import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { commitFastDraft } from "../commit-engine.js";
import { buildCommitPlanFromProject } from "../commit-plan-builder.js";
import { checkDraftContinuity } from "../continuity-quality-check.js";
import { buildWriterContext, type StoryThreadsContext } from "../context-gateway.js";
import { mergeThreadTrackingUpdates, expireStaleIntents } from "../lead-intent-tracking.js";
import { createStoryProject, readHookPool, readThreadPool } from "../project-store.js";
import type { ChapterDeltaDeclaration } from "../chapter-delta.js";
import type { NarrativeThread, ThreadPool } from "../types.js";

describe("StoryEngine-NG Lead / Intent Tracking", () => {
  it("extracts nextLead as lead and decision as intent without polluting HookPool", async () => {
    const projectDir = await createThreadProject();
    await writeDraft(projectDir, 1, [
      "林远发现账册暗号指向库房。",
      "林远决定先去库房查账，并准备隐藏破损信物。",
    ].join("\n\n"));

    const plan = await buildCommitPlanFromProject({ projectDir, chapter: 1 });

    expect(plan.passed).toBe(true);
    expect(plan.threadTrackingUpdates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "lead",
        title: expect.stringContaining("账册暗号指向库房"),
        status: "open",
        firstSeenChapter: 1,
        lastTouchedChapter: 1,
        evidence: expect.arrayContaining([expect.stringContaining("账册暗号指向库房")]),
        relatedCharacters: ["林远"],
        relatedLocations: expect.arrayContaining(["库房"]),
      }),
      expect.objectContaining({
        type: "intent",
        title: expect.stringContaining("林远决定先去库房"),
        status: "open",
        evidence: expect.arrayContaining([expect.stringContaining("决定先去库房查账")]),
      }),
    ]));
    expect(plan.threadTrackingUpdates?.every((update) => update.title.length <= 18)).toBe(true);

    const report = await commitFastDraft({
      projectDir,
      chapter: 1,
      commitPlan: plan.commitPlan!,
    });

    expect(report.passed).toBe(true);
    expect(report.threadTracking?.introducedThreads.length).toBeGreaterThan(0);
    await expect(readThreadPool(projectDir)).resolves.toMatchObject({
      threads: expect.arrayContaining([
        expect.objectContaining({ type: "lead", status: "open", lastTouchedChapter: 1 }),
        expect.objectContaining({ type: "intent", status: "open", lastTouchedChapter: 1 }),
      ]),
    });
    await expect(readHookPool(projectDir)).resolves.toMatchObject({
      hooks: expect.not.arrayContaining([
        expect.objectContaining({ title: expect.stringContaining("去库房") }),
        expect.objectContaining({ title: expect.stringContaining("准备隐藏") }),
      ]),
    });
  });

  it("悬念线索由 lead/intent 通道追踪；伏笔池不再从正文自发建条目（词表已摘除）", async () => {
    const projectDir = await createThreadProject();
    await writeDraft(projectDir, 1, [
      "后墙异常响动，黑影暗号仍未解开。",
      "林远打算夜探账房，查清后墙异常响动。",
    ].join("\n\n"));

    const plan = await buildCommitPlanFromProject({ projectDir, chapter: 1 });

    // 2026-08-12：HOOK_KEYWORDS 题材词表摘除后，纯正文不再自发造伏笔——同一悬念仍由线索通道完整追踪，不丢。
    expect(plan.hookTrackingUpdates ?? []).toEqual([]);
    expect(plan.threadTrackingUpdates).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "lead", title: "后墙异常响动" }),
      expect.objectContaining({ type: "intent", title: expect.stringContaining("林远打算夜探账房") }),
    ]));
  });

  it("uses the actual protagonist name for pronoun intent titles", async () => {
    const projectDir = await createThreadProject("林澈");
    await writeDraft(projectDir, 1, [
      "林澈发现账册暗号指向库房。",
      "他决定先去库房查账，并准备隐藏破损信物。",
    ].join("\n\n"));

    const plan = await buildCommitPlanFromProject({ projectDir, chapter: 1 });

    expect(plan.passed).toBe(true);
    expect(plan.semanticSummary?.protagonist).toBe("林澈");
    expect(plan.threadTrackingUpdates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "intent",
        title: expect.stringContaining("林澈决定先去库房"),
      }),
    ]));
    expect(plan.threadTrackingUpdates?.some((update) => update.title.includes("林远"))).toBe(false);
  });

  it("touches existing threads, bounds evidence, and only marks done on explicit completion", async () => {
    const projectDir = await createThreadProject();
    await seedThreads(projectDir, {
      threads: [
        {
          id: "lead-ledger-code",
          type: "lead",
          title: "账册暗号指向库房",
          status: "open",
          firstSeenChapter: 1,
          lastTouchedChapter: 1,
          evidence: ["旧证据1", "旧证据2", "旧证据3", "旧证据4", "旧证据5"],
          nextActionHint: "继续查账册暗号。",
          relatedCharacters: ["林远"],
          relatedLocations: ["库房"],
        },
      ],
    });
    await writeDraft(projectDir, 2, "林远重新核对账册暗号指向库房，仍没有完全问清楚来源。");

    const touched = await buildCommitPlanFromProject({ projectDir, chapter: 2 });

    expect(touched.threadTrackingUpdates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "lead-ledger-code",
        status: "touched",
        lastTouchedChapter: 2,
      }),
    ]));

    const touchedReport = await commitFastDraft({
      projectDir,
      chapter: 2,
      commitPlan: touched.commitPlan!,
    });

    expect(touchedReport.passed).toBe(true);
    let threadPool = await readThreadPool(projectDir);
    const thread = threadPool.threads.find((item) => item.id === "lead-ledger-code");
    expect(thread?.status).toBe("touched");
    expect(thread?.lastTouchedChapter).toBe(2);
    expect(thread?.evidence.length).toBeLessThanOrEqual(5);

    await writeDraft(projectDir, 3, "林远已经找到账册暗号指向库房的来源，确认完毕。");
    const done = await buildCommitPlanFromProject({ projectDir, chapter: 3 });

    expect(done.threadTrackingUpdates).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "lead-ledger-code", status: "done" }),
    ]));
    await commitFastDraft({ projectDir, chapter: 3, commitPlan: done.commitPlan! });
    threadPool = await readThreadPool(projectDir);
    expect(threadPool.threads.find((item) => item.id === "lead-ledger-code")?.status).toBe("done");
  });

  it("keeps future completion language open but marks explicit lead and intent completion done", async () => {
    const projectDir = await createThreadProject();
    await writeDraft(projectDir, 1, "林远准备查清后墙异常响动，明日再确认后墙暗号。");

    const futurePlan = await buildCommitPlanFromProject({ projectDir, chapter: 1 });

    expect(futurePlan.threadTrackingUpdates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "lead",
        title: "后墙异常响动",
        status: "open",
      }),
    ]));
    expect(futurePlan.threadTrackingUpdates?.some((update) => update.status === "done")).toBe(false);

    await commitFastDraft({ projectDir, chapter: 1, commitPlan: futurePlan.commitPlan! });
    await writeDraft(projectDir, 2, "林远已经查清后墙异常响动的来源，确认暗号已解。");
    const leadDone = await buildCommitPlanFromProject({ projectDir, chapter: 2 });

    expect(leadDone.threadTrackingUpdates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "lead",
        title: "后墙异常响动",
        status: "done",
      }),
    ]));

    await commitFastDraft({ projectDir, chapter: 2, commitPlan: leadDone.commitPlan! });
    await writeDraft(projectDir, 3, "林远决定去库房查账，准备问清楚账册来源。");
    const intentOpen = await buildCommitPlanFromProject({ projectDir, chapter: 3 });

    expect(intentOpen.threadTrackingUpdates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "intent",
        status: "open",
      }),
    ]));
    expect(intentOpen.threadTrackingUpdates?.filter((update) => update.type === "intent").some((update) => update.status === "done")).toBe(false);

    await commitFastDraft({ projectDir, chapter: 3, commitPlan: intentOpen.commitPlan! });
    await writeDraft(projectDir, 4, "林远已经去过库房查账，并问清楚账册来源，完成这次追查。");
    const intentDone = await buildCommitPlanFromProject({ projectDir, chapter: 4 });

    expect(intentDone.threadTrackingUpdates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "intent",
        status: "done",
      }),
    ]));
  });

  it("marks an existing open lead done when a later chapter answers it with the same concrete anchor", async () => {
    const projectDir = await createThreadProject("周砚");
    await seedThreads(projectDir, {
      threads: [
        {
          id: "lead-k15-owner",
          type: "lead",
          title: "K-15保管人",
          status: "open",
          firstSeenChapter: 11,
          lastTouchedChapter: 11,
          evidence: ["K-15的保管人是谁还没查清。"],
          nextActionHint: "继续查K-15保管人。",
          relatedCharacters: ["周砚"],
        },
      ],
    });
    await writeDraft(projectDir, 12, "周砚翻到封存库登记表，K-15的保管人，是乔宁的父亲。");

    const plan = await buildCommitPlanFromProject({ projectDir, chapter: 12 });

    expect(plan.threadTrackingUpdates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "lead-k15-owner",
        type: "lead",
        status: "done",
        evidence: expect.arrayContaining([expect.stringContaining("K-15的保管人")]),
      }),
    ]));
    await commitFastDraft({ projectDir, chapter: 12, commitPlan: plan.commitPlan! });
    const threadPool = await readThreadPool(projectDir);
    expect(threadPool.threads.find((thread) => thread.id === "lead-k15-owner")?.status).toBe("done");
  });

  it("merges similar intent and lead threads while bounding evidence and deduping relations", async () => {
    const projectDir = await createThreadProject();
    await seedThreads(projectDir, {
      threads: [
        {
          id: "intent-a",
          type: "intent",
          title: "去库房查账",
          status: "open",
          firstSeenChapter: 1,
          lastTouchedChapter: 1,
          evidence: ["旧证据1", "旧证据2", "旧证据3", "旧证据4", "旧证据5"],
          nextActionHint: "去库房查账。",
          relatedCharacters: ["林远"],
          relatedLocations: ["库房"],
        },
        {
          id: "intent-b",
          type: "intent",
          title: "明日去库房查账册",
          status: "open",
          firstSeenChapter: 2,
          lastTouchedChapter: 2,
          evidence: ["明日去库房查账册。"],
          relatedCharacters: ["林远", "林婉清"],
          relatedLocations: ["库房", "账房"],
        },
        {
          id: "lead-a",
          type: "lead",
          title: "后墙异常响动",
          status: "open",
          firstSeenChapter: 1,
          lastTouchedChapter: 1,
          evidence: ["后墙异常响动。"],
          relatedCharacters: ["林远"],
          relatedLocations: ["账房"],
        },
        {
          id: "lead-b",
          type: "lead",
          title: "调查后墙响动",
          status: "open",
          firstSeenChapter: 2,
          lastTouchedChapter: 2,
          evidence: ["调查后墙响动。"],
          relatedCharacters: ["林远"],
          relatedLocations: ["后墙"],
        },
      ],
    });
    await writeDraft(projectDir, 3, "林远已经去过库房查账，并查清后墙异常响动的来源。");

    const plan = await buildCommitPlanFromProject({ projectDir, chapter: 3 });

    // 2026-09-04 题材中立修复：持久层坍缩摘除了「库房+账→库房查账」「后墙.*响动→后墙异常响动」
    // 等题材专名别名（老测试书残留，会跨题材熔掉不同语义的真线索，如「库房丢账/库房对账」）。
    // 归并只走 B2-2 安全判据（归一后相同/子串包含 + bigram≥0.6 仅限活跃态）：
    //   - 去库房查账 ↔ 明日去库房查账册：归一后子串包含 → 仍归并（mergedCount 1）
    //   - 后墙异常响动 ↔ 调查后墙响动：Jaccard≈0.33 < 0.6，按 legacy-thread-cleanup 设计
    //     「保守阈值，绝不过并」留在持久层，折叠由展示层聚类（非破坏、可展开）处理。
    expect(plan.threadHygieneReport).toMatchObject({
      beforeCount: 4,
      afterCount: 3,
      mergedCount: 1,
      markedDoneCount: expect.any(Number),
    });
    const report = await commitFastDraft({
      projectDir,
      chapter: 3,
      commitPlan: plan.commitPlan!,
    });

    expect(report.passed).toBe(true);
    expect(report.threadTracking?.threadHygieneReport).toMatchObject({
      beforeCount: 4,
      afterCount: 3,
      mergedCount: 1,
    });
    const threadPool = await readThreadPool(projectDir);
    expect(threadPool.threads).toHaveLength(3);
    expect(threadPool.threads).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "intent",
        title: "去库房查账",
        status: "done",
        lastTouchedChapter: 3,
        evidence: expect.any(Array),
        relatedCharacters: expect.arrayContaining(["林远", "林婉清"]),
        relatedLocations: expect.arrayContaining(["库房", "账房"]),
      }),
      expect.objectContaining({
        type: "lead",
        title: "后墙异常响动",
        status: "done",
        lastTouchedChapter: 3,
        relatedLocations: expect.arrayContaining(["账房"]),
      }),
      expect.objectContaining({
        type: "lead",
        title: "调查后墙响动",
        status: "open",
      }),
    ]));
    for (const thread of threadPool.threads) {
      expect(thread.evidence.length).toBeLessThanOrEqual(5);
      expect(new Set(thread.relatedCharacters ?? []).size).toBe((thread.relatedCharacters ?? []).length);
      expect(new Set(thread.relatedLocations ?? []).size).toBe((thread.relatedLocations ?? []).length);
    }
  });

  it("keeps done threads done when they are mentioned again", async () => {
    const projectDir = await createThreadProject();
    await seedThreads(projectDir, {
      threads: [
        {
          id: "lead-ledger-code",
          type: "lead",
          title: "账册暗号指向库房",
          status: "done",
          firstSeenChapter: 1,
          lastTouchedChapter: 3,
          evidence: ["林远已经找到账册暗号指向库房的来源，确认完毕。"],
          nextActionHint: "账册暗号来源已确认。",
          relatedCharacters: ["林远"],
          relatedLocations: ["库房"],
        },
      ],
    });
    await writeDraft(projectDir, 5, "林远路过库房时再次提到账册暗号指向库房，但没有新的追查动作。");

    const plan = await buildCommitPlanFromProject({ projectDir, chapter: 5 });

    expect(plan.threadTrackingUpdates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "lead-ledger-code",
        status: "done",
        lastTouchedChapter: 5,
      }),
    ]));
    expect(plan.staleThreadWarnings).toEqual([]);
    const report = await commitFastDraft({
      projectDir,
      chapter: 5,
      commitPlan: plan.commitPlan!,
    });

    expect(report.passed).toBe(true);
    const threadPool = await readThreadPool(projectDir);
    expect(threadPool.threads.find((item) => item.id === "lead-ledger-code")).toMatchObject({
      status: "done",
      lastTouchedChapter: 5,
    });
    const context = await buildWriterContext({
      projectDir,
      chapter: 6,
      chapterGoal: "继续推进。",
    });
    const storyThreads = context.sections.find((section) => section.name === "story_threads")
      ?.content as StoryThreadsContext | undefined;
    expect(storyThreads?.openLeads.some((thread) => thread.id === "lead-ledger-code")).toBe(false);
    expect(storyThreads?.openIntents.some((thread) => thread.id === "lead-ledger-code")).toBe(false);
    expect(storyThreads?.staleThreadWarnings.some((warning) => warning.id === "lead-ledger-code")).toBe(false);
  });

  it("warns about stale open threads without blocking commit", async () => {
    const projectDir = await createThreadProject();
    await seedThreads(projectDir, {
      threads: [
        {
          id: "intent-night-ledger",
          type: "intent",
          title: "林远夜探账房",
          status: "open",
          firstSeenChapter: 1,
          lastTouchedChapter: 1,
          evidence: ["林远打算夜探账房。"],
          relatedCharacters: ["林远"],
          relatedLocations: ["账房"],
        },
      ],
    });
    await writeDraft(projectDir, 5, "林远决定先去库房查清账册来源。");

    const plan = await buildCommitPlanFromProject({ projectDir, chapter: 5 });

    expect(plan.staleThreadWarnings).toEqual([
      expect.objectContaining({
        id: "intent-night-ledger",
        type: "intent",
        chaptersSinceTouched: 4,
      }),
    ]);
    const report = await commitFastDraft({
      projectDir,
      chapter: 5,
      commitPlan: plan.commitPlan!,
    });

    expect(report.passed).toBe(true);
    expect(report.threadTracking?.staleThreadWarnings).toEqual(plan.staleThreadWarnings);
    const diagnostics = JSON.parse(await readFile(join(projectDir, "diagnostics", "commit-chapter-0005.json"), "utf-8"));
    expect(diagnostics.details.threadTracking.staleThreadWarnings).toEqual(plan.staleThreadWarnings);
    expect(diagnostics.details.threadTracking.threadHygieneReport).toMatchObject({
      beforeCount: 1,
      afterCount: expect.any(Number),
      staleWarningCount: 1,
    });
  });

  // ===== r7：停滞线索提醒里程碑制（新停滞头两章报、长期停滞每 10 章重提；底数始终如实） =====

  it("停滞提醒里程碑制：idle 6 安静但底数照报，idle 10 重提（中文文案）", async () => {
    const projectDir = await createThreadProject();
    await seedThreads(projectDir, {
      threads: [trackedThread("lead-old-wall", "lead", "后墙异常响动", 1)],
    });

    // idle 6：不在新停滞窗口 (3,5]，也不是 10 的倍数 → 本章不提醒；但 hygiene 底数照记（降噪≠静默）。
    await writeDraft(projectDir, 7, "林远在通道上赶路，没顾上旧线索。");
    const quietPlan = await buildCommitPlanFromProject({ projectDir, chapter: 7 });
    expect(quietPlan.staleThreadWarnings ?? []).toHaveLength(0);
    expect(quietPlan.threadHygieneReport).toMatchObject({
      staleWarningCount: 1,
      oldestStaleChaptersSinceTouched: 6,
    });

    // idle 10：里程碑重提，中文文案。
    await writeDraft(projectDir, 11, "林远在通道上赶路，没顾上旧线索。");
    const remindPlan = await buildCommitPlanFromProject({ projectDir, chapter: 11 });
    expect(remindPlan.staleThreadWarnings).toEqual([
      expect.objectContaining({ id: "lead-old-wall", chaptersSinceTouched: 10 }),
    ]);
    expect(remindPlan.staleThreadWarnings?.[0]?.message).toContain("已 10 章没有推进");
  });

  it("停滞提醒按停滞时长降序、每章最多 8 条；底数与最旧停滞照实进 hygiene report", async () => {
    const projectDir = await createThreadProject();
    // 10 条 lead 全部落在里程碑上（idle = 10,20,…,100），提醒截 8 条、底数 10 条。
    await seedThreads(projectDir, {
      threads: Array.from({ length: 10 }, (_, index) =>
        trackedThread(`lead-batch-${index}`, "lead", `旧线索甲乙丙${index}号一直没有下文`, 101 - (index + 1) * 10)),
    });
    await writeDraft(projectDir, 101, "林远在通道上赶路，没顾上旧线索。");

    const plan = await buildCommitPlanFromProject({ projectDir, chapter: 101 });

    expect(plan.staleThreadWarnings).toHaveLength(8);
    const idles = (plan.staleThreadWarnings ?? []).map((warning) => warning.chaptersSinceTouched);
    expect(idles).toEqual([...idles].sort((a, b) => b - a));
    expect(idles[0]).toBe(100);
    expect(plan.threadHygieneReport).toMatchObject({
      staleWarningCount: 10,
      oldestStaleChaptersSinceTouched: 100,
    });
  });

  it("adds story_threads context for open leads and intents", async () => {
    const projectDir = await createThreadProject();
    await seedThreads(projectDir, {
      threads: [
        trackedThread("lead-wall", "lead", "后墙异常响动", 4),
        trackedThread("intent-night", "intent", "林远夜探账房", 3),
        trackedThread("lead-old", "lead", "另一页账本残页被带走", 1),
      ],
    });

    const context = await buildWriterContext({
      projectDir,
      chapter: 5,
      chapterGoal: "承接线索。",
    });
    const threads = context.sections.find((section) => section.name === "story_threads")
      ?.content as StoryThreadsContext | undefined;

    expect(threads).toBeDefined();
    expect(threads?.openLeads[0]).toMatchObject({
      id: "lead-wall",
      title: "后墙异常响动",
      lastTouchedChapter: 4,
    });
    expect(threads?.openIntents[0]).toMatchObject({
      id: "intent-night",
      title: "林远夜探账房",
      lastTouchedChapter: 3,
    });
    expect(threads?.staleThreadWarnings).toEqual([
      expect.objectContaining({ id: "lead-old", chaptersSinceTouched: 4 }),
    ]);
    expect(threads?.threadCarryForwardInstruction).toContain("未完成线索/意图");
    expect(threads?.threadCarryForwardInstruction).toContain("后墙异常响动");
  });

  it("prioritizes injected story_threads and avoids injecting the whole pool", async () => {
    const projectDir = await createThreadProject();
    await seedThreads(projectDir, {
      threads: [
        trackedThread("lead-wall", "lead", "后墙异常响动", 8),
        trackedThread("intent-night", "intent", "林远夜探账房", 7),
        ...Array.from({ length: 67 }, (_, index) => trackedThread(
          `old-${index}`,
          index % 2 === 0 ? "lead" : "intent",
          `旧线程${index}号`,
          1 + (index % 3),
        )),
      ],
    });

    const context = await buildWriterContext({
      projectDir,
      chapter: 9,
      chapterGoal: "只注入优先 thread。",
    });
    const threads = context.sections.find((section) => section.name === "story_threads")
      ?.content as StoryThreadsContext | undefined;

    expect(threads).toBeDefined();
    expect(threads?.openLeads.length).toBeLessThanOrEqual(8);
    expect(threads?.openIntents.length).toBeLessThanOrEqual(8);
    expect(threads?.recentlyTouchedThreads.length).toBeLessThanOrEqual(5);
    expect(threads?.staleThreadWarnings.length).toBeLessThanOrEqual(5);
    expect(threads?.openLeads.map((thread) => thread.id)).toContain("lead-wall");
    expect(threads?.openIntents.map((thread) => thread.id)).toContain("intent-night");
    const instructionTitles = (threads?.threadCarryForwardInstruction.match(/：(.+?)。不要/u)?.[1] ?? "")
      .split("、")
      .filter(Boolean);
    expect(instructionTitles.length).toBeLessThanOrEqual(5);
  });

  it("continuity quality only checks prioritized story_threads injected into context", () => {
    const report = checkDraftContinuity({
      chapter: 10,
      draftContent: "林远赶到后墙，继续听那阵异常响动。",
      continuity: {
        recentEvents: [],
        openLeads: [],
        activeConflicts: [],
        discoveries: [],
        recentLocations: [],
        recentCharacters: [],
        carryForwardInstruction: "暂无前情承接要求。",
      },
      storyThreads: {
        openLeads: [threadContextItem("lead-wall", "lead", "后墙异常响动")],
        openIntents: [],
        recentlyTouchedThreads: [],
        staleThreadWarnings: [],
        threadCarryForwardInstruction: "下一章优先处理未完成线索/意图：后墙异常响动。",
      },
    });

    expect(report.passed).toBe(true);
    expect(report.issues.some((issue) => issue.type === "open_intents_not_referenced")).toBe(false);
    expect(report.matched.leads).toEqual(["后墙异常响动"]);
  });

  // 阶段 3·核心：同义不同表述的回收证据，有声明时归到同一条既有线索（不新建，治线索分裂）。
  it("声明回收：同义证据（无共享锚点）经 targetThreadHint 归到既有线索、标 done、不新建", async () => {
    const projectDir = await createThreadProject();
    await seedThreads(projectDir, {
      threads: [
        {
          id: "lead-hemei",
          type: "lead",
          title: "玄鹤失踪之谜",
          status: "open",
          firstSeenChapter: 1,
          lastTouchedChapter: 1,
          evidence: ["玄鹤失踪三月，组织讳莫如深。"],
          nextActionHint: "继续查玄鹤失踪。",
          relatedCharacters: ["林远"],
        },
      ],
    });
    // 草稿用完全同义、但与「玄鹤失踪」不共享任何具体锚点的表述——正则 dedup 无法归并。
    await writeDraft(projectDir, 5, "林远合上那封泛黄的信笺，终于确认那位授业恩师早已魂断他乡。");

    const declaration: ChapterDeltaDeclaration = {
      chapter: 5,
      mainEvent: {
        summary: "林远确认恩师已死",
        quote: "林远合上那封泛黄的信笺，终于确认那位授业恩师早已魂断他乡。",
      },
      seededForeshadowing: [],
      resolvedForeshadowing: [
        {
          summary: "恩师下落揭晓",
          quote: "林远合上那封泛黄的信笺，终于确认那位授业恩师早已魂断他乡。",
          targetThreadHint: "玄鹤失踪",
        },
      ],
      resourceDeltas: [],
      keyLeads: [],
    };

    const plan = await buildCommitPlanFromProject({ projectDir, chapter: 5, declaration });

    expect(plan.passed).toBe(true);
    // 回收归到既有线索、标 done
    expect(plan.threadTrackingUpdates).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "lead-hemei", type: "lead", status: "done", lastTouchedChapter: 5 }),
    ]));
    // 绝不新建「恩师」相关的第二条线索（治分裂）
    const leadUpdates = plan.threadTrackingUpdates?.filter((update) => update.type === "lead") ?? [];
    expect(leadUpdates.filter((update) => update.id !== "lead-hemei")).toHaveLength(0);
  });

  // 阶段 3·对照：同一草稿不传声明 → 正则无法跨表述归并（既有线索不被这句同义句触碰），旧行为不变。
  it("对照（无声明）：同义句不共享锚点 → 正则不归并、既有线索保持 open、也不新建", async () => {
    const projectDir = await createThreadProject();
    await seedThreads(projectDir, {
      threads: [
        {
          id: "lead-hemei",
          type: "lead",
          title: "玄鹤失踪之谜",
          status: "open",
          firstSeenChapter: 1,
          lastTouchedChapter: 1,
          evidence: ["玄鹤失踪三月，组织讳莫如深。"],
          relatedCharacters: ["林远"],
        },
      ],
    });
    await writeDraft(projectDir, 5, "林远合上那封泛黄的信笺，终于确认那位授业恩师早已魂断他乡。");

    const plan = await buildCommitPlanFromProject({ projectDir, chapter: 5 });

    expect(plan.passed).toBe(true);
    // 无声明：这句同义句不触碰既有线索（无共享锚点）→ 该线索本轮不在 updates 里
    expect(plan.threadTrackingUpdates?.some((update) => update.id === "lead-hemei")).toBe(false);
  });

  // 阶段 3·埋伏笔：声明的 seededForeshadowing 新建线索，标题用声明 summary。
  it("声明埋设：seededForeshadowing 新建 lead，标题取声明 summary", async () => {
    const projectDir = await createThreadProject();
    await writeDraft(projectDir, 1, "林远把一枚刻着奇怪纹路的铜牌塞进袖中，谁也没说。");

    const declaration: ChapterDeltaDeclaration = {
      chapter: 1,
      mainEvent: {
        summary: "林远藏起神秘铜牌",
        quote: "林远把一枚刻着奇怪纹路的铜牌塞进袖中，谁也没说。",
      },
      seededForeshadowing: [
        {
          summary: "纹路铜牌来历成谜",
          quote: "林远把一枚刻着奇怪纹路的铜牌塞进袖中，谁也没说。",
        },
      ],
      resolvedForeshadowing: [],
      resourceDeltas: [],
      keyLeads: [],
    };

    const plan = await buildCommitPlanFromProject({ projectDir, chapter: 1, declaration });

    expect(plan.passed).toBe(true);
    expect(plan.threadTrackingUpdates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "lead",
        title: "纹路铜牌来历成谜",
        status: "open",
        firstSeenChapter: 1,
        evidence: expect.arrayContaining([expect.stringContaining("铜牌塞进袖中")]),
      }),
    ]));
  });

  // 2026-07-04 真机走查：keyLeads 此前只校验未消费，模型申报的关键线索落不到 threads.json。
  it("声明埋设：keyLeads 新建 lead，标题取声明 summary（与 seededForeshadowing 同路径）", async () => {
    const projectDir = await createThreadProject();
    await writeDraft(projectDir, 2, "走廊尽头那扇铁门虚掩着，门缝里漏出一缕不属于这里的冷光。");

    const declaration: ChapterDeltaDeclaration = {
      chapter: 2,
      mainEvent: {
        summary: "林远发现虚掩铁门",
        quote: "走廊尽头那扇铁门虚掩着，门缝里漏出一缕不属于这里的冷光。",
      },
      seededForeshadowing: [],
      resolvedForeshadowing: [],
      resourceDeltas: [],
      keyLeads: [
        {
          summary: "虚掩铁门后的冷光",
          quote: "走廊尽头那扇铁门虚掩着，门缝里漏出一缕不属于这里的冷光。",
        },
      ],
    };

    const plan = await buildCommitPlanFromProject({ projectDir, chapter: 2, declaration });

    expect(plan.passed).toBe(true);
    expect(plan.threadTrackingUpdates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "lead",
        title: "虚掩铁门后的冷光",
        status: "open",
        firstSeenChapter: 2,
        evidence: expect.arrayContaining([expect.stringContaining("铁门虚掩")]),
      }),
    ]));
  });

  it("声明待办：pendingIntents 新建 intent，标题取声明 summary", async () => {
    const projectDir = await createThreadProject();
    await writeDraft(projectDir, 2, "林远把账册收进袖中，决定明日去库房核对账册来源。");

    const declaration: ChapterDeltaDeclaration = {
      chapter: 2,
      mainEvent: {
        summary: "林远收起账册",
        quote: "林远把账册收进袖中，决定明日去库房核对账册来源。",
      },
      seededForeshadowing: [],
      resolvedForeshadowing: [],
      resourceDeltas: [],
      keyLeads: [],
      pendingIntents: [
        {
          summary: "林远明日核对账册来源",
          quote: "林远把账册收进袖中，决定明日去库房核对账册来源。",
        },
      ],
    };

    const plan = await buildCommitPlanFromProject({ projectDir, chapter: 2, declaration });

    expect(plan.passed).toBe(true);
    expect(plan.threadTrackingUpdates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "intent",
        title: "林远明日核对账册来源",
        status: "open",
        evidence: expect.arrayContaining([expect.stringContaining("明日去库房")]),
      }),
    ]));
  });

  // 阶段 3.5（真机冒烟发现）：声明可用时，本章新埋线索只由声明负责，正则不得从多句同义表述各切一条 lead（治 seed 阶段分裂）。
  it("声明可用：正则 lead 让位，同一件事只留声明的 1 条 lead（不再多句各切一条）", async () => {
    const projectDir = await createThreadProject();
    // 草稿里有两句都在讲「师父失踪」——旧行为下正则会切成 2 条 lead。
    await writeDraft(projectDir, 1, [
      "林远在药垄捡到半块残玉，玉上刻着奇怪的编号。",
      "师父失踪已经三个月了，组织讳莫如深。",
      "他捏紧残玉，第一次觉得师父的失踪或许和这块玉有关。",
    ].join("\n\n"));

    const declaration: ChapterDeltaDeclaration = {
      chapter: 1,
      mainEvent: { summary: "林远捡到刻编号的残玉", quote: "林远在药垄捡到半块残玉，玉上刻着奇怪的编号。" },
      seededForeshadowing: [
        { summary: "师父失踪之谜", quote: "师父失踪已经三个月了，组织讳莫如深。" },
      ],
      resolvedForeshadowing: [],
      resourceDeltas: [],
      keyLeads: [],
    };

    const plan = await buildCommitPlanFromProject({ projectDir, chapter: 1, declaration });

    expect(plan.passed).toBe(true);
    const leads = plan.threadTrackingUpdates?.filter((update) => update.type === "lead") ?? [];
    // 只保留声明埋的那一条 lead；正则不得再从「师父失踪已经三个月」等句另切 lead。
    expect(leads).toHaveLength(1);
    expect(leads[0]?.title).toBe("师父失踪之谜");
  });

  // 2026-07-04 r2：声明契约补 pendingIntents 后，声明可用时新 intent 也由声明负责，正则 intent 让位。
  it("声明可用：正则 intent 让位，未声明 pendingIntents 时不再从 decision/正文另造 intent", async () => {
    const projectDir = await createThreadProject();
    await writeDraft(projectDir, 1, [
      "林远捡到半块刻着编号的残玉。",
      "林远决定先去库房查清账册来源。",
    ].join("\n\n"));

    const declaration: ChapterDeltaDeclaration = {
      chapter: 1,
      mainEvent: { summary: "林远捡到残玉", quote: "林远捡到半块刻着编号的残玉。" },
      seededForeshadowing: [{ summary: "编号残玉之谜", quote: "林远捡到半块刻着编号的残玉。" }],
      resolvedForeshadowing: [],
      resourceDeltas: [],
      keyLeads: [],
      decision: { summary: "林远去库房查账", quote: "林远决定先去库房查清账册来源。" },
    };

    const plan = await buildCommitPlanFromProject({ projectDir, chapter: 1, declaration });

    expect(plan.passed).toBe(true);
    expect(plan.threadTrackingUpdates?.some((update) => update.type === "intent")).toBe(false);
  });

  it("无声明时：regex intent 旧行为仍保留", async () => {
    const projectDir = await createThreadProject();
    await writeDraft(projectDir, 1, "林远决定先去库房查清账册来源。");

    const plan = await buildCommitPlanFromProject({ projectDir, chapter: 1 });

    expect(plan.passed).toBe(true);
    expect(plan.threadTrackingUpdates).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "intent", title: expect.stringContaining("林远决定先去库房") }),
    ]));
  });

  it("commit 时自动把超过 9 章未触碰的 open intent 标 stale，并写进报告", async () => {
    const projectDir = await createThreadProject();
    await seedThreads(projectDir, {
      threads: [
        {
          id: "intent-night-ledger",
          type: "intent",
          title: "林远夜探账房",
          status: "open",
          firstSeenChapter: 1,
          lastTouchedChapter: 1,
          evidence: ["林远打算夜探账房。"],
          relatedCharacters: ["林远"],
          relatedLocations: ["账房"],
        },
      ],
    });
    await writeDraft(projectDir, 10, "林远翻开新账册，核对外院账目，把本章入库。");
    const plan = await buildCommitPlanFromProject({ projectDir, chapter: 10 });

    const report = await commitFastDraft({ projectDir, chapter: 10, commitPlan: plan.commitPlan! });

    expect(report.passed).toBe(true);
    expect(report.threadTracking?.expiredIntentThreads).toEqual([
      expect.objectContaining({
        id: "intent-night-ledger",
        type: "intent",
        title: "林远夜探账房",
        chaptersSinceTouched: 9,
      }),
    ]);
    const pool = await readThreadPool(projectDir);
    expect(pool.threads.find((thread) => thread.id === "intent-night-ledger")?.status).toBe("stale");
  });

  it("被明确再次触碰的 stale intent 可恢复 touched，不被永久关闭", async () => {
    const projectDir = await createThreadProject();
    await seedThreads(projectDir, {
      threads: [
        {
          id: "intent-night-ledger",
          type: "intent",
          title: "林远夜探账房",
          status: "stale",
          firstSeenChapter: 1,
          lastTouchedChapter: 1,
          evidence: ["林远打算夜探账房。"],
        },
      ],
    });
    await writeDraft(projectDir, 11, "林远重新决定夜探账房，把后墙那阵响动查清。");

    const plan = await buildCommitPlanFromProject({ projectDir, chapter: 11 });
    expect(plan.threadTrackingUpdates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "intent-night-ledger",
        type: "intent",
        status: "touched",
        lastTouchedChapter: 11,
      }),
    ]));
  });

  it("checks open story threads even when continuity is empty", () => {
    const report = checkDraftContinuity({
      chapter: 4,
      draftContent: "林远只顾着看大门晨雾，没有提及旧线索和行动计划。",
      continuity: {
        recentEvents: [],
        openLeads: [],
        activeConflicts: [],
        discoveries: [],
        recentLocations: [],
        recentCharacters: [],
        carryForwardInstruction: "暂无前情承接要求。",
      },
      storyThreads: {
        openLeads: [threadContextItem("lead-wall", "lead", "后墙异常响动")],
        openIntents: [threadContextItem("intent-night", "intent", "林远夜探账房")],
        recentlyTouchedThreads: [],
        staleThreadWarnings: [],
        threadCarryForwardInstruction: "下一章优先处理未完成线索/意图。",
      },
    });

    expect(report.passed).toBe(true);
    expect(report.score).toBeLessThan(1);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "warning", type: "open_threads_not_referenced" }),
      expect.objectContaining({ severity: "warning", type: "open_intents_not_referenced" }),
    ]));
  });

  it("expireStaleIntents：lastTouchedChapter 缺失/null/字符串/NaN → 一个都不蛰伏", () => {
    const legacy = (id: string, lastTouchedChapter: unknown): ThreadPool["threads"][number] => {
      const { lastTouchedChapter: _dropped, ...base } = trackedThread(id, "intent", id, 1);
      // 老数据本来就是畸形态——这里刻意构造类型不允许的形状，用 as 明示「我们知道这是坏数据」
      return {
        ...base,
        ...(lastTouchedChapter === "missing" ? {} : { lastTouchedChapter: lastTouchedChapter as number }),
      } as ThreadPool["threads"][number];
    };
    const pool: ThreadPool = {
      threads: [
        legacy("t-missing", "missing"),
        legacy("t-null", null),
        legacy("t-string", "第三章"),
        legacy("t-nan", Number.NaN),
      ],
    };

    const result = expireStaleIntents({ pool, chapter: 99 });

    expect(result.expired).toEqual([]);
    for (const thread of result.pool.threads) {
      expect(thread.status).toBe("open");
    }
  });
});

async function createThreadProject(mainCharacterName = "林远"): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "story-engine-thread-tracking-"));
  const isApocalypse = mainCharacterName === "林澈";
  const { projectDir } = await createStoryProject({
    rootDir,
    title: "Thread Tracking Story",
    genre: isApocalypse ? "末日生存" : "xianxia",
    premise: isApocalypse
      ? `${mainCharacterName}在断电旧城区追查无线电与避难所广播真假。`
      : `${mainCharacterName}追查外院账房黑幕。`,
    mainCharacterName,
  });
  await writeFile(
    join(projectDir, "story", "location-bible.json"),
    `${JSON.stringify({
      version: "v0",
      locations: ["库房", "账房", "外院"].map((name, index) => ({
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

async function seedThreads(projectDir: string, threadPool: ThreadPool): Promise<void> {
  await writeFile(join(projectDir, "story", "threads.json"), `${JSON.stringify(threadPool, null, 2)}\n`, "utf-8");
}

function trackedThread(
  id: string,
  type: "lead" | "intent",
  title: string,
  lastTouchedChapter: number,
): ThreadPool["threads"][number] {
  return {
    id,
    type,
    title,
    status: "open",
    firstSeenChapter: 1,
    lastTouchedChapter,
    evidence: [`林远提到${title}。`],
    nextActionHint: `继续处理${title}。`,
    relatedCharacters: ["林远"],
    relatedLocations: ["账房"],
  };
}

function threadContextItem(
  id: string,
  type: "lead" | "intent",
  title: string,
): StoryThreadsContext["openLeads"][number] {
  return {
    id,
    type,
    title,
    status: "open",
    lastTouchedChapter: 3,
    evidence: [`${title}仍未处理。`],
    relatedCharacters: ["林远"],
    relatedLocations: ["账房"],
  };
}

  // P2：老书的 threads.json 可能早于 lastTouchedChapter 字段引入。NaN < 9 恒为 false
  // → 意图线被直接判成「停滞超阈值」而自动蛰伏（stale），静默丢掉用户的叙事承诺。

describe("题材中立·线索池持久层不得因题材专名词表破坏性熔合", () => {
  const makeLead = (id: string, title: string): NarrativeThread => ({
    id,
    type: "lead",
    title,
    status: "open",
    firstSeenChapter: 3,
    lastTouchedChapter: 12,
    evidence: [`第3章：${title}。`, `第12章：${title}后续。`],
  });

  it("商战反例：库房丢账/库房对账是两条真线索，零 update 时绝不被熔成一条", () => {
    const pool: ThreadPool = {
      threads: [makeLead("lead-lose", "库房丢账"), makeLead("lead-check", "库房对账")],
    };
    const merged = mergeThreadTrackingUpdates(pool, []);
    expect(merged.threads.map((thread) => thread.title)).toEqual(["库房丢账", "库房对账"]);
  });

  it("商战反例：库房亏空/库房对账/库房查账三条各归各，不坍缩进「库房查账」", () => {
    const pool: ThreadPool = {
      threads: [
        makeLead("lead-a", "库房亏空"),
        makeLead("lead-b", "库房对账"),
        makeLead("lead-c", "库房查账"),
      ],
    };
    const merged = mergeThreadTrackingUpdates(pool, []);
    expect(merged.threads).toHaveLength(3);
  });

  it("安全正例保留：去库房查账 ↔ 明日去库房查账册 仍按子串包含归并（短标题胜出）", () => {
    const pool: ThreadPool = {
      threads: [
        makeLead("lead-short", "去库房查账"),
        { ...makeLead("lead-long", "明日去库房查账册"), lastTouchedChapter: 14 },
      ],
    };
    const merged = mergeThreadTrackingUpdates(pool, []);
    expect(merged.threads).toHaveLength(1);
    expect(merged.threads[0]?.title).toBe("去库房查账");
    expect(merged.threads[0]?.lastTouchedChapter).toBe(14);
    expect(merged.threads[0]?.evidence).toHaveLength(4);
  });
});
