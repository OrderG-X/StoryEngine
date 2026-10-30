/**
 * Shared I/O, parsing, path safety, and utility functions used across route modules.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { chmod, readFile, rename, rm, stat, writeFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve, join, isAbsolute, sep, win32 as win32Path } from "node:path";
import { bareChapterName, parseDraftFile, sameDraftBody } from "@actalk/story-core";
import { resolveBooksRootDir } from "./data-dirs.js";
import { noteUsageBook } from "./usage-scope.js";
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
// 原子写盘（审查 #5：防半写文件；几份一起换走 config-commit）
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

/** 发给 AI 的一条聊天历史：AI 那条回合调过的工具结构化带上（服务端还原成真的工具调用记录，不往文字里塞注）。 */
export interface ChatHistoryMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly tools?: readonly { readonly name: string; readonly ok: boolean }[];
}

export function readChatMessages(value: unknown): readonly ChatHistoryMessage[] {
  if (!Array.isArray(value)) return [];
  const messages: ChatHistoryMessage[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const content = readString(item.content);
    if (!content) continue;
    if (item.role === "user") messages.push({ role: "user", content });
    if (item.role === "assistant") {
      const tools = Array.isArray(item.tools)
        ? item.tools.filter(isRecord).flatMap((tool) => {
          const name = readString(tool.name);
          return name ? [{ name, ok: tool.ok !== false }] : [];
        })
        : [];
      messages.push(tools.length > 0 ? { role: "assistant", content, tools } : { role: "assistant", content });
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
  readonly kind?: "scaffolding" | "restore";
  readonly intentTitle?: string;
  readonly turnStartedAt?: number;
  readonly turnEndedAt?: number;
  readonly turnSnapshots?: readonly WorkspaceTurnSnapshot[];
  readonly affectedScopes?: readonly ("full" | "foundation")[];
  readonly tokenUsage?: { readonly input: number; readonly cachedInput: number; readonly output: number };
  readonly cards?: readonly MessageCard[];
  readonly chapter?: number;
  readonly issuedAt?: string;
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
    kind?: "scaffolding" | "restore";
    intentTitle?: string;
    turnStartedAt?: number;
    turnEndedAt?: number;
    turnSnapshots?: readonly WorkspaceTurnSnapshot[];
    affectedScopes?: readonly ("full" | "foundation")[];
    tokenUsage?: { readonly input: number; readonly cachedInput: number; readonly output: number };
    cards?: readonly MessageCard[];
    chapter?: number;
    issuedAt?: string;
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
      ...(item.kind === "scaffolding" || item.kind === "restore" ? { kind: item.kind } : {}),
      ...(turnStartedAt !== undefined ? { turnStartedAt } : {}),
      ...(turnEndedAt !== undefined ? { turnEndedAt } : {}),
      ...(turnSnapshots.length > 0 ? { turnSnapshots } : {}),
      ...(affectedScopes.length > 0 ? { affectedScopes } : {}),
      ...(tokenUsage ? { tokenUsage } : {}),
      ...(cards.length > 0 ? { cards } : {}),
      // 作者发这句时在看哪一章（右栏「这一章的对话」按它分）：只收正整数。
      ...(typeof item.chapter === "number" && Number.isInteger(item.chapter) && item.chapter > 0 ? { chapter: item.chapter } : {}),
      // 作者这句的发出时间（写作版本 P2a：和消息号一起认这句交的操作，重发沿用）：只记在作者的话上。
      ...(item.role === "user" && readIssuedAt(item.issuedAt) ? { issuedAt: readIssuedAt(item.issuedAt) } : {}),
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


/** 不再有的按钮（片 4A：定稿是一次操作，「确认定稿」在定稿清单上，不再是建议条按钮）：老会话读回来不摆死按钮。 */
const RETIRED_ACTION_IDS: ReadonlySet<string> = new Set(["commit-preview", "commit-apply", "commit-short"]);

function readWorkspaceSuggestedActions(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  const actions: Record<string, unknown>[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const id = readString(item.id);
    const label = readString(item.label);
    const description = readString(item.description);
    const permission = readWorkspacePermission(item.permission);
    if (!id || !label || !description || !permission || RETIRED_ACTION_IDS.has(id)) continue;
    // 「确认裁剪」按钮的保留条数：不进白名单的话刷新后丢失，按钮会按默认 200 条裁（与预览不一致）。
    const pruneKeep = isRecord(item.pruneTarget) ? readPositiveInteger(item.pruneTarget.keep) : undefined;
    // 「重写这一章」「接着往下写」按钮的写稿动作（写作版本 P2a）：同理要进白名单，内容由前端点的时候、服务端执行前再校验。
    const operationAction = readWorkspaceOperationAction(item.operationAction);
    // 「重试这一步」重发的那句话的消息号和发出时间（写作版本 P2a）：不进白名单的话重开书后重试就成了一句新话。
    const retryOf = readMessageRef(item.retryOf);
    actions.push({
      id,
      label,
      description,
      permission,
      requiresConfirmation: item.requiresConfirmation === true,
      ...(readString(item.endpoint) ? { endpoint: readString(item.endpoint) } : {}),
      // 「现在还不能点」的原因：不进白名单的话重开书后禁用的按钮会变成可点。
      ...(readString(item.disabledReason) ? { disabledReason: readString(item.disabledReason) } : {}),
      ...(isRecord(item.pruneTarget) ? { pruneTarget: { ...(pruneKeep !== undefined ? { keep: pruneKeep } : {}) } } : {}),
      ...(operationAction ? { operationAction } : {}),
      ...(retryOf ? { retryOf } : {}),
    });
  }
  return actions.slice(0, 8);
}

/** 作者一句话的消息号和发出时间（和服务端 parseMessageRef 同一口径）。 */
function readMessageRef(value: unknown): { messageId: string; issuedAt: string } | undefined {
  if (!isRecord(value)) return undefined;
  const messageId = readString(value.messageId);
  const issuedAt = readIssuedAt(value.issuedAt);
  return messageId && /^[A-Za-z0-9_-]{1,64}$/u.test(messageId) && issuedAt ? { messageId, issuedAt } : undefined;
}

/** 发出时间：读得出的时间（不长于 40 字）才收。 */
function readIssuedAt(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value)) ? value : undefined;
}

/** 按钮上的写稿动作：只认新交的写稿（种类、请求号、发出时间、参数是对象），原样留着；不长于 8000 字。 */
function readWorkspaceOperationAction(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value) || value.kind !== "new" || value.type !== "draft.change" || !isRecord(value.params)) return undefined;
  const requestKey = readString(value.requestKey);
  if (!readString(value.mode) || !requestKey || requestKey.length > 64 || !readIssuedAt(value.issuedAt)) return undefined;
  return JSON.stringify(value).length <= 8000 ? value : undefined;
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
  // 这次请求里调模型的用量记到这本书名下（P10，见 usage-scope）。
  noteUsageBook(projectPath);
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

/** 稿件 / 定稿文件的章名（核心 parseDraftFile 认章名行），去掉开头的「第 N 章 ·」只留名字；没有是 null。 */
export function extractDraftTitle(content: string | undefined): string | null {
  if (!content) return null;
  const heading = parseDraftFile(content).title;
  return heading ? bareChapterTitle(heading) : null;
}

/** 章名去掉开头的「第 N 章 ·」只留名字（已经拆出来的章名用这个，不拼成文件再拆）；剩下是空的是 null。 */
export function bareChapterTitle(title: string): string | null {
  return bareChapterName(title) || null;
}

export interface UiChapterFileState {
  readonly chapter: number;
  readonly hasDraftFile: boolean;
  readonly hasCommittedChapter: boolean;
  /** 定稿后工作稿又改过（两份都在、正文不一样）：章节栏要把它算进「还没定稿」（P11）。只在是的时候带。 */
  readonly editedSinceCommit?: true;
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
    const edited = committedContent !== undefined && draftContent !== undefined && hasRealDraftContent(draftContent)
      && !sameDraftBody(parseDraftFile(draftContent).body, parseDraftFile(committedContent).body);
    return {
      chapter,
      hasDraftFile: hasRealDraftContent(draftContent),
      hasCommittedChapter: committedContent !== undefined,
      ...(edited ? { editedSinceCommit: true as const } : {}),
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
  const body = parseDraftFile(normalizedContent(content)).body;
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

