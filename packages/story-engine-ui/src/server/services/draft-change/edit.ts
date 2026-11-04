/**
 * draft.change 的改稿三种（写作版本 P2a 片 2C，设计 3.1 末两条、6.6）：改已有的工作稿，改前存档、可撤销。
 * - revise：改一段或几段（对话里改稿、选中文字改写）。带 preview 的改好先给作者看：作者点「换上」才换，「再改一版」重改，「不要了」停掉。
 * - fix：核账卡「改这处 / 改掉这 N 处」（按编号句子，一章几处问一次模型）。改完自己再核一遍（只核改过的句子），
 *   作者点的还在报、或改出了新错（改过的句子、本章别处还照改前说的）就再改一轮、再核；两轮都在稿子外面算，最后一次换上（一个存档点）。
 *   还剩的列在卡上交作者；定稿时正文没再动就直接用这遍核账，不再花钱。
 * - deai：AI 味卡「改掉这句 / 一键全修」。
 *
 * 步骤：materials（依据 + 稿同一次读）→ revise:n / fix / deai（只算）→（preview：等作者 confirm:n → fresh:n 核底版和依据，
 * 变了就作废、说哪样变了）→ apply（applyAiDraft；没 preview 的写的途中稿子或前文变了，照写稿一样留成候选）。
 * 一处都没改成如实说为什么（not_changed），稿子不动。
 */
import { diffTruthBasis, parseDraftFile, quoteInText, readDraftFile, readDraftState, type TruthBasis } from "@actalk/story-core";
import { continuityFixGoal } from "../../../lib/continuity-fix.js";
import type { ContinuityCheckData } from "../../../type-defs/workspace.js";
import { describeBasisChanges, readTruthBasisForWork } from "../../book/truth-basis.js";
import type { BrainCallModel } from "../../editorial/reader-window.js";
import { checkChapterBody, ownChapterIssues, prepareCheckerNotes, type ChapterCheckItem } from "../../editorial/continuity/check-service.js";
import { rereadBlocker } from "../../editorial/reread-state.js";
import { modelFailureText } from "../../lib/ai-errors.js";
import { applyAiDraft } from "../../lib/ai-draft-write.js";
import { rethrowIfStopped } from "../../lib/operations/context.js";
import { readAntiRules } from "../../writing/ai-flavor/anti-rules.js";
import { runDeAiFlavorBatch, type DeAiCallModel } from "../de-ai-flavor-batch.js";
import { authorStepId, OperationObsolete, type OperationResult, type RecipeContext } from "../operations/executor.js";
import { FIX_ROUNDS, fixByUnits } from "../unit-fix.js";
import { EDIT_MAX_FIXES, type DraftDeaiParams, type DraftEditMode, type DraftEditParams, type DraftFixParams, type DraftReviseEdit } from "./params.js";
import type { DraftApplied } from "./result.js";
import { reviseDraftText, type RevisionFailure, type RevisionModelCaller } from "./revise-text.js";
import { coded } from "./steps.js";

/** 作者看改法的那个按钮（卡上按它出「换上 / 再改一版」）。 */
export const REVISE_CONFIRM_KIND = "draft.revise.confirm";
/** 「再改一版」最多改到第几版（到了只剩「换上」「不要了」）。 */
export const REVISE_MAX_ROUNDS = 5;

export interface DraftEditDeps {
  /** 改一段、按核账改（repair 槽）。 */
  readonly fixCallModel: RevisionModelCaller;
  /** 去机器腔（repair 槽）。 */
  readonly deAiCallModel: DeAiCallModel;
  /** 按核账改完再核（核账员，qualityCheck 槽）。 */
  readonly readerCallModel: BrainCallModel;
}

/** 按核账改完再核的结果（进结果，卡上列还剩的）。 */
export interface FixVerify {
  /** 再核跑成了几遍（0 = 没核成，原因在 failure）。 */
  readonly checks: number;
  /** 第二轮又改了几句。 */
  readonly again: number;
  /** 最后一遍还对不上的（本章确定的 + 上次改过又被报的）：卡上列，作者定。 */
  readonly left?: ContinuityCheckData;
  readonly failure?: string;
}

/** 开改时的样子：先读依据，再读稿（全文带章名行，和版本一起读的）。 */
export interface EditMaterials {
  readonly basis: TruthBasis;
  readonly baseVersion: string;
  readonly text: string;
}

/** 换上去的一处（改前 → 改后）：卡上给作者看、稿纸上高亮改后的。 */
export interface EditChange {
  readonly from: string;
  readonly to: string;
}

/** 没改成的一处：要改的原文 + 为什么（给作者看的话）。 */
export interface EditFailure {
  readonly target: string;
  readonly why: string;
}

/** 改的那一步的输出（存进检查点）。 */
export interface EditOutcome {
  /** 改后的全文（一处都没改成就是原文）。 */
  readonly text: string;
  readonly changes: readonly EditChange[];
  readonly failed: readonly EditFailure[];
  /** fix：不是点名的、本章别处说同一件事跟着改的句数。 */
  readonly alsoChanged?: number;
  /** fix：改了、但核账引的原句还原样在稿里的那几处（改在本章别的句子上、重复的句子只改了一次）；改完再核交核账员复核。 */
  readonly revisit?: readonly string[];
  /** revise 只改了一段时 AI 说的改了什么；按作者给的原文换上的是 exact。 */
  readonly brief?: string;
  readonly exact?: true;
  /** deai：写作规则没读上之类，结论后面补一句。 */
  readonly note?: string;
  /** fix：改完再核（有改动才有）。 */
  readonly verify?: FixVerify;
}

/** 等作者时卡上摆的（preview）。 */
export interface RevisePreview {
  readonly round: number;
  readonly changes: readonly EditChange[];
  readonly failed: readonly EditFailure[];
  readonly brief?: string;
}

/** draft.change 改稿的 `body`（和写稿同一个 kind：界面按 chapter / ok / snapshotId 刷稿纸、记撤销点）。 */
export interface DraftEditBody {
  readonly kind: "draft.change";
  readonly mode: DraftEditMode;
  /** 换上了。没换上（写的途中稿子或前文改过）是 false，这版留成候选（kept）。 */
  readonly ok: boolean;
  readonly chapter: number;
  readonly draftTitle?: string;
  readonly version?: string;
  readonly snapshotId?: string;
  readonly kept?: { readonly candidateId: string; readonly reason: "draft_moved" | "basis_moved" | "apply_failed"; readonly handled?: true };
  readonly changes: readonly EditChange[];
  readonly failed: readonly EditFailure[];
  readonly alsoChanged?: number;
  readonly verify?: FixVerify;
}

/* ------------------------------------------------------------------ */
/*  受理前                                                              */
/* ------------------------------------------------------------------ */

/** 这一章现在能不能改：没有工作稿（或稿里没正文）就是一句原因和失败码。 */
export async function editTargetProblem(projectDir: string, chapter: number): Promise<{ readonly code: string; readonly message: string } | undefined> {
  const file = await readDraftFile(projectDir, chapter).catch(() => undefined);
  if (!file || !parseDraftFile(file.text).body.trim()) return { code: "no_draft", message: `第 ${chapter} 章还没有工作稿，没有可改的。` };
  return undefined;
}

/** 哪几步会调模型（接着做时额度按它加）：改的那一步；按核账改完补笔记、再核、再改；等作者看改法那一步之后可能「再改一版」。 */
export function editStepCallsModel(stepId: string): boolean {
  return stepId === "fix" || stepId === "deai" || stepId === "notes" || stepId.startsWith("fix:") || stepId.startsWith("check:")
    || stepId.startsWith("revise:") || stepId.startsWith(authorStepId("confirm:"));
}

/* ------------------------------------------------------------------ */
/*  各步                                                                */
/* ------------------------------------------------------------------ */

export async function readEditMaterials(projectDir: string, chapter: number): Promise<EditMaterials> {
  // 先读依据、再读稿（P1b）：途中作者改了什么，换上时都对得出来。
  const basis = await readTruthBasisForWork(projectDir);
  const file = await readDraftFile(projectDir, chapter).catch(() => undefined);
  if (!file || !parseDraftFile(file.text).body.trim()) throw coded("no_draft", `第 ${chapter} 章还没有工作稿，没有可改的。`);
  return { basis, baseVersion: file.version, text: file.text };
}

const REVISION_WHY: Readonly<Record<RevisionFailure["code"], string>> = {
  target_empty: "没说要改哪段",
  goal_empty: "没说往哪改",
  target_not_found: "原文在稿里找不到了（可能已经改过）",
  target_ambiguous: "原文在稿里不止一处，不知道改哪一处",
  exact_replacement_noop: "给的新文本和原文一样",
  model_output_unusable: "AI 没给出能用的改法",
  before_text_not_found: "AI 改出来的对不上原处",
  before_text_ambiguous: "AI 改出来的对不上原处",
  drift_rejected: "AI 去改了别处，不是要改的那段",
  noop: "AI 改出来的和原文一样",
  target_unchanged: "改完原文还原样在稿里，等于没改到",
};

function revisionWhy(failure: RevisionFailure): string {
  const why = REVISION_WHY[failure.code];
  return failure.code === "model_output_unusable" && failure.detail ? `${why}（${failure.detail}）` : why;
}

/**
 * 改几段（不读盘、不写盘）：按先后在同一份稿上一段一段改，后一段在前一段改完的稿上找。
 * avoid：「再改一版」时上一版改成的样子，交给修订模型别再改成一样的。
 */
export async function reviseEdits(input: {
  readonly projectDir: string;
  readonly chapter: number;
  readonly text: string;
  readonly edits: readonly DraftReviseEdit[];
  readonly style?: "deai";
  readonly avoid?: readonly string[];
  readonly callModel: RevisionModelCaller;
}): Promise<EditOutcome> {
  let text = input.text;
  const changes: EditChange[] = [];
  const failed: EditFailure[] = [];
  let brief: string | undefined;
  let exact = false;
  const constraints = (input.avoid ?? []).map((before) => `上一版改成了「${before}」，作者要再改一版：换个改法，别和上一版一样。`);
  for (const edit of input.edits) {
    const revised = await reviseDraftText({
      projectDir: input.projectDir,
      chapter: input.chapter,
      draftContent: text,
      targetText: edit.targetText,
      revisionGoal: edit.revisionGoal ?? "",
      ...(input.style ? { style: input.style } : {}),
      ...(edit.replacementText ? { replacementText: edit.replacementText } : {}),
      ...(constraints.length > 0 ? { constraints } : {}),
      callModel: input.callModel,
    });
    if (!revised.ok) {
      failed.push({ target: edit.targetText, why: revisionWhy(revised) });
      continue;
    }
    changes.push({ from: revised.preview.beforeText, to: revised.preview.afterText.trim() });
    exact = revised.mode === "exact";
    // changeSummary 是模型写的，常自带句号：去掉再接。
    // 不猜白名单：切句
    brief = revised.mode === "model" ? revised.preview.changeSummary?.trim().replace(/[。.\s]+$/u, "") || undefined : undefined;
    text = revised.updatedContent;
  }
  // 只改了一段才带它自己的说法（几段的各说各的，结论只说几处）。
  const single = changes.length === 1 && input.edits.length === 1;
  return { text, changes, failed, ...(single && brief ? { brief } : {}), ...(single && exact ? { exact: true as const } : {}) };
}

async function fixEdits(input: {
  readonly chapter: number;
  readonly text: string;
  readonly fixes: readonly { readonly targetText: string; readonly revisionGoal: string }[];
  readonly callModel: RevisionModelCaller;
}): Promise<EditOutcome> {
  const outcome = await fixByUnits({
    chapter: input.chapter,
    text: input.text,
    fixes: input.fixes.map((fix) => ({ quote: fix.targetText, goal: fix.revisionGoal })),
    callModel: input.callModel,
  });
  return {
    text: outcome.text,
    changes: outcome.changes,
    failed: outcome.failed.map(({ fix, why }) => ({ target: input.fixes[fix]!.targetText, why })),
    ...(outcome.alsoChanged > 0 ? { alsoChanged: outcome.alsoChanged } : {}),
    ...(outcome.revisit.length > 0 ? { revisit: outcome.revisit.map((fix) => input.fixes[fix]!.targetText) } : {}),
  };
}

type Verified = { readonly ok: true; readonly left: ContinuityCheckData } | { readonly ok: false; readonly reason: string };

/** 改完再核前，核账员先把前文笔记补到上一章（和定稿那遍同一套）；没成就不再核，结论里说一句。 */
async function verifyNotes(projectDir: string, chapter: number, callModel: BrainCallModel): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
  const rereading = await rereadBlocker(projectDir, "核账");
  if (rereading) return { ok: false, reason: rereading };
  try {
    await prepareCheckerNotes(projectDir, chapter, callModel);
    return { ok: true };
  } catch (error) {
    rethrowIfStopped(error);
    return { ok: false, reason: `核账员读前文没成：${modelFailureText(error)}` };
  }
}

/**
 * 核改过的这份（稿子外面、还没换上）：只核改过的这几句（上一遍整章核过、记忆对得上时），否则整章核；
 * 改了但原句还原样在稿里的那几处（revisit）上一遍的条目交核账员复核，不原样带着。
 * 还对不上的 = 错在本章、确定的，加上以前改过又被报回来的（降成「可能」的那种），都交下一轮 / 作者。
 * 这遍核全了会存成这份正文的核账记忆：换上后定稿正文没再动就直接用，不再花钱。
 */
async function verifyFix(projectDir: string, chapter: number, text: string, changes: readonly EditChange[], callModel: BrainCallModel, revisit?: readonly string[]): Promise<Verified> {
  try {
    const result = await checkChapterBody(projectDir, chapter, parseDraftFile(text).body.trim(), {
      readerCallModel: callModel,
      afterFix: changes,
      notesReady: {},
      ...(revisit && revisit.length > 0 ? { revisit } : {}),
    });
    if (!result.ok) return { ok: false, reason: result.failures[0] ?? "原因不明" };
    return {
      ok: true,
      left: {
        chapter,
        sure: ownChapterIssues(result.sure, chapter),
        maybe: ownChapterIssues(result.maybe.filter((item) => item.revisited), chapter),
      },
    };
  } catch (error) {
    rethrowIfStopped(error);
    return { ok: false, reason: modelFailureText(error) };
  }
}

const leftCount = (left: ContinuityCheckData): number => left.sure.length + left.maybe.length;

const sameSentence = (a: string, b: string): boolean => Boolean(a && b) && (quoteInText(a, b) || quoteInText(b, a));

/**
 * 第二轮只管两样：作者点了要改、还在报的（第一轮没改成、改了还不对），和第一轮改出来的（报的就是改过的句子，
 * 或本章别的句子跟改过的那句对不上）。作者没点的（两章打架、和设定打架的要作者定哪边为准，P12）、以前改过又被报的
 * 不替作者改，留在卡上。
 */
function againItems(chapter: number, left: ContinuityCheckData, first: EditOutcome, fixes: DraftFixParams["fixes"]): ChapterCheckItem[] {
  const touched = (text: string): boolean => first.changes.some((change) => sameSentence(text, change.to));
  const asked = (text: string): boolean => fixes.some((fix) => sameSentence(text, fix.targetText));
  return [...left.sure, ...left.maybe].filter((item) => asked(item.quote) || touched(item.quote)
    || (!item.againstSetting && (item.earlierChapter <= 0 || item.earlierChapter === chapter) && touched(item.earlierQuote)));
}

/**
 * 第二轮改法：和第一轮同一句话（和哪句对上 + 理由）；这句是第一轮刚改出来的，再带上第一轮那条要求，两样都要对上
 * （不然改回去又和第一轮那句对不上，来回改）。
 */
function againGoal(chapter: number, item: ChapterCheckItem, first: readonly EditChange[], fixes: DraftFixParams["fixes"]): string {
  const goal = continuityFixGoal(chapter, item);
  const changed = first.find((change) => sameSentence(item.quote, change.to));
  const earlier = changed ? fixes.find((fix) => sameSentence(fix.targetText, changed.from)) : undefined;
  return earlier ? `${goal}；这句刚按「${earlier.revisionGoal}」改过，两样都要对得上` : goal;
}

/** 两轮的改动并成一份：第二轮改的是第一轮改出来的句子就接上（改前取最早那版），改回原样的去掉。 */
function mergeRounds(first: EditOutcome, second: EditOutcome): EditOutcome {
  const changes = [...first.changes];
  for (const change of second.changes) {
    const at = changes.findIndex((earlier) => earlier.to === change.from);
    if (at >= 0) changes[at] = { from: changes[at]!.from, to: change.to };
    else changes.push(change);
  }
  const also = (first.alsoChanged ?? 0) + (second.alsoChanged ?? 0);
  return {
    text: second.text,
    changes: changes.filter((change) => change.from !== change.to),
    // 第一轮没改成、第二轮也没动到的才算没改成（原句还原样在稿里）。
    failed: first.failed.filter((failure) => quoteInText(failure.target, second.text)),
    ...(also > 0 ? { alsoChanged: also } : {}),
  };
}

/** 再核不再报的「没改成」不算没改成：两处报的是同一件事的两头，改了这头那头就对上了（真机 2026-11-03）。 */
function settledFailures(outcome: EditOutcome, left?: ContinuityCheckData): EditOutcome {
  const flagged = left ? [...left.sure, ...left.maybe] : [];
  return { ...outcome, failed: outcome.failed.filter((failure) => flagged.some((item) => sameSentence(item.quote, failure.target))) };
}

/** fix：改 → 补笔记 → 再核 →（还有对不上的）再改一轮 → 再核。都只算、不写盘；换上在外面一次做。 */
async function fixRounds(ctx: RecipeContext<unknown>, params: Extract<DraftEditParams, { mode: "fix" }>, materials: EditMaterials, deps: DraftEditDeps): Promise<EditOutcome> {
  const { bookDir } = ctx;
  const { chapter } = params;
  const { text } = materials;
  const first = await ctx.step("fix", { text }, () => {
    ctx.progress("在按核账改");
    return fixEdits({ chapter, text, fixes: params.fixes, callModel: deps.fixCallModel });
  });
  if (first.changes.length === 0) return first;
  // 改的途中作者存过稿：这版换不上（留成候选），不再花钱核它。
  if ((await readDraftState(bookDir, chapter)).version !== materials.baseVersion) return first;
  const notes = await ctx.step("notes", { chapter }, () => verifyNotes(bookDir, chapter, deps.readerCallModel));
  if (!notes.ok) return { ...first, verify: { checks: 0, again: 0, failure: notes.reason } };
  const once = await ctx.step("check:1", { text: first.text }, () => {
    ctx.progress("改完再核一遍");
    return verifyFix(bookDir, chapter, first.text, first.changes, deps.readerCallModel, first.revisit);
  });
  if (!once.ok) return { ...first, verify: { checks: 0, again: 0, failure: once.reason } };
  if (leftCount(once.left) === 0) return { ...settledFailures(first), verify: { checks: 1, again: 0 } };
  // 第二轮（FIX_ROUNDS）：作者点的、第一轮改出来的还对不上的那几处，第一轮刚改出来的带上第一轮那条要求。
  const fixes = againItems(chapter, once.left, first, params.fixes).slice(0, EDIT_MAX_FIXES)
    .map((item) => ({ targetText: item.quote, revisionGoal: againGoal(chapter, item, first.changes, params.fixes) }));
  if (fixes.length === 0) return { ...settledFailures(first, once.left), verify: { checks: 1, again: 0, left: once.left } };
  const second = await ctx.step(`fix:${FIX_ROUNDS}`, { text: first.text, fixes }, () => {
    ctx.progress("还有几处对不上，再改一轮");
    return fixEdits({ chapter, text: first.text, fixes, callModel: deps.fixCallModel });
  });
  // 第二轮一句都没改成：照第一轮的结果交，还剩的列给作者。
  if (second.changes.length === 0) return { ...settledFailures(first, once.left), verify: { checks: 1, again: 0, left: once.left } };
  const merged = mergeRounds(first, second);
  const twice = await ctx.step(`check:${FIX_ROUNDS}`, { text: second.text }, () => {
    ctx.progress("改完再核一遍");
    return verifyFix(bookDir, chapter, second.text, second.changes, deps.readerCallModel, second.revisit);
  });
  const again = second.changes.length;
  if (!twice.ok) return { ...merged, verify: { checks: 1, again, failure: twice.reason } };
  return { ...settledFailures(merged, twice.left), verify: { checks: 2, again, ...(leftCount(twice.left) > 0 ? { left: twice.left } : {}) } };
}

async function deaiEdits(input: {
  readonly projectDir: string;
  readonly text: string;
  readonly violations: DraftDeaiParams["violations"];
  readonly callModel: DeAiCallModel;
}): Promise<EditOutcome> {
  const antiRules = await readAntiRules(input.projectDir);
  const result = await runDeAiFlavorBatch({ draftText: input.text, violations: input.violations, callModel: input.callModel, antiRules: antiRules.items });
  const note = antiRules.failure ? `（${antiRules.failure}。）` : undefined;
  if (!result.ok) {
    return { text: input.text, changes: [], failed: input.violations.map((violation) => ({ target: violation.text, why: `AI 没改成（${result.error ?? "原因不明"}）` })), ...(note ? { note } : {}) };
  }
  const changes = result.changes.map((change) => ({ from: change.before, to: change.after }));
  const changed = new Set(result.changes.map((change) => change.before));
  return {
    text: result.updatedContent,
    changes,
    failed: input.violations
      .filter((violation) => !changed.has(violation.text))
      .map((violation) => ({ target: violation.text, why: "没定位到，或 AI 没给出能用的改法" })),
    ...(note ? { note } : {}),
  };
}

/** 作者点了「换上」：看改法这段时间里稿子、前文变了就作废（作者看的那版不算数了），不留候选。 */
async function checkStillFresh(projectDir: string, chapter: number, materials: EditMaterials): Promise<{ readonly fresh: true }> {
  const state = await readDraftState(projectDir, chapter);
  if (state.version !== materials.baseVersion) {
    throw new OperationObsolete("draft_moved", `你看这版改法的时候，第 ${chapter} 章的稿子又改过，这版没换上。要改就再改一次。`);
  }
  const changes = diffTruthBasis(materials.basis, await readTruthBasisForWork(projectDir));
  if (changes.length > 0) {
    throw new OperationObsolete("basis_moved", `你看这版改法的时候${describeBasisChanges(changes)}改过，这版没换上。要改就再改一次。`);
  }
  return { fresh: true };
}

/* ------------------------------------------------------------------ */
/*  结论                                                                */
/* ------------------------------------------------------------------ */

/** 没改成的那几处一句话（照第一处的原因说）。 */
function notDoneLine(total: number, failed: readonly EditFailure[]): string {
  if (failed.length === 0) return "";
  return total === 1 ? `这一处没改成：${failed[0]!.why}。` : `${failed.length} 处没改成：${failed[0]!.why}。`;
}

const editTotal = (params: DraftEditParams): number =>
  params.mode === "revise" ? params.edits.length : params.mode === "fix" ? params.fixes.length : params.violations.length;

/** 一处都没改成：给作者的一句（这次记成没做成，稿子没动）。 */
export function nothingChangedMessage(params: DraftEditParams, outcome: EditOutcome): string {
  const total = editTotal(params);
  const line = notDoneLine(total, outcome.failed) || (total === 1 ? "这一处没改成。" : `这 ${total} 处都没改成。`);
  return `${line}${outcome.note ? outcome.note : ""}`;
}

/** 改好了的一句（还没说没改成的那几处）。 */
function doneLine(params: DraftEditParams, outcome: EditOutcome): string {
  // 结论自己说是哪章（卡上、重开书都只显示这一句）。
  const at = `第 ${params.chapter} 章`;
  const count = outcome.changes.length;
  if (params.mode === "deai") return `${at}改掉了 ${count} 处机器腔（可撤销）。`;
  if (params.mode === "fix") {
    const also = outcome.alsoChanged ? `本章别处说同一件事的 ${outcome.alsoChanged} 句跟着改了。` : "";
    const done = params.fixes.length - outcome.failed.length;
    return `${params.fixes.length === 1 ? `${at}改好了这一处（可撤销）。` : `${at}改好了 ${done} 处（可撤销）。`}${also}`;
  }
  if (outcome.exact) return `${at}按你给的原文换上了（可撤销）。`;
  // 先给作者看过改法的：卡上已经摆过改了什么，换上了就一句。
  if (params.preview) return params.edits.length === 1 ? `${at}换上了（可撤销）。` : `${at}换上了 ${count} 处（可撤销）。`;
  if (outcome.brief) return `${at}改好了：${outcome.brief}（可撤销）。`;
  return params.edits.length === 1 ? `${at}改好了这一处（可撤销）。` : `${at}改好了 ${count} 处（可撤销）。`;
}

/** 改完再核的一句：没对不上的了 / 还有几处在卡上 / 没核成（定稿时再核）。 */
function verifyLine(verify: FixVerify | undefined): string {
  if (!verify) return "";
  if (verify.failure) return `改完再核没跑成（${verify.failure}），定稿时会再核。`;
  const left = verify.left ? leftCount(verify.left) : 0;
  const again = verify.again > 0 ? `又跟着改了 ${verify.again} 句，` : "";
  return left > 0 ? `改完再核${again}还有 ${left} 处对不上，在卡上。` : `改完再核${again}没有对不上的了。`;
}

export function buildDraftEditResult(input: {
  readonly params: DraftEditParams;
  readonly outcome: EditOutcome;
  readonly title: string;
  readonly applied: DraftApplied;
}): OperationResult {
  const { params, outcome, applied } = input;
  const body: DraftEditBody = {
    kind: "draft.change",
    mode: params.mode,
    ok: applied.applied,
    chapter: params.chapter,
    ...(input.title ? { draftTitle: input.title } : {}),
    ...(applied.applied
      ? { version: applied.version, ...(applied.snapshotId ? { snapshotId: applied.snapshotId } : {}) }
      : { kept: { candidateId: applied.candidateId, reason: applied.reason, ...(applied.handled ? { handled: true as const } : {}) } }),
    changes: outcome.changes,
    failed: outcome.failed,
    ...(outcome.alsoChanged ? { alsoChanged: outcome.alsoChanged } : {}),
    ...(outcome.verify ? { verify: outcome.verify } : {}),
  };
  const summary = applied.applied
    ? `${doneLine(params, outcome)}${notDoneLine(editTotal(params), outcome.failed)}${outcome.note ?? ""}${verifyLine(outcome.verify)}`
    : applied.message;
  return {
    schema: "operation-result/1",
    summary,
    body,
    ...(applied.applied && applied.warnings ? { warnings: applied.warnings } : {}),
  };
}

/* ------------------------------------------------------------------ */
/*  跑                                                                  */
/* ------------------------------------------------------------------ */

const SNAPSHOT_LABELS: Readonly<Record<DraftEditMode, (chapter: number) => string>> = {
  revise: (chapter) => `第${chapter}章修订前快照`,
  fix: (chapter) => `第${chapter}章按核账改前快照`,
  deai: (chapter) => `第${chapter}章去 AI 味前快照`,
};

const SOURCES = { revise: "revise", fix: "unit-fix", deai: "de-ai" } as const;

export async function runDraftEdit(ctx: RecipeContext<unknown>, params: DraftEditParams, deps: DraftEditDeps): Promise<OperationResult> {
  const { bookDir } = ctx;
  const { chapter, mode } = params;
  const materials = await ctx.step("materials", { chapter }, () => readEditMaterials(bookDir, chapter));
  const { text } = materials;

  let outcome: EditOutcome;
  if (mode === "fix") {
    outcome = await fixRounds(ctx, params, materials, deps);
  } else if (mode === "deai") {
    outcome = await ctx.step("deai", { text }, () => {
      ctx.progress("在去机器腔");
      return deaiEdits({ projectDir: bookDir, text, violations: params.violations, callModel: deps.deAiCallModel });
    });
  } else {
    const avoid: string[] = [];
    for (let round = 1; ; round += 1) {
      const tried = [...avoid];
      outcome = await ctx.step(`revise:${round}`, { text, avoid: tried }, () => {
        ctx.progress(round === 1 ? "在改" : `在改第 ${round} 版`);
        return reviseEdits({
          projectDir: bookDir,
          chapter,
          text,
          edits: params.edits,
          ...(params.style ? { style: params.style } : {}),
          ...(tried.length > 0 ? { avoid: tried } : {}),
          callModel: deps.fixCallModel,
        });
      });
      if (!params.preview || outcome.changes.length === 0) break;
      const preview: RevisePreview = { round, changes: outcome.changes, failed: outcome.failed, ...(outcome.brief ? { brief: outcome.brief } : {}) };
      const { decision } = await ctx.waitForAuthor({
        actionId: `confirm:${round}`,
        kind: REVISE_CONFIRM_KIND,
        decisions: round >= REVISE_MAX_ROUNDS ? ["apply"] : ["apply", "again"],
        preview,
      });
      if (decision === "apply") {
        await ctx.step(`fresh:${round}`, { round }, () => checkStillFresh(bookDir, chapter, materials));
        break;
      }
      avoid.push(...outcome.changes.map((change) => change.to));
    }
  }
  if (outcome.changes.length === 0) throw coded("not_changed", nothingChangedMessage(params, outcome));

  // 改的是文件原文（带章名行）：拆一次，章名照原文的。
  const draft = parseDraftFile(outcome.text);
  const title = draft.title ?? "";
  const editedText = outcome.text;
  const fixes = mode === "fix" ? outcome.changes : undefined;
  // 换上 AI 稿那条路本身先回放回执（核心命令在最前面，回放之后才核材料），回放也走它：字数、改句记录按键补发。
  const apply = async (): Promise<DraftApplied> => {
    ctx.progress("在换上工作稿");
    const written = await applyAiDraft(bookDir, {
      chapter,
      title,
      body: draft.body,
      baseVersion: materials.baseVersion,
      basis: materials.basis,
      materials: [],
      source: SOURCES[mode],
      snapshotLabel: SNAPSHOT_LABELS[mode](chapter),
      ...(fixes ? { fixes } : {}),
    });
    if (!written.applied) {
      return { applied: false, reason: written.reason, candidateId: written.candidateId, message: written.message, ...(written.handled ? { handled: true as const } : {}) };
    }
    return {
      applied: true,
      version: written.version,
      unchanged: written.unchanged,
      ...(written.snapshotId ? { snapshotId: written.snapshotId } : {}),
      ...(written.warnings ? { warnings: written.warnings } : {}),
    };
  };
  const applied = await ctx.apply("apply", { text: editedText, baseVersion: materials.baseVersion, basis: materials.basis.digest }, apply, apply);
  return buildDraftEditResult({ params, outcome, title, applied });
}
