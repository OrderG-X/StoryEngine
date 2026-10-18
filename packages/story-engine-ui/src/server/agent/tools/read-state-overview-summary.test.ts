// @vitest-environment node
//
// 里程碑4 接线：read_state_overview 工具回的 summary 要带出势力目标——工具调用处读 story/world-bible.json
// 补 goal（StateOverview 只带名字）后作为 extras 传进 summarizeStateOverview。用真 buildStateOverview 端到端验。
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolExecutionContext } from "@mastra/core/tools";
import { describe, expect, it } from "vitest";
import { createStoryProject } from "../../book/project-store.js";

import { buildProjectRequestContext } from "../request-context.js";
import { readStateOverviewTool } from "./read-state-overview.js";

type ToolExec = (input: Record<string, unknown>, context: ToolExecutionContext) => Promise<{ readonly summary: string }>;
const execute = readStateOverviewTool.execute as unknown as ToolExec;

async function fixture(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "read-overview-summary-"));
  const { projectDir } = await createStoryProject({
    rootDir,
    title: "海天魂钢",
    genre: "都市英灵",
    premise: "普通毕业生林序第一次接触魂钢异常反应。",
    mainCharacterName: "林序",
  });
  await writeFile(
    join(projectDir, "story", "world-bible.json"),
    JSON.stringify({
      version: "v0",
      rules: ["创业魂钢决定城市阶层"],
      factions: [{ id: "f-corp", name: "财团", goal: "垄断觉醒机会", resources: [] }],
    }, null, 2),
    "utf-8",
  );
  return projectDir;
}

describe("read_state_overview 摘要带出势力目标（里程碑4 接线）", () => {
  it("工具回的 summary 含势力目标（读 world-bible 补 goal）", async () => {
    const projectDir = await fixture();
    const result = await execute(
      {},
      { requestContext: buildProjectRequestContext(projectDir) } as unknown as ToolExecutionContext,
    );
    expect(result.summary).toContain("财团");
    expect(result.summary).toContain("垄断觉醒机会");
  });
});
