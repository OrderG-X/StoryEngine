/**
 * 角色矩阵做厚（enrichment）——给项目「已有角色 / 已有关系对」补两类 UI 展示层厚字段：
 *   ① 叙事岗位（matrixOverrides：character.id → narrativeRole，如「主角推动者 / 鱼饵 / 压力源」）
 *   ② 关系账本厚字段（relationshipExtras：relationshipKey → 双名/情感债/红线/下一次转折）
 *
 * 注：信任度由引擎确定性三档（canonical resolveTrust）权威派生百分比，本做厚**不产精确信任度**。
 *
 * 设计动机 & 与 worldbuilding 的关键差异（2026-06-17）：worldbuilding 从「种子」凭空生成；
 * enrichment 必须从「项目现有实体」出发——把真实角色清单（id/名/职能）与真实关系对清单
 * （relationshipKey = `${targetCharacterId||targetName}|${relationType}`）注入提示词，
 * 让模型**只按真实 character.id 与真实 relationshipKey 为键**产出厚字段，绝不许编造不存在的角色或关系。
 *
 * 引擎包零改动：叙事岗位 / 关系账本厚字段纯属 UI 展示层补充，只落到
 * .story-engine-ui/matrix-enrichment.json，绝不并入引擎读取的任何文件（对照 worldbuilding 会并入
 * world-bible，这里刻意不做——这些字段引擎不消费）。
 *
 * 键对齐铁律（见 CharacterMatrixCodexPanel）：matrixOverrides 的键 = character.id（不是 name）；
 * relationshipExtras 的键 = relationshipKey()，即 `${id||name}|${relationType}`。键拼错做厚就白做。
 *
 * 提示词与数据结构均为本项目原创（借鉴通用提示工程技法，不复制任何第三方文案/代码）。
 */
import { mkdir, readFile } from "node:fs/promises";
import { writeFileAtomic } from "../../lib/project-io.js";
import { dirname, join } from "node:path";
import { z } from "zod";

import { appendDedup } from "../enrichment-dedup.js";
import type { MergeResult } from "../enrichment-merge-result.js";

const matrixOverrideSchema = z.object({
  /** 叙事岗位（创作功能位）。 */
  narrativeRole: z.string().trim().optional(),
}).strict();

const relationshipExtraSchema = z.object({
  /** 关系对另一端名字（A⇄B 双名）。 */
  pairWith: z.string().trim().optional(),
  /** 关系对发起方名字（默认即主角）。 */
  pairFrom: z.string().trim().optional(),
  /** 情感债。 */
  emotionalDebt: z.string().trim().optional(),
  /** 关系红线。 */
  redline: z.string().trim().optional(),
  /** 下一次转折。 */
  nextTurn: z.string().trim().optional(),
}).strict();

export const matrixEnrichmentSchema = z.object({
  /** character.id → 叙事岗位覆盖（key 必须取自给定角色 id）。 */
  matrixOverrides: z.record(z.string(), matrixOverrideSchema).default({}),
  /** relationshipKey → 关系账本厚字段（key 必须逐字取自给定的关系键）。 */
  relationshipExtras: z.record(z.string(), relationshipExtraSchema).default({}),
  /** D·账本时效：本批做厚生成于第几章（落盘时由引擎当前章戳，非 GLM 产）；面板据此与当前章比，远超则提示「可能已过期」。 */
  generatedAtChapter: z.number().int().min(1).optional(),
}).strict();

export type MatrixEnrichment = z.infer<typeof matrixEnrichmentSchema>;
export type CharacterMatrixOverride = z.infer<typeof matrixOverrideSchema>;
export type CharacterRelationshipExtra = z.infer<typeof relationshipExtraSchema>;

/** 喂给提示词的「已有角色」一条——id/名/职能，让模型按真实 id 为键补叙事岗位。 */
export interface MatrixCharacterInput {
  readonly id: string;
  readonly name: string;
  readonly role?: string;
  readonly roleHint?: string;
}

/** 喂给提示词的「已有关系对」一条——带预先算好的 relationshipKey（与面板拼法逐字一致）。 */
export interface MatrixRelationshipInput {
  /** 与面板 relationshipKey() 完全一致：`${targetCharacterId||targetName}|${relationType}`。 */
  readonly key: string;
  /** 发起方名字（默认即主角，供模型理解方向）。 */
  readonly fromName?: string;
  readonly targetName: string;
  readonly relationType: string;
  readonly attitude?: string;
  readonly trustLevel?: "low" | "medium" | "high";
  readonly conflict?: string;
  readonly secret?: string;
}

export type ChatMessage = { readonly role: "system" | "user"; readonly content: string };
/** 注入式模型调用：传入消息，返回模型文本（应是一个 JSON 对象）。便于单测 mock。 */
export type CallModel = (messages: readonly ChatMessage[]) => Promise<string>;

/**
 * 构造角色矩阵做厚生成消息（本项目原创提示词）。核心技法：只输出 JSON + 按真实 character.id 与
 * 真实 relationshipKey 为键 + 禁编造 + 叙事岗位是创作功能位 + 关系账本要落到具体红线/转折。
 * 注：信任度以引擎确定性三档为权威（不再让 AI 产精确百分比），故本提示词不要 trustPercent。
 */
export function buildMatrixEnrichmentMessages(
  characters: readonly MatrixCharacterInput[],
  relationships: readonly MatrixRelationshipInput[],
): ChatMessage[] {
  const system = [
    "你是为长篇小说服务的『角色矩阵 / 关系账本』审校助手。下面会给你这本书**已经存在**的角色清单与关系对清单。",
    "你的任务：为这些已有角色补『叙事岗位』，为这些已有关系对补『情感债 / 关系红线 / 下一次转折 / 双名方向』。宁可写具体，不要写空话。",
    "只输出一个合法 JSON 对象，不要 Markdown、不要解释、不要代码块。所有文字用简体中文。",
    "",
    "JSON 字段固定（不要增删字段名）：",
    "matrixOverrides{ 角色id: { narrativeRole: 叙事岗位 } }（对象，键必须逐字取自下方给定的角色 id，不是名字、不要新造角色）",
    "relationshipExtras{ 关系键: { pairFrom?, pairWith?, emotionalDebt?, redline?, nextTurn? } }（对象，键必须逐字取自下方给定的关系键）",
    "",
    "硬规则：",
    "1. 禁编造：matrixOverrides 的键只能是给定的角色 id（不是角色名！），relationshipExtras 的键只能是给定的关系键，逐字照抄；绝不要凭空冒出清单里没有的角色或关系。",
    "2. 叙事岗位 narrativeRole 写『这个角色在故事里承担的创作功能位』，例如『主角推动者 / 鱼饵 / 压力源 / 镜像对照 / 引路人 / 障碍方』，要点出他推动剧情的作用，别只复述身份职业。",
    "3. 关系厚字段要落到具体、可执行：emotionalDebt 情感债写谁欠谁什么（如『甲欠乙一次没说破的提携』）；redline 关系红线写此刻绝不能越的界（如『第 1 章不可当面翻脸』）；nextTurn 下一次转折写这对关系接下来该往哪走。",
    "4. pairFrom / pairWith 用于渲染 A⇄B 双名：pairFrom 填发起方名字（默认即主角），pairWith 一般留空（目标方名字已知）；只有当你想强调对向时才补。",
    "5. 没有把握的字段宁可少写也不要硬凑：某个角色想不出叙事岗位就不放进 matrixOverrides；某对关系补不出厚字段就不放进 relationshipExtras；单条厚字段拿不准就省略该字段，绝不编造。",
  ].join("\n");

  const charLines = characters.map((c, i) => {
    const parts = [
      `id：${c.id}`,
      `名称：${c.name}`,
      c.role && c.role.trim() ? `身份/职能：${c.role.trim()}` : "",
      c.roleHint && c.roleHint.trim() ? `职能提示：${c.roleHint.trim()}` : "",
    ].filter(Boolean);
    return `${i + 1}. ${parts.join("　|　")}`;
  });

  const relLines = relationships.map((r, i) => {
    const parts = [
      `关系键：${r.key}`,
      r.fromName && r.fromName.trim() ? `发起方：${r.fromName.trim()}` : "发起方：主角",
      `目标方：${r.targetName}`,
      `关系类型：${r.relationType}`,
      r.attitude && r.attitude.trim() ? `态度：${r.attitude.trim()}` : "",
      r.trustLevel ? `信任档：${r.trustLevel}` : "",
      r.conflict && r.conflict.trim() ? `隐性矛盾：${r.conflict.trim()}` : "",
      r.secret && r.secret.trim() ? `信息不对称：${r.secret.trim()}` : "",
    ].filter(Boolean);
    return `${i + 1}. ${parts.join("　|　")}`;
  });

  const user = [
    "本书已有的角色清单（matrixOverrides 的键只能取自这里的『角色 id』，不是名字）：",
    ...charLines,
    "",
    relationships.length > 0
      ? "本书已有的关系对清单（relationshipExtras 的键只能逐字取自这里的『关系键』）："
      : "（暂无关系对，relationshipExtras 输出空对象即可）",
    ...relLines,
    "",
    "请据此输出角色矩阵做厚 JSON。",
  ].join("\n");

  return [{ role: "system", content: system }, { role: "user", content: user }];
}

/** 从模型文本里抠出 JSON 并校验。失败抛错（绝不静默放过半成品）。 */
export function parseMatrixEnrichment(text: string): MatrixEnrichment {
  const match = text.match(/\{[\s\S]*\}/u);
  if (!match) throw new Error("角色矩阵做厚结果不是 JSON。");
  const parsed = JSON.parse(match[0]) as unknown;
  return matrixEnrichmentSchema.parse(parsed);
}

/**
 * 把角色矩阵做厚结果落到 UI 侧文件（.story-engine-ui/matrix-enrichment.json）。
 * 刻意**不**并入引擎任何文件——叙事岗位/关系账本厚字段是展示层补充，引擎不消费、零改动。
 */
export async function persistMatrixEnrichment(
  projectDir: string,
  data: MatrixEnrichment,
): Promise<{ readonly artifactPath: string }> {
  const artifactPath = join(projectDir, ".story-engine-ui", "matrix-enrichment.json");
  await mkdir(dirname(artifactPath), { recursive: true });
  await writeFileAtomic(artifactPath, JSON.stringify(data, null, 2));
  return { artifactPath };
}

/** 关系账本厚字段 → relationshipDynamics 短句（情感债 > 红线 > 转折）。信任度由引擎三档承载，不进此账本。 */
function relationshipLines(extra: CharacterRelationshipExtra): string[] {
  const lines: string[] = [];
  if (extra.emotionalDebt?.trim()) lines.push(`情感债：${extra.emotionalDebt.trim()}`);
  if (extra.redline?.trim()) lines.push(`关系红线：${extra.redline.trim()}`);
  if (extra.nextTurn?.trim()) lines.push(`下一次转折：${extra.nextTurn.trim()}`);
  return lines;
}

/**
 * 把角色矩阵做厚并入引擎读的 story/character-bible.json（引擎零改动、经 supportingCast 进正文）：
 *  - matrixOverrides[character.id].narrativeRole → 该角色 extraFields["叙事岗位"]（spread 既有不 clobber）
 *  - relationshipExtras[`${targetId||targetName}|type`] → 解析目标 → 该配角 relationshipDynamics 追加关系账本短句（去重）
 * 返回 MergeResult 三态（R2 停谎报）。只追加不覆盖 foundation 写的关系字段。
 */
export async function mergeMatrixEnrichmentIntoEngine(
  projectDir: string,
  data: MatrixEnrichment,
): Promise<MergeResult> {
  const biblePath = join(projectDir, "story", "character-bible.json");
  let bible: Record<string, unknown>;
  try {
    bible = JSON.parse(await readFile(biblePath, "utf-8")) as Record<string, unknown>;
  } catch {
    return { merged: false };
  }
  try {
    const characters = Array.isArray(bible.characters) ? (bible.characters as Array<Record<string, unknown>>) : [];
    if (characters.length === 0) return { merged: false };

    // 预解析 relationshipExtras：目标键（targetId 或 targetName）→ 关系账本短句累积
    const relByTarget = new Map<string, string[]>();
    for (const [key, extra] of Object.entries(data.relationshipExtras)) {
      const target = (key.split("|")[0] ?? "").trim();
      if (!target) continue;
      const lines = relationshipLines(extra);
      if (lines.length === 0) continue;
      relByTarget.set(target, [...(relByTarget.get(target) ?? []), ...lines]);
    }

    let changed = false;
    const seenIds = new Set<string>();
    for (const character of characters) {
      const name = typeof character.name === "string" ? character.name.trim() : "";
      const id = typeof character.id === "string" ? character.id.trim() : "";
      if (id && seenIds.has(id)) continue;

      const override = id ? data.matrixOverrides[id] : undefined;
      const relLines = relByTarget.get(id) ?? (name ? relByTarget.get(name) : undefined) ?? [];
      const hasOverride = Boolean(override?.narrativeRole?.trim());
      if (!hasOverride && relLines.length === 0) continue;
      if (id) seenIds.add(id);

      if (hasOverride) {
        const extra: Record<string, string | readonly string[]> = {
          ...((character.extraFields as Record<string, string | readonly string[]> | undefined) ?? {}),
        };
        extra["叙事岗位"] = override!.narrativeRole!.trim();
        character.extraFields = extra;
      }
      if (relLines.length > 0) {
        const existing = Array.isArray(character.relationshipDynamics)
          ? (character.relationshipDynamics as string[]).map((s) => `${s}`.trim()).filter(Boolean)
          : [];
        // E1：去重升级到共用 appendDedup（空白折叠 + 前缀含纳），与引擎写/读侧同源。
        character.relationshipDynamics = appendDedup(existing, relLines);
      }
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

export function summarizeMatrixEnrichment(data: MatrixEnrichment, merge: MergeResult): string {
  const roleCount = Object.keys(data.matrixOverrides).length;
  const relCount = Object.keys(data.relationshipExtras).length;
  const tail = merge.merged
    ? "已写入角色矩阵并接进正文（叙事岗位进角色卡、关系账本进配角关系名单），下一章 AI 写作就会用上；可一键撤销，想改哪条直接跟我说。"
    : `已写入角色矩阵展示层资料，但未能接进正文（${merge.reason ?? "暂无可并入的已登记角色"}），下一章 AI 暂时用不上；可一键撤销，想改哪条直接跟我说。`;
  return `已补全现有角色关系：标了 ${roleCount} 个角色的叙事岗位、补了 ${relCount} 对关系的情感债 / 红线 / 下一次转折。${tail}`;
}

export interface GenerateMatrixEnrichmentResult {
  readonly ok: boolean;
  readonly summary: string;
  readonly enrichment?: MatrixEnrichment;
  /** 做厚是否真并入引擎 character-bible（进正文）。ok 恒 true（展示层已落盘），此字段区分是否接进正文。 */
  readonly mergedIntoEngine: boolean;
}

/** 编排：角色清单为空→ok:false 不调模型；否则 建消息 → 调模型 → 解析校验 → 落盘 → 摘要。callModel 注入，便于单测。 */
export async function generateMatrixEnrichment(input: {
  readonly projectDir: string;
  readonly characters: readonly MatrixCharacterInput[];
  readonly relationships: readonly MatrixRelationshipInput[];
  readonly callModel: CallModel;
  /** D·账本时效：落盘时戳上「本批生成于第几章」（引擎当前章），面板据此判过期。 */
  readonly currentChapter?: number;
}): Promise<GenerateMatrixEnrichmentResult> {
  if (input.characters.length === 0) {
    return { ok: false, mergedIntoEngine: false, summary: "还没有角色关系可补全——先把角色资料搭起来，再标注叙事岗位、补充关系里的情感债与红线。" };
  }
  const text = await input.callModel(buildMatrixEnrichmentMessages(input.characters, input.relationships));
  const enrichment: MatrixEnrichment = {
    ...parseMatrixEnrichment(text),
    ...(typeof input.currentChapter === "number" ? { generatedAtChapter: input.currentChapter } : {}),
  };
  await persistMatrixEnrichment(input.projectDir, enrichment);
  const merge = await mergeMatrixEnrichmentIntoEngine(input.projectDir, enrichment);
  return { ok: true, mergedIntoEngine: merge.merged, summary: summarizeMatrixEnrichment(enrichment, merge), enrichment };
}
