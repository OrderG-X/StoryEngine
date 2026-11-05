/**
 * 按核账改（P12 第二期「编号句子」）：核账卡「改这处 / 改掉这 N 处」（draft.change fix）和出稿流程里的「按核账改」共用这一条。
 *
 * 核账引的原句先在稿里找到是哪几句（逐字；不计空白引号；「A……B」两截），整章按句编号交给修订模型，
 * 只许改点名的那几句；模型按编号回新句，代码按编号整句换（核心 applyUnitEdits：引号对齐原句、抄进来的邻句去掉）。
 * 不再让模型抄原句、再拿抄来的字回稿里找，也就没有补整句、接缝去重那一套。
 * 一章要改几处只问一次模型；改不成的照实说为什么，正文不动。
 */

import { chinesePunctuationLike } from "../../lib/dialogue-quotes.js";
import { applyUnitEdits, numberedText, prepareUnitReplacement, splitNumberedReply, splitUnits, type TextUnit, type UnitEdit } from "@actalk/story-core";
import { locateRevisionSpan, revisionSpans, type RevisionModelCaller } from "./draft-change/revise-text.js";
import { rethrowIfStopped } from "../lib/operations/context.js";

import { modelFailureText } from "../lib/ai-errors.js";
export interface UnitFix {
  /** 核账引的原句。 */
  readonly quote: string;
  /** 要改成什么样（和哪句对上 + 理由）。 */
  readonly goal: string;
}

export interface UnitFixOutcome {
  /** 改后的整份正文（一处都没改成就是原文）。 */
  readonly text: string;
  /** 改成了的是第几处（fixes 的下标）。 */
  readonly applied: readonly number[];
  /** 没改成的：第几处 + 为什么（给作者看的话）。 */
  readonly failed: readonly { readonly fix: number; readonly why: string }[];
  /** 换上去的句子（改前 → 改后）。 */
  readonly changes: readonly { readonly from: string; readonly to: string }[];
  /** changes 每一条在改前正文里从第几个字起（按位置并两轮改动用，同样的字出现几处时靠它认是哪一处）。 */
  readonly at: readonly number[];
  /** 其中不是点名的、本章别处说同一件事跟着改的句数。 */
  readonly alsoChanged: number;
  /**
   * applied 里核账引的原句改完还原样在稿里的：点名那句没动、改的是本章别的句子（核账引的常是错处旁边那句，
   * 或同一章前面那句才是该改的），或同一句出现几次只改了其中一次。改完再核要把这几处交核账员复核
   * （不然按「原句没动」原样带着、一直报）。
   */
  readonly revisit: readonly number[];
}

/** 一处原句最多落到几句上；再多就是引得太长，交给作者。 */
const MAX_UNITS_PER_FIX = 4;
/** 同一句在稿里出现几次以内，每一次都编号交模型、照上下文挑真对不上的那次；再多就交给作者。 */
const MAX_COPIES = 3;
/**
 * 本章别处说同一件事、不跟着改就前后对不上的句子，每处最多连带改几句（真机 P13：「四个字」只改了点名那句，
 * 本章另两句还说「四个字」，再核又报两处）。一批按处数算总数：作者自己写的章一次七八处，原来一批合起来只许 3 句，
 * 改完再核剩下的几乎全是「本章别处还照改前说」（考台 2026-11-03）。
 */
export const ALSO_EDITS_PER_FIX = 4;
const alsoEditsFor = (targets: number): number => ALSO_EDITS_PER_FIX * Math.max(1, targets);
/** 一批改句最多调几次：一次 + 格式不对再要一次（写作版本 P2a 4.5 额度从这里算）。 */
export const UNIT_FIX_MAX_CALLS = 2;
/** 核账卡「改掉」最多改几轮：第一轮改作者点的那几处，改完再核还有对不上的再改一轮（考台 2026-11-03：一轮改完还剩一半）。 */
export const FIX_ROUNDS = 2;

/** 原句落在哪几句：ids 是全部编号；同一句在稿里出现了几次（作者稿里整段重复过）时 copies 是每一次的编号。 */
export interface QuoteUnits {
  readonly ids: readonly number[];
  readonly copies?: readonly (readonly number[])[];
}

/** 原句落在哪几句（编号）；找不到 / 出现太多次 / 太长给原因。 */
export function unitsOfQuote(text: string, units: readonly TextUnit[], quote: string): QuoteUnits | string {
  const span = locateRevisionSpan(text, quote.trim());
  if (span === "not_found") return "原句在稿里找不到了（可能已经改过）";
  // 出现几次（考台 2026-11-04：作者稿整段重复，8 处里 5 处因此没改）：每一次都交模型，它看上下文挑；省略号连起的几截不在这里找。
  const spans = span === "ambiguous" ? revisionSpans(text, quote.trim()) : [span];
  if (spans.length === 0 || spans.length > MAX_COPIES) return "原句在稿里不止一处，不知道改哪一处";
  const each = spans.map((at) => units.filter((unit) => unit.start < at.end && at.start < unit.end).map((unit) => unit.id));
  if (each.some((ids) => ids.length === 0)) return "原句在稿里找不到了（可能已经改过）";
  if (each.some((ids) => ids.length > MAX_UNITS_PER_FIX)) return "核账引的原句太长，没法只改那几句";
  return each.length === 1 ? { ids: each[0]! } : { ids: each.flat(), copies: each };
}

/** 同一句出现几次时加在改法后面的那句。 */
const copiesNote = (copies: readonly (readonly number[])[]): string =>
  `（这句在稿里出现了 ${copies.length} 次：${copies.map((ids) => ids.map((id) => `[${id}]`).join("")).join("、")}，只改真和前文对不上的那一次；几次都对不上就都改）`;

export function unitFixTask(chapter: number, numbered: string, targets: readonly { readonly ids: readonly number[]; readonly goal: string }[]): string {
  return [
    `下面是第 ${chapter} 章的工作稿，每句前面有编号 [n]。核账查出几处和前文、设定对不上，请只改点名的这几句：`,
    ...targets.map((target, index) => `${index + 1}. ${target.ids.map((id) => `[${id}]`).join("")}：${target.goal}`),
    "要求：",
    "- 只改点名的句子；能小改就小改，口吻、写法、标点习惯照原来的；",
    "- 改法只用前文、设定和本章已经写明的东西：把对不上的说法改成前文那样，或者删掉、写虚；别为了圆过去新编前文没写过的细节（东西上写着什么、什么时候怎么来的、在哪、谁做了什么、几个、几号），新编的多半又和前文对不上；",
    "- 改完的句子别比原句长出一截，要补的只补最少的几个字；",
    `- 本章别的句子也说了同一件事、点名那句改了它不跟着改就前后对不上的（比如数目、时间、地点、人名、谁说的），也照同样的改法一并给出（这几处合起来最多 ${alsoEditsFor(targets.length)} 句）；和这件事无关的句子一个字不动；`,
    "- 点名那句本身没写到这件事、对不上的说法其实在本章别的句子里的（旁边那句，或本章前面那句），改真写了它的那句，点名那句不动；",
    "- 每条写 for：这句是为上面第几处改的；",
    "- 一句改完还是一句：别把前后句抄进来，也别拆成几句；点名了两三句的，只改要改的那句就行；",
    "- 实在要删掉这句才通顺，to 给空串。",
    '只输出一个 JSON：{"edits":[{"id":12,"for":1,"to":"改后的这一句"}]}',
    "",
    numbered,
  ].join("\n");
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** 一句改法，带模型标的是为第几处改的（0 起；没标、标错的没有）。 */
export type FixEdit = UnitEdit & { readonly target?: number };

/** 模型标的「为第几处改的」：1 起的序号（数字或数字串），越界、没写的当没标。 */
function targetOf(raw: unknown, targets: number): number | undefined {
  const value = typeof raw === "number" ? raw : typeof raw === "string" && /^\s*\d+\s*$/u.test(raw) ? Number(raw) : Number.NaN;
  return Number.isInteger(value) && value >= 1 && value <= targets ? value - 1 : undefined;
}

/**
 * 模型回的改法：点名的编号照收；别的编号是「本章别处说同一件事」的连带改、或点名那句没写到这件事时改的真写了它的那句，
 * 最多 maxAlso 句、锁住的（接着写时作者写的那段）不收。
 * 新句过一遍 prepareUnitReplacement，用不了、和原句一样的不要。
 */
export function parseUnitFixEdits(
  reply: string,
  units: readonly TextUnit[],
  allowed: ReadonlySet<number>,
  locked: ReadonlySet<number> = new Set(),
  maxAlso: number = alsoEditsFor(1),
  targets = 1,
): FixEdit[] | undefined {
  const parsed = parseJsonObject(reply);
  if (!parsed || !Array.isArray(parsed.edits)) return undefined;
  const out: FixEdit[] = [];
  let also = 0;
  // 模型回的半角逗号、直引号换成中文的，除非这章本来就这么写（跟着原文的标点习惯）。
  const context = units.map((unit) => unit.text).join("");
  for (const raw of parsed.edits) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    const rawId = typeof record.id === "number" ? record.id : typeof record.id === "string" ? Number(record.id.replace(/[[\]\s]/gu, "")) : Number.NaN;
    if (!Number.isInteger(rawId) || typeof record.to !== "string") continue;
    // 只有一处时不用标：都是为它改的。
    const target = targets === 1 ? 0 : targetOf(record.for, targets);
    // 照编号正文整段抄回来的（带着别的编号）：拆开，每句各自对。
    for (const piece of splitNumberedReply(rawId, record.to)) {
      const id = piece.id;
      if (out.some((edit) => edit.id === id)) continue;
      const unit = units.find((item) => item.id === id);
      if (!unit) continue;
      const named = allowed.has(id);
      if (!named && (locked.has(id) || also >= maxAlso)) continue;
      const to = prepareUnitReplacement(units, id, chinesePunctuationLike(context, piece.to));
      if (to === undefined || to === unit.text || to.length > unit.text.length * 3 + 60) continue;
      // 连带改的不许删句：删一句要作者看着办。
      if (!named && !to.trim()) continue;
      if (!named) also += 1;
      out.push({ id, from: unit.text, to, ...(target !== undefined ? { target } : {}) });
    }
  }
  return out;
}

const errorText = (error: unknown): string => modelFailureText(error);

/**
 * 改一章（不读盘、不写盘）：定位 → 问一次模型 → 按编号换。
 * 回的不是要的格式就同一份提示再要一次；模型调用本身出错不重试，照实算没改成。
 */
export async function fixByUnits(input: {
  readonly chapter: number;
  readonly text: string;
  readonly fixes: readonly UnitFix[];
  readonly callModel: RevisionModelCaller;
  /** 这个位置之前的句子不连带改（接着写：开头是本来写好的那段）。 */
  readonly lockedBefore?: number;
}): Promise<UnitFixOutcome> {
  const { text, fixes } = input;
  const units = splitUnits(text);
  const locked = new Set(input.lockedBefore === undefined ? [] : units.filter((unit) => unit.start < input.lockedBefore!).map((unit) => unit.id));
  const failed: { fix: number; why: string }[] = [];
  const located: { fix: number; at: QuoteUnits }[] = [];
  fixes.forEach((fix, index) => {
    const at = unitsOfQuote(text, units, fix.quote);
    if (typeof at === "string") failed.push({ fix: index, why: at });
    else located.push({ fix: index, at });
  });
  const unchanged = (): UnitFixOutcome => ({ text, applied: [], failed: failed.sort((a, b) => a.fix - b.fix), changes: [], at: [], alsoChanged: 0, revisit: [] });
  if (located.length === 0) return unchanged();

  // 两处落在同一句上：合成一条交给模型，免得同一句给两种改法。
  const targets: { fixes: number[]; ids: number[]; goals: string[] }[] = [];
  for (const item of located) {
    const goal = `${fixes[item.fix]!.goal}${item.at.copies ? copiesNote(item.at.copies) : ""}`;
    const same = targets.find((target) => item.at.ids.some((id) => target.ids.includes(id)));
    if (same) {
      same.fixes.push(item.fix);
      for (const id of item.at.ids) if (!same.ids.includes(id)) same.ids.push(id);
      same.goals.push(goal);
    } else {
      targets.push({ fixes: [item.fix], ids: [...item.at.ids], goals: [goal] });
    }
  }
  const allowed = new Set(targets.flatMap((target) => target.ids));
  const prompt = unitFixTask(input.chapter, numberedText(units), targets.map((target) => ({ ids: [...target.ids].sort((a, b) => a - b), goal: target.goals.join("；") })));

  let edits: FixEdit[] | undefined;
  try {
    for (let call = 0; call < UNIT_FIX_MAX_CALLS && !edits; call += 1) {
      edits = parseUnitFixEdits(await input.callModel(prompt), units, allowed, locked, alsoEditsFor(targets.length), targets.length);
    }
  } catch (error) {
    rethrowIfStopped(error);
    for (const target of targets) for (const fix of target.fixes) failed.push({ fix, why: `AI 没改成（${errorText(error)}）` });
    return unchanged();
  }
  if (!edits) {
    for (const target of targets) for (const fix of target.fixes) failed.push({ fix, why: "AI 回的格式不对，没写改后的句子" });
    return unchanged();
  }

  // 换上去：哪一句换不上（引号理不平）就去掉那一句再换，别的照换。
  const dropped = new Map<number, string>();
  let pending = edits;
  let result = applyUnitEdits(text, pending);
  while (!result.ok) {
    const bad = result.id;
    dropped.set(bad, result.code === "quotes_unbalanced" ? "改出来引号对不上，没换" : "这句换不上");
    pending = pending.filter((edit) => edit.id !== bad);
    result = applyUnitEdits(text, pending);
  }
  const changedIds = new Set(result.applied.map((edit) => edit.id));
  // 换上了的改别处的句子是为哪几处改的（模型标的）。
  const changedFor = new Set(pending.filter((edit) => changedIds.has(edit.id) && !allowed.has(edit.id)).flatMap((edit) => (edit.target !== undefined ? [edit.target] : [])));
  const applied: number[] = [];
  const elsewhereTargets = new Set<number>();
  targets.forEach((target, index) => {
    if (target.ids.some((id) => changedIds.has(id))) {
      applied.push(...target.fixes);
      return;
    }
    if (changedFor.has(index)) {
      applied.push(...target.fixes);
      elsewhereTargets.add(index);
      return;
    }
    const why = target.ids.map((id) => dropped.get(id)).find(Boolean) ?? "AI 没给出这句的改法";
    for (const fix of target.fixes) failed.push({ fix, why });
  });
  // 一处都没改成：别的句子（连带改、标不出为哪处改的）也不换——连带改只跟着改成了的那处走（外部审查 2026-11-06）。
  if (applied.length === 0) return unchanged();
  const finalText = result.text;
  return {
    text: finalText,
    applied: applied.sort((a, b) => a - b),
    failed: failed.sort((a, b) => a.fix - b.fix),
    changes: result.applied.map((edit) => ({ from: edit.from, to: edit.to })),
    at: result.applied.map((edit) => edit.start),
    // 连带改的不算替点名那句改到别处的那几句。
    alsoChanged: pending.filter((edit) => changedIds.has(edit.id) && !allowed.has(edit.id) && !(edit.target !== undefined && elsewhereTargets.has(edit.target))).length,
    revisit: applied.filter((fix) => locateRevisionSpan(finalText, fixes[fix]!.quote.trim()) !== "not_found"),
  };
}
