export interface CommitReportSummary {
  readonly statusLine: string;
  readonly detailLines: readonly string[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringArrayLength(value: unknown): number {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.trim().length > 0).length : 0;
}

function booleanLabel(value: unknown): string {
  return value === true ? "已更新" : "无变更";
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

/** 重构 P3 起的定稿回执：只带这一章记了多少条账（commit_apply 的 report.ledger）。 */
function summarizeLedgerReport(root: Record<string, unknown>, ledger: Record<string, unknown>): CommitReportSummary {
  const chapterPath = typeof root.chapterPath === "string" && root.chapterPath.trim().length > 0 ? root.chapterPath.trim() : "chapters";
  const facts = count(ledger.facts);
  const opened = count(ledger.threadsOpened);
  const advanced = count(ledger.threadsAdvanced);
  const closed = count(ledger.threadsClosed);
  const present = count(ledger.present);
  const day = count(ledger.day);
  const dayEnd = count(ledger.dayEnd);
  const notRecorded = count(ledger.notRecorded);
  return {
    statusLine: `账已记上：事实 ${facts} 条，线索新开 ${opened}、推进 ${advanced}、收口 ${closed} 条，出场 ${present} 人。`,
    detailLines: [
      `正式章节：已写入 ${chapterPath}`,
      ...(day > 0 ? [`故事时间：${dayEnd > day ? `第 ${day}～${dayEnd} 天` : `第 ${day} 天`}`] : []),
      `事实：${facts} 条`,
      `线索：新开 ${opened}，推进 ${advanced}，收口 ${closed}`,
      `出场人物：${present} 人`,
      ...(notRecorded > 0 ? [`没记上：${notRecorded} 条`] : []),
    ],
  };
}

export function summarizeCommitReport(report: unknown): CommitReportSummary {
  const root = asRecord(report);
  const ledger = asRecord(root.ledger);
  if (Object.keys(ledger).length > 0) return summarizeLedgerReport(root, ledger);
  const hookTracking = asRecord(root.hookTracking);
  const threadTracking = asRecord(root.threadTracking);
  const arcGoalTracking = asRecord(root.arcGoalTracking);

  const updatedCharacterCount = stringArrayLength(root.updatedCharacters);
  const timelineEventCount = stringArrayLength(root.timelineEventIds);
  const updatedHookCount = Math.max(
    stringArrayLength(root.updatedHooks),
    stringArrayLength(hookTracking.touchedHooks),
  );
  const touchedThreadCount = stringArrayLength(threadTracking.touchedThreads);
  const touchedGoalCount = stringArrayLength(arcGoalTracking.touchedGoals);
  const completedGoalCount = stringArrayLength(arcGoalTracking.completedGoals);
  const staleHookWarningCount = Array.isArray(hookTracking.staleHookWarnings) ? hookTracking.staleHookWarnings.length : 0;
  const staleThreadWarningCount = Array.isArray(threadTracking.staleThreadWarnings) ? threadTracking.staleThreadWarnings.length : 0;
  const staleGoalWarningCount = Array.isArray(arcGoalTracking.staleGoalWarnings) ? arcGoalTracking.staleGoalWarnings.length : 0;
  const warningCount = staleHookWarningCount + staleThreadWarningCount + staleGoalWarningCount;

  const chapterPath = typeof root.chapterPath === "string" && root.chapterPath.trim().length > 0
    ? root.chapterPath.trim()
    : "chapters";

  return {
    statusLine: `状态同步：角色 ${updatedCharacterCount} 项，时间线 ${timelineEventCount} 条，伏笔/线索 ${updatedHookCount + touchedThreadCount} 项，主线目标 ${touchedGoalCount} 项。`,
    detailLines: [
      `正式章节：已写入 ${chapterPath}`,
      `角色状态：${updatedCharacterCount} 项`,
      `时间线事件：${timelineEventCount} 条`,
      `伏笔更新：${updatedHookCount} 项`,
      `线索线程：${touchedThreadCount} 项`,
      `主线目标：${touchedGoalCount} 项，完成 ${completedGoalCount} 项`,
      `世界状态：${booleanLabel(root.updatedWorld)}`,
      `故事日历：${booleanLabel(root.updatedCalendar)}`,
      ...(warningCount > 0
        ? [`过期提醒：伏笔 ${staleHookWarningCount} 条，线索 ${staleThreadWarningCount} 条，主线目标 ${staleGoalWarningCount} 条`]
        : []),
    ],
  };
}
