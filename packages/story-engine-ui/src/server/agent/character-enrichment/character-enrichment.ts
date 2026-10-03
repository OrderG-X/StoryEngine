/**
 * 角色做厚（enrichment）——给项目「已有的角色」补 codex 角色面板预留的展示层厚字段：
 *   三层人格：core(内核人格) / surface(表层气质) / mask(社交伪装)
 *   驱动短板：innerLack(内部缺失)
 *   表达层：  emotionalExposure(情绪外露)
 *   日常层：  dailyAnchors(日常锚点 string[])
 *   成长弧：  arcStart(起点误区) / arcSetback(第一卷挫败) / arcCost(关键代价)
 *
 * 设计动机 & 与 worldbuilding 的关键差异（2026-06-17）：worldbuilding 从「种子」凭空生成；
 * enrichment 必须从「项目现有实体」出发——把真实角色矩阵（角色名 / 身份 / 角色定位 / 已知短板等）注入提示词，
 * 让模型**只按真实角色名为键**产出厚字段，绝不许编造不存在的角色。
 *
 * 落盘 + 并入引擎（里程碑3，2026-06-18）：完整结构落 .story-engine-ui/character-enrichment.json 供面板；
 * 同时 mergeCharacterEnrichmentIntoEngine 把三层人格 / 成长弧 / 情绪外露 / 日常锚点按中文键并进
 * story/character-bible.json 的角色 extraFields——引擎 writing-context-pack 会把 extraFields 渲染进正文 prompt
 * （主角→protagonistContext.extraFields、配角→supportingCast.traits），让做厚真到纸面而非只在面板好看。
 *
 * 落盘结构 byCharacter: Record<角色名, CharacterEnrichmentEntry>，对齐 CharacterCodexPanel 的
 * enrichment?: Readonly<Record<string, CharacterCodexEnrichment>>（按角色名索引）。
 *
 * 提示词与数据结构均为本项目原创（借鉴通用提示工程技法，不复制任何第三方文案/代码）。
 */
import { mkdir, readFile } from "node:fs/promises";
import { writeFileAtomic } from "../../lib/project-io.js";
import { dirname, join } from "node:path";
import { z } from "zod";

import type { MergeResult } from "../enrichment-merge-result.js";

const trimmed = z.string().trim();

/** 单个角色一组厚字段，对齐 CharacterCodexPanel 的 CharacterCodexEnrichment。 */
export const characterEnrichmentEntrySchema = z.object({
  /** 内核人格（layer3.core）：与副标题 identity 是不同文案。 */
  core: trimmed.optional(),
  /** 表层气质（layer3.surf）。 */
  surface: trimmed.optional(),
  /** 社交伪装（layer3.mask）。 */
  mask: trimmed.optional(),
  /** 内部缺失（drive3）。 */
  innerLack: trimmed.optional(),
  /** 情绪外露（.voice）。 */
  emotionalExposure: trimmed.optional(),
  /** 日常锚点（.char-row「日常锚点」）。 */
  dailyAnchors: z.array(trimmed.min(1)).default([]),
  /** 成长弧 P1 起点误区。 */
  arcStart: trimmed.optional(),
  /** 成长弧 P2 第一卷挫败。 */
  arcSetback: trimmed.optional(),
  /** 成长弧 P3 关键代价。 */
  arcCost: trimmed.optional(),
}).strict();

export type CharacterEnrichmentEntry = z.infer<typeof characterEnrichmentEntrySchema>;

export const characterEnrichmentSchema = z.object({
  /** 角色名 → 该角色的厚字段（key 必须逐字取自给定角色名）。 */
  byCharacter: z.record(z.string(), characterEnrichmentEntrySchema).default({}),
  /** id → byCharacter 键名的桥接表（可选，向后兼容旧数据无此字段=纯按名字匹配）。改名后用 id 桥回旧键名命中并入。 */
  idMap: z.record(z.string(), z.string()).default({}),
}).strict();

export type CharacterEnrichment = z.infer<typeof characterEnrichmentSchema>;

/** 喂给提示词的「已有角色」一条——名/身份/定位/已知短板等，让模型据真实实体做厚。 */
export interface CharacterEntityInput {
  /** 引擎 character-bible 条目的稳定 id（来自 StateOverview item）。用于改名后经 idMap 桥接命中并入。 */
  readonly id?: string;
  readonly name: string;
  readonly identity?: string;
  readonly role?: string;
  readonly desire?: string;
  readonly fear?: string;
  readonly weakness?: string;
  readonly currentGoal?: string;
}

export type ChatMessage = { readonly role: "system" | "user"; readonly content: string };
/** 注入式模型调用：传入消息，返回模型文本（应是一个 JSON 对象）。便于单测 mock。 */
export type CallModel = (messages: readonly ChatMessage[]) => Promise<string>;

/**
 * 构造角色做厚生成消息（本项目原创提示词）。核心技法：只输出 JSON + 按真实角色名为键 +
 * 禁编造 + 三层人格各司其职 + 成长弧三步要具体可演 + 字段无把握宁缺勿凑。
 */
export function buildCharacterEnrichmentMessages(characters: readonly CharacterEntityInput[]): ChatMessage[] {
  const system = [
    "你是为长篇小说服务的『角色塑造』审校助手。下面会给你这本书**已经存在**的角色清单。",
    "你的任务：为这些已有角色补展示层厚字段——三层人格、内部缺失、情绪外露、日常锚点、成长弧三步。宁可写具体能演，不要写空话标签。",
    "只输出一个合法 JSON 对象，不要 Markdown、不要解释、不要代码块。所有文字用简体中文。",
    "",
    "JSON 顶层只有一个字段：",
    "byCharacter{ 角色名: {core, surface, mask, innerLack, emotionalExposure, dailyAnchors[], arcStart, arcSetback, arcCost} }",
    "（对象，键必须逐字取自下方给定的角色名，不要新造角色、不要改写名字）",
    "",
    "每个角色的字段含义（无把握的字段可省略，dailyAnchors 没有就给空数组）：",
    "core 内核人格：这个人骨子里是什么样的人（一句话内核，不要复述身份头衔）。",
    "surface 表层气质：外人第一眼感受到的气质、做派。",
    "mask 社交伪装：他在外人面前刻意端起的样子，与内核的落差。",
    "innerLack 内部缺失：他自己缺的那块（能力/情感/认知的洞），是成长弧的发动机。",
    "emotionalExposure 情绪外露：情绪上来时身体/语气会泄露什么（微表情、小动作、口头禅走样）。",
    "dailyAnchors 日常锚点：能反复出现、让读者记住这个人的具体生活细节（数组，每条一个具体锚点）。",
    "arcStart 成长弧·起点误区：开篇时他对自己/世界的错误认知。",
    "arcSetback 成长弧·第一卷挫败：把这个误区第一次撞碎的具体事件方向。",
    "arcCost 成长弧·关键代价：他要成长必须付出的、最舍不得的代价。",
    "",
    "硬规则：",
    "1. 禁编造：byCharacter 的键只能是给定角色名，逐字一致；绝不要凭空冒出清单里没有的角色，也不要把同一个人拆成两个键。",
    "2. 三层人格要有落差、各司其职：core 是骨子里、surface 是外人观感、mask 是刻意装出来的；三者别写成同一句话的近义改写。",
    "3. 成长弧三步要能演：arcStart/arcSetback/arcCost 串起来应是一条「误区→撞碎→付代价」的可写路径，别写『慢慢成长』这类空话。",
    "4. 紧扣已给信息：若清单里已标了某角色的恐惧/短板/目标，做厚要顺着它写，别另起炉灶造一个互相矛盾的人。",
    "5. 没有把握的字段宁可省略也不要硬凑：某角色想不出社交伪装就不写 mask；dailyAnchors 想不出具体细节就给空数组，绝不编造。",
  ].join("\n");

  const charLines = characters.map((c, i) => {
    const parts = [
      `角色名：${c.name}`,
      c.role && c.role.trim() ? `定位：${c.role.trim()}` : "",
      c.identity && c.identity.trim() ? `身份：${c.identity.trim()}` : "",
      c.desire && c.desire.trim() ? `渴望：${c.desire.trim()}` : "",
      c.currentGoal && c.currentGoal.trim() ? `当前目标：${c.currentGoal.trim()}` : "",
      c.fear && c.fear.trim() ? `恐惧：${c.fear.trim()}` : "",
      c.weakness && c.weakness.trim() ? `短板：${c.weakness.trim()}` : "",
    ].filter(Boolean);
    return `${i + 1}. ${parts.join("　|　")}`;
  });

  const names = characters.map((c) => c.name.trim()).filter((n) => n.length > 0);

  const user = [
    "本书已有的角色清单（只能基于这些做厚，byCharacter 的键必须逐字取自这里的角色名）：",
    ...charLines,
    "",
    names.length > 0 ? `byCharacter 的键只能取自这些角色名：${names.join("、")}` : "（清单为空）",
    "",
    "请据此输出角色做厚 JSON。",
  ].join("\n");

  return [{ role: "system", content: system }, { role: "user", content: user }];
}

/** 从模型文本里抠出 JSON 并校验。失败抛错（绝不静默放过半成品）。 */
export function parseCharacterEnrichment(text: string): CharacterEnrichment {
  const match = text.match(/\{[\s\S]*\}/u);
  if (!match) throw new Error("角色做厚结果不是 JSON。");
  const parsed = JSON.parse(match[0]) as unknown;
  return characterEnrichmentSchema.parse(parsed);
}

/**
 * 把角色做厚结果落到 UI 侧文件（.story-engine-ui/character-enrichment.json）供面板按角色名读盘。
 * 注：这只是展示层落盘；做厚字段**确会**经 mergeCharacterEnrichmentIntoEngine 并入引擎 character-bible
 * 的 extraFields、渲染进正文 prompt（见下方 merge 函数），并非「引擎不消费/零改动」——编排两步都跑。
 */
export async function persistCharacterEnrichment(
  projectDir: string,
  data: CharacterEnrichment,
): Promise<{ readonly artifactPath: string }> {
  const artifactPath = join(projectDir, ".story-engine-ui", "character-enrichment.json");
  await mkdir(dirname(artifactPath), { recursive: true });
  await writeFileAtomic(artifactPath, JSON.stringify(data, null, 2));
  return { artifactPath };
}

/** 做厚标量字段 → character-bible extraFields 的中文键。dailyAnchors(数组)单独处理。 */
const ENRICHMENT_FIELD_LABELS: Readonly<Record<string, string>> = {
  core: "内核人格",
  surface: "表层气质",
  mask: "社交伪装",
  innerLack: "内部缺失",
  emotionalExposure: "情绪外露",
  arcStart: "成长弧·起点误区",
  arcSetback: "成长弧·第一卷挫败",
  arcCost: "成长弧·关键代价",
};

/**
 * 把角色做厚结果并入引擎读的 story/character-bible.json：按**角色名**匹配，将三层人格 / 内部缺失 /
 * 情绪外露 / 日常锚点 / 成长弧写进该角色的 extraFields（中文键，spread 既有字段不 clobber）。
 * 引擎 writing-context-pack 会把 extraFields 渲染进正文 prompt（主角→protagonistContext、配角→supportingCast）。
 * 返回 MergeResult 三态（R2 停谎报，绝不静默吞错）：真并入≥1条→{merged:true}；
 * 缺 bible 文件 / bible 为空 / 无角色命中→{merged:false}（属正常跳过，完整结构已在 .story-engine-ui 落盘）；
 * 写盘真异常→{merged:false, reason:"写 story/character-bible.json 失败：…"}。整件做厚不因并入失败而报错（ok 仍 true），
 * 但失败时 summary 据 reason 如实告知「未能接进正文」。
 */
export async function mergeCharacterEnrichmentIntoEngine(
  projectDir: string,
  data: CharacterEnrichment,
): Promise<MergeResult> {
  const biblePath = join(projectDir, "story", "character-bible.json");
  let bible: Record<string, unknown>;
  try {
    bible = JSON.parse(await readFile(biblePath, "utf-8")) as Record<string, unknown>;
  } catch {
    return { merged: false }; // 没有 bible 文件就不并（完整结构已落 UI 文件，属正常跳过）
  }
  try {
    const characters = Array.isArray(bible.characters) ? (bible.characters as Array<Record<string, unknown>>) : [];
    if (characters.length === 0) return { merged: false };

    let changed = false;
    const seenIds = new Set<string>();
    for (const character of characters) {
      const name = typeof character.name === "string" ? character.name.trim() : "";
      const id = typeof character.id === "string" ? character.id.trim() : "";
      if (id && seenIds.has(id)) continue; // 同 id 多条目去重，防串味/重复写
      // 先按 name 字面命中；name miss 时按条目 id 经 idMap 桥接到旧键名
      let entry = name ? data.byCharacter[name] : undefined;
      if (!entry && id && data.idMap[id]) entry = data.byCharacter[data.idMap[id]];
      if (!entry) continue;
      if (id) seenIds.add(id);
      const extra: Record<string, string | readonly string[]> = {
        ...((character.extraFields as Record<string, string | readonly string[]> | undefined) ?? {}),
      };
      for (const [field, label] of Object.entries(ENRICHMENT_FIELD_LABELS)) {
        const value = (entry as Record<string, unknown>)[field];
        if (typeof value === "string" && value.trim()) extra[label] = value.trim();
      }
      const anchors = entry.dailyAnchors.map((anchor) => anchor.trim()).filter((anchor) => anchor.length > 0);
      if (anchors.length > 0) extra["日常锚点"] = anchors;
      character.extraFields = extra;
      changed = true;
    }
    if (!changed) return { merged: false };
    bible.characters = characters;
    await writeFileAtomic(biblePath, JSON.stringify(bible, null, 2));
    return { merged: true };
  } catch (err) {
    return { merged: false, reason: `写 story/character-bible.json 失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

export function summarizeCharacterEnrichment(data: CharacterEnrichment, merge: MergeResult): string {
  const entries = Object.values(data.byCharacter);
  const charCount = Object.keys(data.byCharacter).length;
  const arcCount = entries.filter((e) => e.arcStart || e.arcSetback || e.arcCost).length;
  const anchorCount = entries.reduce((sum, e) => sum + e.dailyAnchors.length, 0);
  const head = [
    "已补全现有角色：",
    `补了 ${charCount} 个角色的内核/表层/伪装三层人格与情绪外露、`,
    `${arcCount} 个角色的成长弧三步、`,
    `${anchorCount} 条日常锚点。`,
  ].join("");
  const tail = merge.merged
    ? "已写入角色资料，并接进写正文的上下文（主角的厚字段进角色卡、配角进关系名单），下一章 AI 就能用上；可一键撤销，想改哪条直接跟我说。"
    : `已写入角色展示层资料，但未能接进正文（${merge.reason ?? "原因未知"}），下一章 AI 暂时用不上；可一键撤销，想改哪条直接跟我说。`;
  return head + tail;
}

export interface GenerateCharacterEnrichmentResult {
  readonly ok: boolean;
  readonly summary: string;
  readonly enrichment?: CharacterEnrichment;
  /** 做厚字段是否真并入引擎 character-bible（进正文 prompt）。ok 恒 true，此字段区分是否进正文。 */
  readonly mergedIntoEngine: boolean;
}

/** 编排：清单为空→ok:false 不调模型；否则 建消息 → 调模型 → 解析校验 → 落盘 → 摘要。callModel 注入，便于单测。 */
export async function generateCharacterEnrichment(input: {
  readonly projectDir: string;
  readonly characters: readonly CharacterEntityInput[];
  readonly callModel: CallModel;
}): Promise<GenerateCharacterEnrichmentResult> {
  if (input.characters.length === 0) {
    return {
      ok: false,
      mergedIntoEngine: false,
      summary: "还没有角色可补全——先把主要角色写进角色资料，再补三层人格、成长弧和日常锚点。",
    };
  }
  const text = await input.callModel(buildCharacterEnrichmentMessages(input.characters));
  const parsed = parseCharacterEnrichment(text);
  // 注入 id→键名 桥接表：模型按 name 产 byCharacter 键，生成当次 id 与 name 一致；
  // 锚住生成当次的 id↔name，日后 bible name 被改也能经 id 桥回旧键名命中并入。
  const idMap = Object.fromEntries(
    input.characters
      .filter((c) => c.id && c.id.trim() && c.name && c.name.trim())
      .map((c) => [c.id!.trim(), c.name.trim()]),
  );
  const enrichment: CharacterEnrichment = { ...parsed, idMap };
  await persistCharacterEnrichment(input.projectDir, enrichment);
  const merge = await mergeCharacterEnrichmentIntoEngine(input.projectDir, enrichment);
  return {
    ok: true,
    mergedIntoEngine: merge.merged,
    summary: summarizeCharacterEnrichment(enrichment, merge),
    enrichment,
  };
}
