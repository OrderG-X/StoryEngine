/**
 * 写入路由前置自动快照集成测试：
 * 代表用例 1：POST /api/books/story-settings —— 写入前自动留"故事设定修改前快照"
 */
import { createHash } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStoryProject } from "@actalk/story-engine";
import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import { listSnapshots } from "../lib/snapshot.js";
import { registerBooksRoutes } from "./books.js";
import { callRoute, makeMinimalProject } from "./test-helpers.js";

// guardProjectPath 要求项目路径在 $HOME 下；本文件用自己独立的隐藏临时根目录，afterAll 清理
let testRoot: string;

beforeAll(async () => {
  testRoot = await makeHomeTempDir("se-snap-int-");
});

afterAll(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

describe("write routes take an automatic snapshot before the first write", () => {
  it("POST /api/books/story-settings snapshots before writing settings", async () => {
    const { projectDir } = await createStoryProject({
      rootDir: testRoot,
      title: "快照集成测试",
      genre: "都市",
      premise: "主角进入集团权力中心。",
      mainCharacterName: "林远",
    });

    const { statusCode, payload } = await callRoute(registerBooksRoutes, "POST", "/api/books/story-settings", {
      projectPath: projectDir,
      title: "快照集成测试·改",
      genre: "都市爽文",
      logline: "主角在董事会上反击。",
    });

    expect(statusCode).toBe(200);
    expect(payload.ok).toBe(true);
    await expect(access(join(projectDir, ".git"))).resolves.toBeUndefined();
    const snapshots = await listSnapshots(projectDir);
    expect(snapshots[0]?.label).toBe("故事设定修改前快照");
    // 写入确实发生在快照之后：当前文件已是新标题
    await expect(readFile(join(projectDir, "project.json"), "utf-8")).resolves.toContain("快照集成测试·改");
  });


});

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf-8").digest("hex");
}
