import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkWritingContextPackDraft } from "../commit-quality-check.js";
import { buildWriterContext } from "../context-gateway.js";
import { createStoryProject, toSafeCharacterId } from "../project-store.js";
import { renderFastDraftPromptText } from "../prompt-cache-diagnostics.js";
import { buildWritingContextPack } from "../writing-context-pack.js";

describe("Writing Context Pack V0", () => {
  it("extracts foundation constraints for the current chapter", async () => {
    const projectDir = await createSoulSteelFixture();

    const pack = await buildWritingContextPack({
      projectDir,
      chapter: 1,
      userDirection: "毕业失败当天，主角第一次接触魂钢异常反应",
      currentChapterGoal: "第一章写毕业失败当天，林序第一次接触魂钢异常反应",
      maxTimelineEvents: 3,
    });

    expect(pack.chapterTask).toMatchObject({
      chapterNumber: 1,
      firstChapterGoal: "毕业失败当天，林序第一次接触魂钢异常反应",
      openingScene: "海天市旧城区创业孵化楼",
      firstHook: "半张魂钢申请表出现异常发热",
    });
    expect(pack.protagonistContext).toMatchObject({
      name: "林序",
      weakness: "普通人起步，不开挂，信息有限，前期资源不足",
      knownFacts: expect.arrayContaining(["魂钢会影响毕业后的资源分配"]),
      unknownTruths: expect.arrayContaining(["财团幕后操盘者"]),
      resourcesLimit: expect.arrayContaining(["手机欠费"]),
    });
    expect(pack.locationContext.requiredCurrentLocation).toBe("海天市旧城区创业孵化楼");
    expect(pack.locationContext.spatialStructure?.floors).toEqual(expect.arrayContaining(["1楼大厅", "2楼申请窗口", "3楼办公区"]));
    expect(pack.locationContext.travelRules).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetLocation: "市中心", method: "taxi", durationMinutes: 25 }),
    ]));
    expect(pack.locationContext.locationRisks).toEqual(expect.arrayContaining(["孵化楼的魂钢检测设备可能被财团监控"]));
    expect(pack.worldRulesContext.coreRules).toEqual(expect.arrayContaining(["创业魂钢决定城市阶层、资源分配和英灵能力"]));
    expect(pack.assetContext.initialAssets).toEqual(expect.arrayContaining(["旧笔记本电脑", "公交卡", "欠费手机", "半张魂钢申请表"]));
    expect(pack.assetContext.carriedAssets.join("\n")).toContain("欠费手机");
    expect(pack.assetContext.unavailableAssets.join("\n")).toContain("欠费手机");
    expect(pack.protagonistContext).toMatchObject({
      age: "22岁",
      speechStyle: "克制，先观察再反问。",
      speechSamples: expect.arrayContaining(["先排着，不代表我认了。"]),
    });
    expect(pack.hardConstraints.join("\n")).toContain("不要编造新的城市名");
    expect(pack.hardConstraints.join("\n")).toContain("不要违反移动规则");
    expect(pack.hardConstraints.join("\n")).toContain("欠费手机不能突然正常联网");
    expect(pack.hardConstraints.join("\n")).toContain("海天市旧城区创业孵化楼");
    expect(pack.sourceTrace.map((item) => item.source)).toEqual(expect.arrayContaining([
      "storyBible",
      "writingRules",
      "characterBible",
      "worldBible",
      "locationBible",
      "characterState",
      "chapterSteering",
    ]));
  });

  // Codex 复测：首稿跑偏（第三块砖→第三层杂志架、A-17→数字串）。用户/agent 指定的必命中要点注入「本章硬约束」，
  // protocol 已令模型优先于文风遵守。
  it("injects user-specified mustHitBeats into hardConstraints verbatim", async () => {
    const projectDir = await createSoulSteelFixture();

    const pack = await buildWritingContextPack({
      projectDir,
      chapter: 1,
      userDirection: "第一章",
      mustHitBeats: ["第三块砖", "债权池A-17", "买胶带"],
    });

    const joined = pack.hardConstraints.join("\n");
    expect(joined).toContain("必须在本章逐条落实");
    expect(joined).toContain("第三块砖");
    expect(joined).toContain("债权池A-17");
    expect(joined).toContain("买胶带");
  });

  it("omits the mustHitBeats hard rule when none provided（向后兼容老书）", async () => {
    const projectDir = await createSoulSteelFixture();
    const pack = await buildWritingContextPack({ projectDir, chapter: 1, userDirection: "第一章" });
    expect(pack.hardConstraints.join("\n")).not.toContain("必须在本章逐条落实");
  });

  it("derives the unavailable-asset hard rule from registered name/status, theme-neutrally", async () => {
    const projectDir = await createSoulSteelFixture();
    const characterId = toSafeCharacterId("林序");
    // Replace the genre-specific phone with an arbitrary asset that has no `rules` of its own
    // and a non-standard custom status. The hard rule must still be produced purely from the
    // registered name + status, proving the rule is no longer tied to any hardcoded 题材专名.
    await writeJson(projectDir, "story/assets.json", {
      version: "v0",
      assets: [
        { id: "asset-ok", name: "登记可用道具", type: "item", ownerCharacterId: characterId, ownerName: "林序", carriedByCharacterId: characterId, status: "available", isPlotCritical: false, canAiModify: false },
        { id: "asset-broken", name: "随便什么坏掉的东西", type: "item", ownerCharacterId: characterId, ownerName: "林序", carriedByCharacterId: characterId, status: "出故障", isPlotCritical: false, canAiModify: false },
      ],
      containers: [],
    });

    const pack = await buildWritingContextPack({
      projectDir,
      chapter: 1,
      userDirection: "第一章",
    });

    const assetHardRules = pack.assetContext.assetHardRules.join("\n");
    // Registered non-available asset → still produces a hard rule built purely from the
    // bible's own name + status (detection preserved, no hardcoded 题材专名 required).
    expect(assetHardRules).toContain("随便什么坏掉的东西 当前不可用（出故障），不能写成可正常使用");
    // Available asset → no unavailability rule (no false positive for usable assets).
    expect(assetHardRules).not.toContain("登记可用道具 当前不可用");
    // The phone-specific rule only appears when an asset registered in THIS project carries it;
    // it is no longer synthesized from a hardcoded regex, so it is absent for these assets.
    expect(assetHardRules).not.toContain("欠费手机不能突然正常联网");
  });

  it("never hardcodes 题材专名 in the asset hard-rule source", async () => {
    const source = await readFile(new URL("../writing-context-pack.ts", import.meta.url), "utf-8");
    for (const banned of ["欠费手机", "联网", "末日", "财团"]) {
      expect(source).not.toContain(banned);
    }
  });

  it("adds hard constraints to the FastDraft prompt without embedding State Overview JSON", async () => {
    const projectDir = await createSoulSteelFixture();
    const context = await buildWriterContext({
      projectDir,
      chapter: 1,
      chapterGoal: "第一章写毕业失败当天，林序第一次接触魂钢异常反应",
    });

    const prompt = renderFastDraftPromptText(context);

    expect(context.trace.sectionNames).toContain("writing_context_pack");
    expect(prompt).toContain("## 本章硬约束");
    expect(prompt).toContain("不要编造新的城市名");
    expect(prompt).toContain("海天市旧城区创业孵化楼");
    expect(prompt).toContain("半张魂钢申请表");
    expect(prompt).not.toContain("\"storyStatus\"");
    expect(prompt).not.toContain("\"uiHints\"");
  });

  it("customNotes 进 writingRulesContext 且渲进 FastDraft 正文 prompt（受控破例⑧·喂模型）", async () => {
    const projectDir = await createSoulSteelFixture();
    await writeJson(projectDir, "story/writing-rules.json", {
      version: "v0",
      proseStyle: ["克制"],
      genreRequirements: [],
      suspenseRules: [],
      payoffRules: [],
      reversalRules: [],
      readerExperienceRules: [],
      forbiddenContent: [],
      doNotDo: [],
      customNotes: "## 我的开车节奏\n- 前戏铺垫别超过200字\n- 高潮段落用短句",
    });

    const pack = await buildWritingContextPack({ projectDir, chapter: 1, userDirection: "第一章" });
    expect(pack.writingRulesContext.customNotes).toContain("前戏铺垫别超过200字");

    const context = await buildWriterContext({ projectDir, chapter: 1, chapterGoal: "第一章" });
    const prompt = renderFastDraftPromptText(context);
    expect(prompt).toContain("作者自定写作规矩");
    expect(prompt).toContain("前戏铺垫别超过200字"); // customNotes 原文真进 prompt（不止埋 JSON）
  });

  it("旧书没有 styleExemplars 字段：pack 不崩、styleExemplars 为空（向后兼容）", async () => {
    const projectDir = await createSoulSteelFixture(); // fixture 的 writing-rules.json 不带 styleExemplars
    const pack = await buildWritingContextPack({ projectDir, chapter: 1, userDirection: "第一章" });
    expect(pack.writingRulesContext.styleExemplars).toEqual([]);

    const context = await buildWriterContext({ projectDir, chapter: 1, chapterGoal: "第一章" });
    const prompt = renderFastDraftPromptText(context);
    expect(prompt).not.toContain("作者文风样本");
  });

  it("文风样本进 writingRulesContext 且渲进 FastDraft 正文 prompt（正向锚·模仿风格不得照抄）", async () => {
    const projectDir = await createSoulSteelFixture();
    await writeJson(projectDir, "story/writing-rules.json", {
      version: "v0",
      proseStyle: ["克制"],
      genreRequirements: [],
      suspenseRules: [],
      payoffRules: [],
      reversalRules: [],
      readerExperienceRules: [],
      forbiddenContent: [],
      doNotDo: [],
      styleExemplars: [{
        id: "exemplar-secret-01",
        title: "雨夜开场",
        text: "雨先是落在檐角，再落到他的肩上。他没有躲，只是觉得这座城忽然安静得过分。",
        note: "我满意的开头节奏",
        createdAtMs: 1726000000000,
      }],
    });

    const pack = await buildWritingContextPack({ projectDir, chapter: 1, userDirection: "第一章" });
    expect(pack.writingRulesContext.styleExemplars).toEqual([{
      title: "雨夜开场",
      text: "雨先是落在檐角，再落到他的肩上。他没有躲，只是觉得这座城忽然安静得过分。",
      note: "我满意的开头节奏",
    }]);

    const context = await buildWriterContext({ projectDir, chapter: 1, chapterGoal: "第一章" });
    const prompt = renderFastDraftPromptText(context);
    expect(prompt).toContain("## 作者文风样本（模仿风格·不得照抄内容）");
    expect(prompt).toContain("模仿其句法节奏、用词偏好与叙事温度");
    expect(prompt).toContain("不得照抄样本内容、情节或具体名物");
    expect(prompt).toContain("雨夜开场");
    expect(prompt).toContain("雨先是落在檐角");
    expect(prompt).toContain("我满意的开头节奏");
    expect(prompt).not.toContain("exemplar-secret-01"); // 内部 id 不喂模型
  });

  it("坏样本条目跳过不崩：非对象 / 缺 text / 超存储上限，正常条目仍进 prompt", async () => {
    const projectDir = await createSoulSteelFixture();
    await writeJson(projectDir, "story/writing-rules.json", {
      version: "v0",
      proseStyle: [],
      genreRequirements: [],
      suspenseRules: [],
      payoffRules: [],
      reversalRules: [],
      readerExperienceRules: [],
      forbiddenContent: [],
      doNotDo: [],
      styleExemplars: [
        "这不是对象",
        { id: "bad-1", title: "没正文的" },
        { id: "bad-2", title: "超长", text: "长".repeat(2001) },
        { id: "good-1", title: "好样本", text: "灯火一盏一盏灭下去，他数着自己的脚步声。", createdAtMs: 1 },
      ],
    });

    const pack = await buildWritingContextPack({ projectDir, chapter: 1, userDirection: "第一章" });
    expect(pack.writingRulesContext.styleExemplars.map((item) => item.title)).toEqual(["好样本"]);

    const context = await buildWriterContext({ projectDir, chapter: 1, chapterGoal: "第一章" });
    const prompt = renderFastDraftPromptText(context);
    expect(prompt).toContain("灯火一盏一盏灭下去");
    expect(prompt).not.toContain("没正文的");
  });

  it("注入预算：单条截断 800 字、样本区总量封顶 1600 字（正文 prompt 同步有界）", async () => {
    const projectDir = await createSoulSteelFixture();
    await writeJson(projectDir, "story/writing-rules.json", {
      version: "v0",
      proseStyle: [],
      genreRequirements: [],
      suspenseRules: [],
      payoffRules: [],
      reversalRules: [],
      readerExperienceRules: [],
      forbiddenContent: [],
      doNotDo: [],
      styleExemplars: [
        { id: "ex-1", title: "样本一", text: "一".repeat(900), createdAtMs: 1 },
        { id: "ex-2", title: "样本二", text: "二".repeat(900), createdAtMs: 2 },
        { id: "ex-3", title: "样本三", text: "三".repeat(900), createdAtMs: 3 },
      ],
    });

    const pack = await buildWritingContextPack({ projectDir, chapter: 1, userDirection: "第一章" });
    const items = pack.writingRulesContext.styleExemplars;
    expect(items.map((item) => item.title)).toEqual(["样本一", "样本二"]); // 800+800 后预算耗尽，第三条整条不进
    expect(items[0]?.text).toHaveLength(800);
    expect(items[1]?.text).toHaveLength(800);
    expect(items.reduce((sum, item) => sum + item.text.length, 0)).toBeLessThanOrEqual(1600);

    const context = await buildWriterContext({ projectDir, chapter: 1, chapterGoal: "第一章" });
    const prompt = renderFastDraftPromptText(context);
    expect(prompt).toContain("样本一");
    expect(prompt).toContain("样本二");
    expect(prompt).not.toContain("样本三");
  });

  it("uses the character directory id when legacy state files omit characterId", async () => {
    const projectDir = await createSoulSteelFixture();
    const characterId = toSafeCharacterId("林序");
    await writeJson(projectDir, `characters/${characterId}/state.json`, {
      emotion: "紧张",
      goal: "确认魂钢申请为什么失败",
      relationshipToUser: "普通人起步",
      currentArc: "开篇",
      lastUpdatedChapter: null,
    });

    const pack = await buildWritingContextPack({
      projectDir,
      chapter: 2,
      userDirection: "第二章继续确认魂钢申请异常",
      currentChapterGoal: "第二章继续确认魂钢申请异常",
    });

    expect(pack.protagonistContext).toMatchObject({
      name: "林序",
      currentGoal: "确认魂钢申请为什么失败",
      mentalState: "紧张",
    });
  });

  it("warns when drafts drift from required location or reveal protected truths", async () => {
    const projectDir = await createSoulSteelFixture();
    const pack = await buildWritingContextPack({
      projectDir,
      chapter: 1,
      userDirection: "第一章写魂钢异常反应",
    });

    const issues = checkWritingContextPackDraft([
      "季城市第七中学行政楼里，林序突然知道了魂钢真实来源。",
      "他还确认财团幕后操盘者是谁，并拿到一辆豪车离开。",
      "欠费手机突然正常联网，他打车五分钟就到了市中心，还说自己十八岁。",
    ].join("\n"), pack, 1);

    expect(issues.map((issue) => issue.type)).toEqual(expect.arrayContaining([
      "writing_context_required_location_missing",
      "writing_context_location_drift",
      "writing_context_forbidden_reveal",
      "writing_context_knowledge_boundary",
      // R5b 块3：invented_asset 检测（硬编码豪车/别墅/黑卡/魂钢专名）已移除——题材特定、preview-only 不进正文、不影响成稿。
      "writing_context_travel_rule_violation",
      "writing_context_unavailable_asset_used",
      "writing_context_age_drift",
      "writing_context_identity_detail_drift",
      "writing_context_first_chapter_setup_missing",
    ]));
    expect(issues.find((issue) => issue.type === "writing_context_location_drift")?.message).toContain("季城市");
    expect(issues.find((issue) => issue.type === "writing_context_forbidden_reveal")?.message).toContain("魂钢真实来源");
    expect(issues.find((issue) => issue.type === "writing_context_knowledge_boundary")?.message).toContain("财团幕后操盘者");
  });

  it("warns when building floor descriptions exceed registered location detail", async () => {
    const projectDir = await createSoulSteelFixture();
    const pack = await buildWritingContextPack({
      projectDir,
      chapter: 1,
      userDirection: "第一章写魂钢异常反应",
    });

    const issues = checkWritingContextPackDraft([
      "创业孵化楼是一栋六层建筑，林序站在二楼申请窗口前。",
      "半张魂钢申请表在柜台边缘发热。",
    ].join("\n"), pack, 1);

    expect(issues.map((issue) => issue.type)).toContain("writing_context_floor_structure_conflict");
    expect(issues.find((issue) => issue.type === "writing_context_floor_structure_conflict")?.message).toContain("六层建筑");
  });

  it("does not warn for total floor descriptions already recorded as fixed facts", async () => {
    const projectDir = await createSoulSteelFixture();
    const locationBiblePath = join(projectDir, "story", "location-bible.json");
    const locationBible = JSON.parse(await readFile(locationBiblePath, "utf-8"));
    locationBible.locations[0].fixedFacts = ["该楼共六层"];
    await writeFile(locationBiblePath, `${JSON.stringify(locationBible, null, 2)}\n`, "utf-8");
    const pack = await buildWritingContextPack({
      projectDir,
      chapter: 1,
      userDirection: "第一章写魂钢异常反应",
    });

    const issues = checkWritingContextPackDraft("创业孵化楼是一栋六层建筑，林序站在二楼申请窗口前。", pack, 1);

    expect(issues.map((issue) => issue.type)).not.toContain("writing_context_floor_structure_conflict");
  });

  it("把主角资料卡的 extraFields（做厚）渲染进 protagonistContext，供正文 prompt 取用", async () => {
    const projectDir = await createSoulSteelFixture();
    const biblePath = join(projectDir, "story", "character-bible.json");
    const bible = JSON.parse(await readFile(biblePath, "utf-8"));
    bible.characters[0].extraFields = {
      内核人格: "外冷内热的理想主义者",
      日常锚点: ["随身带半张申请表", "习惯先反问再回答"],
    };
    await writeFile(biblePath, `${JSON.stringify(bible, null, 2)}\n`, "utf-8");

    const pack = await buildWritingContextPack({
      projectDir,
      chapter: 1,
      userDirection: "第一章写魂钢异常反应",
    });

    expect(pack.protagonistContext.extraFields).toEqual(expect.arrayContaining([
      "内核人格：外冷内热的理想主义者",
      "日常锚点：随身带半张申请表、习惯先反问再回答",
    ]));
  });

  it("把配角的关系与做厚特征汇成 supportingCast，主角不在其中", async () => {
    const projectDir = await createSoulSteelFixture();
    const biblePath = join(projectDir, "story", "character-bible.json");
    const bible = JSON.parse(await readFile(biblePath, "utf-8"));
    bible.characters.push({
      id: toSafeCharacterId("沈知夏"),
      name: "沈知夏",
      role: "配角",
      relationshipToProtagonist: "大学同学，暗中受财团指派接近林序",
      relationshipDynamics: ["表面热心帮忙", "关键节点会传递情报给财团"],
      trustLevel: "low",
      extraFields: {
        社交伪装: "热情学姐，实则保持距离",
        情绪外露: "说谎时会反复整理袖口",
      },
    });
    await writeFile(biblePath, `${JSON.stringify(bible, null, 2)}\n`, "utf-8");

    const pack = await buildWritingContextPack({
      projectDir,
      chapter: 1,
      userDirection: "第一章写魂钢异常反应",
    });

    expect(pack.supportingCast.map((cast) => cast.name)).not.toContain("林序");
    const shen = pack.supportingCast.find((cast) => cast.name === "沈知夏");
    expect(shen).toMatchObject({
      name: "沈知夏",
      role: "配角",
      relationToProtagonist: "大学同学，暗中受财团指派接近林序",
      trustLevel: "low",
    });
    expect(shen?.relationshipDynamics).toEqual(expect.arrayContaining(["关键节点会传递情报给财团"]));
    expect(shen?.traits).toEqual(expect.arrayContaining([
      "社交伪装：热情学姐，实则保持距离",
      "情绪外露：说谎时会反复整理袖口",
    ]));
  });

  it("做厚字段与配角关系真进 FastDraft 正文 prompt（链路验证：纸面可见）", async () => {
    const projectDir = await createSoulSteelFixture();
    const biblePath = join(projectDir, "story", "character-bible.json");
    const bible = JSON.parse(await readFile(biblePath, "utf-8"));
    bible.characters[0].extraFields = { 内核人格: "外冷内热的理想主义者" };
    bible.characters.push({
      id: toSafeCharacterId("沈知夏"),
      name: "沈知夏",
      role: "配角",
      relationshipToProtagonist: "大学同学，暗中受财团指派接近林序",
      trustLevel: "low",
      extraFields: { 社交伪装: "热情学姐，实则保持距离" },
    });
    await writeFile(biblePath, `${JSON.stringify(bible, null, 2)}\n`, "utf-8");

    const context = await buildWriterContext({
      projectDir,
      chapter: 1,
      chapterGoal: "第一章写魂钢异常反应",
    });
    const prompt = renderFastDraftPromptText(context);

    expect(prompt).toContain("内核人格");
    expect(prompt).toContain("外冷内热的理想主义者");
    expect(prompt).toContain("沈知夏");
    expect(prompt).toContain("暗中受财团指派接近林序");
    expect(prompt).toContain("社交伪装");
  });

  it("把 fact-ledger 的硬事实注入 continuityFocus.establishedFacts 并到正文 prompt（不得改写）", async () => {
    const projectDir = await createSoulSteelFixture();
    await writeFile(
      join(projectDir, "story", "fact-ledger.json"),
      `${JSON.stringify({ version: "v0", facts: [
        { id: "fact-1-0", chapter: 1, text: "魂钢申请表只有左半张，未补全", source: "auto" },
      ] }, null, 2)}\n`,
      "utf-8",
    );

    const pack = await buildWritingContextPack({ projectDir, chapter: 2, userDirection: "第二章继续" });
    expect(pack.continuityFocus.establishedFacts).toEqual(
      expect.arrayContaining(["第1章：魂钢申请表只有左半张，未补全"]),
    );

    const context = await buildWriterContext({ projectDir, chapter: 2, chapterGoal: "第二章继续" });
    const prompt = renderFastDraftPromptText(context);
    expect(prompt).toContain("魂钢申请表只有左半张，未补全");
    expect(prompt).toContain("不得改写");
  });

  it("早期未收口线索（firstSeenChapter:2）在第50章仍出现在 mustCarryThreads，不被3条近章线索淘汰", async () => {
    // 复现「近章截断」长篇早期记忆塌陷：旧 byLastTouchedDesc.slice(0,3) 把第2章线索砍掉
    const projectDir = await createSoulSteelFixture();
    await writeJson(projectDir, "story/threads.json", {
      version: "v0",
      threads: [
        // 早期未收口线索（第2章出现，至今未触碰）
        {
          id: "thread-early",
          type: "lead",
          title: "借条秘密：赵叔欠下的神秘债务",
          status: "open",
          firstSeenChapter: 2,
          lastTouchedChapter: 2,
          evidence: ["第2章赵叔提过一张未还的借条"],
        },
        // 近章线索（第47/48/49章）
        {
          id: "thread-47",
          type: "lead",
          title: "近章线索A（第47章）",
          status: "open",
          firstSeenChapter: 47,
          lastTouchedChapter: 47,
          evidence: ["第47章新发现"],
        },
        {
          id: "thread-48",
          type: "lead",
          title: "近章线索B（第48章）",
          status: "open",
          firstSeenChapter: 48,
          lastTouchedChapter: 48,
          evidence: ["第48章新发现"],
        },
        {
          id: "thread-49",
          type: "lead",
          title: "近章线索C（第49章）",
          status: "open",
          firstSeenChapter: 49,
          lastTouchedChapter: 49,
          evidence: ["第49章新发现"],
        },
      ],
    });

    const pack = await buildWritingContextPack({
      projectDir,
      chapter: 50,
      userDirection: "第50章继续推进",
    });

    // 早期线索必须出现在 mustCarryThreads 里
    const threadTitles = pack.continuityFocus.mustCarryThreads;
    expect(threadTitles.some((t) => t.includes("借条秘密"))).toBe(true);
  });

  it("已收口线索（status:done）不进 mustCarryThreads，无论章号多近", async () => {
    const projectDir = await createSoulSteelFixture();
    await writeJson(projectDir, "story/threads.json", {
      version: "v0",
      threads: [
        {
          id: "thread-done",
          type: "lead",
          title: "已收口线索（已结案）",
          status: "done",
          firstSeenChapter: 45,
          lastTouchedChapter: 49,
          evidence: ["第49章已收口"],
        },
        {
          id: "thread-open",
          type: "lead",
          title: "开放线索",
          status: "open",
          firstSeenChapter: 48,
          lastTouchedChapter: 48,
          evidence: ["第48章"],
        },
      ],
    });

    const pack = await buildWritingContextPack({
      projectDir,
      chapter: 50,
      userDirection: "第50章",
    });

    expect(pack.continuityFocus.mustCarryThreads.join("\n")).not.toContain("已收口线索");
    expect(pack.continuityFocus.mustCarryThreads.join("\n")).toContain("开放线索");
  });

  it("早期未达成主线目标（firstSeenChapter:3）在第50章仍出现在 arcGoalFocus，不被近章目标淘汰", async () => {
    const projectDir = await createSoulSteelFixture();
    await writeJson(projectDir, "story/arc-goals.json", {
      version: "v0",
      goals: [
        // 早期主线目标（第3章出现，至今 active）
        {
          id: "goal-early",
          title: "查清魂钢申请异常的真相（第3章起）",
          status: "active",
          scope: "main_arc",
          firstSeenChapter: 3,
          lastTouchedChapter: 3,
          evidence: ["第3章设定"],
        },
        // 近章目标（第47/48章）
        {
          id: "goal-47",
          title: "近章目标A（第47章）",
          status: "active",
          scope: "mini_arc",
          firstSeenChapter: 47,
          lastTouchedChapter: 47,
          evidence: ["第47章"],
        },
        {
          id: "goal-48",
          title: "近章目标B（第48章）",
          status: "active",
          scope: "mini_arc",
          firstSeenChapter: 48,
          lastTouchedChapter: 48,
          evidence: ["第48章"],
        },
        {
          id: "goal-49",
          title: "近章目标C（第49章）",
          status: "active",
          scope: "mini_arc",
          firstSeenChapter: 49,
          lastTouchedChapter: 49,
          evidence: ["第49章"],
        },
      ],
    });

    const pack = await buildWritingContextPack({
      projectDir,
      chapter: 50,
      userDirection: "第50章继续推进",
    });

    // 早期主线目标必须出现在 arcGoalFocus 里
    const goalFocus = pack.continuityFocus.arcGoalFocus;
    expect(goalFocus.some((g) => g.includes("查清魂钢申请异常"))).toBe(true);
  });
});

async function createSoulSteelFixture(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "story-engine-writing-context-"));
  const { projectDir } = await createStoryProject({
    rootDir,
    title: "海天魂钢",
    genre: "都市英灵 / 创业魂钢",
    premise: "普通毕业生林序在毕业失败当天第一次接触魂钢异常反应。",
    mainCharacterName: "林序",
  });
  const characterId = toSafeCharacterId("林序");
  await Promise.all([
    writeJson(projectDir, "story/bible.json", {
      version: "v0",
      projectLogline: "普通毕业生林序在毕业失败当天第一次接触魂钢异常反应。",
      premise: "普通毕业生林序在毕业失败当天第一次接触魂钢异常反应。",
      genre: "都市英灵 / 创业魂钢",
      subgenres: [],
      readerPromise: "普通人从资源不足和信息有限的起点，逐步确认魂钢异常背后的阶层真相。",
      longFormGoals: ["林序查清魂钢申请异常，并拿到真正进入觉醒体系的入口。"],
      centralConflicts: ["普通毕业生与财团垄断觉醒机会之间的冲突"],
      coreMysteries: ["魂钢真实来源", "财团幕后操盘者", "主角潜力真实等级"],
      forbiddenChanges: ["不要让主角突然开挂"],
      canonFacts: [],
      openQuestions: [],
      protectedSecrets: ["魂钢真实来源", "财团幕后操盘者", "主角潜力真实等级"],
      setupAssets: {
        initialAssets: ["旧笔记本电脑", "公交卡", "欠费手机", "半张魂钢申请表"],
        keyItems: ["半张魂钢申请表"],
        resourceLimits: ["手机欠费", "现金不足", "没有正式魂钢资格"],
      },
      firstChapterSetup: {
        goal: "毕业失败当天，林序第一次接触魂钢异常反应",
        openingScene: "海天市旧城区创业孵化楼",
        hook: "半张魂钢申请表出现异常发热",
        conflict: "林序被告知申请失败，但魂钢检测仪对他的残缺申请表有异常反应",
      },
    }),
    writeJson(projectDir, "story/writing-rules.json", {
      version: "v0",
      narrativePerspective: "第三人称有限视角",
      proseStyle: ["克制", "紧张", "细节扎实"],
      chapterLength: { targetWords: 1800 },
      pacing: "中等偏快",
      revealPolicy: "只让主角知道亲眼看到和推理得到的信息",
      genreRequirements: ["普通人起步，不开挂"],
      suspenseRules: [],
      payoffRules: [],
      reversalRules: [],
      readerExperienceRules: ["底层普通人识破城市规则并稳步翻盘"],
      forbiddenContent: ["不要提前揭开魂钢真实来源"],
      doNotDo: ["不要让主角突然获得高级能力"],
    }),
    writeJson(projectDir, "story/character-bible.json", {
      version: "v0",
      characters: [{
        id: characterId,
        name: "林序",
        role: "主角",
        age: "22岁",
        identity: "普通毕业生",
        desire: "拿到一次公平的觉醒机会",
        fear: "被城市系统永久判定为无用者",
        weakness: "普通人起步，不开挂，信息有限，前期资源不足",
        behaviorBoundaries: ["不能突然掌握魂钢真相", "不能立刻拥有高级英灵能力"],
        knowledgeKnown: ["魂钢会影响毕业后的资源分配", "财团掌握主要申请渠道"],
        knowledgeUnknown: ["魂钢真实来源", "财团幕后操盘者", "主角潜力真实等级"],
        speechRules: ["克制，先观察再反问。"],
        speechStyle: "克制，先观察再反问。",
        speechSamples: ["先排着，不代表我认了。", "我只问一个问题：规则写在哪儿？"],
        cannotDo: ["不能突然掌握魂钢真相"],
      }],
    }),
    writeJson(projectDir, "story/world-bible.json", {
      version: "v0",
      rules: ["创业魂钢决定城市阶层、资源分配和英灵能力"],
      factions: [{ id: "f-corp", name: "财团", goal: "垄断觉醒机会", resources: ["魂钢申请渠道"] }],
      powerOrSurvivalSystems: ["创业魂钢"],
      historyFacts: [],
      socialOrder: ["财团控制魂钢申请渠道", "毕业生按魂钢适配度进入不同阶层"],
    }),
    writeJson(projectDir, "story/location-bible.json", {
      version: "v0",
      locations: [{
        id: "loc-incubator",
        name: "海天市旧城区创业孵化楼",
        type: "初始地点",
        locationType: "城市建筑",
        spatialStructure: {
          floors: ["1楼大厅", "2楼申请窗口", "3楼办公区"],
          rooms: ["毕业申请窗口", "公共查询终端区"],
          entrances: ["旧城区正门"],
          exits: ["一楼大厅侧门"],
        },
        travelRules: [
          { targetLocation: "1楼大厅", method: "stairs", durationMinutes: 1, constraint: "2楼申请窗口到1楼大厅只能走楼梯或电梯。" },
          { targetLocation: "旧城区公交站", method: "walk", durationMinutes: 6 },
          { targetLocation: "市中心", method: "taxi", durationMinutes: 25, constraint: "现金不足时不能随便打车。" },
        ],
        knownFeatures: ["老旧办公楼", "魂钢申请窗口"],
        risks: ["孵化楼的魂钢检测设备可能被财团监控"],
        resources: ["公共查询终端"],
        fixedFacts: ["2楼有申请窗口", "3楼是办公区"],
      }],
    }),
    writeJson(projectDir, "story/assets.json", {
      version: "v0",
      assets: [
        { id: "asset-laptop", name: "旧笔记本电脑", type: "item", ownerCharacterId: characterId, ownerName: "林序", carriedByCharacterId: characterId, status: "available", isPlotCritical: false, canAiModify: false },
        { id: "asset-bus-card", name: "公交卡", type: "money", ownerCharacterId: characterId, ownerName: "林序", carriedByCharacterId: characterId, status: "available", isPlotCritical: false, canAiModify: false },
        { id: "asset-phone", name: "欠费手机", type: "keyItem", ownerCharacterId: characterId, ownerName: "林序", carriedByCharacterId: characterId, status: "locked", conditionNote: "欠费三天，不能正常联网", isPlotCritical: true, canAiModify: false, rules: ["欠费手机不能突然正常联网。"] },
        { id: "asset-half-form", name: "半张魂钢申请表", type: "document", ownerCharacterId: characterId, ownerName: "林序", carriedByCharacterId: characterId, status: "damaged", conditionNote: "只有左半张", isPlotCritical: true, canAiModify: false, rules: ["半张魂钢申请表不能凭空变成完整申请表。"] },
      ],
      containers: [],
    }),
    writeJson(projectDir, `characters/${characterId}/profile.json`, {
      id: characterId,
      name: "林序",
      identity: "普通毕业生",
      age: "22岁",
      appearance: {},
      tags: ["main-character"],
    }),
    writeJson(projectDir, `characters/${characterId}/state.json`, {
      characterId,
      emotion: "紧张",
      goal: "确认魂钢申请为什么失败",
      relationshipToUser: "普通人起步",
      currentArc: "开篇",
      lastUpdatedChapter: null,
    }),
    writeJson(projectDir, "world/core.json", {
      genre: "都市英灵 / 创业魂钢",
      premise: "创业魂钢决定城市阶层、资源分配和英灵能力，财团垄断觉醒机会。",
      rules: ["创业魂钢决定城市阶层、资源分配和英灵能力"],
      mainConflict: "普通毕业生很难获得魂钢，财团垄断觉醒机会",
    }),
    writeJson(projectDir, "world/state.json", {
      currentPhase: "开篇",
      activeConflicts: ["普通毕业生很难获得魂钢，财团垄断觉醒机会"],
      activeHooks: [],
      knownSecrets: [],
      lastUpdatedChapter: null,
    }),
  ]);
  return projectDir;
}

async function writeJson(projectDir: string, relativePath: string, value: unknown): Promise<void> {
  await writeFile(join(projectDir, relativePath), `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}
