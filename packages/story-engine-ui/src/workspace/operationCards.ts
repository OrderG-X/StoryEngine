/**
 * 操作卡跟着操作变（写作版本 P2a）：同一次操作可能挂在好几条消息上（交它的那一轮、点「接着做」「不要了」的那一轮），
 * 一次变了，所有挂着它的卡一起变；检查、写稿的结果卡只挂在这一轮的那条（owner）上。
 */
import type { OperationViewData } from "../api/agentChatClient.js";
import { projectAgentEvent } from "../hooks/agentEventProjection.js";
import { useChatStore } from "../stores/chatStore.js";
import { cardOf } from "../utils/messageCards.js";
import type { ChapterMessage } from "../types.js";
import type { OperationCardData } from "../type-defs/workspace.js";

/** 结束了的操作（不会再变）。 */
export const ENDED_OPERATION_STATES: ReadonlySet<OperationCardData["state"]> = new Set(["succeeded", "failed", "cancelled", "obsolete"]);

const carries = (message: ChapterMessage, opId: string): boolean => cardOf(message, "operation")?.op.opId === opId;

/**
 * 这次操作又变了：owner 那条整份投影（含结果卡），别的挂着同一次操作的只换操作卡。
 * announced＝这一轮接着会把结论说出来（对话这一轮里收到的终态），owner 的卡上就不再重复。
 */
export function projectOperationEverywhere(view: OperationViewData, ownerMessageId?: string, options: { readonly announced?: boolean } = {}): void {
  const { inspect: _inspect, draft: _draft, ...bare } = view;
  const store = useChatStore.getState();
  for (const message of store.messages) {
    if (message.id === ownerMessageId) {
      store.updateMessage(message.id, (current) => projectAgentEvent(current, { type: "operation", operation: view, ...(options.announced ? { announced: true as const } : {}) }));
    }
    else if (carries(message, view.opId)) store.updateMessage(message.id, (current) => projectAgentEvent(current, { type: "operation", operation: bare }));
  }
}

/** 这次操作的一句进度：挂着它的卡都记上。 */
export function projectOperationProgressEverywhere(opId: string, text: string): void {
  const store = useChatStore.getState();
  for (const message of store.messages) {
    if (carries(message, opId)) store.updateMessage(message.id, (current) => projectAgentEvent(current, { type: "operation-progress", opId, text }));
  }
}
