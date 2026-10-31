// @vitest-environment node
import { describe, expect, it } from "vitest";
import { LEDGER_OPS } from "../../services/ledger-change/plan.js";
import { changeLedgerTool } from "./change-ledger.js";

const schema = (changeLedgerTool as unknown as { inputSchema: { safeParse: (value: unknown) => { success: boolean; data?: { changes?: { op: string }[] } } } }).inputSchema;

describe("change_ledger 参数", () => {
  it("每种 op 原样、大小写写乱都认（真跑 2026-11-01：itemState 被转小写后连拒两次）", () => {
    for (const op of LEDGER_OPS) {
      for (const written of [op, op.toUpperCase(), ` ${op.toLowerCase()} `]) {
        const parsed = schema.safeParse({ changes: [{ op: written, chapter: 5 }] });
        expect(parsed.success, written).toBe(true);
        expect(parsed.data?.changes?.[0]?.op).toBe(op);
      }
    }
  });

  it("作者定东西在哪：模型照说明交的那份能过", () => {
    const parsed = schema.safeParse({ changes: [{ chapter: 5, op: "itemState", query: "两张请帖", where: { place: "村南头老陈家" } }] });
    expect(parsed.success).toBe(true);
  });
});
