// @vitest-environment node
//
// manage_ledger（重构 P3 起）：只提裁定草案、不改账；指向哪条按编号或原话查准，查不准如实说。
import { rm } from "node:fs/promises";
import { cardsImport, chapterCommit, projectBook, runCommand, type EntryInput } from "@actalk/story-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyLedgerDecisions } from "../ledger-decisions.js";
import { makeHomeTempDir } from "../../lib/home-test-tmp.js";
import type { BrainCallModel } from "../../editorial/index.js";
import { confirmLabel, runManageLedger } from "./manage-ledger.js";

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
    expect(group.ledgerConfirm?.label).toBe(group.ledgerConfirm?.lines[0]);
    expect(confirmLabel(["把「甲」并进「乙」", "把「丙」并进「丁」"])).toBe("把「甲」并进「乙」 等 2 条");
    expect(confirmLabel([])).toBe("改账");

    for (const out of [add, addHard, update, supersede, resolve, weight, group]) expect(out.summary).not.toMatch(/c\d+-|t\d+-|d-\d/u);
    expect(JSON.stringify(await projectBook(book))).toBe(before);
  });

  it("查不准如实说：对上多条列候选、对不上说没找到、缺参数问清楚", async () => {
    await commitTwo();
    const ambiguous = await runManageLedger(book, { op: "remove", targetText: "铜钥匙" });
    expect(ambiguous).toMatchObject({ ok: false, blockedReason: "ambiguous" });
    expect(ambiguous.summary).toContain("「铜钥匙在她包里」");
    expect(ambiguous.summary).toContain("「铜钥匙锁在铜盒里」");
    expect(await runManageLedger(book, { op: "remove", targetText: "外乡人" })).toMatchObject({ blockedReason: "not_found" });
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

  // 长篇实跑：第 41 章梗概记成「离云州北上」（其实往南），AI 说梗概「改账够不着」。
  it("改已定稿章的梗概：出按钮，作者点了投影里换成新梗概", async () => {
    await commitTwo();
    const plan = await runManageLedger(book, { op: "summary", chapter: 1, text: "她在钟楼里找到了铜钥匙。" });
    expect(plan).toMatchObject({ needsConfirmation: true, ledgerConfirm: { lines: ["第 1 章的梗概改成：她在钟楼里找到了铜钥匙。"] } });
    const applied = await applyLedgerDecisions(book, { key: plan.ledgerConfirm?.key ?? "", decisions: plan.ledgerConfirm?.decisions ?? [] });
    expect(applied).toMatchObject({ ok: true, applied: 1 });
    expect((await projectBook(book)).chapters[0]?.summary).toBe("她在钟楼里找到了铜钥匙。");

    expect(await runManageLedger(book, { op: "summary", chapter: 9, text: "x" })).toMatchObject({ ok: false, blockedReason: "unknown_chapter" });
    expect(await runManageLedger(book, { op: "summary", chapter: 1 })).toMatchObject({ ok: false, blockedReason: "missing_text" });
    expect(await runManageLedger(book, { op: "summary", chapter: 1, text: "她在钟楼里找到了铜钥匙。" })).toMatchObject({ ok: false, blockedReason: "unchanged" });
  });
});

describe("manage_ledger review：理一遍线索（外部审查 2026-10-28：线索只开不收）", () => {
  /** 跟读写笔记的调用回「笔记」；理线索那次按 review 回；点句子那次按 evidence 回。 */
  function fakeKeeper(review: unknown, evidence: unknown): BrainCallModel & { readonly asked: string[] } {
    const asked: string[] = [];
    const call: BrainCallModel = async (messages, options) => {
      if (!options.json) return "笔记";
      const ask = messages.at(-1)!.content;
      asked.push(ask);
      return JSON.stringify(ask.includes("每句前面是编号") ? evidence : review);
    };
    return Object.assign(call, { asked });
  }

  it("判收了的按编号取原句、出「确认改账」；作者点了才记、记在说的那章；给作者的话里没有编号", async () => {
    await commitTwo();
    const before = JSON.stringify(await projectBook(book));
    const keeper = fakeKeeper(
      { threads: [{ id: "T1", status: "open", reason: "还没说钟为什么停" }, { id: "T2", status: "closed", chapter: 2, reason: "门锁上了" }] },
      { evidence: [{ id: "T2", ids: [1] }] },
    );
    const plan = await runManageLedger(book, { op: "review" }, { callModel: keeper });
    expect(keeper.asked[0]).toContain("T2 悬念「钟楼的门为什么开着」");
    expect(plan).toMatchObject({ ok: false, needsConfirmation: true });
    expect(plan.ledgerConfirm?.lines).toEqual(["「钟楼的门为什么开着」第 2 章已收：「第二天，钟楼的门锁上了。」"]);
    expect(plan.summary).toContain("1 条看着已经收了，1 条还开着");
    expect(plan.summary).not.toMatch(/T\d|thread-|c\d-\d/u);
    expect(JSON.stringify(await projectBook(book))).toBe(before);
    const applied = await applyLedgerDecisions(book, { key: plan.ledgerConfirm?.key ?? "", decisions: plan.ledgerConfirm?.decisions ?? [] });
    expect(applied).toMatchObject({ ok: true, applied: 1 });
    expect((await projectBook(book)).threads.find((thread) => thread.title === "钟楼的门为什么开着")).toMatchObject({ status: "closed", closedAt: 2, closedBy: "author" });
  });

  it("点多了取前几句、编号不在这章的丢掉；账里后面还在推进的，判在更早那章收不列（真机 2026-10-28）", async () => {
    const author = (key: string) => ({ caller: "author" as const, idempotencyKey: key });
    const c1 = await runCommand(book, chapterCommit, { chapter: 1, text: "# 第1章\n\n她要查清账。账本少了一页。谁撕的？", entries: [
      { kind: "thread", review: "auto", op: "open", type: "intent", title: "查清账", note: "要查账", quote: "她要查清账" },
      { kind: "thread", review: "auto", op: "open", type: "question", title: "谁撕的账页", note: "少了一页", quote: "账本少了一页" },
    ] }, author("t1"));
    if (!c1.ok) throw new Error(c1.message);
    const threads = (await projectBook(book)).threads;
    const audit = threads.find((thread) => thread.title === "查清账")!.id;
    const c2 = await runCommand(book, chapterCommit, { chapter: 2, text: "# 第2章\n\n账查了一半。老周说是他撕的。他撕了扔进了灶膛。灶膛里还剩一角。她认得那是账页。", entries: [
      { kind: "thread", review: "auto", op: "advance", thread: audit, note: "查了一半", quote: "账查了一半" },
    ] }, author("t2"));
    if (!c2.ok) throw new Error(c2.message);
    const plan = await runManageLedger(book, { op: "review" }, {
      callModel: fakeKeeper(
        { threads: [{ id: "T1", status: "closed", chapter: 1, reason: "查完了" }, { id: "T2", status: "closed", chapter: 2, reason: "老周认了" }] },
        { evidence: [{ id: "T2", ids: [2, 3, 99, 4, 5] }] },
      ),
    });
    expect(plan.ledgerConfirm?.lines).toEqual(["「谁撕的账页」第 2 章已收：「老周说是他撕的。他撕了扔进了灶膛。灶膛里还剩一角。」"]);
    expect(plan.summary).toContain("「查清账」记账员说第 1 章收了，但账里第 2 章还记着推进，第 1 章收了说不通，没列。");
  });

  it("点不出原句、说的章不对、拿不准的都不列，如实说；一条都没有就不出按钮", async () => {
    await commitTwo();
    const plan = await runManageLedger(book, { op: "review" }, {
      callModel: fakeKeeper(
        { threads: [{ id: "T1", status: "closed", chapter: 9, reason: "x" }, { id: "T2", status: "closed", chapter: 2, reason: "门锁上了" }] },
        { evidence: [{ id: "T2", ids: [40] }] },
      ),
    });
    expect(plan).toMatchObject({ ok: false, blockedReason: "nothing_to_close" });
    expect(plan.ledgerConfirm).toBeUndefined();
    expect(plan.summary).toContain("「钟为什么停」记账员说第 9 章收了");
    expect(plan.summary).toContain("「钟楼的门为什么开着」记账员说第 2 章收了，但第 2 章里点不出写明收口的句子，没列。");
    const unsure = await runManageLedger(book, { op: "review" }, { callModel: fakeKeeper({ threads: [{ id: "T1", status: "maybe" }] }, { evidence: [] }) });
    expect(unsure.summary).toContain("拿不准的 2 条：「钟为什么停」「钟楼的门为什么开着」");
    const failing: BrainCallModel = async (messages, options) => {
      if (!options.json) return "笔记";
      if (messages.at(-1)!.content.includes("每句前面是编号")) throw new Error("idle timeout");
      return JSON.stringify({ threads: [{ id: "T2", status: "closed", chapter: 2, reason: "门锁上了" }] });
    };
    const evidenceFailed = await runManageLedger(book, { op: "review" }, { callModel: failing });
    expect(evidenceFailed).toMatchObject({ blockedReason: "nothing_to_close" });
    expect(evidenceFailed.summary).toContain("点收口原句那步没成");
    expect(evidenceFailed.summary).toContain("有一步没跑成：第 2 章点收口原句没成：idle timeout");
    const broken = await runManageLedger(book, { op: "review" }, { callModel: fakeKeeper("不是 JSON", {}) });
    expect(broken).toMatchObject({ ok: false, blockedReason: "review_failed" });
    expect(broken.summary).toContain("线索没理成");
  });
});
