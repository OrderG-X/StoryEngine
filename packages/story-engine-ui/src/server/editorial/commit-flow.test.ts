// @vitest-environment node
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { projectBook, readHead } from "@actalk/story-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import { confirmChapterCommit, fileTicketStore, memoryTicketStore, prepareChapterCommit, type CommitPreview, type PrepareFailure } from "./commit-flow.js";
import type { BrainCallModel } from "./reader-window.js";

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
  time: { basis: "text", weekday: "周二", timeOfDay: "傍晚", quote: "周二傍晚" },
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

async function commitChapter1(tickets = memoryTicketStore()) {
  const preview = expectPreview(await prepareChapterCommit({ bookDir: book, chapter: 1, text: CH1, callModel: fakeModel(LEDGER1), tickets, knownNames: ["沈青禾"] }));
  const confirmed = await confirmChapterCommit({ bookDir: book, ticket: preview.ticket, text: CH1, tickets });
  if (!confirmed.ok) throw new Error(confirmed.reason);
  return { preview, confirmed };
}

describe("定稿编排", () => {
  it("第 1 章：清单分「要你看的」和「自动记下的」，名字不带编号；确认后写正文 + 账单，投影跟着变", async () => {
    const { preview, confirmed } = await commitChapter1();
    expect(preview.review.map((item) => item.label)).toEqual(["出场：周守义（正文叫「老周」）"]);
    expect(preview.review[0]?.reasons[0]?.code).toBe("new-character");
    expect(preview.auto.map((item) => item.kind)).toEqual(["summary", "time", "presence", "fact", "fact", "thread"]);
    expect(preview.time).toMatchObject({ day: 1, basis: "text", weekday: 1, timeOfDay: "傍晚", needsConfirm: false });
    expect(preview.notRecorded).toEqual([]);
    expect(JSON.stringify(preview)).not.toMatch(/c1-|t1-/u);

    expect(confirmed).toMatchObject({ ok: true, version: 1, replayed: false, result: { recorded: 7, rejected: [] } });
    expect(await readFile(join(book, "chapters/0001.md"), "utf-8")).toBe(CH1);
    const view = await projectBook(book);
    expect(view.cast.find((member) => member.name === "周守义")?.aliases).toEqual(["老周"]);
    expect(view.threads[0]).toMatchObject({ title: "钟为什么停", status: "open" });
  });

  it("第 2 章：推进 / 收口用短号接上前文；原句对不上的如实列出；作者去掉一条、改天数；点两次只定稿一次", async () => {
    await commitChapter1();
    const tickets = memoryTicketStore();
    const preview = expectPreview(
      await prepareChapterCommit({
        bookDir: book,
        chapter: 2,
        text: CH2,
        tickets,
        callModel: fakeModel({
          summary: { text: "外乡人又来，沈青禾锁好钥匙", quote: "外乡人又来了" },
          // 记账员把同一天的章多填了「章内过了 1 天」（摘的换天原句正文里确有，代码核得上）：作者改天数后按作者说的那一天记（P6 第 7 步）。
          time: { basis: "text", daysSincePrevious: 1, daysInChapter: 1, dayChangeQuote: "沈青禾把钥匙锁进铜盒", timeOfDay: "上午", quote: "第二天上午" },
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
    expect(preview.time).toMatchObject({ day: 2, dayEnd: 3, basis: "text" });

    const stranger = preview.review.find((item) => item.label === "出场：外乡人");
    const first = await confirmChapterCommit({ bookDir: book, ticket: preview.ticket, text: CH2, tickets, excluded: [String(stranger?.index), -1, "x"], day: "5" });
    expect(first).toMatchObject({ ok: true, version: 2, replayed: false });
    const again = await confirmChapterCommit({ bookDir: book, ticket: preview.ticket, text: CH2, tickets, excluded: [stranger?.index], day: 5 });
    expect(again).toMatchObject({ ok: true, version: 2, replayed: true });

    const view = await projectBook(book);
    expect(view.chapters[1]).toMatchObject({ day: 5, dayEnd: 5, dayBasis: "author", timeOfDay: "上午" });
    expect(view.chapters[1]?.present).toEqual(["周守义"]);
    expect(view.threads[0]).toMatchObject({ status: "closed", closedAt: 2 });
    const ledger = JSON.parse(await readFile(join(book, "ledger/chapters/0002.json"), "utf-8"));
    expect(ledger.entries.find((entry: { kind: string; op?: string }) => entry.kind === "thread")?.review).toBe("author");
  });

  // 长篇实跑：第 24 章记账员记成第 20～21 天，其实是第 21～22 天；作者只能改成一天，章里第二天那段丢了。
  it("作者改天数也能记跨天：第 5 天到第 6 天", async () => {
    await commitChapter1();
    const tickets = memoryTicketStore();
    const preview = expectPreview(
      await prepareChapterCommit({
        bookDir: book,
        chapter: 2,
        text: CH2,
        tickets,
        callModel: fakeModel({
          summary: { text: "外乡人又来，沈青禾锁好钥匙", quote: "外乡人又来了" },
          time: { basis: "text", daysSincePrevious: 1, daysInChapter: 1, dayChangeQuote: "沈青禾把钥匙锁进铜盒", timeOfDay: "上午", quote: "第二天上午" },
          presence: [{ name: "周守义", nameUsed: "老周", quote: "老周站在门口" }],
          facts: [],
          threads: [],
        }),
      }),
    );
    expect(preview.time).toMatchObject({ day: 2, dayEnd: 3 });
    expect(await confirmChapterCommit({ bookDir: book, ticket: preview.ticket, text: CH2, tickets, day: 5, dayEnd: 6 })).toMatchObject({ ok: true });
    expect((await projectBook(book)).chapters[1]).toMatchObject({ day: 5, dayEnd: 6, dayBasis: "author" });
  });

  it("改了前面一章再定稿：记账员看得到这章上次开的线索，本章还在开就沿用编号，后文的推进接得上", async () => {
    await commitChapter1();
    const tickets = memoryTicketStore();
    const ch2 = expectPreview(await prepareChapterCommit({
      bookDir: book, chapter: 2, text: CH2, tickets,
      callModel: fakeModel({ threads: [{ op: "advance", thread: "T1", note: "知道是人为拨停", quote: "钟是被人故意拨停的" }] }),
    }));
    expect(await confirmChapterCommit({ bookDir: book, ticket: ch2.ticket, text: CH2, tickets })).toMatchObject({ ok: true });

    const edited = CH1.replace("老周没有拦她", "老周侧身让开了");
    const asked: string[] = [];
    const keeper: BrainCallModel = async (messages) => {
      const last = messages.at(-1)?.content ?? "";
      if (!last.includes("交这一章的账单")) return "笔记：老周＝周守义。";
      asked.push(last);
      // 换了个说法（标题对不上上次的），但填了上次的编号。
      return JSON.stringify({ threads: [{ op: "open", type: "question", title: "钟停在三点十五的缘故", thread: "r1", note: "钟停了", quote: "钟为什么偏偏停在这个时刻" }] });
    };
    const again = expectPreview(await prepareChapterCommit({ bookDir: book, chapter: 1, text: edited, callModel: keeper, tickets }));
    expect(asked[0]).toContain("R1 [悬念] 钟为什么停（上次记的：钟停在三点十五分）");
    const confirmed = await confirmChapterCommit({ bookDir: book, ticket: again.ticket, text: edited, tickets });
    expect(confirmed).toMatchObject({ ok: true, result: { recommitted: true, orphanedThreads: [] } });
    const view = await projectBook(book);
    expect(view.threads).toHaveLength(1);
    expect(view.threads[0]).toMatchObject({ title: "钟停在三点十五的缘故", openedAt: 1, lastTouchedAt: 2 });
  });

  it("重定稿：上次定稿认过的出场人物（含泛称）不再当第一次出场问；这次新冒出来的照问", async () => {
    const tickets = memoryTicketStore();
    const first = expectPreview(await prepareChapterCommit({ bookDir: book, chapter: 1, text: CH1, callModel: fakeModel(LEDGER1), tickets }));
    expect(first.review.map((item) => item.label)).toEqual(expect.arrayContaining(["出场：沈青禾，视角人物", "出场：周守义（正文叫「老周」）"]));
    expect(await confirmChapterCommit({ bookDir: book, ticket: first.ticket, text: CH1, tickets })).toMatchObject({ ok: true });

    const edited = CH1.replace("老周没有拦她", "老周没有拦她，门边站着个老头");
    const ledger = { ...LEDGER1, presence: [...LEDGER1.presence, { name: "老头", nameUsed: "老头", generic: true, quote: "门边站着个老头" }] };
    const again = expectPreview(await prepareChapterCommit({ bookDir: book, chapter: 1, text: edited, callModel: fakeModel(ledger), tickets }));
    const askedNames = (preview: CommitPreview) => preview.review.filter((item) => item.reasons.some((reason) => reason.code === "new-character")).map((item) => item.label);
    expect(askedNames(again)).toEqual(["出场：老头"]);
    expect(await confirmChapterCommit({ bookDir: book, ticket: again.ticket, text: edited, tickets })).toMatchObject({ ok: true });
    const third = expectPreview(await prepareChapterCommit({ bookDir: book, chapter: 1, text: `${edited}\n\n钟又走了。`, callModel: fakeModel(ledger), tickets }));
    expect(askedNames(third)).toEqual([]);
  });

  it("正文预览后又改过、票过期了、跳章、老书没导入、记账员没交上：都不定稿，如实说", async () => {
    const tickets = memoryTicketStore();
    const preview = expectPreview(await prepareChapterCommit({ bookDir: book, chapter: 1, text: CH1, callModel: fakeModel(LEDGER1), tickets }));
    expect(await confirmChapterCommit({ bookDir: book, ticket: preview.ticket, text: `${CH1}\n加了一句。`, tickets })).toMatchObject({ ok: false, code: "text_changed" });
    expect(await confirmChapterCommit({ bookDir: book, ticket: "0123456789abcdef", text: CH1, tickets })).toMatchObject({ ok: false, code: "ticket_missing" });
    expect(await readHead(book)).toMatchObject({ version: 0 });

    expect(await prepareChapterCommit({ bookDir: book, chapter: 3, text: CH2, callModel: fakeModel(LEDGER1), tickets })).toMatchObject({ ok: false, code: "chapter_gap" });
    expect(await prepareChapterCommit({ bookDir: book, chapter: 1, text: "  ", callModel: fakeModel(LEDGER1), tickets })).toMatchObject({ ok: false, code: "empty_text" });
    expect(await prepareChapterCommit({ bookDir: book, chapter: 1, text: CH1, callModel: async () => "记不了", tickets })).toMatchObject({ ok: false, code: "keeper_failed" });

    const old = await makeHomeTempDir("commit-flow-old-");
    try {
      await mkdir(join(old, "chapters"), { recursive: true });
      await writeFile(join(old, "chapters/0001.md"), CH1);
      expect(await prepareChapterCommit({ bookDir: old, chapter: 2, text: CH2, callModel: fakeModel(LEDGER1), tickets })).toMatchObject({ ok: false, code: "not_imported" });
    } finally {
      await rm(old, { recursive: true, force: true });
    }
  });

  it("稿纸重新载入只收掉了多余空行（字没动）：照样能确认，定稿的是现在这份", async () => {
    const tickets = memoryTicketStore();
    const loose = CH1.replace(/\n\n/gu, "\n\n\n\n").concat("  \n");
    const preview = expectPreview(await prepareChapterCommit({ bookDir: book, chapter: 1, text: loose, callModel: fakeModel(LEDGER1), tickets }));
    expect(await confirmChapterCommit({ bookDir: book, ticket: preview.ticket, text: CH1, tickets })).toMatchObject({ ok: true, version: 1 });
    expect(await readFile(join(book, "chapters/0001.md"), "utf-8")).toBe(CH1);
  });

  it("预览票存目录：进程重启（换一个 store 实例）也能确认；乱写的票号不读盘", async () => {
    const dir = join(book, ".cache", "tickets");
    const preview = expectPreview(await prepareChapterCommit({ bookDir: book, chapter: 1, text: CH1, callModel: fakeModel(LEDGER1), tickets: fileTicketStore(dir) }));
    const restarted = fileTicketStore(dir);
    expect(await restarted.get("../../etc/passwd")).toBeUndefined();
    expect(await confirmChapterCommit({ bookDir: book, ticket: preview.ticket, text: CH1, tickets: restarted })).toMatchObject({ ok: true, version: 1 });
  });
});
