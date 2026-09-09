/**
 * Shared LLM client logic: OpenAI-compatible HTTP calls and streaming.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { loadModelSettingsV0, renderFastDraftPromptText } from "@actalk/story-engine";
import type { ModelSettingsLoadResult, WriterClient } from "@actalk/story-engine";
import { writeFileAtomic } from "./project-io.js";
import { resolveGlobalDataDir } from "./data-dirs.js";
import { engineProfileFallback, readTaskAssignments, resolveTaskProfileId, resolveTaskThinking } from "./task-assignments.js";
import { resolveThinkingDialect, thinkingRequestParams, type ThinkingDialect } from "./model-capabilities.js";
import { buildFastDraftMessages } from "./builtin-anti-ai-rules.js";

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

export type ModelTaskProfileKey = "fastDraft" | "chapterSteering" | "qualityCheck" | "repair" | "enrichment" | "draftReview" | "triage";

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
};

export async function resolveConfiguredChatModel(task: ModelTaskProfileKey): Promise<ResolvedChatModel> {
  const settings = await loadGlobalModelSettings();
  if (!settings.available) {
    throw new Error("模型设置未配置。请先在设置中配置 Provider 和任务模型。");
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
      throw new Error(
        `任务「${task}」指定的模型档案「${explicitProfileId}」不存在（可能已删除或改名）。` +
          `请在设置中重新为该任务选择模型。`,
      );
    }
    throw new Error(
      `任务「${task}」未解析到有效的模型 profile（解析结果：「${profileId ?? "空"}」）。请在设置中检查该任务的模型分配。`,
    );
  }
  const provider = settings.summary.providers.find((item) => item.id === profile.provider);
  if (!provider) {
    throw new Error(`Profile ${profile.id} 引用了不存在的 Provider：${profile.provider}`);
  }
  const apiKey = await resolveProviderApiKey(provider);
  if (provider.apiKeyStatus === "missing" && !apiKey) {
    throw new Error(`API Key 未设置。请设置环境变量 ${provider.apiKeyEnv}。`);
  }
  return {
    provider,
    profile,
    apiKey,
    thinking: resolveTaskThinking(assignments, task),
    thinkingDialect: resolveThinkingDialect(profile.model),
    customHeaders: await readProviderCustomHeaders(provider.id),
  };
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
      if (isRecord(value) && value.alwaysOnThinking === true) {
        models[key] = { alwaysOnThinking: true, ...(typeof value.learnedAt === "string" ? { learnedAt: value.learnedAt } : {}) };
      }
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

/** 查「该模型是否已确认不可关思考」。读失败/坏 JSON 只当无记忆，绝不因此挡住请求。 */
export async function isAlwaysOnThinkingModel(baseUrl: string, modelId: string): Promise<boolean> {
  const { models, corrupt } = await readModelCapabilities();
  warnIfModelCapabilitiesCorrupt(corrupt);
  return models[modelCapabilityKey(baseUrl, modelId)]?.alwaysOnThinking === true;
}

// 并发学习串行化：多个任务同时踩中新 always-on 模型时排队读-改-写，避免相互覆盖丢记录。
let capabilityLearnChain: Promise<void> = Promise.resolve();

/**
 * 学习：重试成功确认「不可关思考」→ 合并落盘（原子写；非密钥，0600 不必）。
 * 坏 JSON 时**跳过写入**——绝不拿「空库」盖掉损坏文件（对齐 model-secrets/task-assignments 的坏文件保护）。
 * 落盘失败不挡请求（下轮再付一次学费重学即可）。
 */
export async function learnAlwaysOnThinkingModel(baseUrl: string, modelId: string): Promise<void> {
  capabilityLearnChain = capabilityLearnChain.then(() => persistAlwaysOnThinkingModel(baseUrl, modelId));
  return capabilityLearnChain;
}

async function persistAlwaysOnThinkingModel(baseUrl: string, modelId: string): Promise<void> {
  try {
    const { models, corrupt } = await readModelCapabilities();
    if (corrupt) {
      warnIfModelCapabilitiesCorrupt(true);
      return;
    }
    const key = modelCapabilityKey(baseUrl, modelId);
    if (models[key]?.alwaysOnThinking === true) return;
    models[key] = { alwaysOnThinking: true, learnedAt: new Date().toISOString() };
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
  if (/\b1210\b/u.test(t) && /disabled|thinking|reasoning|思考/u.test(t)) return true;
  if (/thinking|reasoning|enable_thinking|思考/u.test(t) && /不可(?:以)?关闭|不能关闭|无法关闭|不支持关闭/u.test(t)) return true;
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
      "已省略思考参数重试一次（让模型用自身默认）；重试成功即记住该模型，之后直接跳过 disabled 注入。",
  );
}

// ---------------------------------------------------------------------------
// OpenAI-compatible HTTP helper
// ---------------------------------------------------------------------------

export async function callOpenAICompatibleChatModel(input: {
  readonly configured: ResolvedChatModel;
  readonly messages: readonly { readonly role: string; readonly content: string }[];
  readonly temperature?: number;
  readonly responseFormat?: { readonly type: "json_object" };
  readonly stream?: boolean;
  readonly timeoutMs?: number;
}): Promise<{ readonly content: string; readonly raw: string; readonly response: Response }> {
  const controller = new AbortController();
  const timeoutMs = input.timeoutMs ?? input.configured.profile.timeoutMs ?? 60000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  // 不设人为上限——**一律不传 max_tokens**，让模型用自身上限跑完、自然收尾，绝不截断。
  // 推理模型的思考(reasoning_content)也算进 max_tokens，实测光思考就要 6~9k token；任何小上限都会把思考
  // 还没写完就截断、正文 content 一个字没出（真机：世界观/做厚/正文都中招）。实测本网关不传＝用模型上限
  // （区间上限 393216、长输出 finish=stop 不截）；传 0 反被 DeepSeek 拒（"valid range [1,393216]"）。
  // 故调用选项上根本没有 maxTokens 字段（传了直接编译失败）；输出长度由提示词约束、模型自然收尾。思考全程保留。
  try {
    const baseUrl = input.configured.provider.baseUrl.replace(/\/+$/u, "");
    const headers = {
      "content-type": "application/json",
      ...(await buildProviderRequestHeaders({
        baseUrl: input.configured.provider.baseUrl,
        apiKey: input.configured.apiKey,
        customHeaders: input.configured.customHeaders,
      })),
    };
    const body: Record<string, unknown> = {
      model: input.configured.profile.model,
      messages: input.messages,
      temperature: input.temperature ?? input.configured.profile.temperature ?? 0.7,
      ...(input.responseFormat ? { response_format: input.responseFormat } : {}),
      // 思考链方言（请求侧模型无关·R7）：按 model id 翻成该模型认的开关（GLM thinking:{type} / Qwen enable_thinking /
      // 认不出整键不发）。**这是非流式路**——Qwen 非流式会被强制 enable_thinking:false（否则 400）。开/关由 task-assignments 决定。
      // always-on 自适应：已学到「不可关思考」的模型要关思考时整键省略（再发 disabled 必 400，不再付学费）。
      ...(await thinkingParamsForRequest({
        baseUrl: input.configured.provider.baseUrl,
        modelId: input.configured.profile.model,
        dialect: input.configured.thinkingDialect,
        thinking: input.configured.thinking,
        stream: input.stream ?? false,
      })),
      stream: input.stream ?? false,
    };
    const postChat = (requestBody: Record<string, unknown>): Promise<Response> =>
      fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
    let response = await postChat(body);
    let raw = await response.text();
    // always-on 思考自适应：仅当本次真发了「关思考」且上游 400 明说 cannot be disabled 才省略思考参数重试一次；
    // 其他 400 不吞——原样走 parseFirstChoiceContent 抛「模型返回错误」。
    if (!response.ok && bodyRequestsThinkingOff(body) && isThinkingCannotBeDisabledError(response.status, raw)) {
      warnAlwaysOnThinkingRetry(input.configured.profile.model, input.configured.provider.baseUrl, raw);
      response = await postChat(omitThinkingParams(body));
      raw = await response.text();
      if (response.ok) {
        await learnAlwaysOnThinkingModel(input.configured.provider.baseUrl, input.configured.profile.model);
      }
    }
    return { content: parseFirstChoiceContent(raw), raw, response };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`模型请求超时：${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * 抠出首个 choice 的正文。绝不静默返回空串——若 content 为空，抛带诊断的错：
 * 推理模型把 max_tokens 预算全耗在思考链上(finish_reason=length + 有 reasoning_content)、正文还没开始就被截断，
 * 是最常见真因（真机实测：世界观/做厚一直失败）。据此提示「调大 max_tokens」，而不是让下游报一句模糊的「不是 JSON」。
 */
function parseFirstChoiceContent(raw: string): string {
  const parsed = JSON.parse(raw) as {
    readonly choices?: readonly { readonly message?: { readonly content?: string; readonly reasoning_content?: string }; readonly finish_reason?: string }[];
    readonly error?: { readonly message?: string };
  };
  if (parsed.error?.message) throw new Error(`模型返回错误：${parsed.error.message}`);
  const choice = parsed.choices?.[0];
  const content = choice?.message?.content?.trim() ?? "";
  if (content) return content;
  const reasonedButNoOutput = (choice?.message?.reasoning_content?.length ?? 0) > 0 || choice?.finish_reason === "length";
  if (reasonedButNoOutput) {
    throw new Error("模型把额度全用在思考链上、正文(content)为空。本网关已不设 max_tokens 上限（用模型自身上限，见上注释），别再调 max_tokens；多为提示词过长或模型异常，可重试或换更快/更稳的模型。");
  }
  throw new Error("模型返回了空内容。");
}

// ---------------------------------------------------------------------------
// Writer client
// ---------------------------------------------------------------------------

export async function createConfiguredWriterClient(task: ModelTaskProfileKey, onDelta?: (delta: string) => void): Promise<WriterClient> {
  const configured = await resolveConfiguredChatModel(task);
  return createOpenAICompatibleWriterClient(configured, onDelta);
}

/**
 * 出稿 writer 客户端。**流式**调模型（afterfix 真机根因：非流式整章生成 100~140s，卡 hub 代理超时边界 → 间歇
 * 500「Internal server error」；流式首字节秒级、连接全程有字节、代理不判超时）。复用 streamChatModelToText：
 * 有字节就续命、不设总时长上限（超时铁律），一律不传 max_tokens，思考方言按 configured 翻译（模型无关）。
 * 这也收束了「非流式 writer」这条旧路——出稿与聊天/审稿/质检统一走同一条流式主干。导出以便单测。
 */
export function createOpenAICompatibleWriterClient(configured: ResolvedChatModel, onDelta?: (delta: string) => void): WriterClient {
  return {
    async generateDraft({ context }) {
      const { content } = await streamChatModelToText({
        configured,
        // 内置去AI味铁律（system·固定常量前缀）+ 引擎产出的正文 prompt（user）。
        // 准则是产品内核：内置代码常量、用户看不见/删不掉、只我们升级；引擎包零改（见 builtin-anti-ai-rules.ts）。
        messages: buildFastDraftMessages(renderFastDraftPromptText(context)),
        temperature: configured.profile.temperature ?? 0.8,
        // 出稿流式：传了 onDelta 就把正文逐字外发（agent 路流式进编辑器）；runFastDraft 仍拿完整 content，引擎零改。
        ...(onDelta ? { onDelta } : {}),
      });
      return {
        title: `第${context.chapter}章`,
        content: content.trim(),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// SSE streaming reader
// ---------------------------------------------------------------------------

export async function streamOpenAICompatibleResponse(
  response: globalThis.Response,
  onDelta: (delta: string) => void,
  onThinkingDelta?: (delta: string) => void,
  // 每收到一块原始字节就回调（含 keepalive / 仅 role 的首块）——用于空闲超时「有字节就续命」，
  // 比只盯 content/thinking delta 更准：思考阶段 content 为空但 reasoning 在流，连接其实活着。
  onActivity?: () => void,
): Promise<{ readonly content: string; readonly thinking: string }> {
  if (!response.body) {
    const parsed = await response.json() as { readonly choices?: readonly { readonly message?: { readonly content?: string } }[] };
    const content = parsed.choices?.[0]?.message?.content ?? "";
    if (content) onDelta(content);
    return { content, thinking: "" };
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";
  let content = "";
  let thinking = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    onActivity?.(); // 收到任何字节 → 续命（重置空闲超时）
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/u);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice("data:".length).trim();
      if (!data) continue;
      if (data === "[DONE]") {
        await reader.cancel().catch(() => undefined);
        return { content, thinking };
      }
      try {
        const parsed = JSON.parse(data) as {
          readonly choices?: readonly {
            readonly delta?: {
              readonly content?: string;
              readonly reasoning_content?: string;
              readonly thinking?: string;
              readonly role?: string;
            };
            readonly message?: { readonly content?: string };
          }[];
        };
        const delta = parsed.choices?.[0]?.delta;
        const textDelta = delta?.content ?? parsed.choices?.[0]?.message?.content ?? "";
        if (textDelta) {
          content += textDelta;
          onDelta(textDelta);
        }
        // Extract thinking/reasoning tokens from providers that support it
        const thinkDelta = delta?.reasoning_content ?? delta?.thinking ?? "";
        if (thinkDelta && onThinkingDelta) {
          thinking += thinkDelta;
          onThinkingDelta(thinkDelta);
        }
      } catch {
        // Ignore provider keepalive or non-JSON stream fragments.
      }
    }
  }

  return { content, thinking };
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

/**
 * 流式调 OpenAI 兼容模型并把全文聚合成字符串。**不设总时长上限**：只要还有字节（正文或思考 token）
 * 在流，空闲计时器就被续命；只有彻底静默超过 `idleTimeoutMs` 才判定连接已死并抛错。
 * 用于审稿/质检这类「内容多、生成久」的只读重活——它们曾因 60s/25s 的 AbortController 死表被误杀。
 * 一律不传 max_tokens（见 callOpenAICompatibleChatModel 注释）；`thinking:enabled` 思考链全程保留。
 */
export async function streamChatModelToText(input: {
  readonly configured: ResolvedChatModel;
  readonly messages: readonly { readonly role: string; readonly content: string }[];
  readonly temperature?: number;
  readonly responseFormat?: { readonly type: "json_object" };
  readonly idleTimeoutMs?: number;
  /** 每段正文 delta 实时回调（出稿流式进编辑器用）；不传则照常只聚合、不外发。 */
  readonly onDelta?: (delta: string) => void;
}): Promise<{ readonly content: string; readonly thinking: string }> {
  const idleTimeoutMs = input.idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS;
  const idle = createIdleAbort(idleTimeoutMs);
  let gotBytes = false; // 是否收过任何字节——区分「从头零响应」与「流到一半断流」，错误文案才诚实（治审查 #5）
  try {
    const baseUrl = input.configured.provider.baseUrl.replace(/\/+$/u, "");
    const headers = {
      "content-type": "application/json",
      ...(await buildProviderRequestHeaders({
        baseUrl: input.configured.provider.baseUrl,
        apiKey: input.configured.apiKey,
        customHeaders: input.configured.customHeaders,
      })),
    };
    const body: Record<string, unknown> = {
      model: input.configured.profile.model,
      messages: input.messages,
      temperature: input.temperature ?? input.configured.profile.temperature ?? 0.7,
      ...(input.responseFormat ? { response_format: input.responseFormat } : {}),
      // 思考链方言（模型无关·R7）：按 model id 翻成该模型认的开关。**这是流式路**——Qwen 可正常开关思考。见 thinkingRequestParams。
      // always-on 自适应：已学到「不可关思考」的模型要关思考时整键省略（再发 disabled 必 400，不再付学费）。
      ...(await thinkingParamsForRequest({
        baseUrl: input.configured.provider.baseUrl,
        modelId: input.configured.profile.model,
        dialect: input.configured.thinkingDialect,
        thinking: input.configured.thinking,
        stream: true,
      })),
      stream: true,
    };
    const postChat = (requestBody: Record<string, unknown>): Promise<Response> =>
      fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
        signal: idle.controller.signal,
      });
    let response = await postChat(body);
    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      // always-on 思考自适应：只认「cannot be disabled」这一个 400，省略思考参数重试一次（让模型用自身默认）；
      // 其他 400/5xx 原样抛，绝不吞错。
      if (bodyRequestsThinkingOff(body) && isThinkingCannotBeDisabledError(response.status, errorText)) {
        warnAlwaysOnThinkingRetry(input.configured.profile.model, input.configured.provider.baseUrl, errorText);
        response = await postChat(omitThinkingParams(body));
        if (response.ok) {
          await learnAlwaysOnThinkingModel(input.configured.provider.baseUrl, input.configured.profile.model);
        } else {
          const retryErrorText = await response.text().catch(() => "");
          throw new Error(`模型请求失败：${response.status} ${retryErrorText.slice(0, 300)}`);
        }
      } else {
        throw new Error(`模型请求失败：${response.status} ${errorText.slice(0, 300)}`);
      }
    }
    const { content, thinking } = await streamOpenAICompatibleResponse(
      response,
      input.onDelta ?? (() => undefined), // 正文 delta：传了 onDelta 就逐字外发（出稿流式），否则只聚合
      () => undefined,
      () => { gotBytes = true; idle.kick(); }, // 收到任何字节就续命，并记下「收过字节」
    );
    return { content, thinking };
  } catch (error) {
    if (idle.controller.signal.aborted) {
      const secs = Math.round(idleTimeoutMs / 1000);
      throw new Error(
        gotBytes
          ? `模型生成中途静默超过 ${secs}s（已收到部分输出后上游断流，长内容生成时常见），请重试。`
          : `模型连接静默超过 ${secs}s（一直没有任何响应），判定连接已死，请重试。`,
      );
    }
    throw error;
  } finally {
    idle.dispose();
  }
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
