import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AiFlavorCard } from "./AiFlavorCard.js";
import { useDraftStore } from "../../../stores/draftStore.js";
import type { AiFlavorReport } from "../../../types.js";

afterEach(() => {
  cleanup();
  useDraftStore.getState().reset();
});

const REPORT: AiFlavorReport = {
  ok: true,
  summary: "有两处 AI 腔。",
  usedFallback: false,
  violations: [
    { id: "v1", text: "心中五味杂陈。", reason: "套路抒情", severity: "high", suggestedFix: "改具体" },
    { id: "v2", text: "仿佛一切都静止了。", reason: "滥用仿佛", severity: "medium", suggestedFix: "去掉仿佛" },
  ],
};

describe("AiFlavorCard", () => {
  it("稿纸开着这一章、原句已不在稿里（作者自己改了、在对话里让 AI 改了）：也算已改", () => {
    useDraftStore.getState().loadPaper("/book", { chapter: 30, draft: { body: "他心里一沉。仿佛一切都静止了。", version: "v1" }, committed: null } as never);
    render(<AiFlavorCard report={{ ...REPORT, chapter: 30 }} onFix={vi.fn()} />);
    expect(screen.getByText("1/2 已改")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /改掉这句/ })).toHaveLength(1);
  });

  it("稿纸开的是别的章：不拿它对照", () => {
    useDraftStore.getState().loadPaper("/book", { chapter: 29, draft: { body: "别的章。", version: "v1" }, committed: null } as never);
    render(<AiFlavorCard report={{ ...REPORT, chapter: 30 }} onFix={vi.fn()} />);
    expect(screen.getByText("0/2 已改")).toBeTruthy();
  });

  it("渲染总评+违规清单+进度，点「改掉这句」回传整条违规", () => {
    const onFix = vi.fn();
    const { container } = render(<AiFlavorCard report={REPORT} onFix={onFix} />);
    // 统一进 StepCard 外壳：暗金折叠卡 + 标题「去AI味」+ 徽章「N/M 已改」。
    expect(container.querySelector(".step-card")).toBeTruthy();
    expect(screen.getByText("检查机器腔")).toBeTruthy();
    expect(screen.getByText(/两处 AI 腔/)).toBeTruthy();
    expect(screen.getByText(/五味杂陈/)).toBeTruthy();
    expect(screen.getByText(/套路抒情/)).toBeTruthy();
    expect(screen.getByText("0/2 已改")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: /改掉这句/ })[0]);
    expect(onFix).toHaveBeenCalledWith(REPORT.violations[0]);
  });

  it("已改的违规标「已改 ✓」、置灰、收起「改掉这句」与原因；进度计数随之更新", () => {
    render(<AiFlavorCard report={REPORT} fixedIds={["v1"]} onFix={vi.fn()} />);
    expect(screen.getByText("已改 ✓")).toBeTruthy();
    expect(screen.getByText("1/2 已改")).toBeTruthy();
    // v1 已改：原因「套路抒情」与它的「改掉这句」都不再渲染；v2 仍有一个「改掉这句」。
    expect(screen.queryByText("套路抒情")).toBeNull();
    expect(screen.getAllByRole("button", { name: /改掉这句/ })).toHaveLength(1);
  });

  it("正在改写的违规显示「改写中…」、不显示「改掉这句」", () => {
    render(<AiFlavorCard report={REPORT} pendingViolationId="v2" onFix={vi.fn()} />);
    expect(screen.getByText("改写中…")).toBeTruthy();
    // 只剩 v1 的「改掉这句」（v2 改写中）。
    expect(screen.getAllByRole("button", { name: /改掉这句/ })).toHaveLength(1);
  });

  it("改写草案已生成、在等用户去写作台应用时显「待应用」（不再误标「改写中…」=系统已闲、在等人）", () => {
    // 生成中（preview 未就绪）：仍是「改写中…」。
    const { rerender } = render(<AiFlavorCard report={REPORT} pendingViolationId="v2" onFix={vi.fn()} />);
    expect(screen.getByText("改写中…")).toBeTruthy();
    expect(screen.queryByText("待应用")).toBeNull();
    // 草案已生成、等用户在写作台点「应用到草稿」：转「待应用」、不再显「改写中…」。
    rerender(<AiFlavorCard report={REPORT} pendingViolationId="v2" awaitingApply onFix={vi.fn()} />);
    expect(screen.getByText("待应用")).toBeTruthy();
    expect(screen.queryByText("改写中…")).toBeNull();
  });

  it("有违规时点明『文风体检·不拦入库』，避免与质检『可入库』读着自相矛盾（afterfix3）", () => {
    render(<AiFlavorCard report={REPORT} onFix={vi.fn()} />);
    expect(screen.getByText(/不影响定稿/)).toBeTruthy();
  });

  it("无违规时不显示『不拦入库』提示（无噪音）", () => {
    render(
      <AiFlavorCard
        report={{ ...REPORT, violations: [], summary: "没挑出明显 AI 腔。" }}
        onFix={vi.fn()}
      />,
    );
    expect(screen.queryByText(/不影响定稿/)).toBeNull();
  });

  it("空清单显示『没挑出明显 AI 腔』、无进度、无任何「改掉这句」", () => {
    render(
      <AiFlavorCard
        report={{ ...REPORT, violations: [], summary: "这章读着挺像人写的，没挑出明显 AI 腔。" }}
        onFix={vi.fn()}
      />,
    );
    expect(screen.getByText(/没挑出明显 AI 腔/)).toBeTruthy();
    expect(screen.queryByText(/已改$/)).toBeNull();
    expect(screen.queryByRole("button", { name: /改掉这句/ })).toBeNull();
  });

  it("usedFallback 时标注「用了通用判据」", () => {
    render(<AiFlavorCard report={{ ...REPORT, usedFallback: true }} onFix={vi.fn()} />);
    expect(screen.getByText(/通用判据/)).toBeTruthy();
  });

  it("一键全修：有未改违规+onFixAll → 显「一键全修剩余 N 处」，点了带【未改的违规】回调", () => {
    const onFixAll = vi.fn();
    render(<AiFlavorCard report={REPORT} onFixAll={onFixAll} />);
    fireEvent.click(screen.getByRole("button", { name: /一键全修剩余 2 处/ }));
    expect(onFixAll).toHaveBeenCalledTimes(1);
    expect(onFixAll.mock.calls[0][0].map((v: { id: string }) => v.id)).toEqual(["v1", "v2"]);
  });

  it("一键全修只算未改的：已改 v1 后剩余 1 处、回调只带 v2", () => {
    const onFixAll = vi.fn();
    render(<AiFlavorCard report={REPORT} fixedIds={["v1"]} onFixAll={onFixAll} />);
    fireEvent.click(screen.getByRole("button", { name: /一键全修剩余 1 处/ }));
    expect(onFixAll.mock.calls[0][0].map((v: { id: string }) => v.id)).toEqual(["v2"]);
  });

  it("batchPending → 按钮转「一键全修中…」、禁用、不可重复点", () => {
    const onFixAll = vi.fn();
    render(<AiFlavorCard report={REPORT} batchPending onFixAll={onFixAll} />);
    const btn = screen.getByRole("button", { name: /一键全修中…/ }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(onFixAll).not.toHaveBeenCalled();
  });

  it("全部已改 → 不显示一键全修按钮；没给 onFixAll 也不显示（向后兼容）", () => {
    const { rerender } = render(<AiFlavorCard report={REPORT} fixedIds={["v1", "v2"]} onFixAll={vi.fn()} />);
    expect(screen.queryByText(/一键全修/)).toBeNull();
    rerender(<AiFlavorCard report={REPORT} />);
    expect(screen.queryByText(/一键全修/)).toBeNull();
  });
});
