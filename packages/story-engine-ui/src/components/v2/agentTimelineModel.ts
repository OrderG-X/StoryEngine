/**
 * agentTimelineModel — 把一条消息上分散的过程数据（thinking / toolSteps /
 * agentCards / toolOutput）归一化为按时间排序的执行时间线，供 AiChatCodex 经 buildTimelineModel 渲染。
 * 纯函数，无 React 依赖。
 */
import type { ChapterAgentCard, ToolStep } from "../../api/types.js";
import type { ChapterMessage } from "../../types.js";
import { uiText } from "./v2Utils.js";

export type TimelineStepStatus = "pending" | "running" | "completed" | "failed" | "needs_confirmation" | "partial" | "stopped" | "verdict";

export interface TimelineStep {
  readonly id: string;
  readonly label: string;
  readonly status: TimelineStepStatus;
  readonly detail?: readonly string[];
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly primaryActionId?: string;
}

export type TimelineState = "running" | "completed" | "failed" | "attention";

export interface TimelineModel {
  readonly steps: readonly TimelineStep[];
  readonly summary: string;
  readonly state: TimelineState;
  readonly autoExpanded: boolean;
  readonly intentTitle?: string;
  readonly affectedLabel?: string;     // 影响范围人话："资料库" / "正文·工作稿" / "资料库·正文·工作稿"
  readonly totalElapsedMs?: number;    // 回合总耗时
  readonly canUndo: boolean;           // 该回合是否有可回退的 git 快照
  readonly undoSnapshotId?: string;    // = turnSnapshots[0].snapshotId（回合首次写入前=整块回退点）
}

export function buildTimelineModel(message: ChapterMessage): TimelineModel | null {
  const steps: TimelineStep[] = [];

  if (message.thinking?.trim()) {
    steps.push({ id: `${message.id}-thinking`, label: "AI 分析", status: "completed", detail: [message.thinking.trim()] });
  }
  for (const step of sortedToolSteps(message.toolSteps ?? [])) {
    steps.push({ id: step.id, label: uiText(step.label, ""), status: step.status, startedAt: step.startedAt, endedAt: step.endedAt });
  }
  for (const card of message.agentCards ?? []) {
    steps.push(stepFromAgentCard(card));
  }
  if (message.toolOutput?.length) {
    steps.push({ id: `${message.id}-tool-output`, label: "执行输出", status: "completed", detail: message.toolOutput.map((line) => uiText(line, "")) });
  }
  if (steps.length === 0) return null;

  const cards = message.agentCards ?? [];
  const state = timelineState(steps);
  const turnSnapshots = message.turnSnapshots ?? [];
  return {
    steps,
    state,
    autoExpanded: state !== "completed",
    summary: `${timelineSubject(cards)} · ${timelineStatusText(steps, state, cards)}`,
    intentTitle: message.intentTitle,
    affectedLabel: affectedLabelFromScopes(message.affectedScopes),
    totalElapsedMs: turnElapsedMs(message),
    canUndo: turnSnapshots.length > 0,
    undoSnapshotId: turnSnapshots[0]?.snapshotId,
  };
}

/** 影响范围 scopes → 人话标签（资料库 / 正文·草稿）。无 scopes 返回 undefined。 */
function affectedLabelFromScopes(scopes?: readonly ("full" | "foundation")[]): string | undefined {
  if (!scopes?.length) return undefined;
  const parts: string[] = [];
  if (scopes.includes("foundation")) parts.push("设定本");
  if (scopes.includes("full")) parts.push("正文·工作稿");
  return parts.join("·") || undefined;
}

/** 回合墙钟总耗时（起止都有才算），用于块头耗时展示。 */
function turnElapsedMs(message: ChapterMessage): number | undefined {
  if (message.turnStartedAt && message.turnEndedAt) return Math.max(0, message.turnEndedAt - message.turnStartedAt);
  return undefined;
}

function sortedToolSteps(steps: readonly ToolStep[]): readonly ToolStep[] {
  return [...steps].sort((a, b) => a.startedAt - b.startedAt);
}

function stepFromAgentCard(card: ChapterAgentCard): TimelineStep {
  const detail = [uiText(card.summary, ""), ...(card.detail ?? []).filter((line) => !isRouteAuditDetailLine(line)).map((line) => uiText(line, ""))]
    .map((line) => line.trim())
    .filter(Boolean);
  return {
    id: card.id,
    label: uiText(card.title, "") || agentDisplayLabel(card),
    status: agentCardTimelineStatus(card.status),
    detail: detail.length ? detail : undefined,
    primaryActionId: card.primaryActionId,
  };
}

const agentCardStatusMap: Record<ChapterAgentCard["status"], TimelineStepStatus> = {
  queued: "pending",
  running: "running",
  completed: "completed",
  saved: "completed",
  needs_confirmation: "needs_confirmation",
  partial: "partial",
  failed: "failed",
  blocked: "failed",
  rejected: "failed",
  stopped: "stopped",
};

function agentCardTimelineStatus(status: ChapterAgentCard["status"]): TimelineStepStatus {
  return agentCardStatusMap[status];
}

function timelineState(steps: readonly TimelineStep[]): TimelineState {
  if (steps.some((step) => step.status === "failed")) return "failed";
  if (steps.some((step) => step.status === "needs_confirmation" || step.status === "partial" || step.status === "stopped")) return "attention";
  if (steps.some((step) => step.status === "running" || step.status === "pending")) return "running";
  return "completed";
}

function timelineSubject(cards: readonly ChapterAgentCard[]): string {
  return cards.length ? agentDisplayLabel(cards[0]) : "执行过程";
}

function timelineStatusText(steps: readonly TimelineStep[], state: TimelineState, cards: readonly ChapterAgentCard[]): string {
  if (state === "failed") return "执行遇到问题";
  if (state === "attention") {
    // 停止（人喊停）与待确认/部分完成分开说——停止不是「等你确认」。
    if (steps.some((step) => step.status === "stopped")) return "已停止";
    return "待确认";
  }
  if (state === "running") {
    const current = steps.find((step) => step.status === "running") ?? steps.find((step) => step.status === "pending");
    return `正在${current?.label ?? "执行"}`;
  }
  // 正式入库成功不以「已完成 N 个步骤」为头条，如实传达入库结果。
  return completedCommitApplyStatusText(cards) ?? `已完成 ${steps.length} 个步骤`;
}

/**
 * 正式入库（commitApplyAgent）完成时，时间线头部用如实结果文案而非机械步骤计数。
 * 仅命中 commit kind + commitApplyAgent 的完成态终态卡，不影响入库预览/草稿/质检等其它流程。
 */
function completedCommitApplyStatusText(cards: readonly ChapterAgentCard[]): string | null {
  const commitApply = cards.find((card) => card.kind === "commit" && card.agentName === "commitApplyAgent");
  if (!commitApply || commitApply.status !== "completed") return null;
  return "已定稿";
}

/** route:/action:/confidence: 等审计行在时间线中不渲染（数据仍保留在消息上）。 */
export function isRouteAuditDetailLine(line: string): boolean {
  const trimmed = line.trim();
  return /^(route|action|target|confidence|reason):\s*/u.test(trimmed) || trimmed.startsWith("判断：");
}

export function agentDisplayLabel(card: ChapterAgentCard): string {
  const byAgentName: Record<string, string> = {
    chapterOrchestrator: "写作助手",
    chapterSteeringAgent: "章纲",
    draftWriterAgent: "正文生成",
    draftEditAgent: "工作稿修改",
    qualityAgent: "硬伤检查",
    reviewAgent: "内容审阅",
    revisionAgent: "修订预览",
    commitPreviewAgent: "定稿预览",
    commitApplyAgent: "定稿",
    foundationAgent: "资料助手",
    stateOverviewReader: "资料助手",
    writingRulesWriter: "写作规则",
    storySettingsWriter: "故事设定",
    chapterNavigator: "下一章",
  };
  const byKind: Record<ChapterAgentCard["kind"], string> = {
    orchestrator: "写作助手",
    steering: "章纲",
    draft: "工作稿处理",
    revision: "修订预览",
    review: "内容审阅",
    quality: "硬伤检查",
    commit: "定稿预览",
    foundation: "资料助手",
    project: "项目处理",
  };
  return byAgentName[card.agentName] ?? byKind[card.kind];
}

export function timelineStepStatusLabel(status: TimelineStepStatus): string {
  const labels: Record<TimelineStepStatus, string> = {
    pending: "排队中",
    running: "执行中",
    completed: "已完成",
    failed: "失败",
    needs_confirmation: "待确认",
    partial: "部分完成",
    stopped: "已停止",
    // 裁决类只读工具（commit_preview）正常返回的否定裁决（ok===canCommit:false）：落定、不红不绿。
    verdict: "裁决未过",
  };
  return labels[status];
}
