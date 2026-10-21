// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import AgentErrorCard, { agentErrorFriendlyBody } from "./AgentErrorCard.js";
import type { SuggestedAction } from "../../../type-defs/workflow.js";

const retryAction: SuggestedAction = {
  id: "retry-agent",
  label: "重试这一步",
  description: "重发",
  permission: "safe_read",
  requiresConfirmation: false,
  endpoint: "帮我写下一句",
};

describe("AgentErrorCard P0-1", () => {
  afterEach(() => cleanup());

  it("正文固定人话，不裸奔 provider 原文", () => {
    render(
      <AgentErrorCard
        detail="Error from provider (Console Go): Upstream request failed"
        retryAction={retryAction}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByText(agentErrorFriendlyBody())).toBeTruthy();
    expect(screen.queryByText(/Upstream request failed/)).toBeNull();
    expect(screen.getByRole("button", { name: "重试这一步" })).toBeTruthy();
  });

  it("技术详情默认收起，展开后才见原始错误", () => {
    render(
      <AgentErrorCard
        detail="Error from provider: boom"
        retryAction={retryAction}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.queryByText("Error from provider: boom")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "技术详情" }));
    expect(screen.getByText("Error from provider: boom")).toBeTruthy();
  });

  it("点「重试这一步」回调 retry-agent；chatLoading 时禁用", () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <AgentErrorCard retryAction={retryAction} onRetry={onRetry} chatLoading={false} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "重试这一步" }));
    expect(onRetry).toHaveBeenCalledWith(retryAction);

    rerender(<AgentErrorCard retryAction={retryAction} onRetry={onRetry} chatLoading />);
    expect(screen.getByRole("button", { name: "重试这一步" })).toBeDisabled();
  });

  it("P11：按原因说人话；没接上 / 密钥不对给「去设置」，重试降为次要", () => {
    const onOpenSettings = vi.fn();
    render(<AgentErrorCard reason="auth" retryAction={retryAction} onRetry={vi.fn()} onOpenSettings={onOpenSettings} />);
    expect(screen.getByText(agentErrorFriendlyBody("auth"))).toBeTruthy();
    expect(agentErrorFriendlyBody("auth")).toContain("密钥");
    fireEvent.click(screen.getByRole("button", { name: "去设置" }));
    expect(onOpenSettings).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "重试这一步" }).className).toBe("aec-detail-toggle");
  });

  it("P11：网络 / 欠费这类不给「去设置」", () => {
    render(<AgentErrorCard reason="network" retryAction={retryAction} onRetry={vi.fn()} onOpenSettings={vi.fn()} />);
    expect(screen.getByText(agentErrorFriendlyBody("network"))).toBeTruthy();
    expect(screen.queryByRole("button", { name: "去设置" })).toBeNull();
  });
});
