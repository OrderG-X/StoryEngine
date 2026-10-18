// @vitest-environment node
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import { normalizeChapterPlan } from "../book/chapter-plan.js";
import {
  applySureGate,
  callConfiguredBrainModel,
  checkChapterByReader,
  checkPlanByReader,
  checkTask,
  CHECKER_FOCUS,
  CHECKER_NOTE_TASK_STRUCTURED,
  CHECKER_ROLE,
  CHECKER_ROLE_STRUCTURED,
  checkerRoleFor,
  DEFAULT_READER_VARIANT,
  parseKeywords,
  parsePlanProblems,
  planCheckTask,
  selfReviewTask,
} from "./checker.js";
import type { BrainCallModel, BrainMessage } from "../editorial/reader-window.js";

const llmMocks = vi.hoisted(() => ({
  resolveConfiguredChatModel: vi.fn(),
  streamChatModelToText: vi.fn(),
}));
vi.mock("../lib/llm-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/llm-client.js")>()),
  ...llmMocks,
}));

/** 路径存在与否（冷窗口「绝不写笔记」的断言用）。 */
const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

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
      time: [{ ...AUNT, quote: "周婶在门口喊他", confidence: "sure" }],
    });
    const result = await checkChapterByReader({ projectDir: dir, chapter: 3, draftBody: BODY, callModel });
    expect(result.cold).toBeUndefined();
    expect(result.failures).toEqual([]);
    expect(result.issues.map((issue) => [issue.quote, issue.reason, issue.confidence])).toEqual([
      ["他从工作台上拿起那块怀表", "怀表锁在抽屉里，本章却在工作台上", "sure"],
      ["周婶在门口喊他", "周婶的位置对不上", "sure"],
    ]);
    expect(result.issues[0]).toMatchObject({ earlierChapter: 2, earlierQuote: "林舟把怀表锁进了柜台下的抽屉" });
  });

  it("把握：只认 schema 的 sure，其余（maybe、没写、中文「不确定」「确定」）→ maybe", async () => {
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

  it("要补的笔记太多（超过 maxCatchUp）→ 冷窗口照核：最近 K 章原文进窗口、cold 说清范围、一个笔记都不写", async () => {
    const dir = await makeBook();
    const { callModel, calls, checkCalls } = fakeModel({ objects: [{ ...WATCH, confidence: "sure" }] });
    const result = await checkChapterByReader({ projectDir: dir, chapter: 3, draftBody: BODY, callModel, maxCatchUp: 1 });
    expect(result.cold).toEqual({ notedThrough: 0, rawFrom: 1, rawTo: 2 });
    expect(result.failures).toEqual([]);
    expect(result.issues.map((issue) => issue.quote)).toEqual(["他从工作台上拿起那块怀表"]);
    expect(checkCalls()).toHaveLength(3);
    for (const { messages } of checkCalls()) {
      expect(messages).toHaveLength(3); // system + 冷窗口原文块 + 任务
      expect(messages[1]).toEqual({
        role: "user",
        content: `【第 1～2 章 定稿原文（你还没读过这些章、也没写过笔记，这次直接给你原文）】\n\n【第 1 章】\n${CH1}\n\n【第 2 章】\n${CH2}`,
      });
    }
    // 冷窗口绝不写笔记：agents/ 目录都不该出现
    expect(await exists(join(dir, "agents"))).toBe(false);
    expect(calls.filter((call) => !call.json)).toHaveLength(0);
  });

  it("冷窗口带已有笔记：笔记按折叠形态进前缀、原文从笔记断点之后起、cold.notedThrough 说清", async () => {
    const dir = await makeBook();
    await writeFile(join(dir, "chapters", "0003.md"), `# 第3章\n\n${BODY}\n`, "utf-8");
    const noteModel = fakeModel({});
    await checkChapterByReader({ projectDir: dir, chapter: 3, draftBody: BODY, callModel: noteModel.callModel, maxCatchUp: 10 });
    // 第 1 章笔记已在盘上（第 2 章的故意删掉），第 4 章要补 2 章 > 1 → 冷窗口，notedThrough=1
    await rm(join(dir, "agents", "checker", "notes", "0002.json"), { force: true });
    const { callModel, checkCalls } = fakeModel({});
    const result = await checkChapterByReader({ projectDir: dir, chapter: 4, draftBody: "林舟又开门了。", callModel, maxCatchUp: 1 });
    expect(result.cold).toEqual({ notedThrough: 1, rawFrom: 2, rawTo: 3 });
    for (const { messages } of checkCalls()) {
      expect(messages[0]).toEqual({ role: "system", content: CHECKER_ROLE.system });
      expect(messages[1]!.content).toBe("【第 1 章（原文已省略，见你当时的笔记）】");
      expect(messages[2]!.role).toBe("assistant");
      expect(messages[3]!.content).toContain("【第 2～3 章 定稿原文");
      // 笔记到第 1 章、原文从第 2 章起——中间没有空档，就不该出现「这次没给你」的说明
      expect(messages[3]!.content).not.toContain("这次没给你");
    }
  });

  it("补笔记中途失败：不核，如实说读前文没成（不是 not_ready）", async () => {
    const dir = await makeBook();
    const callModel: BrainCallModel = async () => { throw new Error("限流了"); };
    const result = await checkChapterByReader({ projectDir: dir, chapter: 3, draftBody: BODY, callModel });
    expect(result.cold).toBeUndefined();
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

describe("核账员：翻原文（窗口里有被折叠的章时）", () => {
  /** 一本能让窗口折叠的书：12 章、每章两千多字，预算压到 6000 → 原文全折掉、只留笔记。 */
  async function makeLongBook(): Promise<string> {
    const dir = await makeHomeTempDir("checker-fold-");
    await mkdir(join(dir, "chapters"), { recursive: true });
    for (let chapter = 1; chapter <= 12; chapter += 1) {
      const filler = `${chapter}号那天，巷子里的一切照旧。`.repeat(140);
      const key = chapter === 1 ? CH1 : chapter === 2 ? CH2 : `第${chapter}章里，林舟照常看店。`;
      await writeFile(join(dir, "chapters", `${String(chapter).padStart(4, "0")}.md`), `# 第${chapter}章\n\n${key}${filler}\n`, "utf-8");
    }
    return dir;
  }

  /** 假模型：笔记回一句；翻原文那轮（带 keywordTask 的记号）按需回关键词；三遍照 fakeModel 的规矩回。 */
  function foldingModel(keywordsReply: string | Error) {
    const calls: { readonly messages: readonly BrainMessage[]; readonly json: boolean }[] = [];
    const callModel: BrainCallModel = async (messages, options) => {
      calls.push({ messages: [...messages], json: options.json });
      const last = messages.at(-1)!.content;
      if (!options.json) return `第${/第 (\d+) 章/u.exec(last)?.[1]}章笔记`;
      if (last.includes("有没有需要翻前文原文的")) {
        if (keywordsReply instanceof Error) throw keywordsReply;
        return keywordsReply;
      }
      return pass(...[]);
    };
    return { callModel, calls };
  }

  it("先问一轮关键词，把翻到的原句（带章号）放进三遍的消息里（新稿后面、核账提示前面）", async () => {
    const dir = await makeLongBook();
    const { callModel, calls } = foldingModel(JSON.stringify({ keywords: ["怀表"] }));
    const result = await checkChapterByReader({ projectDir: dir, chapter: 13, draftBody: BODY, callModel, maxChars: 6_000 });
    expect(result.failures).toEqual([]);
    // 1 次问关键词 + 3 遍核账（json 调用共 4 次）
    const jsonCalls = calls.filter((call) => call.json);
    expect(jsonCalls).toHaveLength(4);
    const keywordCall = jsonCalls[0]!;
    expect(keywordCall.messages.at(-1)!.content).toContain(`【新稿：第 13 章】\n${BODY}`);
    expect(keywordCall.messages.at(-1)!.content).toContain("最多 5 个");
    // 翻到的原文：第 1、2 章里带「怀表」的原句，带章号，贴在三遍各自的核账消息里（新稿后面）
    const checkCalls = jsonCalls.slice(1);
    for (const call of checkCalls) {
      const last = call.messages.at(-1)!.content;
      expect(last).toContain(`【新稿：第 13 章】\n${BODY}`);
      expect(last).toContain("【翻到的原文】");
      expect(last).toContain("第 1 章（怀表）：");
      expect(last).toContain("客人把怀表放在绒布上就走了");
      expect(last).toContain("第 2 章（怀表）：");
      // 前缀 = 窗口（第 1 章起原文已折掉）+ 问关键词 + 答
      expect(call.messages[1]!.content).toBe("【第 1 章（原文已省略，见你当时的笔记）】");
    }
    // 三遍的关键词问答逐字一样（服务商缓存）
    expect(new Set(checkCalls.map((call) => JSON.stringify(call.messages.slice(0, -1)))).size).toBe(1);
  });

  it("关键词抠不出来（不是 JSON / 空数组）→ 不翻原文，照常三遍，不算失败", async () => {
    const dir = await makeLongBook();
    const { callModel, calls } = foldingModel("我觉得没问题");
    const result = await checkChapterByReader({ projectDir: dir, chapter: 13, draftBody: BODY, callModel, maxChars: 6_000 });
    expect(result.failures).toEqual([]);
    expect(result.issues).toEqual([]);
    expect(calls.filter((call) => call.json)).toHaveLength(4);
    // 三遍的核账消息里没有翻到的原文，前缀就是窗口本身（没有问答那两条）
    const checkCalls = calls.filter((call) => call.json).slice(1);
    expect(checkCalls[0]!.messages.at(-1)!.content).not.toContain("【翻到的原文】");
    expect(checkCalls[0]!.messages.at(-2)!.role).toBe("assistant"); // 窗口最后一条：第 12 章的笔记
  });

  it("翻原文那一轮失败：如实记一笔，三遍按原窗口照核", async () => {
    const dir = await makeLongBook();
    const { callModel } = foldingModel(new Error("断流了"));
    const result = await checkChapterByReader({ projectDir: dir, chapter: 13, draftBody: BODY, callModel, maxChars: 6_000 });
    expect(result.failures).toEqual(["翻原文那一轮没跑成（断流了），这次只按窗口核"]);
    expect(result.issues).toEqual([]);
  });

  it("窗口里没有折叠的章 → 不问关键词（保持第 1 步的调用形状）", async () => {
    const dir = await makeBook();
    const { callModel, calls } = foldingModel(JSON.stringify({ keywords: ["怀表"] }));
    await checkChapterByReader({ projectDir: dir, chapter: 3, draftBody: BODY, callModel });
    expect(calls.filter((call) => call.json).every((call) => !call.messages.at(-1)!.content.includes("有没有需要翻前文原文的"))).toBe(true);
  });

  it("关键词去重、太短的丢掉、最多 5 个", () => {
    expect(parseKeywords('前缀 {"keywords":["怀表","怀表 ","周","  ","林溪","抽屉","青砖","表盖"]} 后缀')).toEqual(["怀表", "林溪", "抽屉", "青砖", "表盖"]);
    expect(parseKeywords("完全不是 JSON")).toEqual([]);
  });

  it("关键词写成短语（带空格）也拆得开：翻原文按拆出来的词检索，照样翻到", async () => {
    const dir = await makeLongBook();
    const { callModel, calls } = foldingModel(JSON.stringify({ keywords: ["怀表 放在 绒布", "周婶"] }));
    const result = await checkChapterByReader({ projectDir: dir, chapter: 13, draftBody: BODY, callModel, maxChars: 6_000 });
    expect(result.failures).toEqual([]);
    const last = calls.filter((call) => call.json)[1]!.messages.at(-1)!.content;
    // 短语拆成了单词（怀表 / 放在 / 绒布 / 周婶）逐个检索：第 1 章的原句翻回来了（同一原句按词去重，只带一次）
    expect(last).toMatch(/第 1 章（(怀表|放在|绒布|周婶)）：/u);
    expect(last).toContain("客人把怀表放在绒布上就走了");
    expect(last).toContain("第 2 章（怀表）：");
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
    llmMocks.streamChatModelToText.mockReset().mockResolvedValue({ content: "  ", thinking: "" });
    await expect(callConfiguredBrainModel([{ role: "user", content: "问" }], { json: true })).rejects.toThrow("空内容");
  });
});

// ---------- T1 的四个做法（A 自复核 / B 时间线 / C 结构化笔记 / D 确定门槛） ----------

describe("A 自复核", () => {
  /** 三遍都报怀表，第 4 次（自复核）按 verdicts 表回。 */
  function modelWithReview(verdicts: Record<string, string> | string | Error) {
    const calls: { readonly messages: readonly BrainMessage[]; readonly json: boolean }[] = [];
    const callModel: BrainCallModel = async (messages, options) => {
      calls.push({ messages: [...messages], json: options.json });
      if (!options.json) return "笔记";
      const last = messages.at(-1)!.content;
      if (last.includes("你刚才核完报了")) {
        if (verdicts instanceof Error) throw verdicts;
        if (typeof verdicts === "string") return verdicts;
        return JSON.stringify({ verdicts: Object.entries(verdicts).map(([id, verdict]) => ({ id, verdict })) });
      }
      return pass({ ...WATCH, confidence: "sure" });
    };
    return { callModel, calls };
  }

  it("三遍合并后同一窗口再判一轮：判 no 的删掉，把握以复核为准（sure→maybe 降、maybe→sure 升）", async () => {
    const dir = await makeBook();
    const { callModel } = modelWithReview({ K1: "sure", K2: "no", K3: "maybe" });
    const three = fakeModel({
      objects: [{ ...WATCH, confidence: "maybe" }],
      people: [{ ...AUNT, confidence: "sure" }],
      time: [{ quote: "林舟一早开门", earlierQuote: "林溪说她后天走", earlierChapter: 2, reason: "时间对不上", confidence: "maybe" }],
    });
    // 三遍各自报一条 + 第 4 轮自复核
    const merged: BrainCallModel = async (messages, options) => {
      if (options.json && !messages.at(-1)!.content.includes("你刚才核完报了")) return three.callModel(messages, options);
      return callModel(messages, options);
    };
    const result = await checkChapterByReader({ projectDir: dir, chapter: 3, draftBody: BODY, callModel: merged, variant: { selfReview: true } });
    expect(result.failures).toEqual([]);
    expect(result.issues.map((issue) => [issue.quote, issue.confidence])).toEqual([
      ["他从工作台上拿起那块怀表", "sure"], // 三遍报 maybe，复核判 sure → 升
      ["林舟一早开门", "maybe"], // 复核判 maybe → 保持
      // 「周婶在门口喊他」复核判 no → 删掉
    ]);
  });

  it("自复核的调用 = 窗口 + 新稿 + 候选清单（本章那句、前文那句、理由）", async () => {
    const dir = await makeBook();
    const { callModel, calls } = modelWithReview({ K1: "sure" });
    const three = fakeModel({ objects: [{ ...WATCH, confidence: "sure" }] });
    const merged: BrainCallModel = async (messages, options) => {
      if (options.json && !messages.at(-1)!.content.includes("你刚才核完报了")) return three.callModel(messages, options);
      return callModel(messages, options);
    };
    await checkChapterByReader({ projectDir: dir, chapter: 3, draftBody: BODY, callModel: merged, variant: { selfReview: true } });
    const review = calls.filter((call) => call.messages.at(-1)!.content.includes("你刚才核完报了"));
    expect(review).toHaveLength(1);
    const task = review[0]!.messages.at(-1)!.content;
    expect(task).toContain(`【新稿：第 3 章】\n${BODY}`);
    expect(task).toContain(`【K1】本章那句：${WATCH.quote}`);
    expect(task).toContain(`第 2 章那句：${WATCH.earlierQuote}`);
    expect(task).toContain(`当时的理由：${WATCH.reason}`);
  });

  it("三遍没报出东西 → 不发自复核这一轮（省调用）", async () => {
    const dir = await makeBook();
    const quiet = fakeModel({});
    const result = await checkChapterByReader({ projectDir: dir, chapter: 3, draftBody: BODY, callModel: quiet.callModel, variant: { selfReview: true } });
    expect(result.issues).toEqual([]);
    expect(quiet.checkCalls()).toHaveLength(3); // 只有三遍
    expect(quiet.calls.filter((call) => call.messages.at(-1)!.content.includes("你刚才核完报了"))).toHaveLength(0);
  });

  it("自复核失败 / 输出不是 JSON：候选原样交出，如实记一笔", async () => {
    const dir = await makeBook();
    for (const broken of [new Error("断流了"), "我觉得没问题"] as const) {
      const { callModel } = modelWithReview(broken);
      const three = fakeModel({ objects: [{ ...WATCH, confidence: "sure" }] });
      const merged: BrainCallModel = async (messages, options) => {
        if (options.json && !messages.at(-1)!.content.includes("你刚才核完报了")) return three.callModel(messages, options);
        return callModel(messages, options);
      };
      const result = await checkChapterByReader({ projectDir: dir, chapter: 3, draftBody: BODY, callModel: merged, variant: { selfReview: true } });
      expect(result.issues.map((issue) => [issue.quote, issue.confidence])).toEqual([[WATCH.quote, "sure"]]);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toContain("自复核没跑成");
    }
  });

  it("selfReviewTask：候选逐条列出，判断标准和旧核账的复核一致（sure / maybe / no，拿不准给 maybe）", () => {
    const task = selfReviewTask(7, [{ ...WATCH, kind: "event" }]);
    expect(task).toContain("第 7 章新稿");
    expect(task).toContain(`【K1】本章那句：${WATCH.quote}`);
    expect(task).toContain("拿不准就给 maybe");
    expect(task).toContain("verdicts");
  });
});

describe("B 时间线表进核账", () => {
  async function writeTimeline(dir: string): Promise<void> {
    await mkdir(join(dir, "story"), { recursive: true });
    await writeFile(join(dir, "story", "timeline.json"), JSON.stringify({
      schemaVersion: 1,
      entries: [
        { chapter: 1, day: 1, weekday: 0, source: "author" },
        { chapter: 2, day: 2, weekday: 1, source: "author" },
      ],
    }), "utf-8");
  }

  it("variant.timeline → 三遍的新稿消息后面附上引擎排好的时间线表", async () => {
    const dir = await makeBook();
    await writeTimeline(dir);
    const { callModel, checkCalls } = fakeModel({});
    await checkChapterByReader({ projectDir: dir, chapter: 3, draftBody: BODY, callModel, variant: { timeline: true } });
    expect(checkCalls()).toHaveLength(3);
    for (const { messages } of checkCalls()) {
      const last = messages.at(-1)!.content;
      expect(last).toContain(`【新稿：第 3 章】\n${BODY}`);
      expect(last).toContain("【故事时间线");
      expect(last).toContain("第 1 章");
    }
    // 不开 timeline：一条都不带表
    const plain = fakeModel({});
    await checkChapterByReader({ projectDir: dir, chapter: 3, draftBody: BODY, callModel: plain.callModel });
    for (const { messages } of plain.checkCalls()) expect(messages.at(-1)!.content).not.toContain("【故事时间线");
  });

  it("时间线文件读不了 → 不附表也不算失败，三遍照核", async () => {
    const dir = await makeBook();
    await mkdir(join(dir, "story"), { recursive: true });
    await writeFile(join(dir, "story", "timeline.json"), "{{{坏掉的 JSON", "utf-8");
    const { callModel, checkCalls } = fakeModel({});
    const result = await checkChapterByReader({ projectDir: dir, chapter: 3, draftBody: BODY, callModel, variant: { timeline: true } });
    expect(result.failures).toEqual([]);
    expect(checkCalls()).toHaveLength(3);
    for (const { messages } of checkCalls()) expect(messages.at(-1)!.content).not.toContain("【故事时间线");
  });
});

describe("C 结构化笔记", () => {
  it("角色说明一样、记笔记要求换成固定小节；checkerRoleFor 按开关取角色", () => {
    expect(checkerRoleFor()).toBe(CHECKER_ROLE);
    expect(checkerRoleFor(false)).toBe(CHECKER_ROLE);
    expect(checkerRoleFor(true)).toBe(CHECKER_ROLE_STRUCTURED);
    expect(CHECKER_ROLE_STRUCTURED.id).toBe(CHECKER_ROLE.id); // 笔记还在同一目录
    expect(CHECKER_ROLE_STRUCTURED.system).toBe(CHECKER_ROLE.system);
    expect(CHECKER_NOTE_TASK_STRUCTURED).toContain("【时间】");
    expect(CHECKER_NOTE_TASK_STRUCTURED).toContain("【物件】");
    expect(CHECKER_NOTE_TASK_STRUCTURED).toContain("【人物】");
    expect(CHECKER_NOTE_TASK_STRUCTURED).toContain("【信息】");
    expect(CHECKER_NOTE_TASK_STRUCTURED).toContain("【地点】");
  });

  it("structuredNotes → 写笔记的提示用固定小节版（核账三遍的提示不变）", async () => {
    const dir = await makeBook();
    const { callModel, calls, checkCalls } = fakeModel({});
    await checkChapterByReader({ projectDir: dir, chapter: 3, draftBody: BODY, callModel, variant: { structuredNotes: true } });
    expect(calls.filter((call) => !call.json)).toHaveLength(2);
    for (const call of calls.filter((call) => !call.json)) {
      expect(call.messages.at(-1)!.content).toContain(CHECKER_NOTE_TASK_STRUCTURED);
    }
    for (const { messages } of checkCalls()) expect(messages.at(-1)!.content).toContain(checkTask(3, "objects").slice(0, 10));
  });
});

describe("D「确定」门槛（applySureGate）", () => {
  const EARLIER = { chapters: [{ chapter: 2, sentences: ["周婶端着茶进来。", "林舟把怀表锁进了柜台下的抽屉。", "林溪说她后天走。"] }] };
  const SAME_CHAPTER_FAR = [
    "林舟一早开门。",
    "他把柜台擦了一遍。",
    "他数了数抽屉里的零钱。",
    "他给绿萝浇了水。",
    "他翻开账本看了一眼。",
    "他从工作台上拿起那块怀表，表盖还开着。",
  ].join("");

  it("跨章、两句都逐字抄对 → 保留 sure", () => {
    const gated = applySureGate([{ ...WATCH, confidence: "sure", kind: "event" }], 3, BODY, EARLIER);
    expect(gated[0]!.confidence).toBe("sure");
  });

  it("前文那句只是模糊抄对（不是逐字）→ 降成 maybe", () => {
    const gated = applySureGate([{ ...WATCH, earlierQuote: "林舟把怀表锁进抽屉（原文没有这句）", confidence: "sure", kind: "event" }], 3, BODY, EARLIER);
    expect(gated[0]!.confidence).toBe("maybe");
  });

  it("同章、两句紧挨着（相隔不超过 3 句）→ 降成 maybe；隔得远 → 保留 sure", () => {
    const near = { quote: "他把柜台擦了一遍", earlierQuote: "林舟一早开门", earlierChapter: 3, reason: "同章两句挨着", kind: "event" as const, confidence: "sure" as const };
    const far = { quote: "他从工作台上拿起那块怀表，表盖还开着", earlierQuote: "林舟一早开门", earlierChapter: 3, reason: "同章两句离得远", kind: "event" as const, confidence: "sure" as const };
    const gated = applySureGate([near, far], 3, SAME_CHAPTER_FAR, EARLIER);
    expect(gated[0]!.confidence).toBe("maybe"); // 挨着：第 0 句对第 1 句
    expect(gated[1]!.confidence).toBe("sure"); // 离得远：第 5 句对第 0 句
  });

  it("本来就是 maybe 的不动；quote 在正文里找不到 → 降成 maybe", () => {
    const maybe = { ...WATCH, confidence: "maybe" as const, kind: "event" as const };
    const ghost = { ...WATCH, quote: "新稿里没有的句子", confidence: "sure" as const, kind: "event" as const };
    const gated = applySureGate([maybe, ghost], 3, BODY, EARLIER);
    expect(gated[0]!.confidence).toBe("maybe");
    expect(gated[1]!.confidence).toBe("maybe");
  });

  it("核账全流程带上 sureGate：报出的「确定」过了门槛，被降级的收进「可能」", async () => {
    const dir = await makeBook();
    const { callModel } = fakeModel({
      objects: [
        { ...WATCH, confidence: "sure" },
        { quote: "周婶在门口喊他", earlierQuote: "林舟一早开门", earlierChapter: 3, reason: "同章挨着报的", confidence: "sure" },
      ],
    });
    const result = await checkChapterByReader({ projectDir: dir, chapter: 3, draftBody: BODY, callModel, variant: { sureGate: true } });
    expect(result.issues.map((issue) => [issue.quote, issue.confidence])).toEqual([
      ["他从工作台上拿起那块怀表", "sure"], // 跨章 + 两句逐字 → 保留
      ["周婶在门口喊他", "maybe"], // 同章两句只隔 2 句 → 降级
    ]);
  });
});

describe("F 时间线表只进自复核（R2.1）", () => {
  async function writeTimeline(dir: string): Promise<void> {
    await mkdir(join(dir, "story"), { recursive: true });
    await writeFile(join(dir, "story", "timeline.json"), JSON.stringify({
      schemaVersion: 1,
      entries: [
        { chapter: 1, day: 1, weekday: 0, source: "author" },
        { chapter: 2, day: 2, weekday: 1, source: "author" },
      ],
    }), "utf-8");
  }

  /** 三遍报怀表 + 自复核按 verdicts 回；记下每次调用，供检查三遍和复核各自的消息里有没有时间线表。 */
  function modelWithReview(verdict = "sure") {
    const calls: { readonly messages: readonly BrainMessage[]; readonly json: boolean }[] = [];
    const callModel: BrainCallModel = async (messages, options) => {
      calls.push({ messages: [...messages], json: options.json });
      if (!options.json) return "笔记";
      const last = messages.at(-1)!.content;
      if (last.includes("你刚才核完报了")) return JSON.stringify({ verdicts: [{ id: "K1", verdict }] });
      return pass({ ...WATCH, confidence: "sure" });
    };
    const byKind = () => ({
      passes: calls.filter((call) => call.json && !call.messages.at(-1)!.content.includes("你刚才核完报了")),
      review: calls.filter((call) => call.json && call.messages.at(-1)!.content.includes("你刚才核完报了")),
    });
    return { callModel, byKind };
  }

  it("timelineInReview：三遍不带时间线表；A 自复核那一轮带表，且写明「日子以表为准，不要自己推算」", async () => {
    const dir = await makeBook();
    await writeTimeline(dir);
    const { callModel, byKind } = modelWithReview();
    const result = await checkChapterByReader({ projectDir: dir, chapter: 3, draftBody: BODY, callModel, variant: { selfReview: true, timelineInReview: true } });
    expect(result.failures).toEqual([]);
    const { passes, review } = byKind();
    expect(passes).toHaveLength(3);
    for (const { messages } of passes) expect(messages.at(-1)!.content).not.toContain("【故事时间线");
    expect(review).toHaveLength(1);
    const task = review[0]!.messages.at(-1)!.content;
    expect(task).toContain("【故事时间线（日子以这张表为准，不要自己推算）】");
    expect(task).toContain(`【K1】本章那句：${WATCH.quote}`);
  });

  it("B（timeline）单开时行为不变：三遍和自复核都带同一张表，表头没有「不要自己推算」", async () => {
    const dir = await makeBook();
    await writeTimeline(dir);
    const { callModel, byKind } = modelWithReview();
    await checkChapterByReader({ projectDir: dir, chapter: 3, draftBody: BODY, callModel, variant: { selfReview: true, timeline: true } });
    const { passes, review } = byKind();
    expect(passes).toHaveLength(3);
    for (const { messages } of passes) expect(messages.at(-1)!.content).toContain("【故事时间线（日子以这张表为准）】");
    expect(review).toHaveLength(1);
    expect(review[0]!.messages.at(-1)!.content).toContain("【故事时间线（日子以这张表为准）】");
  });

  it("时间线文件读不了 → 复核不带表也不算失败，照常出结果", async () => {
    const dir = await makeBook();
    await mkdir(join(dir, "story"), { recursive: true });
    await writeFile(join(dir, "story", "timeline.json"), "{{{坏掉的 JSON", "utf-8");
    const { callModel, byKind } = modelWithReview();
    const result = await checkChapterByReader({ projectDir: dir, chapter: 3, draftBody: BODY, callModel, variant: { selfReview: true, timelineInReview: true } });
    expect(result.failures).toEqual([]);
    expect(result.issues.map((issue) => [issue.quote, issue.confidence])).toEqual([[WATCH.quote, "sure"]]);
    for (const { messages } of [...byKind().passes, ...byKind().review]) expect(messages.at(-1)!.content).not.toContain("【故事时间线");
  });

  it("产品默认组合带上 F（R2.1 比分赢下）：A 自复核 + 时间线只进自复核", () => {
    expect(DEFAULT_READER_VARIANT).toEqual({ selfReview: true, timelineInReview: true });
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

  it("R7.5 结构化判定：conflict:false 不收（理由写「不构成矛盾」这种词表没盖到的说法也收得住）；conflict:true 照收", () => {
    const parsed = parsePlanProblems(problems(
      { point: 1, conflict: false, earlierQuote: "林舟把怀表锁进了柜台下的抽屉", earlierChapter: 2, reason: "核对过，不构成矛盾" },
      { point: 2, conflict: "true", earlierQuote: "周婶端着茶进来", earlierChapter: 2, reason: "周婶第 2 章已经动身回乡，端不了茶" },
    ), PLAN, { chapters: [{ chapter: 1, sentences: [CH1] }, { chapter: 2, sentences: [CH2] }] });
    expect(parsed).toEqual([
      { point: 2, beat: "他把怀表交给周婶", earlierQuote: "周婶端着茶进来", earlierChapter: 2, reason: "周婶第 2 章已经动身回乡，端不了茶" },
    ]);
  });

  it("没给 conflict 字段：列进 problems 就照收，不看理由里的字眼（重构 P7 删了词表兜底）", () => {
    const parsed = parsePlanProblems(problems(
      { point: 1, earlierQuote: "林舟把怀表锁进了柜台下的抽屉", earlierChapter: 2, reason: "不构成矛盾" },
      { point: 2, earlierQuote: "周婶端着茶进来", earlierChapter: 2, reason: "周婶第 2 章已经动身回乡，端不了茶" },
    ), PLAN, { chapters: [{ chapter: 1, sentences: [CH1] }, { chapter: 2, sentences: [CH2] }] });
    expect(parsed).toEqual([
      { point: 1, beat: "林舟从抽屉里取出怀表", earlierQuote: "林舟把怀表锁进了柜台下的抽屉", earlierChapter: 2, reason: "不构成矛盾" },
      { point: 2, beat: "他把怀表交给周婶", earlierQuote: "周婶端着茶进来", earlierChapter: 2, reason: "周婶第 2 章已经动身回乡，端不了茶" },
    ]);
  });

  it("R7.5 authorWilled:true 收下来（要报，调用方问作者）；false / 没写不带", () => {
    const parsed = parsePlanProblems(problems(
      { point: 1, conflict: true, authorWilled: true, earlierQuote: "林舟把怀表锁进了柜台下的抽屉", earlierChapter: 2, reason: "作者方向要取表，但表第 2 章已锁进抽屉" },
      { point: 2, conflict: true, authorWilled: false, earlierQuote: "周婶端着茶进来", earlierChapter: 2, reason: "周婶第 2 章已经动身回乡" },
      { point: 3, conflict: true, earlierQuote: "林溪说她后天走", earlierChapter: 2, reason: "日子对不上" },
    ), PLAN, { chapters: [{ chapter: 1, sentences: [CH1] }, { chapter: 2, sentences: [CH2] }] });
    expect(parsed.map((problem) => [problem.point, problem.authorWilled])).toEqual([[1, true], [2, undefined], [3, undefined]]);
  });

  it("不是 JSON 抛错（调用方记失败，不当成没问题）", () => {
    expect(() => parsePlanProblems("没问题", PLAN, { chapters: [] })).toThrow("不是 JSON");
  });

  it("R7.5 planCheckTask：带作者方向时显示出来、要求报方向和前文的冲突；没方向不提这一段", () => {
    const withDirection = planCheckTask(4, { ...PLAN, chapter: 4, direction: "外公把铜盒拿出来看" });
    expect(withDirection).toContain("【作者这章给的方向】\n外公把铜盒拿出来看");
    expect(withDirection).toContain("conflict");
    expect(withDirection).toContain("authorWilled");
    expect(withDirection).toContain("不要因为方向是作者给的就不报");
    expect(planCheckTask(3, PLAN)).not.toContain("【作者这章给的方向】");
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
    expect(result.cold).toBeUndefined();
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

  it("要补的笔记太多 → 冷窗口照审（cold 说清范围）；调用失败 → failures 如实", async () => {
    const dir = await makeBook();
    const coldModel = fakePlanChecker(problems(
      { point: 1, earlierQuote: "林舟把怀表锁进了柜台下的抽屉", earlierChapter: 2, reason: "表在抽屉里锁着，不能直接取出" },
    ));
    const cold = await checkPlanByReader({ projectDir: dir, plan: PLAN, callModel: coldModel.callModel, maxCatchUp: 1 });
    expect(cold.cold).toEqual({ notedThrough: 0, rawFrom: 1, rawTo: 2 });
    expect(cold.problems).toHaveLength(1);
    expect(cold.problems[0]).toMatchObject({ point: 1, earlierChapter: 2 });
    const checkCall = coldModel.calls.filter((call) => call.json)[0]!;
    expect(checkCall.messages).toHaveLength(3); // system + 冷窗口原文块 + 任务
    expect(checkCall.messages[1]!.content).toContain("【第 1～2 章 定稿原文");
    expect(coldModel.calls.filter((call) => !call.json)).toHaveLength(0);
    const broken = fakePlanChecker(new Error("断流了"));
    const failed = await checkPlanByReader({ projectDir: dir, plan: PLAN, callModel: broken.callModel });
    expect(failed.problems).toEqual([]);
    expect(failed.failures).toEqual(["审章纲没跑成：断流了"]);
  });
});
