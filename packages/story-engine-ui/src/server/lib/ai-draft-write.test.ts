// @vitest-environment node
//
// AI 写工作稿的唯一通道（写作版本 P1b）：只在操作里换上（换上 / 留候选的规矩在 services/operations/ai-draft-apply.test.ts）；
// 同一章的 AI 改稿一次一笔。真项目、真命令。
import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { draftSave, readDraft, readTruthBasis, runCommand } from "@actalk/story-core";
import { createStoryProject } from "../book/project-store.js";
import { applyAiDraft, oneAiWriterPerChapter } from "./ai-draft-write.js";
import { makeHomeTempDir } from "./home-test-tmp.js";

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
  return { basis, baseVersion, materials: [] };
}

async function authorSaves(chapter: number, body: string): Promise<void> {
  const baseVersion = (await readDraft(book, chapter))?.version ?? null;
  const outcome = await runCommand(book, draftSave, { chapter, title: "", body, baseVersion }, { caller: "author" });
  if (!outcome.ok) throw new Error(outcome.message);
}

describe("applyAiDraft", () => {
  it("不在操作里：如实挡下、不写（AI 稿只在操作的应用步骤里换上，写作版本 P2a 片 4C）", async () => {
    await authorSaves(1, "作者原来的稿。");
    const begun = await start();
    await expect(applyAiDraft(book, { chapter: 1, title: "", body: "AI 写的。", ...begun, source: "draft" })).rejects.toMatchObject({ code: "not_in_operation" });
    expect((await readDraft(book, 1))?.body).toBe("作者原来的稿。");
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
