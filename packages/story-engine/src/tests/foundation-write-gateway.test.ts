import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyFoundationWriteSuggestion, targetFilesForFoundationWriteSuggestion } from "../foundation-write-gateway.js";
import { createStoryProject, toSafeCharacterId } from "../project-store.js";
import type { AssetLedger, CharacterBible, CharacterCore, CharacterProfile, CharacterState, LocationBible, WorldBible, WritingRules } from "../types.js";

describe("foundation write gateway", () => {
  it("writes character data only into the active projectDir", async () => {
    const { projectDir: projectA } = await createProject("A 书");
    const { projectDir: projectB } = await createProject("B 书");

    const suggestion = {
      actionType: "create_character",
      targetFile: "story/character-bible.json",
      targetPath: "characters",
      after: {
        name: "苏晓薇",
        role: "重要配角",
        age: "28",
        identity: "远山集团秘书",
        speechStyle: "克制、职业化",
        behaviorBoundaries: ["不会越权替林远做决定"],
        knowledgeKnown: ["知道集团行政流程"],
        knowledgeUnknown: ["不知道陌生电话来源"],
      },
      extractedEntityName: "苏晓薇",
    };

    const result = await applyFoundationWriteSuggestion({ projectDir: projectA, suggestion });

    expect(result.applied).toBe(true);
    expect(result.projectDir).toBe(projectA);
    expect(result.writtenFiles).toEqual([
      "story/character-bible.json",
      "characters/char-c4bc64/profile.json",
      "characters/char-c4bc64/core.json",
      "characters/char-c4bc64/state.json",
    ]);
    const bibleA = await readJson<CharacterBible>(projectA, "story/character-bible.json");
    const bibleB = await readJson<CharacterBible>(projectB, "story/character-bible.json");
    expect(bibleA.characters.some((character) => character.name === "苏晓薇")).toBe(true);
    expect(bibleB.characters.some((character) => character.name === "苏晓薇")).toBe(false);
    await expect(readFile(join(projectA, "characters", "char-c4bc64", "profile.json"), "utf-8")).resolves.toContain("苏晓薇");
  });

  it("writes location, world, writing rules, and assets through one gateway", async () => {
    const { projectDir } = await createProject("统一写入测试");

    await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "fill_missing_field",
        category: "story",
        targetFile: "project.json",
        targetPath: "title",
        after: "统一写入测试改名",
        writeMode: "replace",
      },
    });
    await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "create_location",
        category: "locations",
        targetFile: "story/location-bible.json",
        targetPath: "locations",
        after: {
          id: "loc-board-room",
          name: "董事会会议室",
          type: "集团空间",
          floors: ["42层"],
          rooms: ["长桌会议室"],
          narrativeFunction: "让林远第一次面对董事会压力",
          risks: ["信息差"],
        },
      },
    });
    await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "update_world_rule",
        category: "world",
        targetFile: "story/world-bible.json",
        targetPath: "rules",
        after: {
          rules: ["远山集团董事会拥有继承人任命前的临时否决权"],
          socialOrder: ["集团内部按董事会、秘书处、行政部形成权力层级"],
        },
      },
    });
    await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "update_writing_rule",
        category: "writingRules",
        targetFile: "story/writing-rules.json",
        targetPath: "doNotDo",
        after: {
          doNotDo: ["不要把主角写成突然全知全能"],
          proseStyle: ["克制"],
        },
      },
    });
    await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "update_writing_rule",
        category: "writingRules",
        targetFile: "story/writing-rules.json",
        targetPath: "$",
        after: {
          replaceArrays: {
            proseStyle: ["冷静克制"],
          },
        },
      },
    });
    await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "update_writing_rule",
        category: "writingRules",
        targetFile: "story/writing-rules.json",
        targetPath: "doNotDo",
        after: {
          removeFromArrays: {
            doNotDo: ["不要把主角写成突然全知全能"],
          },
        },
      },
    });
    await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "update_asset_status",
        category: "assets",
        targetFile: "story/assets.json",
        targetPath: "assets",
        targetId: "asset-black-card",
        after: {
          id: "asset-black-card",
          name: "黑色权限卡",
          type: "keyItem",
          status: "available",
          rules: ["只能开启集团授权区域"],
        },
      },
    });

    const locations = await readJson<LocationBible>(projectDir, "story/location-bible.json");
    const project = await readJson<{ readonly title: string }>(projectDir, "project.json");
    const world = await readJson<WorldBible>(projectDir, "story/world-bible.json");
    const rules = await readJson<WritingRules>(projectDir, "story/writing-rules.json");
    const assets = await readJson<AssetLedger>(projectDir, "story/assets.json");
    expect(locations.locations.map((location) => location.name)).toContain("董事会会议室");
    expect(project.title).toBe("统一写入测试改名");
    expect(world.rules).toContain("远山集团董事会拥有继承人任命前的临时否决权");
    expect(rules.doNotDo).not.toContain("不要把主角写成突然全知全能");
    expect(rules.proseStyle).toEqual(["冷静克制"]);
    expect(assets.assets.map((asset) => asset.name)).toContain("黑色权限卡");
  });

  it("create_location 用明确 after.name 创建新地点，不让重复占位 targetId 把多地点合并成一条", async () => {
    const { projectDir } = await createProject("多地点建卡");

    for (const name of ["旧城档案馆", "钟表铺", "废弃地铁站", "盛远资本旧楼"]) {
      const result = await applyFoundationWriteSuggestion({
        projectDir,
        suggestion: {
          actionType: "create_location",
          category: "locations",
          targetFile: "story/location-bible.json",
          targetPath: "locations",
          targetId: "待确认地点",
          after: {
            name,
            type: "都市悬疑场景",
            narrativeFunction: `${name}承载关键线索`,
          },
        },
      });
      expect(result.applied).toBe(true);
    }

    const locations = await readJson<LocationBible>(projectDir, "story/location-bible.json");
    expect(locations.locations.map((location) => location.name).sort()).toEqual([
      "废弃地铁站",
      "旧城档案馆",
      "盛远资本旧楼",
      "钟表铺",
    ]);
    expect(new Set(locations.locations.map((location) => location.id)).size).toBe(4);
    expect(locations.locations.some((location) => location.id === "待确认地点")).toBe(false);
  });

  it("create_location 可用 extractedEntityName 建卡，真缺名称时诚实跳过不落占位地点", async () => {
    const { projectDir } = await createProject("地点名兜底");

    const named = await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "create_location",
        category: "locations",
        targetFile: "story/location-bible.json",
        targetPath: "locations",
        targetId: "待确认地点",
        extractedEntityName: "北塔楼梯间",
        after: {
          type: "转场地点",
          narrativeFunction: "通往关键保管间",
        },
      },
    });
    expect(named.applied).toBe(true);

    const missing = await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "create_location",
        category: "locations",
        targetFile: "story/location-bible.json",
        targetPath: "locations",
        targetId: "待确认地点",
        after: {
          type: "地点",
        },
      },
    });
    expect(missing.applied).toBe(false);
    expect(missing.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: "missing_name", action: "create_location" }),
    ]));

    const locations = await readJson<LocationBible>(projectDir, "story/location-bible.json");
    expect(locations.locations.map((location) => location.name)).toEqual(["北塔楼梯间"]);
    expect(locations.locations[0]?.id).not.toBe("待确认地点");
  });

  it("模型把嵌套 removeFromArrays 整块字符串化 → 仍正确删除（不静默吞纠错·readRemovalMap 先 JSON.parse）", async () => {
    const { projectDir } = await createProject("字符串化纠错");
    await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "update_writing_rule", category: "writingRules", targetFile: "story/writing-rules.json", targetPath: "doNotDo",
        after: { doNotDo: ["不要把主角写成突然全知全能"] },
      },
    });
    // 模型把嵌套对象整块发成字符串（after.removeFromArrays:"{...}"）——旧逻辑见 string→非 record→静默返 {} 吞掉纠错。
    const result = await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "update_writing_rule", category: "writingRules", targetFile: "story/writing-rules.json", targetPath: "doNotDo",
        after: { removeFromArrays: JSON.stringify({ doNotDo: ["不要把主角写成突然全知全能"] }) },
      },
    });
    expect(result.applied).toBe(true);
    const rules = await readJson<WritingRules>(projectDir, "story/writing-rules.json");
    expect(rules.doNotDo ?? []).not.toContain("不要把主角写成突然全知全能");
  });

  it("create_character 模型给哨兵 id「none」+ 真名 → id 用 name 生成、不是字面量 none（治真书 id=\"none\"）", async () => {
    const { projectDir } = await createProject("哨兵id建卡");
    const result = await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "create_character", targetFile: "story/character-bible.json", targetPath: "characters",
        after: { id: "none", name: "陈雨薇", role: "情人" },
        extractedEntityName: "陈雨薇",
      },
    });
    expect(result.applied).toBe(true);
    const bible = await readJson<CharacterBible>(projectDir, "story/character-bible.json");
    const chen = bible.characters.find((c) => c.name === "陈雨薇");
    expect(chen).toBeDefined();
    expect(chen?.id).not.toBe("none"); // 绝不让哨兵词成为正式 id
    expect(chen?.id).toMatch(/^char-/u);
  });

  it("create_character 没给名字 → 诚实跳过(missing_name)，不造「待确认角色」垃圾卡", async () => {
    const { projectDir } = await createProject("缺名建卡");
    const result = await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "create_character", targetFile: "story/character-bible.json", targetPath: "characters",
        after: { role: "神秘人" }, // 没 name、也没 extractedEntityName
      },
    });
    expect(result.applied).toBe(false);
    expect(result.skipped?.some((s) => s.reason === "missing_name")).toBe(true);
    const bible = await readJson<CharacterBible>(projectDir, "story/character-bible.json");
    expect(bible.characters.some((c) => c.name === "待确认角色")).toBe(false);
  });

  it("create_asset 没给名字 → 诚实跳过(missing_name)，不在 assets.json 落空资产对象（真机 Kimi/Qwen 都落了 {rules:[]...} 空对象）", async () => {
    const { projectDir } = await createProject("缺名建资产");
    const result = await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "create_asset", targetFile: "story/assets.json", targetPath: "assets", category: "assets",
        after: { rules: [], usageRules: [], lossRules: [], notes: [] }, // 没 name/id（真机就是落了这个空对象）
      },
    });
    expect(result.applied).toBe(false);
    expect(result.skipped?.some((s) => s.reason === "missing_name")).toBe(true);
    const ledger = await readJson<AssetLedger>(projectDir, "story/assets.json");
    expect(ledger.assets.length).toBe(0); // 不落任何空资产
  });

  it("create_asset 有名字 → 正常落盘", async () => {
    const { projectDir } = await createProject("正常建资产");
    const result = await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "create_asset", targetFile: "story/assets.json", targetPath: "assets", category: "assets",
        after: { name: "事故原始图纸", notes: ["宋以宁私藏"] }, extractedEntityName: "事故原始图纸",
      },
    });
    expect(result.applied).toBe(true);
    const ledger = await readJson<AssetLedger>(projectDir, "story/assets.json");
    expect(ledger.assets.some((a) => a.name === "事故原始图纸")).toBe(true);
  });

  it("update_asset_status：targetId 误指向另一资产但 name 是新资产（id/name 打架）→ 不继承旧资产字段、不污染旧资产（治串字段·真机 rerun2）", async () => {
    const { projectDir } = await createProject("资产串字段");
    // 先建「锈蚀闸门钥匙」带 usageRules/lossRules
    await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "create_asset", targetFile: "story/assets.json", targetPath: "assets", category: "assets",
        after: { name: "锈蚀闸门钥匙", usageRules: ["需要找到对应的锈蚀闸门"], lossRules: ["丢失则无法打开对应闸门"] },
        extractedEntityName: "锈蚀闸门钥匙",
      },
    });
    const ledger0 = await readJson<AssetLedger>(projectDir, "story/assets.json");
    const keyId = ledger0.assets.find((a) => a.name === "锈蚀闸门钥匙")!.id;
    // 模型把 targetId 传成钥匙 id，但 name/after 是「事故原始图纸」——id 与 name 打架
    const result = await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "update_asset_status", targetFile: "story/assets.json", targetPath: "assets", category: "assets",
        targetId: keyId, extractedEntityName: "事故原始图纸",
        after: { name: "事故原始图纸", status: "hidden" },
      },
    });
    expect(result.applied).toBe(true);
    const ledger = await readJson<AssetLedger>(projectDir, "story/assets.json");
    const key = ledger.assets.find((a) => a.name === "锈蚀闸门钥匙");
    const plan = ledger.assets.find((a) => a.name === "事故原始图纸");
    expect(key).toBeTruthy();                                          // 钥匙没被改名/覆盖
    expect(key!.usageRules).toEqual(["需要找到对应的锈蚀闸门"]);        // 钥匙字段没丢
    expect(plan).toBeTruthy();                                         // 事故原始图纸独立存在
    expect(plan!.id).not.toBe(keyId);                                  // 不复用钥匙 id
    expect(plan!.usageRules ?? []).not.toContain("需要找到对应的锈蚀闸门"); // 不串钥匙字段
    expect(plan!.lossRules ?? []).not.toContain("丢失则无法打开对应闸门");
  });

  it("create_asset 第二件（不同名、都没给 id）必须真落盘——绝不 undefined===undefined 误判去重报假成功（afterfix·铁律④）", async () => {
    const { projectDir } = await createProject("两件资产");
    await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "create_asset", targetFile: "story/assets.json", targetPath: "assets", category: "assets",
        after: { name: "锈蚀闸门钥匙" }, extractedEntityName: "锈蚀闸门钥匙",
      },
    });
    const r2 = await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "create_asset", targetFile: "story/assets.json", targetPath: "assets", category: "assets",
        after: { name: "事故原始图纸" }, extractedEntityName: "事故原始图纸",
      },
    });
    const ledger = await readJson<AssetLedger>(projectDir, "story/assets.json");
    // 「报成功」⇒「真写盘」：合取断言，直击 Codex 真机的「报成功但没写盘」
    if (r2.applied) expect(ledger.assets.some((a) => a.name === "事故原始图纸")).toBe(true);
    expect(ledger.assets.map((a) => a.name).sort()).toEqual(["事故原始图纸", "锈蚀闸门钥匙"]);
  });

  it("create_asset 落盘的资产必须有非空且互异的 id（杜绝 undefined id → 去重误判复发）", async () => {
    const { projectDir } = await createProject("资产 id");
    for (const name of ["锈蚀闸门钥匙", "事故原始图纸"]) {
      await applyFoundationWriteSuggestion({
        projectDir,
        suggestion: {
          actionType: "create_asset", targetFile: "story/assets.json", targetPath: "assets", category: "assets",
          after: { name }, extractedEntityName: name,
        },
      });
    }
    const ledger = await readJson<AssetLedger>(projectDir, "story/assets.json");
    const key = ledger.assets.find((a) => a.name === "锈蚀闸门钥匙")!;
    const plan = ledger.assets.find((a) => a.name === "事故原始图纸")!;
    expect(key.id).toBeTruthy();
    expect(plan.id).toBeTruthy();
    expect(key.id).not.toBe(plan.id);
  });

  it("create_asset 撞上老书 id=undefined 的资产（向后兼容）：新资产仍真落盘，不被 undefined 守卫吞掉", async () => {
    const { projectDir } = await createProject("老书兼容");
    // 模拟旧数据：经老版 create_asset 落盘、没有 id 的资产
    await writeFile(
      join(projectDir, "story", "assets.json"),
      JSON.stringify({ version: "v0", assets: [{ name: "锈蚀闸门钥匙" }], containers: [] }),
      "utf-8",
    );
    const r = await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "create_asset", targetFile: "story/assets.json", targetPath: "assets", category: "assets",
        after: { name: "事故原始图纸" }, extractedEntityName: "事故原始图纸",
      },
    });
    const ledger = await readJson<AssetLedger>(projectDir, "story/assets.json");
    if (r.applied) expect(ledger.assets.some((a) => a.name === "事故原始图纸")).toBe(true);
    expect(ledger.assets.some((a) => a.name === "事故原始图纸")).toBe(true);
  });

  it("update_character_detail 只改 profile 字段 → writtenFiles 不报未变的 core/state（诚实明细，不过报）", async () => {
    const { projectDir } = await createProject("写入明细");
    await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "create_character", targetFile: "story/character-bible.json", targetPath: "characters",
        after: { name: "苏晓薇" }, extractedEntityName: "苏晓薇",
      },
    });
    const id = toSafeCharacterId("苏晓薇");
    // 只改 profile（外貌锚点），完全不动 core/state
    const result = await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "update_character_detail", category: "characters",
        targetFile: "story/character-bible.json", targetPath: "appearanceAnchors", targetId: id,
        after: { appearanceAnchors: ["左手有一道旧疤"] },
      },
    });
    expect(result.applied).toBe(true);
    expect(result.writtenFiles).toContain(`characters/${id}/profile.json`); // 真改的要在
    expect(result.writtenFiles).not.toContain(`characters/${id}/core.json`); // 没动的不报
    expect(result.writtenFiles).not.toContain(`characters/${id}/state.json`);
  });

  // Bug2（Codex 封测·主角改名谎报）：开书占位主角(name=主角) + 模型把「改名」混进 update_character_detail
  // （after.name=真名 + 其它字段）。过去丢弃 after.name 只写其它字段却 applied=true → 谎报「改名成功」（违铁律④）。
  // 修：现名是开书占位 → 认领改名、真落盘；ok 诚实（名字确实改了）。
  it("update_character_detail 给开书占位主角(name=主角)改真名 → 真落盘改名、不再谎报", async () => {
    const { projectDir } = await createProject("开局给主角起名", "主角");
    const id = toSafeCharacterId("主角");
    const result = await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "update_character_detail", category: "characters",
        targetFile: "story/character-bible.json", targetPath: "characters", targetId: id,
        after: { name: "林砚", appearanceAnchors: ["眉骨有一道旧疤"] },
      },
    });
    expect(result.applied).toBe(true);
    const bible = await readJson<CharacterBible>(projectDir, "story/character-bible.json");
    expect(bible.characters.find((c) => c.id === id)?.name).toBe("林砚"); // 名字真改了（不再谎报）
    const profile = await readJson<CharacterProfile>(projectDir, `characters/${id}/profile.json`);
    expect(profile.name).toBe("林砚"); // 档案名同步
  });

  // 占位主角纯改名（after 只有 name，被误投到 update）→ 也认领改名、ok 诚实。
  it("update_character_detail 占位主角纯改名（after 只有 name）→ 认领落盘", async () => {
    const { projectDir } = await createProject("占位纯改名", "主角");
    const id = toSafeCharacterId("主角");
    const result = await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "update_character_detail", category: "characters",
        targetFile: "story/character-bible.json", targetPath: "characters", targetId: id,
        after: { name: "沈隅" },
      },
    });
    expect(result.applied).toBe(true);
    const bible = await readJson<CharacterBible>(projectDir, "story/character-bible.json");
    expect(bible.characters.find((c) => c.id === id)?.name).toBe("沈隅");
  });

  // 长篇放大律：现名已是真名时，after.name 偶发漂移绝不能静默把既定角色改崩——但也绝不谎报。
  // 其它字段照写、名字保持不变、并诚实回报「名字没改」(name_change_requires_rename)。
  it("update_character_detail 对已有真名角色的 after.name 漂移 → 名字不动、其它字段照写、诚实回报没改名", async () => {
    const { projectDir } = await createProject("真名不被漂移改", "林远");
    await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "create_character", targetFile: "story/character-bible.json", targetPath: "characters",
        after: { name: "陈雨薇" }, extractedEntityName: "陈雨薇",
      },
    });
    const id = toSafeCharacterId("陈雨薇");
    const result = await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "update_character_detail", category: "characters",
        targetFile: "story/character-bible.json", targetPath: "characters", targetId: id,
        after: { name: "苏晴", appearanceAnchors: ["戴金丝眼镜"] },
      },
    });
    expect(result.applied).toBe(true); // 其它字段写了
    const bible = await readJson<CharacterBible>(projectDir, "story/character-bible.json");
    const entry = bible.characters.find((c) => c.id === id);
    expect(entry?.name).toBe("陈雨薇"); // 名字没被漂移改
    expect(entry?.appearanceAnchors).toContain("戴金丝眼镜"); // 其它字段照写
    expect(result.skipped?.some((s) => s.reason === "name_change_requires_rename")).toBe(true); // 诚实回报名字没改
  });

  // 纯改名误投到「已有真名」角色（after 只有 name）→ 无可写、ok:false 诚实说名字没改、绝不谎报成功。
  it("update_character_detail 纯改名误投到已有真名角色 → ok:false 诚实回报、绝不谎报", async () => {
    const { projectDir } = await createProject("纯改名误投", "林远");
    await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "create_character", targetFile: "story/character-bible.json", targetPath: "characters",
        after: { name: "陈雨薇" }, extractedEntityName: "陈雨薇",
      },
    });
    const id = toSafeCharacterId("陈雨薇");
    const result = await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "update_character_detail", category: "characters",
        targetFile: "story/character-bible.json", targetPath: "characters", targetId: id,
        after: { name: "苏晴" },
      },
    });
    expect(result.applied).toBe(false); // 名字没改、也没别的可写
    const bible = await readJson<CharacterBible>(projectDir, "story/character-bible.json");
    expect(bible.characters.find((c) => c.id === id)?.name).toBe("陈雨薇"); // 名字没动
    expect(result.skipped?.some((s) => s.reason === "name_change_requires_rename")).toBe(true);
  });

  // E1：做厚写入 appearanceAnchors 时，前缀含纳的后缀重复（真书陈雨薇式）折叠为更长一条；
  // 守 #357：账本/账目（后缀关系）都保留。证明 mergeStringArrays 已接 dedupeStringList。
  it("folds prefix-contained appearance anchors on write while keeping #357 substrings apart", async () => {
    const { projectDir } = await createProject("外貌锚点去重", "林远");
    await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "create_character", targetFile: "story/character-bible.json", targetPath: "characters",
        after: { name: "陈雨薇" }, extractedEntityName: "陈雨薇",
      },
    });
    const id = toSafeCharacterId("陈雨薇");
    await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "update_character_detail", category: "characters",
        targetFile: "story/character-bible.json", targetPath: "appearanceAnchors", targetId: id,
        after: { appearanceAnchors: [
          "穿着米色风衣，风衣下摆有块深色污渍",
          "穿着米色风衣，风衣下摆有块深色污渍——像是匆忙中蹭上的",
          "账本",
          "账目",
        ] },
      },
    });
    const bible = await readJson<CharacterBible>(projectDir, "story/character-bible.json");
    const anchors = bible.characters.find((character) => character.id === id)?.appearanceAnchors ?? [];
    expect(anchors).toContain("穿着米色风衣，风衣下摆有块深色污渍——像是匆忙中蹭上的");
    expect(anchors).not.toContain("穿着米色风衣，风衣下摆有块深色污渍"); // 短版被更长含纳折叠
    expect(anchors).toContain("账本"); // 守 #357：子串不并
    expect(anchors).toContain("账目");
  });

  // E2：update_character_detail 的 typed 标量（age/gender）强值冲突不再静默覆盖——
  // 走 needs_confirmation 阻断（applied:false + blockedWrites），守铁律④「绝不静默改写」。
  it("blocks a conflicting typed scalar (age) on update instead of silently overwriting", async () => {
    const { projectDir } = await createProject("标量冲突阻断", "林远");
    await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "create_character", targetFile: "story/character-bible.json", targetPath: "characters",
        after: { name: "陈雨薇", age: "二十六七岁" }, extractedEntityName: "陈雨薇",
      },
    });
    const id = toSafeCharacterId("陈雨薇");
    const result = await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "update_character_detail", category: "characters",
        targetFile: "story/character-bible.json", targetPath: "characters", targetId: id,
        after: { age: "三十出头" },
      },
    });
    expect(result.applied).toBe(false);
    expect(result.blockedWrites?.[0]?.level).toBe("needs_confirmation");
    expect(result.blockedWrites?.[0]?.targetPath).toBe("age");
    const bible = await readJson<CharacterBible>(projectDir, "story/character-bible.json");
    expect(bible.characters.find((character) => character.id === id)?.age).toBe("二十六七岁"); // 未被静默改
  });

  it("allows the scalar overwrite when the user explicitly intends replace（改成…）", async () => {
    const { projectDir } = await createProject("标量显式覆盖", "林远");
    await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "create_character", targetFile: "story/character-bible.json", targetPath: "characters",
        after: { name: "陈雨薇", age: "二十六七岁" }, extractedEntityName: "陈雨薇",
      },
    });
    const id = toSafeCharacterId("陈雨薇");
    const result = await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "update_character_detail", category: "characters",
        targetFile: "story/character-bible.json", targetPath: "characters", targetId: id,
        after: { age: "三十出头" }, sourceUserMessage: "把陈雨薇年龄改成三十出头",
      },
    });
    expect(result.applied).toBe(true);
    const bible = await readJson<CharacterBible>(projectDir, "story/character-bible.json");
    expect(bible.characters.find((character) => character.id === id)?.age).toBe("三十出头");
  });

  it("allows the scalar overwrite when confirmedByUser=true（用户确认后的 agent 重试）", async () => {
    const { projectDir } = await createProject("标量确认覆盖", "林远");
    await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "create_character", targetFile: "story/character-bible.json", targetPath: "characters",
        after: { name: "陈雨薇", age: "二十六七岁" }, extractedEntityName: "陈雨薇",
      },
    });
    const id = toSafeCharacterId("陈雨薇");
    const blocked = await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "update_character_detail", category: "characters",
        targetFile: "story/character-bible.json", targetPath: "characters", targetId: id,
        after: { age: "三十出头" },
      },
    });
    expect(blocked.applied).toBe(false);
    expect(blocked.blockedWrites?.[0]?.level).toBe("needs_confirmation");

    const confirmed = await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "update_character_detail", category: "characters",
        targetFile: "story/character-bible.json", targetPath: "characters", targetId: id,
        after: { age: "三十出头" }, confirmedByUser: true,
      },
    });
    expect(confirmed.applied).toBe(true);
    const bible = await readJson<CharacterBible>(projectDir, "story/character-bible.json");
    expect(bible.characters.find((character) => character.id === id)?.age).toBe("三十出头");
  });

  it("does not block when the existing scalar is only a placeholder（待确认）", async () => {
    const { projectDir } = await createProject("标量占位不拦", "林远");
    await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "create_character", targetFile: "story/character-bible.json", targetPath: "characters",
        after: { name: "陈雨薇", age: "待确认" }, extractedEntityName: "陈雨薇",
      },
    });
    const id = toSafeCharacterId("陈雨薇");
    const result = await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "update_character_detail", category: "characters",
        targetFile: "story/character-bible.json", targetPath: "characters", targetId: id,
        after: { age: "二十八岁" },
      },
    });
    expect(result.applied).toBe(true);
    const bible = await readJson<CharacterBible>(projectDir, "story/character-bible.json");
    expect(bible.characters.find((character) => character.id === id)?.age).toBe("二十八岁");
  });

  it("does not over-block a non-scalar update (appearanceAnchors only) on a character that has age set", async () => {
    const { projectDir } = await createProject("非标量不误拦", "林远");
    await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "create_character", targetFile: "story/character-bible.json", targetPath: "characters",
        after: { name: "陈雨薇", age: "二十六七岁" }, extractedEntityName: "陈雨薇",
      },
    });
    const id = toSafeCharacterId("陈雨薇");
    const result = await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "update_character_detail", category: "characters",
        targetFile: "story/character-bible.json", targetPath: "appearanceAnchors", targetId: id,
        after: { appearanceAnchors: ["穿深蓝色衬衫"] },
      },
    });
    expect(result.applied).toBe(true);
    expect(result.blockedWrites ?? []).toEqual([]);
  });

  // E2E 实锤：模型常把整段人物简介同时塞进 role 和 identity（role 应是短标签如「宠妃」）。
  // 归一：整句/整段 role → 取首个短语当标签，完整描述保留在 identity（零丢失）。
  it("collapses a paragraph-bloated role into a short label, keeping full text in identity", async () => {
    const { projectDir } = await createProject("role 归一", "苏清晏");
    const longDesc = "当朝天子，年号永宁。表面推崇文治，实则多疑善变。";
    await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "create_character", targetFile: "story/character-bible.json", targetPath: "characters",
        after: { name: "永宁帝", role: longDesc, identity: longDesc }, extractedEntityName: "永宁帝",
      },
    });
    const id = toSafeCharacterId("永宁帝");
    const bible = await readJson<CharacterBible>(projectDir, "story/character-bible.json");
    const entry = bible.characters.find((character) => character.id === id);
    expect(entry?.role).toBe("当朝天子"); // 收成短标签
    expect(entry?.identity).toBe(longDesc); // 完整描述零丢失
  });

  it("leaves a normal short role label untouched", async () => {
    const { projectDir } = await createProject("短 role 不动", "苏清晏");
    await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "create_character", targetFile: "story/character-bible.json", targetPath: "characters",
        after: { name: "许知衡", role: "翰林院典籍官，实录库旧档看守人" }, extractedEntityName: "许知衡",
      },
    });
    const id = toSafeCharacterId("许知衡");
    const bible = await readJson<CharacterBible>(projectDir, "story/character-bible.json");
    expect(bible.characters.find((character) => character.id === id)?.role).toBe("翰林院典籍官，实录库旧档看守人");
  });

  it("exposes exact target files before writes", () => {
    expect(targetFilesForFoundationWriteSuggestion({
      actionType: "create_location",
      targetFile: "story/location-bible.json",
      targetPath: "locations",
      after: { name: "地下车库" },
    })).toEqual(["story/location-bible.json"]);
  });

  it("includes world/state.json in the backup set for world rule writes that may carry extraFields", () => {
    expect(targetFilesForFoundationWriteSuggestion({
      actionType: "update_world_rule",
      category: "world",
      targetFile: "story/world-bible.json",
      targetPath: "rules",
      after: { rules: ["雷宗禁止成员私下斗法"], extraFields: { 大劫倒计时: "三百年" } },
    })).toEqual(["story/world-bible.json", "world/state.json"]);
  });

  it("blocks generic foundation writes that try to escape the project directory", async () => {
    const { projectDir } = await createProject("越界写入保护");

    const result = await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "fill_missing_field",
        category: "story",
        targetFile: "../outside.json",
        targetPath: "title",
        after: "不应写出项目目录",
      },
    });

    expect(result.applied).toBe(false);
    expect(result.writes).toEqual([]);
    expect(result.blockedWrites?.[0]?.level).toBe("blocked");
    expect(result.blockedWrites?.[0]?.reason).toContain("unsafe_foundation_target_file");
    await expect(readFile(join(projectDir, "..", "outside.json"), "utf-8")).rejects.toThrow();
  });

  it("blocks canonical foundation actions when the model supplies the wrong target file", async () => {
    const { projectDir } = await createProject("canonical target guard");

    const result = await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "create_character",
        category: "characters",
        targetFile: "story/assets.json",
        targetPath: "characters",
        after: { name: "错误目标角色" },
      },
    });

    expect(result.applied).toBe(false);
    expect(result.writes).toEqual([]);
    expect(result.blockedWrites?.[0]?.level).toBe("blocked");
    expect(result.blockedWrites?.[0]?.reason).toContain("target_file_mismatch:story/character-bible.json");
    await expect(readJson<CharacterBible>(projectDir, "story/character-bible.json")).resolves.toMatchObject({
      characters: expect.not.arrayContaining([expect.objectContaining({ name: "错误目标角色" })]),
    });
  });

  it("renames the protagonist display name without renaming ids or expanding write scope", async () => {
    const { projectDir } = await createProject("主角改名", "林序");
    const protagonistId = toSafeCharacterId("林序");

    const suggestion = {
      actionType: "rename_character",
      category: "characters",
      targetFile: "story/character-bible.json",
      targetPath: "characters.name",
      targetId: protagonistId,
      before: "林序",
      after: { name: "林远" },
      extractedEntityName: "林远",
      sourceUserMessage: "把主角改成林远吧",
      writeMode: "replace" as const,
    };

    expect(targetFilesForFoundationWriteSuggestion(suggestion)).toEqual([
      "story/character-bible.json",
      `characters/${protagonistId}/profile.json`,
    ]);

    const result = await applyFoundationWriteSuggestion({ projectDir, suggestion });

    expect(result.applied).toBe(true);
    expect(result.writtenFiles).toEqual([
      "story/character-bible.json",
      `characters/${protagonistId}/profile.json`,
    ]);
    expect(result.writes.map((write) => write.action)).toEqual([
      "rename_character",
      "rename_character_profile",
    ]);
    const bible = await readJson<CharacterBible>(projectDir, "story/character-bible.json");
    const profile = await readJson<CharacterProfile>(projectDir, `characters/${protagonistId}/profile.json`);
    expect(bible.characters.find((character) => character.id === protagonistId)?.name).toBe("林远");
    expect(profile).toMatchObject({ id: protagonistId, name: "林远" });
    await expect(readJson(projectDir, "story/character-matrix.json")).resolves.toMatchObject({ version: "v0" });
    await expect(readJson(projectDir, `characters/${protagonistId}/state.json`)).resolves.toMatchObject({
      characterId: protagonistId,
    });
  });

  it("updates an existing character detail without creating a new character", async () => {
    const { projectDir } = await createProject("角色资料修改", "林远");
    const protagonistId = toSafeCharacterId("林远");

    const suggestion = {
      actionType: "update_character_detail",
      category: "characters",
      targetFile: "story/character-bible.json",
      targetPath: "characters",
      targetId: protagonistId,
      before: undefined,
      after: {
        age: "24",
        identity: "破产富二代",
        speechStyle: "冷一点，少解释",
        state: {
          mood: "冷静",
          currentGoal: "保护苏晓薇",
          recentEvents: ["完成角色资料修改"],
        },
        knowledgeKnown: ["苏晓薇的真实身份"],
      },
      extractedEntityName: "林远",
      sourceUserMessage: "把林远年龄改成24岁，身份改成破产富二代，说话冷一点，当前目标是保护苏晓薇",
      writeMode: "replace" as const,
    };

    expect(targetFilesForFoundationWriteSuggestion(suggestion)).toEqual([
      "story/character-bible.json",
      `characters/${protagonistId}/profile.json`,
      `characters/${protagonistId}/core.json`,
      `characters/${protagonistId}/state.json`,
    ]);

    const result = await applyFoundationWriteSuggestion({ projectDir, suggestion });

    expect(result.applied).toBe(true);
    expect(result.writtenFiles).toEqual([
      "story/character-bible.json",
      `characters/${protagonistId}/profile.json`,
      `characters/${protagonistId}/core.json`,
      `characters/${protagonistId}/state.json`,
    ]);

    const bible = await readJson<CharacterBible>(projectDir, "story/character-bible.json");
    const profile = await readJson<CharacterProfile>(projectDir, `characters/${protagonistId}/profile.json`);
    const core = await readJson<CharacterCore>(projectDir, `characters/${protagonistId}/core.json`);
    const state = await readJson<CharacterState>(projectDir, `characters/${protagonistId}/state.json`);

    expect(bible.characters).toHaveLength(1);
    expect(bible.characters[0]).toMatchObject({
      id: protagonistId,
      name: "林远",
      age: "24",
      identity: "破产富二代",
      speechStyle: "冷一点，少解释",
      knowledgeKnown: ["苏晓薇的真实身份"],
    });
    expect(profile).toMatchObject({ id: protagonistId, name: "林远", age: "24", identity: "破产富二代" });
    expect(core).toMatchObject({ characterId: protagonistId, speechStyle: "冷一点，少解释" });
    expect(state).toMatchObject({
      characterId: protagonistId,
      mood: "冷静",
      currentGoal: "保护苏晓薇",
      recentEvents: ["完成角色资料修改"],
    });
  });

  it("skips (does not falsely report a write) when update_character_detail has a valid target but only unrecognized fields", async () => {
    const { projectDir } = await createProject("乱填字段不谎报", "林远");
    const protagonistId = toSafeCharacterId("林远");

    // agent 乱填了引擎不认得的顶层键（既不是内置字段，也没放进 extraFields）。
    const suggestion = {
      actionType: "update_character_detail" as const,
      category: "characters" as const,
      targetFile: "story/character-bible.json",
      targetPath: "characters",
      targetId: protagonistId,
      before: undefined,
      after: {
        身高: "180cm",
        scars: "left hand has scar",
        hobby: "下棋",
      },
      extractedEntityName: "林远",
      sourceUserMessage: "林远身高180cm，左手有疤，喜欢下棋",
      writeMode: "replace" as const,
    };

    const bibleBefore = await readJson<CharacterBible>(projectDir, "story/character-bible.json");

    const result = await applyFoundationWriteSuggestion({ projectDir, suggestion });

    // 必须如实回报：没写入任何内容、不返回 4 条 write 记录。
    expect(result.applied).toBe(false);
    expect(result.writes).toHaveLength(0);
    expect(result.writtenFiles).toHaveLength(0);
    expect(result.skipped).toBeDefined();
    expect(result.skipped?.[0]?.reason).toBe("no_recognized_fields");
    expect(result.skipped?.[0]?.action).toBe("update_character_detail");

    // 落盘核对：乱填的数据一处都没进角色册。
    const bibleAfter = await readJson<CharacterBible>(projectDir, "story/character-bible.json");
    expect(bibleAfter).toEqual(bibleBefore);
    const serialized = JSON.stringify(bibleAfter);
    expect(serialized).not.toContain("180cm");
    expect(serialized).not.toContain("left hand has scar");
    expect(serialized).not.toContain("下棋");
  });

  it("still writes when update_character_detail puts unknown fields under extraFields", async () => {
    const { projectDir } = await createProject("extraFields 兜底", "林远");
    const protagonistId = toSafeCharacterId("林远");

    const suggestion = {
      actionType: "update_character_detail" as const,
      category: "characters" as const,
      targetFile: "story/character-bible.json",
      targetPath: "characters",
      targetId: protagonistId,
      before: undefined,
      after: {
        extraFields: { 身高: "180cm", hobby: "下棋" },
      },
      extractedEntityName: "林远",
      writeMode: "replace" as const,
    };

    const result = await applyFoundationWriteSuggestion({ projectDir, suggestion });

    expect(result.applied).toBe(true);
    expect(result.skipped).toBeUndefined();
    const state = await readJson<CharacterState>(projectDir, `characters/${protagonistId}/state.json`);
    expect(state).toMatchObject({ extraFields: { 身高: "180cm", hobby: "下棋" } });
  });

  it("normalizes chapter target words out of freeform writing-rule text", async () => {
    const { projectDir } = await createProject("字数规则");
    await writeJson(projectDir, "story/writing-rules.json", {
      version: "v0",
      proseStyle: [],
      genreRequirements: [],
      suspenseRules: [],
      payoffRules: [],
      reversalRules: [],
      readerExperienceRules: ["把写作规则的单章目标字数改成800，"],
      forbiddenContent: [],
      doNotDo: [],
    });

    await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "update_writing_rule",
        category: "writingRules",
        targetFile: "story/writing-rules.json",
        targetPath: "readerExperienceRules",
        sourceUserMessage: "把写作规则的单章目标字数改成200，写入规则",
        after: {
          readerExperienceRules: ["把写作规则的单章目标字数改成200，"],
        },
      },
    });

    const rules = await readJson<WritingRules>(projectDir, "story/writing-rules.json");
    expect(rules.chapterLength?.targetWords).toBe(200);
    expect(rules.readerExperienceRules.join("\n")).not.toContain("目标字数");

    await writeJson(projectDir, "story/writing-rules.json", {
      ...rules,
      readerExperienceRules: [...(rules.readerExperienceRules ?? []), "把写作规则的单章目标字数改成600，"],
    });
    await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "update_writing_rule",
        category: "writingRules",
        targetFile: "story/writing-rules.json",
        targetPath: "readerExperienceRules",
        sourceUserMessage: "把写作规则的单章目标字数改成300，写入规则",
        after: "把写作规则的单章目标字数改成300，",
      },
    });

    const scalarRules = await readJson<WritingRules>(projectDir, "story/writing-rules.json");
    expect(scalarRules.chapterLength?.targetWords).toBe(300);
    expect(scalarRules.readerExperienceRules.join("\n")).not.toContain("目标字数");
  });

  it("does not overwrite existing long-term world premise unless the user explicitly replaces it", async () => {
    const { projectDir } = await createProject("世界观覆盖保护");
    await writeJson(projectDir, "story/world-bible.json", {
      version: "v0",
      worldPremise: "魂钢由城市底层劳动记忆凝成。",
      rules: [],
      factions: [],
      powerOrSurvivalSystems: [],
      historyFacts: [],
      socialOrder: [],
    });

    const blocked = await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "update_world_rule",
        category: "world",
        targetFile: "story/world-bible.json",
        targetPath: "worldPremise",
        after: {
          worldPremise: "魂钢是外星遗物。",
        },
      },
    });

    expect(blocked.applied).toBe(false);
    expect(blocked.blockedWrites?.[0]?.level).toBe("needs_confirmation");
    await expect(readJson<WorldBible>(projectDir, "story/world-bible.json")).resolves.toMatchObject({
      worldPremise: "魂钢由城市底层劳动记忆凝成。",
    });

    const explicit = await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "update_world_rule",
        category: "world",
        targetFile: "story/world-bible.json",
        targetPath: "worldPremise",
        sourceUserMessage: "把世界前提改成魂钢是外星遗物",
        after: {
          worldPremise: "魂钢是外星遗物。",
        },
      },
    });

    expect(explicit.applied).toBe(true);
    await expect(readJson<WorldBible>(projectDir, "story/world-bible.json")).resolves.toMatchObject({
      worldPremise: "魂钢是外星遗物。",
    });
  });

  it("keeps protected asset flags even when a patch tries to flip canAiModify", async () => {
    const { projectDir } = await createProject("资产保护");
    await writeJson(projectDir, "story/assets.json", {
      version: "v0",
      assets: [{
        id: "asset-half-form",
        name: "半张魂钢申请表",
        type: "document",
        status: "damaged",
        canAiModify: false,
      }],
      containers: [],
    });

    const result = await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "update_asset_status",
        category: "assets",
        targetFile: "story/assets.json",
        targetPath: "assets",
        targetId: "asset-half-form",
        after: {
          id: "asset-half-form",
          name: "半张魂钢申请表",
          status: "available",
          canAiModify: true,
        },
      },
    });

    expect(result.applied).toBe(false);
    expect(result.blockedWrites?.[0]?.level).toBe("blocked");
    const assets = await readJson<AssetLedger>(projectDir, "story/assets.json");
    expect(assets.assets.find((asset) => asset.id === "asset-half-form")?.canAiModify).toBe(false);
    expect(assets.assets.find((asset) => asset.id === "asset-half-form")?.status).toBe("damaged");
  });

  it("blocks deleting the protagonist", async () => {
    const { projectDir } = await createProject("删除主角防护", "林远");
    const protagonistId = toSafeCharacterId("林远");

    const result = await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "delete_foundation_entry",
        category: "characters",
        targetFile: "story/character-bible.json",
        targetPath: "$",
        targetId: protagonistId,
        before: { name: "林远" },
        after: null,
        extractedEntityName: "林远",
        sourceUserMessage: "删除主角林远",
      },
    });

    expect(result.applied).toBe(false);
    expect(result.writes).toEqual([]);
    expect(result.blockedWrites?.[0]?.level).toBe("blocked");
    expect(result.blockedWrites?.[0]?.reason).toBe("cannot_delete_protagonist");
    const bible = await readJson<CharacterBible>(projectDir, "story/character-bible.json");
    expect(bible.characters.some((character) => character.id === protagonistId)).toBe(true);
  });

  it("requires explicit confirmation before deleting a character that appeared in chapters", async () => {
    const { projectDir } = await createProject("删除确认防护", "林远");
    await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "create_character",
        targetFile: "story/character-bible.json",
        targetPath: "characters",
        after: { name: "苏晓薇", role: "重要配角" },
        extractedEntityName: "苏晓薇",
      },
    });
    const targetId = toSafeCharacterId("苏晓薇");
    await writeJson(projectDir, "story/character-matrix.json", {
      version: "v0",
      entries: [{
        id: targetId,
        name: "苏晓薇",
        status: "accepted",
        evidence: [],
        appearances: [{ chapter: 3, evidence: "第3章出场" }, { chapter: 5, evidence: "第5章出场" }],
        relationshipEvents: [],
      }],
    });

    const suggestion = {
      actionType: "delete_foundation_entry",
      category: "characters",
      targetFile: "story/character-bible.json",
      targetPath: "$",
      targetId,
      before: { name: "苏晓薇" },
      after: null,
      extractedEntityName: "苏晓薇",
      sourceUserMessage: "删除角色苏晓薇",
    };

    const blocked = await applyFoundationWriteSuggestion({ projectDir, suggestion });
    expect(blocked.applied).toBe(false);
    expect(blocked.blockedWrites?.[0]?.level).toBe("needs_confirmation");
    expect(blocked.blockedWrites?.[0]?.reason).toContain("delete_needs_explicit_confirm:");
    expect(blocked.blockedWrites?.[0]?.reason).toContain("第3章");
    expect(blocked.blockedWrites?.[0]?.reason).toContain("第5章");

    const confirmed = await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: { ...suggestion, confirmedByUser: true },
    });
    expect(confirmed.applied).toBe(true);
    const bible = await readJson<CharacterBible>(projectDir, "story/character-bible.json");
    expect(bible.characters.some((character) => character.name === "苏晓薇")).toBe(false);
  });

  it("blocks deletes when the target does not exist", async () => {
    const { projectDir } = await createProject("删除目标不存在", "林远");

    const result = await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "delete_foundation_entry",
        category: "characters",
        targetFile: "story/character-bible.json",
        targetPath: "$",
        targetId: "char-not-exist",
        before: undefined,
        after: null,
        sourceUserMessage: "删除那个不存在的角色",
      },
    });

    expect(result.applied).toBe(false);
    expect(result.blockedWrites?.[0]?.level).toBe("blocked");
    expect(result.blockedWrites?.[0]?.reason).toBe("delete_target_not_found");
  });

  it("blocks deletes when the model supplies the wrong target file", async () => {
    const { projectDir } = await createProject("删除目标文件防护", "林远");

    const result = await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "delete_foundation_entry",
        category: "characters",
        targetFile: "story/assets.json",
        targetPath: "$",
        targetId: toSafeCharacterId("林远"),
        before: undefined,
        after: null,
      },
    });

    expect(result.applied).toBe(false);
    expect(result.blockedWrites?.[0]?.reason).toContain("target_file_mismatch:story/character-bible.json");
  });

  it("deletes a supporting character with full cascade cleanup", async () => {
    const { projectDir } = await createProject("级联删除", "林远");
    await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "create_character",
        targetFile: "story/character-bible.json",
        targetPath: "characters",
        after: { name: "苏晓薇", role: "重要配角" },
        extractedEntityName: "苏晓薇",
      },
    });
    await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "create_character",
        targetFile: "story/character-bible.json",
        targetPath: "characters",
        after: { name: "赵磊", role: "配角" },
        extractedEntityName: "赵磊",
      },
    });
    const targetId = toSafeCharacterId("苏晓薇");
    const otherId = toSafeCharacterId("赵磊");
    const bibleBefore = await readJson<CharacterBible>(projectDir, "story/character-bible.json");
    await writeJson(projectDir, "story/character-bible.json", {
      ...bibleBefore,
      characters: bibleBefore.characters.map((character) => (
        character.id === otherId
          ? { ...character, relationshipDynamics: ["与苏晓薇是同事", "信任主角"] }
          : character
      )),
    });
    await writeJson(projectDir, "story/character-matrix.json", {
      version: "v0",
      entries: [{
        id: targetId,
        name: "苏晓薇",
        status: "candidate",
        evidence: [],
        appearances: [],
        relationshipEvents: [],
      }],
    });

    const suggestion = {
      actionType: "delete_foundation_entry",
      category: "characters",
      targetFile: "story/character-bible.json",
      targetPath: "$",
      targetId,
      before: { name: "苏晓薇" },
      after: null,
      extractedEntityName: "苏晓薇",
      sourceUserMessage: "删除角色苏晓薇",
    };

    expect(targetFilesForFoundationWriteSuggestion(suggestion)).toEqual([
      "story/character-bible.json",
      "story/character-matrix.json",
      `characters/${targetId}/profile.json`,
      `characters/${targetId}/core.json`,
      `characters/${targetId}/state.json`,
    ]);

    const result = await applyFoundationWriteSuggestion({ projectDir, suggestion });

    expect(result.applied).toBe(true);
    expect(result.writtenFiles).toEqual([
      "story/character-bible.json",
      "story/character-matrix.json",
      `characters/${targetId}/profile.json`,
      `characters/${targetId}/core.json`,
      `characters/${targetId}/state.json`,
    ]);
    const bible = await readJson<CharacterBible>(projectDir, "story/character-bible.json");
    expect(bible.characters.some((character) => character.id === targetId)).toBe(false);
    const other = bible.characters.find((character) => character.id === otherId);
    expect(other?.relationshipDynamics).toEqual(["信任主角"]);
    const matrix = await readJson<{ readonly entries: readonly unknown[] }>(projectDir, "story/character-matrix.json");
    expect(matrix.entries).toEqual([]);
    await expect(readFile(join(projectDir, "characters", targetId, "profile.json"), "utf-8")).rejects.toThrow();
    await expect(readFile(join(projectDir, "characters", targetId, "core.json"), "utf-8")).rejects.toThrow();
    await expect(readFile(join(projectDir, "characters", targetId, "state.json"), "utf-8")).rejects.toThrow();
  });

  it("deletes locations, assets, world rules, writing rules, and relationship entries", async () => {
    const { projectDir } = await createProject("各类型删除", "林远");
    const protagonistId = toSafeCharacterId("林远");
    await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "create_location",
        category: "locations",
        targetFile: "story/location-bible.json",
        targetPath: "locations",
        after: { id: "loc-clinic", name: "地下诊所", type: "城市空间" },
      },
    });
    await writeJson(projectDir, "story/assets.json", {
      version: "v0",
      assets: [{ id: "asset-card", name: "黑色权限卡", type: "keyItem", status: "available" }],
      containers: [],
    });
    await writeJson(projectDir, "story/world-bible.json", {
      version: "v0",
      rules: ["规则A", "规则B"],
      factions: [],
      powerOrSurvivalSystems: [],
      historyFacts: [],
      socialOrder: [],
    });
    await writeJson(projectDir, "story/writing-rules.json", {
      version: "v0",
      proseStyle: [],
      genreRequirements: [],
      suspenseRules: [],
      payoffRules: [],
      reversalRules: [],
      readerExperienceRules: [],
      forbiddenContent: [],
      doNotDo: ["不要开篇回忆", "不要上帝视角"],
    });
    const bibleBefore = await readJson<CharacterBible>(projectDir, "story/character-bible.json");
    await writeJson(projectDir, "story/character-bible.json", {
      ...bibleBefore,
      characters: bibleBefore.characters.map((character) => (
        character.id === protagonistId
          ? { ...character, relationshipDynamics: ["与苏晓薇互相试探", "信任赵磊"] }
          : character
      )),
    });

    const deleteLocation = await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "delete_foundation_entry",
        category: "locations",
        targetFile: "story/location-bible.json",
        targetPath: "$",
        targetId: "loc-clinic",
        before: { name: "地下诊所" },
        after: null,
        sourceUserMessage: "删除地点地下诊所",
      },
    });
    expect(deleteLocation.applied).toBe(true);
    const locations = await readJson<LocationBible>(projectDir, "story/location-bible.json");
    expect(locations.locations).toEqual([]);

    const deleteAsset = await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "delete_foundation_entry",
        category: "assets",
        targetFile: "story/assets.json",
        targetPath: "$",
        targetId: "asset-card",
        before: { name: "黑色权限卡" },
        after: null,
        sourceUserMessage: "删除黑色权限卡",
      },
    });
    expect(deleteAsset.applied).toBe(true);
    const assets = await readJson<AssetLedger>(projectDir, "story/assets.json");
    expect(assets.assets).toEqual([]);

    const deleteWorldRule = await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "delete_foundation_entry",
        category: "world",
        targetFile: "story/world-bible.json",
        targetPath: "rules",
        before: "规则A",
        after: null,
        sourceUserMessage: "删除世界观规则：规则A",
      },
    });
    expect(deleteWorldRule.applied).toBe(true);
    const world = await readJson<WorldBible>(projectDir, "story/world-bible.json");
    expect(world.rules).toEqual(["规则B"]);

    const deleteWritingRule = await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "delete_foundation_entry",
        category: "writingRules",
        targetFile: "story/writing-rules.json",
        targetPath: "doNotDo",
        before: "不要开篇回忆",
        after: null,
        sourceUserMessage: "删除写作规则：不要开篇回忆",
      },
    });
    expect(deleteWritingRule.applied).toBe(true);
    const rules = await readJson<WritingRules>(projectDir, "story/writing-rules.json");
    expect(rules.doNotDo).toEqual(["不要上帝视角"]);

    const deleteRelationship = await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "delete_foundation_entry",
        category: "characterRelationships",
        targetFile: "story/character-bible.json",
        targetPath: "$",
        targetId: protagonistId,
        before: "与苏晓薇互相试探",
        after: null,
        sourceUserMessage: "删除林远与苏晓薇的关系条目",
      },
    });
    expect(deleteRelationship.applied).toBe(true);
    const bible = await readJson<CharacterBible>(projectDir, "story/character-bible.json");
    expect(bible.characters.find((character) => character.id === protagonistId)?.relationshipDynamics).toEqual(["信任赵磊"]);

    const notFound = await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "delete_foundation_entry",
        category: "world",
        targetFile: "story/world-bible.json",
        targetPath: "rules",
        before: "不存在的规则",
        after: null,
      },
    });
    expect(notFound.applied).toBe(false);
    expect(notFound.blockedWrites?.[0]?.reason).toBe("delete_target_not_found");
  });

  // R5b block 1: isTravelSentence must stay genre-neutral. Generic travel prose
  // (movement verb + time/distance, or N楼到M楼 spatial step) is kept out of
  // floors/rooms/fixedFacts, while registered structural rows survive — using only
  // generic signals, never hardcoded place names like 公交站/市中心.
  it("keeps generic travel prose out of spatial fields without any hardcoded place table", async () => {
    const { projectDir } = await createProject("移动语句过滤");
    await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "create_location",
        category: "locations",
        targetFile: "story/location-bible.json",
        targetPath: "locations",
        after: {
          id: "loc-travel",
          name: "测试枢纽楼",
          floors: ["一楼大厅", "二楼办公区", "三楼到一楼走楼梯一分钟"],
          rooms: ["前台", "会议室", "到星辉港步行六分钟", "开车去码头二十分钟"],
          fixedFacts: ["前台位于一楼，不能改到其他楼层", "二楼到一楼走楼梯一分钟"],
        },
      },
    });

    const locations = await readJson<LocationBible>(projectDir, "story/location-bible.json");
    const location = locations.locations.find((item) => item.name === "测试枢纽楼");
    expect(location).toBeDefined();
    const floors = location?.spatialStructure?.floors ?? [];
    const rooms = location?.spatialStructure?.rooms ?? [];
    const fixedFacts = location?.fixedFacts ?? [];

    // Registered structural rows survive.
    expect(floors).toEqual(expect.arrayContaining(["一楼大厅", "二楼办公区"]));
    expect(rooms).toEqual(expect.arrayContaining(["前台", "会议室"]));
    expect(fixedFacts).toEqual(expect.arrayContaining(["前台位于一楼，不能改到其他楼层"]));

    // Generic travel prose is filtered (movement verb + time/distance, and N楼到M楼).
    // 星辉港 is a made-up place name that no longer needs to be in any hardcoded table.
    expect(floors.join("\n")).not.toMatch(/三楼到一楼走楼梯一分钟/u);
    expect(rooms.join("\n")).not.toMatch(/星辉港步行六分钟|开车去码头二十分钟/u);
    expect(fixedFacts.join("\n")).not.toMatch(/二楼到一楼走楼梯一分钟/u);
  });

  it("does not hardcode genre-specific place names in the travel-sentence filter", async () => {
    const source = await readFile(join(import.meta.dirname, "..", "foundation-write-gateway.ts"), "utf-8");
    const travelFn = source.slice(source.indexOf("function isTravelSentence"));
    const body = travelFn.slice(0, travelFn.indexOf("\n}"));
    expect(body).not.toMatch(/公交站|市中心/u);
  });

  // 铁律④·绝不谎报：update_world_rule / update_writing_rule 给空 after（或全是引擎不认得的键）时，
  // normalize 把内容静默丢光，旧逻辑仍无条件回 write 记录 → applied=true 谎称「已写入世界观/写作规则」。
  // 改为照 update_character_detail 显式 skip：no_recognized_fields、不写、ok:false 如实回报。
  it("update_world_rule 给空 after {} → 不谎报已写入，applied:false + skipped no_recognized_fields", async () => {
    const { projectDir } = await createProject("空world");
    const result = await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "update_world_rule",
        category: "world",
        targetFile: "story/world-bible.json",
        targetPath: "rules",
        after: {},
      },
    });
    expect(result.applied).toBe(false);
    expect(result.writes).toEqual([]);
    expect(result.skipped?.some((s) => s.reason === "no_recognized_fields")).toBe(true);
  });

  it("update_writing_rule 给空 after {} → 不谎报已写入，applied:false + skipped no_recognized_fields", async () => {
    const { projectDir } = await createProject("空writing");
    const result = await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "update_writing_rule",
        category: "writingRules",
        targetFile: "story/writing-rules.json",
        targetPath: "doNotDo",
        after: {},
      },
    });
    expect(result.applied).toBe(false);
    expect(result.writes).toEqual([]);
    expect(result.skipped?.some((s) => s.reason === "no_recognized_fields")).toBe(true);
  });

  it("P0-2 原子写：成功后不留 .tmp 残留，旧文件在写入期间始终可读且完整", async () => {
    const { projectDir } = await createProject("原子写");
    const rel = "story/writing-rules.json";
    await writeJson(projectDir, rel, {
      version: "v0",
      rules: [{ id: "rule-old", doNotDo: ["旧规则"], proseStyle: ["克制"] }],
    });
    const abs = join(projectDir, rel);

    // 写入前旧文件完整可读（写入期间也始终是完整的旧内容，直到 rename 那一刻才换新）
    await expect(readFile(abs, "utf-8")).resolves.toContain("旧规则");

    const result = await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "update_writing_rule",
        category: "writingRules",
        targetFile: rel,
        targetPath: "rule-old",
        after: { doNotDo: ["新规则"] },
      },
    });
    expect(result.applied).toBe(true);

    // 成功后目标文件已更新、且目录里没有 .tmp 残留（tmp 已被 rename 消费）
    const files = await readdir(join(projectDir, "story"));
    expect(files.filter((f) => f.includes(".tmp-"))).toEqual([]);
    const after = await readFile(abs, "utf-8");
    expect(after).toContain("新规则");
    // JSON 仍合法可解析（原子写的核心保证：不会留下截断的半个文件）
    expect(() => JSON.parse(after)).not.toThrow();
  });
});

async function createProject(title: string, mainCharacterName = "林远"): Promise<{ readonly projectDir: string }> {
  const rootDir = await mkdtemp(join(tmpdir(), "story-engine-foundation-write-"));
  return createStoryProject({
    rootDir,
    title,
    genre: "都市爽文",
    premise: "林远进入集团权力中心。",
    mainCharacterName,
  });
}

async function readJson<T>(projectDir: string, relativePath: string): Promise<T> {
  return JSON.parse(await readFile(join(projectDir, relativePath), "utf-8")) as T;
}

async function writeJson(projectDir: string, relativePath: string, value: unknown): Promise<void> {
  await writeFile(join(projectDir, relativePath), `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}
