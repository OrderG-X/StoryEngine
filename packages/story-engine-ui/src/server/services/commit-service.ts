/**
 * commit-service — commit 簇（commit-preview / commit-apply）的共享 application service
 * （双轨合一·第二波，全手术最高风险区：写盘路径）。
 *
 * routes/commit.ts 的 POST /api/commit/preview|apply 与 agent/tools/commit-preview.ts /
 * commit-apply.ts 此前各自进程内复刻同一编排；现在同调本 service 拿 canonical result，
 * 两侧只剩适配层投影：
 *   - 路由：HTTP 入参解析/400 守卫、项目级 in-flight 忙碌门（activeProjectCommitOwners）、
 *     formalCommitPreview 强化结构渲染（D9）、状态码/字段投影（D8/D13）。
 *   - 工具：RequestContext 取 projectDir/章号回退、zod schema、writeTool 快照包装与意图门、
 *     previewToken 内存 store 的所有权（commit-preview-store.ts）、用户可见 summary/modelHint、
 *     失败摘要消毒（D12）、入库后抽事实搭车（D11）。
 *
 * 已知分歧全部收敛成显式策略参数（不再是暗差； parity 头注释同步更新）：
 *   - D6 AI 判定层 → preview 的 judge 注入参数（对齐 quality-service 先例）：路由不传=
 *     默认 judgeDraftQualityWithModel（草稿+语义各一次）；工具注入确定性透传桩（不调判定模型）。
 *   - D7 章节语义声明通道 → preview 的 declarationChannel 显式参数：工具传（声明上下文
 *     收集 + declareDelta 调用 + 声明随 previewToken 缓存进工具 store）；路由不传=空声明，
 *     纯正则计划。声明降级（undefined）时两侧计划输入同源，深相等照妖镜由 parity 锁定。
 *   - D8 缺草稿 → canonical no_draft kind；路由渲染 400 missing_workspace_diff，工具渲染
 *     ok:false + blockingReasons["missing_draft"]。
 *   - D10 重放保护 → apply 的 policy 显式参数。「判定同请求」的核心（锁内 recover → 读草稿 →
 *     重建计划 → 重算事务身份 → 比对凭证/票据）由本 service 统一持有；两套机制实现也在此
 *     逐个函数对照挪入，适配层只选定机制：
 *       http_durable_receipt：transactionId/previewHash/idempotencyKey 三绑死 + 持久回执
 *         （.story-engine-ui/commit-idempotency/）重放/碰撞/pending 磁盘对账恢复出口 +
 *         快照与写盘同锁（createSnapshot 在锁内、快照后复核草稿哈希、claim-before-commit）；
 *         一切 replayed 判定先过磁盘对账（安全不变量⑦）。
 *       agent_preview_ticket：A7 已入库幂等探测 + previewToken 守卫（R3 无状态重算在
 *         工具 store 内）+ 预览缓存声明复用；store 后端由工具适配层注入（本 service 不反向
 *         依赖 agent/ 目录）。
 *   - D13 输出面 → canonical committed 结果带全集（report/chapterContent/chapterTitle/
 *     draftBody/draftTitle/overview/warnings + httpPayload）；路由投影 chapterContent/
 *     chapterTitle 且不透出 snapshotId，工具投影 draftBody/draftTitle + writeTool 的 snapshotId。
 *
 * 安全不变量（一寸不让，全部在本文件内原位保留）：
 *   ① withProjectCommitLock 贯穿 preview/apply 全程，进锁先 recoverProjectCommitTransactions；
 *   ② HTTP apply：previewHash/transactionId/idempotencyKey 三绑死（validateCommitApplyPreflight
 *      + receiptMatchesRequest），换键打同事务一律 409；
 *   ③ 快照与写盘同锁：createSnapshot 在锁内执行，快照后重读草稿比对 transaction.draftHash，
 *      不一致即撤 pending 回执并 409；
 *   ④ 事务两阶段：claimDurableCommitReceipt（wx 独占建 pending）→ commitFastDraft →
 *      writeDurableCommitReceipt（tmp+rename 原子换 completed）；失败/异常且未入库时摘除
 *      pending 回执与内存缓存；
 *   ⑤ pending 恢复出口（recoverPendingCommitReceiptFromDisk）：先磁盘对账恢复或 fail-closed
 *      409，绝不删证据后重做；对不上（章未入库/内容被改）一律 409 + 可执行出路文案；
 *      对账本身 IO 读失败单列 409 文案（只说稍后重试，绝不诱导删回执）；
 *   ⑥ 回执文件 IO 全部 no-follow + 父目录防 symlink 校验（Unsafe durable commit receipt...）；
 *   ⑦ replayed 判定前的磁盘对账（undo 假成功根治）：内存缓存只是加速层、持久回执也可能与磁盘
 *      脱节（undo 把回执连同章节一起回滚、内存条目却留在进程内）——该章已入库文件存在且全文与
 *      回执 payload 记录的入库内容逐字一致，才允许报 replayed；对不上（章未入库/被撤销/内容被改）
 *      fall through 走真 apply，磁盘真相为准，绝不做「200 但磁盘什么都没写」的假成功。
 */
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  buildCommitPlanFromProject,
  buildStateOverview,
  checkCommitPlanSemanticQuality,
  checkDraftBeforeCommit,
  commitFastDraft,
  readArcGoalPool,
  readCharacterBible,
  readHookPool,
  readThreadPool,
  readTimelineEvents,
  recoverProjectCommitTransactions,
  withProjectCommitLock,
  type BuildCommitPlanResult,
  type ChapterDeltaDeclaration,
  type CommitQualityReport,
  type CommitReport,
  type StateOverview,
} from "@actalk/story-engine";

import {
  defaultCommittedChapterPath,
  defaultDraftPath,
  extractDraftTitle,
  stripLeadingMarkdownChapterHeading,
} from "../lib/project-io.js";
import { judgeDraftQualityWithModel } from "../lib/quality-judge.js";
import { createSnapshot } from "../lib/snapshot.js";
import {
  buildCommitPreviewTransaction,
  validateCommitApplyPreflight,
  type CommitApplyPreflightResult,
  type CommitPreviewTransactionMetadata,
} from "../lib/transaction-hardening.js";
import type { QualityJudge } from "./quality-service.js";

/* ===========================================================================
 * commit-preview：锁内 recover → 读草稿 → （声明通道）→ 建计划 → 质检 → 事务身份。
 * 只读：不写正式状态、不建快照；previewToken 登记留在工具适配层（工具 store）。
 * ========================================================================= */

/**
 * 预览阶段生成章节语义声明的注入点（单测可传假实现；缺省=不声明，走引擎正则）。
 * openThreadTitles：现有未决线索标题——喂给模型，让它回收时对号入座既有线索、而非每章重埋新线索（治线索堆积）。
 */
export type CommitPreviewDeclareDelta = (input: {
  readonly chapter: number;
  readonly draft: string;
  readonly openThreadTitles?: readonly string[];
  readonly establishedNames?: readonly string[];
  readonly openGoalTitles?: readonly string[];
  readonly previousChapterEnding?: string;
}) => Promise<ChapterDeltaDeclaration | undefined>;

/**
 * D7 显式策略：章节语义声明通道。工具路传（含声明上下文收集：已确立角色名册进计划、
 * 声明喂计划并随 previewToken 缓存）；路由路不传=空声明（纯正则计划，无声明模型通道）。
 * channel 存在但 declareDelta 缺省 = 只带名册进计划、不算声明（工具纯逻辑路径旧行为）。
 */
export interface CommitPreviewDeclarationChannel {
  readonly declareDelta?: CommitPreviewDeclareDelta;
}

export interface CommitPreviewServiceInput {
  readonly projectDir: string;
  readonly chapter: number;
  /** D7 显式策略：声明通道；缺省=无通道（路由路）。 */
  readonly declarationChannel?: CommitPreviewDeclarationChannel;
  /** D6 显式策略：AI 判定层注入点（默认真判定 ×2；传透传桩=显式跳过判定模型，工具路）。 */
  readonly judge?: QualityJudge;
}

/** D8 canonical：缺草稿=「无草稿」kind，两侧适配层各自渲染（HTTP 400 / 工具 missing_draft）。 */
export type CommitPreviewServiceResult =
  | { readonly kind: "no_draft"; readonly chapter: number }
  | {
    readonly kind: "preview";
    readonly chapter: number;
    readonly draftPath: string;
    readonly draftContent: string;
    /** 预览阶段算好的章节语义声明（工具路随 previewToken 缓存供 apply 复用；路由路恒无）。 */
    readonly declaration?: ChapterDeltaDeclaration;
    readonly commitPlan: BuildCommitPlanResult;
    /** 判定层产出（路由=AI 判定后；工具=确定性透传）。 */
    readonly draftQuality: CommitQualityReport;
    readonly semanticQuality?: CommitQualityReport;
    readonly transaction: CommitPreviewTransactionMetadata;
    /** 已入库章节原文（路由投影 formalCommitPreview 的 baseHash 用；读不到=空串）。 */
    readonly committedChapterContent: string;
  };

export async function runCommitPreview(input: CommitPreviewServiceInput): Promise<CommitPreviewServiceResult> {
  return withProjectCommitLock(input.projectDir, async () => {
    await recoverProjectCommitTransactions(input.projectDir);
    return runCommitPreviewUnlocked(input);
  });
}

async function runCommitPreviewUnlocked(input: CommitPreviewServiceInput): Promise<CommitPreviewServiceResult> {
  const { projectDir, chapter } = input;
  const draftPath = defaultDraftPath(projectDir, chapter);

  let draftContent: string;
  try {
    draftContent = await readFile(draftPath, "utf-8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { kind: "no_draft", chapter };
    }
    throw error;
  }

  // D7 声明通道（仅声明了通道的调用方）：已确立角色名喂给声明模型逐字沿用 + 供引擎名字漂移
  // 写前校验；上一章结尾供衔接判断。读失败 → 空，绝不阻断预览。
  const channel = input.declarationChannel;
  let declaration: ChapterDeltaDeclaration | undefined;
  let establishedCharacterNames: readonly string[] = [];
  if (channel) {
    establishedCharacterNames = await readEstablishedCharacterNames(projectDir, chapter);
    const previousChapterEnding = await readPreviousChapterEnding(projectDir, chapter);
    if (channel.declareDelta) {
      try {
        const [openThreadTitles, openGoalTitles] = await Promise.all([
          readOpenThreadTitles(projectDir),
          readOpenArcGoalTitles(projectDir),
        ]);
        declaration = await channel.declareDelta({
          chapter,
          draft: draftContent,
          openThreadTitles,
          ...(establishedCharacterNames.length > 0 ? { establishedNames: establishedCharacterNames } : {}),
          ...(openGoalTitles.length > 0 ? { openGoalTitles } : {}),
          ...(previousChapterEnding ? { previousChapterEnding } : {}),
        });
      } catch (error) {
        // 回退正则是设计内降级，但完全无痕会让声明模型持续挂掉而无人察觉（ChapterDelta 静默退化）——
        // 留一条 warn（章节号 + 错误摘要，不含草稿正文），行为不变只是留痕。
        console.warn(
          `[chapter-delta] ch${chapter} 声明通道调用失败，回退引擎正则：${error instanceof Error ? error.message : String(error)}`,
        );
        declaration = undefined;
      }
    }
  }

  const commitPlan = await buildCommitPlanFromProject({
    projectDir,
    chapter,
    draftPath,
    draftContent,
    ...(declaration ? { declaration } : {}),
    ...(establishedCharacterNames.length > 0 ? { establishedCharacterNames } : {}),
  });
  const deterministicDraftQuality = await checkDraftBeforeCommit({ projectDir, chapter, draftContent });
  const deterministicSemanticQuality = commitPlan.commitPlan
    ? checkCommitPlanSemanticQuality(commitPlan.commitPlan)
    : undefined;
  // D6：判定层调不调由 judge 参数显式决定（默认 judgeDraftQualityWithModel；透传桩=跳过判定模型）。
  const judge = input.judge ?? judgeDraftQualityWithModel;
  const [draftQuality, semanticQuality] = await Promise.all([
    judge({ projectDir, chapter, draftContent, deterministicQuality: deterministicDraftQuality }),
    deterministicSemanticQuality
      ? judge({ projectDir, chapter, draftContent, deterministicQuality: deterministicSemanticQuality })
      : Promise.resolve(undefined),
  ]);
  const transaction = buildCommitPreviewTransaction({ projectDir, chapter, draftContent, commitPlan });
  const committedChapterContent = await readFile(defaultCommittedChapterPath(projectDir, chapter), "utf-8")
    .catch(() => "");
  return {
    kind: "preview",
    chapter,
    draftPath,
    draftContent,
    ...(declaration ? { declaration } : {}),
    commitPlan,
    draftQuality,
    ...(semanticQuality ? { semanticQuality } : {}),
    transaction,
    committedChapterContent,
  };
}

/* ---------------------------------------------------------------------------
 * D7 声明通道的上下文收集（从 tools/commit-preview.ts 对照挪入；纯读盘、失败即空、绝不阻断）。
 * ------------------------------------------------------------------------- */

/**
 * 读现有未决的伏笔+线索标题，供声明模型回收时对号入座（回收 targetThreadHint 从这里选、别新造，也别漏收）。
 * 线索=open/touched thread；伏笔=active hook。两者都是「已埋下、还没收口」的东西，一并喂给模型。
 * 读失败/无库 → 忽略该来源，绝不阻断预览。
 */
async function readOpenThreadTitles(projectDir: string): Promise<readonly string[]> {
  const hookTitles: string[] = [];
  const threadTitles: { readonly title: string; readonly lastTouchedChapter: number }[] = [];
  try {
    const pool = await readThreadPool(projectDir);
    for (const thread of pool.threads) {
      if (thread.status !== "open" && thread.status !== "touched") continue;
      const title = typeof thread.title === "string" ? thread.title.trim() : "";
      if (title) threadTitles.push({ title, lastTouchedChapter: thread.lastTouchedChapter });
    }
  } catch {
    // 无线索库 → 跳过
  }
  try {
    const pool = await readHookPool(projectDir);
    for (const hook of pool.hooks) {
      if (hook.status !== "active") continue;
      const title = typeof hook.title === "string" ? hook.title.trim() : "";
      if (title) hookTitles.push(title);
    }
  } catch {
    // 无伏笔库 → 跳过
  }
  const unique = new Set<string>();
  const result: string[] = [];
  for (const title of hookTitles) {
    if (unique.has(title)) continue;
    unique.add(title);
    result.push(title);
  }
  for (const { title } of threadTitles
    .sort((left, right) => right.lastTouchedChapter - left.lastTouchedChapter)
    .slice(0, 40)) {
    if (unique.has(title)) continue;
    unique.add(title);
    result.push(title);
  }
  return result;
}

/**
 * 读现有未达成的主线/阶段目标标题，供声明模型推进/达成时对号入座既有目标（targetGoalHint 从这里选、别新造），
 * 治「同一条主线跨章被拆成好几个目标」。只喂 active/touched（还在推进中）的，completed/stale 不喂避免噪声。
 * 读失败/无库 → 空数组，绝不阻断预览。题材中立、纯读盘。
 */
async function readOpenArcGoalTitles(projectDir: string): Promise<readonly string[]> {
  const titles = new Set<string>();
  try {
    const pool = await readArcGoalPool(projectDir);
    for (const goal of pool.goals) {
      if (goal.status !== "active" && goal.status !== "touched") continue;
      const title = typeof goal.title === "string" ? goal.title.trim() : "";
      if (title) titles.add(title);
    }
  } catch {
    // 无目标库 → 跳过
  }
  return [...titles];
}

/**
 * 汇出本书「已确立的角色名」，供①喂给声明模型（逐字沿用、别写形近错名）②引擎名字漂移写前校验。
 * 来源：已登记角色库（character-bible）+ 之前各章时间线里出现过的角色名（跨章累积）。
 * 读失败/无库 → 空数组，绝不阻断预览。题材中立、纯读盘。
 */
async function readEstablishedCharacterNames(projectDir: string, chapter: number): Promise<readonly string[]> {
  const names = new Set<string>();
  try {
    const bible = await readCharacterBible(projectDir);
    for (const character of bible?.characters ?? []) {
      const name = character.name?.trim();
      if (name) names.add(name);
    }
  } catch {
    // 无角色库 → 跳过
  }
  try {
    const events = await readTimelineEvents(projectDir);
    for (const event of events) {
      if (typeof event.chapter === "number" && event.chapter >= chapter) continue;
      const summary = event.effects?.semanticSummary as {
        readonly mentionedCharacterNames?: readonly string[];
        readonly presentCharacterNames?: readonly string[];
      } | undefined;
      // 登记角色出现的名字 + 模型声明并校验通过的出场名（含未登记 prose-only 名，如「妹妹林宁」）。
      for (const name of [...(summary?.mentionedCharacterNames ?? []), ...(summary?.presentCharacterNames ?? [])]) {
        const trimmed = typeof name === "string" ? name.trim() : "";
        if (trimmed) names.add(trimmed);
      }
    }
  } catch {
    // 无时间线 → 跳过
  }
  return [...names];
}

function chapterEndingExcerpt(content: string, maxLength = 500): string | undefined {
  const trimmed = content.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length <= maxLength) return trimmed;
  return trimmed.slice(-maxLength);
}

async function readPreviousChapterEnding(projectDir: string, chapter: number): Promise<string | undefined> {
  if (chapter <= 1) return undefined;
  try {
    const content = await readFile(defaultCommittedChapterPath(projectDir, chapter - 1), "utf-8");
    return chapterEndingExcerpt(content);
  } catch {
    return undefined;
  }
}

/* ===========================================================================
 * commit-apply：锁内 recover →（机制外皮：重放/守卫判定）→ 读草稿 → 重建计划 →
 * 重算事务身份 →（机制外皮：凭证/票据比对）→ 计划可用性 → 两阶段写 → canonical。
 * 「判定同请求」的核心底座两侧同源；机制差异全部关在 policy 参数里。
 * ========================================================================= */

/** HTTP 路 apply 成功响应体的持久形状（回执里存的就是它，重放逐字返回）。 */
export interface CommitApplySuccessPayload extends Record<string, unknown> {
  readonly ok: true;
  readonly report: unknown;
  readonly overview: unknown;
  readonly chapterContent: string;
  readonly chapterTitle: string;
}

type CommitIdempotencyEntry =
  | {
    readonly status: "running";
    readonly transaction: CommitPreviewTransactionMetadata;
  }
  | {
    readonly status: "completed";
    readonly transaction: CommitPreviewTransactionMetadata;
    readonly payload: CommitApplySuccessPayload;
  };

/**
 * 幂等内存缓存上界（原无上界：每个成功 apply 的全章正文 payload 常驻内存，长跑只涨不消）。
 * 超界按 FIFO 淘汰最旧条目（Map 迭代序即插入序）。淘汰的只是内存加速层——持久回执
 * （.story-engine-ui/commit-idempotency/）才是重放真值，被淘汰键的同键重试走磁盘回执照常重放。
 */
const COMMIT_IDEMPOTENCY_CACHE_LIMIT = 50;

const commitIdempotencyEntries = new Map<string, CommitIdempotencyEntry>();

function setCommitIdempotencyEntry(cacheKey: string, entry: CommitIdempotencyEntry): void {
  // 同键覆写（running → completed）不换名额、不挪位置，不触发淘汰。
  if (!commitIdempotencyEntries.has(cacheKey)) {
    while (commitIdempotencyEntries.size >= COMMIT_IDEMPOTENCY_CACHE_LIMIT) {
      const oldest = commitIdempotencyEntries.keys().next();
      if (oldest.done) break;
      commitIdempotencyEntries.delete(oldest.value);
    }
  }
  commitIdempotencyEntries.set(cacheKey, entry);
}

/** 测试专用自省：内存缓存当前条目数（上界淘汰的回归锁用；生产代码勿调）。 */
export function commitIdempotencyCacheSizeForTests(): number {
  return commitIdempotencyEntries.size;
}

interface DurableCommitReceipt {
  readonly version: 1;
  readonly status: "pending" | "completed";
  readonly projectHash: string;
  readonly chapter: number;
  readonly idempotencyKey: string;
  readonly transactionId: string;
  readonly previewHash: string;
  readonly createdAt: string;
  readonly payload?: CommitApplySuccessPayload;
}

/** 工具路 A7/票据守卫的失败类别（与 tools/commit-preview-store.ts 的 CommitPreviewGuardFailure 逐字同构）。 */
export type CommitApplyGuardFailure =
  | "no_preview"
  | "chapter_mismatch"
  | "token_mismatch"
  | "draft_changed_since_preview";

/**
 * 工具路预览票据 store 的注入面（外皮留在工具适配层：commit-preview-store.ts；
 * 本 service 不反向依赖 agent/ 目录）。verify 的 R3 无状态重算语义在 store 内。
 */
export interface CommitApplyPreviewTicketStore {
  readonly find: (projectDir: string, chapter: number) => {
    readonly token: string;
    readonly draftHash: string;
    readonly declaration?: ChapterDeltaDeclaration;
  } | undefined;
  readonly verify: (input: {
    readonly projectDir: string;
    readonly chapter: number;
    readonly token?: string;
    readonly currentDraftHash: string;
  }) => { readonly ok: boolean; readonly failure?: CommitApplyGuardFailure };
  readonly consume: (projectDir: string, chapter: number) => void;
}

/**
 * D10 显式策略：重放保护/同请求判定的机制选择。
 *   http_durable_receipt：持久回执重放 + 三绑死 preflight + 锁内快照 + 两阶段回执（含 pending 恢复出口）。
 *   agent_preview_ticket：A7 已入库幂等探测 + previewToken 守卫 + 预览缓存声明复用（快照由 writeTool 在锁外已建）。
 */
export type CommitApplyPolicy =
  | {
    readonly kind: "http_durable_receipt";
    /** trim 后的幂等键（回执/缓存键用）。 */
    readonly idempotencyKey: string;
    /** 原始 body 凭证值（preflight 校验与回执比对用，含未 trim 的 idempotencyKey）。 */
    readonly credentials: {
      readonly transactionId?: unknown;
      readonly previewHash?: unknown;
      readonly idempotencyKey?: unknown;
    };
  }
  | {
    readonly kind: "agent_preview_ticket";
    readonly previewToken?: string;
    readonly previewStore: CommitApplyPreviewTicketStore;
  };

export interface CommitApplyServiceInput {
  readonly projectDir: string;
  readonly chapter: number;
  readonly policy: CommitApplyPolicy;
}

export type CommitApplyPreflightFailure = Exclude<CommitApplyPreflightResult, { readonly ok: true }>;

/**
 * apply 的 canonical 结果全集（D8/D13）：路由/工具各取投影。
 * HTTP 机制专属短路 kind（transaction_already_claimed/idempotency_collision/idempotency_in_progress/
 * replayed/recovered/draft_changed_during_snapshot/preflight_failed）只在 http_durable_receipt 下产生；
 * 工具机制专属短路 kind（already_committed_duplicate/preview_guard_refused）只在 agent_preview_ticket 下产生。
 */
export type CommitApplyServiceResult =
  | { readonly kind: "no_draft"; readonly chapter: number; readonly errorMessage: string }
  | {
    readonly kind: "transaction_already_claimed";
    readonly chapter: number;
    readonly receiptStatus: "pending" | "completed";
  }
  | {
    readonly kind: "idempotency_collision";
    readonly chapter: number;
    /** durable=换键撞已有持久回执；request_mismatch=内存缓存/竞态 claim 撞上不一致请求。 */
    readonly collision: "durable" | "request_mismatch";
  }
  | { readonly kind: "idempotency_in_progress"; readonly chapter: number; readonly error: string }
  | { readonly kind: "replayed"; readonly chapter: number; readonly payload: CommitApplySuccessPayload }
  | { readonly kind: "recovered"; readonly chapter: number; readonly payload: CommitApplySuccessPayload }
  | { readonly kind: "draft_changed_during_snapshot"; readonly chapter: number }
  | { readonly kind: "preflight_failed"; readonly chapter: number; readonly preflight: CommitApplyPreflightFailure }
  | {
    readonly kind: "already_committed_duplicate";
    readonly chapter: number;
    readonly draftBody: string;
    readonly draftTitle?: string;
    readonly overview?: StateOverview;
  }
  | { readonly kind: "preview_guard_refused"; readonly chapter: number; readonly failure: CommitApplyGuardFailure }
  | { readonly kind: "plan_not_applyable"; readonly chapter: number; readonly issues: readonly string[] }
  | { readonly kind: "commit_failed"; readonly chapter: number; readonly report: CommitReport }
  | {
    readonly kind: "committed";
    readonly chapter: number;
    readonly report: CommitReport;
    /** 入库后的章节文件全文（report.chapterPath 读，回退草稿原文）——路由投影 chapterContent。 */
    readonly chapterContent: string;
    /** extractDraftTitle(chapterContent) ?? 第N章——路由投影 chapterTitle。 */
    readonly chapterTitle: string;
    /** 去 Markdown 标题的入库正文（草稿原文推导）——工具投影 draftBody。 */
    readonly draftBody: string;
    /** extractDraftTitle(draftContent) ?? undefined——工具投影 draftTitle。 */
    readonly draftTitle?: string;
    /** 入库后 overview（刷新失败：HTTP 路=null + warnings 带文案；工具路=undefined 静默）。 */
    readonly overview: StateOverview | null | undefined;
    readonly warnings: readonly string[];
    /** HTTP 路专属：与持久回执里逐字同源的成功响应体（重放一致性靠它锁住）。 */
    readonly httpPayload?: CommitApplySuccessPayload;
  };

export async function runCommitApply(input: CommitApplyServiceInput): Promise<CommitApplyServiceResult> {
  return withProjectCommitLock(input.projectDir, async () => {
    await recoverProjectCommitTransactions(input.projectDir);
    return runCommitApplyUnlocked(input);
  });
}

async function runCommitApplyUnlocked(input: CommitApplyServiceInput): Promise<CommitApplyServiceResult> {
  const { projectDir, chapter, policy } = input;
  const idempotencyKey = policy.kind === "http_durable_receipt" ? policy.idempotencyKey : "";
  const cacheKey = policy.kind === "http_durable_receipt"
    ? commitIdempotencyCacheKey(projectDir, chapter, idempotencyKey)
    : "";

  // ── HTTP 机制外皮（写盘前）：持久回执/内存缓存的重放、碰撞与 pending 恢复出口。 ──
  if (policy.kind === "http_durable_receipt") {
    const transactionReceipt = typeof policy.credentials.transactionId === "string"
      && typeof policy.credentials.previewHash === "string"
      ? await findDurableReceiptForTransaction(projectDir, chapter, policy.credentials.transactionId, policy.credentials.previewHash)
      : undefined;
    if (transactionReceipt && transactionReceipt.idempotencyKey !== idempotencyKey) {
      return { kind: "transaction_already_claimed", chapter, receiptStatus: transactionReceipt.status };
    }
    const durableReceipt = isValidIdempotencyKey(idempotencyKey)
      ? await readDurableCommitReceipt(projectDir, chapter, idempotencyKey)
      : undefined;
    if (durableReceipt) {
      if (!receiptMatchesRequest(durableReceipt, policy.credentials, projectDir, chapter)) {
        return { kind: "idempotency_collision", chapter, collision: "durable" };
      }
      if (durableReceipt.status === "pending" || !durableReceipt.payload) {
        const recovery = await recoverPendingCommitReceiptFromDisk(projectDir, chapter, durableReceipt)
          .catch((error: unknown): PendingReceiptRecovery => ({
            // 恢复出口自身的意外异常同样按「对账读失败」如实报，绝不吞成「对不上」。
            outcome: "unreadable",
            error: error instanceof Error ? error.message : String(error),
          }));
        if (recovery.outcome === "recovered") {
          return { kind: "recovered", chapter, payload: recovery.payload };
        }
        return {
          kind: "idempotency_in_progress",
          chapter,
          error: recovery.outcome === "unreadable"
            ? pendingReceiptUnreadableMessage(projectDir, chapter, idempotencyKey, recovery.error)
            : pendingReceiptBlockMessage(projectDir, chapter, idempotencyKey),
        };
      }
      // 不变量⑦：completed 回执也可能与磁盘脱节（回执在、章节文件却被撤销/改动）——
      // 磁盘对账通过才允许报 replayed；对不上 fall through 走真 apply
      // （claim 会撞上这条现存回执，由下方竞态对账出口 fail-closed 收口）。
      const reconciliation = await reconcileReplayWithDisk(projectDir, chapter, durableReceipt.payload);
      if (reconciliation.outcome === "committed") {
        return { kind: "replayed", chapter, payload: durableReceipt.payload };
      }
    }
    const cached = idempotencyKey ? commitIdempotencyEntries.get(cacheKey) : undefined;
    if (cached?.status === "completed") {
      if (!receiptMatchesRequest(receiptFromCache(cached, chapter, idempotencyKey, projectDir), policy.credentials, projectDir, chapter)) {
        return { kind: "idempotency_collision", chapter, collision: "request_mismatch" };
      }
      // 不变量⑦：内存缓存只是加速层，磁盘真相为准——undo 撤销后回执随快照回滚、内存条目却残留，
      // 此时报 replayed 就是「200 但磁盘什么都没写」的假成功。确认对不上 → 摘掉陈旧条目；
      // 对账本身读失败 → 条目保留（下次重试再对账）。两者都 fall through 走真 apply。
      const reconciliation = await reconcileReplayWithDisk(projectDir, chapter, cached.payload);
      if (reconciliation.outcome === "committed") {
        return { kind: "replayed", chapter, payload: cached.payload };
      }
      if (reconciliation.outcome === "not_committed") {
        commitIdempotencyEntries.delete(cacheKey);
      }
    }
  }

  // ── 共享「判定同请求」底座：读当前草稿 → 重建计划 → 重算事务身份。 ──
  const draftPath = defaultDraftPath(projectDir, chapter);
  let draftContent: string;
  try {
    draftContent = await readFile(draftPath, "utf-8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { kind: "no_draft", chapter, errorMessage: error.message };
    }
    throw error;
  }

  // ── 工具机制外皮（写盘前）：A7 幂等探测 → 票据守卫 → 取预览缓存声明。 ──
  let cachedDeclaration: ChapterDeltaDeclaration | undefined;
  if (policy.kind === "agent_preview_ticket") {
    // A7 幂等探测：断流后重试（实际已入库、token 已被消费）→ 该章已入库且正文与当前草稿一致，
    // 直接幂等回报「已入库」，不因 token 蒸发误报「尚未预览」、也不重复写入。放在守卫之前。
    const duplicate = await detectAlreadyCommittedDuplicate(projectDir, chapter, draftContent);
    if (duplicate) {
      const overview = await buildStateOverview({ projectDir, chapter, maxTimelineEvents: 8 }).catch(() => undefined);
      return {
        kind: "already_committed_duplicate",
        chapter,
        draftBody: duplicate.body,
        ...(duplicate.title ? { draftTitle: duplicate.title } : {}),
        ...(overview ? { overview } : {}),
      };
    }

    const currentDraftHash = sha256(draftContent);
    const effectivePreviewToken = resolveEffectivePreviewToken({
      projectDir,
      chapter,
      providedToken: policy.previewToken,
      previewStore: policy.previewStore,
    });
    const guard = policy.previewStore.verify({
      projectDir,
      chapter,
      ...(effectivePreviewToken !== undefined ? { token: effectivePreviewToken } : {}),
      currentDraftHash,
    });
    if (!guard.ok) {
      return { kind: "preview_guard_refused", chapter, failure: guard.failure ?? "no_preview" };
    }
    // 复用预览阶段算好的章节语义声明（不重复调模型）；取不到（进程重启/凭 token 无状态放行）→ undefined，引擎走正则回退。
    cachedDeclaration = policy.previewStore.find(projectDir, chapter)?.declaration;
  }

  const commitPlan = await buildCommitPlanFromProject({
    projectDir,
    chapter,
    draftPath,
    draftContent,
    ...(cachedDeclaration ? { declaration: cachedDeclaration } : {}),
  });
  const transaction = buildCommitPreviewTransaction({ projectDir, chapter, draftContent, commitPlan });

  // ── HTTP 机制外皮：三绑死 preflight（previewHash/transactionId/idempotencyKey 与当前事务身份比对）。 ──
  if (policy.kind === "http_durable_receipt") {
    const transactionPreflight = validateCommitApplyPreflight({
      transactionId: policy.credentials.transactionId,
      expectedPreviewHash: policy.credentials.previewHash,
      idempotencyKey: policy.credentials.idempotencyKey,
      current: transaction,
      residues: [],
    });
    if (!transactionPreflight.ok) {
      return { kind: "preflight_failed", chapter, preflight: transactionPreflight };
    }
  }

  if (!commitPlan.passed || !commitPlan.commitPlan) {
    return { kind: "plan_not_applyable", chapter, issues: commitPlan.issues };
  }

  // ── 两阶段写。HTTP 路：锁内快照 → 快照后复核草稿哈希 → claim pending 回执 → 入库 → completed 回执。 ──
  if (policy.kind === "http_durable_receipt") {
    const pendingReceipt: DurableCommitReceipt = {
      version: 1,
      status: "pending",
      projectHash: sha256(resolve(projectDir)),
      chapter,
      idempotencyKey,
      transactionId: transaction.transactionId,
      previewHash: transaction.previewHash,
      createdAt: new Date().toISOString(),
    };
    let businessCommitted = false;
    try {
      await createSnapshot(projectDir, `入库前快照：第${chapter}章`);
      const draftAfterSnapshot = await readFile(draftPath, "utf-8");
      if (sha256(draftAfterSnapshot) !== transaction.draftHash) {
        await removePendingCommitReceipt(projectDir, pendingReceipt);
        commitIdempotencyEntries.delete(cacheKey);
        return { kind: "draft_changed_during_snapshot", chapter };
      }

      // Claim after the reversible pre-write snapshot so undoing that
      // snapshot also removes the completed receipt and permits a genuine
      // future re-commit. The exclusive create is the atomic post-await gate.
      const racedReceipt = await claimDurableCommitReceipt(projectDir, pendingReceipt);
      if (racedReceipt) {
        if (!receiptMatchesRequest(racedReceipt, policy.credentials, projectDir, chapter)) {
          return { kind: "idempotency_collision", chapter, collision: "request_mismatch" };
        }
        if (racedReceipt.status === "completed" && racedReceipt.payload) {
          // 不变量⑦同口径：回执称已完成 ≠ 章真在盘上（undo/跨进程撤销窗口）。对不上绝不报假成功——
          // fail-closed 409 + 可执行出路（回执证据绝不删了重做）；对账读失败只说稍后重试。
          const reconciliation = await reconcileReplayWithDisk(projectDir, chapter, racedReceipt.payload);
          if (reconciliation.outcome === "committed") {
            return { kind: "replayed", chapter, payload: racedReceipt.payload };
          }
          return {
            kind: "idempotency_in_progress",
            chapter,
            error: reconciliation.outcome === "unreadable"
              ? completedReceiptUnreadableMessage(projectDir, chapter, idempotencyKey, reconciliation.error)
              : completedReceiptDiskMismatchMessage(projectDir, chapter, idempotencyKey),
          };
        }
        return { kind: "idempotency_in_progress", chapter, error: "相同幂等请求仍在执行。" };
      }
      setCommitIdempotencyEntry(cacheKey, { status: "running", transaction });

      const report = await commitFastDraft({
        projectDir,
        chapter,
        draftPath,
        draftContent,
        commitPlan: commitPlan.commitPlan,
      });
      if (!report.passed) {
        await removePendingCommitReceipt(projectDir, pendingReceipt);
        commitIdempotencyEntries.delete(cacheKey);
        return { kind: "commit_failed", chapter, report };
      }
      businessCommitted = true;
      const committed = await buildCommittedResult({ projectDir, chapter, draftContent, report, overviewFailure: "warn" });
      let payload: CommitApplySuccessPayload = {
        ok: true,
        report,
        overview: committed.overview ?? null,
        chapterContent: committed.chapterContent,
        chapterTitle: committed.chapterTitle,
        ...(committed.warnings.length > 0 ? { warnings: [...committed.warnings] } : {}),
      };
      const completedReceipt: DurableCommitReceipt = { ...pendingReceipt, status: "completed", payload };
      try {
        await writeDurableCommitReceipt(projectDir, completedReceipt);
      } catch (error) {
        const receiptWarning = `idempotency receipt persistence failed after successful commit: ${error instanceof Error ? error.message : String(error)}`;
        payload = { ...payload, warnings: [...committed.warnings, receiptWarning] };
      }
      setCommitIdempotencyEntry(cacheKey, { status: "completed", transaction, payload });
      return { ...committed, httpPayload: payload };
    } catch (error) {
      if (!businessCommitted) {
        await removePendingCommitReceipt(projectDir, pendingReceipt).catch(() => undefined);
        commitIdempotencyEntries.delete(cacheKey);
      }
      throw error;
    }
  }

  // ── 工具路：快照已由 writeTool 包装层建好（锁外）；锁内直接入库，成功后消费票据。 ──
  const report = await commitFastDraft({
    projectDir,
    chapter,
    draftPath,
    draftContent,
    commitPlan: commitPlan.commitPlan,
  });
  if (!report.passed) {
    return { kind: "commit_failed", chapter, report };
  }
  // 入库成功：消费 token，防止用同一 token 重复入库。
  policy.previewStore.consume(projectDir, chapter);
  return buildCommittedResult({ projectDir, chapter, draftContent, report, overviewFailure: "swallow" });
}

/**
 * 入库成功后的 canonical 回收：章节文件全文/标题 + 去标题正文 + overview + warnings。
 * overviewFailure：HTTP 路 "warn"（overview 刷新失败=null + warnings 带文案）；工具路 "swallow"
 * （=undefined 静默，绝不让支援性刷新把已成功的入库翻成失败）。
 */
async function buildCommittedResult(input: {
  readonly projectDir: string;
  readonly chapter: number;
  readonly draftContent: string;
  readonly report: CommitReport;
  readonly overviewFailure: "warn" | "swallow";
}): Promise<Extract<CommitApplyServiceResult, { readonly kind: "committed" }>> {
  const { projectDir, chapter, draftContent, report } = input;
  const chapterContent = typeof report.chapterPath === "string"
    ? await readFile(report.chapterPath, "utf-8").catch(() => draftContent)
    : draftContent;
  const chapterTitle = extractDraftTitle(chapterContent) ?? `第${chapter}章`;
  const committedBody = stripLeadingMarkdownChapterHeading(draftContent).trim();
  const committedTitle = extractDraftTitle(draftContent) ?? undefined;
  const warnings: string[] = [];
  const overview = await buildStateOverview({ projectDir, chapter, maxTimelineEvents: 8 })
    .catch((error: unknown) => {
      if (input.overviewFailure === "warn") {
        warnings.push(`overview refresh failed after successful commit: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
      return undefined;
    });
  return {
    kind: "committed",
    chapter,
    report,
    chapterContent,
    chapterTitle,
    draftBody: committedBody,
    ...(committedTitle ? { draftTitle: committedTitle } : {}),
    overview,
    warnings,
  };
}

/* ---------------------------------------------------------------------------
 * D10 工具机制：A7 幂等探测 + 有效票据解析（从 tools/commit-apply.ts 对照挪入）。
 * ------------------------------------------------------------------------- */

/**
 * A7 幂等探测：该章是否「已入库、且已入库正文与当前草稿一致」。
 * 命中=断流后重试 / 重复点入库的同一份草稿——应幂等回报「已入库」，不再因 token 被消费报「尚未预览」、
 * 也绝不重复写入。内容不一致（合法重写已入库章节）→ 返回 null，照常走守卫+入库。
 * 比对：两边都去 Markdown 标题、压掉空白后对比（已入库章节文件就是去标题的纯正文，见 045200/chapters）。
 */
async function detectAlreadyCommittedDuplicate(
  projectDir: string,
  chapter: number,
  draftContent: string,
): Promise<{ readonly body: string; readonly title?: string } | null> {
  const committed = await readFile(defaultCommittedChapterPath(projectDir, chapter), "utf-8").catch(() => undefined);
  if (committed === undefined || committed.trim().length === 0) return null;
  const norm = (text: string): string => stripLeadingMarkdownChapterHeading(text).replace(/\s+/gu, "");
  if (norm(committed) !== norm(draftContent)) return null; // 内容不同=合法重写，不走幂等
  const body = stripLeadingMarkdownChapterHeading(draftContent).trim();
  const title = extractDraftTitle(draftContent) ?? undefined;
  return { body, ...(title ? { title } : {}) };
}

function resolveEffectivePreviewToken(input: {
  readonly projectDir: string;
  readonly chapter: number;
  readonly providedToken?: string;
  readonly previewStore: CommitApplyPreviewTicketStore;
}): string | undefined {
  const record = input.previewStore.find(input.projectDir, input.chapter);
  if (record) return record.token;

  const normalized = input.providedToken?.trim();
  if (!normalized || isPlaceholderPreviewToken(normalized)) return undefined;
  return normalized;
}

function isPlaceholderPreviewToken(token: string): boolean {
  return /^(?:token[_-]?placeholder|placeholder[_-]?token|preview[_-]?token[_-]?placeholder)$/iu.test(token.trim());
}

/* ---------------------------------------------------------------------------
 * D10 HTTP 机制：持久幂等回执（从 routes/commit.ts 逐个函数对照挪入，一寸不让）。
 * 回执文件：.story-engine-ui/commit-idempotency/<sha256(cacheKey)>.json；
 * 全部 no-follow 读 + 父目录防 symlink 校验；claim=wx 独占创建；completed=tmp+rename 原子替换。
 * ------------------------------------------------------------------------- */

function commitIdempotencyCacheKey(projectDir: string, chapter: number, idempotencyKey: string): string {
  return `${resolve(projectDir)}\u0000${chapter}\u0000${idempotencyKey}`;
}

function isValidIdempotencyKey(value: string): boolean {
  return /^[A-Za-z0-9._:-]{8,160}$/u.test(value);
}

function receiptPath(projectDir: string, chapter: number, idempotencyKey: string): string {
  const digest = sha256(commitIdempotencyCacheKey(projectDir, chapter, idempotencyKey));
  return join(projectDir, ".story-engine-ui", "commit-idempotency", `${digest}.json`);
}

async function ensureReceiptDirectory(projectDir: string): Promise<string> {
  const uiRoot = join(projectDir, ".story-engine-ui");
  const dir = join(uiRoot, "commit-idempotency");
  const projectStats = await lstat(projectDir);
  if (!projectStats.isDirectory() || projectStats.isSymbolicLink()) {
    throw new Error(`Unsafe durable commit receipt project root: ${projectDir}`);
  }
  for (const path of [uiRoot, dir]) {
    try {
      const stats = await lstat(path);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new Error(`Unsafe durable commit receipt directory: ${path}`);
      }
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      await mkdir(path);
      const stats = await lstat(path);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new Error(`Unsafe durable commit receipt directory: ${path}`);
      }
    }
  }
  return dir;
}

async function readDurableCommitReceipt(
  projectDir: string,
  chapter: number,
  idempotencyKey: string,
): Promise<DurableCommitReceipt | undefined> {
  const path = receiptPath(projectDir, chapter, idempotencyKey);
  try {
    await validateExistingReceiptParents(projectDir);
    const parsed = JSON.parse(await readReceiptFileNoFollow(path)) as unknown;
    if (!isDurableCommitReceipt(parsed)) throw new Error(`Unreadable durable commit receipt: ${path}`);
    return parsed;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function findDurableReceiptForTransaction(
  projectDir: string,
  chapter: number,
  transactionId: string,
  previewHash: string,
): Promise<DurableCommitReceipt | undefined> {
  const dir = join(projectDir, ".story-engine-ui", "commit-idempotency");
  let entries;
  try {
    await validateExistingReceiptParents(projectDir);
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
  let match: DurableCommitReceipt | undefined;
  for (const entry of entries) {
    if (!entry.name.endsWith(".json")) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Unsafe durable commit receipt entry: ${entry.name}`);
    const path = join(dir, entry.name);
    const parsed = JSON.parse(await readReceiptFileNoFollow(path)) as unknown;
    if (!isDurableCommitReceipt(parsed)) throw new Error(`Unreadable durable commit receipt: ${path}`);
    if (
      parsed.projectHash !== sha256(resolve(projectDir))
      || parsed.chapter !== chapter
      || parsed.transactionId !== transactionId
      || parsed.previewHash !== previewHash
    ) continue;
    if (match && !sameReceiptIdentity(match, parsed)) {
      throw new Error("Conflicting durable receipts exist for the same preview transaction.");
    }
    match = parsed;
  }
  return match;
}

async function validateExistingReceiptParents(projectDir: string): Promise<void> {
  for (const path of [projectDir, join(projectDir, ".story-engine-ui"), join(projectDir, ".story-engine-ui", "commit-idempotency")]) {
    const stats = await lstat(path);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`Unsafe durable commit receipt parent: ${path}`);
    }
  }
}

async function readReceiptFileNoFollow(path: string): Promise<string> {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const [handleStats, pathStats] = await Promise.all([handle.stat(), lstat(path)]);
    if (
      !handleStats.isFile()
      || pathStats.isSymbolicLink()
      || !pathStats.isFile()
      || handleStats.dev !== pathStats.dev
      || handleStats.ino !== pathStats.ino
      || handleStats.nlink !== 1
    ) {
      throw new Error(`Unsafe durable commit receipt file: ${path}`);
    }
    return await handle.readFile("utf-8");
  } finally {
    await handle.close();
  }
}

async function claimDurableCommitReceipt(projectDir: string, receipt: DurableCommitReceipt): Promise<DurableCommitReceipt | undefined> {
  await ensureReceiptDirectory(projectDir);
  const path = receiptPath(projectDir, receipt.chapter, receipt.idempotencyKey);
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      return readDurableCommitReceipt(projectDir, receipt.chapter, receipt.idempotencyKey);
    }
    throw error;
  }
  try {
    await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, "utf-8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return undefined;
}

async function writeDurableCommitReceipt(projectDir: string, receipt: DurableCommitReceipt): Promise<void> {
  const dir = await ensureReceiptDirectory(projectDir);
  const path = receiptPath(projectDir, receipt.chapter, receipt.idempotencyKey);
  const existing = await lstat(path);
  if (!existing.isFile() || existing.isSymbolicLink()) throw new Error(`Unsafe durable commit receipt: ${path}`);
  const tmp = join(dir, `.${sha256(receipt.idempotencyKey).slice(0, 16)}.${process.pid}.${Date.now()}.tmp`);
  try {
    const handle = await open(tmp, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, "utf-8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
  } catch (error) {
    // 失败必清 tmp（writeFileAtomic 同口径）：残留会被下一次快照扫进 git。tmp 名带本进程 pid+时间戳，
    // 只可能属于本次调用，force rm 不会误删别处的临时文件；清理失败也绝不盖过原始错误。
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function removePendingCommitReceipt(projectDir: string, receipt: DurableCommitReceipt): Promise<void> {
  const existing = await readDurableCommitReceipt(projectDir, receipt.chapter, receipt.idempotencyKey);
  if (!existing || existing.status !== "pending") return;
  if (!sameReceiptIdentity(existing, receipt)) return;
  await rm(receiptPath(projectDir, receipt.chapter, receipt.idempotencyKey), { force: true });
}

/**
 * pending 对账的三向结论：恢复成功 / 确认对不上 / 对账本身读失败。
 * IO 异常必须与「确认未入库」严格分开（治旧账：两者曾共用同一条 409 文案，
 * 对账读失败会误导用户去删回执——而回执恰是上次定稿的唯一证据）。
 */
type PendingReceiptRecovery =
  | { readonly outcome: "recovered"; readonly payload: CommitApplySuccessPayload }
  | { readonly outcome: "mismatch" }
  | { readonly outcome: "unreadable"; readonly error: string };

/** 对账读盘：ENOENT=文件确实不在（对账得以继续/结论可信），其余错误=对账本身失败。 */
async function readForPendingReconciliation(
  path: string,
): Promise<{ readonly content?: string; readonly unreadable?: string }> {
  try {
    return { content: await readFile(path, "utf-8") };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return {};
    return { unreadable: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * pending 回执的恢复出口（数据安全收口硬不变量 #7：先恢复或拒绝，绝不删证据后重做）。
 * pending 只证明「claim 之后、completed 回执落盘之前」中断，入库成败未知，故先做磁盘对账：
 * 引擎事务残留已在进锁时由 recoverProjectCommitTransactions 收尾（无半写），而 commitFastDraft
 * 把草稿原文写入 chapters/N.md——若该章已入库且内容与当前草稿哈希一致，说明入库其实已成功、
 * 只是回执没写完。此时按磁盘真值补写 completed 回执并重建响应，是恢复而不是重复写入。
 * 对不上（章未入库/内容被改/哈希不一致）返回 mismatch，由调用方 fail-closed 409 + 可执行出路；
 * 对账读盘 IO 失败返回 unreadable，调用方另行报错（只让稍后重试，绝不诱导删回执）。
 */
async function recoverPendingCommitReceiptFromDisk(
  projectDir: string,
  chapter: number,
  receipt: DurableCommitReceipt,
): Promise<PendingReceiptRecovery> {
  const draft = await readForPendingReconciliation(defaultDraftPath(projectDir, chapter));
  if (draft.unreadable !== undefined) return { outcome: "unreadable", error: draft.unreadable };
  // 草稿不在 → 没有可对账的基准，按「对不上」处理（block 文案已含「草稿在预览后已变化」的情形）。
  if (draft.content === undefined) return { outcome: "mismatch" };
  const draftContent = draft.content;
  const chapterPath = defaultCommittedChapterPath(projectDir, chapter);
  const committed = await readForPendingReconciliation(chapterPath);
  if (committed.unreadable !== undefined) return { outcome: "unreadable", error: committed.unreadable };
  const chapterContent = committed.content;
  if (!chapterContent || sha256(chapterContent) !== sha256(draftContent)) return { outcome: "mismatch" };
  const warnings = [
    "上次定稿在入库成功后、回执落盘前中断；本次按磁盘真值补写回执并返回结果（恢复，未重复入库）。",
    "详细变更清单不可恢复：report 中 updatedCharacters / timelineEventIds / updatedHooks / updatedWorld / updatedCalendar 均为占位空值（不代表实际未更新），真实变更以磁盘上的状态文件为准。",
  ];
  const overview = await buildStateOverview({ projectDir, chapter, maxTimelineEvents: 8 })
    .catch((error: unknown) => {
      warnings.push(`overview refresh failed after recovered commit: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    });
  let payload: CommitApplySuccessPayload = {
    ok: true,
    report: {
      chapter,
      passed: true,
      chapterPath,
      // 引擎 CommitReport 这些字段为必填（commit-engine.ts:192-196），标 undefined 不兼容类型；
      // 占位空值的诚实性由上面第二条 warning 承担，recoveredFromPendingReceipt 供前端识别恢复场景。
      updatedCharacters: [],
      timelineEventIds: [],
      updatedHooks: [],
      updatedWorld: false,
      updatedCalendar: false,
      issues: [],
      recoveredFromPendingReceipt: true,
    },
    overview,
    chapterContent,
    chapterTitle: extractDraftTitle(chapterContent) ?? `第${chapter}章`,
    warnings,
  };
  const completedReceipt: DurableCommitReceipt = { ...receipt, status: "completed", payload };
  try {
    await writeDurableCommitReceipt(projectDir, completedReceipt);
  } catch (error) {
    // 与主路径同口径：入库确已成功，回执补写再失败只降级为警告（下次同键重试还会走这条对账）。
    const receiptWarning = `idempotency receipt persistence failed after recovered commit: ${error instanceof Error ? error.message : String(error)}`;
    payload = { ...payload, warnings: [...warnings, receiptWarning] };
  }
  return { outcome: "recovered", payload };
}

/** pending 对账失败时的 409 文案：fail-closed，但必须给出可执行出路（含回执文件的确切路径）。 */
function pendingReceiptBlockMessage(projectDir: string, chapter: number, idempotencyKey: string): string {
  const receiptFile = join(".story-engine-ui", "commit-idempotency", basename(receiptPath(projectDir, chapter, idempotencyKey)));
  return `检测到未完成的同键定稿记录，磁盘对账显示该章未按此次预览入库（或草稿在预览后已变化）；为避免重复写入，已拒绝自动重试。`
    + `可执行出路：1) 草稿有改动时，重新生成定稿预览会产出新凭证与新幂等键，按新预览重试即可；`
    + `2) 人工核对确认上次定稿确实未生效后，删除回执文件 ${receiptFile} 再用原预览凭证重试。`;
}

/**
 * 用户可见文案的路径消毒（铁律④·绝不泄露本地绝对路径）：与 commit-apply.ts scrubBareEntityIdsFromText /
 * prune-snapshots.ts scrubLocalAbsolutePaths 的路径分支同一口径。errno 原文
 * （如 `EACCES: permission denied, open '/abs/path/chapters/0001.md'`）内嵌绝对路径，直达用户前必须洗掉。
 */
function scrubLocalAbsolutePaths(text: string): string {
  return text.replace(/'?\/(?:Users|home|var|tmp|private)\/[^'"\s]*'?/gu, "(本地路径)");
}

/**
 * pending 对账本身读失败（IO 异常）时的 409 文案：与「对不上」严格分开——
 * 上次定稿是否生效此时未知，出路只有稍后重试；回执是唯一证据，文案绝不提删除。
 */
function pendingReceiptUnreadableMessage(projectDir: string, chapter: number, idempotencyKey: string, error: string): string {
  const receiptFile = join(".story-engine-ui", "commit-idempotency", basename(receiptPath(projectDir, chapter, idempotencyKey)));
  return `检测到未完成的同键定稿记录，但对账读取失败（${scrubLocalAbsolutePaths(error)}），无法确认上次定稿是否已生效；为避免重复写入，已拒绝自动重试。`
    + `请稍后重试；若持续失败请检查磁盘与文件权限。回执文件 ${receiptFile} 是上次定稿的唯一证据，请勿删除。`;
}

/**
 * replayed 判定前的磁盘对账（安全不变量⑦）：该章已入库文件存在、且全文与回执 payload 记录的
 * 入库内容逐字一致，才算「确实已入库」——报 replayed 必须有这个肯定性确认。
 * 三向结论与 pending 对账（recoverPendingCommitReceiptFromDisk）同一纪律：
 * not_committed（文件不在/为空/内容不符=确认对不上）与 unreadable（对账本身读失败）严格分开，
 * 调用方据此决定「fall through 走真 apply」的后续收口文案（前者给可执行出路，后者只说稍后重试）。
 */
type ReplayDiskReconciliation =
  | { readonly outcome: "committed" }
  | { readonly outcome: "not_committed" }
  | { readonly outcome: "unreadable"; readonly error: string };

async function reconcileReplayWithDisk(
  projectDir: string,
  chapter: number,
  payload: CommitApplySuccessPayload,
): Promise<ReplayDiskReconciliation> {
  const committed = await readForPendingReconciliation(defaultCommittedChapterPath(projectDir, chapter));
  if (committed.unreadable !== undefined) return { outcome: "unreadable", error: committed.unreadable };
  const chapterContent = committed.content;
  if (!chapterContent || sha256(chapterContent) !== sha256(payload.chapterContent)) {
    return { outcome: "not_committed" };
  }
  return { outcome: "committed" };
}

/**
 * completed 回执与磁盘真相矛盾（回执称已入库、对账确认该章未入库/内容不符）时的 409 文案：
 * fail-closed + 可执行出路（人工核对确认未入库后删回执重试=真实重新入库）。
 */
function completedReceiptDiskMismatchMessage(projectDir: string, chapter: number, idempotencyKey: string): string {
  const receiptFile = join(".story-engine-ui", "commit-idempotency", basename(receiptPath(projectDir, chapter, idempotencyKey)));
  return `检测到同键定稿的已完成记录，但磁盘对账显示该章未按此次预览入库（可能被撤销或内容已变化）；为避免谎报成功，已拒绝按重放返回。`
    + `可执行出路：1) 草稿有改动时，重新生成定稿预览会产出新凭证与新幂等键，按新预览重试即可；`
    + `2) 人工核对确认该章确实未入库后，删除回执文件 ${receiptFile} 再用原预览凭证重试（将真实重新入库）。`;
}

/**
 * completed 回执的磁盘对账本身读失败（IO 异常）时的 409 文案：与「确认对不上」严格分开——
 * 该章是否已入库此时未知，出路只有稍后重试；回执是唯一证据，文案绝不提删除（同 pending 纪律）。
 */
function completedReceiptUnreadableMessage(projectDir: string, chapter: number, idempotencyKey: string, error: string): string {
  const receiptFile = join(".story-engine-ui", "commit-idempotency", basename(receiptPath(projectDir, chapter, idempotencyKey)));
  return `检测到同键定稿的已完成记录，但磁盘对账读取失败（${scrubLocalAbsolutePaths(error)}），无法确认该章是否已入库；为避免谎报成功，已拒绝按重放返回。`
    + `请稍后重试；若持续失败请检查磁盘与文件权限。回执文件 ${receiptFile} 是上次定稿的唯一证据，请勿删除。`;
}

function receiptMatchesRequest(
  receipt: DurableCommitReceipt,
  credentials: { readonly transactionId?: unknown; readonly previewHash?: unknown; readonly idempotencyKey?: unknown },
  projectDir: string,
  chapter: number,
): boolean {
  return receipt.projectHash === sha256(resolve(projectDir))
    && receipt.chapter === chapter
    && typeof credentials.transactionId === "string"
    && typeof credentials.previewHash === "string"
    && typeof credentials.idempotencyKey === "string"
    && credentials.transactionId === receipt.transactionId
    && credentials.previewHash === receipt.previewHash
    && credentials.idempotencyKey.trim() === receipt.idempotencyKey;
}

function sameReceiptIdentity(left: DurableCommitReceipt, right: DurableCommitReceipt): boolean {
  return left.projectHash === right.projectHash
    && left.chapter === right.chapter
    && left.idempotencyKey === right.idempotencyKey
    && left.transactionId === right.transactionId
    && left.previewHash === right.previewHash;
}

function receiptFromCache(
  entry: Extract<CommitIdempotencyEntry, { readonly status: "completed" }>,
  chapter: number,
  idempotencyKey: string,
  projectDir: string,
): DurableCommitReceipt {
  return {
    version: 1,
    status: "completed",
    projectHash: sha256(resolve(projectDir)),
    chapter,
    idempotencyKey,
    transactionId: entry.transaction.transactionId,
    previewHash: entry.transaction.previewHash,
    createdAt: "memory-cache",
    payload: entry.payload,
  };
}

function isDurableCommitReceipt(value: unknown): value is DurableCommitReceipt {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1
    || (record.status !== "pending" && record.status !== "completed")
    || typeof record.projectHash !== "string"
    || !/^[0-9a-f]{64}$/u.test(record.projectHash)
    || typeof record.chapter !== "number"
    || !Number.isInteger(record.chapter)
    || record.chapter <= 0
    || typeof record.idempotencyKey !== "string"
    || !isValidIdempotencyKey(record.idempotencyKey)
    || typeof record.transactionId !== "string"
    || typeof record.previewHash !== "string"
    || typeof record.createdAt !== "string"
  ) return false;
  if (record.status === "completed") {
    const payload = record.payload;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload) || (payload as { ok?: unknown }).ok !== true) return false;
  }
  return true;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf-8").digest("hex");
}
