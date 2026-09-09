import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildAiFlavorReport,
  detectAiFlavorViolations,
  type AiFlavorReport,
  type AiFlavorRule,
} from "./ai-flavor-detection.js";
import {
  buildWriterContext,
  type ArcGoalsContext,
  type StoryContinuityContext,
  type StoryThreadsContext,
  type WriterContextEnvelope,
} from "./context-gateway.js";
import { checkDraftContinuity, type ContinuityQualityReport } from "./continuity-quality-check.js";
import { checkDraftBeatFidelity, type BeatFidelityReport } from "./draft-beat-fidelity.js";
import {
  applyDraftLengthConstraint,
  buildDraftLengthReport,
  resolveDraftLengthTarget,
  resolveDraftMaxOutputTokens,
  trimDraftBodyToLengthTarget,
  type DraftLengthReport,
} from "./draft-length-control.js";
import {
  attachDiagnostics,
  recordContextStats,
  recordRuntimeLatency,
  recordTokenUsage,
  startRuntimeLatency,
  writeDiagnostics,
  type DiagnosticsRecord,
} from "./diagnostics.js";
import { buildPromptFingerprint, type PromptFingerprint } from "./prompt-cache-diagnostics.js";
import { readWritingRules } from "./project-store.js";
import type { CharacterProfile } from "./types.js";

export { resolveDraftMaxOutputTokens } from "./draft-length-control.js";

export interface WriterClient {
  readonly generateDraft: (input: {
    readonly context: WriterContextEnvelope;
    readonly maxOutputTokens: number;
  }) => Promise<{
    readonly title: string;
    readonly content: string;
    readonly tokenUsage?: TokenUsage;
    readonly cacheMetrics?: CacheMetrics;
  }>;
}

export interface TokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface CacheMetrics {
  readonly provider: string;
  readonly promptCacheHitTokens: number | null;
  readonly promptCacheMissTokens: number | null;
  readonly cacheHitRatio: number | null;
  readonly rawCacheMetadata: Record<string, unknown> | null;
  readonly cacheMetricsAvailable: boolean;
}

export interface FastDraftInput {
  readonly projectDir: string;
  readonly chapter: number;
  readonly chapterGoal: string;
  readonly writerClient: WriterClient;
  readonly selectedCharacterIds?: readonly string[];
  readonly selectedHookIds?: readonly string[];
  readonly maxTimelineEvents?: number;
  /** 用户/agent 指定的本章必须命中要点：注入「本章硬约束」让模型逐条落实，出稿后确定性核对（Codex 复测：首稿跑偏）。 */
  readonly mustHitBeats?: readonly string[];
  readonly rankContext?: (envelope: WriterContextEnvelope) => WriterContextEnvelope;
  readonly maxOutputTokens?: number;
  readonly requestedDraftLength?: number;
  readonly dryRun?: boolean;
  /**
   * persist=false（抽卡候选用）：照常调模型生成正文，但**不写工作稿文件**，把正文放进 report.draftBody 返回。
   * 让「再来一版」能临时生成 2–3 个候选并排给用户挑，不冲掉当前草稿、不污染操作历史。默认 true（写盘，原行为）。
   */
  readonly persist?: boolean;
  /**
   * AI 腔确定性回检规则（机制进引擎、策略留 UI：规则数据由上层传入，引擎不内置禁词表）。
   * 不传/空数组 → 完全不跑、报告里无 aiFlavor 字段（旧调用方零行为变化）；传了 → 出稿后跑
   * detectAiFlavorViolations，结果以 warning-only 放进 report.aiFlavor（绝不影响 passed、不拦稿、不触发重试）。
   */
  readonly aiFlavorRules?: readonly AiFlavorRule[];
}

export interface FastDraftReport {
  readonly chapter: number;
  readonly passed: boolean;
  readonly draftPath?: string;
  /** persist=false（抽卡候选）时正文放这里返回，不写文件。 */
  readonly draftBody?: string;
  readonly title?: string;
  readonly contextStats: {
    readonly totalTokenEstimate: number;
    readonly stableTokenEstimate: number;
    readonly dynamicTokenEstimate: number;
    readonly contextSections: readonly string[];
  };
  readonly tokenUsage?: TokenUsage;
  readonly cacheMetrics?: CacheMetrics;
  readonly promptFingerprint: PromptFingerprint;
  readonly draftLength?: DraftLengthReport;
  readonly continuityQuality?: ContinuityQualityReport;
  readonly beatFidelity?: BeatFidelityReport;
  /** AI 腔确定性回检（warning-only）：仅 input.aiFlavorRules 非空时出现。 */
  readonly aiFlavor?: AiFlavorReport;
  readonly diagnostics?: DiagnosticsRecord;
  readonly issues: readonly string[];
}

/**
 * 工作稿写盘的唯一通道：runFastDraft persist:true 与「先 persist:false 出候选、选出优胜再落盘」共用，
 * 保证 drafts/fast/chapter-XXXX.md 的路径与标题行格式（`# {title}\n\n{body}\n`）只有这一处定义，
 * 上层（路由抽卡落盘、agent 多候选选优落盘）绝不在引擎外另拼这个文件。
 */
export async function persistFastDraftBody(input: {
  readonly projectDir: string;
  readonly chapter: number;
  readonly title: string;
  readonly draftBody: string;
}): Promise<string> {
  const draftPath = join(input.projectDir, "drafts", "fast", `chapter-${padChapter(input.chapter)}.md`);
  await mkdir(join(input.projectDir, "drafts", "fast"), { recursive: true });
  await writeFile(draftPath, `# ${input.title}\n\n${input.draftBody.trim()}\n`, "utf-8");
  return draftPath;
}

export async function runFastDraft(input: FastDraftInput): Promise<FastDraftReport> {
  const latencyTimer = startRuntimeLatency();
  const writingRules = await readWritingRules(input.projectDir).catch(() => null);
  const draftLengthTarget = resolveDraftLengthTarget({
    chapterGoal: input.chapterGoal,
    requestedDraftLength: input.requestedDraftLength,
    writingRules,
  });
  const chapterGoal = applyDraftLengthConstraint(input.chapterGoal, draftLengthTarget);
  const emptyDraftLength = buildDraftLengthReport({
    draftBody: "",
    lengthTarget: draftLengthTarget,
  });
  const builtContext = await buildWriterContext({
    projectDir: input.projectDir,
    chapter: input.chapter,
    chapterGoal,
    selectedCharacterIds: input.selectedCharacterIds,
    selectedHookIds: input.selectedHookIds,
    maxTimelineEvents: input.maxTimelineEvents,
    ...(input.mustHitBeats && input.mustHitBeats.length > 0 ? { mustHitBeats: input.mustHitBeats } : {}),
  });
  const context = input.rankContext ? input.rankContext(builtContext) : builtContext;
  const contextStats = buildContextStats(context);
  const promptFingerprint = buildPromptFingerprint(context);
  if (input.dryRun === true) {
    return withFastDraftDiagnostics(input.projectDir, {
      chapter: input.chapter,
      passed: true,
      draftLength: emptyDraftLength,
      contextStats,
      promptFingerprint,
      issues: [],
    }, latencyTimer);
  }

  try {
    const generated = await input.writerClient.generateDraft({
      context,
      maxOutputTokens: input.maxOutputTokens ?? resolveDraftMaxOutputTokens(draftLengthTarget),
    });
    const generatedTitle = chooseDraftTitle(input.chapter, generated.title, generated.content);
    const rawDraftBody = stripLeadingMarkdownChapterHeading(generated.content);
    const rawDraftLength = buildDraftLengthReport({
      draftBody: rawDraftBody,
      lengthTarget: draftLengthTarget,
    });
    const trimResult = rawDraftLength.lengthStatus === "above_upper_bound"
      ? trimDraftBodyToLengthTarget(rawDraftBody, draftLengthTarget)
      : undefined;
    const draftBody = trimResult?.ok ? trimResult.draftBody : rawDraftBody;
    const draftLength = buildDraftLengthReport({
      draftBody,
      lengthTarget: draftLengthTarget,
      ...(trimResult?.ok
        ? {
          finalLengthAfterTrim: trimResult.finalLength,
          whetherTrimmed: trimResult.draftBody !== rawDraftBody.trim(),
        }
        : {}),
    });
    const normalizedGenerated = { ...generated, title: generatedTitle, content: draftBody };
    const continuityQuality = checkDraftContinuity({
      draftContent: normalizedGenerated.content,
      continuity: storyContinuityFromContext(context),
      storyThreads: storyThreadsFromContext(context),
      arcGoals: arcGoalsFromContext(context),
      chapter: input.chapter,
    });
    // 出稿后确定性保真核对：用户/agent 指定的必命中要点里的具体锚点（编号/数字+量词+名物）漏了就软警告（不阻塞）。
    const beatFidelity = input.mustHitBeats && input.mustHitBeats.length > 0
      ? checkDraftBeatFidelity({ draftContent: normalizedGenerated.content, mustHitBeats: input.mustHitBeats })
      : undefined;
    // AI 腔确定性回检（规则数据由上层传入）：与 beatFidelity 同级的 warning-only 软警告——
    // 绝不影响 passed、不拦稿、不触发重试；不传规则则完全跳过（向后兼容）。
    const aiFlavor = input.aiFlavorRules && input.aiFlavorRules.length > 0
      ? buildAiFlavorReport(detectAiFlavorViolations(normalizedGenerated.content, input.aiFlavorRules))
      : undefined;
    const issues = validateDraft(normalizedGenerated, context);
    if (trimResult && !trimResult.ok) {
      issues.push("Draft content could not be safely trimmed within the requested length range.");
    }
    if (issues.length > 0) {
      return withFastDraftDiagnostics(input.projectDir, {
        chapter: input.chapter,
        passed: false,
        title: generatedTitle,
        contextStats,
        promptFingerprint,
        draftLength,
        tokenUsage: generated.tokenUsage,
        cacheMetrics: generated.cacheMetrics,
        continuityQuality,
        ...(beatFidelity ? { beatFidelity } : {}),
        ...(aiFlavor ? { aiFlavor } : {}),
        issues,
      }, latencyTimer);
    }

    if (input.persist === false) {
      // 抽卡候选：不写工作稿、不动磁盘，把正文交回路由临时展示。
      return withFastDraftDiagnostics(input.projectDir, {
        chapter: input.chapter,
        passed: true,
        draftBody: normalizedGenerated.content.trim(),
        title: generatedTitle,
        contextStats,
        promptFingerprint,
        draftLength,
        tokenUsage: generated.tokenUsage,
        cacheMetrics: generated.cacheMetrics,
        continuityQuality,
        ...(beatFidelity ? { beatFidelity } : {}),
        ...(aiFlavor ? { aiFlavor } : {}),
        issues: [],
      }, latencyTimer);
    }

    const draftPath = await persistFastDraftBody({
      projectDir: input.projectDir,
      chapter: input.chapter,
      title: generatedTitle,
      draftBody: normalizedGenerated.content,
    });
    return withFastDraftDiagnostics(input.projectDir, {
      chapter: input.chapter,
      passed: true,
      draftPath,
      title: generatedTitle,
      contextStats,
      promptFingerprint,
      draftLength,
      tokenUsage: generated.tokenUsage,
      cacheMetrics: generated.cacheMetrics,
      continuityQuality,
      ...(beatFidelity ? { beatFidelity } : {}),
      ...(aiFlavor ? { aiFlavor } : {}),
      issues: [],
    }, latencyTimer);
  } catch (error) {
    return withFastDraftDiagnostics(input.projectDir, {
      chapter: input.chapter,
      passed: false,
      contextStats,
      promptFingerprint,
      draftLength: emptyDraftLength,
      issues: [error instanceof Error ? error.message : String(error)],
    }, latencyTimer);
  }
}

async function withFastDraftDiagnostics(
  projectDir: string,
  report: FastDraftReport,
  latencyTimer: ReturnType<typeof startRuntimeLatency>,
): Promise<FastDraftReport> {
  const diagnostics = await writeDiagnostics(projectDir, {
    stage: "fast-draft",
    chapter: report.chapter,
    generatedAt: new Date().toISOString(),
    runtimeLatency: recordRuntimeLatency(latencyTimer),
    ...(report.tokenUsage !== undefined ? { tokenUsage: recordTokenUsage(report.tokenUsage) } : {}),
    contextStats: recordContextStats(report.contextStats),
    details: {
      passed: report.passed,
      draftPath: report.draftPath,
      title: report.title,
      issueCount: report.issues.length,
      promptFingerprint: report.promptFingerprint,
      ...(report.draftLength !== undefined ? { draftLength: report.draftLength } : {}),
      ...(report.cacheMetrics !== undefined ? { cacheMetrics: report.cacheMetrics } : {}),
      ...(report.continuityQuality !== undefined
        ? {
          continuityQuality: {
            passed: report.continuityQuality.passed,
            score: report.continuityQuality.score,
            issueCount: report.continuityQuality.issues.length,
            matched: report.continuityQuality.matched,
          },
        }
        : {}),
    },
  });
  return attachDiagnostics(report, diagnostics);
}

function storyContinuityFromContext(context: WriterContextEnvelope): StoryContinuityContext {
  const section = context.sections.find((item) => item.name === "story_continuity");
  if (isStoryContinuityContext(section?.content)) return section.content;
  return {
    recentEvents: [],
    openLeads: [],
    activeConflicts: [],
    discoveries: [],
    recentLocations: [],
    recentCharacters: [],
    carryForwardInstruction: "暂无前情承接要求。",
  };
}

function storyThreadsFromContext(context: WriterContextEnvelope): StoryThreadsContext | undefined {
  const section = context.sections.find((item) => item.name === "story_threads");
  if (isStoryThreadsContext(section?.content)) return section.content;
  return undefined;
}

function arcGoalsFromContext(context: WriterContextEnvelope): ArcGoalsContext | undefined {
  const section = context.sections.find((item) => item.name === "arc_goals");
  if (isArcGoalsContext(section?.content)) return section.content;
  return undefined;
}

function isStoryContinuityContext(value: unknown): value is StoryContinuityContext {
  return typeof value === "object"
    && value !== null
    && Array.isArray((value as StoryContinuityContext).recentEvents)
    && Array.isArray((value as StoryContinuityContext).openLeads)
    && Array.isArray((value as StoryContinuityContext).activeConflicts)
    && Array.isArray((value as StoryContinuityContext).discoveries)
    && Array.isArray((value as StoryContinuityContext).recentLocations)
    && Array.isArray((value as StoryContinuityContext).recentCharacters);
}

function isStoryThreadsContext(value: unknown): value is StoryThreadsContext {
  return typeof value === "object"
    && value !== null
    && Array.isArray((value as StoryThreadsContext).openLeads)
    && Array.isArray((value as StoryThreadsContext).openIntents)
    && Array.isArray((value as StoryThreadsContext).recentlyTouchedThreads)
    && Array.isArray((value as StoryThreadsContext).staleThreadWarnings);
}

function isArcGoalsContext(value: unknown): value is ArcGoalsContext {
  return typeof value === "object"
    && value !== null
    && Array.isArray((value as ArcGoalsContext).activeGoals)
    && Array.isArray((value as ArcGoalsContext).recentlyTouchedGoals)
    && Array.isArray((value as ArcGoalsContext).staleGoalWarnings);
}

function buildContextStats(context: WriterContextEnvelope): FastDraftReport["contextStats"] {
  const totalTokenEstimate = context.sections.reduce((sum, section) => sum + section.tokenEstimate, 0);
  const stableTokenEstimate = context.sections
    .filter((section) => section.cachePolicy === "stable")
    .reduce((sum, section) => sum + section.tokenEstimate, 0);
  return {
    totalTokenEstimate,
    stableTokenEstimate,
    dynamicTokenEstimate: totalTokenEstimate - stableTokenEstimate,
    contextSections: context.sections.map((section) => section.name),
  };
}

function validateDraft(
  generated: {
    readonly title: string;
    readonly content: string;
  },
  context: WriterContextEnvelope,
): string[] {
  const issues: string[] = [];
  const title = generated.title.trim();
  const content = generated.content.trim();
  if (!title) issues.push("Draft title is required.");
  if (!content) issues.push("Draft content is required.");
  if (content && looksLikeToolOrJsonArtifact(content)) {
    issues.push("Draft content looks like JSON or a tool-call artifact.");
  }

  const characterNames = selectedCharacterMentionCandidates(context);
  if (content && characterNames.length > 0 && !characterNames.some((name) => content.includes(name))) {
    issues.push(`Draft content must mention at least one selected character: ${characterNames.join(", ")}.`);
  }
  return issues;
}

function selectedCharacterMentionCandidates(context: WriterContextEnvelope): string[] {
  const profilesSection = context.sections.find((section) => section.name === "character_profile");
  const profiles = Array.isArray(profilesSection?.content)
    ? profilesSection.content as CharacterProfile[]
    : [];
  return unique(profiles.flatMap((profile) => nameCandidates(profile.name)));
}

function nameCandidates(name: string): string[] {
  const trimmed = name.trim();
  if (!trimmed) return [];
  return [trimmed, ...trimmed.split(/[\/／|｜,，、]/u).map((part) => part.trim())].filter(Boolean);
}

function looksLikeToolOrJsonArtifact(content: string): boolean {
  if (/^(?:\{|\[)/u.test(content)) {
    try {
      JSON.parse(content);
      return true;
    } catch {
      return false;
    }
  }
  return /tool_call|function_call|"arguments"\s*:|"name"\s*:/iu.test(content);
}

function stripLeadingMarkdownChapterHeading(content: string): string {
  const normalized = content.replace(/\r\n?/gu, "\n").trimStart();
  const lines = normalized.split("\n");
  const firstContentLineIndex = lines.findIndex((line) => line.trim().length > 0);
  if (firstContentLineIndex < 0) return normalized.trim();

  const firstContentLine = lines[firstContentLineIndex].trim();
  if (!isMarkdownChapterHeading(firstContentLine) && !isPlainChapterHeading(firstContentLine)) return normalized.trim();

  const nextLines = lines.slice(firstContentLineIndex + 1);
  while (nextLines[0]?.trim() === "") nextLines.shift();
  return nextLines.join("\n").trim();
}

function chooseDraftTitle(chapter: number, title: string, content: string): string {
  const modelHeadingTitle = extractLeadingChapterTitle(content);
  const cleanTitle = title.trim();
  if (modelHeadingTitle && !isGenericChapterTitle(modelHeadingTitle, chapter)) return modelHeadingTitle;
  if (cleanTitle && !isGenericChapterTitle(cleanTitle, chapter)) return cleanTitle;
  return `第${chapter}章`;
}

function extractLeadingChapterTitle(content: string): string | undefined {
  const normalized = content.replace(/\r\n?/gu, "\n").trimStart();
  const firstLine = normalized.split("\n").find((line) => line.trim().length > 0)?.trim();
  if (!firstLine) return undefined;
  if (isMarkdownChapterHeading(firstLine)) return firstLine.replace(/^#{1,6}\s+/u, "").trim();
  if (isPlainChapterHeading(firstLine)) return firstLine.trim();
  return undefined;
}

function isGenericChapterTitle(title: string, chapter: number): boolean {
  const trimmed = title.trim();
  return trimmed === `第${chapter}章` || /^第[一二三四五六七八九十百千万\d]+章$/u.test(trimmed);
}

function isMarkdownChapterHeading(line: string): boolean {
  if (!/^#{1,6}\s+\S/u.test(line)) return false;
  const title = line.replace(/^#{1,6}\s+/u, "").trim();
  if (!title) return false;
  if (/^第[一二三四五六七八九十百千万\d]+章(?:\s*[·：:、-]\s*.*)?$/u.test(title)) return true;
  return title.length <= 40 && !/[。！？!?；;]/u.test(title);
}

function isPlainChapterHeading(line: string): boolean {
  return /^第[一二三四五六七八九十百千万\d]+章(?:\s*[·：:、-]\s*[^。！？!?；;]{1,32})?$/u.test(line.trim());
}

function padChapter(chapter: number): string {
  return String(Math.max(0, Math.trunc(chapter))).padStart(4, "0");
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
