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
export const USER_ACTION_TOOL_NAMES = ["commit_apply"] as const;
export type UserActionToolName = (typeof USER_ACTION_TOOL_NAMES)[number];

export interface UserAction {
  readonly toolName: UserActionToolName;
  readonly chapter: number;
  readonly previewToken?: string;
}

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
  const chapter = typeof record.chapter === "string" ? Number(record.chapter.trim()) : record.chapter;
  if (typeof chapter !== "number" || !Number.isInteger(chapter) || chapter <= 0) {
    return { kind: "invalid", reason: "缺少有效章号。" };
  }
  const previewToken = typeof record.previewToken === "string" && record.previewToken.trim()
    ? record.previewToken.trim()
    : undefined;
  return {
    kind: "action",
    action: { toolName: toolName as UserActionToolName, chapter, ...(previewToken ? { previewToken } : {}) },
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
      { chapter: action.chapter, ...(action.previewToken ? { previewToken: action.previewToken } : {}) },
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
