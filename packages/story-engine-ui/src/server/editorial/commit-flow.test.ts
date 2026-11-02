// @vitest-environment node
//
// 定稿编排：记账员交账单 → 核原句 → 票；重定稿沿用上次的线索、天数；会改掉前文不会变的、收掉后文还接着的不写。
// 安静账房（2026-11-03）：清单不给作者看了，这里只看票里的条目和定稿后的投影。
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chapterCommit, projectBook, readTruthBasis, runCommand, type BasisChange, type EntryInput } from "@actalk/story-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import { describeBasisChanges } from "../book/truth-basis.js";
import { commitEntriesOf, draftFingerprint, prepareChapterCommit, type CommitPreview, type PrepareFailure, type PrepareInput, type PreviewTicket } from "./commit-flow.js";
import type { BrainCallModel } from "./reader-window.js";

/** 照「先取依据、再读材料」的顺序调（第 8 轮复核 V4）：现取一份依据交进去。 */
const prepareNow = async (input: Omit<PrepareInput, "basis">) => prepareChapterCommit({ ...input, basis: await readTruthBasis(input.bookDir) });

/** 照票定稿（commit.prepare 定稿那步同一个做法：条目照票算、依据照票核）；extra = 安静账房之前作者在清单上定的天数那类。 */
const confirmNow = (ticket: PreviewTicket, text: string, idempotencyKey: string = randomUUID(), extra: readonly EntryInput[] = []) =>
  runCommand(book, chapterCommit, { chapter: ticket.chapter, text, entries: [...commitEntriesOf(ticket), ...extra] }, { caller: "author", basis: ticket.basis, idempotencyKey });

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
    return (last.includes("交这一章的账单") || last.includes("只记本章东西的去向")) ? JSON.stringify(ledger) : "笔记：老周＝周守义。";
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

type TimeEntry = Extract<EntryInput, { kind: "time" }>;
const timeOf = (preview: CommitPreview): TimeEntry | undefined => preview.ticket.entries.find((entry): entry is TimeEntry => entry.kind === "time");
/** 票里时间那条开头附的那句（看照的是上次的还是这次的）。 */
const startQuote = (preview: CommitPreview): string | undefined => {
  const start = timeOf(preview)?.start;
  return start && start !== "unknown" ? start.quote : undefined;
};
const threadsOf = (preview: CommitPreview) => preview.ticket.entries.filter((entry) => entry.kind === "thread");

async function commitChapter1() {
  const preview = expectPreview(await prepareNow({ bookDir: book, chapter: 1, text: CH1, callModel: fakeModel(LEDGER1) }));
  const confirmed = await confirmNow(preview.ticket, CH1);
  if (!confirmed.ok) throw new Error(confirmed.message);
  return { preview, confirmed };
}

describe("定稿编排", () => {
  it("第 1 章：核过的条目全进票、没有不写的；定稿写正文 + 账单，记下的都算自动记的，投影跟着变", async () => {
    const { preview, confirmed } = await commitChapter1();
    expect(preview.ticket.entries.map((entry) => entry.kind).sort()).toEqual(["fact", "fact", "presence", "presence", "summary", "thread", "time"]);
    expect(preview.ticket.optInIndexes).toEqual([]);
    expect(preview.ticket.textSha256).toBe(draftFingerprint(CH1));

    expect(confirmed).toMatchObject({ ok: true, version: 1, replayed: false, result: { recorded: 7, rejected: [] } });
    expect(await readFile(join(book, "chapters/0001.md"), "utf-8")).toBe(CH1);
    const ledger = JSON.parse(await readFile(join(book, "ledger/chapters/0001.json"), "utf-8"));
    expect(ledger.entries.every((entry: { review: string }) => entry.review === "auto")).toBe(true);
    const view = await projectBook(book);
    expect(view.cast.find((member) => member.name === "周守义")?.aliases).toEqual(["老周"]);
    expect(view.threads[0]).toMatchObject({ title: "钟为什么停", status: "open" });
    expect(view.chapters[0]?.time).toMatchObject({ start: { lo: 1, hi: 1 }, end: { lo: 1, hi: 1 }, basis: "ledger", weekday: 1, timeOfDay: "傍晚" });
  });

  it("一句说明推进两条线索：两条都按短号接上前文、都记下", async () => {
    const twoThreads = { ...LEDGER1, threads: [...LEDGER1.threads, { op: "open", type: "question", title: "钥匙开哪把锁", note: "钟箱里的铜钥匙", quote: "她在钟箱里摸到一把铜钥匙" }] };
    const first = expectPreview(await prepareNow({ bookDir: book, chapter: 1, text: CH1, callModel: fakeModel(twoThreads) }));
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
    expect(threadsOf(preview)).toHaveLength(2);
    expect((await confirmNow(preview.ticket, CH2)).ok).toBe(true);
    expect((await projectBook(book)).threads.map((thread) => thread.lastTouchedAt)).toEqual([2, 2]);
  });

  it("第 2 章：收口用短号接上前文；原句对不上的不进票；天数按记账员记的换天推；点两次只定稿一次", async () => {
    await commitChapter1();
    const preview = expectPreview(
      await prepareNow({
        bookDir: book,
        chapter: 2,
        text: CH2,
        callModel: fakeModel({
          summary: { text: "外乡人又来，沈青禾锁好钥匙", quote: "外乡人又来了" },
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
    expect(preview.ticket.entries.flatMap((entry) => (entry.kind === "fact" ? [entry.text] : []))).toEqual(["铜钥匙锁在铜盒里"]);
    expect(threadsOf(preview)).toEqual([expect.objectContaining({ op: "close", note: "钟是被人故意拨停的" })]);
    expect(preview.ticket.optInIndexes).toEqual([]);

    expect(await confirmNow(preview.ticket, CH2, "ch2")).toMatchObject({ ok: true, version: 2, replayed: false });
    expect(await confirmNow(preview.ticket, CH2, "ch2")).toMatchObject({ ok: true, version: 2, replayed: true });

    const view = await projectBook(book);
    expect(view.chapters[1]?.time).toMatchObject({ start: { lo: 2, hi: 2 }, end: { lo: 3, hi: 3 }, basis: "ledger", timeOfDay: "上午" });
    expect(view.chapters[1]?.present).toEqual(["周守义", "外乡人"]);
    expect(view.threads[0]).toMatchObject({ status: "closed", closedAt: 2 });
    const ledger = JSON.parse(await readFile(join(book, "ledger/chapters/0002.json"), "utf-8"));
    expect(ledger.entries.find((entry: { kind: string }) => entry.kind === "thread")?.review).toBe("auto");
  });

  it("会改掉前文不会变的事实：不写（不替作者改前文），其余照记", async () => {
    await commitChapter1();
    const text = "# 第2章 · 四点\n\n第二天上午，钟停在四点整。沈青禾把钥匙锁进铜盒。";
    const preview = expectPreview(await prepareNow({
      bookDir: book, chapter: 2, text,
      callModel: fakeModel({
        summary: { text: "钥匙锁进铜盒", quote: "沈青禾把钥匙锁进铜盒" },
        facts: [
          { nature: "state", subject: "铜钥匙", attribute: "在哪", value: "铜盒里", text: "铜钥匙锁在铜盒里", quote: "沈青禾把钥匙锁进铜盒" },
          { nature: "hard", subject: "钟", attribute: "停的时刻", value: "四点整", text: "钟停在四点整", quote: "钟停在四点整" },
        ],
      }),
    }));
    expect(preview.ticket.optInIndexes.map((index) => preview.ticket.entries[index])).toEqual([expect.objectContaining({ kind: "fact", text: "钟停在四点整" })]);
    expect(commitEntriesOf(preview.ticket).flatMap((entry) => (entry.kind === "fact" ? [entry.text] : []))).toEqual(["铜钥匙锁在铜盒里"]);
    expect(await confirmNow(preview.ticket, text)).toMatchObject({ ok: true });
    const view = await projectBook(book);
    expect(view.conflicts).toEqual([]);
    expect(view.facts.map((fact) => fact.text)).not.toContain("钟停在四点整");
  });

  // 长篇实跑：第 24 章记账员记成第 20～21 天，作者只能改成一天，章里第二天那段丢了（T4）。安静账房之前作者在清单上定的天数还在老书里。
  it("重定稿：作者上次定的天数照留；记账员这次看成同一天、上次换天那句还在，时间照上次的记", async () => {
    await commitChapter1();
    const ledger = (time: Record<string, unknown>) => fakeModel({ summary: { text: "外乡人又来，沈青禾锁好钥匙", quote: "外乡人又来了" }, time, presence: [{ name: "周守义", nameUsed: "老周", quote: "老周站在门口" }] });
    const first = expectPreview(await prepareNow({
      bookDir: book, chapter: 2, text: CH2,
      callModel: ledger({ start: { offset: 1, basis: "text", quote: "第二天上午" }, dayChanges: [{ offset: 1, quote: "沈青禾把钥匙锁进铜盒" }], timeOfDay: "上午" }),
    }));
    expect(await confirmNow(first.ticket, CH2, randomUUID(), [{ kind: "day", review: "author", day: 5 }])).toMatchObject({ ok: true });
    const onlyStart = await projectBook(book);
    // 只给了开头：结尾按记账员记的换天推；作者定的开头和按上一章推的对不上，列一条。
    expect(onlyStart.chapters[1]?.time).toMatchObject({ start: { lo: 5, hi: 5 }, end: { lo: 6, hi: 6 }, basis: "author" });
    expect(onlyStart.timeConflicts.map((conflict) => conflict.kind)).toEqual(["time-start"]);

    const again = expectPreview(await prepareNow({ bookDir: book, chapter: 2, text: CH2, callModel: ledger({ start: { offset: 1, basis: "text", quote: "第二天上午" }, sameDay: true }) }));
    expect(again.ticket.entries.find((entry) => entry.kind === "day")).toMatchObject({ day: 5 });
    expect(timeOf(again)?.dayChanges).toEqual([expect.objectContaining({ quote: "沈青禾把钥匙锁进铜盒" })]);
    expect(await confirmNow(again.ticket, CH2)).toMatchObject({ ok: true });
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
      if (!(last.includes("交这一章的账单") || last.includes("只记本章东西的去向"))) return "笔记：老周＝周守义。";
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
  it("重定稿别丢本章开的线索：报成推进的按开记、没提但后文接着的照上次开；原句也没了就不记", async () => {
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
    expect(threadsOf(asAdvance)).toEqual([expect.objectContaining({ op: "open", title: "钟为什么停" })]);
    expect(await confirmNow(asAdvance.ticket, typo)).toMatchObject({ ok: true, result: { orphanedThreads: [] } });
    expect((await projectBook(book)).threads).toEqual([expect.objectContaining({ title: "钟为什么停", openedAt: 1, status: "closed", closedAt: 2 })]);

    const omitted = expectPreview(await prepareNow({
      bookDir: book, chapter: 1, text: `${typo}\n\n钟楼外起了风。`,
      callModel: fakeModel({ ...LEDGER1, threads: [] }),
    }));
    expect(threadsOf(omitted)).toEqual([expect.objectContaining({ op: "open", title: "钟为什么停" })]);

    const gone = expectPreview(await prepareNow({
      bookDir: book, chapter: 1, text: typo.replace("钟为什么偏偏停在这个时刻？", ""),
      callModel: fakeModel({ ...LEDGER1, threads: [] }),
    }));
    expect(threadsOf(gone)).toEqual([]);
  });

  // 换题材长篇实跑 2026-10-28：第 4 章改一个词重定稿，记账员把第 5～11 章还在推进的线索报成收口。
  it("重定稿收掉一条后文还在接着的线索：不写，后面接得上", async () => {
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
    expect(recommit.ticket.optInIndexes.map((index) => recommit.ticket.entries[index])).toEqual([expect.objectContaining({ kind: "thread", op: "close" })]);
    expect(commitEntriesOf(recommit.ticket).some((entry) => entry.kind === "thread")).toBe(false);
    expect(await confirmNow(recommit.ticket, typo)).toMatchObject({ ok: true });
    expect((await projectBook(book)).threads[0]).toMatchObject({ title: "钟为什么停", status: "active", lastTouchedAt: 3 });
  });

  // 作者长篇实跑 2026-10-27：第 5 章改一个错字重定稿，记账员这次把天数看错一天，后面 45 章跟着挪。
  it("重定稿天数：上次记时间那句还在就照上次的；那句改过、记那套时间的正文读不到就照这次的", async () => {
    await commitChapter1();
    const ch2Ledger = (time: Record<string, unknown>) => fakeModel({ time, presence: [{ name: "周守义", nameUsed: "老周", quote: "老周" }] });
    const first = expectPreview(await prepareNow({
      bookDir: book, chapter: 2, text: CH2,
      callModel: ch2Ledger({ start: { offset: 1, basis: "judged", quote: "第二天上午" }, sameDay: true, timeOfDay: "上午" }),
    }));
    expect(await confirmNow(first.ticket, CH2)).toMatchObject({ ok: true });
    expect((await projectBook(book)).chapters[1]?.time.start).toEqual({ lo: 2, hi: 2 });

    // 只改了一个字，记账员这次看成当天：照上次的第 2 天记。
    const typo = CH2.replace("没让他进", "没让他进门");
    const same = expectPreview(await prepareNow({
      bookDir: book, chapter: 2, text: typo,
      callModel: ch2Ledger({ start: { offset: 0, basis: "judged", quote: "外乡人又来了" }, sameDay: true, timeOfDay: "上午" }),
    }));
    expect(startQuote(same)).toBe("第二天上午");
    expect(await confirmNow(same.ticket, typo)).toMatchObject({ ok: true });
    expect((await projectBook(book)).chapters[1]?.time).toMatchObject({ start: { lo: 2, hi: 2 }, timeOfDay: "上午" });

    // 记时间那句改掉了：上次那条接不上，按这次的记。
    const rewritten = typo.replace("第二天上午", "三天后的上午");
    const moved = expectPreview(await prepareNow({
      bookDir: book, chapter: 2, text: rewritten,
      callModel: ch2Ledger({ start: { offset: 3, basis: "text", quote: "三天后的上午" }, sameDay: true, timeOfDay: "上午" }),
    }));
    expect(startQuote(moved)).toBe("三天后的上午");

    // 记时间那句里加了字、原句还在（P3a 改早章：「这天下午，……」前面加「过了两天，」）：那句改过了，按这次的记。
    const prefixed = typo.replace("第二天上午", "又过了两天，第二天上午");
    const shifted = expectPreview(await prepareNow({
      bookDir: book, chapter: 2, text: prefixed,
      callModel: ch2Ledger({ start: { offset: 3, basis: "text", quote: "又过了两天，第二天上午" }, sameDay: true, timeOfDay: "上午" }),
    }));
    expect(startQuote(shifted)).toBe("又过了两天，第二天上午");

    // 出口复核第 5 轮 R11：盘上的定稿正文不是记那套时间时的那版（被外面改了、没了）：证明不了那几句没改，照这次的。
    for (const broken of [async () => writeFile(join(book, "chapters/0002.md"), prefixed), async () => rm(join(book, "chapters/0002.md"))]) {
      await broken();
      const unproven = expectPreview(await prepareNow({
        bookDir: book, chapter: 2, text: typo,
        callModel: ch2Ledger({ start: { offset: 0, basis: "judged", quote: "外乡人又来了" }, sameDay: true, timeOfDay: "上午" }),
      }));
      expect(startQuote(unproven)).toBe("外乡人又来了");
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
    // 账待记那次正文没改（记账员没交成，先定了正文）：盘上还是记那套时间时的正文，照上次的。
    const pending = await runCommand(book, chapterCommit, { chapter: 2, text: CH2, entries: [], ledger: { status: "pending", reasonCodes: ["keeper_failed"] } }, { caller: "author", idempotencyKey: "pending-2" });
    expect(pending).toMatchObject({ ok: true });
    const same = expectPreview(await prepareNow({
      bookDir: book, chapter: 2, text: CH2,
      callModel: ch2Ledger({ start: { offset: 0, basis: "judged", quote: "外乡人又来了" }, sameDay: true }),
    }));
    expect(startQuote(same)).toBe("第二天上午");
    expect(timeOf(same)).toMatchObject({ segments: [expect.objectContaining({ frame: "past" })] });

    // 出口复核第 5 轮 R11：账待记那次换了正文，记那套时间时的正文不在盘上了，证明不了记时间那几句没改：照这次的。
    const typo = CH2.replace("没让他进", "没让他进门");
    expect(await runCommand(book, chapterCommit, { chapter: 2, text: typo, entries: [], ledger: { status: "pending", reasonCodes: ["keeper_failed"] } }, { caller: "author", idempotencyKey: "pending-2b" })).toMatchObject({ ok: true });
    const changed = expectPreview(await prepareNow({
      bookDir: book, chapter: 2, text: typo,
      callModel: ch2Ledger({ start: { offset: 0, basis: "judged", quote: "外乡人又来了" }, sameDay: true }),
    }));
    expect(startQuote(changed)).toBe("外乡人又来了");
  });

  // 出口复核第 2 轮 R6c：后来哪次时间没记上、作者照样改了天数，账待记之后再定稿用的是作者最近定的那天。
  it("重定稿：中间一次时间没记上但作者改过天数，账待记之后照作者最近定的", async () => {
    await commitChapter1();
    const first = expectPreview(await prepareNow({
      bookDir: book, chapter: 2, text: CH2,
      callModel: fakeModel({ time: { start: { offset: 1, basis: "text", quote: "第二天上午" }, sameDay: true } }),
    }));
    expect(await confirmNow(first.ticket, CH2, randomUUID(), [{ kind: "day", review: "author", day: 5, dayEnd: 5 }])).toMatchObject({ ok: true });
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

  it("跳章、空正文、老书没导入、记账员没交上：都不出票，如实说", async () => {
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

  it("记账之后前面章的账变了：旧票不定稿、说清哪章变了；重新记照新的天数算（Astra 探针 P3）", async () => {
    const first = "# 一\n\n老张回家了。";
    const next = "# 二\n\n第二天上午，老张出门。";
    const commitDay = async (day: number) => {
      const outcome = await runCommand(book, chapterCommit, { chapter: 1, text: first, entries: [{ kind: "day", review: "author", day, dayEnd: day }] }, { caller: "author", idempotencyKey: `day-${day}` });
      expect(outcome.ok).toBe(true);
    };
    const model: BrainCallModel = async (messages) => (messages.at(-1)!.content.includes("交这一章的账单") || messages.at(-1)!.content.includes("只记本章东西的去向"))
      ? JSON.stringify({ time: { start: { offset: 1, basis: "text", quote: "第二天上午" }, sameDay: true } })
      : "老张回家。";
    await commitDay(1);
    const stale = expectPreview(await prepareNow({ bookDir: book, chapter: 2, text: next, callModel: model }));
    await commitDay(20);
    const refused = await confirmNow(stale.ticket, next);
    expect(refused).toMatchObject({ ok: false, code: "basis_changed" });
    expect(describeBasisChanges((refused as { readonly details: { readonly changes: readonly BasisChange[] } }).details.changes)).toContain("第 1 章的账");
    expect((await projectBook(book)).chapters.find((chapter) => chapter.chapter === 2)).toBeUndefined();
    const fresh = expectPreview(await prepareNow({ bookDir: book, chapter: 2, text: next, callModel: model }));
    expect(await confirmNow(fresh.ticket, next)).toMatchObject({ ok: true });
    expect((await projectBook(book)).chapters.find((chapter) => chapter.chapter === 2)?.time.start?.lo).toBe(21);
  });
});
