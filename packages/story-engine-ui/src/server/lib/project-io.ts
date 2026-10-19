/**
 * Shared I/O, parsing, path safety, and utility functions used across route modules.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { chmod, readFile, rename, rm, stat, writeFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve, join, isAbsolute, sep, win32 as win32Path } from "node:path";
import { resolveBooksRootDir } from "./data-dirs.js";
import type { StateOverview } from "../book/state-overview.js";
import type { MessageCard } from "../../type-defs/workspace.js";
import { legacyMessageCards, readMessageCards } from "./message-cards-io.js";
import { isRecord, readNonNegativeInteger, readPositiveInteger, readString, readStringAllowEmpty, readStringList } from "./value-readers.js";

export { isRecord, readPositiveInteger, readString, readStringAllowEmpty, readStringList } from "./value-readers.js";

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


// ---------------------------------------------------------------------------
// String / number parsers
// ---------------------------------------------------------------------------


export function requireBodyString(value: unknown, message: string): string {
  const parsed = readString(value);
  if (!parsed) throw new Error(message);
  return parsed;
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

// ---------------------------------------------------------------------------
// Workspace message parsers
// ---------------------------------------------------------------------------

export type WorkspaceTurnSnapshot = {
  readonly toolName: string;
  readonly snapshotId: string;
  readonly chapterNumber?: number;
};

export function readWorkspaceMessages(value: unknown): {
  readonly id: string;
  readonly role: "user" | "assistant" | "system";
  readonly content: string;
  readonly suggestedActions?: readonly Record<string, unknown>[];
  readonly agentCards?: readonly Record<string, unknown>[];
  readonly toolOutput?: readonly string[];
  readonly thinking?: string;
  readonly toolSteps?: readonly Record<string, unknown>[];
  readonly segments?: readonly WorkspaceMessageSegment[];
  readonly createdAt?: string;
  readonly kind?: "scaffolding";
  readonly intentTitle?: string;
  readonly turnStartedAt?: number;
  readonly turnEndedAt?: number;
  readonly turnSnapshots?: readonly WorkspaceTurnSnapshot[];
  readonly affectedScopes?: readonly ("full" | "foundation")[];
  readonly tokenUsage?: { readonly input: number; readonly cachedInput: number; readonly output: number };
  readonly cards?: readonly MessageCard[];
  readonly chapter?: number;
}[] {
  if (!Array.isArray(value)) return [];
  const messages: {
    id: string;
    role: "user" | "assistant" | "system";
    content: string;
    suggestedActions?: readonly Record<string, unknown>[];
    agentCards?: readonly Record<string, unknown>[];
    toolOutput?: readonly string[];
    thinking?: string;
    toolSteps?: readonly Record<string, unknown>[];
    segments?: readonly WorkspaceMessageSegment[];
    createdAt?: string;
    kind?: "scaffolding";
    intentTitle?: string;
    turnStartedAt?: number;
    turnEndedAt?: number;
    turnSnapshots?: readonly WorkspaceTurnSnapshot[];
    affectedScopes?: readonly ("full" | "foundation")[];
    tokenUsage?: { readonly input: number; readonly cachedInput: number; readonly output: number };
    cards?: readonly MessageCard[];
    chapter?: number;
  }[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const id = readString(item.id);
    const content = readString(item.content);
    // 纯工具回合的 assistant 消息 content 可以为空（只调了工具没说话），但它挂着工具步骤/分段/
    // 撤销快照——按「content 为空」丢掉等于把那一轮的执行记录和快照静默蒸发（复审 P3）。
    const carriesToolPayload = Array.isArray(item.toolSteps) && item.toolSteps.length > 0
      || Array.isArray(item.segments) && item.segments.length > 0
      || Array.isArray(item.turnSnapshots) && item.turnSnapshots.length > 0
      || Array.isArray(item.cards) && item.cards.length > 0;
    if (!id || (!content && !carriesToolPayload)) continue;
    // Self-heal: scrub legacy mockData seed messages (msg-001/msg-002) that may
    // have been固化 onto real project disks before F1. Real runtime ids never use
    // the `msg-0` prefix (they are `${role}-${Date.now()}…`), so this is mock-only.
    if (id.startsWith("msg-0")) continue;
    if (item.role !== "assistant" && item.role !== "user" && item.role !== "system") continue;
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
    // 本轮用量（2026-10-10）：存盘时漏收，对话重载后用量行凭空消失。
    const tokenUsage = readWorkspaceTokenUsage(item.tokenUsage);
    // 卡：新格式按 type 校验；老会话没有 cards，把分散的老字段转成卡（只读迁移，写回就是新格式）。
    const cards = Array.isArray(item.cards) ? readMessageCards(item.cards) : legacyMessageCards(item);
    messages.push({
      id,
      role: item.role,
      content: content ?? "",
      ...(suggestedActions.length > 0 ? { suggestedActions } : {}),
      ...(agentCards && agentCards.length > 0 ? { agentCards } : {}),
      ...(toolOutput.length > 0 ? { toolOutput } : {}),
      ...(thinking ? { thinking } : {}),
      ...(toolSteps && toolSteps.length > 0 ? { toolSteps } : {}),
      ...(segments.length > 0 ? { segments } : {}),
      ...(readString(item.createdAt) ? { createdAt: readString(item.createdAt) } : {}),
      ...(intentTitle ? { intentTitle } : {}),
      ...(item.kind === "scaffolding" ? { kind: "scaffolding" as const } : {}),
      ...(turnStartedAt !== undefined ? { turnStartedAt } : {}),
      ...(turnEndedAt !== undefined ? { turnEndedAt } : {}),
      ...(turnSnapshots.length > 0 ? { turnSnapshots } : {}),
      ...(affectedScopes.length > 0 ? { affectedScopes } : {}),
      ...(tokenUsage ? { tokenUsage } : {}),
      ...(cards.length > 0 ? { cards } : {}),
      // 作者发这句时在看哪一章（右栏「这一章的对话」按它分）：只收正整数。
      ...(typeof item.chapter === "number" && Number.isInteger(item.chapter) && item.chapter > 0 ? { chapter: item.chapter } : {}),
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

/** 回合起止毫秒时间戳：有限正数才保留（坏值不写，刷新后耗时显示宁缺毋假）。 */
function readFinitePositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function readWorkspaceTokenUsage(value: unknown): { readonly input: number; readonly cachedInput: number; readonly output: number } | undefined {
  if (!isRecord(value)) return undefined;
  const input = readNonNegativeInteger(value.input);
  const cachedInput = readNonNegativeInteger(value.cachedInput);
  const output = readNonNegativeInteger(value.output);
  if (input === undefined || output === undefined) return undefined;
  return { input, cachedInput: cachedInput ?? 0, output };
}


/** 「确认定稿」按钮目标（commit-apply 的 commitTarget）：章号 + 可选预览令牌。 */
function readWorkspaceCommitTarget(value: unknown): { chapter?: number; previewToken?: string } | undefined {
  if (!isRecord(value)) return undefined;
  const chapter = readPositiveInteger(value.chapter);
  const previewToken = readString(value.previewToken);
  if (chapter === undefined && !previewToken) return undefined;
  return { ...(chapter !== undefined ? { chapter } : {}), ...(previewToken ? { previewToken } : {}) };
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
    const commitTarget = readWorkspaceCommitTarget(item.commitTarget);
    // 「确认裁剪」按钮的保留条数：不进白名单的话刷新后丢失，按钮会按默认 200 条裁（与预览不一致）。
    const pruneKeep = isRecord(item.pruneTarget) ? readPositiveInteger(item.pruneTarget.keep) : undefined;
    // 「确认改账」按钮带的裁定草案：不进白名单的话刷新后按钮就空了（点了只能如实说过期）。内容由服务端执行前再校验。
    const ledgerTarget = readWorkspaceLedgerTarget(item.ledgerTarget);
    // 「重写这一章」「确认改设定」按钮的参数（重构 P4）：同理要进白名单，内容由服务端执行前再校验。
    const rewriteTarget = readWorkspaceRewriteTarget(item.rewriteTarget);
    const foundationTarget = readWorkspaceFoundationTarget(item.foundationTarget);
    actions.push({
      id,
      label,
      description,
      permission,
      requiresConfirmation: item.requiresConfirmation === true,
      ...(readString(item.endpoint) ? { endpoint: readString(item.endpoint) } : {}),
      // 「现在还不能点」的原因：不进白名单的话重开书后禁用的按钮（如没预览就「确认定稿」）会变成可点。
      ...(readString(item.disabledReason) ? { disabledReason: readString(item.disabledReason) } : {}),
      ...(commitTarget ? { commitTarget } : {}),
      ...(isRecord(item.pruneTarget) ? { pruneTarget: { ...(pruneKeep !== undefined ? { keep: pruneKeep } : {}) } } : {}),
      ...(ledgerTarget ? { ledgerTarget } : {}),
      ...(rewriteTarget ? { rewriteTarget } : {}),
      ...(foundationTarget ? { foundationTarget } : {}),
    });
  }
  return actions.slice(0, 8);
}

function readWorkspaceRewriteTarget(value: unknown): { chapter: number; chapterGoal?: string } | undefined {
  if (!isRecord(value)) return undefined;
  const chapter = readPositiveInteger(value.chapter);
  if (chapter === undefined) return undefined;
  const chapterGoal = readString(value.chapterGoal);
  return { chapter, ...(chapterGoal ? { chapterGoal: chapterGoal.slice(0, 2000) } : {}) };
}

function readWorkspaceFoundationTarget(value: unknown): { key: string; input: Record<string, unknown>; label?: string } | undefined {
  if (!isRecord(value) || !isRecord(value.input)) return undefined;
  const key = readString(value.key);
  if (!key) return undefined;
  const label = readString(value.label);
  return { key, input: value.input, ...(label ? { label } : {}) };
}

function readWorkspaceLedgerTarget(value: unknown): { key: string; decisions: unknown[]; label?: string } | undefined {
  if (!isRecord(value)) return undefined;
  const key = readString(value.key);
  if (!key || !Array.isArray(value.decisions) || value.decisions.length === 0) return undefined;
  const label = readString(value.label);
  return { key, decisions: value.decisions.filter(isRecord).slice(0, 20), ...(label ? { label } : {}) };
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

// ---------------------------------------------------------------------------
// Draft quality parsers
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

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

// 32MB：长篇书的聊天会话保存（对话全量）在 40 章上下就会超过 1MB——
// 真机耐力跑实测撞墙（保存失败→聊天卡死）。本地单用户服务，放宽到 32MB 足够 200+ 章；
// 会话历史的无界增长另行治理（裁剪/归档），这里先保证长书不断粮。
export const MAX_JSON_BODY_BYTES = 32 * 1024 * 1024;
export const MAX_USAGE_SUMMARY_FILES = 200;
export const MAX_USAGE_SUMMARY_FILE_BYTES = 256 * 1024;

export async function readJsonFile(path: string): Promise<Record<string, unknown>> {
  const parsed = JSON.parse(await readFile(path, "utf-8")) as unknown;
  return isRecord(parsed) ? parsed : {};
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


  return { title: project.title.trim() };
}

// ---------------------------------------------------------------------------
// String utilities
// ---------------------------------------------------------------------------



export function splitChineseList(value: string): string[] {
  return value
    // 不猜白名单：切句
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

/** 编辑器只要正文：首行是「# 章名」就去掉（保留原文末换行），否则原样不动。 */
export function stripTitleLineForEditor(content: string): string {
  const firstLine = content.split(/\r?\n/u).find((line) => line.trim().length > 0)?.trim() ?? "";
  if (!isMarkdownChapterHeading(firstLine)) return content;
  const body = stripLeadingMarkdownChapterHeading(content);
  return /\n$/u.test(content) ? `${body}\n` : body;
}

function isMarkdownChapterHeading(line: string): boolean {
  if (!/^#{1,6}\s+\S/u.test(line)) return false;
  const title = line.replace(/^#{1,6}\s+/u, "").trim();
  if (!title) return false;
  // 不猜白名单开始：章节标题
  if (/^第[一二三四五六七八九十百千万\d]+章(?:\s*[·：:、-]\s*.*)?$/u.test(title)) return true;
  return title.length <= 40 && !/[。！？!?；;]/u.test(title);
  // 不猜白名单结束
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

/** 旧版写作台缓存路径（重构 P5 起不再读写；只剩测试用来布置老书残留）。 */
export function chapterWorkspacePath(projectDir: string, chapter: number): string {
  return join(projectDir, ".story-engine-ui", "chapter-workspaces", `chapter-${padChapter(chapter)}.json`);
}

export function extractDraftTitle(content: string | undefined): string | null {
  if (!content) return null;
  const firstLine = content.split(/\r?\n/u).find((line) => line.trim().length > 0)?.trim();
  if (!firstLine?.startsWith("#")) return null;
  // 不猜白名单：章节标题
  const title = firstLine.replace(/^#+\s*/u, "").replace(/^第[一二三四五六七八九十百\d]+章\s*[·：:、-]?\s*/u, "").trim();
  return title || null;
}

export interface UiChapterFileState {
  readonly chapter: number;
  readonly hasDraftFile: boolean;
  readonly hasCommittedChapter: boolean;
  readonly draftTitle?: string;
  readonly committedTitle?: string;
}

/** 扫全书章节文件，给出每章「有无草稿 / 是否入库 / 标题」状态。只读盘、题材中立，供 agent 章节状态可见性用。 */
export async function readUiChapterFileStates(projectDir: string): Promise<readonly UiChapterFileState[]> {
  const chapters = new Set<number>();
  const committedFiles = await readdir(join(projectDir, "chapters")).catch(() => []);
  const draftFiles = await readdir(join(projectDir, "drafts", "fast")).catch(() => []);

  for (const file of committedFiles) {
    const chapter = chapterNumberFromCommittedFile(file);
    if (chapter !== undefined) chapters.add(chapter);
  }
  for (const file of draftFiles) {
    const chapter = chapterNumberFromDraftFile(file);
    if (chapter !== undefined) chapters.add(chapter);
  }

  const states = await Promise.all([...chapters].sort((a, b) => a - b).map(async (chapter) => {
    const [committedContent, draftContent] = await Promise.all([
      readFile(defaultCommittedChapterPath(projectDir, chapter), "utf-8").catch(() => undefined),
      readFile(defaultDraftPath(projectDir, chapter), "utf-8").catch(() => undefined),
    ]);
    return {
      chapter,
      hasDraftFile: hasRealDraftContent(draftContent),
      hasCommittedChapter: committedContent !== undefined,
      ...(extractDraftTitle(draftContent) ? { draftTitle: extractDraftTitle(draftContent)! } : {}),
      ...(extractDraftTitle(committedContent) ? { committedTitle: extractDraftTitle(committedContent)! } : {}),
    };
  }));
  return states;
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

function normalizedContent(content: string | undefined): string {
  return (content ?? "").trim().replace(/\r\n?/gu, "\n");
}

/**
 * 识别「显示用空工作稿占位符」——buildStateBackedDraftPlaceholder（stateOverviewAdapter.ts）在
 * 「本章还没有真正文」时给写作台显示的引导语（以「还没有工作稿正文」/「还没有载入本章工作稿正文」开头；
 * 旧版文案「还没有草稿正文」/「还没有载入本章草稿正文」可能已落进老书的盘上文件，一并识别）。
 * 这种占位符不是用户/AI 写的真稿，一旦它被落进 drafts/fast 的 .md 或 workspace 的 draftContent，
 * 绝不能被当成「有工作稿」——否则章节状态会谎报「有工作稿未定稿」、agent 跟着说「第N章已有工作稿」，
 * 用户打开却是空的（真机实测 bug）。真稿绝不会以这些标记开头，故按开头判定足够安全、题材中立。
 */
function isStateBackedDraftPlaceholder(content: string | undefined): boolean {
  const body = stripLeadingMarkdownChapterHeading(normalizedContent(content)).trim();
  if (!body) return false;
  return body.startsWith("还没有工作稿正文") || body.startsWith("还没有载入本章工作稿正文")
    || body.startsWith("还没有草稿正文") || body.startsWith("还没有载入本章草稿正文");
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
