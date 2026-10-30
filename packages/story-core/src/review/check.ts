/**
 * 定稿前逐条核对：结构对不对、原句在不在正文里、指向的线索和事实在不在。
 * 预览（出定稿清单）和「定稿」命令用的是同一个函数，所以预览说能记上的，定稿就记得上。
 * 核不过的条目如实列出来（这条没记上 + 为什么），绝不悄悄丢、也不退回去猜。
 */
import { declaredQuotes, entryShapeProblem, type EntryInput } from "../schema/ledger.js";
import { chapterSource, timeDeclarationProblem } from "../ledger/entries.js";
import { quoteInText } from "../text/quote.js";
import type { BookProjection } from "../projection/types.js";

export type RejectReason = "shape" | "quote_not_in_text" | "unknown_thread" | "unknown_fact" | "duplicate";

export interface RejectedEntry {
  readonly index: number;
  readonly entry: EntryInput;
  readonly reason: RejectReason;
  /** 给作者看的一句话。 */
  readonly message: string;
}

export interface CheckResult {
  /** 通过的条目（保持原顺序，带原下标）。 */
  readonly accepted: readonly { readonly index: number; readonly entry: EntryInput }[];
  readonly rejected: readonly RejectedEntry[];
}

const label = (entry: EntryInput): string => {
  switch (entry.kind) {
    case "summary":
      return "本章梗概";
    case "fact":
      return `「${entry.text}」`;
    case "thread":
      return entry.title ? `线索「${entry.title}」` : "一条线索";
    case "time":
      return "本章时间";
    case "day":
      return "作者定的天数";
    case "presence":
      return `出场人物「${entry.nameUsed}」`;
  }
};

/**
 * @param before 本章之前（不含本章）的投影：推进、收口只能指向它里面的线索，推翻只能指向它里面的事实。
 */
export function checkEntries(entries: readonly EntryInput[], text: string, before: BookProjection): CheckResult {
  const knownThreads = new Set(before.threads.flatMap((thread) => [thread.id, ...thread.mergedFrom]));
  const knownFacts = new Set(before.facts.map((fact) => fact.id));
  const accepted: { index: number; entry: EntryInput }[] = [];
  const rejected: RejectedEntry[] = [];
  let summaries = 0;
  let times = 0;
  let days = 0;
  let source: ReturnType<typeof chapterSource> | undefined;
  entries.forEach((entry, index) => {
    const reject = (reason: RejectReason, why: string) => rejected.push({ index, entry, reason, message: `${label(entry)}没记上：${why}` });
    const shape = entryShapeProblem(entry);
    if (shape) return reject("shape", shape);
    const quotes = declaredQuotes(entry);
    if (quotes.some((quote) => quote === undefined)) return reject("quote_not_in_text", "没附原句");
    if (quotes.some((quote) => !quoteInText(quote as string, text))) return reject("quote_not_in_text", "附的原句在正文里找不到");
    if (entry.kind === "time") {
      const problem = timeDeclarationProblem(entry, (source ??= chapterSource(0, text)));
      if (problem) return reject("shape", problem);
    }
    if (entry.kind === "thread" && entry.op !== "open" && !knownThreads.has(entry.thread ?? "")) {
      return reject("unknown_thread", "指向的线索前文没有");
    }
    if (entry.kind === "fact" && entry.replaces?.some((ref) => !knownFacts.has(ref))) return reject("unknown_fact", "要推翻的那条前文没有");
    if (entry.kind === "summary" && (summaries += 1) > 1) return reject("duplicate", "一章只记一条梗概");
    if (entry.kind === "time" && (times += 1) > 1) return reject("duplicate", "一章只记一条时间");
    if (entry.kind === "day" && (days += 1) > 1) return reject("duplicate", "作者定的天数一章只有一条");
    accepted.push({ index, entry });
  });
  return { accepted, rejected };
}
