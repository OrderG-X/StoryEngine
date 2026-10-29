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
import { chapterTextPath, checkEntries, numberedText, quoteFromText, quoteInText, readCards, splitUnits, type BookProjection, type EntryInput, type TextUnit } from "@actalk/story-core";
import { positiveIntLike } from "../lib/lenient-args.js";
import { rethrowIfStopped } from "../lib/operations/context.js";
import { withStep } from "../lib/token-meter.js";
import { buildKeeperContext, type ReopenableThread } from "./keeper-context.js";
import { extractJsonObject, parseKeeperOutput, type KeeperParseResult } from "./keeper-parse.js";
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

/** 交账单的要求（通用写法，绝不写进具体书名、人名）。 */
export const KEEPER_SPEC: readonly string[] = [
  "把这一章引起的变化列成一份账单。题材中立：只记正文真实写到的，不臆造、不补剧情、不预设走向。",
  "每一条都必须附 quote：一句逐字摘自本章正文的原句（可以含标点，不能改写、拼接、自己造句）。代码会逐字核对，对不上的那条不记。",
  "- 摘法：照抄正文里连续的一段，至少 4 个字。正文写「他」「她」就照抄「他」「她」，不要换成名字（正文写名字也不要换成「他」）；不要换人称；对话中间夹着「某某说」时只摘一边，要跨过去就在中间写……；不要删字、加字、换词。",
  "",
  "summary：本章梗概。text 用你自己的话一句话说清谁做了什么、结果怎样，不超过 60 个字（不要照抄原句）；quote 引最能代表本章的那句。",
  "",
  "time：每章都给（第 1 章没有上一章，只写星期、时段，没有就省略整个 time）。",
  "- 换天以天亮为界：天亮之前（夜里、半夜、鸡叫、天还没亮）都算前一天的夜里；天亮以后（清晨、早上、晌午）才是新的一天。",
  "- daysSincePrevious = 本章开头离上一章结尾隔了几天：同一天 0，「第二天」1，「三天后」3。正文明写了就照写、basis 填 text；没明写就对照上一章结尾（下面【上一章结尾】是原文）和本章开头判断、basis 填 judged（上一章结尾在夜里、本章开头接着当晚的事、天还没亮就是 0；本章开头已经天亮了，哪怕离上一章结尾只隔一两个时辰、只睡了一觉，也是 1；本章开头做的正是上一章约到「明天」「第二天」的事，或者本章里说「昨天」指的是上一章的事，也是 1）。只有确实判断不了才不填这个数。",
  "- daysInChapter = 本章从开头到结尾又过了几天，每章都填：整章在同一天写 0。从早到晚、从白天到深夜都还是同一天。只有正文写到换了天（「第二天早上」「天亮了」「隔了一夜」这类），才写 1 或更多，并在 dayChangeQuote 里逐字摘那句换天的原句；本章开头天还没亮、后面写到了白天（晌午、日头偏西这类），就是跨过了天亮、写 1，dayChangeQuote 摘第一句已经是白天的原句；找不出这样一句，就是同一天、写 0。代码会核对这句，核不上就按同一天记。",
  "- weekday 只填正文明写的星期，写成「周二」这样；没写就不填，不要自己推算。timeOfDay 填正文写的时段（「傍晚」）。",
  "- quote 引最能说明时间的那句原句。不要写「故事第几天」，那由代码按上表算。",
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
  "",
  "没有的类就给空数组或省略。只输出一个 JSON 对象，键为 summary、time、presence、facts、threads，形如：",
  '{"summary":{"text":"…","quote":"…"},"time":{"basis":"judged","daysSincePrevious":1,"daysInChapter":0,"timeOfDay":"清晨","quote":"…"},"presence":[{"name":"…","nameUsed":"…","viewpoint":true,"quote":"…"},{"name":"…","nameUsed":"那人","generic":true,"quote":"…"}],"facts":[{"nature":"state","subject":"…","attribute":"…","value":"…","text":"…","quote":"…"}],"threads":[{"op":"open","type":"question","title":"…","note":"…","quote":"…"},{"op":"advance","thread":"T2","note":"…","quote":"…"}]}',
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

function oneLine(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error)).trim().split(/\s+/u).join(" ");
  return text.length > 160 ? `${text.slice(0, 160)}…` : text || "未知错误";
}

/** 上一章结尾摘多少字给记账员对时间（判断本章开头隔了几天）。 */
export const PREVIOUS_ENDING_CHARS = 160;

/** 上一章定稿正文的最后一小段（没有上一章、读不到就是空串）。 */
async function previousEnding(projectDir: string, chapter: number): Promise<string> {
  if (chapter <= 1) return "";
  try {
    const text = (await readFile(join(projectDir, chapterTextPath(chapter - 1)), "utf-8")).trim();
    return text.length > PREVIOUS_ENDING_CHARS ? `…${text.slice(-PREVIOUS_ENDING_CHARS)}` : text;
  } catch {
    return "";
  }
}

/** 拼给记账员的那条 user 消息（单测和考卷也用）。 */
export function buildKeeperTask(chapter: number, draft: string, contextText: string, ending = ""): string {
  return [
    `【第 ${chapter} 章 正文（待定稿，上面还没给过你）】\n${draft}`,
    contextText,
    ending ? `【上一章结尾】\n${ending}` : "",
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
      waitingAs: "记账",
    }));
  } catch (error) {
    rethrowIfStopped(error);
    return { ok: false, reason: `记账员读前文没成：${oneLine(error)}`, cause: error };
  }
  const extra = { ...(cold ? { cold } : {}), ...(waited ? { waited } : {}) };
  const cards = await readCards(input.projectDir).catch(() => undefined);
  const context = buildKeeperContext(input.before, input.draft, input.reopenable, cards);
  const task = buildKeeperTask(input.chapter, input.draft, context.text, await previousEnding(input.projectDir, input.chapter));
  let text: string;
  try {
    text = await withStep("记账员", () => input.callModel([...window, { role: "user", content: task }], { json: true }));
  } catch (error) {
    rethrowIfStopped(error);
    return { ok: false, reason: `记账员没交上账单：${oneLine(error)}`, cause: error, ...extra };
  }
  input.onRawOutput?.(text);
  const parsed = parseKeeperOutput(text, context);
  if (!parsed) return { ok: false, reason: "记账员交回来的不是一份能读的账单（不是 JSON 对象）", ...extra };
  const repaired = await repairQuotes(parsed, input, [...window, { role: "user", content: task }, { role: "assistant", content: text }]);
  return {
    ok: true,
    parsed: settleDayChange(withOriginalQuotes(repaired.parsed, input.draft), input.draft),
    omittedThreads: context.omittedThreads,
    omittedFacts: context.omittedFacts,
    ...(repaired.repair ? { quoteRepair: repaired.repair } : {}),
    ...extra,
  };
}

/** 核得上的原句换成正文原字（模型常多打空格、少抄引号）：清单、账里、设定本给作者看的都是正文里那一段。 */
function withOriginalQuotes(parsed: KeeperParseResult, draft: string): KeeperParseResult {
  const entries = parsed.entries.map((entry) => {
    if (!("quote" in entry) || !entry.quote) return entry;
    const original = quoteFromText(entry.quote, draft);
    return original && original !== entry.quote ? ({ ...entry, quote: original } as EntryInput) : entry;
  });
  return { ...parsed, entries };
}

/**
 * 章里换天要有原句（模型声明要带证据）：记账员说本章中间过了几天，就得摘出换天的那句，
 * 代码拿正文逐字核对；没摘、核不上（补摘也没补出来），就按整章同一天记，并在清单「改过的」里如实说。
 * 章里凭空多出一天，后面每章的故事日都跟着错，比少记一处更伤。
 */
export function settleDayChange(parsed: KeeperParseResult, draft: string): KeeperParseResult {
  const index = parsed.entries.findIndex((entry) => entry.kind === "time");
  const time = index >= 0 ? parsed.entries[index] : undefined;
  if (!time || time.kind !== "time" || !time.daysInChapter) return parsed;
  if (dayChangeProven(parsed, draft)) return parsed;
  const { daysInChapter: _dropped, ...sameDay } = time;
  const entries = [...parsed.entries];
  entries[index] = sameDay;
  const reason = parsed.dayChangeQuote ? "说本章中间换了天，摘的那句在正文里找不到，按整章同一天记" : "说本章中间换了天，没摘换天的那句，按整章同一天记";
  return { ...parsed, entries, adjusted: [...parsed.adjusted, { where: "time", reason }] };
}

const dayChangeProven = (parsed: KeeperParseResult, draft: string): boolean =>
  parsed.dayChangeQuote !== undefined && quoteInText(parsed.dayChangeQuote, draft);

/** 说本章中间换了天、却没摘出核得上的换天原句：要补摘的那几天。 */
function dayChangeToRepair(parsed: KeeperParseResult, draft: string): number | undefined {
  const time = parsed.entries.find((entry) => entry.kind === "time");
  if (!time || time.kind !== "time" || !time.daysInChapter || dayChangeProven(parsed, draft)) return undefined;
  return time.daysInChapter;
}

/** 一次最多补摘几条（再多说明这份账单整体不靠谱，不值得再花一次长调用）。 */
export const QUOTE_REPAIR_MAX = 12;

/**
 * 原句补摘：用和定稿同一个核对（checkEntries）找出原句对不上的条目，在同一段对话里请记账员只为这几条点出正文里的句子编号，
 * 代码按编号取回原句（外部审查 2026-10-28：再让它抄一遍还是会抄错——第 28 章出场「老板娘」、两条线索重摘了照样对不上）。
 * 说本章中间换了天却没摘出换天原句的，也在这次一并补点（多数是漏写了 dayChangeQuote，判断本身没错）。
 * 取回的原句照样过同一个核对；补摘调用失败、交回来读不了，都照第一遍的交（最后由定稿清单如实列出没记上的）。
 */
async function repairQuotes(
  parsed: KeeperParseResult,
  input: KeeperInput,
  conversation: readonly BrainMessage[],
): Promise<{ parsed: KeeperParseResult; repair?: QuoteRepair }> {
  const broken = checkEntries(parsed.entries, input.draft, input.before).rejected.filter((item) => item.reason === "quote_not_in_text").slice(0, QUOTE_REPAIR_MAX);
  const dayChange = dayChangeToRepair(parsed, input.draft);
  const asked = broken.length + (dayChange ? 1 : 0);
  if (asked === 0) return { parsed };
  const units = splitUnits(input.draft);
  let reply: string;
  try {
    const ask = buildQuoteRepairTask(broken.map((item) => item.entry), numberedText(units), dayChange ? { days: dayChange, ...(parsed.dayChangeQuote ? { wrote: parsed.dayChangeQuote } : {}) } : undefined);
    reply = await withStep("记账员补摘原句", () => input.callModel([...conversation, { role: "user", content: ask }], { json: true }));
  } catch (error) {
    rethrowIfStopped(error);
    return { parsed, repair: { asked, fixed: 0, failed: oneLine(error) } };
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
  const dayQuote = dayChange ? quoteOf(broken.length + 1) : undefined;
  const dayFixed = dayQuote !== undefined && quoteInText(dayQuote, input.draft);
  if (dayFixed) fixed += 1;
  return {
    parsed: { ...parsed, entries, ...(dayFixed ? { dayChangeQuote: dayQuote } : {}) },
    repair: { asked, fixed },
  };
}

/** 补摘要求里每条怎么称呼（只给记账员看，不进清单）。 */
function repairLabel(entry: EntryInput): string {
  switch (entry.kind) {
    case "summary":
      return `梗概：${entry.text}`;
    case "fact":
      return `事实：${entry.text}`;
    case "thread":
      return entry.op === "open" ? `新开线索「${entry.title ?? entry.note}」：${entry.note}` : `${entry.op === "close" ? "收口" : "推进"}：${entry.note}`;
    case "time":
      return "时间";
    case "presence":
      return `出场人物：${entry.name}（原句里必须有「${entry.nameUsed}」这几个字）`;
  }
}

/** 补点时一条最多点几句（要挨着）。 */
export const QUOTE_REPAIR_UNITS = 2;

/** dayChange：说本章中间过了几天、却没摘出核得上的换天原句（排在最后一条）。numbered：本章正文的编号句子。 */
export function buildQuoteRepairTask(entries: readonly EntryInput[], numbered: string, dayChange?: { readonly days: number; readonly wrote?: string }): string {
  const lines = entries.map((entry, index) => `${index + 1}. ${repairLabel(entry)}\n   你写的：${"quote" in entry && entry.quote ? entry.quote : "（没写）"}`);
  if (dayChange) {
    lines.push(`${entries.length + 1}. 本章中间换天的那句（你说本章从开头到结尾过了 ${dayChange.days} 天）\n   你写的：${dayChange.wrote ?? "（没写）"}`);
  }
  return [
    "你刚交的账单里，下面几条附的 quote 在本章正文里逐字找不到（或没写）：",
    ...lines,
    "",
    "下面是本章正文，每句前面是编号。请为每条点出正文里能说明它的那一句的编号，不用再抄原句，代码按编号取原文。" +
      `一句说不全可以点挨着的 ${QUOTE_REPAIR_UNITS} 句；出场人物点的那句里要有括号里那几个字。`,
    `正文里实在没有能说明它的句子，ids 给 []，那条不记${dayChange ? "（换天那条给 []，就按整章同一天记）" : ""}。`,
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
