import { describe, expect, it } from "vitest";

import { summarizeFormalCommitApplyError } from "./formalCommitApplyErrorCopy.js";

describe("formal commit apply error copy", () => {
  it("asks the user to regenerate preview for stale preview errors", () => {
    const copy = summarizeFormalCommitApplyError(
      new Error("formal_commit_apply_transaction_preflight_failed: preview_hash_mismatch"),
    );

    expect(flattenCopy(copy)).toContain("重新生成定稿预览");
    expect(copy.severity).toBe("warning");
  });

  it("asks the user to regenerate preview from a preserved API payload", () => {
    const copy = summarizeFormalCommitApplyError({
      payload: {
        ok: false,
        reason: "formal_commit_apply_transaction_preflight_failed",
        transactionPreflight: { code: "preview_hash_mismatch" },
      },
    });

    expect(flattenCopy(copy)).toContain("重新生成定稿预览");
  });

  it("explains transaction residue errors", () => {
    const copy = summarizeFormalCommitApplyError(
      new Error("formal_commit_apply_transaction_preflight_failed transaction_residue_found"),
    );

    expect(flattenCopy(copy)).toContain("事务残留");
    expect(flattenCopy(copy)).toContain("不要重复确认定稿");
  });

  it("explains state writes are unsupported", () => {
    const copy = summarizeFormalCommitApplyError(
      new Error("formal_commit_apply_state_writes_not_implemented"),
    );

    expect(flattenCopy(copy)).toContain("状态 JSON 暂未开放");
    expect(flattenCopy(copy)).toContain("当前版本只支持章节正文定稿");
  });

  it("explains finalize failures after possible chapter write", () => {
    const copy = summarizeFormalCommitApplyError(
      new Error("formal_commit_apply_finalize_failed: simulated finalize throw"),
    );

    expect(flattenCopy(copy)).toContain("章节可能已经写入");
    expect(flattenCopy(copy)).toContain("事务 finalized 失败");
    expect(flattenCopy(copy)).toContain("不要重复点击");
  });

  it("explains same-chapter transaction directory collisions", () => {
    const copy = summarizeFormalCommitApplyError(
      new Error("formal_commit_snapshot_materialization_failed existing transaction dir"),
    );

    expect(flattenCopy(copy)).toContain("同一章");
    expect(flattenCopy(copy)).toContain("事务目录");
  });

  it("explains same-chapter transaction directory collisions from snapshot payload reason", () => {
    const copy = summarizeFormalCommitApplyError({
      payload: {
        ok: false,
        reason: "formal_commit_snapshot_materialization_failed",
        snapshotResult: { reason: "existing_transaction_dir" },
      },
    });

    expect(flattenCopy(copy)).toContain("同一章");
    expect(flattenCopy(copy)).toContain("事务目录");
  });

  it("falls back for unknown errors", () => {
    const copy = summarizeFormalCommitApplyError(new Error("network broke"));

    expect(copy.title).toContain("定稿失败");
    expect(flattenCopy(copy)).toContain("network broke");
    expect(flattenCopy(copy)).toContain("工作稿和定稿预览已保留");
  });
});

function flattenCopy(copy: ReturnType<typeof summarizeFormalCommitApplyError>): string {
  return [copy.title, copy.message, ...copy.detail].join("\n");
}
