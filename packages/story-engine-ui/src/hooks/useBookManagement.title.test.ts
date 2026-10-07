import { describe, expect, it } from "vitest";
import { titleFromEvent } from "./useBookManagement.js";

describe("titleFromEvent：书架「上次写到」显示章名", () => {
  it("有真章名用章名（剥掉第N章前缀）", () => {
    expect(titleFromEvent({ chapter: 58, title: "第58章 · 西侧二层", summary: "周屿在梧桐街九号西侧二层空屋的窗缝和墙脚缝里…" }, 58)).toBe("西侧二层");
  });
  it("没有章名或只是占位 → 退回事件摘要（截 18 字）", () => {
    expect(titleFromEvent({ chapter: 49, title: "待补", summary: "短摘要" }, 49)).toBe("短摘要");
    expect(titleFromEvent({ chapter: 3, summary: "一二三四五六七八九十一二三四五六七八九十" }, 3)).toBe("一二三四五六七八九十一二三四五六七八…");
  });
  it("什么都没有 → 第N章", () => {
    expect(titleFromEvent(undefined, 7)).toBe("第7章");
  });
});
