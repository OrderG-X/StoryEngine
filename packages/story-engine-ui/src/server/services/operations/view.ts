/**
 * 操作给界面和对话 AI 看的样子（写作版本 P2a 契约第五节）：不带参数原文、请求哈希、进程号；
 * 结果只认 `operation-result/1`；给作者看的字洗掉本地路径。界面、`read_operation`、SSE 都出这一份。
 */
import { scrubLocalAbsolutePaths } from "../../lib/local-path-scrubber.js";
import type { OperationOrigin, OperationRecord, OperationState, PauseReason } from "../../lib/operations/store.js";
import { OPERATION_RESULT_SCHEMA, summaryLine, type OperationResult } from "./executor.js";

export interface OperationView {
  readonly opId: string;
  readonly kind: string;
  readonly mode?: string;
  readonly state: OperationState;
  readonly pauseReason?: PauseReason;
  readonly currentStep?: string;
  readonly origin: OperationOrigin;
  /** 给作者看的一句（结果的结论，或没成的原因）；还没结论是空串。 */
  readonly summary: string;
  readonly result?: OperationResult;
  readonly failure?: { readonly code: string; readonly message: string; readonly retryable: boolean };
  /** 等作者点的按钮（只带号和种类，决定的哈希不出去）。 */
  readonly pendingActions: readonly { readonly actionId: string; readonly kind: string }[];
  readonly eventSeq: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function resultOf(record: OperationRecord): OperationResult | undefined {
  const result = record.result as Partial<OperationResult> | undefined;
  if (result?.schema !== OPERATION_RESULT_SCHEMA || typeof result.summary !== "string") return undefined;
  return {
    ...(result as OperationResult),
    summary: scrubLocalAbsolutePaths(result.summary),
    ...(result.warnings ? { warnings: result.warnings.map(scrubLocalAbsolutePaths) } : {}),
  };
}

export function operationView(record: OperationRecord): OperationView {
  const result = resultOf(record);
  return {
    opId: record.opId,
    kind: record.kind,
    ...(record.mode !== undefined ? { mode: record.mode } : {}),
    state: record.state,
    ...(record.pauseReason !== undefined ? { pauseReason: record.pauseReason } : {}),
    ...(record.currentStep !== undefined ? { currentStep: record.currentStep } : {}),
    origin: record.origin,
    summary: scrubLocalAbsolutePaths(summaryLine(record)),
    ...(result ? { result } : {}),
    ...(record.failure ? { failure: { ...record.failure, message: scrubLocalAbsolutePaths(record.failure.message) } } : {}),
    pendingActions: record.pendingActions.map(({ actionId, kind }) => ({ actionId, kind })),
    eventSeq: record.eventSeq,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
