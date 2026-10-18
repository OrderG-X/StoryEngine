import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { normalizeChapterPlan } from "../chapter-plan.js";
import type { WriterContextEnvelope } from "../context-gateway.js";
import { findReplayedParagraphs, runFastDraft, stripTrailingSegmentMarkers, type WriterClient } from "../fast-draft-writer.js";
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

  it("前半章末尾写手自加「（本章未完）」→ 接缝处去掉，后半章也看不到（重构 P6 真机：夹在正文中间）", async () => {
    const projectDir = await makeBook();
    const contexts: WriterContextEnvelope[] = [];
    const writer: WriterClient = {
      generateDraft: vi.fn(async ({ context }) => {
        contexts.push(context);
        return contexts.length === 1
          ? { title: "档案室", content: `# 第2章 · 档案室\n\n林澈${han(900, "前")}。\n\n（本章未完）\n` }
          : { title: "", content: `${han(900, "后")}。\n\n（全文完）` };
      }),
    };
    const report = await runFastDraft({ projectDir, chapter: 2, chapterGoal: "继续第 2 章。", writerClient: writer, chapterPlan: PLAN, segmentByPlan: true, requestedDraftLength: 3000, persist: true });
    expect(renderFastDraftPromptText(contexts[1])).not.toContain("本章未完");
    const written = await readFile(report.draftPath!, "utf-8");
    expect(written).toContain(`林澈${han(900, "前")}。\n\n${han(900, "后")}。`);
    expect(written).not.toContain("未完");
    expect(written).not.toContain("全文完");
  });

  it("stripTrailingSegmentMarkers：只去末尾整段的短标记；人物心声、正文中间的括号段不动", () => {
    expect(stripTrailingSegmentMarkers("他走了。\n\n（未完待续）\n\n")).toBe("他走了。");
    expect(stripTrailingSegmentMarkers("他走了。\n(待续)")).toBe("他走了。");
    expect(stripTrailingSegmentMarkers("他走了。\n\n（完了。）")).toBe("他走了。\n\n（完了。）");
    expect(stripTrailingSegmentMarkers("（本章未完）\n\n他走了。")).toBe("（本章未完）\n\n他走了。");
    expect(stripTrailingSegmentMarkers("他走了。\n\n（三年后）")).toBe("他走了。\n\n（三年后）");
    expect(stripTrailingSegmentMarkers("他走了。\n\n（这件事他到死也没想完全明白）")).toBe("他走了。\n\n（这件事他到死也没想完全明白）");
  });

  it("每一半只写自己的要点：前半章的后半要点标成「这次不写」；后半章拿到已写要点清单（第十四轮越界、第十五轮前半章不知后事自己收场）", async () => {
    const projectDir = await makeBook();
    const contexts: WriterContextEnvelope[] = [];
    const writer: WriterClient = {
      generateDraft: vi.fn(async ({ context }) => {
        contexts.push(context);
        return { title: "档案室", content: `${han(900, contexts.length === 1 ? "前" : "后")}。` };
      }),
    };
    await runFastDraft({ projectDir, chapter: 2, chapterGoal: PLAN.summary, writerClient: writer, chapterPlan: PLAN, segmentByPlan: true, requestedDraftLength: 3000, persist: true });
    const firstPrompt = renderFastDraftPromptText(contexts[0]);
    expect(firstPrompt).not.toContain("每个要点都要真正写到");
    const firstPlan = contexts[0].sections.find((section) => section.name === "chapter_plan")?.content as Record<string, unknown>;
    expect(firstPlan.beats).toEqual(["一早出门", "管理员拦人", "翻到底册"]);
    expect(firstPlan.laterBeats).toEqual(["对出缺页是境外汇款", "回家路上被跟踪"]);
    expect(String(firstPlan.instruction)).toContain("这次一个字都不写");
    expect(String(firstPlan.instruction)).toContain("人物不离场");
    const secondPlan = contexts[1].sections.find((section) => section.name === "chapter_plan")?.content as Record<string, unknown>;
    expect(secondPlan.alreadyDone).toEqual(["一早出门", "管理员拦人", "翻到底册"]);
    expect(secondPlan.beats).toEqual(["对出缺页是境外汇款", "回家路上被跟踪"]);
  });

  it("两半都告诉模型：要点里没写换天就都在同一天（换没换天交给模型读，不用词表猜）", async () => {
    const projectDir = await makeBook();
    const contexts: WriterContextEnvelope[] = [];
    const writer: WriterClient = {
      generateDraft: vi.fn(async ({ context }) => {
        contexts.push(context);
        return { title: "t", content: `${han(900, "文")}。` };
      }),
    };
    await runFastDraft({ projectDir, chapter: 2, chapterGoal: "继续第 2 章。", writerClient: writer, chapterPlan: PLAN, segmentByPlan: true, requestedDraftLength: 3000, persist: true });
    expect(renderFastDraftPromptText(contexts[0])).toContain("章纲要点里没写换天，就都在同一天里");
    expect(renderFastDraftPromptText(contexts[1])).toContain("章纲要点里没写换天，就都在同一天里");
  });

  it("两半拼起来超了上限 → 不从结尾裁（第十七轮第 4 章被裁掉最后两个要点），如实记一条", async () => {
    const projectDir = await makeBook();
    let calls = 0;
    const writer: WriterClient = {
      generateDraft: vi.fn(async () => {
        calls += 1;
        return { title: "档案室", content: calls === 1 ? `林澈${han(2000, "前")}。` : `${han(1990, "后")}。结尾一句。` };
      }),
    };
    const report = await runFastDraft({ projectDir, chapter: 2, chapterGoal: "继续第 2 章。", writerClient: writer, chapterPlan: PLAN, segmentByPlan: true, requestedDraftLength: 3000, persist: true });
    expect(await readFile(report.draftPath!, "utf-8")).toContain("结尾一句。");
    expect(report.issues.join("\n")).toContain("不从结尾裁");
  });

  it("前半章照抄上一章 → 带提示重写前半章一次（第二十一轮第 3 章前半把第 2 章整章重写了一遍）", async () => {
    const projectDir = await makeBook();
    const p1 = "林澈推开档案室的门，管理员抬头看了他一眼，说今天不对外开放，让他明天再来，他把介绍信递过去，对方翻了翻又还给他。";
    const p2 = "他在走廊的长椅上坐了一个钟头，窗外的梧桐叶子一片片往下掉，楼下有人在吵架，声音隔着两层楼还听得清清楚楚。";
    await writeFile(join(projectDir, "chapters", "0001.md"), `# 第1章 · 账册\n\n${p1}\n\n${p2}\n\n林澈把账册锁进抽屉。\n`, "utf-8");
    const contexts: WriterContextEnvelope[] = [];
    const writer: WriterClient = {
      generateDraft: vi.fn(async ({ context }) => {
        contexts.push(context);
        if (contexts.length === 1) return { title: "档案室", content: `${p1}\n\n${p2}\n\n林澈${han(600, "前")}。` };
        if (contexts.length === 2) return { title: "档案室", content: `林澈一早出门，${han(900, "新")}。` };
        return { title: "", content: `${han(900, "后")}。` };
      }),
    };
    const report = await runFastDraft({ projectDir, chapter: 2, chapterGoal: "继续第 2 章。", writerClient: writer, chapterPlan: PLAN, segmentByPlan: true, requestedDraftLength: 3000, persist: true });
    expect(writer.generateDraft).toHaveBeenCalledTimes(3);
    expect(renderFastDraftPromptText(contexts[1])).toContain("把上一章的原文又写了一遍");
    const written = await readFile(report.draftPath!, "utf-8");
    expect(written).not.toContain(p2);
    expect(written).toContain("林澈一早出门");
    expect(report.issues.join("\n")).toContain("前半章首稿照抄了上一章 2 段，已重写前半章");
  });

  it("两半的提示词前面那一大段完全相同（各自不同的本章目标、章纲排在最后），后半章能吃到服务商缓存", async () => {
    const projectDir = await makeBook();
    const prompts: string[] = [];
    const writer: WriterClient = {
      generateDraft: vi.fn(async ({ context }) => {
        prompts.push(renderFastDraftPromptText(context));
        return { title: "档案室", content: `林澈${han(900, prompts.length === 1 ? "前" : "后")}。` };
      }),
    };
    await runFastDraft({ projectDir, chapter: 2, chapterGoal: "继续第 2 章。", writerClient: writer, chapterPlan: PLAN, segmentByPlan: true, requestedDraftLength: 3000, persist: true });
    const [first, second] = prompts;
    let shared = 0;
    while (shared < first.length && first[shared] === second[shared]) shared += 1;
    const firstGoalAt = first.indexOf("## chapter_plan");
    expect(firstGoalAt).toBeGreaterThan(0);
    expect(shared).toBeGreaterThanOrEqual(firstGoalAt);
    expect(first.indexOf("## previous_chapter")).toBeLessThan(firstGoalAt);
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

  it("后半章重演了前半章的一场戏 → 带提示重写后半章一次，取重演更少的那版", async () => {
    const projectDir = await makeBook();
    const scene = "林澈推开档案室的门，管理员抬头看了他一眼，说今天不对外开放，让他明天再来，他把介绍信递过去，对方翻了翻又还给他。";
    const contexts: WriterContextEnvelope[] = [];
    const writer: WriterClient = {
      generateDraft: vi.fn(async ({ context }) => {
        contexts.push(context);
        if (contexts.length === 1) return { title: "档案室", content: `# 第2章 · 档案室\n\n林澈${han(600, "前")}。\n\n${scene}` };
        if (contexts.length === 2) return { title: "", content: `${scene}\n\n${han(600, "后")}。` };
        return { title: "", content: `他在走廊尽头等到天黑，管理员终于松了口。\n\n${han(600, "新")}。` };
      }),
    };
    const report = await runFastDraft({ projectDir, chapter: 2, chapterGoal: "继续第 2 章。", writerClient: writer, chapterPlan: PLAN, segmentByPlan: true, requestedDraftLength: 3000, persist: true });
    expect(writer.generateDraft).toHaveBeenCalledTimes(3);
    expect(renderFastDraftPromptText(contexts[2])).toContain("把前半章（或上一章）已经写过的场面又写了一遍");
    const written = await readFile(report.draftPath!, "utf-8");
    expect(written.split(scene).length - 1).toBe(1);
    expect(written).toContain("管理员终于松了口");
    expect(report.issues.join("\n")).toContain("后半章首稿重演了前半章 1 段，已重写后半章");
  });

  it("findReplayedParagraphs：换几个字重演也认得；不相干的段不算", () => {
    const first = "林澈推开档案室的门，管理员抬头看了他一眼，说今天不对外开放，让他明天再来。";
    expect(findReplayedParagraphs(first, "林澈又推开档案室的门，管理员抬头瞥了他一眼，说今天不对外开放，叫他明天再来。")).toHaveLength(1);
    expect(findReplayedParagraphs(first, "傍晚下起了雨，他沿着河堤往回走，街灯一盏一盏亮起来，卖馄饨的摊子刚刚支起。")).toHaveLength(0);
  });
});
