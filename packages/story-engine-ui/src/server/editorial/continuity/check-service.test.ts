// @vitest-environment node
// 编辑部 R3 后核账只有核账员一路（combo 旧路已删）：这里测服务层的收口——账本对账并进、核账记忆、
// 三遍失败如实说、补笔记太多时「还在读前文」的 T5 语义。核账员本身的行为见 editorial/checker.test.ts。
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { BrainCallModel } from "../index.js";
import { CHECKER_ROLE, ensureReaderWindow, readReadersCatchUpStatus, startReaderCatchUp } from "../index.js";
import { makeHomeTempDir } from "../../lib/home-test-tmp.js";
import { checkChapterBody } from "./check-service.js";
import { readEarlierChapters, type ContinuityIssueV2 } from "./check-chapter.js";
import { hashBody, hashEarlier, writeCheckMemory } from "./check-memory.js";
import { addDismissal } from "./dismissals.js";

const CH1 = "客人把怀表放在绒布上就走了。周婶说这表是前天送来的。";
const CH2 = "周婶端着茶进来。林舟把怀表锁进了柜台下的抽屉。林溪说她后天走。";
const BODY = "林舟一早开门。他从工作台上拿起那块怀表，表盖还开着。周婶在门口喊他。";
const LEDGER_SENTENCE = "他翻开扉页，看着那两行字——林秋，一九八五年春——看了很久。";

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

/** 核账员假模型：记笔记回一句；三遍核账里「盯人」那遍报周婶，报了东西就再发一轮自复核（按 verdicts 表回）。 */
function readerModel(confidence = "sure", verdict = confidence) {
  const calls = { notes: 0, checks: 0, reviews: 0 };
  const callModel: BrainCallModel = async (messages, options) => {
    if (!options.json) {
      calls.notes += 1;
      return "笔记";
    }
    const last = messages.at(-1)!.content;
    if (last.includes("你刚才核完报了")) {
      calls.reviews += 1;
      const ids = [...last.matchAll(/【(K\d+)】/gu)].map((match) => match[1]);
      return JSON.stringify({ verdicts: ids.map((id) => ({ id, verdict })) });
    }
    calls.checks += 1;
    return JSON.stringify({ checks: [], contradictions: last.includes("这一遍只盯人") ? [{ ...AUNT, confidence }] : [] });
  };
  return { callModel, calls };
}

const notesCount = async (dir: string) => (await readdir(join(dir, "agents", "checker", "notes")).catch(() => [] as string[])).filter((name) => name.endsWith(".json")).length;

describe("核账服务（核账员一路）", () => {
  it("核一章：先补前文笔记，再三遍核账（每遍两次）加一轮自复核，问题带把握进结果", async () => {
    const dir = await makeBook();
    const reader = readerModel();
    const result = await checkChapterBody(dir, 3, BODY, { readerCallModel: reader.callModel });
    expect(result.ok).toBe(true);
    expect(result.sure.map((item) => item.quote)).toEqual([AUNT.quote]);
    expect(result.summary).toContain("确定对不上 1 处");
    expect(result.summary).toContain(AUNT.quote);
    // 结论那句不带逐条清单（重构 P6：清单在核账卡和稿纸划线上）。
    expect(result.headline).toContain("确定对不上 1 处");
    expect(result.headline).not.toContain(AUNT.quote);
    expect(reader.calls).toEqual({ notes: 2, checks: 6, reviews: 1 });
    expect(await notesCount(dir)).toBe(2);
  });

  it("账本数字对账照跑、排在前面；核账员的「可能」排在「确定」后面", async () => {
    const dir = await makeBook();
    await writeLedger(dir);
    const reader = readerModel("maybe");
    const result = await checkChapterBody(dir, 3, `${BODY}${LEDGER_SENTENCE}`, { readerCallModel: reader.callModel });
    expect(result.sure.map((item) => item.quote)).toEqual([LEDGER_SENTENCE]);
    expect(result.sure[0]).toMatchObject({ earlierChapter: 2 });
    expect(result.maybe.map((item) => item.quote)).toEqual([AUNT.quote]);
  });

  it("上次的问题两边原句还在就照带，把握沿用上次（不随这次的运气跳）", async () => {
    const dir = await makeBook();
    await checkChapterBody(dir, 3, BODY, { readerCallModel: readerModel("sure").callModel });
    // 正文改了一处无关的句子；这次核账员把同一处报成「可能」，沿用上次的「确定」
    const second = await checkChapterBody(dir, 3, `${BODY}林舟低头擦着柜台。`, { readerCallModel: readerModel("maybe").callModel });
    expect(second.reused).toBe(false);
    expect(second.sure.map((item) => item.quote)).toEqual([AUNT.quote]);
    expect(second.maybe).toEqual([]);
    // 作者把那句改掉了：不再带
    const quiet: BrainCallModel = async (_messages, options) => (options.json ? JSON.stringify({ contradictions: [] }) : "笔记");
    const third = await checkChapterBody(dir, 3, BODY.replace("周婶在门口喊他", "周婶在门外等着"), { readerCallModel: quiet });
    expect(third.sure).toEqual([]);
  });

  it("对设定本的条目改稿后照带（以前拿设定原文去正文里找、永远带不过来）；设定本改了就不带", async () => {
    const dir = await makeBook();
    await mkdir(join(dir, "story"), { recursive: true });
    const writeCard = (anchor: string) => writeFile(join(dir, "story", "character-bible.json"), JSON.stringify({
      version: "v0",
      characters: [{ id: "char-z1", name: "周婶", appearanceAnchors: [anchor] }],
    }), "utf-8");
    await writeCard("左腿有旧伤");
    const earlier = await readEarlierChapters(dir, 3);
    const setting: ContinuityIssueV2 = { quote: "周婶在门口喊他。", earlierQuote: "周婶……外貌：左腿有旧伤", earlierChapter: 3, reason: "设定写左腿", kind: "event", confidence: "sure", againstSetting: { label: "人物卡" } };
    await writeCheckMemory(dir, { chapter: 3, bodyHash: hashBody(BODY), earlierHash: hashEarlier(earlier, []), issues: [setting] });
    const quiet: BrainCallModel = async (_messages, options) => (options.json ? JSON.stringify({ checks: [], contradictions: [] }) : "笔记");
    const edited = `${BODY}林舟低头擦着柜台。`;
    const carried = await checkChapterBody(dir, 3, edited, { readerCallModel: quiet });
    expect(carried.sure.map((item) => item.quote)).toEqual([setting.quote]);
    await writeCard("右腿有旧伤");
    const changed = await checkChapterBody(dir, 3, `${edited}门外起风了。`, { readerCallModel: quiet });
    expect(changed.sure).toEqual([]);
  });

  it("核账员三遍全没跑成：如实说没跑成，不记进核账记忆", async () => {
    const dir = await makeBook();
    const broken: BrainCallModel = async (_messages, options) => {
      if (!options.json) return "笔记";
      throw new Error("网关挂了");
    };
    const result = await checkChapterBody(dir, 3, BODY, { readerCallModel: broken });
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("核账没跑成");
    expect(result.failures.some((line) => line.includes("没跑成"))).toBe(true);
    const retry = await checkChapterBody(dir, 3, BODY, { readerCallModel: readerModel().callModel });
    expect(retry.reused).toBe(false);
    expect(retry.ok).toBe(true);
  });
});

describe("核账服务：核账记忆", () => {
  it("正文和前文没改 → 直接用上次结果（不调模型）", async () => {
    const dir = await makeBook();
    const reader = readerModel();
    await checkChapterBody(dir, 3, BODY, { readerCallModel: reader.callModel });
    const checksBefore = reader.calls.checks;
    const again = await checkChapterBody(dir, 3, BODY, { readerCallModel: reader.callModel });
    expect(again.reused).toBe(true);
    expect(again.summary).toContain("结果同上次");
    expect(reader.calls.checks).toBe(checksBefore);
  });

  it("正文改了 → 不复用上次结果，重新核", async () => {
    const dir = await makeBook();
    const reader = readerModel();
    await checkChapterBody(dir, 3, BODY, { readerCallModel: reader.callModel });
    const after = await checkChapterBody(dir, 3, `${BODY}林舟低头擦着柜台。`, { readerCallModel: reader.callModel });
    expect(after.reused).toBe(false);
    expect(reader.calls.checks).toBeGreaterThan(3);
  });
});

describe("核账服务：核账员还没读完前文（R4.4 冷窗口兜底 + 后台补读）", () => {
  it("要补的笔记超过 10 章 → 冷窗口照核（ok:true、coverage 说清范围），笔记后台接着补；补好后下次按全书核", async () => {
    const dir = await makeBook(12);
    const reader = readerModel();
    const first = await checkChapterBody(dir, 13, BODY, { readerCallModel: reader.callModel });
    // 不跳过也不装作核了全书：核了（ok:true、问题照出），范围如实说。
    expect(first.ok).toBe(true);
    expect(first.coverage).toEqual({ mode: "cold", notedThrough: 0, rawFrom: 5, rawTo: 12 });
    expect(first.summary).toContain("核账员还没读完全书（第 0 / 12 章）");
    expect(first.summary).toContain("第 5～12 章原文 + 账本");
    expect(first.summary).toContain("更早的细节可能漏");
    expect(first.sure.map((item) => item.quote)).toContain(AUNT.quote);
    expect(first.reused).toBe(false);
    // 冷窗口不写核账记忆（小范围的结果不能当全书核过来缓存）；笔记在后台按顺序补，进度落盘给界面
    await vi.waitFor(async () => expect(await notesCount(dir)).toBe(12), { timeout: 5_000 });
    const readProgress = () => readFile(join(dir, "agents", "checker", "progress.json"), "utf-8").then((text) => JSON.parse(text));
    await vi.waitFor(async () => expect(await readProgress()).toMatchObject({ role: "checker", reading: false, done: 12, total: 12 }), { timeout: 5_000 });
    // 补好了：同一份正文再核就是读完全书的核账员（没有 coverage，也不会拿冷窗口结果复用）
    const second = await checkChapterBody(dir, 13, BODY, { readerCallModel: reader.callModel });
    expect(second.reused).toBe(false);
    expect(second.ok).toBe(true);
    expect(second.coverage).toBeUndefined();
    expect(second.sure.map((item) => item.quote)).toContain(AUNT.quote);
  });

  it("R4.3 分母统一：核已定稿章的稿子时，回执和进度行同口径（共 y 章＝已定稿章数）", async () => {
    const dir = await makeBook(12);
    const reader = readerModel();
    const result = await checkChapterBody(dir, 12, BODY, { readerCallModel: reader.callModel });
    expect(result.ok).toBe(true);
    expect(result.coverage).toEqual({ mode: "cold", notedThrough: 0, rawFrom: 4, rawTo: 11 });
    // 旧口径的分母是「本章 − 1」＝11（验收 3.3 里 57 对 58 就是这个差）；统一成已定稿章数 12。
    expect(result.summary).toContain("第 0 / 12 章");
    // 后台补读也按统一后的总数排（补齐 12 章，读完就能按读完全书核）。
    await vi.waitFor(async () => expect(await notesCount(dir)).toBe(12), { timeout: 5_000 });
  });

  it("冷窗口三遍全失败：如实说没核成（ok:false + 范围），后台补读失败只 warn、进度如实记错", async () => {
    const dir = await makeBook(12);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const broken: BrainCallModel = async () => { throw new Error("限流了"); };
    const result = await checkChapterBody(dir, 13, BODY, { readerCallModel: broken });
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("核账没跑成");
    expect(result.summary).toContain("还没读完全书");
    await vi.waitFor(() => expect(warn).toHaveBeenCalled(), { timeout: 5_000 });
    // 读到哪里记哪里：一章都没写成就是 0 / 12，错误原因落盘（下次接着补）。
    // 补读失败是先 warn、再落盘，机器忙时要等落盘那一下。
    await vi.waitFor(async () => {
      const progress = JSON.parse(await readFile(join(dir, "agents", "checker", "progress.json"), "utf-8"));
      expect(progress).toMatchObject({ reading: false, done: 0, total: 12 });
      expect(progress.error).toContain("限流了");
    }, { timeout: 5_000 });
    warn.mockRestore();
  });
});

describe("核账服务：等读标注与回执（R5.2 必做）", () => {
  it("当场补了笔记（缺 ≤2）→ 回执加「这次先等核账员读完第 a～b 章再核」（不报用时），结果带 waited；进度盘上等读已收尾", async () => {
    const dir = await makeBook(4);
    // 预置第 1 章笔记（产品同一个角色，哈希对得上）；核第 4 章时缺第 2～3 章 → 当场补（缺 2 ≤ 2）。
    await ensureReaderWindow({ projectDir: dir, role: CHECKER_ROLE, upTo: 1, callModel: async () => "笔记" });
    const seenWhileWaiting: unknown[] = [];
    const reader = readerModel();
    const wrapped: BrainCallModel = async (messages, options) => {
      if (!options.json) {
        // 补笔记的那一刻：进度行应标着「核账在等它读完」（R6.1：waiting 在进程内登记表里，读进度时合并显示）。
        seenWhileWaiting.push((await readReadersCatchUpStatus(dir)).roles.find((role) => role.role === "checker"));
      }
      return reader.callModel(messages, options);
    };
    const result = await checkChapterBody(dir, 4, BODY, { readerCallModel: wrapped });
    expect(result.ok).toBe(true);
    expect(result.waited).toMatchObject({ from: 2, to: 3 });
    expect(result.summary).toContain("这次先等核账员读完第 2～3 章再核");
    expect(result.summary).toContain("再核");
    expect(result.coverage).toBeUndefined();
    // 等读期间：reading:true、waiting:「核账」；分母按 R5.3 现算成已定稿章数（这本书定稿到第 4 章，盘上记的是 3）。
    expect(seenWhileWaiting[0]).toMatchObject({ role: "checker", reading: true, done: 1, total: 4, waiting: "核账" });
    // 收尾：reading:false、waiting 消失。
    await expect(readFile(join(dir, "agents", "checker", "progress.json"), "utf-8").then((text) => JSON.parse(text)))
      .resolves.toMatchObject({ reading: false, done: 3, total: 3 });
    expect((await readReadersCatchUpStatus(dir)).roles.find((role) => role.role === "checker")).not.toHaveProperty("waiting");
  });

  it("缺 9～10 章仍当场补读（老行为）：等读一句照加", async () => {
    const dir = await makeBook(12);
    await ensureReaderWindow({ projectDir: dir, role: CHECKER_ROLE, upTo: 2, callModel: async () => "笔记" });
    const reader = readerModel();
    const result = await checkChapterBody(dir, 13, BODY, { readerCallModel: reader.callModel });
    expect(result.ok).toBe(true);
    expect(result.coverage).toBeUndefined();
    expect(result.waited).toMatchObject({ from: 3, to: 12 });
    expect(result.summary).toContain("这次先等核账员读完第 3～12 章再核");
  });

  it("笔记本来就齐 → 没等就不说（R6.1）：不带 waited、回执不提等、进度不标在等", async () => {
    const dir = await makeBook(4);
    // 后台补读先把 1～3 章一口气读完（读到第 3 章收尾），再核第 4 章：开口时笔记就齐。
    await startReaderCatchUp(dir, CHECKER_ROLE, 3, { callModel: async () => "笔记" });
    const reader = readerModel();
    const result = await checkChapterBody(dir, 4, BODY, { readerCallModel: reader.callModel });
    expect(result.ok).toBe(true);
    expect(result.waited).toBeUndefined();
    expect(result.summary).not.toContain("先等核账员读完");
    expect((await readReadersCatchUpStatus(dir)).roles.find((role) => role.role === "checker")).not.toHaveProperty("waiting");
  });
});

describe("核账服务：排在后台补读后面等（R6.1，新发现 1）", () => {
  it("后台拿着核账员的锁读第 1～10 章时点核账（第 11 章）→ 等待中进度行标「核账在等它读完」，回执如实说等过", async () => {
    const dir = await makeBook(11);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started = false;
    // 后台补读的假模型：第一次调用（写第 1 章笔记）就卡住，把核账员的锁拿在手里。
    const bg: BrainCallModel = async () => { started = true; await gate; return "笔记"; };
    const bgRound = startReaderCatchUp(dir, CHECKER_ROLE, 10, { callModel: bg });
    await vi.waitFor(() => expect(started).toBe(true), { timeout: 5_000 });
    // 并发点核账（第 11 章）：开口时一章笔记都还没有（waited.from=1），排在锁后面等。
    const reader = readerModel();
    const resultPromise = checkChapterBody(dir, 11, BODY, { readerCallModel: reader.callModel });
    await vi.waitFor(async () => {
      expect((await readReadersCatchUpStatus(dir)).roles.find((role) => role.role === "checker")).toMatchObject({ reading: true, waiting: "核账" });
    }, { timeout: 5_000 });
    release();
    const result = await resultPromise;
    expect(result.ok).toBe(true);
    // 等的是谁补的不重要：开口时缺的第 1～10 章等完都补上了，就算等过。
    expect(result.waited).toMatchObject({ from: 1, to: 10 });
    expect(result.summary).toContain("这次先等核账员读完第 1～10 章再核");
    expect(result.summary).toContain("再核");
    expect(result.coverage).toBeUndefined();
    // 结束后 waiting 消失。
    expect((await readReadersCatchUpStatus(dir)).roles.find((role) => role.role === "checker")).not.toHaveProperty("waiting");
    await bgRound;
  });
});

describe("核账服务：前面章节没改的错不再每章重报（P7 后）", () => {
  // 第 2 章那句和设定本对不上（作者一直没改），核第 4 章时第四遍又把它抓出来（fixChapter=2）。
  // 设定原文每次抄的片段不一样，只认「同一句正文、都是对设定」。
  const OLD: ContinuityIssueV2 = {
    quote: "林舟把怀表锁进了柜台下的抽屉",
    earlierQuote: "怀表：一直摆在店里的玻璃柜里",
    earlierChapter: 2,
    fixChapter: 2,
    reason: "设定说怀表摆在玻璃柜里",
    kind: "event",
    confidence: "sure",
    againstSetting: { label: "资产" },
  };
  const TOLD: ContinuityIssueV2 = { ...OLD, quote: "林舟把怀表锁进了柜台下的抽屉。", earlierQuote: "玻璃柜里摆着那块怀表，从不收起", fixChapter: undefined };
  const CURRENT: ContinuityIssueV2 = { ...AUNT, quote: "周婶在门口喊他", kind: "event", confidence: "sure" };

  /** 第 4 章的核账记忆和这次的正文、前文对得上 → 走复用，结果就是这两条。 */
  async function bookWithChapter4Memory(): Promise<string> {
    const dir = await makeBook(3);
    const earlier = await readEarlierChapters(dir, 4);
    await writeCheckMemory(dir, { chapter: 4, bodyHash: hashBody(BODY), earlierHash: hashEarlier(earlier, []), issues: [CURRENT, OLD] });
    return dir;
  }

  it("之前核第 2 章报过 → 不算第 4 章的问题，结论只提一句、条目进 earlierOpen", async () => {
    const dir = await bookWithChapter4Memory();
    await writeCheckMemory(dir, { chapter: 2, bodyHash: "x", earlierHash: "y", issues: [TOLD] });
    const result = await checkChapterBody(dir, 4, BODY);
    expect(result.reused).toBe(true);
    expect(result.sure.map((item) => item.quote)).toEqual(["周婶在门口喊他"]);
    expect(result.earlierOpen.map((item) => item.fixChapter)).toEqual([2]);
    expect(result.headline).toContain("确定对不上 1 处");
    expect(result.headline).toContain("第 2 章还有 1 处之前报过、还没改");
  });

  it("核第 3 章时报过（第 2 章没核过）也算报过", async () => {
    const dir = await bookWithChapter4Memory();
    await writeCheckMemory(dir, { chapter: 3, bodyHash: "x", earlierHash: "y", issues: [OLD] });
    const result = await checkChapterBody(dir, 4, BODY);
    expect(result.earlierOpen).toHaveLength(1);
    expect(result.sure).toHaveLength(1);
  });

  it("没报过（前面那章没核过、也没别的章报过）→ 照常当确定报一次", async () => {
    const dir = await bookWithChapter4Memory();
    const result = await checkChapterBody(dir, 4, BODY);
    expect(result.sure.map((item) => item.fixChapter)).toEqual([undefined, 2]);
    expect(result.earlierOpen).toEqual([]);
    expect(result.headline).not.toContain("之前报过");
  });

  it("第 1 章（错所在章之前）的核账记忆里有同一句不算报过", async () => {
    const dir = await bookWithChapter4Memory();
    await writeCheckMemory(dir, { chapter: 1, bodyHash: "x", earlierHash: "y", issues: [TOLD] });
    const result = await checkChapterBody(dir, 4, BODY);
    expect(result.earlierOpen).toEqual([]);
  });

  it("「不是问题」记在错所在那章 → 以后核哪章都不再报；设定原文抄法不同也认", async () => {
    const dir = await bookWithChapter4Memory();
    await addDismissal(dir, { chapter: 2, quote: TOLD.quote, earlierQuote: TOLD.earlierQuote, againstSetting: true });
    const result = await checkChapterBody(dir, 4, BODY);
    expect(result.dismissed).toBe(1);
    expect([...result.sure, ...result.maybe, ...result.earlierOpen].map((item) => item.quote)).toEqual(["周婶在门口喊他"]);
  });

  it("老记录（标在核的那章、没带设定标记）照旧认：同一章、两边原句都对得上", async () => {
    const dir = await bookWithChapter4Memory();
    await addDismissal(dir, { chapter: 4, quote: OLD.quote, earlierQuote: OLD.earlierQuote });
    const result = await checkChapterBody(dir, 4, BODY);
    expect(result.dismissed).toBe(1);
  });
});
