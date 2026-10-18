// P1-E：显式导出——只导出 UI、CLI、桌面包真正 import 的名字（@actalk/story-engine 的包表面）。
// 挂空导出的模块见 docs/rebuild/reports/P1-E-2026-10-17.md「只剩测试引用」一节，本期不删。
export {
  type AiFlavorFrequencyGateRule,
  type AiFlavorPatternRule,
  type AiFlavorReport,
  type AiFlavorRule,
  type AiFlavorSeverity,
  type AiFlavorViolation,
  buildAiFlavorReport,
  detectAiFlavorViolations,
} from "./ai-flavor-detection.js";
export {
  type ArcGoalUpdate,
  type StaleGoalWarning,
} from "./arc-goal-tracking.js";
export {
  dedupeStringList,
} from "./canonical-resolvers.js";
export {
  type ChapterDeltaDeclaration,
  verifyChapterDelta,
} from "./chapter-delta.js";
export {
  buildChapterSteeringDraft,
  type ChapterSteeringDraft,
  type ChapterSteeringPacing,
  type ChapterSteeringRevealLevel,
} from "./chapter-steering.js";
export {
  type NameDriftFinding,
} from "./character-name-consistency.js";
export {
  type CharacterMatrixUpdate,
  type CommitDraftInput,
  commitFastDraft,
  type CommitReport,
  recoverProjectCommitTransactions,
  withProjectCommitLock,
} from "./commit-engine.js";
export {
  buildCommitPlanFromProject,
  type BuildCommitPlanResult,
  type ChapterSemanticSummary,
} from "./commit-plan-builder.js";
export {
  checkCommitPlanSemanticQuality,
  checkDraftBeforeCommit,
  checkDraftHardGates,
  type CommitQualityIssue,
  type CommitQualityReport,
} from "./commit-quality-check.js";
export {
  type ChapterPlan,
  normalizeChapterPlan,
  readChapterPlan,
  readStoryClock,
  writeChapterPlan,
} from "./chapter-plan.js";
export {
  buildWriterContext,
  type ContextSection,
  estimateTokens,
  type WriterContextEnvelope,
} from "./context-gateway.js";
export {
  findEarlierPassages,
} from "./earlier-passages.js";
export {
  checkDraftBeatFidelity,
} from "./draft-beat-fidelity.js";
export {
  buildDraftAIReviewPrompt,
  type DraftAIReviewReport,
  fallbackDraftAIReviewReport,
  parseDraftAIReviewReport,
} from "./draft-ai-review.js";
export {
  applyDraftLengthConstraint,
  buildDraftLengthReport,
  buildFastDraftRetryPrompt,
  countDraftChineseCharacters,
  type DraftLengthReport,
  type DraftLengthStatus,
  type DraftLengthTarget,
  type DraftLengthTargetSource,
  resolveDraftLengthTarget,
  resolveDraftMaxOutputTokens,
  trimDraftBodyToLengthTarget,
} from "./draft-length-control.js";
export {
  buildDeterministicRevisionPreview,
  buildDraftRevisionPrompt,
  countDraftWords,
  type DraftRevisionPreview,
  type DraftRevisionTask,
  fallbackDraftRevisionPreview,
  normalizeDraftRevisionPreview,
  parseDraftRevisionPreview,
} from "./draft-revision.js";
export {
  selectEffectiveFacts,
} from "./fact-selection.js";
export {
  type ChapterFactUpdate,
  readFactLedgerStrict,
} from "./fact-ledger-store.js";
export {
  type CacheMetrics,
  type FastDraftInput,
  type FastDraftReport,
  persistFastDraftBody,
  runFastDraft,
  stripMarkdownEmphasis,
  stripTrailingSegmentMarkers,
  type TokenUsage,
  type WriterClient,
} from "./fast-draft-writer.js";
export {
  buildFoundationGapReport,
} from "./foundation-gap-assistant.js";
export {
  applyFoundationWriteSuggestion,
  type FoundationWriteResult,
  type FoundationWriteSuggestionLike,
} from "./foundation-write-gateway.js";
export {
  type HookStaleWarning,
  type HookTrackingUpdate,
} from "./hook-tracking.js";
export {
  buildThreadTrackingPlan,
  isQualityLead,
  type StaleThreadWarning,
  type ThreadHygieneReport,
  type ThreadTrackingUpdate,
} from "./lead-intent-tracking.js";
export {
  loadModelSettingsV0,
  validateModelSettingsV0,
} from "./model-settings.js";
export {
  createStoryProject,
  PLACEHOLDER_CHARACTER_NAME,
  readArcGoalPool,
  readAssetLedger,
  readCharacterBible,
  readCharacterMatrixLedger,
  readCharacterState,
  readFactLedger,
  readHookPool,
  readLocationBible,
  readStoryBible,
  readStoryCalendar,
  readThreadPool,
  readTimelineEvents,
  readWorldBible,
  readWorldState,
  readWritingRules,
  toSafeCharacterId,
} from "./project-store.js";
export {
  findFirstPromptDifference,
  renderFastDraftPromptText,
} from "./prompt-cache-diagnostics.js";
export {
  findRecurringPhrases,
} from "./recurring-phrases.js";
export {
  type QualityAiJudgement,
  userDisplayCategoryForJudgement,
} from "./quality-judgement.js";
export {
  buildStateOverview,
  type StateOverview,
} from "./state-overview.js";
export {
  absolutizeRelativeDaysInText,
  chapterEndDay,
  describeTimelineForChapter,
  formatStoryDay,
  readStoryTimeline,
  type StoryTimeline,
  type TimelineEntry,
  timelineEntryFor,
  type TimelineSource,
  validateStoryTimeline,
  weekdayOfDay,
} from "./story-timeline.js";
export {
  findLedgerNumberConflicts,
} from "./ledger-number-check.js";
export {
  normalizeStyleExemplars,
  STYLE_EXEMPLAR_MAX_COUNT,
  STYLE_EXEMPLAR_MAX_TEXT_CHARS,
} from "./style-exemplars.js";
export {
  type TimelineLayerEvent,
  type TimelineMacroBlock,
} from "./timeline-layers.js";
export {
  buildWritingContextPack,
} from "./writing-context-pack.js";
export {
  bigramSimilarity,
} from "./text-similarity.js";
export {
  type ArcGoal,
  type ArcGoalPool,
  type AssetItem,
  type CharacterBible,
  type CharacterBibleEntry,
  type CharacterMatrixEntry,
  type CharacterMatrixLedger,
  type FactEntry,
  type FactLedger,
  type HookPool,
  type LocationBibleEntry,
  type ModelSettingsLoadResult,
  type NarrativeThread,
  type StoryCalendar,
  type StyleExemplar,
  type ThreadPool,
  type TimelineEvent,
  type WorldBible,
} from "./types.js";
