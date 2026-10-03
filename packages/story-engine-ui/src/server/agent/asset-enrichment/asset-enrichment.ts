/**
 * 资产做厚（enrichment）——给项目「已有的资产」补三类 UI 展示层厚字段：
 *   ① 读者可见性 / 知情边界（assetVisibility：资产名 → 「读者可见 / 仅谁知 / 谁+谁知」）
 *   ② 持有人一句话画像（ownerDescriptions：持有人名 → 画像）
 *   ③ 连续性风险提示（continuityRisks：铺垫缺口 / 凭空取物 / 滞留提醒 之类，写作前必看）
 *
 * 设计动机 & 与 worldbuilding 的关键差异（2026-06-17）：worldbuilding 从「种子」凭空生成；
 * enrichment 必须从「项目现有实体」出发——把真实资产清单（资产名 / 持有人名 / 类型 / 状态）注入提示词，
 * 让模型**只按真实资产名/持有人名为键**产出厚字段，绝不许编造不存在的资产或持有人。
 *
 * 落盘去向（2026-06-20 R2 纠正过时注释）：assetVisibility 会并入 story/assets.json 的
 * extraFields["读者可见性"]、进正文 prompt（mergeAssetEnrichmentIntoEngine 干这件事，下一章 AI 会遵守）；
 * 其余字段（ownerDescriptions / continuityRisks）引擎不消费，仅完整结构落 .story-engine-ui/asset-enrichment.json 供面板。
 *
 * 提示词与数据结构均为本项目原创（借鉴通用提示工程技法，不复制任何第三方文案/代码）。
 */
import { mkdir, readFile } from "node:fs/promises";
import { writeFileAtomic } from "../../lib/project-io.js";
import { dirname, join } from "node:path";
import { z } from "zod";

import type { MergeResult } from "../enrichment-merge-result.js";

const nonEmpty = z.string().trim().min(1);

export const assetEnrichmentSchema = z.object({
  /** 资产名 → 读者可见性 / 知情边界文案（key 必须取自给定资产名）。 */
  assetVisibility: z.record(z.string(), z.string().trim()).default({}),
  /** 持有人名 → 一句话画像（key 必须取自给定持有人名）。 */
  ownerDescriptions: z.record(z.string(), z.string().trim()).default({}),
  /** 连续性风险提示（写作前必看）。 */
  continuityRisks: z.array(z.object({
    label: z.string().trim().default(""),
    detail: nonEmpty,
  }).strict()).default([]),
  /** id → assetVisibility 键名的桥接表（可选，向后兼容旧数据无此字段=纯按资产名匹配）。 */
  idMap: z.record(z.string(), z.string()).default({}),
}).strict();

export type AssetEnrichment = z.infer<typeof assetEnrichmentSchema>;

/** 喂给提示词的「已有资产」一条——名/持有人/类型/状态，让模型据真实实体做厚。 */
export interface AssetEntityInput {
  readonly id?: string;
  readonly name: string;
  readonly owner?: string;
  readonly type?: string;
  readonly status?: string;
}

export type ChatMessage = { readonly role: "system" | "user"; readonly content: string };
/** 注入式模型调用：传入消息，返回模型文本（应是一个 JSON 对象）。便于单测 mock。 */
export type CallModel = (messages: readonly ChatMessage[]) => Promise<string>;

/**
 * 构造资产做厚生成消息（本项目原创提示词）。核心技法：只输出 JSON + 按真实资产名/持有人名为键 +
 * 禁编造 + 可见性落实到「读者可见 / 仅谁知 / 谁+谁知」+ 连续性风险要具体。
 */
export function buildAssetEnrichmentMessages(assets: readonly AssetEntityInput[]): ChatMessage[] {
  const owners = [...new Set(
    assets.map((a) => (a.owner ?? "").trim()).filter((o) => o.length > 0),
  )];

  const system = [
    "你是为长篇小说服务的『资产连续性』审校助手。下面会给你这本书**已经存在**的资产清单。",
    "你的任务：为这些已有资产补三类展示层信息——读者可见性 / 知情边界、持有人画像、连续性风险。宁可写具体，不要写空话。",
    "只输出一个合法 JSON 对象，不要 Markdown、不要解释、不要代码块。所有文字用简体中文。",
    "",
    "JSON 字段固定（不要增删字段名）：",
    "assetVisibility{ 资产名: 可见性/知情边界文案 }（对象，键必须逐字取自下方给定的资产名，不要新造资产）",
    "ownerDescriptions{ 持有人名: 一句话画像 }（对象，键必须逐字取自下方给定的持有人名，不要新造人物）",
    "continuityRisks[{label 风险类别小标题, detail 风险正文}]（数组，针对这批资产可能踩的连续性坑）",
    "",
    "硬规则：",
    "1. 禁编造：assetVisibility 的键只能是给定资产名，ownerDescriptions 的键只能是给定持有人名；绝不要凭空冒出清单里没有的资产或人物。",
    "2. 可见性要落实到具体边界，用『读者可见 / 仅<某人>知 / <某人>+<某人>知 / 暂未公开』这种说法，别写『部分可见』『视情况』这类含糊话；要点明这件东西此刻谁知道、读者读到这里知不知道。",
    "3. 持有人画像一句话说清『这个人是谁、和资产什么关系、立场或软肋』，别写『一个普通人』这类废话。",
    "4. 连续性风险要具体、可执行：典型类别有『铺垫缺口』（某资产还没在正文出现就被使用）、『凭空取物风险』（角色突然拿出没交代来源的东西）、『滞留提醒』（埋了很久没回收的资产/伏笔）、『状态冲突』（受限/丢失的资产又被当可用）。每条 detail 要指名道姓提到具体资产或持有人。",
    "5. 没有把握的字段宁可少写也不要硬凑：某件资产判断不了可见性就不放进 assetVisibility；想不出真实风险就让 continuityRisks 为空数组，绝不编造。",
  ].join("\n");

  const assetLines = assets.map((a, i) => {
    const parts = [
      `名称：${a.name}`,
      a.owner && a.owner.trim() ? `持有人：${a.owner.trim()}` : "持有人：未标注",
      a.type && a.type.trim() ? `类型：${a.type.trim()}` : "",
      a.status && a.status.trim() ? `状态：${a.status.trim()}` : "",
    ].filter(Boolean);
    return `${i + 1}. ${parts.join("　|　")}`;
  });

  const user = [
    "本书已有的资产清单（只能基于这些做厚，键必须取自这里的资产名/持有人名）：",
    ...assetLines,
    "",
    owners.length > 0 ? `涉及的持有人（ownerDescriptions 的键只能取自这里）：${owners.join("、")}` : "（清单里没有标注持有人）",
    "",
    "请据此输出资产做厚 JSON。",
  ].join("\n");

  return [{ role: "system", content: system }, { role: "user", content: user }];
}

/** 从模型文本里抠出 JSON 并校验。失败抛错（绝不静默放过半成品）。 */
export function parseAssetEnrichment(text: string): AssetEnrichment {
  const match = text.match(/\{[\s\S]*\}/u);
  if (!match) throw new Error("资产做厚结果不是 JSON。");
  const parsed = JSON.parse(match[0]) as unknown;
  return assetEnrichmentSchema.parse(parsed);
}

/**
 * 把资产做厚结果完整落到 UI 侧文件（.story-engine-ui/asset-enrichment.json）供面板展示。
 * persist 本身只写这一个 UI 文件、不动引擎；assetVisibility 进正文是另一步
 * mergeAssetEnrichmentIntoEngine 干的（并入 story/assets.json 的 extraFields["读者可见性"]）。
 */
export async function persistAssetEnrichment(
  projectDir: string,
  data: AssetEnrichment,
): Promise<{ readonly artifactPath: string }> {
  const artifactPath = join(projectDir, ".story-engine-ui", "asset-enrichment.json");
  await mkdir(dirname(artifactPath), { recursive: true });
  await writeFileAtomic(artifactPath, JSON.stringify(data, null, 2));
  return { artifactPath };
}

/**
 * 把 assetVisibility 按资产名并入 assets.json 条目的 extraFields["读者可见性"]（已确认进正文 prompt）。
 * 诚实三态（R2 停谎报）：真并入→{merged:true}；无 assets.json / 无条目命中→{merged:false}（正常跳过、非失败）；
 * 写盘/解析真异常→{merged:false, reason:"写 story/assets.json 失败：…"}（绝不再静默吞）。
 */
export async function mergeAssetEnrichmentIntoEngine(projectDir: string, data: AssetEnrichment): Promise<MergeResult> {
  const path = join(projectDir, "story", "assets.json");
  let led: Record<string, unknown>;
  try {
    led = JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
  } catch (err) {
    // 文件不存在 = 正常跳过（展示层已落盘、非失败）；其它读/解析异常 = 真失败、如实回报。
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { merged: false };
    return { merged: false, reason: `读 story/assets.json 失败：${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    const assets = Array.isArray(led.assets) ? (led.assets as Array<Record<string, unknown>>) : [];
    let changed = false;
    const seenIds = new Set<string>();
    for (const asset of assets) {
      const name = typeof asset.name === "string" ? asset.name.trim() : "";
      const id = typeof asset.id === "string" ? asset.id.trim() : "";
      if (id && seenIds.has(id)) continue; // 同 id 多条目去重，防串味/重复写
      // 先按资产名字面命中 assetVisibility 键；name miss 时按 id 经 idMap 桥接到旧键名
      let vis = name ? data.assetVisibility[name] : undefined;
      if ((typeof vis !== "string" || !vis.trim()) && id && data.idMap[id]) {
        vis = data.assetVisibility[data.idMap[id]];
      }
      if (typeof vis !== "string" || !vis.trim()) continue;
      if (id) seenIds.add(id);
      const extra: Record<string, string | readonly string[]> = { ...(asset.extraFields as Record<string, string | readonly string[]> ?? {}) };
      extra["读者可见性"] = vis.trim();
      asset.extraFields = extra;
      changed = true;
    }
    if (!changed) return { merged: false };
    led.assets = assets;
    await mkdir(dirname(path), { recursive: true });
    await writeFileAtomic(path, JSON.stringify(led, null, 2));
    return { merged: true };
  } catch (err) {
    return { merged: false, reason: `写 story/assets.json 失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

export function summarizeAssetEnrichment(data: AssetEnrichment, merge: MergeResult): string {
  const visCount = Object.keys(data.assetVisibility).length;
  const ownerCount = Object.keys(data.ownerDescriptions).length;
  const riskCount = data.continuityRisks.length;
  const head = [
    "已补全现有道具与资源：",
    `标了 ${visCount} 件资产的读者可见性 / 知情边界、`,
    `${ownerCount} 个持有人的一句话画像、`,
    `${riskCount} 条连续性风险提示。`,
  ].join("");
  const tail = merge.merged
    ? "已写入资料，并接进写正文的上下文（资产读者可见性进正文，下一章 AI 就会遵守），可一键撤销；想改哪条直接跟我说。"
    : `已写入展示层资料，但未能接进正文（${merge.reason ?? "原因未知"}），下一章 AI 暂时用不上；可一键撤销，想改哪条直接跟我说。`;
  return head + tail;
}

export interface GenerateAssetEnrichmentResult {
  readonly ok: boolean;
  readonly summary: string;
  readonly mergedIntoEngine: boolean;
  readonly enrichment?: AssetEnrichment;
}

/** 编排：清单为空→ok:false 不调模型；否则 建消息 → 调模型 → 解析校验 → 落盘 → 摘要。callModel 注入，便于单测。 */
export async function generateAssetEnrichment(input: {
  readonly projectDir: string;
  readonly assets: readonly AssetEntityInput[];
  readonly callModel: CallModel;
}): Promise<GenerateAssetEnrichmentResult> {
  if (input.assets.length === 0) {
    return { ok: false, mergedIntoEngine: false, summary: "还没有道具与资源可补全——先把角色的随身物品和资源理进资料，再标注可见性、归属和连续性风险。" };
  }
  const text = await input.callModel(buildAssetEnrichmentMessages(input.assets));
  const parsed = parseAssetEnrichment(text);
  // 用本次生成的 input 资产 id↔name 锚住 idMap（id → assetVisibility 键名），
  // 供日后 bible 资产改名时 merge 仍能桥接命中旧键名（件③）。
  const idMap = Object.fromEntries(
    input.assets
      .filter((a) => a.id && a.id.trim() && a.name.trim())
      .map((a) => [a.id!.trim(), a.name.trim()] as const),
  );
  const enrichment: AssetEnrichment = { ...parsed, idMap };
  await persistAssetEnrichment(input.projectDir, enrichment);
  const merge = await mergeAssetEnrichmentIntoEngine(input.projectDir, enrichment);
  return { ok: true, mergedIntoEngine: merge.merged, summary: summarizeAssetEnrichment(enrichment, merge), enrichment };
}
