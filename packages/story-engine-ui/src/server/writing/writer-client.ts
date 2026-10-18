/**
 * 出稿写手的模型实现（重构 P7 第 6 步从 lib/llm-client 挪来）：把写作上下文渲染成提示词，经 llm-client 的流式主干调模型。
 * 写稿层（runFastDraft）只认 WriterClient 接口，模型由这里注入。
 */
import { resolveConfiguredChatModel, streamChatModelToText, type ModelTaskProfileKey, type ResolvedChatModel } from "../lib/llm-client.js";
import { buildFastDraftMessages } from "./ai-flavor/builtin-anti-ai-rules.js";
import { renderFastDraftPromptText } from "./prompt-cache-diagnostics.js";
import type { WriterClient } from "./fast-draft-writer.js";

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
