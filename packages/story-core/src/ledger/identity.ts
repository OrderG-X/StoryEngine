/**
 * 重记同一章时编号怎么沿用（写作版本 P2b 设计 3.1）：定稿、通读记账、补账都走这一处。
 *
 * - 认得的旧条目 = 上一份账单的条目 + 它带着的 carry（同一编号留上一份账单那版）。
 * - 同一条只认声明写法完全一样（entryKey，只比字面，不猜意思）→ 沿用旧编号；
 *   新开线索：记账员写了认得的旧线索号、或标题一字不差且原句落在这版正文的同一句 → 沿用旧线索号。只同标题不算：
 *   改过的章同名不同事，套上旧号会被后文收口错接（P2b 出口复核第 1 条）。
 * - 其余发新号，从认得的旧号里最大的序号往后排：被裁定作废的、被后文 replaces 引着的旧号空着，不落到别的条目头上。
 * - 新账的 carry = 上一份账单的条目 ∪ 它的 carry：连着几次重记（中间账待记也一样）旧号都还占着。
 */
import { threadOf, type ChapterLedger, type EntryInput, type LedgerEntry, type LedgerPrevious, type ThreadEntry } from "../schema/ledger.js";
import { nameKey, normalizeForQuote } from "../text/quote.js";
import { declarationOf, locateQuote, type ChapterSource, type EntryIds } from "./entries.js";

/** 原句落在哪：给了这版正文且找得到唯一一处 → 第几句到第几句（同一句不管原句抄全没抄全、标点带没带）；否则按原句字面。 */
function quoteSpot(quote: string | undefined, source: ChapterSource | undefined): string {
  if (quote === undefined) return "";
  const units = source ? locateQuote(quote, source)?.units : undefined;
  return units ? `#${units.from}-${units.to}` : normalizeForQuote(quote);
}

/** 判断「同一条」的键：只认写法完全一样，不猜意思（新开线索连原句落在这版正文哪一句一起比）。 */
export function entryKey(entry: EntryInput, source?: ChapterSource): string {
  switch (entry.kind) {
    case "summary":
      return "summary";
    case "time":
      return "time";
    case "presence":
      return `presence|${nameKey(entry.name)}|${nameKey(entry.nameUsed)}`;
    case "fact":
      return [
        "fact",
        entry.nature,
        nameKey(entry.subject ?? ""),
        nameKey(entry.attribute ?? ""),
        nameKey(entry.value ?? ""),
        entry.nature === "event" ? nameKey(entry.text) : "",
      ].join("|");
    case "thread":
      return entry.op === "open"
        ? `thread|open|${nameKey(entry.title ?? "")}|${quoteSpot(entry.quote, source)}`
        : `thread|${entry.op}|${entry.thread ?? ""}|${nameKey(entry.note)}`;
  }
}

/** 这一章以前各版账单里出现过的全部条目（同一编号留最近那版），按先上一份账单、再 carry 排。 */
export function knownEntries(previous: ChapterLedger | undefined): readonly LedgerEntry[] {
  if (!previous) return [];
  const seen = new Set<string>();
  const out: LedgerEntry[] = [];
  for (const entry of [...previous.entries, ...(previous.previous?.carry.entries ?? [])]) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push(entry);
  }
  return out;
}

/** 认得的旧条目里新开的线索（同一线索号留最近那版）。 */
export function knownOpens(previous: ChapterLedger | undefined): readonly ThreadEntry[] {
  const seen = new Set<string>();
  return knownEntries(previous).flatMap((entry) => {
    if (entry.kind !== "thread" || entry.op !== "open" || seen.has(threadOf(entry))) return [];
    seen.add(threadOf(entry));
    return [entry];
  });
}

/** 新账单要带的 previous：上一份账单的原样哈希 + 认得的旧条目。没有可带的（新章、上一份是空的待记）就不带。 */
export function previousOf(previous: ChapterLedger | undefined, previousSha256: string | undefined): LedgerPrevious | undefined {
  const entries = knownEntries(previous);
  if (!previous || previousSha256 === undefined || entries.length === 0) return undefined;
  return { ledgerSha256: previousSha256, carry: { entries: [...entries] } };
}

/** 编号里最大的序号（`c3-7` → 7；`c3-7-end` 这类不算，它跟着 `c3-7`）。 */
function maxSeq(ids: Iterable<string>, prefix: string): number {
  let max = 0;
  for (const id of ids) {
    if (!id.startsWith(prefix)) continue;
    const seq = Number(id.slice(prefix.length));
    if (Number.isInteger(seq) && seq > max) max = seq;
  }
  return max;
}

export interface AssignedIds {
  /** 和交来的条目一一对应。 */
  readonly ids: readonly EntryIds[];
  /** 认得的旧开线索里这次没沿用的线索号（后文还接着它的要如实说）。 */
  readonly droppedOpens: readonly ThreadEntry[];
}

/** 给一章这次要记的条目分配编号（重记时照认得的旧条目沿用）。source = 这次记的那版正文。 */
export function assignIds(chapter: number, previous: ChapterLedger | undefined, entries: readonly EntryInput[], source: ChapterSource): AssignedIds {
  const known = knownEntries(previous);
  const idByKey = new Map<string, string>();
  for (const entry of known) {
    const declared = declarationOf(entry, known);
    if (declared && !idByKey.has(entryKey(declared, source))) idByKey.set(entryKey(declared, source), entry.id);
  }
  const opens = knownOpens(previous);
  const openThreadByKey = new Map<string, string>();
  for (const entry of opens) {
    const declared = declarationOf(entry, known);
    if (declared && !openThreadByKey.has(entryKey(declared, source))) openThreadByKey.set(entryKey(declared, source), threadOf(entry));
  }
  const openThreadIds = new Set(opens.map(threadOf));

  const entryPrefix = `c${chapter}-`;
  const threadPrefix = `t${chapter}-`;
  let nextEntry = maxSeq(known.map((entry) => entry.id), entryPrefix);
  let nextThread = maxSeq(openThreadIds, threadPrefix);
  const usedIds = new Set<string>();
  const usedThreads = new Set<string>();
  const ids = entries.map((entry): EntryIds => {
    const key = entryKey(entry, source);
    const reuse = idByKey.get(key);
    const id = reuse && !usedIds.has(reuse) ? reuse : `${entryPrefix}${(nextEntry += 1)}`;
    usedIds.add(id);
    if (entry.kind !== "thread" || entry.op !== "open") return { id };
    const keep = entry.thread && openThreadIds.has(entry.thread) && !usedThreads.has(entry.thread) ? entry.thread : openThreadByKey.get(key);
    const thread = keep && !usedThreads.has(keep) ? keep : `${threadPrefix}${(nextThread += 1)}`;
    usedThreads.add(thread);
    return { id, thread };
  });
  return { ids, droppedOpens: opens.filter((entry) => !usedThreads.has(threadOf(entry))) };
}
