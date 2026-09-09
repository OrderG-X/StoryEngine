import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { buildWriterContext, type ContextSection, type WriterContextEnvelope } from "../context-gateway.js";
import { runFastDraft, resolveDraftMaxOutputTokens, persistFastDraftBody, type WriterClient } from "../fast-draft-writer.js";
import { buildPromptFingerprint, findFirstPromptDifference, renderFastDraftPromptText } from "../prompt-cache-diagnostics.js";
import { createStoryProject } from "../project-store.js";

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
    expect(report.draftPath).toBeUndefined();
    expect(report.contextStats.contextSections).toEqual([
      "story_core",
      "world_core",
      "character_profile",
      "character_core",
      "chapter_goal",
      "writing_context_pack",
      "story_calendar",
      "hook_pool",
      "hook_tracking",
      "story_threads",
      "arc_goals",
      "character_state",
      "world_state",
      "story_continuity",
      "timeline_events",
    ]);
    expect(report.contextStats.totalTokenEstimate).toBeGreaterThan(0);
    expect(report.contextStats.stableTokenEstimate).toBeGreaterThan(0);
    expect(report.contextStats.dynamicTokenEstimate).toBeGreaterThan(0);
    expect(report.promptFingerprint).toMatchObject({
      firstDynamicSectionName: "Chapter",
      firstDynamicSectionIndex: 5,
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
    expect(fingerprint.promptSectionOrder.slice(0, 6)).toEqual([
      "fast_draft_protocol",
      "story_core",
      "world_core",
      "character_profile",
      "character_core",
      "Chapter",
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
    expect(prompt).toContain("不要剧透 protectedSecrets / forbiddenReveals");
    expect(prompt).toContain("不要提前揭开 unknownTruths");
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
      continuityQuality: {
        passed: true,
        score: 1,
        issues: [],
      },
      issues: [],
    });
    expect(report.draftPath).toBe(join(projectDir, "drafts", "fast", "chapter-0001.md"));
    await expect(readFile(report.draftPath!, "utf-8")).resolves.toBe(
      "# 开局\n\nGuo Xu 站在大门前，第一次意识到自己的副本已经开始。\n",
    );
    await expect(readFile(join(projectDir, "characters", "guo-xu", "state.json"), "utf-8")).resolves.toContain(
      "\"lastUpdatedChapter\": null",
    );
    await expect(readFile(join(projectDir, "timeline", "events.json"), "utf-8")).resolves.toBe("[]\n");
    await expect(readFile(join(projectDir, "world", "state.json"), "utf-8")).resolves.toContain(
      "\"lastUpdatedChapter\": null",
    );
    await expect(readFile(join(projectDir, "story", "threads.json"), "utf-8")).resolves.toContain("\"threads\": []");
    await expect(readFile(join(projectDir, "story", "arc-goals.json"), "utf-8")).resolves.toContain("\"goals\": []");
    await expect(access(join(projectDir, "state-diff", "chapter-0001.json"))).rejects.toThrow();
    await expect(access(join(projectDir, "timeline", "chapter-0001.json"))).rejects.toThrow();
    await expect(access(join(projectDir, "world", "diff", "chapter-0001.json"))).rejects.toThrow();
    await expect(access(join(projectDir, "story", "hook-diff", "chapter-0001.json"))).rejects.toThrow();
    await expect(readFile(join(projectDir, "story", "arc-goals.json"), "utf-8")).resolves.toContain("\"goals\": []");
    expect(writerClient.generateDraft).toHaveBeenCalledOnce();
  });

  it("persist:false generates a candidate body without writing the draft file (抽卡候选)", async () => {
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
      persist: false,
    });

    expect(report.passed).toBe(true);
    expect(report.title).toBe("候选一版");
    // 候选正文走 report.draftBody 返回，路由据此并排展示
    expect(report.draftBody).toBe("Guo Xu 推开门，雪光照进来。");
    expect(report.draftPath).toBeUndefined();
    // 关键：不写工作稿文件——候选临时、不冲掉当前草稿、不污染操作历史
    await expect(access(join(projectDir, "drafts", "fast", "chapter-0001.md"))).rejects.toThrow();
  });

  it("injects an explicit user draft length target into FastDraft context and report diagnostics", async () => {
    const projectDir = await createFixtureProject();
    await writeFile(
      join(projectDir, "story", "writing-rules.json"),
      `${JSON.stringify({
        version: "v0",
        chapterLength: { targetWords: 1800 },
      }, null, 2)}\n`,
      "utf-8",
    );
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

  it("uses writing-rules target words when no user draft length is specified", async () => {
    const projectDir = await createFixtureProject();
    await writeFile(
      join(projectDir, "story", "writing-rules.json"),
      `${JSON.stringify({
        version: "v0",
        chapterLength: { targetWords: 700 },
      }, null, 2)}\n`,
      "utf-8",
    );
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

  it("keeps the explicit user target higher priority than writing-rules target words", async () => {
    const projectDir = await createFixtureProject();
    await writeFile(
      join(projectDir, "story", "writing-rules.json"),
      `${JSON.stringify({
        version: "v0",
        chapterLength: { targetWords: 1800 },
      }, null, 2)}\n`,
      "utf-8",
    );
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
      chapterGoal: "这一章约600字，写林远核对门禁。",
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
    const written = await readFile(report.draftPath!, "utf-8");
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

      expect(report.draftPath).toBe(join(projectDir, "drafts", "fast", `chapter-${String(chapter).padStart(4, "0")}.md`));
      await expect(readFile(report.draftPath!, "utf-8")).resolves.toContain(`第${chapter}章`);
    }
  });

  it("does not duplicate markdown chapter headings from model output", async () => {
    const cases = [
      {
        title: "第1章",
        content: "# 第一章\n\nGuo Xu 站在大门前，确认自己不能回头。",
        expected: "# 第1章\n\nGuo Xu 站在大门前，确认自己不能回头。\n",
      },
      {
        title: "开局",
        content: "Guo Xu 站在大门前，确认自己不能回头。",
        expected: "# 开局\n\nGuo Xu 站在大门前，确认自己不能回头。\n",
      },
      {
        title: "开端",
        content: "# 第1章 · 开端\n\nGuo Xu 站在大门前，确认自己不能回头。",
        expected: "# 第1章 · 开端\n\nGuo Xu 站在大门前，确认自己不能回头。\n",
      },
      {
        title: "第1章 · 半张申请表",
        content: "# 第1章 · 半张申请表\n\nGuo Xu 站在大门前，确认自己不能回头。",
        expected: "# 第1章 · 半张申请表\n\nGuo Xu 站在大门前，确认自己不能回头。\n",
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
      await expect(readFile(report.draftPath!, "utf-8")).resolves.toBe(item.expected);
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
    await expect(readFile(report.draftPath!, "utf-8")).resolves.toBe(
      "# 第1章 · 半张申请表\n\nGuo Xu 站在大门前，确认自己不能回头。\n",
    );
  });

  it("falls back to a chapter label when the model omits a meaningful title", async () => {
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

    expect(report.title).toBe("第1章");
    await expect(readFile(report.draftPath!, "utf-8")).resolves.toBe(
      "# 第1章\n\nGuo Xu 捏着半张申请表，纸面在掌心里一点点发热。\n",
    );
  });

  it("records continuity warnings without blocking fast draft persistence", async () => {
    const projectDir = await createFixtureProject();
    await seedSemanticTimeline(projectDir);
    const writerClient: WriterClient = {
      generateDraft: vi.fn(async () => ({
        title: "偏离承接",
        content: "Guo Xu 在大门外整理衣袖，转而观看晨雾，没有追查旧线索。",
        tokenUsage: { promptTokens: 90, completionTokens: 40, totalTokens: 130 },
      })),
    };

    const report = await runFastDraft({
      projectDir,
      chapter: 2,
      chapterGoal: "承接后墙线索。",
      writerClient,
    });

    expect(report.passed).toBe(true);
    expect(report.draftPath).toBe(join(projectDir, "drafts", "fast", "chapter-0002.md"));
    expect(report.continuityQuality).toMatchObject({
      passed: true,
      matched: {
        characters: ["Guo Xu / 主角"],
      },
    });
    expect(report.continuityQuality?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        severity: "warning",
        type: "open_leads_not_referenced",
      }),
    ]));
    expect(report.diagnostics?.details).toMatchObject({
      continuityQuality: {
        passed: true,
        issueCount: expect.any(Number),
      },
    });
    await expect(readFile(report.draftPath!, "utf-8")).resolves.toContain("偏离承接");
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
    expect(report.draftPath).toBeUndefined();
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
    expect(report.draftPath).toBeUndefined();
    expect(report.issues).toEqual(expect.arrayContaining([
      "Draft content looks like JSON or a tool-call artifact.",
      expect.stringContaining("Draft content must mention at least one selected character"),
    ]));
    await expect(access(join(projectDir, "drafts", "fast", "chapter-0002.md"))).rejects.toThrow();
  });

  it("uses selectedCharacterIds for the character mention check", async () => {
    const projectDir = await createFixtureProject();
    const writerClient: WriterClient = {
      generateDraft: vi.fn(async () => ({
        title: "秘书登场",
        content: "林婉清把日程表放在桌上，提醒他今晚还有一场谈判。",
      })),
    };

    const report = await runFastDraft({
      projectDir,
      chapter: 3,
      chapterGoal: "林婉清出场。",
      writerClient,
      selectedCharacterIds: ["Lin Wan-Qing!!"],
    });

    expect(report.passed).toBe(true);
  });

  // 「先 persist:false 出候选、选出优胜再落盘」的写盘通道：与 runFastDraft persist:true 同路径同标题行格式。
  it("persistFastDraftBody writes the canonical draft file (same path + heading format as persist:true)", async () => {
    const projectDir = await createFixtureProject();

    const draftPath = await persistFastDraftBody({
      projectDir,
      chapter: 2,
      title: "雪夜推门",
      draftBody: "Guo Xu 推开门，雪光照进来。\n",
    });

    expect(draftPath).toBe(join(projectDir, "drafts", "fast", "chapter-0002.md"));
    await expect(readFile(draftPath, "utf-8")).resolves.toBe(
      "# 雪夜推门\n\nGuo Xu 推开门，雪光照进来。\n",
    );
  });

  it("runFastDraft persist:false → persistFastDraftBody round-trip matches the persist:true file bytes", async () => {
    const projectDir = await createFixtureProject();
    const body = "Guo Xu 推开门，雪光照进来。";
    const writerClient: WriterClient = {
      generateDraft: vi.fn(async () => ({ title: "候选一版", content: body })),
    };

    const candidate = await runFastDraft({
      projectDir,
      chapter: 1,
      chapterGoal: "再来一版。",
      writerClient,
      persist: false,
    });
    expect(candidate.draftBody).toBe(body);

    const draftPath = await persistFastDraftBody({
      projectDir,
      chapter: 1,
      title: candidate.title ?? "第1章",
      draftBody: candidate.draftBody!,
    });
    await expect(readFile(draftPath, "utf-8")).resolves.toBe(`# 候选一版\n\n${body}\n`);
  });
});

async function createFixtureProject(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "story-engine-fast-draft-"));
  const { projectDir } = await createStoryProject({
    rootDir,
    title: "我的修仙副本",
    genre: "xianxia",
    premise: "用户自己当主角，从杂役弟子开始逆袭。",
    mainCharacterName: "Guo Xu / 主角",
  });
  await createStoryProject({
    rootDir,
    title: "ignored sibling",
    genre: "xianxia",
    premise: "unused",
    mainCharacterName: "Someone Else",
  });
  const linDir = join(projectDir, "characters", "lin-wan-qing");
  await import("node:fs/promises").then(async ({ mkdir, writeFile }) => {
    await mkdir(linDir, { recursive: true });
    await Promise.all([
      writeFile(join(linDir, "profile.json"), JSON.stringify({ id: "lin-wan-qing", name: "林婉清" }, null, 2), "utf-8"),
      writeFile(join(linDir, "core.json"), JSON.stringify({ characterId: "lin-wan-qing", personality: ["precise"] }, null, 2), "utf-8"),
      writeFile(join(linDir, "state.json"), JSON.stringify({ characterId: "lin-wan-qing", emotion: "calm", goal: "assist", lastUpdatedChapter: null }, null, 2), "utf-8"),
    ]);
  });
  return projectDir;
}

async function seedSemanticTimeline(projectDir: string): Promise<void> {
  await writeFile(
    join(projectDir, "timeline", "events.json"),
    `${JSON.stringify([
      {
        id: "ch0001-001",
        chapter: 1,
        summary: "Guo Xu 在账房发现异常。",
        participants: ["guo-xu"],
        effects: {
          semanticSummary: {
            chapter: 1,
            mainEvent: "Guo Xu 在账房发现账本暗页。",
            conflict: "管事威胁 Guo Xu 交出破损信物。",
            discovery: "Guo Xu 发现账本暗页记录外院账目。",
            nextLead: "后墙传来异常响动，黑影暗号仍未解开。",
            mentionedCharacterNames: ["Guo Xu / 主角"],
            locations: ["账房", "外院"],
          },
        },
      },
    ], null, 2)}\n`,
    "utf-8",
  );
}
