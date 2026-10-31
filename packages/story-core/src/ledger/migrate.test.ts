// 写作版本 P2b 片 2：原句定位、v1 → v2 迁移器、「账本升级」命令。设计 2.1～2.3。
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chapterCommit } from "../commands/chapter-commit.js";
import { LEDGER_MIGRATE_COMMAND, ledgerMigrate, ledgerMigrateKey, ledgersToUpgrade } from "../commands/ledger-migrate.js";
import { runCommand } from "../commands/runner.js";
import { readReceipts } from "../history/revert.js";
import { projectBook } from "../index.js";
import { ChapterLedger, type EntryInput, type LedgerEntry } from "../schema/ledger.js";
import { LedgerNeedsUpgradeError, readBookSnapshot } from "../store/book.js";
import { chapterLedgerPath, chapterTextPath, TX_DIR } from "../store/paths.js";
import { recoverBookTransactions } from "../store/transaction.js";
import { splitUnits } from "../text/units.js";
import { chapterSource, declarationsOf, evidenceFor, locateQuote } from "./entries.js";
import { isLedgerV1, LEDGER_V1_SCHEMA, upgradeLedgerV1 } from "./migrate-v1.js";

const sha256 = (value: string): string => createHash("sha256").update(value, "utf-8").digest("hex");

const TEXT = "# 第2章 · 外乡人\n\n第二天上午，外乡人又来了。老周站在门口，没让他进。\n\n沈青禾想起钟停那天，爷爷也这样站着。老周站在门口。";

describe("原句定位", () => {
  const source = chapterSource(2, TEXT);
  const unitOf = (id: number) => splitUnits(TEXT).find((unit) => unit.id === id);

  it("只出现一次：给句号；跨两句给起止", () => {
    const one = locateQuote("外乡人又来了", source);
    expect(one?.units?.from).toBe(one?.units?.to);
    expect(unitOf(one?.units?.from as number)?.text).toContain("外乡人又来了");
    const two = locateQuote("没让他进。沈青禾想起", source);
    expect(two?.units?.to).toBe((two?.units?.from as number) + 1);
  });

  it("出现不止一处：认得出在正文里、不任选一处（quoted）", () => {
    expect(locateQuote("老周站在门口", source)).toEqual({});
    expect(evidenceFor("老周站在门口", source)).toEqual({ evidence: [{ resource: { kind: "chapter", chapter: 2 }, revision: sha256(TEXT), quote: "老周站在门口" }], evidenceStatus: "quoted" });
  });

  it("找不到 = undefined；没原句 = none", () => {
    expect(locateQuote("钟楼塌了", source)).toBeUndefined();
    expect(evidenceFor("钟楼塌了", source)).toBeUndefined();
    expect(evidenceFor(undefined, source)).toEqual({ evidence: [], evidenceStatus: "none" });
  });

  it("证据的版本号是正文哈希", () => {
    expect(evidenceFor("外乡人又来了", source)).toMatchObject({ evidence: [{ revision: sha256(TEXT) }], evidenceStatus: "located" });
  });
});

const V1_ENTRIES = [
  { id: "c2-1", kind: "summary", review: "auto", text: "外乡人又来，老周拦着", quote: "外乡人又来了" },
  { id: "c2-2", kind: "presence", review: "auto", name: "周守义", nameUsed: "老周", quote: "没让他进" },
  { id: "c2-3", kind: "fact", review: "author", nature: "state", subject: "外乡人", attribute: "在哪", value: "门外", text: "外乡人在门外", quote: "没让他进" },
  { id: "c2-4", kind: "thread", review: "auto", op: "open", type: "question", title: "外乡人是谁", note: "又来了", quote: "外乡人又来了", thread: "t2-1" },
  { id: "c2-5", kind: "thread", review: "auto", op: "advance", note: "想起爷爷", quote: "爷爷也这样站着", thread: "t1-1" },
  { id: "c2-6", kind: "time", review: "auto", basis: "text", quote: "第二天上午", daysSincePrevious: 1, daysInChapter: 2, weekday: 3, timeOfDay: "上午" },
] as const;

function v1Raw(entries: readonly object[] = V1_ENTRIES, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ schema: LEDGER_V1_SCHEMA, chapter: 2, textSha256: sha256(TEXT), committedAt: "2026-10-01T00:00:00.000Z", origin: "commit", entries, ...extra }, null, 2)}\n`;
}

function upgraded(raw: string, text: string | undefined): ChapterLedger {
  const result = upgradeLedgerV1(raw, text);
  if (!result.ok) throw new Error(result.reason);
  return ChapterLedger.parse(result.ledger);
}

const withoutId = (entry: object): object => {
  const { id: _id, ...rest } = entry as { id: string };
  return rest;
};

describe("v1 → v2 迁移器", () => {
  it("编号、review、来历原样；来源 unknown、provenance migrated；正文没变的原句定位；时间拆成开头 + 结尾两条", () => {
    const raw = v1Raw();
    const result = upgradeLedgerV1(raw, TEXT);
    if (!result.ok) throw new Error(result.reason);
    const ledger = ChapterLedger.parse(result.ledger);
    expect(ledger).toMatchObject({ schema: "chapter-ledger/2", chapter: 2, textSha256: sha256(TEXT), committedAt: "2026-10-01T00:00:00.000Z", origin: "commit", status: "ready", unitsVersion: 1, scenes: [] });
    expect(ledger.coverage.reasonCodes).toEqual(["legacy_protocol"]);
    expect(ledger.legacy).toEqual({ schema: LEDGER_V1_SCHEMA, sha256: sha256(raw) });
    expect(ledger.entries.map((entry) => entry.id)).toEqual(["c2-1", "c2-2", "c2-3", "c2-4", "c2-5", "c2-6", "c2-6-end"]);
    expect(ledger.entries.every((entry) => entry.provenance === "migrated" && entry.source.kind === "unknown")).toBe(true);
    expect(ledger.entries.find((entry) => entry.id === "c2-3")?.review).toBe("author");
    // 「没让他进」只一处、「外乡人又来了」只一处：定位；时间开头那条的原句也定位，结尾那条跟着同一句。
    expect(ledger.entries.map((entry) => entry.evidenceStatus)).toEqual(["located", "located", "located", "located", "located", "located", "located"]);
    expect(result.evidence).toEqual({ located: 6, quoted: 0, unlocated_legacy: 0, stale: 0, none: 0 });
    const [start, end] = ledger.entries.filter((entry) => entry.kind === "time");
    expect(start).toMatchObject({ relation: "offset", appliesTo: "chapterStart", anchor: "previousChapterEnd", offset: { unit: "day", min: 1, max: 1 }, weekday: 3, timeOfDay: "上午", basis: "text" });
    expect(end).toMatchObject({ relation: "offset", appliesTo: "chapterEnd", anchor: "chapterStart", offset: { unit: "day", min: 2, max: 2 }, basis: "text" });
    expect(end).not.toHaveProperty("weekday");
    expect(ledger.entries.find((entry) => entry.id === "c2-4")).toMatchObject({ threadRef: { id: "t2-1" } });
    expect(ledger.entries.find((entry) => entry.id === "c2-5")).toMatchObject({ threadRef: { id: "t1-1" } });
    expect(ledger.entries.find((entry) => entry.id === "c2-3")).toMatchObject({ subjectRef: { mention: "外乡人" }, predicate: "在哪", value: "门外" });
  });

  it("读回成声明：别的和 v1 一字不差；时间两条并回一条、换成 P3 的说法（开头离上一章、章内换天）", () => {
    const [time, ...rest] = [...declarationsOf(upgraded(v1Raw(), TEXT))].reverse();
    expect(rest.reverse()).toEqual(V1_ENTRIES.slice(0, 5).map(withoutId));
    expect(time).toEqual({
      kind: "time",
      review: "auto",
      start: { offset: { unit: "day", min: 1, max: 1 }, basis: "text", quote: "第二天上午" },
      dayChanges: [{ offset: { unit: "day", min: 2, max: 2 } }],
      weekday: 3,
      timeOfDay: "上午",
    });
  });

  it("定稿后正文改过：原句一律 stale，版本号仍是定稿那版；正文不在了：unlocated_legacy", () => {
    const stale = upgraded(v1Raw(), `${TEXT}\n\n后来补的一段。`);
    expect(new Set(stale.entries.map((entry) => entry.evidenceStatus))).toEqual(new Set(["stale"]));
    expect(stale.entries.every((entry) => entry.evidence.every((item) => item.revision === sha256(TEXT) && item.units === undefined))).toBe(true);
    const gone = upgraded(v1Raw(), undefined);
    expect(new Set(gone.entries.map((entry) => entry.evidenceStatus))).toEqual(new Set(["unlocated_legacy"]));
  });

  it("正文没变但原句找不到：unlocated_legacy；出现多处：quoted", () => {
    const ledger = upgraded(v1Raw([
      { id: "c2-1", kind: "summary", review: "auto", text: "梗概", quote: "这句正文里没有" },
      { id: "c2-2", kind: "presence", review: "auto", name: "周守义", nameUsed: "老周", quote: "老周站在门口" },
    ]), TEXT);
    expect(ledger.entries.map((entry) => entry.evidenceStatus)).toEqual(["unlocated_legacy", "quoted"]);
  });

  it("作者定的第几天 → at；没天数的估计 → unknown（估的不升成准的）", () => {
    const at = upgraded(v1Raw([{ id: "c2-1", kind: "time", review: "author", basis: "author", day: 5 }]), TEXT);
    expect(at.entries).toMatchObject([{ relation: "at", appliesTo: "chapterStart", day: 5, basis: "author", evidenceStatus: "none" }]);
    const unknown = upgraded(v1Raw([{ id: "c2-1", kind: "time", review: "auto", basis: "estimated", timeOfDay: "夜里" }]), TEXT);
    expect(unknown.entries).toMatchObject([{ relation: "unknown", appliesTo: "chapterStart", basis: "estimated", timeOfDay: "夜里" }]);
  });

  it("导入的空账：账待记（pending、imported_text）；导入的、带没原句的条目：ready，证据 none", () => {
    const pending = upgraded(v1Raw([], { origin: "import" }), TEXT);
    expect(pending).toMatchObject({ status: "pending", origin: "import", entries: [] });
    expect(pending.coverage.reasonCodes).toEqual(["imported_text"]);
    const old = upgraded(v1Raw([{ id: "c2-1", kind: "fact", review: "auto", nature: "event", text: "外乡人来过" }], { origin: "import" }), TEXT);
    expect(old).toMatchObject({ status: "ready", entries: [{ evidenceStatus: "none", evidence: [] }] });
  });

  it("坏的 v1 不硬迁：JSON 坏了、当年就不成立（两条梗概、定稿条目没原句）都如实失败", () => {
    expect(upgradeLedgerV1("{坏", TEXT)).toMatchObject({ ok: false });
    expect(upgradeLedgerV1(v1Raw([V1_ENTRIES[0], { ...V1_ENTRIES[0], id: "c2-9" }]), TEXT)).toMatchObject({ ok: false, reason: expect.stringContaining("梗概") });
    expect(upgradeLedgerV1(v1Raw([{ id: "c2-1", kind: "summary", review: "auto", text: "梗概" }]), TEXT)).toMatchObject({ ok: false });
  });

  it("只认格式标记", () => {
    expect(isLedgerV1(v1Raw())).toBe(true);
    expect(isLedgerV1(JSON.stringify({ schema: "chapter-ledger/2" }))).toBe(false);
    expect(isLedgerV1("不是 JSON")).toBe(false);
  });
});

describe("账本升级命令", () => {
  let book: string;
  beforeEach(async () => {
    book = await mkdtemp(join(tmpdir(), "story-core-migrate-"));
    await mkdir(join(book, "chapters"), { recursive: true });
    await mkdir(join(book, "ledger/chapters"), { recursive: true });
  });
  afterEach(async () => {
    await rm(book, { recursive: true, force: true });
  });

  const CH1 = "# 第1章 · 钟停\n\n钟停在三点十五分。沈青禾推开钟楼的门，老周没有拦她。";
  const CH1_ENTRIES = [
    { id: "c1-1", kind: "summary", review: "auto", text: "沈青禾进钟楼", quote: "沈青禾推开钟楼的门" },
    { id: "c1-2", kind: "thread", review: "auto", op: "open", type: "question", title: "钟为什么停", note: "停了", quote: "钟停在三点十五分", thread: "t1-1" },
    { id: "c1-3", kind: "time", review: "auto", basis: "judged", quote: "钟停在三点十五分", daysInChapter: 0 },
  ];
  const v1Of = (chapter: number, text: string, entries: readonly object[], origin = "commit"): string =>
    `${JSON.stringify({ schema: LEDGER_V1_SCHEMA, chapter, textSha256: sha256(text), committedAt: `2026-10-0${chapter}T00:00:00.000Z`, origin, entries }, null, 2)}\n`;

  async function seed(): Promise<void> {
    await writeFile(join(book, chapterTextPath(1)), CH1);
    await writeFile(join(book, chapterTextPath(2)), TEXT);
    await writeFile(join(book, chapterLedgerPath(1)), v1Of(1, CH1, CH1_ENTRIES));
    await writeFile(join(book, chapterLedgerPath(2)), v1Of(2, TEXT, V1_ENTRIES));
  }

  const read = (path: string) => readFile(join(book, path), "utf-8");

  async function migrate(digest: string, snapshot?: (label: string, command: string) => Promise<string>) {
    return runCommand(book, ledgerMigrate, { digest }, { caller: "author", idempotencyKey: ledgerMigrateKey(digest), ...(snapshot ? { snapshot } : {}) });
  }

  it("升级前读书如实说要升级；一个事务全升、先存档、回执记两份；升完照常读", async () => {
    await seed();
    await expect(readBookSnapshot(book)).rejects.toBeInstanceOf(LedgerNeedsUpgradeError);
    const found = await ledgersToUpgrade(book);
    expect(found?.chapters).toEqual([1, 2]);
    const snapshots: string[] = [];
    const outcome = await migrate(found?.digest as string, async (label, command) => {
      snapshots.push(`${command}:${label}`);
      return "tree-1";
    });
    expect(outcome).toMatchObject({ ok: true, result: { chapters: 2, pending: 0, evidence: { located: 9, quoted: 0, unlocated_legacy: 0, stale: 0, none: 0 } } });
    expect(snapshots).toEqual([`${LEDGER_MIGRATE_COMMAND}:账本升级`]);
    for (const chapter of [1, 2]) expect(ChapterLedger.parse(JSON.parse(await read(chapterLedgerPath(chapter)))).schema).toBe("chapter-ledger/2");
    const receipt = (await readReceipts(book)).find((item) => item.command === LEDGER_MIGRATE_COMMAND);
    expect(receipt?.effects?.map((effect) => effect.path).sort()).toEqual([chapterLedgerPath(1), chapterLedgerPath(2)]);
    expect(receipt?.snapshotTree).toBe("tree-1");
    // 正文一个字节不动。
    expect(await read(chapterTextPath(1))).toBe(CH1);
    expect((await readBookSnapshot(book)).ledgers).toHaveLength(2);
    expect(await ledgersToUpgrade(book)).toBeUndefined();
  });

  it("同一批再点一次：回放，不再写；换个键再来：已经是新格式", async () => {
    await seed();
    const found = await ledgersToUpgrade(book);
    expect(await migrate(found?.digest as string)).toMatchObject({ ok: true });
    const after = await read(chapterLedgerPath(2));
    expect(await migrate(found?.digest as string)).toMatchObject({ ok: true, replayed: true });
    expect(await read(chapterLedgerPath(2))).toBe(after);
    expect(await runCommand(book, ledgerMigrate, { digest: found?.digest as string }, { caller: "author", idempotencyKey: "other" })).toMatchObject({ ok: false, code: "nothing_to_upgrade" });
  });

  it("看过之后旧账又改了：不升、一份不动", async () => {
    await seed();
    const found = await ledgersToUpgrade(book);
    const changed = v1Of(1, CH1, CH1_ENTRIES.slice(0, 2));
    await writeFile(join(book, chapterLedgerPath(1)), changed);
    expect(await migrate(found?.digest as string)).toMatchObject({ ok: false, code: "changed_since_scan" });
    expect(await read(chapterLedgerPath(1))).toBe(changed);
    expect(isLedgerV1(await read(chapterLedgerPath(2)))).toBe(true);
  });

  it("有一章升不了：整本不升，说清是哪一章", async () => {
    await seed();
    await writeFile(join(book, chapterLedgerPath(2)), v1Of(2, TEXT, [V1_ENTRIES[0], { ...V1_ENTRIES[0], id: "c2-9" }]));
    const found = await ledgersToUpgrade(book);
    const outcome = await migrate(found?.digest as string);
    expect(outcome).toMatchObject({ ok: false, code: "ledger_unreadable" });
    if (!outcome.ok) expect(outcome.message).toContain("第 2 章");
    expect(isLedgerV1(await read(chapterLedgerPath(1)))).toBe(true);
  });

  it("作者档：AI 调不动", async () => {
    await seed();
    const found = await ledgersToUpgrade(book);
    expect(await runCommand(book, ledgerMigrate, { digest: found?.digest as string }, { caller: "ai", idempotencyKey: "ai" })).toMatchObject({ ok: false });
    expect(isLedgerV1(await read(chapterLedgerPath(1)))).toBe(true);
  });

  it("一章账单都没有：不用升", async () => {
    expect(await ledgersToUpgrade(book)).toBeUndefined();
  });

  it("升到一半进程没了：开书收拾事务时整批换回旧账，再升一次照样成", async () => {
    await seed();
    const found = await ledgersToUpgrade(book);
    // 摆出「第 1 章的新账已换上、第 2 章还在暂存」的半截事务（和事务测试同一种摆法）。
    const v2 = upgradeLedgerV1(await read(chapterLedgerPath(1)), CH1);
    if (!v2.ok) throw new Error(v2.reason);
    const txDir = join(book, TX_DIR, "t1");
    await mkdir(join(txDir, "staged"), { recursive: true });
    await mkdir(join(txDir, "backup"), { recursive: true });
    await writeFile(join(txDir, "backup", "0"), await read(chapterLedgerPath(1)));
    await writeFile(join(txDir, "backup", "1"), await read(chapterLedgerPath(2)));
    await writeFile(join(txDir, "staged", "1"), "{}");
    const old1 = await read(chapterLedgerPath(1));
    await writeFile(join(book, chapterLedgerPath(1)), JSON.stringify(v2.ledger));
    await writeFile(join(txDir, "manifest.json"), JSON.stringify({
      schema: "story-core-tx/1", id: "t1", createdAt: "2026-10-31T00:00:00.000Z", status: "prepared",
      files: [{ path: chapterLedgerPath(1), existed: true, slot: "0" }, { path: chapterLedgerPath(2), existed: true, slot: "1" }],
    }));
    expect((await recoverBookTransactions(book)).rolledBack).toEqual(["t1"]);
    expect(await read(chapterLedgerPath(1))).toBe(old1);
    expect((await ledgersToUpgrade(book))?.digest).toBe(found?.digest);
    expect(await migrate(found?.digest as string)).toMatchObject({ ok: true, result: { chapters: 2 } });
  });

  it("导入了还没通读的：升成账待记", async () => {
    await writeFile(join(book, chapterTextPath(1)), CH1);
    await writeFile(join(book, chapterLedgerPath(1)), v1Of(1, CH1, [], "import"));
    const found = await ledgersToUpgrade(book);
    expect(await migrate(found?.digest as string)).toMatchObject({ ok: true, result: { chapters: 1, pending: 1 } });
    expect(JSON.parse(await read(chapterLedgerPath(1)))).toMatchObject({ status: "pending", origin: "import" });
  });

  it("迁移来的书和同样内容新定稿的书投影一样；时间天数一样，只是旧账算推定的", async () => {
    const native = await mkdtemp(join(tmpdir(), "story-core-native-"));
    try {
      // 新定稿那本：时间按 P3 的说法记（和 v1 那两条同一个意思）。
      const p3Time: Record<number, EntryInput> = {
        1: { kind: "time", review: "auto", start: { offset: { unit: "day", min: 0, max: 0 }, basis: "judged", quote: "钟停在三点十五分" }, sameDay: true },
        2: { kind: "time", review: "auto", start: { offset: { unit: "day", min: 1, max: 1 }, basis: "text", quote: "第二天上午" }, dayChanges: [{ offset: { unit: "day", min: 2, max: 2 } }], weekday: 3, timeOfDay: "上午" },
      };
      const declared = (chapter: number, entries: readonly object[]) =>
        entries.map((entry) => ((entry as { kind: string }).kind === "time" ? p3Time[chapter] : withoutId(entry))) as EntryInput[];
      for (const [chapter, text, entries] of [[1, CH1, CH1_ENTRIES], [2, TEXT, V1_ENTRIES]] as const) {
        const outcome = await runCommand(native, chapterCommit, { chapter, text, entries: declared(chapter, entries) }, { caller: "author", idempotencyKey: `c${chapter}` });
        expect(outcome).toMatchObject({ ok: true, result: { rejected: [] } });
      }
      // 旧账照新定稿那本的编号写（迁移只换格式，编号原样）；时间用 v1 当年的写法。
      for (const [chapter, text, v1] of [[1, CH1, CH1_ENTRIES], [2, TEXT, V1_ENTRIES]] as const) {
        const ledger = ChapterLedger.parse(JSON.parse(await readFile(join(native, chapterLedgerPath(chapter)), "utf-8")));
        const ids = new Map(ledger.entries.filter((entry) => entry.kind !== "time").map((entry: LedgerEntry, index) => [index, entry.id]));
        const threads = new Map(ledger.entries.flatMap((entry) => (entry.kind === "thread" && entry.op === "open" ? [[entry.id, entry.threadRef.id] as const] : [])));
        const timeId = ledger.entries.find((entry) => entry.kind === "time")?.id as string;
        let index = 0;
        const entries = v1.map((entry) => {
          if (entry.kind === "time") return { ...entry, id: timeId };
          const id = ids.get(index++) as string;
          return { ...withoutId(entry), id, ...(threads.has(id) ? { thread: threads.get(id) } : {}) };
        });
        await writeFile(join(book, chapterTextPath(chapter)), text);
        await writeFile(join(book, chapterLedgerPath(chapter)), `${JSON.stringify({ schema: LEDGER_V1_SCHEMA, chapter, textSha256: ledger.textSha256, committedAt: ledger.committedAt, origin: "commit", entries }, null, 2)}\n`);
      }
      const found = await ledgersToUpgrade(book);
      expect(await migrate(found?.digest as string)).toMatchObject({ ok: true });
      type View = Awaited<ReturnType<typeof projectBook>>;
      const strip = ({ version: _version, chapters, ...rest }: View) => ({ ...rest, chapters: chapters.map(({ time: _time, ...chapter }) => chapter) });
      const migrated = await projectBook(book);
      const fresh = await projectBook(native);
      expect(strip(migrated)).toEqual(strip(fresh));
      const days = (view: View) => view.chapters.map(({ time }) => [time.start, time.end, time.weekday, time.basis]);
      expect(days(fresh)).toEqual([[{ lo: 1, hi: 1 }, { lo: 1, hi: 1 }, 2, "ledger"], [{ lo: 2, hi: 2 }, { lo: 4, hi: 4 }, 3, "ledger"]]);
      expect(days(migrated)).toEqual([[{ lo: 1, hi: 1 }, { lo: 1, hi: 1 }, 2, "presumed"], [{ lo: 2, hi: 2 }, { lo: 4, hi: 4 }, 3, "presumed"]]);
    } finally {
      await rm(native, { recursive: true, force: true });
    }
  });
});
