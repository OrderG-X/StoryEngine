import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createStoryProject } from "../project-store.js";
import { buildStateOverview } from "../state-overview.js";

/**
 * Phase 2 canonical 接线集成测试：验 toCharacterMatrix 用上 resolver。
 * - 职能(A)：extraFields["叙事岗位"] 优先于 bible role。
 * - 信任(B)：关系 trustLevel→派生 trustPercent（high=85）。
 * - 关系去重(C)：attitude===relationType 时 attitude 不出现。
 */
describe("canonical 接线 · toCharacterMatrix", () => {
  it("职能取叙事岗位优先、关系派生 trustPercent、attitude 去重", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "canonical-wiring-"));
    const { projectDir } = await createStoryProject({
      rootDir,
      title: "canonical 接线测试",
      genre: "现实",
      premise: "林远与盟友苏晴并肩。",
      mainCharacterName: "林远",
    });

    // 读现有 bible（含主角林远），加一个正式盟友苏晴：做厚「叙事岗位」+ 与主角「信任」关系。
    const biblePath = join(projectDir, "story", "character-bible.json");
    const bible = JSON.parse(await readFile(biblePath, "utf-8")) as {
      characters: Record<string, unknown>[];
    };
    bible.characters.push({
      id: "char-suqing",
      name: "苏晴",
      role: "配角",
      extraFields: { 叙事岗位: "主要盟友" },
      relationshipToProtagonist: "信任",
      trustLevel: "high",
    });
    await writeFile(biblePath, `${JSON.stringify(bible, null, 2)}\n`, "utf-8");

    const overview = await buildStateOverview({ projectDir, maxTimelineEvents: 8 });
    const matrix = overview.characterMatrix;

    // A·职能：苏晴的 role 取「叙事岗位」(主要盟友)，不是 bible 的「配角」。
    const suqing = matrix.characters.find((c) => c.name === "苏晴");
    expect(suqing, "苏晴应在矩阵里").toBeDefined();
    expect(suqing?.role).toBe("主要盟友");

    // B+C·关系：主角→苏晴 的边，关系类型就是作者写的原文；信任度只认卡上的 trustLevel=high→trustPercent=85。
    const edge = matrix.relationships.find((r) => r.targetName === "苏晴");
    expect(edge, "应有 主角→苏晴 的关系边").toBeDefined();
    expect(edge?.relationType).toBe("信任");
    expect(edge?.trustLevel).toBe("high");
    expect(edge?.trustPercent).toBe(85);
    expect(edge?.attitude).toBeUndefined();
  });
});
