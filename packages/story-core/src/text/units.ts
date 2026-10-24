/**
 * 编号句子（P12）：一章正文按确定性规则切成「句」，每句一个编号。核账、改稿、改齐前文之间只传编号，
 * 代码按编号取原文、按编号整句换——不再让模型抄原句、再拿抄来的字去正文里模糊找。
 *
 * 切法（只看标点和换行，不看意思）：
 *  - 不跨段：一行一段，段里按句末标点（。！？!?，连着的几个算一个）断开，后面紧跟的收引号、收括号归这一句；
 *  - 英文直引号按这一段里出现的先后一开一合，句末标点后面那个是不是「收」看它是这段第几个；
 *  - 段首缩进、句间空白不算进句子；「# 章名」那行不切、不给改；
 *  - 省略号、破折号不断句（「他……他走了」是一句）。
 *
 * 换句时代码守住引号：新句开头、结尾的引号跟原句一样（模型多包一层、少收一个都在这里一次理掉），
 * 理完各种引号的开合差还和原句一样才换；理不平就如实失败，不硬塞。
 */

/** 一句：编号（本章第几句，1 起）、在全文里的位置、原文。 */
export interface TextUnit {
  readonly id: number;
  readonly start: number;
  readonly end: number;
  readonly text: string;
  /** 第几行（0 起）：同一行的句子是一段。 */
  readonly line: number;
}

// 不猜白名单开始：切句
const TERMINATORS = new Set(["。", "！", "？", "!", "?"]);
const CLOSERS = new Set(["”", "」", "』", "’", "）", ")", "】", "》"]);
const OPENERS = new Set(["“", "「", "『", "‘"]);
const QUOTE_CLOSERS = new Set(["”", "」", "』", "’"]);
const PAIRS: readonly (readonly [string, string])[] = [["“", "”"], ["「", "」"], ["『", "』"], ["‘", "’"]];
const isBlank = (char: string): boolean => char.trim() === "";
const isHeading = (line: string): boolean => /^#{1,6}\s/u.test(line.trim());
// 不猜白名单结束

/** 切一行：返回各句在这一行里的 [start, end)。 */
function splitLine(line: string): [number, number][] {
  const out: [number, number][] = [];
  const chars = Array.from(line);
  const offsets: number[] = [];
  let offset = 0;
  for (const char of chars) {
    offsets.push(offset);
    offset += char.length;
  }
  offsets.push(offset);
  let straightSeen = 0;
  let begin = 0;
  let index = 0;
  const push = (from: number, to: number): void => {
    let a = from;
    let b = to;
    while (a < b && isBlank(chars[a]!)) a += 1;
    while (b > a && isBlank(chars[b - 1]!)) b -= 1;
    if (b > a) out.push([offsets[a]!, offsets[b]!]);
  };
  while (index < chars.length) {
    const char = chars[index]!;
    if (char === "\"") straightSeen += 1;
    if (!TERMINATORS.has(char)) {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < chars.length && TERMINATORS.has(chars[end]!)) end += 1;
    // 收引号、收括号归这一句；直引号只在「这段里已经开了一个」时算收。
    for (;;) {
      const next = chars[end];
      if (next === undefined) break;
      if (CLOSERS.has(next)) {
        end += 1;
        continue;
      }
      if (next === "\"" && straightSeen % 2 === 1) {
        straightSeen += 1;
        end += 1;
        continue;
      }
      break;
    }
    push(begin, end);
    begin = end;
    index = end;
  }
  push(begin, chars.length);
  return out;
}

/** 把正文切成编号句子。`# 章名` 行不算。 */
export function splitUnits(text: string): TextUnit[] {
  const units: TextUnit[] = [];
  let lineStart = 0;
  const lines = text.split("\n");
  lines.forEach((line, lineIndex) => {
    if (!isHeading(line)) {
      for (const [start, end] of splitLine(line)) {
        units.push({ id: units.length + 1, start: lineStart + start, end: lineStart + end, text: line.slice(start, end), line: lineIndex });
      }
    }
    lineStart += line.length + 1;
  });
  return units;
}

/** 给模型看的样子：一段一行，每句前面写编号 `[12]`。 */
export function numberedText(units: readonly TextUnit[]): string {
  const lines: string[] = [];
  let currentLine: number | undefined;
  for (const unit of units) {
    const piece = `[${unit.id}]${unit.text}`;
    if (unit.line === currentLine) lines[lines.length - 1] += piece;
    else lines.push(piece);
    currentLine = unit.line;
  }
  return lines.join("\n");
}

/** 一句话里各种引号的开合差（开的个数 − 收的个数），直引号只看奇偶。 */
function quoteBalance(text: string): string {
  const parts = PAIRS.map(([open, close]) => text.split(open).length - text.split(close).length);
  parts.push((text.split("\"").length - 1) % 2);
  return parts.join(",");
}

function leadingOpeners(text: string): string {
  let out = "";
  for (const char of text) {
    if (!OPENERS.has(char)) break;
    out += char;
  }
  return out;
}

function trailingClosers(text: string): string {
  const chars = Array.from(text);
  let at = chars.length;
  while (at > 0 && QUOTE_CLOSERS.has(chars[at - 1]!)) at -= 1;
  return chars.slice(at).join("");
}

/** 模型回的新句常带回编号（`[12]……`）或换行：去掉。 */
function cleanReplacement(text: string): string {
  // 不猜白名单：自家格式
  return text.replace(/^\s*\[\d+\]\s*/u, "").replace(/\s*\n+\s*/gu, "").trim();
}

/**
 * 新句的引号对齐原句：先原样试；不行就把新句头尾的引号去掉、换上原句头尾的引号再试；
 * 两样都对不平（开合差和原句不一样）就返回 undefined——宁可不换，不往正文里塞坏引号。
 * 删句（新句是空的）留下原句头尾的引号，免得把整段对话的开 / 收引号一起删了。
 */
export function fitQuotes(from: string, to: string): string | undefined {
  const target = quoteBalance(from);
  const head = leadingOpeners(from);
  const tail = trailingClosers(from);
  if (!to) {
    const kept = `${head}${tail}`;
    return quoteBalance(kept) === target ? kept : undefined;
  }
  const sameEdges = leadingOpeners(to) === head && trailingClosers(to) === tail;
  if (sameEdges && quoteBalance(to) === target) return to;
  const core = Array.from(to);
  let a = 0;
  while (a < core.length && OPENERS.has(core[a]!)) a += 1;
  let b = core.length;
  while (b > a && QUOTE_CLOSERS.has(core[b - 1]!)) b -= 1;
  const rebuilt = `${head}${core.slice(a, b).join("")}${tail}`;
  if (quoteBalance(rebuilt) === target) return rebuilt;
  if (quoteBalance(to) === target) return to;
  return undefined;
}

export interface UnitEdit {
  /** 第几句（按改之前的正文切）。 */
  readonly id: number;
  /** 那句原来的字（编号对不上时按它在全文里唯一找一遍）。 */
  readonly from: string;
  /** 换成什么；空串 = 删掉这句。 */
  readonly to: string;
}

export interface AppliedUnitEdit {
  readonly id: number;
  readonly from: string;
  readonly to: string;
  /** 改之前这句在全文里的位置。 */
  readonly start: number;
  readonly end: number;
}

export type ApplyUnitEditsResult =
  | { readonly ok: true; readonly text: string; readonly applied: readonly AppliedUnitEdit[] }
  | { readonly ok: false; readonly code: "unit_moved" | "duplicate_unit" | "quotes_unbalanced"; readonly id: number; readonly message: string };

/**
 * 按编号整句换。每处先认编号、原文对不上就按原文在全文里唯一找；找不到、找到多处都不换，整批失败。
 * 换上去的字先过 fitQuotes；和原句一样的那处跳过（不算改）。全部成了才返回新正文。
 */
export function applyUnitEdits(text: string, edits: readonly UnitEdit[]): ApplyUnitEditsResult {
  const units = splitUnits(text);
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const picked = new Map<number, AppliedUnitEdit>();
  for (const edit of edits) {
    let unit = byId.get(edit.id);
    if (!unit || unit.text !== edit.from) {
      const matches = units.filter((item) => item.text === edit.from);
      if (matches.length !== 1) {
        return { ok: false, code: "unit_moved", id: edit.id, message: `第 ${edit.id} 句「${edit.from}」现在找不到了（正文改过）` };
      }
      unit = matches[0]!;
    }
    if (picked.has(unit.id)) return { ok: false, code: "duplicate_unit", id: unit.id, message: `第 ${unit.id} 句给了两种改法` };
    const fitted = fitQuotes(unit.text, cleanReplacement(edit.to));
    if (fitted === undefined) {
      return { ok: false, code: "quotes_unbalanced", id: unit.id, message: `「${unit.text}」改出来引号对不上` };
    }
    if (fitted === unit.text) continue;
    picked.set(unit.id, { id: unit.id, from: unit.text, to: fitted, start: unit.start, end: unit.end });
  }
  const applied = [...picked.values()].sort((a, b) => a.start - b.start);
  let out = text;
  for (const edit of [...applied].reverse()) out = out.slice(0, edit.start) + edit.to + out.slice(edit.end);
  return { ok: true, text: out, applied };
}
