/**
 * POST /api/agent/chat — Mastra 写作总控 agent 的 SSE 入口。
 *
 * body: { projectPath: string, messages: [{ role, content }], currentChapter?: number }
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

import { buildProjectRequestContext } from "../agent/request-context.js";
import { getStoryAgent } from "../agent/story-agent.js";
import { createStreamingScrubber } from "../lib/entity-id-scrubber.js";
import {
  buildObedienceRetryNudgeMessage,
  detectMissingExecutionForRequest,
  detectUnbackedCompletionClaim,
  inferClaimedWriteTool,
  OBEDIENCE_RETRY_TRANSITION_TEXT,
  sanitizeCorrectedAssistantHistory,
  unbackedCompletionNoticeText,
  type HonestyToolStep,
} from "../../shared/honesty-detection.js";
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
    return `本章（第 ${chapter} 章）已入库${title ? `（标题：${title}）` : ""}。`;
  }
  // 「有草稿」只认真草稿：.md 有真内容，或 workspace 里有真草稿。光「开过」(hasWorkspaceSnapshot) 不算，
  // 否则用户只是打开/打了招呼、本章其实是空的，却被谎报「已有工作稿」，agent 跟着说「第N章已有内容」（真机实测 bug）。
  if (status?.hasDraftFile || status?.hasWorkspaceDraft) {
    const title = status.draftTitle ?? status.workspaceTitle;
    return `本章（第 ${chapter} 章）已有工作稿待处理${title ? `（标题：${title}）` : ""}，尚未入库。`;
  }
  return `本章（第 ${chapter} 章）还没有草稿，是空的。`;
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
    ? `第 ${currentChapter} 章已入库；用户说「继续/接着写/写下一章」时，目标是第 ${currentChapter + 1} 章（往前推进），不是重写第 ${currentChapter} 章。`
    : `用户说「继续/接着写」时指在本章继续（结合上面的本章状态判断是从头出稿还是接着已有草稿）。`;
  return {
    role: "system",
    content:
      (truthLine ? `${truthLine}\n` : "") +
      `【当前上下文】用户此刻正停留在第 ${currentChapter} 章。` +
      (statusLine ? statusLine : "") +
      `凡涉及具体章号的操作（读取该章、出稿/续写、修订、质检、审稿、入库预览/入库）：` +
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
    : `；有未入库工作稿的章节：第 ${draftOnly.slice(0, 20).join("、")} 章`;
  return (
    `【磁盘真相·硬约束】${committedDesc}${draftDesc}。这是磁盘上的客观事实。` +
    `凡你声称某章「已生成草稿 / 已质检 / 已审稿 / 已入库」，都必须与此一致：这里没列为已入库的章就是还没入库、` +
    `绝不能说成已入库；没列出工作稿的章就是还没写、绝不能说成已写好。拿不准先调 read_chapters_overview / ` +
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
 * SSE 心跳：工具执行期间 fullStream 可能长时间不吐 chunk（如 generate_worldbuilding 一次性大模型
 * 调用，服务端给 200s、期间 SSE 全程静默），客户端 90s 空闲看门狗会误判超时掐流——服务端其实还在
 * 老实生成。每 intervalMs 发一条 SSE 注释行（合法 SSE，客户端语义忽略、但收到字节即重置看门狗），
 * 喂活看门狗。这样 90s 看门狗语义回归正确：「连心跳都收不到」才算真·网络/服务端挂了（永久转圈保护不丢）。
 * 返回停止函数，务必在流结束/出错收尾时调用（避免向已关闭的响应写入）。
 */
export function startSseHeartbeat(
  res: { write: (chunk: string) => void },
  intervalMs: number = SSE_HEARTBEAT_INTERVAL_MS,
): () => void {
  const timer = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      // 客户端已断开（broken pipe）：吞掉写失败，等收尾停表。
    }
  }, intervalMs);
  return () => clearInterval(timer);
}

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

export function serverHonestyCorrectionText(args: {
  readonly userText: string | undefined;
  readonly assistantText: string;
  readonly toolSteps: readonly HonestyToolStep[];
}): string | null {
  const userText = args.userText ?? "";
  const assistantText = args.assistantText.trim();
  if (!assistantText && !userText.trim()) return null;

  if (detectUnbackedCompletionClaim(assistantText, args.toolSteps)) {
    return `\n\n⚠️ 系统更正：${unbackedCompletionNoticeText(assistantText, userText)}`;
  }
  const missingExecution = detectMissingExecutionForRequest(userText, args.toolSteps);
  if (missingExecution) {
    return `\n\n⚠️ 系统更正：${missingExecution.notice}`;
  }
  return null;
}

function toolResultStatus(output: unknown): HonestyToolStep["status"] {
  const result = output as { readonly needsConfirmation?: unknown; readonly ok?: unknown; readonly partialMiss?: unknown } | undefined;
  if (result?.needsConfirmation === true) return "needs_confirmation";
  if (result?.ok === false) return "failed";
  if (result?.partialMiss === true) return "partial";
  return "completed";
}

/**
 * 服从重试上限（r8）：检出「口头声称完成但零工具调用」后自动重做的次数（1 = 初跑 + 最多 1 次重做）。
 * 绝不无限重试：重做后仍空转就按老路径追加诚实更正、如实收场。
 */
export const MAX_OBEDIENCE_RETRIES = 1;

/**
 * 聊天历史窗口上限（r8 二轮·治「回执模式污染」的源头）。
 *
 * 真机实锤（ch84/ch88/ch93 三个病例完全一致）：聊天历史堆到 ≥5 章「出稿→回执→入库→回执」
 * 的重复剧本后，弱模型开始续写回执模式、不调工具——**正常成功回执也会诱发**，不只是被更正的
 * 编造回执（消毒治不了这一半）。故事状态的真值源本来就在磁盘/工具（read_state_overview、
 * 磁盘真相 system 行），聊天历史只承担近程对话连续性——截到最近 12 条（约 6 个回合），
 * 把模式先验掐在发病窗口（约 20 条）之下。确定性、模型无关。
 */
export const MAX_CHAT_HISTORY_MESSAGES = 12;

export function capChatHistoryWindow<T>(
  messages: readonly T[],
  limit: number = MAX_CHAT_HISTORY_MESSAGES,
): readonly T[] {
  return messages.length <= limit ? messages : messages.slice(-limit);
}

/** 重做轮的工具选择策略（r8 二轮）：结构性强制，防止纠偏后模型交白卷/继续纯文本编造。 */
export type ObedienceToolChoice = "required" | { readonly type: "tool"; readonly toolName: string };

export interface ObedienceAttemptOptions {
  /** 强制工具调用：能定位到期望工具就点名强制，否则至少强制调一个工具。 */
  readonly toolChoice?: ObedienceToolChoice;
  /** 点名强制时限 1 步：forced toolChoice 会作用于每一步，放多步会反复调同一工具。 */
  readonly maxSteps?: number;
}

/** agent.stream fullStream chunk 的结构化最小面（只声明本路由真正读的字段，真实类型由 Mastra 提供）。 */
export interface ObedientTurnChunk {
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
  };
}

/**
 * 带「服从重试」的 agent 回合执行器（r8 治 ch88 阻断的核心）：
 *
 * 消费一次 agent.stream 的 fullStream 并转发 SSE；回合结束跑诚实检测——若检出「声称完成/请求执行
 * 却零对应工具调用」（`serverHonestyCorrectionText` 非空）且还有重试额度，则：
 *   ①向用户推一条过渡文案（可见记录保持诚实：上面的声称无效、下面才是真实执行）；
 *   ②把本轮产出文本 + 系统纠偏消息追加进模型消息序列，**沿用同一 requestContext**（用户原话
 *     不变 → TurnIntentGate 对合法写入不误拦），自动重跑一轮。
 * 重做后仍检出 → 按原路径追加「⚠️ 系统更正」诚实收场，绝不第三轮、绝不谎报。
 *
 * 为什么不能只靠更正文案：ch84/ch88 真机实锤——护栏只纠文本时，弱模型把历史里的成功回执当剧本续写，
 * 更正后下一回合继续编造，长跑三连败卡死。重试把「自愈」从赌模型素质变成系统机制（模型无关）。
 * 抽成独立函数并注入 streamAttempt，是为了单测能用假流覆盖重试路径（真机验证成本太高）。
 */
export async function runObedientAgentTurn(args: {
  readonly initialMessages: readonly ModelMessage[];
  readonly userText: string | undefined;
  readonly streamAttempt: (
    messages: readonly ModelMessage[],
    options?: ObedienceAttemptOptions,
  ) => Promise<AsyncIterable<ObedientTurnChunk>>;
  readonly sendEvent: (event: string, data: unknown) => void;
  readonly scrubber: { push(text: string): string; flush(): string };
  readonly maxRetries?: number;
  /** 客户端已断开（abortOnClientDisconnect）：立即停转发、且检出空转也不再自动重做（不再开新工具步骤）。 */
  readonly shouldStop?: () => boolean;
}): Promise<{ readonly finishReason: string | undefined; readonly attempts: number }> {
  const maxRetries = args.maxRetries ?? MAX_OBEDIENCE_RETRIES;
  const modelMessages: ModelMessage[] = [...args.initialMessages];
  let finishReason: string | undefined;
  // 跨尝试累计：工具活动/最近摘要供「绝不静默」兜底（重做轮真调了工具，兜底就该转述它的结果）。
  let sawToolActivity = false;
  let lastToolSummary: string | undefined;
  let attemptOptions: ObedienceAttemptOptions | undefined;
  // 诚实检测按【整回合累计】口径：首轮真跑了 commit_preview、重做轮只补 commit_apply 时，
  // 只看重做轮会把 preview 误判成「没执行」（组合意图）。声称文本与工具集都跨尝试累计。
  const toolSteps = new Map<string, HonestyToolStep>();
  let turnText = "";

  for (let attempt = 0; ; attempt += 1) {
    let attemptText = "";
    let attemptEmittedText = false;

    const fullStream = await args.streamAttempt(modelMessages, attemptOptions);
    for await (const chunk of fullStream) {
      // 客户端已断开：流还在吐也不再转发（write 到已关闭的 res 只是空转），尽快退出消费。
      if (args.shouldStop?.()) break;
      switch (chunk.type) {
        case "text-delta": {
          const text = chunk.payload?.text;
          if (text) {
            attemptEmittedText = true;
            attemptText += text;
            turnText += text;
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
          const toolCallId = chunk.payload?.toolCallId ?? "";
          toolSteps.set(toolCallId, {
            toolName: chunk.payload?.toolName,
            status: "running",
          });
          args.sendEvent("tool-call", {
            toolCallId,
            toolName: chunk.payload?.toolName,
            args: chunk.payload?.args ?? {},
          });
          break;
        }
        case "tool-result": {
          sawToolActivity = true;
          const toolCallId = chunk.payload?.toolCallId ?? "";
          const resultPayload = chunk.payload?.result as
            | { readonly summary?: unknown; readonly dryRun?: unknown; readonly action?: unknown }
            | undefined;
          const summary = resultPayload?.summary;
          if (typeof summary === "string" && summary.trim()) lastToolSummary = summary.trim();
          toolSteps.set(toolCallId, {
            toolName: chunk.payload?.toolName,
            status: toolResultStatus(chunk.payload?.result),
            // 诚实背书粒度（honesty-detection stepBacksWriteClaim）：prune 的 dryRun（预览不背书）/
            // exemplars 的 action（list 不背书）随步骤带上；没有这两字段的工具自然缺省、维持旧口径。
            ...(typeof resultPayload?.dryRun === "boolean" ? { dryRun: resultPayload.dryRun } : {}),
            ...(typeof resultPayload?.action === "string" ? { action: resultPayload.action } : {}),
          });
          args.sendEvent("tool-result", {
            toolCallId,
            toolName: chunk.payload?.toolName,
            output: chunk.payload?.result,
          });
          break;
        }
        case "tool-error": {
          // 工具内部抛错（如缺 projectDir / 落盘失败）。绝不静默失败，且必须收尾正在 running 的
          // 步骤/卡片：发独立 tool-error 事件（带 toolCallId+toolName），前端据此把对应步骤置 failed
          // 再 append 错误消息——而非复用 error 事件（那样无法定位是哪张卡，时间线会卡在 running）。
          const toolCallId = chunk.payload?.toolCallId ?? "";
          toolSteps.set(toolCallId, {
            toolName: chunk.payload?.toolName,
            status: "failed",
          });
          args.sendEvent("tool-error", {
            toolCallId,
            toolName: chunk.payload?.toolName,
            error: stringifyError(chunk.payload?.error),
            retryable: true,
          });
          break;
        }
        case "error": {
          args.sendEvent("error", { error: stringifyError(chunk.payload?.error), retryable: true });
          break;
        }
        case "finish": {
          finishReason = chunk.payload?.stepResult?.reason;
          break;
        }
        default:
          break;
      }
    }

    const stepsForDetection = [...toolSteps.values()];
    const correction = serverHonestyCorrectionText({
      userText: args.userText,
      assistantText: turnText,
      toolSteps: stepsForDetection,
    });

    // 客户端已断开时不重做：重试会再开一轮 agent.stream（新工具步骤），人已走茶凉纯属白费算力。
    if (correction && attempt < maxRetries && args.shouldStop?.() !== true) {
      // 结构性强制（r8 二轮·ch93 实锤纯 prompt 纠偏无效——flash 重做轮直接交白卷）：
      // 能从用户意图定位到期望工具就点名强制 + 限 1 步（forced choice 作用于每一步，多步会反复调
      // 同一工具）；定位不到（只有声称、意图模糊）就至少强制调一个工具。协议层杜绝「纯文本再编一遍」。
      // 期望工具定位：先用户意图（missing execution）；定位不到再从声称文本反推被编造的动作
      // （ch96 实锤：真跑了 commit_preview、编造了 commit_apply——组合意图里 apply 让位、missing 为空，
      // 但「已正式入库」的声称本身指认了该强制哪个工具）。都定位不到才 required 兜底。
      const missing = detectMissingExecutionForRequest(args.userText ?? "", stepsForDetection);
      const forcedTool = missing?.expectedTool ?? inferClaimedWriteTool(attemptText);
      // required 也必须限步（真机实锤）：forced choice 每一步都强制调工具、永远到不了纯文本收尾，
      // 不限步会一直跑到框架步数上限（弱模型开思考时一步一分钟，整轮挂十来分钟）。
      attemptOptions = forcedTool
        ? { toolChoice: { type: "tool", toolName: forcedTool }, maxSteps: 1 }
        : { toolChoice: "required", maxSteps: 4 };
      console.warn(
        `[obedience-retry] 第 ${attempt + 1} 次回复口头声称未执行（零对应工具调用），自动重做一次` +
          `（强制工具：${forcedTool ?? "required"}）`,
      );
      if (attemptText.trim()) modelMessages.push({ role: "assistant", content: attemptText });
      modelMessages.push(buildObedienceRetryNudgeMessage(args.userText, forcedTool));
      const transition = args.scrubber.push(OBEDIENCE_RETRY_TRANSITION_TEXT);
      if (transition) args.sendEvent("text-delta", { text: transition });
      continue;
    }

    // 最终尝试收尾。绝不静默：本轮一个 text 都没发就补一条收尾，别让用户对着无声的工具结果发懵（#2/#4）。
    // emittedText 按【最终尝试】算——被作废的首轮声称不算「已回话」，重做轮闷头调完工具就该转述其结果。
    const fallback = closingFallbackText({ emittedText: attemptEmittedText, sawToolActivity, lastToolSummary });
    if (fallback) {
      const scrubbed = args.scrubber.push(fallback);
      if (scrubbed) args.sendEvent("text-delta", { text: scrubbed });
    }
    const remainingText = args.scrubber.flush();
    if (remainingText) args.sendEvent("text-delta", { text: remainingText });

    if (correction) {
      console.warn(`[honesty-guard] 追加服务端诚实更正：${correction.replace(/\s+/gu, " ").slice(0, 240)}`);
      const correctionScrubber = createStreamingScrubber();
      const text = correctionScrubber.push(correction) + correctionScrubber.flush();
      if (text) args.sendEvent("text-delta", { text });
    }

    return { finishReason, attempts: attempt + 1 };
  }
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
  const sendEvent = (event: string, data: unknown) => {
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

    // 进站消毒（r8 任务②）：把历史里被系统更正/作废过的编造回执换成短桩，打断「编造回执成为
    // 后续回合造假范本」的正反馈污染（user 消息原样保留）。再截历史窗口（r8 二轮）：正常成功回执
    // 堆多了同样诱发模式续写（ch93 实锤），只保留最近一段——故事状态真值源在磁盘/工具，不在聊天历史。
    const messages = capChatHistoryWindow(sanitizeCorrectedAssistantHistory(readChatMessages(body.messages)));
    if (messages.length === 0) {
      writeJson(res, 400, { ok: false, error: "对话内容不能为空。" });
      return;
    }

    await assertStoryEngineProject(projectDir);

    // H3：把用户当前所在章注入 RequestContext（工具缺省回退用）+ system 上下文（引导 agent 默认作用于该章）。
    const currentChapter = readCurrentChapter(body.currentChapter);

    const agent = await getStoryAgent();
    // 出稿流式：注入 sink，让 generate_draft 工具把正文 delta 实时转成 draft-delta SSE 事件（前端逐字进编辑器）。
    // sink 在工具 await 模型期间同步触发 sendEvent（此时 agent.stream 正 parked，draft-delta 自然单独流出）。
    const requestContext = buildProjectRequestContext(
      projectDir,
      currentChapter,
      (payload) => sendEvent("draft-delta", payload),
      readLatestUserTurnText(messages),
    );

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    // 工具长调用期间 SSE 会长时间静默，靠心跳喂活客户端 90s 空闲看门狗，避免误判超时掐流。
    stopHeartbeat = startSseHeartbeat(res);

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

    // 带服从重试的回合执行（r8 任务①）：空转声称 → 自动重做一次 → 仍空转才诚实更正收场。
    // streamAttempt 每次沿用同一 requestContext（用户原话不变 → 写入意图门对合法重做不误拦）。
    const { finishReason } = await runObedientAgentTurn({
      initialMessages: modelMessages,
      userText: readLatestUserTurnText(messages),
      streamAttempt: async (attemptMessages, options) =>
        (
          await agent.stream([...attemptMessages], {
            requestContext,
            // 客户端断开即中止：Mastra 把 signal 穿进 streamText（取消 in-flight 生成、不再开新步骤）。
            abortSignal: disconnectAbort.signal,
            ...(options?.toolChoice ? { toolChoice: options.toolChoice } : {}),
            ...(options?.maxSteps ? { maxSteps: options.maxSteps } : {}),
          })
        ).fullStream as AsyncIterable<ObedientTurnChunk>,
      sendEvent,
      scrubber: visibleTextScrubber,
      shouldStop: () => disconnectAbort.signal.aborted,
    });

    sendEvent("done", { ...(finishReason ? { finishReason } : {}) });
    res.end();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
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

function stringifyError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
