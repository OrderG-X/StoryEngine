// @vitest-environment node
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CHAPTER_LEDGER_SCHEMA, project, type ChapterLedger, type LedgerEntry } from "@actalk/story-core";
import { describe, expect, it } from "vitest";
import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import { buildKeeperContext, MAX_PROMPT_FACTS } from "./keeper-context.js";
import { parseKeeperOutput } from "./keeper-parse.js";
import { buildKeeperTask, KEEPER_SPEC, LEDGER_ROLE, runLedgerKeeper } from "./ledger-keeper.js";
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
    expect(context.text).toContain("另有 30 条");
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

  it("提示词里不写任何具体书名、人名", () => {
    const text = buildKeeperTask(3, "正文", "");
    for (const name of ["沈青禾", "老周", "林舟", "苏晚", "陆川"]) expect(text).not.toContain(name);
  });
});
