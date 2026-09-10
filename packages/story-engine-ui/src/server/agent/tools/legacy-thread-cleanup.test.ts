// @vitest-environment node
import { chmod, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolExecutionContext } from "@mastra/core/tools";
import { describe, expect, it } from "vitest";
import { buildProjectRequestContext } from "../request-context.js";
import { listSnapshots } from "../../lib/snapshot.js";
import { cleanLegacyThreadsTool, planLegacyThreadCleanup, runCleanLegacyThreads } from "./legacy-thread-cleanup.js";
import type { NarrativeThread } from "@actalk/story-engine";

const lead = (id: string, title: string, over: Partial<NarrativeThread> = {}): NarrativeThread => ({
  id, type: "lead", title, status: "open", firstSeenChapter: 1, lastTouchedChapter: 1, evidence: [title], ...over,
});

/** Build a temporary project dir with story/threads.json pre-populated. */
async function tempProject(threads: NarrativeThread[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "clean-legacy-threads-"));
  await mkdir(join(dir, "story"), { recursive: true });
  await writeFile(
    join(dir, "story", "threads.json"),
    JSON.stringify({ threads }, null, 2),
    "utf-8",
  );
  return dir;
}

describe("planLegacyThreadCleanup", () => {
  it("垃圾 lead 标 stale、真线索保留", () => {
    const r = planLegacyThreadCleanup([lead("a", "没有响动"), lead("b", "抽屉夹层藏着借条")]);
    expect(r.staleIds).toContain("a");
    expect(r.staleIds).not.toContain("b");
    expect(r.next.find((t) => t.id === "a")!.status).toBe("stale");
    expect(r.next.find((t) => t.id === "b")!.status).toBe("open");
  });
  it("近重复合并:firstSeenChapter 最早者为 winner、loser stale + evidence 并入 winner", () => {
    // w 第 1 章先出现、l 第 3 章才出现 → w 为 winner（与 group_related_leads 同一规则：firstSeenChapter 最早胜）
    const r = planLegacyThreadCleanup([
      lead("w", "不连续的响动", { evidence: ["e1"] }),
      lead("l", "不连续的响动声", { evidence: ["e2"], firstSeenChapter: 3, lastTouchedChapter: 5 }),
    ]);
    expect(r.staleIds).toContain("l");
    expect(r.mergedPairs).toContainEqual({ loserId: "l", winnerId: "w" });
    expect(r.next.find((t) => t.id === "w")!.evidence).toEqual(expect.arrayContaining(["e1", "e2"]));
  });
  it("winner tiebreaker:firstSeenChapter 并列时 title 较长者为 winner（与 group_related_leads 一致）", () => {
    // 同章出现的近重复，长标题者胜（统一 winner 规则、消除两工具顺序依赖）
    const r = planLegacyThreadCleanup([
      lead("short", "悬空的借条", { evidence: ["e1"], firstSeenChapter: 2 }),
      lead("long", "悬空的借条副本", { evidence: ["e2"], firstSeenChapter: 2 }),
    ]);
    expect(r.mergedPairs).toContainEqual({ loserId: "short", winnerId: "long" });
    expect(r.next.find((t) => t.id === "long")!.evidence).toEqual(expect.arrayContaining(["e1", "e2"]));
  });
  it("3+ 条互为近重复：所有 loser 的 evidence 都并进唯一 winner、不漏（治锚点已 stale 仍被当锚致静默丢失）", () => {
    // 输入顺序故意让较晚的 X 排在最早的 Y 前面：X 先输给 Y 成 loser，若不 break 会被当 Z 的锚 → evZ 丢进已 stale 的 X
    const r = planLegacyThreadCleanup([
      lead("X", "悬空的借条副本", { firstSeenChapter: 5, evidence: ["evX"] }),
      lead("Y", "悬空的借条", { firstSeenChapter: 1, evidence: ["evY"] }),
      lead("Z", "悬空的借条原件", { firstSeenChapter: 5, evidence: ["evZ"] }),
    ]);
    const winner = r.next.find((t) => t.id === "Y")!;
    expect(winner.status).toBe("open"); // Y 最早 = winner
    expect(winner.evidence).toEqual(expect.arrayContaining(["evX", "evY", "evZ"])); // 三条证据全在 winner，evZ 没丢
    expect(r.next.find((t) => t.id === "X")!.status).toBe("stale");
    expect(r.next.find((t) => t.id === "Z")!.status).toBe("stale");
  });
  it("anti-merge:不同伏笔不被合并", () => {
    const r = planLegacyThreadCleanup([lead("x", "父亲的债"), lead("y", "邻居的债")]);
    expect(r.staleIds).toEqual([]);
    expect(r.mergedPairs).toEqual([]);
  });
  it("不碰 intent / done / stale", () => {
    const r = planLegacyThreadCleanup([
      { ...lead("i", "没有响动"), type: "intent" },
      { ...lead("d", "没有响动"), status: "done" },
    ]);
    expect(r.staleIds).toEqual([]);
  });
  it("无可清理 → 计划为空、next 等价", () => {
    const input = [lead("b", "抽屉夹层藏着借条")];
    const r = planLegacyThreadCleanup(input);
    expect(r.staleIds).toEqual([]);
    expect(r.next.map((t) => t.status)).toEqual(["open"]);
  });
  it("泛化：「没有踪迹」(非声音词否定) → stale", () => {
    // 验证否定判定不再依赖声音名词枚举，任何「没有+短字」均命中
    const r = planLegacyThreadCleanup([lead("z", "没有踪迹")]);
    expect(r.staleIds).toContain("z");
    expect(r.next.find((t) => t.id === "z")!.status).toBe("stale");
  });
  it("题材中立：「父亲的声音」含'声音'但无否定前缀 → 保留 open", () => {
    // 验证去掉声音词表后，「声音」单独出现不再触发误判
    const r = planLegacyThreadCleanup([lead("s", "父亲的声音", { evidence: ["第3章父亲留下的声音"] })]);
    expect(r.staleIds).not.toContain("s");
    expect(r.next.find((t) => t.id === "s")!.status).toBe("open");
  });
});

describe("runCleanLegacyThreads 集成", () => {
  it("垃圾+近重复 → 写回 threads.json，垃圾/loser变stale，真线索仍open，ok+数字对", async () => {
    const threads: NarrativeThread[] = [
      lead("garbage", "没有响动"),
      lead("real", "抽屉夹层藏着借条", { evidence: ["第2章发现夹层"] }),
      lead("dup-a", "悬空的借条", { evidence: ["ev1"] }),
      lead("dup-b", "悬空的借条副本", { evidence: ["ev2"], firstSeenChapter: 4, lastTouchedChapter: 5 }),
    ];
    const dir = await tempProject(threads);

    const result = await runCleanLegacyThreads(dir);

    expect(result.ok).toBe(true);
    // 垃圾: garbage (stale 且不是 mergedPair loser)
    // 近重复: dup-a 第 1 章先出现为 winner、dup-b 第 4 章才出现为 loser（firstSeenChapter 最早胜）
    // 所以 staleCount = 1 (纯垃圾), mergedCount = 1
    expect(result.staleCount).toBeGreaterThanOrEqual(1);
    expect(result.mergedCount).toBeGreaterThanOrEqual(1);
    expect(result.summary).toMatch(/清理了/);
    expect(result.summary).toMatch(/撤销/);

    // 读回并断言
    const raw = JSON.parse(await readFile(join(dir, "story", "threads.json"), "utf-8")) as {
      threads: NarrativeThread[];
    };
    const byId = Object.fromEntries(raw.threads.map((t) => [t.id, t]));
    expect(byId["garbage"].status).toBe("stale");
    expect(byId["real"].status).toBe("open");
    // loser (dup-b) → stale
    expect(byId["dup-b"].status).toBe("stale");
    // winner (dup-a) evidence 含两条
    expect(byId["dup-a"].evidence).toEqual(expect.arrayContaining(["ev1", "ev2"]));
  });

  it("无可清理 → ok:true、summary含『没有需要清理』、threads.json不变", async () => {
    const threads: NarrativeThread[] = [
      lead("real1", "抽屉夹层藏着借条"),
      lead("real2", "父亲的债", { evidence: ["第3章提到父亲欠了钱"] }),
    ];
    const dir = await tempProject(threads);
    const before = await readFile(join(dir, "story", "threads.json"), "utf-8");

    const result = await runCleanLegacyThreads(dir);

    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/没有需要清理/);
    // 文件不应该被改写
    const after = await readFile(join(dir, "story", "threads.json"), "utf-8");
    expect(after).toBe(before);
  });

  it("projectDir 不存在 (无 threads.json) → readThreadPool 返回空 threads → ok:true 没有需要清理", async () => {
    // readThreadPool ENOENT → { threads: [] } (graceful fallback in engine)
    const dir = await mkdtemp(join(tmpdir(), "clean-legacy-empty-"));
    // 不建 story 子目录，也不写 threads.json
    const result = await runCleanLegacyThreads(dir);
    // empty threads → nothing to clean → summary 含"没有需要清理"
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/没有需要清理/);
  });

  it("写盘失败（story 目录只读）→ ok:false 如实回报、threads.json 原样、不留 tmp 残留", async () => {
    const threads: NarrativeThread[] = [lead("garbage", "没有响动")];
    const dir = await tempProject(threads);
    const storyDir = join(dir, "story");
    const threadsPath = join(storyDir, "threads.json");
    const before = await readFile(threadsPath, "utf-8");
    // 与 character-enrichment 同款失败注入：目录只读 → writeFileAtomic 建不出临时文件、抛 EACCES。
    // 「rename 失败时自清已建 tmp」的口径锁在 project-io.test.ts 的 writeFileAtomic 用例里（那里能确定性造出 rename 失败）。
    await chmod(storyDir, 0o555);
    try {
      const result = await runCleanLegacyThreads(dir);

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

describe("clean_legacy_threads 本轮意图门", () => {
  it("本轮用户没有清理线索意图 → 写入前拦截，不改 threads.json、不建快照", async () => {
    const threads: NarrativeThread[] = [lead("garbage", "没有响动")];
    const dir = await tempProject(threads);
    const before = await readFile(join(dir, "story", "threads.json"), "utf-8");
    const beforeSnapshots = await listSnapshots(dir);
    const context = {
      requestContext: buildProjectRequestContext(dir, 56, undefined, "继续写第56章正文。只写这一章，不要写其他章。"),
    } as unknown as ToolExecutionContext;
    const execute = cleanLegacyThreadsTool.execute as unknown as (input: Record<string, unknown>, context: ToolExecutionContext) => Promise<unknown>;

    const result = await execute({}, context) as { ok: boolean; blockedReason?: string; summary: string };

    expect(result.ok).toBe(false);
    expect(result.blockedReason).toBe("user_turn_no_thread_cleanup_intent");
    expect(result.summary).toContain("本回合用户没有要求清理/归并线索");
    expect(await readFile(join(dir, "story", "threads.json"), "utf-8")).toBe(before);
    expect(await listSnapshots(dir)).toHaveLength(beforeSnapshots.length);
  });
});
