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
    "contradiction：正文里和已知设定/前文对不上的说法——物件在哪、在谁手里、上面写着什么、坏没坏；地点在不在、远近；时间、天数、日期与星期（和【时间线】对得上吗）；年代算术（照【人物】的年龄，某人在某一年多大、那时能不能做那件事）；谁已经知道什么（人物有没有说出他还不可能知道的东西）；人名称谓；数字（几个字、几样东西）。注意：本章明确写了「发生了变化」（如修好了、搬走了）不算矛盾。",
    "repeat：把前文已经发现、确认、做过的事又当成新的写了一遍（又认出同一个记号、又递一次已经递过的材料），或把前文的场面换个地方重演。",
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

export function buildRepairMessages(input: {
  readonly paragraphs: readonly string[];
  readonly targets: readonly { readonly index: number; readonly issues: readonly ContinuityIssue[] }[];
  readonly references: ContinuityReferences;
}): { readonly role: "system" | "user"; readonly content: string }[] {
  const system = [
    "你是小说改稿编辑。下面列出本章里有连续性问题的几段，以及每段的问题和应以哪条设定为准。",
    "只改这些段：把冲突的说法改成与已知设定一致，把重演前文的内容改成往前推进的新内容；尽量保留原段的其余文字、语气和长度，不要删光、不要加解释。",
    "只输出一个 JSON：{\"paragraphs\":[{\"index\":段落编号,\"text\":\"改好的整段\"}]}。",
  ].join("\n");
  const user = [
    input.references.facts.length > 0 ? `【已确立事实】\n${input.references.facts.join("\n")}` : "",
    "【要改的段落】",
    ...input.targets.map((target) => [
      `#${target.index}：${input.paragraphs[target.index]}`,
      ...target.issues.map((issue) => `  问题（${issue.type === "repeat" ? "重演前文" : "与设定冲突"}）：${issue.conflict}；改法：${issue.fix}`),
    ].join("\n")),
    "【前后文（只读，不要改）】",
    ...input.targets.map((target) => [
      target.index > 0 ? `#${target.index - 1}：${input.paragraphs[target.index - 1]}` : "",
      target.index + 1 < input.paragraphs.length ? `#${target.index + 1}：${input.paragraphs[target.index + 1]}` : "",
    ].filter(Boolean).join("\n")),
  ].filter(Boolean).join("\n\n");
  return [{ role: "system", content: system }, { role: "user", content: user }];
}

export interface RepairResult {
  readonly draftBody: string;
  /** 实际改掉的段落数。 */
  readonly repairedParagraphs: number;
  /** 改掉的段落在新正文里的编号（复核只看这几段）。 */
  readonly changedIndexes?: readonly number[];
  readonly error?: string;
}

/** 一次调用改完所有冲突段（只换这些段，其余一字不动）。改出来过短/空的段不用。 */
export async function repairContinuityIssues(input: {
  readonly draftBody: string;
  readonly issues: readonly ContinuityIssue[];
  readonly references: ContinuityReferences;
  readonly callModel: CheckCallModel;
}): Promise<RepairResult> {
  const paragraphs = [...splitParagraphs(input.draftBody)];
  const byIndex = new Map<number, ContinuityIssue[]>();
  for (const issue of input.issues) {
    if (issue.type === "missing_beat" || !issue.quote) continue;
    const index = findParagraphIndex(paragraphs, issue.quote);
    if (index < 0) continue;
    byIndex.set(index, [...(byIndex.get(index) ?? []), issue]);
  }
  if (byIndex.size === 0) return { draftBody: input.draftBody, repairedParagraphs: 0 };
  const targets = [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([index, issues]) => ({ index, issues }));
  let out: string;
  try {
    out = await input.callModel(buildRepairMessages({ paragraphs, targets, references: input.references }));
  } catch (error) {
    return { draftBody: input.draftBody, repairedParagraphs: 0, error: error instanceof Error ? error.message : String(error) };
  }
  const match = out.match(/\{[\s\S]*\}/u);
  let rewritten: unknown[] = [];
  try {
    const parsed = match ? asRecord(JSON.parse(match[0])) : undefined;
    rewritten = Array.isArray(parsed?.paragraphs) ? parsed.paragraphs : [];
  } catch {
    return { draftBody: input.draftBody, repairedParagraphs: 0, error: "改稿结果不是 JSON" };
  }
  const changedIndexes: number[] = [];
  for (const item of rewritten) {
    const record = asRecord(item);
    const index = Number(record?.index);
    const text = String(record?.text ?? "").trim();
    if (!byIndex.has(index) || !text || changedIndexes.includes(index)) continue;
    // 改出来比原段短一半以上 → 多半是删光了或只回了半句，不用。
    if (text.length < paragraphs[index].length * 0.5) continue;
    paragraphs[index] = text;
    changedIndexes.push(index);
  }
  return changedIndexes.length > 0
    ? { draftBody: paragraphs.join("\n\n"), repairedParagraphs: changedIndexes.length, changedIndexes }
    : { draftBody: input.draftBody, repairedParagraphs: 0 };
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
  readonly repairCallModel: CheckCallModel;
}): Promise<CheckAndRepairResult> {
  const firstCheck = await checkContinuity({ ...input, callModel: input.checkCallModel });
  const missingBeats = firstCheck.issues.filter((issue) => issue.type === "missing_beat");
  let pending = firstCheck.issues.filter((issue) => issue.type !== "missing_beat");
  if (!firstCheck.checked || pending.length === 0) {
    return { draftBody: input.draftBody, changed: false, firstCheck, repairedParagraphs: 0, remaining: firstCheck.issues };
  }
  let body = input.draftBody;
  let repairedParagraphs = 0;
  let repairError: string | undefined;
  let recheck: ContinuityCheckResult | undefined;
  for (let round = 0; round < MAX_REPAIR_ROUNDS && pending.length > 0; round += 1) {
    const repair = await repairContinuityIssues({ draftBody: body, issues: pending, references: input.references, callModel: input.repairCallModel });
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
  if (result.repairedParagraphs > 0) parts.push(`已改好 ${result.repairedParagraphs} 段`);
  if (result.repairError) parts.push(`自动修改没成（${result.repairError}）`);
  const remaining = result.remaining;
  if (remaining.length === 0) return `${parts.join("，")}，复核已无冲突。`;
  const listed = remaining.slice(0, 3).map((issue) => (issue.type === "missing_beat"
    ? `漏写要点：${issue.conflict || issue.fix}`
    : `「${issue.quote}」与${issue.conflict}`)).join("；");
  return `${parts.join("，")}；还有 ${remaining.length} 处需要你定：${listed}${remaining.length > 3 ? "等" : ""}。`;
}
