// @vitest-environment node
// R3 删旧拟纲路后，这里测章纲员复用的纯函数：材料收集（collectPlanMaterials / planMaterialBlocks）、
// 章纲的日子（datePlan / previousPresentFor）、骨架章纲判定。编排（章纲员拟 → 核账员审 → 改一轮）
// 见 resolveChapterPlanForDraft 的用例和 editorial/planner.test.ts。
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cardWrite, chapterCommit, runCommand } from "@actalk/story-core";
import { createStoryProject } from "../book/project-store.js";
import { seedChapters, seedDecisions, seedThreads } from "../book/ledger-test-helpers.js";
import { normalizeChapterPlan, readChapterPlan, writeChapterPlan } from "../book/chapter-plan.js";
import { planClock } from "../book/story-timeline.js";
import { readStoryViews } from "../book/story-views.js";
import { describe, expect, it } from "vitest";
import type { BrainCallModel } from "./reader-window.js";
import { collectPlanMaterials, planMaterialBlocks } from "./plan-materials.js";

async function makeBook(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "se-plan-chapter-"));
  const { projectDir } = await createStoryProject({
    rootDir, title: "海州账册", genre: "urban", logline: "审计员林澈追查账册篡改。", protagonistName: "林澈",
  });
  // 第 1 章定稿：一条开着的悬念（标题截断、证据补全），一条作者说已经收了的。
  await seedThreads(projectDir, [
    { name: "lead-1", type: "question", title: "账册第三页被谁撕掉了…", openedAt: 1, quote: "账册第三页被谁撕掉了，撕口很新" },
    { name: "lead-2", type: "question", title: "已经收口的旧事", openedAt: 1 },
  ], [{ chapter: 1, title: "第1章 · 账册", entries: [{ kind: "summary", text: "林澈锁好账册。", quote: "林澈把蓝色账册锁进抽屉，决定明天去档案室。" }] }]);
  await seedDecisions(projectDir, [{ type: "thread.close", thread: "lead-2", chapter: 1 }]);
  return projectDir;
}

describe("拟章纲材料与提示词块", () => {
  it("带上一章原文、开着的线索（截断标题补证据）、不带已收口的", async () => {
    const projectDir = await makeBook();
    const materials = await collectPlanMaterials(projectDir, 2);
    expect(materials.previousChapter?.text).toContain("决定明天去档案室");
    expect(materials.openThreads).toEqual(["账册第三页被谁撕掉了…（账册第三页被谁撕掉了，撕口很新）（上次第 1 章）"]);
    const blocks = planMaterialBlocks(2, materials, "让他去档案室").join("\n\n");
    expect(blocks).toContain("【作者这章的方向】让他去档案室");
    expect(blocks).toContain("决定明天去档案室");
    expect(blocks).not.toContain("已经收口的旧事");
  });
});

describe("拟章纲材料：人物、物件来自设定本（重构 P9）", () => {
  it("人物 = 设定卡里的 + 账里出场过还没建卡的；物件 = 地点 / 物品 / 其他设定卡的名字；前提在设定本摘要里", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "se-plan-cards-"));
    const { projectDir } = await createStoryProject({ rootDir, title: "海州账册", genre: "都市", logline: "审计员林澈追查账册篡改。", protagonistName: "林澈" });
    const cards = await runCommand(projectDir, cardWrite, { ops: [
      { op: "card.create", kind: "character", name: "许棠", fields: [{ label: "身份", value: "拆迁办干部" }, { label: "年龄", value: "三十五" }] },
      { op: "card.create", kind: "place", name: "市档案馆" },
      { op: "card.create", kind: "item", name: "蓝色账册" },
      { op: "card.create", kind: "lore", name: "审计规矩" },
    ] }, { caller: "author", idempotencyKey: "plan-cards" });
    expect(cards.ok).toBe(true);
    const text = "# 第1章\n\n林澈把蓝色账册锁进抽屉。门卫老周探头看了一眼。";
    const committed = await runCommand(projectDir, chapterCommit, { chapter: 1, text, entries: [
      { kind: "presence", review: "auto", name: "林澈", nameUsed: "林澈", viewpoint: true, quote: "林澈把蓝色账册锁进抽屉" },
      { kind: "presence", review: "auto", name: "周守义", nameUsed: "老周", quote: "门卫老周探头看了一眼" },
    ] }, { caller: "author", idempotencyKey: "plan-c1" });
    expect(committed.ok).toBe(true);

    const materials = await collectPlanMaterials(projectDir, 2);
    expect(materials.characters).toEqual(["林澈", "许棠", "周守义"]);
    expect(materials.entities).toEqual(["市档案馆", "蓝色账册", "审计规矩"]);
    for (const gone of ["premise", "longFormGoals", "protectedSecrets", "coreMysteries"]) expect(materials).not.toHaveProperty(gone);
    expect(materials.foundation).toContain("一句话：审计员林澈追查账册篡改。");
    expect(materials.foundation).toContain("许棠——身份：拆迁办干部；年龄：三十五");

    const blocks = planMaterialBlocks(2, materials).join("\n\n");
    expect(blocks).toContain("【已有人物（身份、年龄见设定本，别用错人、别算错年代）】林澈、许棠、周守义");
    expect(blocks).toContain("【已登记的物件/地点/设定】市档案馆、蓝色账册、审计规矩");
    for (const gone of ["【故事前提】", "【长线目标】", "【主谜/核心冲突】", "【受保护的秘密"]) expect(blocks).not.toContain(gone);
    expect(blocks).not.toMatch(/k-\d/u);
  });

  it("新书只有建书时那几栏：人物就是主角，没有物件", async () => {
    const materials = await collectPlanMaterials(await makeBook(), 2);
    expect(materials.characters).toEqual(["林澈"]);
    expect(materials.entities).toEqual([]);
  });
});

describe("拟章纲材料：旧事实 / 前几章时间 / 反复出现的描写（十章验收第二轮）", () => {
  it("带上与前文相关的旧事实、前几章账里记的是哪天（不看章纲），并把跨章反复的描写确定性并进 avoid", async () => {
    const projectDir = await makeBook();
    const ending = "他把台灯拧暗了一格，一屋子的钟在黑暗里响着。";
    const next = { kind: "time" as const, start: { offset: { unit: "day" as const, min: 1, max: 1 }, basis: "text" as const, quote: "" }, sameDay: true };
    await seedChapters(projectDir, [2, 3, 4].map((n) => ({
      chapter: n,
      entries: n === 2 ? [{ kind: "day" as const, day: 12, dayEnd: 12 }]
        : n === 3 ? [{ ...next, timeOfDay: "上午" }, { kind: "fact" as const, nature: "event" as const, text: "异议书已在第3章递交并拿到回执编号。" }]
        : [next],
    })));
    // 正文换成各章自己写的（结尾那句跨章反复）。
    for (const n of [2, 3, 4]) {
      await writeFile(join(projectDir, "chapters", `000${n}.md`), `# 第${n}章\n\n第${n}章各写各的事，编号${n}。\n\n${ending}\n`, "utf-8");
      await writeChapterPlan(projectDir, normalizeChapterPlan({ summary: `第${n}章`, beats: ["b"], scene: { time: `六月${10 + n}日上午` } }, { chapter: n })!);
    }

    const materials = await collectPlanMaterials(projectDir, 5);
    expect(materials.facts.join("\n")).toContain("异议书已在第3章递交");
    expect(materials.recentTimes).toEqual([
      "第 1 章：没认出这章在不在当下线上，是哪天不知道",
      "第 2 章：故事第 12 天",
      "第 3 章：故事第 13 天，上午",
      "第 4 章：故事第 14 天",
    ]);
    expect(materials.recurringPhrases.some((phrase) => phrase.includes("一屋子的钟在黑暗里响"))).toBe(true);
    const blocks = planMaterialBlocks(5, materials).join("\n\n");
    expect(blocks).toContain("【前几章的时间】");
    expect(blocks).toContain("【已确立事实（不能矛盾，做过的别再做）】");
  });
});

describe("datePlan：章纲的日子存成相对的（离上一个当下章往后几天），不存绝对天数（写作版本 P3a T9）", () => {
  it("dayOffset 优先，没有看开场时间；可以是负的（多线往回接）；整章回忆、上一章不知道、前面没有当下章都不存", async () => {
    const { datePlan, readDayOffset } = await import("./plan-materials.js");
    const make = (over: Record<string, unknown> = {}) => normalizeChapterPlan({ summary: "s", beats: ["b"], ...over }, { chapter: 10 })!;
    expect(datePlan(make(), 1, 9)).toMatchObject({ dayOffset: 1, after: 9 });
    expect(datePlan(make({ scene: { time: "三天后傍晚" } }), undefined, 9)).toMatchObject({ dayOffset: 3, after: 9 });
    expect(datePlan(make({ scene: { time: "紧接上一章结尾，傍晚" } }), undefined, 8)).toMatchObject({ dayOffset: 0, after: 8 });
    expect(datePlan(make(), -2, 9)).toMatchObject({ dayOffset: -2, after: 9 });
    // 算不出隔了几天：不存，日历照实说「哪天说不准」。
    expect(datePlan(make({ scene: { time: "清晨" } }), undefined, 9)).not.toHaveProperty("dayOffset");
    const flashback = datePlan(make({ frame: "回忆" }), 1, 9);
    expect(flashback.frame).toBe("past");
    expect(flashback).not.toHaveProperty("dayOffset");
    expect(datePlan(make(), 1, "unknown")).not.toHaveProperty("dayOffset");
    expect(datePlan(make(), 1, undefined)).not.toHaveProperty("dayOffset");
    // 模型抄回来的旧 after 不留：以这次查到的上一个当下章为准。
    expect(datePlan(make({ dayOffset: 5, after: 3 }), undefined, 9)).not.toHaveProperty("after");
    expect(readDayOffset({ dayOffset: 2 })).toBe(2);
    expect(readDayOffset({ dayOffset: -2 })).toBe(-2);
    expect(readDayOffset({ dayOffset: "-2" })).toBe(-2);
    expect(readDayOffset({ dayOffset: "1天" })).toBe(1);
    expect(readDayOffset({ dayOffset: "第二天" })).toBe(1);
    expect(readDayOffset({ dayOffset: "同一天" })).toBe(0);
    expect(readDayOffset({ dayOffset: "" })).toBeUndefined();
    expect(readDayOffset({})).toBeUndefined();
  });
});

describe("previousPresentFor：上一个当下章；中间有章不知道在不在当下就说不知道，不拿再前一章顶（P2b 设计 3.3）", () => {
  it("上一章账待记 → unknown；之后记了时间的章照常；整章回忆的跳过", async () => {
    const { previousPresentFor } = await import("./plan-materials.js");
    const rootDir = await mkdtemp(join(tmpdir(), "se-plan-unknown-"));
    const { projectDir } = await createStoryProject({ rootDir, title: "渡口" });
    const commit = async (chapter: number, text: string, entries: Parameters<typeof chapterCommit.plan>[1]["entries"], pending = false) => {
      const outcome = await runCommand(projectDir, chapterCommit, {
        chapter, text, entries, ...(pending ? { ledger: { status: "pending" as const, reasonCodes: ["keeper_failed"] } } : {}),
      }, { caller: "author", idempotencyKey: `k${chapter}` });
      expect(outcome.ok).toBe(true);
    };
    const day = (min: number) => ({ unit: "day" as const, min, max: min });
    await commit(1, "# 第1章\n\n周三清晨，渡口起了雾。", [{ kind: "time", review: "auto", start: { offset: day(0), basis: "text", quote: "周三清晨" }, sameDay: true }]);
    expect(await previousPresentFor(projectDir, 1)).toBeUndefined();
    expect(await previousPresentFor(projectDir, 2)).toBe(1);
    await commit(2, "# 第2章\n\n雾还没散。", [], true);
    expect(await previousPresentFor(projectDir, 3)).toBe("unknown");
    await commit(3, "# 第3章\n\n第二天上午，船来了。", [{ kind: "time", review: "auto", start: { offset: day(1), basis: "text", quote: "第二天上午" }, sameDay: true }]);
    expect(await previousPresentFor(projectDir, 4)).toBe(3);
    await commit(4, "# 第4章\n\n他想起那年冬天。那年很冷。", [{ kind: "time", review: "auto", segments: [{ frame: "past", firstQuote: "他想起那年冬天", lastQuote: "那年很冷" }] }]);
    expect(await previousPresentFor(projectDir, 5)).toBe(3);
  });
});

describe("骨架章纲重拟（第二十轮第 5、7 章只有要点，日历少记一天）", () => {
  it("人物/开场/新信息全空 → 章纲员重拟一次用完整的；两次都是骨架就用骨架，不判失败", async () => {
    const dir = await mkdtemp(join(tmpdir(), "se-plan-skeleton-"));
    await mkdir(join(dir, "chapters"), { recursive: true });
    const skeleton = JSON.stringify({ summary: "林舟去档案馆", beats: ["去档案馆", "查到底册"] });
    const full = JSON.stringify({ summary: "林舟去档案馆", beats: ["去档案馆", "查到底册"], characters: ["林舟"], scene: { time: "第二天上午" }, dayOffset: 1 });
    const { planChapterByPlanner } = await import("./planner.js");
    // 两次拟章纲任务消息之间夹着写笔记的调用：假模型 json:false 回笔记、json:true 按序回章纲。
    const queue: (string | Error)[] = [skeleton, full];
    const callModel: BrainCallModel = async (_messages, options) => {
      if (!options.json) return "笔记";
      const reply = queue.shift() ?? skeleton;
      if (reply instanceof Error) throw reply;
      return reply;
    };
    const retried = await planChapterByPlanner({ projectDir: dir, chapter: 3, callModel });
    expect(retried.ok && retried.plan.characters).toEqual(["林舟"]);
    const stubborn: BrainCallModel = async (_messages, options) => (options.json ? skeleton : "笔记");
    const still = await planChapterByPlanner({ projectDir: dir, chapter: 3, callModel: stubborn });
    expect(still.ok && still.plan.summary).toBe("林舟去档案馆");
    expect(await readChapterPlan(dir, 3)).toBeUndefined();
  });
});

describe("上一章停在哪天以账为准，章纲里写的换天不算（2026-10-28 第 33 章章纲跟着过时的第 32 章章纲少记四天）", () => {
  it("作者定了第 1 章是第 9 天：没说到哪天，下一章是哪天就说不准；说了到第 11 天，下一章「第二天」就是第 12 天", async () => {
    const projectDir = await makeBook();
    const day = (dayEnd?: number) => seedDecisions(projectDir, [{ type: "chapter.day", chapter: 1, day: 9, ...(dayEnd ? { dayEnd } : {}) }]);
    await writeChapterPlan(projectDir, normalizeChapterPlan({ summary: "s", beats: ["傍晚回铺子", "第二天上午，许棠上门"] }, { chapter: 1 })!);
    const today = async () => planClock((await readStoryViews(projectDir)).projection, 2, { dayOffset: 1, after: 1 })?.today;
    await day();
    expect(await today()).toContain("本章是哪天说不准");
    await day(11);
    expect(await today()).toBe("本章是故事第 12 天");
  });
});
