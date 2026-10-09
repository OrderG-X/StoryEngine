/**
 * 定稿后抽事实 + 对照旧事实（2026-10-08 写作主链重设计·阶段 4「记账对号」）。
 *
 * 十章验收：抽事实时看不到旧事实，冲突的说法直接追加，账本里同时躺着「登记表写了地址」和「登记表没写地址」，
 * 两条都继续喂给后面的章节；凭空编的一句也被收成「硬事实」。现在抽取时把与本章相关的旧事实（带编号）一起给模型：
 *  - facts：本章新确立的（旧单里已有的不再重复记）；
 *  - changes：本章明写发生了变化的旧事实（修好了/搬走了/送回去了）→ 旧条从本章起失效（supersede），新说法入账；
 *  - conflicts：本章说法与旧事实对不上、又不是剧情里的变化 → 账本不动，交给作者定（绝不替作者拍板）。
 * 模型无关：宽进逐条打捞；编号对不上的、引文不在正文里的一律丢弃；失败自动重试一次，仍不成如实说明。
 */
import { describeStoryDay, readChapterPlan, readStoryClock, selectEffectiveFacts } from "@actalk/story-engine";
import { readFactLedger, appendFacts, applyFactEdit, validateNewCharacterNames, type FactCallModel, type FactEntry } from "./fact-ledger.js";

const RELATED_FACT_CAP = 40;
const RETRIES = 1;

export interface FactConflict {
  /** 旧事实原文（第几章：…）。 */
  readonly old: string;
  /** 本章正文里对不上的原句。 */
  readonly quote: string;
  readonly note: string;
}

export interface ReconcileFactsResult {
  readonly ok: boolean;
  readonly added: number;
  /** 按本章变化更新掉的旧事实（旧说法）。 */
  readonly superseded: readonly string[];
  readonly conflicts: readonly FactConflict[];
  readonly newCharacters: readonly string[];
  readonly summary: string;
}

interface RelatedFact {
  readonly ref: string;
  readonly fact: FactEntry;
}

/** 与本章正文相关的旧事实（同一套挑事实算法，原文 = 本章正文），配短编号 F1..Fn 给模型回指。 */
export function pickRelatedFacts(facts: readonly FactEntry[], chapter: number, draftText: string, knownNames: readonly string[]): readonly RelatedFact[] {
  const byLabel = new Map<string, FactEntry>();
  for (const fact of facts) byLabel.set(`第${fact.chapter}章：${fact.text.trim()}`, fact);
  const selected = selectEffectiveFacts({
    // 只对照本章之前的事实（重新定稿同一章时，上一版自己记的不算「旧事实」）。
    facts: facts.filter((fact) => fact.chapter < chapter),
    chapter,
    relevantNames: knownNames,
    continuityText: draftText,
    cap: RELATED_FACT_CAP,
  }).facts;
  return selected
    .map((label) => byLabel.get(label))
    .filter((fact): fact is FactEntry => Boolean(fact))
    .map((fact, index) => ({ ref: `F${index + 1}`, fact }));
}

export function buildReconcileMessages(
  draftText: string,
  related: readonly RelatedFact[],
  knownNames: readonly string[],
  storyDayLabel?: string,
): { readonly role: "system" | "user"; readonly content: string }[] {
  const system = [
    "你是中文小说的『硬事实记录员』。读这章正文，对照【已记下的旧事实】，做三件事：",
    // 第十七轮：「下周三」原样入账，过几章没人知道指哪天，评估日悄悄消失、后面还被说成「提前」。
    // 第十九轮：「爸的老同事」被记成「林德昌（祖父）的老同事」，下一章章纲照着让林溪自称祖父的女儿。
    "正文用称呼（爸、妈、爷爷、哥）指人时，事实里照写成「林舟的父亲」这类关系说法，不要自己换成人名（容易把父亲和祖父弄混）。",
    "事实里提到日子，一律按【本章日子】换成「故事第几天」或星期几写（「下周三」写成「故事第 N 天（周三）」），不要写明天、后天、下周、前天这类相对说法。",
    "1. facts：本章新确立、后文必须保持一致的硬事实（人物关系与身份、物件在哪/在谁手里/上面写着什么/好坏、地点状况、约定与期限、数字日期）。每条一句话、具体可核对；旧事实里已有的不要重复记；不要记情绪感受。quote 逐字抄本章里写到这件事的原句；正文没明写、要靠推断才得出的不要记（由「换了日子」推出「改过期」、把「交还」说成「卖给」）。",
    "2. changes：本章正文【明确写了发生变化】的旧事实（如修好了、搬走了、送回去了、拆了）。ref 填旧事实编号，text 写变化后的新说法，quote 逐字抄本章里写这个变化的原句。只是没再提到、或者补充了细节的，都不算变化，不要报。",
    "3. conflicts：本章说法和某条旧事实对不上、但正文并没有写它发生了变化（多半是写错了）。ref 填旧事实编号，quote 逐字抄本章正文里对不上的那句，note 说怎么对不上。",
    "另外列出本章首次出现、且不在『已知角色』名单里的具名新人物（真名，宁缺毋滥）。",
    "只输出一个 JSON：{\"facts\":[{\"text\":\"\",\"quote\":\"\"}],\"changes\":[{\"ref\":\"F1\",\"text\":\"\",\"quote\":\"\"}],\"conflicts\":[{\"ref\":\"F2\",\"quote\":\"\",\"note\":\"\"}],\"newCharacters\":[{\"name\":\"\"}]}。没有的给空数组。不要 Markdown、不要解释。",
  ].join("\n");
  const user = [
    related.length > 0
      ? `【已记下的旧事实】\n${related.map((item) => `${item.ref}（第${item.fact.chapter}章）${item.fact.text}`).join("\n")}`
      : "【已记下的旧事实】（无）",
    knownNames.length > 0 ? `【已知角色（这些都不是新人物）】${knownNames.join("、")}` : "",
    storyDayLabel ? `【本章日子】${storyDayLabel}` : "",
    `【本章正文】\n${draftText}`,
  ].filter(Boolean).join("\n\n");
  return [{ role: "system", content: system }, { role: "user", content: user }];
}

interface ParsedReconcile {
  /** quote 空 = 模型没给原句（宽进照收）；给了就要在正文里找得到。 */
  readonly facts: readonly { readonly text: string; readonly quote: string }[];
  readonly changes: readonly { readonly ref: string; readonly text: string; readonly quote: string }[];
  readonly conflicts: readonly { readonly ref: string; readonly quote: string; readonly note: string }[];
  readonly newCharacters: readonly string[];
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const asArray = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string => (typeof value === "string" || typeof value === "number" ? String(value).trim() : "");

/** 宽进解析：条目给成字符串也收、多余键丢掉、坏条目逐条丢。不是 JSON 才抛（由调用方重试）。 */
export function parseReconcile(text: string): ParsedReconcile {
  const match = text.match(/\{[\s\S]*\}/u);
  if (!match) throw new Error("抽取结果不是 JSON");
  const parsed = asRecord(JSON.parse(match[0])) ?? {};
  return {
    facts: asArray(parsed.facts)
      .map((item) => ({ text: str(asRecord(item)?.text ?? item), quote: str(asRecord(item)?.quote) }))
      .filter((item) => item.text),
    changes: asArray(parsed.changes)
      .map((item) => ({ ref: str(asRecord(item)?.ref).toUpperCase(), text: str(asRecord(item)?.text), quote: str(asRecord(item)?.quote) }))
      .filter((item) => item.ref && item.text),
    conflicts: asArray(parsed.conflicts)
      .map((item) => ({ ref: str(asRecord(item)?.ref).toUpperCase(), quote: str(asRecord(item)?.quote), note: str(asRecord(item)?.note) }))
      .filter((item) => item.ref && item.quote),
    newCharacters: asArray(parsed.newCharacters).map((item) => str(asRecord(item)?.name ?? item)).filter(Boolean),
  };
}

const normalizeSpace = (text: string): string => text.replace(/\s+/gu, "");

function hanBigrams(text: string): readonly string[] {
  const out: string[] = [];
  for (const run of text.match(/[\u3400-\u9fff]+/gu) ?? []) {
    const chars = Array.from(run);
    for (let i = 0; i + 1 < chars.length; i += 1) out.push(chars[i] + chars[i + 1]);
  }
  return out;
}

const KINSHIP_TERM = /爸|妈|爹|娘|父|母|爷|奶|外公|外婆|祖|哥|姐|弟|妹|叔|伯|姑|舅|姨|老爷子|老太太/u;

/**
 * 原句里用称呼指人、事实却换成了人名（不含任何称呼）→ 记录员自己把称呼对到了人，辈分常对错，不入账。
 * 「林舟的妹妹林溪」这类称呼和名字都在的照收。
 */
export function factSwapsKinshipForName(fact: { readonly text: string; readonly quote: string }, knownNames: readonly string[]): boolean {
  if (!fact.quote || !KINSHIP_TERM.test(fact.quote) || KINSHIP_TERM.test(fact.text)) return false;
  return knownNames.some((name) => name.length >= 2 && fact.text.includes(name) && !fact.quote.includes(name));
}

/** 新事实引的原句在正文里找得到：逐字命中，或八成两字片段都在正文里（模型抄原句常改一两个字、多带几个字）。 */
export function factQuoteIsSupported(quote: string, draftText: string): boolean {
  const draft = normalizeSpace(draftText);
  const normalized = normalizeSpace(quote);
  if (normalized.length >= 4 && draft.includes(normalized)) return true;
  const grams = hanBigrams(normalized);
  if (grams.length < 4) return false;
  const draftGrams = new Set(hanBigrams(draft));
  return grams.filter((gram) => draftGrams.has(gram)).length / grams.length >= 0.8;
}

function describe(result: Omit<ReconcileFactsResult, "summary" | "ok">): string {
  const parts: string[] = [];
  if (result.added > 0) parts.push(`这章记下 ${result.added} 条硬事实（后文不得改写）。`);
  if (result.superseded.length > 0) {
    parts.push(`按本章的变化更新了 ${result.superseded.length} 条旧设定（${result.superseded.slice(0, 2).map((text) => `「${text}」`).join("、")}${result.superseded.length > 2 ? "等" : ""}从本章起不再算数）。`);
  }
  if (result.conflicts.length > 0) {
    const listed = result.conflicts.slice(0, 2).map((item) => `「${item.quote}」与${item.old}`).join("；");
    parts.push(`有 ${result.conflicts.length} 处和旧设定对不上，账本没动，需要你定以哪个为准：${listed}${result.conflicts.length > 2 ? "等" : ""}。`);
  }
  return parts.join("");
}

export async function extractAndReconcileFacts(input: {
  readonly projectDir: string;
  readonly chapter: number;
  readonly draftText: string;
  readonly callModel: FactCallModel;
  readonly knownNames?: readonly string[];
}): Promise<ReconcileFactsResult> {
  const empty = { added: 0, superseded: [], conflicts: [], newCharacters: [] } as const;
  if (!input.draftText.trim()) return { ok: true, ...empty, summary: "" };
  const knownNames = input.knownNames ?? [];
  let ledger: Awaited<ReturnType<typeof readFactLedger>>;
  try {
    ledger = await readFactLedger(input.projectDir);
  } catch (error) {
    return { ok: false, ...empty, summary: `（事实账本读不了，这章的硬事实没记：${error instanceof Error ? error.message : String(error)}）` };
  }
  const related = pickRelatedFacts(ledger.facts, input.chapter, input.draftText, knownNames);
  const plan = await readChapterPlan(input.projectDir, input.chapter).catch(() => undefined);
  const clock = plan ? await readStoryClock(input.projectDir, input.chapter).catch(() => []) : [];
  const messages = buildReconcileMessages(input.draftText, related, knownNames, describeStoryDay(plan, clock));
  let parsed: ParsedReconcile | undefined;
  for (let attempt = 0; attempt <= RETRIES && !parsed; attempt += 1) {
    try {
      parsed = parseReconcile(await input.callModel(messages));
    } catch {
      parsed = undefined;
    }
  }
  if (!parsed) {
    return { ok: false, ...empty, summary: "（这章的硬事实没抽成，已自动重试一次仍失败；定稿不受影响，只是后面写作时少了这一章的事实参照。）" };
  }

  const byRef = new Map(related.map((item) => [item.ref, item.fact]));
  const draft = normalizeSpace(input.draftText);
  const quoted = (quote: string) => normalizeSpace(quote).length >= 4 && draft.includes(normalizeSpace(quote));
  // 「变化」必须引本章写这个变化的原句（逐字命中）才让旧条失效——验收第四轮：仍然有效的事实（信的全文、照片）被标成过期。
  const changes = parsed.changes.filter((change) => byRef.has(change.ref) && quoted(change.quote));
  // 新事实引了原句却在正文里找不到 → 多半是推断出来的，不入账（第十四轮：凭空推出一次改期、把交还记成卖给）。
  const supportedFacts = parsed.facts.filter((fact) => (!fact.quote || factQuoteIsSupported(fact.quote, input.draftText))
    && !factSwapsKinshipForName(fact, knownNames));
  if (supportedFacts.length < parsed.facts.length) {
    console.info(`[fact-ledger] 第${input.chapter}章 ${parsed.facts.length - supportedFacts.length} 条事实引的原句在正文里找不到，没记`);
  }
  const added = await appendFacts(input.projectDir, input.chapter, [
    ...supportedFacts.map((fact) => fact.text),
    ...changes.map((change) => change.text),
  ], "auto");
  // 变化：旧条从本章起失效（原文保留、可撤销）。新说法已随上面一起入账。
  const superseded: string[] = [];
  for (const change of changes) {
    const old = byRef.get(change.ref);
    if (!old || old.supersededByChapter !== undefined) continue;
    const edited = await applyFactEdit(input.projectDir, "supersede", { id: old.id, chapter: input.chapter });
    if (edited.ok) superseded.push(old.text);
  }
  // 冲突：引文必须逐字在本章正文里，编号必须对得上；账本不动。
  const conflicts: FactConflict[] = parsed.conflicts
    .filter((item) => byRef.has(item.ref) && quoted(item.quote))
    .map((item) => {
      const old = byRef.get(item.ref)!;
      return { old: `第${old.chapter}章「${old.text}」`, quote: item.quote, note: item.note };
    });
  const newCharacters = validateNewCharacterNames(parsed.newCharacters, new Set(knownNames));
  const result = { added, superseded, conflicts, newCharacters };
  return { ok: true, ...result, summary: describe(result) };
}
