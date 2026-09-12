import {
  fetchChapterSteering,
  generateDraftStream,
  checkDraftQuality,
  reviewDraftWithAI,
  previewDraftRevision,
  applyDraftRevision,
  applyDeAiFlavorBatch,
  generateDraftCandidate,
  applyDraftCandidate,
  previewCommit,
  applyCommit,
  saveChapterWorkspace,
  applyFoundationGapDecisions,
} from "../api/client.js";
import type {
  CommitSelectiveConfirmation,
  CommitApplySuccessResult,
  DraftAIReviewIssue,
  DraftAIRevisionSuggestion,
  DraftRevisionTask,
  ChapterAgentCard,
  FoundationGapDecision,
  FoundationGapSuggestion,
  StateOverview,
  UpdateStorySettingsRequest,
  UpdateWritingRulesRequest,
} from "../api/types.js";
import { useWorkspaceStore, type SelectedAdviceCard } from "../stores/workspaceStore.js";
import { useNavigationStore } from "../stores/navigationStore.js";
import type {
  ChapterMessage,
  ChapterWorkflowState,
  CommitPreviewCandidate,
  CommitPreviewUiReport,
  CommitSelectiveConfirmationState,
  CommitSelectiveDecisionState,
  SuggestedAction,
} from "../types.js";
import { compactStrings, countTextWords, extractDraftTitle, cleanUiText } from "../utils/textUtils.js";
import {
  SELECTION_REVISION_TEMPLATES,
  buildSelectionRevisionTask,
  isNoOpRevisionPreview,
  type SelectionRevisionKey,
} from "../components/v2/selectionRevisionTemplates.js";
import { isRevisionZeroDiff } from "../components/v2/codex/revisionZeroDiff.js";
import {
  workflowPromptText,
  actionsForWorkflowState,
  suggestedActionForPendingAction,
  verdictLabel,
  createWorkflowMessage,
  suggestedAction,
} from "../utils/workflowHelpers.js";
import { summarizeDraftQualityReport } from "../utils/qualitySummary.js";
import { summarizeCommitReport } from "../utils/commitReportSummary.js";
import { summarizeFormalCommitApplyError } from "../utils/formalCommitApplyErrorCopy.js";
import { isRealDraftContent } from "../utils/draftContent.js";
import {
  beginWorkspaceOperation,
  finishWorkspaceOperation,
  isWorkspaceOperationCurrent,
  isWorkspaceOperationTargetCurrent,
  workspaceOperationTargetMatches,
  type WorkspaceOperationKind,
  type WorkspaceOperationToken,
} from "../utils/workspaceOperation.js";
import type { WorkspaceOperationTarget } from "../type-defs/workspace.js";
import { prepareVersionedWorkspaceSave, recordWorkspaceRevision } from "../utils/workspaceRevisionTracker.js";

/* ------------------------------------------------------------------ */
/*  File-scope helpers (extracted from App.tsx)                        */
/* ------------------------------------------------------------------ */

function buildSelectedAdvicePlan(cards: readonly SelectedAdviceCard[]): string {
  if (cards.length === 0) return "";
  return `\n\n用户已选中的写法方案：${cards
    .map(({ card }) => `${card.title}：${card.content}`)
    .join("；")}`;
}

function completedAgentCard(input: {
  readonly id: string;
  readonly kind: ChapterAgentCard["kind"];
  readonly agentName: string;
  readonly title: string;
  readonly summary: string;
  readonly detail?: readonly string[];
  readonly status?: ChapterAgentCard["status"];
}): ChapterAgentCard {
  return {
    id: input.id,
    kind: input.kind,
    agentName: input.agentName,
    status: input.status ?? "completed",
    title: input.title,
    summary: input.summary,
    ...(input.detail?.length ? { detail: input.detail } : {}),
  };
}

function draftAgentProgressCard(input: {
  readonly status: ChapterAgentCard["status"];
  readonly title: string;
  readonly summary: string;
  readonly detail?: readonly string[];
}): ChapterAgentCard {
  return {
    id: "agent-fast-draft",
    kind: "draft",
    agentName: "fastDraftAgent",
    status: input.status,
    title: input.title,
    summary: input.summary,
    ...(input.detail?.length ? { detail: input.detail } : {}),
  };
}

function writingRulesSaveSuggestion(input: UpdateWritingRulesRequest): FoundationGapSuggestion {
  return {
    id: `manual-writing-rules-${Date.now()}`,
    gapId: "manual-writing-rules",
    category: "writingRules",
    actionType: "update_writing_rule",
    targetFile: "story/writing-rules.json",
    targetPath: "$",
    before: null,
    after: {
      ...(input.narrativePerspective ? { narrativePerspective: input.narrativePerspective } : {}),
      ...(input.pacing ? { pacing: input.pacing } : {}),
      ...(input.revealPolicy ? { revealPolicy: input.revealPolicy } : {}),
      ...(typeof input.targetChapterWords === "number" ? { targetChapterWords: input.targetChapterWords } : {}),
      replaceArrays: {
        proseStyle: input.proseStyle,
        genreRequirements: input.genreRequirements,
        forbiddenContent: input.forbiddenContent,
        doNotDo: input.doNotDo,
        readerExperienceRules: input.readerExperienceRules,
      },
    },
    rationale: "用户在资料编辑弹窗中保存当前书籍写作规则。",
    risk: "info",
    requiresUserConfirm: true,
  };
}

function storySettingsSaveSuggestions(input: UpdateStorySettingsRequest): readonly FoundationGapSuggestion[] {
  const entries: Array<readonly [FoundationGapSuggestion["category"], string, string, unknown]> = [
    ["story", "project.json", "title", input.title],
    ["world", "world/core.json", "genre", input.genre],
    ["world", "world/core.json", "premise", input.logline],
    ["world", "world/core.json", "rules", input.worldRules ?? []],
    ["world", "world/state.json", "currentPhase", input.currentPhase],
    ["world", "world/state.json", "activeConflicts", input.importantFacts ?? []],
    ["story", "story/core.json", "readerPromise", input.currentMainGoal ?? input.logline],
    ["story", "story/bible.json", "projectLogline", input.logline],
    ["story", "story/bible.json", "premise", input.logline],
    ["story", "story/bible.json", "genre", input.genre],
    ["story", "story/bible.json", "readerPromise", input.logline],
    ["story", "story/bible.json", "longFormGoals", input.longFormGoals ?? (input.firstVolumeGoal ? [input.firstVolumeGoal] : [])],
    ["story", "story/bible.json", "centralConflicts", input.centralConflicts ?? []],
    ["story", "story/bible.json", "forbiddenChanges", input.forbiddenReveals ?? []],
    ["story", "story/bible.json", "canonFacts", input.importantFacts ?? []],
    ["story", "story/bible.json", "openQuestions", input.openQuestions ?? []],
    ["world", "story/world-bible.json", "rules", input.worldRules ?? []],
    ["world", "story/world-bible.json", "socialOrder", input.socialRules ?? []],
  ];
  return entries.map(([category, targetFile, targetPath, after], index) => ({
    id: `manual-story-settings-${Date.now()}-${index}`,
    gapId: `manual-story-settings-${targetFile}-${targetPath}`,
    category,
    actionType: "fill_missing_field",
    targetFile,
    targetPath,
    before: null,
    after,
    rationale: "用户在资料编辑弹窗中保存当前书籍故事设定。",
    risk: "info",
    requiresUserConfirm: true,
    writeMode: "replace",
  }));
}

/* ------------------------------------------------------------------ */
/*  Commit preview UI report helpers                                   */
/* ------------------------------------------------------------------ */

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function inferRevisionTargetType(source: { readonly issue?: DraftAIReviewIssue; readonly suggestion?: DraftAIRevisionSuggestion }): DraftRevisionTask["targetType"] {
  const target = `${source.issue?.category ?? ""} ${source.suggestion?.target ?? ""}`;
  if (/开头|开场/u.test(target)) return "opening";
  if (/结尾|追读/u.test(target)) return "ending";
  if (/dialogue|对话|口吻/u.test(target)) return "dialogue";
  if (/pacing|节奏|中段/u.test(target)) return "section";
  return "paragraph";
}

function draftParagraphs(draftContent: string): string[] {
  return draftContent
    .split(/\n{2,}/u)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0 && !/^#\s*/u.test(paragraph));
}

function findExactOrContainingParagraph(draftContent: string, needle: string): string | null {
  const normalizedNeedle = needle.trim();
  if (!normalizedNeedle) return null;
  if (draftContent.includes(normalizedNeedle)) return normalizedNeedle;
  const paragraphs = draftParagraphs(draftContent);
  const compactNeedle = normalizedNeedle.replace(/\s+/g, "");
  return paragraphs.find((paragraph) => paragraph.replace(/\s+/g, "").includes(compactNeedle)) ?? null;
}

function resolveRevisionTarget(
  source: { readonly issue?: DraftAIReviewIssue; readonly suggestion?: DraftAIRevisionSuggestion },
  draftContent: string,
): { readonly targetText: string; readonly targetType: DraftRevisionTask["targetType"]; readonly guessed: boolean } | null {
  const sourceTexts = [
    source.issue?.evidence,
    source.issue?.affectedParagraphHint,
    source.suggestion?.target,
  ].filter((item): item is string => Boolean(item?.trim()));
  for (const candidate of sourceTexts) {
    const exact = findExactOrContainingParagraph(draftContent, candidate);
    if (exact) return { targetText: exact, targetType: inferRevisionTargetType(source), guessed: false };
  }
  // B5：精确/含有匹配都落空 → 下面按类目「猜」一段。猜中的一律标 guessed=true，让调用方提示用户核对，
  // 不再静默把猜测当成精确目标改错段（违『绝不静默』铁律④）。
  const paragraphs = draftParagraphs(draftContent);
  if (source.issue?.category === "reader_hook") {
    const last = paragraphs.at(-1);
    return last ? { targetText: last, targetType: "ending", guessed: true } : null;
  }
  if (source.issue?.category === "dialogue" || /对话|口吻/u.test(source.suggestion?.target ?? "")) {
    const dialogue = paragraphs.find((paragraph) => /[""“”]/u.test(paragraph));
    return dialogue ? { targetText: dialogue, targetType: "dialogue", guessed: true } : null;
  }
  if (/开头|开场/u.test(source.suggestion?.target ?? "") || source.issue?.category === "plot" || source.issue?.category === "pacing") {
    const first = paragraphs[0];
    return first ? { targetText: first, targetType: "opening", guessed: true } : null;
  }
  const fallback = paragraphs[0];
  return fallback ? { targetText: fallback, targetType: inferRevisionTargetType(source), guessed: true } : null;
}

/* ------------------------------------------------------------------ */
/*  Commit preview UI report helpers                                   */
/* ------------------------------------------------------------------ */

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => cleanUiText(typeof item === "string" ? item : JSON.stringify(item))).filter((item): item is string => Boolean(item))
    : [];
}

/** 从引擎 BuildCommitPlanResult.nameDriftFindings 读结构化的近形错名（establishedName/driftedVariant）；容错、无则空。 */
function readNameDriftFindings(value: unknown): { establishedName: string; driftedVariant: string }[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asRecord(item);
      const establishedName = typeof record.establishedName === "string" ? record.establishedName.trim() : "";
      const driftedVariant = typeof record.driftedVariant === "string" ? record.driftedVariant.trim() : "";
      return establishedName && driftedVariant ? { establishedName, driftedVariant } : undefined;
    })
    .filter((item): item is { establishedName: string; driftedVariant: string } => Boolean(item));
}

/** 读一个 stale 警告数组（伏笔 staleHookWarnings / 线索 staleThreadWarnings），贴上中文类别 kind。容错。 */
function readStaleWarningArray(value: unknown, kind: string): { kind: string; title: string; chaptersSinceTouched: number; lastTouchedChapter: number }[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asRecord(item);
      const title = typeof record.title === "string" ? record.title.trim() : "";
      const chaptersSinceTouched = typeof record.chaptersSinceTouched === "number" ? record.chaptersSinceTouched : undefined;
      const lastTouchedChapter = typeof record.lastTouchedChapter === "number" ? record.lastTouchedChapter : undefined;
      return title && chaptersSinceTouched !== undefined && lastTouchedChapter !== undefined
        ? { kind, title, chaptersSinceTouched, lastTouchedChapter }
        : undefined;
    })
    .filter((item): item is { kind: string; title: string; chaptersSinceTouched: number; lastTouchedChapter: number } => Boolean(item));
}

/** 从引擎结果合并「伏笔/线索待收口」：伏笔=staleHookWarnings、线索=staleThreadWarnings，按停滞最久排前。容错、无则空。 */
function readStaleThreadWarnings(root: Record<string, unknown>): { kind: string; title: string; chaptersSinceTouched: number; lastTouchedChapter: number }[] {
  return [
    ...readStaleWarningArray(root.staleHookWarnings, "伏笔"),
    ...readStaleWarningArray(root.staleThreadWarnings, "线索"),
  ].sort((a, b) => b.chaptersSinceTouched - a.chaptersSinceTouched);
}

function readFirstString(...values: unknown[]): string | undefined {
  const value = values.find((item): item is string => typeof item === "string" && item.trim().length > 0);
  return cleanUiText(value);
}

function fallbackCandidateId(record: Record<string, unknown>): string {
  const name = typeof record.name === "string" ? record.name : "candidate";
  const evidence = typeof record.evidence === "string" ? record.evidence : "";
  return `${name}:${evidence}`.slice(0, 120);
}

function readCandidates(value: unknown): CommitPreviewCandidate[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const record = asRecord(item);
    const severity = typeof record.severity === "string" && ["info", "warning", "error", "high"].includes(record.severity)
      ? record.severity as "info" | "warning" | "error" | "high"
      : undefined;
    return {
      id: cleanUiText(typeof record.id === "string" ? record.id : undefined) ?? fallbackCandidateId(record),
      name: cleanUiText(typeof record.name === "string" ? record.name : "未命名候选") ?? "未命名候选",
      targetId: cleanUiText(typeof record.targetId === "string" ? record.targetId : undefined),
      changeType: cleanUiText(typeof record.changeType === "string" ? record.changeType : undefined),
      before: cleanUiText(typeof record.before === "string" ? record.before : undefined),
      after: cleanUiText(typeof record.after === "string" ? record.after : undefined),
      evidence: cleanUiText(typeof record.evidence === "string" ? record.evidence : undefined),
      severity,
      requiresUserConfirm: typeof record.requiresUserConfirm === "boolean" ? record.requiresUserConfirm : undefined,
    };
  });
}

function formatTimelineChange(value: unknown): string | undefined {
  const record = asRecord(value);
  const summary = typeof record.summary === "string" ? record.summary : undefined;
  const mainEvent = typeof record.mainEvent === "string" ? record.mainEvent : undefined;
  const chapter = typeof record.chapter === "number" ? `第${record.chapter}章` : undefined;
  return compactStrings([chapter, mainEvent ?? summary]).join("：") || undefined;
}

function formatChangeList(value: unknown, fallbackLabel: string): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const record = asRecord(item);
    const title = readFirstString(record.title, record.name, fallbackLabel);
    const detail = readFirstString(record.goal, record.status, record.progress, record.type, record.emotion, record.evidence);
    return compactStrings([title, detail]).join(" · ");
  }).filter(Boolean);
}

function formatWorldChanges(value: unknown): string[] {
  const record = asRecord(value);
  return compactStrings([
    typeof record.currentStage === "string" ? `阶段：${record.currentStage}` : undefined,
    typeof record.currentObjective === "string" ? `目标：${record.currentObjective}` : undefined,
    typeof record.currentLocation === "string" ? `地点：${record.currentLocation}` : undefined,
  ]);
}

function toCommitPreviewUiReport(value: unknown): CommitPreviewUiReport {
  const root = asRecord(value);
  const plan = asRecord(root.commitPlan);
  return {
    passed: typeof root.passed === "boolean" ? root.passed : undefined,
    highRiskIssueCount: typeof root.highRiskIssueCount === "number" ? root.highRiskIssueCount : undefined,
    requiresExplicitOverride: typeof root.requiresExplicitOverride === "boolean" ? root.requiresExplicitOverride : undefined,
    blockingReasons: readStringArray(root.blockingReasons),
    issues: readStringArray(root.issues),
    nameDriftFindings: readNameDriftFindings(root.nameDriftFindings),
    staleThreadWarnings: readStaleThreadWarnings(root),
    timelineChange: formatTimelineChange(plan.timelineEvent),
    hookChanges: formatChangeList(plan.hookUpdates, "伏笔"),
    threadChanges: formatChangeList(plan.threadUpdates ?? root.threadTrackingUpdates, "线索"),
    arcGoalChanges: formatChangeList(plan.arcGoalUpdates ?? root.arcGoalUpdates, "主线"),
    characterChanges: formatChangeList(plan.characterUpdates, "角色"),
    worldChanges: formatWorldChanges(plan.worldUpdate),
    assetChanges: {
      newAssetCandidates: readCandidates(asRecord(root.assetChanges).newAssetCandidates),
      assetStatusChanges: readCandidates(asRecord(root.assetChanges).assetStatusChanges),
      assetUsageEvidence: readCandidates(asRecord(root.assetChanges).assetUsageEvidence),
      unregisteredAssetWarnings: readCandidates(asRecord(root.assetChanges).unregisteredAssetWarnings),
    },
    locationChanges: {
      newLocationCandidates: readCandidates(asRecord(root.locationChanges).newLocationCandidates),
      locationTransitionCandidates: readCandidates(asRecord(root.locationChanges).locationTransitionCandidates),
      spatialViolationWarnings: readCandidates(asRecord(root.locationChanges).spatialViolationWarnings),
    },
    characterKnowledgeChanges: {
      stateChanges: readCandidates(asRecord(root.characterKnowledgeChanges).stateChanges),
      knowledgeKnownChanges: readCandidates(asRecord(root.characterKnowledgeChanges).knowledgeKnownChanges),
      knowledgeUnknownChanges: readCandidates(asRecord(root.characterKnowledgeChanges).knowledgeUnknownChanges),
      characterMatrixCandidates: readCandidates(asRecord(root.characterKnowledgeChanges).characterMatrixCandidates),
      forbiddenRevealTouches: readCandidates(asRecord(root.characterKnowledgeChanges).forbiddenRevealTouches),
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Commit selection helpers                                           */
/* ------------------------------------------------------------------ */

function allAssetPreviewCandidates(preview: CommitPreviewUiReport): readonly CommitPreviewCandidate[] {
  return [
    ...preview.assetChanges.newAssetCandidates,
    ...preview.assetChanges.assetStatusChanges,
    ...preview.assetChanges.assetUsageEvidence,
    ...preview.assetChanges.unregisteredAssetWarnings,
  ];
}

function allLocationPreviewCandidates(preview: CommitPreviewUiReport): readonly CommitPreviewCandidate[] {
  return [
    ...preview.locationChanges.newLocationCandidates,
    ...preview.locationChanges.locationTransitionCandidates,
    ...preview.locationChanges.spatialViolationWarnings,
  ];
}

function allCharacterKnowledgePreviewCandidates(preview: CommitPreviewUiReport): readonly CommitPreviewCandidate[] {
  return [
    ...preview.characterKnowledgeChanges.stateChanges,
    ...preview.characterKnowledgeChanges.knowledgeKnownChanges,
    ...preview.characterKnowledgeChanges.knowledgeUnknownChanges,
    ...preview.characterKnowledgeChanges.characterMatrixCandidates,
    ...preview.characterKnowledgeChanges.forbiddenRevealTouches,
  ];
}

function initialCommitSelections(preview: CommitPreviewUiReport): CommitSelectiveConfirmationState {
  const defaultSelections = (candidates: readonly CommitPreviewCandidate[]): Record<string, CommitSelectiveDecisionState> =>
    Object.fromEntries(candidates.map((candidate) => [candidate.id, shouldAcceptByDefault(candidate) ? "accept" as const : "defer" as const]));
  return {
    assets: defaultSelections(allAssetPreviewCandidates(preview)),
    locations: defaultSelections(allLocationPreviewCandidates(preview)),
    characterKnowledge: defaultSelections(allCharacterKnowledgePreviewCandidates(preview)),
  };
}

function shouldAcceptByDefault(candidate: CommitPreviewCandidate): boolean {
  if (candidate.severity === "high" || candidate.severity === "error") return false;
  return candidate.changeType === "new_asset_candidate"
    || candidate.changeType === "new_location_candidate"
    || candidate.changeType === "character_matrix_candidate";
}

function revisionIssueConstraints(issue?: DraftAIReviewIssue): readonly string[] {
  if (!issue) return [];
  const description = cleanUiText(issue.description);
  const evidence = cleanUiText(issue.evidence);
  return compactStrings([
    description ? `问题说明：${description.slice(0, 220)}` : undefined,
    evidence ? `内容审阅证据：${evidence.slice(0, 260)}` : undefined,
  ]);
}

function buildCommitQualityGate(input: {
  readonly draftConfirmed: number;
  readonly draftNeedsConfirmation: number;
  readonly semanticConfirmed: number;
  readonly semanticNeedsConfirmation: number;
}): CommitPreviewUiReport["qualityGate"] | undefined {
  const blockingCount = input.draftConfirmed + input.draftNeedsConfirmation + input.semanticConfirmed + input.semanticNeedsConfirmation;
  if (blockingCount <= 0) return undefined;
  return {
    blockingCount,
    draftConfirmed: input.draftConfirmed,
    draftNeedsConfirmation: input.draftNeedsConfirmation,
    semanticConfirmed: input.semanticConfirmed,
    semanticNeedsConfirmation: input.semanticNeedsConfirmation,
    message: `仍有 ${blockingCount} 个确认/待确认质检项。可以直接定稿（写入前会自动快照，可撤销），也可以先修订后重新预览。`,
  };
}

function toApiSelectiveConfirmation(selections: CommitSelectiveConfirmationState): CommitSelectiveConfirmation {
  const toDecisions = (items: Readonly<Record<string, CommitSelectiveDecisionState>>) =>
    Object.entries(items).map(([candidateId, state]) => ({ candidateId, state }));
  return {
    assetDecisions: toDecisions(selections.assets),
    locationDecisions: toDecisions(selections.locations),
    characterKnowledgeDecisions: toDecisions(selections.characterKnowledge),
  };
}

function readCommitPreviewApplyCredentials(preview: CommitPreviewUiReport): { readonly transactionId: string; readonly previewHash: string } | null {
  const transactionId = preview.transactionId ?? preview.transaction?.transactionId;
  const previewHash = preview.previewHash ?? preview.transaction?.previewHash;
  if (!transactionId || !previewHash) return null;
  return { transactionId, previewHash };
}

function buildUiCommitApplyIdempotencyKey(input: {
  readonly chapter: number;
  readonly transactionId: string;
  readonly previewHash: string;
}): string {
  // Stable for the lifetime of one preview transaction. A response-loss retry
  // must reach the server with the same key instead of looking like a new write.
  return `ui-v0-commit-apply-${input.chapter}-${input.transactionId}-${input.previewHash}`;
}

function missingCommitPreviewCredentialsMessage(): string {
  return "定稿预览缺少事务凭证，请重新生成定稿预览后再确认定稿。";
}

/* ------------------------------------------------------------------ */
/*  Hook interface                                                     */
/* ------------------------------------------------------------------ */

export interface UseWorkflowActionsParams {
  projectPath: string | null;
  resolveChapterDirection: (value?: unknown) => string;
  appendMessage: (message: ChapterMessage) => void;
  appendWorkflowPrompt: (state: ChapterWorkflowState, content?: string) => void;
  applyOverviewToWorkspace: (
    overview: StateOverview,
    draftContent?: string,
    flowStatus?: ChapterWorkflowState,
    draftTitle?: string,
    // 写类工具回传的「本次实际操作章号」——前端认领以推进当前章，修跨章草稿污染。
    targetChapter?: number,
  ) => void;
  /** 把当前草稿直接持久化（写 drafts/fast 草稿文件 + 工作区快照）。 */
  saveDraftChanges?: () => Promise<void>;
}

/* ------------------------------------------------------------------ */
/*  Hook implementation                                                */
/* ------------------------------------------------------------------ */

export function useWorkflowActions(params: UseWorkflowActionsParams) {
  const { projectPath, resolveChapterDirection, appendMessage, appendWorkflowPrompt, applyOverviewToWorkspace, saveDraftChanges } = params;

  const currentOperationIdentity = () => {
    const store = useWorkspaceStore.getState();
    return {
      projectPath: useNavigationStore.getState().projectPath ?? "",
      chapter: store.workspace.currentChapter.chapterNumber,
      sessionId: store.activeSessionId,
    };
  };

  const beginOwnedOperation = (kind: WorkspaceOperationKind): WorkspaceOperationToken | null => {
    if (!projectPath) return null;
    if (useNavigationStore.getState().projectPath !== projectPath) {
      useNavigationStore.getState().showToast("你切换了书，那个操作没有启动。", 4200);
      return null;
    }
    const token = beginWorkspaceOperation(kind, {
      projectPath,
      chapter: useWorkspaceStore.getState().workspace.currentChapter.chapterNumber,
      sessionId: useWorkspaceStore.getState().activeSessionId,
    });
    if (!token) {
      useNavigationStore.getState().showToast("已有写作操作正在进行，请等它结束后再试。", 4200);
    }
    return token;
  };

  const ownsCurrentWorkspace = (token: WorkspaceOperationToken): boolean =>
    isWorkspaceOperationTargetCurrent(token, currentOperationIdentity());

  const notifyStaleOperation = (): void => {
    useNavigationStore.getState().showToast("你切换了书，那次结果没有写进当前章节。", 5000);
  };

  const finishOwnedOperation = (token: WorkspaceOperationToken): void => {
    if (!isWorkspaceOperationCurrent(token)) return;
    if (ownsCurrentWorkspace(token)) {
      useWorkspaceStore.getState().setDraftActionLoading(null);
    }
    finishWorkspaceOperation(token);
  };

  const finishOwnedSteeringOperation = (token: WorkspaceOperationToken): void => {
    if (!isWorkspaceOperationCurrent(token)) return;
    if (ownsCurrentWorkspace(token)) useWorkspaceStore.getState().setSteeringLoading(false);
    finishWorkspaceOperation(token);
  };

  const startAgentFlow = (input: {
    readonly messageId: string;
    readonly kind: ChapterAgentCard["kind"];
    readonly agentName: string;
    readonly title: string;
    readonly summary: string;
    readonly detail?: readonly string[];
  }): string => {
    appendMessage({
      id: input.messageId,
      role: "system",
      content: `${input.title}。`,
      agentCards: [completedAgentCard({
        id: input.messageId.replace(/^assistant-/u, "agent-"),
        kind: input.kind,
        agentName: input.agentName,
        status: "running",
        title: input.title,
        summary: input.summary,
        detail: input.detail,
      })],
    });
    return input.messageId;
  };

  const updateAgentFlow = (messageId: string, input: {
    readonly role?: ChapterMessage["role"];
    readonly content: string;
    readonly card: ChapterAgentCard;
    readonly suggestedActions?: ChapterMessage["suggestedActions"];
    readonly toolOutput?: readonly string[];
    /** REST 深度审稿成功时挂到消息上，供时间线内折叠卡渲染（不再靠钉底 draftAIReview）。 */
    readonly aiReviewReport?: ChapterMessage["aiReviewReport"];
  }): void => {
    useWorkspaceStore.getState().updateMessage(messageId, (current) => ({
      ...current,
      role: input.role ?? current.role,
      content: input.content,
      agentCards: [input.card],
      ...(input.suggestedActions ? { suggestedActions: input.suggestedActions } : {}),
      ...(input.toolOutput ? { toolOutput: input.toolOutput } : {}),
      ...(input.aiReviewReport ? { aiReviewReport: input.aiReviewReport } : {}),
    }));
  };

  const failAgentFlow = (messageId: string, input: {
    readonly kind: ChapterAgentCard["kind"];
    readonly agentName: string;
    readonly title: string;
    readonly error: unknown;
  }): void => {
    const message = input.error instanceof Error ? input.error.message : String(input.error);
    updateAgentFlow(messageId, {
      content: `${input.title}失败：${message}`,
      card: completedAgentCard({
        id: messageId.replace(/^assistant-/u, "agent-"),
        kind: input.kind,
        agentName: input.agentName,
        status: "failed",
        title: `${input.title}失败`,
        summary: message,
      }),
    });
  };

  /* -------------------------------------------------------------- */
  /*  generateSteering  (App.tsx 1001-1042)                         */
  /* -------------------------------------------------------------- */

  const generateSteering = async (directionOverride?: unknown): Promise<void> => {
    const direction = resolveChapterDirection(directionOverride);
    const ws = useWorkspaceStore.getState();

    if (!projectPath) {
      ws.setSteeringError("请先从首页打开一个真实 StoryEngine 项目。");
      return;
    }
    if (!direction) {
      ws.setSteeringError("请先输入本章方向。");
      appendMessage({
        id: `assistant-direction-needed-${Date.now()}`,
        role: "assistant",
        content: "可以生成本章方案，但我还需要一个本章方向。请补一句这章要写什么。",
      });
      return;
    }

    const operation = beginOwnedOperation("generate-steering");
    if (!operation) return;
    ws.setSteeringLoading(true);
    ws.setSteeringError(null);
    try {
      const draft = await fetchChapterSteering({
        projectPath,
        userDirection: direction,
        chapter: operation.chapter,
        pacing: "medium",
        revealLevel: "small",
        maxSuggestions: 6,
      });
      if (!ownsCurrentWorkspace(operation)) {
        notifyStaleOperation();
        return;
      }
      const s = useWorkspaceStore.getState();
      s.setSteeringDraft(draft);
      s.setWorkspace({ ...s.workspace, flowStatus: "steering_ready" });
      s.setLastChapterDirection(direction);
      appendMessage({
        id: `assistant-steering-${Date.now()}`,
        role: "assistant",
        content: workflowPromptText("steering_ready"),
        agentCards: [completedAgentCard({
          id: "agent-steering",
          kind: "steering",
          agentName: "chapterSteeringAgent",
          title: "本章方案已生成",
          summary: `根据你的方向整理了第 ${s.workspace.currentChapter.chapterNumber} 章写作方案。`,
          detail: [
            `建议数：${draft.suggestions.length}`,
            `本章目标：${draft.generatedChapterGoalPreview}`,
            "未写正式状态",
          ],
        })],
        suggestedActions: actionsForWorkflowState("steering_ready"),
      });
    } catch (error) {
      if (!ownsCurrentWorkspace(operation)) {
        notifyStaleOperation();
        return;
      }
      useWorkspaceStore.getState().setSteeringError(error instanceof Error ? error.message : String(error));
    } finally {
      finishOwnedSteeringOperation(operation);
    }
  };

  /* -------------------------------------------------------------- */
  /*  handleGenerateDraft  (App.tsx 1044-1143)                      */
  /* -------------------------------------------------------------- */

  const handleGenerateDraft = async (
    chapterGoalOverride?: string,
    options: {
      readonly errorTarget?: "chat" | "steering";
      readonly progressMessageId?: string;
      // 「写这一章」按钮直写：没显式方向/方案时用这个题材中立默认目标兜底，直接出稿——
      // 不再因「没方向」落到「方案整理失败」（Kimi/Qwen 两轮真机都中）。见 resolveDirectWriteChapterGoal。
      readonly fallbackGoalWhenEmpty?: string;
    } = {},
  ): Promise<void> => {
    const ws = useWorkspaceStore.getState();

    if (!projectPath) {
      const message = "请先打开或创建一个项目。";
      if (options.errorTarget === "chat") ws.setChatError(message);
      else ws.setSteeringError(message);
      return;
    }

    const explicitGoal = (chapterGoalOverride
      ?? ws.steeringDraft?.generatedChapterGoalPreview
      ?? `${ws.steeringDirection.trim()}${buildSelectedAdvicePlan(ws.selectedAdviceCards)}`).trim();
    const chapterGoal = explicitGoal || (options.fallbackGoalWhenEmpty ?? "").trim();
    if (!chapterGoal) {
      const message = "请先输入本章方向，或先整理本章方案。";
      if (options.errorTarget === "chat") ws.setChatError(message);
      else ws.setSteeringError(message);
      return;
    }
    const operation = beginOwnedOperation("generate-draft");
    if (!operation) return;
    ws.setDraftActionLoading("generate-draft");
    // 出稿一开始就切到写作台，让用户看着正文流式出现（确定性按钮路也与 agent 路一致）。
    useNavigationStore.getState().requestCenterView("desk");
    ws.setCommitPreviewReport(null);
    ws.setDraftAIReview(null);
    ws.setActiveRevisionTask(null);
    ws.setActiveRevisionPreview(null);

    const chapter = ws.workspace.currentChapter.chapterNumber;
    const savedBeforeGeneration = ws.workspace.draft.content;
    const previousFlowStatus = ws.workspace.flowStatus;
    const progressMessageId = options.progressMessageId ?? `assistant-draft-progress-${Date.now()}`;
    const shouldAppendProgressMessage = !options.progressMessageId;

    try {
      const s1 = useWorkspaceStore.getState();
      s1.setWorkspace({
        ...s1.workspace,
        flowStatus: "draft_generating",
        draft: {
          ...s1.workspace.draft,
          chapterNumber: chapter,
          title: s1.workspace.draft.title === `第${chapter}章` ? "生成中" : s1.workspace.draft.title,
          content: "",
          savedContent: savedBeforeGeneration,
          status: "draft",
          wordCount: 0,
        },
      });
      const startingCard = draftAgentProgressCard({
        status: "running",
        title: "调取信息中",
        summary: "正在读取故事状态、章节方向和写作约束。",
        detail: ["准备构建本章写作上下文"],
      });
      if (shouldAppendProgressMessage) {
        appendMessage({
          id: progressMessageId,
          role: "system",
          content: "正文写作流程已启动。",
          agentCards: [startingCard],
        });
      } else {
        s1.updateMessage(progressMessageId, (current) => ({
          ...current,
          content: current.content || "正文写作流程已启动。",
          agentCards: [startingCard],
        }));
      }

      let streamedContent = "";
      let writingCardShown = false;
      await generateDraftStream(
        { projectPath, chapter, chapterGoal },
        {
          onStatus(message) {
            if (!ownsCurrentWorkspace(operation)) return;
            const store = useWorkspaceStore.getState();
            store.updateMessage(progressMessageId, (current) => ({
              ...current,
              content: "正文写作流程执行中。",
              agentCards: [draftAgentProgressCard({
                status: "running",
                title: "调取信息中",
                summary: message,
                detail: ["正在构建上下文或等待模型开始输出"],
              })],
            }));
            store.setChatError(null);
            store.setSteeringError(null);
            store.setWorkspace({
              ...store.workspace,
              draft: {
                ...store.workspace.draft,
                content: streamedContent,
                savedContent: savedBeforeGeneration,
                wordCount: countTextWords(streamedContent),
              },
            });
          },
          onDelta(delta) {
            if (!ownsCurrentWorkspace(operation)) return;
            if (!writingCardShown) {
              writingCardShown = true;
              useWorkspaceStore.getState().updateMessage(progressMessageId, (current) => ({
                ...current,
                content: "正文写作流程执行中。",
                agentCards: [draftAgentProgressCard({
                  status: "running",
                  title: "写作中",
                  summary: "模型正在流式生成正文，左侧工作稿区会同步更新。",
                  detail: [
                    "已完成上下文构建",
                    "正在接收正文内容",
                    "未写正式故事状态",
                  ],
                })],
              }));
            }
            streamedContent += delta;
            const store = useWorkspaceStore.getState();
            store.setWorkspace({
              ...store.workspace,
              draft: {
                ...store.workspace.draft,
                content: streamedContent,
                savedContent: savedBeforeGeneration,
                wordCount: countTextWords(streamedContent),
                status: "draft",
              },
            });
          },
          onDone(result) {
            if (!ownsCurrentWorkspace(operation)) return;
            // 认领本次出稿章号（与 SSE agent 路径同口径），杜绝跨章污染。
            applyOverviewToWorkspace(result.overview, result.draftContent, "draft_ready", result.draftTitle, chapter);
            useWorkspaceStore.getState().updateMessage(progressMessageId, (current) => ({
              ...current,
              content: "正文写作流程完成。",
              agentCards: [completedAgentCard({
                id: "agent-fast-draft",
                kind: "draft",
                agentName: "fastDraftAgent",
                title: "正文工作稿已生成",
                summary: `已生成第 ${chapter} 章工作稿，并自动保存。`,
                detail: [
                  `标题：${result.draftTitle ?? extractDraftTitle(result.draftContent) ?? "未生成"}`,
                  `长度：${result.draftContent.length} 字符`,
                  `目标文件：drafts/fast/chapter-${String(chapter).padStart(4, "0")}.md`,
                  "未写正式状态",
                ],
              })],
              toolOutput: [
                "buildWriterContext: 已构建章节写作上下文",
                "renderFastDraftPromptText: 已生成 FastDraft prompt",
                "fastDraft stream: 已接收模型流式正文",
                `draft target file: drafts/fast/chapter-${String(chapter).padStart(4, "0")}.md`,
                `draft title: ${result.draftTitle ?? extractDraftTitle(result.draftContent) ?? "未生成"}`,
                `draft length: ${result.draftContent.length} 字符`,
              ],
            }));
          },
        },
      );

      if (!ownsCurrentWorkspace(operation)) {
        notifyStaleOperation();
        return;
      }
      appendMessage({
        id: `assistant-draft-${Date.now()}`,
        role: "assistant",
        content: workflowPromptText("draft_ready"),
        suggestedActions: actionsForWorkflowState("draft_ready"),
      });
      // Persisting after a successful generation must not fall into the main
      // catch: that would roll the draft back to its pre-generation content and
      // mark the whole flow as failed over a transient save error. The debounced
      // auto-save channel retries persistence, so a soft toast is enough here.
      try {
        await saveDraftChanges?.();
      } catch {
        useNavigationStore.getState().showToast("工作稿已生成，但自动保存失败，稍后会自动重试。", 5200);
      }
    } catch (error) {
      if (!ownsCurrentWorkspace(operation)) {
        notifyStaleOperation();
        return;
      }
      const msg = error instanceof Error ? error.message : String(error);
      const failedStore = useWorkspaceStore.getState();
      failedStore.setWorkspace({
        ...failedStore.workspace,
        flowStatus: previousFlowStatus,
        draft: {
          ...failedStore.workspace.draft,
          content: savedBeforeGeneration,
          savedContent: savedBeforeGeneration,
          wordCount: countTextWords(savedBeforeGeneration),
          status: "draft",
        },
      });
      failedStore.updateMessage(progressMessageId, (current) => ({
        ...current,
        content: `正文写作流程失败：${msg}`,
        agentCards: [draftAgentProgressCard({
          status: "failed",
          title: "正文工作稿未写入",
          summary: msg,
          detail: [
            "已恢复生成前的工作稿内容",
            "未写正式故事状态",
          ],
        })],
      }));
      if (options.errorTarget === "chat") useWorkspaceStore.getState().setChatError(msg);
      else useWorkspaceStore.getState().setSteeringError(msg);
    } finally {
      finishOwnedOperation(operation);
    }
  };

  /* -------------------------------------------------------------- */
  /*  handleQualityCheck  (App.tsx 1145-1167)                       */
  /* -------------------------------------------------------------- */

  const handleQualityCheck = async (): Promise<void> => {
    if (!projectPath) return;
    const ws = useWorkspaceStore.getState();
    // #4：占位/空草稿不质检——否则会显示「质检完成」把占位当真稿（Kimi 真机）。诚实拦下、指路写正文。
    if (!isRealDraftContent(ws.workspace.draft.content)) {
      useNavigationStore.getState().showToast("这一章还没有正文，没法质检。请先点「写这一章」生成正文，再来质检。", 4600);
      return;
    }
    const operation = beginOwnedOperation("quality-check");
    if (!operation) return;
    ws.setDraftActionLoading("quality-check");
    const messageId = startAgentFlow({
      messageId: `assistant-quality-progress-${Date.now()}`,
      kind: "quality",
      agentName: "qualityAgent",
      title: "质检 Agent 运行中",
      summary: "正在收集规则候选，并调用质量模型做上下文判定。",
      detail: ["收集候选中", "AI 判定中"],
    });
    try {
      const quality = await checkDraftQuality({
        projectPath,
        chapter: operation.chapter,
        draftContent: ws.workspace.draft.content,
      });
      if (!ownsCurrentWorkspace(operation)) {
        notifyStaleOperation();
        return;
      }
      const qualitySummary = summarizeDraftQualityReport(quality);
      const s = useWorkspaceStore.getState();
      s.setWorkspace({ ...s.workspace, flowStatus: quality.passed ? "quality_checked" : "draft_ready" });
      updateAgentFlow(messageId, {
        role: "assistant",
        content: qualitySummary.content,
        card: completedAgentCard({
          id: messageId.replace(/^assistant-/u, "agent-"),
          kind: "quality",
          agentName: "qualityAgent",
          status: qualitySummary.cardStatus,
          title: qualitySummary.cardTitle,
          summary: `候选 ${quality.candidates?.length ?? quality.issues.length} 个；确认 ${qualitySummary.confirmed}，待确认 ${qualitySummary.needsConfirmation}，观察 ${qualitySummary.watch}，忽略 ${qualitySummary.dismissed}。`,
          detail: qualitySummary.cardDetail,
        }),
        suggestedActions: qualitySummary.confirmed === 0
          ? actionsForWorkflowState("quality_checked")
          : [suggestedAction("ai-review"), suggestedAction("generate-draft")],
      });
    } catch (error) {
      if (!ownsCurrentWorkspace(operation)) {
        notifyStaleOperation();
        return;
      }
      failAgentFlow(messageId, {
        kind: "quality",
        agentName: "qualityAgent",
        title: "质检 Agent",
        error,
      });
      useWorkspaceStore.getState().setSteeringError(error instanceof Error ? error.message : String(error));
    } finally {
      finishOwnedOperation(operation);
    }
  };

  /* -------------------------------------------------------------- */
  /*  handleDraftAIReview  (App.tsx 1169-1210)                      */
  /* -------------------------------------------------------------- */

  const handleDraftAIReview = async (): Promise<void> => {
    if (!projectPath) return;
    const ws = useWorkspaceStore.getState();
    // #4 同类：占位/空草稿不审稿——避免把占位当真稿审。诚实拦下、指路写正文。
    if (!isRealDraftContent(ws.workspace.draft.content)) {
      useNavigationStore.getState().showToast("这一章还没有正文，没法做内容审阅。请先点「写这一章」生成正文，再来做内容审阅。", 4600);
      return;
    }
    const operation = beginOwnedOperation("ai-review");
    if (!operation) return;
    ws.setDraftActionLoading("ai-review");
    const messageId = startAgentFlow({
      messageId: `assistant-ai-review-progress-${Date.now()}`,
      kind: "review",
      agentName: "reviewAgent",
      title: "内容审阅 Agent 运行中",
      summary: "正在读取工作稿、章节目标和质检结果，生成内容审阅报告。",
      detail: ["读取上下文中", "内容审阅中"],
    });
    try {
      const review = await reviewDraftWithAI({
        projectPath,
        chapter: operation.chapter,
        draftContent: ws.workspace.draft.content || undefined,
        chapterGoal: ws.steeringDraft?.generatedChapterGoalPreview,
        userDirection: ws.lastChapterDirection || ws.steeringDirection || undefined,
      });
      if (!ownsCurrentWorkspace(operation)) {
        notifyStaleOperation();
        return;
      }
      useWorkspaceStore.getState().setDraftAIReview(review);
      updateAgentFlow(messageId, {
        role: "assistant",
        content: [
          `AI 内容审阅完成：${verdictLabel(review.verdict)}，评分 ${review.score}/100。`,
          review.summary,
          review.verdict === "ready_to_commit"
            ? "可以继续生成定稿预览。"
            : review.verdict === "needs_minor_revision"
              ? "可以生成定稿预览，但建议先小修。"
              : "暂不建议直接定稿，请先查看内容审阅的问题和修改建议。",
        ].join("\n"),
        suggestedActions: review.verdict === "ready_to_commit" || review.verdict === "needs_minor_revision"
          ? [suggestedAction("commit-preview")]
          : [suggestedAction("generate-draft"), suggestedAction("quality-check")],
        card: completedAgentCard({
          id: messageId.replace(/^assistant-/u, "agent-"),
          kind: "review",
          agentName: "reviewAgent",
          title: "AI 内容审阅完成",
          summary: `${verdictLabel(review.verdict)}，评分 ${review.score}/100。`,
          detail: [
            `问题：${review.issues.length}`,
            `修改建议：${review.suggestedRevisions.length}`,
            "未修改工作稿，未写正式状态",
          ],
        }),
        toolOutput: [
          "draftAIReview: 已调用 AI 内容审阅",
          `verdict: ${review.verdict}`,
          `score: ${review.score}`,
          `issues: ${review.issues.length}`,
          `suggestions: ${review.suggestedRevisions.length}`,
          "safety: 未修改工作稿，未写正式状态",
        ],
        // 报告挂消息：时间线内折叠渲染；store.draftAIReview 仍写（分发/空态用），但展示不读它。
        aiReviewReport: review,
      });
    } catch (error) {
      if (!ownsCurrentWorkspace(operation)) {
        notifyStaleOperation();
        return;
      }
      failAgentFlow(messageId, {
        kind: "review",
        agentName: "reviewAgent",
        title: "内容审阅 Agent",
        error,
      });
      useWorkspaceStore.getState().setSteeringError(error instanceof Error ? error.message : String(error));
    } finally {
      finishOwnedOperation(operation);
    }
  };

  /* -------------------------------------------------------------- */
  /*  handleGenerateRevisionPreview  (App.tsx 1258-1292)            */
  /*  须排在 handleCreateRevisionTask 之前：创建任务后会立刻 fire-and-  */
  /*  forget 调本函数，靠声明顺序避免 const 暂死区。                    */
  /* -------------------------------------------------------------- */

  const handleGenerateRevisionPreview = async (): Promise<void> => {
    const nav = useNavigationStore.getState();
    const ws = useWorkspaceStore.getState();

    if (!projectPath || !ws.activeRevisionTask) {
      nav.showToast("请先创建修订任务。");
      return;
    }

    const operation = beginOwnedOperation("revision-preview");
    if (!operation) return;
    ws.setDraftActionLoading("revision-preview");
    const messageId = startAgentFlow({
      messageId: `assistant-revision-preview-progress-${Date.now()}`,
      kind: "revision",
      agentName: "revisionAgent",
      title: "修订 Agent 运行中",
      summary: "正在定位原文片段，并生成局部修订草案。",
      detail: ["定位原文中", "生成修订草案中"],
    });
    try {
      const result = await previewDraftRevision({
        projectPath,
        chapter: operation.chapter,
        task: ws.activeRevisionTask,
        draftContent: ws.workspace.draft.content,
      });
      if (!ownsCurrentWorkspace(operation)) {
        notifyStaleOperation();
        return;
      }
      const s = useWorkspaceStore.getState();
      s.setActiveRevisionTask(result.task);
      s.setActiveRevisionPreview({ ...result.preview, originTarget: operation });
      updateAgentFlow(messageId, {
        role: "assistant",
        content: "修订草案已生成。请查看原文 / 修订后的对比；确认后才会应用到工作稿。",
        card: completedAgentCard({
          id: messageId.replace(/^assistant-/u, "agent-"),
          kind: "revision",
          agentName: "revisionAgent",
          status: "needs_confirmation",
          title: "修订草案已生成",
          summary: result.preview.changeSummary,
          detail: [
            `风险提醒：${result.preview.riskNotes.length + result.preview.warnings.length}`,
            "等待确认后才应用到工作稿",
          ],
        }),
        suggestedActions: [{
          id: "revision-apply",
          label: "应用到工作稿",
          description: "只替换工作稿中的对应片段，不写已定稿版。",
          permission: "draft_write",
          requiresConfirmation: true,
          endpoint: "/api/draft/revision/apply",
        }],
      });
    } catch (error) {
      if (!ownsCurrentWorkspace(operation)) {
        notifyStaleOperation();
        return;
      }
      failAgentFlow(messageId, {
        kind: "revision",
        agentName: "revisionAgent",
        title: "修订 Agent",
        error,
      });
      useWorkspaceStore.getState().setChatError(error instanceof Error ? error.message : String(error));
    } finally {
      finishOwnedOperation(operation);
    }
  };

  /* -------------------------------------------------------------- */
  /*  handleCreateRevisionTask  (App.tsx 1212-1256)                 */
  /* -------------------------------------------------------------- */

  const handleCreateRevisionTask = (source: { readonly issue?: DraftAIReviewIssue; readonly suggestion?: DraftAIRevisionSuggestion }): void => {
    const ws = useWorkspaceStore.getState();
    const nav = useNavigationStore.getState();

    if (!ws.workspace.draft.content.trim()) {
      nav.showToast("当前没有可修订的工作稿。");
      return;
    }
    const target = resolveRevisionTarget(source, ws.workspace.draft.content);
    if (!target) {
      nav.showToast("无法自动定位原文片段。请先在内容审阅建议中选择更具体的问题，或把要修的段落发给我。", 4200);
      return;
    }
    if (target.guessed) {
      // B5：没精确定位到原句、按类目猜了一段——明确提示用户核对，不静默改错段。
      nav.showToast("没能精确定位到要修的原句，已按猜测选了一段。请在下方预览里核对是不是这段，不是就把原句发给我重定位。", 4600);
    }

    const task: DraftRevisionTask = {
      id: `revision-${Date.now().toString(36)}`,
      ...(source.issue ? { sourceIssueId: source.issue.id } : {}),
      ...(source.suggestion ? { sourceSuggestionId: source.suggestion.id } : {}),
      chapter: ws.workspace.currentChapter.chapterNumber,
      targetType: target.targetType,
      targetText: target.targetText,
      problemSummary: source.issue?.title ?? source.suggestion?.target ?? "局部修订",
      revisionGoal: source.issue?.suggestedFix ?? source.suggestion?.suggestion ?? "根据内容审阅建议优化当前片段。",
      constraints: [
        "只修改选中的原文片段，不重写全文。",
        "不改变本章核心事件。",
        "不提前揭开隐藏真相。",
        "不新增未登记关键道具或地点。",
        ...revisionIssueConstraints(source.issue),
      ],
      status: "pending",
    };

    const s = useWorkspaceStore.getState();
    s.setActiveRevisionTask(task);
    s.setActiveRevisionPreview(null);
    appendMessage({
      id: `assistant-revision-task-${Date.now()}`,
      role: "assistant",
      content: "已创建修订任务，正在生成修订草案…可在写作台下方的预览弹窗查看对比",
      agentCards: [completedAgentCard({
        id: "agent-revision-task",
        kind: "revision",
        agentName: "revisionAgent",
        status: "needs_confirmation",
        title: "修订任务已准备",
        summary: task.problemSummary,
        detail: [
          `目标类型：${task.targetType}`,
          `修订目标：${task.revisionGoal}`,
          "正在生成修订草案，不直接写入",
        ],
      })],
    });
    // 对齐选区改写：创建任务后立刻触发生成，避免弹窗卡在假 loading 死路。
    void handleGenerateRevisionPreview();
  };

  /* -------------------------------------------------------------- */
  /*  handleApplyRevisionPreview  (App.tsx 1294-1321)               */
  /* -------------------------------------------------------------- */

  const handleApplyRevisionPreview = async (): Promise<void> => {
    const nav = useNavigationStore.getState();
    const ws = useWorkspaceStore.getState();

    if (!projectPath || !ws.activeRevisionPreview) {
      nav.showToast("请先生成修订草案。");
      return;
    }
    const revisionOrigin = (ws.activeRevisionPreview as { readonly originTarget?: WorkspaceOperationTarget }).originTarget;
    if (!revisionOrigin) {
      nav.showToast("这份修订预览缺少工作区归属，已拒绝应用。", 5000);
      return;
    }
    if (!workspaceOperationTargetMatches(revisionOrigin, currentOperationIdentity())) {
      nav.showToast("这份修订预览来自切换前的那本书，不能应用到当前章节。", 5000);
      return;
    }
    // P0-3 防御纵深：UI 零差异态可能被绕过；入口再拦一次，绝不假成功落盘。
    if (isRevisionZeroDiff(ws.activeRevisionPreview.beforeText, ws.activeRevisionPreview.afterText)) {
      nav.showToast("没有可应用的改动，工作稿未变");
      ws.setActiveRevisionTask(null);
      ws.setActiveRevisionPreview(null);
      return;
    }
    // B2：把这次「手动选区改写」的 before→after 留住，应用成功后写进对话记录——让 agent 不再对前端直改瞎眼
    // （两套改写体系彼此无感知的根因：路①前端 REST 改写应用后只刷工作区、不告诉 agent 改了什么）。
    const appliedPreview = ws.activeRevisionPreview;
    const { originTarget: _originTarget, ...revisionPreviewForApi } = ws.activeRevisionPreview;
    const brief = (text: string): string => {
      const s = text.replace(/\s+/gu, " ").trim();
      return s.length > 60 ? `${s.slice(0, 60)}…` : s;
    };

    const operation = beginOwnedOperation("revision-apply");
    if (!operation) return;
    ws.setDraftActionLoading("revision-apply");
    const messageId = startAgentFlow({
      messageId: `assistant-revision-apply-progress-${Date.now()}`,
      kind: "revision",
      agentName: "revisionAgent",
      title: "应用修订中",
      summary: "正在把已确认的局部修订写回工作稿。",
      detail: ["写入工作稿中", "刷新章节状态中"],
    });
    try {
      const result = await applyDraftRevision({
        projectPath,
        chapter: operation.chapter,
        preview: revisionPreviewForApi,
        // 目标级诚实守卫回传链：把任务里存着的用户点名片段带上——服务端在 apply 时的当前草稿上
        // 重新解析目标区间（解析不到 = 草稿已大变 → 诚实拒）；不回传 resolvedTarget，不信客户端字符串。
        ...(ws.activeRevisionTask?.targetText ? { targetText: ws.activeRevisionTask.targetText } : {}),
      });
      if (!ownsCurrentWorkspace(operation)) {
        notifyStaleOperation();
        return;
      }
      applyOverviewToWorkspace(
        result.overview,
        result.draftContent,
        "draft_ready",
        extractDraftTitle(result.draftContent) ?? ws.workspace.draft.title,
      );
      // 「刚改片段」黄高亮：用改写后的新文本作定位锚，正文里把刚改的那段标出来（WritingPaper 据此高亮）。
      ws.setRevisionHighlight(ws.activeRevisionPreview.afterText);
      // 体检「改掉这句」联动：若这次改写来自某条违规，应用成功后把它在卡片里标「已改 ✓」并清掉 pending。
      const pending = useWorkspaceStore.getState().aiFlavorPending;
      if (pending) {
        useWorkspaceStore.getState().markAiFlavorViolationFixed(pending.messageId, pending.violationId);
        useWorkspaceStore.getState().setAiFlavorPending(null);
      }
      updateAgentFlow(messageId, {
        role: "assistant",
        content:
          "已把选中的这段手动改写并应用到工作稿（只动工作稿正文，已定稿版未变）：\n"
          + `· 原文：「${brief(appliedPreview.beforeText)}」\n`
          + `· 改为：「${brief(appliedPreview.afterText)}」\n`
          + "（这是在编辑器里手动改的，后续涉及这段以改写后为准。）建议重新质检或再次内容审阅。",
        card: completedAgentCard({
          id: messageId.replace(/^assistant-/u, "agent-"),
          kind: "revision",
          agentName: "revisionAgent",
          title: "修订已应用到工作稿",
          summary: "已替换工作稿中对应片段。",
          detail: ["未写正式状态", "建议重新质检或内容审阅"],
        }),
        suggestedActions: [suggestedAction("quality-check"), suggestedAction("ai-review"), suggestedAction("commit-preview")],
      });
      const s = useWorkspaceStore.getState();
      s.setActiveRevisionTask(null);
      s.setActiveRevisionPreview(null);
    } catch (error) {
      if (!ownsCurrentWorkspace(operation)) {
        notifyStaleOperation();
        return;
      }
      failAgentFlow(messageId, {
        kind: "revision",
        agentName: "revisionAgent",
        title: "应用修订",
        error,
      });
      useWorkspaceStore.getState().setChatError(error instanceof Error ? error.message : String(error));
    } finally {
      finishOwnedOperation(operation);
    }
  };

  /* -------------------------------------------------------------- */
  /*  handleDismissRevisionTask  (App.tsx 1323-1327)                */
  /* -------------------------------------------------------------- */

  const handleDismissRevisionTask = (): void => {
    const ws = useWorkspaceStore.getState();
    const current = ws.activeRevisionTask;
    ws.setActiveRevisionTask(current ? { ...current, status: "dismissed" } : null);
    ws.setActiveRevisionTask(null);
    ws.setActiveRevisionPreview(null);
    ws.setAiFlavorPending(null); // 放弃改写：清掉「在改哪条违规」，卡片那条回到「待改」。
  };

  /* -------------------------------------------------------------- */
  /*  handleCommitPreview  (App.tsx 1329-1361)                      */
  /* -------------------------------------------------------------- */

  const handleCommitPreview = async (): Promise<void> => {
    if (!projectPath) return;
    const ws = useWorkspaceStore.getState();
    const operation = beginOwnedOperation("commit-preview");
    if (!operation) return;
    ws.setDraftActionLoading("commit-preview");
    const messageId = startAgentFlow({
      messageId: `assistant-commit-preview-progress-${Date.now()}`,
      kind: "commit",
      agentName: "commitPreviewAgent",
      title: "定稿预览 Agent 运行中",
      summary: "正在生成定稿计划、工作稿质检和语义承接检查。",
      detail: ["生成定稿计划中", "检查正式状态变更中"],
    });
    try {
      const preview = await previewCommit({
        projectPath,
        chapter: operation.chapter,
      });
      if (!ownsCurrentWorkspace(operation)) {
        notifyStaleOperation();
        return;
      }
      const nextCommitPreview = toCommitPreviewUiReport(preview.commitPlan);
      const draftQualitySummary = summarizeDraftQualityReport(preview.draftQuality);
      const draftActionableCount = draftQualitySummary.confirmed + draftQualitySummary.needsConfirmation;
      const draftQualityLine = `工作稿质检：待处理 ${draftActionableCount} 个，观察项 ${draftQualitySummary.watch} 个，已忽略 ${draftQualitySummary.dismissed} 个。`;
      const semanticQualitySummary = preview.semanticQuality ? summarizeDraftQualityReport(preview.semanticQuality) : null;
      const semanticActionableCount = semanticQualitySummary
        ? semanticQualitySummary.confirmed + semanticQualitySummary.needsConfirmation
        : 0;
      const semanticIssueCount = semanticQualitySummary
        ? semanticQualitySummary.confirmed + semanticQualitySummary.needsConfirmation + semanticQualitySummary.watch
        : 0;
      const qualityGate = buildCommitQualityGate({
        draftConfirmed: draftQualitySummary.confirmed,
        draftNeedsConfirmation: draftQualitySummary.needsConfirmation,
        semanticConfirmed: semanticQualitySummary?.confirmed ?? 0,
        semanticNeedsConfirmation: semanticQualitySummary?.needsConfirmation ?? 0,
      });
      // 质检门已降级为提示：qualityGate 仅供 UI 显示黄色提醒，不再拦截入库。
      const previewWithGate: CommitPreviewUiReport = {
        ...nextCommitPreview,
        transaction: preview.transaction,
        transactionId: preview.transactionId,
        previewHash: preview.previewHash,
        ...(qualityGate ? { qualityGate } : {}),
      };

      const s = useWorkspaceStore.getState();
      s.setCommitPreviewReport(previewWithGate);
      s.setCommitSelections(initialCommitSelections(previewWithGate));
      s.setWorkspace({ ...s.workspace, flowStatus: "waiting_commit_confirmation" });

      const nameDriftLine = previewWithGate.nameDriftFindings.length > 0
        ? `人物名一致性提醒：${previewWithGate.nameDriftFindings
            .map((finding) => `「${finding.driftedVariant}」疑似应为已确立角色「${finding.establishedName}」`)
            .join("；")}。请确认是否写错名字。`
        : "";
      const staleThreadLine = previewWithGate.staleThreadWarnings.length > 0
        ? `伏笔/线索待收口：${previewWithGate.staleThreadWarnings
            .map((warning) => `${warning.kind}「${warning.title}」已 ${warning.chaptersSinceTouched} 章没推进`)
            .join("；")}。考虑本章推进或收口。`
        : "";
      updateAgentFlow(messageId, {
        role: "assistant",
        content: [
          workflowPromptText("commit_preview_ready"),
          "",
          draftQualityLine,
          `语义承接问题 ${semanticIssueCount} 个，其中待处理 ${semanticActionableCount} 个。`,
          `高风险 ${previewWithGate.highRiskIssueCount ?? 0} 个，阻断项 ${previewWithGate.blockingReasons.length} 个。`,
          nameDriftLine,
          staleThreadLine,
          qualityGate ? `质检提示：${qualityGate.message}` : "",
          "",
          workflowPromptText("waiting_commit_confirmation"),
        ].join("\n"),
        card: completedAgentCard({
          id: messageId.replace(/^assistant-/u, "agent-"),
          kind: "commit",
          agentName: "commitPreviewAgent",
          status: "needs_confirmation",
          title: "定稿预览已生成",
          summary: qualityGate?.message ?? `高风险 ${previewWithGate.highRiskIssueCount ?? 0} 个，阻断项 ${previewWithGate.blockingReasons.length} 个。`,
          detail: [
            `工作稿质检待处理：${draftActionableCount}`,
            `工作稿观察项：${draftQualitySummary.watch}`,
            `已忽略候选：${draftQualitySummary.dismissed}`,
            `语义承接待处理：${semanticActionableCount}`,
            qualityGate ? "质检提示不拦截定稿，写入前会自动快照" : "确认后直接写入，可在快照中恢复",
          ],
        }),
        suggestedActions: actionsForWorkflowState("waiting_commit_confirmation"),
      });
    } catch (error) {
      if (!ownsCurrentWorkspace(operation)) {
        notifyStaleOperation();
        return;
      }
      failAgentFlow(messageId, {
        kind: "commit",
        agentName: "commitPreviewAgent",
        title: "定稿预览 Agent",
        error,
      });
      useWorkspaceStore.getState().setSteeringError(error instanceof Error ? error.message : String(error));
    } finally {
      finishOwnedOperation(operation);
    }
  };

  /* -------------------------------------------------------------- */
  /*  handleCommitApply  (App.tsx 1363-1371)                        */
  /* -------------------------------------------------------------- */

  const handleCommitApply = (): void => {
    void executeCommitApply();
  };

  /* -------------------------------------------------------------- */
  /*  executeCommitApply  (App.tsx 1373-1407)                       */
  /* -------------------------------------------------------------- */

  const executeCommitApply = async (): Promise<void> => {
    if (!projectPath) return;
    const ws = useWorkspaceStore.getState();
    if (ws.draftActionLoading === "commit-apply") {
      useNavigationStore.getState().showToast("定稿正在执行，请等待完成。", 4200);
      return;
    }
    if (!ws.commitPreviewReport) {
      useNavigationStore.getState().showToast("请先生成定稿预览。");
      return;
    }
    const previewCredentials = readCommitPreviewApplyCredentials(ws.commitPreviewReport);
    if (!previewCredentials) {
      useNavigationStore.getState().showToast(missingCommitPreviewCredentialsMessage(), 5200);
      return;
    }
    const operation = beginOwnedOperation("commit-apply");
    if (!operation) return;
    const chapter = operation.chapter;
    ws.setDraftActionLoading("commit-apply");
    const messageId = startAgentFlow({
      messageId: `assistant-commit-apply-progress-${Date.now()}`,
      kind: "commit",
      agentName: "commitApplyAgent",
      title: "定稿中",
      summary: "正在按你确认的选择写入正式章节正文。",
      detail: ["应用章节定稿计划中", "写入章节正文中"],
    });
    try {
      const result = await applyCommit({
        projectPath,
        chapter,
        transactionId: previewCredentials.transactionId,
        previewHash: previewCredentials.previewHash,
        idempotencyKey: buildUiCommitApplyIdempotencyKey({
          chapter,
          transactionId: previewCredentials.transactionId,
          previewHash: previewCredentials.previewHash,
        }),
        selectiveConfirmation: toApiSelectiveConfirmation(ws.commitSelections),
      });
      if (!ownsCurrentWorkspace(operation)) {
        notifyStaleOperation();
        return;
      }
      if (result.overview) {
        applyOverviewToWorkspace(result.overview, result.chapterContent, "committed", result.chapterTitle, chapter);
      } else {
        const store = useWorkspaceStore.getState();
        const current = store.workspace;
        const committedContent = result.chapterContent ?? current.draft.content;
        const committedTitle = result.chapterTitle ?? extractDraftTitle(committedContent) ?? `第${chapter}章`;
        store.updateWorkspace({
          flowStatus: "committed",
          currentChapter: {
            ...current.currentChapter,
            chapterNumber: chapter,
            title: committedTitle,
            hasCommittedChapter: true,
            hasDraftFile: true,
            hasWorkspaceSnapshot: true,
          },
          chapters: current.chapters.map((item) => item.chapterNumber === chapter
            ? { ...item, title: committedTitle, hasCommittedChapter: true, hasDraftFile: true, hasWorkspaceSnapshot: true }
            : item),
          draft: {
            ...current.draft,
            chapterNumber: chapter,
            title: committedTitle,
            content: committedContent,
            savedContent: committedContent,
            status: "committed",
            wordCount: committedContent.trim() ? countTextWords(committedContent) : undefined,
          },
        });
        useNavigationStore.getState().showToast("定稿已成功写入；资料概览刷新失败，稍后重新打开即可刷新。", 6000);
      }
      const commitSummary = summarizeCommitReport(result.report);

      const commitCard = completedAgentCard({
        id: messageId.replace(/^assistant-/u, "agent-"),
        kind: "commit",
        agentName: "commitApplyAgent",
        title: "定稿完成",
        summary: `第 ${operation.chapter} 章已定稿。`,
        detail: [
          `标题：${result.chapterTitle ?? extractDraftTitle(result.chapterContent) ?? `第${operation.chapter}章`}`,
          ...commitSummary.detailLines,
          ...(result.overview ? [] : ["资料概览刷新失败：定稿已成功，重新打开后会刷新资料视图。"]),
        ],
      });
      const commitMessage: ChapterMessage = {
        id: messageId,
        role: "assistant",
        content: `${workflowPromptText("committed")}\n\n${commitSummary.statusLine}`,
        agentCards: [commitCard],
        suggestedActions: actionsForWorkflowState("committed"),
      };
      updateAgentFlow(messageId, {
        role: commitMessage.role,
        content: commitMessage.content,
        card: commitCard,
        suggestedActions: commitMessage.suggestedActions,
      });

      if (result.chapterContent) {
        const s = useWorkspaceStore.getState();
        const request = prepareVersionedWorkspaceSave({
          projectPath,
          chapter: operation.chapter,
          messages: [...s.workspace.messages, commitMessage],
          selectedAdviceCardKeys: s.selectedAdviceCards.map((item) => item.key),
          flowStatus: "committed",
          draftContent: result.chapterContent,
          draftTitle: result.chapterTitle ?? extractDraftTitle(result.chapterContent) ?? `第${operation.chapter}章`,
        });
        const saved = await saveChapterWorkspace(request).catch(() => undefined);
        if (saved?.revision !== undefined) {
          recordWorkspaceRevision(projectPath, operation.chapter, saved.revision);
          const live = useWorkspaceStore.getState();
          if (useNavigationStore.getState().projectPath === projectPath
            && live.workspace.currentChapter.chapterNumber === operation.chapter) {
            live.setWorkspaceRevision(saved.revision);
          }
        }
      }
    } catch (error) {
      if (!ownsCurrentWorkspace(operation)) {
        notifyStaleOperation();
        return;
      }
      const errorCopy = summarizeFormalCommitApplyError(error);
      updateAgentFlow(messageId, {
        content: [errorCopy.message, "", ...errorCopy.detail].join("\n"),
        card: completedAgentCard({
          id: messageId.replace(/^assistant-/u, "agent-"),
          kind: "commit",
          agentName: "commitApplyAgent",
          status: errorCopy.severity === "danger" ? "failed" : "blocked",
          title: errorCopy.title,
          summary: errorCopy.message,
          detail: errorCopy.detail,
        }),
      });
      useWorkspaceStore.getState().setSteeringError(errorCopy.message);
    } finally {
      finishOwnedOperation(operation);
    }
  };

  /* -------------------------------------------------------------- */
  /*  handleCommitSelectionChange  (App.tsx 1409-1421)              */
  /* -------------------------------------------------------------- */

  const handleCommitSelectionChange = (
    scope: "assets" | "locations" | "characterKnowledge",
    candidateId: string,
    decisionState: CommitSelectiveDecisionState,
  ): void => {
    const ws = useWorkspaceStore.getState();
    ws.setCommitSelections({
      ...ws.commitSelections,
      [scope]: {
        ...ws.commitSelections[scope],
        [candidateId]: decisionState,
      },
    });
  };

  /* -------------------------------------------------------------- */
  /*  handleSelectionRewrite （阶段三块②：选区浮动操作条）           */
  /*  选中正文 → 点按钮（固定模板）→ 复用「审稿修订预览」流：             */
  /*  preview → 存进 activeRevisionTask/activeRevisionPreview → 出「改写前后对比卡」， */
  /*  用户在卡上点「应用到工作稿」才落盘（走 handleApplyRevisionPreview，写前快照=可撤销）。 */
  /*  不再直接 apply——治「点了不知改了啥」。失败就地明示、不乱改。               */
  /*  选区文本随 task.targetText 存进预览态，即使等待确认期间编辑器选区丢了也不受影响。 */
  /* -------------------------------------------------------------- */

  /**
   * 选区改写内核：选区文本 + 模板键（+ 可选 extraGoal）→ preview → 出「改写前后对比卡」、应用前快照可撤销。
   * handleSelectionRewrite（浮动操作条）与 handleFixAiFlavorViolation（体检「改掉这句」）都调它，
   * 行为完全一致——后者只是固定 key=deai 并把 violation.suggestedFix 作为 extraGoal 拼进改写目标。
   */
  const runSelectionRevision = async (
    selectionText: string,
    key: SelectionRevisionKey,
    extraGoal?: string,
    origin?: { readonly messageId: string; readonly violationId: string },
  ): Promise<void> => {
    const nav = useNavigationStore.getState();
    const ws = useWorkspaceStore.getState();
    const template = SELECTION_REVISION_TEMPLATES.find((item) => item.key === key);
    if (!projectPath) {
      nav.showToast("请先打开本地项目。");
      return;
    }
    if (ws.workspace.draft.status === "committed") {
      nav.showToast("本章已定稿，正文只读；如需修改请通过 AI 助手发起修订。");
      return;
    }
    const chapter = ws.workspace.currentChapter.chapterNumber;
    const task = buildSelectionRevisionTask({ selectionText, key, chapter, ...(extraGoal ? { extraGoal } : {}) });
    if (!task || !template) {
      nav.showToast("请先在正文里选中一段文字。");
      return;
    }
    const operation = beginOwnedOperation("selection-rewrite");
    if (!operation) return;
    // 改写预览框（RevisionPreviewModal）浮在中栏写作台上：体检卡的「改掉这句」是在右侧聊天点的，
    // 用户可能正停在资料中心，不切过去就看不到预览框＝以为卡死（Codex P1）。点了就把中间区切到写作台。
    // 浮动操作条路用户本就在写作台，这里是 no-op，安全共用。
    nav.requestCenterView("desk");
    // 点了立刻弹框进「正在改写」态——别等 previewDraftRevision 返回才建 task（否则框要等几秒才出现＝没反应）。
    ws.setActiveRevisionTask(task);
    ws.setActiveRevisionPreview(null);
    ws.setRevisionHighlight(null); // 新一次改写开始：先撤掉上一段「刚改片段」黄高亮。
    ws.setAiFlavorPending(origin ?? null); // 体检「改掉这句」带来源：记下「在改哪条违规」，应用成功后据它标已改、卡片显示「改写中…」。
    ws.setDraftActionLoading(`selection-rewrite-${key}`);
    const messageId = startAgentFlow({
      messageId: `assistant-selection-rewrite-progress-${Date.now()}`,
      kind: "revision",
      agentName: "revisionAgent",
      title: `${template.label} Agent 运行中`,
      summary: `正在${template.label}选中的段落，并生成前后对比草案。`,
      detail: ["定位选中片段中", "生成修订草案中"],
    });
    try {
      const previewResult = await previewDraftRevision({
        projectPath,
        chapter: operation.chapter,
        task,
        draftContent: ws.workspace.draft.content,
      });
      if (!ownsCurrentWorkspace(operation)) {
        notifyStaleOperation();
        return;
      }
      // 治 A.5：模型调用失败时 revision/preview 返回 200 + 安全兜底（afterText===beforeText 的 no-op）。
      // 绝不把 no-op 当成功、绝不谎报「已改写」——不出预览卡、诚实 toast 失败，原文未动、可重试。
      if (isNoOpRevisionPreview(previewResult.preview)) {
        failAgentFlow(messageId, {
          kind: "revision",
          agentName: "revisionAgent",
          title: template.label,
          error: new Error("模型未能改写（可能调用失败或超时），原文未改动。"),
        });
        nav.showToast(`${template.label}失败：模型未能改写（可能调用失败或超时），原文未改动，请重试。`, 5000);
        const fs = useWorkspaceStore.getState();
        fs.setActiveRevisionTask(null);   // 失败：关掉刚弹出的框
        fs.setActiveRevisionPreview(null);
        fs.setAiFlavorPending(null);
        return;
      }
      // 不直接 apply：把任务 + 预览存进「审稿修订预览」同一套状态，让 codex 出「改写前后对比卡」，
      // 用户在卡上点「应用到工作稿」才走 handleApplyRevisionPreview 落盘（写前快照=可撤销）。
      // task 里带着 targetText（=选区原文），即使等待确认期间编辑器选区丢了，apply/再改一版都不依赖即时选区。
      const s = useWorkspaceStore.getState();
      s.setActiveRevisionTask(previewResult.task);
      s.setActiveRevisionPreview({ ...previewResult.preview, originTarget: operation });
      updateAgentFlow(messageId, {
        role: "assistant",
        content: `已生成${template.label}草案。请在中间的写作台查看「原文 / 修订后」对比，确认后点「应用到工作稿」才会改正文。`,
        card: completedAgentCard({
          id: messageId.replace(/^assistant-/u, "agent-"),
          kind: "revision",
          agentName: "revisionAgent",
          status: "needs_confirmation",
          title: `${template.label}草案已生成`,
          summary: previewResult.preview.changeSummary,
          detail: [
            `风险提醒：${previewResult.preview.riskNotes.length + previewResult.preview.warnings.length}`,
            "等待确认后才应用到工作稿",
          ],
        }),
        suggestedActions: [{
          id: "revision-apply",
          label: "应用到工作稿",
          description: "只替换工作稿中的对应片段，不写已定稿版。",
          permission: "draft_write",
          requiresConfirmation: true,
          endpoint: "/api/draft/revision/apply",
        }],
      });
    } catch (error) {
      if (!ownsCurrentWorkspace(operation)) {
        notifyStaleOperation();
        return;
      }
      // 绝不静默、绝不乱改：原文未动，就地明示失败原因。
      failAgentFlow(messageId, {
        kind: "revision",
        agentName: "revisionAgent",
        title: template.label,
        error,
      });
      nav.showToast(`${template.label}失败：${error instanceof Error ? error.message : String(error)}`, 5000);
      const fs = useWorkspaceStore.getState();
      fs.setActiveRevisionTask(null);   // 失败：关掉刚弹出的框
      fs.setActiveRevisionPreview(null);
      fs.setAiFlavorPending(null);      // 治：体检「改掉这句」预览生成失败时，卡片别卡在「改写中…」。
    } finally {
      finishOwnedOperation(operation);
    }
  };

  // 浮动操作条入口：行为不变，直接转调内核（不传 extraGoal）。
  const handleSelectionRewrite = (selectionText: string, key: SelectionRevisionKey): Promise<void> =>
    runSelectionRevision(selectionText, key);

  // 「✎ 自己说」入口：用户的具体要求作为 extraGoal、走 custom 模板（基底安全框 + 用户要求拼成改写方向）。
  const handleSelectionRewriteCustom = (selectionText: string, instruction: string): Promise<void> =>
    runSelectionRevision(selectionText, "custom", instruction);

  // 体检「改掉这句」：复用同一改写内核，key 固定 deai，把这句的 suggestedFix 作为额外改写方向。
  // 带上来源（messageId + violationId）：应用成功后据它把卡片那条标「已改 ✓」、并在改写期间显示「改写中…」。
  const handleFixAiFlavorViolation = (
    violation: { readonly id: string; readonly text: string; readonly suggestedFix?: string },
    messageId: string,
  ): void => {
    void runSelectionRevision(violation.text, "deai", violation.suggestedFix, { messageId, violationId: violation.id });
  };

  // 体检「一键全修」：把卡片里还没改的违规一次批量去 AI 味（走 /api/draft/de-ai-flavor/apply 倒序落盘 + 整批快照）。
  // 诚实：只把真改掉的那几条标「已改 ✓」、按改后文本多处高亮；没改的不标、toast 如实报「改了 M / N」。
  const handleFixAiFlavorAll = async (
    violations: readonly { readonly id: string; readonly text: string; readonly reason?: string; readonly severity?: string; readonly suggestedFix?: string }[],
    messageId: string,
  ): Promise<void> => {
    const nav = useNavigationStore.getState();
    const ws = useWorkspaceStore.getState();
    if (!projectPath) { nav.showToast("请先打开本地项目。"); return; }
    if (ws.workspace.draft.status === "committed") {
      nav.showToast("本章已定稿，正文只读；如需修改请通过 AI 助手发起修订。");
      return;
    }
    if (violations.length === 0) { nav.showToast("没有待改的 AI 腔。"); return; }
    const operation = beginOwnedOperation("deai-fix-all");
    if (!operation) return;
    const chapter = operation.chapter;
    ws.setAiFlavorBatchPending(messageId);
    ws.setRevisionHighlight(null);
    ws.setDraftActionLoading("deai-fix-all");
    try {
      const resp = await applyDeAiFlavorBatch({
        projectPath,
        chapter,
        violations: violations.map((v) => ({
          id: v.id, text: v.text,
          ...(v.reason ? { reason: v.reason } : {}),
          ...(v.severity ? { severity: v.severity } : {}),
          ...(v.suggestedFix ? { suggestedFix: v.suggestedFix } : {}),
        })),
        draftContent: ws.workspace.draft.content,
      });
      if (!ownsCurrentWorkspace(operation)) {
        notifyStaleOperation();
        return;
      }
      if (resp.result.rewritten > 0) {
        useWorkspaceStore.getState().updateDraft({ content: resp.draftContent });
        const norm = (s: string): string => s.replace(/\s+/gu, "");
        const changedBefores = resp.result.changes.map((c) => norm(c.before));
        for (const v of violations) {
          const t = norm(v.text);
          if (changedBefores.some((b) => b === t || b.includes(t) || t.includes(b))) {
            useWorkspaceStore.getState().markAiFlavorViolationFixed(messageId, v.id);
          }
        }
        // 多处黄高亮 + 滚到首处改动（WritingPaper effect 据此联动）。
        useWorkspaceStore.getState().setRevisionHighlights(resp.result.changes.map((c) => c.after));
      }
      nav.showToast(resp.summary, 5000);
    } catch (error) {
      if (!ownsCurrentWorkspace(operation)) {
        notifyStaleOperation();
        return;
      }
      nav.showToast(`一键去 AI 味失败：${error instanceof Error ? error.message : String(error)}`, 5000);
    } finally {
      if (isWorkspaceOperationCurrent(operation)) {
        if (ownsCurrentWorkspace(operation)) {
          useWorkspaceStore.getState().setAiFlavorBatchPending(null);
          useWorkspaceStore.getState().setDraftActionLoading(null);
        }
        finishWorkspaceOperation(operation);
      }
    }
  };

  /* -------------------------------------------------------------- */
  /*  抽卡（阶段三块③）：再来一版 → 生成 2 个临时候选并排 → 挑中落盘     */
  /*  候选 persist:false 不写盘不快照；挑中走 apply-candidate 写前快照=可撤销。*/
  /* -------------------------------------------------------------- */

  const handleRerollCandidates = async (): Promise<void> => {
    const nav = useNavigationStore.getState();
    const ws = useWorkspaceStore.getState();
    if (!projectPath) {
      nav.showToast("请先打开本地项目。");
      return;
    }
    if (ws.workspace.draft.status === "committed") {
      nav.showToast("本章已定稿，正文只读；如需另写请通过 AI 助手发起修订。");
      return;
    }
    const chapter = ws.workspace.currentChapter.chapterNumber;
    const direction = ws.lastChapterDirection || ws.steeringDirection || `继续第 ${chapter} 章。`;
    const operation = beginOwnedOperation("reroll-candidates");
    if (!operation) return;
    ws.setDraftActionLoading("reroll-candidates");
    ws.setDraftCandidates(null);
    try {
      // 顺序生成 2 版候选（避免并发把模型代理打满）；每版同方向、靠模型温度产生差异。
      // 每版各自 try：某版失败不丢掉已成功的版（部分成功也展示，别白烧 token）。
      const candidates: { readonly content: string; readonly title?: string; readonly originTarget: WorkspaceOperationTarget }[] = [];
      let lastError: unknown;
      for (let index = 0; index < 2; index += 1) {
        try {
          const result = await generateDraftCandidate({ projectPath, chapter, chapterGoal: direction });
          if (!ownsCurrentWorkspace(operation)) {
            notifyStaleOperation();
            return;
          }
          if (result.draftContent.trim()) candidates.push({ content: result.draftContent, title: result.draftTitle, originTarget: operation });
        } catch (error) {
          lastError = error;
        }
      }
      if (candidates.length === 0) {
        nav.showToast(`再来一版失败：${lastError instanceof Error ? lastError.message : "候选生成失败，请重试。"}`, 5000);
        return;
      }
      useWorkspaceStore.getState().setDraftCandidates(candidates);
      if (candidates.length < 2) {
        nav.showToast(`只生成出 ${candidates.length} 版候选（另一版生成失败），可先看这版或再试一次。`);
      }
    } finally {
      finishOwnedOperation(operation);
    }
  };

  const handleApplyCandidate = async (content: string): Promise<void> => {
    const nav = useNavigationStore.getState();
    const ws = useWorkspaceStore.getState();
    if (!projectPath || !content.trim()) {
      nav.showToast("没有可应用的候选。");
      return;
    }
    const candidate = ws.draftCandidates?.find((item) => item.content === content);
    if (!candidate?.originTarget) {
      nav.showToast("这份候选稿缺少工作区归属，已拒绝应用。", 5000);
      return;
    }
    if (!workspaceOperationTargetMatches(candidate.originTarget, currentOperationIdentity())) {
      nav.showToast("这份候选稿来自切换前的那本书，不能应用到当前章节。", 5000);
      return;
    }
    const operation = beginOwnedOperation("apply-candidate");
    if (!operation) return;
    const chapter = operation.chapter;
    ws.setDraftActionLoading("apply-candidate");
    try {
      const result = await applyDraftCandidate({ projectPath, chapter, draftContent: content });
      if (!ownsCurrentWorkspace(operation)) {
        notifyStaleOperation();
        return;
      }
      applyOverviewToWorkspace(
        result.overview,
        result.draftContent,
        "draft_ready",
        result.draftTitle ?? extractDraftTitle(result.draftContent) ?? ws.workspace.draft.title,
      );
      useWorkspaceStore.getState().setDraftCandidates(null);
      nav.showToast("已用这版替换工作稿，可在「操作历史」撤销。");
    } catch (error) {
      if (!ownsCurrentWorkspace(operation)) {
        notifyStaleOperation();
        return;
      }
      nav.showToast(`选用候选失败：${error instanceof Error ? error.message : String(error)}`, 5000);
    } finally {
      finishOwnedOperation(operation);
    }
  };

  const handleCloseCandidates = (): void => {
    useWorkspaceStore.getState().setDraftCandidates(null);
  };

  /* -------------------------------------------------------------- */
  /*  Return                                                         */
  /* -------------------------------------------------------------- */

  return {
    generateSteering,
    handleSelectionRewrite,
    handleSelectionRewriteCustom,
    handleFixAiFlavorViolation,
    handleFixAiFlavorAll,
    handleRerollCandidates,
    handleApplyCandidate,
    handleCloseCandidates,
    handleGenerateDraft,
    handleQualityCheck,
    handleDraftAIReview,
    handleCreateRevisionTask,
    handleGenerateRevisionPreview,
    handleApplyRevisionPreview,
    handleDismissRevisionTask,
    handleCommitPreview,
    handleCommitApply,
    executeCommitApply,
    handleCommitSelectionChange,
  } as const;
}
