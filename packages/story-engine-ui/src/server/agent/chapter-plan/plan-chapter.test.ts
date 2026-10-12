// @vitest-environment node
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStoryProject, normalizeChapterPlan, readChapterPlan, writeChapterPlan } from "@actalk/story-engine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildPlanMessages, collectPlanMaterials, planChapter, resolveChapterPlanForDraft } from "./plan-chapter.js";
import type { BrainCallModel } from "../../brain/reader-window.js";

async function makeBook(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "se-plan-chapter-"));
  const { projectDir } = await createStoryProject({
    rootDir, title: "海州账册", genre: "urban", premise: "审计员林澈追查账册篡改。", mainCharacterName: "林澈",
  });
  await mkdir(join(projectDir, "chapters"), { recursive: true });
  await writeFile(join(projectDir, "chapters", "0001.md"), "# 第1章 · 账册\n\n林澈把蓝色账册锁进抽屉，决定明天去档案室。\n", "utf-8");
  await writeFile(join(projectDir, "story", "threads.json"), JSON.stringify({
    threads: [
      { id: "lead-1", type: "lead", title: "账册第三页被谁撕掉了…", status: "open", firstSeenChapter: 1, lastTouchedChapter: 1, evidence: ["账册第三页被谁撕掉了，撕口很新"] },
      { id: "lead-2", type: "lead", title: "已经收口的旧事", status: "done", firstSeenChapter: 1, lastTouchedChapter: 1, evidence: [] },
    ],
  }), "utf-8");
  return projectDir;
}

const GOOD_PLAN = JSON.stringify({
  summary: "林澈去档案室对出缺页",
  beats: ["一早去档案室", "管理员拦人", "对出缺页是一笔境外汇款"],
  newInformation: ["缺页记的是一笔境外汇款"],
  scene: { location: "档案室", time: "第二天上午" },
  characters: ["林澈"],
  entities: ["蓝色账册", "档案室"],
  threadsAdvanced: [{ title: "账册第三页被谁撕掉了", how: "对出缺页内容" }],
  avoid: ["不要再写锁抽屉"],
});

describe("拟章纲材料与提示词", () => {
  it("带上一章原文、开着的线索（截断标题补证据）、不带已收口的", async () => {
    const projectDir = await makeBook();
    const materials = await collectPlanMaterials(projectDir, 2);
    expect(materials.previousChapter?.text).toContain("决定明天去档案室");
    expect(materials.openThreads).toEqual(["账册第三页被谁撕掉了…（账册第三页被谁撕掉了，撕口很新）（上次第 1 章）"]);
    const [system, user] = buildPlanMessages(2, materials, "让他去档案室");
    expect(system.content).toContain("至少给出一条读者此前不知道的新信息");
    expect(user.content).toContain("【作者这章的方向】让他去档案室");
    expect(user.content).toContain("决定明天去档案室");
    expect(user.content).not.toContain("已经收口的旧事");
  });
});

describe("planChapter", () => {
  it("拟成即落盘", async () => {
    const projectDir = await makeBook();
    const result = await planChapter({ projectDir, chapter: 2, callModel: vi.fn(async () => GOOD_PLAN) });
    expect(result.ok).toBe(true);
    expect((await readChapterPlan(projectDir, 2))?.summary).toBe("林澈去档案室对出缺页");
  });

  it("第一次坏 JSON、重试成功；重试换精简材料（服务商内容过滤误伤时，同样输入重发必然再拦）", async () => {
    const projectDir = await makeBook();
    await writeFile(join(projectDir, "chapters", "0001.md"), `# 第1章 · 账册\n\n${"林澈翻账册，一页页核对。".repeat(120)}\n\n结尾：他决定明天去档案室。\n`, "utf-8");
    const callModel = vi.fn().mockResolvedValueOnce("不是JSON").mockResolvedValueOnce(GOOD_PLAN);
    const result = await planChapter({ projectDir, chapter: 2, callModel });
    expect(callModel).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
    const size = (call: number) => (callModel.mock.calls[call][0] as { content: string }[]).map((m) => m.content.length).reduce((a, b) => a + b, 0);
    expect(size(1)).toBeLessThan(size(0));
    expect(JSON.stringify(callModel.mock.calls[1][0])).toContain("结尾：他决定明天去档案室");
  });

  it("两次都不成 → ok:false + 原因，不抛、不落盘", async () => {
    const projectDir = await makeBook();
    const callModel = vi.fn(async () => JSON.stringify({ characters: ["林澈"] }));
    const result = await planChapter({ projectDir, chapter: 2, callModel });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("章纲没拟成（已自动重试一次）") });
    expect(await readChapterPlan(projectDir, 2)).toBeUndefined();
  });
});

describe("resolveChapterPlanForDraft（旧路，显式 legacy）", () => {
  beforeEach(() => {
    // R1 起章纲员是缺省路；这个 describe 测的是旧路的沿用 / 重拟 / 失败语义（假模型只会说旧路的话），
    // 显式设 legacy 再测。章纲员路见下面的 describe。
    vi.stubEnv("STORY_PLANNER", "legacy");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("同一方向重写沿用已有章纲；方向变了重拟", async () => {
    const projectDir = await makeBook();
    const callModel = vi.fn(async () => GOOD_PLAN);
    const first = await resolveChapterPlanForDraft({ projectDir, chapter: 2, callModel });
    expect(first.reused).toBe(false);
    // 新拟一份 = 拟章纲 + 审校各一次调用；沿用不再调。
    expect(callModel).toHaveBeenCalledTimes(2);
    const again = await resolveChapterPlanForDraft({ projectDir, chapter: 2, callModel });
    expect(again.reused).toBe(true);
    expect(callModel).toHaveBeenCalledTimes(2);
    const redirected = await resolveChapterPlanForDraft({ projectDir, chapter: 2, direction: "改成去银行", callModel });
    expect(redirected.reused).toBe(false);
    expect(callModel).toHaveBeenCalledTimes(4);
    expect((await readChapterPlan(projectDir, 2))?.direction).toBe("改成去银行");
  });

  it("拟不成 → 没有章纲 + 如实说明照常出稿", async () => {
    const projectDir = await makeBook();
    const resolved = await resolveChapterPlanForDraft({ projectDir, chapter: 2, callModel: vi.fn(async () => { throw new Error("socket hang up"); }) });
    expect(resolved.plan).toBeUndefined();
    expect(resolved.note).toContain("这次按没有章纲出稿");
  });
});

describe("拟章纲材料：旧事实 / 前几章时间 / 反复出现的描写（十章验收第二轮）", () => {
  it("带上与前文相关的旧事实、前几章章纲里的时间，并把跨章反复的描写确定性并进 avoid", async () => {
    const projectDir = await makeBook();
    const ending = "他把台灯拧暗了一格，一屋子的钟在黑暗里响着。";
    for (const n of [2, 3, 4]) {
      await writeFile(join(projectDir, "chapters", `000${n}.md`), `# 第${n}章\n\n第${n}章各写各的事，编号${n}。\n\n${ending}\n`, "utf-8");
      await writeChapterPlan(projectDir, normalizeChapterPlan({ summary: `第${n}章`, beats: ["b"], scene: { time: `六月${10 + n}日上午` } }, { chapter: n })!);
    }
    await writeFile(join(projectDir, "story", "fact-ledger.json"), JSON.stringify({
      version: "v0", facts: [{ id: "fact-3-0", chapter: 3, text: "异议书已在第3章递交并拿到回执编号。", source: "auto" }],
    }), "utf-8");

    const materials = await collectPlanMaterials(projectDir, 5);
    expect(materials.facts.join("\n")).toContain("异议书已在第3章递交");
    expect(materials.recentTimes).toEqual(["第 2 章：六月12日上午", "第 3 章：六月13日上午", "第 4 章：六月14日上午"]);
    expect(materials.recurringPhrases.some((phrase) => phrase.includes("一屋子的钟在黑暗里响"))).toBe(true);
    const [system, user] = buildPlanMessages(5, materials);
    expect(system.content).toContain("不要连续两章做同一类事");
    expect(user.content).toContain("【前几章的时间】");
    expect(user.content).toContain("【已确立事实（不能矛盾，做过的别再做）】");

    const result = await planChapter({ projectDir, chapter: 5, callModel: vi.fn(async () => GOOD_PLAN) });
    expect(result.ok && result.plan.avoid.at(-1)).toContain("别再用这些说法：");
  });
});

describe("reconcileStoryDay：天数由程序按上一章往后加（第十九轮模型数错第 4、7 章）", () => {
  it("dayOffset 优先；没有就看开场时间；都没有用模型天数但不许倒退；全没有当同一天", async () => {
    const { reconcileStoryDay, readDayOffset } = await import("./plan-chapter.js");
    const make = (time?: string, storyDay?: number) => normalizeChapterPlan({ summary: "s", beats: ["b"], ...(time ? { scene: { time } } : {}), ...(storyDay ? { storyDay } : {}) }, { chapter: 10 })!;
    expect(reconcileStoryDay(make("上午", 9), 1, 12).storyDay).toBe(13);
    expect(reconcileStoryDay(make("紧接第5章次日", 6), undefined, 6).storyDay).toBe(7);
    expect(reconcileStoryDay(make("三天后傍晚"), undefined, 12).storyDay).toBe(15);
    expect(reconcileStoryDay(make("紧接上一章结尾，傍晚", 5), undefined, 4).storyDay).toBe(4);
    expect(reconcileStoryDay(make("清晨", 20), undefined, 12).storyDay).toBe(20);
    expect(reconcileStoryDay(make("清晨", 3), undefined, 12).storyDay).toBe(12);
    expect(reconcileStoryDay(make("清晨"), undefined, 12).storyDay).toBe(12);
    expect(reconcileStoryDay(make("次日"), undefined, undefined).storyDay).toBeUndefined();
    expect(readDayOffset({ dayOffset: 2 })).toBe(2);
    expect(readDayOffset({ dayOffset: "1天" })).toBe(1);
    expect(readDayOffset({ dayOffset: "第二天" })).toBe(1);
    expect(readDayOffset({ dayOffset: "同一天" })).toBe(0);
    expect(readDayOffset({ dayOffset: "" })).toBeUndefined();
    expect(readDayOffset({})).toBeUndefined();
  });
});

describe("骨架章纲重拟（第二十轮第 5、7 章只有要点，日历少记一天）", () => {
  it("人物/开场/新信息全空 → 重拟一次用完整的；两次都是骨架就用骨架，不判失败", async () => {
    const dir = await mkdtemp(join(tmpdir(), "se-plan-skeleton-"));
    await mkdir(join(dir, "story"), { recursive: true });
    const skeleton = JSON.stringify({ summary: "林舟去档案馆", beats: ["去档案馆", "查到底册"] });
    const full = JSON.stringify({ summary: "林舟去档案馆", beats: ["去档案馆", "查到底册"], characters: ["林舟"], scene: { time: "第二天上午" }, dayOffset: 1 });
    const retried = vi.fn().mockResolvedValueOnce(skeleton).mockResolvedValueOnce(full);
    const ok = await planChapter({ projectDir: dir, chapter: 3, callModel: retried });
    expect(retried).toHaveBeenCalledTimes(2);
    expect(ok.ok && ok.plan.characters).toEqual(["林舟"]);
    const stubborn = vi.fn(async () => skeleton);
    const still = await planChapter({ projectDir: dir, chapter: 3, callModel: stubborn });
    expect(still.ok && still.plan.summary).toBe("林舟去档案馆");
  });
});

describe("storyDayAtChapterEnd（第二十一轮第 2 章跨夜没记，此后全书少一天）", () => {
  it("开场那天加上要点开头写明的换天；转述里的「约好第二天」不算", async () => {
    const { storyDayAtChapterEnd } = await import("./plan-chapter.js");
    const make = (beats: string[]) => normalizeChapterPlan({ summary: "s", beats, storyDay: 2 }, { chapter: 2 })!;
    expect(storyDayAtChapterEnd(make(["傍晚回铺子", "第二天上午，许棠上门"]))).toBe(3);
    expect(storyDayAtChapterEnd(make(["傍晚回铺子", "三天后，林溪来了"]))).toBe(5);
    expect(storyDayAtChapterEnd(make(["许棠约好第二天来量铺子", "林舟关门"]))).toBe(2);
    expect(storyDayAtChapterEnd(make(["第二天上午，林舟开门", "傍晚关门"]))).toBe(2);
    expect(storyDayAtChapterEnd(undefined)).toBeUndefined();
  });
});

// ---------- 章纲员路（编辑部第 3 步，STORY_PLANNER=reader） ----------

const READER_PLAN = JSON.stringify({
  summary: "林澈去档案室对出缺页",
  beats: ["一早去档案室", "管理员拦人", "对出缺页是一笔境外汇款"],
  newInformation: ["缺页记的是一笔境外汇款"],
  scene: { location: "档案室", time: "第二天上午" },
  characters: ["林澈"],
  entities: ["蓝色账册", "档案室"],
  threadsAdvanced: [{ title: "账册第三页被谁撕掉了", how: "对出缺页内容" }],
  avoid: [],
});

/** 假章纲员（BrainCallModel）：json:false 写笔记；json:true 按消息内容区分拟纲 / 改纲，回 planReplies 里的下一个。 */
function fakePlannerCallModel(planReplies: (string | Error)[] = [READER_PLAN]) {
  const calls: { readonly json: boolean; readonly task: string }[] = [];
  let used = 0;
  const callModel: BrainCallModel = async (messages, options) => {
    const task = messages.at(-1)!.content;
    calls.push({ json: options.json, task });
    if (!options.json) return `第${/第 (\d+) 章/u.exec(task)?.[1] ?? "?"}章笔记`;
    const reply = planReplies[Math.min(used, planReplies.length - 1)]!;
    used += 1;
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { callModel, calls };
}

/** 假核账员审章纲：回 problems（earlierQuote 得真在第 1 章正文里才留得下）。 */
const fakePlanCheckCallModel = (reply: string): BrainCallModel & { readonly calls: number[] } => {
  let jsonCalls = 0;
  const calls: number[] = [];
  const callModel: BrainCallModel = async (messages, options) => {
    if (!options.json) return `第${/第 (\d+) 章/u.exec(messages.at(-1)!.content)?.[1] ?? "?"}章笔记`;
    jsonCalls += 1;
    calls.push(jsonCalls);
    return reply;
  };
  return Object.assign(callModel, { calls });
};

describe("resolveChapterPlanForDraft：章纲员路", () => {
  beforeEach(() => {
    vi.stubEnv("STORY_PLANNER", "reader");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("拟 → 核账员审 → 没问题直接用；沿用已有章纲的规则不变", async () => {
    const projectDir = await makeBook();
    const planner = fakePlannerCallModel();
    const checker = fakePlanCheckCallModel(JSON.stringify({ problems: [] }));
    const legacy = vi.fn(async () => GOOD_PLAN);
    const first = await resolveChapterPlanForDraft({
      projectDir, chapter: 2, callModel: legacy, plannerCallModel: planner.callModel, planCheckReaderCallModel: checker,
    });
    expect(first.reused).toBe(false);
    expect(first.plan?.summary).toBe("林澈去档案室对出缺页");
    expect(first.note).not.toContain("旧路");
    // 旧路没被调；章纲员 1 次拟纲 + 2 次笔记；核账员 1 次审纲 + 2 次笔记。
    expect(legacy).not.toHaveBeenCalled();
    expect(planner.calls.filter((call) => call.json)).toHaveLength(1);
    expect(checker.calls).toEqual([1]);
    const again = await resolveChapterPlanForDraft({
      projectDir, chapter: 2, callModel: legacy, plannerCallModel: planner.callModel, planCheckReaderCallModel: checker,
    });
    expect(again.reused).toBe(true);
    expect(planner.calls.filter((call) => call.json)).toHaveLength(1);
  });

  it("审出问题 → 交回章纲员改一轮（不循环），落盘的是改过的章纲", async () => {
    const projectDir = await makeBook();
    const fixed = JSON.stringify({
      ...JSON.parse(READER_PLAN),
      beats: ["一早去档案室", "管理员拦人", "对出缺页是一笔境外汇款", "林澈把缺页拍照留证"],
    });
    const planner = fakePlannerCallModel([READER_PLAN, fixed]);
    const checker = fakePlanCheckCallModel(JSON.stringify({
      problems: [{ point: 3, earlierQuote: "林澈把蓝色账册锁进抽屉，决定明天去档案室。", earlierChapter: 1, reason: "缺页那笔在第 1 章已对出" }],
    }));
    const result = await resolveChapterPlanForDraft({
      projectDir, chapter: 2, callModel: vi.fn(async () => GOOD_PLAN), plannerCallModel: planner.callModel, planCheckReaderCallModel: checker,
    });
    expect(result.plan?.beats).toHaveLength(4);
    expect(result.note).toContain("核账员审出 1 处");
    expect((await readChapterPlan(projectDir, 2))?.beats).toHaveLength(4);
  });

  it("章纲员要补的笔记太多 → 这次走旧路拟纲 + 审校，note 里说清楚", async () => {
    // 12 章都没笔记、maxCatchUp 是 10 → not_ready，这次走旧路。
    const projectDir = await makeBook();
    for (let n = 2; n <= 12; n += 1) {
      await writeFile(join(projectDir, "chapters", `${String(n).padStart(4, "0")}.md`), `# 第${n}章\n\n第${n}章各自推进。\n`, "utf-8");
    }
    const planner = fakePlannerCallModel();
    const result = await resolveChapterPlanForDraft({
      projectDir, chapter: 13, callModel: vi.fn(async () => GOOD_PLAN), plannerCallModel: planner.callModel, planCheckReaderCallModel: fakePlanCheckCallModel("{}"),
    });
    expect(result.reused).toBe(false);
    expect(result.note).toContain("章纲员还在读前文，这次用的是旧路拟纲");
    expect(result.plan?.summary).toBe("林澈去档案室对出缺页");
    // 这次没有让章纲员拟纲（后台补笔记不算拟纲）。
    expect(planner.calls.filter((call) => call.json)).toHaveLength(0);
  });

  it("章纲员拟不成 → 没有章纲 + 如实说明照常出稿", async () => {
    const projectDir = await makeBook();
    const planner = fakePlannerCallModel([new Error("网关挂了"), new Error("还是挂")]);
    const result = await resolveChapterPlanForDraft({
      projectDir, chapter: 2, callModel: vi.fn(async () => GOOD_PLAN), plannerCallModel: planner.callModel, planCheckReaderCallModel: fakePlanCheckCallModel("{}"),
    });
    expect(result.plan).toBeUndefined();
    expect(result.note).toContain("这次按没有章纲出稿");
  });

  it("显式设 legacy → 走旧路，不碰章纲员（回退排查用，R3 删）", async () => {
    vi.stubEnv("STORY_PLANNER", "legacy");
    const projectDir = await makeBook();
    const planner = fakePlannerCallModel();
    const result = await resolveChapterPlanForDraft({
      projectDir, chapter: 2, callModel: vi.fn(async () => GOOD_PLAN), plannerCallModel: planner.callModel, planCheckReaderCallModel: fakePlanCheckCallModel("{}"),
    });
    expect(result.plan?.summary).toBe("林澈去档案室对出缺页");
    expect(planner.calls).toHaveLength(0);
  });
});
