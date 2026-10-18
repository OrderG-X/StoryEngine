// @vitest-environment node
//
// 编辑部 R4.6（验收 3.7）核心场景：新书（占位主角卡「主角」）+ 第 1 章写着「陆沉」并已定稿
// → 第 2 章出稿不被引擎选角关卡挡（"Draft content must mention at least one selected character: 主角"）。
// 走真引擎 runFastDraft（关卡在 fast-draft-writer.validateDraft），只 mock 写作模型（不调真实 LLM）。
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStoryProject } from "../book/project-store.js";
import { type WriterClient } from "../writing/fast-draft-writer.js";
import { type WriterContextEnvelope } from "../writing/context-gateway.js";

import { generateDraftCandidate, runGenerateDraft } from "./draft-service.js";

describe("R4.6：占位主角卡不挡出稿（新书：占位卡 + 第 1 章定稿 → 第 2 章出稿）", () => {
  let projectDir: string | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    const rootDir = await mkdtemp(join(tmpdir(), "draft-placeholder-"));
    // books.ts 建书模板：作者没填主角名 → 占位卡固定名「主角」。
    const created = await createStoryProject({
      rootDir,
      title: "灯塔修表人（R4.6 测试）",
      genre: "长篇故事",
      premise: "守塔人修一块停了的手表。",
      mainCharacterName: "主角",
    });
    projectDir = created.projectDir;
  });

  afterEach(async () => {
    if (projectDir) {
      await rm(projectDir, { recursive: true, force: true });
      projectDir = undefined;
    }
  });

  /** 模拟「第 1 章作者手写、含陆沉、已定稿」：chapters/0001.md + 时间线语义摘要（记账员声明的出场名随定稿落这里）。 */
  async function finalizeChapterOneWithLuchen(): Promise<void> {
    await writeFile(join(projectDir!, "chapters", "0001.md"), "# 第一章\n\n陆沉把灯点上，拆开那块停走的怀表。", "utf-8");
    await mkdir(join(projectDir!, "timeline"), { recursive: true });
    await writeFile(join(projectDir!, "timeline", "events.json"), `${JSON.stringify([
      {
        id: "ch0001-001",
        chapter: 1,
        summary: "陆沉拆开停走的怀表。",
        participants: ["zhu-jue"],
        effects: { semanticSummary: { chapter: 1, mainEvent: "陆沉拆开停走的怀表。", presentCharacterNames: ["陆沉"] } },
      },
    ], null, 2)}\n`, "utf-8");
  }

  it("正文只写「陆沉」、全程不出现「主角」→ 过关卡出稿，出场名点进写作方向，回执如实说明", async () => {
    await finalizeChapterOneWithLuchen();
    let capturedContext: WriterContextEnvelope | undefined;
    const writerClient: WriterClient = {
      generateDraft: vi.fn(async ({ context }) => {
        capturedContext = context;
        return { title: "第二天", content: "陆沉把游码归位，表针在晨光里重新走起来。" };
      }),
    };

    const outcome = await generateDraftCandidate({
      projectDir: projectDir!,
      chapter: 2,
      writerClient,
    });

    // 核心断言：改前这里 passed=false + "must mention at least one selected character: 主角"。
    expect(outcome.candidate.passed).toBe(true);
    expect(outcome.candidate.issues).toEqual([]);
    expect(outcome.candidate.draftBody).toContain("陆沉");
    // 选角诊断：出场名来自最近定稿章，且如实说明没拿占位名把关。
    expect(outcome.characterSelection.chapterCharactersFromDeltas).toEqual(["陆沉"]);
    expect(outcome.characterSelection.summary).toContain("陆沉");
    expect(outcome.characterSelection.summary).toContain("没拿占位名把关");
    // 写作方向里点出了本章出场角色（出稿模型由此知道本章写谁）。
    const goalSection = capturedContext?.sections.find((section) => section.name === "chapter_goal")?.content as
      | { readonly goal?: unknown }
      | undefined;
    expect(String(goalSection?.goal)).toContain("本章出场角色（按最近定稿章）：陆沉");
  }, 20_000);

  it("作者方向里已点到出场名 → 不重复追加（写作方向保持原样）", async () => {
    await finalizeChapterOneWithLuchen();
    let capturedContext: WriterContextEnvelope | undefined;
    const writerClient: WriterClient = {
      generateDraft: vi.fn(async ({ context }) => {
        capturedContext = context;
        return { title: "第二天", content: "陆沉收起工具，海雾漫上塔基。" };
      }),
    };

    const outcome = await generateDraftCandidate({
      projectDir: projectDir!,
      chapter: 2,
      chapterGoal: "写陆沉修完表后的傍晚。",
      writerClient,
    });

    expect(outcome.candidate.passed).toBe(true);
    const goalSection = capturedContext?.sections.find((section) => section.name === "chapter_goal")?.content as
      | { readonly goal?: unknown }
      | undefined;
    expect(String(goalSection?.goal)).not.toContain("本章出场角色");
  }, 20_000);

  it("第 1 章没定稿（时间线没有出场名）→ 仍不被占位卡挡（关卡豁免本身不依赖记账）；诊断如实说没有出场记账", async () => {
    // 只有占位名册 + 没有任何已定稿声明：作者直接让 AI 写第 1 章。
    const writerClient: WriterClient = {
      generateDraft: vi.fn(async () => ({ title: "开篇", content: "海雾里有人敲塔门，来客递上一块停走的表。" })),
    };

    const outcome = await generateDraftCandidate({
      projectDir: projectDir!,
      chapter: 1,
      writerClient,
    });

    expect(outcome.candidate.passed).toBe(true);
    expect(outcome.candidate.issues).toEqual([]);
    expect(outcome.characterSelection.chapterCharactersFromDeltas).toBeUndefined();
    expect(outcome.characterSelection.summary).toContain("没拿占位名把关");
  }, 20_000);

  // 编辑部 R5.4·新发现 4：上两条占位名册回执自带句号，出稿回执拼接处曾拼出「把关。。」。
  // 真引擎 + 真 in-scene-detector 全链：runGenerateDraft 的 summary 里不许再出现「。。」。
  it("出稿回执不出现「。。」（占位名册回执自带句号，拼接处去重）", async () => {
    await finalizeChapterOneWithLuchen();
    const writerClient: WriterClient = {
      generateDraft: vi.fn(async () => ({ title: "第二天", content: "陆沉把游码归位，表针在晨光里重新走起来。" })),
    };

    const result = await runGenerateDraft({
      projectDir: projectDir!,
      chapter: 2,
      writerClient,
      policies: { aiFlavorRecheck: false },
    });

    expect(result.ok).toBe(true);
    expect(result.summary).toContain("按最近定稿章的出场记账");
    expect(result.summary).toContain("没拿占位名把关");
    expect(result.summary).not.toContain("。。");
  }, 20_000);
});
