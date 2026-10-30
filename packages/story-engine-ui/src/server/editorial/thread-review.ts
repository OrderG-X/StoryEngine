/**
 * 理线索（外部审查 2026-10-28：线索只开不收）：记账员一章一章记，收口那笔常漏——该收的判成推进、
 * 收口的原句抄不对没记上（换题材长篇实跑第 23 章「周伯起了疑心」），书越长挂着的越多，只能作者自己一条条找。
 *
 * 作者让 AI 理一遍时：
 *  1. 记账员拿读过的全书（跟读窗口）把开着的线索逐条再判一次：收了 / 还开着 / 拿不准，收了的说在第几章收的；
 *  2. 判收了的，把那一章正文按编号句子交给它，点出写明收口的那一两句——原句由代码按编号取，不让模型抄；
 *     点不出句子、说的章不对的不列，如实说。
 * 结果只是建议：作者点「确认改账」才记成作者裁定（ledger.change 操作停下等作者点）。不按停了几章、不按标题字面判收没收。
 */
import { numberedText, projectBook, readChapterText, splitUnits, type ThreadView } from "@actalk/story-core";
import { positiveIntLike } from "../lib/lenient-args.js";
import { withStep } from "../lib/token-meter.js";
import { extractJsonObject } from "./keeper-parse.js";
import { LEDGER_ROLE, openKeeperWindow } from "./ledger-keeper.js";
import type { ReaderWaited } from "./reader-progress.js";
import { modelFailureText } from "../lib/ai-errors.js";
import type { BrainCallModel, ColdCoverage } from "./reader-window.js";

/** 一次最多理多少条（再多一次判不细，如实说另有几条这次没看）。 */
export const MAX_REVIEW_THREADS = 60;
/** 一条收口最多引几句。 */
const MAX_EVIDENCE_UNITS = 3;

const TYPE_LABELS = { question: "悬念", intent: "打算", goal: "目标" } as const;

export interface ThreadCloseSuggestion {
  readonly thread: string;
  readonly title: string;
  /** 在第几章收的。 */
  readonly chapter: number;
  /** 那一章里写明收口的句子（按编号从正文取的原文）。 */
  readonly quote: string;
  /** 怎么收的（记账员说的，给作者看）。 */
  readonly reason: string;
}

export type ThreadReviewOutcome =
  | {
      readonly ok: true;
      /** 这次看了几条开着的。 */
      readonly reviewed: number;
      readonly suggestions: readonly ThreadCloseSuggestion[];
      /** 判还开着的条数。 */
      readonly stillOpen: number;
      /** 拿不准的（标题），留给作者定。 */
      readonly unsure: readonly string[];
      /** 判收了、却点不出写明收口的句子（或说的章不对）的：不列进建议，如实说。 */
      readonly unproven: readonly { readonly title: string; readonly chapter?: number; readonly why: string }[];
      /** 开着的太多，这次没看的条数。 */
      readonly omitted: number;
      /** 有一步没跑成（某章点句子那次调用失败等）。 */
      readonly failures: readonly string[];
      readonly cold?: ColdCoverage;
      readonly waited?: ReaderWaited;
    }
  | { readonly ok: false; readonly reason: string };

function threadLine(handle: string, thread: ThreadView): string {
  const last = thread.touches.at(-1);
  const recent = thread.lastTouchedAt !== thread.openedAt ? `，最近第 ${thread.lastTouchedAt} 章` : "";
  const note = last && last.note !== thread.title ? `（最近一笔：${last.note}）` : "";
  return `${handle} ${TYPE_LABELS[thread.type]}「${thread.title}」：第 ${thread.openedAt} 章埋${recent}${note}`;
}

export function reviewTask(upTo: number, lines: readonly string[]): string {
  return [
    `作者让你把还开着的线索理一遍。对照你读过的全书原文和记账笔记，逐条判这条到第 ${upTo} 章为止收没收：`,
    "- 悬念：标题问的那件事正文完整答出来了；打算：做完了或明确放弃了；目标：达成了或明确落空了。",
    "- 只揭晓了一部分、答案引出新疑问、人物只说了一半、只是又往前推了一步的，不算收。停了很多章没再写，也不等于收了。",
    "- 收了：status 写 closed，chapter 写正文写明收口的那一章。还开着：status 写 open。拿不准：status 写 unsure。",
    "- 最近推进到第几章的，真收了也是那一章或以后（后面还在推进，说明那时还没收）。",
    "- reason 用中文一句话说怎么收的、或为什么还开着（给作者看，不写编号）。",
    "",
    "【开着的线索】（编号只在这次有效）",
    ...lines,
    "",
    '只输出一个 JSON：{"threads":[{"id":"T1","status":"closed","chapter":1,"reason":""}]}',
  ].join("\n");
}

export function evidenceTask(chapter: number, numbered: string, lines: readonly string[]): string {
  return [
    `下面是第 ${chapter} 章正文，每句前面是编号。你判下面这几条线索在这一章收了。`,
    `给每条点出正文里写明收口的那一两句的编号（最多 ${MAX_EVIDENCE_UNITS} 句，只能用这一章的编号）；这一章正文其实没写明收口的，ids 给 []。`,
    "",
    `【第 ${chapter} 章】`,
    numbered,
    "",
    "【这一章收的线索】",
    ...lines,
    "",
    '只输出一个 JSON：{"evidence":[{"id":"T1","ids":[1]}]}',
  ].join("\n");
}

interface Verdict {
  readonly status: "closed" | "open" | "unsure";
  readonly chapter?: number;
  readonly reason: string;
}

/** 记账员判的那一份：编号对不上的不收；status 只认 schema 里那三个英文词（大小写宽容），别的当拿不准。 */
function parseVerdicts(text: string, handles: ReadonlyMap<string, ThreadView>): Map<string, Verdict> | undefined {
  const parsed = extractJsonObject(text);
  if (!parsed || !Array.isArray(parsed.threads)) return undefined;
  const out = new Map<string, Verdict>();
  for (const raw of parsed.threads) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const handle = typeof item.id === "string" || typeof item.id === "number" ? String(item.id).trim().toUpperCase() : "";
    const id = handles.has(handle) ? handle : handles.has(`T${handle}`) ? `T${handle}` : undefined;
    if (!id || out.has(id)) continue;
    const status = typeof item.status === "string" ? item.status.trim().toLowerCase() : "";
    const chapter = positiveIntLike(item.chapter);
    const reason = typeof item.reason === "string" ? item.reason.trim() : "";
    out.set(id, {
      status: status === "closed" || status === "open" ? status : "unsure",
      ...(chapter !== undefined ? { chapter } : {}),
      reason,
    });
  }
  return out;
}

/** 点句子那一份：每条的编号去重、只留这一章有的。 */
function parseEvidence(text: string): Map<string, number[]> | undefined {
  const parsed = extractJsonObject(text);
  if (!parsed || !Array.isArray(parsed.evidence)) return undefined;
  const out = new Map<string, number[]>();
  for (const raw of parsed.evidence) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const handle = typeof item.id === "string" || typeof item.id === "number" ? String(item.id).trim().toUpperCase() : "";
    if (!handle) continue;
    const ids = Array.isArray(item.ids) ? item.ids.map(positiveIntLike).filter((value): value is number => value !== undefined) : [];
    out.set(handle.startsWith("T") ? handle : `T${handle}`, [...new Set(ids)].sort((a, b) => a - b));
  }
  return out;
}

export async function reviewOpenThreads(input: {
  readonly projectDir: string;
  readonly callModel: BrainCallModel;
  /** 笔记存放的根目录；缺省就是书目录（考卷传临时目录）。 */
  readonly notesRoot?: string;
  /** 当场最多补几章笔记、几个卷节点（操作里先在 notes 步补过，这里给 0：缺的按冷窗口判）。缺省是记账员的老上限。 */
  readonly maxCatchUp?: number;
  readonly maxVolumeBuilds?: number;
}): Promise<ThreadReviewOutcome> {
  const projection = await projectBook(input.projectDir);
  const upTo = projection.upTo;
  if (upTo === 0) return { ok: false, reason: "还没有定稿的章，没有线索可理" };
  const open = projection.threads.filter((thread) => thread.status !== "closed");
  const reviewing = open.slice(0, MAX_REVIEW_THREADS);
  const omitted = open.length - reviewing.length;
  if (reviewing.length === 0) {
    return { ok: true, reviewed: 0, suggestions: [], stillOpen: 0, unsure: [], unproven: [], omitted: 0, failures: [] };
  }
  const handles = new Map(reviewing.map((thread, index) => [`T${index + 1}`, thread] as const));

  let opened: Awaited<ReturnType<typeof openKeeperWindow>>;
  try {
    opened = await openKeeperWindow({
      projectDir: input.projectDir,
      upTo,
      callModel: input.callModel,
      ...(input.notesRoot ? { notesRoot: input.notesRoot } : {}),
      ...(input.maxCatchUp !== undefined ? { maxCatchUp: input.maxCatchUp } : {}),
      ...(input.maxVolumeBuilds !== undefined ? { maxVolumeBuilds: input.maxVolumeBuilds } : {}),
      waitingAs: "理线索",
    });
  } catch (error) {
    return { ok: false, reason: `记账员读前文没成：${modelFailureText(error)}` };
  }
  const extra = { ...(opened.cold ? { cold: opened.cold } : {}), ...(opened.waited ? { waited: opened.waited } : {}) };
  const lines = [...handles].map(([handle, thread]) => threadLine(handle, thread));
  let reply: string;
  try {
    reply = await withStep("记账员理线索", () => input.callModel([...opened.window, { role: "user", content: reviewTask(upTo, lines) }], { json: true }));
  } catch (error) {
    return { ok: false, reason: `记账员这次没理完：${modelFailureText(error)}` };
  }
  const verdicts = parseVerdicts(reply, handles);
  if (!verdicts) return { ok: false, reason: "记账员交回来的不是一份能读的结果（不是 JSON）" };

  const unsure: string[] = [];
  const unproven: { title: string; chapter?: number; why: string }[] = [];
  const claimed = new Map<number, { handle: string; thread: ThreadView; reason: string }[]>();
  let stillOpen = 0;
  for (const [handle, thread] of handles) {
    const verdict = verdicts.get(handle);
    if (!verdict || verdict.status === "unsure") {
      unsure.push(thread.title);
      continue;
    }
    if (verdict.status === "open") {
      stillOpen += 1;
      continue;
    }
    const chapter = verdict.chapter;
    if (chapter === undefined || chapter < thread.openedAt || chapter > upTo) {
      unproven.push({ title: thread.title, ...(chapter !== undefined ? { chapter } : {}), why: chapter === undefined ? "没说在第几章收的" : `说的第 ${chapter} 章不在这条埋下之后的定稿章里` });
      continue;
    }
    // 账里后面的章还记着推进：那一章收了说不通（真收了得从后面那章算），不列，作者自己看。
    if (chapter < thread.lastTouchedAt) {
      unproven.push({ title: thread.title, chapter, why: `账里第 ${thread.lastTouchedAt} 章还记着推进，第 ${chapter} 章收了说不通` });
      continue;
    }
    claimed.set(chapter, [...(claimed.get(chapter) ?? []), { handle, thread, reason: verdict.reason }]);
  }

  // 判收了的按章点句子：一章一次，各章并行。正文读不了、调用失败、点不出句子的都不列，如实记。
  const failures: string[] = [];
  const suggestions: ThreadCloseSuggestion[] = [];
  await Promise.all([...claimed].map(async ([chapter, items]) => {
    const text = await readChapterText(input.projectDir, chapter).catch(() => undefined);
    const units = text ? splitUnits(text) : [];
    if (units.length === 0) {
      for (const item of items) unproven.push({ title: item.thread.title, chapter, why: `第 ${chapter} 章正文读不到` });
      return;
    }
    const asked = items.map((item) => `${item.handle} ${TYPE_LABELS[item.thread.type]}「${item.thread.title}」：${item.reason || "（没说怎么收的）"}`);
    let evidence: Map<string, number[]> | undefined;
    try {
      const answer = await withStep("记账员点收口原句", () => input.callModel(
        [{ role: "system", content: LEDGER_ROLE.system }, { role: "user", content: evidenceTask(chapter, numberedText(units), asked) }],
        { json: true },
      ));
      evidence = parseEvidence(answer);
      if (!evidence) failures.push(`第 ${chapter} 章点收口原句那次交回来的不是 JSON`);
    } catch (error) {
      failures.push(`第 ${chapter} 章点收口原句没成：${modelFailureText(error)}`);
    }
    const byId = new Map(units.map((unit) => [unit.id, unit] as const));
    for (const item of items) {
      // 编号不在这一章的丢掉；点多了取前几句（真机：「最多 3 句」它点了 4 句，整条被丢）。
      const picked = (evidence?.get(item.handle) ?? [])
        .map((id) => byId.get(id))
        .filter((unit): unit is NonNullable<typeof unit> => unit !== undefined)
        .slice(0, MAX_EVIDENCE_UNITS);
      if (!evidence) {
        unproven.push({ title: item.thread.title, chapter, why: "点收口原句那步没成" });
      } else if (picked.length === 0) {
        unproven.push({ title: item.thread.title, chapter, why: `第 ${chapter} 章里点不出写明收口的句子` });
      } else {
        suggestions.push({ thread: item.thread.id, title: item.thread.title, chapter, quote: picked.map((unit) => unit.text).join(""), reason: item.reason });
      }
    }
  }));
  suggestions.sort((a, b) => a.chapter - b.chapter || a.title.localeCompare(b.title));
  return { ok: true, reviewed: reviewing.length, suggestions, stillOpen, unsure, unproven, omitted, failures, ...extra };
}
