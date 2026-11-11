// @vitest-environment node
// 外部审查 2026-11-11（P4b 窄审）复现的几处：章末对一遍并回去、替用了没声明的号补声明、缺账口径、章末没对成留一句。
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  chapterCommit,
  checkEntries,
  itemShortfall,
  ledgerOf,
  project,
  projectBook,
  readBookSnapshot,
  readChapterLedger,
  rejectedItemMissing,
  runCommand,
  splitUnits,
  type EntryInput,
} from "@actalk/story-core";
import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import { declareUsedNewTags, mergeItemCheck, nextNewTag } from "./item-check.js";
import { buildKeeperContext } from "./keeper-context.js";
import { parseKeeperOutput } from "./keeper-parse.js";
import { itemsWithUnitQuotes, runLedgerKeeper } from "./ledger-keeper.js";
import { commitEntriesOf, prepareChapterCommit } from "./commit-flow.js";
import type { BrainCallModel } from "./reader-window.js";

const empty = () => project({ ledgers: [], decisions: [] });
const dirs: string[] = [];
const bookDir = async (): Promise<string> => {
  const dir = await makeHomeTempDir("item-check-merge-");
  dirs.push(dir);
  return dir;
};
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const parse = (root: Record<string, unknown>, text: string) =>
  parseKeeperOutput(itemsWithUnitQuotes(JSON.stringify(root), text, splitUnits(text))!, buildKeeperContext(empty(), ""))!;

/** 记账员主对话交 main、记东西那遍交 first、章末对一遍走 check。 */
const modelFor = (first: unknown, check: () => Promise<string>, main: unknown = {}): BrainCallModel => async (messages, options) => {
  if (!options?.json) return "笔记";
  const last = messages.at(-1)?.content ?? "";
  if (last.includes("【对一遍章末】")) return check();
  if (last.includes("只记本章东西的去向")) return JSON.stringify(first);
  if (last.includes("交这一章的账单")) return JSON.stringify(main);
  return "{}";
};

const text = "# 第1章\n\n铜钥匙在桌上。铁盒在柜里。布袋在床下。";
const units = splitUnits(text);
const unit = (word: string) => units.find((entry) => entry.text.includes(word))!.id;
const key = { tag: "N1", name: "铜钥匙", unit: unit("铜钥匙"), by: "narration" };
const keyAt = { seq: 1, item: "N1", op: "at", to: { place: "桌上" }, unit: unit("铜钥匙"), by: "narration" };
const first = { newItems: [key], items: [keyAt] };

const projected = (root: Record<string, unknown>) => {
  const checked = checkEntries(parse(root, text).entries, text, empty());
  return { checked, view: project({ ledgers: [ledgerOf({ chapter: 1, text, entries: checked.accepted.map((entry) => entry.entry) })], decisions: [] }) };
};

describe("章末对一遍并回去：号不串", () => {
  it("补问自己先声明了没撞号的 N2，再声明撞号的 N1：换的号避开两边用过的，铁盒、布袋各归各", () => {
    const merged = mergeItemCheck(first, JSON.stringify({
      newItems: [
        { tag: "N2", name: "布袋", unit: unit("布袋"), by: "narration" },
        { tag: "N1", name: "铁盒", unit: unit("铁盒"), by: "narration" },
      ],
      items: [
        { item: "N2", op: "at", to: { place: "床下" }, unit: unit("布袋"), by: "narration" },
        { item: "N1", op: "at", to: { place: "柜里" }, unit: unit("铁盒"), by: "narration" },
      ],
    }))!;
    expect((merged.root.newItems as { tag: string }[]).map((entry) => entry.tag)).toEqual(["N1", "N2", "N3"]);
    const { checked, view } = projected(merged.root);
    expect(checked.rejected).toEqual([]);
    expect(view.items.find((item) => item.name === "铁盒")?.now).toMatchObject({ kind: "known", place: { text: "柜里" } });
    expect(view.items.find((item) => item.name === "布袋")?.now).toMatchObject({ kind: "known", place: { text: "床下" } });
  });

  it("第一遍用了 N1 没声明：下一个新号从 N2 起；补问照样声明 N1 也换掉，不把铜钥匙的条目挂到铁盒上", () => {
    const incomplete = { newItems: [], items: [{ ...keyAt, as: "铜钥匙" }] };
    expect(nextNewTag(incomplete)).toBe(2);
    const pre = declareUsedNewTags(incomplete);
    expect(pre.declared).toEqual(["N1"]);
    const merged = mergeItemCheck(pre.root, JSON.stringify({
      newItems: [{ tag: "N1", name: "铁盒", unit: unit("铁盒"), by: "narration" }],
      items: [{ item: "N1", op: "at", to: { place: "柜里" }, unit: unit("铁盒"), by: "narration" }],
    }))!;
    const { checked, view } = projected(declareUsedNewTags(merged.root).root);
    expect(checked.rejected).toEqual([]);
    expect(view.items.map((item) => item.name).sort()).toEqual(["铁盒", "铜钥匙"]);
    expect(view.items.find((item) => item.name === "铜钥匙")?.now).toMatchObject({ kind: "known", place: { text: "桌上" } });
  });

  it("补问交单个对象当一条；交空的第一遍原样（第一遍只交了单个对象的也不丢）", () => {
    const extra = { item: "N1", op: "move", to: { person: "甲" }, by: "narration", unit: unit("铜钥匙") };
    const merged = mergeItemCheck(first, JSON.stringify({ items: extra }))!;
    expect(merged.added).toBe(1);
    expect((merged.root.items as unknown[]).length).toBe(2);
    const singleton = { newItems: key, items: keyAt };
    expect(mergeItemCheck(singleton, '{"newItems":[],"items":[]}')).toEqual({ root: singleton, added: 0 });
  });

  it("补问里写坏的条目不悄悄滤掉：并进去，解析时记成丢了一条", () => {
    const merged = mergeItemCheck(first, '{"newItems":[],"items":[null]}')!;
    expect(merged.added).toBe(1);
    expect(parse(merged.root, text).drops).toContainEqual(expect.objectContaining({ kind: "item", reason: "不是对象" }));
  });

  it("补声明只认解析真当成「装在哪样里面」的：kind = person 的去处里多塞的 item 不算一样东西", () => {
    const body = "# 第1章\n\n铜钥匙在甲手里。";
    const id = splitUnits(body).find((entry) => entry.text.includes("铜钥匙"))!.id;
    const raw = { newItems: [{ ...key, unit: id }], items: [{ ...keyAt, unit: id, to: { kind: "person", name: "甲", item: "N2", as: "甲" } }] };
    expect(declareUsedNewTags(raw).declared).toEqual([]);
    // 写成 {"item":"N2","as":"木盒"} 的才是装在它里面，照旧补声明。
    const inBox = { items: [{ ...keyAt, to: { item: "N2", as: "木盒" } }] };
    expect(declareUsedNewTags(inBox).declared).toEqual(["N2"]);
  });
});

describe("跑一遍记账员：第一遍只交单个对象、章末对一遍没成", () => {
  it("第一遍声明、去向各只交一个对象，章末交空的：两条都在", async () => {
    for (const singleton of [{ newItems: key, items: [keyAt] }, { newItems: [key], items: keyAt }]) {
      const result = await runLedgerKeeper({
        projectDir: await bookDir(), chapter: 1, draft: text, before: empty(), maxCatchUp: 0,
        callModel: modelFor(singleton, async () => '{"newItems":[],"items":[]}'),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(checkEntries(result.parsed.entries, text, empty()).rejected).toEqual([]);
      expect(result.parsed.entries.filter((entry) => entry.kind === "item").map((entry) => (entry.kind === "item" ? entry.op : ""))).toEqual(["appear", "at"]);
    }
  });

  it("章末对一遍报错：东西照第一遍记、不算缺账，预览里留下原因", async () => {
    const dir = await bookDir();
    const before = await readBookSnapshot(dir);
    const preview = await prepareChapterCommit({
      bookDir: dir, chapter: 1, text, basis: before.basis, maxCatchUp: 0,
      callModel: modelFor(first, async () => { throw new Error("fetch failed"); }),
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.itemCheckFailed).toBeTruthy();
    expect(preview.itemMissing).toBeUndefined();
  });
});

describe("缺账口径：带东西的事实没记上只缺事实（预览、核心同一把尺子）", () => {
  it("核心尺子", () => {
    const fact = { kind: "fact", review: "auto", nature: "hard", item: { id: "i1-1" }, subject: "铜钥匙", attribute: "新旧", value: "旧", text: "铜钥匙很旧", quote: "x" } as EntryInput;
    const move = { kind: "item", review: "auto", op: "at", seq: 1, item: { id: "i1-1" }, to: { kind: "person", name: "甲" }, quote: "x", source: { kind: "narration" } } as EntryInput;
    expect(rejectedItemMissing([fact])).toEqual({ kinds: ["fact"], items: [] });
    expect(rejectedItemMissing([fact, move])).toEqual({ kinds: ["fact", "item"], items: [{ id: "i1-1" }] });
  });

  it("走预览 + 定稿：前章记过的铜钥匙只有一条事实原句核不上，账只缺事实，铜钥匙不标没核全", async () => {
    const dir = await bookDir();
    const chapter1 = "# 第1章\n\n铜钥匙在甲手里。";
    const entries: EntryInput[] = [
      { kind: "item", review: "auto", op: "appear", tag: "N1", name: "铜钥匙", quote: "铜钥匙在甲手里", source: { kind: "narration" } },
      { kind: "item", review: "auto", op: "at", seq: 1, item: { tag: "N1" }, to: { kind: "person", name: "甲" }, quote: "铜钥匙在甲手里", source: { kind: "narration" } },
    ];
    expect((await runCommand(dir, chapterCommit, { chapter: 1, text: chapter1, entries }, { caller: "author", idempotencyKey: "c1" })).ok).toBe(true);
    const snapshot = await readBookSnapshot(dir);
    const chapter2 = "# 第2章\n\n铜钥匙很旧。";
    const main = { facts: [{ item: "I1", nature: "hard", subject: "铜钥匙", attribute: "新旧", value: "旧", text: "铜钥匙很旧", quote: "正文没有这一句" }] };
    const preview = await prepareChapterCommit({
      bookDir: dir, chapter: 2, text: chapter2, basis: snapshot.basis, maxCatchUp: 0,
      callModel: modelFor({ newItems: [], items: [] }, async () => '{"newItems":[],"items":[]}', main),
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.itemMissing).toEqual(["fact"]);
    const shortfall = itemShortfall(undefined, preview.itemMissing ?? [], preview.itemMissingRefs);
    expect((await runCommand(dir, chapterCommit, { chapter: 2, text: chapter2, entries: commitEntriesOf(preview.ticket), ledger: shortfall }, { caller: "author", idempotencyKey: "c2" })).ok).toBe(true);
    expect((await readChapterLedger(dir, 2))?.coverage.missingKinds).toEqual(["fact"]);
    expect((await projectBook(dir)).items[0]?.unverifiedSince).toBeUndefined();
  });
});
