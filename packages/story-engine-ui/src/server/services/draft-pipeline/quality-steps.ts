/**
 * 出稿后的固定质量环节（2026-10-08 写作主链重设计·阶段 3），拆成出稿操作的几步（写作版本 P2a 3.1）：
 * 字数不够就接着写够（extend）→ 前后核对（check）→ 确定错在新稿里的按前文改一轮（fix）→ 改完再核（recheck）。
 * 每一步输入进、输出出，都只在内存里改正文、不写盘：出稿操作最后一步把结果一次换上工作稿，改句记录在那一步一起记。
 *
 * - 前后核对和「核账」按钮同一套（editorial/continuity/check-service），笔记在操作的 notes 那一步补过，这里不再当场补。
 * - 2026-10-23：核出「确定」又错在新稿里的，按核账卡「改这处」同一条改稿路改（P12 起按编号句子一次改齐），改完再核，
 *   留给作者的是改后还剩的（考卷：新稿里确定对不上每千字 2.10 → 0.69）。对的是设定卡的不自动改，交作者定。
 * - 任何一步没成都原稿不动 + 如实说明，绝不影响出稿本身。
 */
import { quoteInText } from "@actalk/story-core";
import { countDraftChineseCharacters, draftLengthFloor, type DraftLengthTarget } from "../../writing/draft-length-control.js";
import type { ChapterPlan } from "../../book/chapter-plan.js";
import { checkChapterBody, type ChapterCheckItem, type ChapterCheckResult } from "../../editorial/continuity/check-service.js";
import type { BrainCallModel } from "../../editorial/index.js";
import type { FixRecord } from "../../lib/fix-log.js";
import { locateRevisionSpan, type RevisionModelCaller } from "../draft-change/revise-text.js";
import { fixByUnits } from "../unit-fix.js";
import { continuityFixGoal } from "../../../lib/continuity-fix.js";
import { continueDraftToLength, type ContinueCallModel } from "./continue-draft.js";

/** 补字数那步的结果（给作者看的一句在 note）。 */
export interface ExtendOutcome {
  readonly draftBody: string;
  readonly changed: boolean;
  readonly continuation?: { readonly before: number; readonly after: number; readonly rounds: number; readonly failures: readonly string[] };
  readonly note?: string;
}

/**
 * 首稿不到下限就接着写（不在中间插句）。2026-10-10 曾改成只差一点不续（续出的段凭空编对话、矛盾最密），那时续写的段不再核。
 * 现在续写在核账、按核账改之前，续出的错一样被核、被改；不续作者就得为几百字再等一整轮「接着往下写」
 * （2026-10-28 春分面馆：目标 2000 字常出 1500 多）。作者的「至少 N 字」比区间下沿低（floor）时按作者写明的地板判。
 */
export async function extendToFloor(input: {
  readonly chapter: number;
  readonly draftBody: string;
  readonly lengthTarget: DraftLengthTarget;
  readonly chapterPlan?: ChapterPlan;
  readonly callModel: ContinueCallModel;
}): Promise<ExtendOutcome> {
  const floor = draftLengthFloor(input.lengthTarget);
  if (countDraftChineseCharacters(input.draftBody) >= floor) return { draftBody: input.draftBody, changed: false };
  const continued = await continueDraftToLength({
    chapter: input.chapter,
    draftBody: input.draftBody,
    lengthTarget: input.lengthTarget,
    callModel: input.callModel,
    ...(input.chapterPlan ? { chapterPlan: input.chapterPlan } : {}),
  });
  const continuation = { before: continued.before, after: continued.after, rounds: continued.rounds, failures: continued.failures };
  if (continued.rounds > 0) {
    return {
      draftBody: continued.draftBody.trim(),
      changed: true,
      continuation,
      note: continued.after >= floor
        ? `首稿 ${continued.before} 字低于下限 ${floor}，已接着写到 ${continued.after} 字。`
        : `首稿 ${continued.before} 字低于下限 ${floor}，接着写到 ${continued.after} 字，仍差 ${floor - continued.after} 字。`,
    };
  }
  return {
    draftBody: input.draftBody,
    changed: false,
    continuation,
    ...(continued.failures.length > 0 ? { note: `首稿 ${continued.before} 字低于下限 ${floor}，自动续写没成（${continued.failures.at(-1)}）。` } : {}),
  };
}

/** 前后核对一遍（和「核账」按钮同一套：账本对账 + 核账员 + 核账记忆）。笔记在 notes 那一步补过，不再当场补。 */
export function checkDraft(input: { readonly projectDir: string; readonly chapter: number; readonly draftBody: string; readonly callModel: BrainCallModel }): Promise<ChapterCheckResult> {
  return checkChapterBody(input.projectDir, input.chapter, input.draftBody, { readerCallModel: input.callModel, notesReady: {} });
}

/** 能按前文自动改的：错在新稿里（fixChapter 缺省或就是这章）、对的是前文原文或本章前面。对的是设定卡的不算——错的可能是卡。 */
export function fixableInDraft(chapter: number, item: ChapterCheckItem): boolean {
  return (item.fixChapter === undefined || item.fixChapter === chapter) && !item.againstSetting;
}

/** 接着写：原句有一点落在本来写好的那段里就不改（unit-fix 按整句换，跨了接缝也会动到作者的句子）。body 是核的那一版。 */
function inKeptPrefix(body: string, keepPrefix: string | undefined, item: ChapterCheckItem): boolean {
  if (!keepPrefix) return false;
  const span = locateRevisionSpan(body, item.quote.trim());
  return typeof span === "string" ? quoteInText(item.quote, keepPrefix) : span.start < keepPrefix.length;
}

/** 按核账改那步的结果：改了几处、换上去的句子（换上时记进改句记录、再核时只核这几句）。 */
export interface FixOutcome {
  readonly draftBody: string;
  readonly changed: boolean;
  /** 要改的处数（错在新稿里、不在本来写好的那段）。 */
  readonly targets: number;
  readonly applied: number;
  readonly also: number;
  readonly changes: readonly FixRecord[];
}

/** 核出「确定」又错在新稿里的，和核账卡「改掉这 N 处」同一条路：几处一次交修订模型、按编号整句换；没改成的照实计数，正文不动。 */
export async function fixSureIssues(input: {
  readonly chapter: number;
  readonly draftBody: string;
  readonly check: ChapterCheckResult;
  readonly callModel: RevisionModelCaller;
  readonly keepPrefix?: string;
}): Promise<FixOutcome> {
  const targets = input.check.ok
    ? input.check.sure.filter((item) => fixableInDraft(input.chapter, item) && !inKeptPrefix(input.draftBody, input.keepPrefix, item))
    : [];
  if (targets.length === 0) return { draftBody: input.draftBody, changed: false, targets: 0, applied: 0, also: 0, changes: [] };
  const fixed = await fixByUnits({
    chapter: input.chapter,
    text: input.draftBody,
    fixes: targets.map((item) => ({ quote: item.quote, goal: continuityFixGoal(input.chapter, item) })),
    callModel: input.callModel,
    ...(input.keepPrefix ? { lockedBefore: input.keepPrefix.length } : {}),
  });
  const draftBody = fixed.text.trim();
  return {
    draftBody,
    changed: draftBody !== input.draftBody,
    targets: targets.length,
    applied: fixed.applied.length,
    also: fixed.alsoChanged,
    changes: fixed.changes,
  };
}

/** 改完再核：只核改过的句子（上一遍整章核全了、前文没变、换得上），否则整章重核（check-service 判）。 */
export function recheckDraft(input: {
  readonly projectDir: string;
  readonly chapter: number;
  readonly draftBody: string;
  readonly changes: readonly FixRecord[];
  readonly callModel: BrainCallModel;
}): Promise<ChapterCheckResult> {
  return checkChapterBody(input.projectDir, input.chapter, input.draftBody, { readerCallModel: input.callModel, afterFix: input.changes, notesReady: {} });
}

export interface ContinuityInfo {
  readonly checked: boolean;
  /** 改完再核还剩的确定 / 可能对不上——留给作者定。 */
  readonly sure: readonly ChapterCheckItem[];
  readonly maybe: readonly ChapterCheckItem[];
  readonly failures: readonly string[];
  /** 冷窗口核账（R4.4）：核账员还没读完全书也照核，对照范围在这里，note 已如实说明。 */
  readonly coverage?: ChapterCheckResult["coverage"];
  /** 按核账改了几处、几处没改成、连带改了几句说同一件事的（有这项时 sure / maybe 是改完再核的结果）。 */
  readonly autoFixed?: { readonly applied: number; readonly failed: number; readonly also?: number };
}

/**
 * 核账那几步合起来给作者的话和结构化结果：first 是首遍，fix / recheck 是按核账改、改完再核（没改就没有）。
 * checkedBody 是首遍核的那一版（接着写时据它判哪几处落在本来写好的那段里）。
 */
export function continuitySummary(input: {
  readonly chapter: number;
  readonly checkedBody: string;
  readonly first: ChapterCheckResult;
  readonly fix?: FixOutcome;
  readonly recheck?: ChapterCheckResult;
  readonly keepPrefix?: string;
}): { readonly info: ContinuityInfo; readonly notes: readonly string[] } {
  const { chapter, first, fix, keepPrefix } = input;
  const result = input.recheck ?? first;
  const kept = (item: ChapterCheckItem): boolean => inKeptPrefix(input.checkedBody, keepPrefix, item);
  const keptCount = first.ok ? first.sure.filter((item) => fixableInDraft(chapter, item) && kept(item)).length : 0;
  const autoFixed = fix && fix.targets > 0 ? { applied: fix.applied, failed: fix.targets - fix.applied, ...(fix.also > 0 ? { also: fix.also } : {}) } : undefined;
  // 没自动改时把「确定」按出处分开说：新写的 / 本来写好的 / 前文别的章或和设定本对不上的。
  // 只报一个总数时，对话 AI 会把前面本来就有的、别的章的都说成「续写带进来的」。
  const whereSure = (sure: readonly ChapterCheckItem[]): string => {
    if (sure.length === 0) return "";
    const elsewhere = sure.filter((item) => !fixableInDraft(chapter, item)).length;
    const prefix = sure.filter((item) => fixableInDraft(chapter, item) && kept(item)).length;
    const here = sure.length - elsewhere - prefix;
    const parts = [
      keepPrefix ? (here > 0 ? `新写的那段 ${here} 处` : "新写的那段没有") : here > 0 && here < sure.length ? `本章 ${here} 处` : undefined,
      prefix > 0 ? `前面本来写好的那部分 ${prefix} 处` : undefined,
      elsewhere > 0 ? `出在前文别的章或和设定本对不上的 ${elsewhere} 处` : undefined,
    ].filter((part): part is string => part !== undefined);
    const split = parts.length > 1 || keepPrefix ? `（${parts.join("，")}）` : elsewhere === sure.length ? "（都出在前文别的章或和设定本对不上）" : "";
    return here > 0 ? `${split}，没自动改` : `${split}，这章不自动改`;
  };
  // 冷窗口（R4.4）：核账员还没读完全书时绝不只说「没发现对不上」——对照范围（已读笔记+第 a～b 章原文+账本）必须跟上。
  const coldNote = result.coverage
    ? `核账员还没读完全书，这次只对照了${
      [
        ...(result.coverage.notedThrough > 0 ? [`已读笔记（到第 ${result.coverage.notedThrough} 章）`] : []),
        ...(result.coverage.rawTo > 0 ? [`第 ${result.coverage.rawFrom}～${result.coverage.rawTo} 章原文`] : []),
        "账本",
      ].join(" + ")
    }，更早的细节可能漏。`
    : "";
  const left = result.sure.length + result.maybe.length === 0
    ? "没发现和前文对不上的地方。"
    : `确定对不上 ${result.sure.length} 处${result.maybe.length > 0 ? `、可能 ${result.maybe.length} 处` : ""}，点「核账」看是哪几句。`;
  const notes: string[] = [autoFixed
    ? `前后核对：核出 ${first.sure.length} 处确定和前文对不上，按前文改了 ${autoFixed.applied} 处${autoFixed.also ? `（本章别处说同一件事的 ${autoFixed.also} 句跟着改了）` : ""}${autoFixed.failed > 0 ? `（${autoFixed.failed} 处没改成）` : ""}。${
      autoFixed.applied === 0 ? `都还在，点「核账」看是哪几句。`
        : result.ok ? `${result.rechecked ? "改完又核了改过的句子" : "改完又核了一遍"}：${left}` : `改完再核没跑成（${result.failures[0] ?? "原因不明"}），可以点「核账」再核。`
    }${coldNote}`
    : result.ok
      ? result.sure.length + result.maybe.length === 0
        ? `前后核对：没发现和前文对不上的地方。${coldNote}`
        : `前后核对：确定对不上 ${result.sure.length} 处${result.maybe.length > 0 ? `、可能 ${result.maybe.length} 处` : ""}${whereSure(result.sure)}，点「核账」看是哪几句。${coldNote}`
      : `写完那遍核账没跑成（${result.failures[0] ?? "原因不明"}），工作稿没动；可以点「核账」再核。${coldNote}`];
  if (autoFixed && keptCount > 0) notes.push(`前面本来写好的那部分核出 ${keptCount} 处确定对不上，没替你改，点「核账」看是哪几句。`);
  return {
    info: {
      checked: result.ok,
      sure: result.sure,
      maybe: result.maybe,
      failures: result.failures,
      ...(result.coverage ? { coverage: result.coverage } : {}),
      ...(autoFixed ? { autoFixed } : {}),
    },
    notes,
  };
}
