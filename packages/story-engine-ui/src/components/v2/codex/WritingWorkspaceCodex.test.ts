/**
 * WritingWorkspaceCodex — B5-3 轻量测试
 *
 * WritingWorkspaceCodex 本身依赖 localStorage / zustand store / 多个子面板，
 * 完整 DOM 渲染在 jsdom 下需大量 mock，成本过高。
 * 按 B5-3 brief 说明：「退而加一个断言 CATS 含 hooks 项的轻量测试 + 靠 build/typecheck 兜底」。
 *
 * 策略：WritingWorkspaceCodex.tsx 暴露 __CATS_FOR_TEST 命名导出，
 * 本测试直接断言 CATS 数组第 7 项为 hooks 类目。
 * build/typecheck（check-import-boundary + tsc + vite）兜底 JSX 渲染链路类型正确性。
 */

import { describe, it, expect } from "vitest";
import { __CATS_FOR_TEST, resolveRightPanelOpen } from "./WritingWorkspaceCodex.js";

describe("B5-3 CATS 数组含「伏笔线索」与「时间线」类目", () => {
  it("CATS 共 8 项", () => {
    expect(__CATS_FOR_TEST).toHaveLength(8);
  });

  it("含 hooks 类目，glyph / title / sub 与规格一致", () => {
    const hooksCat = __CATS_FOR_TEST.find((c) => c.id === "hooks");
    expect(hooksCat).toBeDefined();
    expect(hooksCat?.glyph).toBe("❖");
    expect(hooksCat?.title).toBe("伏笔线索");
    expect(hooksCat?.sub).toBe("未回收 / 已回收");
  });

  it("含 timeline 类目，glyph / title / sub 与规格一致", () => {
    const timelineCat = __CATS_FOR_TEST.find((c) => c.id === "timeline");
    expect(timelineCat).toBeDefined();
    expect(timelineCat?.glyph).toBe("▤");
    expect(timelineCat?.title).toBe("时间线");
    expect(timelineCat?.sub).toBe("近期 · 中段 · 远期");
  });

  it("timeline 是 CATS 的最后一项（append 不插队）", () => {
    const last = __CATS_FOR_TEST[__CATS_FOR_TEST.length - 1];
    expect(last?.id).toBe("timeline");
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
