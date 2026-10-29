/**
 * 写稿（draft.change）停下来以后这一轮怎么收（外部审查 2026-10-28；写作版本 P2a 3.1）：对话里让 AI 写的、按「写这一章」
 * 「接着往下写」「重写这一章」交的都是这一套，写成了不再交给对话 AI 多说一轮。
 *
 * - 写成了：一句结论（作者要的要点可能没写到的照说）→ 写完那遍核过的账出核账卡（只读核账记忆，不再调模型）→
 *   作者要写完就出定稿预览的接着出预览，否则给下一步。
 * - 写好了没换上（写的途中稿子或前文改过）：照结论说，AI 这版在稿纸上等作者选，不再写一遍。
 * - 没写成 / 没受理：照原因说，按原因给下一步（再写一次、改成从头写、先定稿前一章、重写 / 接着写这一章）。
 * 只按操作记录里的结构化结果出，不看模型说了什么。
 */
import { COLD_PAUSED_TEXT } from "../editorial/reader-window.js";
import type { OperationRecord } from "../lib/operations/store.js";
import { isChapterCommitted } from "../lib/working-draft-text.js";
import type { DraftChangeMode, DraftChangeParams } from "../services/draft-change/params.js";
import { readDraftChangeParams } from "../services/draft-change/params.js";
import { draftBrief, type DraftChangeBody } from "../services/draft-change/result.js";
import { cachedContinuityCheck } from "../services/inspect-service.js";
import type { OperationResult } from "../services/operations/executor.js";
import { operationWhat } from "../services/operations/view.js";
import {
  checkChapterAction,
  continueChoice,
  humanizeToolNames,
  newDraftAction,
  resolveNextDraftTarget,
  sendNextSteps,
  writeNextChoice,
  type NextStepChoice,
} from "./next-steps.js";

export type SendEvent = (event: string, data: unknown) => void;

export interface DraftFinishArgs {
  readonly projectDir: string;
  readonly sendEvent: SendEvent;
  readonly scrubber: { push(text: string): string; flush(): string };
  /** 出这一章的定稿预览（写完就出定稿预览）：调用方给（要走定稿预览工具）；没给就改成下一步里的「预览定稿」。 */
  readonly previewCommit?: (chapter: number) => Promise<void>;
  /** 读核账记忆（测试注入）；缺省按盘上工作稿读，记忆对不上就是 null。 */
  readonly readCachedCheck?: (projectDir: string, chapter: number) => Promise<unknown>;
}

interface CheckLike {
  readonly ok?: unknown;
  readonly summary?: unknown;
  readonly headline?: unknown;
  readonly sure?: readonly unknown[];
  readonly maybe?: readonly unknown[];
  readonly coverage?: { readonly pausedBackfill?: string };
}

/**
 * 写完那遍核账的一句话（重构 P6 第 6 步）：问题清单在核账卡和稿纸划线上，这里只说几处。
 * fixed＞0（2026-10-23）：写完核出的已按前文改了几处、改完又核过——作者看着正文变了，得知道是改过的，卡上是改后还剩的。
 */
export function afterDraftCheckLine(result: CheckLike, fixed = 0): string | undefined {
  if (result.ok !== true) return undefined;
  const sure = Array.isArray(result.sure) ? result.sure.length : 0;
  const maybe = Array.isArray(result.maybe) ? result.maybe.length : 0;
  const cold = result.coverage ? `（核账员还没读完全书，更早的细节可能漏${result.coverage.pausedBackfill ? `；${COLD_PAUSED_TEXT}` : ""}）` : "";
  // 稿纸上默认只画确定的；「可能」在核账卡上点开才画（2026-10-23 稿纸减噪），别说成画上了。
  const counts = sure > 0
    ? `确定对不上 ${sure} 处，画在稿纸上了${maybe > 0 ? `；另有可能 ${maybe} 处，在卡上点开看` : ""}`
    : `没有确定对不上的；可能 ${maybe} 处，在卡上点开看`;
  if (fixed > 0) {
    return sure + maybe === 0
      ? `写完核账，改了 ${fixed} 处对不上的；再核没发现别的${cold}。`
      : `写完核账，改了 ${fixed} 处对不上的；再核还有${counts}${cold}。`;
  }
  return sure + maybe === 0
    ? `写完核了一遍，没发现对不上的地方${cold}。`
    : `写完核了一遍：${counts}${cold}。`;
}

/** 还可能没写到的作者要点（复核后仍漏的 + 去味后新漏的）。 */
export function missingBeatsOf(body: DraftChangeBody): readonly string[] {
  const fidelity = body.beatFidelity;
  return [...new Set([...(fidelity?.missingBeats ?? []), ...(fidelity?.postDeAiNewMisses ?? [])].filter((beat) => beat.trim().length > 0))];
}

/**
 * 「接着往下写」「重写这一章」（有稿的章 AI 不覆盖，作者点了才写；已定稿的只给重写）。照这次交的方向、要点写：
 * 重写带原来的参数，接着写只带方向和要点（字数在接着写里是「再写多少」，不沿用）。
 */
export function rewriteChoices(params: DraftChangeParams, committed: boolean): NextStepChoice[] {
  const { chapter } = params;
  const continueParams: DraftChangeParams = {
    chapter,
    ...(params.direction ? { direction: params.direction } : {}),
    ...(params.mustHitBeats ? { mustHitBeats: params.mustHitBeats } : {}),
  };
  return [
    ...(committed ? [] : [{ label: "接着往下写", intent: `第 ${chapter} 章接着往下写`, action: newDraftAction("continue", continueParams) }]),
    { label: `重写第 ${chapter} 章`, intent: `重写第 ${chapter} 章`, action: newDraftAction("write", { ...params, rewrite: true }) },
  ];
}

/**
 * 没写成 / 没受理的下一步（按原因，不看说法）：导入的书还在记账、已定稿不能接着写、写好了留在稿纸上的 → 不给；
 * 没得接 → 改成从头写；有稿 → 重写 / 接着写；前一章没定稿 → 先定稿前一章 / 仍要先写；其余照原样再来一次。
 */
export async function draftRetryChoices(
  projectDir: string,
  code: string | undefined,
  mode: DraftChangeMode,
  params: DraftChangeParams,
  retryable = true,
): Promise<NextStepChoice[]> {
  const { chapter } = params;
  switch (code) {
    case "rereading":
    case "chapter_committed":
    case "model_missing":
    case "bad_params":
      return [];
    case "nothing_to_continue":
      return [{ label: `AI 写第 ${chapter} 章`, intent: "写这一章的正文", recommended: true, action: newDraftAction("write", { chapter, ...(params.direction ? { direction: params.direction } : {}) }) }];
    case "chapter_has_text":
      return rewriteChoices(params, await isChapterCommitted(projectDir, chapter).catch(() => false));
    case "previous_chapter_not_committed":
      return [
        { label: `先定稿第 ${chapter - 1} 章`, intent: `预览第 ${chapter - 1} 章的定稿改动`, recommended: true, action: { toolName: "commit_preview", chapter: chapter - 1 } },
        { label: `仍要先写第 ${chapter} 章`, intent: `知道风险，仍要先写第 ${chapter} 章`, action: newDraftAction(mode, { ...params, allowWriteAhead: true }) },
      ];
    default:
      return retryable ? [{ label: "再写一次", intent: "写这一章的正文", recommended: true, action: newDraftAction(mode, params) }] : [];
  }
}

function emitter(args: DraftFinishArgs): (text: string) => void {
  return (text) => {
    const scrubbed = args.scrubber.push(text);
    if (scrubbed) args.sendEvent("text-delta", { text: scrubbed });
    const rest = args.scrubber.flush();
    if (rest) args.sendEvent("text-delta", { text: rest });
  };
}

function bodyOf(record: OperationRecord): DraftChangeBody | undefined {
  const result = record.result as Partial<OperationResult> | undefined;
  const body = result?.body as Partial<DraftChangeBody> | undefined;
  return body?.kind === "draft.change" && typeof body.chapter === "number" ? (body as DraftChangeBody) : undefined;
}

/** 写成了：结论 → 核账卡 → 定稿预览或下一步。 */
async function finishWritten(args: DraftFinishArgs, body: DraftChangeBody, thenPreview: boolean): Promise<void> {
  const { chapter } = body;
  const emit = emitter(args);
  const continuity = body.qualityPipeline.continuity;
  const short = body.draftLength?.lengthStatus === "below_lower_bound";
  const missing = missingBeatsOf(body);
  // 写完那遍核过的账：只认核账记忆（稿子又被改过、有一步没跑成没记下的都是 null），不再调模型。
  const cached = continuity?.checked === true
    ? await (args.readCachedCheck ?? cachedContinuityCheck)(args.projectDir, chapter).catch(() => null)
    : null;
  emit([
    draftBrief(body),
    missing.length > 0 ? `这几条要点可能没写到：${missing.join("、")}。` : "",
    continuity?.checked === false ? "写完那遍核账没跑成，可以点「核账」再核。" : continuity?.checked === true && !cached ? "写完那遍核账没核全，可以点「核账」再核。" : "",
  ].filter(Boolean).join("\n"));
  const preview = thenPreview && args.previewCommit ? args.previewCommit : undefined;
  const fillBeats: NextStepChoice[] = missing.length > 0
    ? [{ label: "补上这几条", intent: `第 ${chapter} 章把这几条要点补进去：${missing.join("、")}。只补这些，别的不动。` }]
    : [];
  const more: NextStepChoice[] = [...(short ? [continueChoice(chapter)] : []), ...fillBeats];
  if (cached) {
    // 写完已经核过一遍账：直接出核账卡、问题画到稿纸上，不用作者再点「核账」。
    const check = cached as CheckLike;
    args.sendEvent("text-delta", { text: "\n" });
    args.sendEvent("card", { type: "continuity", check: cached });
    const fixed = continuity?.autoFixed?.applied ?? 0;
    const said = [afterDraftCheckLine(check, fixed), check.headline, check.summary].find((text): text is string => typeof text === "string" && text.trim().length > 0);
    emit(said ? said.trim() : `第 ${chapter} 章写完核了一遍。`);
    if (preview) {
      args.sendEvent("text-delta", { text: "\n" });
      await preview(chapter);
      return;
    }
    if (check.ok === false) return;
    // 确定 N 处时改法都在核账卡上（「改掉这 N 处」、逐条「改这处 / 不是问题」），稿纸工具条照样有「定稿」：不再挂预览和写下一章。
    const sure = Array.isArray(check.sure) ? check.sure.length : 0;
    const choices: NextStepChoice[] = sure > 0
      ? more
      : [
        ...more,
        { label: "预览定稿", intent: `预览第 ${chapter} 章的定稿改动`, recommended: more.length === 0, action: { toolName: "commit_preview", chapter } },
        writeNextChoice(await resolveNextDraftTarget(args.projectDir, chapter), "AI 写下一章"),
      ];
    sendNextSteps(args.sendEvent, "接下来？", choices);
    return;
  }
  if (preview) {
    args.sendEvent("text-delta", { text: "\n" });
    await preview(chapter);
    return;
  }
  sendNextSteps(args.sendEvent, `第 ${chapter} 章写好了，接下来？`, [
    ...more,
    { label: "预览定稿", intent: `预览第 ${chapter} 章的定稿改动`, recommended: more.length === 0, action: { toolName: "commit_preview", chapter } },
    { label: "核账", intent: "核账", action: checkChapterAction(chapter) },
  ]);
}

/**
 * 一次写稿操作停下来以后的那一句和下一步（finishOperationTurn 交过来的：做完了、没做成）。停着、停掉的那几种由调用方说。
 */
export async function finishDraftOperation(record: OperationRecord, args: DraftFinishArgs): Promise<void> {
  const emit = emitter(args);
  const read = readDraftChangeParams(record.mode, record.params);
  const chapter = read?.params.chapter ?? record.origin.chapter;
  const what = operationWhat(record.kind, record.mode, chapter);
  if (record.state === "succeeded") {
    const body = bodyOf(record);
    const summary = (record.result as Partial<OperationResult> | undefined)?.summary;
    if (body?.ok) {
      await finishWritten(args, body, body.thenPreview === true);
      return;
    }
    // 写好了没换上：AI 这版在稿纸上等作者选，不再写一遍。
    emit(typeof summary === "string" && summary.trim() ? humanizeToolNames(summary.trim()) : `${what}做完了，结果在上面。`);
    return;
  }
  emit(`${what}没做成：${record.failure?.message ?? "原因没记下来"}${read ? "原来的稿子没动。" : ""}`);
  if (!read) return;
  const choices = await draftRetryChoices(args.projectDir, record.failure?.code, read.mode, read.params, record.failure?.retryable !== false);
  sendNextSteps(args.sendEvent, `第 ${read.params.chapter} 章没写成，接下来？`, choices);
}
