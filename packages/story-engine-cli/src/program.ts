import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import { Command, InvalidArgumentError } from "commander";
import {
  applyReviewPlan,
  analyzeIntentLifecycle,
  buildAIReviewInput,
  buildAIReviewerPromptContract,
  buildChapterSteeringDraft,
  buildCommitPlanFromProject,
  buildReviewPlan,
  buildStateOverview,
  checkCommitPlanSemanticQuality,
  checkDraftBeforeCommit,
  commitFastDraft,
  inspectStoryEngineTransactionResidue,
  loadModelSettingsV0,
  readThreadPool,
  renderFastDraftPromptText,
  runAIReviewerWithProvider,
  runFastDraft,
  type AIReviewReport,
  type AIReviewScope,
  type AIReviewActionabilitySummary,
  type AIReviewerProviderMetadata,
  type AIReviewerPromptContract,
  type ChapterSteeringDraft,
  type ChapterSteeringPacing,
  type ChapterSteeringRevealLevel,
  type RunAIReviewerWithProviderOptions,
  type StateOverview,
  type MaintenanceCandidateDiagnostics,
  type MaintenanceCandidateReviewPlanStage,
  type ModelSettingsLoadResult,
  type AIReviewThreadSelectionSummary,
  type AIReviewIntentDiagnosticsVisibilitySummary,
  type ApplyReviewPlanResult,
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
  type FilteredAlreadyDoneAction,
  type IntentLifecycleDiagnosticsReport,
  type ReviewPlan,
  type TransactionResidueReport,
  type TokenUsage,
  type WriterContextEnvelope,
  type WriterClient,
} from "@actalk/story-engine";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };
const REVIEW_PLAN_APPLY_CONFIRM_ENV = "STORY_ENGINE_ENABLE_REVIEW_PLAN_APPLY_CONFIRM";

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

export interface ReviewOptions {
  readonly project?: string;
  readonly chapter?: number;
  readonly scope?: AIReviewScope;
  readonly mock?: boolean;
  readonly provider?: string;
  readonly fallbackToMock?: boolean;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly strictJson?: boolean;
  readonly json?: boolean;
}

export type AIReviewCommandReport = AIReviewReport & {
  readonly reportPath?: string;
};

export interface ReviewPromptOptions {
  readonly project?: string;
  readonly chapter?: number;
  readonly scope?: AIReviewScope;
  readonly includeExamples?: boolean;
  readonly tokenBudget?: number;
  readonly json?: boolean;
}

export type ReviewPromptCommandReport = AIReviewerPromptContract & {
  readonly reportPath?: string;
};

export interface ReviewPlanOptions {
  readonly project?: string;
  readonly report?: string;
  readonly chapter?: number;
  readonly json?: boolean;
}

export type ReviewPlanCommandReport = ReviewPlan & {
  readonly reportPath?: string;
  readonly recommendedActionSummary: MaintenanceRecommendedActionSummary;
  readonly noRecommendedActionReason?: MaintenanceNoRecommendedActionReason;
  readonly alreadyDoneGuardSummary: MaintenanceAlreadyDoneGuardSummary;
  readonly mergeDropPreviewSummary: MaintenanceMergeDropPreviewSummary;
  readonly reviewPlanStage: MaintenanceCandidateReviewPlanStage;
  readonly candidateDiagnostics?: MaintenanceCandidateDiagnostics;
};

export interface ApplyReviewPlanOptions {
  readonly project?: string;
  readonly plan?: string;
  readonly action?: readonly string[];
  readonly confirm?: boolean;
  readonly dryRun?: boolean;
  readonly json?: boolean;
}

export type ApplyReviewPlanCommandReport = ApplyReviewPlanResult & {
  readonly reportPath?: string;
};

export interface MaintenanceRunOptions {
  readonly project?: string;
  readonly chapter?: number;
  readonly scope?: AIReviewScope;
  readonly mock?: boolean;
  readonly provider?: string;
  readonly fallbackToMock?: boolean;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly strictJson?: boolean;
  readonly applyDryRun?: boolean;
  readonly action?: readonly string[];
  readonly save?: boolean;
  readonly json?: boolean;
}

export interface IntentLifecycleDiagnosticsOptions {
  readonly project?: string;
  readonly chapter?: number;
  readonly sampleLimit?: number;
  readonly save?: boolean;
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

export type IntentLifecycleDiagnosticsCommandReport = IntentLifecycleDiagnosticsReport & {
  readonly reportPath?: string;
};

export type StateOverviewCommandReport = StateOverview & {
  readonly reportPath?: string;
};

export type ChapterSteeringCommandReport = ChapterSteeringDraft & {
  readonly reportPath?: string;
};

export interface MaintenanceActionBreakdown {
  readonly mark_thread_done: number;
  readonly merge_threads: number;
  readonly drop_thread: number;
  readonly prioritize_thread: number;
  readonly prioritize_hook: number;
  readonly prioritize_arc_goal: number;
  readonly create_repair_plan: number;
  readonly no_action: number;
}

export interface MaintenanceRunReport {
  readonly passed: boolean;
  readonly chapter?: number;
  readonly scope: AIReviewScope;
  readonly reviewReportPath?: string;
  readonly reviewPlanPath?: string;
  readonly applyDryRunReportPath?: string;
  readonly maintenanceReportPath?: string;
  readonly reviewSummary: string;
  readonly issueCount: number;
  readonly suggestionCount: number;
  readonly actionCount: number;
  readonly applicableActionCount: number;
  readonly skippedActionCount: number;
  readonly appliedDryRunCount: number;
  readonly actionBreakdown: MaintenanceActionBreakdown;
  readonly applyDryRunBreakdown: Pick<MaintenanceActionBreakdown, "mark_thread_done" | "merge_threads" | "drop_thread">;
  readonly recommendedActionSummary: MaintenanceRecommendedActionSummary;
  readonly noRecommendedActionReason?: MaintenanceNoRecommendedActionReason;
  readonly alreadyDoneGuardSummary: MaintenanceAlreadyDoneGuardSummary;
  readonly recommendedActionIds: readonly string[];
  readonly riskyActionIds: readonly string[];
  readonly mergeDropPreviewSummary: MaintenanceMergeDropPreviewSummary;
  readonly reviewInputThreadSelection?: AIReviewThreadSelectionSummary;
  readonly actionabilitySummary?: AIReviewActionabilitySummary;
  readonly reviewProvider?: AIReviewerProviderMetadata;
  readonly candidateDiagnostics?: MaintenanceCandidateDiagnostics;
  readonly intentDiagnosticsVisibility?: AIReviewIntentDiagnosticsVisibilitySummary;
  readonly wouldModifyState: false;
  readonly transactionResidue: TransactionResidueReport;
  readonly summary: string;
}

export interface MaintenanceRecommendedActionSummary {
  readonly totalRecommended: number;
  readonly byAction: Pick<MaintenanceActionBreakdown, "mark_thread_done" | "merge_threads" | "drop_thread">;
  readonly byRisk: {
    readonly safe: number;
    readonly caution: number;
    readonly risky: number;
  };
  readonly byConfirmationMode: {
    readonly recommended_confirm: number;
    readonly manual_review: number;
    readonly do_not_confirm: number;
  };
  readonly deepseekDropCount: number;
  readonly deepseekDropRecommendedCount: number;
  readonly deepseekDropManualReviewCount: number;
  readonly deepseekDropRiskyCount: number;
}

export interface MaintenanceNoRecommendedActionReason {
  readonly reason: string;
  readonly actionCount: number;
  readonly executableActionCount: number;
  readonly recommendedActionCount: number;
  readonly manualReviewCount: number;
  readonly riskyCount: number;
  readonly prioritizeOnly: boolean;
  readonly filteredAlreadyDoneCount: number;
  readonly details: readonly string[];
}

export interface MaintenanceAlreadyDoneGuardSummary {
  readonly filteredCount: number;
  readonly filteredActionIds: readonly string[];
  readonly filteredTargetIds: readonly string[];
}

export interface MaintenanceMergeDropPreviewSummary {
  readonly mergePreviewCount: number;
  readonly safeMergeCount: number;
  readonly cautionMergeCount: number;
  readonly riskyMergeCount: number;
  readonly dropPreviewCount: number;
  readonly safeDropCount: number;
  readonly cautionDropCount: number;
  readonly riskyDropCount: number;
}

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
    .command("review")
    .description("Review structured StoryEngine state and emit advisory suggestions without modifying story state")
    .requiredOption("--project <path>", "StoryEngine project directory")
    .option("--chapter <number>", "Chapter number for a chapter/window review", parseChapter)
    .option("--scope <scope>", "Review scope: chapter, window, or arc", parseReviewScope, "window")
    .option("--mock", "Use the deterministic mock reviewer")
    .option("--provider <id>", "AI reviewer provider id")
    .option("--fallback-to-mock", "Use the deterministic mock reviewer if the selected provider fails")
    .option("--timeout-ms <number>", "AI reviewer provider timeout in milliseconds", parsePositiveInteger)
    .option("--max-retries <number>", "AI reviewer provider retry count", parseNonNegativeInteger)
    .option("--strict-json", "Require provider output to pass strict JSON schema validation")
    .option("--json", "Print a machine-readable JSON report")
    .action(async (options: ReviewOptions) => {
      await runReviewCommand(options, hooks);
    });

  program
    .command("review-prompt")
    .description("Build a structured AI reviewer prompt contract without calling a model or modifying story state")
    .requiredOption("--project <path>", "StoryEngine project directory")
    .option("--chapter <number>", "Chapter number for a chapter/window prompt", parseChapter)
    .option("--scope <scope>", "Review scope: chapter, window, or arc", parseReviewScope, "window")
    .option("--include-examples", "Include short output examples in the prompt contract")
    .option("--token-budget <number>", "Prompt token budget summary", parsePositiveInteger)
    .option("--json", "Print a machine-readable JSON prompt contract")
    .action(async (options: ReviewPromptOptions) => {
      await runReviewPromptCommand(options, hooks);
    });

  program
    .command("review-plan")
    .description("Convert an AI review report into an advisory action preview without modifying story state")
    .requiredOption("--project <path>", "StoryEngine project directory")
    .requiredOption("--report <path>", "AIReviewReport JSON path")
    .option("--chapter <number>", "Chapter number for report naming", parseChapter)
    .option("--json", "Print a machine-readable JSON plan")
    .action(async (options: ReviewPlanOptions) => {
      await runReviewPlanCommand(options, hooks);
    });

  program
    .command("apply-review-plan")
    .description("Preview ReviewPlan thread actions; confirmed writes are experimental/manual-only")
    .requiredOption("--project <path>", "StoryEngine project directory")
    .requiredOption("--plan <path>", "ReviewPlan JSON path")
    .option("--action <id>", "Apply only this ReviewPlan action id; repeatable", collectValues, [])
    .option("--confirm", `Experimental/manual-only: mutate story/threads.json only when ${REVIEW_PLAN_APPLY_CONFIRM_ENV}=1`)
    .option("--dry-run", "Preview applicable actions without mutating story state")
    .option("--json", "Print a machine-readable JSON result")
    .action(async (options: ApplyReviewPlanOptions) => {
      await runApplyReviewPlanCommand(options, hooks);
    });

  program
    .command("maintenance-run")
    .description("Run mock review, review-plan, and apply dry-run reports without modifying story state")
    .requiredOption("--project <path>", "StoryEngine project directory")
    .option("--chapter <number>", "Chapter number for the maintenance window", parseChapter)
    .option("--scope <scope>", "Maintenance scope: chapter, window, or arc", parseReviewScope, "window")
    .option("--mock", "Use the deterministic mock reviewer")
    .option("--provider <id>", "AI reviewer provider id")
    .option("--fallback-to-mock", "Use the deterministic mock reviewer if the selected provider fails")
    .option("--timeout-ms <number>", "AI reviewer provider timeout in milliseconds", parsePositiveInteger)
    .option("--max-retries <number>", "AI reviewer provider retry count", parseNonNegativeInteger)
    .option("--strict-json", "Require provider output to pass strict JSON schema validation")
    .option("--apply-dry-run", "Run apply-review-plan in dry-run mode", true)
    .option("--no-apply-dry-run", "Skip the apply-review-plan dry-run step")
    .option("--action <id>", "Pass a selected ReviewPlan action id to apply dry-run; repeatable", collectValues, [])
    .option("--save", "Write maintenance reports", true)
    .option("--no-save", "Do not write maintenance reports")
    .option("--json", "Print a machine-readable JSON maintenance report")
    .action(async (options: MaintenanceRunOptions) => {
      await runMaintenanceRunCommand(options, hooks);
    });

  program
    .command("intent-lifecycle-diagnostics")
    .description("Classify ThreadPool intent value, type, TTL, and lifecycle suggestions without modifying story state")
    .requiredOption("--project <path>", "StoryEngine project directory")
    .option("--chapter <number>", "Current chapter for intent age calculation", parseChapter)
    .option("--sample-limit <number>", "Maximum low/high sample rows", parsePositiveInteger)
    .option("--save", "Write diagnostics report", true)
    .option("--no-save", "Do not write diagnostics report")
    .option("--json", "Print a machine-readable JSON diagnostics report")
    .action(async (options: IntentLifecycleDiagnosticsOptions) => {
      await runIntentLifecycleDiagnosticsCommand(options, hooks);
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

export async function runReviewCommand(
  options: ReviewOptions,
  hooks: ProgramHooks = {},
): Promise<AIReviewCommandReport> {
  const projectDir = resolveRequiredPath(options.project, "--project");
  const scope = options.scope ?? "window";
  const input = await buildAIReviewInput(projectDir, {
    scope,
    chapter: options.chapter,
  });
  const providerResult = await runAIReviewerWithProvider(input, providerOptionsFromReviewOptions(options));
  const report = providerResult.report;
  const reportPath = report.passed ? await writeAIReviewReportFile(projectDir, report, options.chapter) : undefined;
  const commandReport = { ...report, ...(reportPath ? { reportPath } : {}) };

  writeReviewReport(commandReport, options.json === true, hooks.stdout ?? process.stdout, hooks.stderr ?? process.stderr);
  if (!commandReport.passed) {
    process.exitCode = 1;
  }
  return commandReport;
}

export async function runReviewPromptCommand(
  options: ReviewPromptOptions,
  hooks: ProgramHooks = {},
): Promise<ReviewPromptCommandReport> {
  const projectDir = resolveRequiredPath(options.project, "--project");
  const scope = options.scope ?? "window";
  const input = await buildAIReviewInput(projectDir, {
    scope,
    chapter: options.chapter,
    tokenBudget: options.tokenBudget,
  });
  const contract = buildAIReviewerPromptContract(input, {
    tokenBudget: options.tokenBudget,
    includeExamples: options.includeExamples === true,
  });
  const reportPath = await writeAIReviewPromptContractFile(projectDir, contract, scope, options.chapter);
  const commandReport = { ...contract, reportPath };

  writeReviewPromptReport(commandReport, options.json === true, hooks.stdout ?? process.stdout);
  return commandReport;
}

export async function runReviewPlanCommand(
  options: ReviewPlanOptions,
  hooks: ProgramHooks = {},
): Promise<ReviewPlanCommandReport> {
  const projectDir = resolveRequiredPath(options.project, "--project");
  const sourceReportPath = resolveRequiredPath(options.report, "--report");
  const report = JSON.parse(await readFile(sourceReportPath, "utf-8")) as AIReviewReport;
  const plan = await buildReviewPlan({
    projectDir,
    report,
    sourceReportPath,
    chapter: options.chapter,
  });
  const filteredAlreadyDoneActions = plan.filteredAlreadyDoneActions ?? [];
  const recommendedActionSummary = countRecommendedActionSummary(plan.actions, filteredAlreadyDoneActions);
  const alreadyDoneGuardSummary = countAlreadyDoneGuardSummary(filteredAlreadyDoneActions);
  const recommendedActionIds = recommendedActionIdsFromActions(plan.actions, filteredAlreadyDoneActions);
  const riskyActionIds = riskyActionIdsFromActions(plan.actions);
  const reviewPlanStage = buildReviewPlanStage(plan.actions, recommendedActionIds, riskyActionIds, filteredAlreadyDoneActions);
  const commandReport = {
    ...plan,
    recommendedActionSummary,
    alreadyDoneGuardSummary,
    mergeDropPreviewSummary: countMergeDropPreviewSummary(plan.actions),
    reviewPlanStage,
    ...(report.candidateDiagnostics
      ? { candidateDiagnostics: withReviewPlanStage(report.candidateDiagnostics, reviewPlanStage) }
      : {}),
  };
  const reportPath = await writeReviewPlanReportFile(projectDir, commandReport, options.chapter);
  const commandReportWithPath = { ...commandReport, reportPath };

  writeReviewPlanReport(commandReportWithPath, options.json === true, hooks.stdout ?? process.stdout);
  return commandReportWithPath;
}

export async function runApplyReviewPlanCommand(
  options: ApplyReviewPlanOptions,
  hooks: ProgramHooks = {},
): Promise<ApplyReviewPlanCommandReport> {
  const projectDir = resolveRequiredPath(options.project, "--project");
  const planPath = resolveRequiredPath(options.plan, "--plan");
  const plan = JSON.parse(await readFile(planPath, "utf-8")) as ReviewPlan;
  const confirmEnabled = (hooks.env ?? process.env)[REVIEW_PLAN_APPLY_CONFIRM_ENV] === "1";
  const forceDryRun = options.confirm === true && options.dryRun !== true && !confirmEnabled;
  if (forceDryRun && options.json !== true) {
    (hooks.stderr ?? process.stderr).write(`apply-review-plan --confirm is experimental/manual-only; set ${REVIEW_PLAN_APPLY_CONFIRM_ENV}=1 to mutate story/threads.json. Running dry-run only.\n`);
  }
  const result = await applyReviewPlan({
    projectDir,
    plan,
    actionIds: options.action,
    confirm: options.confirm === true && !forceDryRun,
    dryRun: options.dryRun === true || forceDryRun,
  });
  const reportPath = await writeApplyReviewPlanReportFile(projectDir, result, plan.chapter);
  const commandReport = { ...result, reportPath };

  writeApplyReviewPlanReport(commandReport, options.json === true, hooks.stdout ?? process.stdout, hooks.stderr ?? process.stderr);
  if (!commandReport.passed) {
    process.exitCode = 1;
  }
  return commandReport;
}

export async function runMaintenanceRunCommand(
  options: MaintenanceRunOptions,
  hooks: ProgramHooks = {},
): Promise<MaintenanceRunReport> {
  const projectDir = resolveRequiredPath(options.project, "--project");
  const scope = options.scope ?? "window";
  const save = options.save !== false;
  const applyDryRunEnabled = options.applyDryRun !== false;
  const stdout = hooks.stdout ?? process.stdout;
  const stderr = hooks.stderr ?? process.stderr;

  const input = await buildAIReviewInput(projectDir, {
    scope,
    chapter: options.chapter,
  });
  const providerResult = await runAIReviewerWithProvider(input, providerOptionsFromMaintenanceOptions(options));
  const reviewReport = providerResult.report;
  if (!reviewReport.passed) {
    const transactionResidue = await inspectStoryEngineTransactionResidue(projectDir);
    const failed: MaintenanceRunReport = {
      passed: false,
      ...(options.chapter !== undefined ? { chapter: options.chapter } : {}),
      scope,
      reviewSummary: reviewReport.summary,
      issueCount: reviewReport.issues.length,
      suggestionCount: reviewReport.suggestions.length,
      actionCount: 0,
      applicableActionCount: 0,
      skippedActionCount: 0,
      appliedDryRunCount: 0,
      actionBreakdown: emptyMaintenanceActionBreakdown(),
      applyDryRunBreakdown: emptyApplyDryRunBreakdown(),
      recommendedActionSummary: emptyRecommendedActionSummary(),
      alreadyDoneGuardSummary: emptyAlreadyDoneGuardSummary(),
      recommendedActionIds: [],
      riskyActionIds: [],
      mergeDropPreviewSummary: emptyMergeDropPreviewSummary(),
      ...(reviewReport.provider ? { reviewProvider: reviewReport.provider } : {}),
      wouldModifyState: false,
      transactionResidue,
      summary: reviewReport.summary,
    };
    writeMaintenanceRunReport(failed, options.json === true, stdout, stderr);
    process.exitCode = 1;
    return failed;
  }
  const reviewReportPath = save ? await writeAIReviewReportFile(projectDir, reviewReport, options.chapter) : undefined;
  const reviewPlan = await buildReviewPlan({
    projectDir,
    report: reviewReport,
    ...(reviewReportPath ? { sourceReportPath: reviewReportPath } : {}),
    chapter: options.chapter,
  });
  const applyDryRunResult = applyDryRunEnabled
    ? await applyReviewPlan({
      projectDir,
      plan: reviewPlan,
      actionIds: options.action,
      confirm: false,
      dryRun: true,
    })
    : undefined;
  const applyDryRunReportPath = save && applyDryRunResult
    ? await writeMaintenanceApplyDryRunReportFile(projectDir, applyDryRunResult, reviewPlan.scope, options.chapter)
    : undefined;
  const transactionResidue = await inspectStoryEngineTransactionResidue(projectDir);
  const actionBreakdown = countMaintenanceActionBreakdown(reviewPlan.actions);
  const applyDryRunBreakdown = countApplyDryRunBreakdown(applyDryRunResult?.appliedActions ?? []);
  const filteredAlreadyDoneActions = reviewPlan.filteredAlreadyDoneActions ?? [];
  const recommendedActionSummary = countRecommendedActionSummary(reviewPlan.actions, filteredAlreadyDoneActions);
  const alreadyDoneGuardSummary = countAlreadyDoneGuardSummary(filteredAlreadyDoneActions);
  const recommendedActionIds = recommendedActionIdsFromActions(reviewPlan.actions, filteredAlreadyDoneActions);
  const riskyActionIds = riskyActionIdsFromActions(reviewPlan.actions);
  const mergeDropPreviewSummary = countMergeDropPreviewSummary(reviewPlan.actions);
  const reviewPlanStage = buildReviewPlanStage(reviewPlan.actions, recommendedActionIds, riskyActionIds, filteredAlreadyDoneActions);
  const noRecommendedActionReason = recommendedActionIds.length === 0
    ? explainNoRecommendedActions(reviewPlan.actions, filteredAlreadyDoneActions)
    : undefined;
  const candidateDiagnostics = reviewReport.candidateDiagnostics
    ? withReviewPlanStage(reviewReport.candidateDiagnostics, reviewPlanStage)
    : undefined;
  const intentDiagnosticsVisibility = candidateDiagnostics?.intentDiagnostics;
  const reviewPlanReport = {
    ...reviewPlan,
    recommendedActionSummary,
    ...(noRecommendedActionReason ? { noRecommendedActionReason } : {}),
    alreadyDoneGuardSummary,
    mergeDropPreviewSummary,
    reviewPlanStage,
    ...(candidateDiagnostics ? { candidateDiagnostics } : {}),
  };
  const reviewPlanPath = save ? await writeReviewPlanReportFile(projectDir, reviewPlanReport, options.chapter) : undefined;

  const reportWithoutPath: MaintenanceRunReport = {
    passed: true,
    ...(options.chapter !== undefined ? { chapter: options.chapter } : {}),
    scope,
    ...(reviewReportPath ? { reviewReportPath } : {}),
    ...(reviewPlanPath ? { reviewPlanPath } : {}),
    ...(applyDryRunReportPath ? { applyDryRunReportPath } : {}),
    reviewSummary: reviewReport.summary,
    issueCount: reviewReport.issues.length,
    suggestionCount: reviewReport.suggestions.length,
    actionCount: reviewPlan.actions.length,
    applicableActionCount: applyDryRunResult?.appliedActions.length ?? 0,
    skippedActionCount: applyDryRunResult?.skippedActions.length ?? 0,
    appliedDryRunCount: applyDryRunResult?.appliedActions.length ?? 0,
    actionBreakdown,
    applyDryRunBreakdown,
    recommendedActionSummary,
    ...(noRecommendedActionReason ? { noRecommendedActionReason } : {}),
    alreadyDoneGuardSummary,
    recommendedActionIds,
    riskyActionIds,
    mergeDropPreviewSummary,
    ...(input.threadPool.selection ? { reviewInputThreadSelection: input.threadPool.selection } : {}),
    ...(reviewReport.actionabilitySummary ? { actionabilitySummary: reviewReport.actionabilitySummary } : {}),
    ...(reviewReport.provider ? { reviewProvider: reviewReport.provider } : {}),
    ...(candidateDiagnostics ? { candidateDiagnostics } : {}),
    ...(intentDiagnosticsVisibility ? { intentDiagnosticsVisibility } : {}),
    wouldModifyState: false,
    transactionResidue,
    summary: applyDryRunEnabled
      ? `Maintenance run prepared ${reviewPlan.actions.length} action preview${reviewPlan.actions.length === 1 ? "" : "s"} and dry-ran ${applyDryRunResult?.appliedActions.length ?? 0}. No story state was modified.`
      : `Maintenance run prepared ${reviewPlan.actions.length} action preview${reviewPlan.actions.length === 1 ? "" : "s"}. Apply dry-run was skipped and no story state was modified.`,
  };
  const maintenanceReportPath = save
    ? await writeMaintenanceRunReportFile(projectDir, reportWithoutPath, scope, options.chapter)
    : undefined;
  const report = maintenanceReportPath ? { ...reportWithoutPath, maintenanceReportPath } : reportWithoutPath;

  writeMaintenanceRunReport(report, options.json === true, stdout, stderr);
  return report;
}

export async function runIntentLifecycleDiagnosticsCommand(
  options: IntentLifecycleDiagnosticsOptions,
  hooks: ProgramHooks = {},
): Promise<IntentLifecycleDiagnosticsCommandReport> {
  const projectDir = resolveRequiredPath(options.project, "--project");
  const threadPool = await readThreadPool(projectDir);
  const diagnostics = analyzeIntentLifecycle(threadPool, {
    ...(options.chapter !== undefined ? { currentChapter: options.chapter } : {}),
    ...(options.sampleLimit !== undefined ? { sampleLimit: options.sampleLimit } : {}),
  });
  const reportPath = options.save === false
    ? undefined
    : await writeIntentLifecycleDiagnosticsReportFile(projectDir, diagnostics, options.chapter);
  const report = reportPath ? { ...diagnostics, reportPath } : diagnostics;

  writeIntentLifecycleDiagnosticsReport(report, options.json === true, hooks.stdout ?? process.stdout);
  return report;
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

function writeReviewReport(
  report: AIReviewCommandReport,
  asJson: boolean,
  stdout: Pick<NodeJS.WriteStream, "write">,
  stderr: Pick<NodeJS.WriteStream, "write">,
): void {
  if (asJson) {
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  const target = report.passed ? stdout : stderr;
  target.write(report.passed ? "AI review completed.\n" : "AI review failed.\n");
  target.write(`Scope: ${report.scope}\n`);
  if (report.reportPath) target.write(`Report: ${report.reportPath}\n`);
  target.write(`Issues: ${report.issues.length}\n`);
  target.write(`Suggestions: ${report.suggestions.length}\n`);
  target.write(`${report.summary}\n`);
}

function writeReviewPromptReport(
  report: ReviewPromptCommandReport,
  asJson: boolean,
  stdout: Pick<NodeJS.WriteStream, "write">,
): void {
  if (asJson) {
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  stdout.write("AI reviewer prompt contract completed.\n");
  stdout.write(`Version: ${report.version}\n`);
  stdout.write(`Scope: ${report.inputSummary.scope}\n`);
  if (report.inputSummary.chapter !== undefined) stdout.write(`Chapter: ${report.inputSummary.chapter}\n`);
  if (report.reportPath) stdout.write(`Report: ${report.reportPath}\n`);
  stdout.write(`Threads: ${report.inputSummary.threadCount}\n`);
  stdout.write(`Hooks: ${report.inputSummary.hookCount}\n`);
}

function writeReviewPlanReport(
  report: ReviewPlanCommandReport,
  asJson: boolean,
  stdout: Pick<NodeJS.WriteStream, "write">,
): void {
  if (asJson) {
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  stdout.write("Review plan preview completed.\n");
  stdout.write(`Scope: ${report.scope}\n`);
  if (report.chapter !== undefined) stdout.write(`Chapter: ${report.chapter}\n`);
  if (report.reportPath) stdout.write(`Report: ${report.reportPath}\n`);
  stdout.write(`Actions: ${report.actions.length}\n`);
  stdout.write(`${report.summary}\n`);
}

function writeApplyReviewPlanReport(
  report: ApplyReviewPlanCommandReport,
  asJson: boolean,
  stdout: Pick<NodeJS.WriteStream, "write">,
  stderr: Pick<NodeJS.WriteStream, "write">,
): void {
  if (asJson) {
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  const target = report.passed ? stdout : stderr;
  target.write(report.passed ? "Review plan apply completed.\n" : "Review plan apply failed.\n");
  target.write(`Dry-run: ${report.dryRun ? "yes" : "no"}\n`);
  if (report.reportPath) target.write(`Report: ${report.reportPath}\n`);
  target.write(`Applied actions: ${report.appliedActions.length}\n`);
  target.write(`Skipped actions: ${report.skippedActions.length}\n`);
  target.write(`${report.summary}\n`);
}

function writeMaintenanceRunReport(
  report: MaintenanceRunReport,
  asJson: boolean,
  stdout: Pick<NodeJS.WriteStream, "write">,
  stderr: Pick<NodeJS.WriteStream, "write">,
): void {
  if (asJson) {
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  const target = report.passed ? stdout : stderr;
  target.write(report.passed ? "Maintenance run completed.\n" : "Maintenance run failed.\n");
  target.write(`Scope: ${report.scope}\n`);
  if (report.chapter !== undefined) target.write(`Chapter: ${report.chapter}\n`);
  if (report.maintenanceReportPath) target.write(`Report: ${report.maintenanceReportPath}\n`);
  target.write(`Issues: ${report.issueCount}\n`);
  target.write(`Suggestions: ${report.suggestionCount}\n`);
  target.write(`Actions: ${report.actionCount}\n`);
  if (report.intentDiagnosticsVisibility) {
    target.write(`Intent diagnostics: ${report.intentDiagnosticsVisibility.cleanupVisibleCount} cleanup-visible / ${report.intentDiagnosticsVisibility.totalIntents} total; advisory suggestions ${report.intentDiagnosticsVisibility.advisorySuggestionCount}\n`);
  }
  target.write(`Would modify state: ${report.wouldModifyState ? "yes" : "no"}\n`);
  target.write(`${report.summary}\n`);
}

function writeIntentLifecycleDiagnosticsReport(
  report: IntentLifecycleDiagnosticsCommandReport,
  asJson: boolean,
  stdout: Pick<NodeJS.WriteStream, "write">,
): void {
  if (asJson) {
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  stdout.write("Intent lifecycle diagnostics completed.\n");
  if (report.reportPath) stdout.write(`Report: ${report.reportPath}\n`);
  stdout.write(`Intents: ${report.totalIntents}\n`);
  stdout.write(`Open/touched/done: ${report.openIntentCount}/${report.touchedIntentCount}/${report.doneIntentCount}\n`);
  stdout.write(`Low/medium/high: ${report.valueClassCounts.low_value_generic}/${report.valueClassCounts.medium_value_action}/${report.valueClassCounts.high_value_narrative}\n`);
  stdout.write(`Cleanup-visible: ${report.totalIntents - report.cleanupCandidateCounts.none}\n`);
  stdout.write(`${report.summary}\n`);
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

function emptyMaintenanceActionBreakdown(): MaintenanceActionBreakdown {
  return {
    mark_thread_done: 0,
    merge_threads: 0,
    drop_thread: 0,
    prioritize_thread: 0,
    prioritize_hook: 0,
    prioritize_arc_goal: 0,
    create_repair_plan: 0,
    no_action: 0,
  };
}

function emptyApplyDryRunBreakdown(): Pick<MaintenanceActionBreakdown, "mark_thread_done" | "merge_threads" | "drop_thread"> {
  return {
    mark_thread_done: 0,
    merge_threads: 0,
    drop_thread: 0,
  };
}

function emptyRecommendedActionSummary(): MaintenanceRecommendedActionSummary {
  return {
    totalRecommended: 0,
    byAction: emptyApplyDryRunBreakdown(),
    byRisk: {
      safe: 0,
      caution: 0,
      risky: 0,
    },
    byConfirmationMode: {
      recommended_confirm: 0,
      manual_review: 0,
      do_not_confirm: 0,
    },
    deepseekDropCount: 0,
    deepseekDropRecommendedCount: 0,
    deepseekDropManualReviewCount: 0,
    deepseekDropRiskyCount: 0,
  };
}

function emptyAlreadyDoneGuardSummary(): MaintenanceAlreadyDoneGuardSummary {
  return {
    filteredCount: 0,
    filteredActionIds: [],
    filteredTargetIds: [],
  };
}

function countAlreadyDoneGuardSummary(
  filteredAlreadyDoneActions: readonly FilteredAlreadyDoneAction[] = [],
): MaintenanceAlreadyDoneGuardSummary {
  return {
    filteredCount: filteredAlreadyDoneActions.length,
    filteredActionIds: filteredAlreadyDoneActions.map((action) => action.id),
    filteredTargetIds: [...new Set(filteredAlreadyDoneActions.flatMap((action) => action.doneTargetIds))],
  };
}

function emptyMergeDropPreviewSummary(): MaintenanceMergeDropPreviewSummary {
  return {
    mergePreviewCount: 0,
    safeMergeCount: 0,
    cautionMergeCount: 0,
    riskyMergeCount: 0,
    dropPreviewCount: 0,
    safeDropCount: 0,
    cautionDropCount: 0,
    riskyDropCount: 0,
  };
}

function countMergeDropPreviewSummary(
  actions: readonly ReviewPlan["actions"][number][],
): MaintenanceMergeDropPreviewSummary {
  const summary = { ...emptyMergeDropPreviewSummary() };
  for (const action of actions) {
    if (action.action === "merge_threads") {
      summary.mergePreviewCount += 1;
      if (action.safety.riskLevel === "safe") summary.safeMergeCount += 1;
      if (action.safety.riskLevel === "caution") summary.cautionMergeCount += 1;
      if (action.safety.riskLevel === "risky") summary.riskyMergeCount += 1;
    }
    if (action.action === "drop_thread") {
      summary.dropPreviewCount += 1;
      if (action.safety.riskLevel === "safe") summary.safeDropCount += 1;
      if (action.safety.riskLevel === "caution") summary.cautionDropCount += 1;
      if (action.safety.riskLevel === "risky") summary.riskyDropCount += 1;
    }
  }
  return summary;
}

function countRecommendedActionSummary(
  actions: readonly ReviewPlan["actions"][number][],
  filteredAlreadyDoneActions: readonly FilteredAlreadyDoneAction[] = [],
): MaintenanceRecommendedActionSummary {
  const filteredActionIds = new Set(filteredAlreadyDoneActions.map((action) => action.id));
  const summary = emptyRecommendedActionSummary();
  const byAction = { ...summary.byAction };
  const byRisk = { ...summary.byRisk };
  const byConfirmationMode = { ...summary.byConfirmationMode };
  let totalRecommended = 0;
  let deepseekDropCount = 0;
  let deepseekDropRecommendedCount = 0;
  let deepseekDropManualReviewCount = 0;
  let deepseekDropRiskyCount = 0;
  for (const action of actions) {
    byRisk[action.safety.riskLevel] += 1;
    byConfirmationMode[action.confirmationMode] += 1;
    const isDeepseekDrop = action.action === "drop_thread" && action.preview.dropAnalysis?.providerSource === "deepseek";
    if (isDeepseekDrop) {
      deepseekDropCount += 1;
      if (action.safety.riskLevel === "risky") deepseekDropRiskyCount += 1;
      if (action.confirmationMode === "manual_review") deepseekDropManualReviewCount += 1;
    }
    if (!filteredActionIds.has(action.id) && action.confirmability.recommended && action.confirmationMode === "recommended_confirm") {
      totalRecommended += 1;
      if (action.action === "mark_thread_done" || action.action === "merge_threads" || action.action === "drop_thread") {
        byAction[action.action] += 1;
      }
      if (isDeepseekDrop) deepseekDropRecommendedCount += 1;
    }
  }
  return {
    totalRecommended,
    byAction,
    byRisk,
    byConfirmationMode,
    deepseekDropCount,
    deepseekDropRecommendedCount,
    deepseekDropManualReviewCount,
    deepseekDropRiskyCount,
  };
}

function explainNoRecommendedActions(
  actions: readonly ReviewPlan["actions"][number][],
  filteredAlreadyDoneActions: readonly FilteredAlreadyDoneAction[] = [],
): MaintenanceNoRecommendedActionReason {
  const executableActions = actions.filter((action) => action.action === "mark_thread_done"
    || action.action === "merge_threads"
    || action.action === "drop_thread");
  const manualReviewActions = actions.filter((action) => action.confirmationMode === "manual_review");
  const riskyActions = actions.filter((action) => action.safety.riskLevel === "risky");
  const prioritizeActions = actions.filter((action) => action.action === "prioritize_thread"
    || action.action === "prioritize_hook"
    || action.action === "prioritize_arc_goal");
  const details: string[] = [];
  if (actions.length === 0) {
    details.push("ReviewPlan generated no actions.");
  }
  if (actions.length > 0 && executableActions.length === 0 && prioritizeActions.length > 0) {
    details.push("All generated actions are prioritization/no_action/repair actions; no direct thread maintenance action is executable.");
  }
  if (executableActions.length > 0) {
    const notRecommended = executableActions.filter((action) => !action.confirmability.recommended);
    if (notRecommended.length > 0) details.push(`${notRecommended.length} executable thread action(s) were not recommended by safety/confirmation rules.`);
    const notConfirmable = executableActions.filter((action) => action.confirmationMode !== "recommended_confirm");
    if (notConfirmable.length > 0) details.push(`${notConfirmable.length} executable thread action(s) require manual review or do_not_confirm.`);
  }
  if (manualReviewActions.length > 0) details.push(`${manualReviewActions.length} action(s) were downgraded to manual_review.`);
  if (riskyActions.length > 0) details.push(`${riskyActions.length} action(s) were marked risky.`);
  if (filteredAlreadyDoneActions.length > 0) details.push(`${filteredAlreadyDoneActions.length} already-done action(s) were filtered.`);
  const reason = details[0] ?? "No recommended_confirm thread actions reached recommendedActionIds.";
  return {
    reason,
    actionCount: actions.length,
    executableActionCount: executableActions.length,
    recommendedActionCount: 0,
    manualReviewCount: manualReviewActions.length,
    riskyCount: riskyActions.length,
    prioritizeOnly: actions.length > 0 && executableActions.length === 0 && prioritizeActions.length > 0,
    filteredAlreadyDoneCount: filteredAlreadyDoneActions.length,
    details,
  };
}

function recommendedActionIdsFromActions(
  actions: readonly ReviewPlan["actions"][number][],
  filteredAlreadyDoneActions: readonly FilteredAlreadyDoneAction[] = [],
): readonly string[] {
  const filteredActionIds = new Set(filteredAlreadyDoneActions.map((action) => action.id));
  return actions
    .filter((action) => !filteredActionIds.has(action.id))
    .filter((action) => action.confirmability.recommended)
    .filter((action) => action.confirmationMode === "recommended_confirm")
    .filter((action) => action.action === "mark_thread_done" || action.action === "merge_threads" || action.action === "drop_thread")
    .map((action) => action.id);
}

function riskyActionIdsFromActions(actions: readonly ReviewPlan["actions"][number][]): readonly string[] {
  return actions
    .filter((action) => action.safety.riskLevel === "risky")
    .map((action) => action.id);
}

function buildReviewPlanStage(
  actions: readonly ReviewPlan["actions"][number][],
  recommendedActionIds: readonly string[],
  riskyActionIds: readonly string[],
  filteredAlreadyDoneActions: readonly FilteredAlreadyDoneAction[] = [],
): MaintenanceCandidateReviewPlanStage {
  return {
    actionCount: actions.length,
    executableActionCount: actions.filter((action) => action.action === "mark_thread_done"
      || action.action === "merge_threads"
      || action.action === "drop_thread").length,
    recommendedActionCount: recommendedActionIds.length,
    manualReviewCount: actions.filter((action) => action.confirmationMode === "manual_review").length,
    riskyCount: riskyActionIds.length,
    recommendedActionIds,
    riskyActionIds,
    ...(filteredAlreadyDoneActions.length > 0
      ? {
        filteredAlreadyDoneActionCount: filteredAlreadyDoneActions.length,
        filteredAlreadyDoneActionIds: filteredAlreadyDoneActions.map((action) => action.id),
      }
      : {}),
  };
}

function withReviewPlanStage(
  diagnostics: MaintenanceCandidateDiagnostics,
  reviewPlanStage: MaintenanceCandidateReviewPlanStage,
): MaintenanceCandidateDiagnostics {
  const noActionReason = reviewPlanStage.executableActionCount === 0
    ? diagnostics.noActionReason ?? "ReviewPlan produced no executable maintenance actions."
    : diagnostics.noActionReason;
  return {
    ...diagnostics,
    reviewPlanStage,
    ...(noActionReason ? { noActionReason } : {}),
  };
}

function countMaintenanceActionBreakdown(actions: readonly { readonly action: string }[]): MaintenanceActionBreakdown {
  const breakdown = {
    mark_thread_done: 0,
    merge_threads: 0,
    drop_thread: 0,
    prioritize_thread: 0,
    prioritize_hook: 0,
    prioritize_arc_goal: 0,
    create_repair_plan: 0,
    no_action: 0,
  };
  for (const action of actions) {
    if (isMaintenanceAction(action.action)) {
      breakdown[action.action] += 1;
    }
  }
  return breakdown;
}

function countApplyDryRunBreakdown(
  actions: readonly { readonly action: string }[],
): Pick<MaintenanceActionBreakdown, "mark_thread_done" | "merge_threads" | "drop_thread"> {
  const breakdown = {
    mark_thread_done: 0,
    merge_threads: 0,
    drop_thread: 0,
  };
  for (const action of actions) {
    if (action.action === "mark_thread_done" || action.action === "merge_threads" || action.action === "drop_thread") {
      breakdown[action.action] += 1;
    }
  }
  return breakdown;
}

function isMaintenanceAction(value: string): value is keyof MaintenanceActionBreakdown {
  return value === "mark_thread_done"
    || value === "merge_threads"
    || value === "drop_thread"
    || value === "prioritize_thread"
    || value === "prioritize_hook"
    || value === "prioritize_arc_goal"
    || value === "create_repair_plan"
    || value === "no_action";
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

function parseNonNegativeInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new InvalidArgumentError("value must be a non-negative integer");
  }
  return parsed;
}

function parseReviewScope(value: string): AIReviewScope {
  if (value === "chapter" || value === "window" || value === "arc") {
    return value;
  }
  throw new InvalidArgumentError("--scope must be chapter, window, or arc");
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

function providerOptionsFromReviewOptions(options: ReviewOptions): RunAIReviewerWithProviderOptions {
  return {
    providerId: resolveAIReviewerProviderId(options),
    ...(options.fallbackToMock === true ? { fallbackToMock: true } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
    ...(options.strictJson === true ? { strictJson: true } : {}),
  };
}

function providerOptionsFromMaintenanceOptions(options: MaintenanceRunOptions): RunAIReviewerWithProviderOptions {
  return {
    providerId: resolveAIReviewerProviderId(options),
    ...(options.fallbackToMock === true ? { fallbackToMock: true } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
    ...(options.strictJson === true ? { strictJson: true } : {}),
  };
}

function resolveAIReviewerProviderId(options: { readonly mock?: boolean; readonly provider?: string }): string {
  if (options.mock === true) return "mock";
  const provider = options.provider?.trim();
  return provider && provider.length > 0 ? provider : "external";
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

async function writeAIReviewReportFile(
  projectDir: string,
  report: AIReviewReport,
  chapter: number | undefined,
): Promise<string> {
  const reportsDir = join(projectDir, "reports");
  await mkdir(reportsDir, { recursive: true });
  const suffix = chapter === undefined ? "latest" : padChapter(chapter);
  const reportPath = join(reportsDir, `ai-review-${report.scope}-${suffix}.json`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  return reportPath;
}

async function writeAIReviewPromptContractFile(
  projectDir: string,
  contract: AIReviewerPromptContract,
  scope: AIReviewScope,
  chapter: number | undefined,
): Promise<string> {
  const reportsDir = join(projectDir, "reports");
  await mkdir(reportsDir, { recursive: true });
  const suffix = chapter === undefined ? "latest" : padChapter(chapter);
  const reportPath = join(reportsDir, `ai-review-prompt-${scope}-${suffix}.json`);
  await writeFile(reportPath, `${JSON.stringify(contract, null, 2)}\n`, "utf-8");
  return reportPath;
}

async function writeReviewPlanReportFile(
  projectDir: string,
  plan: ReviewPlan,
  chapter: number | undefined,
): Promise<string> {
  const reportsDir = join(projectDir, "reports");
  await mkdir(reportsDir, { recursive: true });
  const suffix = chapter === undefined ? "latest" : padChapter(chapter);
  const reportPath = join(reportsDir, `review-plan-${plan.scope}-${suffix}.json`);
  await writeFile(reportPath, `${JSON.stringify(plan, null, 2)}\n`, "utf-8");
  return reportPath;
}

async function writeApplyReviewPlanReportFile(
  projectDir: string,
  result: ApplyReviewPlanResult,
  chapter: number | undefined,
): Promise<string> {
  const reportsDir = join(projectDir, "reports");
  await mkdir(reportsDir, { recursive: true });
  const suffix = chapter === undefined ? "latest" : padChapter(chapter);
  const reportPath = join(reportsDir, `apply-review-plan-${suffix}.json`);
  await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`, "utf-8");
  return reportPath;
}

async function writeMaintenanceApplyDryRunReportFile(
  projectDir: string,
  result: ApplyReviewPlanResult,
  scope: AIReviewScope,
  chapter: number | undefined,
): Promise<string> {
  const reportsDir = join(projectDir, "reports");
  await mkdir(reportsDir, { recursive: true });
  const suffix = chapter === undefined ? "latest" : padChapter(chapter);
  const reportPath = join(reportsDir, `apply-review-plan-${scope}-${suffix}-dry-run.json`);
  await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`, "utf-8");
  return reportPath;
}

async function writeMaintenanceRunReportFile(
  projectDir: string,
  report: MaintenanceRunReport,
  scope: AIReviewScope,
  chapter: number | undefined,
): Promise<string> {
  const reportsDir = join(projectDir, "reports");
  await mkdir(reportsDir, { recursive: true });
  const suffix = chapter === undefined ? "latest" : padChapter(chapter);
  const reportPath = join(reportsDir, `maintenance-run-${scope}-${suffix}.json`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  return reportPath;
}

async function writeIntentLifecycleDiagnosticsReportFile(
  projectDir: string,
  report: IntentLifecycleDiagnosticsReport,
  chapter: number | undefined,
): Promise<string> {
  const reportsDir = join(projectDir, "reports");
  await mkdir(reportsDir, { recursive: true });
  const suffix = chapter === undefined ? "latest" : padChapter(chapter);
  const reportPath = join(reportsDir, `intent-lifecycle-diagnostics-${suffix}.json`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  return reportPath;
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
