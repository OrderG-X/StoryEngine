/**
 * 定稿清单上作者动过的条目和改的天数（2026-10-10「AI 记账、作者核账」；片 4A 起按出清单的那次定稿记）。
 *
 * 放在模块里而不是弹窗组件状态里：回合收尾时消息列表重建、弹窗重新挂载，组件状态会悄悄丢；关了再开清单也得带上作者动过的。
 * 集合里混着两类：默认记的条目在集合里＝不记；要确认的改记（defaultUnchecked）在集合里＝确认改记。点「确认定稿」时原样交给
 * 那次定稿（服务端按清单上的键认）。
 */
/** 作者改过的天数：第 day 天（到第 dayEnd 天，这一章跨天时）。 */
export interface DayOverride {
  readonly day: number;
  readonly dayEnd?: number;
}

interface Entry {
  readonly toggled: ReadonlySet<string>;
  readonly dayOverride?: DayOverride;
}

const byOperation = new Map<string, Entry>();

export function rememberLedgerExclusions(opId: string, toggled: ReadonlySet<string>): void {
  const previous = byOperation.get(opId);
  byOperation.set(opId, { toggled, ...(previous?.dayOverride !== undefined ? { dayOverride: previous.dayOverride } : {}) });
}

/** 记下作者在清单上改的天数（undefined = 改回原值）。 */
export function rememberLedgerDayOverride(opId: string, day: DayOverride | undefined): void {
  byOperation.set(opId, { toggled: byOperation.get(opId)?.toggled ?? new Set(), ...(day !== undefined ? { dayOverride: day } : {}) });
}

/** 这张清单此前动过的条目（弹窗重挂载时恢复用）。 */
export function ledgerExclusionsFor(opId: string): ReadonlySet<string> {
  return byOperation.get(opId)?.toggled ?? new Set();
}

/** 这张清单此前改过的天数。 */
export function ledgerDayOverrideFor(opId: string): DayOverride | undefined {
  return byOperation.get(opId)?.dayOverride;
}

/** 点了「确认定稿」以后清掉。 */
export function clearLedgerExclusions(opId: string): void {
  byOperation.delete(opId);
}
