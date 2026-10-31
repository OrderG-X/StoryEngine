// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chapterCommit, projectBook, readTruthBasis, runCommand, type BasisChange } from "@actalk/story-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import { describeBasisChanges } from "../book/truth-basis.js";
import { commitEntriesOf, draftFingerprint, prepareChapterCommit, type CommitChoices, type CommitPreview, type PrepareFailure, type PrepareInput, type PreviewTicket } from "./commit-flow.js";
import type { BrainCallModel } from "./reader-window.js";

/** 照「先取依据、再读材料」的顺序调（第 8 轮复核 V4）：现取一份依据交进去。 */
const prepareNow = async (input: Omit<PrepareInput, "basis">) => prepareChapterCommit({ ...input, basis: await readTruthBasis(input.bookDir) });

/** 照票和作者的选择定稿（commit.prepare 的「确认定稿」那步同一个做法：条目照票算、依据照票核）。 */
const confirmNow = (ticket: PreviewTicket, text: string, choices: CommitChoices = {}, idempotencyKey: string = randomUUID()) =>
  runCommand(book, chapterCommit, { chapter: ticket.chapter, text, entries: commitEntriesOf(ticket, choices) }, { caller: "author", basis: ticket.basis, idempotencyKey });

let book: string;
beforeEach(async () => {
  book = await makeHomeTempDir("commit-flow-");
});
afterEach(async () => {
  await rm(book, { recursive: true, force: true });
});

const CH1 = "# 第1章 · 钟停\n\n周二傍晚，钟停在三点十五分。沈青禾推开钟楼的门，老周没有拦她。\n\n她在钟箱里摸到一把铜钥匙，揣进了包里。钟为什么偏偏停在这个时刻？";
const CH2 = "# 第2章 · 外乡人\n\n第二天上午，外乡人又来了。老周站在门口，没让他进。\n\n沈青禾把钥匙锁进铜盒。她终于明白了，钟是被人故意拨停的。";

/** 假模型：要笔记就交笔记，要账单就交给定的那份。 */
function fakeModel(ledger: unknown): BrainCallModel {
  return async (messages) => {
    const last = messages.at(-1)?.content ?? "";
    return last.includes("交这一章的账单") ? JSON.stringify(ledger) : "笔记：老周＝周守义。";
  };
}

const LEDGER1 = {
  summary: { text: "沈青禾进钟楼拿走钥匙", quote: "她在钟箱里摸到一把铜钥匙" },
  time: { start: { offset: 0, basis: "text", quote: "周二傍晚" }, sameDay: true, weekday: "周二", timeOfDay: "傍晚" },
  presence: [
    { name: "沈青禾", nameUsed: "沈青禾", viewpoint: true, quote: "沈青禾推开钟楼的门" },
    { name: "周守义", nameUsed: "老周", quote: "老周没有拦她" },
  ],
  facts: [
    { nature: "state", subject: "铜钥匙", attribute: "在哪", value: "沈青禾包里", text: "铜钥匙在沈青禾包里", quote: "揣进了包里" },
    { nature: "hard", subject: "钟", attribute: "停的时刻", value: "三点十五分", text: "钟停在三点十五分", quote: "钟停在三点十五分" },
  ],
  threads: [{ op: "open", type: "question", title: "钟为什么停", note: "钟停在三点十五分", quote: "钟为什么偏偏停在这个时刻" }],
};

function expectPreview(outcome: CommitPreview | PrepareFailure): CommitPreview {
  if (!outcome.ok) throw new Error(`${outcome.code} ${outcome.reason}`);
  return outcome;
}

async function commitChapter1() {
  const preview = expectPreview(await prepareNow({ bookDir: book, chapter: 1, text: CH1, callModel: fakeModel(LEDGER1), knownNames: ["沈青禾"] }));
  const confirmed = await confirmNow(preview.ticket, CH1);
  if (!confirmed.ok) throw new Error(confirmed.message);
  return { preview, confirmed };
}

describe("定稿编排", () => {
  it("第 1 章：清单分「要你看的」和「自动记下的」，名字不带编号；确认后写正文 + 账单，投影跟着变", async () => {
    const { preview, confirmed } = await commitChapter1();
    expect(preview.review.map((item) => item.label)).toEqual(["出场：周守义（正文叫「老周」）"]);
    expect(preview.review[0]?.reasons[0]?.code).toBe("new-character");
    expect(preview.auto.map((item) => item.kind)).toEqual(["summary", "time", "presence", "fact", "fact", "thread"]);
    expect(preview.time).toMatchObject({ row: { start: { lo: 1, hi: 1 }, end: { lo: 1, hi: 1 }, basis: "ledger", weekday: 1, timeOfDay: "傍晚" }, declared: "text", segments: [], needsConfirm: false });
    expect(preview.notRecorded).toEqual([]);
    expect(JSON.stringify(preview)).not.toMatch(/c1-|t1-/u);

    expect(confirmed).toMatchObject({ ok: true, version: 1, replayed: false, result: { recorded: 7, rejected: [] } });
    expect(await readFile(join(book, "chapters/0001.md"), "utf-8")).toBe(CH1);
    const view = await projectBook(book);
    expect(view.cast.find((member) => member.name === "周守义")?.aliases).toEqual(["老周"]);
    expect(view.threads[0]).toMatchObject({ title: "钟为什么停", status: "open" });
  });

  it("记账员推进一条线索却没写说明：没记上的那条带线索名字，不只说「一条线索」", async () => {
    await commitChapter1();
    const preview = expectPreview(await prepareNow({
      bookDir: book,
      chapter: 2,
      text: CH2,
      callModel: fakeModel({
        summary: { text: "外乡人又来", quote: "外乡人又来了" },
        time: { start: { offset: 1, basis: "text", quote: "第二天上午" }, sameDay: true },
        threads: [{ op: "advance", thread: "T1", quote: "钟是被人故意拨停的" }],
      }),
    }));
    expect(preview.notRecorded).toEqual([{ code: "parse", label: "线索「钟为什么停」", reason: "没写这一章对它做了什么" }]);
  });

  it("一句说明推进两条线索：清单并成一行、标题并排；去掉这行两条都不记", async () => {
    const twoThreads = { ...LEDGER1, threads: [...LEDGER1.threads, { op: "open", type: "question", title: "钥匙开哪把锁", note: "钟箱里的铜钥匙", quote: "她在钟箱里摸到一把铜钥匙" }] };
    const first = expectPreview(await prepareNow({ bookDir: book, chapter: 1, text: CH1, callModel: fakeModel(twoThreads), knownNames: ["沈青禾", "周守义"] }));
    expect((await confirmNow(first.ticket, CH1)).ok).toBe(true);
    const preview = expectPreview(await prepareNow({
      bookDir: book,
      chapter: 2,
      text: CH2,
      callModel: fakeModel({
        summary: { text: "外乡人又来", quote: "外乡人又来了" },
        time: { start: { offset: 1, basis: "text", quote: "第二天上午" }, sameDay: true },
        threads: [{ op: "advance", thread: ["T1", "T2"], note: "钥匙锁进铜盒", quote: "沈青禾把钥匙锁进铜盒" }],
      }),
    }));
    const rows = preview.auto.filter((item) => item.kind === "thread");
    expect(rows.map((item) => item.label)).toEqual(["推进「钟为什么停」「钥匙开哪把锁」：钥匙锁进铜盒"]);
    expect(rows[0]?.merged).toHaveLength(1);
    const confirmed = await confirmNow(preview.ticket, CH2, { excluded: [rows[0]!.index, ...(rows[0]?.merged ?? [])] });
    expect(confirmed.ok).toBe(true);
    expect((await projectBook(book)).threads.map((thread) => thread.lastTouchedAt)).toEqual([1, 1]);
  });

  it("第 2 章：推进 / 收口用短号接上前文；原句对不上的如实列出；作者去掉一条、改天数；点两次只定稿一次", async () => {
    await commitChapter1();
    const preview = expectPreview(
      await prepareNow({
        bookDir: book,
        chapter: 2,
        text: CH2,
        callModel: fakeModel({
          summary: { text: "外乡人又来，沈青禾锁好钥匙", quote: "外乡人又来了" },
          // 记账员把同一天的章多记了一次换天（摘的那句正文里确有，代码核得上）：作者两头都填成第 5 天，按作者说的那一天记（P6 第 7 步），
          // 记账员记的那次换天照留，和作者定的对不上由投影列出来（写作版本 P3 设计 2.5）。
          time: { start: { offset: 1, basis: "text", quote: "第二天上午" }, dayChanges: [{ offset: 1, quote: "沈青禾把钥匙锁进铜盒" }], timeOfDay: "上午" },
          presence: [{ name: "周守义", nameUsed: "老周", quote: "老周站在门口" }, { name: "外乡人", nameUsed: "外乡人", quote: "外乡人又来了" }],
          facts: [
            { nature: "state", subject: "铜钥匙", attribute: "在哪", value: "铜盒里", text: "铜钥匙锁在铜盒里", quote: "沈青禾把钥匙锁进铜盒" },
            { nature: "event", text: "外乡人闯进了钟楼", quote: "外乡人闯进了钟楼" },
          ],
          threads: [{ op: "close", thread: "T1", note: "钟是被人故意拨停的", quote: "钟是被人故意拨停的" }],
        }),
      }),
    );
    const closing = preview.review.find((item) => item.kind === "thread");
    expect(closing?.label).toBe("收口「钟为什么停」：钟是被人故意拨停的");
    expect(preview.review.find((item) => item.kind === "presence")?.label).toBe("出场：外乡人");
    expect(preview.notRecorded).toEqual([{ code: "quote_not_in_text", label: "事实（发生过的事）：外乡人闯进了钟楼", reason: "「外乡人闯进了钟楼」没记上：附的原句在正文里找不到" }]);
    expect(preview.time).toMatchObject({ row: { start: { lo: 2, hi: 2 }, end: { lo: 3, hi: 3 } }, declared: "text" });

    const stranger = preview.review.find((item) => item.label === "出场：外乡人");
    const first = await confirmNow(preview.ticket, CH2, { excluded: [stranger!.index], day: 5, dayEnd: 5 }, "ch2");
    expect(first).toMatchObject({ ok: true, version: 2, replayed: false });
    const again = await confirmNow(preview.ticket, CH2, { excluded: [stranger!.index], day: 5, dayEnd: 5 }, "ch2");
    expect(again).toMatchObject({ ok: true, version: 2, replayed: true });

    const view = await projectBook(book);
    expect(view.chapters[1]?.time).toMatchObject({ start: { lo: 5, hi: 5 }, end: { lo: 5, hi: 5 }, basis: "author", timeOfDay: "上午" });
    // 作者定的开头（第 5 天）和按上一章推的（第 2 天）、作者定的结尾和按换天推的（第 6 天）都对不上：列出来，不改任何一边。
    expect(view.timeConflicts.map((conflict) => [conflict.kind, conflict.authorDay, conflict.expected])).toEqual([
      ["time-start", 5, { lo: 2, hi: 2 }],
      ["time-end", 5, { lo: 6, hi: 6 }],
    ]);
    expect(view.chapters[1]?.present).toEqual(["周守义"]);
    expect(view.threads[0]).toMatchObject({ status: "closed", closedAt: 2 });
    const ledger = JSON.parse(await readFile(join(book, "ledger/chapters/0002.json"), "utf-8"));
    expect(ledger.entries.find((entry: { kind: string; op?: string }) => entry.kind === "thread")?.review).toBe("author");
  });

  // 长篇实跑：第 24 章记账员记成第 20～21 天，其实是第 21～22 天；作者只能改成一天，章里第二天那段丢了（T4）。
  it("作者改天数也能记跨天：只给开头，结尾按记账员记的换天推；两头都给按作者的", async () => {
    await commitChapter1();
    const preview = expectPreview(
      await prepareNow({
        bookDir: book,
        chapter: 2,
        text: CH2,
        callModel: fakeModel({
          summary: { text: "外乡人又来，沈青禾锁好钥匙", quote: "外乡人又来了" },
          time: { start: { offset: 1, basis: "text", quote: "第二天上午" }, dayChanges: [{ offset: 1, quote: "沈青禾把钥匙锁进铜盒" }], timeOfDay: "上午" },
          presence: [{ name: "周守义", nameUsed: "老周", quote: "老周站在门口" }],
          facts: [],
          threads: [],
        }),
      }),
    );
    expect(preview.time.row).toMatchObject({ start: { lo: 2, hi: 2 }, end: { lo: 3, hi: 3 } });
    expect(commitEntriesOf(preview.ticket, { day: 5 }).filter((entry) => entry.kind === "time" || entry.kind === "day")).toEqual([
      expect.objectContaining({ kind: "time", dayChanges: [expect.objectContaining({ quote: "沈青禾把钥匙锁进铜盒" })] }),
      { kind: "day", review: "author", day: 5 },
    ]);
    expect(await confirmNow(preview.ticket, CH2, { day: 5 })).toMatchObject({ ok: true });
    const onlyStart = await projectBook(book);
    expect(onlyStart.chapters[1]?.time).toMatchObject({ start: { lo: 5, hi: 5 }, end: { lo: 6, hi: 6 }, basis: "author" });
    // 作者定的开头和按上一章推的对不上：列一条；结尾按章内跨度推，没有第二条。
    expect(onlyStart.timeConflicts.map((conflict) => conflict.kind)).toEqual(["time-start"]);

    const again = expectPreview(await prepareNow({ bookDir: book, chapter: 2, text: CH2, callModel: fakeModel({ time: { start: { offset: 1, basis: "text", quote: "第二天上午" }, sameDay: true } }) }));
    // 重定稿：作者上次定的天数照留（作者的，不是记账员的）；记账员这次看成同一天，和上次不一样：上次换天那句还在，照上次的记、两边给作者看。
    expect(again.ticket.entries.find((entry) => entry.kind === "day")).toMatchObject({ day: 5 });
    expect(again.time).toMatchObject({
      row: { start: { lo: 5, hi: 5 }, end: { lo: 6, hi: 6 }, basis: "author" },
      needsConfirm: true,
      sinceLast: { kept: true, other: { start: { lo: 5, hi: 5 }, end: { lo: 5, hi: 5 } } },
    });
    expect(await confirmNow(again.ticket, CH2, { day: 5, dayEnd: 6 })).toMatchObject({ ok: true });
    expect((await projectBook(book)).chapters[1]?.time).toMatchObject({ start: { lo: 5, hi: 5 }, end: { lo: 6, hi: 6 }, basis: "author" });
  });

  it("改了前面一章再定稿：记账员看得到这章上次开的线索，本章还在开就沿用编号，后文的推进接得上", async () => {
    await commitChapter1();
    const ch2 = expectPreview(await prepareNow({
      bookDir: book, chapter: 2, text: CH2,
      callModel: fakeModel({ threads: [{ op: "advance", thread: "T1", note: "知道是人为拨停", quote: "钟是被人故意拨停的" }] }),
    }));
    expect(await confirmNow(ch2.ticket, CH2)).toMatchObject({ ok: true });

    const edited = CH1.replace("老周没有拦她", "老周侧身让开了");
    const asked: string[] = [];
    const keeper: BrainCallModel = async (messages) => {
      const last = messages.at(-1)?.content ?? "";
      if (!last.includes("交这一章的账单")) return "笔记：老周＝周守义。";
      asked.push(last);
      // 换了个说法（标题对不上上次的），但填了上次的编号。
      return JSON.stringify({ threads: [{ op: "open", type: "question", title: "钟停在三点十五的缘故", thread: "r1", note: "钟停了", quote: "钟为什么偏偏停在这个时刻" }] });
    };
    const again = expectPreview(await prepareNow({ bookDir: book, chapter: 1, text: edited, callModel: keeper }));
    expect(asked[0]).toContain("R1 [悬念] 钟为什么停（上次记的：钟停在三点十五分）");
    const confirmed = await confirmNow(again.ticket, edited);
    expect(confirmed).toMatchObject({ ok: true, result: { recommitted: true, orphanedThreads: [] } });
    const view = await projectBook(book);
    expect(view.threads).toHaveLength(1);
    expect(view.threads[0]).toMatchObject({ title: "钟停在三点十五的缘故", openedAt: 1, lastTouchedAt: 2 });
  });

  // 作者长篇实跑 2026-10-27：第 5 章改错字重定稿，记账员把本章开的线索报成推进、被拒，定稿了第 45 章的收口就接不上。
  it("重定稿别丢本章开的线索：报成推进的按开记、没提但后文接着的照上次开、原句也没了如实说", async () => {
    await commitChapter1();
    const ch2 = expectPreview(await prepareNow({
      bookDir: book, chapter: 2, text: CH2,
      callModel: fakeModel({ threads: [{ op: "close", thread: "T1", note: "钟是被人故意拨停的", quote: "钟是被人故意拨停的" }] }),
    }));
    expect(await confirmNow(ch2.ticket, CH2)).toMatchObject({ ok: true });

    const typo = `${CH1}\n\n风停了。`;
    const asAdvance = expectPreview(await prepareNow({
      bookDir: book, chapter: 1, text: typo,
      callModel: fakeModel({ ...LEDGER1, threads: [{ op: "advance", thread: "R1", note: "钟停的缘故还没解开", quote: "钟为什么偏偏停在这个时刻" }] }),
    }));
    expect(asAdvance.notRecorded).toEqual([]);
    expect([...asAdvance.review, ...asAdvance.auto].find((item) => item.kind === "thread")?.label).toContain("钟为什么停");
    expect(asAdvance.lostThreads).toBeUndefined();
    expect(await confirmNow(asAdvance.ticket, typo)).toMatchObject({ ok: true, result: { orphanedThreads: [] } });
    expect((await projectBook(book)).threads).toEqual([expect.objectContaining({ title: "钟为什么停", openedAt: 1, status: "closed", closedAt: 2 })]);

    const omitted = expectPreview(await prepareNow({
      bookDir: book, chapter: 1, text: `${typo}\n\n钟楼外起了风。`,
      callModel: fakeModel({ ...LEDGER1, threads: [] }),
    }));
    expect([...omitted.review, ...omitted.auto].some((item) => item.kind === "thread")).toBe(true);
    expect(omitted.lostThreads).toBeUndefined();

    const gone = expectPreview(await prepareNow({
      bookDir: book, chapter: 1, text: typo.replace("钟为什么偏偏停在这个时刻？", ""),
      callModel: fakeModel({ ...LEDGER1, threads: [] }),
    }));
    expect(gone.lostThreads).toEqual(["钟为什么停"]);
  });

  // 换题材长篇实跑 2026-10-28：第 4 章改一个词重定稿，记账员把第 5～11 章还在推进的线索报成收口。
  it("重定稿收掉一条后文还在接着的线索：要你看、说清后文哪几章还接着、默认不记", async () => {
    await commitChapter1();
    const advance = (quote: string) => fakeModel({ threads: [{ op: "advance", thread: "T1", note: "钟停的缘故还没解开", quote }] });
    for (const [chapter, text, quote] of [[2, CH2, "老周站在门口，没让他进"], [3, "# 第3章 · 雨\n\n雨下了一夜，钟楼没人上去。", "钟楼没人上去"]] as const) {
      const preview = expectPreview(await prepareNow({ bookDir: book, chapter, text, callModel: advance(quote) }));
      expect(await confirmNow(preview.ticket, text)).toMatchObject({ ok: true });
    }
    const typo = CH2.replace("又来了", "又来了一趟");
    const recommit = expectPreview(await prepareNow({
      bookDir: book, chapter: 2, text: typo,
      callModel: fakeModel({ threads: [{ op: "close", thread: "T1", note: "钟是被人故意拨停的", quote: "钟是被人故意拨停的" }] }),
    }));
    const close = recommit.review.find((item) => item.kind === "thread");
    expect(close).toMatchObject({ optIn: true, reasons: [{ code: "closes-thread", text: "后文第 3 章还在接着这条：这里收了，后面就接不上，默认不记" }] });
    expect(await confirmNow(recommit.ticket, typo)).toMatchObject({ ok: true });
    expect((await projectBook(book)).threads[0]).toMatchObject({ title: "钟为什么停", status: "active", lastTouchedAt: 3 });
  });

  // 作者长篇实跑 2026-10-27：第 5 章改一个错字重定稿，记账员这次把天数看错一天，后面 45 章跟着挪。
  it("重定稿天数：上次记时间那句还在就照上次的，记账员这次看的不一样两边都给作者看；那句改没了按这次的", async () => {
    await commitChapter1();
    const ch2Ledger = (time: Record<string, unknown>) => fakeModel({ time, presence: [{ name: "周守义", nameUsed: "老周", quote: "老周" }] });
    const first = expectPreview(await prepareNow({
      bookDir: book, chapter: 2, text: CH2,
      callModel: ch2Ledger({ start: { offset: 1, basis: "judged", quote: "第二天上午" }, sameDay: true, timeOfDay: "上午" }),
    }));
    expect(await confirmNow(first.ticket, CH2)).toMatchObject({ ok: true });
    expect((await projectBook(book)).chapters[1]?.time.start).toEqual({ lo: 2, hi: 2 });

    // 只改了一个字，记账员这次看成当天：照上次的第 2 天记，列出这次看成的第 1 天。
    const typo = CH2.replace("没让他进", "没让他进门");
    const same = expectPreview(await prepareNow({
      bookDir: book, chapter: 2, text: typo,
      callModel: ch2Ledger({ start: { offset: 0, basis: "judged", quote: "外乡人又来了" }, sameDay: true, timeOfDay: "上午" }),
    }));
    expect(same.time).toMatchObject({
      row: { start: { lo: 2, hi: 2 }, end: { lo: 2, hi: 2 } },
      needsConfirm: true,
      sinceLast: { kept: true, other: { start: { lo: 1, hi: 1 }, end: { lo: 1, hi: 1 } } },
    });
    expect(await confirmNow(same.ticket, typo)).toMatchObject({ ok: true });
    expect((await projectBook(book)).chapters[1]?.time).toMatchObject({ start: { lo: 2, hi: 2 }, timeOfDay: "上午" });

    // 天数一样：不多问。
    const again = expectPreview(await prepareNow({
      bookDir: book, chapter: 2, text: typo,
      callModel: ch2Ledger({ start: { offset: 1, basis: "judged", quote: "第二天上午" }, sameDay: true, timeOfDay: "上午" }),
    }));
    expect(again.time.needsConfirm).toBe(false);
    expect(again.time.sinceLast).toBeUndefined();

    // 记时间那句改掉了：上次那条接不上，按这次的记，列出上次的第 2 天。
    const rewritten = typo.replace("第二天上午", "三天后的上午");
    const moved = expectPreview(await prepareNow({
      bookDir: book, chapter: 2, text: rewritten,
      callModel: ch2Ledger({ start: { offset: 3, basis: "text", quote: "三天后的上午" }, sameDay: true, timeOfDay: "上午" }),
    }));
    expect(moved.time).toMatchObject({ row: { start: { lo: 4, hi: 4 } }, needsConfirm: true, sinceLast: { kept: false, other: { start: { lo: 2, hi: 2 }, end: { lo: 2, hi: 2 } } } });

    // 记时间那句里加了字、原句还在（P3a 改早章：「这天下午，……」前面加「过了两天，」）：那句改过了，按这次的记。
    const prefixed = typo.replace("第二天上午", "又过了两天，第二天上午");
    const shifted = expectPreview(await prepareNow({
      bookDir: book, chapter: 2, text: prefixed,
      callModel: ch2Ledger({ start: { offset: 3, basis: "text", quote: "又过了两天，第二天上午" }, sameDay: true, timeOfDay: "上午" }),
    }));
    expect(shifted.time).toMatchObject({ row: { start: { lo: 4, hi: 4 } }, needsConfirm: true, sinceLast: { kept: false, other: { start: { lo: 2, hi: 2 } } } });

    // 出口复核第 5 轮 R11：盘上的定稿正文不是记那套时间时的那版（被外面改了、没了）：证明不了那几句没改，照这次的，两边给作者看。
    for (const broken of [async () => writeFile(join(book, "chapters/0002.md"), prefixed), async () => rm(join(book, "chapters/0002.md"))]) {
      await broken();
      const unproven = expectPreview(await prepareNow({
        bookDir: book, chapter: 2, text: typo,
        callModel: ch2Ledger({ start: { offset: 0, basis: "judged", quote: "外乡人又来了" }, sameDay: true, timeOfDay: "上午" }),
      }));
      expect(unproven.time).toMatchObject({ row: { start: { lo: 1, hi: 1 } }, needsConfirm: true, sinceLast: { kept: false, other: { start: { lo: 2, hi: 2 } } } });
    }
  });

  // 出口复核 R6：中间有一次账待记（记账没成先定正文），再定稿时也照最近那次记的时间比，段也读得回。
  it("重定稿天数：中间账待记过，照最近那次记的时间比、段一起读回", async () => {
    await commitChapter1();
    const ch2Ledger = (time: Record<string, unknown>) => fakeModel({ time, presence: [{ name: "周守义", nameUsed: "老周", quote: "老周" }] });
    const segment = { frame: "past", firstQuote: "她终于明白了", lastQuote: "她终于明白了" };
    const first = expectPreview(await prepareNow({
      bookDir: book, chapter: 2, text: CH2,
      callModel: ch2Ledger({ start: { offset: 1, basis: "judged", quote: "第二天上午" }, sameDay: true, segments: [segment] }),
    }));
    expect(await confirmNow(first.ticket, CH2)).toMatchObject({ ok: true });
    // 账待记那次正文没改（记账员没交成，作者先定了正文）：盘上还是记那套时间时的正文，照上次的。
    const pending = await runCommand(book, chapterCommit, { chapter: 2, text: CH2, entries: [], ledger: { status: "pending", reasonCodes: ["keeper_failed"] } }, { caller: "author", idempotencyKey: "pending-2" });
    expect(pending).toMatchObject({ ok: true });
    const same = expectPreview(await prepareNow({
      bookDir: book, chapter: 2, text: CH2,
      callModel: ch2Ledger({ start: { offset: 0, basis: "judged", quote: "外乡人又来了" }, sameDay: true }),
    }));
    expect(same.time).toMatchObject({ row: { start: { lo: 2, hi: 2 } }, needsConfirm: true, sinceLast: { kept: true, other: { start: { lo: 1, hi: 1 } } } });
    expect(same.ticket.entries.find((entry) => entry.kind === "time")).toMatchObject({ segments: [expect.objectContaining({ frame: "past" })] });

    // 出口复核第 5 轮 R11：账待记那次换了正文，记那套时间时的正文不在盘上了，证明不了记时间那几句没改：照这次的，两边给作者看。
    const typo = CH2.replace("没让他进", "没让他进门");
    expect(await runCommand(book, chapterCommit, { chapter: 2, text: typo, entries: [], ledger: { status: "pending", reasonCodes: ["keeper_failed"] } }, { caller: "author", idempotencyKey: "pending-2b" })).toMatchObject({ ok: true });
    const changed = expectPreview(await prepareNow({
      bookDir: book, chapter: 2, text: typo,
      callModel: ch2Ledger({ start: { offset: 0, basis: "judged", quote: "外乡人又来了" }, sameDay: true }),
    }));
    expect(changed.time).toMatchObject({ row: { start: { lo: 1, hi: 1 } }, needsConfirm: true, sinceLast: { kept: false, other: { start: { lo: 2, hi: 2 } } } });
  });

  // 出口复核第 2 轮 R6c：后来哪次时间没记上、作者照样改了天数，账待记之后再定稿用的是作者最近定的那天。
  it("重定稿：中间一次时间没记上但作者改过天数，账待记之后照作者最近定的", async () => {
    await commitChapter1();
    const first = expectPreview(await prepareNow({
      bookDir: book, chapter: 2, text: CH2,
      callModel: fakeModel({ time: { start: { offset: 1, basis: "text", quote: "第二天上午" }, sameDay: true } }),
    }));
    expect(await confirmNow(first.ticket, CH2, { day: 5, dayEnd: 5 })).toMatchObject({ ok: true });
    const partial = await runCommand(book, chapterCommit, {
      chapter: 2, text: CH2, entries: [{ kind: "day", review: "author", day: 10, dayEnd: 11 }],
      ledger: { status: "partial", reasonCodes: ["quote_repair_failed"], missingKinds: ["time"] },
    }, { caller: "author", idempotencyKey: "partial-2" });
    expect(partial).toMatchObject({ ok: true });
    expect(await runCommand(book, chapterCommit, { chapter: 2, text: CH2, entries: [], ledger: { status: "pending", reasonCodes: ["keeper_failed"] } }, { caller: "author", idempotencyKey: "pending-2" })).toMatchObject({ ok: true });
    const again = expectPreview(await prepareNow({
      bookDir: book, chapter: 2, text: CH2,
      callModel: fakeModel({ time: { start: { offset: 1, basis: "text", quote: "第二天上午" }, sameDay: true } }),
    }));
    expect(again.ticket.entries.find((entry) => entry.kind === "day")).toMatchObject({ day: 10, dayEnd: 11 });

    // 第 3 轮 R6c2：后来那次只定了开头，作者定的天数整套是那次的，更早那版的结尾不拼回来。
    const onlyStart = await runCommand(book, chapterCommit, {
      chapter: 2, text: CH2, entries: [{ kind: "day", review: "author", day: 12 }],
      ledger: { status: "partial", reasonCodes: ["quote_repair_failed"], missingKinds: ["time"] },
    }, { caller: "author", idempotencyKey: "partial-2b" });
    expect(onlyStart).toMatchObject({ ok: true });
    expect(await runCommand(book, chapterCommit, { chapter: 2, text: CH2, entries: [], ledger: { status: "pending", reasonCodes: ["keeper_failed"] } }, { caller: "author", idempotencyKey: "pending-2b" })).toMatchObject({ ok: true });
    const third = expectPreview(await prepareNow({
      bookDir: book, chapter: 2, text: CH2,
      callModel: fakeModel({ time: { start: { offset: 1, basis: "text", quote: "第二天上午" }, sameDay: true } }),
    }));
    const day = third.ticket.entries.find((entry) => entry.kind === "day");
    expect(day).toMatchObject({ day: 12 });
    expect(day).not.toHaveProperty("dayEnd");
  });

  it("重定稿：上次定稿认过的出场人物（含泛称）不再当第一次出场问；这次新冒出来的照问", async () => {
    const first = expectPreview(await prepareNow({ bookDir: book, chapter: 1, text: CH1, callModel: fakeModel(LEDGER1) }));
    expect(first.review.map((item) => item.label)).toEqual(expect.arrayContaining(["出场：沈青禾，视角人物", "出场：周守义（正文叫「老周」）"]));
    expect(await confirmNow(first.ticket, CH1)).toMatchObject({ ok: true });

    const edited = CH1.replace("老周没有拦她", "老周没有拦她，门边站着个老头");
    const ledger = { ...LEDGER1, presence: [...LEDGER1.presence, { name: "老头", nameUsed: "老头", generic: true, quote: "门边站着个老头" }] };
    const again = expectPreview(await prepareNow({ bookDir: book, chapter: 1, text: edited, callModel: fakeModel(ledger) }));
    const askedNames = (preview: CommitPreview) => preview.review.filter((item) => item.reasons.some((reason) => reason.code === "new-character")).map((item) => item.label);
    expect(askedNames(again)).toEqual(["出场：老头"]);
    expect(await confirmNow(again.ticket, edited)).toMatchObject({ ok: true });
    const third = expectPreview(await prepareNow({ bookDir: book, chapter: 1, text: `${edited}\n\n钟又走了。`, callModel: fakeModel(ledger) }));
    expect(askedNames(third)).toEqual([]);
  });

  it("跳章、空正文、老书没导入、记账员没交上：都不出清单，如实说", async () => {
    expect(await prepareNow({ bookDir: book, chapter: 3, text: CH2, callModel: fakeModel(LEDGER1) })).toMatchObject({ ok: false, code: "chapter_gap" });
    expect(await prepareNow({ bookDir: book, chapter: 1, text: "  ", callModel: fakeModel(LEDGER1) })).toMatchObject({ ok: false, code: "empty_text" });
    expect(await prepareNow({ bookDir: book, chapter: 1, text: CH1, callModel: async () => "记不了" })).toMatchObject({ ok: false, code: "keeper_failed" });

    const old = await makeHomeTempDir("commit-flow-old-");
    try {
      await mkdir(join(old, "chapters"), { recursive: true });
      await writeFile(join(old, "chapters/0001.md"), CH1);
      expect(await prepareNow({ bookDir: old, chapter: 2, text: CH2, callModel: fakeModel(LEDGER1) })).toMatchObject({ ok: false, code: "not_imported" });
    } finally {
      await rm(old, { recursive: true, force: true });
    }
  });

  it("正文指纹：只收掉了多余空行、行尾空白（字没动）对得上；多一个字就对不上", () => {
    const loose = CH1.replace(/\n\n/gu, "\n\n\n\n").concat("  \n");
    expect(draftFingerprint(loose)).toBe(draftFingerprint(CH1));
    expect(draftFingerprint(`${CH1}\n加了一句。`)).not.toBe(draftFingerprint(CH1));
  });

  it("预览之后前面章的账变了：旧票不定稿、说清哪章变了；重新预览照新的天数算（Astra 探针 P3）", async () => {
    const first = "# 一\n\n老张回家了。";
    const next = "# 二\n\n第二天上午，老张出门。";
    const commitDay = async (day: number) => {
      const outcome = await runCommand(book, chapterCommit, { chapter: 1, text: first, entries: [{ kind: "day", review: "author", day, dayEnd: day }] }, { caller: "author", idempotencyKey: `day-${day}` });
      expect(outcome.ok).toBe(true);
    };
    const model: BrainCallModel = async (messages) => messages.at(-1)!.content.includes("交这一章的账单")
      ? JSON.stringify({ time: { start: { offset: 1, basis: "text", quote: "第二天上午" }, sameDay: true } })
      : "老张回家。";
    await commitDay(1);
    const stale = expectPreview(await prepareNow({ bookDir: book, chapter: 2, text: next, callModel: model }));
    expect(stale.time.row.start?.lo).toBe(2);
    await commitDay(20);
    const refused = await confirmNow(stale.ticket, next);
    expect(refused).toMatchObject({ ok: false, code: "basis_changed" });
    expect(describeBasisChanges((refused as { readonly details: { readonly changes: readonly BasisChange[] } }).details.changes)).toContain("第 1 章的账");
    expect((await projectBook(book)).chapters.find((chapter) => chapter.chapter === 2)).toBeUndefined();
    const fresh = expectPreview(await prepareNow({ bookDir: book, chapter: 2, text: next, callModel: model }));
    expect(fresh.time.row.start?.lo).toBe(21);
    expect(await confirmNow(fresh.ticket, next)).toMatchObject({ ok: true });
    expect((await projectBook(book)).chapters.find((chapter) => chapter.chapter === 2)?.time.start?.lo).toBe(21);
  });

});
