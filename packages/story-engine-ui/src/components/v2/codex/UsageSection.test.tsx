import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UsageSummaryView, UsageTotalsView } from "../../../api/usageClient.js";
import { formatCost, formatTokens, UsageSection } from "./UsageSection.js";

afterEach(cleanup);

const totals = (input: number, output: number, extra: Partial<UsageTotalsView> = {}): UsageTotalsView => ({ calls: 1, input, cachedInput: 0, output, reasoning: 0, unpriced: true, ...extra });

function summary(): UsageSummaryView {
  return {
    today: totals(12_000, 3_000),
    month: totals(2_000_000, 500_000, { cost: 8.123, unpriced: true }),
    days: Array.from({ length: 30 }, (_, i) => ({ date: `2026-10-${String(i + 1).padStart(2, "0")}`, ...totals(i === 29 ? 12_000 : 0, 0, { calls: i === 29 ? 1 : 0 }) })),
    byBook: [{ key: "/b/fog", title: "雾港来信", ...totals(10_000, 2_000) }, { key: "", title: "", ...totals(100, 0) }],
    byTask: [{ key: "fastDraft", ...totals(9_000, 1_000) }, { key: "other", ...totals(5, 5) }],
    byModel: [{ key: "glm|glm-5", provider: "glm", providerLabel: "智谱", model: "glm-5", ...totals(12_000, 3_000) }],
  };
}

describe("设置 · 用量（P10）", () => {
  it("数字好读：万 / 亿；钱没填单价就不写", () => {
    expect(formatTokens(9_999)).toBe("9999");
    expect(formatTokens(15_000)).toBe("1.5 万");
    expect(formatTokens(230_000_000)).toBe("2.30 亿");
    expect(formatCost(totals(1, 1))).toBe("");
    expect(formatCost(totals(1, 1, { cost: 0.004 }))).toBe("不到 ¥0.01");
    expect(formatCost(totals(1, 1, { cost: 3.456 }))).toBe("约 ¥3.46");
  });

  it("今天 / 本月、按书 / 功能分列；没归到书、其他如实写", async () => {
    render(<UsageSection api={{ fetchUsage: vi.fn(async () => summary()), saveUsagePrice: vi.fn() }} />);
    expect(await screen.findByText("1.5 万")).toBeInTheDocument();
    expect(screen.getByText("约 ¥8.12（有模型没填单价）")).toBeInTheDocument();
    expect(screen.getByText("《雾港来信》")).toBeInTheDocument();
    expect(screen.getByText("没归到书")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "按功能" }));
    expect(screen.getByText("正文生成")).toBeInTheDocument();
    expect(screen.getByText("其他")).toBeInTheDocument();
  });

  it("按模型填单价：数字不对不让存；存了重读", async () => {
    const fetchUsage = vi.fn(async () => summary());
    const saveUsagePrice = vi.fn(async () => undefined);
    render(<UsageSection api={{ fetchUsage, saveUsagePrice }} />);
    fireEvent.click(await screen.findByRole("button", { name: "按模型" }));
    fireEvent.click(screen.getByRole("button", { name: "填单价" }));
    fireEvent.change(screen.getByLabelText("输入单价"), { target: { value: "4" } });
    fireEvent.change(screen.getByLabelText("输出单价"), { target: { value: "abc" } });
    expect(screen.getByRole("button", { name: "存" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("输出单价"), { target: { value: "16" } });
    fireEvent.click(screen.getByRole("button", { name: "存" }));
    await vi.waitFor(() => expect(saveUsagePrice).toHaveBeenCalledWith("glm|glm-5", { input: 4, output: 16 }));
    await vi.waitFor(() => expect(fetchUsage).toHaveBeenCalledTimes(2));
  });
});
