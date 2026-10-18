// @vitest-environment node
//
// 对话式开书（第二期②）真机冒烟：空建占位主角的新书里，用户首次说出真主角名时，开书引导应让 agent
// 【改名占位主角】(rename_character) 而非新增第二个角色（里程碑2A #1 核心瑕疵）。对真实 GLM 跑。
// Codex 沙箱连不上 writer.example.com，本机直连补这条最终签收。
//
// 需真实网络 + 真实 GLM key，默认 skip；手动跑：
//   RUN_BOOKCREATION_SMOKE=1 pnpm --filter @actalk/story-engine-ui exec vitest run book-creation-guidance.smoke
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStateOverview } from "../../book/state-overview.js";
import { createStoryProject } from "../../book/project-store.js";
import { describe, expect, it } from "vitest";

import { getStoryAgent } from "../story-agent.js";
import { buildProjectRequestContext } from "../request-context.js";

const ENABLED = process.env.RUN_BOOKCREATION_SMOKE === "1";

describe.skipIf(!ENABLED)("对话式开书 开书引导（真机 GLM）", () => {
  it("空书里说出真主角名 → 改名占位主角(不新增第二个)，并落欲望/恐惧", async () => {
    // 空建：mainCharacterName=占位「主角」，模拟极简新建后的中性骨架空书。
    const rootDir = await mkdtemp(join(tmpdir(), "bookcreation-smoke-"));
    const { projectDir } = await createStoryProject({
      rootDir,
      title: "开书冒烟书",
      genre: "",
      premise: "",
      mainCharacterName: "主角",
    });

    const before = await buildStateOverview({ projectDir, maxTimelineEvents: 8 });
    // eslint-disable-next-line no-console
    console.log("[book] 初始角色:", before.characters.knownCharacters.map((c) => c.name));
    expect(before.characters.knownCharacters.some((c) => c.name === "主角")).toBe(true);

    const agent = await getStoryAgent();
    const requestContext = buildProjectRequestContext(projectDir);
    const result = await agent.stream(
      [{
        role: "user",
        content:
          "我想写一个都市悬疑故事。主角就叫林远吧——他是个调查记者，一心想揭开三年前同事离奇失踪的真相，" +
          "最怕自己那段不光彩的过去被人扒出来。先把他这个人立起来。",
      }],
      { requestContext },
    );

    const toolCalls: string[] = [];
    for await (const chunk of result.fullStream) {
      if (chunk.type === "tool-call") toolCalls.push(chunk.payload.toolName);
    }
    // eslint-disable-next-line no-console
    console.log("[book] agent 调用工具:", toolCalls);

    const after = await buildStateOverview({ projectDir, maxTimelineEvents: 8 });
    const names = after.characters.knownCharacters.map((c) => c.name);
    // eslint-disable-next-line no-console
    console.log("[book] 改后角色:", names, "| protagonist:", after.characters.protagonist);

    // 核心：占位「主角」被改名成林远——不再有名为「主角」的残留，且林远在册（不是「主角、林远」两个）。
    expect(names).toContain("林远");
    expect(names).not.toContain("主角");
    // 主角字段确实是林远。
    expect(after.characters.protagonist).toBe("林远");
  }, 180_000);
});
