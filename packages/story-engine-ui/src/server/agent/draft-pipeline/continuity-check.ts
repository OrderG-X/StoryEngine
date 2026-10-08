/**
 * 写完对一遍 + 自动修一轮（2026-10-08 写作主链重设计·阶段 3）。
 *
 * 十章真机验收：新写的内容和旧设定冲突，没有任何一步会发现（菜场第 5 章拆了、第 8 章还在；登记表地址前后
 * 4 个版本），冲突说法直接记成新的「事实」。这里在出稿后、定稿前：
 *   ① 按「这章正文自己写到了什么」从事实账本翻相关旧事实（同一套挑事实算法，原文换成本章正文）；
 *   ② 连同章纲翻出的旧章原文、上一章结尾，交给审读模型找冲突/重演/漏写要点；
 *   ③ 每条冲突必须引正文原句（逐字命中才采信，治幻觉）；
 *   ④ 有冲突就把涉及的段落交给改稿模型一次改完（只改这些段，其余一字不动），再核一遍；
 *   ⑤ 改不掉的如实留给作者定，绝不替作者拍板、绝不谎报「已一致」。
 *
 * 模型无关：两次调用都是 JSON + 宽进逐条打捞；任何一步挂了 → 原稿不动 + 如实说明这次没核/没修成。
 */
import {
  readCharacterBible,
  readFactLedger,
  selectEffectiveFacts,
  type ChapterPlan,
  type EarlierPassage,
} from "@actalk/story-engine";

export type CheckCallModel = (
  messages: readonly { readonly role: "system" | "user"; readonly content: string }[],
) => Promise<string>;

export type ContinuityIssueType = "contradiction" | "repeat" | "missing_beat";

export interface ContinuityIssue {
  readonly type: ContinuityIssueType;
  /** 正文原句（contradiction / repeat 必有，且逐字在正文里）。 */
  readonly quote?: string;
  /** 与之冲突的旧设定/前文（注明第几章）。 */
  readonly conflict: string;
  /** 怎么改。 */
  readonly fix: string;
}

export interface ContinuityReferences {
  readonly facts: readonly string[];
  readonly passages: readonly EarlierPassage[];
  readonly previousChapterTail?: string;
  /** 人物身份与年龄（查「谁在哪一年多大」这类年代算术）。 */
  readonly characterSheet?: readonly string[];
  /** 前几章与本章的时间（查日期、星期、先后顺序）。 */
  readonly timeline?: readonly string[];
}

export interface ContinuityCheckResult {
  /** false = 审读没跑成（模型挂了/输出不可用）：原稿不动，如实说明。 */
  readonly checked: boolean;
  readonly referenceCount: number;
  readonly issues: readonly ContinuityIssue[];
  /** 被丢弃的条目（引的原句在正文里找不到）。 */
  readonly droppedUnverified: number;
  readonly error?: string;
}

const MAX_ISSUES = 8;
const CHECK_FACT_CAP = 40;
const PREVIOUS_TAIL_CHARS = 1500;

const normalizeSpace = (text: string): string => text.replace(/\s+/gu, "");

/**
 * 核对要对照的旧资料：按本章正文写到的东西挑旧事实（正文提到菜场，就把「菜场已拆」翻出来），
 * 加上写稿时按章纲翻出的旧章原文与上一章结尾。读盘失败即少一类，不阻断。
 */
export async function collectContinuityReferences(input: {
  readonly projectDir: string;
  readonly chapter: number;
  readonly draftBody: string;
  readonly passages?: readonly EarlierPassage[];
  readonly previousChapterText?: string;
  readonly timeline?: readonly string[];
}): Promise<ContinuityReferences> {
  const [ledger, characterBible] = await Promise.all([
    readFactLedger(input.projectDir).catch(() => null),
    readCharacterBible(input.projectDir).catch(() => null),
  ]);
  const facts = selectEffectiveFacts({
    facts: ledger?.facts ?? [],
    chapter: input.chapter,
    relevantNames: (characterBible?.characters ?? []).map((character) => character.name).filter(Boolean),
    continuityText: input.draftBody,
    cap: CHECK_FACT_CAP,
  }).facts;
  const tail = input.previousChapterText?.trim();
  const characterSheet = (characterBible?.characters ?? [])
    .filter((character) => Boolean(character.name))
    .map((character) => {
      const notes = [character.role?.trim().slice(0, 30), character.age?.trim() ? `${character.age.trim()}岁`.replace(/岁岁$/u, "岁") : undefined].filter(Boolean);
      return notes.length > 0 ? `${character.name}（${notes.join("，")}）` : character.name;
    });
  return {
    facts,
    passages: input.passages ?? [],
    ...(characterSheet.length > 0 ? { characterSheet } : {}),
    ...(input.timeline && input.timeline.length > 0 ? { timeline: input.timeline } : {}),
    ...(tail ? { previousChapterTail: tail.length > PREVIOUS_TAIL_CHARS ? tail.slice(-PREVIOUS_TAIL_CHARS) : tail } : {}),
  };
}

export function buildContinuityCheckMessages(input: {
  readonly chapter: number;
  readonly draftBody: string;
  readonly references: ContinuityReferences;
  readonly chapterPlan?: ChapterPlan;
}): { readonly role: "system" | "user"; readonly content: string }[] {
  const system = [
    "你是长篇小说的连续性审读员。对照下面的【已确立事实】【前文原文】【上一章结尾】，检查【本章正文】。只报确实的问题，不报文风、不提建议性修改。",
    "要找三类：",
    "contradiction：正文里和已知设定/前文对不上的说法——物件在哪、在谁手里、上面写着什么、坏没坏；地点在不在、远近；时间、天数、日期与星期（和【时间线】对得上吗）；相对时间要随故事往前走（「三天前送来的表」过了几天还说三天前、「月底还剩几天」十天后还这么说，都算矛盾）；年代算术（照【人物】的年龄，某人在某一年多大、那时能不能做那件事）；谁已经知道什么（人物有没有说出他还不可能知道的东西）；人名称谓；数字（几个字、几样东西）。注意：本章明确写了「发生了变化」（如修好了、搬走了）不算矛盾。",
    "repeat：把前文已经发现、确认、做过的事又当成新的写了一遍（又认出同一个记号、又递一次已经递过的材料），或把前文的场面换个地方重演；也包括本章前半段已经写过的事，后半段又写了一遍。",
    "missing_beat：章纲要点或「本章新信息」在正文里根本没写到。",
    "每条 contradiction / repeat 的 quote 必须逐字抄正文原句（一句即可）；conflict 写清和哪条已知设定或第几章原文冲突；fix 写怎么改。",
    "只输出一个 JSON：{\"issues\":[{\"type\":\"contradiction\",\"quote\":\"\",\"conflict\":\"\",\"fix\":\"\"}]}；没有问题就给空数组。",
  ].join("\n");
  const refs = input.references;
  const user = [
    `【第 ${input.chapter} 章】`,
    input.chapterPlan
      ? `【本章章纲】${input.chapterPlan.summary}\n要点：${input.chapterPlan.beats.join("；")}${input.chapterPlan.newInformation.length > 0 ? `\n本章新信息：${input.chapterPlan.newInformation.join("；")}` : ""}`
      : "",
    refs.characterSheet && refs.characterSheet.length > 0 ? `【人物】${refs.characterSheet.join("、")}` : "",
    refs.timeline && refs.timeline.length > 0 ? `【时间线】\n${refs.timeline.join("\n")}` : "",
    refs.facts.length > 0 ? `【已确立事实】\n${refs.facts.join("\n")}` : "【已确立事实】（无）",
    refs.passages.length > 0
      ? `【前文原文】\n${refs.passages.map((item) => `第 ${item.chapter} 章（${item.term}）：${item.text}`).join("\n")}`
      : "",
    refs.previousChapterTail ? `【上一章结尾】\n${refs.previousChapterTail}` : "",
    `【本章正文】\n${input.draftBody}`,
  ].filter(Boolean).join("\n\n");
  return [{ role: "system", content: system }, { role: "user", content: user }];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

const ISSUE_TYPES = new Set<ContinuityIssueType>(["contradiction", "repeat", "missing_beat"]);

/** 宽进解析：坏条目逐条丢；contradiction/repeat 引的原句必须逐字（忽略空白）在正文里，否则丢弃并计数。 */
export function parseContinuityIssues(text: string, draftBody: string): { readonly issues: readonly ContinuityIssue[]; readonly droppedUnverified: number } {
  const match = text.match(/\{[\s\S]*\}/u);
  if (!match) throw new Error("审读结果不是 JSON");
  const parsed = asRecord(JSON.parse(match[0]));
  const raw = Array.isArray(parsed?.issues) ? parsed.issues : [];
  const draft = normalizeSpace(draftBody);
  const issues: ContinuityIssue[] = [];
  let droppedUnverified = 0;
  for (const item of raw) {
    const record = asRecord(item);
    if (!record) continue;
    const type = String(record.type ?? "").trim() as ContinuityIssueType;
    if (!ISSUE_TYPES.has(type)) continue;
    const conflict = String(record.conflict ?? "").trim();
    const fix = String(record.fix ?? "").trim();
    const quote = String(record.quote ?? "").trim();
    if (type !== "missing_beat") {
      if (normalizeSpace(quote).length < 4 || !draft.includes(normalizeSpace(quote))) {
        droppedUnverified += 1;
        continue;
      }
    }
    if (!conflict && !fix) continue;
    issues.push({ type, ...(quote ? { quote } : {}), conflict, fix });
    if (issues.length >= MAX_ISSUES) break;
  }
  return { issues, droppedUnverified };
}

export async function checkContinuity(input: {
  readonly chapter: number;
  readonly draftBody: string;
  readonly references: ContinuityReferences;
  readonly chapterPlan?: ChapterPlan;
  readonly callModel: CheckCallModel;
}): Promise<ContinuityCheckResult> {
  const referenceCount = input.references.facts.length + input.references.passages.length + (input.references.previousChapterTail ? 1 : 0);
  try {
    const out = await input.callModel(buildContinuityCheckMessages(input));
    const { issues, droppedUnverified } = parseContinuityIssues(out, input.draftBody);
    return { checked: true, referenceCount, issues, droppedUnverified };
  } catch (error) {
    return { checked: false, referenceCount, issues: [], droppedUnverified: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 段落切分：保留原段落顺序；索引供改稿模型回指。 */
export function splitParagraphs(body: string): readonly string[] {
  return body.split(/\n\s*\n|\n/u).map((item) => item.trim()).filter(Boolean);
}

/** 找到引文所在段落的索引（忽略空白比对）。找不到 → -1。 */
export function findParagraphIndex(paragraphs: readonly string[], quote: string): number {
  const target = normalizeSpace(quote);
  return paragraphs.findIndex((paragraph) => normalizeSpace(paragraph).includes(target));
}

/** 引文所在的整句（按句末标点切，带上紧跟的引号）；找不到 → undefined。 */
export function sentenceContaining(body: string, quote: string): string | undefined {
  const target = normalizeSpace(quote);
  const sentences = body.match(/[^。！？…\n]+[。！？…]*[」』”’]?/gu) ?? [];
  const hit = sentences.find((sentence) => normalizeSpace(sentence).includes(target));
  if (hit) return hit.trim();
  // 引文跨了句：退回到含引文的整段里第一句起、最后一句止的那一截。
  const paragraph = splitParagraphs(body).find((item) => normalizeSpace(item).includes(target));
  return paragraph && paragraph.length <= 200 ? paragraph : undefined;
}

export function buildRepairMessages(input: {
  readonly targets: readonly { readonly id: string; readonly sentence: string; readonly paragraph: string; readonly issues: readonly ContinuityIssue[] }[];
  readonly references: ContinuityReferences;
}): { readonly role: "system" | "user"; readonly content: string }[] {
  const system = [
    "你是小说改稿编辑。下面列出本章里有连续性问题的几句话，以及每句的问题和应以哪条设定为准。",
    "只改列出的这一句：把冲突的说法改成与已知设定一致，把重演前文的说法改成往前推进；改完仍是一两句话，长短与原句相近。",
    "原句里与问题无关的信息（说话人、关键台词、动作）原样保留；不要删掉后文可能会引用的台词。所在段落只给你看语境，不要改。",
    "只输出一个 JSON：{\"fixes\":[{\"id\":\"S1\",\"text\":\"改好的这一句\"}]}。",
  ].join("\n");
  const user = [
    input.references.facts.length > 0 ? `【已确立事实】\n${input.references.facts.join("\n")}` : "",
    "【要改的句子】",
    ...input.targets.map((target) => [
      `${target.id}：${target.sentence}`,
      ...target.issues.map((issue) => `  问题（${issue.type === "repeat" ? "重演前文" : "与设定冲突"}）：${issue.conflict}；改法：${issue.fix}`),
      `  所在段落（只读）：${target.paragraph}`,
    ].join("\n")),
  ].filter(Boolean).join("\n\n");
  return [{ role: "system", content: system }, { role: "user", content: user }];
}

export interface RepairResult {
  readonly draftBody: string;
  /** 实际改掉的句子数。 */
  readonly repairedParagraphs: number;
  /** 改过的句子所在段落在新正文里的编号（复核只看这几段）。 */
  readonly changedIndexes?: readonly number[];
  readonly error?: string;
}

/**
 * 一次调用改完所有冲突句——只换出问题的那一句，段里其余文字一字不动（十章验收第六轮：整段重写的自动修补
 * 改出 13 处新矛盾、删掉了后文还在引用的关键台词）。改出来过短 / 过长 / 空的一律不用。
 */
export async function repairContinuityIssues(input: {
  readonly draftBody: string;
  readonly issues: readonly ContinuityIssue[];
  readonly references: ContinuityReferences;
  readonly callModel: CheckCallModel;
}): Promise<RepairResult> {
  const paragraphs = splitParagraphs(input.draftBody);
  const bySentence = new Map<string, { sentence: string; paragraph: string; issues: ContinuityIssue[] }>();
  for (const issue of input.issues) {
    if (issue.type === "missing_beat" || !issue.quote) continue;
    const sentence = sentenceContaining(input.draftBody, issue.quote);
    if (!sentence) continue;
    const paragraph = paragraphs.find((item) => item.includes(sentence)) ?? sentence;
    const entry = bySentence.get(sentence) ?? { sentence, paragraph, issues: [] };
    entry.issues.push(issue);
    bySentence.set(sentence, entry);
  }
  if (bySentence.size === 0) return { draftBody: input.draftBody, repairedParagraphs: 0 };
  const targets = [...bySentence.values()].slice(0, MAX_ISSUES).map((entry, index) => ({ id: `S${index + 1}`, ...entry }));
  let out: string;
  try {
    out = await input.callModel(buildRepairMessages({ targets, references: input.references }));
  } catch (error) {
    return { draftBody: input.draftBody, repairedParagraphs: 0, error: error instanceof Error ? error.message : String(error) };
  }
  const match = out.match(/\{[\s\S]*\}/u);
  let fixes: unknown[] = [];
  try {
    const parsed = match ? asRecord(JSON.parse(match[0])) : undefined;
    fixes = Array.isArray(parsed?.fixes) ? parsed.fixes : [];
  } catch {
    return { draftBody: input.draftBody, repairedParagraphs: 0, error: "改稿结果不是 JSON" };
  }
  let body = input.draftBody;
  const changed: string[] = [];
  for (const item of fixes) {
    const record = asRecord(item);
    const target = targets.find((candidate) => candidate.id === String(record?.id ?? "").trim().toUpperCase());
    const text = String(record?.text ?? "").trim();
    if (!target || !text || text === target.sentence || changed.includes(text)) continue;
    // 改出来比原句短一半以上或长两倍半以上：多半删了要紧的话或趁机加戏，不用。
    if (text.length < target.sentence.length * 0.5 || text.length > target.sentence.length * 2.5) continue;
    if (!body.includes(target.sentence)) continue;
    body = body.replace(target.sentence, text);
    changed.push(text);
  }
  if (changed.length === 0) return { draftBody: input.draftBody, repairedParagraphs: 0 };
  const newParagraphs = splitParagraphs(body);
  const changedIndexes = [...new Set(changed
    .map((text) => newParagraphs.findIndex((paragraph) => paragraph.includes(text)))
    .filter((index) => index >= 0))];
  return { draftBody: body, repairedParagraphs: changed.length, changedIndexes };
}

/**
 * 复核只看改过的段落（连同前后各一段作语境）：比整章重审快得多，又能抓住「改出了新冲突 / 没改掉」。
 * 漏写要点不在复核范围（整章级的问题，第一次审读已经报过）。
 */
export function buildSegmentForRecheck(draftBody: string, changedIndexes: readonly number[]): string {
  const paragraphs = splitParagraphs(draftBody);
  const keep = new Set<number>();
  for (const index of changedIndexes) {
    for (const near of [index - 1, index, index + 1]) if (near >= 0 && near < paragraphs.length) keep.add(near);
  }
  return [...keep].sort((a, b) => a - b).map((index) => paragraphs[index]).join("\n\n");
}

export interface CheckAndRepairResult {
  readonly draftBody: string;
  readonly changed: boolean;
  readonly firstCheck: ContinuityCheckResult;
  readonly repairedParagraphs: number;
  /** 修完复核后仍在的问题（含漏写要点）——留给作者定。 */
  readonly remaining: readonly ContinuityIssue[];
  readonly recheck?: ContinuityCheckResult;
  readonly repairError?: string;
}

/** 自动修最多几轮（每轮：改冲突段 → 只复核改过的段）。 */
const MAX_REPAIR_ROUNDS = 2;

/**
 * 整章核一遍 → 有冲突就改涉及的段 → 只复核改过的段 → 还有就再改一轮（最多两轮），绝不无限循环。
 * 复核没跑成不能说「已一致」：把那一轮要修的问题原样留给作者。漏写要点（整章级）不自动改，直接留给作者。
 */
export async function checkAndRepairContinuity(input: {
  readonly chapter: number;
  readonly draftBody: string;
  readonly references: ContinuityReferences;
  readonly chapterPlan?: ChapterPlan;
  readonly checkCallModel: CheckCallModel;
  /** 缺省 = 只核对、不自动改（问题全部留给作者定）。 */
  readonly repairCallModel?: CheckCallModel;
}): Promise<CheckAndRepairResult> {
  const firstCheck = await checkContinuity({ ...input, callModel: input.checkCallModel });
  const missingBeats = firstCheck.issues.filter((issue) => issue.type === "missing_beat");
  let pending = firstCheck.issues.filter((issue) => issue.type !== "missing_beat");
  if (!firstCheck.checked || pending.length === 0 || !input.repairCallModel) {
    return { draftBody: input.draftBody, changed: false, firstCheck, repairedParagraphs: 0, remaining: firstCheck.issues };
  }
  let body = input.draftBody;
  let repairedParagraphs = 0;
  let repairError: string | undefined;
  let recheck: ContinuityCheckResult | undefined;
  for (let round = 0; round < MAX_REPAIR_ROUNDS && pending.length > 0; round += 1) {
    const repair = await repairContinuityIssues({ draftBody: body, issues: pending, references: input.references, callModel: input.repairCallModel! });
    if (repair.repairedParagraphs === 0 || !repair.changedIndexes) {
      if (repair.error) repairError = repair.error;
      break;
    }
    body = repair.draftBody;
    repairedParagraphs += repair.repairedParagraphs;
    const segment = buildSegmentForRecheck(body, repair.changedIndexes);
    recheck = await checkContinuity({ chapter: input.chapter, draftBody: segment, references: input.references, callModel: input.checkCallModel });
    // 复核没跑成：不能说已一致——这一轮要修的问题原样留给作者。
    if (!recheck.checked) break;
    pending = recheck.issues.filter((issue) => issue.type !== "missing_beat");
  }
  const changed = body !== input.draftBody;
  return {
    draftBody: body,
    changed,
    firstCheck,
    repairedParagraphs,
    remaining: [...pending, ...missingBeats],
    ...(recheck ? { recheck } : {}),
    ...(repairError ? { repairError } : {}),
  };
}

/** 给作者看的一段核对报告（进 generate_draft 的 summary）。 */
export function describeContinuityOutcome(result: CheckAndRepairResult): string {
  const first = result.firstCheck;
  if (!first.checked) return `前后核对这次没跑成（${first.error ?? "审读模型没有返回可用结果"}），正文没有核对过，定稿前可以让我再核一遍。`;
  const parts = [`前后核对：对照了 ${first.referenceCount} 条旧设定和前文`];
  if (first.issues.length === 0) return `${parts[0]}，没发现冲突。`;
  parts.push(`发现 ${first.issues.length} 处问题`);
  if (result.repairedParagraphs > 0) parts.push(`已改好 ${result.repairedParagraphs} 处`);
  if (result.repairError) parts.push(`自动修改没成（${result.repairError}）`);
  const remaining = result.remaining;
  if (remaining.length === 0) return `${parts.join("，")}，复核已无冲突。`;
  if (result.repairedParagraphs === 0 && !result.repairError) {
    const all = remaining.slice(0, 4).map((issue) => (issue.type === "missing_beat"
      ? `漏写要点：${issue.conflict || issue.fix}`
      : `「${issue.quote}」与${issue.conflict}`)).join("；");
    return `${parts.join("，")}，没有自动改（你定）：${all}${remaining.length > 4 ? "等" : ""}。要按旧设定改，就说「按核对结果改」。`;
  }
  const listed = remaining.slice(0, 3).map((issue) => (issue.type === "missing_beat"
    ? `漏写要点：${issue.conflict || issue.fix}`
    : `「${issue.quote}」与${issue.conflict}`)).join("；");
  return `${parts.join("，")}；还有 ${remaining.length} 处需要你定：${listed}${remaining.length > 3 ? "等" : ""}。`;
}
