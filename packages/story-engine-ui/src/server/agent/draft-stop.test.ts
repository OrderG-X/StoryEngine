// @vitest-environment node
import { RequestContext } from "@mastra/core/di";
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

/** 照 Mastra 调工具的样子：每次调用拿到的是合并出来的新一份请求上下文，往里 set 的下一次读不到。 */
function perCall(base: RequestContext): ToolExecutionContext {
  const merged = new RequestContext();
  for (const [key, value] of base.entries()) merged.set(key, value);
  return { requestContext: merged } as unknown as ToolExecutionContext;
}

const run = (tool: object, input: unknown, base: RequestContext) => (tool as { execute: Execute }).execute(input, perCall(base));

describe("出稿后这一轮停下（换题材长篇实跑第 22 章：出完稿又并发调了十几个工具）", () => {
  it("出稿成了：同一轮里定稿预览这类不执行、如实报没做（不抛错，免得前端当服务出错）；核账、建议下一步照常（每次调工具上下文是新的一份也认得）", async () => {
    const tools = fakeTools();
    const turn = buildProjectRequestContext("/tmp/book", 22);
    await expect(run(tools.commit_preview, {}, turn)).resolves.toEqual({ ok: true });
    await run(tools.generate_draft, { ok: true }, turn);
    expect(draftWrittenThisTurn(perCall(turn))).toBe(22);
    await expect(run(tools.commit_preview, {}, turn)).resolves.toEqual({ ok: false, skipped: true, summary: "这一轮已经写好第 22 章的工作稿，这一步先不做，等作者看完稿再说。" });
    expect(tools.commit_preview.execute).toBeDefined();
    await expect(run(tools.generate_draft, { ok: true }, turn)).resolves.toMatchObject({ ok: false, skipped: true });
    await expect(run(tools.check_continuity, {}, turn)).resolves.toEqual({ ok: true });
    await expect(run(tools.suggest_next_steps, {}, turn)).resolves.toEqual({ ok: true });
  });

  it("出稿没成：不算出了稿，后面照常；别的请求不受这一轮影响", async () => {
    const tools = fakeTools();
    const turn = buildProjectRequestContext("/tmp/book", 22);
    await run(tools.generate_draft, { ok: false }, turn);
    expect(draftWrittenThisTurn(perCall(turn))).toBeUndefined();
    await expect(run(tools.commit_preview, {}, turn)).resolves.toEqual({ ok: true });
    await run(tools.generate_draft, { ok: true }, buildProjectRequestContext("/tmp/book", 22));
    await expect(run(tools.commit_preview, {}, buildProjectRequestContext("/tmp/book", 22))).resolves.toEqual({ ok: true });
  });

  it("出稿和定稿预览并发着调（第 26 章）：稿还在写，定稿预览拦下；这份稿没写成，之后再调的照常", async () => {
    let finish: (value: unknown) => void = () => {};
    const tools = withDraftStop({
      generate_draft: { execute: vi.fn(() => new Promise((resolve) => { finish = resolve; })) },
      commit_preview: { execute: vi.fn(async () => ({ ok: true })) },
      read_draft: { execute: vi.fn(async () => ({ ok: true })) },
    });
    const turn = buildProjectRequestContext("/tmp/book", 26);
    const drafting = run(tools.generate_draft, {}, turn);
    await expect(run(tools.commit_preview, {}, turn)).resolves.toEqual({ ok: false, skipped: true, summary: "这一轮正在写工作稿，这一步先不做，等稿写完、作者看过再说。" });
    await expect(run(tools.generate_draft, {}, turn)).resolves.toMatchObject({ ok: false, skipped: true });
    await expect(run(tools.read_draft, {}, turn)).resolves.toEqual({ ok: true });
    finish({ ok: false });
    await drafting;
    await expect(run(tools.commit_preview, {}, turn)).resolves.toEqual({ ok: true });
  });

  it("作者点的按钮带确认标记，照常执行；套过的不再套", async () => {
    const tools = fakeTools();
    const turn = buildProjectRequestContext("/tmp/book", 22);
    await run(tools.generate_draft, { ok: true }, turn);
    markUserConfirmedTool(turn, "commit_preview");
    await expect(run(tools.commit_preview, {}, turn)).resolves.toEqual({ ok: true });
    const once = tools.commit_preview.execute;
    withDraftStop(tools);
    expect(tools.commit_preview.execute).toBe(once);
  });
});
