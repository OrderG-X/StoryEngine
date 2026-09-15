/**
 * ChatContextMeter — 上下文占用提示条（codex AI 列，消息列表与输入框之间）。
 *
 * pct < 80%：低调灰显「上下文 NN%」。
 * pct >= 80%：暗金高亮 + 常驻「清理早先消息」按钮，直到 pct 降下来。
 * 点「清理」：archiveChatSession → setActiveArchivedCount + 显示「撤销清理」。
 * 点「撤销清理」：unarchiveChatSession → archivedCount 清零。
 */
import { useMemo, useState } from "react";
import { estimateTokens } from "../../../lib/estimate-tokens.js";
import { useWorkspaceStore } from "../../../stores/workspaceStore.js";
import { useNavigationStore } from "../../../stores/navigationStore.js";
import { archiveChatSession, unarchiveChatSession } from "../../../api/chatSessionsClient.js";

export function ChatContextMeter() {
  // 按字段订阅（不整店订阅）：流式逐 token 更新 draft/flowStatus 等无关切片时，本条不必跟着重渲染。
  const messages = useWorkspaceStore((s) => s.workspace.messages);
  const activeArchivedCount = useWorkspaceStore((s) => s.activeArchivedCount);
  const activeSessionId = useWorkspaceStore((s) => s.activeSessionId);
  const chatHistoryBudget = useWorkspaceStore((s) => s.chatHistoryBudget);
  const setActiveArchivedCount = useWorkspaceStore((s) => s.setActiveArchivedCount);
  const projectPath = useNavigationStore((s) => s.projectPath);
  const [busy, setBusy] = useState(false);
  // canUndo 由服务端真值派生，不用组件局部 state：本条在视图切换卸载后重建，局部态会丢掉
  // 「撤销清理」入口，而磁盘上其实还存着归档（activeArchivedCount>0）。真值驱动=重挂上也照出。
  const canUndo = activeArchivedCount > 0;

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

  if (pct < 80 && !canUndo) {
    return <div className="codex-context-meter low">对话记忆 {pct}%</div>;
  }

  return (
    <div className={`codex-context-meter${pct >= 80 ? " warn" : ""}`}>
      <span>对话记忆 {pct}%</span>
      {pct >= 80 && (
        <button type="button" disabled={busy} onClick={() => void onArchive()}>
          {busy ? "清理中…" : "清理早先消息"}
        </button>
      )}
      {canUndo && (
        <button type="button" disabled={busy} onClick={() => void onUndo()}>
          撤销清理
        </button>
      )}
    </div>
  );
}
