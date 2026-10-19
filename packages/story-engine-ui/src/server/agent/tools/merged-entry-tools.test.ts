// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

const { calls, fakeTool } = vi.hoisted(() => {
  const calls: { tool: string; args: unknown }[] = [];
  const fakeTool = (tool: string) => ({ execute: async (args: unknown) => { calls.push({ tool, args }); return { ok: true, summary: `${tool} 做完了` }; } });
  return { calls, fakeTool };
});

vi.mock("./undo-last-change.js", () => ({ undoLastChangeTool: fakeTool("undo_last_change") }));
vi.mock("./prune-snapshots.js", () => ({ pruneSnapshotsTool: fakeTool("prune_snapshots") }));

import { manageSnapshotsTool } from "./manage-snapshots.js";

type Exec = (input: Record<string, unknown>, context: unknown) => Promise<Record<string, unknown>>;
const snapshots = manageSnapshotsTool.execute as unknown as Exec;

describe("合并入口（2026-10-12 编辑部 R3b 瘦身）", () => {
  it("manage_snapshots：undo/prune 按 op 转原工具；prune 不透传 confirm（真裁只认按钮），keep 透传；结果带 op", async () => {
    calls.length = 0;
    const out = await snapshots({ op: "undo" }, {});
    expect(calls.at(-1)).toEqual({ tool: "undo_last_change", args: {} });
    expect(out).toMatchObject({ ok: true, op: "undo" });
    await snapshots({ op: "prune" }, {});
    expect(calls.at(-1)).toEqual({ tool: "prune_snapshots", args: {} });
    await snapshots({ op: "prune", keep: 50, confirm: true }, {});
    expect(calls.at(-1)).toEqual({ tool: "prune_snapshots", args: { keep: 50 } });
  });
});
