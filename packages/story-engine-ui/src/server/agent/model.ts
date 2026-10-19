import { providerGate } from "../lib/provider-gate.js";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

import {
  bodyRequestsThinkingOff,
  buildProviderRequestHeaders,
  fallbackNotice,
  isAlwaysOnThinkingModel,
  isThinkingCannotBeDisabledError,
  learnAlwaysOnThinkingModel,
  omitThinkingParams,
  resolveConfiguredChatModel,
  STREAM_IDLE_TIMEOUT_MS,
  type ModelTaskProfileKey,
  type ResolvedChatModel,
} from "../lib/llm-client.js";
import { thinkingRequestParams, type ThinkingDialect } from "../lib/model-capabilities.js";
import { recordAgentFallback, recordTurnNotice } from "../lib/token-meter.js";
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
/**
 * 主对话请求的「上游没反应」防线（2026-10-08 十章验收第三轮）：服务商临时故障时，请求发出去一直等不到响应头，
 * 底层默认 5 分钟才判死，而且不重试——第 4 章起每次都白等 5 分钟、连报「AI 服务暂时没响应」。
 * 守空闲超时铁律（只判「彻底静默」，不设总时长）：
 *  - 响应头迟迟不来（彻底静默 idleMs）→ 掐掉，自动重发一次（还没开始生成，重发不会重复做事）；
 *  - 已开始流式后彻底静默 idleMs → 掐断流、如实报错（流到一半无法安全重发，交给作者点重试）。
 * 模型还在吐字节（含思考 token）就一直续命，长回合不受影响。
 */
export function withUpstreamSilenceGuard(
  baseFetch: typeof fetch,
  idleMs: number = STREAM_IDLE_TIMEOUT_MS,
  retries = 1,
): typeof fetch {
  return async (input, init) => {
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const callerSignal = init?.signal ?? undefined;
      if (callerSignal?.aborted) throw callerSignal.reason ?? new Error("aborted");
      const controller = new AbortController();
      const onCallerAbort = () => controller.abort(callerSignal?.reason);
      callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
      let silent = false;
      let timer = setTimeout(() => { silent = true; controller.abort(new Error(`上游 ${Math.round(idleMs / 1000)} 秒没有任何响应`)); }, idleMs);
      const unref = (t: ReturnType<typeof setTimeout>) => (t as unknown as { unref?: () => void }).unref?.();
      unref(timer);
      try {
        const response = await baseFetch(input, { ...init, signal: controller.signal });
        clearTimeout(timer);
        if (!response.body) {
          callerSignal?.removeEventListener("abort", onCallerAbort);
          return response;
        }
        // 流式阶段：每来一块就续命；彻底静默 idleMs 才掐断（连同下游流一起报错，不依赖底层是否响应 abort）。
        const reader = response.body.getReader();
        let output: ReadableStreamDefaultController<Uint8Array> | undefined;
        const kick = () => {
          clearTimeout(timer);
          timer = setTimeout(() => {
            const stalled = new Error(`上游流式输出中断：${Math.round(idleMs / 1000)} 秒没有新内容`);
            controller.abort(stalled);
            reader.cancel(stalled).catch(() => undefined);
            try { output?.error(stalled); } catch { /* 已关闭 */ }
          }, idleMs);
          unref(timer);
        };
        kick();
        const body = new ReadableStream<Uint8Array>({
          start(streamController) {
            output = streamController;
          },
          async pull(streamController) {
            try {
              const { done, value } = await reader.read();
              if (done) {
                clearTimeout(timer);
                callerSignal?.removeEventListener("abort", onCallerAbort);
                streamController.close();
                return;
              }
              kick();
              streamController.enqueue(value);
            } catch (error) {
              clearTimeout(timer);
              callerSignal?.removeEventListener("abort", onCallerAbort);
              streamController.error(error);
            }
          },
          cancel(reason) {
            clearTimeout(timer);
            callerSignal?.removeEventListener("abort", onCallerAbort);
            return reader.cancel(reason);
          },
        });
        return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
      } catch (error) {
        clearTimeout(timer);
        callerSignal?.removeEventListener("abort", onCallerAbort);
        lastError = error;
        // 作者自己停了 → 不重发；上游静默 / 连接级错误（还没拿到响应）→ 重发一次。
        if (callerSignal?.aborted) throw error;
        if (!silent && !isConnectionLevelError(error)) throw error;
        console.warn(`[agent-upstream] 第 ${attempt + 1} 次请求${silent ? `等了 ${Math.round(idleMs / 1000)} 秒没有响应` : `连接失败（${String((error as Error)?.message ?? error).slice(0, 120)}）`}${attempt < retries ? "，自动重发一次" : ""}`);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  };
}

/** 还没拿到响应就失败的连接级错误（断连、拒连、DNS、重置）：可以安全重发。 */
function isConnectionLevelError(error: unknown): boolean {
  const text = `${(error as { code?: string })?.code ?? ""} ${(error as Error)?.message ?? ""} ${((error as { cause?: { code?: string } })?.cause?.code) ?? ""}`;
  return /UND_ERR_(?:SOCKET|CONNECT_TIMEOUT|HEADERS_TIMEOUT)|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up/iu.test(text);
}

/**
 * 对话 AI「光想不动」上限（2026-10-10 真机验收：记三个人物，它用英文来回纠结了 2.7 万字思考、5 分钟、19.6 万 token 才动手）。
 * 用户开着思考就照开；只是一次请求从发出起这么久还没开始回答、也没调工具（只在吐思考），就掐掉，
 * 关思考重发一次，新回答接在同一条流后面（已经吐出的思考留着）。不是总时长上限：一开始回答就不再计时。
 */
export const AGENT_THINKING_CAP_MS = 90_000;

/** SSE 一帧里有没有正文或工具调用（只有思考的不算）。 */
function frameAnswers(frame: string): boolean {
  for (const line of frame.split("\n")) {
    const data = line.startsWith("data:") ? line.slice(5).trim() : "";
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data) as { choices?: { delta?: { content?: unknown; tool_calls?: unknown } }[] };
      const delta = parsed.choices?.[0]?.delta;
      if ((typeof delta?.content === "string" && delta.content.length > 0) || (Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0)) return true;
    } catch { /* 半截或非 JSON：不算 */ }
  }
  return false;
}

export function withThinkingCap(
  baseFetch: typeof fetch,
  makeThinkingOffInit: (init: RequestInit) => RequestInit,
  capMs: number = AGENT_THINKING_CAP_MS,
): typeof fetch {
  return async (input, init) => {
    const callerSignal = init?.signal ?? undefined;
    const first = new AbortController();
    const onCallerAbort = () => first.abort(callerSignal?.reason);
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    const response = await baseFetch(input, { ...init, signal: first.signal });
    if (!response.ok || !response.body) {
      callerSignal?.removeEventListener("abort", onCallerAbort);
      return response;
    }
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let reader = response.body.getReader();
    let answered = false;
    let switched = false;
    let pending = "";
    let capFired = false;
    const timer = setTimeout(() => { capFired = true; }, capMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    const done = () => { clearTimeout(timer); callerSignal?.removeEventListener("abort", onCallerAbort); };
    const switchToThinkingOff = async (): Promise<void> => {
      switched = true;
      pending = ""; // 没收完的半帧丢掉，保证下游拿到的都是完整的帧
      await reader.cancel(new Error("思考超时，改用不思考重发")).catch(() => undefined);
      first.abort(new Error("思考超时"));
      console.warn(`[agent-thinking] 对话 AI 思考 ${Math.round(capMs / 1000)} 秒还没开始回答，关思考重发一次`);
      const retry = await baseFetch(input, { ...makeThinkingOffInit(init ?? {}), ...(callerSignal ? { signal: callerSignal } : {}) });
      if (!retry.ok || !retry.body) throw new Error(`关思考重发失败：${retry.status}`);
      reader = retry.body.getReader();
      answered = true; // 重发的这条照单全收
    };
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          for (;;) {
            if (!answered && !switched && capFired) await switchToThinkingOff();
            const { done: finished, value } = await reader.read();
            if (finished) {
              if (pending) controller.enqueue(encoder.encode(pending));
              pending = "";
              done();
              controller.close();
              return;
            }
            if (answered) {
              controller.enqueue(value);
              return;
            }
            // 还没开始回答：按整帧往下游送（切换时不会留下半帧），顺便看这帧是不是开始回答了。
            pending += decoder.decode(value, { stream: true });
            const cut = pending.lastIndexOf("\n\n");
            if (cut < 0) continue;
            const frames = pending.slice(0, cut + 2);
            pending = pending.slice(cut + 2);
            if (frameAnswers(frames)) {
              answered = true;
              clearTimeout(timer);
            }
            controller.enqueue(encoder.encode(frames));
            return;
          }
        } catch (error) {
          done();
          controller.error(error);
        }
      },
      cancel(reason) {
        done();
        return reader.cancel(reason);
      },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

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
    // 3. 先发请求；命中 always-on 400 才省略思考参数重试一次。开着思考的流式请求加「光想不动」上限。
    const sendBody = typeof init?.body === "string" ? init.body : "";
    const capped = thinking && dialect !== "none" && /"stream"\s*:\s*true/u.test(sendBody) && /"messages"\s*:/u.test(sendBody)
      ? withThinkingCap(baseFetch, (original) => {
        try {
          const parsed = JSON.parse(String(original.body)) as Record<string, unknown>;
          return { ...original, body: JSON.stringify({ ...parsed, ...thinkingRequestParams({ dialect, thinking: false, stream: true }) }) };
        } catch {
          return original;
        }
      })
      : baseFetch;
    const response = await capped(input, init);
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
  readonly provider: ResolvedChatModel["provider"];
}> {
  const configured = await resolveConfiguredChatModel(task);
  const { provider, profile, apiKey, thinking, fallback } = configured;
  const baseURL = provider.baseUrl.replace(/\/+$/u, "");
  const primaryFetch = await buildAgentModelFetch(configured, thinking);
  const openaiCompatible = createOpenAICompatible({
    name: provider.id,
    baseURL,
    apiKey,
    // 流式末帧带真实用量（对话 AI 每轮记 token，见 lib/token-meter）。
    includeUsage: true,
    fetch: fallback
      ? withModelFallback(primaryFetch, {
        fetch: await buildAgentModelFetch(fallback, thinking),
        fromBaseURL: baseURL,
        toBaseURL: fallback.provider.baseUrl.replace(/\/+$/u, ""),
        apiKey: fallback.apiKey,
        modelId: fallback.profile.model,
        provider: fallback.provider.id,
        ...(fallback.provider.label ? { providerLabel: fallback.provider.label } : {}),
        notice: fallbackNotice(configured, fallback),
      })
      : primaryFetch,
  });
  return { model: openaiCompatible(profile.model), profile, provider };
}

/** 一个模型的整条请求链：思考方言 / 工具 schema 改造 → 限流闸 → 上游静默防线。 */
async function buildAgentModelFetch(configured: ResolvedChatModel, thinking: boolean): Promise<typeof fetch> {
  const outboundHeaders = await buildProviderRequestHeaders({ baseUrl: configured.provider.baseUrl, customHeaders: configured.customHeaders });
  return makeAgentRequestFetch(thinking, configured.thinkingDialect, configured.profile.model, providerGate.wrap(withUpstreamSilenceGuard(fetch)), outboundHeaders);
}

export interface AgentModelFallback {
  /** 备用模型自己的整条请求链（方言、限流、静默防线都按它来）。 */
  readonly fetch: typeof fetch;
  /** 主模型的接口地址（去尾斜杠）：请求 URL 以它开头才换得了。 */
  readonly fromBaseURL: string;
  readonly toBaseURL: string;
  readonly apiKey: string;
  readonly modelId: string;
  /** 备用模型的服务商（换成了记用量用）。 */
  readonly provider: string;
  readonly providerLabel?: string;
  /** 换成了要告诉作者的一句话。 */
  readonly notice: string;
}

/**
 * 备用模型（P10）：对话 AI 这一步的请求主模型没连上（连不上、一直没响应头、上游回了错误状态），换备用模型重发一次——
 * 换地址、换密钥、换 body 里的模型名，思考方言由备用自己的请求链重新注入。
 * 只在拿到成功的响应头之前换：流到一半出错不换（已经出的字收不回，交给作者点重试）；作者自己停了不换。
 * 备用也没成就把主模型的原错误原样交给 SDK（如实报错，不吞）。
 */
export function withModelFallback(primaryFetch: typeof fetch, fallback: AgentModelFallback): typeof fetch {
  return async (input, init) => {
    const callerSignal = init?.signal ?? undefined;
    let primaryResponse: Response | undefined;
    let primaryError: unknown;
    try {
      primaryResponse = await primaryFetch(input, init);
      if (primaryResponse.ok) return primaryResponse;
    } catch (error) {
      if (callerSignal?.aborted) throw error;
      primaryError = error;
    }
    const rewritten = rewriteForFallback(input, init, fallback);
    if (rewritten) {
      const reason = primaryResponse ? `上游回了 ${primaryResponse.status}` : String((primaryError as Error)?.message ?? primaryError).slice(0, 160);
      console.warn(`[agent-fallback] 主模型没连上（${reason}），换备用 ${fallback.modelId} 重发一次`);
      try {
        const response = await fallback.fetch(rewritten.input, rewritten.init);
        if (response.ok) {
          await primaryResponse?.body?.cancel().catch(() => undefined);
          recordTurnNotice(fallback.notice);
          recordAgentFallback({ provider: fallback.provider, ...(fallback.providerLabel ? { providerLabel: fallback.providerLabel } : {}), model: fallback.modelId });
          return response;
        }
        console.warn(`[agent-fallback] 备用模型也没成：上游回了 ${response.status}`);
        await response.body?.cancel().catch(() => undefined);
      } catch (error) {
        if (callerSignal?.aborted) throw error;
        console.warn(`[agent-fallback] 备用模型也没成：${String((error as Error)?.message ?? error).slice(0, 160)}`);
      }
    }
    if (primaryResponse) return primaryResponse;
    throw primaryError;
  };
}

/** 把发给主模型的请求改写成发给备用模型的：地址前缀、Authorization、body.model。改写不了回 null（不换）。 */
function rewriteForFallback(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  fallback: AgentModelFallback,
): { readonly input: string; readonly init: RequestInit } | null {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith(fallback.fromBaseURL) || typeof init?.body !== "string") return null;
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(init.body);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    body = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const headers = new Headers(init.headers);
  if (fallback.apiKey) headers.set("authorization", `Bearer ${fallback.apiKey}`);
  else headers.delete("authorization");
  return {
    input: `${fallback.toBaseURL}${url.slice(fallback.fromBaseURL.length)}`,
    init: { ...init, headers, body: JSON.stringify({ ...body, model: fallback.modelId }) },
  };
}
