import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import HookCodexPanel from "./HookCodexPanel.js";
import type { StateOverviewHookItem, StateOverviewThreadItem } from "../../../api/types.js";

afterEach(() => cleanup());

// ── fixture 数据 ─────────────────────────────────────────────────────────────

const MAJOR_HOOK: StateOverviewHookItem = {
  id: "hook-1",
  title: "老赵借条的秘密",
  status: "active",
  size: "major",
  firstSeenChapter: 3,
  lastTouchedChapter: 10,
};

const MINOR_THREAD: StateOverviewThreadItem = {
  id: "thread-1",
  title: "父亲的负债线索",
  status: "open",
  size: "minor",
  relatedCount: 5,
};

const RESOLVED_HOOK: StateOverviewHookItem = {
  id: "hook-resolved",
  title: "失踪的密道入口",
  status: "resolved",
  size: "major",
  firstSeenChapter: 7,
  resolvedAtChapter: 22,
};

// ── mock fetchForeshadowingOverrides ─────────────────────────────────────────

vi.mock("../../../api/foreshadowingOverridesClient.js", () => ({
  fetchForeshadowingOverrides: vi.fn().mockResolvedValue({}),
}));

import { fetchForeshadowingOverrides } from "../../../api/foreshadowingOverridesClient.js";

// ── 基础渲染断言 ──────────────────────────────────────────────────────────────

describe("HookCodexPanel 基础渲染", () => {
  it("major hook 显示大伏笔 badge + 章号 + 已回收计数", () => {
    render(
      <HookCodexPanel
        hookItems={[MAJOR_HOOK]}
        threadItems={[MINOR_THREAD]}
        resolvedHookCount={2}
        doneThreadCount={0}
        projectPath={null}
      />,
    );

    // 大伏笔 badge
    expect(screen.getAllByText(/大伏笔/).length).toBeGreaterThan(0);

    // 章号信息（文本跨多 span 子节点，用 body.textContent 兜底）
    expect(document.body.textContent).toMatch(/第3章埋/);

    // relatedCount
    expect(document.body.textContent).toMatch(/\+5 条相关/);

    // 已回收计数（stats 胶囊显示 2）
    expect(document.body.textContent).toMatch(/已回收.*2/);
  });

  it("minor thread 显示小线索 badge", () => {
    render(
      <HookCodexPanel
        hookItems={[]}
        threadItems={[MINOR_THREAD]}
        resolvedHookCount={0}
        doneThreadCount={0}
        projectPath={null}
      />,
    );
    expect(screen.getAllByText(/小线索/).length).toBeGreaterThan(0);
  });

  it("已回收 hook 显示章号范围「第N章埋 → 第M章回收」并落在已回收桶", () => {
    render(
      <HookCodexPanel
        hookItems={[RESOLVED_HOOK]}
        threadItems={[]}
        resolvedHookCount={1}
        doneThreadCount={0}
        projectPath={null}
      />,
    );
    // 章号文本可能跨 span 子节点，用 body.textContent 兜底
    expect(document.body.textContent).toMatch(/第7章埋.*第22章回收/);
  });

  it("无活跃项时显示空态虚线框", () => {
    render(
      <HookCodexPanel
        hookItems={[]}
        threadItems={[]}
        resolvedHookCount={0}
        doneThreadCount={0}
        projectPath={null}
      />,
    );
    expect(screen.getByText(/还没有伏笔线索/)).toBeInTheDocument();
  });

  it("字段缺失时不显示章号（降级隐藏，不造假）", () => {
    const hookNoChapter: StateOverviewHookItem = {
      id: "hook-nochap",
      title: "无章号线索",
      status: "active",
    };
    render(
      <HookCodexPanel
        hookItems={[hookNoChapter]}
        threadItems={[]}
        resolvedHookCount={0}
        doneThreadCount={0}
        projectPath={null}
      />,
    );
    expect(screen.getByText(/进行中/)).toBeInTheDocument();
    expect(screen.queryByText(/第.*章埋/)).toBeNull();
  });
});

// ── override 生效测试 ─────────────────────────────────────────────────────────

describe("HookCodexPanel override 生效", () => {
  beforeEach(() => {
    vi.mocked(fetchForeshadowingOverrides).mockResolvedValue({ "hook-1": "minor" });
  });

  afterEach(() => {
    vi.mocked(fetchForeshadowingOverrides).mockResolvedValue({});
  });

  it("override 把 major hook 改成小线索显示", async () => {
    render(
      <HookCodexPanel
        hookItems={[MAJOR_HOOK]}
        threadItems={[]}
        resolvedHookCount={0}
        doneThreadCount={0}
        projectPath="/some/project"
      />,
    );

    // 等 override 生效：等待 .tag.warn（大伏笔）badge 消失
    await waitFor(() => {
      const warnBadges = document.querySelectorAll(".tag.warn");
      expect(warnBadges).toHaveLength(0);
    });

    // 小线索 badge span 应出现（override 生效后 hook 变为 minor）
    const minorBadgeSpans = document.querySelectorAll("span.tag");
    const hasMinorBadge = Array.from(minorBadgeSpans).some((el) => el.textContent?.includes("小线索"));
    expect(hasMinorBadge).toBe(true);
  });
});
