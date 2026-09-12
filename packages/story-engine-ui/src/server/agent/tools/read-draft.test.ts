// @vitest-environment node
//
// read_draft 只读工具单测：直读某章工作稿/已入库正文全文（补「agent 没有读草稿全文工具」的洞）。
// 纯逻辑 readDraftContent 直测；execute 层验证章号缺省回退（用 context.currentChapter）。
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createStoryProject } from "@actalk/story-engine";
import type { ToolExecutionContext } from "@mastra/core/tools";
import { describe, expect, it } from "vitest";

import { defaultCommittedChapterPath, defaultDraftPath } from "../../lib/project-io.js";
import { buildProjectRequestContext } from "../request-context.js";
import { readDraftContent, readDraftTool } from "./read-draft.js";

async function makeProject(title: string): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "read-draft-test-"));
  const { projectDir } = await createStoryProject({
    rootDir,
    title,
    genre: "都市",
    premise: "主角进入权力中心。",
    mainCharacterName: "林远",
  });
  return projectDir;
}

async function writeAt(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf-8");
}

const DRAFT = "# 第1章 那顿不正常的晚饭\n\n林远推开家门，饭桌上父母的神色不太对。";
const COMMITTED = "# 第1章 入库版\n\n这是已入库的正文版本。";

describe("read_draft 只读草稿/正文工具", () => {
  it("有工作稿 → 直接返回草稿全文，source=draft，解析出标题与字数", async () => {
    const projectDir = await makeProject("读草稿");
    await writeAt(defaultDraftPath(projectDir, 1), DRAFT);

    const out = await readDraftContent({ projectDir, chapter: 1 });
    expect(out.found).toBe(true);
    expect(out.source).toBe("draft");
    expect(out.content).toBe(DRAFT);
    expect(out.title).toBe("那顿不正常的晚饭");
    expect(out.charCount).toBeGreaterThan(0);
    expect("snapshotId" in out).toBe(false);
  });

  it("无工作稿但有已入库正文 → auto 回退读已入库，source=committed", async () => {
    const projectDir = await makeProject("回退已入库");
    await writeAt(defaultCommittedChapterPath(projectDir, 1), COMMITTED);

    const out = await readDraftContent({ projectDir, chapter: 1 });
    expect(out.found).toBe(true);
    expect(out.source).toBe("committed");
    expect(out.content).toBe(COMMITTED);
  });

  it("工作稿与已入库都在 → auto 优先读工作稿", async () => {
    const projectDir = await makeProject("优先草稿");
    await writeAt(defaultDraftPath(projectDir, 1), DRAFT);
    await writeAt(defaultCommittedChapterPath(projectDir, 1), COMMITTED);

    const out = await readDraftContent({ projectDir, chapter: 1 });
    expect(out.source).toBe("draft");
    expect(out.content).toBe(DRAFT);
  });

  it("已定稿章节也有工作稿时 → summary 说明当前读的是工作稿，不说未定稿工作稿", async () => {
    const projectDir = await makeProject("定稿后工作稿");
    await writeAt(defaultDraftPath(projectDir, 1), DRAFT);
    await writeAt(defaultCommittedChapterPath(projectDir, 1), COMMITTED);

    const out = await readDraftContent({ projectDir, chapter: 1, source: "draft" });
    expect(out.source).toBe("draft");
    expect(out.summary).toContain("该章已有定稿正文，当前读的是工作稿");
    expect(out.summary).not.toContain("未定稿）");
  });

  it("source=draft 但只有已入库 → 不回退，found=false 诚实回报", async () => {
    const projectDir = await makeProject("只读草稿不回退");
    await writeAt(defaultCommittedChapterPath(projectDir, 1), COMMITTED);

    const out = await readDraftContent({ projectDir, chapter: 1, source: "draft" });
    expect(out.found).toBe(false);
    expect(out.source).toBeNull();
    expect(out.content).toBe("");
  });

  it("草稿与已入库都没有 → found=false，source=null，不抛", async () => {
    const projectDir = await makeProject("空");
    const out = await readDraftContent({ projectDir, chapter: 1 });
    expect(out.found).toBe(false);
    expect(out.source).toBeNull();
    expect(out.charCount).toBe(0);
  });
});

// --- execute 章号缺省回退（与其它只读工具一致：LLM 没给章号时用 context.currentChapter）---

type ToolExec = (input: Record<string, unknown>, context: ToolExecutionContext) => Promise<unknown>;
const execute = readDraftTool.execute as unknown as ToolExec;

function ctx(projectDir: string, currentChapter?: number): ToolExecutionContext {
  return { requestContext: buildProjectRequestContext(projectDir, currentChapter) } as unknown as ToolExecutionContext;
}

describe("read_draft execute 章号缺省回退", () => {
  it("不传 chapter 但注入 currentChapter:2 → 读第 2 章", async () => {
    const projectDir = await makeProject("回退章2");
    await writeAt(defaultDraftPath(projectDir, 2), DRAFT);

    const out = await execute({}, ctx(projectDir, 2)) as { chapter: number; found: boolean };
    expect(out.chapter).toBe(2);
    expect(out.found).toBe(true);
  });

  it("不传 chapter 且 context 无 currentChapter → throw 含「缺少章号」", async () => {
    const projectDir = await makeProject("缺章号");
    await expect(execute({}, ctx(projectDir))).rejects.toThrow(/缺少章号/);
  });
});
