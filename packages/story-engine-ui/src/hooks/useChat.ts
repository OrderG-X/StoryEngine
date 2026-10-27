import { useCallback, useRef } from "react";
import { clearLedgerExclusions, ledgerDayOverrideForConfirm, ledgerExclusionsForConfirm } from "../utils/ledgerExclusions.js";
import { fetchStateOverview, restoreSnapshotApi } from "../api/client.js";
import { streamAgentChat, type AgentUserAction } from "../api/agentChatClient.js";
import { renameChatSession } from "../api/chatSessionsClient.js";
import {
  emptyAssistantMessage,
  projectAgentEvent,
  settleStoppedAgentTurn,
  type AgentProjectionEvent,
} from "./agentEventProjection.js";
import { deriveIntentTitle } from "./deriveIntentTitle.js";
import { nextFlowAfterToolResult } from "./agentFlowStatus.js";
import { truncateMessagesFrom, undoCutId } from "./truncateMessages.js";
import { buildOutboundConversation } from "./buildOutboundConversation.js";
import { flowStatusAfterGenerateFailure } from "./reconcileChapterState.js";
import { openCommitSheet, reusableCommitPreviewId } from "../workspace/commitSheet.js";
import { userActionChoiceText } from "../utils/chapterActionIntents.js";
import { chapterButtonAction, NO_CHAPTER_HINT, type ChapterButton } from "../utils/chapterButtons.js";
import { directionGoal, pickedDirection, pickedDirectionGoal } from "../utils/brainstormCard.js";
import type { StateOverview } from "../api/types.js";
import type { ChapterMessage, CommitConfirmTarget, SuggestedAction } from "../types.js";
import { useBookStore } from "../stores/bookStore.js";
import { useChatStore } from "../stores/chatStore.js";
import { useUiStore } from "../stores/uiStore.js";
import { useNavigationStore } from "../stores/navigationStore.js";
import { useDraftStore } from "../stores/draftStore.js";
import {
  beginWorkspaceOperation,
  finishWorkspaceOperation,
  isWorkspaceBusy,
  isWorkspaceOperationCurrent,
  isWorkspaceOperationTargetCurrent,
  retargetWorkspaceOperation,
} from "../utils/workspaceOperation.js";
import { lastTurnUndoHintFromMessages } from "../utils/lastTurnUndoHint.js";
import { stripStaleTurnSuggestions } from "../utils/staleTurnSuggestions.js";
import { streamingDraftDisplay } from "../utils/streamingDraftDisplay.js";
import { editDraft, flushDraftSave, holdDraftSaves, openPaper, refreshPaper } from "../drafts/draftSync.js";
import { saveChatNow } from "../sync/chatSync.js";
import { flushAllSaves } from "../sync/saveAll.js";
import { applyOverviewToWorkspace, flowStatusForPaper } from "../workspace/applyOverview.js";
import { syncWorkspaceAfterRestore } from "../workspace/syncAfterRestore.js";
import { fetchChapterPaper } from "../api/workingDraftClient.js";
import { patchChapterFlagsFromPaper } from "../utils/bookUtils.js";
import { aiErrorAfterWriteBody, aiErrorBody } from "../lib/ai-error-text.js";
import type { AiErrorReason } from "../server/lib/ai-errors.js";

/** 回合收尾等盘上重读最多等这么久（读盘卡住不能一直占着工作区）。 */
const RESYNC_WAIT_MS = 5_000;

async function settleWithin(promises: readonly Promise<unknown>[], ms: number): Promise<void> {
  if (promises.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled(promises),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
}


/* ------------------------------------------------------------------ */
/*  useChat hook                                                        */
/* ------------------------------------------------------------------ */

export interface UseChatParams {
  projectPath: string | null;
  handleApplyRevisionPreview: () => Promise<void>;
  /**
   * 资料类刷新：仅按 StateOverview 重建资料/侧栏面板，保留当前章节/草稿/消息。
   * agent 的 foundation_write 结果（refreshScope:"foundation"）调它；可不传。
   */
  refreshWorkspaceFromOverview?: (overview: StateOverview) => void;
}

export interface UseChatResult {
  handleSendMessage: (message: string) => Promise<void>;
  handleSuggestedAction: (action: SuggestedAction) => void;
  /** 「下一步」选项的结构化动作直达（R4.7）：点击直接发 body.action，不经模型。 */
  handleSendUserAction: (action: AgentUserAction) => Promise<void>;
  handleChapterButton: (button: ChapterButton) => void;
  /** 块级「撤销到此」：把该回合 git 改动整块回退 + 截断该回合及其后对话 + 重拉 overview 刷工作台。 */
  undoToTurn: (message: ChapterMessage) => Promise<void>;
  /** M3：停止当前在跑的 agent 流（中止 SSE）；已写出内容保留、不报错。无在跑流时调用是 no-op。 */
  stopAgent: () => void;
}

/** 作者发这句时在看哪一章（右栏「这一章的对话」按它分，重构 P6 第 6 步）。 */
function chapterStamp(): { readonly chapter?: number } {
  const chapter = useBookStore.getState().workspace.currentChapter?.chapterNumber;
  return typeof chapter === "number" && chapter > 0 ? { chapter } : {};
}

export function useChat(params: UseChatParams): UseChatResult {
  const {
    projectPath,
    handleApplyRevisionPreview,
    refreshWorkspaceFromOverview,
  } = params;

  /* ---- store access ---- */
  const appendMessage = useChatStore((s) => s.appendMessage);
  const updateMessage = useChatStore((s) => s.updateMessage);
  const setChatLoading = useChatStore((s) => s.setChatLoading);
  const setChatError = useChatStore((s) => s.setChatError);

  const showToast = useNavigationStore((s) => s.showToast);
  const autoRenameRequestSeqRef = useRef(0);

  /* ---- internal helpers ---- */

  /**
   * agent 大脑总入口：右侧对话是唯一驱动面——直接把对话交给
   * Mastra 写作总控 agent，它自行决定读状态 / 写资料，全程经 SSE 增量回流。
   *
   * 流程：
   *   - 起一条空 assistant 消息，把 agent 事件经 agentEventProjection 增量投影进同一条消息。
   *   - text-delta 累加文本；tool-call/tool-result 投影成 toolSteps + agentCards（命中时间线字典）。
   *   - onToolResult 按 refreshScope 刷新工作台：full → applyOverviewToWorkspace（随后按盘上重读稿纸）；
   *     foundation → refreshWorkspaceFromOverview（仅刷资料面板，保留章节/草稿/消息）。
   *   - onError 绝不静默失败：追加一条可重试的 assistant 消息（retry-agent，携带原始消息）。
   * 被 handleSendMessage 和「重试」按钮共用。
   */
  // M3：当前在跑的 agent 流的中止器，供「停止」按钮调用；每轮开始时置入、收尾清空。
  const agentAbortRef = useRef<AbortController | null>(null);
  const stopAgent = useCallback(() => {
    agentAbortRef.current?.abort();
  }, []);

  const runAgentDispatch = useCallback(
    async (
      text: string,
      conversation: readonly { readonly role: "user" | "assistant"; readonly content: string }[],
      /** 结构化动作（「确认定稿」按钮）：服务端直接执行对应工具，不经模型。 */
      action?: AgentUserAction,
    ): Promise<void> => {
      if (!projectPath) {
        setChatError("请先打开真实本地项目。");
        return;
      }
      if (useNavigationStore.getState().projectPath !== projectPath) {
        showToast("当前项目已经变化，不能启动旧工作区请求。", 4200);
        return;
      }

      const initialStoreBook = useBookStore.getState();
      const initialStoreChat = useChatStore.getState();
      const claimedOperation = beginWorkspaceOperation("agent-chat", {
        projectPath,
        chapter: initialStoreBook.workspace.currentChapter.chapterNumber,
        sessionId: initialStoreChat.activeSessionId,
      });
      if (!claimedOperation) {
        showToast("已有写作操作正在进行，请等它结束后再发送新请求。", 4200);
        return;
      }
      let operation = claimedOperation;
      const ownsCurrentWorkspace = (): boolean => {
        const currentBook = useBookStore.getState();
        const currentChat = useChatStore.getState();
        return isWorkspaceOperationTargetCurrent(operation, {
          projectPath: useNavigationStore.getState().projectPath ?? "",
          chapter: currentBook.workspace.currentChapter.chapterNumber,
          sessionId: currentChat.activeSessionId,
        });
      };
      const notifyStaleOperation = (): void => {
        useNavigationStore.getState().showToast("你切换了书，那次结果没有写进来。", 5000);
      };

      const assistantMsgId = `assistant-agent-${Date.now()}`;
      appendMessage(emptyAssistantMessage(assistantMsgId));
      // 回合起点打点：意图标题（=用户原话压一行）+ 回合开始墙钟。块头由此渲染。
      updateMessage(assistantMsgId, (current) => ({
        ...current,
        intentTitle: deriveIntentTitle(text),
        turnStartedAt: Date.now(),
      }));

      const project = (event: AgentProjectionEvent) => {
        if (!ownsCurrentWorkspace()) return;
        updateMessage(assistantMsgId, (current) => projectAgentEvent(current, event));
      };

      // 把 tool-call 与 tool-result 关联起来：优先用后端 toolCallId；缺省时退回「同名工具的最近一次合成 id」。
      const toolCallIds = new Map<string, string>();
      const stepIdFor = (toolName: string, toolCallId?: string): string => {
        const id = toolCallId ?? toolCallIds.get(toolName) ?? `${toolName}-${Date.now()}`;
        toolCallIds.set(toolName, id);
        return id;
      };

      setChatLoading(true);
      setChatError(null);

      let sawError = false;
      // 出稿流式缓冲：generate_draft 的正文 delta 逐字累加到这里，显示在稿纸上（只读，不进作者的稿子，重构 P5）。
      // 每次出稿（generate_draft tool-call）重置；出稿结束后稿纸按盘上终稿重读。
      let streamedDraft = "";
      // 接着写时本来写好的那段（服务端先推过来）：原样显示在新写的前面，不当新写的清理（换引号、去星号会改了作者的字）。
      let streamBase = "";
      let draftStreamChapter: number | null = null;
      let reportedDraftChapterMismatch = false;
      // 流式要换到另一章时，先把手上那章存掉、再换稿纸；这期间流来的字先攒着。
      let paperSwitch: Promise<void> | null = null;
      // 本回合发起的稿纸重读：回合收尾、释放操作所有权之前等它们读完。
      const pendingPaperSyncs: Promise<unknown>[] = [];
      const track = (promise: Promise<unknown>): void => {
        pendingPaperSyncs.push(promise.catch(() => undefined));
      };
      // 这一轮已经写好的稿（出稿 / 改稿的结果收到了）：之后再出错，「重试这一步」会把整句话重发、整章重写，不给。
      let finishedWrite: "draft" | "revise" | null = null;
      // 追加一条错误卡消息（error 卡；可重试时带 retry-agent）。tool-error 与 error 共用。
      const appendErrorMessage = (message: string, retryable: boolean, reason?: AiErrorReason) => {
        appendMessage({
          id: `assistant-agent-error-${Date.now()}`,
          role: "assistant",
          content: finishedWrite ? aiErrorAfterWriteBody(reason, finishedWrite) : aiErrorBody(reason),
          cards: [{ type: "error", detail: message, ...(reason ? { reason } : {}) }],
          ...(retryable && !finishedWrite
            ? {
              suggestedActions: [
                {
                  id: "retry-agent",
                  label: "重试这一步",
                  description: "重新让写作助手处理这条消息",
                  permission: "safe_read" as const,
                  requiresConfirmation: false,
                  endpoint: text,
                },
              ],
            }
            : {}),
        });
      };
      // 本轮是否出现过章节写类工具调用（generate_draft/revise_draft/commit_apply）——出错 / 停止收尾时
      // 据此重读一次盘上的稿纸和状态（回执可能丢了，盘上其实已写）。纯读 / 问答回合不浪费这次 IO。
      let sawChapterWriteToolCall = false;
      // 定稿在飞：记下发起时盘上那份定稿，收尾时据它判断「其实已经定稿、只是回执丢了」。
      let commitAttempt: { readonly committedBefore: string | null } | null = null;
      // 出稿在飞：记下发起时稿纸上的字，停止收尾时据它判断「盘上其实已经写完了」。
      let generateAttempt: { readonly bodyBefore: string } | null = null;
      // AI 真撤销了（undo / manage_snapshots op=undo）：回合收尾时剥掉旧回合挂着的过时建议条。
      let agentUndone = false;

      const showStreaming = (): void => {
        const paper = useDraftStore.getState();
        if (draftStreamChapter === null || paper.chapter !== draftStreamChapter) return;
        paper.setStreaming(streamBase + streamingDraftDisplay(streamedDraft, streamBase));
      };
      const endStreaming = (): void => {
        if (useDraftStore.getState().streaming !== null) useDraftStore.getState().setStreaming(null);
      };
      // 出稿失败收尾：onToolCall(generate_draft) 把 flowStatus 置「正在生成草稿」，失败路径若不复位，标题区
      // 会卡在「正在生成草稿」=明明失败却谎称在生成（诚实铁律）。据稿纸上有没有字复位成 draft_ready/idle。
      const unstickGeneratingFlow = (): void => {
        if (!ownsCurrentWorkspace()) return;
        const wsBook = useBookStore.getState();
        const next = flowStatusAfterGenerateFailure(wsBook.workspace.flowStatus, useDraftStore.getState().body.trim().length > 0);
        if (next) wsBook.updateWorkspace({ flowStatus: next });
      };
      // 写类工具在飞时出错 / 被停止：SSE 回执丢了，但服务端可能已经写完（出稿落了 drafts/fast、定稿已入库）。
      // 重读盘上这一章的稿纸和书的状态：
      //   ① 定稿在飞、盘上的定稿变了 → 其实已经定稿，更正状态并说一声；
      //   ② 停止时流出了半章、盘上没有更全的一版 → 把流出来的字留给作者（照常存盘）。
      let resyncPromise: Promise<void> | null = null;
      const resyncAfterInterruptedWrite = async (partial: string | null): Promise<void> => {
        try {
          if (!projectPath) return;
          await Promise.allSettled(pendingPaperSyncs);
          await refreshPaper();
          if (!ownsCurrentWorkspace()) return;
          const overview = await fetchStateOverview({ projectPath, maxTimelineEvents: 8 });
          if (!ownsCurrentWorkspace()) return;
          applyOverviewToWorkspace(overview);
          const paper = useDraftStore.getState();
          if (commitAttempt && paper.committed && paper.committed.body !== commitAttempt.committedBefore) {
            const current = useBookStore.getState().workspace;
            useBookStore.getState().updateWorkspace({
              flowStatus: "committed",
              currentChapter: { ...current.currentChapter, hasCommittedChapter: true, hasDraftFile: true },
            });
            appendMessage({
              id: `assistant-reconcile-${Date.now()}`,
              role: "assistant",
              content: `（核对盘上：第 ${paper.chapter} 章其实已经定稿——上一步可能因为连接中断没收到结果、看起来像失败，但确实已写入。状态已更正为「已定稿」。）`,
            });
            return;
          }
          // 盘上已经是这一轮写的新稿（停晚了一步、服务端已写进去）：用盘上那版，如实说——不管流出来的字还在不在、长短。
          if (generateAttempt && !paper.incoming && paper.body !== generateAttempt.bodyBefore) {
            appendMessage({
              id: `assistant-reconcile-${Date.now()}`,
              role: "assistant",
              content: `（核对盘上：停止前第 ${paper.chapter} 章其实已经写完了，稿纸上是盘上那一整版，要退回就撤销上一步。）`,
            });
            return;
          }
          if (!partial?.trim()) return;
          if (!paper.incoming && partial.trim().length > paper.body.trim().length) editDraft(partial);
        } catch {
          // 尽力而为，绝不让它破坏收尾路径。
        }
      };
      const requestResync = (partial: string | null = null): void => {
        if (!sawChapterWriteToolCall) return;
        resyncPromise ??= resyncAfterInterruptedWrite(partial);
      };
      // M3：本轮的中止器——「停止」按钮 abort 它即可干净停掉这条流（streamAgentChat 据此不报错收尾）。
      const abortController = new AbortController();
      agentAbortRef.current = abortController;
      let releaseDraftSaves: (() => void) | null = null;
      try {
        // AI 读的是盘上的稿子：先把作者没存的字存掉。存不上也照常发（AI 写的稿回来时稿纸会提示作者选）。
        const flushed = await flushDraftSave();
        if (!flushed.ok) showToast(`稿子还没存上（${flushed.error}），AI 看到的是上一次存下的那版。`, 5200);
        // 回合里作者接着打的字先不存：AI 改了稿，回来时稿纸出提示让作者选，不会把作者的字静默换掉。
        releaseDraftSaves = holdDraftSaves();
        // H3：把用户当前所在章一并发给后端，让 agent 默认作用于该章、各工具缺省回退该值（回看旧章不写错章）。
        const currentChapterNumber = useBookStore.getState().workspace.currentChapter?.chapterNumber;
        // R7.2：带上「上一个有写盘回合的首个快照」——后端 undo 工具优先整回合回退（一回合改两处也全撤），
        // 与块级「撤销到此」同一锚点；作者说「撤销上一步」指的是上一回合的全部改动。
        const lastTurnUndoHint = lastTurnUndoHintFromMessages(useChatStore.getState().messages);
        await streamAgentChat(
          {
            projectPath,
            messages: [...conversation, { role: "user", content: text }],
            ...(typeof currentChapterNumber === "number" ? { currentChapter: currentChapterNumber } : {}),
            ...(lastTurnUndoHint ? { lastTurnUndoHint } : {}),
            ...(action ? { action } : {}),
          },
          {
            onTextDelta: (delta) => project({ type: "text-delta", text: delta }),
            // R4：服务端裁了历史窗口/其它状态说明，照实投影成助手消息前的一条系统提示，不静默吞掉。
            onStatus: (message) => project({ type: "status", text: message }),
            onUsage: (usage) => project({ type: "usage", usage }),
            onReasoningDelta: (delta) => project({ type: "reasoning-delta", text: delta }),
            onToolCall: ({ toolName, toolCallId }) => {
              if (!ownsCurrentWorkspace()) return;
              project({ type: "tool-call", toolCallId: stepIdFor(toolName, toolCallId), toolName, startedAt: Date.now() });
              if (toolName === "generate_draft" || toolName === "revise_draft" || toolName === "commit_apply") {
                sawChapterWriteToolCall = true;
              }
              // 出稿/续写一开始就把中间区切到写作台，让用户看着正文出现（而不是默默落进数据层、还停在资料中心）。
              if (toolName === "generate_draft") {
                useNavigationStore.getState().requestCenterView("desk");
                streamedDraft = ""; // 新一次出稿：清空流式缓冲，逐字从头累加。
                streamBase = "";
                draftStreamChapter = null;
                reportedDraftChapterMismatch = false;
                generateAttempt = { bodyBefore: useDraftStore.getState().body };
                // 出稿一开始就把流程态置「正在生成草稿」，否则续写时标题区会残留上一章的「已入库」误导用户。
                useBookStore.getState().updateWorkspace({ flowStatus: "draft_generating" });
              } else if (toolName === "revise_draft") {
                // 用户让 AI 改稿：也把中间区切到写作台，改完的正文就在眼前。revise 不流式。
                useNavigationStore.getState().requestCenterView("desk");
              } else if (toolName === "commit_apply") {
                commitAttempt = { committedBefore: useDraftStore.getState().committed?.body ?? null };
              }
            },
            onDraftPhase: ({ phase }) => {
              if (!ownsCurrentWorkspace()) return;
              useUiStore.getState().setDraftPhase(phase);
            },
            onDraftDelta: ({ chapter, text, replace, base }) => {
              if (!ownsCurrentWorkspace()) return;
              if (draftStreamChapter === null) {
                const previousChapter = operation.chapter;
                const adopted = retargetWorkspaceOperation(operation, { chapter });
                if (!adopted) return;
                operation = adopted;
                draftStreamChapter = chapter;
                if (chapter !== previousChapter) {
                  // 这一轮写的是另一章：这轮对话归那一章（稿纸跳过去后，下一句话说完它不收进「别的章的对话」）。
                  const turnMessages = useChatStore.getState().messages;
                  const assistantIndex = turnMessages.findIndex((message) => message.id === assistantMsgId);
                  const opener = turnMessages.slice(0, Math.max(assistantIndex, 0)).reverse().find((message) => message.role === "user");
                  if (opener && opener.chapter !== chapter) updateMessage(opener.id, (current) => ({ ...current, chapter }));
                  const storeBook = useBookStore.getState();
                  const cur = storeBook.workspace.currentChapter;
                  storeBook.updateWorkspace({
                    currentChapter: {
                      ...cur,
                      chapterNumber: chapter,
                      status: "current",
                      title: `第${chapter}章`,
                      hasCommittedChapter: false,
                      hasDraftFile: false,
                    },
                  });
                }
                if (useDraftStore.getState().chapter !== chapter && projectPath) {
                  // AI 写的是另一章：稿纸换到那一章（先存掉手上那章）。
                  const switchProject = projectPath;
                  paperSwitch = openPaper(switchProject, chapter)
                    .catch(() => {
                      useDraftStore.getState().loadPaper(switchProject, { chapter, draft: null, committed: null, editedSinceCommit: null });
                    })
                    .then(() => { if (ownsCurrentWorkspace()) showStreaming(); });
                  track(paperSwitch);
                }
              } else if (chapter !== draftStreamChapter) {
                if (!reportedDraftChapterMismatch) {
                  reportedDraftChapterMismatch = true;
                  useNavigationStore.getState().showToast("收到不同章节的迟到正文片段，已拒绝混入当前工作稿。", 5000);
                }
                return;
              }
              if (base) streamBase = text;
              else streamedDraft = replace ? text : streamedDraft + text;
              showStreaming();
            },
            onToolResult: (info) => {
              if (!ownsCurrentWorkspace()) return;
              // 跨章工具结果（用户在第 1 章、agent 核实第 99 章的 commit_preview 等）也必须把对应步骤
              // 落定——否则该步永远 running。章号不匹配只跳过「工作区应用」，不跳过步骤收尾。
              const chapterMismatch = typeof info.chapter === "number" && info.chapter !== operation.chapter;
              project({
                type: "tool-result",
                toolCallId: stepIdFor(info.toolName, info.toolCallId),
                toolName: info.toolName,
                endedAt: Date.now(),
                output: info,
              });
              if (info.toolName === "generate_draft") {
                endStreaming();
                // 结果收到了：之后出错不用再「核对盘上」说它其实写完了。
                generateAttempt = null;
              }
              if ((info.toolName === "generate_draft" || info.toolName === "revise_draft") && info.ok !== false && !info.toolValidationFailure) {
                finishedWrite = info.toolName === "generate_draft" ? "draft" : "revise";
              }
              // 核账结果记下核的是哪一版：服务端报了就用它（它读的那份文件）；没报（老服务端）才用这时稿纸上的版本。
              // 之后稿子变了就显示「核过后改过稿」。AI 出完稿紧接着核账时稿纸可能还没换上新稿，不能拿稿纸的版本。
              if (info.toolName === "check_continuity" && !chapterMismatch) {
                useChatStore.getState().stampCardVersion(assistantMsgId, "continuity", info.checkedVersion ?? useDraftStore.getState().baseVersion);
              }
              // 定稿预览一到就弹出定稿清单（重构 P6）；记下预览的是哪一版，稿子没再变时再点「定稿」直接打开这份。
              if (info.toolName === "commit_preview" && !chapterMismatch) {
                useChatStore.getState().stampCardVersion(assistantMsgId, "commit-preview", useDraftStore.getState().baseVersion);
                openCommitSheet(assistantMsgId);
              }
              if (chapterMismatch) {
                // 跨章工具结果只跳过「当前章稿纸 / 流程态应用」，携带最新章列表 / 入库状态的 overview 照刷资料面板。
                if (info.overview) refreshWorkspaceFromOverview?.(info.overview);
                // 那一章的稿子可能变了（AI 改了已定稿章的工作稿）：按盘上重读它的标记，底栏「N 章还没定稿」不用切过去才对（P11）。
                const otherChapter = info.chapter as number;
                if (projectPath) {
                  track(fetchChapterPaper(projectPath, otherChapter).then((paper) => {
                    if (!ownsCurrentWorkspace()) return;
                    const { workspace, updateWorkspace } = useBookStore.getState();
                    updateWorkspace({ chapters: patchChapterFlagsFromPaper(workspace.chapters, otherChapter, paper) });
                  }).catch(() => undefined));
                }
                showToast(
                  `这次操作写的是第 ${info.chapter} 章，不在当前章（第 ${operation.chapter} 章）；当前章的稿子没有变动，章节列表已按最新状态刷新。`,
                  4200,
                );
                unstickGeneratingFlow();
                return;
              }
              if (info.toolName === "commit_apply") commitAttempt = null;
              // 定论改齐了（P12）：那张定论卡（可能在前面的消息上）标成改齐了，按钮收起。
              if (info.toolName === "settle_apply" && info.settleToken) useChatStore.getState().markSettleApplied(info.settleToken, info.summary ?? "");
              // 定稿成了：顶栏「设定本」亮个小点，点进去先看这章改了什么（重构 P6 第 6 步）。
              if (info.toolName === "commit_apply" && info.committed === true) useNavigationStore.getState().setUnseenChangesChapter(operation.chapter);
              const undone = info.undone === true && (info.toolName === "undo_last_change" || info.toolName === "manage_snapshots");
              if (undone) {
                agentUndone = true;
                // AI 撤销了：顶栏「设定本」上「刚定稿」的小点跟着消。
                useNavigationStore.getState().setUnseenChangesChapter(null);
              }
              const flowBefore = useBookStore.getState().workspace.flowStatus;
              const hasDraftContent = useDraftStore.getState().body.trim().length > 0;
              const nextFlow = nextFlowAfterToolResult(info.toolName, info, flowBefore, hasDraftContent);
              if (!info.overview) {
                const changedBible = info.refreshScope === "foundation"
                  || ((info.toolName === "manage_ledger" || info.toolName === "settle_apply") && info.refreshScope === "full");
                if (changedBible && projectPath) {
                  // 改设定、确认改账的结果不带概况（重构 P9）：重读一份，设定本、主角、待处理跟着变。
                  track(fetchStateOverview({ projectPath, maxTimelineEvents: 8 })
                    .then((overview) => { if (ownsCurrentWorkspace()) refreshWorkspaceFromOverview?.(overview); })
                    .catch(() => undefined));
                }
                if (info.toolName === "commit_apply" && info.committed === true) {
                  const storeBook = useBookStore.getState();
                  const current = storeBook.workspace;
                  storeBook.updateWorkspace({
                    flowStatus: "committed",
                    currentChapter: { ...current.currentChapter, hasCommittedChapter: true, hasDraftFile: true },
                    chapters: current.chapters.map((item) => item.chapterNumber === operation.chapter
                      ? { ...item, hasCommittedChapter: true, hasDraftFile: true }
                      : item),
                  });
                } else if (nextFlow !== flowBefore) {
                  // 没带 overview 的工具（如质检 / 预览只读）也要推进流程状态，否则地图卡在写稿不动。
                  useBookStore.getState().updateWorkspace({ flowStatus: nextFlow });
                }
              } else if (info.refreshScope === "full") {
                // 传 info.chapter（工具实际操作的章号）让前端认领权威章。
                applyOverviewToWorkspace(info.overview, {
                  flowStatus: nextFlow,
                  ...(typeof info.chapter === "number" ? { chapter: info.chapter } : {}),
                  ...(info.draftTitle ? { title: info.draftTitle } : {}),
                });
              } else if (info.refreshScope === "foundation") {
                refreshWorkspaceFromOverview?.(info.overview);
              }
              // 工具可能改了这一章的稿子（出稿、改稿、定稿、改名、撤销……）：按盘上重读稿纸。
              // 盘上没变什么都不发生；变了而作者手上没有没存的字就换上，有就出提示让作者选。
              // AI 撤销是作者自己要的：直接换上。
              track((paperSwitch ?? Promise.resolve())
                .then(() => refreshPaper(undone ? { force: true } : {}))
                .then(() => {
                  // 撤销后这一章回到哪一步，按盘上那版算（可能退回到「还没写过」）。
                  if (undone && ownsCurrentWorkspace()) {
                    useBookStore.getState().updateWorkspace({ flowStatus: flowStatusForPaper(useDraftStore.getState()) });
                  }
                }));
            },
            onToolError: (info) => {
              if (!ownsCurrentWorkspace()) return;
              sawError = true;
              // 先收尾：把对应 running 的步骤/卡片置 failed（复用已测投影逻辑），时间线不再卡转圈。
              project({
                type: "tool-error",
                toolCallId: stepIdFor(info.toolName, info.toolCallId),
                toolName: info.toolName,
                endedAt: Date.now(),
                error: info.message,
              });
              // 再如实回报：追加一条可重试的错误气泡。
              appendErrorMessage(info.message, info.retryable);
              if (info.toolName === "generate_draft") endStreaming(); // 半截流式稿只是显示，丢掉即可，盘上旧稿没动
              unstickGeneratingFlow();
              requestResync(); // 断流可能其实已写盘，重读盘上真值更正
            },
            onError: (message, retryable, reason) => {
              if (!ownsCurrentWorkspace()) return;
              sawError = true;
              appendErrorMessage(message, retryable, reason);
              endStreaming();
              unstickGeneratingFlow();
              requestResync();
            },
            onDone: () => undefined,
          },
          abortController.signal,
        );
      } catch (error) {
        if (!ownsCurrentWorkspace()) {
          notifyStaleOperation();
          return;
        }
        // streamAgentChat 内部已把异常转成 onError；这里兜底防御未捕获路径。
        if (!sawError) {
          const message = error instanceof Error ? error.message : String(error);
          appendErrorMessage(message, true);
        }
        endStreaming();
        unstickGeneratingFlow();
        requestResync();
      } finally {
        // 停止收尾：用户点「■」abort 只是断了流（streamAgentChat 对主动 abort 不报错、不收尾），回合收尾在这里补齐——
        //   ① 残留 running 的步骤/卡片结算成「已停止」，金光/字幕随之静止；
        //   ② 流出来的半章：盘上没有更全的一版就留给作者（「已停止 · 已写出的内容保留」）；
        //   ③ 写类工具在飞 → 重读一次盘上真值（回执丢了但盘上可能已写完整稿/已入库）。
        const wasAborted = abortController.signal.aborted;
        if (wasAborted && ownsCurrentWorkspace()) {
          updateMessage(assistantMsgId, (current) => settleStoppedAgentTurn(current, Date.now()));
          const partial = useDraftStore.getState().streaming;
          endStreaming();
          unstickGeneratingFlow();
          requestResync(partial);
        }
        // 回合收尾兜底：SSE 回合走到 finally 时 generate_draft 必然已结束，残留的流式显示 / draft_generating
        // 只能是某条中途分支没复位，按稿纸现状复位（unstickGeneratingFlow 只在确实卡住时才动）。
        if (!wasAborted) {
          endStreaming();
          unstickGeneratingFlow();
        }
        useUiStore.getState().setDraftPhase(null);
        // 保持 operation 所有权直到盘上真值读完；否则异步读刚返回，finally 已释放 token，结果会被当成迟到数据丢掉。
        // 但最多等 RESYNC_WAIT_MS：读盘卡住不能把整个工作区一直占着（迟到的结果按所有权丢掉，稿纸下次读盘自会对上）。
        await settleWithin([...(resyncPromise ? [resyncPromise] : []), ...pendingPaperSyncs], RESYNC_WAIT_MS);
        releaseDraftSaves?.();
        if (!ownsCurrentWorkspace() && isWorkspaceOperationCurrent(operation)) {
          notifyStaleOperation();
        }
        if (ownsCurrentWorkspace()) {
          // 回合终点打点：正常完成 / 失败 / 停止都走到这里，保证块头耗时落地。
          updateMessage(assistantMsgId, (current) => ({
            ...current,
            turnEndedAt: Date.now(),
          }));
          // AI 撤销后，旧回合挂着的建议条（确认定稿 / 确认写入资料…）已过时，剥掉。
          if (agentUndone) {
            const liveMessages = useChatStore.getState().messages;
            const withoutStaleSuggestions = stripStaleTurnSuggestions(liveMessages);
            if (withoutStaleSuggestions !== liveMessages) {
              useChatStore.getState().setMessages(withoutStaleSuggestions);
            }
          }
        }
        if (isWorkspaceOperationCurrent(operation)) {
          if (ownsCurrentWorkspace()) setChatLoading(false);
          finishWorkspaceOperation(operation);
        }
        agentAbortRef.current = null; // 本轮收尾，清掉中止器（避免「停止」误伤下一轮）。
      }
    },
    [
      appendMessage,
      projectPath,
      refreshWorkspaceFromOverview,
      setChatError,
      setChatLoading,
      updateMessage,
      showToast,
    ],
  );

  /* ---- undoToTurn：块级「撤销到此」 ---- */

  /**
   * 块级精确撤销：把某个 AI 回合的 git 改动整块回退，并让对话历史与工作台同步回退，不整页刷新（重构 P5）。
   *
   * 步骤：
   *  1. 防御：回合还在跑（chatLoading）或该回合没有写盘快照（turnSnapshots 空）→ 不动。
   *  2. 先把稿子和对话存掉（存不上就不撤，免得作者手上的字没进存档就被盖掉）。
   *  3. restore 该回合的「首次写入前快照」turnSnapshots[0] —— 盘上整块回到回合开始前。
   *  4. 截断对话：连同触发该回合的用户提问一起去掉该回合及其后，写回会话文件（对话只有这一份）。
   *  5. 原地重读稿纸和书的状态（syncWorkspaceAfterRestore）。滚动位置、输入框里没发的字都还在。
   *  失败不静默：restore 失败如实回报「没动盘」、不截断对话。
   */
  const undoToTurn = useCallback(
    async (message: ChapterMessage): Promise<void> => {
      const storeChat = useChatStore.getState();
      if (storeChat.chatLoading) return;
      const undoSnapshotId = message.turnSnapshots?.[0]?.snapshotId;
      if (!undoSnapshotId) return;
      if (!projectPath) {
        setChatError("请先打开真实本地项目。");
        return;
      }
      if (useNavigationStore.getState().projectPath !== projectPath) {
        showToast("当前项目已经变化，不能发送旧工作区请求。", 4200);
        return;
      }
      const liveChat = useChatStore.getState();
      const liveUi = useUiStore.getState();
      if (isWorkspaceBusy() || liveChat.chatLoading || Boolean(liveUi.draftActionLoading)) {
        showToast("已有写作操作正在进行，请等它结束后再发送新请求。", 4200);
        return;
      }

      const flushed = await flushAllSaves();
      if (!flushed.ok) {
        showToast(`${flushed.error}。先别撤销，等它存上再试。`, 5200);
        return;
      }

      // restore 是唯一动盘的步骤；先单独 try，失败时如实回报「没动盘」、不截断对话。
      try {
        await restoreSnapshotApi(projectPath, undoSnapshotId);
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        appendMessage({
          id: `assistant-undo-error-${Date.now()}`,
          role: "assistant",
          content: `撤销失败：${messageText}。没有改动磁盘或对话历史。`,
        });
        setChatError(messageText);
        return;
      }

      // 截断对话：连同触发该回合的用户提问一起去掉该回合及其后（回到「没问过」的干净态）。
      // git restore 刻意不回退会话文件——必须显式写回，否则下次开书被撤销的回合又整段回来。
      const liveMessages = useChatStore.getState().messages;
      const truncated = truncateMessagesFrom(liveMessages, undoCutId(liveMessages, message.id));
      useChatStore.getState().setMessages(truncated);
      const saved = await saveChatNow(truncated.length === 0 ? { allowEmpty: true } : {});
      if (!saved.ok) {
        showToast(
          `对话历史的撤销没写进会话文件（${saved.error}）。稿子和资料已经撤回去了，但重新打开本书后对话可能还是撤销前的样子。`,
          5200,
        );
      }

      try {
        await syncWorkspaceAfterRestore(projectPath);
      } catch (error) {
        showToast(`撤销已完成，但重读盘上状态没成功（${error instanceof Error ? error.message : String(error)}）；换一章再回来即可看到撤销后的稿子。`, 5200);
      }
    },
    [appendMessage, projectPath, setChatError, showToast],
  );

  /* ---- handleSendMessage ---- */

  const handleSendMessage = useCallback(
    async (message: string) => {
      const text = message.trim();
      if (!text) return;
      if (!projectPath) {
        setChatError("请先打开真实本地项目。");
        return;
      }
      const liveChat = useChatStore.getState();
      const liveUi = useUiStore.getState();
      if (isWorkspaceBusy() || liveChat.chatLoading || Boolean(liveUi.draftActionLoading)) {
        showToast("已有操作正在进行，请等它结束后再发送新请求。", 4200);
        return;
      }

      const userMessage: ChapterMessage = {
        id: `user-${Date.now()}`,
        role: "user",
        content: text,
        ...chapterStamp(),
      };

      const conversation = buildOutboundConversation(
        liveChat.messages,
        liveChat.activeArchivedCount,
        liveChat.chatHistoryBudget,
      );

      appendMessage(userMessage);

      // 自动起名：还叫默认「新会话」的会话，首条用户消息一发就用原话压成标题命名。
      // 手动/已自动命名过的会话名不是默认值，不会被覆盖；fire-and-forget，不阻塞发送。
      {
        const stChat = useChatStore.getState();
        const active = stChat.sessions.find((s) => s.id === stChat.activeSessionId);
        if (active && (active.name === "新会话" || active.name === "会话")) {
          const requestSeq = ++autoRenameRequestSeqRef.current;
          const originProjectPath = projectPath;
          const originSessionId = active.id;
          void renameChatSession(projectPath, active.id, deriveIntentTitle(text))
            // 只更新 sessions 列表（拿到新名），不传 activeSessionId：异步起名期间用户
            // 若已切到别的会话，传回旧的 activeSessionId 会把当前选择回拉，造成名/内容错乱。
            .then((r) => {
              const liveChatNow = useChatStore.getState();
              if (requestSeq !== autoRenameRequestSeqRef.current
                || useNavigationStore.getState().projectPath !== originProjectPath
                || liveChatNow.activeSessionId !== originSessionId) return;
              liveChatNow.setSessions(r.index.sessions);
            })
            .catch((err) => console.error("[useChat] 会话自动起名失败", err));
        }
      }

      // 输入框的字一律交给 AI（重构 P4）：不再拿「原话等于按钮文案」认回按钮动作；按钮自己发结构化动作（handleChapterButton）。
      await runAgentDispatch(text, conversation);
    },
    [
      projectPath,
      appendMessage,
      setChatError,
      runAgentDispatch,
      showToast,
    ],
  );


  /* ---- handleConfirmCommit：「确认定稿」按钮 ---- */

  // 结构化动作（2026-10-07 拆补丁塔）：按钮点击即授权，服务端直接执行 commit_apply——不经模型、
  // 不靠文本意图词表。对话里留一条「确认定稿第 N 章」作记录，后续回合模型能看到发生过什么。
  const handleConfirmCommit = useCallback(
    async (target?: CommitConfirmTarget): Promise<void> => {
      if (!projectPath) {
        setChatError("请先打开真实本地项目。");
        return;
      }
      const liveBook = useBookStore.getState();
      const liveChat = useChatStore.getState();
      const liveUi = useUiStore.getState();
      if (isWorkspaceBusy() || liveChat.chatLoading || Boolean(liveUi.draftActionLoading)) {
        showToast("已有操作正在进行，请等它结束后再定稿。", 4200);
        return;
      }
      const chapter = target?.chapter ?? liveBook.workspace.currentChapter?.chapterNumber;
      if (typeof chapter !== "number" || !Number.isInteger(chapter) || chapter <= 0) {
        showToast("没找到要定稿的章节，请先打开那一章。", 4200);
        return;
      }
      // 作者在预览卡上动过的账本条目：从卡上点带着；从建议条点的没带，按章取回（否则会把勾掉的照写）。
      // 两类混在一个数组里、按前缀分流：勾掉的（fact:/change:…）＝去掉不写；勾上的要确认改记（change_confirm:）＝确认作废旧条。
      const excluded = target?.excluded ?? ledgerExclusionsForConfirm(chapter, target?.previewToken);
      const confirmedChanges = excluded.filter((id) => id.startsWith("change_confirm:")).length;
      const removedCount = excluded.length - confirmedChanges;
      const dayOverride = target?.dayOverride !== undefined
        ? { day: target.dayOverride, ...(target.dayEndOverride !== undefined ? { dayEnd: target.dayEndOverride } : {}) }
        : ledgerDayOverrideForConfirm(chapter, target?.previewToken);
      const dayEnd = dayOverride?.dayEnd !== undefined && dayOverride.dayEnd > dayOverride.day ? dayOverride.dayEnd : undefined;
      clearLedgerExclusions(chapter);
      const notes = [
        ...(removedCount > 0 ? [`账本清单去掉了 ${removedCount} 条`] : []),
        ...(confirmedChanges > 0 ? [`确认改记 ${confirmedChanges} 条`] : []),
        ...(dayOverride !== undefined ? [`这一章改记为故事第 ${dayOverride.day} 天${dayEnd !== undefined ? `到第 ${dayEnd} 天` : ""}`] : []),
      ];
      const text = notes.length > 0 ? `确认定稿第 ${chapter} 章（${notes.join("，")}）` : `确认定稿第 ${chapter} 章`;
      const conversation = buildOutboundConversation(liveChat.messages, liveChat.activeArchivedCount, liveChat.chatHistoryBudget);
      appendMessage({ id: `user-${Date.now()}`, role: "user", content: text, ...chapterStamp() });
      await runAgentDispatch(text, conversation, {
        toolName: "commit_apply",
        chapter,
        ...(target?.previewToken ? { previewToken: target.previewToken } : {}),
        ...(excluded.length > 0 ? { excluded } : {}),
        ...(dayOverride !== undefined ? { dayOverride: dayOverride.day } : {}),
        ...(dayEnd !== undefined ? { dayEndOverride: dayEnd } : {}),
      });
    },
    [projectPath, appendMessage, setChatError, runAgentDispatch, showToast],
  );

  /* ---- handleConfirmPrune：「确认裁剪」按钮 ---- */

  // 与「确认定稿」同一套结构化动作：按钮点击即授权，服务端直接真裁操作历史（裁前自动备份），不经模型。
  const handleConfirmPrune = useCallback(
    async (target?: { readonly keep?: number }): Promise<void> => {
      if (!projectPath) {
        setChatError("请先打开真实本地项目。");
        return;
      }
      const liveChat = useChatStore.getState();
      const liveUi = useUiStore.getState();
      if (isWorkspaceBusy() || liveChat.chatLoading || Boolean(liveUi.draftActionLoading)) {
        showToast("已有操作正在进行，请等它结束后再裁剪。", 4200);
        return;
      }
      const text = target?.keep ? `确认裁剪操作历史（保留最近 ${target.keep} 条）` : "确认裁剪操作历史";
      const conversation = buildOutboundConversation(liveChat.messages, liveChat.activeArchivedCount, liveChat.chatHistoryBudget);
      appendMessage({ id: `user-${Date.now()}`, role: "user", content: text, ...chapterStamp() });
      await runAgentDispatch(text, conversation, { toolName: "prune_snapshots", ...(target?.keep ? { keep: target.keep } : {}) });
    },
    [projectPath, appendMessage, setChatError, runAgentDispatch, showToast],
  );

  /* ---- handleSendUserAction：「下一步」选项的结构化动作直达（R4.7） ---- */

  // 服务端自己生成的确定性选项（预览定稿/再核一次/写下一章…）带 action：点击直接发 body.action，
  // 服务端执行对应工具、结果照常进对话——不再发一句意图给模型白跑一轮（一次 3～5 万输入）。
  // 与「确认定稿」「确认裁剪」同一通道；对话里照留一句「你：…」回显（userActionChoiceText）。
  const handleSendUserAction = useCallback(
    async (action: AgentUserAction): Promise<void> => {
      if (!projectPath) {
        setChatError("请先打开真实本地项目。");
        return;
      }
      const liveChat = useChatStore.getState();
      const liveUi = useUiStore.getState();
      if (isWorkspaceBusy() || liveChat.chatLoading || Boolean(liveUi.draftActionLoading)) {
        showToast("已有操作正在进行，请等它结束再点。", 4200);
        return;
      }
      // 「写这一章」带的方向就是作者挑中的那种走法：回显里写明照哪种写。
      const picked = action.toolName === "generate_draft" ? pickedDirection(liveChat.messages, action.chapter) : undefined;
      const goal = action.toolName === "generate_draft" ? action.chapterGoal : undefined;
      const text = userActionChoiceText(action, picked && goal?.startsWith(directionGoal(picked)) ? picked.title : undefined);
      const conversation = buildOutboundConversation(liveChat.messages, liveChat.activeArchivedCount, liveChat.chatHistoryBudget);
      appendMessage({ id: `user-${Date.now()}`, role: "user", content: text, ...chapterStamp() });
      // 出稿类动作把作者带回写作台（正文流式进稿纸；按章自动切换当前章，见 runAgentDispatch 的 onDraftDelta）。
      if (action.toolName === "generate_draft") useNavigationStore.getState().requestCenterView("desk");
      await runAgentDispatch(text, conversation, action);
    },
    [projectPath, appendMessage, setChatError, runAgentDispatch, showToast],
  );

  /* ---- handleChapterButton：写作区固定按钮（重构 P4） ---- */

  // 按钮直接发对应的结构化动作（写这一章 / 写下一章 / 核账 / 审阅 / 硬伤检查 / 定稿 / 撤销），
  // 不经模型判断、也不靠「文字等于按钮文案」认回。章号取当前章；没选章就如实提示。
  const handleChapterButton = useCallback(
    (button: ChapterButton): void => {
      // 「定稿」：上次预览后稿子没变，直接打开那份定稿清单，不再重跑记账员。
      if (button === "commit_preview") {
        const reusable = reusableCommitPreviewId(useChatStore.getState().messages, useDraftStore.getState());
        if (reusable) {
          openCommitSheet(reusable);
          return;
        }
      }
      const liveBook = useBookStore.getState();
      const liveUi = useUiStore.getState();
      const chapter = liveBook.workspace.currentChapter?.chapterNumber;
      // 「写这一章」：作者在稿纸上方挑中过走法，就照它写（输入框里另写了话一并带上）。
      const pickedGoal = typeof chapter === "number" ? pickedDirectionGoal(useChatStore.getState().messages, chapter) : undefined;
      const direction = [pickedGoal ?? "", liveUi.steeringDirection.trim()].filter(Boolean).join("\n");
      const action = chapterButtonAction(button, {
        chapter,
        chapters: liveBook.workspace.chapters,
        direction,
      });
      if (!action) {
        appendMessage({ id: `assistant-button-nochapter-${Date.now()}`, role: "assistant", content: NO_CHAPTER_HINT });
        return;
      }
      void handleSendUserAction(action);
    },
    [appendMessage, handleSendUserAction],
  );

  /* ---- handleSuggestedAction ---- */

  // 动作消费（A-6 建议条配套）：动作成功执行后把它从携带它的消息上摘掉——否则建议条继续显示
  // 已完成的动作（如「撤销本次修改」撤销成功后还能再点），成假入口。失败/未执行不摘，留着重试。
  const consumeSuggestedAction = useCallback(
    (consumed: SuggestedAction): void => {
      const storeChat = useChatStore.getState();
      const carrier = [...storeChat.messages].reverse().find((m) =>
        m.role === "assistant"
        && (m.suggestedActions ?? []).some((a) => a.id === consumed.id && a.endpoint === consumed.endpoint));
      if (!carrier) return;
      updateMessage(carrier.id, (current) => ({
        ...current,
        suggestedActions: (current.suggestedActions ?? []).filter(
          (a) => !(a.id === consumed.id && a.endpoint === consumed.endpoint),
        ),
      }));
    },
    [updateMessage],
  );

  const handleSuggestedAction = useCallback(
    (action: SuggestedAction) => {
      if (action.disabledReason) {
        showToast(action.disabledReason);
        return;
      }
      // workflow 类动作：不再直接调老工作流函数（那会绕过 Mastra agent、没有思考/工具反馈），
      // 改成用 handleSendMessage 发一条中文请求给 agent，走正常对话链路（出 SSE 思考/调用工具）。
      switch (action.id) {
        case "generate-steering":
          void handleSendMessage("帮我读一下当前状态，整理这一章的承接建议。");
          return;
        case "generate-draft":
        case "generate-draft-direct":
          handleChapterButton("write");
          return;
        case "quality-check":
          handleChapterButton("quality_check");
          return;
        case "ai-review":
          handleChapterButton("ai_review");
          return;
        case "revision-preview":
          void handleSendMessage("按我的方向给这一章改一版，先出预览。");
          return;
        case "revision-apply":
          void handleApplyRevisionPreview();
          return;
        case "commit-preview":
          handleChapterButton("commit_preview");
          return;
        case "commit-apply":
          void handleConfirmCommit(action.commitTarget);
          return;
        case "commit-short":
          if (action.commitTarget?.chapter) void handleSendUserAction({ toolName: "commit_preview", chapter: action.commitTarget.chapter, allowShort: true });
          return;
        case "prune-confirm":
          consumeSuggestedAction(action);
          void handleConfirmPrune(action.pruneTarget);
          return;
        case "ledger-confirm":
          if (!action.ledgerTarget) {
            showToast("这个改账按钮已经失效了，请让 AI 重新提一次。", 4200);
            return;
          }
          consumeSuggestedAction(action);
          void handleSendUserAction({ toolName: "ledger_decision", ...action.ledgerTarget });
          return;
        case "rewrite-confirm":
        case "continue-confirm":
          if (!action.rewriteTarget) {
            showToast("这个按钮已经失效了，请让 AI 重新提一次。", 4200);
            return;
          }
          consumeSuggestedAction(action);
          void handleSendUserAction({ toolName: "generate_draft", ...action.rewriteTarget });
          return;
        case "foundation-confirm":
          if (!action.foundationTarget) {
            showToast("这个改设定按钮已经失效了，请让 AI 重新提一次。", 4200);
            return;
          }
          consumeSuggestedAction(action);
          void handleSendUserAction({ toolName: "foundation_decision", ...action.foundationTarget });
          return;
        case "foundation-accept":
          if (!action.foundationTarget) {
            showToast("这个按钮已经失效了，请让 AI 重新提一次。", 4200);
            return;
          }
          consumeSuggestedAction(action);
          void handleSendUserAction({ toolName: "foundation_decision", ...action.foundationTarget, accept: true });
          return;
        case "continue-next":
          handleChapterButton("write_next");
          return;
        case "retry-agent": {
          // agent 大脑失败后重试：用按钮 endpoint 携带的原始消息重跑 agent 派发，不重复 append 用户消息。
          const original = action.endpoint?.trim();
          if (!original) return;
          void runAgentDispatch(
            original,
            buildOutboundConversation(
              useChatStore.getState().messages,
              useChatStore.getState().activeArchivedCount,
              useChatStore.getState().chatHistoryBudget,
            ),
          );
          return;
        }
        default:
          return;
      }
    },
    [
      showToast,
      handleSendMessage,
      handleChapterButton,
      handleConfirmCommit,
      handleConfirmPrune,
      handleSendUserAction,
      handleApplyRevisionPreview,
      appendMessage,
      consumeSuggestedAction,
      runAgentDispatch,
    ],
  );

  return {
    handleSendMessage,
    handleSuggestedAction,
    handleSendUserAction,
    handleChapterButton,
    undoToTurn,
    stopAgent,
  };
}
