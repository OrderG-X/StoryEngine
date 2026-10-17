import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import { Command, InvalidArgumentError } from "commander";
import {
  buildChapterSteeringDraft,
  buildCommitPlanFromProject,
  buildStateOverview,
  checkCommitPlanSemanticQuality,
  checkDraftBeforeCommit,
  commitFastDraft,
  loadModelSettingsV0,
  renderFastDraftPromptText,
  runFastDraft,
  type ChapterSteeringDraft,
  type ChapterSteeringPacing,
  type ChapterSteeringRevealLevel,
  type StateOverview,
  type ModelSettingsLoadResult,
  type CommitDraftInput,
  type ArcGoalUpdate,
  type HookStaleWarning,
  type HookTrackingUpdate,
  type StaleGoalWarning,
  type StaleThreadWarning,
  type ThreadHygieneReport,
  type ThreadTrackingUpdate,
  type CommitQualityReport,
  type CommitReport,
  type CacheMetrics,
  type ChapterSemanticSummary,
  type FastDraftReport,
  type TokenUsage,
  type WriterContextEnvelope,
  type WriterClient,
} from "@actalk/story-engine";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

export interface DraftOptions {
  readonly project?: string;
  readonly chapter?: number;
  readonly provider?: string;
  readonly model?: string;
  readonly dryRun?: boolean;
  readonly json?: boolean;
}

export interface CommitDraftOptions {
  readonly project?: string;
  readonly chapter?: number;
  readonly plan?: string;
  readonly preview?: boolean;
  readonly json?: boolean;
}

export interface StateOverviewOptions {
  readonly project?: string;
  readonly chapter?: number;
  readonly maxTimelineEvents?: number;
  readonly save?: boolean;
  readonly json?: boolean;
}

export interface ChapterSteeringOptions {
  readonly project?: string;
  readonly direction?: string;
  readonly chapter?: number;
  readonly mustInclude?: readonly string[];
  readonly mustAvoid?: readonly string[];
  readonly pacing?: ChapterSteeringPacing;
  readonly revealLevel?: ChapterSteeringRevealLevel;
  readonly maxSuggestions?: number;
  readonly save?: boolean;
  readonly json?: boolean;
}

export interface ModelSettingsOptions {
  readonly project?: string;
  readonly json?: boolean;
}

export type StateOverviewCommandReport = StateOverview & {
  readonly reportPath?: string;
};

export type ChapterSteeringCommandReport = ChapterSteeringDraft & {
  readonly reportPath?: string;
};

export interface CommitPlanPreviewReport {
  readonly chapter: number;
  readonly passed: boolean;
  readonly commitPlan?: CommitDraftInput["commitPlan"];
  readonly qualityCheck?: CommitQualityReport;
  readonly semanticSummary?: ChapterSemanticSummary;
  readonly hookTrackingUpdates?: readonly HookTrackingUpdate[];
  readonly staleHookWarnings?: readonly HookStaleWarning[];
  readonly threadTrackingUpdates?: readonly ThreadTrackingUpdate[];
  readonly staleThreadWarnings?: readonly StaleThreadWarning[];
  readonly threadHygieneReport?: ThreadHygieneReport;
  readonly arcGoalUpdates?: readonly ArcGoalUpdate[];
  readonly staleGoalWarnings?: readonly StaleGoalWarning[];
  readonly summary: {
    readonly characterUpdates: number;
    readonly timelineEvents: number;
    readonly worldUpdates: boolean;
    readonly hookUpdates: number;
    readonly calendarUpdate: boolean;
  };
  readonly issues: readonly string[];
}

export type CommitDraftCommandReport = CommitReport & {
  readonly qualityCheck?: CommitQualityReport;
};

export interface ProgramHooks {
  readonly writerClient?: WriterClient;
  readonly env?: Record<string, string | undefined>;
  readonly fetch?: FetchLike;
  readonly stdout?: Pick<NodeJS.WriteStream, "write">;
  readonly stderr?: Pick<NodeJS.WriteStream, "write">;
}

export interface FetchLike {
  (url: string, init: {
    readonly method: "POST";
    readonly headers: Record<string, string>;
    readonly body: string;
  }): Promise<{
    readonly ok: boolean;
    readonly status: number;
    readonly statusText: string;
    text(): Promise<string>;
  }>;
}

export function createProgram(hooks: ProgramHooks = {}): Command {
  const program = new Command();

  program
    .name("story-engine")
    .description("StoryEngine-NG command line tools")
    .version(version)
    .exitOverride();

  program
    .command("model-settings")
    .description("Inspect read-only StoryEngine model settings")
    .addCommand(createModelSettingsShowCommand(hooks))
    .addCommand(createModelSettingsValidateCommand(hooks));

  program
    .command("draft")
    .description("Create a fast draft for a chapter without committing formal story state")
    .requiredOption("--project <path>", "StoryEngine project directory")
    .requiredOption("--chapter <number>", "Chapter number", parseChapter)
    .option("--provider <provider>", "OpenAI-compatible provider name")
    .option("--model <model>", "Model name for real fast draft generation")
    .option("--dry-run", "Build context and diagnostics without calling a writer or writing a draft", true)
    .option("--no-dry-run", "Call the configured writer and save drafts/fast/chapter-000N.md")
    .option("--json", "Print a machine-readable JSON report")
    .action(async (options: DraftOptions) => {
      await runDraftCommand(options, hooks);
    });

  program
    .command("commit-draft")
    .description("Commit a fast draft into formal chapter and story state files")
    .requiredOption("--project <path>", "StoryEngine project directory")
    .requiredOption("--chapter <number>", "Chapter number", parseChapter)
    .option("--plan <path>", "Optional JSON commit plan file")
    .option("--preview", "Build and print the commit plan without applying it")
    .option("--json", "Print a machine-readable JSON report")
    .action(async (options: CommitDraftOptions) => {
      await runCommitDraftCommand(options, hooks);
    });

  program
    .command("state-overview")
    .description("Build a read-only StoryEngine state overview ViewModel for UI and chapter steering")
    .requiredOption("--project <path>", "StoryEngine project directory")
    .option("--chapter <number>", "Current chapter for age-sensitive diagnostics", parseChapter)
    .option("--max-timeline-events <number>", "Maximum recent timeline events", parsePositiveInteger)
    .option("--save", "Write state overview report", true)
    .option("--no-save", "Do not write state overview report")
    .option("--json", "Print a machine-readable JSON state overview")
    .action(async (options: StateOverviewOptions) => {
      await runStateOverviewCommand(options, hooks);
    });

  program
    .command("chapter-steering")
    .description("Build a read-only next-chapter steering draft with selectable continuity suggestions")
    .requiredOption("--project <path>", "StoryEngine project directory")
    .requiredOption("--direction <text>", "User direction for the next chapter")
    .option("--chapter <number>", "Current chapter for state overview and diagnostics", parseChapter)
    .option("--must-include <text>", "Text that should be included; repeatable", collectValues, [])
    .option("--must-avoid <text>", "Text that should be avoided; repeatable", collectValues, [])
    .option("--pacing <level>", "Pacing: slow, medium, or fast", parsePacing, "medium")
    .option("--reveal-level <level>", "Reveal level: none, small, or large", parseRevealLevel, "small")
    .option("--max-suggestions <number>", "Maximum steering suggestions", parsePositiveInteger)
    .option("--save", "Write chapter steering report", true)
    .option("--no-save", "Do not write chapter steering report")
    .option("--json", "Print a machine-readable JSON steering draft")
    .action(async (options: ChapterSteeringOptions) => {
      await runChapterSteeringCommand(options, hooks);
    });

  return program;
}

function createModelSettingsShowCommand(hooks: ProgramHooks): Command {
  return new Command("show")
    .description("Show a sanitized model settings summary without calling a model")
    .requiredOption("--project <path>", "StoryEngine project directory")
    .option("--json", "Print a machine-readable JSON report")
    .action(async (options: ModelSettingsOptions) => {
      await runModelSettingsShowCommand(options, hooks);
    });
}

function createModelSettingsValidateCommand(hooks: ProgramHooks): Command {
  return new Command("validate")
    .description("Validate model settings without calling a model")
    .requiredOption("--project <path>", "StoryEngine project directory")
    .option("--json", "Print a machine-readable JSON report")
    .action(async (options: ModelSettingsOptions) => {
      await runModelSettingsValidateCommand(options, hooks);
    });
}

export async function runModelSettingsShowCommand(
  options: ModelSettingsOptions,
  hooks: ProgramHooks = {},
): Promise<ModelSettingsLoadResult> {
  return runModelSettingsCommand(options, hooks);
}

export async function runModelSettingsValidateCommand(
  options: ModelSettingsOptions,
  hooks: ProgramHooks = {},
): Promise<ModelSettingsLoadResult> {
  return runModelSettingsCommand(options, hooks);
}

async function runModelSettingsCommand(
  options: ModelSettingsOptions,
  hooks: ProgramHooks,
): Promise<ModelSettingsLoadResult> {
  const projectDir = resolveRequiredPath(options.project, "--project");
  const result = await loadModelSettingsV0(projectDir, {
    env: hooks.env ?? process.env,
  });
  writeModelSettingsReport(result, options.json === true, hooks.stdout ?? process.stdout, hooks.stderr ?? process.stderr);
  if (!result.passed) {
    process.exitCode = 1;
  }
  return result;
}

export async function runStateOverviewCommand(
  options: StateOverviewOptions,
  hooks: ProgramHooks = {},
): Promise<StateOverviewCommandReport> {
  const projectDir = resolveRequiredPath(options.project, "--project");
  const overview = await buildStateOverview({
    projectDir,
    chapter: options.chapter,
    maxTimelineEvents: options.maxTimelineEvents,
  });
  const reportPath = options.save === false
    ? undefined
    : await writeStateOverviewReportFile(projectDir, overview, options.chapter);
  const report = reportPath ? { ...overview, reportPath } : overview;

  writeStateOverviewReport(report, options.json === true, hooks.stdout ?? process.stdout);
  return report;
}

export async function runChapterSteeringCommand(
  options: ChapterSteeringOptions,
  hooks: ProgramHooks = {},
): Promise<ChapterSteeringCommandReport> {
  const projectDir = resolveRequiredPath(options.project, "--project");
  const draft = await buildChapterSteeringDraft({
    projectDir,
    userDirection: requirePlainText(options.direction, "--direction"),
    chapter: options.chapter,
    mustInclude: options.mustInclude ?? [],
    mustAvoid: options.mustAvoid ?? [],
    pacing: options.pacing,
    revealLevel: options.revealLevel,
    maxSuggestions: options.maxSuggestions,
  });
  const reportPath = options.save === false
    ? undefined
    : await writeChapterSteeringReportFile(projectDir, draft, options.chapter);
  const report = reportPath ? { ...draft, reportPath } : draft;

  writeChapterSteeringReport(report, options.json === true, hooks.stdout ?? process.stdout);
  return report;
}

export async function runProgram(argv: readonly string[] = process.argv, hooks: ProgramHooks = {}): Promise<void> {
  const program = createProgram(hooks);
  await program.parseAsync([...argv]);
}

export async function runDraftCommand(options: DraftOptions, hooks: ProgramHooks = {}): Promise<FastDraftReport> {
  const projectDir = resolveRequiredPath(options.project, "--project");
  const chapter = requireChapter(options.chapter);
  const dryRun = options.dryRun !== false;
  const writerClient = dryRun
    ? hooks.writerClient ?? unreachableDryRunWriterClient
    : hooks.writerClient ?? createOpenAICompatibleWriterClient({
      provider: requireText(options.provider, "--provider"),
      model: requireText(options.model, "--model"),
      env: hooks.env ?? process.env,
      fetch: hooks.fetch ?? (globalThis.fetch as FetchLike),
    });
  const report = await runFastDraft({
    projectDir,
    chapter,
    chapterGoal: `Fast draft chapter ${chapter}.`,
    writerClient,
    dryRun,
  });

  writeDraftReport(report, options.json === true, hooks.stdout ?? process.stdout, hooks.stderr ?? process.stderr);
  if (!report.passed) {
    process.exitCode = 1;
  }
  return report;
}

const unreachableDryRunWriterClient: WriterClient = {
  async generateDraft() {
    throw new Error("Dry-run must not call a writer client.");
  },
};

export async function runCommitDraftCommand(
  options: CommitDraftOptions,
  hooks: ProgramHooks = {},
): Promise<CommitDraftCommandReport | CommitPlanPreviewReport> {
  const projectDir = resolveRequiredPath(options.project, "--project");
  const chapter = requireChapter(options.chapter);
  const draftPath = join(projectDir, "drafts", "fast", `chapter-${padChapter(chapter)}.md`);
  const commitPlan = options.plan
    ? await readCommitPlan(resolveRequiredPath(options.plan, "--plan"))
    : await buildDefaultCommitPlan(projectDir, chapter, draftPath);
  if (!commitPlan.passed || !commitPlan.commitPlan) {
    const report = failedCommitReport(chapter, commitPlan.issues);
    writeCommitReport(report, options.json === true, hooks.stdout ?? process.stdout, hooks.stderr ?? process.stderr);
    process.exitCode = 1;
    return report;
  }
  const qualityCheck = await runCommitQualityCheck(projectDir, chapter, draftPath);
  const qualityWithPlanSemantics = mergeQualityReports(qualityCheck, checkCommitPlanSemanticQuality(commitPlan.commitPlan));
  if (options.preview === true) {
    const report = buildCommitPlanPreviewReport(chapter, commitPlan.commitPlan, qualityWithPlanSemantics);
    writeCommitPreviewReport(report, options.json === true, hooks.stdout ?? process.stdout, hooks.stderr ?? process.stderr);
    return report;
  }
  if (!qualityWithPlanSemantics.passed) {
    const report = attachQualityCheck(
      failedCommitReport(chapter, qualityWithPlanSemantics.issues.map((issue) => issue.message)),
      qualityWithPlanSemantics,
    );
    writeCommitReport(report, options.json === true, hooks.stdout ?? process.stdout, hooks.stderr ?? process.stderr);
    process.exitCode = 1;
    return report;
  }
  const report = await commitFastDraft({
    projectDir,
    chapter,
    draftPath,
    commitPlan: commitPlan.commitPlan,
  });
  const reportWithQuality = attachQualityCheck(report, qualityWithPlanSemantics);

  writeCommitReport(reportWithQuality, options.json === true, hooks.stdout ?? process.stdout, hooks.stderr ?? process.stderr);
  if (!reportWithQuality.passed) {
    process.exitCode = 1;
  }
  return reportWithQuality;
}

function mergeQualityReports(...reports: readonly CommitQualityReport[]): CommitQualityReport {
  const issues = reports.flatMap((report) => report.issues);
  return {
    passed: !issues.some((issue) => issue.severity === "error"),
    issues,
  };
}

function buildCommitPlanPreviewReport(
  chapter: number,
  commitPlan: CommitDraftInput["commitPlan"],
  qualityCheck?: CommitQualityReport,
): CommitPlanPreviewReport {
  return {
    chapter,
    passed: true,
    commitPlan,
    ...(qualityCheck !== undefined ? { qualityCheck } : {}),
    ...semanticSummaryFromCommitPlan(commitPlan),
    ...(commitPlan.hookTrackingUpdates !== undefined ? { hookTrackingUpdates: commitPlan.hookTrackingUpdates } : {}),
    ...(commitPlan.staleHookWarnings !== undefined ? { staleHookWarnings: commitPlan.staleHookWarnings } : {}),
    ...(commitPlan.threadTrackingUpdates !== undefined ? { threadTrackingUpdates: commitPlan.threadTrackingUpdates } : {}),
    ...(commitPlan.staleThreadWarnings !== undefined ? { staleThreadWarnings: commitPlan.staleThreadWarnings } : {}),
    ...(commitPlan.threadHygieneReport !== undefined ? { threadHygieneReport: commitPlan.threadHygieneReport } : {}),
    ...(commitPlan.arcGoalUpdates !== undefined ? { arcGoalUpdates: commitPlan.arcGoalUpdates } : {}),
    ...(commitPlan.staleGoalWarnings !== undefined ? { staleGoalWarnings: commitPlan.staleGoalWarnings } : {}),
    summary: {
      characterUpdates: commitPlan.characterUpdates?.length ?? 0,
      timelineEvents: commitPlan.timelineEvents?.length ?? 0,
      worldUpdates: commitPlan.worldUpdates !== undefined,
      hookUpdates: commitPlan.hookUpdates?.length ?? 0,
      calendarUpdate: commitPlan.calendar !== undefined,
    },
    issues: [],
  };
}

function semanticSummaryFromCommitPlan(commitPlan: CommitDraftInput["commitPlan"]): {
  readonly semanticSummary?: ChapterSemanticSummary;
} {
  const semanticSummary = commitPlan.timelineEvents?.find((event) => event.effects !== undefined)
    ?.effects?.semanticSummary;
  return isChapterSemanticSummary(semanticSummary) ? { semanticSummary } : {};
}

function isChapterSemanticSummary(value: unknown): value is ChapterSemanticSummary {
  return typeof value === "object"
    && value !== null
    && "chapter" in value
    && "mainEvent" in value;
}

async function runCommitQualityCheck(
  projectDir: string,
  chapter: number,
  draftPath: string,
): Promise<CommitQualityReport> {
  try {
    return await checkDraftBeforeCommit({
      projectDir,
      chapter,
      draftContent: await readFile(draftPath, "utf-8"),
    });
  } catch (error) {
    return {
      passed: false,
      issues: [
        {
          severity: "error",
          type: "draft_read_failed",
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
}

function attachQualityCheck<T extends object>(report: T, qualityCheck: CommitQualityReport): T & {
  readonly qualityCheck: CommitQualityReport;
} {
  return Object.defineProperty(report, "qualityCheck", {
    value: qualityCheck,
    enumerable: true,
    configurable: true,
  }) as T & { readonly qualityCheck: CommitQualityReport };
}

async function buildDefaultCommitPlan(
  projectDir: string,
  chapter: number,
  draftPath: string,
): Promise<{
  readonly passed: boolean;
  readonly commitPlan?: CommitDraftInput["commitPlan"];
  readonly issues: readonly string[];
}> {
  return buildCommitPlanFromProject({ projectDir, chapter, draftPath });
}

async function readCommitPlan(path: string): Promise<{
  readonly passed: boolean;
  readonly commitPlan?: CommitDraftInput["commitPlan"];
  readonly issues: readonly string[];
}> {
  try {
    return {
      passed: true,
      commitPlan: JSON.parse(await readFile(path, "utf-8")) as CommitDraftInput["commitPlan"],
      issues: [],
    };
  } catch (error) {
    return {
      passed: false,
      issues: [error instanceof Error ? error.message : String(error)],
    };
  }
}

function failedCommitReport(chapter: number, issues: readonly string[]): CommitReport {
  return {
    chapter,
    passed: false,
    updatedCharacters: [],
    timelineEventIds: [],
    updatedHooks: [],
    updatedWorld: false,
    updatedCalendar: false,
    issues,
  };
}

// ---------------------------------------------------------------------------
// OpenCode Go 会话头（与 UI story-engine-ui/src/server/lib/llm-client.ts 同源的最小副本：
// CLI 只依赖引擎包、够不着 UI 的 llm-client，函数很小故本地重复一份——改语义须两边同步）。
// 规则（https://opencode.ai/docs/go/）：仅当 baseUrl 命中 opencode 主机才带稳定 x-opencode-session
// + 自有 UA（不带会被拒 MissingSessionID），会话 id 持久化在
// <SE_DATA_DIR ?? ~/.story-engine>/opencode-session.json（与 UI 同一文件同一格式，0600）。
// ---------------------------------------------------------------------------

const STORY_ENGINE_USER_AGENT = "story-engine-ng/1.0";

function isOpencodeHost(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase().includes("opencode");
  } catch {
    return false;
  }
}

// 进程内缓存按「路径」键住：SE_DATA_DIR 变了（测试注入）自动重读，不会拿着旧目录的 id（同 UI）。
let opencodeSessionCache: { readonly path: string; readonly id: string } | undefined;

async function getOpencodeSessionId(env: Record<string, string | undefined>): Promise<string> {
  const override = env.SE_DATA_DIR?.trim();
  const dir = override || join(homedir(), ".story-engine");
  const path = join(dir, "opencode-session.json");
  if (opencodeSessionCache?.path === path) return opencodeSessionCache.id;
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf-8"));
    const existing = typeof parsed === "object" && parsed !== null && "sessionId" in parsed
      ? (parsed as { readonly sessionId?: unknown }).sessionId
      : undefined;
    if (typeof existing === "string" && existing.trim()) {
      opencodeSessionCache = { path, id: existing };
      return existing;
    }
  } catch {
    // 文件不存在/读失败/坏 JSON → 重新生成。session id 不是密钥、无数据损失，重建即恢复（同 UI）。
  }
  const id = randomUUID();
  opencodeSessionCache = { path, id };
  try {
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, `.${randomUUID()}.tmp`);
    try {
      await writeFile(tmp, `${JSON.stringify({ version: 1, sessionId: id }, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
      await chmod(tmp, 0o600).catch(() => undefined);
      await rename(tmp, path);
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw error;
    }
  } catch {
    // 写盘失败不挡请求：进程内缓存仍保证本会话稳定，重启后重新生成（同 UI）。
  }
  return id;
}

export function createOpenAICompatibleWriterClient(input: {
  readonly provider: string;
  readonly model: string;
  readonly env: Record<string, string | undefined>;
  readonly fetch: FetchLike;
}): WriterClient {
  return {
    async generateDraft({ context }) {
      const apiKey = input.env.STORY_ENGINE_LLM_API_KEY;
      if (!apiKey) {
        throw new Error("Missing STORY_ENGINE_LLM_API_KEY.");
      }
      const baseUrl = input.env.STORY_ENGINE_LLM_BASE_URL ?? defaultBaseUrl(input.provider);
      if (!baseUrl) {
        throw new Error("Missing STORY_ENGINE_LLM_BASE_URL.");
      }
      const prompt = renderFastDraftPrompt(context);
      const headers: Record<string, string> = {
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      };
      if (isOpencodeHost(baseUrl)) {
        headers["user-agent"] = STORY_ENGINE_USER_AGENT;
        headers["x-opencode-session"] = await getOpencodeSessionId(input.env);
      }
      const response = await input.fetch(completionEndpoint(baseUrl), {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: input.model,
          messages: [
            {
              role: "user",
              content: prompt,
            },
          ],
          temperature: 0.8,
          // 不传 max_tokens：推理模型的 reasoning_content 也吃 max_tokens 额度，光思考就要 6~9k，
          // 小上限会把正文截空。让模型用自身上限自然收尾（与 UI 侧 llm-client 同一铁律）。
        }),
      });
      const raw = await response.text();
      if (!response.ok) {
        throw new Error(`Model request failed: ${response.status} ${response.statusText}`);
      }
      const parsed = JSON.parse(raw) as OpenAICompatibleResponse;
      const content = parsed.choices?.[0]?.message?.content?.trim() ?? "";
      return {
        title: `Fast Draft Chapter ${context.chapter}`,
        content,
        tokenUsage: normalizeTokenUsage(parsed.usage),
        cacheMetrics: normalizeCacheMetrics(input.provider, parsed),
      };
    },
  };
}

export function renderFastDraftPrompt(envelope: WriterContextEnvelope): string {
  return renderFastDraftPromptText(envelope);
}

interface OpenAICompatibleResponse {
  readonly choices?: ReadonlyArray<{
    readonly message?: {
      readonly content?: string;
    };
  }>;
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
    readonly total_tokens?: number;
    readonly [key: string]: unknown;
  };
  readonly [key: string]: unknown;
}

function normalizeTokenUsage(usage: OpenAICompatibleResponse["usage"]): TokenUsage | undefined {
  if (!usage) return undefined;
  const promptTokens = usage.prompt_tokens ?? 0;
  const completionTokens = usage.completion_tokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: usage.total_tokens ?? promptTokens + completionTokens,
  };
}

const CACHE_HIT_FIELDS = [
  "prompt_cache_hit_tokens",
  "cached_tokens",
  "cache_hit_tokens",
  "input_cache_hit_tokens",
] as const;

const CACHE_MISS_FIELDS = [
  "prompt_cache_miss_tokens",
  "cache_miss_tokens",
  "input_cache_miss_tokens",
] as const;

function normalizeCacheMetrics(provider: string, response: OpenAICompatibleResponse): CacheMetrics {
  const candidates = collectCacheMetadata(response);
  const hitTokens = firstNumericField(candidates, CACHE_HIT_FIELDS);
  const missTokens = firstNumericField(candidates, CACHE_MISS_FIELDS);
  const cacheMetricsAvailable = hitTokens !== null || missTokens !== null;
  return {
    provider: provider.toLowerCase(),
    promptCacheHitTokens: hitTokens,
    promptCacheMissTokens: missTokens,
    cacheHitRatio: hitTokens !== null && missTokens !== null && hitTokens + missTokens > 0
      ? Number((hitTokens / (hitTokens + missTokens)).toFixed(6))
      : null,
    rawCacheMetadata: cacheMetricsAvailable ? candidates : null,
    cacheMetricsAvailable,
  };
}

function collectCacheMetadata(response: OpenAICompatibleResponse): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  collectCacheMetadataInto(result, "usage", response.usage);
  collectCacheMetadataInto(result, "response", response);
  return result;
}

function collectCacheMetadataInto(target: Record<string, unknown>, prefix: string, value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  for (const [key, entry] of Object.entries(value)) {
    if (isCacheMetricField(key) && isMetricPrimitive(entry)) {
      target[`${prefix}.${key}`] = entry;
    }
    if (typeof entry === "object" && entry !== null) {
      collectCacheMetadataInto(target, `${prefix}.${key}`, entry);
    }
  }
}

function firstNumericField(candidates: Record<string, unknown>, names: readonly string[]): number | null {
  for (const name of names) {
    for (const [key, value] of Object.entries(candidates)) {
      if (key.endsWith(`.${name}`) && typeof value === "number" && Number.isFinite(value)) {
        return value;
      }
    }
  }
  return null;
}

function isCacheMetricField(key: string): boolean {
  return (CACHE_HIT_FIELDS as readonly string[]).includes(key) || (CACHE_MISS_FIELDS as readonly string[]).includes(key);
}

function isMetricPrimitive(value: unknown): boolean {
  return typeof value === "number" || typeof value === "string" || typeof value === "boolean";
}

function completionEndpoint(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/u, "");
  return normalized.endsWith("/v1") ? `${normalized}/chat/completions` : `${normalized}/v1/chat/completions`;
}

function defaultBaseUrl(provider: string): string | undefined {
  return provider.toLowerCase() === "deepseek" ? "https://api.deepseek.com" : undefined;
}

function writeDraftReport(
  report: FastDraftReport,
  asJson: boolean,
  stdout: Pick<NodeJS.WriteStream, "write">,
  stderr: Pick<NodeJS.WriteStream, "write">,
): void {
  if (asJson) {
    stdout.write(`${JSON.stringify(toJsonReport(report), null, 2)}\n`);
    return;
  }
  const target = report.passed ? stdout : stderr;
  target.write(report.passed ? "Fast draft completed.\n" : "Fast draft failed.\n");
  target.write(`Chapter: ${report.chapter}\n`);
  if (report.draftPath) target.write(`Draft: ${report.draftPath}\n`);
  if (report.title) target.write(`Title: ${report.title}\n`);
  if (report.issues.length > 0) {
    target.write(`Issues:\n${report.issues.map((issue) => `- ${issue}`).join("\n")}\n`);
  }
}

function writeModelSettingsReport(
  report: ModelSettingsLoadResult,
  asJson: boolean,
  stdout: Pick<NodeJS.WriteStream, "write">,
  stderr: Pick<NodeJS.WriteStream, "write">,
): void {
  if (asJson) {
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  const target = report.passed ? stdout : stderr;
  target.write(report.passed ? "Model settings inspected.\n" : "Model settings validation failed.\n");
  target.write(`Status: ${report.status}\n`);
  target.write(`Config: ${report.configPath}\n`);
  target.write(`Providers: ${report.summary.providers.length}\n`);
  target.write(`Profiles: ${report.summary.profiles.length}\n`);
  if (report.summary.providers.length > 0) {
    target.write("API keys:\n");
    for (const provider of report.summary.providers) {
      target.write(`- ${provider.id}: ${provider.apiKeyEnv ?? "none"} = ${provider.apiKeyStatus}\n`);
    }
  }
  if (report.issues.length > 0) {
    target.write(`Issues:\n${report.issues.map((item) => `- [${item.severity}] ${item.path}: ${item.message}`).join("\n")}\n`);
  }
}

function writeCommitPreviewReport(
  report: CommitPlanPreviewReport,
  asJson: boolean,
  stdout: Pick<NodeJS.WriteStream, "write">,
  stderr: Pick<NodeJS.WriteStream, "write">,
): void {
  if (asJson) {
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  const target = report.passed ? stdout : stderr;
  target.write(report.passed ? "Commit plan preview completed.\n" : "Commit plan preview failed.\n");
  target.write(`Chapter: ${report.chapter}\n`);
  if (report.passed) {
    target.write(`Character updates: ${report.summary.characterUpdates}\n`);
    target.write(`Timeline events: ${report.summary.timelineEvents}\n`);
    target.write(`World updates: ${report.summary.worldUpdates ? "yes" : "no"}\n`);
    target.write(`Hook updates: ${report.summary.hookUpdates}\n`);
    target.write(`Calendar update: ${report.summary.calendarUpdate ? "yes" : "no"}\n`);
  }
  if (report.issues.length > 0) {
    target.write(`Issues:\n${report.issues.map((issue) => `- ${issue}`).join("\n")}\n`);
  }
}

function writeCommitReport(
  report: CommitReport,
  asJson: boolean,
  stdout: Pick<NodeJS.WriteStream, "write">,
  stderr: Pick<NodeJS.WriteStream, "write">,
): void {
  if (asJson) {
    stdout.write(`${JSON.stringify(toJsonReport(report), null, 2)}\n`);
    return;
  }
  const target = report.passed ? stdout : stderr;
  target.write(report.passed ? "Fast draft committed.\n" : "Fast draft commit failed.\n");
  target.write(`Chapter: ${report.chapter}\n`);
  if (report.chapterPath) target.write(`Chapter file: ${report.chapterPath}\n`);
  if (report.updatedCharacters.length > 0) {
    target.write(`Characters: ${report.updatedCharacters.join(", ")}\n`);
  }
  if (report.timelineEventIds.length > 0) {
    target.write(`Timeline events: ${report.timelineEventIds.join(", ")}\n`);
  }
  if (report.updatedHooks.length > 0) {
    target.write(`Hooks: ${report.updatedHooks.join(", ")}\n`);
  }
  if (report.issues.length > 0) {
    target.write(`Issues:\n${report.issues.map((issue) => `- ${issue}`).join("\n")}\n`);
  }
}

function writeStateOverviewReport(
  report: StateOverviewCommandReport,
  asJson: boolean,
  stdout: Pick<NodeJS.WriteStream, "write">,
): void {
  if (asJson) {
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  stdout.write("State overview completed.\n");
  if (report.reportPath) stdout.write(`Report: ${report.reportPath}\n`);
  stdout.write(`Project: ${report.project.title}\n`);
  stdout.write(`Genre: ${report.project.genre}\n`);
  stdout.write(`Current chapter: ${report.project.currentChapter ?? "unknown"}\n`);
  stdout.write(`Hooks active/touched/resolved: ${report.hooks.activeCount}/${report.hooks.touchedCount}/${report.hooks.resolvedCount}\n`);
  stdout.write(`Threads open/touched/done: ${report.threads.open}/${report.threads.touched}/${report.threads.done}\n`);
  stdout.write(`Arc goals active/touched/completed: ${report.arcGoals.activeCount}/${report.arcGoals.touchedCount}/${report.arcGoals.completedCount}\n`);
  stdout.write(`Cleanup-visible intents: ${report.maintenance.cleanupVisibleCount}\n`);
  stdout.write(`Confirm policy: mark_done=${report.maintenance.confirmPolicy.markDone}, merge=${report.maintenance.confirmPolicy.merge}, drop=${report.maintenance.confirmPolicy.drop}\n`);
}

function writeChapterSteeringReport(
  report: ChapterSteeringCommandReport,
  asJson: boolean,
  stdout: Pick<NodeJS.WriteStream, "write">,
): void {
  if (asJson) {
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  stdout.write("Chapter steering draft completed.\n");
  if (report.reportPath) stdout.write(`Report: ${report.reportPath}\n`);
  stdout.write(`Chapter: ${report.chapter ?? "unknown"}\n`);
  stdout.write(`Direction: ${report.userDirection}\n`);
  stdout.write(`Suggestions: ${report.suggestions.length}\n`);
  stdout.write(`Writes state: ${report.safety.writesState ? "yes" : "no"}\n`);
  stdout.write(`Preview: ${report.generatedChapterGoalPreview}\n`);
}

function parseChapter(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError("--chapter must be a positive integer");
  }
  return parsed;
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError("value must be a positive integer");
  }
  return parsed;
}

function parsePacing(value: string): ChapterSteeringPacing {
  if (value === "slow" || value === "medium" || value === "fast") {
    return value;
  }
  throw new InvalidArgumentError("--pacing must be slow, medium, or fast");
}

function parseRevealLevel(value: string): ChapterSteeringRevealLevel {
  if (value === "none" || value === "small" || value === "large") {
    return value;
  }
  throw new InvalidArgumentError("--reveal-level must be none, small, or large");
}

function collectValues(value: string, previous: readonly string[]): readonly string[] {
  return [...previous, value];
}

function toJsonReport<T extends { readonly diagnostics?: unknown }>(report: T): T {
  return report.diagnostics === undefined ? report : { ...report, diagnostics: report.diagnostics };
}

function requireChapter(chapter: number | undefined): number {
  if (chapter === undefined) {
    throw new InvalidArgumentError("--chapter is required");
  }
  return chapter;
}

function requireText(value: string | undefined, flagName: string): string {
  if (!value || !value.trim()) {
    throw new InvalidArgumentError(`${flagName} is required when --no-dry-run is used`);
  }
  return value.trim();
}

function requirePlainText(value: string | undefined, flagName: string): string {
  if (!value || !value.trim()) {
    throw new InvalidArgumentError(`${flagName} is required`);
  }
  return value.trim();
}

function resolveRequiredPath(value: string | undefined, flagName: string): string {
  if (!value || !value.trim()) {
    throw new InvalidArgumentError(`${flagName} is required`);
  }
  return resolve(value);
}

function padChapter(chapter: number): string {
  return String(Math.max(0, Math.trunc(chapter))).padStart(4, "0");
}

async function writeStateOverviewReportFile(
  projectDir: string,
  report: StateOverview,
  chapter: number | undefined,
): Promise<string> {
  const reportsDir = join(projectDir, "reports");
  await mkdir(reportsDir, { recursive: true });
  const suffix = chapter === undefined ? "latest" : padChapter(chapter);
  const reportPath = join(reportsDir, `state-overview-${suffix}.json`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  return reportPath;
}

async function writeChapterSteeringReportFile(
  projectDir: string,
  report: ChapterSteeringDraft,
  chapter: number | undefined,
): Promise<string> {
  const reportsDir = join(projectDir, "reports");
  await mkdir(reportsDir, { recursive: true });
  const suffix = chapter === undefined ? "latest" : padChapter(chapter);
  const reportPath = join(reportsDir, `chapter-steering-${suffix}.json`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  return reportPath;
}
