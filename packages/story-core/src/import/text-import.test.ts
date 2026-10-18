import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectBook } from "../index.js";
import { chapterCommit } from "../commands/chapter-commit.js";
import { ledgerReread } from "../commands/ledger-reread.js";
import { runCommand } from "../commands/runner.js";
import type { CommandOutcome, CommandSuccess } from "../commands/types.js";
import type { EntryInput } from "../schema/ledger.js";
import { readChapterLedger, readHead } from "../store/book.js";
import { bookImportText } from "./text-import.js";

let book: string;
beforeEach(async () => {
  book = await mkdtemp(join(tmpdir(), "story-core-text-import-"));
});
afterEach(async () => {
  await rm(book, { recursive: true, force: true });
});

const NOW = new Date("2026-10-19T08:00:00.000Z");
const author = (key: string) => ({ caller: "author" as const, idempotencyKey: key, now: () => NOW });

function ok<R>(outcome: CommandOutcome<R>): CommandSuccess<R> {
  if (!outcome.ok) throw new Error(`${outcome.code} ${outcome.message}`);
  return outcome;
}

const CHAPTERS = [
  { title: "钟停", body: "钟停在三点十五分。沈青禾推开钟楼的门，老周没有拦她。\n\n她在钟箱里摸到一把铜钥匙，揣进了包里。" },
  { title: "", body: "第二天上午，外乡人又来了。老周站在门口，没让他进。" },
];

const CH1_ENTRIES: EntryInput[] = [
  { kind: "summary", review: "auto", text: "沈青禾进钟楼，拿走钟箱钥匙", quote: "她在钟箱里摸到一把铜钥匙" },
  { kind: "presence", review: "auto", name: "沈青禾", nameUsed: "沈青禾", quote: "沈青禾推开钟楼的门" },
  { kind: "thread", review: "auto", op: "open", type: "question", title: "钟为什么停", note: "钟停在三点十五分", quote: "钟停在三点十五分" },
];

describe("导入已写的书", () => {
  it("每章写正文和一份空账单：马上是「都定稿了、账还没记」", async () => {
    const outcome = ok(await runCommand(book, bookImportText, { chapters: CHAPTERS }, author("import")));
    expect(outcome.result).toEqual({ chapters: 2 });
    expect(outcome.changed).toEqual({ chapters: [1, 2], ledgers: [1, 2] });
    expect(await readFile(join(book, "chapters/0001.md"), "utf-8")).toBe(`# 第1章 · 钟停\n\n${CHAPTERS[0]!.body}\n`);
    expect(await readFile(join(book, "chapters/0002.md"), "utf-8")).toBe(`# 第2章\n\n${CHAPTERS[1]!.body}\n`);
    expect(await readChapterLedger(book, 2)).toMatchObject({ origin: "import", entries: [] });
    const view = await projectBook(book);
    expect(view.chapters.map((chapter) => [chapter.chapter, chapter.origin, chapter.editedSinceCommit])).toEqual([[1, "import", false], [2, "import", false]]);
  });

  it("书里已经有章节就拒绝，不覆盖；没有正文的章不收", async () => {
    ok(await runCommand(book, bookImportText, { chapters: CHAPTERS }, author("import")));
    expect(await runCommand(book, bookImportText, { chapters: CHAPTERS }, author("import-again"))).toMatchObject({ ok: false, code: "book_not_empty" });
    const empty = await mkdtemp(join(tmpdir(), "story-core-text-import-"));
    try {
      expect(await runCommand(empty, bookImportText, { chapters: [{ title: "空", body: "  " }] }, author("x"))).toMatchObject({ ok: false, code: "invalid_args" });
      expect(await runCommand(empty, bookImportText, { chapters: [] }, author("y"))).toMatchObject({ ok: false, code: "invalid_args" });
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it("AI 调不了", async () => {
    expect(await runCommand(book, bookImportText, { chapters: CHAPTERS }, { caller: "ai", idempotencyKey: "z" })).toMatchObject({ ok: false, code: "author_only" });
  });
});

describe("通读记账", () => {
  beforeEach(async () => {
    ok(await runCommand(book, bookImportText, { chapters: CHAPTERS }, author("import")));
  });

  it("给已定稿的章换上账单（origin = reread），正文不动；原句对不上的不记", async () => {
    const before = await readFile(join(book, "chapters/0001.md"), "utf-8");
    const outcome = ok(await runCommand(book, ledgerReread, {
      chapter: 1,
      entries: [...CH1_ENTRIES, { kind: "fact", review: "auto", nature: "event", text: "老周哭了", quote: "老周哭得说不出话" }],
    }, author("reread:1")));
    expect(outcome.result).toMatchObject({ chapter: 1, recorded: 3 });
    expect(outcome.result.rejected.map((item) => item.reason)).toEqual(["quote_not_in_text"]);
    expect(outcome.changed).toEqual({ ledgers: [1] });
    expect(await readFile(join(book, "chapters/0001.md"), "utf-8")).toBe(before);
    expect(await readChapterLedger(book, 1)).toMatchObject({ origin: "reread" });
    const view = await projectBook(book);
    expect(view.chapters[0]).toMatchObject({ origin: "reread", summary: "沈青禾进钟楼，拿走钟箱钥匙", editedSinceCommit: false });
    expect(view.threads.map((thread) => thread.title)).toEqual(["钟为什么停"]);
  });

  it("不打快照、版本号照常 +1；同一个标记再来只回放", async () => {
    const snapshots: string[] = [];
    const first = ok(await runCommand(book, ledgerReread, { chapter: 1, entries: CH1_ENTRIES }, { ...author("reread:1"), snapshot: async (label) => { snapshots.push(label); } }));
    const again = ok(await runCommand(book, ledgerReread, { chapter: 1, entries: [] }, author("reread:1")));
    expect(snapshots).toEqual([]);
    expect(again.replayed).toBe(true);
    expect((await readHead(book)).version).toBe(first.version);
  });

  it("后一章推进前一章开的线索：编号接得上", async () => {
    ok(await runCommand(book, ledgerReread, { chapter: 1, entries: CH1_ENTRIES }, author("reread:1")));
    const thread = (await readChapterLedger(book, 1))!.entries.find((entry) => entry.kind === "thread");
    const outcome = ok(await runCommand(book, ledgerReread, {
      chapter: 2,
      entries: [{ kind: "thread", review: "auto", op: "advance", thread: thread?.kind === "thread" ? thread.thread : "", note: "外乡人又来", quote: "外乡人又来了" }],
    }, author("reread:2")));
    expect(outcome.result.recorded).toBe(1);
    expect((await projectBook(book)).threads[0]).toMatchObject({ title: "钟为什么停", lastTouchedAt: 2 });
  });

  it("没定稿的章不记；记账员记的条目必须附原句", async () => {
    expect(await runCommand(book, ledgerReread, { chapter: 3, entries: [] }, author("reread:3"))).toMatchObject({ ok: false, code: "not_committed" });
    const missing = await runCommand(book, ledgerReread, { chapter: 1, entries: [{ kind: "summary", review: "auto", text: "梗概" }] }, author("reread:1b"));
    expect(missing).toMatchObject({ ok: false, code: "invalid_args" });
  });

  it("通读记过的章作者再定稿：照重定稿换账单", async () => {
    ok(await runCommand(book, ledgerReread, { chapter: 1, entries: CH1_ENTRIES }, author("reread:1")));
    const text = `# 第1章 · 钟停\n\n${CHAPTERS[0]!.body}\n`;
    const outcome = ok(await runCommand(book, chapterCommit, { chapter: 1, text, entries: CH1_ENTRIES }, author("commit:1")));
    expect(outcome.result.recommitted).toBe(true);
    expect(await readChapterLedger(book, 1)).toMatchObject({ origin: "commit" });
  });
});
