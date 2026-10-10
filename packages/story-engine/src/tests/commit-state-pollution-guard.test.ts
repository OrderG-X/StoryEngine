import { mkdir, mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCommitPlanFromProject, buildSelectiveCommitPlan } from "../commit-plan-builder.js";
import { commitFastDraft } from "../commit-engine.js";
import { createStoryProject, readAssetLedger, readCharacterBible, readCharacterMatrixLedger, readLocationBible, toSafeCharacterId } from "../project-store.js";
import { buildStateOverview } from "../state-overview.js";

describe("Commit State Pollution Guard V0", () => {
  it("does not inject any genre-progression goals or threads regardless of setting wording", async () => {
    const projectDir = await createUrbanSpiritProject();
    await writeDraft(projectDir, 1, [
      "# 第1章",
      "",
      "林序站在海天市旧城区创业孵化楼2楼申请窗口，半张魂钢申请表突然发热。",
      "他没有去便利店找食物，也没有搜索地下车库，只是冷静地确认窗口为什么拒绝他的申请。",
      "他低声问：“规则写在哪儿？”",
      longEnoughText("创业魂钢申请窗口的冷光照着队伍，林序先观察电子屏，再把半张申请表按在柜台边缘。"),
    ].join("\n"));

    const result = await buildCommitPlanFromProject({ projectDir, chapter: 1 });

    // Pin: the genre-progression engine is removed, so no chapter can ever produce
    // hardcoded survival/apocalypse arc goals or threads from setting wording alone.
    expect(result.passed).toBe(true);
    expect(result.arcGoalUpdates?.map((goal) => goal.title).join("\n") ?? "").not.toMatch(/活过前三天|找到稳定水源|获取基础食物|搜索地下车库|去药店找药/u);
    expect(result.threadTrackingUpdates?.map((thread) => thread.title).join("\n") ?? "").not.toMatch(/水源|便利店找食物|药店|地下车库/u);
    expect(result.commitPlan?.characterUpdates?.[0]?.emotion).not.toBe("engaged");
    expect(result.commitPlan?.characterUpdates?.[0]?.goal).not.toBe("use the new advantage");
  });

  it("lists unregistered assets and locations in commit preview without writing ledgers", async () => {
    const projectDir = await createUrbanSpiritProject();
    await writeDraft(projectDir, 3, [
      "# 第3章",
      "",
      "林序离开孵化楼，摸到口袋里四十三块五毛现金，又在公交站旁边的便利店买了压缩饼干和矿泉水。",
      "便利店老板提到前面还有老邮局，门口挂着一部公共电话。",
      "半张魂钢申请表仍是半张，只在纸张毛边处稳定发热。",
      longEnoughText("林序没有打车去市中心，也没有让欠费手机联网。他只是拎着新买的东西，继续观察街口的人流。"),
    ].join("\n"));
    const beforeAssets = await readFile(join(projectDir, "story", "assets.json"), "utf-8");
    const beforeLocations = await readFile(join(projectDir, "story", "location-bible.json"), "utf-8");

    const result = await buildCommitPlanFromProject({ projectDir, chapter: 3 });

    expect(result.assetChanges?.newAssetCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: expect.stringContaining("现金"), requiresUserConfirm: true }),
      expect.objectContaining({ name: "压缩饼干", requiresUserConfirm: true }),
      expect.objectContaining({ name: "矿泉水", requiresUserConfirm: true }),
    ]));
    expect(result.locationChanges?.newLocationCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "便利店", requiresUserConfirm: true }),
      expect.objectContaining({ name: "老邮局", requiresUserConfirm: true }),
      expect.objectContaining({ name: "公共电话", requiresUserConfirm: true }),
    ]));
    await expect(readFile(join(projectDir, "story", "assets.json"), "utf-8")).resolves.toBe(beforeAssets);
    await expect(readFile(join(projectDir, "story", "location-bible.json"), "utf-8")).resolves.toBe(beforeLocations);
  });

  // Codex 复测：「许鸣站在报亭门口」里 报亭门口 = 已知地点「废弃报亭」的片段 + 方位后缀（门口），
  // 不是裸方位词所以躲过上轮的拒判，仍作新地点候选冒出来（方位词地点化的残留）。
  // 修后：候选剥掉方位后缀（门口/门外/后门/柜台/窗口…）若剩下的是已知地点子串 → 是已知地点的微位置、不当新候选；
  // 但「海港集团…档案室门外」这类剩下是【新】地点的不受影响（仍是合法新候选）。
  it("does not surface a known location's micro-position (报亭门口) as a new location candidate", async () => {
    const projectDir = await createUrbanSpiritProject();
    await writeJson(projectDir, "story/location-bible.json", {
      version: "v0",
      locations: [
        { id: "loc-incubator", name: "海天市旧城区创业孵化楼", type: "opening" },
        { id: "loc-kiosk", name: "废弃报亭", type: "scene" },
      ],
    });
    await writeDraft(projectDir, 2, [
      "# 第2章",
      "",
      "林序走到废弃报亭前查看，又在报亭门口站了一会儿。",
      "便利店老板路过，提了一句前面的老邮局还开着。",
      longEnoughText("林序没有打车去市中心，只是把报亭门口的位置记在心里，继续核对手里的半张申请表。"),
    ].join("\n"));

    const result = await buildCommitPlanFromProject({ projectDir, chapter: 2 });

    const candidateNames = result.locationChanges?.newLocationCandidates.map((item) => item.name) ?? [];
    // 已知地点的微位置不当新候选
    expect(candidateNames.join("\n")).not.toMatch(/报亭门口/u);
    // 窄修不误伤：真·新设施仍照常作候选浮出
    expect(candidateNames).toEqual(expect.arrayContaining(["便利店"]));
  });

  it("surfaces spatial / vehicle / phone risks as non-blocking soft warnings", async () => {
    const projectDir = await createUrbanSpiritProject();
    await writeDraft(projectDir, 2, [
      "# 第2章",
      "",
      "林序从2楼申请窗口往下走，却抬头看见这栋楼其实有四层楼。",
      "他打车去市中心，只用了五分钟就到达财团联合检测中心。",
      "欠费手机忽然连上网，刷新出了新的申请记录。",
      longEnoughText("他握紧半张魂钢申请表，知道自己不能突然掌握隐藏真相，只能继续确认眼前证据。"),
    ].join("\n"));

    const result = await buildCommitPlanFromProject({ projectDir, chapter: 2 });

    // 受控破例③（2026-06-20）：题材特定门禁降级为软提示——不再阻塞入库，但 candidate 仍产出。
    expect(result.passed).toBe(true);
    expect(result.requiresExplicitOverride).toBe(false);
    expect(result.blockingReasons ?? []).toEqual([]);
    // 检测能力不丢：highRiskIssueCount 与三类 candidate 照旧（前端当软提示展示）。
    expect(result.highRiskIssueCount).toBeGreaterThan(0);
    expect(result.locationChanges?.spatialViolationWarnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "未登记楼层：四层楼", severity: "high" }),
    ]));
    expect(result.assetChanges?.unregisteredAssetWarnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "欠费手机正常联网风险", severity: "high" }),
      expect.objectContaining({ name: "未登记交通工具或打车条件", severity: "high" }),
    ]));
  });

  it("does not block a registered basement garage location as an unregistered floor", async () => {
    const projectDir = await createUrbanSpiritProject();
    await writeJson(projectDir, "story/location-bible.json", {
      version: "v0",
      locations: [
        {
          id: "loc-headquarters-garage",
          name: "远山集团总部地下车库",
          type: "地点",
          locationType: "地点",
          spatialStructure: {
            floors: ["待确认楼层"],
            rooms: ["B2停车区", "车辆调度位置"],
            entrances: ["电梯厅"],
            exits: ["车库出口"],
          },
          knownFeatures: [],
          risks: [],
          resources: [],
          connectedLocations: [],
          fixedFacts: [],
        },
      ],
    });
    await writeDraft(projectDir, 2, [
      "# 第2章",
      "",
      "林序下班后走进远山集团总部地下车库，看见行政部安排的司机等在车旁。",
      "他没有开车，也没有坐专车，只说自己要坐公交回老房子拿东西。",
      longEnoughText("这一段使用的是已登记地点名，不应该因为包含地下车库四个字就被入库预览当成未登记楼层。"),
    ].join("\n"));

    const result = await buildCommitPlanFromProject({ projectDir, chapter: 2 });

    expect(result.blockingReasons?.join("\n") ?? "").not.toMatch(/地下车库/u);
    expect(result.locationChanges?.spatialViolationWarnings.map((item) => item.name).join("\n") ?? "").not.toMatch(/地下车库/u);
  });

  it("does not block generic top-floor lodging descriptions", async () => {
    const projectDir = await createUrbanSpiritProject();
    await writeDraft(projectDir, 2, [
      "# 第2章",
      "",
      "林序结束登记后，来到临时安排的顶楼套房休息。",
      "窗外的城市灯光很安静，他没有把这个住处当成新的固定据点，只把半张魂钢申请表压在桌角。",
      longEnoughText("他复盘白天在创业孵化楼看到的申请流程，决定明天继续确认窗口规则，而不是凭想象改写这栋建筑的结构。"),
    ].join("\n"));

    const result = await buildCommitPlanFromProject({ projectDir, chapter: 2 });

    expect(result.passed).toBe(true);
    expect(result.blockingReasons?.join("\n") ?? "").not.toMatch(/顶楼/u);
    expect(result.locationChanges?.spatialViolationWarnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "未登记泛化楼层描述：顶楼", severity: "warning" }),
    ]));
  });

  it("does not treat nearby people or non-money counters as protagonist assets", async () => {
    const projectDir = await createUrbanSpiritProject();
    await writeDraft(projectDir, 2, [
      "# 第2章",
      "",
      "林序走到一楼大厅，看见台面上立着一块塑料牌。",
      "旁边那个女孩的手机屏幕亮着，显示联网状态，她蹲在墙角翻背包。",
      "路边有自行车和电动车经过，但林序兜里现金不够，叫车都不现实。",
      "林序自己的欠费手机仍然只能显示仅限紧急呼叫，半张魂钢申请表仍是半张。",
      longEnoughText("林序没有使用别人的手机，也没有拿走别人的背包，只继续确认查询终端上的申请记录。"),
    ].join("\n"));

    const result = await buildCommitPlanFromProject({ projectDir, chapter: 2 });

    expect(result.passed).toBe(true);
    expect(result.assetChanges?.newAssetCandidates?.map((item) => item.name).join("\n") ?? "").not.toMatch(/背包/u);
    expect(result.assetChanges?.unregisteredAssetWarnings?.map((item) => item.name).join("\n") ?? "").not.toMatch(/欠费手机正常联网/u);
    expect(result.assetChanges?.unregisteredAssetWarnings?.map((item) => item.name).join("\n") ?? "").not.toMatch(/交通工具|打车/u);
  });

  it("does not treat an open closet door as vehicle usage", async () => {
    const projectDir = await createUrbanSpiritProject();
    await writeDraft(projectDir, 2, [
      "# 第2章",
      "",
      "林序回到父母的卧室，床铺已经收拾干净，衣柜门开着，少了几件衣服，行李箱不见了。",
      "楼下停着一辆银灰色商务车，但林序只是看见司机等在车旁，还没有决定是否接受安排。",
      longEnoughText("这一段只说明家里的人走得匆忙，不应该因为衣柜门开着就触发交通工具风险。"),
    ].join("\n"));

    const result = await buildCommitPlanFromProject({ projectDir, chapter: 2 });

    expect(result.assetChanges?.unregisteredAssetWarnings?.map((item) => item.evidence).join("\n") ?? "").not.toMatch(/衣柜门开着/u);
  });

  it("keeps protagonist as target when multiple mentioned support characters appear", async () => {
    const projectDir = await createUrbanSpiritProject();
    await addCharacterProfile(projectDir, "char-lawyer", "李明远", "法务律师");
    await writeDraft(projectDir, 2, [
      "# 第2章",
      "",
      "李明远律师的名字第一次出现在文件上，但真正做决定的人仍然是林序。",
      "林序决定去海天市确认后续安排，并要求自己先看清楚每份文件。",
      longEnoughText("李明远只是被提到的法务联系人，不应该抢走本章主角的状态更新目标。"),
    ].join("\n"));

    // 2026-10-10 起人物目标只取声明里的关键决定；这里钉的是「目标记在主角身上，不被配角抢走」。
    const decisionQuote = "林序决定去海天市确认后续安排，并要求自己先看清楚每份文件。";
    const result = await buildCommitPlanFromProject({
      projectDir,
      chapter: 2,
      declaration: {
        chapter: 2,
        mainEvent: { summary: "林序决定去海天市", quote: decisionQuote },
        decision: { summary: "去海天市确认后续安排", quote: decisionQuote },
        seededForeshadowing: [],
        resolvedForeshadowing: [],
        resourceDeltas: [],
        keyLeads: [],
      },
    });

    expect(result.semanticSummary?.protagonist).toBe("林序");
    expect(result.semanticSummary?.mentionedCharacterNames[0]).toBe("林序");
    expect(result.commitPlan?.timelineEvents?.[0]?.effects?.semanticSummary).toMatchObject({
      protagonist: "林序",
      mentionedCharacterNames: expect.arrayContaining(["林序", "李明远"]),
    });
    expect(result.characterKnowledgeChanges?.stateChanges.map((item) => item.name).join("\n") ?? "").toMatch(/林序/u);
    expect(result.characterKnowledgeChanges?.stateChanges.map((item) => item.name).join("\n") ?? "").not.toMatch(/李明远/u);
  });

  it("does not write rejected asset or location candidates during selective commit", async () => {
    const projectDir = await createUrbanSpiritProject();
    await writeDraft(projectDir, 3, [
      "# 第3章",
      "",
      "林序发现便利店门口贴着一张魂钢申请补交通知。",
      "林序决定继续确认补交通知，不立刻购买任何东西。",
      "他摸到口袋里四十三块五毛现金，却没有立刻进去购买压缩饼干。",
      longEnoughText("他仍然只确认眼前证据，不让欠费手机联网，也不把半张申请表变成完整表格。"),
    ].join("\n"));

    const preview = await buildCommitPlanFromProject({ projectDir, chapter: 3 });
    const cash = preview.assetChanges?.newAssetCandidates.find((item) => item.name.includes("现金"));
    const store = preview.locationChanges?.newLocationCandidates.find((item) => item.name === "便利店");
    expect(cash).toBeDefined();
    expect(store).toBeDefined();
    const commitPlan = buildSelectiveCommitPlan(preview, {
      assetDecisions: [{ candidateId: cash!.id, state: "reject" }],
      locationDecisions: [{ candidateId: store!.id, state: "reject" }],
      characterKnowledgeDecisions: [],
    });
    expect(commitPlan).toBeDefined();
    expect(commitPlan?.characterUpdates).toBeUndefined();

    const report = await commitFastDraft({ projectDir, chapter: 3, commitPlan: commitPlan! });

    expect(report.passed).toBe(true);
    const ledger = await readAssetLedger(projectDir);
    const locationBible = await readLocationBible(projectDir);
    const characterState = JSON.parse(await readFile(join(projectDir, "characters", toSafeCharacterId("林序"), "state.json"), "utf-8")) as { readonly lastUpdatedChapter?: number | null };
    expect(ledger.assets.map((asset) => asset.name).join("\n")).not.toMatch(/现金/u);
    expect(locationBible?.locations.map((location) => location.name).join("\n")).not.toMatch(/便利店/u);
    expect(characterState.lastUpdatedChapter).not.toBe(3);
  });

  it("writes character current state only when the state candidate is accepted", async () => {
    const projectDir = await createUrbanSpiritProject();
    await writeDraft(projectDir, 3, [
      "# 第3章",
      "",
      "林序决定去旧城区公交站查清魂钢检测记录。",
      longEnoughText("这一次决定是本章结尾的明确行动方向，不是普通肢体动作。"),
    ].join("\n"));

    const decisionQuote = "林序决定去旧城区公交站查清魂钢检测记录。";
    const preview = await buildCommitPlanFromProject({
      projectDir,
      chapter: 3,
      declaration: {
        chapter: 3,
        mainEvent: { summary: "林序决定查魂钢检测记录", quote: decisionQuote },
        decision: { summary: "去旧城区公交站查清魂钢检测记录", quote: decisionQuote },
        seededForeshadowing: [],
        resolvedForeshadowing: [],
        resourceDeltas: [],
        keyLeads: [],
      },
    });
    const goalCandidate = preview.characterKnowledgeChanges?.stateChanges.find((item) => item.changeType === "character_state_goal");
    expect(goalCandidate).toBeDefined();

    const commitPlan = buildSelectiveCommitPlan(preview, {
      assetDecisions: [],
      locationDecisions: [],
      characterKnowledgeDecisions: [{ candidateId: goalCandidate!.id, state: "accept" }],
    });
    expect(commitPlan?.characterUpdates?.[0]?.goal ?? "").toMatch(/魂钢检测记录|旧城区公交站/u);

    const report = await commitFastDraft({ projectDir, chapter: 3, commitPlan: commitPlan! });
    expect(report.passed).toBe(true);
    const characterState = JSON.parse(await readFile(join(projectDir, "characters", toSafeCharacterId("林序"), "state.json"), "utf-8")) as { readonly goal?: string; readonly lastUpdatedChapter?: number | null };
    expect(characterState.goal ?? "").toMatch(/魂钢检测记录|旧城区公交站/u);
    expect(characterState.lastUpdatedChapter).toBe(3);
  });

  it("does not promote ordinary body actions to character current goals", async () => {
    const projectDir = await createUrbanSpiritProject();
    await writeDraft(projectDir, 2, [
      "# 第2章 · 收起纸页",
      "",
      "林序把纸折好，准备塞回包里。",
      "他站起来，转身离开窗口，沉默地看了一眼大厅。",
      longEnoughText("这些动作只是他离开窗口前的整理，不代表新的长期目标，也没有构成明确的调查决定。"),
    ].join("\n"));

    const result = await buildCommitPlanFromProject({ projectDir, chapter: 2 });

    expect(result.commitPlan?.characterUpdates?.[0]?.goal ?? "").not.toMatch(/把纸折好|塞回包里|站起来|转身离开/u);
    expect(result.characterKnowledgeChanges?.stateChanges.map((item) => item.after).join("\n") ?? "").not.toMatch(/把纸折好|塞回包里|站起来|转身离开/u);
  });

  it("prefers completed ending locations for current location", async () => {
    const projectDir = await createUrbanSpiritProject();
    await writeDraft(projectDir, 3, [
      "# 第3章 · 旧站台",
      "",
      "林序从创业孵化楼出来，沿着旧城区街道慢慢往前走。",
      longEnoughText("公交站的顶棚投下一片阴影，林序没有打车，也没有让欠费手机联网。"),
      "林序站在旧城区公交站，低头摸了摸发热的半张申请表。",
      "他决定继续追查检测系统记录。",
    ].join("\n"));

    const preview = await buildCommitPlanFromProject({ projectDir, chapter: 3 });
    expect(preview.semanticSummary?.locations[0]).toBe("旧城区公交站");
    const report = await commitFastDraft({ projectDir, chapter: 3, commitPlan: preview.commitPlan! });
    expect(report.passed).toBe(true);

    const overview = await buildStateOverview({ projectDir });
    expect(overview.storyStatus.currentLocation).toBe("旧城区公交站");
    expect(overview.storyStatus.currentObjective).toMatch(/追查|检测系统记录/u);
  });

  it("keeps the more specific ending location when parent and target both appear", async () => {
    const projectDir = await createUrbanSpiritProject();
    await writeDraft(projectDir, 3, [
      "# 第3章 · 旧站台",
      "",
      "旧城区的风从街口灌过来，林序没有回头。",
      longEnoughText("这一段反复提到旧城区，只是为了保证父级地点和具体地点同时存在。"),
      "林序走到旧城区公交站，站在公交站台边确认下一条线索。",
      "他决定去旧城区公交站确认下一条线索。",
    ].join("\n"));

    const preview = await buildCommitPlanFromProject({ projectDir, chapter: 3 });

    expect(preview.semanticSummary?.locations[0]).toBe("旧城区公交站");
  });

  it("does not update current location from planned movement only", async () => {
    const projectDir = await createUrbanSpiritProject();
    await writeDraft(projectDir, 3, [
      "# 第3章 · 窗口前",
      "",
      "林序仍站在二楼申请窗口前，重新看了一遍半张魂钢申请表。",
      "他准备去旧城区公交站，但还没有离开窗口。",
      longEnoughText("这只是下一步计划，不代表他已经抵达公交站。"),
    ].join("\n"));

    const preview = await buildCommitPlanFromProject({ projectDir, chapter: 3 });

    expect(preview.semanticSummary?.locations[0]).not.toBe("旧城区公交站");
  });

  it("updates current location when moving from second floor window to first floor hall", async () => {
    const projectDir = await createUrbanSpiritProject();
    await writeDraft(projectDir, 2, [
      "# 第2章 · 一楼大厅",
      "",
      longEnoughText("他没有离开孵化楼，也没有把半张申请表变成完整申请表。"),
      "林序从二楼申请窗口下到一楼大厅。",
      "他站在一楼大厅的公共查询终端前，确认申请记录异常。",
    ].join("\n"));

    const preview = await buildCommitPlanFromProject({ projectDir, chapter: 2 });

    expect(preview.semanticSummary?.locations[0]).toBe("1楼大厅");
  });

  it("filters action and attitude sentences from current objectives and character goals", async () => {
    const projectDir = await createUrbanSpiritProject();
    await writeDraft(projectDir, 3, [
      "# 第3章 · 暂不回头",
      "",
      "林序把表格抽回来，转身准备走。",
      "但林序没打算再上去。",
      longEnoughText("这些只是章节结尾动作和态度，不应该覆盖长期目标。"),
    ].join("\n"));

    const preview = await buildCommitPlanFromProject({ projectDir, chapter: 3 });

    expect(preview.commitPlan?.characterUpdates?.[0]?.goal ?? "").not.toMatch(/抽回来|准备走|没打算再上去/u);
    expect(preview.characterKnowledgeChanges?.stateChanges.map((item) => item.after).join("\n") ?? "").not.toMatch(/抽回来|准备走|没打算再上去/u);
  });

  it("does not promote routine checks or seeing time to state facts", async () => {
    const projectDir = await createUrbanSpiritProject();
    await writeDraft(projectDir, 2, [
      "# 第2章",
      "",
      "林序伸手摸到手机，按掉闹钟，看见屏幕上的时间——上午七点半。",
      "林序回到自己房间，把昨晚收拾好的双肩包最后检查了一遍，然后坐在床边等车。",
      longEnoughText("这些是日常动作和普通感知，不是章节目标，也不是需要入库的新增知识。"),
    ].join("\n"));

    const preview = await buildCommitPlanFromProject({ projectDir, chapter: 2 });

    expect(preview.characterKnowledgeChanges?.stateChanges.map((item) => item.after).join("\n") ?? "").not.toMatch(/双肩包|检查/u);
    expect(preview.characterKnowledgeChanges?.knowledgeKnownChanges.map((item) => item.after).join("\n") ?? "").not.toMatch(/上午七点半|屏幕上的时间/u);
  });

  it("keeps explicit investigation intent as current objective", async () => {
    const projectDir = await createUrbanSpiritProject();
    await writeDraft(projectDir, 3, [
      "# 第3章 · 下一条线索",
      "",
      longEnoughText("林序没有开挂，也没有提前知道隐藏真相，只能沿着眼前记录继续走。"),
      "他决定去旧城区公交站确认下一条线索。",
    ].join("\n"));

    const preview = await buildCommitPlanFromProject({ projectDir, chapter: 3 });

    expect(preview.semanticSummary?.decision ?? "").toMatch(/确认|线索|公交站/u);
  });

  it("keeps logistics dialogue out of character goals and thread tracking", async () => {
    const projectDir = await createUrbanSpiritProject();
    await writeDraft(projectDir, 3, [
      "# 第3章",
      "",
      "苏晓薇一边走一边看手机：“先去酒店放行李，下午两点半去集团总部。”",
      "楼顶，“远山集团”四个金属字被阳光勾勒出一圈金边，气势夺人。",
      "李明远接过签好的文件，点头说第一阶段的程序就算初步完成了。",
      "林序看着文件，意识到自己不能一直被安排着走，他必须开始学会自己判断，先弄清自己能做什么、不能做什么。",
      longEnoughText("他没有把这些流程当成最终答案，只把今天见到的人、文件和规则逐条记下来，准备下一步继续确认。"),
    ].join("\n"));

    const preview = await buildCommitPlanFromProject({ projectDir, chapter: 3 });
    const goal = preview.semanticSummary?.decision ?? "";
    const threadTitles = preview.threadTrackingUpdates?.map((thread) => thread.title).join("\n") ?? "";

    expect(goal).toMatch(/自己判断|能做什么|不能做什么/u);
    expect(goal).not.toMatch(/苏晓薇|先去酒店|放行李/u);
    expect(preview.semanticSummary?.conflict ?? "").not.toMatch(/气势夺人|楼顶/u);
    expect(preview.semanticSummary?.mainEvent ?? "").not.toMatch(/当然可以|带回去慢慢看/u);
    expect(preview.semanticSummary?.timelineSummary ?? "").not.toMatch(/准备好了的话|当然可以/u);
    expect(threadTitles).not.toMatch(/先去酒店|放行李|程序.*完成|自己做决定/u);
  });

  it("keeps routine paperwork moving from polluting conflict and gained state", async () => {
    const projectDir = await createUrbanSpiritProject();
    await writeDraft(projectDir, 4, [
      "# 第4章",
      "",
      "林序站在酒店房间里，手里抱着一个沉甸甸的牛皮纸文件袋。",
      "他把文件袋拿到客厅茶几上打开，一份一份确认今天看过的材料。",
      "林序快速扫了一遍，发现其中一页审批记录被人威胁着代签，背后藏着一桩造假。",
      "他打开微信，给父亲发消息说今天的事都办妥了。",
      "陌生号码发来一条短信：“别再追这件事，否则有你好看。”",
      "林序没有删除这条短信，也没有回复，明天把材料看明白后再决定下一步。",
      longEnoughText("这章重点是主角发现造假与威胁，不应该把文件移动当成获得物。"),
    ].join("\n"));

    const preview = await buildCommitPlanFromProject({ projectDir, chapter: 4 });

    expect(preview.semanticSummary?.conflict ?? "").toMatch(/威胁|造假|代签|否则有你好看/u);
    expect(preview.semanticSummary?.discovery ?? "").toMatch(/威胁|造假|代签|审批|发现/u);
    expect(preview.semanticSummary?.gained ?? "").not.toMatch(/文件袋|茶几|聊天记录/u);
    expect(preview.semanticSummary?.mainEvent ?? "").not.toMatch(/文件袋拿到/u);
    expect(preview.semanticSummary?.keyEvents?.join("\n") ?? "").toMatch(/威胁|造假|代签|审批/u);
  });

  it("prioritizes the substantive revelation over routine family and travel beats", async () => {
    const projectDir = await createUrbanSpiritProject();
    await writeDraft(projectDir, 1, [
      "# 第1章",
      "",
      "林序把碗筷端进厨房，洗了手出来，发现父母还坐在原位，摆出一副长谈的架势。",
      "他想起初中毕业想去夏令营，三百块的钱让母亲犹豫了一晚上。",
      "母亲压低声音说，他注意到登记簿上有人冒用了林序的名义提交申请。",
      "林序意识到这份伪造的申请背后牵出一桩他从不知道的秘密。",
      "他决定先去档案室核对原始记录，弄清谁在背后操作。",
      longEnoughText("这章重点是伪造申请的秘密被揭开，不能把收碗、夏令营和普通家庭回忆当成正式状态。"),
    ].join("\n"));

    const preview = await buildCommitPlanFromProject({ projectDir, chapter: 1 });
    const keyEvents = preview.semanticSummary?.keyEvents?.join("\n") ?? "";

    expect(preview.semanticSummary?.discovery ?? "").toMatch(/冒用|伪造|注意到|意识到|秘密/u);
    expect(preview.semanticSummary?.mainEvent ?? "").toMatch(/冒用|伪造|注意到|意识到|秘密|档案室/u);
    expect(keyEvents).toMatch(/冒用|伪造|秘密|档案室/u);
    expect(keyEvents).not.toMatch(/碗筷|夏令营/u);
  });

  it("keeps protagonist agency as the decision after a passive onboarding scene", async () => {
    const projectDir = await createUrbanSpiritProject();
    await writeDraft(projectDir, 3, [
      "# 第3章",
      "",
      "取完行李，林序出了到达大厅，看见司机举着写有“林先生”的接机牌站在栏杆外。",
      "陪同的人说先去酒店放行李，下午两点半再出发。",
      "对方递来一沓材料，说所有流程都已经安排好，他只要按提示签字就行。",
      "会议结束后，林序忽然意识到自己不能再只是被推着走，他必须开始学会自己判断，先弄清自己能做什么、不能做什么。",
      longEnoughText("这章重点是被动安排的流程和主角开始主动判断，不能让接机牌和放行李覆盖入库目标。"),
    ].join("\n"));

    const preview = await buildCommitPlanFromProject({ projectDir, chapter: 3 });

    expect(preview.semanticSummary?.decision ?? "").toMatch(/不能再|自己判断|能做什么|不能做什么/u);
    expect(preview.semanticSummary?.mainEvent ?? "").not.toMatch(/接机牌|放行李/u);
  });

  it("prioritizes the investigation beats over routine hotel beats", async () => {
    const projectDir = await createUrbanSpiritProject();
    await writeDraft(projectDir, 5, [
      "# 第5章",
      "",
      "阳光从窗帘缝隙里漏进来的时候，林序已经醒了。",
      "他看见屏幕上没有新消息，吃完早餐才打开桌上那叠材料。",
      "林序翻看材料时，发现其中一份审批记录的签名和原件完全对不上。",
      "他意识到有人替换了关键的审批页，决定下午去档案室核对原件，查清合同和纠纷的真实记录。",
      longEnoughText("这一章重点是主角主动核对材料发现疑点，而不是让早餐、窗帘和寒暄成为正式故事状态。"),
    ].join("\n"));

    const preview = await buildCommitPlanFromProject({ projectDir, chapter: 5 });
    const keyEvents = preview.semanticSummary?.keyEvents?.join("\n") ?? "";

    expect(preview.semanticSummary?.discovery ?? "").toMatch(/对不上|替换|审批|原件|意识到|发现/u);
    expect(preview.semanticSummary?.decision ?? "").toMatch(/档案室|核对|原件|合同|纠纷|查清/u);
    expect(preview.semanticSummary?.mainEvent ?? "").not.toMatch(/窗帘|早餐|清粥|胃口/u);
    expect(keyEvents).toMatch(/对不上|替换|审批|原件|档案室/u);
    expect(keyEvents).not.toMatch(/窗帘|早餐|清粥|胃口|没有新消息/u);
  });

  it("keeps mid-draft locations behind the ending location", async () => {
    const projectDir = await createUrbanSpiritProject();
    await writeDraft(projectDir, 2, [
      "# 第2章 · 回到窗口",
      "",
      "林序经过旧城区公交站，短暂停了一下。",
      longEnoughText("结尾仍然发生在申请窗口，不应该被中段公交站覆盖。"),
      "随后他回到二楼申请窗口，站在窗口前确认半张申请表的编号。",
    ].join("\n"));

    const preview = await buildCommitPlanFromProject({ projectDir, chapter: 2 });

    expect(preview.semanticSummary?.locations[0]).toBe("2楼申请窗口");
  });

  it("writes only accepted asset, location, and knowledge candidates during selective commit", async () => {
    const projectDir = await createUrbanSpiritProject();
    await writeDraft(projectDir, 3, [
      "# 第3章",
      "",
      "林序发现便利店门口贴着一张魂钢申请补交通知。",
      "他摸到口袋里四十三块五毛现金，又确认便利店货架上有压缩饼干和矿泉水。",
      longEnoughText("他仍然只确认眼前证据，不让欠费手机联网，也不把半张申请表变成完整表格。"),
    ].join("\n"));

    const preview = await buildCommitPlanFromProject({ projectDir, chapter: 3 });
    const cash = preview.assetChanges?.newAssetCandidates.find((item) => item.name.includes("现金"));
    const store = preview.locationChanges?.newLocationCandidates.find((item) => item.name === "便利店");
    const knowledge = preview.characterKnowledgeChanges?.knowledgeKnownChanges[0];
    expect(cash).toBeDefined();
    expect(store).toBeDefined();
    expect(knowledge).toBeDefined();

    const commitPlan = buildSelectiveCommitPlan(preview, {
      assetDecisions: [{ candidateId: cash!.id, state: "accept" }],
      locationDecisions: [{ candidateId: store!.id, state: "accept" }],
      characterKnowledgeDecisions: [{ candidateId: knowledge!.id, state: "accept" }],
    });
    expect(commitPlan).toBeDefined();

    const report = await commitFastDraft({ projectDir, chapter: 3, commitPlan: commitPlan! });

    expect(report.passed).toBe(true);
    const ledger = await readAssetLedger(projectDir);
    const locationBible = await readLocationBible(projectDir);
    const characterBible = await readCharacterBible(projectDir);
    expect(ledger.assets.map((asset) => asset.name).join("\n")).toMatch(/现金/u);
    expect(locationBible?.locations.map((location) => location.name).join("\n")).toMatch(/便利店/u);
    expect(characterBible?.characters[0]?.knowledgeKnown?.join("\n") ?? "").toMatch(/便利店|魂钢申请补交通知/u);
  });

  it("captures prose-introduced people, places, and objects as accepted foundation updates", async () => {
    const projectDir = await createUrbanSpiritProject();
    await writeDraft(projectDir, 4, [
      "# 第4章",
      "",
      "林序站在海港集团二十七层的档案室门外，看见沈望把一支银色录音笔推到他面前。",
      "沈望的胸牌上写着“战略审计部”，他低声提醒林序：这段录音只能证明有人改过交接记录。",
      longEnoughText("林序没有立刻相信沈望，他只把档案室门外的监控死角和银色录音笔都记下来，准备下一步核对交接记录。"),
    ].join("\n"));

    const preview = await buildCommitPlanFromProject({ projectDir, chapter: 4 });
    const matrixCandidate = preview.characterKnowledgeChanges?.characterMatrixCandidates.find((item) => item.name.includes("沈望"));
    const recorder = preview.assetChanges?.newAssetCandidates.find((item) => item.name === "银色录音笔");
    const archiveDoor = preview.locationChanges?.newLocationCandidates.find((item) => item.name.includes("海港集团二十七层的档案室门外"));
    expect(matrixCandidate).toEqual(expect.objectContaining({ changeType: "character_matrix_candidate" }));
    expect(recorder).toEqual(expect.objectContaining({ changeType: "new_asset_candidate" }));
    expect(archiveDoor).toEqual(expect.objectContaining({ changeType: "new_location_candidate" }));

    const commitPlan = buildSelectiveCommitPlan(preview, {
      assetDecisions: [{ candidateId: recorder!.id, state: "accept" }],
      locationDecisions: [{ candidateId: archiveDoor!.id, state: "accept" }],
      characterKnowledgeDecisions: [{ candidateId: matrixCandidate!.id, state: "accept" }],
    });
    expect(commitPlan).toBeDefined();

    const report = await commitFastDraft({ projectDir, chapter: 4, commitPlan: commitPlan! });

    expect(report.passed).toBe(true);
    await expect(readAssetLedger(projectDir)).resolves.toMatchObject({
      assets: expect.arrayContaining([expect.objectContaining({ name: "银色录音笔" })]),
    });
    await expect(readLocationBible(projectDir)).resolves.toMatchObject({
      locations: expect.arrayContaining([expect.objectContaining({ name: expect.stringContaining("海港集团二十七层的档案室门外") })]),
    });
    await expect(readCharacterMatrixLedger(projectDir)).resolves.toMatchObject({
      entries: expect.arrayContaining([expect.objectContaining({
        name: "沈望",
        status: "candidate",
        roleHint: expect.stringContaining("战略审计部"),
        relationToProtagonist: expect.stringContaining("信息提供者"),
      })]),
    });
    const overview = await buildStateOverview({ projectDir, chapter: 4 });
    expect(overview.characterMatrix.characters.map((item) => item.name)).toEqual(expect.arrayContaining(["沈望"]));
  });

  it("does not downgrade an accepted character matrix entry back to candidate", async () => {
    const projectDir = await createUrbanSpiritProject();
    await writeJson(projectDir, "story/character-matrix.json", {
      version: "v0",
      entries: [{
        id: "matrix-shen-wang",
        name: "沈望",
        status: "accepted",
        roleHint: "战略审计部",
        evidence: ["已人工确认是战略审计部成员。"],
        appearances: [],
        relationshipEvents: [],
      }],
    });
    await writeDraft(projectDir, 4, [
      "# 第4章",
      "",
      "沈望站在海港集团二十七层的档案室门外，把一支银色录音笔推到林序面前。",
      "沈望的胸牌上写着“战略审计部”，他低声提醒林序：这段录音只能证明有人改过交接记录。",
      longEnoughText("林序只把沈望的话当成待核对线索，不让欠费手机联网，也不提前相信任何阵营。"),
    ].join("\n"));

    const report = await commitFastDraft({
      projectDir,
      chapter: 4,
      commitPlan: {
        timelineEvents: [{ summary: "沈望再次出现。", participants: [toSafeCharacterId("林序")] }],
        characterMatrixUpdates: [{
          id: "matrix-shen-wang",
          name: "沈望",
          status: "candidate",
          evidence: ["第4章再次出现。"],
          appearances: [{ chapter: 4, evidence: "沈望站在档案室门外。" }],
          relationshipEvents: [{ chapter: 4, evidence: "沈望提醒林序核对交接记录。" }],
        }],
      },
    });
    expect(report.passed).toBe(true);

    const matrix = await readCharacterMatrixLedger(projectDir);
    expect(matrix.entries.find((entry) => entry.name === "沈望")?.status).toBe("accepted");
  });

  it("captures the browser writing scenario without treating cash-flow wording as cash asset", async () => {
    const projectDir = await createUrbanSpiritProject();
    await writeDraft(projectDir, 5, [
      "# 第5章",
      "",
      "林序走到海港集团三十二层风控会议室外的长廊，陆映站在会议室门口等他。",
      "她的工牌上写着“风控合规部”，她把一枚蓝色权限盘递给林序，提醒他先核对会议记录。",
      "墙上的屏幕滚动着远山集团现金流压力预警，但林序没有因此获得任何现金，也不想让周泊言把所有风险推给新继承人。",
      longEnoughText("林序收起蓝色权限盘，没有立刻进入风控会议室，只记下陆映给出的风控会议室门口监控盲区。"),
    ].join("\n"));

    const preview = await buildCommitPlanFromProject({ projectDir, chapter: 5 });
    const matrixCandidate = preview.characterKnowledgeChanges?.characterMatrixCandidates.find((item) => item.name.includes("陆映"));
    const matrixNames = preview.characterKnowledgeChanges?.characterMatrixCandidates.map((item) => item.name) ?? [];
    const assetNames = preview.assetChanges?.newAssetCandidates.map((item) => item.name) ?? [];
    const locationNames = preview.locationChanges?.newLocationCandidates.map((item) => item.name) ?? [];
    const permissionDrive = preview.assetChanges?.newAssetCandidates.find((item) => item.name === "蓝色权限盘");
    const riskHall = preview.locationChanges?.newLocationCandidates.find((item) => item.name.includes("风控会议室外的长廊"));
    const falseCash = preview.assetChanges?.newAssetCandidates.find((item) => item.name === "现金/余额");
    expect(matrixCandidate).toEqual(expect.objectContaining({ changeType: "character_matrix_candidate" }));
    expect(permissionDrive).toEqual(expect.objectContaining({ changeType: "new_asset_candidate" }));
    expect(riskHall).toEqual(expect.objectContaining({ changeType: "new_location_candidate" }));
    expect(falseCash).toBeUndefined();
    expect(assetNames).not.toContain("权限盘");
    expect(assetNames).not.toContain("工牌");
    expect(locationNames.some((name) => /林序|他沿着|记下|没有直接/u.test(name))).toBe(false);
    expect(locationNames).not.toContain("会议室门口");
    expect(matrixNames.some((name) => /回答|让/u.test(name))).toBe(false);
    expect(matrixNames).toEqual(expect.arrayContaining([expect.stringContaining("周泊言")]));

    const commitPlan = buildSelectiveCommitPlan(preview, {
      assetDecisions: [{ candidateId: permissionDrive!.id, state: "accept" }],
      locationDecisions: [{ candidateId: riskHall!.id, state: "accept" }],
      characterKnowledgeDecisions: [{ candidateId: matrixCandidate!.id, state: "accept" }],
    });
    expect(commitPlan).toBeDefined();

    const report = await commitFastDraft({ projectDir, chapter: 5, commitPlan: commitPlan! });

    expect(report.passed).toBe(true);
    await expect(readAssetLedger(projectDir)).resolves.toMatchObject({
      assets: expect.arrayContaining([expect.objectContaining({ name: "蓝色权限盘" })]),
    });
    await expect(readLocationBible(projectDir)).resolves.toMatchObject({
      locations: expect.arrayContaining([expect.objectContaining({ name: expect.stringContaining("风控会议室外的长廊") })]),
    });
    await expect(readCharacterMatrixLedger(projectDir)).resolves.toMatchObject({
      entries: expect.arrayContaining([expect.objectContaining({
        name: "陆映",
        status: "candidate",
        roleHint: expect.stringContaining("风控合规部"),
      })]),
    });
  });
});

async function createUrbanSpiritProject(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "story-engine-pollution-guard-"));
  const { projectDir } = await createStoryProject({
    rootDir,
    title: "海天魂钢",
    genre: "都市英灵 / 创业魂钢",
    premise: "普通毕业生林序在海天市旧城区创业孵化楼接触创业魂钢异常反应。",
    mainCharacterName: "林序",
  });
  const characterId = toSafeCharacterId("林序");
  await Promise.all([
    writeJson(projectDir, "story/bible.json", {
      version: "v0",
      projectLogline: "林序从底层追查创业魂钢申请异常。",
      premise: "创业魂钢决定城市阶层、资源分配和英灵能力。",
      genre: "都市英灵 / 创业魂钢",
      subgenres: ["都市英灵"],
      readerPromise: "普通人稳步确认城市规则。",
      longFormGoals: ["查清魂钢申请异常"],
      centralConflicts: ["财团垄断觉醒机会"],
      coreMysteries: ["魂钢真实来源"],
      forbiddenChanges: ["不要突然开挂"],
      canonFacts: [],
      openQuestions: [],
      protectedSecrets: ["魂钢真实来源", "财团幕后操盘者", "主角潜力真实等级"],
    }),
    writeJson(projectDir, "story/location-bible.json", {
      version: "v0",
      locations: [{
        id: "loc-incubator",
        name: "海天市旧城区创业孵化楼",
        type: "opening",
        locationType: "城市建筑",
        spatialStructure: {
          floors: ["1楼大厅", "2楼申请窗口", "3楼办公区"],
          rooms: ["1楼大厅查询终端区", "2楼毕业申请窗口", "3楼财团办公区"],
          entrances: ["旧城区正门"],
          exits: ["一楼大厅侧门"],
        },
        knownFeatures: ["魂钢申请窗口"],
        risks: ["3楼办公区不对普通毕业生开放"],
        resources: ["1楼大厅公共查询终端"],
        connectedLocations: ["旧城区公交站", "市中心"],
        travelRules: [
          { targetLocation: "1楼大厅", method: "stairs", durationMinutes: 1 },
          { targetLocation: "旧城区公交站", method: "walk", durationMinutes: 6 },
          { targetLocation: "市中心", method: "taxi", durationMinutes: 25, constraint: "现金不足时不能随便打车。" },
        ],
      }],
    }),
    writeJson(projectDir, "story/assets.json", {
      version: "v0",
      assets: [
        { id: "asset-phone", name: "欠费手机", type: "keyItem", ownerCharacterId: characterId, carriedByCharacterId: characterId, status: "locked", isPlotCritical: true, canAiModify: false, conditionNote: "欠费三天，不能正常联网。" },
        { id: "asset-bus-card", name: "公交卡", type: "money", ownerCharacterId: characterId, carriedByCharacterId: characterId, status: "available", canAiModify: false },
        { id: "asset-half-form", name: "半张魂钢申请表", type: "document", ownerCharacterId: characterId, carriedByCharacterId: characterId, status: "damaged", isPlotCritical: true, canAiModify: false, conditionNote: "只有左半张。" },
      ],
      containers: [],
    }),
  ]);
  return projectDir;
}

async function writeDraft(projectDir: string, chapter: number, content: string): Promise<void> {
  await writeFile(join(projectDir, "drafts", "fast", `chapter-${String(chapter).padStart(4, "0")}.md`), `${content}\n`, "utf-8");
}

async function writeJson(projectDir: string, relativePath: string, value: unknown): Promise<void> {
  await writeFile(join(projectDir, relativePath), `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

async function addCharacterProfile(projectDir: string, id: string, name: string, identity: string): Promise<void> {
  await mkdir(join(projectDir, "characters", id), { recursive: true });
  await writeJson(projectDir, join("characters", id, "profile.json"), { id, name, identity });
}

function longEnoughText(seed: string): string {
  return Array.from({ length: 8 }, (_, index) => `${seed} 第${index + 1}次确认后，他仍然只相信眼前看见的窗口、申请表和终端提示。`).join("\n");
}
