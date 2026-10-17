import { beforeEach, describe, expect, it, vi } from "vitest";

import { useWorkspaceStore } from "../stores/workspaceStore.js";
import { useNavigationStore } from "../stores/navigationStore.js";
import { mockWorkspaceData } from "../mockData.js";
import type { StateOverview } from "../api/types.js";

const apiMocks = vi.hoisted(() => ({
  applyFoundationGapDecisions: vi.fn(),
  applyDraftRevision: vi.fn(),
  checkDraftQuality: vi.fn(),
  fetchChapterSteering: vi.fn(),
  generateDraftStream: vi.fn(),
  previewDraftRevision: vi.fn(),
  reviewDraftWithAI: vi.fn(),
  saveChapterWorkspace: vi.fn(),
}));

vi.mock("../api/client.js", () => apiMocks);

const ORIGINAL_DRAFT = "# 第一章\n\n生成前的旧草稿内容。";
const GENERATED_DRAFT = "# 第一章 新标题\n\n这是成功生成的新正文。";

describe("handleGenerateDraft save failure handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useNavigationStore.getState().clearToast();
    useNavigationStore.setState({ projectPath: "/tmp/story-project" });
    useWorkspaceStore.setState({
      workspace: {
        ...mockWorkspaceData,
        currentChapter: { id: "ch-001", chapterNumber: 1, title: "第一章", status: "current" },
        flowStatus: "draft_ready",
        draft: {
          chapterNumber: 1,
          title: "第一章",
          status: "draft",
          content: ORIGINAL_DRAFT,
          savedContent: ORIGINAL_DRAFT,
        },
        messages: [],
      },
      draftActionLoading: null,
      selectedAdviceCards: [],
      chatError: null,
      steeringError: null,
      activeSessionId: "",
    });
  });

  it("keeps the generated draft and does not fail the flow when saving after generation rejects", async () => {
    const { useWorkflowActions } = await import("./useWorkflowActions.js");
    apiMocks.generateDraftStream.mockImplementationOnce(async (_params, handlers) => {
      handlers.onDelta(GENERATED_DRAFT);
      handlers.onDone({
        overview: {} as StateOverview,
        draftContent: GENERATED_DRAFT,
        draftTitle: "新标题",
      });
    });
    const saveDraftChanges = vi.fn().mockRejectedValueOnce(new Error("network down"));
    const applyOverviewToWorkspace = vi.fn((_overview: StateOverview, draftContent?: string) => {
      const store = useWorkspaceStore.getState();
      store.setWorkspace({
        ...store.workspace,
        flowStatus: "draft_ready",
        draft: {
          ...store.workspace.draft,
          content: draftContent ?? "",
          savedContent: draftContent ?? "",
          status: "draft",
        },
      });
    });

    await useWorkflowActions({
      projectPath: "/tmp/story-project",
      resolveChapterDirection: () => "",
      appendMessage: useWorkspaceStore.getState().appendMessage,
      appendWorkflowPrompt: vi.fn(),
      applyOverviewToWorkspace,
      saveDraftChanges,
    }).handleGenerateDraft("本章目标：测试保存失败");

    const state = useWorkspaceStore.getState();
    const messages = state.workspace.messages.map((message) => [
      message.content,
      ...(message.agentCards ?? []).flatMap((card) => [
        card.title,
        card.summary,
        ...(card.detail ?? []),
      ]),
    ].join("\n")).join("\n");

    expect(saveDraftChanges).toHaveBeenCalledTimes(1);
    // The successfully generated draft must survive a failed post-generation save.
    expect(state.workspace.draft.content).toBe(GENERATED_DRAFT);
    expect(state.workspace.draft.content).not.toBe(ORIGINAL_DRAFT);
    expect(state.workspace.flowStatus).toBe("draft_ready");
    // The flow must not be reported as failed and no error channel should fire.
    expect(messages).not.toContain("正文写作流程失败");
    expect(messages).toContain("正文写作流程完成");
    expect(state.chatError).toBeNull();
    expect(state.steeringError).toBeNull();
    expect(state.draftActionLoading).toBeNull();
    // A soft toast tells the user that auto-save will retry persistence.
    expect(useNavigationStore.getState().toast).toContain("自动保存失败");
  });

  it("still reports a failed flow and restores the draft when generation itself fails", async () => {
    const { useWorkflowActions } = await import("./useWorkflowActions.js");
    apiMocks.generateDraftStream.mockRejectedValueOnce(new Error("model unavailable"));
    const saveDraftChanges = vi.fn().mockResolvedValue(undefined);

    await useWorkflowActions({
      projectPath: "/tmp/story-project",
      resolveChapterDirection: () => "",
      appendMessage: useWorkspaceStore.getState().appendMessage,
      appendWorkflowPrompt: vi.fn(),
      applyOverviewToWorkspace: vi.fn(),
      saveDraftChanges,
    }).handleGenerateDraft("本章目标：测试生成失败");

    const state = useWorkspaceStore.getState();
    const messages = state.workspace.messages.map((message) => message.content).join("\n");

    expect(saveDraftChanges).not.toHaveBeenCalled();
    expect(state.workspace.draft.content).toBe(ORIGINAL_DRAFT);
    expect(messages).toContain("正文写作流程失败");
    expect(state.draftActionLoading).toBeNull();
  });
});
