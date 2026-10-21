/**
 * AiChatCodex — codex 视觉的右侧 AI 对话列（codex 三栏壳第 3 列 `<aside class="ai">`）。
 *
 * 这是「唯一控制面」的 codex 聊天列：发送 / IME 守卫 / 智能跟随滚动 / 停止 / 清空 /
 * 撤销到此 / 快捷操作 / 流程映射，
 * presentation 走 codex.css 里 `.ai/.ai-head/.ai-flow/.msg/.msg-user/.msg-ai/.step-fold/.suggest/.composer`
 * 那套 class（作用域在 .codex-app 内）。聊天区为「内容优先平铺」（无气泡框）：
 * 用户消息=低调浅底块，助手消息=裸全宽文字（无气泡/无框）；思考过程与调用工具都是默认收起的
 * 「一行步骤」（无 emoji，展开钮贴标签，进行中那一步标签跑金色光影，点开才看详情）。
 *
 * 复用的纯函数来自 chatRenderShared（聊天渲染共享模块）：
 *   getPlaceholder / formatMessageBlocks / renderRichText / ThinkingIndicator / workflowErrorTitle。
 * 工具步聚合复用 agentTimelineModel 的 buildTimelineModel；权限点复用 v2Utils.primaryPermission。
 */
import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { ToolStep, DraftReviewIssueView, ReaderCatchUpStatus } from "../../../api/types.js";
import type { ChapterMessage, MessageCard, WritingWorkspaceLayoutProps, AiFlavorViolation } from "../../../types.js";
import { cardOf } from "../../../utils/messageCards.js";
import { shouldSendOnEnterKey } from "../../../utils/imeEnterGuard.js";
import { resolveToolStepLabel } from "../../../hooks/agentEventProjection.js";
import { isBookCreationGreeting } from "../../../hooks/useProjectNavigation.js";
import { buildTimelineModel } from "../agentTimelineModel.js";
import { primaryPermission, uiText } from "../v2Utils.js";
import { IconArrowUp, IconChevronRight, IconClose, IconCopy, IconSparkle, IconStop, IconUndo } from "./icons.js";
import { useActiveModel } from "./useActiveModel.js";
import { StepCardCollapsedByDefault } from "./StepCard.js";
import { activeMentionQuery, buildMentionCandidates, insertMention } from "./composerMention.js";
import { buildInboxTodos, type InboxTodo } from "./inboxTodos.js";
import { saveCards } from "../../../api/bibleClient.js";
import { refreshOverviewNow } from "../../../workspace/refreshOverview.js";
import { useNavigationStore } from "../../../stores/navigationStore.js";
import { resumeBookReread } from "../../../api/client.js";
import AgentErrorCard from "./AgentErrorCard.js";
import { ChatCapabilityBar, type CapabilityAction } from "./ChatCapabilityBar.js";
import { turnTailSummary } from "./turnTail.js";
import { operationCaption, runningAgentCard } from "./operationCaption.js";
import { ContinuityCheckCard } from "./ContinuityCheckCard.js";
import { DirectionsCard } from "./Brainstorm.js";
import { dismissContinuityItem } from "../../../workspace/continuityActions.js";
import { DraftReviewCard } from "./DraftReviewCard.js";
import { ChatContextMeter } from "./ChatContextMeter.js";
import { ChatSessionBar } from "./ChatSessionBar.js";
import { ChapterTodoCard } from "./ChapterTodoCard.js";
import { useChapterProgress } from "../../../workspace/chapterProgress.js";
import { targetChapterWordsOf } from "./WritingDeskCodex.js";
import type { SuggestedAction } from "../../../type-defs/workflow.js";
import { AiFlavorCard } from "./AiFlavorCard.js";
import { lastAssistantNextStepPrompt, type NextStepPrompt } from "./nextStepChoices.js";
import type { AgentUserAction } from "../../../api/agentChatClient.js";
import { confirmableCommitPreviewMessageId, undoableCommitReportMessageId } from "./commitConfirm.js";
import { commitConfirmAction } from "../../../utils/workflowHelpers.js";
import { latestTurnSuggestedActions, visibleRailActions } from "./suggestedActionRail.js";
import { buildMessageRenderSegments } from "./messageSegments.js";
import { chapterTurns } from "./chapterTurns.js";
import {
  foldProcessSegments,
  isCompletedTurnForProcessFold,
  shouldAggregateProcessBucket,
  type ProcessFoldStep,
} from "./processLogFold.js";
import {
  formatMessageBlocks,
  formatStepElapsed,
  getPlaceholder,
  renderRichText,
  ThinkingIndicator,
  workflowErrorTitle,
} from "./chatRenderShared.js";
import { CommitDeltaCard } from "./CommitDeltaCard.js";
import { QualityCheckCard } from "./QualityCheckCard.js";
import { NameConsistencyCard } from "./NameConsistencyCard.js";
import { StaleThreadCard } from "./StaleThreadCard.js";
import { CommitPreviewCard } from "./CommitPreviewCard.js";
import { openCommitSheet } from "../../../workspace/commitSheet.js";
import { useChatStore } from "../../../stores/chatStore.js";
import { isWorkspaceBusy } from "../../../utils/workspaceOperation.js";
import { useReaderCatchUp, useRefreshWhenRereadDone } from "../../../hooks/useReaderCatchUp.js";

type AiChatCodexProps = WritingWorkspaceLayoutProps & {
  /** 按章号打开一章（已定稿时顶卡的「去第 N 章」）。 */
  readonly onOpenChapter?: (chapter: number) => void;
  /** @ 提及候选：设定本里的人物和地点（WritingWorkspaceCodex 从设定视图拼好传下来）。 */
  readonly mentionNames?: { readonly characters: readonly string[]; readonly locations: readonly string[] };
  readonly rightOpen: boolean;
  readonly onToggleRight: () => void;
  /** 拖动右栏左缘改宽（pointerdown 起拖，宽度状态由外层 codex 壳持有）。 */
  readonly onResizeStart?: (event: ReactPointerEvent) => void;
  /** 双击拖宽手柄：宽度回到默认。 */
  readonly onResizeReset?: () => void;
  /** 非写作页（设定本 / 历史）的输入框提示；写作台不传，按写作进度提示。 */
  readonly composerHint?: string;
  /** 非写作页时快捷条最前面的能力（跟当前页有关）；不传则按本章进度给写作工具。 */
  readonly contextActions?: readonly CapabilityAction[] | null;
  /** 点头部模型标签：打开模型设置（工作区设置弹窗）。 */
  readonly onOpenModelSettings?: () => void;
  /** 变了就重读一次当前模型（设置弹窗关闭时 +1）。 */
  readonly modelRefreshKey?: number;
};

/** 进度行里角色 id → 叫法（和服务端 brain 的角色对应：checker / ledger / planner）。 */
const READER_ROLE_LABELS: Readonly<Record<string, string>> = {
  checker: "核账员",
  ledger: "记账员",
  planner: "章纲员",
};

/**
 * 编辑部「在读前文」进度行（R4.3 验收 3.3）：三个角色一行写全，例如
 * 「编辑部在读前文：核账员 34/58 · 记账员 排队 · 章纲员 排队」。在读的带 done/total（分母和核账回执同口径：
 * 共 y 章（已定稿））；还没轮到的或这次没读成的显示「排队」（下一次开书 / 核账会重排）；读完的划掉；
 * 全读完（reading:false）这行消失。数据：开书概况带初值，在读期间 useReaderCatchUp 每 5 秒轮询轻量接口自走。
 * R5.2：核账 / 拟纲 / 记账在等哪个角色当场补笔记，那个角色后面标「（核账在等它读完）」——走的还是这条轮询链路。
 * R6.2：概况刷新的新初值盖过旧轮询快照（同一次打开里后来的补读也显示）；动作等回包期间也轮询，这行不等回包落地就能现出来。
 */
export function ReadersCatchUpNote({ status, onResumeReread }: {
  readonly status?: ReaderCatchUpStatus | null;
  /** 导入的书通读记账停下了（P8）：点「接着记」。 */
  readonly onResumeReread?: () => Promise<void>;
}) {
  const [resuming, setResuming] = useState<"idle" | "sending" | string>("idle");
  const reread = status?.reread;
  if (reread?.status === "stopped") {
    return (
      <div className="se-checker-reading is-stopped" role="status">
        <span className="se-checker-reading-text">
          记账员记到第 {reread.done}/{reread.total} 章停下了：{reread.stoppedReason ?? "没记上"}
          {resuming !== "idle" && resuming !== "sending" ? `（${resuming}）` : ""}
        </span>
        {onResumeReread ? (
          <button
            className="se-checker-reading-resume"
            disabled={resuming === "sending"}
            onClick={() => {
              setResuming("sending");
              onResumeReread().then(() => setResuming("idle"), (error: unknown) => setResuming(error instanceof Error ? error.message : String(error)));
            }}
            type="button"
          >
            接着记
          </button>
        ) : null}
      </div>
    );
  }
  if (!status?.reading) return null;
  return (
    <div className="se-checker-reading" role="status">
      <span className="se-checker-reading-dot" aria-hidden="true" />
      <span className="se-checker-reading-text">
        编辑部在读前文：
        {status.roles.map((role, index) => {
          const label = READER_ROLE_LABELS[role.role] ?? role.role;
          const finished = !role.reading && role.total > 0 && role.done >= role.total;
          const waitingSuffix = role.reading && role.waiting ? `（${role.waiting}在等它读完）` : "";
          // 导入的书通读记账（P8）：记账员这一行带上还要多久。
          const etaSuffix = role.role === "ledger" && reread?.etaMinutes !== undefined ? `（${formatEta(reread.etaMinutes)}）` : "";
          const text = role.reading || finished ? `${label} ${role.done}/${role.total}${waitingSuffix}${etaSuffix}` : `${label} 排队`;
          return (
            <span key={role.role}>
              {index > 0 ? " · " : ""}
              {finished ? <s className="se-checker-reading-done">{text}</s> : text}
            </span>
          );
        })}
      </span>
    </div>
  );
}

/** 「约 25 分钟」/「约 2 小时」。 */
function formatEta(minutes: number): string {
  return minutes < 60 ? `约 ${minutes} 分钟` : `约 ${Math.round(minutes / 60)} 小时`;
}

/**
 * 「下一步：AI 带路选项」行（从主组件抽出便于单测点击分派）。两档：
 *  1. choice 带 action（服务端生成的确定性选项）→ 直接发结构化动作（body.action，不经模型）；
 *  2. 其余（模型 suggest_next_steps 生成的选项）→ 把 intent 当一句话发给 AI。要定稿的，AI 调定稿只会出「确认定稿」按钮。
 * 不再拿 intent 的措辞认回按钮（重构 P4）。
 */
export function NextStepChoicesRow({ nextStep, busy, onSendMessage, onSendUserAction }: {
  readonly nextStep: NextStepPrompt;
  readonly busy: boolean;
  readonly onSendMessage?: (message: string) => void;
  readonly onSendUserAction?: (action: AgentUserAction) => void;
}) {
  return (
    <div className="nextstep">
      <span className="nextstep-q">{nextStep.question}</span>
      <div className="nextstep-row">
        {nextStep.choices.map((choice) => (
          <button
            key={choice.label}
            type="button"
            className={`nextstep-choice${choice.primary ? " is-primary" : ""}`}
            disabled={busy}
            onMouseMove={trackChoiceLight}
            onClick={() => {
              if (choice.action && onSendUserAction) {
                onSendUserAction(choice.action);
                return;
              }
              onSendMessage?.(choice.intent);
            }}
          >
            <span>{choice.label}{choice.primary ? <em className="nextstep-rec">推荐</em> : null}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * 折叠态竖条。展开 handler 只挂在 aside 上：button 不自带 onClick，点击经冒泡触发一次。
 * （此前 aside+button 双 handler 各自取反，一次点击展开两次=净零，「点按钮等于没点」。）
 */
export function CollapsedAiRail({ onToggleRight }: { readonly onToggleRight: () => void }) {
  return (
    <aside
      className="ai"
      style={{ width: 44, minWidth: 44, alignItems: "center", padding: "16px 0", cursor: "pointer" }}
      onClick={onToggleRight}
      title="展开 AI 写作助手"
    >
      <button
        type="button"
        title="展开 AI 写作助手"
        style={{
          display: "grid",
          placeItems: "center",
          gap: 8,
          border: 0,
          background: "transparent",
          color: "var(--accent-hi)",
          cursor: "pointer",
          writingMode: "vertical-rl",
          letterSpacing: ".2em",
          fontSize: 12,
        }}
      >
        <IconSparkle size={16} />
        <span>AI 助手</span>
      </button>
    </aside>
  );
}

export default function AiChatCodex(props: AiChatCodexProps) {
  // 归档折叠行展开态。
  const [archivedExpanded, setArchivedExpanded] = useState(false);
  const activeArchivedCount = useChatStore((s) => s.activeArchivedCount);
  // 对话直接订阅 chatStore（重构 P5），不再经 App 往下传。
  const messages = useChatStore((s) => s.messages);
  // 这一章的对话（P6 第 6 步）：别的章的轮收成顶上一行，点开看全部；换章自动收回。
  const viewingChapter = props.workspace.currentChapter.chapterNumber;
  const [otherChaptersOpen, setOtherChaptersOpen] = useState(false);
  useEffect(() => setOtherChaptersOpen(false), [viewingChapter]);
  const chapterView = chapterTurns(messages.slice(activeArchivedCount), viewingChapter);
  // 头部模型小标签（读当前默认模型；设置弹窗开关时重读）。
  const { info: activeModel, setupStep } = useActiveModel(props.modelRefreshKey ?? 0);
  // 有动作在跑（聊天回包 / 出稿 / 预览 / 工作台写操作）＝「动作进行中」：先于下面的钩子算好，
  // 传给 useReaderCatchUp——动作等回包期间即使补读没在读也按 5 秒轮询（R6.2），「（核账在等它读完）」一出来就能看到。
  const workspaceBusy = Boolean(
    props.chatLoading
    || props.steeringLoading
    || props.draftActionLoading
    || isWorkspaceBusy(),
  );
  // 编辑部「在读前文」进度（R4.3）：开书概况带初值；任一角色在读时每 5 秒轮询，全读完自动停。
  // R6.2：概况刷新带来的新初值盖过旧轮询结果（同一次打开里后来的补读也显示）；动作进行中（busy）也轮询，回包到了再按 reading 停。
  // 钩子必须在折叠早退之前调（规则不许条件钩子）；没在读时它只是安静地返回 null。
  const readerCatchUp = useReaderCatchUp(props.projectPath, props.overview?.readerCatchUp, workspaceBusy);
  useRefreshWhenRereadDone(props.projectPath, readerCatchUp);
  // 这一章还差什么（顶卡；和稿纸底下的工具条同源）。
  const chapterProgressNow = useChapterProgress(targetChapterWordsOf(props.overview));

  // 智能跟随滚动：贴底才跟新内容滚，翻历史时不打扰。
  const historyRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const handleHistoryScroll = () => {
    const el = historyRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  // IME 守卫（治拼音确认回车被误判成发送）。
  const composingRef = useRef(false);
  const compositionEndedAtRef = useRef(Number.NEGATIVE_INFINITY);
  // @ 引用：末尾正在打「@xxx」时弹候选（角色 / 地点 / 最近章节）。Esc 关掉后直到这段 @ 打完都不再弹。
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionDismissedAt, setMentionDismissedAt] = useState<string | null>(null);
  const mentionQuery = activeMentionQuery(props.steeringDirection);
  const mentionCandidates = mentionQuery === null ? [] : buildMentionCandidates({
    query: mentionQuery,
    characters: props.mentionNames?.characters ?? [],
    locations: props.mentionNames?.locations ?? [],
    chapters: props.workspace.chapters,
  });
  const mentionOpen = mentionCandidates.length > 0 && mentionDismissedAt !== props.steeringDirection;
  const activeMention = Math.min(mentionIndex, Math.max(0, mentionCandidates.length - 1));
  // 「待处理」收件箱：点「让 AI …」只把一句话放进输入框，发不发由你。
  const [inboxOpen, setInboxOpen] = useState(false);
  const inboxTodos = buildInboxTodos({
    chapters: props.workspace.chapters,
    overview: props.overview,
    currentChapterNumber: props.workspace.currentChapter.chapterNumber,
    rereading: readerCatchUp?.reread !== undefined,
  });
  useEffect(() => {
    if (!inboxOpen) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setInboxOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inboxOpen]);
  const prefillComposer = (text: string) => {
    props.onSteeringDirectionChange(text);
    setInboxOpen(false);
    requestAnimationFrame(() => {
      const el = composerRef.current;
      if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
    });
  };
  // 带 ops 的待办（还没标主角）点了直接改设定本：作者档、可撤销，不经模型；没改成就在这儿如实说。
  const [inboxError, setInboxError] = useState<string | null>(null);
  const [inboxSaving, setInboxSaving] = useState(false);
  const runInboxTodo = (todo: InboxTodo) => {
    const projectPath = props.projectPath;
    if (!todo.ops || !projectPath) {
      prefillComposer(todo.prefill);
      return;
    }
    setInboxSaving(true);
    setInboxError(null);
    void saveCards(projectPath, todo.ops).then(async (result) => {
      if (result.ok) {
        await refreshOverviewNow(projectPath);
        setInboxOpen(false);
      } else {
        setInboxError(result.error);
      }
      setInboxSaving(false);
    });
  };
  const pickMention = (label: string) => {
    props.onSteeringDirectionChange(insertMention(props.steeringDirection, label));
    setMentionIndex(0);
    requestAnimationFrame(() => {
      const el = composerRef.current;
      if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
    });
  };
  // 「动作进行中」的判断已上移到 useReaderCatchUp 调用之前（workspaceBusy，R6.2），这里直接用。
  const chatEnabled = Boolean(props.onSendMessage) && !workspaceBusy;
  const sendCurrent = () => {
    const message = props.steeringDirection.trim();
    if (!chatEnabled || !message) return;
    props.onSendMessage?.(message);
    props.onSteeringDirectionChange("");
  };

  // rightOpen：收起（含专注模式）再展开时对话区是新挂上的、停在最顶，贴底的照样滚回底。
  useEffect(() => {
    if (!atBottomRef.current) return;
    const el = historyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, props.chatLoading, props.steeringLoading, props.steeringDraft, props.draftAIReview, props.activeRevisionTask, props.chatError, props.steeringError, props.rightOpen]);

  // 折叠态：整列只渲染一个极简竖条（点击展开）。codex.css 没有专用 class，用最小内联（codex 变量调色）。
  if (!props.rightOpen) {
    return <CollapsedAiRail onToggleRight={props.onToggleRight} />;
  }


  const { flowStatus } = props.workspace;
  const busy = workspaceBusy;
  // 「下一步」选项：优先用 agent 主动提议的（suggest_next_steps，贴合上下文，和 agent 的话一致）；
  // 「下一步」选项卡只在 agent 主动调 suggest_next_steps 给出上下文相关提议时出现——已删掉按 flowStatus 写死的兜底
  // （那套死选项不看你这章具体情况、还会和 agent 正文打架，正是 suggest_next_steps 当初要治的病）。
  // agent 没提议的回合就不出卡，顺着它正文走或直接打字即可。点选项=给 agent 发一句意图。
  const nextStep = busy ? null : lastAssistantNextStepPrompt(messages);
  // 「建议动作」条（A-6）：最后一轮消息上挂着的 suggestedActions（重新确认定稿/撤销本次修改/确认写入资料…）。
  // 忙碌时不渲染（回合进行中不可点；回合结束自然浮现）。retry-agent 不进条——错误气泡内已有就地重试。
  const railActions = busy ? [] : visibleRailActions(latestTurnSuggestedActions(messages));
  // 「确认定稿」按钮只挂在最新一张未用掉的定稿预览卡上（见 commitConfirm.ts）。
  const confirmablePreviewId = confirmableCommitPreviewMessageId(messages);
  // 「撤销这次定稿」只挂在最近一次改动就是定稿的那张回执上（见 commitConfirm.ts）。
  const undoableCommitId = undoableCommitReportMessageId(messages);
  const canClear = Boolean(props.onClearChat) && messages.length > 0 && !workspaceBusy;
  // 顶卡忙的时候主按钮上说正在干什么（原状态行的实时字幕）。
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  const busyCaption = busy
    ? operationCaption(props.draftActionLoading)
      ?? runningStepCaption(lastAssistant?.toolSteps?.find((step) => step.status === "running")?.label)
      ?? "AI 在忙…"
    : null;

  return (
    <aside className="ai" aria-label="AI 写作助手">
      {/* ── 左缘拖拽手柄：拖动调整对话列宽度 ── */}
      {props.onResizeStart ? (
        <div
          className="ai-resize"
          onPointerDown={props.onResizeStart}
          onDoubleClick={props.onResizeReset}
          role="separator"
          aria-orientation="vertical"
          aria-label="拖动调整对话宽度"
          title="拖动调整宽度，双击还原"
        />
      ) : null}
      {/* ── 头部一行（P6）：会话名（点开历史，清空、记忆上限也在那里）+ 新建 + 模型 + 收起 ── */}
      <div className="ai-head se-ai-head">
        <ChatSessionBar {...(canClear && props.onClearChat ? { onClear: props.onClearChat } : {})} />
        {setupStep ? (
          <button type="button" className="se-model-chip" title="还没接上 AI（点开模型设置）" onClick={() => props.onOpenModelSettings?.()}>
            <span className="se-dot warn" aria-hidden="true" />
            <span className="se-model-name">没接 AI</span>
          </button>
        ) : activeModel ? (
          <button
            type="button"
            className="se-model-chip"
            title={activeModel.ok ? `当前模型：${activeModel.label}（点开模型设置）` : `模型设置有问题：${activeModel.label}（点开查看）`}
            onClick={() => props.onOpenModelSettings?.()}
          >
            <span className={`se-dot ${activeModel.ok ? "ok" : "warn"}`} aria-hidden="true" />
            <span className="se-model-name">{activeModel.label}</span>
          </button>
        ) : null}
        <button type="button" className="se-icon-btn sm" onClick={props.onToggleRight} title="收起" aria-label="收起 AI 助手">
          <IconClose size={16} />
        </button>
      </div>

      {/* ── 还没接上 AI（P11）：新用户第一次打开就在这儿说清楚，别等点了按钮才报错 ── */}
      {setupStep ? (
        <section className="se-setup-card" aria-label="还没接上 AI">
          <div className="se-setup-main">
            <h3 className="se-setup-title">{setupStep === "connect" ? "先接上 AI" : "还差一步：选个模型"}</h3>
            <p className="se-setup-text">
              {setupStep === "connect"
                ? "选一家服务商、填上密钥，大约两分钟。不接也能自己写、建设定卡、导出。"
                : "服务商接好了。在模型设置里测一下连接、点一个模型，所有功能就都用它。"}
            </p>
          </div>
          <button type="button" className="se-setup-btn" onClick={() => props.onOpenModelSettings?.()}>{setupStep === "connect" ? "去接上" : "去选"}</button>
        </section>
      ) : null}

      {/* ── 顶卡（P6）：这一章还差什么 + 一个主按钮；下面一行小字是编辑部读前文、不急的事 ── */}
      <ChapterTodoCard
        progress={chapterProgressNow}
        busy={busy}
        busyCaption={busyCaption}
        onChapterButton={props.onChapterButton}
        {...(props.onOpenChapter ? { onOpenChapter: props.onOpenChapter } : {})}
      >
        <ReadersCatchUpNote status={readerCatchUp} {...(props.projectPath ? { onResumeReread: () => resumeBookReread(props.projectPath as string) } : {})} />
        {inboxTodos.length > 0 ? (
          <div className="se-todo-more">
            <button
              type="button"
              className="se-todo-more-btn"
              aria-expanded={inboxOpen}
              onClick={() => setInboxOpen((open) => !open)}
            >
              另有 {inboxTodos.length} 件不急的事
            </button>
            {inboxOpen ? (
              <div className="se-inbox-pop" role="dialog" aria-label="不急的事">
                <div className="se-inbox-h">
                  <span>这些不急，但别忘了</span>
                  <button type="button" className="se-icon-btn sm" aria-label="关闭" onClick={() => setInboxOpen(false)}><IconClose size={14} /></button>
                </div>
                {inboxTodos.map((todo) => (
                  <div key={todo.key} className="se-todo">
                    <div className="se-todo-tx">{todo.title}<span title={todo.sub}>{todo.sub}</span></div>
                    <button
                      type="button"
                      className="se-todo-act"
                      disabled={todo.ops && props.projectPath ? busy || inboxSaving : !chatEnabled}
                      title={todo.ops && props.projectPath ? "直接改设定本，可在操作历史里撤销" : `把「${todo.prefill}」放进输入框（不会自动发送）`}
                      onClick={() => runInboxTodo(todo)}
                    >
                      {todo.action}
                    </button>
                  </div>
                ))}
                {inboxError ? <p className="se-todo-err" role="alert">{inboxError}</p> : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </ChapterTodoCard>

      {/* ── 消息流（智能跟随滚动） ── */}
      {/* is-thinking：生成期间底部留白，避免「正在思考」浮层盖住正在流式输出的文字。 */}
      <div className={`ai-body${props.chatLoading ? " is-thinking" : ""}`} ref={historyRef} onScroll={handleHistoryScroll}>
        {/* ── 归档折叠行：顶部显示「已清理 N 条早先消息」（可点展开只读回看） ── */}
        {activeArchivedCount > 0 ? (
          <div
            className="codex-archived-fold"
            role="button"
            tabIndex={0}
            onClick={() => setArchivedExpanded((v) => !v)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setArchivedExpanded((v) => !v); }}
          >
            {archivedExpanded ? `收起已清理的 ${activeArchivedCount} 条早先消息` : `已清理 ${activeArchivedCount} 条早先消息 · 点开回看`}
          </div>
        ) : null}
        {/* 展开归档段：只读显示 slice(0, activeArchivedCount) */}
        {archivedExpanded && activeArchivedCount > 0 ? (
          <div className="codex-archived-messages">
            {messages.slice(0, activeArchivedCount).map((message) => (
              <MessageBubbles
                key={`archived-${message.id}`}
                message={message}
                chatLoading={workspaceBusy}
              />
            ))}
          </div>
        ) : null}
        {/* 主消息流：裁掉已归档前缀（activeArchivedCount 是归档偏移量，与
            ChatContextMeter/buildOutboundConversation 同一口径）。修前未裁 →
            「清理早先消息」后消息仍在、展开后同 N 条渲染两遍（2026-09-15 审计 P1-2） */}
        {chapterView.hiddenTurns > 0 ? (
          <button type="button" className="codex-archived-fold se-other-chapters" aria-expanded={otherChaptersOpen} onClick={() => setOtherChaptersOpen((v) => !v)}>
            {otherChaptersOpen ? "收起别的章的对话" : `别的章的对话 ${chapterView.hiddenTurns} 轮 · 点开`}
          </button>
        ) : null}
        {messages.slice(activeArchivedCount).map((message, index, all) => {
          if (!otherChaptersOpen && chapterView.hidden.has(message.id)) return null;
          const isLatestAssistant = message.role === "assistant"
            && !all.slice(index + 1).some((m) => m.role === "assistant");
          const isLiveAssistant = Boolean(props.chatLoading) && isLatestAssistant;
          return (
          // 较早回复里的卡片（定稿明细 / 线索提醒 / 审稿…）默认收起成一行，只有最新一条回复的卡片展开。
          <StepCardCollapsedByDefault.Provider key={message.id} value={message.role === "assistant" && !isLatestAssistant}>
          <MessageBubbles
            message={message}
            chatLoading={workspaceBusy}
            isLiveAssistant={isLiveAssistant}
            {...(props.onOpenModelSettings ? { onOpenSettings: props.onOpenModelSettings } : {})}
            onUndoToHere={props.onUndoToTurn ? () => props.onUndoToTurn?.(message) : undefined}
            onPrefillComposer={prefillComposer}
            liveOperation={index === all.length - 1 ? operationCaption(props.draftActionLoading) : null}
            isLatestMessage={index === all.length - 1}
            onFixAiFlavorViolation={props.onFixAiFlavorViolation}
            onFixAllAiFlavorViolations={props.onFixAllAiFlavorViolations}
            pendingViolationId={props.aiFlavorPending?.messageId === message.id ? props.aiFlavorPending.violationId : null}
            aiFlavorAwaitingApply={props.aiFlavorPending?.messageId === message.id && Boolean(props.activeRevisionPreview)}
            batchPendingForThisCard={props.aiFlavorBatchPending === message.id}
            onSendMessage={props.onSendMessage}
            onSendUserAction={props.onSendUserAction}
            onSuggestedAction={props.onSuggestedAction}
            commitConfirmable={message.id === confirmablePreviewId}
            commitUndoable={message.id === undoableCommitId}
            projectPath={props.projectPath ?? null}
          />
          </StepCardCollapsedByDefault.Provider>
          );
        })}

        {shouldShowEmptyState(props, messages) ? (
          <div style={surfaceCardStyle}>
            <strong style={{ color: "var(--text)", fontSize: 13 }}>可以直接描述下一章方向</strong>
            <p style={{ margin: "6px 0 0", color: "var(--muted)", fontSize: 12.5 }}>我会先帮你生成承接建议或工作稿。</p>
            {props.canUndoClearChat && props.onUndoClearChat ? (
              <button type="button" className="chip" style={{ marginTop: 10 }} onClick={() => props.onUndoClearChat?.()}>
                撤销清空，恢复刚才的对话
              </button>
            ) : null}
          </div>
        ) : null}

        {props.steeringDraft ? <SteeringDraftCard draft={props.steeringDraft} /> : null}
        {/* 审稿卡不再在这里常驻渲染（旧实现一直钉底部吃视口）——已改为随对应 assistant 消息走，见 MessageBubbles。 */}
        {/* 体检卡不再在这里常驻渲染（旧实现一直钉底部）——已改为随对应 assistant 消息走，见 MessageBubbles。 */}
        {/* 选区改写预览不再在聊天里渲染——已移到写作区下方独立弹窗（见 RevisionPreviewModal）。 */}

        {props.steeringError ? <NoticeCard title={workflowErrorTitle(flowStatus)} text={props.steeringError} danger /> : null}
        {props.chatError ? <NoticeCard title="章节对话失败" text={props.chatError} danger /> : null}
        {props.steeringLoading ? <NoticeCard title="正在拟章纲" text="正在读前文，拟这一章的章纲。" /> : null}
      </div>

      {/* ── 下一步：AI 带路选项 ── 点选项=给 agent 发一句意图（对话里留「你：…」、再由 agent 接着做）；
          引导≠强制：可直接打字无视。idle/进行态不出（空态卡/思考浮层自有提示）。 */}
      {nextStep && props.onSendMessage && !workspaceBusy ? (
        <NextStepChoicesRow
          nextStep={nextStep}
          busy={busy}
          onSendMessage={props.onSendMessage}
          onSendUserAction={props.onSendUserAction}
        />
      ) : null}

      {/* ── 上下文提示条（消息列表与输入框之间） ──
          「正在思考」胶囊挂在这一段的顶上（浮在消息流底部留出的空当里），不再压住下面的快捷按钮。 */}
      <div className="se-ai-dock-anchor">
        {props.chatLoading ? (
          <div className="se-v2-thinking-dock">
            <ThinkingIndicator />
          </div>
        ) : null}
      </div>
      <ChatContextMeter />

      {/* ── 不在写作台（设定本 / 历史）时，跟当前页有关的能力照旧给一排 ── */}
      {props.contextActions ? (
        <ChatCapabilityBar onSendMessage={props.onSendMessage} onChapterButton={props.onChapterButton} disabled={workspaceBusy} leading={props.contextActions} leadingOnly />
      ) : null}

      {/* ── 建议动作条（A-6）：和「下一步」合成一条——有下一步选项就只出它，没有才出建议动作。 ── */}
      {railActions.length > 0 && props.onSuggestedAction && !(nextStep && props.onSendMessage) ? (
        <div className="suggest" aria-label="建议动作">
          {railActions.map((action) => (
            <button
              key={`${action.id}::${action.endpoint ?? ""}`}
              type="button"
              className="chip"
              disabled={Boolean(action.disabledReason)}
              title={action.disabledReason ?? uiText(action.description)}
              onClick={() => props.onSuggestedAction?.(action)}
            >
              {uiText(action.label)}
            </button>
          ))}
        </div>
      ) : null}

      {/* ── 输入区 ── */}
      <div style={{ position: "relative" }}>
        {mentionOpen ? (
          <div className="se-mention" role="listbox" aria-label="引用角色、地点或章节">
            <div className="se-mention-h">引用角色、地点或章节 · ↑↓ 选，回车插入</div>
            {mentionCandidates.map((c, i) => (
              <button
                key={`${c.kind}:${c.label}`}
                type="button"
                role="option"
                aria-selected={i === activeMention}
                className={i === activeMention ? "on" : ""}
                onMouseDown={(event) => { event.preventDefault(); pickMention(c.label); }}
                onMouseMove={() => { if (i !== activeMention) setMentionIndex(i); }}
              >
                <span className="se-mention-label">{c.label}</span>
                <span className="se-mention-kind">{c.kind}</span>
              </button>
            ))}
          </div>
        ) : null}
        <div className="composer" style={{ alignItems: "flex-end" }}>
          {/* 其余能力（内容审阅、检查机器腔、补资料、整理……）收进输入框左边的「更多」（P6：不再单占一条）。 */}
          {!props.contextActions ? (
            <ChatCapabilityBar variant="menu" onSendMessage={props.onSendMessage} onChapterButton={props.onChapterButton} disabled={workspaceBusy} />
          ) : null}
          <textarea
            ref={composerRef}
            className="ai-composer-input"
            disabled={!chatEnabled}
            value={props.steeringDirection}
            onChange={(event) => { props.onSteeringDirectionChange(event.target.value); setMentionIndex(0); }}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={() => {
              composingRef.current = false;
              compositionEndedAtRef.current = performance.now();
            }}
            onKeyDown={(event) => {
              if (mentionOpen && !event.nativeEvent.isComposing && !composingRef.current) {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const step = event.key === "ArrowDown" ? 1 : -1;
                  setMentionIndex((activeMention + step + mentionCandidates.length) % mentionCandidates.length);
                  return;
                }
                if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
                  event.preventDefault();
                  const picked = mentionCandidates[activeMention];
                  if (picked) pickMention(picked.label);
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setMentionDismissedAt(props.steeringDirection);
                  return;
                }
              }
              if (!shouldSendOnEnterKey({
                key: event.key,
                shiftKey: event.shiftKey,
                isComposing: event.nativeEvent.isComposing,
                keyCode: event.keyCode,
                composing: composingRef.current,
                msSinceCompositionEnd: performance.now() - compositionEndedAtRef.current,
              })) return;
              event.preventDefault();
              sendCurrent();
            }}
            placeholder={
              props.composerHint && !props.chatLoading && !isBookCreationGreeting(messages)
                ? props.composerHint
                : getPlaceholder(flowStatus, isBookCreationGreeting(messages))
            }
            rows={3}
            style={composerInputStyle}
          />
          {props.chatLoading && props.onStopAgent ? (
            <button
              type="button"
              className="send"
              onClick={() => props.onStopAgent?.()}
              title="停止本次生成（已写出的内容保留）"
              aria-label="停止"
              data-stop="true"
            >
              <IconStop size={16} />
            </button>
          ) : (
            <button
              type="button"
              className="send"
              disabled={!chatEnabled || !props.steeringDirection.trim()}
              onClick={sendCurrent}
              title="发送"
              aria-label="发送"
              style={!chatEnabled || !props.steeringDirection.trim() ? { opacity: 0.5, cursor: "not-allowed" } : undefined}
            >
              <IconArrowUp size={16} strokeWidth={2} />
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}

const surfaceCardStyle: React.CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--line)",
  borderRadius: 14,
  padding: "12px 14px",
  marginBottom: 10,
};

/** 「下一步」选项的鼠标跟手光斑：把指针在按钮内的坐标写进 --mx/--my，CSS 用它定位金色径向光。 */
function trackChoiceLight(event: React.MouseEvent<HTMLButtonElement>): void {
  const rect = event.currentTarget.getBoundingClientRect();
  event.currentTarget.style.setProperty("--mx", `${event.clientX - rect.left}px`);
  event.currentTarget.style.setProperty("--my", `${event.clientY - rect.top}px`);
}

const composerInputStyle: React.CSSProperties = {
  flex: 1,
  resize: "none",
  border: 0,
  background: "transparent",
  color: "var(--text)",
  fontSize: 14,
  lineHeight: 1.65,
  minHeight: 62,
  outline: "none",
  fontFamily: "inherit",
};

/** 点「审校问题·改这处」→ 拼一句给 agent 的改写意图（agent 据纪律 5.5 先 read_draft 定位逐字原文再 revise）。 */
function buildReviseIntent(issue: DraftReviewIssueView): string {
  // 不猜白名单：切句
  const trimDot = (s: string) => s.replace(/[。.]+\s*$/u, ""); // 去段尾句号，免与拼接的「。」叠成双句号
  const parts = [`针对内容审阅发现的问题改一下——【${issue.title}】${trimDot(issue.description)}`];
  if (issue.evidence) parts.push(`原句：「${issue.evidence}」`);
  if (issue.suggestedFix) parts.push(`建议：${trimDot(issue.suggestedFix)}`);
  return `${parts.join("。")}。`;
}

/** 正在跑的那一步工具的叫法（按真实工具说，别按阶段笼统说——预览定稿时说「正在定稿」会吓人）。 */
const RUNNING_STEP_WORDS: Readonly<Record<string, string>> = {
  "定稿影响预览": "生成定稿预览",
};

function runningStepCaption(step: string | undefined): string | null {
  return step ? `正在${RUNNING_STEP_WORDS[step] ?? step}…` : null;
}

// ─────────────────────────── 消息气泡 ───────────────────────────

function MessageBubbles({
  message,
  chatLoading,
  isLiveAssistant = false,
  onUndoToHere,
  onFixAiFlavorViolation,
  onFixAllAiFlavorViolations,
  pendingViolationId = null,
  aiFlavorAwaitingApply = false,
  batchPendingForThisCard = false,
  onSendMessage,
  onSendUserAction,
  onSuggestedAction,
  commitConfirmable = false,
  commitUndoable = false,
  onPrefillComposer,
  liveOperation = null,
  isLatestMessage = true,
  projectPath = null,
  onOpenSettings,
}: {
  readonly message: ChapterMessage;
  readonly chatLoading: boolean;
  /** 本条是否为当前流式进行中的助手消息（进行中不聚合过程步）。 */
  readonly isLiveAssistant?: boolean;
  readonly onUndoToHere?: () => void;
  readonly onFixAiFlavorViolation?: (violation: AiFlavorViolation, messageId: string) => void;
  readonly onFixAllAiFlavorViolations?: (violations: readonly AiFlavorViolation[], messageId: string) => void;
  readonly pendingViolationId?: string | null;
  /** 那条 pending 的改写草案是否已生成、等用户去写作台应用（→ 卡上显「待应用」而非「改写中…」）。 */
  readonly aiFlavorAwaitingApply?: boolean;
  readonly batchPendingForThisCard?: boolean;
  /** 点「审校问题」卡的「改这处」=给 agent 发一句改写意图（chat 驱动）。 */
  readonly onSendMessage?: (content: string) => void;
  /** 结构化动作直达（核账「改这处」按钮直接改，不经模型）。 */
  readonly onSendUserAction?: (action: AgentUserAction) => void;
  readonly onSuggestedAction?: (action: SuggestedAction) => void;
  /** 本条的定稿预览卡是否挂「确认定稿」按钮（最新一张未用掉的预览才挂）。 */
  readonly commitConfirmable?: boolean;
  /** 本条的定稿回执是否挂「撤销这次定稿」（最近一次改动就是这次定稿才挂）。 */
  readonly commitUndoable?: boolean;
  /** 把一句话填进输入框（不发送），如定稿预览卡的「先不定」。 */
  readonly onPrefillComposer?: (text: string) => void;
  /** 本条是最新消息、且有不走对话的操作在跑时的说明（审稿/质检…）；其余为 null。 */
  readonly liveOperation?: string | null;
  /** 是不是对话里最后一条（旧的出错卡不再给「重试」——后面已经重试过/往下走了，再点会重复跑）。 */
  readonly isLatestMessage?: boolean;
  /** 当前书目录（核账卡「不是问题」存盘用）。 */
  readonly projectPath?: string | null;
  /** 出错卡的「去设置」（没接上 AI、密钥不对时）。 */
  readonly onOpenSettings?: () => void;
}) {
  if (message.role === "system") {
    // 不走对话的操作挂的进行中卡：在跑就显示「正在…」，不在跑了（上次关页/刷新打断）就如实说没做完。
    const running = runningAgentCard(message.agentCards);
    if (!running) return null;
    return liveOperation ? (
      <div className="msg msg-ai se-op-row is-running" role="status">
        <span className="se-op-dot" aria-hidden="true" />
        <span>{liveOperation}…</span>
      </div>
    ) : (
      <div className="msg msg-ai se-op-row">
        <span>{stripRunningSuffix(running.title)}没做完（中途关掉或刷新了），可以再来一次。</span>
      </div>
    );
  }

  if (message.role === "user") {
    const blocks = formatMessageBlocks(message.content);
    return (
      <div className="msg msg-user">
        <div className="msg-body">
          {blocks.length ? <MessageBlocksView blocks={blocks} /> : message.content}
        </div>
      </div>
    );
  }

  // P0-1：结构化错误卡（勿靠文案 startsWith 猜）。
  const errorCard = cardOf(message, "error");
  if (errorCard) {
    const retry = (message.suggestedActions ?? []).find((a) => a.id === "retry-agent") ?? null;
    return (
      <div className="msg msg-ai">
        <AgentErrorCard
          detail={errorCard.detail || message.content}
          {...(errorCard.reason ? { reason: errorCard.reason } : {})}
          {...(onOpenSettings ? { onOpenSettings } : {})}
          retryAction={isLatestMessage ? retry : null}
          chatLoading={chatLoading}
          onRetry={onSuggestedAction}
        />
      </div>
    );
  }

  // assistant
  const model = buildTimelineModel(message);
  const toolSteps = (message.toolSteps ?? []) as readonly ToolStep[];
  const contentBlocks = message.content.trim() ? formatMessageBlocks(message.content) : [];
  const commitPreview = cardOf(message, "commit-preview")?.preview;
  // 注：suggestedActions 不再计入「这条气泡有没有东西」——它们已统一移到 composer 上方的建议条。
  const hasAnything = message.content.trim().length > 0
    || toolSteps.length > 0
    || (message.agentCards?.length ?? 0) > 0
    || (message.cards?.length ?? 0) > 0
    || Boolean(message.thinking?.trim());
  // 流式开始前的空占位助手气泡不渲染。
  if (!hasAnything) return null;

  const canUndo = Boolean(onUndoToHere) && (model?.canUndo ?? false);
  const canCopy = !isLiveAssistant && message.content.trim().length > 0;
  // 思考「进行中」=本轮还在流、答案与工具都还没出现（此时思考字上跑光影；一旦出工具/答案即静止）。
  const thinkingActive = chatLoading && !message.content.trim() && toolSteps.length === 0;
  // 有序分段：把「想→调工具→再想→答」按真实时间顺序逐段渲染（治「工具堆顶部、后续思考看不见」）。
  // 旧消息无 segments → renderSegments 为 null → 回退原「思考折叠→工具→正文」三桶渲染。
  const renderSegments = buildMessageRenderSegments(message);
  // P1-9：已完成轮次把多条过程步聚成「AI 操作记录 · N 步」；进行中保持逐步金光。
  const aggregateProcess = isCompletedTurnForProcessFold(chatLoading, isLiveAssistant);
  const folded = renderSegments
    ? foldProcessSegments(renderSegments, { aggregate: aggregateProcess })
    : null;
  const firstTextIndex = folded ? folded.findIndex((seg) => seg.kind === "text") : -1;
  // 模型做完事没再说话就结束时，补一句最后那步工具的原话结果（见 turnTail.ts）。
  const tailSummary = turnTailSummary(folded, !isLiveAssistant);
  const bucketAggregate = shouldAggregateProcessBucket(
    message.thinking,
    toolSteps.length,
    aggregateProcess,
  );

  const statusNotes = cardOf(message, "status-notes")?.notes;
  // 卡片按 type 分发渲染，按固定次序排（布局稳定，不随工具先后跳）；状态说明在最上面单独渲染。
  const orderedCards = [...(message.cards ?? [])]
    .filter((card) => card.type !== "status-notes" && card.type !== "error")
    .sort((a, b) => CARD_ORDER.indexOf(a.type) - CARD_ORDER.indexOf(b.type));
  const renderCard = (card: MessageCard) => {
    switch (card.type) {
      case "ai-flavor":
        // 去 AI 味体检卡：随这条消息走（不再钉底部）。已改的违规标「已改 ✓」、与左侧正文黄高亮联动。
        return (
          <AiFlavorCard
            key={card.type}
            report={card.report}
            fixedIds={card.fixedIds}
            pendingViolationId={pendingViolationId}
            awaitingApply={aiFlavorAwaitingApply}
            batchPending={batchPendingForThisCard}
            onFix={onFixAiFlavorViolation ? (v) => onFixAiFlavorViolation(v, message.id) : undefined}
            onFixAll={onFixAllAiFlavorViolations ? (vs) => onFixAllAiFlavorViolations(vs, message.id) : undefined}
          />
        );
      case "draft-review":
        // AI 审稿问题清单卡：点「改这处」=给 agent 发改写意图（chat 驱动·唯一控制面），由 agent 先 read_draft 定位再 revise。
        return (
          <DraftReviewCard
            key={card.type}
            report={card.review}
            onRevise={onSendMessage ? (issue) => onSendMessage(buildReviseIntent(issue)) : undefined}
          />
        );
      case "continuity":
        // 核账卡：本章原句 ↔ 前文原句，确定的列出、可能的收起；「改这处」给 agent 发只改这一处的意图。
        return (
          <ContinuityCheckCard
            key={card.type}
            check={card.check}
            dismissed={card.dismissed ?? []}
            onRevise={onSendMessage}
            onFixAction={onSendUserAction}
            onDismiss={projectPath ? (item, undo) => dismissContinuityItem({ messageId: message.id, chapter: card.check.chapter, item, undo }) : undefined}
          />
        );
      case "quality":
        // 质检明细卡：blocking 硬伤突出、soft 软提示默认折叠（防噪音），紧靠审校。
        return <QualityCheckCard key={card.type} report={card.report} />;
      case "commit-preview":
        // 定稿预览卡（R3）：commit_preview 的结构化裁决照实展示，不靠模型转述（模型可能把硬阻断说软/略过）。
        return (
          <CommitPreviewCard
            key={card.type}
            preview={card.preview}
            confirmable={commitConfirmable}
            onOpen={() => openCommitSheet(message.id)}
          />
        );
      case "name-drift":
        // 人物名一致性提醒卡：入库预览报出近形错名时固定醒目展示，不靠模型转述、不被说软。
        return card.warnings.length ? <NameConsistencyCard key={card.type} warnings={card.warnings} /> : null;
      case "stale-threads":
        // 伏笔/线索待收口提醒卡：入库预览报出久未推进的伏笔/线索时固定醒目展示，治「埋了不收」的遗漏。
        return card.warnings.length ? <StaleThreadCard key={card.type} warnings={card.warnings} /> : null;
      case "commit-report":
        // 入库 delta 卡：这章正式入库改了哪些角色/伏笔/线索/时间线/主线目标，随消息走。
        return (
          <CommitDeltaCard
            key={card.type}
            report={card.report}
            onUndo={canUndo && commitUndoable ? onUndoToHere : undefined}
            undoDisabled={chatLoading}
          />
        );
      case "directions":
        // 头脑风暴走法卡：对话里只列名字，挑在稿纸上方（BrainstormPanel）。
        return <DirectionsCard key={card.type} messageId={message.id} data={card.brainstorm} {...(card.picked !== undefined ? { picked: card.picked } : {})} />;
      case "next-steps":
        // 「下一步」选项在 composer 上方渲染（lastAssistantNextStepPrompt），气泡内不重复。
        return null;
      default:
        return null;
    }
  };

  return (
    <div className="msg msg-ai" data-message-id={message.id}>
      {/* R4：服务端状态说明（如历史窗口被裁剪）照实展示，不静默吞掉；不进助手正文。 */}
      {statusNotes?.length ? (
        <div className="msg-status-notes">
          {statusNotes.map((note, index) => (
            <p className="msg-status-note" key={`status-${index}`}>{note}</p>
          ))}
        </div>
      ) : null}
      {folded ? (
        folded.map((seg, index) => {
          if (seg.kind === "process") {
            return <ProcessLogAggregate key={`seg-p-${index}`} steps={seg.steps} />;
          }
          if (seg.kind === "reasoning") {
            // 尾段思考 + 仍在流 = 当前正在想的那段，跑金光；其余历史思考静止。
            const active = chatLoading && isLiveAssistant && index === folded.length - 1;
            return <ThinkingDisclosure key={`seg-r-${index}`} thinking={seg.text.trim()} active={active} />;
          }
          if (seg.kind === "tool") {
            return <ToolStepFold key={`seg-t-${seg.step.id}`} step={seg.step} />;
          }
          const blocks = formatMessageBlocks(seg.text);
          if (!blocks.length) return null;
          return (
            <div className="msg-body" key={`seg-x-${index}`}>
              <MessageBlocksView blocks={blocks} lead={index === firstTextIndex} />
            </div>
          );
        })
      ) : (
        <>
          {bucketAggregate ? (
            <ProcessLogAggregate
              steps={[
                ...(message.thinking?.trim()
                  ? [{ kind: "reasoning" as const, text: message.thinking.trim() }]
                  : []),
                ...toolSteps.map((step) => ({ kind: "tool" as const, step })),
              ]}
            />
          ) : (
            <>
              {/* 回退：思考过程默认收起一行；进行中字上跑光影 */}
              {message.thinking?.trim() ? <ThinkingDisclosure thinking={message.thinking.trim()} active={thinkingActive} /> : null}
              {/* 回退：调用工具一行（调用工具 · 工具名），运行中跑光影，点开看执行详情 */}
              {toolSteps.map((step) => <ToolStepFold key={step.id} step={step} />)}
            </>
          )}
          {/* 回退：正文裸文字平铺，无气泡框 */}
          {contentBlocks.length ? (
            <div className="msg-body">
              <MessageBlocksView blocks={contentBlocks} lead />
            </div>
          ) : null}
        </>
      )}

      {tailSummary ? <p className="se-turn-tail">{tailSummary}</p> : null}

      {orderedCards.map(renderCard)}

      {/* 「建议动作」统一在 composer 正上方的建议条渲染（latestTurnSuggestedActions + .suggest），气泡内不再渲染。 */}

      {/* 回复下方的小动作（悬停才显）：复制回复文字 / 撤销到此。 */}
      {(canCopy || canUndo || message.tokenUsage) ? (
        <div className="se-msg-acts">
          {canCopy ? (
            <button
              type="button"
              title="复制这条回复的文字"
              onClick={() => {
                void navigator.clipboard?.writeText(message.content.trim())
                  .then(() => useNavigationStore.getState().showToast("已复制这条回复", 2400))
                  .catch(() => useNavigationStore.getState().showToast("复制没成功：浏览器没给剪贴板权限", 4200));
              }}
            >
              <IconCopy size={13} />复制
            </button>
          ) : null}
          {canUndo ? (
            <button
              type="button"
              disabled={chatLoading}
              onClick={onUndoToHere}
              title="把这回合的改动整块回退，并截断这之后的对话"
            >
              <IconUndo size={13} />撤销到此
            </button>
          ) : null}
          {message.tokenUsage && message.tokenUsage.input > 0 ? (
            <span className="se-msg-usage" title="这一轮用了多少 token（对话 AI 加上写章纲、出稿、核对等内部调用）；命中缓存的部分服务商通常只收一成左右">
              {formatWan(message.tokenUsage.input + message.tokenUsage.output)} · 缓存 {formatWan(message.tokenUsage.cachedInput)}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** 「15.5 万」：作者看得懂的量级。 */
function formatWan(value: number): string {
  return value >= 10000 ? `${(value / 10000).toFixed(1)} 万` : String(value);
}

/** 卡片在气泡里的固定次序。 */
const CARD_ORDER: readonly MessageCard["type"][] = [
  "ai-flavor",
  "draft-review",
  "continuity",
  "directions",
  "quality",
  "commit-preview",
  "name-drift",
  "stale-threads",
  "commit-report",
  "next-steps",
];

/** message 段落/列表/表格渲染。lead=把第一段首句套金色 .lead。 */
function MessageBlocksView({ blocks, lead }: { readonly blocks: ReturnType<typeof formatMessageBlocks>; readonly lead?: boolean }) {
  return (
    <>
      {blocks.map((block, index) => {
        if (block.kind === "list") {
          return (
            <ul key={index} style={{ margin: "4px 0", paddingLeft: 18 }}>
              {block.items.map((item) => <li key={item}>{renderRichText(item)}</li>)}
            </ul>
          );
        }
        if (block.kind === "table") {
          return (
            <div key={index} style={{ overflowX: "auto", margin: "6px 0" }}>
              <table style={{ borderCollapse: "collapse", fontSize: 11.5, width: "100%" }}>
                <thead>
                  <tr>{block.headers.map((cell, cellIndex) => (
                    <th key={`${cell}-${cellIndex}`} style={{ border: "1px solid var(--line-weak)", padding: "4px 8px", textAlign: "left", color: "var(--accent-hi)" }}>{cell}</th>
                  ))}</tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rowIndex) => (
                    <tr key={rowIndex}>{row.map((cell, cellIndex) => (
                      <td key={`${cell}-${cellIndex}`} style={{ border: "1px solid var(--line-weak)", padding: "4px 8px" }}>{cell}</td>
                    ))}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        // paragraph：仅第一段、且要求 lead、且首句后面还有正文时，才把首句短语套斜体金色 .lead。
        // （纯短句如「你好！」不切——否则整句被当 lead 全斜，看着像输出错乱。）
        if (lead && index === 0) {
          const { head, rest } = splitLead(block.text);
          // rest 要够长才算「真有正文」——纯短句/带个 emoji（如「你好！👋」）不套 lead，免得整句被斜。
          if (head && rest.trim().length >= 8) {
            return (
              <p key={index} style={{ margin: 0 }}>
                <span className="lead">{head}</span>
                {renderRichText(rest)}
              </p>
            );
          }
        }
        return <p key={index} style={{ margin: index === 0 ? 0 : "8px 0 0" }}>{renderRichText(block.text)}</p>;
      })}
    </>
  );
}

/** 卡片标题是本程序自己拼的「X Agent 运行中」：去掉这个固定后缀。 */
function stripRunningSuffix(title: string): string {
  const suffix = "运行中";
  const text = title.trim();
  if (!text.endsWith(suffix)) return text;
  const head = text.slice(0, -suffix.length).trimEnd();
  return head.endsWith("Agent") ? head.slice(0, -"Agent".length).trimEnd() : head;
}

/** 起首短句（到第一个句末标点为止）作为金色 lead，其余正常。无明显短句则不切。 */
function splitLead(text: string): { head: string; rest: string } {
  // 不猜白名单：切句
  const match = text.match(/^[^。！？!?\n]{1,12}[。！？!?]/u);
  if (match) {
    return { head: match[0], rest: text.slice(match[0].length) };
  }
  return { head: "", rest: text };
}

/** 调用工具：默认收起一行「调用工具 · 工具名」。运行中工具名跑光影；有执行详情时可点开看。 */
function ToolStepFold({ step }: { readonly step: ToolStep }) {
  const [open, setOpen] = useState(false);
  const failed = step.status === "failed";
  const running = step.status === "running";
  // 已停止（人喊停腰斩）：中性徽标如实说「已停止」，不走红（不是失败）、不跑光影（不在跑）。
  const stopped = step.status === "stopped";
  // 裁决未过（commit_preview 核实「暂不可定稿」这类否定裁决）：落定徽标，不红（不是失败）不绿。
  const verdict = step.status === "verdict";
  const detail = step.detail?.trim();
  const canOpen = Boolean(detail);
  const elapsed = step.endedAt && step.startedAt ? formatStepElapsed(step.endedAt - step.startedAt) : null;
  // 工具名一律现取中文（覆盖旧历史里烤进消息的英文 label），见 resolveToolStepLabel。
  const toolLabel = resolveToolStepLabel(step.toolName, step.label);
  return (
    <div className="step-fold">
      <button
        type="button"
        className="step-head"
        onClick={() => { if (canOpen) setOpen((v) => !v); }}
        aria-expanded={canOpen ? open : undefined}
        disabled={!canOpen}
      >
        <span className="step-kind">AI 操作记录</span>
        <span className="step-sep">·</span>
        <span className={`step-label is-tool ${running ? "is-active" : ""}`.trim()}>{uiText(toolLabel, "执行步骤")}</span>
        {failed ? <span className="step-fail">失败</span> : null}
        {stopped ? <span className="step-stop">已停止</span> : null}
        {verdict ? <span className="step-verdict">裁决未过</span> : null}
        {elapsed ? <span className="tm">{elapsed}</span> : null}
        {canOpen ? <span className={`step-caret${open ? " is-open" : ""}`} aria-hidden="true"><IconChevronRight size={12} strokeWidth={2} /></span> : null}
      </button>
      {open && detail ? <p className="step-detail">{detail}</p> : null}
    </div>
  );
}

/** P1-9：已完成轮次的过程步聚合行——默认收起「AI 操作记录 · N 步」，展开后按序渲染各步。 */
function ProcessLogAggregate({ steps }: { readonly steps: readonly ProcessFoldStep[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="step-fold process-log-agg">
      <button
        type="button"
        className="step-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="step-kind">AI 操作记录</span>
        <span className="step-sep">·</span>
        <span className="step-label is-tool">{steps.length} 步</span>
        <span className={`step-caret${open ? " is-open" : ""}`} aria-hidden="true"><IconChevronRight size={12} strokeWidth={2} /></span>
      </button>
      {open ? (
        <div className="process-log-children">
          {steps.map((step, index) => {
            if (step.kind === "reasoning") {
              return <ThinkingDisclosure key={`agg-r-${index}`} thinking={step.text.trim()} />;
            }
            return <ToolStepFold key={`agg-t-${step.step.id}`} step={step.step} />;
          })}
        </div>
      ) : null}
    </div>
  );
}

/** 思考过程：默认收起一行「思考过程 ▸」。进行中标签跑光影；点开看真实推理链。无 emoji。 */
function ThinkingDisclosure({ thinking, active }: { readonly thinking: string; readonly active?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="step-fold">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="step-head">
        <span className={`step-label ${active ? "is-active" : ""}`.trim()}>AI 分析</span>
        <span className={`step-caret${open ? " is-open" : ""}`} aria-hidden="true"><IconChevronRight size={12} strokeWidth={2} /></span>
      </button>
      {open ? <p className="step-detail">{thinking}</p> : null}
    </div>
  );
}

// ─────────────────────────── extras（方案 / 审稿 / 修订 / 提示） ───────────────────────────

function NoticeCard({ title, text, danger }: { readonly title: string; readonly text: string; readonly danger?: boolean }) {
  return (
    <div
      style={{
        ...surfaceCardStyle,
        borderColor: danger ? "var(--danger)" : "var(--line)",
        background: danger ? "var(--danger-soft)" : "var(--surface)",
      }}
    >
      <strong style={{ color: danger ? "var(--danger)" : "var(--text)", fontSize: 12.5 }}>{title}</strong>
      <p style={{ margin: "6px 0 0", color: "var(--muted)", fontSize: 12 }}>{uiText(text)}</p>
    </div>
  );
}

function SteeringDraftCard({ draft }: { readonly draft: NonNullable<WritingWorkspaceLayoutProps["steeringDraft"]> }) {
  return (
    <div style={surfaceCardStyle}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
        <span style={{ color: "var(--accent-hi)", fontSize: 12, fontWeight: 600 }}>章纲</span>
        <strong style={{ color: "var(--muted)", fontSize: 11.5 }}>{draft.suggestions.length} 条建议 · 只读预览</strong>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {draft.suggestions.map((suggestion) => (
          <div key={suggestion.id} style={{ borderTop: "1px dashed var(--line-faint)", paddingTop: 8 }}>
            <span style={{ color: "var(--faint)", fontSize: 11 }}>
              {suggestion.type === "hook" ? "伏笔" : suggestion.type === "thread" ? "线索" : suggestion.type === "arcGoal" ? "主线目标" : suggestion.type === "risk" ? "风险" : suggestion.type === "location" ? "地点" : "角色"}
            </span>
            <strong style={{ display: "block", color: "var(--text)", fontSize: 12.5 }}>{uiText(suggestion.title)}</strong>
            <p style={{ margin: "2px 0 0", color: "var(--muted)", fontSize: 11.5 }}>{uiText(suggestion.reason)}</p>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 10 }}>
        <h3 style={extraHeadingStyle}>本章目标预览</h3>
        <p style={{ margin: 0, color: "var(--muted)", fontSize: 12 }}>{uiText(draft.generatedChapterGoalPreview)}</p>
      </div>
    </div>
  );
}

const extraHeadingStyle: React.CSSProperties = {
  margin: "0 0 3px",
  fontSize: 11,
  fontWeight: 600,
  color: "var(--faint)",
  letterSpacing: ".04em",
};

// ─────────────────────────── 空状态判定 ───────────────────────────

function shouldShowEmptyState(props: WritingWorkspaceLayoutProps, messages: readonly ChapterMessage[]): boolean {
  const onlyInjected = messages.every((message) => isInjectedWorkflowMessage(message));
  return onlyInjected
    && !props.steeringDraft
    && !props.draftAIReview
    && !props.activeRevisionTask
    && !props.steeringError
    && !props.chatError
    && !props.steeringLoading
    && !props.chatLoading;
}

function isInjectedWorkflowMessage(message: ChapterMessage): boolean {
  if (message.role === "system") return true;
  if (message.role !== "assistant") return false;
  if ((message.agentCards?.length ?? 0) > 0 || (message.cards?.length ?? 0) > 0 || (message.toolSteps?.length ?? 0) > 0) return false;
  // 按消息自带的 kind 认（重构 P4），不按文案。
  return message.kind === "scaffolding";
}
