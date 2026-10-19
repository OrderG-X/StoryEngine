/**
 * commit_preview — 定稿预览（重构 P3 起走新编辑部，见 docs/rebuild/P3-design.md 第二节）：
 *
 *   读工作稿 → 硬闸（空的 / 只有标题 / 太短 / 混进工具 JSON 或模型解释话）→ 书接到新核心（老书先导入）
 *   → 记账员一次交账单 → 核原句 → 分流（要你看的 / 自动记下的 / 没记上的）→ 存预览票
 *
 * 不写真相；预览票只是缓存（`ledger/.preview/`，丢了重新预览）。清单投影成「定稿预览」卡认的 ledgerChecklist：
 * 条目 id 就是清单序号；默认不写、作者勾上才写的条目 id 带 `change_confirm:` 前缀（和「确认定稿」按钮的分流同口径）。
 */
import { checkDraftHardGates } from "../../writing/commit-quality-check.js";
import { createTool } from "@mastra/core/tools";
import type { ToolExecutionContext } from "@mastra/core/tools";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { readCardsOrLegacy } from "@actalk/story-core";

import { callConfiguredBrainModel, catchUpReaders, rereadBlocker, type BrainCallModel } from "../../editorial/index.js";
import { fileTicketStore, prepareChapterCommit, type CommitItem, type CommitPreview, type TicketStore } from "../../editorial/commit-flow.js";
import { describeReaderWait } from "../../editorial/reader-progress.js";
import { ensureBookOnCore } from "../../book/mirror/ensure.js";
import { QUALITY_TYPE_LABELS } from "../../writing/quality-report-refine.js";
import { coreSnapshotFor } from "../../lib/snapshot.js";
import { defaultDraftPath } from "../../lib/project-io.js";
import { withStep } from "../../lib/token-meter.js";
import { readProjectDirFromContext, resolveChapterFromInputOrContext } from "../request-context.js";
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
  ledgerChecklist: z.array(z.object({
    id: z.string(),
    kind: z.string(),
    label: z.string(),
    reason: z.string().optional(),
    detail: z.string().optional(),
    removable: z.boolean(),
    editableDay: z.number().int().optional(),
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
}): Promise<CommitPreviewToolOutput> {
  const { projectDir, chapter } = input;
  const text = await readFile(defaultDraftPath(projectDir, chapter), "utf-8").catch(() => undefined);
  if (text === undefined || text.trim().length === 0) {
    return blocked(chapter, [`第 ${chapter} 章还没有工作稿，先写正文再定稿。`], `第 ${chapter} 章还没有工作稿，没法定稿。`);
  }

  // 导入的书还在通读记账（P8）：前文的账没记全，这一章的账对不上前文。
  const rereading = await rereadBlocker(projectDir, "定稿");
  if (rereading) return blocked(chapter, [rereading], rereading);

  const gates = (await checkDraftHardGates({ projectDir, draftContent: text })).map((issue) => ({ severity: issue.severity, type: issue.type, message: issue.message }));
  if (gates.length > 0) {
    const reasons = gates.map(describeGate);
    return {
      ...blocked(chapter, reasons, `第 ${chapter} 章现在还定不了：${reasons.join("；")}。`),
      // 引擎原话是英文，给人看的（卡片里点开的明细）换成同一句中文说法。
      draftQualityIssues: gates.map((issue, index) => ({ ...issue, message: reasons[index]! })),
      ...(gates.some((issue) => issue.type === "too_short")
        ? { modelHint: "字数不足是硬阻断：先和作者商量扩写方向、把工作稿写够，再重新预览；不要在字数不足时反复预览。" }
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
  return fromPreview(preview);
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

function describeGate(issue: { readonly type: string; readonly message: string }): string {
  if (issue.type === "too_short") return describeLengthShortfall(issue.message);
  return QUALITY_TYPE_LABELS[issue.type] ?? "正文过不了定稿硬闸";
}

/**
 * too_short 的引擎消息形如 `Draft body is shorter than 2250 Chinese characters (current: 2000).`，
 * 只从里面取两个数字；取不到也给定性文案，绝不吞掉长度阻断。
 */
function describeLengthShortfall(message: string): string {
  const min = /shorter than (\d+)/u.exec(message)?.[1];
  const current = /current: (\d+)/u.exec(message)?.[1];
  if (min === undefined) return `正文字数低于写作规则要求的下限，需扩写后再定稿${LENGTH_RULE_HINT}`;
  return current === undefined
    ? `正文字数低于写作规则要求的下限 ${min} 字，需扩写后再定稿${LENGTH_RULE_HINT}`
    : `正文 ${current} 字，低于写作规则要求的下限 ${min} 字（只数汉字，不含标点和标题），需扩写后再定稿${LENGTH_RULE_HINT}`;
}

/** 下限是作者自己的写作规则：手写短章的作者得知道去哪改（重构 P6 第 7 步）。 */
const LENGTH_RULE_HINT = "。这一章就该这么短的话，可以跟右边的 AI 说把每章字数下限改低";

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

function dayLabel(preview: CommitPreview): string {
  const { time } = preview;
  const span = time.dayEnd > time.day ? `故事第 ${time.day} 天到第 ${time.dayEnd} 天` : `故事第 ${time.day} 天`;
  const extra = [time.timeOfDay, time.weekday !== undefined ? `星期${"日一二三四五六"[time.weekday % 7]}` : undefined].filter(Boolean).join("，");
  const basis = time.basis === "text"
    ? "（正文明写）"
    : time.basis === "author"
      ? "（你定的）"
      : time.basis === "judged"
        ? "（按前后文判断）"
        : "（正文里没找到时间说法，先按上一章往后推，不对就改）";
  return `这一章记为${span}${extra ? `（${extra}）` : ""}${basis}`;
}

function fromPreview(preview: CommitPreview): CommitPreviewToolOutput {
  const timeItems = (items: readonly CommitItem[]) => items.filter((item) => item.kind === "time");
  const others = (items: readonly CommitItem[]) => items.filter((item) => item.kind !== "time");
  const timeQuote = [...timeItems(preview.review), ...timeItems(preview.auto)].find((item) => item.quote)?.quote;
  const ledgerChecklist: ChecklistItem[] = [
    {
      id: "day",
      kind: "time",
      label: dayLabel(preview),
      ...(timeQuote ? { detail: timeQuote } : {}),
      removable: false,
      editableDay: preview.time.day,
      ...(preview.time.needsConfirm ? { needsConfirm: true } : {}),
    },
    ...others(preview.review).map((item) => toChecklistItem(item, true)),
    ...others(preview.auto).map((item) => toChecklistItem(item, false)),
  ];
  const reviewCount = others(preview.review).length + (preview.time.needsConfirm ? 1 : 0);
  const autoCount = others(preview.auto).length;
  const notRecorded = preview.notRecorded.map((item) => `${item.label}：${item.reason}`);
  const notes: string[] = [];
  if (notRecorded.length > 0) notes.push(`有 ${notRecorded.length} 条原句对不上或指向前文没有的，没记上`);
  if (preview.recommit) notes.push("这章定稿过，这次会换掉原来的账");
  if (preview.omittedThreads > 0 || preview.omittedFacts > 0) {
    notes.push(`前文太长，记账员这次没看全（另有 ${preview.omittedThreads} 条线索、${preview.omittedFacts} 条事实没列给它）`);
  }
  if (preview.cold) {
    const raw = preview.cold.rawFrom > 0 ? `加第 ${preview.cold.rawFrom}～${preview.cold.rawTo} 章原文` : "";
    notes.push(`记账员还在读前文（笔记到第 ${preview.cold.notedThrough} 章），这次按已有笔记${raw}记的`);
  }
  if (preview.waited) notes.push(describeReaderWait("ledger", preview.waited, "记账"));
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
      "预览通过：请作者看清单、点预览卡上的「确认定稿」按钮写入（写入前自动存档、可撤销）。你不要说『已定稿』；" +
      "作者口头说确认定稿时可调 commit_apply，它只会再给作者出一个确认按钮。summary 里【】内的提醒要如实转达。",
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
    return buildCommitPreviewToolOutput({ projectDir, chapter });
  },
});
