/**
 * ChatContextMeter — 上下文占用提示条（codex AI 列，消息列表与输入框之间）。
 *
 * pct < 80%：不显示（P6 右栏瘦身）。
 * pct >= 80%：暗金高亮 + 「清理早先消息」按钮，直到 pct 降下来。
 * 点「清理」：archiveChatSession → setActiveArchivedCount；消息流顶上出「已清理 N 条早先消息」折叠行。
 * 撤销清理（unarchiveChatSession）放在那行点开之后的末尾（UnarchiveButton），不再常驻占一条（2026-10-22 减字）。
 */
import { useMemo, useState } from "react";
import { estimateTokens } from "../../../lib/estimate-tokens.js";
import { useChatStore } from "../../../stores/chatStore.js";
import { useNavigationStore } from "../../../stores/navigationStore.js";
import { archiveChatSession, unarchiveChatSession } from "../../../api/chatSessionsClient.js";

export function ChatContextMeter() {
  // 按字段订阅（不整店订阅）：流式逐 token 更新 draft/flowStatus 等无关切片时，本条不必跟着重渲染。
  const messages = useChatStore((s) => s.messages);
  const activeArchivedCount = useChatStore((s) => s.activeArchivedCount);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const chatHistoryBudget = useChatStore((s) => s.chatHistoryBudget);
  const setActiveArchivedCount = useChatStore((s) => s.setActiveArchivedCount);
  const projectPath = useNavigationStore((s) => s.projectPath);
  const [busy, setBusy] = useState(false);

  const pct = useMemo(() => {
    const active = messages.slice(activeArchivedCount).map((m) => m.content).join("\n");
    return Math.min(100, Math.round((estimateTokens(active) / chatHistoryBudget) * 100));
  }, [messages, activeArchivedCount, chatHistoryBudget]);

  async function onArchive() {
    if (!projectPath || !activeSessionId) return;
    setBusy(true);
    try {
      const r = await archiveChatSession(projectPath, activeSessionId);
      setActiveArchivedCount(r.archivedCount);
    } catch (err) {
      // 审查 #19：失败不再吞进未处理 rejection——如实提示，按钮恢复可点。
      useNavigationStore.getState().showToast(`清理早先消息失败：${err instanceof Error ? err.message : String(err)}`, 3200);
    } finally {
      setBusy(false);
    }
  }

  // P6：平时不占一条，快满了（≥80%）才出来。
  if (pct < 80) return null;

  return (
    <div className="codex-context-meter warn">
      <span>对话记忆 {pct}%</span>
      <button type="button" disabled={busy} onClick={() => void onArchive()}>
        {busy ? "清理中…" : "清理早先消息"}
      </button>
    </div>
  );
}

/** 「已清理的早先消息」点开后末尾那个按钮：放回对话（撤销清理）。归档数是服务端真值，重挂上也照出。 */
export function UnarchiveButton({ disabled = false }: { readonly disabled?: boolean }) {
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const setActiveArchivedCount = useChatStore((s) => s.setActiveArchivedCount);
  const projectPath = useNavigationStore((s) => s.projectPath);
  const [busy, setBusy] = useState(false);
  async function onUndo() {
    if (!projectPath || !activeSessionId) return;
    setBusy(true);
    try {
      const r = await unarchiveChatSession(projectPath, activeSessionId);
      setActiveArchivedCount(r.archivedCount);
    } catch (err) {
      useNavigationStore.getState().showToast(`撤销清理失败：${err instanceof Error ? err.message : String(err)}`, 3200);
    } finally {
      setBusy(false);
    }
  }
  return (
    <button type="button" className="chip codex-unarchive" disabled={disabled || busy} onClick={() => void onUndo()}>
      {busy ? "放回中…" : "撤销清理，放回对话"}
    </button>
  );
}
