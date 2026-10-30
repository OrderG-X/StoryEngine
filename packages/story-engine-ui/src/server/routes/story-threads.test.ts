import { describe, expect, it } from "vitest";
import type { BookProjection } from "@actalk/story-core";
import { toThreadBoard } from "./story-threads.js";

type Thread = BookProjection["threads"][number];

const thread = (over: Partial<Thread> & Pick<Thread, "id" | "status">): Thread => ({
  type: "question",
  title: over.id,
  idleChapters: 0,
  openedAt: 1,
  lastTouchedAt: 1,
  weight: "normal",
  touches: [{ chapter: 1, op: "open", note: "埋", entry: "c1-1" }],
  mergedFrom: [],
  ...over,
});

describe("伏笔看板数据（重构 P6）", () => {
  it("四种状态原样给；停了几章＝算到的章 − 最近一笔；原句有才带，账单条目编号不外传", () => {
    const board = toThreadBoard({
      upTo: 10,
      threads: [
        thread({ id: "a", status: "stale", lastTouchedAt: 3, touches: [{ chapter: 3, op: "open", note: "钥匙开什么", quote: "一把铜钥匙", entry: "c3-2" }] }),
        thread({ id: "b", status: "closed", openedAt: 2, lastTouchedAt: 8, closedAt: 8, closedBy: "author" }),
      ],
    });
    expect(board.upTo).toBe(10);
    expect(board.threads.find((item) => item.id === "a")).toMatchObject({
      status: "stale",
      idle: 7,
      touches: [{ chapter: 3, op: "open", note: "钥匙开什么", quote: "一把铜钥匙" }],
    });
    expect(JSON.stringify(board)).not.toContain("c3-2");
    expect(board.threads.find((item) => item.id === "b")).toMatchObject({ closedAt: 8, closedBy: "author" });
    expect(board.threads.find((item) => item.id === "b")!.touches[0]).not.toHaveProperty("quote");
  });

  it("排序：分量重的先；停太久的里停得久的先；其余最近动过的先", () => {
    const board = toThreadBoard({
      upTo: 12,
      threads: [
        thread({ id: "minor-new", status: "active", weight: "minor", lastTouchedAt: 12 }),
        thread({ id: "stale-short", status: "stale", lastTouchedAt: 6 }),
        thread({ id: "stale-long", status: "stale", lastTouchedAt: 2 }),
        thread({ id: "major-old", status: "open", weight: "major", lastTouchedAt: 1 }),
        thread({ id: "normal-new", status: "active", lastTouchedAt: 11 }),
      ],
    });
    expect(board.threads.map((item) => item.id)).toEqual(["major-old", "normal-new", "stale-long", "stale-short", "minor-new"]);
  });
});
