import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectBook } from "../index.js";
import type { EntryInput } from "../schema/ledger.js";
import { readChapterLedger, readHead } from "../store/book.js";
import { draftPath, TX_DIR } from "../store/paths.js";
import { setAsideBrokenTransactions } from "../store/transaction.js";
import { chapterCommit, type ChapterCommitResult } from "./chapter-commit.js";
import { chapterRetitle } from "./chapter-retitle.js";
import { readDraft } from "../draft/draft.js";
import { decisionRecord } from "./decision-record.js";
import { BookEventHub } from "./events.js";
import { runCommand } from "./runner.js";
import type { BookEvent, CommandOutcome, CommandSuccess } from "./types.js";

let book: string;
beforeEach(async () => {
  book = await mkdtemp(join(tmpdir(), "story-core-cmd-"));
});
afterEach(async () => {
  await rm(book, { recursive: true, force: true });
});

const CH1 = "# 第1章 · 钟停\n\n钟停在三点十五分。沈青禾推开钟楼的门，老周没有拦她。\n\n她在钟箱里摸到一把铜钥匙，揣进了包里。";
const CH2 = "# 第2章 · 外乡人\n\n第二天上午，外乡人又来了。老周站在门口，没让他进。\n\n沈青禾想起钟停那天，爷爷也这样站着。";

const CH1_ENTRIES: EntryInput[] = [
  { kind: "summary", review: "auto", text: "沈青禾进钟楼，拿走钟箱钥匙", quote: "她在钟箱里摸到一把铜钥匙" },
  { kind: "presence", review: "auto", name: "沈青禾", nameUsed: "沈青禾", viewpoint: true, quote: "沈青禾推开钟楼的门" },
  { kind: "presence", review: "auto", name: "周守义", nameUsed: "老周", quote: "老周没有拦她" },
  { kind: "fact", review: "auto", nature: "state", subject: "钟箱钥匙", attribute: "在哪", value: "沈青禾包里", text: "钟箱钥匙在沈青禾包里", quote: "揣进了包里" },
  { kind: "fact", review: "auto", nature: "hard", subject: "钟", attribute: "停的时刻", value: "三点十五分", text: "钟停在三点十五分", quote: "钟停在三点十五分" },
  { kind: "thread", review: "auto", op: "open", type: "question", title: "钟为什么停", note: "钟停在三点十五分", quote: "钟停在三点十五分" },
];

const author = (key: string, emit?: (event: BookEvent) => void) => ({ caller: "author" as const, idempotencyKey: key, ...(emit ? { emit } : {}) });

function expectOk<R>(outcome: CommandOutcome<R>): CommandSuccess<R> {
  if (!outcome.ok) throw new Error(`命令失败：${outcome.code} ${outcome.message}`);
  return outcome;
}

describe("定稿命令", () => {
  it("写正文和账单，版本号 +1，推事件，投影跟着变", async () => {
    const hub = new BookEventHub();
    const events: BookEvent[] = [];
    hub.subscribe((event) => events.push(event));
    const outcome = expectOk(await runCommand(book, chapterCommit, { chapter: 1, text: CH1, entries: CH1_ENTRIES }, author("k1", hub.emit)));
    expect(outcome.result).toMatchObject({ chapter: 1, recorded: 6, rejected: [], recommitted: false });
    expect(outcome.version).toBe(1);
    expect(await readFile(join(book, "chapters/0001.md"), "utf-8")).toBe(CH1);
    expect((await readHead(book)).version).toBe(1);
    expect(events).toEqual([expect.objectContaining({ version: 1, command: "chapter.commit", label: "定稿：第 1 章", changed: { chapters: [1], ledgers: [1] } })]);

    const view = await projectBook(book);
    expect(view.version).toBe(1);
    expect(view.chapters[0]).toMatchObject({ chapter: 1, summary: "沈青禾进钟楼，拿走钟箱钥匙", viewpoint: "沈青禾", editedSinceCommit: false });
    expect(view.cast.find((member) => member.name === "周守义")?.aliases).toEqual(["老周"]);
    expect(view.threads[0]).toMatchObject({ title: "钟为什么停", status: "open" });
  });

  it("原句对不上的不记、如实列出来；推进指向前文没有的线索也不记", async () => {
    const outcome = expectOk(await runCommand(book, chapterCommit, {
      chapter: 1,
      text: CH1,
      entries: [
        ...CH1_ENTRIES,
        { kind: "fact", review: "auto", nature: "event", subject: "老周", text: "老周哭了", quote: "老周哭得说不出话" },
        { kind: "thread", review: "auto", op: "advance", thread: "t9-9", note: "推进", quote: "钟停在三点十五分" },
      ],
    }, author("k1")));
    expect(outcome.result.recorded).toBe(6);
    expect(outcome.result.rejected.map((item) => [item.index, item.reason])).toEqual([[6, "quote_not_in_text"], [7, "unknown_thread"]]);
    expect(outcome.result.rejected[0]?.message).toBe("「老周哭了」没记上：附的原句在正文里找不到");
  });

  it("AI 调不了；没带防重复标记不执行；同一个标记再点一次只回放", async () => {
    const asAi = await runCommand(book, chapterCommit, { chapter: 1, text: CH1, entries: [] }, { caller: "ai", idempotencyKey: "x" });
    expect(asAi).toMatchObject({ ok: false, code: "author_only" });
    const noKey = await runCommand(book, chapterCommit, { chapter: 1, text: CH1, entries: [] }, { caller: "author" });
    expect(noKey).toMatchObject({ ok: false, code: "missing_idempotency_key" });

    const emit = vi.fn();
    const first = expectOk(await runCommand(book, chapterCommit, { chapter: 1, text: CH1, entries: CH1_ENTRIES }, author("same", emit)));
    const again = expectOk(await runCommand(book, chapterCommit, { chapter: 1, text: CH1, entries: [] }, author("same", emit)));
    expect(again.replayed).toBe(true);
    expect(again.result).toEqual(first.result);
    expect(emit).toHaveBeenCalledTimes(1);
    expect((await readHead(book)).version).toBe(1);
  });

  it("重定稿：同一条事实、同一条线索的编号沿用，后文接得上；不见了的被引用线索如实列出", async () => {
    expectOk(await runCommand(book, chapterCommit, { chapter: 1, text: CH1, entries: CH1_ENTRIES }, author("k1")));
    const first = await readChapterLedger(book, 1);
    const threadId = first?.entries.find((entry) => entry.kind === "thread")?.id;
    const openedThread = first?.entries.flatMap((entry) => (entry.kind === "thread" ? [entry.thread] : []))[0];
    expect(openedThread).toBe("t1-1");

    expectOk(await runCommand(book, chapterCommit, {
      chapter: 2,
      text: CH2,
      entries: [{ kind: "thread", review: "auto", op: "advance", thread: "t1-1", note: "想起钟停那天", quote: "沈青禾想起钟停那天" }],
    }, author("k2")));

    // 重定稿第 1 章：线索还在（标题一样）→ 编号不变。
    const recommit = expectOk(await runCommand(book, chapterCommit, { chapter: 1, text: `${CH1}\n`, entries: [...CH1_ENTRIES].reverse() }, author("k3")));
    expect(recommit.result).toMatchObject({ recommitted: true, orphanedThreads: [] });
    const second = await readChapterLedger(book, 1);
    expect(second?.entries.find((entry) => entry.kind === "thread")).toMatchObject({ id: threadId, thread: "t1-1" });
    expect((await projectBook(book)).threads[0]).toMatchObject({ id: "t1-1", status: "active", lastTouchedAt: 2 });

    // 再重定稿：这次没开这条线索 → 第 2 章的推进没了来处，如实列出。
    const dropped = expectOk(await runCommand(book, chapterCommit, { chapter: 1, text: CH1, entries: CH1_ENTRIES.slice(0, 5) }, author("k4")));
    expect(dropped.result.orphanedThreads).toEqual(["钟为什么停"]);
    expect((await projectBook(book)).dangling).toEqual([{ kind: "thread", ref: "t1-1", chapter: 2, source: "c2-1" }]);
  });

  it("先存撤销点；撤销点存不了就不写", async () => {
    const snapshot = vi.fn(async () => undefined);
    expectOk(await runCommand(book, chapterCommit, { chapter: 1, text: CH1, entries: [] }, { ...author("k1"), snapshot }));
    expect(snapshot).toHaveBeenCalledWith("定稿：第 1 章", "chapter.commit");

    const broken = await runCommand(book, chapterCommit, { chapter: 2, text: CH2, entries: [] }, {
      ...author("k2"),
      snapshot: async () => {
        throw new Error("git 坏了");
      },
    });
    expect(broken).toMatchObject({ ok: false, code: "snapshot_failed" });
    await expect(readFile(join(book, "chapters/0002.md"), "utf-8")).rejects.toThrow();
    expect((await readHead(book)).version).toBe(1);
  });

  it("上次写断了：开工前退回去并在结果里带出来；清单坏了就不开工，作者挪开后照常写", async () => {
    expectOk(await runCommand(book, chapterCommit, { chapter: 1, text: CH1, entries: CH1_ENTRIES }, author("k1")));
    const stranded = join(book, TX_DIR, "t1");
    await mkdir(join(stranded, "staged"), { recursive: true });
    await writeFile(join(book, "chapters/0001.md"), "写了一半的正文");
    await mkdir(join(stranded, "backup"), { recursive: true });
    await writeFile(join(stranded, "backup", "0"), CH1);
    await writeFile(join(stranded, "manifest.json"), JSON.stringify({ schema: "story-core-tx/1", id: "t1", createdAt: "x", status: "prepared", files: [{ path: "chapters/0001.md", existed: true, slot: "0" }] }));
    const next = expectOk(await runCommand(book, chapterCommit, { chapter: 2, text: CH2, entries: [] }, author("k2")));
    expect(next.recovered?.rolledBack).toEqual(["t1"]);
    expect(await readFile(join(book, "chapters/0001.md"), "utf-8")).toBe(CH1);

    await mkdir(join(book, TX_DIR, "bad"), { recursive: true });
    await writeFile(join(book, TX_DIR, "bad", "manifest.json"), "{坏");
    expect(await runCommand(book, chapterCommit, { chapter: 3, text: CH2, entries: [] }, author("k3"))).toMatchObject({ ok: false, code: "transaction_residue" });
    expect((await setAsideBrokenTransactions(book)).moved).toEqual(["bad"]);
    const after = expectOk(await runCommand(book, chapterCommit, { chapter: 3, text: CH2, entries: [] }, author("k3")));
    expect(after.recovered).toBeUndefined();
  });

  it("参数不对如实报，不写", async () => {
    const outcome = await runCommand(book, chapterCommit, { chapter: 0, text: "", entries: "[]" }, author("k1"));
    expect(outcome).toMatchObject({ ok: false, code: "invalid_args" });
    expect((await readHead(book)).version).toBe(0);
  });
});

describe("改已定稿的章名", () => {
  it("只换第一行章名：正文、账单条目不动，正文指纹跟着换（不算定稿后改过）；工作稿的章名一起换；能撤销、AI 调不了", async () => {
    expectOk(await runCommand(book, chapterCommit, { chapter: 1, text: CH1, entries: CH1_ENTRIES }, author("c1")));
    const before = await readChapterLedger(book, 1);
    await mkdir(join(book, "drafts/fast"), { recursive: true });
    await writeFile(join(book, draftPath(1)), CH1);

    expect(await runCommand(book, chapterRetitle, { chapter: 1, title: "回乡" }, { caller: "ai", idempotencyKey: "x" })).toMatchObject({ ok: false, code: "author_only" });
    const snapshot = vi.fn(async () => "snap-1");
    const done = expectOk(await runCommand(book, chapterRetitle, { chapter: 1, title: "  回乡 " }, { ...author("r1"), snapshot }));
    expect(done.result).toEqual({ chapter: 1, title: "回乡", unchanged: false });
    expect(snapshot).toHaveBeenCalledTimes(1);
    const text = await readFile(join(book, "chapters/0001.md"), "utf-8");
    expect(text.split("\n")[0]).toBe("# 回乡");
    expect(text).toContain("她在钟箱里摸到一把铜钥匙，揣进了包里。");
    const after = await readChapterLedger(book, 1);
    expect(after?.entries).toEqual(before?.entries);
    expect(after?.textSha256).not.toBe(before?.textSha256);
    expect((await projectBook(book)).chapters[0]).toMatchObject({ editedSinceCommit: false });
    expect((await readDraft(book, 1))?.title).toBe("回乡");

    const again = expectOk(await runCommand(book, chapterRetitle, { chapter: 1, title: "回乡" }, author("r2")));
    expect(again.result.unchanged).toBe(true);
  });

  it("没定稿的章、空章名：如实不改", async () => {
    expect(await runCommand(book, chapterRetitle, { chapter: 3, title: "回乡" }, author("r3"))).toMatchObject({ ok: false, code: "not_committed" });
    expectOk(await runCommand(book, chapterCommit, { chapter: 1, text: CH1, entries: [] }, author("c1")));
    expect(await runCommand(book, chapterRetitle, { chapter: 1, title: "  " }, author("r4"))).toMatchObject({ ok: false, code: "empty_title" });
  });
});

describe("作者裁定命令", () => {
  it("归并线索后投影只剩一条；指向不存在的线索就不记", async () => {
    expectOk(await runCommand(book, chapterCommit, {
      chapter: 1,
      text: CH1,
      entries: [
        CH1_ENTRIES[5] as EntryInput,
        { kind: "thread", review: "auto", op: "open", type: "intent", title: "老周不让人进钟楼", note: "老周没有拦她", quote: "老周没有拦她" },
      ],
    }, author("k1")));
    const merged = expectOk(await runCommand(book, decisionRecord, { type: "thread.merge", from: ["t1-2"], into: "t1-1" }, author("d1")));
    expect(merged.result).toEqual({ decision: "d-1" });
    expect(merged.changed).toEqual({ decisions: true });
    const view = await projectBook(book);
    expect(view.threads.map((thread) => [thread.id, thread.mergedFrom])).toEqual([["t1-1", ["t1-2"]]]);

    const missing = await runCommand(book, decisionRecord, { type: "thread.close", thread: "t1-2", chapter: 1 }, author("d2"));
    expect(missing).toMatchObject({ ok: false, code: "unknown_thread" });
  });

  it("补记事实：章要定稿过、改写的那条要还在、不会变的要写清谁哪方面是什么", async () => {
    expectOk(await runCommand(book, chapterCommit, { chapter: 1, text: CH1, entries: CH1_ENTRIES }, author("k1")));
    const added = expectOk(await runCommand(book, decisionRecord, { type: "fact.assert", chapter: 1, nature: "event", text: "钟楼失过一次火" }, author("d1")));
    expect(added.result).toEqual({ decision: "d-1" });
    expect((await projectBook(book)).facts.find((fact) => fact.id === "d-1")).toMatchObject({ chapter: 1, text: "钟楼失过一次火", review: "author", status: "current" });

    expect(await runCommand(book, decisionRecord, { type: "fact.assert", chapter: 2, nature: "event", text: "x" }, author("d2"))).toMatchObject({ ok: false, code: "unknown_chapter" });
    expect(await runCommand(book, decisionRecord, { type: "fact.assert", chapter: 1, nature: "event", text: "x", corrects: "nope" }, author("d3"))).toMatchObject({ ok: false, code: "unknown_fact" });
    expect(await runCommand(book, decisionRecord, { type: "fact.assert", chapter: 1, nature: "hard", text: "老周很老" }, author("d4"))).toMatchObject({ ok: false, code: "invalid_args" });
  });

  it("AI 调不了", async () => {
    const outcome = await runCommand(book, decisionRecord, { type: "issue.dismiss", issue: "x" }, { caller: "ai", idempotencyKey: "d" });
    expect(outcome).toMatchObject({ ok: false, code: "author_only" });
  });
});

describe("并发", () => {
  it("同一本书的写命令排队：两次定稿不同章，版本号 1、2，都写上", async () => {
    const results = await Promise.all([
      runCommand(book, chapterCommit, { chapter: 1, text: CH1, entries: CH1_ENTRIES }, author("a")),
      runCommand(book, chapterCommit, { chapter: 2, text: CH2, entries: [] }, author("b")),
    ]);
    expect(results.map((result) => (result.ok ? result.version : -1)).sort()).toEqual([1, 2]);
    const view = await projectBook(book);
    expect(view.chapters.map((chapter) => chapter.chapter)).toEqual([1, 2]);
    expect((results[0] as CommandSuccess<ChapterCommitResult>).result.recorded).toBe(6);
  });
});
