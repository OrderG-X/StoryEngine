/**
 * AI 栏「待处理」（2026-10-07 改版）：不急但别忘的事，按需点「让 AI …」把一句话放进输入框（不自动发、不直连引擎）。
 * 带 ops 的（重构 P9：还没标主角）点了直接改设定本（作者档、可撤销），不经模型；带 userAction 的（P3a：天数待确认）点了直接改账。
 * 全部从现有只读数据确定性推出：还没标主角 / 天数要你看的章 / 好几章没动的线索数 / 久未推进的主线目标 / 占位章名 / 重名章节。题材中立。
 */
import { newLedgerAction, type AgentUserAction } from "../../../api/agentChatClient.js";
import type { CardOp } from "../../../api/bibleClient.js";
import type { StateOverview } from "../../../api/types.js";
import type { ChapterNavItem } from "../../../type-defs/workspace.js";
import { chapterBareTitle, isPlaceholderChapterTitle } from "../v2Utils.js";

export interface InboxTodo {
  readonly key: string;
  readonly title: string;
  readonly sub: string;
  readonly action: string;
  readonly prefill: string;
  /** 有就直接改设定本（作者点了就算数），不放进输入框。 */
  readonly ops?: readonly CardOp[];
  /** 有就直接交这个按钮动作（作者档改账，可撤销），不放进输入框。 */
  readonly userAction?: AgentUserAction;
}

const ARC_STALE_CHAPTERS = 8;
/** 天数待确认的先列几处。 */
const MAX_TIME_TODOS = 3;

function chapterList(numbers: readonly number[]): string {
  const shown = numbers.slice(0, 6).join("、");
  return `第 ${shown}${numbers.length > 6 ? " 等" : ""} 章`;
}

export function buildInboxTodos(input: {
  readonly chapters: readonly ChapterNavItem[];
  readonly overview: (Pick<StateOverview, "threads" | "arcGoals"> & Partial<Pick<StateOverview, "protagonistSuggestion" | "timeChecks">>) | null | undefined;
  readonly currentChapterNumber: number;
  /** 导入的书还在通读记账（P8）：后面的章还没记账，前面开的线索、主线看着「很久没推进」是假的，这两条先不提。 */
  readonly rereading?: boolean;
}): InboxTodo[] {
  const todos: InboxTodo[] = [];
  const written = input.chapters.filter((ch) => ch.status !== "planned");
  const latest = Math.max(input.currentChapterNumber, ...written.map((ch) => ch.chapterNumber), 0);

  const protagonist = input.rereading ? undefined : input.overview?.protagonistSuggestion;
  if (protagonist) {
    todos.push({
      key: "protagonist",
      title: "还没标主角",
      sub: `${protagonist.viewpointChapters} 章跟着${protagonist.name}的视角走`,
      action: `设${protagonist.name}为主角`,
      prefill: `把「${protagonist.name}」设为主角`,
      ops: protagonist.carded
        ? [{ op: "card.protagonist", card: protagonist.name }]
        : [{ op: "card.create", kind: "character", name: protagonist.name, protagonist: true }],
    });
  }

  // 天数要你看的（写作版本 P3a）：导入时记成你定的待确认 → 「对，是这天」；作者定的和记下的对不上 → 「以我定的为准」；
  // 两处写明的星期算不拢、换天规矩改了不知道了 → 让 AI 对着正文看。最多列 3 章，多的让 AI 一起看。
  const timeChecks = input.overview?.timeChecks ?? [];
  for (const check of timeChecks.slice(0, MAX_TIME_TODOS)) {
    if (check.kind === "unproven" && check.day !== undefined) {
      todos.push({
        key: `time-${check.chapter}-${check.kind}`,
        title: `第 ${check.chapter} 章是第 ${check.day} 天吗`,
        sub: check.text,
        action: `对，是第 ${check.day} 天`,
        prefill: `第 ${check.chapter} 章是故事第 ${check.day} 天`,
        userAction: newLedgerAction([{ op: "day", chapter: check.chapter, day: check.day }]),
      });
    } else if (check.kind === "weekday") {
      todos.push({
        key: `time-${check.chapter}-${check.kind}`,
        title: `第 ${check.chapter} 章的星期对不上`,
        sub: check.text,
        action: "让 AI 对一下",
        prefill: `第 ${check.chapter} 章写的星期和前面推的对不上，对着正文看一下是星期写错了还是天数记错了，再跟我确认`,
      });
    } else if (check.kind === "conflict") {
      todos.push({
        key: `time-${check.chapter}-${check.kind}`,
        title: `第 ${check.chapter} 章的天数对不上`,
        sub: check.text,
        action: "以我定的为准",
        prefill: `第 ${check.chapter} 章的天数以我定的为准`,
        userAction: newLedgerAction([{ op: "keepDay", chapter: check.chapter }]),
      });
    } else {
      todos.push({
        key: `time-${check.chapter}-${check.kind}`,
        title: `第 ${check.chapter} 章是哪天不知道了`,
        sub: check.text,
        action: "让 AI 对一下",
        prefill: `第 ${check.chapter} 章是故事第几天不知道了，对着正文看一下，再跟我确认`,
      });
    }
  }
  if (timeChecks.length > MAX_TIME_TODOS) {
    const rest = timeChecks.slice(MAX_TIME_TODOS).map((check) => check.chapter);
    todos.push({
      key: "time-more",
      title: `还有 ${rest.length} 处天数要你看`,
      sub: chapterList([...new Set(rest)]),
      action: "让 AI 列给我",
      prefill: "把天数要我确认的那几章列给我，一章一章说清楚",
    });
  }

  const cleanup = input.rereading ? 0 : input.overview?.threads.cleanupVisibleCount ?? 0;
  if (cleanup > 0) {
    todos.push({
      key: "threads-cleanup",
      title: `${cleanup} 条线索好几章没动`,
      sub: "可能早就收了、或意思重复",
      action: "让 AI 理一遍",
      prefill: "把开着的线索理一遍，看看哪些其实已经收了",
    });
  }

  for (const goal of input.rereading ? [] : input.overview?.arcGoals.activeItems ?? []) {
    const last = goal.lastTouchedChapter;
    if (typeof last !== "number" || latest - last < ARC_STALE_CHAPTERS) continue;
    todos.push({
      key: `arc-${goal.id}`,
      title: `主线目标 ${latest - last} 章没推进`,
      sub: `「${goal.title}」`,
      action: "让 AI 安排",
      prefill: `主线「${goal.title}」很久没推进了，帮我想想接下来两三章怎么接上`,
    });
    if (todos.filter((t) => t.key.startsWith("arc-")).length >= 2) break;
  }

  // 只看定稿了的章：正在写的章标题多半还是「第N章」，出稿或定稿时才起（长篇连写：给正在写的章提示「还没起标题」）。
  const placeholders = written
    .filter((ch) => ch.status === "committed" && isPlaceholderChapterTitle(chapterBareTitle(ch.title ?? "").trim()))
    .map((ch) => ch.chapterNumber)
    .sort((a, b) => a - b);
  if (placeholders.length > 0) {
    todos.push({
      key: "placeholder-titles",
      title: placeholders.length === 1 ? `第 ${placeholders[0]} 章还没起标题` : `${placeholders.length} 章还没起标题`,
      sub: placeholders.length === 1 ? `现在叫「${chapterBareTitle(written.find((c) => c.chapterNumber === placeholders[0])?.title ?? "")}」` : chapterList(placeholders),
      action: "让 AI 起名",
      prefill: placeholders.length === 1
        ? `给第 ${placeholders[0]} 章起个标题，给我三个选项`
        : `${chapterList(placeholders)}还没有像样的标题，帮我各起一个，先给方案`,
    });
  }

  const byTitle = new Map<string, number[]>();
  for (const ch of written) {
    const title = chapterBareTitle(ch.title ?? "").trim();
    if (!title || isPlaceholderChapterTitle(title)) continue;
    byTitle.set(title, [...(byTitle.get(title) ?? []), ch.chapterNumber]);
  }
  const duplicates = [...byTitle.entries()]
    .filter(([, nums]) => nums.length >= 3)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 2);
  for (const [title, nums] of duplicates) {
    const sorted = [...nums].sort((a, b) => a - b);
    todos.push({
      key: `dup-${title}`,
      title: `${sorted.length} 章用了同一个标题「${title}」`,
      sub: chapterList(sorted),
      action: "让 AI 改名",
      prefill: `${chapterList(sorted)}都叫「${title}」，帮我各起一个能区分的标题，先给方案`,
    });
  }

  return todos;
}
