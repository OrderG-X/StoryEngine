// @vitest-environment node
//
// M6 真机冒烟：覆盖现有非空草稿前建快照；首次出稿建「出稿：第N章」（R4.2，对真实 GLM=writer.example.com 出稿）。
// Codex 沙箱连不上 writer.example.com，本测试在能直连的本机补验那两条。
//
// 需真实网络 + 真实 GLM key（~/.story-engine/model-secrets.json 的 glm），默认 skip；手动跑：
//   RUN_M6_SMOKE=1 pnpm --filter @actalk/story-engine-ui exec vitest run generate-draft-snapshot.smoke
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createStoryProject } from "../../book/project-store.js";
import { describe, expect, it } from "vitest";
import type { ToolExecutionContext } from "@mastra/core/tools";

import { generateDraftTool } from "../tools/generate-draft.js";
import { buildProjectRequestContext } from "../request-context.js";
import { defaultDraftPath } from "../../lib/project-io.js";
import { listSnapshots, restoreSnapshot } from "../../lib/snapshot.js";

const ENABLED = process.env.RUN_M6_SMOKE === "1";

type ToolExec = (input: Record<string, unknown>, context: ToolExecutionContext) => Promise<Record<string, unknown>>;
const generate = generateDraftTool.execute as unknown as ToolExec;

function ctx(projectDir: string, chapter: number): ToolExecutionContext {
  return { requestContext: buildProjectRequestContext(projectDir, chapter) } as unknown as ToolExecutionContext;
}

async function makeProject(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "m6-smoke-"));
  const { projectDir } = await createStoryProject({
    rootDir,
    title: "M6 冒烟书",
    genre: "都市悬疑",
    premise: "深夜的旧公寓里，主角林远收到一条来自三年前失踪同事的短信。",
    mainCharacterName: "林远",
  });
  return projectDir;
}

describe.skipIf(!ENABLED)("M6 覆盖现有非空草稿前建快照（真机 GLM）", () => {
  it("覆盖现有非空草稿 → 出稿成功带 snapshotId，且 restore 能退回旧稿A", async () => {
    const projectDir = await makeProject();
    // 预置一份「旧稿A」（带哨兵），让本次出稿走「覆盖非空草稿」路径。
    const draftPath = defaultDraftPath(projectDir, 1);
    await mkdir(dirname(draftPath), { recursive: true });
    const draftA = "# 第一章 · 旧稿A\n\nDRAFT_A_SENTINEL 这是覆盖前就存在的一版草稿，撤销后应当原样回来。";
    await writeFile(draftPath, draftA, "utf-8");

    const out = await generate(
      { chapter: 1, chapterGoal: "主角林远读到失踪同事的短信，决定独自前往约定地点；不揭开真相。" },
      ctx(projectDir, 1),
    );
    // eslint-disable-next-line no-console
    console.log("[m6] overwrite ok=", out.ok, "snapshotId=", out.snapshotId, "summary=", out.summary);

    expect(out.ok).toBe(true);
    expect(out.snapshotId).toMatch(/^[0-9a-f]{40}$/u);

    // 出稿后草稿已是新稿B（不含旧哨兵）。
    const afterGen = await readFile(draftPath, "utf-8");
    expect(afterGen).not.toContain("DRAFT_A_SENTINEL");

    // 历史里有「再次出稿前快照」。
    const snaps = await listSnapshots(projectDir);
    expect(snaps.some((s) => s.label.includes("再次出稿前快照"))).toBe(true);

    // M6 核心：撤销到该快照 → 草稿原样退回旧稿A。
    await restoreSnapshot(projectDir, String(out.snapshotId));
    const afterUndo = await readFile(draftPath, "utf-8");
    expect(afterUndo).toContain("DRAFT_A_SENTINEL");
  }, 180_000);

  it("空章首次出稿（R4.2：首稿也建「出稿：第N章」存档点、可撤销）→ snapshotId 透出、历史里有该条", async () => {
    const projectDir = await makeProject();
    const out = await generate(
      { chapter: 1, chapterGoal: "主角林远读到失踪同事的短信，决定独自前往约定地点；不揭开真相。" },
      ctx(projectDir, 1),
    );
    // eslint-disable-next-line no-console
    console.log("[m6] first-draft ok=", out.ok, "snapshotId=", out.snapshotId);

    expect(out.ok).toBe(true);
    expect(typeof out.snapshotId).toBe("string");
    const snaps = await listSnapshots(projectDir);
    expect(snaps.some((s) => s.label === "出稿：第1章")).toBe(true);
  }, 180_000);
});
