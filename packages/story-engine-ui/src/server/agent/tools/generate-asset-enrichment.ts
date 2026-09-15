/**
 * generate_asset_enrichment — 写类工具：给项目「已有资产」补三类展示层厚字段（读者可见性 / 知情边界、
 * 持有人画像、连续性风险）并落盘到 .story-engine-ui/asset-enrichment.json，喂满 AssetCodexPanel 预留的
 * 三个可选厚 props（assetVisibility / ownerDescriptions / continuityRisks）。
 *
 * 与 generate_worldbuilding 的关键差异：enrichment 从「已有实体」生成——先 buildStateOverview 取项目
 * 真实资产清单（资产名 / 持有人名 / 类型 / 状态），按真实键做厚，绝不编造不存在的资产（见
 * asset-enrichment/asset-enrichment.ts 的设计动机）。
 *
 * 铁律：直接做 + 可撤销（writeTool 前置快照）；绝不静默失败（没有资产 ok:false、模型/解析出错抛错）。
 */
import { buildStateOverview } from "@actalk/story-engine";
import { z } from "zod";

import { writeTool } from "../withSnapshot.js";
import { targetFields, parseEntityTarget, filterByEntityTarget } from "./enrichment-target.js";
import { callOpenAICompatibleChatModel, resolveConfiguredChatModel } from "../../lib/llm-client.js";
import {
  generateAssetEnrichment,
  type AssetEntityInput,
  type ChatMessage,
} from "../asset-enrichment/asset-enrichment.js";

const inputSchema = z.object({
  // enrichment 从项目现有资产读取，通常不需要任何参数；保留一个可空开关以备将来扩展，不强制。
  note: z.string().optional().describe("可选备注，一般留空——工具自动读取项目现有资产做厚。"),
  // 单体定向：用户刚补/指名某资产时，只补全这几个，别整批覆盖已手改的其它资产。省略=补全部。
  ...targetFields,
});

const outputSchema = z.object({
  ok: z.boolean().describe("是否成功做厚。没有任何资产时为 false。"),
  summary: z.string().describe("自然语言摘要，供回答用户。"),
  enrichment: z.unknown().optional().describe("生成的资产做厚对象（可见性/持有人画像/连续性风险）。"),
  overview: z.unknown().optional().describe("落盘后的最新 StateOverview，供刷新资料面板。"),
  refreshScope: z.literal("foundation").optional(),
  snapshotId: z.string().describe("写前快照 id，可一键撤销本次做厚。"),
});

/** 用用户配置的模型做一次 JSON 输出调用（照 generate-worldbuilding 的 callConfiguredModel）。 */
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
 * 从 StateOverview 的 assetSummary 提取「已有资产」清单 → AssetEntityInput[]。
 * 数据路径：overview.assetSummary（StateOverviewAssetSummary）。优先用结构化 assetItems
 * （含 name/type/owner/carriedBy/status），为空时回落到字符串清单（carried/owned/unavailable/plotCritical）。
 */
function collectAssetEntities(assetSummary: Awaited<ReturnType<typeof buildStateOverview>>["assetSummary"]): AssetEntityInput[] {
  if (assetSummary.assetItems.length > 0) {
    return assetSummary.assetItems.map((item) => ({
      ...(item.id ? { id: item.id } : {}),
      name: item.name,
      ...(item.owner ?? item.carriedBy ? { owner: item.owner ?? item.carriedBy } : {}),
      ...(item.type ? { type: item.type } : {}),
      ...(item.status ? { status: item.status } : {}),
    }));
  }
  // 回落：仅有字符串清单时，去重成名字、用清单类别粗标状态（无持有人/类型信息）。
  const seen = new Map<string, AssetEntityInput>();
  const unavailable = new Set(assetSummary.unavailableAssets.map((s) => s.trim()));
  const critical = new Set(assetSummary.plotCriticalAssets.map((s) => s.trim()));
  const add = (raw: string, status: string) => {
    const name = raw.trim();
    if (!name || seen.has(name)) return;
    seen.set(name, {
      name,
      status: unavailable.has(name) ? "受限" : critical.has(name) ? "关键" : status,
    });
  };
  assetSummary.carriedAssets.forEach((a) => add(a, "随身可用"));
  assetSummary.ownedAssets.forEach((a) => add(a, "可用"));
  assetSummary.unavailableAssets.forEach((a) => add(a, "受限"));
  assetSummary.plotCriticalAssets.forEach((a) => add(a, "关键"));
  return [...seen.values()];
}

export const generateAssetEnrichmentTool = writeTool({
  id: "generate_asset_enrichment",
  description:
    "当用户说『把资产做厚 / 补全资产细节 / 标一下每件东西谁知道、读者可不可见 / 给持有人画个像 / " +
    "查一下资产连续性有没有坑』时调用：基于项目现有资产清单，为每件资产补读者可见性与知情边界、" +
    "给持有人一句话画像、列出连续性风险（铺垫缺口/凭空取物/滞留提醒之类），写入资料、可一键撤销。" +
    "只对已有资产做厚，不会编造不存在的资产。",
  inputSchema,
  outputSchema,
  run: async ({ input, projectDir }) => {
    const overview = await buildStateOverview({ projectDir, maxTimelineEvents: 8 });
    const target = parseEntityTarget({
      ...input,
      nameById: new Map(overview.characterMatrix.characters.map((c) => [c.id, c.name])),
    });
    const assets = filterByEntityTarget(collectAssetEntities(overview.assetSummary), target);
    if (target && assets.length === 0) {
      return {
        ok: false,
        summary: `没找到要补全的资产（${target.labels.join("、")}）；确认名字/ id 与资料里一致，或先把这件资产建出来再补。`,
      };
    }

    const result = await generateAssetEnrichment({ projectDir, assets: [...assets], callModel: callConfiguredModel });
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
