/**
 * 核账的确定性工具集（2026-10-12 编辑部 R3：旧组合查错 combo 已删，这里只剩两条路共用的纯函数）。
 *
 * 原则：正文是唯一真相。不拿可能记错的账本当裁判，拿本章原句去对前文原句。
 * 留下的函数分三类：
 *  - 文本工具：normalize / splitSentences / containsQuote（原句核对，审章纲也用）；
 *  - 前文读取：readEarlierChapters（前面各章原文，按句切好）；
 *  - 核账收口：parseFullReadIssues（通读 JSON → 问题条目，原句逐条核对）、issueStillPresent（核账记忆的
 *    「上次问题还在不在」）、ledgerNumberIssues（账本数字对账，引擎 findLedgerNumberConflicts）、
 *    mergeContinuityIssues（合并去重）、hedged（模型调用对冲，brain 的核账员 / 章纲员都在用）。
 * 调模型的编排（通读三遍 + 拆说法逐条判 + 复核）随旧路删除；核账只剩编辑部核账员（editorial/checker.ts）。
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseDraftFile, splitUnits } from "@actalk/story-core";
import { findLedgerNumberConflicts } from "../../writing/ledger-number-check.js";
import { readFactLedgerStrict } from "../../book/fact-ledger-store.js";
import { timelineEntryFor, type StoryTimeline } from "../../book/story-timeline.js";
import { type FactEntry } from "../../book/types.js";
import type { SettingKind } from "../foundation-digest.js";

export type ClaimKind = "object" | "place" | "time" | "identity" | "knowledge" | "number" | "event";

export interface ContinuityIssueV2 {
  readonly quote: string;
  readonly earlierQuote: string;
  readonly earlierChapter: number;
  readonly reason: string;
  readonly kind: ClaimKind;
  /** 复核把握：sure＝确定是矛盾（排前面）；maybe＝可能（收起来给作者看）。未复核时缺省。 */
  readonly confidence?: "sure" | "maybe";
  /** ledger＝账本数字对账（确定性层）查出来的，不是模型找的。 */
  readonly source?: "ledger";
  /**
   * R7.3 对的是设定本而不是某一章：earlierQuote＝设定原文（已由代码核对真在设定本里），
   * quote＝有问题的那句原句（在当前稿，或在 fixChapter 指的那一章）。
   */
  readonly againstSetting?: { readonly label: string; readonly kind?: SettingKind; readonly card?: string };
  /** R7.3 错在哪一章、按钮就改哪一章（quote 抄自前文某章时由代码定）；缺省＝当前核的章。 */
  readonly fixChapter?: number;
  /** 这句是上一遍按核账改出来的（from＝改前那句）：这遍又说它不对，两遍说法相反，降成「可能」交作者定。 */
  readonly revisited?: { readonly from: string };
}

export interface EarlierText {
  /** 前面各章（近的在前）。 */
  readonly chapters: readonly { readonly chapter: number; readonly sentences: readonly string[] }[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function parseJson(text: string): Record<string, unknown> {
  const match = text.match(/\{[\s\S]*\}/u);
  if (!match) throw new Error("模型输出不是 JSON");
  return asRecord(JSON.parse(match[0])) ?? {};
}

/**
 * 模型把换行多转义了一层（JSON 里写成 `\\n`），解出来是字面的反斜杠 n（长篇实跑 2026-10-25：核账原句「小满。\\n\\n小满在行李卷里…」
 * 原样给作者看、对不回整句）。小说正文里没有字面转义，比对和展示前当空白去掉。
 */
export const dropLiteralEscapes = (text: string): string => text.replace(/\\[nrt]/gu, "");

export const normalize = (text: string): string => dropLiteralEscapes(text).replace(/\s+/gu, "");

/** 句子切分：和编号句子同一套切法（核心 splitUnits：引号里的整句归一句、省略号不断句、标题行不算）。 */
export function splitSentences(text: string): readonly string[] {
  return splitUnits(text).map((unit) => unit.text);
}

/**
 * 前面各章原文。缺省读全书（2026-10-10 引擎升级：原来只读最近 30 章，第 200 章写错第 1 章的设定根本对不上）；
 * 折叠预算（要不要只取最近的若干章）由跟读窗口自己管，这里只负责把章读出来按句切好。
 */
export async function readEarlierChapters(projectDir: string, chapter: number, limit = Number.POSITIVE_INFINITY): Promise<EarlierText> {
  const files = await readdir(join(projectDir, "chapters")).catch(() => [] as string[]);
  const numbers = files
    .map((file) => /^(\d{4})\.md$/u.exec(file))
    .filter((match): match is RegExpExecArray => Boolean(match))
    .map((match) => Number(match[1]))
    .filter((n) => n < chapter)
    .sort((a, b) => b - a)
    .slice(0, limit);
  const chapters = [];
  for (const n of numbers) {
    const raw = await readFile(join(projectDir, "chapters", `${String(n).padStart(4, "0")}.md`), "utf-8").catch(() => "");
    chapters.push({ chapter: n, sentences: splitSentences(parseDraftFile(raw).body) });
  }
  return { chapters };
}

function bigrams(text: string): Set<string> {
  const chars = Array.from(normalize(text));
  const out = new Set<string>();
  for (let i = 0; i + 1 < chars.length; i += 1) out.add(chars[i] + chars[i + 1]);
  return out;
}

/** 一句「原文」是否真在一段文本里（宽进：模型抄原句常改一两个字）。审章纲核 earlierQuote 也用它。 */
export function containsQuote(haystack: string, quote: string): boolean {
  const target = normalize(quote);
  if (target.length < 4) return false;
  if (haystack.includes(target)) return true;
  const grams = bigrams(target);
  if (grams.size === 0) return false;
  // 模型抄原句常改一两个字：九成两字片段落在同一个 60 字窗口里也算。
  for (let start = 0; start < haystack.length; start += 30) {
    const windowGrams = bigrams(haystack.slice(start, start + target.length + 30));
    let shared = 0;
    for (const gram of grams) if (windowGrams.has(gram)) shared += 1;
    if (shared / grams.size >= 0.9) return true;
  }
  return false;
}

/** 一处原句最多对到连着的几句上；再长就不对了（照原样）。 */
const SNAP_MAX_SENTENCES = 6;

/** 「A……B」几截按顺序都在 text 里。 */
function fragmentsInOrder(text: string, fragments: readonly string[]): boolean {
  let from = 0;
  for (const fragment of fragments) {
    const at = text.indexOf(fragment, from);
    if (at < 0) return false;
    from = at + fragment.length;
  }
  return true;
}

/**
 * 模型抄的原句对回正文里的整句（P12 编号句子）：核账抄的常是半句、抄错一两个字（他→她）、或「A……B」两截，
 * 作者看到的、「改这处」按编号换的、合并去重比的都该是正文里的整句——同一句抄成两个样子，作者看到两条一样的「确定」；
 * 半句交去改，改的其实是整句。按 splitSentences 的句子：
 * 逐字（不计空白）落在连着的几句里 → 那几句；「A……B」几截按序落在里面 → 那几句；两字片段九成落在连着的一到三句里 → 那几句。
 * 都取最短的那段；都对不上的照原样（宁可不动）。
 */
export function snapToOriginal(sentences: readonly string[], quote: string): string {
  const target = normalize(quote);
  if (target.length < 4) return quote;
  const norms = sentences.map(normalize);
  const shortest = (fits: (joined: string) => boolean, maxCount: number): string | undefined => {
    let best: { start: number; count: number; size: number } | undefined;
    for (let start = 0; start < sentences.length; start += 1) {
      let joined = "";
      for (let count = 1; count <= maxCount && start + count <= sentences.length; count += 1) {
        joined += norms[start + count - 1]!;
        if (!fits(joined)) continue;
        if (best === undefined || joined.length < best.size) best = { start, count, size: joined.length };
        break;
      }
    }
    return best ? sentences.slice(best.start, best.start + best.count).join("") : undefined;
  };
  const exact = shortest((joined) => joined.includes(target), SNAP_MAX_SENTENCES);
  if (exact) return exact;
  const fragments = quote.split("…").map(normalize).filter(Boolean);
  if (fragments.length >= 2) {
    const pieces = shortest((joined) => fragmentsInOrder(joined, fragments), SNAP_MAX_SENTENCES);
    if (pieces) return pieces;
  }
  const grams = bigrams(target);
  if (grams.size === 0) return quote;
  return shortest((joined) => {
    const windowGrams = bigrams(joined);
    let shared = 0;
    for (const gram of grams) if (windowGrams.has(gram)) shared += 1;
    return shared / grams.size >= 0.9;
  }, 3) ?? quote;
}

/** 一批核账条目的两边原句都对回真句：本章那句对本章（错在前文某章的对那章），前文那句对它标的那章；设定原文不动。 */
export function snapIssueQuotes(
  issues: readonly ContinuityIssueV2[],
  chapter: number,
  draftBody: string,
  earlier: EarlierText,
): ContinuityIssueV2[] {
  const draft = splitSentences(draftBody);
  const sentencesOf = (n: number): readonly string[] => (n === chapter ? draft : earlier.chapters.find((item) => item.chapter === n)?.sentences ?? []);
  return issues.map((issue) => {
    const quote = snapToOriginal(sentencesOf(issue.fixChapter ?? chapter), issue.quote);
    const earlierQuote = issue.againstSetting ? issue.earlierQuote : snapToOriginal(sentencesOf(issue.earlierChapter), issue.earlierQuote);
    return quote === issue.quote && earlierQuote === issue.earlierQuote ? issue : { ...issue, quote, earlierQuote };
  });
}

/** 模型给的把握：只认 schema 的 sure，其余（maybe、没写、中文说法）都当 maybe。 */
export function readConfidence(record: Record<string, unknown>): "sure" | "maybe" {
  return String(record.confidence ?? "").trim().toLowerCase() === "sure" ? "sure" : "maybe";
}

/** 通读 JSON → 问题条目（带模型给的把握）：两边原句逐条核对（宽进：抄错一两个字也收），收下的都对回正文整句（snapToOriginal）。 */
export function parseFullReadIssues(text: string, chapter: number, draftBody: string, earlier: EarlierText): readonly ContinuityIssueV2[] {
  const parsed = parseJson(text);
  const raw = Array.isArray(parsed.contradictions) ? parsed.contradictions : [];
  const body = normalize(draftBody);
  const draft = splitSentences(draftBody);
  const earlierByChapter = new Map(earlier.chapters.map((item) => [item.chapter, normalize(item.sentences.join(""))]));
  const sentencesOf = (n: number): readonly string[] => (n === chapter ? draft : earlier.chapters.find((item) => item.chapter === n)?.sentences ?? []);
  const out: ContinuityIssueV2[] = [];
  for (const item of raw) {
    const record = asRecord(item);
    if (!record) continue;
    const rawQuote = dropLiteralEscapes(String(record.quote ?? "")).trim();
    const rawEarlier = dropLiteralEscapes(String(record.earlierQuote ?? "")).trim();
    const reason = String(record.reason ?? "").trim();
    // 理由里自己说「不矛盾」的不再按词表丢（重构 P7「不猜」）：是不是问题由 A 自复核的结构化判定（sure / maybe / no）定。
    if (!containsQuote(body, rawQuote)) continue;
    const claimedChapter = Number(record.earlierChapter);
    let earlierChapter: number | undefined;
    if (containsQuote(body, rawEarlier)) earlierChapter = chapter;
    else if (Number.isInteger(claimedChapter) && earlierByChapter.has(claimedChapter) && containsQuote(earlierByChapter.get(claimedChapter)!, rawEarlier)) earlierChapter = claimedChapter;
    else earlierChapter = [...earlierByChapter.entries()].find(([, text]) => containsQuote(text, rawEarlier))?.[0];
    if (earlierChapter === undefined) continue;
    const quote = snapToOriginal(draft, rawQuote);
    const earlierQuote = snapToOriginal(sentencesOf(earlierChapter), rawEarlier);
    if (earlierChapter === chapter) {
      // 本章自己和自己比：两边落在同一句（或互相包含）就是同一处（浏览器实测：「兜里只剩这一张纸了」对上含它的那一整句，报成「重复」）。
      // 真重复（同一句在本章出现两次）照报——分两半写偶尔会把段落写两遍。
      const sameSpot = normalize(earlierQuote).includes(normalize(quote)) || normalize(quote).includes(normalize(earlierQuote));
      const shorter = normalize(rawQuote).length <= normalize(rawEarlier).length ? normalize(rawQuote) : normalize(rawEarlier);
      const appearsTwice = shorter.length >= 4 && body.indexOf(shorter) !== body.lastIndexOf(shorter);
      if (sameSpot && !appearsTwice) continue;
    }
    out.push({ quote, earlierQuote, earlierChapter, reason, kind: "event", confidence: readConfidence(record) });
  }
  return out;
}

/**
 * 上次报的问题两边原句是否都还在（本章那句在本章；前文那句在它标的那一章或本章更早处）。改掉了的不再带上。
 * 必须逐字还在：作者改错往往只改一两个字（「一九八五」→「一九八七」），模糊比对会把改好的当成还在
 * （2026-10-10 真机验收：改完三处再核，三处原样又报了一遍）。逐字对不上就不带，交给这次重新核。
 * 两句都在本章的：两句连同中间那段也得和上次一字不差——本章前后对不上，常是作者挪了段、在中间补了一句改好的，
 * 两句原样都还在（长篇连写 2026-10-24：作者把错位的一句挪回原处再核，「确定」照带、改好了还报）。
 */
export function issueStillPresent(
  issue: ContinuityIssueV2,
  chapter: number,
  draftBody: string,
  earlier: EarlierText,
  previousBody: string,
  settingStillSays: (settingQuote: string) => boolean = () => false,
): boolean {
  const body = normalize(draftBody);
  const quote = normalize(issue.quote);
  const earlierQuote = normalize(issue.earlierQuote);
  if (quote.length < 4) return false;
  // 对设定本的条目：earlierQuote 是设定原文、不在任何一章里——错的那句还在（本章，或 fixChapter 指的那章）、
  // 设定本也还这么写，才算没改掉（以前拿设定原文去正文里找，改稿后这类条目永远带不过来）。
  if (issue.againstSetting) {
    const home = issue.fixChapter !== undefined && issue.fixChapter !== chapter
      ? earlier.chapters.find((item) => item.chapter === issue.fixChapter)
      : undefined;
    const where = home ? normalize(home.sentences.join("")) : issue.fixChapter !== undefined && issue.fixChapter !== chapter ? "" : body;
    return where.includes(quote) && settingStillSays(issue.earlierQuote);
  }
  if (!body.includes(quote)) return false;
  if (issue.earlierChapter === chapter) {
    const span = spanBetween(body, quote, earlierQuote);
    return span !== undefined && span === spanBetween(normalize(previousBody), quote, earlierQuote);
  }
  const earlierChapter = earlier.chapters.find((item) => item.chapter === issue.earlierChapter);
  return Boolean(earlierChapter) && normalize(earlierChapter!.sentences.join("")).includes(earlierQuote);
}

/** 两句按出现先后连同中间那段；有一句不在就没有。 */
function spanBetween(text: string, a: string, b: string): string | undefined {
  const at = text.indexOf(a);
  const bt = text.indexOf(b);
  if (at < 0 || bt < 0) return undefined;
  return text.slice(Math.min(at, bt), Math.max(at + a.length, bt + b.length));
}

/** 先发一份；afterMs 后还没结果就再发一份；先成功的为准，两份都失败才算失败。 */
export function hedged<T>(run: () => Promise<T>, afterMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let started = 0;
    let failed = 0;
    let lastError: unknown;
    const attempt = () => {
      started += 1;
      run().then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          failed += 1;
          lastError = error;
          if (!settled && failed >= started && (started >= 2 || timerFired)) {
            settled = true;
            reject(lastError);
          } else if (!settled && started < 2) {
            // 第一份先失败了：不用等对冲时间，马上补发一份（就是原先的「失败重试一次」）。
            clearTimeout(timer);
            timerFired = true;
            attempt();
          }
        },
      );
    };
    let timerFired = false;
    const timer = setTimeout(() => {
      timerFired = true;
      if (!settled && started < 2) attempt();
    }, afterMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    attempt();
  });
}

/**
 * 确定性层：账本里带数字的硬设定 vs 本章（引擎 findLedgerNumberConflicts，不调模型）。
 * 账本读不了如实记进 failures（不吞掉），模型那一路照跑。
 */
export async function ledgerNumberIssues(input: {
  readonly projectDir: string;
  readonly chapter: number;
  readonly draftBody: string;
  readonly ledgerFacts?: readonly FactEntry[];
}): Promise<{ readonly issues: readonly ContinuityIssueV2[]; readonly failures: readonly string[] }> {
  let facts = input.ledgerFacts;
  if (!facts) {
    try {
      facts = (await readFactLedgerStrict(input.projectDir)).facts;
    } catch (error) {
      return { issues: [], failures: [`账本读不了，这次没对账：${error instanceof Error ? error.message : String(error)}`] };
    }
  }
  const issues = findLedgerNumberConflicts({ chapter: input.chapter, draftBody: input.draftBody, facts }).map((conflict) => ({
    quote: conflict.quote,
    earlierQuote: conflict.earlierQuote,
    earlierChapter: conflict.earlierChapter,
    reason: conflict.reason,
    kind: "number" as const,
    confidence: "sure" as const,
    source: "ledger" as const,
  }));
  return { issues, failures: [] };
}

/**
 * 合并去重：先来的留下。同一句只留一条——账本对账、核账记忆带上次的、核账员三遍常从同一句里各抄一段报同一个问题，作者看到两三遍。
 * 同一句：一条的原句包含另一条的，或两段搭着抄（一条的尾巴就是另一条的开头）。长篇连写走查（2026-10-24）：
 * 「……就在那排库房往里数第三个门」和「就在那排库房往里数第三个门，门前一小片空地……」各算一条，作者看到两遍、批量改时后一处已跟着改掉。
 */
export function mergeContinuityIssues(ordered: readonly ContinuityIssueV2[]): ContinuityIssueV2[] {
  const merged: ContinuityIssueV2[] = [];
  const seen = new Set<string>();
  for (const issue of ordered) {
    const key = normalize(issue.quote).slice(0, 16);
    if (seen.has(key)) continue;
    const quote = normalize(issue.quote);
    if (merged.some((other) => sameSentence(normalize(other.quote), quote))) continue;
    seen.add(key);
    merged.push(issue);
  }
  return merged;
}

/**
 * 一对方向相反的条目（本章 A 句对不上本章 B 句、又报 B 句对不上 A 句）：两条各让改对方，「改掉这 N 处」一起改，
 * 两句会互换说法、照样对不上（长篇连写 2026-10-24：一条要把「阮」改成「刘」，一条要把「刘」改成「阮」）。
 * 哪句对代码判不了，两条都降成「可能」，交作者在卡上挑一条改。只看本章内的冲突（对前文某章的，前文那句不在本章，不会成对）。
 */
export function settleMirroredIssues(issues: readonly ContinuityIssueV2[], chapter: number): ContinuityIssueV2[] {
  const inChapter = (issue: ContinuityIssueV2): boolean =>
    issue.earlierChapter === chapter && issue.fixChapter === undefined && !issue.againstSetting;
  const mirrored = new Set<number>();
  issues.forEach((a, i) => {
    if (!inChapter(a)) return;
    issues.forEach((b, j) => {
      if (j <= i || !inChapter(b)) return;
      if (sameSentence(normalize(a.quote), normalize(b.earlierQuote)) && sameSentence(normalize(b.quote), normalize(a.earlierQuote))) {
        mirrored.add(i);
        mirrored.add(j);
      }
    });
  });
  return issues.map((issue, index) => (mirrored.has(index) && issue.confidence === "sure" ? { ...issue, confidence: "maybe" as const } : issue));
}

/**
 * 上一遍按核账改过的句子，这遍核账又说它不对（倒计时改成八天、再核又说不该是八天）：哪遍对代码判不了，
 * 再自动改就来回改。错在本章、原句落在改后那句里（改后那句还在稿里）的「确定」降成「可能」，带上改前那句给作者看。
 */
export function settleRevisitedIssues(
  issues: readonly ContinuityIssueV2[],
  chapter: number,
  body: string,
  fixes: readonly { readonly from: string; readonly to: string }[],
): ContinuityIssueV2[] {
  if (fixes.length === 0) return [...issues];
  const text = normalize(body);
  const live = fixes.filter((fix) => {
    const to = normalize(fix.to);
    return to.length > 0 && text.includes(to);
  });
  return issues.map((issue) => {
    if (issue.confidence !== "sure" || (issue.fixChapter !== undefined && issue.fixChapter !== chapter)) return issue;
    const quote = normalize(issue.quote);
    const fix = [...live].reverse().find((candidate) => sameSentence(normalize(candidate.to), quote));
    return fix ? { ...issue, confidence: "maybe" as const, revisited: { from: fix.from } } : issue;
  });
}

/** 两段搭着抄至少这么多字才算同一句（太短的搭边，如一个「她说」，不算）。 */
const QUOTE_OVERLAP_MIN = 8;

function sameSentence(a: string, b: string): boolean {
  return a.includes(b) || b.includes(a) || overlapsAtEdge(a, b) || overlapsAtEdge(b, a);
}

/** head 的尾巴就是 tail 的开头（搭上 ≥ QUOTE_OVERLAP_MIN 个字）。 */
function overlapsAtEdge(head: string, tail: string): boolean {
  for (let size = Math.min(head.length, tail.length) - 1; size >= QUOTE_OVERLAP_MIN; size -= 1) {
    if (head.endsWith(tail.slice(0, size))) return true;
  }
  return false;
}

// ---------- 相对日子换算（2026-10-14 编辑部 R7.3，确定性、不调模型） ----------

/**
 * 固定说法（任务单 R7.3 点名这六个，别扩词表）；delta＝相对「说话那天」的偏移天数。
 * 报告 3.3：第 1 章（第 1 天）「后天上午陆川来」对第 2 章（第 2 天）「明天上午陆川来」，其实是同一天，
 * 按字面比会把对的改成错的。修法：两句里都有这几个说法时，先按时间线里两章各自的故事日换算成绝对第几天再比。
 */
const RELATIVE_DAY_WORDS: readonly { readonly word: string; readonly delta: number }[] = [
  { word: "大后天", delta: 3 },
  { word: "后天", delta: 2 },
  { word: "明天", delta: 1 },
  { word: "今天", delta: 0 },
  { word: "昨天", delta: -1 },
  { word: "前天", delta: -2 },
];

/**
 * 「目前天气」「眼前天色」「然后天亮」这类前一个字里的前天 / 后天不是在说日子（守卫口径沿用引擎
 * story-timeline 的 RELATIVE_DAY_PATTERNS）；「大前天」不在这六个说法里，也别把它吃成「前天」。
 */
const RELATIVE_DAY_GUARDS = new Set([..."目眼面跟门提当之以空从向往日然最随之其落背身先午稍过", "大"]);

/** 一句话里认到的相对日子说法，按出现顺序（大后天先认，不会吃成后天；守卫字后的不算）。 */
export function relativeDayMentions(text: string): readonly { readonly word: string; readonly delta: number }[] {
  const out: { readonly word: string; readonly delta: number }[] = [];
  let index = 0;
  while (index < text.length) {
    const hit = RELATIVE_DAY_WORDS.find(({ word }) => text.startsWith(word, index));
    if (!hit) {
      index += 1;
      continue;
    }
    const guarded = (hit.word === "前天" || hit.word === "后天") && index > 0 && RELATIVE_DAY_GUARDS.has(text[index - 1]!);
    if (!guarded) out.push(hit);
    index += hit.word.length;
  }
  return out;
}

/**
 * 一章可靠的故事日：时间线里没有它的条目、或条目是 fallback（「上一章 +1」估的，作者还没确认，
 * R7.6 之前常估错——拿估的日子当真去删「确定」会错杀）都算换算不了。
 * 唯一例外：第 1 章的 fallback，day＝1 不是估出来的（前面没有章），引擎口径里必然是 1。
 */
function reliableStoryDay(timeline: StoryTimeline | undefined, chapter: number): number | undefined {
  const entry = timeline ? timelineEntryFor(timeline, chapter) : undefined;
  if (!entry) return undefined;
  if (entry.source === "fallback" && !(chapter === 1 && entry.day === 1)) return undefined;
  return entry.day;
}

/**
 * 相对日子换算（产品路专用，核账服务合并后过一遍）：
 * - 两句里都有固定说法、且两章都有可靠故事日 → 各自换算成绝对第几天再比：是同一天就不报
 *   （字面「明天 / 后天」不同不是错，报告 3.3）；换算出来不足第 1 天（日子在故事开始前）算换算不了。
 * - 两边只有一处说法才比：两边各有好几处说法的（把两个日子对调了那类），代码分不出谁对谁，交给模型。
 * - 换算不了（缺可靠故事日）→ 最多算「可能」，不进「确定」。
 * 对的是设定本的条目不适用（设定原文不锚在某一天上）。
 */
export function applyRelativeDayAlignment(
  issues: readonly ContinuityIssueV2[],
  chapter: number,
  timeline: StoryTimeline | undefined,
): ContinuityIssueV2[] {
  const out: ContinuityIssueV2[] = [];
  for (const issue of issues) {
    if (issue.againstSetting) {
      out.push(issue);
      continue;
    }
    const here = relativeDayMentions(issue.quote);
    const there = relativeDayMentions(issue.earlierQuote);
    if (here.length === 0 || there.length === 0) {
      out.push(issue);
      continue;
    }
    const dayHere = reliableStoryDay(timeline, chapter);
    const dayThere = reliableStoryDay(timeline, issue.earlierChapter);
    if (dayHere === undefined || dayThere === undefined) {
      out.push({ ...issue, confidence: "maybe" });
      continue;
    }
    if (here.length === 1 && there.length === 1) {
      const absHere = dayHere + here[0]!.delta;
      const absThere = dayThere + there[0]!.delta;
      if (absHere < 1 || absThere < 1) {
        out.push({ ...issue, confidence: "maybe" });
        continue;
      }
      if (absHere === absThere) continue; // 换算后是同一天：不报
    }
    out.push(issue);
  }
  return out;
}
