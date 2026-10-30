// @vitest-environment node
// AI 写稿用到、不在真相依据里的材料（别的章的工作稿、各章章纲、书里别的文件）：开写时整本拍一份，写的途中变了，照旧材料写的不换上、留候选
// （第 5 轮复核 S8/S9、第 6 轮 T5/T6/T9、第 7 轮 U3/U5）；没变照常换上（第 6 轮 T7）。账从真相现算，定稿完就开写读到的是新账（第 7 轮 U3；U3a 在 agent/ledger-then-draft.test.ts），
// 核账旧记忆前文改了不交给写手（第 7 轮 U4）。真写稿操作（draft.change 配方 + 执行器）+ 真章纲编排 + 真核心写盘，只替换模型（draft-change-kit）。
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cardWrite, chapterCommit, draftSave, readDraft, readDraftState, readTruthBasis, runCommand } from "@actalk/story-core";
import { createStoryProject } from "../book/project-store.js";
import { seedChapters } from "../book/ledger-test-helpers.js";
import { normalizeChapterPlan, readChapterPlan, writeChapterPlan } from "../book/chapter-plan.js";
import { pendingDraftFor } from "../lib/draft-candidates.js";
import { planBasisOf, resolveChapterPlanForDraft } from "../editorial/plan-chapter.js";
import type { BrainCallModel } from "../editorial/index.js";
import { __resetOperationStoreForTests } from "../lib/operations/store.js";
import type { WriterClient } from "../writing/fast-draft-writer.js";
import { __drainOperationsForTests, __resetRecipesForTests } from "./operations/executor.js";
import { fakeDraftDeps, fakePlanner, planJson, quietReader, runDraftChange, settledDraftChange, submitDraftChange } from "./operations/recipes/draft-change-kit.js";
import type { DraftChangeDeps } from "./operations/recipes/draft-change.js";
import { canReuseCheck, checkChapterBody } from "../editorial/continuity/check-service.js";
import { readCheckMemory } from "../editorial/continuity/check-memory.js";

const hooks = vi.hoisted(() => ({
  afterPresence: undefined as undefined | (() => Promise<void>),
  afterMaterial: undefined as undefined | (() => Promise<void>),
}));
vi.mock("../writing/presence/in-scene-detector.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../writing/presence/in-scene-detector.js")>();
  return {
    ...actual,
    resolveInSceneCharacters: async (...args: Parameters<typeof actual.resolveInSceneCharacters>) => {
      const result = await actual.resolveInSceneCharacters(...args);
      await hooks.afterPresence?.();
      return result;
    },
  };
});
vi.mock("../book/material-reads.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../book/material-reads.js")>();
  return {
    ...actual,
    firstMovedMaterial: async (...args: Parameters<typeof actual.firstMovedMaterial>) => {
      const result = await actual.firstMovedMaterial(...args);
      await hooks.afterMaterial?.();
      return result;
    },
  };
});

let root: string | undefined;
beforeEach(() => {
  __resetOperationStoreForTests();
  __resetRecipesForTests();
});
afterEach(async () => {
  await __drainOperationsForTests();
  hooks.afterPresence = undefined;
  hooks.afterMaterial = undefined;
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function makeBook(): Promise<string> {
  root = await mkdtemp(join(process.env.STORY_ENGINE_TEST_RUN_ROOT!, "draft-materials-"));
  vi.stubEnv("SE_BOOKS_DIR", join(root, "books"));
  vi.stubEnv("SE_DATA_DIR", join(root, "data"));
  return (await createStoryProject({ rootDir: join(root, "books"), title: "写稿材料", genre: "都市", protagonistName: "林远" })).projectDir;
}

async function save(book: string, chapter: number, body: string, title?: string): Promise<void> {
  const baseVersion = (await readDraftState(book, chapter)).version;
  expect(await runCommand(book, draftSave, { chapter, body, baseVersion, title: title ?? (await readDraft(book, chapter))?.title ?? "" }, { caller: "author" })).toMatchObject({ ok: true });
}

const prose = (line: string): string => Array(6).fill(`${line}林远沿着河岸走了很久，手里的账册越攥越紧。他还记得早上的约定，却不知道对方为什么迟迟没有露面。巷子尽头有人推开门，朝他招了招手，示意他先进去等一会儿。`).join("\n\n");

const planner = fakePlanner;
const noProblems: BrainCallModel = quietReader;
const reuseOnly: BrainCallModel = async () => { throw new Error("已有章纲应直接沿用"); };

/** 写第 chapter 章（前一章没定稿也写；有稿的整章重写），等它跑完。 */
function write(book: string, chapter: number, writerClient: WriterClient, deps: Partial<DraftChangeDeps> = {}, params: Record<string, unknown> = {}) {
  return runDraftChange(book, "write", { chapter, allowWriteAhead: true, ...params }, fakeDraftDeps({ writerClient, ...deps }));
}

it("写手看过的别章章名写的途中改了：不换上、留候选，说清是哪章（第 5 轮 S8）", async () => {
  const book = await makeBook();
  await save(book, 1, "前章的林远已经出发。", "第一章");
  await save(book, 4, "其他章工作稿。", "雨夜");
  const result = await write(book, 2, {
    async generateDraft({ context }) {
      expect(JSON.stringify(context.sections.find((section) => section.name === "chapter_titles")?.content)).toContain("雨夜");
      await save(book, 4, "其他章工作稿。", "钟声");
      return { title: "钟声", content: prose("林远听见远处响起了钟声。") };
    },
  });
  expect(result).toMatchObject({ body: { ok: false, kept: { reason: "basis_moved" } }, summary: expect.stringContaining("第 4 章的稿子") });
  expect(await readDraft(book, 2)).toBeUndefined();
  expect(await pendingDraftFor(book, 2)).toMatchObject({ kind: "candidate", reason: "basis_moved" });
});

it("别的章只改了正文：也不换上（拍的是整本，不猜写手用没用到那一章）", async () => {
  const book = await makeBook();
  await save(book, 1, "前章的林远已经出发。", "第一章");
  await save(book, 4, "其他章工作稿。", "雨夜");
  const result = await write(book, 2, {
    async generateDraft() {
      await save(book, 4, "其他章工作稿，作者又写了一句。", "雨夜");
      return { title: "河岸", content: prose("林远走到河岸。") };
    },
  });
  expect(result.body?.ok).toBe(false);
  expect(await pendingDraftFor(book, 2)).toMatchObject({ kind: "candidate", reason: "basis_moved" });
});

it("照本章章纲写的途中章纲被重拟：不换上、留候选（第 5 轮 S9）", async () => {
  const book = await makeBook();
  await save(book, 1, "林远推门走了出去。");
  const oldPlan = normalizeChapterPlan(JSON.parse(planJson("把钥匙交给老周")), { chapter: 2, basis: await planBasisOf(book, 2) })!;
  await writeChapterPlan(book, oldPlan);
  const result = await write(book, 2, {
    async generateDraft({ context }) {
      expect(JSON.stringify(context.sections.find((section) => section.name === "chapter_plan")?.content)).toContain("把钥匙交给老周");
      // 另一轮拟纲（拟纲只在内存里拟，存纲那一下换上）。
      const replanned = await resolveChapterPlanForDraft({ projectDir: book, chapter: 2, direction: "把钥匙熔毁", plannerCallModel: planner("把钥匙熔毁"), planCheckReaderCallModel: noProblems });
      expect(replanned.plan?.summary).toBe("把钥匙熔毁");
      await writeChapterPlan(book, replanned.plan!);
      return { title: "交接", content: prose("林远把唯一的钥匙交给了老周。") };
    },
  }, { plannerCallModel: reuseOnly });
  expect(result).toMatchObject({ body: { ok: false }, summary: expect.stringContaining("本章章纲") });
  expect(await readDraft(book, 2)).toBeUndefined();
  expect(await pendingDraftFor(book, 2)).toMatchObject({ kind: "candidate", reason: "basis_moved" });
});

it("写手读过的前章章纲写的途中重拟了：不换上（第 6 轮 T5）", async () => {
  const book = await makeBook();
  // 前章定了稿、记了天数：写手段的故事日历按时间线读前章，连带读它的章纲（摘要、开场时间）。
  await seedChapters(book, [{ chapter: 1, entries: [{ kind: "summary", text: "林远走到河岸。", quote: "林远走到了河岸。" }, { kind: "time", basis: "author", day: 1 }] }]);
  await writeChapterPlan(book, normalizeChapterPlan(JSON.parse(planJson("钥匙交给老周")), { chapter: 1, source: "author" })!);
  await writeChapterPlan(book, normalizeChapterPlan({ ...JSON.parse(planJson("林远接着走")), storyDay: 2 }, { chapter: 2, source: "author" })!);
  const result = await write(book, 2, {
    async generateDraft({ context }) {
      expect(JSON.stringify(context.sections.find((section) => section.name === "chapter_plan")?.content)).toContain("钥匙交给老周");
      const replanned = await resolveChapterPlanForDraft({ projectDir: book, chapter: 1, direction: "钥匙当场熔毁", plannerCallModel: planner("钥匙当场熔毁"), planCheckReaderCallModel: noProblems });
      expect(replanned.plan?.summary).toBe("钥匙当场熔毁");
      await writeChapterPlan(book, replanned.plan!);
      return { title: "交接之后", content: prose("昨天把钥匙交给老周后，林远一直等着他的回信。") };
    },
  }, { plannerCallModel: reuseOnly });
  expect(result).toMatchObject({ body: { ok: false }, summary: expect.stringContaining("第 1 章的章纲") });
  expect(await pendingDraftFor(book, 2)).toMatchObject({ reason: "basis_moved" });
});

it("在场检测读过前章之后作者改了前章：不换上（第 6 轮 T6）", async () => {
  const book = await makeBook();
  expect(await runCommand(book, cardWrite, { ops: [
    { op: "card.create", kind: "character", name: "老周" },
    { op: "card.create", kind: "character", name: "老李" },
  ] }, { caller: "author", idempotencyKey: "round6-cast" })).toMatchObject({ ok: true });
  await save(book, 1, "林远与老周在门外等着。");
  hooks.afterPresence = async () => {
    hooks.afterPresence = undefined;
    await save(book, 1, "林远与老李在门外等着。");
  };
  const result = await write(book, 2, {
    async generateDraft({ context }) {
      expect(context.trace.selectedCharacters).toContain("老周");
      return { title: "门外", content: prose("老周陪着林远继续等。") };
    },
  });
  expect(result).toMatchObject({ body: { ok: false }, summary: expect.stringContaining("第 1 章的稿子") });
  expect(await pendingDraftFor(book, 2)).toMatchObject({ reason: "basis_moved" });
});

it.each([240, 150])("审纲后改出 %i 字的要点：写手拿到的就是盘上那份，没人动材料照常换上（第 6 轮 T7）", async (length) => {
  const book = await makeBook();
  const previousText = "林远把蓝色账册锁进抽屉，决定明天去档案室。";
  expect(await runCommand(book, chapterCommit, { chapter: 1, text: `# 第一章\n\n${previousText}`, entries: [] }, { caller: "author", idempotencyKey: "round6-commit" })).toMatchObject({ ok: true });
  const fixedBeat = "第二天林远去档案室，逐页核对账册上的记录，确定缺页是一笔境外汇款。".repeat(10).slice(0, length);
  const replies = [
    JSON.stringify({ summary: "去档案室对账", beats: ["当天去档案室", "管理员拦人", "查出缺页"], newInformation: ["缺页是境外汇款"], scene: { location: "档案室", time: "上午" }, characters: ["林远"], entities: ["账册"], dayOffset: 0 }),
    JSON.stringify({ revised: [{ point: 1, beat: fixedBeat }] }),
  ];
  let jsonCalls = 0;
  let consumed: readonly string[] = [];
  // 审纲、核账是同一个核账员：审纲那遍报第 1 点和前章冲突，核账那遍没问题。
  const result = await write(book, 2, {
    async generateDraft({ context }) {
      consumed = (context.sections.find((section) => section.name === "chapter_plan")?.content as { beats: string[] }).beats;
      return { title: "档案室", content: prose("第二天林远去档案室，核对账册。") };
    },
  }, {
    plannerCallModel: async (_messages, options) => (options?.json ? replies[Math.min(jsonCalls++, replies.length - 1)]! : "读到林远计划明天去档案室。"),
    readerCallModel: async (_messages, options) => (options?.json
      ? JSON.stringify({ problems: [{ point: 1, conflict: true, authorWilled: false, earlierQuote: previousText, earlierChapter: 1, reason: "前章安排明天，章纲却安排当天。" }], checks: [], contradictions: [] })
      : "笔记。"),
  });
  expect(jsonCalls).toBe(2);
  expect(consumed[0]).toHaveLength(length);
  expect((await readChapterPlan(book, 2))?.beats).toEqual(consumed);
  expect(result.body?.ok).toBe(true);
});

it("书锁里核完章纲、还没换上时另一轮存纲：等换上之后才写章纲（第 6 轮 T9）", async () => {
  const book = await makeBook();
  await writeChapterPlan(book, normalizeChapterPlan(JSON.parse(planJson("把钥匙交给老周")), { chapter: 1, source: "author" })!);
  let reached!: () => void;
  const checked = new Promise<void>((resolve) => { reached = resolve; });
  let release!: () => void;
  const allowed = new Promise<void>((resolve) => { release = resolve; });
  hooks.afterMaterial = async () => { hooks.afterMaterial = undefined; reached(); await allowed; };
  const submitted = await submitDraftChange(book, "write", { chapter: 1 }, fakeDraftDeps({
    plannerCallModel: reuseOnly,
    writerClient: { async generateDraft() { return { title: "交钥匙", content: prose("林远把钥匙交给了老周。") }; } },
  }));
  if (!submitted.ok || !("record" in submitted)) throw new Error("没受理");
  const running = settledDraftChange(book, submitted.record.opId);
  await checked;
  let replaced = false;
  const replanning = resolveChapterPlanForDraft({ projectDir: book, chapter: 1, direction: "把钥匙熔毁", plannerCallModel: planner("把钥匙熔毁"), planCheckReaderCallModel: noProblems })
    .then((replanned) => writeChapterPlan(book, replanned.plan!))
    .then(() => { replaced = true; });
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(replaced).toBe(false);
  release();
  expect((await running).result).toMatchObject({ body: { ok: true } });
  await replanning;
  expect((await readChapterPlan(book, 1))?.summary).toBe("把钥匙熔毁");
});

it("沿用的章纲、新拟的章纲没被动过：照常换上", async () => {
  const book = await makeBook();
  await save(book, 1, "林远推门走了出去。");
  const fresh = await write(book, 2, { async generateDraft() { return { title: "交接", content: prose("林远把钥匙交给了老周。") }; } }, { plannerCallModel: planner("把钥匙交给老周") });
  expect(fresh.body?.ok).toBe(true);
  // 再写一遍同一章（作者点「重写」）：章纲沿用（前文没变、方向没变），照常换上。
  const again = await write(book, 2, { async generateDraft() { return { title: "交接", content: prose("林远又一次把钥匙交给了老周。") }; } }, { plannerCallModel: planner("不该重拟") }, { rewrite: true });
  expect(again.body).toMatchObject({ ok: true, chapterPlan: { reused: true, summary: "把钥匙交给老周" } });
  expect((await readDraft(book, 2))?.body).toContain("又一次");
});

/** 定稿第 1 章：带一条保险柜口令的事实。 */
async function commitKey(book: string, text: string, key: string, withFact = true): Promise<void> {
  const entries = withFact ? [{ kind: "fact" as const, review: "author" as const, nature: "hard" as const, subject: "保险柜", attribute: "口令", value: key, text, quote: text }] : [];
  const result = await runCommand(book, chapterCommit, { chapter: 1, text: `# 第一章\n\n${text}`, entries }, { caller: "author", idempotencyKey: key });
  expect(result).toMatchObject({ ok: true, result: { rejected: [] } });
}

const packOf = (context: { readonly sections: readonly { readonly name: string; readonly content?: unknown }[] }): string =>
  JSON.stringify(context.sections.find((section) => section.name === "writing_context_pack")?.content);

it("重定稿完马上开写：写手读到的是新账（第 7 轮 U3）", async () => {
  const book = await makeBook();
  await commitKey(book, "保险柜的口令是红松。", "红松");
  await commitKey(book, "保险柜的口令是白鹤。", "白鹤");
  let consumed = "";
  const result = await write(book, 2, {
    async generateDraft({ context }) {
      consumed = packOf(context);
      return { title: "开柜", content: prose("林远输入白鹤，打开了保险柜。") };
    },
  }, {}, { direction: "林远打开保险柜" });
  expect(consumed).toContain("白鹤");
  expect(consumed).not.toContain("红松");
  expect(result.body?.ok).toBe(true);
});

it("核账记忆是照改之前的前文核的：不当成「上一稿核出的错」交给写手（第 7 轮 U4）", async () => {
  const book = await makeBook();
  const oldFact = "钥匙在老周手里。";
  const nowCorrect = "钥匙在老李手里。";
  await commitKey(book, oldFact, "old-key", false);
  const checkedBody = `林远走到门口。${nowCorrect}他们约好明天再见。`;
  const checked = await checkChapterBody(book, 2, checkedBody, {
    readerCallModel: async (messages, options) => {
      if (!options?.json) return "笔记：钥匙在老周手里。";
      const last = messages.at(-1)!.content;
      if (last.includes("你刚才核完报了")) {
        const ids = [...last.matchAll(/【(K\d+)】/gu)].map((match) => match[1]);
        return JSON.stringify({ verdicts: ids.map((id) => ({ id, verdict: "sure" })) });
      }
      return JSON.stringify({ checks: [], contradictions: [{ quote: nowCorrect, earlierQuote: oldFact, earlierChapter: 1, reason: "钥匙保管人不一致", confidence: "sure" }] });
    },
  });
  expect(checked.sure).toHaveLength(1);
  expect(await readCheckMemory(book, 2)).toBeDefined();
  // 作者把前文改成老李：旧记忆按旧前文核的，作废。
  await commitKey(book, nowCorrect, "new-key", false);
  expect(await canReuseCheck(book, 2, checkedBody)).toBe(false);
  let conflicts: unknown = "没调写手";
  await write(book, 2, {
    async generateDraft({ context }) {
      conflicts = context.sections.find((section) => section.name === "last_draft_conflicts")?.content;
      return { title: "门外", content: prose(nowCorrect) };
    },
  }, {}, { direction: "林远接着向前走" });
  expect(conflicts).toBeUndefined();
});

it("前文没改的核账记忆照常交给写手（对照）", async () => {
  const book = await makeBook();
  const fact = "钥匙在老周手里。";
  await commitKey(book, fact, "key", false);
  const wrong = "钥匙在老李手里。";
  await checkChapterBody(book, 2, `林远走到门口。${wrong}`, {
    readerCallModel: async (messages, options) => {
      if (!options?.json) return "笔记：钥匙在老周手里。";
      const last = messages.at(-1)!.content;
      if (last.includes("你刚才核完报了")) {
        const ids = [...last.matchAll(/【(K\d+)】/gu)].map((match) => match[1]);
        return JSON.stringify({ verdicts: ids.map((id) => ({ id, verdict: "sure" })) });
      }
      return JSON.stringify({ checks: [], contradictions: [{ quote: wrong, earlierQuote: fact, earlierChapter: 1, reason: "钥匙保管人不一致", confidence: "sure" }] });
    },
  });
  let conflicts: unknown;
  await write(book, 2, {
    async generateDraft({ context }) {
      conflicts = context.sections.find((section) => section.name === "last_draft_conflicts")?.content;
      return { title: "门外", content: prose("林远把钥匙要了回来。") };
    },
  });
  expect(JSON.stringify(conflicts)).toContain(wrong);
});

it("没有章纲接着写，途中本章新建了章纲：不换上（第 7 轮 U5）", async () => {
  const book = await makeBook();
  await save(book, 1, "作者已经写好的开场。");
  const result = await runDraftChange(book, "continue", { chapter: 1, length: 600 }, fakeDraftDeps({
    writerClient: {
      async generateDraft({ context }) {
        expect(context.sections.some((section) => section.name === "chapter_plan")).toBe(false);
        await writeChapterPlan(book, normalizeChapterPlan({ summary: "林远立刻离开河岸", beats: ["林远坐车离开河岸"] }, { chapter: 1, source: "author" })!);
        return { title: "河岸", content: prose("林远继续在河岸等人。") };
      },
    },
  }));
  expect(result.body?.ok).toBe(false);
  expect(await pendingDraftFor(book, 1)).toMatchObject({ reason: "basis_moved" });
});

it("写的途中书里别的资料变了（不在真相里、也不是稿子和章纲）：不换上，说清是哪样", async () => {
  const book = await makeBook();
  await save(book, 1, "林远推门走了出去。");
  const before = await readTruthBasis(book);
  const result = await write(book, 2, {
    async generateDraft() {
      await writeFile(join(book, "project.json"), `${JSON.stringify({ title: "改过名的书" }, null, 2)}\n`, "utf-8");
      return { title: "交接", content: prose("林远把钥匙交给了老周。") };
    },
  }, { plannerCallModel: planner("把钥匙交给老周") });
  expect((await readTruthBasis(book)).digest).toBe(before.digest);
  expect(result.body?.ok).toBe(false);
  expect(result.summary).toContain("书的资料");
  expect(await pendingDraftFor(book, 2)).toMatchObject({ reason: "basis_moved" });
});
