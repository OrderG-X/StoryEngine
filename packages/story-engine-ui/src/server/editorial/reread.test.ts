// @vitest-environment node
import { rm } from "node:fs/promises";
import { bookImportText, projectBook, readChapterLedger, runCommand } from "@actalk/story-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelCallError } from "../lib/ai-errors.js";
import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import { readReadersCatchUpStatus, runInReaderCatchUpQueue } from "./catch-up.js";
import { resumeBackgroundReading } from "./index.js";
import { setReaderBackfillHandler, type ReaderBackfillRequest } from "../lib/reader-backfill.js";
import type { BrainCallModel } from "./reader-window.js";
import { beginReread, isRereadActive, REREAD_ATTEMPTS, runReread } from "./reread.js";
import { readRereadState, rereadBlocker, rereadEtaMinutes, writeRereadState } from "./reread-state.js";

const CHAPTERS = [
  { title: "钟停", body: "钟停在三点十五分。沈青禾推开钟楼的门，老周没有拦她。" },
  { title: "外乡人", body: "第二天上午，外乡人又来了。老周说他今年七十了。" },
  { title: "还钥匙", body: "沈青禾把钥匙还给了老周。" },
];

const LEDGERS: Record<number, unknown> = {
  1: {
    summary: { text: "沈青禾进了钟楼", quote: "沈青禾推开钟楼的门" },
    presence: [{ name: "沈青禾", nameUsed: "沈青禾", quote: "沈青禾推开钟楼的门" }],
    facts: [{ nature: "hard", subject: "周守义", attribute: "年纪", value: "六十", text: "老周六十岁", quote: "老周没有拦她" }],
    threads: [{ op: "open", type: "question", title: "钟为什么停", note: "钟停了", quote: "钟停在三点十五分" }],
  },
  2: {
    summary: { text: "外乡人又来", quote: "外乡人又来了" },
    // 和第 1 章「不会变」的事实对不上：定稿时默认不写、要作者勾；通读没人勾，不写。
    facts: [{ nature: "hard", subject: "周守义", attribute: "年纪", value: "七十", text: "老周七十岁", quote: "老周说他今年七十了" }],
    threads: [{ op: "advance", thread: "T1", note: "外乡人又来", quote: "外乡人又来了" }],
  },
  3: { summary: { text: "钥匙还了", quote: "沈青禾把钥匙还给了老周" } },
};

/** 假记账员：要 JSON 的是交账单（看是哪一章），其余是写笔记。 */
function fakeKeeper(options: { readonly failChapter?: number; readonly failTimes?: number; readonly error?: () => Error } = {}): BrainCallModel & { calls: number; ledgerCalls: number } {
  let failed = 0;
  const call = (async (messages, callOptions) => {
    call.calls += 1;
    if (!callOptions.json) return "笔记：老周＝周守义。";
    call.ledgerCalls += 1;
    const task = messages.at(-1)?.content ?? "";
    const chapter = [1, 2, 3].find((n) => task.includes(`【第 ${n} 章 正文`)) ?? 0;
    if (chapter === options.failChapter && failed < (options.failTimes ?? Infinity)) {
      failed += 1;
      throw options.error?.() ?? new Error("服务商 502");
    }
    return JSON.stringify(LEDGERS[chapter] ?? {});
  }) as BrainCallModel & { calls: number; ledgerCalls: number };
  call.calls = 0;
  call.ledgerCalls = 0;
  return call;
}

let book: string;
beforeEach(async () => {
  book = await makeHomeTempDir("reread-");
  const imported = await runCommand(book, bookImportText, { chapters: CHAPTERS }, { caller: "author", idempotencyKey: "import" });
  if (!imported.ok) throw new Error(imported.message);
});
afterEach(async () => {
  await rm(book, { recursive: true, force: true });
});

describe("通读记账", () => {
  it("从第 1 章起一章一章记：账单换成通读记的，后一章推进前一章的线索；会改前文不会变的事实不写", async () => {
    await beginReread(book, 3);
    const onDone = vi.fn();
    await runReread(book, { callModel: fakeKeeper(), onDone });
    expect(onDone).toHaveBeenCalledWith(3);
    const state = await readRereadState(book);
    expect(state).toMatchObject({ status: "done", done: 3, total: 3 });
    expect(state!.skipped).toBeGreaterThanOrEqual(1);
    for (const chapter of [1, 2, 3]) expect((await readChapterLedger(book, chapter))?.origin).toBe("reread");
    const ch2 = await readChapterLedger(book, 2);
    expect(ch2?.entries.some((entry) => entry.kind === "fact")).toBe(false);
    const view = await projectBook(book);
    expect(view.threads[0]).toMatchObject({ title: "钟为什么停", lastTouchedAt: 2 });
    expect(view.facts.find((fact) => fact.subject === "周守义")?.value).toBe("六十");
    expect(await rereadBlocker(book, "核账")).toBeUndefined();
  });

  it("一章连着记不上就停下、记原因；点「接着记」从那章接着记，前面的不重记", async () => {
    await beginReread(book, 3);
    const failing = fakeKeeper({ failChapter: 2 });
    await runReread(book, { callModel: failing });
    const stopped = await readRereadState(book);
    expect(stopped).toMatchObject({ status: "stopped", done: 1 });
    expect(stopped?.stoppedReason).toContain("502");
    expect(await rereadBlocker(book, "定稿")).toContain("停在了第 2 章");
    const status = await readReadersCatchUpStatus(book);
    expect(status.reread).toMatchObject({ status: "stopped", done: 1, total: 3 });
    expect(status.roles.find((role) => role.role === "ledger")).toMatchObject({ reading: false, done: 1, total: 3 });

    // 停下的开书时不自动重试（一直失败的话每次开书都白花调用）。
    await resumeBackgroundReading(book);
    expect(isRereadActive(book)).toBe(false);

    const good = fakeKeeper();
    await runReread(book, { callModel: good });
    expect(await readRereadState(book)).toMatchObject({ status: "done", done: 3 });
    expect((await readChapterLedger(book, 1))?.origin).toBe("reread");
  });

  it("被拒（422）这类再发也一样的：这章只发一次就停下，不试满三次（写作版本 P2a 4.2，Astra 第 6 轮第 3 条）", async () => {
    await beginReread(book, 3);
    const rejected = fakeKeeper({ failChapter: 2, error: () => new ModelCallError("模型请求失败：422", "rejected", 422) });
    await runReread(book, { callModel: rejected });
    expect(rejected.ledgerCalls).toBe(2); // 第 1 章一次 + 第 2 章一次
    expect(await readRereadState(book)).toMatchObject({ status: "stopped", done: 1 });
  });

  it("产物不能用（空回复）可以再试：照旧最多试满三次", async () => {
    await beginReread(book, 3);
    const empty = fakeKeeper({ failChapter: 2, error: () => new ModelCallError("模型什么也没回", "unusable", undefined, "empty") });
    await runReread(book, { callModel: empty });
    expect(empty.ledgerCalls).toBe(1 + REREAD_ATTEMPTS);
    expect(await readRereadState(book)).toMatchObject({ status: "stopped", done: 1 });
  });

  it("偶尔失败一两次照记（一章最多试几次）", async () => {
    await beginReread(book, 3);
    await runReread(book, { callModel: fakeKeeper({ failChapter: 3, failTimes: REREAD_ATTEMPTS - 1 }) });
    expect(await readRereadState(book)).toMatchObject({ status: "done", done: 3 });
  });

  it("在记的时候：进度行按通读状态显示记账员那一行，四个动作都挡住", async () => {
    const state = await beginReread(book, 3, new Date("2026-10-19T08:00:00.000Z"));
    await writeRereadState(book, { ...state, done: 2, doneAtResume: 0, resumedAt: "2026-10-19T08:00:00.000Z" });
    const status = await readReadersCatchUpStatus(book);
    expect(status.reading).toBe(true);
    expect(status.roles.find((role) => role.role === "ledger")).toEqual({ role: "ledger", reading: true, done: 2, total: 3 });
    expect(status.reread).toMatchObject({ status: "running", done: 2, total: 3 });
    expect(await rereadBlocker(book, "核账")).toContain("记完 2/3 章");
    // 两章用了 10 分钟 → 剩一章大约 5 分钟。
    const now = Date.parse("2026-10-19T08:10:00.000Z");
    expect(rereadEtaMinutes((await readRereadState(book))!, now)).toBe(5);
  });

  it("进程重启前在记的：开书时接着记", async () => {
    await beginReread(book, 3);
    const keeper = fakeKeeper();
    const backfills: ReaderBackfillRequest[] = [];
    setReaderBackfillHandler(async (_book, request) => { backfills.push(request); });
    try {
      await resumeBackgroundReading(book, { callModel: keeper });
      await vi.waitFor(async () => expect((await readRereadState(book))?.status).toBe("done"), { timeout: 5000 });
      expect(keeper.calls).toBeGreaterThan(0);
      // 记完交一次三个专员的后台补读（执行器的 background.backfill）。
      await vi.waitFor(() => expect(backfills).toEqual([{ upTo: 3 }]), { timeout: 5000 });
      await runInReaderCatchUpQueue(book, async () => undefined);
    } finally {
      setReaderBackfillHandler(undefined);
    }
  });
});
