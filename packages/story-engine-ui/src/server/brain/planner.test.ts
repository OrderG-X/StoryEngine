// @vitest-environment node
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeChapterPlan, readChapterPlan } from "@actalk/story-engine";
import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import {
  callConfiguredPlannerModel,
  PLANNER_ROLE,
  planChapterByPlanner,
  plannerTask,
  revisePlanByPlanner,
  reviseTask,
} from "./planner.js";
import { planCheckTask, parsePlanProblems, type PlanProblem } from "./checker.js";
import { collectPlanMaterials } from "../agent/chapter-plan/plan-chapter.js";
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

describe("章纲员：改章纲（一轮，不循环）", () => {
  it("把问题列表交回窗口：只改有问题的要点；缺的栏沿用原章纲、avoid 并集、天数不丢", async () => {
    const dir = await makeBook();
    // 先把窗口的笔记补上（拟一次），再改。
    await planChapterByPlanner({ projectDir: dir, chapter: 3, callModel: fakePlanner().callModel });
    const revisedJson = JSON.stringify({
      summary: "许棠等林溪的回信",
      beats: ["许棠在铺子里盘点账目", "邮差送来林溪的回信", "信里约好周末见面"],
      scene: { time: "第二天上午" },
    });
    const { callModel, calls } = fakePlanner([revisedJson]);
    const result = await revisePlanByPlanner({ projectDir: dir, chapter: 3, plan: BASE_PLAN, problems: PROBLEMS, callModel });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.beats[0]).toBe("许棠在铺子里盘点账目");
    expect(result.plan.beats.slice(1)).toEqual(BASE_PLAN.beats.slice(1));
    // 模型只回了 summary/beats/scene：其余栏沿用原章纲，avoid 并集，天数不丢。
    expect(result.plan.characters).toEqual(["许棠", "林溪"]);
    expect(result.plan.newInformation).toEqual(["林溪约好周末见面"]);
    expect(result.plan.avoid).toContain("别再写抽屉");
    expect(result.plan.storyDay).toBe(3);
    expect((await readChapterPlan(dir, 3))?.beats[0]).toBe("许棠在铺子里盘点账目");
    const task = calls.find((call) => call.json)!.messages.at(-1)!.content;
    expect(task).toContain("核账员审出 1 处和前文对不上");
    expect(task).toContain("第 1 条要点「许棠在铺子里等信」");
    expect(task).toContain("许棠把那封信锁进抽屉");
  });

  it("改纲输出不完整 → ok:false，调用方用原章纲", async () => {
    const dir = await makeBook();
    await planChapterByPlanner({ projectDir: dir, chapter: 3, callModel: fakePlanner().callModel });
    const { callModel } = fakePlanner([JSON.stringify({ characters: ["许棠"] })]);
    const result = await revisePlanByPlanner({ projectDir: dir, chapter: 3, plan: BASE_PLAN, problems: PROBLEMS, callModel });
    expect(result.ok).toBe(false);
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

  it("「光想不写」超时（ThinkingTooLongError）→ 关思考重拟一次", async () => {
    const { ThinkingTooLongError } = await import("../lib/llm-client.js");
    llmMocks.streamChatModelToText
      .mockRejectedValueOnce(new ThinkingTooLongError(150_000))
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
    const { PLAN_REQUIREMENT_LINES, PLAN_JSON_FIELDS } = await import("../agent/chapter-plan/plan-chapter.js");
    for (const line of PLAN_REQUIREMENT_LINES) {
      expect(task).toContain(line);
    }
    expect(task).toContain(PLAN_JSON_FIELDS);
  });

  it("reviseTask 带原章纲和每条问题；planCheckTask 带编号要点", () => {
    const revise = reviseTask(3, BASE_PLAN, PROBLEMS);
    expect(revise).toContain("可以整条重写");
    for (const beat of BASE_PLAN.beats) expect(revise).toContain(beat);
    const check = planCheckTask(3, BASE_PLAN);
    expect(check).toContain("1. 许棠在铺子里等信");
    expect(check).toContain("还没写正文");
    expect(check).toContain('"problems"');
  });
});
