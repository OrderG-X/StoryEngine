/**
 * 老书数据 → 章节账单（origin = import）。纯函数：同样的老数据和正文，生成一模一样的账单。
 *
 * 映射规则见 docs/rebuild/P2-core-design.md 第五节。几条要点：
 *  - 只给有正文的章生成账单；指向没有正文的章的老数据跳过并记下。
 *  - 老数据带的原句先核一遍，在本章正文里找不到就去掉原句（条目照记），计数如实报。
 *  - 老事实编号沿用（后文的推翻链要接得上）；其余条目编号 c{章}-{n}。
 *  - 老的「作废」链改写成新那条的 replaces；只说作废、没说被谁取代的，导入成作者裁定 fact.expire（老账里这种只有手动作废才会有）。
 *  - 故事天数：按老时间线逐章算出「隔几天」（import/legacy-time.ts，和盘点同一条规则）：作者定的照留；估的、比上一章早的
 *    （没法判断是倒叙还是记错）和紧跟它们的下一章记成不知道，原值留着给作者看。
 */
import type { ChapterLedger, EntryKind, LedgerEntry, ThreadType } from "../schema/ledger.js";
import { chapterSource, evidenceFor, newLedger, storeEntry, storeLegacyTime, type EntryDraft, type LegacyTimeDraft } from "../ledger/entries.js";
import { nameKey, quoteInText } from "../text/quote.js";
import { LEGACY_FILES, type ImportSkip, type LegacyData } from "./legacy.js";
import { legacyTimelineRow, legacyTimeOf } from "./legacy-time.js";

export interface ImportAdjustment {
  readonly file: string;
  readonly item: string;
  readonly change: string;
}

export interface ImportCounts {
  readonly chapters: number;
  readonly facts: number;
  readonly threadsOpened: number;
  readonly threadAdvances: number;
  readonly threadsClosed: number;
  readonly times: number;
  readonly summaries: number;
  readonly presences: number;
  /** 老数据带了原句、但在正文里找不到，去掉了原句的条数。 */
  readonly quotesDropped: number;
  /** 老事实没有 kind（老账本都没有），按「发生过的事」记的条数。 */
  readonly factsWithoutKind: number;
}

export interface ImportExpiry {
  readonly fact: string;
  readonly chapter: number;
}

export interface ImportBuild {
  readonly ledgers: readonly ChapterLedger[];
  /** 老账里手动作废、没写被谁取代的事实：导入成作者裁定「从第几章起不再成立」。 */
  readonly expiries: readonly ImportExpiry[];
  /** 老账里的主线目标（scope = main_arc）：导入成作者裁定「这条重要」。 */
  readonly majorThreads: readonly string[];
  readonly counts: ImportCounts;
  readonly skipped: readonly ImportSkip[];
  readonly adjusted: readonly ImportAdjustment[];
}

/** 老数据里的一条（老事实沿用老编号；线索的老编号在 thread 上）。时间是旧账格式（storeLegacyTime）。 */
type Draft = (Exclude<EntryDraft, { readonly kind: "time" | "day" }> | (LegacyTimeDraft & { readonly kind: "time" })) & { readonly id?: string };

const SECTION_ORDER: Record<EntryKind, number> = { summary: 0, time: 1, presence: 2, fact: 3, thread: 4 };
const THREAD_OP_ORDER = { open: 0, advance: 1, close: 2 } as const;

export function buildImportLedgers(data: LegacyData, texts: ReadonlyMap<number, string>, committedAt: string): ImportBuild {
  const skipped: ImportSkip[] = [...data.skipped];
  const adjusted: ImportAdjustment[] = [];
  const drafts = new Map<number, Draft[]>();
  let quotesDropped = 0;
  let factsWithoutKind = 0;

  const place = (chapter: number, draft: Draft, file: string, item: number | string): boolean => {
    if (!texts.has(chapter)) {
      skipped.push({ file, item, reason: `第 ${chapter} 章没有正文` });
      return false;
    }
    const list = drafts.get(chapter) ?? [];
    list.push(draft);
    drafts.set(chapter, list);
    return true;
  };
  /** 核原句：在本章正文里就留着，否则去掉（计数）。 */
  const verified = (chapter: number, quote: string | undefined): { quote?: string } => {
    if (!quote || quote.trim().length === 0) return {};
    const text = texts.get(chapter);
    if (text !== undefined && quoteInText(quote, text)) return { quote: quote.trim() };
    quotesDropped += 1;
    return {};
  };
  /** 一串证据里第一句在本章正文里的。 */
  const firstEvidenceIn = (chapter: number, evidence: readonly string[] | undefined): { quote?: string } => {
    const text = texts.get(chapter);
    const hit = text === undefined ? undefined : evidence?.find((item) => item.trim().length > 0 && quoteInText(item, text));
    return hit ? { quote: hit.trim() } : {};
  };

  // —— 事实 ——
  const factIds = new Set<string>();
  const factChapter = new Map(data.facts.map((fact) => [fact.id, fact.chapter]));
  const replacesOf = new Map<string, string[]>();
  const expiries: ImportExpiry[] = [];
  for (const fact of data.facts) {
    const by = fact.supersededByFactId;
    if (by === undefined) {
      if (fact.supersededByChapter !== undefined && fact.supersededByChapter > fact.chapter && texts.has(fact.chapter)) {
        expiries.push({ fact: fact.id, chapter: fact.supersededByChapter });
      }
      continue;
    }
    const byChapter = factChapter.get(by);
    if (byChapter === undefined || byChapter <= fact.chapter) {
      adjusted.push({ file: LEGACY_FILES.facts, item: fact.id, change: "旧账写的取代它的那条不存在或不在它后面；新账里它照旧有效" });
      continue;
    }
    replacesOf.set(by, [...(replacesOf.get(by) ?? []), fact.id]);
  }
  data.facts.forEach((fact, index) => {
    if (factIds.has(fact.id)) {
      skipped.push({ file: LEGACY_FILES.facts, item: index, reason: `编号重复：${fact.id}` });
      return;
    }
    factIds.add(fact.id);
    const typed = fact.kind === "hard" || fact.kind === "state";
    const complete = Boolean(fact.subject?.trim() && fact.attribute?.trim() && fact.value?.trim());
    const nature: "hard" | "state" | "event" = typed && complete ? (fact.kind as "hard" | "state") : "event";
    const replaces = replacesOf.get(fact.id);
    const placed = place(fact.chapter, {
      kind: "fact",
      id: fact.id,
      review: fact.source === "manual" ? "author" : "auto",
      nature,
      ...(fact.subject?.trim() ? { subject: fact.subject.trim() } : {}),
      ...(nature !== "event" ? { attribute: (fact.attribute as string).trim(), value: (fact.value as string).trim() } : {}),
      text: fact.text,
      ...verified(fact.chapter, fact.quote),
      ...(replaces ? { replaces } : {}),
    }, LEGACY_FILES.facts, index);
    if (!placed) return;
    if (typed && !complete) adjusted.push({ file: LEGACY_FILES.facts, item: fact.id, change: "缺谁 / 哪方面 / 是什么，按发生过的事记" });
    if (fact.kind === undefined) factsWithoutKind += 1;
  });

  // —— 线索：threads（lead / intent）、hooks、arc-goals 合成一种 ——
  interface ThreadSource {
    readonly file: string;
    readonly index: number;
    readonly id: string;
    readonly type: ThreadType;
    readonly title: string;
    readonly note: string;
    readonly first: number;
    readonly last?: number;
    readonly closeAt?: number;
    readonly closeNote?: string;
    readonly evidence?: readonly string[];
    readonly major?: boolean;
  }
  // 老账的 stale：线索是清理工具判成没用、或合并时被并掉的；打算是放了几章没动、过期的；目标是搁置了的。
  // 老代码一律不再当开着的读，导入成在最后一次提到的那章收掉（后文再推进，投影会重新打开）。
  const STALE_NOTE = "旧账：不再追踪了";
  const sources: ThreadSource[] = [];
  data.threads.forEach((thread, index) => sources.push({
    file: LEGACY_FILES.threads,
    index,
    id: thread.id,
    type: thread.type === "intent" ? "intent" : "question",
    title: thread.title,
    note: thread.title,
    first: thread.firstSeenChapter,
    ...(thread.lastTouchedChapter !== undefined ? { last: thread.lastTouchedChapter } : {}),
    ...(thread.status === "done" || thread.status === "stale" ? { closeAt: thread.lastTouchedChapter ?? thread.firstSeenChapter } : {}),
    ...(thread.status === "stale" ? { closeNote: STALE_NOTE } : {}),
    ...(thread.evidence ? { evidence: thread.evidence } : {}),
  }));
  data.hooks.forEach((hook, index) => {
    const closeAt = hook.resolvedAtChapter ?? hook.lastTouchedChapter ?? hook.firstSeenChapter;
    sources.push({
      file: LEGACY_FILES.hooks,
      index,
      id: hook.id,
      type: "question",
      title: hook.title,
      note: hook.description?.trim() || hook.title,
      first: hook.firstSeenChapter,
      ...(hook.lastTouchedChapter !== undefined ? { last: hook.lastTouchedChapter } : {}),
      ...(hook.status === "resolved" ? { closeAt } : {}),
      ...(hook.status === "abandoned" ? { closeAt, closeNote: "旧账：放弃了" } : {}),
      ...(hook.evidence ? { evidence: hook.evidence } : {}),
    });
  });
  data.goals.forEach((goal, index) => sources.push({
    file: LEGACY_FILES.goals,
    index,
    id: goal.id,
    type: "goal",
    title: goal.title,
    note: goal.title,
    first: goal.firstSeenChapter,
    ...(goal.lastTouchedChapter !== undefined ? { last: goal.lastTouchedChapter } : {}),
    ...(goal.status === "completed" || goal.status === "stale" ? { closeAt: goal.lastTouchedChapter ?? goal.firstSeenChapter } : {}),
    ...(goal.status === "stale" ? { closeNote: STALE_NOTE } : {}),
    ...(goal.evidence ? { evidence: goal.evidence } : {}),
    ...(goal.scope === "main_arc" ? { major: true } : {}),
  }));
  const majorThreads: string[] = [];
  const threadIds = new Set<string>();
  for (const source of sources) {
    if (threadIds.has(source.id)) {
      skipped.push({ file: source.file, item: source.index, reason: `编号重复：${source.id}` });
      continue;
    }
    if (!place(source.first, {
      kind: "thread",
      review: "auto",
      op: "open",
      thread: source.id,
      type: source.type,
      title: source.title,
      note: source.note,
      ...firstEvidenceIn(source.first, source.evidence),
    }, source.file, source.index)) continue;
    threadIds.add(source.id);
    if (source.major) majorThreads.push(source.id);
    const closeAt = source.closeAt !== undefined && source.closeAt >= source.first ? source.closeAt : undefined;
    if (source.last !== undefined && source.last > source.first && source.last !== closeAt) {
      place(source.last, { kind: "thread", review: "auto", op: "advance", thread: source.id, note: source.title, ...firstEvidenceIn(source.last, source.evidence) }, source.file, source.index);
    }
    if (closeAt !== undefined) {
      place(closeAt, {
        kind: "thread",
        review: "auto",
        op: "close",
        thread: source.id,
        note: source.closeNote ?? source.title,
        ...firstEvidenceIn(closeAt, source.evidence),
      }, source.file, source.index);
    }
  }

  // —— 时间：按老时间线逐章算「隔几天」；坏锚和紧跟它的一章记成不知道 ——
  const seenTimeChapters = new Set<number>();
  const timeRows = [...data.timeline].sort((a, b) => a.chapter - b.chapter).flatMap((entry, index) => {
    if (seenTimeChapters.has(entry.chapter)) {
      skipped.push({ file: LEGACY_FILES.timeline, item: index, reason: `第 ${entry.chapter} 章有两条时间` });
      return [];
    }
    seenTimeChapters.add(entry.chapter);
    return [{ entry, index }];
  });
  const outcomes = legacyTimeOf(timeRows.map(({ entry }) => legacyTimelineRow(entry)));
  timeRows.forEach(({ entry, index }, at) => {
    const outcome = outcomes[at]!;
    const explicit = entry.source === "declared" || entry.source === "author";
    if (outcome.kind === "unknown") {
      const why = outcome.legacy.reason === "estimated" ? "老书里是估的" : outcome.legacy.reason === "earlier" ? "比上一章早，没法判断是倒叙还是记错" : "上一章的天数记成了不知道，这章的差值没了依据";
      adjusted.push({ file: LEGACY_FILES.timeline, item: `第 ${entry.chapter} 章`, change: `天数${why}，记成不知道` });
    }
    const basis = outcome.kind === "at" ? "author" : outcome.kind === "offset" ? outcome.basis : outcome.legacy.basis;
    place(entry.chapter, {
      kind: "time",
      review: "auto",
      basis,
      ...(outcome.kind === "at" ? { day: outcome.day } : outcome.kind === "offset" ? { daysSincePrevious: outcome.daysSincePrevious } : { legacy: outcome.legacy }),
      ...(outcome.kind !== "unknown" && outcome.daysInChapter ? { daysInChapter: outcome.daysInChapter } : {}),
      ...(explicit && entry.weekday !== undefined ? { weekday: entry.weekday } : {}),
      ...(entry.timeOfDay?.trim() ? { timeOfDay: entry.timeOfDay.trim() } : {}),
      ...(basis === "text" || basis === "judged" ? verified(entry.chapter, entry.quote) : {}),
    }, LEGACY_FILES.timeline, index);
  });

  // —— 梗概和出场 ——
  const presenceKeys = new Map<number, Set<string>>();
  const firstSeen = new Map<string, number>();
  const addPresence = (chapter: number, name: string, nameUsed: string, quote: { quote?: string }, file: string, item: number | string): void => {
    const key = `${nameKey(name)}|${nameKey(nameUsed)}`;
    const keys = presenceKeys.get(chapter) ?? new Set<string>();
    if (keys.has(key)) return;
    if (!place(chapter, { kind: "presence", review: "auto", name, nameUsed, ...quote }, file, item)) return;
    keys.add(key);
    presenceKeys.set(chapter, keys);
    const nk = nameKey(name);
    if (!firstSeen.has(nk) || (firstSeen.get(nk) as number) > chapter) firstSeen.set(nk, chapter);
  };
  const summarized = new Set<number>();
  data.events.forEach((event, index) => {
    if (event.summary?.trim() && !summarized.has(event.chapter)) {
      if (place(event.chapter, { kind: "summary", review: "auto", text: event.summary.trim() }, LEGACY_FILES.events, index)) summarized.add(event.chapter);
    }
    for (const id of event.participants ?? []) {
      const name = data.characterNames.get(id);
      if (!name) {
        skipped.push({ file: LEGACY_FILES.events, item: index, reason: "有一个出场人物找不到名字" });
        continue;
      }
      addPresence(event.chapter, name, name, {}, LEGACY_FILES.events, index);
    }
  });
  data.matrix.forEach((entry, index) => {
    for (const appearance of entry.appearances ?? []) {
      addPresence(appearance.chapter, entry.name, entry.name, verified(appearance.chapter, appearance.evidence), LEGACY_FILES.matrix, index);
    }
  });
  data.aliases.forEach((entry, index) => {
    const generated = new Set((entry.generated ?? []).map(nameKey));
    const own = new Set([nameKey(entry.canonicalName), nameKey(entry.primary ?? "")]);
    const chapter = firstSeen.get(nameKey(entry.canonicalName));
    for (const alias of entry.aliases ?? []) {
      const key = nameKey(alias);
      if (key.length === 0 || generated.has(key) || own.has(key)) continue;
      if (chapter === undefined) {
        skipped.push({ file: LEGACY_FILES.aliases, item: index, reason: "这个人没在任何一章出场过，别称没处记" });
        break;
      }
      addPresence(chapter, entry.canonicalName, alias.trim(), {}, LEGACY_FILES.aliases, index);
    }
  });

  // —— 拼账单 ——
  const ledgers: ChapterLedger[] = [];
  const counts = { facts: 0, threadsOpened: 0, threadAdvances: 0, threadsClosed: 0, times: 0, summaries: 0, presences: 0 };
  for (const chapter of [...texts.keys()].sort((a, b) => a - b)) {
    const list = [...(drafts.get(chapter) ?? [])];
    // 稳定排序：先按种类，线索再按开 / 推进 / 收；同类保持老数据里的顺序。
    const ordered = list
      .map((draft, position) => ({ draft, position }))
      .sort((a, b) => SECTION_ORDER[a.draft.kind] - SECTION_ORDER[b.draft.kind]
        || (a.draft.kind === "thread" && b.draft.kind === "thread" ? THREAD_OP_ORDER[a.draft.op] - THREAD_OP_ORDER[b.draft.op] : 0)
        || a.position - b.position)
      .map(({ draft }) => draft);
    let seq = 0;
    const source = chapterSource(chapter, texts.get(chapter) as string);
    const entries: LedgerEntry[] = [];
    for (const draft of ordered) {
      if (draft.kind === "fact") counts.facts += 1;
      else if (draft.kind === "time") counts.times += 1;
      else if (draft.kind === "summary") counts.summaries += 1;
      else if (draft.kind === "presence") counts.presences += 1;
      else if (draft.op === "open") counts.threadsOpened += 1;
      else if (draft.op === "advance") counts.threadAdvances += 1;
      else counts.threadsClosed += 1;
      const { id: kept, ...declared } = draft;
      const id = kept ?? `c${chapter}-${(seq += 1)}`;
      const thread = declared.kind === "thread" && declared.op === "open" ? declared.thread : undefined;
      // 老数据：来源、范围说不清，按迁移来的记；原句前面核过，在正文里。
      if (declared.kind === "time") {
        entries.push(...storeLegacyTime(declared, id, evidenceFor(declared.quote, source) ?? { evidence: [], evidenceStatus: "none" }, "migrated"));
      } else {
        entries.push(...storeEntry(declared, { id, ...(thread ? { thread } : {}) }, source, "migrated").entries);
      }
    }
    // 老数据里这章什么都没有：账待记，记账员通读时记（和导入已写的书同一种）。
    const built = newLedger({
      chapter,
      textSha256: source.revision,
      committedAt,
      origin: "import",
      entries,
      status: entries.length === 0 ? "pending" : "ready",
      coverage: { reasonCodes: [entries.length === 0 ? "imported_text" : "legacy_protocol"] },
      ...(entries.length === 0 ? {} : { legacyTime: true as const }),
    });
    if (!built.success) throw new Error(`第 ${chapter} 章的账单没拼成：${built.error.issues[0]?.message ?? "格式不对"}`);
    ledgers.push(built.data);
  }
  return {
    ledgers,
    expiries,
    majorThreads,
    counts: { chapters: ledgers.length, ...counts, quotesDropped, factsWithoutKind },
    skipped,
    adjusted,
  };
}
