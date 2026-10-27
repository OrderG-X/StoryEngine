// @vitest-environment node
//
// read_chapters_overview：全书章节地图（空/草稿/入库），给 agent 进度抓手（⑤治本）。
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ToolExecutionContext } from "@mastra/core/tools";

import { buildProjectRequestContext } from "../request-context.js";

vi.mock("../../lib/project-io.js", () => ({
  readUiChapterFileStates: vi.fn(),
}));
vi.mock("@actalk/story-core", () => ({ projectBook: vi.fn(async () => ({ chapters: [], threads: [] })) }));
vi.mock("../../services/pace-report.js", () => ({ readPaceReport: vi.fn() }));
import { readUiChapterFileStates } from "../../lib/project-io.js";
import { readPaceReport } from "../../services/pace-report.js";
import { readChaptersOverviewTool } from "./read-chapters-overview.js";

const mockRead = vi.mocked(readUiChapterFileStates);
const mockPace = vi.mocked(readPaceReport);
const ctx = { requestContext: buildProjectRequestContext("/tmp/proj") } as unknown as ToolExecutionContext;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (context: ToolExecutionContext) => (readChaptersOverviewTool as any).execute({}, context);

describe("read_chapters_overview 全书章节地图", () => {
  beforeEach(() => {
    mockRead.mockReset();
    mockPace.mockReset();
    mockPace.mockResolvedValue({ chapters: [], flags: [] });
  });

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

  it("顺带一句节奏诊断：和故事地图同一种说法；下不了结论、读不出来都如实说", async () => {
    mockRead.mockResolvedValue([{ chapter: 1, hasDraftFile: false, hasCommittedChapter: true }]);
    mockPace.mockResolvedValue({
      chapters: [],
      typical: { density: 2, words: 2000 },
      flags: [
        { kind: "drag", reason: "slow", from: 46, to: 46, words: 2094, advanced: 1, closed: 0 },
        { kind: "rush", reason: "span", from: 50, to: 50, words: 1284, advanced: 1, closed: 0, span: 16 },
      ],
    });
    expect((await run(ctx)).pace).toBe("节奏诊断（按账里每章推进的线索和字数，跟全书平常比；只是「可能」，作者自己判断）：第 46 章可能拖：2,094 字只推进了 1 条线索；第 50 章可能赶：一章跨了 16 天，只写了 1,284 字。");
    mockPace.mockResolvedValue({ chapters: [], typical: { density: 2, words: 2000 }, flags: [] });
    expect((await run(ctx)).pace).toBe("节奏诊断：按账里每章推进的线索和字数看，没有明显拖或赶的章。");
    mockPace.mockResolvedValue({ chapters: [], flags: [] });
    expect((await run(ctx)).pace).toContain("先不下结论");
    mockPace.mockRejectedValue(new Error("账坏了"));
    const out = await run(ctx);
    expect(out.ok).toBe(true);
    expect(out.pace).toBe("节奏诊断这次没读出来：账坏了");
  });
});
