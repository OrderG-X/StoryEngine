/**
 * 世界观生成（厚版）——把极简种子扩写成可直接开写的「结构化世界观」。
 *
 * 设计动机（2026-06-16，与用户对齐）：旧路径让 agent「只记录用户确认的几个字」，于是世界观极薄
 * （world-bible 大量字段为空）。这里反过来：用一套「逼写厚 / 禁空话 / 题材感知 / 数量约束 / 关系成网」
 * 的提示词，让模型一次产出结构化、有血有肉、且各部分自洽的世界观，落进项目供展示与后续正文引用。
 *
 * 提示词与数据结构均为本项目原创（借鉴通用提示工程技法，不复制任何第三方文案/代码）。
 * 引擎包零改动：本模块只在 UI 服务层写项目文件——完整结构落到 .story-engine-ui/worldbuilding.json，
 * 同时把头部要点并入引擎读取的 story/world-bible.json（合并去重，写失败不致命但据 MergeResult 如实回报）。
 */
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

import { toSafeLocalId, writeFileAtomic } from "../../lib/project-io.js";
import { appendDedup } from "../enrichment-dedup.js";
import type { MergeResult } from "../enrichment-merge-result.js";

// 模型无关（产品方向）：worldbuilding 输出 schema 必须吃下模型的退化/边角输出——
// 缺嵌套字段 / 空串 / 夹空数组项 / 凭空多塞字段——绝不因单个字段缺失就把整份世界观抛掉
// （E2E 实锤：模型漏 forces[].pressure，旧 nonEmpty+strict 让整份世界观丢失、用户拿到 0）。
// 「逼写厚 / 禁空话」由提示词承担；schema 只负责把残缺归一成 canonical 默认值。
const optStr = z.preprocess((v) => (typeof v === "string" ? v.trim() : ""), z.string());

/** 字符串数组：非数组→[]；逐项 trim、滤空。 */
const strList = z.preprocess(
  (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim().length > 0).map((x) => (x as string).trim()) : []),
  z.array(z.string()),
);

/** 对象（overview/worldRules/storyBinding）：非对象→{}，字段缺失由 optStr/strList 归一。 */
function lenientObj<T extends z.ZodRawShape>(shape: T) {
  return z.preprocess(
    (v) => (v !== null && typeof v === "object" && !Array.isArray(v) ? v : {}),
    z.object(shape),
  );
}

/** 对象数组：非数组→[]；逐项按 shape 归一（缺字段→""、多塞字段剥掉）；丢掉「所有字段都空」的垃圾项。 */
function lenientObjList<T extends z.ZodRawShape>(shape: T) {
  return z.preprocess(
    (v) => (Array.isArray(v) ? v.filter((x) => x !== null && typeof x === "object" && !Array.isArray(x)) : []),
    z.array(z.object(shape)),
  ).transform((arr) => arr.filter((item) =>
    Object.values(item as Record<string, unknown>).some((val) =>
      typeof val === "string" ? val.trim().length > 0 : Array.isArray(val) ? val.length > 0 : Boolean(val),
    ),
  ));
}

export const worldbuildingSchema = z.object({
  overview: lenientObj({
    oneLine: optStr, tone: optStr, coreConflict: optStr,
    // 厚版概要明细（codex 世界概要表）。
    worldName: optStr, genreBase: optStr, era: optStr, coreTheme: optStr,
    toneTags: strList, worldSentence: optStr,
  }),
  // 世界法则·规则层（codex 现实稳定度/超常可见性/真相可达性/叙事限制）。
  worldRules: lenientObj({
    realityStability: optStr, supernaturalVisibility: optStr, truthAccessibility: optStr, narrativeLimit: optStr,
  }),
  socialStructure: strList,
  rules: lenientObjList({ name: optStr, detail: optStr }),
  // 阵营·思想立场（codex 阵营 Factions）。
  factions: lenientObjList({ name: optStr, stance: optStr, longTermGoal: optStr, fear: optStr, narrativeValue: optStr }),
  forces: lenientObjList({
    name: optStr, type: optStr, resources: optStr, objective: optStr, pressure: optStr,
    hiddenObjective: optStr, // 隐藏目标。
  }),
  // 特殊要素·推动情节的机关（codex 特殊要素 Special Elements）。
  specialElements: lenientObjList({ name: optStr, type: optStr, effect: optStr, cost: optStr, controller: optStr, plotValue: optStr }),
  locations: lenientObjList({ name: optStr, type: optStr, function: optStr, risk: optStr }),
  relations: lenientObjList({ from: optStr, to: optStr, relation: optStr, stability: optStr }),
  conflictSources: strList,
  storyEntries: lenientObjList({ title: optStr, hook: optStr }),
  // 本卷绑定·从世界全量裁出的有效切片（codex 本卷绑定 Story Binding）。
  storyBinding: lenientObj({
    activeForces: strList, coreLocations: strList, usedElements: strList,
    conflictTypes: strList, forbidden: strList, toneSupport: strList,
  }),
});

export type Worldbuilding = z.infer<typeof worldbuildingSchema>;

export interface WorldbuildingSeed {
  readonly genre: string;
  readonly premise: string;
  readonly title?: string;
}

export type ChatMessage = { readonly role: "system" | "user"; readonly content: string };
/** 注入式模型调用：传入消息，返回模型文本（应是一个 JSON 对象）。便于单测 mock。 */
export type CallModel = (messages: readonly ChatMessage[]) => Promise<string>;

/**
 * 构造世界观生成消息（本项目原创提示词）。核心技法：结构化 JSON 强约束 + 禁空话 + 题材感知 +
 * 数量下限 + 关系引用已生成势力 + 各部分自洽。
 */
export function buildWorldbuildingMessages(seed: WorldbuildingSeed): ChatMessage[] {
  const system = [
    "你是为长篇小说服务的世界观架构师。把用户给的极简种子，扩写成一份『厚实、可直接开写』的「结构化世界观」。宁可写满写透，不要留空。",
    "只输出一个合法 JSON 对象，不要 Markdown、不要解释、不要代码块。所有文字用简体中文。",
    "",
    "JSON 字段固定（不要增删字段名），每个都要认真填满：",
    "overview{oneLine 一句话故事, tone 基调, coreConflict 核心冲突, worldName 世界名称, genreBase 题材基底, era 时代背景, coreTheme 核心主题(凝练成一句格言，如『人设即资产，欲望即债务』), toneTags[基调标签数组 4~6 个], worldSentence 世界一句话(这个世界最毒辣的一句概括)}",
    "worldRules{realityStability 现实稳定度(如『stable·常识可靠』), supernaturalVisibility 超常可见性(如『无超常·纯现实博弈』), truthAccessibility 真相可达性(如『partial·真相可得但代价极高』), narrativeLimit 叙事限制(冲突限于哪些维度、禁什么)}",
    "socialStructure[字符串数组，自上而下的圈层，每条『名称：怎么运作』]",
    "rules[{name 法则名, detail 详解}]（世界铁律/法典）",
    "factions[{name 阵营名, stance 核心立场, longTermGoal 长期目标, fear 最大恐惧, narrativeValue 叙事价值}]（思想立场而非具体组织，通常 2~3 个对立阵营）",
    "forces[{name, type 类型, resources 资源, objective 明面目标, pressure 施压方式, hiddenObjective 隐藏目标(藏在明面之下的真实算盘)}]（能行动、有资源的组织/圈子）",
    "specialElements[{name 名称, type 类型(物品/契约/情报…), effect 作用, cost 使用代价, controller 掌控者, plotValue 剧情价值}]（推动情节的关键道具/机关，3~5 个）",
    "locations[{name, type, function 叙事功能, risk 风险}]",
    "relations[{from, to, relation 关系描述, stability 稳定性(stable/unstable/temporary)}]",
    "conflictSources[字符串数组，每条『短标题：具体引爆线』]",
    "storyEntries[{title 钩子标题, hook 可直接开写的开局场景}]",
    "storyBinding{activeForces[本卷激活的势力名], coreLocations[核心舞台地点名], usedElements[调用的特殊要素名], conflictTypes[适配的冲突类型], forbidden[本卷禁止的组合/方向], toneSupport[支撑基调的关键词]}（从世界全量里裁出『本卷』真正用到的局部舞台）",
    "",
    "硬规则：",
    "1. 禁空话：不准写「势力纷争」「社会复杂」「充满张力」这类标签；每条都要说清『怎么运作 / 谁控制 / 在哪冲突 / 代价是什么』，能带专有名词、数字、地名就带。",
    "2. 题材感知：都市/现实/婚恋/职场题材里，forces 要落在『公司或部门、资本圈、相亲资源圈、家庭利益共同体、灰色产业、物业/机关』这类现实可行动的群体，别套玄幻门派；玄幻/古代题材则用对应的门派/势力/法则体系。",
    "3. forces 是『能行动、有资源、有目标、能施压』的组织或圈子；绝不要把『前任 / 暧昧对象 / 某个人物』当成势力。",
    "4. relations 的 from/to、storyBinding 里的各项引用，都必须用前面已生成的势力名/地点名/要素名，不要凭空冒出新名字。",
    "5. 数量下限：toneTags≥4、socialStructure≥3、rules≥4、factions≥2、forces≥4、specialElements≥3、locations≥4、relations≥3、conflictSources≥3、storyEntries 给 3 个、storyBinding 各数组≥2。",
    "6. 各部分自洽且互相咬合：阵营立场 ↔ 势力归属、特殊要素 ↔ 冲突来源、本卷绑定 ↔ 开局钩子，不要互相打架。",
    "7. hiddenObjective / specialElements.cost / relations.stability 这些『暗面』字段，是让世界有阴影和张力的关键，务必写出真东西，别敷衍。",
  ].join("\n");

  const user = [
    `题材：${seed.genre}`,
    seed.title ? `书名：${seed.title}` : "",
    `世界种子（就这几个字）：${seed.premise}`,
    "请据此生成完整的结构化世界观 JSON。",
  ].filter(Boolean).join("\n");

  return [{ role: "system", content: system }, { role: "user", content: user }];
}

/**
 * 从模型文本里抠出 JSON 并归一。模型无关：单个嵌套字段缺失/多塞/空串已被 schema 容忍归一，
 * 不再因此整份抛错（E2E 实锤）。但若实质内容近乎全空（模型基本没产出势力/法则/社会结构），
 * 仍抛错回退手写，不写一份空壳世界观——保留「不接受垃圾半成品」的合理内核。
 */
export function parseWorldbuilding(text: string): Worldbuilding {
  const match = text.match(/\{[\s\S]*\}/u);
  if (!match) throw new Error("世界观生成结果不是 JSON。");
  const parsed = JSON.parse(match[0]) as unknown;
  const wb = worldbuildingSchema.parse(parsed);
  if (wb.forces.length === 0 && wb.rules.length === 0 && wb.socialStructure.length === 0) {
    throw new Error("世界观生成结果实质为空（缺势力/法则/社会结构），未采纳。");
  }
  return wb;
}

function dedupeAppend(existing: unknown, additions: readonly string[]): string[] {
  // E1：去重升级到共用 appendDedup（空白折叠 + 前缀含纳），与引擎写/读侧同源。
  const base = Array.isArray(existing) ? existing.filter((x): x is string => typeof x === "string") : [];
  return appendDedup(base, additions);
}

/** 势力富对象（与引擎 WorldBibleFaction / project-io UiWorldBibleFaction 对齐）。 */
interface RichFaction {
  readonly id: string;
  readonly name: string;
  readonly goal: string;
  readonly resources: readonly string[];
}

const FACTION_GOAL_PLACEHOLDER = "维持自身利益和影响力";

/** 把 worldbuilding 的单个 force 合成富对象：goal 由 objective + 施压方式 + 隐藏目标拼接。 */
function forceToFaction(f: Worldbuilding["forces"][number]): RichFaction {
  const goal = [
    f.objective,
    f.pressure ? `施压方式：${f.pressure}` : "",
    f.hiddenObjective ? `隐藏目标：${f.hiddenObjective}` : "",
  ].filter(Boolean).join("；");
  return {
    id: toSafeLocalId(f.name, "faction"),
    name: f.name,
    goal,
    resources: f.resources ? [f.resources] : [],
  };
}

/**
 * 把 forces 富对象并入既有 factions（既有项可能是裸字符串或对象都兼容），按 id||name 去重合并：
 * 用富 goal 升级空 goal 或占位串；resources 取并集；不覆盖已有真 goal。
 */
function mergeRichFactions(existing: unknown, forces: Worldbuilding["forces"]): RichFaction[] {
  const out: RichFaction[] = [];
  const indexByKey = new Map<string, number>();
  const keyOf = (id: string, name: string) => id || name;

  const seedFrom = (id: string, name: string, goal: string, resources: readonly string[]) => {
    const key = keyOf(id, name);
    if (!key) return;
    const at = indexByKey.get(key);
    if (at === undefined) {
      indexByKey.set(key, out.length);
      out.push({ id: id || toSafeLocalId(name, "faction"), name, goal, resources });
      return;
    }
    const cur = out[at];
    const curGoalEmpty = !cur.goal.trim() || cur.goal.trim() === FACTION_GOAL_PLACEHOLDER;
    const nextGoalReal = goal.trim() && goal.trim() !== FACTION_GOAL_PLACEHOLDER;
    const mergedGoal = curGoalEmpty && nextGoalReal ? goal : cur.goal;
    const mergedResources = Array.from(new Set([...cur.resources, ...resources]));
    out[at] = { id: cur.id || id || toSafeLocalId(name, "faction"), name: cur.name || name, goal: mergedGoal, resources: mergedResources };
  };

  if (Array.isArray(existing)) {
    for (const item of existing) {
      if (typeof item === "string") {
        const name = item.trim();
        if (name) seedFrom("", name, "", []);
      } else if (item && typeof item === "object") {
        const rec = item as Record<string, unknown>;
        const name = typeof rec.name === "string" ? rec.name.trim() : "";
        if (!name) continue;
        const id = typeof rec.id === "string" ? rec.id : "";
        const goal = typeof rec.goal === "string" ? rec.goal : "";
        const resources = Array.isArray(rec.resources)
          ? rec.resources.filter((r): r is string => typeof r === "string")
          : [];
        seedFrom(id, name, goal, resources);
      }
    }
  }

  for (const f of forces) {
    const rich = forceToFaction(f);
    seedFrom(rich.id, rich.name, rich.goal, rich.resources);
  }

  return out;
}

/**
 * 把完整结构落到 UI 侧文件，并把头部要点并入引擎读取的 world-bible（合并去重）。
 * 返回 MergeResult 二态（R2 停谎报）：完整结构已在 UI 侧落盘成功（用户东西没丢），
 * 但 world-bible 并入若真出错（读/写/合并异常）→ merged:false + reason，由 summary 如实告知
 * 「只落了资料、没接进正文」，绝不再无条件 catch 后宣称已写入正文。
 */
export async function persistWorldbuilding(
  projectDir: string,
  wb: Worldbuilding,
): Promise<{ readonly artifactPath: string; readonly merge: MergeResult }> {
  const artifactPath = join(projectDir, ".story-engine-ui", "worldbuilding.json");
  await mkdir(dirname(artifactPath), { recursive: true });
  await writeFileAtomic(artifactPath, JSON.stringify(wb, null, 2));

  // 并入引擎 world-bible（合并去重，不覆盖既有）。失败不致命（完整结构已在 UI 侧落盘），
  // 但据 MergeResult 二态如实回报，不再静默吞错。worldbuilding schema 保证 rules/socialStructure/
  // forces/conflictSources 都 ≥1，所以并入成功即 merged:true（必有内容接进正文）。
  let merge: MergeResult;
  try {
    const wbiblePath = join(projectDir, "story", "world-bible.json");
    let bible: Record<string, unknown> = {};
    let rawBible: string | undefined;
    try {
      rawBible = await readFile(wbiblePath, "utf-8");
    } catch (readErr) {
      if ((readErr as { code?: string })?.code !== "ENOENT") throw readErr; // 不存在则新建；其它读错误不吞
    }
    if (rawBible !== undefined) {
      try {
        bible = JSON.parse(rawBible) as Record<string, unknown>;
      } catch {
        // world-bible 损坏：不覆盖、如实回报没接进正文（修 P1·4）。展示层已落盘（上面 artifact）。
        return {
          artifactPath,
          merge: { merged: false, reason: "story/world-bible.json 内容损坏（不是合法 JSON），未并入正文以免覆盖丢数据；请先修复或删除该文件。" },
        };
      }
    }
    bible.rules = dedupeAppend(bible.rules, [
      ...wb.rules.map((r) => `${r.name}：${r.detail}`),
      ...wb.specialElements.map((e) => `特殊要素·${e.name}（${e.type}）：${e.effect}；代价：${e.cost}；掌控：${e.controller}`),
      ...wb.relations.map((r) => `关系·${r.from}↔${r.to}：${r.relation}${r.stability ? `（${r.stability}）` : ""}`),
      ...[wb.worldRules.realityStability, wb.worldRules.supernaturalVisibility, wb.worldRules.truthAccessibility, wb.worldRules.narrativeLimit].filter(Boolean).map((x) => `世界规则：${x}`),
    ]);
    bible.socialOrder = dedupeAppend(bible.socialOrder, wb.socialStructure);
    bible.factions = mergeRichFactions(bible.factions, wb.forces);
    bible.conflictSources = dedupeAppend(bible.conflictSources, wb.conflictSources);
    await mkdir(dirname(wbiblePath), { recursive: true });
    await writeFileAtomic(wbiblePath, JSON.stringify(bible, null, 2));
    merge = { merged: true };
  } catch (err) {
    merge = { merged: false, reason: `并入 story/world-bible.json 失败：${err instanceof Error ? err.message : String(err)}` };
  }

  return { artifactPath, merge };
}

export function summarizeWorldbuilding(wb: Worldbuilding, merge: MergeResult): string {
  const tail = merge.merged
    ? "已写入资料并接进正文（势力 / 规则 / 社会结构 / 冲突源下一章 AI 写作就会用上），可一键撤销；想改任何一块直接跟我说。"
    : `已写入资料展示层，但未能接进正文（${merge.reason ?? "world-bible 并入失败"}），下一章 AI 暂时用不上；可一键撤销，想改任何一块直接跟我说。`;
  return [
    `已生成《${wb.overview.oneLine}》的世界观：`,
    `社会结构 ${wb.socialStructure.length} 条、规则 ${wb.rules.length} 条、势力 ${wb.forces.length} 个`,
    `（${wb.forces.slice(0, 3).map((f) => f.name).join("、")}…）、地点 ${wb.locations.length} 个、`,
    `关系 ${wb.relations.length} 条、冲突源 ${wb.conflictSources.length} 条、开局方向 ${wb.storyEntries.length} 个。`,
    tail,
  ].join("");
}

export interface GenerateWorldbuildingResult {
  readonly ok: boolean;
  readonly summary: string;
  readonly worldbuilding?: Worldbuilding;
  /** 世界观是否真并入引擎 world-bible（进正文）。ok 恒 true（展示层已落盘），此字段区分是否接进正文。 */
  readonly mergedIntoEngine?: boolean;
}

/** 编排：建消息 → 调模型 → 解析校验 → 落盘 → 摘要。callModel 注入，便于单测。 */
export async function generateWorldbuilding(input: {
  readonly projectDir: string;
  readonly seed: WorldbuildingSeed;
  readonly callModel: CallModel;
}): Promise<GenerateWorldbuildingResult> {
  if (!input.seed.premise.trim()) {
    return { ok: false, summary: "还没有可用的世界种子——先用一句话告诉我这个故事大概是什么世界（年代/基调/主角处境）。" };
  }
  const text = await input.callModel(buildWorldbuildingMessages(input.seed));
  const wb = parseWorldbuilding(text);
  const { merge } = await persistWorldbuilding(input.projectDir, wb);
  return { ok: true, mergedIntoEngine: merge.merged, summary: summarizeWorldbuilding(wb, merge), worldbuilding: wb };
}
