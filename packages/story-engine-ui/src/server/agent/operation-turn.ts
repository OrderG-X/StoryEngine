/**
 * 对话里交上的操作怎么收尾（写作版本 P2a 契约第三、四节，设计 6.7、第九节）：受理之后这一轮的模型就停，
 * 服务端订阅这次操作、把记录和实时进度原样转进对话的 SSE（`operation` 事件），直到它结束、等作者或停着；
 * 再按结果出一句结论和下一步。对话 AI 交的、按钮交的、「接着做」「不要了」都走这里。
 *
 * - 作者那边断开了（关页、网断）：只是不再转发，操作照跑；重开书时前端按 `GET /api/operations` 接着看。
 * - 结论和下一步只按操作记录里的结构化结果出，不看模型说了什么。卡（核账卡、审稿卡……）前端按结果画。
 */
import type { OperationRecord, OperationState } from "../lib/operations/store.js";
import { isTerminal, readOperation } from "../lib/operations/store.js";
import { rereadBlocker } from "../editorial/reread-state.js";
import { cancelOperation, resumeOperation, submitOperation, subscribeOperation, type OperationEvent, type OperationResult } from "../services/operations/executor.js";
import { INSPECT_KIND } from "../services/operations/recipes/inspect-run.js";
import { PLAN_PROPOSE_KIND, readPlanProposeParams } from "../services/operations/recipes/plan-propose.js";
import { LEDGER_CHANGE_KIND } from "../services/operations/recipes/ledger-change.js";
import { CANON_PROPOSE_KIND, canonInputOf, type CanonConfirmPreview, type CanonProposeBody, type CanonProposeParams } from "../services/operations/recipes/canon-propose.js";
import { AUTHOR_CHOICE_KIND, COMMIT_PREPARE_KIND, type CommitPrepareBody } from "../services/operations/recipes/commit-prepare.js";
import { SETTINGS_CHANGE_KIND, type SettingsChangeBody } from "../services/operations/recipes/settings-change.js";
import { HISTORY_CHANGE_KIND, type HistoryChangeBody } from "../services/operations/recipes/history-change.js";
import { checkedDraftChanged } from "../services/operations/summary.js";
import { operationView, operationWhat } from "../services/operations/view.js";
import type { InspectMode } from "../services/inspect-service.js";
import { DRAFT_ADOPT_KIND, DRAFT_CHANGE_KIND, readDraftChangeParams } from "../services/draft-change/params.js";
import { draftRetryChoices, finishDraftOperation } from "./draft-finish.js";
import { checkChapterAction, commitChoice, fillChoice, humanizeToolNames, newCanonAction, newOperationAction, newPlanAction, recheckCanonAction, resolveNextDraftTarget, sendNextSteps, settingsAcceptAction, undoAction, writeNextChoice, type NextStepChoice } from "./next-steps.js";
import { buildProtagonistRenameSuggestion } from "./protagonist-rename-suggestion.js";
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
      commitChoice(chapter, { recommended: true }),
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
  /** 作者那边还连着：写完就定稿的接着交这一章的定稿、跟着它收尾（没给就只给下一步里的「定稿」）。 */
  readonly signal?: AbortSignal;
}): Promise<void> {
  const { record, signal } = args;
  // 写稿做完、没写成：结论、核账卡、定稿清单、下一步按写稿那一套出。
  if (record.kind === DRAFT_CHANGE_KIND && (record.state === "succeeded" || record.state === "failed" || record.state === "obsolete")) {
    await finishDraftOperation(record, {
      projectDir: args.projectDir,
      sendEvent: args.sendEvent,
      scrubber: args.scrubber,
      // 写完就定稿：请求号由这次写稿定（收尾再来一遍也是同一次定稿）。
      ...(signal ? {
        previewCommit: (chapter: number) => runOperationAction({
          action: { kind: "new", type: COMMIT_PREPARE_KIND, params: { chapter }, requestKey: `then-${record.opId}`, issuedAt: record.issuedAt },
          projectDir: args.projectDir,
          sendEvent: args.sendEvent,
          scrubber: args.scrubber,
          signal,
        }),
      } : {}),
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
      if (record.kind === COMMIT_PREPARE_KIND && chapter !== undefined) {
        await finishCommit(args.projectDir, chapter, result?.body as Partial<CommitPrepareBody> | undefined, view.conclusion, emitText, args.sendEvent);
        return;
      }
      emitText(`${humanizeToolNames(view.conclusion)}${changed}`);
      // 换上了作者挑的那版 AI 稿：这版没核过账，核了再定稿。
      if (record.kind === DRAFT_ADOPT_KIND && chapter !== undefined && (result?.body as { readonly applied?: unknown } | undefined)?.applied === true) {
        sendNextSteps(args.sendEvent, "接下来？", [
          { label: "核账", intent: `核第 ${chapter} 章的账`, recommended: true, action: checkChapterAction(chapter) },
          commitChoice(chapter),
        ]);
      }
      // 定论改齐了：从哪一章点进来的就给「再核这一章」；没改（没有要改的）但没查全：给「重新查」。
      const canon = record.kind === CANON_PROPOSE_KIND ? result?.body as CanonProposeBody | undefined : undefined;
      if (canon?.applied && canon.card.chapter !== undefined) {
        sendNextSteps(args.sendEvent, "改齐了，接下来？", [{ label: `再核第 ${canon.card.chapter} 章`, intent: `重新核第 ${canon.card.chapter} 章的账`, recommended: true, action: checkChapterAction(canon.card.chapter, { fresh: true }) }]);
      } else if (canon && !canon.applied && (canon.card.failures.length > 0 || canon.card.missed.length > 0)) {
        sendNextSteps(args.sendEvent, "接下来？", [{ label: "重新查", intent: `重新查定论「${canon.card.canon}」`, recommended: true, action: recheckCanonAction(canon.card) }]);
      }
      // 撤了、恢复了：给「撤回来」（撤这一次撤销 / 恢复本身）。
      const history = record.kind === HISTORY_CHANGE_KIND ? result?.body as Partial<HistoryChangeBody> | undefined : undefined;
      if (history && history.mode !== "prune" && (history.paths?.length ?? 0) > 0) {
        sendNextSteps(args.sendEvent, "接下来？", [{ label: "撤回来", intent: `把刚才的${what}撤回来`, action: undoAction(record.opId) }]);
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
      // 定论没查成：照原来的再查一次（新的一次，请求号另给）；查完之后书变了（obsolete）也是重新查。
      if (record.kind === CANON_PROPOSE_KIND && view.failure?.retryable !== false && record.params) {
        const params = record.params as CanonProposeParams;
        sendNextSteps(args.sendEvent, "接下来？", [{ label: "重新查", intent: "重新查这条定论", recommended: true, action: newCanonAction(params.mode, canonInputOf(params)) }]);
      }
      // 定稿 / 补账没成（清单出来之后正文或前文改过……）：再出一次清单（新的一次）。
      if (record.kind === COMMIT_PREPARE_KIND && chapter !== undefined && view.failure?.retryable !== false) {
        const again = { label: "再来一次", recommended: true } as const;
        sendNextSteps(args.sendEvent, "接下来？", [isFillRecord(record) ? fillChoice(chapter, again) : commitChoice(chapter, again)]);
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
            : record.kind === CANON_PROPOSE_KIND
              ? canonWaitingText(record)
              : record.kind === HISTORY_CHANGE_KIND
                ? (record.mode === "prune" ? "要裁的在卡上：点「确认裁剪」才裁。" : "撤之前要你看一眼，在卡上：点「全撤」才撤。")
              : record.kind === COMMIT_PREPARE_KIND && chapter !== undefined
                ? commitWaitingText(record, chapter)
                : `${what}在等你点卡上的按钮。`);
      return;
    default:
      return;
  }
}

/**
 * 定稿做完：定不了的只说一句（原因在清单里，只差字数的清单上有「就这么短，照样定稿」）；定了的说结论，
 * 下一步给写下一章（线索堆多了加「归并线索」；设定本里还没标主角、账里有视角人物的加「把『X』设为主角」，点了交给对话 AI 设）。
 */
async function finishCommit(
  projectDir: string,
  chapter: number,
  body: Partial<CommitPrepareBody> | undefined,
  conclusion: string,
  emitText: (text: string) => void,
  sendEvent: SendEvent,
): Promise<void> {
  if (body?.committed !== true) {
    emitText(body?.fill ? `第 ${chapter} 章的账现在补不了，原因在卡上。` : `第 ${chapter} 章现在还定不了，原因在清单里。`);
    return;
  }
  emitText(humanizeToolNames(conclusion));
  const status = body.done?.report?.ledger.status;
  const next = await resolveNextDraftTarget(projectDir, chapter);
  // 补上了：接着写；账待记 / 没记全：「补记账」摆在写下一章旁边（补之前接着写也行，写作上下文里说清那章账没记上）。
  if (body.fill) {
    sendNextSteps(sendEvent, "接下来？", [
      ...(status === "partial" ? [fillChoice(chapter, { label: "再补一次" })] : []),
      { ...writeNextChoice(next), recommended: true },
    ]);
    return;
  }
  if (status === "pending" || status === "partial") {
    sendNextSteps(sendEvent, `第 ${chapter} 章正文定了，接下来？`, [fillChoice(chapter, { recommended: true }), writeNextChoice(next)]);
    return;
  }
  const rename = await buildProtagonistRenameSuggestion(projectDir).catch(() => undefined);
  sendNextSteps(sendEvent, `第 ${chapter} 章定稿了，接下来？`, [
    { ...writeNextChoice(next), recommended: true },
    ...(body.done?.threadMaintenanceHint === "escalated" ? [{ label: "归并线索", intent: "看看开着的线索里有没有讲同一件事的，提一份归并方案给我确认" }] : []),
    ...(rename ? [{ label: rename.label, intent: rename.intent }] : []),
  ]);
}

/** 这次定稿操作是补账。 */
function isFillRecord(record: OperationRecord): boolean {
  return (record.params as { readonly fill?: unknown } | undefined)?.fill === true;
}

/** 定稿停着等作者：记账没成的卡（再记一次 / 先定正文）、定稿清单、补账清单。清单在弹窗和对话小卡里，回话只说一句（刷新后弹窗没开也说得通）。 */
function commitWaitingText(record: OperationRecord, chapter: number): string {
  const waiting = record.pendingActions.find((action) => !action.decisionHash);
  if (waiting?.kind === AUTHOR_CHOICE_KIND) return `第 ${chapter} 章的账这次没记成，怎么办在卡上。`;
  return isFillRecord(record) ? `第 ${chapter} 章的账可以补上，清单在卡上：点「确认记账」才记。` : `第 ${chapter} 章可以定稿，清单在卡上：点「确认定稿」才定。`;
}

/** 定论查完等作者点：卡上面那句话（查到几处、在哪几章、没查全的），定论本身卡上有。 */
function canonWaitingText(record: OperationRecord): string {
  const preview = record.pendingActions.find((action) => !action.decisionHash)?.preview as Partial<CanonConfirmPreview> | undefined;
  return typeof preview?.summary === "string" && preview.summary ? preview.summary : "定论在卡上：点「确认」才改。";
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
      // 卡上的按钮旧了（作废了、做完了、别处点过）：卡跟着换成这次现在的样子，再如实说一句。
      const stored = await readOperation(projectDir, action.opId);
      if (stored.kind === "record") args.sendEvent("operation", { type: "record", operation: operationView(stored.record) });
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
    // 摆着等作者点的（改法、要改的设定 / 账 / 定论）：「不要了」就是不换、不改。
    const waited = cancelled.record.pendingActions.some((pending) => !pending.decisionHash);
    const dropped = cancelled.record.kind === DRAFT_CHANGE_KIND ? "这版不要了，稿子没动。" : "不要了，书里没动。";
    emitText(!cancelled.cancelled ? `${what}已经结束了，不用停。` : waited ? `${what}：${dropped}` : `${what}停掉了，不再接着做。`);
    return;
  }
  const record = await followOperation({ bookDir: projectDir, opId, sendEvent: args.sendEvent, signal: args.signal });
  if (!record || args.signal.aborted || !settlesTurn(record.state)) return;
  await finishOperationTurn({ record, projectDir, sendEvent: args.sendEvent, scrubber: args.scrubber, signal: args.signal });
}
