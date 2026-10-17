/**
 * 用户结构化动作（2026-10-07 拆补丁塔）：界面按钮（定稿预览卡 / 建议条「确认定稿」）发来的明确指令，
 * 服务端直接执行对应工具，不经模型判断——按钮点击本身就是授权，不再用正则去猜用户原话。
 *
 * 事件协议与 agent 回合完全一致（tool-call / tool-result / text-delta），前端投影零分叉：
 * 入库 delta 卡、撤销快照、草稿以 committed 态载入都照旧走。收尾文本与下一步选项确定性生成，不调模型。
 */
import type { RequestContext } from "@mastra/core/di";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { applyLedgerDecisions, MAX_DECISIONS_PER_CHANGE } from "./ledger-decisions.js";
import { buildProtagonistRenameSuggestion } from "./protagonist-rename-suggestion.js";
import { markUserConfirmedTool } from "./request-context.js";

/** 允许经按钮直接执行的工具（白名单；新增前想清楚它是否真需要绕过模型）。 */
export const USER_ACTION_TOOL_NAMES = ["commit_apply", "prune_snapshots", "check_continuity", "commit_preview", "generate_draft"] as const;
export type UserActionToolName = (typeof USER_ACTION_TOOL_NAMES)[number];
/** 不走工具、服务端直接执行的作者命令（重构 P3：「确认改账」= 记作者裁定）。 */
const DIRECT_ACTION_NAMES = ["ledger_decision"] as const;

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
  | { readonly toolName: "generate_draft"; readonly chapter: number; readonly chapterGoal?: string }
  /**
   * 「确认改账」按钮（重构 P3）：manage_ledger 提的裁定草案原样带回，服务端按作者档命令记下（幂等键 = key）。
   * decisions 在服务端执行前逐条按裁定 schema 校验。
   */
  | { readonly toolName: "ledger_decision"; readonly key: string; readonly decisions: readonly unknown[]; readonly label?: string };

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
  if (typeof toolName !== "string" || ![...USER_ACTION_TOOL_NAMES, ...DIRECT_ACTION_NAMES].includes(toolName as never)) {
    return { kind: "invalid", reason: "不支持的操作。" };
  }
  if (toolName === "ledger_decision") {
    const key = typeof record.key === "string" ? record.key.trim() : "";
    if (!key || key.length > 120) return { kind: "invalid", reason: "改账按钮缺少有效标识。" };
    if (!Array.isArray(record.decisions) || record.decisions.length === 0 || record.decisions.length > MAX_DECISIONS_PER_CHANGE) {
      return { kind: "invalid", reason: "改账内容不对。" };
    }
    const label = typeof record.label === "string" ? record.label.trim().slice(0, 80) : "";
    return { kind: "action", action: { toolName: "ledger_decision", key, decisions: record.decisions, ...(label ? { label } : {}) } };
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

/**
 * 已定稿章号（只列 chapters/ 目录名，不读文件内容）。目录读不到（老书/异常）→ 空数组，调用方按旧口径 N+1 兜底。
 * 纯 readdir，一次目录扫描，代价可忽略。
 */
export async function readCommittedChapterNumbers(projectDir: string): Promise<readonly number[]> {
  const files = await readdir(join(projectDir, "chapters")).catch(() => [] as string[]);
  const numbers: number[] = [];
  for (const file of files) {
    const match = /^(\d{4})\.md$/u.exec(file);
    if (match?.[1]) {
      const chapter = Number(match[1]);
      if (Number.isInteger(chapter) && chapter > 0) numbers.push(chapter);
    }
  }
  return numbers;
}

/**
 * 写作前沿章（R7.7·报告 4.2）：第 N 章之后第一个还没定稿的章；N 之后全都定稿了就是 N+1（旧口径）。
 * 重新定稿旧章（比如回到第 3 章改，第 4、5 章早定稿了）后，旧代码推荐「写第 4 章」会把作者拽回
 * 早就写完的旧章——正确推荐是接着写没定稿的那章（第 6 章）。从 N+1 起找而不是从 1 起找：
 * 「第一个没定稿的章」常常正是手头这本草稿（核账/出稿都在未定稿章上做），不能推荐回去重写它。
 * 纯确定性计算（扫定稿文件名），不猜说法。
 */
export function nextDraftChapterAfter(chapter: number, committed: readonly number[]): number {
  const set = new Set(committed.filter((n) => Number.isInteger(n) && n > 0));
  let next = Math.max(1, Math.trunc(chapter)) + 1;
  while (set.has(next)) next += 1;
  return next;
}

/**
 * 定稿动作收尾的下一步选项（确定性）：成功 → 写下一章（+线索堆积时清理）；未成 → 重新预览。
 * nextDraftChapter（R7.7）：推荐写的「下一章」默认还是 N+1（旧行为，无书目录信息时），
 * 有书目录时由调用方传写作前沿章（第一个没定稿的章），重定旧章后不再推荐回去写旧章。
 */
export function commitApplyNextSteps(
  chapter: number,
  output: CommitApplyLikeOutput | undefined,
  nextDraftChapter: number = chapter + 1,
): { readonly question: string; readonly choices: readonly NextStepChoice[] } {
  if (output?.committed === true) {
    return {
      question: `第 ${chapter} 章定稿了，接下来？`,
      choices: [
        {
          label: `写第 ${nextDraftChapter} 章`,
          intent: `继续写第 ${nextDraftChapter} 章的正文`,
          recommended: true,
          action: { toolName: "generate_draft", chapter: nextDraftChapter },
        },
        ...(output.threadMaintenanceHint === "escalated"
          ? [{ label: "归并线索", intent: "看看开着的线索里有没有讲同一件事的，提一份归并方案给我确认" }]
          : []),
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

/** 写作前沿章（R7.7）：有书目录时按定稿文件现算；没传目录/读不到定稿章 → N+1 旧口径兜底。 */
async function resolveNextDraftChapter(projectDir: string | undefined, chapter: number): Promise<number> {
  if (!projectDir) return chapter + 1;
  const committed = await readCommittedChapterNumbers(projectDir);
  return committed.length > 0 ? nextDraftChapterAfter(chapter, committed) : chapter + 1;
}

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
  /** 项目目录（编辑部 R4.6 建议项用：定稿后判占位主角卡要不要给改名建议）；缺省不给建议，行为不变。 */
  readonly projectDir?: string;
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
  if (action.toolName === "ledger_decision") {
    await runLedgerDecisionAction({ ...args, action });
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

  const nextSteps = commitApplyNextSteps(action.chapter, result, await resolveNextDraftChapter(args.projectDir, action.chapter));
  // 编辑部 R4.6 建议项（只追加选项，不动上面 commitApplyNextSteps 的生成逻辑）：定稿成功后，主角卡
  // 还是开书占位、已定稿声明里有出场最多的真名 → 多给一个「把主角卡改成『X』」。只是建议：作者点了
  // 才把 intent 发给模型，由模型走 foundation_write 改名（可撤销）；建议判不了/判挂了按无建议处理。
  const renameSuggestion = result?.committed === true && args.projectDir
    ? await buildProtagonistRenameSuggestion(args.projectDir, action.chapter).catch(() => undefined)
    : undefined;
  const choices = renameSuggestion
    ? [...nextSteps.choices, { label: renameSuggestion.label, intent: renameSuggestion.intent }]
    : nextSteps.choices;
  const nextCallId = `user-action-next-${stamp}`;
  args.sendEvent("tool-call", { toolCallId: nextCallId, toolName: "suggest_next_steps", args: {} });
  args.sendEvent("tool-result", {
    toolCallId: nextCallId,
    toolName: "suggest_next_steps",
    output: { ok: true, question: nextSteps.question, choices },
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
    // 写下一章推荐写作前沿章（R7.7）：在旧章上核账时不再推荐回去重写 N+1 旧章。
    const nextDraftChapter = await resolveNextDraftChapter(args.projectDir, action.chapter);
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
            action: { toolName: "generate_draft", chapter: nextDraftChapter },
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
        // 写作前沿章（R7.7）：在旧章上核账时不再推荐回去重写 N+1 旧章。
        action: { toolName: "generate_draft", chapter: await resolveNextDraftChapter(args.projectDir, action.chapter) },
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

/** 「确认改账」：作者点了按钮，按作者档命令记下裁定（改前存档、点两次只记一次），回执照实说。 */
async function runLedgerDecisionAction(args: Omit<Parameters<typeof runUserAction>[0], "action"> & {
  readonly action: Extract<UserAction, { readonly toolName: "ledger_decision" }>;
}): Promise<void> {
  const { action } = args;
  const toolCallId = `user-action-manage_ledger-${Date.now()}`;
  const emitText = (text: string): void => {
    const scrubbed = args.scrubber.push(text);
    if (scrubbed) args.sendEvent("text-delta", { text: scrubbed });
    const rest = args.scrubber.flush();
    if (rest) args.sendEvent("text-delta", { text: rest });
  };
  args.sendEvent("tool-call", { toolCallId, toolName: "manage_ledger", args: { op: "confirm" } });
  if (!args.projectDir) {
    const message = "没改账：没拿到书的位置，请重新打开这本书再点。";
    args.sendEvent("tool-result", { toolCallId, toolName: "manage_ledger", output: { ok: false, op: "confirm", summary: message } });
    emitText(message);
    return;
  }
  let outcome: Awaited<ReturnType<typeof applyLedgerDecisions>>;
  try {
    outcome = await applyLedgerDecisions(args.projectDir, { key: action.key, decisions: action.decisions, ...(action.label ? { label: action.label } : {}) });
  } catch (error) {
    const message = args.scrubError(error);
    args.sendEvent("tool-error", { toolCallId, toolName: "manage_ledger", error: message, retryable: true });
    emitText(`没改账：${message}。可以再点一次「确认改账」重试。`);
    return;
  }
  args.sendEvent("tool-result", {
    toolCallId,
    toolName: "manage_ledger",
    // 带上改前的撤销点：界面把这一步登记成一个可撤销的回合，「撤销上一步」只撤这次改账。
    output: { ok: outcome.ok, op: "confirm", summary: outcome.summary, refreshScope: "full", ...(outcome.snapshotId ? { snapshotId: outcome.snapshotId } : {}) },
  });
  emitText(outcome.summary);
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
  // R7.1 结构化意图标记：按钮/选项点击本身就是写作授权。generate_draft 工具的写作意图门
  // （防定稿后自主续写）见此标记优先放行，不赌回显文案命中正向词表。标记只在本次执行期间存在，
  // 结束即清（与 prune 同款）；本通道不跑模型，不存在模型调用蹭标记的窗口。
  markUserConfirmedTool(args.requestContext, "generate_draft");
  try {
    output = await args.executeTool("generate_draft", input, args.requestContext);
  } catch (error) {
    const message = args.scrubError(error);
    args.sendEvent("tool-error", { toolCallId, toolName: "generate_draft", error: message, retryable: true });
    emitText(`第 ${action.chapter} 章没写成：${message}。原来的稿子没动，可以再点一次「写这一章」。`);
    const rest = args.scrubber.flush();
    if (rest) args.sendEvent("text-delta", { text: rest });
    return;
  } finally {
    markUserConfirmedTool(args.requestContext, undefined);
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
