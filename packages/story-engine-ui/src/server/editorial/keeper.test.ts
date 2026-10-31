// @vitest-environment node
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkEntries, ledgerOf, project, splitUnits, type ChapterLedger, type EntryDraft, type SettingCardsFile, type TimeInput } from "@actalk/story-core";
import { describe, expect, it } from "vitest";
import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import { buildKeeperContext, MAX_PROMPT_FACTS } from "./keeper-context.js";
import { nameHandles, parseKeeperOutput } from "./keeper-parse.js";
import { buildChapterEndTask, buildKeeperTask, endingByWorld, endingWeekday, endsAtNight, KEEPER_SPEC, LEDGER_ROLE, nightIssue, previousPresentChapter, quoteOfUnits, runLedgerKeeper, settleTime } from "./ledger-keeper.js";
import type { BrainMessage } from "./reader-window.js";

type Draft = EntryDraft extends infer E ? (E extends EntryDraft ? Omit<E, "review"> & { readonly id?: string; readonly review?: "auto" | "author" } : never) : never;

function ledger(chapter: number, drafts: Draft[]): ChapterLedger {
  return ledgerOf({ chapter, committedAt: "2026-10-17T00:00:00.000Z", entries: drafts.map((draft) => ({ review: "auto", ...draft }) as EntryDraft & { id?: string }) });
}
const q = "原句原句";
const presence = (name: string, nameUsed = name): Draft => ({ kind: "presence", name, nameUsed, quote: q });
const state = (subject: string, attribute: string, value: string, nature: "state" | "hard" = "state"): Draft => ({
  kind: "fact", nature, subject, attribute, value, text: `${subject}${attribute}${value}`, quote: q,
});
const open = (thread: string, title: string): Draft => ({ kind: "thread", op: "open", thread, type: "question", title, note: title, quote: q });

function sampleBook() {
  return project({
    ledgers: [
      ledger(1, [presence("沈青禾"), presence("周守义", "老周"), state("钟箱钥匙", "在哪", "老周手里"), state("周守义", "年纪", "六十", "hard"), open("t1-1", "钟为什么停")]),
      ledger(2, [state("铜盒", "在哪", "井里"), open("t2-1", "门外是谁"), { kind: "time", start: { offset: { unit: "day", min: 1, max: 1 }, basis: "text", quote: q }, weekday: 1 }]),
    ],
    decisions: [],
  });
}

function sampleCards(): SettingCardsFile {
  return {
    schema: "setting-cards/1",
    story: { fields: [] },
    rules: { style: [], musts: [], bans: [], avoid: [], exemplars: [] },
    cards: [
      { id: "k-1", kind: "character", name: "沈青禾", aliases: [], fields: [], by: "author", at: "2026-10-27T00:00:00.000Z" },
      { id: "k-2", kind: "character", name: "沈德厚", aliases: ["沈父"], fields: [], by: "author", at: "2026-10-27T00:00:00.000Z" },
      { id: "k-3", kind: "character", name: "老周", aliases: [], fields: [], by: "author", at: "2026-10-27T00:00:00.000Z" },
      { id: "k-4", kind: "place", name: "钟楼", aliases: [], fields: [], by: "author", at: "2026-10-27T00:00:00.000Z" },
    ],
    relations: [{ id: "r-1", a: "k-1", b: "k-2", label: "父女", by: "author", at: "2026-10-27T00:00:00.000Z" }],
    canon: [],
    skipped: [],
  } as unknown as SettingCardsFile;
}

describe("交账单要求：换天", () => {
  it("上一章约到「明天」的事本章开头在做、或本章说「昨天」指上一章：隔了一天（换题材长篇实跑 2026-10-27：记成了同一天）", () => {
    const spec = KEEPER_SPEC.join("\n");
    expect(spec).toContain("本章开头做的正是上一个当下章约到「明天」「第二天」的事，或者本章里说「昨天」指的是上一个当下章的事，也是 1");
  });

  it("不再让记账员写故事第几天、也不再按天亮换日：换天的规矩拿不准就按两种各写一份", () => {
    const spec = KEEPER_SPEC.join("\n");
    expect(spec).not.toContain("天亮换日");
    expect(spec).toContain("\"byBoundary\":{\"midnight\"");
    expect(spec).toContain("不要写「故事第几天」");
  });

  it("章里过了半夜、凌晨开头又过了天亮：也是一次换天，按两种规矩各写；追问结尾时同一句（P3a 评测：这两种整章记成了同一天）", () => {
    const spec = KEEPER_SPEC.join("\n");
    expect(spec).toContain("从白天到半夜十二点以前都还是同一天");
    expect(spec).toContain("③ 从白天或半夜以前讲到半夜以后、天亮以前");
    expect(spec).toContain("④ 本章开头在半夜以后、天亮以前，章里又讲到天亮以后：midnight 0、dawn 1");
    const ask = buildChapterEndTask("[1]凌晨四点。");
    expect(ask).toContain("③ 从白天或半夜以前讲到半夜以后、天亮以前");
    expect(ask).toContain("点天亮后那句");
    expect(ask).not.toContain("quote");
  });
});

describe("记账员上下文", () => {
  it("人物带别称、线索和事实各编短号、时间照表；短号能换回真编号", () => {
    const before = sampleBook();
    const context = buildKeeperContext(before, "老周把钥匙递过来。");
    expect(context.text).toContain("周守义（又叫：老周）");
    expect(context.text).toMatch(/T1 \[悬念\] (钟为什么停|门外是谁)/u);
    expect([...context.threadHandles.values()].sort()).toEqual(["t1-1", "t2-1"]);
    expect(context.text).toContain("周守义 · 年纪：六十（第 1 章，不会变）");
    // 正文提到「老周」（别称）→ 他的事实在前面。
    expect(context.factHandles.get("F1")).toBe("c1-4");
    expect(context.text).toContain("| 第 2 章 |");
    expect(context.omittedFacts).toBe(0);
  });

  it("设定本里有卡、还没出场的人物也列上（别名、卡上的关系）；已出场的不重复列", () => {
    const cards = sampleCards();
    const text = buildKeeperContext(sampleBook(), "父亲咳了一声。", [], cards).text;
    expect(text).toContain("【设定本里还没出场的人物");
    expect(text).toContain("沈德厚（又叫：沈父；和沈青禾：父女）");
    // 沈青禾已出场、老周是已出场的周守义的别称：都不在这一段重复。
    const section = text.slice(text.indexOf("【设定本里还没出场的人物"));
    expect(section.split("\n\n")[0]).not.toContain("沈青禾（");
    expect(section.split("\n\n")[0]).not.toContain("\n老周");
    expect(section).not.toContain("钟楼");
    expect(buildKeeperContext(sampleBook(), "正文").text).not.toContain("设定本里还没出场");
  });

  it("空书什么段都没有；事实太多就截断并如实写没列的条数", () => {
    expect(buildKeeperContext(project({ ledgers: [], decisions: [] }), "正文").text).toBe("");
    const many = Array.from({ length: MAX_PROMPT_FACTS + 30 }, (_, index) => state(`物件${index}`, "在哪", "库房"));
    const view = project({ ledgers: [ledger(1, many)], decisions: [] });
    const context = buildKeeperContext(view, "正文");
    expect(context.factHandles.size).toBe(MAX_PROMPT_FACTS);
    expect(context.text).toContain("另有 30 条和本章有关的事实");
    expect(context.omittedFacts).toBe(30);
  });

  it("主体没在本章出现、也不是最近记的事实：本来就不列，只告诉模型，不算「没看全」", () => {
    const old = Array.from({ length: 5 }, (_, index) => state(`旧物${index}`, "在哪", "库房"));
    const view = project({ ledgers: [ledger(1, old), ledger(2, []), ledger(3, []), ledger(4, []), ledger(5, [])], decisions: [] });
    const context = buildKeeperContext(view, "正文没提到它们");
    expect(context.factHandles.size).toBe(0);
    expect(context.omittedFacts).toBe(0);
    expect(context.text).toContain("另有 5 条有效的事实，主体没在本章出现");
  });
});

describe("记账员交回的账单", () => {
  const handles = { threadHandles: new Map([["T1", "t1-1"], ["T2", "t2-1"]]), factHandles: new Map([["F1", "c1-4"]]) };

  it("正常的一份：每类都对上新核心的条目；短号换真编号；一条推进挂两个短号拆成两条", () => {
    const parsed = parseKeeperOutput(
      `好的，账单如下：\n\`\`\`json\n${JSON.stringify({
        summary: { text: "老周交出钥匙", quote: "老周把钥匙递过来" },
        time: { start: { offset: { unit: "天", min: "1", max: 1 }, basis: "text", quote: "第二天清晨" }, sameDay: "true", weekday: "周三", timeOfDay: "清晨" },
        presence: [{ name: "周守义", nameUsed: "老周", viewpoint: "false", quote: "老周把钥匙递过来" }],
        facts: [
          { nature: "state", subject: "钟箱钥匙", attribute: "在哪", value: "沈青禾手里", text: "钥匙到了沈青禾手里", quote: "钥匙递过来" },
          { nature: "hard", subject: "周守义", attribute: "年纪", value: "七十", text: "老周其实七十", quote: "我七十了", replaces: "F1" },
        ],
        threads: [
          { op: "advanced", thread: "t1、T2", note: "钥匙有了下落", quote: "钥匙递过来" },
          { op: "open", type: "intent", title: "去井边找铜盒", note: "她决定去井边", quote: "她决定去井边" },
        ],
      })}\n\`\`\``,
      handles,
    );
    expect(parsed?.drops).toEqual([]);
    expect(parsed?.entries).toEqual([
      { kind: "summary", review: "auto", text: "老周交出钥匙", quote: "老周把钥匙递过来" },
      { kind: "time", review: "auto", start: { offset: { unit: "day", min: 1, max: 1 }, basis: "text", quote: "第二天清晨" }, sameDay: true, weekday: 2, timeOfDay: "清晨" },
      { kind: "presence", review: "auto", name: "周守义", nameUsed: "老周", quote: "老周把钥匙递过来" },
      { kind: "fact", review: "auto", nature: "state", subject: "钟箱钥匙", attribute: "在哪", value: "沈青禾手里", text: "钥匙到了沈青禾手里", quote: "钥匙递过来" },
      { kind: "fact", review: "auto", nature: "hard", subject: "周守义", attribute: "年纪", value: "七十", text: "老周其实七十", quote: "我七十了", replaces: ["c1-4"] },
      { kind: "thread", review: "auto", op: "advance", thread: "t1-1", note: "钥匙有了下落", quote: "钥匙递过来" },
      { kind: "thread", review: "auto", op: "advance", thread: "t2-1", note: "钥匙有了下落", quote: "钥匙递过来" },
      { kind: "thread", review: "auto", op: "open", type: "intent", title: "去井边找铜盒", note: "她决定去井边", quote: "她决定去井边" },
    ]);
  });

  it("出场：泛称带 generic；和名字一样的称呼不带", () => {
    const parsed = parseKeeperOutput(JSON.stringify({
      presence: [
        { name: "周守义", nameUsed: "那人", generic: "true", quote: "那人把钥匙递过来" },
        { name: "沈青禾", nameUsed: "沈青禾", generic: true, quote: "沈青禾接住了" },
      ],
    }), handles);
    expect(parsed?.entries).toEqual([
      { kind: "presence", review: "auto", name: "周守义", nameUsed: "那人", generic: true, quote: "那人把钥匙递过来" },
      { kind: "presence", review: "auto", name: "沈青禾", nameUsed: "沈青禾", quote: "沈青禾接住了" },
    ]);
  });

  it("重定稿：新开的线索填了这次列出的 R 短号就带上那条的真编号，别的写法照新开记", () => {
    const parsed = parseKeeperOutput(JSON.stringify({
      threads: [
        { op: "open", type: "question", title: "钟停的缘故", thread: " r2 ", note: "钟停了", quote: q },
        { op: "open", type: "question", title: "门外的人", thread: "R9", note: "有人敲门", quote: q },
        { op: "open", type: "question", title: "井里", thread: "T1", note: "井里有东西", quote: q },
      ],
    }), { ...handles, reopenHandles: new Map([["R1", "t1-1"], ["R2", "t1-2"]]) });
    expect(parsed?.entries.map((entry) => (entry.kind === "thread" ? entry.thread : undefined))).toEqual(["t1-2", undefined, undefined]);
    expect(parsed?.drops).toEqual([]);
  });

  it("重定稿：R 短号报成推进 / 收口也换成真编号交下去（定稿编排认得出是这章自己开的那条）", () => {
    const parsed = parseKeeperOutput(JSON.stringify({
      threads: [{ op: "advance", thread: "R1", note: "还没解开", quote: q }],
    }), { ...handles, reopenHandles: new Map([["R1", "t1-1"]]) });
    expect(parsed?.entries).toEqual([{ kind: "thread", review: "auto", op: "advance", thread: "t1-1", note: "还没解开", quote: q }]);
  });

  it("时间：往回接写负数、说不准写区间、半年后照月记；换天和段原样交下去，段写在顶层或 time 里都认", () => {
    const time = (raw: unknown, segments?: unknown) => parseKeeperOutput(JSON.stringify({ time: raw, ...(segments ? { segments } : {}) }), handles);
    expect(time({ start: { offset: { min: "-2", max: -2 }, basis: "judged", quote: "前天夜里" }, sameDay: true })?.entries[0]).toMatchObject({
      start: { offset: { unit: "day", min: -2, max: -2 }, basis: "judged" },
    });
    expect(time({ start: { offset: { unit: "day", min: 3 }, quote: "过了几天" } })?.entries[0]).toMatchObject({ start: { offset: { unit: "day", min: 3 }, basis: "judged" } });
    expect(time({ start: { offset: { unit: "month", value: 6 }, basis: "text", quote: "半年后" } })?.entries[0]).toMatchObject({ start: { offset: { unit: "month", min: 6, max: 6 } } });
    const changed = time({
      start: { byBoundary: { midnight: 1, dawn: { min: 0, max: 0 } }, quote: "凌晨两点" },
      dayChanges: [{ offset: { min: 1, max: 1 }, quote: "第二天早上" }, { offset: 2 }],
    }, [{ frame: "回忆", firstQuote: "她想起那年", lastQuote: "雪很大", when: { offset: { unit: "year", max: -3 } } }, { frame: "dream", firstQuote: "梦里", lastQuote: "梦醒" }]);
    expect(changed?.adjusted).toEqual([]);
    expect(changed?.entries[0]).toEqual({
      kind: "time",
      review: "auto",
      start: { byBoundary: { midnight: { unit: "day", min: 1, max: 1 }, dawn: { unit: "day", min: 0, max: 0 } }, basis: "judged", quote: "凌晨两点" },
      // 没附那句的换天先交空串，等补点。
      dayChanges: [{ offset: { unit: "day", min: 1, max: 1 }, quote: "第二天早上" }, { offset: { unit: "day", min: 2, max: 2 }, quote: "" }],
      segments: [
        { frame: "past", firstQuote: "她想起那年", lastQuote: "雪很大", when: { offset: { unit: "year", max: -3 } } },
        { frame: "other", firstQuote: "梦里", lastQuote: "梦醒" },
      ],
    });
    // 按换天规矩各写的那份里又套了一层 offset：拆开照收；外层写的单位照留（月、年不能按换天规矩分记，开头按说不出）。
    expect(time({ start: { byBoundary: { midnight: { unit: "month", offset: 1 }, dawn: { unit: "month", offset: 1 } }, basis: "text", quote: "一个月后" } })?.entries[0]).toMatchObject({ start: "unknown" });
    expect(time({ start: { byBoundary: { midnight: { offset: { unit: "day", min: 0, max: 0 } }, dawn: { offset: 1 } }, basis: "text", quote: "第二天一早" } })?.entries[0]).toMatchObject({
      start: { byBoundary: { midnight: { unit: "day", min: 0, max: 0 }, dawn: { unit: "day", min: 1, max: 1 } }, basis: "text" },
    });
    // 里外写法不同、意思一样的单位（「天」和 day）照收；真不一样的不收。
    expect(time({ start: { byBoundary: { midnight: { unit: "天", offset: { unit: "day", min: 1, max: 1 } }, dawn: { unit: "天", offset: 1 } }, basis: "text", quote: "第二天一早" } })?.entries[0]).toMatchObject({
      start: { byBoundary: { midnight: { unit: "day", min: 1, max: 1 }, dawn: { unit: "day", min: 1, max: 1 } } },
    });
    expect(time({ start: { byBoundary: { midnight: { unit: "month", offset: { unit: "day", min: 1, max: 1 } }, dawn: { offset: 1 } }, basis: "text", quote: "第二天一早" } })?.entries[0]).toMatchObject({ start: "unknown" });
    // 整章是一段：只写 segments（写在 time 里也认）。
    expect(time({ segments: [{ frame: "past", firstQuote: "那年", lastQuote: "那年", when: "unknown" }] })?.entries[0]).toEqual({
      kind: "time", review: "auto", segments: [{ frame: "past", firstQuote: "那年", lastQuote: "那年", when: "unknown" }],
    });
    expect(time({ start: "unknown", timeOfDay: "傍晚" })?.entries[0]).toEqual({ kind: "time", review: "auto", start: "unknown", timeOfDay: "傍晚" });
  });

  it("时间写坏了：按能确定的那一半记、如实说，不硬猜", () => {
    const time = (raw: unknown, segments?: unknown) => parseKeeperOutput(JSON.stringify({ time: raw, ...(segments ? { segments } : {}) }), handles);
    // 单位认不出、两头倒了 → 本章开头按说不出记。
    const unit = time({ start: { offset: { unit: "week", min: 1 }, quote: "一周后" }, sameDay: true });
    expect(unit?.entries[0]).toMatchObject({ start: "unknown", sameDay: true });
    expect(unit?.adjusted[0]?.reason).toContain("认不出");
    expect(time({ start: { offset: { min: 3, max: 1 }, quote: "x" } })?.entries[0]).toMatchObject({ start: "unknown" });
    // 换天有一次写坏（0 天不算换天）→ 换天全不记，章末不知道。
    const broken = time({ start: { offset: 1, quote: "第二天" }, dayChanges: [{ offset: 1, quote: "又一天" }, { offset: 0, quote: "当晚" }] });
    expect(broken?.entries[0]).not.toHaveProperty("dayChanges");
    expect(broken?.adjusted).toEqual([{ where: "time.dayChanges", reason: expect.stringContaining("章末是哪天不知道") }]);
    // 又说同一天又列换天 → 两样都不记。
    const both = time({ start: { offset: 1, quote: "第二天" }, sameDay: true, dayChanges: [{ offset: 1, quote: "又一天" }] });
    expect(both?.entries[0]).not.toHaveProperty("sameDay");
    expect(both?.entries[0]).not.toHaveProperty("dayChanges");
    // 段认不出是什么 → 那段不记；梦里写了时间 → 时间不记；回忆的时间写坏 → 按说不出。
    const segments = time({ start: { offset: 0, quote: "当天" } }, [
      { frame: "vision", firstQuote: "a", lastQuote: "b" },
      { frame: "other", firstQuote: "梦里", lastQuote: "梦醒", when: { offset: -1 } },
      { frame: "past", firstQuote: "那年", lastQuote: "那年", when: { offset: { unit: "century" } } },
    ]);
    expect(segments?.drops).toEqual([{ where: "segments 第 1 段", reason: expect.stringContaining("段里的事按当下记了") }]);
    expect(segments?.entries[0]).toMatchObject({ segments: [{ frame: "other" }, { frame: "past", when: "unknown" }] });
    expect(segments?.entries[0]).not.toHaveProperty("segments.0.when");
    expect(segments?.adjusted.map((item) => item.where)).toEqual(["segments 第 2 段", "segments 第 3 段"]);
    // 只写了同一天、没写开头 → 开头按说不出；什么都没写 → 不记。
    expect(time({ sameDay: true })?.entries[0]).toEqual({ kind: "time", review: "auto", start: "unknown", sameDay: true });
    expect(time({ basis: "author", quote: "那天" })?.drops).toEqual([{ where: "time", reason: "时间里什么都没写" }]);
  });

  it("事实、线索的来源：写了说话人 = 人物说的；叙述直接写的标 narration；说是人物说的却没写谁，按不知道记", () => {
    const parsed = parseKeeperOutput(JSON.stringify({
      facts: [
        { nature: "hard", subject: "甲", attribute: "年纪", value: "八十", text: "甲说八十", quote: "我八十了", speaker: "老甲" },
        { nature: "hard", subject: "甲", attribute: "籍贯", value: "北方", text: "甲是北方人", quote: "甲是北方人", source: "narration" },
        { nature: "event", text: "甲来过", quote: "甲来过", source: "character" },
      ],
      threads: [{ op: "close", thread: "T1", note: "他说钟是他停的", quote: "钟是我停的", speaker: "老甲" }],
    }), handles);
    expect(parsed?.entries.map((entry) => ("source" in entry ? entry.source : undefined))).toEqual([
      { kind: "character_claim", speaker: "老甲" },
      { kind: "narration" },
      // 明说是人物说的、没写是谁：照人物说的记（不改现状、不收线索），说话人空着。
      { kind: "character_claim" },
      { kind: "character_claim", speaker: "老甲" },
    ]);
    expect(parsed?.adjusted).toEqual([]);
  });

  it("说明里混进的短号换成名字（只换认得的、不粘着英文的），不让「T1」进定稿清单", () => {
    const names = new Map([["T1", "钟为什么停"], ["F1", "老周六十岁"]]);
    expect(nameHandles("并入T1，同 F1 说的一样", names)).toBe("并入「钟为什么停」，同 「老周六十岁」 说的一样");
    expect(nameHandles("T9 没列；ST1 不是短号；T1x 也不是", names)).toBe("T9 没列；ST1 不是短号；T1x 也不是");
    const parsed = parseKeeperOutput(JSON.stringify({ threads: [{ op: "advance", thread: "T1", note: "归入T1：钟停的原因有了眉目", quote: "钥匙递过来" }] }), { ...handles, handleNames: names });
    expect(parsed?.entries[0]).toMatchObject({ note: "归入「钟为什么停」：钟停的原因有了眉目" });
  });

  it("推进没写说明：丢掉时带上线索名字，作者知道是哪条没记上（换题材长篇实跑 2026-10-28）", () => {
    const names = new Map([["T1", "钟为什么停"]]);
    const parsed = parseKeeperOutput(JSON.stringify({ threads: [{ op: "advance", thread: "T1", quote: "钥匙递过来" }, { op: "advance", thread: "T9", quote: "x" }] }), { ...handles, handleNames: names });
    expect(parsed?.entries).toEqual([]);
    expect(parsed?.drops).toEqual([
      { where: "threads 第 1 条", reason: "没写这一章对它做了什么", name: "钟为什么停" },
      { where: "threads 第 2 条", reason: "没写这一章对它做了什么" },
    ]);
  });

  it("原句里多转义了一层的换行（字面的反斜杠 n）换回空白", () => {
    const parsed = parseKeeperOutput(JSON.stringify({ summary: { text: "找到书", quote: "林秋\\n一九八七年春" } }), handles);
    expect(parsed?.entries[0]).toMatchObject({ kind: "summary", quote: "林秋 一九八七年春" });
  });

  it("退化输入：逐条丢、记原因，不整份作废；抠不出 JSON 才算整份失败", () => {
    expect(parseKeeperOutput("我记不了", handles)).toBeUndefined();
    expect(parseKeeperOutput("[1,2]", handles)).toBeUndefined();
    const parsed = parseKeeperOutput(
      JSON.stringify({
        summary: "",
        time: { weekday: 3, basis: "author", quote: "那天" },
        presence: [{ name: "", quote: "x" }, "老周", { name: "沈青禾", quote: "沈青禾来了" }],
        facts: [
          { nature: "state", subject: "钥匙", text: "钥匙丢了", quote: "钥匙丢了" },
          { nature: "maybe", text: "下雨了", quote: "下雨了" },
          { text: "", quote: "x" },
          { nature: "hard", subject: "甲", attribute: "出身", value: "北方", text: "甲是北方人", quote: "甲是北方人", replaces: ["F9", ""] },
        ],
        threads: [
          { op: "close", note: "了结", quote: "了结了" },
          { op: "advance", thread: "T7", note: "又提到", quote: "又提到了" },
          { op: "maybe", thread: "T1", note: "?", quote: "?" },
          { op: "open", note: "没标题", quote: "没标题的" },
          { op: "open", type: "plot", title: "谁在敲门", quote: "谁在敲门" },
        ],
      }),
      handles,
    );
    expect(parsed).toBeDefined();
    const where = parsed?.drops.map((drop) => drop.where);
    expect(where).toEqual(expect.arrayContaining([
      "summary",
      "time.weekday",
      "time",
      "presence 第 1 条",
      "presence 第 2 条",
      "facts 第 3 条",
      "facts 第 4 条.replaces",
      "threads 第 1 条",
      "threads 第 3 条",
      "threads 第 4 条",
    ]));
    expect(parsed?.adjusted.map((item) => item.where)).toEqual(["facts 第 1 条", "facts 第 2 条", "threads 第 5 条"]);
    const kinds = parsed?.entries.map((entry) => (entry.kind === "fact" ? `${entry.kind}:${entry.nature}` : entry.kind === "thread" ? `${entry.kind}:${entry.op}:${entry.thread ?? entry.title}` : entry.kind));
    // 时间：星期写数字不收（分不清从周日还是周一数）；老写法的 basis、quote 不算写了时间 → 什么都没剩，整条丢。
    expect(kinds).toEqual(["presence", "fact:event", "fact:event", "fact:hard", "thread:advance:T7", "thread:open:谁在敲门"]);
    // 推翻的短号对不上：事实照记、不带 replaces。
    expect(parsed?.entries.find((entry) => entry.kind === "fact" && entry.nature === "hard")).not.toHaveProperty("replaces");
  });
});

describe("记账员跑一章", () => {
  it("先补笔记再交账单；坏输出、调用失败都如实说没成，不抛", async () => {
    const book = await makeHomeTempDir("keeper-");
    try {
      await mkdir(join(book, "chapters"), { recursive: true });
      await writeFile(join(book, "chapters/0001.md"), "# 第1章\n\n钟停在三点十五分。老周没有拦她。");
      await mkdir(join(book, "ledger"), { recursive: true });
      await writeFile(join(book, "ledger/cards.json"), JSON.stringify(sampleCards()));
      const before = sampleBook();
      const calls: BrainMessage[][] = [];
      const reply = JSON.stringify({ summary: { text: "老周交出钥匙", quote: "老周把钥匙递过来" }, threads: [{ op: "advance", thread: "T1", note: "有下落", quote: "钥匙递过来" }] });
      const outcome = await runLedgerKeeper({
        projectDir: book,
        chapter: 2,
        draft: "# 第2章\n\n老周把钥匙递过来。",
        before,
        callModel: async (messages) => {
          calls.push([...messages]);
          return calls.length === 1 ? "第 1 章笔记：老周＝周守义。" : reply;
        },
      });
      expect(outcome.ok).toBe(true);
      expect(calls).toHaveLength(2);
      expect(calls[0]?.[0]).toMatchObject({ role: "system", content: LEDGER_ROLE.system });
      const task = calls[1]?.at(-1)?.content ?? "";
      expect(task).toContain("【第 2 章 正文（待定稿");
      expect(task).toContain("【开着的线索");
      expect(task).toContain("【上一个当下章结尾（第 1 章）】\n# 第1章\n\n钟停在三点十五分。老周没有拦她。");
      expect(task).toContain(KEEPER_SPEC[0]);
      expect(task).toContain("沈德厚（又叫：沈父；和沈青禾：父女）");
      if (outcome.ok) expect(outcome.parsed.entries).toHaveLength(2);

      const broken = await runLedgerKeeper({ projectDir: book, chapter: 2, draft: "老周", before, callModel: async () => "不是 JSON" });
      expect(broken).toMatchObject({ ok: false, reason: expect.stringContaining("不是一份能读的账单") });
      const failed = await runLedgerKeeper({ projectDir: book, chapter: 2, draft: "老周", before, callModel: async () => { throw new Error("429 太忙"); } });
      expect(failed).toMatchObject({ ok: false, reason: expect.stringContaining("429 太忙") });
      expect(await runLedgerKeeper({ projectDir: book, chapter: 2, draft: "  ", before, callModel: async () => "" })).toMatchObject({ ok: false });
    } finally {
      await rm(book, { recursive: true, force: true });
    }
  });

  it("原句对不上的几条单独重摘一次：核得上才换；重摘失败照第一遍交；全对上就不多调", async () => {
    const book = await makeHomeTempDir("keeper-quote-");
    try {
      await mkdir(join(book, "chapters"), { recursive: true });
      await writeFile(join(book, "chapters/0001.md"), "# 第1章\n\n钟停在三点十五分。老周没有拦她。");
      await mkdir(join(book, "ledger"), { recursive: true });
      await writeFile(join(book, "ledger/cards.json"), JSON.stringify(sampleCards()));
      const before = sampleBook();
      const draft = "# 第2章\n\n他把钥匙递过来，说：「拿着。」沈青禾接住了。";
      const first = JSON.stringify({
        summary: { text: "老周交出钥匙", quote: "老周把钥匙递过来" },
        presence: [{ name: "沈青禾", nameUsed: "沈青禾", quote: "沈青禾接住了" }],
        facts: [{ nature: "event", text: "老周交出钥匙", quote: "老周说拿着" }],
      });
      const run = (repair: (messages: readonly BrainMessage[]) => Promise<string>) => {
        const calls: BrainMessage[][] = [];
        const outcome = runLedgerKeeper({
          projectDir: book,
          chapter: 2,
          draft,
          before,
          maxCatchUp: 0,
          callModel: async (messages, options) => {
            calls.push([...messages]);
            if (!options.json) return "笔记";
            return messages.at(-1)?.content.includes("逐字找不到") ? repair(messages) : first;
          },
        });
        return { calls, outcome };
      };

      // 点编号：第 1 条点了第 1 句；第 2 条点的编号本章没有。
      const fixed = run(async () => JSON.stringify({ quotes: [{ n: 1, ids: [1] }, { n: "2", ids: [9] }] }));
      const ok = await fixed.outcome;
      expect(ok).toMatchObject({ ok: true, quoteRepair: { asked: 2, fixed: 1 } });
      const ask = fixed.calls.at(-1) ?? [];
      // 同一段对话里接着问：前面是第一遍的要求和它交的账单。
      expect(ask.at(-2)).toMatchObject({ role: "assistant", content: first });
      expect(ask.at(-1)?.content).toContain("1. 梗概：老周交出钥匙");
      expect(ask.at(-1)?.content).toContain("你写的：老周把钥匙递过来");
      // 正文按编号句子给：代码按编号取原文，不再让它抄。
      expect(ask.at(-1)?.content).toContain("[1]他把钥匙递过来，说：「拿着。」[2]沈青禾接住了。");
      if (ok.ok) {
        // 记下的是正文原字（收尾的引号照原句的统一口径去掉）。
        expect(ok.parsed.entries[0]).toMatchObject({ kind: "summary", quote: "他把钥匙递过来，说：「拿着。" });
        // 第 2 条重摘了还是对不上：保持原样，留给定稿清单如实列。
        expect(ok.parsed.entries[2]).toMatchObject({ kind: "fact", quote: "老周说拿着" });
      }

      const thrown = await run(async () => { throw new Error("429 太忙"); }).outcome;
      expect(thrown).toMatchObject({ ok: true, quoteRepair: { asked: 2, fixed: 0, failed: expect.stringContaining("429") } });
      const junk = await run(async () => "好的").outcome;
      expect(junk).toMatchObject({ ok: true, quoteRepair: { asked: 2, fixed: 0, failed: "补摘交回来的不是 JSON" } });

      const clean = runLedgerKeeper({
        projectDir: book,
        chapter: 2,
        draft,
        before,
        maxCatchUp: 0,
        // 多打了空格、少抄了引号：核得上，记的是正文原字。
        callModel: async (_messages, options) => (options.json ? JSON.stringify({ summary: { text: "交钥匙", quote: "他把钥匙 递过来，说：「拿着" } }) : "笔记"),
      });
      const cleanOutcome = await clean;
      expect(cleanOutcome.ok && cleanOutcome.quoteRepair).toBeFalsy();
      if (cleanOutcome.ok) expect(cleanOutcome.parsed.entries[0]).toMatchObject({ kind: "summary", quote: "他把钥匙递过来，说：「拿着" });
    } finally {
      await rm(book, { recursive: true, force: true });
    }
  });

  it("补点取原句：挨着的两句连起来取，不挨着、跨段的只取头一句；出场人物点的句子里没有他的叫法不认", async () => {
    const draft = "# 第2章\n\n老板娘没抬头。她把布往前一推。\n店里没别人。";
    const units = splitUnits(draft);
    expect(quoteOfUnits(draft, units, [1, 2])).toBe("老板娘没抬头。她把布往前一推。");
    expect(quoteOfUnits(draft, units, [1, 3])).toBe("老板娘没抬头。");
    expect(quoteOfUnits(draft, units, [2, 3])).toBe("她把布往前一推。");
    expect(quoteOfUnits(draft, units, [7])).toBeUndefined();
    const book = await makeHomeTempDir("keeper-presence-");
    try {
      await mkdir(join(book, "chapters"), { recursive: true });
      await writeFile(join(book, "chapters/0001.md"), "# 第1章\n\n钟停在三点十五分。");
      const first = JSON.stringify({ presence: [{ name: "绸布店老板", nameUsed: "老板娘", quote: "老板娘头也没抬" }, { name: "绸布店老板", nameUsed: "老板娘", quote: "老板娘把布推过来" }] });
      const outcome = await runLedgerKeeper({
        projectDir: book, chapter: 2, draft, before: sampleBook(), maxCatchUp: 0,
        callModel: async (messages, options) => {
          if (!options.json) return "笔记";
          return messages.at(-1)?.content.includes("逐字找不到") ? JSON.stringify({ quotes: [{ n: 1, ids: [1] }, { n: 2, ids: [2] }] }) : first;
        },
      });
      expect(outcome).toMatchObject({ ok: true, quoteRepair: { asked: 2, fixed: 1 } });
      if (outcome.ok) {
        expect(outcome.parsed.entries[0]).toMatchObject({ kind: "presence", quote: "老板娘没抬头。" });
        expect(outcome.parsed.entries[1]).toMatchObject({ kind: "presence", quote: "老板娘把布推过来" });
      }
    } finally {
      await rm(book, { recursive: true, force: true });
    }
  });

  it("忘了附原句的（时间开头、事实）不直接丢：补摘时一并问，补上了就记；还补不上，事实核对如实说「没附原句」、开头按说不出隔多久记", async () => {
    const book = await makeHomeTempDir("keeper-noquote-");
    try {
      await mkdir(join(book, "chapters"), { recursive: true });
      await writeFile(join(book, "chapters/0001.md"), "# 第1章\n\n钟停在三点十五分。");
      const draft = "# 第2章\n\n天刚蒙蒙亮，她就起来换药。晌午到了柳湾。";
      const first = JSON.stringify({
        time: { start: { offset: 1, basis: "judged" }, sameDay: true },
        facts: [{ nature: "event", text: "她清早换药" }],
      });
      const run = (repair: string) => {
        const asks: string[] = [];
        const outcome = runLedgerKeeper({
          projectDir: book, chapter: 2, draft, before: sampleBook(), maxCatchUp: 0,
          callModel: async (messages, options) => {
            if (!options.json) return "笔记";
            const last = messages.at(-1)?.content ?? "";
            if (last.includes("逐字找不到")) { asks.push(last); return repair; }
            return first;
          },
        });
        return { asks, outcome };
      };
      const got = run(JSON.stringify({ quotes: [{ n: 1, ids: [1] }, { n: 2, ids: ["1"] }] }));
      const ok = await got.outcome;
      expect(got.asks[0]).toContain("1. 事实：她清早换药\n   你写的：（没写）");
      expect(got.asks[0]).toContain("2. 时间：说明本章开头离上一个当下章多久的那句\n   你写的：（没写）");
      expect(ok).toMatchObject({ ok: true, quoteRepair: { asked: 2, fixed: 2 } });
      if (!ok.ok) throw new Error(ok.reason);
      expect(ok.parsed.drops).toEqual([]);
      expect(ok.parsed.adjusted).toEqual([]);
      expect(ok.parsed.entries).toEqual([
        expect.objectContaining({ kind: "time", start: { offset: { unit: "day", min: 1, max: 1 }, basis: "judged", quote: "天刚蒙蒙亮，她就起来换药。" }, sameDay: true }),
        expect.objectContaining({ kind: "fact", quote: "天刚蒙蒙亮，她就起来换药。" }),
      ]);
      const still = await run(JSON.stringify({ quotes: [] })).outcome;
      if (!still.ok) throw new Error(still.reason);
      expect(still.parsed.entries[0]).toMatchObject({ kind: "time", start: "unknown", sameDay: true });
      expect(still.parsed.adjusted).toEqual([{ where: "time.start", reason: expect.stringContaining("按说不出隔多久记") }]);
      const checked = checkEntries(still.parsed.entries, draft, sampleBook());
      expect(checked.rejected.map((item) => item.message)).toEqual([expect.stringContaining("没附原句")]);
    } finally {
      await rm(book, { recursive: true, force: true });
    }
  });

  it("换天没摘那句、段的首末句对不上：补摘时一并问——换天点那一句，段点从第几句到第几句；点出来的记句子编号", async () => {
    const book = await makeHomeTempDir("keeper-daychange-");
    try {
      await mkdir(join(book, "chapters"), { recursive: true });
      await writeFile(join(book, "chapters/0001.md"), "# 第1章\n\n钟停在三点十五分。");
      const draft = "# 第2章\n\n她在旅馆住下。她想起十年前离家那天。那天也下着雨。第二天早上，她七点就上了山。";
      const first = JSON.stringify({
        time: { start: { offset: 0, basis: "judged", quote: "她在旅馆住下" }, dayChanges: [{ offset: 1 }] },
        segments: [{ frame: "past", firstQuote: "她想起离家", lastQuote: "那天下着雨", when: { offset: { unit: "year", min: -10, max: -10 } } }],
      });
      const run = (repair: string) => {
        const asks: string[] = [];
        const outcome = runLedgerKeeper({
          projectDir: book, chapter: 2, draft, before: sampleBook(), maxCatchUp: 0,
          callModel: async (messages, options) => {
            if (!options.json) return "笔记";
            const last = messages.at(-1)?.content ?? "";
            if (last.includes("逐字找不到")) { asks.push(last); return repair; }
            return first;
          },
        });
        return { asks, outcome };
      };
      const proven = run(JSON.stringify({ quotes: [{ n: 1, ids: [4] }, { n: 2, ids: [2, 3] }] }));
      const ok = await proven.outcome;
      expect(proven.asks[0]).toContain("1. 时间：本章第 1 次换天、新的一天开头那句");
      expect(proven.asks[0]).toContain("2. 不在当下的第 1 段（回忆、倒叙）：点这段从第几句到第几句");
      expect(proven.asks[0]).toContain("你写的：她想起离家 …… 那天下着雨");
      expect(ok).toMatchObject({ ok: true, quoteRepair: { asked: 2, fixed: 2 } });
      if (!ok.ok) throw new Error(ok.reason);
      expect(ok.parsed.adjusted).toEqual([]);
      expect(ok.parsed.entries[0]).toMatchObject({
        kind: "time",
        dayChanges: [{ offset: { unit: "day", min: 1, max: 1 }, quote: "第二天早上，她七点就上了山。" }],
        segments: [{ frame: "past", firstQuote: "她想起十年前离家那天。", lastQuote: "那天也下着雨。", units: { from: 2, to: 3 } }],
      });
      expect(checkEntries(ok.parsed.entries, draft, sampleBook()).rejected).toEqual([]);

      const none = await run(JSON.stringify({ quotes: [{ n: 1, ids: [] }, { n: 2, ids: [] }] })).outcome;
      if (!none.ok) throw new Error(none.reason);
      // 换天照记、不附那句；段不记，如实说段里的事按当下记了。
      expect(none.parsed.entries[0]).toMatchObject({ kind: "time", dayChanges: [{ offset: { unit: "day", min: 1, max: 1 } }] });
      expect(none.parsed.entries[0]).not.toHaveProperty("dayChanges.0.quote");
      expect(none.parsed.entries[0]).not.toHaveProperty("segments");
      expect(none.parsed.adjusted).toEqual([{ where: "time.dayChanges", reason: expect.stringContaining("哪句开始是新的一天不知道") }]);
      expect(none.parsed.drops).toEqual([{ where: "segments 第 1 段", reason: expect.stringContaining("段里的事按当下记了") }]);
      expect(checkEntries(none.parsed.entries, draft, sampleBook()).rejected).toEqual([]);
    } finally {
      await rm(book, { recursive: true, force: true });
    }
  });

  it("写了开头没说结尾：同一段对话里只追问结尾——同一天、点换天那句的编号（代码取原句）；没问成、看不出照第一遍交；说了结尾的不问", async () => {
    const book = await makeHomeTempDir("keeper-end-");
    try {
      await mkdir(join(book, "chapters"), { recursive: true });
      await writeFile(join(book, "chapters/0001.md"), "# 第1章\n\n钟停在三点十五分。");
      const draft = "# 第2章\n\n她在旅馆住下。夜里下起了雨。第二天早上，她七点就上了山。";
      const startOnly = { start: { offset: 0, basis: "judged", quote: "她在旅馆住下" } };
      const run = (time: Record<string, unknown>, end: () => Promise<string>) => {
        const asks: BrainMessage[][] = [];
        const outcome = runLedgerKeeper({
          projectDir: book, chapter: 2, draft, before: sampleBook(), maxCatchUp: 0,
          callModel: async (messages, options) => {
            if (!options.json) return "笔记";
            if (messages.at(-1)?.content.includes("本章结尾是哪天就不知道了")) { asks.push([...messages]); return end(); }
            return JSON.stringify({ time });
          },
        });
        return { asks, outcome };
      };
      const timeOf = async (outcome: ReturnType<typeof runLedgerKeeper>) => {
        const done = await outcome;
        if (!done.ok) throw new Error(done.reason);
        return { time: done.parsed.entries.find((entry) => entry.kind === "time"), adjusted: done.parsed.adjusted };
      };

      const same = run(startOnly, async () => JSON.stringify({ sameDay: true }));
      expect((await timeOf(same.outcome)).time).toMatchObject({ kind: "time", sameDay: true });
      expect(same.asks).toHaveLength(1);
      // 接着第一遍那段对话问：前面是交账单的要求和它交的账单；正文按编号句子给。
      expect(same.asks[0]?.at(-2)).toMatchObject({ role: "assistant", content: JSON.stringify({ time: startOnly }) });
      expect(same.asks[0]?.at(-1)?.content).toContain("[3]第二天早上，她七点就上了山。");

      const changed = await timeOf(run(startOnly, async () => JSON.stringify({ dayChanges: [{ id: 3, offset: { unit: "day", min: 1, max: 1 } }] })).outcome);
      expect(changed.time).toMatchObject({ kind: "time", dayChanges: [{ offset: { unit: "day", min: 1, max: 1 }, quote: "第二天早上，她七点就上了山。" }] });
      expect(changed.time).not.toHaveProperty("sameDay");
      expect(checkEntries(changed.time ? [changed.time] : [], draft, sampleBook()).rejected).toEqual([]);

      const failed = await timeOf(run(startOnly, async () => { throw new Error("429 太忙"); }).outcome);
      expect(failed.time).not.toHaveProperty("sameDay");
      expect(failed.time).not.toHaveProperty("dayChanges");
      expect(failed.adjusted).toEqual([{ where: "time", reason: expect.stringContaining("问本章结尾是哪天没问成（") }]);
      const unknown = await timeOf(run(startOnly, async () => JSON.stringify({ unknown: true })).outcome);
      expect(unknown.time).not.toHaveProperty("sameDay");
      expect(unknown.adjusted).toEqual([]);
      // 交回来的又是同一天又换天：和第一遍同样的规矩，不记、如实说。
      const both = await timeOf(run(startOnly, async () => JSON.stringify({ sameDay: true, dayChanges: [{ id: 3, offset: 1 }] })).outcome);
      expect(both.time).not.toHaveProperty("sameDay");
      expect(both.time).not.toHaveProperty("dayChanges");
      expect(both.adjusted).toHaveLength(1);

      const told = run({ ...startOnly, sameDay: true }, async () => JSON.stringify({ sameDay: true }));
      await told.outcome;
      expect(told.asks).toEqual([]);
      // 开头说不出隔多久的也问（第 1 章开头总是第 1 天，结尾漏了全书断）。
      const noStart = run({ start: "unknown" }, async () => JSON.stringify({ sameDay: true }));
      expect((await timeOf(noStart.outcome)).time).toMatchObject({ kind: "time", start: "unknown", sameDay: true });
      expect(noStart.asks).toHaveLength(1);
    } finally {
      await rm(book, { recursive: true, force: true });
    }
  });

  it("写的星期和按开头推的对不上：只复核这一件——改了隔几天、算得上就换（原句照旧）；说星期不是开头那天就不记星期；没问成、改了还对不上照第一遍交并说明；对得上的不问", async () => {
    const book = await makeHomeTempDir("keeper-weekday-");
    try {
      await mkdir(join(book, "chapters"), { recursive: true });
      const monday = "# 第1章\n\n周一下午，面馆还没上客。";
      await writeFile(join(book, "chapters/0001.md"), monday);
      const day = (min: number) => ({ unit: "day" as const, min, max: min });
      const before = project({ ledgers: [ledgerOf({ chapter: 1, text: monday, committedAt: "2026-10-17T00:00:00.000Z", entries: [{ kind: "time", review: "auto", start: { offset: day(0), basis: "text", quote: "周一下午" }, weekday: 0, sameDay: true }] })], decisions: [] });
      const draft = "# 第2章\n\n周三上午，她又来了。";
      const run = (offset: number, recheck: () => Promise<string>) => {
        const asks: string[] = [];
        const outcome = runLedgerKeeper({
          projectDir: book, chapter: 2, draft, before, maxCatchUp: 0,
          callModel: async (messages, options) => {
            if (!options.json) return "笔记";
            const last = messages.at(-1)?.content ?? "";
            if (last.includes("对不上。请对照正文再看一遍")) { asks.push(last); return recheck(); }
            return JSON.stringify({ time: { start: { offset: day(offset), basis: "judged", quote: "周三上午" }, weekday: "周三", sameDay: true } });
          },
        });
        return { asks, outcome };
      };
      const timeOf = async (outcome: ReturnType<typeof runLedgerKeeper>) => {
        const done = await outcome;
        if (!done.ok) throw new Error(done.reason);
        return { time: done.parsed.entries.find((entry) => entry.kind === "time"), adjusted: done.parsed.adjusted };
      };

      const fixed = run(1, async () => JSON.stringify({ offset: day(2) }));
      expect((await timeOf(fixed.outcome)).time).toMatchObject({ start: { offset: day(2), basis: "judged", quote: "周三上午" }, weekday: 2 });
      expect(fixed.asks[0]).toContain("本章写的是周三；上一个当下章（第 1 章）结尾是周一，按你写的开头离它 1 天，本章开头该是周二");

      const notStart = await timeOf(run(1, async () => JSON.stringify({ weekday: null })).outcome);
      expect(notStart.time).toMatchObject({ start: { offset: day(1) } });
      expect(notStart.time).not.toHaveProperty("weekday");
      expect(notStart.adjusted).toEqual([]);

      for (const reply of [async () => { throw new Error("429 太忙"); }, async () => JSON.stringify({ offset: day(3) }), async () => JSON.stringify({ unknown: true })]) {
        const kept = await timeOf(run(1, reply).outcome);
        expect(kept.time).toMatchObject({ start: { offset: day(1) }, weekday: 2 });
        expect(kept.adjusted).toEqual([{ where: "time.weekday", reason: expect.stringContaining("本章写的周三和按开头推的周二对不上") }]);
      }

      const agrees = run(2, async () => JSON.stringify({ offset: day(9) }));
      await agrees.outcome;
      expect(agrees.asks).toEqual([]);
    } finally {
      await rm(book, { recursive: true, force: true });
    }
  });

  it("按两种换天规矩走一遍：进半夜到天亮之间得先不在、出来得先在，差一天以上不可能；结尾还没天亮的报（本章列换天进的不报）；第 1 章开头不算", () => {
    const day = (min: number) => ({ unit: "day" as const, min, max: min });
    const night = { byBoundary: { midnight: day(1), dawn: day(0) } };
    const dawn = { byBoundary: { midnight: day(0), dawn: day(1) } };
    const start = (relative: object) => ({ ...relative, basis: "judged" as const, quote: "q" });
    const time = (partial: Partial<TimeInput>): TimeInput => ({ kind: "time", review: "auto", start: start({ offset: day(1) }), sameDay: true, ...partial });
    const out = { exists: true, atNight: false };
    expect([
      nightIssue(time({ start: start(night) }), out),
      nightIssue(time({ start: start(night), sameDay: undefined, dayChanges: [{ ...dawn, quote: "q" }] }), out),
      nightIssue(time({ start: start(dawn) }), out),
      nightIssue(time({ start: start(dawn) }), { exists: true, atNight: true }),
      nightIssue(time({ sameDay: undefined, dayChanges: [{ ...dawn, quote: "q" }] }), out),
      nightIssue(time({ start: start({ byBoundary: { midnight: day(2), dawn: day(0) } }) }), { exists: true }),
      nightIssue(time({ sameDay: undefined, dayChanges: [{ ...night, quote: "q" }] }), out),
      nightIssue(time({}), { exists: true, atNight: true }),
      nightIssue(time({ start: start(dawn) }), { exists: false }),
      nightIssue(time({ start: "unknown" }), out),
      nightIssue(time({ start: start({ offset: { unit: "day", min: 1 } }) }), { exists: true, atNight: true }),
      nightIssue(time({ start: start({ offset: { unit: "day", min: 0, max: 1 } }), sameDay: undefined, dayChanges: [{ ...dawn, quote: "q" }] }), out),
    ]).toEqual([
      { kind: "endsAtNight" },
      undefined,
      { kind: "impossible", at: "start", shift: -1 },
      undefined,
      { kind: "impossible", at: 1, shift: -1 },
      { kind: "impossible", at: "start", shift: 2 },
      undefined,
      { kind: "endsAtNight" },
      undefined,
      undefined,
      { kind: "endsAtNight" },
      { kind: "impossible", at: 1, shift: -1 },
    ]);
  });

  it("上一章结尾在不在半夜到天亮之间：按投影两个世界的差算，比全书最小的差大一天就在；哪边不确定就不知道", () => {
    const day = (min: number) => ({ unit: "day" as const, min, max: min });
    const text = (n: number) => `# 第${n}章\n\n她醒了。`;
    const ledger = (chapter: number, time: Record<string, unknown>) => ledgerOf({ chapter, text: text(chapter), committedAt: "2026-10-17T00:00:00.000Z", entries: [{ kind: "time", review: "auto", ...time } as EntryDraft] });
    const before = project({
      ledgers: [
        ledger(1, { start: { offset: day(0), basis: "text", quote: "她醒了。" }, sameDay: true }),
        ledger(2, { start: { byBoundary: { midnight: day(1), dawn: day(0) }, basis: "judged", quote: "她醒了。" }, sameDay: true }),
        ledger(3, { start: { byBoundary: { midnight: day(0), dawn: day(1) }, basis: "judged", quote: "她醒了。" }, sameDay: true }),
        ledger(4, { start: { offset: { unit: "day", min: 1 }, basis: "judged", quote: "她醒了。" }, sameDay: true }),
      ],
      decisions: [],
    });
    expect([1, 2, 3, 4].map((chapter) => endsAtNight(before, chapter))).toEqual([false, true, false, undefined]);
  });

  it("按两种换天规矩对不上 / 结尾还没天亮：只复核这一件——改了走得通就换（开头原句照旧、换天点编号代码取句）；说没记错、看不出、没问成、改了还不通照第一遍交，走不通的如实说明；走得通的不问", async () => {
    const book = await makeHomeTempDir("keeper-night-");
    try {
      await mkdir(join(book, "chapters"), { recursive: true });
      const first = "# 第1章\n\n傍晚，面馆打烊。";
      await writeFile(join(book, "chapters/0001.md"), first);
      const day = (min: number) => ({ unit: "day" as const, min, max: min });
      const before = project({ ledgers: [ledgerOf({ chapter: 1, text: first, committedAt: "2026-10-17T00:00:00.000Z", entries: [{ kind: "time", review: "auto", start: { offset: day(0), basis: "text", quote: "傍晚，面馆打烊。" }, sameDay: true }] })], decisions: [] });
      const draft = "# 第2章\n\n凌晨四点，她醒了。天亮了，楼下有了自行车铃。中午，客人进门。";
      const units = splitUnits(draft);
      const dawnId = units.find((unit) => draft.slice(unit.start, unit.end).includes("天亮了"))!.id;
      const run = (first: object, recheck: () => Promise<string>) => {
        const asks: string[] = [];
        const outcome = runLedgerKeeper({
          projectDir: book, chapter: 2, draft, before, maxCatchUp: 0,
          callModel: async (messages, options) => {
            if (!options.json) return "笔记";
            const last = messages.at(-1)?.content ?? "";
            if (last.includes("按两种换天规矩对不上")) { asks.push(last); return recheck(); }
            return JSON.stringify({ time: { start: { ...first, basis: "judged", quote: "凌晨四点，她醒了。" }, sameDay: true } });
          },
        });
        return { asks, outcome };
      };
      const timeOf = async (outcome: ReturnType<typeof runLedgerKeeper>) => {
        const done = await outcome;
        if (!done.ok) throw new Error(done.reason);
        return { time: done.parsed.entries.find((entry) => entry.kind === "time"), adjusted: done.parsed.adjusted };
      };
      const night = { byBoundary: { midnight: day(1), dawn: day(0) } };
      const dawn = { byBoundary: { midnight: day(0), dawn: day(1) } };

      const added = run(night, async () => JSON.stringify({ dayChanges: [{ id: dawnId, ...dawn }] }));
      const fixed = await timeOf(added.outcome);
      expect(fixed.time).toMatchObject({ start: { ...night, quote: "凌晨四点，她醒了。" }, dayChanges: [{ ...dawn, quote: "天亮了，楼下有了自行车铃。" }] });
      expect(fixed.time).not.toHaveProperty("sameDay");
      expect(fixed.adjusted).toEqual([]);
      expect(added.asks[0]).toContain("本章结尾还在半夜以后、天亮以前");
      expect(added.asks[0]).toContain(`[${dawnId}]`);

      const confirmed = await timeOf(run(night, async () => JSON.stringify({ keep: true })).outcome);
      expect(confirmed.time).toMatchObject({ start: night, sameDay: true });
      expect(confirmed.adjusted).toEqual([]);

      const wrongStart = run(dawn, async () => JSON.stringify({ start: { offset: day(1) } }));
      expect((await timeOf(wrongStart.outcome)).time).toMatchObject({ start: { offset: day(1), basis: "judged", quote: "凌晨四点，她醒了。" }, sameDay: true });
      expect(wrongStart.asks[0]).toContain("这得上一章（第 1 章）结尾在半夜以后、天亮以前才对得上");

      for (const reply of [async () => { throw new Error("429 太忙"); }, async () => JSON.stringify({ unknown: true }), async () => JSON.stringify({ keep: true }), async () => JSON.stringify({ start: dawn })]) {
        const kept = await timeOf(run(dawn, reply).outcome);
        expect(kept.time).toMatchObject({ start: dawn, sameDay: true });
        expect(kept.adjusted).toEqual([{ where: "time", reason: expect.stringContaining("按半夜和天亮两种规矩记的对不上") }]);
      }

      const fine = run({ offset: day(1) }, async () => JSON.stringify({ keep: true }));
      await fine.outcome;
      expect(fine.asks).toEqual([]);
    } finally {
      await rm(book, { recursive: true, force: true });
    }
  });

  it("时间核不上的原句怎么落：开头 → 说不出隔多久；换天 → 不附那句；段 → 不记；整章是段却对不上 → 整条时间没记上", () => {
    const draft = "她在旅馆住下。她梦见了海。第二天早上，她七点就上了山。";
    const base = { drops: [], adjusted: [] };
    const time = {
      kind: "time" as const,
      review: "auto" as const,
      start: { offset: { unit: "day" as const, min: 0, max: 0 }, basis: "judged" as const, quote: "她在旅馆住下" },
      dayChanges: [{ offset: { unit: "day" as const, min: 1, max: 1 }, quote: "第二天早上，她七点就上了山" }],
      segments: [{ frame: "other" as const, firstQuote: "她梦见了海", lastQuote: "她梦见了海" }],
    };
    expect(settleTime({ ...base, entries: [time] }, draft)).toEqual({ ...base, entries: [time] });
    const start = settleTime({ ...base, entries: [{ ...time, start: { ...time.start, quote: "她住进了旅馆" } }] }, draft);
    expect(start.entries[0]).toMatchObject({ start: "unknown", dayChanges: time.dayChanges, segments: time.segments });
    const change = settleTime({ ...base, entries: [{ ...time, dayChanges: [{ ...time.dayChanges[0]!, quote: "天亮了" }] }] }, draft);
    expect(change.entries[0]).toMatchObject({ start: time.start, dayChanges: [{ offset: { unit: "day", min: 1, max: 1 } }] });
    expect(change.entries[0]).not.toHaveProperty("dayChanges.0.quote");
    const segment = settleTime({ ...base, entries: [{ ...time, segments: [{ frame: "other" as const, firstQuote: "她梦见了山", lastQuote: "她梦见了山" }] }] }, draft);
    expect(segment.entries[0]).not.toHaveProperty("segments");
    expect(segment.drops).toEqual([{ where: "segments 第 1 段", reason: expect.stringContaining("梦、想象、传闻") }]);
    const whole = settleTime({ ...base, entries: [{ kind: "time", review: "auto", segments: [{ frame: "past", firstQuote: "那年", lastQuote: "那年" }] }] }, draft);
    expect(whole.entries).toEqual([]);
    expect(whole.drops.map((drop) => drop.where)).toEqual(["segments 第 1 段", "time"]);
  });

  it("上一个当下章：往前跳过整章是回忆、梦的章；没记上时间的章不跳", () => {
    const text = (chapter: number) => `# 第${chapter}章\n\n那年冬天很冷。河面冻上了。`;
    const segmentOnly = (chapter: number) =>
      ledgerOf({ chapter, text: text(chapter), committedAt: "2026-10-17T00:00:00.000Z", entries: [{ kind: "time", review: "auto", segments: [{ frame: "past", firstQuote: "那年冬天很冷", lastQuote: "河面冻上了" }] }] });
    const present = (chapter: number) =>
      ledgerOf({ chapter, text: text(chapter), committedAt: "2026-10-17T00:00:00.000Z", entries: [{ kind: "time", review: "auto", start: { offset: { unit: "day", min: 1, max: 1 }, basis: "judged", quote: "那年冬天很冷" }, sameDay: true }] });
    const view = project({ ledgers: [present(1), segmentOnly(2), segmentOnly(3), present(4), ledger(5, [])], decisions: [] });
    expect(previousPresentChapter(view, 4)).toBe(1);
    expect(previousPresentChapter(view, 6)).toBe(5);
    expect(previousPresentChapter(view, 1)).toBeUndefined();
    expect(buildKeeperTask(4, "正文", "", { chapter: 1, text: "结尾" })).toContain("【上一个当下章结尾（第 1 章）】\n结尾");
  });

  it("上一个当下章结尾两种换天规矩不在同一天：告诉记账员各是哪天；一样的不说", () => {
    const text = (chapter: number) => `# 第${chapter}章\n\n他坐到后半夜。屋里静了。`;
    const day = (min: number) => ({ unit: "day" as const, min, max: min });
    const first = ledgerOf({ chapter: 1, text: text(1), committedAt: "2026-10-17T00:00:00.000Z", entries: [{ kind: "time", review: "auto", start: { offset: day(0), basis: "judged", quote: "他坐到后半夜" }, sameDay: true }] });
    const late = ledgerOf({
      chapter: 2,
      text: text(2),
      committedAt: "2026-10-17T00:00:00.000Z",
      entries: [{ kind: "time", review: "auto", start: { offset: day(1), basis: "judged", quote: "他坐到后半夜" }, dayChanges: [{ byBoundary: { midnight: day(1), dawn: day(0) }, quote: "屋里静了" }] }],
    });
    const view = project({ ledgers: [first, late], decisions: [] });
    expect(endingByWorld(view, 1)).toBeUndefined();
    const ends = endingByWorld(view, 2);
    expect(ends).toEqual({ midnight: { lo: 3, hi: 3 }, dawn: { lo: 2, hi: 2 } });
    const task = buildKeeperTask(3, "正文", "", { chapter: 2, text: "屋里静了。", byWorld: ends });
    expect(task).toContain("过了半夜就算第二天时是第 3 天，天亮才算第二天时是第 2 天");
    expect(buildKeeperTask(3, "正文", "", { chapter: 2, text: "屋里静了。" })).not.toContain("两种换天规矩不在同一天");
  });

  it("上一个当下章结尾是星期几：前文写明了星期、推得出来才告诉记账员（多线往回接按星期定隔几天）；跨天数不定的不说", () => {
    const day = (min: number) => ({ unit: "day" as const, min, max: min });
    const monday = "# 第1章\n\n周一下午，面馆还没上客。";
    const first = ledgerOf({ chapter: 1, text: monday, committedAt: "2026-10-17T00:00:00.000Z", entries: [{ kind: "time", review: "auto", start: { offset: day(0), basis: "text", quote: "周一下午" }, weekday: 0, sameDay: true }] });
    const next = (entries: EntryDraft[]) => ledgerOf({ chapter: 2, text: "# 第2章\n\n第二天一早。到了夜里。", committedAt: "2026-10-17T00:00:00.000Z", entries });
    const twoDays = next([{ kind: "time", review: "auto", start: { offset: day(1), basis: "text", quote: "第二天一早" }, dayChanges: [{ offset: day(1), quote: "到了夜里" }] }]);
    expect(endingWeekday(project({ ledgers: [first, twoDays], decisions: [] }), 1)).toBe(0);
    // 第 2 章开头周二，章内过了一天：结尾周三。
    expect(endingWeekday(project({ ledgers: [first, twoDays], decisions: [] }), 2)).toBe(2);
    // 凌晨开头、过了天亮：开头按两种规矩不在同一天（推不出开头星期几），结尾两种都是第 2 天 → 照第 1 章写明的周一推，周二。
    const dawn = next([{ kind: "time", review: "auto", start: { byBoundary: { midnight: day(1), dawn: day(0) }, basis: "judged", quote: "第二天一早" }, dayChanges: [{ byBoundary: { midnight: day(0), dawn: day(1) }, quote: "到了夜里" }] }]);
    const dawnView = project({ ledgers: [first, dawn], decisions: [] });
    expect(dawnView.chapters[1]?.time.weekday).toBeUndefined();
    expect(endingWeekday(dawnView, 2)).toBe(1);
    const open = next([{ kind: "time", review: "auto", start: { offset: day(1), basis: "text", quote: "第二天一早" } }]);
    expect(endingWeekday(project({ ledgers: [first, open], decisions: [] }), 2)).toBeUndefined();
    const task = buildKeeperTask(3, "正文", "", { chapter: 2, text: "到了夜里。", weekday: 2 });
    expect(task).toContain("（第 2 章结尾是周三，按前文写明的星期推的。");
    expect(buildKeeperTask(3, "正文", "", { chapter: 2, text: "到了夜里。" })).not.toContain("按前文写明的星期推的");
  });

  it("提示词里不写任何具体书名、人名", () => {
    const text = buildKeeperTask(3, "正文", "");
    for (const name of ["沈青禾", "老周", "林舟", "苏晚", "陆川"]) expect(text).not.toContain(name);
  });
});
