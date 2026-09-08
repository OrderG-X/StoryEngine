import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildChapterSteeringDraft } from "../chapter-steering.js";
import { createStoryProject, toSafeCharacterId } from "../project-store.js";

describe("Chapter Steering Pack V0", () => {
  it("builds a read-only steering draft with selectable continuity suggestions", async () => {
    const projectDir = await createSteeringFixture();
    const before = await snapshotStateFiles(projectDir);

    const draft = await buildChapterSteeringDraft({
      projectDir,
      userDirection: "下一章去地下车库确认信号源",
      chapter: 8,
      mustInclude: ["判断避难所广播真假"],
      mustAvoid: ["避难所"],
      pacing: "medium",
      revealLevel: "small",
      maxSuggestions: 10,
    });

    expect(draft.userDirection).toBe("下一章去地下车库确认信号源");
    expect(draft.chapter).toBe(8);
    expect(draft.foundationContext).toMatchObject({
      available: true,
      storyBibleAvailable: true,
      writingRulesAvailable: true,
      characterBibleAvailable: true,
      worldBibleAvailable: true,
      locationBibleAvailable: true,
    });
    expect(draft.foundationContext.writingRuleReminders).toEqual(expect.arrayContaining(["避免任务清单式推进"]));
    expect(draft.foundationContext.worldRuleReminders).toEqual(expect.arrayContaining(["城市断电断网，物资稀缺。"]));
    expect(draft.foundationContext.characterBoundaryReminders.join(" / ")).toContain("暂时没有强大战斗力");
    expect(draft.foundationContext.protagonistKnowledgeReminders).toEqual(expect.arrayContaining(["已知：无线电信号异常"]));
    expect(draft.foundationContext.forbiddenRevealReminders).toEqual(expect.arrayContaining(["无线电异常信号来源"]));
    expect(draft.foundationContext.locationRiskReminders).toEqual(expect.arrayContaining(["地下车库：深处有异响"]));
    expect(draft.foundationContext.setupAssetReminders).toEqual(expect.arrayContaining(["旧收音机"]));
    expect(draft.foundationContext.locationContinuityReminders).toEqual(expect.arrayContaining(["地下车库"]));
    expect(draft.suggestions.some((suggestion) => suggestion.title === "不要提前揭开隐藏真相")).toBe(true);
    expect(draft.generatedChapterGoalPreview).toContain("下一章去地下车库确认信号源");
    expect(draft.generatedChapterGoalPreview).toContain("基础设定：");
    expect(draft.generatedChapterGoalPreview).toContain("本 preview 只用于 draft 前预览，不写正式状态");
    expect(draft.safety).toMatchObject({
      writesState: false,
      requiresPreviewBeforeCommit: true,
    });
    expect(draft.safety.disabledActions).toEqual(expect.arrayContaining([
      "commit_draft",
      "apply_review_plan_confirm",
      "merge_threads_confirm",
      "drop_thread_confirm",
    ]));
    expect(draft.suggestions.length).toBeGreaterThanOrEqual(3);
    expect(draft.suggestions.length).toBeLessThanOrEqual(10);
    for (const suggestion of draft.suggestions) {
      expect(suggestion.availableActions).toEqual(["include", "skip", "weaken", "alternative"]);
    }
    const types = new Set(draft.suggestions.map((suggestion) => suggestion.type));
    expect(types.has("hook")).toBe(true);
    expect(types.has("thread")).toBe(true);
    expect(types.has("arcGoal")).toBe(true);
    expect(types.has("risk")).toBe(true);
    expect(draft.suggestions.some((suggestion) => suggestion.sourceId === "intent-low")).toBe(false);
    const riskTitles = draft.suggestions.filter((suggestion) => suggestion.type === "risk").map((suggestion) => suggestion.title);
    // 稳健断言（不锁死精确措辞，文案可自由优化）：有一条「控制伏笔/线索数量」的风险提示，
    // 且所有面向用户的 risk 标题都不含英文行话（hook/thread/arc）——文案读感靠真机页面验，不靠脆的字符串等值。
    expect(riskTitles.some((title) => /伏笔|线索/.test(title))).toBe(true);
    expect(riskTitles.every((title) => !/hook|thread|arc/i.test(title))).toBe(true);
    expect(riskTitles).not.toContain("写作规则提醒");
    expect(riskTitles).not.toContain("世界观与类型规则提醒");
    expect(riskTitles).not.toContain("角色边界提醒");
    expect(draft.selectedInclusions.length).toBeGreaterThan(0);
    const includedSuggestions = draft.suggestions.filter((suggestion) => draft.selectedInclusions.includes(suggestion.id));
    expect(includedSuggestions.length).toBe(draft.selectedInclusions.length);
    for (const suggestion of includedSuggestions) {
      expect(suggestion.defaultAction).toBe("include");
      expect(suggestion.type).not.toBe("risk");
    }
    const skippedSuggestions = draft.suggestions.filter((suggestion) => suggestion.defaultAction === "skip");
    expect(skippedSuggestions.length).toBeGreaterThan(0);
    for (const suggestion of skippedSuggestions) {
      expect(draft.selectedInclusions).not.toContain(suggestion.id);
      expect(draft.generatedChapterGoalPreview).not.toContain(`建议承接：${suggestion.title}`);
    }
    expect(draft.generatedChapterGoalPreview).toContain(`建议承接：${includedSuggestions[0]?.title}`);

    await expect(snapshotStateFiles(projectDir)).resolves.toEqual(before);
  });

  it("feeds top-ranked include suggestions into the goal preview instead of the fallback line", async () => {
    const projectDir = await createSteeringFixture();

    const draft = await buildChapterSteeringDraft({
      projectDir,
      userDirection: "下一章去地下车库确认信号源",
      chapter: 8,
      mustInclude: ["确认无线电信号来源"],
    });

    expect(draft.selectedInclusions.length).toBeGreaterThan(0);
    expect(draft.selectedInclusions.length).toBeLessThanOrEqual(3);
    const includedSuggestions = draft.suggestions.filter((suggestion) => draft.selectedInclusions.includes(suggestion.id));
    expect(includedSuggestions.every((suggestion) => suggestion.defaultAction === "include" && suggestion.type !== "risk")).toBe(true);
    expect(draft.generatedChapterGoalPreview).toContain(`建议承接：${includedSuggestions[0]?.title}`);
    expect(draft.generatedChapterGoalPreview).not.toContain("保留 1 条主行动和 1 条轻量伏笔即可");
  });

  it("degrades gracefully when optional pools are missing", async () => {
    const projectDir = await createSteeringFixture();
    await rm(join(projectDir, "story", "hooks.json"));
    await rm(join(projectDir, "story", "threads.json"));
    await rm(join(projectDir, "story", "arc-goals.json"));

    const draft = await buildChapterSteeringDraft({
      projectDir,
      userDirection: "下一章先确认楼道是否安全",
      chapter: 3,
    });

    expect(draft.safety.writesState).toBe(false);
    expect(draft.foundationContext.available).toBe(true);
    expect(draft.generatedChapterGoalPreview).toContain("下一章先确认楼道是否安全");
    expect(draft.suggestions.some((suggestion) => suggestion.type === "risk")).toBe(true);
  });

  // r7：久未推进的目标要在章节导向里带压力信号（长跑防「目标挂着没人管」）。
  it("gives idle arc goals a pressure signal: reason names idle chapters and defaults to include", async () => {
    const projectDir = await createSteeringFixture();

    const draft = await buildChapterSteeringDraft({
      projectDir,
      userDirection: "写一段过渡日常",
      chapter: 30, // goal-shelter lastTouched=7 → idle 23 > 10
    });

    const goalSuggestion = draft.suggestions.find((suggestion) => suggestion.type === "arcGoal");
    expect(goalSuggestion).toBeDefined();
    expect(goalSuggestion?.reason).toContain("已 23 章未推进");
    expect(goalSuggestion?.defaultAction).toBe("include");
    expect(goalSuggestion?.suggestedMethod).toContain("实质推进");
    expect(goalSuggestion?.intensity).toBe("medium"); // mini_arc 停滞 → medium；main_arc 停滞才 strong
  });

  it("does not fail when story foundation files are missing", async () => {
    const projectDir = await createSteeringFixture();
    await Promise.all([
      rm(join(projectDir, "story", "bible.json")),
      rm(join(projectDir, "story", "writing-rules.json")),
      rm(join(projectDir, "story", "character-bible.json")),
      rm(join(projectDir, "story", "world-bible.json")),
      rm(join(projectDir, "story", "location-bible.json")),
    ]);

    const draft = await buildChapterSteeringDraft({
      projectDir,
      userDirection: "下一章去地下车库确认信号源",
      chapter: 8,
    });

    expect(draft.foundationContext.available).toBe(false);
    expect(draft.foundationContext.writingRuleReminders).toEqual([]);
    expect(draft.foundationContext.worldRuleReminders).toEqual([]);
    expect(draft.generatedChapterGoalPreview).toContain("下一章去地下车库确认信号源");
  });
});

async function createSteeringFixture(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "story-engine-chapter-steering-"));
  const { projectDir } = await createStoryProject({
    rootDir,
    title: "章节转向测试",
    genre: "apocalypse",
    premise: "林澈在旧城区灾变中求生，逐步确认无线电异常信号。",
    mainCharacterName: "林澈",
  });
  await Promise.all([
    writeFile(join(projectDir, "story", "bible.json"), `${JSON.stringify({
      version: "v0",
      projectLogline: "旧城区公寓楼求生与无线电异常信号调查",
      premise: "林澈在旧城区灾变中求生，逐步确认无线电异常信号。",
      genre: "apocalypse",
      subgenres: ["survival", "mystery"],
      readerPromise: "看普通人在断电旧城区靠判断和胆量活下去。",
      longFormGoals: ["活过前三天", "找到可信避难所"],
      centralConflicts: ["公寓楼内幸存者互不信任"],
      coreMysteries: ["无线电异常信号来源"],
      protectedSecrets: ["避难所真实目的"],
      forbiddenChanges: ["林澈不能突然拥有强大战斗力"],
      canonFacts: ["城市断电断网，物资稀缺。"],
      openQuestions: ["避难所广播是真是假"],
      setupAssets: {
        initialAssets: ["旧收音机"],
        keyItems: ["避难所地图"],
        resourceLimits: ["水和药都不足"],
      },
    }, null, 2)}\n`, "utf-8"),
    writeFile(join(projectDir, "story", "writing-rules.json"), `${JSON.stringify({
      version: "v0",
      narrativePerspective: "third_limited",
      proseStyle: ["紧张", "克制"],
      chapterLength: { targetWords: 1800 },
      pacing: "medium",
      revealPolicy: "balanced",
      genreRequirements: ["普通物资不能当作悬念"],
      suspenseRules: ["每章至少保留一个未完全解释的异常"],
      payoffRules: ["线索回收必须有正文证据"],
      reversalRules: ["反转不能推翻已提交事实"],
      readerExperienceRules: ["避免任务清单式推进"],
      forbiddenContent: [],
      doNotDo: ["不要自动改正式状态"],
    }, null, 2)}\n`, "utf-8"),
    writeFile(join(projectDir, "story", "character-bible.json"), `${JSON.stringify({
      version: "v0",
      characters: [
        {
          id: "lin-che",
          name: "林澈",
          role: "protagonist",
          desire: "确认信号源且暂时没有强大战斗力",
          weakness: "暂时缺少可靠武器",
          behaviorBoundaries: ["不能突然拥有强大战斗力"],
          knowledgeKnown: ["无线电信号异常"],
          knowledgeUnknown: ["避难所广播背后的真实来源"],
        },
      ],
    }, null, 2)}\n`, "utf-8"),
    writeFile(join(projectDir, "story", "world-bible.json"), `${JSON.stringify({
      version: "v0",
      rules: ["城市断电断网，物资稀缺。"],
      factions: [],
      powerOrSurvivalSystems: ["无线电", "水源"],
      historyFacts: [],
      socialOrder: [],
    }, null, 2)}\n`, "utf-8"),
    writeFile(join(projectDir, "story", "location-bible.json"), `${JSON.stringify({
      version: "v0",
      locations: [
        {
          id: "garage",
          name: "地下车库",
          type: "route",
          knownFeatures: ["信号较强"],
          risks: ["深处有异响"],
          resources: ["备用电池"],
        },
      ],
    }, null, 2)}\n`, "utf-8"),
    writeFile(join(projectDir, "story", "hooks.json"), `${JSON.stringify({
      hooks: [
        {
          id: "hook-radio",
          title: "无线电异常信号",
          description: "收音机里出现断续广播。",
          status: "active",
          firstSeenChapter: 2,
          lastTouchedChapter: 7,
          evidence: ["第7章：广播频率异常。"],
          nextActionHint: "确认信号源。",
        },
      ],
    }, null, 2)}\n`, "utf-8"),
    writeFile(join(projectDir, "story", "threads.json"), `${JSON.stringify({
      threads: [
        {
          id: "lead-signal",
          type: "lead",
          title: "确认无线电信号来源",
          status: "touched",
          firstSeenChapter: 3,
          lastTouchedChapter: 7,
          evidence: ["收音机里出现避难所坐标。"],
          relatedLocations: ["地下车库"],
        },
        {
          id: "intent-medicine",
          type: "intent",
          title: "去药店找药",
          status: "open",
          firstSeenChapter: 4,
          lastTouchedChapter: 6,
          evidence: ["他决定先去药店找绷带。"],
          relatedLocations: ["药店"],
        },
        {
          id: "intent-low",
          type: "intent",
          title: "林澈想了想，决定先不管这个",
          status: "open",
          firstSeenChapter: 1,
          lastTouchedChapter: 1,
          evidence: ["他想了想，决定先不管这个。"],
        },
      ],
    }, null, 2)}\n`, "utf-8"),
    writeFile(join(projectDir, "story", "arc-goals.json"), `${JSON.stringify({
      goals: [
        {
          id: "goal-shelter",
          title: "判断避难所广播真假",
          status: "active",
          scope: "mini_arc",
          firstSeenChapter: 5,
          lastTouchedChapter: 7,
          evidence: ["广播坐标和信号源不一致。"],
          relatedLocations: ["地下车库"],
        },
      ],
    }, null, 2)}\n`, "utf-8"),
    writeFile(join(projectDir, "timeline", "events.json"), `${JSON.stringify([
      {
        id: "ch0007-001",
        chapter: 7,
        summary: "林澈在地下车库听见收音机断续广播，意识到信号源可能不在避难所坐标。",
        participants: ["lin-che"],
        effects: {
          semanticSummary: {
            mainEvent: "林澈发现信号源异常。",
            locations: ["地下车库"],
            genreProgression: { currentStage: "shelter_truth" },
          },
        },
      },
    ], null, 2)}\n`, "utf-8"),
  ]);
  return projectDir;
}

async function snapshotStateFiles(projectDir: string): Promise<Record<string, string>> {
  const files = [
    "project.json",
    "story/bible.json",
    "story/writing-rules.json",
    "story/character-bible.json",
    "story/world-bible.json",
    "story/location-bible.json",
    "story/hooks.json",
    "story/threads.json",
    "story/arc-goals.json",
    "timeline/events.json",
    "world/state.json",
    "time/calendar.json",
    `characters/${toSafeCharacterId("林澈")}/state.json`,
  ];
  const entries = await Promise.all(files.map(async (file) => [
    file,
    createHash("sha256").update(await readFile(join(projectDir, file), "utf-8")).digest("hex"),
  ] as const));
  return Object.fromEntries(entries);
}
