import { beforeEach, describe, expect, it, vi } from "vitest";

import { useBookStore } from "../stores/bookStore.js";
import { useChatStore } from "../stores/chatStore.js";
import { useUiStore } from "../stores/uiStore.js";
import { useDraftStore } from "../stores/draftStore.js";
import { useNavigationStore } from "../stores/navigationStore.js";
import { mockWorkspaceData } from "../mockData.js";
import { resetWorkspaceOperationForTests } from "../utils/workspaceOperation.js";

const apiMocks = vi.hoisted(() => ({
  applyDraftCandidate: vi.fn(),
  generateDraftCandidate: vi.fn(),
  checkDraftQuality: vi.fn(),
  generateDraftStream: vi.fn(),
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
  });
  useDraftStore.getState().loadPaper("/tmp/story-project", { chapter, draft: { chapter, body: content, version: `v-${chapter}` }, committed: null, editedSinceCommit: null });
}

async function actions() {
  const { useWorkflowActions } = await import("./useWorkflowActions.js");
  return useWorkflowActions({ projectPath: "/tmp/story-project" });
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

  it("refuses to apply a candidate created for chapter A after switching to B", async () => {
    apiMocks.generateDraftCandidate
      .mockResolvedValueOnce({ draftBody: "第一版", draftTitle: "候选 A1" })
      .mockResolvedValueOnce({ draftBody: "第二版", draftTitle: "候选 A2" });
    const workflow = await actions();

    await workflow.handleRerollCandidates();
    // 不编方向：照本章已有章纲另写（服务端沿用章纲里作者的原话）。
    expect(apiMocks.generateDraftCandidate).toHaveBeenCalledWith(expect.not.objectContaining({ chapterGoal: expect.anything() }));
    const candidate = useUiStore.getState().draftCandidates?.[0];
    expect(candidate).toBeTruthy();
    setChapter(2, B_DRAFT, "session-b");
    useUiStore.getState().setDraftCandidates(candidate ? [candidate] : []);
    await workflow.handleApplyCandidate(candidate!);

    expect(apiMocks.applyDraftCandidate).not.toHaveBeenCalled();
    expect(useNavigationStore.getState().toast).toContain("切换前的那本书");
    expect(useDraftStore.getState().body).toBe(B_DRAFT);
  });

  it("fails closed when a candidate has no originating target", async () => {
    const orphan = { body: "不能写入", title: "无归属候选" } as never;
    useUiStore.getState().setDraftCandidates([orphan]);
    const workflow = await actions();

    await workflow.handleApplyCandidate(orphan);

    expect(apiMocks.applyDraftCandidate).not.toHaveBeenCalled();
    expect(useNavigationStore.getState().toast).toContain("缺少工作区归属");
  });
});
