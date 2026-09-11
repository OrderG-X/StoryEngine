import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import { afterAll, describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { registerSnapshotsRoutes } from "./snapshots.js";
import { createSnapshot, listSnapshots } from "../lib/snapshot.js";
import { HOME_TEST_TMP_ROOT } from "../lib/home-test-tmp.js";
import type { Middleware } from "../lib/project-io.js";

const execFileAsync = promisify(execFile);

// guardProjectPath 要求项目路径在 $HOME 下（tmpdir 会被判不安全）；统一收敛到隐藏测试基目录下。
const TEST_ROOT = join(HOME_TEST_TMP_ROOT, "se-snap-route-test");

async function makeProject(): Promise<string> {
  await mkdir(TEST_ROOT, { recursive: true });
  const dir = await mkdtemp(join(TEST_ROOT, "p-"));
  await writeFile(join(dir, "project.json"), JSON.stringify({ title: "测试书" }), "utf-8");
  for (const d of ["story", "timeline", "world", "characters"]) {
    await mkdir(join(dir, d), { recursive: true });
  }
  await writeFile(join(dir, "story", "threads.json"), JSON.stringify({ threads: [] }), "utf-8");
  return dir;
}

afterAll(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
});

async function callSnapshotsRoute(
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
): Promise<{
  readonly statusCode: number;
  readonly payload: Record<string, unknown>;
}> {
  const handlers: Middleware[] = [];
  registerSnapshotsRoutes({ use: (handler) => handlers.push(handler) });
  const rawBody = body === undefined ? "" : JSON.stringify(body);
  const req = Object.assign(Readable.from(rawBody ? [Buffer.from(rawBody)] : []), {
    method,
    url: path,
  }) as IncomingMessage;
  const chunks: Buffer[] = [];
  const res = {
    statusCode: 200,
    setHeader: (name: string, value: string | number | readonly string[]) => {
      void name;
      void value;
      return res as unknown as ServerResponse;
    },
    end: (chunk?: string | Buffer) => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return res as unknown as ServerResponse;
    },
  } as unknown as ServerResponse;

  await new Promise<void>((resolve, reject) => {
    const result = handlers[0]?.(req, res, (error?: unknown) => error ? reject(error) : resolve()) as unknown;
    Promise.resolve(result).then(() => resolve(), reject);
  });

  const payload = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown>;
  return { statusCode: res.statusCode, payload };
}

describe("snapshots routes", () => {
  it("GET /api/snapshots returns history newest-first", async () => {
    const dir = await makeProject();
    await createSnapshot(dir, "第一次");
    const { statusCode, payload } = await callSnapshotsRoute(
      "GET",
      `/api/snapshots?project=${encodeURIComponent(dir)}`,
    );
    expect(statusCode).toBe(200);
    expect(payload.ok).toBe(true);
    const snapshots = payload.snapshots as Array<{ id: string; label: string; timestamp: number }>;
    expect(snapshots.length).toBeGreaterThanOrEqual(1);
    expect(snapshots[0]?.label).toBe("第一次");
    expect(snapshots[0]?.id).toMatch(/^[0-9a-f]{40}$/);
  });

  it("POST /api/snapshots/restore restores and reports the new entry", async () => {
    const dir = await makeProject();
    const snap = await createSnapshot(dir, "好状态");
    await writeFile(join(dir, "story", "extra.json"), "{}", "utf-8");
    await createSnapshot(dir, "坏状态");
    const { statusCode, payload } = await callSnapshotsRoute("POST", "/api/snapshots/restore", {
      projectPath: dir,
      id: snap.id,
    });
    expect(statusCode).toBe(200);
    expect(payload.ok).toBe(true);
    const restored = payload.restored as { id: string; label: string };
    expect(restored.label).toContain("恢复到");
  });

  it("rejects unsafe project paths", async () => {
    const { statusCode, payload } = await callSnapshotsRoute(
      "GET",
      `/api/snapshots?project=${encodeURIComponent("/etc")}`,
    );
    expect(statusCode).toBe(400);
    expect(payload.ok).toBe(false);
  });

  it("POST /api/snapshots/prune 默认 dry-run 不落盘，confirm=true 才真裁（bundle 落在 SE_DATA_DIR 下、项目目录之外）", async () => {
    const dir = await makeProject();
    await createSnapshot(dir, "起点"); // init + 本条 = 2
    for (let i = 0; i < 28; i += 1) {
      await execFileAsync("git", ["-C", dir, "commit", "--allow-empty", "-m", `快照 ${i + 1}`]);
    }
    expect((await listSnapshots(dir, 100)).length).toBe(30);

    // 备份目录经 SE_DATA_DIR 重定向到测试临时区，不碰真实 ~/.story-engine
    const seDataDir = join(TEST_ROOT, `se-data-${Date.now()}`);
    await mkdir(seDataDir, { recursive: true });
    process.env.SE_DATA_DIR = seDataDir;
    try {
      const dry = await callSnapshotsRoute("POST", "/api/snapshots/prune", { projectPath: dir, keep: 20 });
      expect(dry.statusCode).toBe(200);
      const dryResult = dry.payload.result as { dryRun: boolean; prunedCount: number; totalAfter: number; freedCommits: number };
      expect(dryResult.dryRun).toBe(true);
      expect(dryResult.prunedCount).toBe(10);
      expect(dryResult.totalAfter).toBe(21);
      expect(dryResult.freedCommits).toBe(9);
      expect((await listSnapshots(dir, 100)).length).toBe(30); // 预览不动历史

      const real = await callSnapshotsRoute("POST", "/api/snapshots/prune", { projectPath: dir, keep: 20, confirm: true });
      expect(real.statusCode).toBe(200);
      const realResult = real.payload.result as { dryRun: boolean; prunedCount: number; backupBundlePath?: string };
      expect(realResult.dryRun).toBe(false);
      expect(realResult.prunedCount).toBe(10);
      expect((await listSnapshots(dir, 100)).length).toBe(21); // 20 保留 + 1 base
      expect(realResult.backupBundlePath).toBeDefined();
      expect(realResult.backupBundlePath!.startsWith(seDataDir)).toBe(true);
      await access(realResult.backupBundlePath!);
    } finally {
      delete process.env.SE_DATA_DIR;
    }
  }, 60_000);

  it("POST /api/snapshots/prune confirm=true 但无需裁剪时，dryRun 按「没落盘」口径回 true（与工具侧一致）", async () => {
    const dir = await makeProject();
    await createSnapshot(dir, "唯一快照"); // init + 本条 = 2，远低于 keep 默认 200 → 无需裁剪
    // 预览 no-op：新旧口径都是 true（钉住不漂移）
    const dry = await callSnapshotsRoute("POST", "/api/snapshots/prune", { projectPath: dir });
    expect(dry.statusCode).toBe(200);
    const dryResult = dry.payload.result as { dryRun: boolean; prunedCount: number };
    expect(dryResult.prunedCount).toBe(0);
    expect(dryResult.dryRun).toBe(true);
    // confirm=true 的 no-op：老口径回 false（请求口径），新口径须回 true（什么都没落盘）
    const real = await callSnapshotsRoute("POST", "/api/snapshots/prune", { projectPath: dir, confirm: true });
    expect(real.statusCode).toBe(200);
    const realResult = real.payload.result as { dryRun: boolean; prunedCount: number };
    expect(realResult.prunedCount).toBe(0);
    expect(realResult.dryRun).toBe(true);
  });
});

