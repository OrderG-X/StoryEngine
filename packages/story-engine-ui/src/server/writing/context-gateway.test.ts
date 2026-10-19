// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { cardWrite, runCommand, type CardOp } from "@actalk/story-core";
import {
  buildWriterContext,
  estimateTokens,
  type PreviousChapterContext,
  type PreviousUncommittedDraftContext,
  type StoryContinuityContext,
  type WritingContextPack,
} from "./context-gateway.js";
import { renderFastDraftPromptText } from "./prompt-cache-diagnostics.js";
import { createStoryProject } from "../book/project-store.js";
import type { ArcGoalPool, HookPool, ThreadPool, TimelineEvent } from "../book/types.js";

describe("StoryEngine-NG ContextGateway", () => {
  it("builds an ordered writer context from structured project data（设定走 writing_context_pack，没有老的设定段）", async () => {
    const projectDir = await createFixtureProject();

    const envelope = await buildWriterContext({
      projectDir,
      chapter: 8,
      chapterGoal: "林远和林婉清追查矿藏失踪，并推进组织暗线。",
      maxTimelineEvents: 3,
    });

    expect(envelope.projectId).toMatch(/^story-[a-f0-9]{6}$/u);
    expect(envelope.chapter).toBe(8);
    // L1Window=3, currentChapter=8: L2 covers chapters 1-5 (有内容), L3 为空（总章数≤15）
    // 所以 timeline_earlier_summary 会出现（L2 非空）
    expect(envelope.trace.sectionNames).toEqual([
      "chapter_goal",
      "writing_context_pack",
      "story_calendar",
      "hook_pool",
      "hook_tracking",
      "story_threads",
      "arc_goals",
      "story_continuity",
      "timeline_events",
      "timeline_earlier_summary",
    ]);
    for (const legacy of ["story_core", "world_core", "character_profile", "character_core", "character_state", "world_state"]) {
      expect(envelope.trace.sectionNames).not.toContain(legacy);
    }
    expect(envelope.sections.every((section) => section.cachePolicy === "dynamic")).toBe(true);
    // 没点名：走在场检测（主角恒带 + 方向里点到名字的），trace 里是名字，不是编号
    expect(envelope.trace.selectedCharacters).toEqual(["林远", "林婉清"]);
    expect(envelope.trace.selectedHooks).toEqual(["h-seeded", "h-active"]);
    expect(envelope.trace.selectedTimelineEvents).toEqual(["event-0005", "event-0006", "event-0007"]);
    expect(envelope.trace.totalTokenEstimate).toBeGreaterThan(0);
    expect(envelope.trace.dynamicTokenEstimate).toBe(envelope.trace.totalTokenEstimate);
    expect(envelope.trace.stableTokenEstimate).toBe(0);

    const pack = envelope.sections.find((section) => section.name === "writing_context_pack")?.content as WritingContextPack;
    expect(pack.setting.protagonist?.name).toBe("林远");
    expect(pack.setting.cast.map((brief) => brief.name)).toEqual(["林婉清"]);
    expect(pack.setting.cast[0]?.card).toEqual(["身份：外院执事助手", "说话：简短"]);
  });

  it("没点名时在场检测按上一章正文挑人，方向和上一章都没点到的人不带", async () => {
    const projectDir = await createFixtureProject();
    await writeCards(projectDir, [{ op: "card.create", kind: "character", name: "孙管事" }]);
    await mkdir(join(projectDir, "chapters"), { recursive: true });
    await writeFile(join(projectDir, "chapters", "0007.md"), "# 第7章 · 后墙\n\n林婉清把账本残页塞进林远袖中。\n", "utf-8");

    const envelope = await buildWriterContext({ projectDir, chapter: 8, chapterGoal: "继续追查后墙的响动。" });

    expect(envelope.trace.selectedCharacters).toEqual(["林远", "林婉清"]);
    const pack = envelope.sections.find((section) => section.name === "writing_context_pack")?.content as WritingContextPack;
    expect(pack.setting.otherNames.characters).toEqual(["孙管事"]);
  });

  it("honors explicit character（名字）, hook, and timeline selections", async () => {
    const projectDir = await createFixtureProject();

    const envelope = await buildWriterContext({
      projectDir,
      chapter: 8,
      chapterGoal: "只处理废弃伏笔的复盘。",
      selectedCharacters: ["林婉清"],
      selectedHookIds: ["h-resolved"],
      maxTimelineEvents: 1,
    });

    expect(envelope.trace.selectedCharacters).toEqual(["林婉清"]);
    expect(envelope.trace.selectedHooks).toEqual(["h-resolved"]);
    expect(envelope.trace.selectedTimelineEvents).toEqual(["event-0007"]);
    const pack = envelope.sections.find((section) => section.name === "writing_context_pack")?.content as WritingContextPack;
    // 主角恒带；点名的人整张带上
    expect(pack.setting.protagonist?.name).toBe("林远");
    expect(pack.setting.cast.map((brief) => brief.name)).toEqual(["林婉清"]);
  });

  it("builds a continuity section from recent semantic timeline summaries", async () => {
    const projectDir = await createFixtureProject();

    const envelope = await buildWriterContext({
      projectDir,
      chapter: 8,
      chapterGoal: "承接前情追查账房异动。",
      maxTimelineEvents: 7,
    });
    const continuity = envelope.sections.find((section) => section.name === "story_continuity")
      ?.content as StoryContinuityContext | undefined;

    expect(continuity).toBeDefined();
    expect(continuity?.recentEvents).toEqual([
      "林远在后墙听见异常响动，并察觉账本暗页暴露了外院账目。",
      "林远在库房遭管事克扣月钱，并发现账册暗号指向账房。",
      "林远被同门打压，被迫离开园圃，并发现园圃灵土里藏着账本残页。",
    ]);
    expect(continuity?.openLeads).toEqual([
      expect.stringContaining("后墙"),
      expect.stringContaining("明日"),
      expect.stringContaining("后院"),
    ]);
    expect(continuity?.activeConflicts).toEqual([
      "管事威胁林远交出破损信物。",
      "林远在库房遭管事克扣月钱。",
      "林远被同门打压，被迫离开园圃。",
    ]);
    expect(continuity?.discoveries).toEqual([
      "林远察觉账本暗页暴露了外院账目。",
      "林远发现账册暗号指向账房。",
      "林远发现园圃灵土里藏着账本残页。",
    ]);
    expect(continuity?.recentLocations).toEqual(["账房", "外院", "库房", "园圃", "后院"]);
    expect(continuity?.recentCharacters).toEqual(["林远", "林婉清"]);
    expect(continuity?.carryForwardInstruction).toContain("下一章必须承接最近未解决线索");
    expect(continuity?.carryForwardInstruction).toContain("后墙");
    expect(continuity?.openLeads[0]?.length).toBeLessThanOrEqual(101);
    expect(continuity?.recentEvents).toHaveLength(3);
  });

  it("builds a story_threads section from open lead and intent threads", async () => {
    const projectDir = await createFixtureProject();

    const envelope = await buildWriterContext({
      projectDir,
      chapter: 8,
      chapterGoal: "承接未完成线索和行动意图。",
    });
    const storyThreads = envelope.sections.find((section) => section.name === "story_threads")?.content as {
      openLeads: Array<{ title: string; lastTouchedChapter: number }>;
      openIntents: Array<{ title: string; lastTouchedChapter: number }>;
      staleThreadWarnings: Array<{ id: string; chaptersSinceTouched: number }>;
      threadCarryForwardInstruction: string;
    } | undefined;

    expect(storyThreads).toBeDefined();
    expect(storyThreads?.openLeads[0]).toMatchObject({
      title: "后墙异常响动",
      lastTouchedChapter: 7,
    });
    expect(storyThreads?.openIntents[0]).toMatchObject({
      title: "林远夜探账房",
      lastTouchedChapter: 6,
    });
    expect(storyThreads?.staleThreadWarnings).toEqual([
      expect.objectContaining({ id: "lead-old", chaptersSinceTouched: 5 }),
    ]);
    expect(storyThreads?.threadCarryForwardInstruction).toContain("未完成线索/意图");
    expect(storyThreads?.threadCarryForwardInstruction).toContain("后墙异常响动");
  });

  it("builds an arc_goals section from active arc goals", async () => {
    const projectDir = await createFixtureProject();

    const envelope = await buildWriterContext({
      projectDir,
      chapter: 8,
      chapterGoal: "继续推进小卷目标。",
    });
    const arcGoals = envelope.sections.find((section) => section.name === "arc_goals")?.content as {
      activeGoals: Array<{ title: string; lastTouchedChapter: number }>;
      recentlyTouchedGoals: Array<{ title: string }>;
      staleGoalWarnings: Array<{ id: string; chaptersSinceTouched: number }>;
      arcCarryForwardInstruction: string;
    } | undefined;

    expect(arcGoals).toBeDefined();
    expect(arcGoals?.activeGoals[0]).toMatchObject({
      title: "查清资源账目",
      lastTouchedChapter: 7,
    });
    expect(arcGoals?.activeGoals.map((goal) => goal.title)).toContain("查明破损信物用途");
    // 最近碰过的只给 activeGoals 里没有的（2026-10-10：原来同一批目标给两遍）
    const activeTitles = new Set(arcGoals?.activeGoals.map((goal) => goal.title));
    expect(arcGoals?.recentlyTouchedGoals.some((goal) => activeTitles.has(goal.title))).toBe(false);
    expect(arcGoals?.staleGoalWarnings).toEqual([
      expect.objectContaining({ id: "arc-stale", chaptersSinceTouched: 6 }),
    ]);
    expect(arcGoals?.arcCarryForwardInstruction).toContain("当前小卷目标");
    expect(arcGoals?.arcCarryForwardInstruction).toContain("查清资源账目");
  });

  it("falls back to TimelineEvent.summary when semanticSummary is missing", async () => {
    const projectDir = await createFixtureProject();
    const events: TimelineEvent[] = [
      {
        id: "manual-fallback",
        chapter: 9,
        summary: "林远在大门外收到一封没有署名的警告信。",
        participants: ["林远"],
      },
    ];
    await writeJson(join(projectDir, "timeline", "events.json"), events);

    const envelope = await buildWriterContext({
      projectDir,
      chapter: 10,
      chapterGoal: "承接警告信。",
      maxTimelineEvents: 5,
    });
    const continuity = envelope.sections.find((section) => section.name === "story_continuity")
      ?.content as StoryContinuityContext | undefined;

    expect(continuity?.recentEvents).toEqual(["林远在大门外收到一封没有署名的警告信。"]);
    expect(continuity?.openLeads).toEqual([]);
    expect(continuity?.carryForwardInstruction).toContain("林远在大门外收到一封没有署名的警告信。");
  });

  it("does not invent carry-forward pressure when there is no continuity", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "story-engine-empty-continuity-"));
    const { projectDir } = await createStoryProject({
      rootDir,
      title: "空前情",
      genre: "xianxia",
      logline: "第一章还没有前情。",
      protagonistName: "林远",
    });

    const envelope = await buildWriterContext({
      projectDir,
      chapter: 1,
      chapterGoal: "开局。",
    });
    const continuity = envelope.sections.find((section) => section.name === "story_continuity")
      ?.content as StoryContinuityContext | undefined;

    expect(continuity).toMatchObject({
      recentEvents: [],
      openLeads: [],
      activeConflicts: [],
      discoveries: [],
      recentLocations: [],
      recentCharacters: [],
      carryForwardInstruction: "暂无前情承接要求。",
    });
    expect(continuity?.carryForwardInstruction).not.toContain("最近事件");
    expect(continuity?.carryForwardInstruction).not.toContain("上一章后果");
  });

  it("injects previous uncommitted draft context for the next chapter", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "story-engine-uncommitted-draft-context-"));
    const { projectDir } = await createStoryProject({
      rootDir,
      title: "海州账册",
      genre: "urban",
      logline: "审计员林澈追查账册篡改。",
      protagonistName: "林澈",
    });
    await mkdir(join(projectDir, "drafts", "fast"), { recursive: true });
    await writeFile(
      join(projectDir, "drafts", "fast", "chapter-0001.md"),
      "# 第一章 · 雨夜账册\n\n林澈在海州审计办公室发现蓝色账册被篡改，他决定去档案室核对附件。\n",
      "utf-8",
    );

    const envelope = await buildWriterContext({
      projectDir,
      chapter: 2,
      chapterGoal: "承接账册篡改，去档案室继续查。",
    });
    const previousDraft = envelope.sections.find((section) => section.name === "previous_uncommitted_draft")
      ?.content as PreviousUncommittedDraftContext | undefined;
    const prompt = renderFastDraftPromptText(envelope);

    expect(previousDraft).toMatchObject({
      kind: "working_draft_context",
      status: "previous_uncommitted_draft",
      chapter: 1,
      title: "第一章 · 雨夜账册",
    });
    expect(previousDraft?.excerpt).toContain("林澈在海州审计办公室");
    expect(previousDraft?.continuityInstruction).toContain("尚未正式入库");
    expect(prompt).toContain("## previous_uncommitted_draft");
    expect(prompt).toContain("preserve protagonist identity");
  });

  it("does not inject previous draft context once the previous chapter is committed", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "story-engine-committed-draft-context-"));
    const { projectDir } = await createStoryProject({
      rootDir,
      title: "海州账册",
      genre: "urban",
      logline: "审计员林澈追查账册篡改。",
      protagonistName: "林澈",
    });
    await mkdir(join(projectDir, "drafts", "fast"), { recursive: true });
    await mkdir(join(projectDir, "chapters"), { recursive: true });
    await writeFile(join(projectDir, "drafts", "fast", "chapter-0001.md"), "# 第一章 · 草稿\n\n工作稿。", "utf-8");
    await writeFile(join(projectDir, "chapters", "0001.md"), "# 第一章 · 正式\n\n正式正文。", "utf-8");

    const envelope = await buildWriterContext({
      projectDir,
      chapter: 2,
      chapterGoal: "继续第二章。",
    });

    expect(envelope.sections.some((section) => section.name === "previous_uncommitted_draft")).toBe(false);
  });

  // 2026-10-08 十章验收：上一章定稿后写手只剩 3 条各 100 字的摘要，物件状态、人物位置逐章漂移。
  it("gives the writer the committed previous chapter's verbatim text", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "story-engine-previous-chapter-"));
    const { projectDir } = await createStoryProject({
      rootDir,
      title: "海州账册",
      genre: "urban",
      logline: "审计员林澈追查账册篡改。",
      protagonistName: "林澈",
    });
    await mkdir(join(projectDir, "chapters"), { recursive: true });
    await writeFile(
      join(projectDir, "chapters", "0001.md"),
      "# 第1章 · 雨夜账册\n\n林澈把蓝色账册锁进抽屉，钥匙揣进左边口袋。\n\n他关灯出门，雨还没停。\n",
      "utf-8",
    );

    const envelope = await buildWriterContext({ projectDir, chapter: 2, chapterGoal: "继续第 2 章。" });
    const previous = envelope.sections.find((section) => section.name === "previous_chapter")
      ?.content as PreviousChapterContext | undefined;
    const prompt = renderFastDraftPromptText(envelope);

    expect(previous).toMatchObject({ kind: "previous_chapter_text", status: "committed", chapter: 1, title: "第1章 · 雨夜账册", truncated: false });
    expect(previous?.text).toContain("钥匙揣进左边口袋");
    expect(previous?.text).toContain("他关灯出门，雨还没停。");
    expect(previous?.continuityInstruction).toContain("一律以这段原文为准");
    expect(prompt).toContain("## previous_chapter");
    expect(prompt).toContain("never re-discover or redo");
  });

  // R7.7·报告第 5 节：拟标题防重名——已有各章标题（定稿优先、工作稿兜底）进 chapter_titles 段，不含本章。
  it("lists existing chapter titles for the writer to avoid duplicates（R7.7）", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "story-engine-chapter-titles-"));
    const { projectDir } = await createStoryProject({
      rootDir,
      title: "旧钟楼",
      genre: "urban",
      logline: "修表匠追查停摆的钟。",
      protagonistName: "陈拾",
    });
    await Promise.all([
      mkdir(join(projectDir, "chapters"), { recursive: true }),
      mkdir(join(projectDir, "drafts", "fast"), { recursive: true }),
    ]);
    await writeFile(join(projectDir, "chapters", "0001.md"), "# 第1章 · 停摆\n\u6b63\u6587\u4e00。\n", "utf-8");
    // 第 2 章只有工作稿（没定稿）：标题也带上。
    await writeFile(join(projectDir, "drafts", "fast", "chapter-0002.md"), "# 第2章 · 铁丝\n\u6b63\u6587\u4e8c。\n", "utf-8");
    // 第 3 章定稿与工作稿标题不同：以定稿为准。
    await writeFile(join(projectDir, "chapters", "0003.md"), "# 第3章 · 正稿题\n\u6b63\u6587\u4e09。\n", "utf-8");
    await writeFile(join(projectDir, "drafts", "fast", "chapter-0003.md"), "# 第3章 · 旧稿题\n\u6b63\u6587\u4e09。\n", "utf-8");
    // 本章（第 4 章）自己的工作稿不算「已有标题」。
    await writeFile(join(projectDir, "drafts", "fast", "chapter-0004.md"), "# 第4章 · 我自己\n\u6b63\u6587\u56db。\n", "utf-8");

    const envelope = await buildWriterContext({ projectDir, chapter: 4, chapterGoal: "继续写。" });
    const titlesSection = envelope.sections.find((section) => section.name === "chapter_titles")?.content as
      | { instruction: string; titles: readonly { chapter: number; title: string }[] }
      | undefined;
    expect(titlesSection?.titles).toEqual([
      { chapter: 1, title: "第1章 · 停摆" },
      { chapter: 2, title: "第2章 · 铁丝" },
      { chapter: 3, title: "第3章 · 正稿题" },
    ]);
    const prompt = renderFastDraftPromptText(envelope);
    expect(prompt).toContain("## chapter_titles");
    expect(prompt).toContain("第2章 · 铁丝");
    expect(prompt).not.toContain("我自己");
    expect(prompt).toContain("不要起与之重复的标题");
  });

  it("没有任何已有章节文件 → 不出 chapter_titles 段（新书写第 1 章不背空清单）", async () => {
    const projectDir = await createFixtureProject();
    const envelope = await buildWriterContext({ projectDir, chapter: 1, chapterGoal: "开局。" });
    expect(envelope.sections.some((section) => section.name === "chapter_titles")).toBe(false);
    const prompt = renderFastDraftPromptText(envelope);
    expect(prompt).not.toContain("## chapter_titles");
  });

  it("gives only the ending of a long previous chapter, cut at a paragraph boundary", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "story-engine-previous-chapter-long-"));
    const { projectDir } = await createStoryProject({
      rootDir,
      title: "海州账册",
      genre: "urban",
      logline: "审计员林澈追查账册篡改。",
      protagonistName: "林澈",
    });
    await mkdir(join(projectDir, "chapters"), { recursive: true });
    const filler = Array.from({ length: 250 }, (_, i) => `第${i}段：林澈翻着账册，一页一页核对附件上的数字，窗外雨声不断。`).join("\n\n");
    await writeFile(join(projectDir, "chapters", "0001.md"), `# 第1章 · 长章\n\n开头一句只在最前面。\n\n${filler}\n\n结尾：他把账册锁进抽屉。\n`, "utf-8");

    const envelope = await buildWriterContext({ projectDir, chapter: 2, chapterGoal: "继续第 2 章。" });
    const previous = envelope.sections.find((section) => section.name === "previous_chapter")
      ?.content as PreviousChapterContext | undefined;

    expect(previous?.truncated).toBe(true);
    expect(previous?.text.startsWith("（前略）\n第")).toBe(true);
    expect(previous?.text).toContain("结尾：他把账册锁进抽屉。");
    expect(previous?.text).not.toContain("开头一句只在最前面");
  });

  it("gives the ending (not the opening) of a long uncommitted previous draft", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "story-engine-previous-draft-tail-"));
    const { projectDir } = await createStoryProject({
      rootDir,
      title: "海州账册",
      genre: "urban",
      logline: "审计员林澈追查账册篡改。",
      protagonistName: "林澈",
    });
    await mkdir(join(projectDir, "drafts", "fast"), { recursive: true });
    const filler = Array.from({ length: 250 }, (_, i) => `第${i}段：林澈翻着账册，一页一页核对附件上的数字，窗外雨声不断。`).join("\n\n");
    await writeFile(join(projectDir, "drafts", "fast", "chapter-0001.md"), `# 第1章 · 草稿\n\n开头一句。\n\n${filler}\n\n草稿结尾：他推门进了档案室。\n`, "utf-8");

    const envelope = await buildWriterContext({ projectDir, chapter: 2, chapterGoal: "继续第 2 章。" });
    const previousDraft = envelope.sections.find((section) => section.name === "previous_uncommitted_draft")
      ?.content as PreviousUncommittedDraftContext | undefined;

    expect(previousDraft?.excerpt).toContain("草稿结尾：他推门进了档案室。");
    expect(previousDraft?.excerpt).not.toContain("开头一句。");
    expect(envelope.sections.some((section) => section.name === "previous_chapter")).toBe(false);
  });

  it("never emits an apocalypse_progression section regardless of timeline summary wording", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "story-engine-no-genre-progression-"));
    const { projectDir } = await createStoryProject({
      rootDir,
      title: "旧城区求生",
      genre: "apocalypse",
      logline: "林澈被困旧城区。",
      protagonistName: "林澈",
    });
    await writeJson(join(projectDir, "timeline", "events.json"), [
      {
        id: "event-0003",
        chapter: 3,
        summary: "林澈修好无线电后听见异常信号。",
        participants: ["林澈"],
        effects: {
          semanticSummary: {
            mainEvent: "林澈修好无线电后听见异常信号。",
            mentionedCharacterNames: ["林澈"],
            locations: ["公寓楼"],
          },
        },
      },
    ] satisfies TimelineEvent[]);

    const envelope = await buildWriterContext({
      projectDir,
      chapter: 4,
      chapterGoal: "继续推进无线电异常。",
    });

    // Pin: the genre-progression engine is removed, so no project ever gets an
    // apocalypse_progression context section, even for an "apocalypse" genre.
    expect(envelope.trace.sectionNames).not.toContain("apocalypse_progression");
  });

  it("estimates tokens from serialized context content", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens({ a: "12345678" })).toBeGreaterThan(1);
  });

  it("early active hook survives selectRelevant and appears in activeHooks (hook not-sinking)", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "story-engine-hook-nosink-"));
    const { projectDir } = await createStoryProject({
      rootDir,
      title: "古老伏笔测试",
      genre: "xianxia",
      logline: "测试早期伏笔不沉底。",
      protagonistName: "林远",
    });

    // 1 early hook (ch2) + 6 recent hooks (ch44-49)
    const hooks: HookPool = {
      hooks: [
        {
          id: "h-early",
          title: "早期古老伏笔",
          description: "第2章的伏笔一直没有解决",
          status: "active",
          relatedCharacters: [],
          firstSeenChapter: 2,
          lastTouchedChapter: 2,
        },
        {
          id: "h-r1",
          title: "近章钩1",
          description: "近章伏笔1",
          status: "active",
          relatedCharacters: [],
          lastTouchedChapter: 49,
        },
        {
          id: "h-r2",
          title: "近章钩2",
          description: "近章伏笔2",
          status: "active",
          relatedCharacters: [],
          lastTouchedChapter: 48,
        },
        {
          id: "h-r3",
          title: "近章钩3",
          description: "近章伏笔3",
          status: "active",
          relatedCharacters: [],
          lastTouchedChapter: 47,
        },
        {
          id: "h-r4",
          title: "近章钩4",
          description: "近章伏笔4",
          status: "active",
          relatedCharacters: [],
          lastTouchedChapter: 46,
        },
        {
          id: "h-r5",
          title: "近章钩5",
          description: "近章伏笔5",
          status: "active",
          relatedCharacters: [],
          lastTouchedChapter: 45,
        },
        {
          id: "h-r6",
          title: "近章钩6",
          description: "近章伏笔6",
          status: "active",
          relatedCharacters: [],
          lastTouchedChapter: 44,
        },
      ],
    };
    await writeJson(join(projectDir, "story", "hooks.json"), hooks);

    const envelope = await buildWriterContext({ projectDir, chapter: 50, chapterGoal: "继续推进剧情。" });
    const hookTracking = envelope.sections.find((s) => s.name === "hook_tracking")?.content as
      | { activeHooks: Array<{ id: string }> }
      | undefined;

    // With selectRelevant + ancientBonus, h-early (chapter 50 - chapter 2 = 48 >= 10 threshold) gets ancientBonus
    // so it should survive in the top 8
    const activeHookIds = hookTracking?.activeHooks.map((h) => h.id) ?? [];
    expect(activeHookIds).toContain("h-early");
  });

  it("early open lead survives selectRelevant and appears in openLeads (thread not-sinking)", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "story-engine-thread-nosink-"));
    const { projectDir } = await createStoryProject({
      rootDir,
      title: "古老线索测试",
      genre: "xianxia",
      logline: "测试早期线索不沉底。",
      protagonistName: "林远",
    });

    // 1 early lead (ch2) + 6 recent leads (ch44-49)
    const threads: import("../book/types.js").ThreadPool = {
      threads: [
        {
          id: "lead-early",
          type: "lead",
          title: "早期古老线索",
          status: "open",
          firstSeenChapter: 2,
          lastTouchedChapter: 2,
          evidence: ["第2章出现的线索一直没有解决。"],
          relatedCharacters: [],
          relatedLocations: [],
        },
        {
          id: "lead-r1",
          type: "lead",
          title: "近章线索1",
          status: "open",
          firstSeenChapter: 45,
          lastTouchedChapter: 49,
          evidence: ["近章线索1。"],
          relatedCharacters: [],
          relatedLocations: [],
        },
        {
          id: "lead-r2",
          type: "lead",
          title: "近章线索2",
          status: "open",
          firstSeenChapter: 44,
          lastTouchedChapter: 48,
          evidence: ["近章线索2。"],
          relatedCharacters: [],
          relatedLocations: [],
        },
        {
          id: "lead-r3",
          type: "lead",
          title: "近章线索3",
          status: "open",
          firstSeenChapter: 43,
          lastTouchedChapter: 47,
          evidence: ["近章线索3。"],
          relatedCharacters: [],
          relatedLocations: [],
        },
        {
          id: "lead-r4",
          type: "lead",
          title: "近章线索4",
          status: "open",
          firstSeenChapter: 42,
          lastTouchedChapter: 46,
          evidence: ["近章线索4。"],
          relatedCharacters: [],
          relatedLocations: [],
        },
        {
          id: "lead-r5",
          type: "lead",
          title: "近章线索5",
          status: "open",
          firstSeenChapter: 41,
          lastTouchedChapter: 45,
          evidence: ["近章线索5。"],
          relatedCharacters: [],
          relatedLocations: [],
        },
        {
          id: "lead-r6",
          type: "lead",
          title: "近章线索6",
          status: "open",
          firstSeenChapter: 40,
          lastTouchedChapter: 44,
          evidence: ["近章线索6。"],
          relatedCharacters: [],
          relatedLocations: [],
        },
      ],
    };
    await writeJson(join(projectDir, "story", "threads.json"), threads);

    const envelope = await buildWriterContext({ projectDir, chapter: 50, chapterGoal: "继续推进剧情。" });
    const storyThreads = envelope.sections.find((s) => s.name === "story_threads")?.content as
      | { openLeads: Array<{ id: string }> }
      | undefined;

    // With selectRelevant + ancientBonus, lead-early (50 - 2 = 48 >= 10) gets ancientBonus
    // so it should survive in openLeads despite 6 more recent leads
    const openLeadIds = storyThreads?.openLeads.map((l) => l.id) ?? [];
    expect(openLeadIds).toContain("lead-early");
  });

  it("thread matching arcGoal keywords ranks above irrelevant recent thread", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "story-engine-thread-relevance-"));
    const { projectDir } = await createStoryProject({
      rootDir,
      title: "关键词排序测试",
      genre: "xianxia",
      logline: "测试关键词相关性提升排名。",
      protagonistName: "林远",
    });

    // early thread (ch2) whose text matches arcGoal keywords ("账房", "账目")
    // vs very recent thread (ch49) with no keyword match
    const threads: import("../book/types.js").ThreadPool = {
      threads: [
        {
          id: "lead-early-relevant",
          type: "lead",
          title: "账房账目查证线索",
          status: "open",
          firstSeenChapter: 2,
          lastTouchedChapter: 2,
          evidence: ["后墙发现账册。"],
          relatedCharacters: [],
          relatedLocations: ["账房"],
        },
        {
          id: "lead-recent-irrelevant",
          type: "lead",
          title: "毫不相关的新线索",
          status: "open",
          firstSeenChapter: 49,
          lastTouchedChapter: 49,
          evidence: ["完全无关的最新线索。"],
          relatedCharacters: [],
          relatedLocations: [],
        },
      ],
    };
    await writeJson(join(projectDir, "story", "threads.json"), threads);

    const arcGoals: ArcGoalPool = {
      goals: [
        {
          id: "arc-ledger",
          title: "查清外院账房账目",
          status: "active",
          scope: "main_arc",
          firstSeenChapter: 1,
          lastTouchedChapter: 48,
          evidence: ["外院账房存在账目。"],
          relatedLocations: ["账房", "外院"],
          relatedCharacters: ["林远"],
        },
      ],
    };
    await writeJson(join(projectDir, "story", "arc-goals.json"), arcGoals);

    const envelope = await buildWriterContext({ projectDir, chapter: 50, chapterGoal: "追查外院账目。" });
    const storyThreads = envelope.sections.find((s) => s.name === "story_threads")?.content as
      | { openLeads: Array<{ id: string }> }
      | undefined;

    const openLeadIds = storyThreads?.openLeads.map((l) => l.id) ?? [];
    // The early+relevant thread should rank above the recent but irrelevant thread
    expect(openLeadIds.indexOf("lead-early-relevant")).toBeLessThan(openLeadIds.indexOf("lead-recent-irrelevant"));
  });

  // P2 铁律④（永不静默）：损坏的 timeline/events.json 此前双重 catch 后静默降级为 []，
  // 模型拿到「空历史」却毫无知觉，会把已写过的章节当没发生过。降级照做（不炸出稿），
  // 但失败原因必须以 read_failures 段进上下文，让模型知道自己在盲写并如实转达用户。
  it("corrupt timeline/events.json degrades to empty but surfaces a read_failures section", async () => {
    const projectDir = await createFixtureProject();
    await writeFile(join(projectDir, "timeline", "events.json"), "{not-json", "utf-8");

    const envelope = await buildWriterContext({
      projectDir,
      chapter: 8,
      chapterGoal: "追查矿藏失踪。",
      maxTimelineEvents: 3,
    });

    const failures = envelope.sections.find((s) => s.name === "read_failures")?.content as
      | { failures: readonly string[] }
      | undefined;
    expect(failures?.failures.length).toBeGreaterThan(0);
    expect(failures!.failures.join(" ")).toContain("时间线事件");
    // 健康项目里这一段根本不存在——只有坏读盘才出现，不污染正常上下文
  });

  it("healthy projects never carry a read_failures section", async () => {
    const projectDir = await createFixtureProject();
    const envelope = await buildWriterContext({
      projectDir,
      chapter: 8,
      chapterGoal: "追查矿藏失踪。",
      maxTimelineEvents: 3,
    });
    expect(envelope.sections.some((s) => s.name === "read_failures")).toBe(false);
  });

  // 设定卡坏了：按空设定降级照常出上下文（不炸出稿），原因如实进 read_failures 段、只记一次、不带本地绝对路径。
  it("corrupt ledger/cards.json degrades to an empty setting and surfaces once in read_failures", async () => {
    const projectDir = await createFixtureProject();
    await writeFile(join(projectDir, "ledger", "cards.json"), "{not-json", "utf-8");

    const envelope = await buildWriterContext({
      projectDir,
      chapter: 8,
      chapterGoal: "林远追查矿藏失踪。",
      maxTimelineEvents: 3,
    });

    const pack = envelope.sections.find((section) => section.name === "writing_context_pack")?.content as WritingContextPack;
    expect(pack.setting.protagonist).toBeUndefined();
    expect(envelope.trace.selectedCharacters).toEqual([]);
    // 账（伏笔、线索）照常带
    expect(envelope.trace.selectedHooks).toEqual(["h-seeded", "h-active"]);
    const failures = (envelope.sections.find((s) => s.name === "read_failures")?.content as { failures: readonly string[] } | undefined)?.failures ?? [];
    expect(failures.filter((line) => line.includes("设定本读取失败"))).toHaveLength(1);
    expect(failures.join(" ")).not.toMatch(/\/Users|\/var|\/private|\/tmp|\/home/u);
    expect(renderFastDraftPromptText(envelope)).toContain("设定本读取失败");
  });
});

async function writeCards(projectDir: string, ops: readonly CardOp[]): Promise<void> {
  const outcome = await runCommand(projectDir, cardWrite, { ops }, { caller: "author", idempotencyKey: `t-${randomUUID()}` });
  if (!outcome.ok) throw new Error(outcome.message);
}

async function createFixtureProject(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "story-engine-context-"));
  const { projectDir } = await createStoryProject({
    rootDir,
    title: "我的修仙副本",
    genre: "xianxia",
    logline: "林远从杂役弟子开始逆袭。",
    protagonistName: "林远",
  });
  await writeCards(projectDir, [
    { op: "card.create", kind: "character", name: "林婉清", fields: [{ label: "身份", value: "外院执事助手" }, { label: "说话", value: "简短" }] },
  ]);
  await mkdir(join(projectDir, "story"), { recursive: true });
  await mkdir(join(projectDir, "timeline"), { recursive: true });
  const hooks: HookPool = {
    hooks: [
      {
        id: "h-seeded",
        title: "失踪矿藏",
        description: "组织账册里少了一批矿藏。",
        status: "seeded",
        relatedCharacters: ["林远"],
      },
      {
        id: "h-active",
        title: "掌门密令",
        description: "掌门暗中试探主角。",
        status: "active",
        relatedCharacters: ["林远", "林婉清"],
      },
      {
        id: "h-resolved",
        title: "旧账误会",
        description: "旧账疑点已被解释。",
        status: "resolved",
        relatedCharacters: ["林婉清"],
      },
      {
        id: "h-abandoned",
        title: "废弃支线",
        description: "不再推进的假线索。",
        status: "abandoned",
        relatedCharacters: [],
      },
    ],
  };
  await writeJson(join(projectDir, "story", "hooks.json"), hooks);
  const threads: ThreadPool = {
    threads: [
      {
        id: "lead-wall",
        type: "lead",
        title: "后墙异常响动",
        status: "open",
        firstSeenChapter: 5,
        lastTouchedChapter: 7,
        evidence: ["后墙传来异常响动。"],
        nextActionHint: "继续查后墙异常响动。",
        relatedCharacters: ["林远"],
        relatedLocations: ["账房"],
      },
      {
        id: "intent-night",
        type: "intent",
        title: "林远夜探账房",
        status: "open",
        firstSeenChapter: 5,
        lastTouchedChapter: 6,
        evidence: ["林远打算夜探账房。"],
        nextActionHint: "安排夜探账房。",
        relatedCharacters: ["林远"],
        relatedLocations: ["账房"],
      },
      {
        id: "lead-old",
        type: "lead",
        title: "另一页账本残页被带走",
        status: "open",
        firstSeenChapter: 1,
        lastTouchedChapter: 3,
        evidence: ["另一页账本残页被带走。"],
        relatedCharacters: ["林远"],
        relatedLocations: ["后院"],
      },
    ],
  };
  await writeJson(join(projectDir, "story", "threads.json"), threads);
  const arcGoals: ArcGoalPool = {
    goals: [
      {
        id: "arc-ledger",
        title: "查清资源账目",
        status: "touched",
        scope: "main_arc",
        firstSeenChapter: 1,
        lastTouchedChapter: 7,
        targetChapters: 10,
        evidence: ["林远察觉账本暗页暴露了外院账目。"],
        relatedHooks: ["h-active"],
        relatedThreads: ["lead-wall"],
        relatedCharacters: ["林远"],
        relatedLocations: ["账房", "外院"],
        nextActionHint: "继续追查外院账目。",
      },
      {
        id: "arc-token",
        title: "查明破损信物用途",
        status: "active",
        scope: "mini_arc",
        firstSeenChapter: 5,
        lastTouchedChapter: 6,
        targetChapters: 5,
        evidence: ["管事威胁林远交出破损信物。"],
        relatedCharacters: ["林远"],
        relatedLocations: ["账房"],
      },
      {
        id: "arc-stale",
        title: "摆脱外院管事打压",
        status: "active",
        scope: "mini_arc",
        firstSeenChapter: 1,
        lastTouchedChapter: 2,
        evidence: ["林远被管事打压。"],
        relatedCharacters: ["林远"],
        relatedLocations: ["外院"],
      },
    ],
  };
  await writeJson(join(projectDir, "story", "arc-goals.json"), arcGoals);
  const events: TimelineEvent[] = Array.from({ length: 7 }, (_, index) => {
    const chapter = index + 1;
    return {
      id: `event-${String(chapter).padStart(4, "0")}`,
      chapter,
      summary: `第${chapter}章事件`,
      participants: chapter % 2 === 0 ? ["林婉清"] : ["林远"],
    };
  });
  events[4] = {
    ...events[4]!,
    effects: {
      semanticSummary: {
        chapter: 5,
        protagonist: "林远",
        mainEvent: "林远被同门打压，被迫离开园圃，并发现园圃灵土里藏着账本残页。",
        conflict: "林远被同门打压，被迫离开园圃。",
        discovery: "林远发现园圃灵土里藏着账本残页。",
        nextLead: "后院有人影带走账本残页，留下新的线索。",
        mentionedCharacterNames: ["林远"],
        locations: ["园圃", "后院", "园圃"],
      },
    },
  };
  events[5] = {
    ...events[5]!,
    effects: {
      semanticSummary: {
        chapter: 6,
        protagonist: "林远",
        mainEvent: "林远在库房遭管事克扣月钱，并发现账册暗号指向账房。",
        conflict: "林远在库房遭管事克扣月钱。",
        discovery: "林远发现账册暗号指向账房。",
        nextLead: "明日清晨库房会有人转移账册，林远必须提前守住账房。",
        mentionedCharacterNames: ["林远", "林婉清"],
        locations: ["库房", "账房", "外院"],
      },
    },
  };
  events[6] = {
    ...events[6]!,
    effects: {
      semanticSummary: {
        chapter: 7,
        protagonist: "林远",
        mainEvent: "林远在后墙听见异常响动，并察觉账本暗页暴露了外院账目。",
        conflict: "管事威胁林远交出破损信物。",
        discovery: "林远察觉账本暗页暴露了外院账目。",
        nextLead: "后墙传来异常响动，门后黑影似乎掌握了更完整的账本线索，这条线索非常长很长很长很长很长很长很长很长很长很长很长。",
        mentionedCharacterNames: ["林远"],
        locations: ["账房", "外院"],
      },
    },
  };
  await writeJson(join(projectDir, "timeline", "events.json"), events);
  return projectDir;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}
