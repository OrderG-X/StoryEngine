/**
 * canon.propose：定论（写作版本 P2a 片 3C，契约第七节；收编 settle_fact、「以第 N 章为准 / 以本章为准 / 以设定为准 /
 * 以定论为准」、设定本「查前文」、定论卡「确认」）。
 *
 * - `propose`：先取依据再读，查全书哪几句、设定本哪几栏和这条定论对不上、账里哪几条跟着改（核账员那个槽，模型多次）；
 *   没查全、核账报的那句没查出改法都如实写在卡上。预览就存在这一步的输出里（不再另存票库）。
 * - 有要改的（或要记进设定本）就停下等作者点「确认」，卡上每处能划掉；没有要改的就做完，如实说。
 * - `apply`：划掉的去掉，settle.apply 一条作者档命令一次改齐（写前存档、能撤销）；查完之后书变了就不改、说哪样变了。
 * 对话 AI 交（`propose_canon`）只能交「作者定下的说法」（statement）；「以某一边为准」（pick）的原句是核账卡上的，只认按钮。
 */
import { CANON_TEXT_MAX, listChapterTexts, settleApply, type BasisChange, type SettleApplyResult } from "@actalk/story-core";
import { describeBasisChanges } from "../../../book/truth-basis.js";
import { callConfiguredBrainModel, READER_CALL_MAX_SENDS } from "../../../editorial/checker.js";
import type { BrainCallModel } from "../../../editorial/reader-window.js";
import { rereadBlocker } from "../../../editorial/reread-state.js";
import { isEmptySettleArgs, settleApplyArgs } from "../../../editorial/settle/apply-args.js";
import { proposeSettle, type ChapterSide, type SettleProposal, type SettleRequest, type SettleSide } from "../../../editorial/settle/propose.js";
import { frozenCompatAllowance, frozenModelProblem, type FrozenModels, type ModelTaskProfileKey } from "../../../lib/llm-client.js";
import { runCommandInOperation } from "../../../lib/operations/command.js";
import { OperationObsolete, rethrowIfStopped } from "../../../lib/operations/context.js";
import { coded } from "../../draft-change/steps.js";
import type { OperationResult, Recipe } from "../executor.js";

export const CANON_PROPOSE_KIND = "canon.propose";
/** 定论停下等作者点的按钮（种类给界面认卡，号给回显认是哪个按钮）。 */
export const CANON_CONFIRM_KIND = "canon_confirm";
export const CANON_CONFIRM_ACTION = "confirm-canon";

const MAX_QUOTE = 800;
const MAX_ALSO = 10;
const MAX_ITEM_KEY = MAX_QUOTE * 2 + 1;

export interface CanonProposeParams {
  /** pick：以某一边为准（核账卡上的按钮）；statement：按作者定下的说法查（对话、设定本「查前文」、核账卡「以定论为准」）。 */
  readonly mode: "pick" | "statement";
  readonly request: SettleRequest;
  /** 「以本章为准」时核账卡上点的那条（条目键）：原样带回，改齐后核账卡认它改掉了。 */
  readonly item?: string;
  /** 受理时按书的章数算的「查」那一步最多发几次（接着做也按它）。 */
  readonly sends: number;
}

/** 按钮交来的参数（核账卡、设定本、定论卡上「重新查」出的时候就是这个样子）。 */
export type CanonProposeInput =
  | { readonly statement: string; readonly chapter?: number; readonly also?: readonly ChapterSide[] }
  | { readonly chapter: number; readonly truth: SettleSide; readonly other?: SettleSide; readonly also?: readonly ChapterSide[]; readonly reason?: string; readonly item?: string };

/** 卡上摆的（只有名字和原句，不带编号）。 */
export interface CanonCard {
  readonly canon: string;
  readonly canonExists: boolean;
  /** 只是某一场里的事：只改句子，不记进设定本。 */
  readonly sceneOnly?: boolean;
  /** 换掉设定本里原来那条定论（原文）。 */
  readonly replaces?: string;
  readonly chapter?: number;
  readonly edits: readonly { readonly key: string; readonly chapter: number; readonly draft: boolean; readonly from: string; readonly to: string; readonly why?: string }[];
  readonly facts: readonly { readonly chapter: number; readonly before: string; readonly after?: string }[];
  readonly fields: readonly { readonly key: string; readonly card?: string; readonly label: string; readonly from: string; readonly to: string }[];
  readonly searched: readonly number[];
  readonly missed: readonly { readonly chapter: number; readonly quote: string }[];
  readonly failures: readonly string[];
  /** 核账卡上点「以本章为准」的那条（条目键，原样带回）。 */
  readonly resolves?: string;
}

/** 停下等作者时的预览：卡 + 卡上面那句话。 */
export interface CanonConfirmPreview {
  readonly card: CanonCard;
  readonly summary: string;
}

/** 结果的 body：卡、作者划掉的、改没改（界面按它认核账卡上哪几条改掉了、重读概况和设定本）。 */
export interface CanonProposeBody {
  readonly kind: typeof CANON_PROPOSE_KIND;
  readonly card: CanonCard;
  readonly excluded: readonly string[];
  readonly applied: boolean;
  readonly snapshotId?: string;
}

export interface CanonProposeDeps {
  readonly callModel: BrainCallModel;
  readonly modelProblem: (models: FrozenModels, task: ModelTaskProfileKey) => string | undefined;
}

const DEFAULT_DEPS: CanonProposeDeps = { callModel: callConfiguredBrainModel, modelProblem: frozenModelProblem };

/** 查全书用的模型任务：核账员那个槽。 */
const CANON_TASKS: readonly ModelTaskProfileKey[] = ["qualityCheck"];

/**
 * 「查」那一步最多发几次（每次调用连对冲最多 READER_CALL_MAX_SENDS 次）：问涉及谁 1 + 逐批查（一章最多自成一批，再加作者那章的工作稿）
 * + 设定本 1 + 补问 1 + 复核 1 + 账跟着改（每章最多一次）。
 */
export const canonProposeSends = (chapters: number): number => (1 + (chapters + 1) + 1 + 1 + 1 + chapters) * READER_CALL_MAX_SENDS;

function readSide(value: unknown): SettleSide | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const quote = typeof record.quote === "string" ? record.quote.trim() : "";
  if (!quote || quote.length > MAX_QUOTE) return undefined;
  if (record.where === "setting") {
    const label = typeof record.label === "string" ? record.label.trim().slice(0, 40) : "";
    const card = typeof record.card === "string" ? record.card.trim().slice(0, 40) : "";
    return label ? { where: "setting", quote, label, ...(card ? { card } : {}) } : undefined;
  }
  const chapter = typeof record.chapter === "number" ? record.chapter : Number.NaN;
  return record.where === "chapter" && Number.isInteger(chapter) && chapter > 0 ? { where: "chapter", chapter, quote } : undefined;
}

const readAlso = (value: unknown): ChapterSide[] =>
  (Array.isArray(value) ? value : []).slice(0, MAX_ALSO).map(readSide).filter((side): side is ChapterSide => side?.where === "chapter");

const positiveChapter = (value: unknown): number | undefined => (typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined);

/** 交来的参数（按钮、对话工具同一个口）：不认的如实说。sends 在受理时按书算。 */
export function readCanonProposeParams(origin: string, raw: unknown, mode: string | undefined): Omit<CanonProposeParams, "sends"> | { readonly invalid: string } {
  const record = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const chapter = positiveChapter(record.chapter);
  const also = readAlso(record.also);
  if (mode === "statement") {
    const statement = typeof record.statement === "string" ? record.statement.trim() : "";
    if (!statement || statement.length > CANON_TEXT_MAX) return { invalid: "定论的内容不对：一句话说清是什么。" };
    return { mode, request: { kind: "statement", text: statement, ...(chapter ? { chapter } : {}), ...(also.length > 0 ? { also } : {}) } };
  }
  if (mode !== "pick") return { invalid: "要定下什么没说清。" };
  // 「以某一边为准」的两边原句是核账卡上的：只认作者点的按钮。
  if (origin !== "button") return { invalid: "以哪一边为准要你自己在核账卡上点。" };
  const truth = readSide(record.truth);
  if (!chapter || !truth) return { invalid: "定论按钮的内容不对，请刷新后再点。" };
  const other = readSide(record.other);
  const reason = typeof record.reason === "string" ? record.reason.trim().slice(0, 400) : "";
  const item = typeof record.item === "string" && record.item.length > 0 && record.item.length <= MAX_ITEM_KEY ? record.item : undefined;
  return {
    mode,
    request: { kind: "pick", chapter, truth, ...(other ? { other } : {}), ...(also.length > 0 ? { also } : {}), ...(reason ? { reason } : {}) },
    ...(item ? { item } : {}),
  };
}

/** 读过的参数 → 按钮那样的参数（按钮动作里存这个）。 */
export function canonInputOf(params: Omit<CanonProposeParams, "sends">): CanonProposeInput {
  const { request } = params;
  if (request.kind === "statement") {
    return { statement: request.text, ...(request.chapter !== undefined ? { chapter: request.chapter } : {}), ...(request.also ? { also: request.also } : {}) };
  }
  return {
    chapter: request.chapter,
    truth: request.truth,
    ...(request.other ? { other: request.other } : {}),
    ...(request.also ? { also: request.also } : {}),
    ...(request.reason ? { reason: request.reason } : {}),
    ...(params.item ? { item: params.item } : {}),
  };
}

export function canonCardOf(proposal: SettleProposal, item?: string): CanonCard {
  return {
    canon: proposal.canon,
    canonExists: proposal.canonExists,
    ...(proposal.sceneOnly ? { sceneOnly: true } : {}),
    ...(proposal.replaces ? { replaces: proposal.replaces.text } : {}),
    ...(proposal.chapter !== undefined ? { chapter: proposal.chapter } : {}),
    edits: proposal.edits.map((edit) => ({ key: edit.key, chapter: edit.chapter, draft: edit.target === "draft", from: edit.from, to: edit.to, ...(edit.why ? { why: edit.why } : {}) })),
    facts: proposal.facts.map((fact) => ({ chapter: fact.chapter, before: fact.before, ...(fact.after ? { after: fact.after } : {}) })),
    fields: proposal.fields.map((field) => ({ key: field.key, ...(field.card ? { card: field.card } : {}), label: field.label, from: field.from, to: field.to })),
    searched: proposal.searched,
    missed: proposal.missed,
    failures: proposal.failures,
    ...(item ? { resolves: item } : {}),
  };
}

const chapterList = (chapters: readonly number[]): string => [...new Set(chapters)].sort((a, b) => a - b).map((chapter) => `第 ${chapter} 章`).join("、");

/** 卡上面那句话：几处要改（在哪几章）+ 没查成的。定论本身卡上有，不再念一遍。 */
export function canonPreviewSummary(card: CanonCard): string {
  const where = chapterList(card.edits.map((edit) => edit.chapter));
  const fields = card.fields.length > 0 ? `设定本 ${card.fields.length} 栏` : "";
  const parts = [card.edits.length > 0 ? `${where} ${card.edits.length} 句` : "", fields].filter(Boolean).join("、");
  const body = parts
    ? `查完了：${parts}要改。点「确认」一起改齐，改前存档、能撤销。`
    : card.sceneOnly ? "查完了：没有要改的。"
    : card.canonExists ? "查完了：没有要改的，设定本里也记着这条。"
    : card.replaces ? "查完了：没有要改的。点「换掉旧的」把设定本里原来那条换成这条。" : "查完了：没有要改的。点「记下定论」记进设定本。";
  const missed = card.missed.length > 0 ? `核账报的${card.missed.map((item) => `第 ${item.chapter} 章「${item.quote}」`).join("、")}这次没查出改法，可以重新查一遍。` : "";
  const failed = card.failures.length > 0 ? `没查全：${card.failures.join("；")}。` : "";
  return [body, missed, failed].filter(Boolean).join("");
}

/** 改齐之后那句话：记了什么、改了哪几章几处、账里跟着改了 / 作废了什么。 */
export function canonAppliedSummary(result: SettleApplyResult): string {
  const parts: string[] = [];
  if (result.cardLines.length > 0) parts.push(`设定本：${result.cardLines.join("；")}`);
  // 已定稿章另有工作稿的，同一句跟着改了：作者眼里是同一章的同一句，不另报。
  const committed = new Set(result.chapters.map((item) => item.chapter));
  const changes = [
    ...result.chapters.map((item) => ({ chapter: item.chapter, edits: item.edits })),
    ...result.drafts.filter((item) => !committed.has(item.chapter)).map((item) => ({ chapter: item.chapter, edits: item.edits })),
  ].sort((a, b) => a.chapter - b.chapter).map((item) => `第 ${item.chapter} 章 ${item.edits} 句`);
  if (changes.length > 0) parts.push(`改了${changes.join("、")}`);
  const updated = result.chapters.flatMap((item) => item.factsUpdated.map((text) => `第 ${item.chapter} 章「${text}」`));
  if (updated.length > 0) parts.push(`账里跟着改了${updated.join("、")}`);
  const retracted = result.chapters.flatMap((item) => item.factsRetracted.map((text) => `第 ${item.chapter} 章「${text}」`));
  if (retracted.length > 0) parts.push(`账里${retracted.join("、")}原句改了，作废了`);
  const dropped = result.chapters.flatMap((item) => item.presenceDropped.map((name) => `第 ${item.chapter} 章的「${name}」`));
  if (dropped.length > 0) parts.push(`${dropped.join("、")}改后找不到了，出场去掉了`);
  return parts.length > 0 ? `改齐了。${parts.join("；")}（可撤销）。` : "这次什么都没改。";
}

/** 查全书：查的中途这次被停掉（取消、暂停、额度到了）不当成「这一批没查成」，照停。 */
async function propose(bookDir: string, request: SettleRequest, callModel: BrainCallModel): Promise<SettleProposal> {
  let stopped: unknown;
  const guarded: BrainCallModel = async (messages, options) => {
    try {
      return await callModel(messages, options);
    } catch (error) {
      try {
        rethrowIfStopped(error);
      } catch (stop) {
        stopped ??= stop;
      }
      throw error;
    }
  };
  const outcome = await proposeSettle({ projectDir: bookDir, request, callModel: guarded });
  if (stopped) throw stopped;
  if (!outcome.ok) throw coded("propose_failed", outcome.message);
  return outcome.proposal;
}

/** 改齐（作者档，一个事务）：查完之后书变了是过时（说哪样变了），别的如实失败。 */
async function applyProposal(bookDir: string, proposal: SettleProposal, excluded: readonly string[]): Promise<{ readonly summary: string; readonly snapshotId?: string }> {
  const args = await settleApplyArgs(bookDir, proposal, new Set(excluded));
  if (isEmptySettleArgs(args)) {
    throw coded("nothing_applied", proposal.sceneOnly ? "要改的几处都划掉了，这次什么都没改。" : "这条定论已经记着，要改的几处也都划掉了，这次什么都没改。");
  }
  const { result, snapshotId } = await runCommandInOperation(bookDir, settleApply, args, {
    what: "定论改齐",
    caller: "author",
    basis: proposal.basis,
    // 作者的选择只有划掉哪几处（参数里的账是照现在的正文重算的）。
    intent: { excluded: [...excluded].sort() },
  });
  if (!result.ok) {
    if (result.code === "basis_changed") {
      const changes = (result.details as { readonly changes?: readonly BasisChange[] } | undefined)?.changes ?? [];
      throw new OperationObsolete("basis_moved", `查完之后${describeBasisChanges(changes)}改过，这份定论是照改之前查的，没改；要的话重新查一遍。`);
    }
    throw coded(result.code, result.message);
  }
  return { summary: canonAppliedSummary(result.result), ...(snapshotId ? { snapshotId } : {}) };
}

export function createCanonProposeRecipe(deps: CanonProposeDeps = DEFAULT_DEPS): Recipe<CanonProposeParams> {
  return {
    kind: CANON_PROPOSE_KIND,
    version: 1,
    lane: "foreground",

    async prepare(bookDir, input) {
      const read = readCanonProposeParams(input.origin.kind, input.params, input.mode);
      if ("invalid" in read) return { ok: false, code: "bad_params", message: read.invalid };
      // 导入的书还在通读记账（P8）：账没记全，跟着改的那几条对不上。
      const rereading = await rereadBlocker(bookDir, "定论");
      if (rereading) return { ok: false, code: "rereading", message: rereading };
      for (const task of CANON_TASKS) {
        const problem = deps.modelProblem(input.models, task);
        if (problem) return { ok: false, code: "model_missing", message: problem };
      }
      const sends = canonProposeSends((await listChapterTexts(bookDir)).length);
      const params: CanonProposeParams = { ...read, sends };
      return { ok: true, params, mode: read.mode, writeScope: { chapters: [] }, budget: sends + await frozenCompatAllowance(input.models, CANON_TASKS) };
    },

    async run(ctx): Promise<OperationResult> {
      const { bookDir, params } = ctx;
      ctx.progress("在查全书哪几句对不上");
      const proposal = await ctx.step("propose", { request: params.request }, () => propose(bookDir, params.request, deps.callModel));
      const card = canonCardOf(proposal, params.item);
      const summary = canonPreviewSummary(card);
      // 没有要改的、定论也记着（或只是一场的事）：如实说，不出「确认」。
      if (card.edits.length + card.fields.length === 0 && (card.canonExists || card.sceneOnly)) {
        const body: CanonProposeBody = { kind: CANON_PROPOSE_KIND, card, excluded: [], applied: false };
        return { schema: "operation-result/1", summary: `定论「${card.canon}」：${summary}`, body };
      }
      const preview: CanonConfirmPreview = { card, summary };
      const { excluded } = await ctx.waitForAuthor({
        actionId: CANON_CONFIRM_ACTION,
        kind: CANON_CONFIRM_KIND,
        decisions: ["apply"],
        preview,
        excludable: [...card.edits.map((edit) => edit.key), ...card.fields.map((field) => field.key)],
      });
      const applied = await ctx.apply("apply", { excluded }, () => applyProposal(bookDir, proposal, excluded));
      const body: CanonProposeBody = { kind: CANON_PROPOSE_KIND, card, excluded, applied: true, ...(applied.snapshotId ? { snapshotId: applied.snapshotId } : {}) };
      return { schema: "operation-result/1", summary: applied.summary, body };
    },

    stepBudget(stepId, params) {
      return stepId === "propose" ? params.sends : 0;
    },

    modelTasks() {
      return CANON_TASKS;
    },
  };
}

export const canonProposeRecipe = createCanonProposeRecipe();
