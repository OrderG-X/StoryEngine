/**
 * 定论预览（P12「前文一次定死」）：作者在两句打架的说法里点了「以这句为准」（或自己写下一条定论），
 * 这里算出要改的全部地方，交给预览卡；作者点「确认」后由 settle.apply 一次写完。模型只提、代码核：
 *
 *  1. 写定论：模型把作者选的那句写成一句话，顺带报这件事涉及的名字；作者自己写的定论只问名字。
 *  2. 圈章：名字连同设定卡上的别名逐字出现在哪些已定稿章 / 当前工作稿里，只查这些（名字一个都没给就全书查）。
 *  3. 扫：圈到的章按编号句子分批并行问「哪几句和定论对不上、改成什么」，只回编号和新句；设定本里相关的栏也编号问一遍。
 *  4. 复核：扫出来的改法（作者点的那句除外）再问一遍「真的对不上吗」，推算站不住的去掉——扫的时候宁多勿漏，这里收。
 *  5. 账跟着改：改到的句子里记过账的事实，问一次「照旧 / 改成 / 去掉」，新原句要逐字在改后的正文里；
 *     老书导入的账没记原句的事实一并问（多半不动），说法变了的改、不成立的作废。
 *
 * 每一步失败都如实记进 failures，不当成「没有要改的」。纯提议：不写正文、不写真相，只把结果交回去（存盘由 store 管）。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  applyUnitEdits,
  draftPath,
  draftVersionOf,
  listChapterTexts,
  nameKey,
  numberedText,
  prepareUnitReplacement,
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
export type ChapterSide = Extract<SettleSide, { readonly where: "chapter" }>;

export type SettleRequest =
  | {
      readonly kind: "pick";
      /** 正在写 / 核的那一章（它的工作稿也查）。 */
      readonly chapter: number;
      readonly truth: SettleSide;
      readonly other?: SettleSide;
      /** 核账卡上和同一句（同一条设定）打架的别几句：一并要改，一句都不能漏。 */
      readonly also?: readonly ChapterSide[];
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
  /** 老账里没记原句的那种：不会因原句被改自动作废，作废要点名。 */
  readonly loose?: true;
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
  /** 只是某一场里的事（那一夜的风、谁一时站在哪）：只改句子，不记进设定本「定论」。 */
  readonly sceneOnly?: boolean;
  /** 改的是设定本里已有的那条定论（新的取代旧的）：确认时换掉它，不另加一条。 */
  readonly replaces?: { readonly id: string; readonly text: string };
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
  /** 核账报过和它打架、这次却没查出改法的句子（如实说）。 */
  readonly missed: readonly { readonly chapter: number; readonly quote: string }[];
  /** 复核去掉的改法（不上卡，留在存盘里查问题用）。 */
  readonly reviewDropped: readonly { readonly chapter: number; readonly from: string; readonly to: string; readonly why?: string }[];
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

function sideLine(side: SettleSide, docs: ReadonlyMap<number, SweepDoc>, cards?: SettingCardsFile): string {
  if (side.where === "setting") {
    // 同一张卡上别的几栏帮着看懂这条说的是什么事（回归书：「下月办手续」不看「即将退休」那栏，定论写成了「每月办手续」）。
    const card = side.card ? cards?.cards.find((item) => nameKey(item.name) === nameKey(side.card!)) : undefined;
    const others = card?.fields.filter((field) => !quoteInText(side.quote, field.value) && !quoteInText(field.value, side.quote)).map((field) => `${field.label}：${field.value}`) ?? [];
    return `设定本（${side.card ? `${side.label}「${side.card}」` : side.label}）：「${side.quote}」${others.length > 0 ? `（这张卡别的几栏：${others.join("；")}）` : ""}`;
  }
  const doc = docs.get(side.chapter);
  const where = doc?.target === "draft" ? `第 ${side.chapter} 章（工作稿）` : `第 ${side.chapter} 章`;
  const unit = doc?.units.find((item) => quoteInText(side.quote, item.text)) ?? doc?.units.find((item) => quoteInText(item.text, side.quote));
  if (!doc || !unit) return `${where}：「${side.quote}」`;
  const before = doc.units[unit.id - 2]?.text ?? "";
  const after = doc.units[unit.id]?.text ?? "";
  return `${where}：「${side.quote}」（前后文：${before}【${unit.text}】${after}）`;
}

export function canonTask(request: Extract<SettleRequest, { kind: "pick" }>, docs: ReadonlyMap<number, SweepDoc>, cards?: SettingCardsFile): string {
  return [
    "作者在两处打架的说法里定了一处为准，请把它写成一条「定论」（这本书以后都以它为准）。",
    `【作者选为准的】${sideLine(request.truth, docs, cards)}`,
    ...(request.other ? [`【和它打架的（这边要跟着改）】${sideLine(request.other, docs, cards)}`] : []),
    ...(request.reason ? [`【核账员说】${request.reason}`] : []),
    "要求：",
    "- point：先想清楚两处说的是哪一件事、哪一点说得不一样，写成一个问句（比如「看仓人多大年纪？」「挂锁是什么颜色？」）；",
    "- canon：照【作者选为准的】那边的说法回答这个问句，只答这一点：那句里别的事（长相、动作、别的物件）一概不写；",
    "  正面写（比如「某某二十九岁」），别写成否定另一边的话（「没有……」「不是……」）；数字、时间照原句抄；原句说得含糊的，看前后文和另一边说的是什么事把它说明白；",
    "  主语写全（写名字，别用「他」「她」「这」，也别省掉），单拿出来也看得懂；不写章号、不写「以……为准」，不超过 40 字；",
    "  说的是谁平常带着什么、东西放在哪这类每场都会变的事时，写那件东西本身（「某某随身带的是一把黑伞」），别写一时的拿法、姿势（「攥着」「搭在肩上」「横在膝上」）；",
    "- names：这件事涉及的人名、地名、物名（照正文的写法，最多 6 个）；",
    "- keep：这条以后写别的章还用得着吗？人物的年纪、长相、身份、来历，谁有什么东西、东西什么样，大事在哪天、在哪发生——用得着，写 true；只是那一场里的天气、风、光线，谁一时站在哪、在干什么——过了那一场就用不着，写 false（这样的只改句子，不记进设定本）。",
    '只输出一个 JSON：{"point":"","canon":"","names":[],"keep":true}',
  ].join("\n");
}

export function namesTask(canon: string, existing: readonly string[] = []): string {
  return [
    `作者写下了一条定论（这本书以后都以它为准）：「${canon}」`,
    "- names：列出这件事涉及的人名、地名、物名（照正文的写法，最多 6 个）。",
    ...(existing.length > 0
      ? [
        "- replaces：设定本里已经记着下面几条定论。这条新的是不是在改其中一条（说的是同一件事，新的说法取代旧的）？是就填那条的编号，不是填 0。",
        ...existing.map((text, index) => `[${index + 1}] ${text}`),
        '只输出一个 JSON：{"names":[],"replaces":0}',
      ]
      : ['只输出一个 JSON：{"names":[]}']),
  ].join("\n");
}

export function sweepTask(canon: string, docs: readonly SweepDoc[], flagged: readonly ChapterSide[] = []): string {
  const mine = flagged.filter((side) => docs.some((doc) => doc.chapter === side.chapter));
  return [
    `作者定下了一条定论（全书以它为准）：「${canon}」`,
    "下面是这本书的几章正文，每句前面有编号 [n]。逐句看，找出说法和这条定论对不上的句子（同一件事写成了别的样子）。",
    ...(mine.length > 0 ? [`核账已经报过这几句和它对不上，一定给出改法：${mine.map((side) => `第 ${side.chapter} 章「${side.quote}」`).join("；")}。`] : []),
    "- 原句说的得是定论里的同一个人、同一件东西、同一件事：名字不一样的、只是身份相近（都是看门的、都是老人）或同一类东西的，不算——宁可漏掉，也别把别人改成定论里的人；",
    "- 写了变化过程的、人物明确在撒谎或记错的，不算；",
    "- 定论说的是平常带着什么、放在哪这类事时：原句只是那一场里一时的拿法、放法，或者那一场顺手抄起了别的东西、换了别人拿着，不算；",
    "- 每处给出改法 to：把和定论对不上的说法改成定论的说法，别的字尽量照抄；改完还是一整句，读起来要通顺、前后说得通（别留下只有原说法才说得通的半截）；不加新情节、不加新台词，前后句写过的事别再写进这一句；",
    "- chapter 写第几章，id 写那句的编号，why 用一句话说哪里和定论对不上。",
    '只输出一个 JSON：{"edits":[{"chapter":1,"id":1,"to":"","why":""}]}。一处都没有就给 {"edits":[]}。',
    "",
    ...docs.flatMap((doc) => [`【第 ${doc.chapter} 章${doc.target === "draft" ? "（工作稿）" : ""}】`, doc.numbered, ""]),
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
    "to 只写这一栏改后的内容本身，不带编号、卡名、栏名。",
    '只输出一个 JSON：{"edits":[{"id":"S1","to":""}]}。一栏都没有就给 {"edits":[]}。',
    "",
    ...fields.map((field) => `[${field.id}]${fieldHead(field)}${field.value}${field.ai ? AI_MARK : ""}`),
  ].join("\n");
}

const AI_MARK = "（AI 补的）";
const fieldHead = (field: Pick<FieldRef, "card" | "label">): string => `${field.card ?? "故事设定"} · ${field.label}：`;

/** 模型回的整栏内容常把提示里那栏的头（编号、卡名 · 栏名：）和「（AI 补的）」一起抄回来：照我们自己写的样子去掉。 */
function stripFieldEcho(to: string, field: FieldRef): string {
  let out = to.trim();
  for (const head of [`[${field.id}]`, fieldHead(field), `${field.label}：`]) {
    if (out.startsWith(head)) out = out.slice(head.length).trim();
  }
  if (out.endsWith(AI_MARK)) out = out.slice(0, -AI_MARK.length).trim();
  return out;
}

interface FactRef {
  readonly id: string;
  readonly factId: string;
  readonly nature: string;
  readonly subject?: string;
  readonly attribute?: string;
  readonly value?: string;
  readonly text: string;
  /** 没有 = 老账没记原句。 */
  readonly quote?: string;
}

const factLine = (fact: FactRef): string =>
  `[${fact.id}] ${[fact.subject, fact.attribute, fact.value].filter(Boolean).join("｜") || "（事件）"} —— ${fact.text}${fact.quote ? `（原句：「${fact.quote}」）` : ""}`;

export function factsTask(canon: string, chapter: number, edits: readonly SettleEdit[], facts: readonly FactRef[], loose: readonly FactRef[] = []): string {
  return [
    `作者定下了一条定论：「${canon}」。第 ${chapter} 章为此改了这几句：`,
    ...edits.map((edit) => `- 原句「${edit.from}」→ 改成「${edit.to}」`),
    ...(facts.length > 0
      ? [
        "账里这几条事实引用了改掉的句子：",
        ...facts.map(factLine),
        "这几条每条回一个 action：keep（改后的句子还是这么说，给新原句 quote）、update（改后说法变了：给新的 value（事件不用）、新的说明 text、新原句 quote；text 照原来那条的口气直接写现在是什么样，别写「改后」「而非」「原来是」这类改动经过）、drop（改后这条不成立了）。",
      ]
      : []),
    ...(loose.length > 0
      ? [
        "账里这几条没记原句，看改了以后还对不对（多半不受影响）：",
        ...loose.map(factLine),
        "这几条：不受影响的回 keep（不用给 quote）；说法变了的回 update（同上，要给 quote）；不成立了的回 drop。",
      ]
      : []),
    "quote 必须逐字抄改后的正文里的一段（至少 4 个字）。",
    `只输出一个 JSON：{"facts":[{"id":"${facts[0]?.id ?? loose[0]?.id ?? "F1"}","action":"update","value":"","text":"","quote":""}]}`,
  ].join("\n");
}

export function reviewTask(canon: string, edits: readonly (Omit<SettleEdit, "key"> & { readonly before?: string; readonly after?: string })[]): string {
  return [
    `作者定下了一条定论（全书以它为准）：「${canon}」`,
    "另一个人逐句查了全书，说下面这几句和定论对不上、要改。请逐条复核：原句是不是真的和定论说不到一块。",
    "- 先看原句（连同前后文）说的是不是定论里的同一个人、同一件东西：名字不一样、只是身份相近或同一类东西的，不算；",
    "- 原句写的就是这件事、而且写得和定论不一样：算；",
    "- 要靠推算才对不上的：推算的每一步都站得住才算；推得出、也说得通的不算；",
    "- 人物在撒谎或记错、写的是变化过程的：不算；",
    "- 定论说的是平常带着什么、放在哪这类事，原句只是那一场里一时的拿法、放法、顺手抄起的别的东西、换了别人拿着的：不算；",
    "- 改法添了原句没有的情节、台词的：不算。",
    "",
    ...edits.map((edit, index) => `[${index + 1}] 第 ${edit.chapter} 章：「${edit.from}」→「${edit.to}」${edit.before || edit.after ? `（前后文：${edit.before ?? ""}【原句】${edit.after ?? ""}）` : ""}${edit.why ? `（他的理由：${edit.why}）` : ""}`),
    "",
    '每条都要给。只输出一个 JSON：{"verdicts":[{"id":1,"conflict":true}]}',
  ].join("\n");
}

/** 复核结果：conflict 明说 false 的那几条（下标）去掉；没给的留着（作者在卡上还会一句句看）。格式不对抛错。 */
export function parseReview(text: string, count: number): ReadonlySet<number> {
  const parsed = parseJsonObject(text);
  if (!parsed || !Array.isArray(parsed.verdicts)) throw new Error("模型回的不是要的格式");
  const drop = new Set<number>();
  for (const raw of parsed.verdicts) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    const id = int(record.id);
    if (id === undefined || id > count) continue;
    if (record.conflict === false || str(record.conflict).toLowerCase() === "false") drop.add(id - 1);
  }
  return drop;
}

/** 原句落在哪个编号句子里（原句是半句、或横跨两句里的一句都认）。 */
function unitOfQuote(doc: SweepDoc | undefined, quote: string): TextUnit | undefined {
  return doc?.units.find((item) => quoteInText(quote, item.text) || quoteInText(item.text, quote));
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
    const fitted = proposed ? prepareUnitReplacement(doc.units, unit.id, proposed) : undefined;
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
    const to = field ? stripFieldEcho(str(record.to), field) : "";
    if (!field || !to || to === field.value || out.some((item) => item.card === field.card && item.label === field.label)) continue;
    out.push({ ...(field.card ? { card: field.card } : {}), label: field.label, from: field.value, to });
  }
  return out;
}

export function parseFactChanges(text: string, chapter: number, facts: readonly FactRef[], nextText: string, loose: readonly FactRef[] = []): SettleFactChange[] {
  const parsed = parseJsonObject(text);
  if (!parsed || !Array.isArray(parsed.facts)) throw new Error("模型回的不是要的格式");
  const replies = parsed.facts;
  const replyOf = (id: string) => replies.find((item) => item && typeof item === "object" && str((item as Record<string, unknown>).id) === id) as Record<string, unknown> | undefined;
  const out: SettleFactChange[] = [];
  // 老账没记原句的：没回、回 keep 就不动；回 update 但新原句核不上、回 drop 的作废（说法已经不对了）。
  for (const fact of loose) {
    const raw = replyOf(fact.id);
    const action = str(raw?.action).toLowerCase();
    if (action !== "update" && action !== "drop") continue;
    const quote = str(raw?.quote);
    const value = str(raw?.value);
    const textAfter = str(raw?.text) || fact.text;
    const base = { chapter, factId: fact.factId, before: fact.text, loose: true as const };
    if (action === "drop" || !quote || !quoteInText(quote, nextText) || (fact.nature !== "event" && !value)) {
      out.push(base);
      continue;
    }
    out.push({ ...base, after: textAfter, patch: { ...(fact.nature !== "event" ? { value } : {}), text: textAfter, quote } });
  }
  for (const fact of facts) {
    const raw = replyOf(fact.id);
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

async function askNames(callModel: BrainCallModel, prompt: string): Promise<{ canon?: string; names: string[]; keep: boolean; replaces?: number }> {
  const parsed = parseJsonObject(await callModel([{ role: "user", content: prompt }], { json: true }));
  if (!parsed) throw new Error("模型回的不是要的格式");
  const names = Array.isArray(parsed.names) ? parsed.names.map(str).filter(Boolean) : [];
  const canon = str(parsed.canon);
  // 只认明说的 false（布尔或字串）；没给、给别的都照记定论（老行为）。
  const keep = !(parsed.keep === false || (typeof parsed.keep === "string" && parsed.keep.trim().toLowerCase() === "false"));
  const replaces = Number(parsed.replaces);
  return { ...(canon ? { canon } : {}), names, keep, ...(Number.isInteger(replaces) && replaces > 0 ? { replaces } : {}) };
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

  // 还没定稿的那章查工作稿（作者眼前那份）；已定稿的章查定稿正文，工作稿里同一句跟着改——只改工作稿的话
  // 定稿正文还是原样，核别的章还会拿它报（回归书：核已定稿的第 3 章、点「以第 1 章为准」，只改了工作稿）。
  // 定稿后作者又改过工作稿、核账报的那句只在工作稿里有，才查工作稿。
  const docs = new Map<number, SweepDoc>();
  const committed: { chapter: number; textSha256: string; draftVersion?: string; draftText?: string }[] = [];
  const drafts: { chapter: number; baseVersion: string }[] = [];
  if (focusChapter !== undefined) {
    const raw = await readOptional(join(projectDir, draftPath(focusChapter)));
    if (raw !== undefined && raw.trim()) {
      const draftDoc = docOf(focusChapter, "draft", raw);
      const text = committedNumbers.includes(focusChapter) ? await readChapterText(projectDir, focusChapter) : undefined;
      const committedDoc = text === undefined ? undefined : docOf(focusChapter, "committed", text);
      const quotes = request.kind === "pick"
        ? [request.other, ...(request.also ?? [])].flatMap((side) => (side?.where === "chapter" && side.chapter === focusChapter ? [side.quote] : []))
        : [];
      if (!committedDoc || quotes.some((quote) => !unitOfQuote(committedDoc, quote) && unitOfQuote(draftDoc, quote))) {
        docs.set(focusChapter, draftDoc);
        drafts.push({ chapter: focusChapter, baseVersion: draftVersionOf(raw) });
      }
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
  let sceneOnly = false;
  let replaces: SettleProposal["replaces"];
  // 按已记下的定论查（核账卡「以定论为准」带的是核账员摘的那半句）：用设定本里那一整条，别再记一条半截的。
  const recorded = request.kind === "statement"
    ? cards.canon.find((item) => quoteInText(request.text, item.text) || quoteInText(item.text, request.text))
    : undefined;
  const statementText = request.kind === "statement" ? recorded?.text ?? request.text.trim() : "";
  try {
    if (request.kind === "pick") {
      const asked = await askNames(callModel, canonTask(request, docs, cards));
      if (!asked.canon) return { ok: false, message: "这次没写出定论（模型没回），重新点一次试试。" };
      canon = asked.canon.slice(0, 400);
      names = asked.names;
      sceneOnly = !asked.keep;
    } else {
      canon = statementText;
      // 新写的一条：问一句是不是在改设定本里已有的哪条（作者长篇实跑 2026-10-26：「那条定论过时了，改成…」
      // 记成了第二条，旧的还在，核账照旧拿旧的报）。
      const existing = recorded ? [] : cards.canon;
      const asked = await askNames(callModel, namesTask(canon, existing.map((item) => item.text)));
      names = asked.names;
      const old = asked.replaces === undefined ? undefined : existing[asked.replaces - 1];
      if (old) replaces = { id: old.id, text: old.text };
    }
  } catch (error) {
    if (request.kind === "pick") return { ok: false, message: `这次没写出定论（${error instanceof Error ? error.message : String(error)}），重新点一次试试。` };
    canon = statementText;
    failures.push("没问出这条定论涉及谁，这次全书都查了");
  }

  const terms = termsFor(names, cards);
  // 核账报过、作者点过的那几句（打架的另一边 + 同一条报的别几句）：章一定查，改法不复核，查不出如实说。
  const flagged: ChapterSide[] = request.kind === "pick"
    ? [request.other, ...(request.also ?? [])].flatMap((side) => (side?.where === "chapter" ? [side] : []))
    : [];
  const pinned = new Set<number>([
    ...(focusChapter !== undefined ? [focusChapter] : []),
    ...(request.kind === "pick" ? [request.truth, ...flagged].flatMap((side) => (side.where === "chapter" ? [side.chapter] : [])) : []),
  ]);
  const picked = [...docs.values()]
    .filter((doc) => terms.length === 0 || pinned.has(doc.chapter) || terms.some((term) => doc.text.includes(term)))
    .sort((a, b) => a.chapter - b.chapter);

  const batches = batchesOf(picked);
  const fields = fieldRefs(cards, terms);
  const [batchResults, fieldResult] = await Promise.all([
    Promise.allSettled(batches.map(async (batch) => parseSweepEdits(await callModel([{ role: "user", content: sweepTask(canon, batch, flagged) }], { json: true }), batch))),
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
  const flaggedUnits = flagged.map((side) => ({ side, unit: unitOfQuote(docs.get(side.chapter), side.quote) }));
  const hasEdit = (side: ChapterSide, unit: TextUnit): boolean => found.some((edit) => edit.chapter === side.chapter && edit.id === unit.id);
  // 核账报过、作者点过的那句是这次要定的事本身：整批查时漏了，只拿那几章单问一次（批里几万字，模型偶尔漏点名的句子）。
  const unanswered = flaggedUnits.flatMap(({ side, unit }) => (unit && !hasEdit(side, unit) ? [{ side, unit }] : []));
  const asked = new Set(batches.flatMap((batch, index) => (batchResults[index]!.status === "fulfilled" ? batch.map((doc) => doc.chapter) : [])));
  const retry = unanswered.filter(({ side }) => asked.has(side.chapter));
  if (retry.length > 0) {
    const focus = [...new Set(retry.map(({ side }) => side.chapter))].sort((a, b) => a - b).map((chapter) => docs.get(chapter)!);
    try {
      const again = parseSweepEdits(await callModel([{ role: "user", content: sweepTask(canon, focus, retry.map(({ side }) => side)) }], { json: true }), focus);
      found.push(...again.filter((edit) => retry.some(({ side, unit }) => edit.chapter === side.chapter && edit.id === unit.id)));
    } catch {
      // 补问没成：下面照实列进「没查出改法」。
    }
  }
  // 核账报过的那几句（作者认了它们打架）不复核；别的再问一遍，推算站不住的去掉。
  const clicked = (edit: Omit<SettleEdit, "key">): boolean =>
    flaggedUnits.some(({ side, unit }) => unit !== undefined && edit.chapter === side.chapter && edit.id === unit.id);
  const toReview = found.filter((edit) => !clicked(edit));
  let kept = found;
  const reviewDropped: SettleProposal["reviewDropped"][number][] = [];
  if (toReview.length > 0) {
    try {
      const withContext = toReview.map((edit) => {
        const units = docs.get(edit.chapter)?.units ?? [];
        return { ...edit, before: units[edit.id - 2]?.text ?? "", after: units[edit.id]?.text ?? "" };
      });
      const drop = parseReview(await callModel([{ role: "user", content: reviewTask(canon, withContext) }], { json: true }), toReview.length);
      kept = found.filter((edit) => clicked(edit) || !drop.has(toReview.indexOf(edit)));
      reviewDropped.push(...toReview.filter((_, index) => drop.has(index)).map(({ chapter, from, to, why }) => ({ chapter, from, to, ...(why ? { why } : {}) })));
    } catch (error) {
      failures.push(`复核没做成（${error instanceof Error ? error.message : String(error)}），下面几处请一句句看过再确认`);
    }
  }
  const edits: SettleEdit[] = kept
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
    const loose: FactRef[] = [];
    for (const entry of ledger?.entries ?? []) {
      if (entry.kind !== "fact") continue;
      const ref = {
        factId: entry.id,
        nature: entry.nature,
        ...(entry.subject ? { subject: entry.subject } : {}),
        ...(entry.attribute ? { attribute: entry.attribute } : {}),
        ...(entry.value ? { value: entry.value } : {}),
        text: entry.text,
      };
      if (!entry.quote) {
        loose.push({ id: `L${loose.length + 1}`, ...ref });
        continue;
      }
      if (!quoteInText(entry.quote, doc.text) || quoteInText(entry.quote, applied.text)) continue;
      affected.push({ id: `F${affected.length + 1}`, ...ref, quote: entry.quote });
    }
    if (affected.length === 0 && loose.length === 0) return;
    try {
      const reply = await callModel([{ role: "user", content: factsTask(canon, chapter, mine, affected, loose) }], { json: true });
      facts.push(...parseFactChanges(reply, chapter, affected, applied.text, loose));
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      if (affected.length > 0) {
        failures.push(`第 ${chapter} 章账里跟着改的那几条没问成（${why}），确认后这几条会作废`);
        facts.push(...affected.map((fact) => ({ chapter, factId: fact.factId, before: fact.text })));
      } else {
        failures.push(`第 ${chapter} 章账里没记原句的那几条没问成（${why}），确认后不动，可能有跟改后正文对不上的`);
      }
    }
  }));

  // 已定稿章另有工作稿的：同一句在工作稿里一字不差、只出现一次才跟着改。
  const committedOut = committed.map(({ chapter, textSha256, draftVersion, draftText }) => {
    if (!draftVersion || !draftText) return { chapter, textSha256 };
    const units = splitUnits(draftText);
    const carried = edits.filter((edit) => edit.chapter === chapter && units.filter((unit) => unit.text === edit.from).length === 1);
    return carried.length > 0 ? { chapter, textSha256, draftVersion } : { chapter, textSha256 };
  });

  const missed = flaggedUnits
    .filter(({ side, unit }) => !(unit !== undefined && edits.some((edit) => edit.chapter === side.chapter && edit.id === unit.id)))
    .map(({ side }) => ({ chapter: side.chapter, quote: side.quote }));

  return {
    ok: true,
    proposal: {
      canon,
      canonExists: cards.canon.some((item) => nameKey(item.text) === nameKey(canon)),
      ...(sceneOnly ? { sceneOnly } : {}),
      ...(replaces ? { replaces } : {}),
      ...(focusChapter !== undefined ? { chapter: focusChapter } : {}),
      edits,
      facts: facts.sort((a, b) => a.chapter - b.chapter),
      fields: fieldEdits,
      committed: committedOut.filter((item) => edits.some((edit) => edit.target === "committed" && edit.chapter === item.chapter)),
      drafts: drafts.filter((item) => edits.some((edit) => edit.target === "draft" && edit.chapter === item.chapter)),
      searched: picked.map((doc) => doc.chapter),
      missed,
      reviewDropped,
      failures,
    },
  };
}
