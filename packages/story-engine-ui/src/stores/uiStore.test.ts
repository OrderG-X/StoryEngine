import { beforeEach, describe, expect, it, vi } from "vitest";

describe("resetTransientUiState（切项目清残留临时态，防跨书串写）", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("清掉 draftCandidates 等所有「操作在飞」临时态（防 A 书候选稿挂到 B 书）", async () => {
    const { useUiStore } = await import("./uiStore.js");
    const store = useUiStore.getState();
    // 模拟 A 书残留的在飞态。
    store.setDraftCandidates([{ chapter: 1, title: "A书候选稿", content: "A书正文" }] as never);
    store.setCommitPreviewReport({} as never);
    store.setDraftAIReview({} as never);
    store.setActiveRevisionTask({} as never);
    store.setActiveRevisionPreview({} as never);
    store.setSteeringDraft({} as never);
    expect(useUiStore.getState().draftCandidates).not.toBeNull();

    useUiStore.getState().resetTransientUiState();

    const s = useUiStore.getState();
    expect(s.draftCandidates).toBeNull();
    expect(s.commitPreviewReport).toBeNull();
    expect(s.draftAIReview).toBeNull();
    expect(s.activeRevisionTask).toBeNull();
    expect(s.activeRevisionPreview).toBeNull();
    expect(s.steeringDraft).toBeNull();
  });
});
