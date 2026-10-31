// 写作版本 P3a 设计 2.6：「天数盘点」——以前导入老书时记进账的不可信天数改成「不知道」。
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newLedger, storeLegacyTime, type LegacyTimeDraft } from "../ledger/entries.js";
import { projectBook } from "../index.js";
import type { ChapterLedger } from "../schema/ledger.js";
import { readChapterLedger } from "../store/book.js";
import { chapterLedgerPath, chapterTextPath } from "../store/paths.js";
import { runCommand } from "./runner.js";
import { timeAudit, timeAuditKey, timeAuditPlan } from "./time-audit.js";

let book: string;
beforeEach(async () => {
  book = await mkdtemp(join(tmpdir(), "story-core-time-audit-"));
});
afterEach(async () => {
  await rm(book, { recursive: true, force: true });
});

async function put(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(join(book, path)), { recursive: true });
  await writeFile(join(book, path), typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
}

/** P2b 导入老书时记下的那种账：没有 P3 时间格式标记，时间按当年的规则存。 */
function imported(chapter: number, draft: Partial<LegacyTimeDraft>, origin: ChapterLedger["origin"] = "import"): ChapterLedger {
  const parsed = newLedger({
    chapter,
    textSha256: "0".repeat(64),
    committedAt: "2026-10-01T00:00:00.000Z",
    origin,
    legacyTime: true,
    entries: storeLegacyTime({ review: "auto", basis: "text", ...draft }, `c${chapter}-1`, { evidence: [], evidenceStatus: "none" }, "native"),
  });
  if (!parsed.success) throw parsed.error;
  return parsed.data;
}

async function seed(ledgers: ChapterLedger[]): Promise<void> {
  for (const ledger of ledgers) {
    await put(chapterTextPath(ledger.chapter), `# 第${ledger.chapter}章\n\n第${ledger.chapter}章的正文。`);
    await put(chapterLedgerPath(ledger.chapter), ledger);
  }
}

const author = (key: string) => ({ caller: "author" as const, idempotencyKey: key });
async function audit(key = "a") {
  const plan = await timeAuditPlan(book);
  if (!plan) throw new Error("没有要盘的");
  return runCommand(book, timeAudit, { digest: plan.digest }, { ...author(timeAuditKey(plan.digest)), idempotencyKey: `${timeAuditKey(plan.digest)}:${key}` });
}

describe("天数盘点", () => {
  // 老时间线：第 3 章「比上一章早」当年被 P2b 记成了作者定的第 2 天（伪裁定）；第 5 章是估的。
  const TIMELINE = {
    schemaVersion: 1,
    entries: [
      { chapter: 1, day: 1, source: "declared" },
      { chapter: 2, day: 3, source: "plan" },
      { chapter: 3, day: 2, source: "plan" },
      { chapter: 4, day: 5, source: "declared" },
      { chapter: 5, day: 6, source: "fallback" },
      { chapter: 6, day: 7, source: "declared" },
      { chapter: 7, day: 9, source: "author" },
    ],
  };
  const LEDGERS = () => [
    imported(1, { daysSincePrevious: 1 }),
    imported(2, { basis: "judged", daysSincePrevious: 2 }),
    imported(3, { basis: "author", day: 2 }),
    imported(4, { daysSincePrevious: 3, daysInChapter: 1 }),
    imported(5, { basis: "estimated", daysSincePrevious: 0 }),
    imported(6, { daysSincePrevious: 1 }),
    imported(7, { basis: "author", day: 9 }),
  ];

  it("伪裁定、估的、紧跟它们的下一章改成不知道，原值留着；真作者定的不动；先存档、能撤销的作者档命令", async () => {
    await seed(LEDGERS());
    await put("story/timeline.json", TIMELINE);
    const plan = await timeAuditPlan(book);
    expect(plan?.chapters).toEqual([3, 4, 5, 6]);
    const outcome = await audit();
    expect(outcome).toMatchObject({ ok: true, result: { chapters: [3, 4, 5, 6], unproven: [] } });

    const three = await readChapterLedger(book, 3);
    expect(three?.entries).toMatchObject([{ id: "c3-1", relation: "unknown", appliesTo: "chapterStart", legacy: { relation: "at", day: 2, reason: "not_author" } }]);
    // 第 4 章本章内过的那一天（结尾那条）一起去掉：相对的是不可信的开头。
    expect((await readChapterLedger(book, 4))?.entries.map((entry) => entry.id)).toEqual(["c4-1"]);
    expect((await readChapterLedger(book, 7))?.entries).toMatchObject([{ relation: "at", day: 9 }]);

    const view = await projectBook(book);
    expect(view.chapters.map(({ time }) => [time.start?.lo, time.legacyDay?.reason])).toEqual([
      [1, undefined], [3, undefined], [undefined, "not_author"], [undefined, "after_bad"], [undefined, "estimated"], [undefined, "after_bad"], [9, undefined],
    ]);
    // 改过的不会再被盘出来。
    expect(await timeAuditPlan(book)).toBeUndefined();
  });

  it("时间线文件不在了（照章纲现推）：记成作者定的证明不了，改成不知道、列给作者确认", async () => {
    await seed([imported(1, { daysSincePrevious: 0 }), imported(2, { basis: "author", day: 4 }), imported(3, { daysSincePrevious: 1 })]);
    await put("drafts/plans/chapter-0002.json", { storyDay: 4 });
    const outcome = await audit();
    expect(outcome).toMatchObject({ ok: true, result: { unproven: [2] } });
    expect((await readChapterLedger(book, 2))?.entries).toMatchObject([{ relation: "unknown", legacy: { relation: "at", day: 4, reason: "unproven" } }]);
  });

  it("只盘导入来的旧账：定稿的、重记过的（P3 新账）、账待记的都不碰；没有要盘的就不出命令", async () => {
    await seed([imported(1, { basis: "estimated" }, "commit"), imported(2, { basis: "estimated" }, "reread")]);
    await put("story/timeline.json", { schemaVersion: 1, entries: [{ chapter: 1, day: 1, source: "fallback" }, { chapter: 2, day: 2, source: "fallback" }] });
    expect(await timeAuditPlan(book)).toBeUndefined();
    expect(await runCommand(book, timeAudit, { digest: "0".repeat(64) }, author("x"))).toMatchObject({ ok: false, code: "nothing_to_audit" });
  });

  it("开书之后账又改过：摘要对不上，不改、如实说；AI 调不动", async () => {
    await seed(LEDGERS());
    await put("story/timeline.json", TIMELINE);
    const plan = await timeAuditPlan(book);
    await put(chapterLedgerPath(6), imported(6, { daysSincePrevious: 2 }));
    const before = await readFile(join(book, chapterLedgerPath(3)), "utf-8");
    expect(await runCommand(book, timeAudit, { digest: plan!.digest }, author("y"))).toMatchObject({ ok: false, code: "changed_since_scan" });
    expect(await readFile(join(book, chapterLedgerPath(3)), "utf-8")).toBe(before);
    const fresh = await timeAuditPlan(book);
    expect(await runCommand(book, timeAudit, { digest: fresh!.digest }, { caller: "ai", idempotencyKey: "z" })).toMatchObject({ ok: false });
  });
});
