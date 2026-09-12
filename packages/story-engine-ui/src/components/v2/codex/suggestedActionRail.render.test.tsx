// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { mockSidebarData, mockWorkspaceData } from "../../../mockData.js";
import type { ChapterMessage, WritingWorkspaceLayoutProps } from "../../../types.js";
import type { SuggestedAction } from "../../../type-defs/workflow.js";
import AiChatCodex from "./AiChatCodex.js";

// A-6 建议条 rail JSX 渲染（复审 T6 缺口：此前只测了 latestTurnSuggestedActions 纯函数，
// rail 本身零渲染测试、变异 0 红）。钉三条：最后一轮动作渲染、retry-agent 不在条上重复、busy 不渲染。

function action(id: string, label: string, endpoint?: string): SuggestedAction {
  return {
    id,
    label,
    description: `${label}的说明`,
    permission: "project_config_write",
    requiresConfirmation: false,
    ...(endpoint !== undefined ? { endpoint } : {}),
  };
}

function assistant(id: string, content: string, actions?: readonly SuggestedAction[], extra?: Partial<ChapterMessage>): ChapterMessage {
  return {
    id,
    role: "assistant",
    content,
    ...(actions && actions.length > 0 ? { suggestedActions: actions } : {}),
    ...extra,
  };
}

function user(id: string): ChapterMessage {
  return { id, role: "user", content: `提问-${id}` };
}

type AiChatCodexProps = WritingWorkspaceLayoutProps & {
  readonly rightOpen: boolean;
  readonly onToggleRight: () => void;
};

function renderChat(messages: readonly ChapterMessage[], overrides: Record<string, unknown> = {}) {
  const props = {
    workspace: { ...mockWorkspaceData, messages },
    sidebar: mockSidebarData,
    themeMode: "dark",
    steeringDirection: "",
    onSteeringDirectionChange: () => undefined,
    onGenerateSteering: () => undefined,
    rightOpen: true,
    onToggleRight: () => undefined,
    onSuggestedAction: vi.fn(),
    ...overrides,
  } as AiChatCodexProps;
  return render(<AiChatCodex {...props} />);
}

function rail(container: HTMLElement): HTMLElement | null {
  return container.querySelector(".suggest");
}

describe("建议动作条 rail 渲染（AiChatCodex .suggest）", () => {
  afterEach(() => cleanup());

  it("最后一轮 assistant 的 suggestedActions 渲染成 chip；旧回合动作不残留；点击回调原动作", () => {
    const onSuggestedAction = vi.fn();
    const undo = action("undo-foundation-write", "撤销本次修改", "undo-1");
    const { container } = renderChat([
      assistant("a0", "旧回合回复。", [action("commit-apply", "确认定稿")]),
      user("u1"),
      assistant("a1", "资料已更新，可撤销本次修改。", [undo]),
    ], { onSuggestedAction });

    const el = rail(container);
    expect(el).not.toBeNull();
    const chips = within(el!);
    chips.getByRole("button", { name: "撤销本次修改" });
    // 旧回合（最后一条用户消息之前）的动作不进条。
    expect(chips.queryByRole("button", { name: "确认定稿" })).toBeNull();

    fireEvent.click(chips.getByRole("button", { name: "撤销本次修改" }));
    expect(onSuggestedAction).toHaveBeenCalledTimes(1);
    expect(onSuggestedAction).toHaveBeenCalledWith(undo);
  });

  it("retry-agent 不进建议条：错误气泡内已有就地「重试这一步」，条上不重复", () => {
    const { container } = renderChat([
      user("u1"),
      assistant(
        "err-1",
        "AI 服务暂时没响应，本次没有改动。",
        [action("retry-agent", "重试", "把这条记进资料")],
        { isErrorNotice: true, errorDetail: "落盘失败" },
      ),
      assistant("a2", "已写入资料。", [action("undo-foundation-write", "撤销本次修改", "undo-9")]),
    ]);

    // 就地入口在错误卡上，全界面只此一个重试钮。
    expect(screen.getAllByRole("button", { name: "重试这一步" })).toHaveLength(1);
    const el = rail(container);
    expect(el).not.toBeNull();
    const chips = within(el!);
    chips.getByRole("button", { name: "撤销本次修改" });
    expect(chips.queryByRole("button", { name: /重试/ })).toBeNull();
  });

  it("回合进行中（chatLoading）整条不渲染，回合结束才浮现", () => {
    const { container } = renderChat([
      user("u1"),
      assistant("a1", "资料已更新，可撤销本次修改。", [action("undo-foundation-write", "撤销本次修改", "undo-1")]),
    ], { chatLoading: true });

    expect(rail(container)).toBeNull();
    expect(screen.queryByRole("button", { name: "撤销本次修改" })).toBeNull();
  });
});
