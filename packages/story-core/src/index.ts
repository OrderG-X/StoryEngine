/**
 * @actalk/story-core —— 新核心：真相、命令、投影。显式导出，没导出的就是内部的。
 * 设计见 docs/rebuild/P2-core-design.md。
 */
export {
  CHAPTER_LEDGER_SCHEMA,
  ChapterLedger,
  EntryInput,
  FactEntry,
  FactInput,
  FactNature,
  LedgerEntry,
  PresenceEntry,
  PresenceInput,
  ReviewMark,
  SummaryEntry,
  SummaryInput,
  ThreadEntry,
  ThreadInput,
  ThreadOp,
  ThreadType,
  TimeBasis,
  TimeEntry,
  TimeInput,
  entryShapeProblem,
} from "./schema/ledger.js";
export { AUTHOR_DECISIONS_SCHEMA, AuthorDecision, AuthorDecisionsFile, DecisionInput } from "./schema/decisions.js";
export { BOOK_HEAD_SCHEMA, BookHead, COMMAND_RECEIPT_SCHEMA, ChangeSet, CommandReceipt } from "./schema/book.js";
export {
  CANON_MAX,
  CANON_TEXT_MAX,
  CanonItem,
  CARD_NAME_MAX,
  Card,
  CardAuthor,
  CardField,
  CardKind,
  emptySettingCards,
  emptyWritingRules,
  Exemplar,
  EXEMPLAR_TEXT_MAX,
  EXEMPLARS_MAX,
  FIELD_LABEL_MAX,
  FIELD_VALUE_MAX,
  FIELDS_PER_CARD_MAX,
  Relation,
  RULE_ITEM_MAX,
  RULE_LIST_MAX,
  RULE_LISTS,
  RULE_SCALARS,
  RuleItem,
  RuleNumber,
  RuleText,
  SETTING_CARDS_SCHEMA,
  SettingCardsFile,
  WritingRules,
  type RuleList,
  type RuleScalar,
} from "./schema/cards.js";
export {
  applyCardOp,
  applyCardOps,
  CardOp,
  CardOps,
  findCard,
  KIND_LABELS,
  MAX_OPS_PER_CHANGE,
  RULE_LIST_LABELS,
  RULE_SCALAR_LABELS,
  splitForAi,
  type AiSplit,
  type ApplyResult,
  type OpContext,
} from "./bible/ops.js";
export { cardChangeLabel, cardFill, cardsImport, CardsImportArgs, cardWrite, CardWriteArgs, readCardsOrLegacy, type CardsImportResult, type CardWriteResult } from "./bible/commands.js";
export {
  bibleView,
  type BibleAppearances,
  type BibleEntry,
  type BibleFact,
  type BibleRelation,
  type BibleRelationView,
  type BibleView,
  type UncardedEntry,
} from "./bible/view.js";
export { readLegacyCards, type LegacyCardsResult } from "./import/legacy-cards.js";

export { MIN_QUOTE_LENGTH, nameKey, normalizeForQuote, quoteFromText, quoteInText } from "./text/quote.js";
export { bareChapterName, CHAPTER_NUMERAL, hasChapterNumberPrefix } from "./text/chapter-title.js";
export {
  applyUnitEdits,
  dropNeighborEcho,
  fitQuotes,
  numberedText,
  prepareUnitReplacement,
  splitNumberedReply,
  splitUnits,
  type AppliedUnitEdit,
  type ApplyUnitEditsResult,
  type TextUnit,
  type UnitEdit,
} from "./text/units.js";
export {
  cjkBigrams,
  bigramSimilarity,
  bigramOverlapCoefficient,
} from "./text/text-similarity.js";
export {
  type RecurringPhrase,
  type FindRecurringPhrasesInput,
  findRecurringPhrases,
} from "./text/recurring-phrases.js";
export {
  type RelevanceScorable,
  type RelevanceInput,
  type RelevanceResult,
  selectRelevant,
} from "./text/relevance-selection.js";
export {
  type BeatFidelityIssue,
  type BeatFidelityReport,
  checkDraftBeatFidelity,
} from "./text/draft-beat-fidelity.js";
export {
  type AiFlavorSeverity,
  type AiFlavorPatternRule,
  type AiFlavorFrequencyGateRule,
  type AiFlavorRule,
  type AiFlavorViolation,
  AI_FLAVOR_MAX_VIOLATIONS,
  type AiFlavorReport,
  detectAiFlavorViolations,
  buildAiFlavorReport,
} from "./text/ai-flavor-detection.js";

export {
  BookFileError,
  listChapterTexts,
  listChapterLedgers,
  readAllLedgers,
  readBookSnapshot,
  readChapterLedger,
  readCards,
  readChapterText,
  readDecisions,
  readHead,
  readTruthBasis,
  sha256,
  type BookSnapshot,
} from "./store/book.js";
export { bumpRevision, revisionWrite } from "./store/revision.js";
export { bookEpochWrite, draftStampOf, opBookEpoch, freshDraftGensWrite, readBookEpoch, readDraftGens, type DraftGens, type DraftStamp } from "./store/control.js";
export { basisDigestBefore, canonicalJson, diffTruthBasis, TRUTH_BASIS_SCHEMA, TruthBasis, truthBasisOf, type BasisChange } from "./store/basis.js";
export { bookKey, withBookLock } from "./store/lock.js";
export {
  LEGACY_TX_ACTIVE_RETENTION,
  LEGACY_TX_ARCHIVE_RETENTION,
  LEGACY_TX_DIR,
  LegacyResidueError,
  listLegacyRecoveryNotices,
  setLegacyTxIoHookForTests,
  type LegacyRecoveryNotice,
} from "./store/legacy-transaction.js";
export { BOOK_EPOCH_PATH, CARDS_PATH, chapterFromFileName, chapterLedgerPath, chapterTextPath, DRAFT_GENS_PATH, draftChapterOfPath, draftPath, DECISIONS_PATH, HEAD_PATH, isUndoablePath, KEPT_TX_DIR, LEDGER_DIR, planChapterOfPath, planPath, REVISION_PATH, SAVED_COPIES_DIR, TX_DIR, UNDOABLE_DIRS, UNDOABLE_FILES } from "./store/paths.js";
export { isSavedCopyId, listSavedDrafts, readSavedDraft, settleSavedCopy, type SavedDraft } from "./store/saved-copies.js";
export {
  hasPendingTransactions,
  KEPT_REPORT_THRESHOLD,
  recoverBookTransactions,
  recoverTransactions,
  setAsideBrokenTransactions,
  sha256Bytes,
  type RecoveryReport,
  type TxEffect,
} from "./store/transaction.js";

export { DEFAULT_STALE_AFTER, project, type ProjectionInput, type ProjectionOptions } from "./projection/project.js";
export type * from "./projection/types.js";
export {
  chapterBrief,
  currentFactsAbout,
  DEFAULT_PROMPT_THREAD_LIMIT,
  PRE_WRITE_CHANGE_LIMIT,
  PRE_WRITE_RECENT_CHAPTERS,
  PRE_WRITE_THREAD_LIMIT,
  preWriteMemo,
  threadsForPrompt,
  timelineTable,
  timelineText,
  type ChapterBrief,
  type PromptThread,
  type PreWriteChange,
  type PreWriteMemo,
  type PreWritePrevious,
  type PreWriteThread,
  type PromptThreads,
  type SubjectFacts,
  type TimelineRow,
} from "./projection/queries.js";
export {
  PACE_FAST_MIN_MOVES,
  PACE_FAST_RATIO,
  PACE_MIN_CHAPTERS,
  PACE_SLOW_RATIO,
  PACE_SPAN_DAYS,
  PACE_SPAN_WORDS_RATIO,
  paceReport,
  type PaceChapter,
  type PaceFlag,
  type PaceReport,
} from "./projection/pace.js";

export { checkEntries, type CheckResult, type RejectedEntry, type RejectReason } from "./review/check.js";
export { classifyForReview, type ClassifiedEntry, type ClassifyOptions, type ReviewPlan, type ReviewReason } from "./review/classify.js";

export { fail, opCommandKey, readCommandReceipt, runCommand, withSettledBook } from "./commands/runner.js";
export { buildChapterLedger, chapterCommit, ChapterCommitArgs, type BuiltChapterLedger, type ChapterCommitResult } from "./commands/chapter-commit.js";
export { chapterRetitle, ChapterRetitleArgs, type ChapterRetitleResult } from "./commands/chapter-retitle.js";
export { ledgerReread, LedgerRereadArgs, type LedgerRereadResult } from "./commands/ledger-reread.js";
export { decisionRecord, DecisionRecordArgs, MAX_DECISIONS_PER_RECORD, type DecisionRecordResult } from "./commands/decision-record.js";
export { settleApply, SettleApplyArgs, type SettledChapter, type SettleApplyResult } from "./commands/settle-apply.js";
export { planSave, PlanSaveArgs, type PlanSaveResult } from "./commands/plan-save.js";
export { WRITE_COMMANDS, writeCommandsFor } from "./commands/table.js";
export { historyApply, HistoryApplyArgs, type HistoryApplyResult } from "./history/apply.js";
export { BOOK_START_KEYS, HISTORY_APPLY_COMMAND, lastUndoable, lastUndoableIn, planRevert, readReceipts, revertTargetOf, type ImpactItem, type LaterWrite, type PlannedChange, type RevertPlan, type RevertTarget } from "./history/revert.js";
export { planRestore, type RestorePlan } from "./history/restore.js";
export { HISTORY_FILE_MAX_BYTES, ledgerChapterOfPath, rangeDigestOf, readUndoableFiles, type HistoryReader } from "./history/store.js";
export { refsOfDecision, refsOfEntry, type Ref, type RefWhere } from "./history/references.js";
export { bookImport, BookImportArgs, type BookImportResult } from "./import/command.js";
export { bookImportText, BookImportTextArgs, TEXT_IMPORT_MAX_CHAPTERS, type BookImportTextResult } from "./import/text-import.js";
export {
  readSerialHeading,
  serialChapterFile,
  serialFileStem,
  splitSerialText,
  SERIAL_HEADING_MAX_CHARS,
  type SerialFile,
  type SerialPart,
  type SerialSplit,
} from "./text/serial-split.js";
export { absentDraftVersion, composeDraftFile, draftVersionOf, parseDraftFile, readChapterPaper, readDraft, readDraftFile, readDraftState, readDraftStamp, readDraftVersions, sameDraft, sameDraftBody, type ChapterPaper, type Draft, type DraftText } from "./draft/draft.js";
export { draftAdoptCandidate, draftApplyGenerated, DraftSaveArgs, draftSave, type DraftConflictDetails, type DraftWriteResult } from "./draft/commands.js";
export { buildImportLedgers, type ImportAdjustment, type ImportBuild, type ImportCounts } from "./import/build.js";
export { readLegacyData, type ImportSkip, type LegacyData } from "./import/legacy.js";
export { BookEventHub, type BookEventListener } from "./commands/events.js";
export type {
  AnyWriteCommandSpec,
  BookEvent,
  Caller,
  CommandFailure,
  CommandOutcome,
  CommandSuccess,
  CommandTier,
  PlanContext,
  RunOptions,
  WriteCommandSpec,
  WritePlan,
} from "./commands/types.js";

import { readBookSnapshot } from "./store/book.js";
import { project, type ProjectionOptions } from "./projection/project.js";
import type { BookProjection } from "./projection/types.js";
import { bibleView as buildBibleView, type BibleView } from "./bible/view.js";
import { readLegacyCards as readLegacy } from "./import/legacy-cards.js";

/** 读真相、算投影（不写盘、不拿锁）。 */
export async function projectBook(bookDir: string, options: ProjectionOptions = {}): Promise<BookProjection> {
  const snapshot = await readBookSnapshot(bookDir);
  return project(snapshot, options);
}

/** 读真相、算投影和设定视图（不写盘、不拿锁）。还没有 cards.json 的老书现从老格式文件拼一份。 */
export async function readBible(bookDir: string, options: ProjectionOptions = {}): Promise<{ readonly projection: BookProjection; readonly bible: BibleView }> {
  const snapshot = await readBookSnapshot(bookDir);
  const projection = project(snapshot, options);
  const cards = snapshot.cards ?? (await readLegacy(bookDir, new Date().toISOString())).file;
  return { projection, bible: buildBibleView(projection, cards) };
}
