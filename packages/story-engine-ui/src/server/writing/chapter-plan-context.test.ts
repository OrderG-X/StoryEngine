// @vitest-environment node
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  readStoryClock,
  buildChapterPlanSection,
  chapterPlanPath,
  collectPlanEntityTerms,
  collectPlanRetrievalTerms,
  normalizeChapterPlan,
  readChapterPlan,
  writeChapterPlan,
} from "../book/chapter-plan.js";
import { buildWriterContext } from "./context-gateway.js";
import { makeWriterRankContext } from "./rank-writer-context.js";
import { findEarlierPassages } from "./earlier-passages.js";
import { renderFastDraftPromptText } from "./prompt-cache-diagnostics.js";
import { createStoryProject } from "../book/project-store.js";

const NOW = new Date("2026-10-08T00:00:00.000Z");

describe("normalizeChapterPlan 宽进（模型无关）", () => {
  it("收齐常规形状", () => {
    const plan = normalizeChapterPlan({
      summary: "林舟去南门菜场后街找修鞋的吴师傅",
      beats: ["一早出门", "找到修鞋摊", "吴师傅说出沈同志的全名"],
      newInformation: ["沈同志全名沈秀英"],
      scene: { location: "南门菜场后街", time: "第二天上午" },
      characters: ["林舟", "吴师傅"],
      entities: ["登记表", "南门菜场后街"],
      threadsAdvanced: [{ title: "沈同志是谁", how: "得到全名" }],
      avoid: ["不要再写四月十七对上了"],
    }, { chapter: 11, now: NOW });
    expect(plan).toMatchObject({
      version: 1,
      chapter: 11,
      source: "model",
      beats: ["一早出门", "找到修鞋摊", "吴师傅说出沈同志的全名"],
      scene: { location: "南门菜场后街", time: "第二天上午" },
      threadsAdvanced: [{ title: "沈同志是谁", how: "得到全名" }],
    });
  });

  it("数组给成字符串、多余键、编号前缀、空串、数字都能收", () => {
    const plan = normalizeChapterPlan({
      goal: "去城东查档案",
      outline: "1. 骑车出门\n2. 门卫给纸条；3) 回铺子",
      newInfo: "",
      location: "城东开发区",
      characters: "林舟、门卫老人",
      objects: [42, { name: "纸条" }, ""],
      extra: "多余的键",
    }, { chapter: 9, direction: "  去城东  ", now: NOW });
    expect(plan?.summary).toBe("去城东查档案");
    expect(plan?.beats).toEqual(["骑车出门", "门卫给纸条", "回铺子"]);
    expect(plan?.newInformation).toEqual([]);
    expect(plan?.scene).toEqual({ location: "城东开发区" });
    expect(plan?.characters).toEqual(["林舟", "门卫老人"]);
    expect(plan?.entities).toEqual(["42", "纸条"]);
    expect(plan?.direction).toBe("去城东");
  });

  it("人名带括号注释时不被拆坏", () => {
    const plan = normalizeChapterPlan({
      summary: "s", beats: ["b"], characters: ["林舟", "送表的客人（中年男客，未具名）"],
    }, { chapter: 1, now: NOW });
    expect(plan?.characters).toEqual(["林舟", "送表的客人"]);
  });

  it("既没有 summary 也没有 beats → undefined（不拿空章纲冒充）", () => {
    expect(normalizeChapterPlan({ characters: ["林舟"] }, { chapter: 3 })).toBeUndefined();
    expect(normalizeChapterPlan("不是对象", { chapter: 3 })).toBeUndefined();
    expect(normalizeChapterPlan({ summary: "只有一句话", beats: [] }, { chapter: 3 })).toBeUndefined();
  });

  it("检索词：物件/地点给翻原文；人物只给挑事实", () => {
    const plan = normalizeChapterPlan({
      summary: "s", beats: ["b"], scene: { location: "南门菜场" }, characters: ["林舟"], entities: ["登记表", "南门菜场"],
    }, { chapter: 5, now: NOW })!;
    expect(collectPlanEntityTerms(plan)).toEqual(["南门菜场", "登记表"]);
    expect(collectPlanRetrievalTerms(plan)).toEqual(["南门菜场", "登记表", "林舟"]);
    expect(buildChapterPlanSection(plan)).toMatchObject({ summary: "s", beats: ["b"], entities: ["登记表", "南门菜场"] });
  });
});

describe("章纲落盘", () => {
  it("写了能读回；文件坏了读侧降级并留痕", async () => {
    const dir = await mkdtemp(join(tmpdir(), "story-engine-chapter-plan-"));
    const plan = normalizeChapterPlan({ summary: "去城东", beats: ["出门", "回来"] }, { chapter: 9, source: "author", now: NOW })!;
    const path = await writeChapterPlan(dir, plan);
    expect(path).toBe(chapterPlanPath(dir, 9));
    expect(await readChapterPlan(dir, 9)).toEqual(plan);
    expect(await readChapterPlan(dir, 10)).toBeUndefined();

    await writeFile(chapterPlanPath(dir, 9), "{坏了", "utf-8");
    const notes: string[] = [];
    expect(await readChapterPlan(dir, 9, (reason) => notes.push(reason))).toBeUndefined();
    expect(notes[0]).toContain("损坏");
  });
});

describe("findEarlierPassages 按章纲翻旧章原文", () => {
  it("近章优先、每词限量、轮流分配名额、按章号正序；不翻排除的章", async () => {
    const dir = await mkdtemp(join(tmpdir(), "story-engine-earlier-passages-"));
    await mkdir(join(dir, "chapters"), { recursive: true });
    await writeFile(join(dir, "chapters", "0001.md"), "# 第1章\n\n铁皮盒放在陈列柜最里面。\n\n他关了灯。\n", "utf-8");
    await writeFile(join(dir, "chapters", "0002.md"), "# 第2章\n\n登记表上写着：地址，南门槐树巷十七号。\n\n铁皮盒挪到了后屋箱子里。\n", "utf-8");
    await writeFile(join(dir, "chapters", "0003.md"), "# 第3章\n\n他又看了一遍登记表。\n", "utf-8");
    await writeFile(join(dir, "chapters", "0004.md"), "# 第4章\n\n登记表压在台灯底下。\n", "utf-8");

    const passages = await findEarlierPassages({
      projectDir: dir, chapter: 5, terms: ["登记表", "铁皮盒", "城东"], excludeChapters: [4], maxPerTerm: 2, maxTotal: 3,
    });
    // 登记表：近章优先取第 3、2 章（第 4 章被排除）；铁皮盒取第 2 章；名额 3 → 先各取第 1 段，再补登记表第 2 段。
    expect(passages.map((item) => [item.chapter, item.term])).toEqual([[2, "铁皮盒"], [2, "登记表"], [3, "登记表"]]);
    expect(passages.find((item) => item.chapter === 2 && item.term === "登记表")?.text).toContain("南门槐树巷十七号");
  });

  it("没有章节目录 / 没有检索词 → 空", async () => {
    const dir = await mkdtemp(join(tmpdir(), "story-engine-earlier-passages-empty-"));
    expect(await findEarlierPassages({ projectDir: dir, chapter: 5, terms: ["登记表"] })).toEqual([]);
    expect(await findEarlierPassages({ projectDir: dir, chapter: 5, terms: [" ", "x"] })).toEqual([]);
  });
});

describe("buildWriterContext 带章纲", () => {
  it("章纲进 chapter_plan 段、按点名的物件翻出旧章原文、章纲地点算本章地点", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "story-engine-plan-context-"));
    const { projectDir } = await createStoryProject({
      rootDir, title: "海州账册", genre: "urban", logline: "审计员林澈追查账册篡改。", protagonistName: "林澈",
    });
    await mkdir(join(projectDir, "chapters"), { recursive: true });
    await writeFile(join(projectDir, "chapters", "0001.md"), "# 第1章 · 账册\n\n蓝色账册第三页被人撕掉了一角。\n", "utf-8");
    await writeFile(join(projectDir, "chapters", "0002.md"), "# 第2章 · 雨\n\n林澈在家里坐了一夜。\n", "utf-8");
    const plan = normalizeChapterPlan({
      summary: "林澈带着蓝色账册去档案室核对",
      beats: ["去档案室", "对出缺页内容"],
      newInformation: ["缺页记的是一笔境外汇款"],
      entities: ["蓝色账册"],
    }, { chapter: 3, now: NOW })!;

    const envelope = await buildWriterContext({ projectDir, chapter: 3, chapterGoal: "继续第 3 章。", chapterPlan: plan });
    const names = envelope.sections.map((section) => section.name);
    expect(names).toContain("chapter_plan");
    expect(names).toContain("earlier_passages");
    const passages = envelope.sections.find((section) => section.name === "earlier_passages")?.content as { passages: { chapter: number; text: string }[] };
    expect(passages.passages).toEqual([expect.objectContaining({ chapter: 1, text: expect.stringContaining("第三页被人撕掉了一角") })]);
    const prompt = renderFastDraftPromptText(envelope);
    expect(prompt).toContain("缺页记的是一笔境外汇款");
    expect(prompt).toContain("If the chapter_plan section exists");
  });

  it("上一稿核出的对不上 → 进受保护段 last_draft_conflicts（预算再紧也不裁）；没有就不出这段", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "story-engine-plan-context-conflicts-"));
    const { projectDir } = await createStoryProject({ rootDir, title: "海州账册", genre: "urban", logline: "审计员林澈追查账册篡改。", protagonistName: "林澈" });
    const conflict = { wrote: "他上到三楼走廊。", against: "档案室的单间在一楼。", where: "第 1 章", why: "楼层对不上" };
    const envelope = await buildWriterContext({ projectDir, chapter: 2, chapterGoal: "继续第 2 章。", lastDraftConflicts: [conflict] });
    const ranked = makeWriterRankContext({ tokenBudget: 1 }).rankContext(envelope);
    const section = ranked.sections.find((item) => item.name === "last_draft_conflicts")?.content as { instruction: string; conflicts: unknown[] } | undefined;
    expect(section?.conflicts).toEqual([conflict]);
    expect(section?.instruction).toContain("以前文和设定为准");
    const plain = await buildWriterContext({ projectDir, chapter: 2, chapterGoal: "继续第 2 章。", lastDraftConflicts: [] });
    expect(plain.sections.map((item) => item.name)).not.toContain("last_draft_conflicts");
  });

  it("不给章纲 → 没有这两段（旧行为）", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "story-engine-plan-context-none-"));
    const { projectDir } = await createStoryProject({
      rootDir, title: "海州账册", genre: "urban", logline: "审计员林澈追查账册篡改。", protagonistName: "林澈",
    });
    const envelope = await buildWriterContext({ projectDir, chapter: 2, chapterGoal: "继续第 2 章。" });
    const names = envelope.sections.map((section) => section.name);
    expect(names).not.toContain("chapter_plan");
    expect(names).not.toContain("earlier_passages");
  });
});

describe("故事日历（十章验收：「三天前」一直是三天前、星期算错）", () => {
  it("storyDay 宽进：数字、「第12天」都收，非正数/乱写不收", () => {
    const base = { summary: "s", beats: ["b"] };
    expect(normalizeChapterPlan({ ...base, storyDay: 12 }, { chapter: 3 })?.storyDay).toBe(12);
    expect(normalizeChapterPlan({ ...base, storyDay: "第12天" }, { chapter: 3 })?.storyDay).toBe(12);
    expect(normalizeChapterPlan({ ...base, scene: { storyDay: "5" } }, { chapter: 3 })?.storyDay).toBe(5);
    expect(normalizeChapterPlan({ ...base, storyDay: 0 }, { chapter: 3 })?.storyDay).toBeUndefined();
    expect(normalizeChapterPlan({ ...base, storyDay: "过几天" }, { chapter: 3 })?.storyDay).toBeUndefined();
    expect(normalizeChapterPlan(base, { chapter: 1 })?.storyDay).toBe(1);
  });

  it("读前面各章的天数（跳过没天数的老章纲），写手段里给出今天第几天和前文天数", async () => {
    const dir = await mkdtemp(join(tmpdir(), "story-engine-story-clock-"));
    await writeChapterPlan(dir, normalizeChapterPlan({ summary: "怀表送到铺子", beats: ["b"], storyDay: 1, scene: { time: "周一上午" } }, { chapter: 1, now: NOW })!);
    await writeChapterPlan(dir, normalizeChapterPlan({ summary: "没天数的老章纲", beats: ["b"] }, { chapter: 2, now: NOW })!);
    await writeChapterPlan(dir, normalizeChapterPlan({ summary: "去档案馆", beats: ["b"], storyDay: 4 }, { chapter: 3, now: NOW })!);
    const clock = await readStoryClock(dir, 4);
    expect(clock.map((entry) => [entry.chapter, entry.storyDay])).toEqual([[1, 1], [3, 4]]);
    const plan = normalizeChapterPlan({ summary: "s", beats: ["b"], storyDay: 9 }, { chapter: 4, now: NOW })!;
    const section = buildChapterPlanSection(plan, clock) as { storyClock: { today: string; earlier: string[]; rule: string } };
    // 第十五轮：只给天数让写手自己减，台词里的「昨天 / 上周」错了 11 处 → 直接标好从本章看是哪天、星期几。
    expect(section.storyClock.today).toBe("本章是故事第 9 天，周二");
    expect(section.storyClock.earlier).toEqual([
      "8 天前（故事第 1 天，周一）：第 1 章，周一上午，怀表送到铺子",
      "5 天前（故事第 4 天，周四）：第 3 章，去档案馆",
    ]);
    expect(section.storyClock.rule).toContain("不要自己推算");
  });

  it("「故事第 N 天」不进要点 / 摘要 / 开场时间，只留在 storyDay（第十八轮正文照抄出「第十一天」）", () => {
    const plan = normalizeChapterPlan({
      summary: "故事第11天，林舟去房管所",
      beats: ["故事第11天上午，林舟锁好铺子去房管所", "（故事第11天）下午回铺子"],
      scene: { time: "第二天上午（故事第11天）" },
    }, { chapter: 10, now: NOW })!;
    expect(plan.summary).toBe("林舟去房管所");
    expect(plan.beats).toEqual(["上午，林舟锁好铺子去房管所", "下午回铺子"]);
    expect(plan.scene.time).toBe("第二天上午");
    expect(plan.storyDay).toBe(11);
    const digits = normalizeChapterPlan({ summary: "s", beats: ["第3天上午，林舟开门", "第二天一早他又去了"], scene: { time: "第3天上午" } }, { chapter: 3, now: NOW })!;
    expect(digits.beats).toEqual(["上午，林舟开门", "第二天一早他又去了"]);
    expect(digits.scene.time).toBe("上午");
    expect(digits.storyDay).toBe(3);
  });

  it("describeStoryDay：本章第几天、星期几（给记事实环节换掉「下周三」）", async () => {
    const { describeStoryDay } = await import("../book/chapter-plan.js");
    const plan = normalizeChapterPlan({ summary: "s", beats: ["b"], storyDay: 8 }, { chapter: 9, now: NOW })!;
    expect(describeStoryDay(plan, [{ chapter: 1, storyDay: 1, time: "周三上午", summary: "a" }])).toBe("本章是故事第 8 天，周三");
    expect(describeStoryDay(plan)).toBe("本章是故事第 8 天");
    expect(describeStoryDay(undefined)).toBeUndefined();
  });

  it("相对说法：同一天 / 昨天 / 前天；没有星期锚就不编星期", () => {
    const plan = normalizeChapterPlan({ summary: "s", beats: ["b"], storyDay: 5 }, { chapter: 6, now: NOW })!;
    const section = buildChapterPlanSection(plan, [
      { chapter: 3, storyDay: 3, summary: "a" },
      { chapter: 4, storyDay: 4, summary: "b" },
      { chapter: 5, storyDay: 5, time: "上午", summary: "c" },
    ]) as { storyClock: { today: string; earlier: string[] } };
    expect(section.storyClock.today).toBe("本章是故事第 5 天");
    expect(section.storyClock.earlier).toEqual([
      "前天（故事第 3 天）：第 3 章，a",
      "昨天（故事第 4 天）：第 4 章，b",
      "今天早些时候（故事第 5 天）：第 5 章，上午，c",
    ]);
  });
});

