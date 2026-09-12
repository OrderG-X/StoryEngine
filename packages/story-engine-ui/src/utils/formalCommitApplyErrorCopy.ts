export interface FormalCommitApplyErrorCopy {
  readonly title: string;
  readonly message: string;
  readonly detail: readonly string[];
  readonly severity: "warning" | "danger";
}

export function summarizeFormalCommitApplyError(error: unknown): FormalCommitApplyErrorCopy {
  const rawMessage = errorMessage(error);
  const normalized = rawMessage.toLowerCase();

  if (/\bpreview_hash_mismatch\b|\btransaction_id_mismatch\b|stale/u.test(normalized)) {
    return {
      title: "定稿预览已过期",
      message: "当前定稿预览已过期，请重新生成定稿预览后再确认定稿。",
      detail: [
        "工作稿和定稿预览已保留。",
        "不要重复点击当前确认定稿；先重新生成预览，确认最新事务信息后再继续。",
        `原始错误：${rawMessage}`,
      ],
      severity: "warning",
    };
  }

  if (/transaction_residue_found|residue|malformed_finalized|finalized_invalid/u.test(normalized)) {
    return {
      title: "检测到事务残留",
      message: "检测到未完成或异常事务残留，当前不能继续定稿。",
      detail: [
        "不要重复确认定稿。",
        "需要先处理事务目录或联系维护流程，再重新生成定稿预览。",
        "工作稿和定稿预览已保留。",
        `原始错误：${rawMessage}`,
      ],
      severity: "danger",
    };
  }

  if (/formal_commit_apply_state_writes_not_implemented|state json|state_writes_not_implemented/u.test(normalized)) {
    return {
      title: "状态 JSON 暂未开放",
      message: "当前版本只支持章节正文定稿，状态 JSON 暂未开放。",
      detail: [
        "请继续使用定稿预览确认计划，不要强行正式写状态。",
        "工作稿和定稿预览已保留。",
        `原始错误：${rawMessage}`,
      ],
      severity: "warning",
    };
  }

  if (/formal_commit_apply_finalize_failed|finalize|finalized/u.test(normalized)) {
    return {
      title: "事务 finalized 失败",
      message: "章节可能已经写入，但事务 finalized 失败。",
      detail: [
        "请保留现场，不要重复点击确认定稿。",
        "需要人工检查 `.story-engine-tx` 和 snapshot-manifest.json。",
        "工作稿和定稿预览已保留。",
        `原始错误：${rawMessage}`,
      ],
      severity: "danger",
    };
  }

  if (/formal_commit_snapshot_materialization_failed|snapshot_materialization|existing transaction dir|txdir|transaction dir/u.test(normalized)) {
    return {
      title: "同一章事务目录冲突",
      message: "同一章已有事务目录，当前版本暂不支持同章重复定稿。",
      detail: [
        "请不要重复点击。",
        "后续需要通过 cleanup/archive 或同章 guard 解决事务目录冲突。",
        "工作稿和定稿预览已保留。",
        `原始错误：${rawMessage}`,
      ],
      severity: "warning",
    };
  }

  return {
    title: "定稿失败",
    message: "定稿失败，工作稿和定稿预览已保留。",
    detail: [
      "请根据错误信息处理后再重试。",
      `原始错误：${rawMessage}`,
    ],
    severity: "warning",
  };
}

function errorMessage(error: unknown): string {
  const payload = payloadFromError(error);
  const payloadMessage = payload ? structuredErrorMessage(payload) : undefined;
  if (error instanceof Error && error.message.trim().length > 0) {
    return compactStrings([payloadMessage, error.message.trim()]).join(" ");
  }
  if (typeof error === "string" && error.trim().length > 0) {
    return error.trim();
  }
  if (typeof error === "object" && error !== null) {
    return payloadMessage ?? structuredErrorMessage(error);
  }
  return String(error);
}

function payloadFromError(error: unknown): unknown | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const record = error as Record<string, unknown>;
  return record.payload;
}

function structuredErrorMessage(value: unknown): string {
  if (typeof value !== "object" || value === null) return "";
  const record = value as Record<string, unknown>;
  return compactStrings([
    readString(record.reason),
    readString(record.error),
    readString(record.finalizeError),
    record.transactionFinalized === false ? "transactionFinalized:false" : undefined,
    nestedString(record.transactionPreflight, "code"),
    nestedString(record.formalPreflight, "code"),
    nestedString(record.snapshotResult, "reason"),
    nestedString(record.snapshotResult, "code"),
  ]).join(" ");
}

function nestedString(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  return readString(record[key]);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function compactStrings(values: readonly (string | undefined)[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}
