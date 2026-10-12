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
import { describeTimelineForChapter, findEarlierPassages, readStoryTimeline } from "@actalk/story-engine";
import { resolveConfiguredChatModel, streamChatModelToText } from "../lib/llm-client.js";
import { withStep } from "../lib/token-meter.js";
import {
  containsQuote,
  hedged,
  normalize,
  parseFullReadIssues,
  readEarlierChapters,
  splitSentences,
  type ContinuityIssueV2,
  type EarlierText,
} from "../agent/continuity-v2/check-chapter.js";
import type { ChapterPlan } from "@actalk/story-engine";
import { ensureReaderWindow, type BrainCallModel, type BrainMessage, type ReaderRole } from "./reader-window.js";

export const CHECKER_ROLE: ReaderRole = {
  id: "checker",
  system: [
    "你是这本长篇小说的连续性编辑，从第 1 章起一章一章跟读。",
    "每读完一章，你写一份读书笔记，记下以后核对要用的硬信息。",
    "作者交来新稿时，你对照读过的前文原文和你的笔记，找出新稿里和前文（或和新稿自己更早的位置）对不上的地方。",
  ].join("\n"),
  noteTask: [
    "读完写这一章的笔记（纯文本，800 字以内），只记以后核对要用的硬信息，不复述情节：",
    "- 时间：本章发生在哪天、离上一章过了几天、几点到几点；约好的日子、期限",
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
  "【时间】本章是哪天（按前文推：第几天 / 几月几日 / 星期几，写清怎么推的）、几点到几点；离上一章过了几天；约好的日子、期限",
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

/** 核账提示：先逐条列出新稿里碰到硬信息的说法并对照前文，再把对不上的列为矛盾，每条带把握（sure / maybe）。 */
export function checkTask(chapter: number, focus?: CheckerFocus): string {
  return [
    `这是作者刚交的第 ${chapter} 章新稿（上面还没给过你）。对照你读过的前文原文和笔记，逐段核对：`,
    "1. 先在 checks 里按顺序列出新稿里每一处碰到硬信息的说法：物件在哪、谁拿着、写着什么、有几个；人物年龄、身份、住处、亲属、称呼；几天前、几点、星期、天色；谁知道什么；方位、距离、路上用时；数目。每条一句：说法要点 → 前文怎么写的 → 对得上 / 对不上。新稿自己前后也要核（同一场面的钟点、物件位置、人物位置）。",
    "2. 对不上的放进 contradictions。写了变化过程的、人物明确在撒谎或记错的、只是补充细节的，不算。本来会变的状态（门开关、灯、值班的人）不同时候不一样也不算。",
    "每条 contradictions：quote 逐字抄新稿里有问题的那一句；earlierQuote 逐字抄前文（或新稿更早处）和它冲突的那一句；earlierChapter 写那句在第几章；reason 一句话说哪里对不上；confidence 写 sure（两处不可能同时成立）或 maybe（看着对不上，但也说得通）。抄不出原文的不要报。",
    ...(focus ? [`【这一遍的重点】${CHECKER_FOCUS[focus]}`] : []),
    "只输出一个 JSON：{\"checks\":[\"...\"],\"contradictions\":[{\"quote\":\"\",\"earlierQuote\":\"\",\"earlierChapter\":1,\"reason\":\"\",\"confidence\":\"sure\"}]}",
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
}

/** D 同章的两句至少相隔几句才可能算「确定」：同一个节拍里的两个说法（比如门开着又关上）常被误读成矛盾。 */
export const SURE_GATE_MIN_SENTENCE_GAP = 3;

/**
 * 产品核账缺省用的组合：A 自复核 + F 时间线只进自复核。
 * A 是 T1.1 题库比分选出来的；F 是 R2.1 比分赢的（「确定」查准下限 46.1→47.2、查全 33.9→35.5、小考题误报 0/1/1→0/0/0，
 * 差距和口径见 docs/editorial-room/reports/R2.1-2026-10-12.md）。
 * checkChapterByReader 自己缺省全关（第 1 步原样，单测和评测各自显式传），只有走核账服务的产品路才带这个组合。
 */
export const DEFAULT_READER_VARIANT: ReaderCheckVariant = { selfReview: true, timelineInReview: true };

/** 翻原文那一轮的问法：窗口里有被折叠的章（只看得到笔记）时，问它要翻哪些词的前文原文。 */
export function keywordTask(chapter: number): string {
  return [
    `这是作者刚交的第 ${chapter} 章新稿。前面的章节你只留下了笔记、看不到原文。`,
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
 * 外面套对冲（一次调用迟迟不回就并行再发一份，谁先回来用谁）。空内容抛错，不当成没问题。
 */
export const callConfiguredBrainModel: BrainCallModel = (messages, options) => {
  const once = async () => {
    const resolved = await resolveConfiguredChatModel("qualityCheck");
    const { content } = await streamChatModelToText({
      configured: { ...resolved, thinking: false },
      messages: messages.map((message) => ({ role: message.role, content: message.content })),
      temperature: 0.1,
      ...(options.json ? { responseFormat: { type: "json_object" as const } } : {}),
      maxThinkingMs: 180_000,
      maxContentChars: 60_000,
    });
    if (!content.trim()) throw new Error("模型返回了空内容");
    return content;
  };
  return hedged(once, 120_000);
};

/** 从模型原始 JSON 里按 quote 取把握：sure / 确定 → sure，其余 maybe；同一句出现几次，有一次 sure 就是 sure。 */
function readConfidences(text: string): Map<string, "sure" | "maybe"> {
  const out = new Map<string, "sure" | "maybe">();
  try {
    const parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as { contradictions?: unknown };
    for (const item of Array.isArray(parsed.contradictions) ? parsed.contradictions : []) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const quote = String(record.quote ?? "").trim();
      const said = String(record.confidence ?? "").toLowerCase();
      const sure = /sure|确定/u.test(said) && !/unsure|not sure|不确定|不太确定/u.test(said);
      if (sure || !out.has(quote)) out.set(quote, sure ? "sure" : "maybe");
    }
  } catch {
    // 解析不了就全当 maybe（正文那边 parseFullReadIssues 自己会报「不是 JSON」）
  }
  return out;
}

/** A 自复核的提示：把三遍合并后的候选逐条列出（本章那句、前文那句、理由），让它再判一轮。 */
export function selfReviewTask(chapter: number, issues: readonly ContinuityIssueV2[]): string {
  return [
    `上面是作者刚交的第 ${chapter} 章新稿，你刚才核完报了下面这些对不上的地方。逐条复核一遍：`,
    ...issues.map((issue, index) => [
      `【K${index + 1}】本章那句：${issue.quote}`,
      `  ${issue.earlierChapter === chapter ? "本章更早处" : `第 ${issue.earlierChapter} 章`}那句：${issue.earlierQuote}`,
      `  当时的理由：${issue.reason}`,
    ].join("\n")),
    "每条给一个判断：",
    "sure＝确定是矛盾：同一件事、同一样东西、同一个人，两处说法不可能同时成立，文中也没交代变化过程；",
    "maybe＝可能是：看着对不上，但也说得通（时间没写清、可能是两样东西、中间可能发生了没写的事）；",
    "no＝不是：说的明显不是同一件事或同一时刻（比如前后其实换了一天、换了一个人、换了一样东西），或文中明写了变化，或人物在撒谎记错。",
    "拿不准就给 maybe，不要轻易给 no。只输出一个 JSON：{\"verdicts\":[{\"id\":\"K1\",\"verdict\":\"sure\"}]}，每条都要给。",
  ].join("\n\n");
}

/** A 自复核的判断（判别规则与旧核账的复核一致）：K1 → sure / maybe / no。解析不了返回空表，按原把握保留。 */
export function parseVerdicts(text: string): Map<string, "sure" | "maybe" | "no"> {
  const out = new Map<string, "sure" | "maybe" | "no">();
  try {
    const parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as { verdicts?: unknown };
    for (const item of Array.isArray(parsed.verdicts) ? parsed.verdicts : []) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const id = String(record.id ?? "").trim().toUpperCase();
      const verdict = String(record.verdict ?? record.real ?? "").trim().toLowerCase();
      if (!id) continue;
      if (/^(?:no|false|不是|否)$/u.test(verdict)) out.set(id, "no");
      else if (/^(?:sure|true|确定|是)$/u.test(verdict)) out.set(id, "sure");
      else out.set(id, "maybe");
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

/** 三遍合并：一条的原句包含另一条的算同一条，留先出现的；同一句一遍判 sure、一遍判 maybe 取 sure。 */
function mergePasses(passes: readonly (readonly ContinuityIssueV2[])[]): ContinuityIssueV2[] {
  const merged: ContinuityIssueV2[] = [];
  for (const issue of passes.flat()) {
    const quote = normalize(issue.quote);
    const index = merged.findIndex((other) => { const kept = normalize(other.quote); return kept.includes(quote) || quote.includes(kept); });
    if (index < 0) merged.push(issue);
    else if (issue.confidence === "sure" && merged[index]!.confidence !== "sure") merged[index] = { ...merged[index]!, confidence: "sure" };
  }
  return merged;
}

export interface ReaderCheckResult {
  /** 带 confidence。 */
  readonly issues: ContinuityIssueV2[];
  /** 没跑成的步骤（如实说明）。三遍全失败才算这次没核成。 */
  readonly failures: string[];
  /** not_ready＝要补的笔记太多（超过 maxCatchUp），这次没核；pending＝已读到第 done 章、总共 total 章。 */
  readonly skipped?: "not_ready";
  readonly pending?: { readonly done: number; readonly total: number };
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
}): Promise<{ readonly prefix: readonly BrainMessage[]; readonly passages?: string; readonly failure?: string }> {
  const ask: BrainMessage = { role: "user", content: `【新稿：第 ${input.chapter} 章】\n${input.draftBody}\n\n${keywordTask(input.chapter)}` };
  try {
    const reply = (await input.callModel([...input.window, ask], { json: true })).trim();
    const keywords = parseKeywords(reply);
    if (keywords.length === 0) return { prefix: input.window };
    // 关键词可能带修饰（「周屿父 城东」）或写成短语：拆成单词再检索，防整串落空。
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
    const message = error instanceof Error ? error.message : String(error);
    return { prefix: input.window, failure: `翻原文那一轮没跑成（${message}），这次只按窗口核` };
  }
}

/** 核账员核一章：先确保读完前文（缺的笔记补上），再三遍并行核新稿，最后按变体做自复核（A，可带时间线表 F）和「确定」门槛（D）。 */
export async function checkChapterByReader(input: {
  readonly projectDir: string;
  readonly chapter: number;
  readonly draftBody: string;
  readonly callModel: BrainCallModel;
  readonly notesRoot?: string;
  readonly maxCatchUp?: number;
  /** 窗口字数预算；缺省 READER_WINDOW_MAX_CHARS（测试用小值，好让折叠和翻原文真的发生）。 */
  readonly maxChars?: number;
  /** 前面各章原文（核账服务已读过就传进来，省得再读一遍）；缺省从书目录读。 */
  readonly earlier?: EarlierText;
  /** T1 的四个做法（A 自复核 / B 时间线 / C 结构化笔记 / D 确定门槛）；缺省全关＝第 1 步的原样。产品默认见 DEFAULT_READER_VARIANT。 */
  readonly variant?: ReaderCheckVariant;
}): Promise<ReaderCheckResult> {
  const variant = input.variant ?? {};
  const role = checkerRoleFor(variant.structuredNotes);
  let window: BrainMessage[];
  let foldedChapters: number;
  try {
    const ready = await withStep("跟读补笔记", () => ensureReaderWindow({
      projectDir: input.projectDir,
      role,
      upTo: input.chapter - 1,
      callModel: input.callModel,
      ...(input.notesRoot ? { notesRoot: input.notesRoot } : {}),
      ...(input.maxCatchUp !== undefined ? { maxCatchUp: input.maxCatchUp } : {}),
      ...(input.maxChars !== undefined ? { maxChars: input.maxChars } : {}),
    }));
    if (ready.missing > 0) {
      return { issues: [], failures: [], skipped: "not_ready", pending: { done: ready.reused, total: ready.reused + ready.missing } };
    }
    window = ready.messages;
    foldedChapters = ready.foldedChapters;
  } catch (error) {
    // 补到一半失败：已写下的笔记留着，下次接着补；这次如实说没核成。
    return { issues: [], failures: [`核账员读前文没成：${error instanceof Error ? error.message : String(error)}`] };
  }
  const earlier = input.earlier ?? await readEarlierChapters(input.projectDir, input.chapter);
  // B 时间线表：引擎排好的日子，核账时照表判「昨天 / 前天 / 周几」，不让模型自己推算（压「换了一天」那类误报）。
  // F（时间线只进自复核）开着时三遍不带表、只在 A 那一轮带（表照样读一次）。
  const timelineTable = variant.timeline || variant.timelineInReview
    ? await readStoryTimeline(input.projectDir)
      .then((read) => describeTimelineForChapter(read.timeline, input.chapter))
      .catch(() => undefined)
    : undefined;
  // 前文有被折叠的章（原文不在窗口里）→ 先翻一轮原文贴回去，三遍和自复核共用这一段前缀。
  const lookup = foldedChapters > 0
    ? await lookupEarlierPassages({ projectDir: input.projectDir, chapter: input.chapter, draftBody: input.draftBody, window, callModel: input.callModel })
    : { prefix: window };
  // 新稿这条消息三遍共用：新稿本体 + 时间线表（B，且 F 没开）+ 翻到的原文（T5）——都拼在新稿后面、核账提示前面（离要判的话最近）。
  const draftParts = (timeline: string | undefined): string => [
    `【新稿：第 ${input.chapter} 章】\n${input.draftBody}`,
    ...(timeline ? ["", timeline] : []),
    ...(lookup.passages ? ["", lookup.passages] : []),
  ].join("\n");
  const passesTimeline = variant.timeline && !variant.timelineInReview && timelineTable ? `【故事时间线（日子以这张表为准）】\n${timelineTable}` : undefined;
  // F：三遍不带表；A 自复核那一轮带表，并写明日子以表为准、不要自己推算（B 单开时复核沿用三遍那张表，第 1 步行为不变）。
  const reviewTimeline = variant.timelineInReview && timelineTable
    ? `【故事时间线（日子以这张表为准，不要自己推算）】\n${timelineTable}`
    : passesTimeline;
  const draftMessage = draftParts(passesTimeline);
  const reviewMessage = draftParts(reviewTimeline);
  const settled = await withStep("核账员", () => Promise.allSettled(CHECKER_PASSES.map(async ({ focus }) => {
    const text = await input.callModel(
      [...lookup.prefix, { role: "user", content: `${draftMessage}\n\n${checkTask(input.chapter, focus)}` }],
      { json: true },
    );
    const confidences = readConfidences(text);
    return parseFullReadIssues(text, input.chapter, input.draftBody, earlier)
      .map((issue): ContinuityIssueV2 => ({ ...issue, confidence: confidences.get(issue.quote) ?? "maybe" }));
  })));
  const failures: string[] = lookup.failure ? [lookup.failure] : [];
  const passes: ContinuityIssueV2[][] = [];
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") passes.push(result.value);
    else failures.push(`${CHECKER_PASSES[index]!.label}没跑成：${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
  });
  let issues = mergePasses(passes);
  // A 自复核：三遍合并后，在同一窗口里把候选逐条再判一轮（no 的删掉，把握以复核为准）。没候选就不发这一轮（省调用）。
  if (variant.selfReview && issues.length > 0) {
    try {
      const text = await withStep("核账员自复核", () => input.callModel(
        [...lookup.prefix, { role: "user", content: `${reviewMessage}\n\n${selfReviewTask(input.chapter, issues)}` }],
        { json: true },
      ));
      const verdicts = parseVerdicts(text);
      if (verdicts.size === 0) throw new Error("复核输出不是 JSON");
      const verdictOf = (index: number) => verdicts.get(`K${index + 1}`);
      // 判 no 的删掉，其余把握以复核为准；没给判断的按原把握保留。
      issues = issues
        .map((issue, index) => {
          const verdict = verdictOf(index);
          return verdict === undefined ? issue : { ...issue, confidence: verdict === "sure" ? "sure" as const : "maybe" as const };
        })
        .filter((_, index) => verdictOf(index) !== "no");
    } catch (error) {
      // 复核没跑成：候选原样交出（宁可多报），如实记一笔。
      failures.push(`自复核没跑成：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // D「确定」门槛：最后加一道确定性的闸，压「确定」的误报和波动。
  if (variant.sureGate) issues = applySureGate(issues, input.chapter, input.draftBody, earlier);
  return { issues, failures };
}

// ---------- 审章纲（2026-10-12 编辑部第 3 步） ----------

/** 核账员审章纲审出的一条问题：point 指 beats 的序号（1 起），beat 由代码按序号取回（不信模型抄写）。 */
export interface PlanProblem {
  readonly point: number;
  readonly beat?: string;
  readonly earlierQuote: string;
  readonly earlierChapter: number;
  readonly reason: string;
}

export interface ReaderPlanCheckResult {
  /** earlierQuote 已由代码逐字核对过真在前文里（抄不出的在解析时丢掉）。 */
  readonly problems: readonly PlanProblem[];
  readonly failures: string[];
  /** not_ready＝要补的笔记太多（超过 maxCatchUp），这次没审；pending＝已读到第 done 章、总共 total 章。 */
  readonly skipped?: "not_ready";
  readonly pending?: { readonly done: number; readonly total: number };
}

/** 审章纲提示：核账员窗口（读到 N-1）后接「这是第 N 章的章纲（还没写正文）」+ 章纲要点，找和前文矛盾的要点。 */
export function planCheckTask(chapter: number, plan: ChapterPlan): string {
  return [
    `这是作者准备照着写第 ${chapter} 章的章纲（还没写正文），上面还没给过你。对照你读过的前文原文和笔记，找出章纲里和前文对不上的要点：`,
    "- 谁手里有什么：物件此刻在哪、在谁手上，章纲是不是安排拿错了、放错了、又交了一遍",
    "- 谁在哪：人物的位置和行程按前文接不接得上",
    "- 谁知道什么：章纲安排人物说出或用到的信息，他按前文还不可能知道",
    "- 日子：开场时间和「几天后」按前文过了几天算得对不对",
    "只报按前文不可能成立的安排；章纲明确安排了变化过程的、作者方向明确要求的，不算。",
    "每条 problems：point 写第几条要点（下面要点列表的序号）；earlierQuote 逐字抄前文和它冲突的那一句；earlierChapter 写那句在第几章；reason 一句话说哪里对不上。抄不出原文的不要报。",
    `【第 ${chapter} 章章纲】`,
    `一句话：${plan.summary}`,
    `要点：\n${plan.beats.map((beat, index) => `${index + 1}. ${beat}`).join("\n")}`,
    ...(plan.newInformation.length > 0 ? [`新信息：\n${plan.newInformation.map((item, index) => `${index + 1}. ${item}`).join("\n")}`] : []),
    `开场：${plan.scene.location ?? "（没写）"}，${plan.scene.time ?? "（没写）"}`,
    ...(plan.characters.length > 0 ? [`人物：${plan.characters.join("、")}`] : []),
    ...(plan.entities.length > 0 ? [`物件/地点：${plan.entities.join("、")}`] : []),
    '只输出一个 JSON：{"problems":[{"point":1,"earlierQuote":"","earlierChapter":1,"reason":""}]}；没有问题就给空数组。',
  ].join("\n");
}

/** 前文按章号 → 归一后的全文（核 earlierQuote 用）。 */
function earlierByText(earlier: EarlierText): ReadonlyMap<number, string> {
  return new Map(earlier.chapters.map((item) => [item.chapter, normalize(item.sentences.join(""))]));
}

/** 理由自己就否决了的（「此点成立，不报」「与前文一致」）：模型把自我否决的候选也输出了，不当问题收。 */
const SELF_DISMISSED_PLAN = /不报|不矛盾|没有矛盾|无矛盾|前后一致|说法一致|不冲突|不算|说得通|此点成立/u;

/** 要点序号：数字、「第 2 条」都收；越界（或没写）丢掉。 */
function readPoint(raw: unknown, beats: readonly string[]): number | undefined {
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw : "";
  const digits = /\d+/u.exec(text);
  if (!digits) return undefined;
  const point = Number(digits[0]);
  return Number.isInteger(point) && point >= 1 && point <= beats.length ? point : undefined;
}

/**
 * 解析审章纲输出：earlierQuote 由代码核对真在前文里（先信它报的章号，对不上按章序搜），抄不出原文的丢掉；
 * point 越界的丢掉（模型没指到具体要点的问题没法只改那条要点）。
 */
export function parsePlanProblems(text: string, plan: ChapterPlan, earlier: EarlierText): readonly PlanProblem[] {
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
    if (!point || !earlierQuote || !reason || SELF_DISMISSED_PLAN.test(reason)) continue;
    const claimed = Number(record.earlierChapter);
    const inClaimed = Number.isInteger(claimed) && claimed >= 1 && byChapter.has(claimed) && containsQuote(byChapter.get(claimed)!, earlierQuote);
    const chapter = inClaimed
      ? claimed
      : [...byChapter.keys()].sort((a, b) => a - b).find((key) => containsQuote(byChapter.get(key)!, earlierQuote));
    if (chapter === undefined) continue;
    out.push({ point, beat: plan.beats[point - 1], earlierQuote, earlierChapter: chapter, reason });
  }
  return out;
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
  /** 前面各章原文（调用方已读过就传进来）；缺省从书目录读。 */
  readonly earlier?: EarlierText;
}): Promise<ReaderPlanCheckResult> {
  let window: BrainMessage[];
  try {
    const ready = await withStep("跟读补笔记", () => ensureReaderWindow({
      projectDir: input.projectDir,
      role: CHECKER_ROLE,
      upTo: input.plan.chapter - 1,
      callModel: input.callModel,
      ...(input.notesRoot ? { notesRoot: input.notesRoot } : {}),
      ...(input.maxCatchUp !== undefined ? { maxCatchUp: input.maxCatchUp } : {}),
    }));
    if (ready.missing > 0) return { problems: [], failures: [], skipped: "not_ready", pending: { done: ready.reused, total: ready.reused + ready.missing } };
    window = ready.messages;
  } catch (error) {
    return { problems: [], failures: [`核账员读前文没成：${error instanceof Error ? error.message : String(error)}`] };
  }
  const earlier = input.earlier ?? await readEarlierChapters(input.projectDir, input.plan.chapter);
  try {
    const text = await withStep("核账员审纲", () => input.callModel(
      [...window, { role: "user", content: planCheckTask(input.plan.chapter, input.plan) }],
      { json: true },
    ));
    return { problems: parsePlanProblems(text, input.plan, earlier), failures: [] };
  } catch (error) {
    return { problems: [], failures: [`审章纲没跑成：${error instanceof Error ? error.message : String(error)}`] };
  }
}
