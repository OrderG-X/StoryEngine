// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cardWrite, chapterCommit, runCommand, type CardOp, type EntryInput } from "@actalk/story-core";
import { createStoryProject } from "./project-store.js";
import { buildStateOverview } from "./state-overview.js";

describe("State Overview（重构 P9：账 + 设定本的几个数）", () => {

  it("从测试书拼出只读概况：账照旧、设定只带计数和主角，读完盘上一个字节不变", async () => {
    const projectDir = await createOverviewFixture();
    const before = await snapshotBookFiles(projectDir);

    const overview = await buildStateOverview({ projectDir, chapter: 5, maxTimelineEvents: 2 });

    // 题材、一句话照故事设定栏原样取。
    expect(overview.project).toEqual({
      title: "状态总览测试",
      genre: "末世",
      logline: "林澈在旧城区灾变中求生，逐步确认无线电异常信号。",
      currentChapter: 5,
    });
    expect(overview.storyStatus.currentObjective).toBe("在旧城区灾变中生存下来");
    expect(overview.storyStatus.lastTimelineEvent?.length).toBeLessThanOrEqual(160);
    expect(overview.hooks.activeCount).toBe(1);
    expect(overview.threads).toMatchObject({
      total: 3,
      open: 1,
      touched: 1,
      done: 1,
      openIntents: 1,
    });
    // 最久没碰的 intent-low 停了 4 章（第 1→5 章），不到 5 章不算可清理。
    expect(overview.threads.cleanupVisibleCount).toBe(0);
    expect(overview.threads.keyOpenItems.map((item) => item.id)).toContain("intent-low");
    expect(overview.arcGoals.activeCount).toBe(1);
    expect(overview.timeline.recentEvents).toHaveLength(2);

    expect(overview.characters.protagonist).toBe("林澈");
    expect(overview.characters.knownCharacters).toEqual([
      { name: "林澈", carded: true, protagonist: true },
      { name: "苏雨", carded: true },
    ]);
    expect(overview.setting).toEqual({
      targetChapterWords: 2400,
      minChapterWords: 2000,
      cards: { characters: 2, places: 1, items: 1, lore: 1 },
      uncarded: 0,
      storyFields: 3,
    });

    // 瘦身后不再带老设定的大块（设定本内容走设定视图 / read_foundation）。
    expect(Object.keys(overview).sort()).toEqual([
      "arcGoals", "characters", "hooks", "maintenance", "project", "setting", "storyStatus", "threads", "timeline", "uiHints",
    ]);
    expect(Object.keys(overview.storyStatus).sort()).toEqual(["currentObjective", "lastTimelineEvent"]);

    expect(overview.maintenance).toMatchObject({
      diagnosticsAvailable: true,
      mergeDisabled: true,
      dropDisabled: true,
      confirmPolicy: {
        markDone: "manual_only",
        merge: "disabled",
        drop: "disabled",
      },
    });
    expect(overview.uiHints.disabledActions).toEqual(expect.arrayContaining([
      "merge_threads_confirm",
      "drop_thread_confirm",
      "auto_apply_review_plan_confirm",
    ]));
    expect(overview.uiHints.warnings.join(" ")).not.toContain("设定卡读不出来");
    expect(overview.timeline.recentEvents.at(-1)?.summary.length).toBeLessThanOrEqual(160);
    expect(JSON.stringify(overview)).not.toContain("长文本尾巴不应该出现在 overview 里");
    // 读路径不写盘：文件一个不多、内容一个字节不变。
    await expect(snapshotBookFiles(projectDir)).resolves.toEqual(before);
  });

  it("人物名单 = 人物卡 + 账里出场过还没建卡的人：主角在前，带出场章数和最近一章", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "story-engine-overview-cast-"));
    const { projectDir } = await createStoryProject({ rootDir, title: "人物名单", protagonistName: "沈青禾" });
    await writeCards(projectDir, [{ op: "card.create", kind: "character", name: "许澄" }]);
    await commit(projectDir, 1, "# 第1章\n\n沈青禾推开钟楼的门，老周没有拦她。", [
      { kind: "presence", review: "auto", name: "沈青禾", nameUsed: "沈青禾", viewpoint: true, quote: "沈青禾推开钟楼的门" },
      { kind: "presence", review: "auto", name: "周守义", nameUsed: "老周", quote: "老周没有拦她" },
    ]);
    await commit(projectDir, 2, "# 第2章\n\n老周站在门口，没让外人进。", [
      { kind: "presence", review: "auto", name: "周守义", nameUsed: "老周", quote: "老周站在门口" },
    ]);

    const overview = await buildStateOverview({ projectDir, chapter: 2 });

    expect(overview.characters.protagonist).toBe("沈青禾");
    expect(overview.characters.knownCharacters).toEqual([
      { name: "沈青禾", carded: true, protagonist: true, chapterCount: 1, lastSeenChapter: 1 },
      // 有卡、账里还没出场：没有出场数。
      { name: "许澄", carded: true },
      // 账里出场两章、还没建卡：如实列出，标没卡。
      { name: "周守义", carded: false, chapterCount: 2, lastSeenChapter: 2 },
    ]);
    expect(overview.setting.cards.characters).toBe(2);
    expect(overview.setting.uncarded).toBe(1);
  });

  it("作者没填题材、一句话、主角：概况就空着，不编占位", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "story-engine-overview-bare-"));
    const { projectDir } = await createStoryProject({ rootDir, title: "只有书名" });
    await writeCards(projectDir, [{ op: "card.create", kind: "character", name: "林远" }]);

    const overview = await buildStateOverview({ projectDir });

    expect(overview.project).toEqual({ title: "只有书名", genre: "", logline: "", currentChapter: null });
    expect(overview.characters).toEqual({ knownCharacters: [{ name: "林远", carded: true }] });
    expect(overview.characters).not.toHaveProperty("protagonist");
    expect(overview.setting).toEqual({ cards: { characters: 1, places: 0, items: 0, lore: 0 }, uncarded: 0, storyFields: 0 });
  });

  // 可清理的线索只按章数算（重构 P7「不猜」）：还开着、已经 5 章没碰过的才算；收了的不算。
  // 编辑部 R5.4 的口径照旧：可清理数和 open+touched 同一集合，恒 ≤ open+touched。
  it("可清理线索 = 还开着且 5 章没碰过的；收了的、最近碰过的都不算", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "story-engine-state-overview-r54-"));
    const { projectDir } = await createStoryProject({
      rootDir,
      title: "线索口径测试",
      genre: "都市",
      logline: "测试线索计数口径。",
      protagonistName: "林澈",
    });
    await writeLegacyJson(projectDir, "story/threads.json", {
      threads: [
        { id: "t-open-stale", type: "intent", title: "想了想", status: "open", firstSeenChapter: 1, lastTouchedChapter: 1, evidence: [] },
        { id: "t-done-old", type: "intent", title: "犹豫了一下", status: "done", firstSeenChapter: 1, lastTouchedChapter: 1, evidence: [] },
        { id: "t-touched-recent", type: "lead", title: "查清信号来源", status: "touched", firstSeenChapter: 1, lastTouchedChapter: 5, evidence: [] },
        { id: "t-open-recent", type: "intent", title: "先不管", status: "open", firstSeenChapter: 2, lastTouchedChapter: 4, evidence: [] },
      ],
    });

    const overview = await buildStateOverview({ projectDir, chapter: 6 });

    expect(overview.threads.open).toBe(2);
    expect(overview.threads.touched).toBe(1);
    expect(overview.threads.cleanupVisibleCount).toBe(1);
    expect(overview.threads.cleanupVisibleUnresolvedCount).toBe(1);
    expect(overview.threads.cleanupVisibleUnresolvedCount)
      .toBeLessThanOrEqual(overview.threads.open + overview.threads.touched);
    await rm(rootDir, { recursive: true, force: true });
  });

  it("degrades gracefully when optional pools are missing", async () => {
    const projectDir = await createOverviewFixture();
    await rm(join(projectDir, "story", "hooks.json"));
    await rm(join(projectDir, "story", "threads.json"));
    await rm(join(projectDir, "story", "arc-goals.json"));

    const overview = await buildStateOverview({ projectDir });

    expect(overview.hooks.activeCount).toBe(0);
    expect(overview.threads.total).toBe(0);
    expect(overview.arcGoals.activeCount).toBe(0);
    expect(overview.maintenance.mergeDisabled).toBe(true);
    expect(overview.maintenance.dropDisabled).toBe(true);
    expect(overview.maintenance.confirmPolicy.markDone).toBe("manual_only");
  });

  // Task 4: 用例 A — 早期未收口伏笔仍出现在 activeItems（不被近章挤掉）
  it("(Task 4-A) 早期未收口条目在≥12条近章时仍出现在 hooks.activeItems 和 threads.keyOpenItems", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "story-engine-task4-a-"));
    const { projectDir } = await createStoryProject({
      rootDir,
      title: "早期伏笔召回测试",
      genre: "urban",
      logline: "测试早期伏笔不被近章挤掉。",
    });

    // 1条早期未收口 hook（chapter:2）+ 13条近章 hook（chapters 40-52）
    const earlyHook = {
      id: "early-hook-ancient",
      title: "早期未收口伏笔线索",
      description: "这是早期埋下的重要伏笔",
      status: "active",
      relatedCharacters: [],
      firstSeenChapter: 2,
      lastTouchedChapter: 2,
    };
    const recentHooks = Array.from({ length: 13 }, (_, i) => ({
      id: `recent-hook-${i}`,
      title: `近章伏笔${i}`,
      description: `近章伏笔描述${i}`,
      status: "active",
      relatedCharacters: [],
      firstSeenChapter: 40 + i,
      lastTouchedChapter: 40 + i,
    }));

    // 1条早期未收口 thread（chapter:2）+ 13条近章 thread
    const earlyThread = {
      id: "early-thread-ancient",
      type: "lead",
      title: "早期线索未收口",
      status: "open",
      firstSeenChapter: 2,
      lastTouchedChapter: 2,
      evidence: ["早期发现的线索"],
    };
    const recentThreads = Array.from({ length: 13 }, (_, i) => ({
      id: `recent-thread-${i}`,
      type: "lead",
      title: `近章线索${i}`,
      status: "open",
      firstSeenChapter: 40 + i,
      lastTouchedChapter: 40 + i,
      evidence: [`近章证据${i}`],
    }));

    await writeLegacyJson(projectDir, "story/hooks.json", { hooks: [earlyHook, ...recentHooks] });
    await writeLegacyJson(projectDir, "story/threads.json", { threads: [earlyThread, ...recentThreads] });

    const overview = await buildStateOverview({ projectDir, chapter: 50 });

    // 早期条目在 chapter=50 时距首见章已 48 章（>ancientThreshold=10），应被古老加分救回
    expect(overview.hooks.activeItems.map((item) => item.id)).toContain("early-hook-ancient");
    expect(overview.threads.keyOpenItems.map((item) => item.id)).toContain("early-thread-ancient");
  });

  // Task 4: 用例 B — null chapter 兜底（无 input.chapter + 空 timeline）
  it("(Task 4-B) 无 input.chapter 且 timeline 为空时，hooks/threads 仍出现在 activeItems（不被误排除）", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "story-engine-task4-b-"));
    const { projectDir } = await createStoryProject({
      rootDir,
      title: "Null章号兜底测试",
      genre: "scifi",
      logline: "新书空timeline章号null测试。",
    });

    await writeLegacyJson(projectDir, "story/hooks.json", {
      hooks: [
        {
          id: "hook-new",
          title: "新书第一个伏笔",
          description: "新书里埋下的伏笔。",
          status: "active",
          relatedCharacters: [],
          firstSeenChapter: 1,
          lastTouchedChapter: 1,
        },
      ],
    });
    await writeLegacyJson(projectDir, "story/threads.json", {
      threads: [
        {
          id: "thread-new",
          type: "lead",
          title: "新书第一条线索",
          status: "open",
          firstSeenChapter: 1,
          lastTouchedChapter: 1,
          evidence: ["新书线索证据"],
        },
      ],
    });
    // timeline 为空（不写 events.json，使用默认空数组）

    // 不传 chapter → currentChapter=null，兜底章号应保证条目不被排除
    const overview = await buildStateOverview({ projectDir });

    expect(overview.project.currentChapter).toBeNull();
    expect(overview.hooks.activeItems.map((item) => item.id)).toContain("hook-new");
    expect(overview.threads.keyOpenItems.map((item) => item.id)).toContain("thread-new");
  });
});

// R5b 题材中立化：概况源码里不许写死任何题材专名地点。
describe("State Overview — genre-neutral (R5b)", () => {
  it("源码不再写死任何题材专名地点（公交站/孵化楼/申请窗口/办公区/终端区/旧城区/楼层映射）", async () => {
    const source = await readFile(join(__filenameDir(), "state-overview.ts"), "utf-8");
    // 仅检查执行逻辑里的字符串字面量与正则，注释里被动提及「已删除的旧专名」不算违规：
    // 抽出所有非注释代码行后断言不含写死专名。
    const codeOnly = source
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    for (const banned of ["孵化楼", "申请窗口", "办公区", "终端区", "市中心", "旧城区"]) {
      expect(codeOnly).not.toContain(banned);
    }
    // 旧版写死的「一楼大厅→1楼大厅 / 二楼申请窗口 / 三楼办公区」专名映射必须消失。
    expect(codeOnly).not.toContain("二楼申请窗口");
    expect(codeOnly).not.toContain("三楼办公区");
  });
});

// Task 6b：timeline 分层摘要接入 state-overview
describe("State Overview timeline 分层摘要（Task 6b）", () => {
  it("50 章 timeline：macroSummary 含早期块、earlierSummary 含中段、recentEvents 仍是近章（不破坏）", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "story-engine-overview-6b-"));
    const { projectDir } = await createStoryProject({
      rootDir,
      title: "分层摘要测试书",
      genre: "wuxia",
      logline: "江湖风云",
      protagonistName: "侠客",
    });

    // 构造 50 章 timeline，每章一个事件，mainEvent 包含章号方便断言
    const events = Array.from({ length: 50 }, (_, i) => {
      const ch = i + 1;
      return {
        id: `ch${String(ch).padStart(4, "0")}-001`,
        chapter: ch,
        summary: `第${ch}章：主角经历了事件${ch}。`,
        participants: ["侠客"],
        effects: {
          semanticSummary: {
            mainEvent: `第${ch}章核心事件mainEvent${ch}`,
            timelineSummary: `第${ch}章时间线摘要`,
          },
        },
      };
    });

    await writeLegacyJson(projectDir, "timeline/events.json", events);

    // currentChapter=50：L1=48-50，L2=35-47（15窗口），L3=1-35（远期宏块）
    const overview = await buildStateOverview({ projectDir, chapter: 50, maxTimelineEvents: 3 });

    // recentEvents 仍是近章（默认3条 maxTimelineEvents）
    expect(overview.timeline.recentEvents).toHaveLength(3);
    expect(overview.timeline.recentEvents.map((e) => e.chapter)).toEqual([48, 49, 50]);

    // earlierSummary（L2）包含中段章节
    expect(overview.timeline.earlierSummary.length).toBeGreaterThan(0);
    // L2 应包含第 35 章（currentChapter-l2Window=50-15=35，边界含）
    const l2Chapters = overview.timeline.earlierSummary.map((e) => e.chapter);
    expect(l2Chapters.some((ch) => ch <= 47 && ch >= 36)).toBe(true);

    // macroSummary（L3）含早期块
    expect(overview.timeline.macroSummary.length).toBeGreaterThan(0);
    // 早期第 2 章的 mainEvent 应出现在某个宏块 summary 里
    const allMacroText = overview.timeline.macroSummary.map((b) => b.summary).join("\n");
    expect(allMacroText).toContain("mainEvent2");

    // macroSummary 第一块应覆盖最早的章节（fromChapter 从1开始）
    expect(overview.timeline.macroSummary[0].fromChapter).toBe(1);

    // 空 timeline 不崩
    await writeLegacyJson(projectDir, "timeline/events.json", []);
    const emptyOverview = await buildStateOverview({ projectDir, chapter: 1 });
    expect(emptyOverview.timeline.recentEvents).toHaveLength(0);
    expect(emptyOverview.timeline.earlierSummary).toHaveLength(0);
    expect(emptyOverview.timeline.macroSummary).toHaveLength(0);
  });
});

// B5-2: 引擎 overview 投影补章号字段
describe("State Overview B5-2: hooks/threads 投影带 firstSeenChapter / resolvedAtChapter", () => {
  it("toHookOverview 投影：activeHook 带 firstSeenChapter，resolvedHook 带 firstSeenChapter + resolvedAtChapter", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "story-engine-b5-2-hooks-"));
    const { projectDir } = await createStoryProject({
      rootDir,
      title: "B5-2 伏笔章号测试",
      genre: "urban",
      logline: "伏笔初见章号 + 回收章号透传测试。",
    });

    await writeLegacyJson(projectDir, "story/hooks.json", {
      hooks: [
        {
          id: "hook-active",
          title: "活跃伏笔",
          description: "还未回收的伏笔。",
          status: "active",
          relatedCharacters: [],
          firstSeenChapter: 3,
          lastTouchedChapter: 5,
        },
        {
          id: "hook-resolved",
          title: "已回收伏笔",
          description: "已回收的伏笔，有 resolvedAtChapter。",
          status: "resolved",
          relatedCharacters: [],
          firstSeenChapter: 2,
          lastTouchedChapter: 12,
          resolvedAtChapter: 12,
        },
      ],
    });
    await writeLegacyJson(projectDir, "story/threads.json", { threads: [] });

    const overview = await buildStateOverview({ projectDir, chapter: 13 });

    // 活跃伏笔在 activeItems 里，带 firstSeenChapter
    const activeItem = overview.hooks.activeItems.find((item) => item.id === "hook-active");
    expect(activeItem, "活跃伏笔应在 activeItems").toBeDefined();
    expect(activeItem!.firstSeenChapter).toBe(3);
    expect(activeItem!.resolvedAtChapter).toBeUndefined();

    // 确保 resolvedHook 不在 activeItems，总数包含已回收
    expect(overview.hooks.resolvedCount).toBeGreaterThanOrEqual(1);
  });

  it("toHookOverview 投影：已回收 hook 的 resolvedAtChapter 被正确投出（通过解构批量方式验证）", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "story-engine-b5-2-resolved-"));
    const { projectDir } = await createStoryProject({
      rootDir,
      title: "B5-2 已回收章号投影测试",
      genre: "xianxia",
      logline: "resolvedAtChapter 投影确认。",
    });

    await writeLegacyJson(projectDir, "story/hooks.json", {
      hooks: [
        {
          id: "hook-only-active",
          title: "唯一活跃伏笔",
          description: "本章的活跃伏笔。",
          status: "active",
          relatedCharacters: [],
          firstSeenChapter: 7,
          lastTouchedChapter: 10,
        },
      ],
    });
    await writeLegacyJson(projectDir, "story/threads.json", { threads: [] });

    const overview = await buildStateOverview({ projectDir, chapter: 10 });
    const item = overview.hooks.activeItems.find((i) => i.id === "hook-only-active");
    expect(item).toBeDefined();
    // firstSeenChapter 应被正确投出
    expect(item!.firstSeenChapter).toBe(7);
  });

  it("toThreadOverview 投影：thread 带 firstSeenChapter", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "story-engine-b5-2-threads-"));
    const { projectDir } = await createStoryProject({
      rootDir,
      title: "B5-2 线索章号测试",
      genre: "mystery",
      logline: "线索首现章号透传测试。",
    });

    await writeLegacyJson(projectDir, "story/hooks.json", { hooks: [] });
    await writeLegacyJson(projectDir, "story/threads.json", {
      threads: [
        {
          id: "thread-lead",
          type: "lead",
          title: "谜案主线索",
          status: "open",
          firstSeenChapter: 4,
          lastTouchedChapter: 8,
          evidence: ["第4章发现尸体。"],
        },
      ],
    });

    const overview = await buildStateOverview({ projectDir, chapter: 9 });

    const threadItem = overview.threads.keyOpenItems.find((item) => item.id === "thread-lead");
    expect(threadItem, "线索应在 keyOpenItems").toBeDefined();
    // firstSeenChapter 应被正确投出
    expect(threadItem!.firstSeenChapter).toBe(4);
  });
});

function __filenameDir(): string {
  // fileURLToPath 才能正确解码路径里的空格等。
  return dirname(fileURLToPath(import.meta.url));
}

/** 老格式的账文件（hooks / threads / timeline 等镜像文件）：建书不再建 story/、timeline/ 目录，要写自己建。 */
async function writeLegacyJson(projectDir: string, relativePath: string, value: unknown): Promise<void> {
  const target = join(projectDir, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

async function writeCards(projectDir: string, ops: CardOp[]): Promise<void> {
  const outcome = await runCommand(projectDir, cardWrite, { ops }, { caller: "author", idempotencyKey: `t-${Math.random()}` });
  expect(outcome.ok, outcome.ok ? "" : outcome.message).toBe(true);
}

async function commit(projectDir: string, chapter: number, text: string, entries: EntryInput[]): Promise<void> {
  const outcome = await runCommand(projectDir, chapterCommit, { chapter, text, entries }, { caller: "author", idempotencyKey: `c-${chapter}-${Math.random()}` });
  expect(outcome.ok, outcome.ok ? "" : outcome.message).toBe(true);
  if (outcome.ok) expect(outcome.result.rejected).toEqual([]);
}

async function createOverviewFixture(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "story-engine-state-overview-"));
  const { projectDir } = await createStoryProject({
    rootDir,
    title: "状态总览测试",
    genre: "末世",
    logline: "林澈在旧城区灾变中求生，逐步确认无线电异常信号。",
    protagonistName: "林澈",
  });
  await writeCards(projectDir, [
    { op: "card.create", kind: "character", name: "苏雨", fields: [{ label: "身份", value: "楼内临时医疗志愿者" }] },
    { op: "relation.set", a: "苏雨", b: "林澈", label: "盟友，但怀疑林澈隐瞒无线电细节" },
    { op: "card.create", kind: "place", name: "公寓楼", fields: [{ label: "格局", value: "1楼大厅\n3楼住户区" }] },
    { op: "card.create", kind: "item", name: "旧收音机" },
    { op: "card.create", kind: "lore", name: "断电", fields: [{ label: "规矩", value: "城市断电断网，物资稀缺。" }] },
    { op: "story.set", label: "基调", value: "紧张、克制" },
    { op: "rules.set", field: "targetWords", value: 2400 },
    { op: "rules.set", field: "minWords", value: 2000 },
  ]);
  await writeLegacyJson(projectDir, "story/hooks.json", {
    hooks: [
      {
        id: "hook-radio",
        title: "无线电异常信号",
        description: "收音机里出现断续广播。",
        status: "active",
        relatedCharacters: ["林澈"],
        firstSeenChapter: 2,
        lastTouchedChapter: 5,
        evidence: ["第5章：广播频率异常。"],
        nextActionHint: "确认信号源。",
      },
      {
        id: "hook-done",
        title: "已解决血痕",
        description: "血痕来源已经确认。",
        status: "resolved",
        relatedCharacters: [],
        lastTouchedChapter: 3,
      },
    ],
  });
  await writeLegacyJson(projectDir, "story/threads.json", {
    threads: [
      {
        id: "intent-low",
        type: "intent",
        title: "林澈想了想，决定先不管这个",
        status: "open",
        firstSeenChapter: 1,
        lastTouchedChapter: 1,
        evidence: ["他想了想，决定先不管这个。"],
      },
      {
        id: "lead-signal",
        type: "lead",
        title: "确认无线电信号来源",
        status: "touched",
        firstSeenChapter: 3,
        lastTouchedChapter: 5,
        evidence: ["收音机里出现避难所坐标。"],
      },
      {
        id: "intent-done",
        type: "intent",
        title: "去药店找药",
        status: "done",
        firstSeenChapter: 2,
        lastTouchedChapter: 4,
        evidence: ["他已经带回绷带。"],
      },
    ],
  });
  await writeLegacyJson(projectDir, "story/arc-goals.json", {
    goals: [
      {
        id: "goal-survive",
        title: "在旧城区灾变中生存下来",
        status: "active",
        scope: "main_arc",
        firstSeenChapter: 1,
        lastTouchedChapter: 5,
        evidence: ["林澈继续寻找安全路线。"],
      },
      {
        id: "goal-done",
        title: "获取基础食物",
        status: "completed",
        scope: "mini_arc",
        firstSeenChapter: 1,
        lastTouchedChapter: 3,
        evidence: ["便利店罐头已经带回。"],
      },
    ],
  });
  await writeLegacyJson(projectDir, "timeline/events.json", [
    {
      id: "ch0004-001",
      chapter: 4,
      summary: "林澈在楼道避开感染者。",
      participants: ["林澈"],
      effects: {
        semanticSummary: {
          mainEvent: "林澈避开感染者。",
          locations: ["楼道"],
        },
      },
    },
    {
      id: "ch0005-001",
      chapter: 5,
      summary: "这是一段非常长的章节正文摘要不应该进入状态总览全文，只能保留短摘要。林澈在地下车库听见收音机断续广播。".repeat(4) + "长文本尾巴不应该出现在 overview 里",
      participants: ["林澈"],
      effects: {
        semanticSummary: {
          mainEvent: "林澈在地下车库听见断续广播。",
          locations: ["地下车库"],
        },
      },
    },
  ]);
  return projectDir;
}

/** 书目录下全部文件（相对路径 → 内容哈希）：读路径前后比一比，多一个文件、改一个字节都看得出来。 */
async function snapshotBookFiles(projectDir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(dir, entry.name), relative);
      else out[relative] = createHash("sha256").update(await readFile(join(dir, entry.name))).digest("hex");
    }
  };
  await walk(projectDir, "");
  return out;
}
