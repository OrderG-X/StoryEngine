// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { cardWrite, chapterCommit, runCommand, type CardOp } from "@actalk/story-core";
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
import { seedChapters, seededThreadId, seedThreads, type SeedChapter, type SeedThread } from "../book/ledger-test-helpers.js";

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
      "chapter_titles",
      "previous_chapter",
      "writing_context_pack",
      "story_calendar",
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
    expect(envelope.trace.selectedTimelineEvents).toEqual(["ch0005-001", "ch0006-001", "ch0007-001"]);
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

  it("honors explicit character（名字） and timeline selections", async () => {
    const projectDir = await createFixtureProject();

    const envelope = await buildWriterContext({
      projectDir,
      chapter: 8,
      chapterGoal: "只处理废弃伏笔的复盘。",
      selectedCharacters: ["林婉清"],
      maxTimelineEvents: 1,
    });

    expect(envelope.trace.selectedCharacters).toEqual(["林婉清"]);
    expect(envelope.trace.selectedTimelineEvents).toEqual(["ch0007-001"]);
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
    // 账里没有「下一步线索」「冲突」「地点」：不编。
    expect(continuity?.openLeads).toEqual([]);
    expect(continuity?.activeConflicts).toEqual([]);
    // 本章收掉的悬念 = 揭开的事。
    expect(continuity?.discoveries).toEqual([
      "林远察觉账本暗页暴露了外院账目。",
      "林远发现账册暗号指向账房。",
      "林远发现园圃灵土里藏着账本残页。",
    ]);
    expect(continuity?.recentLocations).toEqual([]);
    expect(continuity?.recentCharacters).toEqual(["林远", "林婉清"]);
    expect(continuity?.carryForwardInstruction).toContain("下一章必须承接最近未解决线索");
    expect(continuity?.carryForwardInstruction).toContain("后墙");
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
    expect(storyThreads?.openLeads).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "后墙异常响动", lastTouchedChapter: 7 }),
      expect.objectContaining({ title: "另一页账本残页被带走", lastTouchedChapter: 3 }),
    ]));
    // 收了的悬念不进开着的线索。
    expect(storyThreads?.openLeads.map((lead) => lead.title)).not.toContain("园圃灵土里有什么");
    expect(storyThreads?.openIntents[0]).toMatchObject({
      title: "林远夜探账房",
      lastTouchedChapter: 6,
    });
    expect(storyThreads?.staleThreadWarnings).toEqual([
      expect.objectContaining({ id: seededThreadId(projectDir, "lead-old"), chaptersSinceTouched: 5 }),
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
      expect.objectContaining({ id: seededThreadId(projectDir, "arc-stale"), chaptersSinceTouched: 6 }),
    ]);
    expect(arcGoals?.arcCarryForwardInstruction).toContain("当前小卷目标");
    expect(arcGoals?.arcCarryForwardInstruction).toContain("查清资源账目");
  });

  it("前面只有一章、只记了提要：前情照这句提要承接，不编线索", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "story-engine-summary-only-"));
    const { projectDir } = await createStoryProject({ rootDir, title: "警告信", genre: "xianxia", logline: "一封警告信。", protagonistName: "林远" });
    await seedChapters(projectDir, [{ chapter: 9, entries: [{ kind: "summary", text: "林远在大门外收到一封没有署名的警告信。" }] }]);

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

  it("前面有章账待记：单列一段说清那几章账里没有、以正文为准（预算挤不掉）；故事日历说不知道（P2b）", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "story-engine-ledger-pending-"));
    const { projectDir } = await createStoryProject({ rootDir, title: "渡口", protagonistName: "林远" });
    const outcome = await runCommand(projectDir, chapterCommit, {
      chapter: 1,
      text: "# 第1章\n\n林远在渡口等船。",
      entries: [],
      ledger: { status: "pending", reasonCodes: ["keeper_failed"] },
    }, { caller: "author", idempotencyKey: randomUUID() });
    expect(outcome.ok).toBe(true);

    const envelope = await buildWriterContext({ projectDir, chapter: 2, chapterGoal: "船来了。", maxTimelineEvents: 5 });
    const pending = envelope.sections.find((section) => section.name === "ledger_pending")?.content as { chapters: number[]; note: string } | undefined;
    expect(pending?.chapters).toEqual([1]);
    expect(pending?.note).toContain("第 1 章的账还没记上");
    expect(envelope.sections.find((section) => section.name === "story_calendar")?.content).toEqual({ currentStoryDay: "不知道（第 1 章：这章的账还没记上）" });
    // 最近那章账待记：承接它的正文，不拿「梗概给不出」当要推进的事。
    const continuity = envelope.sections.find((section) => section.name === "story_continuity")?.content as { recentEvents: string[]; carryForwardInstruction: string } | undefined;
    expect(continuity?.recentEvents).toEqual(["第 1 章：这章的账还没记上，梗概给不出"]);
    expect(continuity?.carryForwardInstruction).toContain("优先推进：第 1 章正文结尾接着的事（那章的账还没记上，以正文为准）。");

    // 没有账待记的章：没有这一段。
    const plain = await buildWriterContext({ projectDir: await createFixtureProject(), chapter: 8, chapterGoal: "推进。", maxTimelineEvents: 3 });
    expect(plain.trace.sectionNames).not.toContain("ledger_pending");
  });

  it("没记全、账待记的章不当成什么都没发生：单列一段如实说，线索不算闲置（P2b 出口复核第 2、3 条）", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "story-engine-ledger-partial-"));
    const { projectDir } = await createStoryProject({ rootDir, title: "渡口", protagonistName: "林远" });
    const commit = async (chapter: number, text: string, entries: unknown[], ledger?: unknown) => {
      const outcome = await runCommand(projectDir, chapterCommit, { chapter, text, entries, ...(ledger ? { ledger } : {}) } as never, { caller: "author", idempotencyKey: randomUUID() });
      expect(outcome.ok).toBe(true);
    };
    await commit(1, "# 第1章\n\n林远在渡口捡到一封信。", [
      { kind: "day", review: "author", day: 1 },
      { kind: "thread", review: "auto", op: "open", type: "question", title: "信是谁写的", note: "捡到一封信", quote: "林远在渡口捡到一封信" },
    ]);
    // 第 2 章补摘原句没成，梗概、时间、线索都没记上；第 3、4 章账待记。
    await commit(2, "# 第2章\n\n船来了。", [], { status: "partial", reasonCodes: ["quote_repair_failed"], missingKinds: ["summary", "time", "thread"] });
    for (const chapter of [3, 4]) await commit(chapter, `# 第${chapter}章\n\n又等了一天。`, [], { status: "pending", reasonCodes: ["keeper_failed"] });

    const envelope = await buildWriterContext({ projectDir, chapter: 5, chapterGoal: "拆信。", maxTimelineEvents: 5 });
    const short = envelope.sections.find((section) => section.name === "ledger_pending")?.content as { chapters: number[]; note: string } | undefined;
    expect(short?.chapters).toEqual([2, 3, 4]);
    expect(short?.note).toContain("第 3 章、第 4 章的账还没记上、第 2 章的账没记全");
    const continuity = envelope.sections.find((section) => section.name === "story_continuity")?.content as { recentEvents: string[] } | undefined;
    expect(continuity?.recentEvents).toContain("第 2 章：这章的账没记全，梗概给不出");
    // 按章号相减是「已 4 章没有推进」、要提醒；那 3 章不知道动没动，不数。
    const threads = envelope.sections.find((section) => section.name === "story_threads")?.content as { staleThreadWarnings: unknown[] } | undefined;
    expect(threads?.staleThreadWarnings).toEqual([]);
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

  // 写作版本 P1 第 15 轮 AC2：上一章的文件原文只经核心 parseDraftFile 拆一次，没章名时正文开头的小节标题、垫的空章名行都不吃掉正文。
  it.each([
    { label: "已定稿、没章名、正文开头是二级小节", where: "chapters/0001.md", file: "## 小节：钥匙已交给乙\n甲离开了。\n", section: "previous_chapter" },
    { label: "没定稿、垫了空章名、正文开头是一级标题", where: "drafts/fast/chapter-0001.md", file: "#\n\n# 正文：钥匙已交给乙\n甲离开了。\n", section: "previous_uncommitted_draft" },
  ])("上一章正文的首行不丢（$label）", async ({ where, file, section }) => {
    const rootDir = await mkdtemp(join(tmpdir(), "story-engine-previous-heading-"));
    const { projectDir } = await createStoryProject({ rootDir, title: "交钥匙", genre: "urban", logline: "甲把钥匙交给乙。", protagonistName: "甲" });
    await mkdir(join(projectDir, dirname(where)), { recursive: true });
    await writeFile(join(projectDir, where), file, "utf-8");
    const envelope = await buildWriterContext({ projectDir, chapter: 2, chapterGoal: "继续第 2 章。" });
    const found = envelope.sections.find((item) => item.name === section)?.content as { title?: string; text?: string; excerpt?: string } | undefined;
    expect(found?.title).toBeUndefined();
    expect(found?.text ?? found?.excerpt).toContain("钥匙已交给乙");
    expect(found?.text ?? found?.excerpt).toContain("甲离开了。");
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
    const rootDir = await mkdtemp(join(tmpdir(), "story-engine-no-titles-"));
    const { projectDir } = await createStoryProject({ rootDir, title: "新书", genre: "xianxia", logline: "第一章。", protagonistName: "林远" });
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
    await seedChapters(projectDir, [{ chapter: 3, entries: [
      { kind: "summary", text: "林澈修好无线电后听见异常信号。" },
      { kind: "presence", name: "林澈", nameUsed: "林澈" },
    ] }]);

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

  it("early open lead survives selectRelevant and appears in openLeads (thread not-sinking)", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "story-engine-thread-nosink-"));
    const { projectDir } = await createStoryProject({
      rootDir,
      title: "古老线索测试",
      genre: "xianxia",
      logline: "测试早期线索不沉底。",
      protagonistName: "林远",
    });

    // 1 early lead (ch2) + 6 recent leads (ch40-45 开、ch44-49 碰过)
    await seedThreads(projectDir, [
      { name: "lead-early", type: "question", title: "早期古老线索", openedAt: 2, quote: "第2章出现的线索一直没有解决。" },
      ...Array.from({ length: 6 }, (_, index): SeedThread => ({ name: `lead-r${index + 1}`, type: "question", title: `近章线索${index + 1}`, openedAt: 45 - index, touchedAt: 49 - index, quote: `近章线索${index + 1}。` })),
    ]);

    const envelope = await buildWriterContext({ projectDir, chapter: 50, chapterGoal: "继续推进剧情。" });
    const storyThreads = envelope.sections.find((s) => s.name === "story_threads")?.content as
      | { openLeads: Array<{ id: string }> }
      | undefined;

    // With selectRelevant + ancientBonus, lead-early (50 - 2 = 48 >= 10) gets ancientBonus
    // so it should survive in openLeads despite 6 more recent leads
    const openLeadIds = storyThreads?.openLeads.map((l) => l.id) ?? [];
    expect(openLeadIds).toContain(seededThreadId(projectDir, "lead-early"));
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
    await seedThreads(projectDir, [
      { name: "lead-early-relevant", type: "question", title: "账房账目查证线索", openedAt: 2, quote: "后墙发现账册。" },
      { name: "lead-recent-irrelevant", type: "question", title: "毫不相关的新线索", openedAt: 49, quote: "完全无关的最新线索。" },
      { name: "arc-ledger", type: "goal", title: "查清外院账房账目", openedAt: 1, touchedAt: 48, quote: "外院账房存在账目。", weight: "major" },
    ]);

    const envelope = await buildWriterContext({ projectDir, chapter: 50, chapterGoal: "追查外院账目。" });
    const storyThreads = envelope.sections.find((s) => s.name === "story_threads")?.content as
      | { openLeads: Array<{ id: string }> }
      | undefined;

    const openLeadIds = storyThreads?.openLeads.map((l) => l.id) ?? [];
    // The early+relevant thread should rank above the recent but irrelevant thread
    const early = openLeadIds.indexOf(seededThreadId(projectDir, "lead-early-relevant"));
    expect(early).toBeGreaterThanOrEqual(0);
    expect(early).toBeLessThan(openLeadIds.indexOf(seededThreadId(projectDir, "lead-recent-irrelevant")));
  });

  // P2 铁律④（永不静默）：账读坏了此前静默降级为 []，模型拿到「空历史」却毫无知觉，会把已写过的章节当没发生过。
  // 降级照做（不炸出稿），但失败原因必须以 read_failures 段进上下文、只记一次，让模型知道自己在盲写并如实转达用户。
  it("账读坏了：降级成空，但 read_failures 段如实说一次", async () => {
    const projectDir = await createFixtureProject();
    await writeFile(join(projectDir, "ledger", "chapters", "0003.json"), "{not-json", "utf-8");

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
    expect(failures!.failures).toHaveLength(1);
    expect(failures!.failures[0]).toContain("设定本和账读取失败");
    expect(failures!.failures.join(" ")).not.toMatch(/\/Users|\/var|\/private|\/tmp|\/home/u);
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
  it("设定卡坏了：设定和账都按空写，read_failures 只说一次", async () => {
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
    // 设定和账是同一份快照：账也按空，原因只说一次。
    const failures = (envelope.sections.find((s) => s.name === "read_failures")?.content as { failures: readonly string[] } | undefined)?.failures ?? [];
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("设定本和账读取失败");
    expect(failures.join(" ")).not.toMatch(/\/Users|\/var|\/private|\/tmp|\/home/u);
    expect(renderFastDraftPromptText(envelope)).toContain("设定本和账读取失败");
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
  // 第 1～7 章：线索、打算、目标照老样子开、碰；第 5～7 章收掉三个悬念（= 这章揭开的事）。
  const summaries: Record<number, string> = {
    5: "林远被同门打压，被迫离开园圃，并发现园圃灵土里藏着账本残页。",
    6: "林远在库房遭管事克扣月钱，并发现账册暗号指向账房。",
    7: "林远在后墙听见异常响动，并察觉账本暗页暴露了外院账目。",
  };
  const present: Record<number, readonly string[]> = { 5: ["林远"], 6: ["林远", "林婉清"], 7: ["林远"] };
  const chapters: SeedChapter[] = Array.from({ length: 7 }, (_, index) => {
    const chapter = index + 1;
    return {
      chapter,
      entries: [
        { kind: "summary", text: summaries[chapter] ?? `第${chapter}章事件` },
        ...(present[chapter] ?? [chapter % 2 === 0 ? "林婉清" : "林远"]).map((name) => ({ kind: "presence" as const, name, nameUsed: name })),
      ],
    };
  });
  await seedThreads(projectDir, [
    { name: "lead-wall", type: "question", title: "后墙异常响动", openedAt: 5, touchedAt: 7, quote: "后墙传来异常响动。" },
    { name: "intent-night", type: "intent", title: "林远夜探账房", openedAt: 5, touchedAt: 6, quote: "林远打算夜探账房。" },
    { name: "lead-old", type: "question", title: "另一页账本残页被带走", openedAt: 1, touchedAt: 3, quote: "另一页账本残页被带走。" },
    { name: "q-soil", type: "question", title: "园圃灵土里有什么", openedAt: 4, closedAt: 5, closeNote: "林远发现园圃灵土里藏着账本残页。" },
    { name: "q-code", type: "question", title: "账册暗号指向哪", openedAt: 4, closedAt: 6, closeNote: "林远发现账册暗号指向账房。" },
    { name: "q-page", type: "question", title: "账本暗页写了什么", openedAt: 4, closedAt: 7, closeNote: "林远察觉账本暗页暴露了外院账目。" },
    { name: "arc-ledger", type: "goal", title: "查清资源账目", openedAt: 1, touchedAt: 7, quote: "林远察觉账本暗页暴露了外院账目。", weight: "major" },
    { name: "arc-token", type: "goal", title: "查明破损信物用途", openedAt: 5, touchedAt: 6, quote: "管事威胁林远交出破损信物。" },
    { name: "arc-stale", type: "goal", title: "摆脱外院管事打压", openedAt: 1, touchedAt: 2, quote: "林远被管事打压。" },
  ], chapters);
  return projectDir;
}
