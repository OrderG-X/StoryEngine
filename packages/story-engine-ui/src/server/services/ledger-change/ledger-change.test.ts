// @vitest-environment node
//
// 改账（写作版本 P2a 片 3B：ledger.change 收编 manage_ledger、「确认改账」、线索板 / 梗概上直接点的）：
// 对话 AI 提的整批停下等作者点「确认改账」，点之前账一点不动；指向哪条按编号或原话查准，查不准如实说；
// 提议之后账变了就不记、说哪样变了；作者在线索板 / 梗概上点的直接记；理线索按编号取原句、收了的同样等作者点。
// 真项目、真存档点、真执行器；记账员是假的。
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { chapterCommit, decisionRecord, projectBook, runCommand, type EntryInput } from "@actalk/story-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createStoryProject } from "../../book/project-store.js";
import type { BrainCallModel } from "../../editorial/index.js";
import { __resetCatchUpLocksForTests } from "../../editorial/reader-window.js";
import { makeHomeTempDir } from "../../lib/home-test-tmp.js";
import { __resetExecutionsForTests } from "../../lib/operations/context.js";
import { __resetLiveForTests } from "../../lib/operations/live.js";
import { __resetOperationStoreForTests, readOperation, type OperationRecord } from "../../lib/operations/store.js";
import { listSnapshots } from "../../lib/snapshot.js";
import { __drainOperationsForTests, __resetRecipesForTests, registerRecipe, resumeOperation, submitOperation } from "../operations/executor.js";
import {
  createLedgerChangeRecipe,
  LEDGER_CHANGE_KIND,
  LEDGER_CONFIRM_ACTION,
  LEDGER_CONFIRM_KIND,
  LEDGER_REVIEW_STEP_BUDGET,
  MAX_LEDGER_CHANGES,
  readLedgerChangeParams,
  type LedgerChangeBody,
  type LedgerConfirmPreview,
} from "../operations/recipes/ledger-change.js";

/** 编号只给程序用，给人看的话里一个都不许出现。 */
const RAW_ID = /c\d+-\d|t\d+-\d|T\d/u;

let root: string;
let book: string;
let keeper: BrainCallModel = async () => "笔记";

beforeEach(async () => {
  __resetOperationStoreForTests();
  __resetExecutionsForTests();
  __resetLiveForTests();
  __resetRecipesForTests();
  __resetCatchUpLocksForTests();
  root = await makeHomeTempDir("ledger-change-");
  vi.stubEnv("SE_DATA_DIR", join(root, "data"));
  ({ projectDir: book } = await createStoryProject({ rootDir: root, title: "钟楼", genre: "悬疑", protagonistName: "她" }));
  keeper = async () => "笔记";
  registerRecipe(createLedgerChangeRecipe({ keeperCallModel: (messages, options) => keeper(messages, options), modelProblem: () => undefined }));
});
afterEach(async () => {
  await __drainOperationsForTests();
  __resetRecipesForTests();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

const CH1 = "# 第1章\n\n周二傍晚，钟停在三点十五分。老周没有拦她。她在钟箱里摸到一把铜钥匙，揣进了包里。钟为什么停？钟楼的门为什么开着？";
const CH2 = "# 第2章\n\n第二天，钟楼的门锁上了。她把钥匙锁进铜盒。";

function entries1(): EntryInput[] {
  return [
    { kind: "fact", review: "auto", nature: "hard", subject: "钟", attribute: "停的时刻", value: "三点十五分", text: "钟停在三点十五分", quote: "钟停在三点十五分" },
    { kind: "fact", review: "auto", nature: "state", subject: "铜钥匙", attribute: "在哪", value: "她包里", text: "铜钥匙在她包里", quote: "揣进了包里" },
    { kind: "fact", review: "auto", nature: "event", text: "老周没有拦她", quote: "老周没有拦她" },
    { kind: "thread", review: "auto", op: "open", type: "question", title: "钟为什么停", note: "钟停了", quote: "钟为什么停" },
    { kind: "thread", review: "auto", op: "open", type: "question", title: "钟楼的门为什么开着", note: "门开着", quote: "钟楼的门为什么开着" },
  ];
}

const author = (key: string) => ({ caller: "author" as const, idempotencyKey: key });

async function commitTwo(): Promise<void> {
  const first = await runCommand(book, chapterCommit, { chapter: 1, text: CH1, entries: entries1() }, author("c1"));
  if (!first.ok) throw new Error(first.message);
  const second = await runCommand(book, chapterCommit, {
    chapter: 2,
    text: CH2,
    entries: [{ kind: "fact", review: "auto", nature: "state", subject: "铜钥匙", attribute: "在哪", value: "铜盒里", text: "铜钥匙锁在铜盒里", quote: "她把钥匙锁进铜盒" }],
  }, author("c2"));
  if (!second.ok) throw new Error(second.message);
}

async function stored(opId: string): Promise<OperationRecord> {
  const read = await readOperation(book, opId);
  if (read.kind !== "record") throw new Error("记录没了");
  return read.record;
}

/** 交一次、等它停下（做完 / 没做成 / 等作者）。 */
async function settled(mode: "edit" | "author" | "review", params: Record<string, unknown>, origin: "chat" | "button" = mode === "author" ? "button" : "chat"): Promise<OperationRecord> {
  const outcome = await submitOperation(book, {
    kind: LEDGER_CHANGE_KIND,
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

const edit = (...changes: Record<string, unknown>[]) => settled("edit", { changes });
const previewOf = (record: OperationRecord): LedgerConfirmPreview => record.pendingActions[0]!.preview as LedgerConfirmPreview;
const decisionsOf = async (record: OperationRecord): Promise<unknown> => {
  const plan = await import("../../lib/operations/checkpoints.js").then(({ readCheckpoint }) => readCheckpoint(book, record.opId, "plan"));
  return (plan?.output as { readonly decisions: unknown } | undefined)?.decisions;
};
const summaryOf = (record: OperationRecord): string => (record.result as { readonly summary: string }).summary;

async function confirm(record: OperationRecord): Promise<OperationRecord> {
  const outcome = await resumeOperation(book, record.opId, { actionId: LEDGER_CONFIRM_ACTION, decision: "apply" });
  expect(outcome.ok).toBe(true);
  await __drainOperationsForTests();
  return stored(record.opId);
}

describe("交来的参数", () => {
  it("直接改只认作者点的按钮；认不出的那条如实列；一次太多不受理；理线索不带别的", () => {
    expect(readLedgerChangeParams("chat", { changes: [{ op: "resolve", id: "x" }] }, "author")).toEqual({ invalid: "直接改账要你自己点按钮。" });
    expect(readLedgerChangeParams("chat", {}, "edit")).toEqual({ invalid: "没说要改哪几笔账。" });
    expect(readLedgerChangeParams("chat", { changes: [{ op: "explode" }] }, "edit")).toEqual({ invalid: "账没改：第 1 条没说清要做哪种改动。" });
    expect(readLedgerChangeParams("chat", { changes: [{ op: "explode" }, { op: "resolve", query: "钟" }] }, "edit"))
      .toEqual({ mode: "edit", changes: [{ op: "resolve", query: "钟" }], notDone: ["第 1 条没说清要做哪种改动"] });
    const many = Array.from({ length: MAX_LEDGER_CHANGES + 1 }, () => ({ op: "resolve", query: "钟" }));
    expect(readLedgerChangeParams("chat", { changes: many }, "edit")).toMatchObject({ invalid: expect.stringContaining(`一次最多改 ${MAX_LEDGER_CHANGES} 条`) });
    expect(readLedgerChangeParams("chat", { changes: many }, "review")).toEqual({ mode: "review" });
    expect(readLedgerChangeParams("chat", {}, undefined)).toMatchObject({ invalid: expect.any(String) });
  });
});

describe("对话 AI 提的改账：停下等作者点「确认改账」", () => {
  it("还没定稿的书：如实说账本是空的", async () => {
    const record = await edit({ op: "remove", targetText: "钟" });
    expect(record.state).toBe("failed");
    expect(record.failure?.message).toContain("还没有定稿的章");
  });

  it("各种改法翻成裁定草案；作者没点之前账一点没动；卡上的话里没有编号", async () => {
    await commitTwo();
    const before = JSON.stringify(await projectBook(book));
    const record = await edit(
      { op: "add", text: "钟楼失过一次火", chapter: 1 },
      { op: "add", text: "老周六十二岁", nature: "hard", subject: "老周", attribute: "年纪", value: "六十二" },
      { op: "update", targetText: "三点十五分", text: "钟停在三点二十分", value: "三点二十分" },
      { op: "supersede", targetText: "老周没有拦她", chapter: 2 },
      { op: "resolve", query: "钟为什么停" },
      { op: "importance", query: "门为什么开着", importance: "major" },
    );
    expect(record.state).toBe("waiting_author");
    expect(record.pendingActions[0]).toMatchObject({ actionId: LEDGER_CONFIRM_ACTION, kind: LEDGER_CONFIRM_KIND, decisions: ["apply"] });
    expect(await decisionsOf(record)).toEqual([
      { type: "fact.assert", chapter: 1, nature: "event", text: "钟楼失过一次火" },
      { type: "fact.assert", chapter: 2, nature: "hard", subject: "老周", attribute: "年纪", value: "六十二", text: "老周六十二岁" },
      { type: "fact.assert", chapter: 1, nature: "hard", subject: "钟", attribute: "停的时刻", value: "三点二十分", text: "钟停在三点二十分", corrects: "c1-1" },
      { type: "fact.expire", fact: "c1-3", chapter: 2 },
      { type: "thread.close", thread: "t1-1", chapter: 2 },
      { type: "thread.weight", thread: "t1-2", weight: "major" },
    ]);
    const preview = previewOf(record);
    expect(preview.lines).toContain("把第 1 章的事实「钟停在三点十五分」改成「钟停在三点二十分」");
    expect(preview.notes).toEqual([]);
    expect(JSON.stringify(preview)).not.toMatch(RAW_ID);
    expect(JSON.stringify(await projectBook(book))).toBe(before);
  });

  it("作者点了：整批记成作者裁定、改前存档；改写的那条作废、新说法生效", async () => {
    await commitTwo();
    const snapshotsBefore = (await listSnapshots(book)).length;
    const done = await confirm(await edit(
      { op: "update", targetText: "三点十五分", text: "钟停在三点二十分", value: "三点二十分" },
      { op: "resolve", query: "钟为什么停" },
    ));
    expect(done.state).toBe("succeeded");
    expect(summaryOf(done)).toBe("账改好了：把第 1 章的事实「钟停在三点十五分」改成「钟停在三点二十分」；把线索「钟为什么停」记为第 2 章已收（可撤销）。");
    const body = (done.result as { readonly body: LedgerChangeBody }).body;
    expect(body).toMatchObject({ kind: LEDGER_CHANGE_KIND, applied: expect.any(Array), snapshotId: expect.any(String) });
    expect((await listSnapshots(book)).length).toBeGreaterThan(snapshotsBefore);
    const view = await projectBook(book);
    expect(view.facts.find((fact) => fact.id === "c1-1")?.status).toBe("retracted");
    expect(view.facts.find((fact) => fact.text === "钟停在三点二十分")).toMatchObject({ chapter: 1, value: "三点二十分", review: "author", status: "current" });
    expect(view.threads.find((thread) => thread.id === "t1-1")).toMatchObject({ status: "closed", closedAt: 2, closedBy: "author" });
  });

  it("查不准如实说：一条都没算成就没做成、列候选；算成一部分的照出卡，没算成的写在卡上", async () => {
    await commitTwo();
    const ambiguous = await edit({ op: "remove", targetText: "铜钥匙" });
    expect(ambiguous.state).toBe("failed");
    expect(ambiguous.failure?.message).toContain("「铜钥匙在她包里」");
    expect(ambiguous.failure?.message).toContain("「铜钥匙锁在铜盒里」");
    for (const [change, text] of [
      [{ op: "remove", targetText: "外乡人" }, "账里没找到「外乡人」这条事实"],
      [{ op: "group" }, "要归并哪几条"],
      [{ op: "group", groups: [["钟为什么停"]] }, "每组至少要两条不同的线索"],
      [{ op: "add", text: "x", chapter: 5 }, "第 5 章还没定稿"],
      [{ op: "supersede", targetText: "老周没有拦她", chapter: 1 }, "要在它之后"],
      [{ op: "day", chapter: 1, day: 3, dayEnd: 2 }, "到第 2 天比第 3 天还早"],
      [{ op: "summary", chapter: 1 }, "梗概要改成什么"],
    ] as const) {
      const record = await edit(change);
      expect(record.state, JSON.stringify(change)).toBe("failed");
      expect(record.failure?.message).toContain(text);
    }
    const partial = await edit({ op: "remove", targetText: "外乡人" }, { op: "resolve", query: "钟为什么停" });
    expect(partial.state).toBe("waiting_author");
    expect(previewOf(partial)).toEqual({ lines: ["把线索「钟为什么停」记为第 2 章已收"], notes: ["没改成：账里没找到「外乡人」这条事实。"] });
  });

  it("归并、改天数、改梗概；同一笔裁定交两遍只记一次", async () => {
    await commitTwo();
    const group = await edit({ op: "group", groups: [["钟为什么停", "钟楼的门为什么开着"]] }, { op: "group", groups: [["钟为什么停", "钟楼的门为什么开着"]] });
    expect(await decisionsOf(group)).toEqual([{ type: "thread.merge", from: ["t1-2"], into: "t1-1" }]);
    expect(previewOf(group).lines).toEqual(["把 「钟楼的门为什么开着」并进「钟为什么停」"]);
    const day = await confirm(await edit({ op: "day", chapter: 1, day: 3, dayEnd: 4 }));
    expect(summaryOf(day)).toBe("账改好了：第 1 章从故事第 1 天改记为第 3 天到第 4 天（可撤销）。");
    expect((await projectBook(book)).chapters.map((chapter) => [chapter.day, chapter.dayEnd, chapter.dayBasis])).toEqual([[3, 4, "author"], [5, 5, "missing"]]);
    expect((await edit({ op: "day", chapter: 1, day: 3, dayEnd: 4 })).failure?.message).toContain("不用改");
    await confirm(await edit({ op: "summary", chapter: 1, text: "她在钟楼里找到了铜钥匙。" }));
    expect((await projectBook(book)).chapters[0]?.summary).toBe("她在钟楼里找到了铜钥匙。");
  });

  it("提议之后账变了：作者点了也不记，说哪样变了", async () => {
    await commitTwo();
    const record = await edit({ op: "resolve", query: "钟为什么停" });
    const moved = await runCommand(book, decisionRecord, { decisions: [{ type: "chapter.summary", chapter: 2, text: "门锁上了。" }] }, author("moved"));
    expect(moved.ok).toBe(true);
    const done = await confirm(record);
    expect(done.state).toBe("obsolete");
    expect(done.failure?.message).toMatch(/^提议之后.+改过，这份改账是照改之前算的，没改。$/u);
    expect((await projectBook(book)).threads.find((thread) => thread.id === "t1-1")?.status).not.toBe("closed");
  });
});

describe("作者在线索板 / 梗概上直接改", () => {
  it("点了就记（存档、可撤销）；同一条再点一次如实说已经收了", async () => {
    await commitTwo();
    const done = await settled("author", { changes: [{ op: "resolve", id: "t1-1", chapter: 2 }] });
    expect(done.state).toBe("succeeded");
    expect(done.pendingActions).toEqual([]);
    expect(summaryOf(done)).toBe("账改好了：把线索「钟为什么停」记为第 2 章已收（可撤销）。");
    expect((await projectBook(book)).threads.find((thread) => thread.id === "t1-1")).toMatchObject({ status: "closed", closedBy: "author" });
    const again = await settled("author", { changes: [{ op: "resolve", id: "t1-1", chapter: 2 }] });
    expect(again.state).toBe("failed");
    expect(again.failure?.message).toContain("已经收了");
    const weight = await settled("author", { changes: [{ op: "importance", id: "t1-2", importance: "minor" }] });
    expect(summaryOf(weight)).toBe("账改好了：线索「钟楼的门为什么开着」定为小线索（停多久都不提醒）（可撤销）。");
    const synopsis = await settled("author", { changes: [{ op: "summary", chapter: 2, text: "门锁上了，钥匙进了铜盒。" }] });
    expect(synopsis.state).toBe("succeeded");
    expect((await projectBook(book)).chapters[1]?.summary).toBe("门锁上了，钥匙进了铜盒。");
  });
});

describe("理线索（外部审查 2026-10-28：线索只开不收）", () => {
  /** 跟读写笔记的调用回「笔记」；理线索那次按 review 回；点句子那次按 evidence 回。 */
  function fakeKeeper(review: unknown, evidence: unknown): string[] {
    const asked: string[] = [];
    keeper = async (messages, options) => {
      if (!options.json) return "笔记";
      const ask = messages.at(-1)!.content;
      asked.push(ask);
      return typeof review === "string" && !ask.includes("每句前面是编号") ? review : JSON.stringify(ask.includes("每句前面是编号") ? evidence : review);
    };
    return asked;
  }

  it("受理时按步骤冻结额度；没定稿的书如实说", async () => {
    const empty = await settled("review", {});
    expect(empty.state).toBe("failed");
    expect(empty.failure?.message).toContain("没有线索可理");
    expect(empty.budget.limit).toBe(Object.values(LEDGER_REVIEW_STEP_BUDGET).reduce((sum, value) => sum + value, 0));
  });

  it("判收了的按编号取原句、出「确认改账」卡；作者点了才记、记在说的那章；卡上没有编号", async () => {
    await commitTwo();
    const before = JSON.stringify(await projectBook(book));
    const asked = fakeKeeper(
      { threads: [{ id: "T1", status: "open", reason: "还没说钟为什么停" }, { id: "T2", status: "closed", chapter: 2, reason: "门锁上了" }] },
      { evidence: [{ id: "T2", ids: [1] }] },
    );
    const record = await settled("review", {});
    expect(asked[0]).toContain("T2 悬念「钟楼的门为什么开着」");
    expect(record.state).toBe("waiting_author");
    expect(previewOf(record)).toEqual({
      lines: ["「钟楼的门为什么开着」第 2 章已收：「第二天，钟楼的门锁上了。」"],
      notes: ["理了 2 条开着的线索：1 条看着已经收了，1 条还开着。"],
    });
    expect(JSON.stringify(previewOf(record))).not.toMatch(RAW_ID);
    expect(JSON.stringify(await projectBook(book))).toBe(before);
    const done = await confirm(record);
    expect(done.state).toBe("succeeded");
    expect((await projectBook(book)).threads.find((thread) => thread.title === "钟楼的门为什么开着")).toMatchObject({ status: "closed", closedAt: 2, closedBy: "author" });
  });

  it("点不出原句、说的章不对、拿不准的都不列，如实说；一条都没有就不停下、说理了几条；交回来的读不了是没做成", async () => {
    await commitTwo();
    fakeKeeper(
      { threads: [{ id: "T1", status: "closed", chapter: 9, reason: "x" }, { id: "T2", status: "closed", chapter: 2, reason: "门锁上了" }] },
      { evidence: [{ id: "T2", ids: [40] }] },
    );
    const nothing = await settled("review", {});
    expect(nothing.state).toBe("succeeded");
    expect(nothing.pendingActions).toEqual([]);
    expect(summaryOf(nothing)).toContain("理了 2 条开着的线索：没有看着已经收了的。");
    expect(summaryOf(nothing)).toContain("「钟为什么停」记账员说第 9 章收了");
    expect(summaryOf(nothing)).toContain("「钟楼的门为什么开着」记账员说第 2 章收了，但第 2 章里点不出写明收口的句子，没列。");
    fakeKeeper({ threads: [{ id: "T1", status: "maybe" }] }, { evidence: [] });
    expect(summaryOf(await settled("review", {}))).toContain("拿不准的 2 条：「钟为什么停」「钟楼的门为什么开着」");
    fakeKeeper("不是 JSON", {});
    const broken = await settled("review", {});
    expect(broken.state).toBe("failed");
    expect(broken.failure?.message).toContain("线索没理成");
  });
});
