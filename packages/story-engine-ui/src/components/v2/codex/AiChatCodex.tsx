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
import type { ChapterAdviceCard, ToolStep, DraftReviewIssueView } from "../../../api/types.js";
import type { ChapterFlowStatus, ChapterMessage, WritingWorkspaceLayoutProps, AiFlavorViolation } from "../../../types.js";
import { shouldSendOnEnterKey } from "../../../utils/imeEnterGuard.js";
import { resolveToolStepLabel } from "../../../hooks/agentEventProjection.js";
import { isBookCreationGreeting } from "../../../hooks/useProjectNavigation.js";
import { buildTimelineModel, liveFlowFromMessage, type LiveFlow, type FlowPhaseKey } from "../agentTimelineModel.js";
import { flowHint, primaryPermission, uiText } from "../v2Utils.js";
import AgentErrorCard from "./AgentErrorCard.js";
import { ChapterToolRail } from "./ChapterToolRail.js";
import { ChatCapabilityBar } from "./ChatCapabilityBar.js";
import { DraftAIReviewCard } from "./DraftAIReviewCard.js";
import { DraftReviewCard } from "./DraftReviewCard.js";
import { ChatContextMeter } from "./ChatContextMeter.js";
import { ChatSessionBar } from "./ChatSessionBar.js";
import type { SuggestedAction } from "../../../type-defs/workflow.js";
import { AiFlavorCard } from "./AiFlavorCard.js";
import { lastAssistantNextStepPrompt } from "./nextStepChoices.js";
import { latestTurnSuggestedActions } from "./suggestedActionRail.js";
import { buildMessageRenderSegments } from "./messageSegments.js";
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
import { useWorkspaceStore } from "../../../stores/workspaceStore.js";
import { isWorkspaceBusy } from "../../../utils/workspaceOperation.js";

type AiChatCodexProps = WritingWorkspaceLayoutProps & {
  readonly rightOpen: boolean;
  readonly onToggleRight: () => void;
  /** 拖动右栏左缘改宽（pointerdown 起拖，宽度状态由外层 codex 壳持有）。 */
  readonly onResizeStart?: (event: ReactPointerEvent) => void;
};

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
        <span style={{ fontSize: 16 }} aria-hidden="true">✦</span>
        <span>AI 助手</span>
      </button>
    </aside>
  );
}

export default function AiChatCodex(props: AiChatCodexProps) {
  // 归档折叠行展开态。
  const [archivedExpanded, setArchivedExpanded] = useState(false);
  const { activeArchivedCount } = useWorkspaceStore();

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
  const workspaceBusy = Boolean(
    props.chatLoading
    || props.steeringLoading
    || props.draftActionLoading
    || isWorkspaceBusy(),
  );
  const chatEnabled = Boolean(props.onSendMessage) && !workspaceBusy;
  const sendCurrent = () => {
    const message = props.steeringDirection.trim();
    if (!chatEnabled || !message) return;
    props.onSendMessage?.(message);
    props.onSteeringDirectionChange("");
  };

  useEffect(() => {
    if (!atBottomRef.current) return;
    const el = historyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [props.workspace.messages, props.chatLoading, props.steeringLoading, props.steeringDraft, props.draftAIReview, props.activeRevisionTask, props.chatError, props.steeringError]);

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
  const nextStep = busy ? null : lastAssistantNextStepPrompt(props.workspace.messages);
  // 「建议动作」条（A-6）：最后一轮消息上挂着的 suggestedActions（重新确认定稿/撤销本次修改/确认写入资料…）。
  // 忙碌时不渲染（回合进行中不可点；回合结束自然浮现）。retry-agent 不进条——错误气泡内已有就地重试。
  const railActions = busy ? [] : latestTurnSuggestedActions(props.workspace.messages);
  const canClear = Boolean(props.onClearChat) && props.workspace.messages.length > 0 && !workspaceBusy;

  return (
    <aside className="ai" aria-label="AI 写作助手">
      {/* ── 左缘拖拽手柄：拖动调整对话列宽度 ── */}
      {props.onResizeStart ? (
        <div
          className="ai-resize"
          onPointerDown={props.onResizeStart}
          role="separator"
          aria-orientation="vertical"
          aria-label="拖动调整对话宽度"
          title="拖动调整对话宽度"
        />
      ) : null}
      {/* ── 头部：身份 + 在线点 + 折叠/清空小按钮 ── */}
      <div className="ai-head">
        <div className="ai-av"><span aria-hidden="true">✦</span><span className="ai-av-dot" title="在线" /></div>
        <div className="ai-id">
          <b>AI 写作助手</b>
          <small title={flowHint(flowStatus)}>{flowHint(flowStatus)}</small>
        </div>
        <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          {/* 聊天字号步进器已撤——统一并入「设置 · 显示」面板；缩放仍由 .codex-app 的 --codex-chat-zoom 生效。 */}
          {canClear ? (
            <button
              type="button"
              onClick={() => props.onClearChat?.()}
              title="清空当前对话（不影响正文和资料，可撤销）"
              style={aiHeadBtnStyle}
            >
              清空
            </button>
          ) : null}
          <button type="button" onClick={props.onToggleRight} title="收起 AI 对话" style={aiHeadBtnStyle}>
            收起
          </button>
        </span>
      </div>

      {/* ── 会话入口：当前会话名（可就地改名）+ 新建 + 历史列表 ── */}
      <ChatSessionBar />

      {/* ── 四步进度：flowStatus 基线 + 本回合 toolSteps 派生的实时态（哪步在跑 / 落地物） ── */}
      <AiFlow flowStatus={flowStatus} live={liveFlowFromMessage([...props.workspace.messages].reverse().find((m) => m.role === "assistant"))} />
      {/* ── 本章工具条（B1）：按阶段确定性列出该用的工具，点一下=给 agent 发预置意图（对话唯一控制面） ── */}
      <ChapterToolRail flowStatus={flowStatus} onSendMessage={props.onSendMessage} disabled={workspaceBusy} />

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
            {archivedExpanded ? `▾ 隐藏已清理的 ${activeArchivedCount} 条早先消息` : `— 已清理 ${activeArchivedCount} 条早先消息，点击展开 —`}
          </div>
        ) : null}
        {/* 展开归档段：只读显示 slice(0, activeArchivedCount) */}
        {archivedExpanded && activeArchivedCount > 0 ? (
          <div className="codex-archived-messages">
            {props.workspace.messages.slice(0, activeArchivedCount).map((message) => (
              <MessageBubbles
                key={`archived-${message.id}`}
                message={message}
                chatLoading={workspaceBusy}
              />
            ))}
          </div>
        ) : null}
        {props.workspace.messages.map((message, index, all) => {
          const isLiveAssistant = Boolean(props.chatLoading)
            && message.role === "assistant"
            && !all.slice(index + 1).some((m) => m.role === "assistant");
          return (
          <MessageBubbles
            key={message.id}
            message={message}
            chatLoading={workspaceBusy}
            isLiveAssistant={isLiveAssistant}
            selectedAdviceCardKeys={props.selectedAdviceCardKeys}
            onSelectAdviceCard={props.onSelectAdviceCard}
            onUndoToHere={props.onUndoToTurn ? () => props.onUndoToTurn?.(message) : undefined}
            onFixAiFlavorViolation={props.onFixAiFlavorViolation}
            onFixAllAiFlavorViolations={props.onFixAllAiFlavorViolations}
            pendingViolationId={props.aiFlavorPending?.messageId === message.id ? props.aiFlavorPending.violationId : null}
            aiFlavorAwaitingApply={props.aiFlavorPending?.messageId === message.id && Boolean(props.activeRevisionPreview)}
            batchPendingForThisCard={props.aiFlavorBatchPending === message.id}
            onSendMessage={props.onSendMessage}
            onSuggestedAction={props.onSuggestedAction}
            onCreateRevisionTask={props.onCreateRevisionTask}
          />
          );
        })}

        {shouldShowEmptyState(props) ? (
          <div style={surfaceCardStyle}>
            <strong style={{ color: "var(--text)", fontSize: 13 }}>可以直接描述下一章方向</strong>
            <p style={{ margin: "6px 0 0", color: "var(--muted)", fontSize: 12.5 }}>我会先帮你生成承接建议或工作稿。</p>
            {props.canUndoClearChat && props.onUndoClearChat ? (
              <button type="button" className="chip" style={{ marginTop: 10 }} onClick={() => props.onUndoClearChat?.()}>
                ↩ 撤销清空，恢复刚才的对话
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
        {props.steeringLoading ? <NoticeCard title="正在整理本章方案" text="正在读取故事状态，并整理本章写作方案。" /> : null}
      </div>

      {/* ── 下一步：AI 带路选项 ── 点选项=给 agent 发一句意图（对话里留「你：…」、再由 agent 接着做）；
          引导≠强制：可直接打字无视。idle/进行态不出（空态卡/思考浮层自有提示）。 */}
      {nextStep && props.onSendMessage && !workspaceBusy ? (
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
                onClick={() => props.onSendMessage?.(choice.intent)}
              >
                <span>{choice.label}{choice.primary ? <em className="nextstep-rec">推荐</em> : null}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {/* ── 上下文提示条（消息列表与输入框之间） ── */}
      <ChatContextMeter />

      {/* ── 能力快捷条：补全资料 + 整理的散能力入口（写作流程那几个在上方 ChapterToolRail） ── */}
      <ChatCapabilityBar onSendMessage={props.onSendMessage} disabled={workspaceBusy} />

      {/* ── 建议动作条（A-6）：回合级动作的统一入口——此前这些 suggestedActions 在 codex 壳里零渲染，
          作者只能照文字重打指令。点击走既有 handleSuggestedAction（发消息给 agent / 调既有工具路），
          不是绕过对话的直连引擎按钮。 ── */}
      {railActions.length > 0 && props.onSuggestedAction ? (
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

      {/* ── 输入区（含「正在思考」浮层） ── */}
      <div style={{ position: "relative" }}>
        {/* 「正在思考」浮层——复用旧版那套受喜爱的动效（错峰跳动金点 + 流光扫过 + 呼吸辉光，纯 CSS，v2.css 全局生效）。 */}
        {props.chatLoading ? (
          <div className="se-v2-thinking-dock">
            <ThinkingIndicator />
          </div>
        ) : null}
        <div className="composer" style={{ alignItems: "flex-end" }}>
          <textarea
            className="ai-composer-input"
            disabled={!chatEnabled}
            value={props.steeringDirection}
            onChange={(event) => props.onSteeringDirectionChange(event.target.value)}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={() => {
              composingRef.current = false;
              compositionEndedAtRef.current = performance.now();
            }}
            onKeyDown={(event) => {
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
            placeholder={getPlaceholder(flowStatus, isBookCreationGreeting(props.workspace.messages))}
            rows={3}
            style={composerInputStyle}
          />
          {props.chatLoading && props.onStopAgent ? (
            <button
              type="button"
              className="send"
              onClick={() => props.onStopAgent?.()}
              title="停止本次生成（已写出的内容保留）"
              style={{ background: "var(--danger)", color: "#fff" }}
            >
              ■
            </button>
          ) : (
            <button
              type="button"
              className="send"
              disabled={!chatEnabled || !props.steeringDirection.trim()}
              onClick={sendCurrent}
              title="发送"
              style={!chatEnabled || !props.steeringDirection.trim() ? { opacity: 0.5, cursor: "not-allowed" } : undefined}
            >
              ↑
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}

const aiHeadBtnStyle: React.CSSProperties = {
  fontSize: 11,
  padding: "3px 9px",
  borderRadius: 8,
  border: "1px solid var(--line)",
  background: "var(--surface)",
  color: "var(--muted)",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

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

// ─────────────────────────── 四步进度 ───────────────────────────

type FlowStep = { readonly key: FlowPhaseKey; readonly icon: string; readonly label: string; readonly desc: string };

const FLOW_STEPS: readonly FlowStep[] = [
  { key: "understand", icon: "✓", label: "构思", desc: "想这一章往哪走：写什么、怎么转折。直接跟 AI 聊方向就行。" },
  { key: "draft", icon: "✎", label: "写稿", desc: "把方向写成工作稿——还没定稿，随便改。" },
  { key: "polish", icon: "◈", label: "检查", desc: "检查逻辑和前后穿帮，也可以做内容审阅，有问题再修改。" },
  { key: "commit", icon: "↻", label: "定稿", desc: "确认这章为定稿，更新人物、伏笔等故事资料，让下一章接得上。"},
];

/**
 * 9 阶段 flowStatus → codex 4 步的「当前下标」（0=构思,1=写稿,2=审校,3=入库）。
 * 已入库（committed/ready_for_next）返回 4 = 越过末尾 → 四步全部显示「完成」（入库这步也打勾），
 * 而不是停在入库发光（那会让用户以为还没走完）。入库前一步（预览/等确认）才让入库步「on」。
 */
function flowStepIndex(flowStatus: ChapterFlowStatus): number {
  switch (flowStatus) {
    case "idle":
    case "steering_ready":
      return 0;
    case "draft_generating":
    case "draft_ready":
      return 1;
    case "quality_checked":
      return 2;
    case "commit_preview_ready":
    case "waiting_commit_confirmation":
      return 3;
    case "committed":
    case "ready_for_next":
      return 4;
    default:
      return 0;
  }
}

/** 点「审校问题·改这处」→ 拼一句给 agent 的改写意图（agent 据纪律 5.5 先 read_draft 定位逐字原文再 revise）。 */
function buildReviseIntent(issue: DraftReviewIssueView): string {
  const trimDot = (s: string) => s.replace(/[。.]+\s*$/u, ""); // 去段尾句号，免与拼接的「。」叠成双句号
  const parts = [`针对内容审阅发现的问题改一下——【${issue.title}】${trimDot(issue.description)}`];
  if (issue.evidence) parts.push(`原句：「${issue.evidence}」`);
  if (issue.suggestedFix) parts.push(`建议：${trimDot(issue.suggestedFix)}`);
  return `${parts.join("。")}。`;
}

/** 把一行落地物压成单行短摘要（去多余空白、超长截断）。 */
function oneLine(text: string, max: number): string {
  const t = text.replace(/\s+/gu, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** 实时态字幕：有步骤在跑 → 「正在审校…」；否则显示最靠后已动步骤的落地物（写稿字数 / 入库变更清单等）。 */
function liveCaption(live: LiveFlow | null): { readonly text: string; readonly running: boolean } | null {
  if (!live) return null;
  const running = FLOW_STEPS.find((s) => live[s.key].status === "running");
  if (running) return { text: `正在${running.label}…`, running: true };
  // 「停止」收尾后（残留 running 已结算成 stopped）：常驻如实字幕，直到下一回合覆盖。
  if (FLOW_STEPS.some((s) => live[s.key].status === "stopped")) {
    return { text: "已停止 · 已写出的内容保留", running: false };
  }
  const acted = FLOW_STEPS.filter((s) => live[s.key].status === "done" || live[s.key].status === "failed");
  const last = acted[acted.length - 1];
  if (!last) return null;
  const lp = live[last.key];
  if (lp.status === "failed") return { text: `${last.label}没成功，可重试`, running: false };
  return { text: lp.detail ? oneLine(lp.detail, 52) : `${last.label}完成`, running: false };
}

function AiFlow({ flowStatus, live }: { readonly flowStatus: ChapterFlowStatus; readonly live: LiveFlow | null }) {
  const current = flowStepIndex(flowStatus);
  // 每步状态：实时态（toolSteps 派生）优先；该相没有 live 数据时退回 flowStatus 基线下标。
  // stopped（人喊停）= 既非完成也非失败的中性「停」态（halt），不转圈、不走红。
  const stepCls = (index: number, key: FlowPhaseKey): { cls: "done" | "on" | "fail" | "halt" | ""; running: boolean } => {
    const status = live?.[key].status;
    if (status === "running") return { cls: "on", running: true };
    if (status === "done") return { cls: "done", running: false };
    if (status === "failed") return { cls: "fail", running: false };
    if (status === "stopped") return { cls: "halt", running: false };
    return { cls: index < current ? "done" : index === current ? "on" : "", running: false };
  };
  const states = FLOW_STEPS.map((step, index) => stepCls(index, step.key));
  const caption = liveCaption(live);
  return (
    <div className="ai-flow">
      <div className="ai-flow-rail">
        {FLOW_STEPS.map((step, index) => {
          const { cls, running } = states[index];
          return (
            <span key={step.key} style={{ display: "contents" }}>
              <div
                className={`ai-step ${cls}${running ? " live" : ""}`.trim()}
                tabIndex={0}
                aria-label={`${step.label}：${step.desc}`}
              >
                <span className="st">{cls === "fail" ? "!" : cls === "halt" ? "■" : step.icon}</span>
                {step.label}
                {/* 悬停/键盘聚焦说明：不占地、要看才出（codex 暗金 tooltip）。首/末步靠边对齐防溢出。 */}
                <span className={`ai-step-tip ${index === 0 ? "tip-left" : index === FLOW_STEPS.length - 1 ? "tip-right" : ""}`.trim()}>
                  {step.desc}
                </span>
              </div>
              {index < FLOW_STEPS.length - 1 ? (
                // 走过/已完成段=done(金色填满)；正在跑那步紧后段=active(金光流动)；更远=暗。
                <div className={`ai-bar ${states[index].running ? "active" : states[index].cls === "done" ? "done" : index < current ? "done" : index === current ? "active" : ""}`.trim()} />
              ) : null}
            </span>
          );
        })}
      </div>
      {/* 实时态字幕：让用户「看见」每步在干啥、干完了啥（codex 暗金、淡、不抢戏）。 */}
      {caption ? <div className={`ai-flow-live${caption.running ? " is-running" : ""}`}>{caption.text}</div> : null}
    </div>
  );
}

// ─────────────────────────── 消息气泡 ───────────────────────────

function MessageBubbles({
  message,
  chatLoading,
  isLiveAssistant = false,
  selectedAdviceCardKeys = [],
  onSelectAdviceCard,
  onUndoToHere,
  onFixAiFlavorViolation,
  onFixAllAiFlavorViolations,
  pendingViolationId = null,
  aiFlavorAwaitingApply = false,
  batchPendingForThisCard = false,
  onSendMessage,
  onSuggestedAction,
  onCreateRevisionTask,
}: {
  readonly message: ChapterMessage;
  readonly chatLoading: boolean;
  /** 本条是否为当前流式进行中的助手消息（进行中不聚合过程步）。 */
  readonly isLiveAssistant?: boolean;
  readonly selectedAdviceCardKeys?: readonly string[];
  readonly onSelectAdviceCard?: (key: string, card: ChapterAdviceCard) => void;
  readonly onUndoToHere?: () => void;
  readonly onFixAiFlavorViolation?: (violation: AiFlavorViolation, messageId: string) => void;
  readonly onFixAllAiFlavorViolations?: (violations: readonly AiFlavorViolation[], messageId: string) => void;
  readonly pendingViolationId?: string | null;
  /** 那条 pending 的改写草案是否已生成、等用户去写作台应用（→ 卡上显「待应用」而非「改写中…」）。 */
  readonly aiFlavorAwaitingApply?: boolean;
  readonly batchPendingForThisCard?: boolean;
  /** 点「审校问题」卡的「改这处」=给 agent 发一句改写意图（chat 驱动）。 */
  readonly onSendMessage?: (content: string) => void;
  readonly onSuggestedAction?: (action: SuggestedAction) => void;
  /** REST 深度审稿卡「生成修订任务」——传进消息内卡，不再靠钉底卡。 */
  readonly onCreateRevisionTask?: WritingWorkspaceLayoutProps["onCreateRevisionTask"];
}) {
  if (message.role === "system") return null;

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
  if (message.isErrorNotice) {
    const retry = (message.suggestedActions ?? []).find((a) => a.id === "retry-agent") ?? null;
    return (
      <div className="msg msg-ai">
        <AgentErrorCard
          detail={message.errorDetail || message.content}
          retryAction={retry}
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
  // 注：suggestedActions 不再计入「这条气泡有没有东西」——它们已统一移到 composer 上方的建议条。
  const hasAnything = message.content.trim().length > 0
    || toolSteps.length > 0
    || (message.agentCards?.length ?? 0) > 0
    || (message.adviceCards?.length ?? 0) > 0
    || Boolean(message.aiFlavorReport)
    || Boolean(message.aiReviewReport)
    || Boolean(message.draftReview)
    || Boolean(message.nameConsistencyWarnings?.length)
    || Boolean(message.staleThreadWarnings?.length)
    || Boolean(message.thinking?.trim());
  // 流式开始前的空占位助手气泡不渲染。
  if (!hasAnything) return null;

  const canUndo = Boolean(onUndoToHere) && (model?.canUndo ?? false);
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
  const bucketAggregate = shouldAggregateProcessBucket(
    message.thinking,
    toolSteps.length,
    aggregateProcess,
  );

  return (
    <div className="msg msg-ai">
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

      {/* 建议卡片 */}
      {message.adviceCards?.length ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
          {message.adviceCards.map((card) => {
            const selected = selectedAdviceCardKeys.includes(`${message.id}:${card.id}`);
            return (
              <button
                key={card.id}
                type="button"
                onClick={() => onSelectAdviceCard?.(`${message.id}:${card.id}`, card)}
                style={{
                  ...adviceCardStyle,
                  borderColor: selected ? "var(--accent-hi)" : "var(--line-weak)",
                  background: selected ? "var(--accent-soft)" : "rgba(0,0,0,.22)",
                }}
                title={card.reason ? uiText(card.reason) : undefined}
              >
                <strong style={{ color: "var(--text)", display: "block", fontSize: 12 }}>{uiText(card.title)}</strong>
                <span style={{ color: "var(--muted)", fontSize: 11.5 }}>{uiText(card.content)}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      {/* 去 AI 味体检卡：随这条消息走（不再钉底部）。已改的违规标「已改 ✓」、与左侧正文黄高亮联动。 */}
      {message.aiFlavorReport ? (
        <AiFlavorCard
          report={message.aiFlavorReport}
          fixedIds={message.aiFlavorFixedIds}
          pendingViolationId={pendingViolationId}
          awaitingApply={aiFlavorAwaitingApply}
          batchPending={batchPendingForThisCard}
          onFix={onFixAiFlavorViolation ? (v) => onFixAiFlavorViolation(v, message.id) : undefined}
          onFixAll={onFixAllAiFlavorViolations ? (vs) => onFixAllAiFlavorViolations(vs, message.id) : undefined}
        />
      ) : null}

      {/* REST 深度审稿卡：随这条消息走（不再钉底部）；StepCard 折叠壳在卡内，点「生成修订任务」走写作台链路。 */}
      {message.aiReviewReport ? (
        <DraftAIReviewCard
          review={message.aiReviewReport}
          onCreateRevisionTask={onCreateRevisionTask}
        />
      ) : null}

      {/* AI 审稿问题清单卡：点「改这处」=给 agent 发改写意图（chat 驱动·唯一控制面），由 agent 先 read_draft 定位再 revise。 */}
      {message.draftReview ? (
        <DraftReviewCard
          report={message.draftReview}
          onRevise={onSendMessage ? (issue) => onSendMessage(buildReviseIntent(issue)) : undefined}
        />
      ) : null}

      {/* 质检明细卡：blocking 硬伤突出、soft 软提示默认折叠（防噪音），紧靠审校。 */}
      {message.qualityReport ? <QualityCheckCard report={message.qualityReport} /> : null}

      {/* 人物名一致性提醒卡：入库预览报出近形错名时固定醒目展示，不靠模型转述、不被说软。 */}
      {message.nameConsistencyWarnings?.length ? <NameConsistencyCard warnings={message.nameConsistencyWarnings} /> : null}

      {/* 伏笔/线索待收口提醒卡：入库预览报出久未推进的伏笔/线索时固定醒目展示，治「埋了不收」的遗漏。 */}
      {message.staleThreadWarnings?.length ? <StaleThreadCard warnings={message.staleThreadWarnings} /> : null}

      {/* 入库 delta 卡：这章正式入库改了哪些角色/伏笔/线索/时间线/主线目标，随消息走。 */}
      {message.commitReport ? <CommitDeltaCard report={message.commitReport} /> : null}

      {/* 「建议动作」统一在 composer 正上方的建议条渲染（latestTurnSuggestedActions + .suggest），气泡内不再渲染。 */}

      {/* 撤销到此 */}
      {canUndo ? (
        <div style={{ marginBottom: 12 }}>
          <button
            type="button"
            disabled={chatLoading}
            onClick={onUndoToHere}
            title="把这回合的改动整块回退，并截断这之后的对话"
            style={{
              fontSize: 11,
              color: "var(--muted)",
              background: "transparent",
              border: 0,
              cursor: chatLoading ? "not-allowed" : "pointer",
              opacity: chatLoading ? 0.5 : 1,
              padding: 0,
            }}
          >
            ↩ 撤销到此
          </button>
        </div>
      ) : null}
    </div>
  );
}

const adviceCardStyle: React.CSSProperties = {
  textAlign: "left",
  border: "1px solid var(--line-weak)",
  borderRadius: 10,
  padding: "8px 11px",
  cursor: "pointer",
  maxWidth: "100%",
};

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

/** 起首短句（到第一个句末标点为止）作为金色 lead，其余正常。无明显短句则不切。 */
function splitLead(text: string): { head: string; rest: string } {
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
        {elapsed ? <span className="tm">{elapsed}</span> : null}
        {canOpen ? <span className="step-caret" aria-hidden="true">{open ? "▾" : "▸"}</span> : null}
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
        <span className="step-caret" aria-hidden="true">{open ? "▾" : "▸"}</span>
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
        <span className="step-caret" aria-hidden="true">{open ? "▾" : "▸"}</span>
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
        <span style={{ color: "var(--accent-hi)", fontSize: 12, fontWeight: 600 }}>本章方案</span>
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

function shouldShowEmptyState(props: WritingWorkspaceLayoutProps): boolean {
  const onlyInjected = props.workspace.messages.every((message) => isInjectedWorkflowMessage(message));
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
  if ((message.agentCards?.length ?? 0) > 0 || (message.adviceCards?.length ?? 0) > 0 || (message.toolSteps?.length ?? 0) > 0) return false;
  const content = message.content.trim();
  return content.startsWith("已进入《")
    || content === "当前章节已就绪。"
    // 新旧定稿文案都算（老会话落盘的是旧口径）。
    || content === "本章已定稿。说「下一章」继续。"
    || content === "本章已入库。说「下一章」继续。";
}
