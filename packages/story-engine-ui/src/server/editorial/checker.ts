/**
 * 核账员（2026-10-12 编辑部第 1 步）：从第 1 章起一章一章跟读、自己记笔记的连续性编辑。
 *
 * 核第 N 章时，在「读完第 N-1 章」那一刻的窗口后面接上新稿，分三遍（盯东西 / 盯人 / 盯时间与信息）让它先逐条对照、再列矛盾。
 * 提示词来自评测脚本 scripts/eval/run-reader-agent.mjs（那一版在题库上验证过）：改提示词先在题库上比分，别凭感觉改。
 * 比旧核账（临时拼材料判一次）查得全：窗口里是读过的全文和它自己的笔记，不靠检索拼证据。
 *
 * T1 收尾（2026-10-12）加了四个可独立开关的做法（ReaderCheckVariant），在题库上比分后选定默认组合（DEFAULT_READER_VARIANT）：
 * A 自复核（三遍合并后同一窗口再判一轮）、B 时间线表进核账、C 结构化笔记、D「确定」门槛（纯确定性，不调模型）。
 * R2.1（2026-10-12）比分后加了 F 时间线表只进自复核（三遍不带表，A 那一轮带表并写明日子以表为准）进默认组合；
 * 同一轮试过 E 同一底层问题去重（earlierChapter 相同且 earlierQuote 相似只留一条），大考卷查准/查全都掉，比分输了已删（数字见 docs/editorial-room/reports/R2.1-2026-10-12.md）。
 * 2026-10-12 T5 长书：窗口里早期章节被折掉（只剩笔记或卷笔记）时，先问一轮「要核对的地方里有没有要翻前文原文的」，
 * 代码用引擎的 findEarlierPassages 把命中的原句（带章号）贴回窗口再核——笔记会漏会走样，翻回原文才算数。
 */
import { numberedText, splitUnits, type TextUnit } from "@actalk/story-core";
import { describeTimelineForChapter } from "../book/story-timeline.js";
import { modelFailureText } from "../lib/ai-errors.js";
import { readStoryViews } from "../book/story-views.js";
import { findEarlierPassages } from "../writing/earlier-passages.js";
import { MODEL_CALL_MAX_SENDS, resolveConfiguredChatModel, streamChatModelToText } from "../lib/llm-client.js";
import { withStep } from "../lib/token-meter.js";
import { rethrowIfStopped } from "../lib/operations/context.js";
import {
  containsQuote,
  dropLiteralEscapes,
  HEDGE_MAX_COPIES,
  hedged,
  normalize,
  parseFullReadIssues,
  readConfidence,
  readEarlierChapters,
  snapToOriginal,
  splitSentences,
  type ContinuityIssueV2,
  type EarlierText,
} from "./continuity/check-chapter.js";
import type { ChapterPlan } from "../book/chapter-plan.js";
import { cleanSettingQuote, foundationMessage, readFoundationDigest, settingQuoteSource, type FoundationDigest } from "./foundation-digest.js";
import { ensureReaderWindow, buildColdReaderWindow, type BrainCallModel, type BrainMessage, type ColdCoverage, type ReaderRole } from "./reader-window.js";
import { readerWaitingHandlers, type ReaderWaited } from "./reader-progress.js";

export const CHECKER_ROLE: ReaderRole = {
  id: "checker",
  system: [
    "你是这本长篇小说的连续性编辑，从第 1 章起一章一章跟读。",
    "每读完一章，你写一份读书笔记，记下以后核对要用的硬信息。",
    "作者交来新稿时，你对照读过的前文原文和你的笔记，找出新稿里和前文（或和新稿自己更早的位置）对不上的地方。",
  ].join("\n"),
  noteTask: [
    "读完写这一章的笔记（纯文本，800 字以内），只记以后核对要用的硬信息，不复述情节：",
    "- 时间：正文写明的日子、星期、几点到几点；本章开头离上一章结尾隔了多久；约好的日子、期限",
    "- 物件：要紧的东西现在在哪、在谁手里、什么样、写着什么、有几个；本章谁把什么交给了谁、带走了、放回了",
    "- 人物：年龄或能推出年龄的线索、住处、职业、身份、亲属关系、称呼；本章结束时各自在哪",
    "- 信息：谁知道了什么、谁还不知道什么",
    "- 地点：方位、距离、路上用多久、样子",
  ].join("\n"),
  volumeTask: [
    "把上面这些读书笔记缩写成一份卷笔记（纯文本，1500 字以内），按章序保住以后核对要用的硬信息，不复述情节：",
    "- 时间：这几章各自发生在哪天、跨了哪些日子；约好的日子、期限到这几章结束时还剩多少",
    "- 物件：要紧的东西到这几章结束时在哪、在谁手里、样子、写着什么、有几个；中间经过哪些转手",
    "- 人物：年龄、住处、职业、身份、亲属、称呼；谁在这几章里去了哪、知道了什么",
    "- 信息：到这几章结束，谁知道什么、谁还不知道什么",
    "- 地点：方位、距离、路上用多久、样子",
    "同一条信息前后有变化时，记最后的状态，再用半句话带出之前的状态。",
  ].join("\n"),
};

/** C 结构化笔记：笔记按固定小节、一行一条硬信息。提示词变了，旧格式笔记作废（roleHash 变了），这是预期的。 */
export const CHECKER_NOTE_TASK_STRUCTURED = [
  "读完写这一章的笔记（纯文本，900 字以内），按下面的固定小节组织，一行一条硬信息，不复述情节：",
  "【时间】正文写明的日期 / 星期 / 几点到几点；本章开头离上一章结尾隔了多久（写清依据）；约好的日子、期限",
  "【物件】每样要紧的东西一行：物件 | 在哪 / 在谁手里 | 本章变化（谁交给谁、带来带走、放回、用掉）",
  "【人物】每个人一行：人物 | 年龄 / 身份 / 职业 / 住处 / 亲属和称呼 | 本章结束时在哪",
  "【信息】谁知道什么、谁还不知道什么（谁说的、哪一章知道的）",
  "【地点】方位、距离、路上用多久、样子",
].join("\n");

/** C 结构化笔记的角色：id 不变（笔记还在同一目录），noteTask 变了 → roleHash 变了 → 旧笔记自动作废重写。 */
export const CHECKER_ROLE_STRUCTURED: ReaderRole = { ...CHECKER_ROLE, noteTask: CHECKER_NOTE_TASK_STRUCTURED };

/** 按变体取核账员角色（笔记提示词决定 roleHash，也决定旧笔记能不能复用）。 */
export function checkerRoleFor(structuredNotes?: boolean): ReaderRole {
  return structuredNotes ? CHECKER_ROLE_STRUCTURED : CHECKER_ROLE;
}

export type CheckerFocus = "objects" | "people" | "time";

export const CHECKER_FOCUS: Record<CheckerFocus, string> = {
  objects: "这一遍只盯东西：每样物件此刻在哪、在谁手里、什么样、写着什么、有几个；人物身上带的东西是否凭空出现或消失；同一场面里摆设前后是否一致。",
  people: "这一遍只盯人：人物在哪、住在哪、和谁住、身份、年龄、职业、亲属关系、称呼；同一人前后说法是否一致；同一场面里人物的位置和动作前后是否接得上。",
  time: "这一遍只盯时间和信息：几天前、昨天、上周、星期几按前文过了几天算对不对；期限还剩几天；钟点和天色前后接不接得上；路上用时；人物有没有说出按前文还不可能知道的事；把前文发生过的事说成了别的样子。",
};

/** 三遍，各自独立并行；label 用在失败说明里。 */
const CHECKER_PASSES: readonly { readonly focus: CheckerFocus; readonly label: string }[] = [
  { focus: "objects", label: "第 1 遍（盯东西）" },
  { focus: "people", label: "第 2 遍（盯人）" },
  { focus: "time", label: "第 3 遍（盯时间）" },
];

/**
 * reason 是作者在核账卡上读的：笔记里核账员自己记日子用「D+3」这类记号，原样抄进 reason 作者看不懂
 * （换题材长篇实跑 2026-10-27：「林朗说'十来万'是当天（D+3）下午说的」）。
 */
export const REASON_WORDING = "reason 用中文一句话说哪里对不上，是给作者看的：日子说成「第 4 天」「当天」「第二天」，不写笔记里自己用的记号（D+3 之类）";

/** 核账提示：先逐条列出新稿里碰到硬信息的说法并对照前文，再把对不上的列为矛盾，每条带把握（sure / maybe）。 */
export interface DraftSegment {
  /** 第几块（1 起）。 */
  readonly index: number;
  readonly count: number;
  /** 这一块的原文（新稿里原样的一段）。 */
  readonly text: string;
}

/**
 * 新稿按段落切成 count 块、每块字数差不多（只在段与段之间切；一段太长才在句子之间切）：返回切点（第几句之前，0 起），头尾带上。
 * 句子太少（不到每块两句）不切。
 */
function segmentBounds(units: readonly TextUnit[], count: number): readonly number[] {
  if (count <= 1 || units.length < count * 2) return [0, units.length];
  const total = units.reduce((sum, unit) => sum + unit.text.length, 0);
  const target = total / count;
  const slack = target * 0.25;
  const cuts: number[] = [];
  let size = 0;
  /** 上一个段落边界：切在第 index 句之前，到那儿一共 size 字。 */
  let boundary: { readonly index: number; readonly size: number } | undefined;
  units.forEach((unit, index) => {
    size += unit.text.length;
    const next = units[index + 1];
    if (!next || cuts.length >= count - 1) return;
    const goal = target * (cuts.length + 1);
    const atParagraph = next.line !== unit.line;
    if (size >= goal) {
      // 到数了：正好段落结尾就切这儿；上一个段落边界离得不远就切回那儿；都不行、又超出不少才在句子之间切。
      if (atParagraph) cuts.push(index + 1);
      else if (boundary && boundary.index > (cuts.at(-1) ?? 0) && goal - boundary.size <= slack) cuts.push(boundary.index);
      else if (size >= goal + slack) cuts.push(index + 1);
    }
    if (atParagraph) boundary = { index: index + 1, size };
  });
  return [0, ...cuts, units.length];
}

/**
 * 新稿按段落切成 count 块、每块字数差不多（segmentBounds）。
 * 首遍一遍只列 10～16 处说法（作者手写章实测 2026-11-05），整章近百句、细处核不到；分块后每次逐句核一块。
 */
export function draftSegments(body: string, count: number): readonly DraftSegment[] {
  const units = splitUnits(body);
  const bounds = segmentBounds(units, count);
  if (bounds.length <= 2) return [{ index: 1, count: 1, text: body }];
  return bounds.slice(0, -1).map((from, index) => ({
    index: index + 1,
    count: bounds.length - 1,
    text: body.slice(units[from]!.start, units[bounds[index + 1]! - 1]!.end),
  }));
}

/** 「本章前后」那一遍逐句核的一段：第 from～to 句（句子编号，1 起，含两头）。 */
export interface UnitRange {
  readonly index: number;
  readonly count: number;
  readonly from: number;
  readonly to: number;
}

/** 按句编号的分块（和 draftSegments 同一套切法），给「本章前后」那一遍几次各核一段。 */
export function unitRanges(units: readonly TextUnit[], count: number): readonly UnitRange[] {
  const bounds = segmentBounds(units, count);
  return bounds.slice(0, -1).map((from, index) => ({
    index: index + 1,
    count: bounds.length - 1,
    from: units[from]?.id ?? 1,
    to: units[bounds[index + 1]! - 1]?.id ?? 1,
  }));
}

export function checkTask(chapter: number, focus?: CheckerFocus, segment?: DraftSegment): string {
  return [
    `这是作者刚交的第 ${chapter} 章新稿（上面还没给过你）。对照你读过的前文原文和笔记，逐段核对：`,
    "1. 先在 checks 里按顺序列出新稿里每一处碰到硬信息的说法：物件在哪、谁拿着、写着什么、有几个；人物年龄、身份、住处、亲属、称呼；几天前、几点、星期、天色；谁知道什么；方位、距离、路上用时；数目。每条一句：说法要点 → 前文怎么写的 → 对得上 / 对不上。新稿自己前后也要核（同一场面的钟点、物件位置、人物位置）。",
    "2. 对不上的放进 contradictions。写了变化过程的、人物明确在撒谎或记错的、只是补充细节的，不算。本来会变的状态（门开关、灯、值班的人）不同时候不一样也不算。",
    `每条 contradictions：quote 逐字抄有问题、该改的那一句（「改这处」只改它）——两句冲突时，和更早几章一致的那句是对的，不能当 quote；两句都在新稿里，抄和前文各章不一致的那句，前文没写过就抄后出现的那句；earlierQuote 逐字抄前文（或新稿更早处）和它冲突的那一句；earlierChapter 写那句在第几章；${REASON_WORDING}；confidence 写 sure（两处不可能同时成立）或 maybe（看着对不上，但也说得通）。抄不出原文的不要报。`,
    ...(focus ? [`【这一遍的重点】${CHECKER_FOCUS[focus]}`] : []),
    ...(segment && segment.count > 1
      ? [`【这一遍逐句核的一段】新稿分成 ${segment.count} 段，这一遍只逐句核第 ${segment.index} 段（下面原样贴出），别的段当上下文看、不用列：\n${segment.text}`]
      : []),
    "只输出一个 JSON：{\"checks\":[\"...\"],\"contradictions\":[{\"quote\":\"\",\"earlierQuote\":\"\",\"earlierChapter\":1,\"reason\":\"\",\"confidence\":\"sure\"}]}",
  ].join("\n");
}

/**
 * 「本章前后」那一遍（2026-11-06 30 章尺子）：只给这一章、按句编号，找本章自己前后打架的两句，模型点句号、代码取原句。
 * 两本 30 章的书判过的真错里同一章前后打架的占三成（早上已经拿出来、晚上又说还在箱里），核账没报的里头占四成——
 * 三遍带着整本前文读，眼睛都在「和前文对不对」上，本章自己前后反倒看漏。这一遍不带前文窗口、很便宜，候选照样进自复核。
 * 量过的几种（两本书 60 章、判过的同章真错 30 组）：直接交 12 组；先逐句列核对（checks）再交 15 组；再分四块并行、每次逐句核一块 18 组。
 * 开思考抓得最全（24 组），但一章要想 8～12 分钟，不用。
 * range：几次并行、各逐句核一段（整章照样给，当上下文）。
 */
export function innerCheckTask(chapter: number, numbered: string, range?: UnitRange): string {
  return [
    `下面是第 ${chapter} 章新稿，每句前面有编号 [n]。只找这一章自己前后打架的地方：后面某句和本章前面某句说的是同一件事，两处不可能同时成立，中间也没写过变化。`,
    "要核的：东西在哪、在谁手里、什么样、有几个；人在哪、在做什么、穿着拿着什么；钟点、天色、过了多久；谁说过什么、谁已经知道什么；引号里的字说成「几个字」的，数一数对不对。",
    "不算：中间写了变化（拿走了、放回去、换了地方、过了一夜）；说得通的；人物撒谎、记错、改口（正文写明的）；回忆和梦里的；文笔和节奏。",
    "逐句读：每句碰到具体的东西、人、时间、数目，就回本章前面找同一件事核一遍。",
    "1. 先在 checks 里按顺序逐句列：这句碰到的具体东西、人、时间、数目 → 本章前面写同一件事的那句（写编号）怎么说 → 对得上 / 对不上。本章前面没写过的不用列。",
    `2. 对不上的放进 pairs：later 写后面那句的编号，earlier 写本章前面和它打架的那句的编号；${REASON_WORDING}，也不写句子编号；拿不准的 sure 写 false。`,
    '只输出一个 JSON：{"checks":["[12] 箱子在桌上 → [5] 锁进了柜子 → 对不上"],"pairs":[{"later":12,"earlier":5,"reason":"","sure":true}]}。',
    ...(range && range.count > 1 ? [`【这一遍逐句核的】只逐句核第 ${range.from}～${range.to} 句，每句回本章前面找同一件事；别的句子当上下文看，不用列。`] : []),
    "",
    numbered,
  ].join("\n");
}

/** 句子编号宽进：数字、"12"、"[12]" 都收（模型照着正文里的样子抄）；别的写法当没给。 */
function readUnitId(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isInteger(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  // 不猜白名单：自家格式
  const match = /^\s*\[?\s*(\d+)\s*\]?\s*$/u.exec(value);
  return match ? Number(match[1]) : undefined;
}

/**
 * 「本章前后」那一遍的输出：编号对回本章原句（代码取，不让模型抄）。quote＝后面那句（该改的，和三遍「前文没写过就抄后出现的那句」同口径），
 * earlierQuote＝本章更早那句。编号越界、两边同一句的丢掉；模型把先后写反了按编号摆正。
 * 只收它自己说 sure 的（2026-11-06 两本 30 章的书）：它说 sure、自复核也判 sure 的 35 条里真错 27 条；它拿不准的 40 条里真错 7 条，
 * 自复核也分不出来（判 sure 的 18 条里真错 4 条）——进自复核只会多出一堆误报。
 */
export function parseInnerPairs(text: string, chapter: number, draftBody: string): ContinuityIssueV2[] {
  const units = new Map(splitUnits(draftBody).map((unit) => [unit.id, unit.text]));
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  } catch {
    throw new Error("「本章前后」那一遍输出不是 JSON");
  }
  // 宽进：单条直接放在 pairs 下的包成一条，null / "" 当没找到；没写 pairs 或写成别的如实算没跑成，
  // 不当「没发现问题」存进核账记忆（外部审查 2026-11-06）。
  const pairs = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as { pairs?: unknown }).pairs : undefined;
  const raw: unknown[] = Array.isArray(pairs) ? pairs
    : pairs === null || pairs === "" ? []
    : pairs && typeof pairs === "object" ? [pairs]
    : (() => { throw new Error("「本章前后」那一遍没按格式交 pairs"); })();
  const out: ContinuityIssueV2[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const a = readUnitId(record.later);
    const b = readUnitId(record.earlier);
    if (a === undefined || b === undefined || a === b) continue;
    const quote = units.get(Math.max(a, b));
    const earlierQuote = units.get(Math.min(a, b));
    if (!quote || !earlierQuote || readBoolFlag(record.sure) !== true) continue;
    out.push({ quote, earlierQuote, earlierChapter: chapter, reason: String(record.reason ?? "").trim(), kind: "event", confidence: "sure" });
  }
  return out;
}

/**
 * R7.3 第 4 遍（对设定本）的提示：把新稿和前文里碰到设定本写到的硬信息的句子逐句列出，每句判和设定一致不一致。
 * 逐句二元判定（agrees）而不是让模型挑「哪边错」——实测让它挑边会把对的挑成错的（deepseek-flash），
 * 逐句判一致性能判对，谁错由代码按「哪句和设定不一致」推。
 */
export function settingCheckTask(chapter: number): string {
  return [
    `这是作者刚交的第 ${chapter} 章新稿，上面附了这本书的设定本（作者定的硬设定）。这一遍只对设定本，不看别的：`,
    "把新稿和前文各章里、写到设定本也写到的那些硬信息（年龄、亲属、去世时间、身体特征、物件归属、地点方位、世界规则等）的原句逐句列出，每句判它和设定一致不一致：",
    `- quote 逐字抄那一句原句；quoteChapter 写它在第几章（新稿里的句子写 ${chapter}）；`,
    "- settingQuote 逐字抄设定本里写这件事的那句原文；",
    "- agrees：那句和设定本一致写 true，对不上写 false；",
    "- reason 用中文一句话说它和设定说什么、一致还是对不上；confidence 写 sure（那句和设定不可能同时成立）或 maybe。",
    "写了变化过程的、人物明确在撒谎或记错的，不算对不上。设定原文抄不出（和上面设定本逐字对不上）的不要列。只列和设定本写到的同一件事直接相关的句子，最多 12 句。",
    '只输出一个 JSON：{"checks":[{"quote":"","quoteChapter":0,"settingQuote":"","agrees":true,"reason":"","confidence":"maybe"}]}',
  ].join("\n");
}

/** T1 的四个做法 + R2.1 的 F，各自独立开关（评测用 --variant=a,b,c,d,f 组合着比分，产品默认见 DEFAULT_READER_VARIANT）。 */
export interface ReaderCheckVariant {
  /** A 自复核：三遍合并后，在同一窗口里把候选逐条再判一轮（sure / maybe / no），no 的删掉、把握以复核为准。 */
  readonly selfReview?: boolean;
  /** B 时间线表进核账：核账提示附上引擎排好的故事时间线（日子以表为准，不要自己推算）。 */
  readonly timeline?: boolean;
  /** C 结构化笔记：读书笔记按固定小节写（笔记提示词变了，旧笔记作废是预期的）。 */
  readonly structuredNotes?: boolean;
  /** D「确定」门槛：两句原文都逐字抄对、且（跨章，或同章但两句相隔超过 3 句）才允许保留 sure，其余降成 maybe。不调模型。 */
  readonly sureGate?: boolean;
  /** F 时间线表只进自复核：三遍核账不附时间线表（B 对三遍的效果关掉），只在 A 自复核那一轮附表并写明「日子以表为准，不要自己推算」。要 selfReview 开着才有那一轮。 */
  readonly timelineInReview?: boolean;
  /** G 每遍核几次（缺省 1）：几次各逐句核新稿的一块（按段落切成这么多块，draftSegments），合并去重。 */
  readonly passRepeats?: number;
  /** 改后只核改过的句子时并行几次（缺省同 passRepeats）。 */
  readonly recheckRepeats?: number;
  /** H「本章前后」那一遍并行几次（innerCheckTask；缺省 0 = 不跑）：只给这一章、按句编号，几次各逐句核一段，找本章自己前后打架的，和三遍并行，候选一起进自复核。 */
  readonly innerRepeats?: number;
}

/** D 同章的两句至少相隔几句才可能算「确定」：同一个节拍里的两个说法（比如门开着又关上）常被误读成矛盾。 */
export const SURE_GATE_MIN_SENTENCE_GAP = 3;

/**
 * 产品核账缺省用的组合：A 自复核 + F 时间线只进自复核 + G 每遍核两次。
 * A 是 T1.1 题库比分选出来的；F 是 R2.1 比分赢的（「确定」查准下限 46.1→47.2、查全 33.9→35.5、小考题误报 0/1/1→0/0/0，
 * 差距和口径见 docs/editorial-room/reports/R2.1-2026-10-12.md）。
 * G（2026-10-24 重构后重考）：大考卷查全 57.1/60.7%→67.9%、「确定」查全 48.8/50.0%→59.9%，「确定」查准下限 47.8/48.6%→50.3%；
 * 两次调用并行，单章单独核用时不变（约 40～80 秒），多花的是 token（输入多半走缓存）。
 * G 加到四次（外部审查 2026-10-28）：改后改成只核改过的句子，老做法「改后整章再核一遍」顺带抽中的首遍漏错就没了
 * （改后重核考卷 16 章 57 处标注：首遍抓到 34，并上整章再核 44，并上只核改过的 36）。首遍每遍核四次补回来：同一批章首遍
 * 自己就抓到 46（「确定」33→40，查准下限 37%→40%）——而且是在按核账改之前抓到、跟着一起改掉，不是改完才摆在卡上。四次并行，多等的是排队，不是再核一整遍。
 * 改后只核改过的那一遍照旧两次（recheckRepeats）。
 * 四次各核一块（2026-11-05）：原来四次都核整章，一次只列 10～16 处说法，近百句的章细处总核不到。作者手写第 9 章 8 份
 * （Claude 子代理两人各找一遍 + 盲判定出 49 处真错）：「确定、错在本章」查全 55%（只改了相对日子那条）→ 两次 67%、71%，
 * 去掉「小处也别跳过」那句后 76%，「确定」里真错占比不掉（73%）。AI 写的章（考卷 16 章）没多抓到真错，「不是」的多了约
 * 每章一条（27→46 条），数字见 docs/rebuild/reports/作者写的章核账查全-2026-11-05.md。
 * checkChapterByReader 自己缺省全关（第 1 步原样，单测和评测各自显式传），只有走核账服务的产品路才带这个组合。
 * H 本章前后（2026-11-06）：两本 30 章的书（现在 main / 0.4.1 各写第 9～38 章、共 60 章）上单独跑这一遍、再过自复核，
 * 多出「确定」35 条：真错 27、不是 6、拿不准 2（「确定」里真错约 77%，和原来三遍的差不多）；「可能」多 6 条（真错 1）。
 * 定稿里还留着、盲找盲判出的同一章前后打架真错 30 组，定稿前核账只报过 4 组（「确定」1 组）；这一遍以「确定」抓到 13 组，另外还抓到 13 处盲找漏了的。
 * 四次并行，每次不带前文、只给这一章，几十秒，和三遍一起跑不多等。数字见 docs/rebuild/reports/核账本章前后-2026-11-06.md。
 */
export const DEFAULT_READER_VARIANT: ReaderCheckVariant = { selfReview: true, timelineInReview: true, passRepeats: 4, recheckRepeats: 2, innerRepeats: 4 };

/** 核账员（含跟读笔记、卷笔记）一次调用最多几次占额度的发送：对冲份数 × 每份（主 + 备用）。写作版本 P2a 4.5。 */
export const READER_CALL_MAX_SENDS = HEDGE_MAX_COPIES * MODEL_CALL_MAX_SENDS;

/** 整章核一次最多几次核账员调用：翻原文 1 + 对设定本 1 + 三遍 × 每遍次数 + 本章前后几次 + 自复核 1（额度按它算）。 */
export function readerCheckCalls(variant: ReaderCheckVariant): number {
  return 1 + 1 + CHECKER_PASSES.length * Math.max(1, variant.passRepeats ?? 1) + Math.max(0, variant.innerRepeats ?? 0) + (variant.selfReview ? 1 : 0);
}

/** 只核改过的句子一次最多几次：翻原文 1 + 并行次数 + 自复核 1。 */
export function readerRecheckCalls(variant: ReaderCheckVariant): number {
  return 1 + Math.max(1, variant.recheckRepeats ?? variant.passRepeats ?? 1) + (variant.selfReview ? 1 : 0);
}

/** 翻原文那一轮的问法：窗口里有看不到原文的章（折叠只剩笔记，或冷窗口没给到）时，问它要翻哪些词的前文原文。 */
export function keywordTask(chapter: number, cold = false): string {
  return [
    `这是作者刚交的第 ${chapter} 章新稿。${cold ? "你还没读完全书：更早的章节这次只有笔记或什么都没给你，看不到原文。" : "前面的章节你只留下了笔记、看不到原文。"}`,
    "要核对的地方里，有没有需要翻前文原文的？列关键词（最多 5 个）：人名、称呼、物件名、地点，以及新稿里写样子、颜色、材质、数目、方位的词——这类细节最容易和前文对不上。前文原文会按关键词检给你。都装得下就不用翻。",
    "只输出一个 JSON：{\"keywords\":[\"…\"]}",
  ].join("\n");
}

/** 关键词那一轮最多翻几个词、每个词最多带几段原文。 */
const KEYWORD_LIMIT = 5;
/** 模型常把关键词写成带空格的短语（「某地名 外墙 颜色」），按词面检索会整串落空——拆开再查，最多这么多词。 */
const TERM_LIMIT = 8;
const PASSAGES_PER_TERM = 5;
const PASSAGES_TOTAL = 25;

/** 从模型回复里抠关键词：JSON 里 keywords 数组、每条去空格、太短的不要，最多 KEYWORD_LIMIT 个。抠不出来当没词。 */
export function parseKeywords(text: string): string[] {
  try {
    const parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as { keywords?: unknown };
    const list = Array.isArray(parsed.keywords) ? parsed.keywords : [];
    return [...new Set(list.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter((item) => item.length >= 2))].slice(0, KEYWORD_LIMIT);
  } catch {
    // 不是 JSON / 没有 keywords → 当没词（不翻原文，照常核）
    return [];
  }
}

/** 贴回窗口的原文消息：带章号、按章排；一条没翻到也说清楚。 */
function passagesMessage(passages: readonly { readonly chapter: number; readonly term: string; readonly text: string }[]): string {
  if (passages.length === 0) return "【翻到的原文】\n没按关键词翻到前文原句，就按你读过的笔记核。";
  const lines = [...passages]
    .sort((a, b) => a.chapter - b.chapter)
    .map((passage) => `第 ${passage.chapter} 章（${passage.term}）：${passage.text}`);
  return `【翻到的原文】\n${lines.join("\n")}`;
}

/**
 * 核账员 / 跟读用的模型调用（qualityCheck 槽）：关思考、低随机性、流式。
 * 不传 max_tokens，不设总时长上限（超时铁律）：只有「光想不写」超过 maxThinkingMs 和输出超过 maxContentChars 两道闸，
 * 外面套对冲（一次调用迟迟不回就并行再发一份，谁先回来用谁、掐掉另一份）。空内容由调用层按「产物不能用」抛，不当成没问题。
 */
export const callConfiguredBrainModel: BrainCallModel = (messages, options) => {
  const once = async (signal: AbortSignal) => {
    const resolved = await resolveConfiguredChatModel("qualityCheck");
    const { content } = await streamChatModelToText({
      configured: { ...resolved, thinking: false },
      messages: messages.map((message) => ({ role: message.role, content: message.content })),
      temperature: 0.1,
      ...(options.json ? { responseFormat: { type: "json_object" as const } } : {}),
      maxThinkingMs: 180_000,
      maxContentChars: 60_000,
      signal,
    });
    return content;
  };
  return hedged(once, 120_000);
};

/** A 自复核的提示：把三遍合并后的候选逐条列出（本章那句、另一侧那句、理由），让它再判一轮。
 *  R7.3 有设定本时多要三个字段：设定原句（settingQuote）＋两句各自和设定一致不一致（draftAgrees / earlierAgrees）。 */
export function selfReviewTask(chapter: number, issues: readonly ContinuityIssueV2[], withSetting = false): string {
  return [
    `上面是作者刚交的第 ${chapter} 章新稿，你刚才核完报了下面这些对不上的地方（有的是上一稿报过的，作者改过稿，一律按现在这稿判）。逐条复核一遍：`,
    ...issues.map((issue, index) => [
      `【K${index + 1}】${issue.fixChapter && issue.fixChapter !== chapter ? `第 ${issue.fixChapter} 章` : "本章"}那句：${issue.quote}`,
      `  ${
        issue.againstSetting
          ? `设定本（${issue.againstSetting.label}）`
          : issue.earlierChapter === chapter ? "本章更早处" : `第 ${issue.earlierChapter} 章`
      }那句：${issue.earlierQuote}`,
      `  当时的理由：${issue.reason}`,
    ].join("\n")),
    "每条给一个判断：",
    "sure＝确定是矛盾：同一件事、同一样东西、同一个人，两处说法不可能同时成立，文中也没交代变化过程；设定本（作者定的硬设定）和正文对不上也算；",
    "maybe＝可能是：看着对不上，但也说得通（时间没写清、可能是两样东西、中间可能发生了没写的事）；",
    "no＝不是：说的明显不是同一件事或同一时刻（比如前后其实换了一天、换了一个人、换了一样东西），或文中明写了变化，或人物在撒谎记错。",
    ...(withSetting
      ? [
        "另外每条查一下设定本（上面消息里那份）：两边说法不一（年数、归属、方位、身份各说各的）时，设定本多半写到了这件事，按条目查（人物卡：年龄、亲属、去世时间、身体特征；地点：方位；资产：归属；世界规则）。写到的话，",
        "- settingQuote 逐字抄设定本里写这件事的那句原文（没写就留空，别自己编）；",
        "- draftAgrees：本章那句和设定本一致写 true，对不上写 false；",
        "- earlierAgrees：另一侧那句和设定本一致写 true，对不上写 false；",
        "设定本没写到的，这三个字段都留空。",
      ]
      : []),
    `拿不准就给 maybe，不要轻易给 no。只输出一个 JSON：{"verdicts":[{"id":"K1","verdict":"sure"${
      withSetting ? ',"settingQuote":"","draftAgrees":true,"earlierAgrees":true' : ""
    }]}，每条都要给。`,
  ].join("\n\n");
}

/** A 自复核一条的判断：verdict（K1 → sure / maybe / no）＋ R7.3 的设定裁定（可缺省）。 */
export interface ReviewVerdict {
  readonly verdict: "sure" | "maybe" | "no";
  /** 设定本里写这件事的原句（模型抄的，收之前由代码核对真在设定本里）。 */
  readonly settingQuote?: string;
  /** 本章那句和设定一致吗：false＝对不上；undefined＝设定没写到 / 没判。 */
  readonly draftAgrees?: boolean;
  /** 另一侧那句和设定一致吗：false＝对不上；undefined＝设定没写到 / 没判。 */
  readonly earlierAgrees?: boolean;
}

/** R7 修复口径：布尔/枚举字段只认 schema 里的英文写法（false/no/f），不猜中文说法——模型真写了中文就当「没判」放过，不误报。 */
const agreesFalse = (value: unknown): boolean => value === false || /^(?:false|no|f)$/iu.test(String(value ?? "").trim());

/** 解析复核判断：K1 → verdict＋设定裁定。解析不了返回空表，按原把握保留。 */
export function parseVerdicts(text: string): Map<string, ReviewVerdict> {
  const out = new Map<string, ReviewVerdict>();
  try {
    const parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as { verdicts?: unknown };
    for (const item of Array.isArray(parsed.verdicts) ? parsed.verdicts : []) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const id = String(record.id ?? "").trim().toUpperCase();
      const verdict = String(record.verdict ?? record.real ?? "").trim().toLowerCase();
      if (!id) continue;
      const settingQuote = typeof record.settingQuote === "string" && record.settingQuote.trim() ? record.settingQuote.trim() : undefined;
      const hasDraft = record.draftAgrees !== undefined;
      const hasEarlier = record.earlierAgrees !== undefined;
      const judged: ReviewVerdict["verdict"] = /^(?:no|false)$/u.test(verdict)
        ? "no"
        : /^(?:sure|true)$/u.test(verdict)
          ? "sure"
          : "maybe";
      out.set(id, {
        verdict: judged,
        ...(settingQuote ? { settingQuote } : {}),
        ...(hasDraft ? { draftAgrees: !agreesFalse(record.draftAgrees) } : {}),
        ...(hasEarlier ? { earlierAgrees: !agreesFalse(record.earlierAgrees) } : {}),
      });
    }
  } catch {
    // 解析不了：一条判断都取不到，调用方按原把握保留并如实记失败
  }
  return out;
}

/**
 * D「确定」门槛（纯确定性，不调模型）：两句原文都逐字抄对（去空白后逐字含于原文，比 parseFullReadIssues 的
 * 模糊核对更严），且 earlierChapter 不等于本章（同章则要求两句相隔超过 N 句），才允许保留 sure，其余降成 maybe。
 * 同一个小节拍里的两个说法（门开着又关上、人进来又出去）最容易被误读成矛盾，离得远的才是真对不上。
 */
export function applySureGate(
  issues: readonly ContinuityIssueV2[],
  chapter: number,
  draftBody: string,
  earlier: EarlierText,
  minGap: number = SURE_GATE_MIN_SENTENCE_GAP,
): ContinuityIssueV2[] {
  const body = normalize(draftBody);
  const earlierByChapter = new Map(earlier.chapters.map((item) => [item.chapter, normalize(item.sentences.join(""))]));
  const sentences = splitSentences(draftBody).map(normalize);
  /** 这句原文（去空白）在正文第几句：取它的前 12 个字找。找不到返回 -1（同章的就算不过门槛）。 */
  const locate = (target: string): number => sentences.findIndex((sentence) => sentence.includes(target.slice(0, Math.min(target.length, 12))));
  return issues.map((issue) => {
    if (issue.confidence !== "sure") return issue;
    // 对设定本的条目有自己的核对（设定原文对设定本、quote 对它所在的那一章），不走这道闸。
    if (issue.againstSetting) return issue;
    const quote = normalize(issue.quote);
    const earlierQuote = normalize(issue.earlierQuote);
    // 1. 两句原文都逐字抄对（本章那句在正文里、前文那句在它标的那一章里）
    const source = issue.earlierChapter === chapter ? body : earlierByChapter.get(issue.earlierChapter);
    if (quote.length < 4 || !body.includes(quote) || !source || !earlierQuote || !source.includes(earlierQuote)) {
      return { ...issue, confidence: "maybe" as const };
    }
    // 2. 跨章的可以；同章的要两句离得够远
    if (issue.earlierChapter !== chapter) return issue;
    const here = locate(quote);
    const there = locate(earlierQuote);
    if (here < 0 || there < 0 || Math.abs(here - there) <= minGap) return { ...issue, confidence: "maybe" as const };
    return issue;
  });
}

/**
 * 三遍合并：一条的原句包含另一条的算同一条，留先出现的；同一句一遍判 sure、一遍判 maybe 取 sure。
 * 本章自己前后打架的，两条把同一对句子抄反了（这条的 quote 是那条的 earlierQuote、反过来也是）也算同一条。
 */
function mergePasses(passes: readonly (readonly ContinuityIssueV2[])[], chapter: number): ContinuityIssueV2[] {
  const overlaps = (a: string, b: string): boolean => { const x = normalize(a); const y = normalize(b); return x.includes(y) || y.includes(x); };
  const merged: ContinuityIssueV2[] = [];
  for (const issue of passes.flat()) {
    const inner = issue.earlierChapter === chapter && !issue.againstSetting;
    const index = merged.findIndex((other) => overlaps(other.quote, issue.quote)
      || (inner && other.earlierChapter === chapter && !other.againstSetting && overlaps(other.quote, issue.earlierQuote) && overlaps(other.earlierQuote, issue.quote)));
    if (index < 0) merged.push(issue);
    else if (issue.confidence === "sure" && merged[index]!.confidence !== "sure") merged[index] = { ...merged[index]!, confidence: "sure" };
  }
  return merged;
}

const sentencesOf = (earlier: EarlierText, chapter: number): readonly string[] =>
  earlier.chapters.find((item) => item.chapter === chapter)?.sentences ?? [];

/**
 * R7.3 解析对设定本的矛盾（模型输出里带 settingQuote 的条目）：
 * - 新稿和设定对不上：quote 在新稿里 → earlierChapter＝本章，按钮改本章；
 * - 新稿和设定一致、前文某章和设定对不上：quote 在前文那章 → fixChapter＝那章（问题指向前文那章，
 *   「第 3 章和人物卡不一致」，按钮也改那章，别让作者把对的改成错的）。
 * 设定原文必须按 containsQuote 口径真在设定本里、quote 必须真在新稿或某章前文里，抄不出的丢掉；收下的 quote 对回那章的整句。
 * 填了 earlierQuote 的条目走老路（parseFullReadIssues），这里只收「对照设定本」的。
 */
export function parseSettingIssues(
  text: string,
  chapter: number,
  draftBody: string,
  earlier: EarlierText,
  digest: FoundationDigest,
): ContinuityIssueV2[] {
  let parsed: { contradictions?: unknown };
  try {
    parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as { contradictions?: unknown };
  } catch {
    return [];
  }
  const body = normalize(draftBody);
  const draft = splitSentences(draftBody);
  const byChapter = new Map(earlier.chapters.map((item) => [item.chapter, normalize(item.sentences.join(""))]));
  const out: ContinuityIssueV2[] = [];
  for (const item of Array.isArray(parsed.contradictions) ? parsed.contradictions : []) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (String(record.earlierQuote ?? "").trim()) continue;
    const settingQuote = cleanSettingQuote(digest, String(record.settingQuote ?? ""));
    const quote = dropLiteralEscapes(String(record.quote ?? "")).trim();
    const reason = String(record.reason ?? "").trim();
    if (!settingQuote || !quote || !reason) continue;
    const source = settingQuoteSource(digest, settingQuote);
    if (!source) continue; // 设定原文和设定本对不上：不收
    const confidence = readConfidence(record);
    if (containsQuote(body, quote)) {
      out.push({ quote: snapToOriginal(draft, quote), earlierQuote: settingQuote, earlierChapter: chapter, reason, kind: "event", confidence, againstSetting: source });
      continue;
    }
    // quote 在前文哪一章：先信它报的 quoteChapter，对不上按章序搜。
    const claimed = Number(record.quoteChapter);
    const inClaimed = Number.isInteger(claimed) && byChapter.has(claimed) && containsQuote(byChapter.get(claimed)!, quote);
    const found = inClaimed
      ? claimed
      : [...byChapter.keys()].sort((a, b) => a - b).find((key) => containsQuote(byChapter.get(key)!, quote));
    if (found === undefined) continue;
    out.push({ quote: snapToOriginal(sentencesOf(earlier, found), quote), earlierQuote: settingQuote, earlierChapter: found, fixChapter: found, reason, kind: "event", confidence, againstSetting: source });
  }
  return out;
}

/** 第 4 遍 agrees 判定里「对不上」的写法：只认明确的 false / no / f，其余（true / 没写 / 中文说法）都当一致——宁可放过不误报。 */
const AGREES_FALSE = /^(?:false|no|f)$/iu;

/**
 * R7.3 解析第 4 遍（对设定本）的逐句判定：checks 里每条＝一句正文原句＋设定原句＋agrees。
 * 只收 agrees=false 的（和设定对不上的那句）；quote 定位到新稿（→ 指向本章）或前文某章（→ fixChapter 指向那章）。
 * 设定原文必须真在设定本里（settingQuoteSource），quote 必须真在新稿或某章前文里；对不上的才收。
 */
export function parseSettingChecks(
  text: string,
  chapter: number,
  draftBody: string,
  earlier: EarlierText,
  digest: FoundationDigest,
): ContinuityIssueV2[] {
  let parsed: { checks?: unknown };
  try {
    parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as { checks?: unknown };
  } catch {
    return [];
  }
  const body = normalize(draftBody);
  const draft = splitSentences(draftBody);
  const byChapter = new Map(earlier.chapters.map((item) => [item.chapter, normalize(item.sentences.join(""))]));
  const out: ContinuityIssueV2[] = [];
  for (const item of Array.isArray(parsed.checks) ? parsed.checks : []) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (!AGREES_FALSE.test(String(record.agrees ?? "").trim())) continue;
    const settingQuote = cleanSettingQuote(digest, String(record.settingQuote ?? ""));
    const quote = dropLiteralEscapes(String(record.quote ?? "")).trim();
    const reason = String(record.reason ?? "").trim();
    if (!settingQuote || !quote || !reason) continue; // 对不上与否只认结构化的 agrees，不再看理由里的字眼
    const source = settingQuoteSource(digest, settingQuote);
    if (!source) continue; // 设定原文和设定本对不上：不收
    const confidence = /sure/u.test(String(record.confidence ?? "")) && !/unsure/u.test(String(record.confidence ?? "")) ? "sure" as const : "maybe" as const;
    if (containsQuote(body, quote)) {
      out.push({ quote: snapToOriginal(draft, quote), earlierQuote: settingQuote, earlierChapter: chapter, reason, kind: "event", confidence, againstSetting: source });
      continue;
    }
    const claimed = Number(record.quoteChapter);
    const inClaimed = Number.isInteger(claimed) && byChapter.has(claimed) && containsQuote(byChapter.get(claimed)!, quote);
    const found = inClaimed
      ? claimed
      : [...byChapter.keys()].sort((a, b) => a - b).find((key) => containsQuote(byChapter.get(key)!, quote));
    if (found === undefined) continue;
    out.push({ quote: snapToOriginal(sentencesOf(earlier, found), quote), earlierQuote: settingQuote, earlierChapter: found, fixChapter: found, reason, kind: "event", confidence, againstSetting: source });
  }
  return out;
}

/** 两句是不是同一句（互相包含，或按 containsQuote 的宽口径对得上）——设定裁定的比对用。 */
function sameSettingText(a: string, b: string): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  if (na.length < 4 || nb.length < 4) return false;
  return na.includes(nb) || nb.includes(na) || containsQuote(na, b) || containsQuote(nb, a);
}

/**
 * R7.3 确定性裁定（不调模型）：某条「本章 vs 前文」的正常条目，如果它的前文那句已经被第 4 遍裁定
 * 「和设定本对不上」（存在 fixChapter 指向那章、原句对得上的设定条目），而本章这句没被设定标错
 * ——说明本章那句其实和设定一致、错的是前文那章，这条的矛头指错了方向（按钮会让人把对的改成错的），
 * 收掉不报；那条设定条目（指向前文那章）已经在管这件事。本章这句也被设定标错的（两边都错）照旧两条都报。
 */
export function dropMisdirectedBySetting(issues: readonly ContinuityIssueV2[]): ContinuityIssueV2[] {
  const settingIssues = issues.filter((issue) => issue.againstSetting);
  if (settingIssues.length === 0) return [...issues];
  const draftFlagged = (quote: string): boolean =>
    settingIssues.some((setting) => setting.fixChapter === undefined && sameSettingText(setting.quote, quote));
  return issues.filter((issue) => {
    if (issue.againstSetting) return true;
    const earlierAdjudicated = settingIssues.some((setting) =>
      setting.fixChapter === issue.earlierChapter && sameSettingText(setting.quote, issue.earlierQuote));
    return !(earlierAdjudicated && !draftFlagged(issue.quote));
  });
}

export interface ReaderCheckResult {
  /** 带 confidence。 */
  readonly issues: ContinuityIssueV2[];
  /** 没跑成的步骤（如实说明）。三遍全失败才算这次没核成。 */
  readonly failures: string[];
  /** 冷窗口＝核账员还没读完全书（笔记要补的太多，后台在补），这次对照的是已有笔记 + 最近 K 章原文；
   *  cold 说清范围，回执文字据此如实说「更早的细节可能漏」。R4.4 起不再跳过。 */
  readonly cold?: ColdCoverage;
  /** 这次先当场补了笔记（R5.2＋R6.1）：等完笔记多了第 from～to 章（谁补的都算）、花了 ms 毫秒——回执据此加「这次先等核账员读完…再核」。 */
  readonly waited?: ReaderWaited;
}

/**
 * 翻原文那一轮：问关键词、把命中的前文原句找回来。返回贴回用的原文段（三遍各带一份，放在新稿后面、
 * 核账提示前面——离要判的话最近，模型不容易看漏）。这一轮失败不拦着核：如实记一笔失败、按原窗口照核。
 */
async function lookupEarlierPassages(input: {
  readonly projectDir: string;
  readonly chapter: number;
  readonly draftBody: string;
  readonly window: readonly BrainMessage[];
  readonly callModel: BrainCallModel;
  /** 冷窗口口径：问法如实说「还没读完全书」，不说「只留下了笔记」。 */
  readonly cold?: boolean;
}): Promise<{ readonly prefix: readonly BrainMessage[]; readonly passages?: string; readonly failure?: string }> {
  const ask: BrainMessage = { role: "user", content: `【新稿：第 ${input.chapter} 章】\n${input.draftBody}\n\n${keywordTask(input.chapter, input.cold === true)}` };
  try {
    const reply = (await input.callModel([...input.window, ask], { json: true })).trim();
    const keywords = parseKeywords(reply);
    if (keywords.length === 0) return { prefix: input.window };
    // 关键词可能带修饰（「周屿父 城东」）或写成短语：拆成单词再检索，防整串落空。
    // 不猜白名单：切句
    const terms = [...new Set(keywords.flatMap((keyword) => keyword.split(/[\s,，、/／|]+/u)).filter((term) => term.length >= 2))].slice(0, TERM_LIMIT);
    if (terms.length === 0) return { prefix: input.window };
    const passages = await findEarlierPassages({
      projectDir: input.projectDir,
      chapter: input.chapter,
      terms,
      maxPerTerm: PASSAGES_PER_TERM,
      maxTotal: PASSAGES_TOTAL,
    });
    return { prefix: [...input.window, ask, { role: "assistant", content: reply }], passages: passagesMessage(passages) };
  } catch (error) {
    rethrowIfStopped(error);
    const message = modelFailureText(error);
    return { prefix: input.window, failure: `翻原文那一轮没跑成（${message}），这次只按窗口核` };
  }
}

/** 核账员核一章的输入（核整章、改后只核改过的句子两条路共用）。 */
interface ReaderCheckInput {
  readonly projectDir: string;
  readonly chapter: number;
  readonly draftBody: string;
  readonly callModel: BrainCallModel;
  readonly notesRoot?: string;
  readonly maxCatchUp?: number;
  /** 这次最多新生成几个卷节点（见 ensureReaderWindow）；到了走冷窗口。 */
  readonly maxVolumeBuilds?: number;
  /** 窗口字数预算；缺省 READER_WINDOW_MAX_CHARS（测试用小值，好让折叠和翻原文真的发生）。 */
  readonly maxChars?: number;
  /** 前面各章原文（核账服务已读过就传进来，省得再读一遍）；缺省从书目录读。 */
  readonly earlier?: EarlierText;
  /** T1 的四个做法（A 自复核 / B 时间线 / C 结构化笔记 / D 确定门槛）；缺省全关＝第 1 步的原样。产品默认见 DEFAULT_READER_VARIANT。 */
  readonly variant?: ReaderCheckVariant;
  /**
   * 前文笔记已经在前一步补过（写作版本 P2a inspect.run 的 notes 步，额度分开算）：这里不再当场补（缺了就照冷窗口核），
   * 等读那一句按那一步的 waited 说。
   */
  readonly notesReady?: { readonly waited?: ReaderWaited };
}

/** 核之前备好的：读完前文的窗口（翻过原文的接在后面）、新稿那条消息（三遍用 / 自复核用）、设定本、前文原文。 */
interface ReaderCheckSetup {
  readonly prefix: readonly BrainMessage[];
  readonly draftMessage: string;
  readonly reviewMessage: string;
  readonly earlier: EarlierText;
  readonly foundation?: FoundationDigest;
  readonly failures: readonly string[];
  readonly cold?: ColdCoverage;
  readonly waited?: ReaderWaited;
}

/** 先确保读完前文（缺的笔记补上，补不完走冷窗口），再备好新稿那条消息。读前文没成返回 failure（这次没核成）。 */
async function prepareReaderCheck(input: ReaderCheckInput): Promise<ReaderCheckSetup | { readonly failure: string }> {
  const variant = input.variant ?? {};
  const role = checkerRoleFor(variant.structuredNotes);
  let window: BrainMessage[];
  let foldedChapters: number;
  let cold: ColdCoverage | undefined;
  let waited: ReaderWaited | undefined;
  try {
    // 等读（R5.2＋R6.1）：补读期间进度行标「核账在等它读完」（进程内登记，进锁前后都算）；
    // 等过了（笔记是谁补上的都算）由 ensureReaderWindow 带回 waited，回执如实说等了哪几章。
    const root = input.notesRoot ?? input.projectDir;
    const waiting = readerWaitingHandlers(root, role.id, input.chapter - 1);
    // 笔记前一步补过：这里一章、一个卷节点都不补（缺了照冷窗口核），这一步的额度只算核。
    const maxCatchUp = input.notesReady ? 0 : input.maxCatchUp;
    const maxVolumeBuilds = input.notesReady ? 0 : input.maxVolumeBuilds;
    const ready = await withStep("跟读补笔记", () => ensureReaderWindow({
      projectDir: input.projectDir,
      role,
      upTo: input.chapter - 1,
      callModel: input.callModel,
      ...(input.notesRoot ? { notesRoot: input.notesRoot } : {}),
      ...(maxCatchUp !== undefined ? { maxCatchUp } : {}),
      ...(maxVolumeBuilds !== undefined ? { maxVolumeBuilds } : {}),
      ...(input.maxChars !== undefined ? { maxChars: input.maxChars } : {}),
      waitingAs: "核账",
      onCatchUpBegin: waiting.onCatchUpBegin,
      onProgress: waiting.onProgress,
      onCatchUpEnd: waiting.onCatchUpEnd,
    }));
    waited = input.notesReady ? input.notesReady.waited : ready.waited;
    if (ready.missing > 0) {
      // R4.4 冷窗口兜底：要补的笔记太多（后台补读还在跑）不再跳过——已有笔记 + 最近 K 章原文先核，范围如实带回执。
      const built = await buildColdReaderWindow({
        projectDir: input.projectDir,
        role,
        upTo: input.chapter - 1,
        ...(input.notesRoot ? { notesRoot: input.notesRoot } : {}),
      });
      window = built.messages;
      foldedChapters = built.foldedChapters;
      cold = built.coverage;
    } else {
      window = ready.messages;
      foldedChapters = ready.foldedChapters;
    }
  } catch (error) {
    rethrowIfStopped(error);
    // 补到一半失败：已写下的笔记留着，下次接着补；这次如实说没核成（上一稿的问题照带）。
    return { failure: `核账员读前文没成：${modelFailureText(error)}` };
  }
  const earlier = input.earlier ?? await readEarlierChapters(input.projectDir, input.chapter);
  // R7.3 设定本进核账：人物卡 / 地点 / 资产 / 世界规则拼一份「设定」对照材料，三遍和自复核都带上。
  // 读不了如实记一笔失败、照常核（只是没对照设定）；哪类资料都没有（新建的书）就不带、提示里也不提设定。
  let foundation: FoundationDigest | undefined;
  let foundationFailure: string | undefined;
  try {
    foundation = await readFoundationDigest(input.projectDir);
  } catch (error) {
    foundationFailure = `设定本读不了，这次没对照设定核：${modelFailureText(error)}`;
  }
  const settingMessage = foundation ? foundationMessage(foundation) : undefined;
  // B 时间线表：引擎排好的日子，核账时照表判「昨天 / 前天 / 周几」，不让模型自己推算（压「换了一天」那类误报）。
  // F（时间线只进自复核）开着时三遍不带表、只在 A 那一轮带（表照样读一次）。
  const timelineTable = variant.timeline || variant.timelineInReview
    ? await readStoryViews(input.projectDir)
      .then((views) => describeTimelineForChapter(views.projection, input.chapter))
      .catch(() => undefined)
    : undefined;
  // 前文有看不到原文的章（折叠只剩笔记 / 冷窗口没给到）→ 先翻一轮原文贴回去，三遍和自复核共用这一段前缀。
  const lookup = foldedChapters > 0
    ? await lookupEarlierPassages({ projectDir: input.projectDir, chapter: input.chapter, draftBody: input.draftBody, window, callModel: input.callModel, ...(cold ? { cold: true } : {}) })
    : { prefix: window };
  // 新稿这条消息三遍共用：新稿本体 + 时间线表（B，且 F 没开）+ 翻到的原文（T5）+ 设定本（R7.3）——都拼在新稿后面、核账提示前面（离要判的话最近）。
  const draftParts = (timeline: string | undefined): string => [
    `【新稿：第 ${input.chapter} 章】\n${input.draftBody}`,
    ...(timeline ? ["", timeline] : []),
    ...(lookup.passages ? ["", lookup.passages] : []),
    ...(settingMessage ? ["", settingMessage] : []),
  ].join("\n");
  const passesTimeline = variant.timeline && !variant.timelineInReview && timelineTable ? `【故事时间线（日子以这张表为准）】\n${timelineTable}` : undefined;
  // F：三遍不带表；A 自复核那一轮带表，并写明日子以表为准、不要自己推算（B 单开时复核沿用三遍那张表，第 1 步行为不变）。
  const reviewTimeline = variant.timelineInReview && timelineTable
    ? `【故事时间线（日子以这张表为准，不要自己推算）】\n${timelineTable}`
    : passesTimeline;
  return {
    prefix: lookup.prefix,
    draftMessage: draftParts(passesTimeline),
    reviewMessage: draftParts(reviewTimeline),
    earlier,
    ...(foundation ? { foundation } : {}),
    failures: [...(lookup.failure ? [lookup.failure] : []), ...(foundationFailure ? [foundationFailure] : [])],
    ...(cold ? { cold } : {}),
    ...(waited ? { waited } : {}),
  };
}

/** 并行跑几遍核账调用：没跑成的如实记一笔（label 写进失败说明），跑成的各自解析。 */
async function runReaderPasses(
  plans: readonly { readonly label: string; readonly run: () => Promise<readonly ContinuityIssueV2[]> }[],
): Promise<{ readonly passes: readonly (readonly ContinuityIssueV2[])[]; readonly failures: readonly string[] }> {
  const settled = await withStep("核账员", () => Promise.allSettled(plans.map((plan) => plan.run())));
  const passes: (readonly ContinuityIssueV2[])[] = [];
  const failures: string[] = [];
  settled.forEach((result, index) => {
    if (result.status === "rejected") rethrowIfStopped(result.reason);
    if (result.status === "fulfilled") passes.push(result.value);
    else failures.push(`${plans[index]!.label}没跑成：${modelFailureText(result.reason)}`);
  });
  return { passes, failures };
}

/** 一遍对前文的核账调用（checks + contradictions 那套输出）：对前文的、对设定本的（有设定本时）都收。 */
function contradictionPass(input: ReaderCheckInput, setup: ReaderCheckSetup, label: string, task: string) {
  return {
    label,
    run: async (): Promise<readonly ContinuityIssueV2[]> => {
      const text = await input.callModel([...setup.prefix, { role: "user", content: `${setup.draftMessage}\n\n${task}` }], { json: true });
      return [
        ...parseFullReadIssues(text, input.chapter, input.draftBody, setup.earlier),
        ...(setup.foundation ? parseSettingIssues(text, input.chapter, input.draftBody, setup.earlier, setup.foundation) : []),
      ];
    },
  };
}

/**
 * A 自复核：候选在同一窗口里逐条再判一轮（no 的删掉，把握以复核为准）。carried 里的（上一稿带过来的）不改把握。
 * 复核没跑成：候选原样交出（宁可多报），如实记一笔。
 */
async function selfReviewIssues(
  input: ReaderCheckInput,
  setup: ReaderCheckSetup,
  candidates: readonly ContinuityIssueV2[],
  carried: ReadonlySet<ContinuityIssueV2>,
): Promise<{ readonly issues: ContinuityIssueV2[]; readonly failure?: string }> {
  const { foundation } = setup;
  try {
    const text = await withStep("核账员自复核", () => input.callModel(
      [...setup.prefix, { role: "user", content: `${setup.reviewMessage}\n\n${selfReviewTask(input.chapter, candidates, Boolean(foundation))}` }],
      { json: true },
    ));
    const verdicts = parseVerdicts(text);
    if (verdicts.size === 0) throw new Error("复核输出不是 JSON");
    const rulingOf = (index: number) => verdicts.get(`K${index + 1}`);
    // 判 no 的删掉，其余把握以复核为准；没给判断的按原把握保留。
    // R7.3 设定裁定：复核逐句判了两边各自和设定一致不一致（settingQuote 已由代码核对真在设定本里）→
    // 另一侧对不上、本章这句一致：错的是另一侧那句，那条原地改成「错的那句 vs 设定原文」、指向改那章
    // （fixChapter），别让「本章 vs 前文」的矛头指向其实和设定一致的一侧、诱导作者把对的改成错的；
    // 本章这句对不上、另一侧一致 → 对设定本报（earlierQuote 换成设定原文，改本章）。
    const issues = candidates
      .map((issue, index): ContinuityIssueV2 => {
        const ruling = rulingOf(index);
        if (!ruling || carried.has(issue)) return issue;
        const confidence = ruling.verdict === "sure" ? "sure" as const : "maybe" as const;
        if (foundation && !issue.againstSetting && ruling.settingQuote) {
          const settingQuote = cleanSettingQuote(foundation, ruling.settingQuote);
          const source = settingQuoteSource(foundation, settingQuote);
          const draftWrong = ruling.draftAgrees === false;
          const earlierWrong = ruling.earlierAgrees === false;
          if (source && earlierWrong && !draftWrong) {
            return {
              quote: issue.earlierQuote,
              earlierQuote: settingQuote,
              earlierChapter: issue.earlierChapter,
              fixChapter: issue.earlierChapter,
              reason: issue.reason,
              kind: "event",
              confidence,
              againstSetting: source,
            };
          }
          if (source && draftWrong && !earlierWrong) {
            return {
              quote: issue.quote,
              earlierQuote: settingQuote,
              earlierChapter: input.chapter,
              reason: issue.reason,
              kind: "event",
              confidence,
              againstSetting: source,
            };
          }
        }
        return { ...issue, confidence };
      })
      .filter((_, index) => rulingOf(index)?.verdict !== "no");
    return { issues };
  } catch (error) {
    rethrowIfStopped(error);
    return { issues: [...candidates], failure: `自复核没跑成：${modelFailureText(error)}` };
  }
}

/** 核账员核一章：先确保读完前文（缺的笔记补上），再三遍并行核新稿，最后按变体做自复核（A，可带时间线表 F）和「确定」门槛（D）。 */
export async function checkChapterByReader(input: ReaderCheckInput & {
  /** 上一稿报过、两边原句都还在的问题：和这次三遍的候选一起进自复核，判 no 的去掉（作者改了别处把它修好了），
   *  其余照带、把握沿用上一稿（不随这次的运气跳）。 */
  readonly carryOver?: readonly ContinuityIssueV2[];
}): Promise<ReaderCheckResult> {
  const carryOver = input.carryOver ?? [];
  const variant = input.variant ?? {};
  const setup = await prepareReaderCheck(input);
  if ("failure" in setup) return { issues: [...carryOver], failures: [setup.failure] };
  const { foundation, earlier } = setup;
  // 三遍（盯东西 / 盯人 / 盯时间）+ R7.3 第 4 遍（对设定本，有设定本才跑）。第 4 遍用专用小 schema，只收「对设定本」的条目。
  // 合并去重按先来留下：同一句新稿既被三遍按「对前文」报、又被第 4 遍按「对设定」报时，留带裁定的设定条目
  // （fixChapter 指得准），所以第 4 遍排在合并序列最前（执行仍是并行的，只是标签叫第 4 遍）。
  const passPlans: readonly { readonly label: string; readonly run: () => Promise<readonly ContinuityIssueV2[]> }[] = [
    ...(foundation
      ? [{
        label: "第 4 遍（对设定本）",
        run: async () => {
          const text = await input.callModel(
            [...setup.prefix, { role: "user", content: `${setup.draftMessage}\n\n${settingCheckTask(input.chapter)}` }],
            { json: true },
          );
          return parseSettingChecks(text, input.chapter, input.draftBody, earlier, foundation);
        },
      }]
      : []),
    ...CHECKER_PASSES.flatMap(({ focus, label }) => {
      const repeats = Math.max(1, variant.passRepeats ?? 1);
      const segments = draftSegments(input.draftBody, repeats);
      return Array.from({ length: repeats }, (_, repeat) =>
        contradictionPass(input, setup, repeat === 0 ? label : `${label}第 ${repeat + 1} 次`, checkTask(input.chapter, focus, segments.length > 1 ? segments[repeat % segments.length] : undefined)));
    }),
    // H 本章前后：不带前文窗口，只给这一章（按句编号），几次各逐句核一段；排在三遍后面，同一处三遍也报了留三遍那条（它看过前文，挑的该改那句更准）。
    ...(() => {
      const repeats = Math.max(0, variant.innerRepeats ?? 0);
      if (repeats === 0) return [];
      const units = splitUnits(input.draftBody);
      const numbered = numberedText(units);
      const ranges = unitRanges(units, repeats);
      return Array.from({ length: repeats }, (_, repeat) => ({
        label: repeat === 0 ? "本章前后那一遍" : `本章前后那一遍第 ${repeat + 1} 次`,
        run: async (): Promise<readonly ContinuityIssueV2[]> => {
          const range = ranges.length > 1 ? ranges[repeat % ranges.length] : undefined;
          const text = await input.callModel([{ role: "user", content: innerCheckTask(input.chapter, numbered, range) }], { json: true });
          return parseInnerPairs(text, input.chapter, input.draftBody);
        },
      }));
    })(),
  ];
  const ran = await runReaderPasses(passPlans);
  const failures: string[] = [...setup.failures, ...ran.failures];
  // 上一稿带过来的排最前：同一句这次又报了，留上一稿那条（把握沿用）。
  let issues = dropMisdirectedBySetting(mergePasses([carryOver, ...ran.passes], input.chapter));
  const carried = new Set<ContinuityIssueV2>(issues.filter((issue) => carryOver.includes(issue)));
  // A 自复核：没候选就不发这一轮（省调用）。
  // 上一稿带过来的也在里头：原句没动、错却可能在别处改好了（长篇实跑：作者把地点挪对了，报的那句台词没动，「确定」一直带着）。
  if (variant.selfReview && issues.length > 0) {
    const reviewed = await selfReviewIssues(input, setup, issues, carried);
    issues = reviewed.issues;
    if (reviewed.failure) failures.push(reviewed.failure);
  }
  // D「确定」门槛：最后加一道确定性的闸，压「确定」的误报和波动。
  if (variant.sureGate) issues = applySureGate(issues, input.chapter, input.draftBody, earlier);
  return { issues, failures, ...(setup.cold ? { cold: setup.cold } : {}), ...(setup.waited ? { waited: setup.waited } : {}) };
}

/** 按核账改过的一句：改前 → 改后（改后空串＝删掉了这句）。 */
export interface ChangedSentence {
  readonly from: string;
  readonly to: string;
}

/** 改后只核改过的句子：列出改前 → 改后，核改后的说法、以及本章别处有没有还照改前说的。输出和三遍同一套 JSON。 */
export function recheckTask(chapter: number, changes: readonly ChangedSentence[]): string {
  return [
    `上面是第 ${chapter} 章新稿，刚按核账改了下面几句（新稿里已经是改后的样子）。别的句子刚核过，这一遍只核改过的这几句，对照你读过的前文原文和笔记、设定本、本章别处：`,
    ...changes.map((change, index) => `${index + 1}. 改前：${change.from}\n   改后：${change.to.trim() ? change.to : "（删掉了）"}`),
    "1. 先在 checks 里逐句列：改后的说法碰到的硬信息（物件、人物、时间、谁知道什么、数目）→ 前文、设定、本章别处怎么写的 → 对得上 / 对不上；",
    "2. 再看本章别处：有没有句子还照改前的说法写、和改后这句对不上的；",
    "3. 对不上的放进 contradictions。写了变化过程的、人物明确在撒谎或记错的、只是补充细节的，不算。",
    `每条 contradictions：quote 逐字抄有问题、该改的那一句（改后的句子，或本章别处还照改前说法写的那句）；earlierQuote 逐字抄前文（或本章别处、设定本）和它冲突的那一句；earlierChapter 写那句在第几章；${REASON_WORDING}；confidence 写 sure（两处不可能同时成立）或 maybe（看着对不上，但也说得通）。抄不出原文的不要报。`,
    "只输出一个 JSON：{\"checks\":[\"...\"],\"contradictions\":[{\"quote\":\"\",\"earlierQuote\":\"\",\"earlierChapter\":1,\"reason\":\"\",\"confidence\":\"sure\"}]}",
  ].join("\n");
}

/**
 * 改后按改动重核（外部审查 2026-10-28：改稿后再跑一遍完整核账，等待翻倍）：整章刚核过、只改了几句，
 * 就只让核账员核改过的句子和它们牵连的本章别处——同一窗口、同一份新稿消息，按变体并行几次（recheckRepeats），
 * 候选照样自复核、过「确定」门槛。没改的句子沿用上一遍的结果，由核账服务带上（这里只返回这次新核出的）。
 * revisit：上一遍报的、这次改在别的句子上（原句没动）的，和候选一起进自复核，判 no 的去掉，其余照带、把握沿用。
 */
export async function recheckChangesByReader(input: ReaderCheckInput & {
  readonly changes: readonly ChangedSentence[];
  readonly revisit?: readonly ContinuityIssueV2[];
}): Promise<ReaderCheckResult> {
  const variant = input.variant ?? {};
  const revisit = input.revisit ?? [];
  const setup = await prepareReaderCheck(input);
  if ("failure" in setup) return { issues: [...revisit], failures: [setup.failure] };
  const task = recheckTask(input.chapter, input.changes);
  const ran = await runReaderPasses(Array.from({ length: Math.max(1, variant.recheckRepeats ?? variant.passRepeats ?? 1) }, (_, repeat) =>
    contradictionPass(input, setup, repeat === 0 ? "核改过的句子" : `核改过的句子第 ${repeat + 1} 次`, task)));
  const failures: string[] = [...setup.failures, ...ran.failures];
  // 带过来复核的排最前：同一句这遍又报了，留上一遍那条（把握沿用）。
  let issues = dropMisdirectedBySetting(mergePasses([revisit, ...ran.passes], input.chapter));
  const carried = new Set<ContinuityIssueV2>(issues.filter((issue) => revisit.includes(issue)));
  if (variant.selfReview && issues.length > 0) {
    const reviewed = await selfReviewIssues(input, setup, issues, carried);
    issues = reviewed.issues;
    if (reviewed.failure) failures.push(reviewed.failure);
  }
  if (variant.sureGate) issues = applySureGate(issues, input.chapter, input.draftBody, setup.earlier);
  return { issues, failures, ...(setup.cold ? { cold: setup.cold } : {}), ...(setup.waited ? { waited: setup.waited } : {}) };
}

// ---------- 审章纲（2026-10-12 编辑部第 3 步） ----------

/** 核账员审章纲审出的一条问题：point 指 beats 的序号（1 起），beat 由代码按序号取回（不信模型抄写）。 */
export interface PlanProblem {
  readonly point: number;
  readonly beat?: string;
  readonly earlierQuote: string;
  readonly earlierChapter: number;
  readonly reason: string;
  /** R7.5：这条要点来自作者给的方向、且方向本身和前文既成事实对不上——不自动改，回执问作者以哪个为准。 */
  readonly authorWilled?: true;
  /** authorWilled 时作者方向里冲突的那句原话（代码核对过真在方向里；核不上就不算作者方向，交章纲员改）。 */
  readonly directionQuote?: string;
}

export interface ReaderPlanCheckResult {
  /** earlierQuote 已由代码逐字核对过真在前文里（抄不出的在解析时丢掉）。 */
  readonly problems: readonly PlanProblem[];
  readonly failures: string[];
  /** 冷窗口＝核账员还没读完全书，这次按已有笔记 + 最近 K 章原文审的纲（R4.4 起不再跳过）。 */
  readonly cold?: ColdCoverage;
  /** 这次先等了补读（R5.2＋R6.1，谁补的都算）：回执据此加「这次先等核账员读完…再审章纲」。 */
  readonly waited?: ReaderWaited;
}

/** 审章纲提示：核账员窗口（读到 N-1）后接「这是第 N 章的章纲（还没写正文）」+ 章纲要点，逐条判 conflict（结构化，R7.5）。
 *  作者方向和前文既成事实对不上的也报（authorWilled=true），别因为「作者方向明确要求」就放过——写完才被核账抓到就白写了。 */
export function planCheckTask(chapter: number, plan: ChapterPlan): string {
  return [
    `这是作者准备照着写第 ${chapter} 章的章纲（还没写正文），上面还没给过你。对照你读过的前文原文和笔记，逐条核对章纲要点和前文对不对得上：`,
    "- 谁手里有什么：物件此刻在哪、在谁手上，章纲是不是安排拿错了、放错了、又交了一遍",
    "- 谁在哪：人物的位置和行程按前文接不接得上",
    "- 谁知道什么：章纲安排人物说出或用到的信息，他按前文还不可能知道",
    "- 日子：开场时间和「几天后」按前文过了几天算得对不对",
    ...(plan.direction ? [`【作者这章给的方向】\n${plan.direction}`] : []),
    "核对到的要点逐条列进 problems，每条判 conflict：true＝按前文不可能成立；false＝核对过、对得上或不构成矛盾（章纲明确安排了变化过程的、作者明确要求的变化过程，都不算）。作者方向本身和前文既成事实对不上的（东西已在别人手里、人已不在、事已发生过），conflict 照样写 true，authorWilled 也写 true——不要因为方向是作者给的就不报。",
    `conflict 为 true 的条目：earlierQuote 逐字抄前文和它冲突的那一句（抄不出原文的不要报）；earlierChapter 写那句在第几章；${REASON_WORDING}；要点内容来自作者方向的原话时 authorWilled 写 true、directionQuote 逐字抄方向里冲突的那句原话，否则 authorWilled 写 false（章纲员自己展开、方向里没说的细节都算 false）。conflict 为 false 的条目：reason 一句话写核对结论，其余字段留空。`,
    `【第 ${chapter} 章章纲】`,
    `一句话：${plan.summary}`,
    `要点：\n${plan.beats.map((beat, index) => `${index + 1}. ${beat}`).join("\n")}`,
    ...(plan.newInformation.length > 0 ? [`新信息：\n${plan.newInformation.map((item, index) => `${index + 1}. ${item}`).join("\n")}`] : []),
    `开场：${plan.scene.location ?? "（没写）"}，${plan.scene.time ?? "（没写）"}`,
    ...(plan.characters.length > 0 ? [`人物：${plan.characters.join("、")}`] : []),
    ...(plan.entities.length > 0 ? [`物件/地点：${plan.entities.join("、")}`] : []),
    '只输出一个 JSON：{"problems":[{"point":1,"conflict":true,"authorWilled":false,"directionQuote":"","earlierQuote":"","earlierChapter":1,"reason":""}]}；没有问题就给空数组。',
  ].join("\n");
}

/** 前文按章号 → 归一后的全文（核 earlierQuote 用）。 */
function earlierByText(earlier: EarlierText): ReadonlyMap<number, string> {
  return new Map(earlier.chapters.map((item) => [item.chapter, normalize(item.sentences.join(""))]));
}

/** 结构化布尔宽进：true/"true"/false/"false"（大小写不限）；别的写法当没给（不猜中文说法）。 */
function readBoolFlag(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const text = value.trim().toLowerCase();
  if (text === "true") return true;
  if (text === "false") return false;
  return undefined;
}

/** 要点序号：数字、「第 2 条」都收；越界（或没写）丢掉。 */
export function readPoint(raw: unknown, beats: readonly string[]): number | undefined {
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw : "";
  const digits = /\d+/u.exec(text);
  if (!digits) return undefined;
  const point = Number(digits[0]);
  return Number.isInteger(point) && point >= 1 && point <= beats.length ? point : undefined;
}

/**
 * 解析审章纲输出：每条带结构化判定 conflict（R7.5）——false 的一律不收；没给字段的照收（列进 problems 就是要报），不看理由里的字眼。
 * authorWilled＝这条要点来自作者给的方向且方向和前文事实对不上：照收（要报），调用方不自动改、回执问作者。
 *   P7 GLM 复跑：模型会把章纲员自己展开的细节也标成作者方向（作者从没说过，却被反问「以哪个为准」、错的要点也不改），
 *   所以要它逐字抄方向里冲突的那句（directionQuote），代码核对真在方向原话里才算，核不上当章纲员拟错、照常交回去改。
 * earlierQuote 由代码核对真在前文里（先信它报的章号，对不上按章序搜），抄不出原文的丢掉；
 * point 越界的丢掉（模型没指到具体要点的问题没法只改那条要点）。
 */
export function parsePlanProblems(text: string, plan: Pick<ChapterPlan, "beats"> & { readonly direction?: string }, earlier: EarlierText): readonly PlanProblem[] {
  let parsed: { problems?: unknown };
  try {
    parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as { problems?: unknown };
  } catch {
    throw new Error("审章纲结果不是 JSON");
  }
  const byChapter = earlierByText(earlier);
  const out: PlanProblem[] = [];
  for (const item of Array.isArray(parsed.problems) ? parsed.problems : []) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const earlierQuote = String(record.earlierQuote ?? "").trim();
    const reason = String(record.reason ?? "").trim();
    const point = readPoint(record.point ?? record.beat, plan.beats);
    const conflict = readBoolFlag(record.conflict);
    if (conflict === false) continue; // 模型判了不构成矛盾：结构化字段说了算
    if (!point || !earlierQuote || !reason) continue;
    const claimed = Number(record.earlierChapter);
    const inClaimed = Number.isInteger(claimed) && claimed >= 1 && byChapter.has(claimed) && containsQuote(byChapter.get(claimed)!, earlierQuote);
    const chapter = inClaimed
      ? claimed
      : [...byChapter.keys()].sort((a, b) => a - b).find((key) => containsQuote(byChapter.get(key)!, earlierQuote));
    if (chapter === undefined) continue;
    out.push({
      point,
      beat: plan.beats[point - 1],
      earlierQuote,
      earlierChapter: chapter,
      reason,
      ...authorWilledOf(record, plan.direction),
    });
  }
  return out;
}

/** 作者方向那条要核原话：模型说来自方向、且抄的那句真在方向原文里，才算作者方向。 */
function authorWilledOf(record: Record<string, unknown>, direction: string | undefined): { authorWilled?: true; directionQuote?: string } {
  if (readBoolFlag(record.authorWilled) !== true || !direction?.trim()) return {};
  const directionQuote = String(record.directionQuote ?? "").trim();
  return directionQuote && containsQuote(normalize(direction), directionQuote) ? { authorWilled: true, directionQuote } : {};
}

/**
 * 核账员审章纲：在读完第 N-1 章的窗口后面接「第 N 章的章纲（还没写正文）」+ 要点，一遍找出和前文矛盾的要点。
 * 章纲短，不用像核正文那样分三遍。earlierQuote 全部经代码核对。
 */
export async function checkPlanByReader(input: {
  readonly projectDir: string;
  readonly plan: ChapterPlan;
  readonly callModel: BrainCallModel;
  readonly notesRoot?: string;
  readonly maxCatchUp?: number;
  readonly maxVolumeBuilds?: number;
  /** 前面各章原文（调用方已读过就传进来）；缺省从书目录读。 */
  readonly earlier?: EarlierText;
}): Promise<ReaderPlanCheckResult> {
  let window: BrainMessage[];
  let cold: ColdCoverage | undefined;
  let waited: ReaderWaited | undefined;
  try {
    // 等读（R5.2＋R6.1）：审纲在拟纲流程里，补读期间进度行标「拟纲在等它读完」；等没等由 ensureReaderWindow 判（谁补的都算）。
    const root = input.notesRoot ?? input.projectDir;
    const waiting = readerWaitingHandlers(root, CHECKER_ROLE.id, input.plan.chapter - 1);
    const ready = await withStep("跟读补笔记", () => ensureReaderWindow({
      projectDir: input.projectDir,
      role: CHECKER_ROLE,
      upTo: input.plan.chapter - 1,
      callModel: input.callModel,
      ...(input.notesRoot ? { notesRoot: input.notesRoot } : {}),
      ...(input.maxCatchUp !== undefined ? { maxCatchUp: input.maxCatchUp } : {}),
      ...(input.maxVolumeBuilds !== undefined ? { maxVolumeBuilds: input.maxVolumeBuilds } : {}),
      waitingAs: "拟纲",
      onCatchUpBegin: waiting.onCatchUpBegin,
      onProgress: waiting.onProgress,
      onCatchUpEnd: waiting.onCatchUpEnd,
    }));
    waited = ready.waited;
    if (ready.missing > 0) {
      // R4.4 冷窗口兜底：没读完也照审（已有笔记 + 最近 K 章原文），范围如实带回执。
      const built = await buildColdReaderWindow({
        projectDir: input.projectDir,
        role: CHECKER_ROLE,
        upTo: input.plan.chapter - 1,
        ...(input.notesRoot ? { notesRoot: input.notesRoot } : {}),
      });
      window = built.messages;
      cold = built.coverage;
    } else {
      window = ready.messages;
    }
  } catch (error) {
    rethrowIfStopped(error);
    return { problems: [], failures: [`核账员读前文没成：${modelFailureText(error)}`] };
  }
  const earlier = input.earlier ?? await readEarlierChapters(input.projectDir, input.plan.chapter);
  try {
    const text = await withStep("核账员审纲", () => input.callModel(
      [...window, { role: "user", content: planCheckTask(input.plan.chapter, input.plan) }],
      { json: true },
    ));
    return { problems: parsePlanProblems(text, input.plan, earlier), failures: [], ...(cold ? { cold } : {}), ...(waited ? { waited } : {}) };
  } catch (error) {
    rethrowIfStopped(error);
    return { problems: [], failures: [`审章纲没跑成：${modelFailureText(error)}`] };
  }
}
