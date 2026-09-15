import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CharacterMatrixLedger } from "@actalk/story-engine";
import { describe, expect, it } from "vitest";

import { NO_FACTS_RELATIONSHIP_SUMMARY, convertRelationshipsToMatrixUpdates, persistCharacterRoster } from "./generate-character-relationships.js";

describe("空事实失败文案（R2#2·铁律④诚实不误导）", () => {
  it("指对路：开书给具名角色登记关系走 foundation_write update_character_detail 写 relationshipToProtagonist", () => {
    expect(NO_FACTS_RELATIONSHIP_SUMMARY).toContain("update_character_detail");
    expect(NO_FACTS_RELATIONSHIP_SUMMARY).toContain("relationshipToProtagonist");
  });
});

describe("convertRelationshipsToMatrixUpdates → candidate updates", () => {
  it("把 GLM 人物转成 status:candidate 的 CharacterMatrixUpdate（id/firstSeenChapter 对）", () => {
    const updates = convertRelationshipsToMatrixUpdates(
      {
        characters: [{ name: "老赵", role: "债主" }],
        relationships: [{ from: "林远", to: "老赵", relationType: "债务", trust: "low" }],
      },
      47,
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      id: "matrix-老赵",
      name: "老赵",
      status: "candidate",
      firstSeenChapter: 47,
      lastSeenChapter: 47,
    });
  });

  it("空人物 → 空 updates（上层据此 ok:false）", () => {
    expect(
      convertRelationshipsToMatrixUpdates({ characters: [], relationships: [] }, 1),
    ).toEqual([]);
  });

  it("relationToProtagonist 取自该人物与主角的关系（主角=第一个关系的 from）", () => {
    const updates = convertRelationshipsToMatrixUpdates(
      {
        characters: [
          { name: "老赵", role: "债主" },
          { name: "阿明", role: "工友" },
        ],
        relationships: [
          { from: "林远", to: "老赵", relationType: "债务", trust: "low" },
          { from: "林远", to: "阿明", relationType: "工友", trust: "high" },
        ],
      },
      5,
    );
    const zhao = updates.find((u) => u.name === "老赵");
    const ming = updates.find((u) => u.name === "阿明");
    expect(zhao?.relationToProtagonist).toBe("债务");
    expect(ming?.relationToProtagonist).toBe("工友");
  });

  it("人物若与主角无直接关系 → relationToProtagonist 省略（不编造）", () => {
    const updates = convertRelationshipsToMatrixUpdates(
      {
        characters: [{ name: "路人甲", role: "邻居" }],
        relationships: [],
      },
      3,
    );
    expect(updates[0]?.relationToProtagonist).toBeUndefined();
  });
});


describe("persistCharacterRoster（P2 同名重复矩阵条目）", () => {
  it("无 id 的既有条目 + 同名更新 → 合并成一条，不重复", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "se-roster-"));
    const projectDir = join(rootDir, "proj");
    await mkdir(join(projectDir, "story"), { recursive: true });
    // 既有矩阵里有个没 id 的角色（老数据/未提升的候选）
    await writeFile(
      join(projectDir, "story", "character-matrix.json"),
      `${JSON.stringify({ version: "v0", entries: [
        { id: "", name: "顾长风", status: "candidate", firstSeenChapter: 2, lastSeenChapter: 2, evidence: ["第二章出场"] },
      ] }, null, 2)}\n`,
      "utf-8",
    );

    await persistCharacterRoster(projectDir, [
      { id: "", name: "顾长风", status: "accepted", evidence: ["新证据"], firstSeenChapter: 2, lastSeenChapter: 5 },
    ], 5);

    const after = JSON.parse(await readFile(join(projectDir, "story", "character-matrix.json"), "utf-8")) as CharacterMatrixLedger;
    const named = after.entries.filter((e) => e.name === "顾长风");
    expect(named).toHaveLength(1); // 此前会变成两条（undefined 键 + name 键各一条）
    expect(named[0]?.status).toBe("accepted");
    expect(named[0]?.evidence).toEqual(["第二章出场", "新证据"]);
    expect(named[0]?.lastSeenChapter).toBe(5);
  });

  it("有 id 的条目按 id 合并，同名不同 id 不串扰", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "se-roster-id-"));
    const projectDir = join(rootDir, "proj");
    await mkdir(join(projectDir, "story"), { recursive: true });
    await writeFile(
      join(projectDir, "story", "character-matrix.json"),
      `${JSON.stringify({ version: "v0", entries: [
        { id: "gu-cf", name: "顾长风", status: "accepted", firstSeenChapter: 1, lastSeenChapter: 3, evidence: [] },
        { id: "gu-cf2", name: "顾长风", status: "candidate", firstSeenChapter: 4, lastSeenChapter: 4, evidence: ["分身"] },
      ] }, null, 2)}\n`,
      "utf-8",
    );

    await persistCharacterRoster(projectDir, [
      { id: "gu-cf", name: "顾长风", status: "accepted", evidence: ["第五章"], firstSeenChapter: 1, lastSeenChapter: 5 },
    ], 5);

    const after = JSON.parse(await readFile(join(projectDir, "story", "character-matrix.json"), "utf-8")) as CharacterMatrixLedger;
    expect(after.entries).toHaveLength(2);
    const touched = after.entries.find((e) => e.id === "gu-cf");
    expect(touched?.lastSeenChapter).toBe(5);
    expect(touched?.evidence).toEqual(["第五章"]);
    const other = after.entries.find((e) => e.id === "gu-cf2");
    expect(other?.lastSeenChapter).toBe(4); // 没被误改
  });
});
