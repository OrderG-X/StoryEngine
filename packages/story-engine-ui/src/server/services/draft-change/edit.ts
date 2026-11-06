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
import { reviseDraftText, revisionSpans, type RevisionFailure, type RevisionModelCaller } from "./revise-text.js";
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
  /** 再核跑了、但有一步没跑成（第一条原因）：不能说「没有对不上的了」，定稿时会再核。 */
  readonly partial?: string;
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
  /** fix：两轮改下来为它改的句子全回到了原样（结论照实说「改了两轮又回到了原样」，不说没改成）。 */
  readonly reverted?: true;
  /** fix 回到原样的：为它改过、又回到原样的那几句（再核还报不报它，这几句也算；只在操作里用）。 */
  readonly sentences?: readonly string[];
}

const REVERTED_WHY = "改了两轮又回到了原样";

/** 改的那一步的输出（存进检查点）。 */
export interface EditOutcome {
  /** 改后的全文（一处都没改成就是原文）。 */
  readonly text: string;
  readonly changes: readonly EditChange[];
  readonly failed: readonly EditFailure[];
  /** fix：不是点名的、本章别处说同一件事跟着改的句数。 */
  readonly alsoChanged?: number;
  /** fix 每一轮：changes 每一条在这一轮改前正文里从第几个字起（两轮按位置并，只在操作里用）。 */
  readonly at?: readonly number[];
  /** fix 每一轮：changes 每一条是为这一轮第几处改的（两轮改回原样时按处算没改成，只在操作里用）。 */
  readonly owners?: readonly (readonly number[])[];
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
    at: outcome.at,
    owners: outcome.owners,
    failed: outcome.failed.map(({ fix, why }) => ({ target: input.fixes[fix]!.targetText, why })),
    ...(outcome.alsoChanged > 0 ? { alsoChanged: outcome.alsoChanged } : {}),
    ...(outcome.revisit.length > 0 ? { revisit: outcome.revisit.map((fix) => input.fixes[fix]!.targetText) } : {}),
  };
}

type Verified =
  /** full：这遍整章核的（不是只核改过的几句）。 */
  | { readonly ok: true; readonly left: ContinuityCheckData; readonly partial?: string; readonly full: boolean }
  | { readonly ok: false; readonly reason: string };

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
      // 报出了问题、但有一步没跑成：核账那边算 ok，这里不能拿它证明核完、干净（外部审查 2026-11-06）。
      ...(result.failures.length > 0 ? { partial: result.failures[0]! } : {}),
      full: !result.rechecked,
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
  // 以前改过又被报回来的（revisited，已降成「可能」）不管牵连到哪句都留给作者（外部审查 2026-11-06：曾被第二轮改回去）。
  return [...left.sure, ...left.maybe].filter((item) => !item.revisited && (asked(item.quote) || touched(item.quote)
    || (!item.againstSetting && (item.earlierChapter <= 0 || item.earlierChapter === chapter) && touched(item.earlierQuote))));
}

/**
 * 第二轮改法：和第一轮同一句话（和哪句对上 + 理由）；这句是第一轮刚改出来的，再带上第一轮那条要求，两样都要对上
 * （不然改回去又和第一轮那句对不上，来回改）。
 */
function againGoal(chapter: number, item: ChapterCheckItem, first: EditOutcome, fixes: DraftFixParams["fixes"]): string {
  const goal = continuityFixGoal(chapter, item);
  // 按位置认报的是不是第一轮改过的那句：核账引的句子在第一轮稿里只有一处、正落在改过的那句上才算。
  // 同样的字（或只差全半角）别处还有一句时，报的可能是那一句，套上第一轮的要求、「别改回」会把那句的正确改法禁了（外部审查 2026-11-06）。
  const spans = landedSpans(first);
  const quoted = revisionSpans(first.text, item.quote.trim());
  if (!spans || quoted.length !== 1) return goal;
  const at = quoted[0]!;
  const index = first.changes.findIndex((change, other) => change.to.length > 0 && spans[other]!.start < at.end && at.start < spans[other]!.end);
  const goals = index < 0 ? [] : [...new Set((first.owners?.[index] ?? []).map((fix) => fixes[fix]!.revisionGoal))];
  if (goals.length === 0) return goal;
  // 别改回第一轮之前那样：原来那句正是核出对不上才改的（真机 2026-11-06：「今天」改「后天」再改回「今天」）。
  return `${goal}；这句刚按「${goals.join("；")}」改过，两样都要对得上，也别改回原来的「${first.changes[index]!.from}」`;
}

/** 第一轮每条改动换上后在第一轮稿里从第几个字到第几个字（前面几处改动长短变了，往后挪）；位置没记全的没有。 */
function landedSpans(first: EditOutcome): { readonly start: number; readonly end: number }[] | undefined {
  const at = first.at;
  if (!at || at.length !== first.changes.length) return undefined;
  return first.changes.map((change, index) => {
    const start = at[index]! + first.changes.reduce((shift, other, j) => (at[j]! < at[index]! ? shift + other.to.length - other.from.length : shift), 0);
    return { start, end: start + change.to.length };
  });
}

/**
 * 两轮的改动并成一份：第二轮改的是第一轮改出来的那句（同一个位置）就接上（改前取最早那版），改回原样的去掉。
 * 按位置认、不按字认：同样的字出现几处时，第二轮改的可能是另一处（外部审查 2026-11-06：两处说法对调时曾被并成
 * 「三点→三点」删掉；只认出现一次又会把同一处改回原样当成两处改动）。
 * 作者点的哪一处，第一轮为它改的句子两轮下来全回到了原样，就算这处没改成（按第一轮记的为哪处改的认，不按字认）。
 */
function mergeRounds(first: EditOutcome, second: EditOutcome, fixes: DraftFixParams["fixes"]): EditOutcome {
  const changes = [...first.changes];
  const landed = landedSpans(first);
  second.changes.forEach((change, index) => {
    const secondAt = second.at?.[index];
    const at = landed && secondAt !== undefined
      // 只在第一轮那几条里找：changes 后面接着的是这一轮新加的，没有第一轮的位置（外部审查 2026-11-06：曾越界报错）。
      ? first.changes.findIndex((earlier, other) => landed[other]!.start === secondAt && earlier.to === change.from)
      : -1;
    if (at >= 0) changes[at] = { from: changes[at]!.from, to: change.to };
    else changes.push(change);
  });
  const also = (first.alsoChanged ?? 0) + (second.alsoChanged ?? 0);
  // 作者点的那处两轮改下来回到原样：照实算进没改成（真机 2026-11-06：曾仍报「改好了 5 处」）。
  // 一句里有几处的每处都算；一处改了几句（重复的句子、改在别处的）要全回去才算；连带改的句子回到原样不算哪一处的。
  const owners = first.owners && first.owners.length === first.changes.length ? first.owners : [];
  const reverted = [...new Set(owners.flat())].sort((a, b) => a - b)
    .filter((fix) => owners.every((list, index) => !list.includes(fix) || changes[index]!.from === changes[index]!.to))
    .map((fix): EditFailure => ({
      target: fixes[fix]!.targetText,
      why: REVERTED_WHY,
      reverted: true,
      sentences: owners.flatMap((list, index) => (list.includes(fix) ? [changes[index]!.from] : [])),
    }));
  return {
    text: second.text,
    changes: changes.filter((change) => change.from !== change.to),
    // 第一轮没改成、第二轮也没动到的才算没改成（原句还原样在稿里）。
    failed: [...first.failed.filter((failure) => quoteInText(failure.target, second.text)), ...reverted],
    ...(also > 0 ? { alsoChanged: also } : {}),
  };
}

/**
 * 再核不再报的「没改成」不算没改成：两处报的是同一件事的两头，改了这头那头就对上了（真机 2026-11-03）。
 * 还报着它的认两头：本章自己前后打架的，核账员可能把两句对调着报；回到原样的连为它改过的那几句一起认（外部审查 2026-11-06）。
 * 别章、设定那头同字不算。还报着的是不是原来那件事不猜：牵着它就照实留着（回到原样的只说回到了原样，不说没改成）。
 */
function settledFailures(outcome: EditOutcome, chapter: number, left?: ContinuityCheckData): EditOutcome {
  const flagged = left ? [...left.sure, ...left.maybe] : [];
  const still = (failure: EditFailure): boolean => {
    const sentences = [failure.target, ...(failure.sentences ?? [])];
    return flagged.some((item) => sentences.some((sentence) => sameSentence(item.quote, sentence)
      || (!item.againstSetting && (item.earlierChapter <= 0 || item.earlierChapter === chapter) && sameSentence(item.earlierQuote, sentence))));
  };
  return { ...outcome, failed: outcome.failed.filter(still) };
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
  // 有一步没跑成：这一遍没核全，后面哪一遍核全了也只核改过的那几句，盖不住它。
  const partial = once.partial ? { partial: once.partial } : {};
  // 没核全时「没再报」不能当改好了：没改成的照实留着。
  if (leftCount(once.left) === 0) return { ...(once.partial ? first : settledFailures(first, chapter)), verify: { checks: 1, again: 0, ...partial } };
  // 第二轮（FIX_ROUNDS）：作者点的、第一轮改出来的还对不上的那几处，第一轮刚改出来的带上第一轮那条要求。
  const fixes = againItems(chapter, once.left, first, params.fixes).slice(0, EDIT_MAX_FIXES)
    .map((item) => ({ targetText: item.quote, revisionGoal: againGoal(chapter, item, first, params.fixes) }));
  if (fixes.length === 0) return { ...(once.partial ? first : settledFailures(first, chapter, once.left)), verify: { checks: 1, again: 0, left: once.left, ...partial } };
  const second = await ctx.step(`fix:${FIX_ROUNDS}`, { text: first.text, fixes }, () => {
    ctx.progress("还有几处对不上，再改一轮");
    return fixEdits({ chapter, text: first.text, fixes, callModel: deps.fixCallModel });
  });
  // 第二轮一句都没改成：照第一轮的结果交，还剩的列给作者。
  if (second.changes.length === 0) return { ...(once.partial ? first : settledFailures(first, chapter, once.left)), verify: { checks: 1, again: 0, left: once.left, ...partial } };
  const merged = mergeRounds(first, second, params.fixes);
  const twice = await ctx.step(`check:${FIX_ROUNDS}`, { text: second.text }, () => {
    ctx.progress("改完再核一遍");
    return verifyFix(bookDir, chapter, second.text, second.changes, deps.readerCallModel, second.revisit);
  });
  const again = second.changes.length;
  if (!twice.ok) return { ...merged, verify: { checks: 1, again, failure: twice.reason } };
  // 第二遍整章核的：只看它自己全没全；只核改过几句的盖不住第一遍没核成的那步。
  const partialEnd = twice.full ? twice.partial : once.partial ?? twice.partial;
  return {
    ...(partialEnd ? merged : settledFailures(merged, chapter, twice.left)),
    verify: { checks: 2, again, ...(leftCount(twice.left) > 0 ? { left: twice.left } : {}), ...(partialEnd ? { partial: partialEnd } : {}) },
  };
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

/** 没改成的那几处一句话（照第一处的原因说）；两轮改回原样的另说一句，只说回到了原样（再核还报不报在后面那句）。 */
function notDoneLine(total: number, failed: readonly EditFailure[]): string {
  const back = failed.filter((failure) => failure.reverted);
  const rest = failed.filter((failure) => !failure.reverted);
  const restLine = rest.length === 0 ? "" : total === 1 ? `这一处没改成：${rest[0]!.why}。` : `${rest.length} 处没改成：${rest[0]!.why}。`;
  const backLine = back.length === 0 ? "" : total === 1 ? `这一处${REVERTED_WHY}。` : `${back.length} 处${REVERTED_WHY}。`;
  return `${restLine}${backLine}`;
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
    const done = Math.max(0, params.fixes.length - outcome.failed.length);
    // 点的都没改成、只剩别的句子的改动（两轮下来点名那句回到原样，跟着改的那句还在）：不说「改好了」（外部审查 2026-11-06）。
    if (done === 0) return `${at}换上了 ${count} 句改动（可撤销）。`;
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
  const partial = verify.partial ? `有一步没核成（${verify.partial}），定稿时会再核。` : "";
  if (left > 0) return `改完再核${again}还有 ${left} 处对不上，在卡上。${partial}`;
  return partial ? `改完再核${again}${partial}` : `改完再核${again}没有对不上的了。`;
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
    failed: outcome.failed.map(({ target, why }) => ({ target, why })),
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
  // 改来改去和原稿一字不差（同一处两轮改回原样）也是没改：不报「改好了」（外部审查 2026-11-06）。
  if (outcome.changes.length === 0 || outcome.text === text) throw coded("not_changed", nothingChangedMessage(params, outcome));

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
