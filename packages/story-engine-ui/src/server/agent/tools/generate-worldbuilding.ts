/**
 * generate_worldbuilding — 写类工具：把极简种子扩写成「厚版结构化世界观」并落盘。
 *
 * 这是补「世界观太薄」的核心一刀（见 worldbuilding/worldbuilding.ts 的设计动机）：用本项目原创的
 * 「逼写厚 / 禁空话 / 题材感知」提示词，让模型一次产出有血有肉、自洽的世界观（社会结构 / 规则 /
 * 势力 / 地点 / 关系网 / 冲突源 / 开局方向），完整结构落到 .story-engine-ui/worldbuilding.json，
 * 头部要点并入 world-bible 供引擎与正文引用。
 *
 * 铁律：直接做 + 可撤销（writeTool 前置快照）；绝不静默失败（缺种子 ok:false、模型/解析出错抛错）。
 * 模型走用户配置（慢就慢，世界观是一次性铺垫；建议在设置里用更快的模型）。
 */
import { buildStateOverview } from "../../book/state-overview.js";
import { z } from "zod";

import { writeTool } from "../withSnapshot.js";
import { callOpenAICompatibleChatModel, resolveConfiguredChatModel } from "../../lib/llm-client.js";
import { blankToUndefined } from "../../lib/lenient-args.js";
import { generateWorldbuilding, type ChatMessage } from "../../services/enrichment/worldbuilding.js";

// 模型无关：模型常把可选种子传成空串 `""`，旧 `?? overview…` 接不住（`"" ?? x = ""`）→ 旁路"从项目
// 现有设定推断"→ 在本有世界设定的书上谎报"没种子"硬失败。blankToUndefined 把空串归一成 undefined。
export const inputSchema = z.object({
  premise: blankToUndefined(z.string().optional().describe(
    "世界种子：一句话描述这个故事大概是什么世界（年代/基调/主角处境/核心金手指）。省略时从项目现有设定推断。",
  )),
  genre: blankToUndefined(z.string().optional().describe("题材，如『都市后宫』『古代权谋』。省略时用项目题材。")),
});

const outputSchema = z.object({
  ok: z.boolean().describe("是否成功生成世界观。缺种子时为 false。"),
  summary: z.string().describe("自然语言摘要，供回答用户。"),
  worldbuilding: z.unknown().optional().describe("生成的结构化世界观对象（前端据此渲染卡片/关系网）。"),
  mergedIntoEngine: z.boolean().optional().describe("是否真并入引擎 world-bible（进正文）。展示层恒落盘；false=只落了资料没接进正文（summary 会说明原因），调用方据此判断结构化信号，不只看文案。"),
  overview: z.unknown().optional().describe("落盘后的最新 StateOverview，供刷新资料面板。"),
  refreshScope: z.literal("foundation").optional(),
  snapshotId: z.string().describe("写前快照 id，可一键撤销本次生成。"),
});

/** 用用户配置的模型做一次 JSON 输出调用。世界观较长，给足超时（慢模型可能仍超时——建议换快模型）。 */
const callConfiguredModel = async (messages: readonly ChatMessage[]): Promise<string> => {
  const configured = await resolveConfiguredChatModel("enrichment");
  const { content } = await callOpenAICompatibleChatModel({
    configured,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    responseFormat: { type: "json_object" }, // → json_object 自动拿高 max_tokens 上限（见 llm-client），思考+正文都装得下
  });
  return content;
};

export const generateWorldbuildingTool = writeTool({
  id: "generate_worldbuilding",
  description:
    "把用户给的极简世界种子扩写成一份『厚』的结构化世界观（社会结构/规则/势力/地点/关系网/冲突源/开局方向），" +
    "并写入资料。当用户说『建一个XX世界观 / 把世界观搭起来 / 这个世界扩写一下 / 世界观太单薄帮我补』时调用；" +
    "也适合新书开局先把世界铺厚。生成后可一键撤销，用户想改某一块直接再对话即可。",
  inputSchema,
  outputSchema,
  run: async ({ input, projectDir }) => {
    const overview = await buildStateOverview({ projectDir, maxTimelineEvents: 8 });
    const seed = {
      genre: (input.genre ?? overview.project.genre ?? "长篇故事").trim() || "长篇故事",
      premise: (input.premise ?? overview.world?.summary ?? overview.storyStatus?.currentObjective ?? "").trim(),
      ...(overview.project.title ? { title: overview.project.title } : {}),
    };

    const result = await generateWorldbuilding({ projectDir, seed, callModel: callConfiguredModel });
    if (!result.ok) {
      return { ok: false, summary: result.summary };
    }

    const after = await buildStateOverview({ projectDir, maxTimelineEvents: 8 });
    return {
      ok: true,
      summary: result.summary,
      worldbuilding: result.worldbuilding,
      ...(typeof result.mergedIntoEngine === "boolean" ? { mergedIntoEngine: result.mergedIntoEngine } : {}),
      overview: after,
      refreshScope: "foundation" as const,
    };
  },
});
