// @vitest-environment node
//
// manage_ledger（重构 P3 起）：只提裁定草案、不改账；指向哪条按编号或原话查准，查不准如实说。
import { rm } from "node:fs/promises";
import { cardsImport, chapterCommit, projectBook, runCommand, type EntryInput } from "@actalk/story-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyLedgerDecisions } from "../ledger-decisions.js";
import { makeHomeTempDir } from "../../lib/home-test-tmp.js";
import { runManageLedger } from "./manage-ledger.js";

let book: string;
beforeEach(async () => {
  book = await makeHomeTempDir("manage-ledger-");
});
afterEach(async () => {
  await rm(book, { recursive: true, force: true });
});

const CH1 = "# 第1章\n\n周二傍晚，钟停在三点十五分。老周没有拦她。她在钟箱里摸到一把铜钥匙，揣进了包里。钟为什么停？钟楼的门为什么开着？";
const CH2 = "# 第2章\n\n第二天，钟楼的门锁上了。她把钥匙锁进铜盒。";

function entries1(): EntryInput[] {
  return [
    { kind: "fact", review: "auto", nature: "hard", subject: "钟", attribute: "停的时刻", value: "三点十五分", text: "钟停在三点十五分", quote: "钟停在三点十五分" },
    { kind: "fact", review: "auto", nature: "state", subject: "铜钥匙", attribute: "在哪", value: "她包里", text: "铜钥匙在她包里", quote: "揣进了包里" },
    { kind: "fact", review: "auto", nature: "event", text: "老周没有拦她", quote: "老周没有拦她" },
    { kind: "thread", review: "auto", op: "open", type: "question", title: "钟为什么停", note: "钟停了", quote: "钟为什么停" },
    { kind: "thread", review: "auto", op: "open", type: "question", title: "钟楼的门为什么开着", note: "门开着", quote: "钟楼的门为什么开着" },
  ];
}

async function commitTwo(): Promise<void> {
  const author = (key: string) => ({ caller: "author" as const, idempotencyKey: key });
  const first = await runCommand(book, chapterCommit, { chapter: 1, text: CH1, entries: entries1() }, author("c1"));
  if (!first.ok) throw new Error(first.message);
  const second = await runCommand(book, chapterCommit, {
    chapter: 2,
    text: CH2,
    entries: [{ kind: "fact", review: "auto", nature: "state", subject: "铜钥匙", attribute: "在哪", value: "铜盒里", text: "铜钥匙锁在铜盒里", quote: "她把钥匙锁进铜盒" }],
  }, author("c2"));
  if (!second.ok) throw new Error(second.message);
  // 开过的书都有设定卡（开书时搬过）：不然第一次提草案时顺手搬设定，书的版本号会往上走（P9）。
  const cards = await runCommand(book, cardsImport, {}, author("cards"));
  if (!cards.ok) throw new Error(cards.message);
}

describe("manage_ledger：只提草案", () => {
  it("还没定稿的书：如实说账本是空的", async () => {
    expect(await runManageLedger(book, { op: "remove", targetText: "钟" })).toMatchObject({ ok: false, blockedReason: "no_chapters" });
  });

  it("各个 op 翻成裁定草案；作者没点之前账一点没动；说给作者的话里没有编号", async () => {
    await commitTwo();
    const before = JSON.stringify(await projectBook(book));

    const add = await runManageLedger(book, { op: "add", text: "钟楼失过一次火", chapter: 1 });
    expect(add).toMatchObject({ ok: false, needsConfirmation: true });
    expect(add.ledgerConfirm?.decisions).toEqual([{ type: "fact.assert", chapter: 1, nature: "event", text: "钟楼失过一次火" }]);

    const addHard = await runManageLedger(book, { op: "add", text: "老周六十二岁", nature: "hard", subject: "老周", attribute: "年纪", value: "六十二" });
    expect(addHard.ledgerConfirm?.decisions[0]).toMatchObject({ type: "fact.assert", chapter: 2, nature: "hard", subject: "老周" });

    const update = await runManageLedger(book, { op: "update", targetText: "三点十五分", text: "钟停在三点二十分", value: "三点二十分" });
    expect(update.ledgerConfirm?.decisions[0]).toMatchObject({ type: "fact.assert", chapter: 1, nature: "hard", subject: "钟", value: "三点二十分", corrects: "c1-1" });
    expect(update.summary).toContain("「钟停在三点十五分」改成「钟停在三点二十分」");

    const supersede = await runManageLedger(book, { op: "supersede", targetText: "老周没有拦她", chapter: 2 });
    expect(supersede.ledgerConfirm?.decisions).toEqual([{ type: "fact.expire", fact: "c1-3", chapter: 2 }]);

    const resolve = await runManageLedger(book, { op: "resolve", query: "钟为什么停" });
    expect(resolve.ledgerConfirm?.decisions).toEqual([{ type: "thread.close", thread: "t1-1", chapter: 2 }]);

    const weight = await runManageLedger(book, { op: "importance", query: "门为什么开着", importance: "major" });
    expect(weight.ledgerConfirm?.decisions).toEqual([{ type: "thread.weight", thread: "t1-2", weight: "major" }]);

    const group = await runManageLedger(book, { op: "group", groups: ["钟为什么停", "钟楼的门为什么开着"] });
    expect(group.ledgerConfirm?.decisions).toEqual([{ type: "thread.merge", from: ["t1-2"], into: "t1-1" }]);
    expect(group.summary).toContain("把 「钟楼的门为什么开着」并进「钟为什么停」");

    for (const out of [add, addHard, update, supersede, resolve, weight, group]) expect(out.summary).not.toMatch(/c\d+-|t\d+-|d-\d/u);
    expect(JSON.stringify(await projectBook(book))).toBe(before);
  });

  it("查不准如实说：对上多条列候选、对不上说没找到、清理碎片说不需要、缺参数问清楚", async () => {
    await commitTwo();
    const ambiguous = await runManageLedger(book, { op: "remove", targetText: "铜钥匙" });
    expect(ambiguous).toMatchObject({ ok: false, blockedReason: "ambiguous" });
    expect(ambiguous.summary).toContain("「铜钥匙在她包里」");
    expect(ambiguous.summary).toContain("「铜钥匙锁在铜盒里」");
    expect(await runManageLedger(book, { op: "remove", targetText: "外乡人" })).toMatchObject({ blockedReason: "not_found" });
    expect(await runManageLedger(book, { op: "clean" })).toMatchObject({ ok: false, blockedReason: "not_needed" });
    expect(await runManageLedger(book, { op: "group" })).toMatchObject({ blockedReason: "missing_target" });
    expect(await runManageLedger(book, { op: "group", groups: [["钟为什么停"]] })).toMatchObject({ blockedReason: "too_few" });
    expect(await runManageLedger(book, { op: "add", text: "x", chapter: 5 })).toMatchObject({ blockedReason: "unknown_chapter" });
    expect(await runManageLedger(book, { op: "supersede", targetText: "老周没有拦她", chapter: 1 })).toMatchObject({ blockedReason: "bad_chapter" });
  });

  it("作者确认后：改写的那条作废、新说法生效；坏数据整批不记", async () => {
    await commitTwo();
    const update = await runManageLedger(book, { op: "update", targetText: "三点十五分", text: "钟停在三点二十分", value: "三点二十分" });
    const applied = await applyLedgerDecisions(book, { key: update.ledgerConfirm?.key ?? "", decisions: update.ledgerConfirm?.decisions ?? [] });
    expect(applied).toMatchObject({ ok: true, applied: 1 });
    const view = await projectBook(book);
    expect(view.facts.find((fact) => fact.id === "c1-1")?.status).toBe("retracted");
    expect(view.facts.find((fact) => fact.text === "钟停在三点二十分")).toMatchObject({ chapter: 1, value: "三点二十分", review: "author", status: "current" });

    const bad = await applyLedgerDecisions(book, { key: "k-bad", decisions: [{ type: "fact.retract" }] });
    expect(bad).toMatchObject({ ok: false, applied: 0 });
  });

  // 长篇实跑：第 24 章定稿后才发现天数记错，AI 说「我手头没有能改时间线天数的工具」。
  it("改已定稿章的天数：出按钮，作者点了后那章和后面的章跟着挪", async () => {
    await commitTwo();
    const before = await projectBook(book);
    expect(before.chapters.map((chapter) => [chapter.day, chapter.dayEnd])).toEqual([[1, 1], [2, 2]]);
    const plan = await runManageLedger(book, { op: "day", chapter: 1, day: 3, dayEnd: 4 });
    expect(plan).toMatchObject({ needsConfirmation: true, ledgerConfirm: { lines: ["第 1 章从故事第 1 天改记为第 3 天到第 4 天"] } });
    expect((await projectBook(book)).chapters[0]).toMatchObject({ day: 1 });
    const applied = await applyLedgerDecisions(book, { key: plan.ledgerConfirm?.key ?? "", decisions: plan.ledgerConfirm?.decisions ?? [] });
    expect(applied).toMatchObject({ ok: true, applied: 1 });
    expect((await projectBook(book)).chapters.map((chapter) => [chapter.day, chapter.dayEnd, chapter.dayBasis])).toEqual([[3, 4, "author"], [5, 5, "missing"]]);

    expect(await runManageLedger(book, { op: "day", chapter: 9, day: 3 })).toMatchObject({ ok: false, blockedReason: "unknown_chapter" });
    expect(await runManageLedger(book, { op: "day", chapter: 1, day: 3, dayEnd: 2 })).toMatchObject({ ok: false, blockedReason: "bad_day" });
    expect(await runManageLedger(book, { op: "day", chapter: 1, day: 3, dayEnd: 4 })).toMatchObject({ ok: false, blockedReason: "unchanged" });
  });
});
