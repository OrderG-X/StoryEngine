/**
 * POST /api/agent/chat — Mastra 写作总控 agent 的 SSE 入口。
 *
 * body: { projectPath: string, messages: [{ role, content }], currentChapter?: number, action?: UserAction }
 * action（结构化动作，2026-10-07）：界面按钮的明确指令（如「确认定稿」），服务端直接执行对应工具、不经模型，
 * 事件协议同下（见 agent/user-actions.ts）。
 * 把 agent.stream() 的流式 chunk 转成 SSE 事件推给前端：
 *   - text-delta   { text }                              助手文本增量
 *   - tool-call    { toolCallId, toolName, args }        agent 决定调某工具
 *   - tool-result  { toolCallId, toolName, output }      工具返回（含 overview/refreshScope/snapshotId）
 *   - tool-error   { toolCallId, toolName, error, retryable }  工具内部抛错（前端据此收尾对应步骤为 failed）
 *   - error        { error, retryable }                  模型/链路错误（前端可重试）
 *   - done         { finishReason }                      本轮结束
 *
 * 铁律：projectDir 经 RequestContext 注入工具；绝不静默失败（任何错误→error 事件）；
 * 错误语义：运行时错误带 retryable:true。
 * 客户端断开（前端「停止」/90s 空闲看门狗掐 fetch）→ abort 本轮 agent.stream：停流式输出、
 * 尽力取消 in-flight 生成、不再开新工具步骤（已执行中的写盘工具不回滚，写盘本身有事务保护）。
 */
import type { ModelMessage } from "ai";

import { buildProjectRequestContext, parseLastTurnUndoHint } from "../agent/request-context.js";
import { getStoryAgent } from "../agent/story-agent.js";
import { commitApplyTool } from "../agent/tools/commit-apply.js";
import { commitPreviewTool } from "../agent/tools/commit-preview.js";
import { generateDraftTool } from "../agent/tools/generate-draft.js";
import { pruneSnapshotsTool } from "../agent/tools/prune-snapshots.js";
import { parseUserAction, runUserAction, type UserActionToolExecutor } from "../agent/user-actions.js";
import { createStreamingScrubber } from "../lib/entity-id-scrubber.js";
import { describeTokenUsage, recordAgentUsage, sampleFromSdkUsage, withTokenMeter } from "../lib/token-meter.js";
import { appendTurnMetrics } from "../lib/turn-metrics.js";
import { checkContinuityTool } from "../agent/tools/check-continuity.js";
import {
  assertStoryEngineProject,
  guardProjectPath,
  readChatMessages,
  readJsonBody,
  readString,
  readUiChapterFileStates,
  writeJson,
  type MiddlewareStack,
  type UiChapterFileState,
} from "../lib/project-io.js";
import { scrubLocalAbsolutePaths } from "../lib/local-path-scrubber.js";
import { shouldSendHistoryTrimNoticeOnce } from "../lib/history-trim-notice.js";
import { startSseHeartbeat } from "../lib/sse-heartbeat.js";

/** body.currentChapter 容错解析：只接受正整数，其余（缺省/非法/0/负/小数）一律 undefined。 */
export function readCurrentChapter(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isInteger(raw) && raw > 0 ? raw : undefined;
}

/** 取本轮最后一条用户原话，供 requestContext 注入工具层做写盘意图门。 */
export function readLatestUserTurnText(messages: readonly { readonly role: string; readonly content: string }[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    return message.content.trim() ? message.content : undefined;
  }
  return undefined;
}

/**
 * 把「用户当前所在章」做成一条 system 上下文消息，喂给 agent，使它在涉及章号时默认作用于该章、
 * 不擅自跳到最新章（H3）。currentChapter 缺省时返回 null（不注入）。
 */
/**
 * 把当前章的文件状态压成一句中性描述，让 agent 知道本章「是空的 / 已有草稿 / 已入库」，
 * 而不是只拿到一个光杆章号在本章无从下手（⑤根因之一）。题材中立，不含任何题材词。
 */
export function formatChapterStatusLine(chapter: number, status: UiChapterFileState | undefined): string {
  if (status?.hasCommittedChapter) {
    const title = status.committedTitle ?? status.draftTitle;
    return `本章（第 ${chapter} 章）已定稿${title ? `（标题：${title}）` : ""}。`;
  }
  // 「有草稿」只认真草稿：.md 有真内容，或 workspace 里有真草稿。光「开过」(hasWorkspaceSnapshot) 不算，
  // 否则用户只是打开/打了招呼、本章其实是空的，却被谎报「已有工作稿」，agent 跟着说「第N章已有内容」（真机实测 bug）。
  if (status?.hasDraftFile || status?.hasWorkspaceDraft) {
    const title = status.draftTitle ?? status.workspaceTitle;
    return `本章（第 ${chapter} 章）已有工作稿待处理${title ? `（标题：${title}）` : ""}，尚未定稿。`;
  }
  return `本章（第 ${chapter} 章）还没有工作稿，是空的。`;
}

/**
 * 把「用户当前所在章」做成一条 system 上下文消息，喂给 agent，使它在涉及章号时默认作用于该章、
 * 不擅自跳到最新章（H3）。currentChapter 缺省时返回 null（不注入）。
 * 传入 chapterStatus 时一并带上本章状态（空/有草稿/已入库），让 agent 在本章有抓手、不退回旧章。
 */
export function buildCurrentChapterSystemMessage(
  currentChapter: number | undefined,
  chapterStatus?: UiChapterFileState | undefined,
  allStates?: readonly UiChapterFileState[],
): import("ai").ModelMessage | null {
  // 全书磁盘真相硬约束（A3）：即使没有 currentChapter，只要拿到了全书状态也要注入这条反证，
  // 让模型无法凭对话历史/印象谎报「某章已入库/已写好」。
  const truthLine = allStates && allStates.length > 0 ? buildWholeBookTruthLine(allStates) : "";
  if (currentChapter === undefined) {
    if (!truthLine) return null;
    return { role: "system", content: truthLine };
  }
  const statusLine = chapterStatus !== undefined ? formatChapterStatusLine(currentChapter, chapterStatus) : "";
  // 当前章已入库时，「继续/写下一章」的目标是下一章（在本章之上往前推进），不是重写本章——
  // 治 codex 真机 P0「入库第 N 章后说写第 N+1 章却落回第 N 章」的章号 off-by-one。
  const committedForwardLine = chapterStatus?.hasCommittedChapter
    ? `第 ${currentChapter} 章已定稿；用户说「继续/接着写/写下一章」时，目标是第 ${currentChapter + 1} 章（往前推进），不是重写第 ${currentChapter} 章。`
    : `用户说「继续/接着写」时指在本章继续（结合上面的本章状态判断是从头出稿还是接着已有草稿）。`;
  return {
    role: "system",
    content:
      (truthLine ? `${truthLine}\n` : "") +
      `【当前上下文】用户此刻正停留在第 ${currentChapter} 章。` +
      (statusLine ? statusLine : "") +
      `凡涉及具体章号的操作（读取该章、出稿/续写、修订、质检、内容审阅、定稿预览/定稿）：` +
      `如果用户明确点名了某一章（例如「写第 7 章」「改第 3 章」「入库第 5 章」），一律以用户点名的章号为准，` +
      `即使它不是第 ${currentChapter} 章——把该章号原样填进工具的 chapter 入参，绝不用第 ${currentChapter} 章顶替。` +
      `只有当用户没有明确点名另一章时，才默认作用于第 ${currentChapter} 章，绝不要擅自跳到最新章或别的章。` +
      committedForwardLine,
  };
}

/**
 * 全书磁盘真相（A3·治谎报 A1/A2 的结构兜底）：从已扫全书的章节文件状态派生一条「客观事实」硬约束，
 * 让模型声称的任何「某章已生成/已入库」都必须与磁盘对齐，拿不准先核对、不得凭对话历史脑补。
 * 纯只读盘派生、题材中立。
 */
export function buildWholeBookTruthLine(allStates: readonly UiChapterFileState[]): string {
  const committed = allStates.filter((s) => s.hasCommittedChapter).map((s) => s.chapter).sort((a, b) => a - b);
  const draftOnly = allStates
    .filter((s) => !s.hasCommittedChapter && (s.hasDraftFile === true || s.hasWorkspaceDraft === true))
    .map((s) => s.chapter)
    .sort((a, b) => a - b);
  const committedDesc = committed.length === 0
    ? "本书目前还没有任何章节已定稿"
    : committed.length <= 20
      ? `本书已定稿的章节是：第 ${committed.join("、")} 章`
      : `本书已定稿 ${committed.length} 章，最高到第 ${committed[committed.length - 1]} 章`;
  const draftDesc = draftOnly.length === 0
    ? ""
    : `；有未定稿工作稿的章节：第 ${draftOnly.slice(0, 20).join("、")} 章`;
  return (
    `【磁盘真相·硬约束】${committedDesc}${draftDesc}。这是磁盘上的客观事实。` +
    `凡你声称某章「已生成工作稿 / 已质检 / 已审阅 / 已定稿」，都必须与此一致：这里没列为已定稿的章就是还没定稿、` +
    `绝不能说成已定稿；没列出工作稿的章就是还没写、绝不能说成已写好。拿不准先调 read_chapters_overview / ` +
    `read_draft 核对真实状态，绝不凭对话历史或印象脑补出不存在的进度（结构性防谎报）。`
  );
}

/**
 * 拼装喂给 agent 的消息序列。关键：当前章 system 提示放在【最后一条消息（通常是用户最新指令）之前】、
 * 紧贴它，而不是塞在 modelMessages[0]。单聊天走天涯后历史横跨多章，放开头会被一长串旧章讨论淹没
 * （lost-in-the-middle，⑤头号根因）——agent 读「继续」时近处全是旧章上下文，就被带跑回旧章。
 * 贴到用户指令前，让「你在第 N 章」成为最近、最强的信号。
 */
export function buildModelMessages(
  systemMessage: import("ai").ModelMessage | null,
  history: readonly import("ai").ModelMessage[],
): import("ai").ModelMessage[] {
  if (!systemMessage) return [...history];
  if (history.length === 0) return [systemMessage];
  return [...history.slice(0, -1), systemMessage, history[history.length - 1]!];
}

/**
 * SSE 心跳间隔。必须远低于客户端空闲看门狗（agentChatClient.AGENT_IDLE_TIMEOUT_MS = 90s），
 * 留足多次丢包余量；15s → 90s 内可喂活看门狗 5~6 次。
 */
export const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * 客户端断开侦测 → AbortController（前端「停止」/空闲看门狗都只是掐 fetch，服务端 agent.stream
 * 与工具步骤不会自己停）。res 'close' + writableEnded===false = 响应未完成时连接被掐 → abort。
 * 不能挂 req 'close'：请求体一读完 IncomingMessage 就 close（Node ≥18 实测 req.complete=true 即触发），
 * 挂它会误杀每个正常请求；正常 res.end() 收尾时 writableEnded=true，不误杀。
 */
export function abortOnClientDisconnect(res: import("node:http").ServerResponse): AbortController {
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });
  return controller;
}

/**
 * 路由级「绝不静默」兜底（铁律④延伸·E2E 实锤）：模型常在调完工具后沉默收场、偶尔整轮空转——
 * 用户只看到卡/章节冒出来、AI 一句话不说，体感像卡住/坏了。本轮 fullStream 结束时若一个 text-delta
 * 都没发过，就据本轮活动补一条收尾文本：工具有摘要→照实转述；工具无摘要→中性指向上方结果；
 * 完全没调工具（空转）→ 诚实请用户重说。返回 null 表示模型已自己回话、无需兜底。
 * 与 instructions 里「干完必回话」双保险：模型通常自己给更自然的总结，这条只兜最坏情况。
 */
export function closingFallbackText(state: {
  readonly emittedText: boolean;
  readonly sawToolActivity: boolean;
  readonly lastToolSummary?: string;
}): string | null {
  if (state.emittedText) return null;
  if (state.sawToolActivity) {
    const summary = state.lastToolSummary?.trim();
    return summary ? summary : "（已按你的要求完成上述操作，结果见上方。需要我接着做什么吗？）";
  }
  return "抱歉，我这次没能生成回应。可以再说一次，或者换个说法吗？";
}

/** Mastra 工具入参/出参校验失败时框架返回的错误形状（@mastra/core tools/validation.ts 的 validateToolInput/Output：
 *  { error:true, message, validationErrors }）。execute 不会跑，模型下一步能看到 message 自行修正重试。 */
export interface MastraToolValidationFailure {
  readonly error: true;
  readonly message: string;
  readonly validationErrors?: { readonly errors?: readonly string[]; readonly fields?: Record<string, { readonly errors?: readonly string[] }> };
}

/** 判别 Mastra 校验失败结果。只认结构化标记（error===true + message 字符串 + validationErrors），不猜文案。 */
export function isMastraToolValidationError(result: unknown): result is MastraToolValidationFailure {
  if (typeof result !== "object" || result === null) return false;
  const r = result as { error?: unknown; message?: unknown; validationErrors?: unknown };
  return r.error === true && typeof r.message === "string" && r.validationErrors !== undefined;
}

/** 校验失败 → 给作者看的一句话。只列 schema 字段名（结构性信息、无裸 id）；不转述 message 原文——
 *  里面带着模型传来的原始参数全文，原样进步骤卡既啰嗦也可能带正文片段。 */
export function toolValidationFailureSummary(failure: MastraToolValidationFailure): string {
  const fields = Object.keys(failure.validationErrors?.fields ?? {});
  const fieldText = fields.length > 0 ? `（${fields.join("、")}）` : "";
  return `AI 传的参数没通过校验${fieldText}，这一步没有执行，具体原因已回给 AI 处理。`;
}

/** 工具结果转发前的归一：Mastra 校验失败结果没有 ok/summary，前端会当成「已完成 + 空」——
 *  步骤卡 1 秒内结束、点开没有任何原因（十章真机第 5/7 章出稿都出现过，见 R7.9）。归一成
 *  ok:false + 中文 summary + toolValidationFailure 标记，步骤卡如实显示失败与原因。
 *  只发干净的三字段：Mastra 的 message 原文里嵌着模型传来的完整参数（可能带正文片段），不落到客户端
 *  （模型那边仍由框架喂原始 message，自行修正重试，不受影响）。其余结果逐字节原样转发。 */
export function normalizeForwardedToolResult(result: unknown): unknown {
  if (!isMastraToolValidationError(result)) return result;
  return { ok: false, summary: toolValidationFailureSummary(result), toolValidationFailure: true };
}

/**
 * 一轮对话最多走几步（Mastra 默认 5）。2026-10-10 真机试写：作者一次列 7 处修改，改到第 4 处步数用完就停了，
 * 回复读起来像全改完了。改稿 / 补资料这类多处操作一步一处，5 步不够。
 */
export const AGENT_TURN_MAX_STEPS = 12;

/** 步数用完、模型还停在工具调用上：如实告诉作者没做完。 */
export const STEP_LIMIT_NOTICE = "\n\n（这一轮能走的步数用完了，事情可能还没做完。说「继续」我接着做。）";

/**
 * 聊天历史窗口上限：只带最近 12 条（约 6 个回合）给 AI。故事状态的真值在磁盘和工具里
 * （read_state_overview、磁盘真相 system 行），聊天历史只承担近程对话连续性；带太多既费上下文，
 * 也会让模型照着历史里的回执往下续写（r8 真机：堆到约 20 条起开始不调工具、续写回执）。
 */
export const MAX_CHAT_HISTORY_MESSAGES = 12;

export function capChatHistoryWindow<T>(
  messages: readonly T[],
  limit: number = MAX_CHAT_HISTORY_MESSAGES,
): readonly T[] {
  return messages.length <= limit ? messages : messages.slice(-limit);
}

/** agent.stream fullStream chunk 的结构化最小面（只声明本路由真正读的字段，真实类型由 Mastra 提供）。 */
export interface AgentTurnChunk {
  readonly type: string;
  readonly payload?: {
    readonly text?: string;
    readonly delta?: string;
    readonly toolCallId?: string;
    readonly toolName?: string;
    readonly args?: unknown;
    readonly result?: unknown;
    readonly error?: unknown;
    readonly stepResult?: { readonly reason?: string };
    /** finish 帧：这一轮（可能多步）的总用量与步骤。 */
    readonly output?: { readonly usage?: unknown; readonly steps?: readonly unknown[] };
  };
}

/**
 * 一个对话回合：消费 agent.stream 的 fullStream，转发成 SSE。
 *
 * 重构 P4：不读作者原话、不改写 AI 的回复，也不自动重做。以前的「诚实检测 + 服从重试」用正则猜
 * AI 有没有谎报、作者想让它做什么，猜错时会把正确回复整段换成「定稿没有执行」（P3 走查当场复现）。
 * 现在真相看工具卡：卡片由工具的结构化结果渲染，AI 嘴上说什么都改不了卡片；作者档的写（定稿、改账……）
 * 只能由按钮触发，AI 说「已定稿」也定不了稿。
 *
 * 收尾只做两件结构性的事：
 * - 这一轮一个字都没说：有工具结果就转述最后一张卡的摘要，什么都没做就请作者重说（绝不静默）；
 * - 最后一步还停在工具调用上 = 步数用完被截停，如实说没做完。
 */
export async function runAgentTurn(args: {
  readonly fullStream: AsyncIterable<AgentTurnChunk>;
  readonly sendEvent: (event: string, data: unknown) => void;
  readonly scrubber: { push(text: string): string; flush(): string };
  /** 客户端已断开（abortOnClientDisconnect）：立即停转发。 */
  readonly shouldStop?: () => boolean;
}): Promise<{ readonly finishReason: string | undefined }> {
  let finishReason: string | undefined;
  let sawToolActivity = false;
  let lastToolSummary: string | undefined;
  // 模型/网络中途出错（error 帧）：前端会出「AI 服务暂时没响应 · 重试」卡，就别再叠「抱歉没能回应」。
  let sawStreamError = false;
  let emittedText = false;
  // 空工具调用 id 兜底：上游三层（ai-sdk / openai-compatible / Mastra）正常都保证带 id，但适配器
  // 抽风给空串时，所有空 id 会塌成同一个——前一张工具卡被后一张覆盖、结果配错对、时间线卡死。
  // 给空 id 分配确定性合成 id；同工具名的 call/result 按 FIFO 配对，保证仍能对上。
  const syntheticQueues = new Map<string, string[]>();
  let syntheticCounter = 0;
  const syntheticToolName = (raw: unknown): string =>
    typeof raw === "string" && raw.trim() ? raw.trim() : "tool";
  const allocateSyntheticToolCallId = (raw: unknown, toolName: unknown): string => {
    const id = typeof raw === "string" ? raw.trim() : "";
    if (id) return id;
    const name = syntheticToolName(toolName);
    const next = `synthetic-${name}-${(syntheticCounter += 1)}`;
    const queue = syntheticQueues.get(name) ?? [];
    queue.push(next);
    syntheticQueues.set(name, queue);
    return next;
  };
  const reuseSyntheticToolCallId = (raw: unknown, toolName: unknown): string => {
    const id = typeof raw === "string" ? raw.trim() : "";
    if (id) return id;
    const name = syntheticToolName(toolName);
    return syntheticQueues.get(name)?.shift() ?? `synthetic-${name}-${(syntheticCounter += 1)}`;
  };

  for await (const chunk of args.fullStream) {
    // 客户端已断开：流还在吐也不再转发（write 到已关闭的 res 只是空转），尽快退出消费。
    if (args.shouldStop?.()) break;
    switch (chunk.type) {
      case "text-delta": {
        const text = chunk.payload?.text;
        if (text) {
          emittedText = true;
          const scrubbed = args.scrubber.push(text);
          if (scrubbed) args.sendEvent("text-delta", { text: scrubbed });
        }
        break;
      }
      case "reasoning-delta": {
        // 思考链增量（模型 reasoning_content → AI SDK reasoning-delta）。字段在 payload.text，
        // 兼容 .delta 以防版本差异。前端累加成消息的「思考过程」。
        const text = chunk.payload?.text ?? chunk.payload?.delta ?? "";
        if (text) args.sendEvent("reasoning-delta", { text });
        break;
      }
      case "tool-call": {
        sawToolActivity = true;
        const toolCallId = allocateSyntheticToolCallId(chunk.payload?.toolCallId, chunk.payload?.toolName);
        args.sendEvent("tool-call", {
          toolCallId,
          toolName: chunk.payload?.toolName,
          args: chunk.payload?.args ?? {},
        });
        break;
      }
      case "tool-result": {
        sawToolActivity = true;
        const toolCallId = reuseSyntheticToolCallId(chunk.payload?.toolCallId, chunk.payload?.toolName);
        const output = normalizeForwardedToolResult(chunk.payload?.result);
        const summary = (output as { readonly summary?: unknown } | undefined)?.summary;
        if (typeof summary === "string" && summary.trim()) lastToolSummary = summary.trim();
        args.sendEvent("tool-result", { toolCallId, toolName: chunk.payload?.toolName, output });
        break;
      }
      case "tool-error": {
        // 工具内部抛错（如缺 projectDir / 落盘失败）。绝不静默失败，且必须收尾正在 running 的
        // 步骤/卡片：发独立 tool-error 事件（带 toolCallId+toolName），前端据此把对应步骤置 failed
        // 再 append 错误消息——而非复用 error 事件（那样无法定位是哪张卡，时间线会卡在 running）。
        const toolCallId = reuseSyntheticToolCallId(chunk.payload?.toolCallId, chunk.payload?.toolName);
        args.sendEvent("tool-error", {
          toolCallId,
          toolName: chunk.payload?.toolName,
          error: stringifyError(chunk.payload?.error),
          retryable: true,
        });
        break;
      }
      case "error": {
        sawStreamError = true;
        args.sendEvent("error", { error: stringifyError(chunk.payload?.error), retryable: true });
        break;
      }
      case "finish": {
        finishReason = chunk.payload?.stepResult?.reason;
        recordAgentUsage(sampleFromSdkUsage(chunk.payload?.output?.usage), chunk.payload?.output?.steps?.length || 1);
        break;
      }
      default:
        break;
    }
  }

  const fallback = sawStreamError && !sawToolActivity
    ? null
    : closingFallbackText({ emittedText, sawToolActivity, lastToolSummary });
  if (fallback) {
    const scrubbed = args.scrubber.push(fallback);
    if (scrubbed) args.sendEvent("text-delta", { text: scrubbed });
  }
  if (finishReason === "tool-calls" && !sawStreamError) {
    const scrubbed = args.scrubber.push(STEP_LIMIT_NOTICE);
    if (scrubbed) args.sendEvent("text-delta", { text: scrubbed });
  }
  const remainingText = args.scrubber.flush();
  if (remainingText) args.sendEvent("text-delta", { text: remainingText });
  return { finishReason };
}

export function registerAgentChatRoutes(middlewares: MiddlewareStack): void {
  middlewares.use(async (req, res, next) => {
    if (!req.url?.startsWith("/api/agent/chat")) {
      next();
      return;
    }
    if (req.method !== "POST") {
      writeJson(res, 405, { ok: false, error: "Only POST is supported." });
      return;
    }
    await handleAgentChat(req, res);
  });
}

async function handleAgentChat(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
): Promise<void> {
  // headersSent 之后只能走 SSE error 事件；之前可走标准 JSON 错误。
  // 审计 Low：与 draft/chapter-chat 两条已加固路由同口径的三重护栏——writeHead 前不发帧
  // （防隐式刷错默认头）、连接已断/已收尾不再写（防 ERR_STREAM_WRITE_AFTER_END）。
  const sendEvent = (event: string, data: unknown) => {
    if (res.writableEnded || res.destroyed || !res.headersSent) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // 切到 SSE 后启动；finally 统一停表（成功/出错/客户端断开都不向已关闭响应写心跳）。
  let stopHeartbeat: (() => void) | undefined;
  // 客户端断开（停止/空闲超时掐 fetch）→ abort 本轮 agent.stream。挂得比 SSE 切换更早：
  // body 读取/项目校验期间断开同样置位，进流后第一拍即停。
  const disconnectAbort = abortOnClientDisconnect(res);

  try {
    const body = await readJsonBody(req);
    const projectDir = readString(body.projectPath);
    if (!projectDir) {
      writeJson(res, 400, { ok: false, error: "Project path is required." });
      return;
    }
    if (!guardProjectPath(res, projectDir)) return;
    const parsedAction = parseUserAction(body.action);
    if (parsedAction.kind === "invalid") {
      writeJson(res, 400, { ok: false, error: parsedAction.reason });
      return;
    }

    // 截历史窗口：只带最近一段给 AI——故事状态的真值在磁盘和工具里，不在聊天历史。
    const incomingMessages = readChatMessages(body.messages);
    const messages = capChatHistoryWindow(incomingMessages);
    // R4 绝不静默：历史被裁掉时必须告诉用户——不然用户以为前面说过的话 agent 还记得，
    // 得到的回复却像失忆。故事状态真值在磁盘/工具，但聊天上下文确实被截了。
    const droppedHistoryCount = incomingMessages.length - messages.length;
    if (messages.length === 0) {
      writeJson(res, 400, { ok: false, error: "对话内容不能为空。" });
      return;
    }

    await assertStoryEngineProject(projectDir);

    // H3：把用户当前所在章注入 RequestContext（工具缺省回退用）+ system 上下文（引导 agent 默认作用于该章）。
    const currentChapter = readCurrentChapter(body.currentChapter);
    // R7.2：带上「上一个有写盘回合的首个快照」（前端 turnSnapshots[0]）——undo 工具优先整回合回退。
    const lastTurnUndoHint = parseLastTurnUndoHint(body.lastTurnUndoHint);

    const agent = await getStoryAgent();
    // 出稿流式：注入 sink，让 generate_draft 工具把正文 delta 实时转成 draft-delta SSE 事件（前端逐字进编辑器）。
    // sink 在工具 await 模型期间同步触发 sendEvent（此时 agent.stream 正 parked，draft-delta 自然单独流出）。
    const requestContext = buildProjectRequestContext(
      projectDir,
      currentChapter,
      (payload) => sendEvent("draft-delta", payload),
      readLatestUserTurnText(messages),
      lastTurnUndoHint,
    );

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    // 工具长调用期间 SSE 会长时间静默，靠心跳喂活客户端 90s 空闲看门狗，避免误判超时掐流。
    stopHeartbeat = startSseHeartbeat(res).stop;

    // 结构化动作（用户点了「确认定稿」按钮）：服务端直接执行工具，不经模型、不过意图词表。
    if (parsedAction.kind === "action") {
      const actionStarted = Date.now();
      const { usage: actionUsage } = await withTokenMeter(() => runUserAction({
        action: parsedAction.action,
        requestContext,
        executeTool: executeUserActionTool,
        sendEvent,
        scrubber: createStreamingScrubber(),
        scrubError: stringifyError,
        // 编辑部 R4.6：定稿后判「占位主角卡改名建议」用（缺省不给建议）。
        projectDir,
      }));
      // 定稿按钮不经对话 AI，但定稿里有章节声明、抽事实对账等模型调用，同样记账。
      console.info(`[token-usage] ${describeTokenUsage(actionUsage)}`);
      sendEvent("usage", actionUsage);
      const action = parsedAction.action;
      await appendTurnMetrics(projectDir, "chapter" in action ? action.chapter : currentChapter, {
        kind: "action",
        label: action.toolName,
        ms: Date.now() - actionStarted,
        usage: actionUsage,
      });
      sendEvent("done", {});
      res.end();
      return;
    }

    // R7.7·报告 4.6：同一本书只提示一次（进程内登记），不再每回合都弹——作者从第 3 章起每回合看到这条，烦且看不懂。
    if (droppedHistoryCount > 0 && shouldSendHistoryTrimNoticeOnce(projectDir)) {
      sendEvent("status", {
        message:
          `这次只带上最近 ${messages.length} 条对话给 AI，更早的 ${droppedHistoryCount} 条它看不到；故事资料不受影响。` +
          "前面说过的安排要用到的话，请再说一遍。",
      });
    }

    // 读全书章节文件状态（空/有草稿/已入库）：①取当前章给 agent 抓手；②派生「全书磁盘真相」硬约束
    // 注入 system，结构性防谎报（A3）。这次扫盘的全书结果不再只取一条就丢。读盘失败不阻塞聊天。
    const allChapterStates = await readUiChapterFileStates(projectDir).catch(() => [] as readonly UiChapterFileState[]);
    const currentChapterStatus = currentChapter !== undefined
      ? allChapterStates.find((s) => s.chapter === currentChapter)
      : undefined;
    const systemMessage = buildCurrentChapterSystemMessage(currentChapter, currentChapterStatus, allChapterStates);
    const history = messages.map((m) => ({ role: m.role, content: m.content } as ModelMessage));
    // 当前章提示紧贴用户最新指令（而非塞开头被历史淹没）——⑤头号根因 lost-in-the-middle。
    const modelMessages: ModelMessage[] = buildModelMessages(systemMessage, history);
    const visibleTextScrubber = createStreamingScrubber();

    const turnStarted = Date.now();
    const { result: { finishReason }, usage } = await withTokenMeter(async () => runAgentTurn({
      fullStream: (
        await agent.stream([...modelMessages], {
          requestContext,
          // 客户端断开即中止：Mastra 把 signal 穿进 streamText（取消 in-flight 生成、不再开新步骤）。
          abortSignal: disconnectAbort.signal,
          maxSteps: AGENT_TURN_MAX_STEPS,
        })
      ).fullStream as AsyncIterable<AgentTurnChunk>,
      sendEvent,
      scrubber: visibleTextScrubber,
      shouldStop: () => disconnectAbort.signal.aborted,
    }));

    // 本轮真实 token 用量（对话 AI + 工具内部调用）：打日志、发给前端。服务商没回用量时全是 0，照样如实发。
    console.info(`[token-usage] ${describeTokenUsage(usage)}`);
    sendEvent("usage", usage);
    await appendTurnMetrics(projectDir, currentChapter, { kind: "chat", ms: Date.now() - turnStarted, usage });
    sendEvent("done", { ...(finishReason ? { finishReason } : {}) });
    res.end();
  } catch (error) {
    // 审计 Med：两条路（500 JSON 与 SSE error 帧）都进用户可见区域——先过 scrubLocalAbsolutePaths。
    const message = scrubLocalAbsolutePaths(error instanceof Error ? error.message : String(error));
    if (res.headersSent) {
      // 已切到 SSE：错误也走 error 事件（前端可重试），再收尾。
      try {
        sendEvent("error", { error: message, retryable: true });
      } catch {
        // ignore write failures on a broken pipe
      }
      res.end();
    } else {
      writeJson(res, 500, { ok: false, error: message, retryable: true });
    }
  } finally {
    stopHeartbeat?.();
  }
}

/** 结构化动作的工具执行器：按白名单取工具、带同一 requestContext 直接 execute。 */
const executeUserActionTool: UserActionToolExecutor = async (toolName, input, requestContext) => {
  switch (toolName) {
    case "check_continuity": {
      const execute = checkContinuityTool.execute as unknown as (
        input: Record<string, unknown>,
        context: { readonly requestContext: typeof requestContext },
      ) => Promise<unknown>;
      return execute(input, { requestContext });
    }
    case "commit_preview": {
      const execute = commitPreviewTool.execute as unknown as (
        input: Record<string, unknown>,
        context: { readonly requestContext: typeof requestContext },
      ) => Promise<unknown>;
      return execute(input, { requestContext });
    }
    case "commit_apply": {
      const execute = commitApplyTool.execute as unknown as (
        input: Record<string, unknown>,
        context: { readonly requestContext: typeof requestContext },
      ) => Promise<unknown>;
      return execute(input, { requestContext });
    }
    case "generate_draft": {
      const execute = generateDraftTool.execute as unknown as (
        input: Record<string, unknown>,
        context: { readonly requestContext: typeof requestContext },
      ) => Promise<unknown>;
      return execute(input, { requestContext });
    }
    case "prune_snapshots": {
      const execute = pruneSnapshotsTool.execute as unknown as (
        input: Record<string, unknown>,
        context: { readonly requestContext: typeof requestContext },
      ) => Promise<unknown>;
      return execute(input, { requestContext });
    }
  }
};

function stringifyError(error: unknown): string {
  // 审计 Med：错误原文（fs errno 等）内嵌本地绝对路径，直达前端步骤卡/错误气泡——
  // 与 chapter-chat 已立的口径对齐：进用户可见面之前先过 scrubLocalAbsolutePaths。
  return scrubLocalAbsolutePaths(rawStringifyError(error));
}

function rawStringifyError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
