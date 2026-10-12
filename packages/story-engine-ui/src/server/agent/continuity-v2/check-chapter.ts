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
import { findLedgerNumberConflicts, readFactLedgerStrict, type FactEntry } from "@actalk/story-engine";

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

const SELF_DISMISSED = /不矛盾|并不矛盾|没有矛盾|无矛盾|一致[，。；,;]?(?:没有|无|不)|说法一致|前后一致|不冲突|并不冲突|不算矛盾|可以解释|说得通/u;

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
    if (!containsQuote(body, quote) || SELF_DISMISSED.test(reason)) continue;
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
