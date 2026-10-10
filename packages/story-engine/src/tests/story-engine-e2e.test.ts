import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { buildWriterContext } from "../context-gateway.js";
import { commitFastDraft } from "../commit-engine.js";
import { buildCommitPlanFromProject } from "../commit-plan-builder.js";
import { runFastDraft, type WriterClient } from "../fast-draft-writer.js";
import {
  createStoryProject,
  readCharacterState,
  readHookPool,
  readStoryCalendar,
  readTimelineEvents,
  readWorldState,
} from "../project-store.js";
import type { HookPool } from "../types.js";

describe("StoryEngine E2E V1", () => {
  it("runs the complete minimal state-first flow with a fake writer", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "story-engine-e2e-"));
    const { projectDir, project } = await createStoryProject({
      rootDir,
      title: "Minimal E2E Story",
      genre: "xianxia",
      premise: "Guo Xu investigates a broken sect ledger before dawn.",
      mainCharacterName: "Guo Xu",
    });
    await seedHook(projectDir);

    const initialContext = await buildWriterContext({
      projectDir,
      chapter: 1,
      chapterGoal: "Guo Xu discovers the ledger breach and chooses to investigate.",
      selectedHookIds: ["h-ledger"],
      maxTimelineEvents: 5,
    });

    expect(project.id).toBe("minimal-e2e-story");
    expect(initialContext.projectId).toBe(project.id);
    expect(initialContext.trace.sectionNames).toEqual([
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
    expect(initialContext.trace.selectedCharacters).toEqual(["guo-xu"]);
    expect(initialContext.trace.selectedHooks).toEqual(["h-ledger"]);
    expect(initialContext.trace.selectedTimelineEvents).toEqual([]);

    const writerClient: WriterClient = {
      generateDraft: vi.fn(async ({ context, maxOutputTokens }) => {
        expect(context.projectId).toBe(project.id);
        expect(context.chapter).toBe(1);
        expect(context.trace.selectedHooks).toEqual(["h-ledger"]);
        expect(maxOutputTokens).toBe(900);
        return {
          title: "Ledger Before Dawn",
          content: "Guo Xu found the cracked sect ledger before dawn and marked the missing spirit-stone line.",
          tokenUsage: { promptTokens: 120, completionTokens: 45, totalTokens: 165 },
        };
      }),
    };

    const draftReport = await runFastDraft({
      projectDir,
      chapter: 1,
      chapterGoal: "Guo Xu discovers the ledger breach and chooses to investigate.",
      selectedHookIds: ["h-ledger"],
      maxTimelineEvents: 5,
      maxOutputTokens: 900,
      writerClient,
    });

    expect(draftReport.passed).toBe(true);
    expect(draftReport.title).toBe("Ledger Before Dawn");
    expect(draftReport.draftPath).toBe(join(projectDir, "drafts", "fast", "chapter-0001.md"));
    expect(draftReport.tokenUsage).toEqual({ promptTokens: 120, completionTokens: 45, totalTokens: 165 });
    expect(draftReport.diagnostics).toMatchObject({
      stage: "fast-draft",
      chapter: 1,
      tokenUsage: { promptTokens: 120, completionTokens: 45, totalTokens: 165 },
      details: {
        passed: true,
        title: "Ledger Before Dawn",
        issueCount: 0,
      },
    });
    expect(writerClient.generateDraft).toHaveBeenCalledOnce();

    const commitReport = await commitFastDraft({
      projectDir,
      chapter: 1,
      draftPath: draftReport.draftPath,
      commitPlan: {
        characterUpdates: [
          {
            characterId: "Guo Xu",
            emotion: "focused",
            goal: "trace the missing spirit-stone line",
            currentArc: "ledger investigation",
          },
        ],
        timelineEvents: [
          {
            summary: "Guo Xu finds the cracked sect ledger and marks the missing spirit-stone line.",
            participants: ["guo-xu"],
            effects: {
              "guo-xu": {
                goal: "trace the missing spirit-stone line",
              },
            },
          },
        ],
        worldUpdates: {
          currentPhase: "investigation",
          activeConflicts: ["missing spirit-stone line"],
          activeHooks: ["h-ledger"],
          knownSecrets: ["the ledger was damaged before dawn"],
        },
        hookUpdates: [
          {
            hookId: "h-ledger",
            status: "active",
          },
        ],
        calendar: {
          storyDay: 1,
          timeOfDay: "morning",
        },
      },
    });

    expect(commitReport).toEqual({
      chapter: 1,
      passed: true,
      chapterPath: join(projectDir, "chapters", "0001.md"),
      updatedCharacters: ["guo-xu"],
      timelineEventIds: ["ch0001-001"],
      updatedHooks: ["h-ledger"],
      updatedWorld: true,
      updatedCalendar: true,
      issues: [],
    });
    expect(commitReport.diagnostics).toMatchObject({
      stage: "commit",
      chapter: 1,
      details: {
        passed: true,
        chapterPath: join(projectDir, "chapters", "0001.md"),
        updatedCharacterCount: 1,
        timelineEventCount: 1,
        updatedHookCount: 1,
        issueCount: 0,
      },
    });

    await expect(readFile(join(projectDir, "chapters", "0001.md"), "utf-8")).resolves.toBe(
      "# Ledger Before Dawn\n\nGuo Xu found the cracked sect ledger before dawn and marked the missing spirit-stone line.\n",
    );
    await expect(readCharacterState(projectDir, "guo-xu")).resolves.toMatchObject({
      emotion: "focused",
      goal: "trace the missing spirit-stone line",
      currentArc: "ledger investigation",
      lastUpdatedChapter: 1,
    });
    await expect(readTimelineEvents(projectDir)).resolves.toEqual([
      {
        id: "ch0001-001",
        chapter: 1,
        summary: "Guo Xu finds the cracked sect ledger and marks the missing spirit-stone line.",
        participants: ["guo-xu"],
        effects: {
          "guo-xu": {
            goal: "trace the missing spirit-stone line",
          },
        },
      },
    ]);
    await expect(readWorldState(projectDir)).resolves.toMatchObject({
      currentPhase: "investigation",
      activeConflicts: ["missing spirit-stone line"],
      activeHooks: ["h-ledger"],
      knownSecrets: ["the ledger was damaged before dawn"],
      lastUpdatedChapter: 1,
    });
    await expect(readHookPool(projectDir)).resolves.toEqual({
      hooks: [
        {
          id: "h-ledger",
          title: "Cracked Ledger",
          description: "A sect ledger has one missing spirit-stone line.",
          status: "active",
          relatedCharacters: ["guo-xu"],
        },
      ],
    });
    await expect(readStoryCalendar(projectDir)).resolves.toEqual({
      currentStoryDay: 1,
      currentTimeOfDay: "morning",
    });
    await expect(readFile(join(projectDir, "diagnostics", "fast-draft-chapter-0001.json"), "utf-8"))
      .resolves.toContain("\"stage\": \"fast-draft\"");
    await expect(readFile(join(projectDir, "diagnostics", "commit-chapter-0001.json"), "utf-8"))
      .resolves.toContain("\"stage\": \"commit\"");

    const nextContext = await buildWriterContext({
      projectDir,
      chapter: 2,
      chapterGoal: "Continue from the committed ledger discovery.",
      selectedHookIds: ["h-ledger"],
      maxTimelineEvents: 5,
    });

    expect(nextContext.trace.selectedTimelineEvents).toEqual(["ch0001-001"]);
    expect(nextContext.sections.find((section) => section.name === "character_state")?.content).toEqual([
      expect.objectContaining({
        characterId: "guo-xu",
        emotion: "focused",
        lastUpdatedChapter: 1,
      }),
    ]);
  });

  it("carries semantic summaries from three committed chapters into chapter 4 context", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "story-engine-continuity-e2e-"));
    const { projectDir } = await createStoryProject({
      rootDir,
      title: "Continuity E2E Story",
      genre: "xianxia",
      premise: "林远从外院废柴追查组织账册黑幕。",
      mainCharacterName: "林远",
    });
    await writeFile(
      join(projectDir, "story", "location-bible.json"),
      `${JSON.stringify({
        version: "v0",
        locations: ["外院", "园圃", "库房", "后院", "账房"].map((name, index) => ({
          id: `loc-${index}`,
          name,
          type: index === 0 ? "opening" : "scene",
        })),
      }, null, 2)}\n`,
      "utf-8",
    );
    const drafts = [
      "林远在外院园圃遭管事克扣月钱，却发现灵土下面压着一页旧账本。他决定先去库房查账，后院黑影留下了账本线索。",
      "林远来到库房，被同门威胁交出旧账本。他看见账册暗号指向账房，拿到半枚破损信物，却被扣掉粮米。明日清晨账房会转移账册。",
      "林远夜入账房，发现账本暗页记录外院账目。林婉清提醒他门后有异常声音，他决定守住后墙，黑影的暗号仍未解开。",
    ];

    for (const [index, draft] of drafts.entries()) {
      const chapter = index + 1;
      await writeFile(
        join(projectDir, "drafts", "fast", `chapter-${String(chapter).padStart(4, "0")}.md`),
        `# 第${chapter}章\n\n${draft}\n`,
        "utf-8",
      );
      const plan = await buildCommitPlanFromProject({ projectDir, chapter });
      expect(plan.passed).toBe(true);
      const report = await commitFastDraft({
        projectDir,
        chapter,
        commitPlan: plan.commitPlan!,
      });
      expect(report.passed).toBe(true);
    }

    const chapter4Context = await buildWriterContext({
      projectDir,
      chapter: 4,
      chapterGoal: "承接后墙与黑影暗号，继续推进外院账目。",
      maxTimelineEvents: 5,
    });
    const continuity = chapter4Context.sections.find((section) => section.name === "story_continuity")?.content as {
      recentEvents: string[];
      openLeads: string[];
      recentLocations: string[];
      recentCharacters: string[];
      carryForwardInstruction: string;
    };

    expect(continuity.recentEvents).toHaveLength(3);
    expect(continuity.recentEvents.every((event) => !event.includes("草稿被提交为正式章节"))).toBe(true);
    expect(continuity.recentEvents.join("\n")).toContain("账房");
    expect(continuity.openLeads.length).toBeGreaterThanOrEqual(1);
    expect(continuity.recentLocations.length).toBeGreaterThanOrEqual(1);
    expect(continuity.recentCharacters).toContain("林远");
    expect(continuity.carryForwardInstruction).toContain("不要重新开局");

    // 2026-10-10 第 4 期：给写手的近几章事件只留要点（章号、摘要、主事件、关键事件…），不再整份语义摘要原样塞进去。
    const timelineSection = chapter4Context.sections.find((section) => section.name === "timeline_events")?.content as Array<{
      chapter: number;
      summary: string;
      effects?: unknown;
    }>;
    expect(timelineSection).toHaveLength(3);
    expect(timelineSection.map((event) => event.chapter)).toEqual([1, 2, 3]);
    expect(timelineSection.every((event) => event.summary.length > 0 && event.effects === undefined)).toBe(true);
  });

  it("has no legacy package, old runner, or live-provider references in the package", async () => {
    const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const forbiddenImportPath = ["packages", "core"].join("/");
    const forbiddenRunnerName = ["Pipeline", "Runner"].join("");
    const forbiddenLiveProvider = new RegExp(["real", "model"].join("[\\s_-]*"), "iu");
    const violations: string[] = [];

    for (const filePath of await listFiles(packageDir)) {
      const content = await readFile(filePath, "utf-8");
      if (content.includes(forbiddenImportPath)) violations.push(`${filePath}: legacy package path`);
      if (content.includes(forbiddenRunnerName)) violations.push(`${filePath}: old runner name`);
      if (forbiddenLiveProvider.test(content)) violations.push(`${filePath}: live provider wording`);
    }

    expect(violations).toEqual([]);
  });
});

async function seedHook(projectDir: string): Promise<void> {
  const hooks: HookPool = {
    hooks: [
      {
        id: "h-ledger",
        title: "Cracked Ledger",
        description: "A sect ledger has one missing spirit-stone line.",
        status: "seeded",
        relatedCharacters: ["guo-xu"],
      },
    ],
  };
  await writeFile(join(projectDir, "story", "hooks.json"), `${JSON.stringify(hooks, null, 2)}\n`, "utf-8");
}

async function listFiles(rootDir: string): Promise<string[]> {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(rootDir, entry.name);
    if (entry.name === "dist" || entry.name === "node_modules") return [];
    if (entry.isDirectory()) return listFiles(path);
    if (!entry.isFile()) return [];
    return [path];
  }));
  return files.flat();
}
