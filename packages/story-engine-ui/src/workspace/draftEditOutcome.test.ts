import { beforeEach, describe, expect, it } from "vitest";
import { settleDraftEdit } from "./draftEditOutcome.js";
import type { OperationViewData } from "../api/agentChatClient.js";
import { useChatStore } from "../stores/chatStore.js";
import { useDraftStore } from "../stores/draftStore.js";
import { useUiStore } from "../stores/uiStore.js";

const report = {
  ok: true,
  summary: "两句机器腔",
  usedFallback: false,
  violations: [
    { id: "v1", text: "那一刻，他明白了。", reason: "套话", severity: "high" as const },
    { id: "v2", text: "心中五味杂陈。", reason: "套话", severity: "medium" as const },
  ],
};

function view(overrides: Partial<OperationViewData> = {}): OperationViewData {
  return {
    opId: "op-0123456789abcdef0123", kind: "draft.change", mode: "deai", chapter: 4, what: "去 AI 味·第 4 章", state: "succeeded", stateText: "", allowed: [], summary: "", eventSeq: 3,
    origin: { kind: "chat" },
    draft: { chapter: 4, applied: true, changes: [{ from: "那一刻，他\n明白了。", to: "他把信折好。" }] },
    ...overrides,
  };
}

describe("settleDraftEdit（片 2C：改稿做完了）", () => {
  beforeEach(() => {
    useUiStore.getState().resetTransientUiState();
    useDraftStore.getState().loadPaper("/book", { chapter: 4, draft: { body: "他把信折好。心中五味杂陈。", version: "v2" }, committed: null } as never);
    useChatStore.setState({ messages: [{ id: "m1", role: "assistant", content: "", cards: [{ type: "ai-flavor", report }] }] as never });
  });

  it("换上了：稿纸高亮改后那几句，AI 味卡上改掉的那句标「已改」，「改写中…」收起", () => {
    useUiStore.getState().setAiFlavorBatchPending("m1");
    settleDraftEdit(view());
    expect(useUiStore.getState().revisionHighlightTexts).toEqual(["他把信折好。"]);
    const card = useChatStore.getState().messages[0]!.cards!.find((item) => item.type === "ai-flavor") as { fixedIds?: readonly string[] };
    expect(card.fixedIds).toEqual(["v1"]);
    expect(useUiStore.getState().aiFlavorBatchPending).toBeNull();
  });

  it("没换上、不是稿纸开着的那章：不高亮、不标，只收起", () => {
    useUiStore.getState().setAiFlavorPending({ messageId: "m1", violationId: "v1" });
    settleDraftEdit(view({ state: "failed", draft: undefined }));
    expect(useUiStore.getState().revisionHighlightTexts).toEqual([]);
    expect(useUiStore.getState().aiFlavorPending).toBeNull();
    settleDraftEdit(view({ chapter: 7 }));
    expect(useUiStore.getState().revisionHighlightTexts).toEqual([]);
  });

  it("按核账改把那句删了（改成空）：没东西可标，稿纸不高亮", () => {
    settleDraftEdit(view({ mode: "fix", draft: { chapter: 4, applied: true, changes: [{ from: "心中五味杂陈。", to: "" }] } }));
    expect(useUiStore.getState().revisionHighlightTexts).toEqual([]);
  });
});
