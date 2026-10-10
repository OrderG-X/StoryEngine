/**
 * 用户结构化动作（2026-10-07 拆补丁塔）：界面按钮（定稿预览卡 / 建议条「确认定稿」）发来的明确指令，
 * 服务端直接执行对应工具，不经模型判断——按钮点击本身就是授权，不再用正则去猜用户原话。
 *
 * 事件协议与 agent 回合完全一致（tool-call / tool-result / text-delta），前端投影零分叉：
 * 入库 delta 卡、撤销快照、草稿以 committed 态载入都照旧走。收尾文本与下一步选项确定性生成，不调模型。
 */
import type { RequestContext } from "@mastra/core/di";

import { markUserConfirmedTool } from "./request-context.js";

/** 允许经按钮直接执行的工具（白名单；新增前想清楚它是否真需要绕过模型）。 */
export const USER_ACTION_TOOL_NAMES = ["commit_apply", "prune_snapshots", "check_continuity"] as const;
export type UserActionToolName = (typeof USER_ACTION_TOOL_NAMES)[number];

/** 「确认定稿」：定这一章。「确认裁剪」：把操作历史裁到最近 keep 条（缺省=引擎默认 200）。 */
export type UserAction =
  | {
    readonly toolName: "commit_apply";
    readonly chapter: number;
    readonly previewToken?: string;
    /** 作者在定稿预览的账本清单上去掉的条目 id（这些不写进账本）。 */
    readonly excluded?: readonly string[];
  }
  | { readonly toolName: "prune_snapshots"; readonly keep?: number }
  /** 「核账」：只读，拿这一章对前文原文找对不上的地方。 */
  | { readonly toolName: "check_continuity"; readonly chapter: number };

/** 账本清单一次最多去掉多少条（防异常请求体）。 */
const MAX_EXCLUDED = 500;

/** body.action 解析：缺省 → none（普通对话）；形状不对 → invalid（路由回 400，绝不静默当普通对话）。 */
export type ParsedUserAction =
  | { readonly kind: "none" }
  | { readonly kind: "invalid"; readonly reason: string }
  | { readonly kind: "action"; readonly action: UserAction };

export function parseUserAction(raw: unknown): ParsedUserAction {
  if (raw === undefined || raw === null) return { kind: "none" };
  if (typeof raw !== "object" || Array.isArray(raw)) return { kind: "invalid", reason: "动作格式不对。" };
  const record = raw as Record<string, unknown>;
  const toolName = record.toolName;
  if (typeof toolName !== "string" || !(USER_ACTION_TOOL_NAMES as readonly string[]).includes(toolName)) {
    return { kind: "invalid", reason: "不支持的操作。" };
  }
  if (toolName === "prune_snapshots") {
    const rawKeep = typeof record.keep === "string" ? Number(record.keep.trim()) : record.keep;
    if (rawKeep === undefined || rawKeep === null || rawKeep === "") return { kind: "action", action: { toolName: "prune_snapshots" } };
    if (typeof rawKeep !== "number" || !Number.isInteger(rawKeep) || rawKeep < 0) {
      return { kind: "invalid", reason: "保留条数不对。" };
    }
    return { kind: "action", action: { toolName: "prune_snapshots", ...(rawKeep > 0 ? { keep: rawKeep } : {}) } };
  }
  const chapter = typeof record.chapter === "string" ? Number(record.chapter.trim()) : record.chapter;
  if (typeof chapter !== "number" || !Number.isInteger(chapter) || chapter <= 0) {
    return { kind: "invalid", reason: "缺少有效章号。" };
  }
  if (toolName === "check_continuity") return { kind: "action", action: { toolName: "check_continuity", chapter } };
  const previewToken = typeof record.previewToken === "string" && record.previewToken.trim()
    ? record.previewToken.trim()
    : undefined;
  const excluded = Array.isArray(record.excluded)
    ? [...new Set(record.excluded.filter((id): id is string => typeof id === "string" && id.trim().length > 0 && id.length <= 200).map((id) => id.trim()))].slice(0, MAX_EXCLUDED)
    : [];
  return {
    kind: "action",
    action: { toolName: "commit_apply", chapter, ...(previewToken ? { previewToken } : {}), ...(excluded.length > 0 ? { excluded } : {}) },
  };
}

interface NextStepChoice {
  readonly label: string;
  readonly intent: string;
  readonly recommended?: boolean;
}

interface CommitApplyLikeOutput {
  readonly committed?: unknown;
  readonly summary?: unknown;
  readonly chapter?: unknown;
  readonly threadMaintenanceHint?: unknown;
}

/** 给用户看的收尾文本：工具 summary 里偶有工具名（「尚未对该章执行 commit_preview」），换成人话。 */
export function humanizeToolNames(text: string): string {
  return text.replace(/commit_preview/gu, "定稿预览").replace(/commit_apply/gu, "定稿");
}

/** 定稿动作收尾的下一步选项（确定性）：成功 → 写下一章（+线索堆积时清理）；未成 → 重新预览。 */
export function commitApplyNextSteps(
  chapter: number,
  output: CommitApplyLikeOutput | undefined,
): { readonly question: string; readonly choices: readonly NextStepChoice[] } {
  if (output?.committed === true) {
    return {
      question: `第 ${chapter} 章定稿了，接下来？`,
      choices: [
        { label: `写第 ${chapter + 1} 章`, intent: `继续写第 ${chapter + 1} 章的正文`, recommended: true },
        ...(output.threadMaintenanceHint === "escalated" ? [{ label: "清理线索", intent: "清理线索" }] : []),
      ],
    };
  }
  return {
    question: `第 ${chapter} 章还没定稿，接下来？`,
    choices: [{ label: "重新预览", intent: `生成第 ${chapter} 章定稿预览`, recommended: true }],
  };
}

export type UserActionToolExecutor = (
  toolName: UserActionToolName,
  input: Record<string, unknown>,
  requestContext: RequestContext,
) => Promise<unknown>;

/**
 * 执行一次用户结构化动作并把结果按 agent 回合同款事件推给前端。
 * 工具抛错 → tool-error + 如实文案（绝不静默）；标记只在本次执行期间存在，结束即清。
 */
export async function runUserAction(args: {
  readonly action: UserAction;
  readonly requestContext: RequestContext;
  readonly executeTool: UserActionToolExecutor;
  readonly sendEvent: (event: string, data: unknown) => void;
  readonly scrubber: { push(text: string): string; flush(): string };
  readonly scrubError: (error: unknown) => string;
}): Promise<void> {
  const { action } = args;
  if (action.toolName === "prune_snapshots") {
    await runPruneAction({ ...args, action });
    return;
  }
  if (action.toolName === "check_continuity") {
    await runCheckContinuityAction({ ...args, action });
    return;
  }
  const stamp = Date.now();
  const toolCallId = `user-action-${action.toolName}-${stamp}`;
  const emitText = (text: string): void => {
    const scrubbed = args.scrubber.push(text);
    if (scrubbed) args.sendEvent("text-delta", { text: scrubbed });
  };

  args.sendEvent("tool-call", { toolCallId, toolName: action.toolName, args: { chapter: action.chapter } });
  let output: unknown;
  markUserConfirmedTool(args.requestContext, action.toolName);
  try {
    output = await args.executeTool(
      action.toolName,
      {
        chapter: action.chapter,
        ...(action.previewToken ? { previewToken: action.previewToken } : {}),
        ...(action.excluded && action.excluded.length > 0 ? { excluded: action.excluded } : {}),
      },
      args.requestContext,
    );
  } catch (error) {
    const message = args.scrubError(error);
    args.sendEvent("tool-error", { toolCallId, toolName: action.toolName, error: message, retryable: true });
    emitText(`第 ${action.chapter} 章定稿没有完成：${humanizeToolNames(message)}。可以再点一次「确认定稿」重试。`);
    const rest = args.scrubber.flush();
    if (rest) args.sendEvent("text-delta", { text: rest });
    return;
  } finally {
    markUserConfirmedTool(args.requestContext, undefined);
  }

  args.sendEvent("tool-result", { toolCallId, toolName: action.toolName, output });
  const result = output as CommitApplyLikeOutput | undefined;
  const summary = typeof result?.summary === "string" && result.summary.trim()
    ? result.summary.trim()
    : result?.committed === true
      ? `第 ${action.chapter} 章已定稿。`
      : `第 ${action.chapter} 章没有定稿。`;
  emitText(humanizeToolNames(summary));
  const rest = args.scrubber.flush();
  if (rest) args.sendEvent("text-delta", { text: rest });

  const nextSteps = commitApplyNextSteps(action.chapter, result);
  const nextCallId = `user-action-next-${stamp}`;
  args.sendEvent("tool-call", { toolCallId: nextCallId, toolName: "suggest_next_steps", args: {} });
  args.sendEvent("tool-result", {
    toolCallId: nextCallId,
    toolName: "suggest_next_steps",
    output: { ok: true, question: nextSteps.question, choices: nextSteps.choices },
  });
}

interface CheckContinuityLikeOutput {
  readonly ok?: unknown;
  readonly summary?: unknown;
  readonly sure?: readonly unknown[];
  readonly maybe?: readonly unknown[];
}

/** 「核账」按钮：服务端直接跑核账（只读），结果按 agent 回合同款事件推给前端，再给下一步选项。 */
async function runCheckContinuityAction(args: Omit<Parameters<typeof runUserAction>[0], "action"> & {
  readonly action: Extract<UserAction, { readonly toolName: "check_continuity" }>;
}): Promise<void> {
  const { action } = args;
  const stamp = Date.now();
  const toolCallId = `user-action-check_continuity-${stamp}`;
  const emitText = (text: string): void => {
    const scrubbed = args.scrubber.push(text);
    if (scrubbed) args.sendEvent("text-delta", { text: scrubbed });
  };
  args.sendEvent("tool-call", { toolCallId, toolName: "check_continuity", args: { chapter: action.chapter } });
  let output: unknown;
  try {
    output = await args.executeTool("check_continuity", { chapter: action.chapter }, args.requestContext);
  } catch (error) {
    const message = args.scrubError(error);
    args.sendEvent("tool-error", { toolCallId, toolName: "check_continuity", error: message, retryable: true });
    emitText(`第 ${action.chapter} 章核账没跑成：${message}。可以再点一次「核账」。`);
    const rest = args.scrubber.flush();
    if (rest) args.sendEvent("text-delta", { text: rest });
    return;
  }
  args.sendEvent("tool-result", { toolCallId, toolName: "check_continuity", output });
  const result = output as CheckContinuityLikeOutput | undefined;
  emitText(typeof result?.summary === "string" && result.summary.trim() ? result.summary.trim() : `第 ${action.chapter} 章核账做完了。`);
  const rest = args.scrubber.flush();
  if (rest) args.sendEvent("text-delta", { text: rest });
  const sureCount = Array.isArray(result?.sure) ? result.sure.length : 0;
  const choices: NextStepChoice[] = sureCount > 0
    ? [
      { label: `改掉确定的 ${sureCount} 处`, intent: `按核账结果把第 ${action.chapter} 章确定对不上的那几处改掉，别的不动`, recommended: true },
      { label: "我自己改", intent: "我自己改，先放着" },
      { label: "预览定稿", intent: `预览第 ${action.chapter} 章的定稿改动` },
    ]
    : [
      { label: "预览定稿", intent: `预览第 ${action.chapter} 章的定稿改动`, recommended: true },
      { label: "写下一章", intent: "继续写下一章的正文" },
    ];
  const nextCallId = `user-action-next-${stamp}`;
  args.sendEvent("tool-call", { toolCallId: nextCallId, toolName: "suggest_next_steps", args: {} });
  args.sendEvent("tool-result", {
    toolCallId: nextCallId,
    toolName: "suggest_next_steps",
    output: { ok: true, question: sureCount > 0 ? "核账做完了，这几处怎么处理？" : "核账做完了，接下来？", choices },
  });
}

interface PruneLikeOutput {
  readonly ok?: unknown;
  readonly summary?: unknown;
}

/** 「确认裁剪」按钮：服务端直接真裁（带用户确认标记），结果按 agent 回合同款事件推给前端。 */
async function runPruneAction(args: Omit<Parameters<typeof runUserAction>[0], "action"> & {
  readonly action: Extract<UserAction, { readonly toolName: "prune_snapshots" }>;
}): Promise<void> {
  const { action } = args;
  const toolCallId = `user-action-prune_snapshots-${Date.now()}`;
  const input = { confirm: true, ...(action.keep ? { keep: action.keep } : {}) };
  const emitText = (text: string): void => {
    const scrubbed = args.scrubber.push(text);
    if (scrubbed) args.sendEvent("text-delta", { text: scrubbed });
  };
  const flush = (): void => {
    const rest = args.scrubber.flush();
    if (rest) args.sendEvent("text-delta", { text: rest });
  };
  args.sendEvent("tool-call", { toolCallId, toolName: "prune_snapshots", args: input });
  let output: unknown;
  markUserConfirmedTool(args.requestContext, "prune_snapshots");
  try {
    output = await args.executeTool("prune_snapshots", input, args.requestContext);
  } catch (error) {
    const message = args.scrubError(error);
    args.sendEvent("tool-error", { toolCallId, toolName: "prune_snapshots", error: message, retryable: true });
    emitText(`裁剪操作历史没有完成：${message}。历史没有被改动，可以再点一次「确认裁剪」重试。`);
    flush();
    return;
  } finally {
    markUserConfirmedTool(args.requestContext, undefined);
  }
  args.sendEvent("tool-result", { toolCallId, toolName: "prune_snapshots", output });
  const result = output as PruneLikeOutput | undefined;
  const summary = typeof result?.summary === "string" && result.summary.trim()
    ? result.summary.trim()
    : result?.ok === true ? "操作历史已裁剪。" : "操作历史没有裁剪。";
  emitText(summary);
  flush();
}
