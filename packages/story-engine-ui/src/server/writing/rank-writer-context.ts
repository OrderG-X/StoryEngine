import { type WriterContextEnvelope, estimateTokens } from "./context-gateway.js";

// 超预算时整段让出的顺序。远期摘要（timeline_earlier_summary）原来不在表里、永远不让，
// 超了先丢的却是近几章事件——远的留着、近的丢掉，顺序反了（2026-10-10 引擎升级第 4 期）。
const DEFAULT_DROP_ORDER = [
  "story_calendar",
  "timeline_earlier_summary",
  "timeline_events",
  "world_state",
  "arc_goals",
  "story_threads",
  "hook_tracking",
  "hook_pool",
  "story_continuity",
] as const;

// 上一章正文（已定稿 previous_chapter / 未定稿 previous_uncommitted_draft）是接着写的真值源，永不裁
// （2026-10-08 十章验收：写手只看摘要时物件状态、人物位置逐章漂移）。
// 章纲（chapter_plan）与按章纲翻出的旧章原文（earlier_passages）同理：是「这章写什么、前面怎么写的」本身。
const PROTECTED_DYNAMIC_SECTIONS = new Set([
  "chapter_goal",
  "chapter_plan",
  "earlier_passages",
  "previous_chapter",
  "previous_uncommitted_draft",
  "writing_context_pack",
  "character_state",
]);
const CORE_IMPACT_SECTIONS = new Set(["story_continuity"]);
// 12k → 15k：给上一章正文（约 2.5–3.5k token）腾位置，不挤掉原有的线索/伏笔段。
export const DEFAULT_TOKEN_BUDGET = 15_000;

/**
 * 生产出稿路径用：把"用户/路由没显式给预算"解析成默认预算 DEFAULT_TOKEN_BUDGET，
 * 让 Phase 0/1 的 dynamic 裁剪在真实写作里真正生效（修审计洞①：生产路径恒 no-op 的总放大器）。
 * 显式值（含 0，表示极限裁剪）原样尊重——不被 ?? 吞成默认。
 * 注意：纯函数 rankWriterContext / makeWriterRankContext 仍保持"undefined=no-op"契约不变
 * （Phase 0 受控破例①的字节级零行为保证、便于测试与显式 opt-out），默认预算只在调用方这里显式取。
 */
export function resolveWriterTokenBudget(explicit?: number): number {
  return explicit ?? DEFAULT_TOKEN_BUDGET;
}

export interface WriterContextBudgetOptions {
  readonly tokenBudget?: number;
  readonly dropOrder?: readonly string[];
}

export interface DroppedWriterContextSection {
  readonly name: string;
  readonly reason: "budget" | "low-relevance" | "compacted";
  readonly coreImpact: boolean;
}

export interface WriterContextBudgetResult {
  readonly envelope: WriterContextEnvelope;
  readonly dropped: readonly DroppedWriterContextSection[];
  readonly coreImpact: boolean;
  readonly issues: readonly string[];
}

export interface WriterRankContextPlan {
  readonly rankContext: (envelope: WriterContextEnvelope) => WriterContextEnvelope;
  readonly droppedSections: readonly string[];
  readonly droppedDetails: readonly DroppedWriterContextSection[];
  readonly coreImpact: boolean;
  readonly issues: readonly string[];
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * 可降级段（R5 线索精筛）：超预算时不整段裁掉，先砍 staleWarnings + 冗余 recentlyTouched，
 * 留真线索前 N + carryForward——治长篇线索/弧目标/伏笔被整段丢、AI 看不到的隐患。段内已被引擎
 * 按优先级排序，取前 N 即取最相关，无需额外打分。content 结构异常时各字段安全降级为空。
 */
const SECTION_COMPACTORS: Readonly<Record<string, (content: unknown) => unknown>> = {
  story_threads: (content) => {
    const c = (content ?? {}) as Record<string, unknown>;
    return {
      openLeads: asArray(c.openLeads).slice(0, 3),
      openIntents: asArray(c.openIntents).slice(0, 3),
      recentlyTouchedThreads: [], // 与 openLeads/openIntents 冗余，降级砍掉
      staleThreadWarnings: [], // 低价值「X 章没碰」提醒，降级砍掉（字段保留为空，下游渲染安全）
      threadCarryForwardInstruction: asString(c.threadCarryForwardInstruction),
    };
  },
  arc_goals: (content) => {
    const c = (content ?? {}) as Record<string, unknown>;
    return {
      activeGoals: asArray(c.activeGoals).slice(0, 2),
      recentlyTouchedGoals: [],
      staleGoalWarnings: [],
      arcCarryForwardInstruction: asString(c.arcCarryForwardInstruction),
    };
  },
  hook_tracking: (content) => {
    const c = (content ?? {}) as Record<string, unknown>;
    return {
      activeHooks: asArray(c.activeHooks).slice(0, 4),
      recentlyTouchedHooks: [],
      staleHookWarnings: [],
      hookCarryForwardInstruction: asString(c.hookCarryForwardInstruction),
    };
  },
};

export function rankWriterContext(
  envelope: WriterContextEnvelope,
  opts: WriterContextBudgetOptions = {},
): WriterContextBudgetResult {
  if (opts.tokenBudget === undefined) return { envelope, dropped: [], coreImpact: false, issues: [] };

  const budget = Math.max(0, Math.trunc(opts.tokenBudget));
  const dynamicSections = envelope.sections.filter((section) => section.cachePolicy !== "stable");
  let dynamicTokenEstimate = dynamicSections.reduce((sum, section) => sum + section.tokenEstimate, 0);
  if (dynamicTokenEstimate <= budget) return { envelope, dropped: [], coreImpact: false, issues: [] };
  const protectedTokenEstimate = dynamicSections
    .filter((section) => PROTECTED_DYNAMIC_SECTIONS.has(section.name))
    .reduce((sum, section) => sum + section.tokenEstimate, 0);
  const coreOverBudget = protectedTokenEstimate > budget;

  const dropCandidates = rankDropCandidates(
    dynamicSections
      .filter((section) => !PROTECTED_DYNAMIC_SECTIONS.has(section.name))
      .map((section) => section.name),
    opts.dropOrder ?? DEFAULT_DROP_ORDER,
  );
  const dropped: DroppedWriterContextSection[] = [];
  const droppedSet = new Set<string>();
  // 工作副本：降级会替换其中的 section（content 精简、token 重算），整删只在阶段 2 从结果里移除。
  const working = [...envelope.sections];

  // 阶段 1（R5 线索精筛）：对可降级段先 compact（砍 staleWarnings/冗余、留真线索+carryForward），
  // token 大降；回到预算内就停，threads/arc/hook 得以精简保留而非被整段裁掉。
  for (const name of dropCandidates) {
    if (dynamicTokenEstimate <= budget) break;
    const compactor = SECTION_COMPACTORS[name];
    if (!compactor) continue;
    const idx = working.findIndex((item) => item.name === name);
    if (idx < 0) continue;
    const current = working[idx];
    const newContent = compactor(current.content);
    const newToken = estimateTokens(newContent);
    if (newToken >= current.tokenEstimate) continue; // 没省到就不降级
    working[idx] = { ...current, content: newContent, tokenEstimate: newToken };
    dynamicTokenEstimate -= current.tokenEstimate - newToken;
    dropped.push({ name, reason: "compacted", coreImpact: false });
  }

  // 阶段 2：仍超 → 按 DROP_ORDER 整删（降级段此时已变小、排在 calendar/timeline 之后，多半不必删）。
  for (const name of dropCandidates) {
    if (dynamicTokenEstimate <= budget) break;
    const section = working.find((item) => item.name === name);
    if (!section || droppedSet.has(name)) continue;
    // 该段若先前降级过，最终既然整删 → 移除其 compacted 记录，避免一段两条记录。
    const compactedIdx = dropped.findIndex((item) => item.name === name && item.reason === "compacted");
    if (compactedIdx >= 0) dropped.splice(compactedIdx, 1);
    dropped.push({ name, reason: "budget", coreImpact: CORE_IMPACT_SECTIONS.has(name) });
    droppedSet.add(name);
    dynamicTokenEstimate -= section.tokenEstimate;
  }

  const coreImpact = coreOverBudget || dropped.some((item) => item.coreImpact);
  const issues = coreOverBudget
    ? [`本章上下文超预算（核心 ${protectedTokenEstimate} > 预算 ${budget}），已尽量保核心、挤出非核心，仍超 ${Math.max(0, dynamicTokenEstimate - budget)}。`]
    : [];

  if (dropped.length === 0) return { envelope, dropped, coreImpact, issues };

  const sections = working.filter((section) => !droppedSet.has(section.name));
  return {
    envelope: {
      ...envelope,
      sections,
      trace: rebuildTrace(envelope, sections),
    },
    dropped,
    coreImpact,
    issues,
  };
}

export function makeWriterRankContext(opts: WriterContextBudgetOptions = {}): WriterRankContextPlan {
  const droppedSections: string[] = [];
  const droppedDetails: DroppedWriterContextSection[] = [];
  const issues: string[] = [];
  let coreImpact = false;
  return {
    rankContext: (envelope) => {
      const result = rankWriterContext(envelope, opts);
      droppedSections.push(...result.dropped.map((item) => item.name));
      droppedDetails.push(...result.dropped);
      issues.push(...result.issues);
      coreImpact = coreImpact || result.coreImpact;
      return result.envelope;
    },
    get droppedSections() {
      return [...droppedSections];
    },
    get droppedDetails() {
      return [...droppedDetails];
    },
    get coreImpact() {
      return coreImpact;
    },
    get issues() {
      return [...issues];
    },
  };
}

export function contextBudgetPayload(input: WriterRankContextPlan | readonly string[]): {
  readonly droppedSections: readonly string[];
  readonly droppedDetails?: readonly DroppedWriterContextSection[];
  readonly coreImpact?: boolean;
  readonly issues?: readonly string[];
} {
  if (isDroppedSectionNames(input)) return { droppedSections: [...input] };
  return {
    droppedSections: [...input.droppedSections],
    ...(input.droppedDetails.length > 0 ? { droppedDetails: input.droppedDetails } : {}),
    ...(input.coreImpact ? { coreImpact: true } : {}),
    ...(input.issues.length > 0 ? { issues: input.issues } : {}),
  };
}

function isDroppedSectionNames(input: WriterRankContextPlan | readonly string[]): input is readonly string[] {
  return Array.isArray(input);
}

function rankDropCandidates(names: readonly string[], dropOrder: readonly string[]): readonly string[] {
  const candidates = new Set(names);
  const ordered = dropOrder.filter((name) => candidates.delete(name));
  const unordered = names.filter((name) => candidates.has(name));
  const ranked = [...ordered, ...unordered];
  return [
    ...ranked.filter((name) => name !== "story_continuity"),
    ...ranked.filter((name) => name === "story_continuity"),
  ];
}

function rebuildTrace(
  envelope: WriterContextEnvelope,
  sections: WriterContextEnvelope["sections"],
): WriterContextEnvelope["trace"] {
  const totalTokenEstimate = sections.reduce((sum, section) => sum + section.tokenEstimate, 0);
  const stableTokenEstimate = sections
    .filter((section) => section.cachePolicy === "stable")
    .reduce((sum, section) => sum + section.tokenEstimate, 0);
  return {
    ...envelope.trace,
    sectionNames: sections.map((section) => section.name),
    totalTokenEstimate,
    stableTokenEstimate,
    dynamicTokenEstimate: totalTokenEstimate - stableTokenEstimate,
  };
}
