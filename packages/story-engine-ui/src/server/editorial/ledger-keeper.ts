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
import { checkEntries, type BookProjection, type EntryInput } from "@actalk/story-core";
import { withStep } from "../lib/token-meter.js";
import { buildKeeperContext } from "./keeper-context.js";
import { extractJsonObject, parseKeeperOutput, quoteText, type KeeperParseResult } from "./keeper-parse.js";
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
  "- daysSincePrevious = 本章开头离上一章结尾隔了几天：同一天 0，「第二天」1，「三天后」3。正文明写了就照写、basis 填 text；没明写就对照你读过的上一章结尾和本章开头判断、basis 填 judged（上一章结尾在夜里、本章开头接着当晚的事就是 0，隔了一夜才是 1）。只有确实判断不了才不填这个数。",
  "- daysInChapter = 本章从开头到结尾又过了几天（章中间换了天才填；整章同一天就不填）。",
  "- weekday 只填正文明写的星期，写成「周二」这样；没写就不填，不要自己推算。timeOfDay 填正文写的时段（「傍晚」）。",
  "- quote 引最能说明时间的那句原句。不要写「故事第几天」，那由代码按上表算。",
  "",
  "presence：本章出场的每个有名字的人物各一条。",
  "- name 写这个人的已确立名字：上面【本书已出场的人物】里有的，逐字沿用那里的写法；第一次出场的写正文里的名字。",
  "- nameUsed 写本章正文里怎么称呼他（和 name 不同就是别称，代码会记成同一个人）；quote 必须逐字含 nameUsed。",
  "- 正文里冒出的新称呼如果指的是已有的人，name 写那个人的已确立名字、nameUsed 写新称呼，不要当成新人物。同一个人本章只报一条，用最主要的称呼。",
  "- 本章主要跟着谁的眼睛走，就给那个人加 \"viewpoint\": true；多视角或全知叙事就都不加。",
  "",
  "facts：本章写明的、以后写作要守住的事实。",
  "- nature：会随剧情变的写 state——人在哪、东西在谁手里、人和人的关系、伤势病情、谁知道了什么 / 还不知道什么、身份暴没暴露、手头的打算。不会变的写 hard——出身、年纪、长相、过去发生过的事、世界的规则。只是这一章发生过的事写 event。拿不准会不会变的写 event。",
  "- state 和 hard 必须写清 subject（谁或什么）、attribute（哪一方面）、value（是什么）；text 用一句话说清这条事实。",
  "- 同一个人、同一样东西每次都用同一个名字当 subject；同一方面每次都用同一个说法当 attribute，尽量用短的常用说法（在哪、在谁手里、年纪、身份、关系、知道什么）。上面【现在有效的事实】里已经有的人、物和方面，照抄那里的写法——代码按写法认「同一方面」，写法一变，旧的现状就顶替不掉。",
  "- 本章明写推翻了上面【现在有效的事实】里某条不会变的事实（比如揭穿了假身份），在 replaces 里填它的编号（如 [\"F3\"]），quote 引推翻它的那句。会变的事实有了新值不用填 replaces，代码按最新一章算。",
  "- 前文已经记过、本章只是又提了一遍的，不要再记。",
  "",
  "threads：线索——悬念（question）、人物的打算或待办（intent）、主角的目标（goal）。",
  "- op = open 新开：只给正文还没解开、后文需要一个揭晓或回收时刻的问题，以及正文明确留下的后续行动、新立的目标。写 type、title（像个标题，跨章能认出来）、note（本章怎么引出的）、quote。",
  "- op = advance 推进：上面【开着的线索】里某条有了新进展但还没了结。thread 填它的编号（如 \"T3\"）；同一件事前文拆成了几条的，把相关编号都填上（如 [\"T3\", \"T5\"]）。note 写本章推进了什么。",
  "- op = close 收口：谜底写出来了（哪怕只是局部揭晓）、打算做完了或明确放弃了、目标达成了。thread 填编号，note 写怎么了结的。",
  "- 你读过前文：同一件事只报一条；前文立过的问题不要换个说法当新线索再开。开新线索前先自问：正文是不是已经给出答案了？后文会不会真有揭晓它的时刻？它是不是【开着的线索】里某条的另一种说法？答案已给、不会揭晓、或是另一种说法的，都不开——是已有线索的报 advance，纯背景细节不报。",
  "- 同一个谜不要既开「它是什么」又开「为什么是它」两条，报成一条，把疑点写进 note。",
  "- 报 advance 之前先想一遍：它是不是其实已经做完、已经揭晓了？是就报 close，别让它一直挂着。判断待办做没做完，只看那个动作本身：正文写到动作做成了（问过了、找到了、交出去了、打开了），就算完成；做完之后冒出的新问题另开一条。",
  "",
  "没有的类就给空数组或省略。只输出一个 JSON 对象，键为 summary、time、presence、facts、threads，形如：",
  '{"summary":{"text":"…","quote":"…"},"time":{"basis":"judged","daysSincePrevious":1,"timeOfDay":"清晨","quote":"…"},"presence":[{"name":"…","nameUsed":"…","viewpoint":true,"quote":"…"}],"facts":[{"nature":"state","subject":"…","attribute":"…","value":"…","text":"…","quote":"…"}],"threads":[{"op":"open","type":"question","title":"…","note":"…","quote":"…"},{"op":"advance","thread":"T2","note":"…","quote":"…"}]}',
  "不要 Markdown、不要解释、不要多余文字。",
];

export interface KeeperInput {
  readonly projectDir: string;
  readonly chapter: number;
  readonly draft: string;
  /** 算到上一章的投影。 */
  readonly before: BookProjection;
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
  | (KeeperCommon & { readonly ok: false; readonly reason: string });

function oneLine(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error)).trim().split(/\s+/u).join(" ");
  return text.length > 160 ? `${text.slice(0, 160)}…` : text || "未知错误";
}

/** 拼给记账员的那条 user 消息（单测和考卷也用）。 */
export function buildKeeperTask(chapter: number, draft: string, contextText: string): string {
  return [
    `【第 ${chapter} 章 正文（待定稿，上面还没给过你）】\n${draft}`,
    contextText,
    `这一章即将定稿入库。对照你读过的前文原文和记账笔记，交这一章的账单。\n\n${KEEPER_SPEC.join("\n")}`,
  ]
    .filter((part) => part.length > 0)
    .join("\n\n");
}

/**
 * 先确保读到第 N-1 章（缺的笔记按顺序补；太多就走冷窗口），再在窗口后面接一条 user 消息要账单。
 * 坏 JSON、调用失败 → ok=false + 原因，不抛。
 */
export async function runLedgerKeeper(input: KeeperInput): Promise<KeeperOutcome> {
  if (input.draft.trim().length === 0) return { ok: false, reason: "正文是空的，没有可记的账" };
  const root = input.notesRoot ?? input.projectDir;
  let window: BrainMessage[];
  let cold: ColdCoverage | undefined;
  let waited: ReaderWaited | undefined;
  try {
    const waiting = readerWaitingHandlers(root, LEDGER_ROLE.id, input.chapter - 1);
    const ready = await withStep("跟读补笔记", () =>
      ensureReaderWindow({
        projectDir: input.projectDir,
        role: LEDGER_ROLE,
        upTo: input.chapter - 1,
        callModel: input.callModel,
        ...(input.notesRoot ? { notesRoot: input.notesRoot } : {}),
        maxCatchUp: input.maxCatchUp ?? KEEPER_MAX_CATCH_UP,
        waitingAs: "记账",
        onCatchUpBegin: waiting.onCatchUpBegin,
        onProgress: waiting.onProgress,
        onCatchUpEnd: waiting.onCatchUpEnd,
      }),
    );
    waited = ready.waited;
    if (ready.missing > 0) {
      const built = await buildColdReaderWindow({
        projectDir: input.projectDir,
        role: LEDGER_ROLE,
        upTo: input.chapter - 1,
        ...(input.notesRoot ? { notesRoot: input.notesRoot } : {}),
      });
      window = built.messages;
      cold = built.coverage;
    } else {
      window = ready.messages;
    }
  } catch (error) {
    return { ok: false, reason: `记账员读前文没成：${oneLine(error)}` };
  }
  const extra = { ...(cold ? { cold } : {}), ...(waited ? { waited } : {}) };
  const context = buildKeeperContext(input.before, input.draft);
  let text: string;
  try {
    text = await withStep("记账员", () =>
      input.callModel([...window, { role: "user", content: buildKeeperTask(input.chapter, input.draft, context.text) }], { json: true }),
    );
  } catch (error) {
    return { ok: false, reason: `记账员没交上账单：${oneLine(error)}`, ...extra };
  }
  input.onRawOutput?.(text);
  const parsed = parseKeeperOutput(text, context);
  if (!parsed) return { ok: false, reason: "记账员交回来的不是一份能读的账单（不是 JSON 对象）", ...extra };
  const task = buildKeeperTask(input.chapter, input.draft, context.text);
  const repaired = await repairQuotes(parsed, input, [...window, { role: "user", content: task }, { role: "assistant", content: text }]);
  return {
    ok: true,
    parsed: repaired.parsed,
    omittedThreads: context.omittedThreads,
    omittedFacts: context.omittedFacts,
    ...(repaired.repair ? { quoteRepair: repaired.repair } : {}),
    ...extra,
  };
}

/** 一次最多补摘几条（再多说明这份账单整体不靠谱，不值得再花一次长调用）。 */
export const QUOTE_REPAIR_MAX = 12;

/**
 * 原句补摘：用和定稿同一个核对（checkEntries）找出原句对不上的条目，在同一段对话里请记账员只为这几条从正文里重摘一句。
 * 重摘的原句也得核得上才换上去；补摘调用失败、交回来读不了，都照第一遍的交（最后由定稿清单如实列出没记上的）。
 * 模型无关：任何模型都会偶尔把「他」写成名字、跨过「某某说」拼对话——这里不放宽核对，只给一次改正的机会。
 */
async function repairQuotes(
  parsed: KeeperParseResult,
  input: KeeperInput,
  conversation: readonly BrainMessage[],
): Promise<{ parsed: KeeperParseResult; repair?: QuoteRepair }> {
  const broken = checkEntries(parsed.entries, input.draft, input.before).rejected.filter((item) => item.reason === "quote_not_in_text").slice(0, QUOTE_REPAIR_MAX);
  if (broken.length === 0) return { parsed };
  let reply: string;
  try {
    reply = await withStep("记账员补摘原句", () =>
      input.callModel([...conversation, { role: "user", content: buildQuoteRepairTask(broken.map((item) => item.entry)) }], { json: true }),
    );
  } catch (error) {
    return { parsed, repair: { asked: broken.length, fixed: 0, failed: oneLine(error) } };
  }
  input.onRawOutput?.(reply);
  const quotes = parseQuoteRepairs(reply);
  if (!quotes) return { parsed, repair: { asked: broken.length, fixed: 0, failed: "补摘交回来的不是 JSON" } };
  const entries = [...parsed.entries];
  let fixed = 0;
  broken.forEach((item, position) => {
    const quote = quotes.get(position + 1);
    if (!quote) return;
    const candidate = { ...item.entry, quote } as EntryInput;
    if (checkEntries([candidate], input.draft, input.before).rejected.some((rejected) => rejected.reason === "quote_not_in_text")) return;
    entries[item.index] = candidate;
    fixed += 1;
  });
  return { parsed: { ...parsed, entries }, repair: { asked: broken.length, fixed } };
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

export function buildQuoteRepairTask(entries: readonly EntryInput[]): string {
  return [
    "你刚交的账单里，下面几条附的 quote 在本章正文里逐字找不到：",
    ...entries.map((entry, index) => `${index + 1}. ${repairLabel(entry)}\n   你写的：${"quote" in entry ? (entry.quote ?? "（没写）") : "（没写）"}`),
    "请为每条从本章正文里重新摘一句原句：照抄连续的一段，至少 4 个字；「他」「她」照正文抄，不换成名字；不换人称；不跨过「某某说」拼接（要跨就在中间写……）。",
    "正文里实在没有能说明它的句子，就给空串，那条不记。",
    '只交 JSON：{"quotes":[{"n":1,"quote":"…"}]}',
  ].join("\n");
}

function parseQuoteRepairs(text: string): Map<number, string> | undefined {
  const list = extractJsonObject(text)?.quotes;
  if (!Array.isArray(list)) return undefined;
  const quotes = new Map<number, string>();
  for (const item of list) {
    const record = item as { n?: unknown; quote?: unknown } | null;
    const n = typeof record?.n === "number" ? record.n : typeof record?.n === "string" ? Number(record.n.trim()) : Number.NaN;
    const quote = quoteText(record?.quote);
    if (Number.isInteger(n) && n >= 1 && quote) quotes.set(n, quote);
  }
  return quotes;
}
