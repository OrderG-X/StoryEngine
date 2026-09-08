import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

import { buildProviderRequestHeaders, resolveConfiguredChatModel, type ModelTaskProfileKey, type ResolvedChatModel } from "../lib/llm-client.js";
import { thinkingRequestParams, type ThinkingDialect } from "../lib/model-capabilities.js";
import { modelNeedsMfjs, sanitizeRequestToolSchemas } from "../lib/strict-tool-schema.js";

/**
 * 把现有的 GLM 配置（~/.story-engine 的 model-settings + model-secrets，经 resolveConfiguredChatModel
 * 解析）包装成一个 AI SDK 的 OpenAI 兼容 LanguageModel，喂给 Mastra Agent 的 model 字段。
 *
 * 关键：**完全复用现有 key/baseUrl 解析**，不另搞一套 key 管理（plan 硬约束③）。
 * baseUrl 末尾斜杠归一，与 llm-client.ts:162 的现有行为保持一致（SDK 自己拼 /chat/completions）。
 */
/**
 * 工厂：生成 Mastra agent 出站请求的 fetch 包装器，做两件**请求侧模型无关**的改造（R7/R8）：
 * 1. **思考方言注入**（R7）：按「用户思考开关 × 模型方言」注入——GLM 发 `thinking:{type}`、Qwen 发 `enable_thinking`、
 *    认不出的整键不发（换 Kimi/Qwen 不因这个参数 400）。agent 走流式，故 stream:true；该方言键已显式设过则不覆盖。
 * 2. **工具 schema MFJS 改造**（R8）：仅当模型是 Kimi/Moonshot 系时，把 `tools[].function.parameters` 改造成 MFJS 合规
 *    （补全每个节点的 type + 剥掉 minimum/maxLength 等不支持的校验关键字），否则真 Moonshot 拒整批工具。
 *    只对 Kimi/Moonshot 启用——别的模型 schema 原样不动、零影响。见 strict-tool-schema.ts。
 * **任何解析异常都原样放行**——绝不因这两步挡住聊天。baseFetch 可注入便于单测。
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
  return (input, init) => {
    if (init && typeof init.body === "string") {
      try {
        const parsed = JSON.parse(init.body) as Record<string, unknown>;
        let next = parsed;
        // 1. 思考方言注入（仅带 messages 的请求；该方言键未显式设过时）
        if (Array.isArray(parsed.messages)) {
          const params = thinkingRequestParams({ dialect, thinking, stream: true });
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
    return baseFetch(input, init);
  };
}

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
