import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockWorkspaceData } from "../mockData.js";
import { useWorkspaceStore } from "../stores/workspaceStore.js";
import { useNavigationStore } from "../stores/navigationStore.js";
import { useChat, type UseChatParams } from "./useChat.js";
import type { SuggestedAction } from "../type-defs/workflow.js";
import { resetWorkspaceOperationForTests } from "../utils/workspaceOperation.js";

// A-6 建议条配套：consumeSuggestedAction——动作成功执行后把它从携带消息上摘掉（否则建议条继续显示
// 已完成动作=假入口）；失败/未执行不摘，留着重试。此前零测试（复审 T6 缺口：变异 0 红）。
vi.mock("../api/client.js", () => ({
  applyFoundationGapDecisions: vi.fn(),
  directEditDraft: vi.fn(),
  fetchChapterChatStream: vi.fn(async () => undefined),
  fetchChapterWorkspace: vi.fn(),
}));

vi.mock("../api/agentChatClient.js", () => ({
  streamAgentChat: vi.fn(),
}));

vi.mock("../api/chatSessionsClient.js", () => ({
  renameChatSession: vi.fn(),
}));

const undoAction: SuggestedAction = {
  id: "undo-foundation-write",
  label: "撤销本次修改",
  description: "恢复到这次 Agent 修改前的资料状态。",
  permission: "project_config_write",
  requiresConfirmation: false,
  endpoint: "foundation-1-undo",
};

const acceptAction: SuggestedAction = {
  id: "accept-foundation-suggestions",
  label: "确认写入资料",
  description: "写入资料",
  permission: "project_config_write",
  requiresConfirmation: true,
  endpoint: "sug-1",
};

function resetStore(): void {
  resetWorkspaceOperationForTests();
  useNavigationStore.setState({ projectPath: "/tmp/story-engine-agent", toast: null });
  useWorkspaceStore.setState({
    workspace: { ...mockWorkspaceData, messages: [] },
    chatLoading: false,
    chatError: null,
    pendingDirectEditInstruction: null,
    selectedAdviceCards: [],
    aiFlavorPending: null,
    activeSessionId: "session-a",
    sessions: [{ id: "session-a", name: "新会话", updatedAt: "2026-07-13T00:00:00.000Z" }],
    draftActionLoading: null,
    steeringLoading: false,
  });
}

function messages() {
  return useWorkspaceStore.getState().workspace.messages;
}

function lastAssistant() {
  const list = messages();
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i].role === "assistant") return list[i];
  }
  return undefined;
}

/** 在对话里种一条携带建议动作的 assistant 结果消息（如「资料已更新，可撤销本次修改。」）。 */
function seedCarrierMessage(actions: readonly SuggestedAction[]): string {
  const id = "assistant-carrier-1";
  useWorkspaceStore.setState({
    workspace: {
      ...useWorkspaceStore.getState().workspace,
      messages: [{ id, role: "assistant", content: "资料已更新，可撤销本次修改。", suggestedActions: actions }],
    },
  });
  return id;
}

function buildParams(overrides: Partial<UseChatParams>): UseChatParams {
  return {
    projectPath: "/tmp/story-engine-agent",
    resolveChapterDirection: (value?: unknown) => (typeof value === "string" ? value : ""),
    handleGenerateDraft: async () => undefined,
    handleQualityCheck: async () => undefined,
    handleDraftAIReview: async () => undefined,
    handleGenerateRevisionPreview: async () => undefined,
    handleApplyRevisionPreview: async () => undefined,
    handleCommitPreview: async () => undefined,
    handleCommitApply: () => undefined,
    handleGenerateSteering: async () => undefined,
    handleContinueNextChapter: async () => undefined,
    handleCreateRevisionTask: () => undefined,
    applyOverviewToWorkspace: () => undefined,
    refreshWorkspaceFromOverview: () => undefined,
    ...overrides,
  };
}

describe("consumeSuggestedAction（A-6 动作消费：成功摘掉、失败保留）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    resetStore();
  });

  it("撤销成功（ok=true）：动作从携带消息上摘掉、追加如实回执，对话里不留假入口", async () => {
    const carrierId = seedCarrierMessage([undoAction]);
    const handleRollback = vi.fn(async () => true);
    const { result } = renderHook(() => useChat(buildParams({
      handleRollbackFoundationGapApplyFromChat: handleRollback,
    })));

    await act(async () => {
      result.current.handleSuggestedAction(undoAction);
    });

    expect(handleRollback).toHaveBeenCalledWith("foundation-1-undo");
    await vi.waitFor(() => {
      expect(lastAssistant()?.content).toBe("已撤销本次修改。");
    });
    // 携带消息上的动作被摘掉（建议条随之消失），整条对话不再有这个动作的任何入口。
    const carrier = messages().find((m) => m.id === carrierId);
    expect(carrier?.suggestedActions ?? []).toHaveLength(0);
    expect(
      messages().some((m) =>
        (m.suggestedActions ?? []).some((a) => a.id === "undo-foundation-write" && a.endpoint === "foundation-1-undo")),
    ).toBe(false);
  });

  it("撤销失败（ok=false）：动作保留在消息上留作重试入口，如实报失败", async () => {
    const carrierId = seedCarrierMessage([undoAction]);
    const handleRollback = vi.fn(async () => false);
    const { result } = renderHook(() => useChat(buildParams({
      handleRollbackFoundationGapApplyFromChat: handleRollback,
    })));

    await act(async () => {
      result.current.handleSuggestedAction(undoAction);
    });

    await vi.waitFor(() => {
      expect(lastAssistant()?.content).toBe("撤销失败，请查看资料补全面板错误。");
    });
    const carrier = messages().find((m) => m.id === carrierId);
    expect(carrier?.suggestedActions).toEqual([undoAction]);
  });

  it("accept 成功：「确认写入资料」从携带消息上摘掉，结果消息带真撤销动作（undoId 来自服务端回执）", async () => {
    const carrierId = seedCarrierMessage([acceptAction]);
    const handleApply = vi.fn(async () => ({
      plan: {
        acceptedSuggestions: [],
        rejectedSuggestionIds: [],
        deferredSuggestionIds: [],
        skippedConflicts: [],
        fileChanges: [],
      },
      writes: [{
        domain: "character" as const,
        action: "update_character",
        targetFile: "story/character-bible.json",
        targetName: "顾长风",
        summary: "已更新顾长风的角色资料。",
      }],
      skippedWrites: [],
      undo: { undoId: "foundation-9-undo", changedFiles: ["story/character-bible.json"] },
    }));
    const { result } = renderHook(() => useChat(buildParams({
      handleApplyFoundationGapSuggestionsFromChat: handleApply,
    })));

    await act(async () => {
      result.current.handleSuggestedAction(acceptAction);
    });

    expect(handleApply).toHaveBeenCalledWith(["sug-1"]);
    await vi.waitFor(() => {
      expect(lastAssistant()?.content).toContain("顾长风");
      expect(lastAssistant()?.content).toContain("可撤销本次修改");
    });
    // 已消费的 accept 动作被摘掉；新回执消息上挂着可真用的撤销动作。
    const carrier = messages().find((m) => m.id === carrierId);
    expect(carrier?.suggestedActions ?? []).toHaveLength(0);
    expect(
      messages().some((m) =>
        (m.suggestedActions ?? []).some((a) => a.id === "accept-foundation-suggestions")),
    ).toBe(false);
    expect(lastAssistant()?.suggestedActions).toEqual([
      expect.objectContaining({ id: "undo-foundation-write", endpoint: "foundation-9-undo" }),
    ]);
  });

  it("动作找不到携带消息：消费静默 no-op，不炸也不误摘别的消息", async () => {
    const otherId = seedCarrierMessage([acceptAction]); // 携带的是另一个动作
    const handleRollback = vi.fn(async () => true);
    const { result } = renderHook(() => useChat(buildParams({
      handleRollbackFoundationGapApplyFromChat: handleRollback,
    })));

    await act(async () => {
      result.current.handleSuggestedAction(undoAction); // 没有任何消息携带它
    });

    await vi.waitFor(() => {
      expect(lastAssistant()?.content).toBe("已撤销本次修改。");
    });
    // 别的消息上的动作原样保留。
    expect(messages().find((m) => m.id === otherId)?.suggestedActions).toEqual([acceptAction]);
  });
});
