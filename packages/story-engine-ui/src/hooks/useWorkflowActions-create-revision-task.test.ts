import { beforeEach, describe, expect, it, vi } from "vitest";

import { useWorkspaceStore } from "../stores/workspaceStore.js";
import { useNavigationStore } from "../stores/navigationStore.js";
import { mockWorkspaceData } from "../mockData.js";
import type { DraftAIReviewIssue, DraftRevisionPreview, DraftRevisionTask } from "../api/types.js";

const apiMocks = vi.hoisted(() => ({
  applyFoundationGapDecisions: vi.fn(),
  applyDraftRevision: vi.fn(),
  applyDraftCandidate: vi.fn(),
  generateDraftCandidate: vi.fn(),
  checkDraftQuality: vi.fn(),
  fetchChapterSteering: vi.fn(),
  generateDraftStream: vi.fn(),
  previewDraftRevision: vi.fn(),
  reviewDraftWithAI: vi.fn(),
  saveChapterWorkspace: vi.fn(),
}));

vi.mock("../api/client.js", () => apiMocks);

const TARGET_TEXT = "林远站在落地窗前，望着楼下的车流。这是一段需要润色的原文。";
const ORIGINAL_DRAFT = `# 第一章\n\n${TARGET_TEXT}`;

function makeIssue(overrides: Partial<DraftAIReviewIssue> = {}): DraftAIReviewIssue {
  return {
    id: "issue-1",
    severity: "warning",
    category: "style",
    title: "语言略平",
    description: "这段描写偏说明文。",
    evidence: TARGET_TEXT,
    suggestedFix: "改成更有画面感的写法。",
    ...overrides,
  };
}

function makeTask(): DraftRevisionTask {
  return {
    id: "revision-auto",
    chapter: 1,
    targetType: "paragraph",
    targetText: TARGET_TEXT,
    problemSummary: "语言略平",
    revisionGoal: "改成更有画面感的写法。",
    constraints: [],
    status: "pending",
  };
}

function makePreview(afterText: string): DraftRevisionPreview {
  return {
    taskId: "revision-auto",
    beforeText: TARGET_TEXT,
    afterText,
    changeSummary: "增强画面感。",
    rationale: "润色。",
    riskNotes: [],
    preservedFacts: [],
    warnings: [],
  };
}

describe("handleCreateRevisionTask 自动生成修订草案", () => {
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
      activeRevisionTask: null,
      activeRevisionPreview: null,
      activeSessionId: "",
    });
  });

  it("创建任务后自动调用 previewDraftRevision，成功后 activeRevisionPreview 非空", async () => {
    const { useWorkflowActions } = await import("./useWorkflowActions.js");
    apiMocks.previewDraftRevision.mockResolvedValueOnce({
      task: makeTask(),
      preview: makePreview("林远独自立在落地窗边，俯瞰楼下川流不息的车阵。"),
    });

    useWorkflowActions({
      projectPath: "/tmp/story-project",
      resolveChapterDirection: () => "",
      appendMessage: useWorkspaceStore.getState().appendMessage,
      appendWorkflowPrompt: vi.fn(),
      applyOverviewToWorkspace: vi.fn(),
    }).handleCreateRevisionTask({ issue: makeIssue() });

    await vi.waitFor(() => {
      expect(apiMocks.previewDraftRevision).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect(useWorkspaceStore.getState().activeRevisionPreview).not.toBeNull();
    });

    const state = useWorkspaceStore.getState();
    expect(state.activeRevisionTask).not.toBeNull();
    expect(state.activeRevisionPreview?.afterText).toContain("川流不息");
    expect(state.draftActionLoading).toBeNull();

    const created = state.workspace.messages.find((m) => m.content.includes("已创建修订任务"));
    expect(created).toBeTruthy();
    expect(created!.content).toContain("正在生成修订草案");
    expect(created!.suggestedActions).toBeUndefined();
  });

  it("guessed 分支同样自动触发生成", async () => {
    const { useWorkflowActions } = await import("./useWorkflowActions.js");
    apiMocks.previewDraftRevision.mockResolvedValueOnce({
      task: makeTask(),
      preview: makePreview("改写后的开头。"),
    });

    // evidence 对不上原文 → resolveRevisionTarget 走 category 猜测
    useWorkflowActions({
      projectPath: "/tmp/story-project",
      resolveChapterDirection: () => "",
      appendMessage: useWorkspaceStore.getState().appendMessage,
      appendWorkflowPrompt: vi.fn(),
      applyOverviewToWorkspace: vi.fn(),
    }).handleCreateRevisionTask({
      issue: makeIssue({
        category: "plot",
        evidence: "这段根本不在草稿里的句子",
        affectedParagraphHint: undefined,
      }),
    });

    await vi.waitFor(() => {
      expect(apiMocks.previewDraftRevision).toHaveBeenCalledTimes(1);
    });
    expect(useNavigationStore.getState().toast).toContain("没能精确定位");
  });

  it("生成失败时 preview 仍空、draftActionLoading 清空（第三态可达）", async () => {
    const { useWorkflowActions } = await import("./useWorkflowActions.js");
    apiMocks.previewDraftRevision.mockRejectedValueOnce(new Error("模型超时"));

    useWorkflowActions({
      projectPath: "/tmp/story-project",
      resolveChapterDirection: () => "",
      appendMessage: useWorkspaceStore.getState().appendMessage,
      appendWorkflowPrompt: vi.fn(),
      applyOverviewToWorkspace: vi.fn(),
    }).handleCreateRevisionTask({ issue: makeIssue() });

    await vi.waitFor(() => {
      expect(apiMocks.previewDraftRevision).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect(useWorkspaceStore.getState().draftActionLoading).toBeNull();
    });

    const state = useWorkspaceStore.getState();
    expect(state.activeRevisionTask).not.toBeNull();
    expect(state.activeRevisionPreview).toBeNull();
    expect(state.chatError).toContain("模型超时");
  });
});
