// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StepCard } from "./StepCard.js";

describe("StepCard 共享外壳", () => {
  it("渲染标题 + 默认徽章文字（按 status 映射）", () => {
    const { container, getByText } = render(<StepCard title="质检" status="done"><p>x</p></StepCard>);
    expect(getByText("质检")).toBeTruthy();
    expect(getByText("已完成")).toBeTruthy();
    expect(container.querySelector(".step-card.sc-done")).toBeTruthy();
  });

  it("statusLabel 覆盖默认徽章", () => {
    const { getByText } = render(<StepCard title="入库" status="done" statusLabel="已入库"><p>x</p></StepCard>);
    expect(getByText("已入库")).toBeTruthy();
  });

  it("四态各自有 class", () => {
    for (const [status, cls] of [["running", "sc-running"], ["attention", "sc-attention"], ["failed", "sc-failed"]] as const) {
      const { container } = render(<StepCard title="t" status={status}><p>x</p></StepCard>);
      expect(container.querySelector(`.step-card.${cls}`)).toBeTruthy();
    }
  });

  it("defaultOpen=true 显示 body；点头部折叠后隐藏", () => {
    const { container } = render(<StepCard title="t" status="done" defaultOpen><p>正文内容</p></StepCard>);
    expect(container.querySelector(".sc-body")).toBeTruthy();
    fireEvent.click(container.querySelector("button.sc-head") as HTMLButtonElement);
    expect(container.querySelector(".sc-body")).toBeNull();
  });

  it("defaultOpen=false 初始隐藏 body", () => {
    const { container } = render(<StepCard title="t" status="done" defaultOpen={false}><p>x</p></StepCard>);
    expect(container.querySelector(".sc-body")).toBeNull();
  });

  it("无 children 时不可折叠、无 caret、无 body", () => {
    const { container } = render(<StepCard title="t" status="done" />);
    expect(container.querySelector(".sc-caret")).toBeNull();
    expect(container.querySelector(".sc-body")).toBeNull();
    expect((container.querySelector("button.sc-head") as HTMLButtonElement).disabled).toBe(true);
  });

  it("elapsedMs>0 渲染计时", () => {
    const { getByText } = render(<StepCard title="t" status="done" elapsedMs={6000}><p>x</p></StepCard>);
    expect(getByText("6 秒")).toBeTruthy();
  });
});
