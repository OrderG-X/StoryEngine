/**
 * 出稿后的固定质量环节（2026-10-08 写作主链重设计·阶段 3）：字数不够就接着写够 → 前后核对 → 按核账改一轮再核一遍。
 * 2026-10-10 引擎升级第 3 期：前后核对改用和「核账」按钮同一套服务（editorial/continuity/check-service），
 * 删掉了出稿专用的旧版核对（对照账本 + 上一章结尾，召回 17～25%、误报 35～57%）和没人用的自动改冲突段。
 * 2026-10-23：核出「确定」又错在新稿里的，按核账卡「改这处」同一句要求、同一条改稿路改（P12 起按编号句子一次改齐），改完再核，
 * 留给作者的是改后还剩的（考卷：新稿里确定对不上每千字 2.10 → 0.69）。对的是设定卡的不自动改，交作者定。
 *
 * 编排在工具内一次跑完（确定性顺序），不再靠 agent 跨回合「预览→补字→再预览」接力（十章验收：每章来回 3–4 轮、
 * 补字 40 次、单回合思考 11 万字）。任何一步没成都原稿不动 + 如实说明，绝不影响出稿本身的 ok。
 * 真改了正文：先建快照（可撤销回首稿）再走 draft.write 写盘，两步在同一把书锁里（防与定稿、撤销交错）。
 */
import { countDraftChineseCharacters, draftLengthFloor, type DraftLengthTarget } from "../../writing/draft-length-control.js";
import { type ChapterPlan } from "../../book/chapter-plan.js";
import { quoteInText, withBookLock } from "@actalk/story-core";
import { isDraftConflict, writeAiDraft } from "../../lib/ai-draft-write.js";
import { snapshotBeforeDraftOverwrite } from "../../lib/snapshot-on-draft-overwrite.js";
import { checkChapterBody, type ChapterCheckItem, type ChapterCheckResult } from "../../editorial/continuity/check-service.js";
import type { BrainCallModel } from "../../editorial/index.js";
import { locateRevisionSpan, type RevisionModelCaller } from "../revision-service.js";
import { fixByUnits, recordUnitFixes } from "../unit-fix.js";
import { continuityFixGoal } from "../../../lib/continuity-fix.js";
import { continueDraftToLength, type ContinueCallModel } from "./continue-draft.js";

export interface QualityPipelineInput {
  readonly projectDir: string;
  readonly chapter: number;
  /** 不给 = 写回时沿用盘上的标题（接着写不换标题）。 */
  readonly title?: string;
  readonly draftBody: string;
  /** draftBody 在盘上是哪一版（出稿刚写下的那份的 version）。补写、核账、改的这几分钟里盘上换了就不写回。 */
  readonly baseVersion: string | null;
  readonly lengthTarget: DraftLengthTarget;
  readonly chapterPlan?: ChapterPlan;
  /** 续写（fastDraft 槽）。缺失 = 不补写。 */
  readonly continueCallModel?: ContinueCallModel;
  /** 前后核对（qualityCheck 槽，和「核账」同一套，核账员那一路）。缺失 = 不核对。 */
  readonly checkCallModel?: BrainCallModel;
  /** 按核账改（repair 槽，和核账卡「改这处」同一条路 fixByUnits）。缺失 = 核出来不改、原样交作者。 */
  readonly fixCallModel?: RevisionModelCaller;
  /** true=本出稿流程已有「写盘前」存档点（适配层建），补写重写不再另建（R4.2：一次出稿=操作历史里的一步）。 */
  readonly skipOverwriteSnapshot?: boolean;
  /** 接着往下写（P13）：正文开头这一段是本来就写好的（多半是作者写的），按核账改不碰它；核出的照列给作者。 */
  readonly keepPrefix?: string;
}

export interface QualityPipelineInfo {
  /** 各环节耗时（毫秒）：长篇里「写一章要多久」要看得见，慢在哪一步才能对症。 */
  readonly timings?: { readonly continueMs?: number; readonly continuityMs?: number; readonly fixMs?: number };
  readonly continuation?: { readonly before: number; readonly after: number; readonly rounds: number; readonly failures: readonly string[] };
  readonly continuity?: {
    readonly checked: boolean;
    /** 改完再核还剩的确定 / 可能对不上——留给作者定。 */
    readonly sure: readonly ChapterCheckItem[];
    readonly maybe: readonly ChapterCheckItem[];
    readonly failures: readonly string[];
    /** 冷窗口核账（R4.4）：核账员还没读完全书也照核，对照范围在这里，notes 已如实说明。 */
    readonly coverage?: ChapterCheckResult["coverage"];
    /** 按核账改了几处、几处没改成、连带改了几句说同一件事的（有这项时 sure / maybe 是改完再核的结果）。 */
    readonly autoFixed?: { readonly applied: number; readonly failed: number; readonly also?: number };
  };
}

export interface QualityPipelineResult {
  readonly draftBody: string;
  readonly changed: boolean;
  /** 写回后盘上的版本（changed 时有）。 */
  readonly version?: string;
  /** 盘上那份在这期间被改过（作者存稿、撤销或恢复），这次的改动没写回。 */
  readonly conflict?: boolean;
  readonly snapshotId?: string;
  readonly info: QualityPipelineInfo;
  /** 给作者看的几句话（进 summary）。 */
  readonly notes: readonly string[];
}

export async function runDraftQualityPipeline(input: QualityPipelineInput): Promise<QualityPipelineResult> {
  let body = input.draftBody;
  const notes: string[] = [];
  let info: QualityPipelineInfo = {};

  const timings: { continueMs?: number; continuityMs?: number; fixMs?: number } = {};
  // ① 首稿不到下限就接着写（不在中间插句）。2026-10-10 曾改成只差一点不续（续出的段凭空编对话、矛盾最密），
  // 那时续写的段不再核。现在续写在核账、按核账改之前，续出的错一样被核、被改；不续作者就得为几百字再等一整轮「接着往下写」
  // （2026-10-28 春分面馆：目标 2000 字常出 1500 多，外部审查也点了这条）。
  const firstLength = countDraftChineseCharacters(body);
  // 作者的「至少 N 字」比区间下沿低（floor）时按作者写明的地板判。
  const floor = draftLengthFloor(input.lengthTarget);
  if (input.continueCallModel && firstLength < floor) {
    const startedAt = Date.now();
    const continued = await continueDraftToLength({
      chapter: input.chapter,
      draftBody: body,
      lengthTarget: input.lengthTarget,
      callModel: input.continueCallModel,
      ...(input.chapterPlan ? { chapterPlan: input.chapterPlan } : {}),
    });
    timings.continueMs = Date.now() - startedAt;
    info = { ...info, continuation: { before: continued.before, after: continued.after, rounds: continued.rounds, failures: continued.failures } };
    if (continued.rounds > 0) {
      body = continued.draftBody;
      notes.push(continued.after >= floor
        ? `首稿 ${continued.before} 字低于下限 ${floor}，已接着写到 ${continued.after} 字。`
        : `首稿 ${continued.before} 字低于下限 ${floor}，接着写到 ${continued.after} 字，仍差 ${floor - continued.after} 字。`);
    } else if (continued.failures.length > 0) {
      notes.push(`首稿 ${continued.before} 字低于下限 ${floor}，自动续写没成（${continued.failures.at(-1)}）。`);
    }
  }

  // ② 前后核对：和「核账」按钮同一套（账本对账 + 模型查错 + 核账记忆）。③ 核出「确定」又错在新稿里的按前文改一轮、改完再核。
  // 结果记进核账记忆：作者随后点「核账」，正文没改就直接出这次（改后再核）的结果。
  if (input.checkCallModel && body.trim()) {
    const startedAt = Date.now();
    const first = await checkChapterBody(input.projectDir, input.chapter, body, { readerCallModel: input.checkCallModel });
    let result = first;
    let autoFixed: { readonly applied: number; readonly failed: number; readonly also?: number } | undefined;
    // 接着写：原句有一点落在本来写好的那段里就不改（unit-fix 按整句换，跨了接缝也会动到作者的句子）。
    const kept = (item: ChapterCheckItem): boolean => {
      if (!input.keepPrefix) return false;
      const span = locateRevisionSpan(body, item.quote.trim());
      return typeof span === "string" ? quoteInText(item.quote, input.keepPrefix) : span.start < input.keepPrefix.length;
    };
    const keptCount = first.ok ? first.sure.filter((item) => fixableInDraft(input.chapter, item) && kept(item)).length : 0;
    // 没自动改时把「确定」按出处分开说：新写的 / 本来写好的 / 前文别的章或和设定本对不上的。
    // 只报一个总数时，对话 AI 会把前面本来就有的、别的章的都说成「续写带进来的」。
    const whereSure = (sure: readonly ChapterCheckItem[]): string => {
      if (sure.length === 0) return "";
      const elsewhere = sure.filter((item) => !fixableInDraft(input.chapter, item)).length;
      const prefix = sure.filter((item) => fixableInDraft(input.chapter, item) && kept(item)).length;
      const here = sure.length - elsewhere - prefix;
      const parts = [
        input.keepPrefix ? (here > 0 ? `新写的那段 ${here} 处` : "新写的那段没有") : here > 0 && here < sure.length ? `本章 ${here} 处` : undefined,
        prefix > 0 ? `前面本来写好的那部分 ${prefix} 处` : undefined,
        elsewhere > 0 ? `出在前文别的章或和设定本对不上的 ${elsewhere} 处` : undefined,
      ].filter((part): part is string => part !== undefined);
      const split = parts.length > 1 || input.keepPrefix ? `（${parts.join("，")}）` : elsewhere === sure.length ? "（都出在前文别的章或和设定本对不上）" : "";
      return here > 0 ? `${split}，没自动改` : `${split}，这章不自动改`;
    };
    const targets = first.ok && input.fixCallModel ? first.sure.filter((item) => fixableInDraft(input.chapter, item) && !kept(item)) : [];
    if (input.fixCallModel && targets.length > 0) {
      const fixStartedAt = Date.now();
      // 和核账卡「改掉这 N 处」同一条路：几处一次交修订模型、按编号整句换；没改成的照实计数，正文不动。
      const fixed = await fixByUnits({
        chapter: input.chapter,
        text: body,
        fixes: targets.map((item) => ({ quote: item.quote, goal: continuityFixGoal(input.chapter, item) })),
        callModel: input.fixCallModel,
        ...(input.keepPrefix ? { lockedBefore: input.keepPrefix.length } : {}),
      });
      body = fixed.text;
      await recordUnitFixes(input.projectDir, input.chapter, fixed);
      const applied = fixed.applied.length;
      timings.fixMs = Date.now() - fixStartedAt;
      autoFixed = { applied, failed: targets.length - applied, ...(fixed.alsoChanged > 0 ? { also: fixed.alsoChanged } : {}) };
      if (applied > 0) result = await checkChapterBody(input.projectDir, input.chapter, body, { readerCallModel: input.checkCallModel });
    }
    info = {
      ...info,
      continuity: {
        checked: result.ok,
        sure: result.sure,
        maybe: result.maybe,
        failures: result.failures,
        ...(result.coverage ? { coverage: result.coverage } : {}),
        ...(autoFixed ? { autoFixed } : {}),
      },
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
    notes.push(autoFixed
      ? `前后核对：核出 ${first.sure.length} 处确定和前文对不上，按前文改了 ${autoFixed.applied} 处${autoFixed.also ? `（本章别处说同一件事的 ${autoFixed.also} 句跟着改了）` : ""}${autoFixed.failed > 0 ? `（${autoFixed.failed} 处没改成）` : ""}。${
        autoFixed.applied === 0 ? `都还在，点「核账」看是哪几句。`
          : result.ok ? `改完又核了一遍：${left}` : `改完再核没跑成（${result.failures[0] ?? "原因不明"}），可以点「核账」再核。`
      }${coldNote}`
      : result.ok
        ? result.sure.length + result.maybe.length === 0
          ? `前后核对：没发现和前文对不上的地方。${coldNote}`
          : `前后核对：确定对不上 ${result.sure.length} 处${result.maybe.length > 0 ? `、可能 ${result.maybe.length} 处` : ""}${whereSure(result.sure)}，点「核账」看是哪几句。${coldNote}`
        : `写完那遍核账没跑成（${result.failures[0] ?? "原因不明"}），工作稿没动；可以点「核账」再核。${coldNote}`);
    if (autoFixed && keptCount > 0) notes.push(`前面本来写好的那部分核出 ${keptCount} 处确定对不上，没替你改，点「核账」看是哪几句。`);
    timings.continuityMs = Date.now() - startedAt;
  }
  info = { ...info, timings };
  console.info(
    `[draft-pipeline] ch${input.chapter} 续写 ${Math.round((timings.continueMs ?? 0) / 1000)}s / 核对与修改 ${Math.round((timings.continuityMs ?? 0) / 1000)}s（其中按核账改 ${Math.round((timings.fixMs ?? 0) / 1000)}s）`,
  );

  const changed = body !== input.draftBody;
  if (!changed) return { draftBody: input.draftBody, changed: false, info, notes };
  let snapshotId: string | undefined;
  let version: string;
  try {
    version = await withBookLock(input.projectDir, async () => {
      // 独立跑（如修订后的核对）照旧建覆盖前快照；出稿流程内（有「写盘前」存档点）不另建（R4.2）。
      if (!input.skipOverwriteSnapshot) {
        snapshotId = await snapshotBeforeDraftOverwrite(input.projectDir, input.chapter, `第${input.chapter}章补写与前后核对前快照`);
      }
      const written = await writeAiDraft(input.projectDir, {
        chapter: input.chapter,
        ...(input.title ? { title: input.title } : {}),
        body,
        baseVersion: input.baseVersion,
      });
      return written.version;
    });
  } catch (error) {
    if (!isDraftConflict(error)) throw error;
    return { draftBody: input.draftBody, changed: false, conflict: true, info, notes: [...notes, `上面补写、按核账改的都没写进去：${(error as Error).message}`] };
  }
  return { draftBody: body.trim(), changed: true, version, ...(snapshotId ? { snapshotId } : {}), info, notes };
}

/** 能按前文自动改的：错在新稿里（fixChapter 缺省或就是这章）、对的是前文原文或本章前面。对的是设定卡的不算——错的可能是卡。 */
export function fixableInDraft(chapter: number, item: ChapterCheckItem): boolean {
  return (item.fixChapter === undefined || item.fixChapter === chapter) && !item.againstSetting;
}
