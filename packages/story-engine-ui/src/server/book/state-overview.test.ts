// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cardWrite, chapterCommit, runCommand, type CardOp, type EntryInput } from "@actalk/story-core";
import { seedChapters, seedDecisions, seededThreadId } from "./ledger-test-helpers.js";
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
    expect(overview.threads).toMatchObject({
      total: 3,
      open: 1,
      touched: 1,
      done: 1,
      openIntents: 1,
    });
    // 最久没碰的 intent-low 停了 4 章（第 1→5 章），不到 5 章不算可清理。
    expect(overview.threads.cleanupVisibleCount).toBe(0);
    expect(overview.threads.keyOpenItems.map((item) => item.id)).toContain(seededThreadId(projectDir, "intent-low"));
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
      "arcGoals", "characters", "project", "setting", "storyStatus", "threads", "timeline", "uiHints",
    ]);
    expect(Object.keys(overview.storyStatus).sort()).toEqual(["currentObjective", "lastTimelineEvent"]);

    // 老的「归并 / 删除已禁用」开关不再给：对话 AI 照着它跟作者说「归并是禁用的」，其实 manage_ledger 能归并（长篇实跑）。
    expect(Object.keys(overview.uiHints)).toEqual(["warnings"]);
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

    // 作者说过不用建卡：人物名单照列（写稿要用），待建的数不算它。
    await writeCards(projectDir, [{ op: "uncarded.skip", name: "老周" }]);
    const after = await buildStateOverview({ projectDir, chapter: 2 });
    expect(after.characters.knownCharacters).toContainEqual({ name: "周守义", carded: false, chapterCount: 2, lastSeenChapter: 2 });
    expect(after.setting.uncarded).toBe(0);
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

  // 可清理的线索只按章数和作者标的轻重算（重构 P7「不猜」）：还开着、从最新定稿章算已经 5 章没碰过的才算；
  // 收了的、标了大伏笔 / 小线索的不算。编辑部 R5.4 的口径照旧：可清理数和 open+touched 同一集合，恒 ≤ open+touched。
  it("可清理线索 = 还开着且 5 章没碰过的；收了的、最近碰过的、大伏笔、小线索都不算", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "story-engine-state-overview-r54-"));
    const { projectDir } = await createStoryProject({
      rootDir,
      title: "线索口径测试",
      genre: "都市",
      logline: "测试线索计数口径。",
      protagonistName: "林澈",
    });
    await seedChapters(projectDir, [
      { chapter: 1, entries: [
        { kind: "thread", thread: "t-open-stale", op: "open", type: "intent", title: "想了想", note: "想了想" },
        { kind: "thread", thread: "t-done-old", op: "open", type: "intent", title: "犹豫了一下", note: "犹豫了一下" },
        { kind: "thread", thread: "t-touched-recent", op: "open", type: "question", title: "查清信号来源", note: "信号" },
        // 作者标了大伏笔：埋得再久也不劝清理。
        { kind: "thread", thread: "t-major-old", op: "open", type: "question", title: "铁箱里是什么", note: "铁箱" },
        // 作者标了小线索：停多久都不提醒（跟伏笔看板「停太久」一个口径）。
        { kind: "thread", thread: "t-minor-old", op: "open", type: "question", title: "补发工钱", note: "工钱" },
      ] },
      { chapter: 2, entries: [{ kind: "thread", thread: "t-done-old", op: "close", note: "不犹豫了" }] },
      { chapter: 3, entries: [{ kind: "summary", text: "第三章" }] },
      { chapter: 4, entries: [{ kind: "thread", thread: "t-open-recent", op: "open", type: "intent", title: "先不管", note: "先不管" }] },
      { chapter: 5, entries: [{ kind: "thread", thread: "t-touched-recent", op: "advance", note: "信号又来了" }] },
      { chapter: 6, entries: [{ kind: "summary", text: "第六章" }] },
    ]);
    await seedDecisions(projectDir, [
      { type: "thread.weight", thread: "t-major-old", weight: "major" },
      { type: "thread.weight", thread: "t-minor-old", weight: "minor" },
    ]);

    const overview = await buildStateOverview({ projectDir, chapter: 6 });

    expect(overview.threads.open).toBe(4);
    expect(overview.threads.touched).toBe(1);
    expect(overview.threads.cleanupVisibleCount).toBe(1);
    expect(overview.threads.cleanupItems.map((item) => item.title)).toEqual(["想了想"]);
    // 作者翻到还没写的第 9 章：照最新定稿章（第 6 章）算，跟界面数的同一批（长篇实跑：界面说 5 条、AI 说 6 条）。
    const ahead = await buildStateOverview({ projectDir, chapter: 9 });
    expect(ahead.threads.cleanupItems.map((item) => item.title)).toEqual(["想了想"]);
    // 只带作者标的分量（大伏笔 / 小线索），普通的不带；不再给按跨章数派生的「大 / 小」，免得对话 AI 当成作者标的。
    const byTitle = new Map(overview.threads.keyOpenItems.map((item) => [item.title, item]));
    expect(byTitle.get("铁箱里是什么")?.weight).toBe("major");
    expect(byTitle.get("补发工钱")?.weight).toBe("minor");
    expect(byTitle.get("先不管")).not.toHaveProperty("weight");
    expect(JSON.stringify(overview.threads)).not.toContain("\"size\"");
    expect(overview.threads.cleanupVisibleUnresolvedCount).toBe(1);
    expect(overview.threads.cleanupVisibleUnresolvedCount)
      .toBeLessThanOrEqual(overview.threads.open + overview.threads.touched);
    await rm(rootDir, { recursive: true, force: true });
  });

  it("账读不出来：如实挂警告，线索、目标、时间线按空显示，概况照常出", async () => {
    const projectDir = await createOverviewFixture();
    await writeFile(join(projectDir, "ledger", "chapters", "0003.json"), "坏了", "utf-8");

    const overview = await buildStateOverview({ projectDir });

    expect(overview.threads.total).toBe(0);
    expect(overview.arcGoals.activeCount).toBe(0);
    expect(overview.threads.cleanupItems).toEqual([]);
    expect(overview.timeline.recentEvents).toEqual([]);
    expect(overview.uiHints.warnings.join(" ")).toContain("账读不出来");
    expect(overview.uiHints.warnings.join(" ")).not.toMatch(/\/Users|\/var|\/private|\/tmp|\/home/u);
    // 书名照常。
    expect(overview.project.title).toBe("状态总览测试");
  });

  it("账还没接上新核心的老书（书架上、没打开过）：章数照盘上的定稿正文算，不报成零章", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "story-engine-overview-old-"));
    const { projectDir } = await createStoryProject({ rootDir, title: "老书", protagonistName: "林澈" });
    await writeFile(join(projectDir, "chapters", "0001.md"), "# 第1章\n\n林澈醒了。", "utf-8");
    await writeFile(join(projectDir, "chapters", "0002.md"), "# 第2章\n\n林澈出门。", "utf-8");

    const overview = await buildStateOverview({ projectDir });

    expect(overview.project.currentChapter).toBe(2);
    expect(overview.threads.total).toBe(0);
  });

  // Task 4: 用例 A — 早期未收口伏笔仍出现在 activeItems（不被近章挤掉）
  it("(Task 4-A) 早期未收口线索在≥12条近章时仍出现在 threads.keyOpenItems", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "story-engine-task4-a-"));
    const { projectDir } = await createStoryProject({
      rootDir,
      title: "早期伏笔召回测试",
      genre: "urban",
      logline: "测试早期伏笔不被近章挤掉。",
    });

    // 1条早期未收口线索（第 2 章）+ 13条近章线索（第 40-52 章）
    await seedChapters(projectDir, [
      { chapter: 2, entries: [{ kind: "thread", thread: "early-thread-ancient", op: "open", type: "question", title: "早期线索未收口", note: "早期发现的线索" }] },
      ...Array.from({ length: 13 }, (_, i) => ({
        chapter: 40 + i,
        entries: [{ kind: "thread" as const, thread: `recent-thread-${i}`, op: "open" as const, type: "question" as const, title: `近章线索${i}`, note: `近章证据${i}` }],
      })),
    ]);

    const overview = await buildStateOverview({ projectDir, chapter: 50 });

    // 早期条目在 chapter=50 时距首见章已 48 章（>ancientThreshold=10），应被古老加分救回
    expect(overview.threads.keyOpenItems.map((item) => item.id)).toContain(seededThreadId(projectDir, "early-thread-ancient"));
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
  // 50 章真走定稿命令种账，磁盘 IO 重：给显式超时。
  it("50 章 timeline：macroSummary 含早期块、earlierSummary 含中段、recentEvents 仍是近章（不破坏）", { timeout: 60_000 }, async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "story-engine-overview-6b-"));
    const { projectDir } = await createStoryProject({
      rootDir,
      title: "分层摘要测试书",
      genre: "wuxia",
      logline: "江湖风云",
      protagonistName: "侠客",
    });

    // 构造 50 章，每章一句梗概，梗概里带章号方便断言
    await seedChapters(projectDir, Array.from({ length: 50 }, (_, i) => ({
      chapter: i + 1,
      entries: [{ kind: "summary" as const, text: `第${i + 1}章核心事件mainEvent${i + 1}` }],
    })));

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

    // 空书不崩
    const empty = await createStoryProject({ rootDir, title: "空书", protagonistName: "侠客" });
    const emptyOverview = await buildStateOverview({ projectDir: empty.projectDir, chapter: 1 });
    expect(emptyOverview.timeline.recentEvents).toHaveLength(0);
    expect(emptyOverview.timeline.earlierSummary).toHaveLength(0);
    expect(emptyOverview.timeline.macroSummary).toHaveLength(0);
  });
});

// B5-2: 引擎 overview 投影补章号字段
describe("State Overview B5-2: threads 投影带 firstSeenChapter", () => {
  it("toThreadOverview 投影：thread 带 firstSeenChapter", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "story-engine-b5-2-threads-"));
    const { projectDir } = await createStoryProject({
      rootDir,
      title: "B5-2 线索章号测试",
      genre: "mystery",
      logline: "线索首现章号透传测试。",
    });

    await seedChapters(projectDir, [
      { chapter: 4, entries: [{ kind: "thread", thread: "thread-lead", op: "open", type: "question", title: "谜案主线索", note: "第4章发现尸体。" }] },
      { chapter: 8, entries: [{ kind: "thread", thread: "thread-lead", op: "advance", note: "又有发现。" }] },
    ]);

    const overview = await buildStateOverview({ projectDir, chapter: 9 });

    const threadItem = overview.threads.keyOpenItems.find((item) => item.id === seededThreadId(projectDir, "thread-lead"));
    expect(threadItem, "线索应在 keyOpenItems").toBeDefined();
    // firstSeenChapter 应被正确投出
    expect(threadItem!.firstSeenChapter).toBe(4);
  });
});

function __filenameDir(): string {
  // fileURLToPath 才能正确解码路径里的空格等。
  return dirname(fileURLToPath(import.meta.url));
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
  await seedChapters(projectDir, [
    { chapter: 1, entries: [
      { kind: "thread", thread: "intent-low", op: "open", type: "intent", title: "林澈想了想，决定先不管这个", note: "他想了想，决定先不管这个。" },
      { kind: "thread", thread: "goal-survive", op: "open", type: "goal", title: "在旧城区灾变中生存下来", note: "林澈继续寻找安全路线。" },
      { kind: "thread", thread: "goal-done", op: "open", type: "goal", title: "获取基础食物", note: "要找吃的。" },
    ] },
    { chapter: 2, entries: [{ kind: "thread", thread: "intent-done", op: "open", type: "intent", title: "去药店找药", note: "要去药店。" }] },
    { chapter: 3, entries: [
      { kind: "thread", thread: "lead-signal", op: "open", type: "question", title: "确认无线电信号来源", note: "收音机里出现避难所坐标。" },
      { kind: "thread", thread: "goal-done", op: "close", note: "便利店罐头已经带回。" },
    ] },
    { chapter: 4, entries: [
      { kind: "summary", text: "林澈在楼道避开感染者。" },
      { kind: "thread", thread: "intent-done", op: "close", note: "他已经带回绷带。" },
    ] },
    { chapter: 5, entries: [
      { kind: "summary", text: "这是一段非常长的章节正文摘要不应该进入状态总览全文，只能保留短摘要。林澈在地下车库听见收音机断续广播。".repeat(4) + "长文本尾巴不应该出现在 overview 里" },
      { kind: "thread", thread: "lead-signal", op: "advance", note: "广播频率异常。" },
    ] },
  ]);
  await seedDecisions(projectDir, [{ type: "thread.weight", thread: "goal-survive", weight: "major" }]);
  return projectDir;
}

/** 书目录下全部文件  return projectDir;
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
