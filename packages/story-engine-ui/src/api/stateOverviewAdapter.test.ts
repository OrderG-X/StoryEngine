import { describe, expect, it } from "vitest";
import { countRealChapters, pickPreferredChapter, sidebarFromStateOverview, workspaceFromStateOverview } from "./stateOverviewAdapter.js";
import type { StateOverview } from "./types.js";
import type { ChapterNavItem } from "../types.js";

describe("countRealChapters（R2#4·章数不计占位「下一章」）", () => {
  const ch = (n: number, extra: Partial<ChapterNavItem> = {}): ChapterNavItem =>
    ({ id: `ch-${n}`, chapterNumber: n, title: `第${n}章`, status: "planned", ...extra });

  it("新书：当前第1章 + 占位下一章 → 只算 1 章（不计占位）", () => {
    expect(countRealChapters([ch(1), ch(2)], 1)).toBe(1);
  });

  it("ch1已入库、正写ch2、尾随ch3占位 → 算 2 章（修「2/3」）", () => {
    const chapters = [ch(1, { hasCommittedChapter: true }), ch(2, { hasDraftFile: true }), ch(3)];
    expect(countRealChapters(chapters, 2)).toBe(2);
  });

  it("有草稿/已入库的章一律计入，哪怕在当前章之后", () => {
    expect(countRealChapters([ch(1, { hasCommittedChapter: true }), ch(2, { hasDraftFile: true })], 1)).toBe(2);
  });
});

describe("pickPreferredChapter", () => {
  it("claims the tool's authoritative chapter over a stale store chapter (fix cross-chapter pollution)", () => {
    // 写第2章：UI 还停在第1章，但工具回了 chapter=2 → 必须认领 2，否则 autosave 把第2章写回 chapter-0001.md。
    expect(pickPreferredChapter(1, 2)).toBe(2);
  });

  it("keeps the store chapter when no tool chapter is given (read-only refresh must not eject the user)", () => {
    expect(pickPreferredChapter(3, undefined)).toBe(3);
  });

  it("ignores a degenerate tool chapter (0 / negative / non-int) and keeps the store chapter", () => {
    expect(pickPreferredChapter(2, 0)).toBe(2);
    expect(pickPreferredChapter(2, -1)).toBe(2);
    expect(pickPreferredChapter(2, 1.5)).toBe(2);
  });

  it("returns undefined when neither is usable (let overview derivation decide)", () => {
    expect(pickPreferredChapter(undefined, undefined)).toBeUndefined();
  });
});

describe("stateOverviewAdapter", () => {
  it("keeps rich foundation data visible in workspace panels", () => {
    const overview = createOverview();

    const workspace = workspaceFromStateOverview(overview);
    const sidebar = sidebarFromStateOverview(overview);

    expect(workspace.flowStatus).toBe("draft_ready");
    expect(workspace.characterMatrix?.characters[0]).toMatchObject({
      name: "苏晓薇",
      appearanceAnchors: ["皮肤白皙"],
      contradiction: "外表柔和但效率极高",
      currentLocation: "远山集团总部",
    });
    expect(workspace.location.locations?.[0]).toMatchObject({
      name: "远山集团总部",
      sensory: expect.arrayContaining(["视觉：玻璃幕墙反光"]),
      narrativeFunction: "权力压迫感场景",
      possibleConflicts: expect.arrayContaining(["身份核验"]),
    });
    expect(workspace.assets.items?.[0]).toMatchObject({
      name: "黑色双肩包",
      usageRules: ["只能装已登记资产"],
      lossRules: ["丢失会触发追踪风险"],
    });
    expect(sidebar.characters.join("\n")).toContain("苏晓薇");
    expect(sidebar.locations.join("\n")).toContain("远山集团总部：视觉：玻璃幕墙反光");
    expect(sidebar.assets.join("\n")).toContain("黑色双肩包");
  });

  it("多条文风规则各成独立 chip：proseStyle 用 `；` 分隔，内部 `、` 不被误切（修「新增写作规则塌进巨型 chip、面板看不见」）", () => {
    const overview: StateOverview = {
      ...createOverview(),
      writingRules: {
        available: true,
        narrativePerspective: "第三人称有限视角",
        proseStyle: [
          "沉浸",
          "感官描写：注重视觉、触觉、嗅觉等细节",
          "每章开头标注时间卡：日期+星期几+天气",
        ],
        genreRequirements: [],
        forbiddenContent: [],
        doNotDo: [],
        readerExperienceRules: [],
        antiAiPatterns: [],
      },
    };

    const sidebar = sidebarFromStateOverview(overview);
    const line = sidebar.writingRules.find((l) => l.startsWith("文风关键词："));
    expect(line).toBeDefined();
    // 镜像 WritingRulesCodexPanel.splitRuleList 的切分（按 `；;\n`），还原面板真实看到的 chip 列表。
    const chips = (line ?? "")
      .slice("文风关键词：".length)
      .split(/[；;\n]/u)
      .map((s) => s.trim())
      .filter(Boolean);
    expect(chips).toEqual([
      "沉浸",
      "感官描写：注重视觉、触觉、嗅觉等细节", // 规则内部的顿号原样保留，不被切碎
      "每章开头标注时间卡：日期+星期几+天气", // 新增规则成为独立可见 chip
    ]);
  });

  it("透传 extraFields 给角色矩阵/地点/资产面板数据（破例⑦展示落点）", () => {
    const base = createOverview();
    const cm = base.characterMatrix!;
    const ld = base.locationDetailSummary!;
    const as = base.assetSummary!;
    const overview: StateOverview = {
      ...base,
      characterMatrix: {
        ...cm,
        characters: (cm.characters ?? []).map((c, i) => (i === 0 ? { ...c, extraFields: { 外号: "阿薇" } } : c)),
      },
      locationDetailSummary: {
        ...ld,
        locations: (ld.locations ?? []).map((l, i) => (i === 0 ? { ...l, extraFields: { 气味: "玻璃与香水" } } : l)),
      },
      assetSummary: {
        ...as,
        assetItems: (as.assetItems ?? []).map((a, i) => (i === 0 ? { ...a, extraFields: { 来历: "前任所赠" } } : a)),
      },
    };
    const ws = workspaceFromStateOverview(overview);
    expect(ws.characterMatrix?.characters[0]?.extraFields).toEqual({ 外号: "阿薇" });
    expect(ws.location.locations?.[0]?.extraFields).toEqual({ 气味: "玻璃与香水" });
    expect(ws.assets.items?.[0]?.extraFields).toEqual({ 来历: "前任所赠" });
  });

  it("写作规则 customNotes 单独透出到 sidebar.writingRulesCustomNotes（破例⑧·不混进 writingRules 字符串数组）", () => {
    const base = createOverview();
    const wr = base.writingRules!;
    const overview: StateOverview = {
      ...base,
      writingRules: { ...wr, customNotes: "## 我的补充\n- 每章开头标时间卡" },
    };
    const sidebar = sidebarFromStateOverview(overview);
    expect(sidebar.writingRulesCustomNotes).toBe("## 我的补充\n- 每章开头标时间卡");
    // 不能混进 writingRules 字符串数组（否则污染面板 splitRuleList）
    expect(sidebar.writingRules.join("\n")).not.toContain("每章开头标时间卡");
  });

  it("没有加厚层时把引擎正典世界观暴露为 workspace.worldbuildingFallback", () => {
    const overview: StateOverview = {
      ...createOverview(),
      worldBible: {
        available: true,
        ruleCount: 1,
        factionCount: 0,
        systemCount: 0,
        keyRules: ["资源受集团控制"],
        keyFactions: [],
        socialOrder: ["集团层级森严"],
        fixedFacts: ["林远是千亿富豪"],
      },
    };
    const workspace = workspaceFromStateOverview(overview);
    expect(workspace.worldbuildingFallback).toBeTruthy();
    expect(workspace.worldbuildingFallback!.rules.map((r) => r.detail)).toContain("资源受集团控制");
    expect(workspace.worldbuildingFallback!.rules.some((r) => r.detail === "林远是千亿富豪")).toBe(true);
  });

  it("稀疏新书：资产/地点不灌「尚未配置」占位，统计与列表同源为空", () => {
    const overview: StateOverview = {
      ...createOverview(),
      storyStatus: { currentStage: "idle", currentObjective: undefined, currentLocation: undefined },
      world: { summary: "等待展开的故事世界", activeLocations: [], importantFacts: [], protectedSecrets: [] },
      assetSummary: {
        available: true,
        carriedAssets: [],
        ownedAssets: [],
        unavailableAssets: [],
        plotCriticalAssets: [],
        assetItems: [],
      },
      locationDetailSummary: undefined,
      locationBible: {
        available: true,
        locationCount: 0,
        activeLocationNames: [],
        riskCount: 0,
        resourceCount: 0,
        keyRisks: [],
        keyResources: [],
        keyNarrativeFunctions: [],
      },
    };
    const ws = workspaceFromStateOverview(overview);
    expect(ws.assets.carriedItems).toEqual([]);
    expect(ws.assets.availableAssets).toEqual([]);
    expect(ws.assets.unavailableAssets).toEqual([]);
    expect(ws.assets.properties).toEqual([]);
    expect(ws.assets.plotCriticalItems).toEqual([]);
    expect(ws.assets.carriedItems.every((x) => !x.includes("尚未配置"))).toBe(true);
    expect(ws.location.currentLocation ?? "").not.toMatch(/尚未配置/);
    expect(ws.location.risks ?? []).toEqual([]);
    expect(ws.location.resources ?? []).toEqual([]);
    expect(ws.location.floors ?? []).toEqual([]);
    expect(ws.location.rooms ?? []).toEqual([]);
  });

  it("写作规则 readerExperienceRules 标签为「读者体验规则」而非「描写重点」", () => {
    const overview: StateOverview = {
      ...createOverview(),
      writingRules: {
        available: true,
        narrativePerspective: "第三人称有限视角",
        proseStyle: ["沉浸"],
        genreRequirements: [],
        forbiddenContent: [],
        doNotDo: [],
        readerExperienceRules: ["落具体感官", "少总结腔"],
        antiAiPatterns: [],
      },
    };
    const sidebar = sidebarFromStateOverview(overview);
    expect(sidebar.writingRules.some((l) => l.startsWith("读者体验规则："))).toBe(true);
    expect(sidebar.writingRules.some((l) => l.startsWith("描写重点："))).toBe(false);
  });

  it("老书含系统元话术时 worldbuildingFallback 过滤掉该句", () => {
    const overview: StateOverview = {
      ...createOverview(),
      worldBible: {
        available: true,
        ruleCount: 1,
        factionCount: 0,
        systemCount: 0,
        keyRules: ["正式事实只能通过确认提交更新。"],
        keyFactions: [],
        socialOrder: [],
        fixedFacts: [],
      },
    };
    const ws = workspaceFromStateOverview(overview);
    expect(ws.worldbuildingFallback).toBeNull();
  });

  it("preferredCurrentChapter 优先于 overview 推导（修 applyOverviewToWorkspace 静默重置当前章）", () => {
    const overview = {
      ...createOverview(),
      project: { title: "测试书", genre: "都市", currentChapter: 1 },
    } satisfies StateOverview;
    // 不传 preferred：退化到 overview.project.currentChapter（旧行为）
    expect(workspaceFromStateOverview(overview).currentChapter.chapterNumber).toBe(1);
    // 传「用户当前停留章 5」：优先用之，不被引擎旧章号(1)覆盖 —— 这正是切第5章不被弹回第1章的修复
    expect(workspaceFromStateOverview(overview, 5).currentChapter.chapterNumber).toBe(5);
    // 非正整数 preferred 安全退化
    expect(workspaceFromStateOverview(overview, 0).currentChapter.chapterNumber).toBe(1);
  });

  it("treats draft-only chapter files as work drafts instead of committed chapters", () => {
    const overview = {
      ...createOverview(),
      project: { title: "测试书", genre: "都市", currentChapter: 2 },
      storyStatus: { currentStage: "draft_ready", currentObjective: "写第二章" },
      timeline: { recentEvents: [], earlierSummary: [], macroSummary: [] },
      uiChapterFiles: [
        { chapter: 1, hasDraftFile: true, hasCommittedChapter: false, draftTitle: "雨夜账册" },
      ],
    } satisfies StateOverview;

    const workspace = workspaceFromStateOverview(overview);
    const chapterOne = workspace.chapters.find((chapter) => chapter.chapterNumber === 1);

    expect(chapterOne).toMatchObject({
      status: "draft",
      hasDraftFile: true,
      hasCommittedChapter: false,
      title: "雨夜账册",
    });
  });

  it("keeps committed character state fields in sidebar detail JSON after overview refresh", () => {
    const overview = {
      ...createOverview(),
      characterMatrix: {
        available: false,
        characters: [],
        relationships: [],
        riskReminders: [],
      },
      characterDetails: [{
        id: "lin-xiao",
        name: "林晓",
        role: "配角",
        mood: "冷静",
        currentGoal: "保护主角",
        recentEvents: ["完成角色状态确认写入封测"],
      }],
    } satisfies StateOverview;

    const sidebar = sidebarFromStateOverview(overview);
    const detail = JSON.parse(sidebar.characters[0] ?? "{}") as {
      readonly mood?: string;
      readonly currentGoal?: string;
      readonly recentEvents?: readonly string[];
    };

    expect(detail).toMatchObject({
      mood: "冷静",
      currentGoal: "保护主角",
      recentEvents: ["完成角色状态确认写入封测"],
    });
  });

  it("keeps legacy emotion and goal as sidebar committed state fallbacks", () => {
    const overview = {
      ...createOverview(),
      characterMatrix: {
        available: false,
        characters: [],
        relationships: [],
        riskReminders: [],
      },
      characterDetails: [{
        id: "legacy-char",
        name: "旧字段角色",
        role: "配角",
        emotion: "警惕",
        goal: "确认主角是否可信",
      }],
    } satisfies StateOverview;

    const sidebar = sidebarFromStateOverview(overview);
    const detail = JSON.parse(sidebar.characters[0] ?? "{}") as {
      readonly mood?: string;
      readonly currentGoal?: string;
    };

    expect(detail).toMatchObject({
      mood: "警惕",
      currentGoal: "确认主角是否可信",
    });
  });

  it("marks chapters committed only when a committed chapter file exists", () => {
    const overview = {
      ...createOverview(),
      project: { title: "测试书", genre: "都市", currentChapter: 3 },
      timeline: { recentEvents: [], earlierSummary: [], macroSummary: [] },
      uiChapterFiles: [
        { chapter: 1, hasDraftFile: false, hasCommittedChapter: true, committedTitle: "正式一" },
        { chapter: 2, hasDraftFile: true, hasCommittedChapter: true, draftTitle: "工作稿二", committedTitle: "正式二" },
      ],
    } satisfies StateOverview;

    const workspace = workspaceFromStateOverview(overview);

    expect(workspace.chapters.find((chapter) => chapter.chapterNumber === 1)).toMatchObject({
      status: "committed",
      hasCommittedChapter: true,
      hasDraftFile: false,
    });
    expect(workspace.chapters.find((chapter) => chapter.chapterNumber === 2)).toMatchObject({
      status: "committed",
      hasCommittedChapter: true,
      hasDraftFile: true,
      title: "正式二",
    });
  });

  it("marks draft-only chapters as an uncommitted working draft chain", () => {
    const overview = {
      ...createOverview(),
      project: { title: "测试书", genre: "都市", currentChapter: 10 },
      timeline: { recentEvents: [], earlierSummary: [], macroSummary: [] },
      uiChapterFiles: Array.from({ length: 10 }, (_, index) => ({
        chapter: index + 1,
        hasDraftFile: true,
        hasCommittedChapter: false,
        draftTitle: `工作稿${index + 1}`,
      })),
    } satisfies StateOverview;

    const workspace = workspaceFromStateOverview(overview);

    expect(workspace.hasUncommittedDrafts).toBe(true);
    expect(workspace.workingDraftChain).toBe(true);
    expect(workspace.previousUncommittedDraftContext).toBe(true);
    expect(workspace.latestUncommittedDraftChapter).toBe(10);
  });

  it("does not show an uncommitted working chain when all drafts are committed", () => {
    const overview = {
      ...createOverview(),
      project: { title: "测试书", genre: "都市", currentChapter: 2 },
      timeline: { recentEvents: [], earlierSummary: [], macroSummary: [] },
      uiChapterFiles: [
        { chapter: 1, hasDraftFile: true, hasCommittedChapter: true, draftTitle: "工作稿一", committedTitle: "正式一" },
        { chapter: 2, hasDraftFile: false, hasCommittedChapter: true, committedTitle: "正式二" },
      ],
    } satisfies StateOverview;

    const workspace = workspaceFromStateOverview(overview);

    expect(workspace.hasUncommittedDrafts).toBe(false);
    expect(workspace.workingDraftChain).toBe(false);
    expect(workspace.previousUncommittedDraftContext).toBe(false);
    expect(workspace.latestUncommittedDraftChapter).toBeUndefined();
  });
});

function createOverview(): StateOverview {
  return {
    project: { title: "测试书", genre: "都市", currentChapter: 1 },
    storyStatus: {
      currentStage: "draft_ready",
      currentLocation: "远山集团总部",
      currentObjective: "进入总部",
    },
    hooks: { activeCount: 0, touchedCount: 0, resolvedCount: 0, activeItems: [] },
    threads: { total: 0, open: 0, touched: 0, done: 0, openIntents: 0, cleanupVisibleCount: 0, cleanupVisibleUnresolvedCount: 0, keyOpenItems: [] },
    arcGoals: { activeCount: 0, touchedCount: 0, completedCount: 0, activeItems: [] },
    timeline: { recentEvents: [], earlierSummary: [], macroSummary: [] },
    characters: { protagonist: "林远", knownCharacters: [{ id: "char-guo-xu", name: "林远", role: "主角" }] },
    world: {
      summary: "现实都市表层下存在隐秘资源秩序。",
      activeLocations: ["远山集团总部"],
      importantFacts: ["远山集团控制关键资源"],
      protectedSecrets: [],
    },
    storyBible: {
      available: true,
      projectLogline: "林远进入远山集团。",
      genre: "都市",
      readerPromise: "主角掌控剧情推进。",
      longFormGoals: ["查明集团秘密"],
      centralConflicts: [],
      coreMysteries: [],
      forbiddenChanges: [],
      canonFacts: [],
      openQuestions: [],
    },
    writingRules: {
      available: true,
      narrativePerspective: "第三人称有限视角",
      proseStyle: ["克制"],
      genreRequirements: [],
      forbiddenContent: [],
      doNotDo: [],
      readerExperienceRules: [],
      antiAiPatterns: ["避免总结腔"],
    },
    characterBible: {
      available: true,
      characterCount: 1,
      keyCharacters: [],
    },
    characterMatrix: {
      available: true,
      characters: [{
        id: "char-lin-xiaowei",
        name: "苏晓薇",
        role: "重要角色",
        age: "28岁",
        identity: "远山集团生活秘书",
        appearanceAnchors: ["皮肤白皙"],
        desire: "照顾主角",
        fear: "越界",
        weakness: "过度负责",
        contradiction: "外表柔和但效率极高",
        moralBoundary: "不诱导违法",
        privateMotive: "观察主角",
        relationshipDynamics: ["亲近但有边界"],
        trustLevel: "medium",
        hiddenStance: "替集团观察",
        behaviorBoundaries: ["不能替主角决策"],
        cannotDo: ["不能越权"],
        cannotReveal: ["集团高层秘密"],
        speechStyle: "温和短句",
        speechSamples: ["您先坐。"],
        knownFacts: ["集团日常流程"],
        unknownTruths: ["魂钢来源"],
        protectedSecrets: [],
        forbiddenReveals: [],
        currentLocation: "远山集团总部",
        currentGoal: "完成接待",
        carriedAssets: [],
        ownedAssets: [],
        plotCriticalAssets: [],
        relationshipToProtagonist: "看主角像弟弟",
        relationships: [],
        riskReminders: [],
      }],
      relationships: [],
      riskReminders: [],
    },
    worldBible: {
      available: true,
      ruleCount: 1,
      factionCount: 0,
      systemCount: 0,
      keyRules: ["资源受集团控制"],
      keyFactions: [],
      resourceRules: ["资源准入受限"],
      socialOrder: ["集团层级森严"],
    },
    locationBible: {
      available: true,
      locationCount: 1,
      activeLocationNames: ["远山集团总部"],
      riskCount: 1,
      resourceCount: 1,
      keyRisks: ["远山集团总部：身份核验"],
      keyResources: ["远山集团总部：档案室"],
      keyNarrativeFunctions: ["远山集团总部：权力压迫感场景"],
    },
    assetSummary: {
      available: true,
      carriedAssets: ["黑色双肩包"],
      ownedAssets: ["黑色双肩包"],
      unavailableAssets: [],
      plotCriticalAssets: ["黑色双肩包"],
      assetItems: [{
        id: "asset-backpack",
        name: "黑色双肩包",
        type: "container",
        owner: "林远",
        currentLocation: "随身",
        carriedBy: "林远",
        status: "available",
        isPlotCritical: true,
        rules: ["不能凭空出现新物品"],
        usageRules: ["只能装已登记资产"],
        lossRules: ["丢失会触发追踪风险"],
        notes: [],
      }],
    },
    locationDetailSummary: {
      locations: [{
        id: "loc-zs-hq",
        name: "远山集团总部",
        type: "building",
        parentLocation: "海天市",
        currentKnownPosition: "前台大厅",
        sensory: ["视觉：玻璃幕墙反光", "声音：电梯低鸣"],
        narrativeFunction: "权力压迫感场景",
        possibleConflicts: ["身份核验"],
        currentStatus: "正常开放",
        floors: ["1楼大厅"],
        rooms: ["前台大厅"],
        entrances: ["正门"],
        exits: ["侧门"],
        travelRules: ["远山集团总部 -> 公交站 · 步行 · 6分钟"],
        risks: ["身份核验"],
        resources: ["档案室"],
        fixedFacts: ["前台在1楼"],
        hiddenFacts: ["地下室入口隐藏"],
      }],
      floors: ["1楼大厅"],
      rooms: ["前台大厅"],
      entrances: ["正门"],
      exits: ["侧门"],
      travelRules: ["远山集团总部 -> 公交站 · 步行 · 6分钟"],
      risks: ["远山集团总部：身份核验"],
      resources: ["远山集团总部：档案室"],
      fixedFacts: ["远山集团总部：前台在1楼"],
    },
    foundationCompleteness: {
      passed: true,
      readinessLevel: "ready",
      missingItems: [],
      suggestions: [],
    },
    maintenance: {
      diagnosticsAvailable: true,
      cleanupVisibleCount: 0,
      markDoneCandidateCount: 0,
      mergeDisabled: true,
      dropDisabled: true,
      confirmPolicy: { markDone: "manual_only", merge: "disabled", drop: "disabled" },
    },
    uiHints: { recommendedNextPanels: [], warnings: [], disabledActions: [] },
  };
}
