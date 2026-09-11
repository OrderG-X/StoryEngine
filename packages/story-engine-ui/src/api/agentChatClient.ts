/**
 * agentChatClient — 读 POST /api/agent/chat 的 SSE 流，把后端事件分发给回调。
 *
 * 后端事件协议（见 server/routes/agent-chat.ts）：
 *   - text-delta   { text }                                 → onTextDelta(text)
 *   - tool-call    { toolCallId, toolName, args }           → onToolCall({ toolName })
 *   - tool-result  { toolCallId, toolName, output }         → onToolResult({ toolName, overview, refreshScope, snapshotId })
 *   - tool-error   { toolCallId, toolName, error, retryable } → onToolError({ toolCallId, toolName, message, retryable })
 *   - error        { error, retryable }                     → onError(message, retryable)
 *   - done         { finishReason? }                        → onDone()
 *
 * SSE 行读法参考现有 fetchChapterChatStream：跨 chunk 缓冲，空行 flush 一个事件。
 * 铁律：绝不静默失败——HTTP 非 2xx / 无 body / SSE error 事件，统统走 onError（默认可重试）。
 */
import { mergeSignals } from "./fetchJson.js";
import type { StateOverview, DraftReviewView, QualityCardReport } from "./types.js";
import type { AiFlavorReport } from "../types.js";

export interface StreamAgentChatRequest {
  readonly projectPath: string;
  readonly messages: readonly { readonly role: "user" | "assistant"; readonly content: string }[];
  /** 用户当前打开/停留的章号。后端据此引导 agent 默认作用于该章、工具缺省回退该值（H3：回看旧章不写错章）。 */
  readonly currentChapter?: number;
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
  /** 诚实背书粒度（服务端 agent-chat tool-result 已随步骤带上、honesty-detection stepBacksWriteClaim 认的字段名）：
   *  prune_snapshots 的 dryRun（预览不背书「已裁剪」）/ manage_style_exemplars 的 action（list 不背书「已添加」）。
   *  不透传会让 exemplars add 成功在前端被诚实探针误判成「操作未完成」（复审 P2③）。 */
  readonly dryRun?: boolean;
  readonly action?: string;
  readonly summary?: string;
  /** 改草稿类工具（generate_draft/revise_draft）返回的「当前章完整草稿正文（去 Markdown 标题）」。
   *  前端据此把真正文载入工作区——否则只能用不含正文的 overview 刷新，草稿被占位覆盖、autosave 抹掉真正文。 */
  readonly draftBody?: string;
  readonly draftTitle?: string;
  /** commit_apply 入库成功标志：前端据此把 draftBody 以 committed 状态（而非 draft_ready）载入工作区，防 autosave 复活已入库章节。 */
  readonly committed?: boolean;
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
  /** suggest_next_steps 专属：agent 提议的下一步选项，透传给投影层挂到消息→驱动「下一步」卡。 */
  readonly nextStepPrompt?: {
    readonly question: string;
    readonly choices: readonly { readonly label: string; readonly intent: string; readonly recommended?: boolean }[];
  };
  /** commit_preview 专属：人物名近形漂移提醒（引擎确定性判定）。透传给投影层挂到消息→渲染固定「人物名一致性」提醒卡，不靠模型转述。 */
  readonly nameConsistencyWarnings?: readonly { readonly establishedName: string; readonly driftedVariant: string; readonly message: string }[];
  /** commit_preview 专属：伏笔/线索待收口提醒（引擎确定性判定：超 3 章未推进）。透传给投影层挂到消息→渲染固定「伏笔/线索待收口」提醒卡，不靠模型转述。 */
  readonly staleThreadWarnings?: readonly { readonly kind: string; readonly title: string; readonly lastTouchedChapter: number; readonly chaptersSinceTouched: number; readonly message: string }[];
}

export interface AgentToolError {
  readonly toolCallId?: string;
  readonly toolName: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface AgentChatHandlers {
  readonly onTextDelta: (text: string) => void;
  /** 思考链增量（仅思考模式下有）。累加成消息的「思考过程」。 */
  readonly onReasoningDelta?: (text: string) => void;
  /** 出稿正文增量（generate_draft 流式）：逐字进编辑器。带本次章号，前端只往当前章追。 */
  readonly onDraftDelta?: (info: { readonly chapter: number; readonly text: string }) => void;
  readonly onToolCall: (info: { readonly toolCallId?: string; readonly toolName: string }) => void;
  readonly onToolResult: (info: AgentToolResult) => void;
  /** 工具内部抛错：携带 toolCallId/toolName，让上层把对应步骤/卡片收尾为 failed，再 append 错误。 */
  readonly onToolError: (info: AgentToolError) => void;
  readonly onError: (message: string, retryable: boolean) => void;
  readonly onDone: () => void;
}

/** 空闲看门狗超时：上游/网络半挂时多久没有任何 SSE 数据就判超时、中止流（M3：治「永久转圈」）。 */
export const AGENT_IDLE_TIMEOUT_MS = 90_000;

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
      }),
      signal: idleController.signal,
    });
    if (!response.ok || !response.body) {
      // 非 2xx：尽量读出服务端给的真实原因（如「项目目录不存在」「API Key 未设置」），别只甩一个
      // 「请求失败：500」让用户摸不着头脑。读不到 body 才退回状态码。
      const serverMessage = await readServerErrorMessage(response);
      handlers.onError(serverMessage ?? `写作助手请求失败：${response.status}`, true);
      emitDone();
      return;
    }

    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = "";
    let eventName = "message";
    let dataLines: string[] = [];

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
        case "reasoning-delta":
          if (typeof parsed.text === "string") handlers.onReasoningDelta?.(parsed.text);
          return;
        case "draft-delta":
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
            // 诚实背书粒度（honesty-detection stepBacksWriteClaim 认的字段名）：prune 的 dryRun /
            // exemplars 的 action 必须透传给投影层累加进 step——否则 add 真成功也被前端诚实探针误判「操作未完成」。
            ...(typeof output.dryRun === "boolean" ? { dryRun: output.dryRun } : {}),
            ...(typeof output.action === "string" ? { action: output.action } : {}),
            ...(typeof output.summary === "string" ? { summary: output.summary } : {}),
            // 改草稿工具的真正文必须透传，前端据此把真正文载入工作区（防占位覆盖+autosave 抹稿）。
            ...(typeof output.draftBody === "string" ? { draftBody: output.draftBody } : {}),
            ...(typeof output.draftTitle === "string" ? { draftTitle: output.draftTitle } : {}),
            // 入库成功标志：让 draftBody 以 committed 状态载入（commit_apply 专用）。
            ...(output.committed === true ? { committed: true } : {}),
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
            ...(parsed.toolName === "suggest_next_steps" && isNextStepPrompt(output)
              ? { nextStepPrompt: output as unknown as AgentToolResult["nextStepPrompt"] }
              : {}),
            // commit_apply 专属：入库成功且带 report（整份 CommitReport，不在轻量白名单里）→ 透传，前端渲染「入库」delta 卡。
            ...(parsed.toolName === "commit_apply" && output.committed === true && isRecord(output.report)
              ? { commitReport: output.report }
              : {}),
            // quality_check 专属：分层报告 refined（blocking/soft/reference 不在轻量白名单里）→ 透传，前端渲染「质检」明细卡。
            ...(parsed.toolName === "quality_check" && isRecord(output.refined)
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
          );
          return;
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
      handlers.onError("写作助手响应超时（约 90 秒无响应），可以点重试。", true);
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

/** check_ai_flavor 输出形状校验：必须有 boolean ok + 数组 violations + boolean usedFallback。
 *  形状不符就不透传（防把别的工具输出误当体检报告）。 */
function isAiFlavorReport(value: Record<string, unknown>): boolean {
  return typeof value.ok === "boolean"
    && Array.isArray(value.violations)
    && typeof value.usedFallback === "boolean";
}

/**
 * ai_review 输出形状守卫：output.review 是对象且有 issues 数组（防把别的工具输出误当审稿报告）。
 * **审稿没跑成（usedFallback=true）→ 返回 false**：引擎此时回 fallback 报告（含一条假 issue「AI 审稿结果不可用」），
 * 不能当「审校问题」卡渲染（否则显成『1 处问题』+ 可点改这处，点了让 agent 去改不存在的问题）；
 * 让 agent 的文本摘要「这次没审完、要不要重试」如实告知。与 check_ai_flavor 的 ok!==false 守卫对称。
 */
export function isDraftReview(value: Record<string, unknown>): boolean {
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
async function readServerErrorMessage(response: Response): Promise<string | undefined> {
  try {
    const raw = await response.text();
    if (!raw.trim()) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed) && typeof parsed.error === "string" && parsed.error.trim()) {
      return parsed.error.trim();
    }
  } catch {
    // body 非 JSON / 读失败：退回状态码文案。
  }
  return undefined;
}
