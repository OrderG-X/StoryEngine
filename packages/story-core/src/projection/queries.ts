/**
 * 投影上的常用查询：给界面、核账员、对话 AI 取一小块用。全是纯函数，只读投影、不读盘。
 *
 * 名字一律按 nameKey 精确比（已确立名字或别名都行），不做模糊匹配；找不到就是找不到，返回 undefined。
 * 返回值里给人看的字段只有名字、标题、章号；id 留着给程序回指，展示前不许直接拼进文案。
 */
import type { ThreadType, TimeBasis } from "../schema/ledger.js";
import { nameKey } from "../text/quote.js";
import type { BookProjection, ChapterView, FactView, ThreadStatus, ThreadView, ThreadWeight } from "./types.js";

export interface SubjectFacts {
  /** 已确立名字。 */
  readonly name: string;
  readonly key: string;
  readonly aliases: readonly string[];
  /** 现在有效的事实，按章序。 */
  readonly facts: readonly FactView[];
}

/** 名字（或别名）→ 主体键。人物表和事实主体都查；查不到返回 undefined。 */
function resolveSubject(projection: BookProjection, raw: string): { key: string; name: string; aliases: readonly string[] } | undefined {
  const key = nameKey(raw);
  if (key.length === 0) return undefined;
  for (const member of projection.cast) {
    if (member.key === key || member.aliases.some((alias) => nameKey(alias) === key)) {
      return { key: member.key, name: member.name, aliases: member.aliases };
    }
  }
  const subject = projection.subjects.find((item) => item.key === key);
  if (subject) return { key: subject.key, name: subject.name, aliases: [] };
  if (projection.facts.some((fact) => fact.subjectKey === key)) {
    const fact = projection.facts.find((item) => item.subjectKey === key);
    return { key, name: fact?.subject ?? raw, aliases: [] };
  }
  return undefined;
}

/** 某个人或物现在有效的事实（作废的、作者说记错的不算）。 */
export function currentFactsAbout(projection: BookProjection, name: string): SubjectFacts | undefined {
  const subject = resolveSubject(projection, name);
  if (!subject) return undefined;
  const facts = projection.facts.filter((fact) => fact.subjectKey === subject.key && fact.status === "current");
  return { ...subject, facts };
}

export interface PromptThread {
  readonly id: string;
  readonly type: ThreadType;
  readonly title: string;
  readonly status: Exclude<ThreadStatus, "closed">;
  readonly weight: ThreadWeight;
  readonly openedAt: number;
  readonly lastTouchedAt: number;
  /** 离算到的那章已经几章没动。 */
  readonly idleChapters: number;
  /** 最近一次推进的说明。 */
  readonly lastNote: string;
}

export interface PromptThreads {
  readonly threads: readonly PromptThread[];
  /** 没放进来的开着的线索条数（超过 limit 的）。 */
  readonly omitted: number;
}

export const DEFAULT_PROMPT_THREAD_LIMIT = 20;

const WEIGHT_RANK: Record<ThreadWeight, number> = { major: 0, normal: 1, minor: 2 };

/**
 * 给模型看的开着的线索。排序：分量重的先，同分量里停太久的先，再按最近推进（新的先）。
 * limit 不是正整数时按缺省 20 条。
 */
export function threadsForPrompt(projection: BookProjection, options: { readonly limit?: number } = {}): PromptThreads {
  const limit = Number.isInteger(options.limit) && (options.limit ?? 0) > 0 ? (options.limit as number) : DEFAULT_PROMPT_THREAD_LIMIT;
  const open = projection.threads.filter((thread): thread is ThreadView & { status: Exclude<ThreadStatus, "closed"> } => thread.status !== "closed");
  const sorted = [...open].sort(
    (a, b) =>
      WEIGHT_RANK[a.weight] - WEIGHT_RANK[b.weight] ||
      Number(b.status === "stale") - Number(a.status === "stale") ||
      b.lastTouchedAt - a.lastTouchedAt ||
      a.openedAt - b.openedAt ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const threads = sorted.slice(0, limit).map((thread) => ({
    id: thread.id,
    type: thread.type,
    title: thread.title,
    status: thread.status,
    weight: thread.weight,
    openedAt: thread.openedAt,
    lastTouchedAt: thread.lastTouchedAt,
    idleChapters: Math.max(0, projection.upTo - thread.lastTouchedAt),
    lastNote: thread.touches.at(-1)?.note ?? thread.title,
  }));
  return { threads, omitted: sorted.length - threads.length };
}

export interface TimelineRow {
  readonly chapter: number;
  readonly day: number;
  readonly dayEnd: number;
  /** 0 = 周一 … 6 = 周日。 */
  readonly weekday?: number;
  readonly weekdayDerived: boolean;
  readonly timeOfDay?: string;
  readonly basis: TimeBasis | "missing";
}

/** 每章「第几天、星期几、依据」，算到 upTo（含；缺省 = 投影算到的那章）。模型照表对，不自己做日期算术。 */
export function timelineTable(projection: BookProjection, upTo: number = projection.upTo): TimelineRow[] {
  return projection.chapters
    .filter((chapter) => chapter.chapter <= upTo)
    .map((chapter) => ({
      chapter: chapter.chapter,
      day: chapter.day,
      dayEnd: chapter.dayEnd,
      ...(chapter.weekday !== undefined ? { weekday: chapter.weekday } : {}),
      weekdayDerived: chapter.weekdayDerived,
      ...(chapter.timeOfDay !== undefined ? { timeOfDay: chapter.timeOfDay } : {}),
      basis: chapter.dayBasis,
    }));
}

const WEEKDAY_NAMES = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"] as const;
const BASIS_LABELS: Record<TimelineRow["basis"], string> = {
  text: "正文明写",
  judged: "按正文推断",
  author: "作者定的",
  estimated: "估计的",
  missing: "没记，按上一章 +1",
};

/** 时间表的文字版，给提示词直接贴。 */
export function timelineText(rows: readonly TimelineRow[]): string {
  const lines = ["| 章 | 第几天 | 星期 | 时段 | 依据 |", "|---|---|---|---|---|"];
  for (const row of rows) {
    const days = row.dayEnd > row.day ? `${row.day}～${row.dayEnd}` : `${row.day}`;
    const weekday = row.weekday === undefined ? "—" : `${WEEKDAY_NAMES[row.weekday]}${row.weekdayDerived ? "（推算）" : ""}`;
    lines.push(`| 第 ${row.chapter} 章 | ${days} | ${weekday} | ${row.timeOfDay ?? "—"} | ${BASIS_LABELS[row.basis]} |`);
  }
  return lines.join("\n");
}

export interface ChapterBrief {
  readonly chapter: number;
  readonly summary?: string;
  readonly present: readonly string[];
  readonly viewpoint?: string;
  readonly time: TimelineRow;
  /** 这章动过的线索（标题 + 开 / 推进 / 收）。 */
  readonly threads: readonly { readonly id: string; readonly title: string; readonly op: "open" | "advance" | "close" }[];
  readonly editedSinceCommit?: boolean;
  readonly textMissing: boolean;
}

/** 一章的梗概、出场、时间、动过的线索。没定稿的章返回 undefined。 */
export function chapterBrief(projection: BookProjection, chapter: number): ChapterBrief | undefined {
  const view: ChapterView | undefined = projection.chapters.find((item) => item.chapter === chapter);
  if (!view) return undefined;
  const threads: { id: string; title: string; op: "open" | "advance" | "close" }[] = [];
  for (const thread of projection.threads) {
    for (const touch of thread.touches) {
      if (touch.chapter === chapter) threads.push({ id: thread.id, title: thread.title, op: touch.op });
    }
  }
  const [time] = timelineTable({ ...projection, chapters: [view] }, chapter);
  return {
    chapter,
    ...(view.summary !== undefined ? { summary: view.summary } : {}),
    present: view.present,
    ...(view.viewpoint !== undefined ? { viewpoint: view.viewpoint } : {}),
    time: time as TimelineRow,
    threads,
    ...(view.editedSinceCommit !== undefined ? { editedSinceCommit: view.editedSinceCommit } : {}),
    textMissing: view.textMissing,
  };
}
