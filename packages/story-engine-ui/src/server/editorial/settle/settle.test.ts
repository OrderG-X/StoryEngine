// @vitest-environment node
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chapterCommit, draftPath, projectBook, readBible, readChapterLedger, readDecisions, runCommand, type EntryInput } from "@actalk/story-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHomeTempDir } from "../../lib/home-test-tmp.js";
import type { BrainCallModel } from "../reader-window.js";
import { proposeSettle } from "./propose.js";
import { applySettleProposal, readSettleProposal, saveSettleProposal } from "./store.js";

const CH1 = "# 第1章 · 旧屋\n\n杜叔走了整整十年。屋里没人住过。\n\n许微推开门，灰扑了一脸。";
const CH2 = "# 第2章 · 来信\n\n“杜叔走了五年了。”孟叔说。许微没接话。\n\n雾很大，码头上没人。";
const CH3 = "# 第3章 · 码头\n\n海风很冷。许微数着集装箱。";
const DRAFT4 = "# 第4章 · 夜\n\n孟叔又提起杜叔，说他五年前就没了。许微摇头。\n";

const E1: EntryInput[] = [
  { kind: "summary", review: "auto", text: "许微进杜叔的旧屋", quote: "许微推开门" },
  { kind: "fact", review: "auto", nature: "hard", subject: "杜长顺", attribute: "去世", value: "十年前", text: "杜长顺十年前去世", quote: "杜叔走了整整十年" },
];
const E2: EntryInput[] = [
  { kind: "summary", review: "auto", text: "孟叔说起杜叔", quote: "杜叔走了五年了" },
  { kind: "fact", review: "auto", nature: "hard", subject: "杜长顺", attribute: "去世", value: "五年前", text: "杜长顺五年前去世", quote: "杜叔走了五年了" },
  { kind: "fact", review: "auto", nature: "state", subject: "码头", attribute: "样子", value: "雾大没人", text: "码头雾大没人", quote: "雾很大，码头上没人" },
];
const E3: EntryInput[] = [{ kind: "summary", review: "auto", text: "许微在码头", quote: "许微数着集装箱" }];

let dir: string;
beforeEach(async () => {
  dir = await makeHomeTempDir("settle-");
  const author = (key: string) => ({ caller: "author" as const, idempotencyKey: key });
  for (const [chapter, text, entries] of [[1, CH1, E1], [2, CH2, E2], [3, CH3, E3]] as const) {
    const outcome = await runCommand(dir, chapterCommit, { chapter, text, entries: [...entries] }, author(`c${chapter}`));
    if (!outcome.ok) throw new Error(outcome.message);
  }
  await mkdir(join(dir, "drafts", "fast"), { recursive: true });
  await writeFile(join(dir, draftPath(4)), DRAFT4);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** 假模型：按提示词认是哪一步，回固定的答案；记下每步收到的提示。 */
function fakeModel(over: { sweepFails?: boolean; factsReply?: string } = {}): BrainCallModel & { prompts: string[] } {
  const prompts: string[] = [];
  const call: BrainCallModel = async (messages) => {
    const prompt = messages.at(-1)?.content ?? "";
    prompts.push(prompt);
    if (prompt.includes("写成一条「定论」")) return JSON.stringify({ canon: "杜长顺十年前去世", names: ["杜叔"] });
    if (prompt.includes("列出这件事涉及的")) return JSON.stringify({ names: ["杜叔"] });
    if (prompt.includes("设定本里相关的几栏")) return JSON.stringify({ edits: [] });
    if (prompt.includes("账里这几条事实")) return over.factsReply ?? JSON.stringify({ facts: [{ id: "F1", action: "update", value: "十年前", text: "杜长顺十年前去世", quote: "杜叔走了十年了" }] });
    if (prompt.includes("逐句看")) {
      if (over.sweepFails) throw new Error("连不上");
      const edits = [];
      const ch2 = /\[(\d+)\]“杜叔走了五年了。”/u.exec(prompt);
      if (ch2) edits.push({ chapter: 2, id: Number(ch2[1]), to: "“杜叔走了十年了。”", why: "五年对不上十年" });
      const ch4 = /\[(\d+)\]孟叔又提起杜叔，说他五年前就没了。/u.exec(prompt);
      if (ch4) edits.push({ chapter: 4, id: Number(ch4[1]), to: "孟叔又提起杜叔，说他十年前就没了。", why: "五年对不上十年" });
      // 模型偶尔给不存在的编号、和原句一样的改法：都得丢掉。
      edits.push({ chapter: 2, id: 999, to: "乱来。" }, { chapter: 3, id: 1, to: "海风很冷。" });
      return JSON.stringify({ edits });
    }
    throw new Error(`没想到的提示：${prompt.slice(0, 40)}`);
  };
  return Object.assign(call, { prompts });
}

const pick = {
  kind: "pick" as const,
  chapter: 4,
  truth: { where: "chapter" as const, chapter: 1, quote: "杜叔走了整整十年" },
  other: { where: "chapter" as const, chapter: 4, quote: "说他五年前就没了" },
  reason: "杜叔去世的年份对不上",
};

describe("定论预览", () => {
  it("写定论 → 按名字圈章 → 分批扫 → 账跟着改；没提到名字的章不查", async () => {
    const model = fakeModel();
    const outcome = await proposeSettle({ projectDir: dir, request: pick, callModel: model });
    if (!outcome.ok) throw new Error(outcome.message);
    const { proposal } = outcome;
    expect(proposal.canon).toBe("杜长顺十年前去世");
    expect(proposal.searched).toEqual([1, 2, 4]);
    expect(proposal.edits.map((edit) => [edit.key, edit.chapter, edit.target, edit.from, edit.to])).toEqual([
      ["e1", 2, "committed", "“杜叔走了五年了。”", "“杜叔走了十年了。”"],
      ["e2", 4, "draft", "孟叔又提起杜叔，说他五年前就没了。", "孟叔又提起杜叔，说他十年前就没了。"],
    ]);
    expect(proposal.facts).toEqual([expect.objectContaining({ chapter: 2, before: "杜长顺五年前去世", after: "杜长顺十年前去世" })]);
    expect(proposal.otherMissed).toBeUndefined();
    expect(proposal.failures).toEqual([]);
    expect(model.prompts.find((prompt) => prompt.includes("写成一条「定论」"))).toContain("前后文");
  });

  it("一批没查成如实记下，不当成没有要改的", async () => {
    const outcome = await proposeSettle({ projectDir: dir, request: pick, callModel: fakeModel({ sweepFails: true }) });
    if (!outcome.ok) throw new Error(outcome.message);
    expect(outcome.proposal.edits).toEqual([]);
    expect(outcome.proposal.failures[0]).toContain("这一批没查成");
    expect(outcome.proposal.otherMissed).toEqual({ chapter: 4, quote: "说他五年前就没了" });
  });
});

describe("按已记下的定论查", () => {
  it("带的是半句：用设定本里那一整条，不另记一条", async () => {
    const outcome = await proposeSettle({ projectDir: dir, request: pick, callModel: fakeModel() });
    if (!outcome.ok) throw new Error(outcome.message);
    const applied = await applySettleProposal(dir, (await saveSettleProposal(dir, outcome.proposal)).token, []);
    if (!applied.ok) throw new Error(applied.message);
    const model = fakeModel();
    const again = await proposeSettle({ projectDir: dir, request: { kind: "statement", text: "十年前去世", chapter: 4 }, callModel: model });
    if (!again.ok) throw new Error(again.message);
    expect(again.proposal).toMatchObject({ canon: "杜长顺十年前去世", canonExists: true, failures: [] });
  });
});

describe("确认改齐", () => {
  it("一次写完：定论、定稿章正文和账、工作稿；同一票号点两次只做一次", async () => {
    const outcome = await proposeSettle({ projectDir: dir, request: pick, callModel: fakeModel() });
    if (!outcome.ok) throw new Error(outcome.message);
    const stored = await saveSettleProposal(dir, outcome.proposal);
    expect((await readSettleProposal(dir, stored.token))?.canon).toBe("杜长顺十年前去世");
    const applied = await applySettleProposal(dir, stored.token, []);
    if (!applied.ok) throw new Error(applied.message);
    expect(applied.result.cardLines).toEqual(["记下定论「杜长顺十年前去世」"]);
    expect(applied.result.chapters).toEqual([expect.objectContaining({ chapter: 2, factsUpdated: ["杜长顺十年前去世"], factsRetracted: [] })]);
    expect(await readFile(join(dir, "chapters/0002.md"), "utf-8")).toContain("“杜叔走了十年了。”孟叔说。");
    expect(await readFile(join(dir, draftPath(4)), "utf-8")).toContain("说他十年前就没了。");
    const ledger = await readChapterLedger(dir, 2);
    expect(ledger?.entries.find((entry) => entry.kind === "fact" && entry.subject === "杜长顺")).toMatchObject({ value: "十年前" });
    expect((await projectBook(dir)).conflicts).toEqual([]);
    expect((await readBible(dir)).bible.canon.map((item) => item.text)).toEqual(["杜长顺十年前去世"]);

    const again = await applySettleProposal(dir, stored.token, []);
    expect(again).toMatchObject({ ok: true, replayed: true });
  });

  it("划掉的那处不改；账里那条跟着不动；记账没问成的那条作废并如实说", async () => {
    const outcome = await proposeSettle({ projectDir: dir, request: pick, callModel: fakeModel({ factsReply: "不是 JSON" }) });
    if (!outcome.ok) throw new Error(outcome.message);
    expect(outcome.proposal.failures).toEqual(["第 2 章账里跟着改的那几条没问成（模型回的不是要的格式），确认后这几条会作废"]);
    expect(outcome.proposal.facts).toEqual([{ chapter: 2, factId: expect.any(String), before: "杜长顺五年前去世" }]);
    const stored = await saveSettleProposal(dir, outcome.proposal);
    const skipDraft = await applySettleProposal(dir, stored.token, ["e2"]);
    if (!skipDraft.ok) throw new Error(skipDraft.message);
    expect(skipDraft.result.drafts).toEqual([]);
    expect(await readFile(join(dir, draftPath(4)), "utf-8")).toBe(DRAFT4);
    expect(skipDraft.result.chapters[0]?.factsRetracted).toEqual(["杜长顺五年前去世"]);
    expect((await readDecisions(dir)).map((decision) => decision.type)).toEqual(["fact.retract"]);
  });

  it("预览后正文改过：一处都不改，如实说重新查", async () => {
    const outcome = await proposeSettle({ projectDir: dir, request: pick, callModel: fakeModel() });
    if (!outcome.ok) throw new Error(outcome.message);
    const stored = await saveSettleProposal(dir, outcome.proposal);
    await writeFile(join(dir, draftPath(4)), `${DRAFT4}作者又写了一句。\n`);
    const applied = await applySettleProposal(dir, stored.token, []);
    expect(applied).toMatchObject({ ok: false, code: "draft_moved" });
    expect(await readFile(join(dir, "chapters/0002.md"), "utf-8")).toBe(CH2);
    expect((await readBible(dir)).bible.canon).toEqual([]);
    expect(await applySettleProposal(dir, "0123456789abcdef", [])).toMatchObject({ ok: false, code: "proposal_missing" });
  });
});
