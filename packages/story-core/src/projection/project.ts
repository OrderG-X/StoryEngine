/**
 * 从真相算投影。纯函数：同样的账单和裁定，算出来一模一样；改了哪一章，整份重算即可。
 *
 * 不做增量：200 章、每章几十条，全量重算在几十毫秒内（见 project.test 的量级测试），
 * 增量缓存带来的「从中间算和从头算不一致」风险不值得。P7 实测慢了再说。
 *
 * 规则全是确定性的，不读正文、不判断意思：
 *  - 名字：出场条目里「正文用的称呼 ≠ 已确立名字」就是别名；主体名先过别名表再比。
 *  - 状态（state）：同一主体同一方面，后一章的值顶替前一章的。
 *  - 不会变的（hard）：只有明写推翻（replaces）才作废；值不同又没推翻 = 矛盾，交给作者。
 *  - 线索：开 / 推进 / 收按章序；收了又推进 = 重新打开；作者的归并、收口、分量最后套上。
 *  - 时间：作者定的 > 隔几天 > 上一章 +1（标 missing，要确认）；星期从最近的明写星期推。
 */
import type { AuthorDecision } from "../schema/decisions.js";
import type { ChapterLedger, FactEntry, PresenceEntry, ThreadEntry, TimeEntry } from "../schema/ledger.js";
import { nameKey } from "../text/quote.js";
import type {
  BookProjection,
  CastMember,
  ChapterView,
  ConflictView,
  DanglingView,
  FactView,
  SubjectAttributeView,
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
}

export interface ProjectionOptions {
  /** 只算到第几章（含）。缺省 = 全部。 */
  readonly upTo?: number;
  /** 线索多少章没动算「停太久」。缺省 5。 */
  readonly staleAfter?: number;
}

export const DEFAULT_STALE_AFTER = 5;

const mod7 = (value: number): number => ((value % 7) + 7) % 7;

/** 别名表：称呼键 → 已确立名字键。跟着链走到底，防环。 */
class Names {
  private readonly aliasTo = new Map<string, string>();
  private readonly display = new Map<string, string>();

  addPresence(entry: PresenceEntry): void {
    const name = nameKey(entry.name);
    const used = nameKey(entry.nameUsed);
    if (!this.display.has(name)) this.display.set(name, entry.name);
    if (used !== name && !this.aliasTo.has(used)) this.aliasTo.set(used, name);
  }

  resolve(raw: string): { readonly key: string; readonly name: string } {
    let key = nameKey(raw);
    const seen = new Set<string>([key]);
    for (let next = this.aliasTo.get(key); next !== undefined && !seen.has(next); next = this.aliasTo.get(key)) {
      seen.add(next);
      key = next;
    }
    return { key, name: this.display.get(key) ?? raw };
  }
}

function buildCast(ledgers: readonly ChapterLedger[], names: Names): CastMember[] {
  const members = new Map<string, { name: string; aliases: Set<string>; chapters: Set<number>; viewpoint: Set<number> }>();
  for (const ledger of ledgers) {
    for (const entry of ledger.entries) {
      if (entry.kind !== "presence") continue;
      const { key, name } = names.resolve(entry.name);
      let member = members.get(key);
      if (!member) {
        member = { name, aliases: new Set(), chapters: new Set(), viewpoint: new Set() };
        members.set(key, member);
      }
      if (nameKey(entry.nameUsed) !== key) member.aliases.add(entry.nameUsed);
      member.chapters.add(ledger.chapter);
      if (entry.viewpoint) member.viewpoint.add(ledger.chapter);
    }
  }
  return [...members.entries()]
    .map(([key, member]) => ({
      key,
      name: member.name,
      aliases: [...member.aliases],
      chapters: [...member.chapters].sort((a, b) => a - b),
      viewpointChapters: [...member.viewpoint].sort((a, b) => a - b),
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
  const retracted = new Set(decisions.flatMap((decision) => (decision.type === "fact.retract" ? [decision.fact] : [])));
  const byId = new Map<string, MutableFact>();
  const ordered: MutableFact[] = [];
  const currentState = new Map<string, string>();
  const currentHard = new Map<string, string[]>();
  const conflicts: ConflictView[] = [];
  const dangling: DanglingView[] = [];
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

  for (const ledger of ledgers) {
    for (const entry of ledger.entries) {
      if (entry.kind !== "fact") continue;
      const fact = toFactView(entry, ledger.chapter, names, retracted.has(entry.id));
      byId.set(fact.id, fact);
      ordered.push(fact);
      if (fact.status === "retracted") continue;

      if (entry.replaces) {
        const target = byId.get(entry.replaces);
        if (!target || target.chapter >= ledger.chapter) {
          dangling.push({ kind: "fact", ref: entry.replaces, chapter: ledger.chapter, source: entry.id });
        } else if (target.status === "current") {
          supersede(target, ledger.chapter, fact.id);
        }
      }
      if (fact.nature === "event" || fact.attributeKey === undefined) continue;

      const key = `${fact.subjectKey}|${fact.attributeKey}`;
      let subject = subjects.get(fact.subjectKey);
      if (!subject) {
        subject = { name: fact.subject, attrs: new Map() };
        subjects.set(fact.subjectKey, subject);
      }
      let attr = subject.attrs.get(fact.attributeKey);
      if (!attr) {
        attr = { attribute: fact.attribute ?? fact.attributeKey, nature: fact.nature, history: [] };
        subject.attrs.set(fact.attributeKey, attr);
      }
      attr.history.push(fact.id);

      if (fact.nature === "state") {
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
        const issue = `hard-fact:${otherId}:${fact.id}`;
        if (dismissed.has(issue)) continue;
        conflicts.push({ key: issue, kind: "hard-fact", subject: fact.subject, attribute: fact.attribute ?? "", facts: [otherId, fact.id] });
      }
      currentHard.set(key, [...list, fact.id]);
    }
  }

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
  return { facts: ordered, subjects: subjectViews, conflicts, dangling };
}

function toFactView(entry: FactEntry, chapter: number, names: Names, retracted: boolean): MutableFact {
  const subject = names.resolve(entry.subject);
  return {
    id: entry.id,
    chapter,
    nature: entry.nature,
    subject: subject.name,
    subjectKey: subject.key,
    ...(entry.attribute ? { attribute: entry.attribute, attributeKey: nameKey(entry.attribute) } : {}),
    ...(entry.value ? { value: entry.value } : {}),
    text: entry.text,
    ...(entry.quote ? { quote: entry.quote } : {}),
    review: entry.review,
    status: retracted ? "retracted" : "current",
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

function touchOf(entry: ThreadEntry, chapter: number): ThreadTouch {
  return { chapter, op: entry.op, note: entry.note, ...(entry.quote ? { quote: entry.quote } : {}), entry: entry.id };
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
      if (threads.has(entry.thread)) {
        dangling.push({ kind: "thread", ref: entry.thread, chapter: ledger.chapter, source: entry.id });
        continue;
      }
      threads.set(entry.thread, {
        id: entry.thread,
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
      const thread = threads.get(entry.thread);
      if (!thread) {
        dangling.push({ kind: "thread", ref: entry.thread, chapter: ledger.chapter, source: entry.id });
        continue;
      }
      thread.touches.push(touchOf(entry, ledger.chapter));
      if (entry.op === "close") {
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

  const views = [...threads.values()].map((thread): ThreadView => {
    const lastTouchedAt = Math.max(thread.openedAt, ...thread.touches.map((touch) => touch.chapter));
    const status = thread.closedAt !== undefined
      ? "closed"
      : thread.weight !== "minor" && upTo - lastTouchedAt >= staleAfter
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
): ChapterView[] {
  const views: ChapterView[] = [];
  let previousEnd = 0;
  for (const ledger of ledgers) {
    const time = ledger.entries.find((entry): entry is TimeEntry => entry.kind === "time");
    const summary = ledger.entries.find((entry) => entry.kind === "summary");
    let day: number;
    let basis: ChapterView["dayBasis"];
    if (time?.basis === "author" && time.day !== undefined) {
      day = time.day;
      basis = "author";
    } else if (time?.daysSincePrevious !== undefined) {
      day = Math.max(1, previousEnd + time.daysSincePrevious);
      basis = time.basis;
    } else {
      day = previousEnd + 1;
      basis = time ? time.basis : "missing";
    }
    const dayEnd = day + (time?.daysInChapter ?? 0);
    previousEnd = dayEnd;

    const present: string[] = [];
    let viewpoint: string | undefined;
    for (const entry of ledger.entries) {
      if (entry.kind !== "presence") continue;
      const { name } = names.resolve(entry.name);
      if (!present.includes(name)) present.push(name);
      if (entry.viewpoint && viewpoint === undefined) viewpoint = name;
    }
    const hash = textHashes?.get(ledger.chapter);
    views.push({
      chapter: ledger.chapter,
      origin: ledger.origin,
      committedAt: ledger.committedAt,
      ...(summary?.kind === "summary" ? { summary: summary.text } : {}),
      day,
      dayEnd,
      dayBasis: basis,
      ...(time?.weekday !== undefined ? { weekday: time.weekday } : {}),
      weekdayDerived: false,
      ...(time?.timeOfDay ? { timeOfDay: time.timeOfDay } : {}),
      present,
      ...(viewpoint !== undefined ? { viewpoint } : {}),
      ...(textHashes ? (hash === undefined ? {} : { editedSinceCommit: hash !== ledger.textSha256 }) : {}),
      textMissing: textHashes ? hash === undefined : false,
    });
  }
  // 星期：没明写的，从天数最近的一个明写星期推。
  const anchors = views.filter((view) => view.weekday !== undefined);
  if (anchors.length === 0) return views;
  return views.map((view) => {
    if (view.weekday !== undefined) return view;
    let best = anchors[0] as ChapterView;
    for (const anchor of anchors) if (Math.abs(anchor.day - view.day) < Math.abs(best.day - view.day)) best = anchor;
    return { ...view, weekday: mod7((best.weekday as number) + view.day - best.day), weekdayDerived: true };
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
  for (const ledger of ledgers) for (const entry of ledger.entries) if (entry.kind === "presence") names.addPresence(entry);

  const facts = buildFacts(ledgers, input.decisions, names, dismissed);
  const threads = buildThreads(ledgers, input.decisions, upTo, staleAfter);
  return {
    version: input.version ?? 0,
    upTo,
    unsettled: input.unsettled ?? false,
    chapters: buildChapters(ledgers, names, input.textHashes),
    facts: facts.facts,
    subjects: facts.subjects,
    threads: threads.threads,
    cast: buildCast(ledgers, names),
    conflicts: facts.conflicts,
    dangling: [...facts.dangling, ...threads.dangling],
    dismissedIssues: [...dismissed],
  };
}
