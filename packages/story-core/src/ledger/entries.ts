/**
 * 声明 ↔ 账单条目（写作版本 P2b）：记账员、定稿清单交的是平铺的声明（`EntryInput`），账单里存的是带证据、来源这些格子的条目。
 * 两边只在这里换：存的时候按冻结正文算证据（哪一版、第几句），读回成声明（重定稿沿用上次的、出预览）也在这里。
 * 时间：一条声明（离上一章几天、本章内过几天）存成本章开头一条 + 本章结尾一条（有本章内天数才有），读回时并成一条。
 */
import { createHash } from "node:crypto";
import {
  CHAPTER_LEDGER_SCHEMA,
  ChapterLedger,
  UNITS_VERSION,
  type EntryInput,
  type Evidence,
  type EvidenceStatus,
  type FactInput,
  type LedgerCoverage,
  type LedgerEntry,
  type LedgerOrigin,
  type LedgerStatus,
  type PresenceInput,
  type Provenance,
  type SummaryInput,
  type ThreadInput,
  type TimeEntry,
  type TimeInput,
  type UnitRange,
} from "../schema/ledger.js";
import { normalizedWithOrigin, quoteInText, quoteSegments } from "../text/quote.js";
import { splitUnits, type TextUnit } from "../text/units.js";

const sha256 = (text: string): string => createHash("sha256").update(text, "utf-8").digest("hex");

type Draft<T> = T extends { readonly quote: string } ? Omit<T, "quote"> & { readonly quote?: string } : T;
/** 声明，原句可以缺（老书导入的旧数据当年没存）。交给定稿命令的照旧是 EntryInput。 */
export type EntryDraft = Draft<SummaryInput> | Draft<FactInput> | Draft<ThreadInput> | TimeInput | Draft<PresenceInput>;

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

/** 本章结尾那条时间的编号：跟着本章开头那条走。 */
export const chapterEndTimeId = (id: string): string => `${id}-end`;

/**
 * 一条声明 → 账单条目（时间可能是两条）。原句按冻结正文算证据；正文里找不到的（不该发生：定稿前核过）记成没证据，
 * 整份账单校验时会如实拒掉。推进、收口没带线索编号的照旧交给校验拒。
 */
export function storeEntry(draft: EntryDraft, ids: EntryIds, source: ChapterSource, provenance: Provenance = "native"): LedgerEntry[] {
  const quote = "quote" in draft ? draft.quote : undefined;
  return storeWithProof(draft, ids, evidenceFor(quote, source) ?? { evidence: [], evidenceStatus: "none" }, provenance);
}

/** 证据已经定好了的（迁移器按旧正文另定）：只换结构。 */
export function storeWithProof(draft: EntryDraft, ids: EntryIds, proof: { readonly evidence: Evidence[]; readonly evidenceStatus: EvidenceStatus }, provenance: Provenance): LedgerEntry[] {
  const base = { id: ids.id, review: draft.review, source: { kind: "unknown" as const }, transition: "unknown" as const, ...proof, provenance };
  switch (draft.kind) {
    case "summary":
      return [{ kind: "summary", ...base, text: draft.text }];
    case "fact":
      return [{
        kind: "fact",
        ...base,
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
    case "time":
      return storeTime(draft, base);
  }
}

type TimeBase = Pick<TimeEntry, "id" | "review" | "source" | "transition" | "evidence" | "evidenceStatus" | "provenance">;

function storeTime(draft: TimeInput, base: TimeBase): TimeEntry[] {
  const common = { kind: "time" as const, ...base, basis: draft.basis };
  const start: TimeEntry = draft.basis === "author" && draft.day !== undefined
    ? { ...common, relation: "at", appliesTo: "chapterStart", day: draft.day }
    : draft.daysSincePrevious !== undefined
      ? { ...common, relation: "offset", appliesTo: "chapterStart", anchor: "previousChapterEnd", offset: { unit: "day", min: draft.daysSincePrevious, max: draft.daysSincePrevious } }
      : { ...common, relation: "unknown", appliesTo: "chapterStart" };
  const withMarks: TimeEntry = { ...start, ...(draft.weekday !== undefined ? { weekday: draft.weekday } : {}), ...(draft.timeOfDay ? { timeOfDay: draft.timeOfDay } : {}) };
  if (draft.daysInChapter === undefined) return [withMarks];
  const end: TimeEntry = {
    ...common,
    id: chapterEndTimeId(base.id),
    relation: "offset",
    appliesTo: "chapterEnd",
    anchor: "chapterStart",
    offset: { unit: "day", min: draft.daysInChapter, max: draft.daysInChapter },
  };
  return [withMarks, end];
}

/** 本章的时间（开头那条 + 结尾那条），读回成一条声明（带开头那条的编号）。没记时间 = undefined。 */
export function timeDeclarationOf(entries: readonly LedgerEntry[]): (TimeInput & { readonly id: string }) | undefined {
  const start = entries.find((entry): entry is TimeEntry => entry.kind === "time" && entry.appliesTo === "chapterStart");
  if (!start) return undefined;
  const end = entries.find((entry): entry is TimeEntry => entry.kind === "time" && entry.appliesTo === "chapterEnd");
  const quote = start.evidence[0]?.quote;
  return {
    id: start.id,
    kind: "time",
    review: start.review,
    basis: start.basis,
    ...(quote !== undefined ? { quote } : {}),
    ...(start.relation === "at" && start.day !== undefined ? { day: start.day } : {}),
    ...(start.relation === "offset" && start.offset ? { daysSincePrevious: start.offset.min } : {}),
    ...(end?.relation === "offset" && end.offset ? { daysInChapter: end.offset.min } : {}),
    ...(start.weekday !== undefined ? { weekday: start.weekday } : {}),
    ...(start.timeOfDay ? { timeOfDay: start.timeOfDay } : {}),
  };
}

/**
 * 账单条目读回成声明（重定稿沿用上次的开线索、天数，出预览用）：时间两条并成一条，排在开头那条的位置。
 * 原句缺了的（老书导入的）照样给出：交给 checkEntries 会如实拒掉。
 */
export function declarationsOf(entries: readonly LedgerEntry[]): EntryInput[] {
  const out: EntryInput[] = [];
  for (const entry of entries) {
    const decl = declarationOf(entry, entries);
    if (decl) out.push(decl);
  }
  return out;
}

/** 一条账单条目读回成声明；本章结尾那条时间并进开头那条（返回 undefined）。 */
export function declarationOf(entry: LedgerEntry, all: readonly LedgerEntry[] = [entry]): EntryInput | undefined {
  const quote = entry.evidence[0]?.quote;
  const q = quote !== undefined ? { quote } : {};
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
    case "time": {
      if (entry.appliesTo !== "chapterStart") return undefined;
      const time = timeDeclarationOf(all.includes(entry) ? all : [entry]);
      if (!time) return undefined;
      const { id: _id, ...rest } = time;
      return rest;
    }
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
  const entries = input.entries.flatMap((draft, index) => {
    const { id, ...declared } = draft;
    const thread = declared.kind === "thread" && declared.op === "open" ? (declared.thread ?? `t${input.chapter}-${(threads += 1)}`) : undefined;
    const quote = "quote" in declared ? declared.quote : undefined;
    const proof = (source ? evidenceFor(quote, source) : undefined) ?? trusted(quote);
    return storeWithProof(declared as EntryDraft, { id: id ?? `c${input.chapter}-${index + 1}`, ...(thread ? { thread } : {}) }, proof, input.provenance ?? "native");
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
    scenes: [],
    entries,
  };
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
  readonly legacy?: ChapterLedger["legacy"];
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
    scenes: [],
    entries: input.entries,
    ...(input.legacy ? { legacy: input.legacy } : {}),
  });
}
