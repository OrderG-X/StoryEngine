import { beforeEach, describe, expect, it, vi } from "vitest";

import { useWorkspaceStore } from "../stores/workspaceStore.js";
import { useNavigationStore } from "../stores/navigationStore.js";
import { mockWorkspaceData } from "../mockData.js";
import type { DraftAIReviewReport } from "../api/types.js";

const apiMocks = vi.hoisted(() => ({
  applyCommit: vi.fn(),
  applyFoundationGapDecisions: vi.fn(),
  applyDraftRevision: vi.fn(),
  applyDraftCandidate: vi.fn(),
  generateDraftCandidate: vi.fn(),
  checkDraftQuality: vi.fn(),
  fetchChapterSteering: vi.fn(),
  generateDraftStream: vi.fn(),
  previewCommit: vi.fn(),
  previewDraftRevision: vi.fn(),
  reviewDraftWithAI: vi.fn(),
  saveChapterWorkspace: vi.fn(),
}));

vi.mock("../api/client.js", () => apiMocks);

const REAL_DRAFT = "# 第一章\n\n顾长风推开雾港旧泵站的铁门，雨丝斜斜地刮进来。";

function makeReview(overrides: Partial<DraftAIReviewReport> = {}): DraftAIReviewReport {
  return {
    passed: false,
    score: 62,
    verdict: "needs_major_revision",
    summary: "节奏偏慢，动机不够清楚。",
    strengths: ["气氛到位"],
    issues: [
      {
        id: "issue-1",
        severity: "high",
        category: "plot",
        title: "动机不清",
        description: "主角为何深夜来泵站没有铺垫。",
        evidence: "顾长风推开雾港旧泵站的铁门",
        suggestedFix: "补一句来因。",
      },
    ],
    suggestedRevisions: [],
    continuityNotes: [],
    styleNotes: [],
    characterNotes: [],
    pacingNotes: [],
    readerHookNotes: [],
    shouldCommit: false,
    blockingReasons: [],
    ...overrides,
  };
}

describe("handleDraftAIReview 把报告挂到消息上", () => {
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
          content: REAL_DRAFT,
          savedContent: REAL_DRAFT,
        },
        messages: [],
      },
      draftActionLoading: null,
      draftAIReview: null,
      selectedAdviceCards: [],
      chatError: null,
      steeringError: null,
      activeRevisionTask: null,
      activeRevisionPreview: null,
      activeSessionId: "",
    });
  });

  it("成功后 assistant 消息挂上 aiReviewReport，且仍写入 store.draftAIReview", async () => {
    const { useWorkflowActions } = await import("./useWorkflowActions.js");
    const review = makeReview();
    apiMocks.reviewDraftWithAI.mockResolvedValueOnce(review);

    await useWorkflowActions({
      projectPath: "/tmp/story-project",
      resolveChapterDirection: () => "",
      appendMessage: useWorkspaceStore.getState().appendMessage,
      appendWorkflowPrompt: vi.fn(),
      applyOverviewToWorkspace: vi.fn(),
    }).handleDraftAIReview();

    const state = useWorkspaceStore.getState();
    expect(state.draftAIReview).toEqual(review);
    expect(state.draftActionLoading).toBeNull();

    const msg = state.workspace.messages.find((m) => m.content.includes("AI 内容审阅完成"));
    expect(msg).toBeTruthy();
    expect(msg!.aiReviewReport).toEqual(review);
  });

  it("失败路径不挂 aiReviewReport，错误可见", async () => {
    const { useWorkflowActions } = await import("./useWorkflowActions.js");
    apiMocks.reviewDraftWithAI.mockRejectedValueOnce(new Error("审稿超时"));

    await useWorkflowActions({
      projectPath: "/tmp/story-project",
      resolveChapterDirection: () => "",
      appendMessage: useWorkspaceStore.getState().appendMessage,
      appendWorkflowPrompt: vi.fn(),
      applyOverviewToWorkspace: vi.fn(),
    }).handleDraftAIReview();

    const state = useWorkspaceStore.getState();
    expect(state.draftAIReview).toBeNull();
    expect(state.steeringError).toContain("审稿超时");
    expect(state.draftActionLoading).toBeNull();

    const failed = state.workspace.messages.find((m) => m.content.includes("内容审阅 Agent失败"));
    expect(failed).toBeTruthy();
    expect(failed!.aiReviewReport).toBeUndefined();
  });
});
