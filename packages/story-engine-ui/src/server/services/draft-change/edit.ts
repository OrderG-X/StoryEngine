/**
 * draft.change 的改稿三种（写作版本 P2a 片 2C，设计 3.1 末两条、6.6）：改已有的工作稿，改前存档、可撤销。
 * - revise：改一段或几段（对话里改稿、选中文字改写）。带 preview 的改好先给作者看：作者点「换上」才换，「再改一版」重改，「不要了」停掉。
 * - fix：核账卡「改这处 / 改掉这 N 处」（按编号句子，一章几处问一次模型）。
 * - deai：AI 味卡「改掉这句 / 一键全修」。
 *
 * 步骤：materials（依据 + 稿同一次读）→ revise:n / fix / deai（只算）→（preview：等作者 confirm:n → fresh:n 核底版和依据，
 * 变了就作废、说哪样变了）→ apply（applyAiDraft；没 preview 的写的途中稿子或前文变了，照写稿一样留成候选）。
 * 一处都没改成如实说为什么（not_changed），稿子不动。
 */
import { diffTruthBasis, parseDraftFile, readDraftFile, readDraftState, type TruthBasis } from "@actalk/story-core";
import { describeBasisChanges, readTruthBasisForWork } from "../../book/truth-basis.js";
import { applyAiDraft } from "../../lib/ai-draft-write.js";
import { readAntiRules } from "../../writing/ai-flavor/anti-rules.js";
import { runDeAiFlavorBatch, type DeAiCallModel } from "../de-ai-flavor-batch.js";
import { authorStepId, OperationObsolete, type OperationResult, type RecipeContext } from "../operations/executor.js";
import { fixByUnits } from "../unit-fix.js";
import type { DraftDeaiParams, DraftEditMode, DraftEditParams, DraftReviseEdit } from "./params.js";
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
  /** revise 只改了一段时 AI 说的改了什么；按作者给的原文换上的是 exact。 */
  readonly brief?: string;
  readonly exact?: true;
  /** deai：写作规则没读上之类，结论后面补一句。 */
  readonly note?: string;
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

/** 哪几步会调模型（接着做时额度按它加）：改的那一步；等作者看改法那一步之后可能「再改一版」。 */
export function editStepCallsModel(stepId: string): boolean {
  return stepId === "fix" || stepId === "deai" || stepId.startsWith("revise:") || stepId.startsWith(authorStepId("confirm:"));
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
    return `${params.fixes.length === 1 ? `${at}改好了这一处（可撤销）。` : `${at}改好了 ${count - (outcome.alsoChanged ?? 0)} 处（可撤销）。`}${also}`;
  }
  if (outcome.exact) return `${at}按你给的原文换上了（可撤销）。`;
  // 先给作者看过改法的：卡上已经摆过改了什么，换上了就一句。
  if (params.preview) return params.edits.length === 1 ? `${at}换上了（可撤销）。` : `${at}换上了 ${count} 处（可撤销）。`;
  if (outcome.brief) return `${at}改好了：${outcome.brief}（可撤销）。`;
  return params.edits.length === 1 ? `${at}改好了这一处（可撤销）。` : `${at}改好了 ${count} 处（可撤销）。`;
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
  };
  const summary = applied.applied
    ? `${doneLine(params, outcome)}${notDoneLine(editTotal(params), outcome.failed)}${outcome.note ?? ""}`
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
    outcome = await ctx.step("fix", { text }, () => {
      ctx.progress("在按核账改");
      return fixEdits({ chapter, text, fixes: params.fixes, callModel: deps.fixCallModel });
    });
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
  const applied = await ctx.apply("apply", { text: editedText, baseVersion: materials.baseVersion, basis: materials.basis.digest }, async (): Promise<DraftApplied> => {
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
  });
  return buildDraftEditResult({ params, outcome, title, applied });
}
