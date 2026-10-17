/**
 * generate_writing_rules_enrichment — 写类工具：据项目「已有写作规则 / 叙事契约」补两类展示层厚字段
 * （风格特征指纹 fingerprints + 反 AI 写作规则 antiRules）并落盘到
 * .story-engine-ui/writing-rules-enrichment.json，喂满 WritingRulesCodexPanel 预留的两个可选厚 props。
 *
 * 与 generate_worldbuilding 的关键差异：enrichment 从「已有规则」生成——先 buildStateOverview 取本书
 * 题材与现有 writingRules（视角 / 文风 / 节奏 / 禁止内容 / 反 AI 倾向），据真实风格量化指纹、提炼反 AI
 * 规则，不脱离本书既定风格凭空发挥（见 writing-rules-enrichment/writing-rules-enrichment.ts 的设计动机）。
 *
 * 铁律：直接做 + 可撤销（writeTool 前置快照）；绝不静默失败（没有规则 ok:false、模型/解析出错抛错）。
 */
import { buildStateOverview } from "@actalk/story-engine";
import { z } from "zod";

import { writeTool } from "../withSnapshot.js";
import { callOpenAICompatibleChatModel, resolveConfiguredChatModel } from "../../lib/llm-client.js";
import {
  generateWritingRulesEnrichment,
  type ChatMessage,
  type WritingRulesContextInput,
} from "../writing-rules-enrichment/writing-rules-enrichment.js";

const inputSchema = z.object({
  // enrichment 从项目现有写作规则读取，通常不需要任何参数；保留一个可空备注以备将来扩展，不强制。
  note: z.string().optional().describe("可选备注，一般留空——工具自动读取项目现有写作规则做厚。"),
});

const outputSchema = z.object({
  ok: z.boolean().describe("是否成功做厚。没有任何写作规则时为 false。"),
  summary: z.string().describe("自然语言摘要，供回答用户。"),
  enrichment: z.unknown().optional().describe("生成的写作规则补全结果（文风特点 / 避免机器腔的提醒）。"),
  overview: z.unknown().optional().describe("落盘后的最新 StateOverview，供刷新资料面板。"),
  refreshScope: z.literal("foundation").optional(),
  snapshotId: z.string().describe("写前快照 id，可一键撤销本次做厚。"),
});

/** 用用户配置的模型做一次 JSON 输出调用（照 generate-asset-enrichment 的 callConfiguredModel）。 */
const callConfiguredModel = async (messages: readonly ChatMessage[]): Promise<string> => {
  const configured = await resolveConfiguredChatModel("enrichment");
  const { content } = await callOpenAICompatibleChatModel({
    configured,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    responseFormat: { type: "json_object" },
  });
  return content;
};

/**
 * 从 StateOverview 提取「本书写作规则」上下文 → WritingRulesContextInput。
 * 数据路径：overview.writingRules（StateOverviewWritingRulesSummary）+ overview.project.genre（题材兜底）。
 */
function collectWritingRulesContext(overview: Awaited<ReturnType<typeof buildStateOverview>>): WritingRulesContextInput {
  const wr = overview.writingRules;
  return {
    ...(overview.project.genre ? { genre: overview.project.genre } : {}),
    ...(wr.narrativePerspective ? { narrativePerspective: wr.narrativePerspective } : {}),
    proseStyle: wr.proseStyle,
    ...(wr.pacing ? { pacing: wr.pacing } : {}),
    ...(wr.revealPolicy ? { revealPolicy: wr.revealPolicy } : {}),
    genreRequirements: wr.genreRequirements,
    forbiddenContent: wr.forbiddenContent,
    doNotDo: wr.doNotDo,
    readerExperienceRules: wr.readerExperienceRules,
    antiAiPatterns: wr.antiAiPatterns,
  };
}

export const generateWritingRulesEnrichmentTool = writeTool({
  id: "generate_writing_rules_enrichment",
  description:
    "当用户说『补全/丰富写作规则 / 把写作规则做厚 / 量化一下本书风格 / 给本书的风格打个指纹 / 帮我列一份反 AI 写作规则 / " +
    "查一下哪些写法有 AI 味』时调用：基于本书题材与现有写作规则，整理出文风特点（如『物质细节描写较多』）、" +
    "提炼出一组避免机器腔的可执行写作提醒（禁用 / 风险 / 鼓励，带严重度），写入资料、可一键撤销。" +
    "只据本书既定风格补全，不会脱离本书风格凭空发挥。",
  inputSchema,
  outputSchema,
  run: async ({ projectDir }) => {
    const overview = await buildStateOverview({ projectDir, maxTimelineEvents: 8 });
    const context = collectWritingRulesContext(overview);

    const result = await generateWritingRulesEnrichment({ projectDir, context, callModel: callConfiguredModel });
    if (!result.ok) {
      return { ok: false, summary: result.summary };
    }

    const after = await buildStateOverview({ projectDir, maxTimelineEvents: 8 });
    return {
      ok: true,
      summary: result.summary,
      enrichment: result.enrichment,
      overview: after,
      refreshScope: "foundation" as const,
    };
  },
});
