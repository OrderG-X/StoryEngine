/**
 * 重记同一章时编号怎么沿用（写作版本 P2b 设计 3.1）：定稿、通读记账、补账都走这一处。
 *
 * - 认得的旧条目 = 上一份账单的条目 + 它带着的 carry（同一编号留上一份账单那版）。
 * - 同一条只认声明写法完全一样（entryKey，只比字面，不猜意思）→ 沿用旧编号；
 *   新开线索只认记账员写明的旧线索号（重记时它拿到这章上次开的线索和编号）。标题、原句一样都不算：
 *   改过的章同名不同事，同一句里也能是两件事，套上旧号会被后文收口错接（P2b 出口复核第 1 条、第 2 轮）。
 * - 其余发新号，从认得的旧号里最大的序号往后排：被裁定作废的、被后文 replaces 引着的旧号空着，不落到别的条目头上。
 * - 新账的 carry = 上一份账单的条目 ∪ 它的 carry：连着几次重记（中间账待记也一样）旧号都还占着。
 *   时间另带最近一份记了时间的账单那一套（条目、段、时间格式），账待记那份照它读回上次的时间（出口复核 R6）。
 * - 东西（P3b 设计 3.3）：本章头回写到的东西只认记账员写明的上次编号（reuse，它拿到这章上次新记的东西和编号），
 *   别的都发新号「i{章}-{n}」，从认得的旧号里最大的往后排（旧号照样占着，carry 里的旧去向不复活）。
 *   东西条目同一条的键里，东西一律换成编号再比（本批标签换成这次发的号）。
 */
import {
  missingKindsOf,
  threadOf,
  type ChapterLedger,
  type EntryInput,
  type ItemEntry,
  type ItemPlaceInput,
  type ItemRefInput,
  type LedgerCarryTime,
  type LedgerEntry,
  type LedgerPrevious,
  type ThreadEntry,
  type TimeEntry,
} from "../schema/ledger.js";
import { nameKey } from "../text/quote.js";
import { bornItems, dayDeclarationOf, declarationOf, timeDeclarationOf, type EntryIds } from "./entries.js";

/** 声明里的东西换成编号（标签按 tags 换；换不上就是标签原样，不和任何旧条目同号）。 */
type ItemIdOf = (ref: ItemRefInput) => string;
const literalItem: ItemIdOf = (ref) => ("id" in ref ? ref.id : `#${ref.tag}`);

const placeKey = (place: ItemPlaceInput | undefined, itemId: ItemIdOf): string => {
  if (!place) return "";
  switch (place.kind) {
    case "person":
      return `p:${nameKey(place.name)}`;
    case "place":
      return `l:${nameKey(place.text)}`;
    case "inside":
      return `i:${itemId(place.item)}`;
    case "unknown":
      return "u";
  }
};

/**
 * 判断「同一条」的键：只认写法完全一样，不猜意思（新开线索连写明的线索号一起比：没写旧号的不和任何旧条目同号）。
 * 东西一律换成编号再比（itemId；缺省标签原样）；东西条目不比先后号和原句（前面多记一条、换了附哪句，说的还是那件事）。
 */
export function entryKey(entry: EntryInput, itemId: ItemIdOf = literalItem): string {
  switch (entry.kind) {
    case "summary":
      return "summary";
    case "time":
      return "time";
    case "day":
      return "day";
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
        entry.item ? itemId(entry.item) : "",
      ].join("|");
    case "item":
      return entry.op === "appear"
        ? `item|appear|${itemId({ tag: entry.tag ?? "" })}`
        : [
          "item",
          entry.op,
          entry.item ? itemId(entry.item) : "",
          placeKey(entry.to, itemId),
          placeKey(entry.from, itemId),
          entry.gone ?? "",
          (entry.members ?? []).map((member) => [itemId(member), ...(member.replaces ?? []), "~", ...(member.overlaps ?? [])].join(" ")).join(","),
          entry.complete === undefined ? "" : String(entry.complete),
        ].join("|");
    case "thread":
      return entry.op === "open"
        ? `thread|open|${entry.thread ?? ""}|${nameKey(entry.title ?? "")}`
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

/**
 * 最近一份记了时间的账单那一套时间：上一份记全了时间就是它的，没记时间（账待记、时间没记全）就接着它带的。
 * 时间没记全、但那次照样记了作者定的天数（作者档、不靠记账员）：作者定的天数整套换成那次的（只定了开头就只有开头，
 * 不把更早那版的结尾拼回来，出口复核 R6c2）；记账员的时间、段、格式照旧接着带的。账待记的那份什么都没记，原样接着带。
 */
export function carriedTime(previous: ChapterLedger | undefined): LedgerCarryTime | undefined {
  if (!previous) return undefined;
  if (missingKindsOf(previous).includes("time")) {
    const older = previous.previous?.carry.time;
    if (!older || previous.status === "pending") return older;
    const author = previous.entries.filter((entry): entry is TimeEntry => entry.kind === "time" && entry.relation === "at");
    return { ...older, entries: [...author, ...older.entries.filter((entry) => entry.relation !== "at")] };
  }
  const entries = previous.entries.filter((entry) => entry.kind === "time");
  if (entries.length === 0 && previous.scenes.length === 0) return undefined;
  return { ...(previous.timeModel ? { timeModel: previous.timeModel } : {}), entries, scenes: previous.scenes };
}

/** 新账单要带的 previous：上一份账单的原样哈希 + 认得的旧条目（+ 最近那套时间）。没有可带的（新章、上一份是空的待记）就不带。 */
export function previousOf(previous: ChapterLedger | undefined, previousSha256: string | undefined): LedgerPrevious | undefined {
  if (!previous || previousSha256 === undefined) return undefined;
  const entries = knownEntries(previous);
  const time = carriedTime(previous);
  // 整章只切了段、没有条目的账也要带上（段在 time 里）。
  if (entries.length === 0 && !time) return undefined;
  return { ledgerSha256: previousSha256, carry: { entries: [...entries], ...(time ? { time } : {}) } };
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

/** 认得的旧条目里本章头回写到的东西（同一编号留最近那版）。 */
export function knownAppears(previous: ChapterLedger | undefined): readonly ItemEntry[] {
  const seen = new Set<string>();
  return knownEntries(previous).flatMap((entry) => {
    if (entry.kind !== "item" || entry.op !== "appear" || seen.has(entry.itemRef.id)) return [];
    seen.add(entry.itemRef.id);
    return [entry];
  });
}

export interface AssignedIds {
  /** 和交来的条目一一对应。 */
  readonly ids: readonly EntryIds[];
  /** 认得的旧开线索里这次没沿用的线索号（后文还接着它的要如实说）。 */
  readonly droppedOpens: readonly ThreadEntry[];
  /** 认得的、本章上次头回写到的东西这次没认上的（后文还用着它的要如实说）。 */
  readonly droppedItems: readonly ItemEntry[];
}

/** 给一章这次要记的条目分配编号（重记时照认得的旧条目沿用）。 */
export function assignIds(chapter: number, previous: ChapterLedger | undefined, entries: readonly EntryInput[]): AssignedIds {
  const known = knownEntries(previous);
  const idByKey = new Map<string, string>();
  // 时间、作者定的天数整章各一条：编号取最近那版的（认得的条目里排最前的；只取编号，段读不全也不要紧）。
  const time = timeDeclarationOf({ entries: known, ...(previous ? { scenes: previous.scenes } : {}) });
  const day = dayDeclarationOf({ entries: known, ...(previous?.timeModel ? { timeModel: previous.timeModel } : {}) });
  if (time) idByKey.set("time", time.id);
  if (day) idByKey.set("day", day.id);
  // 旧条目读回声明时，本章头回写到的东西写成标签（标签就是编号）：键里换回编号。
  const knownBorn = bornItems(known);
  const knownItemId: ItemIdOf = (ref) => ("id" in ref ? ref.id : knownBorn.has(ref.tag) ? ref.tag : `#${ref.tag}`);
  for (const entry of known) {
    const declared = declarationOf(entry, knownBorn);
    if (declared && !idByKey.has(entryKey(declared, knownItemId))) idByKey.set(entryKey(declared, knownItemId), entry.id);
  }
  const opens = knownOpens(previous);
  const openThreadIds = new Set(opens.map(threadOf));
  const appears = knownAppears(previous);
  const appearIds = new Set(appears.map((entry) => entry.itemRef.id));

  const entryPrefix = `c${chapter}-`;
  const threadPrefix = `t${chapter}-`;
  const itemPrefix = `i${chapter}-`;
  let nextEntry = maxSeq(known.map((entry) => entry.id), entryPrefix);
  let nextThread = maxSeq(openThreadIds, threadPrefix);
  let nextItem = maxSeq(known.flatMap((entry) => (entry.kind === "item" ? [entry.itemRef.id] : [])), itemPrefix);
  // 先给本章头回写到的东西发号（别的条目、事实里的标签都换成它）。
  const usedItems = new Set<string>();
  const itemTags = new Map<string, string>();
  const itemOf = new Map<number, string>();
  entries.forEach((entry, index) => {
    if (entry.kind !== "item" || entry.op !== "appear" || !entry.tag || itemTags.has(entry.tag)) return;
    const keep = entry.reuse && appearIds.has(entry.reuse) && !usedItems.has(entry.reuse) ? entry.reuse : undefined;
    const item = keep ?? `${itemPrefix}${(nextItem += 1)}`;
    usedItems.add(item);
    itemTags.set(entry.tag, item);
    itemOf.set(index, item);
  });
  const newItemId: ItemIdOf = (ref) => ("id" in ref ? ref.id : (itemTags.get(ref.tag) ?? `#${ref.tag}`));
  const usedIds = new Set<string>();
  const usedThreads = new Set<string>();
  const ids = entries.map((entry, index): EntryIds => {
    const key = entryKey(entry, newItemId);
    const reuse = idByKey.get(key);
    const id = reuse && !usedIds.has(reuse) ? reuse : `${entryPrefix}${(nextEntry += 1)}`;
    usedIds.add(id);
    const item = itemOf.get(index);
    if (entry.kind === "item" || (entry.kind === "fact" && entry.item)) return { id, ...(item ? { item } : {}), itemTags };
    if (entry.kind !== "thread" || entry.op !== "open") return { id };
    const keep = entry.thread && openThreadIds.has(entry.thread) && !usedThreads.has(entry.thread) ? entry.thread : undefined;
    const thread = keep ?? `${threadPrefix}${(nextThread += 1)}`;
    usedThreads.add(thread);
    return { id, thread };
  });
  return {
    ids,
    droppedOpens: opens.filter((entry) => !usedThreads.has(threadOf(entry))),
    droppedItems: appears.filter((entry) => !usedItems.has(entry.itemRef.id)),
  };
}
