/**
 * 东西现在在哪（写作版本 P3b，设计 docs/rebuild/写作版本-P3b-设计.md 2.5、2.7）。纯函数：从账单里的东西条目、设定卡、作者裁定现算。
 *
 * 规则全是结构上的，不读正文、不按名字认东西：
 *  - 一样东西一个编号。作者的归并（item.merge）让账里所有位置指 from 的都算 into；拆开（item.split）把点名的那几处换成新编号。
 *  - 只有当下线上叙述的（和作者定的）去向改「现在」（来源 × 段限权，scope.ts）；人物说的、回忆、梦里的进单列。
 *  - 一章里按 seq（故事里发生的先后）一组一组走。同一组里同一样东西有几处去向（条目自己的、清点给成员的「在里面」）：
 *    结果都一样照走一次；结果不一样 = 正文没说清先后 → 「拿不准」，几种都列，后面的组的明确去向照样解开它；到章末还没解开才报。
 *    代码不拿句子先后、数组先后判断事情先后（倒叙、插叙里先写的可以后发生）。
 *  - 挪动写了从哪来、和前一刻已知的去处接不上（中间东西账都记全了）→ 拿不准 + 一条「去处接不上」。地方是原样的字、不发编号，
 *    地方和地方不比（字不一样不等于不是一处）；人按别名表比，东西里面按编号比，种类不同就是接不上。
 *  - 清点里的成员此刻在这样东西里面（按这条清点的权限，不补造挪动）。完整清点是带章、条、来源的断言，和「已知在里面的」分开存：
 *    之后记全了的挪进挪出照算；这一章或之后有一章东西账没记全、有成员去向说不确定（不知道、丢了、拿不准）、和它有关的条目
 *    同号先后不清、作者把东西放进去，就成了「此后没核全」，不能据它说哪样不在里面。清点时已知在里面（最后一次写它之后都记全了）、
 *    清点里却没有的，之后从里面拿出了清点里没有的，或只是看到清点里没有的在里面（没记挪进来）→ 「对不上」。
 *    隔着没核全的章、上回所知在里面的，新的完整清点里没有它：它改成「不知道在哪了」（这条清点为证），不反过来否决新清点。
 *    作者在某章末给的清点取代此前所有清点的完整效力（没列全的就是到那章末没有有效的完整清点）。
 *  - 投影自己能确定的矛盾只报「可能」，作者点「不是问题」只压告警、不改状态。
 */
import type { SettingCardsFile } from "../schema/cards.js";
import type { AuthorDecision, ItemPosition, ItemStateRuling } from "../schema/decisions.js";
import {
  entryQuote,
  itemGapOf,
  itemRefsOf,
  type ChapterLedger,
  type ItemEntry,
  type ItemGone,
  type ItemPlace,
  type ItemRef,
} from "../schema/ledger.js";
import type { Names } from "./names.js";
import { rightsOf, scopeOf, type EntryScope } from "./scope.js";
import type { DanglingView, StatementScope } from "./types.js";

export type ItemPlaceView =
  | { readonly kind: "person"; readonly name: string; readonly key: string }
  | { readonly kind: "place"; readonly text: string }
  | { readonly kind: "inside"; readonly item: string };

/** 一种确定的「现在」：在哪 / 丢了、毁了 / 正文明说不知道在哪了。entry = 哪条（作者定的是裁定号）。 */
export type ItemSettled =
  | { readonly kind: "known"; readonly place: ItemPlaceView; readonly chapter: number; readonly entry: string }
  | { readonly kind: "gone"; readonly gone: ItemGone; readonly note?: string; readonly chapter: number; readonly entry: string }
  | { readonly kind: "unknown"; readonly chapter: number; readonly entry: string };

/** 拿不准为什么：order = 这章先后定不了；from = 去处和前文接不上；destroyed = 毁了之后又写它在哪。 */
export type ItemUncertainReason = "order" | "from" | "destroyed";
export type ItemNow = ItemSettled | { readonly kind: "uncertain"; readonly reason: ItemUncertainReason; readonly options: readonly ItemSettled[]; readonly chapter: number };

/** 一条东西记录（历史、单列的说法都是它）。 */
export interface ItemStep {
  readonly chapter: number;
  /** 账单条目号；作者定的是裁定号。 */
  readonly entry: string;
  readonly op: ItemEntry["op"];
  readonly seq?: number;
  readonly to?: ItemPlaceView | { readonly kind: "unknown" };
  readonly from?: ItemPlaceView;
  readonly gone?: ItemGone;
  readonly note?: string;
  readonly members?: readonly string[];
  readonly complete?: boolean;
  readonly quote?: string;
  readonly scope: StatementScope;
}

/**
 * 一次完整清点现在还算不算数：valid = 之后挪进挪出都记全了，members 是照算后的；unverified = 之后有没核全的（since 那章起），
 * 不能据它说哪样不在里面；conflict = 清点时已知在里面的它没列，两边证据都留。
 */
export interface CensusView {
  readonly chapter: number;
  readonly entry: string;
  /** 那次清点列的（清点时的断言，原样留着）。 */
  readonly listed: readonly string[];
  /** 按之后记全了的挪进挪出算下来的；只有清点有效时才是「现在里面的」。 */
  readonly members: readonly string[];
  readonly status: "valid" | "unverified" | "conflict";
  readonly since?: number;
}

export interface ItemView {
  readonly id: string;
  /** 设定卡上的名字，不然头一回写到时的叫法；都没有就没有（外层用中性说法）。 */
  readonly name?: string;
  /** 设定卡上的东西。 */
  readonly card?: true;
  /** 正文里的各种叫法（原样，先后排）。 */
  readonly mentions: readonly string[];
  /** 作者并进来的编号。 */
  readonly mergedFrom: readonly string[];
  /** 头一回写到（没有 appear 就是最早用到它的那条）。设定卡上、账里还没写到的没有。 */
  readonly firstSeen?: { readonly chapter: number; readonly entry: string; readonly quote?: string };
  readonly now?: ItemNow;
  /** 最后一次写它在哪之后，第一个东西账没记全（账待记、没记全、旧记法）的章：读的人照「之后没核全，挪没挪不知道」说。 */
  readonly unverifiedSince?: number;
  /** 那一章是整章东西账没记全（chapter），还是只有说它的条目没记上（entry）。 */
  readonly unverifiedBy?: "chapter" | "entry";
  readonly history: readonly ItemStep[];
  /** 人物说的、回忆里的、梦里的、定不了在段里段外的去向（不改现在）。 */
  readonly asides: readonly ItemStep[];
  /** 现在已知在它里面的（编号）。 */
  readonly inside: readonly string[];
  /** 最近一次完整清点。 */
  readonly census?: CensusView;
  /** 账里只在别的条目里用到它、没有一条证明它存在（出处被撤、重记没认上）。 */
  readonly dangling?: true;
}

/** dangling = 用到了账里没有存在证明的东西（重定稿没认上）：含它的清点不再当完整、装进它里面的去向记成不知道。 */
export type ItemIssueKind = "from" | "census" | "not-in-census" | "destroyed" | "cycle" | "order" | "dangling";

/** 投影能确定的东西矛盾（都只是「可能」）。entries = 两边的条目号（作者定的是裁定号）。 */
export interface ItemIssueView {
  readonly key: string;
  readonly kind: ItemIssueKind;
  readonly item: string;
  readonly chapter: number;
  readonly entries: readonly string[];
}

export interface ItemProjection {
  readonly items: readonly ItemView[];
  readonly issues: readonly ItemIssueView[];
  readonly dangling: readonly DanglingView[];
  /** 账里的东西编号 → 投影里的编号（归并、拆开之后）。事实、清单都照它认。 */
  readonly resolve: (raw: string, position?: Omit<ItemPosition, "index"> & { readonly index?: number }) => string;
  /** 这一处的旧记法关联不生效（悬空的成员、装进悬空东西里的那条、指着悬空东西的作者裁定）：条目或裁定号 + 位置。 */
  readonly voided: (entry: string, at: string, index?: number) => boolean;
}

/** 编号解析：先看这一处有没有被拆开，再沿归并走到底（防环）。 */
export function itemResolver(decisions: readonly AuthorDecision[]): ItemProjection["resolve"] {
  const merged = new Map<string, string>();
  const split = new Map<string, string>();
  for (const decision of decisions) {
    if (decision.type === "item.merge") for (const from of decision.from) if (from !== decision.into) merged.set(from, decision.into);
    if (decision.type === "item.split") for (const ref of decision.refs) split.set(positionKey(ref), splitItemId(decision.id));
  }
  return (raw, position) => {
    let id = (position ? split.get(positionKey(position)) : undefined) ?? raw;
    const seen = new Set([id]);
    for (let next = merged.get(id); next !== undefined && !seen.has(next); next = merged.get(id)) {
      seen.add(next);
      id = next;
    }
    return id;
  };
}

/** 作者拆出来的那样东西的编号（自家格式）。 */
export const splitItemId = (decision: string): string => `x-${decision}`;
const positionKey = (position: { readonly entry: string; readonly at: string; readonly index?: number }): string => `${position.entry}|${position.at}|${position.index ?? ""}`;


const AUTHOR: EntryScope = { frame: "present", source: "author_ruling", rights: rightsOf("author_ruling", "present") };
const statementOf = (scope: EntryScope): StatementScope => ({ frame: scope.frame, source: scope.source, ...(scope.speaker ? { speaker: scope.speaker } : {}) });

interface MutableItem {
  id: string;
  name?: string;
  card?: true;
  mentions: string[];
  mergedFrom: Set<string>;
  firstSeen?: { chapter: number; entry: string; quote?: string };
  now?: ItemNow;
  lastWrite: number;
  unverifiedSince?: number;
  unverifiedBy?: "chapter" | "entry";
  history: ItemStep[];
  asides: ItemStep[];
  census?: { chapter: number; entry: string; listed: string[]; members: Set<string>; status: CensusView["status"]; since?: number };
}

/** 一条要走的去向：账单条目或作者定的。 */
interface Move {
  readonly chapter: number;
  readonly entry: string;
  readonly op: Exclude<ItemEntry["op"], "appear">;
  readonly seq: number;
  readonly item: string;
  readonly to?: ItemPlaceView | { readonly kind: "unknown" };
  readonly from?: ItemPlaceView;
  readonly gone?: ItemGone;
  readonly note?: string;
  readonly members?: readonly string[];
  readonly complete?: boolean;
  readonly quote?: string;
  readonly scope: EntryScope;
}

export function projectItems(
  ledgers: readonly ChapterLedger[],
  decisions: readonly AuthorDecision[],
  names: Names,
  cards: SettingCardsFile | undefined,
  dismissed: ReadonlySet<string>,
): ItemProjection {
  const resolve = itemResolver(decisions);
  const retracted = new Set(decisions.flatMap((decision) => (decision.type === "item.retract" ? [decision.entry] : [])));
  const items = new Map<string, MutableItem>();
  const issues: ItemIssueView[] = [];
  const dangling: DanglingView[] = [];
  const issue = (kind: ItemIssueKind, item: string, chapter: number, entries: readonly string[]): void => {
    const key = `item-${kind}:${chapter}:${entries.join(":")}`;
    if (dismissed.has(key) || issues.some((existing) => existing.key === key)) return;
    issues.push({ key, kind, item, chapter, entries });
  };
  const touch = (id: string): MutableItem => {
    let item = items.get(id);
    if (!item) {
      item = { id, mentions: [], mergedFrom: new Set(), lastWrite: 0, history: [], asides: [] };
      items.set(id, item);
    }
    return item;
  };
  const mention = (item: MutableItem, text: string | undefined): void => {
    if (text && !item.mentions.includes(text)) item.mentions.push(text);
  };
  /**
   * 证明它存在的（设计 2.8）：账里以它为主体的东西条目、以它为主体的事实、设定卡、拆出它的裁定。
   * 只在别的条目里用到（清点成员、装在它里面、裁定指着它）的不算——那几处用不上它（设计 3.3）。
   */
  const proven = new Set<string>();
  for (const card of cards?.cards ?? []) if (card.kind === "item") proven.add(resolve(card.id));
  for (const decision of decisions) if (decision.type === "item.split") proven.add(splitItemId(decision.id));
  for (const ledger of ledgers) {
    for (const entry of ledger.entries) {
      if (entry.kind === "item" && !retracted.has(entry.id)) proven.add(resolve(entry.itemRef.id, { entry: entry.id, at: "item" }));
      if (entry.kind === "fact" && entry.subjectRef?.id) proven.add(resolve(entry.subjectRef.id, { entry: entry.id, at: "subject" }));
    }
  }
  const voided = new Set<string>();
  const voidLink = (entry: string, at: string, index?: number): void => {
    voided.add(positionKey({ entry, at, ...(index !== undefined ? { index } : {}) }));
  };

  for (const card of cards?.cards ?? []) {
    if (card.kind !== "item") continue;
    const item = touch(resolve(card.id));
    item.card = true;
    item.name ??= card.name;
    mention(item, card.name);
    for (const alias of card.aliases) mention(item, alias);
  }
  for (const decision of decisions) {
    if (decision.type === "item.merge") for (const from of decision.from) if (resolve(from) !== from) touch(resolve(from)).mergedFrom.add(from);
    if (decision.type === "item.split") {
      const item = touch(splitItemId(decision.id));
      item.name ??= decision.name;
    }
  }

  const placeView = (place: ItemPlace, entry: string, at: "to" | "from"): ItemPlaceView | { readonly kind: "unknown" } => {
    switch (place.kind) {
      case "person": {
        const person = names.resolve(place.ref.mention);
        return { kind: "person", name: person.name, key: person.key };
      }
      case "place":
        return { kind: "place", text: place.text };
      case "inside":
        return { kind: "inside", item: resolve(place.ref.id, { entry, at }) };
      case "unknown":
        return { kind: "unknown" };
    }
  };
  const authorStates = new Map<number, (AuthorDecision & { type: "item.state" })[]>();
  const chapters = new Set(ledgers.map((ledger) => ledger.chapter));
  for (const decision of decisions) {
    if (decision.type !== "item.state") continue;
    if (!chapters.has(decision.chapter)) {
      dangling.push({ kind: "decision", ref: `chapter:${decision.chapter}`, chapter: decision.chapter, source: decision.id });
      continue;
    }
    // 指着账里没有存在证明的东西：这条裁定不生效（它关联的旧事实也不动）。
    const refs = [decision.item, ...(decision.state.kind === "census" ? decision.state.members.map((member) => member.id) : decision.state.kind === "at" && decision.state.to.kind === "inside" ? [decision.state.to.ref.id] : [])];
    const lost = refs.find((id) => !proven.has(resolve(id)));
    if (lost !== undefined) {
      dangling.push({ kind: "item", ref: resolve(lost), chapter: decision.chapter, source: decision.id });
      issue("dangling", resolve(decision.item), decision.chapter, [decision.id]);
      voidLink(decision.id, "item");
      if (decision.state.kind === "census") decision.state.members.forEach((_, index) => voidLink(decision.id, "member", index));
      continue;
    }
    authorStates.set(decision.chapter, [...(authorStates.get(decision.chapter) ?? []), decision]);
  }

  /** 现在在不在 container 里面。 */
  const insideOf = (now: ItemNow | undefined): string | undefined => (now?.kind === "known" && now.place.kind === "inside" ? now.place.item : undefined);
  const samePlace = (a: ItemPlaceView, b: ItemPlaceView): boolean | undefined => {
    if (a.kind !== b.kind) return false;
    if (a.kind === "person" && b.kind === "person") return a.key === b.key;
    if (a.kind === "inside" && b.kind === "inside") return a.item === b.item;
    // 地方是原样的字、不发编号：比不了（字不一样不等于不是一处）。
    return undefined;
  };
  /** 从哪来和前一刻接不接得上（false = 接不上）。前一刻搁在某处、从哪来写的是人：当那人从那儿拿起来的（拿起常不单写一句）。 */
  const fromConnects = (previous: ItemPlaceView, from: ItemPlaceView): boolean | undefined =>
    from.kind === "person" && previous.kind !== "person" ? true : samePlace(previous, from);
  const markUnverified = (item: MutableItem, chapter: number, by: "chapter" | "entry"): void => {
    item.unverifiedSince = chapter;
    item.unverifiedBy = by;
  };
  const unverify = (container: MutableItem | undefined, chapter: number): void => {
    if (container?.census && container.census.status === "valid") {
      container.census.status = "unverified";
      container.census.since = chapter;
    }
  };
  /**
   * 一样东西换了「现在」：跟着改它前后所在的容器的清点（挪进加上、挪出去掉）。挪出去以后去向说不确定
   * （不知道、丢了、拿不准）：可能还在里面，那份清点不再当完整用。
   */
  const setNow = (item: MutableItem, now: ItemNow, chapter: number): void => {
    const before = insideOf(item.now);
    const after = insideOf(now);
    item.now = now;
    item.lastWrite = chapter;
    delete item.unverifiedSince;
    delete item.unverifiedBy;
    // 容器毁了：里面的还在不在说不准，它的清点不再当完整用。
    if (now.kind === "gone" && now.gone === "destroyed") unverify(item, chapter);
    if (before === after) return;
    if (before !== undefined) {
      const container = items.get(before);
      container?.census?.members.delete(item.id);
      const settledElsewhere = now.kind === "known" || (now.kind === "gone" && now.gone === "destroyed");
      if (!settledElsewhere) unverify(container, chapter);
    }
    if (after !== undefined) items.get(after)?.census?.members.add(item.id);
  };

  const settledOf = (move: Move): ItemSettled | undefined => {
    if (move.op === "gone" && move.gone) return { kind: "gone", gone: move.gone, ...(move.note ? { note: move.note } : {}), chapter: move.chapter, entry: move.entry };
    if (move.to?.kind === "unknown") return { kind: "unknown", chapter: move.chapter, entry: move.entry };
    if (move.to) return { kind: "known", place: move.to, chapter: move.chapter, entry: move.entry };
    return undefined;
  };
  /** 两种「现在」是不是同一个结果（同一组里谁先谁后都一样）。地方只认字一样的。 */
  const sameOutcome = (a: ItemSettled, b: ItemSettled): boolean => {
    if (a.kind === "known" && b.kind === "known") {
      if (a.place.kind === "place" && b.place.kind === "place") return a.place.text === b.place.text;
      return samePlace(a.place, b.place) === true;
    }
    if (a.kind === "gone" && b.kind === "gone") return a.gone === b.gone;
    return a.kind === "unknown" && b.kind === "unknown";
  };

  /** 又写到它在哪（没换地方）：算核过了。 */
  const reaffirm = (item: MutableItem, chapter: number): void => {
    item.lastWrite = chapter;
    delete item.unverifiedSince;
    delete item.unverifiedBy;
  };

  /** 这一组里刚立的清点：同组的去向先后不清，不拿它判对不上（组走完不再当完整用）。 */
  let freshCensus = new Set<string>();
  const checkable = (container: MutableItem | undefined): container is MutableItem & { census: NonNullable<MutableItem["census"]> } =>
    container?.census?.status === "valid" && !freshCensus.has(container.census.entry);

  /**
   * 只是看到它在 container 里面（at、清点给成员的「在里面」，没记挪进来）：有效完整清点里没有它 → 被反证，对不上；
   * 作者放进去的 → 清点此后没核全（作者定了现状，不替清点补完整）。
   */
  const observeInside = (item: MutableItem, container: MutableItem, move: Move): void => {
    if (insideOf(item.now) === container.id || !checkable(container) || container.census.members.has(item.id)) return;
    if (move.scope.source === "author_ruling") return unverify(container, move.chapter);
    issue("not-in-census", item.id, move.chapter, [container.census.entry, move.entry]);
    container.census.status = "conflict";
    delete container.census.since;
  };

  /** 一处「它到这儿了」：条目自己的去向，或清点给成员的「在里面」。 */
  interface Placement { readonly item: string; readonly settled: ItemSettled; readonly move: Move; readonly member: boolean }
  const placementsOf = (move: Move): Placement[] => {
    if (move.op === "census") {
      return (move.members ?? []).filter((id) => proven.has(id)).map((id) => ({ item: id, settled: { kind: "known", place: { kind: "inside", item: move.item }, chapter: move.chapter, entry: move.entry }, move, member: true }));
    }
    const settled = settledOf(move);
    return settled ? [{ item: move.item, settled, move, member: false }] : [];
  };

  /**
   * 一样东西在这一组里的几处去向（结果都一样）走一次（设计 2.5）：每一处都核——毁了之后又写它在哪（清点给的「在里面」也算）、
   * 从哪来接不上、从里面拿出了清点里没有的——不看数组里谁在前；有一处写了挪进来的照算进清点，都只是写它此刻在里面的才核清点。
   * 证据取头一处条目自己的去向（只有清点给的才取清点那条）。
   */
  const settle = (id: string, list: readonly Placement[]): void => {
    const item = touch(id);
    const lead = list.find((placement) => !placement.member) ?? (list[0] as Placement);
    const { settled } = lead;
    const chapter = lead.move.chapter;
    const previous = item.now;
    if (previous?.kind === "gone" && previous.gone === "destroyed" && settled.kind !== "gone") {
      for (const placement of list) issue("destroyed", id, chapter, [previous.entry, placement.move.entry]);
      setNow(item, { kind: "uncertain", reason: "destroyed", options: [settled, previous], chapter }, chapter);
      return;
    }
    const own = list.filter((placement) => !placement.member).map((placement) => placement.move);
    // 中间东西账都记全了（最后一次写它之后没有没核全的章），从哪来接不上才算数。
    if (previous?.kind === "known" && item.unverifiedSince === undefined) {
      const unlinked = own.filter((move) => move.from !== undefined && fromConnects(previous.place, move.from) === false);
      if (unlinked.length > 0) {
        for (const move of unlinked) issue("from", id, chapter, [previous.entry, move.entry]);
        setNow(item, { kind: "uncertain", reason: "from", options: [settled, previous], chapter }, chapter);
        return;
      }
    }
    // 从里面拿出了有效完整清点里没有的：清点被反证，改记对不上（几处一起核完再改）。
    const entering = insideOf(settled.kind === "known" ? settled : undefined);
    const refuted = new Map<MutableItem, string[]>();
    for (const placement of list) {
      const leaving = !placement.member && placement.move.from?.kind === "inside" ? placement.move.from.item : insideOf(previous);
      const container = leaving !== undefined ? items.get(leaving) : undefined;
      if (checkable(container) && !container.census.members.has(id) && entering !== leaving) refuted.set(container, [...(refuted.get(container) ?? []), placement.move.entry]);
    }
    for (const [container, entries] of refuted) {
      for (const entry of entries) issue("not-in-census", id, chapter, [container.census?.entry ?? "", entry]);
      if (container.census) {
        container.census.status = "conflict";
        delete container.census.since;
      }
    }
    // 已经在里面、这组只是清点又列了它：算又核了一次。
    if (entering !== undefined && insideOf(previous) === entering && list.every((placement) => placement.member)) return reaffirm(item, chapter);
    // 挪进来（move）的照算进清点；都只是写它此刻在里面（at、清点给的、作者定的）才核。
    const movedIn = own.some((move) => move.op === "move" && move.scope.source !== "author_ruling");
    if (entering !== undefined && !movedIn) observeInside(item, touch(entering), lead.move);
    setNow(item, settled, chapter);
  };

  /**
   * 清点立起来（按这一组之前的样子核）：完整的，清点时已知在里面、最后一次写它之后都记全了、清点里没有、这一组也没动它 → 对不上；
   * 隔着没核全的章、上回所知在里面的 → 改成「不知道在哪了」（这条清点为证），不否决新清点。作者没列全的清点取消此前的完整效力。
   */
  const openCensus = (move: Move, touched: ReadonlySet<string>): void => {
    const container = touch(move.item);
    if (!move.complete) {
      if (move.scope.source === "author_ruling") delete container.census;
      return;
    }
    const listed = new Set(move.members ?? []);
    const extra = [...items.values()].filter((other) => insideOf(other.now) === container.id && !listed.has(other.id) && !touched.has(other.id));
    const fresh = extra.filter((other) => other.unverifiedSince === undefined);
    for (const stale of extra.filter((other) => other.unverifiedSince !== undefined)) {
      stale.history.push({ ...memberStep(move), to: { kind: "unknown" } });
      setNow(stale, { kind: "unknown", chapter: move.chapter, entry: move.entry }, move.chapter);
    }
    container.census = { chapter: move.chapter, entry: move.entry, listed: [...listed], members: new Set(listed), status: fresh.length > 0 ? "conflict" : "valid" };
    for (const other of fresh) issue("census", container.id, move.chapter, [move.entry, (other.now as ItemSettled).entry]);
  };

  /**
   * 走一组（同一个 seq，或作者在章末定的一批）：先立清点，再逐样走去向——一样东西几处去向结果都一样走一次，不一样就拿不准；
   * 同组里有清点、又有动它或它里面东西的：先后不清，这份清点不再当完整用。返回拿不准的（东西 → 那几条）。
   */
  const runGroup = (group: readonly Move[], chapter: number): Map<string, string[]> => {
    const placements = group.flatMap(placementsOf);
    const touched = new Set(placements.map((placement) => placement.item));
    const censuses = group.filter((move) => move.op === "census");
    freshCensus = new Set(censuses.map((move) => move.entry));
    for (const census of censuses) openCensus(census, touched);
    const byItem = new Map<string, Placement[]>();
    for (const placement of placements) byItem.set(placement.item, [...(byItem.get(placement.item) ?? []), placement]);
    const tied = new Map<string, string[]>();
    for (const [id, list] of byItem) {
      const first = list[0] as Placement;
      if (list.every((placement) => sameOutcome(placement.settled, first.settled))) {
        settle(id, list);
        continue;
      }
      setNow(touch(id), { kind: "uncertain", reason: "order", options: list.map((placement) => placement.settled), chapter }, chapter);
      tied.set(id, list.map((placement) => placement.move.entry));
    }
    for (const census of censuses) {
      // 它的另一条清点、挪进挪出它的、清单里的东西又挪了：先后不清。挪它自己不动里面有什么。
      const touches = group.some((move) => move !== census && ((move.op === "census" && move.item === census.item) || (move.to?.kind === "inside" && move.to.item === census.item) || (move.from?.kind === "inside" && move.from.item === census.item) || census.members?.includes(move.item)));
      if (touches) unverify(touch(census.item), chapter);
    }
    freshCensus = new Set();
    return tied;
  };

  /** 清点给成员记的那一笔：这条清点为证，「在它里面」。 */
  const memberStep = (move: Move): ItemStep => ({
    chapter: move.chapter,
    entry: move.entry,
    op: "at",
    seq: move.seq,
    to: { kind: "inside", item: move.item },
    ...(move.quote ? { quote: move.quote } : {}),
    scope: statementOf(move.scope),
  });
  const stepOf = (move: Move): ItemStep => ({
    chapter: move.chapter,
    entry: move.entry,
    op: move.op,
    seq: move.seq,
    ...(move.to ? { to: move.to } : {}),
    ...(move.from ? { from: move.from } : {}),
    ...(move.gone ? { gone: move.gone } : {}),
    ...(move.note ? { note: move.note } : {}),
    ...(move.members ? { members: move.members } : {}),
    ...(move.complete !== undefined ? { complete: move.complete } : {}),
    ...(move.quote ? { quote: move.quote } : {}),
    scope: statementOf(move.scope),
  });

  /**
   * 用到账里没有存在证明的东西（设计 3.3）：清点里有它 → 这次清点不再当完整（不排除别的，成员里不列它），
   * 装进它里面 → 去向记成不知道；从它里面拿出来 → 不核从哪来。那几处附带的旧记法关联不生效，记一条 dangling 问题。
   */
  const withoutDangling = (move: Move, members: readonly { readonly id: string; readonly index: number }[]): Move => {
    const lostMembers = members.filter((member) => !proven.has(member.id));
    const lostInside = move.to?.kind === "inside" && !proven.has(move.to.item);
    const lostFrom = move.from?.kind === "inside" && !proven.has(move.from.item);
    if (lostMembers.length === 0 && !lostInside && !lostFrom) return move;
    for (const member of lostMembers) voidLink(move.entry, "member", member.index);
    if (lostInside) voidLink(move.entry, "item");
    issue("dangling", move.item, move.chapter, [move.entry]);
    const { from, ...rest } = move;
    return {
      ...rest,
      ...(from && !lostFrom ? { from } : {}),
      ...(lostInside ? { to: { kind: "unknown" as const } } : {}),
      ...(lostMembers.length > 0 ? { members: (move.members ?? []).filter((id) => proven.has(id)), complete: false } : {}),
    };
  };

  for (const ledger of [...ledgers].sort((a, b) => a.chapter - b.chapter)) {
    const chapter = ledger.chapter;
    const moves: Move[] = [];
    for (const entry of ledger.entries) {
      // 以它为主体的事实也证明它在（设计 2.8）：只剩事实的，清单里照列，头一回写到的算那条。
      if (entry.kind === "fact" && entry.subjectRef?.id) {
        const target = touch(resolve(entry.subjectRef.id, { entry: entry.id, at: "subject" }));
        mention(target, entry.subjectRef.mention);
        const quote = entryQuote(entry);
        target.firstSeen ??= { chapter, entry: entry.id, ...(quote ? { quote } : {}) };
      }
      if (entry.kind !== "item" || retracted.has(entry.id)) continue;
      const quote = entryQuote(entry);
      const seen = { chapter, entry: entry.id, ...(quote ? { quote } : {}) };
      for (const { at, index, ref } of itemRefsOf(entry)) {
        const target = touch(resolve(ref.id, { entry: entry.id, at, ...(index !== undefined ? { index } : {}) }));
        mention(target, ref.mention);
        if (at !== "item") {
          target.firstSeen ??= seen;
          continue;
        }
        if (entry.op === "appear") {
          // 头回写到那条优先（同一章里先被别的条目用到也算这条）；名字取它。
          if (!target.firstSeen || target.firstSeen.chapter === chapter) target.firstSeen = seen;
          target.name ??= ref.mention;
        } else {
          target.firstSeen ??= seen;
        }
      }
      if (entry.op === "appear" || entry.seq === undefined) continue;
      const move: Move = {
        chapter,
        entry: entry.id,
        op: entry.op,
        seq: entry.seq,
        item: resolve(entry.itemRef.id, { entry: entry.id, at: "item" }),
        ...(entry.to ? { to: placeView(entry.to, entry.id, "to") } : {}),
        ...(entry.from && entry.from.kind !== "unknown" ? { from: placeView(entry.from, entry.id, "from") as ItemPlaceView } : {}),
        ...(entry.gone ? { gone: entry.gone } : {}),
        ...(entry.note ? { note: entry.note } : {}),
        ...(entry.members ? { members: entry.members.map((member, index) => resolve(member.id, { entry: entry.id, at: "member", index })) } : {}),
        ...(entry.complete !== undefined ? { complete: entry.complete } : {}),
        ...(quote ? { quote } : {}),
        scope: scopeOf(entry, ledger),
      };
      moves.push(withoutDangling(move, entry.members?.map((member, index) => ({ id: resolve(member.id, { entry: entry.id, at: "member", index }), index })) ?? []));
    }
    // 历史按故事里的先后排（同号的照账里的顺序，不代表谁先）。
    moves.sort((a, b) => a.seq - b.seq);
    // 只有有改现状权的（当下线上叙述的）走；人物说的、回忆、梦里的、定不了在哪的进单列。
    const effective = moves.filter((move) => move.scope.rights.state);
    for (const move of moves) {
      const list = (id: string) => (move.scope.rights.state ? touch(id).history : touch(id).asides);
      list(move.item).push(stepOf(move));
      // 清点的成员那边也记一笔「在它里面」（同一条为证）。
      for (const id of move.op === "census" ? (move.members ?? []) : []) if (proven.has(id)) list(id).push(memberStep(move));
    }
    const groups = new Map<number, Move[]>();
    for (const move of effective) groups.set(move.seq, [...(groups.get(move.seq) ?? []), move]);
    const tied = new Map<string, string[]>();
    for (const seq of [...groups.keys()].sort((a, b) => a - b)) for (const [id, entries] of runGroup(groups.get(seq) as Move[], chapter)) tied.set(id, entries);
    // 作者定的这章末尾的样子：压过记账员这章记的；同一样东西同一方面（在哪 / 里面有什么）定了几次的，后定的算，两方面各管各的。
    const latest = new Map<string, AuthorDecision & { type: "item.state" }>();
    for (const decision of authorStates.get(chapter) ?? []) latest.set(`${resolve(decision.item)}:${decision.state.kind === "census" ? "contents" : "where"}`, decision);
    const ruled = [...latest.values()].map((decision) => authorMove(decision, decision.state, placeView, resolve));
    for (const move of ruled) {
      touch(move.item).history.push(stepOf(move));
      for (const id of move.op === "census" ? (move.members ?? []) : []) if (proven.has(id)) touch(id).history.push(memberStep(move));
    }
    if (ruled.length > 0) for (const [id, entries] of runGroup(ruled, chapter)) tied.set(id, entries);
    // 到章末还是先后不清的才报。
    for (const [id, entries] of tied) {
      const now = items.get(id)?.now;
      if (now?.kind === "uncertain" && now.reason === "order" && now.chapter === chapter) issue("order", id, chapter, entries);
    }
    // 这章末拿不准的：装着它的、清点里有它的清点不再当完整用。
    for (const item of items.values()) {
      if (item.now?.kind !== "uncertain" || item.now.chapter !== chapter) continue;
      const containers = new Set(item.now.options.flatMap((option) => (option.kind === "known" && option.place.kind === "inside" ? [option.place.item] : [])));
      for (const other of items.values()) if (other.census?.members.has(item.id) || containers.has(other.id)) unverify(other, chapter);
    }
    // 这章东西账没记全：只缺认得出的那几样 → 只那几样（和清点里有它们的）此后没核全，这章写过它也算；
    // 整章没记全（或那几样有认不得的）→ 这章没写到的都没核全。
    const gap = itemGapOf(ledger);
    const missing = gap === "all" || gap === "none" ? [] : gap.map((id) => resolve(id));
    if (gap === "all" || missing.some((id) => !items.has(id))) {
      for (const item of items.values()) {
        if (item.unverifiedSince === undefined && item.lastWrite < chapter) markUnverified(item, chapter, "chapter");
        unverify(item, chapter);
      }
    } else {
      for (const id of missing) {
        const item = items.get(id) as MutableItem;
        if (item.unverifiedSince === undefined) markUnverified(item, chapter, "entry");
        unverify(item, chapter);
        for (const other of items.values()) if (other.census?.members.has(id)) unverify(other, chapter);
      }
    }
  }

  // 装在里面绕成圈的：结构冲突（外层不往外找）。
  for (const item of items.values()) {
    const seen = new Set<string>([item.id]);
    for (let at = insideOf(item.now); at !== undefined; at = insideOf(items.get(at)?.now)) {
      if (seen.has(at)) {
        issue("cycle", item.id, item.now?.kind === "known" ? item.now.chapter : 0, [...[...seen].sort()]);
        break;
      }
      seen.add(at);
    }
  }

  const insideIndex = new Map<string, string[]>();
  for (const item of items.values()) {
    const container = insideOf(item.now);
    if (container !== undefined) insideIndex.set(container, [...(insideIndex.get(container) ?? []), item.id]);
  }
  const views = [...items.values()].map((item): ItemView => ({
    id: item.id,
    ...(item.name !== undefined ? { name: item.name } : item.mentions[0] !== undefined ? { name: item.mentions[0] } : {}),
    ...(item.card ? { card: true as const } : {}),
    mentions: item.mentions,
    mergedFrom: [...item.mergedFrom],
    ...(item.firstSeen ? { firstSeen: item.firstSeen } : {}),
    ...(item.now ? { now: item.now } : {}),
    ...(item.unverifiedSince !== undefined ? { unverifiedSince: item.unverifiedSince, unverifiedBy: item.unverifiedBy ?? "chapter" } : {}),
    history: item.history,
    asides: item.asides,
    inside: insideIndex.get(item.id) ?? [],
    ...(item.census
      ? {
        census: {
          chapter: item.census.chapter,
          entry: item.census.entry,
          listed: item.census.listed,
          members: [...item.census.members],
          status: item.census.status,
          ...(item.census.since !== undefined ? { since: item.census.since } : {}),
        },
      }
      : {}),
    ...(proven.has(item.id) ? {} : { dangling: true as const }),
  }));
  for (const view of views) if (view.dangling) dangling.push({ kind: "item", ref: view.id, ...(view.firstSeen ? { chapter: view.firstSeen.chapter, source: view.firstSeen.entry } : { source: view.id }) });
  views.sort((a, b) => (a.firstSeen?.chapter ?? 0) - (b.firstSeen?.chapter ?? 0) || a.id.localeCompare(b.id));
  return { items: views, issues, dangling, resolve, voided: (entry, at, index) => voided.has(positionKey({ entry, at, ...(index !== undefined ? { index } : {}) })) };
}

function authorMove(
  decision: AuthorDecision & { type: "item.state" },
  state: ItemStateRuling,
  placeView: (place: ItemPlace, entry: string, at: "to" | "from") => ItemPlaceView | { readonly kind: "unknown" },
  resolve: ItemProjection["resolve"],
): Move {
  const base = { chapter: decision.chapter, entry: decision.id, seq: Number.MAX_SAFE_INTEGER, item: resolve(decision.item), scope: AUTHOR } as const;
  switch (state.kind) {
    case "at":
      return { ...base, op: "at", to: placeView(state.to, decision.id, "to") };
    case "gone":
      return { ...base, op: "gone", gone: state.gone };
    case "census":
      return { ...base, op: "census", members: state.members.map((member: ItemRef) => resolve(member.id)), complete: state.complete };
  }
}
