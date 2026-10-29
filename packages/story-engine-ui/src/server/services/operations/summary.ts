/**
 * `OperationSummary/1`（写作版本 P2a 契约第三节第 5 条）：每轮对话开头给对话 AI 看的「最近几次操作」——
 * 做的什么、到哪一步、结论、没做完的、作者能点什么。「上次那个」指哪次由模型在对话里问清，这里不猜。
 *
 * 只读操作记录（不触发补读、不拿锁、不写盘）。后台补读只列没结束的（在补、停着等作者），做完的不占位置。
 */
import { readDraftState } from "@actalk/story-core";
import { isTerminal, listOperations, type OperationRecord } from "../../lib/operations/store.js";
import { BACKFILL_KIND } from "../../lib/reader-backfill.js";
import { operationView, type OperationView } from "./view.js";

export const OPERATION_SUMMARY_SCHEMA = "operation-summary/1" as const;

/** 最多列几次。 */
export const OPERATION_SUMMARY_LIMIT = 5;

export interface OperationSummaryItem {
  readonly opId: string;
  /** 做的什么（中文，带章号）。 */
  readonly what: string;
  readonly state: OperationView["state"];
  /** 状态的中文说法（停着的带为什么停）。 */
  readonly stateText: string;
  readonly currentStep?: string;
  /** 结论或没成的原因（一句）。 */
  readonly summary: string;
  /** 作者能点的（接着做 / 不要了 / 停掉）。 */
  readonly allowed: readonly ("resume" | "cancel")[];
  /** 检查的结论是改稿前那一版的（查完稿子又改过）。 */
  readonly draftChanged?: true;
  readonly updatedAt: string;
}

export interface OperationSummary {
  readonly schema: typeof OPERATION_SUMMARY_SCHEMA;
  readonly operations: readonly OperationSummaryItem[];
}

const MODE_LABELS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "inspect.run": { continuity: "核账", quality: "硬伤检查", review: "内容审阅", flavor: "查 AI 味" },
};
const KIND_LABELS: Readonly<Record<string, string>> = {
  [BACKFILL_KIND]: "后台补读前文",
  "inspect.run": "检查",
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
  material: "停着：资料还没备好",
};

function stateText(record: OperationRecord): string {
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

function allowedOf(record: OperationRecord): readonly ("resume" | "cancel")[] {
  if (record.state === "paused") return ["resume", "cancel"];
  if (record.state === "queued" || record.state === "running" || record.state === "waiting_author") return ["cancel"];
  return [];
}

function chapterOf(record: OperationRecord): number | undefined {
  const fromParams = (record.params as { readonly chapter?: unknown } | null | undefined)?.chapter;
  if (typeof fromParams === "number" && Number.isInteger(fromParams) && fromParams > 0) return fromParams;
  return record.origin.chapter;
}

/**
 * 检查做完了、查的是工作稿某一版，稿子之后又改过（或删了）：结论是改稿前那一版的（Astra P2a 第 10 轮第 4 条）。
 * 停过再接着做查的是冻结的那份，期间作者可能改过稿。只读；读不到当没改。
 */
export async function checkedDraftChanged(bookDir: string, record: OperationRecord): Promise<boolean> {
  if (record.kind !== "inspect.run" || record.state !== "succeeded") return false;
  const body = (record.result as { readonly body?: { readonly source?: unknown; readonly checkedVersion?: unknown } } | undefined)?.body;
  const chapter = chapterOf(record);
  if (body?.source !== "draft" || typeof body.checkedVersion !== "string" || chapter === undefined) return false;
  const current = await readDraftState(bookDir, chapter).catch(() => undefined);
  return current !== undefined && current.version !== body.checkedVersion;
}

/** 这本书最近几次操作（新的在前）。读不到操作目录就是空的。 */
export async function buildOperationSummary(bookDir: string, limit: number = OPERATION_SUMMARY_LIMIT): Promise<OperationSummary> {
  const records = await listOperations(bookDir).catch(() => [] as readonly OperationRecord[]);
  const shown = records
    .filter((record) => record.kind !== BACKFILL_KIND || !isTerminal(record.state))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit);
  return {
    schema: OPERATION_SUMMARY_SCHEMA,
    operations: await Promise.all(shown.map(async (record) => {
      const view = operationView(record);
      return {
        opId: record.opId,
        what: operationWhat(record.kind, record.mode, chapterOf(record)),
        state: record.state,
        stateText: stateText(record),
        ...(record.currentStep !== undefined ? { currentStep: record.currentStep } : {}),
        summary: view.summary,
        allowed: allowedOf(record),
        ...(await checkedDraftChanged(bookDir, record) ? { draftChanged: true as const } : {}),
        updatedAt: record.updatedAt,
      };
    })),
  };
}

const ALLOWED_TEXT: Readonly<Record<"resume" | "cancel", string>> = { resume: "「接着做」", cancel: "「不要了」" };

/** 给对话 AI 的那一段（system 消息）：没有操作就不注。操作号只给 read_operation 用。 */
export function operationSummaryText(summary: OperationSummary): string | undefined {
  if (summary.operations.length === 0) return undefined;
  const lines = summary.operations.map((item) => {
    const allowed = item.allowed.length > 0 ? `；作者可以点${item.allowed.map((action) => ALLOWED_TEXT[action]).join("或")}` : "";
    const changed = item.draftChanged ? "（查的是改稿前那一版，稿子之后改过）" : "";
    return `- ${item.opId}：${item.what}，${item.stateText}${item.summary ? `：${item.summary}` : ""}${changed}${allowed}`;
  });
  return [
    `【最近的操作】（${OPERATION_SUMMARY_SCHEMA}，新的在前；操作号只用来调 read_operation 查细节，别念给作者）`,
    ...lines,
    "这些是服务端按固定步骤做的：结果以这里和 read_operation 为准；还在做的别说成做完了，停着的告诉作者点卡上的按钮。",
  ].join("\n");
}
