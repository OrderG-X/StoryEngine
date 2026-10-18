// @vitest-environment node
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyFoundationWriteSuggestion } from "./foundation-write-gateway.js";
import type { FoundationWriteRecord } from "./foundation-write-gateway.js";
import { applyFoundationGapDecisions, buildFoundationGapApplyPlan } from "./foundation-gap-assistant.js";
import type { FoundationGapSuggestion } from "./foundation-gap-assistant.js";
import { createStoryProject, toSafeCharacterId } from "./project-store.js";
import type { AssetLedger, CharacterState, LocationBible, WorldState } from "./types.js";

describe("foundation writes land after.extraFields with newExtraFields report", () => {
  it("creates a character and lands extraFields into the character state card", async () => {
    const { projectDir } = await createProject("创建带自定义字段角色");

    const suggestion = {
      actionType: "create_character",
      category: "characters",
      targetFile: "story/character-bible.json",
      targetPath: "characters",
      after: {
        name: "林晚",
        role: "重要配角",
        identity: "雷宗成员",
        behaviorBoundaries: ["不会越级斩杀金丹"],
        extraFields: { 境界: "金丹期", 功法: ["奔雷诀", "云隐步"] },
      },
      extractedEntityName: "林晚",
      sourceUserMessage: "林晚突破金丹期了，主修奔雷诀、云隐步。",
    };

    const result = await applyFoundationWriteSuggestion({ projectDir, suggestion });
    expect(result.applied).toBe(true);

    const charId = toSafeCharacterId("林晚");
    const state = await readJson<CharacterState>(projectDir, `characters/${charId}/state.json`);
    expect(state.extraFields?.["境界"]).toBe("金丹期");
    expect(state.extraFields?.["功法"]).toEqual(["奔雷诀", "云隐步"]);

    const record = findRecord(result.writes, (item) => item.targetFile.endsWith("state.json"));
    expect(record?.newExtraFields).toEqual(expect.arrayContaining(["境界", "功法"]));
    expect(record?.newExtraFields).toHaveLength(2);
  });

  it("merges extraFields additively on character update and only reports newly created keys", async () => {
    const { projectDir } = await createProject("更新角色自定义字段", "林远");
    const charId = toSafeCharacterId("林远");

    // 预置一个 state，含已有 extraFields 和内置字段
    await writeJson(projectDir, `characters/${charId}/state.json`, {
      characterId: charId,
      emotion: "平静",
      goal: "查清真相",
      knowledgeKnown: ["集团行政流程"],
      extraFields: { 境界: "筑基", 灵根: "天灵根" },
      lastUpdatedChapter: null,
    });

    const suggestion = {
      actionType: "update_character_detail",
      category: "characters",
      targetFile: "story/character-bible.json",
      targetPath: "characters",
      targetId: charId,
      after: {
        identity: "雷宗真传",
        extraFields: { 境界: "金丹期", 灵根: "五行杂灵根", 体质: "先天道体" },
      },
      extractedEntityName: "林远",
      sourceUserMessage: "林远突破金丹期，灵根其实是五行杂灵根，还觉醒了先天道体。",
    };

    const result = await applyFoundationWriteSuggestion({ projectDir, suggestion });
    expect(result.applied).toBe(true);

    const state = await readJson<CharacterState>(projectDir, `characters/${charId}/state.json`);
    // 同名键被新值覆盖
    expect(state.extraFields?.["境界"]).toBe("金丹期");
    expect(state.extraFields?.["灵根"]).toBe("五行杂灵根");
    // 新键加入
    expect(state.extraFields?.["体质"]).toBe("先天道体");
    // 已有的内置字段不被抹掉
    expect(state.emotion).toBe("平静");
    expect(state.goal).toBe("查清真相");
    expect(state.knowledgeKnown).toEqual(["集团行政流程"]);

    const record = findRecord(result.writes, (item) => item.targetFile.endsWith("state.json"));
    // 只有体质是新建键；境界、灵根原本就有
    expect(record?.newExtraFields).toEqual(["体质"]);
  });

  it("lands extraFields onto a location card", async () => {
    const { projectDir } = await createProject("地点自定义字段");

    const result = await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "create_location",
        category: "locations",
        targetFile: "story/location-bible.json",
        targetPath: "locations",
        after: {
          id: "loc-thunder-peak",
          name: "雷霆峰",
          type: "组织要地",
          extraFields: { 灵气浓度: "极盛", 禁制: ["五雷禁阵", "锁灵阵"] },
        },
      },
    });

    const bible = await readJson<LocationBible>(projectDir, "story/location-bible.json");
    const location = bible.locations.find((item) => item.id === "loc-thunder-peak");
    expect(location?.extraFields?.["灵气浓度"]).toBe("极盛");
    expect(location?.extraFields?.["禁制"]).toEqual(["五雷禁阵", "锁灵阵"]);

    const record = findRecord(result.writes, (item) => item.domain === "location");
    expect(record?.newExtraFields).toEqual(expect.arrayContaining(["灵气浓度", "禁制"]));
  });

  it("lands extraFields onto an asset card", async () => {
    const { projectDir } = await createProject("资产自定义字段");

    const result = await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "update_asset_status",
        category: "assets",
        targetFile: "story/assets.json",
        targetPath: "assets",
        targetId: "asset-thunder-sword",
        after: {
          id: "asset-thunder-sword",
          name: "奔雷剑",
          type: "keyItem",
          status: "available",
          extraFields: { 品阶: "灵器", 附魔: ["雷属性", "破甲"] },
        },
      },
    });

    const ledger = await readJson<AssetLedger>(projectDir, "story/assets.json");
    const asset = ledger.assets.find((item) => item.id === "asset-thunder-sword");
    expect(asset?.extraFields?.["品阶"]).toBe("灵器");
    expect(asset?.extraFields?.["附魔"]).toEqual(["雷属性", "破甲"]);

    const record = findRecord(result.writes, (item) => item.domain === "asset");
    expect(record?.newExtraFields).toEqual(expect.arrayContaining(["品阶", "附魔"]));
  });

  it("normalizes string-valued create_asset list fields and survives the buildStateOverview readback", async () => {
    // 真机根因（Codex 第六轮）：模型给 create_asset 时常把 rules/usageRules/lossRules/notes 给成
    // 单个字符串而非数组。create 路径原先原样落盘 → 紧接着 applyFoundationGapDecisions 内的
    // buildStateOverview 读回做 (asset.rules ?? []).map(...) 在字符串上炸 → catch 回滚全部 → 整批 500。
    const { projectDir } = await createProject("资产 list 字段字符串规整");

    const suggestion: FoundationGapSuggestion = {
      id: "asset-string-rules",
      gapId: "gap-extra",
      category: "assets",
      actionType: "create_asset",
      targetFile: "story/assets.json",
      targetPath: "assets",
      before: undefined,
      after: {
        id: "asset-jade-token",
        name: "玉牌",
        type: "keyItem",
        status: "available",
        rules: "不能凭空充值", // 字符串而非数组
        notes: "祖传之物", // 字符串而非数组
      },
      rationale: "测试 create_asset list 字段字符串规整",
      risk: "info",
      requiresUserConfirm: true,
      extractedEntityName: "玉牌",
    };

    // 不抛 + applied:true 即证明 buildStateOverview 读回不再崩、整批不再被拖垮成 500。
    const result = await applyFoundationGapDecisions(
      projectDir,
      [{ suggestionId: suggestion.id, decision: "accept" }],
      [suggestion],
    );
    expect(result.applied).toBe(true);
    expect(result.writes.length).toBeGreaterThan(0);

    const ledger = await readJson<AssetLedger>(projectDir, "story/assets.json");
    const asset = ledger.assets.find((item) => item.id === "asset-jade-token");
    // 单字符串被捕获成数组（数据不丢），而非原样字符串。
    expect(asset?.rules).toEqual(["不能凭空充值"]);
    expect(asset?.notes).toEqual(["祖传之物"]);
  });

  it("does not throw on a create_asset whose after is null (guards the destructure)", async () => {
    const { projectDir } = await createProject("create_asset after 为 null");

    const suggestion: FoundationGapSuggestion = {
      id: "asset-null-after",
      gapId: "gap-extra",
      category: "assets",
      actionType: "create_asset",
      targetFile: "story/assets.json",
      targetPath: "assets",
      before: undefined,
      after: null,
      rationale: "测试 after 为 null 时不裸解构抛错",
      risk: "info",
      requiresUserConfirm: true,
      extractedEntityName: "无名物",
    };

    // 以前 applyCreateAsset 裸解构 normalizeAssetPatch(null) 抛 Cannot destructure；现在不该抛。
    await expect(
      applyFoundationGapDecisions(
        projectDir,
        [{ suggestionId: suggestion.id, decision: "accept" }],
        [suggestion],
      ),
    ).resolves.toBeDefined();
  });

  it("lands world extraFields into world/state.json so the prompt can read them", async () => {
    const { projectDir } = await createProject("世界观自定义字段");

    const result = await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "update_world_rule",
        category: "world",
        targetFile: "story/world-bible.json",
        targetPath: "rules",
        after: {
          rules: ["雷宗禁止成员私下斗法"],
          extraFields: { 大劫倒计时: "三百年", 灵气复苏阶段: "初期" },
        },
      },
    });

    const worldState = await readJson<WorldState>(projectDir, "world/state.json");
    expect(worldState.extraFields?.["大劫倒计时"]).toBe("三百年");
    expect(worldState.extraFields?.["灵气复苏阶段"]).toBe("初期");

    const record = findRecord(result.writes, (item) => item.newExtraFields !== undefined && item.newExtraFields.length > 0);
    expect(record?.newExtraFields).toEqual(expect.arrayContaining(["大劫倒计时", "灵气复苏阶段"]));
  });

  it("includes world/state.json in the rollback backup set when a batch carries world-rule extraFields", async () => {
    const { projectDir } = await createProject("世界观字段回滚备份");

    const worldRuleSuggestion: FoundationGapSuggestion = {
      id: "extra-world-rule",
      gapId: "gap-world",
      category: "world",
      actionType: "update_world_rule",
      targetFile: "story/world-bible.json",
      targetPath: "rules",
      before: undefined,
      after: {
        rules: ["雷宗禁止成员私下斗法"],
        extraFields: { 大劫倒计时: "三百年" },
      },
      rationale: "测试世界观自定义字段回滚",
      risk: "info",
      requiresUserConfirm: true,
    };

    // 回滚使用 plan.fileChanges 构建备份集（applyFoundationGapDecisions 只回滚被备份的文件）。
    // world-rule 的 extraFields 落到 world/state.json，所以该文件必须出现在备份集里，
    // 否则同批后续写入失败回滚时它会残留孤儿 extraFields。
    const plan = await buildFoundationGapApplyPlan(
      projectDir,
      [{ suggestionId: worldRuleSuggestion.id, decision: "accept" }],
      [worldRuleSuggestion],
    );
    const backedUpFiles = plan.fileChanges.map((change) => change.targetFile);
    expect(backedUpFiles).toContain("world/state.json");
    expect(backedUpFiles).toContain("story/world-bible.json");
  });

  it("lands extraFields on an existing character via update_character_detail when targetId is backfilled", async () => {
    // 模拟解析器回填 targetId 后的归档：项目里已有「林远」，update_character_detail 带回填的真实 id。
    const { projectDir } = await createProject("回填后更新角色字段", "林远");
    const charId = toSafeCharacterId("林远");

    const suggestion: FoundationGapSuggestion = {
      id: "extra-update-guoxu",
      gapId: "gap-extra",
      category: "characters",
      actionType: "update_character_detail",
      targetFile: "story/character-bible.json",
      targetPath: "characters",
      targetId: charId,
      before: { name: "林远" },
      after: { extraFields: { 境界: "金丹期" } },
      rationale: "测试回填 targetId 后真正落盘",
      risk: "info",
      requiresUserConfirm: true,
      extractedEntityName: "林远",
    };

    const result = await applyFoundationGapDecisions(
      projectDir,
      [{ suggestionId: suggestion.id, decision: "accept" }],
      [suggestion],
    );

    expect(result.applied).toBe(true);
    expect(result.writes.length).toBeGreaterThan(0);

    const state = await readJson<CharacterState>(projectDir, `characters/${charId}/state.json`);
    expect(state.extraFields?.["境界"]).toBe("金丹期");
  });

  it("does not silently succeed when update_character_detail cannot locate its target", async () => {
    // 护栏（修2）：缺 targetId 的 update_character_detail 不能装作「啥也没要写」，
    // 要让上层 applied=false 且能区分「因目标缺失而跳过」。
    const { projectDir } = await createProject("缺目标静默失败护栏", "林远");

    const suggestion: FoundationGapSuggestion = {
      id: "extra-update-missing-target",
      gapId: "gap-extra",
      category: "characters",
      actionType: "update_character_detail",
      targetFile: "story/character-bible.json",
      targetPath: "characters",
      // 故意不给 targetId：解析器没能回填（模型只给了 before.name 但项目没有匹配角色）
      before: { name: "查无此人" },
      after: { extraFields: { 境界: "金丹期" } },
      rationale: "测试缺目标时的诚实失败",
      risk: "info",
      requiresUserConfirm: true,
    };

    const result = await applyFoundationGapDecisions(
      projectDir,
      [{ suggestionId: suggestion.id, decision: "accept" }],
      [suggestion],
    );

    expect(result.applied).toBe(false);
    expect(result.writes).toHaveLength(0);
    // 显式信号：跳过的写入要被记录，而不是无声消失。
    expect(result.skippedWrites?.length ?? 0).toBeGreaterThan(0);
    expect(result.skippedWrites?.[0]?.suggestionId).toBe("extra-update-missing-target");
    // 这条压根没给 targetId（解析器也回填不到），属于 missing_target_id。
    expect(result.skippedWrites?.[0]?.reason).toBe("missing_target_id");
    expect(result.skippedWrites?.[0]?.summary).toContain("未写入任何内容");
  });

  it("flags target_not_found when a targetId points at a nonexistent character", async () => {
    // 区分 missing_target_id 与 target_not_found：这条给了 targetId 但角色册里没有。
    const { projectDir } = await createProject("targetId 指向不存在角色", "林远");

    const suggestion: FoundationGapSuggestion = {
      id: "extra-update-bad-id",
      gapId: "gap-extra",
      category: "characters",
      actionType: "update_character_detail",
      targetFile: "story/character-bible.json",
      targetPath: "characters",
      targetId: "char-does-not-exist",
      before: { name: "林晚" },
      after: { extraFields: { 境界: "金丹期" } },
      rationale: "测试 targetId 找不到角色",
      risk: "info",
      requiresUserConfirm: true,
    };

    const result = await applyFoundationGapDecisions(
      projectDir,
      [{ suggestionId: suggestion.id, decision: "accept" }],
      [suggestion],
    );

    expect(result.applied).toBe(false);
    expect(result.writes).toHaveLength(0);
    expect(result.skippedWrites?.[0]?.reason).toBe("target_not_found");
  });

  it("surfaces newExtraFields through applyFoundationGapDecisions writes", async () => {
    const { projectDir } = await createProject("端到端归档自定义字段");
    const charId = toSafeCharacterId("林晚");

    const extraSuggestion: FoundationGapSuggestion = {
      id: "extra-create-lin-wan",
      gapId: "gap-extra",
      category: "characters",
      actionType: "create_character",
      targetFile: "story/character-bible.json",
      targetPath: "characters",
      targetId: charId,
      before: undefined,
      after: {
        name: "林晚",
        role: "重要配角",
        identity: "雷宗成员",
        extraFields: { 境界: "金丹期" },
      },
      rationale: "测试自定义字段端到端落盘",
      risk: "info",
      requiresUserConfirm: true,
      extractedEntityName: "林晚",
    };

    const result = await applyFoundationGapDecisions(
      projectDir,
      [{ suggestionId: extraSuggestion.id, decision: "accept" }],
      [extraSuggestion],
    );

    expect(result.applied).toBe(true);
    const stateRecord = findRecord(result.writes, (item) => item.targetFile.endsWith("state.json"));
    expect(stateRecord?.newExtraFields).toEqual(["境界"]);

    const state = await readJson<CharacterState>(projectDir, `characters/${charId}/state.json`);
    expect(state.extraFields?.["境界"]).toBe("金丹期");
  });

  it("isolates a throwing suggestion so the rest of the batch still writes (no all-or-nothing 500)", async () => {
    // 韧性（Part 2）：混合批里一条 applySuggestion 写入期抛错不能把整批拖垮成 500/全回滚。
    // 制造确定性抛错：把已有角色「林远」的 core.json 写坏，update_character_detail 林远 在写入期 readJson(core) 抛
    // SyntaxError（classify 放行、buildStateOverview 用 readJsonSafe 不受影响）。同批再 create 一个新角色「赵磊」。
    // 期望：赵磊 照常写入（applied:true），林远 这条记成 apply_failed；且回滚不能把同写 character-bible.json 的
    // 赵磊 一起抹掉（验「按当前快照逐条回滚」而非「按批前回滚」）。
    const { projectDir } = await createProject("逐条隔离不整批崩", "林远");
    const guoxuId = toSafeCharacterId("林远");
    await mkdir(join(projectDir, "characters", guoxuId), { recursive: true });
    await writeFile(join(projectDir, "characters", guoxuId, "core.json"), "{{{ 这不是合法 JSON", "utf-8");

    const goodSuggestion: FoundationGapSuggestion = {
      id: "good-create-zhaolei",
      gapId: "gap-extra",
      category: "characters",
      actionType: "create_character",
      targetFile: "story/character-bible.json",
      targetPath: "characters",
      targetId: toSafeCharacterId("赵磊"),
      before: undefined,
      after: { name: "赵磊", role: "配角", identity: "镇上铁匠" },
      rationale: "能写的那条",
      risk: "info",
      requiresUserConfirm: true,
      extractedEntityName: "赵磊",
    };

    const throwingSuggestion: FoundationGapSuggestion = {
      id: "throwing-update-guoxu",
      gapId: "gap-extra",
      category: "characters",
      actionType: "update_character_detail",
      targetFile: "story/character-bible.json",
      targetPath: "characters",
      targetId: guoxuId,
      before: { name: "林远" },
      after: { identity: "改个身份触发写入" },
      rationale: "写入期读坏掉的 core.json 会抛错的那条",
      risk: "info",
      requiresUserConfirm: true,
      extractedEntityName: "林远",
    };

    const result = await applyFoundationGapDecisions(
      projectDir,
      [
        { suggestionId: goodSuggestion.id, decision: "accept" },
        { suggestionId: throwingSuggestion.id, decision: "accept" },
      ],
      [goodSuggestion, throwingSuggestion],
    );

    // 好的那条真写进去（applied:true），坏的那条记成 apply_failed，而不是整批 500/回滚。
    expect(result.applied).toBe(true);
    const bible = await readJson<{ characters: { name?: string }[] }>(projectDir, "story/character-bible.json");
    expect(bible.characters.some((item) => item.name === "赵磊")).toBe(true);
    expect(
      result.skippedWrites?.some(
        (skip) => skip.suggestionId === "throwing-update-guoxu" && skip.reason === "apply_failed",
      ),
    ).toBe(true);
  });
});

function findRecord(
  writes: readonly FoundationWriteRecord[],
  predicate: (record: FoundationWriteRecord) => boolean,
): FoundationWriteRecord | undefined {
  return writes.find(predicate);
}

async function createProject(title: string, mainCharacterName = "林远"): Promise<{ readonly projectDir: string }> {
  const rootDir = await mkdtemp(join(tmpdir(), "story-engine-extra-fields-write-"));
  return createStoryProject({
    rootDir,
    title,
    genre: "xianxia",
    premise: "主角从杂役弟子逆袭。",
    mainCharacterName,
  });
}

async function readJson<T>(projectDir: string, relativePath: string): Promise<T> {
  return JSON.parse(await readFile(join(projectDir, relativePath), "utf-8")) as T;
}

async function writeJson(projectDir: string, relativePath: string, value: unknown): Promise<void> {
  await writeFile(join(projectDir, relativePath), `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}
