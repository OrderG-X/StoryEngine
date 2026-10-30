// @vitest-environment node
//
// AI 写工作稿（写作版本 P1b、P2a）：在操作的应用步骤里，只在工作稿还是开工时那版、书还是开工时那样时换上；
// 对不上就留成候选、如实说，作者那份一个字不动。真项目、真命令、真存档点、真操作。
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { draftSave, readDraft, readTruthBasis, runCommand } from "@actalk/story-core";
import { createStoryProject } from "../../book/project-store.js";
import { writeCards } from "../../lib/card-write.js";
import { pendingDraftFor, readDraftCandidate } from "../../lib/draft-candidates.js";
import { makeHomeTempDir } from "../../lib/home-test-tmp.js";
import { listSnapshots } from "../../lib/snapshot.js";
import { applyAiDraftInOperation as applyAiDraft } from "./test-helpers.js";

let rootDir: string;
let book: string;
beforeEach(async () => {
  rootDir = await makeHomeTempDir("ai-draft-apply-");
  ({ projectDir: book } = await createStoryProject({ rootDir, title: "海州账册", genre: "都市", protagonistName: "林远" }));
});
afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

/** 开工：先读依据、再读稿（和出稿流程同一个先后）。 */
async function start(chapter = 1) {
  const basis = await readTruthBasis(book);
  const baseVersion = (await readDraft(book, chapter))?.version ?? null;
  return { basis, baseVersion, materials: [] };
}

async function authorSaves(chapter: number, body: string): Promise<void> {
  const baseVersion = (await readDraft(book, chapter))?.version ?? null;
  const outcome = await runCommand(book, draftSave, { chapter, title: "", body, baseVersion }, { caller: "author" });
  if (!outcome.ok) throw new Error(outcome.message);
}

describe("AI 稿换上", () => {
  it("两样都对得上 → 换上，换前打存档点（叫调用方给的名字）", async () => {
    const begun = await start();
    const outcome = await applyAiDraft(book, { chapter: 1, title: "", body: "AI 写的第一章。", ...begun, source: "draft", snapshotLabel: "出稿：第1章" });
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
    const outcome = await applyAiDraft(book, { chapter: 1, title: "", body: "AI 写的一版。", ...begun, source: "revise" });
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
    expect(await writeCards(book, { ops: [{ op: "field.set", card: "林远", label: "籍贯", value: "海州" }], idempotencyKey: `card-ui:${randomUUID()}` }))
      .toMatchObject({ ok: true });
    const outcome = await applyAiDraft(book, { chapter: 1, title: "", body: "照旧设定写的一版。", ...begun, source: "draft" });
    expect(outcome).toMatchObject({ applied: false, reason: "basis_moved" });
    expect((await readDraft(book, 1))?.body).toBe("作者原来的稿。");
  });

  it("写好的那份和盘上一样 → 不写、不打存档点，算换上了", async () => {
    await authorSaves(1, "一样的。");
    const begun = await start();
    const before = (await listSnapshots(book)).length;
    const outcome = await applyAiDraft(book, { chapter: 1, title: "", body: "一样的。", ...begun, source: "unit-fix" });
    expect(outcome).toMatchObject({ applied: true, unchanged: true });
    expect((await listSnapshots(book)).length).toBe(before);
  });
});
