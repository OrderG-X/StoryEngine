// @vitest-environment node
// draft.change 改稿三种（写作版本 P2a 片 2C）：fix（核账卡改这处）、deai（AI 味卡改掉这句 / 一键全修）、revise（对话改稿、选中文字改写）。
// 没稿不受理；改成了换上、存档可撤销；一处没改成如实说为什么、稿子不动；写的途中作者存了稿留成候选；
// revise 带 preview 停下等作者：换上 / 再改一版 / 不要了；看的时候稿子改过就作废。真配方 + 真执行器 + 真核心写盘，只换模型。
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { draftSave, readDraft, readDraftState, runCommand } from "@actalk/story-core";
import { createStoryProject } from "../../../book/project-store.js";
import { pendingDraftFor } from "../../../lib/draft-candidates.js";
import { readFixLog } from "../../../lib/fix-log.js";
import { makeHomeTempDir } from "../../../lib/home-test-tmp.js";
import { __resetExecutionsForTests } from "../../../lib/operations/context.js";
import { __resetLiveForTests } from "../../../lib/operations/live.js";
import { __resetOperationStoreForTests, readOperation } from "../../../lib/operations/store.js";
import { listSnapshots } from "../../../lib/snapshot.js";
import { operationView } from "../view.js";
import { __drainOperationsForTests, __resetRecipesForTests, cancelOperation, resumeOperation } from "../executor.js";
import type { BrainCallModel } from "../../../editorial/index.js";
import { fakeDraftDeps, quietReader, runDraftEdit, settledDraftChange, submitDraftChange } from "./draft-change-kit.js";

let root: string;
let book: string;

beforeEach(async () => {
  __resetOperationStoreForTests();
  __resetExecutionsForTests();
  __resetLiveForTests();
  __resetRecipesForTests();
  root = await makeHomeTempDir("draft-edit-");
  vi.stubEnv("SE_DATA_DIR", join(root, "data"));
  ({ projectDir: book } = await createStoryProject({ rootDir: root, title: "改一改", genre: "都市", protagonistName: "林远" }));
});
afterEach(async () => {
  await __drainOperationsForTests();
  __resetRecipesForTests();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

async function save(chapter: number, body: string): Promise<void> {
  const baseVersion = (await readDraftState(book, chapter)).version;
  expect(await runCommand(book, draftSave, { chapter, body, baseVersion, title: "" }, { caller: "author" })).toMatchObject({ ok: true });
}

const bodyOf = async (chapter: number): Promise<string | undefined> => (await readDraft(book, chapter))?.body;
const reviseReply = (beforeText: string, afterText: string, changeSummary = "改了") => JSON.stringify({ beforeText, afterText, changeSummary });
const goal = "和第 10 章「八几年就没了」对上";

/**
 * 假核账员（改完再核用）：核的那份稿里有 when 的几句（都有）就报 conflict；自复核都判 sure；别的都说没问题。
 */
function recheckReader(rules: readonly { readonly when: readonly string[]; readonly conflict: Record<string, unknown> }[]): BrainCallModel {
  return async (messages, options) => {
    if (!options?.json) return "笔记。";
    const last = messages.at(-1)!.content;
    if (last.includes("你刚才核完报了")) {
      const ids = [...last.matchAll(/【(K\d+)】/gu)].map((match) => match[1]);
      return JSON.stringify({ verdicts: ids.map((id) => ({ id, verdict: "sure" })) });
    }
    const all = messages.map((message) => message.content).join("\n");
    return JSON.stringify({ checks: [], pairs: [], contradictions: rules.filter((rule) => rule.when.every((text) => all.includes(text))).map((rule) => rule.conflict) });
  };
}

describe("受理前", () => {
  it("没有工作稿 → no_draft，不调模型", async () => {
    const fixCallModel = vi.fn(async () => "{}");
    expect(await submitDraftChange(book, "fix", { chapter: 3, fixes: [{ targetText: "甲", revisionGoal: goal }] }, fakeDraftDeps({ fixCallModel }))).toMatchObject({ ok: false, code: "no_draft" });
    expect(fixCallModel).not.toHaveBeenCalled();
  });

  it("参数缺了 → bad_params", async () => {
    expect(await submitDraftChange(book, "revise", { chapter: 1, edits: [] })).toMatchObject({ ok: false, code: "bad_params" });
    expect(await submitDraftChange(book, "deai", { chapter: 1, violations: [{ id: "v1" }] })).toMatchObject({ ok: false, code: "bad_params" });
  });
});

describe("fix：核账卡改这处", () => {
  it("几处一次交模型、按编号换；换上前存档、改句记录记上；结论说改了几处", async () => {
    await save(1, "他说那家店八几年还开着。老周点头。\n天黑了。");
    const fixCallModel = vi.fn(async (prompt: string) => {
      expect(prompt).toContain("和第 10 章");
      return JSON.stringify({ edits: [{ id: 1, to: "他说那家店八几年就没了。" }, { id: 3, to: "天快黑了。" }] });
    });
    const { record, body, summary } = await runDraftEdit(book, "fix", { chapter: 1, fixes: [{ targetText: "八几年还开着", revisionGoal: goal }, { targetText: "天黑了", revisionGoal: goal }] }, fakeDraftDeps({ fixCallModel }));
    expect(record.state).toBe("succeeded");
    expect(fixCallModel).toHaveBeenCalledTimes(1);
    expect(await bodyOf(1)).toBe("他说那家店八几年就没了。老周点头。\n天快黑了。");
    // 改完自己再核了一遍（只核改过的句子）：没有对不上的了。
    expect(summary).toBe("第 1 章改好了 2 处（可撤销）。改完再核没有对不上的了。");
    expect(body).toMatchObject({ kind: "draft.change", mode: "fix", ok: true, chapter: 1, failed: [], verify: { checks: 1, again: 0 } });
    // 再核一处不剩：作者点的这几处都算改掉了（核账卡照它划掉，真机 2026-11-06）。
    expect(body?.settled).toEqual([{ quote: "八几年还开着", goal }, { quote: "天黑了", goal }]);
    expect(body?.changes).toEqual([{ from: "他说那家店八几年还开着。", to: "他说那家店八几年就没了。" }, { from: "天黑了。", to: "天快黑了。" }]);
    expect((await listSnapshots(book)).some((snapshot) => snapshot.id === body?.snapshotId)).toBe(true);
    expect((await readFixLog(book, 1)).map((entry) => entry.to)).toContain("天快黑了。");
  });

  it("改完再核还有对不上的（本章别处还照改前说）：再改一轮、再核，两轮一起换上、一个存档点；两轮的改句都记上", async () => {
    await save(1, "钟停在三点。老周看了一眼，说是三点。\n天黑了。");
    const prompts: string[] = [];
    const fixCallModel = vi.fn(async (prompt: string) => {
      prompts.push(prompt);
      return prompts.length === 1
        ? JSON.stringify({ edits: [{ id: 1, to: "钟停在四点。" }] })
        : JSON.stringify({ edits: [{ id: 2, to: "老周看了一眼，说是四点。" }] });
    });
    const reader = recheckReader([{ when: ["钟停在四点。", "说是三点。"], conflict: { quote: "老周看了一眼，说是三点。", earlierQuote: "钟停在四点。", earlierChapter: 1, reason: "钟停的时刻对不上", confidence: "sure" } }]);
    const { record, body, summary } = await runDraftEdit(book, "fix", { chapter: 1, fixes: [{ targetText: "钟停在三点", revisionGoal: goal }] }, fakeDraftDeps({ fixCallModel, readerCallModel: reader }));
    expect(record.state).toBe("succeeded");
    expect(fixCallModel).toHaveBeenCalledTimes(2);
    // 第二轮的改法：和本章那句对上；那句不是第一轮改出来的，不带第一轮的要求。
    expect(prompts[1]).toContain("和本章前面「钟停在四点。」对上（钟停的时刻对不上）");
    expect(prompts[1]).not.toContain("两样都要对得上");
    expect(await bodyOf(1)).toBe("钟停在四点。老周看了一眼，说是四点。\n天黑了。");
    expect(summary).toBe("第 1 章改好了这一处（可撤销）。改完再核又跟着改了 1 句，没有对不上的了。");
    expect(body?.verify).toEqual({ checks: 2, again: 1 });
    // 第二轮按再核报的改的那条也算（原句 + 前文原句认，作者没点它也划，外部审查 2026-11-06）。
    expect(body?.settled).toEqual([{ quote: "钟停在三点", goal }, { quote: "老周看了一眼，说是三点。", earlierQuote: "钟停在四点。" }]);
    expect(body?.changes).toEqual([{ from: "钟停在三点。", to: "钟停在四点。" }, { from: "老周看了一眼，说是三点。", to: "老周看了一眼，说是四点。" }]);
    expect((await listSnapshots(book)).filter((snapshot) => snapshot.label === "第1章按核账改前快照")).toHaveLength(1);
    expect((await readFixLog(book, 1)).map((entry) => entry.to)).toEqual(["钟停在四点。", "老周看了一眼，说是四点。"]);
  });

  it("第二轮改的是第一轮刚改出来的句子：改法带上第一轮那条要求；两轮改完还对不上的列给作者（卡上）", async () => {
    await save(1, "钟停在三点。老周点头。\n天黑了。");
    const prompts: string[] = [];
    const fixCallModel = vi.fn(async (prompt: string) => {
      prompts.push(prompt);
      return JSON.stringify({ edits: [{ id: 1, to: prompts.length === 1 ? "钟停在四点。" : "钟停在四点一刻。" }] });
    });
    const conflict = (quote: string) => ({ quote, earlierQuote: "天黑了。", earlierChapter: 1, reason: "天黑了钟不会停在下午", confidence: "sure" });
    const reader = recheckReader([
      { when: ["钟停在四点。"], conflict: conflict("钟停在四点。") },
      { when: ["钟停在四点一刻。"], conflict: conflict("钟停在四点一刻。") },
    ]);
    const { body, summary } = await runDraftEdit(book, "fix", { chapter: 1, fixes: [{ targetText: "钟停在三点", revisionGoal: goal }] }, fakeDraftDeps({ fixCallModel, readerCallModel: reader }));
    expect(prompts[1]).toContain(`这句刚按「${goal}」改过，两样都要对得上`);
    expect(await bodyOf(1)).toBe("钟停在四点一刻。老周点头。\n天黑了。");
    expect(summary).toBe("第 1 章改好了这一处（可撤销）。改完再核又跟着改了 1 句，还有 1 处对不上，在卡上。");
    expect(body?.verify).toMatchObject({ checks: 2, again: 1, left: { chapter: 1, sure: [{ quote: "钟停在四点一刻。" }], maybe: [] } });
    // 还剩的出新卡、旧卡整张作废：不带改掉了哪几处。
    expect(body?.settled).toBeUndefined();
    // 同一句改了两次：给作者看的是最早那版 → 最后那版。
    expect(body?.changes).toEqual([{ from: "钟停在三点。", to: "钟停在四点一刻。" }]);
  });

  it("两处是同一件事的两头：改了一头、另一头 AI 没动，再核不报了就算两处都改好了", async () => {
    await save(1, "“明晚你值班？”孟叔问。今夜值班的是她。");
    const fixCallModel = vi.fn(async () => JSON.stringify({ edits: [{ id: 1, to: "“今晚你值班？”孟叔问。" }] }));
    const { body, summary } = await runDraftEdit(book, "fix", { chapter: 1, fixes: [
      { targetText: "“明晚你值班？”孟叔问。", revisionGoal: "和本章后面「今夜值班的是她。」对上" },
      { targetText: "今夜值班的是她。", revisionGoal: "和本章前面「“明晚你值班？”孟叔问。」对上" },
    ] }, fakeDraftDeps({ fixCallModel }));
    expect(fixCallModel).toHaveBeenCalledTimes(1);
    expect(summary).toBe("第 1 章改好了 2 处（可撤销）。改完再核没有对不上的了。");
    expect(body?.failed).toEqual([]);
  });

  it("点名那句没动、AI 改的是旁边真写了这件事的那句（核账引的是错处旁边那句，2026-11-04）：照换，再核不报了就算改好了", async () => {
    await save(1, "他抬头看了一眼。钟停在三点。天黑了。");
    const prompts: string[] = [];
    const fixCallModel = vi.fn(async (prompt: string) => {
      prompts.push(prompt);
      return JSON.stringify({ edits: [{ id: 2, to: "钟停在四点。" }] });
    });
    const { body, summary } = await runDraftEdit(book, "fix", { chapter: 1, fixes: [{ targetText: "他抬头看了一眼。", revisionGoal: goal }] }, fakeDraftDeps({ fixCallModel }));
    expect(prompts[0]).toContain("改真写了它的那句，点名那句不动");
    expect(await bodyOf(1)).toBe("他抬头看了一眼。钟停在四点。天黑了。");
    expect(summary).toBe("第 1 章改好了这一处（可撤销）。改完再核没有对不上的了。");
    expect(body?.failed).toEqual([]);
    // 改在别处：点名那句还原样在稿里，卡上光看原句认不出改掉了，靠它划掉。
    expect(body?.settled).toEqual([{ quote: "他抬头看了一眼。", goal }]);
  });

  it("再核报的跟这次改的不相干（作者没点、也不是改出来的）：不替作者改，列在卡上", async () => {
    await save(1, "钟停在三点。老周来过。门开着。");
    const fixCallModel = vi.fn(async () => JSON.stringify({ edits: [{ id: 1, to: "钟停在四点。" }] }));
    const reader = recheckReader([{ when: ["钟停在四点。"], conflict: { quote: "门开着。", earlierQuote: "老周来过。", earlierChapter: 1, reason: "老周走时锁了门", confidence: "sure" } }]);
    const { body, summary } = await runDraftEdit(book, "fix", { chapter: 1, fixes: [{ targetText: "钟停在三点", revisionGoal: goal }] }, fakeDraftDeps({ fixCallModel, readerCallModel: reader }));
    expect(fixCallModel).toHaveBeenCalledTimes(1);
    expect(await bodyOf(1)).toBe("钟停在四点。老周来过。门开着。");
    expect(summary).toBe("第 1 章改好了这一处（可撤销）。改完再核还有 1 处对不上，在卡上。");
    expect(body?.verify).toMatchObject({ checks: 1, again: 0, left: { sure: [{ quote: "门开着。" }] } });
  });

  it("改完再核没跑成：照样换上，结论说一句、定稿时再核", async () => {
    await save(1, "他说那家店八几年还开着。老周点头。");
    const fixCallModel = async () => JSON.stringify({ edits: [{ id: 1, to: "他说那家店八几年就没了。" }] });
    const reader: BrainCallModel = async (messages, options) => {
      if (options?.json) throw new Error("服务商 502");
      return quietReader(messages, options);
    };
    const { record, body, summary } = await runDraftEdit(book, "fix", { chapter: 1, fixes: [{ targetText: "八几年还开着", revisionGoal: goal }] }, fakeDraftDeps({ fixCallModel, readerCallModel: reader }));
    expect(record.state).toBe("succeeded");
    expect(await bodyOf(1)).toBe("他说那家店八几年就没了。老周点头。");
    expect(body?.verify?.checks).toBe(0);
    expect(body?.settled).toBeUndefined();
    expect(summary).toMatch(/^第 1 章改好了这一处（可撤销）。改完再核没跑成（.+），定稿时会再核。$/u);
  });

  it("原句找不到了：不问模型、稿子不动，记成没做成并说为什么", async () => {
    await save(1, "老周点头。");
    const fixCallModel = vi.fn(async () => "{}");
    const { record } = await runDraftEdit(book, "fix", { chapter: 1, fixes: [{ targetText: "八几年还开着", revisionGoal: goal }] }, fakeDraftDeps({ fixCallModel }));
    expect(fixCallModel).not.toHaveBeenCalled();
    expect(record).toMatchObject({ state: "failed", failure: { code: "not_changed", message: "这一处没改成：原句在稿里找不到了（可能已经改过）。" } });
    expect(await bodyOf(1)).toBe("老周点头。");
  });

  it("模型改的时候作者存了稿：不换、留成候选、如实说；作者那份不动", async () => {
    await save(1, "他走了。\n许微没接话。");
    const fixCallModel = async (): Promise<string> => {
      await save(1, "他走了。\n许微没接话。\n作者又加了一句。");
      return JSON.stringify({ edits: [{ id: 2, to: "许微点了点头。" }] });
    };
    const { record, body, summary } = await runDraftEdit(book, "fix", { chapter: 1, fixes: [{ targetText: "许微没接话", revisionGoal: goal }] }, fakeDraftDeps({ fixCallModel }));
    expect(record.state).toBe("succeeded");
    expect(body).toMatchObject({ ok: false, kept: { reason: "draft_moved" } });
    expect(summary).toContain("AI 这版没换上");
    expect(await bodyOf(1)).toBe("他走了。\n许微没接话。\n作者又加了一句。");
    expect(await pendingDraftFor(book, 1)).toMatchObject({ kind: "candidate", body: "他走了。\n许微点了点头。" });
  });
});

describe("deai：AI 味卡改掉这句 / 一键全修", () => {
  it("挑出的几句一次改；没改上的照实说", async () => {
    await save(1, "那一刻，他心中五味杂陈。门开了。仿佛整个世界都安静了。");
    const deAiCallModel = vi.fn(async () => JSON.stringify({ rewrites: [{ text: "那一刻，他心中五味杂陈。", afterText: "他攥紧了拳头。" }] }));
    const { record, body, summary } = await runDraftEdit(book, "deai", {
      chapter: 1,
      violations: [
        { id: "v1", text: "那一刻，他心中五味杂陈。", reason: "套路抒情", severity: "high" },
        { id: "v2", text: "仿佛整个世界都安静了。", reason: "套路抒情" },
      ],
    }, fakeDraftDeps({ deAiCallModel }));
    expect(record.state).toBe("succeeded");
    expect(await bodyOf(1)).toBe("他攥紧了拳头。门开了。仿佛整个世界都安静了。");
    expect(body?.changes).toEqual([{ from: "那一刻，他心中五味杂陈。", to: "他攥紧了拳头。" }]);
    expect(body?.failed.map((item) => item.target)).toEqual(["仿佛整个世界都安静了。"]);
    expect(summary).toBe("第 1 章改掉了 1 处机器腔（可撤销）。1 处没改成：没定位到，或 AI 没给出能用的改法。");
  });

  it("模型没跑成：记成没做成，稿子不动", async () => {
    await save(1, "那一刻，他心中五味杂陈。");
    const { record } = await runDraftEdit(book, "deai", { chapter: 1, violations: [{ id: "v1", text: "那一刻，他心中五味杂陈。" }] }, fakeDraftDeps({ deAiCallModel: async () => { throw new Error("服务商超时"); } }));
    expect(record).toMatchObject({ state: "failed", failure: { code: "not_changed" } });
    expect(record.failure?.message).toContain("服务商超时");
    expect(await bodyOf(1)).toBe("那一刻，他心中五味杂陈。");
  });
});

describe("revise：对话改稿", () => {
  it("几处按先后在同一份稿上改：后一处的提示里看得到前一处改完的", async () => {
    await save(1, "门厅的灯还是冷的。\n\n林远推开了那扇门，门后是空荡的走廊。");
    const prompts: string[] = [];
    const fixCallModel = vi.fn(async (prompt: string) => {
      prompts.push(prompt);
      return prompts.length === 1
        ? reviseReply("门厅的灯还是冷的。", "门厅的灯换成了暖黄的。")
        : reviseReply("林远推开了那扇门，门后是空荡的走廊。", "林远轻轻带上了那扇门，走廊尽头有光。");
    });
    const { body, summary } = await runDraftEdit(book, "revise", {
      chapter: 1,
      edits: [
        { targetText: "门厅的灯还是冷的。", revisionGoal: "把灯光改成暖的" },
        { targetText: "林远推开了那扇门，门后是空荡的走廊。", revisionGoal: "动作克制些" },
      ],
    }, fakeDraftDeps({ fixCallModel }));
    expect(await bodyOf(1)).toBe("门厅的灯换成了暖黄的。\n\n林远轻轻带上了那扇门，走廊尽头有光。");
    expect(prompts[1]).toContain("门厅的灯换成了暖黄的。");
    expect(summary).toBe("第 1 章改好了 2 处（可撤销）。");
    expect(body).toMatchObject({ mode: "revise", ok: true });
  });

  it("作者给了确切新文本：原样换上、不调模型", async () => {
    await save(1, "林秋，一九八五年春。");
    const fixCallModel = vi.fn(async () => "{}");
    const { summary } = await runDraftEdit(book, "revise", { chapter: 1, edits: [{ targetText: "一九八五年春", replacementText: "一九八七年春" }] }, fakeDraftDeps({ fixCallModel }));
    expect(fixCallModel).not.toHaveBeenCalled();
    expect(await bodyOf(1)).toBe("林秋，一九八七年春。");
    expect(summary).toBe("第 1 章按你给的原文换上了（可撤销）。");
  });

  it("AI 去改了别处：这处没改成、照实说，稿子不动", async () => {
    await save(1, "灯是我亲手关的。\n\n他点了点头，没有说话。");
    const { record } = await runDraftEdit(book, "revise", { chapter: 1, edits: [{ targetText: "灯是我亲手关的。", revisionGoal: "删掉这句" }] }, fakeDraftDeps({
      fixCallModel: async () => reviseReply("他点了点头，没有说话。", "他缓缓点了下头。"),
    }));
    expect(record).toMatchObject({ state: "failed", failure: { code: "not_changed", message: "这一处没改成：AI 去改了别处，不是要改的那段。" } });
    expect(await bodyOf(1)).toBe("灯是我亲手关的。\n\n他点了点头，没有说话。");
  });
});

describe("revise preview：选中文字改写，先给作者看", () => {
  const params = { chapter: 1, edits: [{ targetText: "他推开门。", revisionGoal: "更克制" }], preview: true };

  it("改好停下等作者（不占写位）、稿子不动；点「换上」才换", async () => {
    await save(1, "他推开门。");
    const fixCallModel = vi.fn(async () => reviseReply("他推开门。", "他轻轻推开门。", "放轻动作"));
    const waiting = await runDraftEdit(book, "revise", params, fakeDraftDeps({ fixCallModel }));
    expect(waiting.record.state).toBe("waiting_author");
    expect(await bodyOf(1)).toBe("他推开门。");
    expect(operationView(waiting.record).pendingActions).toEqual([{
      actionId: "confirm:1",
      kind: "draft.revise.confirm",
      decisions: ["apply", "again"],
      preview: { round: 1, changes: [{ from: "他推开门。", to: "他轻轻推开门。" }], failed: [], brief: "放轻动作" },
      decided: false,
    }]);
    // 作者看的时候照常能存稿（写位没被占）。
    expect(await resumeOperation(book, waiting.record.opId, { actionId: "confirm:1", decision: "apply" })).toMatchObject({ ok: true });
    const done = await settledDraftChange(book, waiting.record.opId);
    expect(done.state).toBe("succeeded");
    expect(fixCallModel).toHaveBeenCalledTimes(1);
    expect(await bodyOf(1)).toBe("他轻轻推开门。");
    expect((done.result as { summary?: string }).summary).toBe("第 1 章换上了（可撤销）。");
  });

  it("「再改一版」：带着上一版重改、再停下等；最多改到第 5 版", async () => {
    await save(1, "他推开门。");
    const prompts: string[] = [];
    const fixCallModel = vi.fn(async (prompt: string) => {
      prompts.push(prompt);
      return reviseReply("他推开门。", `他第 ${prompts.length} 次推开门。`);
    });
    const deps = fakeDraftDeps({ fixCallModel });
    const waiting = await runDraftEdit(book, "revise", params, deps);
    const { opId } = waiting.record;
    for (let round = 1; round < 5; round += 1) {
      expect(await resumeOperation(book, opId, { actionId: `confirm:${round}`, decision: "again" })).toMatchObject({ ok: true });
      const next = await settledDraftChange(book, opId);
      expect(next.state).toBe("waiting_author");
    }
    expect(prompts[1]).toContain("上一版改成了「他第 1 次推开门。」");
    const last = (await settledDraftChange(book, opId)).pendingActions.at(-1);
    expect(last).toMatchObject({ actionId: "confirm:5", decisions: ["apply"] });
    expect(await resumeOperation(book, opId, { actionId: "confirm:5", decision: "again" })).toMatchObject({ ok: false, code: "bad_decision" });
    expect(await resumeOperation(book, opId, { actionId: "confirm:5", decision: "apply" })).toMatchObject({ ok: true });
    expect((await settledDraftChange(book, opId)).state).toBe("succeeded");
    expect(fixCallModel).toHaveBeenCalledTimes(5);
    expect(await bodyOf(1)).toBe("他第 5 次推开门。");
  });

  it("「不要了」：停掉，稿子不动", async () => {
    await save(1, "他推开门。");
    const waiting = await runDraftEdit(book, "revise", params, fakeDraftDeps({ fixCallModel: async () => reviseReply("他推开门。", "他轻轻推开门。") }));
    expect(await cancelOperation(book, waiting.record.opId)).toMatchObject({ cancelled: true, record: { state: "cancelled" } });
    expect(await bodyOf(1)).toBe("他推开门。");
  });

  it("看的时候作者改了稿：点「换上」作废、说清，不留候选", async () => {
    await save(1, "他推开门。");
    const waiting = await runDraftEdit(book, "revise", params, fakeDraftDeps({ fixCallModel: async () => reviseReply("他推开门。", "他轻轻推开门。") }));
    await save(1, "他推开门。作者又写了一句。");
    expect(await resumeOperation(book, waiting.record.opId, { actionId: "confirm:1", decision: "apply" })).toMatchObject({ ok: true });
    const done = await settledDraftChange(book, waiting.record.opId);
    expect(done).toMatchObject({ state: "obsolete", failure: { code: "draft_moved" } });
    expect(done.failure?.message).toContain("第 1 章的稿子又改过");
    expect(await bodyOf(1)).toBe("他推开门。作者又写了一句。");
    expect(await pendingDraftFor(book, 1)).toBeUndefined();
  });

  it("一处都没改出来：不停下等，直接说没改成", async () => {
    await save(1, "他推开门。");
    const { record } = await runDraftEdit(book, "revise", params, fakeDraftDeps({ fixCallModel: async () => reviseReply("他推开门。", "他推开门。") }));
    expect(record).toMatchObject({ state: "failed", failure: { code: "not_changed" } });
    expect((await readOperation(book, record.opId)).kind).toBe("record");
  });
});
