// @vitest-environment node
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrainCallModel } from "../../brain/index.js";
import { makeHomeTempDir } from "../../lib/home-test-tmp.js";
import type { CheckCallModel } from "./check-chapter.js";
import { checkChapterBody } from "./check-service.js";

const CH1 = "客人把怀表放在绒布上就走了。周婶说这表是前天送来的。";
const CH2 = "周婶端着茶进来。林舟把怀表锁进了柜台下的抽屉。林溪说她后天走。";
const BODY = "林舟一早开门。他从工作台上拿起那块怀表，表盖还开着。周婶在门口喊他。";
const LEDGER_SENTENCE = "他翻开扉页，看着那两行字——林秋，一九八五年春——看了很久。";

const WATCH = { quote: "他从工作台上拿起那块怀表", earlierQuote: "林舟把怀表锁进了柜台下的抽屉", earlierChapter: 2, reason: "怀表锁在抽屉里，本章却在工作台上" };
const AUNT = { quote: "周婶在门口喊他", earlierQuote: "周婶端着茶进来", earlierChapter: 2, reason: "周婶的位置对不上" };

async function makeBook(chapters = 2): Promise<string> {
  const dir = await makeHomeTempDir("check-service-");
  await mkdir(join(dir, "chapters"), { recursive: true });
  for (let chapter = 1; chapter <= chapters; chapter += 1) {
    const text = chapter === 1 ? CH1 : chapter === 2 ? CH2 : `第${chapter}章的内容，林舟照常开门。`;
    await writeFile(join(dir, "chapters", `${String(chapter).padStart(4, "0")}.md`), `# 第${chapter}章\n\n${text}\n`, "utf-8");
  }
  return dir;
}

async function writeLedger(dir: string): Promise<void> {
  await mkdir(join(dir, "story"), { recursive: true });
  await writeFile(join(dir, "story", "fact-ledger.json"), JSON.stringify({
    version: "v0",
    facts: [{ id: "fact-2-6", chapter: 2, text: "扉页写着林秋，一九八七年春", source: "auto", quote: "扉页上写着两行字：林秋，一九八七年春。", subject: "城南旧事", kind: "hard" }],
  }), "utf-8");
}

/** 旧路假模型：通读「盯东西」那遍报怀表，复核一律判确定。记下调用次数。 */
function comboModel() {
  const callModel = vi.fn<CheckCallModel>(async (messages) => {
    const system = messages[0]!.content;
    if (system.includes("复核编辑")) return JSON.stringify({ verdicts: [{ id: "K1", verdict: "sure" }, { id: "K2", verdict: "sure" }] });
    if (system.includes("连续性审读员") && messages[1]!.content.includes("只盯东西")) return JSON.stringify({ contradictions: [WATCH] });
    return JSON.stringify({ contradictions: [], claims: [] });
  });
  return callModel;
}

/** 核账员假模型：记笔记回一句；核账那三遍，「盯人」那遍报周婶。 */
function readerModel(confidence = "sure") {
  const calls = { notes: 0, checks: 0 };
  const callModel: BrainCallModel = async (messages, options) => {
    if (!options.json) {
      calls.notes += 1;
      return "笔记";
    }
    calls.checks += 1;
    const last = messages.at(-1)!.content;
    return JSON.stringify({ checks: [], contradictions: last.includes("这一遍只盯人") ? [{ ...AUNT, confidence }] : [] });
  };
  return { callModel, calls };
}

beforeEach(() => {
  vi.stubEnv("STORY_CHECKER", undefined as unknown as string);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const notesCount = async (dir: string) => (await readdir(join(dir, "agents", "checker", "notes")).catch(() => [] as string[])).filter((name) => name.endsWith(".json")).length;

describe("核账服务：新旧两路的开关", () => {
  it("缺省走旧路（combo）：用旧的模型调用，不碰核账员，也不写读书笔记", async () => {
    const dir = await makeBook();
    const combo = comboModel();
    const reader = readerModel();
    const result = await checkChapterBody(dir, 3, BODY, combo, { readerCallModel: reader.callModel });
    expect(result.sure.map((item) => item.quote)).toEqual([WATCH.quote]);
    expect(combo).toHaveBeenCalled();
    expect(reader.calls).toEqual({ notes: 0, checks: 0 });
    expect(await notesCount(dir)).toBe(0);
  });

  it("engine: reader 走核账员：补前文笔记、三遍核账，旧路的模型一次不调", async () => {
    const dir = await makeBook();
    const combo = comboModel();
    const reader = readerModel();
    const result = await checkChapterBody(dir, 3, BODY, combo, { engine: "reader", readerCallModel: reader.callModel });
    expect(result.ok).toBe(true);
    expect(result.sure.map((item) => item.quote)).toEqual([AUNT.quote]);
    expect(result.summary).toContain("确定对不上 1 处");
    expect(result.summary).not.toContain("旧核账");
    expect(combo).not.toHaveBeenCalled();
    expect(reader.calls).toEqual({ notes: 2, checks: 3 });
    expect(await notesCount(dir)).toBe(2);
  });

  it("环境变量 STORY_CHECKER=reader 也切到核账员；options.engine 优先于环境变量", async () => {
    vi.stubEnv("STORY_CHECKER", "reader");
    const dir = await makeBook();
    const reader = readerModel();
    const viaEnv = await checkChapterBody(dir, 3, BODY, comboModel(), { readerCallModel: reader.callModel });
    expect(viaEnv.sure.map((item) => item.quote)).toEqual([AUNT.quote]);
    const combo = comboModel();
    const viaOption = await checkChapterBody(dir, 3, `${BODY}。`, combo, { engine: "combo", readerCallModel: reader.callModel });
    expect(viaOption.sure.map((item) => item.quote)).toContain(WATCH.quote);
    expect(combo).toHaveBeenCalled();
  });

  it("核账员这一路：账本数字对账照跑、排在前面；核账员的「可能」排在「确定」后面", async () => {
    const dir = await makeBook();
    await writeLedger(dir);
    const reader = readerModel("maybe");
    const result = await checkChapterBody(dir, 3, `${BODY}${LEDGER_SENTENCE}`, comboModel(), { engine: "reader", readerCallModel: reader.callModel });
    expect(result.sure.map((item) => item.quote)).toEqual([LEDGER_SENTENCE]);
    expect(result.sure[0]).toMatchObject({ earlierChapter: 2 });
    expect(result.maybe.map((item) => item.quote)).toEqual([AUNT.quote]);
  });

  it("核账员这一路：上次的问题两边原句还在就照带，把握沿用上次（不随这次的运气跳）", async () => {
    const dir = await makeBook();
    await checkChapterBody(dir, 3, BODY, comboModel(), { engine: "reader", readerCallModel: readerModel("sure").callModel });
    // 正文改了一处无关的句子；这次核账员把同一处报成「可能」，沿用上次的「确定」
    const second = await checkChapterBody(dir, 3, `${BODY}林舟低头擦着柜台。`, comboModel(), { engine: "reader", readerCallModel: readerModel("maybe").callModel });
    expect(second.reused).toBe(false);
    expect(second.sure.map((item) => item.quote)).toEqual([AUNT.quote]);
    expect(second.maybe).toEqual([]);
    // 作者把那句改掉了：不再带
    const quiet: BrainCallModel = async (_messages, options) => (options.json ? JSON.stringify({ contradictions: [] }) : "笔记");
    const third = await checkChapterBody(dir, 3, BODY.replace("周婶在门口喊他", "周婶在门外等着"), comboModel(), { engine: "reader", readerCallModel: quiet });
    expect(third.sure).toEqual([]);
  });

  it("核账员三遍全没跑成：如实说没跑成，不记进核账记忆", async () => {
    const dir = await makeBook();
    const broken: BrainCallModel = async (_messages, options) => {
      if (!options.json) return "笔记";
      throw new Error("网关挂了");
    };
    const result = await checkChapterBody(dir, 3, BODY, comboModel(), { engine: "reader", readerCallModel: broken });
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("核账没跑成");
    expect(result.failures.some((line) => line.includes("没跑成"))).toBe(true);
    const retry = await checkChapterBody(dir, 3, BODY, comboModel(), { engine: "reader", readerCallModel: readerModel().callModel });
    expect(retry.reused).toBe(false);
    expect(retry.ok).toBe(true);
  });
});

describe("核账服务：核账记忆不串", () => {
  it("同一路正文和前文没改 → 直接用上次结果（不调模型）", async () => {
    const dir = await makeBook();
    const reader = readerModel();
    await checkChapterBody(dir, 3, BODY, comboModel(), { engine: "reader", readerCallModel: reader.callModel });
    const checksBefore = reader.calls.checks;
    const again = await checkChapterBody(dir, 3, BODY, comboModel(), { engine: "reader", readerCallModel: reader.callModel });
    expect(again.reused).toBe(true);
    expect(again.summary).toContain("结果同上次");
    expect(reader.calls.checks).toBe(checksBefore);
  });

  it("切换引擎：不复用另一路的结果（核账员 → 旧路 → 核账员各自重新核）", async () => {
    const dir = await makeBook();
    const reader = readerModel();
    const first = await checkChapterBody(dir, 3, BODY, comboModel(), { engine: "reader", readerCallModel: reader.callModel });
    expect(first.reused).toBe(false);
    const combo = comboModel();
    const second = await checkChapterBody(dir, 3, BODY, combo, { engine: "combo", readerCallModel: reader.callModel });
    expect(second.reused).toBe(false);
    expect(combo).toHaveBeenCalled();
    expect(second.sure.map((item) => item.quote)).toContain(WATCH.quote);
    const third = await checkChapterBody(dir, 3, BODY, comboModel(), { engine: "reader", readerCallModel: reader.callModel });
    expect(third.reused).toBe(false);
    expect(third.sure.map((item) => item.quote)).toContain(AUNT.quote);
    const fourth = await checkChapterBody(dir, 3, BODY, comboModel(), { engine: "reader", readerCallModel: reader.callModel });
    expect(fourth.reused).toBe(true);
  });
});

describe("核账服务：核账员还没读完前文（T5 后台补读）", () => {
  it("要补的笔记超过 10 章 → 如实说读到第几章、这次没核；旧路一次不调，笔记在后台补；补好后下次走核账员", async () => {
    const dir = await makeBook(12);
    const combo = comboModel();
    const reader = readerModel();
    const first = await checkChapterBody(dir, 13, BODY, combo, { engine: "reader", readerCallModel: reader.callModel });
    // 不拿旧核账顶、也不装作核过：ok=false，summary 说清读到第几章。
    expect(first.ok).toBe(false);
    expect(first.summary).toContain("还在读这本书的前文：第 0 / 12 章");
    expect(first.summary).toContain("这次没有核");
    expect(first.sure).toEqual([]);
    expect(first.maybe).toEqual([]);
    expect(combo).not.toHaveBeenCalled();
    expect(reader.calls.checks).toBe(0);
    // 笔记在后台按顺序补（每个角色一条队列），进度落盘给界面
    await vi.waitFor(async () => expect(await notesCount(dir)).toBe(12), { timeout: 5_000 });
    const readProgress = () => readFile(join(dir, "agents", "checker", "progress.json"), "utf-8").then((text) => JSON.parse(text));
    await vi.waitFor(async () => expect(await readProgress()).toMatchObject({ role: "checker", reading: false, done: 12, total: 12 }), { timeout: 5_000 });
    // 补好了：同一份正文再核就走核账员（这次没核不写核账记忆，不会拿「没核」复用）
    const second = await checkChapterBody(dir, 13, BODY, comboModel(), { engine: "reader", readerCallModel: reader.callModel });
    expect(second.reused).toBe(false);
    expect(second.ok).toBe(true);
    expect(second.sure.map((item) => item.quote)).toContain(AUNT.quote);
    expect(reader.calls.checks).toBe(3);
  });

  it("后台补笔记失败：只 warn、进度如实记错；这次的结果不受影响", async () => {
    const dir = await makeBook(12);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const broken: BrainCallModel = async () => { throw new Error("限流了"); };
    const result = await checkChapterBody(dir, 13, BODY, comboModel(), { engine: "reader", readerCallModel: broken });
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("还在读");
    await vi.waitFor(() => expect(warn).toHaveBeenCalled(), { timeout: 5_000 });
    // 读到哪里记哪里：一章都没写成就是 0 / 12，错误原因落盘（下次接着补）
    const progress = JSON.parse(await readFile(join(dir, "agents", "checker", "progress.json"), "utf-8"));
    expect(progress).toMatchObject({ reading: false, done: 0, total: 12 });
    expect(progress.error).toContain("限流了");
    warn.mockRestore();
  });
});
