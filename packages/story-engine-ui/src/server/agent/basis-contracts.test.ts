// @vitest-environment node

/**
 * 依据安全契约（写作版本 P1a 复核，Astra 2026-10-29 的七个探针 R1～R7 转成的回归测试）：
 * 旧依据算出来的东西不许执行、不许被当成新的复用，也不许报假成功。模型全是假的（确定性返回）。
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  bookImportText,
  cardsImport,
  cardWrite,
  chapterCommit,
  decisionRecord,
  draftPath,
  draftSave,
  projectBook,
  readCards,
  readChapterLedger,
  readTruthBasis,
  runCommand,
  sha256,
  splitUnits,
} from "@actalk/story-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeChapterPlan, writeChapterPlan } from "../book/chapter-plan.js";
import { confirmChapterCommit, fileTicketStore, memoryTicketStore, prepareChapterCommit, type PrepareInput } from "../editorial/commit-flow.js";
import { planBasisOf, resolveChapterPlanForDraft } from "../editorial/plan-chapter.js";
import * as readers from "../editorial/reader-window.js";
import { readRereadState } from "../editorial/reread-state.js";
import { beginReread, runReread } from "../editorial/reread.js";
import { applySettleProposal, saveSettleProposal } from "../editorial/settle/store.js";
import { syncLegacyMirror } from "../book/mirror/sync.js";
import { readChapterPlan } from "../book/chapter-plan.js";
import { createBookBackup, restoreBookFromBackup } from "../lib/book-backup.js";
import { moveBookToTrash, restoreFromTrash } from "../lib/book-trash.js";
import { writeCards } from "../lib/card-write.js";
import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import { createSnapshot, restoreSnapshot } from "../lib/snapshot.js";
import { __resetOperationStoreForTests } from "../lib/operations/store.js";
import { __drainOperationsForTests, __resetRecipesForTests, registerRecipe, resumeOperation, submitOperation } from "../services/operations/executor.js";
import { SETTINGS_CHANGE_KIND, settingsChangeRecipe } from "../services/operations/recipes/settings-change.js";
import { applyLedgerDecisions, planLedgerChange } from "./ledger-decisions.js";

/** 照「先取依据、再读材料」的顺序调（第 8 轮复核 V4）：现取一份依据交进去。 */
const prepareNow = async (input: Omit<PrepareInput, "basis">) => prepareChapterCommit({ ...input, basis: await readTruthBasis(input.bookDir) });

let sandbox: string;
let book: string;
beforeEach(async () => {
  // 书放在一个临时书库里：备份恢复、回收站恢复都按书库路径来（Astra 第 2 轮 N1）。
  sandbox = await makeHomeTempDir("basis-contracts-");
  vi.stubEnv("SE_BOOKS_DIR", join(sandbox, "books"));
  vi.stubEnv("SE_DATA_DIR", join(sandbox, "data"));
  book = join(sandbox, "books/story-engine/demo");
  await mkdir(book, { recursive: true });
  await writeFile(join(book, "project.json"), JSON.stringify({ title: "依据契约测试书" }));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(sandbox, { recursive: true, force: true });
});

const author = (key: string) => ({ caller: "author" as const, idempotencyKey: key });
function ok<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  return result as Extract<T, { ok: true }>;
}
const model = async (messages: readonly { content: string }[]) => (messages.at(-1)?.content.includes("交这一章的账单") ? "{}" : "笔记。");
async function seed(text = "# 一\n\n张三回家了。"): Promise<void> {
  ok(await runCommand(book, chapterCommit, { chapter: 1, text, entries: [] }, author("seed")));
  ok(await runCommand(book, cardsImport, {}, author("cards")));
}

describe("依据安全契约", () => {
  it("R1 通读记账途中正文改了：读旧正文记的账不落盘，照新正文重记", async () => {
    ok(await runCommand(book, bookImportText, { chapters: [{ title: "一", body: "张三交出钥匙。他离开了。" }] }, author("import")));
    const original = await readFile(join(book, "chapters/0001.md"), "utf-8");
    const unit = splitUnits(original).find((item) => item.text.includes("张三"));
    if (!unit) throw new Error("没找到那句");
    const correction = await saveSettleProposal(book, {
      canon: "", canonExists: false, sceneOnly: true,
      edits: [{ key: "fix-name", chapter: 1, target: "committed", id: unit.id, from: unit.text, to: unit.text.replace("张三", "李四") }],
      facts: [], fields: [], committed: [{ chapter: 1, textSha256: sha256(original) }],
      drafts: [], searched: [1], missed: [], reviewDropped: [], failures: [], basis: await readTruthBasis(book),
    });
    await beginReread(book, 1);
    let changed = false;
    await runReread(book, {
      callModel: async (messages, options) => {
        if (!options?.json) return "笔记。";
        const sees = messages.at(-1)?.content.includes("李四") ? "李四" : "张三";
        if (!changed) {
          changed = true;
          // 记账员还在想：作者在别处确认了一条定论，正文里的张三改成了李四。
          ok(await applySettleProposal(book, correction.token, []));
        }
        return JSON.stringify({ summary: { text: `${sees}交出钥匙后离开`, quote: "他离开了" } });
      },
    });
    const text = await readFile(join(book, "chapters/0001.md"), "utf-8");
    const ledger = await readChapterLedger(book, 1);
    expect(text).toContain("李四");
    expect((await readRereadState(book))?.status).toBe("done");
    expect(ledger?.textSha256).toBe(sha256(text));
    expect(ledger?.entries.find((entry) => entry.kind === "summary")).toMatchObject({ text: "李四交出钥匙后离开" });
  });

  it("R2 改账整批一个事务：提议之后作者改了天数，整批一条都不记、如实说", async () => {
    await seed();
    const proposal = await planLedgerChange(book, { op: "summary", chapter: 1, text: "第一条" });
    if (!proposal.ok) throw new Error(proposal.reason);
    const day = await planLedgerChange(book, { op: "day", chapter: 1, day: 2 });
    if (!day.ok) throw new Error(day.reason);
    ok(await runCommand(book, decisionRecord, { decisions: [{ type: "chapter.day", chapter: 1, day: 20 }] }, author("author-new-day")));
    const result = await applyLedgerDecisions(book, { key: proposal.key, decisions: [...proposal.decisions, ...day.decisions], basis: proposal.basis });
    const view = await projectBook(book);
    expect(result).toMatchObject({ ok: false, applied: 0 });
    expect(result.summary).toContain("请让 AI 重新提一次");
    expect(view.chapters[0]?.day).toBe(20);
    expect(view.chapters[0]?.summary).not.toBe("第一条");
  });

  it("R3 确认定稿后撤销，再点同一张旧票：作废，不重新定稿", async () => {
    await seed();
    ok(await runCommand(book, draftSave, { chapter: 2, title: "二", body: "第二天，张三出门了。", baseVersion: null }, { caller: "author" }));
    const text = await readFile(join(book, draftPath(2)), "utf-8");
    const snapshot = await createSnapshot(book, "before-ch2");
    const ticketDir = join(book, "ledger/.preview");
    const tickets = fileTicketStore(ticketDir);
    const preview = ok(await prepareNow({ bookDir: book, chapter: 2, text, tickets, callModel: model }));
    ok(await confirmChapterCommit({ bookDir: book, ticket: preview.ticket, text, tickets }));
    await restoreSnapshot(book, snapshot.id);
    expect((await projectBook(book)).chapters).toHaveLength(1);
    const restoredText = await readFile(join(book, draftPath(2)), "utf-8");
    expect(restoredText).toBe(text);
    const again = await confirmChapterCommit({ bookDir: book, ticket: preview.ticket, text: restoredText, tickets: fileTicketStore(ticketDir) });
    expect(again.ok).toBe(false);
    expect((await projectBook(book)).chapters).toHaveLength(1);
  });

  it("R4 A→B→撤销回 A：记账员读的是 B，票记的是 A，确认时照样作废", async () => {
    const textA = "# 一\n\n他叫张三。";
    const textB = "# 一\n\n他叫李四。";
    await seed(textA);
    const basisA = await readTruthBasis(book);
    const saved = await createSnapshot(book, "state-A");
    const original = readers.ensureReaderWindow;
    let switched = false;
    // 只插一道调度屏障：预览记完依据、还没读前文时，书上真写一次。
    vi.spyOn(readers, "ensureReaderWindow").mockImplementation(async (input) => {
      if (!switched) {
        switched = true;
        ok(await runCommand(book, chapterCommit, { chapter: 1, text: textB, entries: [] }, author("state-B")));
      }
      return original(input);
    });
    const tickets = memoryTicketStore();
    const text = "# 二\n\n第二天，他交了钥匙。";
    let sawB = false;
    const preview = ok(await prepareNow({
      bookDir: book, chapter: 2, text, tickets, callModel: async (messages) => {
        if (!messages.at(-1)?.content.includes("交这一章的账单")) return "他是李四。";
        sawB = messages.some((message) => message.content.includes("他叫李四"));
        await restoreSnapshot(book, saved.id);
        return JSON.stringify({ summary: { text: "李四交了钥匙", quote: "他交了钥匙" } });
      },
    }));
    expect(sawB).toBe(true);
    const now = await readTruthBasis(book);
    expect(now.texts).toEqual(basisA.texts);
    const result = await confirmChapterCommit({ bookDir: book, ticket: preview.ticket, text, tickets });
    expect(result.ok).toBe(false);
    expect((await projectBook(book)).chapters).toHaveLength(1);
  });

  it("R5 再提一次和以前一样的改设定：是新按钮，确认真执行，不被旧回执当成「已经做过」", async () => {
    const write = async (value: string, key: string) => ok(await runCommand(book, cardWrite, { ops: [{ op: "story.set", label: "地点", value }] }, author(key)));
    await write("北京", "initial");
    const ops = [{ op: "story.set", label: "地点", value: "上海" }];
    __resetOperationStoreForTests();
    registerRecipe(settingsChangeRecipe);
    // 对话 AI 提一次改设定（碰了作者写的 → 等作者点「确认改设定」），作者点了。
    const proposeAndConfirm = async (): Promise<string> => {
      const outcome = ok(await submitOperation(book, {
        kind: SETTINGS_CHANGE_KIND, params: { ops }, requestKey: crypto.randomUUID(), issuedAt: new Date().toISOString(), origin: { kind: "chat", messageId: crypto.randomUUID() },
      }));
      if (!("record" in outcome)) throw new Error("没受理");
      await __drainOperationsForTests();
      ok(await resumeOperation(book, outcome.record.opId, { actionId: "confirm-settings", decision: "apply" }));
      await __drainOperationsForTests();
      return outcome.record.opId;
    };
    try {
      const first = await proposeAndConfirm();
      await write("广州", "author-later");
      const second = await proposeAndConfirm();
      expect(second).not.toBe(first);
      expect((await readCards(book))?.story.fields.find((field) => field.label === "地点")?.value).toBe("上海");
    } finally {
      __resetRecipesForTests();
    }
  });

  it("R6 作者一次没改动的请求也留回执：迟到重发不盖掉后来的改动", async () => {
    const write = (value: string, key: string) => writeCards(book, { ops: [{ op: "story.set", label: "地点", value }], idempotencyKey: key });
    ok(await write("北京", "seed-city"));
    expect(ok(await write("北京", "retry-same-request")).lines).toEqual([]);
    ok(await write("广州", "new-request"));
    await write("北京", "retry-same-request");
    expect((await readCards(book))?.story.fields.find((field) => field.label === "地点")?.value).toBe("广州");
  });

  it("R7 前一章章纲的要点改了：本章章纲的依据跟着变，不再沿用", async () => {
    await seed();
    const previous = normalizeChapterPlan({ summary: "前章计划", beats: ["前往南城"], storyDay: 1 }, { chapter: 1 });
    if (!previous) throw new Error("章纲没成");
    await writeChapterPlan(book, previous);
    const basis = await planBasisOf(book, 2);
    expect(basis).toBeDefined();
    const current = normalizeChapterPlan({ summary: "已去南城，本章去北城", beats: ["前往北城"] }, { chapter: 2 });
    if (!current) throw new Error("章纲没成");
    await writeChapterPlan(book, { ...current, ...(basis ? { basis } : {}) });
    expect(await planBasisOf(book, 2)).toBe(basis);
    await writeChapterPlan(book, { ...previous, beats: ["前往北城"] });
    expect(await planBasisOf(book, 2)).not.toBe(basis);
    const planner = vi.fn(async () => "不是 JSON");
    const result = await resolveChapterPlanForDraft({ projectDir: book, chapter: 2, plannerCallModel: planner, planCheckReaderCallModel: planner });
    expect(result.reused).toBe(false);
    expect(planner).toHaveBeenCalled();
  });
  it.each(["backup", "trash"] as const)("R8 整书恢复（%s）回到原路径：读过后来那一版的旧定稿票作废", async (mode) => {
    const textA = "# 一\n\n他叫张三。";
    await seed(textA);
    ok(await runCommand(book, draftSave, { chapter: 2, title: "二", body: "第二天，他交了钥匙。", baseVersion: null }, { caller: "author" }));
    const text = await readFile(join(book, draftPath(2)), "utf-8");
    const backup = mode === "backup" ? await createBookBackup(book) : undefined;
    let trashA = "";
    const original = readers.ensureReaderWindow;
    let switched = false;
    vi.spyOn(readers, "ensureReaderWindow").mockImplementation(async (input) => {
      if (!switched) {
        switched = true;
        if (mode === "trash") {
          trashA = await moveBookToTrash(book, "A");
          await mkdir(book, { recursive: true });
          await writeFile(join(book, "project.json"), JSON.stringify({ title: "同路径的新书" }));
        }
        ok(await runCommand(book, chapterCommit, { chapter: 1, text: "# 一\n\n他叫李四。", entries: [] }, author("state-B")));
      }
      return original(input);
    });
    const tickets = memoryTicketStore();
    const preview = ok(await prepareNow({
      bookDir: book, chapter: 2, text, tickets, callModel: async (messages, options) => {
        if (!options?.json) return "笔记。";
        expect(messages.at(-1)?.content).toContain("他叫李四");
        await moveBookToTrash(book, "B");
        const restored = mode === "backup" ? await restoreBookFromBackup(backup!.data) : await restoreFromTrash(trashA);
        expect(restored.projectPath).toBe(book);
        return JSON.stringify({ summary: { text: "李四交了钥匙", quote: "他交了钥匙" } });
      },
    }));
    const result = await confirmChapterCommit({ bookDir: book, ticket: preview.ticket, text, tickets });
    expect(result.ok).toBe(false);
    expect((await projectBook(book)).chapters[1]?.summary ?? "").not.toContain("李四");
  });

  it("R9 拟章纲途中书 A→B→撤销回 A：章纲员读的是 B，拟出的章纲不挂 A 的指纹、下次重拟", async () => {
    await seed("# 一\n\n他叫张三。");
    expect((await syncLegacyMirror(book)).ok).toBe(true);
    const saved = await createSnapshot(book, "state-A");
    const basisA = await planBasisOf(book, 2);
    const original = readers.ensureReaderWindow;
    let switched = false;
    vi.spyOn(readers, "ensureReaderWindow").mockImplementation(async (input) => {
      if (!switched) {
        switched = true;
        ok(await runCommand(book, chapterCommit, { chapter: 1, text: "# 一\n\n他叫李四。", entries: [] }, author("state-B")));
      }
      return original(input);
    });
    await resolveChapterPlanForDraft({
      projectDir: book, chapter: 2,
      plannerCallModel: async (messages, options) => {
        if (!options?.json) return "笔记。";
        expect(messages.some((message) => message.content.includes("他叫李四"))).toBe(true);
        await restoreSnapshot(book, saved.id);
        return JSON.stringify({ summary: "李四去交钥匙", beats: ["李四去交钥匙"], characters: ["李四"], newInformation: ["钥匙有了下落"], scene: { location: "北城" }, dayOffset: 1 });
      },
      planCheckReaderCallModel: async (_messages, options) => (options?.json ? JSON.stringify({ problems: [] }) : "笔记。"),
    });
    expect(await planBasisOf(book, 2)).toBe(basisA);
    expect((await readChapterPlan(book, 2))?.basis).not.toBe(basisA);
    const planner = vi.fn(async () => "不是 JSON");
    const second = await resolveChapterPlanForDraft({ projectDir: book, chapter: 2, plannerCallModel: planner, planCheckReaderCallModel: planner });
    expect(second.reused).toBe(false);
    expect(planner).toHaveBeenCalled();
  });
});
