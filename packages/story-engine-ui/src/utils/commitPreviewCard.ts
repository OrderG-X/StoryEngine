/**
 * 定不了的卡的数据（commit.prepare 定不了时的原因；服务端 services/commit-view.ts 的 CommitPreviewView）的防御解析。
 * SSE 收到的、存盘读回的都过这一道：章号 + 原因是必须的，其余逐项校验、截长。没有原因的（安静账房之前存下的定稿清单）不出卡。
 */
import type { CommitPreviewCardData } from "../type-defs/workspace.js";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const positive = (value: unknown): number | undefined => (typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined);
const clip = (line: string): string => (line.length > 300 ? `${line.slice(0, 300)}…` : line);
/** 一列字；单个字符串收成一条（老存档、模型退化输入）。 */
const lines = (value: unknown, max: number): string[] => (Array.isArray(value) ? value : [value]).map(text).filter(Boolean).map(clip).slice(0, max);

export function readCommitPreviewCard(value: unknown): CommitPreviewCardData | undefined {
  if (!isRecord(value)) return undefined;
  const chapter = positive(value.chapter);
  const blockingReasons = lines(value.blockingReasons, 20);
  if (chapter === undefined || blockingReasons.length === 0) return undefined;
  const summary = text(value.summary);
  const draftIssues = lines(value.draftIssues, 20);
  return {
    chapter,
    blockingReasons,
    ...(summary ? { summary } : {}),
    ...(draftIssues.length > 0 ? { draftIssues } : {}),
    ...(value.shortOnly === true ? { shortOnly: true } : {}),
    ...(value.fill === true ? { fill: true as const } : {}),
  };
}
