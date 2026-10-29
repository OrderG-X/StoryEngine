import { useCallback, useRef } from "react";
import { clearLedgerExclusions, ledgerDayOverrideForConfirm, ledgerExclusionsForConfirm } from "../utils/ledgerExclusions.js";
import { fetchStateOverview, restoreSnapshotApi } from "../api/client.js";
import { isCandidateDecisionType, isDraftEditMode, isOperationAction, readStoredOperationAction, streamAgentChat, type AgentUserAction, type OperationViewData } from "../api/agentChatClient.js";
import { cancelOperationRequest } from "../api/operationsClient.js";
import { renameChatSession } from "../api/chatSessionsClient.js";
import {
  emptyAssistantMessage,
  projectAgentEvent,
  settleUnfinishedAgentTurn,
  type AgentProjectionEvent,
} from "./agentEventProjection.js";
import { deriveIntentTitle } from "./deriveIntentTitle.js";
import { agentFlowStatusForTool, flowAfterOperation } from "./agentFlowStatus.js";
import { truncateMessagesFrom, undoCutId } from "./truncateMessages.js";
import { buildOutboundConversation } from "./buildOutboundConversation.js";
import { flowStatusAfterGenerateFailure } from "./reconcileChapterState.js";
import { openCommitSheet, reusableCommitPreviewId } from "../workspace/commitSheet.js";
import { settleDraftEdit } from "../workspace/draftEditOutcome.js";
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
  canRetargetWorkspaceOperation,
} from "../utils/workspaceOperation.js";
import { lastTurnUndoHintFromMessages } from "../utils/lastTurnUndoHint.js";
import { stripStaleTurnSuggestions } from "../utils/staleTurnSuggestions.js";
import { streamingDraftDisplay } from "../utils/streamingDraftDisplay.js";
import { editDraft, flushDraftSave, isOwnSavedVersion, openPaper, refreshPaper, UnsavedPaperError } from "../drafts/draftSync.js";
import { claimWorkspaceForRestore } from "../workspace/claimRestore.js";
import { saveChatNow } from "../sync/chatSync.js";
import { flushAllSaves } from "../sync/saveAll.js";
import { applyOverviewToWorkspace, flowStatusForPaper } from "../workspace/applyOverview.js";
import { syncWorkspaceAfterRestore } from "../workspace/syncAfterRestore.js";
import { fetchChapterPaper } from "../api/workingDraftClient.js";
import { patchChapterFlagsFromPaper } from "../utils/bookUtils.js";
import { ENDED_OPERATION_STATES, projectOperationEverywhere, projectOperationProgressEverywhere } from "../workspace/operationCards.js";
import { applyDraftDelta, draftPhaseOfStep, EMPTY_DRAFT_STREAM, type DraftStreamState } from "../workspace/draftStream.js";
import { aiErrorAfterWriteBody, aiErrorBody } from "../lib/ai-error-text.js";
import { pageLeaving } from "../lib/page-leaving.js";
import { reconnectOperations } from "../workspace/operationReconnect.js";
import { cardOf } from "../utils/messageCards.js";
import type { AiErrorReason } from "../server/lib/ai-errors.js";

/** 操作还在做的那几种（别的都是停下来了：做完、没成、停掉、停着等）。 */
const LIVE_STATES: ReadonlySet<string> = new Set(["queued", "running"]);

/** 回合收尾等盘上重读最多等这么久（读盘卡住不能一直占着工作区）。 */
const RESYNC_WAIT_MS = 5_000;

/** 等这些都落定，最多等 ms；返回是不是都落定了。 */
async function settleWithin(promises: readonly Promise<unknown>[], ms: number): Promise<boolean> {
  if (promises.length === 0) return true;
  if (ms <= 0) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = await Promise.race([
    Promise.allSettled(promises).then(() => true),
    new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ms); }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  return settled;
}


/* ------------------------------------------------------------------ */
/*  useChat hook                                                        */
/* ------------------------------------------------------------------ */

export interface UseChatParams {
  projectPath: string | null;
  /**
   * 资料类刷新：仅按 StateOverview 重建资料/侧栏面板，保留当前章节/草稿/消息。
   * 改设定、改账做完了（settings.change / ledger.change）、带 refreshScope:"foundation" 的工具结果调它；可不传。
   */
  refreshWorkspaceFromOverview?: (overview: StateOverview) => void;
}

export interface UseChatResult {
  handleSendMessage: (message: string) => Promise<void>;
  handleSuggestedAction: (action: SuggestedAction) => void;
  /** 「下一步」选项的结构化动作直达（R4.7）：点击直接发 body.action，不经模型。 */
  handleSendUserAction: (action: AgentUserAction, options?: { readonly echo?: string }) => Promise<void>;
  handleChapterButton: (button: ChapterButton) => void;
  /** 块级「撤销到此」：把该回合 git 改动整块回退 + 截断该回合及其后对话 + 重拉 overview 刷工作台。 */
  undoToTurn: (message: ChapterMessage) => Promise<void>;
  /** M3：停止当前在跑的 agent 流（中止 SSE）；已写出内容保留、不报错。无在跑流时调用是 no-op。 */
  stopAgent: () => void;
}

/** 稿纸上开着这本书的哪一章（作者眼前的）；还没开就是 undefined。 */
function visibleChapter(projectPath: string): number | undefined {
  const paper = useDraftStore.getState();
  return paper.loaded && paper.projectPath === projectPath && paper.chapter > 0 ? paper.chapter : undefined;
}

/** 作者发这句时在看哪一章（右栏「这一章的对话」按它分，重构 P6 第 6 步）。 */
function chapterStamp(): { readonly chapter?: number } {
  const chapter = useBookStore.getState().workspace.currentChapter?.chapterNumber;
  return typeof chapter === "number" && chapter > 0 ? { chapter } : {};
}

/** 这一轮是作者哪句话发起的（写作版本 P2a）：消息号 + 发出时间，随消息存、随请求发；重发沿用存下的。 */
export interface MessageRef {
  readonly messageId: string;
  readonly issuedAt: string;
}

/** 作者的一句话：带消息号（UUID）、发出时间、所在章；ref 是随请求发的那两样。 */
export function authorMessage(content: string): { readonly message: ChapterMessage; readonly ref: MessageRef } {
  const id = `user-${crypto.randomUUID()}`;
  const issuedAt = new Date().toISOString();
  return { message: { id, role: "user", content, issuedAt, ...chapterStamp() }, ref: { messageId: id, issuedAt } };
}

export function useChat(params: UseChatParams): UseChatResult {
  const {
    projectPath,
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
  // 这一轮交上、还在做的操作（写作版本 P2a）：「停止」停的是它——服务端先记下停掉再掐在途请求，这一轮跟着它收尾；
  // 还没交上（模型在想、在调别的工具）才掐连接。
  const liveOperationRef = useRef<{ readonly projectPath: string; readonly opId: string } | null>(null);
  const stopAgent = useCallback(() => {
    const live = liveOperationRef.current;
    if (live) {
      void cancelOperationRequest(live.projectPath, live.opId).catch((error: unknown) => {
        useNavigationStore.getState().showToast(`没停成：${error instanceof Error ? error.message : String(error)}`, 5000);
      });
      return;
    }
    agentAbortRef.current?.abort();
  }, []);

  const runAgentDispatch = useCallback(
    async (
      text: string,
      conversation: readonly { readonly role: "user" | "assistant"; readonly content: string }[],
      /** 结构化动作（「确认定稿」按钮）：服务端直接执行对应工具，不经模型。 */
      action?: AgentUserAction,
      /** 这一轮是作者哪句话发起的（重试沿用原来那句的）。 */
      ref?: MessageRef,
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
      // 写稿操作（draft.change）的正文流：按操作的实时事件拼（workspace/draftStream），显示在稿纸上（只读，不进作者的稿子，重构 P5）。
      // 这一轮交上的写稿操作一开始重置；做完了稿纸按盘上终稿重读。接着写时本来写好的那段原样显示在新写的前面。
      let draftStream: DraftStreamState = EMPTY_DRAFT_STREAM;
      // 这一轮跟着的那次写稿操作（只认它的正文流）。
      let draftOpId: string | null = null;
      let draftStreamChapter: number | null = null;
      // 流式要换到另一章时，先把手上那章存掉、再换稿纸（换完清空）；这期间流来的字先攒着，到的工具结果等它换完再处理。
      let paperSwitch: Promise<void> | null = null;
      // 流式稿还在出（写稿操作开始到它停下来）：之后迟到的换章不再把流式稿摆回稿纸（第 5 轮 S4）。
      let streamOpen = false;
      // 这一次出稿报错了：还没换完的换章不换了，稿纸留在原来那章（第 5 轮 S4）。
      let draftFailed = false;
      // 回合收完尾（等够了、交还了工作区）：之后才到的换章、工具结果都不再动稿纸和工作区（第 5 轮 S3）。
      let turnFinished = false;
      // 本回合发起的稿纸重读：回合收尾、释放操作所有权之前等它们读完。
      const pendingPaperSyncs: Promise<unknown>[] = [];
      const track = (promise: Promise<unknown>): void => {
        pendingPaperSyncs.push(promise.catch(() => undefined));
      };
      // 这一轮做完的改设定、改账（重读过概况的）：同一次的记录会来几回，只读一回。
      const refreshedChanges = new Set<string>();
      // 这一轮已经写好的稿（写稿 / 改稿换上了）：之后再出错，「重试这一步」会把整句话重发、再写再改一遍，不给。
      let finishedWrite: "draft" | "revise" | null = null;
      // 追加一条错误卡消息（error 卡；可重试时带 retry-agent）。tool-error 与 error 共用。
      const appendErrorMessage = (message: string, retryable: boolean, reason?: AiErrorReason) => {
        // 关页 / 刷新掐断的流不是出错：不记错误卡（交了的操作重开书会接上）。
        if (pageLeaving()) return;
        // 这一轮交的操作还没结束：断的只是对话这条流，操作照做——不说「没做完」、不给重试，接着订阅它（P2a 第九节「重连」）。
        // 也不另记一句「还在做」：卡自己跟着变（软件关过的停着、做完的结论），另记的那句会和卡对不上（杀进程真测 10-30）。
        const turnMessage = useChatStore.getState().messages.find((item) => item.id === assistantMsgId);
        const live = turnMessage ? cardOf(turnMessage, "operation")?.op : undefined;
        if (live && !ENDED_OPERATION_STATES.has(live.state)) {
          if (projectPath) reconnectOperations(projectPath);
          return;
        }
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
                  ...(ref ? { retryOf: ref } : {}),
                },
              ],
            }
            : {}),
        });
      };
      // 本轮是否出现过章节写类动作（写稿、改稿操作、commit_apply）——出错 / 停止收尾时
      // 据此重读一次盘上的稿纸和状态（回执可能丢了，盘上其实已写）。纯读 / 问答回合不浪费这次 IO。
      let sawChapterWriteToolCall = false;
      // 定稿在飞：记下发起时盘上那份定稿，收尾时据它判断「其实已经定稿、只是回执丢了」。
      let commitAttempt: { readonly committedBefore: string | null } | null = null;
      // 出稿在飞：记下发起时稿纸开着哪章、盘上那版的版本号。停止 / 出错收尾时盘上换成了别的版本、又不是这个窗口自己存的，
      // 才说「盘上其实已经写完了」（只和同一章比，第 5 轮 S4；作者自己存的字不算，第 6 轮 T4）。
      let generateAttempt: { readonly chapter: number; readonly versionBefore: string | null } | null = null;
      // AI 真撤销了（undo / manage_snapshots op=undo）：回合收尾时剥掉旧回合挂着的过时建议条。
      let agentUndone = false;

      const streamedText = (): string => draftStream.base + streamingDraftDisplay(draftStream.text, draftStream.base);
      const showStreaming = (): void => {
        const paper = useDraftStore.getState();
        if (!streamOpen || turnFinished || draftStreamChapter === null || paper.chapter !== draftStreamChapter) return;
        paper.setStreaming(streamedText());
      };
      const endStreaming = (): void => {
        streamOpen = false;
        if (useDraftStore.getState().streaming !== null) useDraftStore.getState().setStreaming(null);
      };
      // 写稿没成收尾：写稿操作一开始把 flowStatus 置「正在生成草稿」，失败路径若不复位，标题区
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
      const resyncAfterInterruptedWrite = async (partial: { readonly text: string; readonly chapter: number } | null): Promise<void> => {
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
          if (
            generateAttempt
            && generateAttempt.chapter === paper.chapter
            && !paper.incoming
            && paper.baseVersion !== generateAttempt.versionBefore
            && !isOwnSavedVersion(paper.baseVersion)
          ) {
            appendMessage({
              id: `assistant-reconcile-${Date.now()}`,
              role: "assistant",
              content: `（核对盘上：停止前第 ${paper.chapter} 章其实已经写完了，稿纸上是盘上那一整版，要退回就撤销上一步。）`,
            });
            return;
          }
          if (!partial?.text.trim() || partial.chapter !== paper.chapter) return;
          if (!paper.incoming && partial.text.trim().length > paper.body.trim().length) editDraft(partial.text);
        } catch {
          // 尽力而为，绝不让它破坏收尾路径。
        }
      };
      const requestResync = (partial: { readonly text: string; readonly chapter: number } | null = null): void => {
        if (!sawChapterWriteToolCall) return;
        resyncPromise ??= resyncAfterInterruptedWrite(partial);
      };
      // 写稿操作写的是哪一章（操作的第一份记录就知道）：认领那章——这一轮的操作、书的「当前章」、这轮对话都归它；
      // 稿纸开着别的章就换过去（先存掉手上那章）。
      const claimDraftChapter = (chapter: number): void => {
        if (draftStreamChapter !== null || !canRetargetWorkspaceOperation(operation)) return;
        draftStreamChapter = chapter;
        const previousChapter = operation.chapter;
        // 认领 AI 写的那章：这一轮的操作、书的「当前章」、这轮对话都归它。稿纸要换章时，等稿纸真换过去了才认领
        // （第 4 轮复核 R8：手上那章存不上、稿纸没换成，就都留在原章，下一句话不能指向 AI 写的那章）。
        const adopt = (): void => {
          const adopted = retargetWorkspaceOperation(operation, { chapter });
          if (!adopted) return;
          operation = adopted;
          if (chapter === previousChapter) return;
          // 这轮对话归那一章（稿纸跳过去后，下一句话说完它不收进「别的章的对话」）。
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
        };
        if (useDraftStore.getState().chapter !== chapter && projectPath) {
          // AI 写的是另一章：稿纸换到那一章（先存掉手上那章）。回合收完尾、出稿报错了、工作区换了就不换了。
          const switching = openPaper(projectPath, chapter, { stillWanted: () => !turnFinished && !draftFailed && ownsCurrentWorkspace() })
            .then((switched) => {
              if (!switched) return;
              adopt();
              // 写前的字按换过去的那章算（停止收尾时只和同一章比）。
              if (generateAttempt) generateAttempt = { chapter, versionBefore: useDraftStore.getState().baseVersion };
              showStreaming();
            }, (error: unknown) => {
              // 手上那章的字没存上、那一章读不出来：稿纸不换（字还在这一章上），也不认领那一章，如实说一声（第 5 轮 S1）。
              if (!ownsCurrentWorkspace()) return;
              const reason = error instanceof UnsavedPaperError
                ? error.message
                : `第 ${chapter} 章没读出来（${error instanceof Error ? error.message : String(error)}），稿纸留在原来那章。`;
              useNavigationStore.getState().showToast(`AI 在写第 ${chapter} 章；${reason}`, 6000);
            });
          paperSwitch = switching;
          void switching.finally(() => { if (paperSwitch === switching) paperSwitch = null; });
          track(switching);
        } else {
          adopt();
        }
      };
      // 这一轮交上的写稿操作开始了：中间区切到写作台、清空流式缓冲、流程态置「正在生成草稿」（否则续写时标题区残留上一章的「已入库」）。
      const beginDraftStream = (view: OperationViewData): void => {
        draftOpId = view.opId;
        sawChapterWriteToolCall = true;
        useNavigationStore.getState().requestCenterView("desk");
        draftStream = EMPTY_DRAFT_STREAM;
        draftStreamChapter = null;
        streamOpen = true;
        draftFailed = false;
        generateAttempt = { chapter: useDraftStore.getState().chapter, versionBefore: useDraftStore.getState().baseVersion };
        useBookStore.getState().updateWorkspace({ flowStatus: "draft_generating" });
        if (view.chapter !== undefined) claimDraftChapter(view.chapter);
      };
      // 写稿操作停下来了（做完、没成、停掉、停着等）：流式稿收起，按盘上重读稿纸和书的状态。
      // 停掉的：流出来的字盘上没有更全的一版就留给作者（「已停止 · 已写出的内容保留」，和原来停止出稿一样）。
      const finishDraftStream = (view: OperationViewData): void => {
        if (view.opId !== draftOpId || !streamOpen) return;
        const partial = view.state === "cancelled" && draftStreamChapter !== null ? { text: streamedText(), chapter: draftStreamChapter } : null;
        endStreaming();
        generateAttempt = null;
        useUiStore.getState().setDraftPhase(null);
        const applied = view.state === "succeeded" && view.draft?.applied === true;
        if (applied) finishedWrite = "draft";
        if (view.state !== "succeeded") draftFailed = true;
        const apply = (): void => {
          if (!projectPath) return;
          const sameChapter = view.chapter !== undefined && view.chapter === operation.chapter;
          // 写的不是稿纸上这章（换章没换成）：这章没在写，马上退出「正在生成草稿」，不挂到这一轮结束。
          if (!sameChapter) unstickGeneratingFlow();
          track(fetchStateOverview({ projectPath, maxTimelineEvents: 8 }).then((overview) => {
            if (!ownsCurrentWorkspace()) return;
            if (!sameChapter || !applied) {
              refreshWorkspaceFromOverview?.(overview);
              return;
            }
            applyOverviewToWorkspace(overview, {
              flowStatus: flowAfterOperation(view, useBookStore.getState().workspace.flowStatus),
              chapter: view.chapter as number,
              ...(view.draft?.title ? { title: view.draft.title } : {}),
            });
          }).catch(() => undefined));
          track(refreshPaper().then(() => {
            if (!ownsCurrentWorkspace()) return;
            const paper = useDraftStore.getState();
            if (partial?.text.trim() && partial.chapter === paper.chapter && !paper.incoming && partial.text.trim().length > paper.body.trim().length) {
              editDraft(partial.text);
            }
            if (!applied) unstickGeneratingFlow();
          }));
        };
        // 稿纸正在换到 AI 写的那章：等换完（或没换成）再按那时的当前章应用；回合收完尾还没换完就不应用了。
        if (paperSwitch) {
          track(paperSwitch.then(() => { if (!turnFinished && ownsCurrentWorkspace()) apply(); }));
          return;
        }
        apply();
      };
      // 这一轮跟着的那次改稿操作（片 2C：按核账改 / 去 AI 味 / 改写）：不流正文，做完了才按盘上重读稿纸。
      let editOpId: string | null = null;
      let editSettled = false;
      const beginEdit = (view: OperationViewData): void => {
        editOpId = view.opId;
        sawChapterWriteToolCall = true;
        // 改完的正文就在眼前（AI 味卡、核账卡是在右栏点的，作者可能停在设定本）。
        useNavigationStore.getState().requestCenterView("desk");
      };
      // 改稿停下来了（做完、没成、停掉、过时了）：按盘上重读稿纸和书的状态，换上了的高亮改后那几句；停着等作者的不算。
      const finishEdit = (view: OperationViewData): void => {
        if (view.opId !== editOpId) return;
        editOpId = null;
        editSettled = true;
        const applied = view.state === "succeeded" && view.draft?.applied === true;
        if (applied) finishedWrite = "revise";
        const apply = (): void => {
          if (!projectPath) return;
          track(fetchStateOverview({ projectPath, maxTimelineEvents: 8 }).then((overview) => {
            if (ownsCurrentWorkspace()) refreshWorkspaceFromOverview?.(overview);
          }).catch(() => undefined));
          track(refreshPaper().then(() => {
            if (ownsCurrentWorkspace()) settleDraftEdit(view);
          }));
        };
        if (paperSwitch) {
          track(paperSwitch.then(() => { if (!turnFinished && ownsCurrentWorkspace()) apply(); }));
          return;
        }
        apply();
      };
      // M3：本轮的中止器——「停止」按钮 abort 它即可干净停掉这条流（streamAgentChat 据此不报错收尾）。
      const abortController = new AbortController();
      agentAbortRef.current = abortController;
      try {
        // AI 读的是盘上的稿子：先把作者没存的字存掉。存不上也照常发（AI 写的稿回来时稿纸会提示作者选）。
        // 回合里作者接着打的字照常存（写作版本 P1b）：AI 写完时稿子改过，AI 那版不换上、留成候选让作者选。
        const flushed = await flushDraftSave();
        if (!flushed.ok) showToast(`稿子还没存上（${flushed.error}），AI 看到的是上一次存下的那版。`, 5200);
        // H3：把用户当前所在章一并发给后端，让 agent 默认作用于该章、各工具缺省回退该值（回看旧章不写错章）。
        // 「所在章」= 稿纸上开着的那章（作者眼前的）；稿纸还没开才用书的当前章（第 4 轮复核 R8）。
        const currentChapterNumber = visibleChapter(projectPath) ?? useBookStore.getState().workspace.currentChapter?.chapterNumber;
        // R7.2：带上「上一个有写盘回合的首个快照」——后端 undo 工具优先整回合回退（一回合改两处也全撤），
        // 与块级「撤销到此」同一锚点；作者说「撤销上一步」指的是上一回合的全部改动。
        const lastTurnUndoHint = lastTurnUndoHintFromMessages(useChatStore.getState().messages);
        const pickedText = typeof currentChapterNumber === "number" ? pickedDirectionGoal(useChatStore.getState().messages, currentChapterNumber) : undefined;
        await streamAgentChat(
          {
            projectPath,
            messages: [...conversation, { role: "user", content: text }],
            ...(typeof currentChapterNumber === "number" ? { currentChapter: currentChapterNumber } : {}),
            ...(lastTurnUndoHint ? { lastTurnUndoHint } : {}),
            ...(pickedText && typeof currentChapterNumber === "number" ? { pickedDirection: { chapter: currentChapterNumber, text: pickedText } } : {}),
            ...(action ? { action } : {}),
            ...(ref ? { messageId: ref.messageId, issuedAt: ref.issuedAt } : {}),
          },
          {
            onTextDelta: (delta) => project({ type: "text-delta", text: delta }),
            // 这一轮交上的操作（写作版本 P2a）：操作卡跟着变（挂着同一次的别的卡也变），做完了挂结果卡、推进流程态。
            onOperation: (view) => {
              if (!ownsCurrentWorkspace()) return;
              projectOperationEverywhere(view, assistantMsgId, { announced: ENDED_OPERATION_STATES.has(view.state) });
              liveOperationRef.current = view.allowed.includes("cancel") && view.state !== "paused" ? { projectPath, opId: view.opId } : null;
              // 改稿、换上 / 不要 AI 稿：不流正文，停下来了按盘上重读稿纸（稿纸提示条跟着收起或换成别的）。
              if ((view.kind === "draft.change" && isDraftEditMode(view.mode)) || isCandidateDecisionType(view.kind)) {
                if (editOpId === null && !editSettled) beginEdit(view);
                if (ENDED_OPERATION_STATES.has(view.state)) finishEdit(view);
              } else if (view.kind === "draft.change") {
                if (draftOpId === null) beginDraftStream(view);
                if (!LIVE_STATES.has(view.state)) finishDraftStream(view);
              }
              // 改设定、改账做完了（结果不带概况）：重读一份，设定本、主角、线索、待处理跟着变。同一次只读一回。
              if (view.changed && !refreshedChanges.has(view.opId) && projectPath) {
                refreshedChanges.add(view.opId);
                track(fetchStateOverview({ projectPath, maxTimelineEvents: 8 })
                  .then((overview) => { if (ownsCurrentWorkspace()) refreshWorkspaceFromOverview?.(overview); })
                  .catch(() => undefined));
              }
              if (view.state === "succeeded") {
                const flowBefore = useBookStore.getState().workspace.flowStatus;
                const flow = flowAfterOperation(view, flowBefore);
                if (flow !== flowBefore && view.chapter === operation.chapter) useBookStore.getState().updateWorkspace({ flowStatus: flow });
              }
            },
            onOperationProgress: ({ opId, text: progress }) => {
              if (!ownsCurrentWorkspace()) return;
              projectOperationProgressEverywhere(opId, progress);
            },
            // 写稿操作的步骤开始（稿纸顶上说在拟纲 / 写 / 核）、正文流（逐字进稿纸）。
            onOperationLive: ({ opId, event }) => {
              if (!ownsCurrentWorkspace() || opId !== draftOpId) return;
              if (event.type === "step") {
                const phase = draftPhaseOfStep(event.step);
                if (phase) useUiStore.getState().setDraftPhase(phase);
                return;
              }
              draftStream = applyDraftDelta(draftStream, event);
              showStreaming();
            },
            // R4：服务端裁了历史窗口/其它状态说明，照实投影成助手消息前的一条系统提示，不静默吞掉。
            onStatus: (message) => project({ type: "status", text: message }),
            onUsage: (usage) => project({ type: "usage", usage }),
            onReasoningDelta: (delta) => project({ type: "reasoning-delta", text: delta }),
            onToolCall: ({ toolName, toolCallId }) => {
              if (!ownsCurrentWorkspace()) return;
              project({ type: "tool-call", toolCallId: stepIdFor(toolName, toolCallId), toolName, startedAt: Date.now() });
              if (toolName === "commit_apply") {
                sawChapterWriteToolCall = true;
                commitAttempt = { committedBefore: useDraftStore.getState().committed?.body ?? null };
              }
            },
            onToolResult: (info) => {
              if (!ownsCurrentWorkspace()) return;
              // 步骤马上落定（跨章的也一样，否则该步永远 running）；章号不匹配只跳过下面的「工作区应用」。
              project({
                type: "tool-result",
                toolCallId: stepIdFor(info.toolName, info.toolCallId),
                toolName: info.toolName,
                endedAt: Date.now(),
                output: info,
              });
              const apply = (): void => {
                // 跨章工具结果（用户在第 1 章、agent 核实第 99 章的 commit_preview 等）：按这时的当前章判。
                const chapterMismatch = typeof info.chapter === "number" && info.chapter !== operation.chapter;
                // 定稿预览一到就弹出定稿清单（重构 P6）；记下预览的是哪一版，稿子没再变时再点「定稿」直接打开这份。
                if (info.toolName === "commit_preview" && !chapterMismatch) {
                  useChatStore.getState().stampPreviewVersion(assistantMsgId, useDraftStore.getState().baseVersion);
                  openCommitSheet(assistantMsgId);
                }
                if (chapterMismatch) {
                  // 跨章工具结果只跳过「当前章稿纸 / 流程态应用」，携带最新章列表 / 入库状态的 overview 照刷资料面板。
                  if (info.overview) refreshWorkspaceFromOverview?.(info.overview);
                  // 只有真写了那一章（出稿 / 改稿 / 定稿回 refreshScope:"full"，或打了存档点）才重读它、提示一句；
                  // 核账回执、定稿预览这类没写的，说「写的是第 N 章」就是瞎说。
                  if (info.ok === false || (info.refreshScope !== "full" && info.snapshotId === undefined)) {
                    unstickGeneratingFlow();
                    return;
                  }
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
                const nextFlow = agentFlowStatusForTool(info.toolName, info, flowBefore);
                if (!info.overview) {
                  const changedBible = info.refreshScope === "foundation"
                    || (info.toolName === "settle_apply" && info.refreshScope === "full");
                  if (changedBible && projectPath) {
                    // 定论改齐的结果不带概况：重读一份，设定本、主角、待处理跟着变。
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
                // 盘上没变什么都不发生；变了而作者手上没有没存的字就换上，有就出提示让作者选（撤销也一样）。
                track(refreshPaper()
                  .then(() => {
                    // 撤销后这一章回到哪一步，按盘上那版算（可能退回到「还没写过」）。
                    if (undone && ownsCurrentWorkspace()) {
                      useBookStore.getState().updateWorkspace({ flowStatus: flowStatusForPaper(useDraftStore.getState()) });
                    }
                  }));
              };
              // 稿纸正在换到 AI 写的那章：等换完（或没换成）再按那时的当前章应用（第 4 轮复核 R8）；
              // 回合收完尾还没换完就不应用了（第 5 轮 S3：工作区已交还，稿纸下次读盘自会对上）。
              if (paperSwitch) {
                track(paperSwitch.then(() => { if (!turnFinished && ownsCurrentWorkspace()) apply(); }));
                return;
              }
              apply();
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
        // 回合收尾：
        //   ① 不管怎么结束（停止、断了、出错、正常），残留 running 的步骤/卡片都落定，金光/字幕随之静止
        //      （断了 / 出错的说一句没收到结果，第 6 轮复核 T3）；
        //   ② 停止时流出来的半章：盘上没有更全的一版就留给作者（「已停止 · 已写出的内容保留」）；
        //   ③ 写类工具在飞 → 重读一次盘上真值（回执丢了但盘上可能已写完整稿/已入库）。
        // 用户点「■」abort 只是断了流（streamAgentChat 对主动 abort 不报错、不收尾），②③ 在这里补齐。
        const wasAborted = abortController.signal.aborted;
        if (ownsCurrentWorkspace()) {
          updateMessage(assistantMsgId, (current) => settleUnfinishedAgentTurn(current, Date.now(), wasAborted ? undefined : "这一轮中途断了，没收到这一步的结果。"));
        }
        if (wasAborted && ownsCurrentWorkspace()) {
          const paperNow = useDraftStore.getState();
          const partial = paperNow.streaming !== null ? { text: paperNow.streaming, chapter: paperNow.chapter } : null;
          endStreaming();
          unstickGeneratingFlow();
          requestResync(partial);
        }
        // 回合收尾兜底：SSE 回合走到 finally 时这一轮跟着的写稿操作已经停下来（或作者断开了），残留的流式显示 / draft_generating
        // 只能是某条中途分支没复位，按稿纸现状复位（unstickGeneratingFlow 只在确实卡住时才动）。
        if (!wasAborted) {
          endStreaming();
          unstickGeneratingFlow();
        }
        useUiStore.getState().setDraftPhase(null);
        // 保持 operation 所有权直到盘上真值读完；否则异步读刚返回，finally 已释放 token，结果会被当成迟到数据丢掉。
        // 等的途中排着的工具结果又发起了重读（第 5 轮 S2）：接着等，直到不再有新的。
        // 但一共最多等 RESYNC_WAIT_MS：读盘卡住不能把整个工作区一直占着。
        const waitUntil = Date.now() + RESYNC_WAIT_MS;
        for (;;) {
          const waiting = [...(resyncPromise ? [resyncPromise] : []), ...pendingPaperSyncs];
          if (!(await settleWithin(waiting, waitUntil - Date.now()))) break;
          if ((resyncPromise ? 1 : 0) + pendingPaperSyncs.length === waiting.length) break;
        }
        // 从这里起迟到的换章、工具结果都不再动稿纸和工作区（第 5 轮 S3）。
        turnFinished = true;
        if (paperSwitch && draftStreamChapter !== null && ownsCurrentWorkspace()) {
          showToast(`AI 写的是第 ${draftStreamChapter} 章，稿纸没来得及换过去；在章节列表里点开它看。`, 6000);
        }
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
        liveOperationRef.current = null;
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
      // 从存稿到截完对话、重读完都占着工作区：这期间开不了新的一轮，截对话不会把新话截掉（第 6 轮复核 T10）。
      const claimed = liveChat.chatLoading ? null : claimWorkspaceForRestore(projectPath);
      if (!claimed) {
        showToast("已有写作操作正在进行，请等它结束后再发送新请求。", 4200);
        return;
      }
      try {
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
      } finally {
        finishWorkspaceOperation(claimed);
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
      if (isWorkspaceBusy() || liveChat.chatLoading) {
        showToast("已有操作正在进行，请等它结束后再发送新请求。", 4200);
        return;
      }

      const { message: userMessage, ref } = authorMessage(text);

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
      await runAgentDispatch(text, conversation, undefined, ref);
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
      if (isWorkspaceBusy() || liveChat.chatLoading) {
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
      const echo = authorMessage(text);
      appendMessage(echo.message);
      await runAgentDispatch(text, conversation, {
        toolName: "commit_apply",
        chapter,
        ...(target?.previewToken ? { previewToken: target.previewToken } : {}),
        ...(excluded.length > 0 ? { excluded } : {}),
        ...(dayOverride !== undefined ? { dayOverride: dayOverride.day } : {}),
        ...(dayEnd !== undefined ? { dayEndOverride: dayEnd } : {}),
      }, echo.ref);
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
      if (isWorkspaceBusy() || liveChat.chatLoading) {
        showToast("已有操作正在进行，请等它结束后再裁剪。", 4200);
        return;
      }
      const text = target?.keep ? `确认裁剪操作历史（保留最近 ${target.keep} 条）` : "确认裁剪操作历史";
      const conversation = buildOutboundConversation(liveChat.messages, liveChat.activeArchivedCount, liveChat.chatHistoryBudget);
      const echo = authorMessage(text);
      appendMessage(echo.message);
      await runAgentDispatch(text, conversation, { toolName: "prune_snapshots", ...(target?.keep ? { keep: target.keep } : {}) }, echo.ref);
    },
    [projectPath, appendMessage, setChatError, runAgentDispatch, showToast],
  );

  /* ---- handleSendUserAction：「下一步」选项的结构化动作直达（R4.7） ---- */

  // 服务端自己生成的确定性选项（预览定稿/再核一次/写下一章…）带 action：点击直接发 body.action，
  // 服务端执行对应工具、结果照常进对话——不再发一句意图给模型白跑一轮（一次 3～5 万输入）。
  // 与「确认定稿」「确认裁剪」同一通道；对话里照留一句「你：…」回显（userActionChoiceText）。
  const handleSendUserAction = useCallback(
    /** echo＝对话里「你：…」那句换成调用方给的（选中文字改写说清是润色还是扩写）。 */
    async (action: AgentUserAction, options: { readonly echo?: string } = {}): Promise<void> => {
      if (!projectPath) {
        setChatError("请先打开真实本地项目。");
        return;
      }
      const liveChat = useChatStore.getState();
      if (isWorkspaceBusy() || liveChat.chatLoading) {
        showToast("已有操作正在进行，请等它结束再点。", 4200);
        return;
      }
      // 「写这一章」带的方向就是作者挑中的那种走法：回显里写明照哪种写。
      const draftAction = isOperationAction(action) && action.kind === "new" && action.type === "draft.change" && (action.mode === "write" || action.mode === "continue") ? action : undefined;
      const picked = draftAction ? pickedDirection(liveChat.messages, draftAction.params.chapter) : undefined;
      const goal = draftAction?.params.direction;
      const text = options.echo ?? userActionChoiceText(action, picked && goal?.startsWith(directionGoal(picked)) ? picked.title : undefined);
      const conversation = buildOutboundConversation(liveChat.messages, liveChat.activeArchivedCount, liveChat.chatHistoryBudget);
      const echo = authorMessage(text);
      appendMessage(echo.message);
      // 写稿动作把作者带回写作台（正文流式进稿纸；按章自动切换当前章，见 runAgentDispatch 的 beginDraftStream）。
      if (draftAction) useNavigationStore.getState().requestCenterView("desk");
      await runAgentDispatch(text, conversation, action, echo.ref);
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
          handleChapterButton("quality");
          return;
        case "ai-review":
          handleChapterButton("review");
          return;
        case "revision-preview":
          void handleSendMessage("按我的方向给这一章改一版，先出预览。");
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
        case "rewrite-confirm":
        case "continue-confirm": {
          // 存盘读回的按钮动作点的时候再核一遍（服务端执行前还会再核）。
          const draft = readStoredOperationAction(action.operationAction);
          if (!draft) {
            showToast("这个按钮已经失效了，请让 AI 重新提一次。", 4200);
            return;
          }
          consumeSuggestedAction(action);
          void handleSendUserAction(draft);
          return;
        }
        case "continue-next":
          handleChapterButton("write_next");
          return;
        case "retry-agent": {
          // agent 大脑失败后重试：用按钮 endpoint 携带的原始消息重跑 agent 派发，不重复 append 用户消息。
          const original = action.endpoint?.trim();
          if (!original) return;
          // 重发沿用原来那句的消息号和发出时间（那句交过的操作认得出是同一次，写作版本 P2a）。
          void runAgentDispatch(
            original,
            buildOutboundConversation(
              useChatStore.getState().messages,
              useChatStore.getState().activeArchivedCount,
              useChatStore.getState().chatHistoryBudget,
            ),
            undefined,
            action.retryOf,
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
