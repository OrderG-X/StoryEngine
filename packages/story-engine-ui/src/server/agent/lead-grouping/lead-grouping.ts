/**
 * lead-grouping lib（模块 GL-1）
 *
 * 纯函数 lib，无副作用（不写盘不调网）。
 * 功能：
 *   1. zod schema + GLM 提示词构造（buildLeadGroupingMessages）
 *   2. 解析模型输出（parseLeadGroups）
 *   3. 确定性合并（applyLeadGroups）——GLM 只给分组，合并是确定性的：
 *      每组保留 firstSeenChapter 最早的 winner、其余 loser 标 stale +
 *      evidence/relatedCharacters 去重并入 winner。
 *
 * 设计原则：
 * - 题材中立，不预设任何世界观
 * - 引擎零改动（只 type-import NarrativeThread）
 * - 不可变更新（所有输出都是新对象）
 * - 绝不过并不同伏笔（单成员组被 zod 拒；有效成员 <2 整组跳过）
 */

import { z } from "zod";
import type { NarrativeThread } from "@actalk/story-engine";

// ─── Schema ──────────────────────────────────────────────────────────────────

export const leadGroupsSchema = z
  .object({
    groups: z
      .array(
        z.object({
          memberIds: z.array(z.string().min(1)).min(2),
        }),
      )
      .default([]),
  })
  .strict();

export type LeadGroups = z.infer<typeof leadGroupsSchema>;

// ─── buildLeadGroupingMessages ────────────────────────────────────────────────

/**
 * 构造发给 GLM 的消息列表。
 * 范式照 character-relationships.ts：system 强约束只输出合法 JSON、不要 markdown；
 * user 把每条 lead 编号列出。
 */
export function buildLeadGroupingMessages(
  leads: readonly { id: string; title: string; evidence: string }[],
): { role: string; content: string }[] {
  const system =
    "你是小说资料整理助手。只输出一个合法 JSON 对象，不要 Markdown、不要代码块、不要解释。" +
    "简体中文。字段固定为 groups[].{memberIds}，memberIds 必须取自给定 id 清单。" +
    "只把【明确在讲同一件事/同一个伏笔】的归一组；" +
    "拿不准就别归组（宁可不并别过并）；单条不成组（每组至少 2 个成员）；" +
    "不存在可合并同义伏笔时输出 {\"groups\":[]}。";

  const lines = leads
    .map((l, i) => `[${l.id}] ${i + 1}. ${l.title} — ${l.evidence}`)
    .join("\n");

  const user =
    `以下是当前故事的线索/伏笔清单，请把【明确讲同一件事】的归组，id 取自方括号内：\n${lines}\n\n` +
    "输出格式：{\"groups\":[{\"memberIds\":[\"id1\",\"id2\",...]},...]}";

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

// ─── parseLeadGroups ──────────────────────────────────────────────────────────

/**
 * 从模型原始输出中抠出 JSON 并用 leadGroupsSchema 校验。
 * 无 JSON 或不合法（如单成员组）时抛 Error。
 */
/**
 * 宽进（模型无关铁律）：多给的字段丢掉、单条成组的跳过、id 给成数字也收、groups 直接给成数组也认。
 * 2026-10-10 真机试写：严格 schema 下模型多带一个字段 / 某组只放一条，整次归并就「没跑成」。不是 JSON 才抛。
 */
export function parseLeadGroups(text: string): LeadGroups {
  const match = text.match(/[[{][\s\S]*[\]}]/u);
  if (!match) throw new Error("lead-grouping: 模型输出未含 JSON 对象");
  const raw = JSON.parse(match[0]) as unknown;
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
  const groupsRaw: readonly unknown[] = Array.isArray(record?.groups) ? record.groups : Array.isArray(raw) ? raw : [];
  const groups = groupsRaw
    .map((group) => {
      const item = group && typeof group === "object" && !Array.isArray(group) ? (group as Record<string, unknown>) : undefined;
      const ids: readonly unknown[] = Array.isArray(item?.memberIds) ? item.memberIds : Array.isArray(item?.ids) ? item.ids : Array.isArray(group) ? group : [];
      const memberIds = [...new Set(ids.map((id) => (typeof id === "string" || typeof id === "number" ? String(id).trim() : "")).filter(Boolean))];
      return { memberIds };
    })
    .filter((group) => group.memberIds.length >= 2);
  return { groups };
}

// ─── applyLeadGroups ──────────────────────────────────────────────────────────

export interface ApplyGroupsResult {
  readonly staleIds: readonly string[];
  readonly mergedPairs: readonly { readonly loserId: string; readonly winnerId: string }[];
  readonly next: readonly NarrativeThread[];
}

/**
 * 确定性合并：纯函数，不可变。
 *
 * 对每组 memberIds：
 *   1. 过滤出有效成员：存在 && type==="lead" && status∈{"open","touched"}
 *   2. 有效成员 <2 → 跳过该组（保护：绝不误并）
 *   3. winner = firstSeenChapter 最小者（并列取 title.length 最大）
 *   4. 其余 loser → status:"stale"，evidence+relatedCharacters 去重并入 winner
 */
export function applyLeadGroups(
  threads: readonly NarrativeThread[],
  groups: LeadGroups,
): ApplyGroupsResult {
  // 先把 threads 建成 id→index 的快查表
  const byId = new Map<string, NarrativeThread>(threads.map((t) => [t.id, t]));

  // 收集本轮所有要 stale 的 id 以及合并对，最后统一应用
  const allStaleIds = new Set<string>();
  const allMergedPairs: { loserId: string; winnerId: string }[] = [];

  // 每组的 loser→winner 的 evidence/relatedCharacters 积累
  const winnerEvidence = new Map<string, string[]>();
  const winnerRelatedChars = new Map<string, string[]>();

  // 修#3：已被前面分组认领的 lead（winner 或 loser）。GLM 可能返回重叠组（如 [a,b] 和 [b,c]）——
  // 若不防，第一组把 b stale 后第二组仍可能选 b 当 winner，evidence 并进已 stale 节点而静默丢失。
  // 每个 lead 只许被一个组认领（先到先得），重叠成员从后续组剔除。
  const claimed = new Set<string>();

  for (const group of groups.groups) {
    // 1. 过滤有效成员（剔除已被前面分组认领的，防重叠组）
    const valid = group.memberIds
      .map((id) => byId.get(id))
      .filter(
        (t): t is NarrativeThread =>
          t !== undefined &&
          t.type === "lead" &&
          (t.status === "open" || t.status === "touched") &&
          !claimed.has(t.id),
      );

    // 2. 有效 <2 → 跳过
    if (valid.length < 2) continue;

    // 认领本组全部有效成员，后续重叠组不再碰它们
    for (const t of valid) claimed.add(t.id);

    // 3. 选 winner：firstSeenChapter 最小，并列取 title.length 最大
    const winner = valid.reduce((best, cur) => {
      if (cur.firstSeenChapter < best.firstSeenChapter) return cur;
      if (
        cur.firstSeenChapter === best.firstSeenChapter &&
        cur.title.length > best.title.length
      )
        return cur;
      return best;
    });

    // 4. 其余为 loser
    const losers = valid.filter((t) => t.id !== winner.id);

    // 初始化 winner 累积（避免重复）
    if (!winnerEvidence.has(winner.id)) {
      winnerEvidence.set(winner.id, [...(winner.evidence ?? [])]);
    }
    if (!winnerRelatedChars.has(winner.id)) {
      winnerRelatedChars.set(winner.id, [...(winner.relatedCharacters ?? [])]);
    }

    for (const loser of losers) {
      allStaleIds.add(loser.id);
      allMergedPairs.push({ loserId: loser.id, winnerId: winner.id });

      // 并入 evidence（去重）
      const evArr = winnerEvidence.get(winner.id)!;
      for (const e of loser.evidence ?? []) {
        if (!evArr.includes(e)) evArr.push(e);
      }

      // 并入 relatedCharacters（去重）
      const rcArr = winnerRelatedChars.get(winner.id)!;
      for (const rc of loser.relatedCharacters ?? []) {
        if (!rcArr.includes(rc)) rcArr.push(rc);
      }
    }
  }

  // 构建 next（不可变）
  const next: NarrativeThread[] = threads.map((t) => {
    if (allStaleIds.has(t.id)) {
      return { ...t, status: "stale" as const };
    }
    const ev = winnerEvidence.get(t.id);
    const rc = winnerRelatedChars.get(t.id);
    if (ev !== undefined || rc !== undefined) {
      return {
        ...t,
        evidence: ev ?? [...(t.evidence ?? [])],
        ...(rc !== undefined ? { relatedCharacters: rc } : {}),
      };
    }
    return t;
  });

  return {
    staleIds: [...allStaleIds],
    mergedPairs: allMergedPairs,
    next,
  };
}
