import type { ForeshadowingDeclaration, VerifiedChapterDelta } from "./chapter-delta.js";
import type { ChapterSemanticSummary } from "./commit-plan-builder.js";
import { shouldRemindStaleAt } from "./stale-reminder-policy.js";
import type { HookItem, HookPool } from "./types.js";

/**
 * tracking 通道只表达两态：active（埋/承接）与 resolved（本章回收）。绝不放宽到 seeded/inactive/abandoned
 * —— 那些是 hookUpdates 校验通道（必须指向池内已有 hook）的职责，混进 tracking update 易被误用。
 */
export type HookTrackingStatus = Extract<HookItem["status"], "active" | "resolved">;

export interface HookTrackingUpdate {
  readonly id: string;
  readonly title: string;
  readonly status: HookTrackingStatus;
  readonly firstSeenChapter: number;
  readonly lastTouchedChapter: number;
  readonly evidence: readonly string[];
  readonly nextActionHint?: string;
  readonly relatedCharacters?: readonly string[];
  readonly relatedLocations?: readonly string[];
  /**
   * B4: 该 hook 本章被判为回收（resolved）的章号。走 trackingUpdates 通道携带（commit-engine 原样转发、零改动）；
   * status 仍由独立的 statusUpdates 通道置成 resolved，这里只补回收章号。
   */
  readonly resolvedAtChapter?: number;
}

export interface HookStaleWarning {
  readonly id: string;
  readonly title: string;
  readonly lastTouchedChapter: number;
  readonly chaptersSinceTouched: number;
  readonly message: string;
}

export interface HookTrackingPlan {
  readonly updates: readonly HookTrackingUpdate[];
  readonly introducedHooks: readonly string[];
  readonly touchedHooks: readonly string[];
  readonly staleHookWarnings: readonly HookStaleWarning[];
  readonly resolvedHookIds: readonly string[];
}

const MAX_CANDIDATES = 5;
const MAX_EVIDENCE = 5;
// 2026-08-12 摘除 HOOK_KEYWORDS 悬疑词表（后墙异常响动/假账本/血痕…）：它是早期测试书的题材残留，
// 违反题材中立——50 章武侠实测只误中 1 次，换成商战/都市文则会拿「账目」「失踪」乱造伏笔。
// 新伏笔的正路早已迁到「模型声明 seededForeshadowing（证据校验）→ 线索池」（见 lead-intent-tracking）；
// 本模块只负责【已存在伏笔】的触达/收口/停滞告警，不再从正文正则猜新伏笔。
const MAX_TITLE_LENGTH = 16;

export function buildHookTrackingPlan(input: {
  readonly chapter: number;
  readonly draft: string;
  readonly semanticSummary: ChapterSemanticSummary;
  readonly hookPool: HookPool;
  /**
   * 可选：已核实的章节语义声明。传入时，本章模型声明的 resolvedForeshadowing 若命中某条【已存在的活跃伏笔】，
   * 直接标该伏笔 resolved——补齐「伏笔只能靠完成词正则收口」的缺口（线索早已走这条声明通道，伏笔漏了）。
   * 缺失时本章只记触达、不收口。题材中立：只做标题/证据比对，不加任何完成词表。
   */
  readonly verifiedDelta?: VerifiedChapterDelta;
}): HookTrackingPlan {
  // 声明驱动的伏笔收口放最前：uniqueById 保留首个，声明的收口优先于正文提到的同一伏笔（后者只算触达）。
  const declaredResolvedCandidates = input.verifiedDelta
    ? extractDeclaredResolvedHookCandidates(input.verifiedDelta, input.hookPool)
    : [];
  const candidates = [...declaredResolvedCandidates, ...extractHookCandidates(input)];
  const existingById = new Map(input.hookPool.hooks.map((hook) => [hook.id, hook]));

  // Collect per-hook resolved IDs: candidate isDone + hook already exists in pool
  const resolvedHookIds = candidates
    .filter((candidate) => candidate.isDone)
    .map((candidate) => {
      const existing = findSimilarHook(input.hookPool.hooks, candidate.title);
      return existing?.id ?? hookIdFromTitle(candidate.title);
    });
  const resolvedIdSet = new Set(resolvedHookIds);

  const updates = uniqueById(candidates.map((candidate) => {
    const existing = findSimilarHook(input.hookPool.hooks, candidate.title);
    const update = buildHookTrackingUpdate({
      chapter: input.chapter,
      candidate,
      existing,
      semanticSummary: input.semanticSummary,
    });
    // B4 + PR B: 本章回收的 hook 在 trackingUpdate 上携带回收章号 + 状态置 resolved（resolved 状态全程走
    // trackingUpdates 通道，新/未登记 hook 也能 introduce-then-resolve，无需经 hookUpdates 校验通道）。
    return resolvedIdSet.has(update.id)
      ? { ...update, status: "resolved" as const, resolvedAtChapter: input.chapter }
      : update;
  }));
  const touched = new Set(updates.map((update) => update.id));
  const introducedHooks = updates
    .filter((update) => !existingById.has(update.id))
    .map((update) => update.id);
  const staleHookWarnings = findStaleHookWarnings(input.hookPool.hooks, input.chapter, touched);

  return {
    updates,
    introducedHooks,
    touchedHooks: [...touched],
    staleHookWarnings,
    resolvedHookIds,
  };
}

export function mergeHookTrackingUpdates(
  previous: HookPool,
  updates: readonly HookTrackingUpdate[],
  statusUpdates: ReadonlyMap<string, HookItem["status"]> = new Map(),
): HookPool {
  const byId = new Map(previous.hooks.map((hook) => [hook.id, hook]));
  for (const update of updates) {
    const existing = byId.get(update.id);
    byId.set(update.id, existing ? mergeExistingHook(existing, update) : hookFromUpdate(update));
  }

  const hooks = [...byId.values()].map((hook) => {
    const status = statusUpdates.get(hook.id);
    return status === undefined ? hook : { ...hook, status };
  });
  return { hooks };
}

function extractHookCandidates(input: {
  readonly chapter: number;
  readonly draft: string;
  readonly semanticSummary: ChapterSemanticSummary;
  readonly hookPool: HookPool;
}): readonly {
  readonly title: string;
  readonly evidence: string;
  readonly isDone: boolean;
}[] {
  const sentences = splitSentences(input.draft);
  const mentionedHookTitles = input.semanticSummary.mentionedHooks.map((hookId) => {
      const existing = input.hookPool.hooks.find((hook) => hook.id === hookId);
      return existing?.title ?? hookId;
    });

  // 只产出【已存在伏笔】的触达/收口候选：新伏笔不再从正文正则猜（题材词表已摘除，见文件头注释）——
  // 模型声明的新埋伏笔走 seededForeshadowing → 线索池（声明+证据校验，题材中立）。
  const candidates: Array<{ title: string; evidence: string; isDone: boolean }> = [];
  for (const title of mentionedHookTitles) {
    const cleanTitle = cleanHookTitle(title);
    if (!cleanTitle || candidates.some((candidate) => normalize(candidate.title) === normalize(cleanTitle))) continue;
    // 正文提到只算触达；收口只认声明的 resolvedForeshadowing（2026-10-10 删掉「水落石出 / 查清了」完成词表：
    // 「还没查清了」「以为查清了」这类句子也会被它关掉）。
    candidates.push({
      title: truncateText(cleanTitle, 24),
      evidence: evidenceFor(cleanTitle, input.draft, input.semanticSummary),
      isDone: false,
    });
    if (candidates.length >= MAX_CANDIDATES) return candidates;
  }
  return candidates;
}

/**
 * 声明驱动的伏笔收口候选（题材中立，已通过证据校验）：模型 resolvedForeshadowing 里每条回收声明，
 * 若能命中某条【已存在的活跃伏笔】（标题/证据比对），产出一条 isDone 候选（复用该伏笔标题→下游按标题找回其 id 标 resolved）。
 * 指向不存在/非活跃伏笔的回收声明直接跳过（宁可不动，也不凭空造伏笔或误收口）。
 */
function extractDeclaredResolvedHookCandidates(
  verifiedDelta: VerifiedChapterDelta,
  hookPool: HookPool,
): readonly { readonly title: string; readonly evidence: string; readonly isDone: boolean }[] {
  const activeHooks = hookPool.hooks.filter((hook) => hook.status === "active");
  if (activeHooks.length === 0) return [];
  const candidates: { title: string; evidence: string; isDone: boolean }[] = [];
  for (const resolved of verifiedDelta.resolvedForeshadowing) {
    const target = findDeclaredTargetHook(resolved, activeHooks);
    if (!target) continue;
    candidates.push({ title: target.title, evidence: truncateText(resolved.quote, 110), isDone: true });
  }
  return candidates;
}

/**
 * 把一条回收声明匹配到某条已存在的活跃伏笔：先用 targetThreadHint，再退到 summary，与伏笔标题做标题重叠比对。
 * 都对不上 → undefined（该条回收不落到伏笔上，绝不误收口）。
 */
function findDeclaredTargetHook(
  resolved: ForeshadowingDeclaration,
  activeHooks: readonly HookItem[],
): HookItem | undefined {
  const probes = [resolved.targetThreadHint, resolved.summary]
    .map((value) => value?.trim())
    .filter((value): value is string => !!value && value.length > 0);
  for (const probe of probes) {
    const match = activeHooks.find((hook) => titlesOverlap(hook.title, probe));
    if (match) return match;
  }
  return undefined;
}

function buildHookTrackingUpdate(input: {
  readonly chapter: number;
  readonly candidate: { readonly title: string; readonly evidence: string };
  readonly existing?: HookItem;
  readonly semanticSummary: ChapterSemanticSummary;
}): HookTrackingUpdate {
  const existing = input.existing;
  const id = existing?.id ?? hookIdFromTitle(input.candidate.title);
  const nextActionHint = input.semanticSummary.nextLead ?? `自然推进${input.candidate.title}。`;
  return {
    id,
    title: existing?.title ?? input.candidate.title,
    status: "active",
    firstSeenChapter: existing?.firstSeenChapter ?? input.chapter,
    lastTouchedChapter: input.chapter,
    evidence: mergeEvidence(existing?.evidence ?? [], [input.candidate.evidence]),
    nextActionHint,
    ...(input.semanticSummary.mentionedCharacterNames.length > 0
      ? { relatedCharacters: input.semanticSummary.mentionedCharacterNames }
      : {}),
    ...(input.semanticSummary.locations.length > 0 ? { relatedLocations: input.semanticSummary.locations } : {}),
  };
}

function mergeExistingHook(existing: HookItem, update: HookTrackingUpdate): HookItem {
  // B4 单调：回收章号定死在第一次回收那章——existing 已有则保留，绝不被后续章节覆盖/丢失。
  const resolvedAtChapter = existing.resolvedAtChapter ?? update.resolvedAtChapter;
  return {
    ...existing,
    // 单调：已 resolved 恒保；否则承接本轮 tracking update 的状态（resolved 走 tracking 通道）。
    status: existing.status === "resolved" ? "resolved" : update.status,
    firstSeenChapter: existing.firstSeenChapter ?? update.firstSeenChapter,
    lastTouchedChapter: update.lastTouchedChapter,
    evidence: mergeEvidence(existing.evidence ?? [], update.evidence),
    ...(update.nextActionHint ? { nextActionHint: update.nextActionHint } : {}),
    relatedCharacters: unique([...(existing.relatedCharacters ?? []), ...(update.relatedCharacters ?? [])]),
    relatedLocations: unique([...(existing.relatedLocations ?? []), ...(update.relatedLocations ?? [])]),
    ...(resolvedAtChapter !== undefined ? { resolvedAtChapter } : {}),
  };
}

function hookFromUpdate(update: HookTrackingUpdate): HookItem {
  return {
    id: update.id,
    title: update.title,
    description: update.evidence[0] ?? update.title,
    // 新 hook 入池承接 update 状态：introduce-then-resolve 时直接落 resolved，不再硬编码 active。
    status: update.status,
    relatedCharacters: update.relatedCharacters ?? [],
    firstSeenChapter: update.firstSeenChapter,
    lastTouchedChapter: update.lastTouchedChapter,
    evidence: update.evidence,
    ...(update.nextActionHint ? { nextActionHint: update.nextActionHint } : {}),
    ...(update.relatedLocations ? { relatedLocations: update.relatedLocations } : {}),
    ...(update.resolvedAtChapter !== undefined ? { resolvedAtChapter: update.resolvedAtChapter } : {}),
  };
}

/** 伏笔停滞提醒阈值（与线索同口径）。 */
const HOOK_STALE_THRESHOLD = 3;

/** 每章最多提醒的停滞伏笔条数（按停滞时长降序截断）。 */
const MAX_STALE_HOOK_WARNINGS = 5;

/** 停滞伏笔提醒文案（中文；供 report / 写手上下文共用）。 */
export function formatStaleHookMessage(input: {
  readonly title: string;
  readonly lastTouchedChapter: number;
  readonly chaptersSinceTouched: number;
}): string {
  return `伏笔「${input.title}」已 ${input.chaptersSinceTouched} 章没有推进（上次出现在第 ${input.lastTouchedChapter} 章）。考虑推进或收口，别让它埋了不收。`;
}

/**
 * 停滞伏笔提醒（r7 起里程碑制，见 stale-reminder-policy）：不再每章重复全量灌提醒。
 */
function findStaleHookWarnings(
  hooks: readonly HookItem[],
  chapter: number,
  touchedHookIds: ReadonlySet<string>,
): readonly HookStaleWarning[] {
  return hooks
    .filter((hook) => hook.status === "active")
    .filter((hook) => hook.lastTouchedChapter !== undefined)
    .filter((hook) => !touchedHookIds.has(hook.id))
    .map((hook) => ({
      hook,
      chaptersSinceTouched: chapter - hook.lastTouchedChapter!,
    }))
    .filter((entry) => shouldRemindStaleAt(entry.chaptersSinceTouched, HOOK_STALE_THRESHOLD))
    .sort((left, right) => right.chaptersSinceTouched - left.chaptersSinceTouched)
    .slice(0, MAX_STALE_HOOK_WARNINGS)
    .map(({ hook, chaptersSinceTouched }) => ({
      id: hook.id,
      title: hook.title,
      lastTouchedChapter: hook.lastTouchedChapter!,
      chaptersSinceTouched,
      message: formatStaleHookMessage({
        title: hook.title,
        lastTouchedChapter: hook.lastTouchedChapter!,
        chaptersSinceTouched,
      }),
    }));
}

function findSimilarHook(hooks: readonly HookItem[], title: string): HookItem | undefined {
  const normalizedTitle = normalize(title);
  return hooks.find((hook) => {
    const values = [hook.id, hook.title, hook.description, ...(hook.evidence ?? [])].map(normalize);
    return values.some((value) => value.includes(normalizedTitle) || normalizedTitle.includes(value));
  });
}

function uniqueById(updates: readonly HookTrackingUpdate[]): readonly HookTrackingUpdate[] {
  const byId = new Map<string, HookTrackingUpdate>();
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

function cleanHookTitle(title: string): string | undefined {
  const clean = cleanText(title).replace(/[。！？!?；;，,\s]+$/u, "");
  if (!clean) return undefined;
  return truncateText(clean, MAX_TITLE_LENGTH);
}

function evidenceFor(title: string, draft: string, semanticSummary: ChapterSemanticSummary): string {
  const sentence = splitSentences(draft).find((candidate) => candidate.includes(title));
  return truncateText(sentence ?? semanticSummary.nextLead ?? semanticSummary.discovery ?? semanticSummary.mainEvent, 110);
}

function splitSentences(content: string): readonly string[] {
  return content
    .split(/(?<=[。！？!?；;])|\n+/u)
    .map(cleanText)
    .filter(Boolean);
}

function mergeEvidence(previous: readonly string[], additions: readonly string[]): readonly string[] {
  return unique([...previous, ...additions].map((value) => truncateText(value, 110))).slice(-MAX_EVIDENCE);
}

function hookIdFromTitle(title: string): string {
  const ascii = title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/['’]/gu, "")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .replace(/-{2,}/gu, "-");
  return ascii ? `hook-${ascii}` : `hook-${hashText(title)}`;
}

function hashText(value: string): string {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function normalize(value: string): string {
  return cleanText(value).toLowerCase().replace(/\s+/gu, "");
}

function cleanText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function truncateText(value: string, maxLength: number): string {
  const clean = cleanText(value);
  return clean.length <= maxLength ? clean : `${clean.slice(0, maxLength)}…`;
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter(Boolean))];
}
