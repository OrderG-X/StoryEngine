import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectBook } from "../index.js";
import { runCommand } from "../commands/runner.js";
import { timeAuditPlan } from "../commands/time-audit.js";
import type { CommandOutcome, CommandSuccess } from "../commands/types.js";
import { readAllLedgers } from "../store/book.js";
import { bookImport, type BookImportResult } from "./command.js";

let book: string;
beforeEach(async () => {
  book = await mkdtemp(join(tmpdir(), "story-core-import-"));
});
afterEach(async () => {
  await rm(book, { recursive: true, force: true });
});

async function put(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(join(book, path)), { recursive: true });
  await writeFile(join(book, path), typeof value === "string" ? value : JSON.stringify(value));
}

const NOW = new Date("2026-10-17T12:00:00.000Z");
const run = (key = "import") => runCommand(book, bookImport, {}, { caller: "author", idempotencyKey: key, now: () => NOW });

function ok(outcome: CommandOutcome<BookImportResult>): CommandSuccess<BookImportResult> {
  if (!outcome.ok) throw new Error(`${outcome.code} ${outcome.message}`);
  return outcome;
}

/** 一本最小的老书：每条映射规则都有一处用到。 */
async function legacyBook(): Promise<void> {
  await put("chapters/0001.md", "# 第1章\n\n周二傍晚，阿甲把钥匙交给乙。钥匙在乙手里。甲今年三十岁。");
  await put("chapters/0002.md", "# 第2章\n\n两天后，乙把钥匙锁进铜盒。乙说：「谁也别动它。」");
  await put("chapters/0003.md", "# 第3章\n\n前一天夜里的事，乙还记得。甲把账本烧了。");
  await put("story/fact-ledger.json", {
    version: "v0",
    facts: [
      { id: "fact-1-0", chapter: 1, text: "阿甲把钥匙交给乙", source: "auto" },
      { id: "fact-1-1", chapter: 1, text: "钥匙在乙手里", source: "auto", kind: "state", subject: "钥匙", attribute: "在哪", value: "乙手里", quote: "钥匙在乙手里", supersededByChapter: 2, supersededByFactId: "fact-2-0" },
      { id: "fact-1-2", chapter: 1, text: "甲三十岁", source: "manual", kind: "hard", subject: "甲", attribute: "年纪" },
      { id: "fact-1-3", chapter: 1, text: "乙是甲的表弟", source: "auto", quote: "乙是甲的表弟", supersededByChapter: 3 },
      { id: "fact-2-0", chapter: 2, text: "钥匙在铜盒里", source: "auto", kind: "state", subject: "钥匙", attribute: "在哪", value: "铜盒里", quote: "乙把钥匙锁进铜盒" },
      { id: "fact-9-0", chapter: 9, text: "没有正文的章", source: "auto" },
      { id: "fact-x", chapter: 1 },
    ],
  });
  await put("story/threads.json", {
    threads: [
      { id: "lead-a", type: "lead", title: "钥匙开什么", status: "open", firstSeenChapter: 1, lastTouchedChapter: 2, evidence: ["乙把钥匙锁进铜盒"] },
      { id: "intent-b", type: "intent", title: "乙要守住铜盒", status: "done", firstSeenChapter: 2, lastTouchedChapter: 3, evidence: ["谁也别动它"] },
    ],
  });
  await put("story/hooks.json", {
    hooks: [
      { id: "hook-c", title: "账本里写了什么", description: "账本的下落", status: "resolved", firstSeenChapter: 1, resolvedAtChapter: 3, evidence: ["甲把账本烧了"] },
      { id: "hook-d", title: "门外是谁", status: "abandoned", firstSeenChapter: 2, lastTouchedChapter: 2 },
    ],
  });
  await put("story/arc-goals.json", { goals: [{ id: "arc-e", title: "查清钥匙来历", status: "touched", scope: "main_arc", firstSeenChapter: 1, lastTouchedChapter: 3 }] });
  await put("story/timeline.json", {
    schemaVersion: 1,
    entries: [
      { chapter: 1, day: 1, weekday: 1, timeOfDay: "傍晚", source: "declared", quote: "周二傍晚" },
      { chapter: 2, day: 3, source: "plan" },
      { chapter: 3, day: 2, source: "fallback" },
    ],
  });
  await put("timeline/events.json", [
    { id: "ch0001-001", chapter: 1, summary: "阿甲交出钥匙", participants: ["char-a", "char-zz"] },
    { id: "ch0002-001", chapter: 2, summary: "乙锁起钥匙", participants: ["char-b"] },
  ]);
  await put("characters/char-a/profile.json", { id: "char-a", name: "甲" });
  await put("story/character-bible.json", { version: "v0", characters: [{ id: "char-b", name: "乙", role: "配角" }] });
  await put("story/character-matrix.json", { version: "v0", entries: [{ name: "乙", appearances: [{ chapter: 1, evidence: "阿甲把钥匙交给乙" }] }] });
  await put(".story-engine-ui/alias-tables.json", {
    version: "v0",
    byEntity: { "char-a": { canonicalName: "甲", primary: "甲", aliases: ["甲", "阿甲", "甲哥"], generated: ["甲哥"], type: "character" } },
    conflicts: [],
  });
}

describe("导入老书", () => {
  it("每类老数据按规则变成账单；坏的、没正文的跳过并记下", async () => {
    await legacyBook();
    const { result } = ok(await run());
    expect(result.counts).toMatchObject({
      chapters: 3,
      facts: 5,
      threadsOpened: 5,
      threadsClosed: 3,
      times: 3,
      summaries: 2,
      expiries: 1,
      factsWithoutKind: 2,
      quotesDropped: 1,
    });
    expect(result.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: "story/fact-ledger.json", item: 6 }),
      expect.objectContaining({ file: "story/fact-ledger.json", item: 5, reason: "第 9 章没有正文" }),
      expect.objectContaining({ file: "timeline/events.json", reason: "有一个出场人物找不到名字" }),
    ]));
    expect(result.adjusted.map((item) => item.item)).toEqual(expect.arrayContaining(["fact-1-2", "第 3 章"]));

    const view = await projectBook(book);
    // 事实：作废链接上；手动作废的从第 3 章起不成立；缺值的不会变事实按发生过的事记。
    const byId = Object.fromEntries(view.facts.map((fact) => [fact.id, fact]));
    expect(byId["fact-1-1"]).toMatchObject({ status: "superseded", supersededAt: 2, supersededBy: "fact-2-0" });
    expect(byId["fact-1-3"]).toMatchObject({ status: "superseded", supersededAt: 3 });
    expect(byId["fact-1-2"]).toMatchObject({ nature: "event", review: "author" });
    expect(byId["fact-1-3"]?.quote).toBeUndefined();
    // 线索：开、推进、收；放弃的也收；目标没完成就还开着。
    const threads = Object.fromEntries(view.threads.map((thread) => [thread.id, thread]));
    expect(threads["lead-a"]).toMatchObject({ type: "question", status: "active", lastTouchedAt: 2 });
    expect(threads["intent-b"]).toMatchObject({ type: "intent", status: "closed", closedAt: 3 });
    expect(threads["hook-c"]).toMatchObject({ status: "closed", closedAt: 3 });
    expect(threads["hook-d"]?.touches.at(-1)?.note).toBe("旧账：放弃了");
    expect(threads["arc-e"]).toMatchObject({ type: "goal", status: "active" });
    // 时间：老时间线换成离上一章几天（旧账推定，不算已识别）；估的那章不知道，原值留着给作者看。
    expect(view.chapters.map(({ time }) => [time.start, time.basis, time.legacyDay])).toEqual([
      [{ lo: 1, hi: 1 }, "presumed", undefined],
      [{ lo: 3, hi: 3 }, "presumed", undefined],
      [undefined, "unknown", { day: 2, reason: "estimated" }],
    ]);
    expect(view.chapters[0]).toMatchObject({ time: { weekday: 1, timeOfDay: "傍晚" }, summary: "阿甲交出钥匙" });
    // 新导入就按盘点同一条规则记的：开书盘点没有要改的。
    expect(await timeAuditPlan(book)).toBeUndefined();
    // 出场：人物 id 换成名字；别称表里人工加的别称记上，机器生成的不记。
    expect(view.cast.find((member) => member.name === "甲")).toMatchObject({ aliases: ["阿甲"], chapters: [1] });
    expect(view.chapters[0]?.present).toEqual(["甲", "乙"]);
    expect(view.dangling).toEqual([]);
  });

  it("已经有账单的书不再导入；老文件一个字节都不动", async () => {
    await legacyBook();
    const before = await readFile(join(book, "story/fact-ledger.json"), "utf-8");
    ok(await run("a"));
    expect(await run("b")).toMatchObject({ ok: false, code: "already_imported" });
    expect(await readFile(join(book, "story/fact-ledger.json"), "utf-8")).toBe(before);
  });

  it("删掉 ledger 再导一遍，账单逐字节相同", async () => {
    await legacyBook();
    ok(await run("a"));
    const read = async () => {
      const files = (await readdir(join(book, "ledger/chapters"))).sort();
      return Promise.all(files.map((file) => readFile(join(book, "ledger/chapters", file), "utf-8")));
    };
    const first = await read();
    const decisions = await readFile(join(book, "ledger/decisions.json"), "utf-8");
    await rm(join(book, "ledger"), { recursive: true });
    ok(await run("b"));
    expect(await read()).toEqual(first);
    expect(await readFile(join(book, "ledger/decisions.json"), "utf-8")).toBe(decisions);
  });

  it("老文件坏了就停下，说清是哪个文件；没有正文就不导", async () => {
    expect(await run("empty")).toMatchObject({ ok: false, code: "no_chapters" });
    await put("chapters/0001.md", "正文正文正文");
    await put("story/threads.json", "{坏");
    const outcome = await run("broken");
    expect(outcome).toMatchObject({ ok: false, code: "book_file_invalid" });
    expect(outcome.ok ? "" : outcome.message).toContain("story/threads.json");
    expect(await readAllLedgers(book)).toEqual([]);
  });
  it("没有时间线文件：照老代码从章纲推天数；老账的 stale 收掉；主线目标记成重要", async () => {
    for (const chapter of [1, 2, 3, 4]) await put(`chapters/000${chapter}.md`, `# 第${chapter}章\n\n第${chapter}章的正文，写了一些事。`);
    await put("drafts/plans/chapter-0002.json", { storyDay: 5 });
    await put("drafts/plans/chapter-0003.json", { storyDay: "七" });
    await put("story/threads.json", {
      threads: [
        { id: "lead-junk", type: "lead", title: "清理掉的线索", status: "stale", firstSeenChapter: 1, lastTouchedChapter: 2 },
        { id: "lead-open", type: "lead", title: "开着的线索", status: "open", firstSeenChapter: 1, lastTouchedChapter: 1 },
      ],
    });
    await put("story/arc-goals.json", {
      goals: [
        { id: "goal-main", title: "主线目标", status: "touched", scope: "main_arc", firstSeenChapter: 1, lastTouchedChapter: 3 },
        { id: "goal-mini", title: "阶段目标", status: "stale", scope: "mini_arc", firstSeenChapter: 1, lastTouchedChapter: 1 },
      ],
    });
    const outcome = ok(await run());
    expect(outcome.result.counts).toMatchObject({ majorThreads: 1 });
    const view = await projectBook(book);
    // 老代码推的：第 1 章没章纲 → 第 1 天（估的）；第 2 章章纲第 5 天（差值相对估的那章）；第 3 章章纲写坏了 → 上一章 +1、第 4 章 +1（估的）。
    // 都不可信：原值留着；第 1 章是全书起点照样推定第 1 天，后面的天数不知道。
    expect(view.chapters.map(({ time }) => [time.start, time.legacyDay])).toEqual([
      [{ lo: 1, hi: 1 }, { day: 1, reason: "estimated" }],
      [undefined, { day: 5, reason: "after_bad" }],
      [undefined, { day: 6, reason: "estimated" }],
      [undefined, { day: 7, reason: "estimated" }],
    ]);
    const byId = new Map(view.threads.map((thread) => [thread.id, thread]));
    expect(byId.get("lead-junk")).toMatchObject({ status: "closed", closedAt: 2 });
    expect(byId.get("lead-junk")?.touches.at(-1)?.note).toBe("旧账：不再追踪了");
    expect(byId.get("lead-open")?.status).not.toBe("closed");
    expect(byId.get("goal-main")).toMatchObject({ weight: "major" });
    expect(byId.get("goal-mini")).toMatchObject({ status: "closed", weight: "normal" });
  });
});
