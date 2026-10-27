// @vitest-environment node
import type { ToolExecutionContext } from "@mastra/core/tools";
import { describe, expect, it, vi } from "vitest";
import { draftWrittenThisTurn, withDraftStop } from "./draft-stop.js";
import { buildProjectRequestContext, markUserConfirmedTool } from "./request-context.js";

type Execute = (input: unknown, context: ToolExecutionContext) => Promise<unknown>;

function fakeTools() {
  return withDraftStop({
    generate_draft: { execute: vi.fn(async (input: unknown) => ({ ok: (input as { ok: boolean }).ok, chapter: 22 })) },
    commit_preview: { execute: vi.fn(async () => ({ ok: true })) },
    check_continuity: { execute: vi.fn(async () => ({ ok: true })) },
    suggest_next_steps: { execute: vi.fn(async () => ({ ok: true })) },
  });
}

const run = (tool: object, input: unknown, context: ToolExecutionContext) => (tool as { execute: Execute }).execute(input, context);

describe("出稿后这一轮停下（换题材长篇实跑第 22 章：出完稿又并发调了十几个工具）", () => {
  it("出稿成了：同一轮里定稿预览这类不执行、如实报；核账、建议下一步照常", async () => {
    const tools = fakeTools();
    const context = { requestContext: buildProjectRequestContext("/tmp/book", 22) } as unknown as ToolExecutionContext;
    await run(tools.commit_preview, {}, context);
    expect(tools.commit_preview.execute).toBeDefined();
    await run(tools.generate_draft, { ok: true }, context);
    expect(draftWrittenThisTurn(context)).toBe(22);
    await expect(run(tools.commit_preview, {}, context)).rejects.toThrow("这一轮已经写好第 22 章的工作稿，这一步先不做");
    await expect(run(tools.generate_draft, { ok: true }, context)).rejects.toThrow("这一步先不做");
    await expect(run(tools.check_continuity, {}, context)).resolves.toEqual({ ok: true });
    await expect(run(tools.suggest_next_steps, {}, context)).resolves.toEqual({ ok: true });
  });

  it("出稿没成：不算出了稿，后面照常；别的请求不受这一轮影响", async () => {
    const tools = fakeTools();
    const context = { requestContext: buildProjectRequestContext("/tmp/book", 22) } as unknown as ToolExecutionContext;
    await run(tools.generate_draft, { ok: false }, context);
    expect(draftWrittenThisTurn(context)).toBeUndefined();
    await expect(run(tools.commit_preview, {}, context)).resolves.toEqual({ ok: true });
    const drafted = { requestContext: buildProjectRequestContext("/tmp/book", 22) } as unknown as ToolExecutionContext;
    await run(tools.generate_draft, { ok: true }, drafted);
    const next = { requestContext: buildProjectRequestContext("/tmp/book", 22) } as unknown as ToolExecutionContext;
    await expect(run(tools.commit_preview, {}, next)).resolves.toEqual({ ok: true });
  });

  it("作者点的按钮带确认标记，照常执行；套过的不再套", async () => {
    const tools = fakeTools();
    const context = { requestContext: buildProjectRequestContext("/tmp/book", 22) } as unknown as ToolExecutionContext;
    await run(tools.generate_draft, { ok: true }, context);
    markUserConfirmedTool(context.requestContext, "commit_preview");
    await expect(run(tools.commit_preview, {}, context)).resolves.toEqual({ ok: true });
    const once = tools.commit_preview.execute;
    withDraftStop(tools);
    expect(tools.commit_preview.execute).toBe(once);
  });
});
