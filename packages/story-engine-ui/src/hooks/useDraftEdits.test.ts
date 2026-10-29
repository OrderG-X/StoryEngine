// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDraftEdits } from "./useDraftEdits.js";
import { useDraftStore } from "../stores/draftStore.js";
import { useNavigationStore } from "../stores/navigationStore.js";
import { useUiStore } from "../stores/uiStore.js";
import type { AiFlavorViolation } from "../type-defs/workspace.js";

const BODY = "他慢慢地走了过去。那一刻，他明白了。";

function openPaper(options: { readonly committed?: boolean } = {}) {
  useDraftStore.getState().loadPaper("/book", {
    chapter: 4,
    draft: options.committed ? null : { body: BODY, version: "v1" },
    committed: options.committed ? { body: BODY, version: "c1" } : null,
  } as never);
}

const violation = (id: string, text: string): AiFlavorViolation => ({ id, text, reason: "套话", severity: "high", suggestedFix: "改成动作" });

describe("useDraftEdits（片 2C：改稿按钮交改稿操作、进对话一轮）", () => {
  let send: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    send = vi.fn(async () => undefined);
    useNavigationStore.getState().clearToast();
    useUiStore.getState().resetTransientUiState();
    openPaper();
  });

  it("选中文字改写：交改写、先给作者看（preview），模板的改法 + 「自己说」的要求；去机器腔带 deai 手法；回显说清怎么改", async () => {
    const edits = useDraftEdits({ sendUserAction: send });
    await edits.handleSelectionRewrite("他慢慢地走了过去。", "polish");
    const [action, options] = send.mock.lastCall!;
    expect(action).toMatchObject({ kind: "new", type: "draft.change", mode: "revise", params: { mode: "revise", chapter: 4, preview: true, edits: [{ targetText: "他慢慢地走了过去。" }] } });
    expect(action.params.edits[0].revisionGoal).toContain("润色");
    expect(action.params).not.toHaveProperty("style");
    expect(options).toEqual({ echo: "润色第 4 章这段：「他慢慢地走了过去。」" });

    await edits.handleSelectionRewrite("他慢慢地走了过去。", "deai");
    expect(send.mock.lastCall![0].params.style).toBe("deai");

    await edits.handleSelectionRewriteCustom("他慢慢地走了过去。", " 写快一点 ");
    expect(send.mock.lastCall![0].params.edits[0].revisionGoal).toContain("针对本句的具体方向：写快一点");
    expect(send.mock.lastCall![1]).toEqual({ echo: "改第 4 章这段（写快一点）：「他慢慢地走了过去。」" });
  });

  it("交不了的如实说、不交：没选字、选太长、已定稿、稿纸上挂着「稿子在别处改过」", async () => {
    const edits = useDraftEdits({ sendUserAction: send });
    await edits.handleSelectionRewrite("   ", "polish");
    expect(useNavigationStore.getState().toast).toContain("选中一段");
    await edits.handleSelectionRewrite("字".repeat(801), "polish");
    expect(useNavigationStore.getState().toast).toContain("最多改 800 字");
    useDraftStore.setState({ incoming: { cause: "conflict" } as never });
    await edits.handleSelectionRewrite("他慢慢地走了过去。", "polish");
    expect(useNavigationStore.getState().toast).toContain("先选好用哪一版");
    openPaper({ committed: true });
    await edits.handleSelectionRewrite("他慢慢地走了过去。", "polish");
    expect(useNavigationStore.getState().toast).toContain("已定稿");
    edits.handleFixAiFlavorViolation(violation("v1", "那一刻，他明白了。"), "m1");
    expect(send).not.toHaveBeenCalled();
    expect(useUiStore.getState().aiFlavorPending).toBeNull();
  });

  it("AI 味卡「改掉这句」只交这一句、「一键全修」交卡上还没改的几句（最多 30 句）；这一轮完了「改写中…」收起", async () => {
    let finish!: () => void;
    send.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const edits = useDraftEdits({ sendUserAction: send });
    edits.handleFixAiFlavorViolation(violation("v1", "那一刻，他明白了。"), "m1");
    expect(send.mock.lastCall![0]).toMatchObject({ mode: "deai", params: { mode: "deai", chapter: 4, violations: [{ id: "v1", text: "那一刻，他明白了。", reason: "套话", severity: "high", suggestedFix: "改成动作" }] } });
    expect(useUiStore.getState().aiFlavorPending).toEqual({ messageId: "m1", violationId: "v1" });
    finish();
    await vi.waitFor(() => expect(useUiStore.getState().aiFlavorPending).toBeNull());

    edits.handleFixAiFlavorAll(Array.from({ length: 35 }, (_, index) => violation(`v${index}`, `第 ${index} 句。`)), "m2");
    expect(send.mock.lastCall![0].params.violations).toHaveLength(30);
    expect(useUiStore.getState().aiFlavorBatchPending).toBe("m2");
    finish();
    await vi.waitFor(() => expect(useUiStore.getState().aiFlavorBatchPending).toBeNull());
  });
});
