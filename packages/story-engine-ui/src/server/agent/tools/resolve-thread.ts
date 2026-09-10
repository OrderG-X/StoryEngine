import { join } from "node:path";
import { z } from "zod";

import { bigramSimilarity, readThreadPool } from "@actalk/story-engine";
import type { NarrativeThread } from "@actalk/story-engine";

import { writeFileAtomic } from "../../lib/project-io.js";
import { readUserTurnTextFromContext } from "../request-context.js";
import { writeTool } from "../withSnapshot.js";
import { userTurnAllowsResolveThread } from "./turn-intent-gate.js";

export interface ResolveThreadCandidate {
  readonly id: string;
  readonly title: string;
  readonly status: NarrativeThread["status"];
  readonly type: NarrativeThread["type"];
}

export interface ResolveThreadResult {
  readonly ok: boolean;
  readonly summary: string;
  readonly blockedReason?: "thread_not_found" | "multiple_threads_matched" | "read_failed" | "write_failed" | "user_turn_no_resolve_thread_intent";
  readonly resolvedId?: string;
  readonly candidates?: ResolveThreadCandidate[];
}

function normalize(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[「」『』“”"'`（）()【】\[\]、，。！？；：:\s]/gu, "");
}

function isOrderedSubsequence(needle: string, haystack: string): boolean {
  if (!needle) return false;
  let cursor = 0;
  for (const char of haystack) {
    if (char === needle[cursor]) cursor += 1;
    if (cursor >= needle.length) return true;
  }
  return false;
}

function titleMatches(query: string, title: string): boolean {
  const q = normalize(query);
  const t = normalize(title);
  if (!q || !t) return false;
  if (t.includes(q) || q.includes(t)) return true;
  if (isOrderedSubsequence(q, t)) return true;
  return bigramSimilarity(q, t) >= 0.45;
}

function candidateOf(thread: NarrativeThread): ResolveThreadCandidate {
  return {
    id: thread.id,
    title: thread.title,
    status: thread.status,
    type: thread.type,
  };
}

export async function runResolveThread(projectDir: string, query: string): Promise<ResolveThreadResult> {
  let pool;
  try {
    pool = await readThreadPool(projectDir);
  } catch (error) {
    return {
      ok: false,
      blockedReason: "read_failed",
      summary: `读取 threads.json 失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const candidates = pool.threads
    .filter((thread) => thread.status === "open" || thread.status === "touched")
    .filter((thread) => titleMatches(query, thread.title));

  if (candidates.length === 0) {
    return {
      ok: false,
      blockedReason: "thread_not_found",
      summary: `没有找到与「${query}」匹配的未收口线索。`,
    };
  }

  if (candidates.length > 1) {
    return {
      ok: false,
      blockedReason: "multiple_threads_matched",
      summary: `找到 ${candidates.length} 条相近线索，请说得更具体：${candidates.map((thread) => `「${thread.title}」`).join("、")}`,
      candidates: candidates.map(candidateOf),
    };
  }

  const target = candidates[0]!;
  const next = pool.threads.map((thread) =>
    thread.id === target.id
      ? { ...thread, status: "done" as const }
      : thread,
  );

  const threadsPath = join(projectDir, "story", "threads.json");
  try {
    await writeFileAtomic(threadsPath, `${JSON.stringify({ threads: next }, null, 2)}\n`);
  } catch (error) {
    return {
      ok: false,
      blockedReason: "write_failed",
      summary: `写回 threads.json 失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  return {
    ok: true,
    resolvedId: target.id,
    summary: `已收口线索「${target.title}」，可对我说「撤销」恢复。`,
  };
}

const inputSchema = z.object({
  query: z.string().min(1).describe("要收口的线索/伏笔标题或关键词，如『安保盘问』。"),
});

const outputSchema = z.object({
  snapshotId: z.string().describe("写前快照 id，可一键撤销本次收口。"),
  ok: z.boolean().describe("是否成功；false 时 summary 含原因。"),
  summary: z.string().describe("自然语言结果，供回答用户。"),
  blockedReason: z.string().optional().describe("失败或守卫原因。"),
  resolvedId: z.string().optional().describe("成功收口的线索 id。"),
  candidates: z.array(z.object({
    id: z.string(),
    title: z.string(),
    status: z.string(),
    type: z.string(),
  })).optional().describe("多命中时返回候选，供用户消歧。"),
});

export const resolveThreadTool = writeTool({
  id: "resolve_thread",
  description:
    "当用户明确说某条伏笔/线索已经完结、收口、收掉、标记完成时调用：" +
    "按标题或关键词模糊匹配 open/touched 线索，唯一命中才标 done；零命中/多命中会如实返回候选，不会写盘。" +
    "写前自动快照、可一键撤销。本工具有写入前守卫：本轮用户原话没有明确单条线索收口意图会被拒绝。",
  inputSchema,
  outputSchema,
  preflight: ({ context }) => {
    const userTurnText = readUserTurnTextFromContext(context);
    if (userTurnText === undefined || userTurnAllowsResolveThread(userTurnText)) return undefined;

    console.warn("[turn-intent-gate] 拦下未授权 resolve_thread（本轮用户原话无对应意图）");
    return {
      ok: false,
      blockedReason: "user_turn_no_resolve_thread_intent",
      summary: "本回合用户没有要求收口某条线索，已拦下自动收口。看到待收口提醒时请先转告用户，用户明确说收掉/完结后再做。",
    };
  },
  run: async ({ input, projectDir }) => runResolveThread(projectDir, input.query),
  snapshotDetail: (input) => `收口线索 ${input.query}`,
});
