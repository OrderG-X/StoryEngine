/**
 * draft.change 的各步（写作版本 P2a 3.1）：materials → notes → plan → plan-save → write:n → select → extend → deai
 * → check → fix → recheck → bundle → apply。每一步输入进、输出出（输出要能存成 JSON、自己说得清），只算不写书：
 * 能写的只有按内容键整份覆盖的缓存（跟读笔记、核账记忆）；章纲、正文、改句记录在 plan-save / apply 两步里走核心命令写。
 * 原来 runGenerateDraftWithPlan 一口气做的事按这张表拆开，分支都留在各步内部。
 */
import {
  buildAiFlavorReport,
  checkDraftBeatFidelity,
  detectAiFlavorViolations,
  parseDraftFile,
  quoteInText,
  readDraftState,
  type AiFlavorReport,
  type BeatFidelityReport,
  type TruthBasis,
} from "@actalk/story-core";
import { readChapterPlan, type ChapterPlan } from "../../book/chapter-plan.js";
import { planDigest, readMaterialWorld, readStartPlan, type MaterialRead } from "../../book/material-reads.js";
import { readTruthBasisForWork } from "../../book/truth-basis.js";
import { prepareCheckerNotes } from "../../editorial/continuity/check-service.js";
import { chapterPlanReusable, PLANNER_MAX_CATCH_UP, resolveChapterPlanForDraft, type ResolvedChapterPlan } from "../../editorial/plan-chapter.js";
import { PLANNER_ROLE } from "../../editorial/planner.js";
import { prepareReaderNotes, type ReaderNotesOutcome } from "../../editorial/prepare-notes.js";
import { describeReaderWait } from "../../editorial/reader-progress.js";
import { READER_MAX_VOLUME_BUILDS } from "../../editorial/continuity/check-service.js";
import type { BrainCallModel } from "../../editorial/index.js";
import { isChapterCommitted } from "../../lib/working-draft-text.js";
import { scrubLocalAbsolutePaths } from "../../lib/local-path-scrubber.js";
import { rethrowIfStopped } from "../../lib/operations/context.js";
import { readAntiAiPatterns, readAntiRules } from "../../writing/ai-flavor/anti-rules.js";
import { ALL_BUILTIN_AI_FLAVOR_RULES, buildUserAntiAiPatternRules } from "../../writing/ai-flavor/ai-flavor-rules.js";
import { adjudicateMissingBeats, type BeatMissAdjudication } from "../../writing/beat-miss-adjudication.js";
import { buildDraftLengthReport, type DraftLengthReport, type DraftLengthTarget } from "../../writing/draft-length-control.js";
import { runFastDraft, type WriterClient } from "../../writing/fast-draft-writer.js";
import type { InSceneResult } from "../../writing/presence/in-scene-detector.js";
import type { DeAiCallModel } from "../de-ai-flavor-batch.js";
import {
  EMPTY_AUTO_DE_AI_SKIPPED,
  optionalContextBudget,
  pickAutoDeAiTargets,
  rankDraftCandidates,
  resolveDraftRunContext,
  runAutoDeAiRound,
  scoreInputFromCandidateReport,
  sharedFastDraftInput,
  attachCandidateExcerpts,
  type DraftCandidateReportEntry,
  type DraftCandidateScoreInput,
  type GenerateDraftAutoDeAiInfo,
} from "../draft-service.js";
import type { ContinueCallModel } from "../draft-pipeline/continue-draft.js";
import { checkDraft, extendToFloor, fixSureIssues, recheckDraft, type ExtendOutcome, type FixOutcome } from "../draft-pipeline/quality-steps.js";
import type { RevisionModelCaller } from "../revision-service.js";
import type { DraftChangeMode, DraftChangeParams } from "./params.js";

/** 带失败码的错：操作记成 failed，码进 failure.code，原因进 failure.message。 */
export const coded = (code: string, message: string): Error => Object.assign(new Error(message), { code });

/* ------------------------------------------------------------------ */
/*  materials                                                           */
/* ------------------------------------------------------------------ */

/** 开写时的样子：先读依据，再读材料、章纲、稿（接着写要接的正文和版本号同一次读）。 */
export interface DraftMaterials {
  readonly basis: TruthBasis;
  /** 开写时这一章工作稿的版本（没有稿是 null）。 */
  readonly baseVersion: string | null;
  /** 开写时那份稿的章名（空串 = 没有）：接着写、AI 没起名时沿用。 */
  readonly title: string;
  /** 开写时这一章有正文（换上前存档点的名字按它定）。 */
  readonly hadText: boolean;
  /** 接着写：本来写好的那段（原样留着、只往后接）。 */
  readonly continueText?: string;
  /** 开写时盘上的本章章纲（照着写的章纲没换就按它核）。 */
  readonly startPlan: MaterialRead;
  /** 接着写：本章已有的章纲（写手照它接着写还没写到的要点）。 */
  readonly continuePlan?: ChapterPlan;
  /** 开写时整本书的别的材料（各章工作稿版本、章纲、其余文件）。 */
  readonly world: readonly MaterialRead[];
  /** 哪几个专员要先读前文：章纲员只在要新拟纲时读。 */
  readonly readers: { readonly planner: boolean; readonly checker: boolean };
}

/** 这一章现在能不能按这个模式写（受理前、开写时各核一次）：不能就是一句原因和失败码。 */
export async function draftTargetProblem(
  projectDir: string,
  mode: DraftChangeMode,
  params: DraftChangeParams,
  state: { readonly hasText: boolean },
): Promise<{ readonly code: string; readonly message: string } | undefined> {
  const { chapter } = params;
  const committed = await isChapterCommitted(projectDir, chapter);
  if (mode === "continue") {
    if (committed) return { code: "chapter_committed", message: `第 ${chapter} 章已经定稿了，接着写只接还没定稿的章。要往这章里加内容，先在稿纸上改、再重新定稿。` };
    if (!state.hasText) return { code: "nothing_to_continue", message: `第 ${chapter} 章还没有正文，没有可以接着写的。要从头写，就说「写第 ${chapter} 章」。` };
    return undefined;
  }
  if (!params.rewrite && (committed || state.hasText)) {
    return {
      code: "chapter_has_text",
      message: committed
        ? `第 ${chapter} 章已经定稿了，不直接重写：要整章重写点「重写第 ${chapter} 章」。`
        : `第 ${chapter} 章已经有工作稿了，不直接覆盖：要接着写点「接着往下写」，要整章重写点「重写第 ${chapter} 章」。`,
    };
  }
  if (!params.allowWriteAhead && chapter > 1 && !(await isChapterCommitted(projectDir, chapter - 1))) {
    return {
      code: "previous_chapter_not_committed",
      message: `第 ${chapter - 1} 章还没定稿——它的新状态还没写进故事，现在写第 ${chapter} 章容易前后穿帮。先把第 ${chapter - 1} 章定稿再写；要冒险先写就明说「仍要先写」。`,
    };
  }
  return undefined;
}

/** 读这一章现在的稿：正文（去掉首尾空白）、章名、版本号。 */
export async function readChapterDraft(projectDir: string, chapter: number): Promise<{ readonly body: string; readonly title: string; readonly version: string | null }> {
  const state = await readDraftState(projectDir, chapter);
  const draft = state.file ? parseDraftFile(state.file.text) : undefined;
  return { body: draft?.body.trim() ?? "", title: draft?.title ?? "", version: state.version };
}

export async function readDraftMaterials(projectDir: string, mode: DraftChangeMode, params: DraftChangeParams): Promise<DraftMaterials> {
  const { chapter } = params;
  // 先读依据、再读材料和稿（P1b）：途中作者改了什么，换上时都对得出来。
  const basis = await readTruthBasisForWork(projectDir);
  const startPlan = await readStartPlan(projectDir, chapter);
  const world = await readMaterialWorld(projectDir, chapter);
  const draft = await readChapterDraft(projectDir, chapter);
  const problem = await draftTargetProblem(projectDir, mode, params, { hasText: draft.body !== "" });
  if (problem) throw coded(problem.code, problem.message);
  const continuing = mode === "continue";
  const continuePlan = continuing ? await readChapterPlan(projectDir, chapter).catch(() => undefined) : undefined;
  // 接着写不拟纲：章纲员看不到作者写的半章。要新拟纲才让章纲员先读前文。
  const planner = !continuing && chapter > 1 && !(await chapterPlanReusable(projectDir, chapter, params.direction));
  return {
    basis,
    baseVersion: draft.version,
    title: draft.title,
    hadText: draft.body !== "",
    ...(continuing ? { continueText: draft.body } : {}),
    startPlan,
    ...(continuePlan ? { continuePlan } : {}),
    world,
    readers: { planner, checker: chapter > 1 },
  };
}

/* ------------------------------------------------------------------ */
/*  notes                                                               */
/* ------------------------------------------------------------------ */

export interface NotesOutcome {
  readonly roles: readonly ReaderNotesOutcome[];
  /** 当场补了笔记的那一句（「这次先等章纲员读完第 a～b 章再拟纲」）。 */
  readonly notes: readonly string[];
}

/** 两个专员的笔记各补一次（当场最多 10 章、2 个卷节点）。缺得更多的由调用方交后台补读、停下等。 */
export async function prepareDraftNotes(input: {
  readonly projectDir: string;
  readonly chapter: number;
  readonly readers: DraftMaterials["readers"];
  readonly plannerCallModel: BrainCallModel;
  readonly readerCallModel: BrainCallModel;
}): Promise<NotesOutcome> {
  const roles: ReaderNotesOutcome[] = [];
  const notes: string[] = [];
  if (input.readers.planner) {
    const planner = await prepareReaderNotes({
      projectDir: input.projectDir,
      role: PLANNER_ROLE,
      chapter: input.chapter,
      callModel: input.plannerCallModel,
      maxCatchUp: PLANNER_MAX_CATCH_UP,
      maxVolumeBuilds: READER_MAX_VOLUME_BUILDS,
      waitingAs: "拟纲",
    });
    roles.push(planner);
    if (planner.waited) notes.push(`${describeReaderWait(PLANNER_ROLE.id, planner.waited, "拟纲")}。`);
  }
  if (input.readers.checker) {
    const checker = await prepareCheckerNotes(input.projectDir, input.chapter, input.readerCallModel);
    roles.push(checker);
    if (checker.waited) notes.push(`${describeReaderWait(checker.role, checker.waited, "核")}。`);
  }
  return { roles, notes };
}

/* ------------------------------------------------------------------ */
/*  plan                                                                */
/* ------------------------------------------------------------------ */

/** 拟纲那一步的输出：照哪份写（没有就按无纲写）、要不要落盘、给作者的一句。 */
export interface PlanOutcome {
  readonly plan?: ChapterPlan;
  readonly note: string;
  readonly reused: boolean;
  readonly save?: true;
}

/** 沿用 / 新拟 / 审纲 / 改一轮，全在内存里；笔记在 notes 那一步补过，这里不再当场补。 */
export async function planDraft(input: {
  readonly projectDir: string;
  readonly chapter: number;
  readonly direction?: string;
  readonly plannerCallModel: BrainCallModel;
  readonly readerCallModel: BrainCallModel;
}): Promise<PlanOutcome> {
  const resolved: ResolvedChapterPlan = await resolveChapterPlanForDraft({
    projectDir: input.projectDir,
    chapter: input.chapter,
    ...(input.direction ? { direction: input.direction } : {}),
    plannerCallModel: input.plannerCallModel,
    planCheckReaderCallModel: input.readerCallModel,
    maxCatchUp: 0,
    maxVolumeBuilds: 0,
  });
  return {
    ...(resolved.plan ? { plan: resolved.plan } : {}),
    note: resolved.note,
    reused: resolved.reused,
    ...(resolved.save ? { save: true as const } : {}),
  };
}

/* ------------------------------------------------------------------ */
/*  write:n                                                             */
/* ------------------------------------------------------------------ */

/** 写手这一版的报告里后面几步要用的那几样（整份报告带诊断和提示词指纹，不进检查点）。 */
export interface VersionReport {
  readonly passed: boolean;
  readonly draftBody?: string;
  readonly title?: string;
  readonly issues: readonly string[];
  readonly draftLength?: DraftLengthReport;
  readonly beatFidelity?: BeatFidelityReport;
  readonly aiFlavor?: AiFlavorReport;
}

/** 写这一版时的上下文（后面几步、结论要用）：在场人物、字数目标、上下文裁剪。 */
export interface VersionContext {
  readonly characterSelection: InSceneResult;
  readonly lengthTarget: DraftLengthTarget;
  readonly contextBudget?: unknown;
}

export interface DraftVersion {
  /** 第几版（0 起）。 */
  readonly index: number;
  /** 写手抛了错（没报告）：原因。 */
  readonly exception?: string;
  readonly report?: VersionReport;
  /** 这一版的判漏复核（多版时选优前做；只出一版时留到终稿做）。 */
  readonly adjudication?: BeatMissAdjudication;
  /** 这一版用的温度（多版错开）。 */
  readonly temperature?: number;
  readonly context: VersionContext;
}

export async function writeVersion(input: {
  readonly projectDir: string;
  readonly mode: DraftChangeMode;
  readonly params: DraftChangeParams;
  readonly index: number;
  readonly plan?: ChapterPlan;
  readonly continueText?: string;
  readonly writerClient: WriterClient;
  readonly temperature?: number;
  readonly onStreamReset?: (visible: string) => void;
  /** 多版时这一版先做判漏复核（选优吃复核后的漏写数）。 */
  readonly beatAdjudicationCallModel?: (prompt: string) => Promise<string>;
}): Promise<DraftVersion> {
  const { projectDir, params } = input;
  const continuing = input.mode === "continue";
  const run = await resolveDraftRunContext({
    ...(input.plan ? { chapterPlan: input.plan } : {}),
    projectDir,
    chapter: params.chapter,
    ...(params.direction ? { chapterGoal: params.direction } : {}),
    // 接着写时作者说的字数是「这次写多少」，整章目标照写作规则。
    ...(params.length !== undefined && !continuing ? { requestedDraftLength: params.length } : {}),
    ...(params.selectedCharacters ? { selectedCharacters: params.selectedCharacters } : {}),
    ...(params.maxTimelineEvents !== undefined ? { maxTimelineEvents: params.maxTimelineEvents } : {}),
    ...(params.contextTokenBudget !== undefined ? { contextTokenBudget: params.contextTokenBudget } : {}),
    aiFlavorRecheck: true,
  });
  // 上下文预算的裁剪账在写手构包时才记上（rankContext 边构边记）：写完再取。
  const contextOf = (): VersionContext => {
    const budget = optionalContextBudget(run.contextRanking);
    return {
      characterSelection: run.characterSelection,
      lengthTarget: run.lengthTarget,
      ...(budget.contextBudget ? { contextBudget: budget.contextBudget } : {}),
    };
  };
  const temperature = input.temperature !== undefined ? { temperature: input.temperature } : {};
  let report;
  try {
    report = await runFastDraft({
      ...sharedFastDraftInput(run, {
        projectDir,
        chapter: params.chapter,
        ...(params.selectedHookIds ? { selectedHookIds: params.selectedHookIds } : {}),
        ...(params.mustHitBeats ? { mustHitBeats: params.mustHitBeats } : {}),
        // 有章纲就按要点分前后两半写（字数在出稿时就够，少走事后续写）；接着写不分。
        segmentByPlan: !continuing,
      }),
      ...(continuing && input.continueText
        ? { continueFrom: { text: input.continueText, ...(params.length !== undefined ? { length: params.length } : {}), ...(params.direction ? { direction: params.direction } : {}) } }
        : {}),
      writerClient: input.writerClient,
      ...(input.onStreamReset ? { onStreamReset: input.onStreamReset } : {}),
      dryRun: false,
    });
  } catch (error) {
    rethrowIfStopped(error);
    // 多版时一版没写成不拖垮别的版；只出一版时由选优那步如实报全没写成。
    return { index: input.index, exception: scrubLocalAbsolutePaths(error instanceof Error ? error.message : String(error)), context: contextOf(), ...temperature };
  }
  const body = report.passed ? report.draftBody?.trim() : undefined;
  const versionReport: VersionReport = {
    passed: report.passed,
    ...(body ? { draftBody: body } : {}),
    ...(report.title ? { title: report.title } : {}),
    issues: report.issues,
    ...(report.draftLength ? { draftLength: report.draftLength } : {}),
    ...(report.beatFidelity ? { beatFidelity: report.beatFidelity } : {}),
    ...(report.aiFlavor ? { aiFlavor: report.aiFlavor } : {}),
  };
  const missing = report.beatFidelity?.missingBeats ?? [];
  const adjudication = input.beatAdjudicationCallModel && report.passed && body && missing.length > 0
    ? await adjudicateMissingBeats({ draftContent: body, missingBeats: missing, callModel: input.beatAdjudicationCallModel })
    : undefined;
  return { index: input.index, report: versionReport, context: contextOf(), ...(adjudication ? { adjudication } : {}), ...temperature };
}

/* ------------------------------------------------------------------ */
/*  select                                                              */
/* ------------------------------------------------------------------ */

/** 落选、但通过了的一版（全文，没落盘）：对话里出「另外几版」卡，作者点「用这版」才换进工作稿。 */
export interface DraftOtherVersion {
  readonly index: number;
  readonly body: string;
}

export interface SelectOutcome {
  /** 选中第几版（0 起）；一版都没通过是 undefined。 */
  readonly chosen?: number;
  readonly entries: readonly DraftCandidateReportEntry[];
  readonly scoreInputs: readonly DraftCandidateScoreInput[];
  readonly otherVersions?: readonly DraftOtherVersion[];
}

/** 确定性选优（不调模型）：只出一版也走这里（通过就选它）。 */
export function selectVersion(versions: readonly DraftVersion[]): SelectOutcome {
  const scoreInputs = versions.map((version) =>
    scoreInputFromCandidateReport(version.index, version.report, version.exception, version.adjudication));
  const ranked = rankDraftCandidates(scoreInputs);
  const withExcerpts = attachCandidateExcerpts(ranked.entries, versions.map((version) => version.report?.draftBody));
  const entries = withExcerpts.map((entry, position) =>
    versions[position]?.temperature !== undefined ? { ...entry, temperature: versions[position]!.temperature! } : entry);
  const chosen = ranked.chosenIndex !== undefined && versions[ranked.chosenIndex]?.report?.draftBody ? ranked.chosenIndex : undefined;
  if (chosen === undefined) return { entries, scoreInputs };
  const otherVersions = versions.flatMap((version, position) =>
    position !== chosen && scoreInputs[position]?.eligible && version.report?.draftBody ? [{ index: position + 1, body: version.report.draftBody }] : []);
  return { chosen, entries, scoreInputs, ...(otherVersions.length > 0 ? { otherVersions } : {}) };
}

/* ------------------------------------------------------------------ */
/*  extend / deai / check / fix / recheck                               */
/* ------------------------------------------------------------------ */

export function extendDraft(input: {
  readonly chapter: number;
  readonly draftBody: string;
  readonly lengthTarget: DraftLengthTarget;
  readonly plan?: ChapterPlan;
  readonly callModel: ContinueCallModel;
}): Promise<ExtendOutcome> {
  return extendToFloor({
    chapter: input.chapter,
    draftBody: input.draftBody,
    lengthTarget: input.lengthTarget,
    callModel: input.callModel,
    ...(input.plan ? { chapterPlan: input.plan } : {}),
  });
}

export interface DeAiOutcome {
  readonly draftBody: string;
  readonly changed: boolean;
  /** 去味前（这一版正文）的 AI 腔检出；没开回检规则是 undefined。 */
  readonly aiFlavor?: AiFlavorReport;
  readonly autoDeAi?: GenerateDraftAutoDeAiInfo;
  /** 去味后才漏掉的要点（确定性核对，复核前）。 */
  readonly newMisses: readonly string[];
}

/**
 * AI 腔回检 + 自动去味一轮（只动新写的：接着写时作者写的那几句检出照列、不替作者改）。
 * 改写没成 = 原稿不动 + 如实记；作者说只标注（autoDeAi:false）就只标注。
 */
export async function deAiDraft(input: {
  readonly projectDir: string;
  readonly draftBody: string;
  readonly continueText?: string;
  readonly mustHitBeats?: readonly string[];
  readonly autoDeAi: boolean;
  readonly callModel: DeAiCallModel;
}): Promise<DeAiOutcome> {
  // 内置规则 + 这本书写作规则里的禁用说法（读不到就只用内置的，同写手那边）。
  const rules = [...ALL_BUILTIN_AI_FLAVOR_RULES, ...buildUserAntiAiPatternRules(await readAntiAiPatterns(input.projectDir))];
  const aiFlavor = buildAiFlavorReport(detectAiFlavorViolations(input.draftBody, rules));
  const targets = pickAutoDeAiTargets(aiFlavor).filter((violation) => !input.continueText || !quoteInText(violation.text, input.continueText));
  const initialHighMedium = aiFlavor.bySeverity.high + aiFlavor.bySeverity.medium;
  if (targets.length === 0) return { draftBody: input.draftBody, changed: false, aiFlavor, newMisses: [] };
  if (!input.autoDeAi) {
    return {
      draftBody: input.draftBody,
      changed: false,
      aiFlavor,
      autoDeAi: { attempted: false, fixedCount: 0, remainingHighMedium: initialHighMedium, skipped: EMPTY_AUTO_DE_AI_SKIPPED },
      newMisses: [],
    };
  }
  let round;
  try {
    round = await runAutoDeAiRound({
      draftBody: input.draftBody,
      initialHighMedium,
      targets,
      rules,
      antiRules: (await readAntiRules(input.projectDir)).items,
      callModel: input.callModel,
    });
  } catch (error) {
    rethrowIfStopped(error);
    const message = scrubLocalAbsolutePaths(error instanceof Error ? error.message : String(error));
    return {
      draftBody: input.draftBody,
      changed: false,
      aiFlavor,
      autoDeAi: { attempted: true, fixedCount: 0, remainingHighMedium: initialHighMedium, skipped: EMPTY_AUTO_DE_AI_SKIPPED, error: message },
      newMisses: [],
    };
  }
  if (round.draftBody === undefined) return { draftBody: input.draftBody, changed: false, aiFlavor, autoDeAi: round.info, newMisses: [] };
  const beats = input.mustHitBeats ?? [];
  const before = new Set(beats.length > 0 ? checkDraftBeatFidelity({ draftContent: input.draftBody, mustHitBeats: beats }).missingBeats : []);
  const after = beats.length > 0 ? checkDraftBeatFidelity({ draftContent: round.draftBody, mustHitBeats: beats }).missingBeats : [];
  return {
    draftBody: round.draftBody,
    changed: round.draftBody !== input.draftBody,
    aiFlavor,
    autoDeAi: round.info,
    newMisses: after.filter((beat) => !before.has(beat)),
  };
}

export { checkDraft, fixSureIssues, recheckDraft, type FixOutcome };

/** 终稿的要点核对：确定性核对（零调用），有漏的再让模型复核一次（带正文原句才摘掉）。 */
export async function finalBeatFidelity(input: {
  readonly draftBody: string;
  readonly mustHitBeats?: readonly string[];
  /** 多版时选中那一版的复核（终稿和它一样就沿用，不再调）。 */
  readonly chosenBody?: string;
  readonly chosenAdjudication?: BeatMissAdjudication;
  readonly chosenReport?: BeatFidelityReport;
  readonly callModel: (prompt: string) => Promise<string>;
}): Promise<{ readonly missingBeats: readonly string[]; readonly adjudication?: BeatMissAdjudication }> {
  const beats = input.mustHitBeats ?? [];
  const unchanged = input.chosenBody !== undefined && input.chosenBody === input.draftBody;
  const deterministic = unchanged && input.chosenReport
    ? input.chosenReport.missingBeats
    : beats.length > 0 ? checkDraftBeatFidelity({ draftContent: input.draftBody, mustHitBeats: beats }).missingBeats : [];
  if (deterministic.length === 0) return { missingBeats: deterministic };
  if (unchanged && input.chosenAdjudication) return { missingBeats: deterministic, adjudication: input.chosenAdjudication };
  const adjudication = await adjudicateMissingBeats({ draftContent: input.draftBody, missingBeats: deterministic, callModel: input.callModel });
  return { missingBeats: deterministic, adjudication };
}

/** 这一版正文的字数报告（每步改了正文都按最新的重算）。 */
export const lengthReportOf = (draftBody: string, lengthTarget: DraftLengthTarget): DraftLengthReport => buildDraftLengthReport({ draftBody, lengthTarget });

/** 照这份章纲写的那一条材料（没有章纲就用开写时盘上那份）。 */
export function planMaterial(chapter: number, plan: ChapterPlan | undefined, startPlan: MaterialRead): MaterialRead {
  return plan ? { kind: "plan", chapter, digest: planDigest(plan) } : startPlan;
}

export type { ChapterPlan, ExtendOutcome };
