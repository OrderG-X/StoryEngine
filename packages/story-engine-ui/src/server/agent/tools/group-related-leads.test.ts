// @vitest-environment node
import { chmod, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolExecutionContext } from "@mastra/core/tools";
import { describe, expect, it, vi } from "vitest";
import type { NarrativeThread } from "@actalk/story-engine";
import { buildProjectRequestContext } from "../request-context.js";
import { listSnapshots } from "../../lib/snapshot.js";
import { groupRelatedLeadsTool, runGroupRelatedLeads } from "./group-related-leads.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

const lead = (
  id: string,
  title: string,
  over: Partial<NarrativeThread> = {},
): NarrativeThread => ({
  id,
  type: "lead",
  title,
  status: "open",
  firstSeenChapter: 1,
  lastTouchedChapter: 1,
  evidence: [title],
  ...over,
});

async function tempProject(threads: NarrativeThread[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "group-related-leads-"));
  await mkdir(join(dir, "story"), { recursive: true });
  await writeFile(
    join(dir, "story", "threads.json"),
    JSON.stringify({ threads }, null, 2),
    "utf-8",
  );
  return dir;
}

async function readThreadsFile(dir: string): Promise<NarrativeThread[]> {
  const raw = JSON.parse(
    await readFile(join(dir, "story", "threads.json"), "utf-8"),
  ) as { threads: NarrativeThread[] };
  return raw.threads;
}

// ─── 测试数据 ──────────────────────────────────────────────────────────────────

/** 3 条"响动"lead（不同 firstSeenChapter）+ 1 条借条 lead。 */
function makeTestThreads(): NarrativeThread[] {
  return [
    lead("dong-1", "不连续的响动", { firstSeenChapter: 3, evidence: ["第3章有响动"] }),
    lead("dong-2", "墙里的声音", { firstSeenChapter: 1, evidence: ["第1章墙里声音"] }),
    lead("dong-3", "半夜响动声", { firstSeenChapter: 5, evidence: ["第5章半夜响动"] }),
    lead("jiutiao", "抽屉夹层藏着借条", { firstSeenChapter: 2, evidence: ["第2章发现借条"] }),
  ];
}

/** mock callModel：把 3 条响动 id 归一组 */
function mockCallModelGroup(): (messages: { role: string; content: string }[]) => Promise<string> {
  return vi.fn().mockResolvedValue(
    JSON.stringify({ groups: [{ memberIds: ["dong-1", "dong-2", "dong-3"] }] }),
  );
}

/** mock callModel：空组，没有可合并的 */
function mockCallModelEmpty(): (messages: { role: string; content: string }[]) => Promise<string> {
  return vi.fn().mockResolvedValue(JSON.stringify({ groups: [] }));
}

// ─── 测试集 ───────────────────────────────────────────────────────────────────

describe("runGroupRelatedLeads", () => {
  it("3条响动归组 → winner(firstSeen最早)+2stale、借条不动、ok:true + 数字对", async () => {
    const threads = makeTestThreads();
    const dir = await tempProject(threads);
    const mockCall = mockCallModelGroup();

    const result = await runGroupRelatedLeads(dir, mockCall);

    expect(result.ok).toBe(true);
    expect(result.groupCount).toBe(1);
    expect(result.mergedCount).toBe(2); // 3条-winner=2 loser

    // winner = dong-2（firstSeenChapter=1 最早）
    const saved = await readThreadsFile(dir);
    const byId = Object.fromEntries(saved.map((t) => [t.id, t]));

    expect(byId["dong-2"].status).toBe("open"); // winner 不变
    expect(byId["dong-1"].status).toBe("stale"); // loser
    expect(byId["dong-3"].status).toBe("stale"); // loser
    expect(byId["jiutiao"].status).toBe("open"); // 借条完全不动

    // winner evidence 被并入了其他两条
    expect(byId["dong-2"].evidence).toEqual(
      expect.arrayContaining(["第1章墙里声音", "第3章有响动", "第5章半夜响动"]),
    );

    // summary 含合并信息和撤销提示
    expect(result.summary).toMatch(/1/);
    expect(result.summary).toMatch(/2/);
    expect(result.summary).toMatch(/撤销/);
  });

  it("mock返回空groups → 「没有可合并的同类线索」、不写盘", async () => {
    const threads = makeTestThreads();
    const dir = await tempProject(threads);
    const before = await readFile(join(dir, "story", "threads.json"), "utf-8");

    const result = await runGroupRelatedLeads(dir, mockCallModelEmpty());

    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/没有可合并/);
    expect(result.mergedCount).toBeUndefined();

    // threads.json 完全不变
    const after = await readFile(join(dir, "story", "threads.json"), "utf-8");
    expect(after).toBe(before);
  });

  it("<2条 lead → 「线索不足」、不写盘", async () => {
    // 只有 1 条 lead
    const threads: NarrativeThread[] = [
      lead("solo", "孤独的线索"),
    ];
    const dir = await tempProject(threads);
    const before = await readFile(join(dir, "story", "threads.json"), "utf-8");

    const result = await runGroupRelatedLeads(dir, mockCallModelGroup());

    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/线索不足/);

    // threads.json 完全不变
    const after = await readFile(join(dir, "story", "threads.json"), "utf-8");
    expect(after).toBe(before);
  });

  it("callModel 抛错 → ok:false、不写盘", async () => {
    const threads = makeTestThreads();
    const dir = await tempProject(threads);
    const before = await readFile(join(dir, "story", "threads.json"), "utf-8");

    const failingCall = vi.fn().mockRejectedValue(new Error("GLM 调用超时"));

    const result = await runGroupRelatedLeads(dir, failingCall);

    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/GLM 调用超时/);

    // threads.json 完全不变
    const after = await readFile(join(dir, "story", "threads.json"), "utf-8");
    expect(after).toBe(before);
  });

  it("项目无 threads.json（空项目）→ 线索不足、不写盘", async () => {
    const dir = await mkdtemp(join(tmpdir(), "group-related-leads-empty-"));
    // 不建 story 子目录和 threads.json → readThreadPool graceful fallback

    const result = await runGroupRelatedLeads(dir, mockCallModelGroup());

    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/线索不足/);
  });

  it("写盘失败（story 目录只读）→ ok:false 如实回报、threads.json 原样、不留 tmp 残留", async () => {
    const dir = await tempProject(makeTestThreads());
    const storyDir = join(dir, "story");
    const threadsPath = join(storyDir, "threads.json");
    const before = await readFile(threadsPath, "utf-8");
    // 与 character-enrichment 同款失败注入：目录只读 → writeFileAtomic 建不出临时文件、抛 EACCES。
    // 「rename 失败时自清已建 tmp」的口径锁在 project-io.test.ts 的 writeFileAtomic 用例里（那里能确定性造出 rename 失败）。
    await chmod(storyDir, 0o555);
    try {
      const result = await runGroupRelatedLeads(dir, mockCallModelGroup());

      expect(result.ok).toBe(false);
      expect(result.summary).toContain("写回 threads.json 失败");
      expect(await readFile(threadsPath, "utf-8")).toBe(before);
      const residue = (await readdir(storyDir)).filter((entry) => entry.includes(".tmp"));
      expect(residue).toEqual([]);
    } finally {
      await chmod(storyDir, 0o755);
    }
  });
});

describe("group_related_leads 本轮意图门", () => {
  it("本轮用户没有归并线索意图 → 写入前拦截，不调模型、不建快照", async () => {
    const dir = await tempProject(makeTestThreads());
    const before = await readFile(join(dir, "story", "threads.json"), "utf-8");
    const beforeSnapshots = await listSnapshots(dir);
    const context = {
      requestContext: buildProjectRequestContext(dir, 57, undefined, "继续写第57章正文。只写这一章，不要写其他章。"),
    } as unknown as ToolExecutionContext;
    const execute = groupRelatedLeadsTool.execute as unknown as (input: Record<string, unknown>, context: ToolExecutionContext) => Promise<unknown>;

    const result = await execute({}, context) as { ok: boolean; blockedReason?: string; summary: string };

    expect(result.ok).toBe(false);
    expect(result.blockedReason).toBe("user_turn_no_thread_cleanup_intent");
    expect(result.summary).toContain("本回合用户没有要求清理/归并线索");
    expect(await readFile(join(dir, "story", "threads.json"), "utf-8")).toBe(before);
    expect(await listSnapshots(dir)).toHaveLength(beforeSnapshots.length);
  });
});
