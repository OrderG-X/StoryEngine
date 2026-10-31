/**
 * 东西在哪的说法（写作版本 P3b 设计第 4 节）：记账员的【已有的东西】、写手和章纲员的「东西在哪」、对话 AI、定稿清单同一套字。
 * 全部从投影的 items 现拼，不读正文、不按名字认东西；编号一律换成名字，同名的加区分（头回那句的前几个字，兜底「第 N 章那件」）。
 * 名字解析不到用中性说法「一样东西」。
 */
import { nameKey, normalizeForQuote, type BookProjection, type FactView, type ItemIssueView, type ItemNow, type ItemPlaceView, type ItemSettled, type ItemStep, type ItemView } from "@actalk/story-core";

/** 同名的区分取头回那句的前几个字。 */
const QUOTE_HINT_CHARS = 8;
const NEUTRAL = "一样东西";
const REASON_TEXT = { order: "这章先后没说清", from: "去处和前文接不上", destroyed: "毁了之后又写到它" } as const;

export interface ItemTexts {
  readonly byId: ReadonlyMap<string, ItemView>;
  /** 给人、给模型看的名字（同名的带区分）。 */
  readonly label: (id: string) => string;
}

/** 名字表：同名两样以上的，每样带上头回那句的前几个字（没有就「第 N 章那件」）。 */
export function itemTexts(items: readonly ItemView[]): ItemTexts {
  const byId = new Map(items.map((item) => [item.id, item] as const));
  const counts = new Map<string, number>();
  for (const item of items) if (item.name) counts.set(item.name, (counts.get(item.name) ?? 0) + 1);
  const label = (id: string): string => {
    const item = byId.get(id);
    const name = item?.name;
    if (!item || !name) return NEUTRAL;
    if ((counts.get(name) ?? 0) < 2) return name;
    if (item.card) return `${name}（设定卡上那件）`;
    const quote = item.firstSeen?.quote;
    if (quote) return `${name}（「${[...quote].slice(0, QUOTE_HINT_CHARS).join("")}${[...quote].length > QUOTE_HINT_CHARS ? "…" : ""}」那件）`;
    return item.firstSeen ? `${name}（第 ${item.firstSeen.chapter} 章那件）` : name;
  };
  return { byId, label };
}

/** 去处一句：「沈知秋拿着」「在里屋房梁上」「在铁盒里（铁盒在樟木箱里，樟木箱由沈知秋拿着）」——装在里面的往外找到头（绕成圈的不往外找）。 */
export function placeText(place: ItemPlaceView, texts: ItemTexts): string {
  if (place.kind === "person") return `${place.name}拿着`;
  if (place.kind === "place") return `在${place.text}`;
  const outer: string[] = [];
  const seen = new Set([place.item]);
  for (let container = place.item; ; ) {
    const now = texts.byId.get(container)?.now;
    if (now?.kind !== "known") break;
    const next = now.place;
    if (next.kind !== "inside") {
      outer.push(`${texts.label(container)}${next.kind === "person" ? `由${next.name}拿着` : `在${next.text}`}`);
      break;
    }
    if (seen.has(next.item)) break;
    outer.push(`${texts.label(container)}在${texts.label(next.item)}里`);
    seen.add(next.item);
    container = next.item;
  }
  return `在${texts.label(place.item)}里${outer.length > 0 ? `（${outer.join("，")}）` : ""}`;
}

function settledText(settled: ItemSettled, texts: ItemTexts): string {
  switch (settled.kind) {
    case "known":
      return placeText(settled.place, texts);
    case "gone":
      return `${settled.gone === "lost" ? "丢了" : "毁了"}${settled.note ? `（${settled.note}）` : ""}`;
    case "unknown":
      return "不知道在哪了";
  }
}

/** 现在一句：「沈知秋拿着，第 3 章」「拿不准：乙拿着 / 丙拿着（这章先后没说清，第 3 章）」；没写过 = undefined。 */
export function nowText(now: ItemNow | undefined, texts: ItemTexts): string | undefined {
  if (!now) return undefined;
  if (now.kind === "uncertain") return `拿不准：${now.options.map((option) => settledText(option, texts)).join(" / ")}（${REASON_TEXT[now.reason]}，第 ${now.chapter} 章）`;
  return `${settledText(now, texts)}，第 ${now.chapter} 章`;
}

/** 里面有什么：完整清点（有效 / 此后没核全 / 对不上）或已知有的（一律「可能还有别的」）；什么都不知道 = undefined。 */
export function contentsText(item: ItemView, texts: ItemTexts): string | undefined {
  const census = item.census;
  if (census) {
    const listed = census.members.length === 0 ? "空了" : `只有${census.members.map(texts.label).join("、")}`;
    if (census.status === "valid") return `第 ${census.chapter} 章清点过，之后的挪动都记着：现在里面${listed}`;
    if (census.status === "unverified") return `第 ${census.chapter} 章清点过（${listed}），第 ${census.since} 章起没核全，不能据此说哪样不在里面`;
    return `第 ${census.chapter} 章清点「${listed}」和别处记的对不上，不能据此说哪样不在里面`;
  }
  if (item.inside.length > 0) return `已知里面有${item.inside.map(texts.label).join("、")}（可能还有别的）`;
  return undefined;
}

/** 之后东西账没记全那句：整章没记全，还是只有说它的那条没记上。 */
export function unverifiedText(item: ItemView): string | undefined {
  if (item.unverifiedSince === undefined) return undefined;
  return item.unverifiedBy === "entry"
    ? `第 ${item.unverifiedSince} 章有一条说它的账没记上，从那章起在哪不一定`
    : `第 ${item.unverifiedSince} 章起东西账没记全，之后挪没挪不知道`;
}

/** 最近一条单列的说法（人物说的、回忆里、梦里的），比最后一次有权的去向还晚才列；它不改现在。 */
export function asideText(item: ItemView, texts: ItemTexts): string | undefined {
  const last: ItemStep | undefined = item.asides.at(-1);
  if (!last || (!last.to && last.op !== "gone")) return undefined;
  // 有权的去向在它之后（后面的章，或同一章故事里更晚）：它已经过时了，不列。
  const latest = item.history.at(-1);
  if (latest && (latest.chapter > last.chapter || (latest.chapter === last.chapter && latest.seq !== undefined && last.seq !== undefined && latest.seq > last.seq))) return undefined;
  const where = last.op === "gone"
    ? `${last.gone === "destroyed" ? "毁了" : "丢了"}${last.note ? `（${last.note}）` : ""}`
    : !last.to || last.to.kind === "unknown" ? "不知道在哪" : placeText(last.to, texts);
  const who = last.scope.source === "character_claim" ? `${last.scope.speaker ?? "有人"}说${where}` : last.scope.frame === "past" ? `回忆里${where}` : `梦、想象或传闻里${where}`;
  return `${who}（第 ${last.chapter} 章，没核实）`;
}

/** 一样东西的一行（不含编号）：名字 · 现在 · 里面 · 没核全 · 单列的说法。 */
export function itemLine(item: ItemView, texts: ItemTexts): string {
  const now = nowText(item.now, texts);
  const parts = [
    `${texts.label(item.id)}${item.mentions.length > 1 ? `（又叫：${item.mentions.filter((mention) => mention !== item.name).join("、")}）` : ""}`,
    now ? `现在：${now}` : "正文还没写过它在哪",
    contentsText(item, texts),
    unverifiedText(item),
    asideText(item, texts),
  ];
  return parts.filter((part): part is string => part !== undefined).join(" · ");
}

/** 主体是东西、现在有效的特征事实（不会变、会变的格子），按东西归。 */
export function itemFacts(projection: Pick<BookProjection, "facts">): ReadonlyMap<string, readonly FactView[]> {
  const out = new Map<string, FactView[]>();
  for (const fact of projection.facts) {
    if (fact.item === undefined || fact.status !== "current" || (fact.nature !== "hard" && fact.nature !== "state")) continue;
    out.set(fact.item, [...(out.get(fact.item) ?? []), fact]);
  }
  return out;
}

/** 旧记法里一句说了好几样、其中有几样已按新记法对上的事实：哪几样以「东西在哪」为准。 */
export function unalignedText(fact: FactView, texts: ItemTexts): string {
  return `「${fact.text}」（第 ${fact.chapter} 章，旧记法）——其中${(fact.unaligned ?? []).map(texts.label).join("、")}的去向以「东西在哪」为准`;
}

/** 现在那条记录的原句（作者定的、清点推出来的没有）。 */
export function nowQuote(item: ItemView): string | undefined {
  const now = item.now;
  if (!now || now.kind === "uncertain") return undefined;
  return item.history.find((step) => step.entry === now.entry && step.chapter === now.chapter)?.quote;
}

/** 写手、章纲员看的一行：名字 · 现在（哪章）· 里面 · 没核全 · 单列的说法 · 现在那句原句。 */
export function writerItemLine(item: ItemView, texts: ItemTexts): string {
  const quote = nowQuote(item);
  return `${itemLine(item, texts)}${quote ? ` · 原句「${quote}」` : ""}`;
}

export interface PickItemsOptions {
  /** 本章要写、要记的字（本章正文，或方向、章纲、上一章原文）：东西的叫法在里面出现就算相关。 */
  readonly texts: readonly string[];
  /** 本章出场的人：拿着东西的人在里面也算相关。 */
  readonly people?: readonly string[];
  /** 最近几章动过的也算相关。 */
  readonly recentChapters: number;
  /** 全书不超过这么多样就全列（记账员要认全）；不给 = 只列相关的。 */
  readonly listAllUpTo?: number;
  /**
   * 最多列几样：相关的里先留叫法写到的，再留拿着它的人出场的，再留最近动过的（装着它们的、同名的排最后）；
   * 相关的不够这么多，拿不相关的补满（最后一次写到它在哪越晚越先），久没动的东西别从读的人眼里消失。
   */
  readonly max?: number;
}

/**
 * 本章相关的东西（记账员、写手、章纲员同一套挑法，P3b 设计 3.1 / 第 4 节）：叫法在本章的字里出现、拿着它的人出场、最近几章动过；
 * 再带上装着它们的（往外找到头）和同名的整组（同名不一定是同一样，要一起看）。
 */
export function pickItems(projection: Pick<BookProjection, "items" | "cast" | "upTo">, options: PickItemsOptions): { picked: ItemView[]; omitted: number } {
  // 悬空的（账里没有存在证明，设计 3.3）不当它在：读的人、记账员都不列。
  const all = projection.items.filter((item) => !item.dangling);
  if (options.listAllUpTo !== undefined && all.length <= options.listAllUpTo) return { picked: [...all], omitted: 0 };
  // 不猜白名单：找原句（叫法在本章字里原样出现）
  const text = normalizeForQuote(options.texts.join("\n"));
  const appears = (name: string): boolean => {
    const key = normalizeForQuote(name);
    return key.length > 0 && text.includes(key);
  };
  const people = new Set((options.people ?? []).map(nameKey));
  const castNames = new Map(projection.cast.map((member) => [member.key, [member.name, ...member.aliases]] as const));
  const recentFrom = projection.upTo - options.recentChapters + 1;
  const byId = new Map(all.map((item) => [item.id, item] as const));
  const rank = new Map<string, number>();
  for (const item of all) {
    const holder = item.now?.kind === "known" && item.now.place.kind === "person" ? item.now.place : undefined;
    const held = holder !== undefined && (people.has(holder.key) || (castNames.get(holder.key) ?? [holder.name]).some(appears));
    const recent = (item.history.at(-1)?.chapter ?? 0) >= recentFrom;
    const score = item.mentions.some(appears) ? 3 : held ? 2 : recent ? 1 : 0;
    if (score > 0) rank.set(item.id, score);
  }
  for (const id of [...rank.keys()]) {
    const seen = new Set<string>();
    for (let at = byId.get(id)?.now; at?.kind === "known" && at.place.kind === "inside" && !seen.has(at.place.item); at = byId.get(at.place.item)?.now) {
      seen.add(at.place.item);
      if (!rank.has(at.place.item)) rank.set(at.place.item, 0);
    }
  }
  const names = new Set([...rank.keys()].flatMap((id) => (byId.get(id)?.name ? [byId.get(id)?.name as string] : [])));
  for (const item of all) if (item.name && names.has(item.name) && !rank.has(item.id)) rank.set(item.id, 0);
  let kept = all.filter((item) => rank.has(item.id));
  const order = new Map(all.map((item, index) => [item.id, index] as const));
  if (options.max !== undefined && kept.length > options.max) {
    const top = new Set([...kept].sort((a, b) => (rank.get(b.id) ?? 0) - (rank.get(a.id) ?? 0) || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)).slice(0, options.max).map((item) => item.id));
    kept = kept.filter((item) => top.has(item.id));
  } else if (options.max !== undefined && kept.length < options.max) {
    const lastWrite = (item: ItemView): number => item.history.at(-1)?.chapter ?? item.firstSeen?.chapter ?? 0;
    const rest = all.filter((item) => !rank.has(item.id)).sort((a, b) => lastWrite(b) - lastWrite(a) || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    const fill = new Set(rest.slice(0, options.max - kept.length).map((item) => item.id));
    kept = all.filter((item) => rank.has(item.id) || fill.has(item.id));
  }
  return { picked: kept, omitted: all.length - kept.length };
}

/** 写手、章纲员的「东西在哪」：本章相关的每样一行，加上旧记法里没逐样对齐、又说到这几样的事实。 */
export interface ItemsWhere {
  readonly lines: readonly string[];
  readonly legacyFacts: readonly string[];
  readonly omitted: number;
}

/** 写手最多看几样东西、几条没对齐的旧事实。 */
export const WRITER_MAX_ITEMS = 20;
const WRITER_MAX_LEGACY_FACTS = 8;
const WRITER_RECENT_CHAPTERS = 3;

export function itemsWhere(projection: Pick<BookProjection, "items" | "cast" | "upTo" | "facts">, texts: readonly string[], people: readonly string[]): ItemsWhere {
  const { picked, omitted } = pickItems(projection, { texts, people, recentChapters: WRITER_RECENT_CHAPTERS, max: WRITER_MAX_ITEMS });
  const names = itemTexts(projection.items);
  const ids = new Set(picked.map((item) => item.id));
  const legacyFacts = projection.facts
    .filter((fact) => fact.status === "current" && (fact.unaligned ?? []).some((item) => ids.has(item)))
    .slice(-WRITER_MAX_LEGACY_FACTS)
    .map((fact) => unalignedText(fact, names));
  return { lines: picked.map((item) => writerItemLine(item, names)), legacyFacts, omitted };
}

function stepPlaceText(place: ItemStep["to"], texts: ItemTexts): string {
  if (!place) return "在哪没写";
  return place.kind === "unknown" ? "不知道在哪了" : placeText(place, texts);
}

/** 一条记录一句：「沈知秋拿着 → 在铁盒里」「丢了（落进河里）」「清点：只有借据、银票」「头回写到」。 */
export function stepText(step: ItemStep, texts: ItemTexts): string {
  switch (step.op) {
    case "appear":
      return "头回写到";
    case "at":
      return stepPlaceText(step.to, texts);
    case "move":
      return `${step.from ? placeText(step.from, texts) : "原处没写"} → ${stepPlaceText(step.to, texts)}`;
    case "gone":
      return `${step.gone === "destroyed" ? "毁了" : "丢了"}${step.note ? `（${step.note}）` : ""}`;
    case "census": {
      const members = (step.members ?? []).map(texts.label);
      return step.complete ? `清点：${members.length > 0 ? `只有${members.join("、")}` : "空了"}` : `里面有${members.join("、")}`;
    }
  }
}

/** 单列的说法（人物说的、回忆里、梦里）前面那几个字。 */
export function asideScopeText(step: ItemStep): string | undefined {
  if (step.scope.source === "character_claim") return `${step.scope.speaker ?? "人物"}说的`;
  if (step.scope.frame === "past") return "回忆里";
  if (step.scope.frame === "other") return "梦里";
  if (step.scope.frame === "unknown") return "段对不上";
  return undefined;
}

export interface ItemMoveLine {
  readonly name: string;
  readonly text: string;
  readonly chapter: number;
  readonly quote?: string;
  /** 不改现在的说法（人物说的、回忆里、梦里）。 */
  readonly scope?: string;
}

const samePlace = (a: ItemStep["to"], b: ItemStep["to"]): boolean => {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === "person" && b.kind === "person") return a.key === b.key;
  if (a.kind === "place" && b.kind === "place") return a.text === b.text;
  if (a.kind === "inside" && b.kind === "inside") return a.item === b.item;
  return a.kind === "unknown";
};

/** 真改了去向的记录：头回写到的、只是再说一遍还在原处的（清点里列到它、又写它在那儿）不算。 */
function changingSteps(history: readonly ItemStep[]): ItemStep[] {
  let last: ItemStep["to"];
  return history.filter((step) => {
    if (step.op === "appear") return false;
    const repeat = step.op === "at" && samePlace(step.to, last);
    if (step.to) last = step.to;
    else if (step.op === "gone") last = undefined;
    return !repeat;
  });
}

/** 这一章东西对不上的地方（投影报的，都是「可能」），给作者看的一句话；定稿清单列它。 */
export function itemIssueTexts(projection: Pick<BookProjection, "items" | "itemIssues">, chapter: number): string[] {
  const nameOf = (id: string) => `「${projection.items.find((item) => item.id === id)?.name ?? "一样东西"}」`;
  const censusOwner = (entry: string | undefined) => projection.items.find((item) => item.history.some((step) => step.entry === entry && step.op === "census"));
  const text = (issue: ItemIssueView): string => {
    const name = nameOf(issue.item);
    switch (issue.kind) {
      case "from":
        return `${name}这章写的从哪拿出来，和前文记的它在哪对不上，记成拿不准`;
      case "census":
        return `${name}这章的清点说只有这几样，可前文记着里面还有别的`;
      case "not-in-census": {
        const owner = censusOwner(issue.entries[0]);
        return `${name}不在${owner ? `「${owner.name ?? "那样东西"}」` : "装它的东西"}上回的完整清点里，这章却写它在里面：那次清点不再当完整`;
      }
      case "destroyed":
        return `${name}前文已经毁了，这章又写到它在哪，记成拿不准`;
      case "cycle":
        return `${name}装在自己里面绕成了圈`;
      case "order":
        return `${name}这章几处去向分不出先后，记成拿不准`;
      case "dangling":
        return `${name}这章用到的一样东西账里没了：含它的清点不再当完整、装进它里面的去向记成不知道`;
    }
  };
  return projection.itemIssues.filter((issue) => issue.chapter === chapter).map(text);
}

/** 某章东西挪了什么（「这章改了什么」）：有权的和单列的都列；头回写到、只是再说一遍还在原处的不列。 */
export function chapterItemMoves(projection: Pick<BookProjection, "items">, chapter: number): ItemMoveLine[] {
  const texts = itemTexts(projection.items);
  return projection.items.flatMap((item) => [...changingSteps(item.history), ...item.asides]
    .filter((step) => step.chapter === chapter && step.op !== "appear")
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
    .map((step): ItemMoveLine => {
      const scope = asideScopeText(step);
      return { name: texts.label(item.id), text: stepText(step, texts), chapter, ...(step.quote ? { quote: step.quote } : {}), ...(scope ? { scope } : {}) };
    }));
}

/** 写前备忘「东西挪了」最多几样、看最近几章。 */
const MEMO_ITEM_LIMIT = 6;
const MEMO_RECENT_CHAPTERS = 3;

/** 写前备忘：最近几章挪过的东西，每样只列最后一笔（新的先）。投影要算到上一章。 */
export function recentItemMoves(projection: Pick<BookProjection, "items" | "upTo">): ItemMoveLine[] {
  const texts = itemTexts(projection.items);
  const from = projection.upTo - MEMO_RECENT_CHAPTERS + 1;
  return projection.items
    .flatMap((item) => {
      const last = changingSteps(item.history).at(-1);
      if (!last || last.chapter < from) return [];
      return [{ name: texts.label(item.id), text: stepText(last, texts), chapter: last.chapter, ...(last.quote ? { quote: last.quote } : {}) }];
    })
    .sort((a, b) => b.chapter - a.chapter)
    .slice(0, MEMO_ITEM_LIMIT);
}

/** 设定本里一样东西的去向（给界面的字，编号都换成名字）。 */
export interface ItemTextView {
  readonly name: string;
  readonly now?: string;
  readonly contents?: string;
  readonly unverified?: string;
  /** 去向小时间线：头回写到、每次挪、清点、单列的说法（标谁说的 / 回忆里 / 梦里），按章、先后排。 */
  readonly steps: readonly { readonly chapter: number; readonly text: string; readonly quote?: string; readonly scope?: string }[];
}

export function itemTextViews(projection: Pick<BookProjection, "items">): Record<string, ItemTextView> {
  const texts = itemTexts(projection.items);
  const out: Record<string, ItemTextView> = {};
  for (const item of projection.items) {
    const steps = [...item.history.filter((step) => step.op === "appear"), ...changingSteps(item.history), ...item.asides]
      .sort((a, b) => a.chapter - b.chapter || (a.op === "appear" ? -1 : b.op === "appear" ? 1 : (a.seq ?? 0) - (b.seq ?? 0)))
      .map((step) => {
        const scope = asideScopeText(step);
        return { chapter: step.chapter, text: stepText(step, texts), ...(step.quote ? { quote: step.quote } : {}), ...(scope ? { scope } : {}) };
      });
    const now = nowText(item.now, texts);
    const contents = contentsText(item, texts);
    const unverified = unverifiedText(item);
    out[item.id] = { name: texts.label(item.id), ...(now ? { now } : {}), ...(contents ? { contents } : {}), ...(unverified ? { unverified } : {}), steps };
  }
  return out;
}
