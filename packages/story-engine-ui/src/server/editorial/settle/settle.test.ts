// @vitest-environment node
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chapterCommit, draftPath, numberedText, projectBook, readBible, readChapterLedger, readDecisions, runCommand, splitUnits, type EntryInput } from "@actalk/story-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHomeTempDir } from "../../lib/home-test-tmp.js";
import type { BrainCallModel } from "../reader-window.js";
import { canonTask, parseFieldEdits, parseSweepEdits, proposeSettle, reviewTask } from "./propose.js";
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
function fakeModel(over: { sweepFails?: boolean; factsReply?: string; reviewReply?: string; canonReply?: string; namesReply?: string } = {}): BrainCallModel & { prompts: string[] } {
  const prompts: string[] = [];
  const call: BrainCallModel = async (messages) => {
    const prompt = messages.at(-1)?.content ?? "";
    prompts.push(prompt);
    if (prompt.includes("写成一条「定论」")) return over.canonReply ?? JSON.stringify({ canon: "杜长顺十年前去世", names: ["杜叔"] });
    if (prompt.includes("列出这件事涉及的")) return over.namesReply ?? JSON.stringify({ names: ["杜叔"] });
    if (prompt.includes("设定本里相关的几栏")) return JSON.stringify({ edits: [] });
    if (prompt.includes("请逐条复核")) return over.reviewReply ?? JSON.stringify({ verdicts: [{ id: 1, conflict: true }, { id: 2, conflict: true }] });
    if (prompt.includes("账里这几条")) return over.factsReply ?? JSON.stringify({ facts: [{ id: "F1", action: "update", value: "十年前", text: "杜长顺十年前去世", quote: "杜叔走了十年了" }] });
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
    expect(proposal.missed).toEqual([]);
    expect(proposal.failures).toEqual([]);
    expect(model.prompts.find((prompt) => prompt.includes("写成一条「定论」"))).toContain("前后文");
  });

  it("复核：作者点的那句不问；别的说不对不上的去掉，复核没做成就留着、如实说", async () => {
    const model = fakeModel({ reviewReply: JSON.stringify({ verdicts: [{ id: 1, conflict: "false" }] }) });
    const outcome = await proposeSettle({ projectDir: dir, request: pick, callModel: model });
    if (!outcome.ok) throw new Error(outcome.message);
    expect(outcome.proposal.edits.map((edit) => [edit.key, edit.chapter])).toEqual([["e1", 4]]);
    const review = model.prompts.find((prompt) => prompt.includes("请逐条复核"))!;
    expect(review).toContain("“杜叔走了五年了。”");
    expect(review).not.toContain("说他五年前就没了");

    expect(outcome.proposal.reviewDropped).toEqual([expect.objectContaining({ chapter: 2, from: "“杜叔走了五年了。”" })]);

    const broken = await proposeSettle({ projectDir: dir, request: pick, callModel: fakeModel({ reviewReply: "不是 JSON" }) });
    if (!broken.ok) throw new Error(broken.message);
    expect(broken.proposal.edits).toHaveLength(2);
    expect(broken.proposal.failures).toEqual([expect.stringContaining("复核没做成")]);
  });

  it("核账卡上同一条报的别几句（also）：章一定查、提示里点名、不复核；没查出改法的如实列出", async () => {
    const model = fakeModel({ reviewReply: JSON.stringify({ verdicts: [] }) });
    const outcome = await proposeSettle({
      projectDir: dir,
      request: { ...pick, also: [{ where: "chapter", chapter: 2, quote: "杜叔走了五年了" }, { where: "chapter", chapter: 3, quote: "海风很冷" }] },
      callModel: model,
    });
    if (!outcome.ok) throw new Error(outcome.message);
    const sweep = model.prompts.find((prompt) => prompt.includes("逐句看"))!;
    expect(sweep).toContain("核账已经报过这几句和它对不上，一定给出改法：第 4 章「说他五年前就没了」；第 2 章「杜叔走了五年了」；第 3 章「海风很冷」");
    expect(model.prompts.some((prompt) => prompt.includes("请逐条复核"))).toBe(false);
    expect(outcome.proposal.searched).toContain(3);
    expect(outcome.proposal.missed).toEqual([{ chapter: 3, quote: "海风很冷" }]);
  });

  it("定论只写打架的那一点：提示里说清楚", async () => {
    const model = fakeModel();
    await proposeSettle({ projectDir: dir, request: pick, callModel: model });
    const canonPrompt = model.prompts.find((prompt) => prompt.includes("写成一条「定论」"));
    expect(canonPrompt).toContain("写成一个问句");
    expect(canonPrompt).toContain("只答这一点");
  });

  // 长篇实跑：「以第 14 章为准」定成「某人手里攥着木杠」，扫全书把别章里放在膝上、打架顺手抄的、别人拿着的都列进来要改。
  it("会变的状态写那件东西本身、不写一时的拿法；扫和复核都不算一时的拿法、放法", async () => {
    const model = fakeModel();
    await proposeSettle({ projectDir: dir, request: pick, callModel: model });
    expect(model.prompts.find((prompt) => prompt.includes("写成一条「定论」"))).toContain("别写一时的拿法、姿势");
    expect(model.prompts.find((prompt) => prompt.includes("逐句看"))).toContain("原句只是那一场里一时的拿法、放法");
    expect(canonTask(pick, new Map())).toContain("写那件东西本身");
    expect(reviewTask("某某随身带的是一把黑伞。", [{ chapter: 2, target: "committed", id: 1, from: "甲", to: "乙" }])).toContain("顺手抄起的别的东西");
  });

  // 长篇实跑：核账报「昨夜在风口坐了半宿」和前一章「山沟里没风」打架，点「以第 23 章为准」把「那夜山沟里没风」记成了全书定论。
  it("只是那一场的事（keep 给 false）：句子照改，不记进设定本「定论」", async () => {
    const model = fakeModel({ canonReply: JSON.stringify({ canon: "杜长顺十年前去世", names: ["杜叔"], keep: "false" }) });
    const outcome = await proposeSettle({ projectDir: dir, request: pick, callModel: model });
    if (!outcome.ok) throw new Error(outcome.message);
    expect(model.prompts.find((prompt) => prompt.includes("写成一条「定论」"))).toContain("过了那一场就用不着");
    expect(outcome.proposal.sceneOnly).toBe(true);
    const applied = await applySettleProposal(dir, (await saveSettleProposal(dir, outcome.proposal)).token, []);
    if (!applied.ok) throw new Error(applied.message);
    expect(await readFile(join(dir, "chapters/0002.md"), "utf-8")).toContain("“杜叔走了十年了。”");
    expect(applied.result.cardLines).toEqual([]);
    expect(JSON.parse(await readFile(join(dir, "ledger/cards.json"), "utf-8").catch(() => "{}")).canon ?? []).toEqual([]);

    const kept = await proposeSettle({ projectDir: dir, request: pick, callModel: fakeModel() });
    if (!kept.ok) throw new Error(kept.message);
    expect(kept.proposal.sceneOnly).toBeUndefined();
  });

  it("核的是已定稿的章：改定稿正文，工作稿里同一句跟着改；定稿后改过工作稿、报的那句只在工作稿里，才改工作稿", async () => {
    const onTwo = { ...pick, chapter: 2, other: { where: "chapter" as const, chapter: 2, quote: "杜叔走了五年了" } };
    await writeFile(join(dir, draftPath(2)), CH2);
    const outcome = await proposeSettle({ projectDir: dir, request: onTwo, callModel: fakeModel() });
    if (!outcome.ok) throw new Error(outcome.message);
    expect(outcome.proposal.edits.filter((edit) => edit.chapter === 2).map((edit) => edit.target)).toEqual(["committed"]);
    const applied = await applySettleProposal(dir, (await saveSettleProposal(dir, outcome.proposal)).token, []);
    if (!applied.ok) throw new Error(applied.message);
    expect(await readFile(join(dir, "chapters/0002.md"), "utf-8")).toContain("“杜叔走了十年了。”");
    expect(await readFile(join(dir, draftPath(2)), "utf-8")).toContain("“杜叔走了十年了。”");

    await writeFile(join(dir, draftPath(3)), "# 第3章 · 码头\n\n海风很冷。“杜叔走了五年了。”孟叔又说。\n");
    const edited = await proposeSettle({
      projectDir: dir,
      request: { ...pick, chapter: 3, other: { where: "chapter", chapter: 3, quote: "“杜叔走了五年了。”孟叔又说" } },
      callModel: async (messages, options) => {
        const prompt = messages.at(-1)?.content ?? "";
        const three = /【第 3 章（工作稿）】\n[\s\S]*?\[(\d+)\]“杜叔走了五年了。”/u.exec(prompt);
        return prompt.includes("逐句看")
          ? JSON.stringify({ edits: three ? [{ chapter: 3, id: Number(three[1]), to: "“杜叔走了十年了。”" }] : [] })
          : fakeModel()(messages, options);
      },
    });
    if (!edited.ok) throw new Error(edited.message);
    expect(edited.proposal.edits.filter((edit) => edit.chapter === 3).map((edit) => edit.target)).toEqual(["draft"]);
  });

  it("整批查时漏了作者点的那句：只拿那一章单问一次；别的句子不从补问里收", async () => {
    let sweeps = 0;
    const base = fakeModel({ reviewReply: JSON.stringify({ verdicts: [] }) });
    const outcome = await proposeSettle({
      projectDir: dir,
      request: pick,
      callModel: async (messages, options) => {
        const prompt = messages.at(-1)?.content ?? "";
        if (!prompt.includes("逐句看")) return base(messages, options);
        sweeps += 1;
        if (sweeps === 1) return JSON.stringify({ edits: [] });
        expect(prompt).toContain("【第 4 章（工作稿）】");
        expect(prompt).not.toContain("【第 1 章】");
        return JSON.stringify({ edits: [{ chapter: 4, id: 1, to: "孟叔又提起杜叔，说他十年前就没了。" }, { chapter: 4, id: 2, to: "许微点头。" }] });
      },
    });
    if (!outcome.ok) throw new Error(outcome.message);
    expect(sweeps).toBe(2);
    expect(outcome.proposal.edits.map((edit) => [edit.chapter, edit.to])).toEqual([[4, "孟叔又提起杜叔，说他十年前就没了。"]]);
    expect(outcome.proposal.missed).toEqual([]);
  });

  it("一批没查成如实记下，不当成没有要改的", async () => {
    const outcome = await proposeSettle({ projectDir: dir, request: pick, callModel: fakeModel({ sweepFails: true }) });
    if (!outcome.ok) throw new Error(outcome.message);
    expect(outcome.proposal.edits).toEqual([]);
    expect(outcome.proposal.failures[0]).toContain("这一批没查成");
    expect(outcome.proposal.missed).toEqual([{ chapter: 4, quote: "说他五年前就没了" }]);
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
    // 设定本里已经记着的那条：不再问是不是改哪条。
    expect(model.prompts.find((prompt) => prompt.includes("列出这件事涉及的"))).not.toContain("replaces");
  });

  // 作者长篇实跑（2026-10-26）：「那条定论过时了，改成…」记成了第二条，旧的还在，核账照旧拿旧的报。
  it("改的是设定本里已有的那条：卡上带着旧的，确认后换掉它、不另加；模型说不是就照常加", async () => {
    const first = await proposeSettle({ projectDir: dir, request: pick, callModel: fakeModel() });
    if (!first.ok) throw new Error(first.message);
    const applied = await applySettleProposal(dir, (await saveSettleProposal(dir, first.proposal)).token, []);
    if (!applied.ok) throw new Error(applied.message);

    const model = fakeModel({ namesReply: JSON.stringify({ names: ["杜叔"], replaces: 1 }) });
    const outcome = await proposeSettle({ projectDir: dir, request: { kind: "statement", text: "杜长顺是八年前去世的" }, callModel: model });
    if (!outcome.ok) throw new Error(outcome.message);
    const asked = model.prompts.find((prompt) => prompt.includes("列出这件事涉及的"))!;
    expect(asked).toContain("[1] 杜长顺十年前去世");
    expect(outcome.proposal).toMatchObject({ canon: "杜长顺是八年前去世的", canonExists: false, replaces: { text: "杜长顺十年前去世" } });
    const replaced = await applySettleProposal(dir, (await saveSettleProposal(dir, outcome.proposal)).token, []);
    if (!replaced.ok) throw new Error(replaced.message);
    expect((await readBible(dir)).bible.canon.map((item) => item.text)).toEqual(["杜长顺是八年前去世的"]);

    const other = await proposeSettle({ projectDir: dir, request: { kind: "statement", text: "孟叔是杜长顺的表弟" }, callModel: fakeModel({ namesReply: JSON.stringify({ names: ["孟叔"], replaces: 0 }) }) });
    if (!other.ok) throw new Error(other.message);
    expect(other.proposal.replaces).toBeUndefined();
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

  it("老书的账没记原句的事实也问一次：回 drop 的确认后作废，回 keep / 没回的不动", async () => {
    const path = join(dir, "ledger/chapters/0002.json");
    const raw = { ...(JSON.parse(await readFile(path, "utf-8")) as { entries: Record<string, unknown>[] }), origin: "import" };
    raw.entries.push(
      { kind: "fact", review: "auto", nature: "event", text: "孟叔记得杜叔五年前走的", id: "fact-2-90" },
      { kind: "fact", review: "auto", nature: "event", text: "码头上常年起雾", id: "fact-2-91" },
    );
    await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`);
    const model = fakeModel({ factsReply: JSON.stringify({ facts: [
      { id: "F1", action: "update", value: "十年前", text: "杜长顺十年前去世", quote: "杜叔走了十年了" },
      { id: "L1", action: "drop" },
      { id: "L2", action: "keep" },
    ] }) });
    const outcome = await proposeSettle({ projectDir: dir, request: pick, callModel: model });
    if (!outcome.ok) throw new Error(outcome.message);
    expect(model.prompts.find((prompt) => prompt.includes("没记原句"))).toContain("孟叔记得杜叔五年前走的");
    expect(outcome.proposal.facts.map((fact) => [fact.factId, fact.after ?? null, fact.loose ?? false])).toEqual([
      ["fact-2-90", null, true],
      [expect.any(String), "杜长顺十年前去世", false],
    ]);
    const applied = await applySettleProposal(dir, (await saveSettleProposal(dir, outcome.proposal)).token, []);
    if (!applied.ok) throw new Error(applied.message);
    expect(applied.result.chapters[0]).toMatchObject({ factsUpdated: ["杜长顺十年前去世"], factsRetracted: ["孟叔记得杜叔五年前走的"] });
    expect((await readDecisions(dir)).map((decision) => (decision.type === "fact.retract" ? decision.fact : ""))).toEqual(["fact-2-90"]);
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

describe("改法解析", () => {
  it("新句抄了上一句（一段对话切成两句）：去掉抄的那截再换，正文不会重复", () => {
    const text = "“许微，那都是多少年前的事了。你爸没了十五年了，你翻这些有什么用。”";
    const units = splitUnits(text);
    const doc = { chapter: 2, target: "committed" as const, text, units, numbered: numberedText(units) };
    const reply = JSON.stringify({ edits: [{ chapter: 2, id: 2, to: "许微，那都是多少年前的事了。你爸失踪十五年了，你翻这些有什么用。”" }] });
    expect(parseSweepEdits(reply, [doc])).toEqual([
      { chapter: 2, target: "committed", id: 2, from: "你爸没了十五年了，你翻这些有什么用。”", to: "你爸失踪十五年了，你翻这些有什么用。”" },
    ]);
  });

  it("整栏内容抄回了栏头（卡名 · 栏名：）和「（AI 补的）」：去掉，只留内容", () => {
    const fields = [
      { id: "S1", label: "历史", value: "十五年前海难结案", ai: false },
      { id: "S2", card: "许微", label: "年龄", value: "三十岁", ai: true },
    ];
    const reply = JSON.stringify({ edits: [
      { id: "S1", to: "故事设定 · 历史：十五年前按失踪结案" },
      { id: "S2", to: "[S2]许微 · 年龄：二十九岁（AI 补的）" },
    ] });
    expect(parseFieldEdits(reply, fields)).toEqual([
      { label: "历史", from: "十五年前海难结案", to: "十五年前按失踪结案" },
      { card: "许微", label: "年龄", from: "三十岁", to: "二十九岁" },
    ]);
  });
});
