/**
 * 按核账改（P12 第二期「编号句子」）：核账卡「改这处 / 改掉这 N 处」和出稿流程里的「按核账改」共用这一条。
 *
 * 核账引的原句先在稿里找到是哪几句（逐字；不计空白引号；「A……B」两截），整章按句编号交给修订模型，
 * 只许改点名的那几句；模型按编号回新句，代码按编号整句换（核心 applyUnitEdits：引号对齐原句、抄进来的邻句去掉）。
 * 不再让模型抄原句、再拿抄来的字回稿里找，也就没有补整句、接缝去重那一套。
 * 一章要改几处只问一次模型；改不成的照实说为什么，正文不动。
 */
import { readFile } from "node:fs/promises";

import { applyUnitEdits, numberedText, prepareUnitReplacement, splitUnits, withBookLock, type TextUnit, type UnitEdit } from "@actalk/story-core";
import { writeAiDraft } from "../lib/ai-draft-write.js";
import { defaultDraftPath } from "../lib/project-io.js";
import { snapshotBeforeDraftOverwrite } from "../lib/snapshot-on-draft-overwrite.js";
import { locateRevisionSpan, nextDraftVersion, type RevisionModelCaller } from "./revision-service.js";

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
}

/** 一处原句最多落到几句上；再多就是引得太长，交给作者。 */
const MAX_UNITS_PER_FIX = 4;

/** 原句落在哪几句（编号）；找不到 / 不唯一 / 太长给原因。 */
export function unitsOfQuote(text: string, units: readonly TextUnit[], quote: string): readonly number[] | string {
  const span = locateRevisionSpan(text, quote.trim());
  if (span === "not_found") return "原句在稿里找不到了（可能已经改过）";
  if (span === "ambiguous") return "原句在稿里不止一处，不知道改哪一处";
  const ids = units.filter((unit) => unit.start < span.end && span.start < unit.end).map((unit) => unit.id);
  if (ids.length === 0) return "原句在稿里找不到了（可能已经改过）";
  if (ids.length > MAX_UNITS_PER_FIX) return "核账引的原句太长，没法只改那几句";
  return ids;
}

export function unitFixTask(chapter: number, numbered: string, targets: readonly { readonly ids: readonly number[]; readonly goal: string }[]): string {
  return [
    `下面是第 ${chapter} 章的工作稿，每句前面有编号 [n]。核账查出几处和前文、设定对不上，请只改点名的这几句：`,
    ...targets.map((target, index) => `${index + 1}. ${target.ids.map((id) => `[${id}]`).join("")}：${target.goal}`),
    "要求：",
    "- 只改点名的句子，别的一个字不动；能小改就小改，口吻、写法、标点习惯照原来的；",
    "- 一句改完还是一句：别把前后句抄进来，也别拆成几句；点名了两三句的，只改要改的那句就行；",
    "- 实在要删掉这句才通顺，to 给空串。",
    '只输出一个 JSON：{"edits":[{"id":12,"to":"改后的这一句"}]}',
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

/** 模型回的改法：只认点名的编号；新句过一遍 prepareUnitReplacement，用不了、和原句一样的不要。 */
export function parseUnitFixEdits(reply: string, units: readonly TextUnit[], allowed: ReadonlySet<number>): UnitEdit[] | undefined {
  const parsed = parseJsonObject(reply);
  if (!parsed || !Array.isArray(parsed.edits)) return undefined;
  const out: UnitEdit[] = [];
  for (const raw of parsed.edits) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    const id = typeof record.id === "number" ? record.id : typeof record.id === "string" ? Number(record.id.replace(/[[\]\s]/gu, "")) : Number.NaN;
    if (!Number.isInteger(id) || !allowed.has(id) || out.some((edit) => edit.id === id) || typeof record.to !== "string") continue;
    const unit = units.find((item) => item.id === id)!;
    const to = prepareUnitReplacement(units, id, record.to);
    if (to === undefined || to === unit.text || to.length > unit.text.length * 3 + 60) continue;
    out.push({ id, from: unit.text, to });
  }
  return out;
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * 改一章（不读盘、不写盘）：定位 → 问一次模型 → 按编号换。
 * 回的不是要的格式就同一份提示再要一次；模型调用本身出错不重试，照实算没改成。
 */
export async function fixByUnits(input: {
  readonly chapter: number;
  readonly text: string;
  readonly fixes: readonly UnitFix[];
  readonly callModel: RevisionModelCaller;
}): Promise<UnitFixOutcome> {
  const { text, fixes } = input;
  const units = splitUnits(text);
  const failed: { fix: number; why: string }[] = [];
  const located: { fix: number; ids: readonly number[] }[] = [];
  fixes.forEach((fix, index) => {
    const ids = unitsOfQuote(text, units, fix.quote);
    if (typeof ids === "string") failed.push({ fix: index, why: ids });
    else located.push({ fix: index, ids });
  });
  const unchanged = (): UnitFixOutcome => ({ text, applied: [], failed: failed.sort((a, b) => a.fix - b.fix), changes: [] });
  if (located.length === 0) return unchanged();

  // 两处落在同一句上：合成一条交给模型，免得同一句给两种改法。
  const targets: { fixes: number[]; ids: number[]; goals: string[] }[] = [];
  for (const item of located) {
    const same = targets.find((target) => item.ids.some((id) => target.ids.includes(id)));
    if (same) {
      same.fixes.push(item.fix);
      for (const id of item.ids) if (!same.ids.includes(id)) same.ids.push(id);
      same.goals.push(fixes[item.fix]!.goal);
    } else {
      targets.push({ fixes: [item.fix], ids: [...item.ids], goals: [fixes[item.fix]!.goal] });
    }
  }
  const allowed = new Set(targets.flatMap((target) => target.ids));
  const prompt = unitFixTask(input.chapter, numberedText(units), targets.map((target) => ({ ids: [...target.ids].sort((a, b) => a - b), goal: target.goals.join("；") })));

  let edits: UnitEdit[] | undefined;
  try {
    edits = parseUnitFixEdits(await input.callModel(prompt), units, allowed);
    if (!edits) edits = parseUnitFixEdits(await input.callModel(prompt), units, allowed);
  } catch (error) {
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
  const applied: number[] = [];
  for (const target of targets) {
    if (target.ids.some((id) => changedIds.has(id))) {
      applied.push(...target.fixes);
      continue;
    }
    const why = target.ids.map((id) => dropped.get(id)).find(Boolean) ?? "AI 没给出这句的改法";
    for (const fix of target.fixes) failed.push({ fix, why });
  }
  return {
    text: result.text,
    applied: applied.sort((a, b) => a - b),
    failed: failed.sort((a, b) => a.fix - b.fix),
    changes: result.applied.map((edit) => ({ from: edit.from, to: edit.to })),
  };
}

export interface DraftUnitFixResult extends UnitFixOutcome {
  /** 真改了：写回的版本号和改前存档点。 */
  readonly draftVersion?: number;
  readonly snapshotId?: string;
}

/**
 * 改工作稿（核账卡「改这处 / 改掉这 N 处」）：读稿 → 改 → 改成了就存档、写回，整段在书锁里
 * （和 revise_draft 一样：修订模型跑着时定稿、撤销排队，不会切进读和写中间）。没有工作稿照实说。
 */
export async function fixDraftByUnits(input: {
  readonly projectDir: string;
  readonly chapter: number;
  readonly fixes: readonly UnitFix[];
  readonly callModel: RevisionModelCaller;
}): Promise<DraftUnitFixResult> {
  const { projectDir, chapter } = input;
  return withBookLock(projectDir, async () => {
    const text = await readFile(defaultDraftPath(projectDir, chapter), "utf-8").catch(() => undefined);
    if (text === undefined || !text.trim()) {
      return { text: text ?? "", applied: [], failed: input.fixes.map((_, fix) => ({ fix, why: "这一章没有工作稿了" })), changes: [] };
    }
    const outcome = await fixByUnits({ chapter, text, fixes: input.fixes, callModel: input.callModel });
    if (outcome.applied.length === 0) return outcome;
    const snapshotId = await snapshotBeforeDraftOverwrite(projectDir, chapter, `第${chapter}章按核账改前快照`);
    await writeAiDraft(projectDir, { chapter, body: outcome.text });
    return { ...outcome, draftVersion: nextDraftVersion(), ...(snapshotId ? { snapshotId } : {}) };
  });
}
