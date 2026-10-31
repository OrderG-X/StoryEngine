/**
 * ledger.change：改账（写作版本 P2a 片 3B，契约第七节；收编 manage_ledger、「确认改账」、线索板 / 梗概上直接点的）。
 *
 * - 对话 AI 交（`change_ledger`），改账是作者的决定，AI 只能提：
 *   - edit：`plan`（先取依据再读投影，几条改账请求翻成裁定草案；查不准的如实列进「没改成」）→ 停下等作者点「确认改账」→
 *     `apply`（记裁定，作者档；提议之后账变了就不记、说哪样变了）。
 *   - review（理线索）：`notes`（记账员当场最多补 10 章笔记；缺得更多交后台补读，这次按冷窗口判）→ `review`（记账员按全书判
 *     开着的线索收没收、点出收口原句，代码取原文）→ 有收了的停下等作者点「确认改账」→ `apply`。
 * - 作者在线索板 / 梗概上直接点的（author，只认按钮）：`plan` → `apply`，不再停下问。
 * 改前存档、可撤销。
 */
import { decisionRecord, projectBook, type BasisChange, type CommandReceipt, type DecisionInput, type TruthBasis } from "@actalk/story-core";
import { itOrThem, shortChapters, shortChaptersText, type ShortChapter } from "../../../book/ledger-short.js";
import { describeBasisChanges, readTruthBasisForWork } from "../../../book/truth-basis.js";
import { callConfiguredBrainModel, coldPausedNote, LEDGER_ROLE, reviewOpenThreads, type BrainCallModel, type ThreadReviewOutcome } from "../../../editorial/index.js";
import { KEEPER_MAX_CATCH_UP } from "../../../editorial/ledger-keeper.js";
import { READER_MAX_VOLUME_BUILDS } from "../../../editorial/continuity/check-service.js";
import { READER_CALL_MAX_SENDS } from "../../../editorial/checker.js";
import { prepareReaderNotes } from "../../../editorial/prepare-notes.js";
import { rereadBlocker } from "../../../editorial/reread-state.js";
import { MAX_REVIEW_THREADS } from "../../../editorial/thread-review.js";
import { frozenCompatAllowance, frozenModelProblem, type FrozenModels, type ModelTaskProfileKey } from "../../../lib/llm-client.js";
import { replayedOutcome, runCommandInOperation } from "../../../lib/operations/command.js";
import { OperationObsolete, rethrowIfStopped } from "../../../lib/operations/context.js";
import { submitReaderBackfill } from "../../../lib/reader-backfill.js";
import { coded } from "../../draft-change/steps.js";
import { MAX_DECISIONS_PER_CHANGE, planLedgerRequests, readLedgerRequest, type LedgerChangeRequest } from "../../ledger-change/plan.js";
import type { OperationResult, Recipe } from "../executor.js";
import { modelFailureText } from "../../../lib/ai-errors.js";

export const LEDGER_CHANGE_KIND = "ledger.change";
/** 改账停下等作者点的按钮（种类给界面认卡，号给回显认是哪个按钮）。 */
export const LEDGER_CONFIRM_KIND = "ledger_confirm";
export const LEDGER_CONFIRM_ACTION = "confirm-ledger";
/** 一次最多交几条改账请求（每条至少一笔裁定，和一次最多记的笔数同一个数）。 */
export const MAX_LEDGER_CHANGES = MAX_DECISIONS_PER_CHANGE;

export type LedgerChangeParams =
  /** edit：对话 AI 提的；author：作者在线索板 / 梗概上直接点的。notDone = 交来时就认不出的那几条。 */
  | { readonly mode: "edit" | "author"; readonly changes: readonly LedgerChangeRequest[]; readonly notDone: readonly string[] }
  /** 理线索：记账员按全书判开着的线索收没收。 */
  | { readonly mode: "review" };

/** 卡上摆的（改设定的确认卡同一个形状）：要改的每一条（只有名字、原话），和附带要说的。 */
export interface LedgerConfirmPreview {
  readonly lines: readonly string[];
  readonly notes: readonly string[];
}

/** 结果的 body（界面按它重读概况、登记撤销点）。 */
export interface LedgerChangeBody {
  readonly kind: typeof LEDGER_CHANGE_KIND;
  readonly applied: readonly string[];
  readonly notes: readonly string[];
  readonly snapshotId?: string;
}

interface LedgerPlan {
  readonly decisions: readonly DecisionInput[];
  readonly lines: readonly string[];
  /** 算不成的那几条（如实列进「没改成」）。 */
  readonly notDone: readonly string[];
  /** 提议时书的样子（作者点的时候比）。 */
  readonly basis: TruthBasis;
}

export interface LedgerChangeDeps {
  readonly keeperCallModel: BrainCallModel;
  readonly modelProblem: (models: FrozenModels, task: ModelTaskProfileKey) => string | undefined;
}

const DEFAULT_DEPS: LedgerChangeDeps = { keeperCallModel: callConfiguredBrainModel, modelProblem: frozenModelProblem };

/** 理线索用到的模型任务：记账员（核账员那个槽）。 */
const REVIEW_TASKS: readonly ModelTaskProfileKey[] = ["qualityCheck"];

/** 理线索每一步最多发几次：当场补笔记（章上限 + 卷节点上限）；判一次 + 判收了的每章点一次句子（最多理的条数）。 */
export const LEDGER_REVIEW_STEP_BUDGET: Readonly<Record<string, number>> = {
  notes: (KEEPER_MAX_CATCH_UP + READER_MAX_VOLUME_BUILDS) * READER_CALL_MAX_SENDS,
  review: (1 + MAX_REVIEW_THREADS) * READER_CALL_MAX_SENDS,
};

const trimStop = (text: string): string => (text.endsWith("。") ? text.slice(0, -1) : text);

export function readLedgerChangeParams(origin: string, raw: unknown, mode: string | undefined): LedgerChangeParams | { readonly invalid: string } {
  const record = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  if (mode === "review") return { mode: "review" };
  if (mode !== "edit" && mode !== "author") return { invalid: "要做什么没说清：改哪几笔账，或者理一遍线索。" };
  // 直接改（不再问）是作者的事：只认作者点的按钮。
  if (mode === "author" && origin !== "button") return { invalid: "直接改账要你自己点按钮。" };
  const items = Array.isArray(record.changes) ? record.changes : [];
  if (items.length === 0) return { invalid: "没说要改哪几笔账。" };
  if (items.length > MAX_LEDGER_CHANGES) return { invalid: `一次最多改 ${MAX_LEDGER_CHANGES} 条，这次有 ${items.length} 条，分几次提。` };
  const changes: LedgerChangeRequest[] = [];
  const notDone: string[] = [];
  items.forEach((item, index) => {
    const request = readLedgerRequest(item);
    if (request) changes.push(request);
    else notDone.push(`第 ${index + 1} 条没说清要做哪种改动`);
  });
  if (changes.length === 0) return { invalid: `账没改：${notDone.join("；")}。` };
  return { mode, changes, notDone };
}

/** 先取依据再读投影：读的中途账变了，确认时对不上，照样作废。 */
async function planChanges(bookDir: string, changes: readonly LedgerChangeRequest[], notDone: readonly string[]): Promise<LedgerPlan> {
  const basis = await readTruthBasisForWork(bookDir);
  const view = await projectBook(bookDir);
  if (view.chapters.length === 0) throw coded("no_chapters", "还没有定稿的章，账本是空的；先定稿一章再改账。");
  const planned = planLedgerRequests(view, changes);
  return { decisions: planned.decisions, lines: planned.lines, notDone: [...notDone, ...planned.notDone], basis };
}

const notDoneNotes = (notDone: readonly string[]): readonly string[] => (notDone.length > 0 ? [`没改成：${notDone.join("；")}。`] : []);

const shortQuote = (text: string): string => (text.length > 40 ? `${text.slice(0, 40)}…` : text);

/** 理线索的结论：收了的翻成「收掉线索」的裁定，还开着、拿不准、点不出原句、没看到的如实说。 */
function reviewPlan(review: Extract<ThreadReviewOutcome, { ok: true }>, short: readonly ShortChapter[]): { readonly head: string; readonly decisions: readonly DecisionInput[]; readonly lines: readonly string[]; readonly notes: readonly string[] } {
  const shown = review.suggestions.slice(0, MAX_DECISIONS_PER_CHANGE);
  const notes = [
    // 账待记的章（正文定了、账还没记上）：那几章收没收线索账里看不出来，如实说。
    short.length > 0 ? `${shortChaptersText(short)}，这份缺${itOrThem(short)}的账。` : "",
    review.unsure.length > 0 ? `拿不准的 ${review.unsure.length} 条：${review.unsure.slice(0, 5).map((title) => `「${title}」`).join("")}${review.unsure.length > 5 ? "等" : ""}，你看着定。` : "",
    ...review.unproven.slice(0, 5).map((item) => `「${item.title}」记账员说${item.chapter !== undefined ? `第 ${item.chapter} 章` : ""}收了，但${item.why}，没列。`),
    review.unproven.length > 5 ? `另有 ${review.unproven.length - 5} 条也是点不出原句，没列。` : "",
    review.suggestions.length > shown.length ? `一次最多记 ${MAX_DECISIONS_PER_CHANGE} 条，另有 ${review.suggestions.length - shown.length} 条下次再理。` : "",
    review.omitted > 0 ? `开着的太多，这次只看了 ${review.reviewed} 条，另有 ${review.omitted} 条没看。` : "",
    review.cold ? `记账员还没读完全书（第 ${review.cold.notedThrough} 章），这次按已有笔记和最近几章原文判的，更早的可能漏。${coldPausedNote(review.cold)}` : "",
    ...review.failures.slice(0, 2).map((failure) => `（有一步没跑成：${failure}）`),
  ].filter(Boolean);
  const stillOpen = review.stillOpen > 0 ? `，${review.stillOpen} 条还开着` : "";
  const head = shown.length > 0
    ? `理了 ${review.reviewed} 条开着的线索：${shown.length} 条看着已经收了${stillOpen}。`
    : `理了 ${review.reviewed} 条开着的线索：没有看着已经收了的${stillOpen}。`;
  return {
    head,
    decisions: shown.map((item) => ({ type: "thread.close" as const, thread: item.thread, chapter: item.chapter })),
    lines: shown.map((item) => `「${item.title}」第 ${item.chapter} 章已收：「${shortQuote(item.quote)}」`),
    notes,
  };
}

/** 记裁定（作者档，一个事务：要么全记上、要么都不记）；依据变了是过时（说哪样变了），别的如实失败。 */
async function applyDecisions(bookDir: string, decisions: readonly DecisionInput[], basis: TruthBasis | undefined): Promise<{ readonly applied: number; readonly snapshotId?: string }> {
  const { result, snapshotId } = await runCommandInOperation(bookDir, decisionRecord, { decisions: [...decisions] }, {
    what: "改账",
    caller: "author",
    ...(basis ? { basis } : {}),
  });
  if (!result.ok) {
    if (result.code === "basis_changed") {
      const changes = (result.details as { readonly changes?: readonly BasisChange[] } | undefined)?.changes ?? [];
      throw new OperationObsolete("basis_moved", `提议之后${describeBasisChanges(changes)}改过，这份改账是照改之前算的，没改。`);
    }
    throw coded(result.code, result.message);
  }
  return { applied: decisions.length, ...(snapshotId ? { snapshotId } : {}) };
}

/** 上次已经记上了（崩在记完、记检查点之前，ctx.apply 照回执回放）。 */
function decisionsRecorded(receipt: CommandReceipt, decisions: readonly DecisionInput[]): { readonly applied: number } {
  replayedOutcome(receipt, decisionRecord);
  return { applied: decisions.length };
}

function succeeded(lines: readonly string[], notes: readonly string[], snapshotId: string | undefined): OperationResult {
  const body: LedgerChangeBody = { kind: LEDGER_CHANGE_KIND, applied: lines, notes, ...(snapshotId ? { snapshotId } : {}) };
  return { schema: "operation-result/1", summary: `账改好了：${trimStop(lines.join("；"))}（可撤销）。${notes.join("")}`, body };
}

export function createLedgerChangeRecipe(deps: LedgerChangeDeps = DEFAULT_DEPS): Recipe<LedgerChangeParams> {
  return {
    kind: LEDGER_CHANGE_KIND,
    version: 1,
    lane: "foreground",

    async prepare(bookDir, input) {
      const params = readLedgerChangeParams(input.origin.kind, input.params, input.mode);
      if ("invalid" in params) return { ok: false, code: "bad_params", message: params.invalid };
      if (params.mode !== "review") return { ok: true, params, mode: params.mode, writeScope: { chapters: [] }, budget: 0 };
      // 导入的书还在通读记账（P8）：账没记全，理出来的对不上全书。
      const rereading = await rereadBlocker(bookDir, "理线索");
      if (rereading) return { ok: false, code: "rereading", message: rereading };
      for (const task of REVIEW_TASKS) {
        const problem = deps.modelProblem(input.models, task);
        if (problem) return { ok: false, code: "model_missing", message: problem };
      }
      const budget = Object.values(LEDGER_REVIEW_STEP_BUDGET).reduce((sum, value) => sum + value, 0) + await frozenCompatAllowance(input.models, REVIEW_TASKS);
      return { ok: true, params, mode: "review", writeScope: { chapters: [] }, budget };
    },

    async run(ctx): Promise<OperationResult> {
      const { bookDir, params } = ctx;
      if (params.mode !== "review") {
        const plan = await ctx.step("plan", { changes: params.changes, notDone: params.notDone }, () => planChanges(bookDir, params.changes, params.notDone));
        if (plan.decisions.length === 0) throw coded("nothing_applied", plan.notDone.length > 0 ? `${plan.notDone.join("；")}。` : "没有要改的。");
        const notes = notDoneNotes(plan.notDone);
        if (params.mode === "edit") {
          const preview: LedgerConfirmPreview = { lines: plan.lines, notes };
          await ctx.waitForAuthor({ actionId: LEDGER_CONFIRM_ACTION, kind: LEDGER_CONFIRM_KIND, decisions: ["apply"], preview });
        }
        const applied = await ctx.apply("apply", { decisions: plan.decisions }, () => applyDecisions(bookDir, plan.decisions, plan.basis), async (receipt) => decisionsRecorded(receipt, plan.decisions));
        return succeeded(plan.lines, notes, applied.snapshotId);
      }

      // 理线索：先取依据（理的中途、作者点之前账变了，确认时不记）。
      const { basis, upTo, short } = await ctx.step("basis", {}, async () => {
        const taken = await readTruthBasisForWork(bookDir);
        const projection = await projectBook(bookDir);
        return { basis: taken, upTo: projection.upTo, short: shortChapters(projection.chapters) };
      });
      if (upTo === 0) throw coded("no_chapters", "还没有定稿的章，没有线索可理。");
      await ctx.step("notes", { upTo }, async () => {
        ctx.progress("记账员在读前文");
        try {
          const notes = await prepareReaderNotes({
            projectDir: bookDir,
            role: LEDGER_ROLE,
            chapter: upTo + 1,
            callModel: deps.keeperCallModel,
            maxCatchUp: KEEPER_MAX_CATCH_UP,
            maxVolumeBuilds: READER_MAX_VOLUME_BUILDS,
            waitingAs: "理线索",
          });
          if (notes.missing > 0 && !notes.pausedBackfill) await submitReaderBackfill(bookDir, { roles: [LEDGER_ROLE.id], upTo });
          return { missing: notes.missing };
        } catch (error) {
          rethrowIfStopped(error);
          throw coded("notes_failed", `记账员读前文没成：${modelFailureText(error)}`);
        }
      });
      ctx.progress("记账员在理开着的线索");
      // 笔记在上一步补过：这里当场一份不补（缺的按冷窗口判）。
      const review = await ctx.step("review", { upTo }, async () => {
        const outcome = await reviewOpenThreads({ projectDir: bookDir, callModel: deps.keeperCallModel, maxCatchUp: 0, maxVolumeBuilds: 0 });
        if (!outcome.ok) throw coded("review_failed", `线索没理成：${trimStop(outcome.reason)}。`);
        return outcome;
      });
      const plan = reviewPlan(review, short ?? []);
      if (plan.decisions.length === 0) {
        const body: LedgerChangeBody = { kind: LEDGER_CHANGE_KIND, applied: [], notes: plan.notes };
        return { schema: "operation-result/1", summary: `${plan.head}${plan.notes.join("")}`, body };
      }
      const preview: LedgerConfirmPreview = { lines: plan.lines, notes: [plan.head, ...plan.notes] };
      await ctx.waitForAuthor({ actionId: LEDGER_CONFIRM_ACTION, kind: LEDGER_CONFIRM_KIND, decisions: ["apply"], preview });
      const applied = await ctx.apply("apply", { decisions: plan.decisions }, () => applyDecisions(bookDir, plan.decisions, basis), async (receipt) => decisionsRecorded(receipt, plan.decisions));
      return succeeded(plan.lines, plan.notes, applied.snapshotId);
    },

    stepBudget(stepId, params) {
      if (stepId === undefined || params.mode !== "review") return 0;
      return LEDGER_REVIEW_STEP_BUDGET[stepId] ?? 0;
    },

    modelTasks(params) {
      return params.mode === "review" ? REVIEW_TASKS : [];
    },
  };
}

export const ledgerChangeRecipe = createLedgerChangeRecipe();
