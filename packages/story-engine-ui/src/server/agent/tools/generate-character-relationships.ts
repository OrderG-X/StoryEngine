/**
 * generate_character_relationships — 写类工具：用户说「整理人物关系」时，从硬事实账本
 * （story/fact-ledger.json）出发，调 GLM 整理出【真实出现的具名人物 roster + 人物关系】，
 * 再把结果落盘，让角色矩阵的「总览表 / 关系账本 / 关系网」三视图一起活起来：
 *
 *   ① 人物 roster → story/character-matrix.json 的 status:"candidate" 条目
 *      （绝不建正式卡：只写 candidate；既有 accepted/promoted/ignored 条目永不被 candidate 降级——
 *       完全复刻引擎 commit-engine.buildCharacterMatrixFile 的 merge 语义；该函数引擎内未导出，
 *       此处镜像其 mergeCharacterMatrixStatus + 按 id 合并的逻辑，确定性、零 LLM、题材中立）。
 *      roster 里的 relationToProtagonist 字段驱动关系网中各人物与主角的连边。
 *
 *      更细的关系厚字段（情感债/红线/信任%）请用「做厚」（generate_matrix_enrichment）生成：
 *      该工具写的键格式与面板消费侧一致，才能正确展示在关系账本中。
 *
 * 持久化路径决策（recon 后）：本工具不是在入库一章草稿（没有 draft），commitFastDraft 需要
 * chapter+draftPath，故走不通 brief 设想的 commit plan → commitFastDraft 路径。引擎的
 * buildCharacterMatrixFile 未 export 不能直接复用，因此退而：读现有 character-matrix.json
 * （readCharacterMatrixLedger，已 export）→ 用引擎同款 merge 语义并入 candidate updates → 原子写回。
 * 既尊重既有条目、又脱离整章 commit、又只产出 candidate（不建正式卡）。
 *
 * 铁律：直接做 + 可撤销（writeTool 前置快照）；绝不静默失败（facts 空 ok:false、人物空 ok:false、
 * 模型/解析出错抛错）；题材中立（一切以 fact-ledger 真实事实为准、不预设关系/世界观）。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  readCharacterMatrixLedger,
  type CharacterMatrixEntry,
  type CharacterMatrixLedger,
  type CharacterMatrixUpdate,
} from "@actalk/story-engine";
import { z } from "zod";

import { writeTool } from "../withSnapshot.js";
import { callOpenAICompatibleChatModel, resolveConfiguredChatModel } from "../../lib/llm-client.js";
import { readFactLedger } from "../fact-ledger/fact-ledger.js";
import { appendDedup } from "../enrichment-dedup.js";
import { resolveChapterFromInputOrContext } from "../request-context.js";
import {
  buildCharacterRelationshipsMessages,
  parseCharacterRelationships,
  type CharacterRelationships,
  type ChatMessage,
} from "../character-relationships/character-relationships.js";

const inputSchema = z.object({
  // roster/关系全部从项目硬事实账本读取，通常不需要任何参数；保留可空备注以备将来扩展，不强制。
  note: z.string().optional().describe("可选备注，一般留空——工具自动读取项目硬事实账本整理人物关系。"),
});

const outputSchema = z.object({
  ok: z.boolean().describe("是否成功整理出人物关系。没有硬事实或没有具名人物时为 false。"),
  summary: z.string().describe("自然语言摘要，供回答用户。"),
  characterCount: z.number().optional().describe("整理出的具名人物数。"),
  relationshipCount: z.number().optional().describe("整理出的关系数。"),
  refreshScope: z.literal("full").optional().describe("整理完成需全量刷新资料面板（角色矩阵三视图）。"),
  snapshotId: z.string().describe("写前快照 id，可一键撤销本次整理。"),
});

/**
 * 纯函数：把 GLM 整理出的人物 roster 转成 status:"candidate" 的 CharacterMatrixUpdate[]。
 * 确定性、零副作用，便于单测。空 characters → 空数组（上层据此 ok:false，绝不谎报）。
 *
 * relationToProtagonist：主角 = 第一条关系的 from（题材中立地以事实里实际出现的关系发起方为主角）；
 *   取该人物作为主角关系目标方（to）的那条关系的 relationType；无直接关系则省略（不编造）。
 */
export function convertRelationshipsToMatrixUpdates(
  rel: CharacterRelationships,
  chapter: number,
): readonly CharacterMatrixUpdate[] {
  if (rel.characters.length === 0) return [];

  const protagonist = rel.relationships[0]?.from?.trim();
  const relationToProtagonistByName = new Map<string, string>();
  if (protagonist) {
    for (const r of rel.relationships) {
      if (r.from.trim() === protagonist && r.to.trim() && r.relationType.trim()) {
        // 首条优先（与 protagonist 直接相关、按事实顺序）。
        if (!relationToProtagonistByName.has(r.to.trim())) {
          relationToProtagonistByName.set(r.to.trim(), r.relationType.trim());
        }
      }
    }
  }

  // 主角本人不当作候选条目（避免把主角写成 candidate 矩阵条目）。
  return rel.characters
    .map((c) => c.name.trim())
    .filter((name) => name.length > 0 && name !== protagonist)
    .map((name): CharacterMatrixUpdate => {
      const relationToProtagonist = relationToProtagonistByName.get(name);
      const roleEntry = rel.characters.find((c) => c.name.trim() === name);
      const evidence = roleEntry?.role?.trim() ? [`身份：${roleEntry.role.trim()}`] : undefined;
      return {
        id: `matrix-${name}`,
        name,
        status: "candidate",
        ...(relationToProtagonist !== undefined ? { relationToProtagonist } : {}),
        firstSeenChapter: chapter,
        lastSeenChapter: chapter,
        ...(evidence !== undefined ? { evidence } : {}),
        appearances: [],
        relationshipEvents: [],
      };
    });
}

/**
 * 复刻引擎 commit-engine.mergeCharacterMatrixStatus（未导出）：
 * 既有 accepted/promoted/ignored 条目永不被 candidate 更新降级（保护正式/已忽略条目）。
 */
function mergeStatus(
  existing: CharacterMatrixEntry["status"] | undefined,
  patch: CharacterMatrixEntry["status"] | undefined,
): CharacterMatrixEntry["status"] {
  if ((existing === "accepted" || existing === "promoted" || existing === "ignored") && patch === "candidate") {
    return existing;
  }
  return patch ?? existing ?? "candidate";
}

function mergeUnique(existing: readonly string[], extra: readonly string[] | undefined): string[] {
  // E1：去重升级到共用 appendDedup（空白折叠 + 前缀含纳），与引擎写/读侧同源。
  return appendDedup(existing, extra ?? []);
}

/**
 * 把 candidate updates 并入现有 character-matrix.json（读现有 → merge → 原子写）。
 * 完全复刻引擎 buildCharacterMatrixFile 的按 (id || name) 合并 + 状态保护语义，确定性、零 LLM。
 * 既有 accepted/promoted/ignored 条目不被降级；既有 evidence/appearances 等保留。
 */
export async function persistCharacterRoster(
  projectDir: string,
  updates: readonly CharacterMatrixUpdate[],
  chapter: number,
): Promise<void> {
  if (updates.length === 0) return;
  const previous = await readCharacterMatrixLedger(projectDir);
  const byKey = new Map<string, CharacterMatrixEntry>(
    previous.entries.map((entry) => [entry.id || entry.name, entry]),
  );
  for (const update of updates) {
    const key = update.id || update.name;
    const existing = byKey.get(key) ?? previous.entries.find((entry) => entry.name === update.name);
    const next: CharacterMatrixEntry = {
      id: existing?.id ?? update.id,
      name: update.name,
      status: mergeStatus(existing?.status, update.status),
      ...(update.relationToProtagonist !== undefined
        ? { relationToProtagonist: update.relationToProtagonist }
        : existing?.relationToProtagonist !== undefined
          ? { relationToProtagonist: existing.relationToProtagonist }
          : {}),
      ...(existing?.roleHint !== undefined ? { roleHint: existing.roleHint } : {}),
      ...(existing?.riskHint !== undefined ? { riskHint: existing.riskHint } : {}),
      firstSeenChapter: existing?.firstSeenChapter ?? update.firstSeenChapter ?? chapter,
      lastSeenChapter: update.lastSeenChapter ?? chapter,
      ...(existing?.promotedCharacterId !== undefined
        ? { promotedCharacterId: existing.promotedCharacterId }
        : {}),
      evidence: mergeUnique(existing?.evidence ?? [], update.evidence),
      appearances: existing?.appearances ?? [],
      relationshipEvents: existing?.relationshipEvents ?? [],
    };
    byKey.set(next.id, next);
  }
  const nextLedger: CharacterMatrixLedger = { version: "v0", entries: [...byKey.values()] };
  const path = join(projectDir, "story", "character-matrix.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(nextLedger, null, 2), "utf-8");
}

/** 用用户配置的模型做一次 JSON 输出调用（照 generate-matrix-enrichment 的 callConfiguredModel）。 */
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
 * 空事实失败文案（R2#2·铁律④诚实不误导）：本工具只从【已入库章节的硬事实】整理关系网；
 * 开书阶段还没入库章节时，旧文案让用户「先写几章」是误导——给具名角色登记关系当下就能做。
 */
export const NO_FACTS_RELATIONSHIP_SUMMARY =
  "现在还没有可整理的硬事实——本工具是从【已定稿章节】抽出的硬事实里梳理关系网的。" +
  "如果你是想给现有角色登记关系（比如『谁是谁的姐姐 / 谁信任谁』），现在就能做：" +
  "用 foundation_write 的 update_character_detail 把关系写进对方角色卡的 relationshipToProtagonist / relationshipDynamics 字段（写入可撤销），关系网会据此自动显示。" +
  "等写了几章并定稿后，本工具能再从正文里帮你补全更多关系。";

export const generateCharacterRelationshipsTool = writeTool({
  id: "generate_character_relationships",
  description:
    "当用户说『整理人物关系 / 把人物关系网理出来 / 梳理一下都有哪些人和他们的关系』时调用：" +
    "从本书已抽好的硬事实出发，整理出真实出现的具名人物名单与他们之间的关系，" +
    "把人物登记成角色矩阵候选（候选不是正式卡）、把关系（情感倾向/信任度）写入关系账本，" +
    "让角色矩阵的总览表、关系账本、人物关系网三个视图一起有内容。只整理事实里真实出现的具名人物，" +
    "不会编造不存在的人物或关系；写入可一键撤销。",
  inputSchema,
  outputSchema,
  run: async ({ projectDir, context }) => {
    const facts = (await readFactLedger(projectDir)).facts
      .map((f) => f.text?.trim() ?? "")
      .filter((t) => t.length > 0);
    if (facts.length === 0) {
      return { ok: false, summary: NO_FACTS_RELATIONSHIP_SUMMARY };
    }

    const existingNames = (await readCharacterMatrixLedger(projectDir)).entries
      .map((e) => e.name?.trim() ?? "")
      .filter((n) => n.length > 0);

    // A1 的 buildCharacterRelationshipsMessages 硬编码 role 为 system/user，但其推断类型为 string；
    // 在边界处显式收窄成 ChatMessage（role 取值由 A1 保证，仅做类型层收口）。
    const messages: readonly ChatMessage[] = buildCharacterRelationshipsMessages(facts, existingNames).map(
      (m) => ({ role: m.role as ChatMessage["role"], content: m.content }),
    );
    const text = await callConfiguredModel(messages);
    const rel = parseCharacterRelationships(text);

    if (rel.characters.length === 0) {
      return {
        ok: false,
        summary: "我读完现有事实，没能从中整理出足够的具名人物关系——可能事实里多是无名提及。继续写、定稿更多章节后再来整理会更准。",
      };
    }

    // 章号仅用于 firstSeen/lastSeen 标注：取当前章号，拿不到则用最大事实章号兜底。
    const factMaxChapter = (await readFactLedger(projectDir)).facts.reduce(
      (max, f) => (typeof f.chapter === "number" && f.chapter > max ? f.chapter : max),
      0,
    );
    const chapter = resolveChapterFromInputOrContext(undefined, context) ?? (factMaxChapter > 0 ? factMaxChapter : 1);

    const updates = convertRelationshipsToMatrixUpdates(rel, chapter);
    // 修 P2·2：模型给了 characters 但转换/过滤后没有任何可写候选 → persist 是 no-op，别谎报成功。
    if (updates.length === 0) {
      return {
        ok: false,
        summary: "事实里有人物提及，但没能归纳出足够支撑的具名候选（多为无名/泛指），本次没有写入。继续写、定稿更多章节后再整理会更准。",
      };
    }
    await persistCharacterRoster(projectDir, updates, chapter);

    const relationshipCount = rel.relationships.length;
    return {
      ok: true,
      summary:
        // 修 P2·1：如实说候选 + 关系是「体现在候选关系信息里」，不再谎称写了独立的「N 条人物关系（关系网已更新）」。
        `已把 ${updates.length} 位具名人物登记为角色矩阵候选（不是正式卡），并归纳出 ${relationshipCount} 条关系线索、体现在这些候选的关系信息里——角色矩阵的『总览表 / 关系网』据此渲染。` +
        "想把谁转成正式角色、或把关系做厚（情感债/红线/信任度），直接跟我说；本次整理可一键撤销。",
      characterCount: updates.length,
      relationshipCount,
      refreshScope: "full" as const,
    };
  },
});
