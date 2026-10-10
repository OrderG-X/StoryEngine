import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ChapterDeltaDeclaration } from "../chapter-delta.js";
import { commitFastDraft } from "../commit-engine.js";
import { buildCommitPlanFromProject } from "../commit-plan-builder.js";
import { buildWriterContext, type HookTrackingContext } from "../context-gateway.js";
import { createStoryProject, readHookPool } from "../project-store.js";
import type { HookPool } from "../types.js";

// 2026-10-10 起伏笔收口只认声明（完成词表已删）：本章声明「账目」这条伏笔回收了。
const LEDGER_RESOLVED = "林远终于将账目的来源查清了，账房黑幕水落石出，真相大白于天下。";
function ledgerResolvedDeclaration(chapter: number): ChapterDeltaDeclaration {
  return {
    chapter,
    mainEvent: { summary: "林远查清账目来源", quote: LEDGER_RESOLVED },
    seededForeshadowing: [],
    resolvedForeshadowing: [{ summary: "账目来源查清", quote: LEDGER_RESOLVED, targetThreadHint: "账目" }],
    resourceDeltas: [],
    keyLeads: [],
  };
}

describe("StoryEngine-NG Hook Tracking Pack", () => {
  // 2026-08-12 契约翻转：HOOK_KEYWORDS 悬疑词表已摘除（题材中立铁律——50 章武侠实测词表只误中 1 次，
  // 换成商战文则会拿「账目」「失踪」乱造伏笔）。新伏笔只走「模型声明 seededForeshadowing → 线索池」；
  // 本模块只维护已存在伏笔的触达/收口/停滞告警。此用例从「词表能造伏笔」翻转为「纯正文绝不自发造伏笔」。
  it("题材中立：空池 + 含旧词表词汇的正文 → 不再自发新建伏笔（新伏笔走声明通道进线索池）", async () => {
    const projectDir = await createHookProject();
    await writeDraft(projectDir, 1, [
      "林远在账房发现账目和破损信物。",
      "后墙异常响动，黑影暗号仍未解开。",
    ].join("\n\n"));

    const plan = await buildCommitPlanFromProject({ projectDir, chapter: 1 });

    expect(plan.passed).toBe(true);
    expect(plan.hookTrackingUpdates ?? []).toEqual([]);

    const report = await commitFastDraft({
      projectDir,
      chapter: 1,
      commitPlan: plan.commitPlan!,
    });

    expect(report.passed).toBe(true);
    await expect(readHookPool(projectDir)).resolves.toEqual({ hooks: [] });
  });

  it("touches existing hooks, appends bounded evidence, and keeps generated candidates deduped", async () => {
    const projectDir = await createHookProject();
    await seedHooks(projectDir, {
      hooks: [
        {
          id: "h-ledger",
          title: "账目",
          description: "账房账目记录外院账目。",
          status: "active",
          relatedCharacters: ["林远"],
          firstSeenChapter: 1,
          lastTouchedChapter: 1,
          evidence: ["旧证据1", "旧证据2", "旧证据3", "旧证据4", "旧证据5"],
        },
      ],
    });
    await writeDraft(projectDir, 2, [
      "林远再次翻到账目，发现暗页里还有账目。",
      "账目、账目和账目都指向后墙异常响动，黑影暗号仍未解开。",
    ].join("\n\n"));

    const plan = await buildCommitPlanFromProject({ projectDir, chapter: 2 });
    const ids = plan.hookTrackingUpdates?.map((update) => update.id) ?? [];

    expect(ids).toContain("h-ledger");
    expect(new Set(plan.hookTrackingUpdates?.map((update) => update.title)).size)
      .toBe(plan.hookTrackingUpdates?.length);
    expect(plan.hookTrackingUpdates?.length).toBeLessThanOrEqual(5);

    const report = await commitFastDraft({
      projectDir,
      chapter: 2,
      commitPlan: plan.commitPlan!,
    });

    expect(report.passed).toBe(true);
    const hookPool = await readHookPool(projectDir);
    const ledger = hookPool.hooks.find((hook) => hook.id === "h-ledger");
    expect(ledger).toMatchObject({
      status: "active",
      lastTouchedChapter: 2,
      nextActionHint: expect.stringContaining("后墙"),
    });
    expect(ledger?.evidence?.length).toBeLessThanOrEqual(5);
    expect(ledger?.evidence?.join("\n")).toContain("账目");
  });

  it("filters ordinary lead and intent text out of HookPool titles", async () => {
    const projectDir = await createHookProject();
    await writeDraft(projectDir, 1, [
      "林远决定先去库房查清账册来源。",
      "他准备修炼突破，明日去找管事问清楚。",
      "他不能再任人打压，必须证明自己。",
    ].join("\n\n"));

    const plan = await buildCommitPlanFromProject({ projectDir, chapter: 1 });

    expect(plan.passed).toBe(true);
    expect(plan.hookTrackingUpdates).toEqual([]);

    const report = await commitFastDraft({
      projectDir,
      chapter: 1,
      commitPlan: plan.commitPlan!,
    });

    expect(report.passed).toBe(true);
    await expect(readHookPool(projectDir)).resolves.toEqual({ hooks: [] });
  });

  it("动作线索句含悬念词汇也不再造伏笔（词表已摘除；该线索由 lead 声明/正则通道照常追踪）", async () => {
    const projectDir = await createHookProject();
    await writeDraft(projectDir, 1, "林远决定去后墙调查异常响动，下一章必须弄清黑影暗号。");

    const plan = await buildCommitPlanFromProject({ projectDir, chapter: 1 });

    expect(plan.passed).toBe(true);
    expect(plan.hookTrackingUpdates ?? []).toEqual([]);
    // 线索本身没有丢：nextLead 语义提取照常工作（只是不再被硬塞进伏笔池）
    expect(plan.semanticSummary?.nextLead ?? "").not.toBe(undefined);
  });

  it("warns about stale active hooks without blocking commit", async () => {
    const projectDir = await createHookProject();
    await seedHooks(projectDir, {
      hooks: [
        {
          id: "h-old",
          title: "禁区残页",
          description: "禁区残页提示后院有封条。",
          status: "active",
          relatedCharacters: ["林远"],
          firstSeenChapter: 1,
          lastTouchedChapter: 1,
          evidence: ["林远在禁区残页上看见封条图案。"],
        },
      ],
    });
    await writeDraft(projectDir, 5, "林远回到账房，发现账目暗页仍在记录账目。");

    const plan = await buildCommitPlanFromProject({ projectDir, chapter: 5 });

    expect(plan.staleHookWarnings).toEqual([
      expect.objectContaining({
        id: "h-old",
        title: "禁区残页",
        chaptersSinceTouched: 4,
      }),
    ]);

    const report = await commitFastDraft({
      projectDir,
      chapter: 5,
      commitPlan: plan.commitPlan!,
    });

    expect(report.passed).toBe(true);
    expect(report.hookTracking?.staleHookWarnings).toEqual(plan.staleHookWarnings);
    const diagnostics = JSON.parse(await readFile(join(projectDir, "diagnostics", "commit-chapter-0005.json"), "utf-8"));
    expect(diagnostics.details.hookTracking.staleHookWarnings).toEqual(plan.staleHookWarnings);
  });

  it("逐条收口：声明回收伏笔 A → resolved；B 只是被提到 → 仍 active（regression Fix 1）", async () => {
    // Seed two active hooks
    const projectDir = await createHookProject();
    await seedHooks(projectDir, {
      hooks: [
        {
          id: "h-ledger",
          title: "账目",
          description: "账房账目记录外院账目。",
          status: "active",
          relatedCharacters: ["林远"],
          firstSeenChapter: 1,
          lastTouchedChapter: 1,
          evidence: ["账房发现账目。"],
        },
        {
          id: "h-token",
          title: "破损信物",
          description: "破损信物来源不明。",
          status: "active",
          relatedCharacters: ["林远"],
          firstSeenChapter: 1,
          lastTouchedChapter: 1,
          evidence: ["林远捡到破损信物。"],
        },
      ],
    });

    // Draft: hook A (账目) is resolved with resolution phrase; hook B (破损信物) is merely mentioned
    await writeDraft(projectDir, 2, [
      "林远终于将账目的来源查清了，账房黑幕水落石出，真相大白于天下。",
      "他的口袋里还揣着那枚破损信物，但其中的秘密依然未解。",
    ].join("\n\n"));

    const plan = await buildCommitPlanFromProject({ projectDir, chapter: 2, declaration: ledgerResolvedDeclaration(2) });
    expect(plan.passed).toBe(true);

    const report = await commitFastDraft({
      projectDir,
      chapter: 2,
      commitPlan: plan.commitPlan!,
    });
    expect(report.passed).toBe(true);

    const hookPool = await readHookPool(projectDir);

    // Hook A must be resolved
    const hookA = hookPool.hooks.find((hook) => hook.id === "h-ledger");
    expect(hookA, "hook A (账目) should exist in pool after commit").toBeDefined();
    expect(hookA!.status).toBe("resolved");

    // Hook B must remain active (monotonicity: whole-chapter resolution must NOT bleed onto B)
    const hookB = hookPool.hooks.find((hook) => hook.id === "h-token");
    expect(hookB, "hook B (破损信物) should exist in pool after commit").toBeDefined();
    expect(hookB!.status).toBe("active");
  });

  it("monotonicity: resolved hook stays resolved when merely mentioned in next chapter without resolution phrase (Test C)", async () => {
    // Chapter N: seed an active hook, then commit a draft that resolves it
    const projectDir = await createHookProject();
    await seedHooks(projectDir, {
      hooks: [
        {
          id: "h-ledger",
          title: "账目",
          description: "账房账目记录外院账目。",
          status: "active",
          relatedCharacters: ["林远"],
          firstSeenChapter: 1,
          lastTouchedChapter: 1,
          evidence: ["账房发现账目。"],
        },
      ],
    });

    // Chapter N draft contains a resolution phrase → hook becomes resolved
    await writeDraft(projectDir, 2, [
      "林远终于将账目的来源查清了，账房黑幕水落石出，真相大白于天下。",
    ].join("\n\n"));

    const planN = await buildCommitPlanFromProject({ projectDir, chapter: 2, declaration: ledgerResolvedDeclaration(2) });
    expect(planN.passed).toBe(true);

    const reportN = await commitFastDraft({
      projectDir,
      chapter: 2,
      commitPlan: planN.commitPlan!,
    });
    expect(reportN.passed).toBe(true);

    // Verify hook is resolved after chapter N
    const hookPoolAfterN = await readHookPool(projectDir);
    const hookAfterN = hookPoolAfterN.hooks.find((h) => h.id === "h-ledger");
    expect(hookAfterN, "hook should exist after chapter N commit").toBeDefined();
    expect(hookAfterN!.status).toBe("resolved");

    // Chapter N+1: draft merely mentions the hook but contains NO resolution phrase
    await writeDraft(projectDir, 3, [
      "林远回想起那本账目，记录着外院那些陈年旧事。",
    ].join("\n\n"));

    const planN1 = await buildCommitPlanFromProject({ projectDir, chapter: 3 });
    expect(planN1.passed).toBe(true);

    const reportN1 = await commitFastDraft({
      projectDir,
      chapter: 3,
      commitPlan: planN1.commitPlan!,
    });
    expect(reportN1.passed).toBe(true);

    // MONOTONICITY: hook must remain resolved — must NOT be reactivated to active
    const hookPoolAfterN1 = await readHookPool(projectDir);
    const hookAfterN1 = hookPoolAfterN1.hooks.find((h) => h.id === "h-ledger");
    expect(hookAfterN1, "hook should still exist after chapter N+1 commit").toBeDefined();
    expect(hookAfterN1!.status).toBe("resolved");
  });

  it("adds a bounded hook tracking context section for active and recently touched hooks", async () => {
    const projectDir = await createHookProject();
    await seedHooks(projectDir, {
      hooks: [
        trackedHook("h-ledger", "账目", 4),
        trackedHook("h-token", "破损信物", 3),
        trackedHook("h-shadow", "黑影暗号", 2),
        trackedHook("h-wall", "后墙异常响动", 1),
        trackedHook("h-blood", "血痕", 1),
        trackedHook("h-old", "禁区残页", 1),
      ],
    });

    const context = await buildWriterContext({
      projectDir,
      chapter: 5,
      chapterGoal: "承接账房线索。",
    });
    const hookTracking = context.sections.find((section) => section.name === "hook_tracking")
      ?.content as HookTrackingContext | undefined;

    expect(hookTracking).toBeDefined();
    expect(hookTracking?.activeHooks.length).toBeLessThanOrEqual(8);
    expect(hookTracking?.activeHooks[0]).toMatchObject({
      id: "h-ledger",
      title: "账目",
      lastTouchedChapter: 4,
      evidence: [expect.stringContaining("账目")],
      nextActionHint: "继续追查账目。",
      relatedLocations: ["账房"],
      relatedCharacters: ["林远"],
    });
    expect(hookTracking?.recentlyTouchedHooks).toHaveLength(5);
    expect(hookTracking?.staleHookWarnings).toEqual([
      expect.objectContaining({ id: "h-wall", chaptersSinceTouched: 4 }),
      expect.objectContaining({ id: "h-blood", chaptersSinceTouched: 4 }),
      expect.objectContaining({ id: "h-old", chaptersSinceTouched: 4 }),
    ]);
    expect(hookTracking?.hookCarryForwardInstruction).toContain("不要一次性全部解开");
    expect(hookTracking?.hookCarryForwardInstruction).toContain("账目");
  });

  // 声明驱动的伏笔收口：过去伏笔只能靠 HOOK_DONE_KEYWORDS 正则收口，模型换个说法（无完成词）就收不掉，
  // 于是伏笔一直挂 active、越堆越多（Codex 报告的「陈旧线索一路涨」同源）。线索早已走声明回收通道，伏笔漏了。
  // 本组用例验证：模型声明 resolvedForeshadowing 命中已有活跃伏笔时直接标 resolved；指向不存在的不误收口；
  // 无声明时行为与旧正则一字不差。题材中立：只做标题/证据比对，绝不新增完成词表。
  describe("声明驱动的伏笔收口（resolvedForeshadowing 命中已有活跃伏笔 → resolved）", () => {
    it("模型换说法回收（无正则完成词）：声明命中已有活跃伏笔 → 标 resolved；同草稿无声明 → 仍 active（对照）", async () => {
      const draft = [
        "# 第2章",
        "",
        "陆青岚循着密道来到组织后院，在一处石室里翻出玄鹤当年留下的绝笔。",
        "",
        "字里行间，她终于明白恩师三个月前并非叛逃，而是被青衡宗掳走囚禁。",
      ].join("\n");
      const declaration: ChapterDeltaDeclaration = {
        chapter: 2,
        mainEvent: {
          summary: "陆青岚查明师父玄鹤失踪真相",
          quote: "陆青岚循着密道来到组织后院，在一处石室里翻出玄鹤当年留下的绝笔。",
        },
        seededForeshadowing: [],
        resolvedForeshadowing: [
          {
            summary: "师父玄鹤失踪之谜揭晓",
            quote: "字里行间，她终于明白恩师三个月前并非叛逃，而是被青衡宗掳走囚禁。",
            targetThreadHint: "师父玄鹤失踪",
          },
        ],
        resourceDeltas: [],
        keyLeads: [],
      };

      // 对照组：同一草稿、不传声明 → 正则没有完成词可命中 → 伏笔仍 active（证明是声明在补这个洞）。
      const controlDir = await createHookProject();
      await seedHooks(controlDir, { hooks: [masterHook()] });
      await writeDraft(controlDir, 2, draft);
      const controlPlan = await buildCommitPlanFromProject({ projectDir: controlDir, chapter: 2 });
      const controlReport = await commitFastDraft({ projectDir: controlDir, chapter: 2, commitPlan: controlPlan.commitPlan! });
      expect(controlReport.passed).toBe(true);
      const controlHook = (await readHookPool(controlDir)).hooks.find((hook) => hook.id === "h-master");
      expect(controlHook?.status).toBe("active");

      // 实验组：传声明 → 命中活跃伏笔「师父玄鹤失踪」→ 标 resolved（哪怕正文用词完全不同、无完成词）。
      const projectDir = await createHookProject();
      await seedHooks(projectDir, { hooks: [masterHook()] });
      await writeDraft(projectDir, 2, draft);
      const plan = await buildCommitPlanFromProject({ projectDir, chapter: 2, declaration });
      expect(plan.passed).toBe(true);

      const report = await commitFastDraft({ projectDir, chapter: 2, commitPlan: plan.commitPlan! });
      expect(report.passed).toBe(true);

      const hook = (await readHookPool(projectDir)).hooks.find((h) => h.id === "h-master");
      expect(hook, "seeded 活跃伏笔应仍在池中").toBeDefined();
      expect(hook!.status).toBe("resolved");
      expect(hook!.resolvedAtChapter).toBe(2);
      // 复用既有伏笔身份，绝不因回收另起一条新伏笔
      expect((await readHookPool(projectDir)).hooks.filter((h) => h.title === "师父玄鹤失踪")).toHaveLength(1);
    });

    it("回收声明指向不存在的伏笔 → 宁可不动：不误收口已有伏笔、不凭空新建", async () => {
      const projectDir = await createHookProject();
      await seedHooks(projectDir, { hooks: [masterHook()] });
      await writeDraft(projectDir, 2, [
        "# 第2章",
        "",
        "陆青岚在集市上买了些干粮，随口和摊主聊了几句家常。",
      ].join("\n"));

      const declaration: ChapterDeltaDeclaration = {
        chapter: 2,
        mainEvent: {
          summary: "陆青岚采买干粮",
          quote: "陆青岚在集市上买了些干粮，随口和摊主聊了几句家常。",
        },
        seededForeshadowing: [],
        resolvedForeshadowing: [
          {
            summary: "买干粮的小事",
            quote: "陆青岚在集市上买了些干粮，随口和摊主聊了几句家常。",
            targetThreadHint: "集市买干粮",
          },
        ],
        resourceDeltas: [],
        keyLeads: [],
      };

      const plan = await buildCommitPlanFromProject({ projectDir, chapter: 2, declaration });
      expect(plan.passed).toBe(true);
      const report = await commitFastDraft({ projectDir, chapter: 2, commitPlan: plan.commitPlan! });
      expect(report.passed).toBe(true);

      const pool = await readHookPool(projectDir);
      // 已有伏笔没被这条对不上的回收声明误标 resolved
      const master = pool.hooks.find((hook) => hook.id === "h-master");
      expect(master?.status).toBe("active");
      // 也没凭空造出「集市买干粮」这条新伏笔
      expect(pool.hooks.some((hook) => hook.title.includes("集市买干粮") || hook.title.includes("买干粮"))).toBe(false);
    });
  });
});

async function createHookProject(input?: {
  readonly genre?: string;
  readonly premise?: string;
  readonly mainCharacterName?: string;
}): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "story-engine-hook-tracking-"));
  const { projectDir } = await createStoryProject({
    rootDir,
    title: "Hook Tracking Story",
    genre: input?.genre ?? "xianxia",
    premise: input?.premise ?? "林远追查外院账房黑幕。",
    mainCharacterName: input?.mainCharacterName ?? "林远",
  });
  await writeFile(
    join(projectDir, "story", "location-bible.json"),
    `${JSON.stringify({
      version: "v0",
      locations: ["账房", "库房", "外院"].map((name, index) => ({
        id: `loc-${index}`,
        name,
        type: index === 0 ? "opening" : "scene",
      })),
    }, null, 2)}\n`,
    "utf-8",
  );
  return projectDir;
}

async function writeDraft(projectDir: string, chapter: number, content: string): Promise<void> {
  await writeFile(
    join(projectDir, "drafts", "fast", `chapter-${String(chapter).padStart(4, "0")}.md`),
    `# 第${chapter}章\n\n${content}\n`,
    "utf-8",
  );
}

async function seedHooks(projectDir: string, hookPool: HookPool): Promise<void> {
  await writeFile(join(projectDir, "story", "hooks.json"), `${JSON.stringify(hookPool, null, 2)}\n`, "utf-8");
}

/** 一条已埋下、仍活跃的跨章伏笔（师父失踪），用于验证声明驱动的收口。 */
function masterHook(): HookPool["hooks"][number] {
  return {
    id: "h-master",
    title: "师父玄鹤失踪",
    description: "师父玄鹤三个月前离奇失踪，去向不明。",
    status: "active",
    relatedCharacters: ["陆青岚"],
    firstSeenChapter: 1,
    lastTouchedChapter: 1,
    evidence: ["师父玄鹤三个月前离奇失踪。"],
  };
}

function trackedHook(id: string, title: string, lastTouchedChapter: number): HookPool["hooks"][number] {
  return {
    id,
    title,
    description: `${title}仍未解释。`,
    status: "active",
    relatedCharacters: ["林远"],
    firstSeenChapter: 1,
    lastTouchedChapter,
    evidence: [`林远再次提到${title}。`],
    nextActionHint: `继续追查${title}。`,
    relatedLocations: ["账房"],
  };
}
