/**
 * commit_preview — 定稿预览（重构 P3 起走新编辑部，见 docs/rebuild/P3-design.md 第二节）：
 *
 *   读工作稿 → 硬闸（空的 / 只有标题 / 太短 / 混进工具 JSON 或模型解释话）→ 书接到新核心（老书先导入）
 *   → 记账员一次交账单 → 核原句 → 分流（要你看的 / 自动记下的 / 没记上的）→ 存预览票
 *
 * 不写真相；预览票只是缓存（`ledger/.preview/`，丢了重新预览）。清单投影成「定稿预览」卡认的 ledgerChecklist：
 * 条目 id 就是清单序号；默认不写、作者勾上才写的条目 id 带 `change_confirm:` 前缀（和「确认定稿」按钮的分流同口径）。
 */
import { checkDraftHardGates, type CommitQualityIssue } from "../../writing/commit-quality-check.js";
import { countDraftChineseCharacters } from "../../writing/draft-length-control.js";
import { createTool } from "@mastra/core/tools";
import type { ToolExecutionContext } from "@mastra/core/tools";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { readCardsOrLegacy, readChapterPaper } from "@actalk/story-core";

import { callConfiguredBrainModel, catchUpReaders, rereadBlocker, type BrainCallModel } from "../../editorial/index.js";
import { fileTicketStore, prepareChapterCommit, type CommitItem, type CommitPreview, type TicketStore } from "../../editorial/commit-flow.js";
import { describeReaderWait } from "../../editorial/reader-progress.js";
import { ensureBookOnCore } from "../../book/mirror/ensure.js";
import { describeQualityIssue, QUALITY_TYPE_LABELS } from "../../writing/quality-report-refine.js";
import { WEEKDAY_NAMES } from "../../book/story-timeline.js";
import { coreSnapshotFor } from "../../lib/snapshot.js";
import { defaultDraftPath } from "../../lib/project-io.js";
import { withStep } from "../../lib/token-meter.js";
import { isUserConfirmedTool, readProjectDirFromContext, resolveChapterFromInputOrContext } from "../request-context.js";
import { coerceNumber } from "../../lib/lenient-args.js";

/** 记账员当场最多补多少章笔记；超过就按「已有笔记 + 最近几章原文」记（冷窗口），笔记在后台补。 */
const LEDGER_MAX_CATCH_UP = 10;
/** 默认不写、作者勾上才写的条目 id 前缀（「确认定稿」按钮按它分流）。 */
export const OPT_IN_PREFIX = "change_confirm:";
/** 预览票的目录（相对书目录）。只是缓存：不进撤销快照。 */
export const PREVIEW_TICKET_DIR = "ledger/.preview";

const ticketStores = new Map<string, TicketStore>();
/** 每本书每章最近一次通过的预览票号（建议条上的「确认定稿」、模型发起的定稿请求没带票号时用）。进程重启就没了，如实请作者重新预览。 */
const latestTickets = new Map<string, string>();

export function latestTicketFor(projectDir: string, chapter: number): string | undefined {
  return latestTickets.get(`${projectDir}\u0000${chapter}`);
}

/** 每本书一个预览票仓库（内存 + 文件，进程重启后确认定稿也不用重新调模型）。 */
export function ticketStoreFor(projectDir: string): TicketStore {
  let store = ticketStores.get(projectDir);
  if (!store) {
    store = fileTicketStore(join(projectDir, PREVIEW_TICKET_DIR));
    ticketStores.set(projectDir, store);
  }
  return store;
}

const inputSchema = z.object({
  chapter: coerceNumber(z.number().int().positive().optional().describe("要预览定稿的章号。")),
});

const issueSchema = z.object({ severity: z.string(), type: z.string(), message: z.string() });

const outputSchema = z.object({
  chapter: z.number().int().positive(),
  ok: z.boolean().describe("等于 canCommit。false = 这章现在定不了（没有工作稿、正文过不了硬闸、记账员没交成账）。"),
  canCommit: z.boolean(),
  previewToken: z.string().optional().describe("预览票号（「确认定稿」按钮带回）。你不用转述。"),
  draftQualityIssues: z.array(issueSchema).describe("正文硬闸没过的地方（会挡定稿）。"),
  semanticQualityIssues: z.array(issueSchema).describe("保留字段，新定稿链不再猜语义，恒为空。"),
  notRecorded: z.array(z.string()).describe("记账员交了、但原句对不上或指向前文没有的东西，这次没记上的（带原因）。"),
  blockingReasons: z.array(z.string()),
  summary: z.string().describe("给作者看的一句话结论。"),
  notes: z.array(z.string()).optional().describe("要如实告诉作者的提醒（记账员没读完前文、这章定稿过会换掉原来的账……），summary 里【】内的就是这些。"),
  modelHint: z.string().optional().describe("给你（模型）的行动指引，界面不展示。"),
  shortOnly: z.boolean().optional().describe("只差字数下限：定稿窗口里有「就这么短，照样定稿」按钮，作者点了只放这一章。"),
  ledgerChecklist: z.array(z.object({
    id: z.string(),
    kind: z.string(),
    label: z.string(),
    reason: z.string().optional(),
    detail: z.string().optional(),
    removable: z.boolean(),
    editableDay: z.number().int().optional(),
    editableDayEnd: z.number().int().optional(),
    needsConfirm: z.boolean().optional(),
    defaultUnchecked: z.boolean().optional(),
  })).optional().describe("定稿要记的账：要作者看的排在前面；界面列成清单给作者勾，你不用逐条转述。"),
});

export type CommitPreviewToolOutput = z.infer<typeof outputSchema>;

/** 定稿预览：硬闸 → 接新核心 → 记账员 → 清单。读不到工作稿、硬闸没过、记账员没交成，都如实给 canCommit=false。 */
export async function buildCommitPreviewToolOutput(input: {
  readonly projectDir: string;
  readonly chapter: number;
  /** 记账员用的模型调用（单测、考卷注入）；缺省用配置的模型。 */
  readonly callModel?: BrainCallModel;
  readonly maxCatchUp?: number;
  /** 作者点了「就这么短，照样定稿」（按钮才有，模型调不出来）：这一章不拿字数下限挡。 */
  readonly allowShort?: boolean;
}): Promise<CommitPreviewToolOutput> {
  const { projectDir, chapter } = input;
  const text = await readFile(defaultDraftPath(projectDir, chapter), "utf-8").catch(() => undefined);
  if (text === undefined || text.trim().length === 0) {
    return blocked(chapter, [`第 ${chapter} 章还没有工作稿，先写正文再定稿。`], `第 ${chapter} 章还没有工作稿，没法定稿。`);
  }

  // 导入的书还在通读记账（P8）：前文的账没记全，这一章的账对不上前文。
  const rereading = await rereadBlocker(projectDir, "定稿");
  if (rereading) return blocked(chapter, [rereading], rereading);

  const allGates = await checkDraftHardGates({ projectDir, draftContent: text });
  const short = allGates.find((issue) => issue.type === "too_short")?.length;
  const shortBefore = await committedShortOf(projectDir, chapter, allGates);
  const shortAllowed = short !== undefined && (shortBefore !== undefined || input.allowShort === true);
  const gates = shortAllowed ? allGates.filter((issue) => issue.type !== "too_short") : allGates;
  if (gates.length > 0) {
    const reasons = gates.map(describeGate);
    const shortOnly = gates.every((issue) => issue.type === "too_short");
    return {
      ...blocked(chapter, reasons, `第 ${chapter} 章现在还定不了：${reasons.join("；")}。`),
      // 引擎原话是英文，给人看的（卡片里点开的明细）换成同一句中文说法。
      draftQualityIssues: gates.map((issue, index) => ({ severity: issue.severity, type: issue.type, message: reasons[index]! })),
      ...(shortOnly ? { shortOnly: true } : {}),
      ...(gates.some((issue) => issue.type === "too_short")
        ? { modelHint: "字数不到下限：问作者是扩写还是就这么短。就这么短的话，请作者在定稿窗口点「就这么短，照样定稿」（你替不了）；别在字数不足时反复预览。" }
        : {}),
    };
  }

  const onCore = await ensureBookOnCore(projectDir, { snapshot: coreSnapshotFor(projectDir) });
  if (!onCore.ok) {
    return blocked(chapter, [`这本书的账没能接到新格式上：${onCore.reason}`], `第 ${chapter} 章现在还定不了：这本书的账没能接到新格式上（${onCore.reason}）。`);
  }

  const cards = await readCardsOrLegacy(projectDir);
  const knownNames = cards.cards.filter((card) => card.kind === "character").flatMap((card) => [card.name, ...card.aliases]);
  const callModel = input.callModel ?? callConfiguredBrainModel;
  const preview = await withStep("记账员", () => prepareChapterCommit({
    bookDir: projectDir,
    chapter,
    text,
    callModel,
    tickets: ticketStoreFor(projectDir),
    knownNames,
    maxCatchUp: input.maxCatchUp ?? LEDGER_MAX_CATCH_UP,
  }));
  if (preview.cold) {
    // 记账员还没读完全书：这次按已有笔记 + 最近几章原文记的，笔记在后台接着补。
    void catchUpReaders(projectDir, chapter - 1, { ...(input.callModel ? { callModel: input.callModel } : {}), roles: ["ledger"] });
  }
  if (!preview.ok) {
    return blocked(chapter, [preview.reason], `第 ${chapter} 章现在还定不了：${preview.reason}`);
  }
  latestTickets.set(`${projectDir}\u0000${chapter}`, preview.ticket);
  const shortNote = !short || !shortAllowed
    ? []
    : shortBefore !== undefined
      ? [`这章原来定稿时就不到 ${short.min} 字，字数下限这次不挡`]
      : [`这章 ${short.current} 字，比字数下限 ${short.min} 字少；你点了照样定稿，只这一章`];
  return fromPreview(preview, shortNote);
}

/**
 * 字数下限是作者后来定的、这章原来就按短的定了稿：回头改个错字再定稿，不拿下限挡（作者长篇实跑 2026-10-26：
 * 第 3 章删一段重复，被后定的「至少 2000 字」挡住，提示还叫作者把全书下限改低）。返回下限字数；不是这种情况回 undefined。
 */
async function committedShortOf(projectDir: string, chapter: number, gates: readonly CommitQualityIssue[]): Promise<number | undefined> {
  const short = gates.find((issue) => issue.type === "too_short")?.length;
  if (!short) return undefined;
  const committed = (await readChapterPaper(projectDir, chapter)).committed;
  return committed && countDraftChineseCharacters(committed.body) < short.min ? short.min : undefined;
}

function blocked(chapter: number, reasons: readonly string[], summary: string): CommitPreviewToolOutput {
  return {
    chapter,
    ok: false,
    canCommit: false,
    draftQualityIssues: [],
    semanticQualityIssues: [],
    notRecorded: [],
    blockingReasons: [...reasons],
    summary,
  };
}

function describeGate(issue: CommitQualityIssue): string {
  if (issue.type === "too_short") return `${describeQualityIssue(issue)}${LENGTH_RULE_HINT}`;
  return QUALITY_TYPE_LABELS[issue.type] ?? "正文过不了定稿硬闸";
}

/**
 * 下限是作者自己的写作规则（重构 P6 第 7 步）。这一章就该这么短，作者点按钮放这一章；不用为一章去改全书下限
 * （作者长篇实跑 2026-10-26：手写的第 36 章收在悬念上 1137 字，只能去改每章下限才定得了）。
 */
const LENGTH_RULE_HINT = "。这章就该这么短的话，点「就这么短，照样定稿」";

type ChecklistItem = NonNullable<CommitPreviewToolOutput["ledgerChecklist"]>[number];

function toChecklistItem(item: CommitItem, review: boolean): ChecklistItem {
  const why = item.reasons.map((reason) => reason.text).join("；");
  return {
    id: item.optIn ? `${OPT_IN_PREFIX}${item.index}` : String(item.index),
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
          : preview.chapter <= 1
            ? "（正文里没找到时间说法，先这么记，不对就改）"
            : "（正文里没找到时间说法，先按上一章往后推，不对就改）";
  return `这一章记为${span}${extra ? `（${extra}）` : ""}${basis}`;
}

function fromPreview(preview: CommitPreview, extraNotes: readonly string[]): CommitPreviewToolOutput {
  const timeItems = (items: readonly CommitItem[]) => items.filter((item) => item.kind === "time");
  const others = (items: readonly CommitItem[]) => items.filter((item) => item.kind !== "time");
  const timeQuote = [...timeItems(preview.review), ...timeItems(preview.auto)].find((item) => item.quote)?.quote;
  const ledgerChecklist: ChecklistItem[] = [
    {
      id: "day",
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
  // 要作者看的是哪几条，点名给模型（换题材长篇实跑 2026-10-27：要看的是两个新出场的人，模型转述成了两条新开的线索）。
  const reviewLabels = [...(preview.time.needsConfirm ? ["这一章记为第几天"] : []), ...others(preview.review).map((item) => item.label)];
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
  }
  if (preview.waited) notes.push(describeReaderWait("ledger", preview.waited, "记账"));
  notes.push(...extraNotes);
  const head = reviewCount > 0
    ? `第 ${preview.chapter} 章可以定稿：要你看 ${reviewCount} 条，其余 ${autoCount} 条自动记下（不对的都能去掉）。`
    : `第 ${preview.chapter} 章可以定稿：${autoCount} 条自动记下（不对的都能去掉）。`;
  return {
    chapter: preview.chapter,
    ok: true,
    canCommit: true,
    previewToken: preview.ticket,
    draftQualityIssues: [],
    semanticQualityIssues: [],
    notRecorded,
    blockingReasons: [],
    summary: notes.length > 0 ? `${head}${notes.map((note) => `【${note}】`).join("")}` : head,
    ...(notes.length > 0 ? { notes } : {}),
    modelHint:
      "预览通过：请作者在定稿清单里点「确认定稿」写入（写入前自动存档、可撤销）。你不要说『已定稿』；" +
      "作者口头说确认定稿时可调 commit_apply，它只会再给作者出一个确认按钮。summary 里【】内的提醒要如实转达。" +
      (reviewLabels.length > 0 ? `要作者看的就是这几条（别说成别的）：${reviewLabels.join("；")}。` : ""),
    ledgerChecklist,
  };
}

export const commitPreviewTool = createTool({
  id: "commit_preview",
  description:
    "预览把某章工作稿定稿会记下哪些账（事实、线索、出场人物、故事第几天），不改任何文件。" +
    "作者想定稿、或想知道定稿会记什么时调用。预览通过后由作者点「确认定稿」按钮写入。",
  inputSchema,
  outputSchema,
  execute: async (input: z.infer<typeof inputSchema>, context: ToolExecutionContext) => {
    const projectDir = readProjectDirFromContext(context);
    if (!projectDir) {
      throw new Error("commit_preview 缺少 projectDir：请确认调用 agent 时通过 RequestContext 注入了 projectDir。");
    }
    const chapter = resolveChapterFromInputOrContext(input.chapter, context);
    if (chapter === undefined) {
      throw new Error("commit_preview 缺少章号：没给章号，前端也没带当前章。请明确指定章号。");
    }
    // 「就这么短，照样定稿」按钮（user-actions 标了作者确认）才放字数下限；模型自己调的照挡。
    return buildCommitPreviewToolOutput({ projectDir, chapter, ...(isUserConfirmedTool(context, "commit_preview") ? { allowShort: true } : {}) });
  },
});
