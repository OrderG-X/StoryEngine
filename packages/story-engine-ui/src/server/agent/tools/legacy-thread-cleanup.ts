/**
 * planLegacyThreadCleanup — 纯函数，对旧书 threads.json 里的历史垃圾 lead 做两步清理：
 *  ① 质量闸：isQualityLead 假且命中明确噪声/否定/截断 → 标 stale
 *  ② 保守去重：同型 open/touched lead 近重复 → loser 标 stale，evidence 并入 winner
 *
 * 纯函数、确定性、题材中立、不调 LLM、引擎零改动（只 value-import）。
 *
 * clean_legacy_threads — 写类工具：读 threads.json → planLegacyThreadCleanup → 原子写回。
 * runCleanLegacyThreads — 纯壳函数，便于单测（工具 run 调它）。
 */

import { join } from "node:path";
import { z } from "zod";

import { isQualityLead, bigramSimilarity, readThreadPool } from "@actalk/story-engine";
import type { NarrativeThread } from "@actalk/story-engine";

import { writeFileAtomic } from "../../lib/project-io.js";
import { writeTool } from "../withSnapshot.js";
import { readUserTurnTextFromContext } from "../request-context.js";
import { userTurnAllowsThreadCleanup } from "./turn-intent-gate.js";

export interface LegacyCleanupResult {
  readonly staleIds: readonly string[];
  readonly mergedPairs: readonly { readonly loserId: string; readonly winnerId: string }[];
  readonly next: readonly NarrativeThread[];
}

/** 工具内私有：trim + toLowerCase + 去空格 */
function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, "");
}

/**
 * 垃圾 lead 判定：先通过 isQualityLead 粗筛，再用更精确的模式集决定是否真的丢弃。
 * 原因：isQualityLead 的长度闸（title 且 evidence 均 < 6）会误判有意义的短标题
 * （如「父亲的债」）；这里对短标题额外要求命中截断/噪声/否定任一模式才丢弃，
 * 保留不符合任何垃圾模式的简洁伏笔。
 */
const TRUNCATED_LEAD_CHARS_LOCAL = /^[么的了吗呢吧啊哦哈嘛啦呀哟喔哎哩嗯唉]/u;
const GARBAGE_NOISE_PATTERN = /没有异常|线索太碎|看不出任何异常|没有发现异常|没有线索|无任何线索/u;
// 题材中立短否定：「没有」+1~6字 或 「未」+1~5字，整串匹配（^ … $）
// 6字上限排除长否定句（如「没有发现任何蛛丝马迹」=8字，可能是合法伏笔）
const GARBAGE_NEGATION_SHORT_1 = /^没有.{1,6}$/u;
const GARBAGE_NEGATION_SHORT_2 = /^未.{1,5}$/u;

function isGarbageLead(title: string, evidence: string): boolean {
  // 先让 isQualityLead 做粗筛（截断/长度/噪声/否定）
  if (isQualityLead(title, evidence)) return false; // 通过则保留

  // isQualityLead 返回 false：可能是长度不足或命中模式
  // 对短标题做二次鉴别：只在命中明确垃圾模式时才丢弃
  if (TRUNCATED_LEAD_CHARS_LOCAL.test(title.trimStart())) return true;
  if (GARBAGE_NOISE_PATTERN.test(title) || GARBAGE_NOISE_PATTERN.test(evidence)) return true;
  if (
    GARBAGE_NEGATION_SHORT_1.test(title) ||
    GARBAGE_NEGATION_SHORT_1.test(evidence) ||
    GARBAGE_NEGATION_SHORT_2.test(title) ||
    GARBAGE_NEGATION_SHORT_2.test(evidence)
  )
    return true;

  // 短但未命中垃圾模式（如「父亲的债」）→ 保留
  return false;
}

export function planLegacyThreadCleanup(threads: readonly NarrativeThread[]): LegacyCleanupResult {
  // 只处理 type==="lead" && (status==="open" || status==="touched")
  const isTarget = (t: NarrativeThread): boolean =>
    t.type === "lead" && (t.status === "open" || t.status === "touched");

  // 以可变映射记录每条的新状态和 evidence（只改 target 条目）
  const statusMap = new Map<string, NarrativeThread["status"]>();
  const evidenceMap = new Map<string, readonly string[]>();
  const relatedCharactersMap = new Map<string, readonly string[]>();

  // 初始化
  for (const t of threads) {
    statusMap.set(t.id, t.status);
    evidenceMap.set(t.id, t.evidence ?? []);
    relatedCharactersMap.set(t.id, t.relatedCharacters ?? []);
  }

  // ① 质量闸
  const staleIds = new Set<string>();
  for (const t of threads) {
    if (!isTarget(t)) continue;
    const evidenceStr = (t.evidence ?? []).join(" ");
    if (isGarbageLead(t.title, evidenceStr)) {
      statusMap.set(t.id, "stale");
      staleIds.add(t.id);
    }
  }

  // ② 去重合并：质量闸通过的 open/touched lead
  const survivors = threads.filter((t) => isTarget(t) && !staleIds.has(t.id));

  const mergedPairs: Array<{ loserId: string; winnerId: string }> = [];
  const loserSet = new Set<string>();

  for (let i = 0; i < survivors.length; i++) {
    const a = survivors[i];
    if (loserSet.has(a.id)) continue;

    for (let j = i + 1; j < survivors.length; j++) {
      // a 本轮内层已沦为 loser（3+ 条互为近重复时先输给某个 b）→ 不再拿它当锚，
      // 否则后续 evidence 会被并进已 stale 的 a 节点而静默丢失（state-overview 把 stale 列 closedStatuses 永不进正文）。
      if (loserSet.has(a.id)) break;
      const b = survivors[j];
      if (loserSet.has(b.id)) continue;

      const na = normalize(a.title);
      const nb = normalize(b.title);

      // 近重复判定：子串含 OR bigram >= 0.6
      const isNearDuplicate =
        na.includes(nb) || nb.includes(na) || bigramSimilarity(na, nb) >= 0.6;

      if (!isNearDuplicate) continue;

      // winner 规则与 group_related_leads 的 applyLeadGroups 逐字一致（lead-grouping.ts:127-138），
      // 统一两工具、消除「先后跑对同一对 lead 选不同 winner、evidence 落到不同幸存者」的顺序依赖：
      // firstSeenChapter 最早者为 winner；并列时 title 较长者为 winner（再并列则数组在前的 a 胜）。
      const aWins =
        a.firstSeenChapter < b.firstSeenChapter ||
        (a.firstSeenChapter === b.firstSeenChapter && a.title.length >= b.title.length);
      const winner = aWins ? a : b;
      const loser = aWins ? b : a;

      // loser → stale
      loserSet.add(loser.id);
      staleIds.add(loser.id);
      statusMap.set(loser.id, "stale");
      mergedPairs.push({ loserId: loser.id, winnerId: winner.id });

      // evidence 去重并入 winner
      const winnerEvidence = evidenceMap.get(winner.id) ?? [];
      const loserEvidence = evidenceMap.get(loser.id) ?? [];
      const mergedEvidence = Array.from(new Set([...winnerEvidence, ...loserEvidence]));
      evidenceMap.set(winner.id, mergedEvidence);

      // relatedCharacters 去重并入 winner
      const winnerRC = relatedCharactersMap.get(winner.id) ?? [];
      const loserRC = relatedCharactersMap.get(loser.id) ?? [];
      const mergedRC = Array.from(new Set([...winnerRC, ...loserRC]));
      relatedCharactersMap.set(winner.id, mergedRC);
    }
  }

  // ③ 构造 next：逐条映射，不动其它字段，顺序不变
  const next: NarrativeThread[] = threads.map((t) => {
    if (!isTarget(t)) return t;
    const newStatus = statusMap.get(t.id)!;
    const newEvidence = evidenceMap.get(t.id)!;
    const newRC = relatedCharactersMap.get(t.id)!;
    // 若无变化则返回原对象（引用相等），否则构造新对象
    const statusChanged = newStatus !== t.status;
    const evidenceChanged = t.evidence !== undefined
      ? newEvidence !== t.evidence
      : newEvidence.length > 0;
    const rcChanged = t.relatedCharacters !== undefined
      ? newRC !== t.relatedCharacters
      : newRC.length > 0;
    if (!statusChanged && !evidenceChanged && !rcChanged) return t;
    return {
      ...t,
      status: newStatus,
      evidence: newEvidence,
      ...(newRC.length > 0 || (t.relatedCharacters?.length ?? 0) > 0
        ? { relatedCharacters: newRC }
        : {}),
    };
  });

  return {
    staleIds: Array.from(staleIds),
    mergedPairs,
    next,
  };
}

// ─── clean_legacy_threads 工具 ───────────────────────────────────────────────

export interface CleanLegacyThreadsResult {
  readonly ok: boolean;
  readonly summary: string;
  readonly blockedReason?: string;
  readonly staleCount?: number;
  readonly mergedCount?: number;
}

/**
 * 纯壳函数（便于单测）：
 *  readThreadPool(projectDir) → planLegacyThreadCleanup → 若有改动则原子写回 story/threads.json
 */
export async function runCleanLegacyThreads(projectDir: string): Promise<CleanLegacyThreadsResult> {
  let pool;
  try {
    pool = await readThreadPool(projectDir);
  } catch (error) {
    return {
      ok: false,
      summary: `读取 threads.json 失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const result = planLegacyThreadCleanup(pool.threads);
  const { staleIds, mergedPairs } = result;

  if (staleIds.length === 0 && mergedPairs.length === 0) {
    return { ok: true, summary: "检查完毕，没有需要清理的旧线索" };
  }

  // 计算"纯垃圾"数：staleIds 里不在任何 mergedPairs.loserId 中的条目
  const loserIds = new Set(mergedPairs.map((p) => p.loserId));
  const pureGarbageCount = staleIds.filter((id) => !loserIds.has(id)).length;
  const mergedCount = mergedPairs.length;

  // 原子写回（writeFileAtomic：tmp+rename，失败自清临时文件、不留残留）
  const threadsPath = join(projectDir, "story", "threads.json");
  try {
    await writeFileAtomic(threadsPath, `${JSON.stringify({ threads: result.next }, null, 2)}\n`);
  } catch (error) {
    return {
      ok: false,
      summary: `写回 threads.json 失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  return {
    ok: true,
    summary: `清理了 ${pureGarbageCount} 条垃圾碎片、合并 ${mergedCount} 组近重复，可对我说「撤销」`,
    staleCount: pureGarbageCount,
    mergedCount,
  };
}

// ─── writeTool 包装 ──────────────────────────────────────────────────────────

const inputSchema = z.object({});

const outputSchema = z.object({
  snapshotId: z.string().describe("写前快照 id，可一键撤销本次清理。"),
  ok: z.boolean().describe("是否成功；false 时 summary 含原因。"),
  summary: z.string().describe("自然语言结果，供回答用户。"),
  blockedReason: z.string().optional().describe("写入前守卫拦截原因，如本轮用户原话没有清理/归并线索意图。"),
  staleCount: z.number().optional().describe("标为垃圾的纯碎片数（不含合并 loser）。"),
  mergedCount: z.number().optional().describe("合并的近重复组数。"),
});

export const cleanLegacyThreadsTool = writeTool({
  id: "clean_legacy_threads",
  description:
    "当用户说『把这本书的旧线索清理一下 / 线索太乱了帮我整理 / 清理垃圾线索』时调用：" +
    "确定性清理（不调 LLM）——把没有实质内容的垃圾碎片 lead 标为 stale、把**字面近重复**的 lead 合并（evidence 并入 winner，firstSeenChapter 最早者胜），" +
    "原子写回文件。写前自动快照、可一键撤销。无可清理时如实回报『没有需要清理的旧线索』。" +
    "（注：本工具只做字面去重；若要把『措辞不同但讲同一件事』的线索语义归并，用 group_related_leads。一般先 clean 后 group。）" +
    "本工具有写入前守卫：本轮用户原话没有清理/归并线索意图会被拒绝。",
  inputSchema,
  outputSchema,
  preflight: ({ context }) => {
    const userTurnText = readUserTurnTextFromContext(context);
    if (userTurnText === undefined || userTurnAllowsThreadCleanup(userTurnText)) return undefined;

    console.warn("[turn-intent-gate] 拦下未授权 clean_legacy_threads（本轮用户原话无对应意图）");
    return {
      ok: false,
      blockedReason: "user_turn_no_thread_cleanup_intent",
      summary: "本回合用户没有要求清理/归并线索，已拦下自动清理。看到待收口提醒时请转告用户并给『清理旧线索』选项，用户点了再做。",
    };
  },
  run: async ({ projectDir }) => {
    return runCleanLegacyThreads(projectDir);
  },
});
