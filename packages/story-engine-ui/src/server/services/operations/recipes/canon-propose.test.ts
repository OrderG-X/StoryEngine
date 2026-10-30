// @vitest-environment node
//
// 定论（写作版本 P2a 片 3C：canon.propose 收编 settle_fact、核账卡「以第 N 章为准」、设定本「查前文」、定论卡「确认」）：
// 查完停下等作者点「确认」，点之前书一点不动；卡上划掉的那几处不改；没有要改的如实说、不出按钮；
// 查完之后书变了就不改、说哪样变了；「以某一边为准」只认按钮。真项目、真存档点、真执行器；核账员是假的。
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chapterCommit, decisionRecord, draftPath, readCards, runCommand, type EntryInput } from "@actalk/story-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createStoryProject } from "../../../book/project-store.js";
import type { BrainCallModel } from "../../../editorial/reader-window.js";
import { __resetCatchUpLocksForTests } from "../../../editorial/reader-window.js";
import { makeHomeTempDir } from "../../../lib/home-test-tmp.js";
import { __resetExecutionsForTests } from "../../../lib/operations/context.js";
import { __resetLiveForTests } from "../../../lib/operations/live.js";
import { __resetOperationStoreForTests, readOperation, type OperationRecord } from "../../../lib/operations/store.js";
import { listSnapshots } from "../../../lib/snapshot.js";
import { __drainOperationsForTests, __resetRecipesForTests, cancelOperation, reconcileOperations, registerRecipe, resumeOperation, submitOperation } from "../executor.js";
import {
  CANON_CONFIRM_ACTION,
  CANON_CONFIRM_KIND,
  CANON_PROPOSE_KIND,
  canonProposeSends,
  createCanonProposeRecipe,
  readCanonProposeParams,
  type CanonConfirmPreview,
  type CanonProposeBody,
} from "./canon-propose.js";

/** 定论改齐那条命令写完之后、配方接着往下之前（模拟进程在这儿没了，Astra 第 12 轮）。 */
const hook = vi.hoisted(() => ({ afterSettle: undefined as undefined | (() => Promise<void>) }));
vi.mock("../../../lib/operations/command.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/operations/command.js")>();
  return {
    ...actual,
    runCommandInOperation: async (...args: Parameters<typeof actual.runCommandInOperation>) => {
      const outcome = await actual.runCommandInOperation(...args);
      if (args[1].name === "settle.apply") await hook.afterSettle?.();
      return outcome;
    },
  };
});

/** 编号只给程序用，给人看的话里一个都不许出现。 */
const RAW_ID = /c\d+-\d|t\d+-\d|F\d|"e\d"(?!:)/u;

const CH1 = "# 第1章 · 旧屋\n\n杜叔走了整整十年。屋里没人住过。\n\n许微推开门，灰扑了一脸。";
const CH2 = "# 第2章 · 来信\n\n“杜叔走了五年了。”孟叔说。许微没接话。\n\n雾很大，码头上没人。";
const DRAFT3 = "# 第3章 · 夜\n\n孟叔又提起杜叔，说他五年前就没了。许微摇头。\n";

const E1: EntryInput[] = [
  { kind: "summary", review: "auto", text: "许微进杜叔的旧屋", quote: "许微推开门" },
  { kind: "fact", review: "auto", nature: "hard", subject: "杜长顺", attribute: "去世", value: "十年前", text: "杜长顺十年前去世", quote: "杜叔走了整整十年" },
];
const E2: EntryInput[] = [
  { kind: "summary", review: "auto", text: "孟叔说起杜叔", quote: "杜叔走了五年了" },
  { kind: "fact", review: "auto", nature: "hard", subject: "杜长顺", attribute: "去世", value: "五年前", text: "杜长顺五年前去世", quote: "杜叔走了五年了" },
];

let root: string;
let book: string;
let model: BrainCallModel;

/** 假核账员：按提示词认是哪一步，回固定的答案；sweep 给 false 就什么都不改。 */
function fakeModel(over: { sweep?: boolean; namesReply?: string } = {}): BrainCallModel {
  return async (messages) => {
    const prompt = messages.at(-1)?.content ?? "";
    if (prompt.includes("写成一条「定论」")) return JSON.stringify({ canon: "杜长顺十年前去世", names: ["杜叔"], keep: true });
    if (prompt.includes("列出这件事涉及的")) return over.namesReply ?? JSON.stringify({ names: ["杜叔"] });
    if (prompt.includes("设定本里相关的几栏")) return JSON.stringify({ edits: [] });
    if (prompt.includes("请逐条复核")) return JSON.stringify({ verdicts: [{ id: 1, conflict: true }, { id: 2, conflict: true }] });
    if (prompt.includes("账里这几条")) return JSON.stringify({ facts: [{ id: "F1", action: "update", value: "十年前", text: "杜长顺十年前去世", quote: "杜叔走了十年了" }] });
    if (prompt.includes("逐句看")) {
      if (over.sweep === false) return JSON.stringify({ edits: [] });
      const edits = [];
      const ch2 = /\[(\d+)\]“杜叔走了五年了。”/u.exec(prompt);
      if (ch2) edits.push({ chapter: 2, id: Number(ch2[1]), to: "“杜叔走了十年了。”", why: "五年对不上十年" });
      const ch3 = /\[(\d+)\]孟叔又提起杜叔，说他五年前就没了。/u.exec(prompt);
      if (ch3) edits.push({ chapter: 3, id: Number(ch3[1]), to: "孟叔又提起杜叔，说他十年前就没了。", why: "五年对不上十年" });
      return JSON.stringify({ edits });
    }
    throw new Error(`没想到的提示：${prompt.slice(0, 40)}`);
  };
}

beforeEach(async () => {
  __resetOperationStoreForTests();
  __resetExecutionsForTests();
  __resetLiveForTests();
  __resetRecipesForTests();
  __resetCatchUpLocksForTests();
  hook.afterSettle = undefined;
  root = await makeHomeTempDir("canon-propose-");
  vi.stubEnv("SE_DATA_DIR", join(root, "data"));
  ({ projectDir: book } = await createStoryProject({ rootDir: root, title: "雾港", genre: "悬疑", protagonistName: "许微" }));
  model = fakeModel();
  registerRecipe(createCanonProposeRecipe({ callModel: (messages, options) => model(messages, options), modelProblem: () => undefined }));
  for (const [chapter, text, entries] of [[1, CH1, E1], [2, CH2, E2]] as const) {
    const outcome = await runCommand(book, chapterCommit, { chapter, text, entries: [...entries] }, { caller: "author", idempotencyKey: `c${chapter}` });
    if (!outcome.ok) throw new Error(outcome.message);
  }
  await mkdir(join(book, "drafts", "fast"), { recursive: true });
  await writeFile(join(book, draftPath(3)), DRAFT3);
});
afterEach(async () => {
  await __drainOperationsForTests();
  __resetRecipesForTests();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

async function stored(opId: string): Promise<OperationRecord> {
  const read = await readOperation(book, opId);
  if (read.kind !== "record") throw new Error("记录没了");
  return read.record;
}

/** 交一次、等它停下（做完 / 没做成 / 等作者）。 */
async function settled(mode: "statement" | "pick", params: Record<string, unknown>, origin: "chat" | "button" = mode === "pick" ? "button" : "chat"): Promise<OperationRecord> {
  const outcome = await submitOperation(book, {
    kind: CANON_PROPOSE_KIND,
    mode,
    params,
    requestKey: randomUUID(),
    issuedAt: new Date().toISOString(),
    origin: origin === "chat" ? { kind: "chat", messageId: randomUUID() } : { kind: "button" },
  });
  if (!outcome.ok || !("record" in outcome)) throw new Error(`没受理：${JSON.stringify(outcome)}`);
  await __drainOperationsForTests();
  return stored(outcome.record.opId);
}

const statement = (text = "杜长顺十年前去世") => settled("statement", { statement: text, chapter: 3 });
const previewOf = (record: OperationRecord): CanonConfirmPreview => record.pendingActions[0]!.preview as CanonConfirmPreview;
const bodyOf = (record: OperationRecord): CanonProposeBody => (record.result as { readonly body: CanonProposeBody }).body;
const summaryOf = (record: OperationRecord): string => (record.result as { readonly summary: string }).summary;
const chapterText = (chapter: number) => readFile(join(book, "chapters", `${String(chapter).padStart(4, "0")}.md`), "utf8");
const draftText = () => readFile(join(book, draftPath(3)), "utf8");
const canonTexts = async (): Promise<string[]> => (await readCards(book))?.canon.map((item) => item.text) ?? [];

async function confirm(record: OperationRecord, excluded?: readonly string[]): Promise<OperationRecord> {
  const outcome = await resumeOperation(book, record.opId, { actionId: CANON_CONFIRM_ACTION, decision: "apply", ...(excluded ? { excluded } : {}) });
  expect(outcome.ok).toBe(true);
  await __drainOperationsForTests();
  return stored(record.opId);
}

describe("交来的参数", () => {
  it("作者定下的说法对话、按钮都认；「以某一边为准」只认按钮；说不清的如实说", () => {
    expect(readCanonProposeParams("chat", { statement: "  杜长顺十年前去世 ", chapter: 3 }, "statement"))
      .toEqual({ mode: "statement", request: { kind: "statement", text: "杜长顺十年前去世", chapter: 3 } });
    expect(readCanonProposeParams("chat", { statement: "" }, "statement")).toEqual({ invalid: "定论的内容不对：一句话说清是什么。" });
    const truth = { where: "chapter", chapter: 1, quote: "杜叔走了整整十年" };
    expect(readCanonProposeParams("chat", { chapter: 3, truth }, "pick")).toEqual({ invalid: "以哪一边为准要你自己在核账卡上点。" });
    expect(readCanonProposeParams("button", { chapter: 3 }, "pick")).toEqual({ invalid: "定论按钮的内容不对，请刷新后再点。" });
    expect(readCanonProposeParams("button", { chapter: 3, truth, item: "k1" }, "pick"))
      .toEqual({ mode: "pick", request: { kind: "pick", chapter: 3, truth: { where: "chapter", chapter: 1, quote: "杜叔走了整整十年" } }, item: "k1" });
    expect(readCanonProposeParams("button", {}, undefined)).toEqual({ invalid: "要定下什么没说清。" });
  });

  it("受理时按书的章数冻结额度", async () => {
    const record = await statement();
    expect(record.budget.limit).toBeGreaterThanOrEqual(canonProposeSends(2));
  });
});

describe("查完停下等作者点「确认」", () => {
  it("卡上列出要改的几句（定稿章 + 工作稿）；点之前书一点没动；卡上的话里没有编号", async () => {
    const record = await statement();
    expect(record.state).toBe("waiting_author");
    expect(record.pendingActions[0]).toMatchObject({ actionId: CANON_CONFIRM_ACTION, kind: CANON_CONFIRM_KIND, decisions: ["apply"] });
    const { card, summary } = previewOf(record);
    expect(card).toMatchObject({ canon: "杜长顺十年前去世", canonExists: false, chapter: 3 });
    expect(card.edits.map((edit) => [edit.chapter, edit.draft, edit.from, edit.to])).toEqual([
      [2, false, "“杜叔走了五年了。”", "“杜叔走了十年了。”"],
      [3, true, "孟叔又提起杜叔，说他五年前就没了。", "孟叔又提起杜叔，说他十年前就没了。"],
    ]);
    expect(summary).toBe("查完了：第 2 章、第 3 章 2 句要改。点「确认」一起改齐，改前存档、能撤销。");
    expect(summary).not.toMatch(RAW_ID);
    expect(await chapterText(2)).toContain("杜叔走了五年了");
    expect(await draftText()).toBe(DRAFT3);
    expect(await canonTexts()).toEqual([]);
  });

  it("作者点了：划掉的那句不改，别的一次改齐、记进设定本、改前存档", async () => {
    const record = await statement();
    const [ch2, ch3] = previewOf(record).card.edits;
    const snapshotsBefore = (await listSnapshots(book)).length;
    const done = await confirm(record, [ch3!.key]);
    expect(done.state).toBe("succeeded");
    expect(bodyOf(done)).toMatchObject({ kind: CANON_PROPOSE_KIND, applied: true, excluded: [ch3!.key], snapshotId: expect.any(String) });
    expect(summaryOf(done)).toMatch(/^改齐了。.*改了第 2 章 1 句.*（可撤销）。$/u);
    expect(summaryOf(done)).not.toMatch(RAW_ID);
    expect(await chapterText(2)).toContain(ch2!.to);
    expect(await draftText()).toBe(DRAFT3);
    expect(await canonTexts()).toEqual(["杜长顺十年前去世"]);
    expect((await listSnapshots(book)).length).toBeGreaterThan(snapshotsBefore);
  });

  it("改齐了、记检查点之前进程没了：接着做照回执报「改齐了」，不照改过的正文重算、不再改一遍（Astra 第 12 轮）", async () => {
    const record = await statement();
    const [ch2] = previewOf(record).card.edits;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let reached!: () => void;
    const appliedOnce = new Promise<void>((resolve) => { reached = resolve; });
    hook.afterSettle = async () => {
      hook.afterSettle = undefined;
      reached();
      await held;
    };
    expect((await resumeOperation(book, record.opId, { actionId: CANON_CONFIRM_ACTION, decision: "apply" })).ok).toBe(true);
    await appliedOnce;
    __resetOperationStoreForTests();
    __resetExecutionsForTests();
    await reconcileOperations(book);
    expect(await stored(record.opId)).toMatchObject({ state: "paused" });
    release();
    const textAfter = await chapterText(2);
    expect(textAfter).toContain(ch2!.to);
    expect((await resumeOperation(book, record.opId)).ok).toBe(true);
    await __drainOperationsForTests();
    const done = await stored(record.opId);
    expect(done.state).toBe("succeeded");
    expect(summaryOf(done)).toMatch(/^改齐了。/u);
    expect(await chapterText(2)).toBe(textAfter);
    expect(await canonTexts()).toEqual(["杜长顺十年前去世"]);
  });

  it("卡上没有的那处划不掉；全划掉了（定论也记着）如实说什么都没改", async () => {
    await confirm(await statement());
    // 同一条再查一遍：定论记着了，前文也改齐了 → 不出按钮。
    const again = await statement();
    expect(again.state).toBe("succeeded");
    expect(again.pendingActions).toEqual([]);
    expect(bodyOf(again).applied).toBe(false);
    expect(summaryOf(again)).toBe("定论「杜长顺十年前去世」：查完了：没有要改的，设定本里也记着这条。");

    await writeFile(join(book, draftPath(3)), DRAFT3);
    const record = await statement();
    expect(record.state).toBe("waiting_author");
    const bad = await resumeOperation(book, record.opId, { actionId: CANON_CONFIRM_ACTION, decision: "apply", excluded: ["nope"] });
    expect(bad).toMatchObject({ ok: false, code: "bad_decision" });
    const keys = previewOf(record).card.edits.map((edit) => edit.key);
    const done = await confirm(record, keys);
    expect(done.state).toBe("failed");
    expect(done.failure?.message).toBe("这条定论已经记着，要改的几处也都划掉了，这次什么都没改。");
    expect(await draftText()).toBe(DRAFT3);
  });

  it("没有要改的新定论：照样停下等作者点（记进设定本）", async () => {
    model = fakeModel({ sweep: false });
    const record = await statement("许微是杜长顺的外甥女");
    expect(record.state).toBe("waiting_author");
    expect(previewOf(record).summary).toBe("查完了：没有要改的。点「记下定论」记进设定本。");
    const done = await confirm(record);
    expect(done.state).toBe("succeeded");
    expect(await canonTexts()).toEqual(["许微是杜长顺的外甥女"]);
  });

  it("作者不要了：书里没动", async () => {
    const record = await statement();
    const cancelled = await cancelOperation(book, record.opId);
    expect(cancelled?.cancelled).toBe(true);
    await __drainOperationsForTests();
    expect((await stored(record.opId)).state).toBe("cancelled");
    expect(await chapterText(2)).toContain("杜叔走了五年了");
    expect(await canonTexts()).toEqual([]);
  });

  it("查完之后书变了：作者点了也不改，说哪样变了", async () => {
    const record = await statement();
    const moved = await runCommand(book, decisionRecord, { decisions: [{ type: "chapter.summary", chapter: 2, text: "孟叔来信。" }] }, { caller: "author", idempotencyKey: "moved" });
    expect(moved.ok).toBe(true);
    const done = await confirm(record);
    expect(done.state).toBe("obsolete");
    expect(done.failure?.message).toMatch(/^查完之后.+改过，这份定论是照改之前查的，没改；要的话重新查一遍。$/u);
    expect(await chapterText(2)).toContain("杜叔走了五年了");
    expect(await canonTexts()).toEqual([]);
  });
});

describe("核账卡上「以第 N 章为准」", () => {
  it("按钮交的：写出定论、点的那条原样带回，改齐后核账卡认它改掉了", async () => {
    const record = await settled("pick", {
      chapter: 3,
      truth: { where: "chapter", chapter: 1, quote: "杜叔走了整整十年" },
      other: { where: "chapter", chapter: 3, quote: "说他五年前就没了" },
      reason: "杜叔去世的年份对不上",
      item: "issue-1",
    });
    expect(record.state).toBe("waiting_author");
    expect(previewOf(record).card).toMatchObject({ canon: "杜长顺十年前去世", resolves: "issue-1" });
    const done = await confirm(record);
    expect(done.state).toBe("succeeded");
    expect(bodyOf(done).card.resolves).toBe("issue-1");
    expect(await draftText()).toContain("说他十年前就没了");
  });

  it("对话交的不受理", async () => {
    const outcome = await submitOperation(book, {
      kind: CANON_PROPOSE_KIND,
      mode: "pick",
      params: { chapter: 3, truth: { where: "chapter", chapter: 1, quote: "杜叔走了整整十年" } },
      requestKey: randomUUID(),
      issuedAt: new Date().toISOString(),
      origin: { kind: "chat", messageId: randomUUID() },
    });
    expect(outcome).toMatchObject({ ok: false, message: "以哪一边为准要你自己在核账卡上点。" });
  });
});
