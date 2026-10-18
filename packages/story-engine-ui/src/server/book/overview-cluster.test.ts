// @vitest-environment node
/**
 * B2-3: overview 读侧近重复聚类折叠测试
 *
 * TDD 先写测试、跑确认失败、再实现。
 */
import { describe, expect, it } from "vitest";
import { clusterNearDuplicates } from "./state-overview.js";

// ---------------------------------------------------------------------------
// 辅助：最小 thread 骨架（只需 id + title）
// ---------------------------------------------------------------------------
function makeThread(id: string, title: string) {
  return { id, title } as const;
}

describe("clusterNearDuplicates", () => {
  // -------------------------------------------------------------------------
  // ① 正例：真高重叠近同句 → 聚成 1 条代表 + relatedCount >= 2
  // -------------------------------------------------------------------------
  it("① 正例：高重叠近同句应聚成 1 个 cluster，relatedCount=2", () => {
    const items = [
      makeThread("t1", "不连续的响动"),
      makeThread("t2", "不连续的响动声"),
      makeThread("t3", "听到不连续的响动"),
    ];

    const clusters = clusterNearDuplicates(items, 0.5);

    // 三条合并为 1 个 cluster
    expect(clusters).toHaveLength(1);
    // 代表项是第一条（保序）
    expect(clusters[0]!.rep.id).toBe("t1");
    // relatedCount 反映被吸收的数量
    expect(clusters[0]!.relatedCount).toBeGreaterThanOrEqual(2);
  });

  // -------------------------------------------------------------------------
  // ② 反例（核心）：词面分散的不同伏笔 → 各自独立，绝不被聚掉
  // -------------------------------------------------------------------------
  it("② 反例（anti-cluster）：「父亲的债」「邻居的债」「工地的响动」应各自独立", () => {
    const items = [
      makeThread("a1", "父亲的债"),
      makeThread("a2", "邻居的债"),
      makeThread("a3", "工地的响动"),
    ];

    const clusters = clusterNearDuplicates(items, 0.5);

    // 三条各自独立 → 3 个 cluster
    expect(clusters).toHaveLength(3);
    // 每条 relatedCount=0（没有被吸收的邻居）
    expect(clusters.every((c) => c.relatedCount === 0)).toBe(true);
    // 代表项 id 保序
    expect(clusters.map((c) => c.rep.id)).toEqual(["a1", "a2", "a3"]);
  });

  // -------------------------------------------------------------------------
  // 边界：空列表
  // -------------------------------------------------------------------------
  it("空列表返回空数组", () => {
    expect(clusterNearDuplicates([], 0.5)).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 边界：单条
  // -------------------------------------------------------------------------
  it("单条 → 1 个 cluster，relatedCount=0", () => {
    const clusters = clusterNearDuplicates([makeThread("x", "父亲的债")], 0.5);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.relatedCount).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 保代表 id：diagnosticsByThread.get(rep.id) 语义依赖
  // -------------------------------------------------------------------------
  it("代表项 id 是 cluster 第一条（保 selectRelevant 排序）", () => {
    const items = [
      makeThread("first", "不连续的响动"),
      makeThread("second", "不连续的响动声"),
    ];
    const clusters = clusterNearDuplicates(items, 0.5);
    expect(clusters[0]!.rep.id).toBe("first");
  });
});
