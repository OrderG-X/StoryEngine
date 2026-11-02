/**
 * commit.prepare：定稿（写作版本 P2a 片 4A，设计第八节；安静账房 2026-11-03 改成「作者点定稿 = 授权，账 AI 记」）。
 *
 * - 起头两种：作者点「定稿」（按钮）就是授权，直接往下走；对话 AI 交的（prepare_commit、写完就定稿）先停下问一句
 *   「定稿？」，作者点了才往下走（没点不花钱，冻结的是点了之后的正文）。
 * - `freeze`：先取依据再读工作稿、过硬闸（空的 / 只有标题 / 太短 / 混进工具 JSON 或模型解释话）。过不了就做完、结果里列原因
 *   （只差字数时卡上给「就这么短，照样定稿」：作者点了交一次新的，只认按钮）。
 * - `notes` + `check`：和「核账」同一套（正文、前文没变直接用核账记忆，改了几句只核改过的）。有「确定」对不上的才停下，
 *   卡上只列这几处，作者改（另一次改稿）或点「照这样定稿」。核账没跑成不挡定稿，回执里如实说一句。
 * - `ledger`：记账员一次交账单 → 核原句 → 票（条目、正文指纹、依据）。记账没成自动再记一次（`ledger:2`，额度照算），
 *   还不成就先定正文、账待记（`commit-pending`：正文和待记的账单同一事务写，账以后补）。
 * - `commit`：照票交「定稿」命令（作者档，写前存档、能撤销）；记账之后正文改过、前文 / 账 / 设定 / 裁定变过，
 *   都不定稿、说哪样变了。补摘原句那一次没成、那几条因此没记：账记成 partial。
 * - 补账（`fill`，P2b 设计 3.2）：定稿时账没记上 / 没记全的那章，按定稿那版正文记账，交「补账」命令（只换账单，正文不动）；
 *   不核账（正文没动），记账两次都没成就如实说没补上。
 * 账不再列成清单给作者勾：会改掉前文不会变的事实、重定稿收掉后文还接着的线索的不写，其余照记；天数作者在对话里改（change_ledger）。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  chapterCommit,
  chapterTextPath,
  draftVersionOf,
  itemShortfall,
  ledgerComplete,
  readBookSnapshot,
  readChapterLedgerFile,
  readDraftStamp,
  receiptOnDisk,
  sha256,
  withBookLock,
  type BasisChange,
  type ChapterCommitResult,
  type CommandReceipt,
  type EntryInput,
  type LedgerCompleteResult,
  type LedgerShortfall,
  type TruthBasis,
} from "@actalk/story-core";
import { BookUnsettledError, describeBasisChanges, readTruthBasisForWork } from "../../../book/truth-basis.js";
import { callConfiguredBrainModel, READER_CALL_MAX_SENDS } from "../../../editorial/checker.js";
import { commitEntriesOf, commitOrderProblem, draftFingerprint, prepareChapterCommit, type CommitPreview } from "../../../editorial/commit-flow.js";
import { ownChapterIssues, prepareCheckerNotes, READER_MAX_VOLUME_BUILDS } from "../../../editorial/continuity/check-service.js";
import { warmUpReaders } from "../../../editorial/index.js";
import { KEEPER_MAX_CALLS, KEEPER_MAX_CATCH_UP } from "../../../editorial/ledger-keeper.js";
import type { ReaderWaited } from "../../../editorial/reader-progress.js";
import type { BrainCallModel } from "../../../editorial/reader-window.js";
import { rereadBlocker } from "../../../editorial/reread-state.js";
import { modelFailureText } from "../../../lib/ai-errors.js";
import { autoBackupAfterCommit } from "../../../lib/book-backup.js";
import { frozenCompatAllowance, frozenModelProblem, type FrozenModels, type ModelTaskProfileKey } from "../../../lib/llm-client.js";
import { replayedOutcome, runCommandInOperation } from "../../../lib/operations/command.js";
import { OperationObsolete, rethrowIfStopped } from "../../../lib/operations/context.js";
import type { OperationRecord } from "../../../lib/operations/store.js";
import { defaultDraftPath } from "../../../lib/project-io.js";
import { requestReaderBackfill } from "../../../lib/reader-backfill.js";
import { recordChapterWords } from "../../../lib/word-stats.js";
import { checkDraftHardGates } from "../../../writing/commit-quality-check.js";
import {
  blockedView,
  commitAskChoice,
  commitDoneView,
  committedShortOf,
  conflictsChoice,
  describeGate,
  fillDoneView,
  supersededCommitView,
  type AuthorChoicePreview,
  type CommitDone,
  type CommitNotes,
  type CommitPreviewView,
} from "../../commit-view.js";
import { coded } from "../../draft-change/steps.js";
import { freezeChapterText, runContinuityCheck, type ContinuityCheckOutput } from "../../inspect-service.js";
import { READER_CHECK_SENDS, READER_NOTES_SENDS } from "../budgets.js";
import type { OperationResult, Recipe } from "../executor.js";

export const COMMIT_PREPARE_KIND = "commit.prepare";
/** 停下请作者点的卡（「定稿？」、核出对不上的那几处）：通用的选择卡。 */
export const AUTHOR_CHOICE_KIND = "author_choice";
/** 对话里交的定稿 / 补账：先问一句的那张。 */
export const COMMIT_ASK_ACTION = "commit-ask";
/** 定稿前核出确定对不上的那张。 */
export const COMMIT_CONFLICTS_ACTION = "commit-conflicts";
/** 记账最多记几轮（没成自动再记一次）。 */
export const LEDGER_ROUNDS = 2;
const ledgerStepId = (round: number): string => (round === 1 ? "ledger" : `ledger:${round}`);

export interface CommitPrepareParams {
  readonly chapter: number;
  /** 作者点了「就这么短，照样定稿」（只认按钮）：这一章不拿字数下限挡。 */
  readonly allowShort?: true;
  /** 补账：这章定稿时账没记上 / 没记全，按定稿那版正文补记（只换账单）。 */
  readonly fill?: true;
  /** 作者点「定稿」时稿纸上存下的那一版（只认按钮）：冻结时工作稿已经不是这版 = 点了之后又改过，不定。 */
  readonly draftVersion?: string;
}

/** 结果的 body：定不了的（原因在卡上）、定完的（回执）。 */
export interface CommitPrepareBody {
  readonly kind: typeof COMMIT_PREPARE_KIND;
  readonly chapter: number;
  /** 写成了（定稿：正文定了；补账：账换上了）。 */
  readonly committed: boolean;
  /** 这次是补账。 */
  readonly fill?: true;
  readonly blocked?: CommitPreviewView;
  readonly done?: CommitDone;
  readonly snapshotId?: string;
}

export interface CommitPrepareDeps {
  readonly callModel: BrainCallModel;
  /** 核账员的模型调用（测试注入）；缺省走配置的 qualityCheck 模型。 */
  readonly readerCallModel?: BrainCallModel;
  readonly modelProblem: (models: FrozenModels, task: ModelTaskProfileKey) => string | undefined;
}

const DEFAULT_DEPS: CommitPrepareDeps = { callModel: callConfiguredBrainModel, modelProblem: frozenModelProblem };

/** 记账员、核账员都走 qualityCheck 那一路的模型。 */
const COMMIT_TASKS: readonly ModelTaskProfileKey[] = ["qualityCheck"];

/** 记一轮账最多发几次：当场补笔记（章上限 + 卷节点上限）+ 记账员（含补摘原句）× 每次。 */
export const COMMIT_LEDGER_SENDS = (KEEPER_MAX_CATCH_UP + READER_MAX_VOLUME_BUILDS + KEEPER_MAX_CALLS) * READER_CALL_MAX_SENDS;
/** 定稿前核一遍：核账员补读 + 核。 */
export const COMMIT_CHECK_SENDS = READER_NOTES_SENDS + READER_CHECK_SENDS;

/** freeze 那一步的输出：能往下走的材料（补账带着读到的那份账单的哈希），或定不了的原因卡。 */
type Frozen =
  | { readonly kind: "ok"; readonly text: string; readonly basis: TruthBasis; readonly notes: readonly string[]; readonly ledgerSha256?: string }
  | { readonly kind: "blocked"; readonly view: CommitPreviewView };

/** 记账那一步的输出：票，定不了的原因，或记账没成（原因）。 */
type Ledgered =
  | { readonly kind: "ok"; readonly preview: CommitPreview }
  | { readonly kind: "blocked"; readonly view: CommitPreviewView }
  | { readonly kind: "failed"; readonly reason: string };

/** 核账那两步的输出：核成了（结果），或没跑成（原因，不挡定稿）。 */
type Checked =
  | { readonly kind: "ok"; readonly output: ContinuityCheckOutput }
  | { readonly kind: "failed"; readonly reason: string };

const positiveChapter = (value: unknown): number | undefined => (typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined);

/** 交来的参数：章号；「就这么短」只认按钮；补账谁交都行（对话交的先问一句）。 */
export function readCommitPrepareParams(origin: string, raw: unknown): CommitPrepareParams | { readonly invalid: string } {
  const record = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const chapter = positiveChapter(record.chapter);
  if (record.fill === true) return chapter ? { chapter, fill: true } : { invalid: "要补哪一章的账没说清。" };
  if (!chapter) return { invalid: "要定稿哪一章没说清。" };
  const button = origin === "button";
  const draftVersion = button && typeof record.draftVersion === "string" && record.draftVersion.length > 0 ? record.draftVersion : undefined;
  return { chapter, ...(button && record.allowShort === true ? { allowShort: true as const } : {}), ...(draftVersion ? { draftVersion } : {}) };
}

async function readDraft(bookDir: string, chapter: number): Promise<string | undefined> {
  const text = await readFile(defaultDraftPath(bookDir, chapter), "utf-8").catch(() => undefined);
  return text !== undefined && text.trim().length > 0 ? text : undefined;
}

/** 先取依据再读：工作稿、硬闸。读的途中作者改了设定，定稿时对不上、作废。 */
async function freeze(bookDir: string, params: CommitPrepareParams): Promise<Frozen> {
  const { chapter } = params;
  const noDraft = (): Frozen => ({ kind: "blocked", view: blockedView(chapter, [`第 ${chapter} 章还没有工作稿，先写正文再定稿。`], `第 ${chapter} 章还没有工作稿，没法定稿。`) });
  let basis: TruthBasis;
  try {
    basis = await readTruthBasisForWork(bookDir);
  } catch (error) {
    if (!(error instanceof BookUnsettledError)) throw error;
    return { kind: "blocked", view: blockedView(chapter, [error.message], `第 ${chapter} 章现在还定不了：${error.message}`) };
  }
  // 老书没导入、前面还有章没定稿：先说，不问作者、不核账（那几步要花钱）。
  const order = commitOrderProblem(await readBookSnapshot(bookDir), chapter);
  if (order) return { kind: "blocked", view: blockedView(chapter, [order.reason], `第 ${chapter} 章现在还定不了：${order.reason}。`) };
  const text = await readDraft(bookDir, chapter);
  if (text === undefined) return noDraft();
  // 点了「定稿」之后、冻结之前又存了稿：定的就不是作者点的那版，不定（Astra 2026-11-03 第 1 条）。
  if (params.draftVersion !== undefined && draftVersionOf(text, await readDraftStamp(bookDir, chapter)) !== params.draftVersion) {
    throw new OperationObsolete("draft_changed", DRAFT_CHANGED);
  }
  const allGates = await checkDraftHardGates({ projectDir: bookDir, draftContent: text });
  const short = allGates.find((issue) => issue.type === "too_short")?.length;
  const shortBefore = await committedShortOf(bookDir, chapter, allGates);
  const shortAllowed = short !== undefined && (shortBefore !== undefined || params.allowShort === true);
  const gates = shortAllowed ? allGates.filter((issue) => issue.type !== "too_short") : allGates;
  if (gates.length > 0) {
    const reasons = gates.map(describeGate);
    return {
      kind: "blocked",
      view: blockedView(chapter, reasons, `第 ${chapter} 章现在还定不了：${reasons.join("；")}。`, {
        draftIssues: reasons,
        ...(gates.every((issue) => issue.type === "too_short") ? { shortOnly: true } : {}),
      }),
    };
  }
  return { kind: "ok", text, basis, notes: [] };
}

/**
 * 补账先冻结：取依据，读这章的账单（得是没记上 / 没记全的、定稿时记的）和定稿正文（哈希得是那份账单记的那版）。
 * 不能补的如实列原因（已经记上了、正文定稿后又改过要先重新定稿、导入的等通读记账）。
 */
async function freezeFill(bookDir: string, chapter: number): Promise<Frozen> {
  const blocked = (reason: string): Frozen => ({ kind: "blocked", view: { ...blockedView(chapter, [reason], `第 ${chapter} 章的账现在补不了：${reason}`), fill: true } });
  let basis: TruthBasis;
  try {
    basis = await readTruthBasisForWork(bookDir);
  } catch (error) {
    if (!(error instanceof BookUnsettledError)) throw error;
    return blocked(error.message);
  }
  const [file, text] = await Promise.all([
    readChapterLedgerFile(bookDir, chapter),
    readFile(join(bookDir, chapterTextPath(chapter)), "utf-8").catch(() => undefined),
  ]);
  if (!file || text === undefined) return blocked(`第 ${chapter} 章还没定稿，没有账可补`);
  if (file.ledger.status === "ready") return blocked(`第 ${chapter} 章的账已经记上了，不用补`);
  if (file.ledger.origin === "import") return blocked(`第 ${chapter} 章是导入的，账由通读记账来记`);
  if (sha256(text) !== file.ledger.textSha256) return blocked(`第 ${chapter} 章定稿之后正文又改过，先重新定稿（定稿时会重新记账）`);
  return { kind: "ok", text, basis, notes: [], ledgerSha256: file.sha256 };
}

/** 核账员读前文：没成不挡定稿（回执里说一句）。 */
async function checkNotes(bookDir: string, chapter: number, readerCallModel: BrainCallModel | undefined): Promise<{ readonly ok: true; readonly waited?: ReaderWaited } | { readonly ok: false; readonly reason: string }> {
  try {
    const notes = await prepareCheckerNotes(bookDir, chapter, readerCallModel);
    return { ok: true, ...(notes.waited ? { waited: notes.waited } : {}) };
  } catch (error) {
    rethrowIfStopped(error);
    return { ok: false, reason: `核账员读前文没成：${modelFailureText(error)}` };
  }
}

/** 核要定的这份正文（和冻结的那份对得上才核；对不上 = 冻结之后正文又改过，不定）。核账没跑成不挡定稿。 */
async function check(bookDir: string, chapter: number, frozen: Extract<Frozen, { kind: "ok" }>, waited: ReaderWaited | undefined, readerCallModel: BrainCallModel | undefined): Promise<Checked> {
  const read = await freezeChapterText(bookDir, chapter, "continuity");
  if ("missing" in read || read.source !== "draft" || draftFingerprint(read.fileText) !== draftFingerprint(frozen.text)) {
    throw new OperationObsolete("draft_changed", DRAFT_CHANGED);
  }
  try {
    const output = await runContinuityCheck(bookDir, read, {
      ...(readerCallModel ? { readerCallModel } : {}),
      notesReady: waited ? { waited } : {},
    });
    if (!output.ok) return { kind: "failed", reason: output.failures[0] ?? "原因不明" };
    return { kind: "ok", output };
  } catch (error) {
    rethrowIfStopped(error);
    return { kind: "failed", reason: modelFailureText(error) };
  }
}

/** 记账员交账单。记账员还没读完前文：这次按已有笔记 + 最近几章原文记，笔记交后台补。 */
async function ledger(bookDir: string, chapter: number, frozen: Extract<Frozen, { kind: "ok" }>, callModel: BrainCallModel): Promise<Ledgered> {
  const preview = await prepareChapterCommit({
    bookDir,
    chapter,
    text: frozen.text,
    callModel,
    basis: frozen.basis,
    maxCatchUp: KEEPER_MAX_CATCH_UP,
    maxVolumeBuilds: READER_MAX_VOLUME_BUILDS,
  });
  if (preview.cold) requestReaderBackfill(bookDir, { roles: ["ledger"], upTo: chapter - 1 });
  if (preview.ok) return { kind: "ok", preview };
  switch (preview.code) {
    case "basis_changed":
      throw new OperationObsolete("basis_moved", "记账的途中书里有地方改过，没定稿；要的话再点一次「定稿」。");
    case "keeper_failed":
      return { kind: "failed", reason: preview.reason };
    case "book_unsettled":
      throw coded(preview.code, preview.reason);
    default:
      return { kind: "blocked", view: blockedView(chapter, [preview.reason], `第 ${chapter} 章现在还定不了：${preview.reason}`) };
  }
}

/** 点了之后（冻结、核账、记账那会儿）正文改过。 */
const DRAFT_CHANGED = "点了「定稿」之后正文又改过，没定稿；要的话再点一次「定稿」。";

/**
 * 补摘原句那一次没成、那几条因此没记：账记成 partial，写明缺哪几类（核不上原句拒收的照旧算记全了）。
 * 梗概、时间一章只有一条：最后交的条目里有了就不算缺；缺的几类都补上了就不算没记全。
 * 东西的条目没记上（核不上也算：引用它的、按它算的去向都可能缺）：再缺东西那类，和核心定稿时同一个合法（P3b 设计 2.4）。
 */
function shortfallOf(preview: CommitPreview, entries: readonly EntryInput[]): LedgerShortfall | undefined {
  return itemShortfall(quoteShortfallOf(preview, entries), preview.itemMissing ?? [], preview.itemMissingRefs);
}

function quoteShortfallOf(preview: CommitPreview, entries: readonly EntryInput[]): LedgerShortfall | undefined {
  if (!preview.quoteRepair?.failed) return undefined;
  const has = new Set(entries.map((entry) => entry.kind));
  if (!preview.missingKinds) return { status: "partial", reasonCodes: ["quote_repair_failed"] };
  const missing = preview.missingKinds.filter((kind) => !((kind === "time" || kind === "summary") && has.has(kind)));
  return missing.length > 0 ? { status: "partial", reasonCodes: ["quote_repair_failed"], missingKinds: missing } : undefined;
}

/** 照票定稿：记账之后正文改过、书变过都不定，说哪样变了。 */
async function commit(bookDir: string, preview: CommitPreview, notes: CommitNotes): Promise<{ readonly done: CommitDone; readonly snapshotId?: string }> {
  // 定和读回执在同一把书锁里：定完到读账之间别的操作插不进来（回执说的就是这次写的）。
  const { ticket, chapter } = preview;
  const entries = commitEntriesOf(ticket);
  return withBookLock(bookDir, () => commitLocked(bookDir, chapter, ticket.textSha256, ticket.basis, entries, shortfallOf(preview, entries), notes));
}

/** 记账两轮都没成：正文照冻结那版定，账单记成待记（同一事务、写前存档、能撤销）。 */
async function commitPending(bookDir: string, chapter: number, frozen: Extract<Frozen, { kind: "ok" }>, notes: CommitNotes): Promise<{ readonly done: CommitDone; readonly snapshotId?: string }> {
  return withBookLock(bookDir, () => commitLocked(bookDir, chapter, draftFingerprint(frozen.text), frozen.basis, [], { status: "pending", reasonCodes: ["keeper_failed"] }, notes));
}

async function commitLocked(
  bookDir: string,
  chapter: number,
  textFingerprint: string,
  basis: TruthBasis,
  entries: ReturnType<typeof commitEntriesOf>,
  shortfall: LedgerShortfall | undefined,
  notes: CommitNotes,
): Promise<{ readonly done: CommitDone; readonly snapshotId?: string }> {
  const text = await readDraft(bookDir, chapter);
  if (text === undefined) throw new OperationObsolete("draft_missing", `第 ${chapter} 章的工作稿没了，没定稿。`);
  const fingerprint = draftFingerprint(text);
  if (fingerprint !== textFingerprint) throw new OperationObsolete("draft_changed", DRAFT_CHANGED);
  const args = { chapter, text, entries, ...(shortfall ? { ledger: shortfall } : {}), acceptedBasis: basis.digest };
  const { result, snapshotId } = await runCommandInOperation(bookDir, chapterCommit, args, {
    what: `定稿：第 ${chapter} 章`,
    caller: "author",
    basis,
    // 正文按指纹认（稿纸重新载入只收空段落，字一个没动）。
    intent: { text: fingerprint, entries, ...(shortfall ? { ledger: shortfall } : {}) },
    // 整段在书锁里，走命令的存稿插不进来；不走锁的（在别处直接改了文件）还可能：命令里再读一遍，变了就不定（Astra 第 11 轮：会把旧稿定上）。
    precondition: async () => {
      const now = await readDraft(bookDir, chapter);
      return now !== undefined && draftFingerprint(now) === fingerprint ? undefined : { ok: false, code: "draft_changed", message: DRAFT_CHANGED };
    },
  });
  if (!result.ok) {
    if (result.code === "draft_changed") throw new OperationObsolete("draft_changed", DRAFT_CHANGED);
    if (result.code === "basis_changed") {
      const changes = (result.details as { readonly changes?: readonly BasisChange[] } | undefined)?.changes ?? [];
      throw new OperationObsolete("basis_moved", `定稿的途中${describeBasisChanges(changes)}改过，没定稿；要的话再点一次「定稿」。`);
    }
    throw coded(result.code, result.message);
  }
  return { done: await commitDoneView(bookDir, chapter, text, notes, result.result), ...(snapshotId ? { snapshotId } : {}) };
}

/** 照票补账：只换这章的账单（作者档，写前存档、能撤销）；记账之后这章的账、正文、书变过都不写，说哪样变了。 */
async function fill(bookDir: string, preview: CommitPreview, ledgerSha256: string): Promise<{ readonly done: CommitDone; readonly snapshotId?: string }> {
  const { ticket, chapter } = preview;
  const entries = commitEntriesOf(ticket);
  const shortfall = shortfallOf(preview, entries);
  return withBookLock(bookDir, async () => {
    const { result, snapshotId } = await runCommandInOperation(bookDir, ledgerComplete, {
      chapter,
      ledgerSha256,
      entries,
      ...(shortfall ? { partial: { reasonCodes: shortfall.reasonCodes, ...(shortfall.missingKinds ? { missingKinds: shortfall.missingKinds } : {}), ...(shortfall.missingItems ? { missingItems: shortfall.missingItems } : {}) } } : {}),
      acceptedBasis: ticket.basis.digest,
    }, { what: `补账：第 ${chapter} 章`, caller: "author", basis: ticket.basis });
    if (!result.ok) {
      if (result.code === "basis_changed") {
        const changes = (result.details as { readonly changes?: readonly BasisChange[] } | undefined)?.changes ?? [];
        throw new OperationObsolete("basis_moved", `补账的途中${describeBasisChanges(changes)}改过，没写；要的话再点一次「补记账」。`);
      }
      if (result.code === "ledger_changed" || result.code === "text_changed" || result.code === "nothing_to_fill") throw new OperationObsolete(result.code, result.message);
      throw coded(result.code, result.message);
    }
    return { done: await fillDoneView(bookDir, chapter, result.result, preview.notRecorded), ...(snapshotId ? { snapshotId } : {}) };
  });
}

/** 上次已经补了（崩在写完、记检查点之前）：照回执报。 */
async function filled(bookDir: string, chapter: number, receipt: CommandReceipt): Promise<{ readonly done: CommitDone }> {
  const outcome = replayedOutcome<LedgerCompleteResult>(receipt, ledgerComplete);
  return withBookLock(bookDir, async () => {
    if (await receiptOnDisk(bookDir, receipt) !== true) return { done: { summary: `第 ${chapter} 章的账那次已经补上了；之后这章又改过。` } };
    return { done: await fillDoneView(bookDir, chapter, outcome.result) };
  });
}

/**
 * 上次已经定了（崩在定完、记检查点之前，ctx.apply 照回执回放）：照回执报，不再核工作稿（作者之后存的新稿不算「改过」）。
 * 盘上还是这次写成的才照盘上说；之后这章又定过、撤过的，盘上是后来的，只说定成了（Astra 第 14 轮第 2 条）。
 */
async function committed(bookDir: string, chapter: number, receipt: CommandReceipt, notes: CommitNotes): Promise<{ readonly done: CommitDone }> {
  // 核和读在同一把书锁里：核完到读之间别的操作（撤销、重定稿）插不进来（Astra 第 15 轮第 2 条）。
  return withBookLock(bookDir, async () => {
    if (await receiptOnDisk(bookDir, receipt) !== true) return { done: supersededCommitView(chapter) };
    const text = await readFile(join(bookDir, chapterTextPath(chapter)), "utf-8");
    return { done: await commitDoneView(bookDir, chapter, text, notes, replayedOutcome<ChapterCommitResult>(receipt, chapterCommit).result) };
  });
}

const blockedResult = (chapter: number, view: CommitPreviewView, isFill: boolean): OperationResult => {
  const body: CommitPrepareBody = { kind: COMMIT_PREPARE_KIND, chapter, committed: false, ...(isFill ? { fill: true as const } : {}), blocked: view };
  return { schema: "operation-result/1", summary: view.summary, body };
};

const doneResult = (chapter: number, isFill: boolean, applied: { readonly done: CommitDone; readonly snapshotId?: string }): OperationResult => {
  const body: CommitPrepareBody = {
    kind: COMMIT_PREPARE_KIND,
    chapter,
    committed: true,
    ...(isFill ? { fill: true as const } : {}),
    done: applied.done,
    ...(applied.snapshotId ? { snapshotId: applied.snapshotId } : {}),
  };
  return { schema: "operation-result/1", summary: applied.done.summary, body };
};

export function createCommitPrepareRecipe(deps: CommitPrepareDeps = DEFAULT_DEPS): Recipe<CommitPrepareParams> {
  /** 从这一步往后最多还要发几次（接着做时额度按它加）。 */
  const sendsFrom = (stepId: string, isFill: boolean): number => {
    const ledgerRounds = stepId === "ledger:2" ? 1 : LEDGER_ROUNDS;
    const ledgerSends = ledgerRounds * COMMIT_LEDGER_SENDS;
    if (isFill) return stepId.startsWith("ledger") || stepId === "freeze" || stepId === `author:${COMMIT_ASK_ACTION}` ? ledgerSends : 0;
    switch (stepId) {
      case "freeze":
      case `author:${COMMIT_ASK_ACTION}`:
      case "notes":
        return COMMIT_CHECK_SENDS + ledgerSends;
      case "check":
        return READER_CHECK_SENDS + ledgerSends;
      case `author:${COMMIT_CONFLICTS_ACTION}`:
      case "ledger":
      case "ledger:2":
        return ledgerSends;
      default:
        return 0;
    }
  };
  return {
    kind: COMMIT_PREPARE_KIND,
    // 2：安静账房（清单没了、核账进了定稿）；之前停着的接不上，重新来一次。
    version: 2,
    lane: "foreground",
    // 一章只留一张能点的卡：再点「定稿」是新的一次，旧的那张作废。
    supersedesWaiting: { message: "这一章后来又点了一次定稿，用新的那次。" },

    async prepare(bookDir, input) {
      const params = readCommitPrepareParams(input.origin.kind, input.params);
      if ("invalid" in params) return { ok: false, code: "bad_params", message: params.invalid };
      // 导入的书还在通读记账（P8）：前文的账没记全，这一章的账对不上前文。
      const rereading = await rereadBlocker(bookDir, params.fill ? "补账" : "定稿");
      if (rereading) return { ok: false, code: "rereading", message: rereading };
      for (const task of COMMIT_TASKS) {
        const problem = deps.modelProblem(input.models, task);
        if (problem) return { ok: false, code: "model_missing", message: problem };
      }
      return {
        ok: true,
        // 补账记成 fill 这一档：操作历史、对话里说「补账」，不说「定稿」。
        ...(params.fill ? { mode: "fill" } : {}),
        params,
        writeScope: { chapters: [params.chapter] },
        budget: sendsFrom("freeze", params.fill === true) + await frozenCompatAllowance(input.models, COMMIT_TASKS),
      };
    },

    async run(ctx): Promise<OperationResult> {
      const { bookDir, params } = ctx;
      const { chapter } = params;
      const isFill = params.fill === true;
      const freezeNow = (): Promise<Frozen> => (isFill ? freezeFill(bookDir, chapter) : freeze(bookDir, params));
      // 对话里交的：先过一遍硬闸（定不了就不问了），再问一句；作者点了才冻结、往下走（没点不花钱）。
      if (ctx.record.origin.kind !== "button") {
        const early = await freezeNow();
        if (early.kind === "blocked") return blockedResult(chapter, early.view, isFill);
        await ctx.waitForAuthor({
          actionId: COMMIT_ASK_ACTION,
          kind: AUTHOR_CHOICE_KIND,
          decisions: ["commit"],
          preview: commitAskChoice(chapter, isFill) satisfies AuthorChoicePreview,
        });
      }
      const frozen = await ctx.step("freeze", { chapter, ...(isFill ? { fill: true } : { allowShort: params.allowShort === true }) }, freezeNow);
      if (frozen.kind === "blocked") return blockedResult(chapter, frozen.view, isFill);
      const notes: { -readonly [K in keyof CommitNotes]: CommitNotes[K] } = {};
      if (!isFill) {
        // 定稿前核一遍：确定对不上的才停下给作者看；没核成不挡定稿，回执里说一句。
        ctx.progress("在对前文");
        const read = await ctx.step("notes", { chapter }, () => checkNotes(bookDir, chapter, deps.readerCallModel));
        const checked: Checked = read.ok
          ? await ctx.step("check", { chapter, digest: frozen.basis.digest }, () => check(bookDir, chapter, frozen, read.waited, deps.readerCallModel))
          : { kind: "failed", reason: read.reason };
        if (checked.kind === "failed") notes.checkFailed = checked.reason;
        else {
          if (checked.output.failures.length > 0) notes.checkPartial = checked.output.failures[0];
          if (checked.output.coverage) notes.checkCold = true;
          const own = ownChapterIssues(checked.output.sure, chapter);
          if (own.length > 0) {
            await ctx.waitForAuthor({
              actionId: COMMIT_CONFLICTS_ACTION,
              kind: AUTHOR_CHOICE_KIND,
              decisions: ["commit"],
              preview: conflictsChoice(chapter, { ...checked.output, sure: own }) satisfies AuthorChoicePreview,
            });
            // 停着的时候作者改了那几处（或别的）：点「照这样定稿」定的还是冻结那版，先别花记账的钱，直接说改过了。
            const now = await readDraft(bookDir, chapter);
            if (now === undefined || draftFingerprint(now) !== draftFingerprint(frozen.text)) throw new OperationObsolete("draft_changed", DRAFT_CHANGED);
          }
        }
      }
      // 记账：没成自动再记一次；还不成，定稿就先定正文、账待记，补账如实说没补上。
      let preview: CommitPreview | undefined;
      for (let round = 1; round <= LEDGER_ROUNDS && preview === undefined; round += 1) {
        ctx.progress("在记账");
        const ledgered = await ctx.step(ledgerStepId(round), { chapter, digest: frozen.basis.digest, ...(round > 1 ? { round } : {}) }, () => ledger(bookDir, chapter, frozen, deps.callModel));
        if (ledgered.kind === "blocked") return blockedResult(chapter, ledgered.view, isFill);
        if (ledgered.kind === "ok") {
          preview = ledgered.preview;
          if (preview.notRecorded) notes.notRecorded = preview.notRecorded;
        } else notes.ledgerFailed = ledgered.reason;
      }
      if (preview === undefined) {
        if (isFill) throw coded("keeper_failed", `第 ${chapter} 章的账这次没补上：${notes.ledgerFailed ?? "原因不明"}`);
        const applied = await ctx.apply("commit-pending", {}, () => commitPending(bookDir, chapter, frozen, notes), (receipt) => committed(bookDir, chapter, receipt, notes));
        return doneResult(chapter, false, applied);
      }
      const ticketed = preview;
      const { ledgerFailed: _retried, ...said } = notes;
      const applied = isFill
        ? await ctx.apply("fill", {}, () => fill(bookDir, ticketed, frozen.ledgerSha256 ?? ""), (receipt) => filled(bookDir, chapter, receipt))
        : await ctx.apply("commit", {}, () => commit(bookDir, ticketed, said), (receipt) => committed(bookDir, chapter, receipt, said));
      return doneResult(chapter, isFill, applied);
    },

    stepBudget(stepId, params) {
      return stepId === undefined ? 0 : sendsFrom(stepId, params.fill === true);
    },

    modelTasks() {
      return COMMIT_TASKS;
    },

    async afterRun(bookDir, record) {
      const chapter = committedChapter(record);
      if (chapter === undefined) return;
      try {
        // 编辑部预热：后台给专员把笔记补到这一章。
        warmUpReaders(bookDir, chapter);
        // 写作统计：定稿后这章按定稿重数（工作稿还在就数工作稿）。
        await recordChapterWords(bookDir, chapter, "other");
        // 自动备份（设置里能关）：后台打一份，没成不挡定稿，结果记进备份设置、设置里看得到。
        void autoBackupAfterCommit(bookDir).catch((error: unknown) => console.warn("[commit.prepare] 定稿后自动备份没成", error));
      } catch (error) {
        console.warn("[commit.prepare] 定稿后的收尾没做完", error);
      }
    },
  };
}

/** 这次做成了、真定了稿的章号（补账不算：正文没动）。 */
function committedChapter(record: OperationRecord): number | undefined {
  if (record.state !== "succeeded") return undefined;
  const body = (record.result as { readonly body?: Partial<CommitPrepareBody> } | undefined)?.body;
  return body?.kind === COMMIT_PREPARE_KIND && body.committed === true && body.fill !== true && typeof body.chapter === "number" ? body.chapter : undefined;
}

export const commitPrepareRecipe = createCommitPrepareRecipe();
