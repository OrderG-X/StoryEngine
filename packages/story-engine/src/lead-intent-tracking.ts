import type { ForeshadowingDeclaration, LeadDeclaration, PendingIntentDeclaration, VerifiedChapterDelta } from "./chapter-delta.js";
import type { ChapterSemanticSummary } from "./commit-plan-builder.js";
import { chaptersSinceTouched, shouldRemindStaleAt } from "./stale-reminder-policy.js";
import { bigramSimilarity } from "./text-similarity.js";
import type { NarrativeThread, ThreadPool } from "./types.js";

export interface ThreadTrackingUpdate {
  readonly id: string;
  readonly type: NarrativeThread["type"];
  readonly title: string;
  readonly status: NarrativeThread["status"];
  readonly firstSeenChapter: number;
  readonly lastTouchedChapter: number;
  readonly evidence: readonly string[];
  readonly nextActionHint?: string;
  readonly relatedCharacters?: readonly string[];
  readonly relatedLocations?: readonly string[];
}

export interface StaleThreadWarning {
  readonly id: string;
  readonly type: NarrativeThread["type"];
  readonly title: string;
  readonly lastTouchedChapter: number;
  readonly chaptersSinceTouched: number;
  readonly message: string;
}

export interface ExpiredIntentThread {
  readonly id: string;
  readonly type: "intent";
  readonly title: string;
  readonly lastTouchedChapter: number;
  readonly chaptersSinceTouched: number;
}

export interface ThreadHygieneReport {
  readonly beforeCount: number;
  readonly afterCount: number;
  readonly mergedCount: number;
  readonly markedDoneCount: number;
  /**
   * 全书停滞线索底数（open/touched、本章未触及、idle 超过阈值的全部）——r7 起与「本章提醒了几条」解耦：
   * staleThreadWarnings 走里程碑制只提醒一部分，这个数始终报真话，供预览 digest 播报总量（降噪≠静默）。
   */
  readonly staleWarningCount: number;
  /** 全书停滞线索里最久的一条已停滞多少章（底数为 0 时缺省）。 */
  readonly oldestStaleChaptersSinceTouched?: number;
  readonly injectedCount: number;
}

export interface ThreadTrackingPlan {
  readonly updates: readonly ThreadTrackingUpdate[];
  readonly introducedThreads: readonly string[];
  readonly touchedThreads: readonly string[];
  readonly staleThreadWarnings: readonly StaleThreadWarning[];
  readonly threadHygieneReport: ThreadHygieneReport;
}

const MAX_EVIDENCE = 5;
const MAX_TITLE_LENGTH = 18;

/** 线索停滞提醒阈值（严格大于才算停滞；与 hook 同口径）。 */
const THREAD_STALE_THRESHOLD = 3;

/** 每章最多提醒的停滞线索条数（按停滞时长降序截断；全量底数走 threadHygieneReport.staleWarningCount）。 */
const MAX_STALE_THREAD_WARNINGS = 8;

export function buildThreadTrackingPlan(input: {
  readonly chapter: number;
  readonly draft: string;
  readonly semanticSummary: ChapterSemanticSummary;
  readonly threadPool: ThreadPool;
  readonly protagonistName?: string;
  /**
   * 可选：已核实的章节语义声明。传入时，线索回收/埋设优先走声明——
   * resolvedForeshadowing 指向**已存在**线索（标 done，绝不新建，治线索分裂）；
   * seededForeshadowing 才新建（标题用声明 summary）。缺失时本章不动线索（不再从正文正则猜）。
   */
  readonly verifiedDelta?: VerifiedChapterDelta;
}): ThreadTrackingPlan {
  const existingById = new Map(input.threadPool.threads.map((thread) => [thread.id, thread]));
  const declaredCandidates = input.verifiedDelta
    ? extractDeclaredThreadCandidates({ verifiedDelta: input.verifiedDelta, threadPool: input.threadPool })
    : [];
  // 2026-10-10 引擎升级：线索的新开、推进、了结只听章节语义声明（原句已核、作者在定稿清单上勾过）。
  // 删掉了从正文正则猜线索的两条路——关键词表里还留着旧测试书的词（后墙、暗号、残页），
  // 正则「了结」更是有声明也照跑，常把还开着的线索按「查清 / 确认」字样关掉。没拿到声明 = 本章线索没记，由上层如实提示。
  const candidates = [...declaredCandidates];
  const updates = uniqueById(candidates.map((candidate) => {
    const existing = candidate.targetThreadId
      ? existingById.get(candidate.targetThreadId)
      : findSimilarThread(input.threadPool.threads, candidate);
    return buildThreadTrackingUpdate({
      chapter: input.chapter,
      candidate,
      existing,
      semanticSummary: input.semanticSummary,
    });
  }));
  const touched = new Set(updates.map((update) => update.id));
  const introducedThreads = updates
    .filter((update) => !existingById.has(update.id))
    .map((update) => update.id);
  const staleThreadWarnings = findStaleThreadWarnings(input.threadPool.threads, input.chapter, touched);
  const staleBacklog = collectStaleBacklog(input.threadPool.threads, input.chapter, touched);
  const merged = mergeThreadTrackingUpdates(input.threadPool, updates);

  return {
    updates,
    introducedThreads,
    touchedThreads: [...touched],
    staleThreadWarnings,
    threadHygieneReport: buildThreadHygieneReport({
      before: input.threadPool,
      after: merged,
      updates,
      staleBacklog,
      injectedCount: 0,
    }),
  };
}

/**
 * 声明驱动的线索候选（题材中立，已通过证据校验）：
 * - resolvedForeshadowing：只在能命中**已存在** open/touched 线索时消费——标 done、复用其 id/title，绝不新建（治线索分裂）。
 *   指向不存在线索的回收声明直接跳过（宁可不动，也不凭空造新线索）。
 * - seededForeshadowing / keyLeads：新建 lead 线索，标题用声明 summary（keyLeads 此前只校验未消费，
 *   模型申报的关键线索被丢在地上——2026-07-04 补上，对齐设计文档「新埋 lead 由 seeded/keyLeads 负责」）。
 * - pendingIntents：新建 intent，标题用声明 summary。声明可用时 regex intent 让位，避免「决定/准备」类正则每章净增。
 * - 声明 summary 同样过 isQualityLead 质量闸：模型无关铁律，不信模型会传干净输入——
 *   退化 summary（「什么线索」这类指代模糊短语）拦在门外，绝不当标题落库。
 */
/** 两条线索引的是不是同一句原文（压掉空白和标点再比；太短的不算，免得「嗯。」这类句子误并）。 */
function sameEvidence(a: string | undefined, b: string): boolean {
  const squash = (text: string) => text.replace(/[\s\p{P}]+/gu, "");
  const left = squash(a ?? "");
  return left.length >= 6 && left === squash(b);
}

function extractDeclaredThreadCandidates(input: {
  readonly verifiedDelta: VerifiedChapterDelta;
  readonly threadPool: ThreadPool;
}): readonly ThreadCandidate[] {
  const candidates: ThreadCandidate[] = [];
  const activeThreads = input.threadPool.threads.filter(
    (thread) => thread.status === "open" || thread.status === "touched",
  );
  for (const resolved of input.verifiedDelta.resolvedForeshadowing) {
    const target = findDeclaredTargetThread(resolved, activeThreads);
    if (!target) continue; // 指向不存在线索 → 不新建（避免制造分裂）
    // 收口证据必须真的在说这条线索（十章验收：拿「是一枚硬币」关掉凭物线索、核心谜底第 3 章就被关）：
    // 引的原句与线索标题/证据至少共享两个字面片段才算收口；对不上就只算推进，不关。
    candidates.push({
      type: target.type,
      title: target.title,
      evidence: truncateText(resolved.quote, 120),
      isDone: resolutionQuoteIsRelevant(resolved.quote, target),
      targetThreadId: target.id,
    });
  }
  // 阶段 4「记账对号」：声明说本章推进的是某条已开着的线索 → 触碰那一条（touched、更新最近推进章），不新建。
  // 指不到（标题对不上）→ 当新线索处理（下面的新建路径），宁可多一条也不丢。
  const newLeadDeclarations: (ForeshadowingDeclaration | LeadDeclaration)[] = [...input.verifiedDelta.seededForeshadowing];
  for (const declared of input.verifiedDelta.keyLeads) {
    const target = declared.progress === "advanced" || declared.targetThreadHint
      ? findAdvancedTargetThread(declared, activeThreads)
      : undefined;
    if (target) {
      if (!candidates.some((candidate) => candidate.targetThreadId === target.id)) {
        candidates.push({
          type: target.type,
          title: target.title,
          evidence: truncateText(declared.quote, 120),
          isDone: false,
          targetThreadId: target.id,
        });
      }
      continue;
    }
    newLeadDeclarations.push(declared);
  }
  for (const declared of newLeadDeclarations) {
    const title = cleanTitle(declared.summary);
    if (!title) continue;
    if (!isQualityLead(title, declared.quote)) continue;
    // 同一批声明里 seeded 与 keyLeads 常是同一件事换个说法：批内去重（标题互相包含 / 字面相近 / 引的是同一句原文），只留第一条
    // （2026-10-11 真机验收：「郑德海与林秋同届」「能否找到郑德海问出…」引同一句，记成两条新线索）。
    const evidence = truncateText(declared.quote, 120);
    if (candidates.some((candidate) => !candidate.targetThreadId && candidate.type === "lead"
      && (titlesOverlap(candidate.title, title) || bigramSimilarity(candidate.title, title) >= BATCH_DUPLICATE_SIMILARITY
        || sameEvidence(candidate.evidence, evidence)))) continue;
    candidates.push({
      type: "lead",
      title,
      evidence,
      isDone: false,
    });
  }
  for (const declared of input.verifiedDelta.pendingIntents) {
    // 还是那件没办完的事（模型给了已开着的编号，或标题互相包含）→ 触碰那一条，不另立一条（第十四轮「继承公证材料」立了 6 条）。
    const target = findAdvancedTargetThread(declared, activeThreads);
    if (target) {
      if (!candidates.some((candidate) => candidate.targetThreadId === target.id)) {
        candidates.push({ type: target.type, title: target.title, evidence: truncateText(declared.quote, 120), isDone: false, targetThreadId: target.id });
      }
      continue;
    }
    const candidate = declaredPendingIntentCandidate(declared);
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

function declaredPendingIntentCandidate(declared: PendingIntentDeclaration): ThreadCandidate | undefined {
  const title = cleanTitle(declared.summary);
  if (!title) return undefined;
  if (!isQualityLead(title, declared.quote)) return undefined;
  return {
    type: "intent",
    title,
    evidence: truncateText(declared.quote, 120),
    isDone: false,
  };
}

/**
 * 待办多久没人碰就蛰伏（stale，不算完成；再被提到会恢复）。待办是「下一步要做什么」，几章不碰多半已办完或作罢：
 * 第十四轮十章里「明天上午工作组来丈量」第 3 章立、第 4 章就丈量完，到第 10 章还开着；touched 的待办过去永不蛰伏。
 */
const INTENT_STALE_AFTER_CHAPTERS = 4;

export function expireStaleIntents(input: {
  readonly pool: ThreadPool;
  readonly chapter: number;
}): { readonly pool: ThreadPool; readonly expired: readonly ExpiredIntentThread[] } {
  const expired: ExpiredIntentThread[] = [];
  const threads = input.pool.threads.map((thread) => {
    if (thread.type !== "intent" || (thread.status !== "open" && thread.status !== "touched")) return thread;
    const idleChapters = chaptersSinceTouched(thread.lastTouchedChapter, input.chapter);
    if (idleChapters < INTENT_STALE_AFTER_CHAPTERS) return thread;
    expired.push({
      id: thread.id,
      type: "intent",
      title: thread.title,
      lastTouchedChapter: thread.lastTouchedChapter,
      chaptersSinceTouched: idleChapters,
    });
    return { ...thread, status: "stale" as const };
  });
  return {
    pool: { threads },
    expired,
  };
}

/** 收口原句与线索至少共享几个两字片段才算在说同一件事。 */
const RESOLUTION_MIN_SHARED_BIGRAMS = 2;

function hanBigrams(text: string): Set<string> {
  const grams = new Set<string>();
  for (const run of text.match(/[\u3400-\u9fff]+/gu) ?? []) {
    const chars = Array.from(run);
    for (let i = 0; i + 1 < chars.length; i += 1) grams.add(chars[i] + chars[i + 1]);
  }
  return grams;
}

/** 收口引的原句是否真的在说这条线索：与线索标题 + 首条证据共享 ≥ 2 个两字片段。 */
function resolutionQuoteIsRelevant(quote: string, thread: NarrativeThread): boolean {
  const threadGrams = hanBigrams(`${thread.title.replace(/…$/u, "")} ${thread.evidence?.[0] ?? ""}`);
  let shared = 0;
  for (const gram of hanBigrams(quote)) {
    if (threadGrams.has(gram)) shared += 1;
    if (shared >= RESOLUTION_MIN_SHARED_BIGRAMS) return true;
  }
  return false;
}

/** 同一批新线索之间算重复的字面相近度阈值（bigram 相似度）。 */
const BATCH_DUPLICATE_SIMILARITY = 0.5;

/**
 * 推进声明指向哪条已开着的线索：targetThreadHint 与标题逐字相同（去空白、去截断省略号）优先，其次标题互相包含；
 * 不走「任意两字片段」的宽松锚点——推进只是触碰，指错了会让真线索被误判在推进。
 */
function findAdvancedTargetThread(
  declared: Pick<LeadDeclaration, "summary" | "targetThreadHint">,
  activeThreads: readonly NarrativeThread[],
): NarrativeThread | undefined {
  const bare = (value: string) => value.replace(/[\s…]+/gu, "").replace(/\.{3}$/u, "");
  const hint = declared.targetThreadHint?.trim();
  if (hint) {
    // 入库标题过长会被截成「前 16 字…」：提示给的是完整说法时，按「以截断标题开头」也算同一条。
    const exact = activeThreads.find((thread) => bare(thread.title) === bare(hint)
      || (thread.title.trim().endsWith("…") && bare(thread.title).length >= 6 && bare(hint).startsWith(bare(thread.title))));
    if (exact) return exact;
    const overlap = activeThreads.find((thread) => titlesOverlap(thread.title, hint));
    if (overlap) return overlap;
  }
  return activeThreads.find((thread) => titlesOverlap(thread.title, declared.summary));
}

/**
 * 把一条回收声明匹配到某条已存在的活跃线索：先用 targetThreadHint（命中标题/具体锚点），
 * 再退到 summary 命中锚点/标题。都对不上 → undefined（该条回收不落地，绝不新建）。
 */
function findDeclaredTargetThread(
  resolved: ForeshadowingDeclaration,
  activeThreads: readonly NarrativeThread[],
): NarrativeThread | undefined {
  const probes = [resolved.targetThreadHint, resolved.summary]
    .map((value) => value?.trim())
    .filter((value): value is string => !!value && value.length > 0);
  for (const probe of probes) {
    const match = activeThreads.find(
      (thread) =>
        titlesOverlap(thread.title, probe)
        || concreteThreadAnchors(thread).some((anchor) => probe.includes(anchor) || anchor.includes(probe)),
    );
    if (match) return match;
  }
  return undefined;
}

export function mergeThreadTrackingUpdates(
  previous: ThreadPool,
  updates: readonly ThreadTrackingUpdate[],
): ThreadPool {
  const byId = new Map(previous.threads.map((thread) => [thread.id, thread]));
  for (const update of updates) {
    const existing = byId.get(update.id);
    byId.set(update.id, existing ? mergeExistingThread(existing, update) : threadFromUpdate(update));
  }
  return compactThreadPool({ threads: [...byId.values()] });
}

// 铅笔截断字首检测：以下字符只会出现在词的中间，句首出现说明是被截断的半句
const TRUNCATED_LEAD_CHARS = /^[么的了吗呢吧啊哦哈嘛啦呀哟喔哎哩嗯唉]/u;
// 连词/处置介词起头 = 从句中截出的半句病句（如「就把线索拆散了夹在这些没」）——成形线索标题以名词锚点起头，
// 已重锚成功的好标题不会撞这条（Codex 1-5 章真机：threads.json 出现连词起头病句标题）。
const LEADING_CONJUNCTION_FRAGMENT = /^(?:就|把|便|才|则|又|也|还|而|于是|然后|接着|可是|但是|不过|因为|所以|要是|如果|既然|况且|何况|随后|接下来|于此|为此)/u;
// 噪声黑名单（来自 isAdministrativeIntentNoise 同款范式）
const QUALITY_LEAD_NOISE_PATTERN = /没有异常|线索太碎|看不出任何异常|没有发现异常|没有线索|无任何线索/u;
// 否定模式（复用 isDoneSource 同款范式）
const QUALITY_LEAD_NEGATION_PATTERN = /没有.{0,6}(?:异常|线索|发现|问题)|未(?:发现|找到|查清)|看不出/u;
// 最短成句长度（title + evidence 都太短视为碎片）
const MIN_QUALITY_LEAD_LEN = 6;
// 元叙述/总结句标题（Codex 5 章 E2E：threads 出现「三条线索」「线索闭环了」）——谈「线索/真相/谜」这套系统本身、
// 无具体故事名物锚点的句子，不是真线索。成形的真线索以具体名物/人物/地点起头（蓝色棉线/账册/赵叔/后墙）、不撞这两条。
// ① 枚举/指代 meta：纯「数量词/指示词 + 线索/真相/谜/疑点/证据」（三条线索 / 这些线索），整条无具体宾语。
const META_ENUMERATION_LEAD = /^(?:[一二三四五六七八九十两数几多]+[条种个]?|这些|那些|这几|那几|这|那|所有|全部|各条|每条|几条)?\s*(?:线索|真相|谜[底团]|疑点|证据)$/u;
// ② 收束/总结 meta：整条以「线索/真相/谜/疑点/案子 + 收束词」起头（线索闭环了）。**锚定标题开头**——
//    「邻居的债务线索浮出水面」这种带具体主语的真线索不撞（它不以『线索/真相』起头）。只收收束动词、不收「指向」
//    （「线索指向赵叔」是带具体人物的真线索、不能误杀）。
const META_CLOSURE_LEAD = /^(?:这|那|这些|那些|所有|全部|一切)?(?:线索|真相|谜[底团]|疑点|案子)[^。！？]{0,4}(?:闭环|闭合|汇合|收束|收拢|串联|串起来?|拼合|拼起来?|兜上|归拢|理清了?|清晰了?|明朗了?|浮出水面|尘埃落定|水落石出|大白)了?/u;

/** 谈「线索/真相」系统本身、无具体名物锚点的元叙述/总结句 → 不是真线索。 */
function isMetaSummaryLead(title: string): boolean {
  const t = title.trim();
  return META_ENUMERATION_LEAD.test(t) || META_CLOSURE_LEAD.test(t);
}

/** 质量闸：只让成句的真线索通过，滤掉截断半句/否定/无意义噪声/元叙述总结句。 */
export function isQualityLead(title: string, evidence: string): boolean {
  // ① 截断半句：title 以词中字起头 / 连词·介词起头 / title 与 evidence 都太短
  if (TRUNCATED_LEAD_CHARS.test(title.trimStart())) return false;
  if (LEADING_CONJUNCTION_FRAGMENT.test(title.trimStart())) return false;
  if (title.trim().length < MIN_QUALITY_LEAD_LEN && evidence.trim().length < MIN_QUALITY_LEAD_LEN) return false;
  // ② 否定/无意义噪声：命中任一则丢弃
  if (QUALITY_LEAD_NOISE_PATTERN.test(title) || QUALITY_LEAD_NOISE_PATTERN.test(evidence)) return false;
  if (QUALITY_LEAD_NEGATION_PATTERN.test(title) || QUALITY_LEAD_NEGATION_PATTERN.test(evidence)) return false;
  // ③ 元叙述/总结句标题（三条线索 / 线索闭环了）→ 丢弃
  if (isMetaSummaryLead(title)) return false;
  return true;
}

interface ThreadCandidate {
  readonly type: NarrativeThread["type"];
  readonly title: string;
  readonly evidence: string;
  readonly isDone: boolean;
  /** 声明回收专用：直接指向某条已存在线索的 id（跳过模糊相似度匹配，确保归到同一条、不新建）。 */
  readonly targetThreadId?: string;
}

function buildThreadTrackingUpdate(input: {
  readonly chapter: number;
  readonly candidate: ThreadCandidate;
  readonly existing?: NarrativeThread;
  readonly semanticSummary: ChapterSemanticSummary;
}): ThreadTrackingUpdate {
  const existing = input.existing;
  const id = existing?.id ?? threadIdFromTitle(input.candidate.type, input.candidate.title);
  return {
    id,
    type: input.candidate.type,
    title: existing?.title ?? input.candidate.title,
    status: existing?.status === "done" ? "done" : input.candidate.isDone ? "done" : existing ? "touched" : "open",
    firstSeenChapter: existing?.firstSeenChapter ?? input.chapter,
    lastTouchedChapter: input.chapter,
    evidence: mergeEvidence(existing?.evidence ?? [], [input.candidate.evidence]),
    nextActionHint: input.semanticSummary.nextLead ?? input.candidate.title,
    ...(input.semanticSummary.mentionedCharacterNames.length > 0
      ? { relatedCharacters: input.semanticSummary.mentionedCharacterNames }
      : {}),
    ...(input.semanticSummary.locations.length > 0 ? { relatedLocations: input.semanticSummary.locations } : {}),
  };
}

function mergeExistingThread(existing: NarrativeThread, update: ThreadTrackingUpdate): NarrativeThread {
  return {
    ...existing,
    status: existing.status === "done" ? "done" : update.status,
    lastTouchedChapter: update.lastTouchedChapter,
    evidence: mergeEvidence(existing.evidence, update.evidence),
    ...(update.nextActionHint ? { nextActionHint: update.nextActionHint } : {}),
    relatedCharacters: unique([...(existing.relatedCharacters ?? []), ...(update.relatedCharacters ?? [])]),
    relatedLocations: unique([...(existing.relatedLocations ?? []), ...(update.relatedLocations ?? [])]),
  };
}

function threadFromUpdate(update: ThreadTrackingUpdate): NarrativeThread {
  return {
    id: update.id,
    type: update.type,
    title: update.title,
    status: update.status,
    firstSeenChapter: update.firstSeenChapter,
    lastTouchedChapter: update.lastTouchedChapter,
    evidence: update.evidence,
    ...(update.nextActionHint ? { nextActionHint: update.nextActionHint } : {}),
    ...(update.relatedCharacters ? { relatedCharacters: update.relatedCharacters } : {}),
    ...(update.relatedLocations ? { relatedLocations: update.relatedLocations } : {}),
  };
}

/** 停滞线索提醒文案（中文；供 report / 写手上下文共用）。 */
export function formatStaleThreadMessage(input: {
  readonly type: NarrativeThread["type"];
  readonly title: string;
  readonly lastTouchedChapter: number;
  readonly chaptersSinceTouched: number;
}): string {
  const kind = input.type === "lead" ? "线索" : "意图";
  return `${kind}「${input.title}」已 ${input.chaptersSinceTouched} 章没有推进（上次出现在第 ${input.lastTouchedChapter} 章）。考虑推进或收口，别让它埋了不收。`;
}

/**
 * 停滞线索提醒（r7 起里程碑制）：新停滞头两章立即提醒、长期停滞每 10 章重提一次（见 stale-reminder-policy），
 * 按停滞时长降序、截 MAX_STALE_THREAD_WARNINGS 条。全量底数走 collectStaleBacklog → hygiene report。
 */
function findStaleThreadWarnings(
  threads: readonly NarrativeThread[],
  chapter: number,
  touchedThreadIds: ReadonlySet<string>,
): readonly StaleThreadWarning[] {
  return threads
    .filter((thread) => thread.status === "open" || thread.status === "touched")
    .filter((thread) => !touchedThreadIds.has(thread.id))
    .map((thread) => ({
      thread,
      chaptersSinceTouched: chaptersSinceTouched(thread.lastTouchedChapter, chapter),
    }))
    .filter((entry) => shouldRemindStaleAt(entry.chaptersSinceTouched, THREAD_STALE_THRESHOLD))
    .sort((left, right) => right.chaptersSinceTouched - left.chaptersSinceTouched)
    .slice(0, MAX_STALE_THREAD_WARNINGS)
    .map(({ thread, chaptersSinceTouched }) => ({
      id: thread.id,
      type: thread.type,
      title: thread.title,
      lastTouchedChapter: thread.lastTouchedChapter,
      chaptersSinceTouched,
      message: formatStaleThreadMessage({
        type: thread.type,
        title: thread.title,
        lastTouchedChapter: thread.lastTouchedChapter,
        chaptersSinceTouched,
      }),
    }));
}

/** 全书停滞线索底数（不做里程碑过滤）：条数 + 最久停滞章数，供 digest 如实播报。 */
function collectStaleBacklog(
  threads: readonly NarrativeThread[],
  chapter: number,
  touchedThreadIds: ReadonlySet<string>,
): { readonly count: number; readonly oldestChaptersSinceTouched?: number } {
  const idles = threads
    .filter((thread) => thread.status === "open" || thread.status === "touched")
    .filter((thread) => !touchedThreadIds.has(thread.id))
    .map((thread) => chaptersSinceTouched(thread.lastTouchedChapter, chapter))
    .filter((idle) => idle > THREAD_STALE_THRESHOLD);
  if (idles.length === 0) return { count: 0 };
  return { count: idles.length, oldestChaptersSinceTouched: Math.max(...idles) };
}

const DEDUP_SIMILARITY_THRESHOLD = 0.6;

function findSimilarThread(threads: readonly NarrativeThread[], candidate: ThreadCandidate): NarrativeThread | undefined {
  const normalizedTitle = canonicalThreadTitle(candidate.title);
  return threads.find((thread) => {
    if (thread.type !== candidate.type) return false;
    const values = [thread.title, ...(thread.evidence ?? [])].map((value) => canonicalThreadTitle(value));
    const isActiveThread = thread.status === "open" || thread.status === "touched";
    // B2-2: bigram 近似归并只对 open/touched 线索生效（done/stale 不参与模糊归并）；
    //        完全相同 / 子串包含对所有状态继续生效（保持 "done 再提到仍 touch" 原有行为）
    return values.some((value) => titlesOverlapWithStatus(value, normalizedTitle, isActiveThread));
  });
}

function cleanTitle(value: string): string {
  const clean = cleanText(value)
    .replace(/[。！？!?；;，,\s]+$/u, "")
    .replace(/^(?:他|她)\s*/u, "主角");
  return truncateText(clean, MAX_TITLE_LENGTH);
}

function concreteThreadAnchors(thread: NarrativeThread): readonly string[] {
  const raw = [
    thread.title,
    ...(thread.evidence ?? []),
  ].join(" ");
  const codeAnchors = raw.match(/[A-Za-z]{1,4}[-－—]?\d{1,4}/gu) ?? [];
  const hanAnchors = raw
    .replace(/[A-Za-z]{1,4}[-－—]?\d{1,4}/gu, " ")
    .split(/[^\p{Script=Han}]+/u)
    .flatMap((chunk) => chunk.match(/[\p{Script=Han}]{2,8}/gu) ?? [])
    .filter((item) => !isGenericThreadAnchor(item));
  return unique([...codeAnchors, ...hanAnchors]);
}

function isGenericThreadAnchor(value: string): boolean {
  return /^(?:主角|线索|来源|异常|响动|踪迹|残页|暗号|保管人|证据|记录|编号|查清|确认|继续|已经|仍未|还没|没有)$/u.test(value);
}

function mergeEvidence(previous: readonly string[], additions: readonly string[]): readonly string[] {
  return unique([...previous, ...additions].map((value) => truncateText(value, 120))).slice(-MAX_EVIDENCE);
}

function uniqueById(updates: readonly ThreadTrackingUpdate[]): readonly ThreadTrackingUpdate[] {
  const byId = new Map<string, ThreadTrackingUpdate>();
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

/**
 * B2-2: 带状态感知的标题重叠判断。
 * - allowBigram=true（open/touched）：在完全相同/子串包含之外，还接受：
 *     ① bigram Jaccard 相似度 ≥ 阈值（适合长标题高重叠）。
 * - allowBigram=false（done/stale）：回退到原有纯子串行为，保持「done 再提到仍 touch」的既有语义。
 *
 * 注：尾端 bigram 包含（bigramSuffixContains）已删除——该层会误并「父亲的债/邻居的债」
 * 「工地的响动/楼上的响动」「藏起来的借条/烧掉的借条」等真正不同的线索。
 * 响动类短标题的折叠改由后续 B2-3 展示层聚类处理（非破坏性、可展开）。
 */
function titlesOverlapWithStatus(left: string, right: string, allowBigram: boolean): boolean {
  if (titlesOverlap(left, right)) return true;
  if (!allowBigram) return false;
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  // ① Jaccard 相似度（适合较长/更多 bigram 的标题对）
  if (bigramSimilarity(normalizedLeft, normalizedRight) >= DEDUP_SIMILARITY_THRESHOLD) return true;
  return false;
}

function compactThreadPool(pool: ThreadPool): ThreadPool {
  // 持久层坍缩与 B2-2 去重共用同一套保守安全判据（归一后相同/子串包含；
  // bigram≥0.6 仅对 open/touched 生效）——绝不做题材专名词表驱动的破坏性熔合：
  // 「库房丢账/库房对账」是两条真线索，短标题别名折叠（响动类）归展示层聚类（非破坏、可展开）。
  const groups: NarrativeThread[] = [];
  for (const thread of pool.threads) {
    const active = thread.status === "open" || thread.status === "touched";
    const canonical = canonicalThreadTitle(thread.title);
    const matchIndex = groups.findIndex((existing) => {
      if (existing.type !== thread.type) return false;
      return titlesOverlapWithStatus(
        canonicalThreadTitle(existing.title),
        canonical,
        active,
      );
    });
    if (matchIndex === -1) {
      groups.push(thread);
    } else {
      groups[matchIndex] = mergeSimilarThreads(groups[matchIndex], thread);
    }
  }
  return { threads: groups };
}

function mergeSimilarThreads(left: NarrativeThread, right: NarrativeThread): NarrativeThread {
  const keepLeftTitle = left.title.length <= right.title.length;
  const status = statusRank(left.status) >= statusRank(right.status) ? left.status : right.status;
  return {
    ...left,
    title: keepLeftTitle ? left.title : right.title,
    status,
    firstSeenChapter: Math.min(left.firstSeenChapter, right.firstSeenChapter),
    lastTouchedChapter: Math.max(left.lastTouchedChapter, right.lastTouchedChapter),
    evidence: mergeEvidence(left.evidence, right.evidence),
    nextActionHint: right.nextActionHint ?? left.nextActionHint,
    relatedCharacters: unique([...(left.relatedCharacters ?? []), ...(right.relatedCharacters ?? [])]),
    relatedLocations: unique([...(left.relatedLocations ?? []), ...(right.relatedLocations ?? [])]),
  };
}

function statusRank(status: NarrativeThread["status"]): number {
  if (status === "done") return 3;
  if (status === "touched") return 2;
  if (status === "open") return 1;
  return 0;
}

function buildThreadHygieneReport(input: {
  readonly before: ThreadPool;
  readonly after: ThreadPool;
  readonly updates: readonly ThreadTrackingUpdate[];
  readonly staleBacklog: { readonly count: number; readonly oldestChaptersSinceTouched?: number };
  readonly injectedCount: number;
}): ThreadHygieneReport {
  const previousById = new Map(input.before.threads.map((thread) => [thread.id, thread]));
  const newUpdateCount = input.updates.filter((update) => !previousById.has(update.id)).length;
  const theoreticalCount = input.before.threads.length + newUpdateCount;
  return {
    beforeCount: input.before.threads.length,
    afterCount: input.after.threads.length,
    mergedCount: Math.max(0, theoreticalCount - input.after.threads.length),
    markedDoneCount: input.updates.filter((update) => update.status === "done").length,
    staleWarningCount: input.staleBacklog.count,
    ...(input.staleBacklog.oldestChaptersSinceTouched !== undefined
      ? { oldestStaleChaptersSinceTouched: input.staleBacklog.oldestChaptersSinceTouched }
      : {}),
    injectedCount: input.injectedCount,
  };
}

function canonicalThreadTitle(value: string): string {
  // 仅做题材中立归一：去主角代词/意图动词/时间词/体貌助词/泛词。绝不放题材专名别名
  // （账册/后墙/库房查账等）——那是老测试书残留，会把不同语义的真线索坍缩成一条。
  return normalize(value)
    .replace(/主角|他|她/gu, "")
    .replace(/重新|决定|准备|打算|必须|要去|先去|明日去|明日|夜探|前往|寻找|调查|查清|问清楚|继续|处理/gu, "")
    .replace(/已经|完成|过/gu, "")
    .replace(/来源|线索|的/gu, "");
}

function threadIdFromTitle(type: NarrativeThread["type"], title: string): string {
  return `${type}-${hashText(title)}`;
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
  return clean.length <= maxLength ? clean : `${clean.slice(0, Math.max(0, maxLength - 1))}…`;
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter(Boolean))];
}
