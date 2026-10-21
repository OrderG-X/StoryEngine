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

describe("输入框草稿按章存（P11：切章不清空）", () => {
  it("切走存下、切回来还在；去的那章没写过就是空；空着离开不留；换书清空", async () => {
    vi.resetModules();
    const { useUiStore } = await import("./uiStore.js");
    const store = () => useUiStore.getState();
    store().setSteeringDirection("第 1 章想让她晚点回家");
    store().switchComposerChapter(1, 2);
    expect(store().steeringDirection).toBe("");
    store().setSteeringDirection("第 2 章的话");
    store().switchComposerChapter(2, 1);
    expect(store().steeringDirection).toBe("第 1 章想让她晚点回家");
    store().switchComposerChapter(1, 2);
    expect(store().steeringDirection).toBe("第 2 章的话");
    store().setSteeringDirection("  ");
    store().switchComposerChapter(2, 3);
    expect(store().composerDrafts).toEqual({ 1: "第 1 章想让她晚点回家" });
    store().switchComposerChapter(3, 3);
    expect(store().steeringDirection).toBe("");
    store().clearComposerDrafts();
    expect(store().composerDrafts).toEqual({});
  });
});
