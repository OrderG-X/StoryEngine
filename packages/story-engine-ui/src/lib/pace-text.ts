/**
 * 节奏诊断的中文说法：故事地图和对话 AI（read_chapters_overview）共用一份，说法只在这里定一次。
 * 只拼数字，不加评语；结论一律是「可能」，作者自己判断。
 */
import type { PaceFlag } from "@actalk/story-core";

const num = (value: number): string => value.toLocaleString("zh-CN");

export function paceRange(flag: Pick<PaceFlag, "from" | "to">): string {
  return flag.from === flag.to ? `第 ${flag.from} 章` : `第 ${flag.from}～${flag.to} 章`;
}

/** 「推进 4 条、收了 1 条线索」「只推进了 1 条线索」「没推进线索」。 */
function movesText(flag: PaceFlag): string {
  if (flag.reason === "slow") {
    if (flag.advanced + flag.closed === 0) return "没推进线索";
    return flag.closed > 0 ? `只推进 ${flag.advanced} 条、收了 ${flag.closed} 条线索` : `只推进了 ${flag.advanced} 条线索`;
  }
  return flag.closed > 0 ? `推进 ${flag.advanced} 条、收了 ${flag.closed} 条线索` : `推进了 ${flag.advanced} 条线索`;
}

/** 为什么说它拖 / 赶（不带章号）。 */
export function paceReason(flag: PaceFlag): string {
  if (flag.reason === "span") return `一章跨了 ${flag.span ?? 0} 天，只写了 ${num(flag.words)} 字`;
  if (flag.reason === "dense") return `${num(flag.words)} 字里${movesText(flag)}`;
  return `${num(flag.words)} 字${movesText(flag)}`;
}

/** 一整句：「第 46 章可能拖：2,094 字只推进了 1 条线索」。 */
export function paceNote(flag: PaceFlag): string {
  return `${paceRange(flag)}可能${flag.kind === "drag" ? "拖" : "赶"}：${paceReason(flag)}`;
}
