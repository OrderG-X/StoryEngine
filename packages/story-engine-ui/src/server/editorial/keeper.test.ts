// @vitest-environment node
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CHAPTER_LEDGER_SCHEMA, checkEntries, project, type ChapterLedger, type LedgerEntry } from "@actalk/story-core";
import { describe, expect, it } from "vitest";
import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import { buildKeeperContext, MAX_PROMPT_FACTS } from "./keeper-context.js";
import { nameHandles, parseKeeperOutput } from "./keeper-parse.js";
import { buildKeeperTask, KEEPER_SPEC, LEDGER_ROLE, runLedgerKeeper, settleDayChange } from "./ledger-keeper.js";
import type { BrainMessage } from "./reader-window.js";

type Draft = LedgerEntry extends infer E ? (E extends LedgerEntry ? Omit<E, "id" | "review"> & { id?: string } : never) : never;

function ledger(chapter: number, drafts: Draft[]): ChapterLedger {
  return {
    schema: CHAPTER_LEDGER_SCHEMA,
    chapter,
    textSha256: "0".repeat(64),
    committedAt: "2026-10-17T00:00:00.000Z",
    origin: "commit",
    entries: drafts.map((draft, index) => ({ review: "auto", ...draft, id: draft.id ?? `c${chapter}-${index + 1}` }) as LedgerEntry),
  };
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
      ledger(2, [state("铜盒", "在哪", "井里"), open("t2-1", "门外是谁"), { kind: "time", basis: "text", weekday: 1, quote: q }]),
    ],
    decisions: [],
  });
}

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
        time: { basis: "text", daysSincePrevious: "1", weekday: "周三", timeOfDay: "清晨", quote: "第二天清晨" },
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
      { kind: "time", review: "auto", basis: "text", daysSincePrevious: 1, weekday: 2, timeOfDay: "清晨", quote: "第二天清晨" },
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

  it("章里换了天：daysInChapter 带上摘的换天原句；写 0 就不记、也不带原句", () => {
    const changed = parseKeeperOutput(JSON.stringify({ time: { basis: "judged", daysSincePrevious: 0, daysInChapter: 1, dayChangeQuote: "第二天早上", quote: "当晚" } }), handles);
    expect(changed?.entries[0]).toMatchObject({ kind: "time", daysInChapter: 1 });
    expect(changed?.dayChangeQuote).toBe("第二天早上");
    const same = parseKeeperOutput(JSON.stringify({ time: { basis: "judged", daysSincePrevious: 0, daysInChapter: 0, dayChangeQuote: "傍晚", quote: "当晚" } }), handles);
    expect(same?.entries[0]).not.toHaveProperty("daysInChapter");
    expect(same?.dayChangeQuote).toBeUndefined();
  });

  it("说明里混进的短号换成名字（只换认得的、不粘着英文的），不让「T1」进定稿清单", () => {
    const names = new Map([["T1", "钟为什么停"], ["F1", "老周六十岁"]]);
    expect(nameHandles("并入T1，同 F1 说的一样", names)).toBe("并入「钟为什么停」，同 「老周六十岁」 说的一样");
    expect(nameHandles("T9 没列；ST1 不是短号；T1x 也不是", names)).toBe("T9 没列；ST1 不是短号；T1x 也不是");
    const parsed = parseKeeperOutput(JSON.stringify({ threads: [{ op: "advance", thread: "T1", note: "归入T1：钟停的原因有了眉目", quote: "钥匙递过来" }] }), { ...handles, handleNames: names });
    expect(parsed?.entries[0]).toMatchObject({ note: "归入「钟为什么停」：钟停的原因有了眉目" });
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
        time: { daysSincePrevious: -2, weekday: 3, basis: "author", quote: "那天" },
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
      "time.daysSincePrevious",
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
    // 时间：basis 写了 author 按 judged 记；星期写数字不收；隔几天负数不收 → 什么都没剩，整条丢。
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
      expect(task).toContain("【上一章结尾】\n# 第1章\n\n钟停在三点十五分。老周没有拦她。");
      expect(task).toContain(KEEPER_SPEC[0]);
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

      const fixed = run(async () => JSON.stringify({ quotes: [{ n: 1, quote: "他把钥匙递过来" }, { n: "2", quote: "老周说拿着" }] }));
      const ok = await fixed.outcome;
      expect(ok).toMatchObject({ ok: true, quoteRepair: { asked: 2, fixed: 1 } });
      const ask = fixed.calls.at(-1) ?? [];
      // 同一段对话里接着问：前面是第一遍的要求和它交的账单。
      expect(ask.at(-2)).toMatchObject({ role: "assistant", content: first });
      expect(ask.at(-1)?.content).toContain("1. 梗概：老周交出钥匙");
      expect(ask.at(-1)?.content).toContain("你写的：老周把钥匙递过来");
      if (ok.ok) {
        expect(ok.parsed.entries[0]).toMatchObject({ kind: "summary", quote: "他把钥匙递过来" });
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

  it("忘了附原句的（时间、事实）不直接丢：补摘时一并问，补上了就记；还补不上，核对如实说「没附原句」", async () => {
    const book = await makeHomeTempDir("keeper-noquote-");
    try {
      await mkdir(join(book, "chapters"), { recursive: true });
      await writeFile(join(book, "chapters/0001.md"), "# 第1章\n\n钟停在三点十五分。");
      const draft = "# 第2章\n\n天刚蒙蒙亮，她就起来换药。晌午到了柳湾。";
      const first = JSON.stringify({
        time: { basis: "judged", daysSincePrevious: 1 },
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
      const got = run(JSON.stringify({ quotes: [{ n: 1, quote: "天刚蒙蒙亮" }, { n: 2, quote: "她就起来换药" }] }));
      const ok = await got.outcome;
      expect(got.asks[0]).toContain("1. 时间\n   你写的：（没写）");
      expect(ok).toMatchObject({ ok: true, quoteRepair: { asked: 2, fixed: 2 } });
      if (!ok.ok) throw new Error(ok.reason);
      expect(ok.parsed.drops).toEqual([]);
      expect(ok.parsed.entries).toEqual([
        expect.objectContaining({ kind: "time", daysSincePrevious: 1, quote: "天刚蒙蒙亮" }),
        expect.objectContaining({ kind: "fact", quote: "她就起来换药" }),
      ]);
      const still = await run(JSON.stringify({ quotes: [] })).outcome;
      if (!still.ok) throw new Error(still.reason);
      const checked = checkEntries(still.parsed.entries, draft, sampleBook());
      expect(checked.rejected.map((item) => item.message)).toEqual([expect.stringContaining("没附原句"), expect.stringContaining("没附原句")]);
    } finally {
      await rm(book, { recursive: true, force: true });
    }
  });

  it("说章里换了天却没摘换天那句：补摘时一并问；补出核得上的就认，给空串按同一天记", async () => {
    const book = await makeHomeTempDir("keeper-daychange-");
    try {
      await mkdir(join(book, "chapters"), { recursive: true });
      await writeFile(join(book, "chapters/0001.md"), "# 第1章\n\n钟停在三点十五分。");
      const draft = "# 第2章\n\n她在旅馆住下。第二天早上，她七点就上了山。";
      const first = JSON.stringify({ time: { basis: "judged", daysSincePrevious: 0, daysInChapter: 1, quote: "她在旅馆住下" } });
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
      const proven = run(JSON.stringify({ quotes: [{ n: 1, quote: "第二天早上，她七点就上了山" }] }));
      const ok = await proven.outcome;
      expect(proven.asks[0]).toContain("1. 本章中间换天的那句（你说本章从开头到结尾过了 1 天）");
      expect(ok).toMatchObject({ ok: true, quoteRepair: { asked: 1, fixed: 1 } });
      if (ok.ok) {
        expect(ok.parsed.entries[0]).toMatchObject({ kind: "time", daysInChapter: 1 });
        expect(ok.parsed.adjusted).toEqual([]);
      }
      const none = await run(JSON.stringify({ quotes: [{ n: 1, quote: "" }] })).outcome;
      if (!none.ok) throw new Error(none.reason);
      expect(none.parsed.entries[0]).not.toHaveProperty("daysInChapter");
      expect(none.parsed.adjusted[0]?.reason).toContain("按整章同一天记");
    } finally {
      await rm(book, { recursive: true, force: true });
    }
  });

  it("章里换天要有原句：摘的那句在正文里才认，没摘、核不上按同一天记并说明", () => {
    const draft = "她在旅馆住下。第二天早上，她七点就上了山。";
    const base = { drops: [], adjusted: [] };
    const time = { kind: "time" as const, review: "auto" as const, basis: "judged" as const, daysSincePrevious: 0, daysInChapter: 1, quote: "她在旅馆住下" };
    const kept = settleDayChange({ ...base, entries: [time], dayChangeQuote: "第二天早上，她七点就上了山" }, draft);
    expect(kept.entries[0]).toMatchObject({ daysInChapter: 1 });
    expect(kept.adjusted).toEqual([]);
    const made = settleDayChange({ ...base, entries: [time], dayChangeQuote: "天亮了" }, draft);
    expect(made.entries[0]).not.toHaveProperty("daysInChapter");
    expect(made.entries[0]).toMatchObject({ daysSincePrevious: 0, quote: "她在旅馆住下" });
    expect(made.adjusted).toEqual([{ where: "time", reason: expect.stringContaining("找不到") }]);
    expect(settleDayChange({ ...base, entries: [time] }, draft).adjusted[0]?.reason).toContain("没摘");
  });

  it("提示词里不写任何具体书名、人名", () => {
    const text = buildKeeperTask(3, "正文", "");
    for (const name of ["沈青禾", "老周", "林舟", "苏晚", "陆川"]) expect(text).not.toContain(name);
  });
});
