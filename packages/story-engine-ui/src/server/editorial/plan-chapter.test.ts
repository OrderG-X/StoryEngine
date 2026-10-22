// @vitest-environment node
// R3 删旧拟纲路后，这里测章纲员复用的纯函数：材料收集（collectPlanMaterials / planMaterialBlocks）、
// 天数归一（reconcileStoryDay / storyDayAtChapterEnd）、骨架章纲判定。编排（章纲员拟 → 核账员审 → 改一轮）
// 见 resolveChapterPlanForDraft 的用例和 editorial/planner.test.ts。
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cardWrite, chapterCommit, runCommand } from "@actalk/story-core";
import { createStoryProject } from "../book/project-store.js";
import { normalizeChapterPlan, readChapterPlan, writeChapterPlan } from "../book/chapter-plan.js";
import { describe, expect, it } from "vitest";
import type { BrainCallModel } from "./reader-window.js";
import { collectPlanMaterials, planMaterialBlocks } from "./plan-materials.js";

async function makeBook(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "se-plan-chapter-"));
  const { projectDir } = await createStoryProject({
    rootDir, title: "海州账册", genre: "urban", logline: "审计员林澈追查账册篡改。", protagonistName: "林澈",
  });
  await mkdir(join(projectDir, "chapters"), { recursive: true });
  await writeFile(join(projectDir, "chapters", "0001.md"), "# 第1章 · 账册\n\n林澈把蓝色账册锁进抽屉，决定明天去档案室。\n", "utf-8");
  // 老格式镜像文件（线索、硬事实）：建书不再建 story/，要写自己建（P9）。
  await mkdir(join(projectDir, "story"), { recursive: true });
  await writeFile(join(projectDir, "story", "threads.json"), JSON.stringify({
    threads: [
      { id: "lead-1", type: "lead", title: "账册第三页被谁撕掉了…", status: "open", firstSeenChapter: 1, lastTouchedChapter: 1, evidence: ["账册第三页被谁撕掉了，撕口很新"] },
      { id: "lead-2", type: "lead", title: "已经收口的旧事", status: "done", firstSeenChapter: 1, lastTouchedChapter: 1, evidence: [] },
    ],
  }), "utf-8");
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
    const blocks = planMaterialBlocks(5, materials).join("\n\n");
    expect(blocks).toContain("【前几章的时间】");
    expect(blocks).toContain("【已确立事实（不能矛盾，做过的别再做）】");
  });
});

describe("reconcileStoryDay：天数由程序按上一章往后加（第十九轮模型数错第 4、7 章）", () => {
  it("dayOffset 优先；没有就看开场时间；都没有用模型天数但不许倒退；全没有当同一天", async () => {
    const { reconcileStoryDay, readDayOffset } = await import("./plan-materials.js");
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
    expect((await readChapterPlan(dir, 3))?.summary).toBe("林舟去档案馆");
  });
});

describe("storyDayAtChapterEnd（第二十一轮第 2 章跨夜没记，此后全书少一天）", () => {
  it("开场那天加上要点开头写明的换天；转述里的「约好第二天」不算", async () => {
    const { storyDayAtChapterEnd } = await import("./plan-materials.js");
    const make = (beats: string[]) => normalizeChapterPlan({ summary: "s", beats, storyDay: 2 }, { chapter: 2 })!;
    expect(storyDayAtChapterEnd(make(["傍晚回铺子", "第二天上午，许棠上门"]))).toBe(3);
    expect(storyDayAtChapterEnd(make(["傍晚回铺子", "三天后，林溪来了"]))).toBe(5);
    expect(storyDayAtChapterEnd(make(["许棠约好第二天来量铺子", "林舟关门"]))).toBe(2);
    expect(storyDayAtChapterEnd(make(["第二天上午，林舟开门", "傍晚关门"]))).toBe(2);
    expect(storyDayAtChapterEnd(undefined)).toBeUndefined();
  });
});

// ---------- 出稿前的章纲编排：章纲员拟 → 核账员审 → 改一轮（R3 后唯一一条路） ----------

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

describe("resolveChapterPlanForDraft：编辑部编排", () => {
  it("拟 → 核账员审 → 没问题直接用；同一方向重写沿用已有章纲，方向变了重拟", async () => {
    const { resolveChapterPlanForDraft } = await import("./plan-chapter.js");
    const projectDir = await makeBook();
    const planner = fakePlannerCallModel();
    const checker = fakePlanCheckCallModel(JSON.stringify({ problems: [] }));
    const first = await resolveChapterPlanForDraft({
      projectDir, chapter: 2, plannerCallModel: planner.callModel, planCheckReaderCallModel: checker,
    });
    expect(first.reused).toBe(false);
    expect(first.plan?.summary).toBe("林澈去档案室对出缺页");
    // 章纲员 1 次拟纲 + 2 次笔记；核账员 1 次审纲 + 2 次笔记。
    expect(planner.calls.filter((call) => call.json)).toHaveLength(1);
    expect(checker.calls).toEqual([1]);
    const again = await resolveChapterPlanForDraft({
      projectDir, chapter: 2, plannerCallModel: planner.callModel, planCheckReaderCallModel: checker,
    });
    expect(again.reused).toBe(true);
    expect(planner.calls.filter((call) => call.json)).toHaveLength(1);
    const redirected = await resolveChapterPlanForDraft({
      projectDir, chapter: 2, direction: "改成去银行", plannerCallModel: planner.callModel, planCheckReaderCallModel: checker,
    });
    expect(redirected.reused).toBe(false);
    expect((await readChapterPlan(projectDir, 2))?.direction).toBe("改成去银行");
  });

  it("审出问题 → 交回章纲员改一轮（不循环），落盘的是改过的章纲", async () => {
    const { resolveChapterPlanForDraft } = await import("./plan-chapter.js");
    const projectDir = await makeBook();
    const fixed = JSON.stringify({ revised: [{ point: 3, beat: "对出缺页是一笔境外汇款，和第 1 章的记录对上" }] });
    const planner = fakePlannerCallModel([READER_PLAN, fixed]);
    const checker = fakePlanCheckCallModel(JSON.stringify({
      problems: [{ point: 3, conflict: true, authorWilled: false, earlierQuote: "林澈把蓝色账册锁进抽屉，决定明天去档案室。", earlierChapter: 1, reason: "缺页那笔在第 1 章已对出" }],
    }));
    const result = await resolveChapterPlanForDraft({
      projectDir, chapter: 2, plannerCallModel: planner.callModel, planCheckReaderCallModel: checker,
    });
    expect(result.plan?.beats).toHaveLength(3);
    expect(result.plan?.beats[2]).toBe("对出缺页是一笔境外汇款，和第 1 章的记录对上");
    expect(result.note).toContain("核账员审出 1 处");
    expect(result.note).toContain("改掉 1 处");
    expect((await readChapterPlan(projectDir, 2))?.beats[2]).toBe("对出缺页是一笔境外汇款，和第 1 章的记录对上");
  });

  it("R7.5 作者方向和前文冲突（authorWilled）→ 不自动改、不叫改纲，回执问作者以哪个为准、照原要点出稿", async () => {
    const { resolveChapterPlanForDraft } = await import("./plan-chapter.js");
    const projectDir = await makeBook();
    const planner = fakePlannerCallModel([READER_PLAN]);
    const checker = fakePlanCheckCallModel(JSON.stringify({
      problems: [{ point: 1, conflict: true, authorWilled: true, directionQuote: "当天就去档案室", earlierQuote: "林澈把蓝色账册锁进抽屉，决定明天去档案室。", earlierChapter: 1, reason: "作者方向要当天去，但账册第 1 章已锁进抽屉" }],
    }));
    const result = await resolveChapterPlanForDraft({
      projectDir, chapter: 2, direction: "当天就去档案室", plannerCallModel: planner.callModel, planCheckReaderCallModel: checker,
    });
    // 没叫改纲（只有拟纲那一次 json 调用），要点原样保留。
    expect(planner.calls.filter((call) => call.json)).toHaveLength(1);
    expect(result.plan?.beats).toEqual(JSON.parse(READER_PLAN).beats);
    expect(result.note).toContain("都来自你给的方向");
    expect(result.note).toContain("以哪个为准");
    expect(result.note).toContain("这次先照你的方向出稿");
    expect(result.note).toContain("你给的方向里「当天就去档案室」");
  });

  it("P7 审纲把章纲员自己展开的细节标成作者方向、却抄不出方向原话 → 当章纲员拟错交回去改，不反问作者", async () => {
    const { resolveChapterPlanForDraft } = await import("./plan-chapter.js");
    const projectDir = await makeBook();
    const fixed = JSON.stringify({ revised: [{ point: 3, beat: "对出缺页是一笔境外汇款，和第 1 章的记录对上" }] });
    const planner = fakePlannerCallModel([READER_PLAN, fixed]);
    const checker = fakePlanCheckCallModel(JSON.stringify({
      problems: [{ point: 3, conflict: true, authorWilled: true, directionQuote: "当晚把账册烧了", earlierQuote: "林澈把蓝色账册锁进抽屉，决定明天去档案室。", earlierChapter: 1, reason: "缺页那笔在第 1 章已对出" }],
    }));
    const result = await resolveChapterPlanForDraft({
      projectDir, chapter: 2, direction: "一早去档案室", plannerCallModel: planner.callModel, planCheckReaderCallModel: checker,
    });
    expect(planner.calls.filter((call) => call.json)).toHaveLength(2);
    expect(result.plan?.beats[2]).toBe("对出缺页是一笔境外汇款，和第 1 章的记录对上");
    expect(result.note).toContain("改掉 1 处");
    expect(result.note).not.toContain("你给的方向");
  });

  it("R7.5 混合：章纲员自己的错照改，作者方向的另报一条问作者", async () => {
    const { resolveChapterPlanForDraft } = await import("./plan-chapter.js");
    const projectDir = await makeBook();
    const fixed = JSON.stringify({ revised: [{ point: 3, beat: "对出缺页是一笔境外汇款，和第 1 章的记录对上" }] });
    const planner = fakePlannerCallModel([READER_PLAN, fixed]);
    const checker = fakePlanCheckCallModel(JSON.stringify({
      problems: [
        { point: 3, conflict: true, authorWilled: false, earlierQuote: "林澈把蓝色账册锁进抽屉，决定明天去档案室。", earlierChapter: 1, reason: "缺页那笔在第 1 章已对出" },
        { point: 1, conflict: true, authorWilled: true, directionQuote: "一早去档案室", earlierQuote: "林澈把蓝色账册锁进抽屉，决定明天去档案室。", earlierChapter: 1, reason: "作者方向要一早去，第 1 章写的是明天" },
      ],
    }));
    const result = await resolveChapterPlanForDraft({
      projectDir, chapter: 2, direction: "一早去档案室", plannerCallModel: planner.callModel, planCheckReaderCallModel: checker,
    });
    // 改纲只收到非 authorWilled 的那条（point 3）；作者那条（point 1）保留原样。
    const reviseTaskText = planner.calls.filter((call) => call.json)[1]?.task ?? "";
    expect(reviseTaskText).toContain("第 3 条要点");
    expect(reviseTaskText).not.toContain("第 1 条要点");
    expect(result.plan?.beats[0]).toBe("一早去档案室");
    expect(result.plan?.beats[2]).toBe("对出缺页是一笔境外汇款，和第 1 章的记录对上");
    expect(result.note).toContain("改掉 1 处");
    expect(result.note).toContain("另有 1 处来自你给的方向");
    expect(result.note).toContain("以哪个为准");
  });

  it("P7 章纲员改了作者方向要声明：原话核得上的进回执告诉作者、落盘带着；编的原话丢掉；同一方向沿用时照样说", async () => {
    const { resolveChapterPlanForDraft } = await import("./plan-chapter.js");
    const projectDir = await makeBook();
    const changed = JSON.stringify({
      ...JSON.parse(READER_PLAN),
      beats: ["一早去档案室，带上复印件", "管理员拦人", "对出缺页是一笔境外汇款"],
      directionChanges: [
        { said: "带上蓝色账册", changedTo: "带上账册的复印件", why: "第 1 章账册已经锁进抽屉、钥匙不在他身上" },
        { said: "作者根本没说过这句", changedTo: "随便改的", why: "编的" },
      ],
    });
    const planner = fakePlannerCallModel([changed]);
    const checker = fakePlanCheckCallModel(JSON.stringify({ problems: [] }));
    const result = await resolveChapterPlanForDraft({
      projectDir, chapter: 2, direction: "一早带上蓝色账册去档案室", plannerCallModel: planner.callModel, planCheckReaderCallModel: checker,
    });
    expect(result.plan?.directionChanges).toEqual([{ said: "带上蓝色账册", changedTo: "带上账册的复印件", why: "第 1 章账册已经锁进抽屉、钥匙不在他身上" }]);
    expect(result.note).toContain("你给的方向里「带上蓝色账册」和前文对不上：第 1 章账册已经锁进抽屉、钥匙不在他身上。章纲改成了「带上账册的复印件」；要照你原话写就说一声。");
    expect(result.note).not.toContain("编的");
    expect((await readChapterPlan(projectDir, 2))?.directionChanges).toHaveLength(1);
    const again = await resolveChapterPlanForDraft({
      projectDir, chapter: 2, direction: "一早带上蓝色账册去档案室", plannerCallModel: planner.callModel, planCheckReaderCallModel: checker,
    });
    expect(again.reused).toBe(true);
    expect(again.note).toContain("章纲改成了「带上账册的复印件」");
  });

  it("P7 章纲员已声明改掉的方向原话，审纲再报成「作者方向和前文对不上」→ 不再反问（回执只说改成了什么）", async () => {
    const { resolveChapterPlanForDraft } = await import("./plan-chapter.js");
    const projectDir = await makeBook();
    const changed = JSON.stringify({
      ...JSON.parse(READER_PLAN),
      directionChanges: [{ said: "带上蓝色账册", changedTo: "带上账册的复印件", why: "账册第 1 章已锁进抽屉。" }],
    });
    const checker = fakePlanCheckCallModel(JSON.stringify({
      problems: [{ point: 1, conflict: true, authorWilled: true, directionQuote: "一早带上蓝色账册", earlierQuote: "林澈把蓝色账册锁进抽屉，决定明天去档案室。", earlierChapter: 1, reason: "账册已锁进抽屉" }],
    }));
    const result = await resolveChapterPlanForDraft({
      projectDir, chapter: 2, direction: "一早带上蓝色账册去档案室", plannerCallModel: fakePlannerCallModel([changed]).callModel, planCheckReaderCallModel: checker,
    });
    expect(result.note).not.toContain("以哪个为准");
    expect(result.note).not.toContain("核账员审出");
    expect(result.note).toContain("和前文对不上：账册第 1 章已锁进抽屉。章纲改成了「带上账册的复印件」");
  });

  it("没给方向时章纲员声明的「改了方向」一条不收", async () => {
    const { resolveChapterPlanForDraft } = await import("./plan-chapter.js");
    const projectDir = await makeBook();
    const changed = JSON.stringify({ ...JSON.parse(READER_PLAN), directionChanges: [{ said: "一早去档案室", changedTo: "下午去", why: "上午闭馆" }] });
    const result = await resolveChapterPlanForDraft({
      projectDir, chapter: 2, plannerCallModel: fakePlannerCallModel([changed]).callModel, planCheckReaderCallModel: fakePlanCheckCallModel(JSON.stringify({ problems: [] })),
    });
    expect(result.plan?.directionChanges).toBeUndefined();
    expect(result.note).not.toContain("你给的方向");
  });

  it("作者没给方向（写下一章）→ 模型标的 authorWilled 不作数，照章纲员的错改，回执不说「来自你给的方向」", async () => {
    const { resolveChapterPlanForDraft } = await import("./plan-chapter.js");
    const projectDir = await makeBook();
    const fixed = JSON.stringify({ revised: [{ point: 1, beat: "第二天去档案室" }] });
    const planner = fakePlannerCallModel([READER_PLAN, fixed]);
    const checker = fakePlanCheckCallModel(JSON.stringify({
      problems: [{ point: 1, conflict: true, authorWilled: true, earlierQuote: "林澈把蓝色账册锁进抽屉，决定明天去档案室。", earlierChapter: 1, reason: "第 1 章写的是明天去" }],
    }));
    const result = await resolveChapterPlanForDraft({
      projectDir, chapter: 2, plannerCallModel: planner.callModel, planCheckReaderCallModel: checker,
    });
    expect(planner.calls.filter((call) => call.json)).toHaveLength(2);
    expect(result.plan?.beats[0]).toBe("第二天去档案室");
    expect(result.note).toContain("改掉 1 处");
    expect(result.note).not.toContain("你给的方向");
  });

  it("章纲员要补的笔记太多 → 冷窗口照拟照审，note 如实标对照范围（不再「按没有章纲出稿」）", async () => {
    const { resolveChapterPlanForDraft } = await import("./plan-chapter.js");
    // 12 章都没笔记、maxCatchUp 是 10 → 冷窗口（已有笔记 0 章 + 最近 8 章原文）。
    const projectDir = await makeBook();
    for (let n = 2; n <= 12; n += 1) {
      await writeFile(join(projectDir, "chapters", `${String(n).padStart(4, "0")}.md`), `# 第${n}章\n\n第${n}章各自推进。\n`, "utf-8");
    }
    const planner = fakePlannerCallModel();
    const checker = fakePlanCheckCallModel("{}");
    const result = await resolveChapterPlanForDraft({
      projectDir, chapter: 13, plannerCallModel: planner.callModel, planCheckReaderCallModel: checker,
    });
    expect(result.reused).toBe(false);
    expect(result.plan?.summary).toBe("林澈去档案室对出缺页");
    expect(result.note).toContain("章纲员还没读完全书（第 0 / 12 章）");
    expect(result.note).toContain("这次按第 5～12 章原文拟的纲");
    expect(result.note).toContain("核账员还没读完全书（第 0 / 12 章）");
    expect(result.note).toContain("这次按第 5～12 章原文审的纲");
    // 拟了纲、也审了纲（不是空手出稿）。
    expect(planner.calls.filter((call) => call.json)).toHaveLength(1);
    expect(checker.calls).toEqual([1]);
  });

  it("核账员还没读完前文 → 冷窗口照审（note 如实标），章纲照用", async () => {
    const { resolveChapterPlanForDraft } = await import("./plan-chapter.js");
    const { rm } = await import("node:fs/promises");
    const projectDir = await makeBook();
    for (let n = 2; n <= 11; n += 1) {
      await writeFile(join(projectDir, "chapters", `${String(n).padStart(4, "0")}.md`), `# 第${n}章\n\n第${n}章各自推进。\n`, "utf-8");
    }
    const planner = fakePlannerCallModel();
    const checker = fakePlanCheckCallModel("{}");
    // 第一轮（第 11 章）：两个角色当场补齐各自的 10 份笔记。
    await resolveChapterPlanForDraft({ projectDir, chapter: 11, plannerCallModel: planner.callModel, planCheckReaderCallModel: checker });
    // 删掉核账员的全部笔记、再往书里加 1 章：下一轮章纲员只缺 2 份（缺得少仍当场补读，R5.2），
    // 核账员缺 12 份（超过 10）→ not_ready。
    await rm(join(projectDir, "agents", "checker", "notes"), { recursive: true, force: true });
    await writeFile(join(projectDir, "chapters", "0012.md"), "# 第12章\n\n第12章各自推进。\n", "utf-8");
    const result = await resolveChapterPlanForDraft({
      projectDir, chapter: 13, plannerCallModel: planner.callModel, planCheckReaderCallModel: checker,
    });
    expect(result.plan?.summary).toBe("林澈去档案室对出缺页");
    // 章纲员只缺 2 份（当场补齐、正常拟），note 如实说等过它（R5.2 必做 2）；
    expect(result.note).toContain("这次先等章纲员读完第 11～12 章再拟纲");
    expect(result.note).toContain("再拟纲");
    // 核账员缺 12 份 → 冷窗口审（已有笔记 0 章 + 第 5～12 章原文），缺口没被原文补全、老措辞照说。
    expect(result.note).toContain("核账员还没读完全书（第 0 / 12 章）");
    expect(result.note).toContain("这次按第 5～12 章原文审的纲");
    expect(result.note).not.toContain("这次没审章纲");
  });

  it("章纲员拟不成 → 没有章纲 + 如实说明照常出稿", async () => {
    const { resolveChapterPlanForDraft } = await import("./plan-chapter.js");
    const projectDir = await makeBook();
    const planner = fakePlannerCallModel([new Error("网关挂了"), new Error("还是挂")]);
    const result = await resolveChapterPlanForDraft({
      projectDir, chapter: 2, plannerCallModel: planner.callModel, planCheckReaderCallModel: fakePlanCheckCallModel("{}"),
    });
    expect(result.plan).toBeUndefined();
    expect(result.note).toContain("这次按没有章纲出稿");
  });
});
