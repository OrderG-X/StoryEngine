/**
 * generate_character_enrichment — 写类工具：给项目「已有角色」补 codex 角色面板预留的展示层厚字段
 * （三层人格 core/surface/mask、内部缺失 innerLack、情绪外露 emotionalExposure、日常锚点 dailyAnchors、
 * 成长弧三步 arcStart/arcSetback/arcCost）并落盘到 .story-engine-ui/character-enrichment.json，
 * 喂满 CharacterCodexPanel 的 enrichment?: Record<角色名, CharacterCodexEnrichment>。
 *
 * 与 generate_worldbuilding 的关键差异：enrichment 从「已有实体」生成——先 buildStateOverview 取项目
 * 真实角色矩阵（角色名 / 身份 / 角色定位 / 已知短板等），按真实角色名为键做厚，绝不编造不存在的角色
 * （见 character-enrichment/character-enrichment.ts 的设计动机）。
 *
 * 铁律：直接做 + 可撤销（writeTool 前置快照）；绝不静默失败（没有角色 ok:false、模型/解析出错抛错）。
 */
import { buildStateOverview } from "@actalk/story-engine";
import { z } from "zod";

import { writeTool } from "../withSnapshot.js";
import { targetFields, parseEntityTarget, filterByEntityTarget } from "./enrichment-target.js";
import { callOpenAICompatibleChatModel, resolveConfiguredChatModel } from "../../lib/llm-client.js";
import {
  generateCharacterEnrichment,
  type CharacterEntityInput,
  type ChatMessage,
} from "../character-enrichment/character-enrichment.js";

const inputSchema = z.object({
  // enrichment 从项目现有角色矩阵读取，通常不需要任何参数；保留一个可空开关以备将来扩展，不强制。
  note: z.string().optional().describe("可选备注，一般留空——工具自动读取项目现有角色做厚。"),
  // 单体定向：用户刚补/指名某角色时，只补全这几个，别整批覆盖已手改的其它角色。省略=补全部。
  ...targetFields,
});

const outputSchema = z.object({
  ok: z.boolean().describe("是否成功做厚。没有任何角色时为 false。"),
  summary: z.string().describe("自然语言摘要，供回答用户。"),
  enrichment: z.unknown().optional().describe("生成的角色做厚对象（byCharacter: 角色名 → 三层人格/成长弧/情绪外露/日常锚点）。"),
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
    timeoutMs: 250000,
  });
  return content;
};

/**
 * 从 StateOverview 的 characterMatrix 提取「已有角色」清单 → CharacterEntityInput[]。
 * 数据路径：overview.characterMatrix.characters（StateOverviewCharacterMatrixItem）。
 * 矩阵不可用 / 为空 → 返回空数组，工具据此回 ok:false（不调模型、不编造）。
 */
function collectCharacterEntities(matrix: Awaited<ReturnType<typeof buildStateOverview>>["characterMatrix"]): CharacterEntityInput[] {
  if (!matrix.available || matrix.characters.length === 0) return [];
  return matrix.characters
    .filter((c) => c.name && c.name.trim().length > 0)
    .map((c) => ({
      name: c.name,
      ...(c.id ? { id: c.id } : {}),
      ...(c.role ? { role: c.role } : {}),
      ...(c.identity ? { identity: c.identity } : {}),
      ...(c.desire ? { desire: c.desire } : {}),
      ...(c.fear ? { fear: c.fear } : {}),
      ...(c.weakness ? { weakness: c.weakness } : {}),
      ...(c.currentGoal ? { currentGoal: c.currentGoal } : {}),
    }));
}

export const generateCharacterEnrichmentTool = writeTool({
  id: "generate_character_enrichment",
  description:
    "当用户说『把角色做厚 / 补全角色细节 / 给角色立三层人格（内核 表层 社交伪装）/ 补成长弧 / " +
    "加日常锚点 / 写情绪外露』时调用：基于项目现有角色矩阵，为每个角色补内核/表层/伪装三层人格、" +
    "内部缺失、情绪外露、日常锚点和成长弧三步，写入资料、可一键撤销。" +
    "只对已有角色做厚，不会编造不存在的角色。",
  inputSchema,
  outputSchema,
  run: async ({ input, projectDir }) => {
    const overview = await buildStateOverview({ projectDir, maxTimelineEvents: 8 });
    const target = parseEntityTarget({
      ...input,
      nameById: new Map(overview.characterMatrix.characters.map((c) => [c.id, c.name])),
    });
    const characters = filterByEntityTarget(collectCharacterEntities(overview.characterMatrix), target);
    if (target && characters.length === 0) {
      // 定向了却一个没命中 → 诚实回报，绝不静默整批或空跑（铁律④）。
      return {
        ok: false,
        summary: `没找到要补全的角色（${target.labels.join("、")}）；确认名字/ id 与资料里一致，或先把这个角色建出来再补。`,
      };
    }

    const result = await generateCharacterEnrichment({ projectDir, characters: [...characters], callModel: callConfiguredModel });
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
