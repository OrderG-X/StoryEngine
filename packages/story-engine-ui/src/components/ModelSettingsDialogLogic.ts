import type { ModelInfoItem, ModelProfileSummary, ModelSettingsLoadResult, TaskAssignmentView } from "../api/types.js";
import { PROVIDER_PRESETS } from "../constants/providerPresets.js";
import type { WizardServicePreset } from "../constants/wizardPresets.js";
import { TASK_LABELS, TASK_SUGGEST_THINKING, type SavedProvider } from "./ModelSettingsDialogTypes.js";

/** 任务模型档案 id：与 model-settings.json 的 profile id 同一套，旁路 task-assignments 也用它。 */
export function taskProfileId(provId: string, model: string): string {
  return `${provId}_${model}`.replace(/[^\w-]/g, "_");
}

/** 连通测试失败信息人话化：把 HTTP/网络底层报错翻成用户能行动的提示。 */
export function formatHumanTestError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/401|authentication|api key|invalid|unauthorized/i.test(message)) {
    return "密钥无效或已过期。请检查后重试，或到服务商控制台重新创建密钥。";
  }
  if (/timeout|超时|aborted/i.test(message)) {
    return "连接超时。请检查网络，或确认接口地址是否正确后再重试。";
  }
  if (/ENOTFOUND|ECONNREFUSED|无法连接|Failed to fetch|NetworkError/i.test(message)) {
    return "连不上该 AI 服务。请检查接口地址与网络后重试。";
  }
  if (/404|not found/i.test(message)) {
    return "接口地址可能不对（常见需以 /v1 结尾）。请修正后再试。";
  }
  const cleaned = message.replace(/\s+/g, " ").trim();
  return `测试未通过：${cleaned.slice(0, 160)}${cleaned.length > 160 ? "…" : ""}`;
}

/** 从 raw JSON 文本抽出对话记忆上限；缺省/非法返回 null。 */
export function parseChatHistoryBudgetTokens(rawText: string | undefined | null): number | null {
  if (!rawText?.trim()) return null;
  try {
    const parsed = JSON.parse(rawText) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const value = (parsed as Record<string, unknown>).chatHistoryBudgetTokens;
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : null;
  } catch {
    return null;
  }
}

/** 连通测试返回的模型列表里，优先取推荐模型，否则取第一项。 */
export function pickRecommendedModelId(
  models: readonly ModelInfoItem[],
  recommendedModel: string,
): string | null {
  if (models.length === 0) return null;
  const want = recommendedModel.trim();
  if (want && models.some((m) => m.id === want)) return want;
  return models[0]?.id ?? null;
}

/**
 * 向导成功后的推荐配置：单服务 + 全任务指向同一推荐模型 + 思考按软建议。
 */
export function buildWizardRecommendedState(
  preset: WizardServicePreset,
  baseUrl: string,
  modelId: string,
): {
  readonly providers: readonly SavedProvider[];
  readonly tasks: Record<string, string>;
  readonly thinking: Record<string, boolean>;
} {
  const providerId = preset.id === "custom" ? "custom" : preset.id;
  const provider: SavedProvider = {
    id: providerId,
    label: preset.label,
    baseUrl: baseUrl.trim(),
    apiKeyEnv: preset.apiKeyEnv,
    apiKeyStatus: "present",
  };
  const tasks: Record<string, string> = {};
  const thinking: Record<string, boolean> = {};
  for (const key of Object.keys(TASK_LABELS)) {
    tasks[key] = `${providerId}|${modelId}`;
    thinking[key] = TASK_SUGGEST_THINKING[key] ?? true;
  }
  return { providers: [provider], tasks, thinking };
}

export interface ParsedModelSettings {
  readonly tasks: Record<string, string>;
  readonly providers: readonly SavedProvider[];
  readonly providerModels: Record<string, readonly ModelInfoItem[]>;
}

export function parseModelSettings(result: ModelSettingsLoadResult | null | undefined): ParsedModelSettings {
  const summary = result?.summary;
  const taskProfiles = summary?.taskProfiles as Record<string, string> | undefined;
  const profiles = summary?.profiles ?? [];
  const providers = Array.isArray(summary?.providers) ? summary.providers : [];

  return {
    tasks: parseTaskAssignments(taskProfiles, profiles),
    providers: parseSavedProviders(providers),
    providerModels: parseProviderModels(profiles),
  };
}

function parseTaskAssignments(
  taskProfiles: Record<string, string> | undefined,
  profiles: readonly ModelProfileSummary[],
): Record<string, string> {
  const savedTasks: Record<string, string> = {};
  if (!taskProfiles) return savedTasks;

  for (const [taskKey, profileId] of Object.entries(taskProfiles)) {
    const profile = profiles.find((p) => p?.id === profileId);
    if (profile?.provider && profile.model) {
      savedTasks[taskKey] = `${profile.provider}|${profile.model}`;
    }
  }
  return savedTasks;
}

function parseSavedProviders(
  providers: ModelSettingsLoadResult["summary"]["providers"],
): readonly SavedProvider[] {
  return providers
    .filter((p): p is NonNullable<typeof p> => p != null && typeof p.id === "string")
    .map((p) => ({
      id: p.id,
      label: typeof p.label === "string" ? p.label : p.id,
      baseUrl: typeof p.baseUrl === "string" ? p.baseUrl : "",
      apiKeyEnv: typeof p.apiKeyEnv === "string" ? p.apiKeyEnv : "",
      apiKeyStatus: ["present", "missing", "not_required"].includes(p.apiKeyStatus as string)
        ? (p.apiKeyStatus as "present" | "missing" | "not_required")
        : "missing",
    }));
}

function parseProviderModels(
  profiles: readonly ModelProfileSummary[],
): Record<string, readonly ModelInfoItem[]> {
  const modelsByProvider: Record<string, ModelInfoItem[]> = {};
  for (const profile of profiles) {
    if (!profile?.provider || !profile.model) continue;
    if (!modelsByProvider[profile.provider]) modelsByProvider[profile.provider] = [];
    if (!modelsByProvider[profile.provider].some((m) => m.id === profile.model)) {
      modelsByProvider[profile.provider].push({ id: profile.model, name: profile.model });
    }
  }
  return modelsByProvider;
}

/**
 * 表单路径重建整份 model-settings 配置。P2-3 残留洞修复：options.previousRawText 给当前磁盘配置原文
 * （GET 回显的打码文本）时，逐层以磁盘对象为合并底、表单改动覆盖其上——provider 对象层表单不认识的字段
 * （customHeaders 等）、顶层表单不认识的键（defaultProfile 等）、profile 上手调的五件套旋钮
 * （temperature/maxTokens/timeoutMs/retries/stream）都随合并保留，不再被静默重建重置。customHeaders 的值是
 * 打码哨兵（键名保留、值不回显），PUT 时服务端 restoreMaskedCustomHeaders 还原磁盘真实值，哨兵绝不落盘；
 * 还原不了的条目服务端会进 warnings 如实告知。无 previousRawText / 文本非法 / 条目是新增 → 退化为旧的从零重建行为。
 */
export function buildModelSettingsConfig(
  savedProviders: readonly SavedProvider[],
  tasks: Record<string, string>,
  options?: {
    readonly chatHistoryBudgetTokens?: number | null;
    readonly previousRawText?: string | null;
  },
): Record<string, unknown> {
  const previous = parsePreviousConfig(options?.previousRawText);
  const providerMap: Record<string, unknown> = {};
  const seenProviders = new Set<string>();

  for (const prov of savedProviders) {
    const preset = PROVIDER_PRESETS.find((p) => p.id === prov.id);
    providerMap[prov.id] = {
      ...previous.providers[prov.id],
      id: prov.id,
      label: prov.label,
      type: preset?.type ?? "openai-compatible",
      baseUrl: prov.baseUrl,
      apiKeyEnv: prov.apiKeyEnv || preset?.apiKeyEnvSuggestion || undefined,
    };
    seenProviders.add(prov.id);
  }

  for (const val of Object.values(tasks)) {
    if (!val) continue;
    const [provId] = val.split("|");
    if (!provId || seenProviders.has(provId)) continue;
    seenProviders.add(provId);
    const preset = PROVIDER_PRESETS.find((p) => p.id === provId);
    if (preset) {
      providerMap[preset.id] = {
        ...previous.providers[preset.id],
        id: preset.id,
        label: preset.label,
        type: preset.type,
        baseUrl: preset.baseUrl,
        apiKeyEnv: preset.apiKeyEnvSuggestion || undefined,
      };
    }
  }

  const profileMap: Record<string, unknown> = {};
  const finalTasks: Record<string, string> = {};
  for (const [key, val] of Object.entries(tasks)) {
    if (!val) continue;
    const [provId, model] = val.split("|");
    if (!provId || !model) continue;
    const profId = taskProfileId(provId, model);
    if (!profileMap[profId]) {
      profileMap[profId] = {
        // 五件套默认打底；磁盘同 id profile 的手调值盖过默认（这几个旋钮表单不管理），
        // 表单管理的 id/label/provider/model 最后写死、永远以表单为准。
        temperature: 0.7,
        maxTokens: 4096,
        timeoutMs: 60000,
        retries: 2,
        stream: true,
        ...previous.profiles[profId],
        id: profId,
        label: model,
        provider: provId,
        model,
      };
    }
    finalTasks[key] = profId;
  }

  const defaultProvider = seenProviders.size > 0 ? [...seenProviders][0] : undefined;
  const budget = options?.chatHistoryBudgetTokens;
  // 顶层同样以磁盘对象为合并底（表单不认识的键随合并保留）；表单管理的键覆盖其上。
  // 服务商清空时磁盘残留的 defaultProvider 必须抹掉（指向已删服务商），不借合并复活。
  const config: Record<string, unknown> = {
    ...previous.top,
    version: 1,
    providers: providerMap,
    profiles: profileMap,
    taskProfiles: finalTasks,
  };
  if (defaultProvider) config.defaultProvider = defaultProvider;
  else delete config.defaultProvider;
  if (typeof budget === "number" && budget > 0) config.chatHistoryBudgetTokens = budget;
  return config;
}

interface PreviousConfig {
  /** 磁盘配置顶层对象整体：defaultProfile 等表单不认识的键的保留来源。 */
  readonly top: Record<string, unknown>;
  /** provider id → 磁盘上的 provider 对象。 */
  readonly providers: Record<string, Record<string, unknown>>;
  /** profile id → 磁盘上的 profile 对象：手调五件套旋钮的保留来源。 */
  readonly profiles: Record<string, Record<string, unknown>>;
}

/**
 * 从原始设置文本抽出合并底（顶层对象 + providers/profiles 两张 id 表），供 buildModelSettingsConfig
 * 逐层合并、保留表单不认识的字段。文本缺失/非法/结构不对 → 全空（调用方退化为从零重建，绝不因旧文本坏而炸表单保存）。
 */
function parsePreviousConfig(rawText: string | null | undefined): PreviousConfig {
  const empty: PreviousConfig = { top: {}, providers: {}, profiles: {} };
  if (!rawText?.trim()) return empty;
  try {
    const parsed = JSON.parse(rawText) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return empty;
    const top = parsed as Record<string, unknown>;
    return { top, providers: pickObjectMap(top.providers), profiles: pickObjectMap(top.profiles) };
  } catch {
    return empty;
  }
}

/** 只收「id → 对象」的纯对象层；数组/非标量条目丢弃。 */
function pickObjectMap(value: unknown): Record<string, Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, Record<string, unknown>> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      out[key] = entry as Record<string, unknown>;
    }
  }
  return out;
}

/**
 * 从 tasks（task→"provider|model"）+ thinking（task→bool）构造旁路 taskAssignments 载荷（task→{profileId?,thinking}）。
 * 遍历 tasks ∪ thinking 全部 key——**思考与模型两个旋钮独立**：没显式选模型、只关思考的任务也必须落盘
 * （治审查 important：纯切思考被静默丢弃）。有选模型才带 profileId（与 buildModelSettingsConfig 的 taskProfileId 同一套）。
 */
export function buildTaskAssignmentsPayload(
  tasks: Record<string, string>,
  thinking: Record<string, boolean>,
): TaskAssignmentView {
  const out: Record<string, { profileId?: string; thinking: boolean }> = {};
  const keys = new Set([...Object.keys(tasks), ...Object.keys(thinking)]);
  for (const task of keys) {
    const entry: { profileId?: string; thinking: boolean } = { thinking: thinking[task] ?? true };
    const val = tasks[task];
    if (val) {
      const [provId, model] = val.split("|");
      if (provId && model) entry.profileId = taskProfileId(provId, model);
    }
    out[task] = entry;
  }
  return out;
}

/**
 * 从 GET 返回的 taskAssignments 视图（task→{profileId,thinking}）+ profiles 反推面板状态：
 * tasks（task→"provider|model"，profileId 映射回 provider/model）与 thinking（task→bool）。
 * 视图缺失 → 返回空（调用方回退引擎 taskProfiles 解析、thinking 走默认开）。
 */
export function parseTaskViewState(
  taskAssignments: TaskAssignmentView | undefined,
  profiles: readonly ModelProfileSummary[],
): { tasks: Record<string, string>; thinking: Record<string, boolean> } {
  const tasks: Record<string, string> = {};
  const thinking: Record<string, boolean> = {};
  if (!taskAssignments) return { tasks, thinking };
  for (const [task, entry] of Object.entries(taskAssignments)) {
    thinking[task] = entry.thinking;
    const profile = profiles.find((p) => p?.id === entry.profileId);
    if (profile?.provider && profile.model) {
      tasks[task] = `${profile.provider}|${profile.model}`;
    }
  }
  return { tasks, thinking };
}
