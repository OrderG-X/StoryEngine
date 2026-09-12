// @vitest-environment node
//
// read_chapters_overview：全书章节地图（空/草稿/入库），给 agent 进度抓手（⑤治本）。
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ToolExecutionContext } from "@mastra/core/tools";

import { buildProjectRequestContext } from "../request-context.js";

vi.mock("../../lib/project-io.js", () => ({
  readUiChapterFileStates: vi.fn(),
}));
import { readUiChapterFileStates } from "../../lib/project-io.js";
import { readChaptersOverviewTool } from "./read-chapters-overview.js";

const mockRead = vi.mocked(readUiChapterFileStates);
const ctx = { requestContext: buildProjectRequestContext("/tmp/proj") } as unknown as ToolExecutionContext;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (context: ToolExecutionContext) => (readChaptersOverviewTool as any).execute({}, context);

describe("read_chapters_overview 全书章节地图", () => {
  beforeEach(() => mockRead.mockReset());

  it("把每章文件状态映射成 committed/draft/empty + 标题", async () => {
    mockRead.mockResolvedValue([
      { chapter: 1, hasDraftFile: false, hasCommittedChapter: true, committedTitle: "归途" },
      { chapter: 2, hasDraftFile: true, hasCommittedChapter: false, draftTitle: "暗涌" },
      { chapter: 3, hasDraftFile: false, hasCommittedChapter: false },
    ]);
    const out = await run(ctx);
    expect(out.ok).toBe(true);
    expect(out.chapters).toEqual([
      { chapter: 1, status: "committed", title: "归途" },
      { chapter: 2, status: "draft", title: "暗涌" },
      { chapter: 3, status: "empty" },
    ]);
    expect(out.summary).toContain("已定稿 1 章");
    expect(out.summary).toContain("有工作稿未定稿 1 章");
    expect(out.summary).toContain("最大章号 3");
  });

  it("空书 → ok:true, chapters 空, summary 说空书", async () => {
    mockRead.mockResolvedValue([]);
    const out = await run(ctx);
    expect(out.ok).toBe(true);
    expect(out.chapters).toEqual([]);
    expect(out.summary).toContain("空书");
  });

  it("题材中立：summary 不含任何题材词", async () => {
    mockRead.mockResolvedValue([{ chapter: 1, hasDraftFile: true, hasCommittedChapter: false }]);
    const out = await run(ctx);
    expect(out.summary).not.toMatch(/玄幻|修仙|武侠|霸总|穿越|科幻|言情/u);
  });

  it("缺 projectDir → 抛错（绝不静默失败）", async () => {
    const emptyCtx = { requestContext: { get: () => undefined } } as unknown as ToolExecutionContext;
    await expect(run(emptyCtx)).rejects.toThrow(/缺少 projectDir/u);
  });
});
