// @vitest-environment node
/**
 * 定稿清单上东西那几句（写作版本 P3b 设计 3.3、第 4 节）：重定稿没认上的东西、这章东西对不上的地方。
 * 用假记账员走真的预览 → 确认定稿，再看清单上的话和投影。
 */
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { chapterCommit, itemShortfall, projectBook, readChapterLedger, readTruthBasis, runCommand } from "@actalk/story-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import { commitEntriesOf, prepareChapterCommit, type CommitPreview, type PrepareFailure, type PrepareInput, type PreviewTicket } from "../editorial/commit-flow.js";
import type { BrainCallModel } from "../editorial/reader-window.js";
import { checklistView } from "./commit-view.js";

const prepareNow = async (input: Omit<PrepareInput, "basis">) => prepareChapterCommit({ ...input, basis: await readTruthBasis(input.bookDir) });
const confirmNow = (ticket: PreviewTicket, text: string) =>
  runCommand(book, chapterCommit, { chapter: ticket.chapter, text, entries: commitEntriesOf(ticket, {}) }, { caller: "author", basis: ticket.basis, idempotencyKey: randomUUID() });
function fakeModel(ledger: unknown): BrainCallModel {
  return async (messages) => ((messages.at(-1)?.content ?? "").includes("交这一章的账单") ? JSON.stringify(ledger) : "笔记：无。");
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

describe("定稿清单：东西", () => {
  it("重定稿别丢本章头回写到的东西：原句还在照上次记回；原句没了不拦、清单说清后文哪几处用不上它", async () => {
    const one = `${CH1}\n\n桌上放着一只铜盒。`;
    const two = "# 第2章 · 外乡人\n\n第二天上午，沈青禾把钥匙锁进铜盒。";
    const ledger1 = { ...LEDGER1, newItems: [{ tag: "N1", name: "铜钥匙", by: "narration", quote: "她在钟箱里摸到一把铜钥匙" }, { tag: "N2", name: "铜盒", by: "narration", quote: "桌上放着一只铜盒" }], items: [{ seq: 1, item: "N1", op: "move", to: { person: "沈青禾" }, by: "narration", quote: "揣进了包里" }] };
    const first = expectPreview(await prepareNow({ bookDir: book, chapter: 1, text: one, callModel: fakeModel(ledger1), knownNames: ["沈青禾"] }));
    expect(await confirmNow(first.ticket, one)).toMatchObject({ ok: true });
    const handles = new Map((await projectBook(book)).items.map((item, index) => [item.name, `I${index + 1}`] as const));
    const ledger2 = { summary: { text: "钥匙锁进铜盒", quote: "沈青禾把钥匙锁进铜盒" }, items: [{ seq: 1, item: handles.get("铜钥匙"), op: "move", to: { inside: handles.get("铜盒") }, by: "narration", quote: "沈青禾把钥匙锁进铜盒" }] };
    const second = expectPreview(await prepareNow({ bookDir: book, chapter: 2, text: two, callModel: fakeModel(ledger2) }));
    expect(await confirmNow(second.ticket, two)).toMatchObject({ ok: true });

    // 记账员这次没提铜盒，原句还在：照上次的记回去。
    const kept = expectPreview(await prepareNow({ bookDir: book, chapter: 1, text: `${one}\n\n风停了。`, callModel: fakeModel({ ...ledger1, newItems: ledger1.newItems.slice(0, 1) }) }));
    expect(kept.lostItems).toBeUndefined();
    expect([...kept.review, ...kept.auto].map((item) => item.label)).toContain("新东西：铜盒");

    // 原句改没了：不拦；清单说清后文只在装着它的地方用到它，定稿后那几处用不上。
    const gone = expectPreview(await prepareNow({ bookDir: book, chapter: 1, text: CH1, callModel: fakeModel({ ...ledger1, newItems: ledger1.newItems.slice(0, 1) }) }));
    expect(gone.lostItems).toEqual([{ name: "铜盒", proved: false }]);
    expect((checklistView(gone, []).view.notes ?? []).join("\n")).toContain("这章原来写到的「铜盒」这次没认上，后文只在装着它、清点它的地方提到：定稿后那几处用不上它");
    expect(await confirmNow(gone.ticket, CH1)).toMatchObject({ ok: true });
    const after = await projectBook(book);
    expect(after.items.find((item) => item.name === "铜钥匙")?.now).toMatchObject({ kind: "unknown", chapter: 2 });
    expect(after.itemIssues).toEqual([expect.objectContaining({ kind: "dangling", chapter: 2 })]);
  });


  it("这章东西对不上的（投影报的「可能」）进清单，说名字不说编号", async () => {
    const one = `${CH1}\n\n铜盒里只有那把铜钥匙。`;
    const ledger1 = { ...LEDGER1, newItems: [{ tag: "N1", name: "铜钥匙", by: "narration", quote: "她在钟箱里摸到一把铜钥匙" }, { tag: "N2", name: "铜盒", by: "narration", quote: "铜盒里只有那把铜钥匙" }], items: [{ seq: 1, item: "N2", op: "census", members: ["N1"], complete: true, by: "narration", quote: "铜盒里只有那把铜钥匙" }] };
    const first = expectPreview(await prepareNow({ bookDir: book, chapter: 1, text: one, callModel: fakeModel(ledger1), knownNames: ["沈青禾"] }));
    expect(first.itemIssues).toBeUndefined();
    expect(await confirmNow(first.ticket, one)).toMatchObject({ ok: true });
    const handles = new Map((await projectBook(book)).items.map((item, index) => [item.name, `I${index + 1}`] as const));
    const two = "# 第2章 · 外乡人\n\n第二天上午，沈青禾从铜盒里拿出一封信。";
    const ledger2 = { summary: { text: "拿出信", quote: "沈青禾从铜盒里拿出一封信" }, newItems: [{ tag: "N1", name: "信", by: "narration", quote: "沈青禾从铜盒里拿出一封信" }], items: [{ seq: 1, item: "N1", op: "move", from: { inside: handles.get("铜盒") }, to: { person: "沈青禾" }, by: "narration", quote: "沈青禾从铜盒里拿出一封信" }] };
    const second = expectPreview(await prepareNow({ bookDir: book, chapter: 2, text: two, callModel: fakeModel(ledger2) }));
    expect(second.itemIssues).toEqual(["「信」不在「铜盒」上回的完整清点里，这章却写它在里面：那次清点不再当完整"]);
    const notes = checklistView(second, []).view.notes ?? [];
    expect(notes).toContain("东西可能对不上：「信」不在「铜盒」上回的完整清点里，这章却写它在里面：那次清点不再当完整");
    expect(notes.join("")).not.toMatch(/\b[icx]\d*-\d/u);
  });

  it("一条东西条目写坏了丢掉：只那样东西这章起没核全，别的照旧；清单如实说", async () => {
    const one = `${CH1}\n\n桌上放着一只铜盒。`;
    const ledger1 = { ...LEDGER1, newItems: [{ tag: "N1", name: "铜钥匙", by: "narration", quote: "她在钟箱里摸到一把铜钥匙" }, { tag: "N2", name: "铜盒", by: "narration", quote: "桌上放着一只铜盒" }], items: [{ seq: 1, item: "N1", op: "move", to: { person: "沈青禾" }, by: "narration", quote: "揣进了包里" }, { seq: 2, item: "N2", op: "at", to: { place: "桌上" }, by: "narration", quote: "桌上放着一只铜盒" }] };
    const first = expectPreview(await prepareNow({ bookDir: book, chapter: 1, text: one, callModel: fakeModel(ledger1), knownNames: ["沈青禾"] }));
    expect(await confirmNow(first.ticket, one)).toMatchObject({ ok: true });
    const handles = new Map((await projectBook(book)).items.map((item, index) => [item.name, `I${index + 1}`] as const));
    const two = "# 第2章 · 外乡人\n\n第二天上午，铜钥匙不见了。";
    // 丢了却没写是丢了还是毁了：这条认不出、丢掉。
    const ledger2 = { summary: { text: "钥匙不见了", quote: "铜钥匙不见了" }, items: [{ seq: 1, item: handles.get("铜钥匙"), op: "gone", by: "narration", quote: "铜钥匙不见了" }] };
    const second = expectPreview(await prepareNow({ bookDir: book, chapter: 2, text: two, callModel: fakeModel(ledger2) }));
    const ids = new Map((await projectBook(book)).items.map((item) => [item.name, item.id] as const));
    expect(second).toMatchObject({ itemMissing: ["item"], itemMissingRefs: [{ id: ids.get("铜钥匙") }] });
    expect(checklistView(second, []).view.notes).toContain("东西有几条没记上，说到的那几样这章起的去向会记成没核全");
    const shortfall = itemShortfall(undefined, second.itemMissing ?? [], second.itemMissingRefs);
    expect(await runCommand(book, chapterCommit, { chapter: 2, text: two, entries: commitEntriesOf(second.ticket, {}), ...(shortfall ? { ledger: shortfall } : {}) }, { caller: "author", basis: second.ticket.basis, idempotencyKey: randomUUID() })).toMatchObject({ ok: true });
    expect((await readChapterLedger(book, 2))?.coverage.missingItems).toEqual([ids.get("铜钥匙")]);
    const after = await projectBook(book);
    expect(after.items.find((item) => item.name === "铜钥匙")).toMatchObject({ unverifiedSince: 2, unverifiedBy: "entry" });
    expect(after.items.find((item) => item.name === "铜盒")?.unverifiedSince).toBeUndefined();
  });
});
