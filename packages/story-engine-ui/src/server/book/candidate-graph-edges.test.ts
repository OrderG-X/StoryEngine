// @vitest-environment node
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createStoryProject } from "./project-store.js";
import { buildStateOverview } from "./state-overview.js";
import type { StateOverviewCharacterRelationship } from "./state-overview.js";
import type { CharacterMatrixLedger } from "./types.js";

/**
 * 回归：候选角色(status:candidate)的关系边渲染不出来。
 *
 * 病根——toCharacterMatrix 把候选边并进 matrix 顶层 relationships 时，用的是候选节点自身的
 * .relationships(候选→主角，target=主角)，而正式边是「主角→对方」(target=对方)。
 * flatten 后候选边丢了来源方向 → UI 的 characterGraph from(默认主角)→to(主角) 成自环被跳过
 * → 关系网 0 条边。
 *
 * 修法——候选边改主角视角(target=候选)，与正式边同构 → 主角—候选非自环 → 画得出带标签边。
 *
 * 注：characterGraph 在 UI 包(story-engine-ui)，引擎包 tsc 的 rootDir=src 不能跨包 import，
 * 否则会破 build/typecheck。这里内联一个忠实复刻 characterGraph.ts 第 98-101 行端点解析+
 * 自环跳过规则的最小图模型，断言候选边非自环、真能画。
 */

interface MiniGraphCharacter {
  readonly id: string;
  readonly name: string;
  readonly role: string;
}

/** 忠实复刻 characterGraph.ts buildCharacterGraphModel 的端点解析与自环跳过逻辑（仅算边数）。 */
function countDrawableEdges(
  characters: readonly MiniGraphCharacter[],
  relationships: readonly StateOverviewCharacterRelationship[],
): number {
  const protagonist = characters.find((c) => c.role.includes("主角")) ?? characters[0];
  const others = characters.filter((c) => c.id !== protagonist?.id);
  const pos = new Map<string, { readonly x: number; readonly y: number }>();
  const place = (c: MiniGraphCharacter, x: number, y: number): void => {
    pos.set(c.id, { x, y });
    if (c.name.trim()) pos.set(c.name, { x, y });
  };
  if (protagonist) place(protagonist, 0, 0);
  others.forEach((c, i) => place(c, 100 + i, 200 + i)); // 任意互不相同的非原点坐标
  const resolve = (key?: string): { readonly x: number; readonly y: number } | undefined =>
    key?.trim() ? pos.get(key.trim()) : undefined;

  let count = 0;
  for (const r of relationships) {
    const from = (protagonist ? pos.get(protagonist.id) : undefined); // 候选/正式边都无 pairFrom → 默认主角
    const to = resolve(r.targetCharacterId) ?? resolve(r.targetName);
    if (!from || !to) continue;
    if (from.x === to.x && from.y === to.y) continue; // 自指/同端点 → 跳过（病根命中处）
    count += 1;
  }
  return count;
}

describe("候选角色关系边渲染（关系网自环回归）", () => {
  it("matrix 顶层 relationships 含一条 主角→候选 边、且能画出非自环边", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "candidate-graph-edges-"));
    const { projectDir } = await createStoryProject({
      rootDir,
      title: "候选关系网测试",
      genre: "现实",
      premise: "林远在城里追查一笔旧账。",
      mainCharacterName: "林远",
    });

    // 写入一个候选角色：老赵，与主角是「债务」关系。
    const matrix: CharacterMatrixLedger = {
      version: "v0",
      entries: [
        {
          id: "matrix-lao-zhao",
          name: "老赵",
          status: "candidate",
          roleHint: "债主",
          relationToProtagonist: "债务，林远欠他一笔旧账",
          riskHint: "身份待补全",
          firstSeenChapter: 2,
          lastSeenChapter: 5,
          evidence: ["第2章茶馆里提到借条"],
          appearances: [{ chapter: 2, evidence: "茶馆", location: "城南茶馆" }],
          relationshipEvents: [{ chapter: 2, relationToProtagonist: "债务", evidence: "借条" }],
        },
      ],
    };
    await writeFile(
      join(projectDir, "story", "character-matrix.json"),
      `${JSON.stringify(matrix, null, 2)}\n`,
      "utf-8",
    );

    const overview = await buildStateOverview({ projectDir, maxTimelineEvents: 8 });
    const characterMatrix = overview.characterMatrix;

    // 节点里既有主角也有候选老赵。
    const names = characterMatrix.characters.map((c) => c.name);
    expect(names).toContain("林远");
    expect(names).toContain("老赵");

    // 顶层 relationships 里有一条 主角→候选(targetName==="老赵") 的边，relationType 非空。
    const candidateEdge = characterMatrix.relationships.find((r) => r.targetName === "老赵");
    expect(candidateEdge, "候选边应以主角视角并入(target=候选老赵)，而非主角→主角自环").toBeDefined();
    expect(candidateEdge?.relationType?.trim()).toBeTruthy();
    // 不应再出现 主角→主角 自指边（病根产物）。
    expect(characterMatrix.relationships.every((r) => r.targetName !== "林远")).toBe(true);

    // 再过一道 characterGraph 端点解析：候选边真能画(非自环被跳)。
    const drawable = countDrawableEdges(
      characterMatrix.characters.map((c) => ({ id: c.id, name: c.name, role: c.role })),
      characterMatrix.relationships,
    );
    expect(drawable).toBeGreaterThanOrEqual(1);
  });
});
