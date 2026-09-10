import { chmod, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { runResolveThread } from "./resolve-thread.js";

async function makeProject(threads: unknown[]) {
  const dir = await mkdtemp(join(tmpdir(), "resolve-thread-"));
  await mkdir(join(dir, "story"), { recursive: true });
  await writeFile(join(dir, "story", "threads.json"), `${JSON.stringify({ threads }, null, 2)}\n`, "utf-8");
  return dir;
}

async function readThreads(projectDir: string) {
  return JSON.parse(await readFile(join(projectDir, "story", "threads.json"), "utf-8")).threads as Array<{ id: string; status: string }>;
}

describe("runResolveThread", () => {
  it("marks the unique matching open thread done", async () => {
    const projectDir = await makeProject([
      { id: "intent-a", type: "intent", title: "韩青需要应对安保人员的盘问", status: "open", firstSeenChapter: 2, lastTouchedChapter: 2, evidence: ["被安保拦住。"] },
      { id: "lead-b", type: "lead", title: "王磊倒卖氧气滤芯", status: "open", firstSeenChapter: 4, lastTouchedChapter: 4, evidence: ["王磊有前科。"] },
    ]);

    const result = await runResolveThread(projectDir, "安保盘问");

    expect(result).toMatchObject({ ok: true, resolvedId: "intent-a" });
    expect(result.summary).toContain("已收口");
    const threads = await readThreads(projectDir);
    expect(threads.find((thread) => thread.id === "intent-a")?.status).toBe("done");
    expect(threads.find((thread) => thread.id === "lead-b")?.status).toBe("open");
  });

  it("does not write when there is no match", async () => {
    const projectDir = await makeProject([
      { id: "lead-b", type: "lead", title: "王磊倒卖氧气滤芯", status: "open", firstSeenChapter: 4, lastTouchedChapter: 4, evidence: ["王磊有前科。"] },
    ]);

    const result = await runResolveThread(projectDir, "安保盘问");

    expect(result.ok).toBe(false);
    expect(result.blockedReason).toBe("thread_not_found");
    expect(await readThreads(projectDir)).toEqual([
      { id: "lead-b", type: "lead", title: "王磊倒卖氧气滤芯", status: "open", firstSeenChapter: 4, lastTouchedChapter: 4, evidence: ["王磊有前科。"] },
    ]);
  });

  it("does not write when multiple threads match", async () => {
    const projectDir = await makeProject([
      { id: "intent-a", type: "intent", title: "韩青需要应对安保人员的盘问", status: "open", firstSeenChapter: 2, lastTouchedChapter: 2, evidence: ["被安保拦住。"] },
      { id: "intent-b", type: "intent", title: "韩青需要处理安保盘问后续", status: "open", firstSeenChapter: 3, lastTouchedChapter: 3, evidence: ["还要处理。"] },
    ]);

    const result = await runResolveThread(projectDir, "安保盘问");

    expect(result.ok).toBe(false);
    expect(result.blockedReason).toBe("multiple_threads_matched");
    expect(result.candidates?.map((candidate) => candidate.id)).toEqual(["intent-a", "intent-b"]);
    expect((await readThreads(projectDir)).every((thread) => thread.status === "open")).toBe(true);
  });

  it("写盘失败（story 目录只读）→ ok:false write_failed 如实回报、threads.json 原样、不留 tmp 残留", async () => {
    const projectDir = await makeProject([
      { id: "lead-b", type: "lead", title: "王磊倒卖氧气滤芯", status: "open", firstSeenChapter: 4, lastTouchedChapter: 4, evidence: ["王磊有前科。"] },
    ]);
    const storyDir = join(projectDir, "story");
    const threadsPath = join(storyDir, "threads.json");
    const before = await readFile(threadsPath, "utf-8");
    // 与 character-enrichment 同款失败注入：目录只读 → writeFileAtomic 建不出临时文件、抛 EACCES。
    // 「rename 失败时自清已建 tmp」的口径锁在 project-io.test.ts 的 writeFileAtomic 用例里（那里能确定性造出 rename 失败）。
    await chmod(storyDir, 0o555);
    try {
      const result = await runResolveThread(projectDir, "氧气滤芯");

      expect(result.ok).toBe(false);
      expect(result.blockedReason).toBe("write_failed");
      expect(result.summary).toContain("写回 threads.json 失败");
      expect(await readFile(threadsPath, "utf-8")).toBe(before);
      const residue = (await readdir(storyDir)).filter((entry) => entry.includes(".tmp"));
      expect(residue).toEqual([]);
    } finally {
      await chmod(storyDir, 0o755);
    }
  });
});
