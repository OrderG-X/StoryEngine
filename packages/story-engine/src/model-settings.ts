import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ModelProfile,
  ModelProfileSummary,
  ModelSettingsIssueSeverity,
  ModelSettingsLoadResult,
  ModelSettingsStatus,
  ModelSettingsSummary,
  ModelSettingsV0,
  ModelSettingsValidationIssue,
  ProviderConfig,
  ProviderConfigSummary,
  TaskProfileMap,
} from "./types.js";

export const MODEL_SETTINGS_RELATIVE_PATH = ".story-engine/model-settings.json";

const taskProfileKeys = ["fastDraft", "chapterSteering", "qualityCheck", "repair", "futureReview", "draftReview", "triage"] as const;

export async function loadModelSettingsV0(
  projectDir: string,
  options: { readonly env?: Record<string, string | undefined>; readonly configPath?: string } = {},
): Promise<ModelSettingsLoadResult> {
  // configPath 覆盖（UI 全局设置用它对齐 SE_DATA_DIR，治「写 A 读 B」单一真值源分裂）；
  // 省略时保持旧行为 = projectDir/.story-engine/model-settings.json，向后兼容按项目读法。
  const configPath = options.configPath ?? join(projectDir, MODEL_SETTINGS_RELATIVE_PATH);
  let rawText: string;
  try {
    rawText = await readFile(configPath, "utf-8");
  } catch (error) {
    if (isFileNotFound(error)) {
      return missingModelSettingsResult(configPath);
    }
    throw error;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(rawText) as unknown;
  } catch (error) {
    const issues = [issue("error", "invalid_json", "$", error instanceof Error ? error.message : String(error))];
    return resultFromRaw(configPath, "invalid_json", undefined, issues, options.env ?? process.env);
  }

  const issues = validateModelSettingsRaw(raw);
  const settings = issues.some((item) => item.code === "invalid_root" || item.code === "invalid_providers" || item.code === "invalid_profiles" || item.code === "invalid_task_profiles")
    ? undefined
    : raw as ModelSettingsV0;
  const status: ModelSettingsStatus = issues.length > 0 ? "invalid_schema" : "loaded";

  return resultFromRaw(configPath, status, settings, issues, options.env ?? process.env);
}

export function validateModelSettingsV0(
  settings: unknown,
  options: { readonly configPath?: string; readonly env?: Record<string, string | undefined> } = {},
): ModelSettingsLoadResult {
  const configPath = options.configPath ?? MODEL_SETTINGS_RELATIVE_PATH;
  const issues = validateModelSettingsRaw(settings);
  const typed = issues.some((item) => item.code === "invalid_root" || item.code === "invalid_providers" || item.code === "invalid_profiles" || item.code === "invalid_task_profiles")
    ? undefined
    : settings as ModelSettingsV0;
  return resultFromRaw(configPath, issues.length > 0 ? "invalid_schema" : "loaded", typed, issues, options.env ?? process.env);
}

function validateModelSettingsRaw(value: unknown): readonly ModelSettingsValidationIssue[] {
  const issues: ModelSettingsValidationIssue[] = [];
  issues.push(...findApiKeyFields(value));

  if (!isRecord(value)) {
    return [...issues, issue("error", "invalid_root", "$", "Model settings must be a JSON object.")];
  }

  if (value.version !== 1) {
    issues.push(issue("error", "invalid_version", "$.version", "Model settings version must be 1."));
  }
  if (!isRecord(value.providers)) {
    issues.push(issue("error", "invalid_providers", "$.providers", "providers must be an object keyed by provider id."));
  }
  if (!isRecord(value.profiles)) {
    issues.push(issue("error", "invalid_profiles", "$.profiles", "profiles must be an object keyed by profile id."));
  }
  if (!isRecord(value.taskProfiles)) {
    issues.push(issue("error", "invalid_task_profiles", "$.taskProfiles", "taskProfiles must be an object."));
  }

  const providerIds = isRecord(value.providers) ? Object.keys(value.providers) : [];
  const profileIds = isRecord(value.profiles) ? Object.keys(value.profiles) : [];

  if (typeof value.defaultProvider === "string" && !providerIds.includes(value.defaultProvider)) {
    issues.push(issue("error", "unknown_default_provider", "$.defaultProvider", `defaultProvider references unknown provider '${value.defaultProvider}'.`));
  }
  if (typeof value.defaultProfile === "string" && !profileIds.includes(value.defaultProfile)) {
    issues.push(issue("error", "unknown_default_profile", "$.defaultProfile", `defaultProfile references unknown profile '${value.defaultProfile}'.`));
  }

  if (isRecord(value.providers)) {
    for (const [providerId, provider] of Object.entries(value.providers)) {
      issues.push(...validateProvider(providerId, provider));
    }
  }
  if (isRecord(value.profiles)) {
    for (const [profileId, profile] of Object.entries(value.profiles)) {
      issues.push(...validateProfile(profileId, profile, providerIds));
    }
  }
  if (isRecord(value.taskProfiles)) {
    issues.push(...validateTaskProfiles(value.taskProfiles, profileIds));
  }

  return issues;
}

function validateProvider(providerId: string, value: unknown): readonly ModelSettingsValidationIssue[] {
  if (!isRecord(value)) {
    return [issue("error", "invalid_provider", `$.providers.${providerId}`, "Provider config must be an object.")];
  }
  const issues: ModelSettingsValidationIssue[] = [];
  if (value.id !== providerId) {
    issues.push(issue("error", "provider_id_mismatch", `$.providers.${providerId}.id`, "Provider id must exist and match its providers key."));
  }
  if (!isProviderType(value.type)) {
    issues.push(issue("error", "invalid_provider_type", `$.providers.${providerId}.type`, "Provider type must be openai-compatible, openai, local, or custom."));
  }
  if (typeof value.baseUrl !== "string" || value.baseUrl.trim() === "") {
    issues.push(issue("error", "invalid_provider_base_url", `$.providers.${providerId}.baseUrl`, "Provider baseUrl must be a non-empty string."));
  }
  if (value.apiKeyEnv !== undefined && (typeof value.apiKeyEnv !== "string" || value.apiKeyEnv.trim() === "")) {
    issues.push(issue("error", "invalid_api_key_env", `$.providers.${providerId}.apiKeyEnv`, "apiKeyEnv must be a non-empty string when provided."));
  }
  if (value.customHeaders !== undefined) {
    if (!isRecord(value.customHeaders)) {
      issues.push(issue("error", "invalid_custom_headers", `$.providers.${providerId}.customHeaders`, "customHeaders must be an object mapping header names to string values."));
    } else {
      for (const [headerName, headerValue] of Object.entries(value.customHeaders)) {
        if (!headerName.trim()) {
          issues.push(issue("error", "invalid_custom_header_name", `$.providers.${providerId}.customHeaders`, "customHeaders header names must be non-empty strings."));
        }
        if (typeof headerValue !== "string") {
          // 消息只带键名不带值——customHeaders 值视同机密，绝不进 issues/日志。
          issues.push(issue("error", "invalid_custom_header_value", `$.providers.${providerId}.customHeaders.${headerName}`, "customHeaders values must be strings."));
        }
      }
    }
  }
  return issues;
}

function validateProfile(profileId: string, value: unknown, providerIds: readonly string[]): readonly ModelSettingsValidationIssue[] {
  if (!isRecord(value)) {
    return [issue("error", "invalid_profile", `$.profiles.${profileId}`, "Model profile must be an object.")];
  }
  const issues: ModelSettingsValidationIssue[] = [];
  if (value.id !== profileId) {
    issues.push(issue("error", "profile_id_mismatch", `$.profiles.${profileId}.id`, "Profile id must exist and match its profiles key."));
  }
  if (typeof value.provider !== "string" || value.provider.trim() === "") {
    issues.push(issue("error", "missing_profile_provider", `$.profiles.${profileId}.provider`, "Profile provider must be a non-empty string."));
  } else if (!providerIds.includes(value.provider)) {
    issues.push(issue("error", "unknown_profile_provider", `$.profiles.${profileId}.provider`, `Profile references unknown provider '${value.provider}'.`));
  }
  if (typeof value.model !== "string" || value.model.trim() === "") {
    issues.push(issue("error", "invalid_profile_model", `$.profiles.${profileId}.model`, "Profile model must be a non-empty string."));
  }
  if (value.temperature !== undefined && typeof value.temperature !== "number") {
    issues.push(issue("error", "invalid_temperature", `$.profiles.${profileId}.temperature`, "temperature must be a number when provided."));
  }
  if (value.maxTokens !== undefined && !isPositiveInteger(value.maxTokens)) {
    issues.push(issue("error", "invalid_max_tokens", `$.profiles.${profileId}.maxTokens`, "maxTokens must be a positive integer when provided."));
  }
  if (value.timeoutMs !== undefined && !isPositiveInteger(value.timeoutMs)) {
    issues.push(issue("error", "invalid_timeout_ms", `$.profiles.${profileId}.timeoutMs`, "timeoutMs must be a positive integer when provided."));
  }
  if (value.retries !== undefined && !isNonNegativeInteger(value.retries)) {
    issues.push(issue("error", "invalid_retries", `$.profiles.${profileId}.retries`, "retries must be a non-negative integer when provided."));
  }
  if (value.stream !== undefined && typeof value.stream !== "boolean") {
    issues.push(issue("error", "invalid_stream", `$.profiles.${profileId}.stream`, "stream must be a boolean when provided."));
  }
  return issues;
}

function validateTaskProfiles(value: Record<string, unknown>, profileIds: readonly string[]): readonly ModelSettingsValidationIssue[] {
  const issues: ModelSettingsValidationIssue[] = [];
  for (const [taskName, profileId] of Object.entries(value)) {
    if (!taskProfileKeys.includes(taskName as (typeof taskProfileKeys)[number])) {
      issues.push(issue("warning", "unknown_task_profile", `$.taskProfiles.${taskName}`, `Unknown task profile key '${taskName}' will be ignored by V0.`));
      continue;
    }
    if (typeof profileId !== "string" || profileId.trim() === "") {
      issues.push(issue("error", "invalid_task_profile", `$.taskProfiles.${taskName}`, "Task profile value must be a non-empty profile id."));
    } else if (!profileIds.includes(profileId)) {
      issues.push(issue("error", "unknown_task_profile_reference", `$.taskProfiles.${taskName}`, `Task profile references unknown profile '${profileId}'.`));
    }
  }
  return issues;
}

function resultFromRaw(
  configPath: string,
  status: ModelSettingsStatus,
  settings: ModelSettingsV0 | undefined,
  issues: readonly ModelSettingsValidationIssue[],
  env: Record<string, string | undefined>,
): ModelSettingsLoadResult {
  const summary = buildModelSettingsSummary(configPath, status, settings, issues, env);
  return {
    passed: status === "missing" || issues.every((item) => item.severity !== "error" && item.severity !== "high"),
    available: status === "loaded" || status === "invalid_schema",
    status,
    configPath,
    summary,
    issues,
  };
}

function missingModelSettingsResult(configPath: string): ModelSettingsLoadResult {
  const summary: ModelSettingsSummary = {
    available: false,
    status: "missing",
    configPath,
    providers: [],
    profiles: [],
    taskProfiles: {},
    issueCount: 0,
    highRiskIssueCount: 0,
  };
  return {
    passed: true,
    available: false,
    status: "missing",
    configPath,
    summary,
    issues: [],
  };
}

function buildModelSettingsSummary(
  configPath: string,
  status: ModelSettingsStatus,
  settings: ModelSettingsV0 | undefined,
  issues: readonly ModelSettingsValidationIssue[],
  env: Record<string, string | undefined>,
): ModelSettingsSummary {
  return {
    available: settings !== undefined,
    status,
    configPath,
    ...(settings?.defaultProvider !== undefined ? { defaultProvider: settings.defaultProvider } : {}),
    ...(settings?.defaultProfile !== undefined ? { defaultProfile: settings.defaultProfile } : {}),
    providers: settings ? Object.values(settings.providers).map((provider) => summarizeProvider(provider, env)) : [],
    profiles: settings ? Object.values(settings.profiles).map(summarizeProfile) : [],
    taskProfiles: settings?.taskProfiles ?? {},
    issueCount: issues.length,
    highRiskIssueCount: issues.filter((item) => item.severity === "high").length,
  };
}

function summarizeProvider(provider: ProviderConfig, env: Record<string, string | undefined>): ProviderConfigSummary {
  // 脱敏（customHeaders 值视同机密，与 apiKeyStatus 只出状态不出值同口径）：summary 只回键名列表。
  const customHeaderNames = provider.customHeaders ? Object.keys(provider.customHeaders) : [];
  return {
    id: provider.id,
    ...(provider.label !== undefined ? { label: provider.label } : {}),
    type: provider.type,
    baseUrl: provider.baseUrl,
    ...(provider.apiKeyEnv !== undefined ? { apiKeyEnv: provider.apiKeyEnv } : {}),
    apiKeyStatus: provider.apiKeyEnv === undefined ? "not_required" : env[provider.apiKeyEnv] ? "present" : "missing",
    ...(customHeaderNames.length > 0 ? { customHeaderNames } : {}),
  };
}

function summarizeProfile(profile: ModelProfile): ModelProfileSummary {
  return {
    id: profile.id,
    ...(profile.label !== undefined ? { label: profile.label } : {}),
    provider: profile.provider,
    model: profile.model,
    ...(profile.temperature !== undefined ? { temperature: profile.temperature } : {}),
    ...(profile.maxTokens !== undefined ? { maxTokens: profile.maxTokens } : {}),
    ...(profile.timeoutMs !== undefined ? { timeoutMs: profile.timeoutMs } : {}),
    ...(profile.retries !== undefined ? { retries: profile.retries } : {}),
    ...(profile.stream !== undefined ? { stream: profile.stream } : {}),
  };
}

function findApiKeyFields(value: unknown, path = "$"): readonly ModelSettingsValidationIssue[] {
  if (!isRecord(value) && !Array.isArray(value)) return [];
  const issues: ModelSettingsValidationIssue[] = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      issues.push(...findApiKeyFields(item, `${path}[${index}]`));
    });
    return issues;
  }
  for (const [key, nested] of Object.entries(value)) {
    const nestedPath = `${path}.${key}`;
    if (key.toLowerCase() === "apikey" || key.toLowerCase() === "api_key") {
      issues.push(issue("high", "plaintext_api_key", nestedPath, "Plaintext apiKey fields are not allowed. Use apiKeyEnv instead."));
    }
    issues.push(...findApiKeyFields(nested, nestedPath));
  }
  return issues;
}

function issue(
  severity: ModelSettingsIssueSeverity,
  code: string,
  path: string,
  message: string,
): ModelSettingsValidationIssue {
  return { severity, code, path, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProviderType(value: unknown): value is ProviderConfig["type"] {
  return value === "openai-compatible" || value === "openai" || value === "local" || value === "custom";
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function isFileNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
