import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import { afterAll, describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { registerSnapshotsRoutes } from "./snapshots.js";
import { createSnapshot, listSnapshots } from "../lib/snapshot.js";
import { testRunRoot } from "../lib/home-test-tmp.js";
import type { Middleware } from "../lib/project-io.js";

const execFileAsync = promisify(execFile);

// guardProjectPath 要求项目路径在 $HOME 下（tmpdir 会被判不安全）；统一收敛到本次运行专属 run 目录下。
const TEST_ROOT = join(testRunRoot(), "se-snap-route-test");

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

  it("裁剪操作历史没有 HTTP 入口（重构 P4：只能由作者点「确认裁剪」按钮）：POST /api/snapshots/prune 带 confirm 也不裁", async () => {
    const dir = await makeProject();
    await createSnapshot(dir, "起点");
    for (let i = 0; i < 5; i += 1) {
      await execFileAsync("git", ["-C", dir, "commit", "--allow-empty", "-m", `快照 ${i + 1}`]);
    }
    const before = (await listSnapshots(dir, 100)).length;
    const res = await callSnapshotsRoute("POST", "/api/snapshots/prune", { projectPath: dir, keep: 1, confirm: true });
    expect(res.statusCode).toBe(405);
    expect((await listSnapshots(dir, 100)).length).toBe(before);
  });
});

