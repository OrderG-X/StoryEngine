/**
 * 定稿清单卡的数据（写作版本 P2a 片 4A：commit.prepare 等作者点「确认定稿」时的清单、定不了时的原因；服务端 services/commit-view.ts
 * 的 CommitPreviewView）的防御解析。SSE 收到的、存盘读回的都过这一道：章号 + 能不能定是必须的，其余逐项校验、截长。
 */
import type { CommitPreviewCardData } from "../type-defs/workspace.js";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const positive = (value: unknown): number | undefined => (typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined);
const clip = (line: string): string => (line.length > 300 ? `${line.slice(0, 300)}…` : line);
/** 一列字；单个字符串收成一条（老存档、模型退化输入）。 */
const lines = (value: unknown, max: number): string[] => (Array.isArray(value) ? value : [value]).map(text).filter(Boolean).map(clip).slice(0, max);

type ChecklistItem = NonNullable<CommitPreviewCardData["ledgerChecklist"]>[number];

function readChecklistItem(value: unknown): ChecklistItem | undefined {
  if (!isRecord(value)) return undefined;
  const id = text(value.id);
  const label = text(value.label);
  if (!id || !label) return undefined;
  const reason = text(value.reason);
  const detail = text(value.detail);
  const editableDay = positive(value.editableDay);
  const editableDayEnd = positive(value.editableDayEnd);
  return {
    id,
    kind: text(value.kind),
    label,
    ...(reason ? { reason } : {}),
    ...(detail ? { detail } : {}),
    removable: value.removable === true,
    ...(editableDay !== undefined ? { editableDay } : {}),
    ...(editableDayEnd !== undefined ? { editableDayEnd } : {}),
    ...(editableDay === undefined && value.dayUnknown === true ? { dayUnknown: true as const } : {}),
    ...(value.needsConfirm === true ? { needsConfirm: true } : {}),
    ...(value.defaultUnchecked === true ? { defaultUnchecked: true } : {}),
  };
}

export function readCommitPreviewCard(value: unknown): CommitPreviewCardData | undefined {
  if (!isRecord(value)) return undefined;
  const chapter = positive(value.chapter);
  if (chapter === undefined || typeof value.canCommit !== "boolean") return undefined;
  const blockingReasons = lines(value.blockingReasons, 20);
  const summary = text(value.summary);
  const draftIssues = lines(value.draftIssues, 20);
  const notRecorded = lines(value.notRecorded, 50);
  const notes = lines(value.notes, 20);
  const ledgerChecklist = Array.isArray(value.ledgerChecklist)
    ? value.ledgerChecklist.slice(0, 200).flatMap((item) => readChecklistItem(item) ?? [])
    : [];
  return {
    chapter,
    canCommit: value.canCommit,
    ...(blockingReasons.length > 0 ? { blockingReasons } : {}),
    ...(summary ? { summary } : {}),
    ...(draftIssues.length > 0 ? { draftIssues } : {}),
    ...(notRecorded.length > 0 ? { notRecorded } : {}),
    ...(notes.length > 0 ? { notes } : {}),
    ...(value.shortOnly === true ? { shortOnly: true } : {}),
    ...(value.fill === true ? { fill: true as const } : {}),
    ...(ledgerChecklist.length > 0 ? { ledgerChecklist } : {}),
  };
}
