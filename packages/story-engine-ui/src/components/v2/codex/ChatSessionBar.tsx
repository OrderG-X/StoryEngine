/**
 * ChatSessionBar — 聊天面板顶部会话入口（走天涯 Task 8）。
 *
 * 一行三件：当前会话名（点击就地重命名）、「＋」新会话、历史图标（弹出会话列表）。
 * 历史列表每项可切换 / 改名 / 删除。
 * 样式全部在 codex.css 的 .codex-app 作用域下（铁律 3）。
 */
import { useEffect, useRef, useState } from "react";
import { useWorkspaceStore } from "../../../stores/workspaceStore.js";
import { useNavigationStore } from "../../../stores/navigationStore.js";
import { flushAutosaveNow } from "../../../utils/autosaveControl.js";
import * as api from "../../../api/chatSessionsClient.js";
import type { ChatSession, ChatSessionIndex } from "../../../type-defs/workspace.js";
import { formatRelativeSessionTime } from "./formatRelativeSessionTime.js";
import {
  beginWorkspaceOperation,
  finishWorkspaceOperation,
  isWorkspaceBusy,
  isWorkspaceOperationTargetCurrent,
  type WorkspaceOperationToken,
} from "../../../utils/workspaceOperation.js";

/** 把 token 预算压成人话：300000 → 300k，1500000 → 1.5M。 */
function fmtBudget(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (n >= 1000) {
    const k = Math.round(n / 1000);
    return k >= 1000 ? "1M" : `${k}k`; // 防 999999 四舍五入成反直觉的 "1000k"
  }
  return String(n);
}

export function ChatSessionBar() {
  const {
    sessions,
    activeSessionId,
    setSessions,
    updateWorkspace,
    setActiveArchivedCount,
    chatHistoryBudget,
    setChatHistoryBudget,
  } = useWorkspaceStore();
  const projectPath = useNavigationStore((s) => s.projectPath);
  // 审查 #6：生成进行中禁用会话操作，避免把 A 会话的流式内容存进刚切过去的 B。
  const chatLoading = useWorkspaceStore((s) => s.chatLoading);
  const draftActionLoading = useWorkspaceStore((s) => s.draftActionLoading);
  const steeringLoading = useWorkspaceStore((s) => s.steeringLoading);
  const workspaceBusy = chatLoading || Boolean(draftActionLoading) || steeringLoading || isWorkspaceBusy();

  function notify(message: string) {
    useNavigationStore.getState().showToast(message, 3200);
  }

  function currentSessionIdentity() {
    const live = useWorkspaceStore.getState();
    return {
      projectPath: useNavigationStore.getState().projectPath ?? "",
      chapter: live.workspace.currentChapter.chapterNumber,
      sessionId: live.activeSessionId,
    };
  }

  function beginSessionTransition(): WorkspaceOperationToken | null {
    const token = beginWorkspaceOperation("session-transition", currentSessionIdentity());
    if (!token) notify("已有操作正在进行，请等它结束后再切换会话。");
    return token;
  }

  function ownsSessionOrigin(token: WorkspaceOperationToken): boolean {
    return isWorkspaceOperationTargetCurrent(token, currentSessionIdentity());
  }

  function applySessionTruth(result: { readonly index: ChatSessionIndex; readonly session: ChatSession }): void {
    setSessions(result.index.sessions, result.index.activeSessionId);
    updateWorkspace({ messages: result.session.messages ?? [] });
    setActiveArchivedCount(result.session.archivedCount ?? 0);
  }

  async function reconcileSessionTruth(
    transition: WorkspaceOperationToken,
    actionLabel: string,
    originalError: unknown,
  ): Promise<boolean> {
    try {
      const listed = await api.listChatSessions(transition.projectPath);
      if (!ownsSessionOrigin(transition)) return false;
      const target = await api.readChatSession(transition.projectPath, listed.index.activeSessionId);
      if (!ownsSessionOrigin(transition)) return false;
      if (!target.session) throw new Error(`活跃会话不可读: ${listed.index.activeSessionId}`);
      applySessionTruth({ index: listed.index, session: target.session });
      notify(`${actionLabel}的结果没有收到确认，已按磁盘上的实际内容重新同步。`);
      return true;
    } catch (reconcileError) {
      if (ownsSessionOrigin(transition)) {
        console.error(`[ChatSessionBar] ${actionLabel}后对账失败`, { originalError, reconcileError });
        notify(`${actionLabel}的结果丢失且磁盘对账失败，当前会话状态不确定，请刷新页面后再操作。`);
      }
      return false;
    }
  }

  /** 生成进行中拦截会话操作（切换/新建/删除），如实提示而非静默串会话。 */
  function blockedByGeneration(): boolean {
    if (workspaceBusy) {
      notify("写作操作正在进行，请等本次操作结束再切换会话。");
      return true;
    }
    return false;
  }

  const [historyOpen, setHistoryOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [budgetOpen, setBudgetOpen] = useState(false);
  // 下拉里打字时的实时预览值（用于「≈ 300k」回显，不影响最终 onBlur 落盘）
  const [budgetDraft, setBudgetDraft] = useState(chatHistoryBudget);
  // 列表内行内改名 state：{ id, value } | null
  const [inlineRename, setInlineRename] = useState<{ id: string; value: string } | null>(null);

  const historyRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const renameRequestSeqRef = useRef(0);

  const activeName = sessions.find((s) => s.id === activeSessionId)?.name ?? "新会话";
  const displayName = activeName === "新会话" || activeName === "会话" ? "当前会话" : activeName;

  // 点 bar 以外的地方：收起上下文 / 历史下拉；若预算框里有没提交的值，先落盘再关。
  useEffect(() => {
    if (!budgetOpen && !historyOpen) return;
    function onDocMouseDown(e: MouseEvent) {
      if (barRef.current?.contains(e.target as Node)) return;
      if (budgetOpen && budgetDraft > 0 && budgetDraft !== chatHistoryBudget) {
        setChatHistoryBudget(budgetDraft);
        void saveBudgetToSettings(budgetDraft);
      }
      setBudgetOpen(false);
      setHistoryOpen(false);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [budgetOpen, historyOpen, budgetDraft, chatHistoryBudget]);

  async function saveBudgetToSettings(budget: number) {
    if (!projectPath) return;
    try { await api.saveChatHistoryBudget(projectPath, budget); } catch (err) {
      console.error("[ChatSessionBar] 保存上下文预算失败", err);
    }
  }

  // ─── 新建会话 ─────────────────────────────────────────────────────────────
  async function onNew() {
    if (!projectPath || blockedByGeneration()) return;
    const transition = beginSessionTransition();
    if (!transition) return;
    try {
      const flushed = await flushAutosaveNow();
      if (!flushed.ok) {
        notify(`保存失败，未新建会话：${flushed.error}`);
        return;
      }
      const r = await api.createChatSession(projectPath);
      if (!ownsSessionOrigin(transition)) return;
      applySessionTruth(r);
    } catch (err) {
      if (ownsSessionOrigin(transition)) {
        console.error("[ChatSessionBar] 新建会话失败", err);
        await reconcileSessionTruth(transition, "新建会话", err);
      }
    } finally {
      finishWorkspaceOperation(transition);
    }
  }

  // ─── 切换会话（审查 #6·事务化）─────────────────────────────────────────────
  // 先把当前会话未落盘的编辑刷盘 → 再读目标会话 messages（读成功后）才切 active + 换内存消息；
  // 任一步失败：不改 active、不动内存消息、如实提示。杜绝「A 内容显示在 B 名下、再存进 B」的串会话。
  async function onSwitch(id: string) {
    if (!projectPath || id === activeSessionId) {
      setHistoryOpen(false);
      return;
    }
    if (blockedByGeneration()) return;
    const transition = beginSessionTransition();
    if (!transition) return;
    try {
      const flushed = await flushAutosaveNow();
      if (!flushed.ok) {
        notify(`保存失败，仍停留在当前会话：${flushed.error}`);
        return;
      }
      const r = await api.setActiveChatSession(projectPath, id);
      if (!ownsSessionOrigin(transition)) return;
      applySessionTruth(r);
    } catch (err) {
      if (ownsSessionOrigin(transition)) {
        console.error("[ChatSessionBar] 切换会话失败", err);
        await reconcileSessionTruth(transition, "切换会话", err);
      }
    } finally {
      finishWorkspaceOperation(transition);
      setHistoryOpen(false);
    }
  }

  // ─── 重命名（头部当前会话名 / 列表行内） ─────────────────────────────────
  async function onRename(id: string, name: string) {
    if (!projectPath || !name.trim()) return;
    const requestSeq = ++renameRequestSeqRef.current;
    const origin = currentSessionIdentity();
    try {
      const r = await api.renameChatSession(projectPath, id, name.trim());
      const live = currentSessionIdentity();
      if (requestSeq !== renameRequestSeqRef.current
        || live.projectPath !== origin.projectPath
        || live.chapter !== origin.chapter
        || live.sessionId !== origin.sessionId) return;
      setSessions(r.index.sessions);
    } catch (err) {
      console.error("[ChatSessionBar] 重命名失败", err);
      notify(`重命名失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ─── 删除 ─────────────────────────────────────────────────────────────────
  async function onDelete(id: string) {
    if (!projectPath || blockedByGeneration()) return;
    const transition = beginSessionTransition();
    if (!transition) return;
    try {
      const flushed = await flushAutosaveNow();
      if (!flushed.ok) {
        notify(`保存失败，未删除会话：${flushed.error}`);
        return;
      }
      const r = await api.deleteChatSession(projectPath, id);
      if (!ownsSessionOrigin(transition)) return;
      applySessionTruth(r);
    } catch (err) {
      if (ownsSessionOrigin(transition)) {
        console.error("[ChatSessionBar] 删除会话失败", err);
        await reconcileSessionTruth(transition, "删除会话", err);
      }
    } finally {
      finishWorkspaceOperation(transition);
    }
  }

  // ─── 点头部会话名：当前名 onBlur 改名 ───────────────────────────────────
  function handleHeadBlur(e: React.FocusEvent<HTMLInputElement>) {
    void onRename(activeSessionId, e.target.value);
    setEditing(false);
  }

  // ─── 列表行内改名提交 ────────────────────────────────────────────────────
  function commitInlineRename() {
    if (!inlineRename) return;
    void onRename(inlineRename.id, inlineRename.value);
    setInlineRename(null);
  }

  return (
    <div className="codex-chat-session-bar" ref={barRef}>
      {/* 当前会话名：点击就地编辑 */}
      {editing ? (
        <input
          className="codex-session-name-input"
          autoFocus
          defaultValue={activeName}
          onBlur={handleHeadBlur}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") { setEditing(false); }
          }}
        />
      ) : (
        <button
          className="codex-session-name"
          onClick={() => setEditing(true)}
          title="重命名会话"
          aria-label="重命名会话"
        >
          <span className="csn-label">{displayName}</span>
          <span className="csn-edit" aria-hidden="true">✎</span>
        </button>
      )}

      {/* ＋ 新会话 */}
      <button
        className="codex-session-action"
        onClick={() => void onNew()}
        disabled={workspaceBusy}
        title={workspaceBusy ? "写作操作进行中，暂不能新建会话" : "开一条新的空白会话（旧会话进「历史」保留）"}
      >
        <span className="csa-glyph" aria-hidden="true">＋</span>新会话
      </button>

      {/* ☰ 历史会话 */}
      <button
        className={`codex-session-action${historyOpen ? " is-open" : ""}`}
        onClick={() => { setHistoryOpen((v) => !v); setBudgetOpen(false); }}
        disabled={workspaceBusy}
        title={workspaceBusy ? "写作操作进行中，暂不能切换会话" : "切换 / 管理历史会话"}
        aria-expanded={historyOpen}
      >
        <span className="csa-glyph" aria-hidden="true">☰</span>历史
      </button>

      {/* ⚙ 上下文设置（按钮上常驻显示当前预算，如 300k） */}
      <button
        className={`codex-session-action${budgetOpen ? " is-open" : ""}`}
        onClick={() => {
          const next = !budgetOpen;
          setBudgetOpen(next);
          setHistoryOpen(false);
          if (next) setBudgetDraft(chatHistoryBudget);
        }}
        title="设置 AI 最多保留多少对话记忆"
        aria-expanded={budgetOpen}
      >
        <span className="csa-glyph" aria-hidden="true">⚙</span>对话记忆
        <span className="csa-budget-tag">{fmtBudget(chatHistoryBudget)}</span>
      </button>
      {budgetOpen && (
        <div className="codex-budget-pop">
          <div className="codex-budget-label">对话记忆上限</div>
          <div className="codex-budget-hint">这是 AI 一次能参考的对话内容总量；上限越高，越能记住早先内容。1M 模型建议 300000，小模型可用默认 96000。</div>
          <input
            className="codex-session-budget"
            type="number"
            min={10000}
            step={10000}
            autoFocus
            defaultValue={chatHistoryBudget}
            key={chatHistoryBudget}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              if (!Number.isNaN(v)) setBudgetDraft(v);
            }}
            onBlur={(e) => {
              const v = parseInt(e.target.value, 10);
              if (v > 0 && v !== chatHistoryBudget) {
                setChatHistoryBudget(v);
                void saveBudgetToSettings(v);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") { (e.target as HTMLInputElement).blur(); setBudgetOpen(false); }
              if (e.key === "Escape") setBudgetOpen(false);
            }}
          />
          <div className="codex-budget-preview">≈ <strong>{fmtBudget(budgetDraft)}</strong> tokens</div>
        </div>
      )}

      {/* 历史会话浮层 */}
      {historyOpen && (
        <div className="codex-session-history-pop" ref={historyRef}>
          <div className="cssp-head">历史会话</div>
          {sessions.length === 0 && (
            <div className="cssp-empty">暂无其他会话</div>
          )}
          <ul className="cssp-list">
            {sessions.map((s) => (
              <li
                key={s.id}
                className={`cssp-item${s.id === activeSessionId ? " is-active" : ""}`}
              >
                {inlineRename?.id === s.id ? (
                  /* 行内改名 input */
                  <input
                    className="cssp-rename-input"
                    autoFocus
                    value={inlineRename.value}
                    onChange={(e) => setInlineRename({ id: s.id, value: e.target.value })}
                    onBlur={commitInlineRename}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitInlineRename();
                      if (e.key === "Escape") setInlineRename(null);
                    }}
                  />
                ) : (
                  <button
                    className="cssp-name"
                    onClick={() => void onSwitch(s.id)}
                    title={s.name}
                  >
                    {s.id === activeSessionId && (
                      <span className="cssp-cur-dot" aria-hidden="true" />
                    )}
                    <span className="cssp-meta">
                      <span className="cssp-label">{s.name}</span>
                      <span className="cssp-time">
                        {formatRelativeSessionTime(s.updatedAt)}
                        {s.id === activeSessionId ? " · 当前" : ""}
                      </span>
                    </span>
                  </button>
                )}
                <span className="cssp-actions">
                  <button
                    className="cssp-btn cssp-btn-text"
                    onClick={() => setInlineRename({ id: s.id, value: s.name })}
                    aria-label="重命名"
                    title="重命名"
                  >
                    重命名
                  </button>
                  <button
                    className="cssp-btn cssp-btn-text cssp-btn-del"
                    onClick={() => void onDelete(s.id)}
                    aria-label="删除"
                    title="删除"
                    disabled={sessions.length <= 1}
                  >
                    删除
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
