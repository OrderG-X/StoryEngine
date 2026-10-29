// @vitest-environment node
import { rm } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { draftSave, readDraft, runCommand } from "@actalk/story-core";

import { createStoryProject } from "../book/project-store.js";
import { readDraftCandidate } from "../lib/draft-candidates.js";
import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import { fixByUnits, fixDraftByUnits } from "./unit-fix.js";

const goal = "和第 3 章「他那年二十九」对上";
const reply = (edits: readonly { id: number | string; to: string }[]) => JSON.stringify({ edits });

describe("fixByUnits：按编号整句换（P12 编号句子）", () => {
  const draft = "# 第五章 雾\n\n“我出。”杜卫平说，“我爹的账上沾了那船的钱，他那本手账里一笔一笔都记着。这些年这钱在我手里压着，花在当年那条船的人身上，不亏心。”\n许微没接话。\n";

  it("核账抄的是半句：提示里点名那几句的编号，模型回整句、按编号换，不留两遍；收引号对齐原句", async () => {
    const callModel = vi.fn(async (prompt: string) => {
      expect(prompt).toContain("1. [2][3]：和第 3 章");
      expect(prompt).toContain("\n[4]许微没接话。");
      return reply([{ id: 3, to: "这些年这钱在我手里压着，花在当年那条船的人身上，我心里不亏。" }]);
    });
    const out = await fixByUnits({ chapter: 5, text: draft, fixes: [{ quote: "他那本手账里一笔一笔都记着。这些年这钱在我手里压着", goal }], callModel });
    expect(out.applied).toEqual([0]);
    expect(out.failed).toEqual([]);
    expect(out.text).toBe(draft.replace("不亏心。”", "我心里不亏。”"));
  });

  it("新句抄进了前一句：去掉抄的那截；编号写成「[2]」也认", async () => {
    const text = "他走了。\n许微没接话。\n";
    const out = await fixByUnits({ chapter: 5, text, fixes: [{ quote: "许微没接话", goal }], callModel: async () => reply([{ id: "[2]", to: "他走了。许微点了点头。" }]) });
    expect(out).toMatchObject({ text: "他走了。\n许微点了点头。\n", applied: [0] });
  });

  // 换题材长篇实跑 2026-10-28：改法照编号正文整段抄回（「上一句[2]这一句」），整条被当成一句改成了几句丢掉。
  it("新写法带着别的编号（整段抄回来）：按编号拆开，点名那句照换", async () => {
    const text = "他走了。\n许微没接话。\n";
    const out = await fixByUnits({ chapter: 5, text, fixes: [{ quote: "许微没接话", goal }], callModel: async () => reply([{ id: 1, to: "他走了。[2]许微点了点头。" }]) });
    expect(out).toMatchObject({ text: "他走了。\n许微点了点头。\n", applied: [0] });
  });

  it("两处报的是同一句：合成一条交给模型，只问一次，两处都算改了", async () => {
    const callModel = vi.fn(async (_prompt: string) => reply([{ id: 1, to: "甲乙丁。" }]));
    const out = await fixByUnits({ chapter: 5, text: "甲乙丙。戊己。\n", fixes: [{ quote: "甲乙", goal: "一" }, { quote: "乙丙", goal: "二" }], callModel });
    expect(callModel).toHaveBeenCalledTimes(1);
    expect(callModel.mock.calls[0]![0]).toContain("1. [1]：一；二");
    expect(out).toMatchObject({ text: "甲乙丁。戊己。\n", applied: [0, 1], failed: [] });
  });

  it("原句找不到 / 不止一处 / 太长：不问模型，照实说为什么", async () => {
    const callModel = vi.fn(async () => reply([]));
    const out = await fixByUnits({
      chapter: 5,
      text: "他走了。他走了。一。二。三。四。五。\n",
      fixes: [{ quote: "不在稿里", goal }, { quote: "他走了", goal }, { quote: "一。二。三。四。五", goal }],
      callModel,
    });
    expect(callModel).not.toHaveBeenCalled();
    expect(out.text).toBe("他走了。他走了。一。二。三。四。五。\n");
    expect(out.failed.map((item) => item.why)).toEqual([
      "原句在稿里找不到了（可能已经改过）",
      "原句在稿里不止一处，不知道改哪一处",
      "核账引的原句太长，没法只改那几句",
    ]);
  });

  it("回的不是 JSON：同一份提示再要一次；还不行就照实说格式不对，正文不动", async () => {
    const callModel = vi.fn(async () => "好的，我改成了……");
    const out = await fixByUnits({ chapter: 5, text: "他走了。\n", fixes: [{ quote: "他走了", goal }], callModel });
    expect(callModel).toHaveBeenCalledTimes(2);
    expect(out).toMatchObject({ text: "他走了。\n", applied: [], failed: [{ fix: 0, why: "AI 回的格式不对，没写改后的句子" }] });
  });

  it("只认点名的编号：改了别的句子不算；没给点名那句的改法照实说", async () => {
    const out = await fixByUnits({ chapter: 5, text: "甲。乙。\n", fixes: [{ quote: "乙", goal }], callModel: async () => reply([{ id: 1, to: "改了甲。" }]) });
    expect(out).toMatchObject({ text: "甲。乙。\n", applied: [], failed: [{ fix: 0, why: "AI 没给出这句的改法" }] });
  });

  it("本章别处说同一件事的句子跟着改（P13 真机：「四个字」只改了点名那句）；锁住的、超三句的、要删句的不收", async () => {
    const text = "他说了四个字。不到时候。她问哪四个字。他说就这四个字。前面也说四个字。\n";
    const out = await fixByUnits({
      chapter: 9, text, fixes: [{ quote: "他说了四个字", goal }],
      callModel: async () => reply([{ id: 1, to: "他说了三个字。" }, { id: 3, to: "她问哪三个字。" }, { id: 4, to: "他说就这三个字。" }]),
    });
    expect(out.text).toBe("他说了三个字。不到时候。她问哪三个字。他说就这三个字。前面也说四个字。\n");
    expect(out).toMatchObject({ applied: [0], alsoChanged: 2 });

    const locked = await fixByUnits({
      chapter: 9, text, fixes: [{ quote: "她问哪四个字", goal }], lockedBefore: text.indexOf("不到时候"),
      callModel: async () => reply([{ id: 3, to: "她问哪三个字。" }, { id: 1, to: "他说了三个字。" }, { id: 4, to: "" }]),
    });
    // 第 1 句在作者写的那段里，不连带改；连带的不许删句。
    expect(locked.text).toBe("他说了四个字。不到时候。她问哪三个字。他说就这四个字。前面也说四个字。\n");
    expect(locked.alsoChanged).toBe(0);

    const capped = await fixByUnits({
      chapter: 9, text: "甲。乙。丙。丁。戊。\n", fixes: [{ quote: "甲", goal }],
      callModel: async () => reply([{ id: 1, to: "甲甲。" }, { id: 2, to: "乙乙。" }, { id: 3, to: "丙丙。" }, { id: 4, to: "丁丁。" }, { id: 5, to: "戊戊。" }]),
    });
    expect(capped.text).toBe("甲甲。乙乙。丙丙。丁丁。戊。\n");
  });

  it("几处里一处换上了、一处没给：改了的照换，没给的照实说", async () => {
    const out = await fixByUnits({
      chapter: 5,
      text: "甲。乙。丙。\n",
      fixes: [{ quote: "甲", goal }, { quote: "丙", goal }],
      callModel: async () => reply([{ id: 1, to: "改了甲。" }]),
    });
    expect(out).toMatchObject({ text: "改了甲。乙。丙。\n", applied: [0], failed: [{ fix: 1, why: "AI 没给出这句的改法" }] });
    expect(out.changes).toEqual([{ from: "甲。", to: "改了甲。" }]);
  });

  it("to 给空串 = 删掉这句", async () => {
    const out = await fixByUnits({ chapter: 5, text: "甲。乙。丙。\n", fixes: [{ quote: "乙", goal }], callModel: async () => reply([{ id: 2, to: "" }]) });
    expect(out).toMatchObject({ text: "甲。丙。\n", applied: [0] });
  });

  it("模型调用报错：不重试，照实说，正文不动", async () => {
    const callModel = vi.fn(async () => { throw new Error("服务商超时"); });
    const out = await fixByUnits({ chapter: 5, text: "他走了。\n", fixes: [{ quote: "他走了", goal }], callModel });
    expect(callModel).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ text: "他走了。\n", applied: [], failed: [{ fix: 0, why: "AI 没改成（服务商超时）" }] });
  });
});

describe("fixDraftByUnits：改完走 AI 写稿唯一通道（写作版本 P1b）", () => {
  async function book(body: string) {
    const rootDir = await makeHomeTempDir("unit-fix-");
    const { projectDir } = await createStoryProject({ rootDir, title: "白沙渡", genre: "武侠", protagonistName: "许微" });
    const saved = await runCommand(projectDir, draftSave, { chapter: 5, title: "", body, baseVersion: null }, { caller: "author" });
    if (!saved.ok) throw new Error(saved.message);
    return { rootDir, projectDir };
  }
  const authorSaves = async (projectDir: string, body: string) => {
    const outcome = await runCommand(projectDir, draftSave, { chapter: 5, title: "", body, baseVersion: (await readDraft(projectDir, 5))?.version ?? null }, { caller: "author" });
    if (!outcome.ok) throw new Error(outcome.message);
  };

  it("稿子没动 → 换上、存档可撤销", async () => {
    const { rootDir, projectDir } = await book("他走了。\n许微没接话。");
    const out = await fixDraftByUnits({ projectDir, chapter: 5, fixes: [{ quote: "许微没接话", goal }], callModel: async () => reply([{ id: 2, to: "许微点了点头。" }]) });
    expect(out.kept).toBeUndefined();
    expect(typeof out.snapshotId).toBe("string");
    expect((await readDraft(projectDir, 5))?.body).toBe("他走了。\n许微点了点头。");
    await rm(rootDir, { recursive: true, force: true });
  });

  it("模型改的时候作者存了稿 → 不换、留成候选、如实说；作者那份不动", async () => {
    const { rootDir, projectDir } = await book("他走了。\n许微没接话。");
    const out = await fixDraftByUnits({
      projectDir, chapter: 5, fixes: [{ quote: "许微没接话", goal }],
      callModel: async () => {
        await authorSaves(projectDir, "他走了。\n许微没接话。\n作者又加了一句。");
        return reply([{ id: 2, to: "许微点了点头。" }]);
      },
    });
    expect(out.kept?.message).toContain("AI 这版没换上");
    expect((await readDraft(projectDir, 5))?.body).toBe("他走了。\n许微没接话。\n作者又加了一句。");
    expect(await readDraftCandidate(projectDir, out.kept!.candidateId)).toMatchObject({ source: "unit-fix", reason: "draft_moved" });
    await rm(rootDir, { recursive: true, force: true });
  });
});
