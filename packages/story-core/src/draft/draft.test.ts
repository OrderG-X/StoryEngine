import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCommand } from "../commands/runner.js";
import type { CommandFailure, CommandOutcome, CommandSuccess } from "../commands/types.js";
import { readHead } from "../store/book.js";
import { DRAFT_GENS_PATH } from "../store/paths.js";
import { bumpRevision } from "../store/revision.js";
import { draftAdoptCandidate, draftApplyGenerated, draftSave, type DraftConflictDetails, type DraftWriteResult } from "./commands.js";
import { composeDraftFile, draftVersionOf, parseDraftFile, readChapterPaper, readDraft, sameDraft, sameDraftBody } from "./draft.js";

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
  it("文件原文：第一行非空行是一级章名行就拆成章名，其余是正文；只有「#」是空章名；「## 小节」是正文", () => {
    expect(parseDraftFile("# 第1章 · 钟停\n\n钟停了。\n\n她推门。\n")).toEqual({ title: "第1章 · 钟停", body: "钟停了。\n\n她推门。" });
    expect(parseDraftFile("\n\n钟停了。\n")).toEqual({ body: "钟停了。" });
    expect(parseDraftFile("")).toEqual({ body: "" });
    expect(parseDraftFile("## 第一节\n\n原句。\n")).toEqual({ body: "## 第一节\n\n原句。" });
    expect(parseDraftFile("# 章名\n\n## 第一节\n\n原句。\n")).toEqual({ title: "章名", body: "## 第一节\n\n原句。" });
    expect(parseDraftFile("#\n\n# 小节\n正文\n")).toEqual({ body: "# 小节\n正文" });
    expect(parseDraftFile("\r\n# 章名\r\n正文\r\n")).toEqual({ title: "章名", body: "正文" });
  });

  it("拆开的稿拼回文件：正文一行都不拆（第 14 轮复核 AB1）；没章名、正文开头是章名行的垫一行「#」，读回来还是原样", () => {
    expect(composeDraftFile({ title: "钟停", body: "钟停了。" })).toBe("# 钟停\n\n钟停了。\n");
    expect(composeDraftFile({ title: "章名", body: "## 第一节\n\n原句。" })).toBe("# 章名\n\n## 第一节\n\n原句。\n");
    expect(composeDraftFile({ body: "## 第一节\n原句。" })).toBe("## 第一节\n原句。\n");
    expect(composeDraftFile({ title: "", body: "# 小节\n正文" })).toBe("#\n\n# 小节\n正文\n");
    expect(composeDraftFile({ body: "钟停了。" })).toBe("钟停了。\n");
    expect(composeDraftFile({ title: "钟停", body: "" })).toBe("# 钟停\n");
    for (const draft of [{ title: "章名", body: "## 第一节\n\n原句。" }, { body: "# 小节\n正文" }, { title: "章名", body: "# 小节\n正文" }]) {
      expect(parseDraftFile(composeDraftFile(draft))).toEqual(draft);
      expect(composeDraftFile(parseDraftFile(composeDraftFile(draft)))).toBe(composeDraftFile(draft));
    }
  });

  it("同一份稿按整份比，两边都不拆：章名不一样就不是同一份；小节标题不一样也不是；正文只差空行不算", () => {
    expect(sameDraft({ title: "钟停", body: "钟停了。" }, { title: "钟停", body: "\n\n钟停了。  " })).toBe(true);
    expect(sameDraft({ title: "钟停", body: "钟停了。" }, { title: "别的", body: "钟停了。" })).toBe(false);
    expect(sameDraft({ title: "", body: "钟停了。" }, { body: "钟停了。" })).toBe(true);
    expect(sameDraft({ title: "章名", body: "## 旧小节\n原句。" }, { title: "章名", body: "## 新小节\n原句。" })).toBe(false);
    expect(sameDraft({ title: "章名", body: "## 第一节\n原句。" }, { title: "章名", body: "原句。" })).toBe(false);
  });

  it("章名里的换行（\\n、单独的 \\r、\\r\\n、U+2028 / U+2029）收成空格：拼回文件再读回来章名完整、正文一个字不多（第 16 轮 AD2）", () => {
    for (const title of ["前半\n后半", "前半\r\n后半", "前半\r后半", "前半\u2028后半", "前半\u2029后半", "前半 \r \n 后半"]) {
      const file = composeDraftFile({ title, body: "# 正文第一节\n\n原正文。" });
      expect(file).toBe("# 前半 后半\n\n# 正文第一节\n\n原正文。\n");
      expect(parseDraftFile(file)).toEqual({ title: "前半 后半", body: "# 正文第一节\n\n原正文。" });
      expect(sameDraft({ title, body: "原正文。" }, { title: "前半 后半", body: "原正文。" })).toBe(true);
    }
    // 盘上的章名行里本来就夹着 U+2028：照样认成章名，不掉进正文。
    expect(parseDraftFile("# 前半\u2028后半\n\n正文。\n")).toEqual({ title: "前半\u2028后半", body: "正文。" });
  });

});

describe("作者存稿（draft.save）", () => {
  it("章名必带、以它为准（空串 = 去掉章名）；正文是拆开的正文、一行都不拆（第 13 轮 AA4、第 14 轮 AB1、第 15 轮）", async () => {
    let base = expectOk(await runCommand(book, draftSave, { chapter: 1, body: "钟停了。", title: "原章名", baseVersion: null }, author)).result.version;
    expect(await readFile(draftFile(1), "utf-8")).toBe("# 原章名\n\n钟停了。\n");
    const renamed = expectOk(await runCommand(book, draftSave, { chapter: 1, body: "钟停了。", title: "新章名", baseVersion: base }, author));
    expect(renamed.result.unchanged).toBe(false);
    expect(await readFile(draftFile(1), "utf-8")).toBe("# 新章名\n\n钟停了。\n");
    base = expectOk(await runCommand(book, draftSave, { chapter: 1, body: "钟停了。又响了。", title: "新章名", baseVersion: renamed.result.version }, author)).result.version;
    expect((await readDraft(book, 1))?.title).toBe("新章名");
    // 作者在稿纸开头打的「# 某某」是正文：有章名、没章名都原样留着，读回来还是同一份。
    for (const title of ["新章名", ""]) {
      const body = "# 正文第一节\n\n钟停了。又响了。";
      base = expectOk(await runCommand(book, draftSave, { chapter: 1, body, title, baseVersion: base }, author)).result.version;
      expect(await readDraft(book, 1)).toMatchObject({ ...(title ? { title } : {}), body });
    }
    base = expectOk(await runCommand(book, draftSave, { chapter: 1, body: "钟停了。又响了。", title: "", baseVersion: base }, author)).result.version;
    expect(await readFile(draftFile(1), "utf-8")).toBe("钟停了。又响了。\n");
    expectOk(await runCommand(book, draftSave, { chapter: 1, body: "## 第一节\n\n钟停了。", title: "章名", baseVersion: base }, author));
    expect(await readFile(draftFile(1), "utf-8")).toBe("# 章名\n\n## 第一节\n\n钟停了。\n");
    expect(await readDraft(book, 1)).toMatchObject({ title: "章名", body: "## 第一节\n\n钟停了。" });
  });

  it("新章：baseVersion 传 null 就能存；回执的版本号就是盘上文件的哈希；不动书的快照", async () => {
    let snapshots = 0;
    const outcome = expectOk(await runCommand(book, draftSave, { chapter: 1, title: "钟停", body: "钟停了。", baseVersion: null }, { ...author, snapshot: async () => { snapshots += 1; } }));
    const text = await readFile(draftFile(1), "utf-8");
    expect(text).toBe("# 钟停\n\n钟停了。\n");
    expect(outcome.result).toMatchObject({ chapter: 1, unchanged: false });
    expect(outcome.changed).toEqual({ drafts: [1] });
    expect(snapshots).toBe(0);
    expect((await readDraft(book, 1))?.version).toBe(outcome.result.version);
  });

  it("拿着旧版本号存：不写，交回盘上那份", async () => {
    const first = expectOk(await runCommand(book, draftSave, { chapter: 1, title: "钟停", body: "钟停了。", baseVersion: null }, author));
    expectOk(await runCommand(book, draftApplyGenerated, { chapter: 1, title: "钟停", body: "钟停了。AI 改过。", baseVersion: first.result.version }, ai));
    const details = expectConflict(await runCommand(book, draftSave, { chapter: 1, title: "钟停", body: "钟停了。作者也改了。", baseVersion: first.result.version }, author));
    expect(details.current).toMatchObject({ chapter: 1, title: "钟停", body: "钟停了。AI 改过。" });
    expect(await readFile(draftFile(1), "utf-8")).toBe("# 钟停\n\n钟停了。AI 改过。\n");
  });

  it("盘上有稿却传 null（以为是新章）也算撞版本", async () => {
    await mkdir(join(book, "drafts", "fast"), { recursive: true });
    await writeFile(draftFile(2), "外面写的。\n", "utf-8");
    const details = expectConflict(await runCommand(book, draftSave, { chapter: 2, title: "", body: "我的。", baseVersion: null }, author));
    expect(details.current?.body).toBe("外面写的。");
  });

  it("撤销把文件换回原样：版本号不回到原来那个，照撤销前发的旧存稿撞版本（不把撤销的结果盖回去）", async () => {
    const vR = expectOk(await runCommand(book, draftSave, { chapter: 1, title: "", body: "原稿。", baseVersion: null }, author)).result.version;
    const vA = expectOk(await runCommand(book, draftSave, { chapter: 1, title: "", body: "作者的。", baseVersion: vR }, author)).result.version;
    const vB = expectOk(await runCommand(book, draftApplyGenerated, { chapter: 1, title: "", body: "AI 的。", baseVersion: vA }, ai)).result.version;
    // 撤销：存档点把文件换回原样（store-control 不进存档点），再换代次。
    await writeFile(draftFile(1), "原稿。\n", "utf-8");
    await bumpRevision(book);
    const now = (await readDraft(book, 1))!.version;
    expect([vR, vA, vB]).not.toContain(now);
    // 撤销前那笔「作者的。@原稿」迟到重发：撞版本，撤销的结果不动。
    expectConflict(await runCommand(book, draftSave, { chapter: 1, title: "", body: "作者的。", baseVersion: vR }, author));
    expect(await readFile(draftFile(1), "utf-8")).toBe("原稿。\n");
    expectOk(await runCommand(book, draftSave, { chapter: 1, title: "", body: "接着写。", baseVersion: now }, author));
  });

  it("撤销到还没写过：没稿也有新版本号，照撤销前「没稿」发的旧首稿撞版本（第 4 轮复核 R1）", async () => {
    const vA = expectOk(await runCommand(book, draftSave, { chapter: 1, title: "", body: "作者首稿。", baseVersion: null }, author)).result.version;
    expectOk(await runCommand(book, draftApplyGenerated, { chapter: 1, title: "", body: "AI 的。", baseVersion: vA }, ai));
    // 撤销到没稿：存档点删掉文件，再换代次。
    await rm(draftFile(1));
    await bumpRevision(book);
    const now = (await readChapterPaper(book, 1)).draftVersion;
    expect(now).toMatch(/^none-/u);
    expectConflict(await runCommand(book, draftSave, { chapter: 1, title: "", body: "作者首稿。", baseVersion: null }, author));
    expectOk(await runCommand(book, draftSave, { chapter: 1, title: "", body: "重新写。", baseVersion: now }, author));
  });

  it("不经撤销，作者把稿改回原样：旧版本号也对不上（每写一次换一个代次号）", async () => {
    const vR = expectOk(await runCommand(book, draftSave, { chapter: 1, title: "", body: "原稿。", baseVersion: null }, author)).result.version;
    const vA = expectOk(await runCommand(book, draftSave, { chapter: 1, title: "", body: "改了。", baseVersion: vR }, author)).result.version;
    const back = expectOk(await runCommand(book, draftSave, { chapter: 1, title: "", body: "原稿。", baseVersion: vA }, author)).result.version;
    expect(back).not.toBe(vR);
    expectConflict(await runCommand(book, draftSave, { chapter: 1, title: "", body: "改了。", baseVersion: vR }, author));
  });

  it("老书（还没有工作稿代次）：版本号就是全文的哈希，升级前打开的稿纸照样能存", async () => {
    await mkdir(join(book, "drafts", "fast"), { recursive: true });
    await writeFile(draftFile(4), "老稿。\n", "utf-8");
    const legacy = (await readDraft(book, 4))!.version;
    expect(legacy).toBe(draftVersionOf("老稿。\n", { epoch: "" }));
    // 别的章先写过（代次文件建起来了），这一章还是老版本号。
    expectOk(await runCommand(book, draftSave, { chapter: 5, title: "", body: "别章。", baseVersion: null }, author));
    expect((await readDraft(book, 4))!.version).toBe(legacy);
    expectOk(await runCommand(book, draftSave, { chapter: 4, title: "", body: "新写。", baseVersion: legacy }, author));
  });

  it("工作稿代次文件坏了：版本号谁都对不上（撞版本），下一次写换成好的", async () => {
    const v1 = expectOk(await runCommand(book, draftSave, { chapter: 1, title: "", body: "一。", baseVersion: null }, author)).result.version;
    await writeFile(join(book, DRAFT_GENS_PATH), "{坏了", "utf-8");
    const now = (await readDraft(book, 1))!.version;
    expect(now).not.toBe(v1);
    expectConflict(await runCommand(book, draftSave, { chapter: 1, title: "", body: "二。", baseVersion: v1 }, author));
    expectOk(await runCommand(book, draftSave, { chapter: 1, title: "", body: "二。", baseVersion: now }, author));
    expect(JSON.parse(await readFile(join(book, DRAFT_GENS_PATH), "utf-8"))).toMatchObject({ schema: "draft-gens/1" });
  });

  it("章名不带：参数不过，什么都不写（章名由调用方定，命令里不沿用盘上的）", async () => {
    const v1 = expectOk(await runCommand(book, draftSave, { chapter: 1, title: "钟停", body: "一。", baseVersion: null }, author)).result.version;
    expect((await runCommand(book, draftSave, { chapter: 1, body: "二。", baseVersion: v1 } as never, author)).ok).toBe(false);
    expect(await readFile(draftFile(1), "utf-8")).toBe("# 钟停\n\n一。\n");
  });

  it("存稿不动书的版本号（老格式镜像和老书导入都看它）", async () => {
    expectOk(await runCommand(book, draftSave, { chapter: 1, title: "", body: "一。", baseVersion: null }, author));
    expect((await readHead(book)).version).toBe(0);
  });

  it("内容没变：什么都不写，版本号不变", async () => {
    const v1 = expectOk(await runCommand(book, draftSave, { chapter: 1, title: "", body: "一。", baseVersion: null }, author));
    const head = (await readHead(book)).version;
    const again = expectOk(await runCommand(book, draftSave, { chapter: 1, title: "", body: "一。", baseVersion: v1.result.version }, author));
    expect(again.result).toEqual({ chapter: 1, version: v1.result.version, unchanged: true });
    expect((await readHead(book)).version).toBe(head);
  });

  it("AI 不能调作者存稿", async () => {
    const outcome = await runCommand(book, draftSave, { chapter: 1, title: "", body: "一。", baseVersion: null }, ai);
    expect(outcome).toMatchObject({ ok: false, code: "author_only" });
  });

  it("同一笔重发：盘上已经是这份了，算存上（不因为版本已经换了报撞）", async () => {
    const v1 = expectOk(await runCommand(book, draftSave, { chapter: 1, title: "", body: "一。", baseVersion: null }, author)).result.version;
    const v2 = expectOk(await runCommand(book, draftSave, { chapter: 1, title: "", body: "二。", baseVersion: v1 }, author)).result.version;
    const retry = expectOk(await runCommand(book, draftSave, { chapter: 1, title: "", body: "二。", baseVersion: v1 }, author));
    expect(retry.result).toEqual({ chapter: 1, version: v2, unchanged: true });
  });
});

describe("AI 写稿换上（draft.applyGenerated）", () => {
  it("写前打快照；新章 baseVersion 传 null", async () => {
    const labels: string[] = [];
    const outcome = expectOk(await runCommand(book, draftApplyGenerated, { chapter: 3, title: "外乡人", body: "外乡人来了。", baseVersion: null }, { ...ai, snapshot: async (label) => { labels.push(label); } }));
    expect(labels).toEqual(["AI 写稿：第 3 章"]);
    expect(outcome.result.version).toBe((await readDraft(book, 3))?.version);
  });

  it("基稿版本必带：缺了参数不过", async () => {
    const outcome = await runCommand(book, draftApplyGenerated, { chapter: 1, title: "", body: "一。" } as never, ai);
    expect(outcome.ok).toBe(false);
  });

  it("写的途中作者存过稿：不换，作者那份不动", async () => {
    const v1 = expectOk(await runCommand(book, draftSave, { chapter: 1, title: "", body: "一。", baseVersion: null }, author)).result.version;
    expectOk(await runCommand(book, draftSave, { chapter: 1, title: "", body: "作者改过。", baseVersion: v1 }, author));
    expectConflict(await runCommand(book, draftApplyGenerated, { chapter: 1, title: "", body: "AI 稿。", baseVersion: v1 }, ai));
    expect(await readFile(draftFile(1), "utf-8")).toBe("作者改过。\n");
  });
});

describe("作者换上 AI 稿（draft.adoptCandidate）", () => {
  it("作者档、写前打快照；拿作者眼前那份的版本换", async () => {
    const v1 = expectOk(await runCommand(book, draftSave, { chapter: 1, title: "", body: "作者的。", baseVersion: null }, author)).result.version;
    expect(await runCommand(book, draftAdoptCandidate, { chapter: 1, title: "", body: "AI 的。", baseVersion: v1 }, ai)).toMatchObject({ ok: false, code: "author_only" });
    const labels: string[] = [];
    expectOk(await runCommand(book, draftAdoptCandidate, { chapter: 1, title: "", body: "AI 的。", baseVersion: v1 }, { ...author, snapshot: async (label) => { labels.push(label); } }));
    expect(labels).toEqual(["换上 AI 稿：第 1 章"]);
    expect(await readFile(draftFile(1), "utf-8")).toBe("AI 的。\n");
  });

  it("作者眼前那份已经不是盘上的：不换", async () => {
    const v1 = expectOk(await runCommand(book, draftSave, { chapter: 1, title: "", body: "一。", baseVersion: null }, author)).result.version;
    expectOk(await runCommand(book, draftSave, { chapter: 1, title: "", body: "二。", baseVersion: v1 }, author));
    expectConflict(await runCommand(book, draftAdoptCandidate, { chapter: 1, title: "", body: "AI 的。", baseVersion: v1 }, author));
    expect(await readFile(draftFile(1), "utf-8")).toBe("二。\n");
  });
});

describe("稿纸打开一章", () => {
  it("工作稿、定稿都给；只差空行时不算定稿后改过", async () => {
    await mkdir(join(book, "chapters"), { recursive: true });
    await writeFile(join(book, "chapters", "0001.md"), "# 第1章 · 钟停\n\n钟停了。\n\n她推门。\n", "utf-8");
    expect(await readChapterPaper(book, 1)).toEqual({ chapter: 1, draft: null, draftVersion: null, committed: { title: "第1章 · 钟停", body: "钟停了。\n\n她推门。" }, editedSinceCommit: null });
    await mkdir(join(book, "drafts", "fast"), { recursive: true });
    await writeFile(draftFile(1), "# 第1章 · 钟停\n\n钟停了。  \n\n\n\n她推门。\n", "utf-8");
    expect((await readChapterPaper(book, 1)).editedSinceCommit).toBe(false);
    await writeFile(draftFile(1), "# 第1章 · 钟停\n\n钟停了。\n\n她没推门。\n", "utf-8");
    expect((await readChapterPaper(book, 1)).editedSinceCommit).toBe(true);
    expect(sameDraftBody("a\r\nb", "a\nb")).toBe(true);
  });
});
