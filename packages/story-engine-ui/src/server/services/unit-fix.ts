/**
 * 按核账改（P12 第二期「编号句子」）：核账卡「改这处 / 改掉这 N 处」和出稿流程里的「按核账改」共用这一条。
 *
 * 核账引的原句先在稿里找到是哪几句（逐字；不计空白引号；「A……B」两截），整章按句编号交给修订模型，
 * 只许改点名的那几句；模型按编号回新句，代码按编号整句换（核心 applyUnitEdits：引号对齐原句、抄进来的邻句去掉）。
 * 不再让模型抄原句、再拿抄来的字回稿里找，也就没有补整句、接缝去重那一套。
 * 一章要改几处只问一次模型；改不成的照实说为什么，正文不动。
 */

import { chinesePunctuationLike } from "../../lib/dialogue-quotes.js";
import { applyUnitEdits, numberedText, prepareUnitReplacement, readDraftFile, splitNumberedReply, splitUnits, type TextUnit, type UnitEdit } from "@actalk/story-core";
import { appendFixLog } from "../editorial/continuity/check-memory.js";
import { applyAiDraft, oneAiWriterPerChapter } from "../lib/ai-draft-write.js";
import { locateRevisionSpan, nextDraftVersion, type RevisionModelCaller } from "./revision-service.js";
import { readTruthBasisForWork } from "../book/truth-basis.js";
import { rethrowIfStopped } from "../lib/operations/context.js";

export interface UnitFix {
  /** 核账引的原句。 */
  readonly quote: string;
  /** 要改成什么样（和哪句对上 + 理由）。 */
  readonly goal: string;
}

export interface UnitFixOutcome {
  /** 改后的整份正文（一处都没改成就是原文）。 */
  readonly text: string;
  /** 改成了的是第几处（fixes 的下标）。 */
  readonly applied: readonly number[];
  /** 没改成的：第几处 + 为什么（给作者看的话）。 */
  readonly failed: readonly { readonly fix: number; readonly why: string }[];
  /** 换上去的句子（改前 → 改后）。 */
  readonly changes: readonly { readonly from: string; readonly to: string }[];
  /** 其中不是点名的、本章别处说同一件事跟着改的句数。 */
  readonly alsoChanged: number;
}

/** 一处原句最多落到几句上；再多就是引得太长，交给作者。 */
const MAX_UNITS_PER_FIX = 4;
/**
 * 本章别处说同一件事、不跟着改就前后对不上的句子，最多连带改几句（真机 P13：「四个字」只改了点名那句，
 * 本章另两句还说「四个字」，再核又报两处）。
 */
const MAX_ALSO_EDITS = 3;

/** 原句落在哪几句（编号）；找不到 / 不唯一 / 太长给原因。 */
export function unitsOfQuote(text: string, units: readonly TextUnit[], quote: string): readonly number[] | string {
  const span = locateRevisionSpan(text, quote.trim());
  if (span === "not_found") return "原句在稿里找不到了（可能已经改过）";
  if (span === "ambiguous") return "原句在稿里不止一处，不知道改哪一处";
  const ids = units.filter((unit) => unit.start < span.end && span.start < unit.end).map((unit) => unit.id);
  if (ids.length === 0) return "原句在稿里找不到了（可能已经改过）";
  if (ids.length > MAX_UNITS_PER_FIX) return "核账引的原句太长，没法只改那几句";
  return ids;
}

export function unitFixTask(chapter: number, numbered: string, targets: readonly { readonly ids: readonly number[]; readonly goal: string }[]): string {
  return [
    `下面是第 ${chapter} 章的工作稿，每句前面有编号 [n]。核账查出几处和前文、设定对不上，请只改点名的这几句：`,
    ...targets.map((target, index) => `${index + 1}. ${target.ids.map((id) => `[${id}]`).join("")}：${target.goal}`),
    "要求：",
    "- 只改点名的句子；能小改就小改，口吻、写法、标点习惯照原来的；",
    `- 本章别的句子也说了同一件事、点名那句改了它不跟着改就前后对不上的（比如数目、时间、谁说的），也照同样的改法一并给出，最多 ${MAX_ALSO_EDITS} 句；和这件事无关的句子一个字不动；`,
    "- 一句改完还是一句：别把前后句抄进来，也别拆成几句；点名了两三句的，只改要改的那句就行；",
    "- 实在要删掉这句才通顺，to 给空串。",
    '只输出一个 JSON：{"edits":[{"id":12,"to":"改后的这一句"}]}',
    "",
    numbered,
  ].join("\n");
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 模型回的改法：点名的编号照收；别的编号是「本章别处说同一件事」的连带改，最多 MAX_ALSO_EDITS 句、锁住的（接着写时作者写的那段）不收。
 * 新句过一遍 prepareUnitReplacement，用不了、和原句一样的不要。
 */
export function parseUnitFixEdits(
  reply: string,
  units: readonly TextUnit[],
  allowed: ReadonlySet<number>,
  locked: ReadonlySet<number> = new Set(),
): UnitEdit[] | undefined {
  const parsed = parseJsonObject(reply);
  if (!parsed || !Array.isArray(parsed.edits)) return undefined;
  const out: UnitEdit[] = [];
  let also = 0;
  // 模型回的半角逗号、直引号换成中文的，除非这章本来就这么写（跟着原文的标点习惯）。
  const context = units.map((unit) => unit.text).join("");
  for (const raw of parsed.edits) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    const rawId = typeof record.id === "number" ? record.id : typeof record.id === "string" ? Number(record.id.replace(/[[\]\s]/gu, "")) : Number.NaN;
    if (!Number.isInteger(rawId) || typeof record.to !== "string") continue;
    // 照编号正文整段抄回来的（带着别的编号）：拆开，每句各自对。
    for (const piece of splitNumberedReply(rawId, record.to)) {
      const id = piece.id;
      if (out.some((edit) => edit.id === id)) continue;
      const unit = units.find((item) => item.id === id);
      if (!unit) continue;
      const named = allowed.has(id);
      if (!named && (locked.has(id) || also >= MAX_ALSO_EDITS)) continue;
      const to = prepareUnitReplacement(units, id, chinesePunctuationLike(context, piece.to));
      if (to === undefined || to === unit.text || to.length > unit.text.length * 3 + 60) continue;
      // 连带改的不许删句：删一句要作者看着办。
      if (!named && !to.trim()) continue;
      if (!named) also += 1;
      out.push({ id, from: unit.text, to });
    }
  }
  // 点名的一句都没改，连带的也不改（跟着改是为了和点名那句一致）。
  return out.some((edit) => allowed.has(edit.id)) ? out : [];
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * 改一章（不读盘、不写盘）：定位 → 问一次模型 → 按编号换。
 * 回的不是要的格式就同一份提示再要一次；模型调用本身出错不重试，照实算没改成。
 */
export async function fixByUnits(input: {
  readonly chapter: number;
  readonly text: string;
  readonly fixes: readonly UnitFix[];
  readonly callModel: RevisionModelCaller;
  /** 这个位置之前的句子不连带改（接着写：开头是本来写好的那段）。 */
  readonly lockedBefore?: number;
}): Promise<UnitFixOutcome> {
  const { text, fixes } = input;
  const units = splitUnits(text);
  const locked = new Set(input.lockedBefore === undefined ? [] : units.filter((unit) => unit.start < input.lockedBefore!).map((unit) => unit.id));
  const failed: { fix: number; why: string }[] = [];
  const located: { fix: number; ids: readonly number[] }[] = [];
  fixes.forEach((fix, index) => {
    const ids = unitsOfQuote(text, units, fix.quote);
    if (typeof ids === "string") failed.push({ fix: index, why: ids });
    else located.push({ fix: index, ids });
  });
  const unchanged = (): UnitFixOutcome => ({ text, applied: [], failed: failed.sort((a, b) => a.fix - b.fix), changes: [], alsoChanged: 0 });
  if (located.length === 0) return unchanged();

  // 两处落在同一句上：合成一条交给模型，免得同一句给两种改法。
  const targets: { fixes: number[]; ids: number[]; goals: string[] }[] = [];
  for (const item of located) {
    const same = targets.find((target) => item.ids.some((id) => target.ids.includes(id)));
    if (same) {
      same.fixes.push(item.fix);
      for (const id of item.ids) if (!same.ids.includes(id)) same.ids.push(id);
      same.goals.push(fixes[item.fix]!.goal);
    } else {
      targets.push({ fixes: [item.fix], ids: [...item.ids], goals: [fixes[item.fix]!.goal] });
    }
  }
  const allowed = new Set(targets.flatMap((target) => target.ids));
  const prompt = unitFixTask(input.chapter, numberedText(units), targets.map((target) => ({ ids: [...target.ids].sort((a, b) => a - b), goal: target.goals.join("；") })));

  let edits: UnitEdit[] | undefined;
  try {
    edits = parseUnitFixEdits(await input.callModel(prompt), units, allowed, locked);
    if (!edits) edits = parseUnitFixEdits(await input.callModel(prompt), units, allowed, locked);
  } catch (error) {
    rethrowIfStopped(error);
    for (const target of targets) for (const fix of target.fixes) failed.push({ fix, why: `AI 没改成（${errorText(error)}）` });
    return unchanged();
  }
  if (!edits) {
    for (const target of targets) for (const fix of target.fixes) failed.push({ fix, why: "AI 回的格式不对，没写改后的句子" });
    return unchanged();
  }

  // 换上去：哪一句换不上（引号理不平）就去掉那一句再换，别的照换。
  const dropped = new Map<number, string>();
  let pending = edits;
  let result = applyUnitEdits(text, pending);
  while (!result.ok) {
    const bad = result.id;
    dropped.set(bad, result.code === "quotes_unbalanced" ? "改出来引号对不上，没换" : "这句换不上");
    pending = pending.filter((edit) => edit.id !== bad);
    result = applyUnitEdits(text, pending);
  }
  const changedIds = new Set(result.applied.map((edit) => edit.id));
  const applied: number[] = [];
  for (const target of targets) {
    if (target.ids.some((id) => changedIds.has(id))) {
      applied.push(...target.fixes);
      continue;
    }
    const why = target.ids.map((id) => dropped.get(id)).find(Boolean) ?? "AI 没给出这句的改法";
    for (const fix of target.fixes) failed.push({ fix, why });
  }
  return {
    text: result.text,
    applied: applied.sort((a, b) => a - b),
    failed: failed.sort((a, b) => a.fix - b.fix),
    changes: result.applied.map((edit) => ({ from: edit.from, to: edit.to })),
    alsoChanged: result.applied.filter((edit) => !allowed.has(edit.id)).length,
  };
}

export interface DraftUnitFixResult extends UnitFixOutcome {
  /** 真改了：写回的版本号和改前存档点。 */
  readonly draftVersion?: number;
  readonly snapshotId?: string;
  /** 改好了但没换上（改的途中作者存过稿、撤销过，或前文变了）：留成候选，message 是给作者看的一句。 */
  readonly kept?: { readonly candidateId: string; readonly message: string };
}

/**
 * 改工作稿（核账卡「改这处 / 改掉这 N 处」）：读依据 → 读稿 → 改 → 改成了就走 AI 写稿唯一通道换上（换上前存档）。
 * 模型跑着时不占书锁（作者照常存稿）；读稿之后稿子或前文变了，换上时对不上就留成候选、如实说。同一章的 AI 改稿排队。
 * 没有工作稿照实说。
 */
export async function fixDraftByUnits(input: {
  readonly projectDir: string;
  readonly chapter: number;
  readonly fixes: readonly UnitFix[];
  readonly callModel: RevisionModelCaller;
}): Promise<DraftUnitFixResult> {
  const { projectDir, chapter } = input;
  return oneAiWriterPerChapter(projectDir, chapter, async () => {
    const basis = await readTruthBasisForWork(projectDir);
    const file = await readDraftFile(projectDir, chapter).catch(() => undefined);
    const text = file?.text;
    if (file === undefined || text === undefined || !text.trim()) {
      return { text: text ?? "", applied: [], failed: input.fixes.map((_, fix) => ({ fix, why: "这一章没有工作稿了" })), changes: [], alsoChanged: 0 };
    }
    const outcome = await fixByUnits({ chapter, text, fixes: input.fixes, callModel: input.callModel });
    if (outcome.applied.length === 0) return outcome;
    const written = await applyAiDraft(projectDir, {
      chapter,
      body: outcome.text,
      baseVersion: file.version,
      basis,
      materials: [],
      source: "unit-fix",
      snapshotLabel: `第${chapter}章按核账改前快照`,
    });
    if (!written.applied) return { ...outcome, kept: { candidateId: written.candidateId, message: written.message } };
    await recordUnitFixes(projectDir, chapter, outcome);
    return { ...outcome, draftVersion: nextDraftVersion(), ...(written.snapshotId ? { snapshotId: written.snapshotId } : {}) };
  });
}

/** 按核账改出来的句子记下来：再核时核账员又说这句不对，就知道是两遍说法相反（check-memory 的改句记录）。记不上不影响改稿。 */
export async function recordUnitFixes(projectDir: string, chapter: number, outcome: Pick<UnitFixOutcome, "changes">): Promise<void> {
  await appendFixLog(projectDir, chapter, outcome.changes).catch((error) => {
    console.warn("[unit-fix] 改句记录没存上（不影响这次改稿）", error);
  });
}
