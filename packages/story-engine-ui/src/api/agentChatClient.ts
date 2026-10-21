/**
 * agentChatClient — 读 POST /api/agent/chat 的 SSE 流，把后端事件分发给回调。
 *
 * 后端事件协议（见 server/routes/agent-chat.ts）：
 *   - text-delta   { text }                                 → onTextDelta(text)
 *   - tool-call    { toolCallId, toolName, args }           → onToolCall({ toolName })
 *   - tool-result  { toolCallId, toolName, output }         → onToolResult({ toolName, overview, refreshScope, snapshotId })
 *   - tool-error   { toolCallId, toolName, error, retryable } → onToolError({ toolCallId, toolName, message, retryable })
 *   - error        { error, retryable, reason }             → onError(message, retryable, reason)
 *   - done         { finishReason? }                        → onDone()
 *
 * SSE 行读法参考现有 fetchChapterChatStream：跨 chunk 缓冲，空行 flush 一个事件。
 * 铁律：绝不静默失败——HTTP 非 2xx / 无 body / SSE error 事件，统统走 onError（默认可重试）。
 */
import { mergeSignals } from "./fetchJson.js";
import type { StateOverview, DraftReviewView, QualityCardReport } from "./types.js";
import type { AiFlavorReport } from "../types.js";
import type { BrainstormCardData } from "../type-defs/workspace.js";
import { readBrainstormData } from "../utils/brainstormCard.js";
import type { AiErrorReason } from "../server/lib/ai-errors.js";

const AI_ERROR_REASONS: readonly AiErrorReason[] = ["setup", "auth", "quota", "rate-limit", "server", "network", "timeout", "unknown"];

/** 服务端给的出错原因（P11）：只认约定的几个值，别的当没给。 */
export function readAiErrorReason(value: unknown): AiErrorReason | undefined {
  return AI_ERROR_REASONS.find((reason) => reason === value);
}

export interface StreamAgentChatRequest {
  readonly projectPath: string;
  readonly messages: readonly { readonly role: "user" | "assistant"; readonly content: string }[];
  /** 用户当前打开/停留的章号。后端据此引导 agent 默认作用于该章、工具缺省回退该值（H3：回看旧章不写错章）。 */
  readonly currentChapter?: number;
  /**
   * R7.2：上一个有写盘回合的首个快照（该回合第一次写盘前）。后端 undo 工具优先按它整回合回退，
   * 与作者说「撤销上一步」= 撤上一回合全部改动 的理解一致。
   */
  readonly lastTurnUndoHint?: { readonly snapshotId: string; readonly changes: number };
  /** 结构化动作（用户点了「确认定稿」按钮）：服务端直接执行对应工具，不经模型。 */
  readonly action?: AgentUserAction;
}

/** 结构化动作（与服务端 agent/user-actions.ts 的 UserAction 同形）。 */
export type AgentUserAction =
  | { readonly toolName: "commit_apply"; readonly chapter: number; readonly previewToken?: string; readonly excluded?: readonly string[]; readonly dayOverride?: number }
  | { readonly toolName: "prune_snapshots"; readonly keep?: number }
  | { readonly toolName: "check_continuity"; readonly chapter: number; readonly fresh?: boolean }
  | { readonly toolName: "commit_preview"; readonly chapter: number }
  | { readonly toolName: "generate_draft"; readonly chapter: number; readonly chapterGoal?: string }
  | { readonly toolName: "ai_review"; readonly chapter: number }
  | { readonly toolName: "quality_check"; readonly chapter: number }
  | { readonly toolName: "undo" }
  | { readonly toolName: "revise_draft"; readonly chapter: number; readonly fixes: readonly { readonly targetText: string; readonly revisionGoal: string }[] }
  | { readonly toolName: "ledger_decision"; readonly key: string; readonly decisions: readonly unknown[]; readonly label?: string }
  | { readonly toolName: "foundation_decision"; readonly key: string; readonly input: Readonly<Record<string, unknown>>; readonly label?: string }
  | { readonly toolName: "brainstorm_chapter"; readonly chapter: number; readonly idea?: string; readonly avoid?: readonly string[] };

/** 定稿预览账本清单里的一条（与服务端 agent/tools/commit-preview.ts 的 ledgerChecklist 同形）。 */
export interface LedgerChecklistItemView {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  /** 为什么要作者看（同一原因的条目清单里归在一起）。 */
  readonly reason?: string;
  readonly detail?: string;
  readonly removable: boolean;
  /** 作者能改的「第几天」（故事时间线）。 */
  readonly editableDay?: number;
  /** 引擎没把握、请作者确认。 */
  readonly needsConfirm?: boolean;
  /** 默认不勾（要确认的改记）：不勾＝这条改记不作数，勾上才算确认。 */
  readonly defaultUnchecked?: boolean;
}

/** 核账结果里的一条：本章原句 ↔ 前文原句；对设定本的条目 earlierQuote＝设定原文（R7.3）。 */
export interface ContinuityCheckItem {
  readonly quote: string;
  readonly earlierQuote: string;
  readonly earlierChapter: number;
  readonly reason: string;
  /** R7.3 对的是设定本（人物卡 / 地点 / 资产 / 世界规则）而不是某一章。 */
  readonly againstSetting?: { readonly label: string };
  /** R7.3 错在哪一章、按钮就改哪一章（前文章和设定不一致时指向前文那章）；缺省＝本章。 */
  readonly fixChapter?: number;
}

/** check_continuity 结果（投影到消息上渲染「核账」卡）。 */
export interface ContinuityCheckView {
  readonly chapter: number;
  readonly sure: readonly ContinuityCheckItem[];
  readonly maybe: readonly ContinuityCheckItem[];
  /** 错在前面某章、之前报过还没改的。 */
  readonly earlierOpen?: readonly ContinuityCheckItem[];
}

function toContinuityItems(value: unknown): readonly ContinuityCheckItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (typeof record.quote !== "string" || typeof record.earlierQuote !== "string") return [];
    const againstSetting = record.againstSetting && typeof record.againstSetting === "object"
      && typeof (record.againstSetting as { label?: unknown }).label === "string" && (record.againstSetting as { label: string }).label.trim()
      ? { label: (record.againstSetting as { label: string }).label }
      : undefined;
    return [{
      quote: record.quote,
      earlierQuote: record.earlierQuote,
      earlierChapter: typeof record.earlierChapter === "number" ? record.earlierChapter : 0,
      reason: typeof record.reason === "string" ? record.reason : "",
      ...(againstSetting ? { againstSetting } : {}),
      ...(Number.isInteger(record.fixChapter) && (record.fixChapter as number) > 0 ? { fixChapter: record.fixChapter as number } : {}),
    }];
  });
}

/** commit_preview 的质量问题明细（{severity,type,message} → 给作者看的文案）。防御解析：非字符串丢掉、截超长、最多 20 条。 */
function toIssueMessages(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((item): string[] => {
      if (typeof item === "string") return [item];
      if (!item || typeof item !== "object") return [];
      const message = (item as Record<string, unknown>).message;
      return typeof message === "string" && message.trim() ? [message.trim()] : [];
    })
    .map((message) => (message.length > 300 ? `${message.slice(0, 300)}…` : message))
    .slice(0, 20);
}

export interface AgentToolResult {
  readonly toolCallId?: string;
  readonly toolName: string;
  /** 工具诚实成功标志（写类/出稿工具）：false=引擎拒绝/失败/未写入。前端据此把时间线置 failed，防 agent 文本谎报盖过真实结果。 */
  readonly ok?: boolean;
  /** 写类工具因「需用户确认」被挡下（如删除角色未确认）：前端据此把该步骤置 needs_confirmation（待确认·暖色），区别于失败/红。 */
  readonly needsConfirmation?: boolean;
  /** 部分纠错失败（写成功但有要删的目标没命中）：前端据此把该步骤置 partial（部分完成·琥珀色），不当全成功绿色（修#1）。 */
  readonly partialMiss?: boolean;
  /** R7.9：工具参数/输出没过 Mastra 校验（服务端归一标记）——投影层一律置「失败」，即便裁决类工具（没跑≠裁决未过）。 */
  readonly toolValidationFailure?: boolean;
  readonly summary?: string;
  /** 改草稿类工具（generate_draft/revise_draft）返回的「当前章完整草稿正文（去 Markdown 标题）」。
   *  前端据此把真正文载入工作区——否则只能用不含正文的 overview 刷新，草稿被占位覆盖、autosave 抹掉真正文。 */
  readonly draftBody?: string;
  readonly draftTitle?: string;
  /** 这份正文写回时的版本号（revise_draft 带，同一进程严格递增）：并行改稿的结果到达顺序不等于写入顺序，前端只套用更新的。 */
  readonly draftVersion?: number;
  /** commit_apply 入库成功标志：前端据此把 draftBody 以 committed 状态（而非 draft_ready）载入工作区，防 autosave 复活已入库章节。 */
  readonly committed?: boolean;
  /** undo_last_change 专属：true=磁盘真的被 git 回退了。前端据此冻结 autosave、改读磁盘真值、回合收尾后整页重载——
   *  否则内存里撤销前的旧稿会被 autosave 写回去（此前只靠 409 冲突兜底）。 */
  readonly undone?: boolean;
  readonly overview?: StateOverview;
  readonly refreshScope?: "full" | "foundation";
  readonly snapshotId?: string;
  /** 写类/出稿工具实际操作的章号：透传给投影层回写进 turnSnapshots，供「撤销到此回合」写回该回合实际操作的章。 */
  readonly chapter?: number;
  /** check_ai_flavor 专属：整份去 AI 味体检报告（含 violations/usedFallback）。
   *  这俩字段不在 read/draft 工具的轻量投影白名单里，故为体检工具专门透传整份报告，
   *  前端据此落 store 渲染体检卡。 */
  readonly aiFlavorReport?: AiFlavorReport;
  /** ai_review 专属：整份审稿报告（含 issues 问题清单）。前端据此渲染「审校问题清单」可点卡。 */
  readonly draftReview?: DraftReviewView;
  /** commit_apply 专属：整份入库报告（CommitReport）。前端据此渲染「入库」delta 卡（这章改了哪些角色/伏笔/线索/时间线）。 */
  readonly commitReport?: unknown;
  /** quality_check 专属：分层质检报告（RefinedQualityReport 子集）。前端据此渲染「质检」明细卡。 */
  readonly qualityReport?: QualityCardReport;
  /** check_continuity 专属：核账结果。 */
  readonly continuityCheck?: ContinuityCheckView;
  /** check_continuity 专属：核的是工作稿哪一版（服务端按读到的文件算）；核的是定稿正文时没有。 */
  readonly checkedVersion?: string;
  /** brainstorm_chapter 专属：几种走法（重构 P6 头脑风暴）。 */
  readonly brainstorm?: BrainstormCardData;
  /** check_continuity 专属：还在读前文的结构化进度（只在 ok:false 且原因=还在读时有）。
   *  前端要区分「还在读」和「出错」用这个字段，别解析 failures 的文字（R4.1）。 */
  readonly continuityPending?: { readonly done: number; readonly total: number };
  /** suggest_next_steps 专属：agent 提议的下一步选项，透传给投影层挂到消息→驱动「下一步」卡。
   *  choice.action（R4.7）：服务端自己生成的确定性选项带结构化动作，点击直接发 body.action 不经模型；
   *  模型生成的选项没有 action。 */
  readonly nextStepPrompt?: {
    readonly question: string;
    readonly choices: readonly { readonly label: string; readonly intent: string; readonly recommended?: boolean; readonly action?: AgentUserAction }[];
  };
  /** commit_preview 专属：人物名近形漂移提醒（引擎确定性判定）。透传给投影层挂到消息→渲染固定「人物名一致性」提醒卡，不靠模型转述。 */
  readonly nameConsistencyWarnings?: readonly { readonly establishedName: string; readonly driftedVariant: string; readonly message: string }[];
  /** commit_preview 专属：伏笔/线索待收口提醒（引擎确定性判定：超 3 章未推进）。透传给投影层挂到消息→渲染固定「伏笔/线索待收口」提醒卡，不靠模型转述。 */
  readonly staleThreadWarnings?: readonly { readonly kind: string; readonly title: string; readonly lastTouchedChapter: number; readonly chaptersSinceTouched: number; readonly message: string }[];
  /** commit_preview 专属：结构化定稿预览（R3）——裁决/阻断项/质量问题计数透传给投影层渲染固定「定稿预览」卡。
   *  裁决不靠模型转述：模型可能把「暂不可定稿」说成小问题或略过不提。 */
  readonly commitPreview?: {
    readonly chapter: number;
    readonly canCommit: boolean;
    readonly blockingReasons?: readonly string[];
    readonly summary?: string;
    readonly draftIssueCount?: number;
    readonly semanticIssueCount?: number;
    /** R7.7·报告 4.3：质量问题明细直接进卡（默认折叠），不再指向界面上不存在的「质检卡」。 */
    readonly draftIssues?: readonly string[];
    readonly semanticIssues?: readonly string[];
    readonly previewToken?: string;
  };
  /** commit_apply 专属：模型发起的定稿请求没写盘、等用户确认——投影层据此挂「确认定稿」按钮。 */
  readonly commitConfirmAction?: { readonly chapter: number; readonly previewToken?: string };
  /** prune_snapshots 专属：模型只做了预览、有可裁内容，等用户点「确认裁剪」按钮。 */
  readonly pruneConfirmAction?: { readonly keep?: number };
  /** manage_ledger 专属：改账是作者裁定，模型只提了草案，等作者点「确认改账」按钮。 */
  readonly ledgerConfirmAction?: LedgerConfirmTarget;
  /** generate_draft 专属（重构 P4）：这一章已有稿子，AI 不覆盖，等作者点「重写这一章」。 */
  readonly rewriteConfirmAction?: RewriteConfirmTarget;
  /** foundation_write 专属（重构 P4）：删角色 / 覆盖已确立设定是作者档，等作者点「确认改设定」。 */
  readonly foundationConfirmAction?: FoundationConfirmTarget;
}

/** 「重写这一章」按钮带回的东西。 */
export interface RewriteConfirmTarget {
  readonly chapter: number;
  readonly chapterGoal?: string;
}

/** 「确认改设定」按钮带回的东西（被拦下的那次资料写入，服务端执行前再校验）。 */
export interface FoundationConfirmTarget {
  readonly key: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly label?: string;
}

/** 「确认改账」按钮带回服务端的东西（manage_ledger 提的裁定草案，服务端执行前再校验）。 */
export interface LedgerConfirmTarget {
  readonly key: string;
  readonly decisions: readonly unknown[];
  readonly label?: string;
}

export interface AgentToolError {
  readonly toolCallId?: string;
  readonly toolName: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface AgentChatHandlers {
  readonly onTextDelta: (text: string) => void;
  /** 服务端状态说明（如「历史过长，仅保留最近 N 条作为上下文」）：必须展示给用户，不能静默吞掉（R4）。 */
  readonly onStatus?: (message: string) => void;
  /** 思考链增量（仅思考模式下有）。累加成消息的「思考过程」。 */
  readonly onReasoningDelta?: (text: string) => void;
  /** 出稿正文增量（generate_draft 流式）：逐字进编辑器。带本次章号，前端只往当前章追。 */
  readonly onDraftDelta?: (info: { readonly chapter: number; readonly text: string }) => void;
  /** AI 出稿进行到哪一步（plan 拟章纲 / write 写正文）。 */
  readonly onDraftPhase?: (info: { readonly chapter: number; readonly phase: "plan" | "write" }) => void;
  readonly onToolCall: (info: { readonly toolCallId?: string; readonly toolName: string }) => void;
  readonly onToolResult: (info: AgentToolResult) => void;
  /** 工具内部抛错：携带 toolCallId/toolName，让上层把对应步骤/卡片收尾为 failed，再 append 错误。 */
  readonly onToolError: (info: AgentToolError) => void;
  readonly onError: (message: string, retryable: boolean, reason?: AiErrorReason) => void;
  readonly onDone: () => void;
  /** 本轮真实 token 用量（服务端轮末发；服务商没回用量时为 0）。 */
  readonly onUsage?: (usage: AgentTurnUsage) => void;
}

/** 一轮对话的 token 用量（合计：对话 AI + 工具内部调用）。 */
export interface AgentTurnUsage {
  readonly input: number;
  readonly cachedInput: number;
  readonly output: number;
}

/** 空闲看门狗超时：上游/网络半挂时多久没有任何 SSE 数据就判超时、中止流（M3：治「永久转圈」）。 */
const AGENT_IDLE_TIMEOUT_MS = 90_000;

export async function streamAgentChat(
  input: StreamAgentChatRequest,
  handlers: AgentChatHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const { signal: mergedSignal, cleanup } = mergeSignals(signal);
  // M3：在 mergedSignal（含用户「停止」）之上再叠一个内部 controller，用于「空闲超时」中止——
  // 任一来源 abort 都会中止 fetch/读流。idleFired 区分「超时」与「用户主动停止」，给不同收尾。
  const idleController = new AbortController();
  let idleFired = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const onMergedAbort = () => idleController.abort(mergedSignal.reason);
  if (mergedSignal.aborted) idleController.abort(mergedSignal.reason);
  else mergedSignal.addEventListener("abort", onMergedAbort, { once: true });
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleFired = true;
      idleController.abort(new DOMException("agent-idle-timeout", "AbortError"));
    }, AGENT_IDLE_TIMEOUT_MS);
  };
  const clearIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
  };

  let doneEmitted = false;
  const emitDone = () => {
    if (doneEmitted) return;
    doneEmitted = true;
    handlers.onDone();
  };

  try {
    armIdle();
    const response = await fetch("/api/agent/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectPath: input.projectPath,
        messages: input.messages,
        ...(typeof input.currentChapter === "number" ? { currentChapter: input.currentChapter } : {}),
        ...(input.lastTurnUndoHint ? { lastTurnUndoHint: input.lastTurnUndoHint } : {}),
        ...(input.action ? { action: input.action } : {}),
      }),
      signal: idleController.signal,
    });
    if (!response.ok || !response.body) {
      // 非 2xx：尽量读出服务端给的真实原因（如「项目目录不存在」「API Key 未设置」），别只甩一个
      // 「请求失败：500」让用户摸不着头脑。读不到 body 才退回状态码。
      const server = await readServerError(response);
      handlers.onError(server.message ?? `写作助手请求失败：${response.status}`, true, server.reason);
      emitDone();
      return;
    }

    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = "";
    let eventName = "message";
    let dataLines: string[] = [];
    let badFrameReported = false;

    const flush = () => {
      if (dataLines.length === 0) {
        eventName = "message";
        return;
      }
      const raw = dataLines.join("\n");
      dataLines = [];
      const current = eventName;
      eventName = "message";
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        // 审计 Low：坏帧不再无声吞——断流尾部截断的 error/done 帧解析失败时若不报，
        // 回合会以「正常结束+内容缺尾」假收场（违反本文件头的绝不静默铁律）。每条流只报一次。
        if (!badFrameReported) {
          badFrameReported = true;
          handlers.onError("收到无法解析的事件帧（连接可能被截断），本次回复可能不完整；可重试该消息。", true);
        }
        return;
      }
      dispatchEvent(current, parsed);
    };

    const dispatchEvent = (event: string, parsed: unknown) => {
      if (!isRecord(parsed)) return;
      switch (event) {
        case "text-delta":
          if (typeof parsed.text === "string") handlers.onTextDelta(parsed.text);
          return;
        case "status":
          // 服务端状态说明（R4：历史窗口裁剪等）必须照实带给用户，不能静默吞掉。
          if (typeof parsed.message === "string") handlers.onStatus?.(parsed.message);
          return;
        case "reasoning-delta":
          if (typeof parsed.text === "string") handlers.onReasoningDelta?.(parsed.text);
          return;
        case "draft-delta":
          if ((parsed.phase === "plan" || parsed.phase === "write") && typeof parsed.chapter === "number") {
            handlers.onDraftPhase?.({ chapter: parsed.chapter, phase: parsed.phase });
            return;
          }
          if (typeof parsed.text === "string" && typeof parsed.chapter === "number") {
            handlers.onDraftDelta?.({ chapter: parsed.chapter, text: parsed.text });
          }
          return;
        case "tool-call":
          if (typeof parsed.toolName === "string") {
            handlers.onToolCall({
              toolName: parsed.toolName,
              toolCallId: typeof parsed.toolCallId === "string" ? parsed.toolCallId : undefined,
            });
          }
          return;
        case "tool-result": {
          if (typeof parsed.toolName !== "string") return;
          const output = isRecord(parsed.output) ? parsed.output : {};
          handlers.onToolResult({
            toolName: parsed.toolName,
            toolCallId: typeof parsed.toolCallId === "string" ? parsed.toolCallId : undefined,
            // 诚实成功标志 + 摘要必须透传给投影层，否则 ok:false 的失败会被显示成完成（结构性谎报）。
            // 条件透传：读类工具无 ok/summary 则不带这俩 key（保持轻量、不影响读类行为）。
            ...(typeof output.ok === "boolean" ? { ok: output.ok } : {}),
            // 需确认（删除角色未确认等）：透传给投影层置「待确认」步骤态，区别于失败。
            ...(output.needsConfirmation === true ? { needsConfirmation: true } : {}),
            ...(output.partialMiss === true ? { partialMiss: true } : {}),
            // R7.9：Mastra 校验失败标记（服务端 agent-chat 归一时带上）——投影层据此一律置「失败」，
            // 即便是裁决类工具（校验失败=工具没跑，不是「裁决未过」）。
            ...(output.toolValidationFailure === true ? { toolValidationFailure: true } : {}),
            ...(typeof output.summary === "string" ? { summary: output.summary } : {}),
            // 改草稿工具的真正文必须透传，前端据此把真正文载入工作区（防占位覆盖+autosave 抹稿）。
            ...(typeof output.draftBody === "string" ? { draftBody: output.draftBody } : {}),
            ...(typeof output.draftTitle === "string" ? { draftTitle: output.draftTitle } : {}),
            ...(typeof output.draftVersion === "number" && Number.isFinite(output.draftVersion) ? { draftVersion: output.draftVersion } : {}),
            // 入库成功标志：让 draftBody 以 committed 状态载入（commit_apply 专用）。
            ...(output.committed === true ? { committed: true } : {}),
            // 撤销标志（undo_last_change / 今并入 manage_snapshots op=undo）：只在布尔时透传，前端据此冻结 autosave、改读磁盘真值。
            ...(typeof output.undone === "boolean" && (parsed.toolName === "undo_last_change" || parsed.toolName === "manage_snapshots")
              ? { undone: output.undone }
              : {}),
            // check_ai_flavor 专属：整份体检报告（violations/usedFallback 不在上面的轻量白名单里），
            // 仅在该工具且 output 形状符合 AiFlavorReport 时透传，前端据此落 store 渲染体检卡。
            ...(parsed.toolName === "check_ai_flavor" && isAiFlavorReport(output)
              ? { aiFlavorReport: output as unknown as AiFlavorReport }
              : {}),
            // ai_review 专属：整份审稿报告（review.issues 不在轻量白名单里），透传给投影层挂到消息→渲染「审校问题清单」可点卡。
            ...(parsed.toolName === "ai_review" && isDraftReview(output)
              ? { draftReview: (output as { review?: unknown }).review as DraftReviewView }
              : {}),
            // suggest_next_steps 专属：agent 提议的下一步选项（question/choices 不在轻量白名单里），透传给投影层挂到消息。
            // choice.action（R4.7）按白名单防御解析（toNextStepPrompt）：只放行下一步级的只读/写稿工具，
            // commit_apply、prune_snapshots 这类授权写盘动作必须走各自的确认按钮，不许藏在选项里被点击直达。
            ...(parsed.toolName === "suggest_next_steps" && isNextStepPrompt(output)
              ? { nextStepPrompt: toNextStepPrompt(output) }
              : {}),
            // commit_apply 专属：入库成功且带 report（整份 CommitReport，不在轻量白名单里）→ 透传，前端渲染「入库」delta 卡。
            ...(parsed.toolName === "commit_apply" && output.committed === true && isRecord(output.report)
              ? { commitReport: output.report }
              : {}),
            // check_continuity 专属：核账结果（确定 / 可能两档，两边原句）→ 透传，前端渲染「核账」卡。
            // ok:false（还在读 / 出错 / 没正文）一律不建卡——sure/maybe 空数组只说明「没有条目」，不代表「没问题」，
            // 否则会显成「没发现对不上」的假成功卡（R4.1/验收 3.1）。没核成就只留工具文字如实说。
            ...(parsed.toolName === "check_continuity" && output.ok !== false && typeof output.chapter === "number" && (Array.isArray(output.sure) || Array.isArray(output.maybe))
              ? { continuityCheck: { chapter: output.chapter, sure: toContinuityItems(output.sure), maybe: toContinuityItems(output.maybe), ...(toContinuityItems(output.earlierOpen).length > 0 ? { earlierOpen: toContinuityItems(output.earlierOpen) } : {}) } }
              : {}),
            // brainstorm_chapter 专属：几种走法 → 透传，前端渲染走法卡、稿纸上方给作者挑。没想出来（ok:false）不建卡。
            ...(parsed.toolName === "brainstorm_chapter" && output.ok !== false && readBrainstormData(output)
              ? { brainstorm: readBrainstormData(output)! }
              : {}),
            ...(parsed.toolName === "check_continuity" && typeof output.checkedVersion === "string" && output.checkedVersion
              ? { checkedVersion: output.checkedVersion }
              : {}),
            // check_continuity 专属：还在读的结构化进度（pending 只在「还在读、没核」时出现）→ 透传。
            // 前端要区分「还在读」和「出错」用这个字段，别解析 failures 的文字（R4.1）。
            ...(parsed.toolName === "check_continuity" && isPendingProgress(output.pending)
              ? { continuityPending: output.pending }
              : {}),
            // quality_check 专属：分层报告 refined（blocking/soft/reference 不在轻量白名单里）→ 透传，前端渲染「质检」明细卡。
            // ok:false 不透传（防御：质检失败今天走抛错→tool-error，但 ok:false+refined 一旦出现不能显成「质检通过」卡）。
            ...(parsed.toolName === "quality_check" && output.ok !== false && isRecord(output.refined)
              ? { qualityReport: output.refined as unknown as QualityCardReport }
              : {}),
            // commit_preview 专属：人物名一致性提醒（不在轻量白名单里）→ 透传，前端渲染固定提醒卡（不靠模型转述、不被说软）。
            ...(parsed.toolName === "commit_preview" && isNameConsistencyWarnings(output.nameConsistencyWarnings)
              ? { nameConsistencyWarnings: output.nameConsistencyWarnings }
              : {}),
            // commit_preview 专属：伏笔/线索待收口提醒（不在轻量白名单里）→ 透传，前端渲染固定提醒卡（不靠模型转述、不被隐去）。
            ...(parsed.toolName === "commit_preview" && isStaleThreadWarnings(output.staleThreadWarnings)
              ? { staleThreadWarnings: output.staleThreadWarnings }
              : {}),
            // commit_preview 专属：结构化定稿预览（R3）→ 透传，前端渲染固定「定稿预览」卡。裁决/阻断项不靠模型
            // 转述（模型可能把硬阻断说成「小问题」或干脆不提）。字段防御解析：缺 chapter/canCommit 的残缺输出不挂卡。
            ...(parsed.toolName === "commit_preview" && typeof output.chapter === "number" && typeof output.canCommit === "boolean"
              ? {
                  commitPreview: {
                    chapter: output.chapter,
                    canCommit: output.canCommit,
                    ...(Array.isArray(output.blockingReasons)
                      ? { blockingReasons: output.blockingReasons.filter((reason): reason is string => typeof reason === "string") }
                      : {}),
                    ...(typeof output.summary === "string" ? { summary: output.summary } : {}),
                    ...(Array.isArray(output.draftQualityIssues) ? { draftIssueCount: output.draftQualityIssues.length } : {}),
                    ...(Array.isArray(output.semanticQualityIssues) ? { semanticIssueCount: output.semanticQualityIssues.length } : {}),
                    // R7.7·报告 4.3：明细文案直接带进卡（默认折叠展示），不再让作者去找不存在的「质检卡」。
                    ...(toIssueMessages(output.draftQualityIssues).length > 0 ? { draftIssues: toIssueMessages(output.draftQualityIssues) } : {}),
                    ...(toIssueMessages(output.semanticQualityIssues).length > 0 ? { semanticIssues: toIssueMessages(output.semanticQualityIssues) } : {}),
                    ...(typeof output.previewToken === "string" && output.previewToken ? { previewToken: output.previewToken } : {}),
                    ...(toIssueMessages(output.notRecorded).length > 0 ? { notRecorded: toIssueMessages(output.notRecorded) } : {}),
                    ...(toIssueMessages(output.notes).length > 0 ? { notes: toIssueMessages(output.notes) } : {}),
                    ...(toLedgerChecklist(output.ledgerChecklist).length > 0 ? { ledgerChecklist: toLedgerChecklist(output.ledgerChecklist) } : {}),
                  },
                }
              : {}),
            // commit_apply 专属：模型发起的定稿请求只出确认按钮（needsConfirmation + confirmAction），透传给投影层挂按钮。
            ...(parsed.toolName === "commit_apply" && output.needsConfirmation === true && isCommitConfirmAction(output.confirmAction)
              ? {
                  commitConfirmAction: {
                    chapter: output.confirmAction.chapter,
                    ...(typeof output.confirmAction.previewToken === "string" ? { previewToken: output.confirmAction.previewToken } : {}),
                  },
                }
              : {}),
            ...((parsed.toolName === "prune_snapshots" || parsed.toolName === "manage_snapshots")
              && output.needsConfirmation === true
              && typeof output.confirmAction === "object" && output.confirmAction !== null
              ? {
                  pruneConfirmAction: {
                    ...(typeof (output.confirmAction as { keep?: unknown }).keep === "number"
                      ? { keep: (output.confirmAction as { keep: number }).keep }
                      : {}),
                  },
                }
              : {}),
            ...(parsed.toolName === "manage_ledger" && output.needsConfirmation === true && isLedgerConfirm(output.ledgerConfirm)
              ? {
                  ledgerConfirmAction: {
                    key: output.ledgerConfirm.key,
                    decisions: output.ledgerConfirm.decisions,
                    ...(typeof output.ledgerConfirm.label === "string" && output.ledgerConfirm.label ? { label: output.ledgerConfirm.label } : {}),
                  },
                }
              : {}),
            ...(parsed.toolName === "generate_draft" && output.needsConfirmation === true && isRewriteConfirm(output.rewriteConfirm)
              ? {
                  rewriteConfirmAction: {
                    chapter: output.rewriteConfirm.chapter,
                    ...(typeof output.rewriteConfirm.chapterGoal === "string" && output.rewriteConfirm.chapterGoal.trim()
                      ? { chapterGoal: output.rewriteConfirm.chapterGoal.trim() }
                      : {}),
                  },
                }
              : {}),
            ...(parsed.toolName === "foundation_write" && output.needsConfirmation === true && isFoundationConfirm(output.foundationConfirm)
              ? {
                  foundationConfirmAction: {
                    key: output.foundationConfirm.key,
                    input: output.foundationConfirm.input,
                    ...(typeof output.foundationConfirm.label === "string" && output.foundationConfirm.label ? { label: output.foundationConfirm.label } : {}),
                  },
                }
              : {}),
            overview: output.overview as StateOverview | undefined,
            refreshScope: output.refreshScope as "full" | "foundation" | undefined,
            snapshotId: typeof output.snapshotId === "string" ? output.snapshotId : undefined,
            chapter: typeof output.chapter === "number" ? output.chapter : undefined,
          });
          return;
        }
        case "tool-error":
          if (typeof parsed.toolName === "string") {
            handlers.onToolError({
              toolName: parsed.toolName,
              toolCallId: typeof parsed.toolCallId === "string" ? parsed.toolCallId : undefined,
              message: typeof parsed.error === "string" ? parsed.error : "写作助手执行出错。",
              retryable: parsed.retryable !== false,
            });
          }
          return;
        case "error":
          handlers.onError(
            typeof parsed.error === "string" ? parsed.error : "写作助手执行出错。",
            parsed.retryable !== false,
            readAiErrorReason(parsed.reason),
          );
          return;
        case "usage": {
          const total = parsed.total && typeof parsed.total === "object" ? parsed.total as Record<string, unknown> : undefined;
          const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
          if (total) handlers.onUsage?.({ input: num(total.input), cachedInput: num(total.cachedInput), output: num(total.output) });
          return;
        }
        case "done":
          emitDone();
          return;
        default:
          return;
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      armIdle(); // 收到数据就重置看门狗：只在「真的卡住没数据」时才超时。
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/u);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line === "") {
          flush();
        } else if (line.startsWith("event:")) {
          eventName = line.slice("event:".length).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice("data:".length).trim());
        }
      }
    }
    flush();
    // 流自然结束但后端没发 done（异常断流），也收尾，避免上层永久 loading。
    emitDone();
  } catch (error) {
    if (idleFired) {
      // 空闲超时：上游/网络半挂，给一条可重试的超时提示（而非裸 AbortError 文案）。
      handlers.onError("写作助手响应超时（约 90 秒无响应），可以点重试。", true, "timeout");
    } else if (mergedSignal.aborted) {
      // 用户主动「停止」：不报错、不留错误气泡，保留已流式出的内容，干净收尾。
      // （什么都不 onError，下面统一 emitDone。）
    } else {
      const message = error instanceof Error ? error.message : String(error);
      handlers.onError(message, true);
    }
    emitDone();
  } finally {
    clearIdle();
    mergedSignal.removeEventListener("abort", onMergedAbort);
    cleanup();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 定稿预览的账本清单（防御解析：缺 id / label 的条目丢掉）。 */
function toLedgerChecklist(value: unknown): readonly LedgerChecklistItemView[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.id !== "string" || !item.id || typeof item.label !== "string" || !item.label.trim()) return [];
    return [{
      id: item.id,
      kind: typeof item.kind === "string" ? item.kind : "",
      label: item.label,
      ...(typeof item.reason === "string" && item.reason.trim() ? { reason: item.reason } : {}),
      ...(typeof item.detail === "string" && item.detail.trim() ? { detail: item.detail } : {}),
      removable: item.removable === true,
      ...(typeof item.editableDay === "number" && Number.isInteger(item.editableDay) && item.editableDay > 0 ? { editableDay: item.editableDay } : {}),
      ...(item.needsConfirm === true ? { needsConfirm: true } : {}),
      ...(item.defaultUnchecked === true ? { defaultUnchecked: true } : {}),
    }];
  });
}

function isLedgerConfirm(value: unknown): value is { readonly key: string; readonly decisions: readonly unknown[]; readonly label?: unknown } {
  return isRecord(value) && typeof value.key === "string" && value.key.length > 0 && Array.isArray(value.decisions) && value.decisions.length > 0;
}

function isRewriteConfirm(value: unknown): value is { readonly chapter: number; readonly chapterGoal?: unknown } {
  return isRecord(value) && typeof value.chapter === "number" && Number.isInteger(value.chapter) && value.chapter > 0;
}

function isFoundationConfirm(value: unknown): value is { readonly key: string; readonly input: Record<string, unknown>; readonly label?: unknown } {
  return isRecord(value) && typeof value.key === "string" && value.key.length > 0 && isRecord(value.input);
}

function isCommitConfirmAction(value: unknown): value is { readonly chapter: number; readonly previewToken?: unknown } {
  return isRecord(value) && typeof value.chapter === "number" && Number.isInteger(value.chapter) && value.chapter > 0;
}

/** check_ai_flavor 输出形状校验：必须有 boolean ok + 数组 violations + boolean usedFallback。
 *  形状不符就不透传（防把别的工具输出误当体检报告）。 */
function isAiFlavorReport(value: Record<string, unknown>): boolean {
  return typeof value.ok === "boolean"
    && Array.isArray(value.violations)
    && typeof value.usedFallback === "boolean";
}

/**
 * ai_review 输出形状守卫：output.review 是对象且有 issues 数组（防把别的工具输出误当审稿报告）。
 * **审稿没跑成（ok:false / usedFallback=true）→ 返回 false**：引擎此时回 fallback 报告（含一条假 issue「AI 审稿结果不可用」），
 * 不能当「审校问题」卡渲染（否则显成『1 处问题』+ 可点改这处，点了让 agent 去改不存在的问题）；
 * 让 agent 的文本摘要「这次没审完、要不要重试」如实告知。与 check_ai_flavor 的 ok!==false 守卫对称。
 * ok:false 是 R4.1 同类排查补的防御位（今天 ok:false ⟺ usedFallback，字段双保险）。
 */
function isDraftReview(value: Record<string, unknown>): boolean {
  if (value.ok === false) return false;
  if (value.usedFallback === true) return false;
  const review = value.review;
  return typeof review === "object" && review !== null && Array.isArray((review as { issues?: unknown }).issues);
}

/** suggest_next_steps 输出形状守卫：有 question 字符串 + 非空 choices 数组。 */
function isNextStepPrompt(value: Record<string, unknown>): boolean {
  return typeof value.question === "string"
    && Array.isArray(value.choices)
    && value.choices.length > 0;
}

/**
 * 「下一步」选项里允许直达的结构化动作白名单（R4.7）：只有下一步级的动作能藏在选项里被点击直达——
 * 定稿预览（只读）、核账（只读）、出稿（写工作稿、可撤销）。commit_apply / prune_snapshots 这类
 * 授权写盘动作**不在**白名单：定稿要走定稿预览卡的「确认定稿」、裁剪要走「确认裁剪」，各带各的授权语义。
 */
export function parseNextStepUserAction(value: unknown): AgentUserAction | undefined {
  if (!isRecord(value)) return undefined;
  const chapter = typeof value.chapter === "number" && Number.isInteger(value.chapter) && value.chapter > 0
    ? value.chapter
    : undefined;
  if (chapter === undefined) return undefined;
  // 下面的逐个相等判断就是白名单本身：别的工具名（含 commit_apply / prune_snapshots）一律 undefined。
  if (value.toolName === "commit_preview") return { toolName: "commit_preview", chapter };
  if (value.toolName === "check_continuity") {
    return { toolName: "check_continuity", chapter, ...(value.fresh === true ? { fresh: true } : {}) };
  }
  if (value.toolName === "ai_review") return { toolName: "ai_review", chapter };
  if (value.toolName === "quality_check") return { toolName: "quality_check", chapter };
  if (value.toolName === "generate_draft") {
    const chapterGoal = typeof value.chapterGoal === "string" && value.chapterGoal.trim()
      ? value.chapterGoal.trim().slice(0, 2000)
      : undefined;
    return { toolName: "generate_draft", chapter, ...(chapterGoal ? { chapterGoal } : {}) };
  }
  return undefined;
}

/** suggest_next_steps 输出 → 「下一步」卡数据（choices 的 action 字段经白名单防御解析，坏的丢掉、选项保留）。 */
function toNextStepPrompt(output: Record<string, unknown>): NonNullable<AgentToolResult["nextStepPrompt"]> {
  const question = typeof output.question === "string" ? output.question : "";
  const choices = (Array.isArray(output.choices) ? output.choices : []).flatMap((item) => {
    if (!isRecord(item) || typeof item.label !== "string" || typeof item.intent !== "string") return [];
    const action = parseNextStepUserAction(item.action);
    return [{
      label: item.label,
      intent: item.intent,
      ...(typeof item.recommended === "boolean" ? { recommended: item.recommended } : {}),
      ...(action ? { action } : {}),
    }];
  });
  return { question, choices };
}

/** check_continuity 的 pending 形状守卫：done/total 是整数、total>0（残缺的进度不当「还在读」透传）。 */
function isPendingProgress(value: unknown): value is { readonly done: number; readonly total: number } {
  return isRecord(value)
    && typeof value.done === "number" && Number.isInteger(value.done) && value.done >= 0
    && typeof value.total === "number" && Number.isInteger(value.total) && value.total > 0;
}

/** commit_preview 人物名一致性提醒形状守卫：非空数组，每条有 establishedName/driftedVariant/message 字符串。 */
function isNameConsistencyWarnings(
  value: unknown,
): value is readonly { readonly establishedName: string; readonly driftedVariant: string; readonly message: string }[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((entry) => isRecord(entry)
      && typeof entry.establishedName === "string"
      && typeof entry.driftedVariant === "string"
      && typeof entry.message === "string");
}

/** commit_preview 伏笔/线索待收口提醒形状守卫：非空数组，每条有 kind/title/message 字符串 + 两个章号数字。 */
function isStaleThreadWarnings(
  value: unknown,
): value is readonly { readonly kind: string; readonly title: string; readonly lastTouchedChapter: number; readonly chaptersSinceTouched: number; readonly message: string }[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((entry) => isRecord(entry)
      && typeof entry.kind === "string"
      && typeof entry.title === "string"
      && typeof entry.lastTouchedChapter === "number"
      && typeof entry.chaptersSinceTouched === "number"
      && typeof entry.message === "string");
}

/** 从非 2xx 响应体里取服务端 `{ error }`；取不到返回 undefined（让调用方退回状态码文案）。 */
async function readServerError(response: Response): Promise<{ readonly message?: string; readonly reason?: AiErrorReason }> {
  try {
    const raw = await response.text();
    if (!raw.trim()) return {};
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed) && typeof parsed.error === "string" && parsed.error.trim()) {
      const reason = readAiErrorReason(parsed.reason);
      return { message: parsed.error.trim(), ...(reason ? { reason } : {}) };
    }
  } catch {
    // body 非 JSON / 读失败：退回状态码文案。
  }
  return {};
}
