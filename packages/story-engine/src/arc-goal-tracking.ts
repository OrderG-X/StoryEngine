import type { VerifiedChapterDelta } from "./chapter-delta.js";
import type { ChapterSemanticSummary } from "./commit-plan-builder.js";
import type { HookTrackingUpdate } from "./hook-tracking.js";
import type { ThreadTrackingUpdate } from "./lead-intent-tracking.js";
import { chaptersSinceTouched, shouldRemindStaleAt } from "./stale-reminder-policy.js";
import type { ArcGoal, ArcGoalPool } from "./types.js";

export interface ArcGoalUpdate {
  readonly id: string;
  readonly title: string;
  readonly status: ArcGoal["status"];
  readonly scope: ArcGoal["scope"];
  readonly firstSeenChapter: number;
  readonly lastTouchedChapter: number;
  readonly targetChapters?: number;
  readonly evidence: readonly string[];
  readonly relatedHooks?: readonly string[];
  readonly relatedThreads?: readonly string[];
  readonly relatedCharacters?: readonly string[];
  readonly relatedLocations?: readonly string[];
  readonly nextActionHint?: string;
}

export interface StaleGoalWarning {
  readonly id: string;
  readonly title: string;
  /** 目标层级：main_arc 停滞会升级提醒（主线不该长期停摆），上层展示也按层级措辞。 */
  readonly scope: ArcGoal["scope"];
  readonly lastTouchedChapter: number;
  readonly chaptersSinceTouched: number;
  readonly message: string;
}

/** 被自动蛰伏（status→stale）的阶段目标——commit report 必须如实披露，绝不静默。 */
export interface ExpiredArcGoal {
  readonly id: string;
  readonly title: string;
  readonly scope: ArcGoal["scope"];
  readonly lastTouchedChapter: number;
  readonly chaptersSinceTouched: number;
}

export interface ArcGoalTrackingPlan {
  readonly updates: readonly ArcGoalUpdate[];
  readonly introducedGoals: readonly string[];
  readonly touchedGoals: readonly string[];
  readonly completedGoals: readonly string[];
  readonly staleGoalWarnings: readonly StaleGoalWarning[];
}

const MAX_ACTIVE_MINI_ARC_GOALS = 3;
const MAX_ACTIVE_MAIN_ARC_GOALS = 1;
const MAX_EVIDENCE = 5;

/**
 * 阶段目标（非 main_arc）自动蛰伏阈值（2026-07-05 r7）：连续 15 章无推进 → status:"stale"。
 * 数据支撑（修仙 75 章真机）：健康 mini 目标每 1–2 章被 touch、已完成 mini 生命周期 ≤4 章；
 * 烂尾的「突破炼气七层瓶颈」挂了 49 章无人推进也不收口，长期霸占面板与写手上下文。
 * 蛰伏≠删除：数据仍在 arc-goals.json、面板可查；正文再写到（声明命中/标题相似）即自动复活成 touched。
 */
export const MINI_ARC_GOAL_STALE_CHAPTERS = 15;

/** 目标停滞提醒阈值（严格大于才算停滞）。 */
const GOAL_STALE_THRESHOLD = 5;

/** 主线目标停滞升级提醒阈值：idle 超过它就换更强的措辞（主线永不自动蛰伏，只升级喊话）。 */
const MAIN_ARC_ESCALATION_IDLE = 10;

/** 每章最多提醒的停滞目标条数（按停滞时长降序截断；全量底数由上层 digest 播报）。 */
const MAX_STALE_GOAL_WARNINGS = 5;

export function buildArcGoalTrackingPlan(input: {
  readonly chapter: number;
  readonly draft: string;
  readonly semanticSummary: ChapterSemanticSummary;
  readonly hookTrackingUpdates: readonly HookTrackingUpdate[];
  readonly threadTrackingUpdates: readonly ThreadTrackingUpdate[];
  readonly arcGoalPool: ArcGoalPool;
  /**
   * 已核实的章节语义声明。有 arcGoalProgress 声明（≥1 条证据校验通过）时，本章目标候选**只**由声明产出
   * （题材中立，替代修仙关键词表）；无声明时逐字段回退关键词路径，旧书旧行为一字不差（向后兼容）。
   */
  readonly verifiedDelta?: VerifiedChapterDelta;
}): ArcGoalTrackingPlan {
  // 目标只由章节语义声明产出（原句已核）。2026-10-10 引擎升级删掉了关键词兜底：那张表写死了旧测试书的三条目标
  //（「查清资源账目」等，其中一条是主线），任何书只要出现「库房」「暗号」「克扣」就会被凭空造出这些目标。
  const candidates = input.verifiedDelta && input.verifiedDelta.arcGoalProgress.length > 0
    ? arcGoalCandidatesFromDeclaration(input.arcGoalPool, input.verifiedDelta)
    : [];
  const existingById = new Map(input.arcGoalPool.goals.map((goal) => [goal.id, goal]));
  const activeMiniArcCount = input.arcGoalPool.goals
    .filter((goal) => (goal.status === "active" || goal.status === "touched") && goal.scope === "mini_arc")
    .filter((goal) => chaptersSinceTouched(goal.lastTouchedChapter, input.chapter) <= 5)
    .length;
  const activeMainArcCount = input.arcGoalPool.goals
    .filter((goal) => (goal.status === "active" || goal.status === "touched") && goal.scope === "main_arc")
    .length;
  let newMiniArcCount = 0;
  let newMainArcCount = 0;

  const updates: ArcGoalUpdate[] = [];
  for (const candidate of candidates) {
    const existing = findSimilarGoal(input.arcGoalPool.goals, candidate.title);
    if (!existing && candidate.scope === "mini_arc" && activeMiniArcCount + newMiniArcCount >= MAX_ACTIVE_MINI_ARC_GOALS) {
      continue;
    }
    if (!existing && candidate.scope === "main_arc" && activeMainArcCount + newMainArcCount >= MAX_ACTIVE_MAIN_ARC_GOALS) {
      continue;
    }
    if (!existing && candidate.scope === "mini_arc") newMiniArcCount += 1;
    if (!existing && candidate.scope === "main_arc") newMainArcCount += 1;
    updates.push(buildArcGoalUpdate({
      chapter: input.chapter,
      candidate,
      existing,
      semanticSummary: input.semanticSummary,
      hookTrackingUpdates: input.hookTrackingUpdates,
      threadTrackingUpdates: input.threadTrackingUpdates,
    }));
  }

  const uniqueUpdates = uniqueById(updates);
  const touched = new Set(uniqueUpdates.map((update) => update.id));
  return {
    updates: uniqueUpdates,
    introducedGoals: uniqueUpdates.filter((update) => !existingById.has(update.id)).map((update) => update.id),
    touchedGoals: [...touched],
    completedGoals: uniqueUpdates.filter((update) => update.status === "completed").map((update) => update.id),
    staleGoalWarnings: findStaleGoalWarnings(input.arcGoalPool.goals, input.chapter, touched),
  };
}

export function mergeArcGoalUpdates(
  previous: ArcGoalPool,
  updates: readonly ArcGoalUpdate[],
): ArcGoalPool {
  const byId = new Map(previous.goals.map((goal) => [goal.id, goal]));
  for (const update of updates) {
    const existing = byId.get(update.id);
    byId.set(update.id, existing ? mergeExistingGoal(existing, update) : goalFromUpdate(update));
  }
  return { goals: [...byId.values()] };
}

/**
 * 阶段目标自动蛰伏（r7）：非 main_arc、active/touched、连续 ≥MINI_ARC_GOAL_STALE_CHAPTERS 章未推进
 * → 标 status:"stale"（不删、面板仍可查），expired 清单供 commit report 如实披露。
 * main_arc **绝不**自动蛰伏——主线被静默搁置不可接受，停滞主线走 findStaleGoalWarnings 的升级提醒。
 * 复活路径：蛰伏目标再被候选命中（findSimilarGoal 搜全池不分状态）→ mergeExistingGoal 标回 touched。
 */
export function expireStaleArcGoals(input: {
  readonly pool: ArcGoalPool;
  readonly chapter: number;
}): { readonly pool: ArcGoalPool; readonly expired: readonly ExpiredArcGoal[] } {
  const expired: ExpiredArcGoal[] = [];
  const goals = input.pool.goals.map((goal) => {
    if (goal.scope === "main_arc") return goal;
    if (goal.status !== "active" && goal.status !== "touched") return goal;
    const idleChapters = chaptersSinceTouched(goal.lastTouchedChapter, input.chapter);
    if (idleChapters < MINI_ARC_GOAL_STALE_CHAPTERS) return goal;
    expired.push({
      id: goal.id,
      title: goal.title,
      scope: goal.scope,
      lastTouchedChapter: goal.lastTouchedChapter,
      chaptersSinceTouched: idleChapters,
    });
    return { ...goal, status: "stale" as const };
  });
  return { pool: { goals }, expired };
}

interface ArcGoalCandidate {
  readonly title: string;
  readonly scope: ArcGoal["scope"];
  readonly evidence: string;
  readonly isCompleted: boolean;
}


/**
 * 声明驱动的目标候选（题材中立，替代 classifyGoalTitle 关键词表）：
 * 引擎已对每条 arcGoalProgress 逐字校验证据（verifiedDelta.arcGoalProgress 均已命中草稿），此处只做确定性归并：
 * - introduced：本章新确立目标 → 用声明 summary 作标题、声明 scope 作层级（缺省 mini_arc）。
 * - advanced/completed：优先经 targetGoalHint（缺则 summary）对号入座**已存在**目标，复用其标题/层级避免目标分裂；
 *   对不上任何已有目标时退化为按 summary 新建（宁可如实记录主线信号，也绝不静默丢弃已核实的推进）。
 * 绝不新增任何题材完成词/关键词表；标题匹配、层级判定全部走通用的 findSimilarGoal / 声明字段。
 */
function arcGoalCandidatesFromDeclaration(
  arcGoalPool: ArcGoalPool,
  verifiedDelta: VerifiedChapterDelta,
): readonly ArcGoalCandidate[] {
  const candidates: ArcGoalCandidate[] = [];
  for (const declaration of verifiedDelta.arcGoalProgress) {
    const summary = cleanText(declaration.summary);
    if (!summary) continue;
    const hint = declaration.targetGoalHint ? cleanText(declaration.targetGoalHint) : "";
    const matched =
      declaration.progress === "introduced"
        ? undefined
        : (hint ? findSimilarGoal(arcGoalPool.goals, hint) : undefined)
          ?? findSimilarGoal(arcGoalPool.goals, summary);
    const title = matched?.title ?? truncateText(summary, 40);
    if (!title) continue;
    if (candidates.some((candidate) => titlesOverlap(candidate.title, title))) continue;
    candidates.push({
      title,
      scope: matched?.scope ?? declaration.scope ?? "mini_arc",
      evidence: truncateText(declaration.quote, 120),
      isCompleted: declaration.progress === "completed",
    });
  }
  return candidates;
}



function buildArcGoalUpdate(input: {
  readonly chapter: number;
  readonly candidate: ArcGoalCandidate;
  readonly existing?: ArcGoal;
  readonly semanticSummary: ChapterSemanticSummary;
  readonly hookTrackingUpdates: readonly HookTrackingUpdate[];
  readonly threadTrackingUpdates: readonly ThreadTrackingUpdate[];
}): ArcGoalUpdate {
  const existing = input.existing;
  const id = existing?.id ?? arcGoalIdFromTitle(input.candidate.title);
  const completed = input.candidate.isCompleted || existing?.status === "completed";
  return {
    id,
    title: existing?.title ?? input.candidate.title,
    status: completed ? "completed" : existing ? "touched" : "active",
    scope: existing?.scope ?? input.candidate.scope,
    firstSeenChapter: existing?.firstSeenChapter ?? input.chapter,
    lastTouchedChapter: input.chapter,
    targetChapters: existing?.targetChapters ?? defaultTargetChapters(input.candidate.scope),
    evidence: mergeEvidence(existing?.evidence ?? [], [input.candidate.evidence]),
    relatedHooks: unique([...(existing?.relatedHooks ?? []), ...input.hookTrackingUpdates.map((update) => update.id)]),
    relatedThreads: unique([...(existing?.relatedThreads ?? []), ...input.threadTrackingUpdates.map((update) => update.id)]),
    relatedCharacters: unique([...(existing?.relatedCharacters ?? []), ...input.semanticSummary.mentionedCharacterNames]),
    relatedLocations: unique([...(existing?.relatedLocations ?? []), ...input.semanticSummary.locations]),
    nextActionHint: input.semanticSummary.nextLead ?? existing?.nextActionHint ?? `继续推进${input.candidate.title}。`,
  };
}

function mergeExistingGoal(existing: ArcGoal, update: ArcGoalUpdate): ArcGoal {
  return {
    ...existing,
    status: existing.status === "completed" ? "completed" : update.status,
    lastTouchedChapter: update.lastTouchedChapter,
    evidence: mergeEvidence(existing.evidence, update.evidence),
    ...(update.nextActionHint ? { nextActionHint: update.nextActionHint } : {}),
    relatedHooks: unique([...(existing.relatedHooks ?? []), ...(update.relatedHooks ?? [])]),
    relatedThreads: unique([...(existing.relatedThreads ?? []), ...(update.relatedThreads ?? [])]),
    relatedCharacters: unique([...(existing.relatedCharacters ?? []), ...(update.relatedCharacters ?? [])]),
    relatedLocations: unique([...(existing.relatedLocations ?? []), ...(update.relatedLocations ?? [])]),
  };
}

function goalFromUpdate(update: ArcGoalUpdate): ArcGoal {
  return {
    id: update.id,
    title: update.title,
    status: update.status,
    scope: update.scope,
    firstSeenChapter: update.firstSeenChapter,
    lastTouchedChapter: update.lastTouchedChapter,
    ...(update.targetChapters !== undefined ? { targetChapters: update.targetChapters } : {}),
    evidence: update.evidence,
    ...(update.relatedHooks ? { relatedHooks: update.relatedHooks } : {}),
    ...(update.relatedThreads ? { relatedThreads: update.relatedThreads } : {}),
    ...(update.relatedCharacters ? { relatedCharacters: update.relatedCharacters } : {}),
    ...(update.relatedLocations ? { relatedLocations: update.relatedLocations } : {}),
    ...(update.nextActionHint ? { nextActionHint: update.nextActionHint } : {}),
  };
}

/**
 * 停滞目标提醒文案（中文、按层级措辞；供 commit report / preview / 写手上下文共用，避免多处漂移）。
 * main_arc 停滞超过 MAIN_ARC_ESCALATION_IDLE 章 → 升级喊话（主线永不自动蛰伏，必须显式处置）。
 */
export function formatStaleGoalMessage(input: {
  readonly title: string;
  readonly scope: ArcGoal["scope"];
  readonly lastTouchedChapter: number;
  readonly chaptersSinceTouched: number;
}): string {
  if (input.scope === "main_arc") {
    if (input.chaptersSinceTouched > MAIN_ARC_ESCALATION_IDLE) {
      return `主线目标「${input.title}」已 ${input.chaptersSinceTouched} 章未实质推进——主线不该长期停摆：近几章安排一次实质推进（新信息/新障碍/关键抉择），或与用户确认是否转入蛰伏。`;
    }
    return `主线目标「${input.title}」已 ${input.chaptersSinceTouched} 章没有推进（上次出现在第 ${input.lastTouchedChapter} 章）。考虑近几章安排一次实质推进。`;
  }
  return `阶段目标「${input.title}」已 ${input.chaptersSinceTouched} 章没有推进（上次出现在第 ${input.lastTouchedChapter} 章）。考虑推进或收口；连续 ${MINI_ARC_GOAL_STALE_CHAPTERS} 章不动会被自动蛰伏（写到即恢复）。`;
}

/**
 * 停滞目标提醒（r7 起里程碑制）：新停滞头两章立即提醒、长期停滞每 10 章重提一次（见 stale-reminder-policy），
 * 按停滞时长降序、截 MAX_STALE_GOAL_WARNINGS 条——不再每章重复全量灌提醒。
 */
function findStaleGoalWarnings(
  goals: readonly ArcGoal[],
  chapter: number,
  touchedGoalIds: ReadonlySet<string>,
): readonly StaleGoalWarning[] {
  return goals
    .filter((goal) => goal.status === "active" || goal.status === "touched")
    .filter((goal) => !touchedGoalIds.has(goal.id))
    .map((goal) => ({
      goal,
      chaptersSinceTouched: chaptersSinceTouched(goal.lastTouchedChapter, chapter),
    }))
    .filter((entry) => shouldRemindStaleAt(entry.chaptersSinceTouched, GOAL_STALE_THRESHOLD))
    .sort((left, right) => right.chaptersSinceTouched - left.chaptersSinceTouched)
    .slice(0, MAX_STALE_GOAL_WARNINGS)
    .map(({ goal, chaptersSinceTouched }) => ({
      id: goal.id,
      title: goal.title,
      scope: goal.scope,
      lastTouchedChapter: goal.lastTouchedChapter,
      chaptersSinceTouched,
      message: formatStaleGoalMessage({
        title: goal.title,
        scope: goal.scope,
        lastTouchedChapter: goal.lastTouchedChapter,
        chaptersSinceTouched,
      }),
    }));
}

function findSimilarGoal(goals: readonly ArcGoal[], title: string): ArcGoal | undefined {
  const normalizedTitle = normalize(title);
  return goals.find((goal) => {
    const normalizedGoal = normalize(goal.title);
    return normalizedGoal === normalizedTitle
      || normalizedGoal.includes(normalizedTitle)
      || normalizedTitle.includes(normalizedGoal);
  });
}




function defaultTargetChapters(scope: ArcGoal["scope"]): number {
  return scope === "main_arc" ? 10 : scope === "mini_arc" ? 5 : 1;
}

function splitSentences(content: string): readonly string[] {
  return content
    .split(/(?<=[。！？!?；;])|\n+/u)
    .map(cleanText)
    .filter(Boolean);
}

function mergeEvidence(previous: readonly string[], additions: readonly string[]): readonly string[] {
  return unique([...previous, ...additions].map((value) => truncateText(value, 120))).slice(-MAX_EVIDENCE);
}

function uniqueById(updates: readonly ArcGoalUpdate[]): readonly ArcGoalUpdate[] {
  const byId = new Map<string, ArcGoalUpdate>();
  for (const update of updates) {
    if (!byId.has(update.id)) byId.set(update.id, update);
  }
  return [...byId.values()];
}

function titlesOverlap(left: string, right: string): boolean {
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return normalizedLeft === normalizedRight
    || normalizedLeft.includes(normalizedRight)
    || normalizedRight.includes(normalizedLeft);
}

function arcGoalIdFromTitle(title: string): string {
  return `arc-${hashText(title)}`;
}

function hashText(value: string): string {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function containsAny(value: string, keywords: readonly string[]): boolean {
  return keywords.some((keyword) => value.includes(keyword));
}

function normalize(value: string): string {
  return cleanText(value).toLowerCase().replace(/\s+/gu, "");
}

function cleanText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function truncateText(value: string, maxLength: number): string {
  const clean = cleanText(value);
  return clean.length <= maxLength ? clean : `${clean.slice(0, Math.max(0, maxLength - 1))}…`;
}

function unique(values: readonly (string | undefined)[]): readonly string[] {
  return [...new Set(values.filter((value): value is string => value !== undefined && value.trim().length > 0))];
}
