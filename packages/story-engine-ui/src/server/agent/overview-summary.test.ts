// @vitest-environment node
//
// 里程碑4（聊天摘要露出）：让 agent 回答「现在啥状态」时也能说出**角色关系**和**势力目标**，
// 而不是只列名字。关系来自 StateOverview.characterMatrix（现成）；势力目标 StateOverview 只带名字、
// 丢了 goal，需调用处读 story/world-bible.json 补（readFactionGoals）后作为 extras 传入。
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildStateOverview } from "../book/state-overview.js";
import { createStoryProject, toSafeCharacterId } from "../book/project-store.js";

import { readFactionGoals, summarizeStateOverview } from "./overview-summary.js";

async function fixture(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "overview-summary-"));
  const { projectDir } = await createStoryProject({
    rootDir,
    title: "海天魂钢",
    genre: "都市英灵",
    premise: "普通毕业生林序第一次接触魂钢异常反应。",
    mainCharacterName: "林序",
  });
  await writeFile(
    join(projectDir, "story", "character-bible.json"),
    JSON.stringify({
      version: "v0",
      characters: [
        { id: toSafeCharacterId("林序"), name: "林序", role: "主角" },
        {
          id: toSafeCharacterId("沈知夏"),
          name: "沈知夏",
          role: "配角",
          relationshipToProtagonist: "大学同学，暗中受财团指派接近林序",
          trustLevel: "low",
        },
      ],
    }, null, 2),
    "utf-8",
  );
  await writeFile(
    join(projectDir, "story", "world-bible.json"),
    JSON.stringify({
      version: "v0",
      rules: ["创业魂钢决定城市阶层"],
      factions: [{ id: "f-corp", name: "财团", goal: "垄断觉醒机会", resources: ["申请渠道"] }],
    }, null, 2),
    "utf-8",
  );
  return projectDir;
}

describe("summarizeStateOverview 露出关系与势力目标（里程碑4）", () => {
  it("摘要带出配角与主角的关系（之前只列名字）", async () => {
    const overview = await buildStateOverview({ projectDir: await fixture(), maxTimelineEvents: 8 });
    const summary = summarizeStateOverview(overview);
    expect(summary).toContain("沈知夏");
    expect(summary).toContain("暗中受财团指派接近林序");
  });

  it("给了势力目标(extras)时摘要带目标，没给时只列名字", async () => {
    const overview = await buildStateOverview({ projectDir: await fixture(), maxTimelineEvents: 8 });
    const withGoals = summarizeStateOverview(overview, { factions: [{ name: "财团", goal: "垄断觉醒机会" }] });
    expect(withGoals).toContain("垄断觉醒机会");
    const namesOnly = summarizeStateOverview(overview);
    expect(namesOnly).toContain("财团");
    expect(namesOnly).not.toContain("垄断觉醒机会");
  });
});

describe("readFactionGoals 读 world-bible 势力目标", () => {
  it("读出 {name, goal}", async () => {
    const goals = await readFactionGoals(await fixture());
    expect(goals).toEqual(expect.arrayContaining([{ name: "财团", goal: "垄断觉醒机会" }]));
  });

  it("缺 world-bible 文件不抛、回空数组", async () => {
    const empty = await readFactionGoals(await mkdtemp(join(tmpdir(), "no-wb-")));
    expect(empty).toEqual([]);
  });
});
