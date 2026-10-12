// @vitest-environment node
//
// undo_last_change 工具回执（R4.2·验收 3.2）：真撤销 + 回执写清实际退回了什么、去哪找回。
// 旧回执「只撤了这一步」给了模型编「第 5 章草稿没受影响」的空间——回执必须列清单。
// 用临时项目 + 真实 git 快照验（不打网络；overview 构建失败按工具实现降级为 undefined）。
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import { createSnapshot, runWithSnapshot } from "../../lib/snapshot.js";
import { buildProjectRequestContext } from "../request-context.js";
import { undoLastChangeTool } from "./undo-last-change.js";

type Exec = (input: Record<string, never>, context: unknown) => Promise<{ ok: boolean; undone: boolean; summary: string }>;
const execute = undoLastChangeTool.execute as unknown as Exec;

async function makeProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "se-undo-tool-test-"));
  await mkdir(join(dir, "story"), { recursive: true });
  await mkdir(join(dir, "characters", "char-protag"), { recursive: true });
  await writeFile(join(dir, "project.json"), JSON.stringify({ title: "撤销回执测试书" }), "utf-8");
  await writeFile(join(dir, "story", "threads.json"), JSON.stringify({ threads: [] }), "utf-8");
  await writeFile(join(dir, "characters", "char-protag", "core.json"), JSON.stringify({ id: "char-protag", name: "主角" }), "utf-8");
  return dir;
}

async function undo(projectDir: string) {
  return execute({}, { requestContext: buildProjectRequestContext(projectDir) });
}

describe("undo_last_change 回执写清退回了什么（R4.2）", () => {
  it("首稿后撤销：回执点名第 5 章工作稿 + 找回办法，不说「只撤了这一步」", async () => {
    const projectDir = await makeProject();
    await runWithSnapshot(projectDir, "agent:foundation_write:改名 主角→陆沉", async () => {
      await writeFile(join(projectDir, "characters", "char-protag", "core.json"), JSON.stringify({ id: "char-protag", name: "陆沉" }), "utf-8");
    });
    await createSnapshot(projectDir, "出稿：第5章");
    await mkdir(join(projectDir, "drafts", "fast"), { recursive: true });
    await writeFile(join(projectDir, "drafts", "fast", "chapter-0005.md"), "# 第 5 章\n\n阿禾拆了信。", "utf-8");

    const out = await undo(projectDir);
    expect(out.ok).toBe(true);
    expect(out.undone).toBe(true);
    expect(out.summary).toContain("已撤销上一步（出稿：第5章）");
    expect(out.summary).toContain("第 5 章工作稿");
    expect(out.summary).toContain("要找回，去「历史」页点「恢复前的自动存档」");
    expect(out.summary).not.toContain("只撤了这一步");
    expect(out.summary).not.toContain("也一并退回"); // 只撤这一步，没有连带
    await expect(access(join(projectDir, "drafts", "fast", "chapter-0005.md"))).rejects.toThrow();
    expect(JSON.parse(await readFile(join(projectDir, "characters", "char-protag", "core.json"), "utf-8")).name).toBe("陆沉");
  }, 30_000);

  it("再撤一次撤的是改名，回执换成角色卡（认不出 id 用中性说法，不吐 char-）", async () => {
    const projectDir = await makeProject();
    await runWithSnapshot(projectDir, "agent:foundation_write:改名 主角→陆沉", async () => {
      await writeFile(join(projectDir, "characters", "char-protag", "core.json"), JSON.stringify({ id: "char-protag", name: "陆沉" }), "utf-8");
    });
    await createSnapshot(projectDir, "出稿：第5章");
    await mkdir(join(projectDir, "drafts", "fast"), { recursive: true });
    await writeFile(join(projectDir, "drafts", "fast", "chapter-0005.md"), "# 第 5 章\n\n阿禾拆了信。", "utf-8");
    await undo(projectDir); // 撤首稿

    const second = await undo(projectDir); // 撤改名
    expect(second.undone).toBe(true);
    expect(second.summary).toContain("更新故事资料：改名 主角→陆沉");
    expect(second.summary).toContain("角色卡资料"); // 该临时项目没有角色名册可解析 → 中性说法
    expect(second.summary).not.toMatch(/char-protag/u); // 铁律④：绝不吐裸 id
    expect(JSON.parse(await readFile(join(projectDir, "characters", "char-protag", "core.json"), "utf-8")).name).toBe("主角");
  }, 30_000);

  it("没有可撤销的改动 → undone:false 如实说", async () => {
    const projectDir = await makeProject();
    await createSnapshot(projectDir, "agent:foundation_write");
    const out = await undo(projectDir);
    expect(out.ok).toBe(true);
    expect(out.undone).toBe(false);
    expect(out.summary).toContain("没有可撤销的改动");
  }, 30_000);
});
