import type { ForeshadowingDeclaration, PendingIntentDeclaration, VerifiedChapterDelta } from "./chapter-delta.js";
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

const MAX_CANDIDATES = 12;
const MAX_EVIDENCE = 5;
const MAX_TITLE_LENGTH = 18;

/** 线索停滞提醒阈值（严格大于才算停滞；与 hook 同口径）。 */
const THREAD_STALE_THRESHOLD = 3;

/** 每章最多提醒的停滞线索条数（按停滞时长降序截断；全量底数走 threadHygieneReport.staleWarningCount）。 */
const MAX_STALE_THREAD_WARNINGS = 8;

const LEAD_KEYWORDS = [
  "线索",
  "指向",
  "暗号",
  "响动",
  "转移",
  "留下",
  "带走",
  "藏在",
  "后墙",
  "明日",
  "失踪",
  "另一页",
  "残页",
  "踪迹",
  "异常",
];

const INTENT_KEYWORDS = [
  "决定",
  "准备",
  "打算",
  "必须",
  "要去",
  "先去",
  "明日去",
  "夜探",
  "查清",
  "问清楚",
  "寻找",
  "前往",
  "隐藏",
  "突破",
  "离开",
  "已经去过",
  "赶到",
  "抵达",
  "完成",
  "做完",
  "拿到",
  "取回",
  "成功藏好",
  "成功进入",
  "已经调查",
  "已经见到",
  "已经交给",
];

const LEAD_DONE_KEYWORDS = [
  "查清",
  "查明",
  "确认",
  "弄清",
  "找到来源",
  "找到证据",
  "证实",
  "验明",
  "对上了",
  "线索闭合",
  "暗号已解",
];

const INTENT_DONE_KEYWORDS = [
  "已经去过",
  "赶到",
  "抵达",
  "已查清",
  "完成",
  "做完",
  "问清楚",
  "拿到",
  "取回",
  "成功藏好",
  "成功进入",
  "已经调查",
  "已经见到",
  "已经交给",
  "成功取回",
];

const HOOK_ONLY_KEYWORDS = [
  "账目",
  "破损信物",
  "封条",
  "密信",
  "血痕",
  "假账本",
];

export function buildThreadTrackingPlan(input: {
  readonly chapter: number;
  readonly draft: string;
  readonly semanticSummary: ChapterSemanticSummary;
  readonly threadPool: ThreadPool;
  readonly protagonistName?: string;
  /**
   * 可选：已核实的章节语义声明。传入时，线索回收/埋设优先走声明——
   * resolvedForeshadowing 指向**已存在**线索（标 done，绝不新建，治线索分裂）；
   * seededForeshadowing 才新建（标题用声明 summary）。缺失时完全走现有正则 fallback（旧行为不变）。
   */
  readonly verifiedDelta?: VerifiedChapterDelta;
}): ThreadTrackingPlan {
  const existingById = new Map(input.threadPool.threads.map((thread) => [thread.id, thread]));
  const declaredCandidates = input.verifiedDelta
    ? extractDeclaredThreadCandidates({ verifiedDelta: input.verifiedDelta, threadPool: input.threadPool })
    : [];
  // 声明可用（有任一条通过校验）时：本章【新埋线索/待办意图】只由声明的 seededForeshadowing/keyLeads/pendingIntents 负责，
  // 正则 extractThreadCandidates 让位——否则正则会从多句同义表述各切一条，把「师父失踪」/「明日查账」
  // 拆成多条（真机冒烟证实）。extractResolvedExistingThreadCandidates 只【触碰已存在线索】、从不新建，无论有无声明都保留。
  const suppressRegexThreads = input.verifiedDelta?.hasAnyVerified ?? false;
  const regexCandidates = extractThreadCandidates(input);
  // 声明候选放最前：uniqueById 保留首个，声明的回收/埋设优先于正则从正文猜的同一线索。
  const candidates = [
    ...declaredCandidates,
    ...extractResolvedExistingThreadCandidates(input),
    ...(suppressRegexThreads ? [] : regexCandidates),
  ];
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
    candidates.push({
      type: target.type,
      title: target.title,
      evidence: truncateText(resolved.quote, 120),
      isDone: true,
      targetThreadId: target.id,
    });
  }
  const newLeadDeclarations = [
    ...input.verifiedDelta.seededForeshadowing,
    ...input.verifiedDelta.keyLeads,
  ];
  for (const declared of newLeadDeclarations) {
    const title = cleanTitle(declared.summary);
    if (!title) continue;
    if (!isQualityLead(title, declared.quote)) continue;
    candidates.push({
      type: "lead",
      title,
      evidence: truncateText(declared.quote, 120),
      isDone: false,
    });
  }
  for (const declared of input.verifiedDelta.pendingIntents) {
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

export function expireStaleIntents(input: {
  readonly pool: ThreadPool;
  readonly chapter: number;
}): { readonly pool: ThreadPool; readonly expired: readonly ExpiredIntentThread[] } {
  const expired: ExpiredIntentThread[] = [];
  const threads = input.pool.threads.map((thread) => {
    if (thread.type !== "intent" || thread.status !== "open") return thread;
    const idleChapters = chaptersSinceTouched(thread.lastTouchedChapter, input.chapter);
    if (idleChapters < 9) return thread;
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

function extractResolvedExistingThreadCandidates(input: {
  readonly draft: string;
  readonly threadPool: ThreadPool;
}): readonly ThreadCandidate[] {
  const sentences = splitSentences(input.draft);
  const candidates: ThreadCandidate[] = [];
  for (const thread of input.threadPool.threads) {
    if (thread.status !== "open" && thread.status !== "touched") continue;
    const evidence = sentences.find((sentence) => resolvesExistingThread(sentence, thread));
    if (!evidence) continue;
    candidates.push({
      type: thread.type,
      title: thread.title,
      evidence: truncateText(evidence, 120),
      isDone: true,
    });
  }
  return candidates;
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

function extractThreadCandidates(input: {
  readonly draft: string;
  readonly semanticSummary: ChapterSemanticSummary;
  readonly protagonistName?: string;
}): readonly ThreadCandidate[] {
  const sentences = splitSentences(input.draft);
  const sources: ThreadCandidateSource[] = [
    ...(input.semanticSummary.nextLead ? [{ type: "lead" as const, text: input.semanticSummary.nextLead }] : []),
    ...(input.semanticSummary.discovery && containsAny(input.semanticSummary.discovery, LEAD_KEYWORDS)
      ? [{ type: "lead" as const, text: input.semanticSummary.discovery }]
      : []),
    ...(input.semanticSummary.decision ? [{ type: "intent" as const, text: input.semanticSummary.decision }] : []),
    ...sentences
      .filter((sentence) => containsAny(sentence, LEAD_KEYWORDS))
      .map((text) => ({ type: "lead" as const, text })),
    ...sentences
      .filter((sentence) => containsAny(sentence, INTENT_KEYWORDS))
      .filter((sentence) => isThreadworthyIntentSentence(sentence, input.protagonistName ?? input.semanticSummary.protagonist))
      .map((text) => ({ type: "intent" as const, text })),
  ];
  const candidates: ThreadCandidate[] = [];
  for (const source of sources) {
    const title = titleForSource(source, input.protagonistName ?? input.semanticSummary.protagonist);
    if (!title) continue;
    if (source.type === "lead" && !isQualityLead(title, source.text)) continue;
    if (candidates.some((candidate) => candidate.type === source.type && titlesOverlap(candidate.title, title))) continue;
    candidates.push({
      type: source.type,
      title,
      evidence: truncateText(source.text, 120),
      isDone: isDoneSource(source.text, source.type),
    });
    if (candidates.length >= MAX_CANDIDATES) break;
  }
  return candidates;
}

// 退场尾动作：转身/起身/说完/话音落…紧接 离开/离去/走开/远去。这是舞台指示，不是被追踪的故事意图。
const STAGE_EXIT_CODA = /(?:转身|转头|起身|站起身?|说完|说罢|话音.{0,3}落|语毕|话毕|拍.{0,3}手|顿了顿).{0,6}(?:离开|离去|走开|走出|走远|远去)/u;
// 目的性意图词：带这些时「离开/赶到/抵达」是有指向的真意图，退场尾动作判定让位（不误杀「决定离开X去查Y」）。
const GOAL_INTENT_WORDS = /决定|打算|必须|要去|先去|明日去|夜探|查清|查明|问清楚|寻找|前往|调查|追查|核对|确认/u;

export function isThreadworthyIntentSentence(sentence: string, protagonistName: string | undefined): boolean {
  const text = sentence.trim();
  if (isAdministrativeIntentNoise(text)) return false;
  // 退场尾动作（「他说完，转身离开」）若不带任何目的性意图词 = 舞台指示，非可追踪意图（Codex 复测：垃圾线索「苏晚说完，转身离开」）。
  if (STAGE_EXIT_CODA.test(text) && !GOAL_INTENT_WORDS.test(text)) return false;
  if (protagonistName && text.includes(protagonistName)) return true;
  if (/(?:^|[。！？\n])(?:他|她|自己|少年|少女|主角).{0,12}(?:决定|打算|必须|要去|查清|问清楚|寻找|前往|离开|赶到|抵达|拿到|取回|继续|确认)/u.test(text)) return true;
  return /(?:夜探|明日去)/u.test(text);
}

function isAdministrativeIntentNoise(text: string): boolean {
  return /准备好了的话|先去酒店|放行李|分批次.{0,8}分阶段|法律过户|资产交割|第一阶段.{0,12}程序.{0,8}完成|程序就算.{0,8}完成|等着.{0,10}做决定|自己做决定/u.test(text);
}

interface ThreadCandidateSource {
  readonly type: NarrativeThread["type"];
  readonly text: string;
}

interface ThreadCandidate {
  readonly type: NarrativeThread["type"];
  readonly title: string;
  readonly evidence: string;
  readonly isDone: boolean;
  /** 声明回收专用：直接指向某条已存在线索的 id（跳过模糊相似度匹配，确保归到同一条、不新建）。 */
  readonly targetThreadId?: string;
}

function titleForSource(source: ThreadCandidateSource, protagonistName: string | undefined): string | undefined {
  if (source.type === "lead") return leadTitle(source.text);
  return intentTitle(source.text, protagonistName);
}

// 线索标题里的核心名词锚点——半句截断时从这里重新起头，避免标题从词中切起（rerun2 P2）。
const LEAD_TITLE_ANCHORS = /(?:线索|踪迹|异常|响动|失踪|残页|暗号|账册|转移|带走)/u;

/**
 * 若捕获的标题在原文里「前一个字仍是汉字」（= 前向窗口把一个词切成了两半，如『确认』被切成『认』、
 * 『未来/后来』被切成『来』），就从标题内第一个核心名词锚点重新起头，去掉切半的前缀（rerun2 P2：半句截断）。
 * 只在确实被切（前字是汉字、且锚点不在词首）时重锚，正常起于句首/标点后的标题原样保留。
 */
export function reanchorTruncatedLeadTitle(text: string, raw: string, matchIndex: number): string {
  if (matchIndex > 0 && /\p{Script=Han}/u.test(text[matchIndex - 1] ?? "")) {
    const kw = LEAD_TITLE_ANCHORS.exec(raw);
    if (kw && kw.index !== undefined && kw.index > 0) return raw.slice(kw.index);
  }
  return raw;
}

function leadTitle(text: string): string | undefined {
  if (isHookOnly(text)) return undefined;
  if (/后墙.{0,12}异常响动/u.test(text)) return "后墙异常响动";
  const patterns = [
    /明日(?:清晨|傍晚|夜里)?[\p{Script=Han}]{0,8}(?:转移|带走)[\p{Script=Han}]{0,8}/u,
    /[\p{Script=Han}]{0,8}暗号指向[\p{Script=Han}]{1,8}/u,
    /[\p{Script=Han}]{0,8}账册暗号指向[\p{Script=Han}]{1,8}/u,
    /另一页[\p{Script=Han}]{0,8}残页(?:被)?带走/u,
    /[\p{Script=Han}]{0,8}(?:线索|踪迹|异常|响动|失踪|残页)[\p{Script=Han}]{0,8}/u,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.[0] && match.index !== undefined) return cleanTitle(reanchorTruncatedLeadTitle(text, match[0], match.index));
  }
  return undefined;
}

function intentTitle(text: string, protagonistName: string | undefined): string | undefined {
  const intentWords = "(?:已经去过|已经调查|已经见到|已经交给|成功藏好|成功进入|准备|打算|决定|必须|要去|先去|明日去|夜探|查清|问清楚|寻找|前往|隐藏|突破|离开|赶到|抵达|完成|做完|拿到|取回)";
  const patterns = [
    new RegExp(`[\\p{Script=Han}]{1,6}.{0,8}${intentWords}.{0,14}`, "u"),
    new RegExp(`${intentWords}.{0,14}`, "u"),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.[0]) return normalizeIntentTitle(match[0], protagonistName);
  }
  return undefined;
}

function normalizeIntentTitle(value: string, protagonistName: string | undefined): string {
  const actor = protagonistName?.trim() || "主角";
  const clean = cleanTitle(value)
    .replace(/^(?:他|她|主角)/u, actor)
    .replace(/^必须/u, `${actor}必须`)
    .replace(/^准备/u, `${actor}准备`)
    .replace(/^打算/u, `${actor}打算`)
    .replace(/^决定/u, `${actor}决定`)
    .replace(/^要去/u, `${actor}要去`)
    .replace(/^先去/u, `${actor}先去`)
    .replace(/^明日去/u, `${actor}明日去`)
    .replace(/^夜探/u, `${actor}夜探`)
    .replace(/^查清/u, `${actor}查清`)
    .replace(/^问清楚/u, `${actor}问清楚`)
    .replace(/^寻找/u, `${actor}寻找`)
    .replace(/^前往/u, `${actor}前往`)
    .replace(/^隐藏/u, `${actor}隐藏`)
    .replace(/^突破/u, `${actor}突破`)
    .replace(/^离开/u, `${actor}离开`)
    .replace(/^已经去过/u, `${actor}已经去过`)
    .replace(/^赶到/u, `${actor}赶到`)
    .replace(/^抵达/u, `${actor}抵达`)
    .replace(/^完成/u, `${actor}完成`)
    .replace(/^做完/u, `${actor}做完`)
    .replace(/^拿到/u, `${actor}拿到`)
    .replace(/^取回/u, `${actor}取回`)
    .replace(/^成功藏好/u, `${actor}成功藏好`)
    .replace(/^成功进入/u, `${actor}成功进入`)
    .replace(/^已经调查/u, `${actor}已经调查`)
    .replace(/^已经见到/u, `${actor}已经见到`)
    .replace(/^已经交给/u, `${actor}已经交给`);
  return clean;
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

function isHookOnly(text: string): boolean {
  const clean = cleanText(text);
  return HOOK_ONLY_KEYWORDS.includes(clean);
}

function cleanTitle(value: string): string {
  const clean = cleanText(value)
    .replace(/[。！？!?；;，,\s]+$/u, "")
    .replace(/^(?:他|她)\s*/u, "主角");
  return truncateText(clean, MAX_TITLE_LENGTH);
}

function containsAny(value: string, keywords: readonly string[]): boolean {
  return keywords.some((keyword) => value.includes(keyword));
}

function isDoneSource(value: string, type: NarrativeThread["type"]): boolean {
  if (/没有|还没|尚未|仍未|并未|未曾|未能.{0,6}(?:问清楚|查清|找到|解决|完成|确认完毕|成功取回)/u.test(value)) return false;
  if (/未(?:问清楚|查清|找到|解决|完成|确认完毕|成功取回)/u.test(value)) return false;
  if (/(?:准备|明日|必须|决定|打算|要去|先去|还要|需要).{0,10}(?:查清|查明|确认|弄清|问清楚|完成|抵达|赶到|拿到|取回|进入)/u.test(value)) {
    return false;
  }
  return containsAny(value, type === "lead" ? LEAD_DONE_KEYWORDS : INTENT_DONE_KEYWORDS);
}

const UNRESOLVED_THREAD_PATTERN = /(?:还没|没有|并未|未曾|未能|不知道|不清楚|无法确认|不能确认|尚未).{0,12}(?:查清|查明|确认|弄清|问清楚|找到|对上|解决|完成|保管人|来源|指向)/u;
const ANSWERED_LEAD_PATTERN = /(?:查清|查明|确认|弄清|证实|验明|对上了?|对应|指向|来源是|保管人[，,、]?(?:是|就是)|(?:^|[，。！？；;])[^。！？；;]{0,24}(?:是|就是|原来是|其实是)[^。！？；;]{1,24})/u;

function resolvesExistingThread(sentence: string, thread: NarrativeThread): boolean {
  if (UNRESOLVED_THREAD_PATTERN.test(sentence)) return false;
  if (!threadOverlapsSentence(thread, sentence)) return false;
  if (thread.type === "intent") return isDoneSource(sentence, "intent");
  return isDoneSource(sentence, "lead") || ANSWERED_LEAD_PATTERN.test(sentence);
}

function threadOverlapsSentence(thread: NarrativeThread, sentence: string): boolean {
  return concreteThreadAnchors(thread).some((anchor) => sentence.includes(anchor));
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

function splitSentences(content: string): readonly string[] {
  return content
    .split(/(?<=[。！？!?；;])|\n+/u)
    .map(cleanText)
    .filter(Boolean);
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
