// @vitest-environment node
import { access, chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { CHAPTER_LEDGER_SCHEMA, cardWrite, composeDraftFile, runCommand, type CardOp, type ChapterLedger } from "@actalk/story-core";
import { describe, expect, it, vi } from "vitest";
import { buildWriterContext, type ContextSection, type WriterContextEnvelope } from "./context-gateway.js";
import { runFastDraft, resolveDraftMaxOutputTokens, type WriterClient } from "./fast-draft-writer.js";
import { buildPromptFingerprint, findFirstPromptDifference, renderFastDraftPromptText } from "./prompt-cache-diagnostics.js";
import { createStoryProject } from "../book/project-store.js";

/** 引擎不写盘了（重构 P7）：拼出调用方会落进工作稿的文件文本，沿用原来按文件比对的断言。 */
function draftFileOf(report: { readonly title?: string; readonly draftBody?: string }): string {
  return composeDraftFile({ ...(report.title ? { title: report.title } : {}), body: report.draftBody ?? "" });
}

describe("StoryEngine-NG FastDraftWriter", () => {
  it("dry-run builds context stats without calling writer or writing a draft", async () => {
    const projectDir = await createFixtureProject();
    const writerClient: WriterClient = {
      generateDraft: vi.fn(),
    };

    const report = await runFastDraft({
      projectDir,
      chapter: 1,
      chapterGoal: "开局交代主角处境。",
      writerClient,
      dryRun: true,
    });

    expect(report.passed).toBe(true);
    expect(report.draftBody).toBeUndefined();
    // 重构 P9：设定（主角、人物、写作规则……）全在 writing_context_pack 的设定包里，老的
    // story_core / world_core / character_* / world_state 段都没了；上下文段全是 dynamic。
    expect(report.contextStats.contextSections).toEqual([
      "chapter_goal",
      "writing_context_pack",
      "story_calendar",
      "hook_pool",
      "hook_tracking",
      "story_threads",
      "arc_goals",
      "story_continuity",
      "timeline_events",
    ]);
    expect(report.contextStats.totalTokenEstimate).toBeGreaterThan(0);
    expect(report.contextStats.stableTokenEstimate).toBe(0);
    expect(report.contextStats.dynamicTokenEstimate).toBe(report.contextStats.totalTokenEstimate);
    expect(report.promptFingerprint).toMatchObject({
      firstDynamicSectionName: "Chapter",
      firstDynamicSectionIndex: 1,
    });
    expect(report.promptFingerprint.firstDynamicCharOffset).toBeGreaterThan(0);
    expect(report.promptFingerprint.stablePrefixHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(report.promptFingerprint.dynamicSuffixHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(writerClient.generateDraft).not.toHaveBeenCalled();
    await expect(access(join(projectDir, "drafts", "fast", "chapter-0001.md"))).rejects.toThrow();
  });

  it("keeps the default context ranking path byte-identical to an explicit identity ranker", async () => {
    const projectDir = await createFixtureProject();
    const writerClient: WriterClient = { generateDraft: vi.fn() };

    const defaultReport = await runFastDraft({
      projectDir,
      chapter: 1,
      chapterGoal: "开局交代主角处境。",
      writerClient,
      dryRun: true,
    });
    const identityReport = await runFastDraft({
      projectDir,
      chapter: 1,
      chapterGoal: "开局交代主角处境。",
      writerClient,
      dryRun: true,
      rankContext: (envelope: WriterContextEnvelope) => envelope,
    });

    expect(identityReport.contextStats).toEqual(defaultReport.contextStats);
    expect(identityReport.promptFingerprint).toEqual(defaultReport.promptFingerprint);
  });

  it("applies rankContext after context build and keeps stable prompt prefix cache-safe", async () => {
    const projectDir = await createFixtureProject();
    const writerClient: WriterClient = { generateDraft: vi.fn() };
    let originalContext: WriterContextEnvelope | undefined;
    let rankedContext: WriterContextEnvelope | undefined;

    const report = await runFastDraft({
      projectDir,
      chapter: 1,
      chapterGoal: "开局交代主角处境。",
      writerClient,
      dryRun: true,
      rankContext: (envelope: WriterContextEnvelope) => {
        originalContext = envelope;
        const sections = envelope.sections.map((section) => section.name === "chapter_goal"
          ? {
            ...section,
            content: { chapter: envelope.chapter, goal: "ranked dynamic goal marker" },
            tokenEstimate: section.tokenEstimate + 7,
          }
          : section);
        rankedContext = { ...envelope, sections };
        return rankedContext;
      },
    });

    expect(originalContext).toBeTruthy();
    expect(rankedContext).toBeTruthy();
    const originalFingerprint = buildPromptFingerprint(originalContext!);
    const rankedFingerprint = buildPromptFingerprint(rankedContext!);

    expect(renderFastDraftPromptText(rankedContext!)).toContain("ranked dynamic goal marker");
    expect(report.promptFingerprint.fullPromptHash).toBe(rankedFingerprint.fullPromptHash);
    expect(report.promptFingerprint.stablePrefixHash).toBe(originalFingerprint.stablePrefixHash);
    expect(report.promptFingerprint.dynamicSuffixHash).not.toBe(originalFingerprint.dynamicSuffixHash);
    expect(report.contextStats).toEqual({
      totalTokenEstimate: rankedContext!.sections.reduce((sum, section) => sum + section.tokenEstimate, 0),
      stableTokenEstimate: rankedContext!.sections
        .filter((section) => section.cachePolicy === "stable")
        .reduce((sum, section) => sum + section.tokenEstimate, 0),
      dynamicTokenEstimate: rankedContext!.sections
        .filter((section) => section.cachePolicy !== "stable")
        .reduce((sum, section) => sum + section.tokenEstimate, 0),
      contextSections: rankedContext!.sections.map((section) => section.name),
    });
  });

  it("places stable sections before the chapter line to improve prompt prefix stability", async () => {
    const projectDir = await createFixtureProject();
    const chapter19 = await buildWriterContext({
      projectDir,
      chapter: 19,
      chapterGoal: "Draft chapter 19.",
    });
    const chapter20 = await buildWriterContext({
      projectDir,
      chapter: 20,
      chapterGoal: "Draft chapter 20.",
    });
    const prompt19 = renderFastDraftPromptText(chapter19);
    const prompt20 = renderFastDraftPromptText(chapter20);
    const diff = findFirstPromptDifference(prompt19, prompt20);
    const fingerprint = buildPromptFingerprint(chapter19, prompt19);
    const fingerprint20 = buildPromptFingerprint(chapter20, prompt20);
    const sectionNames = chapter19.trace.sectionNames;

    expect(diff.firstDiffCharOffset).toBe(prompt19.indexOf("Chapter: 19") + "Chapter: ".length);
    expect(diff.firstDiffCharOffset).toBeGreaterThan(500);
    expect(diff.leftSnippet).toContain("Chapter: 19");
    expect(diff.rightSnippet).toContain("Chapter: 20");
    // 稳定前缀只剩写手协议（设定包随本章在场人物变，归 dynamic）。
    expect(fingerprint.promptSectionOrder.slice(0, 3)).toEqual([
      "fast_draft_protocol",
      "Chapter",
      "chapter_goal",
    ]);
    expect(fingerprint.firstDynamicSectionName).toBe("Chapter");
    expect(fingerprint.firstDynamicCharOffset).toBe(prompt19.indexOf("Chapter:"));
    expect(fingerprint.estimatedStablePrefixRatio).toBeGreaterThan(0.15);
    expect(fingerprint.stablePrefixHash).toBe(fingerprint20.stablePrefixHash);
    expect(fingerprint.dynamicSuffixHash).not.toBe(fingerprint20.dynamicSuffixHash);
    for (const sectionName of sectionNames) {
      expect(prompt19).toContain(`## ${sectionName}`);
    }
  });

  it("asks FastDraft to generate a non-spoiler chapter title in the opening heading", async () => {
    const projectDir = await createFixtureProject();
    const context = await buildWriterContext({
      projectDir,
      chapter: 1,
      chapterGoal: "主角发现半张申请表异常发热。",
    });
    const prompt = renderFastDraftPromptText(context);

    expect(prompt).toContain("正文开头必须是 markdown 章节标题，格式：# 第N章 · 标题。");
    expect(prompt).toContain("标题由你根据本章正文自然拟定，必须存在");
    expect(prompt).toContain("不要剧透设定里写着还没揭开、不能说破的内容");
  });

  it("tells FastDraft not to reuse the previous chapter opening pattern", async () => {
    const projectDir = await createFixtureProject();
    const context = await buildWriterContext({
      projectDir,
      chapter: 4,
      chapterGoal: "主角进入集团公关部后，第一次面对媒体预演。",
    });
    const prompt = renderFastDraftPromptText(context);

    expect(prompt).toContain("连续章节必须避免重复上一章开头场面、首句结构和人物进场方式");
    expect(prompt).toContain("否则用新的动作、时间点或压力源切入");
  });

  it("generates and saves a fast draft without committing state", async () => {
    const projectDir = await createFixtureProject();
    const cardsBefore = await readFile(join(projectDir, "ledger", "cards.json"), "utf-8");
    const writerClient: WriterClient = {
      generateDraft: vi.fn(async ({ context, maxOutputTokens }) => {
        expect(context.chapter).toBe(1);
        expect(maxOutputTokens).toBe(1200);
        return {
          title: "开局",
          content: "Guo Xu 站在大门前，第一次意识到自己的副本已经开始。",
          tokenUsage: { promptTokens: 100, completionTokens: 60, totalTokens: 160 },
        };
      }),
    };

    const report = await runFastDraft({
      projectDir,
      chapter: 1,
      chapterGoal: "主角进入大门。",
      writerClient,
      maxOutputTokens: 1200,
    });

    expect(report).toMatchObject({
      chapter: 1,
      passed: true,
      title: "开局",
      tokenUsage: { promptTokens: 100, completionTokens: 60, totalTokens: 160 },
      issues: [],
    });
    // 引擎不写盘：工作稿文件由调用方走 draft.applyGenerated 落。
    await expect(access(join(projectDir, "drafts", "fast", "chapter-0001.md"))).rejects.toThrow();
    await expect(Promise.resolve(draftFileOf(report))).resolves.toBe(
      "# 开局\n\nGuo Xu 站在大门前，第一次意识到自己的副本已经开始。\n",
    );
    // 不记账、不动设定：没有章节账单，设定卡一字不变，也不建任何老格式状态目录。
    await expect(access(join(projectDir, "ledger", "chapters", "0001.json"))).rejects.toThrow();
    await expect(readFile(join(projectDir, "ledger", "cards.json"), "utf-8")).resolves.toBe(cardsBefore);
    for (const dir of ["story", "timeline", "world", "characters", "state-diff"]) {
      await expect(access(join(projectDir, dir))).rejects.toThrow();
    }
    expect(writerClient.generateDraft).toHaveBeenCalledOnce();
  });

  it("generates the body without writing the draft file (落盘交给 draft.applyGenerated)", async () => {
    const projectDir = await createFixtureProject();
    const writerClient: WriterClient = {
      generateDraft: vi.fn(async () => ({
        title: "候选一版",
        content: "Guo Xu 推开门，雪光照进来。",
        tokenUsage: { promptTokens: 80, completionTokens: 40, totalTokens: 120 },
      })),
    };

    const report = await runFastDraft({
      projectDir,
      chapter: 1,
      chapterGoal: "再来一版。",
      writerClient,
    });

    expect(report.passed).toBe(true);
    expect(report.title).toBe("候选一版");
    // 候选正文走 report.draftBody 返回，路由据此并排展示
    expect(report.draftBody).toBe("Guo Xu 推开门，雪光照进来。");
    // 关键：不写工作稿文件——候选临时、不冲掉当前草稿、不污染操作历史
    await expect(access(join(projectDir, "drafts", "fast", "chapter-0001.md"))).rejects.toThrow();
  });

  it("injects an explicit user draft length target into FastDraft context and report diagnostics", async () => {
    const projectDir = await createFixtureProject();
    await writeCards(projectDir, [{ op: "rules.set", field: "targetWords", value: 1800 }]);
    const writerClient: WriterClient = {
      generateDraft: vi.fn(async ({ context, maxOutputTokens }) => {
        expect(maxOutputTokens).toBe(resolveDraftMaxOutputTokens({
          requested: 900,
          lowerBound: 765,
          upperBound: 1035,
          source: "user",
        }));
        const chapterGoal = context.sections.find((section: ContextSection) => section.name === "chapter_goal")?.content;
        expect(JSON.stringify(chapterGoal)).toContain("用户明确要求约 900 字");
        expect(JSON.stringify(chapterGoal)).toContain("765-1035 个中文字符");
        return {
          title: "长度控制",
          content: `${"海".repeat(880)} Guo Xu.`,
        };
      }),
    };

    const report = await runFastDraft({
      projectDir,
      chapter: 1,
      chapterGoal: "主角进入大门。",
      requestedDraftLength: 900,
      writerClient,
    });

    expect(report.passed).toBe(true);
    expect(report.draftLength).toMatchObject({
      requestedDraftLength: 900,
      source: "user",
      lowerBound: 765,
      upperBound: 1035,
      actualLength: 880,
      lengthStatus: "within_range",
      whetherTrimmed: false,
    });
    expect(report.diagnostics?.details).toMatchObject({
      draftLength: {
        requestedDraftLength: 900,
        lowerBound: 765,
        upperBound: 1035,
        lengthStatus: "within_range",
      },
    });
  });

  it("uses the setting cards' writing-rules target words when no user draft length is specified", async () => {
    const projectDir = await createFixtureProject();
    await writeCards(projectDir, [{ op: "rules.set", field: "targetWords", value: 700 }]);
    const writerClient: WriterClient = {
      generateDraft: vi.fn(async ({ context, maxOutputTokens }) => {
        expect(maxOutputTokens).toBe(resolveDraftMaxOutputTokens({
          requested: 700,
          lowerBound: 595,
          upperBound: 805,
          source: "writing_rules",
        }));
        const chapterGoal = context.sections.find((section: ContextSection) => section.name === "chapter_goal")?.content;
        expect(JSON.stringify(chapterGoal)).toContain("项目写作规则要求约 700 字");
        return {
          title: "写作规则长度",
          content: `${"海".repeat(680)} Guo Xu.`,
        };
      }),
    };

    const report = await runFastDraft({
      projectDir,
      chapter: 1,
      chapterGoal: "主角核对门禁记录。",
      writerClient,
    });

    expect(report.draftLength).toMatchObject({
      requestedDraftLength: 700,
      source: "writing_rules",
      lowerBound: 595,
      upperBound: 805,
      lengthStatus: "within_range",
    });
  });

  it("keeps the explicit user target (structured requestedDraftLength) higher priority than writing-rules target words", async () => {
    const projectDir = await createFixtureProject();
    await writeCards(projectDir, [{ op: "rules.set", field: "targetWords", value: 1800 }]);
    const writerClient: WriterClient = {
      generateDraft: vi.fn(async ({ context }) => {
        const chapterGoal = context.sections.find((section: ContextSection) => section.name === "chapter_goal")?.content;
        expect(JSON.stringify(chapterGoal)).toContain("用户明确要求约 600 字");
        expect(JSON.stringify(chapterGoal)).not.toContain("项目写作规则要求约 1800 字");
        return {
          title: "用户优先",
          content: `${"海".repeat(610)} Guo Xu.`,
        };
      }),
    };

    const report = await runFastDraft({
      projectDir,
      chapter: 1,
      chapterGoal: "写林远核对门禁。",
      requestedDraftLength: 600,
      writerClient,
    });

    expect(report.draftLength).toMatchObject({
      requestedDraftLength: 600,
      source: "user",
      lowerBound: 510,
      upperBound: 690,
      lengthStatus: "within_range",
    });
  });

  it("scales generated max output tokens with the upper draft length bound", async () => {
    const short = resolveDraftMaxOutputTokens({
      requested: 600,
      lowerBound: 510,
      upperBound: 690,
      source: "user",
    });
    const long = resolveDraftMaxOutputTokens({
      requested: 2200,
      lowerBound: 1870,
      upperBound: 2530,
      source: "user",
    });

    expect(long).toBeGreaterThan(short);
    expect(short).toBeGreaterThanOrEqual(360);
    expect(long).toBeLessThanOrEqual(4096);
  });

  it("records a controlled below-lower-bound length warning without hiding the actual length", async () => {
    const projectDir = await createFixtureProject();
    const writerClient: WriterClient = {
      generateDraft: vi.fn(async () => ({
        title: "短草稿",
        content: `${"海".repeat(200)} Guo Xu.`,
      })),
    };

    const report = await runFastDraft({
      projectDir,
      chapter: 1,
      chapterGoal: "主角进入大门。",
      requestedDraftLength: 700,
      writerClient,
    });

    expect(report.passed).toBe(true);
    expect(report.draftLength).toMatchObject({
      requestedDraftLength: 700,
      lowerBound: 595,
      upperBound: 805,
      actualLength: 200,
      lengthStatus: "below_lower_bound",
      retryReason: "below_lower_bound",
    });
  });

  it("trims above-upper-bound drafts before writing the final fast draft", async () => {
    const projectDir = await createFixtureProject();
    const writerClient: WriterClient = {
      generateDraft: vi.fn(async () => ({
        title: "超长草稿",
        content: [
          `Guo Xu ${"海".repeat(320)}。`,
          `${"山".repeat(300)}。`,
          `${"门".repeat(280)}。`,
          `${"灯".repeat(260)}。`,
        ].join("\n\n"),
      })),
    };

    const report = await runFastDraft({
      projectDir,
      chapter: 1,
      chapterGoal: "主角进入大门。",
      requestedDraftLength: 700,
      writerClient,
    });

    expect(report.passed).toBe(true);
    expect(report.draftLength).toMatchObject({
      requestedDraftLength: 700,
      lowerBound: 595,
      upperBound: 805,
      lengthStatus: "within_range",
      whetherTrimmed: true,
      finalLengthAfterTrim: expect.any(Number),
    });
    expect(report.draftLength?.actualLength).toBeGreaterThanOrEqual(595);
    expect(report.draftLength?.actualLength).toBeLessThanOrEqual(805);
    expect(report.draftLength?.finalLengthAfterTrim).toBe(report.draftLength?.actualLength);
    expect(report.diagnostics?.details).toMatchObject({
      draftLength: {
        lengthStatus: "within_range",
        whetherTrimmed: true,
        finalLengthAfterTrim: report.draftLength?.actualLength,
      },
    });
    const written = draftFileOf(report);
    const writtenBody = written.replace(/^#.*\n+/u, "").trim();
    expect(writtenBody).not.toBe("");
    expect(writtenBody).not.toBe("超长草稿");
    const writtenCjk = (writtenBody.match(/[\u3400-\u9fff]/gu) ?? []).length;
    expect(writtenCjk).toBe(report.draftLength?.actualLength);
    expect(writtenCjk).toBeGreaterThanOrEqual(595);
    expect(writtenCjk).toBeLessThanOrEqual(805);
  });

  it("uses one canonical draft path width for chapter 1, 10, and 100", async () => {
    const projectDir = await createFixtureProject();
    const writerClient: WriterClient = {
      generateDraft: vi.fn(async ({ context }) => ({
        title: `第${context.chapter}章`,
        content: `Guo Xu 在第${context.chapter}章确认草稿路径必须一致。`,
      })),
    };

    for (const chapter of [1, 10, 100]) {
      const report = await runFastDraft({
        projectDir,
        chapter,
        chapterGoal: `写第${chapter}章。`,
        writerClient,
      });

      expect(report.passed).toBe(true);
      await expect(Promise.resolve(draftFileOf(report))).resolves.toContain(`第${chapter}章`);
    }
  });

  it("does not duplicate markdown chapter headings from model output", async () => {
    const cases = [
      {
        // 只写了章号：算没起名（第 16 轮 AD1），文件里不出章名行。
        title: "第1章",
        content: "# 第一章\n\nGuo Xu 站在大门前，确认自己不能回头。",
        expected: "Guo Xu 站在大门前，确认自己不能回头。\n",
      },
      {
        title: "开局",
        content: "Guo Xu 站在大门前，确认自己不能回头。",
        expected: "# 开局\n\nGuo Xu 站在大门前，确认自己不能回头。\n",
      },
      {
        title: "开端",
        // R7.7：模型把章号写错（写第 3 章却标「第1章」）→ 按本章章号重拼成「第3章 · 开端」。
        content: "# 第1章 · 开端\n\nGuo Xu 站在大门前，确认自己不能回头。",
        expected: "# 第3章 · 开端\n\nGuo Xu 站在大门前，确认自己不能回头。\n",
      },
      {
        // R7.7：同上，第 4 章写成「第1章」→ 重拼为「第4章 · 半张申请表」。
        title: "第1章 · 半张申请表",
        content: "# 第1章 · 半张申请表\n\nGuo Xu 站在大门前，确认自己不能回头。",
        expected: "# 第4章 · 半张申请表\n\nGuo Xu 站在大门前，确认自己不能回头。\n",
      },
    ];

    for (const [index, item] of cases.entries()) {
      const projectDir = await createFixtureProject();
      const chapter = index + 1;
      const writerClient: WriterClient = {
        generateDraft: vi.fn(async () => ({
          title: item.title,
          content: item.content,
        })),
      };

      const report = await runFastDraft({
        projectDir,
        chapter,
        chapterGoal: "主角进入大门。",
        writerClient,
      });

      expect(report.passed).toBe(true);
      await expect(Promise.resolve(draftFileOf(report))).resolves.toBe(item.expected);
    }
  });

  it("prefers a meaningful markdown chapter heading over a generic writer title", async () => {
    const projectDir = await createFixtureProject();
    const writerClient: WriterClient = {
      generateDraft: vi.fn(async () => ({
        title: "第1章",
        content: "# 第1章 · 半张申请表\n\nGuo Xu 站在大门前，确认自己不能回头。",
      })),
    };

    const report = await runFastDraft({
      projectDir,
      chapter: 1,
      chapterGoal: "主角发现半张申请表异常发热。",
      writerClient,
    });

    expect(report.title).toBe("第1章 · 半张申请表");
    await expect(Promise.resolve(draftFileOf(report))).resolves.toBe(
      "# 第1章 · 半张申请表\n\nGuo Xu 站在大门前，确认自己不能回头。\n",
    );
  });

  it("no meaningful title from the model → no title at all (写作版本 P1 第 16 轮 AD1：不补「第N章」)", async () => {
    const projectDir = await createFixtureProject();
    const writerClient: WriterClient = {
      generateDraft: vi.fn(async () => ({
        title: "第1章",
        content: "Guo Xu 捏着半张申请表，纸面在掌心里一点点发热。",
      })),
    };

    const report = await runFastDraft({
      projectDir,
      chapter: 1,
      chapterGoal: "主角发现半张申请表异常发热。",
      writerClient,
    });

    expect(report.title).toBeUndefined();
    await expect(Promise.resolve(draftFileOf(report))).resolves.toBe(
      "Guo Xu 捏着半张申请表，纸面在掌心里一点点发热。\n",
    );
  });

  // R7.7·报告第 5 节：AI 起的章标题统一「第N章 · 标题」、章号用阿拉伯数字（模型会写「第九章」「第十章」，还会数错章）。
  // 纯确定性后处理：剥掉模型自己写的第X章前缀后按规范重拼，标题文字本身不动。
  it("normalizes model heading titles to 第N章 · 标题 with arabic chapter number（R7.7）", async () => {
    const cases = [
      { chapter: 9, heading: "# 第九章 · 铁丝", expected: "# 第9章 · 铁丝" },
      { chapter: 9, heading: "# 铁丝", expected: "# 第9章 · 铁丝" },
      { chapter: 10, heading: "# 第十章——旧钟摆", expected: "# 第10章 · 旧钟摆" },
      { chapter: 5, heading: "# 第三章 · 夜访（模型数错章）", expected: "# 第5章 · 夜访（模型数错章）" },
      { chapter: 7, heading: "# 第7章 铁丝圈", expected: "# 第7章 · 铁丝圈" },
    ];
    for (const item of cases) {
      const projectDir = await createFixtureProject();
      const writerClient: WriterClient = {
        generateDraft: vi.fn(async () => ({
          title: `第${item.chapter}章`,
          content: `${item.heading}\n\nGuo Xu 站在大门前，确认自己不能回头。`,
        })),
      };
      const report = await runFastDraft({
        projectDir,
        chapter: item.chapter,
        chapterGoal: "主角推进剧情。",
        writerClient,
      });
      expect(report.passed).toBe(true);
      await expect(Promise.resolve(draftFileOf(report))).resolves.toBe(
        `${item.expected}\n\nGuo Xu 站在大门前，确认自己不能回头。\n`,
      );
    }
  });

  it("model writes only a chinese-numeral chapter label（第十章）→ 算没起名，章号行也不留在正文里", async () => {
    const projectDir = await createFixtureProject();
    const writerClient: WriterClient = {
      generateDraft: vi.fn(async () => ({
        title: "第10章",
        content: "# 第十章\n\nGuo Xu 站在大门前，确认自己不能回头。",
      })),
    };
    const report = await runFastDraft({
      projectDir,
      chapter: 10,
      chapterGoal: "主角推进剧情。",
      writerClient,
    });
    expect(report.title).toBeUndefined();
    await expect(Promise.resolve(draftFileOf(report))).resolves.toBe(
      "Guo Xu 站在大门前，确认自己不能回头。\n",
    );
  });

  it("rejects empty content and does not save a draft", async () => {
    const projectDir = await createFixtureProject();
    const writerClient: WriterClient = {
      generateDraft: vi.fn(async () => ({
        title: "空草稿",
        content: "",
        tokenUsage: { promptTokens: 5, completionTokens: 0, totalTokens: 5 },
      })),
    };

    const report = await runFastDraft({
      projectDir,
      chapter: 2,
      chapterGoal: "测试空正文。",
      writerClient,
    });

    expect(report.passed).toBe(false);
    expect(report.draftBody).toBeUndefined();
    expect(report.tokenUsage).toEqual({ promptTokens: 5, completionTokens: 0, totalTokens: 5 });
    expect(report.issues).toEqual(expect.arrayContaining(["Draft content is required."]));
    await expect(access(join(projectDir, "drafts", "fast", "chapter-0002.md"))).rejects.toThrow();
  });

  it("rejects JSON or tool-call artifacts and does not save them", async () => {
    const projectDir = await createFixtureProject();
    const writerClient: WriterClient = {
      generateDraft: vi.fn(async () => ({
        title: "坏草稿",
        content: "{\"name\":\"tool_call\",\"arguments\":{}}",
        tokenUsage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
      })),
    };

    const report = await runFastDraft({
      projectDir,
      chapter: 2,
      chapterGoal: "测试非法输出。",
      writerClient,
    });

    expect(report.passed).toBe(false);
    expect(report.draftBody).toBeUndefined();
    expect(report.issues).toEqual(expect.arrayContaining([
      "Draft content looks like JSON or a tool-call artifact.",
      expect.stringContaining("Draft content must mention at least one selected character"),
    ]));
    await expect(access(join(projectDir, "drafts", "fast", "chapter-0002.md"))).rejects.toThrow();
  });

  // 出稿关卡认的名字 = 本章上下文（writing_context_pack 设定包）里带上的主角和在场人物的名字 + 别名。
  it("selectedCharacters（名字）进设定包；正文只用了别名也算写到了人", async () => {
    const projectDir = await createFixtureProject();
    const writerClient: WriterClient = {
      generateDraft: vi.fn(async () => ({
        title: "秘书登场",
        content: "林秘书把日程表放在桌上，提醒他今晚还有一场谈判。",
      })),
    };

    const report = await runFastDraft({
      projectDir,
      chapter: 3,
      chapterGoal: "秘书出场。",
      writerClient,
      selectedCharacters: ["林婉清"],
    });

    expect(report.passed).toBe(true);
    expect(report.issues).toEqual([]);
  });

  it("写手用英文直引号写的对话 → 落盘前换成中文引号（长篇连写 2026-10-24：整章直引号和别章混着）", async () => {
    const projectDir = await createFixtureProject();
    const report = await runFastDraft({
      projectDir,
      chapter: 3,
      chapterGoal: "秘书出场。",
      writerClient: {
        generateDraft: vi.fn(async () => ({ title: "秘书登场", content: "\"今晚还有一场谈判。\"林婉清说，\"别忘了。\"" })),
      },
      selectedCharacters: ["林婉清"],
    });
    expect(report.passed).toBe(true);
    expect(report.draftBody).toBe("“今晚还有一场谈判。”林婉清说，“别忘了。”");
  });

  it("写手整章用了直角引号、上一章对话用弯引号 → 跟着上一章换成弯引号（换题材长篇实跑第 23 章）", async () => {
    const projectDir = await createFixtureProject();
    await mkdir(join(projectDir, "chapters"), { recursive: true });
    await writeFile(join(projectDir, "chapters", "0002.md"), "# 第2章 · 谈判\n\n“今晚还有一场谈判。”林婉清说。\n", "utf-8");
    const report = await runFastDraft({
      projectDir,
      chapter: 3,
      chapterGoal: "秘书出场。",
      writerClient: {
        generateDraft: vi.fn(async () => ({ title: "秘书登场", content: "「谈完了。」林婉清说，「别忘了。」" })),
      },
      selectedCharacters: ["林婉清"],
    });
    expect(report.draftBody).toBe("“谈完了。”林婉清说，“别忘了。”");
  });

  it("关卡只认本章带上的人：设定本里有、但这章没带的人不算；挡下时只列名字", async () => {
    const projectDir = await createFixtureProject();

    // 本章方向点到林婉清 → 在场检测带上她 → 只写她也过。
    const passing = await runFastDraft({
      projectDir,
      chapter: 2,
      chapterGoal: "林婉清出场。",
      writerClient: {
        generateDraft: vi.fn(async () => ({ title: "秘书登场", content: "林婉清把日程表放在桌上。" })),
      },
    });
    expect(passing.passed).toBe(true);

    // 本章只带了主角；正文一个人都没写到 → 挡下，提示只列本章带上的名字（不列没带的林婉清，也不列别的书的人）。
    const blocked = await runFastDraft({
      projectDir,
      chapter: 2,
      chapterGoal: "陌生人登场。",
      writerClient: {
        generateDraft: vi.fn(async () => ({ title: "陌生人", content: "来客放下信，转身走进雨里。" })),
      },
    });
    expect(blocked.passed).toBe(false);
    const gateIssue = blocked.issues.find((issue) => issue.includes("must mention at least one selected character"));
    expect(gateIssue).toBe("Draft content must mention at least one selected character: Guo Xu.");
  });

  it("账里上一章出场、还没建卡的人也进设定包，正文写到他就算写到了人", async () => {
    const projectDir = await createFixtureProject();
    const ledger: ChapterLedger = {
      schema: CHAPTER_LEDGER_SCHEMA,
      chapter: 1,
      textSha256: "0".repeat(64),
      committedAt: "2026-10-19T00:00:00.000Z",
      origin: "commit",
      entries: [{ kind: "presence", id: "c1-1", review: "auto", name: "陆沉", nameUsed: "陆沉", quote: "陆沉来了" }],
    };
    await mkdir(join(projectDir, "ledger", "chapters"), { recursive: true });
    await writeFile(join(projectDir, "ledger", "chapters", "0001.json"), JSON.stringify(ledger), "utf-8");

    const report = await runFastDraft({
      projectDir,
      chapter: 2,
      chapterGoal: "接着前文写。",
      writerClient: {
        generateDraft: vi.fn(async () => ({ title: "第二天", content: "陆沉把工具箱收好，天色一点点暗下来。" })),
      },
    });

    expect(report.passed).toBe(true);
  });

  // 编辑部 R4.6（验收 3.7）的新口径：开书没填主角就没有人物卡（不再落占位卡「主角」），
  // 关卡没有可认的名字就不挡——作者手写几章后让 AI 出稿，正文写真名不会被拒。
  it("新书一张人物卡都没有 → 关卡不挡（没有可认的名字）", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "story-engine-fast-draft-"));
    const { projectDir } = await createStoryProject({ rootDir, title: "灯塔修表人", genre: "长篇故事" });
    const writerClient: WriterClient = {
      generateDraft: vi.fn(async () => ({
        title: "第二天",
        content: "陆沉把工具箱收好，天色一点点暗下来。",
      })),
    };

    const report = await runFastDraft({
      projectDir,
      chapter: 2,
      chapterGoal: "接着前文写。",
      writerClient,
    });

    expect(report.passed).toBe(true);
    expect(report.issues).toEqual([]);
  });

  // ── 2026-09-15 复审 P1-4/P1-5 真修 + A5 路径泄漏纪律 ──
  // 上下文构造失败/台账资料损坏时 runFastDraft 绝不 reject：落 passed:false + 结构化 code，
  // 或降级成功并留痕。用户可见文案只给 errno code + 相对文件名，绝不带本地绝对路径。
  const NO_ABSOLUTE_PATH = /\/Users|\/var|\/private|\/tmp|\/home/u;

  it("A4/A5 损坏设定卡（ledger/cards.json）→ 降级出稿成功且留痕（issues + read_failures 段，无绝对路径）", async () => {
    const projectDir = await createFixtureProject();
    await writeFile(join(projectDir, "ledger", "cards.json"), "{not-json", "utf-8");
    let capturedContext: WriterContextEnvelope | undefined;
    const writerClient: WriterClient = {
      generateDraft: vi.fn(async ({ context }) => {
        capturedContext = context;
        return { title: "降级稿", content: "Guo Xu 在规则缺失下继续推进。" };
      }),
    };

    const report = await runFastDraft({ projectDir, chapter: 2, chapterGoal: "降级出稿。", writerClient });

    // 降级成功：不崩、按空设定出稿（没有可认的名字，关卡不挡）。设定本读不了的留痕进 issues；
    // 上下文的 read_failures 段也如实记着——模型知道自己在盲写，绝不静默。
    expect(report.passed).toBe(true);
    expect(report.issues.join(" ")).toContain("设定本读取失败");
    expect(report.issues.join(" ")).not.toMatch(NO_ABSOLUTE_PATH);
    const failures = capturedContext?.sections.find((section) => section.name === "read_failures")?.content as
      | { failures: readonly string[] }
      | undefined;
    expect(failures?.failures.join(" ")).toContain("设定本读取失败");
    expect(failures?.failures.join(" ")).not.toMatch(NO_ABSOLUTE_PATH);
  });

  it("C 级收尾：损坏设定卡 + 校验失败早退 → issues 同时含降级留痕与校验问题", async () => {
    const projectDir = await createFixtureProject();
    await writeFile(join(projectDir, "ledger", "cards.json"), "{not-json", "utf-8");
    const writerClient: WriterClient = {
      generateDraft: vi.fn(async () => ({
        title: "空草稿",
        content: "",
        tokenUsage: { promptTokens: 5, completionTokens: 0, totalTokens: 5 },
      })),
    };

    const report = await runFastDraft({ projectDir, chapter: 2, chapterGoal: "测试空正文。", writerClient });

    // validateDraft 失败早退路径此前漏并降级留痕（复审探针实证）。
    // 现在与成功/catch 路径同口径：issues 同时含「设定本读取失败」留痕与校验问题本体。
    expect(report.passed).toBe(false);
    expect(report.draftBody).toBeUndefined();
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.stringContaining("设定本读取失败"),
      "Draft content is required.",
    ]));
    expect(report.issues.join(" ")).not.toMatch(NO_ABSOLUTE_PATH);
    await expect(access(join(projectDir, "drafts", "fast", "chapter-0002.md"))).rejects.toThrow();
  });

  it("A4 缺 story/hooks.json（新书本来就没有）→ runFastDraft 正常出稿", async () => {
    const projectDir = await createFixtureProject();
    await expect(access(join(projectDir, "story", "hooks.json"))).rejects.toThrow();
    const writerClient: WriterClient = {
      generateDraft: vi.fn(async () => ({ title: "老书", content: "Guo Xu 推进情节。" })),
    };

    const report = await runFastDraft({ projectDir, chapter: 2, chapterGoal: "老书续写。", writerClient });
    expect(report.passed).toBe(true); // ENOENT 兜底为空池，不再 reject/失败
  });

  it("A4/A5 损坏 story/hooks.json → passed:false + writer_context_unavailable，不 reject、不泄路径", async () => {
    const projectDir = await createFixtureProject();
    await mkdir(join(projectDir, "story"), { recursive: true });
    await writeFile(join(projectDir, "story", "hooks.json"), "{not-json", "utf-8");
    const writerClient: WriterClient = { generateDraft: vi.fn() };

    const report = await runFastDraft({ projectDir, chapter: 2, chapterGoal: "损坏台账。", writerClient });

    // 伏笔池是正式状态——损坏时诚实失败（不静默当空池盲写），但绝不 reject 砸穿调用方。
    expect(report.passed).toBe(false);
    expect(report.issues.join(" ")).toContain("writer_context_unavailable");
    expect(report.issues.join(" ")).toContain("JSON 解析失败");
    expect(report.issues.join(" ")).not.toMatch(NO_ABSOLUTE_PATH);
    expect(writerClient.generateDraft).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")("A5 EACCES 读 hooks.json → 只露 errno code + 相对文件名，不露绝对路径", async () => {
    const projectDir = await createFixtureProject();
    await mkdir(join(projectDir, "story"), { recursive: true });
    await writeFile(join(projectDir, "story", "hooks.json"), `${JSON.stringify({ hooks: [] }, null, 2)}\n`, "utf-8");
    await chmod(join(projectDir, "story", "hooks.json"), 0o000);
    const writerClient: WriterClient = { generateDraft: vi.fn() };
    try {
      const report = await runFastDraft({ projectDir, chapter: 2, chapterGoal: "权限故障。", writerClient });
      expect(report.passed).toBe(false);
      expect(report.issues.join(" ")).toContain("writer_context_unavailable");
      expect(report.issues.join(" ")).toContain("EACCES");
      // mkdtemp 落在 /var/folders/...——若误拼 error.message 原文这里必中
      expect(report.issues.join(" ")).not.toMatch(NO_ABSOLUTE_PATH);
      expect(writerClient.generateDraft).not.toHaveBeenCalled();
    } finally {
      await chmod(join(projectDir, "story", "hooks.json"), 0o644);
    }
  });

  it("A5 ENOTDIR（timeline 被文件顶位）→ read_failures 只露 errno code，不露绝对路径", async () => {
    const projectDir = await createFixtureProject();
    await rm(join(projectDir, "timeline"), { recursive: true, force: true });
    await writeFile(join(projectDir, "timeline"), "not a directory", "utf-8");
    let capturedContext: WriterContextEnvelope | undefined;
    const writerClient: WriterClient = {
      generateDraft: vi.fn(async ({ context }) => {
        capturedContext = context;
        return { title: "降级稿", content: "Guo Xu 在时间线缺失下推进。" };
      }),
    };

    const report = await runFastDraft({ projectDir, chapter: 2, chapterGoal: "时间线降级。", writerClient });

    // 时间线属可降级资料——出稿继续但 read_failures 段如实记录 ENOTDIR，文案无绝对路径。
    expect(report.passed).toBe(true);
    const failures = capturedContext?.sections.find((section) => section.name === "read_failures")?.content as
      | { failures: readonly string[] }
      | undefined;
    expect(failures?.failures.join(" ")).toContain("ENOTDIR");
    expect(failures?.failures.join(" ")).not.toMatch(NO_ABSOLUTE_PATH);
  });
});

async function createFixtureProject(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "story-engine-fast-draft-"));
  const { projectDir } = await createStoryProject({
    rootDir,
    title: "我的修仙副本",
    genre: "xianxia",
    logline: "用户自己当主角，从杂役弟子开始逆袭。",
    protagonistName: "Guo Xu",
  });
  await createStoryProject({
    rootDir,
    title: "ignored sibling",
    genre: "xianxia",
    logline: "unused",
    protagonistName: "Someone Else",
  });
  await writeCards(projectDir, [
    { op: "card.create", kind: "character", name: "林婉清", aliases: ["林秘书"], fields: [{ label: "性格", value: "做事精确" }] },
  ]);
  return projectDir;
}

/** 用作者档 card.write 写设定卡（每次换一个幂等键）。 */
async function writeCards(projectDir: string, ops: CardOp[]): Promise<void> {
  const outcome = await runCommand(projectDir, cardWrite, { ops }, { caller: "author", idempotencyKey: `t-${Math.random()}` });
  if (!outcome.ok) throw new Error(outcome.message);
}
