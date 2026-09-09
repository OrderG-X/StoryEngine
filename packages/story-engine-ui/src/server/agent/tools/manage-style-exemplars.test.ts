// @vitest-environment node
//
// manage_style_exemplars 单测：
// - 纯逻辑（manageStyleExemplarsLogic）：CRUD、限额（5 条 / 2000 字）拒绝、坏输入、坏文件、
//   坏条目跳过+报告、summary 用标题不泄露裸 id、写回保留其它写作规则字段。
// - 包装层（writeTool）：add 建快照、list 只读不建快照、失败不暴露 no-op 快照、action 大小写归一。
// 使用临时目录，不碰真书。
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolExecutionContext } from "@mastra/core/tools";
import { describe, expect, it } from "vitest";

import { buildProjectRequestContext } from "../request-context.js";
import { manageStyleExemplarsLogic, manageStyleExemplarsTool } from "./manage-style-exemplars.js";

const WRITING_RULES_PATH = join("story", "writing-rules.json");

async function tempProject(options: { readonly withWritingRules?: boolean } = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "style-exemplars-test-"));
  await mkdir(join(dir, "story"), { recursive: true });
  if (options.withWritingRules !== false) {
    await writeFile(
      join(dir, WRITING_RULES_PATH),
      JSON.stringify({ version: "v0", proseStyle: ["克制"], customNotes: "别动我这条", doNotDo: ["不要开挂"] }),
      "utf-8",
    );
  }
  return dir;
}

async function readWritingRules(projectDir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(projectDir, WRITING_RULES_PATH), "utf-8")) as Record<string, unknown>;
}

async function seedExemplars(projectDir: string, count: number): Promise<void> {
  const record = await readWritingRules(projectDir);
  record.styleExemplars = Array.from({ length: count }, (_, i) => ({
    id: `ex-seed-${i + 1}`,
    title: `种子样本${i + 1}`,
    text: `这是第 ${i + 1} 条种子样本的正文。`,
    createdAtMs: 1000 + i,
  }));
  await writeFile(join(projectDir, WRITING_RULES_PATH), JSON.stringify(record), "utf-8");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const execute = (input: Record<string, unknown>, projectDir: string) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (manageStyleExemplarsTool as any).execute(input, {
    requestContext: buildProjectRequestContext(projectDir),
  } as unknown as ToolExecutionContext);

describe("manage_style_exemplars · add", () => {
  it("add 落盘可读回，保留 proseStyle/customNotes 等其它字段；summary 用标题不带裸 id", async () => {
    const projectDir = await tempProject();

    const result = await manageStyleExemplarsLogic({
      projectDir,
      toolInput: { action: "add", title: "雨夜开场", text: "雨先是落在檐角，再落到他的肩上。", note: "满意的开头节奏" },
    });

    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);
    expect(result.summary).toContain("雨夜开场");
    expect(result.summary).not.toContain("exemplar-");

    const record = await readWritingRules(projectDir);
    expect(record.proseStyle).toEqual(["克制"]);
    expect(record.customNotes).toBe("别动我这条");
    expect(record.doNotDo).toEqual(["不要开挂"]);
    const exemplars = record.styleExemplars as { id: string; title: string; text: string; note?: string; createdAtMs: number }[];
    expect(exemplars).toHaveLength(1);
    expect(exemplars[0]).toMatchObject({ title: "雨夜开场", text: "雨先是落在檐角，再落到他的肩上。", note: "满意的开头节奏" });
    expect(exemplars[0]?.id).toMatch(/^exemplar-[0-9a-f]{6}$/u);
    expect(typeof exemplars[0]?.createdAtMs).toBe("number");
  });

  it("writing-rules.json 不存在时 add 会建最小文件（version v0）", async () => {
    const projectDir = await tempProject({ withWritingRules: false });

    const result = await manageStyleExemplarsLogic({
      projectDir,
      toolInput: { action: "add", title: "第一条", text: "一些正文。" },
    });

    expect(result.ok).toBe(true);
    const record = await readWritingRules(projectDir);
    expect(record.version).toBe("v0");
    expect(record.styleExemplars).toHaveLength(1);
  });

  it("空标题 / 空正文 → ok:false 且不落盘", async () => {
    const projectDir = await tempProject();

    const noTitle = await manageStyleExemplarsLogic({ projectDir, toolInput: { action: "add", text: "正文" } });
    expect(noTitle.ok).toBe(false);
    expect(noTitle.summary).toContain("标题");

    const noText = await manageStyleExemplarsLogic({ projectDir, toolInput: { action: "add", title: "有标题" } });
    expect(noText.ok).toBe(false);
    expect(noText.summary).toContain("正文");

    const record = await readWritingRules(projectDir);
    expect(record.styleExemplars).toBeUndefined(); // 没写入任何东西
  });

  it("正文超 2000 字 → 如实拒绝不截断、不落盘", async () => {
    const projectDir = await tempProject();

    const result = await manageStyleExemplarsLogic({
      projectDir,
      toolInput: { action: "add", title: "超长样本", text: "长".repeat(2001) },
    });

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("2000");
    expect(result.summary).toContain("没有写入");
    const record = await readWritingRules(projectDir);
    expect(record.styleExemplars).toBeUndefined();
  });

  it("同名标题 → ok:false 提示用 update", async () => {
    const projectDir = await tempProject();
    await manageStyleExemplarsLogic({ projectDir, toolInput: { action: "add", title: "雨夜开场", text: "正文一。" } });

    const dup = await manageStyleExemplarsLogic({ projectDir, toolInput: { action: "add", title: "雨夜开场", text: "正文二。" } });

    expect(dup.ok).toBe(false);
    expect(dup.summary).toContain("雨夜开场");
    expect(dup.summary).toContain("update");
    const record = await readWritingRules(projectDir);
    expect(record.styleExemplars).toHaveLength(1); // 仍只有第一条
  });

  it("已有 5 条时再 add 第 6 条 → 如实拒绝", async () => {
    const projectDir = await tempProject();
    await seedExemplars(projectDir, 5);

    const result = await manageStyleExemplarsLogic({
      projectDir,
      toolInput: { action: "add", title: "第六条", text: "装不下的正文。" },
    });

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("5");
    expect(result.summary).toContain("种子样本1"); // 告诉用户现有有哪些，方便决定删哪条
    const record = await readWritingRules(projectDir);
    expect(record.styleExemplars).toHaveLength(5);
  });
});

describe("manage_style_exemplars · list", () => {
  it("list 返回全量样本与总数；坏条目跳过并在 droppedBad 如实报告", async () => {
    const projectDir = await tempProject();
    const record = await readWritingRules(projectDir);
    record.styleExemplars = [
      "这不是对象",
      { id: "bad-1", title: "没正文" },
      { id: "good-1", title: "好样本", text: "灯火一盏一盏灭下去。", createdAtMs: 7 },
    ];
    await writeFile(join(projectDir, WRITING_RULES_PATH), JSON.stringify(record), "utf-8");

    const result = await manageStyleExemplarsLogic({ projectDir, toolInput: { action: "list" } });

    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);
    expect(result.exemplars.map((item) => item.title)).toEqual(["好样本"]);
    expect(result.droppedBad).toHaveLength(2);
    expect(result.summary).toContain("好样本");
    expect(result.summary).toContain("跳过");
  });

  it("没有 writing-rules.json → list ok、count 0", async () => {
    const projectDir = await tempProject({ withWritingRules: false });

    const result = await manageStyleExemplarsLogic({ projectDir, toolInput: { action: "list" } });

    expect(result.ok).toBe(true);
    expect(result.count).toBe(0);
    expect(result.summary).toContain("还没有文风样本");
  });
});

describe("manage_style_exemplars · update", () => {
  it("按标题定位改正文；按 id 定位可同时改标题", async () => {
    const projectDir = await tempProject();
    await manageStyleExemplarsLogic({ projectDir, toolInput: { action: "add", title: "旧标题", text: "旧正文。" } });
    const listed = await manageStyleExemplarsLogic({ projectDir, toolInput: { action: "list" } });
    const id = listed.exemplars[0]?.id ?? "";

    const byTitle = await manageStyleExemplarsLogic({
      projectDir,
      toolInput: { action: "update", title: "旧标题", text: "新正文，更有节奏。" },
    });
    expect(byTitle.ok).toBe(true);
    expect(byTitle.exemplars[0]?.text).toBe("新正文，更有节奏。");

    const byId = await manageStyleExemplarsLogic({
      projectDir,
      toolInput: { action: "update", id, title: "新标题", note: "补个备注" },
    });
    expect(byId.ok).toBe(true);
    expect(byId.exemplars[0]).toMatchObject({ id, title: "新标题", note: "补个备注" });
    expect(byId.summary).toContain("新标题");
  });

  it("目标不存在 / 只给定位不给内容 / 新正文超长 → ok:false 且原文保留", async () => {
    const projectDir = await tempProject();
    await manageStyleExemplarsLogic({ projectDir, toolInput: { action: "add", title: "样本甲", text: "甲的正文。" } });

    const notFound = await manageStyleExemplarsLogic({ projectDir, toolInput: { action: "update", title: "不存在", text: "x。" } });
    expect(notFound.ok).toBe(false);
    expect(notFound.summary).toContain("没找到");

    const nothing = await manageStyleExemplarsLogic({ projectDir, toolInput: { action: "update", title: "样本甲" } });
    expect(nothing.ok).toBe(false);
    expect(nothing.summary).toContain("没有要改的内容");

    const tooLong = await manageStyleExemplarsLogic({ projectDir, toolInput: { action: "update", title: "样本甲", text: "长".repeat(2001) } });
    expect(tooLong.ok).toBe(false);
    expect(tooLong.summary).toContain("2000");

    const record = await readWritingRules(projectDir);
    const exemplars = record.styleExemplars as { text: string }[];
    expect(exemplars[0]?.text).toBe("甲的正文。"); // 三次失败都没动原文
  });
});

describe("manage_style_exemplars · remove", () => {
  it("按标题删除成功；不存在的目标 ok:false", async () => {
    const projectDir = await tempProject();
    await manageStyleExemplarsLogic({ projectDir, toolInput: { action: "add", title: "要删的", text: "删我。" } });

    const removed = await manageStyleExemplarsLogic({ projectDir, toolInput: { action: "remove", title: "要删的" } });
    expect(removed.ok).toBe(true);
    expect(removed.count).toBe(0);
    expect(removed.summary).toContain("要删的");
    const record = await readWritingRules(projectDir);
    expect(record.styleExemplars).toEqual([]);

    const notFound = await manageStyleExemplarsLogic({ projectDir, toolInput: { action: "remove", title: "要删的" } });
    expect(notFound.ok).toBe(false);
    expect(notFound.summary).toContain("没找到");
  });

  it("按 id 定位失败时 summary 不泄露裸 id", async () => {
    const projectDir = await tempProject();

    const result = await manageStyleExemplarsLogic({ projectDir, toolInput: { action: "remove", id: "exemplar-deadbeef" } });

    expect(result.ok).toBe(false);
    expect(result.summary).not.toContain("exemplar-deadbeef");
    expect(result.summary).toContain("没找到");
  });
});

describe("manage_style_exemplars · 坏文件", () => {
  it("writing-rules.json 损坏（非法 JSON）→ ok:false 且不覆盖", async () => {
    const projectDir = await tempProject();
    await writeFile(join(projectDir, WRITING_RULES_PATH), "{ 这不是合法 JSON", "utf-8");

    const result = await manageStyleExemplarsLogic({
      projectDir,
      toolInput: { action: "add", title: "新样本", text: "正文。" },
    });

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("损坏");
    expect(await readFile(join(projectDir, WRITING_RULES_PATH), "utf-8")).toBe("{ 这不是合法 JSON"); // 原样没动
  });
});

describe("manage_style_exemplars · writeTool 包装层（快照 + 坏输入归一）", () => {
  it("add 经包装层：建快照、snapshotId 透出、落盘成功", async () => {
    const projectDir = await tempProject();

    const result = await execute({ action: "add", title: "快照样本", text: "正文。" }, projectDir);

    expect(result.ok).toBe(true);
    expect(result.snapshotId).toBeTruthy();
    await access(join(projectDir, ".git")); // 快照仓库真的建了
    const record = await readWritingRules(projectDir);
    expect(record.styleExemplars).toHaveLength(1);
  });

  it("list 只读：不建快照（snapshotId 空、不初始化 .git）", async () => {
    const projectDir = await tempProject();

    const result = await execute({ action: "list" }, projectDir);

    expect(result.ok).toBe(true);
    expect(result.snapshotId).toBe("");
    await expect(access(join(projectDir, ".git"))).rejects.toThrow();
  });

  it("失败的 add（超 5 条）：ok:false 且 snapshotId 为空（no-op 快照不透出）", async () => {
    const projectDir = await tempProject();
    await seedExemplars(projectDir, 5);

    const result = await execute({ action: "add", title: "第六条", text: "正文。" }, projectDir);

    expect(result.ok).toBe(false);
    expect(result.snapshotId).toBe("");
  });

  it("action 大小写/空白归一：『 Add 』按 add 执行", async () => {
    const projectDir = await tempProject();

    const result = await execute({ action: " Add ", title: "大小写样本", text: "正文。" }, projectDir);

    expect(result.ok).toBe(true);
    expect(result.action).toBe("add");
  });
});
