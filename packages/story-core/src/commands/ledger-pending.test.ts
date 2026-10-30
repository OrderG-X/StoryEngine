/**
 * 先定正文、账待记 + 补账 + 重记编号沿用（写作版本 P2b 片 3）。
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { paceReport, projectBook, threadsForPrompt, timelineTable, timelineText } from "../index.js";
import type { EntryInput } from "../schema/ledger.js";
import { readChapterLedger, readChapterLedgerFile } from "../store/book.js";
import { chapterCommit } from "./chapter-commit.js";
import { ledgerComplete } from "./ledger-complete.js";
import { runCommand } from "./runner.js";
import type { CommandOutcome, CommandSuccess } from "./types.js";

let book: string;
beforeEach(async () => {
  book = await mkdtemp(join(tmpdir(), "story-core-pending-"));
});
afterEach(async () => {
  await rm(book, { recursive: true, force: true });
});

const CH1 = "# 第1章 · 钟停\n\n钟停在三点十五分。沈青禾推开钟楼的门，老周没有拦她。\n\n她在钟箱里摸到一把铜钥匙，揣进了包里。";
const CH2 = "# 第2章 · 外乡人\n\n第二天上午，外乡人又来了。老周站在门口，没让他进。\n\n沈青禾想起钟停那天，爷爷也这样站着。";
const CH3 = "# 第3章 · 渡口\n\n又过了两天，渡口结了冰。沈青禾把铜钥匙交给老周。";

const CH1_ENTRIES: EntryInput[] = [
  { kind: "time", review: "auto", basis: "author", day: 1 },
  { kind: "presence", review: "auto", name: "沈青禾", nameUsed: "沈青禾", viewpoint: true, quote: "沈青禾推开钟楼的门" },
  { kind: "fact", review: "auto", nature: "state", subject: "钟箱钥匙", attribute: "在哪", value: "沈青禾包里", text: "钟箱钥匙在沈青禾包里", quote: "揣进了包里" },
  { kind: "thread", review: "auto", op: "open", type: "question", title: "钟为什么停", note: "钟停在三点十五分", quote: "钟停在三点十五分" },
];
const CH2_ENTRIES: EntryInput[] = [
  { kind: "time", review: "auto", basis: "text", quote: "第二天上午", daysSincePrevious: 1 },
  { kind: "presence", review: "auto", name: "周守义", nameUsed: "老周", quote: "老周站在门口" },
  { kind: "thread", review: "auto", op: "advance", thread: "t2-1", note: "想起钟停那天", quote: "沈青禾想起钟停那天" },
];
const PENDING = { status: "pending" as const, reasonCodes: ["keeper_failed"] };

const author = (key: string) => ({ caller: "author" as const, idempotencyKey: key });

function expectOk<R>(outcome: CommandOutcome<R>): CommandSuccess<R> {
  if (!outcome.ok) throw new Error(`命令失败：${outcome.code} ${outcome.message}`);
  return outcome;
}

describe("先定正文、账待记", () => {
  it("正文照写、账单是空的待记；带着条目的待记账单不收", async () => {
    const outcome = expectOk(await runCommand(book, chapterCommit, { chapter: 1, text: CH1, entries: [], ledger: PENDING }, author("k1")));
    expect(outcome.result).toMatchObject({ chapter: 1, recorded: 0, textCommitted: true, ledgerStatus: "pending" });
    expect(await readFile(join(book, "chapters/0001.md"), "utf-8")).toBe(CH1);
    const ledger = await readChapterLedger(book, 1);
    expect(ledger).toMatchObject({ status: "pending", entries: [] });
    expect(ledger?.coverage.reasonCodes).toEqual(["keeper_failed"]);

    const bad = await runCommand(book, chapterCommit, { chapter: 2, text: CH2, entries: CH2_ENTRIES, ledger: PENDING }, author("k2"));
    expect(bad).toMatchObject({ ok: false, code: "bad_args" });
  });

  it("投影：待记那章和接着它算的章是哪天不知道，到作者定的天数为止；时间表照实写「不知道」", async () => {
    expectOk(await runCommand(book, chapterCommit, { chapter: 1, text: CH1, entries: [], ledger: PENDING }, author("k1")));
    expectOk(await runCommand(book, chapterCommit, { chapter: 2, text: CH2, entries: [{ kind: "time", review: "auto", basis: "text", quote: "第二天上午", daysSincePrevious: 1 }] }, author("k2")));
    expectOk(await runCommand(book, chapterCommit, { chapter: 3, text: CH3, entries: [{ kind: "time", review: "auto", basis: "author", day: 5 }] }, author("k3")));
    const view = await projectBook(book);
    const [one, two, three] = view.chapters;
    expect(one).toMatchObject({ ledgerStatus: "pending", dayBasis: "unknown" });
    expect(one?.day).toBeUndefined();
    expect(two).toMatchObject({ ledgerStatus: "ready", dayBasis: "unknown" });
    expect(two?.day).toBeUndefined();
    expect(three).toMatchObject({ day: 5, dayEnd: 5, dayBasis: "author" });

    const rows = timelineTable(view);
    expect(rows[0]).toMatchObject({ chapter: 1, basis: "unknown", ledgerPending: true });
    const text = timelineText(rows);
    expect(text).toContain("| 第 1 章 | 不知道 | — | — | 这章的账还没记上 |");
    expect(text).toContain("| 第 2 章 | 不知道 | — | — | 不知道（前面有章的账还没记上） |");
  });

  it("线索多久没动不算账待记的章；节奏不拿待记的章算密度", async () => {
    expectOk(await runCommand(book, chapterCommit, { chapter: 1, text: CH1, entries: CH1_ENTRIES }, author("k1")));
    expectOk(await runCommand(book, chapterCommit, { chapter: 2, text: CH2, entries: [], ledger: PENDING }, author("k2")));
    expectOk(await runCommand(book, chapterCommit, { chapter: 3, text: CH3, entries: [] }, author("k3")));
    const view = await projectBook(book);
    // 第 1 章开的线索：之后第 2 章待记、第 3 章没动 → 只算没动 1 章。
    expect(view.threads[0]).toMatchObject({ title: "钟为什么停", idleChapters: 1 });
    expect(threadsForPrompt(view).threads[0]).toMatchObject({ title: "钟为什么停" });
    const pace = paceReport(view, new Map([[1, 3000], [2, 3000], [3, 3000]]));
    expect(pace.chapters[1]).toMatchObject({ chapter: 2, pending: true });
    expect(pace.chapters[1]?.density).toBeUndefined();
  });
});

describe("重记一章时编号沿用（carry）", () => {
  it("中间账待记再补上：同一条声明拿回原来的编号、线索号；后文接得上", async () => {
    expectOk(await runCommand(book, chapterCommit, { chapter: 1, text: CH1, entries: CH1_ENTRIES }, author("k1")));
    const first = await readChapterLedger(book, 1);
    const ids = first!.entries.map((entry) => entry.id);
    expectOk(await runCommand(book, chapterCommit, {
      chapter: 2,
      text: CH2,
      entries: [{ kind: "thread", review: "auto", op: "advance", thread: "t1-1", note: "想起钟停那天", quote: "沈青禾想起钟停那天" }],
    }, author("k2")));

    // 第 1 章重定稿时记账没成，先定正文：carry 带着上一份的全部条目。
    expectOk(await runCommand(book, chapterCommit, { chapter: 1, text: `${CH1}\n`, entries: [], ledger: PENDING }, author("k3")));
    const pending = await readChapterLedgerFile(book, 1);
    expect(pending?.ledger.previous?.carry.entries.map((entry) => entry.id)).toEqual(ids);
    expect((await projectBook(book)).dangling).toEqual([{ kind: "thread", ref: "t1-1", chapter: 2, source: "c2-1" }]);

    // 补账：同样的声明 → 原来的编号、线索号。
    const filled = expectOk(await runCommand(book, ledgerComplete, { chapter: 1, ledgerSha256: pending!.sha256, entries: CH1_ENTRIES }, author("k4")));
    expect(filled.result).toMatchObject({ chapter: 1, ledgerStatus: "ready", recorded: 4, orphanedThreads: [] });
    const after = await readChapterLedger(book, 1);
    expect(after!.entries.map((entry) => entry.id)).toEqual(ids);
    expect(after!.entries.find((entry) => entry.kind === "thread")).toMatchObject({ threadRef: { id: "t1-1" } });
    expect((await projectBook(book)).dangling).toEqual([]);
  });

  it("旧号不落到别的条目头上：重记少了几条，再记一条新的，新号排在认得的最大号后面", async () => {
    expectOk(await runCommand(book, chapterCommit, { chapter: 1, text: CH1, entries: CH1_ENTRIES }, author("k1")));
    expectOk(await runCommand(book, chapterCommit, { chapter: 1, text: CH1, entries: CH1_ENTRIES.slice(0, 2) }, author("k2")));
    expect((await readChapterLedger(book, 1))!.entries.map((entry) => entry.id)).toEqual(["c1-1", "c1-2"]);
    const other: EntryInput = { kind: "fact", review: "auto", nature: "event", subject: "沈青禾", text: "沈青禾推开钟楼的门", quote: "沈青禾推开钟楼的门" };
    expectOk(await runCommand(book, chapterCommit, { chapter: 1, text: CH1, entries: [...CH1_ENTRIES.slice(0, 2), other] }, author("k3")));
    // c1-3、c1-4 是之前那两条（钥匙在哪、钟为什么停）的号，新条目不拿。
    expect((await readChapterLedger(book, 1))!.entries.map((entry) => entry.id)).toEqual(["c1-1", "c1-2", "c1-5"]);
  });
});

describe("补账命令", () => {
  it("只补定稿时账没记上 / 没记全、正文没改过的；账单变过、导入的、AI 交的都不写", async () => {
    expect(await runCommand(book, ledgerComplete, { chapter: 1, ledgerSha256: "0".repeat(64), entries: [] }, author("k0"))).toMatchObject({ ok: false, code: "not_committed" });

    expectOk(await runCommand(book, chapterCommit, { chapter: 1, text: CH1, entries: CH1_ENTRIES }, author("k1")));
    const ready = await readChapterLedgerFile(book, 1);
    expect(await runCommand(book, ledgerComplete, { chapter: 1, ledgerSha256: ready!.sha256, entries: CH1_ENTRIES }, author("k2"))).toMatchObject({ ok: false, code: "nothing_to_fill" });

    expectOk(await runCommand(book, chapterCommit, { chapter: 2, text: CH2, entries: [], ledger: PENDING }, author("k3")));
    const pending = await readChapterLedgerFile(book, 2);
    expect(await runCommand(book, ledgerComplete, { chapter: 2, ledgerSha256: "f".repeat(64), entries: [] }, author("k4"))).toMatchObject({ ok: false, code: "ledger_changed" });
    expect(await runCommand(book, ledgerComplete, { chapter: 2, ledgerSha256: pending!.sha256, entries: [] }, { caller: "ai" as const, idempotencyKey: "k5" })).toMatchObject({ ok: false });

    await writeFile(join(book, "chapters/0002.md"), `${CH2}\n改过一句。`, "utf-8");
    expect(await runCommand(book, ledgerComplete, { chapter: 2, ledgerSha256: pending!.sha256, entries: [] }, author("k6"))).toMatchObject({ ok: false, code: "text_changed" });
  });

  it("补上了：正文、定稿时间不动；补摘原句没成的记成没记全，还能再补", async () => {
    expectOk(await runCommand(book, chapterCommit, { chapter: 1, text: CH1, entries: [], ledger: PENDING }, author("k1")));
    const pending = await readChapterLedgerFile(book, 1);
    const partial = expectOk(await runCommand(book, ledgerComplete, {
      chapter: 1,
      ledgerSha256: pending!.sha256,
      entries: CH1_ENTRIES.slice(0, 2),
      partial: { reasonCodes: ["quote_repair_failed"] },
    }, author("k2")));
    expect(partial.result).toMatchObject({ ledgerStatus: "partial", recorded: 2 });
    const half = await readChapterLedgerFile(book, 1);
    expect(half?.ledger).toMatchObject({ status: "partial", committedAt: pending!.ledger.committedAt, textSha256: pending!.ledger.textSha256 });
    expect(await readFile(join(book, "chapters/0001.md"), "utf-8")).toBe(CH1);

    const full = expectOk(await runCommand(book, ledgerComplete, { chapter: 1, ledgerSha256: half!.sha256, entries: CH1_ENTRIES }, author("k3")));
    expect(full.result).toMatchObject({ ledgerStatus: "ready", recorded: 4 });
    expect((await readChapterLedger(book, 1))!.entries.slice(0, 2).map((entry) => entry.id)).toEqual(half!.ledger.entries.map((entry) => entry.id));
    expect((await projectBook(book)).chapters[0]).toMatchObject({ ledgerStatus: "ready", day: 1 });
  });
});
