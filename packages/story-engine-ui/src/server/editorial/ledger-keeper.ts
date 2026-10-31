/**
 * 记账员（新，重构 P3）：带着读过的前文和自己的笔记，一次交齐这一章的账单——梗概、时间、出场、事实、线索。
 *
 * 和旧路的区别：
 *  - 旧路要两次模型调用（ChapterDelta 声明 + 另一条腿单独抽事实），这里一次交齐；
 *  - 交的直接是新核心的账单条目，不再由引擎拿正则挑事件、合并线索、判断收口；
 *  - 上下文全部从投影拼（keeper-context），短号由代码换回真编号（keeper-parse）。
 *
 * 跟读窗口和笔记沿用旧记账员的角色（LEDGER_ROLE 一个字都不能改：笔记按角色说明的哈希作废，改了全书笔记重写）。
 * 规则里不写任何书名、人名、题材。模型调用由调用方注入，这里不碰模型 SDK。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  chapterSource,
  chapterTextPath,
  checkEntries,
  locateSegment,
  numberedText,
  quoteFromText,
  quoteInText,
  readCards,
  splitUnits,
  type BookProjection,
  type BoundaryOffsets,
  type ChapterTime,
  type DayRange,
  type EntryInput,
  type SegmentInput,
  type TextUnit,
  type TimeInput,
  type TimeOffset,
} from "@actalk/story-core";
import { WEEKDAY_NAMES } from "../book/story-timeline.js";
import { positiveIntLike } from "../lib/lenient-args.js";
import { rethrowIfStopped } from "../lib/operations/context.js";
import { withStep } from "../lib/token-meter.js";
import { buildKeeperContext, type ReopenableThread } from "./keeper-context.js";
import { extractJsonObject, flag, parseChapterEnd, parseKeeperOutput, relativeOf, type KeeperParseResult } from "./keeper-parse.js";
import { modelFailureText } from "../lib/ai-errors.js";
import { readerWaitingHandlers, type ReaderWaited } from "./reader-progress.js";
import { buildColdReaderWindow, ensureReaderWindow, type BrainCallModel, type BrainMessage, type ColdCoverage, type ReaderRole } from "./reader-window.js";

export const LEDGER_ROLE: ReaderRole = {
  id: "ledger",
  system: [
    "你是这本长篇小说的记账员，从第 1 章起一章一章跟读，管人物、线索、打算、目标。",
    "每读完一章，你写一份记账笔记，只记以后记账要用的硬信息，不复述情节。",
    "作者交来新的一章要定稿时，你对照读过的前文原文和你的笔记，把这一章引起的变化列成结构化声明。",
  ].join("\n"),
  noteTask: [
    "读完写这一章的记账笔记（纯文本，800 字以内），只记硬信息：",
    "- 人物：本名、别称、称呼（谁叫谁什么）、身份；本章新出现的称呼指的是谁",
    "- 开着的问题 / 悬念：新冒出的、推进的、揭晓的各是哪条",
    "- 人物的打算 / 待办：新立的、做完的、放弃的各是哪条",
    "- 主角的目标：新立的、推进的、达成的各是哪条",
  ].join("\n"),
  // P7 长书验收：没有卷笔记时窗口只能折原文、笔记只增不减，两百章时记账提示词涨到二十几万字；有了它和核账员一样封顶。
  volumeTask: [
    "把上面这些记账笔记缩写成一份卷笔记（纯文本，1500 字以内），按章序保住以后记账要用的硬信息，不复述情节：",
    "- 人物：本名、别称、称呼（谁叫谁什么）、身份；这几章里冒出的新称呼各指谁",
    "- 开着的问题 / 悬念：到这几章结束还开着的各是哪条；这几章里揭晓了哪些",
    "- 人物的打算 / 待办：到这几章结束还没做完的各是哪条；做完、放弃了哪些",
    "- 主角的目标：到这几章结束还在追的各是哪条；达成了哪些",
    "同一条前后有变化时，记最后的状态，再用半句话带出之前的状态。",
  ].join("\n"),
};

/** 冷窗口的阈值：要补的笔记超过这么多章，就不当场补，按已有笔记 + 最近几章原文记账（笔记在后台补）。 */
export const KEEPER_MAX_CATCH_UP = 10;

/** 记一章账单最多调几次模型（不含补笔记）：交账单一次 + 补摘原句一次 + 追问本章结尾一次 + 复核半夜到天亮一次 + 复核星期一次。额度算式用。 */
export const KEEPER_MAX_CALLS = 5;

/** 章里过了半夜 / 过了天亮：交账单、追问结尾两处同一句。 */
const IN_CHAPTER_BOUNDARY =
  "章里讲过了半夜或天亮、换没换天要看规矩的，也是一次换天，用 byBoundary 各写一份，不写 sameDay：③ 从白天或半夜以前讲到半夜以后、天亮以前（「过了十二点」「凌晨一点」这类）：midnight 1、dawn 0，quote 摘过了半夜那句；④ 本章开头在半夜以后、天亮以前，章里又讲到天亮以后：midnight 0、dawn 1，quote 摘天亮后那句。两样都有（从晚上讲过半夜一直到天亮以后）就各记一次。";

/** 交账单的要求（通用写法，绝不写进具体书名、人名）。 */
export const KEEPER_SPEC: readonly string[] = [
  "把这一章引起的变化列成一份账单。题材中立：只记正文真实写到的，不臆造、不补剧情、不预设走向。",
  "每一条都必须附 quote：一句逐字摘自本章正文的原句（可以含标点，不能改写、拼接、自己造句）。代码会逐字核对，对不上的那条不记。",
  "- 摘法：照抄正文里连续的一段，至少 4 个字。正文写「他」「她」就照抄「他」「她」，不要换成名字（正文写名字也不要换成「他」）；不要换人称；对话中间夹着「某某说」时只摘一边，要跨过去就在中间写……；不要删字、加字、换词。",
  "",
  "summary：本章梗概。text 用你自己的话一句话说清谁做了什么、结果怎样，不超过 60 个字（不要照抄原句）；quote 引最能代表本章的那句。",
  "",
  "time：每章都给（第 1 章也照样给）。",
  "- 当下 = 故事「现在」往前走的那条线。多线叙事换个人物从前天讲起也还在当下，只是往回接。回忆、倒叙、梦、想象、传闻、故事里讲的故事不在当下，写进 segments。",
  "- start = 本章开头离上一个当下章的结尾多久（下面【上一个当下章结尾】是原文）。写成 {\"offset\":{\"unit\":\"day\",\"min\":1,\"max\":1},\"basis\":\"text\",\"quote\":\"…\"}：同一天 0，「第二天」1，「三天后」3，往回接的写负数（「前天」-2）。本章开头做的正是上一个当下章约到「明天」「第二天」的事，或者本章里说「昨天」指的是上一个当下章的事，也是 1。说不准几天就写区间（「过了几天」写 min、max 两头，「几天后」只写 min）；「半年后」「三年后」照原样写 unit 为 month、year，不要折成天。正文明写了 basis 填 text；对照上一个当下章结尾和本章开头判断的填 judged。quote 引说明它的那句。",
  "- 要看「过了半夜算不算第二天」才定的，按两种规矩各写一份，不写 offset：\"byBoundary\":{\"midnight\":{\"unit\":\"day\",\"min\":0,\"max\":0},\"dawn\":{\"unit\":\"day\",\"min\":1,\"max\":1}}（midnight = 过了半夜十二点就算第二天时隔多久，dawn = 天亮才算第二天时隔多久，里面直接写 unit、min、max，不要再套一层 offset）。两种情形要分：① 上一个当下章停在半夜以后、天亮以前（后半夜、凌晨），本章开头是那之后第一次天亮（「第二天一早」这类）：midnight 0、dawn 1；② 上一个当下章停在白天或半夜以前，本章开头在半夜以后、天亮以前（凌晨四点这类）：midnight 1、dawn 0。再往后每多隔一天，两份各加 1。下面【上一个当下章结尾】后面注明了按两种规矩不在同一天的，多半就是①。不看规矩就定的只写 offset。",
  "- 本章接着当下往下讲、但判断不了隔多久，写 \"start\":\"unknown\"，不要硬填一个数。整章都是回忆、梦这类段时，time 只写 segments，不写 start、sameDay、dayChanges、weekday、timeOfDay。",
  "- 本章从头到尾在同一天，写 \"sameDay\":true（从早到晚、从白天到半夜十二点以前都还是同一天）。中间换了天就逐次列 dayChanges：每次写隔了几天（offset 至少 1 天；要看换天规矩才定的照样用 byBoundary 各写一份），quote 逐字摘新的一天开头那句。两样都不写 = 章末是哪天不知道。",
  `- ${IN_CHAPTER_BOUNDARY}`,
  "- weekday 只填正文明写的星期，写成「周二」这样；没写就不填，不要自己推算。timeOfDay 填正文写的时段（「傍晚」）。",
  "- 不要写「故事第几天」，那由代码按全书算。",
  "",
  "segments：本章里不在当下的连续几句（没有就省略）。frame 写 past（回忆、倒叙，当时真发生过的）或 other（梦、想象、传闻、故事里讲的故事）。firstQuote、lastQuote 逐字摘这段的第一句、最后一句（一句就两处写同一句）。",
  "- past 段写 when：这段是什么时候，折成相对本章开头（整章是一段时相对上一个当下章结尾），写法同 start 的 offset（「三年前」{\"unit\":\"year\",\"min\":-3,\"max\":-3}，「至少三年前」只写 max 为 -3；段里说的「昨天」按说这话那天算）；判断不了写 \"unknown\"。other 段不写 when。",
  "",
  "presence：本章真在场的每个有名字的人物各一条。",
  "- 在场 = 在本章的场景里露面：自己说话、做事、被人看见或听见（隔着电话、视频直接说话的也算）。只在别人嘴里、回忆、念头、信上、照片上出现的不算在场，不报——提得再多也不报。拿不准就问：这个人本章自己开口或动手了吗？没有就不报。",
  "- name 写这个人的已确立名字：上面【本书已出场的人物】【设定本里还没出场的人物】里有的，逐字沿用那里的写法；两边都没有的才写正文里的名字。",
  "- nameUsed 写本章正文里怎么称呼他（和 name 不同就是别称，代码会记成同一个人）；quote 必须逐字含 nameUsed。",
  "- 正文里冒出的新称呼如果指的是已有的人，name 写那个人的已确立名字、nameUsed 写新称呼，不要当成新人物。同一个人本章只报一条，用最主要的称呼。",
  "- nameUsed 要是换个场景就能指别人的叫法（「那人」「老头」「她」「男人」这类，不是专属这个人的名字、外号或身份称呼），加 \"generic\": true——代码只认本章这一处是他，不把这个叫法记成他的别名。",
  "- 本章主要跟着谁的眼睛走，就给那个人加 \"viewpoint\": true；多视角或全知叙事就都不加。",
  "",
  "facts：本章写明的、以后写作要守住的事实。",
  "- 先问自己「subject 的 attribute 是什么？」：只有一个答案的才是一个格子，才能写 state 或 hard；能列出好几条的（过去的事、经历、特征、来历、背景、证言、知道的事）不是格子，写 event（subject 照写，attribute 不写）。",
  "- nature：会随剧情变的格子写 state——人在哪、东西在谁手里、和某人的关系、伤势病情、知不知道某件事（attribute 写「知不知道某事」，一件事一条）、身份暴没暴露。不会变的格子写 hard——年纪、出生年、籍贯、职业、门牌、某样东西上写的字、某件旧事发生在哪年、世界的某条规则。发生过的事、一段经历、一处描写写 event。拿不准的写 event。",
  "- state 和 hard 必须写清 subject（谁或什么）、attribute（哪一方面）、value（是什么）；text 用一句话说清这条事实。",
  "- 同一个人、同一样东西每次都用同一个名字当 subject；同一方面每次都用同一个说法当 attribute，尽量用短的常用说法（在哪、在谁手里、年纪、职业、和某某的关系、知不知道某事）。上面【现在有效的事实】里已经有的人、物和方面，照抄那里的写法——代码按写法认「同一方面」，写法一变，旧的现状就顶替不掉。",
  "- 本章明写推翻了上面【现在有效的事实】里某条不会变的事实（比如揭穿了假身份），在 replaces 里填它的编号（如 [\"F3\"]），quote 引推翻它的那句。会变的事实有了新值不用填 replaces，代码按最新一章算。",
  "- 这条是某个人物嘴里说的（不是叙述直接写的），加 \"speaker\":\"正文里对说话人的称呼\"；叙述直接写的加 \"source\":\"narration\"；拿不准就都不写。梦里、回忆里的照常记，算不算现状由代码按 segments 定。",
  "- 本章里同一件事只记一条：同一个动作、同一样东西的同一个变化（把钥匙揣进兜里 / 身上多了一把钥匙），不要换个说法再记一条。",
  "- 前文已经记过、本章只是又提了一遍的，不要再记。换了说法、意思一样（「姓张」和「弓长张」），或者只是补了细节、不和前文那条打架的（「信上有落款」和「落款是某某」），也不要在同一个 subject 同一个 attribute 下再记一条——代码会把同一格子的不同 value 当成前后矛盾报给作者。补的是新的一方面，就换一个 attribute 写；只有本章写的和前文那条真的不可能同时成立，才照同一个 attribute 记。",
  "",
  "threads：线索——悬念（question）、人物的打算或待办（intent）、主角的目标（goal）。",
  "- op = open 新开：只给正文还没解开、后文需要一个揭晓或回收时刻的问题，以及正文明确留下的后续行动、新立的目标。写 type、title（像个标题，跨章能认出来）、note（本章怎么引出的）、quote。",
  "- op = advance 推进：上面【开着的线索】里某条有了新进展但还没了结。thread 填它的编号（如 \"T3\"）；同一件事前文拆成了几条的，把相关编号都填上（如 [\"T3\", \"T5\"]）。note 写本章推进了什么。",
  "- op = close 收口：悬念是标题问的那件事正文完整答出来了；打算是做完了或明确放弃了；目标是达成了。thread 填编号，note 写怎么了结的。悬念只揭晓了一部分、答案引出新疑问、人物说了一半、读者心里有数但正文没说破的，报 advance，不报 close。",
  "- 你读过前文：同一件事只报一条；前文立过的问题不要换个说法当新线索再开。开新线索前先自问：正文是不是已经给出答案了？后文会不会真有揭晓它的时刻？它是不是【开着的线索】里某条的另一种说法？答案已给、不会揭晓、或是另一种说法的，都不开——是已有线索的报 advance，纯背景细节不报。",
  "- 同一个谜不要既开「它是什么」又开「为什么是它」两条，报成一条，把疑点写进 note。",
  "- 报 advance 之前先想一遍：它是不是其实已经做完、已经揭晓了？是就报 close，别让它一直挂着。判断待办做没做完，只看那个动作本身：正文写到动作做成了（问过了、找到了、交出去了、打开了），就算完成；做完之后冒出的新问题另开一条。",
  "- 揭晓、了结是某个人物嘴里说的，照样报，加 speaker（写法同 facts）；梦里、回忆里的照样报，代码按推进记、留给作者看。",
  "",
  "没有的类就给空数组或省略。只输出一个 JSON 对象，键为 summary、time、segments、presence、facts、threads，形如：",
  '{"summary":{"text":"…","quote":"…"},"time":{"start":{"offset":{"unit":"day","min":1,"max":1},"basis":"judged","quote":"…"},"dayChanges":[{"offset":{"unit":"day","min":1,"max":1},"quote":"…"}],"timeOfDay":"清晨"},"segments":[{"frame":"past","firstQuote":"…","lastQuote":"…","when":{"offset":{"unit":"year","max":-3}}}],"presence":[{"name":"…","nameUsed":"…","viewpoint":true,"quote":"…"},{"name":"…","nameUsed":"那人","generic":true,"quote":"…"}],"facts":[{"nature":"state","subject":"…","attribute":"…","value":"…","text":"…","quote":"…"},{"nature":"hard","subject":"…","attribute":"…","value":"…","text":"…","quote":"…","speaker":"…"}],"threads":[{"op":"open","type":"question","title":"…","note":"…","quote":"…"},{"op":"advance","thread":"T2","note":"…","quote":"…"}]}',
  "不要 Markdown、不要解释、不要多余文字。",
];

export interface KeeperInput {
  readonly projectDir: string;
  readonly chapter: number;
  readonly draft: string;
  /** 算到上一章的投影。 */
  readonly before: BookProjection;
  /** 重定稿：这一章上次定稿时开的线索（本章还在开就沿用编号）。 */
  readonly reopenable?: readonly ReopenableThread[];
  readonly callModel: BrainCallModel;
  /** 笔记存放的根目录；缺省就是书目录（考卷传临时目录，不动书）。 */
  readonly notesRoot?: string;
  /** 缺省 KEEPER_MAX_CATCH_UP。 */
  readonly maxCatchUp?: number;
  /** 补笔记时当场最多新生成几个卷节点（缺省不限）。 */
  readonly maxVolumeBuilds?: number;
  /** 拿到记账员原始输出时调一次（考卷、排查用；不进清单）。 */
  readonly onRawOutput?: (text: string) => void;
}

interface KeeperCommon {
  /** 冷窗口：记账员还没读完前文，这次按已有笔记 + 最近几章原文记的账（预览如实标出；笔记由调用方在后台补）。 */
  readonly cold?: ColdCoverage;
  /** 这次先等了补读。 */
  readonly waited?: ReaderWaited;
}

/** 原句补摘：第一遍交的账单里有几条原句在正文里找不到，单独让记账员重摘了一次。 */
export interface QuoteRepair {
  readonly asked: number;
  /** 重摘后核得上的条数。 */
  readonly fixed: number;
  /** 补摘那次调用本身没成（原因）；没成就照第一遍的交，核不上的由定稿清单如实列出。 */
  readonly failed?: string;
}

export type KeeperOutcome =
  | (KeeperCommon & {
      readonly ok: true;
      readonly parsed: KeeperParseResult;
      readonly omittedThreads: number;
      readonly omittedFacts: number;
      readonly quoteRepair?: QuoteRepair;
    })
  | (KeeperCommon & {
      readonly ok: false;
      readonly reason: string;
      /** 调模型那步的原错（带类别）：上层按它判还能不能再记一遍（canCallAgain），别只看 reason。 */
      readonly cause?: unknown;
    });

/** 上一章结尾摘多少字给记账员对时间（判断本章开头隔了几天）。 */
export const PREVIOUS_ENDING_CHARS = 160;

/**
 * 本章开头接着的那一章：往前跳过整章是回忆、梦这类段的章（它们不在当下线上）；没认出来的不跳（照实给前一章）。
 */
export function previousPresentChapter(before: BookProjection, chapter: number): number | undefined {
  const byChapter = new Map(before.chapters.map((view) => [view.chapter, view] as const));
  for (let n = chapter - 1; n >= 1; n -= 1) {
    if (byChapter.get(n)?.time.presentLine === false) continue;
    return n;
  }
  return undefined;
}

/** 上一个当下章的结尾：原文最后一小段，两种换天规矩下结尾不在同一天时带上各是哪天，投影知道结尾是星期几时带上（0 = 周一）。 */
export interface PreviousEnding {
  readonly chapter: number;
  readonly text: string;
  readonly byWorld?: { readonly midnight: DayRange; readonly dawn: DayRange };
  readonly weekday?: number;
}

/**
 * 这一章结尾是星期几（投影的数）：结尾是确定的第几天，就照离它最近的一处正文写明星期、开头天数确定的章推；
 * 不然看这章开头推出了星期几、章内跨了几天也确定（两种换天规矩一样）。都推不出就没有。
 * 多线往回接时本章只写「周二夜里」，记账员得知道上一章结尾是周几才定得出往回隔几天（P3a 评测：专题书「周二夜里」记成了同一天）。
 */
export function endingWeekday(before: BookProjection, chapter: number): number | undefined {
  const exact = (range: DayRange | undefined): number | undefined => (range?.lo !== undefined && range.lo === range.hi ? range.lo : undefined);
  const time = before.chapters.find((view) => view.chapter === chapter)?.time;
  if (!time) return undefined;
  const endDay = exact(time.end);
  if (endDay !== undefined) {
    let best: { readonly chapter: number; readonly weekday: number; readonly day: number } | undefined;
    for (const view of before.chapters) {
      const day = exact(view.time.start);
      if (view.time.presentLine !== true || view.time.weekday === undefined || view.time.weekdayDerived || day === undefined) continue;
      if (!best || Math.abs(view.chapter - chapter) < Math.abs(best.chapter - chapter)) best = { chapter: view.chapter, weekday: view.time.weekday, day };
    }
    if (best) return (((best.weekday + endDay - best.day) % 7) + 7) % 7;
  }
  const span = exact(time.span);
  return time.weekday !== undefined && span !== undefined ? (time.weekday + span) % 7 : undefined;
}

/** 两种换天规矩下这一章结尾各是哪天：都知道、又不一样才有（一样的、哪边不知道的不给，记账员照原文判）。 */
export function endingByWorld(before: BookProjection, chapter: number): PreviousEnding["byWorld"] {
  const days = before.chapters.find((view) => view.chapter === chapter)?.time.byWorld;
  const midnight = days?.midnight?.end;
  const dawn = days?.dawn?.end;
  if (!midnight || !dawn || dayText(midnight) === undefined || dayText(dawn) === undefined) return undefined;
  if (midnight.lo === dawn.lo && midnight.hi === dawn.hi) return undefined;
  return { midnight, dawn };
}

function dayText(range: DayRange): string | undefined {
  if (range.lo !== undefined && range.lo === range.hi) return `第 ${range.lo} 天`;
  if (range.lo !== undefined && range.hi !== undefined) return `第 ${range.lo}～${range.hi} 天`;
  if (range.lo !== undefined) return `第 ${range.lo} 天或更晚`;
  if (range.hi !== undefined) return `不晚于第 ${range.hi} 天`;
  return undefined;
}

/** 上一个当下章定稿正文的最后一小段（没有、读不到就没有）。 */
async function previousEnding(projectDir: string, before: BookProjection, chapter: number): Promise<PreviousEnding | undefined> {
  const previous = previousPresentChapter(before, chapter);
  if (previous === undefined) return undefined;
  try {
    const text = (await readFile(join(projectDir, chapterTextPath(previous)), "utf-8")).trim();
    const byWorld = endingByWorld(before, previous);
    const weekday = endingWeekday(before, previous);
    return {
      chapter: previous,
      text: text.length > PREVIOUS_ENDING_CHARS ? `…${text.slice(-PREVIOUS_ENDING_CHARS)}` : text,
      ...(byWorld ? { byWorld } : {}),
      ...(weekday !== undefined ? { weekday } : {}),
    };
  } catch {
    return undefined;
  }
}

function endingSection(ending: PreviousEnding): string {
  const notes = [
    ...(ending.weekday !== undefined
      ? [`（第 ${ending.chapter} 章结尾是${WEEKDAY_NAMES[ending.weekday]}，按前文写明的星期推的。本章正文写了星期几的，开头离它隔几天对照着这个定，往回接的照样写负数。）`]
      : []),
    ...(ending.byWorld
      ? [`（第 ${ending.chapter} 章结尾按两种换天规矩不在同一天：过了半夜就算第二天时是${dayText(ending.byWorld.midnight)}，天亮才算第二天时是${dayText(ending.byWorld.dawn)}。本章开头隔几天按两种规矩各写一份 byBoundary。）`]
      : []),
  ];
  return [`【上一个当下章结尾（第 ${ending.chapter} 章）】\n${ending.text}`, ...notes].join("\n");
}

/** 拼给记账员的那条 user 消息（单测和考卷也用）。ending = 上一个当下章的结尾。 */
export function buildKeeperTask(chapter: number, draft: string, contextText: string, ending?: PreviousEnding): string {
  return [
    `【第 ${chapter} 章 正文（待定稿，上面还没给过你）】\n${draft}`,
    contextText,
    ending && ending.text ? endingSection(ending) : "",
    `这一章即将定稿入库。对照你读过的前文原文和记账笔记，交这一章的账单。\n\n${KEEPER_SPEC.join("\n")}`,
  ]
    .filter((part) => part.length > 0)
    .join("\n\n");
}

/**
 * 先确保读到第 N-1 章（缺的笔记按顺序补；太多就走冷窗口），再在窗口后面接一条 user 消息要账单。
 * 坏 JSON、调用失败 → ok=false + 原因，不抛。
 */
/**
 * 记账员的跟读窗口：确保读到第 upTo 章（缺的笔记按顺序补；太多就走冷窗口：已有笔记 + 最近几章原文）。
 * 记账和理线索共用。读不成抛错（调用方如实说「读前文没成」）。
 */
export async function openKeeperWindow(input: {
  readonly projectDir: string;
  readonly upTo: number;
  readonly callModel: BrainCallModel;
  readonly notesRoot?: string;
  readonly maxCatchUp?: number;
  /** 当场最多新生成几个卷节点（缺省不限）。 */
  readonly maxVolumeBuilds?: number;
  /** 等读期间进度行标注的动作名。 */
  readonly waitingAs: string;
}): Promise<{ readonly window: BrainMessage[]; readonly cold?: ColdCoverage; readonly waited?: ReaderWaited }> {
  const root = input.notesRoot ?? input.projectDir;
  const waiting = readerWaitingHandlers(root, LEDGER_ROLE.id, input.upTo);
  const ready = await withStep("跟读补笔记", () =>
    ensureReaderWindow({
      projectDir: input.projectDir,
      role: LEDGER_ROLE,
      upTo: input.upTo,
      callModel: input.callModel,
      ...(input.notesRoot ? { notesRoot: input.notesRoot } : {}),
      maxCatchUp: input.maxCatchUp ?? KEEPER_MAX_CATCH_UP,
      ...(input.maxVolumeBuilds !== undefined ? { maxVolumeBuilds: input.maxVolumeBuilds } : {}),
      waitingAs: input.waitingAs,
      onCatchUpBegin: waiting.onCatchUpBegin,
      onProgress: waiting.onProgress,
      onCatchUpEnd: waiting.onCatchUpEnd,
    }),
  );
  const waited = ready.waited ? { waited: ready.waited } : {};
  if (ready.missing === 0) return { window: ready.messages, ...waited };
  const built = await buildColdReaderWindow({
    projectDir: input.projectDir,
    role: LEDGER_ROLE,
    upTo: input.upTo,
    ...(input.notesRoot ? { notesRoot: input.notesRoot } : {}),
  });
  return { window: built.messages, cold: built.coverage, ...waited };
}

export async function runLedgerKeeper(input: KeeperInput): Promise<KeeperOutcome> {
  if (input.draft.trim().length === 0) return { ok: false, reason: "正文是空的，没有可记的账" };
  let window: BrainMessage[];
  let cold: ColdCoverage | undefined;
  let waited: ReaderWaited | undefined;
  try {
    ({ window, cold, waited } = await openKeeperWindow({
      projectDir: input.projectDir,
      upTo: input.chapter - 1,
      callModel: input.callModel,
      ...(input.notesRoot ? { notesRoot: input.notesRoot } : {}),
      ...(input.maxCatchUp !== undefined ? { maxCatchUp: input.maxCatchUp } : {}),
      ...(input.maxVolumeBuilds !== undefined ? { maxVolumeBuilds: input.maxVolumeBuilds } : {}),
      waitingAs: "记账",
    }));
  } catch (error) {
    rethrowIfStopped(error);
    return { ok: false, reason: `记账员读前文没成：${modelFailureText(error)}`, cause: error };
  }
  const extra = { ...(cold ? { cold } : {}), ...(waited ? { waited } : {}) };
  const cards = await readCards(input.projectDir).catch(() => undefined);
  const context = buildKeeperContext(input.before, input.draft, input.reopenable, cards);
  const task = buildKeeperTask(input.chapter, input.draft, context.text, await previousEnding(input.projectDir, input.before, input.chapter));
  let text: string;
  try {
    text = await withStep("记账员", () => input.callModel([...window, { role: "user", content: task }], { json: true }));
  } catch (error) {
    rethrowIfStopped(error);
    return { ok: false, reason: `记账员没交上账单：${modelFailureText(error)}`, cause: error, ...extra };
  }
  input.onRawOutput?.(text);
  const parsed = parseKeeperOutput(text, context);
  if (!parsed) return { ok: false, reason: "记账员交回来的不是一份能读的账单（不是 JSON 对象）", ...extra };
  const conversation: BrainMessage[] = [...window, { role: "user", content: task }, { role: "assistant", content: text }];
  const repaired = await repairQuotes(parsed, input, conversation);
  const ended = await askChapterEnd(repaired.parsed, input, conversation);
  const nights = await recheckNight(ended, input, conversation);
  const dated = await recheckWeekday(nights, input, conversation);
  return {
    ok: true,
    parsed: settleTime(withOriginalQuotes(dated, input.draft), input.draft),
    omittedThreads: context.omittedThreads,
    omittedFacts: context.omittedFacts,
    ...(repaired.repair ? { quoteRepair: repaired.repair } : {}),
    ...extra,
  };
}

/** 核得上的原句换成正文原字（模型常多打空格、少抄引号）：清单、账里、设定本给作者看的都是正文里那一段。 */
function withOriginalQuotes(parsed: KeeperParseResult, draft: string): KeeperParseResult {
  const original = (quote: string): string => (quote ? (quoteFromText(quote, draft) ?? quote) : quote);
  const entries = parsed.entries.map((entry) => {
    if (entry.kind === "time") return mapTimeQuotes(entry, original);
    if (!("quote" in entry) || !entry.quote) return entry;
    const fixed = original(entry.quote);
    return fixed !== entry.quote ? ({ ...entry, quote: fixed } as EntryInput) : entry;
  });
  return { ...parsed, entries };
}

/** 时间声明里的每一句原句（开头那句、各次换天、各段首末句）过一遍 map。 */
function mapTimeQuotes(time: TimeInput, map: (quote: string) => string): TimeInput {
  return {
    ...time,
    ...(time.start && time.start !== "unknown" ? { start: { ...time.start, quote: map(time.start.quote) } } : {}),
    ...(time.dayChanges ? { dayChanges: time.dayChanges.map((change) => (change.quote !== undefined ? { ...change, quote: map(change.quote) } : change)) } : {}),
    ...(time.segments ? { segments: time.segments.map((segment) => ({ ...segment, firstQuote: map(segment.firstQuote), lastQuote: map(segment.lastQuote) })) } : {}),
  };
}

/** 时间声明里要补的一处：开头那句、第几次换天那句、第几段在哪。 */
type TimeSlot = { readonly kind: "start" } | { readonly kind: "dayChange"; readonly index: number } | { readonly kind: "segment"; readonly index: number };

const FRAME_LABELS: Record<SegmentInput["frame"], string> = { past: "回忆、倒叙", other: "梦、想象、传闻" };

/** 时间声明里原句对不上正文的几处（附了却找不到、该附没附；段的首末句对不回句子）。 */
function timeSlotsToRepair(time: TimeInput, draft: string): TimeSlot[] {
  const source = chapterSource(0, draft);
  const slots: TimeSlot[] = [];
  if (time.start && time.start !== "unknown" && !quoteInText(time.start.quote, draft)) slots.push({ kind: "start" });
  (time.dayChanges ?? []).forEach((change, index) => {
    if (!change.quote || !quoteInText(change.quote, draft)) slots.push({ kind: "dayChange", index });
  });
  (time.segments ?? []).forEach((segment, index) => {
    if (typeof locateSegment(segment, source) === "string") slots.push({ kind: "segment", index });
  });
  return slots;
}

function slotLabel(time: TimeInput, slot: TimeSlot): { readonly label: string; readonly wrote: string } {
  switch (slot.kind) {
    case "start":
      return { label: "时间：说明本章开头离上一个当下章多久的那句", wrote: time.start && time.start !== "unknown" ? time.start.quote : "" };
    case "dayChange":
      return { label: `时间：本章第 ${slot.index + 1} 次换天、新的一天开头那句`, wrote: time.dayChanges?.[slot.index]?.quote ?? "" };
    case "segment": {
      const segment = time.segments?.[slot.index];
      return {
        label: `不在当下的第 ${slot.index + 1} 段（${segment ? FRAME_LABELS[segment.frame] : ""}）：点这段从第几句到第几句（点头一句和最后一句，不限 ${QUOTE_REPAIR_UNITS} 句）`,
        wrote: segment ? `${segment.firstQuote || "（没写）"} …… ${segment.lastQuote || "（没写）"}` : "",
      };
    }
  }
}

/**
 * 时间声明里核不上的原句怎么落（补摘之后；模型声明要带证据，核不上不硬记）：
 *  - 本章开头那句对不上 → 隔多久不记，按「在当下线上、说不出隔多久」记；
 *  - 换天那句对不上 → 换天照记、不附那句（章末照算，哪句开始是新的一天不知道，设计 2.2）；
 *  - 段对不回句子 → 那段不记（如实说，段里的事按当下记了）；整章是段的，整条时间没记上。
 * 都在清单「改过的」「没记上的」里如实说。
 */
export function settleTime(parsed: KeeperParseResult, draft: string): KeeperParseResult {
  const index = parsed.entries.findIndex((entry) => entry.kind === "time");
  const found = index >= 0 ? parsed.entries[index] : undefined;
  if (!found || found.kind !== "time") return parsed;
  const slots = timeSlotsToRepair(found, draft);
  if (slots.length === 0) return parsed;
  const adjusted = [...parsed.adjusted];
  const drops = [...parsed.drops];
  let time: TimeInput = found;
  if (slots.some((slot) => slot.kind === "start")) {
    time = { ...time, start: "unknown" };
    adjusted.push({ where: "time.start", reason: "说明本章开头离上一章多久的那句在正文里找不到，按说不出隔多久记" });
  }
  const changeSlots = new Set(slots.flatMap((slot) => (slot.kind === "dayChange" ? [slot.index] : [])));
  if (changeSlots.size > 0) {
    time = { ...time, dayChanges: (time.dayChanges ?? []).map((change, at) => (changeSlots.has(at) ? (({ quote: _quote, ...rest }) => rest)(change) : change)) };
    adjusted.push({ where: "time.dayChanges", reason: "换天那句在正文里找不到：章末照记，哪句开始是新的一天不知道" });
  }
  const segmentSlots = new Set(slots.flatMap((slot) => (slot.kind === "segment" ? [slot.index] : [])));
  if (segmentSlots.size > 0) {
    const kept = (time.segments ?? []).filter((_segment, at) => !segmentSlots.has(at));
    const { segments: _segments, ...rest } = time;
    time = kept.length > 0 ? { ...rest, segments: kept } : rest;
    for (const at of segmentSlots) {
      const frame = found.segments?.[at]?.frame;
      drops.push({ where: `segments 第 ${at + 1} 段`, reason: `这段${frame ? FRAME_LABELS[frame] : ""}的首句、末句在正文里对不上，没记成段，段里的事按当下记了` });
    }
  }
  const entries = [...parsed.entries];
  if (time.start === undefined && (time.segments ?? []).length === 0) {
    entries.splice(index, 1);
    drops.push({ where: "time", reason: "整章是回忆、梦这类段，但段对不上正文，本章时间没记上" });
  } else entries[index] = time;
  return { ...parsed, entries, adjusted, drops };
}

/** 一次最多补摘几条（再多说明这份账单整体不靠谱，不值得再花一次长调用）。 */
export const QUOTE_REPAIR_MAX = 12;

/**
 * 原句补摘：用和定稿同一个核对（checkEntries）找出原句对不上的条目，在同一段对话里请记账员只为这几条点出正文里的句子编号，
 * 代码按编号取回原句（外部审查 2026-10-28：再让它抄一遍还是会抄错——第 28 章出场「老板娘」、两条线索重摘了照样对不上）。
 * 时间声明里对不上的几处（开头那句、换天那句、段的首末句）一并补点：段点的是从第几句到第几句，代码直接记句子编号。
 * 取回的原句照样过同一个核对；补摘调用失败、交回来读不了，都照第一遍的交（最后由 settleTime 和定稿清单如实列出）。
 */
async function repairQuotes(
  parsed: KeeperParseResult,
  input: KeeperInput,
  conversation: readonly BrainMessage[],
): Promise<{ parsed: KeeperParseResult; repair?: QuoteRepair }> {
  const broken = checkEntries(parsed.entries, input.draft, input.before).rejected
    .filter((item) => item.reason === "quote_not_in_text" && item.entry.kind !== "time")
    .slice(0, QUOTE_REPAIR_MAX);
  const timeIndex = parsed.entries.findIndex((entry) => entry.kind === "time");
  const time = timeIndex >= 0 ? (parsed.entries[timeIndex] as TimeInput) : undefined;
  const slots = time ? timeSlotsToRepair(time, input.draft).slice(0, Math.max(0, QUOTE_REPAIR_MAX - broken.length)) : [];
  const asked = broken.length + slots.length;
  if (asked === 0) return { parsed };
  const units = splitUnits(input.draft);
  let reply: string;
  try {
    const ask = buildQuoteRepairTask(
      [...broken.map((item) => ({ label: repairLabel(item.entry), wrote: "quote" in item.entry ? item.entry.quote : "" })), ...slots.map((slot) => slotLabel(time as TimeInput, slot))],
      numberedText(units),
    );
    reply = await withStep("记账员补摘原句", () => input.callModel([...conversation, { role: "user", content: ask }], { json: true }));
  } catch (error) {
    rethrowIfStopped(error);
    return { parsed, repair: { asked, fixed: 0, failed: modelFailureText(error) } };
  }
  input.onRawOutput?.(reply);
  const picks = parseQuoteRepairs(reply);
  if (!picks) return { parsed, repair: { asked, fixed: 0, failed: "补摘交回来的不是 JSON" } };
  const quoteOf = (n: number): string | undefined => quoteOfUnits(input.draft, units, picks.get(n) ?? []);
  const entries = [...parsed.entries];
  let fixed = 0;
  broken.forEach((item, position) => {
    const quote = quoteOf(position + 1);
    if (!quote) return;
    // 出场人物的那句里得有正文对他的叫法，不然记不成这个人在场。
    if (item.entry.kind === "presence" && !quote.includes(item.entry.nameUsed)) return;
    const candidate = { ...item.entry, quote } as EntryInput;
    if (checkEntries([candidate], input.draft, input.before).rejected.some((rejected) => rejected.reason === "quote_not_in_text")) return;
    entries[item.index] = candidate;
    fixed += 1;
  });
  if (time) {
    let next: TimeInput = time;
    slots.forEach((slot, position) => {
      const n = broken.length + position + 1;
      if (slot.kind === "segment") {
        const ids = picks.get(n) ?? [];
        const from = units.find((unit) => unit.id === ids[0]);
        const to = units.find((unit) => unit.id === ids.at(-1));
        if (!from || !to || from.id > to.id) return;
        const segments = [...(next.segments ?? [])];
        const segment = segments[slot.index] as SegmentInput;
        segments[slot.index] = { ...segment, firstQuote: input.draft.slice(from.start, from.end), lastQuote: input.draft.slice(to.start, to.end), units: { from: from.id, to: to.id } };
        next = { ...next, segments };
        fixed += 1;
        return;
      }
      const quote = quoteOf(n);
      if (!quote || !quoteInText(quote, input.draft)) return;
      if (slot.kind === "start" && next.start && next.start !== "unknown") next = { ...next, start: { ...next.start, quote } };
      if (slot.kind === "dayChange") next = { ...next, dayChanges: (next.dayChanges ?? []).map((change, at) => (at === slot.index ? { ...change, quote } : change)) };
      fixed += 1;
    });
    entries[timeIndex] = next;
  }
  return { parsed: { ...parsed, entries }, repair: { asked, fixed } };
}

/**
 * 写了本章开头（在当下线上，开头隔多久说不出也算），却没说结尾：既没写整章同一天，也没列换天（或写坏了没记上）。
 * 开头说不出的也问：第 1 章开头总是第 1 天，作者定了开头的也接得上（P3a 评测：第 1 章开头写了不知道、结尾漏了，全书断）。
 */
function endMissing(time: TimeInput | undefined): time is TimeInput {
  return Boolean(time && time.start !== undefined && time.sameDay !== true && (time.dayChanges ?? []).length === 0);
}

/** 追问本章结尾那条 user 消息（单测也用）。 */
export function buildChapterEndTask(numbered: string): string {
  return [
    "你刚交的账单里，time 写了本章开头，但没写本章从开头到结尾是不是同一天（sameDay），也没列换天（dayChanges），本章结尾是哪天就不知道了。请只补这一件：",
    "- 从头到尾都在同一天（从早到晚、从白天到半夜十二点以前都还是同一天），交 {\"sameDay\":true}；",
    "- 中间换了天，逐次列 dayChanges：每次点新的一天开头那句的编号 id，写隔了几天（offset 至少 1 天；要看换天规矩才定的照样用 byBoundary 各写一份，写法和本章开头一样）；",
    `- ${IN_CHAPTER_BOUNDARY.replaceAll("quote 摘", "点")}`,
    "- 正文里实在看不出，交 {\"unknown\":true}。",
    "",
    "下面是本章正文，每句前面是编号。",
    "",
    "【本章正文】",
    numbered,
    "",
    '只交 JSON：{"sameDay":true} 或 {"dayChanges":[{"id":12,"offset":{"unit":"day","min":1,"max":1}}]}',
  ].join("\n");
}

/**
 * 记账员没说本章结尾（P3a 评测：留出书上约 5% 的章漏答）：章末是哪天就断了，后面每章的绝对天数跟着不知道。
 * 在同一段对话里只追问这一件：同一天，或逐次换天（点句子编号，代码取原句）。追问没成、交回来读不了、说看不出，
 * 都照第一遍的交（章末不知道，清单上照实列）；交回来的换天写坏了，照第一遍同样的规矩不记、如实说。
 */
async function askChapterEnd(parsed: KeeperParseResult, input: KeeperInput, conversation: readonly BrainMessage[]): Promise<KeeperParseResult> {
  const index = parsed.entries.findIndex((entry) => entry.kind === "time");
  const time = index >= 0 ? parsed.entries[index] : undefined;
  if (time?.kind !== "time" || !endMissing(time)) return parsed;
  const units = splitUnits(input.draft);
  let reply: string;
  try {
    reply = await withStep("记账员补记结尾", () => input.callModel([...conversation, { role: "user", content: buildChapterEndTask(numberedText(units)) }], { json: true }));
  } catch (error) {
    rethrowIfStopped(error);
    return { ...parsed, adjusted: [...parsed.adjusted, { where: "time", reason: `问本章结尾是哪天没问成（${modelFailureText(error)}），按不知道记` }] };
  }
  input.onRawOutput?.(reply);
  const raw = extractJsonObject(reply);
  if (!raw) return parsed;
  const adjusted = [...parsed.adjusted];
  const end = parseChapterEnd({ ...raw, dayChanges: changesById(raw.dayChanges, units, input.draft) }, adjusted);
  if (end.sameDay === undefined && end.dayChanges === undefined) return { ...parsed, adjusted };
  const entries = [...parsed.entries];
  entries[index] = { ...time, ...end };
  return { ...parsed, entries, adjusted };
}

/** 追问交回来的换天按句子编号点的：代码取那句原句（编号对不上的原句留空，照交账单的规矩不记）。 */
function changesById(list: unknown, units: readonly TextUnit[], draft: string): unknown {
  if (!Array.isArray(list)) return list;
  return list.map((item) => {
    if (item === null || typeof item !== "object") return item;
    const { id, ...rest } = item as Record<string, unknown>;
    const unit = units.find((candidate) => candidate.id === positiveIntLike(id));
    return { ...rest, quote: unit ? draft.slice(unit.start, unit.end) : "" };
  });
}

/**
 * 两种换天规矩只在半夜十二点到天亮之间差一天（这段时间里按半夜已是新的一天、按天亮还是前一天）。
 * 这一章结尾在不在这段时间里：按投影两个世界的天数差算——差比全书到这章为止最小的那个大一天就在。
 * 两个世界哪边不确定、作者定了换天规矩（只推一个世界）、差得不止一天（前面就对不上了），都不知道。
 */
export function endsAtNight(before: BookProjection, chapter: number): boolean | undefined {
  const exact = (range: DayRange | undefined): number | undefined => (range?.lo !== undefined && range.lo === range.hi ? range.lo : undefined);
  const gap = (days: ChapterTime["byWorld"], key: "start" | "end"): number | undefined => {
    const midnight = exact(days.midnight?.[key]);
    const dawn = exact(days.dawn?.[key]);
    return midnight !== undefined && dawn !== undefined ? midnight - dawn : undefined;
  };
  let low = 0;
  let end: number | undefined;
  for (const view of [...before.chapters].sort((a, b) => a.chapter - b.chapter)) {
    if (view.chapter > chapter) break;
    if (view.time.presentLine !== true) continue;
    for (const value of [gap(view.time.byWorld, "start"), gap(view.time.byWorld, "end")]) if (value !== undefined) low = Math.min(low, value);
    if (view.chapter === chapter) end = gap(view.time.byWorld, "end");
  }
  if (end === undefined || end - low > 1) return undefined;
  return end - low === 1;
}

/** 这一处相对天数按半夜规矩比按天亮规矩多几天：只写一份的两种一样（0）；不确定、按月 / 年说的不知道。 */
function nightShift(relative: { readonly offset?: TimeOffset; readonly byBoundary?: BoundaryOffsets }): number | undefined {
  const exact = (offset: TimeOffset): number | undefined => (offset.unit === "day" && offset.min !== undefined && offset.min === offset.max ? offset.min : undefined);
  if (relative.byBoundary) {
    const midnight = exact(relative.byBoundary.midnight);
    const dawn = exact(relative.byBoundary.dawn);
    return midnight !== undefined && dawn !== undefined ? midnight - dawn : undefined;
  }
  return relative.offset?.unit === "day" ? 0 : undefined;
}

/** 本章时间按两种规矩走一遍查出的毛病：哪一处两种规矩差得不可能（at：开头 / 第几次换天），或结尾还在半夜到天亮之间。 */
export type NightIssue =
  | { readonly kind: "impossible"; readonly at: "start" | number; readonly shift: number }
  | { readonly kind: "endsAtNight" };

/**
 * 从上一个当下章结尾（在不在半夜到天亮之间，不知道就从本章自己写的推）起，沿本章开头、各次换天走：
 * 半夜那边多一天 = 进了半夜到天亮之间（之前得不在），天亮那边多一天 = 出了（之前得在），差一天以上不可能。
 * 结尾还在半夜到天亮之间也报（常是凌晨开头、章里讲到天亮以后却没列换天）；是本章列的换天进的半夜（③）不报。开头说不出、哪一处不确定就不往下走。
 * 没有上一个当下章（第 1 章）时开头那处不算（第 1 章开头是原点）。
 */
export function nightIssue(time: TimeInput, previous: { readonly exists: boolean; readonly atNight?: boolean }): NightIssue | undefined {
  if (time.start === undefined || time.start === "unknown") return undefined;
  let state = previous.atNight;
  // 进半夜到天亮之间是本章列的换天（③，记账员明说过了半夜）：结尾没天亮多半就是对的，不问。
  let enteredByChange = false;
  const steps: { readonly at: "start" | number; readonly relative: { readonly offset?: TimeOffset; readonly byBoundary?: BoundaryOffsets } }[] = [
    ...(previous.exists ? [{ at: "start" as const, relative: time.start }] : []),
    ...(time.dayChanges ?? []).map((change, index) => ({ at: index + 1, relative: change })),
  ];
  for (const step of steps) {
    const shift = nightShift(step.relative);
    if (shift === undefined) return undefined;
    if (shift === 0) continue;
    if (Math.abs(shift) > 1 || (shift === 1 && state === true) || (shift === -1 && state === false)) return { kind: "impossible", at: step.at, shift };
    state = shift === 1;
    enteredByChange = step.at !== "start";
  }
  return state === true && !enteredByChange ? { kind: "endsAtNight" } : undefined;
}

/** 复核半夜到天亮那条 user 消息（单测也用）。 */
export function buildNightRecheckTask(issue: NightIssue, previous: number | undefined, numbered: string): string {
  const what = (() => {
    if (issue.kind === "endsAtNight") return "按你记的，本章结尾还在半夜以后、天亮以前（按半夜规矩已经换了天，按天亮规矩还没换）。章里要是讲到了天亮以后，那是一次换天没列（④）。";
    const who = issue.at === "start" ? "本章开头" : `你列的第 ${issue.at} 次换天`;
    const before = issue.at === "start" ? `上一章（第 ${previous} 章）结尾` : "它前面那一刻";
    if (Math.abs(issue.shift) > 1) return `${who}两种规矩差了不止一天，两种规矩最多差一天。`;
    return issue.shift < 0
      ? `${who}按天亮规矩比按半夜规矩多隔一天，这得${before}在半夜以后、天亮以前才对得上；可按记下的，${before}不在这段时间里。`
      : `${who}按半夜规矩比按天亮规矩多隔一天，这得${before}不在半夜到天亮之间才对得上；可按记下的，${before}已经过了半夜、还没天亮。`;
  })();
  return [
    `你刚交的账单里，time 按两种换天规矩对不上：${what}`,
    "两种换天规矩只在半夜十二点到天亮之间差一天：这段时间里按半夜规矩已经是新的一天、按天亮规矩还是前一天；别的时候两种规矩是同一天。请对照正文再看一遍，只交这一件：",
    "- 记错了：交改好的本章时间，只写要改的那几样：start（本章开头离上一章结尾隔几天，写法同交账单，不用再附 quote）、sameDay 或 dayChanges（逐次点新的一天开头那句的编号 id，写法同交账单）；",
    ...(issue.kind === "endsAtNight"
      ? ['- 没记错，本章到结尾确实还没天亮：交 {"keep":true}；']
      : issue.at === "start" ? ['- 本章没记错，是上一章记的结尾不对：交 {"keep":true}；'] : []),
    '- 正文里看不出：交 {"unknown":true}。',
    "",
    "下面是本章正文，每句前面是编号。",
    "",
    "【本章正文】",
    numbered,
    "",
    '只交 JSON：{"start":{"offset":{"unit":"day","min":1,"max":1}},"dayChanges":[{"id":12,"byBoundary":{"midnight":{"unit":"day","min":0,"max":0},"dawn":{"unit":"day","min":1,"max":1}}}]}',
  ].join("\n");
}

/**
 * 记账员按两种换天规矩记的本章时间自相矛盾，或结尾还在半夜到天亮之间（P3a 评测：凌晨开头记对了、章里讲到天亮以后却写同一天，
 * 天亮规矩那边后面每章少一天；上一章没过半夜、本章开头却写半夜 0 天天亮 1 天）：在同一段对话里只复核这一件。
 * 改了、按两种规矩走得通就换（开头的原句照第一遍的；换天点句子编号、代码取原句）；说没记错、看不出、没问成、改了还不通，
 * 都照第一遍交——走不通的如实记一条说明，只是结尾没天亮的不记（本来就可能是对的）。
 */
async function recheckNight(parsed: KeeperParseResult, input: KeeperInput, conversation: readonly BrainMessage[]): Promise<KeeperParseResult> {
  const index = parsed.entries.findIndex((entry) => entry.kind === "time");
  const time = index >= 0 ? parsed.entries[index] : undefined;
  if (time?.kind !== "time" || time.start === undefined || time.start === "unknown") return parsed;
  const previous = previousPresentChapter(input.before, input.chapter);
  const atNight = previous === undefined ? undefined : endsAtNight(input.before, previous);
  const where = { exists: previous !== undefined, ...(atNight !== undefined ? { atNight } : {}) };
  const issue = nightIssue(time, where);
  if (!issue) return parsed;
  const keep = (why: string): KeeperParseResult =>
    issue.kind === "endsAtNight" ? parsed : { ...parsed, adjusted: [...parsed.adjusted, { where: "time", reason: `本章开头、换天按半夜和天亮两种规矩记的对不上，${why}，照第一遍记的` }] };
  const units = splitUnits(input.draft);
  let reply: string;
  try {
    reply = await withStep("记账员复核半夜到天亮", () => input.callModel([...conversation, { role: "user", content: buildNightRecheckTask(issue, previous, numberedText(units)) }], { json: true }));
  } catch (error) {
    rethrowIfStopped(error);
    return keep(`复核没问成（${modelFailureText(error)}）`);
  }
  input.onRawOutput?.(reply);
  const raw = extractJsonObject(reply);
  if (!raw) return keep("复核交回来的读不了");
  if (flag(raw.keep) === true || flag(raw.unknown) === true) return keep(flag(raw.keep) === true ? "复核说本章没记错" : "复核说看不出");
  const start = typeof raw.start === "object" && raw.start !== null && !Array.isArray(raw.start) ? relativeOf(raw.start as Record<string, unknown>) : undefined;
  if (typeof start === "string") return keep(`复核改的开头${start}`);
  const adjusted = [...parsed.adjusted];
  const end = raw.sameDay !== undefined || raw.dayChanges !== undefined ? parseChapterEnd({ sameDay: raw.sameDay, dayChanges: changesById(raw.dayChanges, units, input.draft) }, adjusted) : undefined;
  if (!start && (!end || (end.sameDay === undefined && end.dayChanges === undefined))) return keep("复核没交改好的时间");
  const { sameDay: _sameDay, dayChanges: _dayChanges, ...rest } = time;
  const fixed: TimeInput = {
    ...(end && (end.sameDay !== undefined || end.dayChanges !== undefined) ? { ...rest, ...end } : time),
    start: start ? { ...start, basis: time.start.basis, quote: time.start.quote } : time.start,
  };
  if (nightIssue(fixed, where)?.kind === "impossible") return keep("复核改了还是对不上");
  const entries = [...parsed.entries];
  entries[index] = fixed;
  return { ...parsed, entries, adjusted };
}

/** 开头离上一个当下章结尾确定隔几天（两种换天规矩一样）；不确定、只写了一种的不算。 */
function startDays(start: TimeInput["start"]): number | undefined {
  if (start === undefined || start === "unknown") return undefined;
  const exact = (offset: TimeOffset): number | undefined => (offset.unit === "day" && offset.min !== undefined && offset.min === offset.max ? offset.min : undefined);
  if ("byBoundary" in start && start.byBoundary) {
    const midnight = exact(start.byBoundary.midnight);
    return midnight !== undefined && midnight === exact(start.byBoundary.dawn) ? midnight : undefined;
  }
  return "offset" in start && start.offset ? exact(start.offset) : undefined;
}

const weekdayAfter = (weekday: number, days: number): number => (((weekday + days) % 7) + 7) % 7;

/** 复核星期那条 user 消息（单测也用）。 */
export function buildWeekdayRecheckTask(wrote: number, previous: number, previousWeekday: number, days: number): string {
  const name = (weekday: number) => WEEKDAY_NAMES[weekday];
  return [
    `你刚交的账单里，本章写的是${name(wrote)}；上一个当下章（第 ${previous} 章）结尾是${name(previousWeekday)}，按你写的开头离它 ${days} 天，本章开头该是${name(weekdayAfter(previousWeekday, days))}，对不上。请对照正文再看一遍，只交这一件：`,
    '- 隔的天数写错了：交改好的开头离上一个当下章结尾隔几天，写法同交账单（{"offset":{"unit":"day","min":2,"max":2}}，要看换天规矩才定的写 byBoundary），往回接的写负数；',
    '- 隔的天数没错，是星期写错了、或那个星期说的不是本章开头那天：交 {"weekday":null}；',
    '- 正文里看不出哪个对：交 {"unknown":true}。',
    "只交 JSON。",
  ].join("\n");
}

/**
 * 记账员写的本章星期，和按它写的开头、上一个当下章结尾的星期（投影推的）算出来的对不上（P3a 评测：上一章周二、本章「周四下午」记成隔 1 天）：
 * 在同一段对话里只复核这一件。改了隔几天、算得上就换（原句照第一遍的）；说星期不是本章开头那天就不记星期；
 * 没问成、看不出、改了还对不上，都照第一遍交，如实记一条说明（清单上照实列）。
 */
async function recheckWeekday(parsed: KeeperParseResult, input: KeeperInput, conversation: readonly BrainMessage[]): Promise<KeeperParseResult> {
  const index = parsed.entries.findIndex((entry) => entry.kind === "time");
  const time = index >= 0 ? parsed.entries[index] : undefined;
  if (time?.kind !== "time" || time.weekday === undefined || time.start === undefined || time.start === "unknown") return parsed;
  const days = startDays(time.start);
  const previous = previousPresentChapter(input.before, input.chapter);
  const previousWeekday = previous === undefined ? undefined : endingWeekday(input.before, previous);
  if (days === undefined || previous === undefined || previousWeekday === undefined || weekdayAfter(previousWeekday, days) === time.weekday) return parsed;
  const keep = (why: string): KeeperParseResult => ({
    ...parsed,
    adjusted: [...parsed.adjusted, { where: "time.weekday", reason: `本章写的${WEEKDAY_NAMES[time.weekday as number]}和按开头推的${WEEKDAY_NAMES[weekdayAfter(previousWeekday, days)]}对不上，${why}，照第一遍记的` }],
  });
  let reply: string;
  try {
    reply = await withStep("记账员复核星期", () => input.callModel([...conversation, { role: "user", content: buildWeekdayRecheckTask(time.weekday as number, previous, previousWeekday, days) }], { json: true }));
  } catch (error) {
    rethrowIfStopped(error);
    return keep(`复核没问成（${modelFailureText(error)}）`);
  }
  input.onRawOutput?.(reply);
  const raw = extractJsonObject(reply);
  if (!raw) return keep("复核交回来的读不了");
  const entries = [...parsed.entries];
  if ("weekday" in raw && (raw.weekday === null || raw.weekday === "")) {
    const { weekday: _weekday, ...rest } = time;
    entries[index] = rest;
    return { ...parsed, entries };
  }
  if (raw.offset === undefined && raw.byBoundary === undefined) return keep("复核说看不出");
  const relative = relativeOf(raw);
  const fixed = typeof relative === "string" ? undefined : startDays({ ...relative, basis: time.start.basis, quote: time.start.quote });
  if (typeof relative === "string" || fixed === undefined || weekdayAfter(previousWeekday, fixed) !== time.weekday) return keep("复核改了还是对不上");
  entries[index] = { ...time, start: { ...relative, basis: time.start.basis, quote: time.start.quote } };
  return { ...parsed, entries };
}

/** 补摘要求里每条怎么称呼（只给记账员看，不进清单）。时间那几处另列（slotLabel）。 */
function repairLabel(entry: EntryInput): string {
  switch (entry.kind) {
    case "summary":
      return `梗概：${entry.text}`;
    case "fact":
      return `事实：${entry.text}`;
    case "thread":
      return entry.op === "open" ? `新开线索「${entry.title ?? entry.note}」：${entry.note}` : `${entry.op === "close" ? "收口" : "推进"}：${entry.note}`;
    case "presence":
      return `出场人物：${entry.name}（原句里必须有「${entry.nameUsed}」这几个字）`;
    case "time":
    case "day":
      return "时间";
  }
}

/** 补点时一条最多点几句（要挨着）。 */
export const QUOTE_REPAIR_UNITS = 2;

/** items：要补的每一条（怎么称呼、第一遍写的）；numbered：本章正文的编号句子。 */
export function buildQuoteRepairTask(items: readonly { readonly label: string; readonly wrote: string }[], numbered: string): string {
  const lines = items.map((item, index) => `${index + 1}. ${item.label}\n   你写的：${item.wrote || "（没写）"}`);
  return [
    "你刚交的账单里，下面几条附的 quote 在本章正文里逐字找不到（或没写）：",
    ...lines,
    "",
    "下面是本章正文，每句前面是编号。请为每条点出正文里能说明它的那一句的编号，不用再抄原句，代码按编号取原文。" +
      `一句说不全可以点挨着的 ${QUOTE_REPAIR_UNITS} 句；出场人物点的那句里要有括号里那几个字。`,
    "正文里实在没有能说明它的句子，ids 给 []，那条不记。",
    "",
    "【本章正文】",
    numbered,
    "",
    '只交 JSON：{"quotes":[{"n":1,"ids":[12]}]}',
  ].join("\n");
}

/** 每条点的编号（去重、排好）；不是 JSON 就 undefined。 */
function parseQuoteRepairs(text: string): Map<number, number[]> | undefined {
  const list = extractJsonObject(text)?.quotes;
  if (!Array.isArray(list)) return undefined;
  const picks = new Map<number, number[]>();
  for (const item of list) {
    const record = item as { n?: unknown; ids?: unknown } | null;
    const n = positiveIntLike(record?.n);
    const ids = Array.isArray(record?.ids) ? record.ids.map(positiveIntLike).filter((id): id is number => id !== undefined) : [];
    if (n !== undefined && ids.length > 0) picks.set(n, [...new Set(ids)].sort((a, b) => a - b));
  }
  return picks;
}

/** 按编号取回原句：头一句，后面紧挨着的再带上（最多 QUOTE_REPAIR_UNITS 句）；编号不在本章就没有。 */
export function quoteOfUnits(draft: string, units: readonly TextUnit[], ids: readonly number[]): string | undefined {
  const byId = new Map(units.map((unit) => [unit.id, unit] as const));
  const first = byId.get(ids[0] ?? 0);
  if (!first) return undefined;
  let last = first;
  for (const id of ids.slice(1, QUOTE_REPAIR_UNITS)) {
    const unit = byId.get(id);
    if (!unit || unit.id !== last.id + 1 || unit.line !== last.line) break;
    last = unit;
  }
  return draft.slice(first.start, last.end);
}
