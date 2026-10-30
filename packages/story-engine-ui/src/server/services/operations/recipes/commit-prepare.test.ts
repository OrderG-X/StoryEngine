// @vitest-environment node
//
// 定稿（写作版本 P2a 片 4A：commit.prepare 收编 commit_preview / commit_apply）：硬闸没过如实列原因、不出按钮；
// 过了就让记账员记账、停下等作者在清单上点「确认定稿」，点之前书一点不动；作者去掉的不记、改的天数照改；
// 清单出来之后正文或前文改过都不定稿、说哪样变了；同一个按钮再点不重复写。真项目、真存档点、真执行器；记账员是假的。
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cardWrite, chapterCommit, declarationsOf, decisionRecord, projectBook, readCards, readChapterLedger, readHead, runCommand } from "@actalk/story-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createStoryProject } from "../../../book/project-store.js";
import type { BrainCallModel } from "../../../editorial/reader-window.js";
import { __resetCatchUpLocksForTests } from "../../../editorial/reader-window.js";
import { makeHomeTempDir } from "../../../lib/home-test-tmp.js";
import { __resetExecutionsForTests, OperationStopped } from "../../../lib/operations/context.js";
import { __resetLiveForTests } from "../../../lib/operations/live.js";
import { __resetOperationStoreForTests, readOperation, type OperationRecord } from "../../../lib/operations/store.js";
import { listSnapshots } from "../../../lib/snapshot.js";
import { restoreForTest } from "../../../lib/history-test-helpers.js";
import { DAY_ITEM_ID, openThreadsHintDue, type AuthorChoicePreview, type CommitPreviewView } from "../../commit-view.js";
import { undoInOperation } from "../test-helpers.js";
import { __drainOperationsForTests, __resetRecipesForTests, registerRecipe, resumeOperation, submitOperation } from "../executor.js";
import {
  AUTHOR_CHOICE_KIND,
  COMMIT_CONFIRM_ACTION,
  COMMIT_CONFIRM_KIND,
  COMMIT_PREPARE_KIND,
  createCommitPrepareRecipe,
  ledgerFailedAction,
  readCommitPrepareParams,
  type CommitConfirmPreview,
  type CommitPrepareBody,
} from "./commit-prepare.js";

const warmUpReadersMock = vi.hoisted(() => vi.fn(() => undefined));
/** 在记账员动手之前插一次别的写（时序屏障，第 8 轮复核 V4）。 */
const hook = vi.hoisted(() => ({
  beforePrepare: undefined as undefined | (() => Promise<void>),
  /** 配方读完正文、交定稿命令之前（还没上书锁）插一次别的写（Astra 第 11 轮）。 */
  beforeCommitCommand: undefined as undefined | (() => Promise<void>),
  /** 定稿命令写完之后、配方接着往下之前（模拟进程在这儿没了，Astra 第 12 轮）。 */
  afterCommitCommand: undefined as undefined | (() => Promise<void>),
  /** 回放核完「盘上还是这次写成的」之后、读正文和账之前（Astra 第 15 轮）。 */
  afterReceiptCheck: undefined as undefined | (() => Promise<void>),
}));
vi.mock("@actalk/story-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@actalk/story-core")>();
  return {
    ...actual,
    receiptOnDisk: async (...args: Parameters<typeof actual.receiptOnDisk>) => {
      const onDisk = await actual.receiptOnDisk(...args);
      await hook.afterReceiptCheck?.();
      return onDisk;
    },
  };
});
vi.mock("../../../lib/operations/command.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/operations/command.js")>();
  return {
    ...actual,
    runCommandInOperation: async (...args: Parameters<typeof actual.runCommandInOperation>) => {
      if (args[1].name === "chapter.commit") await hook.beforeCommitCommand?.();
      const outcome = await actual.runCommandInOperation(...args);
      if (args[1].name === "chapter.commit") await hook.afterCommitCommand?.();
      return outcome;
    },
  };
});
vi.mock("../../../editorial/commit-flow.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../editorial/commit-flow.js")>();
  return {
    ...actual,
    prepareChapterCommit: async (...args: Parameters<typeof actual.prepareChapterCommit>) => {
      await hook.beforePrepare?.();
      return actual.prepareChapterCommit(...args);
    },
  };
});
vi.mock("../../../editorial/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../editorial/index.js")>()),
  warmUpReaders: warmUpReadersMock,
}));

/** 编号只给程序用，给人看的话里一个都不许出现。 */
const RAW_ID = /c\d+-\d|t\d+-\d|commit_|prepare_commit/u;

const FILLER = "林远在钟楼里来回踱步，反复掂量手里那把钥匙的分量，盘算着接下来每一步该怎么走。".repeat(10);
const CH1 = `# 第1章 · 钟停\n\n周二傍晚，钟停在三点十五分。林远推开钟楼的门，老周没有拦他。\n\n他在钟箱里摸到一把铜钥匙，揣进了包里。钟为什么偏偏停在这个时刻？\n\n${FILLER}\n`;
const CH2 = `# 第2章 · 四点\n\n第二天上午，钟楼的钟停在四点整。老周站在门口，没让外人进。\n\n林远把钥匙锁进铜盒。他终于明白了，钟是被人故意拨停的。\n\n${FILLER}\n`;

const LEDGER1 = {
  summary: { text: "林远进钟楼拿走钥匙", quote: "他在钟箱里摸到一把铜钥匙" },
  time: { start: { offset: 0, basis: "text", quote: "周二傍晚" }, sameDay: true, weekday: "周二", timeOfDay: "傍晚" },
  presence: [
    { name: "林远", nameUsed: "林远", viewpoint: true, quote: "林远推开钟楼的门" },
    { name: "周守义", nameUsed: "老周", quote: "老周没有拦他" },
  ],
  facts: [
    { nature: "state", subject: "铜钥匙", attribute: "在哪", value: "林远包里", text: "铜钥匙在林远包里", quote: "揣进了包里" },
    { nature: "hard", subject: "钟", attribute: "停的时刻", value: "三点十五分", text: "钟停在三点十五分", quote: "钟停在三点十五分" },
  ],
  threads: [{ op: "open", type: "question", title: "钟为什么停", note: "钟停在三点十五分", quote: "钟为什么偏偏停在这个时刻" }],
};
const LEDGER2 = {
  summary: { text: "林远锁好钥匙，明白钟是被拨停的", quote: "林远把钥匙锁进铜盒" },
  time: { start: { offset: 1, basis: "text", quote: "第二天上午" }, sameDay: true, timeOfDay: "上午" },
  presence: [{ name: "林远", nameUsed: "林远", viewpoint: true, quote: "林远把钥匙锁进铜盒" }, { name: "周守义", nameUsed: "老周", quote: "老周站在门口" }],
  facts: [
    { nature: "state", subject: "铜钥匙", attribute: "在哪", value: "铜盒里", text: "铜钥匙锁在铜盒里", quote: "林远把钥匙锁进铜盒" },
    { nature: "hard", subject: "钟", attribute: "停的时刻", value: "四点整", text: "钟停在四点整", quote: "钟楼的钟停在四点整" },
  ],
  threads: [{ op: "close", thread: "T1", note: "钟是被人故意拨停的", quote: "钟是被人故意拨停的" }],
};

let root: string;
let book: string;
/** 记账员这次交的账单（按测试换）；undefined = 记账员没交成。 */
let ledger: unknown;

/** 假记账员：要账单交 ledger，要笔记交笔记。 */
const fakeModel: BrainCallModel = async (messages) => {
  const last = messages.at(-1)?.content ?? "";
  if (!last.includes("交这一章的账单")) return "笔记：老周＝周守义。";
  if (ledger === undefined) throw new Error("模型没回话");
  return JSON.stringify(ledger);
};

beforeEach(async () => {
  __resetOperationStoreForTests();
  __resetExecutionsForTests();
  __resetLiveForTests();
  __resetRecipesForTests();
  __resetCatchUpLocksForTests();
  warmUpReadersMock.mockClear();
  hook.beforePrepare = undefined;
  hook.beforeCommitCommand = undefined;
  hook.afterCommitCommand = undefined;
  hook.afterReceiptCheck = undefined;
  root = await makeHomeTempDir("commit-prepare-");
  vi.stubEnv("SE_DATA_DIR", join(root, "data"));
  ({ projectDir: book } = await createStoryProject({ rootDir: root, title: "钟楼", genre: "悬疑", logline: "钟停了。", protagonistName: "林远" }));
  ledger = LEDGER1;
  registerRecipe(createCommitPrepareRecipe({ callModel: (messages, options) => fakeModel(messages, options), modelProblem: () => undefined }));
});
afterEach(async () => {
  await __drainOperationsForTests();
  __resetRecipesForTests();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

async function writeDraft(chapter: number, text: string): Promise<void> {
  await mkdir(join(book, "drafts", "fast"), { recursive: true });
  await writeFile(join(book, "drafts", "fast", `chapter-${String(chapter).padStart(4, "0")}.md`), text, "utf-8");
}

const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false);

async function stored(opId: string): Promise<OperationRecord> {
  const read = await readOperation(book, opId);
  if (read.kind !== "record") throw new Error("记录没了");
  return read.record;
}

/** 交一次定稿、等它停下（定不了 / 等作者 / 没做成）。 */
async function prepare(chapter: number, options: { readonly origin?: "chat" | "button"; readonly allowShort?: boolean } = {}): Promise<OperationRecord> {
  const outcome = await submitOperation(book, {
    kind: COMMIT_PREPARE_KIND,
    params: { chapter, ...(options.allowShort ? { allowShort: true } : {}) },
    requestKey: randomUUID(),
    issuedAt: new Date().toISOString(),
    origin: options.origin === "chat" ? { kind: "chat", messageId: randomUUID() } : { kind: "button" },
  });
  if (!outcome.ok || !("record" in outcome)) throw new Error(`没受理：${JSON.stringify(outcome)}`);
  await __drainOperationsForTests();
  return stored(outcome.record.opId);
}

const viewOf = (record: OperationRecord): CommitPreviewView => (record.pendingActions[0]!.preview as CommitConfirmPreview).view;
const bodyOf = (record: OperationRecord): CommitPrepareBody => (record.result as { readonly body: CommitPrepareBody }).body;
const summaryOf = (record: OperationRecord): string => (record.result as { readonly summary: string }).summary;

/** 作者在清单上点「确认定稿」：toggled = 动过的那几行（去掉的、勾上的），values = 改的天数。 */
async function confirm(record: OperationRecord, toggled: readonly (string | undefined)[] = [], values: Readonly<Record<string, number>> = {}): Promise<OperationRecord> {
  const excluded = toggled.filter((id): id is string => typeof id === "string");
  const outcome = await resumeOperation(book, record.opId, {
    actionId: COMMIT_CONFIRM_ACTION,
    decision: "commit",
    ...(excluded.length > 0 ? { excluded } : {}),
    ...(Object.keys(values).length > 0 ? { values } : {}),
  });
  expect(outcome).toMatchObject({ ok: true });
  await __drainOperationsForTests();
  return stored(record.opId);
}

/** 交一次、直接点「确认定稿」（什么都不动）。 */
async function commit(chapter: number, text: string, entries: unknown): Promise<OperationRecord> {
  await writeDraft(chapter, text);
  ledger = entries;
  const done = await confirm(await prepare(chapter));
  expect(done.state).toBe("succeeded");
  return done;
}

describe("交来的参数", () => {
  it("章号要对；「就这么短」只认按钮", () => {
    expect(readCommitPrepareParams("chat", { chapter: 0 })).toEqual({ invalid: "要定稿哪一章没说清。" });
    expect(readCommitPrepareParams("chat", { chapter: 2, allowShort: true })).toEqual({ chapter: 2 });
    expect(readCommitPrepareParams("button", { chapter: 2, allowShort: true })).toEqual({ chapter: 2, allowShort: true });
    // 补账谁交都行（只出清单）。
    expect(readCommitPrepareParams("chat", { chapter: 3, fill: true })).toEqual({ chapter: 3, fill: true });
    expect(readCommitPrepareParams("chat", { fill: true })).toEqual({ invalid: "要补哪一章的账没说清。" });
  });
});

describe("定不了：如实列原因，不出按钮", () => {
  it("没有工作稿 / 太短：原因是人话、不带路径；只差字数的清单上给「就这么短，照样定稿」", async () => {
    const missing = await prepare(1);
    expect(missing.state).toBe("succeeded");
    expect(missing.pendingActions).toEqual([]);
    expect(bodyOf(missing)).toMatchObject({ kind: COMMIT_PREPARE_KIND, chapter: 1, committed: false, blocked: { canCommit: false } });
    expect(summaryOf(missing)).toContain("还没有工作稿");
    expect(summaryOf(missing)).not.toContain(book);

    await writeDraft(1, "# 第1章\n\n钟停了。\n");
    const short = bodyOf(await prepare(1)).blocked!;
    expect(short.canCommit).toBe(false);
    expect(short.blockingReasons.join("")).toContain("下限");
    expect(short.blockingReasons.join("")).toContain("「就这么短，照样定稿」");
    expect(short.shortOnly).toBe(true);
    expect(short.draftIssues?.length).toBeGreaterThan(0);
    expect(await readChapterLedger(book, 1)).toBeUndefined();
  });

  it("读完字数下限和人物名单之后作者改了设定：清单不出、不定稿；再点一次照新下限挡（第 8 轮 V4）", async () => {
    await writeDraft(1, CH1);
    hook.beforePrepare = async () => {
      hook.beforePrepare = undefined;
      expect(await runCommand(book, cardWrite, { ops: [{ op: "rules.set", field: "minWords", value: 1000 }, { op: "card.delete", card: "林远" }] }, { caller: "author", idempotencyKey: "change-rules" }))
        .toMatchObject({ ok: true });
    };
    const moved = await prepare(1);
    expect(moved.state).toBe("obsolete");
    expect(moved.pendingActions).toEqual([]);
    expect(moved.failure?.message).toContain("再点一次「定稿」");
    expect(await exists(join(book, "chapters", "0001.md"))).toBe(false);
    const fresh = bodyOf(await prepare(1)).blocked!;
    expect(fresh.canCommit).toBe(false);
    expect(fresh.blockingReasons.join("")).toContain("1000");
  });

});

describe("记账没成：停下请作者挑「再记一次」或「先定正文、账待记」（P2b 设计 3.1）", () => {
  it("不整次失败：卡上原因如实、两个按钮；点之前书一点没动", async () => {
    await writeDraft(1, CH1);
    const base = (await readHead(book)).version;
    ledger = undefined;
    const record = await prepare(1);
    expect(record.state).toBe("waiting_author");
    expect(record.pendingActions[0]).toMatchObject({ actionId: ledgerFailedAction(1), kind: AUTHOR_CHOICE_KIND, decisions: ["retry", "pending"] });
    const choice = record.pendingActions[0]!.preview as AuthorChoicePreview;
    expect(choice.lines[0]).toContain("第 1 章的账这次没记成");
    expect(choice.choices.map((item) => item.label)).toEqual(["再记一次", "先定正文、账待记"]);
    expect(JSON.stringify(choice)).not.toMatch(RAW_ID);
    expect(await readHead(book)).toMatchObject({ version: base });
    expect(await exists(join(book, "chapters", "0001.md"))).toBe(false);
  });

  it("「再记一次」：同一次操作按新轮号再记，记成了照常出清单、能定稿；又没成再给一张卡", async () => {
    await writeDraft(1, CH1);
    ledger = undefined;
    const record = await prepare(1);
    expect(await resumeOperation(book, record.opId, { actionId: ledgerFailedAction(1), decision: "retry" })).toMatchObject({ ok: true });
    await __drainOperationsForTests();
    const again = await stored(record.opId);
    expect(again.state).toBe("waiting_author");
    expect(again.pendingActions.find((action) => !action.decisionHash)).toMatchObject({ actionId: ledgerFailedAction(2), kind: AUTHOR_CHOICE_KIND });

    ledger = LEDGER1;
    expect(await resumeOperation(book, record.opId, { actionId: ledgerFailedAction(2), decision: "retry" })).toMatchObject({ ok: true });
    await __drainOperationsForTests();
    const listed = await stored(record.opId);
    expect(listed.pendingActions.find((action) => !action.decisionHash)).toMatchObject({ actionId: COMMIT_CONFIRM_ACTION, kind: COMMIT_CONFIRM_KIND });
    const done = await confirm(listed);
    expect(done.state).toBe("succeeded");
    expect((await readChapterLedger(book, 1))?.status).toBe("ready");
  });

  it("「先定正文、账待记」：正文定了、账单待记；回执如实说、给「补记账」；哪天不知道；能撤销", async () => {
    await writeDraft(1, CH1);
    ledger = undefined;
    const record = await prepare(1);
    expect(await resumeOperation(book, record.opId, { actionId: ledgerFailedAction(1), decision: "pending" })).toMatchObject({ ok: true });
    await __drainOperationsForTests();
    const done = await stored(record.opId);
    expect(done.state).toBe("succeeded");
    expect(bodyOf(done)).toMatchObject({ committed: true, done: { report: { chapter: 1, ledger: { status: "pending", facts: 0 } } } });
    expect(bodyOf(done).done?.report?.ledger.storyTime).toBeUndefined();
    expect(summaryOf(done)).toContain("第 1 章正文定了，账还没记上");
    expect(await readFile(join(book, "chapters", "0001.md"), "utf-8")).toBe(CH1);
    expect(await readChapterLedger(book, 1)).toMatchObject({ status: "pending", entries: [] });
    expect((await projectBook(book)).chapters[0]).toMatchObject({ ledgerStatus: "pending", time: { presentLine: "unknown", basis: "unknown" } });

    await undoInOperation(book, done.opId);
    expect(await exists(join(book, "chapters", "0001.md"))).toBe(false);
  });

  it("记账那会儿之后正文又改过：不定稿、说清楚", async () => {
    await writeDraft(1, CH1);
    ledger = undefined;
    const record = await prepare(1);
    await writeDraft(1, `${CH1}\n又补了一句。`);
    expect(await resumeOperation(book, record.opId, { actionId: ledgerFailedAction(1), decision: "pending" })).toMatchObject({ ok: true });
    await __drainOperationsForTests();
    const done = await stored(record.opId);
    expect(done.state).toBe("obsolete");
    expect(done.failure?.message).toContain("记账那会儿之后正文又改过");
    expect(await exists(join(book, "chapters", "0001.md"))).toBe(false);
  });
});

describe("补账（P2b 设计 3.2）：按定稿那版正文补记，出清单，作者点「确认记账」才记，正文不动", () => {
  async function pendingChapter1(): Promise<void> {
    await writeDraft(1, CH1);
    ledger = undefined;
    const record = await prepare(1);
    await resumeOperation(book, record.opId, { actionId: ledgerFailedAction(1), decision: "pending" });
    await __drainOperationsForTests();
    ledger = LEDGER1;
  }
  async function prepareFill(chapter: number): Promise<OperationRecord> {
    const outcome = await submitOperation(book, {
      kind: COMMIT_PREPARE_KIND,
      params: { chapter, fill: true },
      requestKey: randomUUID(),
      issuedAt: new Date().toISOString(),
      origin: { kind: "chat", messageId: randomUUID() },
    });
    if (!outcome.ok || !("record" in outcome)) throw new Error(`没受理：${JSON.stringify(outcome)}`);
    await __drainOperationsForTests();
    return stored(outcome.record.opId);
  }

  it("出补账清单（标 fill、说「可以补上」）→ 确认记账：账换上、正文和定稿时间不动；回执标补账", async () => {
    await pendingChapter1();
    const before = await readChapterLedger(book, 1);
    // 作者之后又在稿纸上改了工作稿：补账照定稿那版正文记，不碰工作稿。
    await writeDraft(1, `${CH1}\n工作稿上又写了一句。`);
    const record = await prepareFill(1);
    expect(record).toMatchObject({ state: "waiting_author", mode: "fill" });
    const view = viewOf(record);
    expect(view).toMatchObject({ chapter: 1, canCommit: true, fill: true });
    expect(view.summary).toContain("第 1 章的账可以补上");
    expect(view.notes ?? []).not.toContain("这章定稿过，这次会换掉原来的账");

    const done = await confirm(record);
    expect(done.state).toBe("succeeded");
    expect(bodyOf(done)).toMatchObject({ committed: true, fill: true, done: { report: { fill: true, ledger: { status: "ready", facts: 2 } } } });
    expect(summaryOf(done)).toContain("第 1 章的账补上了");
    expect(bodyOf(done).done?.draftBody).toBeUndefined();
    expect(await readFile(join(book, "chapters", "0001.md"), "utf-8")).toBe(CH1);
    expect(await readChapterLedger(book, 1)).toMatchObject({ status: "ready", committedAt: before!.committedAt, textSha256: before!.textSha256 });
    expect((await projectBook(book)).chapters[0]).toMatchObject({ ledgerStatus: "ready", time: { start: { lo: 1, hi: 1 } } });
  });

  it("补摘原句那一步没成：账记成没记全、写明缺哪几类（P2b 出口复核第 2 条）；补账时又没成照样写明", async () => {
    // 线索和一条事实的原句对不上，补摘那次交回来的不是 JSON。
    const broken = {
      ...LEDGER1,
      facts: [LEDGER1.facts[0], { ...LEDGER1.facts[1], quote: "钟停在了三点一刻" }],
      threads: [{ ...LEDGER1.threads[0], quote: "钟到底为什么停" }],
    };
    const done = await commit(1, CH1, broken);
    expect(bodyOf(done)).toMatchObject({ committed: true });
    expect(await readChapterLedger(book, 1)).toMatchObject({ status: "partial", coverage: { reasonCodes: ["quote_repair_failed"], missingKinds: ["fact", "thread"] } });
    const view = (await projectBook(book)).chapters[0];
    expect(view).toMatchObject({ ledgerStatus: "partial", missingKinds: ["fact", "thread"], time: { start: { lo: 1, hi: 1 } } });

    // 补账：时间那条开头那句又没对上、补摘又没成（按说不出隔多久记），作者在清单上填了天数 → 时间不算缺。
    ledger = { ...broken, time: { ...LEDGER1.time, start: { ...LEDGER1.time.start, quote: "周二的傍晚时分" } } };
    const fill = await prepareFill(1);
    const filled = await confirm(fill, [], { [DAY_ITEM_ID]: 1 });
    expect(filled.state).toBe("succeeded");
    expect(await readChapterLedger(book, 1)).toMatchObject({ status: "partial", coverage: { missingKinds: ["fact", "thread"] } });
  });

  it("账待记那份没记天数：补账清单不说「上次定稿记的是第几天」（真点：拿估的天数当上次记的）", async () => {
    await commit(1, CH1, LEDGER1);
    await writeDraft(2, CH2);
    ledger = undefined;
    const record = await prepare(2);
    await resumeOperation(book, record.opId, { actionId: ledgerFailedAction(1), decision: "pending" });
    await __drainOperationsForTests();
    // 记账员这次看成隔了两天（第 3 天）；账待记那份没记时间，没有「上次记的」可比。
    ledger = { ...LEDGER2, time: { ...LEDGER2.time, start: { ...LEDGER2.time.start, offset: 2 } } };
    const fill = await prepareFill(2);
    expect(fill.state).toBe("waiting_author");
    expect(JSON.stringify(viewOf(fill))).not.toContain("上次定稿记的");
  });

  it("补不了的如实说：账已经记上了；补账时记账又没成只给「再记一次」", async () => {
    await commit(1, CH1, LEDGER1);
    const ready = await prepareFill(1);
    expect(ready.state).toBe("succeeded");
    expect(bodyOf(ready)).toMatchObject({ committed: false, fill: true });
    expect(bodyOf(ready).blocked?.blockingReasons.join("")).toContain("已经记上了");

    await writeDraft(2, CH2);
    ledger = undefined;
    const record = await prepare(2);
    await resumeOperation(book, record.opId, { actionId: ledgerFailedAction(1), decision: "pending" });
    await __drainOperationsForTests();
    const fill = await prepareFill(2);
    expect(fill.pendingActions[0]).toMatchObject({ kind: AUTHOR_CHOICE_KIND, decisions: ["retry"] });
  });

  it("补账清单出来之后这章的账又变过：不写、说改过；又交了一次定稿的，旧的补账清单作废", async () => {
    await pendingChapter1();
    const record = await prepareFill(1);
    expect(record.state).toBe("waiting_author");
    // 别处（不经这次操作）把这章的账又写了一遍。
    expect(await runCommand(book, chapterCommit, { chapter: 1, text: CH1, entries: [], ledger: { status: "pending", reasonCodes: ["keeper_failed"] } }, { caller: "author", idempotencyKey: randomUUID() }))
      .toMatchObject({ ok: true });
    const done = await confirm(record);
    expect(done.state).toBe("obsolete");
    expect(done.failure?.message).toContain("补账清单出来之后");
    expect(await readChapterLedger(book, 1)).toMatchObject({ status: "pending" });

    const again = await prepareFill(1);
    await writeDraft(1, CH1);
    await prepare(1);
    expect((await stored(again.opId)).state).toBe("obsolete");
  });
});

describe("清单出来停下等作者", () => {
  it("天数一行在最前，要看的标 needsConfirm，自动记的随后；话里不带工具名和编号；点之前书一点没动", async () => {
    const base = (await readHead(book)).version;
    await writeDraft(1, CH1);
    const record = await prepare(1, { origin: "chat" });
    expect(record.state).toBe("waiting_author");
    expect(record.pendingActions[0]).toMatchObject({ actionId: COMMIT_CONFIRM_ACTION, kind: COMMIT_CONFIRM_KIND, decisions: ["commit"] });
    const view = viewOf(record);
    expect(view).toMatchObject({ chapter: 1, canCommit: true, notRecorded: [] });
    const list = view.ledgerChecklist ?? [];
    expect(list[0]).toMatchObject({ id: DAY_ITEM_ID, kind: "time", editableDay: 1, removable: false, detail: "周二傍晚" });
    expect(list[0]?.label).toContain("故事第 1 天");
    // 星期按 0=周一 存（记账员、时间线同口径）；预览曾按 0=周日显示，「周二」变「星期一」（真机试写）。
    expect(list[0]?.label).toContain("周二");
    const reviewed = list.filter((item) => item.needsConfirm);
    expect(reviewed.map((item) => item.label)).toEqual([expect.stringContaining("周守义")]);
    expect(list.filter((item) => item.kind === "fact")).toHaveLength(2);
    expect(view.summary).toBe("第 1 章可以定稿：要你看 1 条，其余 5 条自动记下（不对的都能去掉）。");
    expect(JSON.stringify(view)).not.toMatch(RAW_ID);
    expect(await exists(join(book, "chapters", "0001.md"))).toBe(false);
    expect(await readHead(book)).toMatchObject({ version: base });
  });

  it("第 1 章正文没写时间：不估，天数那行说不知道、请作者填，不提没有的上一章（2026-10-23 桌面包走查；写作版本 P3 删了估算）", async () => {
    await writeDraft(1, CH1);
    const { time: _time, ...noTime } = LEDGER1;
    ledger = noTime;
    const day = viewOf(await prepare(1)).ledgerChecklist?.[0];
    expect(day).toMatchObject({ id: DAY_ITEM_ID, dayUnknown: true, needsConfirm: true });
    expect(day?.label).toBe("正文里没认出这章的时间，是故事哪天不知道；知道的话填上");
  });
});

describe("作者点「确认定稿」", () => {
  it("去掉的不记、天数照改；写正文 + 账单；后台预热；同一个按钮再点不重复写，换了选法不算", async () => {
    const base = (await readHead(book)).version;
    await writeDraft(1, CH1);
    const record = await prepare(1);
    const stranger = viewOf(record).ledgerChecklist?.find((item) => item.needsConfirm && item.label.includes("周守义"));
    const done = await confirm(record, [stranger?.id], { day: 3 });
    expect(done.state).toBe("succeeded");
    const body = bodyOf(done);
    expect(body).toMatchObject({ committed: true, snapshotId: expect.stringMatching(/^[0-9a-f]{40}$/u) });
    expect(body.done).toMatchObject({ draftTitle: "第1章 · 钟停", report: { chapter: 1, ledger: { facts: 2, threadsOpened: 1, threadsClosed: 0, present: 1, storyTime: "第 3 天", notRecorded: 0 } } });
    expect(body.done?.draftBody?.startsWith("周二傍晚")).toBe(true);
    expect(summaryOf(done)).toContain("第 1 章已定稿");
    expect(await readFile(join(book, "chapters", "0001.md"), "utf-8")).toBe(CH1);
    expect((await projectBook(book)).chapters[0]).toMatchObject({ time: { start: { lo: 3, hi: 3 }, end: { lo: 3, hi: 3 }, basis: "author" }, present: ["林远"] });
    expect(await exists(join(book, ".story-core-mirror.json"))).toBe(false);
    expect(warmUpReadersMock).toHaveBeenCalledWith(book, 1);

    expect(await resumeOperation(book, record.opId, { actionId: COMMIT_CONFIRM_ACTION, decision: "commit", excluded: [stranger!.id], values: { day: 3 } }))
      .toMatchObject({ ok: true, replayed: true });
    expect(await resumeOperation(book, record.opId, { actionId: COMMIT_CONFIRM_ACTION, decision: "commit" }))
      .toMatchObject({ ok: false, code: "decision_conflict" });
    expect(await readHead(book)).toMatchObject({ version: base + 1 });
  });

  it("同一章又出了一张清单：旧的作废、点旧的如实说用新的；新的照常定；别的章的不碰", async () => {
    await commit(1, CH1, LEDGER1);
    const other = await prepare(1);
    await writeDraft(2, CH2);
    ledger = LEDGER2;
    const first = await prepare(2);
    const second = await prepare(2);
    expect(other.state).toBe("waiting_author");
    expect(first.state).toBe("waiting_author");
    expect(await stored(first.opId)).toMatchObject({ state: "obsolete", failure: { code: "superseded", retryable: false } });
    expect(await resumeOperation(book, first.opId, { actionId: COMMIT_CONFIRM_ACTION, decision: "commit" }))
      .toMatchObject({ ok: false, message: "这一章后来又出了一张定稿清单，用新的那张。" });
    expect((await stored(other.opId)).state).toBe("waiting_author");
    expect((await confirm(second)).state).toBe("succeeded");
    // 做完了的换个选法再点：说做完了，不说「没有停着」。
    expect(await resumeOperation(book, second.opId, { actionId: COMMIT_CONFIRM_ACTION, decision: "commit", excluded: ["x"] }))
      .toMatchObject({ ok: false });
  });

  it("前面差一章没定：原因只说那一章", async () => {
    await writeDraft(2, CH2);
    expect(summaryOf(await prepare(2))).toBe("第 2 章现在还定不了：第 1 章还没定稿，先定稿前面的章");
  });

  it("清单上没有的行、范围外的天数：不受理", async () => {
    await writeDraft(1, CH1);
    const record = await prepare(1);
    expect(await resumeOperation(book, record.opId, { actionId: COMMIT_CONFIRM_ACTION, decision: "commit", excluded: ["i99"] })).toMatchObject({ ok: false, code: "bad_decision" });
    expect(await resumeOperation(book, record.opId, { actionId: COMMIT_CONFIRM_ACTION, decision: "commit", values: { day: 0 } })).toMatchObject({ ok: false, code: "bad_decision" });
    expect(await resumeOperation(book, record.opId, { actionId: COMMIT_CONFIRM_ACTION, decision: "commit", values: { week: 2 } })).toMatchObject({ ok: false, code: "bad_decision" });
    expect((await stored(record.opId)).state).toBe("waiting_author");
  });

  it("清单出来之后正文改过：不定稿、说正文改过；字没动只收了空行的照定", async () => {
    await writeDraft(1, CH1);
    const blankOnly = await prepare(1);
    await writeDraft(1, CH1.replace("\n\n", "\n\n\n\n"));
    expect((await confirm(blankOnly)).state).toBe("succeeded");

    await writeDraft(2, CH2);
    ledger = LEDGER2;
    const record = await prepare(2);
    await writeDraft(2, `${CH2}林远又补了一句。\n`);
    const done = await confirm(record);
    expect(done.state).toBe("obsolete");
    expect(done.failure?.message).toContain("正文又改过");
    expect(await exists(join(book, "chapters", "0002.md"))).toBe(false);
  });

  it("读完正文到上书锁之间作者又存了稿：不定稿（不拿读到的旧稿定），稿子是作者新存的那版", async () => {
    await writeDraft(1, CH1);
    const record = await prepare(1);
    const edited = CH1.replace("铜钥匙", "银钥匙");
    hook.beforeCommitCommand = async () => {
      hook.beforeCommitCommand = undefined;
      await writeDraft(1, edited);
    };
    const done = await confirm(record);
    expect(done.state).toBe("obsolete");
    expect(done.failure?.message).toContain("正文又改过");
    expect(await exists(join(book, "chapters", "0001.md"))).toBe(false);
    expect(await readFile(join(book, "drafts", "fast", "chapter-0001.md"), "utf-8")).toBe(edited);
  });

  it("定完、记检查点之前进程没了；作者之后又存了新稿：接着做照回执报「定了」，不说「没定稿」，新稿不动（Astra 第 12 轮）", async () => {
    await writeDraft(1, CH1);
    const record = await prepare(1);
    hook.afterCommitCommand = async () => {
      hook.afterCommitCommand = undefined;
      throw new OperationStopped("operation_stopped", "定完、记检查点之前断了");
    };
    expect(await confirm(record)).toMatchObject({ state: "paused" });
    const edited = CH1.replace("铜钥匙", "银钥匙");
    await writeDraft(1, edited);
    expect(await resumeOperation(book, record.opId)).toMatchObject({ ok: true });
    await __drainOperationsForTests();
    const done = await stored(record.opId);
    expect(done.state).toBe("succeeded");
    expect(bodyOf(done)).toMatchObject({ committed: true });
    expect(await readFile(join(book, "chapters", "0001.md"), "utf-8")).toContain("铜钥匙");
    expect(await readFile(join(book, "drafts", "fast", "chapter-0001.md"), "utf-8")).toBe(edited);
  });

  it("定完、记检查点之前断了；作者之后改稿又定了一次：接着做旧的那次照回执报，不拿后来的正文和条数冒充（Astra 第 14 轮第 2 条）", async () => {
    await writeDraft(1, CH1);
    const record = await prepare(1);
    hook.afterCommitCommand = async () => {
      hook.afterCommitCommand = undefined;
      throw new OperationStopped("operation_stopped", "定完、记检查点之前断了");
    };
    expect(await confirm(record)).toMatchObject({ state: "paused" });
    const firstLedger = await readChapterLedger(book, 1);
    const first = firstLedger?.entries ?? [];
    expect(first.filter((entry) => entry.kind === "fact")).toHaveLength(2);
    const later = await commit(1, CH1.replaceAll("铜钥匙", "银钥匙"), { summary: { text: "林远找到银钥匙", quote: "银钥匙" } });
    expect(bodyOf(later).done?.report?.ledger.facts).toBe(0);
    const head = await readHead(book);
    expect(await resumeOperation(book, record.opId)).toMatchObject({ ok: true });
    await __drainOperationsForTests();
    const done = await stored(record.opId);
    expect(done.state).toBe("succeeded");
    expect(await readHead(book)).toEqual(head);
    expect(bodyOf(done)).toMatchObject({ committed: true });
    expect(bodyOf(done).done?.report).toBeUndefined();
    expect(bodyOf(done).done?.draftBody).toBeUndefined();
    // 条数按声明算（时间一条声明存成开头、结尾几条）。
    expect(summaryOf(done)).toContain(`记了 ${declarationsOf(firstLedger!).length} 条`);
    expect(summaryOf(done)).toContain("之后又改过");
  });

  it("回放核完盘上还是这次写成的、读之前另一次撤销插进来：撤销等回放读完再写，回执卡是这次的（Astra 第 15 轮第 2 条）", async () => {
    await commit(1, CH1.replaceAll("铜钥匙", "银钥匙"), { summary: { text: "林远找到银钥匙", quote: "银钥匙" } });
    const middle = await commit(1, CH1.replaceAll("铜钥匙", "金钥匙"), { summary: { text: "林远找到金钥匙", quote: "金钥匙" } });
    await writeDraft(1, CH1);
    ledger = LEDGER1;
    const record = await prepare(1);
    hook.afterCommitCommand = async () => {
      hook.afterCommitCommand = undefined;
      throw new OperationStopped("operation_stopped", "定完、记检查点之前断了");
    };
    expect(await confirm(record)).toMatchObject({ state: "paused" });
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    hook.afterReceiptCheck = async () => {
      hook.afterReceiptCheck = undefined;
      enter();
      await released;
    };
    expect(await resumeOperation(book, record.opId)).toMatchObject({ ok: true });
    await entered;
    // 另一路：撤掉金钥匙那次（连带退回银钥匙那版）。回放拿着书锁，它写不进来。
    const undoing = undoInOperation(book, middle.opId);
    try {
      const until = Date.now() + 1500;
      while (Date.now() < until && !(await readFile(join(book, "chapters", "0001.md"), "utf-8")).includes("银钥匙")) await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await readFile(join(book, "chapters", "0001.md"), "utf-8")).toContain("铜钥匙");
    } finally {
      release();
    }
    await __drainOperationsForTests();
    const done = await stored(record.opId);
    expect(done.state).toBe("succeeded");
    expect(bodyOf(done).done?.report?.ledger.facts).toBe(2);
    expect(bodyOf(done).done?.draftBody).toContain("铜钥匙");
    expect(JSON.stringify(done.result)).not.toContain("银钥匙");
    await undoing;
    expect(await readFile(join(book, "chapters", "0001.md"), "utf-8")).toContain("银钥匙");
  });

  it("清单出来之后前文的账改过：不定稿、说哪样变了", async () => {
    await commit(1, CH1, LEDGER1);
    await writeDraft(2, CH2);
    ledger = LEDGER2;
    const record = await prepare(2);
    const moved = await runCommand(book, decisionRecord, { decisions: [{ type: "chapter.summary", chapter: 1, text: "林远拿走钥匙。" }] }, { caller: "author", idempotencyKey: "moved" });
    expect(moved.ok).toBe(true);
    const done = await confirm(record);
    expect(done.state).toBe("obsolete");
    expect(done.failure?.message).toMatch(/^清单出来之后.+改过，这份清单是照改之前记的，没定稿；要的话再点一次「定稿」。$/u);
    expect(await readChapterLedger(book, 2)).toBeUndefined();
  });

  it("字数下限后来才定、这章原来就短：改了再定稿不挡，提醒一句；原来够数的照样挡；「就这么短」只放这一章（作者长篇实跑 2026-10-26）", async () => {
    await commit(1, CH1, LEDGER1);
    await runCommand(book, cardWrite, { ops: [{ op: "rules.set", field: "minWords", value: 2000 }] }, { caller: "author", idempotencyKey: "min-2000" });

    await writeDraft(1, CH1.replace("老周没有拦他。", "老周没拦他。"));
    const again = viewOf(await prepare(1));
    expect(again.canCommit).toBe(true);
    expect(again.notes).toContain("这章原来定稿时就不到 2000 字，字数下限这次不挡");

    await writeDraft(2, CH2);
    ledger = LEDGER2;
    const fresh = await prepare(2);
    expect(bodyOf(fresh).blocked).toMatchObject({ canCommit: false, shortOnly: true });
    const allowed = viewOf(await prepare(2, { allowShort: true }));
    expect(allowed.canCommit).toBe(true);
    expect(allowed.notes?.some((note) => note.includes("你点了照样定稿，只这一章"))).toBe(true);
    // 对话交的带了也不算。
    expect(bodyOf(await prepare(2, { origin: "chat", allowShort: true })).blocked).toMatchObject({ shortOnly: true });
  });

  it("重定稿记账员看错天数：天数那行照上次定稿、说清这次看成第几天，算一条要你看（作者长篇实跑 2026-10-27）", async () => {
    await commit(1, CH1, LEDGER1);
    await commit(2, CH2, LEDGER2);
    await writeDraft(2, CH2.replace("没让外人进", "没让外人进门"));
    ledger = { ...LEDGER2, time: { start: { offset: 0, basis: "judged", quote: "林远把钥匙锁进铜盒" }, sameDay: true, timeOfDay: "上午" } };
    const view = viewOf(await prepare(2));
    const day = view.ledgerChecklist?.[0];
    expect(day).toMatchObject({ id: DAY_ITEM_ID, editableDay: 2, editableDayEnd: 2, needsConfirm: true, detail: "第二天上午" });
    expect(day?.label).toBe("这一章记为故事第 2 天（上午，推算是周三）（照上次定稿）");
    expect(day?.reason).toBe("记账员这次看成第 1 天，和上次定稿不一样；先照上次的记，不对就改天数");
    expect(view.summary).toContain("要你看");
  });

  it("记账员说不准离上一章隔几天：不估，天数那行请作者填，算一条要你看（换题材长篇实跑第 21 章「进了暑假」）", async () => {
    await commit(1, CH1, LEDGER1);
    await writeDraft(2, CH2);
    ledger = { ...LEDGER2, time: { start: "unknown", sameDay: true, timeOfDay: "上午" } };
    const view = viewOf(await prepare(2));
    expect(view.ledgerChecklist?.[0]).toMatchObject({ id: DAY_ITEM_ID, dayUnknown: true, needsConfirm: true });
    expect(view.ledgerChecklist?.[0]?.label).toBe("这章离上一章多久说不准，是故事哪天不知道；知道的话填上");
    expect(view.summary).toContain("要你看");
    // 按月、年说的原样给，不折天。
    ledger = { ...LEDGER2, time: { start: { offset: { unit: "month", min: 6, max: 6 }, basis: "text", quote: "第二天上午" }, sameDay: true } };
    expect(viewOf(await prepare(2)).ledgerChecklist?.[0]?.label).toBe("这章离上一章6 个月后，不折成天，是故事哪天不知道；知道的话填上");
  });

  it("一句说明推进两条线索：清单一行、标题并排；作者去掉这行两条都不记（换题材长篇实跑第 22 章同一段说明连出三遍）", async () => {
    await commit(1, CH1, { ...LEDGER1, threads: [...LEDGER1.threads, { op: "open", type: "question", title: "钥匙开哪把锁", note: "钟箱里的铜钥匙", quote: "他在钟箱里摸到一把铜钥匙" }] });
    await writeDraft(2, CH2);
    ledger = { ...LEDGER2, threads: [{ op: "advance", thread: "T1, T2", note: "钥匙锁进铜盒", quote: "林远把钥匙锁进铜盒" }] };
    const record = await prepare(2);
    const rows = viewOf(record).ledgerChecklist?.filter((item) => item.kind === "thread") ?? [];
    expect(rows.map((item) => item.label)).toEqual(["推进「钟为什么停」「钥匙开哪把锁」：钥匙锁进铜盒"]);
    expect((await confirm(record, [rows[0]?.id])).state).toBe("succeeded");
    expect((await projectBook(book)).threads.map((thread) => thread.lastTouchedAt)).toEqual([1, 1]);
  });

  it("和前文不会变的事实对不上：默认不记、作者勾上才记；撤销后重新出清单能再定稿", async () => {
    const base = (await readHead(book)).version;
    await commit(1, CH1, LEDGER1);
    await writeDraft(2, CH2);
    ledger = LEDGER2;
    const record = await prepare(2);
    const conflict = viewOf(record).ledgerChecklist?.find((item) => item.defaultUnchecked);
    expect(conflict).toMatchObject({ kind: "fact", needsConfirm: true });
    expect(conflict?.label).toContain("四点整");
    expect(viewOf(record).ledgerChecklist?.find((item) => item.kind === "thread")?.needsConfirm).toBe(true);

    const skipped = bodyOf(await confirm(record));
    expect(skipped.done?.report?.ledger).toMatchObject({ facts: 1, threadsClosed: 1 });
    expect((await readChapterLedger(book, 2))?.entries.some((entry) => entry.kind === "fact" && entry.text === "钟停在四点整")).toBe(false);

    expect((await restoreForTest(book, skipped.snapshotId ?? "")).length).toBeGreaterThan(0);
    // 恢复本身是一次新的写：版本号只往前走，不退回去。
    expect((await readHead(book)).version).toBeGreaterThan(base + 2);
    expect(await exists(join(book, "chapters", "0002.md"))).toBe(false);

    const again = await prepare(2);
    const optIn = viewOf(again).ledgerChecklist?.find((item) => item.defaultUnchecked);
    const taken = bodyOf(await confirm(again, [optIn?.id]));
    expect(taken.done?.report?.ledger.facts).toBe(2);
    expect((await projectBook(book)).conflicts).toHaveLength(1);
  });

  it("老书（有定稿章、没账单、没设定卡）第一次定稿：先存档、导入账单、搬老设定，老文件不动", async () => {
    // 重构 P9 以前的书：只有老格式文件（老设定、老账本），没有 ledger/。
    book = join(root, "old-book");
    await mkdir(join(book, "chapters"), { recursive: true });
    await mkdir(join(book, "story"), { recursive: true });
    await mkdir(join(book, "timeline"), { recursive: true });
    const at = "2026-10-01T00:00:00.000Z";
    await writeFile(join(book, "project.json"), JSON.stringify({ id: "old-book", title: "钟楼", createdAt: at, updatedAt: at }), "utf-8");
    await writeFile(join(book, "chapters", "0001.md"), CH1, "utf-8");
    await writeFile(join(book, "story", "character-bible.json"), JSON.stringify({
      version: "v0",
      characters: [{ id: "char-a", name: "林远", role: "主角", identity: "钟表匠" }],
    }), "utf-8");
    await writeFile(join(book, "story", "hooks.json"), JSON.stringify({ hooks: [] }), "utf-8");
    await writeFile(join(book, "timeline", "events.json"), "[]\n", "utf-8");
    const bibleBefore = await readFile(join(book, "story", "character-bible.json"), "utf-8");
    await writeDraft(2, CH2);
    ledger = { ...LEDGER2, threads: [] };
    const record = await prepare(2);
    expect(viewOf(record).canCommit).toBe(true);
    expect((await projectBook(book)).chapters[0]?.origin).toBe("import");
    expect((await listSnapshots(book)).length).toBeGreaterThan(0);
    // 老设定搬进了设定卡（主角认出来了）；老设定文件一字不动。
    expect((await readCards(book))?.cards).toEqual([expect.objectContaining({ name: "林远", protagonist: true })]);
    expect(await readFile(join(book, "story", "character-bible.json"), "utf-8")).toBe(bibleBefore);
    // 老账文件没标记（不是我们生成的）：原样留着。
    expect(await readFile(join(book, "story", "hooks.json"), "utf-8")).toBe(JSON.stringify({ hooks: [] }));
    expect(await readFile(join(book, "timeline", "events.json"), "utf-8")).toBe("[]\n");
  });
});

describe("openThreadsHintDue：开着的线索跨过一档才提「归并线索」", () => {
  it("到 20 提一次；停在 20 多不再念；到 25、30 再提；变少不提", () => {
    expect(openThreadsHintDue(19, 20)).toBe(true);
    expect(openThreadsHintDue(18, 22)).toBe(true);
    expect(openThreadsHintDue(20, 20)).toBe(false);
    expect(openThreadsHintDue(20, 21)).toBe(false);
    expect(openThreadsHintDue(24, 25)).toBe(true);
    expect(openThreadsHintDue(29, 31)).toBe(true);
    expect(openThreadsHintDue(26, 24)).toBe(false);
    expect(openThreadsHintDue(10, 15)).toBe(false);
  });
});
