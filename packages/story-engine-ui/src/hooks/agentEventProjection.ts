/**
 * agentEventProjection — 把 Mastra 写作 agent 的流式事件（text-delta / tool-call /
 * tool-result / tool-error）增量投影成**一条 assistant ChapterMessage**。
 *
 * 纯函数、无副作用、无 React 依赖：每次接收 (当前消息, 一个事件) → 返回新消息。
 * 由 useChat 在 streamAgentChat 的回调里逐事件喂入，增量 updateMessage 渲染。
 *
 * 设计要点：
 * - text-delta 累加进 content（顺序拼接）。
 * - tool-call 开始时 push 一个 toolSteps{ id=toolCallId, status:"running", startedAt }，
 *   并（对已知工具）push 一张 agentCards{ status:"running" }，其 agentName 必须命中
 *   components/v2/agentTimelineModel.ts 的 agentDisplayLabel 字典，这样 AiChatCodex
 *   经 buildTimelineModel 零改就能渲染。
 * - tool-result 把对应 step / card 置 completed + endedAt；tool-error 置 failed（绝不静默失败）。
 *
 * 工具 → agent 名映射（与后端工具 id 对齐，命中 agentDisplayLabel 的 byAgentName）：
 *   read_state_overview → stateOverviewReader（显示「资料助手」）
 *   foundation_write    → foundationAgent（显示「资料助手」）
 * 未知工具仍 push 一个带可读标签的 toolStep（保证不静默、不崩），但不强造一张可能误导的卡。
 */
import type { ChapterAgentCard, ToolStep } from "../api/types.js";
import type { ChapterMessage, AiFlavorReport, MessageSegment } from "../types.js";

export type AgentRefreshScope = "full" | "foundation";

export interface AgentToolResultOutput {
  /**
   * 写类/出稿工具的统一诚实成功标志：false = 引擎拒绝/出稿失败/未写入/需确认。
   * 前端据此把时间线步骤置 failed，**不被 agent 文本可能的「已完成」幻觉盖过**（结构性防谎报），
   * 并据此决定是否挂「撤销到此」/染「影响范围」徽标（ok===false 的回合不挂、不染）。
   * 所有写类工具都已带 ok（foundation_write=applied、commit_apply=committed、
   * generate_draft/revise_draft=出稿/改写是否通过）；读类工具无此字段（undefined）→ 视为完成、不受影响。
   */
  readonly ok?: boolean;
  /**
   * 写类工具因「需用户确认」被挡下（如删除角色未确认）。为 true 时步骤显示「待确认」（暖色），
   * 而非「失败」（红）——语义是 pending、不是 error。优先级高于 ok===false。
   */
  readonly needsConfirmation?: boolean;
  /**
   * 写成功但有「要删/改的目标没命中」的部分纠错失败（如『改某条』旧原文差字没删成、新值已加）。
   * 为 true 时步骤显示「部分完成」（琥珀色 attention，不是绿色 completed）——结构性防谎报不让
   * 部分失败显示成全成功（修#1）。优先级低于 needsConfirmation / ok===false。
   */
  readonly partialMiss?: boolean;
  /** 诚实背书粒度（agentChatClient 透传；与服务端 honesty-detection stepBacksWriteClaim 认的字段名对齐）：
   *  prune_snapshots 的 dryRun（true=预览没落盘不背书）/ manage_style_exemplars 的 action
   *  （list 只读不背书；写背书只认 add/update/remove）。累加进 toolStep 供回合收尾的诚实探针判定。 */
  readonly dryRun?: boolean;
  readonly action?: string;
  readonly summary?: string;
  readonly issues?: readonly string[];
  readonly overview?: unknown;
  readonly refreshScope?: AgentRefreshScope;
  readonly snapshotId?: string;
  /** 写类/出稿工具实际操作的章号（agentChatClient 透传）。回写进 turnSnapshots，供「撤销到此回合」写回被撤销回合实际操作的章（治单聊天走天涯后在第5章撤销属于第1章的回合错写到第5章）。 */
  readonly chapter?: number;
  /** check_ai_flavor 专属：体检报告（agentChatClient 透传）。投影时挂到该消息→时间线渲染体检卡。 */
  readonly aiFlavorReport?: AiFlavorReport;
  /** ai_review 专属：审稿报告（agentChatClient 透传）。投影时挂到该消息→渲染「审校问题清单」可点卡。 */
  readonly draftReview?: ChapterMessage["draftReview"];
  /** suggest_next_steps 专属：agent 提议的下一步选项（agentChatClient 透传）。投影时挂到该消息→驱动「下一步」卡。 */
  readonly nextStepPrompt?: ChapterMessage["nextStepPrompt"];
  /** commit_apply 专属：入库报告 CommitReport（agentChatClient 透传）。投影时挂到该消息→渲染「入库」delta 卡。 */
  readonly commitReport?: ChapterMessage["commitReport"];
  /** quality_check 专属：分层质检报告（agentChatClient 透传）。投影时挂到该消息→渲染「质检」明细卡。 */
  readonly qualityReport?: ChapterMessage["qualityReport"];
  /** commit_preview 专属：人物名一致性提醒（agentChatClient 透传）。投影时挂到该消息→渲染固定「人物名一致性」提醒卡。 */
  readonly nameConsistencyWarnings?: ChapterMessage["nameConsistencyWarnings"];
  /** commit_preview 专属：伏笔/线索待收口提醒（agentChatClient 透传）。投影时挂到该消息→渲染固定「伏笔/线索待收口」提醒卡。 */
  readonly staleThreadWarnings?: ChapterMessage["staleThreadWarnings"];
}

export type AgentProjectionEvent =
  | { readonly type: "text-delta"; readonly text: string }
  | { readonly type: "reasoning-delta"; readonly text: string }
  | { readonly type: "tool-call"; readonly toolCallId: string; readonly toolName: string; readonly startedAt: number }
  | {
      readonly type: "tool-result";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly endedAt: number;
      readonly output?: AgentToolResultOutput;
    }
  | {
      readonly type: "tool-error";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly endedAt: number;
      readonly error: string;
    };

interface ToolPresentation {
  readonly stepLabel: string;
  /** 命中 agentDisplayLabel 字典的卡（已知工具才有）；未知工具为 null（只出步骤不出卡）。 */
  readonly card: { readonly kind: ChapterAgentCard["kind"]; readonly agentName: string; readonly title: string } | null;
}

/**
 * 工具 id → 时间线展示。stepLabel 是动作块「块体详情」里这一步的人话标签，
 * 对照 packages/story-engine/src/agent-capabilities.ts 的 label（只读不改它），
 * **覆盖 story-agent.ts 注册的全部 32 个工具**——时间线里「调用工具 · XX」一律说中文，
 * 不让任何工具回退到生硬的「执行 generate_worldbuilding」之类英文（与整套中文 UI 对不齐）。
 * 新增工具务必在这里补一行中文标签；漏了才会落到 presentationFor 的英文兜底。
 *
 * card 只给 read_state_overview / foundation_write 两个保留——它们的 agentName 命中
 * agentTimelineModel.agentDisplayLabel 的 byAgentName，能正确渲染成「资料助手」卡；
 * 其余工具 card:null（只出可读步骤、不强造一张可能误导的卡）。
 */
const TOOL_PRESENTATION: Record<string, ToolPresentation> = {
  // 读取簇
  read_state_overview: {
    stepLabel: "查看当前进度",
    card: { kind: "foundation", agentName: "stateOverviewReader", title: "查看当前进度" },
  },
  read_chapters_overview: { stepLabel: "读取章节概览", card: null },
  read_timeline: { stepLabel: "读取时间线", card: null },
  read_foundation: { stepLabel: "查看故事资料", card: null },
  read_draft: { stepLabel: "读取草稿原文", card: null },
  // 写资料
  foundation_write: {
    stepLabel: "更新故事资料",
    card: { kind: "foundation", agentName: "foundationAgent", title: "更新故事资料" },
  },
  // 做厚资料簇
  generate_worldbuilding: { stepLabel: "完善世界观", card: null },
  generate_asset_enrichment: { stepLabel: "完善道具与资源", card: null },
  generate_location_enrichment: { stepLabel: "完善地点", card: null },
  generate_character_enrichment: { stepLabel: "完善角色", card: null },
  generate_matrix_enrichment: { stepLabel: "完善角色关系", card: null },
  generate_character_relationships: { stepLabel: "完善人物关系", card: null },
  generate_writing_rules_enrichment: { stepLabel: "重新整理写作规则", card: null },
  generate_alias_table: { stepLabel: "完善别名表", card: null },
  // 正文簇
  generate_chapter_steering: { stepLabel: "生成章节方向", card: null },
  generate_draft: { stepLabel: "生成正文", card: null },
  revise_draft: { stepLabel: "修改草稿", card: null },
  // 审校簇
  quality_check: { stepLabel: "硬伤检查", card: null },
  ai_review: { stepLabel: "内容审阅", card: null },
  check_ai_flavor: { stepLabel: "检查机器腔", card: null },
  // 入库簇
  commit_preview: { stepLabel: "定稿影响预览", card: null },
  commit_apply: { stepLabel: "定稿", card: null },
  // 线索与杂项簇
  edit_fact_ledger: { stepLabel: "记录故事事实", card: null },
  suggest_next_steps: { stepLabel: "建议下一步", card: null },
  set_foreshadowing_importance: { stepLabel: "调整伏笔权重", card: null },
  resolve_thread: { stepLabel: "收口单条线索", card: null },
  clean_legacy_threads: { stepLabel: "清理历史线索", card: null },
  group_related_leads: { stepLabel: "归并相关线索", card: null },
  manage_style_exemplars: { stepLabel: "管理文风样本", card: null },
  // 快照与外部簇
  undo_last_change: { stepLabel: "撤销上一改动", card: null },
  prune_snapshots: { stepLabel: "裁剪快照历史", card: null },
  web_search: { stepLabel: "联网检索资料", card: null },
};

/**
 * 只读工具集合：它们不产生任何写盘效果，故不应计入「影响范围」徽标。
 * 关键：read_state_overview 也回 refreshScope:"full"（只为让前端刷新面板），若据此染 affectedScopes
 * 会把纯问答/摸底回合误标「正文·草稿」(#2)。判据必须按「是否只读」而非「有无 snapshotId」——
 * 因为出稿工具 generate_draft/revise_draft 是「草稿待保存、不建 git 快照」，确有效果却无 snapshotId，
 * 用 snapshotId 判会误伤它们的「正文·草稿」徽标。当前只有 read_state_overview 会回 refreshScope，
 * 其余读工具本就不回 refreshScope（列全只为可读+未来稳健）。
 */
const READONLY_TOOL_NAMES = new Set<string>([
  "read_state_overview",
  "read_foundation",
  "generate_chapter_steering",
  "quality_check",
  "ai_review",
  "commit_preview",
]);

/** 工具 id → 块体步骤展示；未知工具回退到带工具名的可读标签（不静默、不崩，但不强造卡）。 */
export function presentationFor(toolName: string): ToolPresentation {
  return TOOL_PRESENTATION[toolName] ?? { stepLabel: `执行 ${toolName}`, card: null };
}

/**
 * 渲染时把工具步骤解析成中文标签：优先按 toolName 现取（presentationFor 覆盖全 32 工具），
 * 让旧历史里烤进消息的英文 label 也显示中文；极旧消息没存 toolName 时，从「执行 xxx」英文兜底
 * label 里反解出工具名再现取中文，彻底覆盖历史；都不行才回退存下的 label（不崩、不静默）。
 */
export function resolveToolStepLabel(toolName: string | undefined, label: string | undefined): string {
  if (toolName) return presentationFor(toolName).stepLabel;
  const legacy = /^执行\s+([a-z][a-z_]+)$/.exec((label ?? "").trim());
  if (legacy) return presentationFor(legacy[1]!).stepLabel;
  return label ?? "";
}

/** 起一条空的 assistant 消息，作为投影起点。 */
export function emptyAssistantMessage(id: string): ChapterMessage {
  return { id, role: "assistant", content: "" };
}

/** 纯增量投影：(当前消息, 单个事件) → 新消息。绝不原地修改入参。 */
export function projectAgentEvent(message: ChapterMessage, event: AgentProjectionEvent): ChapterMessage {
  switch (event.type) {
    case "text-delta":
      // content 仍是全量拼接（撤销/入库/classic 壳等都靠它）；segments 同步追加「正文段」（同类并尾）保留时间顺序。
      return {
        ...message,
        content: message.content + event.text,
        segments: appendTextSegment(message.segments, "text", event.text),
      };
    case "reasoning-delta":
      // 思考链增量累加到 thinking（全量）；segments 同步追加「思考段」（同类并尾），让多段思考各自跟着对话走。
      return {
        ...message,
        thinking: (message.thinking ?? "") + event.text,
        segments: appendTextSegment(message.segments, "reasoning", event.text),
      };
    case "tool-call":
      return applyToolCall(message, event);
    case "tool-result": {
      // 结构性防谎报 + 待确认：
      // - needsConfirmation===true（如删角色未确认）→「待确认」(暖色 pending，不是失败)，优先级最高。
      // - ok===false（引擎拒绝/出稿失败/未写入）→「失败」，绝不被 agent 文本「已完成」幻觉盖过。
      // - 否则「已完成」。并把真实 summary 显示在时间线上。
      // - dryRun/action（prune 只读预览 / exemplars 只读 list）随步骤累加进 toolStep，
      //   供回合收尾的诚实探针（honesty-detection stepBacksWriteClaim）按粒度判写背书。
      const status = event.output?.needsConfirmation === true
        ? "needs_confirmation"
        : event.output?.ok === false
          ? "failed"
          : event.output?.partialMiss === true
            ? "partial"
            : "completed";
      const settled = settleTool(message, event.toolCallId, status, event.endedAt, event.output?.summary, event.output);
      // 块级撤销的命门：snapshotId 已从后端流到 event.output（agentChatClient→onToolResult），
      // 这里把它（连同 refreshScope）回写到消息上，建立「回合↔git 快照」映射，供 M3 块脚「撤销到此」。
      const withEffects = recordTurnEffects(settled, event.toolName, event.output);
      // 去 AI 味体检卡随这条消息走（替代旧的全局常驻挂件，治「一直钉底部」）：把报告挂到本条消息上，
      // 在时间线里随对话滚动。ok:false（体检没成）不挂、不把失败当结果。
      if (event.toolName === "check_ai_flavor" && event.output?.aiFlavorReport && event.output.aiFlavorReport.ok !== false) {
        return { ...withEffects, aiFlavorReport: event.output.aiFlavorReport };
      }
      // AI 审稿报告随这条消息走：渲染「审校问题清单」可点卡（点一条=给 agent 发改写意图）。
      if (event.toolName === "ai_review" && event.output?.draftReview) {
        return { ...withEffects, draftReview: event.output.draftReview };
      }
      // agent 主动提议的「下一步」选项：挂到这条消息，驱动「下一步」选项卡（替代写死选项）。
      if (event.toolName === "suggest_next_steps" && event.output?.nextStepPrompt) {
        return { ...withEffects, nextStepPrompt: event.output.nextStepPrompt };
      }
      // 入库 delta：commit_apply 的 CommitReport 随消息走，渲染「入库」delta 卡（这章改了哪些角色/伏笔/线索/时间线）。
      if (event.toolName === "commit_apply" && event.output?.commitReport) {
        return { ...withEffects, commitReport: event.output.commitReport };
      }
      // 质检明细：quality_check 的分层报告随消息走，渲染「质检」明细卡（blocking 硬伤 / soft 软提示）。
      if (event.toolName === "quality_check" && event.output?.qualityReport) {
        return { ...withEffects, qualityReport: event.output.qualityReport };
      }
      // commit_preview 的两类固定提醒卡（不管模型嘴上怎么说都照实显示）可同时出现，合并挂上、别互相顶掉：
      //   · nameConsistencyWarnings：本章名字疑似把已确立角色名写歪（近形错名）。
      //   · staleThreadWarnings：伏笔/线索超 3 章没推进（埋了不收的遗漏）。
      if (event.toolName === "commit_preview") {
        return {
          ...withEffects,
          ...(event.output?.nameConsistencyWarnings?.length ? { nameConsistencyWarnings: event.output.nameConsistencyWarnings } : {}),
          ...(event.output?.staleThreadWarnings?.length ? { staleThreadWarnings: event.output.staleThreadWarnings } : {}),
        };
      }
      return withEffects;
    }
    case "tool-error":
      return settleTool(message, event.toolCallId, "failed", event.endedAt, event.error);
    default:
      return message;
  }
}

function applyToolCall(
  message: ChapterMessage,
  event: Extract<AgentProjectionEvent, { type: "tool-call" }>,
): ChapterMessage {
  const presentation = presentationFor(event.toolName);

  const step: ToolStep = {
    id: event.toolCallId,
    label: presentation.stepLabel,
    toolName: event.toolName,
    status: "running",
    startedAt: event.startedAt,
  };
  // 同一 toolCallId 不重复 push（防御重复事件）。
  const existingSteps = message.toolSteps ?? [];
  const toolSteps = existingSteps.some((s) => s.id === event.toolCallId)
    ? existingSteps
    : [...existingSteps, step];

  let agentCards = message.agentCards;
  if (presentation.card) {
    const cardId = cardIdFor(event.toolCallId);
    const existingCards = message.agentCards ?? [];
    if (!existingCards.some((c) => c.id === cardId)) {
      const card: ChapterAgentCard = {
        id: cardId,
        kind: presentation.card.kind,
        agentName: presentation.card.agentName,
        status: "running",
        title: presentation.card.title,
        summary: "",
      };
      agentCards = [...existingCards, card];
    }
  }

  // segments 追加一个「工具段」（只引用 toolCallId，详情读 toolSteps[id]）；同一 id 不重复追加。
  const existingSegments = message.segments ?? [];
  const segments = existingSegments.some((s) => s.kind === "tool" && s.toolCallId === event.toolCallId)
    ? existingSegments
    : [...existingSegments, { kind: "tool" as const, toolCallId: event.toolCallId }];

  return {
    ...message,
    toolSteps,
    segments,
    ...(agentCards ? { agentCards } : {}),
  };
}

/**
 * 把一段文本增量追加进 segments：若末段同类（reasoning/text）则并入其文本，否则新起一段。
 * 保证「连续同类事件 → 一段」「换了类型 → 换段」，忠实还原流的时间顺序。纯函数、不改入参。
 */
function appendTextSegment(
  segments: readonly MessageSegment[] | undefined,
  kind: "reasoning" | "text",
  text: string,
): readonly MessageSegment[] {
  const list = segments ?? [];
  const last = list[list.length - 1];
  if (last && last.kind === kind) {
    return [...list.slice(0, -1), { kind, text: last.text + text }];
  }
  return [...list, { kind, text }];
}

function settleTool(
  message: ChapterMessage,
  toolCallId: string,
  status: "completed" | "failed" | "needs_confirmation" | "partial",
  endedAt: number,
  summary?: string,
  output?: AgentToolResultOutput,
): ChapterMessage {
  const cardId = cardIdFor(toolCallId);
  const detail = summary?.trim();
  const toolSteps = message.toolSteps?.map((step) =>
    step.id === toolCallId
      ? {
        ...step,
        status,
        endedAt,
        ...(detail ? { detail } : {}),
        // 诚实背书粒度累加进 step（对齐服务端 honesty-detection 认的字段名）：dryRun（prune 预览
        // 不背书）/ action（exemplars 的 list 不背书）；没有这两字段的工具自然缺省、维持旧口径。
        // 缺了这层累加，exemplars add 真成功也会被回合收尾的诚实探针误判成「操作未完成」（复审 P2③）。
        ...(typeof output?.dryRun === "boolean" ? { dryRun: output.dryRun } : {}),
        ...(typeof output?.action === "string" ? { action: output.action } : {}),
      }
      : step,
  );
  // 把工具的真实 summary（成功摘要 / 失败原因）写进卡片，让用户看到引擎真实结果，而非只看 agent 文本。
  const agentCards = message.agentCards?.map((card) =>
    card.id === cardId ? { ...card, status, ...(detail ? { summary: detail } : {}) } : card,
  );
  return {
    ...message,
    ...(toolSteps ? { toolSteps } : {}),
    ...(agentCards ? { agentCards } : {}),
  };
}

/**
 * 把一次 tool-result 的回合效果回写到消息：
 * - snapshotId（写类/出稿工具写入前的 git 快照）→ 追加进 turnSnapshots（回合↔快照映射，turnSnapshots[0]=整块回退点）。
 * - refreshScope（影响范围 full/foundation）→ 去重并进 affectedScopes（块头「影响范围」徽标的数据源），
 *   **仅当该工具不是只读工具时**才计入（按 READONLY_TOOL_NAMES 判定）：只读工具 read_state_overview 也回
 *   refreshScope:"full"（只为刷新面板），若据此染色会把纯问答/摸底回合误标成「影响了正文·草稿」(#2)。
 *   产生效果的工具——generate_draft/revise_draft（refreshScope:"full"、**无** snapshotId=草稿待保存）、
 *   commit_apply（"full"+snapshotId）、foundation_write（"foundation"+snapshotId）——
 *   都不在只读集里 → 影响范围徽标照常显示。**不能用 snapshotId 判**：那会误伤无快照的出稿回合。
 * - turnSnapshots 仍按 snapshotId 写（草稿类无 snapshotId → 无「撤销到此」，是既有设计、与 affectedScopes 解耦）。
 * 纯函数、不改入参。注意：refreshScope 仍照常由 useChat 用于工作台刷新（那条路径不读 affectedScopes）。
 */
function recordTurnEffects(
  message: ChapterMessage,
  toolName: string,
  output: AgentToolResultOutput | undefined,
): ChapterMessage {
  let next = message;
  // ok===false（引擎拒绝/出稿失败/未写入/需确认）→ 本回合实际没改任何东西，
  // 既不挂「撤销到此」（否则点了把提问删掉+整页刷却啥也没撤）、也不染「影响范围」徽标（否则界面对不上）。
  // 写类工具都已带 ok（foundation_write=applied、commit_apply=committed），
  // 读类工具 ok 为 undefined（!==false）→ 不受此守卫影响，照旧逻辑（它们本就无 snapshotId、在只读集里）。
  const reallyWrote = output?.ok !== false;
  if (output?.snapshotId && reallyWrote) {
    const entry = { toolName, snapshotId: output.snapshotId, ...(typeof output.chapter === "number" ? { chapterNumber: output.chapter } : {}) };
    next = { ...next, turnSnapshots: [...(next.turnSnapshots ?? []), entry] };
  }
  // 守卫：只读工具（read_state_overview 等）即便回 refreshScope 也不计入影响范围，避免误标「正文·草稿」；
  // 出稿工具 generate_draft/revise_draft 虽无 snapshotId 但确有效果 → 不在只读集 → 徽标照常；
  // 但出稿/写入失败（ok===false）的回合不染徽标（M4：出稿被拒仍标「正文·草稿」）。
  if (output?.refreshScope && !READONLY_TOOL_NAMES.has(toolName) && reallyWrote) {
    const scopes = next.affectedScopes ?? [];
    if (!scopes.includes(output.refreshScope)) {
      next = { ...next, affectedScopes: [...scopes, output.refreshScope] };
    }
  }
  return next;
}

/**
 * 「停止」收尾结算：用户点「■」abort 了流，残留 running 的步骤/卡片结算成 stopped——
 * 不是 failed（不是工具自己失败，是人喊停），补 endedAt 让耗时落地。其余状态原样保留。
 * 纯函数、不改入参；供 useChat 回合 finally 在 clean-abort 时调用（错误路径仍走 tool-error→failed）。
 */
export function settleStoppedAgentTurn(message: ChapterMessage, endedAt: number): ChapterMessage {
  const toolSteps = message.toolSteps?.map((step) =>
    step.status === "running" ? { ...step, status: "stopped" as const, endedAt } : step);
  const agentCards = message.agentCards?.map((card) =>
    card.status === "running" ? { ...card, status: "stopped" as const } : card);
  return {
    ...message,
    ...(toolSteps ? { toolSteps } : {}),
    ...(agentCards ? { agentCards } : {}),
  };
}

function cardIdFor(toolCallId: string): string {
  return `agent-card-${toolCallId}`;
}
