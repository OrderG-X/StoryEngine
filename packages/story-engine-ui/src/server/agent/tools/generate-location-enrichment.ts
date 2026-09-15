/**
 * generate_location_enrichment — 写类工具：给项目「已有地点」补一组展示层厚字段（表面印象 / 进入限制 /
 * 离开代价 / 关联势力 / 状态标签）并落盘到 .story-engine-ui/location-enrichment.json，喂满
 * LocationCodexPanel 预留的可选厚 props（LocationThickFields）。
 *
 * keying：落盘 byLocation:Record<地点名, 厚字段>（按地点名稳定生成），面板 fetch 回后按
 * location.locations 顺序映射成数组对上下标——见 location-enrichment/location-enrichment.ts 的设计动机。
 *
 * 与 generate_worldbuilding 的关键差异：enrichment 从「已有实体」生成——先 buildStateOverview 取项目
 * 真实地点清单（地点名 / 类型 / 已有叙事功能 / 已有风险 / 状态），按真实键做厚，绝不编造不存在的地点。
 *
 * 铁律：直接做 + 可撤销（writeTool 前置快照）；绝不静默失败（没有地点 ok:false、模型/解析出错抛错）。
 */
import { buildStateOverview } from "@actalk/story-engine";
import { z } from "zod";

import { writeTool } from "../withSnapshot.js";
import { targetFields, parseEntityTarget, filterByEntityTarget } from "./enrichment-target.js";
import { callOpenAICompatibleChatModel, resolveConfiguredChatModel } from "../../lib/llm-client.js";
import {
  generateLocationEnrichment,
  type LocationEntityInput,
  type ChatMessage,
} from "../location-enrichment/location-enrichment.js";

const inputSchema = z.object({
  // enrichment 从项目现有地点读取，通常不需要任何参数；保留一个可空备注以备将来扩展，不强制。
  note: z.string().optional().describe("可选备注，一般留空——工具自动读取项目现有地点做厚。"),
  // 单体定向：用户刚补/指名某地点时，只补全这几个，别整批覆盖已手改的其它地点。省略=补全部。
  ...targetFields,
});

const outputSchema = z.object({
  ok: z.boolean().describe("是否成功做厚。没有任何地点时为 false。"),
  summary: z.string().describe("自然语言摘要，供回答用户。"),
  enrichment: z.unknown().optional().describe("生成的地点做厚对象（byLocation:地点名→厚字段）。"),
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
 * 从 StateOverview 的 locationDetailSummary 提取「已有地点」清单 → LocationEntityInput[]。
 * 数据路径：overview.locationDetailSummary.locations（StateOverviewLocationDetailItem[]，
 * 含 name/type/narrativeFunction/risks/currentStatus）。
 */
function collectLocationEntities(
  locationDetail: Awaited<ReturnType<typeof buildStateOverview>>["locationDetailSummary"],
): LocationEntityInput[] {
  return locationDetail.locations
    .filter((item) => item.name.trim().length > 0)
    .map((item) => ({
      name: item.name,
      ...(item.id ? { id: item.id } : {}),
      ...(item.type ? { type: item.type } : {}),
      ...(item.narrativeFunction ? { narrativeFunction: item.narrativeFunction } : {}),
      ...(item.risks.length > 0 ? { risks: item.risks } : {}),
      ...(item.currentStatus ? { status: item.currentStatus } : {}),
    }));
}

export const generateLocationEnrichmentTool = writeTool({
  id: "generate_location_enrichment",
  description:
    "当用户说『把地点做厚 / 补全地点细节 / 给每个场景标一下进入限制和离开代价 / 这地方第一眼什么印象 / " +
    "哪些势力盯着这里 / 给地点加个状态标签』时调用：基于项目现有地点清单，为每个地点补表面印象、" +
    "进入限制、离开代价、关联势力与状态标签，写入资料、可一键撤销。" +
    "只对已有地点做厚，不会编造不存在的地点。",
  inputSchema,
  outputSchema,
  run: async ({ input, projectDir }) => {
    const overview = await buildStateOverview({ projectDir, maxTimelineEvents: 8 });
    const target = parseEntityTarget({
      ...input,
      nameById: new Map(overview.characterMatrix.characters.map((c) => [c.id, c.name])),
    });
    const locations = filterByEntityTarget(collectLocationEntities(overview.locationDetailSummary), target);
    if (target && locations.length === 0) {
      return {
        ok: false,
        summary: `没找到要补全的地点（${target.labels.join("、")}）；确认名字/ id 与资料里一致，或先把这个地点建出来再补。`,
      };
    }

    const result = await generateLocationEnrichment({ projectDir, locations: [...locations], callModel: callConfiguredModel });
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
