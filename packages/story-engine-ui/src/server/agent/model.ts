import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

import {
  bodyRequestsThinkingOff,
  buildProviderRequestHeaders,
  isAlwaysOnThinkingModel,
  isThinkingCannotBeDisabledError,
  learnAlwaysOnThinkingModel,
  omitThinkingParams,
  resolveConfiguredChatModel,
  type ModelTaskProfileKey,
  type ResolvedChatModel,
} from "../lib/llm-client.js";
import { thinkingRequestParams, type ThinkingDialect } from "../lib/model-capabilities.js";
import { modelNeedsMfjs, sanitizeRequestToolSchemas } from "../lib/strict-tool-schema.js";

/** 从 fetch 入参抠请求 URL 的 host（能力键的一半；string/URL/Request 三种形态都接，抠不出 → ""）。 */
function requestHost(input: RequestInfo | URL): string {
  try {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * 上游 400「思考不可关」→ 省略思考参数重试一次（让模型用自身默认），重试成功即学习落盘（llm-client 能力库）。
 * 仅当本次请求体真带了「关思考」信号（disabled / enable_thinking:false）且 400 文案命中 cannot-be-disabled
 * 特征才动手；其他响应（含其他 400）原样返回给 AI SDK 自己报错，绝不吞错。
 */
async function maybeRetryWithoutThinking(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  modelId: string,
  baseFetch: typeof fetch,
  response: Response,
): Promise<Response> {
  if (response.ok || !init || typeof init.body !== "string") return response;
  let sent: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(init.body);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return response;
    sent = parsed as Record<string, unknown>;
  } catch {
    return response;
  }
  if (!bodyRequestsThinkingOff(sent)) return response;
  // clone 读错误原文：不消费原响应——判不中时 SDK 仍拿到完整 400 自行报错。
  const errorText = await response.clone().text().catch(() => "");
  if (!isThinkingCannotBeDisabledError(response.status, errorText)) return response;
  const host = requestHost(input);
  console.warn(
    `[model-capabilities] 模型「${modelId}」${host ? `@${host}` : ""} 拒绝关闭思考（400：${errorText.slice(0, 200)}）。` +
      "agent 路已省略思考参数重试一次（让模型用自身默认）；重试成功即记住该模型，之后直接跳过 disabled 注入。",
  );
  const retryResponse = await baseFetch(input, { ...init, body: JSON.stringify(omitThinkingParams(sent)) });
  if (retryResponse.ok && host) await learnAlwaysOnThinkingModel(host, modelId);
  return retryResponse;
}

/**
 * 工厂：生成 Mastra agent 出站请求的 fetch 包装器，做三件**请求侧模型无关**的改造（R7/R8/always-on 自适应）：
 * 1. **思考方言注入**（R7）：按「用户思考开关 × 模型方言」注入——GLM 发 `thinking:{type}`、Qwen 发 `enable_thinking`、
 *    认不出的整键不发（换 Kimi/Qwen 不因这个参数 400）。agent 走流式，故 stream:true；该方言键已显式设过则不覆盖。
 *    always-on 自适应：已学到「不可关思考」的模型要关思考时整键省略（再发 disabled 必 400，不再付学费）；
 *    用户显式开思考照发不误（手动配置优先，不硬编码 enabled）。
 * 2. **工具 schema MFJS 改造**（R8）：仅当模型是 Kimi/Moonshot 系时，把 `tools[].function.parameters` 改造成 MFJS 合规
 *    （补全每个节点的 type + 剥掉 minimum/maxLength 等不支持的校验关键字），否则真 Moonshot 拒整批工具。
 *    只对 Kimi/Moonshot 启用——别的模型 schema 原样不动、零影响。见 strict-tool-schema.ts。
 * 3. **always-on 思考 400 重试**：上游 400 明说「cannot be disabled」（真机 glm-5.3-flash）时省略思考参数重试一次，
 *    成功即学习落盘（之后第 1 步直接跳过注入）。只认这一个错误，其他 400 原样还给 SDK。
 * **任何解析异常都原样放行**——绝不因这几步挡住聊天。baseFetch 可注入便于单测。
 * extraHeaders（可选）：每请求追加的出站头（opencode 会话头/自定义头，由 buildProviderRequestHeaders 组装），
 * 经 Headers.set 覆盖同名头——opencode 网关缺 x-opencode-session 会直接 400（MissingSessionID），agent 路也必须带。
 */
export function makeAgentRequestFetch(
  thinking: boolean,
  dialect: ThinkingDialect,
  modelId: string,
  baseFetch: typeof fetch = fetch,
  extraHeaders?: Readonly<Record<string, string>>,
): typeof fetch {
  return async (input, init) => {
    if (init && typeof init.body === "string") {
      try {
        const parsed = JSON.parse(init.body) as Record<string, unknown>;
        let next = parsed;
        // 1. 思考方言注入（仅带 messages 的请求；该方言键未显式设过时；已学 always-on 且要关思考 → 整键省略）
        if (Array.isArray(parsed.messages)) {
          const host = requestHost(input);
          const learnedAlwaysOn =
            !thinking && dialect !== "none" && host !== "" && (await isAlwaysOnThinkingModel(host, modelId));
          const params = learnedAlwaysOn ? {} : thinkingRequestParams({ dialect, thinking, stream: true });
          const keys = Object.keys(params);
          if (keys.length > 0 && keys.every((k) => parsed[k] === undefined)) next = { ...next, ...params };
        }
        // 2. 工具 schema MFJS 改造（仅 Kimi/Moonshot；带 tools 才动）
        if (modelNeedsMfjs(modelId)) next = sanitizeRequestToolSchemas(next);
        if (next !== parsed) init = { ...init, body: JSON.stringify(next) };
      } catch { /* 非 JSON / 解析失败：原样放行 */ }
    }
    if (extraHeaders && Object.keys(extraHeaders).length > 0) {
      const headers = new Headers(init?.headers);
      for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value);
      init = { ...init, headers };
    }
    // 3. 先发请求；命中 always-on 400 才省略思考参数重试一次
    const response = await baseFetch(input, init);
    return maybeRetryWithoutThinking(input, init, modelId, baseFetch, response);
  };
}

/**
 * 把现有的 GLM 配置（~/.story-engine 的 model-settings + model-secrets，经 resolveConfiguredChatModel
 * 解析）包装成一个 AI SDK 的 OpenAI 兼容 LanguageModel，喂给 Mastra Agent 的 model 字段。
 *
 * 关键：**完全复用现有 key/baseUrl 解析**，不另搞一套 key 管理（plan 硬约束③）。
 * baseUrl 末尾斜杠归一，与 llm-client.ts 的现有行为保持一致（SDK 自己拼 /chat/completions）。
 */
export async function resolveGlmModel(task: ModelTaskProfileKey): Promise<{
  readonly model: ReturnType<ReturnType<typeof createOpenAICompatible>>;
  readonly profile: ResolvedChatModel["profile"];
}> {
  const { provider, profile, apiKey, thinking, thinkingDialect, customHeaders } = await resolveConfiguredChatModel(task);
  const baseURL = provider.baseUrl.replace(/\/+$/u, "");
  const outboundHeaders = await buildProviderRequestHeaders({ baseUrl: provider.baseUrl, customHeaders });
  const openaiCompatible = createOpenAICompatible({
    name: provider.id,
    baseURL,
    apiKey,
    fetch: makeAgentRequestFetch(thinking, thinkingDialect, profile.model, fetch, outboundHeaders),
  });
  return { model: openaiCompatible(profile.model), profile };
}
