/**
 * commit_apply — 定稿（重构 P3 起走新核心，见 docs/rebuild/P3-design.md 第二节）：
 *
 *   取预览票 → 正文哈希对得上 → 减掉作者去掉的、套上作者改的天数 → 「定稿」命令（幂等键 = 票号）
 *   → 重生成老格式镜像 → 编辑部后台补笔记
 *
 * 授权：只有作者点了「确认定稿」按钮（结构化动作）才真写盘；模型自己调只会给作者出一个确认按钮。
 * 定稿前由 writeTool 存撤销点。确认时不再调模型——要记的账在预览时就交齐了。
 */
import { buildStateOverview, type StateOverview } from "../../book/state-overview.js";
import { nameKey, project, readBookSnapshot, readCardsOrLegacy, readChapterLedger } from "@actalk/story-core";
import { readFile } from "node:fs/promises";
import { z } from "zod";

import { warmUpReaders } from "../../editorial/index.js";
import { autoBackupAfterCommit } from "../../lib/book-backup.js";
import { recordChapterWords } from "../../lib/word-stats.js";
import { confirmChapterCommit, draftFingerprint } from "../../editorial/commit-flow.js";
import { markdownTitle, syncLegacyMirror } from "../../book/mirror/sync.js";
import { scrubLocalAbsolutePaths } from "../../lib/local-path-scrubber.js";
import { defaultDraftPath, stripLeadingMarkdownChapterHeading } from "../../lib/project-io.js";
import { isUserConfirmedTool, resolveChapterFromInputOrContext } from "../request-context.js";
import { writeTool } from "../withSnapshot.js";
import { latestTicketFor, OPT_IN_PREFIX, ticketStoreFor } from "./commit-preview.js";
import { coerceNumber } from "../../lib/lenient-args.js";

/** 开着的线索堆到这个数，定稿后的下一步选项里摆「归并线索」（只给选项，真归并要作者点「确认改账」）。 */
export const THREAD_STALE_ESCALATION_THRESHOLD = 30;
/** 开着的线索到这个数，回执里提一句；之后每多这么些条再提一次（不是每次定稿都念）。 */
export const OPEN_THREADS_HINT_THRESHOLD = 20;
const OPEN_THREADS_HINT_STEP = 5;

/** 这次定稿让开着的线索跨过了 20、25、30……中的一档，才提「归并线索」。 */
export function openThreadsHintDue(before: number, after: number): boolean {
  const band = (open: number): number => (open < OPEN_THREADS_HINT_THRESHOLD ? 0 : 1 + Math.floor((open - OPEN_THREADS_HINT_THRESHOLD) / OPEN_THREADS_HINT_STEP));
  return band(after) > band(before);
}
/** 没建卡的人出场满这么多章（这章正好满），回执里点一次名。 */
export const RECURRING_UNCARDED_THRESHOLD = 3;

const inputSchema = z.object({
  chapter: coerceNumber(z.number().int().positive().optional().describe("要定稿的章号。")),
  previewToken: z.string().optional().describe("预览票号（只由「确认定稿」按钮带来，你不用传）。"),
  excluded: z.array(z.string()).optional().describe("作者在清单上动过的条目（只由「确认定稿」按钮带来，你不用传）。"),
  dayOverride: z.number().int().positive().optional().describe("作者改的「第几天」（只由「确认定稿」按钮带来，你不用传）。"),
  dayEndOverride: z.number().int().positive().optional().describe("作者改的「到第几天」（只由「确认定稿」按钮带来，你不用传）。"),
});

const outputSchema = z.object({
  snapshotId: z.string().describe("定稿前的快照 id，前端凭此可一键撤销整次定稿。"),
  ok: z.boolean().describe("true = 真的定稿了；false = 没定稿（被拒或等作者点按钮）。"),
  committed: z.boolean(),
  refused: z.boolean(),
  refusalReason: z.string().optional(),
  blockedReason: z.string().optional().describe(
    "awaiting_user_confirmation = 等作者点「确认定稿」；no_preview / draft_changed_since_preview / no_draft = 还不能定稿。",
  ),
  needsConfirmation: z.boolean().optional().describe("true = 没写盘，界面已给作者出「确认定稿」按钮。"),
  confirmAction: z.object({
    toolName: z.literal("commit_apply"),
    chapter: z.number().int().positive(),
    previewToken: z.string().optional(),
  }).optional(),
  report: z.unknown().optional().describe("这次记了什么账（条数），界面渲染定稿卡用。"),
  draftBody: z.string().optional().describe("已定稿的正文（去掉标题行），前端以「已定稿」载入。"),
  draftTitle: z.string().optional(),
  overview: z.unknown().describe("定稿后的总览，前端刷新用。"),
  summary: z.string().describe("给作者看的结论。"),
  refreshScope: z.literal("full"),
  chapter: z.number().int().positive().optional(),
  threadMaintenanceHint: z.literal("escalated").optional().describe(
    `开着的线索已到 ${THREAD_STALE_ESCALATION_THRESHOLD} 条：收尾的 suggest_next_steps 里要摆「归并线索」选项（只给选项）。`,
  ),
});

export type CommitApplyToolOutput = Omit<z.infer<typeof outputSchema>, "snapshotId">;

/** 定稿卡上的账：这一章记了多少条。 */
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

function refusal(chapter: number, reason: string, blockedReason?: string): CommitApplyToolOutput {
  const safe = scrubLocalAbsolutePaths(reason);
  return {
    ok: false,
    committed: false,
    refused: true,
    refusalReason: safe,
    ...(blockedReason ? { blockedReason } : {}),
    overview: undefined,
    summary: `没定稿：${safe}`,
    refreshScope: "full",
    chapter,
  };
}

/** 清单上作者动过的条目：带前缀的是勾上的「默认不写」条目，「day」是天数那行（不在这里），其余是去掉的。 */
function splitChecklistIds(ids: readonly string[]): { excluded: string[]; optedIn: string[] } {
  const excluded: string[] = [];
  const optedIn: string[] = [];
  for (const id of ids) {
    if (id.startsWith(OPT_IN_PREFIX)) optedIn.push(id.slice(OPT_IN_PREFIX.length));
    else if (id !== "day") excluded.push(id);
  }
  return { excluded, optedIn };
}

/** 作者点了「确认定稿」：照预览票定稿。 */
export async function applyCommitToolLogic(input: {
  readonly projectDir: string;
  readonly chapter: number;
  readonly previewToken?: string;
  readonly excluded?: readonly string[];
  readonly dayOverride?: number;
  readonly dayEndOverride?: number;
}): Promise<CommitApplyToolOutput> {
  const { projectDir, chapter } = input;
  const text = await readFile(defaultDraftPath(projectDir, chapter), "utf-8").catch(() => undefined);
  if (text === undefined) return refusal(chapter, `第 ${chapter} 章没有工作稿，没法定稿。`, "no_draft");
  const ticket = input.previewToken ?? latestTicketFor(projectDir, chapter);
  if (!ticket) return refusal(chapter, `第 ${chapter} 章还没做定稿预览（或预览已过期），请先点「定稿」预览一次。`, "no_preview");

  const ids = splitChecklistIds(input.excluded ?? []);
  const outcome = await confirmChapterCommit({
    bookDir: projectDir,
    ticket,
    text,
    excluded: ids.excluded,
    optedIn: ids.optedIn,
    ...(input.dayOverride !== undefined ? { day: input.dayOverride } : {}),
    ...(input.dayEndOverride !== undefined ? { dayEnd: input.dayEndOverride } : {}),
    tickets: ticketStoreFor(projectDir),
  });
  if (!outcome.ok) {
    const blockedReason = outcome.code === "text_changed" ? "draft_changed_since_preview" : outcome.code === "ticket_missing" ? "no_preview" : undefined;
    return refusal(chapter, outcome.reason, blockedReason);
  }

  // 老代码还在读老格式文件：按新账重生成一遍。没成也不影响定稿本身（下次开书会补），但要如实说。
  const mirror = await syncLegacyMirror(projectDir);
  if (!mirror.ok) console.warn(`[commit_apply] 第 ${chapter} 章定稿后重生成老格式镜像没成：${mirror.reason}`);
  // 编辑部预热：后台给专员把笔记补到这一章，失败只 warn。
  void warmUpReaders(projectDir, chapter);
  // 写作统计：定稿后这章按定稿重数（工作稿还在就数工作稿）。
  await recordChapterWords(projectDir, chapter, "other");
  // 自动备份（设置里能关）：后台打一份，没成不挡定稿，结果记进备份设置、设置里看得到。
  void autoBackupAfterCommit(projectDir);

  const ledger = await readChapterLedger(projectDir, chapter);
  const entries = ledger?.entries ?? [];
  const count = (predicate: (entry: (typeof entries)[number]) => boolean): number => entries.filter(predicate).length;
  const after = project(await readBookSnapshot(projectDir));
  const view = after.chapters.find((item) => item.chapter === chapter);
  const cards = await readCardsOrLegacy(projectDir);
  const known = new Set(cards.cards.filter((card) => card.kind === "character").flatMap((card) => [card.name, ...card.aliases]).map(nameKey));
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
      notRecorded: outcome.result.rejected.length,
    },
  };
  const openThreads = after.threads.filter((thread) => thread.status !== "closed").length;
  const openBefore = openThreads - report.ledger.threadsOpened + report.ledger.threadsClosed;

  const parts = [
    outcome.replayed
      ? `第 ${chapter} 章刚才已经定稿过了，这次没有重复写。`
      // 记了几条在定稿回执卡上，这里不复述（重构 P6：一回合一句结论）。
      // 撤销在定稿回执卡上（「撤销这次定稿」），回话不再提。
      : `第 ${chapter} 章已定稿${outcome.result.recommitted ? "（换掉了原来的账）" : ""}。`,
    ...(outcome.result.rejected.length > 0 ? [`有 ${outcome.result.rejected.length} 条没记上：${outcome.result.rejected.slice(0, 3).map((item) => item.message).join("；")}。`] : []),
    ...(outcome.result.orphanedThreads.length > 0
      ? [`换账后有 ${outcome.result.orphanedThreads.length} 条线索后文还在推进、这章却不再开它：${outcome.result.orphanedThreads.slice(0, 3).map((title) => `「${title}」`).join("")}，要看一下。`]
      : []),
    ...(mirror.ok ? [] : ["（老格式资料没同步上，下次打开书会补；账本身已经记好。）"]),
    ...(newCharacters.length > 0 ? [`这章还出现了新人物：${newCharacters.join("、")}——要给谁建卡，在设定本「还没建卡」里点一下就行。`] : []),
    ...(recurring.length > 0 ? [`${recurring.map((name) => `「${name}」`).join("、")}已经出场 ${RECURRING_UNCARDED_THRESHOLD} 章了，还没有人物卡。`] : []),
    ...(openThreadsHintDue(openBefore, openThreads) ? [`另外，开着的线索已积到 ${openThreads} 条——有讲同一件事的可以说「归并线索」。`] : []),
  ];
  const overview: StateOverview | undefined = await buildStateOverview({ projectDir, chapter, maxTimelineEvents: 8 }).catch(() => undefined);
  const title = markdownTitle(text);
  return {
    ok: true,
    committed: true,
    refused: false,
    report,
    draftBody: stripLeadingMarkdownChapterHeading(text).trim(),
    ...(title ? { draftTitle: title } : {}),
    overview,
    summary: parts.join(" "),
    refreshScope: "full",
    chapter,
    ...(openThreads >= THREAD_STALE_ESCALATION_THRESHOLD ? { threadMaintenanceHint: "escalated" as const } : {}),
  };
}

/** 模型发起的定稿：不写盘。有对得上的预览就给作者出「确认定稿」按钮，没有就如实请先预览。 */
export async function buildConfirmationRequest(projectDir: string, chapter: number): Promise<CommitApplyToolOutput> {
  const text = await readFile(defaultDraftPath(projectDir, chapter), "utf-8").catch(() => undefined);
  if (text === undefined) return refusal(chapter, `第 ${chapter} 章没有工作稿，没法定稿。`, "no_draft");
  const ticketId = latestTicketFor(projectDir, chapter);
  const ticket = ticketId ? await ticketStoreFor(projectDir).get(ticketId) : undefined;
  if (!ticketId || !ticket) return refusal(chapter, `第 ${chapter} 章还没做定稿预览，按规则不能直接定稿；请先预览。`, "no_preview");
  if (ticket.textSha256 !== draftFingerprint(text)) {
    return refusal(chapter, "工作稿在预览之后又改过，请重新预览一次。", "draft_changed_since_preview");
  }
  return {
    ok: false,
    committed: false,
    refused: false,
    needsConfirmation: true,
    blockedReason: "awaiting_user_confirmation",
    confirmAction: { toolName: "commit_apply", chapter, previewToken: ticketId },
    overview: undefined,
    summary: `第 ${chapter} 章已预览通过，还没写入。请点「确认定稿」按钮完成定稿（定稿前自动存档，可撤销）。`,
    refreshScope: "full",
    chapter,
  };
}

export const commitApplyTool = writeTool({
  id: "commit_apply",
  description:
    "请求把某章工作稿定稿。你调用它不会直接写入：本章有有效定稿预览时，它给作者出一个「确认定稿」按钮" +
    "（needsConfirmation=true），作者点了才真正定稿；没有有效预览、或预览后正文改过时如实拒绝，先 commit_preview。" +
    "作者说要定稿时调用它（给出章号即可），然后告诉作者点「确认定稿」按钮；绝不说成『已定稿』。",
  inputSchema,
  outputSchema,
  // 操作历史可读性：定稿存档标签带章号（agent:commit_apply:第58章 → 「定稿：第58章」）。
  snapshotDetail: (input) => (typeof input.chapter === "number" && input.chapter > 0 ? `第${input.chapter}章` : undefined),
  // 只有作者点了「确认定稿」按钮（结构化动作）才真写盘；模型自己发起的一律只出确认按钮。
  preflight: async ({ input, projectDir, context }) => {
    if (isUserConfirmedTool(context, "commit_apply")) return undefined;
    const chapter = resolveChapterFromInputOrContext(input.chapter, context);
    if (chapter === undefined) {
      throw new Error("commit_apply 缺少章号：没给章号，前端也没带当前章。请明确指定章号。");
    }
    return buildConfirmationRequest(projectDir, chapter);
  },
  run: async ({ input, projectDir, context }) => {
    const chapter = resolveChapterFromInputOrContext(input.chapter, context);
    if (chapter === undefined) {
      throw new Error("commit_apply 缺少章号：没给章号，前端也没带当前章。请明确指定章号。");
    }
    return applyCommitToolLogic({
      projectDir,
      chapter,
      ...(input.previewToken ? { previewToken: input.previewToken } : {}),
      ...(input.excluded && input.excluded.length > 0 ? { excluded: input.excluded } : {}),
      ...(input.dayOverride !== undefined ? { dayOverride: input.dayOverride } : {}),
      ...(input.dayEndOverride !== undefined ? { dayEndOverride: input.dayEndOverride } : {}),
    });
  },
});
