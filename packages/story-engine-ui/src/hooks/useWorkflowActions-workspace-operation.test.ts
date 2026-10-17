import { beforeEach, describe, expect, it, vi } from "vitest";

import { useBookStore } from "../stores/bookStore.js";
import { useChatStore } from "../stores/chatStore.js";
import { useUiStore } from "../stores/uiStore.js";
import { useDraftStore } from "../stores/draftStore.js";
import { useNavigationStore } from "../stores/navigationStore.js";
import { mockWorkspaceData } from "../mockData.js";
import type { DraftRevisionPreview, DraftRevisionTask, StateOverview } from "../api/types.js";
import { beginWorkspaceOperation, finishWorkspaceOperation, resetWorkspaceOperationForTests } from "../utils/workspaceOperation.js";

const apiMocks = vi.hoisted(() => ({
  applyDeAiFlavorBatch: vi.fn(),
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

const paperMocks = vi.hoisted(() => ({
  applyOverviewToWorkspace: vi.fn(),
  flushDraftSave: vi.fn(async () => ({ ok: true })),
  refreshPaper: vi.fn(async () => undefined),
}));
vi.mock("../workspace/applyOverview.js", () => ({
  applyOverviewToWorkspace: paperMocks.applyOverviewToWorkspace,
  flowStatusForPaper: () => "draft_ready",
}));
vi.mock("../drafts/draftSync.js", () => ({
  flushDraftSave: paperMocks.flushDraftSave,
  refreshPaper: paperMocks.refreshPaper,
}));

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
  useBookStore.setState({
    workspace: {
      ...mockWorkspaceData,
      currentChapter: { id: `ch-${chapter}`, chapterNumber: chapter, title: `第${chapter}章`, status: "current" },
      flowStatus: "draft_ready",
    },
  });
  useChatStore.setState({
    messages: [],
    activeSessionId: sessionId,
    chatError: null,
  });
  useUiStore.setState({
    draftActionLoading: null,
    draftCandidates: null,
    selectedAdviceCards: [],
    steeringError: null,
    activeRevisionTask: null,
    activeRevisionPreview: null,
  });
  useDraftStore.getState().loadPaper("/tmp/story-project", { chapter, draft: { chapter, body: content, version: `v-${chapter}` }, committed: null, editedSinceCommit: null });
}

async function actions() {
  const { useWorkflowActions } = await import("./useWorkflowActions.js");
  return useWorkflowActions({
    projectPath: "/tmp/story-project",
    appendMessage: useChatStore.getState().appendMessage,
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
  useUiStore.setState({
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
    paperMocks.flushDraftSave.mockImplementation(async () => ({ ok: true }));
    resetWorkspaceOperationForTests();
    useNavigationStore.getState().clearToast();
    useNavigationStore.setState({ projectPath: "/tmp/story-project" });
    setChapter(1, A_DRAFT);
  });

  it("drops a late revision preview after the originating chapter changes", async () => {
    const gate = deferred<{ task: DraftRevisionTask; preview: DraftRevisionPreview }>();
    apiMocks.previewDraftRevision.mockReturnValueOnce(gate.promise);
    const workflow = await actions();

    useUiStore.getState().setActiveRevisionTask(revisionTask());
    const pending = workflow.handleGenerateRevisionPreview();
    await vi.waitFor(() => expect(apiMocks.previewDraftRevision).toHaveBeenCalled());
    setChapter(2, B_DRAFT, "session-b");
    gate.resolve({ task: revisionTask(), preview: revisionPreview() });
    await pending;

    expect(useUiStore.getState().activeRevisionPreview).toBeNull();
    expect(useNavigationStore.getState().toast).toContain("你切换了书");
  });

  it("refuses to apply a candidate created for chapter A after switching to B", async () => {
    apiMocks.generateDraftCandidate
      .mockResolvedValueOnce({ draftContent: "# 候选 A1\n\n第一版", draftTitle: "候选 A1" })
      .mockResolvedValueOnce({ draftContent: "# 候选 A2\n\n第二版", draftTitle: "候选 A2" });
    const workflow = await actions();

    await workflow.handleRerollCandidates();
    const candidate = useUiStore.getState().draftCandidates?.[0];
    expect(candidate).toBeTruthy();
    setChapter(2, B_DRAFT, "session-b");
    useUiStore.getState().setDraftCandidates(candidate ? [candidate] : []);
    await workflow.handleApplyCandidate(candidate?.content ?? "");

    expect(apiMocks.applyDraftCandidate).not.toHaveBeenCalled();
    expect(useNavigationStore.getState().toast).toContain("切换前的那本书");
    expect(useDraftStore.getState().body).toBe(B_DRAFT);
  });

  it("fails closed when a candidate has no originating target", async () => {
    useUiStore.getState().setDraftCandidates([{ content: "# 无归属候选\n\n不能写入" } as never]);
    const workflow = await actions();

    await workflow.handleApplyCandidate("# 无归属候选\n\n不能写入");

    expect(apiMocks.applyDraftCandidate).not.toHaveBeenCalled();
    expect(useNavigationStore.getState().toast).toContain("缺少工作区归属");
  });

  it("fails closed when a revision preview has no originating target", async () => {
    useUiStore.setState({
      activeRevisionTask: revisionTask(),
      activeRevisionPreview: revisionPreview() as never,
    });
    const workflow = await actions();

    await workflow.handleApplyRevisionPreview();

    expect(apiMocks.applyDraftRevision).not.toHaveBeenCalled();
    expect(useNavigationStore.getState().toast).toContain("缺少工作区归属");
  });

  it.each([
    ["de-ai batch", "applyDeAiFlavorBatch"],
  ] as const)("atomically blocks %s when another foreground operation owns the slot", async (_entry, apiName) => {
    seedCommitPreview();
    const owner = beginWorkspaceOperation("generate-draft", {
      projectPath: "/tmp/story-project",
      chapter: 1,
      sessionId: "session-a",
    });
    expect(owner).not.toBeNull();
    const workflow = await actions();

    await workflow.handleFixAiFlavorAll([{ id: "v1", text: "需要改写" }], "message-1");

    expect(apiMocks[apiName]).not.toHaveBeenCalled();
    finishWorkspaceOperation(owner!);
  });

  it.each([
    ["de-ai batch", "applyDeAiFlavorBatch", "draftActionLoading"],
  ] as const)("drops late %s failure without clearing replacement workspace state", async (_entry, apiName, loadingField) => {
    seedCommitPreview();
    const gate = deferred<never>();
    apiMocks[apiName].mockReturnValueOnce(gate.promise);
    const workflow = await actions();

    const pending = workflow.handleFixAiFlavorAll([{ id: "v1", text: "需要改写" }], "message-1");
    await vi.waitFor(() => expect(apiMocks[apiName]).toHaveBeenCalled());

    setChapter(2, B_DRAFT, "session-b");
    useUiStore.setState({
      [loadingField]: "replacement-loading",
      steeringError: "replacement-safe",
      aiFlavorBatchPending: "replacement-batch",
    });
    gate.reject(new Error("late failure"));
    await pending;

    const state = { ...useUiStore.getState(), ...useChatStore.getState() };
    expect(state.steeringError).toBe("replacement-safe");
    expect(state.aiFlavorBatchPending).toBe("replacement-batch");
    expect(state.draftActionLoading).toBe("replacement-loading");
  });
});
