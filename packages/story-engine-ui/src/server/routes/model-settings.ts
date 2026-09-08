/**
 * GET  /api/model-settings — load model settings.
 * PUT  /api/model-settings — save model settings.
 * POST /api/model-settings/test — test a provider connection.
 */
import { homedir } from "node:os";
import { mkdir, readFile } from "node:fs/promises";
import { validateModelSettingsV0 } from "@actalk/story-engine";
import type { ModelSettingsLoadResult } from "@actalk/story-engine";
import {
  commitFilesAtomically,
  readJsonBody,
  readString,
  readStringAllowEmpty,
  writeJson,
  isRecord,
  type AtomicFileEntry,
  type MiddlewareStack,
} from "../lib/project-io.js";
import {
  buildProviderRequestHeaders,
  getSavedProviderApiKey,
  globalStoryEngineDir,
  globalModelSecretsPath,
  globalModelSettingsPath,
  hasProviderApiKey,
  loadGlobalModelSettings,
  mergeProviderApiKeys,
  readModelSecrets,
  readProviderCustomHeaders,
  serializeModelSecrets,
} from "../lib/llm-client.js";
import { invalidateStoryAgent } from "../agent/story-agent.js";
import {
  buildTaskAssignmentsView,
  pickTaskAssignmentsFromBody,
  readTaskAssignments,
  taskAssignmentsPath,
  type TaskAssignmentsFile,
} from "../lib/task-assignments.js";

// ---------------------------------------------------------------------------
// Route registrar
// ---------------------------------------------------------------------------

export function registerModelSettingsRoutes(middlewares: MiddlewareStack): void {
  middlewares.use(async (req, res, next) => {
    if (!req.url?.startsWith("/api/model-settings")) {
      next();
      return;
    }

    try {
      if (req.method === "POST" && (req.url ?? "").includes("/test")) {
        await handleModelTest(req, res);
        return;
      }
      if (req.method === "GET") {
        const result = await loadModelSettingsWithSecretStatus();
        // 脱敏回显：customHeaders 值视同机密（与 apiKeyStatus 只出状态不出值同口径）——rawText 里打码后再出 API。
        const rawText = maskCustomHeadersInSettingsText(await readModelSettingsText(result.status));
        const { file: taFile } = await readTaskAssignments(homedir());
        const taskAssignments = buildTaskAssignmentsView(
          result.summary.taskProfiles as Record<string, string | undefined>,
          result.summary.defaultProfile,
          taFile,
        );
        writeJson(res, 200, { ok: true, result, rawText, taskAssignments });
        return;
      }

      if (req.method === "PUT") {
        const body = await readJsonBody(req);
        const rawText = readStringAllowEmpty(body.rawText);
        const providerApiKeys = readProviderApiKeys(body.providerApiKeys);
        if (rawText === undefined) {
          writeJson(res, 400, { ok: false, error: "模型设置内容不能为空。" });
          return;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(rawText) as unknown;
        } catch (error) {
          writeJson(res, 400, {
            ok: false,
            error: `JSON 格式错误：${error instanceof Error ? error.message : String(error)}`,
          });
          return;
        }

        // customHeaders 打码回显的逆操作：面板回传的打码哨兵先还原成磁盘上的真实值，再校验/落盘——
        // 哨兵绝不写进设置文件；无旧值可还原的打码条目直接丢弃（用户想改头值就得重新填明文）。
        restoreMaskedCustomHeaders(parsed, await readPreviousSettingsText());

        const validation = validateModelSettingsV0(parsed, {
          configPath: globalModelSettingsPath(),
        });
        const blockingIssue = validation.issues.find((issue) => issue.severity === "error" || issue.severity === "high");
        if (blockingIssue) {
          writeJson(res, 400, {
            ok: false,
            error: `模型设置未保存：${blockingIssue.message}`,
          });
          return;
        }

        // 任务分配（任务→{档案,思考}）存 UI 旁路 task-assignments.json（引擎零改）。无该字段则不写盘、保留现状。
        const taskAssignments = pickTaskAssignmentsFromBody(body);
        // 审查 #9：保存前交叉校验任务指定的 profileId 必须存在于本次配置的 profiles，否则明确报错、拒绝保存
        //（不再放行到运行时静默回退第一个 profile）。
        const invalidTask = taskAssignments ? findInvalidTaskProfile(taskAssignments, parsed) : null;
        if (invalidTask) {
          writeJson(res, 400, {
            ok: false,
            error: `模型设置未保存：任务「${invalidTask.task}」指定的模型档案「${invalidTask.profileId}」不在配置的 profiles 中。请重新为该任务选择模型。`,
          });
          return;
        }

        // 审查 #8：三文件（设置/密钥/任务分配）「全备齐再提交」，避免中途失败留下「新档案+旧 key+旧任务」混合态。
        // 密钥先按「坏 JSON/IO 错就抛、绝不当空」的严格读法合并，再统一原子提交。
        await mkdir(globalStoryEngineDir(), { recursive: true });
        const previousSettings = await loadGlobalModelSettings();
        const existingSecrets = await readModelSecrets();
        const mergedSecrets = mergeProviderApiKeys(existingSecrets.providerApiKeys, {
          providerApiKeys,
          activeProviderIds: readProviderIdsFromConfig(parsed),
        });
        // R1b：已存密钥绑定已存 origin。改了接口地址（协议+主机+端口）却没附带新密钥 → 丢掉旧密钥，
        // 避免「只改 baseUrl 再测连通」把旧 key 发到攻击者 URL。旧配置不可用则跳过，绝不误删。
        if (previousSettings.available) {
          const oldUrls = new Map(
            previousSettings.summary.providers.map((p) => [p.id, p.baseUrl] as const),
          );
          const newUrls = readProviderBaseUrlsFromConfig(parsed);
          for (const [id, newUrl] of newUrls) {
            const oldUrl = oldUrls.get(id);
            if (oldUrl === undefined) continue;
            if (!sameHttpOrigin(oldUrl, newUrl) && !providerApiKeys[id]) {
              delete mergedSecrets[id];
            }
          }
        }
        const entries: AtomicFileEntry[] = [
          { path: globalModelSettingsPath(), content: `${JSON.stringify(parsed, null, 2)}\n` },
          { path: globalModelSecretsPath(), content: serializeModelSecrets(mergedSecrets), mode: 0o600 },
        ];
        if (taskAssignments) {
          entries.push({ path: taskAssignmentsPath(homedir()), content: `${JSON.stringify(taskAssignments, null, 2)}\n` });
        }
        await commitFilesAtomically(entries);
        // M1：模型设置已落盘，让缓存的聊天 agent 失效——下一句聊天即用新模型/key/思考开关重建，不必重启服务。
        invalidateStoryAgent();
        const result = await loadModelSettingsWithSecretStatus();
        const savedText = maskCustomHeadersInSettingsText(await readModelSettingsText(result.status));
        const { file: taFile } = await readTaskAssignments(homedir());
        const savedAssignments = buildTaskAssignmentsView(
          result.summary.taskProfiles as Record<string, string | undefined>,
          result.summary.defaultProfile,
          taFile,
        );
        writeJson(res, 200, { ok: true, result, rawText: savedText, taskAssignments: savedAssignments });
        return;
      }

      writeJson(res, 405, { ok: false, error: "Only GET and PUT are supported." });
    } catch (error) {
      writeJson(res, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Provider test handler
// ---------------------------------------------------------------------------

// Provider 连通性测试的硬上限（审查 #1）：超时 / 响应体大小 / 模型数量，防挂死、防超大响应打爆内存。
const PROVIDER_TEST_TIMEOUT_MS = 15_000;
const PROVIDER_TEST_MAX_BYTES = 2 * 1024 * 1024;
const PROVIDER_TEST_MAX_MODELS = 500;

/** 只允许 http/https，且 URL 不得内嵌用户名/密码（防把凭据塞进 URL 外送）。非法返回 null。 */
function normalizeProviderTestUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  return url;
}

/** 协议 + 主机（含端口，host 大小写不敏感）一致：判断 inline baseUrl 是否就是某已存 provider 的 URL。 */
function sameHttpOrigin(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.protocol === ub.protocol && ua.host.toLowerCase() === ub.host.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Provider 连通性测试（审查 #1·安全重写；R1 防御纵深）。
 *
 * 旧实现的洞：接受客户端传的任意 `apiKeyEnv` → `process.env[apiKeyEnv]`，并把「任意已存 provider 的密钥」
 * 发到「客户端指定的任意 baseUrl」——等于可把任何进程环境变量 / 已存密钥外送到攻击者服务器。
 *
 * 新契约（密钥绝不外送到不匹配的 URL）：
 *  - 永远不按客户端给的 apiKeyEnv 读 process.env。
 *  - inline（未保存 provider）测试：只用「用户此刻输入的 apiKey」；未输入时，仅当 inline URL 恰为该
 *    providerId 已存 provider 的同源 URL，才复用其已存密钥；否则无密钥裸测（多半 401，诚实报错即可）。
 *    customHeaders（视同机密）同口径：仅同源时才随请求发出。
 *  - saved（已存 provider）测试：只用已存 provider 自己的 baseUrl + `getSavedProviderApiKey` + 其 customHeaders；**测试路径
 *    永不读 process.env**（R1a）。无已存密钥就裸测；若配了 apiKeyEnv 且裸测失败，错误信息提示去输入/
 *    先保存密钥（运行时聊天仍可经 resolveProviderApiKey 读 env，那是正式功能）。
 *  - PUT 保存：已存密钥绑定已存 origin（R1b）。同 provider id 的 baseUrl origin 变了、且本次未附带新
 *    密钥 → 删掉该 id 旧密钥（改接口地址须重输 key）。旧配置不可用则跳过比较，绝不误删。
 */
async function handleModelTest(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
  try {
    const body = await readJsonBody(req);
    const providerId = readString(body.providerId);
    const inlineBaseUrl = readString(body.baseUrl);
    const inlineApiKey = readString(body.apiKey);
    if (!providerId) {
      writeJson(res, 400, { ok: false, error: "Provider ID is required." });
      return;
    }

    if (inlineBaseUrl) {
      const target = normalizeProviderTestUrl(inlineBaseUrl);
      if (!target) {
        writeJson(res, 400, { ok: false, error: "接口地址无效：仅支持 http/https，且地址不能内嵌账号密码。" });
        return;
      }
      let apiKey = inlineApiKey?.trim() ?? "";
      // 已存密钥与 customHeaders 都绑定已存 origin：仅当 inline URL 恰是该 providerId 已存 provider 的同源 URL
      // 才复用它们，绝不把密钥/自定义头（视同机密）发到客户端指定的任意 URL。
      const settings = await loadGlobalModelSettings();
      const saved = settings.available ? settings.summary.providers.find((p) => p.id === providerId) : undefined;
      let customHeaders: Record<string, string> = {};
      if (saved && sameHttpOrigin(saved.baseUrl, target.toString())) {
        if (!apiKey) apiKey = await getSavedProviderApiKey(providerId);
        customHeaders = await readProviderCustomHeaders(providerId);
      }
      await runProviderTest(res, providerId, target.toString().replace(/\/+$/u, ""), apiKey, undefined, customHeaders);
      return;
    }

    // 已存 provider：用可信的服务端保存配置解析 URL；密钥只取已存库，不读 env（R1a）。
    const settings = await loadGlobalModelSettings();
    if (!settings.available) {
      writeJson(res, 400, { ok: false, error: "模型设置未加载或格式无效。" });
      return;
    }

    const provider = settings.summary.providers.find((p) => p.id === providerId);
    if (!provider) {
      writeJson(res, 400, { ok: false, error: "未找到指定的 Provider: " + providerId });
      return;
    }

    const target = normalizeProviderTestUrl(provider.baseUrl);
    if (!target) {
      writeJson(res, 400, { ok: false, error: "已保存的接口地址无效（仅支持 http/https）。请在设置中修正后重试。" });
      return;
    }
    const apiKey = await getSavedProviderApiKey(provider.id);
    const envKeyHint = !apiKey && provider.apiKeyEnv
      ? "出于安全，连通性测试不读取环境变量密钥；请在测试时输入 API Key，或先保存密钥再试。"
      : undefined;
    const customHeaders = await readProviderCustomHeaders(provider.id);

    await runProviderTest(res, providerId, target.toString().replace(/\/+$/u, ""), apiKey, envKeyHint, customHeaders);
  } catch (error) {
    writeJson(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** 流式读取响应体并封顶字节数：先看 Content-Length，再边读边累加，超限即取消并抛错。 */
async function readCappedText(response: globalThis.Response, maxBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`Provider 响应过大（>${Math.round(maxBytes / 1024 / 1024)}MB），已中止。`);
  }
  if (!response.body) return await response.text();
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`Provider 响应过大（>${Math.round(maxBytes / 1024 / 1024)}MB），已中止。`);
      }
      chunks.push(Buffer.from(value));
    }
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function runProviderTest(
  res: import("node:http").ServerResponse,
  providerId: string,
  baseUrl: string,
  apiKey: string,
  /** 无密钥裸测失败时追加的 UX 提示（R1a：测试路径不读 env）。 */
  bareTestHint?: string,
  /** 该 provider 已存配置里的自定义头（视同机密；opencode 会话头/UA 由 buildProviderRequestHeaders 自动附加）。 */
  customHeaders: Readonly<Record<string, string>> = {},
): Promise<void> {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_TEST_TIMEOUT_MS);
  let response: globalThis.Response;
  try {
    response = await fetch(baseUrl + "/models", {
      headers: await buildProviderRequestHeaders({ baseUrl, apiKey, customHeaders }),
      // 绝不跟随重定向：跟随会把 Authorization 头泄露给被重定向到的（可能是攻击者的）主机。
      redirect: "error",
      signal: controller.signal,
    });
  } catch (fetchError) {
    const aborted = controller.signal.aborted;
    clearTimeout(timeout);
    const base = aborted
      ? `连接 ${baseUrl} 超时（>${Math.round(PROVIDER_TEST_TIMEOUT_MS / 1000)}s），已中止。`
      : "无法连接 " + baseUrl + ": " + (fetchError instanceof Error ? fetchError.message : String(fetchError));
    writeJson(res, 200, {
      ok: false,
      error: !apiKey && bareTestHint ? `${base} ${bareTestHint}` : base,
    });
    return;
  }
  clearTimeout(timeout);

  const elapsedMs = Date.now() - started;

  if (!response.ok) {
    const errorBody = await readCappedText(response, PROVIDER_TEST_MAX_BYTES).catch(() => "");
    const base = "Provider 返回错误 HTTP " + response.status + (errorBody ? ": " + errorBody.slice(0, 200) : "");
    writeJson(res, 200, {
      ok: false,
      error: !apiKey && bareTestHint ? `${base} ${bareTestHint}` : base,
    });
    return;
  }

  let raw: string;
  try {
    raw = await readCappedText(response, PROVIDER_TEST_MAX_BYTES);
  } catch (error) {
    writeJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
    return;
  }
  let data: { data?: Array<{ id: string; name?: string }> };
  try {
    data = JSON.parse(raw) as { data?: Array<{ id: string; name?: string }> };
  } catch {
    writeJson(res, 200, { ok: false, error: "Provider 返回的不是有效 JSON。" });
    return;
  }
  const models = (data.data ?? []).slice(0, PROVIDER_TEST_MAX_MODELS).map((m) => ({ id: m.id, name: m.name }));

  writeJson(res, 200, {
    ok: true,
    result: { providerId, models, elapsedMs },
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** 回显打码哨兵：GET/PUT 响应里 customHeaders 的值一律换成它（值视同机密，绝不明文出 API/日志）。 */
export const MASKED_CUSTOM_HEADER_VALUE = "__STORY_ENGINE_MASKED__";

/**
 * 把设置文本里每个 provider 的 customHeaders 值替换成打码哨兵（键名保留、值绝不回显），再重新序列化。
 * 文本不是合法 JSON 时原样返回（校验层会另行报 JSON 错误；此时也无法定位需打码的字段）。
 */
export function maskCustomHeadersInSettingsText(rawText: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText) as unknown;
  } catch {
    return rawText;
  }
  if (!isRecord(parsed) || !isRecord(parsed.providers)) return rawText;
  let touched = false;
  for (const provider of Object.values(parsed.providers)) {
    if (!isRecord(provider) || !isRecord(provider.customHeaders)) continue;
    const masked: Record<string, string> = {};
    for (const name of Object.keys(provider.customHeaders)) {
      masked[name] = MASKED_CUSTOM_HEADER_VALUE;
    }
    provider.customHeaders = masked;
    touched = true;
  }
  return touched ? `${JSON.stringify(parsed, null, 2)}\n` : rawText;
}

/**
 * PUT 保存前把面板回传的打码哨兵还原成磁盘上的真实值（原地改 parsed，随后才走校验与落盘）：
 *  - 哨兵值 + 旧配置同 provider 同键有真实值 → 还原（用户没动这个头，原样保留）；
 *  - 哨兵值但无旧值可还原（新加的头/旧文件缺失损坏）→ 丢弃该条目，哨兵绝不落盘；
 *  - 丢完后 customHeaders 成空对象 → 整键删除。
 */
export function restoreMaskedCustomHeaders(parsed: unknown, previousRawText: string): void {
  if (!isRecord(parsed) || !isRecord(parsed.providers)) return;
  let previous: unknown;
  try {
    previous = JSON.parse(previousRawText) as unknown;
  } catch {
    previous = undefined;
  }
  const previousProviders = isRecord(previous) && isRecord(previous.providers) ? previous.providers : {};
  for (const [providerKey, provider] of Object.entries(parsed.providers)) {
    if (!isRecord(provider) || !isRecord(provider.customHeaders)) continue;
    const providerId = typeof provider.id === "string" && provider.id.trim() ? provider.id.trim() : providerKey;
    const previousProvider = previousProviders[providerId];
    const previousHeaders = isRecord(previousProvider) && isRecord(previousProvider.customHeaders) ? previousProvider.customHeaders : {};
    for (const [name, value] of Object.entries(provider.customHeaders)) {
      if (value !== MASKED_CUSTOM_HEADER_VALUE) continue;
      const old = previousHeaders[name];
      if (typeof old === "string") provider.customHeaders[name] = old;
      else delete provider.customHeaders[name];
    }
    if (Object.keys(provider.customHeaders).length === 0) delete provider.customHeaders;
  }
}

/** 读磁盘上当前设置原文（供打码还原）；文件不存在/读失败 → 空串（视为无旧值可还原）。 */
async function readPreviousSettingsText(): Promise<string> {
  try {
    return await readFile(globalModelSettingsPath(), "utf-8");
  } catch {
    return "";
  }
}

async function readModelSettingsText(status: ModelSettingsLoadResult["status"]): Promise<string> {
  if (status === "missing") return defaultModelSettingsText();
  try {
    return await readFile(globalModelSettingsPath(), "utf-8");
  } catch {
    return defaultModelSettingsText();
  }
}

function readProviderApiKeys(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const result: Record<string, string> = {};
  for (const [providerId, apiKey] of Object.entries(value)) {
    if (typeof apiKey === "string" && apiKey.trim()) {
      result[providerId] = apiKey;
    }
  }
  return result;
}

function readProviderIdsFromConfig(value: unknown): string[] {
  if (!isRecord(value) || !isRecord(value.providers)) return [];
  const ids: string[] = [];
  for (const [key, providerValue] of Object.entries(value.providers)) {
    if (isRecord(providerValue) && typeof providerValue.id === "string" && providerValue.id.trim()) {
      ids.push(providerValue.id.trim());
    } else {
      ids.push(key);
    }
  }
  return ids;
}

/** 从配置抽出 provider id → baseUrl（供 R1b origin 比较）。 */
function readProviderBaseUrlsFromConfig(value: unknown): Map<string, string> {
  const result = new Map<string, string>();
  if (!isRecord(value) || !isRecord(value.providers)) return result;
  for (const [key, providerValue] of Object.entries(value.providers)) {
    if (!isRecord(providerValue)) continue;
    const id =
      typeof providerValue.id === "string" && providerValue.id.trim()
        ? providerValue.id.trim()
        : key;
    if (typeof providerValue.baseUrl === "string" && providerValue.baseUrl.trim()) {
      result.set(id, providerValue.baseUrl.trim());
    }
  }
  return result;
}

/** 从配置对象抽出全部合法 profile id（键 + 各 profile.id）。用于校验任务分配引用的 profileId 是否存在。 */
export function readProfileIdsFromConfig(value: unknown): Set<string> {
  const ids = new Set<string>();
  if (!isRecord(value) || !isRecord(value.profiles)) return ids;
  for (const [key, profileValue] of Object.entries(value.profiles)) {
    if (key.trim()) ids.add(key.trim());
    if (isRecord(profileValue) && typeof profileValue.id === "string" && profileValue.id.trim()) {
      ids.add(profileValue.id.trim());
    }
  }
  return ids;
}

/** 返回第一个引用了不存在 profileId 的任务分配（审查 #9 保存前校验）；全部合法返回 null。 */
export function findInvalidTaskProfile(
  assignments: TaskAssignmentsFile,
  config: unknown,
): { readonly task: string; readonly profileId: string } | null {
  const validIds = readProfileIdsFromConfig(config);
  for (const [task, assignment] of Object.entries(assignments.tasks)) {
    const profileId = assignment.profileId;
    if (profileId && !validIds.has(profileId)) {
      return { task, profileId };
    }
  }
  return null;
}

async function loadModelSettingsWithSecretStatus(): Promise<ModelSettingsLoadResult> {
  const result = await loadGlobalModelSettings();
  const providers = await Promise.all(
    result.summary.providers.map(async (provider) => {
      if (provider.apiKeyStatus === "not_required") return provider;
      return {
        ...provider,
        apiKeyStatus: await hasProviderApiKey(provider) ? "present" as const : "missing" as const,
      };
    }),
  );
  return {
    ...result,
    summary: {
      ...result.summary,
      providers,
    },
  };
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
