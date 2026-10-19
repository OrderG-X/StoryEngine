// @vitest-environment node
//
// 改设定卡的唯一通道 writeCards（重构 P9）：作者改走 card.write、AI 补走 card.fill，都先打存档点、可撤销；
// 什么都没变就不打存档点；AI 碰作者写的整批不做、一个字节不写；同一个幂等键（同一个按钮）点两次只做一次。
// 真项目、真 git 存档点。
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { readCards, type CardOp } from "@actalk/story-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createStoryProject } from "../book/project-store.js";
import { writeCards } from "./card-write.js";
import { makeHomeTempDir } from "./home-test-tmp.js";
import { humanizeUndoLabel, listSnapshots, restoreSnapshot, snapshotKindOf } from "./snapshot.js";

let rootDir: string;
let book: string;
beforeEach(async () => {
  rootDir = await makeHomeTempDir("card-write-");
  ({ projectDir: book } = await createStoryProject({ rootDir, title: "海州账册", genre: "都市", protagonistName: "林远" }));
});
afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

/** 作者档（card.write）必须带防重复的键：设定本的保存、「确认改设定」按钮都带着。 */
const asAuthor = (ops: CardOp[]) => writeCards(book, { by: "author", ops, idempotencyKey: `card-ui:${randomUUID()}` });

const cardsText = (): Promise<string> => readFile(join(book, "ledger", "cards.json"), "utf-8");
const field = async (card: string, label: string) =>
  (await readCards(book))?.cards.find((item) => item.name === card)?.fields.find((item) => item.label === label);

describe("writeCards：作者改", () => {
  it("改前打存档点（标签带改了什么、归设定类），记成作者写的；按存档点撤销就回去", async () => {
    const out = await asAuthor([{ op: "field.set", card: "林远", label: "身份", value: "审计员" }]);
    expect(out).toMatchObject({ ok: true, lines: ["「林远」的「身份」写上了"] });
    if (!out.ok) throw new Error(out.message);
    expect(out.snapshotId).toMatch(/^[0-9a-f]{40}$/u);
    expect(out.replayed).toBeUndefined();
    expect(await field("林远", "身份")).toMatchObject({ value: "审计员", by: "author" });

    const snapshot = (await listSnapshots(book)).find((entry) => entry.id === out.snapshotId)!;
    expect(snapshotKindOf(snapshot.label)).toBe("bible");
    expect(humanizeUndoLabel(snapshot.label)).toBe("改设定：「林远」的「身份」写上了");

    await restoreSnapshot(book, out.snapshotId!);
    expect(await field("林远", "身份")).toBeUndefined();
  });

  it("什么都没变（空 ops、写的和现在一样）→ ok、没有存档点", async () => {
    await asAuthor([{ op: "field.set", card: "林远", label: "身份", value: "审计员" }]);
    const snapshots = (await listSnapshots(book)).length;
    expect(await asAuthor([])).toEqual({ ok: true, lines: [] });
    expect(await asAuthor([{ op: "field.set", card: "林远", label: "身份", value: "审计员" }])).toEqual({ ok: true, lines: [] });
    expect((await listSnapshots(book)).length).toBe(snapshots);
  });

  it("指错了卡：如实失败、整批不写（前面那步也不写）", async () => {
    const before = await cardsText();
    const out = await asAuthor([{ op: "field.set", card: "林远", label: "外貌", value: "高" }, { op: "card.delete", card: "张三" }]);
    expect(out).toMatchObject({ ok: false, code: "invalid", message: "没改设定：第 2 步：没有叫「张三」的卡。" });
    expect(await cardsText()).toBe(before);
  });
});

describe("writeCards：AI 补", () => {
  it("建新卡、填空的：记成 AI 写的，同样有存档点", async () => {
    const out = await writeCards(book, { by: "ai", ops: [{ op: "card.create", kind: "character", name: "苏晴", fields: [{ label: "身份", value: "记者" }] }] });
    expect(out).toMatchObject({ ok: true, lines: ["建了人物卡「苏晴」"] });
    expect(out.ok && out.snapshotId).toMatch(/^[0-9a-f]{40}$/u);
    expect((await readCards(book))?.cards.find((card) => card.name === "苏晴")).toMatchObject({ by: "ai", fields: [{ by: "ai" }] });
  });

  it("碰了作者写的：整批不做（前面能做的也不做），一个字节不写、不打存档点", async () => {
    await asAuthor([{ op: "field.set", card: "林远", label: "身份", value: "审计员" }]);
    const before = await cardsText();
    const snapshots = (await listSnapshots(book)).length;
    const out = await writeCards(book, {
      by: "ai",
      ops: [
        { op: "card.create", kind: "item", name: "蓝色账册" },
        { op: "field.set", card: "林远", label: "身份", value: "记者" },
      ],
    });
    expect(out).toMatchObject({ ok: false, code: "needs_author" });
    expect(!out.ok && out.message).toContain("「身份」是你写的，AI 改要你点头");
    expect(await cardsText()).toBe(before);
    expect((await listSnapshots(book)).length).toBe(snapshots);
  });
});

describe("writeCards：同一个按钮点两次只做一次", () => {
  it("同一幂等键重放：第二次回 replayed、不带存档点，设定卡里只多一张", async () => {
    const ops = [{ op: "card.create" as const, kind: "character" as const, name: "顾明" }];
    const first = await writeCards(book, { by: "author", ops, idempotencyKey: "card-confirm:k1" });
    expect(first).toMatchObject({ ok: true, lines: ["建了人物卡「顾明」"] });
    expect(first.ok && first.snapshotId).toMatch(/^[0-9a-f]{40}$/u);

    const again = await writeCards(book, { by: "author", ops, idempotencyKey: "card-confirm:k1" });
    expect(again).toMatchObject({ ok: true, replayed: true, lines: ["建了人物卡「顾明」"] });
    expect(again.ok && again.snapshotId).toBeUndefined();
    expect((await readCards(book))?.cards.filter((card) => card.name === "顾明")).toHaveLength(1);
  });

  it("换一个键再点同样的改动：真去做，做不成如实说（不当成重放）", async () => {
    const ops = [{ op: "card.create" as const, kind: "character" as const, name: "顾明" }];
    await writeCards(book, { by: "author", ops, idempotencyKey: "card-confirm:k1" });
    const other = await writeCards(book, { by: "author", ops, idempotencyKey: "card-confirm:k2" });
    expect(other).toMatchObject({ ok: false, code: "invalid" });
    expect(!other.ok && other.message).toContain("已经有叫「顾明」的卡了");
  });
});
