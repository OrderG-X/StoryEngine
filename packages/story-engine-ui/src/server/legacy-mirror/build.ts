/**
 * 老格式镜像：从新核心的投影生成老代码还在读的那几份文件（设计见 docs/rebuild/P3-design.md 第〇、五节）。
 *
 * 镜像不是真相：老文件不再有别的写入方，坏了、丢了重生成一遍就好。同样的真相生成同样的文件（纯函数，
 * 不读时钟、不读盘）。它是临时的：读老文件的地方每改一处读投影，就从这里删掉一个文件。
 *
 * 只生成、不猜：投影里没有的东西（老格式的「时段」枚举、冲突、伏笔关键词……）一律不编，留空或给老代码的缺省值。
 */
import { nameKey, type BookProjection, type ChapterLedger, type ThreadView } from "@actalk/story-core";
import type {
  ArcGoal,
  ArcGoalPool,
  FactEntry,
  FactLedger,
  HookPool,
  NarrativeThread,
  StoryCalendar,
  StoryTimeline,
  TimelineEntry,
  TimelineEvent,
  TimelineSource,
  ThreadPool,
} from "@actalk/story-engine";

/** 镜像生成的文件（相对书目录）。顺序就是写盘顺序。 */
export const MIRROR_FILES = {
  timeline: "story/timeline.json",
  calendar: "time/calendar.json",
  facts: "story/fact-ledger.json",
  threads: "story/threads.json",
  hooks: "story/hooks.json",
  goals: "story/arc-goals.json",
  events: "timeline/events.json",
} as const;

export interface LegacyMirrorInput {
  readonly projection: BookProjection;
  readonly ledgers: readonly ChapterLedger[];
  /** 人物名字（已确立名或别称，nameKey 归一）→ 老格式的人物编号（characters/<id>）。 */
  readonly characterIds: ReadonlyMap<string, string>;
  /** 每章正文的标题（正文第一行的 markdown 标题）；没有就用「第N章」。 */
  readonly chapterTitles: ReadonlyMap<number, string>;
}

export interface LegacyMirror {
  readonly timeline: StoryTimeline;
  readonly calendar: StoryCalendar;
  readonly facts: FactLedger;
  readonly threads: ThreadPool;
  readonly hooks: HookPool;
  readonly goals: ArcGoalPool;
  readonly events: readonly TimelineEvent[];
}

const TIME_SOURCE: Record<BookProjection["chapters"][number]["dayBasis"], TimelineSource> = {
  author: "author",
  text: "declared",
  judged: "plan",
  estimated: "fallback",
  missing: "fallback",
};

/**
 * 老格式的 stale 意思是「不再追踪」（清理掉的、合并掉的、过期的打算），老代码一律不当开着的读。
 * 投影的 stale 只是「停了好几章」，线索还开着——照搬过去会让老代码把真开着的线索从出稿上下文里藏掉
 * （长篇里伏笔就这样被忘）。所以只分三种：收了 / 推进过 / 刚开。
 */
function threadStatus(thread: ThreadView): NarrativeThread["status"] {
  if (thread.status === "closed") return "done";
  return thread.touches.some((touch) => touch.op === "advance") ? "touched" : "open";
}

function goalStatus(thread: ThreadView): ArcGoal["status"] {
  if (thread.status === "closed") return "completed";
  return thread.touches.some((touch) => touch.op === "advance") ? "touched" : "active";
}

export function buildLegacyMirror(input: LegacyMirrorInput): LegacyMirror {
  const { projection } = input;
  const timeEntries = new Map(input.ledgers.flatMap((ledger) => ledger.entries.flatMap((entry) => (entry.kind === "time" ? [[ledger.chapter, entry] as const] : []))));

  const timeline: StoryTimeline = {
    schemaVersion: 1,
    entries: projection.chapters.map((chapter): TimelineEntry => {
      const time = timeEntries.get(chapter.chapter);
      const span = chapter.dayEnd - chapter.day;
      return {
        chapter: chapter.chapter,
        day: chapter.day,
        // 老格式只存明写的星期，推出来的不存（老代码自己推）。
        ...(chapter.weekday !== undefined && !chapter.weekdayDerived ? { weekday: chapter.weekday } : {}),
        ...(chapter.timeOfDay ? { timeOfDay: chapter.timeOfDay } : {}),
        ...(time?.daysSincePrevious !== undefined && chapter.dayBasis !== "author" ? { daysSincePrevious: time.daysSincePrevious } : {}),
        ...(span > 0 ? { daysInChapter: span } : {}),
        source: TIME_SOURCE[chapter.dayBasis],
        ...(time?.quote ? { quote: time.quote } : {}),
      };
    }),
  };

  const last = projection.chapters.at(-1);
  // 老格式的时段是英文枚举；正文的说法不往枚举里猜，一律 unknown（真实说法在 timeline.json 里）。
  const calendar: StoryCalendar = { currentStoryDay: last?.dayEnd ?? 1, currentTimeOfDay: "unknown" };

  const facts: FactLedger = {
    version: "v0",
    facts: projection.facts
      // 作者说「记错了」的不进老账本：老代码不认作废，留着就当真。
      .filter((fact) => fact.status !== "retracted")
      .map((fact): FactEntry => ({
        id: fact.id,
        chapter: fact.chapter,
        text: fact.text,
        source: fact.review === "author" ? "manual" : "auto",
        effectiveFromChapter: fact.chapter,
        ...(fact.supersededAt !== undefined ? { supersededByChapter: fact.supersededAt } : {}),
        ...(fact.supersededBy !== undefined ? { supersededByFactId: fact.supersededBy } : {}),
        ...(fact.quote ? { quote: fact.quote } : {}),
        ...(fact.subject ? { subject: fact.subject } : {}),
        ...(fact.attribute ? { attribute: fact.attribute } : {}),
        ...(fact.value ? { value: fact.value } : {}),
        kind: fact.nature,
      })),
  };

  const evidenceOf = (thread: ThreadView): string[] => unique(thread.touches.flatMap((touch) => (touch.quote ? [touch.quote] : [])));

  const threads: ThreadPool = {
    threads: projection.threads
      .filter((thread) => thread.type !== "goal")
      .map((thread): NarrativeThread => ({
        id: thread.id,
        type: thread.type === "intent" ? "intent" : "lead",
        title: thread.title,
        status: threadStatus(thread),
        firstSeenChapter: thread.openedAt,
        lastTouchedChapter: thread.lastTouchedAt,
        evidence: evidenceOf(thread),
      })),
  };

  const goals: ArcGoalPool = {
    goals: projection.threads
      .filter((thread) => thread.type === "goal")
      .map((thread): ArcGoal => ({
        id: thread.id,
        title: thread.title,
        status: goalStatus(thread),
        // 作者标了「重要」的算主线目标，其余算阶段目标（老代码按这个分开数上限）。
        scope: thread.weight === "major" ? "main_arc" : "mini_arc",
        firstSeenChapter: thread.openedAt,
        lastTouchedChapter: thread.lastTouchedAt,
        evidence: evidenceOf(thread),
      })),
  };

  const threadTypes = new Map(projection.threads.flatMap((thread) => [thread.id, ...thread.mergedFrom].map((id) => [id, thread.type] as const)));
  const events = projection.chapters.map((chapter): TimelineEvent => {
    const ledger = input.ledgers.find((item) => item.chapter === chapter.chapter);
    const summary = chapter.summary ?? "";
    const participants = unique(chapter.present.flatMap((name) => idOf(input, projection, name)));
    const aliases = aliasesOf(ledger, projection);
    const { decision, discovery } = turnsOf(ledger, threadTypes);
    const keyEvents = projection.facts
      .filter((fact) => fact.chapter === chapter.chapter && fact.nature === "event" && fact.status !== "retracted")
      .map((fact) => fact.text);
    return {
      id: `ch${String(chapter.chapter).padStart(4, "0")}-001`,
      chapter: chapter.chapter,
      summary,
      participants,
      effects: {
        semanticSummary: {
          chapter: chapter.chapter,
          chapterTitle: input.chapterTitles.get(chapter.chapter) ?? `第${chapter.chapter}章`,
          ...(summary ? { chapterSummary: summary, timelineSummary: summary } : {}),
          mainEvent: summary,
          participants,
          ...(keyEvents.length > 0 ? { keyEvents } : {}),
          ...(decision ? { decision } : {}),
          ...(discovery ? { discovery } : {}),
          mentionedHooks: [],
          mentionedCharacters: participants,
          mentionedCharacterNames: [...chapter.present],
          presentCharacterNames: [...chapter.present],
          ...(aliases.length > 0 ? { characterAliases: aliases } : {}),
          ...(chapter.viewpoint ? { viewpointCharacter: chapter.viewpoint } : {}),
          locations: [],
        },
      },
    };
  });

  // 伏笔（悬念）在新核心里就是 question 类线索，统一进 threads.json；hooks.json 留空，免得同一条线两处各算一遍。
  return { timeline, calendar, facts, threads, hooks: { hooks: [] }, goals, events };
}

/** 镜像的文件内容（和老代码写盘的格式一致：两格缩进 + 结尾换行）。 */
export function serializeLegacyMirror(mirror: LegacyMirror): ReadonlyArray<readonly [string, string]> {
  return (Object.keys(MIRROR_FILES) as (keyof typeof MIRROR_FILES)[]).map((key) => [MIRROR_FILES[key], `${JSON.stringify(mirror[key], null, 2)}\n`] as const);
}

/** 投影里的已确立名 → 人物编号：先按名字，再按这个人的别称找。 */
function idOf(input: LegacyMirrorInput, projection: BookProjection, name: string): string[] {
  const direct = input.characterIds.get(nameKey(name));
  if (direct) return [direct];
  const member = projection.cast.find((item) => item.name === name);
  for (const alias of member?.aliases ?? []) {
    const id = input.characterIds.get(nameKey(alias));
    if (id) return [id];
  }
  return [];
}

/**
 * 老格式每章的「决定」「发现」：本章新开的打算就是人物做的决定，本章收掉的悬念就是揭开的事。
 * 新账里没有「冲突」，老格式的 conflict 不编。
 */
function turnsOf(ledger: ChapterLedger | undefined, types: ReadonlyMap<string, ThreadView["type"]>): { decision?: string; discovery?: string } {
  const decisions: string[] = [];
  const discoveries: string[] = [];
  for (const entry of ledger?.entries ?? []) {
    if (entry.kind !== "thread") continue;
    if (entry.op === "open" && entry.type === "intent") decisions.push(entry.note);
    if (entry.op === "close" && types.get(entry.thread) === "question") discoveries.push(entry.note);
  }
  return {
    ...(decisions.length > 0 ? { decision: unique(decisions).join("；") } : {}),
    ...(discoveries.length > 0 ? { discovery: unique(discoveries).join("；") } : {}),
  };
}

/** 本章正文里换了叫法的人：name = 已确立名，alias = 本章的叫法。 */
function aliasesOf(ledger: ChapterLedger | undefined, projection: BookProjection): { name: string; alias: string }[] {
  const out: { name: string; alias: string }[] = [];
  const seen = new Set<string>();
  for (const entry of ledger?.entries ?? []) {
    if (entry.kind !== "presence" || nameKey(entry.name) === nameKey(entry.nameUsed)) continue;
    const key = nameKey(entry.name);
    const member = projection.cast.find((item) => item.key === key || item.aliases.some((alias) => nameKey(alias) === key));
    const name = member?.name ?? entry.name;
    const pair = `${nameKey(name)}\u0000${nameKey(entry.nameUsed)}`;
    if (nameKey(name) === nameKey(entry.nameUsed) || seen.has(pair)) continue;
    seen.add(pair);
    out.push({ name, alias: entry.nameUsed });
  }
  return out;
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}
