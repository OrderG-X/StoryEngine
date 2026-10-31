/**
 * 撤销核引用的引用表（写作版本 P2a 片 4B，设计 8.1 第 5 步）：从原始账单、作者裁定、设定卡取（不是投影的 dangling）。
 *
 * 按 schema 穷举：账单每种条目、裁定每种类型都在一个穷尽的 switch 里（漏了一种编译不过），history.test 再按 schema 枚举一遍。
 *
 *  | 来源 | 字段 | 指向 |
 *  |---|---|---|
 *  | 账单 · 事实 | replaces[]；subjectRef | 事实；名字解析 |
 *  | 账单 · 线索 | advance / close 的 threadRef | 线索（由开它的那条定义） |
 *  | 账单 · 出场 | entityRef | 名字解析 |
 *  | 账单 · 时间 | 记账员记的本章开头（任何关系，含不知道）；整章是一段时段的时间（相对前一个当下章结尾） | 前一个当下章（往前到最近一个在当下线上的章，中间没识别的、整章是段的都算上；没有也是一个目标） |
 *  | 裁定 · thread.merge | from[]、into | 线索 |
 *  | 裁定 · thread.close | thread；chapter | 线索；章 |
 *  | 裁定 · thread.weight | thread | 线索 |
 *  | 裁定 · issue.dismiss | issue（`hard-fact:<a>:<b>`） | 事实 a、b |
 *  | 裁定 · fact.retract | fact | 事实 |
 *  | 裁定 · fact.expire | fact；chapter | 事实；章 |
 *  | 裁定 · fact.assert | corrects；chapter；subject | 事实；章；名字解析 |
 *  | 裁定 · chapter.day / chapter.summary | chapter | 章 |
 *  | 账单 · 东西（P3b） | 主体（证明它存在，不引）；to / from 里面、清点成员；replaces[] / overlaps[]（含清点成员上的）；去处里的人 | 东西（只看还有没有证明它存在的）；事实；名字解析 |
 *  | 账单 · 事实 | 主体是东西的（subjectRef.id，证明它存在，不引） | — |
 *  | 裁定 · item.merge | from[]、into | 东西 |
 *  | 裁定 · item.split | item；refs[].entry | 东西；所选条目（东西条目或主体是它的事实） |
 *  | 裁定 · item.retract | entry | 东西条目 |
 *  | 裁定 · item.state | item；chapter；去处 / 成员里的东西；去处里的人；replaces / overlaps（含成员上的） | 东西；章；东西；名字解析；事实 |
 *  | 裁定 · fact.assert | subjectId | 东西 |
 *  | 裁定 · issue.dismiss | issue（`item-<种>:<章>:…`） | 那章 + 键里每条条目的整条内容和有效范围 |
 *  | 设定卡 · 关系 | a、b | 卡 |
 *
 * 被引用那条的身份（Resolver）：事实 / 线索 = 定义它的条目的整条内容摘要 + 有效范围（P3a 设计 2.3：它在当下还是哪个段、
 * 碰到的段的范围 / frame / 段的时间，和段的时间那头离前一个当下章结尾隔几天；来源在整条内容里）——同一条事实编号、原句都没变、只是被划进了梦段，身份也变；
 * 章 = 那章账单的 (committedAt, origin)；名字 = 解析链（起点的键 + 每一跳的出处：哪张卡、哪章哪条出场，带内容摘要；和投影同一个 Names）；
 * 前一个当下章 = 往前到它为止每一章的身份 + 时间摘要（时间条目、段、记没记全），或「没有」；卡 = 卡的内容摘要；
 * 时间冲突（`time-start:<章>:<天>`）= 那章的时间摘要。
 * 东西（P3b 设计 2.8）= 还有没有证明它存在的（账里以它为主体的条目、以它为主体的事实、设定卡、拆出它的裁定）：
 * 撤掉的只是它头回写到那章、后文还有证明的，不拦；撤掉的是唯一的证明、后文还装在它里面 / 清点里有它，拦。
 * 东西条目 = 那条的章 + 整条内容摘要 + 有效范围（和事实同一套）。东西矛盾的问题键 = 那章的身份 + 键里每条条目的身份。
 */
import type { SettingCardsFile } from "../schema/cards.js";
import { itemStateLinksOf, type AuthorDecision } from "../schema/decisions.js";
import { itemLinksOf, itemRefsOf, missingKindsOf, presenceName, subjectOf, threadOf, timeRoleOf, type ChapterLedger, type ItemPlace, type LedgerEntry, type TimeEntry } from "../schema/ledger.js";
import { canonicalJson } from "../store/basis.js";
import { CARDS_PATH, chapterLedgerPath, DECISIONS_PATH } from "../store/paths.js";
import { sha256Bytes } from "../store/transaction.js";
import { Names } from "../projection/names.js";
import { scopeOf } from "../projection/scope.js";
import { splitItemId } from "../projection/items.js";
import { projectTime, type ChapterTime } from "../projection/time.js";

export type Ref =
  | { readonly kind: "fact"; readonly id: string }
  | { readonly kind: "thread"; readonly id: string }
  | { readonly kind: "chapter"; readonly chapter: number }
  | { readonly kind: "name"; readonly raw: string }
  | { readonly kind: "previous"; readonly chapter: number }
  | { readonly kind: "card"; readonly id: string }
  | { readonly kind: "issue"; readonly issue: string }
  | { readonly kind: "item"; readonly id: string }
  | { readonly kind: "itemEntry"; readonly id: string };

/** 引用者在哪（给作者看的位置，结构；文案在外层）。 */
export type RefWhere =
  | { readonly kind: "ledger"; readonly chapter: number }
  | { readonly kind: "decision"; readonly chapter?: number }
  | { readonly kind: "relation" };

export interface Referencer {
  /** 所在文件。 */
  readonly file: string;
  /** 文件里的编号（条目、裁定、关系）。 */
  readonly id: string;
  /** 整条内容的摘要（存续区间按它算）。 */
  readonly digest: string;
  readonly refs: readonly Ref[];
  readonly where: RefWhere;
}

export const digestOf = (value: unknown): string => sha256Bytes(canonicalJson(value));

/**
 * 一条账单条目的身份摘要：证据只算原句的字，不算它在哪一版正文的第几句（改章名、改齐别处的句子会换版本、挪句号，
 * 这条说的事没变，后文接着它照旧接得上）。
 */
export const entryDigest = (entry: LedgerEntry): string => {
  const { evidence, evidenceStatus: _status, ...rest } = entry;
  return digestOf({ ...rest, quotes: evidence.map((item) => item.quote) });
};

/** 账单里一条条目指向什么（穷尽）。 */
export function refsOfEntry(entry: LedgerEntry, chapter: number): Ref[] {
  switch (entry.kind) {
    case "summary":
      return [];
    case "fact":
      // 主体是东西的：它自己就证明那样东西存在（不引）；名字照旧按别名表。
      return [
        ...(entry.replaces ?? []).map((id): Ref => ({ kind: "fact", id })),
        ...(subjectOf(entry) && entry.subjectRef?.id === undefined ? [{ kind: "name", raw: subjectOf(entry) as string } as const] : []),
      ];
    case "item":
      return [
        ...itemLinksOf(entry).flatMap((link) => [...link.replaces, ...link.overlaps]).map((id): Ref => ({ kind: "fact", id })),
        ...itemRefsOf(entry).flatMap(({ at, ref }): Ref[] => (at === "item" ? [] : [{ kind: "item", id: ref.id }])),
        ...[entry.to, entry.from].flatMap((place): Ref[] => (place?.kind === "person" ? [{ kind: "name", raw: place.ref.mention }] : [])),
      ];
    case "thread":
      return entry.op === "open" ? [] : [{ kind: "thread", id: threadOf(entry) }];
    case "presence":
      return [{ kind: "name", raw: presenceName(entry) }];
    case "time": {
      // 作者直接定了第几天的不按相对天数算；记账员记的本章开头（含不知道：它认定本章在当下线上、接着前一个当下章）、
      // 整章是一段时段的时间，都接着前一个当下章（不看裁定盖没盖住它，设计 8.1）。同一天、换天、章内段只相对本章。
      const role = timeRoleOf(entry);
      return role === "start" || (role === "scene" && entry.anchor === "previousChapterEnd") ? [{ kind: "previous", chapter }] : [];
    }
    default: {
      const never: never = entry;
      return never;
    }
  }
}

/** 一条裁定指向什么（穷尽）。 */
export function refsOfDecision(decision: AuthorDecision): Ref[] {
  switch (decision.type) {
    case "thread.merge":
      return [...decision.from, decision.into].map((id): Ref => ({ kind: "thread", id }));
    case "thread.close":
      return [{ kind: "thread", id: decision.thread }, { kind: "chapter", chapter: decision.chapter }];
    case "thread.weight":
      return [{ kind: "thread", id: decision.thread }];
    case "issue.dismiss":
      return [{ kind: "issue", issue: decision.issue }];
    case "fact.retract":
      return [{ kind: "fact", id: decision.fact }];
    case "fact.expire":
      return [{ kind: "fact", id: decision.fact }, { kind: "chapter", chapter: decision.chapter }];
    case "fact.assert":
      return [
        ...(decision.corrects ? [{ kind: "fact", id: decision.corrects } as const] : []),
        { kind: "chapter", chapter: decision.chapter },
        ...(decision.subjectId !== undefined ? [{ kind: "item", id: decision.subjectId } as const] : decision.subject ? [{ kind: "name", raw: decision.subject } as const] : []),
      ];
    case "chapter.day":
    case "chapter.summary":
      return [{ kind: "chapter", chapter: decision.chapter }];
    case "item.merge":
      return [...decision.from, decision.into].map((id): Ref => ({ kind: "item", id }));
    case "item.split":
      return [{ kind: "item", id: decision.item }, ...[...new Set(decision.refs.map((ref) => ref.entry))].map((id): Ref => ({ kind: "itemEntry", id }))];
    case "item.retract":
      return [{ kind: "itemEntry", id: decision.entry }];
    case "item.state": {
      const state = decision.state;
      const inner = state.kind === "census" ? state.members.map((member) => member.id) : state.kind === "at" && state.to.kind === "inside" ? [state.to.ref.id] : [];
      const person = state.kind === "at" && state.to.kind === "person" ? [{ kind: "name", raw: (state.to as ItemPlace & { kind: "person" }).ref.mention } as const] : [];
      const facts = itemStateLinksOf(decision).flatMap((link) => [...link.replaces, ...link.overlaps]).map((id): Ref => ({ kind: "fact", id }));
      return [{ kind: "item", id: decision.item }, { kind: "chapter", chapter: decision.chapter }, ...inner.map((id): Ref => ({ kind: "item", id })), ...person, ...facts];
    }
    default: {
      const never: never = decision;
      return never;
    }
  }
}

const decisionChapter = (decision: AuthorDecision): number | undefined => ("chapter" in decision ? decision.chapter : undefined);

export function ledgerReferencers(ledger: ChapterLedger, file: string = chapterLedgerPath(ledger.chapter)): Referencer[] {
  return ledger.entries.flatMap((entry) => {
    const refs = refsOfEntry(entry, ledger.chapter);
    return refs.length === 0 ? [] : [{ file, id: entry.id, digest: entryDigest(entry), refs, where: { kind: "ledger", chapter: ledger.chapter } as const }];
  });
}

export function decisionReferencers(decisions: readonly AuthorDecision[]): Referencer[] {
  return decisions.flatMap((decision) => {
    const refs = refsOfDecision(decision);
    const chapter = decisionChapter(decision);
    return refs.length === 0 ? [] : [{ file: DECISIONS_PATH, id: decision.id, digest: digestOf(decision), refs, where: { kind: "decision", ...(chapter !== undefined ? { chapter } : {}) } as const }];
  });
}

export function cardReferencers(cards: SettingCardsFile | undefined): Referencer[] {
  return (cards?.relations ?? []).map((relation) => ({
    file: CARDS_PATH,
    id: `relation:${relation.id}`,
    digest: digestOf(relation),
    refs: [{ kind: "card", id: relation.a }, { kind: "card", id: relation.b }],
    where: { kind: "relation" },
  }));
}

export interface TruthView {
  readonly ledgers: readonly ChapterLedger[];
  readonly decisions: readonly AuthorDecision[];
  readonly cards: SettingCardsFile | undefined;
}

/** 在一版真相里解析引用：每个引用 → 一串身份（两版比这串）。 */
export class Resolver {
  private readonly names = new Names();
  private readonly facts = new Map<string, string[]>();
  private readonly threads = new Map<string, string[]>();
  private readonly chapters = new Map<number, string>();
  private readonly order: number[];
  private readonly cardDigests = new Map<string, string>();
  /** 每章的时间摘要（时间条目、段、时间记没记全、格式）。 */
  private readonly timeDigests = new Map<number, string>();
  /** 每章在不在当下线上（投影同一套：作者定的天数、旧账推定都算）。 */
  private readonly presentLine = new Map<number, boolean>();
  /** 投影算的每章时间（段的时间那头离前一个当下章几天）。 */
  private readonly times: ReadonlyMap<number, ChapterTime>;
  /** 有证明存在的东西编号（账里的主体、主体是东西的事实、设定卡、拆出来的）。 */
  private readonly provedItems = new Set<string>();
  /** 东西条目 → 章@摘要。 */
  private readonly itemEntries = new Map<string, string>();

  constructor(truth: TruthView) {
    const ledgers = [...truth.ledgers].sort((a, b) => a.chapter - b.chapter);
    if (truth.cards) {
      this.names.addCards(truth.cards, (card) => `card:${card.id}@${digestOf(card)}`);
      for (const card of truth.cards.cards) this.cardDigests.set(card.id, digestOf(card));
    }
    const add = (map: Map<string, string[]>, id: string, identity: string): void => {
      map.set(id, [...(map.get(id) ?? []), identity]);
    };
    for (const ledger of ledgers) {
      this.chapters.set(ledger.chapter, `${ledger.committedAt}|${ledger.origin}`);
      this.timeDigests.set(ledger.chapter, digestOf({
        timeModel: ledger.timeModel ?? null,
        status: ledger.status,
        timeMissing: missingKindsOf(ledger).includes("time"),
        times: ledger.entries.filter((entry) => entry.kind === "time").map(entryDigest),
        scenes: ledger.scenes,
      }));
      for (const entry of ledger.entries) {
        if (entry.kind === "presence") this.names.addPresence(entry, `presence:${ledger.chapter}:${entry.id}@${entryDigest(entry)}`);
      }
    }
    this.order = ledgers.map((ledger) => ledger.chapter);
    const time = projectTime(ledgers, truth.decisions, truth.cards?.calendar?.dayBoundary, new Set());
    this.times = time.chapters;
    for (const [chapter, view] of time.chapters) this.presentLine.set(chapter, view.presentLine === true);
    for (const ledger of ledgers) {
      for (const entry of ledger.entries) {
        if (entry.kind === "fact") add(this.facts, entry.id, `${ledger.chapter}@${entryDigest(entry)}#${this.scopeDigest(entry, ledger)}`);
        if (entry.kind === "thread" && entry.op === "open") add(this.threads, threadOf(entry), `${ledger.chapter}@${entryDigest(entry)}#${this.scopeDigest(entry, ledger)}`);
      }
    }
    for (const decision of truth.decisions) if (decision.type === "fact.assert") add(this.facts, decision.id, `decision@${digestOf(decision)}`);
    for (const card of truth.cards?.cards ?? []) if (card.kind === "item") this.provedItems.add(card.id);
    for (const decision of truth.decisions) if (decision.type === "item.state") this.itemEntries.set(decision.id, `decision@${digestOf(decision)}`);
    for (const decision of truth.decisions) if (decision.type === "item.split") this.provedItems.add(splitItemId(decision.id));
    for (const ledger of ledgers) {
      for (const entry of ledger.entries) {
        if (entry.kind === "item") {
          this.provedItems.add(entry.itemRef.id);
          this.itemEntries.set(entry.id, `${ledger.chapter}@${entryDigest(entry)}#${this.scopeDigest(entry, ledger)}`);
        }
        if (entry.kind === "fact" && entry.subjectRef?.id !== undefined) {
          this.provedItems.add(entry.subjectRef.id);
          this.itemEntries.set(entry.id, `${ledger.chapter}@${entryDigest(entry)}#${this.scopeDigest(entry, ledger)}`);
        }
      }
    }
  }

  /**
   * 一条事实 / 线索的有效范围摘要：它在当下还是哪种段，和它的原句碰到的段（范围、frame、段的时间）；定位不了就是本章全部的段。
   * 段的时间相对谁，那头离前一个当下章结尾隔几天也算（出口复核 R4，和「前一个当下章」引用同一个口径：只认相对位置）：
   * 相对本章开头的 = 前一个当下章是哪章 + 本章开头离它结尾几天（投影算的，两种换天规矩各一份，一样就并成一份）；
   * 相对前一个当下章结尾的 = 那章是哪章。本章开头挪了两天，回忆里那件事跟着挪，后文接着它的要拦；
   * 前面的章整体挪了（裁定改了第 1 章是哪天），这章和后文一起挪、相对没变，不拦（同「撤掉一条天数裁定不拦」）。
   */
  private scopeDigest(entry: LedgerEntry, ledger: ChapterLedger): string {
    const scope = scopeOf(entry, ledger);
    const ranges = entry.evidenceStatus === "located" ? entry.evidence.flatMap((item) => (item.units ? [item.units] : [])) : [];
    const touched = ranges.length === 0 ? ledger.scenes : ledger.scenes.filter((scene) => ranges.some((range) => range.from <= scene.units.to && range.to >= scene.units.from));
    const sceneTimes = new Set(touched.flatMap((scene) => scene.timeRefs));
    const times = ledger.entries.filter((item): item is TimeEntry => item.kind === "time" && sceneTimes.has(item.id));
    const anchors = new Set(times.flatMap((item) => (item.anchor ? [item.anchor] : [])));
    return digestOf({
      frame: scope.frame,
      scenes: touched,
      times: times.map(entryDigest),
      ...(anchors.size > 0 ? { anchor: this.anchorOf(ledger.chapter, anchors.has("chapterStart")) } : {}),
    });
  }

  /** 段的时间那头在哪：前一个当下章是哪章（链断了是 null）；相对本章开头的再加本章开头离它几天。 */
  private anchorOf(chapter: number, fromStart: boolean): unknown {
    const view = this.times.get(chapter);
    if (view?.presentLine !== true) return { previous: this.previousPresentOf(chapter) ?? null };
    if (!fromStart) return { previous: view.previousPresent ?? null };
    const worlds = Object.keys(view.byWorld) as (keyof typeof view.byWorld)[];
    const since = worlds.map((world) => view.byWorld[world]?.sincePrevious ?? null);
    const same = since.every((range) => canonicalJson(range) === canonicalJson(since[0] ?? null));
    return {
      previous: view.previousPresent ?? null,
      sincePrevious: same ? (since[0] ?? null) : Object.fromEntries(worlds.map((world, index) => [world, since[index]])),
      presumed: view.presumed,
    };
  }

  /** 不在当下线上的章往前找最近的当下章（中间有没识别的就断了）。 */
  private previousPresentOf(chapter: number): number | undefined {
    for (const before of this.order.filter((item) => item < chapter).reverse()) {
      const line = this.times.get(before)?.presentLine;
      if (line === true) return before;
      if (line === "unknown") return undefined;
    }
    return undefined;
  }

  private fact(id: string): string {
    return `fact:${id}=${(this.facts.get(id) ?? ["none"]).join(",")}`;
  }

  resolve(ref: Ref): string {
    switch (ref.kind) {
      case "fact":
        return this.fact(ref.id);
      case "thread":
        return `thread:${ref.id}=${(this.threads.get(ref.id) ?? ["none"]).join(",")}`;
      case "chapter":
        return `chapter:${ref.chapter}=${this.chapters.get(ref.chapter) ?? "none"}`;
      case "name":
        return `name:${ref.raw}=${this.names.chain(ref.raw).join(" ")}`;
      case "previous": {
        // 往前到最近一个在当下线上的章为止，每一章都算（中间没识别的、整章是段的决定了找不找得到它）。
        const chain: string[] = [];
        for (const chapter of this.order.filter((item) => item < ref.chapter).reverse()) {
          chain.push(`${chapter}|${this.chapters.get(chapter)}|${this.timeDigests.get(chapter)}`);
          if (this.presentLine.get(chapter)) break;
        }
        return `previous:${ref.chapter}=${chain.length === 0 ? "none" : chain.join(",")}`;
      }
      case "card":
        return `card:${ref.id}=${this.cardDigests.get(ref.id) ?? "none"}`;
      case "item":
        return `item:${ref.id}=${this.provedItems.has(ref.id) ? "proved" : "none"}`;
      case "itemEntry":
        return `itemEntry:${ref.id}=${this.itemEntries.get(ref.id) ?? "none"}`;
      case "issue": {
        // 自家格式 `item-<种>:<章>:<条目号…>`（projection/items.ts）：那章的身份 + 每条条目的整条内容和有效范围（作者定的是那条裁定）。
        if (ref.issue.startsWith("item-")) {
          const [, chapter, ...entries] = ref.issue.split(":");
          return `issue:${ref.issue}=${this.chapters.get(Number(chapter)) ?? "none"}|${entries.map((id) => this.itemEntries.get(id) ?? "none").join("&")}`;
        }
        // 自家格式 `time-start:<章>:<天>` / `time-end:<章>:<天>`（projection/time.ts）：那章的时间摘要。
        for (const prefix of ["time-start:", "time-end:"]) {
          if (!ref.issue.startsWith(prefix)) continue;
          const rest = ref.issue.slice(prefix.length);
          const chapter = Number(rest.slice(0, rest.indexOf(":")));
          return `issue:${ref.issue}=${this.chapters.get(chapter) ?? "none"}|${this.timeDigests.get(chapter) ?? "none"}`;
        }
        // 自家格式 `hard-fact:<a>:<b>`（projection/project.ts）：编号里万一也有冒号，每一种拆法都算上；认不出的格式投影也不用它。
        const prefix = "hard-fact:";
        if (!ref.issue.startsWith(prefix)) return `issue:${ref.issue}=unparsed`;
        const rest = ref.issue.slice(prefix.length);
        const splits: string[] = [];
        for (let at = rest.indexOf(":"); at >= 0; at = rest.indexOf(":", at + 1)) splits.push(`${this.fact(rest.slice(0, at))}&${this.fact(rest.slice(at + 1))}`);
        return `issue:${ref.issue}=${splits.join(";")}`;
      }
      default: {
        const never: never = ref;
        return never;
      }
    }
  }

  identities(referencer: Referencer): string[] {
    return referencer.refs.map((ref) => this.resolve(ref));
  }
}
