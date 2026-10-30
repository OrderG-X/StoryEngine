/**
 * commit.prepare：定稿（写作版本 P2a 片 4A，设计第八节；收编 commit_preview / commit_apply、「定稿」「就这么短，照样定稿」「确认定稿」）。
 *
 * - `freeze`：先取依据再读工作稿、过硬闸（空的 / 只有标题 / 太短 / 混进工具 JSON 或模型解释话）。过不了就做完、结果里列原因
 *   （只差字数时卡上给「就这么短，照样定稿」：作者点了交一次新的，只认按钮）。
 * - `ledger`：记账员一次交账单 → 核原句 → 分流成清单。票（条目、正文指纹、依据）就是这一步的输出，不再另存。
 *   记账没成（模型没答、超时、不是 JSON、读前文没成）不再整次失败（写作版本 P2b 设计 3.1）：停下给「记账没成」卡，
 *   「再记一次」（同一次操作，记账那步按轮号重来 `ledger:2`…，额度照算）、「先定正文、账待记」（`commit-pending`：
 *   正文和待记的账单同一事务写，账以后补）。
 * - 停下等作者在定稿清单上点「确认定稿」：每行能去掉（默认不写的能勾上），天数两栏能改。
 * - `commit`：照票和作者的选择交「定稿」命令（作者档，写前存档、能撤销）；预览之后正文改过、前文 / 账 / 设定 / 裁定变过，
 *   都不定稿、说哪样变了。回执里的条数照盘上刚写好的算。补摘原句那一次没成、那几条因此没记：账记成 partial。
 * - 补账（`fill`，设计 3.2）：定稿时账没记上 / 没记全的那章，按定稿那版正文走同一套记账 → 清单 →「确认记账」，
 *   最后交的是「补账」命令（只换账单，正文不动）；和定稿只差冻结读的是哪份正文、最后交哪条命令。
 * 对话 AI 交（`prepare_commit`）和作者点「定稿」是同一次：都只出清单，定稿只能作者点「确认定稿」。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  chapterCommit,
  chapterTextPath,
  ledgerComplete,
  readCardsOrLegacy,
  readChapterLedgerFile,
  receiptOnDisk,
  sha256,
  withBookLock,
  type BasisChange,
  type ChapterCommitResult,
  type CommandReceipt,
  type LedgerCompleteResult,
  type LedgerShortfall,
  type TruthBasis,
} from "@actalk/story-core";
import { BookUnsettledError, describeBasisChanges, readTruthBasisForWork } from "../../../book/truth-basis.js";
import { callConfiguredBrainModel, READER_CALL_MAX_SENDS } from "../../../editorial/checker.js";
import { commitEntriesOf, draftFingerprint, prepareChapterCommit, type CommitPreview } from "../../../editorial/commit-flow.js";
import { READER_MAX_VOLUME_BUILDS } from "../../../editorial/continuity/check-service.js";
import { warmUpReaders } from "../../../editorial/index.js";
import { KEEPER_MAX_CALLS, KEEPER_MAX_CATCH_UP } from "../../../editorial/ledger-keeper.js";
import type { BrainCallModel } from "../../../editorial/reader-window.js";
import { rereadBlocker } from "../../../editorial/reread-state.js";
import { autoBackupAfterCommit } from "../../../lib/book-backup.js";
import { frozenCompatAllowance, frozenModelProblem, type FrozenModels, type ModelTaskProfileKey } from "../../../lib/llm-client.js";
import { replayedOutcome, runCommandInOperation } from "../../../lib/operations/command.js";
import { OperationObsolete } from "../../../lib/operations/context.js";
import type { OperationRecord } from "../../../lib/operations/store.js";
import { defaultDraftPath } from "../../../lib/project-io.js";
import { requestReaderBackfill } from "../../../lib/reader-backfill.js";
import { recordChapterWords } from "../../../lib/word-stats.js";
import { checkDraftHardGates } from "../../../writing/commit-quality-check.js";
import {
  blockedView,
  checklistView,
  choicesOfToggled,
  commitDoneView,
  committedShortOf,
  describeGate,
  fillDoneView,
  ledgerFailedChoice,
  supersededCommitView,
  type AuthorChoicePreview,
  type CommitDone,
  type CommitPreviewView,
} from "../../commit-view.js";
import { coded } from "../../draft-change/steps.js";
import type { OperationResult, Recipe } from "../executor.js";

export const COMMIT_PREPARE_KIND = "commit.prepare";
/** 定稿停下等作者点的按钮（种类给界面认卡，号给回显认是哪个按钮）。 */
export const COMMIT_CONFIRM_KIND = "commit_confirm";
export const COMMIT_CONFIRM_ACTION = "confirm-commit";
/** 记账没成停下等作者挑（「再记一次」「先定正文、账待记」）：通用的选择卡。 */
export const AUTHOR_CHOICE_KIND = "author_choice";
/** 第 round 轮记账没成的那张卡（循环里带轮号，同一次操作里唯一）。 */
export const ledgerFailedAction = (round: number): string => (round === 1 ? "ledger-failed" : `ledger-failed:${round}`);
const ledgerStepId = (round: number): string => (round === 1 ? "ledger" : `ledger:${round}`);

/** 天数两栏的范围（作者在清单上改的）。 */
const DAY_MAX = 100_000;

export interface CommitPrepareParams {
  readonly chapter: number;
  /** 作者点了「就这么短，照样定稿」（只认按钮）：这一章不拿字数下限挡。 */
  readonly allowShort?: true;
  /** 补账：这章定稿时账没记上 / 没记全，按定稿那版正文补记（只换账单）。 */
  readonly fill?: true;
}

/** 停下等作者时的预览：定稿清单卡那份。 */
export interface CommitConfirmPreview {
  readonly view: CommitPreviewView;
}

/** 结果的 body：定不了的（原因在清单卡上）、定完的（回执）。 */
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
  readonly modelProblem: (models: FrozenModels, task: ModelTaskProfileKey) => string | undefined;
}

const DEFAULT_DEPS: CommitPrepareDeps = { callModel: callConfiguredBrainModel, modelProblem: frozenModelProblem };

/** 记账员和它补笔记都走核账员那一路的模型。 */
const COMMIT_TASKS: readonly ModelTaskProfileKey[] = ["qualityCheck"];

/** 记账那一步最多发几次：当场补笔记（章上限 + 卷节点上限）+ 记账员（含补摘原句）× 每次。 */
export const COMMIT_LEDGER_SENDS = (KEEPER_MAX_CATCH_UP + READER_MAX_VOLUME_BUILDS + KEEPER_MAX_CALLS) * READER_CALL_MAX_SENDS;

/** freeze 那一步的输出：能往下记账的材料（补账带着读到的那份账单的哈希），或定不了的清单卡。 */
type Frozen =
  | { readonly kind: "ok"; readonly text: string; readonly basis: TruthBasis; readonly knownNames: readonly string[]; readonly notes: readonly string[]; readonly ledgerSha256?: string }
  | { readonly kind: "blocked"; readonly view: CommitPreviewView };

/** 记账那一步的输出：清单（带票），定不了的原因，或记账没成（原因给作者看，停下等作者挑）。 */
type Ledgered =
  | { readonly kind: "ok"; readonly preview: CommitPreview }
  | { readonly kind: "blocked"; readonly view: CommitPreviewView }
  | { readonly kind: "failed"; readonly reason: string };

const positiveChapter = (value: unknown): number | undefined => (typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined);

/** 交来的参数：章号；「就这么短」只认按钮；补账谁交都行（只出清单，写要作者点「确认记账」）。 */
export function readCommitPrepareParams(origin: string, raw: unknown): CommitPrepareParams | { readonly invalid: string } {
  const record = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const chapter = positiveChapter(record.chapter);
  if (record.fill === true) return chapter ? { chapter, fill: true } : { invalid: "要补哪一章的账没说清。" };
  if (!chapter) return { invalid: "要定稿哪一章没说清。" };
  return { chapter, ...(origin === "button" && record.allowShort === true ? { allowShort: true as const } : {}) };
}

async function readDraft(bookDir: string, chapter: number): Promise<string | undefined> {
  const text = await readFile(defaultDraftPath(bookDir, chapter), "utf-8").catch(() => undefined);
  return text !== undefined && text.trim().length > 0 ? text : undefined;
}

/** 先取依据再读：工作稿、硬闸、人物名单。读的途中作者改了设定，确认时对不上、作废。 */
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
  const text = await readDraft(bookDir, chapter);
  if (text === undefined) return noDraft();
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
  const cards = await readCardsOrLegacy(bookDir);
  const knownNames = cards.cards.filter((card) => card.kind === "character").flatMap((card) => [card.name, ...card.aliases]);
  const notes = !short || !shortAllowed
    ? []
    : shortBefore !== undefined
      ? [`这章原来定稿时就不到 ${short.min} 字，字数下限这次不挡`]
      : [`这章 ${short.current} 字，比字数下限 ${short.min} 字少；你点了照样定稿，只这一章`];
  return { kind: "ok", text, basis, knownNames, notes };
}

/**
 * 补账先冻结：取依据，读这章的账单（得是没记上 / 没记全的、定稿时记的）和定稿正文（哈希得是那份账单记的那版）。
 * 不能补的如实列原因（已经记上了、正文定稿后又改过要先重新定稿、导入的等通读记账）。
 */
async function freezeFill(bookDir: string, chapter: number): Promise<Frozen> {
  const blocked = (reason: string): Frozen => ({ kind: "blocked", view: blockedView(chapter, [reason], `第 ${chapter} 章的账现在补不了：${reason}`) });
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
  const cards = await readCardsOrLegacy(bookDir);
  const knownNames = cards.cards.filter((card) => card.kind === "character").flatMap((card) => [card.name, ...card.aliases]);
  return { kind: "ok", text, basis, knownNames, notes: [], ledgerSha256: file.sha256 };
}

/** 记账员交账单、分流成清单。记账员还没读完前文：这次按已有笔记 + 最近几章原文记，笔记交后台补。 */
async function ledger(bookDir: string, chapter: number, frozen: Extract<Frozen, { kind: "ok" }>, callModel: BrainCallModel): Promise<Ledgered> {
  const preview = await prepareChapterCommit({
    bookDir,
    chapter,
    text: frozen.text,
    callModel,
    basis: frozen.basis,
    knownNames: frozen.knownNames,
    maxCatchUp: KEEPER_MAX_CATCH_UP,
    maxVolumeBuilds: READER_MAX_VOLUME_BUILDS,
  });
  if (preview.cold) requestReaderBackfill(bookDir, { roles: ["ledger"], upTo: chapter - 1 });
  if (preview.ok) return { kind: "ok", preview };
  switch (preview.code) {
    case "basis_changed":
      throw new OperationObsolete("basis_moved", "记账的途中书里有地方改过，这份清单没出；要的话再点一次「定稿」。");
    case "keeper_failed":
      // 记账没成：不整次失败，停下请作者挑「再记一次」还是「先定正文、账待记」。
      return { kind: "failed", reason: preview.reason };
    case "book_unsettled":
      throw coded(preview.code, preview.reason);
    default:
      return { kind: "blocked", view: blockedView(chapter, [preview.reason], `第 ${chapter} 章现在还定不了：${preview.reason}`) };
  }
}

const DRAFT_CHANGED = "清单出来之后正文又改过，这份清单是照改之前记的，没定稿；要的话再点一次「定稿」。";
/** 先定正文、账待记：记账那会儿读的正文之后又改过。 */
const PENDING_DRAFT_CHANGED = "记账那会儿之后正文又改过，没定稿；要的话再点一次「定稿」。";

type Choices = { readonly excluded: readonly number[]; readonly optedIn: readonly number[]; readonly day?: number; readonly dayEnd?: number };

/** 补摘原句那一次没成、那几条因此没记：账记成 partial（核不上原句拒收的照旧算记全了）。 */
function shortfallOf(preview: CommitPreview): LedgerShortfall | undefined {
  return preview.quoteRepair?.failed ? { status: "partial", reasonCodes: ["quote_repair_failed"] } : undefined;
}

/** 照票定稿：预览之后正文改过、书变过都不定，说哪样变了。定完照盘上的账算回执。 */
async function commit(bookDir: string, preview: CommitPreview, choices: Choices): Promise<{ readonly done: CommitDone; readonly snapshotId?: string }> {
  // 定和照盘上算回执在同一把书锁里：定完到读账之间别的操作插不进来（回执卡的条数就是这次写的）。
  const { ticket, chapter } = preview;
  const shortfall = shortfallOf(preview);
  return withBookLock(bookDir, () => commitLocked(bookDir, chapter, ticket.textSha256, ticket.basis, commitEntriesOf(ticket, choices), shortfall, "清单出来之后"));
}

/** 记账没成、作者点了「先定正文、账待记」：正文照冻结那版定，账单记成待记（同一事务、写前存档、能撤销）。 */
async function commitPending(bookDir: string, chapter: number, frozen: Extract<Frozen, { kind: "ok" }>): Promise<{ readonly done: CommitDone; readonly snapshotId?: string }> {
  return withBookLock(bookDir, () => commitLocked(bookDir, chapter, draftFingerprint(frozen.text), frozen.basis, [], { status: "pending", reasonCodes: ["keeper_failed"] }, "记账那会儿之后"));
}

async function commitLocked(
  bookDir: string,
  chapter: number,
  textFingerprint: string,
  basis: TruthBasis,
  entries: ReturnType<typeof commitEntriesOf>,
  shortfall: LedgerShortfall | undefined,
  /** 说「什么时候之后改过」：清单出来之后 / 记账那会儿之后（账待记）。 */
  since: "清单出来之后" | "记账那会儿之后",
): Promise<{ readonly done: CommitDone; readonly snapshotId?: string }> {
  const what = `定稿：第 ${chapter} 章`;
  const draftChanged = since === "清单出来之后" ? DRAFT_CHANGED : PENDING_DRAFT_CHANGED;
  const text = await readDraft(bookDir, chapter);
  if (text === undefined) throw new OperationObsolete("draft_missing", `第 ${chapter} 章的工作稿没了，没定稿。`);
  const fingerprint = draftFingerprint(text);
  if (fingerprint !== textFingerprint) throw new OperationObsolete("draft_changed", draftChanged);
  const args = { chapter, text, entries, ...(shortfall ? { ledger: shortfall } : {}), acceptedBasis: basis.digest };
  const { result, snapshotId } = await runCommandInOperation(bookDir, chapterCommit, args, {
    what,
    caller: "author",
    basis,
    // 作者的选择落在条目里；正文按指纹认（稿纸重新载入只收空段落，字一个没动）。
    intent: { text: fingerprint, entries, ...(shortfall ? { ledger: shortfall } : {}) },
    // 整段在书锁里，走命令的存稿插不进来；不走锁的（在别处直接改了文件）还可能：命令里再读一遍，变了就不定（Astra 第 11 轮：会把旧稿定上）。
    precondition: async () => {
      const now = await readDraft(bookDir, chapter);
      return now !== undefined && draftFingerprint(now) === fingerprint ? undefined : { ok: false, code: "draft_changed", message: draftChanged };
    },
  });
  if (!result.ok) {
    if (result.code === "draft_changed") throw new OperationObsolete("draft_changed", draftChanged);
    if (result.code === "basis_changed") {
      const changes = (result.details as { readonly changes?: readonly BasisChange[] } | undefined)?.changes ?? [];
      throw new OperationObsolete("basis_moved", `${since}${describeBasisChanges(changes)}改过，${since === "清单出来之后" ? "这份清单是照改之前记的，" : ""}没定稿；要的话再点一次「定稿」。`);
    }
    throw coded(result.code, result.message);
  }
  return { done: await commitDoneView(bookDir, chapter, text, result.result), ...(snapshotId ? { snapshotId } : {}) };
}

/** 照票补账：只换这章的账单（作者档，写前存档、能撤销）；补账清单出来之后这章的账、正文、书变过都不写，说哪样变了。 */
async function fill(bookDir: string, preview: CommitPreview, ledgerSha256: string, choices: Choices): Promise<{ readonly done: CommitDone; readonly snapshotId?: string }> {
  const { ticket, chapter } = preview;
  const shortfall = shortfallOf(preview);
  const entries = commitEntriesOf(ticket, choices);
  return withBookLock(bookDir, async () => {
    const { result, snapshotId } = await runCommandInOperation(bookDir, ledgerComplete, {
      chapter,
      ledgerSha256,
      entries,
      ...(shortfall ? { partial: { reasonCodes: shortfall.reasonCodes } } : {}),
      acceptedBasis: ticket.basis.digest,
    }, { what: `补账：第 ${chapter} 章`, caller: "author", basis: ticket.basis });
    if (!result.ok) {
      if (result.code === "basis_changed") {
        const changes = (result.details as { readonly changes?: readonly BasisChange[] } | undefined)?.changes ?? [];
        throw new OperationObsolete("basis_moved", `补账清单出来之后${describeBasisChanges(changes)}改过，这份是照改之前记的，没写；要的话再点一次「补记账」。`);
      }
      if (result.code === "ledger_changed" || result.code === "text_changed" || result.code === "nothing_to_fill") throw new OperationObsolete(result.code, result.message);
      throw coded(result.code, result.message);
    }
    return { done: await fillDoneView(bookDir, chapter, result.result), ...(snapshotId ? { snapshotId } : {}) };
  });
}

/** 上次已经补了（崩在写完、记检查点之前）：照回执报。 */
async function filled(bookDir: string, chapter: number, receipt: CommandReceipt): Promise<{ readonly done: CommitDone }> {
  const outcome = replayedOutcome<LedgerCompleteResult>(receipt, ledgerComplete);
  return withBookLock(bookDir, async () => {
    if (await receiptOnDisk(bookDir, receipt) !== true) return { done: { summary: `第 ${chapter} 章的账那次已经补上了，记了 ${outcome.result.recorded} 条；之后这章又改过，细目不列了。` } };
    return { done: await fillDoneView(bookDir, chapter, outcome.result) };
  });
}

/**
 * 上次已经定了（崩在定完、记检查点之前，ctx.apply 照回执回放）：照回执报，不再核工作稿（作者之后存的新稿不算「改过」）。
 * 盘上还是这次写成的才照盘上算条数；之后这章又定过、撤过的，盘上是后来的，只说回执里有的（Astra 第 14 轮第 2 条）。
 */
async function committed(bookDir: string, chapter: number, receipt: CommandReceipt): Promise<{ readonly done: CommitDone }> {
  const outcome = replayedOutcome<ChapterCommitResult>(receipt, chapterCommit);
  // 核和读在同一把书锁里：核完到读之间别的操作（撤销、重定稿）插不进来（Astra 第 15 轮第 2 条）。
  return withBookLock(bookDir, async () => {
    if (await receiptOnDisk(bookDir, receipt) !== true) return { done: supersededCommitView(chapter, outcome.result) };
    const text = await readFile(join(bookDir, chapterTextPath(chapter)), "utf-8");
    return { done: await commitDoneView(bookDir, chapter, text, outcome.result) };
  });
}


const blockedResult = (chapter: number, view: CommitPreviewView, isFill: boolean): OperationResult => {
  const body: CommitPrepareBody = { kind: COMMIT_PREPARE_KIND, chapter, committed: false, ...(isFill ? { fill: true as const } : {}), blocked: view };
  return { schema: "operation-result/1", summary: view.summary, body };
};

export function createCommitPrepareRecipe(deps: CommitPrepareDeps = DEFAULT_DEPS): Recipe<CommitPrepareParams> {
  return {
    kind: COMMIT_PREPARE_KIND,
    version: 1,
    lane: "foreground",
    // 一章只留一张能点的清单：再点「定稿」出了新清单，旧的那张作废（它是照旧稿记的账）。
    supersedesWaiting: { message: "这一章后来又出了一张定稿清单，用新的那张。" },

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
        budget: COMMIT_LEDGER_SENDS + await frozenCompatAllowance(input.models, COMMIT_TASKS),
      };
    },

    async run(ctx): Promise<OperationResult> {
      const { bookDir, params } = ctx;
      const { chapter } = params;
      const isFill = params.fill === true;
      const frozen = isFill
        ? await ctx.step("freeze", { chapter, fill: true }, () => freezeFill(bookDir, chapter))
        : await ctx.step("freeze", { chapter, allowShort: params.allowShort === true }, () => freeze(bookDir, params));
      if (frozen.kind === "blocked") return blockedResult(chapter, frozen.view, isFill);
      // 记账：没成就停下请作者挑；「再记一次」整步按新轮号重来（额度照算），「先定正文、账待记」不再记、直接定正文。
      let preview: CommitPreview | undefined;
      for (let round = 1; preview === undefined; round += 1) {
        ctx.progress("记账员在记这一章的账");
        const ledgered = await ctx.step(ledgerStepId(round), { chapter, digest: frozen.basis.digest, ...(round > 1 ? { round } : {}) }, () => ledger(bookDir, chapter, frozen, deps.callModel));
        if (ledgered.kind === "blocked") return blockedResult(chapter, ledgered.view, isFill);
        if (ledgered.kind === "ok") {
          preview = ledgered.preview;
          break;
        }
        const choice = ledgerFailedChoice(chapter, ledgered.reason, { pendingAllowed: !isFill });
        const picked = await ctx.waitForAuthor({
          actionId: ledgerFailedAction(round),
          kind: AUTHOR_CHOICE_KIND,
          decisions: choice.choices.map((item) => item.decision),
          preview: choice satisfies AuthorChoicePreview,
        });
        if (picked.decision !== "pending") continue;
        const applied = await ctx.apply("commit-pending", { round }, () => commitPending(bookDir, chapter, frozen), (receipt) => committed(bookDir, chapter, receipt));
        const body: CommitPrepareBody = { kind: COMMIT_PREPARE_KIND, chapter, committed: true, done: applied.done, ...(applied.snapshotId ? { snapshotId: applied.snapshotId } : {}) };
        return { schema: "operation-result/1", summary: applied.done.summary, body };
      }
      const { view, keys } = checklistView(preview, frozen.notes, isFill ? { fill: true } : {});
      const decision = await ctx.waitForAuthor({
        actionId: COMMIT_CONFIRM_ACTION,
        kind: COMMIT_CONFIRM_KIND,
        decisions: ["commit"],
        preview: { view } satisfies CommitConfirmPreview,
        excludable: Object.keys(keys),
        inputs: { day: { min: 1, max: DAY_MAX }, dayEnd: { min: 1, max: DAY_MAX } },
      });
      const choices = {
        ...choicesOfToggled(decision.excluded, keys),
        ...(decision.values.day !== undefined ? { day: decision.values.day } : {}),
        ...(decision.values.dayEnd !== undefined ? { dayEnd: decision.values.dayEnd } : {}),
      };
      const ticketed = preview;
      const applied = isFill
        ? await ctx.apply("fill", { excluded: decision.excluded, values: decision.values }, () => fill(bookDir, ticketed, frozen.ledgerSha256 ?? "", choices), (receipt) => filled(bookDir, chapter, receipt))
        : await ctx.apply("commit", { excluded: decision.excluded, values: decision.values }, () => commit(bookDir, ticketed, choices), (receipt) => committed(bookDir, chapter, receipt));
      const body: CommitPrepareBody = {
        kind: COMMIT_PREPARE_KIND,
        chapter,
        committed: true,
        ...(isFill ? { fill: true as const } : {}),
        done: applied.done,
        ...(applied.snapshotId ? { snapshotId: applied.snapshotId } : {}),
      };
      return { schema: "operation-result/1", summary: applied.done.summary, body };
    },

    stepBudget(stepId) {
      // 记账那步从头做；记账没成的卡上作者点了（「再记一次」要再记一轮）。
      if (stepId === undefined) return 0;
      if (stepId === "ledger" || stepId.startsWith("ledger:")) return COMMIT_LEDGER_SENDS;
      if (stepId.startsWith("author:ledger-failed")) return COMMIT_LEDGER_SENDS;
      return 0;
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
