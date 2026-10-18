// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CHAPTER_LEDGER_SCHEMA,
  chapterCommit,
  decisionRecord,
  project,
  runCommand,
  type AuthorDecision,
  type ChapterLedger,
  type EntryInput,
  type LedgerEntry,
} from "@actalk/story-core";
import { readStoryTimeline, validateStoryTimeline, weekdayOfDay } from "../book/story-timeline.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import { buildLegacyMirror, MIRROR_FILES, serializeLegacyMirror } from "./build.js";
import { MIRROR_BACKUP_DIR, MIRROR_MARKER, mirrorIsStale, readMirrorVersion, syncLegacyMirror } from "./sync.js";
import { ensureBookOnCore } from "./ensure.js";

type Draft = LedgerEntry extends infer E ? (E extends LedgerEntry ? Omit<E, "id" | "review"> & { id?: string; review?: "auto" | "author" } : never) : never;
const q = "原句原句";

function ledger(chapter: number, drafts: Draft[]): ChapterLedger {
  return {
    schema: CHAPTER_LEDGER_SCHEMA,
    chapter,
    textSha256: "0".repeat(64),
    committedAt: "2026-10-18T00:00:00.000Z",
    origin: "commit",
    entries: drafts.map((draft, index) => ({ review: "auto", ...draft, id: draft.id ?? `c${chapter}-${index + 1}` }) as LedgerEntry),
  };
}

function sample() {
  const ledgers = [
    ledger(1, [
      { kind: "summary", text: "沈青禾进钟楼拿走钥匙", quote: q },
      { kind: "time", basis: "text", weekday: 1, timeOfDay: "傍晚", quote: "周二傍晚" },
      { kind: "presence", name: "沈青禾", nameUsed: "沈青禾", viewpoint: true, quote: q },
      { kind: "presence", name: "周守义", nameUsed: "老周", quote: q },
      { id: "f-key", kind: "fact", nature: "state", subject: "钥匙", attribute: "在哪", value: "钟箱里", text: "钥匙在钟箱里", quote: q },
      { id: "f-clock", kind: "fact", nature: "hard", subject: "钟", attribute: "停的时刻", value: "三点十五分", text: "钟停在三点十五分", quote: q, review: "author" },
      { id: "f-wrong", kind: "fact", nature: "event", text: "老周哭了", quote: q },
      { kind: "thread", thread: "t-clock", op: "open", type: "question", title: "钟为什么停", note: "钟停了", quote: "钟停在三点十五分" },
      { kind: "thread", thread: "t-well", op: "open", type: "intent", title: "去井边", note: "她决定去井边", quote: "她决定去井边" },
      { kind: "thread", thread: "g-truth", op: "open", type: "goal", title: "查清爷爷的死", note: "她要查清", quote: "她要查清" },
    ]),
    ledger(2, [
      { kind: "summary", text: "钥匙到了沈青禾手里", quote: q },
      { kind: "time", basis: "text", daysSincePrevious: 1, daysInChapter: 1, quote: "第二天" },
      { kind: "presence", name: "周守义", nameUsed: "周守义", quote: q },
      { kind: "fact", nature: "state", subject: "钥匙", attribute: "在哪", value: "沈青禾手里", text: "钥匙在沈青禾手里", quote: q },
      { kind: "thread", op: "advance", thread: "t-clock", note: "钟是被拨停的", quote: "钟是被拨停的" },
      { kind: "thread", op: "close", thread: "t-well", note: "去过井边了", quote: "去过井边了" },
    ]),
  ];
  const decisions: AuthorDecision[] = [
    { id: "d-1", at: "2026-10-18T00:00:00.000Z", type: "fact.retract", fact: "f-wrong" },
    { id: "d-2", at: "2026-10-18T00:00:00.000Z", type: "thread.weight", thread: "g-truth", weight: "major" },
  ];
  return { ledgers, projection: project({ ledgers, decisions, version: 7 }) };
}

describe("老格式镜像·生成", () => {
  it("时间线、日历、事实、线索、目标、事件都照老形状生成", () => {
    const { ledgers, projection } = sample();
    const mirror = buildLegacyMirror({
      projection,
      ledgers,
      characterIds: new Map([["沈青禾", "char-aaaaaa"], ["老周", "zhou"]]),
      chapterTitles: new Map([[1, "第1章 · 钟停"]]),
    });

    expect(mirror.timeline.entries).toEqual([
      { chapter: 1, day: 1, weekday: 1, timeOfDay: "傍晚", source: "declared", quote: "周二傍晚" },
      { chapter: 2, day: 2, daysSincePrevious: 1, daysInChapter: 1, source: "declared", quote: "第二天" },
    ]);
    // 老代码自己校验、自己推星期：一条不丢，第 2 天推成周三。
    const checked = validateStoryTimeline(JSON.parse(JSON.stringify(mirror.timeline)));
    expect(checked.dropped).toBe(0);
    expect(weekdayOfDay(checked.timeline, 2)).toBe(2);
    expect(mirror.calendar).toEqual({ currentStoryDay: 3, currentTimeOfDay: "unknown" });

    // 作者撤掉的那条不进老账本；被取代的带上取代信息；作者亲手点过的记 manual。
    expect(mirror.facts.facts.map((fact) => fact.id)).toEqual(["f-key", "f-clock", "c2-4"]);
    expect(mirror.facts.facts[0]).toMatchObject({ kind: "state", supersededByChapter: 2, supersededByFactId: "c2-4", effectiveFromChapter: 1, source: "auto" });
    expect(mirror.facts.facts[1]).toMatchObject({ kind: "hard", subject: "钟", attribute: "停的时刻", value: "三点十五分", source: "manual" });
    expect(mirror.facts.facts[1]).not.toHaveProperty("supersededByChapter");

    expect(mirror.threads.threads).toEqual([
      { id: "t-clock", type: "lead", title: "钟为什么停", status: "touched", firstSeenChapter: 1, lastTouchedChapter: 2, evidence: ["钟停在三点十五分", "钟是被拨停的"] },
      { id: "t-well", type: "intent", title: "去井边", status: "done", firstSeenChapter: 1, lastTouchedChapter: 2, evidence: ["她决定去井边", "去过井边了"] },
    ]);
    expect(mirror.goals.goals).toEqual([
      { id: "g-truth", title: "查清爷爷的死", status: "active", scope: "main_arc", firstSeenChapter: 1, lastTouchedChapter: 1, evidence: ["她要查清"] },
    ]);
    expect(mirror.hooks).toEqual({ hooks: [] });

    const [first, second] = mirror.events;
    expect(first).toMatchObject({ id: "ch0001-001", chapter: 1, summary: "沈青禾进钟楼拿走钥匙", participants: ["char-aaaaaa", "zhou"] });
    expect(first?.effects?.semanticSummary).toMatchObject({
      chapterTitle: "第1章 · 钟停",
      mainEvent: "沈青禾进钟楼拿走钥匙",
      presentCharacterNames: ["沈青禾", "周守义"],
      characterAliases: [{ name: "周守义", alias: "老周" }],
      viewpointCharacter: "沈青禾",
      decision: "她决定去井边",
      mentionedHooks: [],
      locations: [],
    });
    // 撤掉的事件不进「本章要事」。
    expect(first?.effects?.semanticSummary).not.toHaveProperty("keyEvents");
    // 第 2 章收的是打算（不是悬念），不算「发现」。
    expect(second?.effects?.semanticSummary).toMatchObject({ chapterTitle: "第2章" });
    expect(second?.effects?.semanticSummary).not.toHaveProperty("discovery");
    expect(second?.effects?.semanticSummary).not.toHaveProperty("characterAliases");
  });

  it("同样的真相生成一模一样的文件，格式和老代码写盘的一样", () => {
    const a = sample();
    const b = sample();
    const input = { characterIds: new Map<string, string>(), chapterTitles: new Map<number, string>() };
    const first = serializeLegacyMirror(buildLegacyMirror({ ...input, ...a }));
    const second = serializeLegacyMirror(buildLegacyMirror({ ...input, ...b }));
    expect(first).toEqual(second);
    expect(first.map(([file]) => file)).toEqual(Object.values(MIRROR_FILES));
    for (const [, content] of first) expect(content.endsWith("}\n") || content.endsWith("]\n")).toBe(true);
  });

  it("投影里「停了好几章」的线索在老格式里照样开着（老格式的 stale 是不再追踪，老代码会藏掉）", () => {
    const ledgers = [
      ledger(1, [{ kind: "thread", thread: "t-old", op: "open", type: "question", title: "井里有什么", note: "井里有声音", quote: q }]),
      ledger(9, [{ kind: "summary", text: "过了很久", quote: q }]),
    ];
    const projection = project({ ledgers, decisions: [] });
    expect(projection.threads[0]?.status).toBe("stale");
    const mirror = buildLegacyMirror({ projection, ledgers, characterIds: new Map(), chapterTitles: new Map() });
    expect(mirror.threads.threads[0]).toMatchObject({ id: "t-old", status: "open" });
  });

  it("本章收掉的悬念记成老格式的「发现」（并掉的线索按并入的那条算）", () => {
    const ledgers = [
      ledger(1, [
        { kind: "thread", thread: "t-door", op: "open", type: "question", title: "门外是谁", note: "有人敲门", quote: q },
        { kind: "thread", thread: "t-door2", op: "open", type: "question", title: "谁在敲门", note: "又有人敲门", quote: q },
      ]),
      ledger(2, [{ kind: "thread", thread: "t-door2", op: "close", note: "门外是老周", quote: q }]),
    ];
    const decisions: AuthorDecision[] = [{ id: "d-1", at: "2026-10-18T00:00:00.000Z", type: "thread.merge", from: ["t-door2"], into: "t-door" }];
    const projection = project({ ledgers, decisions });
    const mirror = buildLegacyMirror({ projection, ledgers, characterIds: new Map(), chapterTitles: new Map() });
    expect(mirror.events[1]?.effects?.semanticSummary).toMatchObject({ discovery: "门外是老周" });
    expect(mirror.threads.threads.map((thread) => thread.id)).toEqual(["t-door"]);
  });

  it("空书：每个文件都是老代码认的空样子", () => {
    const mirror = buildLegacyMirror({ projection: project({ ledgers: [], decisions: [] }), ledgers: [], characterIds: new Map(), chapterTitles: new Map() });
    expect(mirror).toEqual({
      timeline: { schemaVersion: 1, entries: [] },
      calendar: { currentStoryDay: 1, currentTimeOfDay: "unknown" },
      facts: { version: "v0", facts: [] },
      threads: { threads: [] },
      hooks: { hooks: [] },
      goals: { goals: [] },
      events: [],
    });
  });
});

const CH1 = "# 第1章 · 钟停\n\n周二傍晚，钟停在三点十五分。沈青禾推开钟楼的门，老周没有拦她。\n\n她在钟箱里摸到一把铜钥匙，揣进了包里。";
const CH2 = "# 第2章 · 外乡人\n\n第二天上午，外乡人又来了。老周站在门口，没让他进。\n\n沈青禾把钥匙锁进铜盒。";
const CH1_ENTRIES: EntryInput[] = [
  { kind: "summary", review: "auto", text: "沈青禾进钟楼拿走钥匙", quote: "她在钟箱里摸到一把铜钥匙" },
  { kind: "time", review: "auto", basis: "text", weekday: 1, timeOfDay: "傍晚", quote: "周二傍晚" },
  { kind: "presence", review: "auto", name: "沈青禾", nameUsed: "沈青禾", viewpoint: true, quote: "沈青禾推开钟楼的门" },
  { kind: "presence", review: "auto", name: "周守义", nameUsed: "老周", quote: "老周没有拦她" },
  { kind: "fact", review: "auto", nature: "state", subject: "铜钥匙", attribute: "在哪", value: "沈青禾包里", text: "铜钥匙在沈青禾包里", quote: "揣进了包里" },
  { kind: "thread", review: "auto", op: "open", type: "question", title: "钟为什么停", note: "钟停了", quote: "钟停在三点十五分" },
];
const CH2_ENTRIES: EntryInput[] = [
  { kind: "summary", review: "auto", text: "外乡人又来，钥匙锁进铜盒", quote: "外乡人又来了" },
  { kind: "time", review: "auto", basis: "text", daysSincePrevious: 1, timeOfDay: "上午", quote: "第二天上午" },
  { kind: "presence", review: "auto", name: "周守义", nameUsed: "老周", quote: "老周站在门口" },
  { kind: "fact", review: "auto", nature: "state", subject: "铜钥匙", attribute: "在哪", value: "铜盒里", text: "铜钥匙锁进了铜盒", quote: "沈青禾把钥匙锁进铜盒" },
];
const author = (key: string) => ({ caller: "author" as const, idempotencyKey: key });

describe("老格式镜像·写盘", () => {
  let book: string;
  beforeEach(async () => {
    book = await makeHomeTempDir("legacy-mirror-");
  });
  afterEach(async () => {
    await rm(book, { recursive: true, force: true });
  });

  it("还没导入新核心的书不写；写完带版本号，老代码读得到；没变的文件不重写", async () => {
    expect(await syncLegacyMirror(book)).toMatchObject({ ok: false, code: "not_imported" });

    // 书里原有的老文件：第一次生成前原样留一份。
    await mkdir(join(book, "story"), { recursive: true });
    await writeFile(join(book, "story/threads.json"), "{\"threads\":[]}");
    await mkdir(join(book, "characters/zhou"), { recursive: true });
    await writeFile(join(book, "characters/zhou/profile.json"), JSON.stringify({ id: "zhou", name: "周守义" }));
    await writeFile(join(book, "characters/broken.json"), "x");
    await mkdir(join(book, "characters/bad"), { recursive: true });
    await writeFile(join(book, "characters/bad/profile.json"), "{坏的");

    const commit = await runCommand(book, chapterCommit, { chapter: 1, text: CH1, entries: CH1_ENTRIES }, author("k1"));
    expect(commit.ok).toBe(true);
    expect(await mirrorIsStale(book)).toBe(true);

    const first = await syncLegacyMirror(book);
    expect(first).toMatchObject({ ok: true, version: 1, backedUp: ["story/threads.json"], unreadable: ["characters/bad/profile.json"] });
    if (first.ok) expect([...first.written].sort()).toEqual(Object.values(MIRROR_FILES).sort());
    expect(await readFile(join(book, MIRROR_BACKUP_DIR, "story/threads.json"), "utf-8")).toBe("{\"threads\":[]}");
    expect(await readMirrorVersion(book)).toBe(1);
    expect(await mirrorIsStale(book)).toBe(false);
    const events = JSON.parse(await readFile(join(book, MIRROR_FILES.events), "utf-8"));
    expect(events[0]).toMatchObject({ participants: ["zhou"], effects: { semanticSummary: { chapterTitle: "第1章 · 钟停" } } });

    const { timeline, derived } = await readStoryTimeline(book);
    expect(derived).toBe(false);
    expect(timeline.entries).toEqual([{ chapter: 1, day: 1, weekday: 1, timeOfDay: "傍晚", source: "declared", quote: "周二傍晚" }]);

    // 再同步一遍：什么都不重写。
    const factsStat = await stat(join(book, MIRROR_FILES.facts));
    const again = await syncLegacyMirror(book);
    expect(again).toMatchObject({ ok: true, version: 1, written: [], backedUp: [] });
    expect((await stat(join(book, MIRROR_FILES.facts))).mtimeMs).toBe(factsStat.mtimeMs);

    // 第 2 章 + 作者裁定之后：只改变了的文件；备份不再动。
    expect((await runCommand(book, chapterCommit, { chapter: 2, text: CH2, entries: CH2_ENTRIES }, author("k2"))).ok).toBe(true);
    const threadId = JSON.parse(await readFile(join(book, MIRROR_FILES.threads), "utf-8")).threads[0].id as string;
    expect((await runCommand(book, decisionRecord, { type: "thread.close", thread: threadId, chapter: 2 }, author("k3"))).ok).toBe(true);
    const third = await syncLegacyMirror(book);
    expect(third).toMatchObject({ ok: true, version: 3, backedUp: [] });
    if (third.ok) expect(third.written).not.toContain(MIRROR_FILES.hooks);
    const threads = JSON.parse(await readFile(join(book, MIRROR_FILES.threads), "utf-8"));
    expect(threads.threads[0]).toMatchObject({ status: "done", lastTouchedChapter: 1 });
    const facts = JSON.parse(await readFile(join(book, MIRROR_FILES.facts), "utf-8"));
    expect(facts.facts.map((fact: { supersededByChapter?: number }) => fact.supersededByChapter)).toEqual([2, undefined]);
    expect(JSON.parse(await readFile(join(book, "time/calendar.json"), "utf-8"))).toEqual({ currentStoryDay: 2, currentTimeOfDay: "unknown" });
    expect(JSON.parse(await readFile(join(book, MIRROR_MARKER), "utf-8"))).toEqual({ schema: "legacy-mirror/1", version: 3 });
  });

  it("同一本书同时同步几次：排队跑，写完之后那次留下最新版本", async () => {
    expect((await runCommand(book, chapterCommit, { chapter: 1, text: CH1, entries: CH1_ENTRIES }, author("k1"))).ok).toBe(true);
    const pending = [syncLegacyMirror(book), syncLegacyMirror(book)];
    expect((await runCommand(book, chapterCommit, { chapter: 2, text: CH2, entries: CH2_ENTRIES }, author("k2"))).ok).toBe(true);
    pending.push(syncLegacyMirror(book));
    const results = await Promise.all(pending);
    // 正赶上第 2 章在写的那几次可以如实说「没读稳」；第 2 章写完之后那次必须拿到最新的。
    for (const result of results) expect(result.ok || result.code === "unsettled").toBe(true);
    expect(results.at(-1)).toMatchObject({ ok: true, version: 2 });
    expect(await readMirrorVersion(book)).toBe(2);
    const events = JSON.parse(await readFile(join(book, MIRROR_FILES.events), "utf-8"));
    expect(events).toHaveLength(2);
  });
});

describe("开书时收老定稿链的事务残留（重构 P7：读路径不再收）", () => {
  let book: string;
  beforeEach(async () => {
    book = await makeHomeTempDir("legacy-tx-open-");
  });
  afterEach(async () => {
    await rm(book, { recursive: true, force: true });
  });

  it("老版本崩溃留下的 staged 事务：开书那步还原备份、标 recovered", async () => {
    const target = join(book, "story", "hooks.json");
    await mkdir(join(book, "story"), { recursive: true });
    await writeFile(target, "崩溃写了一半", "utf-8");
    const txDir = join(book, ".story-engine-tx", "commit-chapter-0001");
    await mkdir(join(txDir, "backups", "story"), { recursive: true });
    const original = "{\"hooks\":[]}\n";
    await writeFile(join(txDir, "backups", "story", "hooks.json"), original, "utf-8");
    await writeFile(join(txDir, "manifest.json"), JSON.stringify({
      version: 2,
      chapter: 1,
      createdAt: "2026-07-13T00:00:00.000Z",
      files: ["story/hooks.json"],
      backups: [{
        relativePath: "story/hooks.json",
        existed: true,
        backupPath: "backups/story/hooks.json",
        sha256: createHash("sha256").update(original, "utf-8").digest("hex"),
      }],
      status: "staged",
    }), "utf-8");

    expect(await ensureBookOnCore(book)).toMatchObject({ ok: true });

    expect(await readFile(target, "utf-8")).toBe(original);
    expect(JSON.parse(await readFile(join(txDir, "manifest.json"), "utf-8")).status).toBe("recovered");
  });
});
