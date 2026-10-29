// @vitest-environment node
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cardWrite, runCommand, type CardOp } from "@actalk/story-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeChapterPlan, readChapterPlan } from "../book/chapter-plan.js";
import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import { readReadersCatchUpStatus } from "./catch-up.js";
import { readerWaitingHandlers } from "./reader-progress.js";
import { ensureReaderWindow } from "./reader-window.js";
import {
  callConfiguredPlannerModel,
  PLANNER_ROLE,
  planChapterByPlanner,
  plannerTask,
  revisePlanByPlanner,
  reviseTask,
} from "./planner.js";
import { planCheckTask, parsePlanProblems, type PlanProblem } from "./checker.js";
import { collectPlanMaterials } from "./plan-materials.js";
import type { BrainCallModel, BrainMessage } from "./reader-window.js";

const llmMocks = vi.hoisted(() => ({
  resolveConfiguredChatModel: vi.fn(),
  streamChatModelToText: vi.fn(),
}));
vi.mock("../lib/llm-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/llm-client.js")>()),
  ...llmMocks,
}));

const CH1 = "许棠把那封信锁进抽屉，说明天一早去邮局。";
const CH2 = "第二天许棠去了邮局，把信寄给了林溪。林溪下午回电说收到了。";

async function makeBook(): Promise<string> {
  const dir = await makeHomeTempDir("planner-");
  await mkdir(join(dir, "chapters"), { recursive: true });
  await writeFile(join(dir, "chapters", "0001.md"), `# 第1章\n\n${CH1}\n`, "utf-8");
  await writeFile(join(dir, "chapters", "0002.md"), `# 第2章\n\n${CH2}\n`, "utf-8");
  // 时间线：第 1 章是故事第 2 天 → 拟第 3 章 dayOffset=1 时应归一到第 3 天。
  await mkdir(join(dir, "story"), { recursive: true });
  await writeFile(join(dir, "story", "timeline.json"), JSON.stringify({
    schemaVersion: 1,
    entries: [{ chapter: 1, day: 2, source: "declared", quote: "明天一早去邮局" }],
  }), "utf-8");
  return dir;
}

const PLAN_JSON = JSON.stringify({
  summary: "许棠等林溪的回信",
  beats: ["许棠在铺子里等信", "邮差送来林溪的回信", "信里约好周末见面"],
  newInformation: ["林溪约好周末见面"],
  scene: { location: "铺子", time: "第二天上午" },
  dayOffset: 1,
  characters: ["许棠", "林溪"],
  entities: ["回信"],
  threadsAdvanced: [],
  avoid: [],
});

/** 假章纲员：json:false 写笔记；json:true 按调用次序回章纲 JSON（可以抛错）。 */
function fakePlanner(replies: (string | Error)[] = [PLAN_JSON]) {
  const calls: { readonly messages: readonly BrainMessage[]; readonly json: boolean }[] = [];
  let jsonCalls = 0;
  const callModel: BrainCallModel = async (messages, options) => {
    calls.push({ messages: [...messages], json: options.json });
    if (!options.json) return `第${/第 (\d+) 章/u.exec(messages.at(-1)!.content)?.[1]}章笔记`;
    const reply = replies[Math.min(jsonCalls, replies.length - 1)]!;
    jsonCalls += 1;
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { callModel, calls, jsonCalls: () => jsonCalls };
}

describe("章纲员：拟章纲", () => {
  it("调用 = 读完 N-1 章的窗口（原文 + 笔记）+ 任务消息（json:true）；任务里有方向、有和旧路同一份的章纲要求", async () => {
    const dir = await makeBook();
    const { callModel, calls } = fakePlanner();
    const result = await planChapterByPlanner({ projectDir: dir, chapter: 3, direction: "许棠收到回信", callModel });
    expect(result.ok).toBe(true);
    const planCalls = calls.filter((call) => call.json);
    expect(planCalls).toHaveLength(1);
    const messages = planCalls[0]!.messages;
    expect(messages[0]).toEqual({ role: "system", content: PLANNER_ROLE.system });
    expect(messages[1]!.content).toBe(`【第 1 章 定稿原文】\n${CH1}\n\n${PLANNER_ROLE.noteTask}`);
    expect(messages[2]).toEqual({ role: "assistant", content: "第1章笔记" });
    expect(messages).toHaveLength(6); // system + 两章各两条 + 任务
    const task = messages.at(-1)!.content;
    expect(task).toContain("你已经从第 1 章跟读到了第 2 章");
    expect(task).toContain("【作者这章的方向】许棠收到回信");
    expect(task).toContain("1. 紧接上一章结尾");
    expect(task).toContain("JSON 字段：");
    expect(task).toContain("threadsAdvanced");
    // 章纲员读过全书：任务里不再带「上一章正文」块。
    expect(task).not.toContain("【上一章");
  });

  it("拟成落盘，天数照旧路归一（timeline 第 1 章=第 2 天、dayOffset 1 → 第 3 天）", async () => {
    const dir = await makeBook();
    const { callModel } = fakePlanner();
    const result = await planChapterByPlanner({ projectDir: dir, chapter: 3, callModel });
    expect(result.ok && result.plan.storyDay).toBe(3);
    expect((await readChapterPlan(dir, 3))?.summary).toBe("许棠等林溪的回信");
  });

  it("第一次不是 JSON 自动重试一次；两次都败 → ok:false + 原因，不落盘", async () => {
    const recovered = await planChapterByPlanner({ projectDir: await makeBook(), chapter: 3, callModel: fakePlanner([new Error("网关 502"), PLAN_JSON]).callModel });
    expect(recovered.ok).toBe(true);
    const failedDir = await makeBook();
    const failed = await planChapterByPlanner({ projectDir: failedDir, chapter: 3, callModel: fakePlanner([new Error("网关 502"), new Error("还是 502")]).callModel });
    expect(failed).toEqual({ ok: false, reason: expect.stringContaining("章纲没拟成（已自动重试一次）") });
    expect(await readChapterPlan(failedDir, 3)).toBeUndefined();
  });

  it("要补的笔记太多（超过 maxCatchUp）→ 冷窗口照拟：最近 K 章原文进窗口、cold 说清范围、一个笔记都不写", async () => {
    const dir = await makeBook();
    const { callModel, calls } = fakePlanner();
    const result = await planChapterByPlanner({ projectDir: dir, chapter: 3, callModel, maxCatchUp: 1 });
    expect(result.ok).toBe(true);
    expect(result.ok === true && result.cold).toEqual({ notedThrough: 0, rawFrom: 1, rawTo: 2 });
    expect(result.ok === true && result.plan.summary).toBe("许棠等林溪的回信");
    const jsonCalls = calls.filter((call) => call.json);
    expect(jsonCalls).toHaveLength(1);
    expect(jsonCalls[0]!.messages[0]).toEqual({ role: "system", content: PLANNER_ROLE.system });
    expect(jsonCalls[0]!.messages[1]!.content).toContain("【第 1～2 章 定稿原文");
    expect(jsonCalls[0]!.messages).toHaveLength(3); // system + 冷窗口原文块 + 任务
    expect(calls.filter((call) => !call.json)).toHaveLength(0);
    expect(await stat(join(dir, "agents")).then(() => true, () => false)).toBe(false); // 冷窗口不落盘
  });

  it("补笔记中途失败 → ok:false 如实说读前文没成（不是 not_ready）；已写的笔记留着", async () => {
    const dir = await makeBook();
    const callModel: BrainCallModel = async () => { throw new Error("限流了"); };
    const result = await planChapterByPlanner({ projectDir: dir, chapter: 3, callModel });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("章纲员读前文没成：限流了");
  });

  it("排在后台补读后面等（R6.1 新发现 1）→ 也算等过：等待中进度行标「拟纲在等它读完」，waited 覆盖补上的章", async () => {
    const dir = await makeBook();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started = false;
    // 别人补读的假模型：第一次调用（写第 1 章笔记）就卡住，把章纲员的锁拿在手里（带上进度回调，进度行看得到它在读）。
    const bg: BrainCallModel = async () => { started = true; await gate; return "笔记"; };
    const bgRound = ensureReaderWindow({ projectDir: dir, role: PLANNER_ROLE, upTo: 2, callModel: bg, ...readerWaitingHandlers(dir, PLANNER_ROLE.id, 2) });
    await vi.waitFor(() => expect(started).toBe(true), { timeout: 5_000 });
    // 并发拟纲（第 3 章）：开口时一章笔记都还没有（waited.from=1），排在锁后面等。
    const { callModel } = fakePlanner();
    const resultPromise = planChapterByPlanner({ projectDir: dir, chapter: 3, callModel });
    await vi.waitFor(async () => {
      expect((await readReadersCatchUpStatus(dir)).roles.find((role) => role.role === "planner")).toMatchObject({ reading: true, waiting: "拟纲" });
    }, { timeout: 5_000 });
    release();
    const result = await resultPromise;
    expect(result.ok).toBe(true);
    // 轮到它时笔记已经齐了（一个没补）：等的是谁补的不重要，开口时缺的第 1～2 章等完补上了就算等过。
    expect(result.ok === true && result.waited).toMatchObject({ from: 1, to: 2 });
    // 结束后 waiting 消失。
    expect((await readReadersCatchUpStatus(dir)).roles.find((role) => role.role === "planner")).not.toHaveProperty("waiting");
    await bgRound;
  });

  it("笔记本来就齐 → 没等就不说（R6.1）：不带 waited，进度不标在等", async () => {
    const dir = await makeBook();
    // 先把第 1～2 章笔记补齐（同一角色，哈希对得上），再拟第 3 章。
    await ensureReaderWindow({ projectDir: dir, role: PLANNER_ROLE, upTo: 2, callModel: async () => "笔记" });
    const { callModel } = fakePlanner();
    const result = await planChapterByPlanner({ projectDir: dir, chapter: 3, callModel });
    expect(result.ok).toBe(true);
    expect(result.ok === true && result.waited).toBeUndefined();
    expect((await readReadersCatchUpStatus(dir)).roles.find((role) => role.role === "planner")).not.toHaveProperty("waiting");
  });
});

const BASE_PLAN = normalizeChapterPlan({
  summary: "许棠等林溪的回信",
  beats: ["许棠在铺子里等信", "邮差送来林溪的回信", "信里约好周末见面"],
  newInformation: ["林溪约好周末见面"],
  scene: { location: "铺子", time: "第二天上午" },
  dayOffset: 1,
  characters: ["许棠", "林溪"],
  entities: ["回信"],
  storyDay: 3,
  avoid: ["别再写抽屉"],
}, { chapter: 3 })!;

const PROBLEMS: readonly PlanProblem[] = [
  { point: 1, beat: "许棠在铺子里等信", earlierQuote: "许棠把那封信锁进抽屉", earlierChapter: 1, reason: "信第 1 章已寄出，不在抽屉里" },
];

describe("章纲员：改章纲（一轮，不循环；R7.5 只改被指出的要点，其余由代码照原章纲保留）", () => {
  it("模型只回被改的要点：代码按序号换进去，其余栏（人物/新信息/开场/avoid/天数）逐字保留", async () => {
    const dir = await makeBook();
    // 先把窗口的笔记补上（拟一次），再改。
    await planChapterByPlanner({ projectDir: dir, chapter: 3, callModel: fakePlanner().callModel });
    const revisedJson = JSON.stringify({ revised: [{ point: 1, beat: "许棠在铺子里盘点账目" }], summary: "" });
    const { callModel, calls } = fakePlanner([revisedJson]);
    const result = await revisePlanByPlanner({ projectDir: dir, chapter: 3, plan: BASE_PLAN, problems: PROBLEMS, callModel });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.beats[0]).toBe("许棠在铺子里盘点账目");
    expect(result.plan.beats.slice(1)).toEqual(BASE_PLAN.beats.slice(1));
    // 其余栏不靠模型重抄：原章纲是什么就是什么（summary 留空 → 保留原话）。
    expect(result.plan.summary).toBe(BASE_PLAN.summary);
    expect(result.plan.characters).toEqual(["许棠", "林溪"]);
    expect(result.plan.newInformation).toEqual(["林溪约好周末见面"]);
    expect(result.plan.avoid).toEqual(["别再写抽屉"]);
    expect(result.plan.scene).toEqual(BASE_PLAN.scene);
    expect(result.plan.storyDay).toBe(3);
    expect((await readChapterPlan(dir, 3))?.beats[0]).toBe("许棠在铺子里盘点账目");
    const task = calls.find((call) => call.json)!.messages.at(-1)!.content;
    expect(task).toContain("核账员审出 1 处和前文对不上");
    expect(task).toContain("第 1 条要点「许棠在铺子里等信」");
    expect(task).toContain("许棠把那封信锁进抽屉");
    // R7.5：不再要整份章纲 JSON，只要被改的要点。
    expect(task).toContain('{"revised":[{"point":1,"beat":"改好的那条要点全文"}]');
    expect(task).not.toContain("只输出修正后的完整章纲 JSON");
  });

  it("summary 给了就换、留空就保留；多条要点各自换各自的位置", async () => {
    const dir = await makeBook();
    await planChapterByPlanner({ projectDir: dir, chapter: 3, callModel: fakePlanner().callModel });
    const revisedJson = JSON.stringify({
      revised: [{ point: 2, beat: "邮差送来林溪的电报" }, { point: 1, beat: "许棠在铺子里等电报" }],
      summary: "许棠等林溪的电报",
    });
    const { callModel } = fakePlanner([revisedJson]);
    const result = await revisePlanByPlanner({
      projectDir: dir, chapter: 3, plan: BASE_PLAN,
      problems: [PROBLEMS[0]!, { ...PROBLEMS[0]!, point: 2 }],
      callModel,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.beats).toEqual(["许棠在铺子里等电报", "邮差送来林溪的电报", "信里约好周末见面"]);
    expect(result.plan.summary).toBe("许棠等林溪的电报");
  });

  it("改纲输出不完整（revised 为空 / 序号越界 / 要点是空串）→ ok:false，调用方用原章纲", async () => {
    const dir = await makeBook();
    await planChapterByPlanner({ projectDir: dir, chapter: 3, callModel: fakePlanner().callModel });
    for (const junk of [
      JSON.stringify({ characters: ["许棠"] }),
      JSON.stringify({ revised: [] }),
      JSON.stringify({ revised: [{ point: 9, beat: "越界" }] }),
      JSON.stringify({ revised: [{ point: 1, beat: "  " }] }),
    ]) {
      const { callModel } = fakePlanner([junk]);
      const result = await revisePlanByPlanner({ projectDir: dir, chapter: 3, plan: BASE_PLAN, problems: PROBLEMS, callModel });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("没改出任何要点");
    }
  });
});

describe("章纲员的模型调用", () => {
  beforeEach(() => {
    llmMocks.resolveConfiguredChatModel.mockReset().mockResolvedValue({
      provider: { baseUrl: "https://example.test/v1" }, profile: { model: "m" }, thinking: true, thinkingDialect: "none", apiKey: "k",
    });
    llmMocks.streamChatModelToText.mockReset().mockResolvedValue({ content: "好的", thinking: "" });
  });

  it("用 chapterSteering 槽；拟纲（json）思考开关随作者设置；笔记（非 json）一律关思考；不传 max_tokens", async () => {
    const messages: BrainMessage[] = [{ role: "system", content: "系统" }];
    await callConfiguredPlannerModel(messages, { json: true });
    expect(llmMocks.resolveConfiguredChatModel).toHaveBeenCalledWith("chapterSteering");
    expect(llmMocks.streamChatModelToText.mock.calls[0]![0]).toMatchObject({
      configured: { thinking: true },
      responseFormat: { type: "json_object" },
      maxThinkingMs: 150_000,
    });
    await callConfiguredPlannerModel(messages, { json: false });
    expect(llmMocks.streamChatModelToText.mock.calls[1]![0]).toMatchObject({ configured: { thinking: false } });
    expect(llmMocks.streamChatModelToText.mock.calls[1]![0]).not.toHaveProperty("maxThinkingMs");
    for (const call of llmMocks.streamChatModelToText.mock.calls) {
      expect(Object.keys(call[0]).filter((key) => /max_?tokens|idleTimeout|timeout/iu.test(key))).toEqual([]);
    }
  });

  it("「光想不写」超时（策略原因 thinking_too_long）→ 关思考重拟一次", async () => {
    const { ModelCallError } = await import("../lib/ai-errors.js");
    llmMocks.streamChatModelToText
      .mockRejectedValueOnce(new ModelCallError("思考超长", "policy_abort", undefined, undefined, { policy: "thinking_too_long" }))
      .mockResolvedValueOnce({ content: "第二次好了", thinking: "" });
    expect(await callConfiguredPlannerModel([{ role: "user", content: "拟" }], { json: true })).toBe("第二次好了");
    expect(llmMocks.streamChatModelToText).toHaveBeenCalledTimes(2);
    expect(llmMocks.streamChatModelToText.mock.calls[1]![0]).toMatchObject({ configured: { thinking: false } });
  });
});

describe("提示词文本", () => {
  it("plannerTask 带全章纲要求（PLAN_REQUIREMENT_LINES 逐条 + PLAN_JSON_FIELDS，改提示词先在题库比分）", async () => {
    const dir = await makeBook();
    const materials = await collectPlanMaterials(dir, 3, "许棠收到回信");
    const task = plannerTask(3, materials, "许棠收到回信");
    const { PLAN_REQUIREMENT_LINES, PLAN_JSON_FIELDS } = await import("./plan-materials.js");
    for (const line of PLAN_REQUIREMENT_LINES) {
      expect(task).toContain(line);
    }
    expect(task).toContain(PLAN_JSON_FIELDS);
  });

  it("第 1 章没有前文：不说「跟读到第 0 章」，要求换成开篇的说法，其余照旧", async () => {
    const dir = await makeBook();
    const task = plannerTask(1, await collectPlanMaterials(dir, 1));
    const { PLAN_REQUIREMENT_LINES } = await import("./plan-materials.js");
    expect(task).not.toContain("第 0 章");
    expect(task).toContain("这是全书第 1 章，前面还没有正文");
    expect(task).not.toContain(PLAN_REQUIREMENT_LINES[0]);
    expect(task).not.toContain(PLAN_REQUIREMENT_LINES[2]);
    expect(task).toContain("除非写明发生在故事开始之前");
    for (const line of PLAN_REQUIREMENT_LINES.slice(3)) expect(task).toContain(line);
  });

  async function writeCards(dir: string, ops: CardOp[]): Promise<void> {
    const outcome = await runCommand(dir, cardWrite, { ops }, { caller: "author", idempotencyKey: `planner-${ops.length}-${Math.random()}` });
    if (!outcome.ok) throw new Error(outcome.message);
  }

  it("白沙渡试写：章纲材料带设定本（人物关系、过去的事、身份年龄），只有名字不带编号", async () => {
    const dir = await makeBook();
    await writeCards(dir, [
      { op: "card.create", kind: "character", name: "韩小满", protagonist: true, fields: [{ label: "年龄", value: "24" }] },
      { op: "card.create", kind: "character", name: "韩德顺", fields: [{ label: "身份", value: "摆渡人" }, { label: "年龄", value: "58" }] },
      { op: "relation.set", a: "韩德顺", b: "韩小满", label: "韩小满的父亲" },
      { op: "story.set", label: "过去的事", value: "农历八月十五，韩德顺摆最后一趟去柳湾村后下落不明" },
    ]);
    const materials = await collectPlanMaterials(dir, 1);
    expect(materials.characters).toEqual(["韩小满", "韩德顺"]);
    const task = plannerTask(1, materials);
    expect(task).toContain("【设定本");
    expect(task).toContain("韩德顺——身份：摆渡人；年龄：58；和韩小满：韩小满的父亲");
    expect(task).toContain("八月十五，韩德顺摆最后一趟去柳湾村后下落不明");
    expect(task).toContain("【已有人物（身份、年龄见设定本，别用错人、别算错年代）】韩小满、韩德顺");
    expect(task).not.toMatch(/[kr]-\d/u);
  });

  it("作者写的一句话 / 主线在设定本的故事设定里照带；不再有单独的【故事前提】块", async () => {
    const dir = await makeBook();
    await writeCards(dir, [{ op: "story.set", label: "一句话", value: "江边小镇，女儿回乡找失踪的摆渡人父亲。" }]);
    const task = plannerTask(3, await collectPlanMaterials(dir, 3));
    expect(task).toContain("【故事设定】\n一句话：江边小镇，女儿回乡找失踪的摆渡人父亲。");
    expect(task).not.toContain("【故事前提】");
  });

  it("reviseTask 带原章纲和每条问题；planCheckTask 带编号要点", () => {
    const revise = reviseTask(3, BASE_PLAN, PROBLEMS);
    expect(revise).toContain("可以整条重写");
    for (const beat of BASE_PLAN.beats) expect(revise).toContain(beat);
    expect(revise).toContain('"revised"');
    const check = planCheckTask(3, BASE_PLAN);
    expect(check).toContain("1. 许棠在铺子里等信");
    expect(check).toContain("还没写正文");
    expect(check).toContain('"problems"');
    expect(check).toContain('"conflict"');
  });
});
