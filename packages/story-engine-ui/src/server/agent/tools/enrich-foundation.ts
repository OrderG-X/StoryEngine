/**
 * enrich_foundation —— 「补全资料」一个入口（2026-10-10 引擎升级第 5 期·对话 AI 瘦身）。
 *
 * 原来 8 个 generate_* 工具各占一份说明和参数（约 4 千字，每轮都发给模型）。现在对话 AI 只看这一个，
 * 按 kind 转给原来的工具执行——快照、撤销标签（「补全角色」等）、结果形状都是原工具的，界面不受影响。
 */
import { createTool } from "@mastra/core/tools";
import type { ToolExecutionContext } from "@mastra/core/tools";
import { z } from "zod";

import { generateAliasTableTool } from "./generate-alias-table.js";
import { generateAssetEnrichmentTool } from "./generate-asset-enrichment.js";
import { generateCharacterEnrichmentTool } from "./generate-character-enrichment.js";
import { generateCharacterRelationshipsTool } from "./generate-character-relationships.js";
import { generateLocationEnrichmentTool } from "./generate-location-enrichment.js";
import { generateMatrixEnrichmentTool } from "./generate-matrix-enrichment.js";
import { generateWorldbuildingTool } from "./generate-worldbuilding.js";
import { generateWritingRulesEnrichmentTool } from "./generate-writing-rules-enrichment.js";
import { blankToUndefined, coerceEnum, coerceStringArray } from "../../lib/lenient-args.js";

export const ENRICH_KINDS = ["world", "characters", "assets", "locations", "matrix", "relationships", "writing_rules", "aliases"] as const;
export type EnrichKind = (typeof ENRICH_KINDS)[number];

const TOOLS: Record<EnrichKind, { readonly execute?: unknown }> = {
  world: generateWorldbuildingTool,
  characters: generateCharacterEnrichmentTool,
  assets: generateAssetEnrichmentTool,
  locations: generateLocationEnrichmentTool,
  matrix: generateMatrixEnrichmentTool,
  relationships: generateCharacterRelationshipsTool,
  writing_rules: generateWritingRulesEnrichmentTool,
  aliases: generateAliasTableTool,
};

/** 原工具名（界面步骤名、撤销标签都认它）。 */
export const ENRICH_TOOL_NAMES: Record<EnrichKind, string> = {
  world: "generate_worldbuilding",
  characters: "generate_character_enrichment",
  assets: "generate_asset_enrichment",
  locations: "generate_location_enrichment",
  matrix: "generate_matrix_enrichment",
  relationships: "generate_character_relationships",
  writing_rules: "generate_writing_rules_enrichment",
  aliases: "generate_alias_table",
};

const inputSchema = z.object({
  kind: coerceEnum(z.enum(ENRICH_KINDS).describe(
    "补什么：world=把世界种子扩写成世界观；characters=角色三层人格/成长弧；assets=资产知情边界与连续性风险；" +
      "locations=地点进入限制/离开代价；matrix=角色叙事岗位与关系情感债；relationships=从已定稿章节的硬事实整理人物关系网（开书时账本为空会失败）；" +
      "writing_rules=文风特点与避免机器腔的提醒；aliases=角色别名表。",
  )),
  targetNames: coerceStringArray(z.array(z.string()).optional()).describe(
    "characters / assets / locations / matrix：只补这几个（按名字）。用户指名某个时必须填，省略=补全部。",
  ),
  premise: blankToUndefined(z.string().optional().describe("world：一句话世界种子；省略时从现有设定推断。")),
});

export const enrichFoundationTool = createTool({
  id: "enrich_foundation",
  description:
    "补全资料（只补已有的，不编造新实体），写入资料、可一键撤销。用户说『补全/丰富某类资料』时用；开放式的整体补全先给方向选项。",
  inputSchema,
  execute: async (input: z.infer<typeof inputSchema>, context: ToolExecutionContext) => {
    const tool = TOOLS[input.kind];
    const execute = tool.execute as ((args: Record<string, unknown>, context: ToolExecutionContext) => Promise<unknown>) | undefined;
    if (!execute) throw new Error(`补全「${input.kind}」暂不可用。`);
    const args: Record<string, unknown> = {};
    if (input.targetNames && input.targetNames.length > 0 && ["characters", "assets", "locations", "matrix"].includes(input.kind)) {
      args.targetNames = input.targetNames;
    }
    if (input.kind === "world" && input.premise) args.premise = input.premise;
    const output = await execute(args, context);
    return output && typeof output === "object" && !Array.isArray(output)
      ? { ...(output as Record<string, unknown>), kind: input.kind }
      : output;
  },
});
