/**
 * 声明 ↔ 账单条目（写作版本 P2b）：记账员、定稿清单交的是平铺的声明（`EntryInput`），账单里存的是带证据、来源这些格子的条目。
 * 两边只在这里换：存的时候按冻结正文算证据（哪一版、第几句），读回成声明（重定稿沿用上次的、出预览）也在这里。
 * 时间（P3a）：记账员的一条时间声明存成本章开头、整章同一天、各次换天、各段（段 + 段的时间）几条；作者定的天数另存
 * （开头、作者给了才有的结尾）。读回时各并成一条声明。旧账的时间（P2b 及更早）读回成同样的声明。
 */
import { createHash } from "node:crypto";
import {
  CHAPTER_LEDGER_SCHEMA,
  ChapterLedger,
  TIME_MODEL,
  UNITS_VERSION,
  timeRoleOf,
  type DayInput,
  type DeclaredSource,
  type EntryInput,
  type EntrySource,
  type Evidence,
  type EvidenceStatus,
  type FactInput,
  type LedgerCoverage,
  type LedgerEntry,
  type LedgerOrigin,
  type LedgerScene,
  type LedgerStatus,
  type LegacyTime,
  type PresenceInput,
  type Provenance,
  type SummaryInput,
  type ThreadInput,
  type SegmentInput,
  type TimeBasis,
  type TimeEntry,
  type TimeInput,
  type TimeModel,
  type UnitRange,
} from "../schema/ledger.js";
import { normalizedWithOrigin, quoteInText, quoteSegments } from "../text/quote.js";
import { splitUnits, type TextUnit } from "../text/units.js";

const sha256 = (text: string): string => createHash("sha256").update(text, "utf-8").digest("hex");

type Draft<T> = T extends { readonly quote: string } ? Omit<T, "quote"> & { readonly quote?: string } : T;
/** 声明，原句可以缺（老书导入的旧数据当年没存）。交给定稿命令的照旧是 EntryInput。 */
export type EntryDraft = Draft<SummaryInput> | Draft<FactInput> | Draft<ThreadInput> | TimeInput | DayInput | Draft<PresenceInput>;

/** 一章正文和它的切句（算证据用；同一章多条只切一次）。 */
export interface ChapterSource {
  readonly chapter: number;
  readonly text: string;
  readonly revision: string;
  readonly units: readonly TextUnit[];
}

export function chapterSource(chapter: number, text: string): ChapterSource {
  return { chapter, text, revision: sha256(text), units: splitUnits(text) };
}

const count = (haystack: string, needle: string): number => {
  let found = 0;
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) found += 1;
  return found;
};

/**
 * 原句在这版正文里在哪：找不到 → undefined；在、每一截在全文里都只有一处 → 第几句到第几句；在但不止一处（或落在章名行）→ 不给句号。
 * 不任选一处（契约第六节第 2 条）。
 */
export function locateQuote(quote: string, source: ChapterSource): { readonly units?: UnitRange } | undefined {
  if (!quoteInText(quote, source.text)) return undefined;
  const { haystack, origin } = normalizedWithOrigin(source.text);
  const segments = quoteSegments(quote);
  if (segments.some((segment) => count(haystack, segment) !== 1)) return {};
  const first = segments[0] as string;
  const last = segments.at(-1) as string;
  const start = origin[haystack.indexOf(first)] as number;
  const end = origin[haystack.indexOf(last) + last.length - 1] as number;
  const unitAt = (position: number): TextUnit | undefined => source.units.find((unit) => unit.start <= position && position < unit.end);
  const from = unitAt(start);
  const to = unitAt(end);
  return from && to && from.id <= to.id ? { units: { from: from.id, to: to.id } } : {};
}

/** 一条原句 → 证据和状态。没原句 → none；正文里找不到 → undefined（调用方定怎么办）。 */
export function evidenceFor(quote: string | undefined, source: ChapterSource): { readonly evidence: Evidence[]; readonly evidenceStatus: EvidenceStatus } | undefined {
  if (quote === undefined) return { evidence: [], evidenceStatus: "none" };
  const located = locateQuote(quote, source);
  if (!located) return undefined;
  const evidence: Evidence = { resource: { kind: "chapter", chapter: source.chapter }, revision: source.revision, ...(located.units ? { units: located.units } : {}), quote };
  return { evidence: [evidence], evidenceStatus: located.units ? "located" : "quoted" };
}

/** 存的时候分给这条的编号（新开的线索另有线索编号）。 */
export interface EntryIds {
  readonly id: string;
  readonly thread?: string;
}

/** 一条时间声明存出来的几条的编号：都跟着这条声明的编号走（重定稿沿用同一个号，后文引用接得上）。 */
export const chapterEndTimeId = (id: string): string => `${id}-end`;
const dayChangeId = (id: string, index: number): string => `${id}-d${index + 1}`;
const sceneId = (id: string, index: number): string => `${id}-s${index + 1}`;
const sceneTimeId = (id: string, index: number): string => `${id}-s${index + 1}-t`;

/** 存出来的：条目，和（时间声明才有的）段。 */
export interface StoredDeclaration {
  readonly entries: LedgerEntry[];
  readonly scenes: LedgerScene[];
}

const storedSource = (source: DeclaredSource | undefined): EntrySource =>
  source?.kind === "narration" ? { kind: "narration" } : source?.kind === "character_claim" ? { kind: "character_claim", ...(source.speaker ? { speaker: { mention: source.speaker } } : {}) } : { kind: "unknown" };

/**
 * 一条声明 → 账单条目（时间声明还有段）。原句按冻结正文算证据；正文里找不到的（不该发生：定稿前核过）记成没证据，
 * 整份账单校验时会如实拒掉。推进、收口没带线索编号的照旧交给校验拒。
 */
export function storeEntry(draft: EntryDraft, ids: EntryIds, source: ChapterSource, provenance: Provenance = "native"): StoredDeclaration {
  if (draft.kind === "time") return storeTime(draft, ids.id, source, provenance);
  const quote = "quote" in draft ? draft.quote : undefined;
  return { entries: storeWithProof(draft, ids, evidenceFor(quote, source) ?? { evidence: [], evidenceStatus: "none" }, provenance), scenes: [] };
}

type NonTimeDraft = Exclude<EntryDraft, TimeInput>;

/** 证据已经定好了的（迁移器按旧正文另定）：只换结构。时间声明走 storeEntry（要按正文定换天、段在哪）。 */
export function storeWithProof(draft: NonTimeDraft, ids: EntryIds, proof: { readonly evidence: Evidence[]; readonly evidenceStatus: EvidenceStatus }, provenance: Provenance): LedgerEntry[] {
  const base = { id: ids.id, review: draft.review, source: { kind: "unknown" as const }, transition: "unknown" as const, ...proof, provenance };
  switch (draft.kind) {
    case "summary":
      return [{ kind: "summary", ...base, text: draft.text }];
    case "fact":
      return [{
        kind: "fact",
        ...base,
        source: storedSource(draft.source),
        transition: draft.replaces ? "change" : "unknown",
        nature: draft.nature,
        ...(draft.subject ? { subjectRef: { mention: draft.subject } } : {}),
        ...(draft.attribute ? { predicate: draft.attribute } : {}),
        ...(draft.value ? { value: draft.value } : {}),
        text: draft.text,
        ...(draft.replaces ? { replaces: draft.replaces } : {}),
      }];
    case "thread":
      return [{
        kind: "thread",
        ...base,
        source: storedSource(draft.source),
        op: draft.op,
        threadRef: { id: (draft.op === "open" ? ids.thread : draft.thread) ?? "" },
        ...(draft.type ? { type: draft.type } : {}),
        ...(draft.title ? { title: draft.title } : {}),
        note: draft.note,
      }];
    case "presence":
      return [{
        kind: "presence",
        ...base,
        entityRef: { mention: draft.name },
        nameUsed: draft.nameUsed,
        ...(draft.viewpoint !== undefined ? { viewpoint: draft.viewpoint } : {}),
        ...(draft.generic !== undefined ? { generic: draft.generic } : {}),
      }];
    case "day":
      return storeDay(draft, { ...base, source: { kind: "author_ruling" } });
  }
}

type TimeBase = Pick<TimeEntry, "id" | "review" | "source" | "transition" | "evidence" | "evidenceStatus" | "provenance">;

/** 作者定的天数：开头那天；作者明确给了结尾才有结尾那条（= 开头就是明确同一天）。 */
function storeDay(draft: DayInput, base: TimeBase): TimeEntry[] {
  const common = { kind: "time" as const, ...base, review: "author" as const, relation: "at" as const, basis: "author" as const };
  return [
    { ...common, appliesTo: "chapterStart", day: draft.day },
    ...(draft.dayEnd !== undefined ? [{ ...common, id: chapterEndTimeId(base.id), appliesTo: "chapterEnd" as const, day: draft.dayEnd }] : []),
  ];
}

const NO_PROOF = { evidence: [] as Evidence[], evidenceStatus: "none" as const };
/** 原句对不上句子（定稿前已核过在正文里；没正文的预览）：认得出、不给句号，和别的条目一样。 */
const quotedOnly = (quote: string, source: ChapterSource) => ({
  evidence: [{ resource: { kind: "chapter" as const, chapter: source.chapter }, revision: source.revision, quote }] as Evidence[],
  evidenceStatus: "quoted" as const,
});

/** 编号上那一句还对得上原句：原句在正文里只有一处就要正落在这一句，有几处就要这一句里有（没原句不核）。 */
function unitAgrees(quote: string, unit: number, side: "from" | "to", source: ChapterSource): boolean {
  if (!quote) return true;
  const located = locateQuote(quote, source);
  if (!located) return false;
  if (located.units) return located.units[side] === unit;
  const at = source.units.find((item) => item.id === unit);
  return at !== undefined && quoteInText(quote, source.text.slice(at.start, at.end));
}

/**
 * 一段在正文里是第几句到第几句：给了编号、首末句也对得上那两句就用编号（补摘那步点的）；
 * 编号对不上原句（重定稿读回的是上一版正文的编号）就按原句重新找：首句、末句各自在正文里只有一处才算定位上。
 */
export function locateSegment(segment: Pick<SegmentInput, "firstQuote" | "lastQuote" | "units">, source: ChapterSource): UnitRange | string {
  const count = source.units.length;
  if (segment.units && segment.units.to <= count && unitAgrees(segment.firstQuote, segment.units.from, "from", source) && unitAgrees(segment.lastQuote, segment.units.to, "to", source)) {
    return segment.units;
  }
  if (segment.units && !segment.firstQuote && !segment.lastQuote) return "段的句子编号超出了本章";
  const first = locateQuote(segment.firstQuote, source);
  const last = locateQuote(segment.lastQuote, source);
  if (!first || !last) return "段的首句或末句在正文里找不到";
  if (!first.units || !last.units) return "段的首句或末句在正文里不止一处，定不了段在哪";
  if (first.units.from > last.units.to) return "段的首句在末句后面";
  return { from: first.units.from, to: last.units.to };
}

/**
 * 一条时间声明对着这版正文的问题（结构之外，checkEntries 用）：段要定位得上、互不重叠；没写本章开头的，段要盖住整章。
 */
export function timeDeclarationProblem(draft: TimeInput, source: ChapterSource): string | undefined {
  const ranges: UnitRange[] = [];
  for (const segment of draft.segments ?? []) {
    const located = locateSegment(segment, source);
    if (typeof located === "string") return located;
    ranges.push(located);
  }
  ranges.sort((a, b) => a.from - b.from);
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index]!.from <= ranges[index - 1]!.to) return "两段的句子重叠了";
  }
  if (draft.start === undefined) {
    let next = 1;
    for (const range of ranges) {
      if (range.from > next) break;
      next = Math.max(next, range.to + 1);
    }
    if (next <= source.units.length) return "没写本章开头，段却没盖住整章";
  }
  return undefined;
}

/** 记账员的时间声明 → 本章开头、整章同一天、各次换天、各段的时间几条 + 段。 */
function storeTime(draft: TimeInput, id: string, source: ChapterSource, provenance: Provenance): StoredDeclaration {
  const base = { kind: "time" as const, review: draft.review, source: { kind: "unknown" as const }, transition: "unknown" as const, provenance };
  const entries: TimeEntry[] = [];
  const marks = { ...(draft.weekday !== undefined ? { weekday: draft.weekday } : {}), ...(draft.timeOfDay ? { timeOfDay: draft.timeOfDay } : {}) };
  if (draft.start === "unknown") {
    entries.push({ ...base, id, ...NO_PROOF, relation: "unknown", appliesTo: "chapterStart", basis: "judged", ...marks });
  } else if (draft.start) {
    const proof = evidenceFor(draft.start.quote, source) ?? quotedOnly(draft.start.quote, source);
    entries.push({
      ...base,
      id,
      ...proof,
      relation: "offset",
      appliesTo: "chapterStart",
      anchor: "previousChapterEnd",
      ...(draft.start.offset ? { offset: draft.start.offset } : {}),
      ...(draft.start.byBoundary ? { byBoundary: draft.start.byBoundary } : {}),
      basis: draft.start.basis,
      ...marks,
    });
  }
  if (draft.sameDay === true) {
    entries.push({ ...base, id: chapterEndTimeId(id), ...NO_PROOF, relation: "offset", appliesTo: "chapterEnd", anchor: "chapterStart", offset: { unit: "day", min: 0, max: 0 }, basis: "judged" });
  }
  (draft.dayChanges ?? []).forEach((change, index) => {
    const proof = change.quote !== undefined ? (evidenceFor(change.quote, source) ?? quotedOnly(change.quote, source)) : NO_PROOF;
    entries.push({
      ...base,
      id: dayChangeId(id, index),
      ...proof,
      relation: "offset",
      appliesTo: "dayChange",
      anchor: "previousMoment",
      ...(change.offset ? { offset: change.offset } : {}),
      ...(change.byBoundary ? { byBoundary: change.byBoundary } : {}),
      basis: "judged",
    });
  });
  const located = (draft.segments ?? []).flatMap((segment, index) => {
    const units = locateSegment(segment, source);
    return typeof units === "string" ? [] : [{ segment, index, units }];
  });
  const order = [...located].sort((a, b) => a.units.from - b.units.from);
  const scenes: LedgerScene[] = located.map(({ segment, index, units }) => {
    const timeRefs: string[] = [];
    if (segment.frame === "past" && segment.when !== undefined) {
      const time = sceneTimeId(id, index);
      const anchor = draft.start === undefined ? "previousChapterEnd" : "chapterStart";
      entries.push(segment.when === "unknown"
        ? { ...base, id: time, ...NO_PROOF, relation: "unknown", appliesTo: "scene", basis: "judged" }
        : {
          ...base,
          id: time,
          ...NO_PROOF,
          relation: "offset",
          appliesTo: "scene",
          anchor,
          ...(segment.when.offset ? { offset: segment.when.offset } : {}),
          ...(segment.when.byBoundary ? { byBoundary: segment.when.byBoundary } : {}),
          basis: "judged",
        });
      timeRefs.push(time);
    }
    return {
      id: sceneId(id, index),
      units,
      order: order.findIndex((item) => item.index === index),
      timeRefs,
      frame: segment.frame,
      quotes: { first: unitText(source, units.from), last: unitText(source, units.to) },
    };
  });
  return { entries, scenes };
}

const unitText = (source: ChapterSource, id: number): string => source.units.find((unit) => unit.id === id)?.text ?? "";

/**
 * 旧账格式的时间（迁移器、老书导入用，设计 2.6、2.7）：作者定第几天 / 离上一章几天 / 不知道，外加本章内过了几天。
 * legacy：判成不可信、改成不知道的原值。
 */
export interface LegacyTimeDraft {
  readonly review: TimeEntry["review"];
  readonly basis: TimeBasis;
  readonly quote?: string;
  readonly day?: number;
  readonly daysSincePrevious?: number;
  readonly daysInChapter?: number;
  readonly weekday?: number;
  readonly timeOfDay?: string;
  readonly legacy?: LegacyTime;
}

export function storeLegacyTime(draft: LegacyTimeDraft, id: string, proof: { readonly evidence: Evidence[]; readonly evidenceStatus: EvidenceStatus }, provenance: Provenance): TimeEntry[] {
  const common = { kind: "time" as const, id, review: draft.review, source: { kind: "unknown" as const }, transition: "unknown" as const, ...proof, provenance, basis: draft.basis };
  const start: TimeEntry = draft.legacy
    ? { ...common, relation: "unknown", appliesTo: "chapterStart", legacy: draft.legacy }
    : draft.basis === "author" && draft.day !== undefined
      ? { ...common, relation: "at", appliesTo: "chapterStart", day: draft.day }
      : draft.daysSincePrevious !== undefined
        ? { ...common, relation: "offset", appliesTo: "chapterStart", anchor: "previousChapterEnd", offset: { unit: "day", min: draft.daysSincePrevious, max: draft.daysSincePrevious } }
        : { ...common, relation: "unknown", appliesTo: "chapterStart" };
  const withMarks: TimeEntry = { ...start, ...(draft.weekday !== undefined ? { weekday: draft.weekday } : {}), ...(draft.timeOfDay ? { timeOfDay: draft.timeOfDay } : {}) };
  if (draft.daysInChapter === undefined || draft.legacy) return [withMarks];
  return [withMarks, {
    ...common,
    id: chapterEndTimeId(id),
    relation: "offset",
    appliesTo: "chapterEnd",
    anchor: "chapterStart",
    offset: { unit: "day", min: draft.daysInChapter, max: draft.daysInChapter },
  }];
}

/** 读时间要的几样：条目、段、时间格式（缺 = 旧账）。 */
type TimeParts = { readonly entries: readonly LedgerEntry[]; readonly scenes?: readonly LedgerScene[]; readonly timeModel?: TimeModel };

/**
 * 本章记账员记的时间读回成一条声明（带它的编号）；没记 = undefined。旧账一样读：本章内过了几天读成一次换天（没附那句），
 * 估的、判成不可信的读成 unknown。作者定的天数不在这里（dayDeclarationOf）。
 */
export function timeDeclarationOf(ledger: TimeParts): (TimeInput & { readonly id: string }) | undefined {
  const times = ledger.entries.filter((entry): entry is TimeEntry => entry.kind === "time");
  const start = times.find((entry) => timeRoleOf(entry) === "start");
  const scenes = [...(ledger.scenes ?? [])].sort((a, b) => a.order - b.order);
  if (!start && scenes.length === 0) return undefined;
  const firstScene = scenes[0]?.id ?? "";
  const id = start?.id ?? firstScene.slice(0, Math.max(0, firstScene.lastIndexOf("-s")));
  const end = times.find((entry) => timeRoleOf(entry) === "end");
  const changes = times.filter((entry) => timeRoleOf(entry) === "dayChange");
  const relativeOf = (entry: TimeEntry) => ({ ...(entry.offset ? { offset: entry.offset } : {}), ...(entry.byBoundary ? { byBoundary: entry.byBoundary } : {}) });
  const startQuote = start?.evidence[0]?.quote;
  const startDecl: TimeInput["start"] = !start
    ? undefined
    : start.relation === "offset" && (start.basis === "text" || start.basis === "judged") && startQuote !== undefined
      ? { ...relativeOf(start), basis: start.basis, quote: startQuote }
      : "unknown";
  const endSpan = end?.offset?.min;
  const legacySpan = endSpan !== undefined && endSpan > 0 ? endSpan : undefined;
  return {
    id,
    kind: "time",
    review: start?.review ?? "auto",
    ...(startDecl !== undefined ? { start: startDecl } : {}),
    ...(end && endSpan === 0 ? { sameDay: true } : {}),
    ...(changes.length > 0 || legacySpan !== undefined
      ? {
        dayChanges: [
          ...changes.map((change) => ({ ...relativeOf(change), ...(change.evidence[0]?.quote !== undefined ? { quote: change.evidence[0].quote } : {}) })),
          ...(legacySpan !== undefined ? [{ offset: { unit: "day" as const, min: legacySpan, max: legacySpan } }] : []),
        ],
      }
      : {}),
    ...(scenes.length > 0
      ? {
        segments: scenes.map((scene) => {
          const when = times.find((entry) => entry.id === scene.timeRefs[0]);
          return {
            frame: scene.frame,
            firstQuote: scene.quotes.first,
            lastQuote: scene.quotes.last,
            ...(scene.stale ? {} : { units: scene.units }),
            ...(when ? { when: when.relation === "offset" ? relativeOf(when) : ("unknown" as const) } : {}),
          };
        }),
      }
      : {}),
    ...(start?.weekday !== undefined ? { weekday: start.weekday } : {}),
    ...(start?.timeOfDay ? { timeOfDay: start.timeOfDay } : {}),
  };
}

/**
 * 本章作者定的天数读回成一条声明（带编号）；没有 = undefined。旧账里作者定的只有开头那天、没写结尾的，
 * 当年的意思就是这一天（P2b 投影按同一天算），读回成明确同一天。
 */
export function dayDeclarationOf(ledger: TimeParts): (DayInput & { readonly id: string }) | undefined {
  const times = ledger.entries.filter((entry): entry is TimeEntry => entry.kind === "time");
  const start = times.find((entry) => timeRoleOf(entry) === "authorStart");
  if (!start || start.day === undefined) return undefined;
  const authorEnd = times.find((entry) => timeRoleOf(entry) === "authorEnd");
  const legacyEnd = times.find((entry) => timeRoleOf(entry) === "end");
  const dayEnd = authorEnd?.day ?? (ledger.timeModel === TIME_MODEL ? undefined : start.day + (legacyEnd?.offset?.min ?? 0));
  return { id: start.id, kind: "day", review: "author", day: start.day, ...(dayEnd !== undefined ? { dayEnd } : {}) };
}

/**
 * 账单条目读回成声明（重定稿沿用上次的开线索、天数，出预览用）：时间、作者定的天数各并成一条，排在开头那条的位置。
 * 原句缺了的（老书导入的）照样给出：交给 checkEntries 会如实拒掉。
 */
export function declarationsOf(ledger: TimeParts): EntryInput[] {
  const out: EntryInput[] = [];
  const time = timeDeclarationOf(ledger);
  const day = dayDeclarationOf(ledger);
  let timeDone = false;
  for (const entry of ledger.entries) {
    if (entry.kind === "time") {
      const role = timeRoleOf(entry);
      if (role === "authorStart" && day) {
        const { id: _id, ...rest } = day;
        out.push(rest);
      } else if (!timeDone && time && role !== "authorStart" && role !== "authorEnd") {
        const { id: _id, ...rest } = time;
        out.push(rest);
        timeDone = true;
      }
      continue;
    }
    const decl = declarationOf(entry);
    if (decl) out.push(decl);
  }
  if (!timeDone && time) {
    const { id: _id, ...rest } = time;
    out.push(rest);
  }
  return out;
}

/** 一条非时间的账单条目读回成声明（时间要整章一起读：timeDeclarationOf / dayDeclarationOf）。 */
export function declarationOf(entry: LedgerEntry): EntryInput | undefined {
  const quote = entry.evidence[0]?.quote;
  const q = quote !== undefined ? { quote } : {};
  const source = entry.source.kind === "narration"
    ? { source: { kind: "narration" as const } }
    : entry.source.kind === "character_claim"
      ? { source: { kind: "character_claim" as const, ...(entry.source.speaker ? { speaker: entry.source.speaker.mention } : {}) } }
      : {};
  switch (entry.kind) {
    case "summary":
      return { kind: "summary", review: entry.review, text: entry.text, ...q } as SummaryInput;
    case "fact":
      return {
        kind: "fact",
        review: entry.review,
        nature: entry.nature,
        ...(entry.subjectRef ? { subject: entry.subjectRef.mention } : {}),
        ...(entry.predicate ? { attribute: entry.predicate } : {}),
        ...(entry.value ? { value: entry.value } : {}),
        text: entry.text,
        ...q,
        ...(entry.replaces ? { replaces: entry.replaces } : {}),
        ...source,
      } as FactInput;
    case "thread":
      return {
        kind: "thread",
        review: entry.review,
        op: entry.op,
        ...(entry.type ? { type: entry.type } : {}),
        ...(entry.title ? { title: entry.title } : {}),
        note: entry.note,
        ...q,
        thread: entry.threadRef.id,
        ...source,
      } as ThreadInput;
    case "presence":
      return {
        kind: "presence",
        review: entry.review,
        name: entry.entityRef.mention,
        nameUsed: entry.nameUsed,
        ...(entry.viewpoint !== undefined ? { viewpoint: entry.viewpoint } : {}),
        ...(entry.generic !== undefined ? { generic: entry.generic } : {}),
        ...q,
      } as PresenceInput;
    case "time":
      return undefined;
  }
}

/** 同一版正文重算证据（改章名、定论改齐之后）：原句在新正文里的换成新一版的证据；不在的（作废了的事实、迁移来找不到的）原样留着。 */
export function relocateEvidence(entry: LedgerEntry, source: ChapterSource): LedgerEntry {
  const quote = entry.evidence[0]?.quote;
  if (quote === undefined) return entry;
  const proof = evidenceFor(quote, source);
  return proof ? { ...entry, ...proof } : entry;
}

/**
 * 段跟着换到新一版正文（改章名、定论改齐之后，设计第 6 节）：首句、末句在新正文里各只有一处就换成新的句号；
 * 对不回了标 stale（按「段未知」处理），不任选一处。replaced：首末句被改了的，换成改后那句（定论改齐给）。
 */
export function relocateScenes(scenes: readonly LedgerScene[], source: ChapterSource, replaced: (quote: string) => string = (quote) => quote): LedgerScene[] {
  return scenes.map((scene) => {
    const quotes = { first: replaced(scene.quotes.first), last: replaced(scene.quotes.last) };
    const units = locateSegment({ firstQuote: quotes.first, lastQuote: quotes.last }, source);
    if (typeof units === "string") return { ...scene, stale: true };
    const { stale: _stale, ...rest } = scene;
    return { ...rest, units, quotes };
  });
}

/**
 * 按声明直接拼一份账单（不核原句、不查前文、不过校验）：出预览、测试造书用。编号给了就用，没给按「c{章}-{第几条}」；
 * 新开线索没给编号按「t{章}-{n}」。给了正文就按它算证据；没给正文的原句照收（当成在那一版正文里、不给句号）。
 */
export function ledgerOf(input: {
  readonly chapter: number;
  readonly entries: readonly (EntryDraft & { readonly id?: string })[];
  readonly text?: string;
  readonly textSha256?: string;
  readonly origin?: LedgerOrigin;
  readonly committedAt?: string;
  readonly status?: LedgerStatus;
  readonly coverage?: Partial<LedgerCoverage>;
  readonly provenance?: Provenance;
}): ChapterLedger {
  const textSha256 = input.textSha256 ?? (input.text !== undefined ? sha256(input.text) : "0".repeat(64));
  const source = input.text !== undefined ? chapterSource(input.chapter, input.text) : undefined;
  const trusted = (quote: string | undefined): { evidence: Evidence[]; evidenceStatus: EvidenceStatus } => quote === undefined
    ? { evidence: [], evidenceStatus: "none" }
    : { evidence: [{ resource: { kind: "chapter", chapter: input.chapter }, revision: textSha256, quote }], evidenceStatus: "quoted" };
  let threads = 0;
  const scenes: LedgerScene[] = [];
  const entries = input.entries.flatMap((draft, index) => {
    const { id: given, ...declared } = draft;
    const id = given ?? `c${input.chapter}-${index + 1}`;
    if (declared.kind === "time") {
      // 没给正文：照声明里的原句、段编号拼（段必须给编号）。
      const stored = storeTime(declared, id, source ?? untextedSource(input.chapter, textSha256, declared), input.provenance ?? "native");
      scenes.push(...stored.scenes);
      return stored.entries;
    }
    const thread = declared.kind === "thread" && declared.op === "open" ? (declared.thread ?? `t${input.chapter}-${(threads += 1)}`) : undefined;
    const quote = "quote" in declared ? declared.quote : undefined;
    const proof = (source ? evidenceFor(quote, source) : undefined) ?? trusted(quote);
    return storeWithProof(declared as NonTimeDraft, { id, ...(thread ? { thread } : {}) }, proof, input.provenance ?? "native");
  });
  return {
    schema: CHAPTER_LEDGER_SCHEMA,
    chapter: input.chapter,
    textSha256,
    committedAt: input.committedAt ?? new Date(0).toISOString(),
    origin: input.origin ?? "commit",
    status: input.status ?? "ready",
    coverage: { ...EMPTY_COVERAGE, ...input.coverage },
    unitsVersion: UNITS_VERSION,
    timeModel: TIME_MODEL,
    scenes,
    entries,
  };
}

/**
 * 没有正文时拼账用的「正文」：每句原句当一句（只够 storeTime 定位换天、段用；段在声明里给了编号的照编号）。
 * 只给 ledgerOf（出预览、测试造书）用。
 */
function untextedSource(chapter: number, revision: string, draft: TimeInput): ChapterSource {
  const quotes = [
    ...(draft.start && draft.start !== "unknown" ? [draft.start.quote] : []),
    ...(draft.dayChanges ?? []).flatMap((change) => (change.quote !== undefined ? [change.quote] : [])),
    ...(draft.segments ?? []).flatMap((segment) => [segment.firstQuote, segment.lastQuote]),
  ];
  const max = Math.max(0, ...(draft.segments ?? []).map((segment) => segment.units?.to ?? 0));
  const lines = [...new Set(quotes)];
  while (lines.length < max) lines.push(`（第 ${lines.length + 1} 句）`);
  const text = lines.join("\n");
  return { ...chapterSource(chapter, text), revision };
}

export const EMPTY_COVERAGE: LedgerCoverage = { missingKinds: [], rejectedCount: 0, reasonCodes: [], omittedUnits: [] };

/** 拼一份账单（格式、切句版本、场景这些固定的格子在这里填，不各写各的），整份过校验。 */
export function newLedger(input: {
  readonly chapter: number;
  readonly textSha256: string;
  readonly committedAt: string;
  readonly origin: LedgerOrigin;
  readonly entries: readonly LedgerEntry[];
  readonly status?: LedgerStatus;
  readonly coverage?: Partial<LedgerCoverage>;
  readonly acceptedBasis?: string;
  readonly previous?: ChapterLedger["previous"];
  readonly legacy?: ChapterLedger["legacy"];
  readonly scenes?: readonly LedgerScene[];
  /** 旧账格式（迁移器、老书导入）：不带 timeModel、不切段。缺 = P3 起的新账。 */
  readonly legacyTime?: true;
}): ReturnType<typeof ChapterLedger.safeParse> {
  return ChapterLedger.safeParse({
    schema: CHAPTER_LEDGER_SCHEMA,
    chapter: input.chapter,
    textSha256: input.textSha256,
    committedAt: input.committedAt,
    origin: input.origin,
    status: input.status ?? "ready",
    coverage: { ...EMPTY_COVERAGE, ...input.coverage },
    ...(input.acceptedBasis ? { acceptedBasis: input.acceptedBasis } : {}),
    unitsVersion: UNITS_VERSION,
    ...(input.legacyTime ? {} : { timeModel: TIME_MODEL }),
    scenes: input.scenes ?? [],
    entries: input.entries,
    ...(input.previous ? { previous: input.previous } : {}),
    ...(input.legacy ? { legacy: input.legacy } : {}),
  });
}
