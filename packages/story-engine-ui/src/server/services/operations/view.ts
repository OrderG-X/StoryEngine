/**
 * 操作给界面和对话 AI 看的样子（写作版本 P2a 契约第五节）：不带参数原文、请求哈希、进程号；
 * 结果只认 `operation-result/1`；给作者看的字洗掉本地路径。界面、`read_operation`、SSE 都出这一份。
 */
import { scrubLocalAbsolutePaths } from "../../lib/local-path-scrubber.js";
import type { OperationOrigin, OperationRecord, OperationState, PauseReason } from "../../lib/operations/store.js";
import { BACKFILL_KIND } from "../../lib/reader-backfill.js";
import { OPERATION_RESULT_SCHEMA, summaryLine, type OperationResult } from "./executor.js";

export interface OperationView {
  readonly opId: string;
  readonly kind: string;
  readonly mode?: string;
  /** 做的什么（中文，带章号）：界面、对话 AI 都照这句说，不各拼各的。 */
  readonly what: string;
  /** 针对哪一章（参数里的；没有就是交的时候所在的章）。 */
  readonly chapter?: number;
  readonly state: OperationState;
  /** 状态的中文说法（停着的带为什么停）。 */
  readonly stateText: string;
  /** 作者能点的（接着做 / 不要了）。 */
  readonly allowed: readonly ("resume" | "cancel")[];
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
  const chapter = operationChapter(record);
  return {
    opId: record.opId,
    kind: record.kind,
    ...(record.mode !== undefined ? { mode: record.mode } : {}),
    what: operationWhat(record.kind, record.mode, chapter),
    ...(chapter !== undefined ? { chapter } : {}),
    state: record.state,
    stateText: operationStateText(record),
    allowed: operationAllowed(record),
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

const MODE_LABELS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "inspect.run": { continuity: "核账", quality: "硬伤检查", review: "内容审阅", flavor: "查 AI 味" },
  "draft.change": { write: "写稿", continue: "接着写" },
};
const KIND_LABELS: Readonly<Record<string, string>> = {
  [BACKFILL_KIND]: "后台补读前文",
  "inspect.run": "检查",
  "draft.change": "写稿",
};

/** 一次操作做的什么（中文）：认不出的种类如实说「别的操作」，不把英文种类名给模型念。 */
export function operationWhat(kind: string, mode: string | undefined, chapter: number | undefined): string {
  const label = (mode !== undefined ? MODE_LABELS[kind]?.[mode] : undefined) ?? KIND_LABELS[kind] ?? "别的操作";
  return chapter !== undefined ? `${label}·第 ${chapter} 章` : label;
}

const PAUSE_TEXT: Readonly<Record<string, string>> = {
  interrupted: "写到一半停了（软件关过）",
  attempt_unknown: "停着：有一步可能已经发出去、结果没收到（可能已经计费）",
  budget: "停着：这次能用的调用次数用完了",
  material: "停着：专员还在读前文",
};

/** 状态的中文说法（停着的带为什么停）。 */
export function operationStateText(record: OperationRecord): string {
  switch (record.state) {
    case "queued": return "排着";
    case "running": return "在做";
    case "waiting_author": return "等作者点按钮";
    case "paused": return PAUSE_TEXT[record.pauseReason ?? "interrupted"] ?? "停着";
    case "succeeded": return "做完了";
    case "failed": return "没做成";
    case "cancelled": return "停掉了";
    case "obsolete": return "作废了";
  }
}

/** 作者能点的：停着的「接着做 / 不要了」，没结束的「不要了」。 */
export function operationAllowed(record: OperationRecord): readonly ("resume" | "cancel")[] {
  if (record.state === "paused") return ["resume", "cancel"];
  if (record.state === "queued" || record.state === "running" || record.state === "waiting_author") return ["cancel"];
  return [];
}

/** 操作针对的章（参数里的，没有就是交的时候所在的章）。 */
export function operationChapter(record: OperationRecord): number | undefined {
  const fromParams = (record.params as { readonly chapter?: unknown } | null | undefined)?.chapter;
  if (typeof fromParams === "number" && Number.isInteger(fromParams) && fromParams > 0) return fromParams;
  return record.origin.chapter;
}
