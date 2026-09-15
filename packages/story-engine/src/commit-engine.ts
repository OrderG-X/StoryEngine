import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { constants as fsConstants, realpathSync } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rm, rmdir, writeFile } from "node:fs/promises";
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
  describeErrorBriefly,
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
  /**
   * 本章明确化解/了结的冲突。按归一化文本从 activeConflicts 扣除——只删模型显式点名的条目，
   * 绝不因「本章没再提」就静默清除（缺失不等于化解，铁律④：永不静默）。
   */
  readonly resolvedConflicts?: readonly string[];
  readonly activeHooks?: readonly string[];
  /**
   * 本章明确揭示/公开的秘密。从 knownSecrets 扣除——已被读者知晓的秘密不再是「隐情」，
   * 再放进 hiddenTruths/protectedSecrets 会让模型把已揭底的事当悬念写。
   */
  readonly revealedSecrets?: readonly string[];
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
  /** P1-6：回滚不完备的残留原因（新建文件无法自证为事务写入内容，原地保留并放行） */
  readonly recoveryIssues?: readonly string[];
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
      // 引擎自造错误都带 .code（UNSAFE_*/TX_*），fs 错误带 errno——进 report.issues 只给
      // code + 项目内相对文件名，绝不拼 error.message 原文（fs 文案带本地绝对路径=泄漏）。
      return withCommitDiagnostics(
        input.projectDir,
        failedReport(input.chapter, [`入库事务自检失败（${describeErrorBriefly(error, input.projectDir)}）。`]),
        startRuntimeLatency(),
        input.draftContent,
      );
    }
    const report = await commitFastDraftUnlocked(input);
    // A3（P1-6 上浮，2026-09-15 复审）：recover 放行的「回滚不完整」残留此前只写进 manifest、
    // 全仓零读点——盘上「章文件已留、资料已回滚」的分歧态用户/agent 无从知晓（违铁律④）。
    // 在提交收尾【之后】扫一次：同章残留刚被本事务吸收（manifest 已 applied、无 recoveryIssues）
    // 不会再报；仍挂着的 recovered-with-issues 残留折进 report.issues 上浮，细节留在盘上 manifest。
    const notices = await listCommitRecoveryNotices(input.projectDir).catch(() => undefined);
    const noticeLines = notices === undefined
      // 残留自检本身失败：不堵提交、也不装没看见——给一条中性提示，指引人工核对事务目录。
      ? ["transaction_recovery_scan_failed: 入库事务残留自检未跑通；如本书此前有中断的入库，请人工核对 .story-engine-tx 目录。"]
      : notices.map(formatCommitRecoveryNotice);
    if (noticeLines.length === 0) return report;
    return { ...report, issues: [...report.issues, ...noticeLines] };
  });
}

async function commitFastDraftUnlocked(input: CommitDraftInput): Promise<CommitReport> {
  const latencyTimer = startRuntimeLatency();
  const draftPath = input.draftPath ?? defaultDraftPath(input.projectDir, input.chapter);
  const issues: string[] = [];
  const draft = input.draftContent !== undefined
    ? input.draftContent
    : await readFile(draftPath, "utf-8").catch((error: unknown) => {
      issues.push(`读取草稿失败（${describeErrorBriefly(error, input.projectDir)}）。`);
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
      issues.push(`读取伏笔池失败（${describeErrorBriefly(error, input.projectDir)}）。`);
      return undefined;
    }),
    readThreadPool(input.projectDir).catch((error: unknown) => {
      issues.push(`读取线索池失败（${describeErrorBriefly(error, input.projectDir)}）。`);
      return undefined;
    }),
    readArcGoalPool(input.projectDir).catch((error: unknown) => {
      issues.push(`读取目标池失败（${describeErrorBriefly(error, input.projectDir)}）。`);
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
    ...(await buildWorldStateFile(input.projectDir, input.chapter, input.commitPlan.worldUpdates, hookUpdates)),
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
    .catch((error: unknown) => undefinedWithIssue(error, issues, input.projectDir));
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

/**
 * 一条「已放行但回滚不完整」的事务残留通知。
 * 只放章号/事务目录名/条目计数——具体原因（含盘上绝对路径）留在 txDir/manifest.json 里，
 * 用户可见面绝不上浮原文（路径泄漏纪律）。
 */
export interface CommitRecoveryNotice {
  readonly chapter: number;
  readonly transactionId: string;
  readonly issueCount: number;
}

/**
 * A3（P1-6 上浮）：列出盘上仍挂着的「recovered + recoveryIssues」事务残留。
 * recover 放行后 manifest 原地保留（同章重提被新事务吸收前一直在），对应的分歧态也就一直在——
 * 此函数给 report.issues / overview warnings 一个可持续的上浮信号，绝非只报一次就静默。
 * 只读 manifest、不动任何文件；坏 manifest 由 recover 路径 fail-closed 拦截，这里跳过不重复判。
 */
export async function listCommitRecoveryNotices(projectDir: string): Promise<readonly CommitRecoveryNotice[]> {
  const txRoot = join(projectDir, ".story-engine-tx");
  let entries;
  try {
    entries = await readdir(txRoot, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
  const notices: CommitRecoveryNotice[] = [];
  for (const entry of entries) {
    const match = /^commit-chapter-(\d+)$/u.exec(entry.name);
    if (!match || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(join(txRoot, entry.name, "manifest.json"), "utf-8")) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(parsed) || parsed.status !== "recovered" || !Array.isArray(parsed.recoveryIssues)) continue;
    const issues = parsed.recoveryIssues.filter((item): item is string => typeof item === "string" && item.length > 0);
    if (issues.length === 0) continue;
    notices.push({ chapter: Number(match[1]), transactionId: entry.name, issueCount: issues.length });
  }
  return notices.sort((left, right) => left.chapter - right.chapter);
}

/**
 * 把一条残留通知渲成用户可见的中性文本（code 前缀 `transaction_recovered_partial` + 章号 + 计数）。
 * 绝不带绝对路径/error.message——细节证据在 `.story-engine-tx/<transactionId>/manifest.json`（相对路径）。
 */
export function formatCommitRecoveryNotice(notice: CommitRecoveryNotice): string {
  return `transaction_recovered_partial: 第 ${notice.chapter} 章的入库事务此前中断且未能完全回滚，已按原样放行（${notice.issueCount} 项残留记录在 ${notice.transactionId}/manifest.json）；该章文件可能与伏笔/时间线等资料不一致，建议重新提交第 ${notice.chapter} 章或人工核对。`;
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
    return attachDiagnosticsWarning(report, `commit diagnostics write failed: ${describeErrorBriefly(error, projectDir)}`);
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

function undefinedWithIssue(error: unknown, issues: string[], projectDir: string): undefined {
  issues.push(`事务落盘失败（${describeErrorBriefly(error, projectDir)}）。`);
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
      issues.push(`读取角色状态失败（${describeErrorBriefly(error, projectDir)}）。`);
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
  /** 本章被模型声明并经校验的 hook 状态变更（化解/废弃的 hook 要从 activeHooks 退场） */
  hookUpdates: readonly HookUpdate[] = [],
): Promise<readonly TransactionFile[]> {
  if (!update) return [];
  const previous = await readWorldState(projectDir);
  const retiredHookIds = hookUpdates
    .filter((update) => update.status === "resolved" || update.status === "abandoned")
    .map((update) => update.hookId);
  const next: WorldState = {
    ...previous,
    ...(update.currentPhase !== undefined ? { currentPhase: update.currentPhase } : {}),
    activeConflicts: subtractNormalized(
      mergeUnique(previous.activeConflicts, update.activeConflicts),
      update.resolvedConflicts,
    ),
    activeHooks: subtractNormalized(
      mergeUnique(previous.activeHooks, update.activeHooks),
      retiredHookIds,
    ),
    knownSecrets: subtractNormalized(
      mergeUnique(previous.knownSecrets, update.knownSecrets),
      update.revealedSecrets,
    ),
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
  // P2：自动路径按章号推一天，但绝不让「第 3 章已明确写到第 10 天」被后续章节回压成第 4 天——
  // 故事日只许前进不许后退。时刻同理：没有时间证据时沿用上次已知时刻，不回退成 unknown。
  const requestedDay = Number.isFinite(update.storyDay) && update.storyDay > 0
    ? Math.floor(update.storyDay)
    : previous.currentStoryDay;
  const next: StoryCalendar = {
    ...previous,
    currentStoryDay: Math.max(previous.currentStoryDay, requestedDay),
    currentTimeOfDay: update.timeOfDay === "unknown" && previous.currentTimeOfDay !== "unknown"
      ? previous.currentTimeOfDay
      : update.timeOfDay,
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
      transaction.files,
    );
    await writeManifest(projectDir, transaction.txDir, {
      ...transaction.manifest,
      status: "failed",
    }).catch(() => undefined);
    return {
      passed: false,
      issues: [
        `入库写入失败（${describeErrorBriefly(error, projectDir)}）。`,
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
    throw taggedError("UNSAFE_TX_ROOT", `Unsafe commit transaction root at ${relative(resolve(projectDir), txRoot)}; refusing formal-state reads.`);
  }
  const entries = await readdir(txRoot, { withFileTypes: true });
  for (const entry of entries) {
    const match = /^commit-chapter-(\d+)$/u.exec(entry.name);
    if (!match) continue;
    const txDir = join(txRoot, entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw taggedError("UNSAFE_TX_RESIDUE", `Unsafe commit transaction residue at ${relative(resolve(projectDir), txDir)}; refusing formal-state reads.`);
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
        await validateSnapshotOnlyCommitResidue(projectDir, snapshotManifestPath, entry.name, chapter);
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
      throw taggedError("UNREADABLE_TX_RESIDUE", `Unreadable commit transaction residue at ${relative(resolve(projectDir), txDir)}; refusing formal-state reads.`);
    }
    await recoverCommitTransactionResidue(projectDir, txDir, chapter);
  }
}

async function validateSnapshotOnlyCommitResidue(
  projectDir: string,
  manifestPath: string,
  transactionId: string,
  chapter: number,
): Promise<void> {
  // manifestPath 一律落成项目内相对路径再进文案——thrown message 可能被调用方原样上抛/打印。
  const manifestRel = relative(resolve(projectDir), manifestPath);
  if (transactionId !== `commit-chapter-${padChapter(chapter)}` || chapter <= 0) {
    throw taggedError("UNSAFE_SNAPSHOT_RESIDUE_ID", `Unsafe snapshot-only commit residue id: ${transactionId}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(manifestPath, "utf-8")) as unknown;
  } catch (error) {
    throw taggedError(
      "UNREADABLE_SNAPSHOT_MANIFEST",
      `Unreadable snapshot-only commit manifest at ${manifestRel}: ${describeErrorBriefly(error, projectDir)}`,
      error,
    );
  }
  if (!isRecord(parsed)) throw taggedError("INVALID_SNAPSHOT_MANIFEST", `Invalid snapshot-only commit manifest at ${manifestRel}`);
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
    throw taggedError("INVALID_SNAPSHOT_MANIFEST", `Invalid snapshot-only commit manifest at ${manifestRel}`);
  }
  const file = parsed.files[0];
  if (!isRecord(file) || file.relativePath !== expectedChapterPath) {
    throw taggedError("UNSAFE_SNAPSHOT_TARGET", `Unsafe snapshot-only commit target at ${manifestRel}`);
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
  if (!validRollback) throw taggedError("INVALID_SNAPSHOT_ROLLBACK", `Invalid snapshot-only commit rollback metadata at ${manifestRel}`);
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
  const txRel = relative(resolve(projectDir), txDir);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw taggedError("UNSAFE_TX_RESIDUE", `Unsafe commit transaction residue at ${txRel}; refusing to delete or overwrite it.`);
  }

  let parsed: unknown;
  try {
    const manifestPath = join(txDir, "manifest.json");
    await assertSafeProjectPath(projectDir, manifestPath, false, "commit transaction manifest");
    parsed = JSON.parse(await readFile(manifestPath, "utf-8")) as unknown;
  } catch (error) {
    throw taggedError(
      "UNREADABLE_TX_RESIDUE",
      `Unreadable commit transaction residue at ${txRel}; refusing to delete it: ${describeErrorBriefly(error, projectDir)}`,
      error,
    );
  }
  const manifest = parseRecoverableCommitManifest(parsed, expectedChapter);
  if (!manifest) {
    throw taggedError("UNRECOVERABLE_TX_MANIFEST", `Unrecoverable commit transaction manifest at ${txRel}; refusing to delete or overwrite it.`);
  }

  if (manifest.status === "recovered") return;
  if (manifest.status !== "applied") {
    // recover 路径不传 writtenFiles：staged/failed 残留的新建文件可能含用户未保存的编辑，
    // 磁盘内容不能自证为「事务写入的内容」。保持 fail-closed（拒绝删除并如实记录），
    // 只有 apply 路径（内存里有确切 writtenContent）才安全删除。
    const rollbackIssues = await restoreCommitTransactionBackups(projectDir, txDir, manifest.backups);
    if (rollbackIssues.length > 0) {
      // P1-6 治永久锁死：回滚不完整时不再永久抛错阻塞后续提交。无法判定的新建文件
      // 原地保留（用户数据分毫不动），事务标记 recovered 放行——后续提交会自然覆盖它。
      // 恢复手段从「报错让用户手工删 .story-engine-tx」升级为「如实记录 + 自动放行」。
      await writeManifest(projectDir, txDir, {
        ...manifest,
        status: "recovered",
        recoveryIssues: rollbackIssues,
      });
      return;
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
  /** 事务写入的新文件内容（P1-6：新建文件回滚的删除凭据） */
  writtenFiles?: readonly TransactionFile[],
): Promise<string[]> {
  const issues: string[] = [];
  const writtenByPath = new Map(
    (writtenFiles ?? []).map((file) => [file.relativePath, file.content] as const),
  );
  for (const backup of [...backups].reverse()) {
    const targetPath = join(projectDir, backup.relativePath);
    try {
      if (backup.existed) {
        const backupPath = join(txDir, backup.backupPath!);
        await assertSafeProjectPath(projectDir, backupPath, false, "commit backup");
        const content = await readFile(backupPath, "utf-8");
        if (sha256Text(content) !== backup.sha256) {
          throw taggedError("TX_BACKUP_CHECKSUM_MISMATCH", `backup checksum mismatch at ${relative(resolve(projectDir), backupPath)}`);
        }
        await ensureSafeDirectory(projectDir, dirname(targetPath), true, "formal target parent");
        await writeTextNoFollow(projectDir, targetPath, content, "formal rollback target");
      } else {
        await removeFileNoFollow(
          projectDir,
          targetPath,
          "formal rollback target",
          writtenByPath.get(backup.relativePath),
        );
      }
    } catch (error) {
      // 相对文件名 + errno code/自造错误码：这条 issues 会同时进 report.issues（用户可见）和
      // manifest.recoveryIssues（盘上取证）——error.message 原文带绝对路径，绝不直拼。
      issues.push(`Rollback failed for ${backup.relativePath}: ${describeErrorBriefly(error, projectDir)}`);
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
    throw taggedError("UNSAFE_TX_TARGETS", "Commit transaction contains duplicate or unsafe target paths.");
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
    // 越界目标只给相对关系（"../…" 已足够定位），绝不落绝对路径进 message。
    throw taggedError("UNSAFE_PATH_OUTSIDE_PROJECT", `Unsafe ${label} path outside project: ${rel}`);
  }
  const rootStats = await lstat(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw taggedError("UNSAFE_PROJECT_ROOT", `Unsafe ${label}: project root is not a real directory.`);
  }
  let current = root;
  const segments = rel.split(sep).filter(Boolean);
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]!);
    try {
      const stats = await lstat(current);
      const currentRel = relative(root, current) || ".";
      if (stats.isSymbolicLink()) throw taggedError("UNSAFE_SYMLINK", `Unsafe ${label}: symbolic link at ${currentRel}`);
      if (index < segments.length - 1 && !stats.isDirectory()) {
        throw taggedError("UNSAFE_PARENT", `Unsafe ${label}: non-directory parent at ${currentRel}`);
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
    throw taggedError("UNSAFE_DIRECTORY", `Unsafe ${label}: expected a real directory at ${relative(resolve(projectDir), directoryPath)}`);
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
    throw taggedError("UNSAFE_CONTAINMENT", `Unsafe ${label}: parent realpath escaped project containment.`);
  }
  if (pathStats.isSymbolicLink() || !pathStats.isFile()) {
    throw taggedError("UNSAFE_NOT_A_FILE", `Unsafe ${label}: final path is not a real file.`);
  }
  if (handleStats.dev !== pathStats.dev || handleStats.ino !== pathStats.ino) {
    throw taggedError("UNSAFE_INODE_MISMATCH", `Unsafe ${label}: opened inode no longer matches the target path.`);
  }
  if (handleStats.nlink !== 1) {
    throw taggedError("UNSAFE_HARDLINK", `Unsafe ${label}: hard-linked targets are not allowed.`);
  }
}

/**
 * 回滚「事务前不存在的文件」（新建的章节文件）。此前一律拒绝删除 → apply 中段崩溃后
 * 每次提交都进 recover → 抛 Rollback failed → 项目永久锁死，只能手工删 .story-engine-tx
 * （2026-09-15 审计 P1-6）。
 *
 * 安全收紧而非放开：只有当磁盘内容【仍是本事务刚写入的内容】时才删（哈希比对）——
 * 这证明文件是本次未完成的提交产生的、没被用户/别的进程改过，删了不会丢任何用户数据。
 * 内容不匹配则保留并如实记录，绝不误删。
 */
async function removeFileNoFollow(
  projectDir: string,
  targetPath: string,
  label: string,
  writtenContent?: string,
): Promise<void> {
  await assertSafeProjectPath(projectDir, targetPath, true, label);
  try {
    await lstat(targetPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  const targetRel = relative(resolve(projectDir), targetPath);
  if (writtenContent === undefined) {
    throw taggedError(
      "TX_UNVERIFIED_DELETE",
      `Refusing to path-delete ${label} at ${targetRel}; no transaction content recorded for verification.`,
    );
  }
  const currentContent = await readFile(targetPath, "utf-8");
  if (sha256Text(currentContent) !== sha256Text(writtenContent)) {
    throw taggedError(
      "TX_CONTENT_CHANGED",
      `Refusing to path-delete ${label} at ${targetRel}; content no longer matches the transaction's write (file was modified after the failed commit).`,
    );
  }
  await rm(targetPath, { force: true });
}

function findUnknownHookIds(hookPool: HookPool, updates: readonly HookUpdate[]): string[] {
  const existing = new Set(hookPool.hooks.map((hook) => hook.id));
  return updates.map((update) => update.hookId).filter((hookId) => !existing.has(hookId));
}

function mergeUnique(previous: readonly string[], additions: unknown): readonly string[] {
  const list = toStringArray(additions);
  if (list.length === 0) return previous;
  return [...new Set([...previous, ...list].filter(Boolean))];
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

/**
 * P2：从累积列表里扣除显式点名的条目。归一化（去空白、转小写、压空格）后按文本匹配，
 * 让模型写「城南争夺」能扣掉此前登记的「城南 争夺」。只删被点名的条目——
 * 缺失不等于化解，绝不做推断式清除（铁律④：永不静默）。
 */
function subtractNormalized(values: readonly string[], removals: unknown): readonly string[] {
  const removalList = toStringArray(removals);
  if (removalList.length === 0) return values;
  const removalSet = new Set(removalList.map(normalizeForMatch).filter((value) => value.length > 0));
  if (removalSet.size === 0) return values;
  return values.filter((value) => !removalSet.has(normalizeForMatch(value)));
}

/**
 * 退化输入归一（铁律：工具边界要容忍模型给 ""/[]/0/"False"/裸 id 甚至非数组）。
 * 非数组/非字符串一律归零，绝不让畸形值清空用户已登记的条目。
 */
function toStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
}

/**
 * 匹配归一：去全部空白 + 转小写。模型重述条目时常随手加空格/换行（「城南 争夺」vs「城南争夺」），
 * 扣除按语义而非按字节才不漏扣；空格对语义无贡献，去掉它不会误伤两个真正不同的条目。
 */
function normalizeForMatch(value: string): string {
  return value.replace(/\s+/gu, "").toLowerCase();
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

/**
 * 引擎自造错误：给稳定 .code，让剔除 error.message 的上游 catch（report.issues/诊断面）
 * 仍能保留语义关键字；message 原文（含内部绝对路径）只留在 Error 对象里供抛出方/调试用。
 */
function taggedError(code: string, message: string, cause?: unknown): Error {
  const error = cause === undefined ? new Error(message) : new Error(message, { cause });
  (error as NodeJS.ErrnoException).code = code;
  return error;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
