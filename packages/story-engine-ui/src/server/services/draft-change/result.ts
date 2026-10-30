/**
 * draft.change 的结果（写作版本 P2a 3.1）：按各步的输出算（纯函数），不再读盘、不调模型。
 * `body` 是结构化结果（界面的「另外几版」卡、稿纸、收尾的核账卡和下一步按它出）；`summary` 是给作者的一句结论，
 * 细节（章纲、要点、核账、字数、AI 腔）一条一句放 `body.notes`，界面在步骤里点开看。
 */
import { bareChapterName } from "@actalk/story-core";
import { countTextWords } from "../../../utils/textUtils.js";
import type { ChapterPlan } from "../../book/chapter-plan.js";
import type { ChapterCheckResult } from "../../editorial/continuity/check-service.js";
import type { BeatMissAdjudication } from "../../writing/beat-miss-adjudication.js";
import { CONTINUE_ASKED_MIN_RATIO } from "../../writing/fast-draft-writer.js";
import type { InSceneResult } from "../../writing/presence/in-scene-detector.js";
import {
  buildAiFlavorInfo,
  buildAiFlavorWarning,
  buildAutoDeAiNote,
  buildBeatFidelityInfo,
  buildBeatFidelityNote,
  buildCandidateSummaryLine,
  buildDraftLengthInfo,
  buildDraftLengthWarning,
  presenceSummarySentence,
  type DraftCandidateReportEntry,
  type GenerateDraftAiFlavorInfo,
  type GenerateDraftAutoDeAiInfo,
  type GenerateDraftBeatFidelityInfo,
  type GenerateDraftLengthInfo,
} from "../draft-service.js";
import { continuitySummary, type ContinuityInfo, type ExtendOutcome, type FixOutcome } from "../draft-pipeline/quality-steps.js";
import type { OperationResult } from "../operations/executor.js";
import type { DraftChangeMode, DraftChangeParams } from "./params.js";
import { lengthReportOf, type DeAiOutcome, type DraftVersion, type KeptVersion, type NotesOutcome, type PlanOutcome, type SelectOutcome } from "./steps.js";

/** 换上那一步的结果（存进检查点的那几样：不带文件路径和整份文件）。 */
export type DraftApplied =
  | { readonly applied: true; readonly version: string; readonly unchanged: boolean; readonly snapshotId?: string; readonly warnings?: readonly string[] }
  | { readonly applied: false; readonly reason: "draft_moved" | "basis_moved" | "apply_failed"; readonly candidateId: string; readonly message: string; readonly handled?: true };

export interface DraftChangePlanInfo {
  readonly summary: string;
  readonly beats: readonly string[];
  readonly newInformation: readonly string[];
  readonly scene?: { readonly location?: string; readonly time?: string };
  /** 沿用了这章已有的章纲（同一方向重写）。 */
  readonly reused: boolean;
}

/** draft.change 的 `body`。 */
export interface DraftChangeBody {
  readonly kind: "draft.change";
  readonly mode: DraftChangeMode;
  /** 换上了工作稿。没换上（写的途中稿子或前文改过）是 false，这版留成候选（kept）。 */
  readonly ok: boolean;
  readonly chapter: number;
  readonly draftBody: string;
  readonly draftTitle?: string;
  /** 换上之后工作稿的版本号。 */
  readonly version?: string;
  readonly snapshotId?: string;
  /** 新拟的章纲存盘前打的存档点（这一轮最早写的那一下：整轮撤销从它退）。 */
  readonly planSnapshotId?: string;
  readonly kept?: { readonly candidateId: string; readonly reason: "draft_moved" | "basis_moved" | "apply_failed"; readonly handled?: true };
  readonly draftLength?: GenerateDraftLengthInfo;
  readonly aiFlavor?: GenerateDraftAiFlavorInfo;
  readonly autoDeAi?: GenerateDraftAutoDeAiInfo;
  readonly beatFidelity?: GenerateDraftBeatFidelityInfo;
  readonly chapterPlan?: DraftChangePlanInfo;
  readonly qualityPipeline: {
    readonly continuation?: ExtendOutcome["continuation"];
    readonly continuity?: ContinuityInfo;
  };
  /** 接着往下写：本来写好的字数、这次接着写的字数（稿纸顶栏同口径）、作者说这次写多少。 */
  readonly continued?: { readonly kept: number; readonly added: number; readonly asked?: number };
  readonly candidatesReport?: readonly DraftCandidateReportEntry[];
  /** 落选的几版（留成了候选，带候选号和指纹：界面的「另外几版」卡点「用这版」换上）。 */
  readonly otherVersions?: readonly KeptVersion[];
  readonly characterSelection: InSceneResult;
  readonly contextBudget?: unknown;
  readonly thenPreview?: true;
  /** 细节，一条一句（章纲、补读、补字数、核账、要点、字数、AI 腔）。 */
  readonly notes: readonly string[];
  readonly issues: readonly string[];
}

function planInfo(plan: ChapterPlan, reused: boolean): DraftChangePlanInfo {
  return {
    summary: plan.summary,
    beats: plan.beats,
    newInformation: plan.newInformation,
    ...(plan.scene.location || plan.scene.time ? { scene: plan.scene } : {}),
    reused,
  };
}

/** 一版都没通过时给作者的一句（这次没写进工作稿）。 */
export function rejectionMessage(chapter: number, versions: readonly DraftVersion[], select: SelectOutcome): string {
  const reasons = versions.length > 1
    ? select.entries.map((entry) => `第 ${entry.index} 版：${entry.reason}`)
    : versions[0]?.report?.issues.length ? versions[0].report.issues : versions[0]?.exception ? [versions[0].exception] : [];
  const why = reasons.length > 0 ? reasons.join("；") : "写手没给出能用的正文";
  const presence = versions[0] ? presenceSummarySentence(versions[0].context.characterSelection.summary) : "";
  return versions.length > 1
    ? `第 ${chapter} 章写了 ${versions.length} 版，都没通过，没写进工作稿：${why}。可以再写一次或换个方向。`
    : `第 ${chapter} 章这一版没通过，没写进工作稿：${why}。${presence}可以再写一次或换个方向。`;
}

export function buildDraftChangeResult(input: {
  readonly mode: DraftChangeMode;
  readonly params: DraftChangeParams;
  readonly notes: NotesOutcome;
  readonly plan?: PlanOutcome;
  /** 照着写的章纲（拟成 / 沿用 / 接着写时已有的）。 */
  readonly usedPlan?: ChapterPlan;
  readonly versions: readonly DraftVersion[];
  readonly select: SelectOutcome & { readonly chosen: number };
  readonly extend?: ExtendOutcome;
  readonly deai: DeAiOutcome;
  /** 首遍核的那一版正文、首遍结果（没核：一版都没写成时不会走到这）。 */
  readonly checkedBody: string;
  readonly first: ChapterCheckResult;
  readonly fix: FixOutcome;
  readonly recheck?: ChapterCheckResult;
  readonly beats: { readonly missingBeats: readonly string[]; readonly adjudication?: BeatMissAdjudication };
  readonly finalBody: string;
  readonly continueText?: string;
  readonly planSnapshotId?: string;
  readonly otherVersions?: readonly KeptVersion[];
  readonly applied: DraftApplied;
}): OperationResult {
  const { params, mode } = input;
  const { chapter } = params;
  const chosen = input.versions[input.select.chosen]!;
  const report = chosen.report!;
  const continuing = mode === "continue";
  const lengthInfo = buildDraftLengthInfo(lengthReportOf(input.finalBody, chosen.context.lengthTarget));
  // 和稿纸顶栏同一个数法（去标题的中文字数）。
  const draftLength = { ...lengthInfo, actualLength: countTextWords(input.finalBody) };
  const aiFlavor = input.deai.aiFlavor ? buildAiFlavorInfo(input.deai.aiFlavor) : undefined;
  const autoDeAi = input.deai.autoDeAi;
  const stillMissing = new Set(input.beats.adjudication?.missingBeats ?? input.beats.missingBeats);
  const postDeAiNewMisses = input.deai.newMisses.filter((beat) => stillMissing.has(beat));
  const baseBeat = buildBeatFidelityInfo({
    deterministicMissingBeats: input.beats.missingBeats,
    ...(input.beats.adjudication ? { adjudication: input.beats.adjudication } : {}),
  });
  const beatFidelity = baseBeat
    ? {
      ...baseBeat,
      missingBeats: baseBeat.missingBeats.filter((beat) => !postDeAiNewMisses.includes(beat)),
      ...(postDeAiNewMisses.length > 0 ? { postDeAiNewMisses } : {}),
    }
    : undefined;
  const continuity = continuitySummary({
    chapter,
    checkedBody: input.checkedBody,
    first: input.first,
    ...(input.fix.targets > 0 ? { fix: input.fix } : {}),
    ...(input.recheck ? { recheck: input.recheck } : {}),
    ...(input.continueText ? { keepPrefix: input.continueText } : {}),
  });
  const continued = continuing && input.continueText !== undefined
    ? {
      kept: countTextWords(input.continueText),
      added: Math.max(countTextWords(input.finalBody) - countTextWords(input.continueText), 0),
      ...(params.length !== undefined ? { asked: params.length } : {}),
    }
    : undefined;
  const versionCount = input.versions.length;
  const candidateLine = versionCount > 1
    ? buildCandidateSummaryLine(versionCount, input.select.scoreInputs[input.select.chosen]!, input.select.scoreInputs).replace("，其余落选原因见 candidatesReport。", "。")
    : "";
  const flavorNote = aiFlavor && autoDeAi ? buildAutoDeAiNote(autoDeAi, aiFlavor) : aiFlavor ? buildAiFlavorWarning(aiFlavor) : "";
  const notes = [
    input.plan?.note ?? "",
    ...input.notes.notes,
    candidateLine,
    presenceSummarySentence(chosen.context.characterSelection.summary),
    input.extend?.note ?? "",
    ...continuity.notes,
    beatFidelity ? buildBeatFidelityNote(beatFidelity) : "",
    buildDraftLengthWarning(draftLength),
    flavorNote,
  ].filter((line) => line.trim().length > 0);
  // AI 起的章名（接着写沿用原来的，不报）。
  const title = continuing ? "" : report.title?.trim() ?? "";
  const usedPlan = input.usedPlan && !continuing ? { chapterPlan: planInfo(input.usedPlan, input.plan?.reused === true) } : {};
  const applied = input.applied;
  const body: DraftChangeBody = {
    kind: "draft.change",
    mode,
    ok: applied.applied,
    chapter,
    draftBody: input.finalBody,
    ...(title ? { draftTitle: title } : {}),
    ...(input.planSnapshotId ? { planSnapshotId: input.planSnapshotId } : {}),
    ...(applied.applied ? { version: applied.version, ...(applied.snapshotId ? { snapshotId: applied.snapshotId } : {}) } : { kept: { candidateId: applied.candidateId, reason: applied.reason, ...(applied.handled ? { handled: true as const } : {}) } }),
    draftLength,
    ...(aiFlavor ? { aiFlavor } : {}),
    ...(autoDeAi ? { autoDeAi } : {}),
    ...(beatFidelity ? { beatFidelity } : {}),
    ...usedPlan,
    qualityPipeline: {
      ...(input.extend?.continuation ? { continuation: input.extend.continuation } : {}),
      continuity: continuity.info,
    },
    ...(continued ? { continued } : {}),
    ...(versionCount > 1 ? { candidatesReport: input.select.entries } : {}),
    ...(input.otherVersions ? { otherVersions: input.otherVersions } : {}),
    characterSelection: chosen.context.characterSelection,
    ...(chosen.context.contextBudget ? { contextBudget: chosen.context.contextBudget } : {}),
    ...(params.thenPreview ? { thenPreview: true as const } : {}),
    notes,
    issues: report.issues,
  };
  const summary = applied.applied ? draftBrief(body) : applied.message;
  return {
    schema: "operation-result/1",
    summary,
    body,
    ...(applied.applied && applied.warnings && applied.warnings.length > 0 ? { warnings: applied.warnings } : {}),
  };
}

/** 作者自己挑（pick: author，片 2D）的结果 `body`：几版都留成了候选，一版都没换上。 */
export interface DraftPickBody {
  readonly kind: "draft.change";
  readonly mode: "write";
  readonly pick: "author";
  /** 没换上工作稿（作者挑了再换）。 */
  readonly ok: false;
  readonly chapter: number;
  /** 留成候选的几版（带候选号和指纹：「写了 N 版」卡点开并排看、点「用这版」换上）。 */
  readonly otherVersions: readonly KeptVersion[];
  readonly candidatesReport: readonly DraftCandidateReportEntry[];
  readonly chapterPlan?: DraftChangePlanInfo;
  readonly planSnapshotId?: string;
  readonly notes: readonly string[];
}

/** 作者自己挑：几版都摆出来了，一句结论（第几版没写成照说）。 */
export function buildAuthorPickResult(input: {
  readonly params: DraftChangeParams;
  readonly notes: NotesOutcome;
  readonly plan?: PlanOutcome;
  readonly usedPlan?: ChapterPlan;
  readonly versions: readonly DraftVersion[];
  readonly select: SelectOutcome;
  readonly kept: readonly KeptVersion[];
  readonly planSnapshotId?: string;
}): OperationResult {
  const { chapter } = input.params;
  const ready = input.kept.filter((version) => !("handled" in version));
  const missed = input.versions.map((_, position) => position + 1).filter((index) => !input.kept.some((version) => version.index === index));
  const body: DraftPickBody = {
    kind: "draft.change",
    mode: "write",
    pick: "author",
    ok: false,
    chapter,
    otherVersions: input.kept,
    candidatesReport: input.select.entries,
    ...(input.usedPlan ? { chapterPlan: planInfo(input.usedPlan, input.plan?.reused === true) } : {}),
    ...(input.planSnapshotId ? { planSnapshotId: input.planSnapshotId } : {}),
    notes: [input.plan?.note ?? "", ...input.notes.notes].filter((line) => line.trim().length > 0),
  };
  const missedLine = missed.length > 0 ? `（第 ${missed.join("、")} 版没写成）` : "";
  return {
    schema: "operation-result/1",
    summary: `第 ${chapter} 章另写了 ${ready.length} 版${missedLine}：点开挑一版换上，你的稿子没动。`,
    body,
  };
}

/** 写成了给作者的一句：写好了、多少字、差多少（章纲、角色、核对细节在操作卡里点开看）。操作结论和对话收尾同一句。 */
export function draftBrief(body: Pick<DraftChangeBody, "chapter" | "draftTitle" | "draftLength" | "continued">): string {
  // 写手有时把「第 N 章 · 」也写进章名：前面已经说了第几章，书名号里只放章名。
  const bare = body.draftTitle ? bareChapterName(body.draftTitle) : "";
  const title = bare ? `《${bare}》` : "";
  const length = body.draftLength;
  const actual = length?.actualLength;
  const short = length?.lengthStatus === "below_lower_bound" && actual !== undefined ? `，比下限少 ${length.lowerBound - actual} 字` : "";
  const continued = body.continued;
  if (!continued) return `第 ${body.chapter} 章写好了${title}${actual !== undefined ? `，${actual} 字` : ""}${short}。`;
  // 作者说了这次写多少、写手两次都没写够：照实说少了多少（界面真点 2026-10-30：要三百字左右，写了 201 字只说了 201）。
  const asked = continued.asked;
  const fewer = asked !== undefined && continued.added < Math.round(asked * CONTINUE_ASKED_MIN_RATIO) ? `，比你要的 ${asked} 字少 ${asked - continued.added} 字` : "";
  return `第 ${body.chapter} 章接着写了 ${continued.added} 字${fewer}，前面的 ${continued.kept} 字没动${actual !== undefined ? `，全章 ${actual} 字` : ""}${short}。`;
}
