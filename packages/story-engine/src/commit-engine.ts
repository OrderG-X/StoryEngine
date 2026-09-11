import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { constants as fsConstants, realpathSync } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rmdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  attachDiagnostics,
  attachDiagnosticsWarning,
  estimateTextTokens,
  recordContextStats,
  recordRuntimeLatency,
  startRuntimeLatency,
  writeDiagnostics,
  type DiagnosticsRecord,
} from "./diagnostics.js";
import {
  expireStaleArcGoals,
  mergeArcGoalUpdates,
  type ArcGoalUpdate,
  type ExpiredArcGoal,
  type StaleGoalWarning,
} from "./arc-goal-tracking.js";
import {
  mergeHookTrackingUpdates,
  type HookStaleWarning,
  type HookTrackingUpdate,
} from "./hook-tracking.js";
import {
  expireStaleIntents,
  mergeThreadTrackingUpdates,
  type ExpiredIntentThread,
  type StaleThreadWarning,
  type ThreadHygieneReport,
  type ThreadTrackingUpdate,
} from "./lead-intent-tracking.js";
import {
  readCharacterState,
  readAssetLedger,
  readArcGoalPool,
  readCharacterBible,
  readCharacterMatrixLedger,
  readHookPool,
  readLocationBible,
  readStoryCalendar,
  readThreadPool,
  readTimelineEvents,
  readWorldState,
  toSafeCharacterId,
} from "./project-store.js";
import type {
  ArcGoalPool,
  AssetItem,
  AssetLedger,
  CharacterBible,
  CharacterBibleEntry,
  CharacterMatrixEntry,
  CharacterMatrixLedger,
  CharacterState,
  HookItem,
  HookPool,
  LocationBible,
  LocationBibleEntry,
  StoryCalendar,
  ThreadPool,
  TimelineEvent,
  WorldState,
} from "./types.js";

export interface CommitDraftInput {
  readonly projectDir: string;
  readonly chapter: number;
  readonly draftPath?: string;
  /** Immutable draft bytes captured by the caller while holding the project commit lock. */
  readonly draftContent?: string;
  readonly commitPlan: {
    readonly title?: string;
    readonly characterUpdates?: readonly CharacterStateUpdate[];
    readonly timelineEvents?: readonly TimelineEventInput[];
    readonly worldUpdates?: WorldStateUpdate;
    readonly hookUpdates?: readonly HookUpdate[];
    readonly hookTrackingUpdates?: readonly HookTrackingUpdate[];
    readonly staleHookWarnings?: readonly HookStaleWarning[];
    readonly threadTrackingUpdates?: readonly ThreadTrackingUpdate[];
    readonly staleThreadWarnings?: readonly StaleThreadWarning[];
    readonly threadHygieneReport?: ThreadHygieneReport;
    readonly arcGoalUpdates?: readonly ArcGoalUpdate[];
    readonly staleGoalWarnings?: readonly StaleGoalWarning[];
    readonly assetLedgerUpdates?: readonly AssetLedgerUpdate[];
    readonly locationBibleUpdates?: readonly LocationBibleUpdate[];
    readonly characterBibleUpdates?: readonly CharacterBibleUpdate[];
    readonly characterMatrixUpdates?: readonly CharacterMatrixUpdate[];
    readonly calendar?: CalendarUpdate;
  };
}

export interface CharacterStateUpdate {
  readonly characterId: string;
  readonly emotion?: string;
  readonly goal?: string;
  readonly relationshipToUser?: string;
  readonly currentArc?: string;
}

export interface TimelineEventInput {
  readonly summary: string;
  readonly participants: readonly string[];
  readonly effects?: Record<string, unknown>;
}

export interface WorldStateUpdate {
  readonly currentPhase?: string;
  readonly activeConflicts?: readonly string[];
  readonly activeHooks?: readonly string[];
  readonly knownSecrets?: readonly string[];
}

export interface HookUpdate {
  readonly hookId: string;
  readonly status: "seeded" | "active" | "resolved" | "abandoned";
}

export interface CalendarUpdate {
  readonly storyDay: number;
  readonly timeOfDay: StoryCalendar["currentTimeOfDay"];
}

export interface AssetLedgerUpdate {
  readonly id: string;
  readonly name: string;
  readonly type?: AssetItem["type"];
  readonly ownerCharacterId?: string;
  readonly ownerName?: string;
  readonly currentLocationId?: string;
  readonly currentLocationName?: string;
  readonly carriedByCharacterId?: string;
  readonly containerId?: string;
  readonly quantity?: number;
  readonly status?: AssetItem["status"];
  readonly conditionNote?: string;
  readonly isConsumable?: boolean;
  readonly isPlotCritical?: boolean;
  readonly canAiModify?: boolean;
  readonly firstSeenChapter?: number;
  readonly lastSeenChapter?: number;
  readonly rules?: readonly string[];
  readonly notes?: readonly string[];
}

export interface LocationBibleUpdate {
  readonly id: string;
  readonly name: string;
  readonly type?: string;
  readonly parentId?: string;
  readonly parentLocation?: string;
  readonly locationType?: string;
  readonly knownFeatures?: readonly string[];
  readonly risks?: readonly string[];
  readonly resources?: readonly string[];
  readonly connectedLocations?: readonly string[];
  readonly fixedFacts?: readonly string[];
  readonly lastSeenChapter?: number;
  readonly lastKnownState?: string;
}

export interface CharacterBibleUpdate {
  readonly characterId: string;
  readonly name?: string;
  readonly knowledgeKnownAppend?: readonly string[];
  readonly knowledgeUnknownAppend?: readonly string[];
  readonly behaviorBoundariesAppend?: readonly string[];
}

export interface CharacterMatrixUpdate {
  readonly id: string;
  readonly name: string;
  readonly status?: CharacterMatrixEntry["status"];
  readonly roleHint?: string;
  readonly relationToProtagonist?: string;
  readonly riskHint?: string;
  readonly firstSeenChapter?: number;
  readonly lastSeenChapter?: number;
  readonly promotedCharacterId?: string;
  readonly evidence?: readonly string[];
  readonly appearances?: CharacterMatrixEntry["appearances"];
  readonly relationshipEvents?: CharacterMatrixEntry["relationshipEvents"];
}

export interface CommitReport {
  readonly chapter: number;
  readonly passed: boolean;
  readonly chapterPath?: string;
  readonly updatedCharacters: readonly string[];
  readonly timelineEventIds: readonly string[];
  readonly updatedHooks: readonly string[];
  readonly updatedWorld: boolean;
  readonly updatedCalendar: boolean;
  readonly hookTracking?: {
    readonly introducedHooks: readonly string[];
    readonly touchedHooks: readonly string[];
    readonly staleHookWarnings: readonly HookStaleWarning[];
  };
  readonly threadTracking?: {
    readonly introducedThreads: readonly string[];
    readonly touchedThreads: readonly string[];
    readonly staleThreadWarnings: readonly StaleThreadWarning[];
    readonly expiredIntentThreads?: readonly ExpiredIntentThread[];
    readonly threadHygieneReport?: ThreadHygieneReport;
  };
  readonly arcGoalTracking?: {
    readonly introducedGoals: readonly string[];
    readonly touchedGoals: readonly string[];
    readonly completedGoals: readonly string[];
    readonly staleGoalWarnings: readonly StaleGoalWarning[];
    /** 本次入库自动蛰伏的阶段目标（≥15 章未推进的非主线目标）——上层必须如实转达，绝不静默。 */
    readonly expiredArcGoals?: readonly ExpiredArcGoal[];
  };
  readonly diagnostics?: DiagnosticsRecord;
  readonly issues: readonly string[];
}

export interface CommitTransactionManifest {
  readonly version: 2;
  readonly chapter: number;
  readonly createdAt: string;
  readonly files: readonly string[];
  readonly backups: readonly CommitTransactionBackup[];
  readonly status: "staged" | "applied" | "failed" | "recovered";
}

export interface CommitTransactionBackup {
  readonly relativePath: string;
  readonly existed: boolean;
  readonly backupPath?: string;
  readonly sha256?: string;
}

interface TransactionFile {
  readonly relativePath: string;
  readonly content: string;
}

const commitTransactionTails = new Map<string, Promise<void>>();
interface CommitLockContext {
  readonly projects: ReadonlySet<string>;
  active: boolean;
}
const heldCommitProjects = new AsyncLocalStorage<CommitLockContext>();

export type CommitIoTestPhase = "after-precheck-before-open" | "after-open-before-verify";
type CommitIoTestHook = (phase: CommitIoTestPhase, targetPath: string) => Promise<void> | void;
let commitIoTestHook: CommitIoTestHook | undefined;

/** Deterministic race injection for filesystem safety regression tests only. */
export function setCommitIoTestHookForTests(hook: CommitIoTestHook | undefined): void {
  commitIoTestHook = hook;
}

export async function commitFastDraft(input: CommitDraftInput): Promise<CommitReport> {
  return withProjectCommitLock(input.projectDir, async () => {
    try {
      await recoverProjectCommitTransactionsUnlocked(input.projectDir);
    } catch (error) {
      return withCommitDiagnostics(
        input.projectDir,
        failedReport(input.chapter, [error instanceof Error ? error.message : String(error)]),
        startRuntimeLatency(),
        input.draftContent,
      );
    }
    return commitFastDraftUnlocked(input);
  });
}

async function commitFastDraftUnlocked(input: CommitDraftInput): Promise<CommitReport> {
  const latencyTimer = startRuntimeLatency();
  const draftPath = input.draftPath ?? defaultDraftPath(input.projectDir, input.chapter);
  const issues: string[] = [];
  const draft = input.draftContent !== undefined
    ? input.draftContent
    : await readFile(draftPath, "utf-8").catch((error: unknown) => {
      issues.push(error instanceof Error ? error.message : String(error));
      return undefined;
    });
  if (!draft) return withCommitDiagnostics(input.projectDir, failedReport(input.chapter, issues), latencyTimer);

  const characterUpdates = input.commitPlan.characterUpdates ?? [];
  const hookUpdates = input.commitPlan.hookUpdates ?? [];
  const hookTrackingUpdates = input.commitPlan.hookTrackingUpdates ?? [];
  const threadTrackingUpdates = input.commitPlan.threadTrackingUpdates ?? [];
  const arcGoalUpdates = input.commitPlan.arcGoalUpdates ?? [];
  const [characterStates, hookPool, threadPool, arcGoalPool] = await Promise.all([
    readExistingCharacterStates(input.projectDir, characterUpdates, issues),
    readHookPool(input.projectDir).catch((error: unknown) => {
      issues.push(error instanceof Error ? error.message : String(error));
      return undefined;
    }),
    readThreadPool(input.projectDir).catch((error: unknown) => {
      issues.push(error instanceof Error ? error.message : String(error));
      return undefined;
    }),
    readArcGoalPool(input.projectDir).catch((error: unknown) => {
      issues.push(error instanceof Error ? error.message : String(error));
      return undefined;
    }),
  ]);
  const unknownHookIds = hookPool ? findUnknownHookIds(hookPool, hookUpdates) : hookUpdates.map((update) => update.hookId);
  for (const hookId of unknownHookIds) {
    issues.push(`Hook not found: ${hookId}`);
  }
  if (issues.length > 0 || !hookPool || !threadPool || !arcGoalPool) {
    return withCommitDiagnostics(input.projectDir, failedReport(input.chapter, issues), latencyTimer, draft);
  }

  const timelineEvents = await buildTimelineEvents(input.projectDir, input.chapter, input.commitPlan.timelineEvents ?? []);
  const threadPoolFiles = buildThreadPoolFiles(input.chapter, threadPool, threadTrackingUpdates);
  const arcGoalPoolFiles = buildArcGoalPoolFiles(input.chapter, arcGoalPool, arcGoalUpdates);
  const transactionFiles = [
    ...buildCharacterStateFiles(input.chapter, characterStates, characterUpdates),
    ...(timelineEvents.file ? [timelineEvents.file] : []),
    ...(await buildWorldStateFile(input.projectDir, input.chapter, input.commitPlan.worldUpdates)),
    ...buildHookPoolFiles(hookPool, hookUpdates, hookTrackingUpdates),
    ...threadPoolFiles.files,
    ...arcGoalPoolFiles.files,
    ...(await buildAssetLedgerFile(input.projectDir, input.chapter, input.commitPlan.assetLedgerUpdates ?? [])),
    ...(await buildLocationBibleFile(input.projectDir, input.chapter, input.commitPlan.locationBibleUpdates ?? [])),
    ...(await buildCharacterBibleFile(input.projectDir, input.commitPlan.characterBibleUpdates ?? [])),
    ...(await buildCharacterMatrixFile(input.projectDir, input.chapter, input.commitPlan.characterMatrixUpdates ?? [])),
    ...(await buildStoryCalendarFile(input.projectDir, input.commitPlan.calendar)),
    {
      relativePath: join("chapters", `${padChapter(input.chapter)}.md`),
      content: draft,
    },
  ];
  const transaction = await stageCommitTransaction(input.projectDir, input.chapter, transactionFiles)
    .catch((error: unknown) => undefinedWithIssue(error, issues));
  if (!transaction) {
    return withCommitDiagnostics(input.projectDir, failedReport(input.chapter, issues), latencyTimer, draft);
  }
  const applyResult = await applyCommitTransaction(input.projectDir, transaction);
  if (!applyResult.passed) {
    return withCommitDiagnostics(input.projectDir, failedReport(input.chapter, applyResult.issues), latencyTimer, draft);
  }

  const chapterPath = join(input.projectDir, "chapters", `${padChapter(input.chapter)}.md`);

  return withCommitDiagnostics(input.projectDir, {
    chapter: input.chapter,
    passed: true,
    chapterPath,
    updatedCharacters: characterUpdates.map((update) => toSafeCharacterId(update.characterId)),
    timelineEventIds: timelineEvents.events.map((event) => event.id),
    updatedHooks: unique([...hookUpdates.map((update) => update.hookId), ...hookTrackingUpdates.map((update) => update.id)]),
    updatedWorld: input.commitPlan.worldUpdates !== undefined,
    updatedCalendar: input.commitPlan.calendar !== undefined,
    ...(hookTrackingUpdates.length > 0 || (input.commitPlan.staleHookWarnings?.length ?? 0) > 0
      ? {
        hookTracking: {
          introducedHooks: hookTrackingUpdates
            .filter((update) => !hookPool.hooks.some((hook) => hook.id === update.id))
            .map((update) => update.id),
          touchedHooks: hookTrackingUpdates.map((update) => update.id),
          staleHookWarnings: input.commitPlan.staleHookWarnings ?? [],
        },
      }
      : {}),
    ...(threadTrackingUpdates.length > 0 || (input.commitPlan.staleThreadWarnings?.length ?? 0) > 0 || threadPoolFiles.expiredIntentThreads.length > 0
      ? {
        threadTracking: {
          introducedThreads: threadTrackingUpdates
            .filter((update) => !threadPool.threads.some((thread) => thread.id === update.id))
            .map((update) => update.id),
          touchedThreads: threadTrackingUpdates.map((update) => update.id),
          staleThreadWarnings: input.commitPlan.staleThreadWarnings ?? [],
          ...(threadPoolFiles.expiredIntentThreads.length > 0
            ? { expiredIntentThreads: threadPoolFiles.expiredIntentThreads }
            : {}),
          ...(input.commitPlan.threadHygieneReport !== undefined
            ? { threadHygieneReport: input.commitPlan.threadHygieneReport }
            : {}),
        },
      }
      : {}),
    ...(arcGoalUpdates.length > 0 || (input.commitPlan.staleGoalWarnings?.length ?? 0) > 0 || arcGoalPoolFiles.expiredArcGoals.length > 0
      ? {
        arcGoalTracking: {
          introducedGoals: arcGoalUpdates
            .filter((update) => !arcGoalPool.goals.some((goal) => goal.id === update.id))
            .map((update) => update.id),
          touchedGoals: arcGoalUpdates.map((update) => update.id),
          completedGoals: arcGoalUpdates.filter((update) => update.status === "completed").map((update) => update.id),
          staleGoalWarnings: input.commitPlan.staleGoalWarnings ?? [],
          ...(arcGoalPoolFiles.expiredArcGoals.length > 0
            ? { expiredArcGoals: arcGoalPoolFiles.expiredArcGoals }
            : {}),
        },
      }
      : {}),
    issues: [],
  }, latencyTimer, draft);
}

/**
 * Canonical, re-entrant project-wide formal-state lock. Shared ledgers are
 * project scoped, so chapter-scoped locks are insufficient.
 */
export async function withProjectCommitLock<T>(projectDir: string, task: () => Promise<T>): Promise<T> {
  // Canonicalize synchronously so aliases share a lock without inserting an
  // await that could invert invocation order.
  let key: string;
  try {
    key = realpathSync.native(projectDir);
  } catch {
    key = resolve(projectDir);
  }
  const held = heldCommitProjects.getStore();
  if (held?.active && held.projects.has(key)) return task();
  const previous = commitTransactionTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  commitTransactionTails.set(key, tail);
  await previous;
  const context: CommitLockContext = {
    projects: new Set([...(held?.projects ?? []), key]),
    active: true,
  };
  try {
    return await heldCommitProjects.run(context, task);
  } finally {
    context.active = false;
    release();
    if (commitTransactionTails.get(key) === tail) {
      commitTransactionTails.delete(key);
    }
  }
}

/** Recover every engine commit residue before any caller reads formal state. */
export async function recoverProjectCommitTransactions(projectDir: string): Promise<void> {
  return withProjectCommitLock(projectDir, () => recoverProjectCommitTransactionsUnlocked(projectDir));
}

async function withCommitDiagnostics(
  projectDir: string,
  report: CommitReport,
  latencyTimer: ReturnType<typeof startRuntimeLatency>,
  draft?: string,
): Promise<CommitReport> {
  const draftTokenEstimate = draft ? estimateTextTokens(draft) : 0;
  const commitPlanTokenEstimate = estimateTextTokens(JSON.stringify({
    updatedCharacters: report.updatedCharacters,
    timelineEventIds: report.timelineEventIds,
    updatedHooks: report.updatedHooks,
    updatedWorld: report.updatedWorld,
    updatedCalendar: report.updatedCalendar,
  }));
  const contextStats = recordContextStats({
    totalTokenEstimate: draftTokenEstimate + commitPlanTokenEstimate,
    stableTokenEstimate: 0,
    dynamicTokenEstimate: draftTokenEstimate + commitPlanTokenEstimate,
    contextSections: draft ? ["draft", "commit_summary"] : ["commit_summary"],
  });
  try {
    const diagnostics = await writeDiagnostics(projectDir, {
      stage: "commit",
      chapter: report.chapter,
      generatedAt: new Date().toISOString(),
      runtimeLatency: recordRuntimeLatency(latencyTimer),
      contextStats,
      details: {
        passed: report.passed,
        chapterPath: report.chapterPath,
        updatedCharacterCount: report.updatedCharacters.length,
        timelineEventCount: report.timelineEventIds.length,
        updatedHookCount: report.updatedHooks.length,
        ...(report.hookTracking !== undefined
          ? {
            hookTracking: {
              introducedHooks: report.hookTracking.introducedHooks,
              touchedHooks: report.hookTracking.touchedHooks,
              staleHookWarnings: report.hookTracking.staleHookWarnings,
            },
          }
          : {}),
        ...(report.threadTracking !== undefined
          ? {
            threadTracking: {
              introducedThreads: report.threadTracking.introducedThreads,
              touchedThreads: report.threadTracking.touchedThreads,
              staleThreadWarnings: report.threadTracking.staleThreadWarnings,
              expiredIntentThreads: report.threadTracking.expiredIntentThreads,
              threadHygieneReport: report.threadTracking.threadHygieneReport,
            },
          }
          : {}),
        ...(report.arcGoalTracking !== undefined
          ? {
            arcGoalTracking: {
              introducedGoals: report.arcGoalTracking.introducedGoals,
              touchedGoals: report.arcGoalTracking.touchedGoals,
              completedGoals: report.arcGoalTracking.completedGoals,
              staleGoalWarnings: report.arcGoalTracking.staleGoalWarnings,
              expiredArcGoals: report.arcGoalTracking.expiredArcGoals,
            },
          }
          : {}),
        issueCount: report.issues.length,
      },
    });
    return attachDiagnostics(report, diagnostics);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return attachDiagnosticsWarning(report, `commit diagnostics write failed: ${detail}`);
  }
}

function defaultDraftPath(projectDir: string, chapter: number): string {
  return join(projectDir, "drafts", "fast", `chapter-${padChapter(chapter)}.md`);
}

function failedReport(chapter: number, issues: readonly string[]): CommitReport {
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

function undefinedWithIssue(error: unknown, issues: string[]): undefined {
  issues.push(error instanceof Error ? error.message : String(error));
  return undefined;
}

async function readExistingCharacterStates(
  projectDir: string,
  updates: readonly CharacterStateUpdate[],
  issues: string[],
): Promise<ReadonlyMap<string, CharacterState>> {
  const entries = await Promise.all(updates.map(async (update) => {
    const characterId = toSafeCharacterId(update.characterId);
    const state = await readCharacterState(projectDir, characterId).catch((error: unknown) => {
      issues.push(error instanceof Error ? error.message : String(error));
      return undefined;
    });
    return [characterId, state] as const;
  }));
  return new Map(entries.filter((entry): entry is readonly [string, CharacterState] => entry[1] !== undefined));
}

function buildCharacterStateFiles(
  chapter: number,
  states: ReadonlyMap<string, CharacterState>,
  updates: readonly CharacterStateUpdate[],
): readonly TransactionFile[] {
  return updates.flatMap((update) => {
    const characterId = toSafeCharacterId(update.characterId);
    const previous = states.get(characterId);
    if (!previous) return [];
    const next: CharacterState = {
      ...previous,
      characterId,
      ...(update.emotion !== undefined ? { emotion: update.emotion } : {}),
      ...(update.goal !== undefined ? { goal: update.goal } : {}),
      ...(update.relationshipToUser !== undefined ? { relationshipToUser: update.relationshipToUser } : {}),
      ...(update.currentArc !== undefined ? { currentArc: update.currentArc } : {}),
      lastUpdatedChapter: chapter,
    };
    return [{
      relativePath: join("characters", characterId, "state.json"),
      content: jsonText(next),
    }];
  });
}

async function buildAssetLedgerFile(
  projectDir: string,
  chapter: number,
  updates: readonly AssetLedgerUpdate[],
): Promise<readonly TransactionFile[]> {
  if (updates.length === 0) return [];
  const previous = await readAssetLedger(projectDir);
  const byKey = new Map(previous.assets.map((asset) => [asset.id || asset.name, asset]));
  for (const update of updates) {
    const key = update.id || update.name;
    const existing = byKey.get(key) ?? previous.assets.find((asset) => asset.name === update.name);
    const next: AssetItem = {
      ...(existing ?? {
        id: update.id,
        name: update.name,
        type: update.type ?? "item",
        status: update.status ?? "available",
      }),
      id: existing?.id ?? update.id,
      name: update.name,
      ...(update.type !== undefined ? { type: update.type } : {}),
      ...(update.ownerCharacterId !== undefined ? { ownerCharacterId: update.ownerCharacterId } : {}),
      ...(update.ownerName !== undefined ? { ownerName: update.ownerName } : {}),
      ...(update.currentLocationId !== undefined ? { currentLocationId: update.currentLocationId } : {}),
      ...(update.currentLocationName !== undefined ? { currentLocationName: update.currentLocationName } : {}),
      ...(update.carriedByCharacterId !== undefined ? { carriedByCharacterId: update.carriedByCharacterId } : {}),
      ...(update.containerId !== undefined ? { containerId: update.containerId } : {}),
      ...(update.quantity !== undefined ? { quantity: update.quantity } : {}),
      ...(update.status !== undefined ? { status: update.status } : {}),
      ...(update.conditionNote !== undefined ? { conditionNote: update.conditionNote } : {}),
      ...(update.isConsumable !== undefined ? { isConsumable: update.isConsumable } : {}),
      ...(update.isPlotCritical !== undefined ? { isPlotCritical: update.isPlotCritical } : {}),
      ...(update.canAiModify !== undefined ? { canAiModify: mergeCanAiModify(existing?.canAiModify, update.canAiModify) } : {}),
      ...(update.firstSeenChapter !== undefined ? { firstSeenChapter: update.firstSeenChapter } : existing?.firstSeenChapter === undefined ? { firstSeenChapter: chapter } : {}),
      lastSeenChapter: update.lastSeenChapter ?? chapter,
      rules: mergeUnique(existing?.rules ?? [], update.rules),
      notes: mergeUnique(existing?.notes ?? [], update.notes),
    };
    byKey.set(next.id, next);
  }
  const nextLedger: AssetLedger = {
    ...previous,
    version: "v0",
    assets: [...byKey.values()],
    containers: previous.containers ?? [],
  };
  return [{
    relativePath: join("story", "assets.json"),
    content: jsonText(nextLedger),
  }];
}

async function buildLocationBibleFile(
  projectDir: string,
  chapter: number,
  updates: readonly LocationBibleUpdate[],
): Promise<readonly TransactionFile[]> {
  if (updates.length === 0) return [];
  const previous = await readLocationBible(projectDir) ?? { version: "v0", locations: [] };
  const byKey = new Map(previous.locations.map((location) => [location.id || location.name, location]));
  for (const update of updates) {
    const key = update.id || update.name;
    const existing = byKey.get(key) ?? previous.locations.find((location) => location.name === update.name);
    const next: LocationBibleEntry = {
      ...(existing ?? {
        id: update.id,
        name: update.name,
        type: update.type ?? "candidate",
        knownFeatures: [],
        risks: [],
        resources: [],
      }),
      id: existing?.id ?? update.id,
      name: update.name,
      type: update.type ?? existing?.type ?? "candidate",
      ...(update.parentId !== undefined ? { parentId: update.parentId } : {}),
      ...(update.parentLocation !== undefined ? { parentLocation: update.parentLocation } : {}),
      ...(update.locationType !== undefined ? { locationType: update.locationType } : {}),
      knownFeatures: mergeUnique(existing?.knownFeatures ?? [], update.knownFeatures),
      risks: mergeUnique(existing?.risks ?? [], update.risks),
      resources: mergeUnique(existing?.resources ?? [], update.resources),
      connectedLocations: mergeUnique(existing?.connectedLocations ?? [], update.connectedLocations),
      fixedFacts: mergeUnique(existing?.fixedFacts ?? [], update.fixedFacts),
      lastSeenChapter: update.lastSeenChapter ?? chapter,
      ...(update.lastKnownState !== undefined ? { lastKnownState: update.lastKnownState } : existing?.lastKnownState !== undefined ? { lastKnownState: existing.lastKnownState } : {}),
    };
    byKey.set(next.id, next);
  }
  const nextBible: LocationBible = {
    ...previous,
    version: "v0",
    locations: [...byKey.values()],
  };
  return [{
    relativePath: join("story", "location-bible.json"),
    content: jsonText(nextBible),
  }];
}

async function buildCharacterBibleFile(
  projectDir: string,
  updates: readonly CharacterBibleUpdate[],
): Promise<readonly TransactionFile[]> {
  if (updates.length === 0) return [];
  const previous = await readCharacterBible(projectDir);
  if (!previous) return [];
  const byKey = new Map(previous.characters.map((character) => [toSafeCharacterId(character.id || character.name), character]));
  for (const update of updates) {
    const key = toSafeCharacterId(update.characterId);
    const existing = byKey.get(key) ?? previous.characters.find((character) => character.name === update.name);
    if (!existing) continue;
    const next: CharacterBibleEntry = {
      ...existing,
      knowledgeKnown: mergeUnique(existing.knowledgeKnown ?? [], update.knowledgeKnownAppend),
      knowledgeUnknown: mergeUnique(existing.knowledgeUnknown ?? [], update.knowledgeUnknownAppend),
      behaviorBoundaries: mergeUnique(existing.behaviorBoundaries ?? [], update.behaviorBoundariesAppend),
    };
    byKey.set(toSafeCharacterId(next.id || next.name), next);
  }
  const nextBible: CharacterBible = {
    ...previous,
    version: "v0",
    characters: [...byKey.values()],
  };
  return [{
    relativePath: join("story", "character-bible.json"),
    content: jsonText(nextBible),
  }];
}

async function buildCharacterMatrixFile(
  projectDir: string,
  chapter: number,
  updates: readonly CharacterMatrixUpdate[],
): Promise<readonly TransactionFile[]> {
  if (updates.length === 0) return [];
  const previous = await readCharacterMatrixLedger(projectDir);
  const byKey = new Map(previous.entries.map((entry) => [entry.id || entry.name, entry]));
  for (const update of updates) {
    const key = update.id || update.name;
    const existing = byKey.get(key) ?? previous.entries.find((entry) => entry.name === update.name);
    const next: CharacterMatrixEntry = {
      ...(existing ?? {
        id: update.id,
        name: update.name,
        status: update.status ?? "candidate",
        evidence: [],
        appearances: [],
        relationshipEvents: [],
      }),
      id: existing?.id ?? update.id,
      name: update.name,
      status: mergeCharacterMatrixStatus(existing?.status, update.status),
      ...(update.roleHint !== undefined ? { roleHint: update.roleHint } : existing?.roleHint !== undefined ? { roleHint: existing.roleHint } : {}),
      ...(update.relationToProtagonist !== undefined ? { relationToProtagonist: update.relationToProtagonist } : existing?.relationToProtagonist !== undefined ? { relationToProtagonist: existing.relationToProtagonist } : {}),
      ...(update.riskHint !== undefined ? { riskHint: update.riskHint } : existing?.riskHint !== undefined ? { riskHint: existing.riskHint } : {}),
      firstSeenChapter: existing?.firstSeenChapter ?? update.firstSeenChapter ?? chapter,
      lastSeenChapter: update.lastSeenChapter ?? chapter,
      ...(update.promotedCharacterId !== undefined ? { promotedCharacterId: update.promotedCharacterId } : existing?.promotedCharacterId !== undefined ? { promotedCharacterId: existing.promotedCharacterId } : {}),
      evidence: mergeUnique(existing?.evidence ?? [], update.evidence),
      appearances: mergeUniqueRecords(existing?.appearances ?? [], update.appearances, (item) => `${item.chapter}:${item.evidence}`),
      relationshipEvents: mergeUniqueRecords(existing?.relationshipEvents ?? [], update.relationshipEvents, (item) => `${item.chapter}:${item.evidence}`),
    };
    byKey.set(next.id, next);
  }
  const nextLedger: CharacterMatrixLedger = {
    ...previous,
    version: "v0",
    entries: [...byKey.values()],
  };
  return [{
    relativePath: join("story", "character-matrix.json"),
    content: jsonText(nextLedger),
  }];
}

function mergeCanAiModify(existing: boolean | undefined, patch: boolean): boolean {
  return existing === false && patch === true ? false : patch;
}

function mergeCharacterMatrixStatus(
  existing: CharacterMatrixEntry["status"] | undefined,
  patch: CharacterMatrixEntry["status"] | undefined,
): CharacterMatrixEntry["status"] {
  if ((existing === "accepted" || existing === "promoted" || existing === "ignored") && patch === "candidate") {
    return existing;
  }
  return patch ?? existing ?? "candidate";
}

async function buildTimelineEvents(
  projectDir: string,
  chapter: number,
  inputs: readonly TimelineEventInput[],
): Promise<{ readonly events: readonly TimelineEvent[]; readonly file?: TransactionFile }> {
  if (inputs.length === 0) return { events: [] };
  const existing = await readTimelineEvents(projectDir);
  const newEvents = inputs.map((input, index): TimelineEvent => ({
    id: `ch${padChapter(chapter)}-${String(index + 1).padStart(3, "0")}`,
    chapter,
    summary: input.summary,
    participants: input.participants,
    ...(input.effects !== undefined ? { effects: input.effects } : {}),
  }));
  const nextEvents = [
    ...existing.filter((event) => event.chapter !== chapter),
    ...newEvents,
  ];
  return {
    events: newEvents,
    file: {
      relativePath: join("timeline", "events.json"),
      content: jsonText(nextEvents),
    },
  };
}

async function buildWorldStateFile(
  projectDir: string,
  chapter: number,
  update: WorldStateUpdate | undefined,
): Promise<readonly TransactionFile[]> {
  if (!update) return [];
  const previous = await readWorldState(projectDir);
  const next: WorldState = {
    ...previous,
    ...(update.currentPhase !== undefined ? { currentPhase: update.currentPhase } : {}),
    activeConflicts: mergeUnique(previous.activeConflicts, update.activeConflicts),
    activeHooks: mergeUnique(previous.activeHooks, update.activeHooks),
    knownSecrets: mergeUnique(previous.knownSecrets, update.knownSecrets),
    lastUpdatedChapter: chapter,
  };
  return [{
    relativePath: join("world", "state.json"),
    content: jsonText(next),
  }];
}

function buildHookPoolFiles(
  previous: HookPool,
  updates: readonly HookUpdate[],
  trackingUpdates: readonly HookTrackingUpdate[],
): readonly TransactionFile[] {
  if (updates.length === 0 && trackingUpdates.length === 0) return [];
  const updateMap = new Map<string, HookItem["status"]>(updates.map((update) => [update.hookId, update.status]));
  const next = mergeHookTrackingUpdates(previous, trackingUpdates, updateMap);
  return [{
    relativePath: join("story", "hooks.json"),
    content: jsonText(next),
  }];
}

function buildThreadPoolFiles(
  chapter: number,
  previous: ThreadPool,
  trackingUpdates: readonly ThreadTrackingUpdate[],
): { readonly files: readonly TransactionFile[]; readonly expiredIntentThreads: readonly ExpiredIntentThread[] } {
  const merged = trackingUpdates.length > 0 ? mergeThreadTrackingUpdates(previous, trackingUpdates) : previous;
  const expired = expireStaleIntents({ pool: merged, chapter });
  if (trackingUpdates.length === 0 && expired.expired.length === 0) {
    return { files: [], expiredIntentThreads: [] };
  }
  return {
    files: [{
      relativePath: join("story", "threads.json"),
      content: jsonText(expired.pool),
    }],
    expiredIntentThreads: expired.expired,
  };
}

function buildArcGoalPoolFiles(
  chapter: number,
  previous: ArcGoalPool,
  trackingUpdates: readonly ArcGoalUpdate[],
): { readonly files: readonly TransactionFile[]; readonly expiredArcGoals: readonly ExpiredArcGoal[] } {
  const merged = trackingUpdates.length > 0 ? mergeArcGoalUpdates(previous, trackingUpdates) : previous;
  // r7：merge 完成后对结果池做阶段目标自动蛰伏（非主线、≥15 章未推进 → stale），expired 供 report 如实披露。
  const expired = expireStaleArcGoals({ pool: merged, chapter });
  if (trackingUpdates.length === 0 && expired.expired.length === 0) {
    return { files: [], expiredArcGoals: [] };
  }
  const next = expired.pool;
  return {
    files: [{
      relativePath: join("story", "arc-goals.json"),
      content: jsonText(next),
    }],
    expiredArcGoals: expired.expired,
  };
}

async function buildStoryCalendarFile(
  projectDir: string,
  update: CalendarUpdate | undefined,
): Promise<readonly TransactionFile[]> {
  if (!update) return [];
  const previous = await readStoryCalendar(projectDir);
  const next: StoryCalendar = {
    ...previous,
    currentStoryDay: update.storyDay,
    currentTimeOfDay: update.timeOfDay,
  };
  return [{
    relativePath: join("time", "calendar.json"),
    content: jsonText(next),
  }];
}

async function stageCommitTransaction(
  projectDir: string,
  chapter: number,
  files: readonly TransactionFile[],
): Promise<{
  readonly txDir: string;
  readonly files: readonly TransactionFile[];
  readonly manifest: CommitTransactionManifest;
}> {
  const txRoot = join(projectDir, ".story-engine-tx");
  await ensureSafeDirectory(projectDir, txRoot, true, "commit transaction root");
  const txDir = join(txRoot, `commit-chapter-${padChapter(chapter)}`);
  await recoverCommitTransactionResidue(projectDir, txDir, chapter);
  assertUniqueSafeTransactionFiles(files);
  await ensureSafeDirectory(projectDir, txDir, true, "commit transaction directory");
  const backups = await createCommitTransactionBackups(projectDir, txDir, files);
  const manifest: CommitTransactionManifest = {
    version: 2,
    chapter,
    createdAt: new Date().toISOString(),
    files: files.map((file) => file.relativePath),
    backups,
    status: "staged",
  };
  // Persist recovery truth before staging the new payload. If the process dies
  // at any later point, the next commit can restore every target deterministically.
  await writeManifest(projectDir, txDir, manifest);
  for (const file of files) {
    const stagedPath = join(txDir, file.relativePath);
    await ensureSafeDirectory(projectDir, dirname(stagedPath), true, "commit staging directory");
    await writeTextNoFollow(projectDir, stagedPath, file.content, "commit staging target");
  }
  return { txDir, files, manifest };
}

async function applyCommitTransaction(
  projectDir: string,
  transaction: {
    readonly txDir: string;
    readonly files: readonly TransactionFile[];
    readonly manifest: CommitTransactionManifest;
  },
): Promise<{ readonly passed: true } | { readonly passed: false; readonly issues: readonly string[] }> {
  try {
    for (const file of transaction.files) {
      const targetPath = join(projectDir, file.relativePath);
      await ensureSafeDirectory(projectDir, dirname(targetPath), true, "formal target parent");
      await writeTextNoFollow(projectDir, targetPath, file.content, "formal target");
    }
    await writeManifest(projectDir, transaction.txDir, {
      ...transaction.manifest,
      status: "applied",
    });
  } catch (error) {
    const rollbackIssues = await restoreCommitTransactionBackups(
      projectDir,
      transaction.txDir,
      transaction.manifest.backups,
    );
    await writeManifest(projectDir, transaction.txDir, {
      ...transaction.manifest,
      status: "failed",
    }).catch(() => undefined);
    return {
      passed: false,
      issues: [
        error instanceof Error ? error.message : String(error),
        ...rollbackIssues,
      ],
    };
  }
  // Preserve the applied manifest and backups as durable evidence. Recursive
  // path cleanup cannot be made race-free with Node's fs API (no unlinkat).
  // A later transaction reuses this manifest-controlled directory safely.
  return { passed: true };
}

/**
 * Snapshot undo (git restore) unlinks every file a finalized transaction left
 * behind — git tracks files, not directories — leaving a zero-file shell with
 * no manifest. An empty shell holds no recovery evidence, so it is safe to
 * drop; anything containing files (or symlinks) must still fail closed.
 */
async function isZeroFileDirectoryShell(dir: string): Promise<boolean> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) return false;
    if (!(await isZeroFileDirectoryShell(join(dir, entry.name)))) return false;
  }
  return true;
}

/**
 * Remove a verified zero-file shell bottom-up. rmdir(2) only removes empty
 * directories, so a file racing back in fails the cleanup instead of being
 * deleted — recursive rm cannot offer that guarantee (no unlinkat).
 */
async function removeZeroFileDirectoryShell(dir: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      await removeZeroFileDirectoryShell(join(dir, entry.name));
    }
  }
  await rmdir(dir);
}

async function recoverProjectCommitTransactionsUnlocked(projectDir: string): Promise<void> {
  const txRoot = join(projectDir, ".story-engine-tx");
  let rootStats;
  try {
    rootStats = await lstat(txRoot);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error(`Unsafe commit transaction root at ${txRoot}; refusing formal-state reads.`);
  }
  const entries = await readdir(txRoot, { withFileTypes: true });
  for (const entry of entries) {
    const match = /^commit-chapter-(\d+)$/u.exec(entry.name);
    if (!match) continue;
    const txDir = join(txRoot, entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`Unsafe commit transaction residue at ${txDir}; refusing formal-state reads.`);
    }
    const chapter = Number(match[1]);
    // Historical finalized snapshot scaffolds use snapshot-manifest.json and
    // intentionally remain as audit evidence. Engine transactions always own
    // manifest.json; only those are recoverable here.
    const hasEngineManifest = await lstat(join(txDir, "manifest.json"))
      .then((stats) => stats.isFile() && !stats.isSymbolicLink())
      .catch((error: unknown) => {
        if (isNodeError(error) && error.code === "ENOENT") return false;
        throw error;
      });
    if (!hasEngineManifest) {
      const snapshotManifestPath = join(txDir, "snapshot-manifest.json");
      const hasSnapshotManifest = await lstat(snapshotManifestPath)
        .then((stats) => stats.isFile() && !stats.isSymbolicLink())
        .catch(() => false);
      if (hasSnapshotManifest) {
        await validateSnapshotOnlyCommitResidue(snapshotManifestPath, entry.name, chapter);
        continue;
      }
      // Zero-file shells (e.g. undo unlinked every staged file) carry no
      // evidence; drop them instead of bricking the project. Cleanup uses
      // rmdir-only primitives — if a file raced back in, removal fails and
      // the fail-closed throw below still applies.
      if (await isZeroFileDirectoryShell(txDir)) {
        try {
          await removeZeroFileDirectoryShell(txDir);
          continue;
        } catch {
          // Fall through to the fail-closed throw.
        }
      }
      throw new Error(`Unreadable commit transaction residue at ${txDir}; refusing formal-state reads.`);
    }
    await recoverCommitTransactionResidue(projectDir, txDir, chapter);
  }
}

async function validateSnapshotOnlyCommitResidue(
  manifestPath: string,
  transactionId: string,
  chapter: number,
): Promise<void> {
  if (transactionId !== `commit-chapter-${padChapter(chapter)}` || chapter <= 0) {
    throw new Error(`Unsafe snapshot-only commit residue id: ${transactionId}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(manifestPath, "utf-8")) as unknown;
  } catch (error) {
    throw new Error(`Unreadable snapshot-only commit manifest at ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) throw new Error(`Invalid snapshot-only commit manifest at ${manifestPath}`);
  const expectedChapterPath = `chapters/${padChapter(chapter)}.md`;
  if (
    parsed.status !== "finalized"
    || parsed.chapter !== chapter
    || typeof parsed.finalizedAt !== "string"
    || !Number.isFinite(Date.parse(parsed.finalizedAt))
    || parsed.noFormalStateWriteConfirmed !== true
    || parsed.productionApplyImplemented !== false
    || parsed.routeWired !== true
    || parsed.formalApplyMode !== "chapter_only_v0a"
    || parsed.stateWritesEnabled !== false
    || parsed.defaultFormalWritesEnabled !== false
    || parsed.cleanupPerformed !== false
    || !Array.isArray(parsed.files)
    || !Array.isArray(parsed.appliedChangedFiles)
    || parsed.files.length !== 1
    || parsed.appliedChangedFiles.length !== 1
    || parsed.appliedChangedFiles[0] !== expectedChapterPath
  ) {
    throw new Error(`Invalid snapshot-only commit manifest at ${manifestPath}`);
  }
  const file = parsed.files[0];
  if (!isRecord(file) || file.relativePath !== expectedChapterPath) {
    throw new Error(`Unsafe snapshot-only commit target at ${manifestPath}`);
  }
  const validRollback = file.rollbackAction === "delete_if_created"
    ? file.snapshotPath == null
    : file.rollbackAction === "restore_previous"
      && file.snapshotPath === `.story-engine-tx/${transactionId}/snapshot/${expectedChapterPath}`
      && typeof file.byteLength === "number"
      && Number.isSafeInteger(file.byteLength)
      && file.byteLength >= 0
      && typeof file.sha256 === "string"
      && /^[0-9a-f]{64}$/u.test(file.sha256);
  if (!validRollback) throw new Error(`Invalid snapshot-only commit rollback metadata at ${manifestPath}`);
}

async function recoverCommitTransactionResidue(
  projectDir: string,
  txDir: string,
  expectedChapter: number,
): Promise<void> {
  let stats;
  try {
    stats = await lstat(txDir);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Unsafe commit transaction residue at ${txDir}; refusing to delete or overwrite it.`);
  }

  let parsed: unknown;
  try {
    const manifestPath = join(txDir, "manifest.json");
    await assertSafeProjectPath(projectDir, manifestPath, false, "commit transaction manifest");
    parsed = JSON.parse(await readFile(manifestPath, "utf-8")) as unknown;
  } catch (error) {
    throw new Error(
      `Unreadable commit transaction residue at ${txDir}; refusing to delete it: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const manifest = parseRecoverableCommitManifest(parsed, expectedChapter);
  if (!manifest) {
    throw new Error(`Unrecoverable commit transaction manifest at ${txDir}; refusing to delete or overwrite it.`);
  }

  if (manifest.status === "recovered") return;
  if (manifest.status !== "applied") {
    const rollbackIssues = await restoreCommitTransactionBackups(projectDir, txDir, manifest.backups);
    if (rollbackIssues.length > 0) {
      throw new Error(`Commit transaction recovery failed: ${rollbackIssues.join("; ")}`);
    }
  }
  await writeManifest(projectDir, txDir, { ...manifest, status: "recovered" });
}

async function createCommitTransactionBackups(
  projectDir: string,
  txDir: string,
  files: readonly TransactionFile[],
): Promise<readonly CommitTransactionBackup[]> {
  const backups: CommitTransactionBackup[] = [];
  for (const file of files) {
    const targetPath = join(projectDir, file.relativePath);
    await assertSafeProjectPath(projectDir, targetPath, true, "formal target");
    let previousContent: string | undefined;
    try {
      previousContent = await readFile(targetPath, "utf-8");
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }
    if (previousContent === undefined) {
      backups.push({ relativePath: file.relativePath, existed: false });
      continue;
    }
    const backupPath = join("backups", file.relativePath);
    const absoluteBackupPath = join(txDir, backupPath);
    await ensureSafeDirectory(projectDir, dirname(absoluteBackupPath), true, "commit backup directory");
    await writeTextNoFollow(projectDir, absoluteBackupPath, previousContent, "commit backup");
    backups.push({
      relativePath: file.relativePath,
      existed: true,
      backupPath,
      sha256: sha256Text(previousContent),
    });
  }
  return backups;
}

async function restoreCommitTransactionBackups(
  projectDir: string,
  txDir: string,
  backups: readonly CommitTransactionBackup[],
): Promise<string[]> {
  const issues: string[] = [];
  for (const backup of [...backups].reverse()) {
    const targetPath = join(projectDir, backup.relativePath);
    try {
      if (backup.existed) {
        const backupPath = join(txDir, backup.backupPath!);
        await assertSafeProjectPath(projectDir, backupPath, false, "commit backup");
        const content = await readFile(backupPath, "utf-8");
        if (sha256Text(content) !== backup.sha256) {
          throw new Error(`backup checksum mismatch at ${backupPath}`);
        }
        await ensureSafeDirectory(projectDir, dirname(targetPath), true, "formal target parent");
        await writeTextNoFollow(projectDir, targetPath, content, "formal rollback target");
      } else {
        await removeFileNoFollow(projectDir, targetPath, "formal rollback target");
      }
    } catch (error) {
      issues.push(`Rollback failed for ${targetPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return issues;
}

function parseRecoverableCommitManifest(value: unknown, expectedChapter: number): CommitTransactionManifest | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.version !== 2
    || value.chapter !== expectedChapter
    || typeof value.createdAt !== "string"
    || !Array.isArray(value.files)
    || !Array.isArray(value.backups)
    || (value.status !== "staged" && value.status !== "applied" && value.status !== "failed" && value.status !== "recovered")
  ) {
    return undefined;
  }
  const files = value.files.filter((item): item is string => typeof item === "string");
  if (files.length !== value.files.length || !isUniqueSafeRelativePaths(files)) return undefined;
  const backups: CommitTransactionBackup[] = [];
  for (const item of value.backups) {
    if (!isRecord(item) || typeof item.relativePath !== "string" || typeof item.existed !== "boolean") return undefined;
    if (!isSafeTransactionRelativePath(item.relativePath)) return undefined;
    if (item.existed) {
      if (
        typeof item.backupPath !== "string"
        || item.backupPath !== join("backups", item.relativePath)
        || !isSafeTransactionRelativePath(item.backupPath)
        || typeof item.sha256 !== "string"
        || !/^[0-9a-f]{64}$/u.test(item.sha256)
      ) return undefined;
      backups.push({
        relativePath: item.relativePath,
        existed: true,
        backupPath: item.backupPath,
        sha256: item.sha256,
      });
    } else {
      if (item.backupPath !== undefined || item.sha256 !== undefined) return undefined;
      backups.push({ relativePath: item.relativePath, existed: false });
    }
  }
  if (
    backups.length !== files.length
    || !isUniqueSafeRelativePaths(backups.map((backup) => backup.relativePath))
    || files.some((file) => !backups.some((backup) => backup.relativePath === file))
  ) return undefined;
  return {
    version: 2,
    chapter: expectedChapter,
    createdAt: value.createdAt,
    files,
    backups,
    status: value.status,
  };
}

function assertUniqueSafeTransactionFiles(files: readonly TransactionFile[]): void {
  const paths = files.map((file) => file.relativePath);
  if (!isUniqueSafeRelativePaths(paths)) {
    throw new Error("Commit transaction contains duplicate or unsafe target paths.");
  }
}

function isUniqueSafeRelativePaths(paths: readonly string[]): boolean {
  return new Set(paths).size === paths.length && paths.every(isSafeTransactionRelativePath);
}

function isSafeTransactionRelativePath(path: string): boolean {
  if (!path || isAbsolute(path) || path.includes("\0")) return false;
  const segments = path.split(/[\\/]/u);
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function sha256Text(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

async function writeManifest(projectDir: string, txDir: string, manifest: CommitTransactionManifest): Promise<void> {
  await writeTextNoFollow(projectDir, join(txDir, "manifest.json"), jsonText(manifest), "commit transaction manifest");
}

async function assertSafeProjectPath(
  projectDir: string,
  candidatePath: string,
  allowMissing: boolean,
  label: string,
): Promise<void> {
  const root = resolve(projectDir);
  const candidate = resolve(candidatePath);
  const rel = relative(root, candidate);
  if (rel === "" || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error(`Unsafe ${label} path outside project: ${candidatePath}`);
  }
  const rootStats = await lstat(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error(`Unsafe ${label}: project root is not a real directory.`);
  }
  let current = root;
  const segments = rel.split(sep).filter(Boolean);
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]!);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) throw new Error(`Unsafe ${label}: symbolic link at ${current}`);
      if (index < segments.length - 1 && !stats.isDirectory()) {
        throw new Error(`Unsafe ${label}: non-directory parent at ${current}`);
      }
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT" && allowMissing) return;
      throw error;
    }
  }
}

async function ensureSafeDirectory(
  projectDir: string,
  directoryPath: string,
  create: boolean,
  label: string,
): Promise<void> {
  await assertSafeProjectPath(projectDir, directoryPath, create, label);
  if (create) await mkdir(directoryPath, { recursive: true });
  await assertSafeProjectPath(projectDir, directoryPath, false, label);
  const stats = await lstat(directoryPath);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Unsafe ${label}: expected a real directory at ${directoryPath}`);
  }
}

async function writeTextNoFollow(
  projectDir: string,
  targetPath: string,
  content: string,
  label: string,
): Promise<void> {
  await assertSafeProjectPath(projectDir, targetPath, true, label);
  await commitIoTestHook?.("after-precheck-before-open", targetPath);
  // Deliberately omit O_TRUNC here. Opening an existing file must not mutate a
  // byte until its parent realpath and the opened inode have both been proven
  // to be the same contained file. If O_CREAT races into an attacker-swapped
  // empty location, the only possible residue before rejection is an empty
  // file; existing outside data is never truncated or overwritten.
  const handle = await open(
    targetPath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    await commitIoTestHook?.("after-open-before-verify", targetPath);
    await verifyOpenedProjectFile(projectDir, targetPath, handle, label);
    await handle.truncate(0);
    await handle.writeFile(content, "utf-8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await assertSafeProjectPath(projectDir, targetPath, false, label);
}

async function verifyOpenedProjectFile(
  projectDir: string,
  targetPath: string,
  handle: Awaited<ReturnType<typeof open>>,
  label: string,
): Promise<void> {
  const [rootRealPath, parentRealPath, handleStats, pathStats] = await Promise.all([
    realpath(projectDir),
    realpath(dirname(targetPath)),
    handle.stat(),
    lstat(targetPath),
  ]);
  const parentRelative = relative(rootRealPath, parentRealPath);
  if (isAbsolute(parentRelative) || parentRelative === ".." || parentRelative.startsWith(`..${sep}`)) {
    throw new Error(`Unsafe ${label}: parent realpath escaped project containment.`);
  }
  if (pathStats.isSymbolicLink() || !pathStats.isFile()) {
    throw new Error(`Unsafe ${label}: final path is not a real file.`);
  }
  if (handleStats.dev !== pathStats.dev || handleStats.ino !== pathStats.ino) {
    throw new Error(`Unsafe ${label}: opened inode no longer matches the target path.`);
  }
  if (handleStats.nlink !== 1) {
    throw new Error(`Unsafe ${label}: hard-linked targets are not allowed.`);
  }
}

async function removeFileNoFollow(projectDir: string, targetPath: string, label: string): Promise<void> {
  await assertSafeProjectPath(projectDir, targetPath, true, label);
  try {
    await lstat(targetPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  throw new Error(
    `Refusing to path-delete ${label} at ${targetPath}; use the pre-commit snapshot or manual recovery.`,
  );
}

function findUnknownHookIds(hookPool: HookPool, updates: readonly HookUpdate[]): string[] {
  const existing = new Set(hookPool.hooks.map((hook) => hook.id));
  return updates.map((update) => update.hookId).filter((hookId) => !existing.has(hookId));
}

function mergeUnique(previous: readonly string[], additions: readonly string[] | undefined): readonly string[] {
  if (!additions) return previous;
  return [...new Set([...previous, ...additions].filter(Boolean))];
}

function mergeUniqueRecords<T>(
  previous: readonly T[],
  additions: readonly T[] | undefined,
  keyOf: (value: T) => string,
): readonly T[] {
  const byKey = new Map<string, T>();
  for (const item of previous) byKey.set(keyOf(item), item);
  for (const item of additions ?? []) byKey.set(keyOf(item), item);
  return [...byKey.values()];
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter(Boolean))];
}

function padChapter(chapter: number): string {
  return String(Math.max(0, Math.trunc(chapter))).padStart(4, "0");
}

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
