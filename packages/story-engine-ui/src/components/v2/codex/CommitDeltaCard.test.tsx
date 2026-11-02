// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommitDeltaCard } from "./CommitDeltaCard.js";

afterEach(() => cleanup());

describe("CommitDeltaCard 定稿回执", () => {
  it("只说第几章、定没定、账记没记上，不列条数", () => {
    const { container, getByText } = render(<CommitDeltaCard report={{ chapter: 4, status: "ready" }} />);
    expect(container.querySelector(".step-card.sc-done")).toBeTruthy();
    expect(getByText("第 4 章")).toBeTruthy();
    expect(getByText("已定稿")).toBeTruthy();
    cleanup();
    expect(render(<CommitDeltaCard report={{ chapter: 4, status: "pending" }} />).getByText("账待记")).toBeTruthy();
    cleanup();
    expect(render(<CommitDeltaCard report={{ chapter: 4, fill: true, status: "ready" }} />).getByText("已补账")).toBeTruthy();
  });

  it("老回执（带条数）、脏输入不崩", () => {
    expect(render(<CommitDeltaCard report={{ chapter: 2, ledger: { facts: 3 } }} />).getByText("第 2 章")).toBeTruthy();
    cleanup();
    expect(render(<CommitDeltaCard report={undefined} />).getByText("定稿")).toBeTruthy();
  });

  it("给了「补记账」才出，点了交那一章", () => {
    const onFill = vi.fn();
    const { getByText } = render(<CommitDeltaCard report={{ chapter: 5, status: "pending" }} onFill={onFill} />);
    fireEvent.click(getByText("补记账"));
    expect(onFill).toHaveBeenCalledWith(5);
    cleanup();
    expect(render(<CommitDeltaCard report={{ chapter: 5, status: "pending" }} />).queryByText("补记账")).toBeNull();
  });
});

describe("CommitDeltaCard 撤销这次定稿", () => {
  it("先确认再撤；点「算了」不撤；没有撤销能力就不出按钮", () => {
    const onUndo = vi.fn();
    const { getByText, queryByText } = render(<CommitDeltaCard report={{ chapter: 1 }} onUndo={onUndo} />);
    fireEvent.click(getByText("撤销这次定稿"));
    expect(onUndo).not.toHaveBeenCalled();
    fireEvent.click(getByText("算了"));
    expect(queryByText("撤销定稿")).toBeNull();
    fireEvent.click(getByText("撤销这次定稿"));
    fireEvent.click(getByText("撤销定稿"));
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it("不传 onUndo 时不渲染撤销按钮", () => {
    const { queryByText } = render(<CommitDeltaCard report={{ chapter: 1 }} />);
    expect(queryByText("撤销这次定稿")).toBeNull();
  });
});
