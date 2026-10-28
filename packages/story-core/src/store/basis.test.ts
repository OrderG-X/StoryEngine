import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chapterCommit } from "../commands/chapter-commit.js";
import { decisionRecord } from "../commands/decision-record.js";
import { runCommand } from "../commands/runner.js";
import type { CommandOutcome, CommandSuccess } from "../commands/types.js";
import { canonicalJson, diffTruthBasis } from "./basis.js";
import { readBookSnapshot, readTruthBasis } from "./book.js";

let book: string;
beforeEach(async () => {
  book = await mkdtemp(join(tmpdir(), "story-core-basis-"));
});
afterEach(async () => {
  await rm(book, { recursive: true, force: true });
});

const CH1 = "# 第1章 · 钟停\n\n钟停在三点十五分。沈青禾推开钟楼的门。";
const CH2 = "# 第2章 · 外乡人\n\n第二天上午，外乡人又来了。";
const author = (key: string) => ({ caller: "author" as const, idempotencyKey: key });

function expectOk<R>(outcome: CommandOutcome<R>): CommandSuccess<R> {
  if (!outcome.ok) throw new Error(`命令失败：${outcome.code} ${outcome.message}`);
  return outcome;
}

describe("真相依据", () => {
  it("键排好序的 JSON：同样的值永远同样的字符串，undefined 的键不进", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: undefined, c: "x" }] })).toBe('{"a":[2,{"c":"x"}],"b":1}');
    expect(canonicalJson(undefined)).toBe("null");
  });

  it("读书快照带的依据和单读的一样；没变就一样，正文 / 账 / 裁定 / 设定哪样变了都说得出", async () => {
    expectOk(await runCommand(book, chapterCommit, { chapter: 1, text: CH1, entries: [] }, author("c1")));
    const before = await readTruthBasis(book);
    expect((await readBookSnapshot(book)).basis).toEqual(before);
    expect(diffTruthBasis(before, await readTruthBasis(book))).toEqual([]);

    expectOk(await runCommand(book, chapterCommit, { chapter: 2, text: CH2, entries: [] }, author("c2")));
    await writeFile(join(book, "chapters", "0001.md"), `${CH1}\n多一句。`, "utf-8");
    await writeFile(join(book, "ledger", "cards.json"), "{}", "utf-8");
    const after = await readTruthBasis(book);
    expect(after.digest).not.toBe(before.digest);
    expect(diffTruthBasis(before, after)).toEqual(expect.arrayContaining([
      { kind: "text", chapter: 1, change: "changed" },
      { kind: "text", chapter: 2, change: "added" },
      { kind: "ledger", chapter: 2, change: "added" },
      { kind: "cards", change: "added" },
    ]));
  });

  it("带依据的写：书变了就不写、说清变了哪些；没变照写；同一个标记先回放（自己改了书不算变）", async () => {
    expectOk(await runCommand(book, chapterCommit, { chapter: 1, text: CH1, entries: [] }, author("c1")));
    const basis = await readTruthBasis(book);
    expectOk(await runCommand(book, chapterCommit, { chapter: 2, text: CH2, entries: [] }, author("c2")));

    const stale = await runCommand(book, decisionRecord, { type: "chapter.summary", chapter: 1, text: "钟停了" }, { ...author("d1"), basis });
    expect(stale).toMatchObject({ ok: false, code: "basis_changed", details: { changes: expect.arrayContaining([{ kind: "text", chapter: 2, change: "added" }]) } });

    const fresh = await readTruthBasis(book);
    expectOk(await runCommand(book, decisionRecord, { type: "chapter.summary", chapter: 1, text: "钟停了" }, { ...author("d2"), basis: fresh }));
    const replay = expectOk(await runCommand(book, decisionRecord, { type: "chapter.summary", chapter: 1, text: "钟停了" }, { ...author("d2"), basis: fresh }));
    expect(replay.replayed).toBe(true);
  });
});
