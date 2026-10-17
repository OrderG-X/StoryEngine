import { beforeEach, describe, expect, it, vi } from "vitest";

import { useBookStore } from "../stores/bookStore.js";
import { useChatStore } from "../stores/chatStore.js";
import { useUiStore } from "../stores/uiStore.js";
import { useDraftStore } from "../stores/draftStore.js";
import { useNavigationStore } from "../stores/navigationStore.js";
import { mockWorkspaceData } from "../mockData.js";
import type { DraftRevisionPreview, DraftRevisionTask, StateOverview } from "../api/types.js";

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

const ORIGINAL_DRAFT = "# 第一章\n\n林远站在落地窗前，望着楼下的车流。这是一段需要润色的原文。";
const SELECTION_TEXT = "林远站在落地窗前，望着楼下的车流。";
const ORIGIN_TARGET = { projectPath: "/tmp/story-project", chapter: 1, sessionId: "", operationId: "fixture-op" } as const;

function makeTask(): DraftRevisionTask {
  return {
    id: "selection-rewrite-polish-ch1",
    chapter: 1,
    targetType: "section",
    targetText: SELECTION_TEXT,
    problemSummary: "用户选中一段正文，要求润色。",
    revisionGoal: "润色这段文字。",
    constraints: [],
    status: "pending",
  };
}

function makePreview(afterText: string): DraftRevisionPreview {
  return {
    taskId: "selection-rewrite-polish-ch1",
    beforeText: SELECTION_TEXT,
    afterText,
    changeSummary: "让语言更流畅。",
    rationale: "润色。",
    riskNotes: [],
    preservedFacts: [],
    warnings: [],
  };
}

describe("handleSelectionRewrite preview-then-confirm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    paperMocks.flushDraftSave.mockImplementation(async () => ({ ok: true }));
    useNavigationStore.getState().clearToast();
    useNavigationStore.setState({ projectPath: "/tmp/story-project" });
    useBookStore.setState({
      workspace: {
        ...mockWorkspaceData,
        currentChapter: { id: "ch-001", chapterNumber: 1, title: "第一章", status: "current" },
        flowStatus: "draft_ready",
      },
    });
    useChatStore.setState({
      messages: [],
      chatError: null,
      activeSessionId: "",
    });
    useUiStore.setState({
      draftActionLoading: null,
      steeringError: null,
      activeRevisionTask: null,
      activeRevisionPreview: null,
    });
    useDraftStore.getState().loadPaper("/tmp/story-project", { chapter: 1, draft: { chapter: 1, body: ORIGINAL_DRAFT, version: "v-1" }, committed: null, editedSinceCommit: null });
  });

  it("sets the revision preview state instead of applying directly", async () => {
    const { useWorkflowActions } = await import("./useWorkflowActions.js");
    apiMocks.previewDraftRevision.mockResolvedValueOnce({
      task: makeTask(),
      preview: makePreview("林远独自立在落地窗边，俯瞰楼下川流不息的车阵。"),
    });

    const applyOverviewToWorkspace = paperMocks.applyOverviewToWorkspace;

    await useWorkflowActions({
      projectPath: "/tmp/story-project",
      appendMessage: useChatStore.getState().appendMessage,
    }).handleSelectionRewrite(SELECTION_TEXT, "polish");

    const state = { ...useUiStore.getState(), ...useChatStore.getState() };

    // preview was generated
    expect(apiMocks.previewDraftRevision).toHaveBeenCalledTimes(1);
    // but NOT applied directly — no write to disk, no overview applied
    expect(apiMocks.applyDraftRevision).not.toHaveBeenCalled();
    expect(applyOverviewToWorkspace).not.toHaveBeenCalled();
    // the draft content is untouched (still original) — apply happens only on confirm
    expect(useDraftStore.getState().body).toBe(ORIGINAL_DRAFT);

    // a preview state is set so the comparison card can render in the codex shell
    expect(state.activeRevisionPreview).not.toBeNull();
    expect(state.activeRevisionPreview?.afterText).toContain("川流不息");
    expect(state.activeRevisionTask).not.toBeNull();
    // the selection text must be carried into the stored task so it survives loss of editor selection
    expect(state.activeRevisionTask?.targetText).toBe(SELECTION_TEXT);

    // loading cleared so the toolbar / apply button is interactive again
    expect(state.draftActionLoading).toBeNull();
  });

  it("does not set preview state and reports failure honestly on a no-op rewrite", async () => {
    const { useWorkflowActions } = await import("./useWorkflowActions.js");
    apiMocks.previewDraftRevision.mockResolvedValueOnce({
      task: makeTask(),
      preview: makePreview(SELECTION_TEXT), // afterText === beforeText → no-op fallback
    });

    await useWorkflowActions({
      projectPath: "/tmp/story-project",
      appendMessage: useChatStore.getState().appendMessage,
    }).handleSelectionRewrite(SELECTION_TEXT, "polish");

    const state = { ...useUiStore.getState(), ...useChatStore.getState() };
    expect(apiMocks.applyDraftRevision).not.toHaveBeenCalled();
    expect(state.activeRevisionPreview).toBeNull();
    expect(state.activeRevisionTask).toBeNull();
    expect(useDraftStore.getState().body).toBe(ORIGINAL_DRAFT);
    expect(useNavigationStore.getState().toast).toContain("原文未改动");
  });

  it("B2：应用手动改写后，对话记录带上 before→after（agent 不再对前端直改瞎眼）", async () => {
    const { useWorkflowActions } = await import("./useWorkflowActions.js");
    const before = "他心中五味杂陈。";
    const after = "他捏紧了杯子，没说话。";
    useUiStore.setState({
      activeRevisionTask: makeTask(),
      activeRevisionPreview: { ...makePreview(after), beforeText: before, afterText: after, originTarget: ORIGIN_TARGET },
    });
    apiMocks.applyDraftRevision.mockResolvedValueOnce({ overview: {}, draftContent: `# 第一章\n\n${after}\n` });

    await useWorkflowActions({
      projectPath: "/tmp/story-project",
      appendMessage: useChatStore.getState().appendMessage,
    }).handleApplyRevisionPreview();

    const request = apiMocks.applyDraftRevision.mock.calls[0]?.[0] as { preview?: Record<string, unknown>; targetText?: string } | undefined;
    expect(request?.preview).toBeDefined();
    expect(request?.preview).not.toHaveProperty("originTarget");
    // 目标级诚实守卫回传链：任务里存着的用户点名片段随 apply 带上（服务端自解析目标区间）
    expect(request?.targetText).toBe(SELECTION_TEXT);

    const applied = useChatStore.getState().messages.find(
      (m) => m.role === "assistant" && m.content.includes("改好"),
    );
    expect(applied).toBeTruthy();
    expect(applied!.content).toContain(before); // 具体原文进了对话 → agent 看得到
    expect(applied!.content).toContain(after);  // 具体改后文进了对话
  });

  it("P0-3：零差异应用入口拦下——不发请求、toast 诚实、清理任务态", async () => {
    const { useWorkflowActions } = await import("./useWorkflowActions.js");
    const same = "林远站在落地窗前。";
    useUiStore.setState({
      activeRevisionTask: makeTask(),
      activeRevisionPreview: { ...makePreview(same), beforeText: same, afterText: `  ${same}  `, originTarget: ORIGIN_TARGET },
    });

    await useWorkflowActions({
      projectPath: "/tmp/story-project",
      appendMessage: useChatStore.getState().appendMessage,
    }).handleApplyRevisionPreview();

    expect(apiMocks.applyDraftRevision).not.toHaveBeenCalled();
    expect(useNavigationStore.getState().toast).toContain("没有可应用的改动");
    expect(useUiStore.getState().activeRevisionPreview).toBeNull();
    expect(useUiStore.getState().activeRevisionTask).toBeNull();
  });
});
