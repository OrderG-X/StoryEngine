import { describe, expect, it } from "vitest";
import type { ChapterWorkspaceSnapshot } from "../api/types.js";
import { mockWorkspaceData } from "../mockData.js";
import type { ChapterWorkspaceData } from "../type-defs/workspace.js";
import { buildWorkspacePatchAfterAgentUndo } from "./agentUndoSync.js";

function currentWorkspace(): ChapterWorkspaceData {
  const base = mockWorkspaceData as unknown as ChapterWorkspaceData;
  return {
    ...base,
    flowStatus: "draft_ready",
    draft: { ...base.draft, chapterNumber: 3, title: "内存旧标题", content: "内存里撤销前的旧稿", savedContent: "内存里撤销前的旧稿", status: "draft" },
  };
}

function snap(overrides: Partial<ChapterWorkspaceSnapshot>): ChapterWorkspaceSnapshot {
  return { chapter: 3, messages: [], selectedAdviceCardKeys: [], ...overrides } as ChapterWorkspaceSnapshot;
}

describe("buildWorkspacePatchAfterAgentUndo（agent 撤销后磁盘真值接管）", () => {
  it("磁盘有草稿：正文/标题/状态/文件标记/revision 全部以磁盘为准，内存旧稿不留", () => {
    const patch = buildWorkspacePatchAfterAgentUndo(snap({
      flowStatus: "draft_ready", draftContent: "磁盘回退后的版本", draftTitle: "磁盘标题",
      hasDraftFile: true, hasCommittedChapter: false, revision: 7,
    }), 3, currentWorkspace());
    expect(patch.draft).toMatchObject({ chapterNumber: 3, title: "磁盘标题", content: "磁盘回退后的版本", savedContent: "磁盘回退后的版本", status: "draft" });
    expect(patch.draft.wordCount).toBeGreaterThan(0);
    expect(patch.flowStatus).toBe("draft_ready");
    expect(patch.currentChapter).toMatchObject({ title: "磁盘标题", hasDraftFile: true, hasCommittedChapter: false, hasWorkspaceSnapshot: true });
    expect(patch.chapters.find((c) => c.chapterNumber === 3)).toMatchObject({ title: "磁盘标题", hasDraftFile: true, hasCommittedChapter: false });
    expect(patch.revision).toBe(7);
  });

  it("磁盘无草稿（撤到还没写过）：正文清空、状态 idle、文件标记复位、revision 缺省 0——绝不保留内存旧稿", () => {
    const patch = buildWorkspacePatchAfterAgentUndo(snap({ hasDraftFile: false, hasCommittedChapter: false }), 3, currentWorkspace());
    expect(patch.draft.content).toBe("");
    expect(patch.draft.savedContent).toBe("");
    expect(patch.draft.wordCount).toBeUndefined();
    expect(patch.flowStatus).toBe("idle");
    expect(patch.currentChapter.hasDraftFile).toBe(false);
    expect(patch.revision).toBe(0);
  });

  it("磁盘快照没带 flowStatus 时按文件标记推断：已定稿 → committed、草稿状态 committed", () => {
    const patch = buildWorkspacePatchAfterAgentUndo(snap({
      draftContent: "# 定稿标题\n正文", hasDraftFile: true, hasCommittedChapter: true, revision: 3,
    }), 3, currentWorkspace());
    expect(patch.flowStatus).toBe("committed");
    expect(patch.draft.status).toBe("committed");
    expect(patch.draft.title).toBe("定稿标题"); // 快照无标题 → 从正文抽
  });

  it("不动其它章的条目", () => {
    const current = currentWorkspace();
    const patch = buildWorkspacePatchAfterAgentUndo(snap({ draftContent: "x", hasDraftFile: true, revision: 1 }), 3, current);
    for (const item of patch.chapters) {
      if (item.chapterNumber !== 3) expect(item).toEqual(current.chapters.find((c) => c.chapterNumber === item.chapterNumber));
    }
  });
});
