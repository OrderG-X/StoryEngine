import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createStoryProject } from "../project-store.js";
import { buildStateOverview } from "../state-overview.js";

describe("State Overview defensive readers", () => {
  it("corrupt ledger JSON degrades to empty but surfaces a visible warning (审计 Low：面板显示「坏」而非「空」)", async () => {
    const projectDir = await createProjectWithSparseFoundationFiles();
    await writeFile(join(projectDir, "story", "hooks.json"), "{not-json", "utf-8");

    const overview = await buildStateOverview({ projectDir, chapter: 1 });

    // 读侧降级照做（不堵概览）
    expect(overview.uiHints.warnings.join(" ")).toContain("资料文件损坏");
    expect(overview.uiHints.warnings.join(" ")).toContain(join("story", "hooks.json"));
  });

  it("builds a controlled overview from old handwritten foundation files with missing fields", async () => {
    const projectDir = await createProjectWithSparseFoundationFiles();

    const overview = await buildStateOverview({ projectDir, chapter: 1 });

    expect(overview.storyStatus.currentObjective).toBeUndefined();
    expect(overview.storyBible).toMatchObject({
      available: true,
      projectLogline: "",
      readerPromise: "",
      longFormGoals: [],
      centralConflicts: [],
      coreMysteries: [],
      forbiddenChanges: [],
      canonFacts: [],
      openQuestions: [],
    });
    expect(overview.storyBible.setupAssets).toEqual({
      initialAssets: [],
      keyItems: [],
      resourceLimits: [],
    });
    expect(overview.writingRules).toMatchObject({
      available: true,
      narrativePerspective: "third_limited",
      proseStyle: [],
      genreRequirements: [],
      forbiddenContent: [],
      doNotDo: [],
      readerExperienceRules: [],
    });
    expect(overview.worldBible).toMatchObject({
      available: true,
      ruleCount: 0,
      factionCount: 0,
      systemCount: 0,
      keyRules: [],
      resourceRules: [],
      authorityRules: [],
      socialOrder: [],
      conflictSources: [],
      fixedFacts: [],
      protectedSecrets: [],
      publicFacts: [],
      hiddenFacts: [],
      forbiddenRuleBreaks: [],
    });
    expect(overview.locationBible).toMatchObject({
      available: true,
      locationCount: 1,
      activeLocationNames: ["旧楼"],
      riskCount: 0,
      resourceCount: 0,
      keyRisks: [],
      keyResources: [],
    });
    expect(overview.locationDetailSummary.locations[0]).toMatchObject({
      id: "old-building",
      name: "旧楼",
      risks: [],
      resources: [],
    });
    expect(overview.locationDetailSummary.risks).toEqual([]);
    expect(overview.locationDetailSummary.resources).toEqual([]);
  });

  it("keeps complete default project overview behavior intact", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "story-engine-defensive-complete-"));
    const { projectDir } = await createStoryProject({
      rootDir,
      title: "完整项目",
      genre: "mystery",
      premise: "完整默认项目仍应正常生成状态总览。",
      mainCharacterName: "林澈",
    });

    const overview = await buildStateOverview({ projectDir, chapter: 1 });

    expect(overview.project).toMatchObject({
      title: "完整项目",
      genre: "mystery",
      currentChapter: 1,
    });
    expect(overview.storyBible.available).toBe(true);
    expect(overview.writingRules.available).toBe(true);
    expect(overview.locationBible.available).toBe(true);
    expect(overview.characterBible.characterCount).toBe(1);
  });
});

async function createProjectWithSparseFoundationFiles(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "story-engine-defensive-readers-"));
  const { projectDir } = await createStoryProject({
    rootDir,
    title: "旧项目",
    genre: "mystery",
    premise: "手写旧项目只保留少量字段。",
    mainCharacterName: "林澈",
  });

  await Promise.all([
    writeJson(projectDir, "story/core.json", {
      tone: "quiet",
    }),
    writeJson(projectDir, "story/bible.json", {
      version: "v0",
      genre: "mystery",
      setupAssets: {},
    }),
    writeJson(projectDir, "story/writing-rules.json", {
      version: "v0",
      narrativePerspective: "third_limited",
    }),
    writeJson(projectDir, "story/world-bible.json", {
      version: "v0",
    }),
    writeJson(projectDir, "story/location-bible.json", {
      version: "v0",
      locations: [
        {
          id: "old-building",
          name: "旧楼",
          type: "building",
        },
      ],
    }),
  ]);

  return projectDir;
}

async function writeJson(projectDir: string, relativePath: string, value: unknown): Promise<void> {
  await writeFile(join(projectDir, relativePath), `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}
