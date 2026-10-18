// @vitest-environment node
//
// read_foundation 纯逻辑单测：按 kind 读出真实资料片段（character/asset/location/gap_report），
// 找不到时诚实回报 found:false，绝不编造。引擎写入用临时项目 fixture（createStoryProject）。
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyFoundationWriteSuggestion } from "../../book/foundation-write-gateway.js";
import { createStoryProject, toSafeCharacterId } from "../../book/project-store.js";
import { describe, expect, it } from "vitest";

import { readFoundationFragment } from "./read-foundation.js";

async function makeProject(title: string, mainCharacterName = "林远"): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "read-foundation-test-"));
  const { projectDir } = await createStoryProject({
    rootDir,
    title,
    genre: "都市",
    premise: "主角进入权力中心。",
    mainCharacterName,
  });
  return projectDir;
}

describe("read_foundation 读类工具", () => {
  it("kind=character 不带 id：读出角色册并诚实计数", async () => {
    const projectDir = await makeProject("角色册");
    const out = await readFoundationFragment({ projectDir, kind: "character" });
    expect(out.kind).toBe("character");
    expect(out.found).toBe(true);
    expect(out.summary).toContain("林远");
    // 读类不带 snapshotId
    expect("snapshotId" in out).toBe(false);
  });

  it("kind=character 带存在的 id：附该角色的运行时 state", async () => {
    const projectDir = await makeProject("单角色", "林远");
    const id = toSafeCharacterId("林远");
    const out = await readFoundationFragment({ projectDir, kind: "character", id });
    expect(out.found).toBe(true);
    expect(out.characterState).toBeTruthy();
    expect(out.summary).toContain("林远");
  });

  it("kind=character 带 id：喂模型的 data 已中文化（键换中文、不露英文字段名）", async () => {
    const projectDir = await makeProject("中文化", "林远");
    const id = toSafeCharacterId("林远");
    const out = await readFoundationFragment({ projectDir, kind: "character", id });
    expect(out.found).toBe(true);
    const data = out.data as Record<string, unknown>;
    // 值原样（用户中文内容）、键换中文标签：name→名称、role→角色定位。
    expect(data["名称"]).toBe("林远");
    // 绝不再露英文字段名（这正是用户看到「读出来是英文」的根因）。
    for (const englishKey of ["id", "name", "role", "identity", "personalityBaseline", "trustLevel", "behaviorBoundaries"]) {
      expect(Object.keys(data)).not.toContain(englishKey);
    }
    // 顶层键一律不以 ASCII 字母开头（即没有任何英文键漏网）。
    expect(Object.keys(data).every((k) => !/^[A-Za-z]/.test(k))).toBe(true);
    // 运行时 state 同样中文化。
    const state = out.characterState as Record<string, unknown>;
    expect(Object.keys(state).every((k) => !/^[A-Za-z]/.test(k))).toBe(true);
  });

  it("kind=character 带不存在的 id：found=false，不编造", async () => {
    const projectDir = await makeProject("缺角色");
    const out = await readFoundationFragment({ projectDir, kind: "character", id: "char-not-here" });
    expect(out.found).toBe(false);
    expect(out.summary).toContain("没有找到");
  });

  // E2E 实锤：agent 常用泛化称呼指主角（id:"主角"），旧码 id/name 精确匹配双双不中 → found:false，弱模型易卡。
  // 泛化称呼（主角/主人公/protagonist 等）解析到主角卡；state 用 entry.id 读（不用泛化词）。
  it("kind=character id=泛化称呼「主角」：解析到主角卡、附 state，不再 found:false", async () => {
    const projectDir = await makeProject("泛化主角", "林远");
    const out = await readFoundationFragment({ projectDir, kind: "character", id: "主角" });
    expect(out.found).toBe(true);
    expect(out.summary).toContain("林远");
    expect(out.characterState).toBeTruthy();
  });

  // E2E 实锤：模型常瞎造「protagonist-<拼音>」这类前缀 id 指代主角（真实 id 是 char-<hash>，绝不以此开头）。
  it("kind=character id=瞎造的 protagonist-<拼音> 前缀：仍解析到主角卡，不 found:false", async () => {
    const projectDir = await makeProject("瞎造前缀", "林远");
    const out = await readFoundationFragment({ projectDir, kind: "character", id: "protagonist-guoxu" });
    expect(out.found).toBe(true);
    expect(out.summary).toContain("林远");
  });

  it("kind=asset：读出资产清单", async () => {
    const projectDir = await makeProject("资产");
    await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "create_asset",
        category: "assets",
        targetFile: "story/assets.json",
        targetPath: "assets",
        after: { name: "青铜钥匙", status: "持有" },
        extractedEntityName: "青铜钥匙",
      },
    });
    const out = await readFoundationFragment({ projectDir, kind: "asset" });
    expect(out.found).toBe(true);
    // 喂模型的 data 已中文化：容器键 assets→「物品」、containers→「容器」（不再露英文键）。
    const data = out.data as Record<string, readonly unknown[]>;
    expect(Object.keys(data)).toContain("物品");
    expect(Object.keys(data)).not.toContain("assets");
    expect(data["物品"].length).toBeGreaterThanOrEqual(1);
  });

  it("kind=location：读出地点册，写入后能读到新地点", async () => {
    const projectDir = await makeProject("地点");
    const empty = await readFoundationFragment({ projectDir, kind: "location" });
    expect(empty.found).toBe(true);
    expect(empty.summary).toContain("0 个地点");

    await applyFoundationWriteSuggestion({
      projectDir,
      suggestion: {
        actionType: "create_location",
        category: "locations",
        targetFile: "story/location-bible.json",
        targetPath: "locations",
        after: { id: "loc-hall", name: "中庭大厅", type: "室内", narrativeFunction: "对峙场" },
      },
    });
    const out = await readFoundationFragment({ projectDir, kind: "location" });
    expect(out.found).toBe(true);
    expect(out.summary).toContain("中庭大厅");
  });

  it("kind=gap_report：返回完整度报告且 found 恒为 true", async () => {
    const projectDir = await makeProject("完整度");
    const out = await readFoundationFragment({ projectDir, kind: "gap_report" });
    expect(out.found).toBe(true);
    const report = out.data as { passed: boolean; readinessLevel: string };
    expect(typeof report.passed).toBe("boolean");
    expect(out.summary).toContain("就绪等级");
  });
});
