/**
 * commit_apply — 写类工具：把某章草稿正式入库（章节正文 + 角色/伏笔/线索/时间线等全套状态）。
 *
 * 双轨合一（第二波·commit 簇）：共享编排（锁内 recover → 机制外皮判定 → 重建计划 → 两阶段写）
 * 已收进 services/commit-service.ts（与 routes/commit.ts 的 /api/commit/apply 同调 runCommitApply）。
 * 本工具只剩适配层：
 *   - RequestContext 取 projectDir/章号回退 + zod schema + writeTool 快照包装 + 本轮意图门；
 *   - 显式策略参数：agent_preview_ticket 机制（D10：A7 幂等探测 + previewToken 守卫 +
 *     预览缓存声明复用），previewToken 内存 store 以注入面形式交给 service（所有权仍在本适配层）；
 *   - canonical result 的工具投影（D13）：draftBody/draftTitle/overview/summary/refreshScope，
 *     快照 id 由 writeTool 包装层并入（HTTP 路不透出）。
 *   - 失败摘要消毒（D12，scrubBareEntityIdsFromText）与入库后抽事实/新人物告知搭车（D11）留在本层。
 *
 * 守卫（铁律：绝不谎报）：必须先对「同一章节」commit_preview 过、且草稿在预览之后没改动
 *   （系统内预览票据/previewToken + 草稿哈希一致），否则诚实拒绝，不入库、不谎称成功。
 */
import type { ChapterFactUpdate } from "@actalk/story-engine";
import {
  buildStateOverview,
  type StateOverview,
} from "@actalk/story-engine";
import { readFile } from "node:fs/promises";
import { basename, isAbsolute, relative } from "node:path";
import { z } from "zod";
import { coerceNumber } from "./lenient-args.js";

import { warmUpReaders } from "../../brain/index.js";
import { resolveConfiguredChatModel, streamChatModelToText } from "../../lib/llm-client.js";
import { scrubLocalAbsolutePaths } from "../../lib/local-path-scrubber.js";
import { type FactCallModel } from "../fact-ledger/fact-ledger.js";
import { describeFactOutcome, factKey, proposeFactChanges, toChapterFactUpdate, type FactProposal } from "../fact-ledger/reconcile-facts.js";
import { splitExclusions } from "../commit-ledger/ledger-checklist.js";
import { writeTool } from "../withSnapshot.js";
import { defaultDraftPath, stripLeadingMarkdownChapterHeading } from "../../lib/project-io.js";
import { isUserConfirmedTool, resolveChapterFromInputOrContext } from "../request-context.js";
import {
  runCommitApply,
  type ChapterDeltaDeclarationOutcome,
  type ChapterDeltaDeclarationStatus,
  type CommitApplyPreviewTicketStore,
  readEstablishedCharacterNames,
} from "../../services/commit-service.js";
import { appendRecurringUncardedToSummary, updateUncardedCharacterMemo } from "./uncarded-character-memo.js";
import {
  consumeCommitPreview,
  findCommitPreview,
  hashDraftContent,
  verifyCommitPreview,
  type CommitPreviewGuardFailure,
} from "./commit-preview-store.js";

/**
 * 堆积加重档阈值（长跑 #16：50 章积 323 条、42 条超 3 章未推进，全靠用户发起治理）：
 * 未收口 ≥30 条时回执除文案提醒外加结构化 threadMaintenanceHint:"escalated"，
 * instructions 据此**必须**在收尾 suggest_next_steps 里摆上「清理线索」选项卡——把「该清理了」
 * 从模型的自觉变成回执里的确定性触发。仍只是给选项：真清理走意图门、要用户点头。
 */
export const THREAD_STALE_ESCALATION_THRESHOLD = 30;

const inputSchema = z.object({
  chapter: coerceNumber(z.number().int().positive().optional().describe("要定稿的章号（必须与之前 commit_preview 的章号一致）。")),
  previewToken: z.string().optional().describe(
    "commit_preview 返回的真实令牌。可省略：系统会优先使用同进程内最近一次有效 commit_preview 票据；没有有效预览时会拒绝定稿。",
  ),
  excluded: z.array(z.string()).optional().describe("作者在账本清单上去掉的条目（只由「确认定稿」按钮带来，你不用传）。"),
  dayOverride: z.number().int().positive().optional().describe("作者在账本清单上改的「第几天」（只由「确认定稿」按钮带来，你不用传）。"),
});

const outputSchema = z.object({
  snapshotId: z.string().describe("定稿前的快照 id，前端凭此可一键撤销整次定稿。"),
  ok: z.boolean().describe(
    "统一诚实成功标志：true=真的定稿成功（committed）；false=被拒绝或定稿未通过。前端结构性防谎报只认这个字段。",
  ),
  committed: z.boolean().describe("是否真的完成了定稿。"),
  refused: z.boolean().describe("是否因守卫（未预览/工作稿已变/计划不可用）被拒绝。"),
  refusalReason: z.string().optional().describe("被拒绝的原因（诚实回报，不谎称成功）。"),
  blockedReason: z.string().optional().describe(
    "写入前守卫拦截原因：awaiting_user_confirmation=已预览通过、等用户点「确认定稿」按钮；no_preview/draft_changed_since_preview/no_draft=还不能定稿。",
  ),
  needsConfirmation: z.boolean().optional().describe("true=没有写盘，界面已给用户出「确认定稿」按钮，用户点了才真正定稿。"),
  confirmAction: z.object({
    toolName: z.literal("commit_apply"),
    chapter: z.number().int().positive(),
    previewToken: z.string().optional(),
  }).optional().describe("「确认定稿」按钮携带的结构化动作（前端据此渲染按钮）。"),
  report: z.unknown().optional().describe("定稿报告（更新了哪些角色/伏笔/线索/时间线等）。"),
  draftBody: z.string().optional().describe(
    "已定稿的章节正文（去 Markdown 标题）；定稿成功时返回，供前端把正文以 committed 状态载入工作区，避免被占位覆盖、且防 autosave 把已定稿章节复活成工作稿。",
  ),
  draftTitle: z.string().optional().describe("定稿章节标题（成功时）。"),
  overview: z.unknown().describe("定稿后（或拒绝时仍读取当前）的 StateOverview，供前端刷新。"),
  summary: z.string().describe("定稿结果的自然语言摘要。"),
  refreshScope: z.literal("full"),
  chapter: z.number().int().positive().optional().describe("本次定稿的章号。"),
  declarationStatus: z.enum(["model", "fallback"]).optional().describe(
    "本次定稿用的章节语义声明来源：model=模型声明已生效；fallback=没拿到声明、这章的线索/目标/人物状态没记（summary 里已有【这章的线索没记上】提示，须如实转达）。",
  ),
  declarationReason: z.string().optional().describe("declarationStatus=fallback 时的原因（用户可见文案）。"),
  threadMaintenanceHint: z.literal("escalated").optional().describe(
    "线索池堆积加重档（未收口 ≥" + THREAD_STALE_ESCALATION_THRESHOLD + " 条）：必须在收尾的 suggest_next_steps 里摆上「清理线索」选项卡（仍只给选项，真清理要用户点头）。",
  ),
});

const GUARD_FAILURE_MESSAGE: Record<CommitPreviewGuardFailure, string> = {
  no_preview: "这一章还没做定稿预览，按规则不能直接定稿；请先预览确认。",
  chapter_mismatch: "预览的章节与本次定稿章节不一致；请对这一章重新做一次定稿预览。",
  token_mismatch: "预览凭证无效或与这一章不匹配；请先做一次定稿预览。",
  draft_changed_since_preview: "工作稿在预览之后又改动过；为避免定稿与预览不一致，请重新做一次定稿预览。",
};

export interface CommitApplyToolOutput {
  readonly ok: boolean;
  readonly committed: boolean;
  readonly refused: boolean;
  readonly refusalReason?: string;
  readonly blockedReason?: string;
  /** 模型发起的调用：没写盘，等用户点「确认定稿」按钮（结构化动作）。 */
  readonly needsConfirmation?: boolean;
  readonly confirmAction?: CommitApplyConfirmAction;
  readonly report?: unknown;
  readonly draftBody?: string;
  readonly draftTitle?: string;
  readonly overview: unknown;
  readonly summary: string;
  readonly refreshScope: "full";
  readonly chapter?: number;
  /** 定稿成功时：章节语义声明来源（fallback=本章按确定性规则兜底，summary 已明说）。 */
  readonly declarationStatus?: ChapterDeltaDeclarationStatus;
  readonly declarationReason?: string;
  /** 线索池堆积加重档（长跑 #16）：未收口 ≥30 条时出现，instructions 据此必须在下一步选项卡里摆「清理线索」。 */
  readonly threadMaintenanceHint?: "escalated";
}

/** 「确认定稿」按钮的结构化动作：前端原样回传给 /api/agent/chat 的 action 字段。 */
export interface CommitApplyConfirmAction {
  readonly toolName: "commit_apply";
  readonly chapter: number;
  readonly previewToken?: string;
}

// 角色候选自动登记（convertCandidatesToMatrixUpdates）已于 2026-06-24 移除：
// 正则猜的候选会把『耳边轻声』类碎片污染成矩阵候选；用户拍板「新人物只告知、不替我写盘」。
// 新出现人物改由入库后 extractAndAppendFacts 的 newCharacters 显式抽取、拼进 summary 告知（见工具 run）。

/**
 * D10 机制外皮注入面：previewToken 内存 store（commit-preview-store.ts）的所有权在本适配层，
 * service 经此窄接口做 A7 探测后的票据守卫/声明复用/消费，不反向依赖 agent/ 目录。
 */
const PREVIEW_TICKET_STORE: CommitApplyPreviewTicketStore = {
  find: findCommitPreview,
  verify: verifyCommitPreview,
  consume: consumeCommitPreview,
};

/**
 * 工具适配层：调共享 service 拿 canonical result（agent_preview_ticket 机制），投影成工具输出。
 * 任何守卫失败或计划不可用 → refused=true、committed=false，不入库、不谎报。
 */
export async function applyCommitToolLogic(input: {
  readonly projectDir: string;
  readonly chapter: number;
  readonly previewToken?: string;
  readonly excluded?: readonly string[];
  readonly dayOverride?: number;
  readonly factUpdate?: ChapterFactUpdate;
}): Promise<CommitApplyToolOutput> {
  const result = await runCommitApply({
    projectDir: input.projectDir,
    chapter: input.chapter,
    policy: {
      kind: "agent_preview_ticket",
      ...(input.previewToken !== undefined ? { previewToken: input.previewToken } : {}),
      previewStore: PREVIEW_TICKET_STORE,
      ...(input.excluded && input.excluded.length > 0 ? { excluded: input.excluded } : {}),
      ...(input.dayOverride !== undefined ? { dayOverride: input.dayOverride } : {}),
      ...(input.factUpdate ? { factUpdate: input.factUpdate } : {}),
    },
  });
  const { projectDir, chapter } = input;
  switch (result.kind) {
    case "no_draft":
      return refusal(projectDir, chapter, `第 ${chapter} 章工作稿不存在，无法定稿。`);
    case "already_committed_duplicate":
      // A7 命中：断流后重试/重复请求——幂等回报「已入库」，不重复写入。
      return {
        ok: true,
        committed: true,
        refused: false,
        ...(result.draftBody ? { draftBody: result.draftBody } : {}),
        ...(result.draftTitle ? { draftTitle: result.draftTitle } : {}),
        overview: result.overview,
        summary: `第 ${chapter} 章此前已定稿，资料已更新（本次为重复请求，未重复写入）。`,
        refreshScope: "full",
        chapter,
      };
    case "preview_guard_refused":
      return refusal(projectDir, chapter, GUARD_FAILURE_MESSAGE[result.failure]);
    case "plan_not_applyable":
      return refusal(
        projectDir,
        chapter,
        `定稿影响不可用：${result.issues.length > 0 ? result.issues.join("；") : "计划未通过"}。请重新做一次定稿预览。`,
      );
    case "commit_failed": {
      const report = result.report;
      const overview = await buildStateOverview({ projectDir, chapter, maxTimelineEvents: 8 });
      // 铁律④·绝不泄露裸 id/path：report.issues 是引擎诊断文本，可能含合成的裸 hook-/char- id（幻影 hook）或
      // 本地绝对路径，进【给用户看的】summary/refusalReason 前先消毒（原始 issues 仍保留在结构化 report 字段）。
      const nameById = new Map(overview.characterMatrix.characters.map((character) => [character.id, character.name]));
      const safeIssues = report.issues.map((issue) => scrubBareEntityIdsFromText(issue, nameById));
      const safeJoined = safeIssues.length > 0 ? safeIssues.join("；") : "引擎报告失败";
      return {
        ok: false,
        committed: false,
        refused: false,
        ...(safeIssues.length > 0 ? { refusalReason: safeJoined } : {}),
        // #6 绝对路径不进用户可见卡：report.chapterPath 改写为项目内相对路径（失败卡同样会渲染 detailLines）。
        report: withRelativeChapterPath(report, projectDir),
        overview,
        // #6a 诚实性：入库失败=事务已回滚、未产生净改动 → 不再谎称「改动已建快照可撤销」。
        summary: `第 ${chapter} 章定稿未通过：${safeJoined}。本次未定稿、工作稿未改动。`,
        refreshScope: "full",
      };
    }
    case "committed": {
      // 编辑部预热（R1 起默认干活）：后台给开着的专员把读书笔记补到这一章（共用队列依次补），失败只 warn、不阻塞定稿返回。
      void warmUpReaders(projectDir, chapter);
      const report = result.report;
      const overview = result.overview ?? undefined;
      // report.updatedCharacters 是引擎的安全 slug ID（中文名会被 toSafeCharacterId 剥成 char-<hash>）；
      // 按 overview 角色 id 映射回真实显示名再点名，绝不把 slug 暴露给用户。
      const updatedIdSet = new Set(report.updatedCharacters);
      const updatedNames = (overview?.characterMatrix.characters ?? [])
        .filter((c) => updatedIdSet.has(c.id))
        .map((c) => c.name);
      // 章节语义声明未生效（预览没拿到 / 票据里取不到）→ 定稿仍成功，但必须在用户可见摘要里明说「本章是兜底结果」。
      const nameById = new Map((overview?.characterMatrix.characters ?? []).map((c) => [c.id, c.name]));
      const declarationNotice = describeDeclarationFallback(result.declarationOutcome, nameById);
      return {
        ok: true,
        committed: true,
        refused: false,
        // #6 绝对路径不进用户可见卡：CommitDeltaCard 直接渲染 report.chapterPath，出工具前改写为相对路径。
        report: withRelativeChapterPath(report, projectDir),
        ...(result.draftBody ? { draftBody: result.draftBody } : {}),
        ...(result.draftTitle ? { draftTitle: result.draftTitle } : {}),
        overview,
        // r7：自动蛰伏（久未推进的意图/阶段目标）必须折进可见摘要——自动写盘动作绝不静默。
        // 线索池体检：堆积达阈值时在摘要尾部带一行确定性提醒（清理仍需用户点头，这里只补盲区）。
        summary: [
          appendLifecycleNotesToSummary(
            `第 ${chapter} 章已定稿，资料已更新${
              updatedNames.length > 0 ? `（更新：${updatedNames.join("、")}）` : ""
            }。改动已建立存档点，可一键撤销。`,
            report,
          ),
          declarationNotice,
          buildThreadMaintenanceNote(overview),
        ].filter(Boolean).join("\n"),
        refreshScope: "full",
        chapter,
        ...(result.declarationOutcome ? { declarationStatus: result.declarationOutcome.status } : {}),
        ...(declarationNotice && result.declarationOutcome?.reason
          ? { declarationReason: scrubBareEntityIdsFromText(result.declarationOutcome.reason, nameById) }
          : {}),
        // 长跑 #16：堆积加重档走结构化字段（不赌模型读散文），instructions 键定它摆「清理线索」选项卡。
        ...(threadMaintenanceEscalated(overview) ? { threadMaintenanceHint: "escalated" as const } : {}),
      };
    }
    default:
      // http_durable_receipt 机制的专属 kind 不会出现在本工具；出现即编程错误。
      throw new Error(`Unexpected commit apply result for agent_preview_ticket policy: ${String(result.kind)}`);
  }
}

/**
 * 铁律④·绝不泄露本地绝对路径（长跑 #6）：引擎 CommitReport.chapterPath 是磁盘绝对路径
 * （join(projectDir, "chapters", "NNNN.md")），report 会原样流到前端定稿卡——
 * CommitDeltaCard「正式章节：已写入 …」（utils/commitReportSummary.ts 只做展示、无消毒）。
 * 回执出工具前把 chapterPath 改写成项目内相对路径（chapters/NNNN.md）；不在项目内时退化为文件名，
 * 绝不让 /Users/... 进用户可见文案。report 其余字段不动（服务端自身读盘不经过本投影）。
 */
function withRelativeChapterPath(report: unknown, projectDir: string): unknown {
  const chapterPath = (typeof report === "object" && report !== null
    ? (report as { readonly chapterPath?: unknown }).chapterPath
    : undefined);
  if (typeof chapterPath !== "string" || chapterPath.trim().length === 0) return report;
  // relative() 在 Windows 上产出反斜杠分隔，统一拍平成 / 展示；逃出项目根（../ 或绝对）时退化为文件名。
  const rel = relative(projectDir, chapterPath).split("\\").join("/");
  const safePath = rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel) ? rel : basename(chapterPath);
  return { ...(report as Record<string, unknown>), chapterPath: safePath };
}

async function refusal(projectDir: string, chapter: number, reason: string): Promise<CommitApplyToolOutput> {
  const overview = await buildStateOverview({ projectDir, chapter, maxTimelineEvents: 8 }).catch(() => undefined);
  // 铁律④·绝不泄露裸 id/path：拒绝原因可能来自引擎 commitPlan.issues（含裸 id/路径），统一在此消毒。
  const nameById = new Map((overview?.characterMatrix.characters ?? []).map((character) => [character.id, character.name]));
  const safeReason = scrubBareEntityIdsFromText(reason, nameById);
  return {
    ok: false,
    committed: false,
    refused: true,
    refusalReason: safeReason,
    overview,
    summary: `未定稿：${safeReason}`,
    refreshScope: "full",
  };
}

/** 把入库成功后抽到的硬事实摘要折进入库摘要（空则原样返回）。 */
export function appendFactNoteToSummary(summary: string, factSummary: string): string {
  return factSummary.trim() ? `${summary} ${factSummary.trim()}` : summary;
}

/** 未收口线索堆到这个数，入库摘要就带体检提醒（长篇实测：10 章即可积到近 30 条而作者毫无察觉）。 */
export const OPEN_THREADS_HINT_THRESHOLD = 20;
/** 引擎标记的低价值/过期线索达到这个数也提醒（数量不多但已经该清了）。 */
export const CLEANUP_VISIBLE_HINT_THRESHOLD = 3;

/**
 * 入库后的线索池体检提示（确定性，不赌模型自觉）：线索堆积到阈值就在入库摘要里带一行提醒。
 * 只提醒、不动手——清理本身仍要用户点头（清理意图门拦着），这里补的是「用户不知道积了多少」的盲区。
 * 「未收口」= open + touched（touched 只是被提到过、同样没完结——评审加固：只数 open 会在
 * 全 touched 的堆积下完全沉默）。文案面向用户：不出现工具名/英文行话（铁律④）。
 * overview 缺失（刷新失败）→ 不提醒，绝不因提醒功能影响入库回报。
 */
export function buildThreadMaintenanceNote(overview: StateOverview | undefined): string {
  const unresolved = (overview?.threads.open ?? 0) + (overview?.threads.touched ?? 0);
  const cleanupVisible = overview?.threads.cleanupVisibleCount ?? 0;
  if (unresolved < OPEN_THREADS_HINT_THRESHOLD && cleanupVisible < CLEANUP_VISIBLE_HINT_THRESHOLD) return "";
  const escalated = unresolved >= THREAD_STALE_ESCALATION_THRESHOLD;
  const detail = cleanupVisible > 0
    ? `未收口的线索已积到 ${unresolved} 条，其中 ${cleanupVisible} 条已经低价值或过期`
    : `未收口的线索已积到 ${unresolved} 条`;
  return `另外，${detail}${escalated ? "，已经明显堆积、建议尽快清理" : ""}——积多了会拖累后面的章节方向。想清就说「清理线索」，我会先归并整理、建好存档点，可一键撤销。`;
}

/** 堆积加重档判定（与 buildThreadMaintenanceNote 同口径）：给回执结构化 threadMaintenanceHint 用。 */
export function threadMaintenanceEscalated(overview: StateOverview | undefined): boolean {
  const unresolved = (overview?.threads.open ?? 0) + (overview?.threads.touched ?? 0);
  return unresolved >= THREAD_STALE_ESCALATION_THRESHOLD;
}

interface ExpiredEntryLike {
  readonly title?: string;
}

/**
 * r7·蛰伏披露：本次入库若自动蛰伏了久未推进的意图线索 / 阶段目标（引擎确定性生命周期），
 * 必须折进给用户看的 summary——自动动作绝不静默。数据未删除、正文再写到会自动恢复。
 */
export function appendLifecycleNotesToSummary(summary: string, report: unknown): string {
  const root = (typeof report === "object" && report !== null ? report : {}) as {
    readonly threadTracking?: { readonly expiredIntentThreads?: readonly ExpiredEntryLike[] };
    readonly arcGoalTracking?: { readonly expiredArcGoals?: readonly ExpiredEntryLike[] };
  };
  const formatTitles = (entries: readonly ExpiredEntryLike[]): string => {
    const titles = entries
      .map((entry) => (typeof entry.title === "string" ? entry.title.trim() : ""))
      .filter((title) => title.length > 0);
    const shown = titles.slice(0, 3).map((title) => `「${title}」`).join("");
    const rest = titles.length - Math.min(titles.length, 3);
    return `${shown}${rest > 0 ? `等 ${titles.length} 条` : ""}`;
  };
  const parts: string[] = [];
  const expiredIntents = root.threadTracking?.expiredIntentThreads ?? [];
  if (expiredIntents.length > 0) {
    parts.push(`意图线索 ${expiredIntents.length} 条（${formatTitles(expiredIntents)}）`);
  }
  const expiredGoals = root.arcGoalTracking?.expiredArcGoals ?? [];
  if (expiredGoals.length > 0) {
    parts.push(`阶段目标 ${expiredGoals.length} 条（${formatTitles(expiredGoals)}）`);
  }
  if (parts.length === 0) return summary;
  return `${summary} 本次还自动蛰伏了久未推进的条目：${parts.join("；")}。数据未删除，正文再写到会自动恢复；想重新捡起来推进就说一声。`;
}

/** 把入库后抽到的「新出现人物」折进入库摘要（空则原样返回）——只告知、不写盘。 */
export function appendNewCharactersToSummary(summary: string, newCharacters: readonly string[]): string {
  if (newCharacters.length === 0) return summary;
  return `${summary} 这章还出现了新人物：${newCharacters.join("、")}——要给谁正式建卡就说一声。`;
}

/**
 * 硬事实抽取的空闲窗口（不是总时长上限）：入库回报用户在等，比审稿/质检的 90s 收紧；
 * 但只要模型还在吐字节就续命——旧 20s 固定死表在长章（5k+ 字 prompt）上掐在正常分布里，抽不到就「这章硬事实没抽成」。
 */
export const FACT_EXTRACTION_IDLE_TIMEOUT_MS = 30_000;

/**
 * 用用户配置的模型做一次 JSON 输出调用（结算搭车在硬事实抽取上）。
 * 强制关思考：结算只机械抽 JSON、不需推理链——不跟随任务旁路默认，
 * 否则推理模型先吐 6~9k 思考 token 拖慢入库回报。走 streamChatModelToText 空闲超时（2026-10-02 P2）：
 * 有字节就续命、无总时长上限、一律不传 max_tokens；抽不到仍非致命（fact-ledger 收成 ok=false 如实回报）。
 */
export const callConfiguredFactModel: FactCallModel = async (messages) => {
  const configured = await resolveConfiguredChatModel("chapterSteering");
  const { content } = await streamChatModelToText({
    configured: { ...configured, thinking: false },
    messages: messages.map((message) => ({ role: message.role, content: message.content })),
    responseFormat: { type: "json_object" },
    idleTimeoutMs: FACT_EXTRACTION_IDLE_TIMEOUT_MS,
  });
  if (!content.trim()) throw new Error("硬事实抽取模型返回了空内容。");
  return content;
};

export const commitApplyTool = writeTool({
  id: "commit_apply",
  description:
    "请求把某章工作稿定稿。你调用它不会直接写入：本章有有效定稿预览时，它给用户出一个「确认定稿」按钮" +
    "（needsConfirmation=true），用户点了按钮系统才真正定稿；没有有效预览/工作稿预览后改过时如实拒绝，先 commit_preview。" +
    "用户说要定稿时调用它（给出章号即可），然后告诉用户点「确认定稿」按钮；绝不说成『已定稿』。",
  inputSchema,
  outputSchema,
  // 操作历史可读性：定稿存档标签带章号（agent:commit_apply:第58章 → 「定稿：第58章」），不再一排分不清的「定稿」。
  snapshotDetail: (input) => (typeof input.chapter === "number" && input.chapter > 0 ? `第${input.chapter}章` : undefined),
  // 授权模型（2026-10-07 拆补丁塔）：只有用户点了「确认定稿」按钮（结构化动作，服务端直接执行）才真写盘；
  // 模型自己发起的调用一律不定稿——有有效预览就给用户出确认按钮，没有就如实让先预览。
  // 不再用正则猜用户原话是不是授权（那张词表追不完中文说法、还和诚实检测两表互锁）。
  preflight: async ({ input, projectDir, context }) => {
    if (isUserConfirmedTool(context, "commit_apply")) return undefined;
    const chapter = resolveChapterFromInputOrContext(input.chapter, context);
    if (chapter === undefined) {
      throw new Error("commit_apply 缺少章号：LLM 未给出章号，且前端未注入 currentChapter。请明确指定章号。");
    }
    return buildConfirmationRequest(projectDir, chapter);
  },
  run: async ({ input, projectDir, context }) => {
    const resolvedChapter = resolveChapterFromInputOrContext(input.chapter, context);
    if (resolvedChapter === undefined) {
      throw new Error("commit_apply 缺少章号：LLM 未给出章号，且前端未注入 currentChapter。请明确指定章号。");
    }
    // 记账（账本 v2）：预览时算好、作者勾过的提案，和章节同一个事务写进账本。
    // 预览时没抽成（ok=false）或票据没了（进程重启）→ 定稿前现抽一次（自带重试）；仍不成就照常定稿、如实说「这章的事实没记上」。
    const excluded = input.excluded ?? [];
    const exclusions = splitExclusions(excluded).facts;
    const ticketProposal = findCommitPreview(projectDir, resolvedChapter)?.factProposal;
    const proposal = ticketProposal?.ok ? ticketProposal : await proposeFactsForCommit(projectDir, resolvedChapter);
    const factUpdate = toChapterFactUpdate(proposal, exclusions);
    const result = await applyCommitToolLogic({
      projectDir,
      chapter: resolvedChapter,
      previewToken: input.previewToken,
      ...(excluded.length > 0 ? { excluded } : {}),
      ...(input.dayOverride !== undefined ? { dayOverride: input.dayOverride } : {}),
      ...(factUpdate ? { factUpdate } : {}),
    });
    if (!result.committed || !result.draftBody) return result;
    const report = result.report as { readonly factLedger?: { readonly ok: boolean; readonly added: number; readonly superseded: readonly string[]; readonly reason?: string } } | undefined;
    const ledger = report?.factLedger;
    const skipped = proposal?.ok
      ? proposal.adds.filter((fact) => exclusions.adds?.has(factKey(fact.text))).length
        + proposal.changes.filter((change) => exclusions.changes?.has(change.factId)).length
      : 0;
    const factNote = !factUpdate
      ? `这章的事实没抽成${proposal?.failureSummary ? `：${proposal.failureSummary.replace(/^（|）$/gu, "")}` : ""}，账里少了这一章的事实——想补记就说「补记第 ${resolvedChapter} 章的事实」。`
      : ledger && !ledger.ok
        ? `这章的事实没记上（${ledger.reason ?? "原因不明"}），章节已正常定稿。`
        : describeFactOutcome({ added: ledger?.added ?? 0, superseded: ledger?.superseded ?? [], conflicts: proposal?.conflicts ?? [], skipped });
    const newCharacters = proposal?.ok ? proposal.newCharacters : [];
    const withFacts = appendFactNoteToSummary(result.summary, factNote);
    const withNew = appendNewCharactersToSummary(withFacts, newCharacters);
    // 反复出场未建卡 → 确定性升级点名一次（50 章实测：每章一句「要建卡就说一声」没人接茬，需要升级语气）。
    const recurring = await updateUncardedCharacterMemo(projectDir, resolvedChapter, newCharacters)
      .catch((error) => {
        console.warn("[commit_apply] 未建卡角色备忘更新失败（不影响入库与摘要）", error);
        return [] as readonly string[];
      });
    return { ...result, summary: appendRecurringUncardedToSummary(withNew, recurring) };
  },
});

/** 定稿前现抽一次事实（预览时没抽成 / 票据丢了）。读不到草稿就当没抽成。 */
async function proposeFactsForCommit(projectDir: string, chapter: number): Promise<FactProposal | undefined> {
  const draft = await readFile(defaultDraftPath(projectDir, chapter), "utf-8").catch(() => undefined);
  if (!draft) return undefined;
  return proposeFactChanges({
    projectDir,
    chapter,
    draftText: stripLeadingMarkdownChapterHeading(draft).trim(),
    callModel: callConfiguredFactModel,
    knownNames: await readEstablishedCharacterNames(projectDir, chapter).catch(() => []),
  }).catch(() => undefined);
}

/**
 * 模型发起的 commit_apply：不写盘，按预览票据给出「确认定稿」按钮或如实拒绝。
 * 票据核对与 apply 时的守卫同口径（有记录 + 草稿未改），免得给用户一个点了必失败的按钮。
 */
export async function buildConfirmationRequest(projectDir: string, chapter: number): Promise<CommitApplyToolOutput> {
  const record = findCommitPreview(projectDir, chapter);
  if (!record) {
    return { ...(await refusal(projectDir, chapter, GUARD_FAILURE_MESSAGE.no_preview)), blockedReason: "no_preview", chapter };
  }
  const draft = await readFile(defaultDraftPath(projectDir, chapter), "utf-8").catch(() => undefined);
  if (draft === undefined) {
    return { ...(await refusal(projectDir, chapter, `第 ${chapter} 章工作稿不存在，无法定稿。`)), blockedReason: "no_draft", chapter };
  }
  if (hashDraftContent(draft) !== record.draftHash) {
    return {
      ...(await refusal(projectDir, chapter, GUARD_FAILURE_MESSAGE.draft_changed_since_preview)),
      blockedReason: "draft_changed_since_preview",
      chapter,
    };
  }
  return {
    ok: false,
    committed: false,
    refused: false,
    needsConfirmation: true,
    blockedReason: "awaiting_user_confirmation",
    confirmAction: { toolName: "commit_apply", chapter, previewToken: record.token },
    overview: undefined,
    summary: `第 ${chapter} 章已预览通过，还没写入。请点「确认定稿」按钮完成定稿（定稿前自动存档，可撤销）。`,
    refreshScope: "full",
    chapter,
  };
}

const BARE_ENTITY_ID_PLACEHOLDER: Readonly<Record<string, string>> = {
  char: "「某角色」",
  hook: "「某条伏笔」",
  thread: "「某条线索」",
  fact: "「某条硬事实」",
};

/**
 * 失败摘要消毒（铁律④·绝不泄露裸 id/path）：引擎 report.issues / commitPlan.issues 是给引擎看的诊断文本，
 * 可能含 commit-engine 合成的裸 hook-<hash>（幻影 hook）/char-/thread-/fact- 或本地绝对路径。进【给用户看的】
 * summary/refusalReason 前必须清洗：裸 id → 角色/条目名（解析得到）或中性占位（解析不到），绝对路径 → 占位。
 */
export function scrubBareEntityIdsFromText(text: string, nameById: ReadonlyMap<string, string>): string {
  // 先剥本地绝对路径（含引号包裹），避免把磁盘路径漏给用户。
  return scrubLocalAbsolutePaths(text)
    // 再把裸 entity id → 名字 / 中性占位。
    .replace(/\b(char|hook|thread|fact)-[a-z0-9]{4,}\b/giu, (match, prefix: string) => {
      const name = nameById.get(match);
      if (name) return name;
      return BARE_ENTITY_ID_PLACEHOLDER[prefix.toLowerCase()] ?? "「内部条目」";
    });
}

/** 用户可见的「声明未生效」固定提示（commit_preview / commit_apply 两处同款，便于前端与测试对齐）。 */
// 2026-10-10 起线索、目标、人物状态只听声明：没拿到声明 = 这章这几样都没记（不再从正文猜），必须明说。
export const DECLARATION_FALLBACK_NOTICE = "【这章的线索没记上】AI 没读出这章的结构，线索、目标、人物状态这次都不记";

/**
 * 把章节语义声明状态翻成给用户看的一句（fallback 才有；model → undefined）。
 * reason 可能含上游错误原文（模型/网关可控字段），进用户文案前双消毒（裸 id / 本地绝对路径）。
 * 治 ChapterDelta 静默退化：声明没拿到时用户必须看得见「本章是兜底结果」，而不是和正常章一样一句「已定稿」。
 */
export function describeDeclarationFallback(
  outcome: ChapterDeltaDeclarationOutcome | undefined,
  nameById: ReadonlyMap<string, string>,
): string | undefined {
  if (!outcome || outcome.status !== "fallback") return undefined;
  const reason = outcome.reason?.trim();
  const safeReason = reason ? scrubBareEntityIdsFromText(reason, nameById) : "";
  return `${DECLARATION_FALLBACK_NOTICE}${safeReason ? `（${safeReason}）` : ""}。`;
}
