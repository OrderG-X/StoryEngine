// @vitest-environment node
//
// read_state_overview 工具端到端（重构 P9）：summary 是 summarizeStateOverview 的话、overview 是瘦身后的 StateOverview；
// 人物和设定本计数来自设定卡（不再读老设定文件），用真 buildStateOverview 验。
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolExecutionContext } from "@mastra/core/tools";
import { describe, expect, it } from "vitest";
import { cardWrite, runCommand } from "@actalk/story-core";
import { createStoryProject } from "../../book/project-store.js";
import type { StateOverview } from "../../book/state-overview.js";

import { buildProjectRequestContext } from "../request-context.js";
import { readStateOverviewTool } from "./read-state-overview.js";

type ToolExec = (input: Record<string, unknown>, context: ToolExecutionContext) => Promise<{
  readonly summary: string;
  readonly overview: StateOverview;
  readonly refreshScope: string;
}>;
const execute = readStateOverviewTool.execute as unknown as ToolExec;

async function fixture(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "read-overview-summary-"));
  const { projectDir } = await createStoryProject({
    rootDir,
    title: "海天魂钢",
    genre: "都市英灵",
    logline: "普通毕业生林序第一次接触魂钢异常反应。",
    protagonistName: "林序",
  });
  const outcome = await runCommand(projectDir, cardWrite, {
    ops: [
      { op: "card.create", kind: "character", name: "沈知夏" },
      { op: "rules.set", field: "targetWords", value: 3000 },
    ],
  }, { caller: "author", idempotencyKey: "fixture" });
  expect(outcome.ok).toBe(true);
  // 老设定文件不再是来源：书有了设定卡，老文件里多出来的人不进概况。
  await mkdir(join(projectDir, "story"), { recursive: true });
  await writeFile(join(projectDir, "story", "world-bible.json"), JSON.stringify({
    version: "v0",
    factions: [{ id: "f-corp", name: "财团", goal: "垄断觉醒机会", resources: [] }],
  }), "utf-8");
  await writeFile(join(projectDir, "story", "character-bible.json"), JSON.stringify({
    version: "v0",
    characters: [{ id: "old", name: "老设定里的人", role: "配角" }],
  }), "utf-8");
  return projectDir;
}

describe("read_state_overview 工具（重构 P9）", () => {
  it("summary 和 overview 都按设定卡来：主角、其他人物、卡数、目标字数", async () => {
    const projectDir = await fixture();
    const result = await execute(
      {},
      { requestContext: buildProjectRequestContext(projectDir) } as unknown as ToolExecutionContext,
    );

    expect(result.refreshScope).toBe("full");
    expect(result.summary).toContain("《海天魂钢》（都市英灵）");
    expect(result.summary).toContain("人物：主角 林序；其他人物 沈知夏。");
    expect(result.summary).toContain("人物卡 2 张");
    expect(result.summary).toContain("read_foundation");
    expect(result.overview.characters.protagonist).toBe("林序");
    expect(result.overview.setting).toMatchObject({ targetChapterWords: 3000, cards: { characters: 2 } });
    expect(result.overview.project.logline).toBe("普通毕业生林序第一次接触魂钢异常反应。");

    // 老设定文件里的东西不再出现（设定卡已经有了，不兜底读老文件）。
    expect(result.summary).not.toContain("老设定里的人");
    expect(result.summary).not.toContain("垄断觉醒机会");
    expect(JSON.stringify(result.overview)).not.toContain("老设定里的人");
  });

  it("用户在看第 3 章（context 里的章）：概况按那一章算", async () => {
    const projectDir = await fixture();
    const result = await execute(
      {},
      { requestContext: buildProjectRequestContext(projectDir, 3) } as unknown as ToolExecutionContext,
    );

    expect(result.overview.project.currentChapter).toBe(3);
    expect(result.summary).toContain("当前进度：第 3 章。");
  });

  it("缺 projectDir 就报错（绝不静默编一份概况）", async () => {
    const emptyCtx = { requestContext: { get: () => undefined } } as unknown as ToolExecutionContext;
    await expect(execute({}, emptyCtx)).rejects.toThrow(/缺少 projectDir/u);
  });
});
