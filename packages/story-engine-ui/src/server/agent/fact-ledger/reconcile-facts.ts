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
import { createHash } from "node:crypto";
import { absolutizeRelativeDaysInText, selectEffectiveFacts, type ChapterFactUpdate, type StoryTimeline } from "@actalk/story-engine";
import { readFactLedger, validateNewCharacterNames, type FactCallModel, type FactEntry } from "./fact-ledger.js";

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
    storyDayLabel
      ? "事实里提到日子，一律按【本章日子】换成「故事第几天」或星期几写（「下周三」写成「故事第 N 天（周三）」），不要写明天、后天、下周、前天这类相对说法。"
      // 作者自己写的章没有章纲、不知道是故事第几天：模型会自己编（2026-10-10 验收：三章里三次把周六记成「故事第 3 天」「第 5 天」）。
      : "不知道本章是故事第几天：事实里提到日子，照正文写星期几或具体日期（「周六上午」）；正文只有明天、后天这种说法时，写成「本章说的后天」。绝不自己换算成「故事第几天」。",
    "1. facts：本章新确立、后文必须保持一致的硬事实（人物关系与身份、人物住在哪/和谁住、物件在哪/在谁手里/上面写着什么/好坏、地点状况、约定与期限、数字日期）。每条一句话、具体可核对；旧事实里已有的不要重复记；不要记情绪感受。quote 逐字抄本章里写到这件事的原句；正文没明写、要靠推断才得出的不要记（由「换了日子」推出「改过期」、把「交还」说成「卖给」）。",
    // 账本 v2（2026-10-10）：能拆成「谁 / 哪方面 / 是什么」的就拆，后文同一主体同一方面写成别的值，引擎直接比对出来（不靠模型判）。
    "   能拆的事实再给三项：subject=说的是谁或什么（人名 / 物名 / 地名，照正文写法），attribute=哪方面（年龄、住址、门牌、扉页写的字、在哪、在谁手里、职业、亲属关系……用短词），value=是什么（照正文）。kind：hard=不该变的（年龄、门牌、写着的字、亲属关系）；state=会变的状态（在哪、在谁手里、好坏）；event=发生过的事。拆不开的只给 text 和 quote。",
    "2. changes：本章正文【明确写了发生变化】的旧事实（如修好了、搬走了、送回去了、拆了）。ref 填旧事实编号，text 写变化后的新说法，quote 逐字抄本章里写这个变化的原句。只是没再提到、或者补充了细节的，都不算变化，不要报。",
    "3. conflicts：本章说法和某条旧事实对不上、但正文并没有写它发生了变化（多半是写错了）。ref 填旧事实编号，quote 逐字抄本章正文里对不上的那句，note 说怎么对不上。",
    "另外列出本章首次出现、且不在『已知角色』名单里的具名新人物（真名，宁缺毋滥）。",
    "只输出一个 JSON：{\"facts\":[{\"text\":\"\",\"quote\":\"\",\"subject\":\"\",\"attribute\":\"\",\"value\":\"\",\"kind\":\"hard\"}],\"changes\":[{\"ref\":\"F1\",\"text\":\"\",\"quote\":\"\"}],\"conflicts\":[{\"ref\":\"F2\",\"quote\":\"\",\"note\":\"\"}],\"newCharacters\":[{\"name\":\"\"}]}。没有的给空数组。不要 Markdown、不要解释。",
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

type FactKind = "hard" | "state" | "event";
interface FactTriple { readonly subject?: string; readonly attribute?: string; readonly value?: string; readonly kind?: FactKind }

interface ParsedReconcile {
  /** quote 空 = 模型没给原句（宽进照收）；给了就要在正文里找得到。 */
  readonly facts: readonly ({ readonly text: string; readonly quote: string } & FactTriple)[];
  readonly changes: readonly { readonly ref: string; readonly text: string; readonly quote: string }[];
  readonly conflicts: readonly { readonly ref: string; readonly quote: string; readonly note: string }[];
  readonly newCharacters: readonly string[];
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const asArray = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string => (typeof value === "string" || typeof value === "number" ? String(value).trim() : "");

/** 三元组宽进：三项都得有才收（缺一项就当没拆）；kind 认不出就不填。 */
function readTriple(record: Record<string, unknown> | undefined): FactTriple {
  if (!record) return {};
  const subject = str(record.subject);
  const attribute = str(record.attribute);
  const value = str(record.value);
  const kindRaw = str(record.kind).toLowerCase();
  const kind = kindRaw === "hard" || kindRaw === "state" || kindRaw === "event" ? kindRaw : undefined;
  return {
    ...(subject && attribute && value ? { subject, attribute, value } : {}),
    ...(kind ? { kind } : {}),
  };
}

/** 宽进解析：条目给成字符串也收、多余键丢掉、坏条目逐条丢。不是 JSON 才抛（由调用方重试）。 */
export function parseReconcile(text: string): ParsedReconcile {
  const match = text.match(/\{[\s\S]*\}/u);
  if (!match) throw new Error("抽取结果不是 JSON");
  const parsed = asRecord(JSON.parse(match[0])) ?? {};
  return {
    facts: asArray(parsed.facts)
      .map((item) => ({ text: str(asRecord(item)?.text ?? item), quote: str(asRecord(item)?.quote), ...readTriple(asRecord(item)) }))
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

/**
 * 不知道本章是故事第几天时，模型照样会编「故事第 3 天（周六）」——编的天数是错的，括号里的星期才是正文写的：只留星期。
 */
export function stripInventedStoryDays(text: string): string {
  return text.replace(/故事第\s*\d+\s*天\s*[（(]\s*((?:周|星期|礼拜)[一二三四五六日天])\s*[）)]/gu, "$1");
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

/**
 * 改记要不要作者确认（R7.4，十章试写报告 3.4）——纯确定性，不猜说法：
 *  - 旧条是 hard（不该变的事实：年龄、门牌、写着的字、亲属关系……）：值不同是矛盾不是变化，绝不自动作废；
 *  - 旧条带主语（账本 v2 的 subject）：新说法和原句里都对不上这个主语 → 说的不是同一件事（十章书里
 *    「老周的茶馆在钟楼斜对面」被当晚「竹桌收进墙根」顶掉），也不自动作废。
 * 老数据没有 kind / subject 两个字段 → 两关都过，照旧自动作废（向后兼容）。
 */
export function changeNeedsConfirmation(
  old: Pick<FactEntry, "kind" | "subject">,
  newText: string,
  quote: string,
): boolean {
  if (old.kind === "hard") return true;
  const subject = old.subject?.trim();
  if (!subject) return false;
  return !normalizeSpace(`${newText}${quote}`).includes(normalizeSpace(subject));
}

/** 两个主语是不是不同的：去掉空白后互不包含才算真不同（「铜盒」和「铜盒和两把钥匙」算同一个）。 */
function subjectsDiffer(a: string, b: string): boolean {
  const x = normalizeSpace(a);
  const y = normalizeSpace(b);
  return x !== y && !x.includes(y) && !y.includes(x);
}

/** 定稿回执里「这章记了什么事实」的一句话（engine report.factLedger + 提案里的对不上 / 新人物）。 */
export function describeFactOutcome(input: {
  readonly added: number;
  readonly superseded: readonly string[];
  readonly conflicts: readonly FactConflict[];
  readonly skipped: number;
  /** 要作者确认的改记里没勾的条数（R7.4）：旧设定没动，回执里如实说一句。 */
  readonly unconfirmed?: number;
}): string {
  return `${describe({ added: input.added, superseded: input.superseded, conflicts: input.conflicts, newCharacters: [] })}${input.skipped > 0 ? `你去掉的 ${input.skipped} 条没记。` : ""}${(input.unconfirmed ?? 0) > 0 ? `还有 ${input.unconfirmed} 条要你确认的改记没勾，旧设定没动。` : ""}`;
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

/**
 * 记账提案（2026-10-10 第 2 期「定稿前看账」）：模型抽出、校验过、但还没写进账本的事实变化。
 * 定稿预览时算好给作者看，作者去掉不对的，定稿时只写留下的（applyFactProposal）。
 */
export interface FactProposal {
  readonly ok: boolean;
  /** 新记的事实（日子由引擎定稿时按时间线换算）。 */
  readonly adds: readonly ({ readonly text: string; readonly quote?: string } & FactTriple)[];
  /** 本章明写变化、且过确定性检查（旧条会变、主语对得上）的改记：旧条从本章起失效、新说法入账。 */
  readonly changes: readonly { readonly factId: string; readonly oldText: string; readonly newText: string; readonly quote: string }[];
  /**
   * 要作者确认才作的改记（R7.4，十章试写报告 3.4）：旧条是 hard 这类不该变的事实、或旧条主语和新说法对不上——
   * 不自动作废。清单顶上标「要你确认」、默认不勾；作者勾了（change_confirm 前缀随排除数组回来）才写。
   */
  readonly changesToConfirm?: readonly { readonly factId: string; readonly oldChapter: number; readonly oldText: string; readonly newText: string; readonly quote: string; readonly why: "hard" | "subject" }[];
  readonly conflicts: readonly FactConflict[];
  readonly newCharacters: readonly string[];
  /** ok=false 时给作者的说明。 */
  readonly failureSummary?: string;
}

/** 作者在定稿前去掉的条目：adds 按事实内容的短哈希（factKey）、changes 按旧事实 id；confirmChanges 是勾上的待确认改记。 */
export interface FactProposalExclusions {
  readonly adds?: ReadonlySet<string>;
  readonly changes?: ReadonlySet<string>;
  readonly confirmChanges?: ReadonlySet<string>;
}

/**
 * 新事实的稳定钥匙（内容短哈希，不用下标）：同一版草稿预览两次，模型抽出的条目和顺序会变，
 * 按下标去掉会删错条；按内容只会删掉作者看到并勾掉的那一句。
 */
export function factKey(text: string): string {
  return createHash("sha1").update(text.replace(/\s+/gu, ""), "utf-8").digest("hex").slice(0, 12);
}

export async function proposeFactChanges(input: {
  readonly projectDir: string;
  readonly chapter: number;
  readonly draftText: string;
  readonly callModel: FactCallModel;
  readonly knownNames?: readonly string[];
}): Promise<FactProposal> {
  const empty = { adds: [], changes: [], conflicts: [], newCharacters: [] } as const;
  if (!input.draftText.trim()) return { ok: true, ...empty };
  const knownNames = input.knownNames ?? [];
  let ledger: Awaited<ReturnType<typeof readFactLedger>>;
  try {
    ledger = await readFactLedger(input.projectDir);
  } catch (error) {
    return { ok: false, ...empty, failureSummary: `（事实账本读不了，这章的硬事实没记：${error instanceof Error ? error.message : String(error)}）` };
  }
  const related = pickRelatedFacts(ledger.facts, input.chapter, input.draftText, knownNames);
  // 日子不让模型换算（2026-10-10 引擎升级）：模型照正文写「周六」「本章说的后天」，
  // 「故事第几天」由引擎按故事时间线换（withTimelineDates），定稿时本章是哪天才最终确定（作者可能改）。
  const messages = buildReconcileMessages(input.draftText, related, knownNames);
  let parsed: ParsedReconcile | undefined;
  for (let attempt = 0; attempt <= RETRIES && !parsed; attempt += 1) {
    try {
      parsed = parseReconcile(await input.callModel(messages));
    } catch {
      parsed = undefined;
    }
  }
  if (!parsed) {
    return { ok: false, ...empty, failureSummary: "（这章的硬事实没抽成，已自动重试一次仍失败；定稿不受影响，只是后面写作时少了这一章的事实参照。）" };
  }

  const byRef = new Map(related.map((item) => [item.ref, item.fact]));
  const draft = normalizeSpace(input.draftText);
  const quoted = (quote: string) => normalizeSpace(quote).length >= 4 && draft.includes(normalizeSpace(quote));
  // 「变化」必须引本章写这个变化的原句（逐字命中）才让旧条失效——验收第四轮：仍然有效的事实（信的全文、照片）被标成过期。
  // 再过确定性检查（R7.4）：旧条是 hard 或主语对不上 → 不自动作废，进「要你确认」清单（默认不勾）。
  const allChanges = parsed.changes
    .filter((change) => byRef.has(change.ref) && quoted(change.quote))
    .map((change) => ({ entry: byRef.get(change.ref)!, newText: stripInventedStoryDays(change.text), quote: change.quote }))
    .filter((change, index, all) => all.findIndex((other) => other.entry.id === change.entry.id) === index);
  const changes: FactProposal["changes"][number][] = [];
  const changesToConfirm: NonNullable<FactProposal["changesToConfirm"]>[number][] = [];
  for (const change of allChanges) {
    if (changeNeedsConfirmation(change.entry, change.newText, change.quote)) {
      changesToConfirm.push({
        factId: change.entry.id,
        oldChapter: change.entry.chapter,
        oldText: change.entry.text,
        newText: change.newText,
        quote: change.quote,
        why: change.entry.kind === "hard" ? "hard" : "subject",
      });
    } else {
      changes.push({ factId: change.entry.id, oldText: change.entry.text, newText: change.newText, quote: change.quote });
    }
  }
  // 新事实引了原句却在正文里找不到 → 多半是推断出来的，不入账（第十四轮：凭空推出一次改期、把交还记成卖给）。
  const supportedFacts = parsed.facts.filter((fact) => (!fact.quote || factQuoteIsSupported(fact.quote, input.draftText))
    && !factSwapsKinshipForName(fact, knownNames));
  if (supportedFacts.length < parsed.facts.length) {
    console.info(`[fact-ledger] 第${input.chapter}章 ${parsed.facts.length - supportedFacts.length} 条事实引的原句在正文里找不到，没记`);
  }
  // 本章新事实的主语（账本 v2 三元组），按引文索引——回执里比对旧设定时用来看「这句说的是谁」。
  const addSubjectByQuote = new Map<string, string>();
  for (const fact of supportedFacts) {
    const subject = fact.subject?.trim();
    if (subject && fact.quote && !addSubjectByQuote.has(normalizeSpace(fact.quote))) addSubjectByQuote.set(normalizeSpace(fact.quote), subject);
  }
  const newSubjectForQuote = (quote: string): string | undefined => {
    const key = normalizeSpace(quote);
    if (key.length < 4) return undefined;
    const exact = addSubjectByQuote.get(key);
    if (exact) return exact;
    for (const [other, subject] of addSubjectByQuote) {
      if (other.length >= 4 && (other.includes(key) || key.includes(other))) return subject;
    }
    return undefined;
  };
  // 冲突：引文必须逐字在本章正文里，编号必须对得上；账本不动。再过两道确定性过滤（R7.4，十章试写报告 3.4 的误报）：
  //  - 引文是问句（带问号）→ 角色在发问、不是在下结论，不当断言比（「怀表是那个外乡人留下的？」）；
  //  - 只比同一个主语：本章新事实同引文那条的主语、和旧事实主语互不包含 → 两个人的事不比
  //    （老周右手腕的疤对上周晓兰手背的疤）；旧事实主语是已确立人物、引文点的是另一个已确立人物 → 同理不比。
  const conflicts: FactConflict[] = parsed.conflicts
    .filter((item) => byRef.has(item.ref) && quoted(item.quote) && !/[？?]/u.test(item.quote))
    .filter((item) => {
      const old = byRef.get(item.ref)!;
      const oldSubject = old.subject?.trim();
      if (!oldSubject) return true;
      const newSubject = newSubjectForQuote(item.quote);
      if (newSubject && subjectsDiffer(newSubject, oldSubject)) return false;
      if (knownNames.includes(oldSubject) && !normalizeSpace(item.quote).includes(normalizeSpace(oldSubject))) {
        const quoteNorm = normalizeSpace(item.quote);
        const namesOtherKnown = knownNames.some((name) => name !== oldSubject
          && subjectsDiffer(name, oldSubject)
          && quoteNorm.includes(normalizeSpace(name)));
        if (namesOtherKnown) return false;
      }
      return true;
    })
    .map((item) => {
      const old = byRef.get(item.ref)!;
      return { old: `第${old.chapter}章「${old.text}」`, quote: item.quote, note: item.note };
    });
  return {
    ok: true,
    adds: supportedFacts.map((fact) => ({
      text: stripInventedStoryDays(fact.text),
      ...(fact.quote ? { quote: fact.quote } : {}),
      ...(fact.subject && fact.attribute && fact.value ? { subject: fact.subject, attribute: fact.attribute, value: stripInventedStoryDays(fact.value) } : {}),
      ...(fact.kind ? { kind: fact.kind } : {}),
    })),
    changes,
    ...(changesToConfirm.length > 0 ? { changesToConfirm } : {}),
    conflicts,
    newCharacters: validateNewCharacterNames(parsed.newCharacters, new Set(knownNames)),
  };
}

/**
 * 记账提案 → 交给引擎的本章事实变更（去掉作者勾掉的、带上作者确认的改记）。提案没抽成（ok=false）→ undefined。
 * 日子不在这里换：引擎定稿时按最终时间线换（作者可能刚改了本章是第几天）。
 * 待确认的改记（R7.4）默认不作数：只有作者勾了（id 以 change_confirm: 前缀随排除数组回来，拆到 confirmChanges）才写。
 */
export function toChapterFactUpdate(proposal: FactProposal | undefined, exclusions: FactProposalExclusions = {}): ChapterFactUpdate | undefined {
  if (!proposal?.ok) return undefined;
  const toChange = (change: { readonly factId: string; readonly newText: string; readonly quote: string }) => ({
    factId: change.factId,
    newText: change.newText,
    ...(change.quote ? { quote: change.quote } : {}),
  });
  return {
    adds: proposal.adds.filter((fact) => !exclusions.adds?.has(factKey(fact.text))),
    changes: [
      ...proposal.changes
        .filter((change) => !exclusions.changes?.has(change.factId))
        .map(toChange),
      ...(proposal.changesToConfirm ?? [])
        .filter((change) => exclusions.confirmChanges?.has(change.factId))
        .map(toChange),
    ],
  };
}

/** 事实文字里的日子按时间线换成「故事第 N 天（周X）」（today = 本章是第几天）。只换显示 / 入账的文字，条目钥匙仍按原文算。 */
export function withTimelineDates(text: string, timelineDay: { readonly today: number; readonly timeline: StoryTimeline } | undefined): string {
  return timelineDay ? absolutizeRelativeDaysInText(text, timelineDay.today, timelineDay.timeline) : text;
}
