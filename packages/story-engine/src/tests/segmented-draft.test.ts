import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { normalizeChapterPlan } from "../chapter-plan.js";
import type { WriterContextEnvelope } from "../context-gateway.js";
import { runFastDraft, type WriterClient } from "../fast-draft-writer.js";
import { renderFastDraftPromptText } from "../prompt-cache-diagnostics.js";
import { createStoryProject } from "../project-store.js";

// 2026-10-08 十章验收第五轮：「先写短、再接着续」的续写越过章纲最后一步自己编新的一天（58 处矛盾里 27 处）。
const PLAN = normalizeChapterPlan({
  summary: "林澈去档案室对出缺页",
  beats: ["一早出门", "管理员拦人", "翻到底册", "对出缺页是境外汇款", "回家路上被跟踪"],
}, { chapter: 2 })!;

async function makeBook(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "story-engine-segmented-"));
  const { projectDir } = await createStoryProject({ rootDir, title: "海州账册", genre: "urban", premise: "审计员林澈追查账册篡改。", mainCharacterName: "林澈" });
  await mkdir(join(projectDir, "chapters"), { recursive: true });
  await writeFile(join(projectDir, "chapters", "0001.md"), "# 第1章 · 账册\n\n林澈把账册锁进抽屉。\n", "utf-8");
  return projectDir;
}

const han = (n: number, ch: string) => ch.repeat(n);

describe("按章纲分前后两半写", () => {
  it("前半章只写前一半要点；后半章带上前半章原文接着写剩下的要点；拼成一章", async () => {
    const projectDir = await makeBook();
    const contexts: WriterContextEnvelope[] = [];
    const writer: WriterClient = {
      generateDraft: vi.fn(async ({ context }) => {
        contexts.push(context);
        return contexts.length === 1
          ? { title: "档案室", content: `# 第2章 · 档案室\n\n林澈${han(900, "前")}。` }
          : { title: "", content: `${han(900, "后")}。` };
      }),
    };
    const report = await runFastDraft({ projectDir, chapter: 2, chapterGoal: "继续第 2 章。", writerClient: writer, chapterPlan: PLAN, segmentByPlan: true, requestedDraftLength: 3000, persist: true });
    expect(writer.generateDraft).toHaveBeenCalledTimes(2);
    const firstPrompt = renderFastDraftPromptText(contexts[0]);
    expect(firstPrompt).toContain("这次是前半章】只写章纲要点 1–3");
    const secondPrompt = renderFastDraftPromptText(contexts[1]);
    expect(secondPrompt).toContain("只写章纲要点 4–5");
    expect(secondPrompt).toContain("## already_written");
    expect(secondPrompt).toContain(han(50, "前"));
    const written = await readFile(report.draftPath!, "utf-8");
    expect(written).toContain(`林澈${han(900, "前")}。\n\n${han(900, "后")}。`);
    expect(report.passed).toBe(true);
  });

  it("后半章没写成 → 只交前半章并如实记一条", async () => {
    const projectDir = await makeBook();
    const writer: WriterClient = {
      generateDraft: vi.fn()
        .mockResolvedValueOnce({ title: "档案室", content: `# 第2章 · 档案室\n\n林澈${han(900, "前")}。` })
        .mockRejectedValueOnce(new Error("socket hang up")),
    };
    const report = await runFastDraft({ projectDir, chapter: 2, chapterGoal: "继续第 2 章。", writerClient: writer, chapterPlan: PLAN, segmentByPlan: true, requestedDraftLength: 3000, persist: true });
    expect(report.issues.join("\n")).toContain("后半章没写成");
    expect(await readFile(report.draftPath!, "utf-8")).not.toContain("后");
  });

  it("没开分段 / 要点太少 → 一次写完（旧行为）", async () => {
    const projectDir = await makeBook();
    const writer: WriterClient = { generateDraft: vi.fn(async () => ({ title: "t", content: `# 第2章 · t\n\n林澈${han(900, "全")}。` })) };
    await runFastDraft({ projectDir, chapter: 2, chapterGoal: "继续第 2 章。", writerClient: writer, chapterPlan: PLAN, requestedDraftLength: 3000 });
    const short = normalizeChapterPlan({ summary: "s", beats: ["a", "b", "c"] }, { chapter: 2 })!;
    await runFastDraft({ projectDir, chapter: 2, chapterGoal: "继续第 2 章。", writerClient: writer, chapterPlan: short, segmentByPlan: true, requestedDraftLength: 3000, persist: true });
    expect(writer.generateDraft).toHaveBeenCalledTimes(2);
  });

  it("目标字数不高（写手一次写得出）→ 不分两半（第十二轮：目标 1800 也拆成两个 900，平白多出接缝）", async () => {
    const projectDir = await makeBook();
    const writer: WriterClient = { generateDraft: vi.fn(async () => ({ title: "t", content: `# 第2章 · t\n\n林澈${han(1700, "全")}。` })) };
    await runFastDraft({ projectDir, chapter: 2, chapterGoal: "继续第 2 章。", writerClient: writer, chapterPlan: PLAN, segmentByPlan: true, requestedDraftLength: 1800 });
    expect(writer.generateDraft).toHaveBeenCalledTimes(1);
  });
});
