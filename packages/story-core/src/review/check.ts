/**
 * 定稿前逐条核对：结构对不对、原句在不在正文里、指向的线索和事实在不在。
 * 预览（出定稿清单）和「定稿」命令用的是同一个函数，所以预览说能记上的，定稿就记得上。
 * 核不过的条目如实列出来（这条没记上 + 为什么），绝不悄悄丢、也不退回去猜。
 *
 * 东西（P3b 设计 2.4）整批一起收：先收本章新写到的（appear：标签、名字、原句），再收别的——每处指的东西
 * （主体、装在哪样里面、从哪样里面拿出来、清点成员、事实的主体）都得是前文已有的编号或本批收了的标签；
 * 声明没收的，引用它的全不收（不从引用反造东西）；清点里有一样不收，整条清点不收。
 */
import { declaredQuotes, entryShapeProblem, type EntryInput, type ItemRefInput } from "../schema/ledger.js";
import { chapterSource, timeDeclarationProblem } from "../ledger/entries.js";
import { quoteInText } from "../text/quote.js";
import type { BookProjection } from "../projection/types.js";

export type RejectReason = "shape" | "quote_not_in_text" | "unknown_thread" | "unknown_fact" | "duplicate" | "unknown_item";

/** 一条声明里指到的东西（主体、装在哪样里面、从哪样里面、清点成员；事实的主体）。 */
export function itemRefsOfInput(entry: EntryInput): readonly ItemRefInput[] {
  if (entry.kind === "fact") return entry.item ? [entry.item] : [];
  if (entry.kind !== "item" || entry.op === "appear") return [];
  return [
    ...(entry.item ? [entry.item] : []),
    ...(entry.to?.kind === "inside" ? [entry.to.item] : []),
    ...(entry.from?.kind === "inside" ? [entry.from.item] : []),
    ...(entry.members ?? []),
  ];
}

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
    case "item":
      return entry.op === "appear" ? `东西「${entry.name ?? ""}」` : `东西${entry.item?.mention ? `「${entry.item.mention}」` : ""}的去向`;
  }
};

/**
 * @param before 本章之前（不含本章）的投影：推进、收口只能指向它里面的线索，推翻只能指向它里面的事实。
 */
export function checkEntries(entries: readonly EntryInput[], text: string, before: BookProjection): CheckResult {
  const knownThreads = new Set(before.threads.flatMap((thread) => [thread.id, ...thread.mergedFrom]));
  const knownFacts = new Set(before.facts.map((fact) => fact.id));
  // 前文已有的东西：投影里的编号和作者并进去的旧编号（账里还写着旧号的照样指得到那样）。
  const knownItems = new Set(before.items.flatMap((item) => [item.id, ...item.mergedFrom]));
  const accepted: { index: number; entry: EntryInput }[] = [];
  const rejected: RejectedEntry[] = [];
  let summaries = 0;
  let times = 0;
  let days = 0;
  let source: ReturnType<typeof chapterSource> | undefined;
  const basicProblem = (entry: EntryInput): { reason: RejectReason; why: string } | undefined => {
    const shape = entryShapeProblem(entry);
    if (shape) return { reason: "shape", why: shape };
    const quotes = declaredQuotes(entry);
    if (quotes.some((quote) => !quote)) return { reason: "quote_not_in_text", why: "没附原句" };
    if (quotes.some((quote) => !quoteInText(quote as string, text))) return { reason: "quote_not_in_text", why: "附的原句在正文里找不到" };
    return undefined;
  };
  // 先收本章新写到的东西：收了的标签别的条目才指得到。
  const tags = new Set<string>();
  const appearProblem = new Map<number, { reason: RejectReason; why: string }>();
  entries.forEach((entry, index) => {
    if (entry.kind !== "item" || entry.op !== "appear") return;
    const problem = basicProblem(entry) ?? (tags.has(entry.tag ?? "") ? { reason: "duplicate" as const, why: "同一个标签写了两样东西" } : undefined);
    if (problem) appearProblem.set(index, problem);
    else tags.add(entry.tag as string);
  });
  const itemKnown = (ref: ItemRefInput): boolean => ("id" in ref ? knownItems.has(ref.id) : tags.has(ref.tag));
  entries.forEach((entry, index) => {
    const reject = (reason: RejectReason, why: string) => rejected.push({ index, entry, reason, message: `${label(entry)}没记上：${why}` });
    const appear = appearProblem.get(index);
    if (appear) return reject(appear.reason, appear.why);
    if (entry.kind === "item" && entry.op === "appear") return accepted.push({ index, entry });
    const problem = basicProblem(entry);
    if (problem) return reject(problem.reason, problem.why);
    const refs = itemRefsOfInput(entry);
    if (refs.some((ref) => !itemKnown(ref))) {
      return reject("unknown_item", entry.kind === "item" && entry.op === "census" ? "清点里有一样东西前文没有、本章也没记上，整条清点没记" : "指的东西前文没有、本章也没记上");
    }
    if (entry.kind === "item") {
      const links = [entry, ...(entry.members ?? [])].flatMap((at) => [...(at.replaces ?? []), ...(at.overlaps ?? [])]);
      if (links.some((ref) => !knownFacts.has(ref))) return reject("unknown_fact", "要对上的那条旧事实前文没有");
      return accepted.push({ index, entry });
    }
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
