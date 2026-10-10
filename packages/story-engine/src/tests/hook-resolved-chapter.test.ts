import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { commitFastDraft } from "../commit-engine.js";
import type { ChapterDeltaDeclaration } from "../chapter-delta.js";
import { buildCommitPlanFromProject } from "../commit-plan-builder.js";
import { mergeHookTrackingUpdates } from "../hook-tracking.js";
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

// Task B4: 伏笔回收章号 resolvedAtChapter
// 已回收 hook 记录「在第几章回收」，供伏笔线索面板显示「第N章埋→第M章回收」。
// 通道：走 trackingUpdates（HookTrackingUpdate.resolvedAtChapter），commit-engine.ts 零改动。
describe("StoryEngine-NG Hook resolvedAtChapter (B4)", () => {
  it("records resolvedAtChapter when a hook is resolved (end-to-end through commit-engine)", async () => {
    const projectDir = await createHookProject();
    await seedHooks(projectDir, {
      hooks: [
        {
          id: "h-ledger",
          title: "账目",
          description: "账房账目记录外院账目。",
          status: "active",
          relatedCharacters: ["林远"],
          firstSeenChapter: 3,
          lastTouchedChapter: 3,
          evidence: ["账房发现账目。"],
        },
      ],
    });

    // 第41章：真相大白，账目回收
    await writeDraft(projectDir, 41, [
      "林远终于将账目的来源查清了，账房黑幕水落石出，真相大白于天下。",
    ].join("\n\n"));

    const plan = await buildCommitPlanFromProject({ projectDir, chapter: 41, declaration: ledgerResolvedDeclaration(41) });
    expect(plan.passed).toBe(true);

    const report = await commitFastDraft({
      projectDir,
      chapter: 41,
      commitPlan: plan.commitPlan!,
    });
    expect(report.passed).toBe(true);

    const hookPool = await readHookPool(projectDir);
    const hook = hookPool.hooks.find((h) => h.id === "h-ledger");
    expect(hook, "resolved hook should exist in pool").toBeDefined();
    expect(hook!.status).toBe("resolved");
    expect(hook!.resolvedAtChapter).toBe(41);
    // 埋于第3章、回收于第41章 —— 供面板显示
    expect(hook!.firstSeenChapter).toBe(3);
  });

  // PR B 幻影 hook：本章回收一个从未登记的线索（同章开+合 / 模型口径漂移 / fuzzy 漏匹配）。
  // 旧路：resolvedHookIds 为它合成 phantom id → 灌进 hookUpdates 校验通道 → commit-engine
  // findUnknownHookIds 判 "Hook not found" → 整章硬阻。修法（introduce-then-resolve）：resolved
  // 状态走 tracking 通道登记入池；hookUpdates 只放行池内 id。验收必须证明「不是 naive filter」。
  // 2026-08-12 注入方式更新：HOOK_KEYWORDS 词表摘除后，纯正文不再自发产生池外候选，
  // 故此用例改为手工往 commitPlan 注入一条池外 resolved 更新——钉住的管道韧性不变：
  // tracking 通道携带幻影 id 时 commit 绝不「Hook not found」硬阻、也绝不静默丢弃，照常登记入池。
  it("introduce-then-resolve: tracking 通道携带池外 resolved 更新 → commit 不硬阻、登记入池（防幻影 id 回归）", async () => {
    const projectDir = await createHookProject();
    await seedHooks(projectDir, { hooks: [] });
    await writeDraft(projectDir, 41, [
      "林远终于将账目的来源查清了，账房黑幕水落石出，真相大白于天下。",
    ].join("\n\n"));

    const plan = await buildCommitPlanFromProject({ projectDir, chapter: 41 });
    expect(plan.passed).toBe(true);
    // 词表已摘除：纯正文不再自发新建/回收未登记伏笔（题材中立）
    expect(plan.commitPlan!.hookTrackingUpdates ?? []).toEqual([]);

    // 手工注入池外 resolved 更新（模拟历史数据/上游演化产生的幻影 id）
    const phantom = {
      id: "hook-phantom-41",
      title: "账目来源",
      status: "resolved" as const,
      firstSeenChapter: 41,
      lastTouchedChapter: 41,
      evidence: ["林远终于将账目的来源查清了，账房黑幕水落石出，真相大白于天下。"],
      resolvedAtChapter: 41,
    };
    (plan.commitPlan as { hookTrackingUpdates?: readonly unknown[] }).hookTrackingUpdates = [phantom];

    // 「非 naive filter」铁证①：池外 phantom id 绝不进 hookUpdates 校验通道
    const hookUpdateIds = (plan.commitPlan!.hookUpdates ?? []).map((update) => update.hookId);
    expect(hookUpdateIds).not.toContain(phantom.id);

    // commit 不因 Hook not found 硬阻
    const report = await commitFastDraft({ projectDir, chapter: 41, commitPlan: plan.commitPlan! });
    expect(report.passed).toBe(true);
    expect(report.issues.some((issue) => issue.includes("Hook not found"))).toBe(false);

    // 「非 naive filter」铁证②：不静默消失——池里真登记了它、状态 resolved、回收章号本章
    const pool = await readHookPool(projectDir);
    const hook = pool.hooks.find((h) => h.id === phantom.id);
    expect(hook, "池外 resolved 更新应登记入池").toBeDefined();
    expect(hook!.status).toBe("resolved");
    expect(hook!.resolvedAtChapter).toBe(41);

    // 报告可见：introducedHooks 含它
    expect(report.hookTracking?.introducedHooks).toContain(phantom.id);
  });

  it("monotonicity: resolvedAtChapter is pinned to the first resolution chapter (not overwritten by later mention)", async () => {
    const projectDir = await createHookProject();
    await seedHooks(projectDir, {
      hooks: [
        {
          id: "h-ledger",
          title: "账目",
          description: "账房账目记录外院账目。",
          status: "active",
          relatedCharacters: ["林远"],
          firstSeenChapter: 3,
          lastTouchedChapter: 3,
          evidence: ["账房发现账目。"],
        },
      ],
    });

    // 第41章：回收 → resolvedAtChapter=41
    await writeDraft(projectDir, 41, [
      "林远终于将账目的来源查清了，账房黑幕水落石出，真相大白于天下。",
    ].join("\n\n"));
    const plan41 = await buildCommitPlanFromProject({ projectDir, chapter: 41, declaration: ledgerResolvedDeclaration(41) });
    expect(plan41.passed).toBe(true);
    const report41 = await commitFastDraft({ projectDir, chapter: 41, commitPlan: plan41.commitPlan! });
    expect(report41.passed).toBe(true);

    const poolAfter41 = await readHookPool(projectDir);
    const hookAfter41 = poolAfter41.hooks.find((h) => h.id === "h-ledger");
    expect(hookAfter41!.status).toBe("resolved");
    expect(hookAfter41!.resolvedAtChapter).toBe(41);

    // 第50章：已回收的 hook 再次被提及（无回收短语）→ resolvedAtChapter 必须仍是 41，不被改成 50、不丢
    await writeDraft(projectDir, 50, [
      "林远回想起那本账目，记录着外院那些陈年旧事。",
    ].join("\n\n"));
    const plan50 = await buildCommitPlanFromProject({ projectDir, chapter: 50 });
    expect(plan50.passed).toBe(true);
    const report50 = await commitFastDraft({ projectDir, chapter: 50, commitPlan: plan50.commitPlan! });
    expect(report50.passed).toBe(true);

    const poolAfter50 = await readHookPool(projectDir);
    const hookAfter50 = poolAfter50.hooks.find((h) => h.id === "h-ledger");
    expect(hookAfter50, "hook should still exist").toBeDefined();
    expect(hookAfter50!.status).toBe("resolved");
    // 单调：回收时间定死在第一次回收那章
    expect(hookAfter50!.resolvedAtChapter).toBe(41);
  });

  it("backward-compatible: old hooks without resolvedAtChapter merge without crashing", async () => {
    // 旧账本 hook 无 resolvedAtChapter 字段，且本轮无回收 → 不崩、不凭空填字段
    const previous: HookPool = {
      hooks: [
        {
          id: "h-legacy",
          title: "旧伏笔",
          description: "旧账本里的伏笔，没有 resolvedAtChapter 字段。",
          status: "active",
          relatedCharacters: ["林远"],
          firstSeenChapter: 1,
          lastTouchedChapter: 1,
          evidence: ["旧证据。"],
        },
      ],
    };

    // 纯 touch 更新（无回收）：mergeHookTrackingUpdates 直接调用不应崩，也不应凭空加 resolvedAtChapter
    const merged = mergeHookTrackingUpdates(
      previous,
      [
        {
          id: "h-legacy",
          title: "旧伏笔",
          status: "active",
          firstSeenChapter: 1,
          lastTouchedChapter: 2,
          evidence: ["第2章再次提及旧伏笔。"],
        },
      ],
    );

    const hook = merged.hooks.find((h) => h.id === "h-legacy");
    expect(hook).toBeDefined();
    expect(hook!.status).toBe("active");
    expect(hook!.lastTouchedChapter).toBe(2);
    expect(hook!.resolvedAtChapter).toBeUndefined();
  });
});

async function createHookProject(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "story-engine-hook-resolved-"));
  const { projectDir } = await createStoryProject({
    rootDir,
    title: "Hook Resolved Story",
    genre: "xianxia",
    premise: "林远追查外院账房黑幕。",
    mainCharacterName: "林远",
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
