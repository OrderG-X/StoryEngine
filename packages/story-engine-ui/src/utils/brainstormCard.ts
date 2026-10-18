/**
 * 头脑风暴卡（重构 P6）的纯函数：工具输出 / 存盘数据的防御解析、挑中的走法变成「这章的方向」、找这一章最新的那张卡。
 * 前端投影和服务端存盘白名单共用同一个解析，两边不会各认各的。
 */
import type { BrainstormCardData, BrainstormOptionData, ChapterMessage } from "../type-defs/workspace.js";
import { cardOf } from "./messageCards.js";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const count = (value: unknown): number | undefined => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined);

function readOption(value: unknown): BrainstormOptionData | undefined {
  if (!isRecord(value)) return undefined;
  const title = text(value.title);
  const steps = (Array.isArray(value.steps) ? value.steps : []).map(text).filter(Boolean).slice(0, 8);
  if (!title || steps.length === 0) return undefined;
  const threads = (Array.isArray(value.threads) ? value.threads : []).flatMap((item) => {
    if (!isRecord(item) || !text(item.title)) return [];
    return [{ title: text(item.title), idle: count(item.idle) ?? 0, stale: item.stale === true }];
  }).slice(0, 12);
  const problems = (Array.isArray(value.problems) ? value.problems : []).flatMap((item) => {
    if (!isRecord(item)) return [];
    const step = count(item.step);
    const earlierChapter = count(item.earlierChapter);
    const reason = text(item.reason);
    if (!step || !earlierChapter || !reason) return [];
    return [{ step, earlierChapter, earlierQuote: text(item.earlierQuote), reason }];
  }).slice(0, 12);
  return { title, steps, ...(value.recommended === true ? { recommended: true } : {}), threads, problems };
}

/** 工具输出 / 存盘的头脑风暴数据 → 校验过的卡数据；没有能用的走法返回 undefined。 */
export function readBrainstormData(value: unknown): BrainstormCardData | undefined {
  if (!isRecord(value)) return undefined;
  const chapter = count(value.chapter);
  if (!chapter) return undefined;
  const options = (Array.isArray(value.options) ? value.options : []).map(readOption).filter((item): item is BrainstormOptionData => Boolean(item)).slice(0, 6);
  if (options.length === 0) return undefined;
  const idea = text(value.idea);
  const checkNote = text(value.checkNote);
  const coldNote = text(value.coldNote);
  return {
    chapter,
    ...(idea ? { idea } : {}),
    options,
    checked: value.checked === true,
    ...(checkNote ? { checkNote } : {}),
    ...(coldNote ? { coldNote } : {}),
  };
}

/** 存盘的 picked：在走法范围内的整数才认。 */
export function readPicked(value: unknown, data: BrainstormCardData): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < data.options.length ? value : undefined;
}

/** 挑中的走法 → 交给「写这一章」的方向（章纲员照它拟纲）。 */
export function directionGoal(option: BrainstormOptionData): string {
  return `${option.title}：${option.steps.map((step, index) => `${index + 1}. ${step}`).join(" ")}`;
}

export interface ChapterDirections {
  readonly messageId: string;
  readonly data: BrainstormCardData;
  readonly picked?: number;
}

/** 这一章最新的那张走法卡（从后往前找）。 */
export function latestDirections(messages: readonly ChapterMessage[], chapter: number): ChapterDirections | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    const card = cardOf(message, "directions");
    if (card && card.brainstorm.chapter === chapter) {
      return { messageId: message.id, data: card.brainstorm, ...(card.picked !== undefined ? { picked: card.picked } : {}) };
    }
  }
  return undefined;
}

/** 这一章挑中的走法（没挑返回 undefined）。 */
export function pickedDirection(messages: readonly ChapterMessage[], chapter: number): BrainstormOptionData | undefined {
  const latest = latestDirections(messages, chapter);
  return latest?.picked !== undefined ? latest.data.options[latest.picked] : undefined;
}
