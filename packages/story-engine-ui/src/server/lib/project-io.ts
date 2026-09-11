/**
 * Shared I/O, parsing, path safety, and utility functions used across route modules.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { chmod, readFile, rename, rm, stat, writeFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve, join, isAbsolute, sep, win32 as win32Path } from "node:path";
import { resolveBooksRootDir } from "./data-dirs.js";
import type {
  ChapterSteeringPacing,
  ChapterSteeringRevealLevel,
  CommitSelectiveConfirmation,
  DraftRevisionPreview,
  DraftRevisionTask,
  FoundationGapDecision,
  normalizeDraftRevisionPreview as NormalizeDraftRevisionPreviewFn,
  StateOverview,
} from "@actalk/story-engine";
import { normalizeDraftRevisionPreview } from "@actalk/story-engine";
import type { FoundationGapSuggestion } from "../../api/types.js";

// ---------------------------------------------------------------------------
// Middleware types
// ---------------------------------------------------------------------------

export type Middleware = (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => void;
export type MiddlewareStack = {
  use(handler: Middleware): void;
};

// ---------------------------------------------------------------------------
// HTTP response
// ---------------------------------------------------------------------------

export type DevApiResponse = {
  readonly ok: boolean;
  readonly [key: string]: unknown;
};

export function writeJson(res: ServerResponse, statusCode: number, payload: DevApiResponse): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(`${JSON.stringify(payload)}\n`);
}

// ---------------------------------------------------------------------------
// 原子写盘（审查 #5/#8：防半写文件 + 多文件「全备齐再提交」）
// ---------------------------------------------------------------------------

/**
 * 原子写单文件：先写同目录临时文件，再 rename 覆盖目标（同盘 rename 是原子操作，绝不留半截文件）。
 * 崩溃/并发只会看到「旧内容」或「新内容」，不会看到截断的中间态。可选 mode（如 0600 密钥文件）。
 * 调用方需自行保证目录已存在（与旧 writeFile 行为一致，不隐式建目录）。
 */
export async function writeFileAtomic(
  path: string,
  data: string,
  options: { readonly mode?: number } = {},
): Promise<void> {
  const tmp = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    await writeFile(tmp, data, options.mode !== undefined ? { encoding: "utf-8", mode: options.mode } : "utf-8");
    if (options.mode !== undefined) await chmod(tmp, options.mode).catch(() => undefined);
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export interface AtomicFileEntry {
  readonly path: string;
  readonly content: string;
  readonly mode?: number;
}

/**
 * 多文件「全备齐再提交」（审查 #8：模型设置/密钥/任务分配三文件不再各自裸写）。
 * 先把每个文件写到各自同目录的临时文件（任一失败即清理全部临时文件并抛错，原文件分毫未动）；
 * 全部临时文件就绪后再逐个 rename 提交。真正的多文件事务需 FS 支持（没有），此法把「部分提交」
 * 的窗口压到仅剩「连续几个 rename 之间」的极小时刻，远好于旧的「边算边裸写」中途失败留下混合态。
 * 提交段中途失败同样清理尚未 rename 的临时文件（tmp 名带 randomUUID，只属本次调用，不会误删
 * 并发调用各自的临时文件）；已成功 rename 的文件不回滚——「部分提交」窗口的语义不变，只是不留残渣。
 */
export async function commitFilesAtomically(entries: readonly AtomicFileEntry[]): Promise<void> {
  const staged: { readonly tmp: string; readonly target: string; readonly mode?: number }[] = [];
  const cleanStaged = (): Promise<unknown[]> => Promise.all(staged.map((s) => rm(s.tmp, { force: true }).catch(() => undefined)));
  try {
    for (const entry of entries) {
      const tmp = join(dirname(entry.path), `.${randomUUID()}.tmp`);
      await writeFile(tmp, entry.content, entry.mode !== undefined ? { encoding: "utf-8", mode: entry.mode } : "utf-8");
      if (entry.mode !== undefined) await chmod(tmp, entry.mode).catch(() => undefined);
      staged.push({ tmp, target: entry.path, ...(entry.mode !== undefined ? { mode: entry.mode } : {}) });
    }
  } catch (error) {
    await cleanStaged();
    throw error;
  }
  try {
    for (const s of staged) {
      await rename(s.tmp, s.target);
    }
  } catch (error) {
    // 已 rename 成功的临时文件不复存在，force rm 对其自然空转，只清掉没来得及提交的那部分。
    await cleanStaged();
    throw error;
  }
}

// ---------------------------------------------------------------------------
// 按 key 串行执行（审查 #5：同一章节的写盘串成队列，杜绝并发/乱序 PUT 交叠、旧稿覆盖新稿）
// ---------------------------------------------------------------------------

const exclusiveChains = new Map<string, Promise<unknown>>();

/**
 * 保证同一 key 的任务串行执行：新任务排在该 key 上一个任务「结算之后」才跑（无论上一个成功或失败）。
 * 进程内互斥，配合原子写，让「同章节的多笔写盘」按到达顺序落地，不会交叠出半新半旧的文件。
 */
export function runExclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = exclusiveChains.get(key) ?? Promise.resolve();
  const run = previous.then(() => task(), () => task());
  const guard = run.then(() => undefined, () => undefined);
  exclusiveChains.set(key, guard);
  void guard.then(() => {
    if (exclusiveChains.get(key) === guard) exclusiveChains.delete(key);
  });
  return run;
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// String / number parsers
// ---------------------------------------------------------------------------

export function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function readStringAllowEmpty(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function requireBodyString(value: unknown, message: string): string {
  const parsed = readString(value);
  if (!parsed) throw new Error(message);
  return parsed;
}

export function readStringList(value: unknown): string[] {
  const items = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/\r?\n|[；;]/u)
      : [];
  return items
    .map((item) => readString(item))
    .filter((item): item is string => Boolean(item));
}

export function readPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const parsed = Math.trunc(value);
  return parsed > 0 ? parsed : undefined;
}

export function requirePositiveBodyInteger(value: unknown, message: string): number {
  const parsed = readPositiveInteger(value);
  if (parsed === undefined) throw new Error(message);
  return parsed;
}

export function parseOptionalPositiveInteger(value: string | null): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function readChatMessages(value: unknown): readonly { readonly role: "user" | "assistant"; readonly content: string }[] {
  if (!Array.isArray(value)) return [];
  const messages: { role: "user" | "assistant"; content: string }[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const content = readString(item.content);
    if (!content) continue;
    if (item.role === "assistant" || item.role === "user") {
      messages.push({ role: item.role, content });
    }
  }
  return messages;
}

export function limitFoundationChatHistory(
  messages: readonly { readonly role: "user" | "assistant"; readonly content: string }[],
  maxCount = 40,
  maxChars = 24000,
): readonly { readonly role: "user" | "assistant"; readonly content: string }[] {
  const recent = messages.slice(-maxCount);
  const kept: { role: "user" | "assistant"; content: string }[] = [];
  let totalChars = 0;
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const item = recent[index]!;
    totalChars += item.content.length;
    if (totalChars > maxChars && kept.length > 0) break;
    kept.unshift(item);
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Enum parsers
// ---------------------------------------------------------------------------

export function readPacing(value: unknown): ChapterSteeringPacing | undefined {
  return value === "slow" || value === "medium" || value === "fast" ? value : undefined;
}

export function readChapterChatMode(value: unknown): "suggest" | "discuss" {
  return value === "suggest" || value === "discuss" ? value : "discuss";
}

export function readRevealLevel(value: unknown): ChapterSteeringRevealLevel | undefined {
  return value === "none" || value === "small" || value === "large" ? value : undefined;
}

// ---------------------------------------------------------------------------
// Workspace message parsers
// ---------------------------------------------------------------------------

export type WorkspaceTurnSnapshot = {
  readonly toolName: string;
  readonly snapshotId: string;
  readonly chapterNumber?: number;
};

export type WorkspaceNameConsistencyWarning = {
  readonly establishedName: string;
  readonly driftedVariant: string;
  readonly message: string;
};

export type WorkspaceStaleThreadWarning = {
  readonly kind: string;
  readonly title: string;
  readonly lastTouchedChapter: number;
  readonly chaptersSinceTouched: number;
  readonly message: string;
};

export type WorkspaceNextStepPrompt = {
  readonly question: string;
  readonly choices: readonly { readonly label: string; readonly intent: string; readonly recommended?: boolean }[];
};

export function readWorkspaceMessages(value: unknown): {
  readonly id: string;
  readonly role: "user" | "assistant" | "system";
  readonly content: string;
  readonly adviceCards?: readonly Record<string, unknown>[];
  readonly suggestedActions?: readonly Record<string, unknown>[];
  readonly agentCards?: readonly Record<string, unknown>[];
  readonly toolOutput?: readonly string[];
  readonly thinking?: string;
  readonly toolSteps?: readonly Record<string, unknown>[];
  readonly segments?: readonly WorkspaceMessageSegment[];
  readonly createdAt?: string;
  readonly intentTitle?: string;
  readonly turnStartedAt?: number;
  readonly turnEndedAt?: number;
  readonly turnSnapshots?: readonly WorkspaceTurnSnapshot[];
  readonly affectedScopes?: readonly ("full" | "foundation")[];
  readonly aiFlavorReport?: Record<string, unknown>;
  readonly aiFlavorFixedIds?: readonly string[];
  readonly aiReviewReport?: Record<string, unknown>;
  readonly draftReview?: Record<string, unknown>;
  readonly qualityReport?: Record<string, unknown>;
  readonly commitReport?: unknown;
  readonly nameConsistencyWarnings?: readonly WorkspaceNameConsistencyWarning[];
  readonly staleThreadWarnings?: readonly WorkspaceStaleThreadWarning[];
  readonly nextStepPrompt?: WorkspaceNextStepPrompt;
  readonly isErrorNotice?: boolean;
  readonly errorDetail?: string;
}[] {
  if (!Array.isArray(value)) return [];
  const messages: {
    id: string;
    role: "user" | "assistant" | "system";
    content: string;
    adviceCards?: readonly Record<string, unknown>[];
    suggestedActions?: readonly Record<string, unknown>[];
    agentCards?: readonly Record<string, unknown>[];
    toolOutput?: readonly string[];
    thinking?: string;
    toolSteps?: readonly Record<string, unknown>[];
    segments?: readonly WorkspaceMessageSegment[];
    createdAt?: string;
    intentTitle?: string;
    turnStartedAt?: number;
    turnEndedAt?: number;
    turnSnapshots?: readonly WorkspaceTurnSnapshot[];
    affectedScopes?: readonly ("full" | "foundation")[];
    aiFlavorReport?: Record<string, unknown>;
    aiFlavorFixedIds?: readonly string[];
    aiReviewReport?: Record<string, unknown>;
    draftReview?: Record<string, unknown>;
    qualityReport?: Record<string, unknown>;
    commitReport?: unknown;
    nameConsistencyWarnings?: readonly WorkspaceNameConsistencyWarning[];
    staleThreadWarnings?: readonly WorkspaceStaleThreadWarning[];
    nextStepPrompt?: WorkspaceNextStepPrompt;
    isErrorNotice?: boolean;
    errorDetail?: string;
  }[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const id = readString(item.id);
    const content = readString(item.content);
    // 纯工具回合的 assistant 消息 content 可以为空（只调了工具没说话），但它挂着工具步骤/分段/
    // 撤销快照——按「content 为空」丢掉等于把那一轮的执行记录和快照静默蒸发（复审 P3）。
    const carriesToolPayload = Array.isArray(item.toolSteps) && item.toolSteps.length > 0
      || Array.isArray(item.segments) && item.segments.length > 0
      || Array.isArray(item.turnSnapshots) && item.turnSnapshots.length > 0;
    if (!id || (!content && !carriesToolPayload)) continue;
    // Self-heal: scrub legacy mockData seed messages (msg-001/msg-002) that may
    // have been固化 onto real project disks before F1. Real runtime ids never use
    // the `msg-0` prefix (they are `${role}-${Date.now()}…`), so this is mock-only.
    if (id.startsWith("msg-0")) continue;
    if (item.role !== "assistant" && item.role !== "user" && item.role !== "system") continue;
    const adviceCards = Array.isArray(item.adviceCards)
      ? item.adviceCards.filter(isRecord).slice(0, 12)
      : undefined;
    const agentCards = Array.isArray(item.agentCards)
      ? item.agentCards.filter(isRecord).slice(0, 12)
      : undefined;
    const suggestedActions = readWorkspaceSuggestedActions(item.suggestedActions);
    const toolOutput = readStringList(item.toolOutput).slice(0, 20);
    const thinking = readString(item.thinking);
    const toolSteps = Array.isArray(item.toolSteps)
      ? item.toolSteps.filter(isRecord).slice(0, 60)
      : undefined;
    const segments = readWorkspaceSegments(item.segments);
    const intentTitle = readString(item.intentTitle);
    const turnStartedAt = readFinitePositiveNumber(item.turnStartedAt);
    const turnEndedAt = readFinitePositiveNumber(item.turnEndedAt);
    const turnSnapshots = readWorkspaceTurnSnapshots(item.turnSnapshots);
    const affectedScopes = readWorkspaceAffectedScopes(item.affectedScopes);
    const aiFlavorReport = isRecord(item.aiFlavorReport) ? item.aiFlavorReport : undefined;
    const aiFlavorFixedIds = readStringList(item.aiFlavorFixedIds).slice(0, 50);
    const aiReviewReport = isRecord(item.aiReviewReport) ? item.aiReviewReport : undefined;
    const draftReview = isRecord(item.draftReview) ? item.draftReview : undefined;
    const qualityReport = isRecord(item.qualityReport) ? item.qualityReport : undefined;
    const commitReport = item.commitReport !== undefined && item.commitReport !== null
      ? item.commitReport
      : undefined;
    const nameConsistencyWarnings = readWorkspaceNameConsistencyWarnings(item.nameConsistencyWarnings);
    const staleThreadWarnings = readWorkspaceStaleThreadWarnings(item.staleThreadWarnings);
    const nextStepPrompt = readWorkspaceNextStepPrompt(item.nextStepPrompt);
    const isErrorNotice = item.isErrorNotice === true;
    const errorDetail = readString(item.errorDetail);
    messages.push({
      id,
      role: item.role,
      content: content ?? "",
      ...(adviceCards && adviceCards.length > 0 ? { adviceCards } : {}),
      ...(suggestedActions.length > 0 ? { suggestedActions } : {}),
      ...(agentCards && agentCards.length > 0 ? { agentCards } : {}),
      ...(toolOutput.length > 0 ? { toolOutput } : {}),
      ...(thinking ? { thinking } : {}),
      ...(toolSteps && toolSteps.length > 0 ? { toolSteps } : {}),
      ...(segments.length > 0 ? { segments } : {}),
      ...(readString(item.createdAt) ? { createdAt: readString(item.createdAt) } : {}),
      ...(intentTitle ? { intentTitle } : {}),
      ...(turnStartedAt !== undefined ? { turnStartedAt } : {}),
      ...(turnEndedAt !== undefined ? { turnEndedAt } : {}),
      ...(turnSnapshots.length > 0 ? { turnSnapshots } : {}),
      ...(affectedScopes.length > 0 ? { affectedScopes } : {}),
      ...(aiFlavorReport ? { aiFlavorReport } : {}),
      ...(aiFlavorFixedIds.length > 0 ? { aiFlavorFixedIds } : {}),
      ...(aiReviewReport ? { aiReviewReport } : {}),
      ...(draftReview ? { draftReview } : {}),
      ...(qualityReport ? { qualityReport } : {}),
      ...(commitReport !== undefined ? { commitReport } : {}),
      ...(nameConsistencyWarnings.length > 0 ? { nameConsistencyWarnings } : {}),
      ...(staleThreadWarnings.length > 0 ? { staleThreadWarnings } : {}),
      ...(nextStepPrompt ? { nextStepPrompt } : {}),
      ...(isErrorNotice ? { isErrorNotice: true } : {}),
      ...(errorDetail ? { errorDetail } : {}),
    });
  }
  // Sanity 上限（防病态膨胀），不是功能性截断。⚠️ 触顶会静默丢最旧消息且【绕过冷归档】
  //（冷热分层只在打开会话时溢写；save 路径过这里）——复审 P0-2。2000 ≈ 单次不刷新页面
  // 连写 8 轮 50 章马拉松的量，真实使用触不到；根治（save 侧先归档后截断）列在跟进清单。
  return messages.slice(-2000);
}

/** 助手消息的有序分段（与 UI 侧 MessageSegment 同构）；落盘/读回的存档形态。 */
export type WorkspaceMessageSegment =
  | { readonly kind: "reasoning"; readonly text: string }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "tool"; readonly toolCallId: string };

/**
 * 校验并保留有序分段 segments（刷新/重开后历史也按真实顺序分段渲染，不退回「工具堆顶部」）。
 * 非数组 → []；逐项校验：reasoning/text 必须带 string text；tool 必须带 string toolCallId；其余丢弃。
 * 上限 400 防病态膨胀（一条长回合的分段数远低于此）。
 */
function readWorkspaceSegments(value: unknown): WorkspaceMessageSegment[] {
  if (!Array.isArray(value)) return [];
  const segments: WorkspaceMessageSegment[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    if (item.kind === "reasoning" || item.kind === "text") {
      const text = readStringAllowEmpty(item.text);
      if (text === undefined) continue;
      segments.push({ kind: item.kind, text });
    } else if (item.kind === "tool") {
      const toolCallId = readString(item.toolCallId);
      if (!toolCallId) continue;
      segments.push({ kind: "tool", toolCallId });
    }
  }
  return segments.slice(0, 400);
}

/** 「撤销到此」依赖的回合快照列表；坏项丢弃，上限 20。 */
function readWorkspaceTurnSnapshots(value: unknown): WorkspaceTurnSnapshot[] {
  if (!Array.isArray(value)) return [];
  const snapshots: WorkspaceTurnSnapshot[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const toolName = readString(item.toolName);
    const snapshotId = readString(item.snapshotId);
    if (!toolName || !snapshotId) continue;
    if ("chapterNumber" in item) {
      const chapterNumber = readPositiveInteger(item.chapterNumber);
      if (chapterNumber === undefined) continue;
      snapshots.push({ toolName, snapshotId, chapterNumber });
    } else {
      snapshots.push({ toolName, snapshotId });
    }
  }
  return snapshots.slice(0, 20);
}

function readWorkspaceAffectedScopes(value: unknown): ("full" | "foundation")[] {
  if (!Array.isArray(value)) return [];
  const scopes: ("full" | "foundation")[] = [];
  for (const item of value) {
    if (item === "full" || item === "foundation") scopes.push(item);
  }
  return scopes.slice(0, 2);
}

function readWorkspaceNameConsistencyWarnings(value: unknown): WorkspaceNameConsistencyWarning[] {
  if (!Array.isArray(value)) return [];
  const warnings: WorkspaceNameConsistencyWarning[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const establishedName = readString(item.establishedName);
    const driftedVariant = readString(item.driftedVariant);
    const message = readString(item.message);
    if (!establishedName || !driftedVariant || !message) continue;
    warnings.push({ establishedName, driftedVariant, message });
  }
  return warnings.slice(0, 20);
}

/** 回合起止毫秒时间戳：有限正数才保留（坏值不写，刷新后耗时显示宁缺毋假）。 */
function readFinitePositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** 「下一步」选项卡：question 非空 + choices 逐项 label/intent 非空、recommended 若在须 boolean；清洗后为空 → 整字段不写；上限 8。 */
function readWorkspaceNextStepPrompt(value: unknown): WorkspaceNextStepPrompt | undefined {
  if (!isRecord(value)) return undefined;
  const question = readString(value.question);
  if (!question || !Array.isArray(value.choices)) return undefined;
  const choices: { label: string; intent: string; recommended?: boolean }[] = [];
  for (const item of value.choices) {
    if (!isRecord(item)) continue;
    const label = readString(item.label);
    const intent = readString(item.intent);
    if (!label || !intent) continue;
    if ("recommended" in item && typeof item.recommended !== "boolean") continue;
    choices.push({ label, intent, ...(typeof item.recommended === "boolean" ? { recommended: item.recommended } : {}) });
  }
  if (choices.length === 0) return undefined;
  return { question, choices: choices.slice(0, 8) };
}

function readWorkspaceStaleThreadWarnings(value: unknown): WorkspaceStaleThreadWarning[] {
  if (!Array.isArray(value)) return [];
  const warnings: WorkspaceStaleThreadWarning[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const kind = readString(item.kind);
    const title = readString(item.title);
    const message = readString(item.message);
    const lastTouchedChapter = readPositiveInteger(item.lastTouchedChapter);
    const chaptersSinceTouched = readPositiveInteger(item.chaptersSinceTouched);
    if (!kind || !title || !message || lastTouchedChapter === undefined || chaptersSinceTouched === undefined) {
      continue;
    }
    warnings.push({ kind, title, lastTouchedChapter, chaptersSinceTouched, message });
  }
  return warnings.slice(0, 20);
}

function readWorkspaceSuggestedActions(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  const actions: Record<string, unknown>[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const id = readString(item.id);
    const label = readString(item.label);
    const description = readString(item.description);
    const permission = readWorkspacePermission(item.permission);
    if (!id || !label || !description || !permission) continue;
    actions.push({
      id,
      label,
      description,
      permission,
      requiresConfirmation: item.requiresConfirmation === true,
      ...(readString(item.endpoint) ? { endpoint: readString(item.endpoint) } : {}),
    });
  }
  return actions.slice(0, 8);
}

function readWorkspacePermission(value: unknown): string | readonly string[] | undefined {
  if (typeof value === "string" && isDevApiPermission(value)) return value;
  if (Array.isArray(value)) {
    const permissions = value.filter((item): item is string => typeof item === "string" && isDevApiPermission(item));
    return permissions.length > 0 ? permissions : undefined;
  }
  return undefined;
}

export function isDevApiPermission(value: string): boolean {
  return [
    "safe_read",
    "model_call",
    "draft_write",
    "project_config_write",
    "formal_state_write",
    "destructive_write",
    "local_side_effect",
  ].includes(value);
}

export function readWorkspaceFlowStatus(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return [
    "idle",
    "steering_ready",
    "draft_generating",
    "draft_ready",
    "quality_checked",
    "commit_preview_ready",
    "waiting_commit_confirmation",
    "committed",
    "ready_for_next",
  ].includes(value) ? value : undefined;
}

// ---------------------------------------------------------------------------
// Commit parsers
// ---------------------------------------------------------------------------

export function readSelectiveConfirmation(value: unknown): CommitSelectiveConfirmation | undefined {
  if (!isRecord(value)) return undefined;
  return {
    assetDecisions: readSelectiveDecisions(value.assetDecisions),
    locationDecisions: readSelectiveDecisions(value.locationDecisions),
    characterKnowledgeDecisions: readSelectiveDecisions(value.characterKnowledgeDecisions),
  };
}

function readSelectiveDecisions(value: unknown): CommitSelectiveConfirmation["assetDecisions"] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((item) => {
    const candidateId = readString(item.candidateId) ?? "";
    const rawState = readString(item.state);
    const state: "accept" | "reject" | "defer" = rawState === "accept" || rawState === "reject" || rawState === "defer" ? rawState : "defer";
    const edited = isRecord(item.edited)
      ? {
        ...(readString(item.edited.name) ? { name: readString(item.edited.name) } : {}),
        ...(readString(item.edited.after) ? { after: readString(item.edited.after) } : {}),
        ...(readString(item.edited.evidence) ? { evidence: readString(item.edited.evidence) } : {}),
      }
      : undefined;
    return {
      candidateId,
      state,
      ...(edited && Object.keys(edited).length > 0 ? { edited } : {}),
    };
  }).filter((item) => item.candidateId.length > 0);
}

// ---------------------------------------------------------------------------
// Draft quality / revision parsers
// ---------------------------------------------------------------------------

export function readDraftQualityReport(value: Record<string, unknown>): { readonly passed: boolean; readonly issues: readonly { readonly severity: "info" | "warning" | "error"; readonly type: string; readonly message: string }[] } {
  const issues = Array.isArray(value.issues)
    ? value.issues.filter(isRecord).map((item) => ({
      severity: (item.severity === "info" || item.severity === "warning" || item.severity === "error" ? item.severity : "warning") as "info" | "warning" | "error",
      type: readString(item.type) ?? "unknown",
      message: readString(item.message) ?? "",
    }))
    : [];
  return {
    passed: typeof value.passed === "boolean" ? value.passed : !issues.some((issue) => issue.severity === "error"),
    issues,
  };
}

export function readDraftRevisionTask(value: unknown, chapter: number): DraftRevisionTask {
  if (!isRecord(value)) throw new Error("修订任务不完整。");
  const id = readString(value.id) ?? `revision-${Date.now().toString(36)}`;
  const targetType = readDraftRevisionTargetType(value.targetType);
  const targetText = readString(value.targetText) ?? "";
  const problemSummary = readString(value.problemSummary) ?? "局部修订";
  const revisionGoal = readString(value.revisionGoal) ?? "根据审稿建议优化当前片段。";
  return {
    id,
    ...(readString(value.sourceIssueId) ? { sourceIssueId: readString(value.sourceIssueId) } : {}),
    ...(readString(value.sourceSuggestionId) ? { sourceSuggestionId: readString(value.sourceSuggestionId) } : {}),
    chapter: readPositiveInteger(value.chapter) ?? chapter,
    targetType,
    targetText,
    ...(readString(value.targetRangeHint) ? { targetRangeHint: readString(value.targetRangeHint) } : {}),
    problemSummary,
    revisionGoal,
    constraints: readStringList(value.constraints),
    status: "pending",
  };
}

function readDraftRevisionTargetType(value: unknown): DraftRevisionTask["targetType"] {
  return value === "paragraph" || value === "section" || value === "dialogue" || value === "opening" || value === "ending" || value === "whole_draft_note"
    ? value
    : "paragraph";
}

export function readDraftRevisionPreviewObj(value: unknown): DraftRevisionPreview {
  if (!isRecord(value)) throw new Error("修订预览不完整。");
  const taskId = requireBodyString(value.taskId, "修订预览缺少任务 ID。");
  const beforeText = requireBodyString(value.beforeText, "修订预览缺少原文。");
  const afterText = requireBodyString(value.afterText, "修订预览缺少修订后文本。");
  return normalizeDraftRevisionPreview({
    ...value,
    taskId,
    beforeText,
    afterText,
  }, {
    id: taskId,
    chapter: 0,
    targetType: "paragraph",
    targetText: beforeText,
    problemSummary: "",
    revisionGoal: "",
    constraints: [],
    status: "preview_generated",
  });
}

// ---------------------------------------------------------------------------
// Foundation gap parsers
// ---------------------------------------------------------------------------

export function readFoundationGapDecisions(value: unknown): readonly FoundationGapDecision[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((item) => {
      const suggestionId = readString(item.suggestionId);
      const decision = readString(item.decision);
      if (!suggestionId || (decision !== "accept" && decision !== "reject" && decision !== "defer" && decision !== "edit")) return undefined;
      return {
        suggestionId,
        decision,
        ...(item.editedAfter !== undefined ? { editedAfter: item.editedAfter } : {}),
      } satisfies FoundationGapDecision;
    })
    .filter((item): item is FoundationGapDecision => item !== undefined);
}

export function readFoundationGapSuggestions(value: unknown): readonly FoundationGapSuggestion[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((item): FoundationGapSuggestion | undefined => {
    const id = readString(item.id);
    const gapId = readString(item.gapId);
    const category = readFoundationGapCategory(item.category);
    const actionType = readFoundationGapActionType(item.actionType);
    const targetFile = readString(item.targetFile);
    const targetPath = readString(item.targetPath);
    const rationale = readString(item.rationale);
    const risk = readFoundationGapSeverity(item.risk);
    if (!id || !gapId || !category || !actionType || !targetFile || !targetPath || !rationale || !risk || item.requiresUserConfirm !== true) return undefined;
    return {
      id,
      gapId,
      category,
      actionType,
      targetFile,
      targetPath,
      ...(readString(item.targetId) ? { targetId: readString(item.targetId) } : {}),
      before: item.before,
      after: item.after,
      rationale,
      risk,
      requiresUserConfirm: true,
      ...(readString(item.sourceUserMessage) ? { sourceUserMessage: readString(item.sourceUserMessage) } : {}),
      ...(readString(item.extractedEntityName) ? { extractedEntityName: readString(item.extractedEntityName) } : {}),
      ...(readString(item.extractedEntityType) ? { extractedEntityType: readString(item.extractedEntityType) } : {}),
      ...(readString(item.sourceEvidence) ? { sourceEvidence: readString(item.sourceEvidence) } : {}),
      ...(readStringList(item.preservationWarnings).length > 0 ? { preservationWarnings: readStringList(item.preservationWarnings) } : {}),
      ...(item.writeMode === "replace" || item.writeMode === "merge" ? { writeMode: item.writeMode } : {}),
      ...(item.confirmedByUser === true ? { confirmedByUser: true } : {}),
    };
  }).filter((item): item is FoundationGapSuggestion => item !== undefined);
}

export function readFoundationGapCategory(value: unknown): FoundationGapSuggestion["category"] | undefined {
  return value === "story"
    || value === "world"
    || value === "writingRules"
    || value === "characters"
    || value === "characterRelationships"
    || value === "locations"
    || value === "assets"
    || value === "hooks"
    || value === "threads"
    || value === "arcGoals"
    || value === "timeline"
    || value === "knowledgeBoundary"
    ? value
    : undefined;
}

export function readFoundationGapActionType(value: unknown): FoundationGapSuggestion["actionType"] | undefined {
  return value === "fill_missing_field"
    || value === "create_character"
    || value === "rename_character"
    || value === "update_character_detail"
    || value === "create_location"
    || value === "create_asset"
    || value === "update_world_rule"
    || value === "update_writing_rule"
    || value === "update_character_boundary"
    || value === "update_location_detail"
    || value === "update_asset_status"
    || value === "create_relationship"
    || value === "update_knowledge_boundary"
    || value === "delete_foundation_entry"
    || value === "defer"
    ? value
    : undefined;
}

export function readFoundationGapSeverity(value: unknown): FoundationGapSuggestion["risk"] | undefined {
  if (value === "low") return "info";
  if (value === "medium") return "warning";
  return value === "info" || value === "warning" || value === "high" ? value : undefined;
}

export function readFoundationGapChatActions(value: unknown): readonly { readonly id: string; readonly label: string }[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((item) => {
    const id = readString(item.id);
    const label = readString(item.label);
    return id && label ? { id, label } : undefined;
  }).filter((item): item is { readonly id: string; readonly label: string } => item !== undefined).slice(0, 5);
}

/**
 * 已知实体名→id 映射表，供解析器把模型未带 targetId 的更新类建议回填到真实卡片。
 * 来源是 StateOverview（characterMatrix / assetSummary / locationDetailSummary），
 * 它是「本书全部已落盘实体」的权威清单——比 report.byCategory（只含有缺口的实体）完整。
 */
export interface FoundationKnownEntities {
  readonly characters: readonly { readonly id: string; readonly name: string }[];
  readonly locations: readonly { readonly id: string; readonly name: string }[];
  readonly assets: readonly { readonly id: string; readonly name: string }[];
}

/**
 * 按名字在已知实体清单里查 id：先精确匹配（去空白），再尝试单侧包含，查不到返回 undefined。
 * 修4（关系诚实性）：精确匹配或包含兜底若命中多于一个候选（同名歧义），返回 undefined——
 * 让其诚实 skip + 引导用户点名，而非赌第一个静默写到错卡。单一命中才回填。
 */
function resolveKnownEntityIdByName(
  entities: readonly { readonly id: string; readonly name: string }[] | undefined,
  rawName: string | undefined,
): string | undefined {
  const name = rawName?.replace(/\s+/gu, "").trim();
  if (!name || !entities || entities.length === 0) return undefined;
  const exact = entities.filter((entity) => entity.name.replace(/\s+/gu, "").trim() === name);
  if (exact.length === 1) return exact[0].id;
  if (exact.length > 1) return undefined;
  // 单侧包含兜底（如模型把「林晚」写成「林晚（雷宗）」），要求被包含名足够长以避免误匹配。
  if (name.length >= 2) {
    const contained = entities.filter((entity) => {
      const entityName = entity.name.replace(/\s+/gu, "").trim();
      return entityName.length >= 2 && (entityName.includes(name) || name.includes(entityName));
    });
    if (contained.length === 1) return contained[0].id;
  }
  return undefined;
}

function isGenericFoundationEntityTargetId(value: string | undefined): boolean {
  if (!value) return false;
  return /^(?:角色|主角|主人公|男主|女主|配角|该角色|这个角色|当前角色|现有角色|character|protagonist|main[-_\s]?character)$/iu.test(value.trim());
}

/**
 * 对更新类建议（update_character_detail / update_location_detail / update_asset_status），
 * 若模型没给 targetId，按 before.name / after.name 去已知实体清单解析真实 id 回填。
 * 解析不到就留空（不硬造），让下游写网关诚实失败（修2）+ 结果卡诚实回报（修3）兜住。
 */
function backfillTargetIdForUpdate(
  item: Record<string, unknown>,
  category: FoundationGapSuggestion["category"],
  actionType: FoundationGapSuggestion["actionType"],
  reusableSuggestion: FoundationGapSuggestion | undefined,
  knownEntities: FoundationKnownEntities | undefined,
): string | undefined {
  const explicit = readString(item.targetId);
  if (explicit && !isGenericFoundationEntityTargetId(explicit)) return explicit;

  // 只对这三类更新建议做名字回填；其他 actionType 保持原行为（仅用模型显式 targetId，
  // 即上面 explicit 为空就返回 undefined），不引入 reusableSuggestion 的 id 以免污染 delete 等路径。
  let pool: readonly { readonly id: string; readonly name: string }[] | undefined;
  if (actionType === "update_character_detail") pool = knownEntities?.characters;
  else if (actionType === "update_location_detail") pool = knownEntities?.locations;
  else if (actionType === "update_asset_status") pool = knownEntities?.assets;
  else return undefined;

  const before = isRecord(item.before) ? item.before : undefined;
  const after = isRecord(item.after) ? item.after : undefined;
  // 修3：名字来源补 extractedEntityName 兜底，与下游（gateway skipName、归一化 extractedEntityName）对齐，
  // 让模型只给 extractedEntityName 时也能回填。
  const candidateName = readString(before?.name) ?? readString(after?.name) ?? readString(item.extractedEntityName);

  return resolveKnownEntityIdByName(pool, candidateName) ?? reusableSuggestion?.targetId;
}

/**
 * 解析「更新类」foundation 写入的目标实体 id（foundation_write 工具用）。
 * 顺序：① 模型显式 targetId；② 按 targetName 在已知实体里查（精确 / 单侧包含）；
 * ③ 兜底——该类实体全书只有一个时，落到这唯一实体。
 *
 * 为什么要 ③：早期补主角人设时，模型常给 update_character_detail 但漏带 targetId/名字，引擎只能诚实跳过、
 * 显示「没能在角色资料里找到对应角色」——同一轮里好几条这样的失败很吓人（真机实测踩过）。书里只有
 * 一个角色时落到它零歧义、且写入自带快照可一键撤销，比一堆红色失败友好得多。多于一个实体时不兜底（返回
 * undefined → 引擎诚实跳过），绝不赌着写到错卡。仅对三类更新生效；create/delete/关系类不兜底（避免把新建/
 * 删除误投到唯一实体）。
 */
export function resolveFoundationUpdateTargetId(input: {
  readonly actionType: string;
  readonly targetId?: string;
  readonly targetName?: string;
  readonly knownEntities: FoundationKnownEntities | undefined;
}): string | undefined {
  let pool: readonly { readonly id: string; readonly name: string }[] | undefined;
  if (input.actionType === "update_character_detail") pool = input.knownEntities?.characters;
  else if (input.actionType === "update_location_detail") pool = input.knownEntities?.locations;
  else if (input.actionType === "update_asset_status") pool = input.knownEntities?.assets;
  else return undefined;

  const explicit = input.targetId?.trim();
  if (explicit && !isGenericFoundationEntityTargetId(explicit)) return explicit;

  const byName = resolveKnownEntityIdByName(pool, input.targetName);
  if (byName) return byName;
  // 兜底仅在「完全没给名字」时生效：模型给了名字却不匹配，多半是指另一个/新实体，
  // 诚实跳过、绝不投到唯一实体（否则会把别人的设定写到主角身上）。
  const hasName = Boolean(input.targetName?.trim());
  if (!hasName && pool && pool.length === 1) return pool[0].id;
  return undefined;
}

export function readGeneratedFoundationGapSuggestions(
  value: unknown,
  existingSuggestions: readonly FoundationGapSuggestion[],
  report: Awaited<ReturnType<typeof import("@actalk/story-engine").buildFoundationGapReport>>,
  sourceUserMessage?: string,
  knownEntities?: FoundationKnownEntities,
): readonly FoundationGapSuggestion[] {
  if (!Array.isArray(value)) return [];
  const normalized: FoundationGapSuggestion[] = [];
  // G2：本批已占用的 suggestion id。reusableSuggestion?.id 分支不含 index，若同一次解析里多条
  // 同 category 建议都匹配到同一条已有 suggestion（category-only 兜底），它们会共用同一个 id，
  // 下游多处按 id 去重（store/engine 的 Map）会把其中一条静默吞掉（真机：师父+师徒关系丢一条）。
  // 这里保证「只第一条复用稳定 id，后续撞 id 的改走唯一 fallback」——既不破坏「更新同一条资料复用
  // 稳定 id」的正常语义，又确保本批 id 两两不同。
  const usedIds = new Set<string>();
  const uniqueFallbackId = (seed: string, index: number): string => {
    let candidate = `ai-${createHash("sha1").update(seed).digest("hex").slice(0, 10)}-${index}`;
    let suffix = 0;
    while (usedIds.has(candidate)) {
      suffix += 1;
      candidate = `ai-${createHash("sha1").update(`${seed}#${suffix}`).digest("hex").slice(0, 10)}-${index}`;
    }
    return candidate;
  };
  value.filter(isRecord).forEach((item, index) => {
    const category = readFoundationGapCategory(item.category);
    const actionType = readFoundationGapActionType(item.actionType);
    const after = actionType === "delete_foundation_entry" ? null : item.after;
    if (!category || !actionType || after === undefined || item.requiresUserConfirm !== true) return;
    if (actionType === "delete_foundation_entry") {
      const deleteTargetId = readString(item.targetId);
      const deleteBeforeText = typeof item.before === "string" ? item.before.trim() : "";
      const needsTargetId = category === "characters" || category === "characterRelationships" || category === "locations" || category === "assets";
      if (needsTargetId && !deleteTargetId) return;
      if ((category === "world" || category === "writingRules") && !deleteBeforeText) return;
    }
    const reusableSuggestion = existingSuggestions.find((suggestion) => suggestion.category === category && suggestion.actionType === actionType)
      ?? existingSuggestions.find((suggestion) => suggestion.category === category);
    const targetFile = canonicalTargetFileForFoundationAction(actionType, category);
    const targetPath = canonicalTargetPathForFoundationAction(actionType, readString(item.targetPath) ?? reusableSuggestion?.targetPath);
    const seed = JSON.stringify({ category, actionType, targetFile, targetPath, after }).slice(0, 500);
    // 复用稳定 id 只给本批第一条认领；后续撞到同一 reusableSuggestion.id 的改走唯一 fallback，
    // 防止同 category 多条建议折成一条。reusableSuggestion 在 targetPath/gapId/targetId 上的兜底不变。
    const reusableId = reusableSuggestion && !usedIds.has(reusableSuggestion.id) ? reusableSuggestion.id : undefined;
    const id = reusableId ?? uniqueFallbackId(seed, index);
    usedIds.add(id);
    const gapId = readString(item.gapId) ?? reusableSuggestion?.gapId ?? report.byCategory[category]?.[0]?.id ?? `ai-gap-${category}`;
    // 修1：更新类建议若缺 targetId，按 before.name/after.name 回填真实卡片 id（解析不到则留空）。
    const resolvedTargetId = backfillTargetIdForUpdate(item, category, actionType, reusableSuggestion, knownEntities);
    normalized.push(withSuggestionSourcePreservation({
      id,
      gapId,
      category,
      actionType,
      targetFile,
      targetPath,
      ...(resolvedTargetId ? { targetId: resolvedTargetId } : {}),
      before: item.before,
      after,
      rationale: readString(item.rationale) ?? readString(item.description) ?? "AI 资料秘书建议补全，以降低后续写作穿帮风险。",
      risk: readFoundationGapSeverity(item.risk) ?? "warning",
      requiresUserConfirm: true,
    }, sourceUserMessage));
  });
  return normalized;
}

export function withSuggestionSourcePreservation(
  suggestion: FoundationGapSuggestion,
  sourceUserMessage: string | undefined,
): FoundationGapSuggestion {
  if (!sourceUserMessage || suggestion.actionType !== "create_asset") return suggestion;
  const entity = extractExplicitAssetEntity(sourceUserMessage);
  if (!entity) return { ...suggestion, sourceUserMessage, sourceEvidence: sourceUserMessage };

  const afterRecord = isRecord(suggestion.after) ? suggestion.after : undefined;
  const afterName = readString(afterRecord?.name) ?? "";
  const afterType = readString(isRecord(suggestion.after) ? suggestion.after.type : undefined) ?? "";
  const warnings: string[] = [];
  if (!assetNamePreserved(afterName, entity.name)) {
    warnings.push(`你刚才说的是：${entity.name}；AI 整理成了：${afterName || "未命名资产"}。`);
  }
  if (assetTypeConflicts(afterType, entity.type)) {
    warnings.push(`你刚才描述的资产类型更像"${entity.typeLabel}"，AI 整理成了"${afterType}"。`);
  }
  const cleanedAfter = afterRecord && warnings.length === 0 && afterName !== entity.name
    ? { ...afterRecord, name: entity.name }
    : suggestion.after;
  return {
    ...suggestion,
    ...(warnings.length > 0 ? { risk: "high" as const } : {}),
    after: cleanedAfter,
    sourceUserMessage,
    extractedEntityName: entity.name,
    extractedEntityType: entity.type,
    sourceEvidence: entity.evidence,
    ...(warnings.length > 0 ? { preservationWarnings: warnings } : {}),
  };
}

export function extractExplicitAssetEntity(message: string): { readonly name: string; readonly type: string; readonly typeLabel: string; readonly evidence: string } | undefined {
  const amount = message.match(/(\d+(?:\.\d+)?)\s*(?:元|块)(?:\s*现金)?/u)?.[0];
  if (amount) return { name: `${amount.replace(/\s+/gu, "")}现金`, type: "money", typeLabel: "现金", evidence: amount };
  const specificBackpack = message.match(/([一-鿿A-Za-z0-9]{0,8}双肩包)/u)?.[1];
  if (specificBackpack) return { name: specificBackpack, type: "container", typeLabel: "容器/背包", evidence: specificBackpack };
  const gun = message.match(/(?:那把|一把|这把)?([一-鿿A-Za-z0-9]{0,6}枪)/u)?.[1];
  if (gun) return { name: gun, type: "keyItem", typeLabel: "关键道具/武器", evidence: gun };
  const phone = message.match(/([一-鿿A-Za-z0-9]{0,6}手机)/u)?.[1];
  if (phone) return { name: phone, type: "item", typeLabel: "物品", evidence: phone };
  return undefined;
}

function assetNamePreserved(afterName: string, expectedName: string): boolean {
  const normalizedAfter = afterName.replace(/\s+/gu, "");
  const normalizedExpected = expectedName.replace(/\s+/gu, "");
  if (!normalizedAfter || !normalizedExpected) return false;
  if (normalizedAfter.includes(normalizedExpected) || normalizedExpected.includes(normalizedAfter)) return true;
  if (normalizedExpected.includes("双肩包")) return normalizedAfter.includes("双肩包");
  if (normalizedExpected.includes("现金")) return normalizedAfter.includes("现金") || normalizedAfter.includes("金额");
  if (normalizedExpected.includes("枪")) return normalizedAfter.includes("枪");
  return false;
}

function assetTypeConflicts(afterType: string, expectedType: string): boolean {
  const normalized = afterType.toLowerCase();
  if (!normalized) return false;
  if (expectedType === "container") return normalized === "phone" || normalized === "money" || normalized === "vehicle" || normalized === "document";
  if (expectedType === "money") return normalized !== "money" && normalized !== "item";
  if (expectedType === "keyItem") return normalized === "phone" || normalized === "money" || normalized === "vehicle";
  return false;
}

export function defaultTargetFileForGapCategory(category: FoundationGapSuggestion["category"] | undefined): string {
  if (category === "assets") return "story/assets.json";
  if (category === "locations") return "story/location-bible.json";
  if (category === "characters" || category === "characterRelationships" || category === "knowledgeBoundary") return "story/character-bible.json";
  if (category === "world") return "story/world-bible.json";
  if (category === "writingRules") return "story/writing-rules.json";
  return "story/bible.json";
}

function canonicalTargetFileForFoundationAction(
  actionType: FoundationGapSuggestion["actionType"],
  category: FoundationGapSuggestion["category"],
): string {
  if (actionType === "delete_foundation_entry") return defaultTargetFileForGapCategory(category);
  if (actionType === "create_character" || actionType === "rename_character" || actionType === "update_character_detail" || actionType === "create_relationship" || actionType === "update_knowledge_boundary") {
    return "story/character-bible.json";
  }
  if (actionType === "create_location" || actionType === "update_location_detail") return "story/location-bible.json";
  if (actionType === "create_asset" || actionType === "update_asset_status") return "story/assets.json";
  if (actionType === "update_world_rule") return "story/world-bible.json";
  if (actionType === "update_writing_rule") return "story/writing-rules.json";
  return defaultTargetFileForGapCategory(category);
}

function canonicalTargetPathForFoundationAction(
  actionType: FoundationGapSuggestion["actionType"],
  fallbackPath: string | undefined,
): string {
  if (
    actionType === "delete_foundation_entry"
    || actionType === "create_character"
    || actionType === "update_character_detail"
    || actionType === "create_location"
    || actionType === "create_asset"
    || actionType === "update_world_rule"
    || actionType === "update_writing_rule"
    || actionType === "update_asset_status"
  ) {
    return "$";
  }
  return fallbackPath ?? "$";
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

// 32MB：长篇书的聊天会话保存（workspace.messages 全量）在 40 章上下就会超过 1MB——
// 真机耐力跑实测撞墙（保存失败→聊天卡死）。本地单用户服务，放宽到 32MB 足够 200+ 章；
// 会话历史的无界增长另行治理（裁剪/归档），这里先保证长书不断粮。
export const MAX_JSON_BODY_BYTES = 32 * 1024 * 1024;
export const MAX_USAGE_SUMMARY_FILES = 200;
export const MAX_USAGE_SUMMARY_FILE_BYTES = 256 * 1024;

export async function readJsonFile(path: string): Promise<Record<string, unknown>> {
  const parsed = JSON.parse(await readFile(path, "utf-8")) as unknown;
  return isRecord(parsed) ? parsed : {};
}

export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > MAX_JSON_BODY_BYTES) {
      throw new Error("请求 JSON body 超过大小限制。");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks, totalBytes).toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("请求 JSON 格式无效。");
  }
  return isRecord(parsed) ? parsed : {};
}

// ---------------------------------------------------------------------------
// Path safety and project validation
// ---------------------------------------------------------------------------

const UNSAFE_HOME_PATH_SEGMENTS = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".config",
  "Library",
  "Library/Application Support",
  "Library/Keychains",
  "Library/Preferences",
];

/** Windows 家目录下的敏感首段（含平台配置根 AppData——%APPDATA%/%LOCALAPPDATA% 都在其下）。 */
const UNSAFE_HOME_PATH_SEGMENTS_WIN = [".ssh", ".gnupg", ".aws", ".config", "AppData"];

const UNSAFE_HOME_FILE_NAMES = [".env", ".npmrc", ".gitconfig", ".netrc"];

export function isSafeProjectPath(projectPath: string): boolean {
  if (isSafeProjectPathForPlatform(projectPath, process.platform, homedir())) return true;
  // SE_BOOKS_DIR 官方覆盖：用户显式把书库根指到家目录外（如测试/自定义盘）时，
  // 其下的项目路径同样可信——否则覆盖了书库根的用户所有写 API 都会被「不安全的项目路径」拒掉。
  if (!process.env.SE_BOOKS_DIR?.trim()) return false;
  const booksRoot = resolve(resolveBooksRootDir());
  const resolved = resolve(projectPath);
  return resolved !== booksRoot && resolved.startsWith(`${booksRoot}${sep}`);
}

/**
 * 平台可注入版（桌面前置·Windows 适配）：原实现是纯 POSIX 语义（"/" 分隔 + Unix 系统目录），
 * 在 Windows 上会把所有合法路径一律拒绝（home 前缀比较用 "/" 拼接永远不命中）→ 服务端整个不可用。
 * win32 分支：盘符绝对路径 + 大小写不敏感比较 + 拒系统目录（\Windows、\Program Files…）+
 * 拒家目录敏感段（AppData/.ssh…）。策略与 POSIX 一致：项目必须落在家目录下。
 * 平台/home 作参数注入，让 macOS 上的单测能直接覆盖 win32 判定逻辑。
 */
export function isSafeProjectPathForPlatform(
  projectPath: string,
  platform: NodeJS.Platform,
  home: string,
): boolean {
  if (!projectPath || projectPath.includes("\0")) return false;
  if (platform === "win32") {
    const win = win32Path;
    if (!win.isAbsolute(projectPath)) return false;
    const resolvedPath = win.resolve(projectPath);
    const lower = resolvedPath.toLowerCase();

    // 系统目录（任意盘符）：\Windows、\Program Files、\Program Files (x86)、\ProgramData
    const WIN_SYSTEM_DIRS = ["\\windows", "\\program files", "\\program files (x86)", "\\programdata"];
    for (const dir of WIN_SYSTEM_DIRS) {
      const index = lower.indexOf(dir);
      if (index === 2 && (lower.length === index + dir.length || lower[index + dir.length] === "\\")) return false;
    }

    const homeResolved = win.resolve(home);
    const homeLower = homeResolved.toLowerCase();
    if (lower === homeLower) return false;
    if (!lower.startsWith(`${homeLower}\\`)) return false;

    const relativeHomePath = resolvedPath.slice(homeResolved.length + 1);
    const firstHomeSegment = (relativeHomePath.split("\\")[0] ?? "").toLowerCase();
    if (UNSAFE_HOME_FILE_NAMES.includes(firstHomeSegment)) return false;
    if (UNSAFE_HOME_PATH_SEGMENTS_WIN.some((segment) => segment.toLowerCase() === firstHomeSegment)) return false;
    return true;
  }

  if (!isAbsolute(projectPath)) return false;
  const resolvedPath = resolve(projectPath);
  if (resolvedPath !== projectPath && projectPath.endsWith("/")) return false;

  const SYSTEM_DIRS = ["/etc", "/usr", "/var", "/bin", "/sbin", "/System", "/Library", "/private"];
  for (const dir of SYSTEM_DIRS) {
    if (resolvedPath === dir || resolvedPath.startsWith(dir + "/")) return false;
  }

  const UNSAFE_PREFIXES = ["/dev/", "/proc/", "/sys/"];
  for (const prefix of UNSAFE_PREFIXES) {
    if (resolvedPath.startsWith(prefix)) return false;
  }

  if (!resolvedPath.startsWith(home + "/") && resolvedPath !== home) {
    return false;
  }
  if (resolvedPath === home) return false;

  const relativeHomePath = resolvedPath.slice(home.length + 1);
  const firstHomeSegment = relativeHomePath.split("/")[0] ?? "";
  if (UNSAFE_HOME_FILE_NAMES.includes(firstHomeSegment)) return false;
  for (const unsafePath of UNSAFE_HOME_PATH_SEGMENTS) {
    if (relativeHomePath === unsafePath || relativeHomePath.startsWith(`${unsafePath}/`)) return false;
  }

  return true;
}

export function guardProjectPath(res: ServerResponse, projectPath: string): boolean {
  if (!isSafeProjectPath(projectPath)) {
    writeJson(res, 400, { ok: false, error: "不安全的项目路径" });
    return false;
  }
  return true;
}

export async function assertStoryEngineProject(projectDir: string): Promise<{ readonly title: string }> {
  if (projectDir.includes("\0")) {
    throw new Error("项目路径无效。");
  }
  const resolved = resolve(projectDir);
  const info = await stat(resolved).catch(() => null);
  if (!info?.isDirectory()) {
    throw new Error("项目目录不存在。");
  }

  const project = JSON.parse(await readFile(join(resolved, "project.json"), "utf-8")) as unknown;
  if (!isRecord(project) || typeof project.title !== "string" || !project.title.trim()) {
    throw new Error("不是有效的 StoryEngine 项目：缺少 project.json。");
  }

  for (const dir of ["story", "timeline", "world", "characters"]) {
    const dirInfo = await stat(join(resolved, dir)).catch(() => null);
    if (!dirInfo?.isDirectory()) {
      throw new Error(`不是有效的 StoryEngine 项目：缺少 ${dir} 目录。`);
    }
  }

  return { title: project.title.trim() };
}

// ---------------------------------------------------------------------------
// String utilities
// ---------------------------------------------------------------------------

export function mergeStringLists(...values: readonly unknown[]): string[] {
  const next: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const items = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
    for (const item of items) {
      if (typeof item !== "string") continue;
      const normalized = item.trim();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      next.push(normalized);
    }
  }
  return next;
}

export function toSafeLocalId(value: string, fallback: string): string {
  const safe = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/['']/gu, "")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .replace(/-{2,}/gu, "-");
  return safe || `${fallback}-${createHash("sha256").update(value).digest("hex").slice(0, 6)}`;
}

export function splitChineseList(value: string): string[] {
  return value
    .split(/[、,，]/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function extractJsonObject(raw: string): string | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/u);
  if (fenced?.[1]) return fenced[1].trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  return raw.slice(start, end + 1).trim();
}

export function compactRecord<T extends Record<string, unknown>>(record: T): Partial<T> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => (
    value !== undefined && (!Array.isArray(value) || value.length > 0)
  ))) as Partial<T>;
}

// ---------------------------------------------------------------------------
// Draft / chapter path helpers
// ---------------------------------------------------------------------------

export function stripLeadingMarkdownChapterHeading(content: string): string {
  const normalized = content.replace(/\r\n?/gu, "\n").trimStart();
  const lines = normalized.split("\n");
  const firstContentLineIndex = lines.findIndex((line) => line.trim().length > 0);
  if (firstContentLineIndex < 0) return normalized.trim();

  const firstContentLine = lines[firstContentLineIndex].trim();
  if (!isMarkdownChapterHeading(firstContentLine)) return normalized.trim();

  const nextLines = lines.slice(firstContentLineIndex + 1);
  while (nextLines[0]?.trim() === "") nextLines.shift();
  return nextLines.join("\n").trim();
}

function isMarkdownChapterHeading(line: string): boolean {
  if (!/^#{1,6}\s+\S/u.test(line)) return false;
  const title = line.replace(/^#{1,6}\s+/u, "").trim();
  if (!title) return false;
  if (/^第[一二三四五六七八九十百千万\d]+章(?:\s*[·：:、-]\s*.*)?$/u.test(title)) return true;
  return title.length <= 40 && !/[。！？!?；;]/u.test(title);
}

export function defaultDraftPath(projectDir: string, chapter: number): string {
  return join(projectDir, "drafts", "fast", `chapter-${padChapter(chapter)}.md`);
}

export function defaultCommittedChapterPath(projectDir: string, chapter: number): string {
  return join(projectDir, "chapters", `${padChapter(chapter)}.md`);
}

export function padChapter(chapter: number): string {
  return String(chapter).padStart(4, "0");
}

export function chapterWorkspacePath(projectDir: string, chapter: number): string {
  return join(projectDir, ".story-engine-ui", "chapter-workspaces", `chapter-${padChapter(chapter)}.json`);
}

export function extractDraftTitle(content: string | undefined): string | null {
  if (!content) return null;
  const firstLine = content.split(/\r?\n/u).find((line) => line.trim().length > 0)?.trim();
  if (!firstLine?.startsWith("#")) return null;
  const title = firstLine.replace(/^#+\s*/u, "").replace(/^第[一二三四五六七八九十百\d]+章\s*[·：:、-]?\s*/u, "").trim();
  return title || null;
}

export async function readChapterWorkspaceSnapshot(projectDir: string, chapter: number): Promise<{
  readonly chapter: number;
  readonly messages: readonly {
    readonly id: string;
    readonly role: "user" | "assistant" | "system";
    readonly content: string;
    readonly adviceCards?: readonly Record<string, unknown>[];
    readonly suggestedActions?: readonly Record<string, unknown>[];
    readonly toolOutput?: readonly string[];
    readonly createdAt?: string;
  }[];
  readonly selectedAdviceCardKeys: readonly string[];
  readonly flowStatus?: string;
  readonly draftContent?: string;
  readonly draftTitle?: string;
  readonly hasDraftFile?: boolean;
  readonly hasCommittedChapter?: boolean;
  readonly pendingBaseContent?: string;
  readonly pendingChangeSource?: "ai" | "manual";
  readonly updatedAt?: string;
  readonly revision?: number;
  /** 上次生成被刷新打断；为 true 时读侧以盘上更完整稿为准（dogfood F1）。 */
  readonly generationInterrupted?: boolean;
  /** 读侧已用磁盘稿覆盖了截断的 workspace.draftContent。 */
  readonly recoveredFromDraftFile?: boolean;
}> {
  const parsed = await readFile(chapterWorkspacePath(projectDir, chapter), "utf-8")
    .then((text) => JSON.parse(text) as unknown)
    .catch(() => null);
  const record = isRecord(parsed) ? parsed : {};
  const revision = typeof record.revision === "number" && Number.isFinite(record.revision) ? record.revision : 0;
  const pendingChangeSource = record.pendingChangeSource === "ai" || record.pendingChangeSource === "manual"
    ? record.pendingChangeSource
    : undefined;
  const pendingDraftContent = readStringAllowEmpty(record.draftContent);
  const flowStatus = readWorkspaceFlowStatus(record.flowStatus);
  const committedChapterContent = await readFile(defaultCommittedChapterPath(projectDir, chapter), "utf-8").catch(() => undefined);
  const draftFileContent = await readFile(defaultDraftPath(projectDir, chapter), "utf-8").catch(() => undefined);
  const savedDraftContent = draftFileContent ?? readStringAllowEmpty(record.draftContent);
  const hasCommittedChapter = committedChapterContent !== undefined;
  const hasDraftFile = hasRealDraftContent(draftFileContent);
  const recoveredMisroutedDraft = committedChapterContent !== undefined
    && !pendingChangeSource
    && isLikelyMisroutedWorkspaceDraft(savedDraftContent);
  const shouldUseCommittedChapter = committedChapterContent !== undefined
    && !pendingChangeSource
    && (
      !hasDraftFile ||
      flowStatus === "committed"
      || flowStatus === "ready_for_next"
      || recoveredMisroutedDraft
      || normalizedContent(savedDraftContent) === normalizedContent(committedChapterContent)
    );
  // dogfood F1：仅在「生成被打断」证据在场时启用恢复——generationInterrupted，或遗留的
  // draft_generating（刷新后不可能仍在生成）。此时若 drafts/fast 明显长于 workspace.draftContent，
  // 以文件为准，避免截断 workspace 态盖过完整盘稿。故意短写（非生成期）不走此分支。
  const generationInterrupted = record.generationInterrupted === true || flowStatus === "draft_generating";
  const workspaceDraftLen = (pendingDraftContent ?? "").trim().length;
  const draftFileLen = (draftFileContent ?? "").trim().length;
  const preferDraftFileAfterInterrupt = generationInterrupted
    && !shouldUseCommittedChapter
    && !pendingChangeSource
    && draftFileContent !== undefined
    && draftFileLen > workspaceDraftLen;
  let effectiveFlowStatus = recoveredMisroutedDraft && flowStatus !== "committed" && flowStatus !== "ready_for_next"
    ? "ready_for_next"
    : shouldUseCommittedChapter && flowStatus !== "ready_for_next"
      ? "committed"
      : flowStatus;
  // 刷新后残留 draft_generating → 诚实改成「草稿中/等待指令」，别渲染「正在生成」或空徽标。
  if (effectiveFlowStatus === "draft_generating") {
    const hasRecoverableDraft = preferDraftFileAfterInterrupt
      || hasRealDraftContent(draftFileContent)
      || hasRealDraftContent(pendingDraftContent);
    effectiveFlowStatus = hasRecoverableDraft ? "draft_ready" : "idle";
  }
  const stalePreCommitSnapshot = shouldUseCommittedChapter
    && !recoveredMisroutedDraft
    && flowStatus !== "committed"
    && flowStatus !== "ready_for_next";
  const draftContent = pendingChangeSource && pendingDraftContent !== undefined
    ? pendingDraftContent
    : shouldUseCommittedChapter
      ? committedChapterContent
      : preferDraftFileAfterInterrupt
        ? draftFileContent
        : savedDraftContent;
  const draftTitle = extractDraftTitle(draftContent) ?? readString(record.draftTitle);
  const workspaceMessages = readWorkspaceMessages(record.messages);
  const committedWithoutCompletionMessage = shouldUseCommittedChapter
    && effectiveFlowStatus === "committed"
    && workspaceMessages.length > 0
    && !workspaceMessages.some((message) => isCommitCompletionMessage(message.content) || isPostCommitAgentMessage(message));
  return {
    chapter,
    messages: recoveredMisroutedDraft || stalePreCommitSnapshot || committedWithoutCompletionMessage ? [] : workspaceMessages,
    selectedAdviceCardKeys: recoveredMisroutedDraft || stalePreCommitSnapshot ? [] : readStringList(record.selectedAdviceCardKeys),
    ...(effectiveFlowStatus ? { flowStatus: effectiveFlowStatus } : {}),
    ...(draftContent !== undefined ? { draftContent } : {}),
    ...(draftTitle ? { draftTitle } : {}),
    hasDraftFile,
    hasCommittedChapter,
    ...(readStringAllowEmpty(record.pendingBaseContent) !== undefined ? { pendingBaseContent: readStringAllowEmpty(record.pendingBaseContent) } : {}),
    ...(pendingChangeSource ? { pendingChangeSource } : {}),
    ...(readString(record.updatedAt) ? { updatedAt: readString(record.updatedAt) } : {}),
    revision,
    ...(generationInterrupted ? { generationInterrupted: true } : {}),
    ...(preferDraftFileAfterInterrupt ? { recoveredFromDraftFile: true } : {}),
  };
}

export interface UiChapterFileState {
  readonly chapter: number;
  readonly hasDraftFile: boolean;
  readonly hasCommittedChapter: boolean;
  /** workspace 文件存在（章节被打开过）。供导航判断「走到哪一章」，不代表本章有真草稿。 */
  readonly hasWorkspaceSnapshot?: boolean;
  /** workspace 的 draftContent 里有「真草稿」内容（非空、非占位符）。章节「有草稿」状态看这个，不看 hasWorkspaceSnapshot。 */
  readonly hasWorkspaceDraft?: boolean;
  readonly draftTitle?: string;
  readonly committedTitle?: string;
  readonly workspaceTitle?: string;
}

/** 扫全书章节文件，给出每章「有无草稿 / 是否入库 / 标题」状态。只读盘、题材中立，供 agent 章节状态可见性用。 */
export async function readUiChapterFileStates(projectDir: string): Promise<readonly UiChapterFileState[]> {
  const chapters = new Set<number>();
  const committedFiles = await readdir(join(projectDir, "chapters")).catch(() => []);
  const draftFiles = await readdir(join(projectDir, "drafts", "fast")).catch(() => []);
  const workspaceFiles = await readdir(join(projectDir, ".story-engine-ui", "chapter-workspaces")).catch(() => []);

  for (const file of committedFiles) {
    const chapter = chapterNumberFromCommittedFile(file);
    if (chapter !== undefined) chapters.add(chapter);
  }
  for (const file of draftFiles) {
    const chapter = chapterNumberFromDraftFile(file);
    if (chapter !== undefined) chapters.add(chapter);
  }
  for (const file of workspaceFiles) {
    const chapter = chapterNumberFromWorkspaceFile(file);
    if (chapter !== undefined) chapters.add(chapter);
  }

  const states = await Promise.all([...chapters].sort((a, b) => a - b).map(async (chapter) => {
    const [committedContent, draftContent, workspaceContent] = await Promise.all([
      readFile(defaultCommittedChapterPath(projectDir, chapter), "utf-8").catch(() => undefined),
      readFile(defaultDraftPath(projectDir, chapter), "utf-8").catch(() => undefined),
      readFile(chapterWorkspacePath(projectDir, chapter), "utf-8").catch(() => undefined),
    ]);
    const workspaceRecord = parseWorkspaceRecord(workspaceContent);
    const workspaceDraftContent = readStringAllowEmpty(workspaceRecord?.draftContent);
    const workspaceTitle = readString(workspaceRecord?.draftTitle) ?? extractDraftTitle(workspaceDraftContent);
    return {
      chapter,
      hasDraftFile: hasRealDraftContent(draftContent),
      hasCommittedChapter: committedContent !== undefined,
      ...(workspaceContent !== undefined ? { hasWorkspaceSnapshot: true } : {}),
      ...(hasRealDraftContent(workspaceDraftContent) ? { hasWorkspaceDraft: true } : {}),
      ...(extractDraftTitle(draftContent) ? { draftTitle: extractDraftTitle(draftContent)! } : {}),
      ...(extractDraftTitle(committedContent) ? { committedTitle: extractDraftTitle(committedContent)! } : {}),
      ...(workspaceTitle ? { workspaceTitle } : {}),
    };
  }));
  return states;
}

function parseWorkspaceRecord(content: string | undefined): Record<string, unknown> | null {
  if (!content) return null;
  try {
    const parsed = JSON.parse(content) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function chapterNumberFromCommittedFile(file: string): number | undefined {
  const match = file.match(/^(\d{4})\.md$/u);
  if (!match?.[1]) return undefined;
  const chapter = Number(match[1]);
  return Number.isInteger(chapter) && chapter > 0 ? chapter : undefined;
}

function chapterNumberFromDraftFile(file: string): number | undefined {
  const match = file.match(/^chapter-(\d{4})\.md$/u);
  if (!match?.[1]) return undefined;
  const chapter = Number(match[1]);
  return Number.isInteger(chapter) && chapter > 0 ? chapter : undefined;
}

function chapterNumberFromWorkspaceFile(file: string): number | undefined {
  const match = file.match(/^chapter-(\d{4})\.json$/u);
  if (!match?.[1]) return undefined;
  const chapter = Number(match[1]);
  return Number.isInteger(chapter) && chapter > 0 ? chapter : undefined;
}

function isCommitCompletionMessage(content: string): boolean {
  return /本章已入库|正式入库完成|已提交到正式故事状态|写入正式故事状态/u.test(content);
}

function isPostCommitAgentMessage(message: {
  readonly id: string;
  readonly content: string;
}): boolean {
  if (/^assistant-foundation-(?:applied|rollback)-/u.test(message.id)) return true;
  return /(?:资料已更新，可撤回本次修改|左侧资料已更新，可撤回本次修改|已撤回本次修改)/u.test(message.content);
}

function normalizedContent(content: string | undefined): string {
  return (content ?? "").trim().replace(/\r\n?/gu, "\n");
}

/**
 * 识别「显示用空草稿占位符」——buildStateBackedDraftPlaceholder（stateOverviewAdapter.ts）在
 * 「本章还没有真正文」时给写作台显示的引导语（以「还没有草稿正文」/「还没有载入本章草稿正文」开头）。
 * 这种占位符不是用户/AI 写的真草稿，一旦它被落进 drafts/fast 的 .md 或 workspace 的 draftContent，
 * 绝不能被当成「有草稿」——否则章节状态会谎报「有草稿未入库」、agent 跟着说「第N章已有工作稿」，
 * 用户打开却是空的（真机实测 bug）。真草稿绝不会以这两个标记开头，故按开头判定足够安全、题材中立。
 */
function isStateBackedDraftPlaceholder(content: string | undefined): boolean {
  const body = stripLeadingMarkdownChapterHeading(normalizedContent(content)).trim();
  if (!body) return false;
  return body.startsWith("还没有草稿正文") || body.startsWith("还没有载入本章草稿正文");
}

/**
 * 哨兵字面串：模型缺值时常把 draftContent 发成 "None"/"null"/"undefined"（退化输入）。整篇正文恰为这几个
 * 词绝不可能是真草稿——必须视同缺省，否则被当 4 字真稿喂引擎误报「正文过短」造假硬伤（E2E 实锤）。
 */
const SENTINEL_DRAFT_BODIES = new Set(["none", "null", "undefined"]);
function isSentinelDraftContent(content: string | undefined): boolean {
  return SENTINEL_DRAFT_BODIES.has(normalizedContent(content).toLowerCase());
}

/** 「真草稿」判定：去空白后非空，且不是显示用空草稿占位符、也不是哨兵字面串。章节「有草稿」状态的唯一权威口径。 */
export function hasRealDraftContent(content: string | undefined): boolean {
  return normalizedContent(content).length > 0
    && !isStateBackedDraftPlaceholder(content)
    && !isSentinelDraftContent(content);
}

function isLikelyMisroutedWorkspaceDraft(content: string | undefined): boolean {
  if (!content) return false;
  const normalized = content.trim();
  if (!normalized) return false;
  if (/^(?:角色档案|资料卡|资料草案|写入结果|底层输出|正文写作流程完成|已整理|已写入|当前没有可写入)/u.test(normalized)) return true;
  if (/以下是写入内容的最终摘要|确认前不会写入|满意就保存草稿，不满意就拒绝改动|你可以随时补充其他角色/u.test(normalized)) return true;
  const lines = normalized.split(/\r?\n/u).filter((line) => line.trim());
  const bulletLines = lines.filter((line) => /^\s*[-*]\s+/u.test(line));
  return normalized.length < 1200 && bulletLines.length >= 4 && /(?:姓名|年龄|外貌|身份|目标|背景|欲望|恐惧|禁忌)/u.test(normalized);
}

// ---------------------------------------------------------------------------
// UI overview helpers
// ---------------------------------------------------------------------------

type StoryCalendarView = {
  readonly currentStoryDay: number;
  readonly currentTimeOfDay: "morning" | "noon" | "afternoon" | "evening" | "night" | "late_night" | "unknown";
};

type CharacterDetailView = Record<string, unknown> & {
  readonly id: string;
  readonly name: string;
};

async function readStoryCalendarView(projectDir: string): Promise<StoryCalendarView | undefined> {
  const parsed = await readFile(join(projectDir, "time", "calendar.json"), "utf-8")
    .then((text) => JSON.parse(text) as unknown)
    .catch(() => undefined);
  if (!isRecord(parsed)) return undefined;
  const currentStoryDay = readPositiveInteger(parsed.currentStoryDay) ?? 1;
  const currentTimeOfDay = readCalendarTimeOfDay(parsed.currentTimeOfDay);
  return { currentStoryDay, currentTimeOfDay };
}

function readCalendarTimeOfDay(value: unknown): StoryCalendarView["currentTimeOfDay"] {
  return value === "morning"
    || value === "noon"
    || value === "afternoon"
    || value === "evening"
    || value === "night"
    || value === "late_night"
    || value === "unknown"
    ? value
    : "unknown";
}

async function readJsonRecord(path: string): Promise<Record<string, unknown> | undefined> {
  const parsed = await readFile(path, "utf-8")
    .then((text) => JSON.parse(text) as unknown)
    .catch(() => undefined);
  return isRecord(parsed) ? parsed : undefined;
}

function readStringListLocal(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
  return [];
}

async function readCharacterDetailViews(projectDir: string): Promise<readonly CharacterDetailView[]> {
  const entries = await readdir(join(projectDir, "characters"), { withFileTypes: true }).catch(() => []);
  const bible = await readFile(join(projectDir, "story", "character-bible.json"), "utf-8")
    .then((text) => JSON.parse(text) as unknown)
    .catch(() => undefined);
  const bibleCharacters = isRecord(bible) && Array.isArray(bible.characters) ? bible.characters.filter(isRecord) : [];
  const details = await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map(async (entry) => {
      const characterDir = join(projectDir, "characters", entry.name);
      const [profile, state, core] = await Promise.all([
        readJsonRecord(join(characterDir, "profile.json")),
        readJsonRecord(join(characterDir, "state.json")),
        readJsonRecord(join(characterDir, "core.json")),
      ]);
      if (!profile) return undefined;
      const id = readString(profile.id) ?? entry.name;
      const bibleEntry = bibleCharacters.find((item) => readString(item.id) === id || readString(item.name) === readString(profile.name));
      return compactRecord({
        id,
        name: readString(profile.name) ?? id,
        role: readString(bibleEntry?.role) ?? readString(profile.identity),
        identity: readString(profile.identity),
        age: readString(profile.age),
        gender: readString(profile.gender),
        height: readString(profile.height),
        weight: readString(profile.weight),
        distinctiveTraits: readStringListLocal(profile.distinctiveTraits),
        bodyTraits: readStringListLocal(profile.bodyTraits),
        privateBodyTraits: readStringListLocal(profile.privateBodyTraits),
        intimacyBoundaries: readStringListLocal(profile.intimacyBoundaries),
        tags: readStringListLocal(profile.tags),
        appearance: isRecord(profile.appearance) ? profile.appearance : undefined,
        appearanceAnchors: mergeStringLists(profile.appearanceAnchors, bibleEntry?.appearanceAnchors),
        emotion: readString(state?.emotion) ?? readString(state?.mood),
        goal: readString(state?.goal) ?? readString(state?.currentGoal),
        mood: readString(state?.mood) ?? readString(state?.emotion),
        currentGoal: readString(state?.currentGoal) ?? readString(state?.goal),
        recentEvents: readStringListLocal(state?.recentEvents),
        relationshipToUser: readString(state?.relationshipToUser),
        currentArc: readString(state?.currentArc),
        currentLocationId: readString(state?.currentLocationId),
        currentLocationName: readString(state?.currentLocationName),
        lastUpdatedChapter: typeof state?.lastUpdatedChapter === "number" ? state.lastUpdatedChapter : null,
        personality: readStringListLocal(core?.personality),
        speechStyle: readString(core?.speechStyle),
        taboos: readStringListLocal(core?.taboos),
        worldview: readString(core?.worldview),
        desire: readString(bibleEntry?.desire) ?? readString(core?.desire),
        fear: readString(bibleEntry?.fear) ?? readString(core?.fear),
        weakness: readString(bibleEntry?.weakness),
        contradiction: readString(bibleEntry?.contradiction) ?? readString(core?.contradiction),
        moralBoundary: readString(bibleEntry?.moralBoundary) ?? readString(core?.moralBoundary),
        privateMotive: readString(bibleEntry?.privateMotive),
        relationshipToProtagonist: readString(bibleEntry?.relationshipToProtagonist),
        relationshipDynamics: readStringListLocal(bibleEntry?.relationshipDynamics),
        trustLevel: readString(bibleEntry?.trustLevel),
        hiddenStance: readString(bibleEntry?.hiddenStance),
        speechRules: readStringListLocal(bibleEntry?.speechRules),
        speechSamples: mergeStringLists(bibleEntry?.speechSamples, isRecord(core?.voice) ? core.voice.sampleLines : undefined),
        behaviorBoundaries: readStringListLocal(bibleEntry?.behaviorBoundaries),
        knowledgeKnown: mergeStringLists(bibleEntry?.knowledgeKnown, state?.knowledgeKnown),
        knowledgeUnknown: mergeStringLists(bibleEntry?.knowledgeUnknown, state?.knowledgeUnknown),
        cannotReveal: mergeStringLists(bibleEntry?.cannotReveal, state?.cannotReveal),
        cannotDo: readStringListLocal(bibleEntry?.cannotDo),
        arcPromise: readString(bibleEntry?.arcPromise),
        currentStateHint: readString(bibleEntry?.currentStateHint),
        currentPhysicalState: readString(state?.currentPhysicalState),
        currentMentalState: readString(state?.currentMentalState),
        currentResourceState: readString(state?.currentResourceState),
      }) as CharacterDetailView;
    }));
  return details.filter((item): item is CharacterDetailView => item !== undefined);
}

export async function withUiOverviewDetails(projectDir: string, overview: StateOverview): Promise<StateOverview & {
  readonly calendar?: StoryCalendarView;
  readonly characterDetails?: readonly CharacterDetailView[];
  readonly uiChapterFiles?: readonly {
    readonly chapter: number;
    readonly hasDraftFile: boolean;
    readonly hasCommittedChapter: boolean;
    readonly hasWorkspaceSnapshot?: boolean;
    readonly hasWorkspaceDraft?: boolean;
    readonly draftTitle?: string;
    readonly committedTitle?: string;
    readonly workspaceTitle?: string;
  }[];
}> {
  const calendar = await readStoryCalendarView(projectDir);
  const [characterDetails, uiChapterFiles] = await Promise.all([
    readCharacterDetailViews(projectDir),
    readUiChapterFileStates(projectDir),
  ]);
  return {
    ...overview,
    ...(calendar ? { calendar } : {}),
    ...(characterDetails.length ? { characterDetails } : {}),
    ...(uiChapterFiles.length ? { uiChapterFiles } : {}),
  };
}

// ---------------------------------------------------------------------------
// Usage summary
// ---------------------------------------------------------------------------

export async function readUsageSummary(projectDir: string): Promise<{
  readonly diagnosticsAvailable: boolean;
  readonly diagnosticsCount: number;
  readonly diagnosticsWarnings: readonly string[];
  readonly totalTokens: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly cacheHitTokens: number | null;
  readonly cacheMissTokens: number | null;
  readonly cacheHitRatio: number | null;
  readonly recent: readonly {
    readonly stage: string;
    readonly chapter: number | null;
    readonly generatedAt: string | null;
    readonly totalTokens: number | null;
    readonly promptTokens: number | null;
    readonly completionTokens: number | null;
    readonly cacheHitRatio: number | null;
    readonly elapsedMs: number | null;
  }[];
}> {
  const diagnosticsDir = join(projectDir, "diagnostics");
  const files = await readdir(diagnosticsDir).catch(() => []);
  const diagnosticsWarnings = new Set<string>();
  const jsonFiles = files.filter((file) => file.endsWith(".json")).sort();
  if (jsonFiles.length > MAX_USAGE_SUMMARY_FILES) {
    diagnosticsWarnings.add("diagnostics_file_count_limit");
  }
  const records: (Record<string, unknown> | null)[] = [];
  for (const file of jsonFiles.slice(0, MAX_USAGE_SUMMARY_FILES)) {
    const filePath = join(diagnosticsDir, file);
    let fileStats: Awaited<ReturnType<typeof stat>>;
    try {
      fileStats = await stat(filePath);
    } catch {
      diagnosticsWarnings.add("diagnostics_file_read_error");
      continue;
    }
    if (fileStats.size > MAX_USAGE_SUMMARY_FILE_BYTES) {
      diagnosticsWarnings.add("diagnostics_file_size_limit");
      continue;
    }
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf-8")) as unknown;
      records.push(isRecord(parsed) ? parsed : null);
    } catch {
      diagnosticsWarnings.add("diagnostics_file_parse_error");
    }
  }
  const valid = records.filter((record): record is Record<string, unknown> => Boolean(record));
  let totalTokens = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let cacheHitTokens = 0;
  let cacheMissTokens = 0;
  let cacheAvailable = false;

  const recent = valid.map((record) => {
    const tokenUsage = isRecord(record.tokenUsage) ? record.tokenUsage : {};
    const cacheMetrics = isRecord(record.cacheMetrics) ? record.cacheMetrics : isRecord(record.details) && isRecord(record.details.cacheMetrics) ? record.details.cacheMetrics : {};
    const prompt = readNumber(tokenUsage.promptTokens);
    const completion = readNumber(tokenUsage.completionTokens);
    const total = readNumber(tokenUsage.totalTokens);
    const hit = readNumber(cacheMetrics.promptCacheHitTokens);
    const miss = readNumber(cacheMetrics.promptCacheMissTokens);
    const ratio = readNumber(cacheMetrics.cacheHitRatio);
    totalTokens += total ?? 0;
    promptTokens += prompt ?? 0;
    completionTokens += completion ?? 0;
    if (hit !== undefined || miss !== undefined) {
      cacheAvailable = true;
      cacheHitTokens += hit ?? 0;
      cacheMissTokens += miss ?? 0;
    }
    const runtimeLatency = isRecord(record.runtimeLatency) ? record.runtimeLatency : {};
    return {
      stage: readString(record.stage) ?? "unknown",
      chapter: readNumber(record.chapter) ?? null,
      generatedAt: readString(record.generatedAt) ?? null,
      totalTokens: total ?? null,
      promptTokens: prompt ?? null,
      completionTokens: completion ?? null,
      cacheHitRatio: ratio ?? null,
      elapsedMs: readNumber(runtimeLatency.elapsedMs) ?? null,
    };
  }).sort((left, right) => String(right.generatedAt ?? "").localeCompare(String(left.generatedAt ?? ""))).slice(0, 8);

  return {
    diagnosticsAvailable: valid.length > 0,
    diagnosticsCount: valid.length,
    diagnosticsWarnings: Array.from(diagnosticsWarnings),
    totalTokens,
    promptTokens,
    completionTokens,
    cacheHitTokens: cacheAvailable ? cacheHitTokens : null,
    cacheMissTokens: cacheAvailable ? cacheMissTokens : null,
    cacheHitRatio: cacheAvailable && cacheHitTokens + cacheMissTokens > 0 ? cacheHitTokens / (cacheHitTokens + cacheMissTokens) : null,
    recent,
  };
}

// ---------------------------------------------------------------------------
// Asset helpers (for create-book / books routes)
// ---------------------------------------------------------------------------

export interface UiAssetItem {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly ownerCharacterId?: string;
  readonly ownerName?: string;
  readonly currentLocationName?: string;
  readonly carriedByCharacterId?: string;
  readonly status: string;
  readonly conditionNote?: string;
  readonly isConsumable?: boolean;
  readonly isPlotCritical?: boolean;
  readonly canAiModify?: boolean;
  readonly firstSeenChapter?: number;
  readonly lastSeenChapter?: number;
  readonly rules?: readonly string[];
  readonly notes?: readonly string[];
}

export function createInitialAssetItems(input: {
  readonly ownerCharacterId: string;
  readonly ownerName: string;
  readonly currentLocationName?: string;
  readonly initialAssets: readonly string[];
  readonly keyItems: readonly string[];
  readonly resourceLimits: readonly string[];
}): UiAssetItem[] {
  const keySet = new Set(input.keyItems);
  return input.initialAssets.map((name) => ({
    id: toSafeLocalId(name, "asset"),
    name,
    type: inferAssetType(name),
    ownerCharacterId: input.ownerCharacterId,
    ownerName: input.ownerName,
    currentLocationName: input.currentLocationName,
    carriedByCharacterId: input.ownerCharacterId,
    status: inferAssetStatus(name, input.resourceLimits),
    conditionNote: input.resourceLimits.find((limit) => limit.includes(name) || name.includes(limit.replace(/不足|欠费|没有/u, ""))),
    isConsumable: /水|食物|现金|钱|电量|药/u.test(name),
    isPlotCritical: keySet.has(name) || /申请表|钥匙|证件|地图|收音机/u.test(name),
    canAiModify: false,
    firstSeenChapter: 1,
    lastSeenChapter: 1,
    rules: assetRulesFor(name, input.resourceLimits),
    notes: input.resourceLimits.filter((limit) => limit.includes(name) || name.includes(limit.replace(/不足|欠费|没有/u, ""))),
  }));
}

export function mergeAssetItems(current: unknown, additions: readonly UiAssetItem[]): UiAssetItem[] {
  const next: UiAssetItem[] = [];
  const seen = new Set<string>();
  const add = (item: UiAssetItem) => {
    if (seen.has(item.id)) return;
    seen.add(item.id);
    next.push(item);
  };
  if (Array.isArray(current)) {
    for (const item of current) {
      if (!isRecord(item)) continue;
      const name = readString(item.name);
      if (!name) continue;
      add({
        id: readString(item.id) ?? toSafeLocalId(name, "asset"),
        name,
        type: readString(item.type) ?? inferAssetType(name),
        ownerCharacterId: readString(item.ownerCharacterId),
        ownerName: readString(item.ownerName),
        currentLocationName: readString(item.currentLocationName),
        carriedByCharacterId: readString(item.carriedByCharacterId),
        status: readString(item.status) ?? "unknown",
        conditionNote: readString(item.conditionNote),
        isConsumable: item.isConsumable === true,
        isPlotCritical: item.isPlotCritical === true,
        canAiModify: item.canAiModify === true,
        firstSeenChapter: readPositiveInteger(item.firstSeenChapter),
        lastSeenChapter: readPositiveInteger(item.lastSeenChapter),
        rules: readStringList(item.rules),
        notes: readStringList(item.notes),
      });
    }
  }
  for (const item of additions) add(item);
  return next;
}

function inferAssetType(name: string): string {
  if (/车|汽车|摩托/u.test(name)) return "vehicle";
  if (/房|住所|避难所|洞府/u.test(name)) return "property";
  if (/权限卡|门禁卡|房卡|钥匙|通行证/u.test(name)) return "keyItem";
  if (/钱|现金|资金|存款|余额|银行卡|信用卡|储蓄卡/u.test(name)) return "money";
  if (/申请表|证件|地图|文件/u.test(name)) return "document";
  if (/水|食物|药/u.test(name)) return "consumable";
  return /钥匙|收音机|电脑|手机/u.test(name) ? "keyItem" : "item";
}

function inferAssetStatus(name: string, resourceLimits: readonly string[]): string {
  const joined = resourceLimits.join("；");
  if (/欠费/u.test(joined) && /手机/u.test(name)) return "locked";
  if (/半张/u.test(name)) return "damaged";
  return "available";
}

function assetRulesFor(name: string, resourceLimits: readonly string[]): string[] {
  return [
    /欠费手机/u.test(name) || (/手机/u.test(name) && resourceLimits.some((limit) => /欠费/u.test(limit))) ? "欠费手机不能突然正常联网。" : undefined,
    /半张.*申请表/u.test(name) ? "半张申请表不能凭空变成完整申请表，也不能让窗口随手补给主角完整申请表。" : undefined,
  ].filter((item): item is string => Boolean(item));
}

// ---------------------------------------------------------------------------
// World bible faction helpers
// ---------------------------------------------------------------------------

export interface UiWorldBibleFaction {
  readonly id: string;
  readonly name: string;
  readonly goal: string;
  readonly resources?: readonly string[];
}

export function mergeWorldBibleFactions(current: unknown, socialOrder: readonly string[]): UiWorldBibleFaction[] {
  const next: UiWorldBibleFaction[] = [];
  const seen = new Set<string>();
  const add = (faction: UiWorldBibleFaction) => {
    const key = faction.id || faction.name;
    if (!key || seen.has(key)) return;
    seen.add(key);
    next.push(faction);
  };

  if (Array.isArray(current)) {
    for (const item of current) {
      if (typeof item === "string") {
        const name = item.trim();
        if (name) add(createConservativeFaction(name));
      } else if (isRecord(item)) {
        const name = readString(item.name);
        if (!name) continue;
        add({
          id: readString(item.id) ?? toSafeLocalId(name, "faction"),
          name,
          goal: readString(item.goal) ?? "维持自身利益和影响力",
          resources: readStringList(item.resources),
        });
      }
    }
  }

  for (const item of socialOrder) {
    add(createConservativeFaction(item));
  }

  return next;
}

function createConservativeFaction(name: string): UiWorldBibleFaction {
  return {
    id: toSafeLocalId(name, "faction"),
    name,
    goal: "维持当前秩序或资源分配",
    resources: [],
  };
}

// ---------------------------------------------------------------------------
// Writing rules parser
// ---------------------------------------------------------------------------

export function parseWritingRuleLines(lines: readonly string[]): Record<string, unknown> {
  const next: {
    narrativePerspective?: string;
    proseStyle: string[];
    pacing?: string;
    revealPolicy?: string;
    chapterLength?: { targetWords?: number };
    genreRequirements: string[];
    forbiddenContent: string[];
    doNotDo: string[];
    readerExperienceRules: string[];
  } = {
    proseStyle: [],
    genreRequirements: [],
    forbiddenContent: [],
    doNotDo: [],
    readerExperienceRules: [],
  };

  for (const line of lines.map((item) => item.trim()).filter(Boolean)) {
    if (line.startsWith("叙事视角：")) {
      next.narrativePerspective = line.slice("叙事视角：".length).trim();
    } else if (line.startsWith("文风：")) {
      next.proseStyle = splitChineseList(line.slice("文风：".length));
    } else if (line.startsWith("节奏：")) {
      next.pacing = line.slice("节奏：".length).trim();
    } else if (line.startsWith("信息揭示：")) {
      next.revealPolicy = line.slice("信息揭示：".length).trim();
    } else if (line.startsWith("目标字数：")) {
      const targetWords = Number.parseInt(line.replace(/[^\d]/gu, ""), 10);
      if (Number.isFinite(targetWords) && targetWords > 0) next.chapterLength = { targetWords };
    } else if (line.startsWith("类型要求：")) {
      next.genreRequirements.push(line.slice("类型要求：".length).trim());
    } else if (line.startsWith("禁忌内容：")) {
      next.forbiddenContent.push(line.slice("禁忌内容：".length).trim());
    } else if (line.startsWith("不要：")) {
      next.doNotDo.push(line.slice("不要：".length).trim());
    } else if (line.startsWith("读者体验：")) {
      next.readerExperienceRules.push(line.slice("读者体验：".length).trim());
    } else {
      next.readerExperienceRules.push(line);
    }
  }

  return next;
}
