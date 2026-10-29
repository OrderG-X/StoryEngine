// @vitest-environment node
// draft.change write / continue（写作版本 P2a 3.1、第七节）：受理前挡下没法写的（不调模型）；写成换上工作稿、新拟的章纲走核心存；
// 接着写本来写好的一个字不动、正文流先推那段；只出一版时正文流按执行、按号进稿纸；前文缺得多停下等后台补读；
// 多版不流、落选的几版带回；停掉不换上。真配方 + 真执行器 + 真核心写盘，只换模型（draft-change-kit）。
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chapterCommit, draftSave, readDraft, readDraftState, runCommand } from "@actalk/story-core";
import { readChapterPlan } from "../../../book/chapter-plan.js";
import { createStoryProject } from "../../../book/project-store.js";
import { __resetCatchUpLocksForTests } from "../../../editorial/reader-window.js";
import { REREAD_STATE_SCHEMA, writeRereadState } from "../../../editorial/reread-state.js";
import { makeHomeTempDir } from "../../../lib/home-test-tmp.js";
import { __resetExecutionsForTests } from "../../../lib/operations/context.js";
import { __resetLiveForTests, onLive, type LiveEvent } from "../../../lib/operations/live.js";
import { __resetOperationStoreForTests } from "../../../lib/operations/store.js";
import { setReaderBackfillHandler } from "../../../lib/reader-backfill.js";
import type { WriterClient } from "../../../writing/fast-draft-writer.js";
import { __drainOperationsForTests, __resetRecipesForTests, cancelOperation } from "../executor.js";
import { fakeDraftDeps, runDraftChange, settledDraftChange, submitDraftChange } from "./draft-change-kit.js";
import type { DraftChangeDeps } from "./draft-change.js";

let root: string;
let book: string;

beforeEach(async () => {
  __resetOperationStoreForTests();
  __resetExecutionsForTests();
  __resetLiveForTests();
  __resetRecipesForTests();
  __resetCatchUpLocksForTests();
  root = await makeHomeTempDir("draft-change-");
  vi.stubEnv("SE_DATA_DIR", join(root, "data"));
  ({ projectDir: book } = await createStoryProject({ rootDir: root, title: "写一章", genre: "都市", protagonistName: "林远" }));
});
afterEach(async () => {
  await __drainOperationsForTests();
  setReaderBackfillHandler(undefined);
  __resetRecipesForTests();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

const prose = (line: string): string =>
  Array(6).fill(`${line}林远沿着河岸走了很久，手里的账册越攥越紧。他还记得早上的约定，却不知道对方为什么迟迟没有露面。巷子尽头有人推开门，朝他招了招手。`).join("\n\n");

async function save(chapter: number, body: string): Promise<void> {
  const baseVersion = (await readDraftState(book, chapter)).version;
  expect(await runCommand(book, draftSave, { chapter, body, baseVersion, title: "" }, { caller: "author" })).toMatchObject({ ok: true });
}

async function commit(chapter: number, body: string): Promise<void> {
  const outcome = await runCommand(book, chapterCommit, { chapter, text: `# 第${chapter}章\n\n${body}`, entries: [] }, { caller: "author", idempotencyKey: `commit-${chapter}` });
  expect(outcome).toMatchObject({ ok: true });
}

/** 一调就报错的写手：受理前挡下的，模型一次都不该调。 */
const untouchable: WriterClient = {
  async generateDraft() {
    throw new Error("受理前挡下的不该调写手");
  },
};

describe("受理前挡下：不受理、不调模型", () => {
  it.each([
    ["没章号", "write", {}, "bad_params"],
    ["接着写没正文", "continue", { chapter: 1 }, "nothing_to_continue"],
    ["前一章没定稿", "write", { chapter: 2 }, "previous_chapter_not_committed"],
  ] as const)("%s → %s", async (_label, mode, params, code) => {
    const outcome = await submitDraftChange(book, mode, params, fakeDraftDeps({ writerClient: untouchable }));
    expect(outcome).toMatchObject({ ok: false, code });
  });

  it("有稿没点重写 → chapter_has_text，稿不动", async () => {
    await save(1, "作者写的第一章。");
    expect(await submitDraftChange(book, "write", { chapter: 1 }, fakeDraftDeps({ writerClient: untouchable }))).toMatchObject({ ok: false, code: "chapter_has_text" });
    expect(await readDraft(book, 1)).toMatchObject({ body: "作者写的第一章。" });
  });

  it("已定稿的章接着写 → chapter_committed", async () => {
    await commit(1, "定稿的第一章。");
    expect(await submitDraftChange(book, "continue", { chapter: 1 }, fakeDraftDeps({ writerClient: untouchable }))).toMatchObject({ ok: false, code: "chapter_committed" });
  });

  it("导入的书还在通读记账 → rereading", async () => {
    const now = new Date().toISOString();
    await writeRereadState(book, { schema: REREAD_STATE_SCHEMA, status: "running", run: "r1", total: 2, done: 0, recorded: 0, skipped: 0, startedAt: now, updatedAt: now, resumedAt: now, doneAtResume: 0 });
    expect(await submitDraftChange(book, "write", { chapter: 1 }, fakeDraftDeps({ writerClient: untouchable }))).toMatchObject({ ok: false, code: "rereading" });
  });

  it("要用的模型没配好 → model_missing，原话带回", async () => {
    const outcome = await submitDraftChange(book, "write", { chapter: 1 }, fakeDraftDeps({ writerClient: untouchable, modelProblem: () => "写手模型还没配好。" }));
    expect(outcome).toEqual({ ok: false, code: "model_missing", message: "写手模型还没配好。" });
  });
});

describe("写成", () => {
  it("写一章：拟纲走核心存、换上工作稿、结果体带正文和章纲", async () => {
    await save(1, "前一章的林远出了门。");
    const { record, body } = await runDraftChange(book, "write", { chapter: 2, direction: "林远去河岸等人", allowWriteAhead: true }, fakeDraftDeps({ writerClient: { async generateDraft() { return { title: "河岸", content: prose("林远到了河岸。") }; } } }));
    expect(record.state).toBe("succeeded");
    expect(body).toMatchObject({ kind: "draft.change", mode: "write", ok: true, chapter: 2, draftTitle: "第2章 · 河岸" });
    expect((await readDraft(book, 2))?.body).toBe(body?.draftBody);
    expect((await readChapterPlan(book, 2))?.direction).toBe("林远去河岸等人");
    // 存档点：章纲存盘前一个、换上稿前一个（整轮撤销从章纲那个退）。
    expect(body?.planSnapshotId).toEqual(expect.any(String));
    expect(body?.snapshotId).toEqual(expect.any(String));
    expect(body?.planSnapshotId).not.toBe(body?.snapshotId);
  });

  it("接着写：本来写好的一个字不动，新写的接在后面；正文流先推本来那段", async () => {
    const mine = "林远推开门，屋里没人。";
    await save(1, mine);
    const events: LiveEvent[] = [];
    const deps: DraftChangeDeps = {
      ...fakeDraftDeps(),
      writer: async ({ onDelta }) => ({
        async generateDraft() {
          onDelta?.("他在桌边坐下。");
          return { content: prose("他在桌边坐下。") };
        },
      }),
    };
    const outcome = await submitDraftChange(book, "continue", { chapter: 1, length: 300 }, deps);
    if (!outcome.ok || !("record" in outcome)) throw new Error("没受理");
    const stop = onLive(book, outcome.record.opId, (event) => events.push(event));
    const record = await settledDraftChange(book, outcome.record.opId);
    stop();
    expect(record.state).toBe("succeeded");
    const draft = (await readDraft(book, 1))!.body;
    expect(draft.startsWith(mine)).toBe(true);
    expect(draft).toContain("他在桌边坐下。");
    const deltas = events.filter((event) => event.type === "draft-delta");
    expect(deltas[0]).toMatchObject({ base: true, text: `${mine}\n\n` });
  });

  it("只出一版：正文流按这一步的执行号、按序号逐段推出来", async () => {
    const events: LiveEvent[] = [];
    const deps: DraftChangeDeps = {
      ...fakeDraftDeps(),
      writer: async ({ onDelta }) => ({
        async generateDraft() {
          onDelta?.("第一段。");
          onDelta?.("第二段。");
          return { content: prose("第一段。第二段。") };
        },
      }),
    };
    const outcome = await submitDraftChange(book, "write", { chapter: 1 }, deps);
    if (!outcome.ok || !("record" in outcome)) throw new Error("没受理");
    const stop = onLive(book, outcome.record.opId, (event) => events.push(event));
    expect((await settledDraftChange(book, outcome.record.opId)).state).toBe("succeeded");
    stop();
    const writeStep = events.find((event) => event.type === "step" && event.step === "write:1");
    expect(writeStep).toBeDefined();
    const deltas = events.filter((event): event is Extract<LiveEvent, { type: "draft-delta" }> => event.type === "draft-delta");
    expect(deltas.map((event) => event.text)).toEqual(["", "第一段。", "第二段。"]);
    expect(deltas[0]).toMatchObject({ replace: true });
    expect(new Set(deltas.map((event) => event.exec))).toEqual(new Set([(writeStep as { exec: string }).exec]));
    expect(deltas.map((event) => event.streamSeq)).toEqual([1, 2, 3]);
  });

  it("一次写两版：不流正文，按选优换上一版、落选的那版全文带回", async () => {
    const events: LiveEvent[] = [];
    let n = 0;
    const deps: DraftChangeDeps = {
      ...fakeDraftDeps(),
      writer: async ({ onDelta, temperature }) => {
        expect(onDelta).toBeUndefined();
        expect(temperature).toEqual(expect.any(Number));
        n += 1;
        const which = n;
        return { async generateDraft() { return { content: prose(`第${which}版的开头。`) }; } };
      },
    };
    const outcome = await submitDraftChange(book, "write", { chapter: 1, candidates: 2 }, deps);
    if (!outcome.ok || !("record" in outcome)) throw new Error("没受理");
    const stop = onLive(book, outcome.record.opId, (event) => events.push(event));
    const record = await settledDraftChange(book, outcome.record.opId);
    stop();
    expect(record.state).toBe("succeeded");
    expect(n).toBe(2);
    expect(events.some((event) => event.type === "draft-delta")).toBe(false);
    const body = (record.result as { body?: { otherVersions?: readonly { content?: string; body?: string }[] } }).body;
    expect(body?.otherVersions).toHaveLength(1);
  });
});

describe("停下来", () => {
  it("前文缺得比当场能补的多：交后台补读（章纲员、核账员都点名），停在 paused:material，不写", async () => {
    for (let chapter = 1; chapter <= 12; chapter += 1) await commit(chapter, `林远第${chapter}天照常开门。`);
    const requests: unknown[] = [];
    setReaderBackfillHandler(async (_bookDir, request) => { requests.push(request); });
    const { record } = await runDraftChange(book, "write", { chapter: 13 }, fakeDraftDeps({ writerClient: untouchable }));
    expect(record).toMatchObject({ state: "paused", pauseReason: "material", currentStep: "notes" });
    expect(requests).toEqual([{ roles: expect.arrayContaining(["planner", expect.any(String)]), upTo: 12 }]);
    expect(await readDraft(book, 13)).toBeUndefined();
  });

  it("写的时候停掉：记成 cancelled，工作稿不动", async () => {
    await save(1, "作者原来的稿。");
    let entered!: () => void;
    const writing = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const writerClient: WriterClient = {
      async generateDraft() {
        entered();
        await hold;
        return { content: prose("不该换上的一版。") };
      },
    };
    const outcome = await submitDraftChange(book, "write", { chapter: 1, rewrite: true }, fakeDraftDeps({ writerClient }));
    if (!outcome.ok || !("record" in outcome)) throw new Error("没受理");
    await writing;
    expect(await cancelOperation(book, outcome.record.opId)).toMatchObject({ cancelled: true });
    release();
    expect((await settledDraftChange(book, outcome.record.opId)).state).toBe("cancelled");
    expect((await readDraft(book, 1))?.body).toBe("作者原来的稿。");
  });
});
