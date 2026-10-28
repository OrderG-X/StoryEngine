// @vitest-environment node
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { cardWrite, runCommand, type CardOp } from "@actalk/story-core";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { normalizeChapterPlan } from "../book/chapter-plan.js";
import type { WriterContextEnvelope } from "./context-gateway.js";
import { dropEchoedLead, findReplayedParagraphs, runFastDraft, stripTrailingSegmentMarkers, type WriterClient } from "./fast-draft-writer.js";
import { renderFastDraftPromptText } from "./prompt-cache-diagnostics.js";
import { createStoryProject } from "../book/project-store.js";

/** 引擎不写盘了（重构 P7）：拼出调用方会落进工作稿的文件文本，沿用原来按文件比对的断言。 */
function draftFileOf(report: { readonly title?: string; readonly draftBody?: string }): string {
  return `# ${report.title}\n\n${report.draftBody ?? ""}\n`;
}

// 2026-10-08 十章验收第五轮：「先写短、再接着续」的续写越过章纲最后一步自己编新的一天（58 处矛盾里 27 处）。
const PLAN = normalizeChapterPlan({
  summary: "林澈去档案室对出缺页",
  beats: ["一早出门", "管理员拦人", "翻到底册", "对出缺页是境外汇款", "回家路上被跟踪"],
}, { chapter: 2 })!;

async function makeBook(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "story-engine-segmented-"));
  const { projectDir } = await createStoryProject({ rootDir, title: "海州账册", genre: "urban", logline: "审计员林澈追查账册篡改。", protagonistName: "林澈" });
  await mkdir(join(projectDir, "chapters"), { recursive: true });
  await writeFile(join(projectDir, "chapters", "0001.md"), "# 第1章 · 账册\n\n林澈把账册锁进抽屉。\n", "utf-8");
  return projectDir;
}

const han = (n: number, ch: string) => ch.repeat(n);

async function writeRules(projectDir: string, ops: CardOp[]): Promise<void> {
  const outcome = await runCommand(projectDir, cardWrite, { ops }, { caller: "author", idempotencyKey: `t-${Math.random()}` });
  if (!outcome.ok) throw new Error(outcome.message);
}

describe("按章纲分前后两半写", () => {
  it("前半章只写前一半要点；后半章带上前半章原文接着写剩下的要点；拼成一章", async () => {
    const projectDir = await makeBook();
    const contexts: WriterContextEnvelope[] = [];
    const writer: WriterClient = {
      generateDraft: vi.fn(async ({ context }) => {
        contexts.push(context);
        return contexts.length === 1
          ? { title: "档案室", content: `# 第2章 · 档案室\n\n林澈${han(1300, "前")}。` }
          : { title: "", content: `${han(1300, "后")}。` };
      }),
    };
    const report = await runFastDraft({ projectDir, chapter: 2, chapterGoal: "继续第 2 章。", writerClient: writer, chapterPlan: PLAN, segmentByPlan: true, requestedDraftLength: 3000 });
    expect(writer.generateDraft).toHaveBeenCalledTimes(2);
    const firstPrompt = renderFastDraftPromptText(contexts[0]);
    expect(firstPrompt).toContain("这次是前半章】只写章纲要点 1–3");
    const secondPrompt = renderFastDraftPromptText(contexts[1]);
    expect(secondPrompt).toContain("只写章纲要点 4–5");
    expect(secondPrompt).toContain("## already_written");
    expect(secondPrompt).toContain(han(50, "前"));
    const written = draftFileOf(report);
    expect(written).toContain(`林澈${han(1300, "前")}。\n\n${han(1300, "后")}。`);
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
    const report = await runFastDraft({ projectDir, chapter: 2, chapterGoal: "继续第 2 章。", writerClient: writer, chapterPlan: PLAN, segmentByPlan: true, requestedDraftLength: 3000 });
    expect(renderFastDraftPromptText(contexts[1])).not.toContain("本章未完");
    const written = draftFileOf(report);
    expect(written).toContain(`林澈${han(900, "前")}。\n\n${han(900, "后")}。`);
    expect(written).not.toContain("未完");
    expect(written).not.toContain("全文完");
  });

  it("后半章开头原样抄了前半章最后一句 → 拼接时去掉（换题材长篇实跑第 21 章「“泡上吧。”」连着两遍）", async () => {
    const projectDir = await makeBook();
    let calls = 0;
    const writer: WriterClient = {
      generateDraft: vi.fn(async () => {
        calls += 1;
        return calls === 1
          ? { title: "档案室", content: `# 第2章 · 档案室\n\n林澈${han(1300, "前")}。\n\n“泡上吧。”` }
          : { title: "", content: `“泡上吧。”\n\n${han(1300, "后")}。` };
      }),
    };
    const report = await runFastDraft({ projectDir, chapter: 2, chapterGoal: "继续第 2 章。", writerClient: writer, chapterPlan: PLAN, segmentByPlan: true, requestedDraftLength: 3000 });
    const written = draftFileOf(report);
    expect(written).toContain(`“泡上吧。”\n\n${han(1300, "后")}。`);
    expect(written.split("“泡上吧。”").length).toBe(2);
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
    await runFastDraft({ projectDir, chapter: 2, chapterGoal: PLAN.summary, writerClient: writer, chapterPlan: PLAN, segmentByPlan: true, requestedDraftLength: 3000 });
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
    await runFastDraft({ projectDir, chapter: 2, chapterGoal: "继续第 2 章。", writerClient: writer, chapterPlan: PLAN, segmentByPlan: true, requestedDraftLength: 3000 });
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
    const report = await runFastDraft({ projectDir, chapter: 2, chapterGoal: "继续第 2 章。", writerClient: writer, chapterPlan: PLAN, segmentByPlan: true, requestedDraftLength: 3000 });
    expect(draftFileOf(report)).toContain("结尾一句。");
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
        if (contexts.length === 2) return { title: "档案室", content: `林澈一早出门，${han(1300, "新")}。` };
        return { title: "", content: `${han(1300, "后")}。` };
      }),
    };
    const report = await runFastDraft({ projectDir, chapter: 2, chapterGoal: "继续第 2 章。", writerClient: writer, chapterPlan: PLAN, segmentByPlan: true, requestedDraftLength: 3000 });
    expect(writer.generateDraft).toHaveBeenCalledTimes(3);
    expect(renderFastDraftPromptText(contexts[1])).toContain("把上一章的原文又写了一遍");
    const written = draftFileOf(report);
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
    await runFastDraft({ projectDir, chapter: 2, chapterGoal: "继续第 2 章。", writerClient: writer, chapterPlan: PLAN, segmentByPlan: true, requestedDraftLength: 3000 });
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
    const report = await runFastDraft({ projectDir, chapter: 2, chapterGoal: "继续第 2 章。", writerClient: writer, chapterPlan: PLAN, segmentByPlan: true, requestedDraftLength: 3000 });
    expect(report.issues.join("\n")).toContain("后半章没写成");
    expect(draftFileOf(report)).not.toContain("后");
  });

  it("没开分段 / 要点太少 → 一次写完（旧行为）", async () => {
    const projectDir = await makeBook();
    const writer: WriterClient = { generateDraft: vi.fn(async () => ({ title: "t", content: `# 第2章 · t\n\n林澈${han(900, "全")}。` })) };
    await runFastDraft({ projectDir, chapter: 2, chapterGoal: "继续第 2 章。", writerClient: writer, chapterPlan: PLAN, requestedDraftLength: 3000 });
    const short = normalizeChapterPlan({ summary: "s", beats: ["a", "b", "c"] }, { chapter: 2 })!;
    await runFastDraft({ projectDir, chapter: 2, chapterGoal: "继续第 2 章。", writerClient: writer, chapterPlan: short, segmentByPlan: true, requestedDraftLength: 3000 });
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
        if (contexts.length === 1) return { title: "档案室", content: `# 第2章 · 档案室\n\n林澈${han(1300, "前")}。\n\n${scene}` };
        // 换了两个字重演（原样照抄的开头另有 dropEchoedLead 去掉）。
        if (contexts.length === 2) return { title: "", content: `${scene.replace("抬头看了他一眼", "抬眼看了看他")}\n\n${han(1300, "后")}。` };
        return { title: "", content: `他在走廊尽头等到天黑，管理员终于松了口。\n\n${han(1300, "新")}。` };
      }),
    };
    const resets: string[] = [];
    const report = await runFastDraft({
      projectDir, chapter: 2, chapterGoal: "继续第 2 章。", writerClient: writer, chapterPlan: PLAN, segmentByPlan: true, requestedDraftLength: 3000,
      onStreamReset: (visible) => resets.push(visible),
    });
    expect(writer.generateDraft).toHaveBeenCalledTimes(3);
    expect(renderFastDraftPromptText(contexts[2])).toContain("把前半章（或上一章）已经写过的场面又写了一遍");
    // 稿纸上：后半章从前半章 + 空行往下流；重写前退回前半章，定了再显示用上的那版——重演的那段不会留在稿纸上。
    const firstVisible = `# 第2章 · 档案室\n林澈${han(1300, "前")}。\n\n${scene}\n\n`;
    expect(resets).toEqual([firstVisible, firstVisible, `${firstVisible}他在走廊尽头等到天黑，管理员终于松了口。\n\n${han(1300, "新")}。`]);
    const written = draftFileOf(report);
    expect(written.split(scene).length - 1).toBe(1);
    expect(written).toContain("管理员终于松了口");
    expect(report.issues.join("\n")).toContain("后半章首稿重演了前半章 1 段，已重写后半章");
  });

  it("前半章写短了，后半章补上差的字数；整章还不到下限就说清差多少再要一次后半章，用更长的那版", async () => {
    const projectDir = await makeBook();
    const contexts: WriterContextEnvelope[] = [];
    const writer: WriterClient = {
      generateDraft: vi.fn(async ({ context }) => {
        contexts.push(context);
        if (contexts.length === 1) return { title: "档案室", content: `# 第2章 · 档案室\n\n林澈${han(800, "前")}。` };
        if (contexts.length === 2) return { title: "", content: `${han(1000, "后")}。` };
        return { title: "", content: `${han(1800, "补")}。` };
      }),
    };
    const report = await runFastDraft({ projectDir, chapter: 2, chapterGoal: "继续第 2 章。", writerClient: writer, chapterPlan: PLAN, segmentByPlan: true, requestedDraftLength: 3000 });
    expect(writer.generateDraft).toHaveBeenCalledTimes(3);
    // 前半章只写到要的五成多：后半章要的（3000 − 802）按最低 0.75 放大。
    expect(renderFastDraftPromptText(contexts[1])).toMatch(/后半章写 293\d 个中文字符左右/u);
    expect(renderFastDraftPromptText(contexts[2])).toMatch(/【上一次的后半章只写了 100\d 个字，整章比最少字数还差 \d+ 字】/u);
    expect(report.draftBody).toContain(han(1800, "补"));
    expect(report.draftBody).not.toContain(han(1000, "后"));
    expect(report.issues.join("\n")).toMatch(/后半章重写了一次（100\d → 180\d 字）/u);
  });

  it("写手只写到要的八成：后半章要的字数照这个比例放大；写得比要的多就缩小（换题材长篇实跑 2026-10-27）", async () => {
    const projectDir = await makeBook();
    const prompts: string[] = [];
    const run = async (firstLength: number) => {
      const writer: WriterClient = {
        generateDraft: vi.fn(async ({ context }) => {
          prompts.push(renderFastDraftPromptText(context));
          return prompts.length % 2 === 1 ? { title: "档案室", content: `林澈${han(firstLength - 2, "前")}。` } : { title: "", content: `${han(1200, "后")}。` };
        }),
      };
      await runFastDraft({ projectDir, chapter: 2, chapterGoal: "继续第 2 章。", writerClient: writer, chapterPlan: PLAN, segmentByPlan: true, requestedDraftLength: 2000 });
    };
    await run(800);
    // 要 1000 写了 800：还差 1200，按八成放大要 1500。
    expect(prompts[1]).toContain("后半章写 1500 个中文字符左右");
    prompts.length = 0;
    await run(1200);
    // 要 1000 写了 1200：还差 800，不够一半照一半 1000，按 1.2 缩小要 833。
    expect(prompts[1]).toContain("后半章写 833 个中文字符左右");
  });

  it("再要的后半章没更长 → 用原来那版，如实记一条", async () => {
    const projectDir = await makeBook();
    let calls = 0;
    const writer: WriterClient = {
      generateDraft: vi.fn(async () => {
        calls += 1;
        return calls === 1 ? { title: "档案室", content: `林澈${han(1000, "前")}。` } : { title: "", content: `${han(calls === 2 ? 1000 : 700, "后")}。` };
      }),
    };
    const report = await runFastDraft({ projectDir, chapter: 2, chapterGoal: "继续第 2 章。", writerClient: writer, chapterPlan: PLAN, segmentByPlan: true, requestedDraftLength: 3000 });
    expect(report.draftBody).toContain(han(1000, "后"));
    expect(report.issues.join("\n")).toContain("没写得更长，用的还是原来那版");
  });

  it("findReplayedParagraphs：换几个字重演也认得；不相干的段不算", () => {
    const first = "林澈推开档案室的门，管理员抬头看了他一眼，说今天不对外开放，让他明天再来。";
    expect(findReplayedParagraphs(first, "林澈又推开档案室的门，管理员抬头瞥了他一眼，说今天不对外开放，叫他明天再来。")).toHaveLength(1);
    expect(findReplayedParagraphs(first, "傍晚下起了雨，他沿着河堤往回走，街灯一盏一盏亮起来，卖馄饨的摊子刚刚支起。")).toHaveLength(0);
  });
});

// P13：作者写了半章、AI 稿短了，从工作稿最后一句接着写；已写的字一个不动。
describe("接着往下写", () => {
  const EXISTING = "林澈推开档案室的门，管理员抬头看了他一眼，说今天不对外开放，让他明天再来，他把介绍信递过去，对方翻了翻又还给他。\n\n他说了句\"那我等\"，**就在门口坐下**。";

  it("已写的交给写手当 already_written，作者的方向进本章目标；正文 = 原样的已写 + 接着写的；有章纲也不分两半", async () => {
    const projectDir = await makeBook();
    const contexts: WriterContextEnvelope[] = [];
    const writer: WriterClient = {
      generateDraft: vi.fn(async ({ context }) => {
        contexts.push(context);
        return { title: "随便", content: `# 第2章 · 随便\n\n他在走廊尽头等到天黑，管理员终于松了口，说\"进来吧\"。\n\n${han(760, "后")}。` };
      }),
    };
    const report = await runFastDraft({
      projectDir, chapter: 2, chapterGoal: "继续第 2 章。", writerClient: writer, chapterPlan: PLAN, segmentByPlan: true, requestedDraftLength: 3000,
      continueFrom: { text: EXISTING, length: 800, direction: "让管理员松口" },
    });
    expect(writer.generateDraft).toHaveBeenCalledTimes(1);
    const prompt = renderFastDraftPromptText(contexts[0]);
    expect(prompt).toContain("## already_written");
    expect(prompt).toContain("管理员抬头看了他一眼");
    expect(prompt).toContain("【作者说接下来写】让管理员松口");
    expect(prompt).toContain("一个字都不要改");
    expect(prompt).toContain("这次接着写 800 个中文字符左右");
    expect(prompt).toContain("本章章纲里 already_written 还没写到的要点");
    // 作者写的星号、直引号原样留着；新写那段照常清理（标题去掉），标点跟着作者那段（作者整段用直引号，新写的也不换）。
    expect(report.draftBody?.startsWith(`${EXISTING}\n\n他在走廊尽头等到天黑`)).toBe(true);
    expect(report.draftBody).toContain("说\"进来吧\"。");
    expect(report.draftBody).not.toContain("# 第2章");
    expect(report.passed).toBe(true);
  });

  it("要接得多就分两次：前一次不收尾、停在场面中间；后一次带上前一次接着写、收住本章", async () => {
    const projectDir = await makeBook();
    const contexts: WriterContextEnvelope[] = [];
    const writer: WriterClient = {
      generateDraft: vi.fn(async ({ context }) => {
        contexts.push(context);
        return { title: "", content: `${han(contexts.length === 1 ? 980 : 1000, contexts.length === 1 ? "甲" : "乙")}。` };
      }),
    };
    const report = await runFastDraft({ projectDir, chapter: 2, chapterGoal: "继续第 2 章。", writerClient: writer, requestedDraftLength: 3000, continueFrom: { text: EXISTING, length: 2000 } });
    expect(writer.generateDraft).toHaveBeenCalledTimes(2);
    const first = renderFastDraftPromptText(contexts[0]);
    expect(first).toContain("这次只接一段：写 1000 个中文字符左右");
    expect(first).toContain("不要收尾");
    const second = renderFastDraftPromptText(contexts[1]);
    expect(second).toContain(han(50, "甲"));
    expect(second).toContain("这次接着写 1020 个中文字符左右");
    expect(second).toContain("收住本章");
    expect(report.draftBody).toBe(`${EXISTING}\n\n${han(980, "甲")}。\n\n${han(1000, "乙")}。`);
  });

  it("没说写多少：写到本章目标；离目标差得少也写 600", async () => {
    const projectDir = await makeBook();
    const contexts: WriterContextEnvelope[] = [];
    const writer: WriterClient = { generateDraft: vi.fn(async ({ context }) => { contexts.push(context); return { title: "", content: `林澈${han(1000, "后")}。` }; }) };
    await runFastDraft({ projectDir, chapter: 2, chapterGoal: "继续第 2 章。", writerClient: writer, requestedDraftLength: 3000, continueFrom: { text: `林澈${han(1000, "前")}。` } });
    expect(renderFastDraftPromptText(contexts[0])).toMatch(/这次只接一段：写 99\d 个中文字符左右/u);
    contexts.length = 0;
    await runFastDraft({ projectDir, chapter: 2, chapterGoal: "继续第 2 章。", writerClient: writer, requestedDraftLength: 3000, continueFrom: { text: `林澈${han(2900, "前")}。` } });
    expect(renderFastDraftPromptText(contexts[0])).toContain("这次接着写 600 个中文字符左右");
  });

  it("接完还不到要的八成五：说清差多少再要一次最后那段，更长才用，留痕", async () => {
    const projectDir = await makeBook();
    const contexts: WriterContextEnvelope[] = [];
    const writer: WriterClient = {
      generateDraft: vi.fn(async ({ context }) => {
        contexts.push(context);
        return { title: "", content: `${han(contexts.length === 1 ? 400 : 780, contexts.length === 1 ? "短" : "长")}。` };
      }),
    };
    const report = await runFastDraft({ projectDir, chapter: 2, chapterGoal: "继续第 2 章。", writerClient: writer, requestedDraftLength: 3000, continueFrom: { text: EXISTING, length: 800 } });
    expect(writer.generateDraft).toHaveBeenCalledTimes(2);
    expect(renderFastDraftPromptText(contexts[1])).toMatch(/【上一次只写了 400 个字，还差 280 字】这次要写够 800 个中文字符/u);
    expect(report.draftBody).toBe(`${EXISTING}\n\n${han(780, "长")}。`);
    expect(report.issues.join("\n")).toContain("最后那段重写了一次（400 → 780 字）");
  });

  it("接着写的那段把已写的场面又写一遍 → 带提示重写一次，取重演少的那版并留痕", async () => {
    const projectDir = await makeBook();
    // 换了两个字重演（原样照抄的开头另有 dropEchoedLead 去掉）。
    const scene = EXISTING.split("\n\n")[0]!.replace("看了他一眼", "瞥了他一眼");
    const contexts: WriterContextEnvelope[] = [];
    const writer: WriterClient = {
      generateDraft: vi.fn(async ({ context }) => {
        contexts.push(context);
        return contexts.length === 1
          ? { title: "", content: `${scene}\n\n${han(700, "后")}。` }
          : { title: "", content: `林澈在走廊尽头等到天黑。\n\n${han(760, "新")}。` };
      }),
    };
    const report = await runFastDraft({ projectDir, chapter: 2, chapterGoal: "继续第 2 章。", writerClient: writer, requestedDraftLength: 3000, continueFrom: { text: EXISTING, length: 800 } });
    expect(writer.generateDraft).toHaveBeenCalledTimes(2);
    expect(renderFastDraftPromptText(contexts[1])).toContain("上一次接着写的那段把已经写过的场面又写了一遍");
    expect(report.draftBody).not.toContain(scene);
    expect(report.draftBody).toContain("走廊尽头等到天黑");
    expect(report.issues.join("\n")).toContain("接着写的那段重演了前面 1 段，已重写");
  });

  it("作者定了「至少 N 字」（下限 = 目标）：瞄区间中间写；接完全章还不到下限就再要一次（P13 真机：至少 2500 只写到 2204）", async () => {
    const projectDir = await makeBook();
    await writeRules(projectDir, [{ op: "rules.set", field: "targetWords", value: 2000 }, { op: "rules.set", field: "minWords", value: 2000 }]);
    const existing = `林澈${han(300, "前")}。`;
    const contexts: WriterContextEnvelope[] = [];
    const writer: WriterClient = {
      generateDraft: vi.fn(async ({ context }) => {
        contexts.push(context);
        return { title: "", content: `${han([900, 700, 950][contexts.length - 1]!, "甲乙丙"[contexts.length - 1]!)}。` };
      }),
    };
    const report = await runFastDraft({ projectDir, chapter: 2, chapterGoal: "继续第 2 章。", writerClient: writer, continueFrom: { text: existing } });
    // 下限 2000、上限 2300：瞄 2150，已写 302 → 接 1848（分两次）、至少 1698。
    expect(renderFastDraftPromptText(contexts[0])).toContain("这次只接一段：写 924 个中文字符左右（不少于 849）");
    expect(renderFastDraftPromptText(contexts[1])).toContain("这次接着写 948 个中文字符左右（不少于 798）");
    expect(renderFastDraftPromptText(contexts[2])).toContain("【上一次只写了 700 个字，还差 98 字】这次要写够 948 个中文字符");
    expect(report.draftBody).toBe(`${existing}\n\n${han(900, "甲")}。\n\n${han(950, "丙")}。`);
  });

  it("流式时：两段之间补空行；重写的那段先退回、定了用哪版再显示那版（稿纸上不会同一段写两遍）", async () => {
    const projectDir = await makeBook();
    const scene = EXISTING.split("\n\n")[0]!.replace("看了他一眼", "瞥了他一眼");
    let calls = 0;
    const writer: WriterClient = {
      generateDraft: vi.fn(async () => {
        calls += 1;
        if (calls === 1) return { title: "", content: `${han(1000, "甲")}。` };
        if (calls === 2) return { title: "", content: `${scene}\n\n${han(700, "乙")}。` };
        return { title: "", content: `${han(1000, "丙")}。` };
      }),
    };
    const resets: string[] = [];
    const report = await runFastDraft({
      projectDir, chapter: 2, chapterGoal: "继续第 2 章。", writerClient: writer, requestedDraftLength: 3000,
      continueFrom: { text: EXISTING, length: 2000 }, onStreamReset: (visible) => resets.push(visible),
    });
    // 只算新写的（本来写好的那段稿纸上另有，不在里面）。
    const one = `${han(1000, "甲")}。`;
    expect(resets).toEqual([`${one}\n\n`, `${one}\n\n`, `${one}\n\n${han(1000, "丙")}。`]);
    expect(report.draftBody).toBe(`${EXISTING}\n\n${one}\n\n${han(1000, "丙")}。`);
  });

  it("接着写开头把作者最后一段原样抄了一遍 → 去掉，接缝不出两遍（换题材长篇实跑 2026-10-27：「林晚看着火。」写了两遍）", async () => {
    const projectDir = await makeBook();
    const existing = `林澈把香插好，蹲在坟前烧纸。\n\n林澈看着火。`;
    const writer: WriterClient = { generateDraft: vi.fn(async () => ({ title: "", content: `林澈看着火。\n\n纸灰被风卷起来，${han(780, "后")}。` })) };
    const report = await runFastDraft({ projectDir, chapter: 2, chapterGoal: "继续第 2 章。", writerClient: writer, requestedDraftLength: 3000, continueFrom: { text: existing, length: 800 } });
    expect(report.issues).toEqual([]);
    expect(report.draftBody?.startsWith(`${existing}\n\n纸灰被风卷起来`)).toBe(true);
  });

  it("dropEchoedLead：整段相同、开头正是已写最后一段都去掉；只是像的不动，至少留一段", () => {
    const written = "第一段。\n\n他把门关上。\n\n林晚看着火。";
    expect(dropEchoedLead(written, "林晚看着火。\n\n他把门关上。\n\n新的一段。")).toBe("新的一段。");
    expect(dropEchoedLead(written, "林晚看着火。火苗舔着纸边。")).toBe("火苗舔着纸边。");
    expect(dropEchoedLead(written, "林晚盯着火。\n\n新的一段。")).toBe("林晚盯着火。\n\n新的一段。");
    expect(dropEchoedLead(written, "新的一段。\n\n林晚看着火。")).toBe("新的一段。\n\n林晚看着火。");
    expect(dropEchoedLead(written, "林晚看着火。")).toBe("林晚看着火。");
    expect(dropEchoedLead(written, "  \n ")).toBe("  \n ");
  });

  it("接着写的那段是 JSON / 工具调用 → 拦下（开头是作者的字，整章查不出来）", async () => {
    const projectDir = await makeBook();
    const writer: WriterClient = { generateDraft: vi.fn(async () => ({ title: "", content: `{"tool_call":"generate_draft","arguments":{}}` })) };
    const report = await runFastDraft({ projectDir, chapter: 2, chapterGoal: "继续第 2 章。", writerClient: writer, requestedDraftLength: 3000, continueFrom: { text: EXISTING, length: 800 } });
    expect(report.passed).toBe(false);
    expect(report.issues.join("\n")).toContain("JSON or a tool-call artifact");
  });

  it("接着写超了上限不从结尾裁（砍掉的就是刚接上的那段），如实记一条", async () => {
    const projectDir = await makeBook();
    const writer: WriterClient = { generateDraft: vi.fn(async () => ({ title: "", content: `林澈${han(3000, "后")}。` })) };
    const report = await runFastDraft({ projectDir, chapter: 2, chapterGoal: "继续第 2 章。", writerClient: writer, requestedDraftLength: 1500, continueFrom: { text: EXISTING, length: 1000 } });
    expect(report.draftBody).toContain(han(3000, "后"));
    expect(report.issues.join("\n")).toContain("接着写的稿不从结尾裁");
  });

  it("作者没定过本章字数：接着写超了默认目标不提「超过上限」（作者只说了这次写多少）", async () => {
    const projectDir = await makeBook();
    const writer: WriterClient = { generateDraft: vi.fn(async () => ({ title: "", content: `林澈${han(3000, "后")}。` })) };
    const report = await runFastDraft({ projectDir, chapter: 2, chapterGoal: "继续第 2 章。", writerClient: writer, continueFrom: { text: EXISTING, length: 1500 } });
    expect(report.draftBody).toContain(han(3000, "后"));
    expect(report.issues.join("\n")).not.toContain("超过上限");
  });
});
