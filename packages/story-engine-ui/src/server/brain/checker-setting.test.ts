// @vitest-environment node
// R7.3 设定本进核账：人物卡 / 地点 / 资产 / 世界规则的硬设定拼一份「设定」进核账窗口；
// 模型引的设定原文照样经代码核对（settingQuoteLabel / parseSettingIssues），抄不出的不收；
// 当前章和设定一致、前文某章和设定不一致时，问题指向前文那章（fixChapter），别让作者把对的改成错的。
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import { checkChapterByReader, checkTask, dropMisdirectedBySetting, parseSettingChecks, parseSettingIssues, parseVerdicts, selfReviewTask, settingCheckTask } from "./checker.js";
import { foundationMessage, readFoundationDigest, settingQuoteLabel } from "./foundation-digest.js";
import type { BrainCallModel, BrainMessage } from "./reader-window.js";
import type { ContinuityIssueV2, EarlierText } from "../agent/continuity-v2/check-chapter.js";

const llmMocks = vi.hoisted(() => ({
  resolveConfiguredChatModel: vi.fn(),
  streamChatModelToText: vi.fn(),
}));
vi.mock("../lib/llm-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/llm-client.js")>()),
  ...llmMocks,
}));

const CH1 = "老周把铜盒收进抽屉。他说爷爷三年前就把钥匙托给了他。";
const CH3 = "陆川想了想，说沈师傅走了也有五年了。";
const BODY = "沈青禾上了钟楼。陆川说她爷爷走了五年。";
const CARD_LINE = "爷爷沈敬山：三年前过世，生前是青石镇守钟楼的人";

async function makeSettingBook(): Promise<string> {
  const dir = await makeHomeTempDir("checker-setting-");
  await mkdir(join(dir, "chapters"), { recursive: true });
  await writeFile(join(dir, "chapters", "0001.md"), `# 第1章\n\n${CH1}\n`, "utf-8");
  await writeFile(join(dir, "chapters", "0003.md"), `# 第3章\n\n${CH3}\n`, "utf-8");
  await mkdir(join(dir, "story"), { recursive: true });
  await writeFile(join(dir, "story", "character-bible.json"), JSON.stringify({
    version: "v0",
    characters: [{
      id: "char-a1", name: "沈青禾", role: "主角", age: "28",
      relationshipDynamics: [CARD_LINE, "老周：爷爷的老友"],
      knowledgeKnown: ["爷爷三年前过世"],
      knowledgeUnknown: ["二十年前钟为什么停"],
    }],
  }), "utf-8");
  await writeFile(join(dir, "story", "world-bible.json"), JSON.stringify({
    version: "v0",
    rules: ["写实题材，没有超自然元素"], factions: [],
  }), "utf-8");
  await writeFile(join(dir, "story", "location-bible.json"), JSON.stringify({
    version: "v0",
    locations: [{
      id: "loc-1", name: "青石镇钟楼", type: "钟楼", knownFeatures: ["塔钟停在三点十五分"],
      extraFields: { 钥匙: "钟楼钥匙装在铜盒里，由老周保管" },
    }],
  }), "utf-8");
  await writeFile(join(dir, "story", "assets.json"), JSON.stringify({
    version: "v0",
    assets: [{ id: "asset-1", name: "钟楼钥匙（装在铜盒里）", status: "由老周保管" }], containers: [],
  }), "utf-8");
  return dir;
}

const earlier = (): EarlierText => ({
  chapters: [
    { chapter: 3, sentences: [CH3] },
    { chapter: 1, sentences: [CH1] },
  ],
});

describe("readFoundationDigest：按项目真实资料拼设定（题材中立，不预设字段名）", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await makeSettingBook();
  });

  it("人物卡 / 地点 / 资产 / 世界规则四节都在，字段按真实键拼、自定义字段照样进、id 不进", async () => {
    const digest = await readFoundationDigest(dir);
    expect(digest).toBeDefined();
    expect(digest!.sections.map((section) => section.label)).toEqual(["人物卡", "地点", "资产", "世界规则"]);
    const card = digest!.sections[0]!.text;
    expect(card).toContain("沈青禾");
    expect(card).toContain(CARD_LINE);
    expect(card).toContain("已经知道：爷爷三年前过世");
    expect(digest!.sections[1]!.text).toContain("钥匙：钟楼钥匙装在铜盒里，由老周保管");
    expect(digest!.sections[2]!.text).toContain("钟楼钥匙（装在铜盒里）");
    expect(digest!.sections[3]!.text).toContain("写实题材");
    expect(digest!.text).not.toContain("char-a1");
    expect(digest!.text).not.toContain("loc-1");
  });

  it("哪类资料都没有 → undefined（不带设定节，提示里也不提）", async () => {
    const bare = await makeHomeTempDir("checker-setting-bare-");
    await mkdir(join(bare, "chapters"), { recursive: true });
    await writeFile(join(bare, "chapters", "0001.md"), `# 第1章\n\n${CH1}\n`, "utf-8");
    expect(await readFoundationDigest(bare)).toBeUndefined();
  });

  it("settingQuoteLabel：设定原文在哪一节就回哪个 label；对不上回 undefined", async () => {
    const digest = await readFoundationDigest(dir);
    expect(settingQuoteLabel(digest!, CARD_LINE)).toBe("人物卡");
    expect(settingQuoteLabel(digest!, "塔钟停在三点十五分")).toBe("地点");
    expect(settingQuoteLabel(digest!, "写实题材，没有超自然元素")).toBe("世界规则");
    expect(settingQuoteLabel(digest!, "设定本里根本没有的一句话")).toBeUndefined();
  });

  it("foundationMessage：整段话带小标题，核账窗口里能认出来", async () => {
    const digest = await readFoundationDigest(dir);
    const text = foundationMessage(digest!);
    expect(text).toContain("【设定本（作者定的硬设定：人物卡、地点、资产、世界规则）】");
    expect(text).toContain("【人物卡】");
  });
});

describe("parseSettingIssues：设定原文照样经代码核对", () => {
  let dir = "";
  let digest: Awaited<ReturnType<typeof readFoundationDigest>>;
  beforeEach(async () => {
    dir = await makeSettingBook();
    digest = await readFoundationDigest(dir);
  });

  const raw = (...contradictions: Record<string, unknown>[]) => JSON.stringify({ checks: [], contradictions });
  const at = (issues: readonly ContinuityIssueV2[], index: number) => issues[index]!;

  it("新稿和设定对不上：quote 在新稿里 → 指向本章", () => {
    const issues = parseSettingIssues(raw({
      quote: "陆川说她爷爷走了五年", settingQuote: "爷爷三年前过世", reason: "人物卡写爷爷三年前过世，新稿说走了五年", confidence: "sure",
    }, {
      quote: "沈青禾上了钟楼", settingQuote: "钟楼钥匙装在铜盒里，由老周保管", reason: "上楼要用钥匙，稿里没交代", confidence: "maybe",
    }), 6, BODY, earlier(), digest!);
    expect(issues.map((issue) => issue.quote)).toEqual(["陆川说她爷爷走了五年", "沈青禾上了钟楼"]);
    expect(at(issues, 0)).toMatchObject({ earlierQuote: "爷爷三年前过世", earlierChapter: 6, againstSetting: { label: "人物卡" } });
    expect(at(issues, 0).fixChapter).toBeUndefined();
    expect(at(issues, 1)).toMatchObject({ againstSetting: { label: "地点" } });
    expect(at(issues, 1).fixChapter).toBeUndefined();
  });

  it("前文那章和设定不一致（新稿和设定一致）：quote 在前文 → fixChapter 指向那章", () => {
    const issues = parseSettingIssues(raw({
      quote: "陆川想了想，说沈师傅走了也有五年了", quoteChapter: 3, settingQuote: CARD_LINE, reason: "人物卡写三年前过世，第 3 章说五年", confidence: "sure",
    }), 6, BODY, earlier(), digest!);
    expect(issues).toHaveLength(1);
    expect(at(issues, 0)).toMatchObject({
      earlierQuote: CARD_LINE,
      earlierChapter: 3,
      fixChapter: 3,
      againstSetting: { label: "人物卡" },
    });
  });

  it("报错了章号就按章序搜；设定原文对不上设定本、quote 哪都不在、理由自我否决、填了 earlierQuote 的 → 都不收", () => {
    const issues = parseSettingIssues(raw(
      { quote: "陆川想了想，说沈师傅走了也有五年了", quoteChapter: 1, settingQuote: CARD_LINE, reason: "第 3 章和人物卡不一致" },
      { quote: "稿里这句", settingQuote: "设定本里根本没有的一句话", reason: "对不上" },
      { quote: "哪一章都没有的一句话", quoteChapter: 3, settingQuote: CARD_LINE, reason: "对不上" },
      { quote: "陆川想了想，说沈师傅走了也有五年了", settingQuote: CARD_LINE, reason: "此点成立，说法一致不算矛盾" },
      { quote: "陆川说她爷爷走了五年", earlierQuote: "爷爷三年前过世", earlierChapter: 1, settingQuote: CARD_LINE, reason: "走了年数对不上" },
    ), 6, BODY, earlier(), digest!);
    expect(issues).toHaveLength(1);
    expect(at(issues, 0)).toMatchObject({ fixChapter: 3, againstSetting: { label: "人物卡" } });
  });
});

describe("parseSettingChecks：第 4 遍逐句判定（agrees=false 才收）", () => {
  let dir = "";
  let digest: Awaited<ReturnType<typeof readFoundationDigest>>;
  beforeEach(async () => {
    dir = await makeSettingBook();
    digest = await readFoundationDigest(dir);
  });

  const raw = (checks: Record<string, unknown>[]) => JSON.stringify({ checks });

  it("前文那章的句子判了和设定不一致 → fixChapter 指向那章；新稿里的句子 → 指向本章", () => {
    const issues = parseSettingChecks(raw([
      { quote: CH3, quoteChapter: 3, settingQuote: CARD_LINE, agrees: false, reason: "人物卡写三年前过世，第 3 章说五年", confidence: "sure" },
      { quote: "陆川说她爷爷走了五年", quoteChapter: 6, settingQuote: "爷爷三年前过世", agrees: false, reason: "人物卡写三年前过世，新稿说五年", confidence: "sure" },
      { quote: "沈青禾上了钟楼", quoteChapter: 6, settingQuote: "塔钟停在三点十五分", agrees: true, reason: "一致" },
    ]), 6, BODY, earlier(), digest!);
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatchObject({ quote: CH3, earlierQuote: CARD_LINE, earlierChapter: 3, fixChapter: 3, againstSetting: { label: "人物卡" }, confidence: "sure" });
    expect(issues[1]).toMatchObject({ quote: "陆川说她爷爷走了五年", earlierChapter: 6, againstSetting: { label: "人物卡" } });
    expect(issues[1]!.fixChapter).toBeUndefined();
  });

  it("agrees 缺省 / 设定原文对不上 / quote 哪都不在 / 理由自我否决 → 都不收", () => {
    const issues = parseSettingChecks(raw([
      { quote: CH3, quoteChapter: 3, settingQuote: CARD_LINE, reason: "没写 agrees" },
      { quote: CH3, quoteChapter: 3, settingQuote: "设定本里根本没有的一句话", agrees: false, reason: "对不上" },
      { quote: "哪一章都没有的一句话", quoteChapter: 3, settingQuote: CARD_LINE, agrees: "false", reason: "对不上" },
      { quote: CH3, quoteChapter: 3, settingQuote: CARD_LINE, agrees: false, reason: "此点成立，说法一致不算矛盾" },
    ]), 6, BODY, earlier(), digest!);
    expect(issues).toEqual([]);
  });

  it("R7 修复口径：agrees 写中文说法（否/对不上/不一致）当一致放过；confidence 写「确定」不升 sure", () => {
    const issues = parseSettingChecks(raw([
      { quote: CH3, quoteChapter: 3, settingQuote: CARD_LINE, agrees: "对不上", reason: "人物卡写三年前过世，第 3 章说五年" },
      { quote: CH3, quoteChapter: 3, settingQuote: CARD_LINE, agrees: "否", reason: "人物卡写三年前过世，第 3 章说五年" },
      { quote: CH3, quoteChapter: 3, settingQuote: CARD_LINE, agrees: "不一致", reason: "人物卡写三年前过世，第 3 章说五年" },
      { quote: "陆川说她爷爷走了五年", quoteChapter: 6, settingQuote: "爷爷三年前过世", agrees: false, reason: "人物卡写爷爷三年前过世，新稿说走了五年", confidence: "确定" },
    ]), 6, BODY, earlier(), digest!);
    // 前三条中文 agrees 不宽进 → 当一致不收（宁可放过不误报）；第四条布尔 false 照收，confidence 中文不升 sure。
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ quote: "陆川说她爷爷走了五年", confidence: "maybe" });
  });
});

describe("parseVerdicts：布尔/枚举字段只认 schema 的英文写法（R7 修复口径，中文说法不猜）", () => {
  const raw = (verdicts: Record<string, unknown>[]) => JSON.stringify({ verdicts });

  it("英文照旧：sure→sure、no→no、maybe→maybe、false→no、true→sure、真布尔 agrees 也认", () => {
    const out = parseVerdicts(raw([
      { id: "K1", verdict: "sure" },
      { id: "K2", verdict: "no" },
      { id: "K3", verdict: "maybe" },
      { id: "K4", verdict: "false" },
      { id: "K5", verdict: "true" },
      { id: "K6", verdict: "sure", settingQuote: CARD_LINE, draftAgrees: false, earlierAgrees: "true" },
    ]));
    expect(out.get("K1")?.verdict).toBe("sure");
    expect(out.get("K2")?.verdict).toBe("no");
    expect(out.get("K3")?.verdict).toBe("maybe");
    expect(out.get("K4")?.verdict).toBe("no");
    expect(out.get("K5")?.verdict).toBe("sure");
    expect(out.get("K6")).toMatchObject({ draftAgrees: false, earlierAgrees: true });
  });

  it("中文说法不宽进：确定/是 → maybe（不升 sure），不是/否 → maybe（不判 no）；draftAgrees「否」当一致放过", () => {
    const out = parseVerdicts(raw([
      { id: "K1", verdict: "确定" },
      { id: "K2", verdict: "是" },
      { id: "K3", verdict: "不是" },
      { id: "K4", verdict: "sure", settingQuote: CARD_LINE, draftAgrees: "否", earlierAgrees: "对不上" },
    ]));
    expect(out.get("K1")?.verdict).toBe("maybe");
    expect(out.get("K2")?.verdict).toBe("maybe");
    expect(out.get("K3")?.verdict).toBe("maybe");
    // K4 的 verdict 是英文 sure 照判；两句 agrees 写中文 → 都当「没判到对不上」（一致），方向是放过不是误报。
    expect(out.get("K4")).toMatchObject({ verdict: "sure", draftAgrees: true, earlierAgrees: true });
  });
});

describe("checkChapterByReader：设定本进核账窗口", () => {
  it("有设定的书：三遍照旧、另跑第 4 遍（对设定本，逐句 agrees 判定）；新稿消息带【设定本】", async () => {
    const dir = await makeSettingBook();
    const calls: BrainMessage[][] = [];
    const callModel: BrainCallModel = async (messages, options) => {
      if (!options.json) return "笔记";
      calls.push([...messages]);
      if (messages.at(-1)!.content.includes("你刚才核完报了")) {
        return JSON.stringify({ verdicts: [{ id: "K1", verdict: "sure" }] });
      }
      // 三遍只走老路（本章 vs 前文），第 4 遍逐句判 agrees（真模型实测会赖在老路，逐句判定收得回来）。
      if (messages.at(-1)!.content.includes("这一遍只盯")) {
        return JSON.stringify({ checks: [], contradictions: [{ quote: "陆川说她爷爷走了五年", earlierQuote: CH1, earlierChapter: 1, reason: "走了年数对不上", confidence: "sure" }] });
      }
      return JSON.stringify({ checks: [{ quote: "陆川说她爷爷走了五年", quoteChapter: 6, settingQuote: "爷爷三年前过世", agrees: false, reason: "人物卡写爷爷三年前过世，新稿说走了五年", confidence: "sure" }] });
    };
    const result = await checkChapterByReader({ projectDir: dir, chapter: 6, draftBody: BODY, callModel, variant: { selfReview: true } });
    expect(result.failures).toEqual([]);
    // 同一句新稿既被三遍按「对前文」报、又被第 4 遍按「对设定」判对不上：合并去重留先来的第 4 遍那条
    // （带设定裁定、指得准），三遍的老路那条被并掉。
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({ againstSetting: { label: "人物卡" }, confidence: "sure" });
    expect(result.issues[0]!.fixChapter).toBeUndefined();
    const checkMessages = calls.filter((messages) => !messages.at(-1)!.content.includes("你刚才核完报了"));
    expect(checkMessages).toHaveLength(4);
    const settingPass = checkMessages.find((messages) => messages.at(-1)!.content.includes("这一遍只对设定本"))!;
    expect(settingPass.at(-1)!.content).toContain("【设定本（作者定的硬设定");
    expect(settingPass.at(-1)!.content).toContain(CARD_LINE);
    // 三遍的提示还是第 1 步原样（不带设定本的指路），设定本只作为材料附在新稿后面。
    for (const messages of checkMessages.filter((messages) => messages.at(-1)!.content.includes("这一遍只盯"))) {
      expect(messages.at(-1)!.content).toContain("【设定本（作者定的硬设定");
    }
    // 自复核那一轮也带上设定本，K 条目把设定那侧标清楚。
    const review = calls.find((messages) => messages.at(-1)!.content.includes("你刚才核完报了"))!;
    expect(review.at(-1)!.content).toContain("【设定本（作者定的硬设定");
    expect(review.at(-1)!.content).toContain("设定本（人物卡）那句：爷爷三年前过世");
  });

  it("没设定的书：消息里没有设定节、不跑第 4 遍、提示不提设定（第 1 步行为不变）", async () => {
    const dir = await makeHomeTempDir("checker-setting-none-");
    await mkdir(join(dir, "chapters"), { recursive: true });
    await writeFile(join(dir, "chapters", "0001.md"), `# 第1章\n\n${CH1}\n`, "utf-8");
    const seen: string[] = [];
    const callModel: BrainCallModel = async (messages, options) => {
      if (!options.json) return "笔记";
      if (!messages.at(-1)!.content.includes("你刚才核完报了")) seen.push(messages.at(-1)!.content);
      return JSON.stringify({ checks: [], contradictions: [] });
    };
    const result = await checkChapterByReader({ projectDir: dir, chapter: 2, draftBody: BODY, callModel });
    expect(result.issues).toEqual([]);
    expect(seen).toHaveLength(3);
    for (const content of seen) {
      expect(content).not.toContain("设定本");
    }
    expect(checkTask(2).includes("设定本")).toBe(false);
    expect(settingCheckTask(2).includes("这一遍只对设定本")).toBe(true);
  });

  it("自复核把前文章对设定的条目列成「第 N 章那句 ↔ 设定本（人物卡）」", () => {
    const task = selfReviewTask(6, [{
      quote: CH3, earlierQuote: CARD_LINE, earlierChapter: 3, fixChapter: 3, reason: "三年对五年", kind: "event",
      againstSetting: { label: "人物卡" }, confidence: "sure",
    }]);
    expect(task).toContain("【K1】第 3 章那句：陆川想了想，说沈师傅走了也有五年了。");
    expect(task).toContain("设定本（人物卡）那句：爷爷沈敬山：三年前过世，生前是青石镇守钟楼的人");
  });
});

describe("dropMisdirectedBySetting：设定裁定收掉指错方向的条目（确定性）", () => {
  const base = { reason: "r", kind: "event" as const, confidence: "sure" as const };
  it("前文那句被裁定「和设定对不上」、本章那句没被标错 → 「本章 vs 前文」那条收掉，设定条目（指向前文那章）保留", () => {
    const out = dropMisdirectedBySetting([
      { ...base, quote: "陆川说她爷爷走了三年", earlierQuote: "沈师傅走了也有五年了", earlierChapter: 3 },
      { ...base, quote: "沈师傅走了也有五年了", earlierQuote: CARD_LINE, earlierChapter: 3, fixChapter: 3, againstSetting: { label: "人物卡" } },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ fixChapter: 3, againstSetting: { label: "人物卡" } });
  });

  it("本章那句也被设定标错（两边都错）→ 两条都保留；没有设定条目时一条不动", () => {
    const both = dropMisdirectedBySetting([
      { ...base, quote: "陆川说她爷爷走了五年", earlierQuote: "沈师傅走了也有三年了", earlierChapter: 3 },
      { ...base, quote: "陆川说她爷爷走了五年", earlierQuote: "爷爷三年前过世", earlierChapter: 6, againstSetting: { label: "人物卡" } },
      { ...base, quote: "沈师傅走了也有三年了", earlierQuote: CARD_LINE, earlierChapter: 3, fixChapter: 3, againstSetting: { label: "人物卡" } },
    ]);
    expect(both).toHaveLength(3);
    const none = dropMisdirectedBySetting([{ ...base, quote: "a sentence here", earlierQuote: "another one", earlierChapter: 3 }]);
    expect(none).toHaveLength(1);
  });
});
