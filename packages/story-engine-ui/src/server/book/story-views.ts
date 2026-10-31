/**
 * 账的几种读法（写作版本 P2b 片 1：删镜像）：写手、章纲、核账、概况要的时间线、事实、线索、目标、各章事件，
 * 每次从投影现算（读真相 → 投影 → 按读者要的样子摆），不落盘、不同步，也就没有「落后了」这回事。
 *
 * 这几样原来是 book/mirror 生成到书里的老格式文件（story/threads.json 等），读者读文件；现在样子不变、直接给，
 * 读者不用改，给模型的字一个不差（片 1 前后的材料逐字比对过）。伏笔池、日历时段这些镜像里一直是空的，不再给。
 *
 * 设定视图也从同一份快照算：写一章的上下文要设定和账两样，读一次，坏了只坏一处、只说一次。
 *
 * 只摆、不猜：投影里没有的东西（老格式的冲突、地点……）不编。读的路径不写盘、不拿锁。
 */
import { bibleView, nameKey, parseDraftFile, presenceName, project, readBookSnapshot, readChapterText, readLegacyCards, rightsOf, scopeOf, timelineTable, type BibleView, type BookProjection, type ChapterLedger, type ThreadView, type TimelineRow } from "@actalk/story-core";
import type { ArcGoal, ArcGoalPool, FactEntry, FactLedger, NarrativeThread, ThreadPool, TimelineEvent } from "./types.js";

export interface LedgerViews {
  readonly projection: BookProjection;
  /** 每章是故事哪几天（核心时间表；给模型的样子见 story-timeline.ts）。 */
  readonly timeline: readonly TimelineRow[];
  readonly facts: FactLedger;
  readonly threads: ThreadPool;
  readonly goals: ArcGoalPool;
  readonly events: readonly TimelineEvent[];
}

export interface StoryViews extends LedgerViews {
  readonly bible: BibleView;
}

/** 读真相、算投影、摆成读者要的几样，连同设定视图（还没有 cards.json 的老书现从老格式文件拼一份，同核心 readBible）。 */
export async function readStoryViews(projectDir: string): Promise<StoryViews> {
  const snapshot = await readBookSnapshot(projectDir);
  const projection = project(snapshot);
  const cards = snapshot.cards ?? (await readLegacyCards(projectDir, new Date().toISOString())).file;
  const titles = await readChapterTitles(projectDir, projection.chapters.map((chapter) => chapter.chapter));
  return { ...storyViewsOf(projection, snapshot.ledgers, titles), bible: bibleView(projection, cards) };
}

/** 章节文件的章名（核心 parseDraftFile：第一行非空行是一级章名行）。 */
export function markdownTitle(text: string | undefined): string | undefined {
  return text === undefined ? undefined : parseDraftFile(text).title;
}

async function readChapterTitles(projectDir: string, chapters: readonly number[]): Promise<Map<number, string>> {
  const titles = new Map<number, string>();
  for (const chapter of chapters) {
    const title = markdownTitle(await readChapterText(projectDir, chapter));
    if (title) titles.set(chapter, title);
  }
  return titles;
}

/** 账待记的章在「各章事件」里的梗概：如实说给不出（写手、章纲、概况照读这一句，不当成「这章什么都没发生」）。 */
export const PENDING_CHAPTER_SUMMARY = "这章的账还没记上，梗概给不出";
/** 账没记全、梗概那条没记上。 */
export const PARTIAL_CHAPTER_SUMMARY = "这章的账没记全，梗概给不出";

/**
 * 读者说的 stale 是「不再追踪」（清理掉的、合并掉的、过期的打算），一律不当开着的读。
 * 投影的 stale 只是「停了好几章」，线索还开着——照搬过去会把真开着的线索从出稿上下文里藏掉
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

export function storyViewsOf(projection: BookProjection, ledgers: readonly ChapterLedger[], chapterTitles: ReadonlyMap<number, string>): LedgerViews {
  const timeline = timelineTable(projection);

  const facts: FactLedger = {
    version: "v0",
    facts: projection.facts
      // 作者说「记错了」的不给：读者不认作废，给了就当真。
      .filter((fact) => fact.status !== "retracted")
      .map((fact): FactEntry => {
        const scope = scopeLabel(fact.scope);
        const { conflict } = rightsOf(fact.scope.source, fact.scope.frame);
        return {
          id: fact.id,
          chapter: fact.chapter,
          text: scope ? `${fact.text}（${scope}）` : fact.text,
          source: fact.review === "author" ? "manual" : "auto",
          effectiveFromChapter: fact.chapter,
          ...(fact.supersededAt !== undefined ? { supersededByChapter: fact.supersededAt } : {}),
          ...(fact.supersededBy !== undefined ? { supersededByFactId: fact.supersededBy } : {}),
          ...(fact.quote ? { quote: fact.quote } : {}),
          ...(fact.subject ? { subject: fact.subject } : {}),
          ...(fact.attribute ? { attribute: fact.attribute } : {}),
          ...(fact.value ? { value: fact.value } : {}),
          kind: fact.nature,
          ...(scope ? { scope } : {}),
          ...(conflict !== "sure" ? { conflict } : {}),
        };
      }),
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
        ...(thread.weight !== "normal" ? { weight: thread.weight } : {}),
      })),
  };

  const goals: ArcGoalPool = {
    goals: projection.threads
      .filter((thread) => thread.type === "goal")
      .map((thread): ArcGoal => ({
        id: thread.id,
        title: thread.title,
        status: goalStatus(thread),
        // 作者标了「重要」的算主线目标，其余算阶段目标（读者按这个分开数上限）。
        scope: thread.weight === "major" ? "main_arc" : "mini_arc",
        firstSeenChapter: thread.openedAt,
        lastTouchedChapter: thread.lastTouchedAt,
        evidence: evidenceOf(thread),
      })),
  };

  const touches = new Map(projection.threads.flatMap((thread) => thread.touches.map((touch) => [touch.entry, { touch, type: thread.type }] as const)));
  const events = projection.chapters.map((chapter): TimelineEvent => {
    const ledger = ledgers.find((item) => item.chapter === chapter.chapter);
    const short = chapter.ledgerStatus !== "ready" ? chapter.ledgerStatus : undefined;
    const summary = chapter.summary ?? (short === "pending" ? PENDING_CHAPTER_SUMMARY : short === "partial" && chapter.missingKinds?.includes("summary") ? PARTIAL_CHAPTER_SUMMARY : "");
    const participants = [...chapter.present];
    const aliases = aliasesOf(ledger, projection);
    const { decision, discovery } = turnsOf(ledger, touches);
    // 梦里、回忆里、人物说的事带上说明（出口复核 R3：不带就成了当下发生的事）；说明放前头，写手材料截短也截不掉。
    const keyEvents = projection.facts
      .filter((fact) => fact.chapter === chapter.chapter && fact.nature === "event" && fact.status !== "retracted")
      .map((fact) => scoped(fact.text, scopeLabel(fact.scope)));
    return {
      id: `ch${String(chapter.chapter).padStart(4, "0")}-001`,
      chapter: chapter.chapter,
      ...(short ? { ledgerShort: short } : {}),
      summary,
      participants,
      effects: {
        semanticSummary: {
          chapter: chapter.chapter,
          chapterTitle: chapterTitles.get(chapter.chapter) ?? `第${chapter.chapter}章`,
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

  return { projection, timeline, facts, threads, goals, events };
}

/** 不是叙述当下说的事实，给模型的字上带一句（写作版本 P3a 第 3 节）：梦里、回忆里的不是现状；人物说的不一定是真的。 */
function scopeLabel(scope: BookProjection["facts"][number]["scope"]): string | undefined {
  if (scope.frame === "other") return "梦里、想象或传闻里的，不是现状";
  if (scope.frame === "past") return "回忆里的，不是现状";
  if (scope.frame === "unknown") return "这句在不在回忆、梦里对不上了，不一定是现状";
  if (scope.source === "character_claim") return `${scope.speaker ?? "人物"}说的，不一定是真的`;
  return undefined;
}

/**
 * 每章的「决定」「发现」：本章新开的打算就是人物做的决定，本章收掉的悬念就是揭开的事。
 * 照投影里实际生效的动作（出口复核 R3）：梦里、回忆里、人物说的收口按推进记，不算揭开；梦里、回忆里开的打算带上说明。
 * 账里没有「冲突」，不编。
 */
function turnsOf(
  ledger: ChapterLedger | undefined,
  touches: ReadonlyMap<string, { readonly touch: ThreadView["touches"][number]; readonly type: ThreadView["type"] }>,
): { decision?: string; discovery?: string } {
  if (!ledger) return {};
  const decisions: string[] = [];
  const discoveries: string[] = [];
  for (const entry of ledger.entries) {
    if (entry.kind !== "thread") continue;
    const applied = touches.get(entry.id);
    if (!applied) continue;
    if (entry.op === "open" && entry.type === "intent") {
      decisions.push(scoped(entry.note, scopeLabel(scopeOf(entry, ledger))));
    }
    if (applied.touch.op === "close" && applied.type === "question") discoveries.push(entry.note);
  }
  return {
    ...(decisions.length > 0 ? { decision: unique(decisions).join("；") } : {}),
    ...(discoveries.length > 0 ? { discovery: unique(discoveries).join("；") } : {}),
  };
}

const scoped = (text: string, scope: string | undefined): string => (scope ? `（${scope}）${text}` : text);

/** 本章正文里换了叫法的人：name = 已确立名，alias = 本章的叫法。 */
function aliasesOf(ledger: ChapterLedger | undefined, projection: BookProjection): { name: string; alias: string }[] {
  const out: { name: string; alias: string }[] = [];
  const seen = new Set<string>();
  for (const entry of ledger?.entries ?? []) {
    if (entry.kind !== "presence" || entry.generic || nameKey(presenceName(entry)) === nameKey(entry.nameUsed)) continue;
    const key = nameKey(presenceName(entry));
    const member = projection.cast.find((item) => item.key === key || item.aliases.some((alias) => nameKey(alias) === key));
    const name = member?.name ?? presenceName(entry);
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
