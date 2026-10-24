/**
 * WritingWorkspaceCodex — B5-3 轻量测试
 *
 * WritingWorkspaceCodex 本身依赖 localStorage / zustand store / 多个子面板，
 * 完整 DOM 渲染在 jsdom 下需大量 mock，成本过高。
 * 按 B5-3 brief 说明：「退而加一个断言 CATS 含 hooks 项的轻量测试 + 靠 build/typecheck 兜底」。
 *
 * 策略：WritingWorkspaceCodex.tsx 暴露 __CATS_FOR_TEST 命名导出，
 * 本测试直接断言类目顺序。
 * build/typecheck（check-import-boundary + tsc + vite）兜底 JSX 渲染链路类型正确性。
 */

import { describe, it, expect } from "vitest";
import { __CATS_FOR_TEST, buildChapterRows, chapterFootStatus, needsCommit, resolveRightPanelOpen } from "./WritingWorkspaceCodex.js";

describe("设定本类目（重构 P9：设定本按设定卡分，伏笔线索和故事地图照旧）", () => {
  it("打头是「这章改了什么」，接着是设定本八类（P12 加定论），最后是伏笔线索、故事地图", () => {
    expect(__CATS_FOR_TEST.map((c) => c.id)).toEqual([
      "changes", "story", "canon", "rules", "chars", "relations", "items", "places", "uncarded", "hooks", "timeline",
    ]);
  });

  it("每类都有标题和一行说明", () => {
    for (const cat of __CATS_FOR_TEST) {
      expect(cat.title.length).toBeGreaterThan(0);
      expect(cat.sub.length).toBeGreaterThan(0);
    }
    expect(__CATS_FOR_TEST.find((c) => c.id === "hooks")?.title).toBe("伏笔与线索");
    expect(__CATS_FOR_TEST.find((c) => c.id === "timeline")?.title).toBe("故事地图");
  });
});

// T3 复审返工：自动收起把展开钮做死（effectiveRightOpen = rightOpen && !aiAutoCollapsed，
// 点展开只翻内部 rightOpen，effectiveRightOpen 恒 false；变宽也不恢复）。裁决函数钉死新行为。
describe("T3 resolveRightPanelOpen：手动意愿覆盖自动收起", () => {
  it("未手动干预 + 视口够宽 → 展开", () => {
    expect(resolveRightPanelOpen(true, false, false)).toBe(true);
  });

  it("未手动干预 + 视口太窄 → 自动收成竖条", () => {
    expect(resolveRightPanelOpen(true, true, false)).toBe(false);
  });

  it("未手动干预时无状态记忆：同一判定在「窄→宽」后自然恢复展开（自动恢复）", () => {
    // 自动收起期间不翻 rightOpen，变宽后同一调用即回 true——不存在「翻成 false 卡住」。
    expect(resolveRightPanelOpen(true, true, false)).toBe(false);
    expect(resolveRightPanelOpen(true, false, false)).toBe(true);
  });

  it("窄视口下手动点展开 → 真的展开（复审返工点：展开钮不再死点击）", () => {
    expect(resolveRightPanelOpen(true, true, true)).toBe(true);
  });

  it("手动点收起 + 视口够宽 → 保持收起（变宽不擅自弹开）", () => {
    expect(resolveRightPanelOpen(false, false, true)).toBe(false);
  });

  it("手动收起后未再干预：窄视口仍收起", () => {
    expect(resolveRightPanelOpen(false, true, false)).toBe(false);
  });

  it("点击序列模拟：900px 自动收起 → 点展开真展开 → 变宽保持 → 再点收起（钉死真机回归）", () => {
    // 镜像组件 onToggleRight 接线：相对「当前实际显示态」翻 rightOpen 并记下手动标记。
    // 旧接线是 rightOpen := !rightOpen——自动收起期内部 rightOpen 仍为 true，一点就翻成 false，
    // 展开钮死点击（T3 返工的真机实证）。下面的序列在旧接线下第一步断言即红。
    let rightOpen = true;
    let manualToggled = false;
    let narrow = true;
    const effective = () => resolveRightPanelOpen(rightOpen, narrow, manualToggled);
    const clickToggle = () => { const next = !effective(); manualToggled = true; rightOpen = next; };

    expect(effective()).toBe(false); // 900px 未干预：自动收起
    clickToggle();
    expect(effective()).toBe(true);  // 点展开：手动意愿覆盖自动收起，真的展开
    narrow = false;
    expect(effective()).toBe(true);  // 变宽：手动展开意愿保留
    clickToggle();
    expect(effective()).toBe(false); // 宽窗点收起：收拢且不再自动弹开
  });
});

describe("改版 buildChapterRows：章节列表新章在上、每 10 章分组", () => {
  const ch = (n: number) => ({ id: `c${n}`, chapterNumber: n, title: `第${n}章 · 标题${n}`, status: "committed" as const });

  it("不搜索：倒序 + 分组标题，最后一组上限取最大章号", () => {
    const rows = buildChapterRows([ch(1), ch(2), ch(11), ch(12)], false);
    expect(rows.map((r) => (r.kind === "group" ? r.label : r.ch.chapterNumber))).toEqual(["第 11–12 章", 12, 11, "第 1–10 章", 2, 1]);
  });

  it("搜索：平铺不分组", () => {
    const rows = buildChapterRows([ch(3), ch(20)], true);
    expect(rows.every((r) => r.kind === "chapter")).toBe(true);
    expect(rows.map((r) => (r.kind === "chapter" ? r.ch.chapterNumber : 0))).toEqual([20, 3]);
  });

  it("只有一章的组标题不写成区间", () => {
    const rows = buildChapterRows([ch(21)], false);
    expect(rows[0]).toEqual({ kind: "group", key: "g2", label: "第 21 章" });
  });
});

describe("章节栏底部状态（P7 桌面包走查）", () => {
  it("新书一章都没定稿时不说「全部已定稿」", () => {
    expect(chapterFootStatus(0, 0)).toEqual({ dot: "", text: "还没有定稿的章" });
    expect(chapterFootStatus(0, 3)).toEqual({ dot: "ok", text: "全部已定稿" });
    expect(chapterFootStatus(2, 3)).toEqual({ dot: "warn", text: "2 章工作稿还没定稿" });
  });
});

describe("needsCommit（P11：底栏「N 章还没定稿」也算定稿后又改过的章）", () => {
  const ch = (status: "committed" | "draft" | "current" | "planned", editedSinceCommit?: boolean) => ({
    id: "ch-1", chapterNumber: 1, title: "x", status, ...(editedSinceCommit !== undefined ? { editedSinceCommit } : {}),
  });
  it("工作稿章、定稿后又改过的章要定稿；已定稿没改、还没写的不算", () => {
    expect(needsCommit(ch("draft"))).toBe(true);
    expect(needsCommit(ch("committed", true))).toBe(true);
    expect(needsCommit(ch("committed", false))).toBe(false);
    expect(needsCommit(ch("committed"))).toBe(false);
    expect(needsCommit(ch("planned", true))).toBe(false);
  });
});
