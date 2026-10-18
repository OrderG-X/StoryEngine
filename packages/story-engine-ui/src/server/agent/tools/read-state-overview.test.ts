// @vitest-environment node
//
// read_state_overview 章号缺省行为（H3）：用户没点名某章时，按「用户当前所在章」（RequestContext 注入）
// 建总览，而非引擎推断的最新章——否则回看旧章问『现在状态』会被工作台拉到最新章。
import type { ToolExecutionContext } from "@mastra/core/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { buildStateOverview } = vi.hoisted(() => ({ buildStateOverview: vi.fn() }));
vi.mock("../../book/state-overview.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  buildStateOverview,
}));
vi.mock("../overview-summary.js", () => ({ summarizeStateOverview: () => "（摘要占位）", readFactionGoals: async () => [] }));

import { buildProjectRequestContext } from "../request-context.js";
import { readStateOverviewTool } from "./read-state-overview.js";

type ToolExec = (input: Record<string, unknown>, context: ToolExecutionContext) => Promise<unknown>;
const execute = readStateOverviewTool.execute as unknown as ToolExec;

function ctx(projectDir: string, currentChapter?: number): ToolExecutionContext {
  return { requestContext: buildProjectRequestContext(projectDir, currentChapter) } as unknown as ToolExecutionContext;
}

describe("read_state_overview 章号缺省回退（H3）", () => {
  beforeEach(() => {
    buildStateOverview.mockReset();
    buildStateOverview.mockResolvedValue({ stub: true });
  });

  it("LLM 没给 chapter + 用户当前在第2章 → 按第2章建总览（不跳最新章）", async () => {
    await execute({}, ctx("/tmp/book", 2));
    expect(buildStateOverview).toHaveBeenCalledTimes(1);
    expect(buildStateOverview.mock.calls[0][0]).toMatchObject({ projectDir: "/tmp/book", chapter: 2 });
  });

  it("LLM 明确给了 chapter → 用 input 的章号（即便当前在别的章）", async () => {
    await execute({ chapter: 5 }, ctx("/tmp/book", 2));
    expect(buildStateOverview.mock.calls[0][0]).toMatchObject({ chapter: 5 });
  });

  it("既没 input 也没注入当前章 → 不带 chapter（引擎按默认推断）", async () => {
    await execute({}, ctx("/tmp/book"));
    expect("chapter" in (buildStateOverview.mock.calls[0][0] as object)).toBe(false);
  });

  it("缺 projectDir 抛错（绝不静默失败）", async () => {
    await expect(execute({}, { requestContext: buildProjectRequestContext("") } as unknown as ToolExecutionContext))
      .rejects.toThrow(/projectDir/);
  });
});
