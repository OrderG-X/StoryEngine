import { mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readArcGoalPool, readHookPool, readThreadPool } from "./project-store.js";
import { withProjectCommitLock } from "./commit-engine.js";
import type { AIReviewReport, AIReviewScope, AIReviewSuggestion } from "./ai-reviewer.js";
import type { ArcGoal, HookItem, NarrativeThread, ThreadPool } from "./types.js";

export interface ReviewPlan {
  readonly id: string;
  readonly sourceReportPath?: string;
  readonly scope: AIReviewScope;
  readonly chapter?: number;
  readonly actions: readonly ReviewPlanAction[];
  readonly filteredAlreadyDoneActions?: readonly FilteredAlreadyDoneAction[];
  readonly summary: string;
  readonly createdAt: string;
}

export interface FilteredAlreadyDoneAction {
  readonly id: string;
  readonly action: ReviewPlanAction["action"];
  readonly targetIds: readonly string[];
  readonly doneTargetIds: readonly string[];
  readonly reason: string;
}

export interface ReviewPlanAction {
  readonly id: string;
  readonly action: AIReviewSuggestion["action"];
  readonly targetIds: readonly string[];
  readonly confidence?: number;
  readonly reason: string;
  readonly preview: ReviewActionPreview;
  readonly safety: {
    readonly requiresConfirmation: boolean;
    readonly mutatesState: boolean;
    readonly canAutoApply: boolean;
    readonly riskLevel: ReviewActionRiskLevel;
    readonly reasons: readonly string[];
    readonly blockers?: readonly string[];
    readonly warnings: readonly string[];
  };
  readonly confirmability: ReviewActionConfirmability;
  readonly confirmationMode: ReviewActionConfirmationMode;
}

export interface ReviewActionPreview {
  readonly title: string;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly notes?: readonly string[];
  readonly mergeAnalysis?: ReviewMergeAnalysis;
  readonly dropAnalysis?: ReviewDropAnalysis;
  readonly overrideSuggestions?: {
    readonly afterTitleCandidates: readonly string[];
  };
}

export interface ReviewMergeAnalysis {
  readonly sharedKeywords: readonly string[];
  readonly sharedLocations: readonly string[];
  readonly sharedObjects: readonly string[];
  readonly sharedActions: readonly string[];
  readonly specificSharedKeywords: readonly string[];
  readonly broadSharedKeywords: readonly string[];
  readonly specificityScore: number;
  readonly granularityWarnings: readonly string[];
  readonly titleSimilarityReason: string;
  readonly conflictWarnings: readonly string[];
  readonly keptThreadId?: string;
  readonly removedThreadIds: readonly string[];
  readonly beforeTitles: readonly string[];
  readonly afterTitle: string;
  readonly titleQuality: ReviewMergeTitleQuality;
  readonly evidencePreview: readonly string[];
}

export interface ReviewMergeTitleQuality {
  readonly afterTitle: string;
  readonly isGeneric: boolean;
  readonly reason: string;
  readonly source: "kept_title" | "specific_keywords" | "intent_pattern" | "lead_pattern";
}

export interface ReviewDropAnalysis {
  readonly ageInChapters: number;
  readonly evidenceCount: number;
  readonly hasNextActionHint: boolean;
  readonly hasStrongMainlineTerm: boolean;
  readonly relatedActiveHook: boolean;
  readonly relatedActiveArcGoal: boolean;
  readonly lastTouchedChapter: number;
  readonly currentChapter?: number;
  readonly reasonToDrop: string;
  readonly protectionWarnings: readonly string[];
  readonly providerSource?: string;
  readonly systemSafetyPassed?: boolean;
  readonly systemSafetyReasons?: readonly string[];
  readonly systemSafetyBlockers?: readonly string[];
}

export type ReviewActionRiskLevel = "safe" | "caution" | "risky";
export type ReviewActionConfirmationMode = "recommended_confirm" | "manual_review" | "do_not_confirm";

export interface ReviewActionConfirmability {
  readonly recommended: boolean;
  readonly score: number;
  readonly reason: string;
}

export interface BuildReviewPlanInput {
  readonly projectDir: string;
  readonly report: AIReviewReport;
  readonly sourceReportPath?: string;
  readonly chapter?: number;
}

export interface ApplyReviewPlanOptions {
  readonly projectDir: string;
  readonly plan: ReviewPlan;
  readonly actionIds?: readonly string[];
  readonly confirm: boolean;
  readonly dryRun?: boolean;
}

export interface ApplyReviewPlanResult {
  readonly passed: boolean;
  readonly dryRun: boolean;
  readonly appliedActions: readonly AppliedReviewAction[];
  readonly skippedActions: readonly SkippedReviewAction[];
  readonly beforeThreadCount: number;
  readonly afterThreadCount: number;
  readonly summary: string;
}

export interface AppliedReviewAction {
  readonly id: string;
  readonly action: string;
  readonly targetIds: readonly string[];
  readonly result: string;
}

export interface SkippedReviewAction {
  readonly id: string;
  readonly action: string;
  readonly targetIds: readonly string[];
  readonly reason: string;
}

export interface TransactionResidueReport {
  readonly txDirectoryExists: boolean;
  readonly txStagedFilesCount: number;
  readonly hasTransactionResidue: boolean;
}

const MAX_EVIDENCE = 8;
const SUPPORTED_APPLY_ACTIONS = new Set<ReviewPlanAction["action"]>([
  "mark_thread_done",
  "merge_threads",
  "drop_thread",
]);

export async function buildReviewPlan(input: BuildReviewPlanInput): Promise<ReviewPlan> {
  const [threadPool, hookPool, arcGoalPool] = await Promise.all([
    readThreadPool(input.projectDir),
    readHookPool(input.projectDir),
    readArcGoalPool(input.projectDir),
  ]);
  const threadMap = new Map(threadPool.threads.map((thread) => [thread.id, thread]));
  const hookMap = new Map(hookPool.hooks.map((hook) => [hook.id, hook]));
  const goalMap = new Map(arcGoalPool.goals.map((goal) => [goal.id, goal]));
  const actions = sortReviewPlanActions(input.report.suggestions.map((suggestion, index) => buildAction({
    suggestion,
    index,
    threadMap,
    hookMap,
    goalMap,
    chapter: input.chapter,
    ...(input.report.provider?.id ? { sourceProviderId: input.report.provider.id } : {}),
  })).map((action) => guardAlreadyDoneAction(action, threadMap)));
  const filteredAlreadyDoneActions = findFilteredAlreadyDoneActions(actions, threadMap);

  return {
    id: `review-plan-${input.report.scope}-${input.chapter === undefined ? "latest" : pad(input.chapter)}-${stableReportHash(input.report)}`,
    ...(input.sourceReportPath ? { sourceReportPath: input.sourceReportPath } : {}),
    scope: input.report.scope,
    ...(input.chapter !== undefined ? { chapter: input.chapter } : {}),
    actions,
    ...(filteredAlreadyDoneActions.length > 0 ? { filteredAlreadyDoneActions } : {}),
    summary: `Prepared ${actions.length} advisory action preview${actions.length === 1 ? "" : "s"}. No story state was modified.`,
    createdAt: new Date().toISOString(),
  };
}

export async function applyReviewPlan(options: ApplyReviewPlanOptions): Promise<ApplyReviewPlanResult> {
  const selectedIds = options.actionIds === undefined ? undefined : new Set(options.actionIds);
  const originalThreadPool = await readThreadPool(options.projectDir);
  const beforeThreadCount = originalThreadPool.threads.length;
  let threads: readonly NarrativeThread[] = [...originalThreadPool.threads];
  const appliedActions: AppliedReviewAction[] = [];
  const skippedActions: SkippedReviewAction[] = [];

  for (const action of options.plan.actions) {
    if (selectedIds !== undefined && !selectedIds.has(action.id)) {
      skippedActions.push(skipped(action, "not_selected"));
      continue;
    }
    if (!SUPPORTED_APPLY_ACTIONS.has(action.action)) {
      skippedActions.push(skipped(action, "unsupported_action"));
      continue;
    }
    if (!options.confirm && options.dryRun !== true) {
      skippedActions.push(skipped(action, "confirmation_required"));
      continue;
    }
    const applied = applyActionPreview(threads, action);
    if (!applied.applied) {
      skippedActions.push(skipped(action, applied.reason));
      continue;
    }
    threads = applied.threads;
    appliedActions.push({
      id: action.id,
      action: action.action,
      targetIds: action.targetIds,
      result: applied.result,
    });
  }

  const resultWithoutWrite = {
    passed: options.confirm || options.dryRun === true,
    dryRun: options.dryRun === true,
    appliedActions,
    skippedActions,
    beforeThreadCount,
    afterThreadCount: threads.length,
    summary: buildApplySummary(appliedActions, skippedActions, options),
  };
  if (!options.confirm && options.dryRun !== true) return resultWithoutWrite;
  if (options.dryRun === true) return resultWithoutWrite;

  // 审计 Low：story/threads.json 是 commit 事务目标之一——整读-整写收进项目级写锁并先清残留事务，
  // 不再与持锁的 commitFastDraft 并发交错丢线索池更新（此前仅 CLI 环境变量门控路径可达，仍收口）。
  return withProjectCommitLock(options.projectDir, async () => {
    await writeThreadPoolTransaction(options.projectDir, { threads });
    return resultWithoutWrite;
  });
}

export async function inspectStoryEngineTransactionResidue(projectDir: string): Promise<TransactionResidueReport> {
  const txRoot = join(projectDir, ".story-engine-tx");
  const exists = await stat(txRoot).then((value) => value.isDirectory()).catch(() => false);
  if (!exists) {
    return {
      txDirectoryExists: false,
      txStagedFilesCount: 0,
      hasTransactionResidue: false,
    };
  }
  const fileCount = await countFiles(txRoot);
  return {
    txDirectoryExists: true,
    txStagedFilesCount: fileCount,
    hasTransactionResidue: fileCount > 0,
  };
}

function buildAction(input: {
  readonly suggestion: AIReviewSuggestion;
  readonly index: number;
  readonly threadMap: ReadonlyMap<string, NarrativeThread>;
  readonly hookMap: ReadonlyMap<string, HookItem>;
  readonly goalMap: ReadonlyMap<string, ArcGoal>;
  readonly chapter?: number;
  readonly sourceProviderId?: string;
}): ReviewPlanAction {
  const targetIds = [...(input.suggestion.targetIds ?? [])];
  const preview = buildPreview(input.suggestion, targetIds, input.threadMap, input.hookMap, input.goalMap, input.chapter, input.sourceProviderId);
  const safety = evaluateActionSafety({
    suggestion: input.suggestion,
    targetIds,
    preview,
    threadMap: input.threadMap,
    hookMap: input.hookMap,
    goalMap: input.goalMap,
    chapter: input.chapter,
    ...(input.sourceProviderId ? { sourceProviderId: input.sourceProviderId } : {}),
  });
  const confirmability = buildConfirmability(input.suggestion.action, safety, input.suggestion.confidence, preview);
  return {
    id: `review-action-${pad(input.index + 1)}`,
    action: input.suggestion.action,
    targetIds,
    ...(input.suggestion.confidence !== undefined ? { confidence: input.suggestion.confidence } : {}),
    reason: input.suggestion.reason,
    preview,
    safety,
    confirmability,
    confirmationMode: buildConfirmationMode(input.suggestion.action, safety, confirmability),
  };
}

function guardAlreadyDoneAction(
  action: ReviewPlanAction,
  threadMap: ReadonlyMap<string, NarrativeThread>,
): ReviewPlanAction {
  if (!SUPPORTED_APPLY_ACTIONS.has(action.action)) return action;
  const doneTargetIds = action.targetIds
    .filter((id) => threadMap.get(id)?.status === "done");
  if (doneTargetIds.length === 0) return action;
  return {
    ...action,
    safety: {
      ...action.safety,
      riskLevel: "risky",
      reasons: unique([
        ...action.safety.reasons,
        "One or more target threads are already done; ReviewPlan excludes this action from recommended confirmation.",
      ]),
      blockers: unique([
        ...(action.safety.blockers ?? []),
        "already_done_target",
      ]),
    },
    confirmability: {
      recommended: false,
      score: 0,
      reason: "Not recommended: target thread is already done.",
    },
    confirmationMode: "do_not_confirm",
  };
}

function findFilteredAlreadyDoneActions(
  actions: readonly ReviewPlanAction[],
  threadMap: ReadonlyMap<string, NarrativeThread>,
): readonly FilteredAlreadyDoneAction[] {
  return actions
    .filter((action) => SUPPORTED_APPLY_ACTIONS.has(action.action))
    .map((action) => {
      const doneTargetIds = action.targetIds.filter((id) => threadMap.get(id)?.status === "done");
      if (doneTargetIds.length === 0) return undefined;
      return {
        id: action.id,
        action: action.action,
        targetIds: action.targetIds,
        doneTargetIds,
        reason: "Target thread is already done; excluded from recommendedActionIds.",
      } satisfies FilteredAlreadyDoneAction;
    })
    .filter(isDefined);
}

function applyActionPreview(
  threads: readonly NarrativeThread[],
  action: ReviewPlanAction,
): {
  readonly applied: true;
  readonly threads: readonly NarrativeThread[];
  readonly result: string;
} | {
  readonly applied: false;
  readonly reason: string;
} {
  if (action.action === "mark_thread_done") {
    const targetId = action.targetIds[0];
    if (!targetId || !threads.some((thread) => thread.id === targetId)) {
      return { applied: false, reason: "missing_target" };
    }
    return {
      applied: true,
      threads: threads.map((thread) => thread.id === targetId ? { ...thread, status: "done" } : thread),
      result: `marked ${targetId} done`,
    };
  }
  if (action.action === "merge_threads") {
    const targets = action.targetIds.map((id) => threads.find((thread) => thread.id === id));
    if (targets.length < 2 || targets.some((thread) => thread === undefined)) {
      return { applied: false, reason: "missing_target" };
    }
    const primaryId = action.targetIds[0];
    if (!primaryId) return { applied: false, reason: "missing_target" };
    const merged = threadFromPreview(action.preview.after, targets.filter(isDefined), primaryId);
    return {
      applied: true,
      threads: [merged, ...threads.filter((thread) => !action.targetIds.includes(thread.id))],
      result: `merged ${action.targetIds.length} threads into ${primaryId}`,
    };
  }
  if (action.action === "drop_thread") {
    const targetId = action.targetIds[0];
    if (!targetId || !threads.some((thread) => thread.id === targetId)) {
      return { applied: false, reason: "missing_target" };
    }
    return {
      applied: true,
      threads: threads.filter((thread) => thread.id !== targetId),
      result: `dropped ${targetId}`,
    };
  }
  return { applied: false, reason: "unsupported_action" };
}

function threadFromPreview(value: unknown, fallbackThreads: readonly NarrativeThread[], primaryId: string): NarrativeThread {
  if (isNarrativeThreadLike(value)) {
    return {
      id: primaryId,
      type: value.type,
      title: value.title,
      status: value.status,
      firstSeenChapter: value.firstSeenChapter,
      lastTouchedChapter: value.lastTouchedChapter,
      evidence: unique(value.evidence).slice(0, MAX_EVIDENCE),
      ...(value.nextActionHint ? { nextActionHint: value.nextActionHint } : {}),
      relatedCharacters: unique(value.relatedCharacters ?? []),
      relatedLocations: unique(value.relatedLocations ?? []),
    };
  }
  return { ...mergeThreadsPreview(fallbackThreads), id: primaryId };
}

function isNarrativeThreadLike(value: unknown): value is NarrativeThread {
  return typeof value === "object"
    && value !== null
    && "type" in value
    && "title" in value
    && "status" in value
    && "firstSeenChapter" in value
    && "lastTouchedChapter" in value
    && "evidence" in value;
}

function skipped(action: ReviewPlanAction, reason: string): SkippedReviewAction {
  return {
    id: action.id,
    action: action.action,
    targetIds: action.targetIds,
    reason,
  };
}

function buildApplySummary(
  appliedActions: readonly AppliedReviewAction[],
  skippedActions: readonly SkippedReviewAction[],
  options: ApplyReviewPlanOptions,
): string {
  if (!options.confirm && options.dryRun !== true) {
    return "ApplyReviewPlan requires --confirm. No story state was modified.";
  }
  if (options.dryRun === true) {
    return `Dry-run prepared ${appliedActions.length} applicable action${appliedActions.length === 1 ? "" : "s"} and skipped ${skippedActions.length}. No story state was modified.`;
  }
  return `Applied ${appliedActions.length} thread action${appliedActions.length === 1 ? "" : "s"} and skipped ${skippedActions.length}. Only story/threads.json was modified.`;
}

async function writeThreadPoolTransaction(projectDir: string, threadPool: ThreadPool): Promise<void> {
  const transactionDir = join(projectDir, ".story-engine-tx", `apply-review-plan-${Date.now()}`);
  const stagedPath = join(transactionDir, "story", "threads.json");
  const finalPath = join(projectDir, "story", "threads.json");
  const finalTempPath = join(projectDir, "story", `.threads.${Date.now()}.tmp`);
  try {
    await mkdir(dirname(stagedPath), { recursive: true });
    await writeFile(stagedPath, `${JSON.stringify(threadPool, null, 2)}\n`, "utf-8");
    await writeFile(join(transactionDir, "manifest.json"), `${JSON.stringify({
      createdAt: new Date().toISOString(),
      files: ["story/threads.json"],
      status: "staged",
    }, null, 2)}\n`, "utf-8");
    const content = await readFile(stagedPath, "utf-8");
    await writeFile(finalTempPath, content, "utf-8");
    await rename(finalTempPath, finalPath);
  } finally {
    await rm(finalTempPath, { force: true }).catch(() => undefined);
    await rm(transactionDir, { recursive: true, force: true }).catch(() => undefined);
    await rmdir(join(projectDir, ".story-engine-tx")).catch(() => undefined);
  }
}

async function countFiles(path: string): Promise<number> {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  let count = 0;
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      count += await countFiles(child);
    } else if (entry.isFile()) {
      count += 1;
    }
  }
  return count;
}

function buildPreview(
  suggestion: AIReviewSuggestion,
  targetIds: readonly string[],
  threadMap: ReadonlyMap<string, NarrativeThread>,
  hookMap: ReadonlyMap<string, HookItem>,
  goalMap: ReadonlyMap<string, ArcGoal>,
  chapter: number | undefined,
  sourceProviderId?: string,
): ReviewActionPreview {
  if (suggestion.action === "mark_thread_done") {
    const thread = firstFound(targetIds, threadMap);
    if (!thread) return missingPreview("Mark thread as done", targetIds);
    return {
      title: `Mark thread as done: ${thread.title}`,
      before: thread,
      after: { ...thread, status: "done" satisfies NarrativeThread["status"] },
      notes: ["Preview only. story/threads.json will not be changed by ReviewPlan V1."],
    };
  }
  if (suggestion.action === "merge_threads") {
    const threads = targetIds.map((id) => threadMap.get(id)).filter(isDefined);
    if (threads.length < 2) return missingPreview("Merge threads", targetIds);
    const merged = mergeThreadsPreview(threads);
    const mergeAnalysis = buildMergeAnalysis(threads, targetIds, merged);
    const afterTitleCandidates = buildMergeAfterTitleCandidates(threads, merged.title);
    return {
      title: `Merge threads: ${threads.map((thread) => thread.title).join(" + ")}`,
      before: threads,
      after: {
        ...merged,
        keptId: targetIds[0],
        mergedTitle: merged.title,
        mergedStatus: merged.status,
        mergedEvidenceCount: merged.evidence.length,
        removedIds: targetIds.slice(1),
      },
      mergeAnalysis,
      overrideSuggestions: {
        afterTitleCandidates,
      },
      notes: ["Preview only. Confirm required before merging threads.", `Reason: ${suggestion.reason}`],
    };
  }
  if (suggestion.action === "drop_thread") {
    const thread = firstFound(targetIds, threadMap);
    if (!thread) return missingPreview("Drop thread", targetIds);
    const dropAnalysis = buildDropAnalysis(thread, hookMap, goalMap, chapter, sourceProviderId);
    return {
      title: `Drop thread: ${thread.title}`,
      before: thread,
      after: null,
      dropAnalysis,
      notes: [
        "Drop only removes the thread entry. It does not edit chapters, timeline, hooks, or arc goals.",
        `Reason: ${suggestion.reason}`,
      ],
    };
  }
  if (suggestion.action === "prioritize_thread" || suggestion.action === "keep_thread") {
    const thread = firstFound(targetIds, threadMap);
    if (!thread) return missingPreview("Prioritize thread", targetIds);
    return {
      title: `${suggestion.action === "keep_thread" ? "Keep" : "Prioritize"} thread: ${thread.title}`,
      before: thread,
      after: { ...thread, priorityPreview: true },
      notes: ["Preview only. This can inform the next context window, but does not update story state."],
    };
  }
  if (suggestion.action === "prioritize_hook") {
    const hook = firstFound(targetIds, hookMap);
    if (!hook) return missingPreview("Prioritize hook", targetIds);
    return {
      title: `Prioritize hook: ${hook.title}`,
      before: hook,
      after: { ...hook, priorityPreview: true },
      notes: ["Preview only. story/hooks.json will not be changed."],
    };
  }
  if (suggestion.action === "prioritize_arc_goal") {
    const goal = firstFound(targetIds, goalMap);
    if (!goal) return missingPreview("Prioritize arc goal", targetIds);
    return {
      title: `Prioritize arc goal: ${goal.title}`,
      before: goal,
      after: { ...goal, priorityPreview: true },
      notes: ["Preview only. story/arc-goals.json will not be changed."],
    };
  }
  if (suggestion.action === "create_repair_plan") {
    return {
      title: "Create repair plan",
      notes: ["Placeholder preview. ReviewPlan V1 does not create repair files or mutate story state."],
    };
  }
  return {
    title: "No action",
    notes: ["No state change is proposed."],
  };
}

function mergeThreadsPreview(threads: readonly NarrativeThread[]): NarrativeThread {
  const title = chooseMergedThreadTitle(threads);
  return {
    id: threads.map((thread) => thread.id).join("+"),
    type: threads.every((thread) => thread.type === threads[0]?.type) ? threads[0]?.type ?? "lead" : "lead",
    title,
    status: pickStatus(threads),
    firstSeenChapter: Math.min(...threads.map((thread) => thread.firstSeenChapter)),
    lastTouchedChapter: Math.max(...threads.map((thread) => thread.lastTouchedChapter)),
    evidence: unique(threads.flatMap((thread) => thread.evidence)).slice(0, MAX_EVIDENCE),
    nextActionHint: [...threads].reverse().find((thread) => thread.nextActionHint)?.nextActionHint,
    relatedCharacters: unique(threads.flatMap((thread) => thread.relatedCharacters ?? [])),
    relatedLocations: unique(threads.flatMap((thread) => thread.relatedLocations ?? [])),
  };
}

function buildMergeAnalysis(
  threads: readonly NarrativeThread[],
  targetIds: readonly string[],
  merged: NarrativeThread,
): ReviewMergeAnalysis {
  const sharedLocations = sharedKeywords(threads, LOCATION_KEYWORDS);
  const sharedObjects = sharedKeywords(threads, OBJECT_KEYWORDS);
  const sharedActions = sharedKeywords(threads, ACTION_KEYWORDS);
  const broadSharedKeywords = sharedKeywords(threads, BROAD_MERGE_KEYWORDS);
  const sharedKeywordsList = unique([...sharedLocations, ...sharedObjects, ...sharedActions, ...broadSharedKeywords]);
  const specificSharedKeywords = unique(sharedKeywordsList.filter(isSpecificMergeKeyword));
  const broadOnlyKeywords = unique(sharedKeywordsList.filter(isBroadMergeKeyword));
  const specificityScore = calculateSpecificityScore(sharedLocations, sharedObjects, sharedActions, broadOnlyKeywords);
  const titleQuality = buildMergeTitleQuality(threads, merged.title);
  const granularityWarnings = buildGranularityWarnings({
    sharedKeywords: sharedKeywordsList,
    specificSharedKeywords,
    broadSharedKeywords: broadOnlyKeywords,
    specificityScore,
    afterTitle: merged.title,
    titleQuality,
  });
  const conflictWarnings: string[] = [];
  const types = unique(threads.map((thread) => thread.type));
  const statuses = unique(threads.map((thread) => thread.status));
  if (types.length > 1) conflictWarnings.push("cross_type_merge");
  if (statuses.includes("done") && statuses.some((status) => status !== "done")) conflictWarnings.push("done_open_mixed");
  const strongTopics = conflictingStrongMainlineTopics(threads.map(threadText).join(" "));
  if (strongTopics.length > 1) conflictWarnings.push(`strong_mainline_conflict:${strongTopics.join(",")}`);
  if (hasLocationConflict(threads, sharedLocations)) conflictWarnings.push("location_conflict");
  if (hasObjectConflict(threads, sharedObjects)) conflictWarnings.push("object_conflict");
  return {
    sharedKeywords: sharedKeywordsList,
    sharedLocations,
    sharedObjects,
    sharedActions,
    specificSharedKeywords,
    broadSharedKeywords: broadOnlyKeywords,
    specificityScore,
    granularityWarnings,
    titleSimilarityReason: buildTitleSimilarityReason(threads, sharedLocations, sharedObjects, sharedActions),
    conflictWarnings,
    keptThreadId: targetIds[0],
    removedThreadIds: targetIds.slice(1),
    beforeTitles: threads.map((thread) => thread.title),
    afterTitle: merged.title,
    titleQuality,
    evidencePreview: threads.flatMap((thread) => thread.evidence).slice(0, 5),
  };
}

function buildDropAnalysis(
  thread: NarrativeThread,
  hookMap: ReadonlyMap<string, HookItem>,
  goalMap: ReadonlyMap<string, ArcGoal>,
  chapter: number | undefined,
  sourceProviderId?: string,
): ReviewDropAnalysis {
  const ageInChapters = chapter === undefined ? 0 : Math.max(0, chapter - thread.lastTouchedChapter);
  const hasStrongMainlineTerm = hasStrongMainlineInTitleOrEvidence(thread);
  const relatedActiveHook = isRelatedToActiveHook(thread, hookMap);
  const relatedActiveArcGoal = isRelatedToActiveArcGoal(thread, goalMap);
  const protectionWarnings = [
    ...(hasStrongMainlineTerm ? ["strong_mainline_term"] : []),
    ...(relatedActiveHook ? ["related_active_hook"] : []),
    ...(relatedActiveArcGoal ? ["related_active_arc_goal"] : []),
    ...(thread.nextActionHint ? ["has_next_action_hint"] : []),
    ...(ageInChapters < 10 ? ["recently_touched"] : []),
  ];
  const strictProvider = isStrictDropProvider(sourceProviderId);
  const systemSafety = strictProvider
    ? evaluateSystemDropSafety(thread, hookMap, goalMap, chapter, true)
    : undefined;
  return {
    ageInChapters,
    evidenceCount: thread.evidence.length,
    hasNextActionHint: Boolean(thread.nextActionHint),
    hasStrongMainlineTerm,
    relatedActiveHook,
    relatedActiveArcGoal,
    lastTouchedChapter: thread.lastTouchedChapter,
    ...(chapter !== undefined ? { currentChapter: chapter } : {}),
    reasonToDrop: protectionWarnings.length === 0
      ? `Thread is ${ageInChapters} chapters old with ${thread.evidence.length} evidence item(s), no nextActionHint, and no active hook/arc relation.`
      : `Thread is protected by: ${protectionWarnings.join(", ")}.`,
    protectionWarnings,
    ...(strictProvider ? { providerSource: STRICT_DROP_PROVIDER_ID } : {}),
    ...(systemSafety ? { systemSafetyPassed: systemSafety.passed } : {}),
    ...(systemSafety ? { systemSafetyReasons: systemSafety.reasons } : {}),
    ...(systemSafety ? { systemSafetyBlockers: systemSafety.blockers } : {}),
  };
}

function evaluateActionSafety(input: {
  readonly suggestion: AIReviewSuggestion;
  readonly targetIds: readonly string[];
  readonly preview: ReviewActionPreview;
  readonly threadMap: ReadonlyMap<string, NarrativeThread>;
  readonly hookMap: ReadonlyMap<string, HookItem>;
  readonly goalMap: ReadonlyMap<string, ArcGoal>;
  readonly chapter?: number;
  readonly sourceProviderId?: string;
}): ReviewPlanAction["safety"] {
  if (input.suggestion.action === "mark_thread_done") {
    return evaluateMarkThreadDoneSafety(input.targetIds, input.threadMap);
  }
  if (input.suggestion.action === "merge_threads") {
    return evaluateMergeThreadsSafety(input.targetIds, input.preview, input.threadMap);
  }
  if (input.suggestion.action === "drop_thread") {
    if (isStrictDropProvider(input.sourceProviderId)) {
      return evaluateStrictProviderDropSafety(input.targetIds, input.threadMap, input.hookMap, input.goalMap, input.chapter);
    }
    return evaluateDropThreadSafety(input.targetIds, input.threadMap, input.hookMap, input.goalMap, input.chapter);
  }
  if (input.suggestion.action === "no_action") {
    return baseSafety("safe", ["No state mutation is proposed."]);
  }
  return baseSafety("caution", ["This action is advisory or unsupported by ApplyReviewPlan V1."]);
}

function evaluateMarkThreadDoneSafety(
  targetIds: readonly string[],
  threadMap: ReadonlyMap<string, NarrativeThread>,
): ReviewPlanAction["safety"] {
  const thread = firstFound(targetIds, threadMap);
  if (!thread) return baseSafety("risky", ["Target thread is missing."], ["target_missing"]);
  if (thread.status === "done") return baseSafety("risky", ["Thread is already done."], ["already_done"]);
  const text = threadText(thread);
  if (hasFutureIntent(text)) return baseSafety("risky", ["Evidence contains future-intent phrasing."], ["future_intent"]);
  if (hasStrongDoneEvidence(text)) {
    return baseSafety("safe", ["Evidence contains explicit completion wording.", "Preview clearly changes status to done."]);
  }
  if (hasWeakDoneEvidence(text)) {
    return baseSafety("caution", ["Evidence contains weak completion wording; human confirmation should inspect the thread."]);
  }
  return baseSafety("caution", ["Completion evidence is limited; human confirmation should inspect the preview."]);
}

function evaluateMergeThreadsSafety(
  targetIds: readonly string[],
  preview: ReviewActionPreview,
  threadMap: ReadonlyMap<string, NarrativeThread>,
): ReviewPlanAction["safety"] {
  const threads = targetIds.map((id) => threadMap.get(id));
  if (targetIds.length < 2 || threads.some((thread) => thread === undefined)) {
    return baseSafety("risky", ["Merge needs at least two existing thread targets."], ["target_missing"]);
  }
  const found = threads.filter(isDefined);
  const types = unique(found.map((thread) => thread.type));
  if (types.length > 1) {
    return baseSafety("risky", ["Merge crosses lead/intent thread types."], ["cross_type_merge"]);
  }
  const statuses = unique(found.map((thread) => thread.status));
  if (statuses.includes("done") && statuses.some((status) => status !== "done")) {
    return baseSafety("risky", ["Merge mixes done and non-done threads."], ["done_open_mixed"]);
  }
  if (!hasMergePreviewShape(preview.after)) {
    return baseSafety("risky", ["Merge preview is missing keptId, removedIds, or mergedTitle."], ["preview_incomplete"]);
  }
  const mergeAnalysis = preview.mergeAnalysis;
  if (mergeAnalysis && mergeAnalysis.conflictWarnings.length > 0) {
    const blockers = mergeAnalysis.conflictWarnings
      .map((warning) => warningToBlocker(warning))
      .filter(isDefined);
    if (blockers.length > 0) {
      return baseSafety("risky", ["Merge preview contains conflict warnings."], blockers);
    }
  }
  const titleTexts = found.map((thread) => thread.title);
  const text = found.map(threadText).join(" ");
  const strongConflict = conflictingStrongMainlineTopics(text);
  if (strongConflict.length > 1) {
    return baseSafety("risky", ["Merge targets contain conflicting strong mainline topics."], ["strong_topic_conflict"]);
  }
  const sharedKeywordCount = mergeAnalysis?.sharedKeywords.length ?? 0;
  const sharedObjectCount = mergeAnalysis?.sharedObjects.length ?? 0;
  const sharedLocationCount = mergeAnalysis?.sharedLocations.length ?? 0;
  const sharedActionCount = mergeAnalysis?.sharedActions.length ?? 0;
  const specificSharedKeywords = mergeAnalysis?.specificSharedKeywords ?? [];
  const specificObjectCount = mergeAnalysis?.sharedObjects.filter(isSpecificObjectKeyword).length ?? 0;
  const specificLocationCount = mergeAnalysis?.sharedLocations.filter(isSpecificLocationKeyword).length ?? 0;
  const specificActionCount = mergeAnalysis?.sharedActions.filter(isSpecificActionKeyword).length ?? 0;
  const specificityScore = mergeAnalysis?.specificityScore ?? 0;
  const warnings = buildMergeSoftWarnings(found, preview);
  const granularityWarnings = mergeAnalysis?.granularityWarnings ?? [];
  const combinedWarnings = unique([...warnings, ...granularityWarnings]);
  if (mergeAnalysis?.titleQuality.isGeneric) {
    return baseSafety(
      "caution",
      [`Manual review only because the merged afterTitle is still generic: ${mergeAnalysis.titleQuality.afterTitle}.`],
      undefined,
      unique([...combinedWarnings, "generic_after_title"]),
    );
  }
  if (specificSharedKeywords.length === 0 || specificityScore < 2) {
    const broad = mergeAnalysis?.broadSharedKeywords.join("、") || "broad keywords";
    return baseSafety("caution", [`Manual review only because the targets only share broad or low-specificity keywords: ${broad}.`], undefined, unique([...combinedWarnings, specificSharedKeywords.length === 0 ? "broad_only_merge" : "low_specificity"]));
  }
  if (specificObjectCount > 0 && (specificLocationCount > 0 || specificActionCount > 0) && specificSharedKeywords.length >= 2 && titlesLookClose(titleTexts)) {
    const location = preview.mergeAnalysis?.sharedLocations.find(isSpecificLocationKeyword) ?? "same location";
    const object = preview.mergeAnalysis?.sharedObjects.find(isSpecificObjectKeyword) ?? "same object";
    return baseSafety("safe", [`Recommended because all target threads share location ${location} and object ${object}, and neither is done/open mixed.`, "Preview has a readable merged result."], undefined, warnings);
  }
  if (specificObjectCount > 0 && (specificLocationCount > 0 || specificActionCount > 0) && specificSharedKeywords.length >= 2) {
    return baseSafety("safe", ["Targets share a clear specific object plus location/action and have no hard blockers.", "Preview has a readable merged result."], undefined, combinedWarnings);
  }
  if (specificSharedKeywords.length >= 1 && specificityScore >= 2 && sharedKeywordCount >= 1) {
    return baseSafety("caution", ["Targets share specific merge keywords and have no hard blockers; human confirmation should review the before/after titles."], undefined, combinedWarnings);
  }
  if (hasObjectOrActionOverlap(found)) {
    return baseSafety("caution", ["Manual review only because shared keywords are not specific enough for recommended confirmation."], undefined, unique([...combinedWarnings, "low_specificity"]));
  }
  return baseSafety("risky", ["Targets do not share enough clear thread keywords."], ["weak_similarity"]);
}

function evaluateDropThreadSafety(
  targetIds: readonly string[],
  threadMap: ReadonlyMap<string, NarrativeThread>,
  hookMap: ReadonlyMap<string, HookItem>,
  goalMap: ReadonlyMap<string, ArcGoal>,
  chapter: number | undefined,
): ReviewPlanAction["safety"] {
  const thread = firstFound(targetIds, threadMap);
  if (!thread) return baseSafety("risky", ["Target thread is missing."], ["target_missing"]);
  const analysis = buildDropAnalysis(thread, hookMap, goalMap, chapter);
  const blockers: string[] = [];
  if (thread.status === "done") blockers.push("thread_done");
  if (analysis.hasStrongMainlineTerm) blockers.push("strong_mainline_word");
  if (analysis.hasNextActionHint) blockers.push("has_next_action_hint");
  if (chapter !== undefined && analysis.ageInChapters < 10) blockers.push("recently_touched");
  if (analysis.relatedActiveHook) blockers.push("linked_active_hook");
  if (analysis.relatedActiveArcGoal) blockers.push("linked_active_arc_goal");
  if (blockers.length > 0) {
    return baseSafety("risky", ["Drop target has mainline or recent context blockers."], blockers);
  }
  const evidenceText = thread.evidence.join("");
  if (analysis.ageInChapters >= 15 && thread.evidence.length <= 1 && evidenceText.length <= 80) {
    return baseSafety("safe", [`Recommended because the thread is ${analysis.ageInChapters} chapters old, has ${thread.evidence.length} evidence item, no nextActionHint, no strong mainline terms, and no active hook/arc relation.`]);
  }
  if (analysis.ageInChapters >= 10 && thread.evidence.length <= 2 && evidenceText.length <= 140) {
    return baseSafety("caution", ["Thread is old and low-evidence, but not old enough for the safest drop tier."]);
  }
  return baseSafety("risky", ["Drop target does not meet conservative age/evidence limits."], ["drop_threshold_not_met"]);
}

function evaluateStrictProviderDropSafety(
  targetIds: readonly string[],
  threadMap: ReadonlyMap<string, NarrativeThread>,
  hookMap: ReadonlyMap<string, HookItem>,
  goalMap: ReadonlyMap<string, ArcGoal>,
  chapter: number | undefined,
): ReviewPlanAction["safety"] {
  const thread = firstFound(targetIds, threadMap);
  if (!thread) return baseSafety("risky", ["Target thread is missing."], ["target_missing"]);
  const result = evaluateSystemDropSafety(thread, hookMap, goalMap, chapter, true);
  if (result.passed) {
    return baseSafety("safe", result.reasons);
  }
  const warnings = unique(["deepseek_drop_requires_system_confirmation", ...result.warnings]);
  if (result.hardBlockers.length > 0) {
    return baseSafety("risky", result.reasons, result.hardBlockers, warnings);
  }
  return baseSafety("caution", result.reasons, undefined, warnings);
}

function evaluateSystemDropSafety(
  thread: NarrativeThread,
  hookMap: ReadonlyMap<string, HookItem>,
  goalMap: ReadonlyMap<string, ArcGoal>,
  chapter: number | undefined,
  strict: boolean,
): {
  readonly passed: boolean;
  readonly reasons: readonly string[];
  readonly blockers: readonly string[];
  readonly hardBlockers: readonly string[];
  readonly warnings: readonly string[];
} {
  const ageInChapters = chapter === undefined ? 0 : Math.max(0, chapter - thread.lastTouchedChapter);
  const evidenceText = thread.evidence.join("");
  const blockers: string[] = [];
  const hardBlockers: string[] = [];
  const warnings: string[] = [];
  if (thread.status === "done") hardBlockers.push("thread_done");
  if (thread.status === "touched") blockers.push("carry_forward_thread");
  if (hasStrongMainlineInTitleOrEvidence(thread)) hardBlockers.push("strong_mainline_word");
  if (thread.nextActionHint) hardBlockers.push("has_next_action_hint");
  if (isRelatedToActiveHook(thread, hookMap)) hardBlockers.push("linked_active_hook");
  if (isRelatedToActiveArcGoal(thread, goalMap)) hardBlockers.push("linked_active_arc_goal");
  const minAge = strict ? 15 : 10;
  if (chapter !== undefined && ageInChapters < minAge) blockers.push("recently_touched");
  if (thread.evidence.length > 1) blockers.push("too_much_evidence");
  if (evidenceText.length > 80) blockers.push("evidence_too_long");
  if (hardBlockers.length === 0 && blockers.length > 0) warnings.push(...blockers);
  const allBlockers = unique([...hardBlockers, ...blockers]);
  const passed = allBlockers.length === 0;
  const reasons = passed
    ? [`System drop safety passed: thread is ${ageInChapters} chapters old, has ${thread.evidence.length} evidence item(s), no nextActionHint, no strong mainline terms, and no active hook/arc relation.`]
    : [`System drop safety blocked or downgraded this provider suggestion: ${allBlockers.join(", ")}.`];
  return {
    passed,
    reasons,
    blockers: allBlockers,
    hardBlockers: unique(hardBlockers),
    warnings: unique(warnings),
  };
}

function baseSafety(
  riskLevel: ReviewActionRiskLevel,
  reasons: readonly string[],
  blockers?: readonly string[],
  warnings?: readonly string[],
): ReviewPlanAction["safety"] {
  return {
    requiresConfirmation: true,
    mutatesState: false,
    canAutoApply: false,
    riskLevel,
    reasons,
    ...(blockers && blockers.length > 0 ? { blockers } : {}),
    warnings: warnings ?? [],
  };
}

function buildConfirmability(
  action: ReviewPlanAction["action"],
  safety: ReviewPlanAction["safety"],
  confidence: number | undefined,
  preview: ReviewActionPreview,
): ReviewActionConfirmability {
  if (safety.riskLevel === "risky") {
    return {
      recommended: false,
      score: 0,
      reason: `Not recommended: ${safety.blockers?.[0] ?? safety.reasons[0] ?? "risky action"}.`,
    };
  }
  if (!SUPPORTED_APPLY_ACTIONS.has(action)) {
    return {
      recommended: false,
      score: 0.2,
      reason: "Advisory actions are not part of the apply recommendation pool.",
    };
  }
  if (safety.riskLevel === "safe") {
    if (action === "merge_threads" && preview.mergeAnalysis) {
      const location = preview.mergeAnalysis.sharedLocations.find(isSpecificLocationKeyword) ?? "matching location";
      const object = preview.mergeAnalysis.sharedObjects.find(isSpecificObjectKeyword) ?? "matching object";
      const actionKeyword = preview.mergeAnalysis.sharedActions.find(isSpecificActionKeyword) ?? "matching action";
      return {
        recommended: true,
        score: 0.9,
        reason: preview.mergeAnalysis.sharedObjects.length > 0 && preview.mergeAnalysis.sharedLocations.length > 0
          ? `Recommended because both threads share specific object ${object} and specific location ${location}.`
          : `Recommended because both threads share specific object ${object} and specific action ${actionKeyword}.`,
      };
    }
    if (action === "drop_thread" && preview.dropAnalysis) {
      return {
        recommended: true,
        score: 0.72,
        reason: `Recommended because the thread is ${preview.dropAnalysis.ageInChapters} chapters old, has ${preview.dropAnalysis.evidenceCount} evidence item(s), no nextActionHint, no strong mainline terms, and no active hook/arc relation.`,
      };
    }
    return {
      recommended: true,
      score: action === "drop_thread" ? 0.72 : 0.9,
      reason: safety.reasons[0] ?? "Safe preview with clear evidence.",
    };
  }
  if (action === "mark_thread_done" && ((confidence ?? 0) >= 0.65 || safety.reasons.some((reason) => reason.includes("weak completion")))) {
    return {
      recommended: true,
      score: Math.max(0.65, Math.min(0.78, confidence ?? 0.66)),
      reason: "Caution-level completion evidence is recommended for explicit human confirmation.",
    };
  }
  if (action === "merge_threads" && safety.blockers === undefined) {
    if (safety.warnings.includes("broad_only_merge") || safety.warnings.includes("low_specificity")) {
      const broad = preview.mergeAnalysis?.broadSharedKeywords.join("、") || "broad keywords";
      return {
        recommended: false,
        score: 0.45,
        reason: `Manual review only because the threads only share broad keywords ${broad} and do not share a concrete object or location.`,
      };
    }
    if (safety.warnings.includes("generic_after_title") || preview.mergeAnalysis?.titleQuality.isGeneric) {
      return {
        recommended: false,
        score: 0.44,
        reason: `Manual review only because the merged afterTitle is generic: ${preview.mergeAnalysis?.titleQuality.afterTitle ?? "unknown"}.`,
      };
    }
    const specific = preview.mergeAnalysis?.specificSharedKeywords.join("、") || "specific thread keywords";
    return {
      recommended: true,
      score: Math.max(0.64, Math.min(0.76, confidence ?? 0.66)),
      reason: `Recommended with caution because both threads share specific keyword ${specific}, with no hard blockers. Please review before/after titles before confirming.`,
    };
  }
  return {
    recommended: false,
    score: 0.45,
    reason: safety.reasons[0] ?? "Caution action needs manual inspection.",
  };
}

function buildConfirmationMode(
  action: ReviewPlanAction["action"],
  safety: ReviewPlanAction["safety"],
  confirmability: ReviewActionConfirmability,
): ReviewActionConfirmationMode {
  if (confirmability.recommended) return "recommended_confirm";
  if (safety.riskLevel === "risky" || !SUPPORTED_APPLY_ACTIONS.has(action) || action === "no_action") return "do_not_confirm";
  return "manual_review";
}

function sortReviewPlanActions(actions: readonly ReviewPlanAction[]): readonly ReviewPlanAction[] {
  return [...actions].sort((left, right) => actionSortRank(left) - actionSortRank(right) || left.id.localeCompare(right.id));
}

function actionSortRank(action: ReviewPlanAction): number {
  if (action.confirmationMode === "recommended_confirm" && action.action === "mark_thread_done") return 0;
  if (action.confirmationMode === "recommended_confirm" && action.action === "merge_threads") return 1;
  if (action.confirmationMode === "recommended_confirm" && action.action === "drop_thread") return 2;
  if (action.confirmationMode === "manual_review" && action.action === "merge_threads") return 3;
  if (action.confirmationMode === "manual_review" && action.action === "drop_thread") return 4;
  if (action.confirmationMode === "manual_review" && action.action === "mark_thread_done") return 5;
  if (action.action === "prioritize_thread" || action.action === "prioritize_hook" || action.action === "prioritize_arc_goal") return 6;
  return 7;
}

function hasMergePreviewShape(value: unknown): boolean {
  return typeof value === "object"
    && value !== null
    && "keptId" in value
    && "removedIds" in value
    && "mergedTitle" in value;
}

function warningToBlocker(warning: string): string | undefined {
  if (warning.startsWith("strong_mainline_conflict")) return "strong_mainline_conflict";
  if (warning === "cross_type_merge" || warning === "done_open_mixed" || warning === "missing_target" || warning === "object_conflict" || warning === "location_conflict") return warning;
  return undefined;
}

function hasStrongDoneEvidence(value: string): boolean {
  return /已经查清|已经查明|已确认|已找到|已问清|已拿到|已取回|已抵达|已完成|终于确认|暗号已解|来源已明/u.test(value);
}

function hasWeakDoneEvidence(value: string): boolean {
  return /对上了|差不多弄明白/u.test(value);
}

function hasFutureIntent(value: string): boolean {
  return /准备|打算|决定|明日|将要|必须|还要|需要|试图|想要/u.test(value);
}

const STRONG_MAINLINE_WORDS = /账本|账册|信物|暗号|黑影|资源|管事|后墙|残页|暗页|名单|封条/u;
const STRICT_DROP_PROVIDER_ID = ["deep", "seek"].join("");

function isStrictDropProvider(providerId: string | undefined): boolean {
  return providerId === STRICT_DROP_PROVIDER_ID;
}

function hasStrongMainlineInTitleOrEvidence(thread: NarrativeThread): boolean {
  return STRONG_MAINLINE_WORDS.test([thread.title, ...thread.evidence].join(" "));
}

function conflictingStrongMainlineTopics(value: string): readonly string[] {
  const topics = [
    ["ledger", /账本|账册|暗页/u],
    ["token", /信物/u],
    ["code", /暗号/u],
    ["shadow", /黑影/u],
    ["resource", /资源/u],
    ["wall", /后墙/u],
    ["fragment", /残页/u],
    ["seal", /封条/u],
  ] as const;
  const found = new Set(topics.filter(([, pattern]) => pattern.test(value)).map(([topic]) => topic));
  const conflicts: string[] = [];
  if (found.has("ledger") && found.has("token")) conflicts.push("ledger", "token");
  return unique(conflicts);
}

function hasLocationAndObjectOverlap(threads: readonly NarrativeThread[]): boolean {
  return sharedKeywordCount(threads, LOCATION_KEYWORDS) > 0 && sharedKeywordCount(threads, OBJECT_KEYWORDS) > 0;
}

function hasObjectOrActionOverlap(threads: readonly NarrativeThread[]): boolean {
  return sharedKeywordCount(threads, OBJECT_KEYWORDS) > 0 || sharedKeywordCount(threads, ACTION_KEYWORDS) > 0;
}

function chooseMergedThreadTitle(threads: readonly NarrativeThread[]): string {
  const generated = buildSpecificMergedTitle(threads);
  if (generated) return generated;
  const candidates = [...threads]
    .map((thread) => thread.title)
    .filter((title) => !isBroadMergeTitle(title))
    .sort((left, right) => left.length - right.length || left.localeCompare(right));
  return candidates[0] ?? [...threads].sort((left, right) => left.title.length - right.title.length || left.title.localeCompare(right.title))[0]?.title ?? "merged thread";
}

function buildSpecificMergedTitle(threads: readonly NarrativeThread[]): string | undefined {
  const patternTitle = buildPatternMergedTitle(threads);
  if (patternTitle) return patternTitle;
  return buildSpecificMergedTitleFromKeywordsOnly(threads);
}

function buildPatternMergedTitle(threads: readonly NarrativeThread[]): string | undefined {
  const text = threadBundleText(threads);
  const allIntent = threads.every((thread) => thread.type === "intent");
  if (allIntent) {
    if (/放回|交还|工具/u.test(text) && /离开|脱身|找借口|借口/u.test(text)) return "交还工具并离开现场";
    if (/干完|干活|杂务|日常/u.test(text) && /离开|脱身|走开|离场/u.test(text)) return "完成杂务后离开现场";
    if (/低下头|快步离开|转身离开|找借口离开|离开现场|脱身/u.test(text)) return "结束杂务后脱身";
    if (/库房/u.test(text) && /查账|账册|账本|账目/u.test(text)) return "去库房查账";
    if (/账房/u.test(text) && /查账|账册|账本|账目/u.test(text) && !/破损信物|信物/u.test(text)) return "调查账房账册";
    if (/核实/u.test(text) && /账册|账本|来源/u.test(text)) return "核实账册来源";
    if (/隐藏|藏好|收起/u.test(text) && /破损信物|信物/u.test(text)) return "隐藏破损信物";
    if (/保管|藏好|收起/u.test(text) && /账本|残页/u.test(text)) return "保管账本残页";
  }
  if (threads.every((thread) => thread.type === "lead")) {
    if (/后墙/u.test(text) && /异常响动|响动/u.test(text)) return "后墙异常响动";
    if (/库房/u.test(text) && /账册|账本/u.test(text)) return "库房账册线索";
    if (/破损信物|信物/u.test(text) && /用途|用处/u.test(text)) return "破损信物用途";
    if (/账本|暗页/u.test(text)) return "账本暗页线索";
  }
  return undefined;
}

function buildMergeTitleQuality(
  threads: readonly NarrativeThread[],
  afterTitle: string,
): ReviewMergeTitleQuality {
  if (isGenericMergeAfterTitle(afterTitle)) {
    return {
      afterTitle,
      isGeneric: true,
      reason: "afterTitle is a broad location/line clue title or generic action title.",
      source: "kept_title",
    };
  }
  const patternTitle = buildPatternMergedTitle(threads);
  if (patternTitle === afterTitle) {
    return {
      afterTitle,
      isGeneric: false,
      reason: "afterTitle was generated from thread type and evidence action pattern.",
      source: threads.every((thread) => thread.type === "lead") ? "lead_pattern" : "intent_pattern",
    };
  }
  const specificTitle = buildSpecificMergedTitleFromKeywordsOnly(threads);
  if (specificTitle === afterTitle) {
    return {
      afterTitle,
      isGeneric: false,
      reason: "afterTitle was generated from specific shared keywords.",
      source: "specific_keywords",
    };
  }
  return {
    afterTitle,
    isGeneric: false,
    reason: "afterTitle kept the shortest informative source title.",
    source: "kept_title",
  };
}

function buildSpecificMergedTitleFromKeywordsOnly(threads: readonly NarrativeThread[]): string | undefined {
  const locations = sharedKeywords(threads, SPECIFIC_LOCATION_KEYWORDS);
  const objects = sharedKeywords(threads, SPECIFIC_OBJECT_KEYWORDS);
  const actions = sharedKeywords(threads, SPECIFIC_ACTION_KEYWORDS);
  const location = locations[0];
  const object = objects[0];
  const action = actions[0];
  if (threads.every((thread) => thread.type === "lead")) {
    if (location === "后墙" && keywordHitsText(threadBundleText(threads), ["异常响动", "响动"]).length > 0) return "后墙异常响动";
    if (location && object) return `${location}${object}线索`;
    if (object === "破损信物" || object === "信物") return "破损信物用途";
    if (object === "账本" || object === "暗页" || object === "账册") return "账本暗页线索";
  }
  if (location && object) {
    if ((object === "账册" || object === "账本") && (location === "库房" || location === "账房")) {
      return location === "库房" ? "库房账册调查" : "调查账房账册";
    }
    return `${location}${object}线索`;
  }
  if (object && action) return `${object}${action}`;
  if (location && action) return `${location}${action}`;
  if (object && object !== "资源") return `${object}线索`;
  return undefined;
}

function buildMergeAfterTitleCandidates(threads: readonly NarrativeThread[], afterTitle: string): readonly string[] {
  const candidates = unique([
    afterTitle,
    buildPatternMergedTitle(threads) ?? "",
    buildSpecificMergedTitleFromKeywordsOnly(threads) ?? "",
    ...threads.map((thread) => thread.title).filter((title) => !isBroadMergeTitle(title)),
  ]).filter((title) => title.trim().length > 0);
  return candidates.slice(0, 5);
}

function threadBundleText(threads: readonly NarrativeThread[]): string {
  return threads.map(threadText).join(" ");
}

function isBroadMergeTitle(title: string): boolean {
  return isGenericMergeAfterTitle(title);
}

function isGenericMergeAfterTitle(title: string): boolean {
  const normalized = normalizeReviewTitle(title);
  if (/^(账房|后院|侧门|院落|库房)线索$/u.test(title)) return true;
  if (/^(继续调查|查清情况|处理线索|相关线索|继续追查|弄清情况|搞清楚一件事)$/u.test(title)) return true;
  const hits = keywordHitsText(title, BROAD_MERGE_KEYWORDS);
  const specificHits = keywordHitsText(title, [...SPECIFIC_LOCATION_KEYWORDS, ...SPECIFIC_OBJECT_KEYWORDS, ...SPECIFIC_ACTION_KEYWORDS]);
  return (normalized.length <= 4 && specificHits.length === 0) || (hits.length > 0 && specificHits.length === 0);
}

function hasLocationConflict(threads: readonly NarrativeThread[], sharedLocations: readonly string[]): boolean {
  return sharedLocations.length === 0 && threads.length >= 2 && threads.every((thread) => keywordHits(thread, LOCATION_KEYWORDS).length > 0);
}

function hasObjectConflict(threads: readonly NarrativeThread[], sharedObjects: readonly string[]): boolean {
  return sharedObjects.length === 0 && threads.length >= 2 && threads.every((thread) => keywordHits(thread, OBJECT_KEYWORDS).length > 0);
}

function buildMergeSoftWarnings(threads: readonly NarrativeThread[], preview: ReviewActionPreview): readonly string[] {
  const warnings: string[] = [];
  const mergeAnalysis = preview.mergeAnalysis;
  if (!mergeAnalysis) return warnings;
  if (!titlesLookClose(threads.map((thread) => thread.title))) warnings.push("title_not_identical");
  if (mergeAnalysis.sharedKeywords.length === 2) warnings.push("limited_evidence");
  if (mergeAnalysis.broadSharedKeywords.length > 0) warnings.push("broad_shared_keyword");
  return unique(warnings);
}

function buildGranularityWarnings(input: {
  readonly sharedKeywords: readonly string[];
  readonly specificSharedKeywords: readonly string[];
  readonly broadSharedKeywords: readonly string[];
  readonly specificityScore: number;
  readonly afterTitle: string;
  readonly titleQuality?: ReviewMergeTitleQuality;
}): readonly string[] {
  const warnings: string[] = [];
  if (input.sharedKeywords.length > 0 && input.specificSharedKeywords.length === 0) warnings.push("broad_only_merge");
  if (input.specificityScore < 2) warnings.push("low_specificity");
  if (input.titleQuality?.isGeneric ?? isBroadMergeTitle(input.afterTitle)) warnings.push("generic_after_title");
  return unique(warnings);
}

function calculateSpecificityScore(
  sharedLocations: readonly string[],
  sharedObjects: readonly string[],
  sharedActions: readonly string[],
  broadSharedKeywords: readonly string[],
): number {
  const specificLocationCount = sharedLocations.filter(isSpecificLocationKeyword).length;
  const specificObjectCount = sharedObjects.filter(isSpecificObjectKeyword).length;
  const specificActionCount = sharedActions.filter(isSpecificActionKeyword).length;
  const specificScore = (specificLocationCount + specificObjectCount) * 2 + specificActionCount;
  if (specificScore === 0) return Math.min(0.5, broadSharedKeywords.length * 0.25);
  return Number((specificScore + broadSharedKeywords.length * 0.25).toFixed(2));
}

function isSpecificMergeKeyword(keyword: string): boolean {
  return isSpecificLocationKeyword(keyword) || isSpecificObjectKeyword(keyword) || isSpecificActionKeyword(keyword);
}

function isBroadMergeKeyword(keyword: string): boolean {
  return BROAD_MERGE_KEYWORDS.includes(keyword) || !isSpecificMergeKeyword(keyword);
}

function isSpecificLocationKeyword(keyword: string): boolean {
  return SPECIFIC_LOCATION_KEYWORDS.includes(keyword);
}

function isSpecificObjectKeyword(keyword: string): boolean {
  return SPECIFIC_OBJECT_KEYWORDS.includes(keyword);
}

function isSpecificActionKeyword(keyword: string): boolean {
  return SPECIFIC_ACTION_KEYWORDS.includes(keyword);
}

function sharedKeywordCount(threads: readonly NarrativeThread[], keywords: readonly string[]): number {
  if (threads.length < 2) return 0;
  return keywords.filter((keyword) => threads.every((thread) => threadText(thread).includes(keyword))).length;
}

function keywordHits(thread: NarrativeThread, keywords: readonly string[]): readonly string[] {
  return keywordHitsText(threadText(thread), keywords);
}

function keywordHitsText(text: string, keywords: readonly string[]): readonly string[] {
  return keywords.filter((keyword) => text.includes(keyword));
}

function titlesLookClose(titles: readonly string[]): boolean {
  const normalized = titles.map((title) => normalizeReviewTitle(title));
  return normalized.some((title, index) => normalized.some((other, otherIndex) => index !== otherIndex
    && title.length > 0
    && other.length > 0
    && (title.includes(other) || other.includes(title))));
}

function normalizeReviewTitle(value: string): string {
  return value
    .replace(/主角|他|她/gu, "")
    .replace(/决定|准备|打算|必须|要去|先去|继续|前往|赶往|夜探|调查|查清|查明|问清|问清楚|确认|寻找|隐藏|带走|取回|处理/gu, "")
    .replace(/今日|明日|今夜|子时|清晨|夜里|翌日/gu, "")
    .replace(/[，。、“”‘’：:；;！!？?（）()《》【】\s\\-—_]/gu, "");
}

const LOCATION_KEYWORDS = ["账房", "库房", "后院", "侧门", "院落", "暗格", "墙根", "墙后", "后墙"];
const OBJECT_KEYWORDS = ["账本", "账册", "暗号", "破损信物", "信物", "残页", "资源", "名单", "管事", "黑影", "纸页", "账页", "暗页", "工具"];
const ACTION_KEYWORDS = ["查账", "调查", "追查", "核实", "问清", "夜探", "隐藏", "转移", "取回", "找到", "确认", "离开", "脱身", "放回", "交还"];
const BROAD_MERGE_KEYWORDS = ["主角", "他", "线索", "事情", "情况", "调查", "确认", "继续", "资源"];
const SPECIFIC_LOCATION_KEYWORDS = ["账房", "库房", "后院", "侧门", "暗格", "墙根", "墙后", "后墙"];
const SPECIFIC_OBJECT_KEYWORDS = ["账本", "账册", "暗页", "残页", "破损信物", "信物", "暗号", "黑影", "名单", "工具"];
const SPECIFIC_ACTION_KEYWORDS = ["查账", "追查", "核实", "问清", "夜探", "隐藏", "转移", "取回", "找到", "离开", "脱身", "放回", "交还"];

function isRelatedToActiveHook(
  thread: NarrativeThread,
  hookMap: ReadonlyMap<string, HookItem>,
): boolean {
  const text = threadText(thread);
  return [...hookMap.values()].some((hook) => hook.status === "active" && hook.title.length > 0 && text.includes(hook.title));
}

function isRelatedToActiveArcGoal(
  thread: NarrativeThread,
  goalMap: ReadonlyMap<string, ArcGoal>,
): boolean {
  const text = threadText(thread);
  return [...goalMap.values()].some((goal) => (goal.status === "active" || goal.status === "touched") && goal.title.length > 0 && text.includes(goal.title));
}

function threadText(thread: NarrativeThread): string {
  return [thread.title, ...thread.evidence, thread.nextActionHint ?? "", ...(thread.relatedCharacters ?? []), ...(thread.relatedLocations ?? [])].join(" ");
}

function pickStatus(threads: readonly NarrativeThread[]): NarrativeThread["status"] {
  if (threads.some((thread) => thread.status === "done")) return "done";
  if (threads.some((thread) => thread.status === "touched")) return "touched";
  if (threads.some((thread) => thread.status === "open")) return "open";
  return "stale";
}

function firstFound<T>(targetIds: readonly string[], map: ReadonlyMap<string, T>): T | undefined {
  return targetIds.map((id) => map.get(id)).find(isDefined);
}

function missingPreview(title: string, targetIds: readonly string[]): ReviewActionPreview {
  return {
    title,
    notes: [
      targetIds.length === 0
        ? "No target id was provided. Nothing can be previewed."
        : `Target id not found: ${targetIds.join(", ")}. Nothing will be applied automatically.`,
    ],
  };
}

function stableReportHash(report: AIReviewReport): string {
  const text = `${report.scope}:${report.summary}:${report.suggestions.map((suggestion) => `${suggestion.action}:${suggestion.targetIds?.join(",") ?? ""}`).join("|")}`;
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36).padStart(6, "0").slice(0, 6);
}

function pad(value: number): string {
  return String(Math.max(0, Math.trunc(value))).padStart(4, "0");
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function sharedKeywords(threads: readonly NarrativeThread[], keywords: readonly string[]): string[] {
  return keywords.filter((keyword) => threads.every((thread) => threadText(thread).includes(keyword)));
}

function buildTitleSimilarityReason(
  threads: readonly NarrativeThread[],
  sharedLocations: readonly string[],
  sharedObjects: readonly string[],
  sharedActions: readonly string[],
): string {
  const pieces = [
    ...(sharedLocations.length > 0 ? [`shared location ${sharedLocations.join("/")}`] : []),
    ...(sharedObjects.length > 0 ? [`shared object ${sharedObjects.join("/")}`] : []),
    ...(sharedActions.length > 0 ? [`shared action ${sharedActions.join("/")}`] : []),
  ];
  if (pieces.length > 0) return pieces.join(", ");
  return titlesLookClose(threads.map((thread) => thread.title)) ? "normalized titles overlap" : "no strong title similarity";
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
