// @vitest-environment node
//
// AI 写工作稿的唯一通道（写作版本 P1b）：只在工作稿还是开工时那版、书还是开工时那样时换上；
// 对不上就留成候选、如实说，作者那份一个字不动。真项目、真命令、真存档点。
import { randomUUID } from "node:crypto";
import { rm, stat } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { draftSave, readDraft, readTruthBasis, runCommand } from "@actalk/story-core";
import { createStoryProject } from "../book/project-store.js";
import { applyAiDraft, oneAiWriterPerChapter } from "./ai-draft-write.js";
import { writeCards } from "./card-write.js";
import { pendingDraftFor, readDraftCandidate, saveDraftCandidate } from "./draft-candidates.js";
import { makeHomeTempDir } from "./home-test-tmp.js";
import { listSnapshots } from "./snapshot.js";

let rootDir: string;
let book: string;
beforeEach(async () => {
  rootDir = await makeHomeTempDir("ai-draft-write-");
  ({ projectDir: book } = await createStoryProject({ rootDir, title: "海州账册", genre: "都市", protagonistName: "林远" }));
});
afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

/** 开工：先读依据、再读稿（和出稿流程同一个先后）。 */
async function start(chapter = 1) {
  const basis = await readTruthBasis(book);
  const baseVersion = (await readDraft(book, chapter))?.version ?? null;
  return { basis, baseVersion };
}

async function authorSaves(chapter: number, body: string): Promise<void> {
  const baseVersion = (await readDraft(book, chapter))?.version ?? null;
  const outcome = await runCommand(book, draftSave, { chapter, body, baseVersion }, { caller: "author" });
  if (!outcome.ok) throw new Error(outcome.message);
}

describe("applyAiDraft", () => {
  it("两样都对得上 → 换上，换前打存档点（叫调用方给的名字）", async () => {
    const begun = await start();
    const outcome = await applyAiDraft(book, { chapter: 1, body: "AI 写的第一章。", ...begun, source: "draft", snapshotLabel: "出稿：第1章" });
    expect(outcome).toMatchObject({ applied: true, unchanged: false });
    expect((await readDraft(book, 1))?.body).toBe("AI 写的第一章。");
    expect(outcome.applied && outcome.snapshotId).toBeTruthy();
    expect((await listSnapshots(book)).some((entry) => entry.label === "出稿：第1章")).toBe(true);
  });

  it("写的途中作者存了稿 → 不换、留成候选（draft_moved），不打存档点；稿纸提示这一份", async () => {
    await authorSaves(1, "作者原来的稿。");
    const begun = await start();
    await authorSaves(1, "作者在 AI 写的时候又改了。");
    const before = (await listSnapshots(book)).length;
    const outcome = await applyAiDraft(book, { chapter: 1, body: "AI 写的一版。", ...begun, source: "revise" });
    expect(outcome).toMatchObject({ applied: false, reason: "draft_moved" });
    expect(outcome.applied ? "" : outcome.message).toContain("你那份没动");
    expect((await readDraft(book, 1))?.body).toBe("作者在 AI 写的时候又改了。");
    expect((await listSnapshots(book)).length).toBe(before);
    const candidate = await readDraftCandidate(book, outcome.applied ? "" : outcome.candidateId);
    expect(candidate).toMatchObject({ chapter: 1, body: "AI 写的一版。", status: "ready", reason: "draft_moved", source: "revise" });
    expect(await pendingDraftFor(book, 1)).toMatchObject({ kind: "candidate", reason: "draft_moved", body: "AI 写的一版。" });
  });

  it("写的途中前文或设定改过 → 不换、留成候选（basis_moved），工作稿没动", async () => {
    await authorSaves(1, "作者原来的稿。");
    const begun = await start();
    expect(await writeCards(book, { by: "author", ops: [{ op: "field.set", card: "林远", label: "籍贯", value: "海州" }], idempotencyKey: `card-ui:${randomUUID()}` }))
      .toMatchObject({ ok: true });
    const outcome = await applyAiDraft(book, { chapter: 1, body: "照旧设定写的一版。", ...begun, source: "draft" });
    expect(outcome).toMatchObject({ applied: false, reason: "basis_moved" });
    expect((await readDraft(book, 1))?.body).toBe("作者原来的稿。");
  });

  it("开写时存的那份候选：换上了删掉，这一章更早没换上的也清掉", async () => {
    const begun = await start();
    const older = await saveDraftCandidate(book, { chapter: 1, body: "更早没换上的。", baseVersion: null, basisDigest: begun.basis.digest, source: "draft", status: "ready", reason: "draft_moved" });
    const writing = await saveDraftCandidate(book, { chapter: 1, body: "在写的。", baseVersion: null, basisDigest: begun.basis.digest, source: "draft", status: "writing" });
    const other = await saveDraftCandidate(book, { chapter: 2, body: "别的章的。", baseVersion: null, basisDigest: begun.basis.digest, source: "draft", status: "ready", reason: "draft_moved" });
    expect(await applyAiDraft(book, { chapter: 1, body: "写完的。", ...begun, source: "draft", candidateId: writing.id })).toMatchObject({ applied: true });
    expect(await readDraftCandidate(book, writing.id)).toBeUndefined();
    expect(await readDraftCandidate(book, older.id)).toBeUndefined();
    expect(await readDraftCandidate(book, other.id)).toBeDefined();
  });

  it("没换上时用的就是开写时存的那份候选（同一个号，状态改成等作者选）", async () => {
    await authorSaves(1, "作者原来的稿。");
    const begun = await start();
    const writing = await saveDraftCandidate(book, { chapter: 1, body: "首稿。", baseVersion: begun.baseVersion, basisDigest: begun.basis.digest, source: "draft", status: "writing" });
    // 本进程正在写的不提示
    expect(await pendingDraftFor(book, 1)).toBeUndefined();
    await authorSaves(1, "作者改了。");
    const outcome = await applyAiDraft(book, { chapter: 1, body: "核账改完的。", ...begun, source: "draft", candidateId: writing.id });
    expect(outcome).toMatchObject({ applied: false, candidateId: writing.id });
    expect(await readDraftCandidate(book, writing.id)).toMatchObject({ status: "ready", body: "核账改完的。" });
  });

  it("写好的那份和盘上一样 → 不写、不打存档点，算换上了", async () => {
    await authorSaves(1, "一样的。");
    const begun = await start();
    const before = (await listSnapshots(book)).length;
    const outcome = await applyAiDraft(book, { chapter: 1, body: "一样的。", ...begun, source: "unit-fix" });
    expect(outcome).toMatchObject({ applied: true, unchanged: true });
    expect((await listSnapshots(book)).length).toBe(before);
  });

  it("书删了（进了回收站）→ 留候选也不在原处建出目录", async () => {
    await authorSaves(1, "作者原来的稿。");
    const begun = await start();
    await authorSaves(1, "改过。");
    await rm(book, { recursive: true, force: true });
    await expect(applyAiDraft(book, { chapter: 1, body: "AI。", ...begun, source: "draft" })).rejects.toThrow();
    await expect(stat(book)).rejects.toThrow();
  });
});

describe("oneAiWriterPerChapter", () => {
  it("同一章一次一笔（后一笔等前一笔换上了再读稿）；别的章不排队；前一笔抛错不卡后面的", async () => {
    const order: string[] = [];
    const slow = (name: string, ms: number) => async () => {
      order.push(`${name}:start`);
      await new Promise((resolve) => setTimeout(resolve, ms));
      order.push(`${name}:end`);
      return name;
    };
    const failing = oneAiWriterPerChapter(book, 1, async () => { order.push("x:start"); throw new Error("模型挂了"); });
    const first = oneAiWriterPerChapter(book, 1, slow("a", 30));
    const second = oneAiWriterPerChapter(book, 1, slow("b", 1));
    const elsewhere = oneAiWriterPerChapter(book, 2, slow("c", 1));
    await expect(failing).rejects.toThrow("模型挂了");
    expect(await Promise.all([first, second, elsewhere])).toEqual(["a", "b", "c"]);
    expect(order.indexOf("a:end")).toBeLessThan(order.indexOf("b:start"));
    expect(order.indexOf("c:end")).toBeLessThan(order.indexOf("a:end"));
  });

  it("排队等的工夫作者存稿不被卡住（不占书锁）", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ai = oneAiWriterPerChapter(book, 1, async () => { await gate; return "done"; });
    await authorSaves(1, "作者照存。");
    expect((await readDraft(book, 1))?.body).toBe("作者照存。");
    release();
    expect(await ai).toBe("done");
  });
});
