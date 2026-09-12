import { beforeEach, describe, expect, it, vi } from "vitest";

import { emptyCommitSelections, useWorkspaceStore } from "../stores/workspaceStore.js";
import { useNavigationStore } from "../stores/navigationStore.js";
import { mockWorkspaceData } from "../mockData.js";
import type { CommitPreviewUiReport } from "../types.js";
import type { StateOverview } from "../api/types.js";
import { resetWorkspaceOperationForTests } from "../utils/workspaceOperation.js";
import { recordWorkspaceRevision, resetWorkspaceRevisionTrackerForTests } from "../utils/workspaceRevisionTracker.js";

const apiMocks = vi.hoisted(() => ({
  applyCommit: vi.fn(),
  applyFoundationGapDecisions: vi.fn(),
  applyDraftRevision: vi.fn(),
  checkDraftQuality: vi.fn(),
  fetchChapterSteering: vi.fn(),
  generateDraftStream: vi.fn(),
  previewCommit: vi.fn(),
  previewDraftRevision: vi.fn(),
  reviewDraftWithAI: vi.fn(),
  saveChapterWorkspace: vi.fn(),
}));

vi.mock("../api/client.js", () => apiMocks);

describe("Formal Commit UI apply result handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetWorkspaceOperationForTests();
    resetWorkspaceRevisionTrackerForTests();
    recordWorkspaceRevision("/tmp/story-project", 1, 7);
    useNavigationStore.getState().clearToast();
    useNavigationStore.setState({ projectPath: "/tmp/story-project" });
    resetWorkspaceForCommitApply();
  });

  it("passes preview transaction credentials and a generated idempotency key to applyCommit", async () => {
    const { useWorkflowActions } = await import("./useWorkflowActions.js");
    useWorkspaceStore.getState().setCommitPreviewReport(basePreview({
      transactionId: "tx-preview-1",
      previewHash: "preview-hash-1",
    }));
    apiMocks.applyCommit.mockResolvedValueOnce({
      reason: "formal_commit_apply_chapter_only_applied_finalized",
      chapter: 1,
      changedFiles: ["chapters/0001.md"],
      transactionDir: ".story-engine-tx/commit-chapter-0001",
      transactionFinalized: true,
      finalizedAt: "2026-05-23T10:00:00.000Z",
      cleanupPerformed: false,
      stateWritesEnabled: false,
    });

    await useWorkflowActions({
      projectPath: "/tmp/story-project",
      resolveChapterDirection: () => "",
      appendMessage: useWorkspaceStore.getState().appendMessage,
      appendWorkflowPrompt: vi.fn(),
      applyOverviewToWorkspace: vi.fn(),
    }).executeCommitApply();

    expect(apiMocks.applyCommit).toHaveBeenCalledWith(expect.objectContaining({
      projectPath: "/tmp/story-project",
      chapter: 1,
      transactionId: "tx-preview-1",
      previewHash: "preview-hash-1",
      idempotencyKey: "ui-v0-commit-apply-1-tx-preview-1-preview-hash-1",
    }));
  });

  it("reuses the exact preview-bound idempotency key after response loss", async () => {
    const { useWorkflowActions } = await import("./useWorkflowActions.js");
    const actions = useWorkflowActions({
      projectPath: "/tmp/story-project",
      resolveChapterDirection: () => "",
      appendMessage: useWorkspaceStore.getState().appendMessage,
      appendWorkflowPrompt: vi.fn(),
      applyOverviewToWorkspace: vi.fn(),
    });
    apiMocks.applyCommit
      .mockRejectedValueOnce(new Error("response lost after server commit"))
      .mockResolvedValueOnce({
        report: { chapterPath: "chapters/0001.md", updatedCharacters: [] },
        overview: {} as StateOverview,
        chapterContent: "# Chapter One\n\nCommitted chapter.",
        chapterTitle: "Chapter One",
      });

    await actions.executeCommitApply();
    await actions.executeCommitApply();

    expect(apiMocks.applyCommit).toHaveBeenCalledTimes(2);
    expect(apiMocks.applyCommit.mock.calls[0]?.[0].idempotencyKey)
      .toBe(apiMocks.applyCommit.mock.calls[1]?.[0].idempotencyKey);
  });

  it("stores preview transaction credentials after generating commit preview", async () => {
    const { useWorkflowActions } = await import("./useWorkflowActions.js");
    apiMocks.previewCommit.mockResolvedValueOnce({
      commitPlan: { passed: true },
      draftQuality: { issues: [] },
      transaction: {
        version: "transaction-hardening-v1",
        transactionId: "tx-preview-generated",
        previewHash: "preview-hash-generated",
        projectHash: "project-hash",
        chapter: 1,
        draftHash: "draft-hash",
        commitPlanHash: "commit-plan-hash",
        selectiveCandidateSummaryHash: "selective-summary-hash",
      },
      transactionId: "tx-preview-generated",
      previewHash: "preview-hash-generated",
    });

    await useWorkflowActions({
      projectPath: "/tmp/story-project",
      resolveChapterDirection: () => "",
      appendMessage: useWorkspaceStore.getState().appendMessage,
      appendWorkflowPrompt: vi.fn(),
      applyOverviewToWorkspace: vi.fn(),
    }).handleCommitPreview();

    const preview = useWorkspaceStore.getState().commitPreviewReport;
    expect(preview).toMatchObject({
      transactionId: "tx-preview-generated",
      previewHash: "preview-hash-generated",
      transaction: expect.objectContaining({
        transactionId: "tx-preview-generated",
        previewHash: "preview-hash-generated",
      }),
    });
  });

  it("blocks apply when preview transaction credentials are missing", async () => {
    const { useWorkflowActions } = await import("./useWorkflowActions.js");
    useWorkspaceStore.getState().setCommitPreviewReport(basePreview({ withCredentials: false }));

    await useWorkflowActions({
      projectPath: "/tmp/story-project",
      resolveChapterDirection: () => "",
      appendMessage: useWorkspaceStore.getState().appendMessage,
      appendWorkflowPrompt: vi.fn(),
      applyOverviewToWorkspace: vi.fn(),
    }).executeCommitApply();

    expect(apiMocks.applyCommit).not.toHaveBeenCalled();
    expect(useNavigationStore.getState().toast).toContain("重新生成定稿预览");
  });

  it("keeps the missing preview guard before credentialed apply", async () => {
    const { useWorkflowActions } = await import("./useWorkflowActions.js");
    const workflowActions = useWorkflowActions({
      projectPath: "/tmp/story-project",
      resolveChapterDirection: () => "",
      appendMessage: useWorkspaceStore.getState().appendMessage,
      appendWorkflowPrompt: vi.fn(),
      applyOverviewToWorkspace: vi.fn(),
    });

    useWorkspaceStore.getState().setCommitPreviewReport(null);
    await workflowActions.executeCommitApply();
    expect(apiMocks.applyCommit).not.toHaveBeenCalled();
    expect(useNavigationStore.getState().toast).toContain("请先生成定稿预览");
  });

  it("no longer blocks apply on pending quality gate items", async () => {
    const { useWorkflowActions } = await import("./useWorkflowActions.js");
    useWorkspaceStore.getState().setCommitPreviewReport(basePreview({
      transactionId: "tx-preview-1",
      previewHash: "preview-hash-1",
      qualityBlocked: true,
    }));
    const applyOverviewToWorkspace = vi.fn();
    apiMocks.applyCommit.mockResolvedValueOnce({
      report: { chapterPath: "chapters/0001.md", updatedCharacters: ["protagonist"] },
      overview: {} as StateOverview,
      chapterContent: "# Chapter One\n\nCommitted chapter.",
      chapterTitle: "Chapter One",
    });

    await useWorkflowActions({
      projectPath: "/tmp/story-project",
      resolveChapterDirection: () => "",
      appendMessage: useWorkspaceStore.getState().appendMessage,
      appendWorkflowPrompt: vi.fn(),
      applyOverviewToWorkspace,
    }).executeCommitApply();

    // 质检有待处理项也不再拦截：apply 照常执行完整提交
    expect(apiMocks.applyCommit).toHaveBeenCalledTimes(1);
    expect(applyOverviewToWorkspace).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      "committed",
      "Chapter One",
      expect.any(Number), // 认领本次入库章号（修跨章污染）
    );
  });

  it("keeps legacy CommitEngine-style apply success supported", async () => {
    const { useWorkflowActions } = await import("./useWorkflowActions.js");
    const overview = {} as StateOverview;
    const applyOverviewToWorkspace = vi.fn();
    apiMocks.applyCommit.mockResolvedValueOnce({
      report: {
        chapterPath: "chapters/0001.md",
        updatedCharacters: ["protagonist"],
      },
      overview,
      chapterContent: "# Chapter One\n\nCommitted chapter.",
      chapterTitle: "Chapter One",
    });
    apiMocks.saveChapterWorkspace.mockResolvedValueOnce({ revision: 8 });

    await useWorkflowActions({
      projectPath: "/tmp/story-project",
      resolveChapterDirection: () => "",
      appendMessage: useWorkspaceStore.getState().appendMessage,
      appendWorkflowPrompt: vi.fn(),
      applyOverviewToWorkspace,
    }).executeCommitApply();

    const state = useWorkspaceStore.getState();
    expect(applyOverviewToWorkspace).toHaveBeenCalledWith(
      overview,
      "# Chapter One\n\nCommitted chapter.",
      "committed",
      "Chapter One",
      expect.any(Number), // 认领本次入库章号（修跨章污染）
    );
    expect(apiMocks.saveChapterWorkspace).toHaveBeenCalledTimes(1);
    expect(apiMocks.saveChapterWorkspace).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 7 }));
    expect(state.workspaceRevision).toBe(8);
    expect(state.draftActionLoading).toBeNull();
  });

  it("keeps committed chapter truth when post-success overview is null", async () => {
    const { useWorkflowActions } = await import("./useWorkflowActions.js");
    const applyOverviewToWorkspace = vi.fn(() => {
      throw new Error("nullable overview must not reach the adapter");
    });
    apiMocks.applyCommit.mockResolvedValueOnce({
      report: { chapterPath: "chapters/0001.md", updatedCharacters: [] },
      overview: null,
      chapterContent: "# Chapter One\n\nCommitted despite overview failure.",
      chapterTitle: "Chapter One",
      warnings: ["overview refresh failed after successful commit"],
    });
    apiMocks.saveChapterWorkspace.mockResolvedValueOnce({ revision: 8 });

    await useWorkflowActions({
      projectPath: "/tmp/story-project",
      resolveChapterDirection: () => "",
      appendMessage: useWorkspaceStore.getState().appendMessage,
      appendWorkflowPrompt: vi.fn(),
      applyOverviewToWorkspace,
    }).executeCommitApply();

    const state = useWorkspaceStore.getState();
    expect(applyOverviewToWorkspace).not.toHaveBeenCalled();
    expect(state.workspace.flowStatus).toBe("committed");
    expect(state.workspace.draft).toMatchObject({
      content: "# Chapter One\n\nCommitted despite overview failure.",
      title: "Chapter One",
      status: "committed",
    });
    expect(visibleMessages()).toContain("定稿完成");
    expect(visibleMessages()).toContain("资料概览刷新失败");
    expect(useNavigationStore.getState().toast).toContain("概览刷新失败");
  });

  it("explains stale preview apply failures and preserves user state", async () => {
    const { useWorkflowActions } = await import("./useWorkflowActions.js");
    const applyOverviewToWorkspace = vi.fn();
    const originalDraft = useWorkspaceStore.getState().workspace.draft.content;
    apiMocks.applyCommit.mockRejectedValueOnce(
      new Error("formal_commit_apply_transaction_preflight_failed: preview_hash_mismatch"),
    );

    await useWorkflowActions({
      projectPath: "/tmp/story-project",
      resolveChapterDirection: () => "",
      appendMessage: useWorkspaceStore.getState().appendMessage,
      appendWorkflowPrompt: vi.fn(),
      applyOverviewToWorkspace,
    }).executeCommitApply();

    const state = useWorkspaceStore.getState();
    const messages = visibleMessages();

    expect(state.draftActionLoading).toBeNull();
    expect(state.workspace.draft.content).toBe(originalDraft);
    expect(state.commitPreviewReport).not.toBeNull();
    expect(state.steeringError).toContain("重新生成定稿预览");
    expect(messages).toContain("重新生成定稿预览");
    expect(messages).toContain("工作稿和定稿预览已保留");
  });

  it("explains stale preview failures from preserved API payloads", async () => {
    const { useWorkflowActions } = await import("./useWorkflowActions.js");
    const originalDraft = useWorkspaceStore.getState().workspace.draft.content;
    apiMocks.applyCommit.mockRejectedValueOnce(Object.assign(
      new Error("Request failed with status 409"),
      {
        payload: {
          ok: false,
          reason: "formal_commit_apply_transaction_preflight_failed",
          transactionPreflight: { code: "preview_hash_mismatch" },
        },
      },
    ));

    await useWorkflowActions({
      projectPath: "/tmp/story-project",
      resolveChapterDirection: () => "",
      appendMessage: useWorkspaceStore.getState().appendMessage,
      appendWorkflowPrompt: vi.fn(),
      applyOverviewToWorkspace: vi.fn(),
    }).executeCommitApply();

    const state = useWorkspaceStore.getState();
    const messages = visibleMessages();

    expect(state.workspace.draft.content).toBe(originalDraft);
    expect(state.commitPreviewReport).not.toBeNull();
    expect(state.steeringError).toContain("重新生成定稿预览");
    expect(messages).toContain("重新生成定稿预览");
  });

  it("explains finalize failures as possible successful writes that need manual handling", async () => {
    const { useWorkflowActions } = await import("./useWorkflowActions.js");
    apiMocks.applyCommit.mockRejectedValueOnce(
      new Error("formal_commit_apply_finalize_failed simulated finalize throw"),
    );

    await useWorkflowActions({
      projectPath: "/tmp/story-project",
      resolveChapterDirection: () => "",
      appendMessage: useWorkspaceStore.getState().appendMessage,
      appendWorkflowPrompt: vi.fn(),
      applyOverviewToWorkspace: vi.fn(),
    }).executeCommitApply();

    const state = useWorkspaceStore.getState();
    const messages = visibleMessages();

    expect(state.draftActionLoading).toBeNull();
    expect(state.commitPreviewReport).not.toBeNull();
    expect(messages).toContain("章节可能已经写入");
    expect(messages).toContain("事务 finalized 失败");
    expect(messages).toContain("不要重复点击");
    expect(messages).toContain(".story-engine-tx");
  });

});

function visibleMessages(): string {
  return useWorkspaceStore.getState().workspace.messages.map((message) => [
    message.content,
    ...(message.agentCards ?? []).flatMap((card) => [
      card.title,
      card.summary,
      ...(card.detail ?? []),
    ]),
  ].join("\n")).join("\n");
}

function resetWorkspaceForCommitApply(): void {
  useWorkspaceStore.setState({
    workspace: {
      ...mockWorkspaceData,
      currentChapter: { id: "ch-001", chapterNumber: 1, title: "Chapter One", status: "current" },
      chapters: [
        { id: "ch-001", chapterNumber: 1, title: "Chapter One", status: "current" },
        { id: "ch-002", chapterNumber: 2, title: "Chapter Two", status: "planned" },
      ],
      flowStatus: "waiting_commit_confirmation",
      draft: {
        chapterNumber: 1,
        title: "Chapter One",
        status: "draft",
        content: "# Chapter One\n\nWorking draft content.",
        savedContent: "# Chapter One\n\nWorking draft content.",
      },
      messages: [],
    },
    commitPreviewReport: basePreview(),
    commitSelections: emptyCommitSelections(),
    lastFormalCommitApply: null,
    draftActionLoading: null,
    selectedAdviceCards: [],
    steeringError: null,
    workspaceRevision: 7,
  });
}

function basePreview(input: {
  readonly transactionId?: string;
  readonly previewHash?: string;
  readonly qualityBlocked?: boolean;
  readonly withCredentials?: boolean;
} = {}): CommitPreviewUiReport {
  const preview: CommitPreviewUiReport = {
    passed: true,
    highRiskIssueCount: 0,
    requiresExplicitOverride: false,
    ...(input.qualityBlocked ? {
      qualityGate: {
        blockingCount: 1,
        draftConfirmed: 1,
        draftNeedsConfirmation: 0,
        semanticConfirmed: 0,
        semanticNeedsConfirmation: 0,
        message: "仍有待处理质检项，暂不能入库。",
      },
    } : {}),
    blockingReasons: [],
    issues: [],
    nameDriftFindings: [],
    staleThreadWarnings: [],
    hookChanges: [],
    threadChanges: [],
    arcGoalChanges: [],
    characterChanges: [],
    worldChanges: [],
    assetChanges: {
      newAssetCandidates: [],
      assetStatusChanges: [],
      assetUsageEvidence: [],
      unregisteredAssetWarnings: [],
    },
    locationChanges: {
      newLocationCandidates: [],
      locationTransitionCandidates: [],
      spatialViolationWarnings: [],
    },
    characterKnowledgeChanges: {
      stateChanges: [],
      knowledgeKnownChanges: [],
      knowledgeUnknownChanges: [],
      characterMatrixCandidates: [],
      forbiddenRevealTouches: [],
    },
  };
  if (input.withCredentials === false) return preview;
  const transactionId = input.transactionId ?? "tx-preview-1";
  const previewHash = input.previewHash ?? "preview-hash-1";
  return Object.assign(preview, {
    transactionId,
    previewHash,
    transaction: {
      version: "transaction-hardening-v1" as const,
      transactionId,
      previewHash,
      projectHash: "project-hash",
      chapter: 1,
      draftHash: "draft-hash",
      commitPlanHash: "commit-plan-hash",
      selectiveCandidateSummaryHash: "selective-summary-hash",
    },
  });
}
