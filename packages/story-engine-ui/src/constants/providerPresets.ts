/**
 * 服务商预设：常见 AI 服务的接口地址模板。
 *
 * 说明只写一句中性的话（P10）：不列模型版本号——会过时，接上后模型清单反正从服务商实时拉。
 * 只收 OpenAI 兼容接口；原生接口不是这个格式的（Anthropic、百度千帆）不放，要用走「自定义服务」接兼容网关。
 */

export type ProviderPresetGroup = "overseas" | "china" | "aggregator" | "local";

export interface ProviderPreset {
  readonly id: string;
  readonly label: string;
  readonly group: ProviderPresetGroup;
  readonly type: "openai-compatible" | "openai";
  readonly baseUrl: string;
  readonly apiKeyEnvSuggestion: string;
  /** 一句话说明（不列模型名）。 */
  readonly note?: string;
}

export const GROUP_LABELS: Record<ProviderPresetGroup, string> = {
  overseas: "海外原厂",
  china: "国产原厂",
  aggregator: "聚合 / 二手 API",
  local: "本地 / 自部署",
};

export const PROVIDER_PRESETS: ReadonlyArray<ProviderPreset> = [
  // ---- Overseas ----
  { id: "openai", label: "OpenAI", group: "overseas", type: "openai-compatible", baseUrl: "https://api.openai.com/v1", apiKeyEnvSuggestion: "OPENAI_API_KEY", note: "OpenAI 官方接口" },
  { id: "google", label: "Google Gemini", group: "overseas", type: "openai-compatible", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", apiKeyEnvSuggestion: "GEMINI_API_KEY", note: "Google 官方的 OpenAI 兼容接口" },
  { id: "xai", label: "xAI (Grok)", group: "overseas", type: "openai-compatible", baseUrl: "https://api.x.ai/v1", apiKeyEnvSuggestion: "XAI_API_KEY", note: "xAI 官方接口" },
  { id: "azure-openai", label: "Azure OpenAI", group: "overseas", type: "openai-compatible", baseUrl: "https://RESOURCE.openai.azure.com/openai/v1", apiKeyEnvSuggestion: "AZURE_OPENAI_API_KEY", note: "把地址里的 RESOURCE 换成你的资源名，模型填部署名" },
  { id: "huggingface", label: "Hugging Face", group: "overseas", type: "openai-compatible", baseUrl: "https://router.huggingface.co/v1", apiKeyEnvSuggestion: "HF_API_KEY", note: "开源模型推理" },
  { id: "cerebras", label: "Cerebras", group: "overseas", type: "openai-compatible", baseUrl: "https://api.cerebras.ai/v1", apiKeyEnvSuggestion: "CEREBRAS_API_KEY", note: "开源模型，速度快" },
  { id: "together", label: "Together AI", group: "overseas", type: "openai-compatible", baseUrl: "https://api.together.xyz/v1", apiKeyEnvSuggestion: "TOGETHER_API_KEY", note: "开源模型推理" },

  // ---- China ----
  { id: "deepseek", label: "DeepSeek", group: "china", type: "openai-compatible", baseUrl: "https://api.deepseek.com/v1", apiKeyEnvSuggestion: "DEEPSEEK_API_KEY", note: "DeepSeek 官方接口" },
  { id: "tongyi", label: "通义千问 (Alibaba)", group: "china", type: "openai-compatible", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", apiKeyEnvSuggestion: "DASHSCOPE_API_KEY", note: "阿里云百炼的兼容接口" },
  { id: "zhipu", label: "智谱 GLM", group: "china", type: "openai-compatible", baseUrl: "https://open.bigmodel.cn/api/paas/v4", apiKeyEnvSuggestion: "ZHIPU_API_KEY", note: "智谱开放平台，按量付费" },
  { id: "zhipu-coding-plan", label: "智谱 Coding Plan", group: "china", type: "openai-compatible", baseUrl: "https://open.bigmodel.cn/api/paas/v4", apiKeyEnvSuggestion: "ZHIPU_CODING_PLAN_API_KEY", note: "智谱的编程套餐（订阅制）" },
  { id: "moonshot", label: "Moonshot (月之暗面)", group: "china", type: "openai-compatible", baseUrl: "https://api.moonshot.cn/v1", apiKeyEnvSuggestion: "MOONSHOT_API_KEY", note: "Kimi 的官方接口" },
  { id: "minimax", label: "MiniMax", group: "china", type: "openai-compatible", baseUrl: "https://api.minimax.chat/v1", apiKeyEnvSuggestion: "MINIMAX_API_KEY", note: "MiniMax 官方接口" },
  { id: "volcengine", label: "火山方舟 (豆包)", group: "china", type: "openai-compatible", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", apiKeyEnvSuggestion: "ARK_API_KEY", note: "字节火山引擎；模型填推理接入点 ID" },
  { id: "stepfun", label: "阶跃星辰 StepFun", group: "china", type: "openai-compatible", baseUrl: "https://api.stepfun.com/v1", apiKeyEnvSuggestion: "STEPFUN_API_KEY", note: "阶跃星辰官方接口" },
  { id: "lingyiwanwu", label: "零一万物 01.AI", group: "china", type: "openai-compatible", baseUrl: "https://api.lingyiwanwu.com/v1", apiKeyEnvSuggestion: "LINGYI_API_KEY", note: "零一万物官方接口" },
  { id: "xunfei", label: "讯飞星火", group: "china", type: "openai-compatible", baseUrl: "https://spark-api-open.xf-yun.com/v1", apiKeyEnvSuggestion: "SPARK_API_KEY", note: "讯飞开放平台" },
  { id: "baichuan", label: "百川智能", group: "china", type: "openai-compatible", baseUrl: "https://api.baichuan-ai.com/v1", apiKeyEnvSuggestion: "BAICHUAN_API_KEY", note: "百川官方接口" },
  { id: "hunyuan", label: "腾讯混元", group: "china", type: "openai-compatible", baseUrl: "https://api.hunyuan.cloud.tencent.com/v1", apiKeyEnvSuggestion: "HUNYUAN_API_KEY", note: "腾讯云的兼容接口" },
  // 官方文档：Go 订阅走 /zen/go/v1（api.opencode.ai 是幻觉域名，任何路径都回 200+纯文本 Not Found）
  { id: "opencode-go", label: "OpenCode Go", group: "china", type: "openai-compatible", baseUrl: "https://opencode.ai/zen/go/v1", apiKeyEnvSuggestion: "OPENCODE_GO_API_KEY", note: "订阅制，开源模型" },

  // ---- Aggregator ----
  { id: "opencode-zen", label: "OpenCode Zen", group: "aggregator", type: "openai-compatible", baseUrl: "https://opencode.ai/zen/v1", apiKeyEnvSuggestion: "OPENCODE_ZEN_API_KEY", note: "按量付费聚合；有的模型走 Responses 接口、这里接不上，换一个就行" },
  { id: "siliconflow", label: "SiliconFlow (硅基流动)", group: "aggregator", type: "openai-compatible", baseUrl: "https://api.siliconflow.cn/v1", apiKeyEnvSuggestion: "SILICONFLOW_API_KEY", note: "大量开源模型" },
  { id: "openrouter", label: "OpenRouter", group: "aggregator", type: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1", apiKeyEnvSuggestion: "OPENROUTER_API_KEY", note: "几乎所有模型的聚合网关" },
  { id: "groq", label: "Groq", group: "aggregator", type: "openai-compatible", baseUrl: "https://api.groq.com/openai/v1", apiKeyEnvSuggestion: "GROQ_API_KEY", note: "开源模型，速度快" },
  { id: "302ai", label: "302.AI", group: "aggregator", type: "openai-compatible", baseUrl: "https://api.302.ai/v1", apiKeyEnvSuggestion: "TRE02_API_KEY", note: "聚合多家模型" },

  // ---- Local ----
  { id: "ollama", label: "Ollama（本地）", group: "local", type: "openai-compatible", baseUrl: "http://localhost:11434/v1", apiKeyEnvSuggestion: "", note: "本机运行，不用密钥" },
  { id: "lmstudio", label: "LM Studio（本地）", group: "local", type: "openai-compatible", baseUrl: "http://localhost:1234/v1", apiKeyEnvSuggestion: "", note: "本机运行，不用密钥" },
  { id: "vllm", label: "vLLM（自部署）", group: "local", type: "openai-compatible", baseUrl: "http://localhost:8000/v1", apiKeyEnvSuggestion: "", note: "自己部署的兼容服务" },
];
