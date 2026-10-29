/**
 * 开书、换会话之后接着看还没结束的操作（写作版本 P2a 设计第九节）：对话那条流断过（关过页、重开书）操作照跑，
 * 这里按 `GET /api/operations?active=1` 找出来，挂回原来那条消息、订阅它，到结束为止。
 *
 * 挂在哪条：已经有这次操作的卡的那条；没有（流断在头一份记录到之前）就是交它的那句话后面的那条助手消息。都找不到
 * （别的会话里交的、后台补读）不挂。卡上还说在做、其实关页期间已经结束的，也问一下拿到结果。换书、换会话就停掉旧的订阅。
 */
import { followOperationEvents, listActiveOperations } from "../api/operationsClient.js";
import type { OperationViewData } from "../api/agentChatClient.js";
import { useChatStore } from "../stores/chatStore.js";
import { useNavigationStore } from "../stores/navigationStore.js";
import { cardOf } from "../utils/messageCards.js";
import type { ChapterMessage } from "../types.js";
import { ENDED_OPERATION_STATES, projectOperationEverywhere, projectOperationProgressEverywhere } from "./operationCards.js";

let current: AbortController | null = null;

/** 这次操作挂在哪条消息上（见文件头）。 */
export function ownerOfOperation(messages: readonly ChapterMessage[], view: Pick<OperationViewData, "opId" | "origin">): string | undefined {
  const carrying = messages.find((message) => cardOf(message, "operation")?.op.opId === view.opId);
  if (carrying) return carrying.id;
  const asked = view.origin.messageId;
  if (view.origin.kind !== "chat" || !asked) return undefined;
  const index = messages.findIndex((message) => message.role === "user" && message.id === asked);
  if (index < 0) return undefined;
  return messages.slice(index + 1).find((message) => message.role === "assistant")?.id;
}

/** 卡上还没结束的那几次（关页时还在做、停着的）：结束了没有要问一下，不然卡一直说「在做」。 */
function unsettledCards(messages: readonly ChapterMessage[]): readonly { readonly opId: string; readonly owner: string }[] {
  return messages.flatMap((message) => {
    const op = cardOf(message, "operation")?.op;
    return op && !ENDED_OPERATION_STATES.has(op.state) ? [{ opId: op.opId, owner: message.id }] : [];
  });
}


/**
 * 接着看这本书、这个会话里还没结束的操作（在做的那几次 + 卡上还没结束的那几次），挂回去订阅到结束。
 * 再调一次（换书、换会话）先停掉上一次的。列在做的那次没成也照样问卡上那几次。
 */
export function reconnectOperations(projectPath: string): void {
  current?.abort();
  const controller = new AbortController();
  current = controller;
  const sessionId = useChatStore.getState().activeSessionId;
  const stillHere = (): boolean => !controller.signal.aborted
    && useNavigationStore.getState().projectPath === projectPath
    && useChatStore.getState().activeSessionId === sessionId;
  const followed = new Set<string>();
  const follow = (opId: string, owner: string): void => {
    if (followed.has(opId) || !stillHere()) return;
    followed.add(opId);
    void followOperationEvents(projectPath, opId, {
      onOperation: (next) => { if (stillHere()) projectOperationEverywhere(next, owner); },
      onProgress: (text) => { if (stillHere()) projectOperationProgressEverywhere(opId, text); },
    }, controller.signal);
  };
  void listActiveOperations(projectPath, controller.signal)
    .catch(() => [] as readonly OperationViewData[])
    .then((operations) => {
      for (const view of operations) {
        const owner = stillHere() ? ownerOfOperation(useChatStore.getState().messages, view) : undefined;
        if (owner) follow(view.opId, owner);
      }
      if (!stillHere()) return;
      for (const { opId, owner } of unsettledCards(useChatStore.getState().messages)) follow(opId, owner);
    });
}

/** 换书、关书时停掉订阅。 */
export function stopOperationReconnect(): void {
  current?.abort();
  current = null;
}
