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
 * 调模型的编排（通读三遍 + 拆说法逐条判 + 复核）随旧路删除；核账只剩编辑部核账员（brain/checker.ts）。
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { findLedgerNumberConflicts, readFactLedgerStrict, timelineEntryFor, type FactEntry, type StoryTimeline } from "@actalk/story-engine";

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
  readonly againstSetting?: { readonly label: string };
  /** R7.3 错在哪一章、按钮就改哪一章（quote 抄自前文某章时由代码定）；缺省＝当前核的章。 */
  readonly fixChapter?: number;
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

export const normalize = (text: string): string => text.replace(/\s+/gu, "");

/** 句子切分：保留引号内的完整句。 */
export function splitSentences(text: string): readonly string[] {
  const out: string[] = [];
  for (const paragraph of text.split(/\n+/u)) {
    const parts = paragraph.match(/[^。！？!?…]+[。！？!?…]*[”」』"]?/gu) ?? [];
    for (const part of parts) {
      const sentence = part.trim();
      if (sentence.length >= 4) out.push(sentence);
    }
  }
  return out;
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
    chapters.push({ chapter: n, sentences: splitSentences(raw.replace(/^#[^\n]*\n/u, "")) });
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

export function parseFullReadIssues(text: string, chapter: number, draftBody: string, earlier: EarlierText): readonly ContinuityIssueV2[] {
  const parsed = parseJson(text);
  const raw = Array.isArray(parsed.contradictions) ? parsed.contradictions : [];
  const body = normalize(draftBody);
  const earlierByChapter = new Map(earlier.chapters.map((item) => [item.chapter, normalize(item.sentences.join(""))]));
  const out: ContinuityIssueV2[] = [];
  for (const item of raw) {
    const record = asRecord(item);
    if (!record) continue;
    const quote = String(record.quote ?? "").trim();
    const earlierQuote = String(record.earlierQuote ?? "").trim();
    const reason = String(record.reason ?? "").trim();
    // 理由里自己说「不矛盾」的不再按词表丢（重构 P7「不猜」）：是不是问题由 A 自复核的结构化判定（sure / maybe / no）定。
    if (!containsQuote(body, quote)) continue;
    const claimedChapter = Number(record.earlierChapter);
    let earlierChapter: number | undefined;
    // 本章自己和自己比：两句互相包含就是同一处（浏览器实测：「兜里只剩这一张纸了」对上含它的那一整句，报成「重复」）。
    // 真重复（同一句在本章出现两次）照报——分两半写偶尔会把段落写两遍。
    const sameSpot = normalize(earlierQuote).includes(normalize(quote)) || normalize(quote).includes(normalize(earlierQuote));
    const shorter = normalize(quote).length <= normalize(earlierQuote).length ? normalize(quote) : normalize(earlierQuote);
    const appearsTwice = shorter.length >= 4 && body.indexOf(shorter) !== body.lastIndexOf(shorter);
    if (containsQuote(body, earlierQuote) && sameSpot && !appearsTwice) continue;
    if (containsQuote(body, earlierQuote)) earlierChapter = chapter;
    else if (Number.isInteger(claimedChapter) && earlierByChapter.has(claimedChapter) && containsQuote(earlierByChapter.get(claimedChapter)!, earlierQuote)) earlierChapter = claimedChapter;
    else earlierChapter = [...earlierByChapter.entries()].find(([, text]) => containsQuote(text, earlierQuote))?.[0];
    if (earlierChapter === undefined) continue;
    out.push({ quote, earlierQuote, earlierChapter, reason, kind: "event" });
  }
  return out;
}

/**
 * 上次报的问题两边原句是否都还在（本章那句在本章；前文那句在它标的那一章或本章更早处）。改掉了的不再带上。
 * 必须逐字还在：作者改错往往只改一两个字（「一九八五」→「一九八七」），模糊比对会把改好的当成还在
 * （2026-10-10 真机验收：改完三处再核，三处原样又报了一遍）。逐字对不上就不带，交给这次重新核。
 */
export function issueStillPresent(issue: ContinuityIssueV2, chapter: number, draftBody: string, earlier: EarlierText): boolean {
  const body = normalize(draftBody);
  const quote = normalize(issue.quote);
  const earlierQuote = normalize(issue.earlierQuote);
  if (quote.length < 4 || !body.includes(quote)) return false;
  if (issue.earlierChapter === chapter) return body.includes(earlierQuote);
  const earlierChapter = earlier.chapters.find((item) => item.chapter === issue.earlierChapter);
  return Boolean(earlierChapter) && normalize(earlierChapter!.sentences.join("")).includes(earlierQuote);
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
 * 合并去重：先来的留下。同一句（一条的原句包含另一条的）只留一条——账本对账、核账记忆带上次的、
 * 核账员三遍常从同一句里各抄一段报同一个问题，作者看到两三遍。
 */
export function mergeContinuityIssues(ordered: readonly ContinuityIssueV2[]): ContinuityIssueV2[] {
  const merged: ContinuityIssueV2[] = [];
  const seen = new Set<string>();
  for (const issue of ordered) {
    const key = normalize(issue.quote).slice(0, 16);
    if (seen.has(key)) continue;
    const quote = normalize(issue.quote);
    if (merged.some((other) => { const kept = normalize(other.quote); return kept.includes(quote) || quote.includes(kept); })) continue;
    seen.add(key);
    merged.push(issue);
  }
  return merged;
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
