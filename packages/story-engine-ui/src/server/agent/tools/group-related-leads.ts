/**
 * group_related_leads — 写类工具：读 story/threads.json → 调 GLM 把讲同一件事的
 * open/touched lead 分组 → 确定性 applyLeadGroups 合并（winner 保留、loser 标 stale
 * + evidence/relatedCharacters 去重并入）→ 原子写回。治「响动墙」（同一个伏笔被碎拆成
 * 多条重复 lead 的问题）。可撤销。
 *
 * 铁律：
 * - 直接做 + 可撤销（writeTool 前置快照）
 * - 绝不静默失败（ok 字段如实回报；GLM/解析/写入任一失败 → ok:false）
 * - 题材中立（GLM 提示词也是中立的，见 lead-grouping lib）
 * - 引擎零改动（只 value-import readThreadPool）
 * - 原子写（writeFileAtomic：tmp + rename，失败自清临时文件）
 *
 * 纯壳 runGroupRelatedLeads(projectDir, callModel) 与工具 run 分开，
 * 方便单测注入 mock callModel，工具 run 里才接真实 GLM。
 */

import { join } from "node:path";
import { z } from "zod";

import { readThreadPool } from "@actalk/story-engine";

import {
  applyLeadGroups,
  buildLeadGroupingMessages,
  parseLeadGroups,
} from "../lead-grouping/lead-grouping.js";
import { callOpenAICompatibleChatModel, resolveConfiguredChatModel } from "../../lib/llm-client.js";
import { writeFileAtomic } from "../../lib/project-io.js";
import { writeTool } from "../withSnapshot.js";
import { readUserTurnTextFromContext } from "../request-context.js";
import { userTurnAllowsThreadCleanup } from "./turn-intent-gate.js";

// ─── 纯壳（可单测）────────────────────────────────────────────────────────────

export interface GroupRelatedLeadsResult {
  readonly ok: boolean;
  readonly summary: string;
  readonly blockedReason?: string;
  readonly groupCount?: number;
  readonly mergedCount?: number;
}

/**
 * 纯壳函数：读 threads → 取 open/touched lead → callModel 分组 → 合并 → 原子写回。
 * callModel 注入使单测可 mock，工具 run 里传真实 GLM 调用。
 */
export async function runGroupRelatedLeads(
  projectDir: string,
  callModel: (messages: { role: string; content: string }[]) => Promise<string>,
): Promise<GroupRelatedLeadsResult> {
  // 1. 读 thread pool
  let pool;
  try {
    pool = await readThreadPool(projectDir);
  } catch (error) {
    return {
      ok: false,
      summary: `读取 threads.json 失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // 2. 取 open/touched lead
  const leads = pool.threads
    .filter(
      (t) =>
        t.type === "lead" && (t.status === "open" || t.status === "touched"),
    )
    .map((t) => ({
      id: t.id,
      title: t.title,
      evidence: (t.evidence ?? []).join(" "),
    }));

  // 3. <2 条 → 无需分组
  if (leads.length < 2) {
    return { ok: true, summary: "线索不足，无需分组" };
  }

  // 4. 调 GLM 分组
  let text: string;
  try {
    text = await callModel(buildLeadGroupingMessages(leads));
  } catch (error) {
    return {
      ok: false,
      summary: `GLM 分组调用失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // 5. 解析模型输出
  let groups;
  try {
    groups = parseLeadGroups(text);
  } catch (error) {
    return {
      ok: false,
      summary: `解析 GLM 分组输出失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // 6. 确定性合并
  const result = applyLeadGroups(pool.threads, groups);
  const { mergedPairs } = result;

  // 7. 无合并对 → 不写盘
  if (mergedPairs.length === 0) {
    return { ok: true, summary: "没有可合并的同类线索" };
  }

  // 8. 原子写回（writeFileAtomic：tmp+rename，失败自清临时文件、不留残留）
  const threadsPath = join(projectDir, "story", "threads.json");
  try {
    await writeFileAtomic(
      threadsPath,
      `${JSON.stringify({ threads: result.next }, null, 2)}\n`,
    );
  } catch (error) {
    return {
      ok: false,
      summary: `写回 threads.json 失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // 修 P3·2：用实际生效的组数（去重后的 winner 数），不再用模型返回的原始组数——
  // applyLeadGroups 会跳过无效/重叠组（见修#3），原始组数会夸大实际收拢数。
  const effectiveGroups = new Set(mergedPairs.map((p) => p.winnerId)).size;
  return {
    ok: true,
    summary:
      `把 ${effectiveGroups} 组讲同一件事的线索各收拢成1条（共合并 ${mergedPairs.length} 条），可对我说撤销`,
    groupCount: effectiveGroups,
    mergedCount: mergedPairs.length,
  };
}

// ─── writeTool 包装 ──────────────────────────────────────────────────────────

const inputSchema = z.object({
  note: z
    .string()
    .optional()
    .describe("可选备注，一般留空——工具自动读取项目线索并调 GLM 分组合并。"),
});

const outputSchema = z.object({
  snapshotId: z.string().describe("写前快照 id，可一键撤销本次合并。"),
  ok: z.boolean().describe("是否成功；false 时 summary 含原因。"),
  summary: z.string().describe("自然语言结果，供回答用户。"),
  blockedReason: z.string().optional().describe("写入前守卫拦截原因，如本轮用户原话没有清理/归并线索意图。"),
  groupCount: z.number().optional().describe("GLM 识别出的可合并组数。"),
  mergedCount: z.number().optional().describe("实际合并（标 stale）的 loser 条数。"),
});

/** 真实 GLM callModel（仅在工具 run 里构造，单测不走这里）。 */
async function realCallModel(
  messages: { role: string; content: string }[],
): Promise<string> {
  const configured = await resolveConfiguredChatModel("enrichment");
  const { content } = await callOpenAICompatibleChatModel({
    configured,
    messages,
    responseFormat: { type: "json_object" },
    timeoutMs: 250000,
  });
  return content;
}

export const groupRelatedLeadsTool = writeTool({
  id: "group_related_leads",
  description:
    "当用户说『把讲同一件事的线索合并收拢 / 线索里有重复的 / 响动写了好多遍 / 把重复伏笔归一条』时调用：" +
    "读取 story/threads.json，调 GLM 识别哪些 open/touched lead 是在讲同一件事，" +
    "再把同一组 lead 合并收拢成一条（firstSeenChapter 最早的保留为 winner，其余标 stale、" +
    "evidence 并入 winner），原子写回；写前自动快照、可一键撤销。" +
    "无可合并线索时如实回报『没有可合并的同类线索』。" +
    "本工具有写入前守卫：本轮用户原话没有清理/归并线索意图会被拒绝。",
  inputSchema,
  outputSchema,
  preflight: ({ context }) => {
    const userTurnText = readUserTurnTextFromContext(context);
    if (userTurnText === undefined || userTurnAllowsThreadCleanup(userTurnText)) return undefined;

    console.warn("[turn-intent-gate] 拦下未授权 group_related_leads（本轮用户原话无对应意图）");
    return {
      ok: false,
      blockedReason: "user_turn_no_thread_cleanup_intent",
      summary: "本回合用户没有要求清理/归并线索，已拦下自动清理。看到待收口提醒时请转告用户并给『清理旧线索』选项，用户点了再做。",
    };
  },
  run: async ({ projectDir }) => {
    return runGroupRelatedLeads(projectDir, realCallModel);
  },
});
