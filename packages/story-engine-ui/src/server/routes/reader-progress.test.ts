// @vitest-environment node
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import { registerReaderProgressRoutes } from "./reader-progress.js";
import { callRoute } from "./test-helpers.js";

/** 建一个带 agents/<角色>/progress.json 的临时项目目录。progress 按「角色 → 文件内容」给。 */
async function projectWithProgress(prefix: string, progress: Record<string, object>): Promise<string> {
  const dir = await makeHomeTempDir(prefix);
  for (const [roleId, payload] of Object.entries(progress)) {
    await mkdir(join(dir, "agents", roleId), { recursive: true });
    await writeFile(join(dir, "agents", roleId, "progress.json"), JSON.stringify(payload, null, 2), "utf-8");
  }
  return dir;
}

const get = (dir: string) => callRoute(registerReaderProgressRoutes, "GET", `/api/reader-progress?project=${encodeURIComponent(dir)}`);

describe("GET /api/reader-progress（R4.3 在读前文轻量轮询）", () => {
  it("没在读：reading:false（前端收到就停轮询），roles 形状照给", async () => {
    const dir = await projectWithProgress("reader-progress-idle-", {
      checker: { role: "checker", reading: false, done: 58, total: 58, updatedAt: "2026-10-13T00:00:00.000Z" },
    });
    const { statusCode, payload } = await get(dir);
    expect(statusCode).toBe(200);
    expect(payload).toEqual({
      ok: true,
      reading: false,
      roles: [
        { role: "checker", reading: false, done: 58, total: 58 },
        { role: "ledger", reading: false, done: 0, total: 0 },
        { role: "planner", reading: false, done: 0, total: 0 },
      ],
    });
  });

  it("还在读：reading:true，三个角色各自的 done/total 如实带出", async () => {
    const dir = await projectWithProgress("reader-progress-live-", {
      checker: { role: "checker", reading: true, done: 34, total: 58, updatedAt: "2026-10-13T00:00:00.000Z" },
      ledger: { role: "ledger", reading: false, done: 58, total: 58, updatedAt: "2026-10-13T00:00:00.000Z" },
    });
    const { statusCode, payload } = await get(dir);
    expect(statusCode).toBe(200);
    expect(payload).toEqual({
      ok: true,
      reading: true,
      roles: [
        { role: "checker", reading: true, done: 34, total: 58 },
        { role: "ledger", reading: false, done: 58, total: 58 },
        { role: "planner", reading: false, done: 0, total: 0 },
      ],
    });
  });

  it("老书没开过编辑部（一个 progress 都没有）：reading:false、三角色 0/0，不炸", async () => {
    const dir = await makeHomeTempDir("reader-progress-fresh-");
    const { statusCode, payload } = await get(dir);
    expect(statusCode).toBe(200);
    expect(payload).toMatchObject({ ok: true, reading: false });
    expect((payload.roles as { role: string }[]).map((role) => role.role)).toEqual(["checker", "ledger", "planner"]);
  });

  it("缺项目路径 400；路径不安全 400", async () => {
    expect((await callRoute(registerReaderProgressRoutes, "GET", "/api/reader-progress")).statusCode).toBe(400);
    expect((await callRoute(registerReaderProgressRoutes, "GET", "/api/reader-progress?project=../outside")).statusCode).toBe(400);
  });

  it("只收 GET", async () => {
    const { statusCode } = await callRoute(registerReaderProgressRoutes, "POST" as "GET", "/api/reader-progress?project=/tmp/x");
    expect(statusCode).toBe(405);
  });
});
