/**
 * commit.prepare：定稿（写作版本 P2a 片 4A，设计第八节；收编 commit_preview / commit_apply、「定稿」「就这么短，照样定稿」「确认定稿」）。
 *
 * - `freeze`：先取依据再读工作稿、过硬闸（空的 / 只有标题 / 太短 / 混进工具 JSON 或模型解释话）。过不了就做完、结果里列原因
 *   （只差字数时卡上给「就这么短，照样定稿」：作者点了交一次新的，只认按钮）。
 * - `ledger`：记账员一次交账单 → 核原句 → 分流成清单。票（条目、正文指纹、依据）就是这一步的输出，不再另存。
 * - 停下等作者在定稿清单上点「确认定稿」：每行能去掉（默认不写的能勾上），天数两栏能改。
 * - `commit`：照票和作者的选择交「定稿」命令（作者档，写前存档、能撤销）；预览之后正文改过、前文 / 账 / 设定 / 裁定变过，
 *   都不定稿、说哪样变了。定完重生成老格式镜像，回执里的条数照盘上刚写好的算。
 * 对话 AI 交（`prepare_commit`）和作者点「定稿」是同一次：都只出清单，定稿只能作者点「确认定稿」。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { chapterCommit, chapterTextPath, readCardsOrLegacy, receiptOnDisk, withBookLock, type BasisChange, type ChapterCommitResult, type CommandReceipt, type TruthBasis } from "@actalk/story-core";
import { syncLegacyMirror } from "../../../book/mirror/sync.js";
import { describeBasisChanges, MirrorLagError, readTruthBasisForWork } from "../../../book/truth-basis.js";
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
import { blockedView, checklistView, choicesOfToggled, commitDoneView, committedShortOf, describeGate, supersededCommitView, type CommitDone, type CommitPreviewView } from "../../commit-view.js";
import { coded } from "../../draft-change/steps.js";
import type { OperationResult, Recipe } from "../executor.js";

export const COMMIT_PREPARE_KIND = "commit.prepare";
/** 定稿停下等作者点的按钮（种类给界面认卡，号给回显认是哪个按钮）。 */
export const COMMIT_CONFIRM_KIND = "commit_confirm";
export const COMMIT_CONFIRM_ACTION = "confirm-commit";

/** 天数两栏的范围（作者在清单上改的）。 */
const DAY_MAX = 100_000;

export interface CommitPrepareParams {
  readonly chapter: number;
  /** 作者点了「就这么短，照样定稿」（只认按钮）：这一章不拿字数下限挡。 */
  readonly allowShort?: true;
}

/** 停下等作者时的预览：定稿清单卡那份。 */
export interface CommitConfirmPreview {
  readonly view: CommitPreviewView;
}

/** 结果的 body：定不了的（原因在清单卡上）、定完的（回执）。 */
export interface CommitPrepareBody {
  readonly kind: typeof COMMIT_PREPARE_KIND;
  readonly chapter: number;
  readonly committed: boolean;
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

/** freeze 那一步的输出：能往下记账的材料，或定不了的清单卡。 */
type Frozen =
  | { readonly kind: "ok"; readonly text: string; readonly basis: TruthBasis; readonly knownNames: readonly string[]; readonly notes: readonly string[] }
  | { readonly kind: "blocked"; readonly view: CommitPreviewView };

/** 记账那一步的输出：清单（带票），或定不了的原因。 */
type Ledgered =
  | { readonly kind: "ok"; readonly preview: CommitPreview }
  | { readonly kind: "blocked"; readonly view: CommitPreviewView };

const positiveChapter = (value: unknown): number | undefined => (typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined);

/** 交来的参数：章号；「就这么短」只认按钮。 */
export function readCommitPrepareParams(origin: string, raw: unknown): CommitPrepareParams | { readonly invalid: string } {
  const record = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const chapter = positiveChapter(record.chapter);
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
    if (!(error instanceof MirrorLagError)) throw error;
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
    case "book_unsettled":
      throw coded(preview.code, preview.reason);
    default:
      return { kind: "blocked", view: blockedView(chapter, [preview.reason], `第 ${chapter} 章现在还定不了：${preview.reason}`) };
  }
}

const DRAFT_CHANGED = "清单出来之后正文又改过，这份清单是照改之前记的，没定稿；要的话再点一次「定稿」。";

/** 照票定稿：预览之后正文改过、书变过都不定，说哪样变了。定完重生成镜像、照盘上的账算回执。 */
async function commit(bookDir: string, preview: CommitPreview, choices: { readonly excluded: readonly number[]; readonly optedIn: readonly number[]; readonly day?: number; readonly dayEnd?: number }): Promise<{ readonly done: CommitDone; readonly snapshotId?: string }> {
  // 定和照盘上算回执在同一把书锁里：定完到读账之间别的操作插不进来（回执卡的条数就是这次写的）。
  return withBookLock(bookDir, () => commitLocked(bookDir, preview, choices));
}

async function commitLocked(bookDir: string, preview: CommitPreview, choices: { readonly excluded: readonly number[]; readonly optedIn: readonly number[]; readonly day?: number; readonly dayEnd?: number }): Promise<{ readonly done: CommitDone; readonly snapshotId?: string }> {
  const { ticket, chapter } = preview;
  const what = `定稿：第 ${chapter} 章`;
  const text = await readDraft(bookDir, chapter);
  if (text === undefined) throw new OperationObsolete("draft_missing", `第 ${chapter} 章的工作稿没了，没定稿。`);
  const fingerprint = draftFingerprint(text);
  if (fingerprint !== ticket.textSha256) throw new OperationObsolete("draft_changed", DRAFT_CHANGED);
  const entries = commitEntriesOf(ticket, choices);
  const { result, snapshotId } = await runCommandInOperation(bookDir, chapterCommit, { chapter, text, entries }, {
    what,
    caller: "author",
    basis: ticket.basis,
    // 作者的选择落在条目里；正文按指纹认（稿纸重新载入只收空段落，字一个没动）。
    intent: { text: fingerprint, entries },
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
      throw new OperationObsolete("basis_moved", `清单出来之后${describeBasisChanges(changes)}改过，这份清单是照改之前记的，没定稿；要的话再点一次「定稿」。`);
    }
    throw coded(result.code, result.message);
  }
  return { done: await doneOf(bookDir, chapter, text, result.result), ...(snapshotId ? { snapshotId } : {}) };
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
    return { done: await doneOf(bookDir, chapter, text, outcome.result) };
  });
}

/** 定完：老代码还在读老格式文件，按新账重生成一遍（没成不影响定稿本身，下次取依据时补，但要如实说）；照盘上的账算回执。 */
async function doneOf(bookDir: string, chapter: number, text: string, result: ChapterCommitResult): Promise<CommitDone> {
  const mirror = await syncLegacyMirror(bookDir).catch((error: unknown) => ({ ok: false as const, reason: error instanceof Error ? error.message : String(error) }));
  if (!mirror.ok) console.warn(`[commit.prepare] 第 ${chapter} 章定稿后重生成老格式镜像没成：${mirror.reason}`);
  return commitDoneView(bookDir, chapter, text, result, mirror.ok);
}

const blockedResult = (chapter: number, view: CommitPreviewView): OperationResult => {
  const body: CommitPrepareBody = { kind: COMMIT_PREPARE_KIND, chapter, committed: false, blocked: view };
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
      const rereading = await rereadBlocker(bookDir, "定稿");
      if (rereading) return { ok: false, code: "rereading", message: rereading };
      for (const task of COMMIT_TASKS) {
        const problem = deps.modelProblem(input.models, task);
        if (problem) return { ok: false, code: "model_missing", message: problem };
      }
      return {
        ok: true,
        params,
        writeScope: { chapters: [params.chapter] },
        budget: COMMIT_LEDGER_SENDS + await frozenCompatAllowance(input.models, COMMIT_TASKS),
      };
    },

    async run(ctx): Promise<OperationResult> {
      const { bookDir, params } = ctx;
      const { chapter } = params;
      const frozen = await ctx.step("freeze", { chapter, allowShort: params.allowShort === true }, () => freeze(bookDir, params));
      if (frozen.kind === "blocked") return blockedResult(chapter, frozen.view);
      ctx.progress("记账员在记这一章的账");
      const ledgered = await ctx.step("ledger", { chapter, digest: frozen.basis.digest }, () => ledger(bookDir, chapter, frozen, deps.callModel));
      if (ledgered.kind === "blocked") return blockedResult(chapter, ledgered.view);
      const { preview } = ledgered;
      const { view, keys } = checklistView(preview, frozen.notes);
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
      const applied = await ctx.apply("commit", { excluded: decision.excluded, values: decision.values }, () => commit(bookDir, preview, choices), (receipt) => committed(bookDir, chapter, receipt));
      const body: CommitPrepareBody = { kind: COMMIT_PREPARE_KIND, chapter, committed: true, done: applied.done, ...(applied.snapshotId ? { snapshotId: applied.snapshotId } : {}) };
      return { schema: "operation-result/1", summary: applied.done.summary, body };
    },

    stepBudget(stepId) {
      return stepId === "ledger" ? COMMIT_LEDGER_SENDS : 0;
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

/** 这次做成了、真定了稿的章号。 */
function committedChapter(record: OperationRecord): number | undefined {
  if (record.state !== "succeeded") return undefined;
  const body = (record.result as { readonly body?: Partial<CommitPrepareBody> } | undefined)?.body;
  return body?.kind === COMMIT_PREPARE_KIND && body.committed === true && typeof body.chapter === "number" ? body.chapter : undefined;
}

export const commitPrepareRecipe = createCommitPrepareRecipe();
