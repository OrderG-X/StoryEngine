/**
 * 定稿清单和定稿回执给界面的样子（重构 P3 的 commit_preview / commit_apply 两个工具里挪出来；写作版本 P2a 片 4A 起由
 * commit.prepare 配方出）：清单卡（定稿弹窗）认的 `ledgerChecklist`、定不了时的原因、定完以后回执卡的条数和那一句话。
 *
 * 清单上每一行的键（作者点「不记」「改记」带回来的）：自动记下 / 要你看的是 `i<序号>`（并成一行的几条以第一条的序号为键，
 * 去掉这行就一起去掉），默认不写、作者勾上才写的是 `o<序号>`。天数那一行不是条目，键是 `day`，改的是天数两栏。
 */
import { nameKey, parseDraftFile, project, readBookSnapshot, readCardsOrLegacy, readChapterLedger, readChapterPaper, type ChapterCommitResult } from "@actalk/story-core";
import { WEEKDAY_NAMES } from "../book/story-timeline.js";
import { markdownTitle } from "../book/story-views.js";
import { COLD_PAUSED_TEXT } from "../editorial/reader-window.js";
import { describeReaderWait } from "../editorial/reader-progress.js";
import type { CommitItem, CommitPreview } from "../editorial/commit-flow.js";
import type { CommitQualityIssue } from "../writing/commit-quality-check.js";
import { countDraftChineseCharacters } from "../writing/draft-length-control.js";
import { describeQualityIssue, QUALITY_TYPE_LABELS } from "../writing/quality-report-refine.js";

/** 默认记下（要你看的、自动记下的）那一行的键前缀。 */
const KEEP_PREFIX = "i";
/** 默认不写、作者勾上才写的那一行的键前缀。 */
const OPT_IN_PREFIX = "o";
/** 天数那一行。 */
export const DAY_ITEM_ID = "day";

export interface ChecklistItem {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly reason?: string;
  readonly detail?: string;
  readonly removable: boolean;
  readonly editableDay?: number;
  readonly editableDayEnd?: number;
  readonly needsConfirm?: boolean;
  readonly defaultUnchecked?: boolean;
}

/** 定稿清单卡（定稿弹窗）：能定的列清单，定不了的列原因。界面照摆，不自己拼字。 */
export interface CommitPreviewView {
  readonly chapter: number;
  readonly canCommit: boolean;
  readonly blockingReasons: readonly string[];
  /** 给作者看的一句话结论。 */
  readonly summary: string;
  /** 要如实告诉作者的提醒（记账员没读完前文、这章定稿过会换掉原来的账……）。 */
  readonly notes?: readonly string[];
  /** 记账员交了、但原句对不上或指向前文没有的东西，这次没记上的（带原因）。 */
  readonly notRecorded: readonly string[];
  /** 正文硬闸没过的地方（会挡定稿）。 */
  readonly draftIssues?: readonly string[];
  /** 只差字数下限：清单上给「就这么短，照样定稿」。 */
  readonly shortOnly?: boolean;
  readonly ledgerChecklist?: readonly ChecklistItem[];
}

/** 清单上作者动过的行 → 去掉的、勾上的条目序号（只认这张清单上有的键）。 */
export function choicesOfToggled(toggled: readonly string[], keys: Readonly<Record<string, readonly number[]>>): { readonly excluded: number[]; readonly optedIn: number[] } {
  const excluded: number[] = [];
  const optedIn: number[] = [];
  for (const id of toggled) {
    const indexes = keys[id];
    if (!indexes) continue;
    if (id.startsWith(OPT_IN_PREFIX)) optedIn.push(...indexes);
    else excluded.push(...indexes);
  }
  return { excluded, optedIn };
}

/** 定不了：原因列在清单卡上。 */
export function blockedView(chapter: number, reasons: readonly string[], summary: string, extra: Partial<Pick<CommitPreviewView, "draftIssues" | "shortOnly">> = {}): CommitPreviewView {
  return { chapter, canCommit: false, blockingReasons: [...reasons], summary, notRecorded: [], ...extra };
}

/**
 * 下限是作者自己的写作规则（重构 P6 第 7 步）。这一章就该这么短，作者点按钮放这一章；不用为一章去改全书下限
 * （作者长篇实跑 2026-10-26：手写的第 36 章收在悬念上 1137 字，只能去改每章下限才定得了）。
 */
const LENGTH_RULE_HINT = "。这章就该这么短的话，点「就这么短，照样定稿」";

export function describeGate(issue: CommitQualityIssue): string {
  if (issue.type === "too_short") return `${describeQualityIssue(issue)}${LENGTH_RULE_HINT}`;
  return QUALITY_TYPE_LABELS[issue.type] ?? "正文过不了定稿硬闸";
}

/**
 * 字数下限是作者后来定的、这章原来就按短的定了稿：回头改个错字再定稿，不拿下限挡（作者长篇实跑 2026-10-26：
 * 第 3 章删一段重复，被后定的「至少 2000 字」挡住，提示还叫作者把全书下限改低）。返回下限字数；不是这种情况回 undefined。
 */
export async function committedShortOf(projectDir: string, chapter: number, gates: readonly CommitQualityIssue[]): Promise<number | undefined> {
  const short = gates.find((issue) => issue.type === "too_short")?.length;
  if (!short) return undefined;
  const committed = (await readChapterPaper(projectDir, chapter)).committed;
  return committed && countDraftChineseCharacters(committed.body) < short.min ? short.min : undefined;
}

function toChecklistItem(item: CommitItem, review: boolean): ChecklistItem {
  const why = item.reasons.map((reason) => reason.text).join("；");
  return {
    id: `${item.optIn ? OPT_IN_PREFIX : KEEP_PREFIX}${item.index}`,
    kind: item.kind,
    label: item.label,
    // 为什么要作者看：单独一栏，清单里同一原因的条目归在一起只说一遍（重构 P6）。
    ...(review && why ? { reason: why } : {}),
    ...(item.quote ? { detail: item.quote } : {}),
    removable: true,
    ...(review ? { needsConfirm: true } : {}),
    ...(item.optIn ? { defaultUnchecked: true } : {}),
  };
}

const daySpan = (day: number, dayEnd: number) => (dayEnd > day ? `第 ${day} 天到第 ${dayEnd} 天` : `第 ${day} 天`);

/** 重定稿天数和上次不一样：为什么要作者看（照上次的记了 / 这次按新的记）。 */
function dayReason(preview: CommitPreview): string | undefined {
  const since = preview.time.sinceLast;
  if (!since) return undefined;
  const other = daySpan(since.otherDay, since.otherDayEnd);
  return since.kept
    ? `记账员这次看成${other}，和上次定稿不一样；先照上次的记，不对就改天数`
    : `上次定稿记的是${other}，记时间的那句改过了，这次按新的记；不对就改天数`;
}

function dayLabel(preview: CommitPreview): string {
  const { time } = preview;
  const span = `故事${daySpan(time.day, time.dayEnd)}`;
  const extra = [time.timeOfDay, time.weekday !== undefined ? WEEKDAY_NAMES[time.weekday] : undefined].filter(Boolean).join("，");
  const basis = time.sinceLast?.kept
    ? "（照上次定稿）"
    : time.basis === "text"
      ? "（正文明写）"
      : time.basis === "author"
        ? "（你定的）"
        : time.basis === "judged"
          ? "（按前后文判断）"
          : time.basis === "estimated"
            ? "（正文没说离上一章隔了几天，先按第二天记，不对就改）"
            : preview.chapter <= 1
              ? "（正文里没找到时间说法，先这么记，不对就改）"
              : "（正文里没找到时间说法，先按上一章往后推，不对就改）";
  return `这一章记为${span}${extra ? `（${extra}）` : ""}${basis}`;
}

/** 能定稿的清单：天数一行在最前，要作者看的随后，自动记下的最后；keys = 每行的键 → 条目序号。 */
export function checklistView(preview: CommitPreview, extraNotes: readonly string[]): { readonly view: CommitPreviewView; readonly keys: Record<string, number[]> } {
  const timeItems = (items: readonly CommitItem[]) => items.filter((item) => item.kind === "time");
  const others = (items: readonly CommitItem[]) => items.filter((item) => item.kind !== "time");
  const timeQuote = [...timeItems(preview.review), ...timeItems(preview.auto)].find((item) => item.quote)?.quote;
  const keys: Record<string, number[]> = {};
  for (const item of [...others(preview.review), ...others(preview.auto)]) {
    keys[`${item.optIn ? OPT_IN_PREFIX : KEEP_PREFIX}${item.index}`] = [item.index, ...(item.merged ?? [])];
  }
  const ledgerChecklist: ChecklistItem[] = [
    {
      id: DAY_ITEM_ID,
      kind: "time",
      label: dayLabel(preview),
      ...(dayReason(preview) ? { reason: dayReason(preview) } : {}),
      ...(timeQuote ? { detail: timeQuote } : {}),
      removable: false,
      editableDay: preview.time.day,
      ...(preview.time.dayEnd > preview.time.day ? { editableDayEnd: preview.time.dayEnd } : {}),
      ...(preview.time.needsConfirm ? { needsConfirm: true } : {}),
    },
    ...others(preview.review).map((item) => toChecklistItem(item, true)),
    ...others(preview.auto).map((item) => toChecklistItem(item, false)),
  ];
  const reviewCount = others(preview.review).length + (preview.time.needsConfirm ? 1 : 0);
  const autoCount = others(preview.auto).length;
  const notRecorded = preview.notRecorded.map((item) => `${item.label}：${item.reason}`);
  const notes: string[] = [];
  if (notRecorded.length > 0) notes.push(`有 ${notRecorded.length} 条没记上（原因在清单里）`);
  if (preview.recommit) notes.push("这章定稿过，这次会换掉原来的账");
  if (preview.lostThreads && preview.lostThreads.length > 0) {
    notes.push(`这章原来开的${preview.lostThreads.slice(0, 3).map((title) => `「${title}」`).join("")}这次没记上，后文还接着它；定稿后它就没了开头`);
  }
  if (preview.omittedThreads > 0 || preview.omittedFacts > 0) {
    notes.push(`前文太长，记账员这次没看全（另有 ${preview.omittedThreads} 条线索、${preview.omittedFacts} 条事实没列给它）`);
  }
  if (preview.cold) {
    const raw = preview.cold.rawFrom > 0 ? `加第 ${preview.cold.rawFrom}～${preview.cold.rawTo} 章原文` : "";
    notes.push(`记账员还在读前文（笔记到第 ${preview.cold.notedThrough} 章），这次按已有笔记${raw}记的`);
    if (preview.cold.pausedBackfill) notes.push(COLD_PAUSED_TEXT);
  }
  if (preview.waited) notes.push(describeReaderWait("ledger", preview.waited, "记账"));
  notes.push(...extraNotes);
  const head = reviewCount > 0
    ? `第 ${preview.chapter} 章可以定稿：要你看 ${reviewCount} 条，其余 ${autoCount} 条自动记下（不对的都能去掉）。`
    : `第 ${preview.chapter} 章可以定稿：${autoCount} 条自动记下（不对的都能去掉）。`;
  return {
    view: {
      chapter: preview.chapter,
      canCommit: true,
      blockingReasons: [],
      summary: notes.length > 0 ? `${head}${notes.map((note) => `【${note}】`).join("")}` : head,
      ...(notes.length > 0 ? { notes } : {}),
      notRecorded,
      ledgerChecklist,
    },
    keys,
  };
}

/** 开着的线索堆到这个数，定稿后的下一步选项里摆「归并线索」（只给选项，真归并要作者点「确认改账」）。 */
export const THREAD_STALE_ESCALATION_THRESHOLD = 30;
/** 开着的线索到这个数，回执里提一句；之后每多这么些条再提一次（不是每次定稿都念）。 */
export const OPEN_THREADS_HINT_THRESHOLD = 20;
const OPEN_THREADS_HINT_STEP = 5;
/** 没建卡的人出场满这么多章（这章正好满），回执里点一次名。 */
export const RECURRING_UNCARDED_THRESHOLD = 3;

/** 这次定稿让开着的线索跨过了 20、25、30……中的一档，才提「归并线索」。 */
export function openThreadsHintDue(before: number, after: number): boolean {
  const band = (open: number): number => (open < OPEN_THREADS_HINT_THRESHOLD ? 0 : 1 + Math.floor((open - OPEN_THREADS_HINT_THRESHOLD) / OPEN_THREADS_HINT_STEP));
  return band(after) > band(before);
}

/** 定稿回执卡上的账：这一章记了多少条。 */
export interface CommitLedgerReport {
  readonly chapter: number;
  readonly chapterPath: string;
  readonly ledger: {
    readonly facts: number;
    readonly threadsOpened: number;
    readonly threadsAdvanced: number;
    readonly threadsClosed: number;
    readonly present: number;
    readonly day: number;
    readonly dayEnd: number;
    readonly notRecorded: number;
  };
}

/** 定完以后：回执卡的条数、给作者的那一句话、定稿后的正文（稿纸以「已定稿」载入）。没有条数和正文的是回放旧定稿、盘上已经是后来的那份（supersededCommitView）。 */
export interface CommitDone {
  readonly report?: CommitLedgerReport;
  readonly summary: string;
  readonly draftBody?: string;
  readonly draftTitle?: string;
  readonly threadMaintenanceHint?: "escalated";
}

/**
 * 回放一次旧定稿（写成了、记检查点之前断了），这章之后又定过 / 撤过：盘上的正文和账是后来的，不拿来冒充这次的条数和正文
 * （Astra 第 14 轮第 2 条）。只说回执里有的：定成了、没记上的那几条。
 */
export function supersededCommitView(chapter: number, result: ChapterCommitResult): CommitDone {
  const parts = [
    `第 ${chapter} 章这次的定稿已经写成了，记了 ${result.recorded} 条；这章之后又改过，细目不列了。`,
    ...(result.rejected.length > 0 ? [`那次有 ${result.rejected.length} 条没记上：${result.rejected.slice(0, 3).map((item) => item.message).join("；")}。`] : []),
  ];
  return { summary: parts.join(" ") };
}

/** 定稿成了：照定稿后的账算回执（读的是盘上刚写好的）。 */
export async function commitDoneView(projectDir: string, chapter: number, text: string, result: ChapterCommitResult): Promise<CommitDone> {
  const ledger = await readChapterLedger(projectDir, chapter);
  const entries = ledger?.entries ?? [];
  const count = (predicate: (entry: (typeof entries)[number]) => boolean): number => entries.filter(predicate).length;
  const after = project(await readBookSnapshot(projectDir));
  const view = after.chapters.find((item) => item.chapter === chapter);
  const cards = await readCardsOrLegacy(projectDir);
  const known = new Set(cards.cards.filter((card) => card.kind === "character").flatMap((card) => [card.name, ...card.aliases]).map(nameKey));
  // 作者说过不用建卡的，也不再点名。
  for (const name of cards.skipped) known.add(nameKey(name));
  const uncarded = after.cast.filter((member) => member.chapters.includes(chapter) && !known.has(member.key) && !member.aliases.some((alias) => known.has(nameKey(alias))));
  const newCharacters = uncarded.filter((member) => member.chapters[0] === chapter).map((member) => member.name);
  // 没建卡、这章正好第 N 次出场的：点一次名（账里算，不另记备忘；建了卡自然不再提）。
  const recurring = uncarded
    .filter((member) => member.chapters.filter((item) => item <= chapter).length === RECURRING_UNCARDED_THRESHOLD)
    .map((member) => member.name);
  const report: CommitLedgerReport = {
    chapter,
    chapterPath: `chapters/${String(chapter).padStart(4, "0")}.md`,
    ledger: {
      facts: count((entry) => entry.kind === "fact"),
      threadsOpened: count((entry) => entry.kind === "thread" && entry.op === "open"),
      threadsAdvanced: count((entry) => entry.kind === "thread" && entry.op === "advance"),
      threadsClosed: count((entry) => entry.kind === "thread" && entry.op === "close"),
      present: count((entry) => entry.kind === "presence"),
      day: view?.day ?? 1,
      dayEnd: view?.dayEnd ?? view?.day ?? 1,
      notRecorded: result.rejected.length,
    },
  };
  const openThreads = after.threads.filter((thread) => thread.status !== "closed").length;
  const openBefore = openThreads - report.ledger.threadsOpened + report.ledger.threadsClosed;
  const parts = [
    // 记了几条在定稿回执卡上，这里不复述（重构 P6：一回合一句结论）；撤销在定稿回执卡上。
    `第 ${chapter} 章已定稿${result.recommitted ? "（换掉了原来的账）" : ""}。`,
    ...(result.rejected.length > 0 ? [`有 ${result.rejected.length} 条没记上：${result.rejected.slice(0, 3).map((item) => item.message).join("；")}。`] : []),
    ...(result.orphanedThreads.length > 0
      ? [`换账后有 ${result.orphanedThreads.length} 条线索后文还在推进、这章却不再开它：${result.orphanedThreads.slice(0, 3).map((title) => `「${title}」`).join("")}，要看一下。`]
      : []),
    ...(newCharacters.length > 0 ? [`这章还出现了新人物：${newCharacters.join("、")}——要给谁建卡，在设定本「还没建卡」里点一下就行。`] : []),
    ...(recurring.length > 0 ? [`${recurring.map((name) => `「${name}」`).join("、")}已经出场 ${RECURRING_UNCARDED_THRESHOLD} 章了，还没有人物卡。`] : []),
    ...(openThreadsHintDue(openBefore, openThreads) ? [`另外，开着的线索已积到 ${openThreads} 条——有讲同一件事的可以说「归并线索」。`] : []),
  ];
  const title = markdownTitle(text);
  return {
    report,
    summary: parts.join(" "),
    draftBody: parseDraftFile(text).body,
    ...(title ? { draftTitle: title } : {}),
    ...(openThreads >= THREAD_STALE_ESCALATION_THRESHOLD ? { threadMaintenanceHint: "escalated" as const } : {}),
  };
}
