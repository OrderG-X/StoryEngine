// @vitest-environment node
// AI 写稿用过、不在真相依据里的材料（已有各章章名、本章章纲）：写的途中变了，照旧材料写的不换上、留候选（第 5 轮复核 S8/S9）；
// 没变照常换上。真出稿服务 + 真章纲编排 + 真核心写盘，只替换写手模型和出稿后的质量复核。
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { draftSave, readDraft, readDraftState, runCommand } from "@actalk/story-core";
import { createStoryProject } from "../book/project-store.js";
import { normalizeChapterPlan, writeChapterPlan } from "../book/chapter-plan.js";
import { pendingDraftFor } from "../lib/draft-candidates.js";
import { planBasisOf, resolveChapterPlanForDraft } from "../editorial/plan-chapter.js";
import type { BrainCallModel } from "../editorial/index.js";
import { runGenerateDraft } from "./draft-service.js";

vi.mock("./draft-pipeline/run-quality-pipeline.js", () => ({
  runDraftQualityPipeline: vi.fn(async (input: { draftBody: string }) => ({ draftBody: input.draftBody, changed: false, info: {}, notes: [] })),
}));

let root: string | undefined;
afterEach(async () => {
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
  expect(await runCommand(book, draftSave, { chapter, body, baseVersion, ...(title ? { title } : {}) }, { caller: "author" })).toMatchObject({ ok: true });
}

const prose = (line: string): string => Array(6).fill(`${line}林远沿着河岸走了很久，手里的账册越攥越紧。他还记得早上的约定，却不知道对方为什么迟迟没有露面。巷子尽头有人推开门，朝他招了招手，示意他先进去等一会儿。`).join("\n\n");

const planJson = (summary: string): string => JSON.stringify({ summary, beats: [summary], characters: ["林远"], newInformation: [summary], scene: { location: "河岸", time: "上午" }, dayOffset: 0 });
const planner = (summary: string): BrainCallModel => async (_messages, options) => (options?.json ? planJson(summary) : "笔记。");
const noProblems: BrainCallModel = async (_messages, options) => (options?.json ? JSON.stringify({ problems: [] }) : "笔记。");

it("写手看过的别章章名写的途中改了：不换上、留候选（第 5 轮 S8）", async () => {
  const book = await makeBook();
  await save(book, 1, "前章的林远已经出发。", "第一章");
  await save(book, 4, "其他章工作稿。", "雨夜");
  const result = await runGenerateDraft({
    projectDir: book,
    chapter: 2,
    policies: { lengthPolicy: "annotate", aiFlavorRecheck: false },
    writerClient: {
      async generateDraft({ context }) {
        expect(JSON.stringify(context.sections.find((section) => section.name === "chapter_titles")?.content)).toContain("雨夜");
        await save(book, 4, "其他章工作稿。", "钟声");
        return { title: "钟声", content: prose("林远听见远处响起了钟声。") };
      },
    },
  });
  expect(result.ok).toBe(false);
  expect(await readDraft(book, 2)).toBeUndefined();
  expect(await pendingDraftFor(book, 2)).toMatchObject({ kind: "candidate", reason: "basis_moved" });
});

it("别章只改了正文、章名没变：照常换上", async () => {
  const book = await makeBook();
  await save(book, 1, "前章的林远已经出发。", "第一章");
  await save(book, 4, "其他章工作稿。", "雨夜");
  const result = await runGenerateDraft({
    projectDir: book,
    chapter: 2,
    policies: { lengthPolicy: "annotate", aiFlavorRecheck: false },
    writerClient: {
      async generateDraft() {
        await save(book, 4, "其他章工作稿，作者又写了一句。", "雨夜");
        return { title: "河岸", content: prose("林远走到河岸。") };
      },
    },
  });
  expect(result.ok).toBe(true);
  expect((await readDraft(book, 2))?.title).toBe("河岸");
});

it("照本章章纲写的途中章纲被重拟：不换上、留候选（第 5 轮 S9）", async () => {
  const book = await makeBook();
  await save(book, 1, "林远推门走了出去。");
  const oldPlan = normalizeChapterPlan(JSON.parse(planJson("把钥匙交给老周")), { chapter: 2, basis: await planBasisOf(book, 2) })!;
  await writeChapterPlan(book, oldPlan);
  const result = await runGenerateDraft({
    projectDir: book,
    chapter: 2,
    plannerCallModel: async () => { throw new Error("已有章纲应直接沿用"); },
    policies: { lengthPolicy: "annotate", aiFlavorRecheck: false },
    writerClient: {
      async generateDraft({ context }) {
        expect(JSON.stringify(context.sections.find((section) => section.name === "chapter_plan")?.content)).toContain("把钥匙交给老周");
        const replanned = await resolveChapterPlanForDraft({ projectDir: book, chapter: 2, direction: "把钥匙熔毁", plannerCallModel: planner("把钥匙熔毁"), planCheckReaderCallModel: noProblems });
        expect(replanned.plan?.summary).toBe("把钥匙熔毁");
        return { title: "交接", content: prose("林远把唯一的钥匙交给了老周。") };
      },
    },
  });
  expect(result.ok).toBe(false);
  expect(await readDraft(book, 2)).toBeUndefined();
  expect(await pendingDraftFor(book, 2)).toMatchObject({ kind: "candidate", reason: "basis_moved" });
});

it("沿用的章纲、新拟的章纲没被动过：照常换上", async () => {
  const book = await makeBook();
  await save(book, 1, "林远推门走了出去。");
  const fresh = await runGenerateDraft({
    projectDir: book,
    chapter: 2,
    plannerCallModel: planner("把钥匙交给老周"),
    planCheckReaderCallModel: noProblems,
    policies: { lengthPolicy: "annotate", aiFlavorRecheck: false },
    writerClient: { async generateDraft() { return { title: "交接", content: prose("林远把钥匙交给了老周。") }; } },
  });
  expect(fresh.ok).toBe(true);
  // 再写一遍同一章：章纲沿用（前文没变、方向没变），照常换上。
  const again = await runGenerateDraft({
    projectDir: book,
    chapter: 2,
    plannerCallModel: planner("不该重拟"),
    planCheckReaderCallModel: noProblems,
    policies: { lengthPolicy: "annotate", aiFlavorRecheck: false },
    writerClient: { async generateDraft() { return { title: "交接", content: prose("林远又一次把钥匙交给了老周。") }; } },
  });
  expect(again).toMatchObject({ ok: true, chapterPlan: { reused: true, summary: "把钥匙交给老周" } });
  expect((await readDraft(book, 2))?.body).toContain("又一次");
});
