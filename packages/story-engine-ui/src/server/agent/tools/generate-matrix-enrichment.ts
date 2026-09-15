/**
 * generate_matrix_enrichment — 写类工具：给项目「已有角色 / 已有关系对」补两类展示层厚字段
 * （叙事岗位 narrativeRole；关系账本的情感债 / 红线 / 下一次转折 / 双名方向）并落盘到
 * .story-engine-ui/matrix-enrichment.json，喂满 CharacterMatrixCodexPanel 预留的两个可选厚 props
 * （matrixOverrides 按 character.id、relationshipExtras 按 relationshipKey）。
 *
 * 与 generate_worldbuilding 的关键差异：enrichment 从「已有实体」生成——先 buildStateOverview 取项目
 * 真实角色清单（id/名/职能）与真实关系对清单，按真实 character.id 与真实 relationshipKey 做厚，
 * 绝不编造不存在的角色或关系（见 matrix-enrichment/matrix-enrichment.ts 的设计动机）。
 *
 * 键对齐铁律（与 CharacterMatrixCodexPanel.relationshipKey() 逐字一致）：
 *   relationshipKey = `${targetCharacterId || targetName}|${relationType}`。
 *
 * 铁律：直接做 + 可撤销（writeTool 前置快照）；绝不静默失败（没有角色 ok:false、模型/解析出错抛错）。
 */
import { buildStateOverview } from "@actalk/story-engine";
import { z } from "zod";

import { writeTool } from "../withSnapshot.js";
import { targetFields, parseEntityTarget, type EntityTarget } from "./enrichment-target.js";
import { callOpenAICompatibleChatModel, resolveConfiguredChatModel } from "../../lib/llm-client.js";
import {
  generateMatrixEnrichment,
  type ChatMessage,
  type MatrixCharacterInput,
  type MatrixRelationshipInput,
} from "../matrix-enrichment/matrix-enrichment.js";

const inputSchema = z.object({
  // enrichment 从项目现有角色矩阵读取，通常不需要任何参数；保留一个可空备注以备将来扩展，不强制。
  note: z.string().optional().describe("可选备注，一般留空——工具自动读取项目现有角色矩阵做厚。"),
  // 单体定向（增量·入库后自动刷本章涉及角色用）：只刷这几个角色及其牵连关系。省略=刷全部。
  ...targetFields,
});

const outputSchema = z.object({
  ok: z.boolean().describe("是否成功做厚。没有任何角色时为 false。"),
  summary: z.string().describe("自然语言摘要，供回答用户。"),
  enrichment: z.unknown().optional().describe("生成的角色矩阵做厚对象（叙事岗位 + 关系账本厚字段）。"),
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

type CharacterMatrix = Awaited<ReturnType<typeof buildStateOverview>>["characterMatrix"];

/** 与 CharacterMatrixCodexPanel.relationshipKey() 逐字一致的关系键拼法（键对齐铁律，别动）。 */
function relationshipKey(rel: CharacterMatrix["relationships"][number]): string {
  const id = (rel.targetCharacterId ?? "").trim();
  const name = (rel.targetName ?? "").trim();
  return `${id || name}|${(rel.relationType ?? "").trim()}`;
}

/** 从 StateOverview 的 characterMatrix 提取「已有角色」清单 → MatrixCharacterInput[]（键用 character.id）。target 非空时只取命中的。 */
function collectCharacters(matrix: CharacterMatrix, target?: EntityTarget): MatrixCharacterInput[] {
  return matrix.characters
    .filter((c) => (c.id ?? "").trim().length > 0)
    .filter((c) => !target || (c.id ? target.ids.has(c.id) : false) || target.names.has((c.name ?? "").trim()))
    .map((c) => ({
      id: c.id,
      name: c.name,
      ...(c.role && c.role.trim() ? { role: c.role } : {}),
      ...(c.roleHint && c.roleHint.trim() ? { roleHint: c.roleHint } : {}),
    }));
}

/** 从 characterMatrix.relationships 提取「已有关系对」→ MatrixRelationshipInput[]（键 = relationshipKey）。 */
function collectRelationships(matrix: CharacterMatrix, target?: EntityTarget): MatrixRelationshipInput[] {
  return matrix.relationships
    .filter((r) => (r.relationType ?? "").trim().length > 0 && ((r.targetCharacterId ?? "").trim() || (r.targetName ?? "").trim()))
    .filter((r) => !target
      || ((r.targetCharacterId ?? "").trim() ? target.ids.has((r.targetCharacterId ?? "").trim()) : false)
      || target.names.has((r.targetName ?? "").trim()))
    .map((r) => ({
      key: relationshipKey(r),
      targetName: r.targetName,
      relationType: r.relationType,
      ...(r.attitude && r.attitude.trim() ? { attitude: r.attitude } : {}),
      ...(r.trustLevel ? { trustLevel: r.trustLevel } : {}),
      ...(r.conflict && r.conflict.trim() ? { conflict: r.conflict } : {}),
      ...(r.secret && r.secret.trim() ? { secret: r.secret } : {}),
    }));
}

export const generateMatrixEnrichmentTool = writeTool({
  id: "generate_matrix_enrichment",
  description:
    "当用户说『把角色矩阵做厚 / 给每个角色标叙事岗位 / 补关系账本（情感债、关系红线、下一次转折）』" +
    "时调用：基于项目现有角色与关系对清单，为每个角色补叙事岗位、" +
    "为每对关系补情感债 / 红线 / 下一次转折，写入资料、可一键撤销。" +
    "（信任度由引擎三档权威派生，本工具不产精确信任度百分比。）" +
    "只对已有角色和关系做厚，不会编造不存在的角色或关系。",
  inputSchema,
  outputSchema,
  run: async ({ input, projectDir }) => {
    const overview = await buildStateOverview({ projectDir, maxTimelineEvents: 8 });
    const target = parseEntityTarget({
      ...input,
      nameById: new Map(overview.characterMatrix.characters.map((c) => [c.id, c.name])),
    });
    const characters = collectCharacters(overview.characterMatrix, target);
    if (target && characters.length === 0) {
      return {
        ok: false,
        summary: `没找到要刷新矩阵的角色（${target.labels.join("、")}）；确认名字/ id 与资料里一致。`,
      };
    }
    const relationships = collectRelationships(overview.characterMatrix, target);

    const result = await generateMatrixEnrichment({
      projectDir,
      characters,
      relationships,
      callModel: callConfiguredModel,
      ...(overview.project.currentChapter != null ? { currentChapter: overview.project.currentChapter } : {}),
    });
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
