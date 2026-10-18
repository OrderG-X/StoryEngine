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

export { MIN_QUOTE_LENGTH, nameKey, normalizeForQuote, quoteInText } from "./text/quote.js";
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
  readAllLedgers,
  readBookSnapshot,
  readChapterLedger,
  readChapterText,
  readDecisions,
  readHead,
  sha256,
  type BookSnapshot,
} from "./store/book.js";
export { bookKey, withBookLock } from "./store/lock.js";
export { chapterLedgerPath, chapterTextPath, draftPath, DECISIONS_PATH, HEAD_PATH, KEPT_TX_DIR, LEDGER_DIR, TX_DIR } from "./store/paths.js";
export {
  hasPendingTransactions,
  KEPT_REPORT_THRESHOLD,
  recoverTransactions,
  setAsideBrokenTransactions,
  type RecoveryReport,
} from "./store/transaction.js";

export { DEFAULT_STALE_AFTER, project, type ProjectionInput, type ProjectionOptions } from "./projection/project.js";
export type * from "./projection/types.js";
export {
  chapterBrief,
  currentFactsAbout,
  DEFAULT_PROMPT_THREAD_LIMIT,
  threadsForPrompt,
  timelineTable,
  timelineText,
  type ChapterBrief,
  type PromptThread,
  type PromptThreads,
  type SubjectFacts,
  type TimelineRow,
} from "./projection/queries.js";

export { checkEntries, type CheckResult, type RejectedEntry, type RejectReason } from "./review/check.js";
export { classifyForReview, type ClassifiedEntry, type ClassifyOptions, type ReviewPlan, type ReviewReason } from "./review/classify.js";

export { runCommand } from "./commands/runner.js";
export { buildChapterLedger, chapterCommit, ChapterCommitArgs, type BuiltChapterLedger, type ChapterCommitResult } from "./commands/chapter-commit.js";
export { ledgerReread, LedgerRereadArgs, type LedgerRereadResult } from "./commands/ledger-reread.js";
export { decisionRecord, type DecisionRecordResult } from "./commands/decision-record.js";
export { WRITE_COMMANDS, writeCommandsFor } from "./commands/table.js";
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
export { composeDraftFile, draftVersionOf, parseDraftFile, readChapterPaper, readDraft, sameDraftBody, type ChapterPaper, type Draft } from "./draft/draft.js";
export { DraftSaveArgs, DraftWriteArgs, draftSave, draftWrite, type DraftConflictDetails, type DraftWriteResult } from "./draft/commands.js";
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

/** 读真相、算投影（不写盘、不拿锁）。 */
export async function projectBook(bookDir: string, options: ProjectionOptions = {}): Promise<BookProjection> {
  const snapshot = await readBookSnapshot(bookDir);
  return project(snapshot, options);
}
