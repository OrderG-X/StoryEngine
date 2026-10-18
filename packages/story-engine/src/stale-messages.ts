/**
 * 停滞提醒的文案（伏笔 / 线索 / 目标「N 章没推进」）。
 *
 * 原来住在三个跟踪模块里，跟踪逻辑随老定稿链删了（重构 P7）；出稿上下文还要这几句提醒，单独留下。
 */
import type { ArcGoal, NarrativeThread } from "./types.js";

/** 主线目标停这么多章以上，提醒语气加重。 */
const MAIN_ARC_ESCALATION_IDLE = 10;

export function formatStaleGoalMessage(input: {
  readonly title: string;
  readonly scope: ArcGoal["scope"];
  readonly lastTouchedChapter: number;
  readonly chaptersSinceTouched: number;
}): string {
  if (input.scope === "main_arc") {
    if (input.chaptersSinceTouched > MAIN_ARC_ESCALATION_IDLE) {
      return `主线目标「${input.title}」已 ${input.chaptersSinceTouched} 章未实质推进——主线不该长期停摆：近几章安排一次实质推进（新信息/新障碍/关键抉择），或与用户确认是否转入蛰伏。`;
    }
    return `主线目标「${input.title}」已 ${input.chaptersSinceTouched} 章没有推进（上次出现在第 ${input.lastTouchedChapter} 章）。考虑近几章安排一次实质推进。`;
  }
  return `阶段目标「${input.title}」已 ${input.chaptersSinceTouched} 章没有推进（上次出现在第 ${input.lastTouchedChapter} 章）。考虑推进或收口。`;
}

export function formatStaleHookMessage(input: {
  readonly title: string;
  readonly lastTouchedChapter: number;
  readonly chaptersSinceTouched: number;
}): string {
  return `伏笔「${input.title}」已 ${input.chaptersSinceTouched} 章没有推进（上次出现在第 ${input.lastTouchedChapter} 章）。考虑推进或收口，别让它埋了不收。`;
}

export function formatStaleThreadMessage(input: {
  readonly type: NarrativeThread["type"];
  readonly title: string;
  readonly lastTouchedChapter: number;
  readonly chaptersSinceTouched: number;
}): string {
  const kind = input.type === "lead" ? "线索" : "意图";
  return `${kind}「${input.title}」已 ${input.chaptersSinceTouched} 章没有推进（上次出现在第 ${input.lastTouchedChapter} 章）。考虑推进或收口，别让它埋了不收。`;
}
