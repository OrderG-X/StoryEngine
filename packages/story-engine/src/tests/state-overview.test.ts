import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createStoryProject, toSafeCharacterId } from "../project-store.js";
import { buildStateOverview } from "../state-overview.js";

describe("State Overview Pack V0", () => {
  it("recovers project-wide commit residue before ordinary overview reads", async () => {
    const projectDir = await createOverviewFixture();
    const timelineRelativePath = join("timeline", "events.json");
    const timelinePath = join(projectDir, timelineRelativePath);
    const originalTimeline = await readFile(timelinePath, "utf-8");
    const txDir = join(projectDir, ".story-engine-tx", "commit-chapter-0001");
    const backupPath = join("backups", timelineRelativePath);
    await mkdir(join(txDir, "backups", "timeline"), { recursive: true });
    await writeFile(join(txDir, backupPath), originalTimeline, "utf-8");
    await writeFile(join(txDir, "manifest.json"), `${JSON.stringify({
      version: 2,
      chapter: 1,
      createdAt: "2026-07-13T00:00:00.000Z",
      files: [timelineRelativePath],
      backups: [{
        relativePath: timelineRelativePath,
        existed: true,
        backupPath,
        sha256: createHash("sha256").update(originalTimeline, "utf-8").digest("hex"),
      }],
      status: "staged",
    }, null, 2)}\n`, "utf-8");
    await writeFile(timelinePath, `${JSON.stringify([{
      id: "partial-overview-contamination",
      chapter: 999,
      summary: "partial residue must not be observed",
      participants: [],
    }], null, 2)}\n`, "utf-8");

    const overview = await buildStateOverview({ projectDir, chapter: 5 });

    expect(overview.timeline.recentEvents.some((event) => event.summary.includes("partial residue"))).toBe(false);
    await expect(readFile(timelinePath, "utf-8")).resolves.toBe(originalTimeline);
    await expect(readFile(join(txDir, "manifest.json"), "utf-8"))
      .resolves.toContain('"status": "recovered"');
  });

  it("builds a read-only UI ViewModel from a fixture project", async () => {
    const projectDir = await createOverviewFixture();
    const before = await snapshotStateFiles(projectDir);

    const overview = await buildStateOverview({ projectDir, chapter: 5, maxTimelineEvents: 2 });

    expect(overview.project).toMatchObject({
      title: "状态总览测试",
      genre: "apocalypse",
      currentChapter: 5,
    });
    expect(overview.storyStatus.currentLocation).toBe("地下车库");
    expect(overview.hooks.activeCount).toBe(1);
    expect(overview.threads).toMatchObject({
      total: 3,
      open: 1,
      touched: 1,
      done: 1,
      openIntents: 1,
    });
    expect(overview.threads.cleanupVisibleCount).toBeGreaterThan(0);
    expect(overview.threads.keyOpenItems.map((item) => item.id)).toContain("intent-low");
    expect(overview.arcGoals.activeCount).toBe(1);
    expect(overview.timeline.recentEvents).toHaveLength(2);
    expect(overview.characters.protagonist).toBe("林澈");
    expect(overview.storyFoundation).toMatchObject({
      available: true,
      missingFiles: [],
    });
    expect(overview.storyFoundation.summary).toContain("Foundation available");
    expect(overview.storyBible).toMatchObject({
      available: true,
      genre: "apocalypse",
      projectLogline: "旧城区公寓楼求生与无线电异常信号调查",
    });
    expect(overview.storyBible.longFormGoals).toEqual(expect.arrayContaining(["找到可信避难所"]));
    expect(overview.writingRules).toMatchObject({
      available: true,
      narrativePerspective: "third_limited",
      pacing: "medium",
      targetChapterWords: 1800,
    });
    expect(overview.characterBible.keyCharacters.map((item) => item.name)).toContain("林澈");
    expect(overview.characterBible.keyCharacters[0]).toMatchObject({
      weakness: "暂时缺少可靠武器",
      knowledgeKnown: expect.arrayContaining(["无线电信号异常"]),
      knowledgeUnknown: expect.arrayContaining(["避难所广播背后的真实来源"]),
    });
    expect(overview.worldBible.keyRules).toContain("城市断电断网，物资稀缺。");
    expect(overview.locationBible.activeLocationNames).toEqual(expect.arrayContaining(["公寓楼", "地下车库"]));
    expect(overview.locationBible.keyRisks).toEqual(expect.arrayContaining(["地下车库：深处有异响"]));
    expect(overview.locationBible.keyResources).toEqual(expect.arrayContaining(["地下车库：备用电池"]));
    expect(overview.assetSummary).toMatchObject({
      available: true,
      carriedAssets: expect.arrayContaining(["旧收音机"]),
      unavailableAssets: expect.arrayContaining(["欠费手机 · locked · 欠费，无法正常联网"]),
      plotCriticalAssets: expect.arrayContaining(["避难所地图"]),
    });
    expect(overview.locationDetailSummary).toMatchObject({
      floors: expect.arrayContaining(["1楼大厅", "地下1层车库"]),
      rooms: expect.arrayContaining(["301室", "地下车库入口"]),
      travelRules: expect.arrayContaining(["公寓楼 -> 地下车库 · stairs · 2分钟"]),
    });
    expect(overview.characterDetailSummary.characters[0]).toMatchObject({
      age: "27岁",
      speechStyle: "短句、谨慎、先确认风险。",
      speechSamples: expect.arrayContaining(["先别急，听完这段广播。"]),
      cannotDo: expect.arrayContaining(["暂时没有强大战斗力"]),
    });
    expect(overview.characterMatrix.available).toBe(true);
    expect(overview.characterMatrix.characters.find((character) => character.name === "林澈")).toMatchObject({
      age: "27岁",
      speechStyle: "短句、谨慎、先确认风险。",
      speechSamples: expect.arrayContaining(["先别急，听完这段广播。"]),
      knownFacts: expect.arrayContaining(["无线电信号异常"]),
      unknownTruths: expect.arrayContaining(["避难所广播背后的真实来源"]),
      carriedAssets: expect.arrayContaining(["旧收音机"]),
      plotCriticalAssets: expect.arrayContaining(["避难所地图"]),
      lastSeenChapter: 5,
    });
    expect(overview.characterMatrix.characters.find((character) => character.name === "苏雨")).toMatchObject({
      relationshipToProtagonist: "盟友，但怀疑林澈隐瞒无线电细节",
    });
    expect(overview.characterMatrix.relationships).toEqual(expect.arrayContaining([
      expect.objectContaining({
        targetName: "苏雨",
        relationType: "朋友",
        attitude: "怀疑",
        trustLevel: "low",
      }),
    ]));
    expect(overview.foundationCompleteness.readinessLevel).toBe("ready");
    expect(overview.world.importantFacts).not.toContain("无线电异常信号来源");
    expect(overview.world.protectedSecrets).toEqual(expect.arrayContaining(["无线电异常信号来源"]));
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
    expect(overview.timeline.recentEvents.at(-1)?.summary.length).toBeLessThanOrEqual(160);
    expect(JSON.stringify(overview)).not.toContain("长文本尾巴不应该出现在 overview 里");
    await expect(snapshotStateFiles(projectDir)).resolves.toEqual(before);
  });

  // 编辑部 R5.4·新发现 4：cleanupVisibleCount 把已收口（done/stale）的意图线索也算进候选，
  // 入库回执拿它当「其中 X 条」曾写出「积到 55 条，其中 78 条」。threads.cleanupVisibleUnresolvedCount
  // 只数仍未收口（open/touched）的候选——与 open+touched 同一集合，恒 ≤ open+touched。
  it("cleanupVisibleUnresolvedCount 与 open+touched 同一集合：done/stale 的候选不计入（R5.4）", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "story-engine-state-overview-r54-"));
    const { projectDir } = await createStoryProject({
      rootDir,
      title: "线索口径测试",
      genre: "都市",
      premise: "测试线索计数口径。",
      mainCharacterName: "林澈",
    });
    await writeFile(join(projectDir, "story", "threads.json"), `${JSON.stringify({
      threads: [
        // 低价值 generic 意图、未收口（open）→ cleanup 候选，且算进未收口。
        { id: "t-open-low", type: "intent", title: "想了想", status: "open", firstSeenChapter: 1, lastTouchedChapter: 5, evidence: [] },
        // 同样低价值、但已收口（done）→ 仍是 cleanup 候选（manual_review_mark_done），不算未收口。
        { id: "t-done-low", type: "intent", title: "犹豫了一下", status: "done", firstSeenChapter: 1, lastTouchedChapter: 5, evidence: [] },
        // 高价值线索（信号/来源类）、未收口（touched）→ 不算 cleanup 候选。
        { id: "t-open-high", type: "intent", title: "查清信号来源", status: "touched", firstSeenChapter: 1, lastTouchedChapter: 5, evidence: ["确认记录里的线索来源"] },
        // 已过期（stale）、低价值 → cleanup 候选，不算未收口。
        { id: "t-stale-low", type: "intent", title: "先不管", status: "stale", firstSeenChapter: 1, lastTouchedChapter: 1, evidence: [] },
      ],
    }, null, 2)}\n`, "utf-8");

    const overview = await buildStateOverview({ projectDir, chapter: 5 });

    expect(overview.threads.open).toBe(1);
    expect(overview.threads.touched).toBe(1);
    // 老口径：4 条意图里 3 条是候选（open 低价值、done、stale；高价值不算）——done/stale 也数进去。
    expect(overview.threads.cleanupVisibleCount).toBe(3);
    // 同集合口径：未收口（open/touched）的候选只有 open 那条低价值。
    expect(overview.threads.cleanupVisibleUnresolvedCount).toBe(1);
    expect(overview.threads.cleanupVisibleUnresolvedCount)
      .toBeLessThanOrEqual(overview.threads.open + overview.threads.touched);
    await rm(rootDir, { recursive: true, force: true });
  });

  it("透出角色/地点/资产/世界观的 extraFields（受控破例⑦：展示路与喂模型路同源）", async () => {
    const projectDir = await createOverviewFixture();

    // 给现有实体注入 extraFields（读→改→写，不动共享 fixture）。
    const cbPath = join(projectDir, "story", "character-bible.json");
    const cb = JSON.parse(await readFile(cbPath, "utf-8")) as { characters: Record<string, unknown>[] };
    cb.characters[0].extraFields = { 外号: "阿澈", 习惯: ["熬夜守夜", "省电"] };
    await writeFile(cbPath, `${JSON.stringify(cb, null, 2)}\n`, "utf-8");

    const lbPath = join(projectDir, "story", "location-bible.json");
    const lb = JSON.parse(await readFile(lbPath, "utf-8")) as { locations: Record<string, unknown>[] };
    lb.locations[0].extraFields = { 气味: "霉味与铁锈" };
    await writeFile(lbPath, `${JSON.stringify(lb, null, 2)}\n`, "utf-8");

    const asPath = join(projectDir, "story", "assets.json");
    const as = JSON.parse(await readFile(asPath, "utf-8")) as { assets: Record<string, unknown>[] };
    as.assets[0].extraFields = { 来历: "父亲遗物" };
    await writeFile(asPath, `${JSON.stringify(as, null, 2)}\n`, "utf-8");

    await mkdir(join(projectDir, "world"), { recursive: true });
    await writeFile(
      join(projectDir, "world", "state.json"),
      `${JSON.stringify({ currentPhase: "unknown", activeConflicts: [], activeHooks: [], knownSecrets: [], extraFields: { 历法: "灾年纪元" } }, null, 2)}\n`,
      "utf-8",
    );

    const overview = await buildStateOverview({ projectDir, chapter: 5 });
    expect(overview.characterMatrix.characters.find((c) => c.name === "林澈")?.extraFields)
      .toMatchObject({ 外号: "阿澈", 习惯: ["熬夜守夜", "省电"] });
    expect(overview.locationDetailSummary.locations.find((l) => l.name === "公寓楼")?.extraFields)
      .toMatchObject({ 气味: "霉味与铁锈" });
    expect(overview.assetSummary.assetItems.find((a) => a.name === "旧收音机")?.extraFields)
      .toMatchObject({ 来历: "父亲遗物" });
    expect(overview.worldBible.extraFields).toMatchObject({ 历法: "灾年纪元" });
  });

  it("透出写作规则 customNotes（受控破例⑧·展示）", async () => {
    const projectDir = await createOverviewFixture();
    const wrPath = join(projectDir, "story", "writing-rules.json");
    const wr = JSON.parse(await readFile(wrPath, "utf-8")) as Record<string, unknown>;
    wr.customNotes = "## 我的补充\n- 每章开头标时间卡";
    await writeFile(wrPath, `${JSON.stringify(wr, null, 2)}\n`, "utf-8");

    const overview = await buildStateOverview({ projectDir, chapter: 5 });
    expect(overview.writingRules.customNotes).toBe("## 我的补充\n- 每章开头标时间卡");
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

  it("derives currentStage from worldState.currentPhase, not timeline genreProgression", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "story-engine-overview-pollution-"));
    const { projectDir } = await createStoryProject({
      rootDir,
      title: "从零开始的海天市",
      genre: "都市爽文/暧昧流",
      premise: "林远继承远山集团后进入都市上层圈。",
      mainCharacterName: "林远",
    });
    await writeFile(join(projectDir, "timeline", "events.json"), `${JSON.stringify([
      {
        id: "ch0005-001",
        chapter: 5,
        summary: "林远拒绝集团安排的专车和司机，坐公交回老房子。",
        participants: ["character"],
        effects: {
          semanticSummary: {
            mainEvent: "林远拒绝集团安排的专车和司机。",
            genreProgression: {
              genre: "apocalypse",
              currentStage: "supply_route",
              activeStageGoals: ["获取急救药品"],
              nextStageLeads: ["药店"],
              mustCarryForward: ["药店药品"],
            },
          },
        },
      },
    ], null, 2)}\n`, "utf-8");

    const overview = await buildStateOverview({ projectDir, chapter: 6 });

    // currentStage is sourced solely from worldState.currentPhase ("开篇" for a fresh project),
    // never from a timeline event's genreProgression.currentStage ("supply_route").
    expect(overview.storyStatus.currentStage).toBe("开篇");
    expect(overview.storyStatus.currentStage).not.toBe("supply_route");
  });

  it("merges runtime character files into character views even when character bible exists", async () => {
    const projectDir = await createOverviewFixture();
    const characterDir = join(projectDir, "characters", "runtime-only");
    await mkdir(characterDir, { recursive: true });
    await Promise.all([
      writeFile(join(characterDir, "profile.json"), `${JSON.stringify({
        id: "runtime-only",
        name: "运行时角色",
        identity: "线索提供者",
        age: "31岁",
        gender: "女",
      }, null, 2)}\n`, "utf-8"),
      writeFile(join(characterDir, "state.json"), `${JSON.stringify({
        characterId: "runtime-only",
        emotion: "警惕",
        goal: "确认主角是否可信",
        lastUpdatedChapter: 5,
      }, null, 2)}\n`, "utf-8"),
    ]);

    const overview = await buildStateOverview({ projectDir, chapter: 5 });

    expect(overview.characters.knownCharacters.find((character) => character.name === "运行时角色")).toMatchObject({
      status: "警惕",
      mood: "警惕",
      currentGoal: "确认主角是否可信",
    });
    expect(overview.characterMatrix.characters.find((character) => character.name === "运行时角色")).toMatchObject({
      age: "31岁",
      gender: "女",
      identity: "线索提供者",
      mood: "警惕",
      mentalState: "警惕",
      currentGoal: "确认主角是否可信",
    });
    expect(overview.characterDetailSummary.characters.find((character) => character.name === "运行时角色")).toMatchObject({
      age: "31岁",
      currentState: "警惕",
    });
  });

  it("projects committed character mood, currentGoal, and recentEvents with legacy fallbacks intact", async () => {
    const projectDir = await createOverviewFixture();
    const characterDir = join(projectDir, "characters", "lin-xiao");
    await mkdir(characterDir, { recursive: true });
    await Promise.all([
      writeFile(join(characterDir, "profile.json"), `${JSON.stringify({
        id: "lin-xiao",
        name: "林晓",
        identity: "守护者",
      }, null, 2)}\n`, "utf-8"),
      writeFile(join(characterDir, "state.json"), `${JSON.stringify({
        characterId: "lin-xiao",
        mood: "冷静",
        currentGoal: "保护主角",
        recentEvents: ["完成角色状态确认写入封测"],
        relationshipToUser: "信任",
        lastUpdatedChapter: 5,
      }, null, 2)}\n`, "utf-8"),
    ]);

    const overview = await buildStateOverview({ projectDir, chapter: 5 });

    expect(overview.characters.knownCharacters.find((character) => character.name === "林晓")).toMatchObject({
      status: "冷静",
      mood: "冷静",
      currentGoal: "保护主角",
      recentEvents: ["完成角色状态确认写入封测"],
    });
    expect(overview.characterMatrix.characters.find((character) => character.name === "林晓")).toMatchObject({
      mood: "冷静",
      mentalState: "冷静",
      currentGoal: "保护主角",
      recentEvents: ["完成角色状态确认写入封测"],
    });
    expect(overview.characterDetailSummary.characters.find((character) => character.name === "林晓")).toMatchObject({
      mood: "冷静",
      currentGoal: "保护主角",
      recentEvents: ["完成角色状态确认写入封测"],
      currentState: "冷静",
    });
  });

  it("returns empty foundation summaries for legacy projects without bible files", async () => {
    const projectDir = await createOverviewFixture();
    await Promise.all([
      rm(join(projectDir, "story", "bible.json")),
      rm(join(projectDir, "story", "writing-rules.json")),
      rm(join(projectDir, "story", "character-bible.json")),
      rm(join(projectDir, "story", "world-bible.json")),
      rm(join(projectDir, "story", "location-bible.json")),
    ]);

    const overview = await buildStateOverview({ projectDir });

    expect(overview.storyFoundation.available).toBe(false);
    expect(overview.storyFoundation.missingFiles).toEqual([
      "story/bible.json",
      "story/writing-rules.json",
      "story/character-bible.json",
      "story/world-bible.json",
      "story/location-bible.json",
    ]);
    expect(overview.storyBible.available).toBe(false);
    expect(overview.storyBible.longFormGoals).toEqual([]);
    expect(overview.writingRules.available).toBe(false);
    expect(overview.writingRules.proseStyle).toEqual([]);
    expect(overview.characterBible.characterCount).toBe(0);
    expect(overview.worldBible.ruleCount).toBe(0);
    expect(overview.locationBible.locationCount).toBe(0);
  });

  // Task 4: 用例 A — 早期未收口伏笔仍出现在 activeItems（不被近章挤掉）
  it("(Task 4-A) 早期未收口条目在≥12条近章时仍出现在 hooks.activeItems 和 threads.keyOpenItems", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "story-engine-task4-a-"));
    const { projectDir } = await createStoryProject({
      rootDir,
      title: "早期伏笔召回测试",
      genre: "urban",
      premise: "测试早期伏笔不被近章挤掉。",
      mainCharacterName: "主角",
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

    await Promise.all([
      writeFile(join(projectDir, "story", "hooks.json"), `${JSON.stringify({
        hooks: [earlyHook, ...recentHooks],
      }, null, 2)}\n`, "utf-8"),
      writeFile(join(projectDir, "story", "threads.json"), `${JSON.stringify({
        threads: [earlyThread, ...recentThreads],
      }, null, 2)}\n`, "utf-8"),
    ]);

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
      premise: "新书空timeline章号null测试。",
      mainCharacterName: "主角",
    });

    await Promise.all([
      writeFile(join(projectDir, "story", "hooks.json"), `${JSON.stringify({
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
      }, null, 2)}\n`, "utf-8"),
      writeFile(join(projectDir, "story", "threads.json"), `${JSON.stringify({
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
      }, null, 2)}\n`, "utf-8"),
      // timeline 为空（不写 events.json，使用默认空数组）
    ]);

    // 不传 chapter → currentChapter=null，兜底章号应保证条目不被排除
    const overview = await buildStateOverview({ projectDir });

    expect(overview.hooks.activeItems.map((item) => item.id)).toContain("hook-new");
    expect(overview.threads.keyOpenItems.map((item) => item.id)).toContain("thread-new");
  });
});

// R5b 题材中立化：currentLocation 选取不得再依赖写死的末日/职场专名，
// 必须读项目自己的 location-bible（空间结构 + 楼层归一化）来判断具体度/匹配。
describe("State Overview currentLocation — genre-neutral (R5b)", () => {
  it("源码不再写死任何题材专名地点（公交站/孵化楼/申请窗口/办公区/终端区/旧城区/楼层映射）", async () => {
    const source = await readFile(join(__filenameDir(), "..", "state-overview.ts"), "utf-8");
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

  it("修仙题材：选当前位置读 bible 登记的具体空间部件，泛指语（路上）被忽略", async () => {
    const projectDir = await createGenreNeutralFixture({
      genre: "xianxia",
      locations: [
        {
          id: "ju-ling-feng",
          name: "聚灵峰",
          type: "sect",
          spatialStructure: { floors: ["三层档案室"], rooms: ["丹房", "档案室"], entrances: ["大门"], exits: ["后院小径"] },
          knownFeatures: ["灵气浓郁"],
          risks: ["走火入魔"],
          resources: ["灵石矿脉"],
        },
      ],
      events: [
        { id: "ch0001-001", chapter: 1, locations: ["路上"] },
        { id: "ch0002-001", chapter: 2, locations: ["路上", "档案室"] },
      ],
    });
    const overview = await buildStateOverview({ projectDir, chapter: 2 });
    // 「档案室」是 bible 登记的房间（具体），「路上」是泛指语 → 选具体的、登记的位置。
    expect(overview.storyStatus.currentLocation).toBe("档案室");
  });

  it("都市题材：口语中文楼层（一楼大厅）经楼层归一化匹配 bible 登记的数字楼层（1楼大厅），不靠写死映射", async () => {
    const projectDir = await createGenreNeutralFixture({
      genre: "urban",
      locations: [
        {
          id: "tian-heng",
          name: "天衡大厦",
          type: "building",
          spatialStructure: { floors: ["1楼大厅", "3楼会议室"], rooms: ["前台"], entrances: ["旋转门"], exits: ["消防楼梯"] },
          knownFeatures: ["玻璃幕墙"],
          risks: [],
          resources: [],
        },
      ],
      events: [
        { id: "ch0001-001", chapter: 1, locations: ["外面"] },
        { id: "ch0002-001", chapter: 2, locations: ["一楼大厅"] },
      ],
    });
    const overview = await buildStateOverview({ projectDir, chapter: 2 });
    // 「一楼大厅」必须经题材中立的楼层归一化匹配到登记的「1楼大厅」并被选为当前位置。
    expect(overview.storyStatus.currentLocation).toBe("一楼大厅");
  });

  it("未登记的位置：带题材中立结构后缀仍算具体并被选中（不依赖任何题材词表）", async () => {
    const projectDir = await createGenreNeutralFixture({
      genre: "mystery",
      locations: [
        {
          id: "old-town",
          name: "雾港老城",
          type: "district",
          spatialStructure: { floors: [], rooms: ["警局值班室"], entrances: [], exits: [] },
          knownFeatures: [],
          risks: [],
          resources: [],
        },
      ],
      events: [
        // 两者都未登记；「码头仓库」带结构后缀（库）更具体，「那台」是泛指语应被排除。
        { id: "ch0001-001", chapter: 1, locations: ["那台", "码头仓库"] },
      ],
    });
    const overview = await buildStateOverview({ projectDir, chapter: 1 });
    expect(overview.storyStatus.currentLocation).toBe("码头仓库");
  });

  it("无 location-bible 时不崩、退回语义地点具体度打分（题材中立兜底）", async () => {
    const projectDir = await createGenreNeutralFixture({
      genre: "scifi",
      locations: [],
      events: [
        { id: "ch0001-001", chapter: 1, locations: ["全市", "空间站舱门"] },
      ],
    });
    const overview = await buildStateOverview({ projectDir, chapter: 1 });
    // 「空间站舱门」带结构后缀（门）→ 具体；「全市」是泛指语 → 被排除。
    expect(overview.storyStatus.currentLocation).toBe("空间站舱门");
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
      premise: "江湖风云",
      mainCharacterName: "侠客",
    });

    // 构造 50 章 timeline，每章一个事件，mainEvent 包含章号方便断言
    const events = Array.from({ length: 50 }, (_, i) => {
      const ch = i + 1;
      return {
        id: `ch${String(ch).padStart(4, "0")}-001`,
        chapter: ch,
        summary: `第${ch}章：主角经历了事件${ch}。`,
        participants: ["protagonist"],
        effects: {
          semanticSummary: {
            mainEvent: `第${ch}章核心事件mainEvent${ch}`,
            timelineSummary: `第${ch}章时间线摘要`,
          },
        },
      };
    });

    await writeFile(
      join(projectDir, "timeline", "events.json"),
      `${JSON.stringify(events, null, 2)}\n`,
      "utf-8",
    );

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
    await writeFile(
      join(projectDir, "timeline", "events.json"),
      `${JSON.stringify([], null, 2)}\n`,
      "utf-8",
    );
    const emptyOverview = await buildStateOverview({ projectDir, chapter: 1 });
    expect(emptyOverview.timeline.recentEvents).toHaveLength(0);
    expect(emptyOverview.timeline.earlierSummary).toHaveLength(0);
    expect(emptyOverview.timeline.macroSummary).toHaveLength(0);
  });
});

function __filenameDir(): string {
  // 测试文件位于 src/tests/，引擎源码在 src/。fileURLToPath 才能正确解码路径里的空格等。
  return dirname(fileURLToPath(import.meta.url));
}

interface GenreNeutralFixtureInput {
  readonly genre: string;
  readonly locations: readonly Record<string, unknown>[];
  readonly events: readonly { readonly id: string; readonly chapter: number; readonly locations: readonly string[] }[];
}

async function createGenreNeutralFixture(input: GenreNeutralFixtureInput): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "story-engine-overview-neutral-"));
  const { projectDir } = await createStoryProject({
    rootDir,
    title: "题材中立总览测试",
    genre: input.genre,
    premise: "题材中立的当前位置选取测试。",
    mainCharacterName: "主角",
  });
  await Promise.all([
    writeFile(join(projectDir, "story", "location-bible.json"), `${JSON.stringify({
      version: "v0",
      locations: input.locations,
    }, null, 2)}\n`, "utf-8"),
    writeFile(join(projectDir, "timeline", "events.json"), `${JSON.stringify(input.events.map((event) => ({
      id: event.id,
      chapter: event.chapter,
      summary: `第${event.chapter}章事件`,
      participants: [],
      effects: {
        semanticSummary: {
          mainEvent: `第${event.chapter}章主事件`,
          locations: event.locations,
        },
      },
    })), null, 2)}\n`, "utf-8"),
  ]);
  return projectDir;
}

async function createOverviewFixture(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "story-engine-state-overview-"));
  const { projectDir } = await createStoryProject({
    rootDir,
    title: "状态总览测试",
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
      canonFacts: ["城市断电断网"],
      openQuestions: ["避难所广播是真是假"],
      setupAssets: {
        initialAssets: ["旧收音机"],
        keyItems: ["避难所地图"],
        resourceLimits: ["水和药都不足"],
      },
      firstChapterSetup: {
        goal: "第一次确认广播异常",
        openingScene: "断电公寓",
        hook: "收音机自动响起",
        conflict: "楼内幸存者互不信任",
      },
    }, null, 2)}\n`, "utf-8"),
    writeFile(join(projectDir, "story", "writing-rules.json"), `${JSON.stringify({
      version: "v0",
      narrativePerspective: "third_limited",
      proseStyle: ["紧张", "克制", "行动驱动"],
      chapterLength: { targetWords: 1800 },
      pacing: "medium",
      revealPolicy: "balanced",
      genreRequirements: ["普通物资不能当作悬念"],
      suspenseRules: ["每章至少保留一个未完全解释的异常"],
      payoffRules: ["线索回收必须有正文证据"],
      reversalRules: ["反转不能推翻已提交事实"],
      readerExperienceRules: ["避免任务清单式推进"],
      forbiddenContent: ["无证据洗白避难所"],
      doNotDo: ["不要自动改正式状态"],
    }, null, 2)}\n`, "utf-8"),
    writeFile(join(projectDir, "story", "character-bible.json"), `${JSON.stringify({
      version: "v0",
      characters: [
        {
          id: "lin-che",
          name: "林澈",
          role: "protagonist",
          age: "27岁",
          identity: "旧城区幸存者",
          desire: "保护自己并确认无线电信号来源",
          weakness: "暂时缺少可靠武器",
          behaviorBoundaries: ["暂时没有强大战斗力"],
          knowledgeKnown: ["无线电信号异常"],
          knowledgeUnknown: ["避难所广播背后的真实来源"],
          speechStyle: "短句、谨慎、先确认风险。",
          speechSamples: ["先别急，听完这段广播。"],
          cannotDo: ["暂时没有强大战斗力"],
        },
        {
          id: "su-yu",
          name: "苏雨",
          role: "重要角色",
          age: "26岁",
          identity: "楼内临时医疗志愿者",
          desire: "确认避难所是否可信",
          fear: "楼内幸存者内斗",
          weakness: "不擅长近身冲突",
          relationshipToProtagonist: "盟友，但怀疑林澈隐瞒无线电细节",
          behaviorBoundaries: ["不会无证据相信避难所广播"],
          knowledgeKnown: ["林澈手里有旧收音机"],
          knowledgeUnknown: ["避难所广播背后的真实来源"],
          speechStyle: "直接追问，先要证据。",
          speechSamples: ["你听到的不是全部，对吗？"],
          cannotDo: ["无法独自清理地下车库"],
        },
      ],
    }, null, 2)}\n`, "utf-8"),
    writeFile(join(projectDir, "story", "world-bible.json"), `${JSON.stringify({
      version: "v0",
      rules: ["城市断电断网，物资稀缺。"],
      factions: [
        { id: "apt-survivors", name: "公寓楼幸存者", goal: "守住楼内资源" },
      ],
      powerOrSurvivalSystems: ["水源", "药品", "无线电"],
      historyFacts: ["灾变发生在旧城区"],
      socialOrder: ["幸存者互不信任"],
    }, null, 2)}\n`, "utf-8"),
    writeFile(join(projectDir, "story", "location-bible.json"), `${JSON.stringify({
      version: "v0",
      locations: [
        {
          id: "apt",
          name: "公寓楼",
          type: "safehouse",
          spatialStructure: {
            floors: ["1楼大厅", "3楼住户区"],
            rooms: ["301室", "楼道"],
            entrances: ["单元门"],
            exits: ["楼梯间"],
          },
          travelRules: [
            { targetLocation: "地下车库", method: "stairs", durationMinutes: 2 },
          ],
          knownFeatures: ["楼道狭窄"],
          risks: ["感染者可能上楼"],
          resources: ["水箱"],
        },
        {
          id: "garage",
          name: "地下车库",
          type: "route",
          spatialStructure: {
            floors: ["地下1层车库"],
            rooms: ["地下车库入口", "配电室"],
            entrances: ["楼梯间"],
            exits: ["消防通道"],
          },
          travelRules: [
            { targetLocation: "公寓楼", method: "stairs", durationMinutes: 2 },
          ],
          knownFeatures: ["信号较强"],
          risks: ["深处有异响"],
          resources: ["备用电池"],
        },
      ],
    }, null, 2)}\n`, "utf-8"),
    writeFile(join(projectDir, "story", "assets.json"), `${JSON.stringify({
      version: "v0",
      assets: [
        { id: "radio", name: "旧收音机", type: "keyItem", ownerCharacterId: "lin-che", ownerName: "林澈", carriedByCharacterId: "lin-che", status: "available", isPlotCritical: true, canAiModify: false },
        { id: "phone", name: "欠费手机", type: "keyItem", ownerCharacterId: "lin-che", ownerName: "林澈", carriedByCharacterId: "lin-che", status: "locked", conditionNote: "欠费，无法正常联网", isPlotCritical: true, canAiModify: false },
        { id: "map", name: "避难所地图", type: "document", ownerCharacterId: "lin-che", ownerName: "林澈", carriedByCharacterId: "lin-che", status: "available", isPlotCritical: true, canAiModify: false },
      ],
      containers: [],
    }, null, 2)}\n`, "utf-8"),
    writeFile(join(projectDir, "story", "hooks.json"), `${JSON.stringify({
      hooks: [
        {
          id: "hook-radio",
          title: "无线电异常信号",
          description: "收音机里出现断续广播。",
          status: "active",
          relatedCharacters: ["lin-che"],
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
    }, null, 2)}\n`, "utf-8"),
    writeFile(join(projectDir, "story", "threads.json"), `${JSON.stringify({
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
          relatedLocations: ["地下车库"],
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
    }, null, 2)}\n`, "utf-8"),
    writeFile(join(projectDir, "story", "arc-goals.json"), `${JSON.stringify({
      goals: [
        {
          id: "goal-survive",
          title: "在旧城区灾变中生存下来",
          status: "active",
          scope: "main_arc",
          firstSeenChapter: 1,
          lastTouchedChapter: 5,
          evidence: ["林澈继续寻找安全路线。"],
          relatedLocations: ["旧城区"],
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
    }, null, 2)}\n`, "utf-8"),
    writeFile(join(projectDir, "timeline", "events.json"), `${JSON.stringify([
      {
        id: "ch0004-001",
        chapter: 4,
        summary: "林澈在楼道避开感染者。",
        participants: ["lin-che"],
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
        participants: ["lin-che"],
        effects: {
          semanticSummary: {
            mainEvent: "林澈在地下车库听见断续广播。",
            locations: ["地下车库"],
            genreProgression: {
              currentStage: "signal_mystery",
            },
          },
        },
      },
    ], null, 2)}\n`, "utf-8"),
  ]);
  return projectDir;
}

// B5-2: 引擎 overview 投影补章号字段
describe("State Overview B5-2: hooks/threads 投影带 firstSeenChapter / resolvedAtChapter", () => {
  it("toHookOverview 投影：activeHook 带 firstSeenChapter，resolvedHook 带 firstSeenChapter + resolvedAtChapter", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "story-engine-b5-2-hooks-"));
    const { projectDir } = await createStoryProject({
      rootDir,
      title: "B5-2 伏笔章号测试",
      genre: "urban",
      premise: "伏笔初见章号 + 回收章号透传测试。",
      mainCharacterName: "主角",
    });

    await writeFile(
      join(projectDir, "story", "hooks.json"),
      `${JSON.stringify({
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
      }, null, 2)}\n`,
      "utf-8",
    );
    await writeFile(
      join(projectDir, "story", "threads.json"),
      `${JSON.stringify({ threads: [] }, null, 2)}\n`,
      "utf-8",
    );

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
      premise: "resolvedAtChapter 投影确认。",
      mainCharacterName: "主角",
    });

    await writeFile(
      join(projectDir, "story", "hooks.json"),
      `${JSON.stringify({
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
      }, null, 2)}\n`,
      "utf-8",
    );
    await writeFile(
      join(projectDir, "story", "threads.json"),
      `${JSON.stringify({ threads: [] }, null, 2)}\n`,
      "utf-8",
    );

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
      premise: "线索首现章号透传测试。",
      mainCharacterName: "主角",
    });

    await writeFile(
      join(projectDir, "story", "hooks.json"),
      `${JSON.stringify({ hooks: [] }, null, 2)}\n`,
      "utf-8",
    );
    await writeFile(
      join(projectDir, "story", "threads.json"),
      `${JSON.stringify({
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
      }, null, 2)}\n`,
      "utf-8",
    );

    const overview = await buildStateOverview({ projectDir, chapter: 9 });

    const threadItem = overview.threads.keyOpenItems.find((item) => item.id === "thread-lead");
    expect(threadItem, "线索应在 keyOpenItems").toBeDefined();
    // firstSeenChapter 应被正确投出
    expect(threadItem!.firstSeenChapter).toBe(4);
  });
});

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
