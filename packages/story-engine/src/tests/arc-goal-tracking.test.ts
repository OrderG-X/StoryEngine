import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { expireStaleArcGoals } from "../arc-goal-tracking.js";
import { commitFastDraft } from "../commit-engine.js";
import { buildCommitPlanFromProject } from "../commit-plan-builder.js";
import { checkDraftContinuity } from "../continuity-quality-check.js";
import { buildWriterContext, type ArcGoalsContext } from "../context-gateway.js";
import { createStoryProject, readArcGoalPool, readHookPool, readThreadPool } from "../project-store.js";
import { chaptersSinceTouched } from "../stale-reminder-policy.js";
import type { ChapterDeltaDeclaration } from "../chapter-delta.js";
import type { ArcGoalPool } from "../types.js";

describe("StoryEngine-NG Arc Goal Tracking", () => {
  it("creates arc goals from ledger pressure and damaged token clues", async () => {
    const projectDir = await createArcProject();
    await writeDraft(projectDir, 1, [
      "林远在外院园圃被克扣月钱，发现账目牵出账目。",
      "他又看见破损信物上的暗号，意识到信物用途可能和账房有关。",
    ].join("\n\n"));

    const plan = await buildCommitPlanFromProject({ projectDir, chapter: 1 });

    expect(plan.arcGoalUpdates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: "查清资源账目",
        status: "active",
        scope: "main_arc",
        firstSeenChapter: 1,
        lastTouchedChapter: 1,
        evidence: expect.arrayContaining([expect.stringContaining("账目")]),
        relatedCharacters: ["林远"],
        relatedLocations: expect.arrayContaining(["外院", "园圃", "账房"]),
      }),
      expect.objectContaining({
        title: "查明破损信物用途",
        status: "active",
        scope: "mini_arc",
      }),
    ]));

    const report = await commitFastDraft({ projectDir, chapter: 1, commitPlan: plan.commitPlan! });

    expect(report.passed).toBe(true);
    expect(report.arcGoalTracking?.introducedGoals.length).toBeGreaterThan(0);
    await expect(readArcGoalPool(projectDir)).resolves.toMatchObject({
      goals: expect.arrayContaining([
        expect.objectContaining({ title: "查清资源账目", status: "active" }),
        expect.objectContaining({ title: "查明破损信物用途", status: "active" }),
      ]),
    });
    await expect(readHookPool(projectDir)).resolves.toMatchObject({
      hooks: expect.not.arrayContaining([
        expect.objectContaining({ title: "查清资源账目" }),
      ]),
    });
    await expect(readThreadPool(projectDir)).resolves.toMatchObject({
      threads: expect.not.arrayContaining([
        expect.objectContaining({ title: "查清资源账目" }),
      ]),
    });
  });

  it("touches existing goals, bounds evidence, and keeps completed goals completed", async () => {
    const projectDir = await createArcProject();
    await seedArcGoals(projectDir, {
      goals: [
        {
          id: "arc-ledger",
          title: "查清资源账目",
          status: "active",
          scope: "main_arc",
          firstSeenChapter: 1,
          lastTouchedChapter: 1,
          targetChapters: 10,
          evidence: ["旧证据1", "旧证据2", "旧证据3", "旧证据4", "旧证据5"],
          nextActionHint: "继续查外院账目。",
          relatedCharacters: ["林远"],
          relatedLocations: ["外院"],
        },
        {
          id: "arc-token",
          title: "查明破损信物用途",
          status: "completed",
          scope: "mini_arc",
          firstSeenChapter: 1,
          lastTouchedChapter: 3,
          targetChapters: 5,
          evidence: ["林远已经解决破损信物用途。"],
        },
      ],
    });
    await writeDraft(projectDir, 4, "林远再次看见账目和账目，确认账房仍在转移外院资源。破损信物也被旁人提起。");

    const plan = await buildCommitPlanFromProject({ projectDir, chapter: 4 });

    expect(plan.arcGoalUpdates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "arc-ledger",
        status: "touched",
        lastTouchedChapter: 4,
      }),
      expect.objectContaining({
        id: "arc-token",
        status: "completed",
        lastTouchedChapter: 4,
      }),
    ]));
    await commitFastDraft({ projectDir, chapter: 4, commitPlan: plan.commitPlan! });
    const pool = await readArcGoalPool(projectDir);
    expect(pool.goals.find((goal) => goal.id === "arc-ledger")).toMatchObject({
      status: "touched",
      lastTouchedChapter: 4,
    });
    expect(pool.goals.find((goal) => goal.id === "arc-ledger")?.evidence.length).toBeLessThanOrEqual(5);
    expect(pool.goals.find((goal) => goal.id === "arc-token")).toMatchObject({
      status: "completed",
      lastTouchedChapter: 4,
    });
  });

  it("warns about stale arc goals without blocking commit", async () => {
    const projectDir = await createArcProject();
    await seedArcGoals(projectDir, {
      goals: [
        {
          id: "arc-stale",
          title: "摆脱外院管事打压",
          status: "active",
          scope: "mini_arc",
          firstSeenChapter: 1,
          lastTouchedChapter: 1,
          evidence: ["林远被管事打压。"],
        },
      ],
    });
    await writeDraft(projectDir, 7, "林远决定先去大门看看，暂时没有处理旧目标。");

    const plan = await buildCommitPlanFromProject({ projectDir, chapter: 7 });

    expect(plan.staleGoalWarnings).toEqual([
      expect.objectContaining({
        id: "arc-stale",
        chaptersSinceTouched: 6,
      }),
    ]);
    const report = await commitFastDraft({ projectDir, chapter: 7, commitPlan: plan.commitPlan! });

    expect(report.passed).toBe(true);
    expect(report.arcGoalTracking?.staleGoalWarnings).toEqual(plan.staleGoalWarnings);
    const diagnostics = JSON.parse(await readFile(join(projectDir, "diagnostics", "commit-chapter-0007.json"), "utf-8"));
    expect(diagnostics.details.arcGoalTracking.staleGoalWarnings).toEqual(plan.staleGoalWarnings);
  });

  it("adds arc_goals context and continuity warnings for missed active goals", async () => {
    const projectDir = await createArcProject();
    await seedArcGoals(projectDir, {
      goals: [
        arcGoal("arc-ledger", "查清资源账目", 5),
        arcGoal("arc-token", "查明破损信物用途", 4),
      ],
    });

    const context = await buildWriterContext({
      projectDir,
      chapter: 6,
      chapterGoal: "继续推进小卷目标。",
    });
    const arcGoals = context.sections.find((section) => section.name === "arc_goals")?.content as ArcGoalsContext | undefined;

    expect(arcGoals).toBeDefined();
    expect(arcGoals?.activeGoals[0]).toMatchObject({
      id: "arc-ledger",
      title: "查清资源账目",
      lastTouchedChapter: 5,
    });
    expect(arcGoals?.arcCarryForwardInstruction).toContain("当前小卷目标");
    expect(arcGoals?.arcCarryForwardInstruction).toContain("查清资源账目");

    const continuityReport = checkDraftContinuity({
      chapter: 6,
      draftContent: "林远只在大门看云，和路边弟子闲谈天气。",
      continuity: {
        recentEvents: [],
        openLeads: [],
        activeConflicts: [],
        discoveries: [],
        recentLocations: [],
        recentCharacters: [],
        carryForwardInstruction: "暂无前情承接要求。",
      },
      arcGoals,
    });

    expect(continuityReport.passed).toBe(true);
    expect(continuityReport.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "warning", type: "arc_goals_not_referenced" }),
    ]));
  });

  it("从 ChapterDelta 声明题材中立地确立主线目标（旧关键词正则在非修仙正文上颗粒无收）", async () => {
    const projectDir = await createArcProject("沈砚", "mystery", "沈砚追查雾港码头凶案。");
    const draft = [
      "沈砚蹲在雾港码头边，盯着那具浮尸，眉头越皱越紧。",
      "他心里只剩一个念头：查明这桩码头凶案的真凶，不查清绝不收手。",
    ].join("\n\n");
    await writeDraft(projectDir, 1, draft);
    const declaration: ChapterDeltaDeclaration = {
      chapter: 1,
      mainEvent: { summary: "码头发现浮尸", quote: "沈砚蹲在雾港码头边，盯着那具浮尸，眉头越皱越紧。" },
      seededForeshadowing: [],
      resolvedForeshadowing: [],
      resourceDeltas: [],
      keyLeads: [],
      charactersPresent: [],
      arcGoalProgress: [
        { summary: "查明码头凶案真凶", progress: "introduced", scope: "main_arc", quote: "他心里只剩一个念头：查明这桩码头凶案的真凶，不查清绝不收手。" },
      ],
    };

    // 无声明：修仙关键词表在悬疑正文上匹配不到任何目标 → 零主线目标（坐实旧路径的题材依赖）。
    const withoutDeclaration = await buildCommitPlanFromProject({ projectDir, chapter: 1 });
    expect(withoutDeclaration.arcGoalUpdates).toHaveLength(0);

    // 有声明：题材中立地确立目标，标题=声明 summary、层级=声明 scope、证据=已校验的原句。
    const withDeclaration = await buildCommitPlanFromProject({ projectDir, chapter: 1, declaration });
    expect(withDeclaration.arcGoalUpdates).toEqual([
      expect.objectContaining({
        title: "查明码头凶案真凶",
        scope: "main_arc",
        status: "active",
        firstSeenChapter: 1,
        lastTouchedChapter: 1,
        evidence: expect.arrayContaining([expect.stringContaining("查明这桩码头凶案的真凶")]),
      }),
    ]);
  });

  it("声明经 targetGoalHint 归到已存在目标、标 completed（不把一个目标拆成好几条）", async () => {
    const projectDir = await createArcProject("沈砚", "mystery", "沈砚追查雾港码头凶案。");
    await seedArcGoals(projectDir, {
      goals: [
        {
          id: "arc-case",
          title: "查明码头凶案真凶",
          status: "active",
          scope: "main_arc",
          firstSeenChapter: 1,
          lastTouchedChapter: 1,
          targetChapters: 10,
          evidence: ["他心里只剩一个念头：查明这桩码头凶案的真凶。"],
          relatedCharacters: ["沈砚"],
        },
      ],
    });
    const draft = "沈砚在停尸房比对刀口与那截铁钩，终于指认出真凶就是仓库管事周三。";
    await writeDraft(projectDir, 5, draft);
    const declaration: ChapterDeltaDeclaration = {
      chapter: 5,
      mainEvent: { summary: "指认真凶", quote: draft },
      seededForeshadowing: [],
      resolvedForeshadowing: [],
      resourceDeltas: [],
      keyLeads: [],
      charactersPresent: [],
      arcGoalProgress: [
        { summary: "凶案告破", progress: "completed", targetGoalHint: "查明码头凶案真凶", quote: draft },
      ],
    };

    const plan = await buildCommitPlanFromProject({ projectDir, chapter: 5, declaration });

    // 只归到既有的 arc-case（复用 id/标题），标 completed；不新建、不分裂。
    expect(plan.arcGoalUpdates).toEqual([
      expect.objectContaining({
        id: "arc-case",
        title: "查明码头凶案真凶",
        status: "completed",
        lastTouchedChapter: 5,
      }),
    ]);
  });

  it("does not let FastDraft update formal arc goal state", async () => {
    const projectDir = await createArcProject();
    await expect(readArcGoalPool(projectDir)).resolves.toEqual({ goals: [] });
    await expect(access(join(projectDir, "chapters", "0001.md"))).rejects.toThrow();
  });

  // ===== r7：阶段目标生命周期（自动蛰伏 + 披露 + 复活）与停滞提醒里程碑制 =====

  it("expireStaleArcGoals：mini_arc 恰好 14 章不蛰伏、15 章蛰伏；main_arc 与已完结目标绝不动", () => {
    const pool: ArcGoalPool = {
      goals: [
        { ...arcGoal("arc-14", "十四章目标", 6), scope: "mini_arc" },
        { ...arcGoal("arc-15", "十五章目标", 5), scope: "mini_arc" },
        { ...arcGoal("arc-main", "主线目标", 1), scope: "main_arc" },
        { ...arcGoal("arc-done", "已完成目标", 1), scope: "mini_arc", status: "completed" },
        { ...arcGoal("arc-already", "已蛰伏目标", 1), scope: "mini_arc", status: "stale" },
      ],
    };

    const result = expireStaleArcGoals({ pool, chapter: 20 });

    expect(result.expired).toEqual([
      expect.objectContaining({ id: "arc-15", chaptersSinceTouched: 15, scope: "mini_arc" }),
    ]);
    const byId = new Map(result.pool.goals.map((goal) => [goal.id, goal]));
    expect(byId.get("arc-14")?.status).toBe("active");
    expect(byId.get("arc-15")?.status).toBe("stale");
    expect(byId.get("arc-main")?.status).toBe("active"); // 主线 idle 19 也不自动蛰伏
    expect(byId.get("arc-done")?.status).toBe("completed");
    expect(byId.get("arc-already")?.status).toBe("stale");
  });

  // P2：老书的 arc-goals.json 可能早于 lastTouchedChapter 字段引入（缺字段/null/字符串）。
  // 裸相减得 NaN，而 NaN < 15 恒为 false → 未知停滞时长的目标被直接判成超阈值而自动蛰伏，
  // 这是静默地丢掉用户的叙事承诺。修复后：未知按「本章刚碰过」处理，不蛰伏、不报警。
  it("expireStaleArcGoals：lastTouchedChapter 缺失/null/字符串 → 不蛰伏（NaN 不再做自动清理决策）", () => {
    // 模拟老数据：字段缺失 / null / 字符串 / NaN 四种形态（base 里先把 lastTouchedChapter 摘掉）
    const legacyGoal = (id: string, lastTouchedChapter: unknown): ArcGoalPool["goals"][number] => {
      const { lastTouchedChapter: _dropped, ...base } = arcGoal(id, id, 1);
      // 老数据本来就是畸形态——这里刻意构造类型不允许的形状，用 as 明示「我们知道这是坏数据」
      return {
        ...base,
        scope: "mini_arc",
        ...(lastTouchedChapter === "missing" ? {} : { lastTouchedChapter: lastTouchedChapter as number }),
      } as ArcGoalPool["goals"][number];
    };
    const pool: ArcGoalPool = {
      goals: [
        legacyGoal("arc-missing", "missing"),
        legacyGoal("arc-null", null),
        legacyGoal("arc-string", "第三章"),
        legacyGoal("arc-nan", Number.NaN),
      ],
    };

    const result = expireStaleArcGoals({ pool, chapter: 99 });

    expect(result.expired).toEqual([]); // 一个都不许蛰伏
    for (const goal of result.pool.goals) {
      expect(goal.status).toBe("active");
    }
  });

  it("chaptersSinceTouched：缺字段/null/字符串/NaN/Infinity 一律按「本章刚碰过」（0 章）", () => {
    expect(chaptersSinceTouched(undefined, 20)).toBe(0);
    expect(chaptersSinceTouched(null, 20)).toBe(0);
    expect(chaptersSinceTouched("第五章", 20)).toBe(0);
    expect(chaptersSinceTouched(Number.NaN, 20)).toBe(0);
    expect(chaptersSinceTouched(Number.POSITIVE_INFINITY, 20)).toBe(0);
    // 正常值照算，且永不为负
    expect(chaptersSinceTouched(15, 20)).toBe(5);
    expect(chaptersSinceTouched(25, 20)).toBe(0);
    expect(chaptersSinceTouched(15.7, 20)).toBe(5);
  });

  it("入库路径：久未推进的 mini_arc 被自动蛰伏并写盘+披露（即使本章无目标更新），main_arc 不蛰伏", async () => {
    const projectDir = await createArcProject();
    await seedArcGoals(projectDir, {
      goals: [
        { ...arcGoal("arc-rot", "突破炼气七层瓶颈", 2), scope: "mini_arc" },
        { ...arcGoal("arc-main", "查明师父闭死关真相", 2), scope: "main_arc" },
      ],
    });
    // 中性正文：不含任何目标关键词 → 本章 arcGoalUpdates 为空，蛰伏仍须发生并写盘。
    await writeDraft(projectDir, 30, "林远在通道上走了一天，风把衣角吹得猎猎作响。");

    const plan = await buildCommitPlanFromProject({ projectDir, chapter: 30 });
    expect(plan.arcGoalUpdates ?? []).toHaveLength(0);

    const report = await commitFastDraft({ projectDir, chapter: 30, commitPlan: plan.commitPlan! });

    expect(report.passed).toBe(true);
    expect(report.arcGoalTracking?.expiredArcGoals).toEqual([
      expect.objectContaining({ id: "arc-rot", title: "突破炼气七层瓶颈", chaptersSinceTouched: 28 }),
    ]);
    const pool = await readArcGoalPool(projectDir);
    expect(pool.goals.find((goal) => goal.id === "arc-rot")?.status).toBe("stale");
    expect(pool.goals.find((goal) => goal.id === "arc-main")?.status).toBe("active");
    const diagnostics = JSON.parse(await readFile(join(projectDir, "diagnostics", "commit-chapter-0030.json"), "utf-8"));
    expect(diagnostics.details.arcGoalTracking.expiredArcGoals).toEqual(report.arcGoalTracking?.expiredArcGoals);
  });

  it("复活：已蛰伏目标被声明 targetGoalHint 命中 → 回 touched（写到即恢复）", async () => {
    const projectDir = await createArcProject("沈砚", "mystery", "沈砚追查雾港码头凶案。");
    await seedArcGoals(projectDir, {
      goals: [
        { ...arcGoal("arc-sleep", "查明码头凶案真凶", 1), status: "stale" },
      ],
    });
    const draft = "沈砚重新翻出旧案卷宗，决定继续追查码头凶案的真凶。";
    await writeDraft(projectDir, 40, draft);
    const declaration: ChapterDeltaDeclaration = {
      chapter: 40,
      mainEvent: { summary: "重启旧案调查", quote: draft },
      seededForeshadowing: [],
      resolvedForeshadowing: [],
      resourceDeltas: [],
      keyLeads: [],
      charactersPresent: [],
      arcGoalProgress: [
        { summary: "重启码头凶案调查", progress: "advanced", targetGoalHint: "查明码头凶案真凶", quote: draft },
      ],
    };

    const plan = await buildCommitPlanFromProject({ projectDir, chapter: 40, declaration });

    expect(plan.arcGoalUpdates).toEqual([
      expect.objectContaining({ id: "arc-sleep", status: "touched", lastTouchedChapter: 40 }),
    ]);
    await commitFastDraft({ projectDir, chapter: 40, commitPlan: plan.commitPlan! });
    const pool = await readArcGoalPool(projectDir);
    expect(pool.goals.find((goal) => goal.id === "arc-sleep")?.status).toBe("touched");
  });

  it("停滞目标提醒走里程碑制：idle 8 安静、idle 10 重提；main_arc 长停滞用升级文案", async () => {
    const projectDir = await createArcProject();
    await seedArcGoals(projectDir, {
      goals: [{ ...arcGoal("arc-stale", "摆脱外院管事打压", 1), scope: "mini_arc" }],
    });

    // idle 8：不在新停滞窗口 (6,7]，也不是 10 的倍数 → 安静（数据仍在池子里）。
    await writeDraft(projectDir, 9, "林远决定先去大门看看，暂时没有处理旧目标。");
    const quietPlan = await buildCommitPlanFromProject({ projectDir, chapter: 9 });
    expect(quietPlan.staleGoalWarnings ?? []).toHaveLength(0);

    // idle 10：里程碑重提。
    await writeDraft(projectDir, 11, "林远决定先去大门看看，暂时没有处理旧目标。");
    const remindPlan = await buildCommitPlanFromProject({ projectDir, chapter: 11 });
    expect(remindPlan.staleGoalWarnings).toEqual([
      expect.objectContaining({ id: "arc-stale", scope: "mini_arc", chaptersSinceTouched: 10 }),
    ]);
    expect(remindPlan.staleGoalWarnings?.[0]?.message).toContain("阶段目标");
    expect(remindPlan.staleGoalWarnings?.[0]?.message).toContain("自动蛰伏");

    // main_arc 长停滞（idle 20）：升级文案，且绝不被自动蛰伏。
    await seedArcGoals(projectDir, {
      goals: [{ ...arcGoal("arc-main", "查明师父闭死关真相", 1), scope: "main_arc" }],
    });
    await writeDraft(projectDir, 21, "林远决定先去大门看看，暂时没有处理旧目标。");
    const mainPlan = await buildCommitPlanFromProject({ projectDir, chapter: 21 });
    expect(mainPlan.staleGoalWarnings).toEqual([
      expect.objectContaining({ id: "arc-main", scope: "main_arc", chaptersSinceTouched: 20 }),
    ]);
    expect(mainPlan.staleGoalWarnings?.[0]?.message).toContain("主线不该长期停摆");
  });
});

async function createArcProject(mainCharacterName = "林远", genre = "xianxia", premise = "林远追查外院账目。"): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "story-engine-arc-goals-"));
  const { projectDir } = await createStoryProject({
    rootDir,
    title: "Arc Goal Story",
    genre,
    premise,
    mainCharacterName,
  });
  await seedLocationBible(projectDir, ["外院", "园圃", "账房", "库房"]);
  return projectDir;
}

async function seedLocationBible(projectDir: string, names: readonly string[]): Promise<void> {
  await writeFile(
    join(projectDir, "story", "location-bible.json"),
    `${JSON.stringify({
      version: "v0",
      locations: names.map((name, index) => ({
        id: `loc-${index}`,
        name,
        type: index === 0 ? "opening" : "scene",
      })),
    }, null, 2)}\n`,
    "utf-8",
  );
}

async function writeDraft(projectDir: string, chapter: number, content: string): Promise<void> {
  await writeFile(
    join(projectDir, "drafts", "fast", `chapter-${String(chapter).padStart(4, "0")}.md`),
    `# 第${chapter}章\n\n${content}\n`,
    "utf-8",
  );
}

async function seedArcGoals(projectDir: string, pool: ArcGoalPool): Promise<void> {
  await writeFile(join(projectDir, "story", "arc-goals.json"), `${JSON.stringify(pool, null, 2)}\n`, "utf-8");
}

function arcGoal(id: string, title: string, lastTouchedChapter: number): ArcGoalPool["goals"][number] {
  return {
    id,
    title,
    status: "active",
    scope: "mini_arc",
    firstSeenChapter: 1,
    lastTouchedChapter,
    targetChapters: 5,
    evidence: [`林远继续推进${title}。`],
    relatedCharacters: ["林远"],
    relatedLocations: ["账房"],
    nextActionHint: `继续推进${title}。`,
  };
}
