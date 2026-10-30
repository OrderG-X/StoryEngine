// @vitest-environment node
//
// 定稿（写作版本 P2a 片 4A：commit.prepare 收编 commit_preview / commit_apply）：硬闸没过如实列原因、不出按钮；
// 过了就让记账员记账、停下等作者在清单上点「确认定稿」，点之前书一点不动；作者去掉的不记、改的天数照改；
// 清单出来之后正文或前文改过都不定稿、说哪样变了；同一个按钮再点不重复写。真项目、真存档点、真执行器；记账员是假的。
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cardWrite, decisionRecord, projectBook, readCards, readChapterLedger, readHead, runCommand } from "@actalk/story-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createStoryProject } from "../../../book/project-store.js";
import { MIRROR_FILES } from "../../../book/mirror/build.js";
import { MIRROR_BACKUP_DIR } from "../../../book/mirror/sync.js";
import type { BrainCallModel } from "../../../editorial/reader-window.js";
import { __resetCatchUpLocksForTests } from "../../../editorial/reader-window.js";
import { makeHomeTempDir } from "../../../lib/home-test-tmp.js";
import { __resetExecutionsForTests } from "../../../lib/operations/context.js";
import { __resetLiveForTests } from "../../../lib/operations/live.js";
import { __resetOperationStoreForTests, readOperation, type OperationRecord } from "../../../lib/operations/store.js";
import { listSnapshots } from "../../../lib/snapshot.js";
import { restoreForTest } from "../../../lib/history-test-helpers.js";
import { DAY_ITEM_ID, openThreadsHintDue, type CommitPreviewView } from "../../commit-view.js";
import { __drainOperationsForTests, __resetRecipesForTests, registerRecipe, resumeOperation, submitOperation } from "../executor.js";
import {
  COMMIT_CONFIRM_ACTION,
  COMMIT_CONFIRM_KIND,
  COMMIT_PREPARE_KIND,
  createCommitPrepareRecipe,
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
}));
vi.mock("../../../lib/operations/command.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/operations/command.js")>();
  return {
    ...actual,
    runCommandInOperation: async (...args: Parameters<typeof actual.runCommandInOperation>) => {
      if (args[1].name === "chapter.commit") await hook.beforeCommitCommand?.();
      return actual.runCommandInOperation(...args);
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
  time: { basis: "text", weekday: "周二", timeOfDay: "傍晚", quote: "周二傍晚" },
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
  time: { basis: "text", daysSincePrevious: 1, timeOfDay: "上午", quote: "第二天上午" },
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

  it("记账员没交成：这次没做成、原因如实，书一点没动", async () => {
    await writeDraft(1, CH1);
    const base = (await readHead(book)).version;
    ledger = undefined;
    const failed = await prepare(1);
    expect(failed.state).toBe("failed");
    expect(failed.failure?.message).toBeTruthy();
    expect(await readHead(book)).toMatchObject({ version: base });
    expect(await exists(join(book, "chapters", "0001.md"))).toBe(false);
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

  it("第 1 章正文没写时间：天数说「先这么记」，不提没有的上一章（2026-10-23 桌面包走查）", async () => {
    await writeDraft(1, CH1);
    const { time: _time, ...noTime } = LEDGER1;
    ledger = noTime;
    const day = viewOf(await prepare(1)).ledgerChecklist?.[0];
    expect(day?.label).toContain("故事第 1 天");
    expect(day?.label).toContain("先这么记");
    expect(day?.label).not.toContain("上一章");
  });
});

describe("作者点「确认定稿」", () => {
  it("去掉的不记、天数照改；写正文 + 账单 + 老格式镜像；后台预热；同一个按钮再点不重复写，换了选法不算", async () => {
    const base = (await readHead(book)).version;
    await writeDraft(1, CH1);
    const record = await prepare(1);
    const stranger = viewOf(record).ledgerChecklist?.find((item) => item.needsConfirm && item.label.includes("周守义"));
    const done = await confirm(record, [stranger?.id], { day: 3 });
    expect(done.state).toBe("succeeded");
    const body = bodyOf(done);
    expect(body).toMatchObject({ committed: true, snapshotId: expect.stringMatching(/^[0-9a-f]{40}$/u) });
    expect(body.done).toMatchObject({ draftTitle: "第1章 · 钟停", report: { chapter: 1, ledger: { facts: 2, threadsOpened: 1, threadsClosed: 0, present: 1, day: 3, notRecorded: 0 } } });
    expect(body.done?.draftBody.startsWith("周二傍晚")).toBe(true);
    expect(summaryOf(done)).toContain("第 1 章已定稿");
    expect(await readFile(join(book, "chapters", "0001.md"), "utf-8")).toBe(CH1);
    expect((await projectBook(book)).chapters[0]).toMatchObject({ day: 3, dayBasis: "author", present: ["林远"] });
    expect(await exists(join(book, ".story-core-mirror.json"))).toBe(true);
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
    ledger = { ...LEDGER2, time: { basis: "judged", daysSincePrevious: 0, timeOfDay: "上午", quote: "林远把钥匙锁进铜盒" } };
    const view = viewOf(await prepare(2));
    const day = view.ledgerChecklist?.[0];
    expect(day).toMatchObject({ id: DAY_ITEM_ID, editableDay: 2, needsConfirm: true, detail: "第二天上午" });
    expect(day?.label).toBe("这一章记为故事第 2 天（上午，周三）（照上次定稿）");
    expect(day?.reason).toBe("记账员这次看成第 1 天，和上次定稿不一样；先照上次的记，不对就改天数");
    expect(view.summary).toContain("要你看");
  });

  it("记账员没说离上一章隔几天：天数那行说清是估的，算一条要你看（换题材长篇实跑第 21 章「进了暑假」）", async () => {
    await commit(1, CH1, LEDGER1);
    await writeDraft(2, CH2);
    ledger = { ...LEDGER2, time: { basis: "text", timeOfDay: "上午", quote: "第二天上午" } };
    const view = viewOf(await prepare(2));
    expect(view.ledgerChecklist?.[0]).toMatchObject({ id: DAY_ITEM_ID, editableDay: 2, needsConfirm: true });
    expect(view.ledgerChecklist?.[0]?.label).toBe("这一章记为故事第 2 天（上午，周三）（正文没说离上一章隔了几天，先按第二天记，不对就改）");
    expect(view.summary).toContain("要你看");
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
    expect(skipped.done?.report.ledger).toMatchObject({ facts: 1, threadsClosed: 1 });
    expect((await readChapterLedger(book, 2))?.entries.some((entry) => entry.kind === "fact" && entry.text === "钟停在四点整")).toBe(false);

    expect((await restoreForTest(book, skipped.snapshotId ?? "")).length).toBeGreaterThan(0);
    // 恢复本身是一次新的写：版本号只往前走，不退回去。
    expect((await readHead(book)).version).toBeGreaterThan(base + 2);
    expect(await exists(join(book, "chapters", "0002.md"))).toBe(false);

    const again = await prepare(2);
    const optIn = viewOf(again).ledgerChecklist?.find((item) => item.defaultUnchecked);
    const taken = bodyOf(await confirm(again, [optIn?.id]));
    expect(taken.done?.report.ledger.facts).toBe(2);
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
    const mirrored = new Map<string, string>();
    for (const file of Object.values(MIRROR_FILES)) {
      const content = await readFile(join(book, file), "utf-8").catch(() => undefined);
      if (content !== undefined) mirrored.set(file, content);
    }
    expect(mirrored.size).toBeGreaterThan(0);
    await writeDraft(2, CH2);
    ledger = { ...LEDGER2, threads: [] };
    const record = await prepare(2);
    expect(viewOf(record).canCommit).toBe(true);
    expect((await projectBook(book)).chapters[0]?.origin).toBe("import");
    expect((await listSnapshots(book)).length).toBeGreaterThan(0);
    // 老设定搬进了设定卡（主角认出来了）；老设定文件一字不动。
    expect((await readCards(book))?.cards).toEqual([expect.objectContaining({ name: "林远", protagonist: true })]);
    expect(await readFile(join(book, "story", "character-bible.json"), "utf-8")).toBe(bibleBefore);
    // 镜像要重生成的老文件，第一次生成前原样留了一份。
    for (const [file, content] of mirrored) {
      expect(await readFile(join(book, MIRROR_BACKUP_DIR, file), "utf-8")).toBe(content);
    }
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
