import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chapterCommit } from "../commands/chapter-commit.js";
import { decisionRecord } from "../commands/decision-record.js";
import { runCommand } from "../commands/runner.js";
import type { CommandOutcome, CommandSuccess } from "../commands/types.js";
import { cardWrite } from "../bible/commands.js";
import { readCards } from "./book.js";
import { canonicalJson, diffTruthBasis } from "./basis.js";
import { readBookSnapshot, readTruthBasis, readWithStableBasis } from "./book.js";
import { bumpRevision } from "./revision.js";

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

    const stale = await runCommand(book, decisionRecord, { decisions: [{ type: "chapter.summary", chapter: 1, text: "钟停了" }] }, { ...author("d1"), basis });
    expect(stale).toMatchObject({ ok: false, code: "basis_changed", details: { changes: expect.arrayContaining([{ kind: "text", chapter: 2, change: "added" }]) } });

    const fresh = await readTruthBasis(book);
    expectOk(await runCommand(book, decisionRecord, { decisions: [{ type: "chapter.summary", chapter: 1, text: "钟停了" }] }, { ...author("d2"), basis: fresh }));
    const replay = expectOk(await runCommand(book, decisionRecord, { decisions: [{ type: "chapter.summary", chapter: 1, text: "钟停了" }] }, { ...author("d2"), basis: fresh }));
    expect(replay.replayed).toBe(true);
  });

  it("换过代就作废：内容一个字节没变（撤销回原样），依据也对不上，说得出是「中间写过」", async () => {
    expectOk(await runCommand(book, chapterCommit, { chapter: 1, text: CH1, entries: [] }, author("c1")));
    const basis = await readTruthBasis(book);
    await bumpRevision(book);
    const now = await readTruthBasis(book);
    expect(now.texts).toEqual(basis.texts);
    expect(diffTruthBasis(basis, now)).toEqual([{ kind: "revision" }]);
    const stale = await runCommand(book, decisionRecord, { decisions: [{ type: "chapter.summary", chapter: 1, text: "钟停了" }] }, { ...author("d1"), basis });
    expect(stale).toMatchObject({ ok: false, code: "basis_changed", details: { changes: [{ kind: "revision" }] } });
  });

  it("稳读：读材料的中途有写（哪怕写回原样）不给依据；没写给读之前那份", async () => {
    expectOk(await runCommand(book, chapterCommit, { chapter: 1, text: CH1, entries: [] }, author("c1")));
    const quiet = await readWithStableBasis(book, async () => "材料");
    expect(quiet).toEqual({ value: "材料", basis: await readTruthBasis(book) });
    const busy = await readWithStableBasis(book, async () => {
      await bumpRevision(book);
      return "材料";
    });
    expect(busy).toEqual({ value: "材料" });
  });

  it("什么都不用改的请求也留回执：迟到重发不会把这之间别人改的盖回去", async () => {
    const set = (value: string) => ({ ops: [{ op: "story.set", label: "地点", value }] });
    expectOk(await runCommand(book, cardWrite, set("北京"), author("w1")));
    const head = (await readTruthBasis(book)).digest;
    const noop = expectOk(await runCommand(book, cardWrite, set("北京"), author("w2")));
    expect(noop.changed).toEqual({});
    expect((await readTruthBasis(book)).digest).toBe(head);
    expectOk(await runCommand(book, cardWrite, set("广州"), author("w3")));
    const late = expectOk(await runCommand(book, cardWrite, set("北京"), author("w2")));
    expect(late.replayed).toBe(true);
    expect((await readCards(book))?.story.fields.find((field) => field.label === "地点")?.value).toBe("广州");
  });
});
