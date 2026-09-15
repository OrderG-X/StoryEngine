/**
 * stale 提醒里程碑制（2026-07-05 r7）：治「同一批停滞告警每章重复灌 prompt/预览」的长跑噪音。
 *
 * 背景：修仙 75 章真机——27 条 open lead（按设计不过期）让每章 preview 刷 10–17 条「待收口」，
 * 写手上下文每章重复注入同一批警告；模型对其脱敏，纯烧上下文预算。告警本身不是错，**每章重复才是错**。
 *
 * 规则（纯章号算术、确定性、题材中立）：设停滞阈值 T，idle = 当前章 - lastTouchedChapter。
 * 提醒当且仅当：
 *   - idle ∈ (T, T+2]：新停滞的头两章立即提醒（及时性）；
 *   - 或 idle % LONG_STALE_REMINDER_INTERVAL === 0：长期停滞按固定里程碑重提（不遗忘）。
 * 其余章保持安静。数据不动（池子里仍是 open/active），总量由上层 digest 如实播报——降噪≠静默。
 */

/** 长期停滞的重提间隔（章）。 */
export const LONG_STALE_REMINDER_INTERVAL = 10;

/** 新停滞立即提醒的窗口宽度（超过阈值后的头 N 章）。 */
export const FRESH_STALE_REMINDER_WINDOW = 2;

/**
 * 本章是否应该提醒这条停滞条目。
 * @param chaptersSinceTouched 已停滞章数（当前章 - lastTouchedChapter）
 * @param threshold 停滞阈值 T（严格大于 T 才算停滞；线索/伏笔 T=3，目标 T=5）
 */
export function shouldRemindStaleAt(chaptersSinceTouched: number, threshold: number): boolean {
  if (chaptersSinceTouched <= threshold) return false;
  if (chaptersSinceTouched <= threshold + FRESH_STALE_REMINDER_WINDOW) return true;
  return chaptersSinceTouched % LONG_STALE_REMINDER_INTERVAL === 0;
}

/**
 * 算「已停滞章数」= 当前章 - lastTouchedChapter，结果恒为有限整数 ≥ 0。
 *
 * 老书的数据可能早于 lastTouchedChapter 字段引入（缺字段、null、字符串）。裸相减得 NaN，
 * 而 NaN 参与比较恒为 false——`NaN < 15` 是 false，导致**未知停滞时长的目标被直接判成
 * 「停滞超阈值」而自动蛰伏**，还会把「已 NaN 章没有推进」的鬼话写进给用户看的提醒。
 *
 * 未知按「本章刚碰过」（0 章）处理：不蛰伏、不报警。绝不拿读不到的日期做自动清理决策（铁律④：
 * 永不静默——蛰伏一条不知道上次何时推进的目标，就是静默地丢掉用户的叙事承诺）。
 */
export function chaptersSinceTouched(lastTouchedChapter: unknown, currentChapter: number): number {
  const touched = typeof lastTouchedChapter === "number" && Number.isFinite(lastTouchedChapter)
    ? Math.floor(lastTouchedChapter)
    : currentChapter;
  return Math.max(0, Math.floor(currentChapter) - touched);
}
