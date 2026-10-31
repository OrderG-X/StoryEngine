/**
 * 从真相算投影。纯函数：同样的账单和裁定，算出来一模一样；改了哪一章，整份重算即可。
 *
 * 不做增量：200 章、每章几十条，全量重算在几十毫秒内（见 project.test 的量级测试），
 * 增量缓存带来的「从中间算和从头算不一致」风险不值得。P7 实测慢了再说。
 *
 * 规则全是确定性的，不读正文、不判断意思：
 *  - 名字：出场条目里「正文用的称呼 ≠ 已确立名字」就是别名；设定卡上写的别名也算；主体名先过别名表再比。
 *  - 状态（state）：同一主体同一方面，后一章的值顶替前一章的。
 *  - 不会变的（hard）：只有明写推翻（replaces）才作废；值不同又没推翻 = 矛盾，交给作者。
 *  - 来源和段限权（P3a，projection/scope.ts）：梦里的、回忆里的、人物说的、定不了在段里段外的不更新现状、replaces 不生效、
 *    不收线索；来源不明的照旧更新，但矛盾只报「可能」。
 *  - 线索：开 / 推进 / 收按章序；收了又推进 = 重新打开；作者的归并、收口、分量最后套上。
 *  - 时间：projection/time.ts（当下线、两种换天规矩、区间、星期）。
 */
import type { SettingCardsFile } from "../schema/cards.js";
import type { AuthorDecision } from "../schema/decisions.js";
import { entryQuote, missingKindsOf, presenceName, subjectOf, threadOf, type ChapterLedger, type FactEntry, type ThreadEntry } from "../schema/ledger.js";
import { nameKey } from "../text/quote.js";
import { idleChaptersBetween, threadUnknownChapters } from "./coverage.js";
import { Names } from "./names.js";
import { lowerConflict, rightsOf, scopeOf, type ConflictLevel, type EntryScope } from "./scope.js";
import { projectTime, type TimeProjection } from "./time.js";
import type {
  BookProjection,
  CastMember,
  ChapterView,
  ConflictView,
  DanglingView,
  FactView,
  SubjectAttributeView,
  StatementScope,
  SubjectView,
  ThreadTouch,
  ThreadView,
  ThreadWeight,
} from "./types.js";

export interface ProjectionInput {
  readonly ledgers: readonly ChapterLedger[];
  readonly decisions: readonly AuthorDecision[];
  readonly version?: number;
  /** 每章正文现在的 sha256；给了就能标「定稿后改过」。 */
  readonly textHashes?: ReadonlyMap<number, string>;
  readonly unsettled?: boolean;
  /** 设定卡：卡上写的别名并进别名表（账里记成别名的人、东西，算到那张卡的名字上）。 */
  readonly cards?: SettingCardsFile;
}

export interface ProjectionOptions {
  /** 只算到第几章（含）。缺省 = 全部。 */
  readonly upTo?: number;
  /** 线索多少章没动算「停太久」。缺省 5。 */
  readonly staleAfter?: number;
}

export const DEFAULT_STALE_AFTER = 5;
/** 大伏笔本来就要埋很久：没动这么多倍的章数才算「停太久」（缺省 5 × 4 = 20 章），免得作者定了大伏笔还天天被催。 */
export const MAJOR_STALE_FACTOR = 4;

function buildCast(ledgers: readonly ChapterLedger[], names: Names): CastMember[] {
  const members = new Map<string, { name: string; aliases: Set<string>; chapters: Set<number>; viewpoint: Set<number>; quotes: Map<number, string> }>();
  for (const ledger of ledgers) {
    for (const entry of ledger.entries) {
      if (entry.kind !== "presence") continue;
      const { key, name } = names.resolve(presenceName(entry));
      let member = members.get(key);
      if (!member) {
        member = { name, aliases: new Set(), chapters: new Set(), viewpoint: new Set(), quotes: new Map() };
        members.set(key, member);
      }
      if (nameKey(entry.nameUsed) !== key && !entry.generic) member.aliases.add(entry.nameUsed);
      member.chapters.add(ledger.chapter);
      if (entry.viewpoint) member.viewpoint.add(ledger.chapter);
      const quote = entryQuote(entry);
      if (quote && !member.quotes.has(ledger.chapter)) member.quotes.set(ledger.chapter, quote);
    }
  }
  return [...members.entries()]
    .map(([key, member]) => ({
      key,
      name: member.name,
      aliases: [...member.aliases],
      chapters: [...member.chapters].sort((a, b) => a - b),
      viewpointChapters: [...member.viewpoint].sort((a, b) => a - b),
      appearances: [...member.quotes.entries()].sort(([a], [b]) => a - b).map(([chapter, quote]) => ({ chapter, quote })),
    }))
    .sort((a, b) => (a.chapters[0] ?? 0) - (b.chapters[0] ?? 0) || a.key.localeCompare(b.key));
}

type MutableFact = { -readonly [K in keyof FactView]: FactView[K] };

function buildFacts(
  ledgers: readonly ChapterLedger[],
  decisions: readonly AuthorDecision[],
  names: Names,
  dismissed: ReadonlySet<string>,
): { facts: FactView[]; subjects: SubjectView[]; conflicts: ConflictView[]; dangling: DanglingView[] } {
  const retracted = new Set(
    decisions.flatMap((decision) =>
      decision.type === "fact.retract" ? [decision.fact] : decision.type === "fact.assert" && decision.corrects ? [decision.corrects] : [],
    ),
  );
  const expiries = decisions.filter((decision) => decision.type === "fact.expire");
  // 作者补记的事实：当成那一章账单末尾多出来的一条（没有原句），和账单里的事实走同一套顶替 / 矛盾规则。
  const asserted = new Map<number, FactEntry[]>();
  const chapters = new Set(ledgers.map((ledger) => ledger.chapter));
  const upTo = ledgers.at(-1)?.chapter ?? 0;
  const assertDangling: DanglingView[] = [];
  for (const decision of decisions) {
    if (decision.type !== "fact.assert") continue;
    if (!chapters.has(decision.chapter)) {
      if (decision.chapter <= upTo) assertDangling.push({ kind: "decision", ref: `chapter:${decision.chapter}`, chapter: decision.chapter, source: decision.id });
      continue;
    }
    const list = asserted.get(decision.chapter) ?? [];
    list.push({
      id: decision.id,
      kind: "fact",
      review: "author",
      source: { kind: "author_ruling", decision: decision.id },
      transition: "unknown",
      evidence: [],
      evidenceStatus: "none",
      provenance: "native",
      nature: decision.nature,
      ...(decision.subject ? { subjectRef: { mention: decision.subject } } : {}),
      ...(decision.attribute ? { predicate: decision.attribute } : {}),
      ...(decision.value ? { value: decision.value } : {}),
      text: decision.text,
    });
    asserted.set(decision.chapter, list);
  }
  const byId = new Map<string, MutableFact>();
  const ordered: MutableFact[] = [];
  const currentState = new Map<string, string>();
  const currentHard = new Map<string, string[]>();
  const conflicts: ConflictView[] = [];
  const dangling: DanglingView[] = [...assertDangling];
  const subjects = new Map<string, { name: string; attrs: Map<string, { attribute: string; nature: "hard" | "state"; history: string[] }> }>();

  const supersede = (target: MutableFact, chapter: number, by: string): void => {
    target.status = "superseded";
    target.supersededAt = chapter;
    target.supersededBy = by;
    const key = `${target.subjectKey}|${target.attributeKey ?? ""}`;
    if (target.nature === "state" && currentState.get(key) === target.id) currentState.delete(key);
    if (target.nature === "hard") {
      const list = currentHard.get(key);
      if (list) currentHard.set(key, list.filter((id) => id !== target.id));
    }
  };

  // 每条事实报矛盾到什么程度（scope.ts）。
  const conflictLevel = new Map<string, ConflictLevel>();
  const AUTHOR_SCOPE: EntryScope = { frame: "present", source: "author_ruling", rights: rightsOf("author_ruling", "present") };
  for (const ledger of ledgers) {
    const assertedIds = new Set((asserted.get(ledger.chapter) ?? []).map((entry) => entry.id));
    for (const entry of [...ledger.entries, ...(asserted.get(ledger.chapter) ?? [])]) {
      if (entry.kind !== "fact") continue;
      const scope = assertedIds.has(entry.id) ? AUTHOR_SCOPE : scopeOf(entry, ledger);
      const fact = toFactView(entry, ledger.chapter, names, retracted.has(entry.id), scope);
      byId.set(fact.id, fact);
      ordered.push(fact);
      if (fact.status === "retracted") continue;
      conflictLevel.set(fact.id, scope.rights.conflict);
      // 梦里的、回忆里的、人物说的……记着，不算现状：不顶替、不推翻；不会变的照样和现状比一比（报到它那一级）。
      if (!scope.rights.state) fact.status = "aside";

      for (const ref of scope.rights.replaces ? (entry.replaces ?? []) : []) {
        const target = byId.get(ref);
        if (!target || target.chapter >= ledger.chapter) {
          dangling.push({ kind: "fact", ref, chapter: ledger.chapter, source: entry.id });
        } else if (target.status === "current") {
          supersede(target, ledger.chapter, fact.id);
        }
      }
      if (fact.nature === "event" || fact.attributeKey === undefined || fact.subjectKey === undefined) continue;

      const key = `${fact.subjectKey}|${fact.attributeKey}`;
      if (!scope.rights.state && fact.nature === "state") continue;
      let subject = subjects.get(fact.subjectKey);
      if (!subject) {
        subject = { name: fact.subject ?? fact.subjectKey, attrs: new Map() };
        subjects.set(fact.subjectKey, subject);
      }
      let attr = subject.attrs.get(fact.attributeKey);
      if (!attr) {
        attr = { attribute: fact.attribute ?? fact.attributeKey, nature: fact.nature, history: [] };
        subject.attrs.set(fact.attributeKey, attr);
      }
      if (scope.rights.state) attr.history.push(fact.id);

      if (fact.nature === "state") {
        if (!scope.rights.state) continue;
        const previous = currentState.get(key);
        if (previous !== undefined) supersede(byId.get(previous) as MutableFact, ledger.chapter, fact.id);
        currentState.set(key, fact.id);
        continue;
      }
      const list = currentHard.get(key) ?? [];
      const valueKey = nameKey(fact.value ?? "");
      for (const otherId of list) {
        const other = byId.get(otherId) as MutableFact;
        if (nameKey(other.value ?? "") === valueKey) continue;
        const level = lowerConflict(scope.rights.conflict, conflictLevel.get(otherId) ?? "maybe");
        if (level === "none") continue;
        const issue = `hard-fact:${otherId}:${fact.id}`;
        if (dismissed.has(issue)) continue;
        conflicts.push({ key: issue, kind: "hard-fact", confidence: level, subject: fact.subject ?? "", attribute: fact.attribute ?? "", facts: [otherId, fact.id] });
      }
      if (scope.rights.state) currentHard.set(key, [...list, fact.id]);
    }
  }

  // 作者说「从第几章起不再成立」的：在那章作废（没有顶替的新说法）。指向不存在的摆进 dangling。
  for (const expiry of expiries) {
    const target = byId.get(expiry.fact);
    if (!target) {
      dangling.push({ kind: "decision", ref: expiry.fact, source: expiry.id });
      continue;
    }
    if (target.status !== "current" || expiry.chapter <= target.chapter) continue;
    target.status = "superseded";
    target.supersededAt = expiry.chapter;
    delete target.supersededBy;
  }
  // 早一条在晚一条那章之前就不成立了，两条不算矛盾。
  const validAt = (id: string, chapter: number): boolean => {
    const fact = byId.get(id);
    return fact !== undefined && (fact.supersededAt === undefined || fact.supersededAt > chapter);
  };
  const liveConflicts = conflicts.filter((conflict) => {
    const later = byId.get(conflict.facts[1])?.chapter ?? 0;
    return validAt(conflict.facts[0], later) && validAt(conflict.facts[1], later);
  });

  const subjectViews: SubjectView[] = [...subjects.entries()].map(([key, subject]) => ({
    key,
    name: subject.name,
    attributes: [...subject.attrs.entries()].map(([attrKey, attr]): SubjectAttributeView => ({
      attribute: attr.attribute,
      key: attrKey,
      nature: attr.nature,
      current: attr.history.filter((id) => byId.get(id)?.status === "current"),
      history: attr.history,
    })),
  }));
  return { facts: ordered, subjects: subjectViews, conflicts: liveConflicts, dangling };
}

const statementOf = (scope: EntryScope): StatementScope => ({ frame: scope.frame, source: scope.source, ...(scope.speaker ? { speaker: scope.speaker } : {}) });

function toFactView(entry: FactEntry, chapter: number, names: Names, retracted: boolean, scope: EntryScope): MutableFact {
  const mention = subjectOf(entry);
  const subject = mention ? names.resolve(mention) : undefined;
  const quote = entryQuote(entry);
  return {
    id: entry.id,
    chapter,
    nature: entry.nature,
    ...(subject ? { subject: subject.name, subjectKey: subject.key } : {}),
    ...(entry.predicate ? { attribute: entry.predicate, attributeKey: nameKey(entry.predicate) } : {}),
    ...(entry.value ? { value: entry.value } : {}),
    text: entry.text,
    ...(quote ? { quote } : {}),
    review: entry.review,
    status: retracted ? "retracted" : "current",
    scope: statementOf(scope),
  };
}

interface MutableThread {
  id: string;
  type: ThreadView["type"];
  title: string;
  openedAt: number;
  closedAt?: number;
  closedBy?: "ledger" | "author";
  weight: ThreadWeight;
  touches: ThreadTouch[];
  mergedFrom: string[];
}

function touchOf(entry: ThreadEntry, chapter: number, closeDenied?: EntryScope): ThreadTouch {
  const quote = entryQuote(entry);
  return {
    chapter,
    op: closeDenied ? "advance" : entry.op,
    note: entry.note,
    ...(quote ? { quote } : {}),
    entry: entry.id,
    ...(closeDenied ? { closeDenied: statementOf(closeDenied) } : {}),
  };
}

function buildThreads(
  ledgers: readonly ChapterLedger[],
  decisions: readonly AuthorDecision[],
  upTo: number,
  staleAfter: number,
): { threads: ThreadView[]; dangling: DanglingView[] } {
  const threads = new Map<string, MutableThread>();
  const dangling: DanglingView[] = [];
  for (const ledger of ledgers) {
    const entries = ledger.entries.filter((entry): entry is ThreadEntry => entry.kind === "thread");
    // 同一章里先开后推：本章开、本章就推进的也接得上。
    for (const entry of entries) {
      if (entry.op !== "open") continue;
      const id = threadOf(entry);
      if (threads.has(id)) {
        dangling.push({ kind: "thread", ref: id, chapter: ledger.chapter, source: entry.id });
        continue;
      }
      threads.set(id, {
        id,
        type: entry.type ?? "question",
        title: entry.title ?? entry.note,
        openedAt: ledger.chapter,
        weight: "normal",
        touches: [touchOf(entry, ledger.chapter)],
        mergedFrom: [],
      });
    }
    for (const entry of entries) {
      if (entry.op === "open") continue;
      const thread = threads.get(threadOf(entry));
      if (!thread) {
        dangling.push({ kind: "thread", ref: threadOf(entry), chapter: ledger.chapter, source: entry.id });
        continue;
      }
      // 人物说的、回忆里的、梦里的、定不了在哪的收口：按推进记（设计第 3 节）。
      const scope = entry.op === "close" ? scopeOf(entry, ledger) : undefined;
      const denied = scope && !scope.rights.close ? scope : undefined;
      thread.touches.push(touchOf(entry, ledger.chapter, denied));
      if (entry.op === "close" && !denied) {
        thread.closedAt = ledger.chapter;
        thread.closedBy = "ledger";
      } else {
        delete thread.closedAt;
        delete thread.closedBy;
      }
    }
  }

  // 作者裁定按顺序套上。
  for (const decision of decisions) {
    if (decision.type === "thread.merge") {
      const into = threads.get(decision.into);
      if (!into) {
        dangling.push({ kind: "decision", ref: decision.into, source: decision.id });
        continue;
      }
      for (const fromId of decision.from) {
        const from = threads.get(fromId);
        if (!from || fromId === decision.into) {
          if (!from) dangling.push({ kind: "decision", ref: fromId, source: decision.id });
          continue;
        }
        into.touches = [...into.touches, ...from.touches].sort((a, b) => a.chapter - b.chapter);
        into.openedAt = Math.min(into.openedAt, from.openedAt);
        into.mergedFrom.push(fromId, ...from.mergedFrom);
        threads.delete(fromId);
      }
    } else if (decision.type === "thread.close") {
      const thread = threads.get(decision.thread);
      if (!thread) {
        dangling.push({ kind: "decision", ref: decision.thread, source: decision.id });
        continue;
      }
      thread.closedAt = decision.chapter;
      thread.closedBy = "author";
    } else if (decision.type === "thread.weight") {
      const thread = threads.get(decision.thread);
      if (!thread) {
        dangling.push({ kind: "decision", ref: decision.thread, source: decision.id });
        continue;
      }
      thread.weight = decision.weight;
    }
  }

  // 「多少章没动」不数线索没记全的章（账待记、没记全）：不知道那几章动没动。
  const unknown = threadUnknownChapters(ledgers.map((ledger) => ({ chapter: ledger.chapter, missingKinds: missingKindsOf(ledger) })));
  const idleSince = (chapter: number): number => idleChaptersBetween(chapter, upTo, unknown);
  const views = [...threads.values()].map((thread): ThreadView => {
    const lastTouchedAt = Math.max(thread.openedAt, ...thread.touches.map((touch) => touch.chapter));
    const idleChapters = Math.max(0, idleSince(lastTouchedAt));
    const idleLimit = thread.weight === "major" ? staleAfter * MAJOR_STALE_FACTOR : staleAfter;
    const status = thread.closedAt !== undefined
      ? "closed"
      : thread.weight !== "minor" && idleChapters >= idleLimit
        ? "stale"
        : thread.touches.some((touch) => touch.op === "advance")
          ? "active"
          : "open";
    return {
      id: thread.id,
      type: thread.type,
      title: thread.title,
      openedAt: thread.openedAt,
      lastTouchedAt,
      idleChapters,
      ...(thread.closedAt !== undefined ? { closedAt: thread.closedAt, closedBy: thread.closedBy ?? "ledger" } : {}),
      status,
      weight: thread.weight,
      touches: thread.touches,
      mergedFrom: thread.mergedFrom,
    };
  });
  return { threads: views.sort((a, b) => a.openedAt - b.openedAt || a.id.localeCompare(b.id)), dangling };
}

function buildChapters(
  ledgers: readonly ChapterLedger[],
  names: Names,
  textHashes: ReadonlyMap<number, string> | undefined,
  decisions: readonly AuthorDecision[],
  time: TimeProjection,
): ChapterView[] {
  // 定稿后作者改写的梗概（同一章改过几次，按最后一次）。
  const summaryRulings = new Map<number, string>();
  for (const decision of decisions) if (decision.type === "chapter.summary") summaryRulings.set(decision.chapter, decision.text);
  return ledgers.map((ledger): ChapterView => {
    const missing = missingKindsOf(ledger);
    const ledgerSummary = ledger.entries.find((entry) => entry.kind === "summary");
    const summary = summaryRulings.get(ledger.chapter) ?? (ledgerSummary?.kind === "summary" ? ledgerSummary.text : undefined);
    const present: string[] = [];
    let viewpoint: string | undefined;
    for (const entry of ledger.entries) {
      if (entry.kind !== "presence") continue;
      const { name } = names.resolve(presenceName(entry));
      if (!present.includes(name)) present.push(name);
      if (entry.viewpoint && viewpoint === undefined) viewpoint = name;
    }
    const hash = textHashes?.get(ledger.chapter);
    return {
      chapter: ledger.chapter,
      origin: ledger.origin,
      committedAt: ledger.committedAt,
      ...(summary !== undefined ? { summary } : {}),
      ledgerStatus: ledger.status,
      ...(missing.length > 0 ? { missingKinds: missing } : {}),
      time: time.chapters.get(ledger.chapter) as ChapterView["time"],
      present,
      ...(viewpoint !== undefined ? { viewpoint } : {}),
      ...(textHashes ? (hash === undefined ? {} : { editedSinceCommit: hash !== ledger.textSha256 }) : {}),
      textMissing: textHashes ? hash === undefined : false,
    };
  });
}

export function project(input: ProjectionInput, options: ProjectionOptions = {}): BookProjection {
  const ledgers = [...input.ledgers]
    .filter((ledger) => options.upTo === undefined || ledger.chapter <= options.upTo)
    .sort((a, b) => a.chapter - b.chapter);
  const upTo = options.upTo ?? ledgers.at(-1)?.chapter ?? 0;
  const staleAfter = options.staleAfter ?? DEFAULT_STALE_AFTER;
  const dismissed = new Set(input.decisions.flatMap((decision) => (decision.type === "issue.dismiss" ? [decision.issue] : [])));

  const names = new Names();
  if (input.cards) names.addCards(input.cards);
  for (const ledger of ledgers) for (const entry of ledger.entries) if (entry.kind === "presence") names.addPresence(entry);

  const facts = buildFacts(ledgers, input.decisions, names, dismissed);
  const threads = buildThreads(ledgers, input.decisions, upTo, staleAfter);
  const time = projectTime(ledgers, input.decisions, input.cards?.calendar?.dayBoundary, dismissed);
  return {
    version: input.version ?? 0,
    upTo,
    unsettled: input.unsettled ?? false,
    chapters: buildChapters(ledgers, names, input.textHashes, input.decisions, time),
    facts: facts.facts,
    subjects: facts.subjects,
    threads: threads.threads,
    cast: buildCast(ledgers, names),
    conflicts: facts.conflicts,
    timeConflicts: time.conflicts,
    weekdayConflicts: time.weekdayConflicts,
    timeWorlds: time.worlds,
    dangling: [...facts.dangling, ...threads.dangling],
    dismissedIssues: [...dismissed],
  };
}
