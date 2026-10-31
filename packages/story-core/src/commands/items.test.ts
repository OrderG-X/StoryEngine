/**
 * 东西现在在哪（写作版本 P3b 第 6 节带 ★ 的固定反例）：声明 → 核心整批收 → 定稿落账 → 改账裁定 → 投影，走真命令。
 * 投影本身的规矩在 projection/items.test.ts，撤销依赖在 history/history.test.ts。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { declarationsOf, projectBook } from "../index.js";
import type { EntryInput } from "../schema/ledger.js";
import { readChapterLedger } from "../store/book.js";
import { chapterCommit } from "./chapter-commit.js";
import { decisionRecord } from "./decision-record.js";
import { runCommand } from "./runner.js";
import type { CommandOutcome, CommandSuccess } from "./types.js";

let book: string;
beforeEach(async () => {
  book = await mkdtemp(join(tmpdir(), "story-core-items-"));
});
afterEach(async () => {
  await rm(book, { recursive: true, force: true });
});

const author = (key: string) => ({ caller: "author" as const, idempotencyKey: key });
function expectOk<R>(outcome: CommandOutcome<R>): CommandSuccess<R> {
  if (!outcome.ok) throw new Error(`命令失败：${outcome.code} ${outcome.message}`);
  return outcome;
}
const narration = { kind: "narration" as const };
type Ref = { id: string } | { tag: string };
const appear = (tag: string, name: string, quote: string): EntryInput => ({ kind: "item", review: "auto", op: "appear", tag, name, quote, source: narration });
const step = (op: "at" | "move", seq: number | undefined, item: Ref, to: Record<string, unknown>, quote: string, extra: Record<string, unknown> = {}): EntryInput =>
  ({ kind: "item", review: "auto", op, ...(seq !== undefined ? { seq } : {}), item, to, quote, source: narration, ...extra }) as EntryInput;
const census = (seq: number, item: Ref, members: Ref[], complete: boolean, quote: string): EntryInput =>
  ({ kind: "item", review: "auto", op: "census", seq, item, members, complete, quote, source: narration });
const commit = (chapter: number, text: string, entries: EntryInput[], key = `k${chapter}`) =>
  runCommand(book, chapterCommit, { chapter, text: `# 第${chapter}章\n\n${text}`, entries }, author(key));
const record = (decisions: unknown[], key: string) => runCommand(book, decisionRecord, { decisions } as never, author(key));
const itemOf = async (id: string) => (await projectBook(book)).items.find((item) => item.id === id);

describe("定稿落账", () => {
  it("6.1 同一句里两次转手：seq 1、2，章末在丙手里", async () => {
    expectOk(await commit(1, "甲把一块表交给乙，乙随即转交给丙。", [
      appear("N1", "表", "甲把一块表交给乙"),
      step("move", 1, { tag: "N1" }, { kind: "person", name: "乙" }, "甲把一块表交给乙", { from: { kind: "person", name: "甲" } }),
      step("move", 2, { tag: "N1" }, { kind: "person", name: "丙" }, "乙随即转交给丙", { from: { kind: "person", name: "乙" } }),
    ]));
    expect(await itemOf("i1-1")).toMatchObject({ name: "表", now: { kind: "known", place: { kind: "person", name: "丙" } } });
    expect(await readChapterLedger(book, 1)).toMatchObject({ status: "ready", itemModel: 1 });
  });

  it("6.2 同一个 seq：拿不准、两种都列；缺 seq 那条不收，这章东西那类没记全", async () => {
    expectOk(await commit(1, "表一会儿在乙手里，一会儿又到了丙手里。", [
      appear("N1", "表", "表一会儿在乙手里"),
      step("at", 1, { tag: "N1" }, { kind: "person", name: "乙" }, "表一会儿在乙手里"),
      step("at", 1, { tag: "N1" }, { kind: "person", name: "丙" }, "一会儿又到了丙手里"),
    ]));
    expect((await itemOf("i1-1"))?.now).toMatchObject({ kind: "uncertain", reason: "order" });

    const outcome = expectOk(await commit(2, "表到了丁手里。", [step("at", undefined, { id: "i1-1" }, { kind: "person", name: "丁" }, "表到了丁手里")]));
    expect(outcome.result.rejected).toHaveLength(1);
    expect(await readChapterLedger(book, 2)).toMatchObject({ status: "partial", coverage: { missingKinds: ["item"], reasonCodes: ["item_rejected"], missingItems: ["i1-1"] } });
    expect(await itemOf("i1-1")).toMatchObject({ unverifiedSince: 2, unverifiedBy: "entry" });
  });

  it("6.8 只在清点里出现的成员：表在盒里、往外是甲拿着；读回声明再交一次，账一模一样", async () => {
    const text = "甲捧着木盒。盒里有一块表。";
    const entries = [
      appear("N1", "木盒", "甲捧着木盒"),
      appear("N2", "表", "盒里有一块表"),
      step("at", 1, { tag: "N1" }, { kind: "person", name: "甲" }, "甲捧着木盒"),
      census(2, { tag: "N1" }, [{ tag: "N2" }], false, "盒里有一块表"),
    ];
    expectOk(await commit(1, text, entries));
    expect((await itemOf("i1-2"))?.now).toMatchObject({ kind: "known", place: { kind: "inside", item: "i1-1" } });
    const first = await readChapterLedger(book, 1);
    expectOk(await commit(1, text, declarationsOf(first!) as EntryInput[], "k1b"));
    const again = await readChapterLedger(book, 1);
    expect(again?.entries).toEqual(first?.entries);
  });

  it("6.10 N2 的原句不在正文：引用 N2 的条目、含 N2 的完整清点全不收；带 N2 的事实不收，没记全里再缺事实", async () => {
    const outcome = expectOk(await commit(1, "铁盒里只有一封信。", [
      appear("N1", "铁盒", "铁盒里只有一封信"),
      appear("N2", "信", "这句正文里没有"),
      census(1, { tag: "N1" }, [{ tag: "N2" }], true, "铁盒里只有一封信"),
      step("at", 2, { tag: "N2" }, { kind: "inside", item: { tag: "N1" } }, "铁盒里只有一封信"),
      { kind: "fact", review: "auto", nature: "hard", subject: "信", attribute: "封口", value: "火漆", item: { tag: "N2" }, text: "信封着火漆", quote: "铁盒里只有一封信", source: narration },
    ]));
    expect(outcome.result.rejected.map((item) => item.index)).toEqual([1, 2, 3, 4]);
    const ledger = await readChapterLedger(book, 1);
    // 没记上的几条说到铁盒和信；信本身没进账，只缺铁盒。
    expect(ledger).toMatchObject({ status: "partial", coverage: { missingKinds: ["item", "fact"], missingItems: ["i1-1"] } });
    expect(ledger?.entries.map((entry) => entry.kind)).toEqual(["item"]);
    expect(await itemOf("i1-1")).toMatchObject({ name: "铁盒" });
    expect((await itemOf("i1-1"))?.census).toBeUndefined();
  });

  it("6.20 同一章完整清点之后，同章一条东西条目缺 seq 没收：章末清点此后没核全", async () => {
    expectOk(await commit(1, "铁盒里只有一封信。他把铁盒放在床底下。", [
      appear("N1", "铁盒", "他把铁盒放在床底下"),
      appear("N2", "信", "铁盒里只有一封信"),
      census(1, { tag: "N1" }, [{ tag: "N2" }], true, "铁盒里只有一封信"),
      step("at", undefined, { tag: "N1" }, { kind: "place", text: "床底下" }, "他把铁盒放在床底下"),
    ]));
    expect(await readChapterLedger(book, 1)).toMatchObject({ status: "partial", coverage: { missingKinds: ["item"] } });
    expect((await itemOf("i1-1"))?.census).toMatchObject({ status: "unverified", since: 1 });
  });

  describe("只缺认得出的那几样（一条没记上不连累别的东西）", () => {
    const chapter1 = () => commit(1, "乙揣着一块表。丙拿着一把伞。桌上的木盒里只有一枚印章。", [
      appear("N1", "表", "乙揣着一块表"),
      appear("N2", "伞", "丙拿着一把伞"),
      appear("N3", "木盒", "桌上的木盒里只有一枚印章"),
      appear("N4", "印章", "桌上的木盒里只有一枚印章"),
      step("at", 1, { tag: "N1" }, { kind: "person", name: "乙" }, "乙揣着一块表"),
      step("at", 2, { tag: "N2" }, { kind: "person", name: "丙" }, "丙拿着一把伞"),
      step("at", 3, { tag: "N3" }, { kind: "place", text: "桌上" }, "桌上的木盒里只有一枚印章"),
      census(4, { tag: "N3" }, [{ tag: "N4" }], true, "桌上的木盒里只有一枚印章"),
    ]);

    it("说印章的那条没收：只印章和装着它的木盒清点没核全，表、伞照旧", async () => {
      expectOk(await chapter1());
      expectOk(await commit(2, "印章被拿了出来。", [step("move", undefined, { id: "i1-4" }, { kind: "person", name: "乙" }, "印章被拿了出来")]));
      expect(await readChapterLedger(book, 2)).toMatchObject({ status: "partial", coverage: { missingKinds: ["item"], missingItems: ["i1-4"] } });
      expect(await itemOf("i1-4")).toMatchObject({ unverifiedSince: 2, unverifiedBy: "entry" });
      expect((await itemOf("i1-3"))?.census).toMatchObject({ status: "unverified", since: 2 });
      expect((await itemOf("i1-1"))?.unverifiedSince).toBeUndefined();
      expect((await itemOf("i1-2"))?.unverifiedSince).toBeUndefined();
    });

    it("交来的没写明缺哪几样、或写的标签本批没有：整章东西都没核全", async () => {
      expectOk(await chapter1());
      expectOk(await runCommand(book, chapterCommit, { chapter: 2, text: "# 第2章\n\n过了一天。", entries: [], ledger: { status: "partial", reasonCodes: ["item_rejected"], missingKinds: ["item"] } }, author("k2")));
      expect((await readChapterLedger(book, 2))?.coverage.missingItems).toBeUndefined();
      expect(await itemOf("i1-2")).toMatchObject({ unverifiedSince: 2, unverifiedBy: "chapter" });
      expectOk(await runCommand(book, chapterCommit, { chapter: 3, text: "# 第3章\n\n又过了一天。", entries: [], ledger: { status: "partial", reasonCodes: ["item_rejected"], missingKinds: ["item"], missingItems: [{ tag: "N9" }] } }, author("k3")));
      expect((await readChapterLedger(book, 3))?.coverage.missingItems).toBeUndefined();
    });

    it("写明只缺的编号前文没有：读的时候当整章没记全", async () => {
      expectOk(await chapter1());
      expectOk(await runCommand(book, chapterCommit, { chapter: 2, text: "# 第2章\n\n过了一天。", entries: [], ledger: { status: "partial", reasonCodes: ["item_rejected"], missingKinds: ["item"], missingItems: [{ id: "i9-9" }] } }, author("k2")));
      expect((await readChapterLedger(book, 2))?.coverage.missingItems).toEqual(["i9-9"]);
      expect(await itemOf("i1-2")).toMatchObject({ unverifiedSince: 2, unverifiedBy: "chapter" });
    });

    it("没记上的只是本章新写到的那样：别的东西不受影响", async () => {
      expectOk(await chapter1());
      expectOk(await commit(2, "乙又拿出一面镜子。", [appear("N1", "镜子", "这句正文里没有")]));
      expect(await readChapterLedger(book, 2)).toMatchObject({ status: "partial", coverage: { missingKinds: ["item"], missingItems: [] } });
      for (const id of ["i1-1", "i1-2", "i1-4"]) expect((await itemOf(id))?.unverifiedSince).toBeUndefined();
      expect((await itemOf("i1-3"))?.census).toMatchObject({ status: "valid" });
    });
  });

  it("清点成员上的旧记法关联：前文没有那条事实 → 整条清点不收；有 → 收下、读回再交一模一样", async () => {
    expectOk(await commit(1, "表和信都在盒里。", [
      { kind: "fact", review: "auto", nature: "state", subject: "表和信", attribute: "在哪", value: "盒里", text: "表和信都在盒里", quote: "表和信都在盒里" },
    ]));
    const text = "乙的木盒里有一块表。";
    const entries = (fact: string) => [
      appear("N1", "木盒", text),
      appear("N2", "表", text),
      { ...census(1, { tag: "N1" }, [{ tag: "N2" }], false, text), members: [{ tag: "N2", overlaps: [fact] }] } as EntryInput,
    ];
    const bad = expectOk(await commit(2, text, entries("c9-9")));
    expect(bad.result.rejected.map((item) => item.reason)).toEqual(["unknown_fact"]);
    expectOk(await commit(2, text, entries("c1-1"), "k2b"));
    const first = await readChapterLedger(book, 2);
    // 头一次那份没收的清点之外，两样东西的号照样占着；这次重记没写 P 号，发新号。
    const watch = first?.entries.find((entry) => entry.kind === "item" && entry.op === "appear" && entry.itemRef.mention === "表");
    const watchId = watch?.kind === "item" ? watch.itemRef.id : "";
    expect(watchId).toBe("i2-4");
    expect(first?.entries.find((entry) => entry.kind === "item" && entry.op === "census")).toMatchObject({ members: [{ id: watchId, overlaps: ["c1-1"] }] });
    expect((await projectBook(book)).facts.find((fact) => fact.id === "c1-1")).toMatchObject({ status: "current", unaligned: [watchId] });
    expectOk(await commit(2, text, declarationsOf(first!) as EntryInput[], "k2c"));
    expect((await readChapterLedger(book, 2))?.entries).toEqual(first?.entries);
  });

  it("6.16 人物说的去向不改现状；作者的 item.state 压过那章记的", async () => {
    expectOk(await commit(1, "表在乙手里。丙说：“表早给了我。”", [
      appear("N1", "表", "表在乙手里"),
      step("at", 1, { tag: "N1" }, { kind: "person", name: "乙" }, "表在乙手里"),
      { ...step("at", 2, { tag: "N1" }, { kind: "person", name: "丙" }, "表早给了我"), source: { kind: "character_claim", speaker: "丙" } } as EntryInput,
    ]));
    expect((await itemOf("i1-1"))?.now).toMatchObject({ kind: "known", place: { name: "乙" } });
    expectOk(await record([{ type: "item.state", item: "i1-1", chapter: 1, state: { kind: "at", to: { kind: "person", ref: { mention: "丙" } } } }], "d1"));
    expect((await itemOf("i1-1"))?.now).toMatchObject({ kind: "known", place: { name: "丙" } });
  });
});

describe("改账裁定", () => {
  const BOX = "铁盒里只有一封信。他把铁盒放在床底下。";
  const boxEntries = () => [
    appear("N1", "铁盒", "他把铁盒放在床底下"),
    appear("N2", "信", "铁盒里只有一封信"),
    step("at", 1, { tag: "N1" }, { kind: "place", text: "床底下" }, "他把铁盒放在床底下"),
    census(2, { tag: "N1" }, [{ tag: "N2" }], true, "铁盒里只有一封信"),
  ];

  it("6.13 误闭合改开放：作者给没列全的清点，旧完整清点不再排除别的；容器自己在哪不变", async () => {
    expectOk(await commit(1, BOX, boxEntries()));
    expectOk(await commit(2, "他从铁盒里拿出一块表。", [
      appear("N1", "表", "他从铁盒里拿出一块表"),
      step("move", 1, { tag: "N1" }, { kind: "person", name: "他" }, "他从铁盒里拿出一块表", { from: { kind: "inside", item: { id: "i1-1" } } }),
    ]));
    expect((await projectBook(book)).itemIssues.map((issue) => issue.kind)).toEqual(["not-in-census"]);
    expectOk(await record([{ type: "item.state", item: "i1-1", chapter: 1, state: { kind: "census", members: [{ id: "i1-2" }], complete: false } }], "d1"));
    const view = await projectBook(book);
    expect(view.itemIssues).toEqual([]);
    expect(view.items.find((item) => item.id === "i1-1")).toMatchObject({ now: { kind: "known", place: { kind: "place", text: "床底下" } } });
    expect(view.items.find((item) => item.id === "i1-1")?.census).toBeUndefined();
  });

  it("毁了改丢了：撤回那条、作者定丢了", async () => {
    expectOk(await commit(1, BOX, boxEntries()));
    expectOk(await commit(2, "信烧成了灰。", [{ kind: "item", review: "auto", op: "gone", seq: 1, item: { id: "i1-2" }, gone: "destroyed", quote: "信烧成了灰", source: narration }]));
    const burnt = (await readChapterLedger(book, 2))!.entries[0]!.id;
    expectOk(await record([{ type: "item.retract", entry: burnt }, { type: "item.state", item: "i1-2", chapter: 2, state: { kind: "gone", gone: "lost" } }], "d1"));
    expect((await itemOf("i1-2"))?.now).toMatchObject({ kind: "gone", gone: "lost" });
    expect((await itemOf("i1-1"))?.now).toMatchObject({ kind: "known", place: { kind: "place", text: "床底下" } });
  });

  it("改账指着不在的东西 / 条目 / 没定稿的章：整批不记，如实说", async () => {
    expectOk(await commit(1, BOX, boxEntries()));
    expect(await record([{ type: "item.merge", from: ["i9-9"], into: "i1-1" }], "d1")).toMatchObject({ ok: false, code: "unknown_item" });
    expect(await record([{ type: "item.retract", entry: "c9-9" }], "d2")).toMatchObject({ ok: false, code: "unknown_entry" });
    expect(await record([{ type: "item.state", item: "i1-1", chapter: 5, state: { kind: "gone", gone: "lost" } }], "d3")).toMatchObject({ ok: false, code: "unknown_chapter" });
    expect(await record([{ type: "item.state", item: "i1-1", chapter: 1, state: { kind: "census", members: [{ id: "i1-1" }], complete: true } }], "d4")).toMatchObject({ ok: false, code: "unknown_item" });
    expect(await record([{ type: "item.state", item: "i1-2", chapter: 1, state: { kind: "gone", gone: "lost" }, overlaps: ["c9-9"] }], "d5")).toMatchObject({ ok: false, code: "unknown_fact" });
  });
});
