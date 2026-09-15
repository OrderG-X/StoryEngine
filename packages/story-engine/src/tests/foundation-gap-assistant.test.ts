import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyFoundationGapDecisions,
  buildFoundationGapApplyPlan,
  buildFoundationGapReport,
  buildFoundationGapSuggestions,
} from "../foundation-gap-assistant.js";
import { createStoryProject, toSafeCharacterId } from "../project-store.js";
import { buildStateOverview } from "../state-overview.js";

/**
 * 原子写回归需要「rename 抛错」这种 chmod 注入不出来的故障（同目录下 tmp 写入和 rename
 * 要的都是目录写权限，chmod 无法只拦后者）。只换 rename 一个符号，其余 fs/promises
 * 全部透传真实实现；默认行为 = 真实 rename，仅个别用例 mockRejectedValueOnce 注入单次失败。
 */
const { renameMock } = vi.hoisted(() => ({ renameMock: vi.fn() }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: (oldPath: unknown, newPath: unknown) => renameMock(oldPath, newPath),
  };
});
const realRename = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).rename;

beforeEach(() => {
  renameMock.mockImplementation(realRename);
});
afterEach(() => {
  renameMock.mockReset();
});

describe("Foundation Gap Assistant V0", () => {
  it("finds book-wide continuity gaps without writing files", async () => {
    const projectDir = await createSparseProject();
    const before = await readProjectStoryBible(projectDir);

    const report = await buildFoundationGapReport(projectDir);

    expect(report.passed).toBe(false);
    expect(report.readinessLevel).toBe("high_risk");
    expect(report.byCategory.characters.map((item) => item.title)).toEqual(expect.arrayContaining([
      "角色「林序」缺少年龄",
      "角色「林序」缺少说话风格",
      "角色「林序」缺少知识边界",
    ]));
    expect(report.byCategory.locations.some((item) => item.title.includes("缺少地点"))).toBe(true);
    expect(report.byCategory.assets.some((item) => item.title === "缺少资产账本")).toBe(true);
    expect(report.byCategory.world.some((item) => item.title === "缺少冲突来源")).toBe(true);
    expect(report.byCategory.writingRules.some((item) => item.title === "缺少文风")).toBe(true);
    expect(await readProjectStoryBible(projectDir)).toBe(before);
  });

  it("generates create suggestions but does not apply them automatically", async () => {
    const projectDir = await createSparseProject();
    const suggestions = await buildFoundationGapSuggestions(projectDir);

    expect(suggestions.some((item) => item.actionType === "create_location")).toBe(true);
    expect(suggestions.some((item) => item.actionType === "create_asset")).toBe(true);
    expect(suggestions.every((item) => item.requiresUserConfirm)).toBe(true);

    const assets = await readJson(projectDir, "story/assets.json");
    const locations = await readJson(projectDir, "story/location-bible.json");
    expect(assets.assets).toEqual([]);
    expect(locations.locations).toEqual([]);
  });

  it("writes accepted suggestions and keeps rejected or deferred suggestions out of formal files", async () => {
    const projectDir = await createSparseProject();
    const suggestions = await buildFoundationGapSuggestions(projectDir);
    const age = suggestions.find((item) => item.targetPath.endsWith(".age"));
    const location = suggestions.find((item) => item.actionType === "create_location");
    const asset = suggestions.find((item) => item.actionType === "create_asset");
    expect(age).toBeDefined();
    expect(location).toBeDefined();
    expect(asset).toBeDefined();

    await applyFoundationGapDecisions(projectDir, [
      { suggestionId: age?.id ?? "", decision: "edit", editedAfter: "22岁" },
      { suggestionId: location?.id ?? "", decision: "reject" },
      { suggestionId: asset?.id ?? "", decision: "defer" },
    ]);

    const characterBible = await readJson(projectDir, "story/character-bible.json");
    const locations = await readJson(projectDir, "story/location-bible.json");
    const assets = await readJson(projectDir, "story/assets.json");
    expect(characterBible.characters[0].age).toBe("22岁");
    expect(locations.locations).toEqual([]);
    expect(assets.assets).toEqual([]);
  });

  it("accepts create_location and create_asset decisions after preview planning", async () => {
    const projectDir = await createSparseProject();
    const suggestions = await buildFoundationGapSuggestions(projectDir);
    const location = suggestions.find((item) => item.actionType === "create_location");
    const asset = suggestions.find((item) => item.actionType === "create_asset");
    const decisions = [
      { suggestionId: location?.id ?? "", decision: "accept" as const },
      { suggestionId: asset?.id ?? "", decision: "edit" as const, editedAfter: {
        id: "asset-bus-card",
        name: "公交卡",
        type: "keyItem",
        ownerName: "林序",
        carriedByCharacterId: toSafeCharacterId("林序"),
        status: "available",
        isPlotCritical: true,
        canAiModify: false,
        rules: ["不能凭空充值。"],
      } },
    ];

    const plan = await buildFoundationGapApplyPlan(projectDir, decisions);
    expect(plan.fileChanges.map((item) => item.targetFile)).toEqual(expect.arrayContaining([
      "story/location-bible.json",
      "story/assets.json",
    ]));

    await applyFoundationGapDecisions(projectDir, decisions);

    const locations = await readJson(projectDir, "story/location-bible.json");
    const assets = await readJson(projectDir, "story/assets.json");
    expect(locations.locations[0].name).toBe("新地点");
    expect(assets.assets[0].name).toBe("公交卡");
  });

  it("can apply an AI-generated suggestion that is not part of the scan report", async () => {
    const projectDir = await createSparseProject();
    const aiSuggestion = {
      id: "ai-world-realistic-city",
      gapId: "ai-gap-world",
      category: "world" as const,
      actionType: "update_world_rule" as const,
      targetFile: "story/world-bible.json",
      targetPath: "socialOrder",
      targetId: "socialOrder",
      before: undefined,
      after: ["现实都市阶层由家庭资源、职业准入、资本和地方关系共同决定。"],
      rationale: "用户确认用现实都市规则补全世界观。",
      risk: "warning" as const,
      requiresUserConfirm: true as const,
    };

    await applyFoundationGapDecisions(
      projectDir,
      [{ suggestionId: aiSuggestion.id, decision: "edit", editedAfter: aiSuggestion.after }],
      [aiSuggestion],
    );

    const worldBible = await readJson(projectDir, "story/world-bible.json");
    expect(worldBible.socialOrder).toEqual(["现实都市阶层由家庭资源、职业准入、资本和地方关系共同决定。"]);
  });

  it("merges structured world and writing-rule suggestions from foundation agent output", async () => {
    const projectDir = await createSparseProject();
    const worldSuggestion = {
      id: "ai-world-structured",
      gapId: "ai-gap-world",
      category: "world" as const,
      actionType: "update_world_rule" as const,
      targetFile: "story/world-bible.json",
      targetPath: "$",
      before: undefined,
      after: {
        worldPremise: "现实都市表层下存在魂钢资源秩序。",
        coreRules: ["魂钢资源不能凭空出现。"],
        resourceRules: ["远山集团控制核心资源准入。"],
        authorityRules: ["集团权限高于普通机构。"],
        socialOrder: ["财富和资源准入共同决定阶层。"],
        conflictSources: ["主角缺乏正式准入资格。"],
        fixedFacts: ["魂钢交易必须留下痕迹。"],
        protectedSecrets: ["魂钢来源暂不揭开。"],
        publicFacts: ["远山集团是合法企业。"],
        hiddenFacts: ["集团内部另有筛选机制。"],
      },
      rationale: "用户补充世界观底层规则。",
      risk: "warning" as const,
      requiresUserConfirm: true as const,
    };
    const writingSuggestion = {
      id: "ai-writing-structured",
      gapId: "ai-gap-writing",
      category: "writingRules" as const,
      actionType: "update_writing_rule" as const,
      targetFile: "story/writing-rules.json",
      targetPath: "$",
      before: undefined,
      after: {
        narrativePerspective: "第三人称有限视角",
        proseStyle: ["克制", "生活流压迫感"],
        pacing: "中速推进",
        targetChapterWords: 2200,
        revealPolicy: "只展示主角能观察到的信息。",
        forbiddenContent: ["不要提前解释魂钢来源。"],
        readerExperienceRules: ["保持读者对下一步选择的期待。"],
        doNotDo: ["不要总结式旁白替代场景。"],
        antiAiPatterns: ["避免清单式段落。"],
      },
      rationale: "用户补充写作规则。",
      risk: "warning" as const,
      requiresUserConfirm: true as const,
    };

    await applyFoundationGapDecisions(
      projectDir,
      [
        { suggestionId: worldSuggestion.id, decision: "accept" },
        { suggestionId: writingSuggestion.id, decision: "accept" },
      ],
      [worldSuggestion, writingSuggestion],
    );

    const worldBible = await readJson(projectDir, "story/world-bible.json");
    const writingRules = await readJson(projectDir, "story/writing-rules.json");
    expect(worldBible).toMatchObject({
      worldPremise: "现实都市表层下存在魂钢资源秩序。",
      rules: expect.arrayContaining(["魂钢资源不能凭空出现。"]),
      resourceRules: expect.arrayContaining(["远山集团控制核心资源准入。"]),
      authorityRules: expect.arrayContaining(["集团权限高于普通机构。"]),
      socialOrder: expect.arrayContaining(["财富和资源准入共同决定阶层。"]),
      hiddenFacts: expect.arrayContaining(["集团内部另有筛选机制。"]),
    });
    expect(writingRules).toMatchObject({
      narrativePerspective: "第三人称有限视角",
      proseStyle: expect.arrayContaining(["克制", "生活流压迫感"]),
      pacing: "中速推进",
      revealPolicy: "只展示主角能观察到的信息。",
      antiAiPatterns: expect.arrayContaining(["避免清单式段落。"]),
      chapterLength: expect.objectContaining({ targetWords: 2200 }),
    });
  });

  it("blocks direct accept when an AI asset suggestion does not preserve the user-provided entity", async () => {
    const projectDir = await createSparseProject();
    const mismatchedSuggestion = {
      id: "ai-asset-backpack-as-phone",
      gapId: "ai-gap-create-asset",
      category: "assets" as const,
      actionType: "create_asset" as const,
      targetFile: "story/assets.json",
      targetPath: "assets",
      targetId: "asset-phone",
      before: undefined,
      after: {
        id: "asset-phone",
        name: "手机",
        type: "phone",
        ownerName: "林序",
        status: "unknown",
      },
      rationale: "模型错误整理的资产草案。",
      risk: "high" as const,
      requiresUserConfirm: true as const,
      sourceUserMessage: "我想给主角补一个黑色双肩包，随身带着。",
      extractedEntityName: "黑色双肩包",
      extractedEntityType: "container",
      sourceEvidence: "黑色双肩包",
      preservationWarnings: ["你刚才说的是：黑色双肩包；AI 整理成了：手机。"],
    };

    const blockedPlan = await buildFoundationGapApplyPlan(
      projectDir,
      [{ suggestionId: mismatchedSuggestion.id, decision: "accept" }],
      [mismatchedSuggestion],
    );
    expect(blockedPlan.acceptedSuggestions).toEqual([]);
    expect(blockedPlan.skippedConflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "资料草案与用户原话不一致" }),
    ]));

    await applyFoundationGapDecisions(
      projectDir,
      [{ suggestionId: mismatchedSuggestion.id, decision: "accept" }],
      [mismatchedSuggestion],
    );
    const assetsAfterBlockedAccept = await readJson(projectDir, "story/assets.json");
    expect(assetsAfterBlockedAccept.assets).toEqual([]);

    await applyFoundationGapDecisions(
      projectDir,
      [{
        suggestionId: mismatchedSuggestion.id,
        decision: "edit",
        editedAfter: {
          id: "asset-black-backpack",
          name: "黑色双肩包",
          type: "container",
          ownerName: "林序",
          currentLocationName: "随身",
          carriedByCharacterId: toSafeCharacterId("林序"),
          status: "available",
          isPlotCritical: false,
          canAiModify: false,
          rules: ["只能存放用户确认过的物品，不能凭空装出新资产。"],
        },
      }],
      [mismatchedSuggestion],
    );
    const assetsAfterEdit = await readJson(projectDir, "story/assets.json");
    expect(assetsAfterEdit.assets[0]).toMatchObject({
      name: "黑色双肩包",
      type: "container",
    });
  });

  it("preserves explicit gun and cash asset entities after user confirmation", async () => {
    const projectDir = await createSparseProject();
    const gunSuggestion = {
      id: "ai-asset-stolen-gun",
      gapId: "ai-gap-create-asset",
      category: "assets" as const,
      actionType: "create_asset" as const,
      targetFile: "story/assets.json",
      targetPath: "assets",
      targetId: "asset-stolen-gun",
      before: undefined,
      after: {
        id: "asset-stolen-gun",
        name: "抢来的枪",
        type: "keyItem",
        ownerName: "林序",
        status: "available",
        isPlotCritical: true,
        canAiModify: false,
        rules: ["来源是抢来的，不能改成合法购买。"],
      },
      rationale: "用户明确补充枪的来源。",
      risk: "warning" as const,
      requiresUserConfirm: true as const,
      sourceUserMessage: "那把枪其实是抢来的。",
      extractedEntityName: "枪",
      extractedEntityType: "keyItem",
      sourceEvidence: "枪",
      preservationWarnings: [],
    };
    const cashSuggestion = {
      id: "ai-asset-cash-43-5",
      gapId: "ai-gap-create-asset",
      category: "assets" as const,
      actionType: "create_asset" as const,
      targetFile: "story/assets.json",
      targetPath: "assets",
      targetId: "asset-cash-43-5",
      before: undefined,
      after: {
        id: "asset-cash-43-5",
        name: "43.5 元现金",
        type: "money",
        ownerName: "林序",
        quantity: 43.5,
        status: "available",
        isPlotCritical: false,
        canAiModify: false,
        rules: ["只能用于小额消费，不能凭空增加。"],
      },
      rationale: "用户明确补充随身现金金额。",
      risk: "info" as const,
      requiresUserConfirm: true as const,
      sourceUserMessage: "他身上还有 43.5 元现金。",
      extractedEntityName: "43.5 元现金",
      extractedEntityType: "money",
      sourceEvidence: "43.5 元现金",
      preservationWarnings: [],
    };

    await applyFoundationGapDecisions(
      projectDir,
      [
        { suggestionId: gunSuggestion.id, decision: "accept" },
        { suggestionId: cashSuggestion.id, decision: "accept" },
      ],
      [gunSuggestion, cashSuggestion],
    );

    const assets = await readJson(projectDir, "story/assets.json");
    expect(assets.assets.map((asset: { name: string }) => asset.name)).toEqual(expect.arrayContaining([
      "枪",
      "43.5 元现金",
    ]));
  });

  it("writes accepted location detail suggestions into structured floors rooms and travel rules", async () => {
    const projectDir = await createSparseProject();
    const locationSuggestion = {
      id: "ai-location-incubator-structure",
      gapId: "ai-gap-location-detail",
      category: "locations" as const,
      actionType: "update_location_detail" as const,
      targetFile: "story/location-bible.json",
      targetPath: "locations",
      targetId: "loc-incubator",
      before: undefined,
      after: {
        id: "loc-incubator",
        name: "海天市旧城区创业孵化楼",
        type: "building",
        parentLocation: "海天市旧城区",
        locationType: "building",
        spatialStructure: {
          floors: ["1楼大厅", "2楼申请窗口", "3楼办公区"],
          rooms: ["毕业申请窗口", "公共查询终端区", "楼梯间"],
          entrances: ["一楼大厅正门"],
          exits: ["正门", "楼梯间"],
        },
        connectedLocations: ["旧城区公交站", "市中心"],
        travelRules: [
          { from: "2楼申请窗口", targetLocation: "1楼大厅", method: "stairs", durationMinutes: 1, constraint: "走楼梯" },
          { from: "创业孵化楼", targetLocation: "旧城区公交站", method: "walk", durationMinutes: 6 },
          { from: "创业孵化楼", targetLocation: "市中心", method: "taxi", durationMinutes: 25 },
        ],
        risks: ["检测系统可能记录异常反应"],
        resources: ["公共查询终端"],
        fixedFacts: ["申请窗口位于2楼，不能随意改到其他楼层"],
      },
      rationale: "补足地点空间结构和移动规则，减少长篇地点漂移。",
      risk: "warning" as const,
      requiresUserConfirm: true as const,
    };

    await applyFoundationGapDecisions(projectDir, [
      { suggestionId: locationSuggestion.id, decision: "accept" },
    ], [locationSuggestion]);

    const locations = await readJson(projectDir, "story/location-bible.json");
    expect(locations.locations[0].spatialStructure.floors).toEqual(expect.arrayContaining(["1楼大厅", "2楼申请窗口", "3楼办公区"]));
    expect(locations.locations[0].spatialStructure.rooms).toEqual(expect.arrayContaining(["毕业申请窗口", "公共查询终端区", "楼梯间"]));
    expect(locations.locations[0].travelRules).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: "2楼申请窗口", targetLocation: "1楼大厅", method: "stairs", durationMinutes: 1 }),
      expect.objectContaining({ from: "创业孵化楼", targetLocation: "旧城区公交站", method: "walk", durationMinutes: 6 }),
      expect.objectContaining({ from: "创业孵化楼", targetLocation: "市中心", method: "taxi", durationMinutes: 25 }),
    ]));

    const overview = await buildStateOverview({ projectDir });
    expect(overview.locationDetailSummary.floors).toEqual(expect.arrayContaining(["1楼大厅", "2楼申请窗口", "3楼办公区"]));
    expect(overview.locationDetailSummary.rooms).toEqual(expect.arrayContaining(["毕业申请窗口", "公共查询终端区", "楼梯间"]));
    expect(overview.locationDetailSummary.travelRules).toEqual(expect.arrayContaining([
      expect.stringContaining("2楼申请窗口 -> 1楼大厅"),
      expect.stringContaining("创业孵化楼 -> 旧城区公交站"),
      expect.stringContaining("创业孵化楼 -> 市中心"),
    ]));
    expect(overview.locationDetailSummary.fixedFacts).toEqual(expect.arrayContaining([
      expect.stringContaining("申请窗口位于2楼"),
    ]));
  });

  it("keeps rejected or deferred location detail suggestions out of location bible", async () => {
    const projectDir = await createSparseProject();
    const locationSuggestion = {
      id: "ai-location-deferred",
      gapId: "ai-gap-location-detail",
      category: "locations" as const,
      actionType: "update_location_detail" as const,
      targetFile: "story/location-bible.json",
      targetPath: "locations",
      targetId: "loc-incubator",
      before: undefined,
      after: {
        id: "loc-incubator",
        name: "海天市旧城区创业孵化楼",
        spatialStructure: { floors: ["1楼大厅"], rooms: ["公共查询终端区"], entrances: [], exits: [] },
        travelRules: [{ from: "创业孵化楼", targetLocation: "旧城区公交站", method: "walk", durationMinutes: 6 }],
        risks: [],
        resources: [],
        fixedFacts: [],
      },
      rationale: "补地点结构。",
      risk: "warning" as const,
      requiresUserConfirm: true as const,
    };

    await applyFoundationGapDecisions(projectDir, [
      { suggestionId: locationSuggestion.id, decision: "defer" },
    ], [locationSuggestion]);

    const locations = await readJson(projectDir, "story/location-bible.json");
    expect(locations.locations).toEqual([]);
  });

  it("does not overwrite conflicting travel rules", async () => {
    const projectDir = await createSparseProject();
    await writeJson(projectDir, "story/location-bible.json", {
      version: "v0",
      locations: [{
        id: "loc-incubator",
        name: "海天市旧城区创业孵化楼",
        type: "building",
        spatialStructure: { floors: ["1楼大厅"], rooms: [], entrances: [], exits: [] },
        knownFeatures: [],
        risks: [],
        resources: [],
        travelRules: [{ from: "创业孵化楼", targetLocation: "旧城区公交站", method: "walk", durationMinutes: 6 }],
      }],
    });
    const conflictingSuggestion = {
      id: "ai-location-conflict",
      gapId: "ai-gap-location-detail",
      category: "locations" as const,
      actionType: "update_location_detail" as const,
      targetFile: "story/location-bible.json",
      targetPath: "locations",
      targetId: "loc-incubator",
      before: undefined,
      after: {
        id: "loc-incubator",
        name: "海天市旧城区创业孵化楼",
        spatialStructure: { floors: [], rooms: [], entrances: [], exits: [] },
        travelRules: [{ from: "创业孵化楼", targetLocation: "旧城区公交站", method: "taxi", durationMinutes: 20 }],
      },
      rationale: "冲突移动规则。",
      risk: "warning" as const,
      requiresUserConfirm: true as const,
    };

    const plan = await buildFoundationGapApplyPlan(projectDir, [
      { suggestionId: conflictingSuggestion.id, decision: "accept" },
    ], [conflictingSuggestion]);
    expect(plan.acceptedSuggestions).toEqual([]);
    expect(plan.skippedConflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "地点移动规则冲突" }),
    ]));

    await applyFoundationGapDecisions(projectDir, [
      { suggestionId: conflictingSuggestion.id, decision: "accept" },
    ], [conflictingSuggestion]);
    const locations = await readJson(projectDir, "story/location-bible.json");
    expect(locations.locations[0].travelRules).toEqual([
      expect.objectContaining({ method: "walk", durationMinutes: 6 }),
    ]);
  });

  it("keeps travel sentences out of floors rooms and fixed facts while preserving travel rules", async () => {
    const projectDir = await createSparseProject();
    const locationSuggestion = {
      id: "ai-location-clean-travel-sentences",
      gapId: "ai-gap-location-detail",
      category: "locations" as const,
      actionType: "update_location_detail" as const,
      targetFile: "story/location-bible.json",
      targetPath: "locations",
      targetId: "loc-incubator",
      before: undefined,
      after: {
        id: "loc-incubator",
        name: "海天市旧城区创业孵化楼",
        spatialStructure: {
          floors: ["一楼大厅", "二楼申请窗口", "三楼办公区", "二楼到一楼走楼梯一分钟"],
          rooms: ["一楼大厅", "二楼申请窗口", "三楼办公区", "二楼到一楼走楼梯一分钟", "到公交站步行六分钟"],
          entrances: ["一楼大厅正门"],
          exits: ["正门", "楼梯间"],
        },
        travelRules: [
          { from: "2楼申请窗口", targetLocation: "1楼大厅", method: "stairs", durationMinutes: 1, constraint: "走楼梯" },
          { from: "创业孵化楼", targetLocation: "旧城区公交站", method: "walk", durationMinutes: 6 },
          { from: "创业孵化楼", targetLocation: "市中心", method: "taxi", durationMinutes: 25 },
        ],
        fixedFacts: ["申请窗口位于2楼，不能随意改到其他楼层", "二楼到一楼走楼梯一分钟"],
      },
      rationale: "补地点结构。",
      risk: "warning" as const,
      requiresUserConfirm: true as const,
    };

    await applyFoundationGapDecisions(projectDir, [
      { suggestionId: locationSuggestion.id, decision: "accept" },
    ], [locationSuggestion]);

    const locations = await readJson(projectDir, "story/location-bible.json");
    const location = locations.locations[0];
    expect(location.spatialStructure.floors).toEqual(expect.arrayContaining(["一楼大厅", "二楼申请窗口", "三楼办公区"]));
    expect(location.spatialStructure.floors.join("\n")).not.toMatch(/二楼到一楼走楼梯一分钟|到公交站步行六分钟/u);
    expect(location.spatialStructure.rooms.join("\n")).not.toMatch(/二楼到一楼走楼梯一分钟|到公交站步行六分钟/u);
    expect(location.fixedFacts.join("\n")).not.toMatch(/二楼到一楼走楼梯一分钟/u);
    expect(location.travelRules).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: "2楼申请窗口", targetLocation: "1楼大厅", method: "stairs", durationMinutes: 1 }),
      expect.objectContaining({ targetLocation: "旧城区公交站", method: "walk", durationMinutes: 6 }),
      expect.objectContaining({ targetLocation: "市中心", method: "taxi", durationMinutes: 25 }),
    ]));
  });

  // R5b block 1: the travel-sentence filter must be genre-neutral. It filters
  // generic travel prose (movement verb + time/distance, or N楼到M楼 spatial step)
  // out of floors/rooms/fixedFacts using only generic signals — with NO hardcoded
  // place names. Here every place name (星辉港/码头) is genre-fictional and would
  // never appear in a hardcoded table, yet the prose is still filtered.
  it("filters generic travel prose with arbitrary place names and no hardcoded place table", async () => {
    const projectDir = await createSparseProject();
    const locationSuggestion = {
      id: "ai-location-genre-neutral-travel",
      gapId: "ai-gap-location-detail",
      category: "locations" as const,
      actionType: "update_location_detail" as const,
      targetFile: "story/location-bible.json",
      targetPath: "locations",
      targetId: "loc-incubator",
      before: undefined,
      after: {
        id: "loc-incubator",
        name: "海天市旧城区创业孵化楼",
        spatialStructure: {
          floors: ["一楼大厅", "二楼办公区", "三楼到一楼走楼梯一分钟"],
          rooms: ["一楼大厅", "二楼办公区", "到星辉港步行六分钟", "开车去码头二十分钟"],
          entrances: ["一楼大厅正门"],
          exits: ["正门"],
        },
        fixedFacts: ["办公区位于二楼，不能随意改到其他楼层", "二楼到一楼走楼梯一分钟"],
      },
      rationale: "补地点结构。",
      risk: "warning" as const,
      requiresUserConfirm: true as const,
    };

    await applyFoundationGapDecisions(projectDir, [
      { suggestionId: locationSuggestion.id, decision: "accept" },
    ], [locationSuggestion]);

    const locations = await readJson(projectDir, "story/location-bible.json");
    const location = locations.locations[0];
    // Registered structural rows survive.
    expect(location.spatialStructure.floors).toEqual(expect.arrayContaining(["一楼大厅", "二楼办公区"]));
    expect(location.spatialStructure.rooms).toEqual(expect.arrayContaining(["一楼大厅", "二楼办公区"]));
    expect(location.fixedFacts).toEqual(expect.arrayContaining(["办公区位于二楼，不能随意改到其他楼层"]));
    // Generic travel prose filtered regardless of (fictional) place names.
    expect(location.spatialStructure.floors.join("\n")).not.toMatch(/三楼到一楼走楼梯一分钟/u);
    expect(location.spatialStructure.rooms.join("\n")).not.toMatch(/星辉港步行六分钟|开车去码头二十分钟/u);
    expect(location.fixedFacts.join("\n")).not.toMatch(/二楼到一楼走楼梯一分钟/u);
  });

  it("does not hardcode genre-specific place names in the travel-sentence filter", async () => {
    const source = await readFile(join(import.meta.dirname, "..", "foundation-gap-assistant.ts"), "utf-8");
    const travelFn = source.slice(source.indexOf("function isTravelSentence"));
    const body = travelFn.slice(0, travelFn.indexOf("\n}"));
    expect(body).not.toMatch(/公交站|市中心/u);
  });

  it("cleans asset names while keeping source evidence", async () => {
    const projectDir = await createSparseProject();
    const backpackSuggestion = {
      id: "ai-asset-command-like-name",
      gapId: "ai-gap-create-asset",
      category: "assets" as const,
      actionType: "create_asset" as const,
      targetFile: "story/assets.json",
      targetPath: "assets",
      targetId: "asset-backpack",
      before: undefined,
      after: {
        id: "asset-backpack",
        name: "给主角补一个黑色双肩包",
        type: "container",
        ownerName: "林序",
        status: "available",
      },
      rationale: "用户明确补充随身容器。",
      risk: "warning" as const,
      requiresUserConfirm: true as const,
      sourceUserMessage: "给主角补一个黑色双肩包，随身带着，可以装公交卡和半张申请表。",
      extractedEntityName: "黑色双肩包",
      extractedEntityType: "container",
      sourceEvidence: "黑色双肩包",
      preservationWarnings: [],
    };

    await applyFoundationGapDecisions(projectDir, [
      { suggestionId: backpackSuggestion.id, decision: "accept" },
    ], [backpackSuggestion]);

    const assets = await readJson(projectDir, "story/assets.json");
    expect(assets.assets[0].name).toBe("黑色双肩包");
  });

  it("upserts rich character suggestions into bible and runtime character files", async () => {
    const projectDir = await createSparseProject();
    const characterId = toSafeCharacterId("苏晓薇");
    const suggestion = {
      id: "ai-character-lin-xiaowei-rich",
      gapId: "ai-gap-character",
      category: "characters" as const,
      actionType: "create_character" as const,
      targetFile: "story/character-bible.json",
      targetPath: "characters",
      targetId: characterId,
      before: undefined,
      after: {
        bibleEntry: {
          id: characterId,
          name: "苏晓薇",
          role: "重要角色",
          age: "28岁",
          gender: "女",
          identity: "远山集团生活秘书",
          appearanceAnchors: ["皮肤白皙", "气质出众"],
          desire: "照顾好主角并完成本职工作",
          fear: "越界影响主角判断",
          contradiction: "外表柔和但工作极其利落",
          moralBoundary: "不主动诱导主角做违法决定",
          relationshipToProtagonist: "看主角像弟弟，带点宠和操心",
          relationshipDynamics: ["亲近但有边界感"],
          speechStyle: "温和短句，先确认需求再行动。",
          speechSamples: ["您先坐，我把资料拿过来。"],
          behaviorBoundaries: ["不能替主角做重大决定"],
          knowledgeKnown: ["远山集团内部日常流程"],
          knowledgeUnknown: ["魂钢真实来源"],
          cannotReveal: ["集团高层秘密"],
          cannotDo: ["不能突破集团权限"],
          currentStateHint: "陪同主角进入集团总部",
        },
        profile: {
          id: characterId,
          name: "苏晓薇",
          identity: "远山集团生活秘书",
          age: "28岁",
          gender: "女",
          appearanceAnchors: ["皮肤白皙", "气质出众"],
          tags: ["重要角色"],
        },
        core: {
          characterId,
          personality: ["严谨", "温和", "效率高"],
          speechStyle: "温和短句，先确认需求再行动。",
          contradiction: "外表柔和但工作极其利落",
          taboos: ["不越权"],
        },
        state: {
          characterId,
          emotion: "平稳",
          goal: "完成照顾主角的本职工作",
          currentLocationName: "远山集团总部",
          currentMentalState: "职业化",
          knowledgeKnown: ["远山集团内部日常流程"],
          knowledgeUnknown: ["魂钢真实来源"],
          cannotReveal: ["集团高层秘密"],
          lastUpdatedChapter: null,
        },
      },
      rationale: "用户要求补充角色档案。",
      risk: "warning" as const,
      requiresUserConfirm: true as const,
    };

    const plan = await buildFoundationGapApplyPlan(projectDir, [
      { suggestionId: suggestion.id, decision: "accept" },
    ], [suggestion]);
    expect(plan.fileChanges.map((item) => item.targetFile)).toEqual(expect.arrayContaining([
      "story/character-bible.json",
      `characters/${characterId}/profile.json`,
      `characters/${characterId}/core.json`,
      `characters/${characterId}/state.json`,
    ]));

    await applyFoundationGapDecisions(projectDir, [
      { suggestionId: suggestion.id, decision: "accept" },
    ], [suggestion]);

    const bible = await readJson(projectDir, "story/character-bible.json");
    expect(bible.characters.find((item: any) => item.name === "苏晓薇")).toMatchObject({
      age: "28岁",
      contradiction: "外表柔和但工作极其利落",
      cannotReveal: ["集团高层秘密"],
    });
    const profile = await readJson(projectDir, `characters/${characterId}/profile.json`);
    const state = await readJson(projectDir, `characters/${characterId}/state.json`);
    expect(profile).toMatchObject({ name: "苏晓薇", age: "28岁", appearanceAnchors: ["皮肤白皙", "气质出众"] });
    expect(state).toMatchObject({ currentLocationName: "远山集团总部", cannotReveal: ["集团高层秘密"] });

    const overview = await buildStateOverview({ projectDir });
    expect(overview.characterMatrix.characters.find((item) => item.name === "苏晓薇")).toMatchObject({
      age: "28岁",
      appearanceAnchors: expect.arrayContaining(["皮肤白皙"]),
      contradiction: "外表柔和但工作极其利落",
      currentLocation: "远山集团总部",
      cannotReveal: expect.arrayContaining(["集团高层秘密"]),
    });
  });

  it("does not overwrite conflicting concrete fields", async () => {
    const projectDir = await createSparseProject();
    await writeJson(projectDir, "world/core.json", {
      genre: "科幻",
      premise: "城市被星港控制。",
      rules: [],
      mainConflict: "",
    });
    await writeJson(projectDir, "story/bible.json", {
      version: "v0",
      projectLogline: "林序毕业失败。",
      premise: "林序毕业失败。",
      genre: "都市英灵",
      subgenres: [],
      readerPromise: "",
      longFormGoals: [],
      centralConflicts: [],
      coreMysteries: [],
      forbiddenChanges: [],
      canonFacts: [],
      openQuestions: [],
    });

    const report = await buildFoundationGapReport(projectDir);
    expect(report.conflictItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "故事类型与世界类型不一致" }),
    ]));

    const genreSuggestion = report.suggestions.find((item) => item.targetPath === "genre");
    if (genreSuggestion) {
      await applyFoundationGapDecisions(projectDir, [{ suggestionId: genreSuggestion.id, decision: "edit", editedAfter: "科幻" }]);
    }
    const bible = await readJson(projectDir, "story/bible.json");
    expect(bible.genre).toBe("都市英灵");
  });

  // P0-2 原子写回归①：apply 走 tmp+rename 落盘，正常完成后目录内不得残留 *.tmp*，
  // 且目标文件是完整可解析的 JSON（进程被杀时要么完整落盘要么旧文件不动，不存在半截文件）。
  it("leaves no tmp residue and parseable JSON after apply", async () => {
    const projectDir = await createSparseProject();
    const suggestion = {
      id: "ai-world-atomic-residue",
      gapId: "ai-gap-world",
      category: "world" as const,
      actionType: "update_world_rule" as const,
      targetFile: "story/world-bible.json",
      targetPath: "socialOrder",
      targetId: "socialOrder",
      before: undefined,
      after: ["现实都市阶层由家庭资源、职业准入、资本和地方关系共同决定。"],
      rationale: "用户确认用现实都市规则补全世界观。",
      risk: "warning" as const,
      requiresUserConfirm: true as const,
    };

    const result = await applyFoundationGapDecisions(
      projectDir,
      [{ suggestionId: suggestion.id, decision: "accept" }],
      [suggestion],
    );

    expect(result.applied).toBe(true);
    const worldBible = await readJson(projectDir, "story/world-bible.json");
    expect(worldBible.socialOrder).toEqual(["现实都市阶层由家庭资源、职业准入、资本和地方关系共同决定。"]);
    expect(await listTmpResidue(projectDir)).toEqual([]);
  });

  // P0-2 原子写回归②：rename 中途抛错 → 该条如实记 apply_failed 跳过（不谎报成功），
  // 目标文件保持旧字节（rename 没发生=旧文件没被碰），tmp 半成品被清掉。
  it("keeps old content and cleans tmp when rename fails mid-apply", async () => {
    const projectDir = await createSparseProject();
    const targetPath = join(projectDir, "story", "world-bible.json");
    const beforeContent = await readFile(targetPath, "utf-8");
    const suggestion = {
      id: "ai-world-atomic-rename-fail",
      gapId: "ai-gap-world",
      category: "world" as const,
      actionType: "update_world_rule" as const,
      targetFile: "story/world-bible.json",
      targetPath: "socialOrder",
      targetId: "socialOrder",
      before: undefined,
      after: ["注入 rename 故障后这条不应该落盘。"],
      rationale: "验证原子写失败路径。",
      risk: "warning" as const,
      requiresUserConfirm: true as const,
    };

    renameMock.mockRejectedValueOnce(new Error("injected rename failure"));

    const result = await applyFoundationGapDecisions(
      projectDir,
      [{ suggestionId: suggestion.id, decision: "accept" }],
      [suggestion],
    );

    expect(renameMock).toHaveBeenCalled();
    expect(result.writes).toEqual([]);
    expect(result.applied).toBe(false);
    expect(result.skippedWrites).toEqual(expect.arrayContaining([
      expect.objectContaining({ suggestionId: suggestion.id, reason: "apply_failed" }),
    ]));
    expect(await readFile(targetPath, "utf-8")).toBe(beforeContent);
    expect(await listTmpResidue(projectDir)).toEqual([]);
  });
});

async function createSparseProject(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "story-engine-gap-assistant-"));
  const { projectDir } = await createStoryProject({
    rootDir,
    title: "资料缺口测试",
    genre: "都市英灵",
    premise: "林序在毕业失败当天接触魂钢异常反应。",
    mainCharacterName: "林序",
  });
  await writeJson(projectDir, "story/writing-rules.json", {
    version: "v0",
    narrativePerspective: "",
    proseStyle: [],
    chapterLength: {},
    genreRequirements: [],
    suspenseRules: [],
    payoffRules: [],
    reversalRules: [],
    readerExperienceRules: [],
    forbiddenContent: [],
    doNotDo: [],
  });
  await writeJson(projectDir, "story/world-bible.json", {
    version: "v0",
    rules: [],
    factions: [],
    powerOrSurvivalSystems: [],
    historyFacts: [],
    socialOrder: [],
  });
  await writeJson(projectDir, "story/location-bible.json", {
    version: "v0",
    locations: [],
  });
  await writeJson(projectDir, "story/assets.json", {
    version: "v0",
    assets: [],
    containers: [],
  });
  await writeJson(projectDir, "world/core.json", {
    genre: "都市英灵",
    premise: "林序在毕业失败当天接触魂钢异常反应。",
    rules: [],
    mainConflict: "",
  });
  return projectDir;
}

async function readProjectStoryBible(projectDir: string): Promise<string> {
  return readFile(join(projectDir, "story", "bible.json"), "utf-8");
}

async function readJson(projectDir: string, relativePath: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(join(projectDir, relativePath), "utf-8")) as Record<string, any>;
}

async function writeJson(projectDir: string, relativePath: string, value: unknown): Promise<void> {
  await writeFile(join(projectDir, relativePath), `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

/** 递归扫出目录里所有名字含 `.tmp` 的文件（原子写半成品残留）。 */
async function listTmpResidue(rootDir: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        await walk(join(dir, entry.name));
      } else if (entry.name.includes(".tmp")) {
        found.push(join(dir, entry.name));
      }
    }
  }
  await walk(rootDir);
  return found;
}
