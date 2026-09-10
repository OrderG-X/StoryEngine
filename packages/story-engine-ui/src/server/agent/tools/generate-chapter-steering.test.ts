// @vitest-environment node
//
// generate_chapter_steering 纯逻辑单测：薄适配层 + 共享 services/steering-service.ts 的确定性编排
// （buildChapterSteeringDraft）。只读：不建快照、不带 snapshotId、不写盘；缺方向诚实拒绝。
// 引擎读取用临时项目 fixture（createStoryProject）。
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStoryProject } from "@actalk/story-engine";
import type { ToolExecutionContext } from "@mastra/core/tools";
import { describe, expect, it, vi } from "vitest";

import { buildProjectRequestContext } from "../request-context.js";
import { buildChapterSteeringToolOutput, generateChapterSteeringTool } from "./generate-chapter-steering.js";

async function makeProject(title: string, mainCharacterName = "林远"): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "gen-steering-test-"));
  const { projectDir } = await createStoryProject({
    rootDir,
    title,
    genre: "都市",
    premise: "主角进入权力中心。",
    mainCharacterName,
  });
  return projectDir;
}

describe("generate_chapter_steering 只读工具", () => {
  it("给出方向 → 返回剧情方案（建议清单 + 章节目标预览），不带 snapshotId", async () => {
    const projectDir = await makeProject("方案");
    const out = await buildChapterSteeringToolOutput({
      projectDir,
      userDirection: "推进主角与对手的第一次正面交锋。",
    });
    expect(out.ok).toBe(true);
    const draft = out.draft;
    if (!draft) throw new Error("expected a steering draft");
    expect(Array.isArray(draft.suggestions)).toBe(true);
    expect(draft.generatedChapterGoalPreview).toContain("正面交锋");
    expect(out.summary).toContain("方案");
    // 只读工具：不写盘、不建快照
    expect("snapshotId" in out).toBe(false);
    expect("refreshScope" in out).toBe(false);
  });

  it("缺方向（空白）→ 诚实拒绝，ok=false，不编造方案", async () => {
    const projectDir = await makeProject("缺方向");
    const out = await buildChapterSteeringToolOutput({ projectDir, userDirection: "   " });
    expect(out.ok).toBe(false);
    expect(out.draft).toBeUndefined();
    expect(out.summary).toContain("方向");
  });

  it("透传 pacing / revealLevel / mustInclude / mustAvoid 到引擎草案", async () => {
    const projectDir = await makeProject("透传");
    const out = await buildChapterSteeringToolOutput({
      projectDir,
      userDirection: "铺垫一条新线索。",
      pacing: "fast",
      revealLevel: "large",
      mustInclude: ["旧账册"],
      mustAvoid: ["直接揭穿幕后"],
    });
    expect(out.ok).toBe(true);
    expect(out.draft?.pacing).toBe("fast");
    expect(out.draft?.revealLevel).toBe("large");
    expect(out.draft?.mustInclude).toContain("旧账册");
    expect(out.draft?.mustAvoid).toContain("直接揭穿幕后");
  });
});

describe("generate_chapter_steering execute 章号回退（currentChapter）", () => {
  it("不传 chapter 但注入 currentChapter:5 → 工具用第5章执行", async () => {
    const { buildChapterSteeringDraft } = await vi.importActual<
      typeof import("@actalk/story-engine")
    >("@actalk/story-engine");
    const spy = vi.spyOn(
      await import("@actalk/story-engine"),
      "buildChapterSteeringDraft",
    );
    // 用真实引擎签名但捕获调用参数；返回最小合法 draft
    spy.mockResolvedValue({
      chapter: 5,
      suggestions: [],
      generatedChapterGoalPreview: "preview",
      pacing: "medium",
      revealLevel: "small",
      mustInclude: [],
      mustAvoid: [],
      contextReminders: [],
    } as unknown as Awaited<ReturnType<typeof buildChapterSteeringDraft>>);

    const projectDir = await makeProject("回退章号");
    type ToolExec = (
      input: Record<string, unknown>,
      context: ToolExecutionContext,
    ) => Promise<unknown>;
    const execute = generateChapterSteeringTool.execute as unknown as ToolExec;
    const context = {
      requestContext: buildProjectRequestContext(projectDir, 5),
    } as unknown as ToolExecutionContext;

    await execute({ userDirection: "推进主线。" }, context);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatchObject({ chapter: 5 });

    spy.mockRestore();
  });
});
