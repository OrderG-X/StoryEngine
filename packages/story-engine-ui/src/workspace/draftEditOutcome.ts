/**
 * 改稿做完了（写作版本 P2a 片 2C：按核账改 / 去 AI 味 / 改写）：稿纸已按盘上重读过，这里高亮改后那几句，
 * AI 味卡上改掉的几句标「已改」，卡上的「改写中…」「全修中…」收起。没换上、不是稿纸开着的那章只收起。
 */
import type { EditChangeData, OperationViewData } from "../api/agentChatClient.js";
import { useChatStore } from "../stores/chatStore.js";
import { useDraftStore } from "../stores/draftStore.js";
import { useUiStore } from "../stores/uiStore.js";
import { cardOf } from "../utils/messageCards.js";

export function settleDraftEdit(view: OperationViewData): void {
  const applied = view.state === "succeeded" && view.draft?.applied === true;
  const changes = applied ? view.draft?.changes ?? [] : [];
  const ui = useUiStore.getState();
  // 删掉的那句（改成空）没东西可标。
  const changed = changes.map((change) => change.to).filter((text) => text.trim());
  if (changed.length > 0 && useDraftStore.getState().chapter === view.chapter) ui.setRevisionHighlights(changed);
  const messageId = ui.aiFlavorPending?.messageId ?? ui.aiFlavorBatchPending;
  if (messageId && changes.length > 0) markFixedViolations(messageId, changes);
  clearAiFlavorFixing();
}

/** AI 味卡上「改写中…」「全修中…」收起（改稿没交上、停掉了也要收）。 */
export function clearAiFlavorFixing(): void {
  const ui = useUiStore.getState();
  if (ui.aiFlavorPending) ui.setAiFlavorPending(null);
  if (ui.aiFlavorBatchPending) ui.setAiFlavorBatchPending(null);
}

const squash = (text: string): string => text.replace(/\s+/gu, "");

/** 卡上哪几句真改掉了：改前那句就是它（一句包着另一句也算）。 */
function markFixedViolations(messageId: string, changes: readonly EditChangeData[]): void {
  const store = useChatStore.getState();
  const message = store.messages.find((item) => item.id === messageId);
  const card = message ? cardOf(message, "ai-flavor") : undefined;
  if (!card) return;
  const froms = changes.map((change) => squash(change.from)).filter(Boolean);
  for (const violation of card.report.violations) {
    const text = squash(violation.text);
    if (text && froms.some((from) => from.includes(text) || text.includes(from))) store.markAiFlavorViolationFixed(messageId, violation.id);
  }
}
