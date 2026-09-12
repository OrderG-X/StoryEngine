import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import UsageDialog from "./UsageDialog.js";

afterEach(() => cleanup());

describe("UsageDialog", () => {
  it("renders an empty usage summary without crashing", () => {
    render(
      <UsageDialog
        onClose={vi.fn()}
        summary={{
          diagnosticsAvailable: false,
          diagnosticsCount: 0,
          diagnosticsWarnings: [],
          totalTokens: 0,
          promptTokens: 0,
          completionTokens: 0,
          cacheHitTokens: null,
          cacheMissTokens: null,
          cacheHitRatio: null,
          recent: [],
        }}
      />,
    );

    expect(screen.getByText("暂无 diagnostics 用量记录。流式生成工作稿时可能无法返回 provider usage。")).toBeInTheDocument();
  });

  it("renders diagnostics warnings as controlled compatibility notes", () => {
    render(
      <UsageDialog
        onClose={vi.fn()}
        summary={{
          diagnosticsAvailable: true,
          diagnosticsCount: 1,
          diagnosticsWarnings: ["diagnostics_file_count_limit", "diagnostics_file_size_limit"],
          totalTokens: 30,
          promptTokens: 10,
          completionTokens: 20,
          cacheHitTokens: null,
          cacheMissTokens: null,
          cacheHitRatio: null,
          recent: [{
            stage: "fast-draft",
            chapter: 1,
            generatedAt: "2026-05-29T12:00:00.000Z",
            totalTokens: 30,
            promptTokens: 10,
            completionTokens: 20,
            cacheHitRatio: null,
            elapsedMs: 900,
          }],
        }}
      />,
    );

    expect(document.body.textContent).toContain("diagnostics_file_count_limit");
    expect(document.body.textContent).toContain("diagnostics_file_size_limit");
    expect(screen.queryByText("/Users/author/Documents")).toBeNull();
  });
});
