/**
 * 用户结构化动作（2026-10-07 拆补丁塔）：界面按钮（定稿预览卡 / 建议条「确认定稿」）发来的明确指令，
 * 服务端直接执行对应工具，不经模型判断——按钮点击本身就是授权，不再用正则去猜用户原话。
 *
 * 事件协议与 agent 回合完全一致（tool-call / tool-result / text-delta），前端投影零分叉：
 * 入库 delta 卡、撤销快照、草稿以 committed 态载入都照旧走。收尾文本与下一步选项确定性生成，不调模型。
 */
import type { RequestContext } from "@mastra/core/di";

import { markUserConfirmedTool } from "./request-context.js";

/** 允许经按钮直接执行的工具（白名单；新增前想清楚它是否真需要绕过模型）。 */
export const USER_ACTION_TOOL_NAMES = ["commit_apply", "prune_snapshots", "check_continuity", "commit_preview", "generate_draft"] as const;
export type UserActionToolName = (typeof USER_ACTION_TOOL_NAMES)[number];

/** 「确认定稿」：定这一章。「确认裁剪」：把操作历史裁到最近 keep 条（缺省=引擎默认 200）。 */
export type UserAction =
  | {
    readonly toolName: "commit_apply";
    readonly chapter: number;
    readonly previewToken?: string;
    /** 作者在定稿预览的账本清单上去掉的条目 id（这些不写进账本）。 */
    readonly excluded?: readonly string[];
    /** 作者改的「第几天」。 */
    readonly dayOverride?: number;
  }
  | { readonly toolName: "prune_snapshots"; readonly keep?: number }
  /** 「核账」：只读，拿这一章对前文原文找对不上的地方。fresh=「再细核一遍」（正文没改也重新核）。 */
  | { readonly toolName: "check_continuity"; readonly chapter: number; readonly fresh?: boolean }
  /** 「定稿」按钮：只读，生成定稿预览（登记票据、列账本清单），不经模型判断。 */
  | { readonly toolName: "commit_preview"; readonly chapter: number }
  /**
   * 「写这一章」按钮（2026-10-10 引擎升级第 5 期「出稿一条路」）：直接执行 generate_draft——先拿章纲、写、
   * 字数不够接着写、写完核账，和对话里让 AI 写同一套。原来按钮走 /api/draft/stream，没章纲也不核账。
   */
  | { readonly toolName: "generate_draft"; readonly chapter: number; readonly chapterGoal?: string };

/** 账本清单一次最多去掉多少条（防异常请求体）。 */
const MAX_EXCLUDED = 500;

/** body.action 解析：缺省 → none（普通对话）；形状不对 → invalid（路由回 400，绝不静默当普通对话）。 */
export type ParsedUserAction =
  | { readonly kind: "none" }
  | { readonly kind: "invalid"; readonly reason: string }
  | { readonly kind: "action"; readonly action: UserAction };

export function parseUserAction(raw: unknown): ParsedUserAction {
  if (raw === undefined || raw === null) return { kind: "none" };
  if (typeof raw !== "object" || Array.isArray(raw)) return { kind: "invalid", reason: "动作格式不对。" };
  const record = raw as Record<string, unknown>;
  const toolName = record.toolName;
  if (typeof toolName !== "string" || !(USER_ACTION_TOOL_NAMES as readonly string[]).includes(toolName)) {
    return { kind: "invalid", reason: "不支持的操作。" };
  }
  if (toolName === "prune_snapshots") {
    const rawKeep = typeof record.keep === "string" ? Number(record.keep.trim()) : record.keep;
    if (rawKeep === undefined || rawKeep === null || rawKeep === "") return { kind: "action", action: { toolName: "prune_snapshots" } };
    if (typeof rawKeep !== "number" || !Number.isInteger(rawKeep) || rawKeep < 0) {
      return { kind: "invalid", reason: "保留条数不对。" };
    }
    return { kind: "action", action: { toolName: "prune_snapshots", ...(rawKeep > 0 ? { keep: rawKeep } : {}) } };
  }
  const chapter = typeof record.chapter === "string" ? Number(record.chapter.trim()) : record.chapter;
  if (typeof chapter !== "number" || !Number.isInteger(chapter) || chapter <= 0) {
    return { kind: "invalid", reason: "缺少有效章号。" };
  }
  if (toolName === "commit_preview") return { kind: "action", action: { toolName: "commit_preview", chapter } };
  if (toolName === "generate_draft") {
    const chapterGoal = typeof record.chapterGoal === "string" ? record.chapterGoal.trim().slice(0, 2000) : "";
    return { kind: "action", action: { toolName: "generate_draft", chapter, ...(chapterGoal ? { chapterGoal } : {}) } };
  }
  if (toolName === "check_continuity") {
    return { kind: "action", action: { toolName: "check_continuity", chapter, ...(record.fresh === true ? { fresh: true } : {}) } };
  }
  const previewToken = typeof record.previewToken === "string" && record.previewToken.trim()
    ? record.previewToken.trim()
    : undefined;
  const excluded = Array.isArray(record.excluded)
    ? [...new Set(record.excluded.filter((id): id is string => typeof id === "string" && id.trim().length > 0 && id.length <= 200).map((id) => id.trim()))].slice(0, MAX_EXCLUDED)
    : [];
  const rawDay = typeof record.dayOverride === "string" ? Number(record.dayOverride.trim()) : record.dayOverride;
  const dayOverride = typeof rawDay === "number" && Number.isInteger(rawDay) && rawDay >= 1 && rawDay <= 100_000 ? rawDay : undefined;
  return {
    kind: "action",
    action: {
      toolName: "commit_apply",
      chapter,
      ...(previewToken ? { previewToken } : {}),
      ...(excluded.length > 0 ? { excluded } : {}),
      ...(dayOverride !== undefined ? { dayOverride } : {}),
    },
  };
}

interface NextStepChoice {
  readonly label: string;
  readonly intent: string;
  readonly recommended?: boolean;
  /**
   * 结构化动作（R4.7/验收 3.8）：带上它的选项，前端点击直接发 body.action 到 /api/agent/chat，
   * 不再发一句意图给模型（一次省 3～5 万输入）。只给**服务端自己生成**的确定性选项填
   * （预览定稿/再核一次/写下一章…）；模型 suggest_next_steps 生成的选项没有这个字段，照旧发文本。
   */
  readonly action?: UserAction;
}

interface CommitApplyLikeOutput {
  readonly committed?: unknown;
  readonly summary?: unknown;
  readonly chapter?: unknown;
  readonly threadMaintenanceHint?: unknown;
}

/** 给用户看的收尾文本：工具 summary 里偶有工具名（「尚未对该章执行 commit_preview」），换成人话。 */
export function humanizeToolNames(text: string): string {
  return text.replace(/commit_preview/gu, "定稿预览").replace(/commit_apply/gu, "定稿");
}

/** 定稿动作收尾的下一步选项（确定性）：成功 → 写下一章（+线索堆积时清理）；未成 → 重新预览。 */
export function commitApplyNextSteps(
  chapter: number,
  output: CommitApplyLikeOutput | undefined,
): { readonly question: string; readonly choices: readonly NextStepChoice[] } {
  if (output?.committed === true) {
    return {
      question: `第 ${chapter} 章定稿了，接下来？`,
      choices: [
        {
          label: `写第 ${chapter + 1} 章`,
          intent: `继续写第 ${chapter + 1} 章的正文`,
          recommended: true,
          action: { toolName: "generate_draft", chapter: chapter + 1 },
        },
        ...(output.threadMaintenanceHint === "escalated" ? [{ label: "清理线索", intent: "清理线索" }] : []),
      ],
    };
  }
  return {
    question: `第 ${chapter} 章还没定稿，接下来？`,
    choices: [{
      label: "重新预览",
      intent: `生成第 ${chapter} 章定稿预览`,
      recommended: true,
      action: { toolName: "commit_preview", chapter },
    }],
  };
}

export type UserActionToolExecutor = (
  toolName: UserActionToolName,
  input: Record<string, unknown>,
  requestContext: RequestContext,
) => Promise<unknown>;

/**
 * 执行一次用户结构化动作并把结果按 agent 回合同款事件推给前端。
 * 工具抛错 → tool-error + 如实文案（绝不静默）；标记只在本次执行期间存在，结束即清。
 */
export async function runUserAction(args: {
  readonly action: UserAction;
  readonly requestContext: RequestContext;
  readonly executeTool: UserActionToolExecutor;
  readonly sendEvent: (event: string, data: unknown) => void;
  readonly scrubber: { push(text: string): string; flush(): string };
  readonly scrubError: (error: unknown) => string;
}): Promise<void> {
  const { action } = args;
  if (action.toolName === "prune_snapshots") {
    await runPruneAction({ ...args, action });
    return;
  }
  if (action.toolName === "check_continuity") {
    await runCheckContinuityAction({ ...args, action });
    return;
  }
  if (action.toolName === "commit_preview") {
    await runCommitPreviewAction({ ...args, action });
    return;
  }
  if (action.toolName === "generate_draft") {
    await runGenerateDraftAction({ ...args, action });
    return;
  }
  const stamp = Date.now();
  const toolCallId = `user-action-${action.toolName}-${stamp}`;
  const emitText = (text: string): void => {
    const scrubbed = args.scrubber.push(text);
    if (scrubbed) args.sendEvent("text-delta", { text: scrubbed });
  };

  args.sendEvent("tool-call", { toolCallId, toolName: action.toolName, args: { chapter: action.chapter } });
  let output: unknown;
  markUserConfirmedTool(args.requestContext, action.toolName);
  try {
    output = await args.executeTool(
      action.toolName,
      {
        chapter: action.chapter,
        ...(action.previewToken ? { previewToken: action.previewToken } : {}),
        ...(action.excluded && action.excluded.length > 0 ? { excluded: action.excluded } : {}),
        ...(action.dayOverride !== undefined ? { dayOverride: action.dayOverride } : {}),
      },
      args.requestContext,
    );
  } catch (error) {
    const message = args.scrubError(error);
    args.sendEvent("tool-error", { toolCallId, toolName: action.toolName, error: message, retryable: true });
    emitText(`第 ${action.chapter} 章定稿没有完成：${humanizeToolNames(message)}。可以再点一次「确认定稿」重试。`);
    const rest = args.scrubber.flush();
    if (rest) args.sendEvent("text-delta", { text: rest });
    return;
  } finally {
    markUserConfirmedTool(args.requestContext, undefined);
  }

  args.sendEvent("tool-result", { toolCallId, toolName: action.toolName, output });
  const result = output as CommitApplyLikeOutput | undefined;
  const summary = typeof result?.summary === "string" && result.summary.trim()
    ? result.summary.trim()
    : result?.committed === true
      ? `第 ${action.chapter} 章已定稿。`
      : `第 ${action.chapter} 章没有定稿。`;
  emitText(humanizeToolNames(summary));
  const rest = args.scrubber.flush();
  if (rest) args.sendEvent("text-delta", { text: rest });

  const nextSteps = commitApplyNextSteps(action.chapter, result);
  const nextCallId = `user-action-next-${stamp}`;
  args.sendEvent("tool-call", { toolCallId: nextCallId, toolName: "suggest_next_steps", args: {} });
  args.sendEvent("tool-result", {
    toolCallId: nextCallId,
    toolName: "suggest_next_steps",
    output: { ok: true, question: nextSteps.question, choices: nextSteps.choices },
  });
}

interface CheckContinuityLikeOutput {
  readonly ok?: unknown;
  readonly reused?: unknown;
  readonly summary?: unknown;
  readonly sure?: readonly unknown[];
  readonly maybe?: readonly unknown[];
  /** 只在「还在读、这次没核」时有：核账员读到第 done / total 章（区分「还在读」和「出错」用这个字段，别解析 failures 文字）。 */
  readonly pending?: { readonly done: number; readonly total: number };
}

/** 「核账」按钮：服务端直接跑核账（只读），结果按 agent 回合同款事件推给前端，再给下一步选项。 */
async function runCheckContinuityAction(args: Omit<Parameters<typeof runUserAction>[0], "action"> & {
  readonly action: Extract<UserAction, { readonly toolName: "check_continuity" }>;
}): Promise<void> {
  const { action } = args;
  const stamp = Date.now();
  const toolCallId = `user-action-check_continuity-${stamp}`;
  const emitText = (text: string): void => {
    const scrubbed = args.scrubber.push(text);
    if (scrubbed) args.sendEvent("text-delta", { text: scrubbed });
  };
  const input = { chapter: action.chapter, ...(action.fresh ? { fresh: true } : {}) };
  args.sendEvent("tool-call", { toolCallId, toolName: "check_continuity", args: input });
  let output: unknown;
  try {
    output = await args.executeTool("check_continuity", input, args.requestContext);
  } catch (error) {
    const message = args.scrubError(error);
    args.sendEvent("tool-error", { toolCallId, toolName: "check_continuity", error: message, retryable: true });
    emitText(`第 ${action.chapter} 章核账没跑成：${message}。可以再点一次「核账」。`);
    const rest = args.scrubber.flush();
    if (rest) args.sendEvent("text-delta", { text: rest });
    return;
  }
  args.sendEvent("tool-result", { toolCallId, toolName: "check_continuity", output });
  const result = output as CheckContinuityLikeOutput | undefined;
  // 没核成（ok:false：还在读 / 出错 / 没正文）绝不写「核账做完了」。summary 缺失时的兜底也按 pending
  // 区分「还在读」和「出错」（结构化字段，不解析 failures 文字）——R4.1/验收 3.1。
  const notChecked = result?.ok === false;
  const fallbackSummary = notChecked
    ? result?.pending
      ? `第 ${action.chapter} 章这次没核成：核账员还在读前文（第 ${result.pending.done} / ${result.pending.total} 章）。`
      : `第 ${action.chapter} 章这次没核成。`
    : `第 ${action.chapter} 章核账做完了。`;
  emitText(typeof result?.summary === "string" && result.summary.trim() ? result.summary.trim() : fallbackSummary);
  const rest = args.scrubber.flush();
  if (rest) args.sendEvent("text-delta", { text: rest });
  // 没核成：下一步只给「再核一次」「先写下一章」——不给「预览定稿」（没核过不该推荐定稿）、
  // 不给「改掉确定的 N 处」（sure 是空的），问句也不写「做完了」。
  if (notChecked) {
    const failedCallId = `user-action-next-${stamp}`;
    args.sendEvent("tool-call", { toolCallId: failedCallId, toolName: "suggest_next_steps", args: {} });
    args.sendEvent("tool-result", {
      toolCallId: failedCallId,
      toolName: "suggest_next_steps",
      output: {
        ok: true,
        question: "这次没核成，接下来？",
        choices: [
          {
            label: "再核一次",
            intent: `重新核第 ${action.chapter} 章的账`,
            recommended: true,
            action: { toolName: "check_continuity", chapter: action.chapter },
          },
          {
            label: "先写下一章",
            intent: "继续写下一章的正文",
            action: { toolName: "generate_draft", chapter: action.chapter + 1 },
          },
        ],
      },
    });
    return;
  }
  const sureCount = Array.isArray(result?.sure) ? result.sure.length : 0;
  // 正文没改、直接给的上次结果 → 多给一个「再细核一遍」（重新核，上次的问题照样带上）。
  const fresh: NextStepChoice[] = result?.reused === true
    ? [{
        label: "再细核一遍",
        intent: "再细核一遍：这一章重新对一遍前文",
        action: { toolName: "check_continuity", chapter: action.chapter, fresh: true },
      }]
    : [];
  // R4.5（验收 3.4）：确定 N 处的主修复动作挪进核账卡——按钮随「不是问题」实时变 N、intent 逐条现拼。
  // 下一步只给次要选项，不再出笼统的「改掉确定的 N 处」（那句话没圈范围，模型会把划掉的也改了）。
  const choices: NextStepChoice[] = sureCount > 0
    ? [
      { label: "我自己改", intent: "我自己改，先放着", recommended: true },
      {
        label: "预览定稿",
        intent: `预览第 ${action.chapter} 章的定稿改动`,
        action: { toolName: "commit_preview", chapter: action.chapter },
      },
      ...fresh,
    ]
    : [
      {
        label: "预览定稿",
        intent: `预览第 ${action.chapter} 章的定稿改动`,
        recommended: true,
        action: { toolName: "commit_preview", chapter: action.chapter },
      },
      {
        label: "写下一章",
        intent: "继续写下一章的正文",
        action: { toolName: "generate_draft", chapter: action.chapter + 1 },
      },
      ...fresh,
    ];
  const nextCallId = `user-action-next-${stamp}`;
  args.sendEvent("tool-call", { toolCallId: nextCallId, toolName: "suggest_next_steps", args: {} });
  args.sendEvent("tool-result", {
    toolCallId: nextCallId,
    toolName: "suggest_next_steps",
    output: { ok: true, question: sureCount > 0 ? "核账做完了，这几处怎么处理？" : "核账做完了，接下来？", choices },
  });
}

interface CommitPreviewLikeOutput {
  readonly canCommit?: unknown;
  readonly summary?: unknown;
}

/**
 * 「定稿」按钮：服务端直接跑 commit_preview（只读；可定稿时登记票据），结果按 agent 回合同款事件推给前端，
 * 前端照常渲染定稿预览卡（账本清单 + 确认定稿按钮）。收尾只回工具自己的用户可见摘要，不调模型。
 */
async function runCommitPreviewAction(args: Omit<Parameters<typeof runUserAction>[0], "action"> & {
  readonly action: Extract<UserAction, { readonly toolName: "commit_preview" }>;
}): Promise<void> {
  const { action } = args;
  const toolCallId = `user-action-commit_preview-${Date.now()}`;
  const emitText = (text: string): void => {
    const scrubbed = args.scrubber.push(text);
    if (scrubbed) args.sendEvent("text-delta", { text: scrubbed });
  };
  const flush = (): void => {
    const rest = args.scrubber.flush();
    if (rest) args.sendEvent("text-delta", { text: rest });
  };
  args.sendEvent("tool-call", { toolCallId, toolName: "commit_preview", args: { chapter: action.chapter } });
  let output: unknown;
  try {
    output = await args.executeTool("commit_preview", { chapter: action.chapter }, args.requestContext);
  } catch (error) {
    const message = args.scrubError(error);
    args.sendEvent("tool-error", { toolCallId, toolName: "commit_preview", error: message, retryable: true });
    emitText(`第 ${action.chapter} 章的定稿预览没生成出来：${humanizeToolNames(message)}。可以再点一次「定稿」。`);
    flush();
    return;
  }
  args.sendEvent("tool-result", { toolCallId, toolName: "commit_preview", output });
  const result = output as CommitPreviewLikeOutput | undefined;
  const summary = typeof result?.summary === "string" && result.summary.trim()
    ? result.summary.trim()
    : result?.canCommit === true ? `第 ${action.chapter} 章可以定稿。` : `第 ${action.chapter} 章暂时不能定稿。`;
  emitText(humanizeToolNames(summary));
  flush();
}

interface PruneLikeOutput {
  readonly ok?: unknown;
  readonly summary?: unknown;
}

/** 「确认裁剪」按钮：服务端直接真裁（带用户确认标记），结果按 agent 回合同款事件推给前端。 */
async function runPruneAction(args: Omit<Parameters<typeof runUserAction>[0], "action"> & {
  readonly action: Extract<UserAction, { readonly toolName: "prune_snapshots" }>;
}): Promise<void> {
  const { action } = args;
  const toolCallId = `user-action-prune_snapshots-${Date.now()}`;
  const input = { confirm: true, ...(action.keep ? { keep: action.keep } : {}) };
  const emitText = (text: string): void => {
    const scrubbed = args.scrubber.push(text);
    if (scrubbed) args.sendEvent("text-delta", { text: scrubbed });
  };
  const flush = (): void => {
    const rest = args.scrubber.flush();
    if (rest) args.sendEvent("text-delta", { text: rest });
  };
  args.sendEvent("tool-call", { toolCallId, toolName: "prune_snapshots", args: input });
  let output: unknown;
  markUserConfirmedTool(args.requestContext, "prune_snapshots");
  try {
    output = await args.executeTool("prune_snapshots", input, args.requestContext);
  } catch (error) {
    const message = args.scrubError(error);
    args.sendEvent("tool-error", { toolCallId, toolName: "prune_snapshots", error: message, retryable: true });
    emitText(`裁剪操作历史没有完成：${message}。历史没有被改动，可以再点一次「确认裁剪」重试。`);
    flush();
    return;
  } finally {
    markUserConfirmedTool(args.requestContext, undefined);
  }
  args.sendEvent("tool-result", { toolCallId, toolName: "prune_snapshots", output });
  const result = output as PruneLikeOutput | undefined;
  const summary = typeof result?.summary === "string" && result.summary.trim()
    ? result.summary.trim()
    : result?.ok === true ? "操作历史已裁剪。" : "操作历史没有裁剪。";
  emitText(summary);
  flush();
}

interface GenerateDraftLikeOutput {
  readonly ok?: unknown;
  readonly summary?: unknown;
}

/** 「写这一章」按钮：服务端直接出稿（正文照常经 draft-delta 流进稿纸），结果按 agent 回合同款事件推给前端，再给下一步选项。 */
async function runGenerateDraftAction(args: Omit<Parameters<typeof runUserAction>[0], "action"> & {
  readonly action: Extract<UserAction, { readonly toolName: "generate_draft" }>;
}): Promise<void> {
  const { action } = args;
  const stamp = Date.now();
  const toolCallId = `user-action-generate_draft-${stamp}`;
  const emitText = (text: string): void => {
    const scrubbed = args.scrubber.push(text);
    if (scrubbed) args.sendEvent("text-delta", { text: scrubbed });
  };
  const input = { chapter: action.chapter, ...(action.chapterGoal ? { chapterGoal: action.chapterGoal } : {}) };
  args.sendEvent("tool-call", { toolCallId, toolName: "generate_draft", args: input });
  let output: unknown;
  try {
    output = await args.executeTool("generate_draft", input, args.requestContext);
  } catch (error) {
    const message = args.scrubError(error);
    args.sendEvent("tool-error", { toolCallId, toolName: "generate_draft", error: message, retryable: true });
    emitText(`第 ${action.chapter} 章没写成：${message}。原来的稿子没动，可以再点一次「写这一章」。`);
    const rest = args.scrubber.flush();
    if (rest) args.sendEvent("text-delta", { text: rest });
    return;
  }
  args.sendEvent("tool-result", { toolCallId, toolName: "generate_draft", output });
  const result = output as GenerateDraftLikeOutput | undefined;
  const written = result?.ok === true;
  emitText(typeof result?.summary === "string" && result.summary.trim()
    ? humanizeToolNames(result.summary.trim())
    : written ? `第 ${action.chapter} 章写好了，在工作稿里。` : `第 ${action.chapter} 章没写成，原来的稿子没动。`);
  const rest = args.scrubber.flush();
  if (rest) args.sendEvent("text-delta", { text: rest });
  const choices: NextStepChoice[] = written
    ? [
      {
        label: "预览定稿",
        intent: `预览第 ${action.chapter} 章的定稿改动`,
        recommended: true,
        action: { toolName: "commit_preview", chapter: action.chapter },
      },
      // 写完已经核过一遍账（结果记在核账记忆里），点这个直接出核账卡，不再调模型。
      { label: "看核账结果", intent: "核账", action: { toolName: "check_continuity", chapter: action.chapter } },
      { label: "我自己改", intent: "我自己改，先放着" },
    ]
    : [{
        label: "再写一次",
        intent: "写这一章的正文",
        recommended: true,
        action: { toolName: "generate_draft", chapter: action.chapter },
      }];
  const nextCallId = `user-action-next-${stamp}`;
  args.sendEvent("tool-call", { toolCallId: nextCallId, toolName: "suggest_next_steps", args: {} });
  args.sendEvent("tool-result", {
    toolCallId: nextCallId,
    toolName: "suggest_next_steps",
    output: { ok: true, question: written ? `第 ${action.chapter} 章写好了，接下来？` : `第 ${action.chapter} 章没写成，接下来？`, choices },
  });
}
