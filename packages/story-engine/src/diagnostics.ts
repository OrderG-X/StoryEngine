import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "./project-store.js";

export interface DiagnosticsTokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface RuntimeLatencyRecord {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly elapsedMs: number;
}

export interface ContextStatsRecord {
  readonly totalTokenEstimate: number;
  readonly stableTokenEstimate: number;
  readonly dynamicTokenEstimate: number;
  readonly contextSections: readonly string[];
}

export interface DiagnosticsRecord {
  readonly stage: "fast-draft" | "commit";
  readonly chapter: number;
  readonly generatedAt: string;
  readonly runtimeLatency: RuntimeLatencyRecord;
  readonly diagnosticsPath?: string;
  readonly tokenUsage?: DiagnosticsTokenUsage;
  readonly contextStats?: ContextStatsRecord;
  readonly details?: Record<string, unknown>;
}

export interface RuntimeLatencyTimer {
  readonly startedAt: Date;
  readonly startedAtMs: number;
}

export function startRuntimeLatency(now: Date = new Date()): RuntimeLatencyTimer {
  return {
    startedAt: now,
    startedAtMs: now.getTime(),
  };
}

export function recordRuntimeLatency(timer: RuntimeLatencyTimer, finishedAt: Date = new Date()): RuntimeLatencyRecord {
  return {
    startedAt: timer.startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    elapsedMs: Math.max(0, finishedAt.getTime() - timer.startedAtMs),
  };
}

export function recordTokenUsage(tokenUsage: DiagnosticsTokenUsage | undefined): DiagnosticsTokenUsage | undefined {
  if (!tokenUsage) return undefined;
  return {
    promptTokens: tokenUsage.promptTokens,
    completionTokens: tokenUsage.completionTokens,
    totalTokens: tokenUsage.totalTokens,
  };
}

export function recordContextStats(stats: ContextStatsRecord): ContextStatsRecord {
  return {
    totalTokenEstimate: stats.totalTokenEstimate,
    stableTokenEstimate: stats.stableTokenEstimate,
    dynamicTokenEstimate: stats.dynamicTokenEstimate,
    contextSections: [...stats.contextSections],
  };
}

export function estimateTextTokens(text: string): number {
  if (!text) return 1;
  let count = 0;
  for (const char of text) {
    const cp = char.codePointAt(0)!;
    if (
      (cp >= 0x4E00 && cp <= 0x9FFF) ||
      (cp >= 0x3400 && cp <= 0x4DBF) ||
      (cp >= 0x20000 && cp <= 0x323AF)
    ) {
      count += 0.67;
    } else if (cp <= 0x7F) {
      count += 0.25;
    } else {
      count += 0.35;
    }
  }
  return Math.max(1, Math.ceil(count));
}

export async function writeDiagnostics(
  projectDir: string,
  diagnostics: Omit<DiagnosticsRecord, "diagnosticsPath">,
): Promise<DiagnosticsRecord> {
  const diagnosticsDir = join(projectDir, "diagnostics");
  const diagnosticsPath = join(diagnosticsDir, `${diagnostics.stage}-chapter-${padChapter(diagnostics.chapter)}.json`);
  const record: DiagnosticsRecord = {
    ...diagnostics,
    diagnosticsPath,
  };
  await mkdir(diagnosticsDir, { recursive: true });
  // 审计 Low：引擎内最后一处对项目目录的非原子 JSON 写——收口 writeFileAtomic。
  await writeFileAtomic(diagnosticsPath, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

export function attachDiagnostics<T extends object>(report: T, diagnostics: DiagnosticsRecord): T & {
  readonly diagnostics: DiagnosticsRecord;
} {
  Object.defineProperty(report, "diagnostics", {
    value: diagnostics,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return report as T & { readonly diagnostics: DiagnosticsRecord };
}

/**
 * Diagnostics are supporting evidence, never the business transaction itself.
 * Keep the warning available to in-process callers without changing serialized
 * API payloads or equality snapshots that describe the commit report contract.
 */
export function attachDiagnosticsWarning<T extends object>(report: T, warning: string): T {
  try {
    Object.defineProperty(report, "diagnosticsWarning", {
      value: warning,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  } catch {
    // Frozen/non-extensible reports still retain their original business truth.
  }
  return report;
}

export function padDiagnosticChapter(chapter: number): string {
  return padChapter(chapter);
}

function padChapter(chapter: number): string {
  return String(Math.max(0, Math.trunc(chapter))).padStart(4, "0");
}
