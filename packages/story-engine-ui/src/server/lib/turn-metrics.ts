/**
 * 每轮对话 / 每个按钮动作的分步计量落盘（2026-10-10 引擎升级第 4 期）：
 * 写到书里 `.story-engine-ui/metrics/chapter-NNNN.jsonl`（没有章号的写 `general.jsonl`），一行一轮，追加写。
 * 内容：总耗时、对话 AI 和内部调用的 token、各步骤（核账/通读、章节声明、记账提案……）的耗时和 token。
 * 长篇里「这一章为什么慢 / 贵」要看得见，才能对症。这是作者的运行记录，不进快照、不进账本；写失败只打日志。
 */
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { TokenMeterSnapshot } from "./token-meter.js";

export const METRICS_DIR = join(".story-engine-ui", "metrics");

export function metricsFileFor(chapter: number | undefined): string {
  return chapter !== undefined && Number.isInteger(chapter) && chapter > 0
    ? `chapter-${String(chapter).padStart(4, "0")}.jsonl`
    : "general.jsonl";
}

export async function appendTurnMetrics(
  projectDir: string,
  chapter: number | undefined,
  entry: { readonly kind: "chat" | "action"; readonly label?: string; readonly ms: number; readonly usage: TokenMeterSnapshot },
): Promise<void> {
  const line = JSON.stringify({
    at: new Date().toISOString(),
    kind: entry.kind,
    ...(entry.label ? { label: entry.label } : {}),
    ms: entry.ms,
    agent: entry.usage.agent,
    pipeline: entry.usage.pipeline,
    ...(entry.usage.steps ? { steps: entry.usage.steps } : {}),
  });
  try {
    const dir = join(projectDir, METRICS_DIR);
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, metricsFileFor(chapter)), `${line}\n`, "utf-8");
  } catch (error) {
    console.warn("[metrics] 计量没写上（不影响这次结果）", error);
  }
}
