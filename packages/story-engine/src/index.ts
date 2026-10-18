// P1-E：显式导出——只导出 UI、桌面包真正 import 的名字（@actalk/story-engine 的包表面）。
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
  dedupeStringList,
} from "./canonical-resolvers.js";
export {
  recoverProjectCommitTransactions,
  withProjectCommitLock,
} from "./legacy-commit-recovery.js";
export {
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
  loadModelSettingsV0,
  validateModelSettingsV0,
} from "./model-settings.js";
export {
  createStoryProject,
  isPlaceholderCharacterName,
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
  type CharacterMatrixUpdate,
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
