/**
 * 记时间那遍（写作版本 P5a，设计 docs/rebuild/写作版本-P5a-设计.md）。
 *
 * 记账员主对话记时间会随机漏记 / 多记一次换天（同一章同一份前文记 5 遍错 1 遍），一错后面每章整体差一天；
 * 正文没交代隔几天时也爱硬给一个数。这里另起一遍只记时间（和主对话、记东西那遍并行，材料是本章编号正文 + 前两章原文
 * + 上一个当下章结尾），和主对话的读法比一下：一样就照主对话的；不一样再问一遍裁定，每一项（开头、章里）分开定，
 * 裁不出的那项按不知道记、如实说。主对话一个字不改（主对话记时间对输入很敏感，P4b 教训）。
 * 模型调用由调用方注入；规则里不写任何书名、人名、题材。
 */
import { entryShapeProblem, type BoundaryOffsets, type TextUnit, type TimeInput, type TimeOffset } from "@actalk/story-core";
import { modelFailureText } from "../lib/ai-errors.js";
import { positiveIntLike } from "../lib/lenient-args.js";
import { rethrowIfStopped } from "../lib/operations/context.js";
import { withStep } from "../lib/token-meter.js";
import { extractJsonObject, flag, parseChapterEnd, quoteText, relativeOf, type KeeperDrop, type KeeperParseResult } from "./keeper-parse.js";
import type { BrainCallModel, BrainMessage } from "./reader-window.js";

/** 章里过了半夜 / 过了天亮：交账单、追问结尾、记时间那遍同一句（后两处把「quote 摘」换成点编号）。 */
export const IN_CHAPTER_BOUNDARY =
  "章里讲过了半夜或天亮、换没换天要看规矩的，也是一次换天，用 byBoundary 各写一份，不写 sameDay：③ 从白天或半夜以前讲到半夜以后、天亮以前（「过了十二点」「凌晨一点」这类）：midnight 1、dawn 0，quote 摘过了半夜那句；④ 本章开头在半夜以后、天亮以前，章里又讲到天亮以后：midnight 0、dawn 1，quote 摘天亮后那句。两样都有（从晚上讲过半夜一直到天亮以后）就各记一次。";

const TIME_SYSTEM = "你是这本长篇小说的记账员，这一次只管记时间：本章开头离上一章结尾多久、章里换没换天。";

/** 记时间那遍（和裁定那遍）的要求。 */
export const TIME_SPEC: readonly string[] = [
  "你只管这一章的时间：本章开头离上一个当下章的结尾多久，章里换没换天。题材中立：只按正文写的定，不臆造。",
  "先逐句读编号正文，把写到时间的句子都列进 cues，一句一条：id 写编号，what 用几个字说它写了什么时间（钟点、时段、天色、「第二天」「当晚」「三天后」「昨天」、睡下、醒来、星期……）；这句在回忆、倒叙、梦、想象、传闻、故事里讲的故事里，加 \"aside\":true。列完再交下面几样。",
  "",
  "- 当下 = 故事「现在」往前走的那条线。多线叙事换个人物从前天讲起也还在当下，只是往回接。回忆、倒叙、梦、想象、传闻、故事里讲的故事不在当下，它们里面的时间、换天都不算。",
  "- 整章都是回忆、梦这类、没有一句在当下的，交 {\"cues\":[…],\"notPresent\":true}，别的不写。",
  "- start = 本章开头离上一个当下章的结尾多久（下面【上一个当下章结尾】是原文，【前文原文】是前两章）。写成 {\"offset\":{\"unit\":\"day\",\"min\":1,\"max\":1},\"basis\":\"text\",\"startId\":4}：同一天 0，隔一天 1，往回接的写负数（「前天」-2）；「半年后」「三年后」照原样写 unit 为 month、year，不要折成天。startId 写本章里说明隔多久的那句的编号（依据只在上一章结尾、本章里没有的，写本章第一句的编号）；basis 写 text（正文明写了）或 judged（对照着判断的）。",
  "- 隔几天要有依据：正文写明的（「第二天」「当晚」「三天后」「一个月后」）；或者本章接着上一章同一个场面往下讲；或者本章开头做的正是上一个当下章约到「明天」「第二天」的事；或者本章里说的「昨天」「前天」「昨晚」指的是上一个当下章的事；或者正文写明的星期对得上。看得出至少隔了一夜、但正文没交代隔了几天的，只写 min（至少几天），不写 max；有个大概范围的写 min、max 两头。",
  "- 要看「过了半夜算不算第二天」才定的，按两种规矩各写一份，不写 offset：\"byBoundary\":{\"midnight\":{\"unit\":\"day\",\"min\":0,\"max\":0},\"dawn\":{\"unit\":\"day\",\"min\":1,\"max\":1}}（midnight = 过了半夜十二点就算第二天时隔多久，dawn = 天亮才算第二天时隔多久，里面直接写 unit、min、max）。两种情形要分：① 上一个当下章停在半夜以后、天亮以前（后半夜、凌晨），本章开头是那之后第一次天亮（「第二天一早」这类）：midnight 0、dawn 1；② 上一个当下章停在白天或半夜以前，本章开头在半夜以后、天亮以前（凌晨四点这类）：midnight 1、dawn 0。再往后每多隔一天，两份各加 1。【上一个当下章结尾】后面注明了按两种规矩不在同一天的，多半就是①。",
  "- 本章接着当下往下讲、但判断不了隔多久，写 \"start\":\"unknown\"。",
  "- 本章从头到尾在同一天，写 \"sameDay\":true（从早到晚、从白天到半夜十二点以前都还是同一天；钟点往后走到夜里十一点、快十二点也还是同一天）。中间换了天就逐次列 dayChanges：每次写 id（新的一天开头那句的编号）和隔了几天（offset 至少 1 天；要看换天规矩才定的照样用 byBoundary 各写一份）。回忆、梦里的换天不算。",
  `- ${IN_CHAPTER_BOUNDARY.replaceAll("quote 摘", "id 写")}`,
  "- 正文实在看不出章末是哪天，写 \"endUnknown\":true。",
  "",
  "只输出一个 JSON 对象，形如：",
  '{"cues":[{"id":1,"what":"傍晚"},{"id":9,"what":"那年冬天","aside":true},{"id":23,"what":"第二天上午"}],"start":{"offset":{"unit":"day","min":1,"max":1},"basis":"text","startId":4},"dayChanges":[{"id":23,"offset":{"unit":"day","min":1,"max":1}}]}',
  "不要 Markdown、不要解释、不要多余文字。",
];

/** 记时间那遍拿到的材料：本章编号正文、前两章原文那段、上一个当下章结尾那段（后两样可以是空串）。 */
export interface TimeMaterial {
  readonly chapter: number;
  readonly numbered: string;
  readonly contextText: string;
  readonly endingText: string;
}

function materialParts(material: TimeMaterial): string[] {
  return [`【第 ${material.chapter} 章 正文（每句前面是编号）】\n${material.numbered}`, material.contextText, material.endingText].filter((part) => part.length > 0);
}

/** 记时间那遍的 user 消息（单测也用）。 */
export function buildTimeTask(material: TimeMaterial): string {
  return [...materialParts(material), `这一章即将定稿入库，请只记本章的时间。\n\n${TIME_SPEC.join("\n")}`].join("\n\n");
}

/** 一份时间读法里能比的那几样：开头、结尾（sameDay / dayChanges，章末不知道时两样都没有），或整章不在当下。 */
export type TimeCandidate = { readonly notPresent: true } | Pick<TimeInput, "start" | "sameDay" | "dayChanges">;

/** 追问 / 记时间那遍交回来的换天按句子编号点的：代码取那句原句（编号对不上的原句留空，照交账单的规矩不记）。 */
export function changesById(list: unknown, units: readonly TextUnit[], draft: string): unknown {
  if (!Array.isArray(list)) return list;
  return list.map((item) => {
    if (item === null || typeof item !== "object") return item;
    const { id, ...rest } = item as Record<string, unknown>;
    const unit = units.find((candidate) => candidate.id === positiveIntLike(id));
    return { ...rest, quote: unit ? draft.slice(unit.start, unit.end) : "" };
  });
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * 记时间那遍（和裁定那遍）交回来的：读成一份读法；读不了、缺开头或结尾、换天点的编号对不上 → 原因（字符串）。
 * 套了一层 time 的照收（模型无关）。开头的原句按 startId 取那一句；没点、点错了留空，由调用方补。
 */
export function parseTimeCandidate(text: string, draft: string, units: readonly TextUnit[]): TimeCandidate | string {
  const root = extractJsonObject(text);
  if (!root) return "交回来的不是 JSON";
  const raw: Record<string, unknown> = isRecord(root.time) ? { ...root, ...root.time } : root;
  if (flag(raw.notPresent) === true) return { notPresent: true };
  let start: TimeInput["start"];
  if (typeof raw.start === "string" && raw.start.trim().toLowerCase() === "unknown") start = "unknown";
  else if (isRecord(raw.start)) {
    const relative = relativeOf(raw.start);
    if (typeof relative === "string") return `开头写得不对（${relative}）`;
    const id = positiveIntLike(raw.start.startId ?? raw.startId);
    const unit = id === undefined ? undefined : units.find((candidate) => candidate.id === id);
    const basis = typeof raw.start.basis === "string" && raw.start.basis.trim().toLowerCase() === "text" ? "text" : "judged";
    start = { ...relative, basis, quote: unit ? draft.slice(unit.start, unit.end) : (quoteText(raw.start.quote) ?? "") };
  } else return "没写本章开头";
  if (flag(raw.endUnknown) === true) return { start };
  const changes = changesById(raw.dayChanges, units, draft);
  if (Array.isArray(changes) && changes.some((change) => isRecord(change) && change.quote === "")) return "换天点的句子编号不对";
  const adjusted: KeeperDrop[] = [];
  const end = parseChapterEnd({ sameDay: raw.sameDay, dayChanges: changes }, adjusted);
  if (adjusted.length > 0) return adjusted[0]?.reason ?? "结尾写得不对";
  if (end.sameDay === undefined && end.dayChanges === undefined) return "没写本章结尾";
  return { start, ...end };
}

// —— 读法：两种换天规矩下，开头隔多久、章里过了多久 ——

type Side = { readonly unit: TimeOffset["unit"]; readonly min?: number; readonly max?: number } | "unknown";
interface Worlds {
  readonly midnight: Side;
  readonly dawn: Side;
}
/** 一份读法：不在当下的只有 present = false。 */
export interface TimeReading {
  readonly present: boolean;
  readonly start?: Worlds;
  readonly span?: Worlds;
}

const sideOf = (offset: TimeOffset): Side => ({ unit: offset.unit, ...(offset.min !== undefined ? { min: offset.min } : {}), ...(offset.max !== undefined ? { max: offset.max } : {}) });
const bothOf = (relative: { readonly offset?: TimeOffset; readonly byBoundary?: BoundaryOffsets }): Worlds =>
  relative.byBoundary
    ? { midnight: sideOf(relative.byBoundary.midnight), dawn: sideOf(relative.byBoundary.dawn) }
    : relative.offset
      ? { midnight: sideOf(relative.offset), dawn: sideOf(relative.offset) }
      : { midnight: "unknown", dawn: "unknown" };

/** 把几次换天在一个世界里加起来：下限都知道才有下限，上限都知道才有上限；不是按天的不知道。 */
function sumSides(sides: readonly Side[]): Side {
  let min: number | undefined = 0;
  let max: number | undefined = 0;
  for (const side of sides) {
    if (side === "unknown" || side.unit !== "day") return "unknown";
    min = min === undefined || side.min === undefined ? undefined : min + side.min;
    max = max === undefined || side.max === undefined ? undefined : max + side.max;
  }
  return { unit: "day", ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
}

/** 一份时间声明（或记时间那遍的读法）折成能比的读法。换天落在哪句不比。 */
export function readingOf(time: TimeCandidate): TimeReading {
  if ("notPresent" in time || time.start === undefined) return { present: false };
  const start: Worlds = time.start === "unknown" ? { midnight: "unknown", dawn: "unknown" } : bothOf(time.start);
  const changes = (time.dayChanges ?? []).map(bothOf);
  const span: Worlds =
    time.sameDay === true
      ? { midnight: { unit: "day", min: 0, max: 0 }, dawn: { unit: "day", min: 0, max: 0 } }
      : changes.length > 0
        ? { midnight: sumSides(changes.map((change) => change.midnight)), dawn: sumSides(changes.map((change) => change.dawn)) }
        : { midnight: "unknown", dawn: "unknown" };
  return { present: true, start, span };
}

const sameSide = (a: Side, b: Side): boolean => (a === "unknown" || b === "unknown" ? a === b : a.unit === b.unit && a.min === b.min && a.max === b.max);
const sameWorlds = (a: Worlds | undefined, b: Worlds | undefined): boolean => (a && b ? sameSide(a.midnight, b.midnight) && sameSide(a.dawn, b.dawn) : a === b);
/** a 把 b 包住（不知道包住一切；没下限 / 没上限的那头包住任何数）。 */
function coversSide(a: Side, b: Side): boolean {
  if (a === "unknown") return true;
  if (b === "unknown" || a.unit !== b.unit) return false;
  return (a.min === undefined || (b.min !== undefined && a.min <= b.min)) && (a.max === undefined || (b.max !== undefined && a.max >= b.max));
}
const coversWorlds = (a: Worlds, b: Worlds): boolean => coversSide(a.midnight, b.midnight) && coversSide(a.dawn, b.dawn);

export function sameReading(a: TimeReading, b: TimeReading): boolean {
  return a.present === b.present && sameWorlds(a.start, b.start) && sameWorlds(a.span, b.span);
}

/** 一项（开头 / 章里）用谁的：主对话、记时间那遍、裁定那遍，或裁不出（按不知道记）。 */
export type TimePick = "main" | "second" | "judge" | "unknown";

/** 一项怎么定（设计 2.2）：两遍一样照留；裁的和哪边一样用哪边；裁的给了把两边都包住的区间用它的；都不是按不知道。 */
export function pickField(main: Worlds, second: Worlds, judge: Worlds | undefined): TimePick {
  if (sameWorlds(main, second)) return "main";
  if (!judge) return "main";
  if (sameWorlds(judge, main)) return "main";
  if (sameWorlds(judge, second)) return "second";
  if (coversWorlds(judge, main) && coversWorlds(judge, second)) return "judge";
  return "unknown";
}

// —— 两遍对一下 ——

/** 记时间那遍的结果，进操作记录（不进清单，不算缺账）。 */
export interface TimeCheck {
  /** agreed = 两遍一样；judged = 裁过一次；kept = 没比成（记时间那遍或裁定没成），照主对话的。 */
  readonly result: "agreed" | "judged" | "kept";
  readonly took?: { readonly start: TimePick; readonly end: TimePick };
  readonly failed?: string;
}

/** 拼出来的时间不能用：按两种换天规矩走不通、或和正文写明的星期对不上（ledger-keeper 判）。 */
export type NightCheck = (time: TimeInput) => boolean;

export interface ReconcileInput {
  readonly draft: string;
  readonly units: readonly TextUnit[];
  readonly material: TimeMaterial;
  readonly callModel: BrainCallModel;
  readonly impossible: NightCheck;
  readonly onRawOutput?: (text: string) => void;
}

/** 记时间那遍：一次调用，读成一份读法；没成 → 原因。停了照抛。 */
export async function askTimeReading(input: Pick<ReconcileInput, "draft" | "units" | "material" | "callModel" | "onRawOutput">): Promise<TimeCandidate | string> {
  let reply: string;
  try {
    reply = await withStep("记账员记时间", () => input.callModel(timeMessages(buildTimeTask(input.material)), { json: true }));
  } catch (error) {
    rethrowIfStopped(error);
    return `记时间那遍没成（${modelFailureText(error)}）`;
  }
  input.onRawOutput?.(reply);
  const candidate = parseTimeCandidate(reply, input.draft, input.units);
  return typeof candidate === "string" ? `记时间那遍${candidate}` : candidate;
}

const timeMessages = (task: string): BrainMessage[] => [
  { role: "system", content: TIME_SYSTEM },
  { role: "user", content: task },
];

const UNIT_WORDS: Record<TimeOffset["unit"], string> = { day: "天", month: "个月", year: "年" };

/** 「1 天」「0～1 天」「至少 1 天」「往回 2 天」：给裁定那遍看的。 */
function rangeText(offset: TimeOffset): string {
  const word = UNIT_WORDS[offset.unit];
  const { min, max } = offset;
  if (min !== undefined && min === max) return min < 0 ? `往回 ${-min} ${word}` : `${min} ${word}`;
  if (min !== undefined && max !== undefined) return `${min}～${max} ${word}`;
  if (min !== undefined) return `至少 ${min} ${word}`;
  return `至多 ${max} ${word}`;
}

const relativeText = (relative: { readonly offset?: TimeOffset; readonly byBoundary?: BoundaryOffsets }): string =>
  relative.byBoundary
    ? `过了半夜就算第二天时 ${rangeText(relative.byBoundary.midnight)}，天亮才算第二天时 ${rangeText(relative.byBoundary.dawn)}`
    : relative.offset
      ? rangeText(relative.offset)
      : "说不出";

/** 原句落在第几句（找不到就只给原句）。 */
function sentenceText(quote: string, draft: string, units: readonly TextUnit[]): string {
  const clip = quote.length > 40 ? `${quote.slice(0, 40)}…` : quote;
  const unit = quote ? units.find((candidate) => draft.slice(candidate.start, candidate.end).includes(quote)) : undefined;
  return unit ? `第 ${unit.id} 句「${clip}」` : `「${clip}」`;
}

/** 一份读法写成几行中文（裁定那遍看的）。 */
export function describeCandidate(time: TimeCandidate, draft: string, units: readonly TextUnit[]): string {
  if ("notPresent" in time || time.start === undefined) return "整章不在当下（回忆、梦这类）。";
  const lines: string[] = [];
  lines.push(
    time.start === "unknown"
      ? "本章开头离上一个当下章结尾：说不出隔多久。"
      : `本章开头离上一个当下章结尾：${relativeText(time.start)}${time.start.quote ? `（依据 ${sentenceText(time.start.quote, draft, units)}）` : ""}。`,
  );
  if (time.sameDay === true) lines.push("章里：从头到尾同一天。");
  else if (time.dayChanges && time.dayChanges.length > 0) {
    for (const change of time.dayChanges) lines.push(`章里：${change.quote ? sentenceText(change.quote, draft, units) : "（没点句子）"}换了天，${relativeText(change)}。`);
  } else lines.push("章里：章末是哪天说不出。");
  return lines.join("\n");
}

/** 裁定那遍的 user 消息（单测也用）：两份读法摆出来，交它自己认定的（规矩同记时间那遍）。 */
export function buildTimeJudgeTask(material: TimeMaterial, main: string, second: string, differs: readonly string[]): string {
  return [
    ...materialParts(material),
    [
      `两位记账员记这一章的时间记得不一样（不一样的是：${differs.join("、")}）。`,
      `甲：\n${main}`,
      `乙：\n${second}`,
      "请逐句对照正文和前文，交你认定的本章时间。两个都不对就交你自己认定的；正文定不下的，照下面的规矩写区间或 unknown，不要硬挑一个。",
    ].join("\n\n"),
    TIME_SPEC.join("\n"),
  ].join("\n\n");
}

/** 记账员主对话记的时间（后面的追问都问完了）那条在 entries 里的位置。 */
const timeIndexOf = (parsed: KeeperParseResult): number => parsed.entries.findIndex((entry) => entry.kind === "time");

/**
 * 两遍对一下（设计 2.2）：second = 记时间那遍（并行跑完的）或它没成的原因。
 * 一样 → 照主对话的；不一样 → 裁一次，开头、章里分开定（pickField）；裁不出的那项按不知道记，清单上如实说一句。
 * 记时间那遍没成、裁定没成、拼出来的时间结构不对或按两种换天规矩走不通、两遍对本章在不在当下说的不一样 → 照主对话的，只在操作记录里留一句。
 * 主对话没记上时间（整条丢了）→ 不比。
 */
export async function reconcileTime(parsed: KeeperParseResult, second: TimeCandidate | string, input: ReconcileInput): Promise<{ readonly parsed: KeeperParseResult; readonly check?: TimeCheck }> {
  const index = timeIndexOf(parsed);
  const main = index >= 0 ? parsed.entries[index] : undefined;
  if (main?.kind !== "time") return { parsed };
  if (typeof second === "string") return { parsed, check: { result: "kept", failed: second } };
  const mainReading = readingOf(main);
  const secondReading = readingOf(second);
  if (sameReading(mainReading, secondReading)) return { parsed, check: { result: "agreed" } };
  if (!mainReading.present || !secondReading.present) return { parsed, check: { result: "kept", failed: "两遍对本章在不在当下说的不一样，照主对话的" } };
  if ("notPresent" in second) return { parsed, check: { result: "kept", failed: "两遍对本章在不在当下说的不一样，照主对话的" } };
  const differs = [
    ...(sameWorlds(mainReading.start, secondReading.start) ? [] : ["本章开头离上一章隔多久"]),
    ...(sameWorlds(mainReading.span, secondReading.span) ? [] : ["章里换没换天"]),
  ];
  let reply: string;
  try {
    reply = await withStep("记账员裁时间", () =>
      input.callModel(
        timeMessages(buildTimeJudgeTask(input.material, describeCandidate(main, input.draft, input.units), describeCandidate(second, input.draft, input.units), differs)),
        { json: true },
      ),
    );
  } catch (error) {
    rethrowIfStopped(error);
    return { parsed, check: { result: "kept", failed: `两遍对不上，裁定那遍没成（${modelFailureText(error)}），照主对话的` } };
  }
  input.onRawOutput?.(reply);
  const judged = parseTimeCandidate(reply, input.draft, input.units);
  if (typeof judged === "string") return { parsed, check: { result: "kept", failed: `两遍对不上，裁定那遍${judged}，照主对话的` } };
  const judgeReading = readingOf(judged);
  if (!judgeReading.present || "notPresent" in judged) return { parsed, check: { result: "kept", failed: "两遍对不上，裁定那遍说整章不在当下，照主对话的" } };
  const took = {
    start: pickField(mainReading.start as Worlds, secondReading.start as Worlds, judgeReading.start),
    end: pickField(mainReading.span as Worlds, secondReading.span as Worlds, judgeReading.span),
  };
  const from = (pick: TimePick): TimeCandidate | undefined => (pick === "second" ? second : pick === "judge" ? judged : pick === "main" ? main : undefined);
  const startFrom = from(took.start);
  const endFrom = from(took.end);
  const { start: _start, sameDay: _sameDay, dayChanges: _dayChanges, ...rest } = main;
  const startOf = (candidate: TimeCandidate | undefined): TimeInput["start"] => {
    if (candidate === main) return main.start;
    if (!candidate || "notPresent" in candidate || candidate.start === undefined) return "unknown";
    if (candidate.start === "unknown" || candidate.start.quote) return candidate.start;
    // 没点依据那句：用主对话那句，主对话也没有就用本章第一句（原句核得上，隔多久照这份记）。
    const fallback = main.start && main.start !== "unknown" && main.start.quote ? main.start.quote : (() => {
      const first = input.units[0];
      return first ? input.draft.slice(first.start, first.end) : "";
    })();
    return { ...candidate.start, quote: fallback };
  };
  const endOf = (candidate: TimeCandidate | undefined): Pick<TimeInput, "sameDay" | "dayChanges"> =>
    !candidate || "notPresent" in candidate
      ? {}
      : { ...(candidate.sameDay !== undefined ? { sameDay: candidate.sameDay } : {}), ...(candidate.dayChanges !== undefined ? { dayChanges: candidate.dayChanges } : {}) };
  const fixed: TimeInput = { ...rest, start: startOf(startFrom), ...endOf(endFrom) };
  if (took.start === "main" && took.end === "main") return { parsed, check: { result: "judged", took } };
  const problem = entryShapeProblem(fixed);
  if (problem) return { parsed, check: { result: "kept", took, failed: `裁出来的时间结构不对（${problem}），照主对话的` } };
  if (input.impossible(fixed)) return { parsed, check: { result: "kept", took, failed: "裁出来的时间按两种换天规矩走不通、或和写明的星期对不上，照主对话的" } };
  const adjusted = [...parsed.adjusted];
  const unknownParts = [...(took.start === "unknown" ? ["本章开头离上一章隔多久"] : []), ...(took.end === "unknown" ? ["章末是哪天"] : [])];
  if (unknownParts.length > 0) adjusted.push({ where: "time", reason: `记时间的几遍对不上，${unknownParts.join("、")}按不知道记` });
  const entries = [...parsed.entries];
  entries[index] = fixed;
  return { parsed: { ...parsed, entries, adjusted }, check: { result: "judged", took } };
}
