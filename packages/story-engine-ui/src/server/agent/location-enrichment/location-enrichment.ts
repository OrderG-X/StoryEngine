/**
 * 地点做厚（enrichment）——给项目「已有的地点」补一组 UI 展示层厚字段，喂满 LocationCodexPanel
 * 预留的可选厚 props（LocationThickFields）：
 *   · surfaceImpression 表面印象——外人/初见时的观感
 *   · entryRestriction  进入限制——进入需要的条件/权限
 *   · exitCost          离开代价——离开会留下的把柄/代价（.alert）
 *   · associatedForces  关联势力——暗中盯着/实控此地的势力
 *   · statusTag         状态标签文案（如「高危 · 监控中」）
 *   · statusTone        状态色调（"warn" | "danger" | "neutral"）
 *
 * 设计动机 & 与 worldbuilding 的关键差异（2026-06-17）：worldbuilding 从「种子」凭空生成；
 * enrichment 必须从「项目现有实体」出发——把真实地点清单（地点名 / 类型 / 已有叙事功能 / 已有风险）
 * 注入提示词，让模型**只按真实地点名为键**产出厚字段，绝不许编造不存在的地点。
 *
 * keying（地点是数组、面板按下标对齐，但生成要稳定）：落盘成 byLocation:Record<地点名, 厚字段>，
 * 面板 fetch 回 Record 后按 location.locations 的顺序映射成数组喂现有渲染逻辑——既稳定按名字、又对上下标。
 *
 * 落盘与并入（2026-06-20 起，纠正旧注释）：完整结构落 .story-engine-ui/location-enrichment.json 喂面板；
 * 同时 mergeLocationEnrichmentIntoEngine 会按地点名把厚字段并入 story/location-bible.json 的 extraFields、
 * 进正文 prompt（外观印象 / 进入限制 / 离开代价等）。早期「绝不并入引擎」的说法已随做厚接正文作废。
 *
 * 提示词与数据结构均为本项目原创（借鉴通用提示工程技法，不复制任何第三方文案/代码）。
 */
import { mkdir, readFile } from "node:fs/promises";
import { writeFileAtomic } from "../../lib/project-io.js";
import { dirname, join } from "node:path";
import { z } from "zod";

import type { MergeResult } from "../enrichment-merge-result.js";

/** 单个地点的厚字段（对齐 LocationCodexPanel 的 LocationThickFields，全可选）。 */
export const locationThickFieldsSchema = z.object({
  surfaceImpression: z.string().trim().optional(),
  entryRestriction: z.string().trim().optional(),
  exitCost: z.string().trim().optional(),
  associatedForces: z.string().trim().optional(),
  statusTag: z.string().trim().optional(),
  statusTone: z.enum(["warn", "danger", "neutral"]).optional(),
}).strict();

export const locationEnrichmentSchema = z.object({
  /** 地点名 → 厚字段（key 必须逐字取自给定地点名）。 */
  byLocation: z.record(z.string(), locationThickFieldsSchema).default({}),
  /** id → byLocation 键名的桥接表（可选，向后兼容旧数据无此字段=纯按名字匹配）。 */
  idMap: z.record(z.string(), z.string()).default({}),
}).strict();

export type LocationThickFields = z.infer<typeof locationThickFieldsSchema>;
export type LocationEnrichment = z.infer<typeof locationEnrichmentSchema>;

/** 喂给提示词的「已有地点」一条——名/类型/已有叙事功能/已有风险，让模型据真实实体做厚。 */
export interface LocationEntityInput {
  readonly id?: string;
  readonly name: string;
  readonly type?: string;
  readonly narrativeFunction?: string;
  readonly risks?: readonly string[];
  readonly status?: string;
}

export type ChatMessage = { readonly role: "system" | "user"; readonly content: string };
/** 注入式模型调用：传入消息，返回模型文本（应是一个 JSON 对象）。便于单测 mock。 */
export type CallModel = (messages: readonly ChatMessage[]) => Promise<string>;

/**
 * 构造地点做厚生成消息（本项目原创提示词）。核心技法：只输出 JSON + 按真实地点名为键 +
 * 禁编造 + 厚字段要具体（进入限制/离开代价要落实到「谁来管、留什么把柄」）。
 */
export function buildLocationEnrichmentMessages(locations: readonly LocationEntityInput[]): ChatMessage[] {
  const system = [
    "你是为长篇小说服务的『叙事场』审校助手。下面会给你这本书**已经存在**的地点清单。",
    "你的任务：为这些已有地点补一组展示层信息——表面印象、进入限制、离开代价、关联势力、状态标签。宁可写具体，不要写空话。",
    "只输出一个合法 JSON 对象，不要 Markdown、不要解释、不要代码块。所有文字用简体中文。",
    "",
    "JSON 字段固定（不要增删字段名）：",
    "byLocation{ 地点名: { surfaceImpression, entryRestriction, exitCost, associatedForces, statusTag, statusTone } }",
    "（byLocation 是对象，键必须逐字取自下方给定的地点名，不要新造地点）",
    "每个地点的厚字段含义：",
    "  surfaceImpression 表面印象：外人/初见时的观感（这地方第一眼像什么、给人什么感觉）。",
    "  entryRestriction  进入限制：进入需要的条件/权限/门槛（谁能进、要什么、被谁把着门）。",
    "  exitCost          离开代价：离开会留下的把柄/代价/后果（走了之后会被谁惦记、留下什么痕迹）。",
    "  associatedForces  关联势力：暗中盯着或实际掌控此地的势力/组织/人。",
    "  statusTag         状态标签：一句话标签文案，如『高危 · 监控中』『安全屋』『已暴露』。",
    "  statusTone        状态色调：仅能取 warn / danger / neutral 三者之一——危险地点用 danger、需警惕用 warn、中性用 neutral。",
    "",
    "硬规则：",
    "1. 禁编造：byLocation 的键只能是给定地点名，绝不要凭空冒出清单里没有的地点。",
    "2. 厚字段要落实到具体的人、势力、代价，别写『需要权限』『有点危险』这类含糊话；进入限制要点明谁来把门、离开代价要点明留什么把柄。",
    "3. statusTone 只能是 warn / danger / neutral；拿不准就用 warn，绝不要写其它词。",
    "4. 没有把握的字段宁可不写也不要硬凑：某个地点判断不出离开代价就不放 exitCost 这个键；整个地点没什么可补就让它在 byLocation 里只放有把握的字段，甚至整条不放。",
    "5. 要结合给定地点已有的『叙事功能』『已知风险』做厚，让新补的字段和已有设定咬合，不要自相矛盾。",
  ].join("\n");

  const locationLines = locations.map((l, i) => {
    const parts = [
      `名称：${l.name}`,
      l.type && l.type.trim() ? `类型：${l.type.trim()}` : "",
      l.narrativeFunction && l.narrativeFunction.trim() ? `已有叙事功能：${l.narrativeFunction.trim()}` : "",
      l.risks && l.risks.length > 0 ? `已知风险：${l.risks.join("；")}` : "",
      l.status && l.status.trim() ? `当前状态：${l.status.trim()}` : "",
    ].filter(Boolean);
    return `${i + 1}. ${parts.join("　|　")}`;
  });

  const user = [
    "本书已有的地点清单（只能基于这些做厚，键必须逐字取自这里的地点名）：",
    ...locationLines,
    "",
    "请据此输出地点做厚 JSON。",
  ].join("\n");

  return [{ role: "system", content: system }, { role: "user", content: user }];
}

/** 从模型文本里抠出 JSON 并校验。失败抛错（绝不静默放过半成品）。 */
export function parseLocationEnrichment(text: string): LocationEnrichment {
  const match = text.match(/\{[\s\S]*\}/u);
  if (!match) throw new Error("地点做厚结果不是 JSON。");
  const parsed = JSON.parse(match[0]) as unknown;
  return locationEnrichmentSchema.parse(parsed);
}

/**
 * 把地点做厚结果的完整结构落到 UI 侧文件（.story-engine-ui/location-enrichment.json）供面板渲染。
 * 注意：这只是落「完整结构」；其中的厚字段另由 mergeLocationEnrichmentIntoEngine 按地点名
 * 并入 story/location-bible.json 的 extraFields、进正文 prompt（见下）。
 */
export async function persistLocationEnrichment(
  projectDir: string,
  data: LocationEnrichment,
): Promise<{ readonly artifactPath: string }> {
  const artifactPath = join(projectDir, ".story-engine-ui", "location-enrichment.json");
  await mkdir(dirname(artifactPath), { recursive: true });
  await writeFileAtomic(artifactPath, JSON.stringify(data, null, 2));
  return { artifactPath };
}

const LOCATION_FIELD_LABELS: ReadonlyArray<readonly [keyof LocationThickFields, string]> = [
  ["surfaceImpression", "外观印象"], ["entryRestriction", "进入限制"], ["exitCost", "离开代价"], ["associatedForces", "关联势力"], ["statusTag", "状态"],
];

/**
 * 把地点厚字段按地点名匹配并入 location-bible 条目的 extraFields（已确认进正文 prompt）。
 * 三态（R2 停谎报，见 enrichment-merge-result.ts）：无 bible 文件 / 无命中=`{merged:false}` 正常跳过；
 * 真并入≥1 条=`{merged:true}`；写盘异常=`{merged:false, reason:"…失败…"}`。绝不静默吞错后宣称成功。
 */
export async function mergeLocationEnrichmentIntoEngine(projectDir: string, data: LocationEnrichment): Promise<MergeResult> {
  const path = join(projectDir, "story", "location-bible.json");
  let lb: Record<string, unknown>;
  try {
    lb = JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
  } catch (err) {
    // 文件不存在=没有地点圣经，正常跳过；其余读/解析异常（EISDIR、JSON 损坏等）算失败、要如实报。
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { merged: false };
    return { merged: false, reason: `读 story/location-bible.json 失败：${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    const locations = Array.isArray(lb.locations) ? (lb.locations as Array<Record<string, unknown>>) : [];
    let changed = false;
    const seenIds = new Set<string>();
    for (const loc of locations) {
      const name = typeof loc.name === "string" ? loc.name.trim() : "";
      const id = typeof loc.id === "string" ? loc.id.trim() : "";
      if (id && seenIds.has(id)) continue; // 同 id 多条目去重，防串味/重复写
      // 先按 name 字面命中 byLocation 键；name miss 时按 id 经 idMap 桥接到旧键名
      let thick = name ? data.byLocation[name] : undefined;
      if (!thick && id && data.idMap[id]) thick = data.byLocation[data.idMap[id]];
      if (!thick) continue;
      if (id) seenIds.add(id);
      const extra: Record<string, string | readonly string[]> = { ...(loc.extraFields as Record<string, string | readonly string[]> ?? {}) };
      for (const [field, label] of LOCATION_FIELD_LABELS) {
        const v = thick[field];
        if (typeof v === "string" && v.trim()) extra[label] = v.trim();
      }
      loc.extraFields = extra;
      changed = true;
    }
    if (!changed) return { merged: false };
    lb.locations = locations;
    await mkdir(dirname(path), { recursive: true });
    await writeFileAtomic(path, JSON.stringify(lb, null, 2));
    return { merged: true };
  } catch (err) {
    return { merged: false, reason: `写 story/location-bible.json 失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

export function summarizeLocationEnrichment(data: LocationEnrichment, merge: MergeResult): string {
  const locCount = Object.keys(data.byLocation).length;
  const tail = merge.merged
    ? "已写入地点资料，并接进写正文的上下文（外观印象 / 进入限制 / 离开代价进正文），下一章 AI 就能用上；可一键撤销，想改哪条直接跟我说。"
    : "已写入地点展示层资料，但未能接进正文（" + (merge.reason ?? "暂无对应地点条目可并") + "），下一章 AI 暂时用不上；可一键撤销，想改哪条直接跟我说。";
  return [
    "已补全现有地点：",
    `给 ${locCount} 个地点补了表面印象 / 进入限制 / 离开代价 / 关联势力 / 状态标签。`,
    tail,
  ].join("");
}

export interface GenerateLocationEnrichmentResult {
  readonly ok: boolean;
  readonly mergedIntoEngine: boolean;
  readonly summary: string;
  readonly enrichment?: LocationEnrichment;
}

/** 编排：清单为空→ok:false 不调模型；否则 建消息 → 调模型 → 解析校验 → 落盘 → 摘要。callModel 注入，便于单测。 */
export async function generateLocationEnrichment(input: {
  readonly projectDir: string;
  readonly locations: readonly LocationEntityInput[];
  readonly callModel: CallModel;
}): Promise<GenerateLocationEnrichmentResult> {
  if (input.locations.length === 0) {
    return { ok: false, mergedIntoEngine: false, summary: "还没有地点可补全——先把这本书的场景设定整理进资料，再补表面印象、进入限制和离开代价。" };
  }
  const text = await input.callModel(buildLocationEnrichmentMessages(input.locations));
  const parsed = parseLocationEnrichment(text);
  // 注入 id→键名桥接表：锚住生成当次的 id↔name，日后 bible 改名仍能桥接回旧键名命中并入。
  const idMap = Object.fromEntries(
    input.locations
      .filter((l) => l.id && l.id.trim() && l.name.trim())
      .map((l) => [l.id!.trim(), l.name.trim()] as const),
  );
  const enrichment: LocationEnrichment = { ...parsed, idMap: { ...parsed.idMap, ...idMap } };
  await persistLocationEnrichment(input.projectDir, enrichment);
  const merge = await mergeLocationEnrichmentIntoEngine(input.projectDir, enrichment);
  return { ok: true, mergedIntoEngine: merge.merged, summary: summarizeLocationEnrichment(enrichment, merge), enrichment };
}
