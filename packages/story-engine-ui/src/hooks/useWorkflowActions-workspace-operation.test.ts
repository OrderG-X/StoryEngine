import { beforeEach, describe, expect, it, vi } from "vitest";

import { useWorkspaceStore } from "../stores/workspaceStore.js";
import { useNavigationStore } from "../stores/navigationStore.js";
import { mockWorkspaceData } from "../mockData.js";
import type { DraftRevisionPreview, DraftRevisionTask, StateOverview } from "../api/types.js";
import { beginWorkspaceOperation, finishWorkspaceOperation, resetWorkspaceOperationForTests } from "../utils/workspaceOperation.js";

const apiMocks = vi.hoisted(() => ({
  applyCommit: vi.fn(),
  applyDeAiFlavorBatch: vi.fn(),
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

const A_DRAFT = "# 第一章\n\n这是第一章生成前已经存在的真实草稿内容。";
const B_DRAFT = "# 第二章\n\n这是第二章自己的正文，绝对不能被第一章覆盖。";
const GENERATED = "# 第一章\n\n这是第一章正在流式生成的新正文。";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function setChapter(chapter: number, content: string, sessionId = "session-a") {
  useWorkspaceStore.setState({
    workspace: {
      ...mockWorkspaceData,
      currentChapter: { id: `ch-${chapter}`, chapterNumber: chapter, title: `第${chapter}章`, status: "current" },
      flowStatus: "draft_ready",
      draft: { chapterNumber: chapter, title: `第${chapter}章`, status: "draft", content, savedContent: content },
      messages: [],
    },
    activeSessionId: sessionId,
    draftActionLoading: null,
    draftCandidates: null,
    selectedAdviceCards: [],
    chatError: null,
    steeringError: null,
    activeRevisionTask: null,
    activeRevisionPreview: null,
  });
}

async function actions() {
  const { useWorkflowActions } = await import("./useWorkflowActions.js");
  return useWorkflowActions({
    projectPath: "/tmp/story-project",
    resolveChapterDirection: (value?: unknown) => typeof value === "string" ? value : "",
    appendMessage: useWorkspaceStore.getState().appendMessage,
    appendWorkflowPrompt: vi.fn(),
    applyOverviewToWorkspace: vi.fn(),
  });
}

function revisionTask(): DraftRevisionTask {
  return {
    id: "revision-a",
    chapter: 1,
    targetType: "section",
    targetText: "真实草稿内容",
    problemSummary: "润色",
    revisionGoal: "写得更好",
    constraints: [],
    status: "pending",
  };
}

function revisionPreview(): DraftRevisionPreview {
  return {
    taskId: "revision-a",
    beforeText: "真实草稿内容",
    afterText: "更有画面的真实草稿内容",
    changeSummary: "润色",
    rationale: "更具体",
    riskNotes: [],
    preservedFacts: [],
    warnings: [],
  };
}

function seedCommitPreview() {
  useWorkspaceStore.setState({
    commitPreviewReport: {
      chapter: 1,
      highRiskIssueCount: 0,
      blockingReasons: [],
      candidates: [],
      nameDriftFindings: [],
      staleThreadWarnings: [],
      transactionId: "tx-1",
      previewHash: "hash-1",
    } as never,
  });
}

describe("workspace-bound writing operations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetWorkspaceOperationForTests();
    useNavigationStore.getState().clearToast();
    useNavigationStore.setState({ projectPath: "/tmp/story-project" });
    setChapter(1, A_DRAFT);
  });

  it("blocks quality review while direct draft generation is streaming", async () => {
    const gate = deferred<void>();
    apiMocks.generateDraftStream.mockImplementationOnce(async (_input, handlers) => {
      handlers.onDelta(GENERATED);
      await gate.promise;
      handlers.onDone({ overview: {} as StateOverview, draftContent: GENERATED, draftTitle: "第一章" });
    });
    apiMocks.checkDraftQuality.mockResolvedValue({ passed: true, issues: [], candidates: [] });
    const workflow = await actions();

    const generating = workflow.handleGenerateDraft("继续第一章");
    await vi.waitFor(() => expect(useWorkspaceStore.getState().workspace.draft.content).toContain("流式生成"));
    await workflow.handleQualityCheck();

    expect(apiMocks.checkDraftQuality).not.toHaveBeenCalled();
    expect(useNavigationStore.getState().toast).toContain("正在进行");
    gate.resolve();
    await generating;
  });

  it("blocks AI review while direct draft generation is streaming", async () => {
    const gate = deferred<void>();
    apiMocks.generateDraftStream.mockImplementationOnce(async (_input, handlers) => {
      handlers.onDelta(GENERATED);
      await gate.promise;
      handlers.onDone({ overview: {} as StateOverview, draftContent: GENERATED, draftTitle: "第一章" });
    });
    apiMocks.reviewDraftWithAI.mockResolvedValue({
      verdict: "ready_to_commit",
      score: 90,
      summary: "ok",
      issues: [],
      suggestedRevisions: [],
    });
    const workflow = await actions();

    const generating = workflow.handleGenerateDraft("继续第一章");
    await vi.waitFor(() => expect(useWorkspaceStore.getState().workspace.draft.content).toContain("流式生成"));
    await workflow.handleDraftAIReview();

    expect(apiMocks.reviewDraftWithAI).not.toHaveBeenCalled();
    expect(useNavigationStore.getState().toast).toContain("正在进行");
    gate.resolve();
    await generating;
  });

  it("does not restore chapter A content into chapter B when A generation fails late", async () => {
    const gate = deferred<void>();
    apiMocks.generateDraftStream.mockImplementationOnce(async (_input, handlers) => {
      handlers.onDelta(GENERATED);
      await gate.promise;
    });
    const workflow = await actions();

    const generating = workflow.handleGenerateDraft("继续第一章");
    await vi.waitFor(() => expect(apiMocks.generateDraftStream).toHaveBeenCalled());
    setChapter(2, B_DRAFT, "session-b");
    useWorkspaceStore.setState({ draftActionLoading: "new-workspace-loading" });
    gate.reject(new Error("late failure"));
    await generating;

    expect(useWorkspaceStore.getState().workspace.currentChapter.chapterNumber).toBe(2);
    expect(useWorkspaceStore.getState().workspace.draft.content).toBe(B_DRAFT);
    expect(useWorkspaceStore.getState().draftActionLoading).toBe("new-workspace-loading");
  });

  it("treats returning home (null project path) as target invalidation even when chapter/session numbers match", async () => {
    const gate = deferred<void>();
    apiMocks.generateDraftStream.mockImplementationOnce(async (_input, handlers) => {
      await gate.promise;
      handlers.onDelta(GENERATED);
    });
    const workflow = await actions();

    const generating = workflow.handleGenerateDraft("继续第一章");
    await vi.waitFor(() => expect(apiMocks.generateDraftStream).toHaveBeenCalled());
    useNavigationStore.setState({ projectPath: null });
    setChapter(1, "首页切换后保留的内存态", "session-a");
    gate.resolve();
    await generating;

    expect(useWorkspaceStore.getState().workspace.draft.content).toBe("首页切换后保留的内存态");
  });

  it("drops a late revision preview after the originating chapter changes", async () => {
    const gate = deferred<{ task: DraftRevisionTask; preview: DraftRevisionPreview }>();
    apiMocks.previewDraftRevision.mockReturnValueOnce(gate.promise);
    const workflow = await actions();

    useWorkspaceStore.getState().setActiveRevisionTask(revisionTask());
    const pending = workflow.handleGenerateRevisionPreview();
    await vi.waitFor(() => expect(apiMocks.previewDraftRevision).toHaveBeenCalled());
    setChapter(2, B_DRAFT, "session-b");
    gate.resolve({ task: revisionTask(), preview: revisionPreview() });
    await pending;

    expect(useWorkspaceStore.getState().activeRevisionPreview).toBeNull();
    expect(useNavigationStore.getState().toast).toContain("你切换了书");
  });

  it("refuses to apply a candidate created for chapter A after switching to B", async () => {
    apiMocks.generateDraftCandidate
      .mockResolvedValueOnce({ draftContent: "# 候选 A1\n\n第一版", draftTitle: "候选 A1" })
      .mockResolvedValueOnce({ draftContent: "# 候选 A2\n\n第二版", draftTitle: "候选 A2" });
    const workflow = await actions();

    await workflow.handleRerollCandidates();
    const candidate = useWorkspaceStore.getState().draftCandidates?.[0];
    expect(candidate).toBeTruthy();
    setChapter(2, B_DRAFT, "session-b");
    useWorkspaceStore.getState().setDraftCandidates(candidate ? [candidate] : []);
    await workflow.handleApplyCandidate(candidate?.content ?? "");

    expect(apiMocks.applyDraftCandidate).not.toHaveBeenCalled();
    expect(useNavigationStore.getState().toast).toContain("切换前的那本书");
    expect(useWorkspaceStore.getState().workspace.draft.content).toBe(B_DRAFT);
  });

  it("fails closed when a candidate has no originating target", async () => {
    useWorkspaceStore.getState().setDraftCandidates([{ content: "# 无归属候选\n\n不能写入" } as never]);
    const workflow = await actions();

    await workflow.handleApplyCandidate("# 无归属候选\n\n不能写入");

    expect(apiMocks.applyDraftCandidate).not.toHaveBeenCalled();
    expect(useNavigationStore.getState().toast).toContain("缺少工作区归属");
  });

  it("fails closed when a revision preview has no originating target", async () => {
    useWorkspaceStore.setState({
      activeRevisionTask: revisionTask(),
      activeRevisionPreview: revisionPreview() as never,
    });
    const workflow = await actions();

    await workflow.handleApplyRevisionPreview();

    expect(apiMocks.applyDraftRevision).not.toHaveBeenCalled();
    expect(useNavigationStore.getState().toast).toContain("缺少工作区归属");
  });

  it.each([
    ["steering", "fetchChapterSteering"],
    ["commit preview", "previewCommit"],
    ["commit apply", "applyCommit"],
    ["de-ai batch", "applyDeAiFlavorBatch"],
  ] as const)("atomically blocks %s when another foreground operation owns the slot", async (entry, apiName) => {
    seedCommitPreview();
    const owner = beginWorkspaceOperation("generate-draft", {
      projectPath: "/tmp/story-project",
      chapter: 1,
      sessionId: "session-a",
    });
    expect(owner).not.toBeNull();
    const workflow = await actions();

    if (entry === "steering") await workflow.generateSteering("继续第一章");
    else if (entry === "commit preview") await workflow.handleCommitPreview();
    else if (entry === "commit apply") await workflow.executeCommitApply();
    else await workflow.handleFixAiFlavorAll([{ id: "v1", text: "需要改写" }], "message-1");

    expect(apiMocks[apiName]).not.toHaveBeenCalled();
    finishWorkspaceOperation(owner!);
  });

  it.each([
    ["steering", "fetchChapterSteering", "steeringLoading"],
    ["commit preview", "previewCommit", "draftActionLoading"],
    ["commit apply", "applyCommit", "draftActionLoading"],
    ["de-ai batch", "applyDeAiFlavorBatch", "draftActionLoading"],
  ] as const)("drops late %s failure without clearing replacement workspace state", async (entry, apiName, loadingField) => {
    seedCommitPreview();
    const gate = deferred<never>();
    apiMocks[apiName].mockReturnValueOnce(gate.promise);
    const workflow = await actions();

    let pending: Promise<void>;
    if (entry === "steering") pending = workflow.generateSteering("继续第一章");
    else if (entry === "commit preview") pending = workflow.handleCommitPreview();
    else if (entry === "commit apply") pending = workflow.executeCommitApply();
    else pending = workflow.handleFixAiFlavorAll([{ id: "v1", text: "需要改写" }], "message-1");
    await vi.waitFor(() => expect(apiMocks[apiName]).toHaveBeenCalled());

    setChapter(2, B_DRAFT, "session-b");
    useWorkspaceStore.setState({
      [loadingField]: loadingField === "steeringLoading" ? true : "replacement-loading",
      steeringError: "replacement-safe",
      aiFlavorBatchPending: "replacement-batch",
    });
    gate.reject(new Error("late failure"));
    await pending;

    const state = useWorkspaceStore.getState();
    expect(state.steeringError).toBe("replacement-safe");
    expect(state.aiFlavorBatchPending).toBe("replacement-batch");
    if (loadingField === "steeringLoading") expect(state.steeringLoading).toBe(true);
    else expect(state.draftActionLoading).toBe("replacement-loading");
  });
});
