// @vitest-environment node
//
// 定稿（写作版本 P2a 片 4A；安静账房 2026-11-03）：作者点「定稿」就是授权，核账 → 记账 → 定一路走完，回执一句；
// 只有核出「确定」对不上的才停下给作者看；对话里交的先问一句「定稿？」，点了才花钱。硬闸没过如实列原因；
// 记账没成自动再记一次，还不成先定正文、账待记；途中正文或前文改过都不定稿、说哪样变了。
// 真项目、真存档点、真执行器；记账员、核账员是假的。
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cardWrite, chapterCommit, decisionRecord, draftVersionOf, projectBook, readCards, readChapterLedger, readDraftStamp, readHead, runCommand } from "@actalk/story-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createStoryProject } from "../../../book/project-store.js";
import type { BrainCallModel } from "../../../editorial/reader-window.js";
import { __resetCatchUpLocksForTests } from "../../../editorial/reader-window.js";
import { makeHomeTempDir } from "../../../lib/home-test-tmp.js";
import { __resetExecutionsForTests, OperationStopped } from "../../../lib/operations/context.js";
import { __resetLiveForTests } from "../../../lib/operations/live.js";
import { __resetOperationStoreForTests, readOperation, type OperationRecord } from "../../../lib/operations/store.js";
import { setReaderBackfillHandler } from "../../../lib/reader-backfill.js";
import { listSnapshots } from "../../../lib/snapshot.js";
import { restoreForTest } from "../../../lib/history-test-helpers.js";
import type { AuthorChoicePreview } from "../../commit-view.js";
import { READER_CHECK_SENDS } from "../budgets.js";
import { undoInOperation } from "../test-helpers.js";
import { __drainOperationsForTests, __resetRecipesForTests, registerRecipe, resumeOperation, submitOperation } from "../executor.js";
import {
  AUTHOR_CHOICE_KIND,
  COMMIT_ASK_ACTION,
  COMMIT_CHECK_SENDS,
  COMMIT_CONFLICTS_ACTION,
  COMMIT_LEDGER_SENDS,
  COMMIT_PREPARE_KIND,
  createCommitPrepareRecipe,
  LEDGER_ROUNDS,
  readCommitPrepareParams,
  type CommitPrepareBody,
} from "./commit-prepare.js";

const warmUpReadersMock = vi.hoisted(() => vi.fn(() => undefined));
/** 在记账员动手之前插一次别的写（时序屏障，第 8 轮复核 V4）。 */
const hook = vi.hoisted(() => ({
  beforePrepare: undefined as undefined | (() => Promise<void>),
  /** 配方读完正文、交定稿 / 补账命令之前插一次别的写（Astra 第 11 轮）。 */
  beforeCommitCommand: undefined as undefined | (() => Promise<void>),
  beforeFillCommand: undefined as undefined | (() => Promise<void>),
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
      if (args[1].name === "ledger.complete") await hook.beforeFillCommand?.();
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
const RAW_ID = /c\d+-\d|t\d+-\d|commit_|prepare_commit|commit-ask|commit-conflicts/u;

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
/** 点了之后正文又改过（冻结、核账、记账那会儿）：不定稿时说的那句。 */
const DRAFT_CHANGED = "点了「定稿」之后正文又改过，没定稿；要的话再点一次「定稿」。";
/** 核账员开着 conflict 时报的那处：第 2 章的钟和第 1 章对不上。 */
const CONFLICT = { quote: "第二天上午，钟楼的钟停在四点整。", earlierQuote: "周二傍晚，钟停在三点十五分。", earlierChapter: 1, reason: "钟停的时刻对不上", confidence: "sure" };

let root: string;
let book: string;
/** 记账员这次交的账单（按测试换）；undefined = 记账员没交成。 */
let ledger: unknown;
/** 记账员交账单那几次（不算读前文）。 */
let keeperCalls = 0;
/** 假核账员的开关和计数：conflict = 报上面那处；fail = 核的那几遍抛这句；failPass = 提示里带这几个字的那一遍抛错；failNotes = 读前文抛这句。 */
let reader: { conflict: boolean; fail?: string; failPass?: string; failNotes?: string; notes: number; checks: number };

/** 假记账员：要账单交 ledger，要笔记交笔记。 */
const fakeModel: BrainCallModel = async (messages) => {
  const last = messages.at(-1)?.content ?? "";
  if (!(last.includes("交这一章的账单") || last.includes("只记本章东西的去向"))) return "笔记：老周＝周守义。";
  keeperCalls += 1;
  if (ledger === undefined) throw new Error("模型没回话");
  return JSON.stringify(ledger);
};

/** 假核账员：写笔记回一句；「盯东西」那遍看到 CONFLICT 那句报一处确定的；自复核都判 sure。 */
const fakeReader: BrainCallModel = async (messages, call) => {
  if (!call.json) {
    reader.notes += 1;
    if (reader.failNotes) throw new Error(reader.failNotes);
    return "笔记：钟停在三点十五分。";
  }
  reader.checks += 1;
  if (reader.fail) throw new Error(reader.fail);
  const last = messages.at(-1)!.content;
  if (last.includes("你刚才核完报了")) {
    const ids = [...last.matchAll(/【(K\d+)】/gu)].map((match) => match[1]);
    return JSON.stringify({ verdicts: ids.map((id) => ({ id, verdict: "sure" })) });
  }
  if (reader.failPass && last.includes(reader.failPass)) throw new Error("服务商 502");
  if (reader.conflict && last.includes("这一遍只盯东西") && last.includes(CONFLICT.quote)) return JSON.stringify({ checks: [], contradictions: [CONFLICT] });
  return JSON.stringify({ checks: [], contradictions: [] });
};

const recipeNow = () => createCommitPrepareRecipe({ callModel: (messages, options) => fakeModel(messages, options), readerCallModel: fakeReader, modelProblem: () => undefined });

beforeEach(async () => {
  __resetOperationStoreForTests();
  __resetExecutionsForTests();
  __resetLiveForTests();
  __resetRecipesForTests();
  __resetCatchUpLocksForTests();
  warmUpReadersMock.mockClear();
  hook.beforePrepare = undefined;
  hook.beforeCommitCommand = undefined;
  hook.beforeFillCommand = undefined;
  hook.afterCommitCommand = undefined;
  hook.afterReceiptCheck = undefined;
  root = await makeHomeTempDir("commit-prepare-");
  vi.stubEnv("SE_DATA_DIR", join(root, "data"));
  ({ projectDir: book } = await createStoryProject({ rootDir: root, title: "钟楼", genre: "悬疑", logline: "钟停了。", protagonistName: "林远" }));
  ledger = LEDGER1;
  keeperCalls = 0;
  reader = { conflict: false, notes: 0, checks: 0 };
  registerRecipe(recipeNow());
});
afterEach(async () => {
  await __drainOperationsForTests();
  __resetRecipesForTests();
  setReaderBackfillHandler(undefined);
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

/** 交一次定稿（缺省是作者点的「定稿」）、等它停下（做完 / 定不了 / 等作者 / 没做成）。 */
async function prepare(chapter: number, options: { readonly origin?: "chat" | "button"; readonly allowShort?: boolean; readonly fill?: boolean; readonly requestKey?: string; readonly draftVersion?: string } = {}): Promise<OperationRecord> {
  const outcome = await submitOperation(book, {
    kind: COMMIT_PREPARE_KIND,
    params: { chapter, ...(options.allowShort ? { allowShort: true } : {}), ...(options.fill ? { fill: true } : {}), ...(options.draftVersion ? { draftVersion: options.draftVersion } : {}) },
    requestKey: options.requestKey ?? randomUUID(),
    issuedAt: new Date().toISOString(),
    origin: options.origin === "chat" ? { kind: "chat", messageId: randomUUID() } : { kind: "button" },
  });
  if (!outcome.ok || !("record" in outcome)) throw new Error(`没受理：${JSON.stringify(outcome)}`);
  await __drainOperationsForTests();
  return stored(outcome.record.opId);
}

const waitingOf = (record: OperationRecord) => record.pendingActions.find((action) => !action.decisionHash);
const choiceOf = (record: OperationRecord): AuthorChoicePreview => waitingOf(record)!.preview as AuthorChoicePreview;
const bodyOf = (record: OperationRecord): CommitPrepareBody => (record.result as { readonly body: CommitPrepareBody }).body;
const summaryOf = (record: OperationRecord): string => (record.result as { readonly summary: string }).summary;

/** 作者点卡上的按钮（「定稿」「补记账」「照这样定稿」都是 commit）。 */
async function answer(record: OperationRecord, actionId: string): Promise<OperationRecord> {
  expect(await resumeOperation(book, record.opId, { actionId, decision: "commit" })).toMatchObject({ ok: true });
  await __drainOperationsForTests();
  return stored(record.opId);
}

/** 写好工作稿、点「定稿」一路定完。 */
async function commit(chapter: number, text: string, entries: unknown): Promise<OperationRecord> {
  await writeDraft(chapter, text);
  ledger = entries;
  const done = await prepare(chapter);
  expect(done.state).toBe("succeeded");
  expect(bodyOf(done).committed).toBe(true);
  return done;
}

describe("交来的参数和额度", () => {
  it("章号要对；「就这么短」、点的是哪一版只认按钮；补账谁交都行", () => {
    expect(readCommitPrepareParams("chat", { chapter: 0 })).toEqual({ invalid: "要定稿哪一章没说清。" });
    expect(readCommitPrepareParams("chat", { chapter: 2, allowShort: true, draftVersion: "v1" })).toEqual({ chapter: 2 });
    expect(readCommitPrepareParams("button", { chapter: 2, allowShort: true, draftVersion: "v1" })).toEqual({ chapter: 2, allowShort: true, draftVersion: "v1" });
    expect(readCommitPrepareParams("button", { chapter: 2, draftVersion: "" })).toEqual({ chapter: 2 });
    expect(readCommitPrepareParams("chat", { chapter: 3, fill: true })).toEqual({ chapter: 3, fill: true });
    expect(readCommitPrepareParams("chat", { fill: true })).toEqual({ invalid: "要补哪一章的账没说清。" });
  });

  it("额度：定稿 = 核一遍 + 记两轮账；补账只记两轮；接着做按停下那步往后的最坏值加", async () => {
    await writeDraft(1, CH1);
    ledger = undefined;
    expect((await prepare(1)).budget.limit).toBe(COMMIT_CHECK_SENDS + LEDGER_ROUNDS * COMMIT_LEDGER_SENDS);
    expect((await prepare(1, { fill: true, origin: "chat" })).budget.limit).toBe(LEDGER_ROUNDS * COMMIT_LEDGER_SENDS);
    const recipe = recipeNow();
    expect(recipe.stepBudget(`author:${COMMIT_ASK_ACTION}`, { chapter: 1 })).toBe(COMMIT_CHECK_SENDS + LEDGER_ROUNDS * COMMIT_LEDGER_SENDS);
    expect(recipe.stepBudget("check", { chapter: 1 })).toBe(READER_CHECK_SENDS + LEDGER_ROUNDS * COMMIT_LEDGER_SENDS);
    expect(recipe.stepBudget(`author:${COMMIT_CONFLICTS_ACTION}`, { chapter: 1 })).toBe(LEDGER_ROUNDS * COMMIT_LEDGER_SENDS);
    expect(recipe.stepBudget("ledger:2", { chapter: 1 })).toBe(COMMIT_LEDGER_SENDS);
    expect(recipe.stepBudget("commit", { chapter: 1 })).toBe(0);
    expect(recipe.stepBudget(`author:${COMMIT_ASK_ACTION}`, { chapter: 1, fill: true })).toBe(LEDGER_ROUNDS * COMMIT_LEDGER_SENDS);
    expect(recipe.stepBudget("fill", { chapter: 1, fill: true })).toBe(0);
    expect(recipe.stepBudget(undefined, { chapter: 1 })).toBe(0);
  });
});

describe("定不了：如实列原因，不出按钮", () => {
  it("没有工作稿 / 太短：原因是人话、不带路径；只差字数的卡上给「就这么短，照样定稿」；对话交的也不先问", async () => {
    const missing = await prepare(1);
    expect(missing.state).toBe("succeeded");
    expect(missing.pendingActions).toEqual([]);
    expect(bodyOf(missing)).toMatchObject({ kind: COMMIT_PREPARE_KIND, chapter: 1, committed: false, blocked: { chapter: 1 } });
    expect(summaryOf(missing)).toContain("还没有工作稿");
    expect(summaryOf(missing)).not.toContain(book);

    await writeDraft(1, "# 第1章\n\n钟停了。\n");
    for (const origin of ["button", "chat"] as const) {
      const record = await prepare(1, { origin });
      expect(record.pendingActions).toEqual([]);
      const short = bodyOf(record).blocked!;
      expect(short.blockingReasons.join("")).toContain("下限");
      expect(short.blockingReasons.join("")).toContain("「就这么短，照样定稿」");
      expect(short.shortOnly).toBe(true);
      expect(short.draftIssues?.length).toBeGreaterThan(0);
    }
    expect(keeperCalls + reader.checks + reader.notes).toBe(0);
    expect(await readChapterLedger(book, 1)).toBeUndefined();
  });

  it("记账前作者改了设定：不定稿、说再点一次；再点一次照新下限挡（第 8 轮 V4）", async () => {
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
    expect(fresh.blockingReasons.join("")).toContain("1000");
  });

  it("前面差一章没定：原因只说那一章", async () => {
    await writeDraft(2, CH2);
    const record = await prepare(2);
    expect(bodyOf(record).committed).toBe(false);
    expect(summaryOf(record)).toBe("第 2 章现在还定不了：第 1 章还没定稿，先定稿前面的章。");
  });

  it("字数下限后来才定、这章原来就短：改了再定稿不挡；原来够数的照样挡；「就这么短」只放这一章、只认按钮（作者长篇实跑 2026-10-26）", async () => {
    await commit(1, CH1, LEDGER1);
    await runCommand(book, cardWrite, { ops: [{ op: "rules.set", field: "minWords", value: 2000 }] }, { caller: "author", idempotencyKey: "min-2000" });

    await writeDraft(1, CH1.replace("老周没有拦他。", "老周没拦他。"));
    expect(bodyOf(await prepare(1)).committed).toBe(true);

    await writeDraft(2, CH2);
    ledger = LEDGER2;
    expect(bodyOf(await prepare(2)).blocked).toMatchObject({ shortOnly: true });
    expect(bodyOf(await prepare(2, { origin: "chat", allowShort: true })).blocked).toMatchObject({ shortOnly: true });
    expect(bodyOf(await prepare(2, { allowShort: true })).committed).toBe(true);
  });
});

describe("作者点「定稿」：核账 → 记账 → 定，一路走完", () => {
  it("没对不上的：直接定，写正文 + 账单，回执一句；记下的都算自动记的；后台预热；同一个按钮再点不重复写", async () => {
    const base = (await readHead(book)).version;
    await writeDraft(1, CH1);
    const requestKey = randomUUID();
    const done = await prepare(1, { requestKey });
    expect(done.state).toBe("succeeded");
    expect(done.pendingActions).toEqual([]);
    const body = bodyOf(done);
    expect(body).toMatchObject({ committed: true, snapshotId: expect.stringMatching(/^[0-9a-f]{40}$/u) });
    expect(body.done).toMatchObject({ draftTitle: "第1章 · 钟停", report: { chapter: 1, status: "ready" } });
    expect(body.done?.draftBody?.startsWith("周二傍晚")).toBe(true);
    expect(summaryOf(done)).toBe("第 1 章定稿了。");
    expect(reader.checks).toBeGreaterThan(0);
    expect(await readFile(join(book, "chapters", "0001.md"), "utf-8")).toBe(CH1);
    const written = await readChapterLedger(book, 1);
    expect(written?.status).toBe("ready");
    expect(written?.entries.every((entry) => entry.review === "auto")).toBe(true);
    const view = await projectBook(book);
    expect(view.chapters[0]).toMatchObject({ time: { start: { lo: 1, hi: 1 } }, present: ["林远", "周守义"] });
    expect(view.threads[0]).toMatchObject({ title: "钟为什么停", status: "open" });
    expect(warmUpReadersMock).toHaveBeenCalledWith(book, 1);

    expect((await prepare(1, { requestKey })).opId).toBe(done.opId);
    expect(await readHead(book)).toMatchObject({ version: base + 1 });
  });

  it("核出确定对不上的：停下，卡上只列这几处、一个「照这样定稿」，记账员还没动、书没动；点了照样定", async () => {
    await commit(1, CH1, LEDGER1);
    const base = (await readHead(book)).version;
    await writeDraft(2, CH2);
    ledger = LEDGER2;
    reader.conflict = true;
    keeperCalls = 0;
    const record = await prepare(2);
    expect(record.state).toBe("waiting_author");
    expect(waitingOf(record)).toMatchObject({ actionId: COMMIT_CONFLICTS_ACTION, kind: AUTHOR_CHOICE_KIND, decisions: ["commit"] });
    const choice = choiceOf(record);
    expect(choice.lines).toEqual([`第 2 章有 ${choice.check?.sure.length} 处和前文对不上，改好了再点「定稿」。`]);
    expect(choice.check?.sure.map((issue) => issue.quote)).toContain(CONFLICT.quote);
    expect(choice.check?.maybe).toEqual([]);
    expect(choice.choices).toEqual([{ decision: "commit", label: "照这样定稿" }]);
    expect(JSON.stringify(choice.lines.concat(choice.choices.map((item) => item.label)))).not.toMatch(RAW_ID);
    expect(keeperCalls).toBe(0);
    expect(await readHead(book)).toMatchObject({ version: base });
    expect(await exists(join(book, "chapters", "0002.md"))).toBe(false);

    const done = await answer(record, COMMIT_CONFLICTS_ACTION);
    expect(done.state).toBe("succeeded");
    expect(summaryOf(done)).toBe("第 2 章定稿了。");
    expect(keeperCalls).toBeGreaterThan(0);
    expect(await readFile(join(book, "chapters", "0002.md"), "utf-8")).toBe(CH2);
  });

  it("等着作者看对不上的那几处时作者改了稿，又点「照这样定稿」：不定稿、说正文改过", async () => {
    await commit(1, CH1, LEDGER1);
    await writeDraft(2, CH2);
    ledger = LEDGER2;
    reader.conflict = true;
    const record = await prepare(2);
    expect(waitingOf(record)?.actionId).toBe(COMMIT_CONFLICTS_ACTION);
    await writeDraft(2, CH2.replace("第二天上午，钟楼的钟停在四点整。", "第二天上午，钟楼的钟还停在三点十五分。"));
    keeperCalls = 0;
    const done = await answer(record, COMMIT_CONFLICTS_ACTION);
    expect(done.state).toBe("obsolete");
    expect(done.failure?.message).toBe(DRAFT_CHANGED);
    expect(keeperCalls).toBe(0);
    expect(await exists(join(book, "chapters", "0002.md"))).toBe(false);
  });

  it("记账员交的有几条接不上（指着前文没有的线索）：照定，回执说有几条没记上", async () => {
    await writeDraft(1, CH1);
    ledger = { ...LEDGER1, threads: [...LEDGER1.threads, { op: "advance", thread: "T9", note: "钥匙的来历", quote: "揣进了包里" }] };
    const done = await prepare(1);
    expect(done.state).toBe("succeeded");
    expect(summaryOf(done)).toBe("第 1 章定稿了。有 1 条账没记上。");
    expect((await readChapterLedger(book, 1))?.status).toBe("ready");
  });

  it("核账没跑成不挡定稿：照样定，回执里多一句没核成（读前文没成、核那遍没成都算）", async () => {
    await writeDraft(1, CH1);
    reader.fail = "服务商 500";
    const first = await prepare(1);
    expect(first.state).toBe("succeeded");
    expect(bodyOf(first).committed).toBe(true);
    expect(summaryOf(first)).toMatch(/^第 1 章定稿了。这次没核成：.+。$/u);

    reader.fail = undefined;
    reader.failNotes = "服务商 500";
    await writeDraft(2, CH2);
    ledger = LEDGER2;
    const second = await prepare(2);
    expect(second.state).toBe("succeeded");
    expect(summaryOf(second)).toBe("第 2 章定稿了。这次没核成：核账员读前文没成：服务商 500。");
  });

  it("核账有一遍没跑成、别的遍核出了对不上的：照样停下；点了照样定，回执说这次没核全（Astra 安静账房第 9 条）", async () => {
    await commit(1, CH1, LEDGER1);
    await writeDraft(2, CH2);
    ledger = LEDGER2;
    reader.conflict = true;
    reader.failPass = "这一遍只盯人";
    const record = await prepare(2);
    expect(waitingOf(record)).toMatchObject({ actionId: COMMIT_CONFLICTS_ACTION });
    const done = await answer(record, COMMIT_CONFLICTS_ACTION);
    expect(done.state).toBe("succeeded");
    expect(summaryOf(done)).toMatch(/^第 2 章定稿了。这次没核全：.*服务商 502.*。$/u);
  });

  it("核账员还没读完前文：照冷窗口核、照样定，回执里说只对照了一部分", async () => {
    setReaderBackfillHandler(async () => undefined);
    for (let chapter = 1; chapter <= 12; chapter += 1) {
      expect(await runCommand(book, chapterCommit, { chapter, text: `# 第${chapter}章\n\n林远照常开门。\n`, entries: [] }, { caller: "author", idempotencyKey: `seed-${chapter}` })).toMatchObject({ ok: true });
    }
    const ch13 = `# 第13章\n\n林远把钥匙拿出来。${FILLER}\n`;
    await writeDraft(13, ch13);
    ledger = { summary: { text: "林远拿出钥匙", quote: "林远把钥匙拿出来" } };
    const done = await prepare(13);
    expect(done.state).toBe("succeeded");
    expect(summaryOf(done)).toBe("第 13 章定稿了。核账员还没读完前文，这次只对照了读过的和最近几章。");
  });

  it("和前文不会变的事实对不上：那条不写、其余照记；撤销后再定稿照样不写", async () => {
    const base = (await readHead(book)).version;
    await commit(1, CH1, LEDGER1);
    const ch2 = await commit(2, CH2, LEDGER2);
    const facts = async () => (await readChapterLedger(book, 2))?.entries.flatMap((entry) => (entry.kind === "fact" ? [entry.text] : [])) ?? [];
    expect(await facts()).toEqual(["铜钥匙锁在铜盒里"]);
    expect((await projectBook(book)).threads[0]).toMatchObject({ status: "closed", closedAt: 2 });

    expect((await restoreForTest(book, bodyOf(ch2).snapshotId ?? "")).length).toBeGreaterThan(0);
    // 恢复本身是一次新的写：版本号只往前走，不退回去。
    expect((await readHead(book)).version).toBeGreaterThan(base + 2);
    expect(await exists(join(book, "chapters", "0002.md"))).toBe(false);
    await commit(2, CH2, LEDGER2);
    expect(await facts()).toEqual(["铜钥匙锁在铜盒里"]);
    expect((await projectBook(book)).conflicts).toEqual([]);
  });

  it("同一章又点了一次：停着的旧的作废、点旧的如实说用新的；别的章的不碰", async () => {
    await commit(1, CH1, LEDGER1);
    const other = await prepare(1, { origin: "chat" });
    await writeDraft(2, CH2);
    ledger = LEDGER2;
    const first = await prepare(2, { origin: "chat" });
    const second = await prepare(2, { origin: "chat" });
    expect(other.state).toBe("waiting_author");
    expect(await stored(first.opId)).toMatchObject({ state: "obsolete", failure: { code: "superseded", retryable: false } });
    expect(await resumeOperation(book, first.opId, { actionId: COMMIT_ASK_ACTION, decision: "commit" }))
      .toMatchObject({ ok: false, message: "这一章后来又点了一次定稿，用新的那次。" });
    expect((await stored(other.opId)).state).toBe("waiting_author");
    expect((await answer(second, COMMIT_ASK_ACTION)).state).toBe("succeeded");
  });
});

describe("对话里交的：先问一句，作者点了才花钱", () => {
  it("停在「定稿？」：模型一次没调、书没动；点「定稿」照常核账记账定；同一个按钮再点回放，没有的选法不受理", async () => {
    const base = (await readHead(book)).version;
    await writeDraft(1, CH1);
    const record = await prepare(1, { origin: "chat" });
    expect(record.state).toBe("waiting_author");
    expect(waitingOf(record)).toMatchObject({ actionId: COMMIT_ASK_ACTION, kind: AUTHOR_CHOICE_KIND, decisions: ["commit"] });
    expect(choiceOf(record)).toEqual({ lines: ["第 1 章要定稿吗？定了也能撤。"], choices: [{ decision: "commit", label: "定稿", primary: true }] });
    expect(keeperCalls + reader.checks + reader.notes).toBe(0);
    expect(await exists(join(book, "chapters", "0001.md"))).toBe(false);
    expect(await readHead(book)).toMatchObject({ version: base });
    expect(await resumeOperation(book, record.opId, { actionId: COMMIT_ASK_ACTION, decision: "retry" })).toMatchObject({ ok: false, code: "bad_decision" });

    const done = await answer(record, COMMIT_ASK_ACTION);
    expect(done.state).toBe("succeeded");
    expect(summaryOf(done)).toBe("第 1 章定稿了。");
    expect(reader.checks).toBeGreaterThan(0);
    expect(await resumeOperation(book, record.opId, { actionId: COMMIT_ASK_ACTION, decision: "commit" })).toMatchObject({ ok: true, replayed: true });
    await __drainOperationsForTests();
    expect(await readHead(book)).toMatchObject({ version: base + 1 });
  });

  it("停着时作者又改了稿：点了照新稿定（冻结的是点了之后的正文）", async () => {
    await writeDraft(1, CH1);
    const record = await prepare(1, { origin: "chat" });
    const edited = CH1.replace("铜钥匙", "银钥匙");
    await writeDraft(1, edited);
    ledger = { ...LEDGER1, summary: { text: "林远进钟楼拿走钥匙", quote: "他在钟箱里摸到一把银钥匙" }, facts: [] };
    expect((await answer(record, COMMIT_ASK_ACTION)).state).toBe("succeeded");
    expect(await readFile(join(book, "chapters", "0001.md"), "utf-8")).toBe(edited);
  });
});

describe("记账没成：自动再记一次，还不成先定正文、账待记（P2b 设计 3.1）", () => {
  it("头一轮没成、第二轮成了：照常定，回执不提没成的那轮", async () => {
    await writeDraft(1, CH1);
    let rounds = 0;
    hook.beforePrepare = async () => {
      rounds += 1;
      ledger = rounds === 1 ? undefined : LEDGER1;
    };
    const done = await prepare(1);
    expect(rounds).toBe(2);
    expect(done.state).toBe("succeeded");
    expect(summaryOf(done)).toBe("第 1 章定稿了。");
    expect((await readChapterLedger(book, 1))?.status).toBe("ready");
  });

  it("两轮都没成：正文定了、账单待记；回执如实说原因、给「补记账」；哪天不知道；能撤销", async () => {
    await writeDraft(1, CH1);
    ledger = undefined;
    let rounds = 0;
    hook.beforePrepare = async () => { rounds += 1; };
    const done = await prepare(1);
    expect(rounds).toBe(LEDGER_ROUNDS);
    expect(done.state).toBe("succeeded");
    expect(bodyOf(done)).toMatchObject({ committed: true, done: { report: { chapter: 1, status: "pending" } } });
    expect(summaryOf(done)).toBe("第 1 章定稿了，账没记上（记账员没交上账单：模型没回话）；可以点「补记账」再记。");
    expect(await readFile(join(book, "chapters", "0001.md"), "utf-8")).toBe(CH1);
    expect(await readChapterLedger(book, 1)).toMatchObject({ status: "pending", entries: [] });
    expect((await projectBook(book)).chapters[0]).toMatchObject({ ledgerStatus: "pending", time: { presentLine: "unknown", basis: "unknown" } });

    await undoInOperation(book, done.opId);
    expect(await exists(join(book, "chapters", "0001.md"))).toBe(false);
  });

  it("记账那会儿正文又改过：账待记也不定稿、说清楚", async () => {
    await writeDraft(1, CH1);
    ledger = undefined;
    hook.beforePrepare = async () => {
      await writeDraft(1, `${CH1}\n又补了一句。`);
    };
    const done = await prepare(1);
    expect(done.state).toBe("obsolete");
    expect(done.failure?.message).toContain("正文又改过");
    expect(await exists(join(book, "chapters", "0001.md"))).toBe(false);
  });
});

describe("补账（P2b 设计 3.2）：按定稿那版正文补记，正文不动、不核账", () => {
  async function pendingChapter1(): Promise<void> {
    await writeDraft(1, CH1);
    ledger = undefined;
    expect(bodyOf(await prepare(1))).toMatchObject({ committed: true, done: { report: { status: "pending" } } });
    ledger = LEDGER1;
  }

  it("点「补记账」：直接记、换上账单；正文和定稿时间不动、工作稿不碰；回执标补账", async () => {
    await pendingChapter1();
    const before = await readChapterLedger(book, 1);
    // 作者之后又在稿纸上改了工作稿：补账照定稿那版正文记，不碰工作稿。
    await writeDraft(1, `${CH1}\n工作稿上又写了一句。`);
    const checks = reader.checks + reader.notes;
    const done = await prepare(1, { fill: true });
    expect(done).toMatchObject({ state: "succeeded", mode: "fill" });
    expect(bodyOf(done)).toMatchObject({ committed: true, fill: true, done: { report: { fill: true, status: "ready" } } });
    expect(summaryOf(done)).toBe("第 1 章的账补上了。");
    expect(bodyOf(done).done?.draftBody).toBeUndefined();
    expect(reader.checks + reader.notes).toBe(checks);
    expect(await readFile(join(book, "chapters", "0001.md"), "utf-8")).toBe(CH1);
    expect(await readChapterLedger(book, 1)).toMatchObject({ status: "ready", committedAt: before!.committedAt, textSha256: before!.textSha256 });
    expect((await projectBook(book)).chapters[0]).toMatchObject({ ledgerStatus: "ready", time: { start: { lo: 1, hi: 1 } } });
  });

  it("对话里交的补账：先问「补记账？」，点了才记", async () => {
    await pendingChapter1();
    keeperCalls = 0;
    const record = await prepare(1, { fill: true, origin: "chat" });
    expect(record).toMatchObject({ state: "waiting_author", mode: "fill" });
    expect(choiceOf(record)).toEqual({ lines: ["第 1 章的账要补记吗？"], choices: [{ decision: "commit", label: "补记账", primary: true }] });
    expect(keeperCalls).toBe(0);
    expect((await answer(record, COMMIT_ASK_ACTION)).state).toBe("succeeded");
    expect((await readChapterLedger(book, 1))?.status).toBe("ready");
  });

  it("补摘原句那一步没成：账记成没记全、写明缺哪几类（P2b 出口复核第 2 条）；补账时又没成照样写明", async () => {
    // 线索和一条事实的原句对不上，补摘那次交回来的不是 JSON。
    const broken = {
      ...LEDGER1,
      facts: [LEDGER1.facts[0], { ...LEDGER1.facts[1], quote: "钟停在了三点一刻" }],
      threads: [{ ...LEDGER1.threads[0], quote: "钟到底为什么停" }],
    };
    const done = await commit(1, CH1, broken);
    expect(summaryOf(done)).toBe("第 1 章定稿了，账没记全（补摘原句那一步没成）；可以点「补记账」补全。");
    expect(await readChapterLedger(book, 1)).toMatchObject({ status: "partial", coverage: { reasonCodes: ["quote_repair_failed"], missingKinds: ["fact", "thread"] } });
    expect((await projectBook(book)).chapters[0]).toMatchObject({ ledgerStatus: "partial", missingKinds: ["fact", "thread"], time: { start: { lo: 1, hi: 1 } } });

    const filled = await prepare(1, { fill: true });
    expect(filled.state).toBe("succeeded");
    expect(summaryOf(filled)).toBe("第 1 章的账补了，还是没记全（补摘原句那一步没成）。");
    expect(await readChapterLedger(book, 1)).toMatchObject({ status: "partial", coverage: { missingKinds: ["fact", "thread"] } });
  });

  it("补不了的如实说：账已经记上了；记账两轮都没成说没补上、账照旧待记", async () => {
    await commit(1, CH1, LEDGER1);
    const ready = await prepare(1, { fill: true });
    expect(ready.state).toBe("succeeded");
    expect(bodyOf(ready)).toMatchObject({ committed: false, fill: true });
    expect(bodyOf(ready).blocked?.blockingReasons.join("")).toContain("已经记上了");

    await writeDraft(2, CH2);
    ledger = undefined;
    await prepare(2);
    const failed = await prepare(2, { fill: true });
    expect(failed.state).toBe("failed");
    expect(failed.failure).toMatchObject({ code: "keeper_failed", message: "第 2 章的账这次没补上：记账员没交上账单：模型没回话" });
    expect((await readChapterLedger(book, 2))?.status).toBe("pending");
  });

  it("记完账、换上之前这章的账又变过：不写、说改过；又交了一次定稿的，停着的补账作废", async () => {
    await pendingChapter1();
    hook.beforeFillCommand = async () => {
      hook.beforeFillCommand = undefined;
      // 别处（不经这次操作）把这章的账又写了一遍。
      expect(await runCommand(book, chapterCommit, { chapter: 1, text: CH1, entries: [], ledger: { status: "pending", reasonCodes: ["keeper_failed"] } }, { caller: "author", idempotencyKey: randomUUID() }))
        .toMatchObject({ ok: true });
    };
    const done = await prepare(1, { fill: true });
    expect(done.state).toBe("obsolete");
    expect(done.failure?.message).toContain("改过");
    expect(await readChapterLedger(book, 1)).toMatchObject({ status: "pending" });

    const again = await prepare(1, { fill: true, origin: "chat" });
    expect(again.state).toBe("waiting_author");
    await writeDraft(1, CH1);
    await prepare(1, { origin: "chat" });
    expect((await stored(again.opId)).state).toBe("obsolete");
  });
});

describe("定稿的途中书变了", () => {
  it("点了「定稿」之后、开工之前又存了稿：不定稿（定的得是作者点的那版），一次模型没调；点的就是现在这版照定", async () => {
    await writeDraft(1, CH1);
    const clicked = draftVersionOf(CH1, await readDraftStamp(book, 1));
    const edited = `${CH1}\n又补了一句。`;
    await writeDraft(1, edited);
    const stale = await prepare(1, { draftVersion: clicked });
    expect(stale.state).toBe("obsolete");
    expect(stale.failure?.message).toBe(DRAFT_CHANGED);
    expect(keeperCalls + reader.checks + reader.notes).toBe(0);
    expect(await exists(join(book, "chapters", "0001.md"))).toBe(false);

    const done = await prepare(1, { draftVersion: draftVersionOf(edited, await readDraftStamp(book, 1)) });
    expect(done.state).toBe("succeeded");
    expect(await readFile(join(book, "chapters", "0001.md"), "utf-8")).toBe(edited);
  });

  it("记账那会儿正文改过：不定稿、说正文改过；字没动只收了空行的照定", async () => {
    await writeDraft(1, CH1);
    hook.beforePrepare = async () => {
      hook.beforePrepare = undefined;
      await writeDraft(1, CH1.replace("\n\n", "\n\n\n\n"));
    };
    expect((await prepare(1)).state).toBe("succeeded");

    await writeDraft(2, CH2);
    ledger = LEDGER2;
    hook.beforePrepare = async () => {
      hook.beforePrepare = undefined;
      await writeDraft(2, `${CH2}林远又补了一句。\n`);
    };
    const done = await prepare(2);
    expect(done.state).toBe("obsolete");
    expect(done.failure?.message).toBe(DRAFT_CHANGED);
    expect(await exists(join(book, "chapters", "0002.md"))).toBe(false);
  });

  it("读完正文到上书锁之间作者又存了稿：不定稿（不拿读到的旧稿定），稿子是作者新存的那版", async () => {
    await writeDraft(1, CH1);
    const edited = CH1.replace("铜钥匙", "银钥匙");
    hook.beforeCommitCommand = async () => {
      hook.beforeCommitCommand = undefined;
      await writeDraft(1, edited);
    };
    const done = await prepare(1);
    expect(done.state).toBe("obsolete");
    expect(done.failure?.message).toContain("正文又改过");
    expect(await exists(join(book, "chapters", "0001.md"))).toBe(false);
    expect(await readFile(join(book, "drafts", "fast", "chapter-0001.md"), "utf-8")).toBe(edited);
  });

  it("记完账之后前文的账改过：不定稿、说哪样变了", async () => {
    await commit(1, CH1, LEDGER1);
    await writeDraft(2, CH2);
    ledger = LEDGER2;
    hook.beforeCommitCommand = async () => {
      hook.beforeCommitCommand = undefined;
      expect(await runCommand(book, decisionRecord, { decisions: [{ type: "chapter.summary", chapter: 1, text: "林远拿走钥匙。" }] }, { caller: "author", idempotencyKey: "moved" })).toMatchObject({ ok: true });
    };
    const done = await prepare(2);
    expect(done.state).toBe("obsolete");
    expect(done.failure?.message).toMatch(/^定稿的途中.+改过，没定稿；要的话再点一次「定稿」。$/u);
    expect(await readChapterLedger(book, 2)).toBeUndefined();
  });

  it("等着作者看对不上的那几处时前文改过，点了「照这样定稿」：记账时发现、不定稿", async () => {
    await commit(1, CH1, LEDGER1);
    await writeDraft(2, CH2);
    ledger = LEDGER2;
    reader.conflict = true;
    const record = await prepare(2);
    expect(waitingOf(record)?.actionId).toBe(COMMIT_CONFLICTS_ACTION);
    expect(await runCommand(book, decisionRecord, { decisions: [{ type: "chapter.summary", chapter: 1, text: "林远拿走钥匙。" }] }, { caller: "author", idempotencyKey: "moved" })).toMatchObject({ ok: true });
    const done = await answer(record, COMMIT_CONFLICTS_ACTION);
    expect(done.state).toBe("obsolete");
    expect(done.failure?.message).toContain("再点一次「定稿」");
    expect(await readChapterLedger(book, 2)).toBeUndefined();
  });

  it("定完、记检查点之前进程没了；作者之后又存了新稿：接着做照回执报「定了」，不说「没定稿」，新稿不动（Astra 第 12 轮）", async () => {
    await writeDraft(1, CH1);
    hook.afterCommitCommand = async () => {
      hook.afterCommitCommand = undefined;
      throw new OperationStopped("operation_stopped", "定完、记检查点之前断了");
    };
    const record = await prepare(1);
    expect(record.state).toBe("paused");
    const edited = CH1.replace("铜钥匙", "银钥匙");
    await writeDraft(1, edited);
    expect(await resumeOperation(book, record.opId)).toMatchObject({ ok: true });
    await __drainOperationsForTests();
    const done = await stored(record.opId);
    expect(done.state).toBe("succeeded");
    expect(bodyOf(done)).toMatchObject({ committed: true });
    expect(summaryOf(done)).toBe("第 1 章定稿了。");
    expect(await readFile(join(book, "chapters", "0001.md"), "utf-8")).toContain("铜钥匙");
    expect(await readFile(join(book, "drafts", "fast", "chapter-0001.md"), "utf-8")).toBe(edited);
  });

  it("定完、记检查点之前断了；作者之后改稿又定了一次：接着做旧的那次照回执报，不拿后来的正文冒充（Astra 第 14 轮第 2 条）", async () => {
    await writeDraft(1, CH1);
    hook.afterCommitCommand = async () => {
      hook.afterCommitCommand = undefined;
      throw new OperationStopped("operation_stopped", "定完、记检查点之前断了");
    };
    const record = await prepare(1);
    expect(record.state).toBe("paused");
    expect((await readChapterLedger(book, 1))?.entries.filter((entry) => entry.kind === "fact")).toHaveLength(2);
    await commit(1, CH1.replaceAll("铜钥匙", "银钥匙"), { summary: { text: "林远找到银钥匙", quote: "银钥匙" } });
    const head = await readHead(book);
    expect(await resumeOperation(book, record.opId)).toMatchObject({ ok: true });
    await __drainOperationsForTests();
    const done = await stored(record.opId);
    expect(done.state).toBe("succeeded");
    expect(await readHead(book)).toEqual(head);
    expect(bodyOf(done)).toMatchObject({ committed: true });
    expect(bodyOf(done).done?.report).toBeUndefined();
    expect(bodyOf(done).done?.draftBody).toBeUndefined();
    expect(summaryOf(done)).toBe("第 1 章这次的定稿已经写成了；这章之后又改过。");
  });

  it("回放核完盘上还是这次写成的、读之前另一次撤销插进来：撤销等回放读完再写，回执卡是这次的（Astra 第 15 轮第 2 条）", async () => {
    await commit(1, CH1.replaceAll("铜钥匙", "银钥匙"), { summary: { text: "林远找到银钥匙", quote: "银钥匙" } });
    const middle = await commit(1, CH1.replaceAll("铜钥匙", "金钥匙"), { summary: { text: "林远找到金钥匙", quote: "金钥匙" } });
    await writeDraft(1, CH1);
    ledger = LEDGER1;
    hook.afterCommitCommand = async () => {
      hook.afterCommitCommand = undefined;
      throw new OperationStopped("operation_stopped", "定完、记检查点之前断了");
    };
    const record = await prepare(1);
    expect(record.state).toBe("paused");
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
    expect(bodyOf(done).done?.report).toMatchObject({ chapter: 1, status: "ready" });
    expect(bodyOf(done).done?.draftBody).toContain("铜钥匙");
    expect(JSON.stringify(done.result)).not.toContain("银钥匙");
    await undoing;
    expect(await readFile(join(book, "chapters", "0001.md"), "utf-8")).toContain("银钥匙");
  });
});

describe("老书", () => {
  it("有定稿章、没账单、没设定卡的第一次定稿：先存档、导入账单、搬老设定，老文件不动", async () => {
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
    expect(record.state).toBe("succeeded");
    expect(bodyOf(record).committed).toBe(true);
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
