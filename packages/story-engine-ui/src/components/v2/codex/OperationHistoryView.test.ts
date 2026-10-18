import { describe, expect, it } from "vitest";
import { groupSnapshotsByDay, snapshotKind } from "./OperationHistoryView.js";

const at = (y: number, m: number, d: number, h = 12) => Math.floor(new Date(y, m - 1, d, h).getTime() / 1000);

describe("改版 groupSnapshotsByDay：操作历史按自然日分组", () => {
  const now = new Date(2026, 9, 7, 15);

  it("今天 / 昨天 / 今年其他日子 / 往年，组顺序跟随输入（新的在前）", () => {
    const groups = groupSnapshotsByDay([
      { id: "a", timestamp: at(2026, 10, 7, 14) },
      { id: "b", timestamp: at(2026, 10, 7, 9) },
      { id: "c", timestamp: at(2026, 10, 6) },
      { id: "d", timestamp: at(2026, 10, 5) },
      { id: "e", timestamp: at(2025, 12, 31) },
    ], now);
    expect(groups.map((g) => g.day)).toEqual(["今天", "昨天", "10 月 5 日", "2025 年 12 月 31 日"]);
    expect(groups[0]?.items.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("空列表 → 空分组", () => {
    expect(groupSnapshotsByDay([], now)).toEqual([]);
  });
});

describe("改版 snapshotKind：操作历史筛选分类", () => {
  it("用服务端给的分类，老服务端没给时算正文改动", () => {
    expect(snapshotKind({ kind: "commit" })).toBe("commit");
    expect(snapshotKind({ kind: "restore" })).toBe("restore");
    expect(snapshotKind({})).toBe("draft");
  });
});
