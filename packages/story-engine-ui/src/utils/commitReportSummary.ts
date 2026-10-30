export interface CommitReportSummary {
  /** 定稿的是第几章（新回执带；老回执没有）。 */
  readonly chapter?: number;
  /** 记了什么，一项一行（「事实：4 条」）；正文写进哪一章不另说——卡头「已定稿」就是。 */
  readonly detailLines: readonly string[];
  /** 账记到什么程度（P2b）：pending = 正文定了、账还没记上；partial = 没记全。记全了 / 老回执没有。 */
  readonly ledgerStatus?: "pending" | "partial";
  /** 补账的回执（正文没动）。 */
  readonly fill?: true;
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
  const chapter = count(root.chapter);
  const facts = count(ledger.facts);
  const opened = count(ledger.threadsOpened);
  const advanced = count(ledger.threadsAdvanced);
  const closed = count(ledger.threadsClosed);
  const present = count(ledger.present);
  const day = count(ledger.day);
  const dayEnd = count(ledger.dayEnd);
  const notRecorded = count(ledger.notRecorded);
  const status: CommitReportSummary["ledgerStatus"] = ledger.status === "pending" ? "pending" : ledger.status === "partial" ? "partial" : undefined;
  const flags = { ...(status ? { ledgerStatus: status } : {}), ...(root.fill === true ? { fill: true as const } : {}) };
  // 账待记：一条都没记，不列一排零。
  if (status === "pending") return { ...(chapter > 0 ? { chapter } : {}), detailLines: ["账：还没记上"], ...flags };
  return {
    ...(chapter > 0 ? { chapter } : {}),
    ...flags,
    detailLines: [
      ...(day > 0 ? [`故事时间：${dayEnd > day ? `第 ${day}～${dayEnd} 天` : `第 ${day} 天`}`] : []),
      `事实：${facts} 条`,
      `线索：新开 ${opened}，推进 ${advanced}，收口 ${closed}`,
      `出场人物：${present} 人`,
      ...(notRecorded > 0 ? [`没记上：${notRecorded} 条`] : []),
      ...(status === "partial" ? ["账：没记全"] : []),
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

  return {
    detailLines: [
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
