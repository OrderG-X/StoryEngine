// @vitest-environment node
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withUiOverviewDetails } from "./ui-overview.js";

describe("withUiOverviewDetails", () => {
  it("projects committed character state fields into UI overview details", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "story-engine-character-detail-state-"));
    await mkdir(join(projectDir, "characters", "lin-xiao"), { recursive: true });
    await Promise.all([
      writeFile(join(projectDir, "characters", "lin-xiao", "profile.json"), `${JSON.stringify({
        id: "lin-xiao",
        name: "林晓",
        identity: "守护者",
      }, null, 2)}\n`, "utf-8"),
      writeFile(join(projectDir, "characters", "lin-xiao", "state.json"), `${JSON.stringify({
        characterId: "lin-xiao",
        mood: "冷静",
        currentGoal: "保护主角",
        recentEvents: ["完成角色状态确认写入封测"],
        relationshipToUser: "信任",
      }, null, 2)}\n`, "utf-8"),
    ]);

    const overview = await withUiOverviewDetails(projectDir, {
      project: { title: "测试书", genre: "都市", currentChapter: 1 },
      storyStatus: {},
      hooks: { activeCount: 0, touchedCount: 0, resolvedCount: 0, activeItems: [] },
      threads: { total: 0, open: 0, touched: 0, done: 0, openIntents: 0, cleanupVisibleCount: 0, cleanupVisibleUnresolvedCount: 0, keyOpenItems: [] },
      arcGoals: { activeCount: 0, touchedCount: 0, completedCount: 0, activeItems: [] },
      timeline: { recentEvents: [], earlierSummary: [], macroSummary: [] },
      characters: { knownCharacters: [] },
      world: { activeLocations: [], importantFacts: [], protectedSecrets: [] },
      maintenance: {
        diagnosticsAvailable: false,
        cleanupVisibleCount: 0,
        markDoneCandidateCount: 0,
        mergeDisabled: true,
        dropDisabled: true,
        confirmPolicy: { markDone: "manual_only", merge: "disabled", drop: "disabled" },
      },
      uiHints: { recommendedNextPanels: [], warnings: [], disabledActions: [] },
    } as unknown as Parameters<typeof withUiOverviewDetails>[1]);

    expect(overview.characterDetails?.[0]).toMatchObject({
      id: "lin-xiao",
      name: "林晓",
      mood: "冷静",
      currentGoal: "保护主角",
      recentEvents: ["完成角色状态确认写入封测"],
      relationshipToUser: "信任",
    });
  });
});
