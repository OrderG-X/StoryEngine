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
 *  | 账单 · 时间 | 本章开头相对上一章结尾的（offset · previousChapterEnd） | 前一章（剩下的账单里排在本章前面的那一章；没有也是一个目标） |
 *  | 裁定 · thread.merge | from[]、into | 线索 |
 *  | 裁定 · thread.close | thread；chapter | 线索；章 |
 *  | 裁定 · thread.weight | thread | 线索 |
 *  | 裁定 · issue.dismiss | issue（`hard-fact:<a>:<b>`） | 事实 a、b |
 *  | 裁定 · fact.retract | fact | 事实 |
 *  | 裁定 · fact.expire | fact；chapter | 事实；章 |
 *  | 裁定 · fact.assert | corrects；chapter；subject | 事实；章；名字解析 |
 *  | 裁定 · chapter.day / chapter.summary | chapter | 章 |
 *  | 设定卡 · 关系 | a、b | 卡 |
 *
 * 被引用那条的身份（Resolver）：事实 / 线索 = 定义它的条目的整条内容摘要（同编号有几条就全算上）；章 = 那章账单的
 * (committedAt, origin)；名字 = 解析链（起点的键 + 每一跳的出处：哪张卡、哪章哪条出场，带内容摘要；和投影同一个 Names）；
 * 前一章 = 那一章的身份或「没有」；卡 = 卡的内容摘要。
 */
import type { SettingCardsFile } from "../schema/cards.js";
import type { AuthorDecision } from "../schema/decisions.js";
import { presenceName, subjectOf, threadOf, type ChapterLedger, type LedgerEntry } from "../schema/ledger.js";
import { canonicalJson } from "../store/basis.js";
import { CARDS_PATH, chapterLedgerPath, DECISIONS_PATH } from "../store/paths.js";
import { sha256Bytes } from "../store/transaction.js";
import { Names } from "../projection/names.js";

export type Ref =
  | { readonly kind: "fact"; readonly id: string }
  | { readonly kind: "thread"; readonly id: string }
  | { readonly kind: "chapter"; readonly chapter: number }
  | { readonly kind: "name"; readonly raw: string }
  | { readonly kind: "previous"; readonly chapter: number }
  | { readonly kind: "card"; readonly id: string }
  | { readonly kind: "issue"; readonly issue: string };

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
      return [...(entry.replaces ?? []).map((id): Ref => ({ kind: "fact", id })), ...(subjectOf(entry) ? [{ kind: "name", raw: subjectOf(entry) as string } as const] : [])];
    case "thread":
      return entry.op === "open" ? [] : [{ kind: "thread", id: threadOf(entry) }];
    case "presence":
      return [{ kind: "name", raw: presenceName(entry) }];
    case "time":
      // 作者直接定了第几天的不按相对天数算；别的「隔几天」都接着前一章（不看裁定盖没盖住它，设计 8.1）。本章结尾那条只相对本章开头。
      return entry.relation === "offset" && entry.anchor === "previousChapterEnd" ? [{ kind: "previous", chapter }] : [];
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
        ...(decision.subject ? [{ kind: "name", raw: decision.subject } as const] : []),
      ];
    case "chapter.day":
    case "chapter.summary":
      return [{ kind: "chapter", chapter: decision.chapter }];
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
      for (const entry of ledger.entries) {
        if (entry.kind === "presence") this.names.addPresence(entry, `presence:${ledger.chapter}:${entry.id}@${entryDigest(entry)}`);
        if (entry.kind === "fact") add(this.facts, entry.id, `${ledger.chapter}@${entryDigest(entry)}`);
        if (entry.kind === "thread" && entry.op === "open") add(this.threads, threadOf(entry), `${ledger.chapter}@${entryDigest(entry)}`);
      }
    }
    for (const decision of truth.decisions) if (decision.type === "fact.assert") add(this.facts, decision.id, `decision@${digestOf(decision)}`);
    this.order = ledgers.map((ledger) => ledger.chapter);
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
        const previous = this.order.filter((chapter) => chapter < ref.chapter).at(-1);
        return `previous:${ref.chapter}=${previous === undefined ? "none" : `${previous}|${this.chapters.get(previous)}`}`;
      }
      case "card":
        return `card:${ref.id}=${this.cardDigests.get(ref.id) ?? "none"}`;
      case "issue": {
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
