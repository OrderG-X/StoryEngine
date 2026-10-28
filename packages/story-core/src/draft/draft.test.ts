import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCommand } from "../commands/runner.js";
import type { CommandFailure, CommandOutcome, CommandSuccess } from "../commands/types.js";
import { readHead } from "../store/book.js";
import { draftAdoptCandidate, draftApplyGenerated, draftSave, type DraftConflictDetails, type DraftWriteResult } from "./commands.js";
import { composeDraftFile, draftVersionOf, parseDraftFile, readChapterPaper, readDraft, sameDraftBody } from "./draft.js";

let book: string;
beforeEach(async () => {
  book = await mkdtemp(join(tmpdir(), "story-core-draft-"));
});
afterEach(async () => {
  await rm(book, { recursive: true, force: true });
});

const draftFile = (chapter: number) => join(book, "drafts", "fast", `chapter-${String(chapter).padStart(4, "0")}.md`);
const author = { caller: "author" as const };
const ai = { caller: "ai" as const };

function expectOk(outcome: CommandOutcome<DraftWriteResult>): CommandSuccess<DraftWriteResult> {
  if (!outcome.ok) throw new Error(`命令失败：${outcome.code} ${outcome.message}`);
  return outcome;
}

function expectConflict(outcome: CommandOutcome<DraftWriteResult>): DraftConflictDetails {
  expect(outcome.ok).toBe(false);
  const failure = outcome as CommandFailure;
  expect(failure.code).toBe("draft_conflict");
  return failure.details as DraftConflictDetails;
}

describe("草稿文件拆拼", () => {
  it("第一行「# 章名」拆成章名，其余是正文；没有章名行就全是正文", () => {
    expect(parseDraftFile("# 第1章 · 钟停\n\n钟停了。\n\n她推门。\n")).toEqual({ title: "第1章 · 钟停", body: "钟停了。\n\n她推门。" });
    expect(parseDraftFile("\n\n钟停了。\n")).toEqual({ body: "钟停了。" });
    expect(parseDraftFile("")).toEqual({ body: "" });
  });

  it("拼回去：有章名补第一行；正文自带章名行就照写", () => {
    expect(composeDraftFile({ title: "钟停", body: "钟停了。" })).toBe("# 钟停\n\n钟停了。\n");
    expect(composeDraftFile({ title: "别的", body: "# 钟停\n\n钟停了。" })).toBe("# 钟停\n\n钟停了。\n");
    expect(composeDraftFile({ body: "钟停了。" })).toBe("钟停了。\n");
  });
});

describe("作者存稿（draft.save）", () => {
  it("新章：baseVersion 传 null 就能存；回执的版本号就是盘上文件的哈希；不动书的快照", async () => {
    let snapshots = 0;
    const outcome = expectOk(await runCommand(book, draftSave, { chapter: 1, title: "钟停", body: "钟停了。", baseVersion: null }, { ...author, snapshot: async () => { snapshots += 1; } }));
    const text = await readFile(draftFile(1), "utf-8");
    expect(text).toBe("# 钟停\n\n钟停了。\n");
    expect(outcome.result).toEqual({ chapter: 1, version: draftVersionOf(text), unchanged: false });
    expect(outcome.changed).toEqual({ drafts: [1] });
    expect(snapshots).toBe(0);
    expect((await readDraft(book, 1))?.version).toBe(outcome.result.version);
  });

  it("拿着旧版本号存：不写，交回盘上那份", async () => {
    const first = expectOk(await runCommand(book, draftSave, { chapter: 1, title: "钟停", body: "钟停了。", baseVersion: null }, author));
    expectOk(await runCommand(book, draftApplyGenerated, { chapter: 1, body: "钟停了。AI 改过。", baseVersion: first.result.version }, ai));
    const details = expectConflict(await runCommand(book, draftSave, { chapter: 1, body: "钟停了。作者也改了。", baseVersion: first.result.version }, author));
    expect(details.current).toMatchObject({ chapter: 1, title: "钟停", body: "钟停了。AI 改过。" });
    expect(await readFile(draftFile(1), "utf-8")).toBe("# 钟停\n\n钟停了。AI 改过。\n");
  });

  it("盘上有稿却传 null（以为是新章）也算撞版本", async () => {
    await mkdir(join(book, "drafts", "fast"), { recursive: true });
    await writeFile(draftFile(2), "外面写的。\n", "utf-8");
    const details = expectConflict(await runCommand(book, draftSave, { chapter: 2, body: "我的。", baseVersion: null }, author));
    expect(details.current?.body).toBe("外面写的。");
  });

  it("撤销把文件换回去：版本号跟着变回去，拿撤销前的版本号存会撞", async () => {
    const v1 = expectOk(await runCommand(book, draftSave, { chapter: 1, body: "第一版。", baseVersion: null }, author)).result.version;
    const v2 = expectOk(await runCommand(book, draftSave, { chapter: 1, body: "第二版。", baseVersion: v1 }, author)).result.version;
    await writeFile(draftFile(1), "第一版。\n", "utf-8");
    expect((await readDraft(book, 1))?.version).toBe(v1);
    expectConflict(await runCommand(book, draftSave, { chapter: 1, body: "第三版。", baseVersion: v2 }, author));
  });

  it("不传章名时留着盘上原来的章名", async () => {
    const v1 = expectOk(await runCommand(book, draftSave, { chapter: 1, title: "钟停", body: "一。", baseVersion: null }, author)).result.version;
    expectOk(await runCommand(book, draftSave, { chapter: 1, body: "二。", baseVersion: v1 }, author));
    expect(await readFile(draftFile(1), "utf-8")).toBe("# 钟停\n\n二。\n");
  });

  it("存稿不动书的版本号（老格式镜像和老书导入都看它）", async () => {
    expectOk(await runCommand(book, draftSave, { chapter: 1, body: "一。", baseVersion: null }, author));
    expect((await readHead(book)).version).toBe(0);
  });

  it("内容没变：什么都不写，版本号不变", async () => {
    const v1 = expectOk(await runCommand(book, draftSave, { chapter: 1, body: "一。", baseVersion: null }, author));
    const head = (await readHead(book)).version;
    const again = expectOk(await runCommand(book, draftSave, { chapter: 1, body: "一。", baseVersion: v1.result.version }, author));
    expect(again.result).toEqual({ chapter: 1, version: v1.result.version, unchanged: true });
    expect((await readHead(book)).version).toBe(head);
  });

  it("AI 不能调作者存稿", async () => {
    const outcome = await runCommand(book, draftSave, { chapter: 1, body: "一。", baseVersion: null }, ai);
    expect(outcome).toMatchObject({ ok: false, code: "author_only" });
  });

  it("同一笔重发：盘上已经是这份了，算存上（不因为版本已经换了报撞）", async () => {
    const v1 = expectOk(await runCommand(book, draftSave, { chapter: 1, body: "一。", baseVersion: null }, author)).result.version;
    const v2 = expectOk(await runCommand(book, draftSave, { chapter: 1, body: "二。", baseVersion: v1 }, author)).result.version;
    const retry = expectOk(await runCommand(book, draftSave, { chapter: 1, body: "二。", baseVersion: v1 }, author));
    expect(retry.result).toEqual({ chapter: 1, version: v2, unchanged: true });
  });
});

describe("AI 写稿换上（draft.applyGenerated）", () => {
  it("写前打快照；新章 baseVersion 传 null", async () => {
    const labels: string[] = [];
    const outcome = expectOk(await runCommand(book, draftApplyGenerated, { chapter: 3, title: "外乡人", body: "外乡人来了。", baseVersion: null }, { ...ai, snapshot: async (label) => { labels.push(label); } }));
    expect(labels).toEqual(["AI 写稿：第 3 章"]);
    expect(outcome.result.version).toBe(draftVersionOf(await readFile(draftFile(3), "utf-8")));
  });

  it("基稿版本必带：缺了参数不过", async () => {
    const outcome = await runCommand(book, draftApplyGenerated, { chapter: 1, body: "一。" } as never, ai);
    expect(outcome.ok).toBe(false);
  });

  it("写的途中作者存过稿：不换，作者那份不动", async () => {
    const v1 = expectOk(await runCommand(book, draftSave, { chapter: 1, body: "一。", baseVersion: null }, author)).result.version;
    expectOk(await runCommand(book, draftSave, { chapter: 1, body: "作者改过。", baseVersion: v1 }, author));
    expectConflict(await runCommand(book, draftApplyGenerated, { chapter: 1, body: "AI 稿。", baseVersion: v1 }, ai));
    expect(await readFile(draftFile(1), "utf-8")).toBe("作者改过。\n");
  });
});

describe("作者换上 AI 稿（draft.adoptCandidate）", () => {
  it("作者档、写前打快照；拿作者眼前那份的版本换", async () => {
    const v1 = expectOk(await runCommand(book, draftSave, { chapter: 1, body: "作者的。", baseVersion: null }, author)).result.version;
    expect(await runCommand(book, draftAdoptCandidate, { chapter: 1, body: "AI 的。", baseVersion: v1 }, ai)).toMatchObject({ ok: false, code: "author_only" });
    const labels: string[] = [];
    expectOk(await runCommand(book, draftAdoptCandidate, { chapter: 1, body: "AI 的。", baseVersion: v1 }, { ...author, snapshot: async (label) => { labels.push(label); } }));
    expect(labels).toEqual(["换上 AI 稿：第 1 章"]);
    expect(await readFile(draftFile(1), "utf-8")).toBe("AI 的。\n");
  });

  it("作者眼前那份已经不是盘上的：不换", async () => {
    const v1 = expectOk(await runCommand(book, draftSave, { chapter: 1, body: "一。", baseVersion: null }, author)).result.version;
    expectOk(await runCommand(book, draftSave, { chapter: 1, body: "二。", baseVersion: v1 }, author));
    expectConflict(await runCommand(book, draftAdoptCandidate, { chapter: 1, body: "AI 的。", baseVersion: v1 }, author));
    expect(await readFile(draftFile(1), "utf-8")).toBe("二。\n");
  });
});

describe("稿纸打开一章", () => {
  it("工作稿、定稿都给；只差空行时不算定稿后改过", async () => {
    await mkdir(join(book, "chapters"), { recursive: true });
    await writeFile(join(book, "chapters", "0001.md"), "# 第1章 · 钟停\n\n钟停了。\n\n她推门。\n", "utf-8");
    expect(await readChapterPaper(book, 1)).toEqual({ chapter: 1, draft: null, committed: { title: "第1章 · 钟停", body: "钟停了。\n\n她推门。" }, editedSinceCommit: null });
    await mkdir(join(book, "drafts", "fast"), { recursive: true });
    await writeFile(draftFile(1), "# 第1章 · 钟停\n\n钟停了。  \n\n\n\n她推门。\n", "utf-8");
    expect((await readChapterPaper(book, 1)).editedSinceCommit).toBe(false);
    await writeFile(draftFile(1), "# 第1章 · 钟停\n\n钟停了。\n\n她没推门。\n", "utf-8");
    expect((await readChapterPaper(book, 1)).editedSinceCommit).toBe(true);
    expect(sameDraftBody("a\r\nb", "a\nb")).toBe(true);
  });
});
