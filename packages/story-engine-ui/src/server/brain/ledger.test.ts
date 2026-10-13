// @vitest-environment node
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import { readReadersCatchUpStatus, startReaderCatchUp } from "./catch-up.js";
import { declareChapterDeltaByLedger, LEDGER_ROLE } from "./ledger.js";
import type { BrainCallModel, BrainMessage } from "./reader-window.js";

const CH1 = "林舟开门营业。陈老师送来一箱旧书。";
const CH2 = "林舟翻看进货本。陈老师说周五来取书。";
const DRAFT = "林舟把书整理上架。陈老师来取走了书。两人约好下周再见面。";

const DECLARATION_JSON = JSON.stringify({
  mainEvent: { summary: "陈老师取走寄卖的书", quote: "陈老师来取走了书。" },
  seededForeshadowing: [],
  resolvedForeshadowing: [{ summary: "取书的约定兑现", quote: "陈老师来取走了书。", targetThreadHint: "T1" }],
  resourceDeltas: [],
  keyLeads: [],
  pendingIntents: [{ summary: "下周再见", quote: "两人约好下周再见面。", targetThreadHint: "T2" }],
  charactersPresent: [
    { name: "陈老师", quote: "陈老师来取走了书。", aliasOf: "陈老师", identityHint: "即陈老师" },
  ],
  arcGoalProgress: [],
  time: { daysSincePrevious: 1, quote: "第二天一早，林舟把书整理上架。" },
  timeSpan: undefined,
});

async function makeBook(chapters: readonly string[]): Promise<string> {
  const dir = await makeHomeTempDir("ledger-");
  await mkdir(join(dir, "chapters"), { recursive: true });
  await Promise.all(chapters.map((body, index) =>
    writeFile(join(dir, "chapters", `${String(index + 1).padStart(4, "0")}.md`), `# 第${index + 1}章\n\n${body}\n`, "utf-8")));
  return dir;
}

interface LedgerCall {
  readonly messages: readonly BrainMessage[];
  readonly json: boolean;
}

/** 假模型：json:false（写笔记）按章回一句；json:true（声明）回 declaration 或抛错。 */
function fakeModel(declaration: string | Error) {
  const calls: LedgerCall[] = [];
  const callModel: BrainCallModel = async (messages, options) => {
    calls.push({ messages: [...messages], json: options.json });
    if (!options.json) return `第${/第 (\d+) 章/u.exec(messages.at(-1)!.content)?.[1]}章的记账笔记`;
    if (declaration instanceof Error) throw declaration;
    return declaration;
  };
  return { callModel, calls };
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("declareChapterDeltaByLedger", () => {
  it("先补笔记到 N-1 章，再在窗口后接一条 user 消息要 JSON 声明；解析与编号换算复用 chapter-delta-declaration 的契约函数", async () => {
    const dir = await makeBook([CH1, CH2]);
    const { callModel, calls } = fakeModel(DECLARATION_JSON);
    const result = await declareChapterDeltaByLedger({
      projectDir: dir,
      chapter: 3,
      draft: DRAFT,
      callModel,
      openThreadTitles: ["陈老师周五取书", "两人保持联系"],
      establishedNames: ["林舟", "陈老师"],
      openGoalTitles: ["把店开下去"],
    });
    expect(result.cold).toBeUndefined();
    expect(result.outcome.status).toBe("model");
    // 编号 T1 换算回线索标题（resolveThreadRefs 的行为）
    expect(result.outcome.declaration?.resolvedForeshadowing[0]?.targetThreadHint).toBe("陈老师周五取书");
    expect(result.outcome.declaration?.charactersPresent?.[0]?.aliasOf).toBe("陈老师");
    // 调用顺序：第 1、2 章各一次写笔记（json:false），最后一次声明（json:true）
    expect(calls.map((call) => call.json)).toEqual([false, false, true]);
    // 声明那条 = 读到第 2 章的窗口 + 一条 user 消息
    const declareCall = calls.at(-1)!;
    expect(declareCall.messages.at(-1)?.role).toBe("user");
    expect(declareCall.messages[0]?.content).toBe(LEDGER_ROLE.system);
    expect(declareCall.messages).toHaveLength(1 + 2 * 2 + 1);
    // user 消息里：本章新稿、上下文段（线索/角色名/目标）、字段说明和额外强调
    const task = declareCall.messages.at(-1)!.content;
    expect(task).toContain("【第 3 章 正文（待定稿）】");
    expect(task).toContain(DRAFT);
    expect(task).toContain("【已开着的线索");
    expect(task).toContain("T1 陈老师周五取书");
    expect(task).toContain("【本书已确立的角色名");
    expect(task).toContain("【已存在的主线/阶段目标");
    expect(task).toContain("只输出一个 JSON 对象");
    expect(task).toContain("同一件事只报一条");
    expect(task).toContain("resolvedForeshadowing");
    expect(task).toContain("aliasOf");
  });

  it("第 1 章：窗口只有角色说明，没有【上一章结尾】段（窗口里刚读过全文）", async () => {
    const dir = await makeBook([]);
    const { callModel, calls } = fakeModel(DECLARATION_JSON);
    const result = await declareChapterDeltaByLedger({ projectDir: dir, chapter: 1, draft: CH1, callModel });
    expect(result.cold).toBeUndefined();
    expect(result.outcome.status).toBe("model");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.messages).toHaveLength(2);
    // 字段说明里会提到「上一章结尾」这个词（continuityWithPrevious 的规则），但不能有真正附上的那一段。
    expect(calls[0]?.messages.at(-1)?.content).not.toContain("【上一章结尾（仅用于判断衔接");
  });

  it("要补的笔记超过 maxCatchUp → 冷窗口照记账（cold 带范围、并进 outcome.cold），不补笔记也不落盘", async () => {
    const dir = await makeBook([CH1, CH2]);
    const { callModel, calls } = fakeModel(DECLARATION_JSON);
    const result = await declareChapterDeltaByLedger({ projectDir: dir, chapter: 3, draft: DRAFT, callModel, maxCatchUp: 1 });
    expect(result.cold).toEqual({ notedThrough: 0, rawFrom: 1, rawTo: 2 });
    expect(result.outcome.status).toBe("model");
    expect(result.outcome.cold).toEqual({ notedThrough: 0, rawFrom: 1, rawTo: 2 });
    // 只发声明那一次调用（json:true），一个笔记都不写；agents/ 目录不该出现
    expect(calls).toHaveLength(1);
    expect(calls[0]!.json).toBe(true);
    expect(calls[0]!.messages[1]!.content).toContain("【第 1～2 章 定稿原文");
    expect(await stat(join(dir, "agents")).then(() => true, () => false)).toBe(false);
  });

  it("当场补了笔记（R5.2）→ waited 带补章范围并进 outcome，进度行标「记账在等它读完」读完即清", async () => {
    const dir = await makeBook([CH1, CH2]);
    const seenWhileWaiting: unknown[] = [];
    const { callModel } = fakeModel(DECLARATION_JSON);
    const wrapped: BrainCallModel = async (messages, options) => {
      if (!options.json) {
        // 补笔记的那一刻：进度行应标着「记账在等它读完」（R6.1：waiting 在进程内登记表里，读进度时合并显示）。
        seenWhileWaiting.push((await readReadersCatchUpStatus(dir)).roles.find((role) => role.role === "ledger"));
      }
      return callModel(messages, options);
    };
    const result = await declareChapterDeltaByLedger({ projectDir: dir, chapter: 3, draft: DRAFT, callModel: wrapped });
    expect(result.outcome.status).toBe("model");
    expect(result.waited).toMatchObject({ from: 1, to: 2 });
    expect(result.outcome.waited).toMatchObject({ from: 1, to: 2 });
    // 等读期间：标着「记账在等它读完」。
    expect(seenWhileWaiting[0]).toMatchObject({ role: "ledger", reading: true, done: 0, total: 2, waiting: "记账" });
    // 读完：reading 翻回 false、waiting 消失。
    await expect(readFile(join(dir, "agents", LEDGER_ROLE.id, "progress.json"), "utf-8").then((text) => JSON.parse(text)))
      .resolves.toMatchObject({ reading: false, done: 2, total: 2 });
    expect((await readReadersCatchUpStatus(dir)).roles.find((role) => role.role === "ledger")).not.toHaveProperty("waiting");
  });

  it("排在后台补读后面等（R6.1 新发现 1）→ 也算等过：等待中进度行标「记账在等它读完」，waited 覆盖补上的章", async () => {
    const dir = await makeBook([CH1, CH2]);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started = false;
    // 后台补读的假模型：第一次调用（写第 1 章笔记）就卡住，把记账员的锁拿在手里。
    const bg: BrainCallModel = async () => { started = true; await gate; return "笔记"; };
    const bgRound = startReaderCatchUp(dir, LEDGER_ROLE, 2, { callModel: bg });
    await vi.waitFor(() => expect(started).toBe(true), { timeout: 5_000 });
    // 并发记账（第 3 章定稿声明）：开口时一章笔记都还没有（waited.from=1），排在锁后面等。
    const { callModel } = fakeModel(DECLARATION_JSON);
    const resultPromise = declareChapterDeltaByLedger({ projectDir: dir, chapter: 3, draft: DRAFT, callModel });
    await vi.waitFor(async () => {
      expect((await readReadersCatchUpStatus(dir)).roles.find((role) => role.role === "ledger")).toMatchObject({ reading: true, waiting: "记账" });
    }, { timeout: 5_000 });
    release();
    const result = await resultPromise;
    expect(result.outcome.status).toBe("model");
    // 轮到它时笔记已经齐了（一个没补）：等的是谁补的不重要，开口时缺的第 1～2 章等完补上了就算等过。
    expect(result.waited).toMatchObject({ from: 1, to: 2 });
    expect(result.outcome.waited).toMatchObject({ from: 1, to: 2 });
    // 结束后 waiting 消失。
    expect((await readReadersCatchUpStatus(dir)).roles.find((role) => role.role === "ledger")).not.toHaveProperty("waiting");
    await bgRound;
  });

  it("补笔记失败 → fallback + 原因（已写下的笔记留着）", async () => {
    const dir = await makeBook([CH1, CH2]);
    let count = 0;
    const callModel: BrainCallModel = async (messages, options) => {
      count += 1;
      if (!options.json) {
        if (count === 2) throw new Error("限流了");
        return "笔记";
      }
      return DECLARATION_JSON;
    };
    const result = await declareChapterDeltaByLedger({ projectDir: dir, chapter: 3, draft: DRAFT, callModel });
    expect(result.cold).toBeUndefined();
    expect(result.outcome.status).toBe("fallback");
    expect(result.outcome.reason).toContain("记账员读前文没成");
    expect(await readFile(join(dir, "agents", LEDGER_ROLE.id, "notes", "0001.json"), "utf-8")).toContain("笔记");
  });

  it("声明输出不是 JSON → fallback + 原因", async () => {
    const dir = await makeBook([CH1]);
    const { callModel } = fakeModel("这不是 JSON，只是随口一说。");
    const result = await declareChapterDeltaByLedger({ projectDir: dir, chapter: 2, draft: DRAFT, callModel });
    expect(result.outcome.status).toBe("fallback");
    expect(result.outcome.reason).toContain("无法解析成结构化 JSON");
  });

  it("声明调用抛错 → fallback + 原因，不向上抛", async () => {
    const dir = await makeBook([CH1]);
    const { callModel } = fakeModel(new Error("超时了"));
    const result = await declareChapterDeltaByLedger({ projectDir: dir, chapter: 2, draft: DRAFT, callModel });
    expect(result.outcome.status).toBe("fallback");
    expect(result.outcome.reason).toContain("记账员声明模型调用失败");
    expect(result.outcome.reason).toContain("超时了");
  });

  it("正文为空 → 直接 fallback，不调模型", async () => {
    const dir = await makeBook([CH1]);
    const { callModel, calls } = fakeModel(DECLARATION_JSON);
    const result = await declareChapterDeltaByLedger({ projectDir: dir, chapter: 2, draft: "  \n", callModel });
    expect(result.outcome.status).toBe("fallback");
    expect(calls).toHaveLength(0);
  });

  it("声明的字段契约用 chapter-delta-declaration 的确定性工具（buildChapterDeltaSystemSpec 原文出现在消息里）", async () => {
    const dir = await makeBook([CH1]);
    const { callModel, calls } = fakeModel(DECLARATION_JSON);
    await declareChapterDeltaByLedger({ projectDir: dir, chapter: 2, draft: DRAFT, callModel });
    const { buildChapterDeltaSystemSpec } = await import("../agent/tools/chapter-delta-declaration.js");
    const spec = buildChapterDeltaSystemSpec();
    const declarationCall = calls.find((call) => call.json)!;
    expect(declarationCall.messages.at(-1)?.content).toContain(spec);
  });
});
