// @vitest-environment node
//
// foundation_write 纯逻辑单测：构造正确的引擎建议、落盘后诚实回报 writes/skipped、
// 删除已晋升/已出场角色如实回报「需用户确认」而非强写。引擎写入用临时项目 fixture。
import { readFile, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyFoundationWriteSuggestion, createStoryProject, toSafeCharacterId } from "@actalk/story-engine";
import type { CharacterBible } from "@actalk/story-engine";
import { describe, expect, it } from "vitest";

import {
  applyFoundationWriteToolLogic,
  buildFoundationWriteSuggestion,
  FOUNDATION_WRITE_ASSETIZATION_GUIDANCE,
  foundationTargetFileFor,
  foundationWriteSnapshotDetail,
} from "./foundation-write.js";

describe("foundationWriteSnapshotDetail（操作历史快照细节·rerun2 P2 可辨识）", () => {
  it("动作 + 实体名（targetName 优先，回退 after.name）", () => {
    expect(foundationWriteSnapshotDetail({ actionType: "create_character", after: { name: "顾长风" } })).toBe("建角色 顾长风");
    expect(foundationWriteSnapshotDetail({ actionType: "update_asset_status", targetName: "事故原始图纸" })).toBe("改资产 事故原始图纸");
    expect(foundationWriteSnapshotDetail({ actionType: "rename_character", targetName: "主角" })).toBe("角色改名 主角");
  });
  it("没名字时只给动作；未知动作回退「写资料」", () => {
    expect(foundationWriteSnapshotDetail({ actionType: "update_world_rule" })).toBe("改世界规则");
    expect(foundationWriteSnapshotDetail({ actionType: "weird_action", after: {} })).toBe("写资料");
  });
});

async function makeProject(title: string, mainCharacterName = "林远"): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "foundation-write-test-"));
  const { projectDir } = await createStoryProject({
    rootDir,
    title,
    genre: "都市",
    premise: "主角进入权力中心。",
    mainCharacterName,
  });
  return projectDir;
}

async function readJson<T>(projectDir: string, relativePath: string): Promise<T> {
  return JSON.parse(await readFile(join(projectDir, relativePath), "utf-8")) as T;
}

describe("foundation_write 构造逻辑", () => {
  it("工具参数说明要求资料资产化，同时禁止凭空补具体事实", () => {
    expect(FOUNDATION_WRITE_ASSETIZATION_GUIDANCE).toContain("资料资产化");
    expect(FOUNDATION_WRITE_ASSETIZATION_GUIDANCE).toContain("一笔写成可写正文的结构化资料");
    expect(FOUNDATION_WRITE_ASSETIZATION_GUIDANCE).toContain("不得凭空补具体事实");
    expect(FOUNDATION_WRITE_ASSETIZATION_GUIDANCE).toContain("不知道就留空");
  });

  it("foundationTargetFileFor 按 actionType+category 推导引擎期望的 targetFile", () => {
    expect(foundationTargetFileFor("create_character", "characters")).toBe("story/character-bible.json");
    expect(foundationTargetFileFor("create_location", "locations")).toBe("story/location-bible.json");
    expect(foundationTargetFileFor("create_asset", "assets")).toBe("story/assets.json");
    expect(foundationTargetFileFor("update_world_rule", "world")).toBe("story/world-bible.json");
    expect(foundationTargetFileFor("update_writing_rule", "writingRules")).toBe("story/writing-rules.json");
    // 删除按 category 走目标文件
    expect(foundationTargetFileFor("delete_foundation_entry", "locations")).toBe("story/location-bible.json");
    expect(foundationTargetFileFor("delete_foundation_entry", "characters")).toBe("story/character-bible.json");
  });

  it("buildFoundationWriteSuggestion 带 confirmed 时映射为引擎的 confirmedByUser", () => {
    const s = buildFoundationWriteSuggestion({
      actionType: "delete_foundation_entry",
      category: "characters",
      targetId: "char-x",
      before: { name: "某角色" },
      after: {},
      confirmed: true,
    });
    expect(s.confirmedByUser).toBe(true);
    expect(s.targetId).toBe("char-x");
    expect(s.targetFile).toBe("story/character-bible.json");
  });

  it("长跑 #3：rename 的顶层 newName 归一进 after.name；after 已写 name/newName 时以 after 为准；after 省略成 {}", () => {
    // 模型只给 newName 直达参数（最自然的调用形态）→ 归一成引擎认的 after.name。
    const viaTopLevel = buildFoundationWriteSuggestion({
      actionType: "rename_character",
      category: "characters",
      targetId: "char-x",
      targetName: "旧名",
      newName: "沈茂行",
    });
    expect(viaTopLevel.after).toMatchObject({ name: "沈茂行" });

    // after 里已写 name → 以 after 为准，顶层 newName 不覆盖。
    const afterWins = buildFoundationWriteSuggestion({
      actionType: "rename_character",
      category: "characters",
      targetId: "char-x",
      after: { name: "after里的新名" },
      newName: "顶层新名",
    });
    expect(afterWins.after).toMatchObject({ name: "after里的新名" });

    // after.newName（引擎也认的键）在场时顶层 newName 同样不覆盖。
    const afterNewNameWins = buildFoundationWriteSuggestion({
      actionType: "rename_character",
      category: "characters",
      targetId: "char-x",
      after: { newName: "after的newName" },
      newName: "顶层新名",
    });
    expect(afterNewNameWins.after).toMatchObject({ newName: "after的newName" });
    expect((afterNewNameWins.after as Record<string, unknown>).name).toBeUndefined();

    // after 整体省略 → 归一成 {}（引擎按缺字段诚实 skip，不再死在 zod 硬校验）。
    const noAfter = buildFoundationWriteSuggestion({
      actionType: "rename_character",
      category: "characters",
      targetId: "char-x",
    });
    expect(noAfter.after).toEqual({});
  });
});

describe("foundation_write 诚实回报", () => {
  it("更新存在角色的外貌 → applied，writes 非空，落盘到角色册", async () => {
    const projectDir = await makeProject("外貌写入", "林远");
    const id = toSafeCharacterId("林远");
    const out = await applyFoundationWriteToolLogic({
      projectDir,
      toolInput: {
        actionType: "update_character_detail",
        category: "characters",
        targetId: id,
        after: { appearanceAnchors: ["左手有一道明显的疤痕"] },
      },
    });
    expect(out.ok).toBe(true); // 真写入 → 统一诚实标志 ok:true
    expect(out.applied).toBe(true);
    expect(out.needsConfirmation).toBe(false);
    expect(out.writes.length).toBeGreaterThan(0);
    expect(out.refreshScope).toBe("foundation");
    const bible = await readJson<CharacterBible>(projectDir, "story/character-bible.json");
    const entry = bible.characters.find((c) => c.id === id);
    expect(entry?.appearanceAnchors).toContain("左手有一道明显的疤痕");
  });

  it("更新角色但缺 targetId → 不写入，skipped 诚实回报，不谎称 applied", async () => {
    const projectDir = await makeProject("缺ID写入");
    const out = await applyFoundationWriteToolLogic({
      projectDir,
      toolInput: {
        actionType: "update_character_detail",
        category: "characters",
        targetName: "不存在的人",
        after: { desire: "复仇" },
      },
    });
    expect(out.applied).toBe(false);
    expect(out.writes).toEqual([]);
    expect(out.skipped.length).toBeGreaterThan(0);
    expect(out.skipped[0]?.reason).toBe("missing_target_id");
    expect(out.summary).toContain("没有写入");
  });

  it("缺 targetId 且没给名字、书里只有一个角色 → 兜底写到唯一角色（治『没能找到对应角色』吓人失败）", async () => {
    const projectDir = await makeProject("唯一角色兜底", "林远");
    const out = await applyFoundationWriteToolLogic({
      projectDir,
      toolInput: {
        actionType: "update_character_detail",
        category: "characters",
        // 模拟模型早期补主角人设时漏带 targetId/名字（用户实测：男主林远那次）
        after: { desire: "后宫成群" },
      },
    });
    expect(out.ok).toBe(true);
    expect(out.applied).toBe(true);
    expect(out.writes.length).toBeGreaterThan(0);
    const bible = await readJson<CharacterBible>(projectDir, "story/character-bible.json");
    const entry = bible.characters.find((c) => c.name === "林远");
    expect(entry?.desire).toBe("后宫成群");
  });

  it("有效 targetId 但只填了引擎不认得的字段 → 不写入，skipped 诚实回报，不谎称 applied", async () => {
    const projectDir = await makeProject("乱填字段", "林远");
    const id = toSafeCharacterId("林远");
    const out = await applyFoundationWriteToolLogic({
      projectDir,
      toolInput: {
        actionType: "update_character_detail",
        category: "characters",
        targetId: id,
        // 引擎认不出来的乱填顶层键（没有专用字段且没放进 extraFields）。
        after: { 身高: "180cm", scars: "left hand has scar", hobby: "下棋" },
      },
    });
    expect(out.applied).toBe(false);
    expect(out.writes).toEqual([]);
    expect(out.skipped.length).toBeGreaterThan(0);
    expect(out.skipped[0]?.reason).toBe("no_recognized_fields");
    expect(out.summary).toContain("没有写入");
    expect(out.summary).toContain("extraFields");
    // 落盘核对：乱填数据一处都没进角色册。
    const bible = await readJson<CharacterBible>(projectDir, "story/character-bible.json");
    expect(JSON.stringify(bible)).not.toContain("180cm");
  });

  it("删除已出场角色 → needsConfirmation=true，未写入，summary 明确要求确认", async () => {
    const projectDir = await makeProject("删除确认", "林远");
    // 新建一个配角并把它登记到角色矩阵且有出场记录（触发 needs_confirmation）
    await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "create_character",
        category: "characters",
        targetFile: "story/character-bible.json",
        targetPath: "characters",
        after: { name: "苏晓薇", role: "重要配角" },
        extractedEntityName: "苏晓薇",
      },
    });
    const targetId = toSafeCharacterId("苏晓薇");
    await writeFile(
      join(projectDir, "story", "character-matrix.json"),
      `${JSON.stringify({
        version: "v0",
        entries: [{
          id: targetId,
          name: "苏晓薇",
          status: "promoted",
          evidence: [],
          appearances: [{ chapter: 3, evidence: "第3章出场" }],
          relationshipEvents: [],
        }],
      }, null, 2)}\n`,
      "utf-8",
    );

    const out = await applyFoundationWriteToolLogic({
      projectDir,
      toolInput: {
        actionType: "delete_foundation_entry",
        category: "characters",
        targetId,
        targetName: "苏晓薇",
        before: { name: "苏晓薇" },
        after: {},
      },
    });
    expect(out.ok).toBe(false); // 需确认=没写任何东西 → ok:false（否则前端会绿色显示「已完成」=谎报）
    expect(out.applied).toBe(false);
    expect(out.needsConfirmation).toBe(true);
    expect(out.blocked[0]?.level).toBe("needs_confirmation");
    expect(out.summary).toContain("先确认"); // 删角色未确认会先被工具门拦下（删任何角色都先问）
    // 没写：角色仍在
    const bible = await readJson<CharacterBible>(projectDir, "story/character-bible.json");
    expect(bible.characters.some((c) => c.id === targetId)).toBe(true);

    // 带 confirmed=true 重试 → 真的删除
    const confirmed = await applyFoundationWriteToolLogic({
      projectDir,
      toolInput: {
        actionType: "delete_foundation_entry",
        category: "characters",
        targetId,
        targetName: "苏晓薇",
        before: { name: "苏晓薇" },
        after: {},
        confirmed: true,
      },
    });
    expect(confirmed.applied).toBe(true);
    expect(confirmed.needsConfirmation).toBe(false);
    const after = await readJson<CharacterBible>(projectDir, "story/character-bible.json");
    expect(after.characters.some((c) => c.id === targetId)).toBe(false);
  });

  it("删除主角：未确认先被工具门拦成 needsConfirmation；确认后再被引擎硬挡 cannot_delete_protagonist（双层保护、始终未删）", async () => {
    const projectDir = await makeProject("删主角防护", "林远");
    const id = toSafeCharacterId("林远");

    // 第一层（工具门）：删任何角色未带 confirmed → needsConfirmation、未删。
    const first = await applyFoundationWriteToolLogic({
      projectDir,
      toolInput: { actionType: "delete_foundation_entry", category: "characters", targetId: id, before: { name: "林远" }, after: {} },
    });
    expect(first.ok).toBe(false);
    expect(first.applied).toBe(false);
    expect(first.needsConfirmation).toBe(true);

    // 第二层（引擎）：即便用户确认（confirmed=true），主角仍被引擎硬挡，不可删。
    const confirmed = await applyFoundationWriteToolLogic({
      projectDir,
      toolInput: { actionType: "delete_foundation_entry", category: "characters", targetId: id, before: { name: "林远" }, after: {}, confirmed: true },
    });
    expect(confirmed.ok).toBe(false);
    expect(confirmed.applied).toBe(false);
    expect(confirmed.needsConfirmation).toBe(false);
    expect(confirmed.blocked[0]?.level).toBe("blocked");
    expect(confirmed.blocked[0]?.reason).toBe("cannot_delete_protagonist");
    const bible = await readJson<CharacterBible>(projectDir, "story/character-bible.json");
    expect(bible.characters.some((c) => c.id === id)).toBe(true);
  });

  it("写作规则档·字段纠错：removeFromArrays 删某条、replaceArrays 整列重写（端到端经工具，零引擎改）", async () => {
    const projectDir = await makeProject("写作规则纠错");
    // 先写两条 forbiddenContent
    await applyFoundationWriteToolLogic({
      projectDir,
      toolInput: {
        actionType: "update_writing_rule",
        category: "writingRules",
        after: { forbiddenContent: ["禁止写规则A", "禁止写规则B"] },
      },
    });
    let rules = await readJson<{ forbiddenContent?: string[] }>(projectDir, "story/writing-rules.json");
    expect(rules.forbiddenContent).toEqual(expect.arrayContaining(["禁止写规则A", "禁止写规则B"]));

    // removeFromArrays 删 A → 只剩 B
    const removed = await applyFoundationWriteToolLogic({
      projectDir,
      toolInput: {
        actionType: "update_writing_rule",
        category: "writingRules",
        after: { removeFromArrays: { forbiddenContent: ["禁止写规则A"] } },
      },
    });
    expect(removed.applied).toBe(true);
    rules = await readJson<{ forbiddenContent?: string[] }>(projectDir, "story/writing-rules.json");
    expect(rules.forbiddenContent).not.toContain("禁止写规则A");
    expect(rules.forbiddenContent).toContain("禁止写规则B");

    // replaceArrays 整列重写 → 只剩 C
    await applyFoundationWriteToolLogic({
      projectDir,
      toolInput: {
        actionType: "update_writing_rule",
        category: "writingRules",
        after: { replaceArrays: { forbiddenContent: ["禁止写规则C"] } },
      },
    });
    rules = await readJson<{ forbiddenContent?: string[] }>(projectDir, "story/writing-rules.json");
    expect(rules.forbiddenContent).toEqual(["禁止写规则C"]);
  });

  it("写作规则档·诚实 miss（修#2）：removeFromArrays 目标全没命中 → ok:false、未删、如实回报没找到（不静默成功）", async () => {
    const projectDir = await makeProject("写作规则删不中");
    await applyFoundationWriteToolLogic({
      projectDir,
      toolInput: { actionType: "update_writing_rule", category: "writingRules", after: { forbiddenContent: ["禁止写规则A"] } },
    });
    const out = await applyFoundationWriteToolLogic({
      projectDir,
      toolInput: { actionType: "update_writing_rule", category: "writingRules", after: { removeFromArrays: { forbiddenContent: ["根本不存在的规则"] } } },
    });
    expect(out.ok).toBe(false); // 没删中 → 不谎报成功
    expect(out.applied).toBe(false);
    expect(out.summary).toMatch(/没找到|未删/);
    const rules = await readJson<{ forbiddenContent?: string[] }>(projectDir, "story/writing-rules.json");
    expect(rules.forbiddenContent).toContain("禁止写规则A"); // 原内容没被动
  });

  it("写作规则档·部分 miss（修#2）：一条命中一条没命中 → 写成功但 skipped 点名没删到的", async () => {
    const projectDir = await makeProject("写作规则部分删");
    await applyFoundationWriteToolLogic({
      projectDir,
      toolInput: { actionType: "update_writing_rule", category: "writingRules", after: { forbiddenContent: ["规则A真实", "规则B真实"] } },
    });
    const out = await applyFoundationWriteToolLogic({
      projectDir,
      toolInput: { actionType: "update_writing_rule", category: "writingRules", after: { removeFromArrays: { forbiddenContent: ["规则A真实", "规则C不存在"] } } },
    });
    expect(out.applied).toBe(true); // 规则A 删了 → 有改动
    expect(out.skipped.length).toBeGreaterThan(0); // 规则C没找到 → 如实回报
    const rules = await readJson<{ forbiddenContent?: string[] }>(projectDir, "story/writing-rules.json");
    expect(rules.forbiddenContent).not.toContain("规则A真实"); // 命中的删了
    expect(rules.forbiddenContent).toContain("规则B真实"); // 其余保留
  });

  describe("角色 bible 档·字段纠错（受控破例⑤·端到端经工具）", () => {
    async function writeAnchors(projectDir: string, id: string, anchors: string[]): Promise<void> {
      await applyFoundationWriteToolLogic({
        projectDir,
        toolInput: { actionType: "update_character_detail", category: "characters", targetId: id, after: { appearanceAnchors: anchors } },
      });
    }

    it("removeFromArrays 删某条外貌锚点，保留其余", async () => {
      const projectDir = await makeProject("删外貌", "林远");
      const id = toSafeCharacterId("林远");
      await writeAnchors(projectDir, id, ["右手有一道疤", "左眼有痣"]);
      const out = await applyFoundationWriteToolLogic({
        projectDir,
        toolInput: { actionType: "update_character_detail", category: "characters", targetId: id, after: { removeFromArrays: { appearanceAnchors: ["右手有一道疤"] } } },
      });
      expect(out.ok).toBe(true);
      expect(out.applied).toBe(true);
      const bible = await readJson<CharacterBible>(projectDir, "story/character-bible.json");
      const entry = bible.characters.find((c) => c.id === id);
      expect(entry?.appearanceAnchors).not.toContain("右手有一道疤");
      expect(entry?.appearanceAnchors).toContain("左眼有痣");
    });

    it("改某条 = 同一次 removeFromArrays 删旧 + appearanceAnchors 加新", async () => {
      const projectDir = await makeProject("改外貌", "林远");
      const id = toSafeCharacterId("林远");
      await writeAnchors(projectDir, id, ["右手有一道疤"]);
      await applyFoundationWriteToolLogic({
        projectDir,
        toolInput: { actionType: "update_character_detail", category: "characters", targetId: id, after: { removeFromArrays: { appearanceAnchors: ["右手有一道疤"] }, appearanceAnchors: ["左手有一道疤"] } },
      });
      const bible = await readJson<CharacterBible>(projectDir, "story/character-bible.json");
      const entry = bible.characters.find((c) => c.id === id);
      expect(entry?.appearanceAnchors).toEqual(["左手有一道疤"]);
    });

    it("replaceArrays 整列重写 relationshipDynamics，再给 [] 真清空（修#8：钉住 [] 清空行为）", async () => {
      const projectDir = await makeProject("重写关系", "林远");
      const id = toSafeCharacterId("林远");
      const read = async () => (await readJson<CharacterBible>(projectDir, "story/character-bible.json")).characters.find((c) => c.id === id);
      await applyFoundationWriteToolLogic({
        projectDir,
        toolInput: { actionType: "update_character_detail", category: "characters", targetId: id, after: { relationshipDynamics: ["欠老陈一个人情", "和林晚是旧识"] } },
      });
      // ① 整列重写成非空
      await applyFoundationWriteToolLogic({
        projectDir,
        toolInput: { actionType: "update_character_detail", category: "characters", targetId: id, after: { replaceArrays: { relationshipDynamics: ["只和林晚是旧识"] } } },
      });
      expect((await read())?.relationshipDynamics).toEqual(["只和林晚是旧识"]);
      // ② 给 [] 真清空（之前测试名说「[] 可清空」但没真测——修#8 补上）
      const cleared = await applyFoundationWriteToolLogic({
        projectDir,
        toolInput: { actionType: "update_character_detail", category: "characters", targetId: id, after: { replaceArrays: { relationshipDynamics: [] } } },
      });
      expect(cleared.applied).toBe(true);
      expect((await read())?.relationshipDynamics).toEqual([]);
    });

    it("removeExtraFieldKeys 删 extraFields 自定义键", async () => {
      const projectDir = await makeProject("删字段键", "林远");
      const id = toSafeCharacterId("林远");
      await applyFoundationWriteToolLogic({
        projectDir,
        toolInput: { actionType: "update_character_detail", category: "characters", targetId: id, after: { extraFields: { 绰号: "远哥", 错填的键: "不该有的值" } } },
      });
      const out = await applyFoundationWriteToolLogic({
        projectDir,
        toolInput: { actionType: "update_character_detail", category: "characters", targetId: id, after: { removeExtraFieldKeys: ["错填的键"] } },
      });
      expect(out.applied).toBe(true);
      const state = await readJson<{ extraFields?: Record<string, unknown> }>(projectDir, `characters/${id}/state.json`);
      expect(state.extraFields).toBeTruthy();
      expect(state.extraFields).not.toHaveProperty("错填的键");
      expect(state.extraFields).toHaveProperty("绰号", "远哥");
    });

    it("诚实·改某条原文差字：删旧没命中但加了新 → 两条并存 + 如实回报『没找到没删』(不静默谎报全成·铁律④)", async () => {
      const projectDir = await makeProject("改某条差字", "林远");
      const id = toSafeCharacterId("林远");
      await writeAnchors(projectDir, id, ["右手有一道明显的疤痕"]);
      // 用户想把疤改到左手，但 removeFromArrays 原文写差了（'右手的疤' ≠ 现存 '右手有一道明显的疤痕'）→ 删不中。
      const out = await applyFoundationWriteToolLogic({
        projectDir,
        toolInput: {
          actionType: "update_character_detail",
          category: "characters",
          targetId: id,
          after: { removeFromArrays: { appearanceAnchors: ["右手的疤"] }, appearanceAnchors: ["左手有一道明显的疤痕"] },
        },
      });
      expect(out.applied).toBe(true); // 新条确实写了
      expect(out.partialMiss).toBe(true); // 修#1：部分纠错失败 → 前端显示「部分完成」(琥珀色)，不当全成功绿色
      expect(out.skipped.length).toBeGreaterThan(0); // 但没删到的如实回报，不静默
      expect(out.summary).toMatch(/没找到|未删/);
      const bible = await readJson<CharacterBible>(projectDir, "story/character-bible.json");
      const entry = bible.characters.find((c) => c.id === id);
      // 如实反映现实：旧的没删成、新的加了 → 两条都在（工具不替用户猜该删哪条，只诚实告知让其核对重试）。
      expect(entry?.appearanceAnchors).toContain("右手有一道明显的疤痕");
      expect(entry?.appearanceAnchors).toContain("左手有一道明显的疤痕");
    });

    it("修#1：纠错全命中（无 miss）→ partialMiss:false（正常绿色，不误报部分完成）", async () => {
      const projectDir = await makeProject("全命中", "林远");
      const id = toSafeCharacterId("林远");
      await writeAnchors(projectDir, id, ["右手有一道疤"]);
      const out = await applyFoundationWriteToolLogic({
        projectDir,
        toolInput: { actionType: "update_character_detail", category: "characters", targetId: id, after: { removeFromArrays: { appearanceAnchors: ["右手有一道疤"] }, appearanceAnchors: ["左手有一道疤"] } },
      });
      expect(out.applied).toBe(true);
      expect(out.partialMiss).toBe(false); // 删旧命中 + 加新 → 全成功
      const bible = await readJson<CharacterBible>(projectDir, "story/character-bible.json");
      expect(bible.characters.find((c) => c.id === id)?.appearanceAnchors).toEqual(["左手有一道疤"]);
    });

    // Bug2（Codex 封测）：已有真名角色的 after.name 漂移——其它字段写成功但名字没改 → partialMiss 琥珀「部分完成」，
    // summary 如实说名字没改，绝不让 agent 据此谎称「改名成功」(铁律④)。
    it("Bug2·已有真名角色 after.name 漂移：其它字段写了名字没改 → partialMiss + 诚实 summary", async () => {
      const projectDir = await makeProject("漂移不改名", "林远");
      const id = toSafeCharacterId("林远");
      const out = await applyFoundationWriteToolLogic({
        projectDir,
        toolInput: { actionType: "update_character_detail", category: "characters", targetId: id, after: { name: "苏晴", appearanceAnchors: ["戴金丝眼镜"] } },
      });
      expect(out.applied).toBe(true); // 其它字段写了
      expect(out.partialMiss).toBe(true); // 名字没改 → 部分完成(琥珀)，不当全成功绿色
      expect(out.summary).toMatch(/名字没有改|改名/);
      const bible = await readJson<CharacterBible>(projectDir, "story/character-bible.json");
      expect(bible.characters.find((c) => c.id === id)?.name).toBe("林远"); // 名字没被漂移改
    });

    // Bug2：开书占位主角(name=主角) + 改名混在 update 里 → 端到端真改名、ok 诚实、summary 含改名（不再谎报、不当部分完成）。
    it("Bug2·开书占位主角改真名混在 update 里 → 真改名、ok 诚实", async () => {
      const projectDir = await makeProject("占位起名", "主角");
      const id = toSafeCharacterId("主角");
      const out = await applyFoundationWriteToolLogic({
        projectDir,
        toolInput: { actionType: "update_character_detail", category: "characters", targetId: id, after: { name: "林砚", appearanceAnchors: ["眉骨有疤"] } },
      });
      expect(out.ok).toBe(true);
      expect(out.partialMiss).toBe(false);
      expect(out.summary).toMatch(/改名|林砚/);
      const bible = await readJson<CharacterBible>(projectDir, "story/character-bible.json");
      expect(bible.characters.find((c) => c.id === id)?.name).toBe("林砚");
    });

    it("修#7：replaceArrays:[] 清空一个本就为空的字段 → 不报「没找到（）」，幂等放行（ok:true）", async () => {
      const projectDir = await makeProject("幂等清空", "林远");
      const id = toSafeCharacterId("林远");
      // cannotDo 本就为空，replaceArrays:[] 是幂等无操作，不该被当「没找到」
      const out = await applyFoundationWriteToolLogic({
        projectDir,
        toolInput: { actionType: "update_character_detail", category: "characters", targetId: id, after: { replaceArrays: { cannotDo: [] } } },
      });
      expect(out.ok).toBe(true);
      expect(out.summary).not.toContain("没找到（）");
    });

    it("诚实：removeFromArrays 的目标一条都没匹配上 → ok:false、未改动、如实回报没找到（绝不静默）", async () => {
      const projectDir = await makeProject("删不存在", "林远");
      const id = toSafeCharacterId("林远");
      await writeAnchors(projectDir, id, ["右手有一道疤"]);
      const out = await applyFoundationWriteToolLogic({
        projectDir,
        toolInput: { actionType: "update_character_detail", category: "characters", targetId: id, after: { removeFromArrays: { appearanceAnchors: ["根本不存在的特征"] } } },
      });
      expect(out.ok).toBe(false);
      expect(out.applied).toBe(false);
      expect(out.summary).toMatch(/没找到|未找到|没有改动/);
      const bible = await readJson<CharacterBible>(projectDir, "story/character-bible.json");
      const entry = bible.characters.find((c) => c.id === id);
      expect(entry?.appearanceAnchors).toContain("右手有一道疤"); // 原内容没被动
    });

    it("向后兼容：不带任何纠错指令的纯追加仍按原样追加（旧书行为不变）", async () => {
      const projectDir = await makeProject("向后兼容", "林远");
      const id = toSafeCharacterId("林远");
      await writeAnchors(projectDir, id, ["右手有一道疤"]);
      await writeAnchors(projectDir, id, ["左眼有痣"]);
      const bible = await readJson<CharacterBible>(projectDir, "story/character-bible.json");
      const entry = bible.characters.find((c) => c.id === id);
      expect(entry?.appearanceAnchors).toEqual(expect.arrayContaining(["右手有一道疤", "左眼有痣"]));
    });
  });

  it("删任何角色都需确认：删一个普通(未晋升、引擎本不强制确认)配角，未带 confirmed → 工具门拦成 needsConfirmation/ok:false/未删；带 confirmed=true → 真删（Codex 顾明场景）", async () => {
    const projectDir = await makeProject("删配角确认", "林远");
    // 建一个普通配角，且**不**写 character-matrix（引擎对它本不会强制确认——证明是工具门在拦，对齐用户「删任何真角色都先问」）。
    await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "create_character",
        category: "characters",
        targetFile: "story/character-bible.json",
        targetPath: "characters",
        after: { name: "顾明", role: "配角" },
        extractedEntityName: "顾明",
      },
    });
    const targetId = toSafeCharacterId("顾明");

    const first = await applyFoundationWriteToolLogic({
      projectDir,
      toolInput: { actionType: "delete_foundation_entry", category: "characters", targetId, targetName: "顾明", before: { name: "顾明" }, after: {} },
    });
    expect(first.ok).toBe(false);
    expect(first.applied).toBe(false);
    expect(first.needsConfirmation).toBe(true);
    expect(first.summary).toContain("先确认");
    const bibleAfterFirst = await readJson<CharacterBible>(projectDir, "story/character-bible.json");
    expect(bibleAfterFirst.characters.some((c) => c.id === targetId)).toBe(true); // 顾明仍在

    const confirmed = await applyFoundationWriteToolLogic({
      projectDir,
      toolInput: { actionType: "delete_foundation_entry", category: "characters", targetId, targetName: "顾明", before: { name: "顾明" }, after: {}, confirmed: true },
    });
    expect(confirmed.ok).toBe(true);
    expect(confirmed.applied).toBe(true);
    const bibleAfter = await readJson<CharacterBible>(projectDir, "story/character-bible.json");
    expect(bibleAfter.characters.some((c) => c.id === targetId)).toBe(false); // 确认后真删
  });

  // 铁律④·绝不泄露裸 id：模型把 char-id 错塞进 targetName 槽位时，删角色确认摘要不能渲染成「删除角色「char-xxxx」」。
  it("删角色未确认：char-id 错塞进 targetName → 确认摘要显角色名、不泄露裸 char-id", async () => {
    const projectDir = await makeProject("删角色裸id", "林远");
    const id = toSafeCharacterId("林远");

    const out = await applyFoundationWriteToolLogic({
      projectDir,
      toolInput: {
        actionType: "delete_foundation_entry",
        category: "characters",
        targetName: id, // 模型把 id 塞进了 name 槽位
        after: {},
      },
    });

    expect(out.needsConfirmation).toBe(true);
    expect(out.summary).toContain("林远"); // 解析成角色名
    expect(out.summary).not.toContain(id); // 绝不泄露裸 char-id
  });
});

describe("foundation_write 已确立设定覆盖确认链路", () => {
  async function seedAge(projectDir: string, name: string, age: string): Promise<string> {
    const id = toSafeCharacterId(name);
    const out = await applyFoundationWriteToolLogic({
      projectDir,
      toolInput: {
        actionType: "update_character_detail",
        category: "characters",
        targetId: id,
        after: { age },
      },
    });
    expect(out.ok).toBe(true);
    return id;
  }

  it("仅「改成」请求、无用户覆盖同意 → 拦下，summary 指引差什么才放行", async () => {
    const projectDir = await makeProject("年龄覆盖拦", "李默");
    const id = await seedAge(projectDir, "李默", "30");
    const out = await applyFoundationWriteToolLogic({
      projectDir,
      toolInput: {
        actionType: "update_character_detail",
        category: "characters",
        targetId: id,
        after: { age: "32" },
      },
      userTurnText: "把主角李默的年龄改成32岁",
    });
    expect(out.ok).toBe(false);
    expect(out.applied).toBe(false);
    expect(out.needsConfirmation).toBe(true);
    expect(out.summary).toMatch(/允许覆盖|确定/);
    expect(out.summary).toMatch(/勿无限重试|不要反复重试|如实/);
    const bible = await readJson<CharacterBible>(projectDir, "story/character-bible.json");
    expect(bible.characters.find((c) => c.id === id)?.age).toBe("30");
  });

  it("agent 自说 confirmed=true 但本轮用户原话无同意 → 仍拦（不接受自说自话）", async () => {
    const projectDir = await makeProject("年龄假确认", "李默");
    const id = await seedAge(projectDir, "李默", "30");
    const out = await applyFoundationWriteToolLogic({
      projectDir,
      toolInput: {
        actionType: "update_character_detail",
        category: "characters",
        targetId: id,
        after: { age: "32" },
        confirmed: true,
      },
      userTurnText: "把主角李默的年龄改成32岁",
    });
    expect(out.ok).toBe(false);
    expect(out.needsConfirmation).toBe(true);
    const bible = await readJson<CharacterBible>(projectDir, "story/character-bible.json");
    expect(bible.characters.find((c) => c.id === id)?.age).toBe("30");
  });

  it.each(["允许覆盖", "确定", "同意", "覆盖吧"])(
    "本轮用户原话含明确同意「%s」→ 放行并真改年龄",
    async (consent) => {
      const projectDir = await makeProject(`年龄覆盖放行-${consent}`, "李默");
      const id = await seedAge(projectDir, "李默", "30");
      const out = await applyFoundationWriteToolLogic({
        projectDir,
        toolInput: {
          actionType: "update_character_detail",
          category: "characters",
          targetId: id,
          after: { age: "33" },
        },
        userTurnText: consent,
      });
      expect(out.ok).toBe(true);
      expect(out.applied).toBe(true);
      expect(out.needsConfirmation).toBe(false);
      expect(out.summary).toContain("已定稿章节不会自动改动");
      const bible = await readJson<CharacterBible>(projectDir, "story/character-bible.json");
      expect(bible.characters.find((c) => c.id === id)?.age).toBe("33");
    },
  );
});
