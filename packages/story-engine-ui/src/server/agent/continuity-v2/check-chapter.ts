/**
 * 查错 v2：拆说法 → 对前文 → 逐条判（2026-10-10 重新设计「作者写、AI 管账」第 1 期）。
 *
 * 原则：正文是唯一真相。不拿可能记错的账本当裁判，拿本章原句去对前文原句。
 * 1. 拆说法（模型）：从本章抽出可核对的具体说法，每条附逐字原句和其中的人名 / 物名 / 地名。
 * 2. 对前文（确定性）：按名字在前面各章与本章更早的位置找相关原句，最近的优先。
 * 3. 逐条判（模型，分批）：本章这句 vs 给出的前文原句，判矛不矛盾；冲突的前文那句必须逐字出自给出的原句，否则不收。
 *
 * 旧版（一次性把事实和前文丢给模型自由找）在 8 本审过的书上查全 17%、查准下限 25%。
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { resolveConfiguredChatModel, streamChatModelToText } from "../../lib/llm-client.js";

export type CheckCallModel = (messages: readonly { readonly role: "system" | "user"; readonly content: string }[]) => Promise<string>;

export type ClaimKind = "object" | "place" | "time" | "identity" | "knowledge" | "number" | "event";

export interface ChapterClaim {
  readonly id: string;
  readonly quote: string;
  readonly claim: string;
  readonly terms: readonly string[];
  readonly kind: ClaimKind;
}

export interface EvidenceSentence {
  /** 第几章；本章更早的位置记本章章号。 */
  readonly chapter: number;
  readonly sameChapter: boolean;
  readonly text: string;
}

export interface ContinuityIssueV2 {
  readonly quote: string;
  readonly earlierQuote: string;
  readonly earlierChapter: number;
  readonly reason: string;
  readonly kind: ClaimKind;
  /** 复核把握：sure＝确定是矛盾（排前面）；maybe＝可能（收起来给作者看）。未复核时缺省。 */
  readonly confidence?: "sure" | "maybe";
}

export interface CheckChapterResult {
  readonly claims: number;
  readonly checkedClaims: number;
  readonly issues: readonly ContinuityIssueV2[];
  /** 没跑成的步骤（如实说明）。 */
  readonly failures: readonly string[];
  /** 过程记录（评测诊断用）：每条说法和给它找到的前文。 */
  readonly trace?: readonly { readonly claim: ChapterClaim; readonly evidence: readonly EvidenceSentence[] }[];
}

const KINDS = new Set<ClaimKind>(["object", "place", "time", "identity", "knowledge", "number", "event"]);
const MAX_CLAIMS = 60;
const EVIDENCE_PER_CLAIM = 7;
const CLAIMS_PER_BATCH = 14;
const MIN_TERM_CHARS = 2;

const normalize = (text: string): string => text.replace(/\s+/gu, "");

const SELF_DISMISSED = /不矛盾|并不矛盾|没有矛盾|无矛盾|一致[，。；,;]?(?:没有|无|不)|说法一致|前后一致|不冲突|并不冲突|不算矛盾|可以解释|说得通/u;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function parseJson(text: string): Record<string, unknown> {
  const match = text.match(/\{[\s\S]*\}/u);
  if (!match) throw new Error("模型输出不是 JSON");
  return asRecord(JSON.parse(match[0])) ?? {};
}

/** 句子切分：保留引号内的完整句。 */
export function splitSentences(text: string): readonly string[] {
  const out: string[] = [];
  for (const paragraph of text.split(/\n+/u)) {
    const parts = paragraph.match(/[^。！？!?…]+[。！？!?…]*[”」』"]?/gu) ?? [];
    for (const part of parts) {
      const sentence = part.trim();
      if (sentence.length >= 4) out.push(sentence);
    }
  }
  return out;
}

// ---------- 1. 拆说法 ----------

export function buildClaimMessages(chapter: number, draftBody: string): { role: "system" | "user"; content: string }[] {
  const system = [
    "你是长篇小说的核对员。从【本章正文】里找出所有「后文必须和前文一致」的具体说法，每条对应正文里的一句原文。重点找：",
    "① 物件：在哪、在谁手里、什么样（材质颜色、上面写着什么、坏没坏、有几个）；",
    "② 人物行踪：在哪、什么时候来 / 走、住在哪、和谁住；",
    "③ 时间：提到过去的事（几天前、昨天、上次、那天）、日期星期、期限还剩几天、几点；",
    "④ 身份：年龄、职业、亲属关系、称呼、谁是谁；",
    "⑤ 认知：人物说出或想到的情报——他该不该已经知道；",
    "⑥ 数字：数量、编号、金额、距离；",
    "⑦ 事件：人物提到前文发生过的事（谁做了什么、说了什么）；",
    "⑧ 搬动东西的动作：拿出、放回、塞进、摸出、交给、锁进、带走——它们说明东西此刻在哪；",
    "⑨ 时辰与天色：几点、上午 / 傍晚、天黑没黑、日头在哪。",
    "不要列情绪、景色、比喻。",
    `每条：quote 逐字抄正文里的那一句；claim 用一句话说它断言了什么；terms 列出其中的人名 / 物名 / 地名（照正文写法，2～6 字）；kind 选 object|place|time|identity|knowledge|number|event。最多 ${MAX_CLAIMS} 条，宁可多列。`,
    "只输出一个 JSON：{\"claims\":[{\"quote\":\"\",\"claim\":\"\",\"terms\":[\"\"],\"kind\":\"object\"}]}，不要解释。",
  ].join("\n");
  return [{ role: "system", content: system }, { role: "user", content: `【第 ${chapter} 章正文】\n${draftBody}` }];
}

export function parseClaims(text: string, draftBody: string): readonly ChapterClaim[] {
  const parsed = parseJson(text);
  const raw = Array.isArray(parsed.claims) ? parsed.claims : [];
  const body = normalize(draftBody);
  const out: ChapterClaim[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const record = asRecord(item);
    if (!record) continue;
    const quote = String(record.quote ?? "").trim();
    if (normalize(quote).length < 4 || !body.includes(normalize(quote)) || seen.has(normalize(quote))) continue;
    seen.add(normalize(quote));
    const terms = (Array.isArray(record.terms) ? record.terms : typeof record.terms === "string" ? String(record.terms).split(/[,，、\s]+/u) : [])
      .map((term) => String(term ?? "").trim())
      .filter((term) => term.length >= MIN_TERM_CHARS && term.length <= 8);
    const kindRaw = String(record.kind ?? "").trim().toLowerCase() as ClaimKind;
    out.push({
      id: `C${out.length + 1}`,
      quote,
      claim: String(record.claim ?? "").trim() || quote,
      terms: [...new Set(terms)],
      kind: KINDS.has(kindRaw) ? kindRaw : "event",
    });
    if (out.length >= MAX_CLAIMS) break;
  }
  return out;
}

// ---------- 2. 对前文 ----------

export interface EarlierText {
  /** 前面各章（近的在前）。 */
  readonly chapters: readonly { readonly chapter: number; readonly sentences: readonly string[] }[];
}

export async function readEarlierChapters(projectDir: string, chapter: number, limit = 30): Promise<EarlierText> {
  const files = await readdir(join(projectDir, "chapters")).catch(() => [] as string[]);
  const numbers = files
    .map((file) => /^(\d{4})\.md$/u.exec(file))
    .filter((match): match is RegExpExecArray => Boolean(match))
    .map((match) => Number(match[1]))
    .filter((n) => n < chapter)
    .sort((a, b) => b - a)
    .slice(0, limit);
  const chapters = [];
  for (const n of numbers) {
    const raw = await readFile(join(projectDir, "chapters", `${String(n).padStart(4, "0")}.md`), "utf-8").catch(() => "");
    chapters.push({ chapter: n, sentences: splitSentences(raw.replace(/^#[^\n]*\n/u, "")) });
  }
  return { chapters };
}

function bigrams(text: string): Set<string> {
  const chars = Array.from(normalize(text));
  const out = new Set<string>();
  for (let i = 0; i + 1 < chars.length; i += 1) out.add(chars[i] + chars[i + 1]);
  return out;
}

/**
 * 给一条说法找前文原句：含它的名字的句子，按「命中几个名字 + 和说法字面相近」打分，近章优先；
 * 本章里排在这句之前、提到同样名字的句子也算（章内前后打架占标注的四分之一）。
 */
/**
 * 名字的检索形：原样，再加去掉修饰的短形（「樟木匣」→「木匣」，「待修的表」→「表」不要，单字太泛）。
 * 模型给的名字常比前文写法长（第一版评测：前文没找到的 21 条里大半是这个原因）。
 */
export function searchForms(term: string): readonly string[] {
  const forms = new Set<string>([term]);
  const core = term.split(/的/u).at(-1) ?? term;
  if (core.length >= 2) forms.add(core);
  if (core.length >= 3) forms.add(core.slice(-2));
  return [...forms].filter((form) => form.length >= 2);
}

export function findEvidence(
  claim: ChapterClaim,
  earlier: EarlierText,
  chapter: number,
  chapterSentences: readonly string[],
): readonly EvidenceSentence[] {
  const ownIndex = chapterSentences.findIndex((sentence) => normalize(sentence).includes(normalize(claim.quote)) || normalize(claim.quote).includes(normalize(sentence)));
  // 往回看的顺序：本章这句之前（由近到远），再前面各章（由近到远、章内由后往前）。
  const backward: EvidenceSentence[] = [
    ...chapterSentences.slice(0, ownIndex > 0 ? ownIndex : 0).reverse().map((text) => ({ chapter, sameChapter: true, text })),
    ...earlier.chapters.flatMap((item) => [...item.sentences].reverse().map((text) => ({ chapter: item.chapter, sameChapter: false, text }))),
  ];
  if (backward.length === 0) return [];
  const forms = claim.terms.map(searchForms);
  // 名字越少见越有区分力（第一版评测：「周婶」「林溪」这类满篇都是的名字把真正相关的句子挤掉了）。
  const weights = forms.map((group) => {
    const df = backward.filter((item) => group.some((form) => item.text.includes(form))).length;
    return df === 0 ? 0 : Math.log((backward.length + 1) / df);
  });
  const claimGrams = bigrams(`${claim.claim}${claim.quote}`);
  const picked: EvidenceSentence[] = [];
  const seen = new Set<string>();
  const take = (item: EvidenceSentence | undefined) => {
    if (!item) return;
    const key = normalize(item.text);
    if (seen.has(key) || picked.length >= EVIDENCE_PER_CLAIM) return;
    seen.add(key);
    picked.push(item);
  };
  // ① 每个名字「最近一次被提到」的那句：东西在哪、人在哪，要对的是最近一次的说法。少见的名字先取。
  forms
    .map((group, index) => ({ group, weight: weights[index] }))
    .filter((item) => item.weight > 0)
    .sort((a, b) => b.weight - a.weight)
    .forEach(({ group }) => take(backward.find((item) => group.some((form) => item.text.includes(form)))));
  // ② 再按「少见名字命中 + 和说法字面相近」补满；名字都没命中的只收字面很近的。
  const scored = backward.map((item, order) => {
    let termScore = 0;
    forms.forEach((group, index) => { if (group.some((form) => item.text.includes(form))) termScore += weights[index]; });
    let overlap = 0;
    for (const gram of bigrams(item.text)) if (claimGrams.has(gram)) overlap += 1;
    return { item, score: termScore * 3 + Math.min(overlap, 12) - order / 2000, termScore, overlap };
  }).filter((entry) => entry.termScore > 0 || entry.overlap >= 6);
  scored.sort((a, b) => b.score - a.score);
  for (const entry of scored) take(entry.item);
  return picked;
}

// ---------- 3. 逐条判 ----------

export function buildVerifyMessages(
  chapter: number,
  batch: readonly { readonly claim: ChapterClaim; readonly evidence: readonly EvidenceSentence[] }[],
  timeline: readonly string[],
): { role: "system" | "user"; content: string }[] {
  const system = [
    "你是长篇小说的核对员。下面每条给出【本章说法】和几句【前文原句】（标了第几章；「本章前文」是本章更早的位置）。判断本章说法和前文是否矛盾：",
    "· 同一件东西的位置、持有人、样子、内容、数量对不上；",
    "· 人物行踪、住处、身份、年龄、关系、称呼对不上；",
    "· 时间推算错：前文写的事过了几天，本章还说成「昨天」「前天」或别的天数；期限的剩余天数算错；",
    "· 人物说出了他按前文还不可能知道的事；",
    "· 本章把前文写过的事说成另一个样子。",
    "下面这些不算矛盾：前文或本章写了变化过程（修好了、搬走了、改了主意）；人物明确在撒谎、猜测或记错；只是补充细节；说法不同但并不冲突；前文没提到的新信息。",
    "本来就会变的状态，在不同的时候 / 场合不一样，不算矛盾：门开着还是关着、灯亮没亮、钟点、天气、谁在窗口值班、桌上摆了什么。只有同一时刻同一场面里前后打架才算。",
    "不该变的东西对不上才算矛盾：刻的字、写的内容、日期、年龄、身份、亲属关系、某样关键东西在谁手里（没写交出去就还在原处）、已经发生过的事的经过、过去的天数。",
    "只报有把握的矛盾。每条矛盾给：id；earlierQuote＝从给出的前文原句里逐字抄出冲突的那一句（必须是给出的原句之一，或其中连续的一段）；reason＝一句话说哪里对不上。",
    "只输出一个 JSON：{\"contradictions\":[{\"id\":\"C1\",\"earlierQuote\":\"\",\"reason\":\"\"}]}；都不矛盾就给空数组。",
  ].join("\n");
  const blocks = batch.map(({ claim, evidence }) => [
    `【${claim.id}】本章说法：${claim.quote}（${claim.claim}）`,
    ...evidence.map((item) => `  - ${item.sameChapter ? "本章前文" : `第 ${item.chapter} 章`}：${item.text}`),
  ].join("\n"));
  const user = [
    `【本章】第 ${chapter} 章`,
    timeline.length > 0 ? `【各章开头（判断过了几天用）】\n${timeline.join("\n")}` : "",
    blocks.join("\n\n"),
  ].filter(Boolean).join("\n\n");
  return [{ role: "system", content: system }, { role: "user", content: user }];
}

/** 冲突的前文那句必须真在给出的原句里（逐字，或九成两字片段命中某一句）。 */
function locateEarlierQuote(earlierQuote: string, evidence: readonly EvidenceSentence[]): EvidenceSentence | undefined {
  const target = normalize(earlierQuote);
  if (target.length < 4) return undefined;
  const exact = evidence.find((item) => normalize(item.text).includes(target) || target.includes(normalize(item.text)));
  if (exact) return exact;
  const grams = bigrams(target);
  return evidence.find((item) => {
    const own = bigrams(item.text);
    let shared = 0;
    for (const gram of grams) if (own.has(gram)) shared += 1;
    return grams.size > 0 && shared / grams.size >= 0.9;
  });
}

export function parseVerdicts(
  text: string,
  batch: readonly { readonly claim: ChapterClaim; readonly evidence: readonly EvidenceSentence[] }[],
): readonly ContinuityIssueV2[] {
  const parsed = parseJson(text);
  const raw = Array.isArray(parsed.contradictions) ? parsed.contradictions : Array.isArray(parsed.results) ? parsed.results : [];
  const byId = new Map(batch.map((item) => [item.claim.id, item]));
  const out: ContinuityIssueV2[] = [];
  for (const item of raw) {
    const record = asRecord(item);
    if (!record) continue;
    if (record.verdict !== undefined && !/contradiction|矛盾/u.test(String(record.verdict))) continue;
    // 拿不准的、理由里自己说「一致 / 不矛盾」的不收（评测：误报里有一类是核对员自我否定的条目）。
    if (SELF_DISMISSED.test(String(record.reason ?? ""))) continue;
    const entry = byId.get(String(record.id ?? "").trim().toUpperCase());
    if (!entry) continue;
    const located = locateEarlierQuote(String(record.earlierQuote ?? ""), entry.evidence);
    if (!located) continue;
    out.push({
      quote: entry.claim.quote,
      earlierQuote: located.text,
      earlierChapter: located.chapter,
      reason: String(record.reason ?? "").trim(),
      kind: entry.claim.kind,
    });
  }
  return out;
}

// ---------- 编排 ----------

export async function checkChapterAgainstEarlierText(input: {
  readonly projectDir: string;
  readonly chapter: number;
  readonly draftBody: string;
  readonly callModel: CheckCallModel;
  /** 逐条判用的调用；缺省同 callModel。 */
  readonly verifyCallModel?: CheckCallModel;
  /** 测试注入；缺省从书目录读前面各章。 */
  readonly earlier?: EarlierText;
}): Promise<CheckChapterResult> {
  const failures: string[] = [];
  let claims: readonly ChapterClaim[] = [];
  try {
    claims = parseClaims(await input.callModel(buildClaimMessages(input.chapter, input.draftBody)), input.draftBody);
  } catch (error) {
    return { claims: 0, checkedClaims: 0, issues: [], failures: [`拆说法没成：${error instanceof Error ? error.message : String(error)}`] };
  }
  const earlier = input.earlier ?? await readEarlierChapters(input.projectDir, input.chapter);
  const chapterSentences = splitSentences(input.draftBody);
  const withEvidence = claims
    .map((claim) => ({ claim, evidence: findEvidence(claim, earlier, input.chapter, chapterSentences) }))
    .filter((item) => item.evidence.length > 0);
  const timeline = [...earlier.chapters].slice(0, 6).reverse()
    .map((item) => `第 ${item.chapter} 章开头：${item.sentences.slice(0, 2).join("").slice(0, 80)}`);
  if (chapterSentences.length > 0) timeline.push(`第 ${input.chapter} 章（本章）开头：${chapterSentences.slice(0, 2).join("").slice(0, 80)}`);

  const batches: (typeof withEvidence)[] = [];
  for (let i = 0; i < withEvidence.length; i += CLAIMS_PER_BATCH) batches.push(withEvidence.slice(i, i + CLAIMS_PER_BATCH));
  const settled = await Promise.allSettled(batches.map(async (batch) => parseVerdicts(await (input.verifyCallModel ?? input.callModel)(buildVerifyMessages(input.chapter, batch, timeline)), batch)));
  const issues: ContinuityIssueV2[] = [];
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") issues.push(...result.value);
    else failures.push(`第 ${index + 1} 批核对没成：${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
  });
  return { claims: claims.length, checkedClaims: withEvidence.length, issues, failures, trace: claims.map((claim) => ({ claim, evidence: withEvidence.find((item) => item.claim.id === claim.id)?.evidence ?? [] })) };
}

/**
 * 核对用的模型调用（qualityCheck 槽）：关思考、要 JSON、低随机性——同一章每次核出来应当一样
 * （评测：沿用 0.7 时同一本书两次跑命中数差一倍）。失败自动重试一次。
 */
export const callConfiguredCheckerModel: CheckCallModel = (messages) => callChecker(messages, false);

/** 逐条判（要推算天数、年龄、谁该知道什么）：开思考判得准不准，用评测比（CHECKER_VERIFY_THINKING=1）。 */
export const callConfiguredVerifierModel: CheckCallModel = (messages) => callChecker(messages, process.env.CHECKER_VERIFY_THINKING === "1");

async function callChecker(messages: Parameters<CheckCallModel>[0], thinking: boolean): Promise<string> {
  const once = async () => {
    const resolved = await resolveConfiguredChatModel("qualityCheck");
    const { content } = await streamChatModelToText({
      configured: { ...resolved, thinking },
      messages: messages.map((message) => ({ role: message.role, content: message.content })),
      temperature: 0.1,
      responseFormat: { type: "json_object" },
    });
    if (!content.trim()) throw new Error("模型返回了空内容");
    return content;
  };
  try {
    return await once();
  } catch {
    return once();
  }
}

// ---------- 整章通读版：前文全文 + 本章，一次找矛盾 ----------

/** 前文全文最多给多少字（再长只给最近的若干章，远处的靠检索版补）。 */
const FULL_CONTEXT_MAX_CHARS = 90_000;

export type FullReadFocus = "objects" | "people" | "time-knowledge";

const FOCUS_LINES: Record<FullReadFocus, string> = {
  objects: "这一遍只盯东西：每样物件此刻在哪、在谁手里、什么样、写着什么、有几个；人物身上带的东西是否凭空出现或消失；同一场面里摆设前后是否一致。",
  people: "这一遍只盯人：人物在哪、住在哪、和谁住、身份、年龄、职业、亲属关系、称呼；同一人前后说法是否一致；人物在同一场面里的位置和动作前后是否接得上。",
  "time-knowledge": "这一遍只盯时间和信息：提到过去的事说的是几天前、昨天还是上周，按前文过了几天算对不对；期限还剩几天；钟点和天色前后接不接得上；人物有没有说出他按前文还不可能知道的事；本章把前文发生过的事说成了别的样子。",
};

/**
 * 整章通读的提示词：前文全文 + 本章在前（几遍共用、吃服务商缓存），「这一遍盯什么」放在最后。
 */
export function buildFullReadMessages(
  chapter: number,
  draftBody: string,
  earlier: EarlierText,
  focus: FullReadFocus,
): { role: "system" | "user"; content: string }[] {
  const ordered = [...earlier.chapters].sort((a, b) => a.chapter - b.chapter);
  let budget = FULL_CONTEXT_MAX_CHARS;
  const kept: typeof ordered = [];
  for (const item of [...ordered].reverse()) {
    const size = item.sentences.join("").length;
    if (size > budget) break;
    budget -= size;
    kept.unshift(item);
  }
  const system = [
    "你是长篇小说的连续性审读员。先读【前文】，再读【本章】，找出本章里和前文（或和本章更早的位置）对不上的地方。",
    "写了变化过程的（修好了、搬走了、改主意）、人物明确在撒谎或记错的、只是补充细节的，不算。本来会变的状态（门开关、灯、钟点、值班的人）在不同时候不一样也不算。",
    "每条：quote 逐字抄本章里有问题的那一句；earlierQuote 逐字抄前文（或本章更早处）和它冲突的那一句；earlierChapter 写那句在第几章；reason 一句话说哪里对不上。两句都必须是原文，抄不出原文的不要报。",
    "只输出一个 JSON：{\"contradictions\":[{\"quote\":\"\",\"earlierQuote\":\"\",\"earlierChapter\":1,\"reason\":\"\"}]}；没有就给空数组。",
  ].join("\n");
  const user = [
    "【前文】",
    ...kept.map((item) => `第 ${item.chapter} 章\n${item.sentences.join("")}`),
    "",
    `【本章】第 ${chapter} 章\n${draftBody}`,
    "",
    `【这一遍的任务】${FOCUS_LINES[focus]}`,
  ].join("\n\n");
  return [{ role: "system", content: system }, { role: "user", content: user }];
}

function containsQuote(haystack: string, quote: string): boolean {
  const target = normalize(quote);
  if (target.length < 4) return false;
  if (haystack.includes(target)) return true;
  const grams = bigrams(target);
  if (grams.size === 0) return false;
  // 模型抄原句常改一两个字：九成两字片段落在同一个 60 字窗口里也算。
  for (let start = 0; start < haystack.length; start += 30) {
    const windowGrams = bigrams(haystack.slice(start, start + target.length + 30));
    let shared = 0;
    for (const gram of grams) if (windowGrams.has(gram)) shared += 1;
    if (shared / grams.size >= 0.9) return true;
  }
  return false;
}

export function parseFullReadIssues(text: string, chapter: number, draftBody: string, earlier: EarlierText): readonly ContinuityIssueV2[] {
  const parsed = parseJson(text);
  const raw = Array.isArray(parsed.contradictions) ? parsed.contradictions : [];
  const body = normalize(draftBody);
  const earlierByChapter = new Map(earlier.chapters.map((item) => [item.chapter, normalize(item.sentences.join(""))]));
  const out: ContinuityIssueV2[] = [];
  for (const item of raw) {
    const record = asRecord(item);
    if (!record) continue;
    const quote = String(record.quote ?? "").trim();
    const earlierQuote = String(record.earlierQuote ?? "").trim();
    const reason = String(record.reason ?? "").trim();
    if (!containsQuote(body, quote) || SELF_DISMISSED.test(reason)) continue;
    const claimedChapter = Number(record.earlierChapter);
    let earlierChapter: number | undefined;
    if (containsQuote(body, earlierQuote) && normalize(earlierQuote) !== normalize(quote)) earlierChapter = chapter;
    else if (Number.isInteger(claimedChapter) && earlierByChapter.has(claimedChapter) && containsQuote(earlierByChapter.get(claimedChapter)!, earlierQuote)) earlierChapter = claimedChapter;
    else earlierChapter = [...earlierByChapter.entries()].find(([, text]) => containsQuote(text, earlierQuote))?.[0];
    if (earlierChapter === undefined) continue;
    out.push({ quote, earlierQuote, earlierChapter, reason, kind: "event" });
  }
  return out;
}

/** 整章通读：两遍（盯东西 / 盯人和时间），各自独立，结果合并去重。 */
export async function checkChapterByFullRead(input: {
  readonly projectDir: string;
  readonly chapter: number;
  readonly draftBody: string;
  readonly callModel: CheckCallModel;
  readonly earlier?: EarlierText;
}): Promise<CheckChapterResult> {
  const earlier = input.earlier ?? await readEarlierChapters(input.projectDir, input.chapter);
  const failures: string[] = [];
  const passes = await Promise.allSettled((["objects", "people", "time-knowledge"] as const).map(async (focus) =>
    parseFullReadIssues(await input.callModel(buildFullReadMessages(input.chapter, input.draftBody, earlier, focus)), input.chapter, input.draftBody, earlier)));
  const issues: ContinuityIssueV2[] = [];
  const seen = new Set<string>();
  passes.forEach((result, index) => {
    if (result.status === "rejected") {
      failures.push(`第 ${index + 1} 遍通读没成：${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
      return;
    }
    for (const issue of result.value) {
      const key = normalize(issue.quote);
      if (seen.has(key)) continue;
      seen.add(key);
      issues.push(issue);
    }
  });
  return { claims: 0, checkedClaims: 0, issues, failures };
}

// ---------- 组合：通读三遍 + 逐条判，合并后复核 ----------

function sentenceWithContext(text: string, quote: string): string {
  const sentences = splitSentences(text);
  const target = normalize(quote);
  const index = sentences.findIndex((sentence) => normalize(sentence).includes(target.slice(0, 12)) || target.includes(normalize(sentence)));
  if (index < 0) return quote;
  return sentences.slice(Math.max(0, index - 1), index + 2).join("");
}

export function buildAdjudicationMessages(
  chapter: number,
  candidates: readonly { readonly id: string; readonly issue: ContinuityIssueV2; readonly here: string; readonly there: string }[],
): { role: "system" | "user"; content: string }[] {
  const system = [
    "你是长篇小说的复核编辑。下面每条是别人标出的「前后矛盾」，附了本章那句和前文那句的上下文。逐条给一个判断：",
    "sure＝确定是矛盾：同一件事、同一样东西、同一个人，两处说法不可能同时成立，文中也没交代变化过程；",
    "maybe＝可能是：看着对不上，但也说得通（时间没写清、可能是两样东西、中间可能发生了没写的事）；",
    "no＝不是：说的明显不是同一件事 / 同一时刻，或标注理由读错了原文，或文中明写了变化 / 人物在撒谎记错。",
    "拿不准就给 maybe，不要轻易给 no。只输出一个 JSON：{\"verdicts\":[{\"id\":\"K1\",\"verdict\":\"sure\"}]}，每条都要给。",
  ].join("\n");
  const user = [
    `【本章】第 ${chapter} 章`,
    ...candidates.map(({ id, issue, here, there }) => [
      `【${id}】标注理由：${issue.reason}`,
      `  本章：${here}`,
      `  ${issue.earlierChapter === chapter ? "本章前文" : `第 ${issue.earlierChapter} 章`}：${there}`,
    ].join("\n")),
  ].join("\n\n");
  return [{ role: "system", content: system }, { role: "user", content: user }];
}

/**
 * 组合查错（第 1 期定型）：整章通读三遍（盯东西 / 盯人 / 盯时间与信息）+ 拆说法逐条判，合并去重，再复核一遍压误报。
 * 评测（4 本书 127 条标注）：单用通读 查全 28%；通读 ∪ 逐条判 查全 42%。复核只删不加。
 */
export async function checkChapterContinuity(input: {
  readonly projectDir: string;
  readonly chapter: number;
  readonly draftBody: string;
  readonly callModel: CheckCallModel;
  /** 是否复核（评测对比用；缺省复核）。 */
  readonly adjudicate?: boolean;
  readonly earlier?: EarlierText;
}): Promise<CheckChapterResult & { readonly candidates: number }> {
  const earlier = input.earlier ?? await readEarlierChapters(input.projectDir, input.chapter);
  const [full, claims] = await Promise.all([
    checkChapterByFullRead({ ...input, earlier }),
    checkChapterAgainstEarlierText({ ...input, earlier }),
  ]);
  const failures = [...full.failures, ...claims.failures];
  const merged: ContinuityIssueV2[] = [];
  const seen = new Set<string>();
  for (const issue of [...full.issues, ...claims.issues]) {
    const key = normalize(issue.quote).slice(0, 16);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(issue);
  }
  if (input.adjudicate === false || merged.length === 0) {
    return { claims: claims.claims, checkedClaims: claims.checkedClaims, issues: merged, failures, candidates: merged.length };
  }
  const earlierText = new Map(earlier.chapters.map((item) => [item.chapter, item.sentences.join("")]));
  const candidates = merged.map((issue, index) => ({
    id: `K${index + 1}`,
    issue,
    here: sentenceWithContext(input.draftBody, issue.quote),
    there: sentenceWithContext(issue.earlierChapter === input.chapter ? input.draftBody : earlierText.get(issue.earlierChapter) ?? issue.earlierQuote, issue.earlierQuote),
  }));
  try {
    const parsed = parseJson(await input.callModel(buildAdjudicationMessages(input.chapter, candidates)));
    const verdicts = new Map((Array.isArray(parsed.verdicts) ? parsed.verdicts : [])
      .map((item) => asRecord(item))
      .filter((record): record is Record<string, unknown> => Boolean(record))
      .map((record) => [String(record.id ?? "").trim().toUpperCase(), String(record.verdict ?? record.real ?? "").trim().toLowerCase()] as const));
    // 只删明确判「不是」的；没给判断的当 maybe（宁可让作者看一眼）。确定的排前面。
    const kept = candidates
      .map((candidate) => {
        const verdict = verdicts.get(candidate.id) ?? "maybe";
        if (/^(?:no|false|不是|否)$/u.test(verdict)) return undefined;
        return { ...candidate.issue, confidence: /^(?:sure|true|确定|是)$/u.test(verdict) ? "sure" as const : "maybe" as const };
      })
      .filter((issue): issue is ContinuityIssueV2 & { confidence: "sure" | "maybe" } => Boolean(issue))
      .sort((a, b) => (a.confidence === b.confidence ? 0 : a.confidence === "sure" ? -1 : 1));
    return { claims: claims.claims, checkedClaims: claims.checkedClaims, issues: kept, failures, candidates: merged.length };
  } catch (error) {
    // 复核没跑成：候选原样交出（宁可多报），如实记一笔。
    failures.push(`复核没跑成：${error instanceof Error ? error.message : String(error)}`);
    return { claims: claims.claims, checkedClaims: claims.checkedClaims, issues: merged, failures, candidates: merged.length };
  }
}
