/**
 * 定稿回执（服务端 services/commit-view.ts 的 CommitLedgerReport）的防御解析：第几章、账记没记上、是不是补账。
 * 安静账房（2026-11-03）起回执不再列记了几条；之前存下的回执（带 ledger 条数）照样认出章号和状态。
 */
export interface CommitReportSummary {
  /** 定稿的是第几章（老回执可能没有）。 */
  readonly chapter?: number;
  /** 账记到什么程度（P2b）：pending = 正文定了、账还没记上；partial = 没记全。记全了 / 认不出没有。 */
  readonly ledgerStatus?: "pending" | "partial";
  /** 补账的回执（正文没动）。 */
  readonly fill?: true;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function summarizeCommitReport(report: unknown): CommitReportSummary {
  const root = asRecord(report);
  const chapter = typeof root.chapter === "number" && Number.isInteger(root.chapter) && root.chapter > 0 ? root.chapter : undefined;
  const status = root.status ?? asRecord(root.ledger).status;
  return {
    ...(chapter !== undefined ? { chapter } : {}),
    ...(status === "pending" || status === "partial" ? { ledgerStatus: status } : {}),
    ...(root.fill === true ? { fill: true as const } : {}),
  };
}
