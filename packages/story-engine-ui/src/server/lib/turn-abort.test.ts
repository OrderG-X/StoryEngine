// @vitest-environment node
//
// 作者喊停之后，这一轮的 AI 不许再往书里写（长篇连写走查 2026-10-24：停了 / 断了之后出稿流水线照跑完，几分钟后把稿写进盘）。
// 真项目：AI 写工作稿、AI 补设定卡两个唯一通道在喊停的一轮里都不落盘；作者档的改设定照常；不在任何一轮里照常写。
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createStoryProject } from "../book/project-store.js";
import { AiDraftWriteError, writeAiDraft } from "./ai-draft-write.js";
import { writeCards } from "./card-write.js";
import { makeHomeTempDir } from "./home-test-tmp.js";
import { runAbortableTurn, turnAborted } from "./turn-abort.js";

let rootDir: string;
let book: string;
beforeEach(async () => {
  rootDir = await makeHomeTempDir("turn-abort-");
  ({ projectDir: book } = await createStoryProject({ rootDir, title: "海州账册", genre: "都市", protagonistName: "林远" }));
});
afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

const draftOf = (chapter: number) => readFile(join(book, "drafts", "fast", `chapter-${String(chapter).padStart(4, "0")}.md`), "utf-8").catch(() => undefined);

describe("喊停之后 AI 写不进书", () => {
  it("没喊停照常写；喊停（信号翻了，哪怕是写到一半才翻）之后的 AI 稿不落盘，抛 turn_aborted", async () => {
    const controller = new AbortController();
    await runAbortableTurn(controller.signal, async () => {
      await writeAiDraft(book, { chapter: 1, body: "第一版。", baseVersion: "overwrite" });
      expect(turnAborted()).toBe(false);
      controller.abort();
      expect(turnAborted()).toBe(true);
      const error = await writeAiDraft(book, { chapter: 1, body: "停了以后才到的一版。", baseVersion: "overwrite" }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AiDraftWriteError);
      expect((error as AiDraftWriteError).code).toBe("turn_aborted");
    });
    expect(await draftOf(1)).toContain("第一版。");
    expect(await draftOf(1)).not.toContain("停了以后");
    // 这一轮之外（后台活、下一轮）不受影响
    await writeAiDraft(book, { chapter: 1, body: "下一轮。", baseVersion: "overwrite" });
    expect(await draftOf(1)).toContain("下一轮。");
  });

  it("设定卡：喊停后 AI 补的不写；作者点的照常写", async () => {
    const controller = new AbortController();
    controller.abort();
    await runAbortableTurn(controller.signal, async () => {
      expect(await writeCards(book, { by: "ai", ops: [{ op: "field.set", card: "林远", label: "身份", value: "审计员" }] }))
        .toMatchObject({ ok: false, code: "turn_aborted" });
      expect(await writeCards(book, { by: "author", ops: [{ op: "field.set", card: "林远", label: "籍贯", value: "海州" }], idempotencyKey: `card-ui:${randomUUID()}` }))
        .toMatchObject({ ok: true });
    });
    const cards = await readFile(join(book, "ledger", "cards.json"), "utf-8");
    expect(cards).toContain("海州");
    expect(cards).not.toContain("审计员");
  });
});
