// @vitest-environment node
//
// summarizeStateOverview（重构 P9）：概况摘要只说进度、人物名单、设定本几张卡、账的计数和最近时间线；
// 设定本的具体内容（卡上写的、关系、势力）不在这里展开，摘要里指去 read_foundation。
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cardWrite, chapterCommit, runCommand, type CardOp } from "@actalk/story-core";
import { buildStateOverview } from "../book/state-overview.js";
import { seedChapters } from "../book/ledger-test-helpers.js";
import { createStoryProject } from "../book/project-store.js";

import { summarizeStateOverview } from "./overview-summary.js";

async function writeCards(projectDir: string, ops: CardOp[]): Promise<void> {
  const outcome = await runCommand(projectDir, cardWrite, { ops }, { caller: "author", idempotencyKey: `t-${Math.random()}` });
  expect(outcome.ok).toBe(true);
}

async function fixture(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "overview-summary-"));
  const { projectDir } = await createStoryProject({
    rootDir,
    title: "海天魂钢",
    genre: "都市英灵",
    logline: "普通毕业生林序第一次接触魂钢异常反应。",
    protagonistName: "林序",
  });
  await writeCards(projectDir, [
    { op: "card.create", kind: "character", name: "沈知夏", fields: [{ label: "身份", value: "大学同学" }] },
    { op: "relation.set", a: "沈知夏", b: "林序", label: "暗中受财团指派接近林序" },
    { op: "card.create", kind: "place", name: "城东码头" },
    { op: "card.create", kind: "lore", name: "财团", fields: [{ label: "目标", value: "垄断觉醒机会" }] },
  ]);
  // 账里出场过、还没建卡的人。
  const outcome = await runCommand(projectDir, chapterCommit, {
    chapter: 1,
    text: "# 第1章\n\n林序走进码头，老周递给他一张船票。林序在码头拿到船票。",
    entries: [
      { kind: "summary", review: "auto", text: "林序在码头拿到船票。", quote: "林序在码头拿到船票。" },
      { kind: "presence", review: "auto", name: "林序", nameUsed: "林序", viewpoint: true, quote: "林序走进码头" },
      { kind: "presence", review: "auto", name: "周伯", nameUsed: "老周", quote: "老周递给他一张船票" },
    ],
  }, { caller: "author", idempotencyKey: "c1" });
  expect(outcome.ok).toBe(true);
  return projectDir;
}

describe("summarizeStateOverview（重构 P9）", () => {
  it("说进度、主角和其他人物（有卡的和账里出场还没卡的），设定本给计数并指去 read_foundation", async () => {
    const overview = await buildStateOverview({ projectDir: await fixture(), maxTimelineEvents: 8 });
    const summary = summarizeStateOverview(overview);

    expect(summary).toContain("《海天魂钢》（都市英灵）当前进度：第 1 章。");
    expect(summary).toContain("人物：主角 林序；其他人物 沈知夏、周伯。");
    expect(summary).toContain("设定本：人物卡 2 张、地点 1、物品 0、其他设定 1；故事设定写了 2 栏；账里还有 1 个没建卡（细看用 read_foundation）。");
    expect(summary).toContain("最近时间线：林序在码头拿到船票。");
  });

  it("开放线索把推进过、还没收的也算上（换题材长篇实跑第 26 章：14 条推进过没收，报 0 条）", async () => {
    const projectDir = await fixture();
    await seedChapters(projectDir, [
      { chapter: 2, entries: [
        { kind: "thread", thread: "t1", op: "open", type: "question", title: "船票是谁给的", note: "船票" },
        { kind: "thread", thread: "t2", op: "open", type: "question", title: "码头那批货", note: "货" },
        { kind: "thread", thread: "t3", op: "open", type: "question", title: "老周的来历", note: "老周" },
      ] },
      { chapter: 3, entries: [
        { kind: "thread", thread: "t2", op: "advance", note: "货到了" },
        { kind: "thread", thread: "t3", op: "close", note: "老周是船老大" },
      ] },
    ]);
    const summary = summarizeStateOverview(await buildStateOverview({ projectDir }));

    expect(summary).toContain("开放线索 2 条");
  });

  it("设定本的内容不在摘要里展开（关系、卡上写的字走 read_foundation）", async () => {
    const overview = await buildStateOverview({ projectDir: await fixture(), maxTimelineEvents: 8 });
    const summary = summarizeStateOverview(overview);

    expect(summary).not.toContain("暗中受财团指派接近林序");
    expect(summary).not.toContain("垄断觉醒机会");
    expect(summary).not.toContain("大学同学");
  });

  it("新书只有书名：不编题材、不编主角，如实说还没人物、还没开始", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "overview-summary-bare-"));
    const { projectDir } = await createStoryProject({ rootDir, title: "空白书" });
    const summary = summarizeStateOverview(await buildStateOverview({ projectDir }));

    expect(summary.split("\n")[0]).toBe("《空白书》当前进度：尚未开始正式章节。");
    expect(summary).toContain("人物：设定本里还没有人物，账里也没记过。");
    expect(summary).not.toContain("主角");
    expect(summary).not.toContain("没建卡");
    expect(summary).not.toContain("最近时间线");
  });

  it("没标主角时不冒充主角：人物全列在「其他人物」里", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "overview-summary-noprot-"));
    const { projectDir } = await createStoryProject({ rootDir, title: "没标主角" });
    await writeCards(projectDir, [
      { op: "card.create", kind: "character", name: "林远" },
      { op: "card.create", kind: "character", name: "苏晴" },
    ]);
    const summary = summarizeStateOverview(await buildStateOverview({ projectDir }));

    expect(summary).toContain("人物：其他人物 林远、苏晴。");
    expect(summary).not.toContain("主角 ");
  });
});
