// @vitest-environment node
/**
 * 定稿记东西（写作版本 P3b 设计 3.3、第 4 节）：重定稿没认上的东西照上次记回、条目写坏了只那样没核全。
 * 用假记账员走真的记账 → 定稿，再看票里的条目和投影（安静账房：清单不给作者看了，话都不说，看账对不对）。
 */
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { chapterCommit, decisionRecord, itemShortfall, projectBook, readChapterLedger, readTruthBasis, runCommand } from "@actalk/story-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import { commitEntriesOf, prepareChapterCommit, type CommitPreview, type PrepareFailure, type PrepareInput, type PreviewTicket } from "./commit-flow.js";
import type { BrainCallModel } from "./reader-window.js";

const prepareNow = async (input: Omit<PrepareInput, "basis">) => prepareChapterCommit({ ...input, basis: await readTruthBasis(input.bookDir) });
const confirmNow = (ticket: PreviewTicket, text: string) =>
  runCommand(book, chapterCommit, { chapter: ticket.chapter, text, entries: commitEntriesOf(ticket) }, { caller: "author", basis: ticket.basis, idempotencyKey: randomUUID() });
function fakeModel(ledger: unknown): BrainCallModel {
  return async (messages) => (((messages.at(-1)?.content ?? "").includes("交这一章的账单") || (messages.at(-1)?.content ?? "").includes("只记本章东西的去向")) ? JSON.stringify(ledger) : "笔记：无。");
}
function expectPreview(outcome: CommitPreview | PrepareFailure): CommitPreview {
  if (!outcome.ok) throw new Error(`${outcome.code} ${outcome.reason}`);
  return outcome;
}

const CH1 = "# 第1章 · 钟停\n\n周二傍晚，钟停在三点十五分。沈青禾推开钟楼的门，老周没有拦她。\n\n她在钟箱里摸到一把铜钥匙，揣进了包里。钟为什么偏偏停在这个时刻？";
const LEDGER1 = {
  summary: { text: "沈青禾进钟楼拿走钥匙", quote: "她在钟箱里摸到一把铜钥匙" },
  time: { start: { offset: 0, basis: "text", quote: "周二傍晚" }, sameDay: true, weekday: "周二", timeOfDay: "傍晚" },
  presence: [
    { name: "沈青禾", nameUsed: "沈青禾", viewpoint: true, quote: "沈青禾推开钟楼的门" },
    { name: "周守义", nameUsed: "老周", quote: "老周没有拦她" },
  ],
  facts: [{ nature: "hard", subject: "钟", attribute: "停的时刻", value: "三点十五分", text: "钟停在三点十五分", quote: "钟停在三点十五分" }],
};

let book: string;
beforeEach(async () => {
  book = await makeHomeTempDir("commit-view-items-");
});
afterEach(async () => {
  await rm(book, { recursive: true, force: true });
});

describe("定稿记东西", () => {
  it("重定稿别丢本章头回写到的东西：原句还在照上次记回；原句没了不拦、后文用到它的记成不知道", async () => {
    const one = `${CH1}\n\n桌上放着一只铜盒。`;
    const two = "# 第2章 · 外乡人\n\n第二天上午，沈青禾把钥匙锁进铜盒。";
    const ledger1 = { ...LEDGER1, newItems: [{ tag: "N1", name: "铜钥匙", by: "narration", quote: "她在钟箱里摸到一把铜钥匙" }, { tag: "N2", name: "铜盒", by: "narration", quote: "桌上放着一只铜盒" }], items: [{ seq: 1, item: "N1", op: "move", to: { person: "沈青禾" }, by: "narration", quote: "揣进了包里" }] };
    const first = expectPreview(await prepareNow({ bookDir: book, chapter: 1, text: one, callModel: fakeModel(ledger1) }));
    expect(await confirmNow(first.ticket, one)).toMatchObject({ ok: true });
    const handles = new Map((await projectBook(book)).items.map((item, index) => [item.name, `I${index + 1}`] as const));
    const ledger2 = { summary: { text: "钥匙锁进铜盒", quote: "沈青禾把钥匙锁进铜盒" }, items: [{ seq: 1, item: handles.get("铜钥匙"), op: "move", to: { inside: handles.get("铜盒") }, by: "narration", quote: "沈青禾把钥匙锁进铜盒" }] };
    const second = expectPreview(await prepareNow({ bookDir: book, chapter: 2, text: two, callModel: fakeModel(ledger2) }));
    expect(await confirmNow(second.ticket, two)).toMatchObject({ ok: true });

    // 记账员这次没提铜盒，原句还在：照上次的记回去。
    const kept = expectPreview(await prepareNow({ bookDir: book, chapter: 1, text: `${one}\n\n风停了。`, callModel: fakeModel({ ...ledger1, newItems: ledger1.newItems.slice(0, 1) }) }));
    expect(kept.ticket.entries).toContainEqual(expect.objectContaining({ kind: "item", op: "appear", name: "铜盒" }));

    // 原句改没了：不拦，定稿后后文那几处用不上它（投影如实记成不知道、记一条问题）。
    const gone = expectPreview(await prepareNow({ bookDir: book, chapter: 1, text: CH1, callModel: fakeModel({ ...ledger1, newItems: ledger1.newItems.slice(0, 1) }) }));
    expect(gone.ticket.entries.some((entry) => entry.kind === "item" && entry.name === "铜盒")).toBe(false);
    expect(await confirmNow(gone.ticket, CH1)).toMatchObject({ ok: true });
    const after = await projectBook(book);
    expect(after.items.find((item) => item.name === "铜钥匙")?.now).toMatchObject({ kind: "unknown", chapter: 2 });
    expect(after.itemIssues).toEqual([expect.objectContaining({ kind: "dangling", chapter: 2 })]);
  });


  it("后文只有作者裁定用着它：重定稿照样记回；原句没了那条裁定不生效、记一条问题", async () => {
    const one = `${CH1}\n\n桌上放着一只铜盒。`;
    const two = "# 第2章 · 外乡人\n\n第二天上午，沈青禾出了门。";
    const ledger1 = { ...LEDGER1, newItems: [{ tag: "N1", name: "铜盒", by: "narration", quote: "桌上放着一只铜盒" }] };
    const first = expectPreview(await prepareNow({ bookDir: book, chapter: 1, text: one, callModel: fakeModel(ledger1) }));
    expect(await confirmNow(first.ticket, one)).toMatchObject({ ok: true });
    const second = expectPreview(await prepareNow({ bookDir: book, chapter: 2, text: two, callModel: fakeModel({ summary: { text: "出门", quote: "沈青禾出了门" } }) }));
    expect(await confirmNow(second.ticket, two)).toMatchObject({ ok: true });
    const box = (await projectBook(book)).items.find((item) => item.name === "铜盒")!;
    const ruled = await runCommand(book, decisionRecord, { decisions: [{ type: "item.state", item: box.id, chapter: 2, state: { kind: "at", to: { kind: "person", ref: { mention: "沈青禾" } } } }] } as never, { caller: "author", idempotencyKey: randomUUID() });
    expect(ruled).toMatchObject({ ok: true });

    const kept = expectPreview(await prepareNow({ bookDir: book, chapter: 1, text: `${one}\n\n风停了。`, callModel: fakeModel({ ...ledger1, newItems: [] }) }));
    expect(kept.ticket.entries).toContainEqual(expect.objectContaining({ kind: "item", op: "appear", name: "铜盒" }));

    const gone = expectPreview(await prepareNow({ bookDir: book, chapter: 1, text: CH1, callModel: fakeModel({ ...ledger1, newItems: [] }) }));
    expect(gone.ticket.entries.some((entry) => entry.kind === "item" && entry.name === "铜盒")).toBe(false);
    const receipt = await confirmNow(gone.ticket, CH1);
    expect(receipt).toMatchObject({ ok: true, result: { orphanedItems: ["铜盒"] } });
    const after = await projectBook(book);
    expect(after.items.some((item) => item.id === box.id)).toBe(false);
    expect(after.itemIssues).toContainEqual(expect.objectContaining({ kind: "dangling", chapter: 2 }));
  });

  it("这章东西对不上的（投影报的「可能」）定稿时不报，投影照记", async () => {
    const one = `${CH1}\n\n铜盒里只有那把铜钥匙。`;
    const ledger1 = { ...LEDGER1, newItems: [{ tag: "N1", name: "铜钥匙", by: "narration", quote: "她在钟箱里摸到一把铜钥匙" }, { tag: "N2", name: "铜盒", by: "narration", quote: "铜盒里只有那把铜钥匙" }], items: [{ seq: 1, item: "N2", op: "census", members: ["N1"], complete: true, by: "narration", quote: "铜盒里只有那把铜钥匙" }] };
    const first = expectPreview(await prepareNow({ bookDir: book, chapter: 1, text: one, callModel: fakeModel(ledger1) }));
    expect(await confirmNow(first.ticket, one)).toMatchObject({ ok: true });
    const handles = new Map((await projectBook(book)).items.map((item, index) => [item.name, `I${index + 1}`] as const));
    const two = "# 第2章 · 外乡人\n\n第二天上午，沈青禾从铜盒里拿出一封信。";
    const ledger2 = { summary: { text: "拿出信", quote: "沈青禾从铜盒里拿出一封信" }, newItems: [{ tag: "N1", name: "信", by: "narration", quote: "沈青禾从铜盒里拿出一封信" }], items: [{ seq: 1, item: "N1", op: "move", from: { inside: handles.get("铜盒") }, to: { person: "沈青禾" }, by: "narration", quote: "沈青禾从铜盒里拿出一封信" }] };
    const second = expectPreview(await prepareNow({ bookDir: book, chapter: 2, text: two, callModel: fakeModel(ledger2) }));
    expect(await confirmNow(second.ticket, two)).toMatchObject({ ok: true });
    expect((await projectBook(book)).itemIssues).toContainEqual(expect.objectContaining({ chapter: 2 }));
  });

  it("一条东西条目写坏了丢掉：只那样东西这章起没核全，别的照旧", async () => {
    const one = `${CH1}\n\n桌上放着一只铜盒。`;
    const ledger1 = { ...LEDGER1, newItems: [{ tag: "N1", name: "铜钥匙", by: "narration", quote: "她在钟箱里摸到一把铜钥匙" }, { tag: "N2", name: "铜盒", by: "narration", quote: "桌上放着一只铜盒" }], items: [{ seq: 1, item: "N1", op: "move", to: { person: "沈青禾" }, by: "narration", quote: "揣进了包里" }, { seq: 2, item: "N2", op: "at", to: { place: "桌上" }, by: "narration", quote: "桌上放着一只铜盒" }] };
    const first = expectPreview(await prepareNow({ bookDir: book, chapter: 1, text: one, callModel: fakeModel(ledger1) }));
    expect(await confirmNow(first.ticket, one)).toMatchObject({ ok: true });
    const handles = new Map((await projectBook(book)).items.map((item, index) => [item.name, `I${index + 1}`] as const));
    const two = "# 第2章 · 外乡人\n\n第二天上午，铜钥匙不见了。";
    // 丢了却没写是丢了还是毁了：这条认不出、丢掉。
    const ledger2 = { summary: { text: "钥匙不见了", quote: "铜钥匙不见了" }, items: [{ seq: 1, item: handles.get("铜钥匙"), op: "gone", by: "narration", quote: "铜钥匙不见了" }] };
    const second = expectPreview(await prepareNow({ bookDir: book, chapter: 2, text: two, callModel: fakeModel(ledger2) }));
    const ids = new Map((await projectBook(book)).items.map((item) => [item.name, item.id] as const));
    expect(second).toMatchObject({ itemMissing: ["item"], itemMissingRefs: [{ id: ids.get("铜钥匙") }] });
    const shortfall = itemShortfall(undefined, second.itemMissing ?? [], second.itemMissingRefs);
    expect(await runCommand(book, chapterCommit, { chapter: 2, text: two, entries: commitEntriesOf(second.ticket), ...(shortfall ? { ledger: shortfall } : {}) }, { caller: "author", basis: second.ticket.basis, idempotencyKey: randomUUID() })).toMatchObject({ ok: true });
    expect((await readChapterLedger(book, 2))?.coverage.missingItems).toEqual([ids.get("铜钥匙")]);
    const after = await projectBook(book);
    expect(after.items.find((item) => item.name === "铜钥匙")).toMatchObject({ unverifiedSince: 2, unverifiedBy: "entry" });
    expect(after.items.find((item) => item.name === "铜盒")?.unverifiedSince).toBeUndefined();
  });
});
