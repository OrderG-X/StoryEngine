// @vitest-environment node
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import { normalizeChapterPlan } from "@actalk/story-engine";
import {
  callConfiguredBrainModel,
  checkChapterByReader,
  checkPlanByReader,
  checkTask,
  CHECKER_FOCUS,
  CHECKER_ROLE,
  parsePlanProblems,
  planCheckTask,
} from "./checker.js";
import type { BrainCallModel, BrainMessage } from "./reader-window.js";

const llmMocks = vi.hoisted(() => ({
  resolveConfiguredChatModel: vi.fn(),
  streamChatModelToText: vi.fn(),
}));
vi.mock("../lib/llm-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/llm-client.js")>()),
  ...llmMocks,
}));

const CH1 = "客人把怀表放在绒布上就走了。周婶说这表是前天送来的。";
const CH2 = "周婶端着茶进来。林舟把怀表锁进了柜台下的抽屉。林溪说她后天走。";
const BODY = "林舟一早开门。他从工作台上拿起那块怀表，表盖还开着。周婶在门口喊他。";

const WATCH = { quote: "他从工作台上拿起那块怀表", earlierQuote: "林舟把怀表锁进了柜台下的抽屉", earlierChapter: 2, reason: "怀表锁在抽屉里，本章却在工作台上" };
const AUNT = { quote: "周婶在门口喊他", earlierQuote: "周婶端着茶进来", earlierChapter: 2, reason: "周婶的位置对不上" };

async function makeBook(): Promise<string> {
  const dir = await makeHomeTempDir("checker-");
  await mkdir(join(dir, "chapters"), { recursive: true });
  await writeFile(join(dir, "chapters", "0001.md"), `# 第1章\n\n${CH1}\n`, "utf-8");
  await writeFile(join(dir, "chapters", "0002.md"), `# 第2章\n\n${CH2}\n`, "utf-8");
  return dir;
}

type Verdict = Record<string, unknown>;
const pass = (...contradictions: Verdict[]) => JSON.stringify({ checks: ["…"], contradictions });
const FOCUS_KEYS = { objects: "这一遍只盯东西", people: "这一遍只盯人", time: "这一遍只盯时间和信息" } as const;

/** 假模型：记笔记（json:false）回一句；核账（json:true）按这一遍的重点回不同的结果（可以抛错）。 */
function fakeModel(byPass: Partial<Record<keyof typeof FOCUS_KEYS, Verdict[] | Error>>) {
  const calls: { readonly messages: readonly BrainMessage[]; readonly json: boolean }[] = [];
  const callModel: BrainCallModel = async (messages, options) => {
    calls.push({ messages: [...messages], json: options.json });
    if (!options.json) return `第${/第 (\d+) 章/u.exec(messages.at(-1)!.content)?.[1]}章笔记`;
    const last = messages.at(-1)!.content;
    const focus = (Object.keys(FOCUS_KEYS) as (keyof typeof FOCUS_KEYS)[]).find((key) => last.includes(FOCUS_KEYS[key]))!;
    const result = byPass[focus] ?? [];
    if (result instanceof Error) throw result;
    return pass(...result);
  };
  return { callModel, calls, checkCalls: () => calls.filter((call) => call.json) };
}

describe("核账员：三遍合并", () => {
  it("三遍各自查、合并去重：一条的原句包含另一条的算同一条，留先出现的；同一句 sure 优先", async () => {
    const dir = await makeBook();
    const { callModel } = fakeModel({
      objects: [{ ...WATCH, confidence: "maybe" }],
      people: [
        { ...AUNT, confidence: "maybe" },
        { ...WATCH, quote: "拿起那块怀表", reason: "同一件事又报一遍", confidence: "sure" },
      ],
      time: [{ ...AUNT, quote: "周婶在门口喊他", confidence: "确定" }],
    });
    const result = await checkChapterByReader({ projectDir: dir, chapter: 3, draftBody: BODY, callModel });
    expect(result.skipped).toBeUndefined();
    expect(result.failures).toEqual([]);
    expect(result.issues.map((issue) => [issue.quote, issue.reason, issue.confidence])).toEqual([
      ["他从工作台上拿起那块怀表", "怀表锁在抽屉里，本章却在工作台上", "sure"],
      ["周婶在门口喊他", "周婶的位置对不上", "sure"],
    ]);
    expect(result.issues[0]).toMatchObject({ earlierChapter: 2, earlierQuote: "林舟把怀表锁进了柜台下的抽屉" });
  });

  it("把握：sure / 确定 → sure，其余（maybe、没写、不确定）→ maybe", async () => {
    const dir = await makeBook();
    const { callModel } = fakeModel({
      objects: [{ ...WATCH, confidence: "sure" }, { ...AUNT, confidence: "不确定" }],
      people: [{ quote: "林舟一早开门", earlierQuote: "林溪说她后天走", earlierChapter: 2, reason: "没写把握" }],
    });
    const result = await checkChapterByReader({ projectDir: dir, chapter: 3, draftBody: BODY, callModel });
    expect(result.issues.map((issue) => issue.confidence)).toEqual(["sure", "maybe", "maybe"]);
  });

  it("抄不出原文的丢掉：本章那句不在新稿里、前文那句不在前文里，都不收", async () => {
    const dir = await makeBook();
    const { callModel } = fakeModel({
      objects: [
        { ...WATCH, quote: "新稿里根本没有的一句话", confidence: "sure" },
        { ...AUNT, earlierQuote: "前文里根本没有的一句话", confidence: "sure" },
        { ...WATCH, confidence: "sure" },
      ],
    });
    const result = await checkChapterByReader({ projectDir: dir, chapter: 3, draftBody: BODY, callModel });
    expect(result.issues.map((issue) => issue.quote)).toEqual(["他从工作台上拿起那块怀表"]);
  });

  it("一遍失败：其余两遍照出结果，失败如实记下（带第几遍和盯什么）", async () => {
    const dir = await makeBook();
    const { callModel } = fakeModel({ objects: [{ ...WATCH, confidence: "sure" }], people: new Error("断流了") });
    const result = await checkChapterByReader({ projectDir: dir, chapter: 3, draftBody: BODY, callModel });
    expect(result.issues).toHaveLength(1);
    expect(result.failures).toEqual(["第 2 遍（盯人）没跑成：断流了"]);
  });

  it("模型这一遍输出不是 JSON：这一遍记失败，不当成没问题", async () => {
    const dir = await makeBook();
    const callModel: BrainCallModel = async (_messages, options) => (options.json ? "我觉得没问题" : "笔记");
    const result = await checkChapterByReader({ projectDir: dir, chapter: 3, draftBody: BODY, callModel });
    expect(result.issues).toEqual([]);
    expect(result.failures).toHaveLength(3);
    expect(result.failures[0]).toContain("第 1 遍（盯东西）没跑成");
  });

  it("三遍全失败：三条失败都在，没有结果", async () => {
    const dir = await makeBook();
    const boom = new Error("网关挂了");
    const { callModel } = fakeModel({ objects: boom, people: boom, time: boom });
    const result = await checkChapterByReader({ projectDir: dir, chapter: 3, draftBody: BODY, callModel });
    expect(result.issues).toEqual([]);
    expect(result.failures.map((line) => line.slice(0, 12))).toEqual(["第 1 遍（盯东西）没跑", "第 2 遍（盯人）没跑成", "第 3 遍（盯时间）没跑"]);
  });
});

describe("核账员：窗口和提示", () => {
  it("每一遍 = 读完前一章的窗口 + 新稿 + 核账提示（json:true）；前文笔记按章补好", async () => {
    const dir = await makeBook();
    const { callModel, calls, checkCalls } = fakeModel({});
    await checkChapterByReader({ projectDir: dir, chapter: 3, draftBody: BODY, callModel });
    expect(calls.filter((call) => !call.json)).toHaveLength(2);
    expect(checkCalls()).toHaveLength(3);
    for (const { messages } of checkCalls()) {
      expect(messages).toHaveLength(6);
      expect(messages[0]).toEqual({ role: "system", content: CHECKER_ROLE.system });
      expect(messages[1]!.content).toBe(`【第 1 章 定稿原文】\n${CH1}\n\n${CHECKER_ROLE.noteTask}`);
      expect(messages[2]).toEqual({ role: "assistant", content: "第1章笔记" });
      expect(messages.at(-1)!.role).toBe("user");
    }
    // 三遍共用同一段窗口前缀（服务商缓存）
    const prefixes = new Set(checkCalls().map((call) => JSON.stringify(call.messages.slice(0, 5))));
    expect(prefixes.size).toBe(1);
    expect(checkCalls().map((call) => call.messages.at(-1)!.content).sort()).toEqual(
      (["objects", "people", "time"] as const).map((focus) => `【新稿：第 3 章】\n${BODY}\n\n${checkTask(3, focus)}`).sort(),
    );
  });

  it("第 1 章没有前文：窗口只有 system，不补笔记，三遍照核", async () => {
    const dir = await makeBook();
    const { callModel, calls, checkCalls } = fakeModel({});
    const result = await checkChapterByReader({ projectDir: dir, chapter: 1, draftBody: CH1, callModel });
    expect(result.failures).toEqual([]);
    expect(calls.filter((call) => !call.json)).toHaveLength(0);
    expect(checkCalls()).toHaveLength(3);
    expect(checkCalls()[0]!.messages).toHaveLength(2);
    expect(checkCalls()[0]!.messages[0]).toEqual({ role: "system", content: CHECKER_ROLE.system });
  });

  it("笔记已经都在：不再调模型写笔记", async () => {
    const dir = await makeBook();
    await checkChapterByReader({ projectDir: dir, chapter: 3, draftBody: BODY, callModel: fakeModel({}).callModel });
    const again = fakeModel({});
    await checkChapterByReader({ projectDir: dir, chapter: 3, draftBody: BODY, callModel: again.callModel });
    expect(again.calls.filter((call) => !call.json)).toHaveLength(0);
  });

  it("要补的笔记太多（超过 maxCatchUp）→ skipped: not_ready，不核也不写笔记", async () => {
    const dir = await makeBook();
    const { callModel, calls } = fakeModel({});
    const result = await checkChapterByReader({ projectDir: dir, chapter: 3, draftBody: BODY, callModel, maxCatchUp: 1 });
    expect(result).toEqual({ issues: [], failures: [], skipped: "not_ready" });
    expect(calls).toHaveLength(0);
  });

  it("补笔记中途失败：不核，如实说读前文没成（不是 not_ready）", async () => {
    const dir = await makeBook();
    const callModel: BrainCallModel = async () => { throw new Error("限流了"); };
    const result = await checkChapterByReader({ projectDir: dir, chapter: 3, draftBody: BODY, callModel });
    expect(result.skipped).toBeUndefined();
    expect(result.issues).toEqual([]);
    expect(result.failures).toEqual(["核账员读前文没成：限流了"]);
  });

  it("提示词：三遍重点各不相同，核账提示要求逐字抄原句并给把握", () => {
    expect(new Set(Object.values(CHECKER_FOCUS)).size).toBe(3);
    const task = checkTask(7, "time");
    expect(task).toContain("第 7 章新稿");
    expect(task).toContain(CHECKER_FOCUS.time);
    expect(task).toContain("confidence 写 sure");
    expect(checkTask(7)).not.toContain("【这一遍的重点】");
  });
});

describe("核账员的模型调用", () => {
  beforeEach(() => {
    llmMocks.resolveConfiguredChatModel.mockReset().mockResolvedValue({ provider: { baseUrl: "https://example.test/v1" }, model: "m", thinking: true });
    llmMocks.streamChatModelToText.mockReset().mockResolvedValue({ content: "好的", thinking: "" });
  });

  it("用 qualityCheck 槽；关思考、低温、两道闸；不传 max_tokens 也不设总时长上限；json 才要 json_object", async () => {
    const messages: BrainMessage[] = [{ role: "system", content: "系统" }, { role: "user", content: "问" }, { role: "assistant", content: "答" }];
    expect(await callConfiguredBrainModel(messages, { json: true })).toBe("好的");
    expect(llmMocks.resolveConfiguredChatModel).toHaveBeenCalledWith("qualityCheck");
    const sent = llmMocks.streamChatModelToText.mock.calls[0]![0];
    expect(sent).toMatchObject({
      configured: { thinking: false },
      messages,
      temperature: 0.1,
      responseFormat: { type: "json_object" },
      maxThinkingMs: 180_000,
      maxContentChars: 60_000,
    });
    expect(Object.keys(sent).filter((key) => /max_?tokens|idleTimeout|timeout/iu.test(key))).toEqual([]);
    await callConfiguredBrainModel(messages, { json: false });
    expect(llmMocks.streamChatModelToText.mock.calls[1]![0]).not.toHaveProperty("responseFormat");
  });

  it("模型返回空内容 → 抛错，不当成没问题", async () => {
    llmMocks.streamChatModelToText.mockResolvedValue({ content: "  ", thinking: "" });
    await expect(callConfiguredBrainModel([{ role: "user", content: "问" }], { json: true })).rejects.toThrow("空内容");
  });
});

// ---------- 审章纲（编辑部第 3 步） ----------

const PLAN = normalizeChapterPlan({
  summary: "林舟去取怀表",
  beats: ["林舟从抽屉里取出怀表", "他把怀表交给周婶", "两人约好三天后再见"],
  newInformation: ["怀表的下落"],
  scene: { location: "铺子", time: "第二天上午" },
  characters: ["林舟", "周婶"],
}, { chapter: 3 })!;

const problems = (...items: Record<string, unknown>[]) => JSON.stringify({ problems: items });

describe("核账员审章纲：解析", () => {
  it("earlierQuote 由代码核对：报错章号时按章序搜；抄不出前文原文的丢掉；point 越界的丢掉", () => {
    const parsed = parsePlanProblems(problems(
      { point: 1, earlierQuote: "林舟把怀表锁进了柜台下的抽屉", earlierChapter: 9, reason: "怀表第 2 章已锁进抽屉，本章却直接取出" },
      { point: 2, earlierQuote: "前文里根本没有的一句话", earlierChapter: 2, reason: "抄不出来" },
      { point: 7, earlierQuote: "周婶端着茶进来", earlierChapter: 2, reason: "要点序号越界" },
      { point: "第 3 条", earlierQuote: "林溪说她后天走", earlierChapter: 2, reason: "日子对不上" },
    ), PLAN, { chapters: [{ chapter: 1, sentences: [CH1] }, { chapter: 2, sentences: [CH2] }] });
    expect(parsed).toEqual([
      { point: 1, beat: "林舟从抽屉里取出怀表", earlierQuote: "林舟把怀表锁进了柜台下的抽屉", earlierChapter: 2, reason: "怀表第 2 章已锁进抽屉，本章却直接取出" },
      { point: 3, beat: "两人约好三天后再见", earlierQuote: "林溪说她后天走", earlierChapter: 2, reason: "日子对不上" },
    ]);
  });

  it("不是 JSON 抛错（调用方记失败，不当成没问题）", () => {
    expect(() => parsePlanProblems("没问题", PLAN, { chapters: [] })).toThrow("不是 JSON");
  });
});

describe("核账员审章纲：checkPlanByReader", () => {
  /** 假模型：checker 笔记（json:false）+ 审章纲（json:true，最后一条消息含「章纲」任务）。 */
  const fakePlanChecker = (reply: string | Error) => {
    const calls: { readonly messages: readonly BrainMessage[]; readonly json: boolean }[] = [];
    const callModel: BrainCallModel = async (messages, options) => {
      calls.push({ messages: [...messages], json: options.json });
      if (!options.json) return `第${/第 (\d+) 章/u.exec(messages.at(-1)!.content)?.[1]}章笔记`;
      if (reply instanceof Error) throw reply;
      return reply;
    };
    return { callModel, calls };
  };

  it("一遍核完：窗口（读到 N-1）+ 审章纲提示；问题经代码核过原句", async () => {
    const dir = await makeBook();
    const { callModel, calls } = fakePlanChecker(problems(
      { point: 1, earlierQuote: "林舟把怀表锁进了柜台下的抽屉", earlierChapter: 2, reason: "表在抽屉里锁着，不能直接取出" },
    ));
    const result = await checkPlanByReader({ projectDir: dir, plan: PLAN, callModel });
    expect(result.skipped).toBeUndefined();
    expect(result.failures).toEqual([]);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatchObject({ point: 1, earlierChapter: 2, reason: "表在抽屉里锁着，不能直接取出" });
    const checkCalls = calls.filter((call) => call.json);
    expect(checkCalls).toHaveLength(1);
    expect(checkCalls[0]!.messages).toHaveLength(6); // system + 两章各两条 + 任务
    expect(checkCalls[0]!.messages.at(-1)!.content).toBe(planCheckTask(3, PLAN));
  });

  it("第 1 章没有前文：窗口只有 system，照审", async () => {
    const dir = await makeBook();
    const { callModel, calls } = fakePlanChecker(problems());
    const result = await checkPlanByReader({ projectDir: dir, plan: { ...PLAN, chapter: 1 }, callModel });
    expect(result.failures).toEqual([]);
    expect(calls.filter((call) => call.json)[0]!.messages).toHaveLength(2);
  });

  it("要补的笔记太多 → skipped: not_ready；调用失败 → failures 如实", async () => {
    const dir = await makeBook();
    const notReady = fakePlanChecker(problems());
    expect(await checkPlanByReader({ projectDir: dir, plan: PLAN, callModel: notReady.callModel, maxCatchUp: 1 }))
      .toEqual({ problems: [], failures: [], skipped: "not_ready" });
    expect(notReady.calls).toHaveLength(0);
    const broken = fakePlanChecker(new Error("断流了"));
    const failed = await checkPlanByReader({ projectDir: dir, plan: PLAN, callModel: broken.callModel });
    expect(failed.problems).toEqual([]);
    expect(failed.failures).toEqual(["审章纲没跑成：断流了"]);
  });
});
