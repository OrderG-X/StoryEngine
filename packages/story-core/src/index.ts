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
  BookFileError,
  readAllLedgers,
  readBookSnapshot,
  readChapterLedger,
  readChapterText,
  readDecisions,
  readHead,
  sha256,
  type BookSnapshot,
} from "./store/book.js";
export { chapterLedgerPath, chapterTextPath, DECISIONS_PATH, HEAD_PATH, LEDGER_DIR, TX_DIR } from "./store/paths.js";
export { hasPendingTransactions, recoverTransactions, type RecoveryReport } from "./store/transaction.js";

export { DEFAULT_STALE_AFTER, project, type ProjectionInput, type ProjectionOptions } from "./projection/project.js";
export type * from "./projection/types.js";

export { checkEntries, type CheckResult, type RejectedEntry, type RejectReason } from "./review/check.js";
export { classifyForReview, type ClassifiedEntry, type ClassifyOptions, type ReviewPlan, type ReviewReason } from "./review/classify.js";

export { runCommand } from "./commands/runner.js";
export { chapterCommit, ChapterCommitArgs, type ChapterCommitResult } from "./commands/chapter-commit.js";
export { decisionRecord, type DecisionRecordResult } from "./commands/decision-record.js";
export { WRITE_COMMANDS, writeCommandsFor } from "./commands/table.js";
export { bookImport, BookImportArgs, type BookImportResult } from "./import/command.js";
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
