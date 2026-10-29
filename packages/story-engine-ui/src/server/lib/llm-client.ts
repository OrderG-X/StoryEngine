/**
 * Shared LLM client logic: OpenAI-compatible HTTP calls and streaming.
 */
import { providerGate } from "./provider-gate.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { loadModelSettingsV0 } from "./model-settings.js";
import type { ModelSettingsLoadResult } from "../book/types.js";
import { writeFileAtomic } from "./project-io.js";
import { recordPipelineUsage, recordTurnNotice, sampleFromOpenAIUsage } from "./token-meter.js";
import { recordUsage } from "./usage-ledger.js";
import { resolveGlobalDataDir } from "./data-dirs.js";
import { engineProfileFallback, readTaskAssignments, resolveTaskProfileId, resolveTaskThinking } from "./task-assignments.js";
import { resolveThinkingDialect, thinkingRequestParams, type ThinkingDialect } from "./model-capabilities.js";
import { ModelCallError, ModelSetupError, StepHaltedError, UpstreamSilentError, type UnusableReason } from "./ai-errors.js";
import type { AttemptOutcome, AttemptTarget, SendTicket } from "./operations/attempts.js";
import { classifyThrown } from "./operations/classify.js";
import { currentOperation, haltStep, OperationStopped, StopSignal, stopOf } from "./operations/context.js";
import { TASK_LABELS } from "../../components/ModelSettingsDialogTypes.js";

// 旁路文件损坏只警告一次（resolveConfiguredChatModel 每次请求都读，避免刷屏）；恢复正常后重置，再坏再警告。
let taskAssignmentsCorruptWarned = false;
function warnIfTaskAssignmentsCorrupt(corrupt: boolean): void {
  if (corrupt && !taskAssignmentsCorruptWarned) {
    taskAssignmentsCorruptWarned = true;
    console.warn(
      "[task-assignments] ~/.story-engine/task-assignments.json 解析失败，已忽略并回退默认" +
        "（各任务模型走引擎配置、思考全开）；请检查该文件，修好后重启或重新保存设置即恢复。",
    );
  } else if (!corrupt && taskAssignmentsCorruptWarned) {
    taskAssignmentsCorruptWarned = false;
  }
}

// ---------------------------------------------------------------------------
// Global model settings paths（桌面前置：SE_DATA_DIR 可覆盖，默认 ~/.story-engine 不变）
// ---------------------------------------------------------------------------
// 函数而非模块级常量：env 每次调用现读，Electron 主进程注入 SE_DATA_DIR 后无需关心 import 顺序，
// 测试也能逐用例注入/还原。

export function globalStoryEngineDir(): string {
  return resolveGlobalDataDir();
}
export function globalModelSettingsPath(): string {
  return join(globalStoryEngineDir(), "model-settings.json");
}
export function globalModelSecretsPath(): string {
  return join(globalStoryEngineDir(), "model-secrets.json");
}

/**
 * 读全局模型设置（审查 #7·单一真值源）。以 globalModelSettingsPath() 为准 → 与保存写盘同一路径、
 * 一致地遵循 SE_DATA_DIR。绝不再裸调 loadModelSettingsV0(homedir())——那会恒读 ~/.story-engine，
 * 与设置页写入的 SE_DATA_DIR 目录分裂，表现为「保存成功却仍用旧模型」。
 */
export async function loadGlobalModelSettings(): Promise<ModelSettingsLoadResult> {
  return loadModelSettingsV0(homedir(), { configPath: globalModelSettingsPath() });
}

// ---------------------------------------------------------------------------
// Local model secrets
// ---------------------------------------------------------------------------

export interface ModelSecretsFile {
  readonly version: 1;
  readonly providerApiKeys: Readonly<Record<string, string>>;
}

function emptyModelSecrets(): ModelSecretsFile {
  return { version: 1, providerApiKeys: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrnoNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

/**
 * 读本机密钥库（审查 #8·「坏 JSON 不当空」）。三态：
 *  - 文件不存在（ENOENT）→ 空库（首次运行的正常态）。
 *  - 读失败（权限/IO）或坏 JSON → **抛错**，绝不当成空库返回。
 *    否则上层 saveModelSecrets 会以「空 existing」合并，把用户原有密钥永久覆盖掉。
 */
export async function readModelSecrets(): Promise<ModelSecretsFile> {
  let text: string;
  try {
    text = await readFile(globalModelSecretsPath(), "utf-8");
  } catch (error) {
    if (isErrnoNotFound(error)) return emptyModelSecrets();
    throw new Error(
      `读取本机密钥库失败（${globalModelSecretsPath()}）：${error instanceof Error ? error.message : String(error)}。` +
        `为避免覆盖已有密钥，本次操作已中止；请检查文件权限后重试。`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(
      `本机密钥库不是有效 JSON（${globalModelSecretsPath()}）：${error instanceof Error ? error.message : String(error)}。` +
        `为避免覆盖已有密钥，本次操作已中止；请修复或删除该文件后重试。`,
    );
  }
  if (!isRecord(parsed) || !isRecord(parsed.providerApiKeys)) {
    return emptyModelSecrets();
  }
  const providerApiKeys: Record<string, string> = {};
  for (const [providerId, apiKey] of Object.entries(parsed.providerApiKeys)) {
    if (typeof apiKey === "string" && apiKey.length > 0) {
      providerApiKeys[providerId] = apiKey;
    }
  }
  return { version: 1, providerApiKeys };
}

/** 合并已有密钥与新传入密钥（纯函数，便于单测穷举）。activeProviderIds 存在时只保留活跃 provider 的键。 */
export function mergeProviderApiKeys(
  existing: Readonly<Record<string, string>>,
  input: { readonly providerApiKeys?: Readonly<Record<string, string>>; readonly activeProviderIds?: readonly string[] },
): Record<string, string> {
  const activeProviderIds = input.activeProviderIds ? new Set(input.activeProviderIds) : null;
  const next: Record<string, string> = {};
  for (const [providerId, apiKey] of Object.entries(existing)) {
    if (!activeProviderIds || activeProviderIds.has(providerId)) {
      next[providerId] = apiKey;
    }
  }
  for (const [providerId, apiKey] of Object.entries(input.providerApiKeys ?? {})) {
    const trimmedProviderId = providerId.trim();
    if (!trimmedProviderId) continue;
    if (activeProviderIds && !activeProviderIds.has(trimmedProviderId)) continue;
    if (apiKey.trim()) {
      next[trimmedProviderId] = apiKey.trim();
    }
  }
  return next;
}

/** 序列化密钥库文件内容（供原子写 / 三文件事务复用）。 */
export function serializeModelSecrets(providerApiKeys: Readonly<Record<string, string>>): string {
  return `${JSON.stringify({ version: 1, providerApiKeys }, null, 2)}\n`;
}

export async function saveModelSecrets(input: {
  readonly providerApiKeys?: Readonly<Record<string, string>>;
  readonly activeProviderIds?: readonly string[];
}): Promise<void> {
  const existing = await readModelSecrets();
  const nextProviderApiKeys = mergeProviderApiKeys(existing.providerApiKeys, input);
  await mkdir(globalStoryEngineDir(), { recursive: true });
  await writeFileAtomic(globalModelSecretsPath(), serializeModelSecrets(nextProviderApiKeys), { mode: 0o600 });
}

export async function getSavedProviderApiKey(providerId: string): Promise<string> {
  const secrets = await readModelSecrets();
  return secrets.providerApiKeys[providerId] ?? "";
}

export async function resolveProviderApiKey(provider: {
  readonly id: string;
  readonly apiKeyEnv?: string;
}): Promise<string> {
  const savedApiKey = await getSavedProviderApiKey(provider.id);
  return savedApiKey || (provider.apiKeyEnv ? (process.env[provider.apiKeyEnv] ?? "") : "");
}

export async function hasProviderApiKey(provider: {
  readonly id: string;
  readonly apiKeyEnv?: string;
}): Promise<boolean> {
  return Boolean(await resolveProviderApiKey(provider));
}

// ---------------------------------------------------------------------------
// Model config resolution
// ---------------------------------------------------------------------------

export type ModelTaskProfileKey = "fastDraft" | "chapterSteering" | "qualityCheck" | "repair" | "draftReview" | "triage";

export type ResolvedChatModel = {
  readonly provider: ModelSettingsLoadResult["summary"]["providers"][number];
  readonly profile: ModelSettingsLoadResult["summary"]["profiles"][number];
  readonly apiKey: string;
  /** 该任务是否开思考链（用户意图，由 UI 旁路 task-assignments 决定，默认开）。 */
  readonly thinking: boolean;
  /** 该模型的思考开关方言（请求侧模型无关·R7）：glm/qwen/none。按 model id 判，发对方言、none 整键不发。 */
  readonly thinkingDialect: ThinkingDialect;
  /**
   * 该 provider 的自定义请求头（含真实值，仅进程内使用，绝不进 API 输出/日志）。
   * 从 model-settings.json 直读——summary 里只有脱敏键名（customHeaderNames）。
   */
  readonly customHeaders?: Record<string, string>;
  /**
   * 备用模型（P10）：主模型这次没连上、还没出一个正文字时，换它再试一次（见 streamChatModelToText）。
   * 设置里没选、和主模型是同一个、或解析不出来（档案没了、缺密钥）时不带。
   */
  readonly fallback?: ResolvedChatModel;
  /** 为哪个功能解析的（记用量分列用，P10）；体检等不属于功能的调用没有。 */
  readonly task?: ModelTaskProfileKey;
};

/** 档案 → 可调用的模型（服务商、密钥、自定义头）。缺服务商 / 缺密钥抛人话错误。 */
async function resolveProfileModel(
  settings: ModelSettingsLoadResult,
  profile: ModelSettingsLoadResult["summary"]["profiles"][number],
  thinking: boolean,
): Promise<ResolvedChatModel> {
  const provider = settings.summary.providers.find((item) => item.id === profile.provider);
  if (!provider) {
    throw new ModelSetupError(`模型「${profile.label || profile.model || profile.id}」用的服务商不见了（可能删掉了），去 设置 → 模型 重新选一个。`);
  }
  const apiKey = await resolveProviderApiKey(provider);
  if (provider.apiKeyStatus === "missing" && !apiKey) {
    throw new ModelSetupError(`「${provider.label || provider.id}」还没填密钥，去 设置 → 模型 填上就能用。`);
  }
  return {
    provider,
    profile,
    apiKey,
    thinking,
    thinkingDialect: resolveThinkingDialect(profile.model),
    customHeaders: await readProviderCustomHeaders(provider.id),
  };
}

const warnedFallbackErrors = new Set<string>();

/**
 * 备用模型（P10）：设置里选了就解析出来；没选回 undefined。解析不出来抛人话错误（体检用它露原因）。
 * 思考开关跟着主任务走（调用时由 streamChatModelToText 覆盖），这里先给默认开。
 */
export async function resolveFallbackChatModel(): Promise<ResolvedChatModel | undefined> {
  const settings = await loadGlobalModelSettings();
  if (!settings.available) return undefined;
  const { file } = await readTaskAssignments(homedir());
  return resolveFallbackFrom(settings, file?.fallbackProfileId);
}

async function resolveFallbackFrom(settings: ModelSettingsLoadResult, profileId: string | undefined): Promise<ResolvedChatModel | undefined> {
  if (!profileId) return undefined;
  const profile = settings.summary.profiles.find((item) => item.id === profileId);
  if (!profile) throw new ModelSetupError(`备用模型的档案「${profileId}」不存在（可能已删除或改名），请在设置里重新选备用模型。`);
  return resolveProfileModel(settings, profile, true);
}

export async function resolveConfiguredChatModel(task: ModelTaskProfileKey): Promise<ResolvedChatModel> {
  const settings = await loadGlobalModelSettings();
  if (!settings.available) {
    throw new ModelSetupError("还没接上 AI：去 设置 → 模型 接一家服务商、填上密钥就能用。");
  }
  // 任务→{档案,思考} 存 UI 旁路 task-assignments.json（引擎零改）。profileId 解析顺序：
  // 旁路 → engineProfileFallback（与面板展示同口径）→ defaultProfile → 第一个。thinking 默认开。
  const { file: assignments, corrupt } = await readTaskAssignments(homedir());
  warnIfTaskAssignmentsCorrupt(corrupt);
  const tp = settings.summary.taskProfiles as Record<string, string>;
  // 审查 #9：区分「显式指定的 profileId」与「回退链解析出的 id」。显式指定却查不到 → 明确报错，
  // 绝不静默切到 profiles[0]（那会让界面显示模型 A、实际用模型 B，影响成本/隐私/能力判断）。
  const explicitProfileId = resolveTaskProfileId(assignments, task);
  const profileId = explicitProfileId
    ?? engineProfileFallback(tp, task)
    ?? settings.summary.defaultProfile
    ?? settings.summary.profiles[0]?.id;
  const profile = settings.summary.profiles.find((item) => item.id === profileId);
  if (!profile) {
    if (explicitProfileId && profileId === explicitProfileId) {
      throw new ModelSetupError(
        `「${TASK_LABELS[task] ?? task}」指定的模型档案「${explicitProfileId}」不存在（可能已删除或改名）。` +
          `请在设置中重新为它选择模型。`,
      );
    }
    throw new ModelSetupError(
      `「${TASK_LABELS[task] ?? task}」没找到能用的模型（解析结果：「${profileId ?? "空"}」）。请在设置中检查它用哪个模型。`,
    );
  }
  const primary = await resolveProfileModel(settings, profile, resolveTaskThinking(assignments, task));
  // 备用模型解析不出来不挡主模型：只 warn 一次（同一原因不刷屏），体检会把原因露给作者。
  let fallback: ResolvedChatModel | undefined;
  try {
    fallback = await resolveFallbackFrom(settings, assignments?.fallbackProfileId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!warnedFallbackErrors.has(message)) {
      warnedFallbackErrors.add(message);
      console.warn(`[model] 备用模型用不了：${message}`);
    }
  }
  const sameModel = fallback && fallback.provider.id === primary.provider.id && fallback.profile.model === primary.profile.model;
  return fallback && !sameModel ? { ...primary, task, fallback: { ...fallback, task } } : { ...primary, task };
}

// ---------------------------------------------------------------------------
// 出站请求头统一收口：OpenCode Go 会话头 + per-provider 自定义头
// ---------------------------------------------------------------------------

/**
 * OpenCode Go 官方要求（https://opencode.ai/docs/go/）：
 *  1. 每个会话发**稳定**的 `x-opencode-session`（路由优化 / prompt 缓存用）——持久化复用，绝不每次请求换新；
 *  2. 用客户端自有 User-Agent 标识（如 `my-coding-agent/1.0`），不用通用 SDK/HTTP 库名。
 * 不带这两个头的请求会被拒（MissingSessionID）。
 */
export const STORY_ENGINE_USER_AGENT = "story-engine-ng/1.0";

export function globalOpencodeSessionPath(): string {
  return join(globalStoryEngineDir(), "opencode-session.json");
}

/** 仅当 provider baseUrl 的 hostname 命中 opencode（大小写不敏感）才发会话头——绝不向任意 provider 广播。 */
export function isOpencodeHost(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase().includes("opencode");
  } catch {
    return false;
  }
}

// 进程内缓存按「路径」键住：SE_DATA_DIR 变了（测试注入/Electron 后设 env）自动重读，不会拿着旧目录的 id。
let opencodeSessionCache: { readonly path: string; readonly id: string } | undefined;
let opencodeSessionInflight: Promise<string> | undefined;

/**
 * 取稳定会话 id：首次用时生成 uuid 并原子写 0600 持久化，之后一律复用（含跨进程重启）。
 * 并发首调合并为同一次生成；写盘失败不挡请求（进程内缓存仍保证本会话稳定）。
 */
export async function getOpencodeSessionId(): Promise<string> {
  const path = globalOpencodeSessionPath();
  if (opencodeSessionCache?.path === path) return opencodeSessionCache.id;
  opencodeSessionInflight ??= loadOrCreateOpencodeSessionId(path).finally(() => {
    opencodeSessionInflight = undefined;
  });
  return opencodeSessionInflight;
}

async function loadOrCreateOpencodeSessionId(path: string): Promise<string> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf-8"));
    const existing = isRecord(parsed) ? parsed.sessionId : undefined;
    if (typeof existing === "string" && existing.trim()) {
      opencodeSessionCache = { path, id: existing };
      return existing;
    }
  } catch {
    // 文件不存在/读失败/坏 JSON → 重新生成。session id 不是密钥、无数据损失，重建即恢复。
  }
  const id = randomUUID();
  opencodeSessionCache = { path, id };
  try {
    await mkdir(globalStoryEngineDir(), { recursive: true });
    await writeFileAtomic(path, `${JSON.stringify({ version: 1, sessionId: id }, null, 2)}\n`, { mode: 0o600 });
  } catch (error) {
    console.warn(
      `[opencode-session] 会话 id 持久化失败（${path}）：${error instanceof Error ? error.message : String(error)}。` +
        "本次进程内仍复用同一 id，重启后会重新生成。",
    );
  }
  return id;
}

/**
 * 直读 model-settings.json 抽某 provider 的 customHeaders（含值）。
 * 为何绕开 summary：ProviderConfigSummary 脱敏只回键名。读失败/无配置 → {}（缺几个自定义头绝不挡请求）。
 */
export async function readProviderCustomHeaders(providerId: string): Promise<Record<string, string>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(globalModelSettingsPath(), "utf-8"));
    if (!isRecord(parsed) || !isRecord(parsed.providers)) return {};
    const provider = parsed.providers[providerId];
    if (!isRecord(provider) || !isRecord(provider.customHeaders)) return {};
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(provider.customHeaders)) {
      if (name.trim() && typeof value === "string") headers[name] = value;
    }
    return headers;
  } catch {
    return {};
  }
}

/**
 * 组装发往 provider 的请求头（所有出站出口共用：chat 非流式/流式、/models 连通性测试、agent SDK 路）。
 * 叠加顺序（后者盖前者）：opencode 定向头（仅 opencode 主机）→ authorization → customHeaders（用户显式配置最后盖，
 * 允许自定义 UA/session/鉴权——备胎 relay 就靠它手工配上 x-opencode-session）。头名统一小写，避免大小写双键并发。
 */
export async function buildProviderRequestHeaders(input: {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly customHeaders?: Readonly<Record<string, string>>;
}): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  if (isOpencodeHost(input.baseUrl)) {
    headers["user-agent"] = STORY_ENGINE_USER_AGENT;
    headers["x-opencode-session"] = await getOpencodeSessionId();
  }
  if (input.apiKey) headers.authorization = `Bearer ${input.apiKey}`;
  for (const [name, value] of Object.entries(input.customHeaders ?? {})) {
    const normalized = name.trim().toLowerCase();
    if (normalized) headers[normalized] = value;
  }
  return headers;
}

// ---------------------------------------------------------------------------
// 模型能力自适应学习：always-on 思考模型（不可关思考）——不维护硬编码模型表
// ---------------------------------------------------------------------------
//
// 真机实锤（glm-5.3-flash @ opencode-go）：always-thinking 模型，发 thinking:{type:"disabled"}
// 上游直接 400「[1210] cannot be disabled; please use low, high, or max」。这类模型会越来越多，
// 硬编码表永远滞后 → 自适应：认出这个特定 400 → 省略思考参数重试一次（让模型用自身默认）→
// 重试成功即把「host+model 不可关思考」记进 ~/.story-engine/model-capabilities.json，之后直接
// 跳过 disabled 注入、不再付 400 学费。**只认这一个错误**，其他 400 原样抛、绝不吞。

export function globalModelCapabilitiesPath(): string {
  return join(globalStoryEngineDir(), "model-capabilities.json");
}

export interface ModelCapabilityEntry {
  readonly alwaysOnThinking?: boolean;
  /** 不认 `stream_options`（末帧带用量）：发了就 400（写作版本 P2a 4.5：学到就落盘，每个模型只被拒一次）。 */
  readonly noStreamOptions?: boolean;
  /** ISO 时间戳，纯诊断用。 */
  readonly learnedAt?: string;
}

/**
 * 能力键 = provider baseUrl 的 host + model id（小写归一）。同一模型挂不同网关各自记账；
 * baseUrl 解析不出 host（非法 URL / 裸 host 串）时用整串兜底，agent 路从请求 URL 抠出的裸 host 天然兼容。
 */
export function modelCapabilityKey(baseUrl: string, modelId: string): string {
  let host = baseUrl.trim().toLowerCase();
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch { /* 非 URL（裸 host 等）→ 用整串兜底 */ }
  return `${host}::${modelId.trim().toLowerCase()}`;
}

/** 读能力库。三态对齐旁路文件惯例：ENOENT → 空库（首跑正常态）；坏 JSON/结构不识 → corrupt:true（绝不覆盖坏文件）。 */
async function readModelCapabilities(): Promise<{ readonly models: Record<string, ModelCapabilityEntry>; readonly corrupt: boolean }> {
  let text: string;
  try {
    text = await readFile(globalModelCapabilitiesPath(), "utf-8");
  } catch {
    return { models: {}, corrupt: false };
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.models)) return { models: {}, corrupt: true };
    const models: Record<string, ModelCapabilityEntry> = {};
    for (const [key, value] of Object.entries(parsed.models)) {
      if (!isRecord(value) || (value.alwaysOnThinking !== true && value.noStreamOptions !== true)) continue;
      models[key] = {
        ...(value.alwaysOnThinking === true ? { alwaysOnThinking: true } : {}),
        ...(value.noStreamOptions === true ? { noStreamOptions: true } : {}),
        ...(typeof value.learnedAt === "string" ? { learnedAt: value.learnedAt } : {}),
      };
    }
    return { models, corrupt: false };
  } catch {
    return { models: {}, corrupt: true };
  }
}

// 损坏只警告一次（每次请求都查，避免刷屏）；恢复正常后重置，再坏再警告。
let modelCapabilitiesCorruptWarned = false;
function warnIfModelCapabilitiesCorrupt(corrupt: boolean): void {
  if (corrupt && !modelCapabilitiesCorruptWarned) {
    modelCapabilitiesCorruptWarned = true;
    console.warn(
      `[model-capabilities] ${globalModelCapabilitiesPath()} 解析失败，本次按无记忆运行且绝不覆盖该文件` +
        "（可能再付一次 400 学费重新学习）；请检查或删除该文件。",
    );
  } else if (!corrupt && modelCapabilitiesCorruptWarned) {
    modelCapabilitiesCorruptWarned = false;
  }
}

/**
 * 进程里学到的「不认」（`能力键|alwaysOnThinking` / `能力键|noStreamOptions`）：学到那一刻先记这里、再落盘，
 * 落盘失败也只是重启后又不知道，这个进程不会再发被拒的那项（写作版本 P2a 4.5）。
 */
const learnedInProcess = new Set<string>();

/** 查「该模型是否已确认不可关思考」。读失败/坏 JSON 只当无记忆，绝不因此挡住请求。 */
export async function isAlwaysOnThinkingModel(baseUrl: string, modelId: string): Promise<boolean> {
  if (learnedInProcess.has(`${modelCapabilityKey(baseUrl, modelId)}|alwaysOnThinking`)) return true;
  const { models, corrupt } = await readModelCapabilities();
  warnIfModelCapabilitiesCorrupt(corrupt);
  return models[modelCapabilityKey(baseUrl, modelId)]?.alwaysOnThinking === true;
}

/** 查「该模型（这个网关上）已确认不认 stream_options」。 */
async function isNoStreamOptionsModel(baseUrl: string, modelId: string): Promise<boolean> {
  if (learnedInProcess.has(`${modelCapabilityKey(baseUrl, modelId)}|noStreamOptions`)) return true;
  const { models, corrupt } = await readModelCapabilities();
  warnIfModelCapabilitiesCorrupt(corrupt);
  return models[modelCapabilityKey(baseUrl, modelId)]?.noStreamOptions === true;
}

// 并发学习串行化：多个任务同时踩中新 always-on 模型时排队读-改-写，避免相互覆盖丢记录。
let capabilityLearnChain: Promise<void> = Promise.resolve();

/**
 * 学习：被拒那一次就确认「不可关思考」→ 合并落盘（原子写；非密钥，0600 不必）。
 * 坏 JSON 时**跳过写入**——绝不拿「空库」盖掉损坏文件（对齐 model-secrets/task-assignments 的坏文件保护）。
 * 落盘失败不挡请求（下轮再付一次学费重学即可）。
 */
export async function learnAlwaysOnThinkingModel(baseUrl: string, modelId: string): Promise<void> {
  return learnCapability(baseUrl, modelId, { alwaysOnThinking: true });
}

function learnCapability(baseUrl: string, modelId: string, learned: Pick<ModelCapabilityEntry, "alwaysOnThinking" | "noStreamOptions">): Promise<void> {
  const key = modelCapabilityKey(baseUrl, modelId);
  if (learned.alwaysOnThinking) learnedInProcess.add(`${key}|alwaysOnThinking`);
  if (learned.noStreamOptions) learnedInProcess.add(`${key}|noStreamOptions`);
  capabilityLearnChain = capabilityLearnChain.then(() => persistCapability(baseUrl, modelId, learned));
  return capabilityLearnChain;
}

async function persistCapability(baseUrl: string, modelId: string, learned: Pick<ModelCapabilityEntry, "alwaysOnThinking" | "noStreamOptions">): Promise<void> {
  try {
    const { models, corrupt } = await readModelCapabilities();
    if (corrupt) {
      warnIfModelCapabilitiesCorrupt(true);
      return;
    }
    const key = modelCapabilityKey(baseUrl, modelId);
    const known = models[key];
    if ((!learned.alwaysOnThinking || known?.alwaysOnThinking) && (!learned.noStreamOptions || known?.noStreamOptions)) return;
    models[key] = { ...known, ...learned, learnedAt: new Date().toISOString() };
    await mkdir(globalStoryEngineDir(), { recursive: true });
    await writeFileAtomic(globalModelCapabilitiesPath(), `${JSON.stringify({ version: 1, models }, null, 2)}\n`);
  } catch (error) {
    console.warn(
      `[model-capabilities] 能力落盘失败（${globalModelCapabilitiesPath()}）：${error instanceof Error ? error.message : String(error)}。` +
        "本次请求不受影响，下轮重新学习。",
    );
  }
}

/**
 * 判定上游 400 是否为「思考不可关」特征（always-on 思考模型）。真机原文：
 * 「[1210] cannot be disabled; please use low, high, or max」——注意原文不一定带 thinking 字样。
 * 宽松覆盖已知文案变体（cannot/can not/can't be disabled、智谱 1210 码、中文「不可关闭」类），
 * 但**只认 400**：其他状态码、其他 400（鉴权/余额/参数错/模型不存在）一律 false，绝不吞错重试。
 */
export function isThinkingCannotBeDisabledError(status: number, errorText: string): boolean {
  if (status !== 400) return false;
  const t = errorText.toLowerCase();
  if (/cannot be disabled|can not be disabled|can't be disabled|could not be disabled/u.test(t)) return true;
  // 不猜白名单开始：报错分类
  if (/\b1210\b/u.test(t) && /disabled|thinking|reasoning|思考/u.test(t)) return true;
  if (/thinking|reasoning|enable_thinking|思考/u.test(t) && /不可(?:以)?关闭|不能关闭|无法关闭|不支持关闭/u.test(t)) return true;
  // 不猜白名单结束
  // glm-5.3 真机文案：「GLM-5.3 is a thinking-only model; disabling thinking…is not supported」（不带 cannot/disabled 连写）
  if (/thinking-only/u.test(t) || (/disabling (?:the )?(?:thinking|reasoning)/u.test(t) && /not supported/u.test(t))) return true;
  return false;
}

/** 请求体是否带「关思考」信号（glm thinking.type=disabled / qwen enable_thinking:false）。没带就没资格谈「cannot be disabled」重试。 */
export function bodyRequestsThinkingOff(body: Readonly<Record<string, unknown>>): boolean {
  const thinking = body.thinking;
  if (isRecord(thinking) && thinking.type === "disabled") return true;
  return body.enable_thinking === false;
}

/** 剥离请求体里全部思考参数（thinking / enable_thinking 整键省略，让模型用自身默认）。 */
export function omitThinkingParams(body: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const next = { ...body };
  delete next.thinking;
  delete next.enable_thinking;
  return next;
}

/**
 * 算本次请求实际要发的思考参数：已学到「不可关思考」且用户想关 → 整键省略（再发 disabled 必 400，不再付学费）；
 * 其余照常按方言翻译——**用户显式开思考照发不误**（手动配置优先，一律不硬编码 enabled）。
 */
async function thinkingParamsForRequest(input: {
  readonly baseUrl: string;
  readonly modelId: string;
  readonly dialect: ThinkingDialect;
  readonly thinking: boolean;
  readonly stream: boolean;
}): Promise<Record<string, unknown>> {
  if (!input.thinking && input.dialect !== "none" && (await isAlwaysOnThinkingModel(input.baseUrl, input.modelId))) {
    return {};
  }
  return thinkingRequestParams({ dialect: input.dialect, thinking: input.thinking, stream: input.stream });
}

/** 重试留痕（诚实可见·console.warn 级别；agent 路不打扰用户，仅日志/diagnostics 可见）。 */
function warnAlwaysOnThinkingRetry(modelId: string, baseUrl: string, errorText: string): void {
  let host = baseUrl;
  try {
    host = new URL(baseUrl).hostname;
  } catch { /* 裸 host 原样 */ }
  console.warn(
    `[model-capabilities] 模型「${modelId}」@${host} 拒绝关闭思考（400：${errorText.slice(0, 200)}）。` +
      "已记住该模型、省略思考参数重试一次（让模型用自身默认），之后直接跳过 disabled 注入。",
  );
}

// ---------------------------------------------------------------------------
// 兼容能力：每个模型每项只被拒一次（写作版本 P2a 4.5）
// ---------------------------------------------------------------------------
//
// 两项：末帧带用量（stream_options）、能关思考。不认的那一项学到先记进进程、再落盘（model-capabilities，重启不丢）；
// 认的只记在进程里（重启后头一笔重新探）。同一模型这次要用的能力里还有不知道的，同时只放一笔去探：别的在进闸之前等，
// 探的那笔拿到 2xx、或被兼容 400 拒了并按去掉那项的重发拿到结局才放开；探的那笔别的结局（取消、暂停、连不上、5xx）
// 什么都不学也放开。放开后等着的各自按最新学到的重组请求体，还有不知道的再同步抢探的位子（只一笔接着探）。
// 所以一个进程里每个模型每项最多被拒一次；跨重启由额度兜（unlearnedCapabilityCount）。

type Capability = "stream_options" | "thinking_off";

/** 进程里确认过认的能力（`能力键|能力`）。 */
const workingCapabilities = new Set<string>();
/** 正在探的（能力键 → 探完时 resolve）。 */
const capabilityProbes = new Map<string, Promise<void>>();

/** 这次请求体要用到的能力。 */
function capabilitiesUsed(body: Readonly<Record<string, unknown>>): readonly Capability[] {
  return [...("stream_options" in body ? ["stream_options" as const] : []), ...(bodyRequestsThinkingOff(body) ? ["thinking_off" as const] : [])];
}

/** 拿到 2xx：这次用到的能力都认。 */
function rememberWorkingCapabilities(key: string, body: Readonly<Record<string, unknown>>): void {
  for (const capability of capabilitiesUsed(body)) workingCapabilities.add(`${key}|${capability}`);
}

/**
 * 发之前定请求体：`build` 按落了盘的学到的组（不认的项已经去掉）。还有不知道认不认的项，就排进这个模型的探测——
 * 没人在探就自己探（带回探完要调的放行函数），有人在探就等它（每 5 秒续一下空闲计时）、再按最新学到的重组一遍。
 * 都知道了不带放行函数。
 */
async function bodyAfterProbe(
  key: string,
  build: () => Promise<Record<string, unknown>>,
  signal: AbortSignal,
  onWait: () => void,
): Promise<{ readonly body: Record<string, unknown>; readonly release?: () => void }> {
  for (;;) {
    const body = await build();
    if (!hasUnknownCapability(key, body)) return { body };
    const running = capabilityProbes.get(key);
    if (!running) {
      let finish!: () => void;
      const probe = new Promise<void>((resolve) => { finish = resolve; });
      capabilityProbes.set(key, probe);
      return {
        body,
        release: () => {
          if (capabilityProbes.get(key) === probe) capabilityProbes.delete(key);
          finish();
        },
      };
    }
    signal.throwIfAborted();
    const pulse = setInterval(onWait, 5000);
    (pulse as unknown as { unref?: () => void }).unref?.();
    try {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        void running.finally(() => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        });
      });
    } finally {
      clearInterval(pulse);
    }
  }
}

/** 这一笔的请求体里还有不知道认不认的能力（不认的已经由 build 去掉了，剩下的没确认认就是不知道）。 */
function hasUnknownCapability(key: string, body: Readonly<Record<string, unknown>>): boolean {
  return capabilitiesUsed(body).some((capability) => !workingCapabilities.has(`${key}|${capability}`));
}

/**
 * 额度里给兼容改参留几次（设计 4.5：受理时按这次冻结的模型算；接着做时再按当时没学全的算一次）：
 * 这个模型两项能力里还没学到的项数（学到不认的、确认认的都不算）。能关思考只在方言能发思考开关时算。
 */
export async function unlearnedCapabilityCount(configured: Pick<ResolvedChatModel, "provider" | "profile" | "thinkingDialect">): Promise<number> {
  const key = modelCapabilityKey(configured.provider.baseUrl, configured.profile.model);
  const streamKnown = workingCapabilities.has(`${key}|stream_options`) || (await isNoStreamOptionsModel(configured.provider.baseUrl, configured.profile.model));
  const thinkingKnown = configured.thinkingDialect === "none"
    || workingCapabilities.has(`${key}|thinking_off`)
    || (await isAlwaysOnThinkingModel(configured.provider.baseUrl, configured.profile.model));
  return (streamKnown ? 0 : 1) + (thinkingKnown ? 0 : 1);
}

/**
 * 400 是不是这次能力还不知道的那一项被拒了，是就学（落盘）并给出去掉它的请求体；不是返回 undefined（如实失败，不再发）。
 * 只认两种：去掉 stream_options（报错里提到它）、关不了思考（isThinkingCannotBeDisabledError）。已确认认的那项不算。
 */
async function compatRetryBody(
  key: string,
  configured: ResolvedChatModel,
  body: Readonly<Record<string, unknown>>,
  errorText: string,
): Promise<Record<string, unknown> | undefined> {
  const { baseUrl } = configured.provider;
  const model = configured.profile.model;
  // 不猜白名单：报错分类
  if ("stream_options" in body && !workingCapabilities.has(`${key}|stream_options`) && /stream_options|include_usage/iu.test(errorText)) {
    await learnCapability(baseUrl, model, { noStreamOptions: true });
    const next = { ...body };
    delete next.stream_options;
    return next;
  }
  if (bodyRequestsThinkingOff(body) && !workingCapabilities.has(`${key}|thinking_off`) && isThinkingCannotBeDisabledError(400, errorText)) {
    warnAlwaysOnThinkingRetry(model, baseUrl, errorText);
    await learnAlwaysOnThinkingModel(baseUrl, model);
    return omitThinkingParams(body);
  }
  return undefined;
}

/** 只供单测：清掉进程里认过的能力和在探的。 */
export function __resetCapabilityMemoryForTests(): void {
  learnedInProcess.clear();
  workingCapabilities.clear();
  capabilityProbes.clear();
}

// ---------------------------------------------------------------------------
// OpenAI-compatible HTTP helper
// ---------------------------------------------------------------------------

/**
 * 一次性调模型拿全文（做厚 / 世界观 / 关系 / 写作规则等）。
 *
 * 重构 P4 起内部走流式 + 空闲超时（同 streamChatModelToText）：有字节就续命、**不设总时长上限**，
 * 连接彻底静默超 STREAM_IDLE_TIMEOUT_MS 才判死。原来是非流式 + 固定总时长（调用方传 250s），
 * 推理模型想得久、整段一次性返回时会撞代理超时或被总时长误杀。返回形状只剩 content（调用方本来只用它）。
 *
 * 不设人为上限——**一律不传 max_tokens**，让模型用自身上限跑完、自然收尾，绝不截断。
 * 推理模型的思考(reasoning_content)也算进 max_tokens，实测光思考就要 6~9k token；任何小上限都会把思考
 * 还没写完就截断、正文 content 一个字没出。故调用选项上根本没有 maxTokens 字段（传了直接编译失败）。
 */
export async function callOpenAICompatibleChatModel(input: {
  readonly configured: ResolvedChatModel;
  readonly messages: readonly { readonly role: string; readonly content: string }[];
  readonly temperature?: number;
  readonly responseFormat?: { readonly type: "json_object" };
}): Promise<{ readonly content: string }> {
  // 正文为空 / 只有思考由 streamChatModelToText 按「产物不能用」抛（写作版本 P2a 4.2），这里拿到的一定有字。
  const { content } = await streamChatModelToText({
    configured: input.configured,
    messages: input.messages,
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.responseFormat ? { responseFormat: input.responseFormat } : {}),
  });
  return { content: content.trim() };
}

// ---------------------------------------------------------------------------
// SSE streaming reader
// ---------------------------------------------------------------------------

/** 流式一帧的最小形状（模型无关：只认 OpenAI 兼容网关普遍带的字段，其余一律忽略）。 */
interface StreamFrame {
  readonly choices?: readonly {
    readonly delta?: {
      readonly content?: string;
      readonly reasoning_content?: string;
      readonly thinking?: string;
      readonly role?: string;
    };
    readonly message?: { readonly content?: string };
    readonly finish_reason?: string | null;
  }[];
  /** 上游在流中途/开头塞的错误帧：OpenAI 形 `{error:{message}}`，也有网关直接给字符串。 */
  readonly error?: { readonly message?: string; readonly code?: string | number; readonly type?: string } | string;
  /** stream_options.include_usage 打开时末帧带的用量（各家字段不一，见 token-meter 的宽进解析）。 */
  readonly usage?: unknown;
}

/**
 * 从一帧里抠出上游错误文案；没有 error 字段返回 undefined。
 * 治「流式解析吞 error 帧」：以前只读 choices[0].delta，上游 200 + 流里一句 `{"error":{...}}`
 * 就被当 keepalive 忽略，聚合出一段空/半截正文还报成功——与非流式 parseFirstChoiceContent 的 error.message 检查对齐。
 */
export function describeStreamErrorFrame(parsed: unknown): string | undefined {
  if (!parsed || typeof parsed !== "object") return undefined;
  const error = (parsed as StreamFrame).error;
  if (error === undefined || error === null) return undefined;
  if (typeof error === "string") return error.trim() || "上游返回了未说明原因的错误";
  if (typeof error === "object") {
    const message = typeof error.message === "string" ? error.message.trim() : "";
    if (message) return message;
    const code = error.code !== undefined ? String(error.code) : "";
    const type = typeof error.type === "string" ? error.type : "";
    return [type, code].filter(Boolean).join(" ") || "上游返回了未说明原因的错误";
  }
  return undefined;
}

/**
 * finish_reason 是否表示「正文没完整收尾」（被截断 / 被过滤）。只认各家网关公认的几个值：
 * OpenAI `length`/`content_filter`、Anthropic 兼容网关的 `max_tokens`、个别网关的 `truncated`。
 * 认不出的非 stop 值（`end_turn`/`tool_calls`/厂商私有）**不**当失败——模型无关铁律：不赌陌生网关的枚举。
 */
export function isTruncatedFinishReason(finishReason: string | undefined): boolean {
  if (!finishReason) return false;
  const normalized = finishReason.trim().toLowerCase();
  return normalized === "length" || normalized === "content_filter" || normalized === "max_tokens" || normalized === "truncated";
}

/** 把「正文没完整收尾」翻成给人看的一句话（含已收到多少字，方便判断是半截还是全空）。 */
export function describeTruncatedFinish(finishReason: string, contentLength: number): string {
  const normalized = finishReason.trim().toLowerCase();
  const got = contentLength > 0 ? `已收到 ${contentLength} 字半截输出，` : "正文一个字都没出，";
  if (normalized === "content_filter") {
    return `模型输出被上游内容过滤中断（finish_reason=${finishReason}），${got}不能当成完整结果使用，请调整内容后重试。`;
  }
  return `模型输出被截断（finish_reason=${finishReason}），${got}不能当成完整结果使用。本网关不设 max_tokens 上限，截断多为模型自身上限或网关限制，可重试或换更稳的模型。`;
}

/** 读完一次流式响应的样子（写作版本 P2a 4.2：定类只看这些结构，不看文案）。 */
export interface ParsedStream {
  readonly content: string;
  readonly thinking: string;
  readonly finishReason?: string;
  readonly usage?: unknown;
  /** 见到了结束标记（`[DONE]` 或非空 finish_reason）。没见到 = 流没收尾就断了，结果不明。 */
  readonly sawEnd: boolean;
  /** 解析不了的数据帧数：不当保活跳过（真保活是注释行和空行），有一帧就说明正文可能丢了字。 */
  readonly badFrames: number;
  /** 流里的错误帧（头一条的文案）：只拿来告诉作者，定类看有没有。 */
  readonly errorText?: string;
}

/**
 * 读一次流式响应。不在读的途中抛「模型返回错误」：错误帧、坏帧、截断都记下来读到底，由调用方按 4.2 的表定类
 * （丢了字的正文只进 attempt 溯源，不交给调用方）。读的途中连接断了、被掐了照常抛（调用方按 abort reason 定类）。
 */
export async function streamOpenAICompatibleResponse(
  response: globalThis.Response,
  onDelta: (delta: string) => void,
  onThinkingDelta?: (delta: string) => void,
  // 每收到一块原始字节就回调（含 keepalive / 仅 role 的首块）——用于空闲超时「有字节就续命」，
  // 比只盯 content/thinking delta 更准：思考阶段 content 为空但 reasoning 在流，连接其实活着。
  onActivity?: () => void,
): Promise<ParsedStream> {
  let content = "";
  let thinking = "";
  let finishReason: string | undefined;
  let usage: unknown;
  let badFrames = 0;
  let errorText: string | undefined;

  const consumeFrame = (parsed: StreamFrame): void => {
    const frameError = describeStreamErrorFrame(parsed);
    if (frameError) {
      errorText ??= frameError;
      return;
    }
    if (parsed.usage) usage = parsed.usage;
    const choice = parsed.choices?.[0];
    const delta = choice?.delta;
    const textDelta = delta?.content ?? choice?.message?.content ?? "";
    if (textDelta) {
      content += textDelta;
      onDelta(textDelta);
    }
    const thinkDelta = delta?.reasoning_content ?? delta?.thinking ?? "";
    if (thinkDelta) {
      thinking += thinkDelta;
      onThinkingDelta?.(thinkDelta);
    }
    // 记下最后一帧的 finish_reason（非 null/空才算）：以前整段丢掉，length/content_filter 的半截正文被当完整结果。
    if (typeof choice?.finish_reason === "string" && choice.finish_reason.trim()) {
      finishReason = choice.finish_reason;
    }
  };
  const result = (sawDone: boolean): ParsedStream => ({
    content,
    thinking,
    ...(finishReason !== undefined ? { finishReason } : {}),
    ...(usage !== undefined ? { usage } : {}),
    sawEnd: sawDone || finishReason !== undefined,
    badFrames,
    ...(errorText !== undefined ? { errorText } : {}),
  });
  /** 一行 `data:`；返回 true = 见到了 [DONE]。 */
  const consumeLine = (line: string): boolean => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return false;
    const data = trimmed.slice("data:".length).trim();
    if (!data) return false;
    if (data === "[DONE]") return true;
    let parsed: StreamFrame;
    try {
      parsed = JSON.parse(data) as StreamFrame;
    } catch {
      badFrames += 1;
      return false;
    }
    consumeFrame(parsed);
    return false;
  };

  if (!response.body) {
    // 没有流（整段 JSON）：读完了才有结果；整段解析不了算一帧坏的。
    const text = await response.text();
    try {
      consumeFrame(JSON.parse(text) as StreamFrame);
    } catch {
      badFrames += 1;
    }
    return result(true);
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      onActivity?.(); // 收到任何字节 → 续命（重置空闲超时）
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/u);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (consumeLine(line)) {
          await reader.cancel().catch(() => undefined);
          return result(true);
        }
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  // 流结束：残留在 buffer 里的最后一行（不带换行收尾的网关）也要看一眼，别漏掉末帧的 error/finish_reason。
  return result(consumeLine(buffer + decoder.decode()));
}

// ---------------------------------------------------------------------------
// 空闲超时（不设总时长上限：有字节就续命、彻底静默才判死）
// ---------------------------------------------------------------------------

/** 默认空闲窗口：流式调模型时，完全收不到任何字节超过这么久才判定连接已死。
 * 不是「总时长上限」——只要还有 token（正文或思考）在流，每块都续命、永不超时。 */
export const STREAM_IDLE_TIMEOUT_MS = 90_000;

/**
 * 空闲超时控制器。`kick()` 每被调用一次就把计时器清零重排；只有连续静默达 `idleMs`
 * （一个字节都没来）才 `controller.abort()`。配合 streamOpenAICompatibleResponse 的 onActivity
 * 实现「有输出就续命、不设总上限」——治审稿/质检长内容被 60s/25s 死表误杀。
 */
export function createIdleAbort(idleMs: number): {
  readonly controller: AbortController;
  kick(): void;
  dispose(): void;
} {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (): void => {
    timer = setTimeout(() => controller.abort(), idleMs);
    // Node：别让这个计时器吊住进程退出（fake timer 下无 unref，按存在性判定）。
    const maybeUnref = timer as unknown as { unref?: () => void };
    if (typeof maybeUnref.unref === "function") maybeUnref.unref();
  };
  const kick = (): void => {
    if (controller.signal.aborted) return; // 已判死就不复活
    if (timer) clearTimeout(timer);
    arm();
  };
  const dispose = (): void => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  arm();
  return { controller, kick, dispose };
}

export type StreamChatInput = {
  readonly configured: ResolvedChatModel;
  readonly messages: readonly { readonly role: string; readonly content: string }[];
  readonly temperature?: number;
  readonly responseFormat?: { readonly type: "json_object" };
  readonly idleTimeoutMs?: number;
  /** 每段正文 delta 实时回调（出稿流式进编辑器用）；不传则照常只聚合、不外发。 */
  readonly onDelta?: (delta: string) => void;
  /**
   * 「光想不写」上限（毫秒）：从发请求起这么久还一个正文字都没出（只在吐思考 token）→ 掐掉并抛 ThinkingTooLongError，
   * 由调用方改用关思考重试。不是总时长上限：一旦开始出正文就不再计时，正文写多久都行（守超时铁律）。
   * 十章验收实锤：拟章纲开思考陷进去 20 分钟（单回合思考 11 万字）——空闲超时管不住，因为思考 token 一直在续命。
   */
  readonly maxThinkingMs?: number;
  /**
   * 正文字数上限：超过就掐掉并抛错（只给输出本该很短的 JSON 调用用，如核账）。不是时长上限、也不是 max_tokens——
   * 治的是模型原地打转一直吐：评测里偶发单次调用 14 分钟不收尾，空闲超时管不住（一直有字节在续命）。
   */
  readonly maxContentChars?: number;
  /**
   * 调用方自己掐这一次（对冲掐输家）：abort reason 用 StopSignal（`hedge_loser`），失败分类按它记。
   * 在操作里不用传操作的 signal：取消、暂停自己会掐在途请求。
   */
  readonly signal?: AbortSignal;
};

export type StreamChatResult = { readonly content: string; readonly thinking: string; readonly finishReason?: string };

function modelLabel(configured: ResolvedChatModel): string {
  return `${configured.provider.label || configured.provider.id} · ${configured.profile.model}`;
}

/** 换了备用模型后告诉作者的一句话（出稿等内部调用和对话 AI 同一句，一轮里只留一条）。 */
export function fallbackNotice(primary: ResolvedChatModel, fallback: ResolvedChatModel): string {
  return `主模型 ${modelLabel(primary)} 这次没连上，用了备用的 ${modelLabel(fallback)}。`;
}

/**
 * 能不能换备用（写作版本 P2a 4.2 登记的例外，契约第八节）：主模型没发出去，或明确拒了这次调用的身份（401 / 403 / 404）。
 * 5xx、断流、空闲超时都是「发出去了、结果不明」，不换（可能已经在算）；思考超长、跑飞是我们自己掐的，也不换。
 */
export function canFallBack(error: unknown): boolean {
  if (!(error instanceof ModelCallError)) return false;
  if (error.attemptClass === "not_sent") return true;
  return error.attemptClass === "rejected" && (error.statusCode === 401 || error.statusCode === 403 || error.statusCode === 404);
}

/**
 * 能不能整次再调一回（对冲第一份失败后补发那类结构重试）：只有产物不能用（见了结束标记、结果没法用）、没发出去的可以；
 * 结果不明、被拒、被停、我们自己掐的都不再发（设计 4.2：没登记的一律不再发）。不是模型调用的错（解析、校验）不在这里管。
 */
export function canCallAgain(error: unknown): boolean {
  if (error instanceof StopSignal || error instanceof OperationStopped) return false;
  if (!(error instanceof ModelCallError)) return true;
  return error.attemptClass === "unusable" || error.attemptClass === "not_sent";
}

/**
 * 流式调模型、聚合成文本（审稿 / 质检 / 出稿 / 核账 … 所有内部调用的唯一出口）。
 *
 * 备用模型（P10，写作版本 P2a 收窄）：只在 canFallBack 的那几种失败时换设置里的备用模型再试一次，思考开关跟着这次调用走；
 * 成了在本轮对话里留一句「这次用了备用」。备用也没成就把两边原因一起如实报。
 */
export async function streamChatModelToText(input: StreamChatInput): Promise<StreamChatResult> {
  try {
    return await streamWithFallback(input);
  } catch (error) {
    // 登记的改参、备用都走完了还是这几种：这一步不再发，上层 catch 了再调也到 beforeSend 为止。
    if (haltsStep(error)) haltStep(error);
    throw error;
  }
}

async function streamWithFallback(input: StreamChatInput): Promise<StreamChatResult> {
  try {
    return await streamChatModelOnce(input);
  } catch (error) {
    const fallback = input.configured.fallback;
    if (!fallback || !canFallBack(error)) throw error;
    const primaryReason = (error as Error).message;
    console.warn(`[model] 主模型 ${modelLabel(input.configured)} 没连上，换备用 ${modelLabel(fallback)} 再试：${primaryReason.slice(0, 200)}`);
    try {
      const result = await streamChatModelOnce({ ...input, configured: { ...fallback, thinking: input.configured.thinking } });
      recordTurnNotice(fallbackNotice(input.configured, fallback));
      return result;
    } catch (fallbackError) {
      if (!(fallbackError instanceof ModelCallError)) throw fallbackError;
      throw new ModelCallError(
        `${primaryReason}（备用模型 ${modelLabel(fallback)} 也没成：${fallbackError.message}）`,
        fallbackError.attemptClass,
        fallbackError.statusCode,
        fallbackError.unusable,
        { cause: fallbackError },
      );
    }
  }
}

/** 记账用的这次调用对象（额度组缺省 = 服务商地址的 origin，和闸同一口径）。 */
function attemptTargetOf(configured: ResolvedChatModel): AttemptTarget {
  let origin = configured.provider.baseUrl;
  try {
    origin = new URL(configured.provider.baseUrl).origin;
  } catch { /* 非法地址：整串兜底 */ }
  return {
    ...(configured.task ? { task: configured.task } : {}),
    provider: configured.provider.id,
    model: configured.profile.model,
    quotaGroup: configured.provider.quotaGroup?.trim() || origin,
  };
}

/** 见了结束标记、产物却不能用的是哪一种（没有就是能用）。 */
function unusableOf(parsed: ParsedStream): { readonly reason: UnusableReason; readonly message: string } | undefined {
  if (parsed.errorText !== undefined) return { reason: "error_frame", message: `模型返回错误：${parsed.errorText}` };
  if (parsed.badFrames > 0) return { reason: "bad_frames", message: `模型的回复里有 ${parsed.badFrames} 段读不懂，这次的结果不完整、不能用，请重试。` };
  if (isTruncatedFinishReason(parsed.finishReason)) return { reason: "truncated", message: describeTruncatedFinish(parsed.finishReason as string, parsed.content.length) };
  if (parsed.content.trim()) return undefined;
  // 绝不静默返回空串：推理模型把输出全花在思考链上、正文还没开始，是最常见真因。
  if (parsed.thinking.trim()) {
    return {
      reason: "thinking_only",
      message: "模型把输出全用在思考链上、正文(content)为空。本网关不设 max_tokens 上限（用模型自身上限），别调 max_tokens；多为提示词过长或模型异常，可重试或换更快/更稳的模型。",
    };
  }
  return { reason: "empty", message: "模型返回了空内容。" };
}

/** 拿到了非 2xx：读完响应体才算「完整的失败响应」（4xx → rejected）；3xx、5xx 一律结果不明；体没读完按怎么断的定。 */
async function readFailedResponse(response: Response, signal: AbortSignal): Promise<{ readonly attemptClass: AttemptOutcome["class"]; readonly text: string }> {
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    return { attemptClass: classifyThrown(error, signal, true), text: "" };
  }
  return { attemptClass: response.status >= 400 && response.status < 500 ? "rejected" : "unknown", text };
}

/**
 * 流式调 OpenAI 兼容模型并把全文聚合成字符串。**不设总时长上限**：只要还有字节（正文或思考 token）
 * 在流，空闲计时器就被续命；只有彻底静默超过 `idleTimeoutMs` 才判定连接已死并抛错。
 * 一律不传 max_tokens（见 callOpenAICompatibleChatModel 注释）；`thinking:enabled` 思考链全程保留。
 *
 * 失败分类（写作版本 P2a 4.2）：发送不跟跳转；每次物理发送在操作里由闸落 attempt，拿到响应的那次在这里按读的结果结算；
 * 抛的一律是 ModelCallError（带类别），操作被取消 / 暂停时原样抛那个 StopSignal。自动再发只有登记的兼容改参（每项一次）。
 */
async function streamChatModelOnce(input: StreamChatInput): Promise<StreamChatResult> {
  const idleTimeoutMs = input.idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS;
  const idle = createIdleAbort(idleTimeoutMs);
  // 我们按策略掐的（光想不写、原地打转）：abort reason 说清是哪条，失败分类只看它。
  const policy = new AbortController();
  const operation = currentOperation();
  const signal = AbortSignal.any([
    idle.controller.signal,
    policy.signal,
    ...(input.signal ? [input.signal] : []),
    ...(operation ? [operation.signal] : []),
  ]);
  let contentChars = 0;
  // 「光想不写」从请求真发出去算：在限流闸里排队、429 退避的时间不算（2026-10-28：一章核账 13 遍并发、闸只放几个，
  // 排着队的几遍被当成「思考超过 180 秒」掐掉）。每次真发（含退避后重发）重新起算。
  let thinkingTimer: ReturnType<typeof setTimeout> | undefined;
  const stopThinkingTimer = () => { if (thinkingTimer) clearTimeout(thinkingTimer); };
  const startThinkingTimer = () => {
    if (!input.maxThinkingMs) return;
    stopThinkingTimer();
    thinkingTimer = setTimeout(() => policy.abort(new StopSignal({ type: "policy", policy: "thinking_too_long" })), input.maxThinkingMs);
    (thinkingTimer as unknown as { unref?: () => void }).unref?.();
  };
  let gotBytes = false; // 是否收过任何字节——区分「从头零响应」与「流到一半断流」，错误文案才诚实（治审查 #5）
  // 这一刻拿到了响应、还没结算的那次发送（只在操作里有）。
  let ticket: SendTicket | undefined;
  const settle = async (outcome: AttemptOutcome): Promise<void> => {
    const current = ticket;
    ticket = undefined;
    await current?.settle(outcome).catch((error: unknown) => {
      console.warn(`[model] 调用记账没写上：${error instanceof Error ? error.message : String(error)}`);
    });
  };
  let releaseProbe: (() => void) | undefined;
  try {
    const { configured } = input;
    const baseUrl = configured.provider.baseUrl.replace(/\/+$/u, "");
    const capabilityKey = modelCapabilityKey(configured.provider.baseUrl, configured.profile.model);
    const headers = {
      "content-type": "application/json",
      ...(await buildProviderRequestHeaders({
        baseUrl: configured.provider.baseUrl,
        apiKey: configured.apiKey,
        customHeaders: configured.customHeaders,
      })),
    };
    const build = async (): Promise<Record<string, unknown>> => ({
      model: configured.profile.model,
      messages: input.messages,
      temperature: input.temperature ?? configured.profile.temperature ?? 0.7,
      ...(input.responseFormat ? { response_format: input.responseFormat } : {}),
      // 思考链方言（模型无关·R7）：按 model id 翻成该模型认的开关。**这是流式路**——Qwen 可正常开关思考。见 thinkingRequestParams。
      // always-on 自适应：已学到「不可关思考」的模型要关思考时整键省略（再发 disabled 必 400，不再付学费）。
      ...(await thinkingParamsForRequest({
        baseUrl: configured.provider.baseUrl,
        modelId: configured.profile.model,
        dialect: configured.thinkingDialect,
        thinking: configured.thinking,
        stream: true,
      })),
      stream: true,
      // 末帧带真实用量（记进本轮 token 计量，见 token-meter）。学到不认就不发。
      ...((await isNoStreamOptionsModel(configured.provider.baseUrl, configured.profile.model)) ? {} : { stream_options: { include_usage: true } }),
    });
    const target = attemptTargetOf(configured);
    const send = (requestBody: Record<string, unknown>): Promise<Response> =>
      // 限流闸：排队 / 429 退避期间给空闲计时器续命，排队不算「连接静默」（provider-gate.ts）。
      providerGate.fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
        signal,
        redirect: "manual",
      }, {
        onWait: idle.kick,
        onSend: startThinkingTimer,
        ...(configured.provider.quotaGroup ? { quotaGroup: configured.provider.quotaGroup } : {}),
        attempt: { target, onTicket: (sent) => { ticket = sent; } },
      });

    const prepared = await bodyAfterProbe(capabilityKey, build, signal, idle.kick);
    releaseProbe = prepared.release;
    let body = prepared.body;
    let response = await send(body);
    // 非 2xx：读完响应体结算；只有这次能力还不知道的那一项被拒（400）才学了改参再发一次，每项一次。
    for (let retries = 0; !response.ok; retries += 1) {
      const failure = await readFailedResponse(response, signal);
      await settle({ class: failure.attemptClass, status: response.status, note: failure.text.slice(0, 200) });
      const retryBody = failure.attemptClass === "rejected" && response.status === 400 && retries < 2
        ? await compatRetryBody(capabilityKey, configured, body, failure.text)
        : undefined;
      if (!retryBody) {
        throw new ModelCallError(`模型请求失败：${response.status} ${failure.text.slice(0, 300)}`, failure.attemptClass, response.status);
      }
      body = retryBody;
      response = await send(body);
    }
    rememberWorkingCapabilities(capabilityKey, body);
    releaseProbe?.();
    releaseProbe = undefined;

    const parsed = await streamOpenAICompatibleResponse(
      response,
      // 正文 delta：传了 onDelta 就逐字外发（出稿流式），否则只聚合；一出正文就停「光想不写」计时。
      (delta) => {
        if (delta) stopThinkingTimer();
        contentChars += delta.length;
        if (input.maxContentChars && contentChars > input.maxContentChars && !policy.signal.aborted) {
          policy.abort(new StopSignal({ type: "policy", policy: "runaway" }));
        }
        input.onDelta?.(delta);
      },
      () => undefined,
      () => { gotBytes = true; idle.kick(); }, // 收到任何字节就续命，并记下「收过字节」
    );
    // 读的途中按策略掐了（正文跑飞、光想不写）但流已经读完：照掐的算，不拿读到的这些交差。
    if (policy.signal.aborted) throw policy.signal.reason;
    // 没见结束标记：流没收尾就断了（上游可能还在算、可能已经计费），结果不明，半截正文不交出去。
    if (!parsed.sawEnd) {
      await settle({ class: "unknown", note: "no_end_marker" });
      throw new ModelCallError(
        parsed.errorText !== undefined
          ? `模型返回错误：${parsed.errorText}`
          : `模型的回复没收尾就断了（${parsed.content.length > 0 ? `已收到 ${parsed.content.length} 字` : "正文一个字都没收到"}），这次的结果不能用，请重试。`,
        "unknown",
      );
    }
    const sample = sampleFromOpenAIUsage(parsed.usage);
    recordPipelineUsage(sample);
    void recordUsage({
      ...(configured.task ? { task: configured.task } : {}),
      provider: configured.provider.id,
      ...(configured.provider.label ? { providerLabel: configured.provider.label } : {}),
      model: configured.profile.model,
      sample,
    });
    // 产物不能用（错误帧、坏帧、被截断、正文为空）：诚实抛错，调用方按 ok=false 如实回报，绝不把半截稿当成功。
    const unusable = unusableOf(parsed);
    if (unusable) {
      await settle({ class: "unusable", usage: parsed.usage, note: unusable.reason });
      throw new ModelCallError(unusable.message, "unusable", undefined, unusable.reason);
    }
    await settle({ class: "ok", usage: parsed.usage });
    return { content: parsed.content, thinking: parsed.thinking, ...(parsed.finishReason !== undefined ? { finishReason: parsed.finishReason } : {}) };
  } catch (error) {
    if (error instanceof ModelCallError) throw error;
    // 读响应体时断了的那次还没结（发出去之前就没成的，闸已经结了 / 没落 attempt）。
    const attemptClass = classifyThrown(error, signal, ticket !== undefined);
    if (ticket) await settle({ class: attemptClass, note: error instanceof Error ? error.name : "stream_failed" });
    const stop = stopOf(signal.aborted ? signal.reason : undefined);
    if (stop?.type === "policy" && stop.policy === "thinking_too_long") throw new ThinkingTooLongError(input.maxThinkingMs ?? 0);
    if (stop?.type === "policy" && stop.policy === "runaway") throw new RunawayError(input.maxContentChars ?? 0);
    if (stop?.type === "policy") throw new ModelCallError("这一份被对冲的另一份先回来了，已停下。", "policy_abort");
    // 操作被取消 / 暂停：原样抛（降级的 catch 用 rethrowIfStopped 认它）。
    if (stop) throw signal.reason;
    if (idle.controller.signal.aborted) {
      const message = gotBytes
        ? `模型生成中途静默超过 ${Math.round(idleTimeoutMs / 1000)}s（已收到部分输出后上游断流，长内容生成时常见），请重试。`
        : `模型连接静默超过 ${Math.round(idleTimeoutMs / 1000)}s（一直没有任何响应），判定连接已死，请重试。`;
      throw new ModelCallError(message, "unknown", undefined, undefined, { cause: new UpstreamSilentError(message) });
    }
    // 操作里 beforeSend 不放行（额度到了、已经停了）：原样抛。
    if (!(error instanceof Error) || error instanceof OperationStopped) throw error;
    throw new ModelCallError(error.message, attemptClass, undefined, undefined, { cause: error });
  } finally {
    releaseProbe?.();
    stopThinkingTimer();
    idle.dispose();
  }
}

/** 「光想不写」超过上限（见 streamChatModelToText 的 maxThinkingMs）：调用方应改用关思考重试。我们自己掐的（policy_abort）。 */
export class ThinkingTooLongError extends ModelCallError {
  override readonly name = "ThinkingTooLongError";
  constructor(readonly maxThinkingMs: number) {
    super(`模型思考超过 ${Math.round(maxThinkingMs / 1000)} 秒还没开始输出，已停下（可改用不思考重试）`, "policy_abort");
  }
}

/** 正文超过这次调用的上限还没收尾（多半在原地打转）：我们自己掐的（policy_abort），不再发。 */
export class RunawayError extends ModelCallError {
  override readonly name = "RunawayError";
  constructor(readonly maxContentChars: number) {
    super(`模型输出超过 ${maxContentChars} 字还没收尾（多半在原地打转），已停下，请重试。`, "policy_abort");
  }
}

/** 这一步里出了这种失败就不再发（设计 4.2 兜底）：被拒、结果不明、跑飞。思考超长（登记了关思考重来）、对冲输家不算。 */
function haltsStep(error: unknown): error is ModelCallError {
  if (!(error instanceof ModelCallError) || error instanceof StepHaltedError) return false;
  return error.attemptClass === "rejected" || error.attemptClass === "unknown" || error instanceof RunawayError;
}

// ---------------------------------------------------------------------------
// Model settings text
// ---------------------------------------------------------------------------

export async function readModelSettingsText(status: ModelSettingsLoadResult["status"]): Promise<string> {
  if (status === "missing") return defaultModelSettingsText();
  try {
    return await readFile(globalModelSettingsPath(), "utf-8");
  } catch {
    return defaultModelSettingsText();
  }
}

function defaultModelSettingsText(): string {
  return `${JSON.stringify({
    version: 1,
    defaultProvider: "main",
    defaultProfile: "balanced",
    providers: {
      main: {
        id: "main",
        label: "OpenAI Compatible",
        type: "openai-compatible",
        baseUrl: "https://api.example.com/v1",
        apiKeyEnv: "STORY_ENGINE_API_KEY",
      },
    },
    profiles: {
      balanced: {
        id: "balanced",
        label: "长篇均衡",
        provider: "main",
        model: "model-name",
        temperature: 0.7,
        maxTokens: 4096,
        timeoutMs: 60000,
        retries: 2,
        stream: true,
      },
    },
    taskProfiles: {
      fastDraft: "balanced",
      chapterSteering: "balanced",
      qualityCheck: "balanced",
      repair: "balanced",
      draftReview: "balanced",
      triage: "balanced",
    },
  }, null, 2)}\n`;
}
