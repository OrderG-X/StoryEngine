/**
 * 对话里交上的操作怎么收尾（写作版本 P2a 契约第三、四节，设计 6.7、第九节）：受理之后这一轮的模型就停，
 * 服务端订阅这次操作、把记录和实时进度原样转进对话的 SSE（`operation` 事件），直到它结束、等作者或停着；
 * 再按结果出一句结论和下一步。对话 AI 交的、按钮交的、「接着做」「不要了」都走这里。
 *
 * - 作者那边断开了（关页、网断）：只是不再转发，操作照跑；重开书时前端按 `GET /api/operations` 接着看。
 * - 结论和下一步只按操作记录里的结构化结果出，不看模型说了什么。卡（核账卡、审稿卡……）前端按结果画。
 */
import type { OperationRecord, OperationState } from "../lib/operations/store.js";
import { isTerminal } from "../lib/operations/store.js";
import { rereadBlocker } from "../editorial/reread-state.js";
import { cancelOperation, resumeOperation, submitOperation, subscribeOperation, type OperationEvent, type OperationResult } from "../services/operations/executor.js";
import { INSPECT_KIND } from "../services/operations/recipes/inspect-run.js";
import { PLAN_PROPOSE_KIND, readPlanProposeParams } from "../services/operations/recipes/plan-propose.js";
import { LEDGER_CHANGE_KIND } from "../services/operations/recipes/ledger-change.js";
import { SETTINGS_CHANGE_KIND, type SettingsChangeBody } from "../services/operations/recipes/settings-change.js";
import { checkedDraftChanged } from "../services/operations/summary.js";
import { operationView, operationWhat } from "../services/operations/view.js";
import type { InspectMode } from "../services/inspect-service.js";
import { DRAFT_ADOPT_KIND, DRAFT_CHANGE_KIND, readDraftChangeParams } from "../services/draft-change/params.js";
import { draftRetryChoices, finishDraftOperation } from "./draft-finish.js";
import { checkChapterAction, humanizeToolNames, newOperationAction, newPlanAction, resolveNextDraftTarget, sendNextSteps, settingsAcceptAction, writeNextChoice, type NextStepChoice } from "./next-steps.js";
import { receiptOf } from "./tools/op-tools.js";
import type { OperationAction } from "./user-actions.js";

export type SendEvent = (event: string, data: unknown) => void;

/** 到这几种就不再等（结束了、等作者点、停着等作者处理）。 */
export function settlesTurn(state: OperationState): boolean {
  return isTerminal(state) || state === "waiting_author" || state === "paused";
}

/**
 * 订阅一次操作、转进对话 SSE：先发一份当前记录，再发之后的记录和实时进度，到结束 / 等作者 / 停着为止；作者断开了也返回。
 * 返回最后看到的记录（找不到这次操作是 undefined）。
 */
export async function followOperation(args: {
  readonly bookDir: string;
  readonly opId: string;
  readonly sendEvent: SendEvent;
  readonly signal: AbortSignal;
}): Promise<OperationRecord | undefined> {
  let last: OperationRecord | undefined;
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => { settle = resolve; });
  let done = false;
  const finish = (): void => {
    if (done) return;
    done = true;
    settle();
  };
  const send = (event: OperationEvent): void => {
    if (done) return;
    if (event.type === "live") {
      args.sendEvent("operation", { type: "live", opId: args.opId, event: event.event });
      return;
    }
    last = event.record;
    args.sendEvent("operation", { type: event.type, operation: operationView(event.record) });
    if (settlesTurn(event.record.state)) finish();
  };
  if (args.signal.aborted) return undefined;
  args.signal.addEventListener("abort", finish, { once: true });
  const off = await subscribeOperation(args.bookDir, args.opId, send);
  if (!off) finish();
  await settled;
  off?.();
  args.signal.removeEventListener("abort", finish);
  return last;
}

const CHANGED_NOTE = "（这是改稿前那一版的结论：查完之后稿子又改过。）";

const PAUSED_TEXT: Readonly<Record<string, string>> = {
  interrupted: "写到一半停了",
  attempt_unknown: "停下了：有一步可能已经发出去、结果没收到（可能已经计费）",
  budget: "停下了：这次能用的调用次数用完了",
  material: "停下了：专员还在读前文（后台在接着读）",
};

interface ContinuityBodyLike {
  readonly ok?: unknown;
  readonly reused?: unknown;
  readonly summary?: unknown;
  readonly headline?: unknown;
  readonly sure?: readonly unknown[];
}

function chapterOf(record: OperationRecord): number | undefined {
  const value = (record.params as { readonly chapter?: unknown } | null | undefined)?.chapter;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : record.origin.chapter;
}

function resultOf(record: OperationRecord): OperationResult | undefined {
  const result = record.result as Partial<OperationResult> | undefined;
  return typeof result?.summary === "string" ? (result as OperationResult) : undefined;
}

/** 核账做完的下一步（和原来「核账」按钮同一套）。 */
async function continuityNextSteps(projectDir: string, chapter: number, body: ContinuityBodyLike | undefined): Promise<{ readonly question: string; readonly choices: readonly NextStepChoice[] }> {
  // 没核成（ok:false）：只给「再核一遍」「先写下一章」，不推荐定稿。导入的书还在通读记账：点了也白点，不给。
  if (body?.ok === false) {
    if (await rereadBlocker(projectDir, "核账")) return { question: "", choices: [] };
    const next = await resolveNextDraftTarget(projectDir, chapter);
    return {
      question: "这次没核成，接下来？",
      choices: [
        { label: "再核一遍", intent: `重新核第 ${chapter} 章的账`, recommended: true, action: checkChapterAction(chapter) },
        writeNextChoice(next, "先让 AI 写下一章"),
      ],
    };
  }
  const sure = Array.isArray(body?.sure) ? body.sure.length : 0;
  // 正文没改、直接给的上次结果 → 多给一个「再核一遍」（重新核）。
  const fresh: NextStepChoice[] = body?.reused === true
    ? [{ label: "再核一遍", intent: "再核一遍：这一章重新对一遍前文", action: checkChapterAction(chapter, { fresh: true }) }]
    : [];
  // 确定对不上的改法都在核账卡上（改掉这 N 处、逐条改这处 / 不是问题）：不再挂下一步，只问要不要重新核。
  if (sure > 0) return { question: "结果同上次，要不要重新核？", choices: fresh };
  return {
    question: "接下来？",
    choices: [
      { label: "预览定稿", intent: `预览第 ${chapter} 章的定稿改动`, recommended: true, action: { toolName: "commit_preview", chapter } },
      writeNextChoice(await resolveNextDraftTarget(projectDir, chapter), "AI 写下一章"),
      ...fresh,
    ],
  };
}

/**
 * 操作停下来以后的那一句和下一步：做完了说结论（核账另给下一步）；没做成说原因、给「再来一次」；停着的说为什么停
 * （「接着做」「不要了」在卡上）；停掉的说停掉了。还在做（作者断开了）什么都不说。
 */
export async function finishOperationTurn(args: {
  readonly record: OperationRecord;
  readonly projectDir: string;
  readonly sendEvent: SendEvent;
  readonly scrubber: { push(text: string): string; flush(): string };
  /** 写完就出定稿预览：出这一章的定稿预览（按钮那条路给）；没给就只给下一步。 */
  readonly previewCommit?: (chapter: number) => Promise<void>;
}): Promise<void> {
  const { record } = args;
  // 写稿做完、没写成：结论、核账卡、定稿预览、下一步按写稿那一套出。
  if (record.kind === DRAFT_CHANGE_KIND && (record.state === "succeeded" || record.state === "failed" || record.state === "obsolete")) {
    await finishDraftOperation(record, {
      projectDir: args.projectDir,
      sendEvent: args.sendEvent,
      scrubber: args.scrubber,
      ...(args.previewCommit ? { previewCommit: args.previewCommit } : {}),
    });
    return;
  }
  const emitText = (text: string): void => {
    const scrubbed = args.scrubber.push(text);
    if (scrubbed) args.sendEvent("text-delta", { text: scrubbed });
    const rest = args.scrubber.flush();
    if (rest) args.sendEvent("text-delta", { text: rest });
  };
  const chapter = chapterOf(record);
  const what = operationWhat(record.kind, record.mode, chapter);
  const view = operationView(record);
  switch (record.state) {
    case "succeeded": {
      const result = resultOf(record);
      // 停过再接着做查的是冻结的那份：期间稿子改过就说清楚（Astra P2a 第 10 轮第 4 条）。
      const changed = await checkedDraftChanged(args.projectDir, record) ? CHANGED_NOTE : "";
      if (record.kind === INSPECT_KIND && record.mode === "continuity" && chapter !== undefined) {
        const body = result?.body as ContinuityBodyLike | undefined;
        const said = [body?.headline, body?.summary, result?.summary].find((text): text is string => typeof text === "string" && text.trim().length > 0);
        // 冷窗口（核账员还没读完全书、后台补读停着）的说明已经在结论里（check-service）。
        emitText(`${said ? humanizeToolNames(said.trim()) : `${what}做完了。`}${changed}`);
        // 稿子改过：结论不算数了，只给「再核一遍」。
        const next = changed
          ? { question: "接下来？", choices: [{ label: "再核一遍", intent: `重新核第 ${chapter} 章的账`, recommended: true, action: checkChapterAction(chapter) }] }
          : await continuityNextSteps(args.projectDir, chapter, body);
        sendNextSteps(args.sendEvent, next.question, next.choices);
        return;
      }
      emitText(`${humanizeToolNames(view.conclusion)}${changed}`);
      // 换上了作者挑的那版 AI 稿：这版没核过账，核了再定稿。
      if (record.kind === DRAFT_ADOPT_KIND && chapter !== undefined && (result?.body as { readonly applied?: unknown } | undefined)?.applied === true) {
        sendNextSteps(args.sendEvent, "接下来？", [
          { label: "核账", intent: `核第 ${chapter} 章的账`, recommended: true, action: checkChapterAction(chapter) },
          { label: "预览定稿", intent: `预览第 ${chapter} 章的定稿改动`, action: { toolName: "commit_preview", chapter } },
        ]);
      }
      // AI 刚写进设定本的（作者口述让 AI 记的）：给「认下」，点了算作者写的。
      const accept = record.kind === SETTINGS_CHANGE_KIND ? (result?.body as Partial<SettingsChangeBody> | undefined)?.accept : undefined;
      if (accept) sendNextSteps(args.sendEvent, "接下来？", [{ label: "认下", intent: `认下${accept.label}`, action: settingsAcceptAction(record.opId) }]);
      return;
    }
    case "failed":
    case "obsolete": {
      emitText(view.conclusion);
      if (record.kind === INSPECT_KIND && chapter !== undefined && record.mode !== undefined && view.failure?.retryable !== false) {
        sendNextSteps(args.sendEvent, "接下来？", [{
          label: "再来一次",
          intent: `重新${what}`,
          recommended: true,
          action: newOperationAction(INSPECT_KIND, record.mode as InspectMode, { chapter }),
        }]);
      }
      // 想走法没想出来：照原来的想法、避开的走法再想一次（新的一次，请求号另给）。
      const plan = record.kind === PLAN_PROPOSE_KIND ? readPlanProposeParams(record.params) : undefined;
      if (plan && view.failure?.retryable !== false) {
        sendNextSteps(args.sendEvent, "接下来？", [{ label: "再想一次", intent: `重新想第 ${plan.chapter} 章的走法`, recommended: true, action: newPlanAction(plan) }]);
      }
      return;
    }
    case "cancelled":
      emitText(view.conclusion);
      return;
    case "paused":
      emitText(`${what}${PAUSED_TEXT[record.pauseReason ?? "interrupted"] ?? "停下了"}：点卡上的「接着做」接着，或「不要了」。`);
      return;
    case "waiting_author":
      // 改稿先给作者看：改法在卡上。
      emitText(record.kind === DRAFT_CHANGE_KIND && record.mode === "revise"
        ? "改法在卡上：点「换上」才换进稿子。"
        : record.kind === SETTINGS_CHANGE_KIND
          ? "这次要改的碰到了你写的，在卡上：点「确认改设定」才改。"
          : record.kind === LEDGER_CHANGE_KIND
            ? `${record.mode === "review" ? "理出来收了的" : "要改的账"}在卡上：点「确认改账」才记。`
            : `${what}在等你点卡上的按钮。`);
      return;
    default:
      return;
  }
}

/** 按钮交的新操作的章号（「认下」这类不按章的没有）。 */
function chapterOfAction(action: Extract<OperationAction, { readonly kind: "new" }>): number | undefined {
  return "chapter" in action.params ? action.params.chapter : undefined;
}

/**
 * 作者点的按钮：新操作（核账、审稿……）、「接着做」、「不要了」。新操作和对话 AI 交的走同一个执行器（origin = 按钮，请求号 = 按钮出的时候给的号）；
 * 受理之后跟对话里一样订阅、转发、收尾。
 */
export async function runOperationAction(args: {
  readonly action: OperationAction;
  readonly projectDir: string;
  readonly sendEvent: SendEvent;
  readonly scrubber: { push(text: string): string; flush(): string };
  readonly signal: AbortSignal;
  readonly previewCommit?: (chapter: number) => Promise<void>;
}): Promise<void> {
  const { action, projectDir } = args;
  const emitText = (text: string): void => {
    const scrubbed = args.scrubber.push(text);
    if (scrubbed) args.sendEvent("text-delta", { text: scrubbed });
    const rest = args.scrubber.flush();
    if (rest) args.sendEvent("text-delta", { text: rest });
  };
  let opId: string;
  if (action.kind === "new") {
    const chapter = chapterOfAction(action);
    const mode = "mode" in action ? action.mode : undefined;
    const outcome = await submitOperation(projectDir, {
      kind: action.type,
      ...(mode !== undefined ? { mode } : {}),
      params: action.params,
      requestKey: action.requestKey,
      issuedAt: action.issuedAt,
      origin: { kind: "button", messageId: action.requestKey, ...(chapter !== undefined ? { chapter } : {}) },
    });
    const receipt = receiptOf(outcome, "button", { kind: action.type, ...(mode !== undefined ? { mode } : {}), ...(chapter !== undefined ? { chapter } : {}) });
    if (!receipt.accepted || !receipt.opId) {
      emitText(receipt.summary);
      // 写稿没受理（有稿、前一章没定稿、没得接……）：按原因给下一步；别的原因（在忙、按过了）不给「再写一次」。
      const read = action.type === DRAFT_CHANGE_KIND && !receipt.ok ? readDraftChangeParams(mode, action.params) : undefined;
      if (read) sendNextSteps(args.sendEvent, "接下来？", await draftRetryChoices(projectDir, receipt.code, read.mode, read.params, false));
      return;
    }
    opId = receipt.opId;
  } else if (action.kind === "resume") {
    const resumed = await resumeOperation(projectDir, action.opId, action.answer);
    if (!resumed.ok) {
      emitText(resumed.message);
      return;
    }
    opId = action.opId;
  } else {
    const cancelled = await cancelOperation(projectDir, action.opId);
    if (!cancelled) {
      emitText("找不到这次操作了。");
      return;
    }
    args.sendEvent("operation", { type: "record", operation: operationView(cancelled.record) });
    const what = operationWhat(cancelled.record.kind, cancelled.record.mode, chapterOf(cancelled.record));
    // 改法摆着等作者点的（选中改写）：「不要了」就是这版不换，稿子没动。
    const waited = cancelled.record.kind === DRAFT_CHANGE_KIND && cancelled.record.pendingActions.some((pending) => !pending.decisionHash);
    emitText(!cancelled.cancelled ? `${what}已经结束了，不用停。` : waited ? `${what}：这版不要了，稿子没动。` : `${what}停掉了，不再接着做。`);
    return;
  }
  const record = await followOperation({ bookDir: projectDir, opId, sendEvent: args.sendEvent, signal: args.signal });
  if (!record || args.signal.aborted || !settlesTurn(record.state)) return;
  await finishOperationTurn({ record, projectDir, sendEvent: args.sendEvent, scrubber: args.scrubber, ...(args.previewCommit ? { previewCommit: args.previewCommit } : {}) });
}
