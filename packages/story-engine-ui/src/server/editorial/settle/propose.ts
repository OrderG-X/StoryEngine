/**
 * 定论预览（P12「前文一次定死」）：作者在两句打架的说法里点了「以这句为准」（或自己写下一条定论），
 * 这里算出要改的全部地方，交给预览卡；作者点「确认」后由 settle.apply 一次写完。模型只提、代码核：
 *
 *  1. 写定论：模型把作者选的那句写成一句话，顺带报这件事涉及的名字；作者自己写的定论只问名字。
 *  2. 圈章：名字连同设定卡上的别名逐字出现在哪些已定稿章 / 当前工作稿里，只查这些（名字一个都没给就全书查）。
 *  3. 扫：圈到的章按编号句子分批并行问「哪几句和定论对不上、改成什么」，只回编号和新句；设定本里相关的栏也编号问一遍。
 *  4. 账跟着改：改到的句子里记过账的事实，问一次「照旧 / 改成 / 去掉」，新原句要逐字在改后的正文里。
 *
 * 每一步失败都如实记进 failures，不当成「没有要改的」。纯提议：不写正文、不写真相，只把结果交回去（存盘由 store 管）。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  applyUnitEdits,
  draftPath,
  draftVersionOf,
  fitQuotes,
  listChapterTexts,
  nameKey,
  numberedText,
  quoteInText,
  readCardsOrLegacy,
  readChapterLedger,
  readChapterText,
  sha256,
  splitUnits,
  type SettingCardsFile,
  type TextUnit,
} from "@actalk/story-core";
import type { BrainCallModel } from "../reader-window.js";

/** 作者选的那一边（或和它打架的那一边）：某章（或工作稿）里的一句，或设定本里的一句。 */
export type SettleSide =
  | { readonly where: "chapter"; readonly chapter: number; readonly quote: string }
  | { readonly where: "setting"; readonly quote: string; readonly label: string; readonly card?: string };

export type SettleRequest =
  | {
      readonly kind: "pick";
      /** 正在写 / 核的那一章（它的工作稿也查）。 */
      readonly chapter: number;
      readonly truth: SettleSide;
      readonly other?: SettleSide;
      /** 核账员说的哪里对不上。 */
      readonly reason?: string;
    }
  | { readonly kind: "statement"; readonly text: string; readonly chapter?: number };

export interface SettleEdit {
  /** 预览卡上去掉某处用的键。 */
  readonly key: string;
  readonly chapter: number;
  /** committed = 已定稿正文；draft = 还没定稿那章的工作稿。 */
  readonly target: "committed" | "draft";
  readonly id: number;
  readonly from: string;
  readonly to: string;
  readonly why?: string;
}

export interface SettleFactChange {
  readonly chapter: number;
  readonly factId: string;
  /** 账里原来那条（给人看的说明）。 */
  readonly before: string;
  /** 改成什么（给人看的说明）；没有 = 作废。 */
  readonly after?: string;
  readonly patch?: { readonly value?: string; readonly text?: string; readonly quote: string };
}

export interface SettleFieldEdit {
  readonly key: string;
  /** 卡名；故事设定没有。 */
  readonly card?: string;
  readonly label: string;
  readonly from: string;
  readonly to: string;
}

export interface SettleProposal {
  readonly canon: string;
  /** 设定本里已经有这条定论（这次不再加）。 */
  readonly canonExists: boolean;
  readonly chapter?: number;
  readonly edits: readonly SettleEdit[];
  readonly facts: readonly SettleFactChange[];
  readonly fields: readonly SettleFieldEdit[];
  /** 已定稿章预览时的正文哈希；另有工作稿的带上它的版本（同一句跟着改）。 */
  readonly committed: readonly { readonly chapter: number; readonly textSha256: string; readonly draftVersion?: string }[];
  /** 还没定稿那章的工作稿版本。 */
  readonly drafts: readonly { readonly chapter: number; readonly baseVersion: string }[];
  /** 查过的章（给人看「查了第几章」）。 */
  readonly searched: readonly number[];
  /** 作者点的那句打架的话这次没查出来要改（如实说）。 */
  readonly otherMissed?: { readonly chapter: number; readonly quote: string };
  readonly failures: readonly string[];
}

/** 一批最多这么多字（编号后的正文）：一章超了就自己一批。 */
export const SETTLE_BATCH_CHARS = 12_000;
const MAX_NAMES = 8;
const MAX_EDITS_PER_BATCH = 24;

interface SweepDoc {
  readonly chapter: number;
  readonly target: "committed" | "draft";
  readonly text: string;
  readonly units: readonly TextUnit[];
  readonly numbered: string;
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const str = (value: unknown): string => (typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "");
const int = (value: unknown): number | undefined => {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value.trim()) : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
};

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function sideLine(side: SettleSide, docs: ReadonlyMap<number, SweepDoc>): string {
  if (side.where === "setting") return `设定本（${side.card ? `${side.label}「${side.card}」` : side.label}）：「${side.quote}」`;
  const doc = docs.get(side.chapter);
  const where = doc?.target === "draft" ? `第 ${side.chapter} 章（工作稿）` : `第 ${side.chapter} 章`;
  const unit = doc?.units.find((item) => quoteInText(side.quote, item.text)) ?? doc?.units.find((item) => quoteInText(item.text, side.quote));
  if (!doc || !unit) return `${where}：「${side.quote}」`;
  const before = doc.units[unit.id - 2]?.text ?? "";
  const after = doc.units[unit.id]?.text ?? "";
  return `${where}：「${side.quote}」（前后文：${before}【${unit.text}】${after}）`;
}

export function canonTask(request: Extract<SettleRequest, { kind: "pick" }>, docs: ReadonlyMap<number, SweepDoc>): string {
  return [
    "作者在两处打架的说法里定了一处为准，请把它写成一条「定论」（这本书以后都以它为准）。",
    `【作者选为准的】${sideLine(request.truth, docs)}`,
    ...(request.other ? [`【和它打架的】${sideLine(request.other, docs)}`] : []),
    ...(request.reason ? [`【核账员说】${request.reason}`] : []),
    "要求：",
    "- canon：一句话写清作者定下的这件事本身（照作者选的那句的说法，只写事实，不写章号、不写「以……为准」，不超过 60 字）；",
    "- names：这件事涉及的人名、地名、物名（照正文的写法，最多 6 个）。",
    '只输出一个 JSON：{"canon":"","names":[]}',
  ].join("\n");
}

export function namesTask(canon: string): string {
  return [
    `作者写下了一条定论（这本书以后都以它为准）：「${canon}」`,
    "列出这件事涉及的人名、地名、物名（照正文的写法，最多 6 个）。",
    '只输出一个 JSON：{"names":[]}',
  ].join("\n");
}

export function sweepTask(canon: string, docs: readonly SweepDoc[]): string {
  return [
    `作者定下了一条定论（全书以它为准）：「${canon}」`,
    "下面是这本书的几章正文，每句前面有编号 [n]。逐句看，找出说法和这条定论对不上的句子（同一件事写成了别的样子）。",
    "- 写了变化过程的、人物明确在撒谎或记错的、说的不是同一件事的，不算；",
    "- 每处给出改法 to：只改和定论对不上的那几个字，别的字照抄，改完还是通顺的一整句，不加新情节；",
    "- chapter 写第几章，id 写那句的编号，why 用一句话说哪里和定论对不上。",
    '只输出一个 JSON：{"edits":[{"chapter":1,"id":1,"to":"","why":""}]}。一处都没有就给 {"edits":[]}。',
    "",
    ...docs.flatMap((doc) => [`【第 ${doc.chapter} 章${doc.target === "draft" ? "（工作稿，还没定稿）" : ""}】`, doc.numbered, ""]),
  ].join("\n");
}

interface FieldRef {
  readonly id: string;
  readonly card?: string;
  readonly label: string;
  readonly value: string;
  readonly ai: boolean;
}

export function fieldsTask(canon: string, fields: readonly FieldRef[]): string {
  return [
    `作者定下了一条定论（全书以它为准）：「${canon}」`,
    "下面是设定本里相关的几栏，每栏前面有编号。找出内容和这条定论对不上的栏，给出改后的整栏内容（只改对不上的部分，别的照抄）。",
    "说的不是同一件事的不算。",
    '只输出一个 JSON：{"edits":[{"id":"S1","to":""}]}。一栏都没有就给 {"edits":[]}。',
    "",
    ...fields.map((field) => `[${field.id}]${field.card ? `${field.card} · ` : "故事设定 · "}${field.label}：${field.value}${field.ai ? "（AI 补的）" : ""}`),
  ].join("\n");
}

interface FactRef {
  readonly id: string;
  readonly factId: string;
  readonly nature: string;
  readonly subject?: string;
  readonly attribute?: string;
  readonly value?: string;
  readonly text: string;
  readonly quote: string;
}

export function factsTask(canon: string, chapter: number, edits: readonly SettleEdit[], facts: readonly FactRef[]): string {
  return [
    `作者定下了一条定论：「${canon}」。第 ${chapter} 章为此改了这几句：`,
    ...edits.map((edit) => `- 原句「${edit.from}」→ 改成「${edit.to}」`),
    "账里这几条事实引用了改掉的句子：",
    ...facts.map((fact) => `[${fact.id}] ${[fact.subject, fact.attribute, fact.value].filter(Boolean).join("｜") || "（事件）"} —— ${fact.text}（原句：「${fact.quote}」）`),
    "每条回一个 action：keep（改后的句子还是这么说，给新原句 quote）、update（改后说法变了：给新的 value（事件不用）、新的说明 text、新原句 quote）、drop（改后这条不成立了）。",
    "quote 必须逐字抄改后的句子里的一段（至少 4 个字）。",
    '只输出一个 JSON：{"facts":[{"id":"F1","action":"update","value":"","text":"","quote":""}]}',
  ].join("\n");
}

/** 把一章（或工作稿）切好编号。 */
function docOf(chapter: number, target: SweepDoc["target"], text: string): SweepDoc {
  const units = splitUnits(text);
  return { chapter, target, text, units, numbered: numberedText(units) };
}

function batchesOf(docs: readonly SweepDoc[]): SweepDoc[][] {
  const batches: SweepDoc[][] = [];
  let current: SweepDoc[] = [];
  let size = 0;
  for (const doc of docs) {
    if (current.length > 0 && size + doc.numbered.length > SETTLE_BATCH_CHARS) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(doc);
    size += doc.numbered.length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function rangeLabel(batch: readonly SweepDoc[]): string {
  const first = batch[0]!.chapter;
  const last = batch.at(-1)!.chapter;
  return first === last ? `第 ${first} 章` : `第 ${first}～${last} 章`;
}

/** 解析一批的改法：章、编号要真在这批里，新句理得平引号、和原句不一样；同一句只留第一种改法。 */
export function parseSweepEdits(text: string, batch: readonly SweepDoc[]): Omit<SettleEdit, "key">[] {
  const parsed = parseJsonObject(text);
  if (!parsed || !Array.isArray(parsed.edits)) throw new Error("模型回的不是要的格式");
  const out: Omit<SettleEdit, "key">[] = [];
  const seen = new Set<string>();
  for (const raw of parsed.edits.slice(0, MAX_EDITS_PER_BATCH)) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    const chapter = int(record.chapter);
    const id = int(record.id);
    const doc = batch.find((item) => item.chapter === chapter);
    const unit = doc && id !== undefined ? doc.units[id - 1] : undefined;
    if (!doc || !unit) continue;
    const key = `${doc.chapter}:${unit.id}`;
    if (seen.has(key)) continue;
    const proposed = str(record.to);
    const fitted = proposed ? fitQuotes(unit.text, proposed.replace(/\s*\n+\s*/gu, "")) : undefined;
    if (!fitted || fitted === unit.text || fitted.length > unit.text.length * 3 + 60) continue;
    seen.add(key);
    const why = str(record.why);
    out.push({ chapter: doc.chapter, target: doc.target, id: unit.id, from: unit.text, to: fitted, ...(why ? { why } : {}) });
  }
  return out;
}

export function parseFieldEdits(text: string, fields: readonly FieldRef[]): Omit<SettleFieldEdit, "key">[] {
  const parsed = parseJsonObject(text);
  if (!parsed || !Array.isArray(parsed.edits)) throw new Error("模型回的不是要的格式");
  const out: Omit<SettleFieldEdit, "key">[] = [];
  for (const raw of parsed.edits) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    const field = fields.find((item) => item.id === str(record.id));
    const to = str(record.to);
    if (!field || !to || to === field.value || out.some((item) => item.card === field.card && item.label === field.label)) continue;
    out.push({ ...(field.card ? { card: field.card } : {}), label: field.label, from: field.value, to });
  }
  return out;
}

export function parseFactChanges(text: string, chapter: number, facts: readonly FactRef[], nextText: string): SettleFactChange[] {
  const parsed = parseJsonObject(text);
  if (!parsed || !Array.isArray(parsed.facts)) throw new Error("模型回的不是要的格式");
  const out: SettleFactChange[] = [];
  for (const fact of facts) {
    const raw = parsed.facts.find((item) => item && typeof item === "object" && str((item as Record<string, unknown>).id) === fact.id) as Record<string, unknown> | undefined;
    const action = str(raw?.action).toLowerCase();
    const quote = str(raw?.quote);
    const base = { chapter, factId: fact.factId, before: fact.text };
    if ((action !== "keep" && action !== "update") || !quote || !quoteInText(quote, nextText)) {
      out.push(base);
      continue;
    }
    if (action === "keep") {
      out.push({ ...base, after: fact.text, patch: { quote } });
      continue;
    }
    const value = str(raw?.value);
    const textAfter = str(raw?.text) || fact.text;
    if (fact.nature !== "event" && !value) {
      out.push(base);
      continue;
    }
    out.push({ ...base, after: textAfter, patch: { ...(fact.nature !== "event" ? { value } : {}), text: textAfter, quote } });
  }
  return out;
}

/** 名字 → 圈章用的词：模型给的名字（两个字起）+ 设定卡上同一张卡的名字和别名。 */
export function termsFor(names: readonly string[], cards: SettingCardsFile): string[] {
  const terms = new Set<string>();
  for (const raw of names.slice(0, MAX_NAMES)) {
    const name = raw.trim();
    if (Array.from(name).length < 2) continue;
    terms.add(name);
    const card = cards.cards.find((item) => [item.name, ...item.aliases].some((alias) => nameKey(alias) === nameKey(name)));
    if (card) for (const alias of [card.name, ...card.aliases]) if (Array.from(alias.trim()).length >= 2) terms.add(alias.trim());
  }
  return [...terms];
}

function fieldRefs(cards: SettingCardsFile, terms: readonly string[]): FieldRef[] {
  const refs: FieldRef[] = [];
  const push = (card: string | undefined, label: string, value: string, ai: boolean): void => {
    refs.push({ id: `S${refs.length + 1}`, ...(card ? { card } : {}), label, value, ai });
  };
  for (const field of cards.story.fields) push(undefined, field.label, field.value, field.by === "ai");
  for (const card of cards.cards) {
    const names = [card.name, ...card.aliases];
    if (terms.length > 0 && !names.some((name) => terms.some((term) => nameKey(term) === nameKey(name)))) continue;
    for (const field of card.fields) push(card.name, field.label, field.value, field.by === "ai");
  }
  return refs;
}

async function askNames(callModel: BrainCallModel, prompt: string): Promise<{ canon?: string; names: string[] }> {
  const parsed = parseJsonObject(await callModel([{ role: "user", content: prompt }], { json: true }));
  if (!parsed) throw new Error("模型回的不是要的格式");
  const names = Array.isArray(parsed.names) ? parsed.names.map(str).filter(Boolean) : [];
  const canon = str(parsed.canon);
  return { ...(canon ? { canon } : {}), names };
}

export async function proposeSettle(input: {
  readonly projectDir: string;
  readonly request: SettleRequest;
  readonly callModel: BrainCallModel;
}): Promise<{ readonly ok: true; readonly proposal: SettleProposal } | { readonly ok: false; readonly message: string }> {
  const { projectDir, request, callModel } = input;
  const failures: string[] = [];
  const cards = await readCardsOrLegacy(projectDir);
  const committedNumbers = await listChapterTexts(projectDir);
  const focusChapter = request.chapter;

  // 正在写的那章有工作稿就查工作稿（作者眼前那份），别的章查定稿正文。
  const docs = new Map<number, SweepDoc>();
  const committed: { chapter: number; textSha256: string; draftVersion?: string; draftText?: string }[] = [];
  const drafts: { chapter: number; baseVersion: string }[] = [];
  if (focusChapter !== undefined) {
    const raw = await readOptional(join(projectDir, draftPath(focusChapter)));
    if (raw !== undefined && raw.trim()) {
      docs.set(focusChapter, docOf(focusChapter, "draft", raw));
      drafts.push({ chapter: focusChapter, baseVersion: draftVersionOf(raw) });
    }
  }
  for (const chapter of committedNumbers) {
    if (docs.has(chapter)) continue;
    const text = await readChapterText(projectDir, chapter);
    if (text === undefined) continue;
    docs.set(chapter, docOf(chapter, "committed", text));
    const draftRaw = await readOptional(join(projectDir, draftPath(chapter)));
    committed.push({ chapter, textSha256: sha256(text), ...(draftRaw?.trim() ? { draftVersion: draftVersionOf(draftRaw), draftText: draftRaw } : {}) });
  }

  let canon: string;
  let names: string[] = [];
  // 按已记下的定论查（核账卡「以定论为准」带的是核账员摘的那半句）：用设定本里那一整条，别再记一条半截的。
  const statementText = request.kind === "statement"
    ? cards.canon.find((item) => item.text.includes(request.text.trim()))?.text ?? request.text.trim()
    : "";
  try {
    if (request.kind === "pick") {
      const asked = await askNames(callModel, canonTask(request, docs));
      if (!asked.canon) return { ok: false, message: "这次没写出定论（模型没回），重新点一次试试。" };
      canon = asked.canon.slice(0, 400);
      names = asked.names;
    } else {
      canon = statementText;
      names = (await askNames(callModel, namesTask(canon))).names;
    }
  } catch (error) {
    if (request.kind === "pick") return { ok: false, message: `这次没写出定论（${error instanceof Error ? error.message : String(error)}），重新点一次试试。` };
    canon = statementText;
    failures.push("没问出这条定论涉及谁，这次全书都查了");
  }

  const terms = termsFor(names, cards);
  const pinned = new Set<number>([
    ...(focusChapter !== undefined ? [focusChapter] : []),
    ...(request.kind === "pick" ? [request.truth, request.other].flatMap((side) => (side?.where === "chapter" ? [side.chapter] : [])) : []),
  ]);
  const picked = [...docs.values()]
    .filter((doc) => terms.length === 0 || pinned.has(doc.chapter) || terms.some((term) => doc.text.includes(term)))
    .sort((a, b) => a.chapter - b.chapter);

  const batches = batchesOf(picked);
  const fields = fieldRefs(cards, terms);
  const [batchResults, fieldResult] = await Promise.all([
    Promise.allSettled(batches.map(async (batch) => parseSweepEdits(await callModel([{ role: "user", content: sweepTask(canon, batch) }], { json: true }), batch))),
    fields.length > 0
      ? callModel([{ role: "user", content: fieldsTask(canon, fields) }], { json: true }).then((text) => parseFieldEdits(text, fields)).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      )
      : Promise.resolve({ ok: true as const, value: [] as Omit<SettleFieldEdit, "key">[] }),
  ]);
  const found: Omit<SettleEdit, "key">[] = [];
  batchResults.forEach((result, index) => {
    if (result.status === "fulfilled") found.push(...result.value);
    else failures.push(`${rangeLabel(batches[index]!)}这一批没查成（${result.reason instanceof Error ? result.reason.message : String(result.reason)}）`);
  });
  if (!fieldResult.ok) failures.push(`设定本那一遍没查成（${fieldResult.error instanceof Error ? fieldResult.error.message : String(fieldResult.error)}）`);
  const edits: SettleEdit[] = found
    .sort((a, b) => a.chapter - b.chapter || a.id - b.id)
    .map((edit, index) => ({ ...edit, key: `e${index + 1}` }));
  const fieldEdits: SettleFieldEdit[] = (fieldResult.ok ? fieldResult.value : []).map((edit, index) => ({ ...edit, key: `f${index + 1}` }));

  // 账跟着改：每章把改法套一遍，原句被碰到的事实问一次。
  const facts: SettleFactChange[] = [];
  const touched = [...new Set(edits.filter((edit) => edit.target === "committed").map((edit) => edit.chapter))];
  await Promise.all(touched.map(async (chapter) => {
    const doc = docs.get(chapter)!;
    const mine = edits.filter((edit) => edit.chapter === chapter);
    const applied = applyUnitEdits(doc.text, mine.map(({ id, from, to }) => ({ id, from, to })));
    if (!applied.ok) {
      failures.push(`第 ${chapter} 章的改法套不上（${applied.message}）`);
      return;
    }
    const ledger = await readChapterLedger(projectDir, chapter).catch(() => undefined);
    const affected: FactRef[] = [];
    for (const entry of ledger?.entries ?? []) {
      if (entry.kind !== "fact" || !entry.quote) continue;
      if (!quoteInText(entry.quote, doc.text) || quoteInText(entry.quote, applied.text)) continue;
      affected.push({
        id: `F${affected.length + 1}`,
        factId: entry.id,
        nature: entry.nature,
        ...(entry.subject ? { subject: entry.subject } : {}),
        ...(entry.attribute ? { attribute: entry.attribute } : {}),
        ...(entry.value ? { value: entry.value } : {}),
        text: entry.text,
        quote: entry.quote,
      });
    }
    if (affected.length === 0) return;
    try {
      const reply = await callModel([{ role: "user", content: factsTask(canon, chapter, mine, affected) }], { json: true });
      facts.push(...parseFactChanges(reply, chapter, affected, applied.text));
    } catch (error) {
      failures.push(`第 ${chapter} 章账里跟着改的那几条没问成（${error instanceof Error ? error.message : String(error)}），确认后这几条会作废`);
      facts.push(...affected.map((fact) => ({ chapter, factId: fact.factId, before: fact.text })));
    }
  }));

  // 已定稿章另有工作稿的：同一句在工作稿里一字不差、只出现一次才跟着改。
  const committedOut = committed.map(({ chapter, textSha256, draftVersion, draftText }) => {
    if (!draftVersion || !draftText) return { chapter, textSha256 };
    const units = splitUnits(draftText);
    const carried = edits.filter((edit) => edit.chapter === chapter && units.filter((unit) => unit.text === edit.from).length === 1);
    return carried.length > 0 ? { chapter, textSha256, draftVersion } : { chapter, textSha256 };
  });

  let otherMissed: SettleProposal["otherMissed"];
  if (request.kind === "pick" && request.other?.where === "chapter") {
    const other = request.other;
    const doc = docs.get(other.chapter);
    const unit = doc?.units.find((item) => quoteInText(other.quote, item.text) || quoteInText(item.text, other.quote));
    const covered = unit !== undefined && edits.some((edit) => edit.chapter === other.chapter && edit.id === unit.id);
    if (!covered) otherMissed = { chapter: other.chapter, quote: other.quote };
  }

  return {
    ok: true,
    proposal: {
      canon,
      canonExists: cards.canon.some((item) => nameKey(item.text) === nameKey(canon)),
      ...(focusChapter !== undefined ? { chapter: focusChapter } : {}),
      edits,
      facts: facts.sort((a, b) => a.chapter - b.chapter),
      fields: fieldEdits,
      committed: committedOut.filter((item) => edits.some((edit) => edit.target === "committed" && edit.chapter === item.chapter)),
      drafts: drafts.filter((item) => edits.some((edit) => edit.target === "draft" && edit.chapter === item.chapter)),
      searched: picked.map((doc) => doc.chapter),
      ...(otherMissed ? { otherMissed } : {}),
      failures,
    },
  };
}
