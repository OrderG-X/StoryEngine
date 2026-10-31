/**
 * 章节账单（真相之二）：每章一份，定稿时写入 `ledger/chapters/NNNN.json`。格式 `chapter-ledger/2`（写作版本 P2b，
 * 契约 docs/rebuild/contracts/账单v2-草案.md）；v1 只在迁移器（`ledger/migrate-v1.ts`）里出现，运行期读到 v1 一律失败。
 *
 * 一章引起的全部变化都在这里：本章梗概、事实、线索（开 / 推进 / 收）、时间、出场人物（含称呼）。
 * 事实账本、线索池、时间线、人物现状……全是从这些账单算出来的投影，不另存。
 *
 * 两种样子：
 *  - 交给定稿命令的样子（Input）：记账员、作者清单上的一条声明，平铺、附原句，没有编号；
 *  - 账单里存的样子（Entry）：核心分配编号、按冻结正文算出证据（哪一版正文、第几句），带来源、变更、出处这些格子。
 *
 * 时间（写作版本 P3a，设计 docs/rebuild/写作版本-P3-设计.md 第 2 节）：P3 起新记的账带 `timeModel: 2`——
 * 本章开头相对前一个当下章结尾（可负、可区间、可按两种换天规矩各记一份）、整章同一天、章里各次换天（带新一天开头那句）、
 * 不在当下线上的段（回忆 / 梦这类，句子范围 + 段的时间）。没有 `timeModel` 的是旧账（P2b 及更早、迁来的、老书导入的），
 * 格子照 P2b 的老规矩，投影只拿它「推定」。
 * 读的一方经这里的几个小函数取（entryQuote、subjectOf、presenceName、threadOf），不各写各的。
 * 条目编号只在系统内部用，绝不直接给作者看。
 */
import { z } from "zod";

export const CHAPTER_LEDGER_SCHEMA = "chapter-ledger/2" as const;
/** 证据里的句子编号按哪一版切句算（`text/units.ts`）。切法改了就加一。 */
export const UNITS_VERSION = 1 as const;
/** P3 起新记的账的时间格式（设计 2.1）：带它的账才算「已识别」，没带的是旧账、只推定。 */
export const TIME_MODEL = 2 as const;
export type TimeModel = typeof TIME_MODEL;

const text = z.string().trim().min(1);
const id = text;
const chapterNo = z.number().int().min(1);
const sha = z.string().regex(/^[0-9a-f]{64}$/u);

/** 这条是作者在定稿清单上亲眼看过点头的（author），还是自动记下、可撤销的（auto）。不是意思对的证明。 */
export const ReviewMark = z.enum(["author", "auto"]);
export type ReviewMark = z.infer<typeof ReviewMark>;

/**
 * 事实。hard = 不会变的（年龄、门牌、写着的字）；state = 会变的状态（在哪、在谁手里、开着还是锁着）；
 * event = 发生过的事。hard / state 必须写清「谁 · 哪方面 · 是什么」，投影靠它做确定性比对。
 */
export const FactNature = z.enum(["hard", "state", "event"]);
export type FactNature = z.infer<typeof FactNature>;

/** 线索类型：question = 悬念 / 待解的问题；intent = 人物的打算、待办；goal = 主角的目标。 */
export const ThreadType = z.enum(["question", "intent", "goal"]);
export type ThreadType = z.infer<typeof ThreadType>;

export const ThreadOp = z.enum(["open", "advance", "close"]);
export type ThreadOp = z.infer<typeof ThreadOp>;

/**
 * 时间依据：text = 正文明写；judged = 记账员读前后文判断（附本章开头那句）；
 * author = 作者定的；estimated = 代码按上一章 +1 估的（一律请作者确认）。
 */
export const TimeBasis = z.enum(["text", "judged", "author", "estimated"]);
export type TimeBasis = z.infer<typeof TimeBasis>;

/** 相对多少的单位。月、年只为正文明写的说法存，不折成天（没有作者定的历法就不换算，设计 2.2）。 */
export const TimeUnit = z.enum(["day", "month", "year"]);
export type TimeUnit = z.infer<typeof TimeUnit>;
const timeBound = z.number().int().min(-36500).max(36500);
/** 相对多少：单位 + 两头（至少一头；缺一头 = 那头不知道）。负 = 往前（多线往回接、倒叙）。「至少三年前」= `{ year, max: -3 }`。 */
export const TimeOffset = z
  .object({ unit: TimeUnit, min: timeBound.optional(), max: timeBound.optional() })
  .refine((offset) => offset.min !== undefined || offset.max !== undefined, "相对多少至少要有一头")
  .refine((offset) => offset.min === undefined || offset.max === undefined || offset.min <= offset.max, "相对多少的两头倒了");
export type TimeOffset = z.infer<typeof TimeOffset>;
/** 要看换天规矩才定的相对天数：过了半夜就算第二天（midnight）/ 天亮才算第二天（dawn），各记一份（只用天）。 */
export const BoundaryOffsets = z.object({ midnight: TimeOffset, dawn: TimeOffset });
export type BoundaryOffsets = z.infer<typeof BoundaryOffsets>;
/** 换天规矩：缺 = 作者没定，两种都推（设计 2.4）。 */
export const DayBoundary = z.enum(["midnight", "dawn"]);
export type DayBoundary = z.infer<typeof DayBoundary>;
/** 段：past = 回忆、倒叙（当时真发生过）；other = 梦、想象、传闻、故事里讲的故事（不上时间线）。 */
export const SceneFrame = z.enum(["past", "other"]);
export type SceneFrame = z.infer<typeof SceneFrame>;

export const EntryKind = z.enum(["summary", "fact", "thread", "time", "presence"]);
export type EntryKind = z.infer<typeof EntryKind>;

/** 正文里第几句到第几句（含两头，`text/units.ts` 的编号）。 */
export const UnitRange = z.object({ from: z.number().int().min(1), to: z.number().int().min(1) }).refine((range) => range.from <= range.to, "句子范围倒了");
export type UnitRange = z.infer<typeof UnitRange>;

// —— 交给「定稿」命令的条目（记账员、定稿清单的声明） ——

const declared = { review: ReviewMark };
/** 记账员标的来源：叙述（正文直接写的）/ 某个人物说的（带正文里对他的称呼；明说是人物说的、没写是谁的，照人物说的记、说话人空着）。拿不准不标。 */
export const DeclaredSource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("narration") }),
  z.object({ kind: z.literal("character_claim"), speaker: text.optional() }),
]);
export type DeclaredSource = z.infer<typeof DeclaredSource>;

export const SummaryInput = z.object({ kind: z.literal("summary"), ...declared, text, quote: text });
export const FactInput = z.object({
  kind: z.literal("fact"),
  ...declared,
  nature: FactNature,
  /** 谁 / 什么。hard 和 state 必填；event 可以没有。 */
  subject: text.optional(),
  attribute: text.optional(),
  value: text.optional(),
  /** 给人看的一句话。 */
  text,
  quote: text,
  /** 本章明写推翻了前文哪些事实（那几条的 id）。不会变的事实只能这样作废。 */
  replaces: z.array(id).min(1).optional(),
  source: DeclaredSource.optional(),
});
/** 新开的线索可以带上本章上次定稿时的编号（重定稿时沿用，后文的推进才接得上）；推进、收口必须带。 */
export const ThreadInput = z.object({
  kind: z.literal("thread"),
  ...declared,
  op: ThreadOp,
  /** open 必填。 */
  type: ThreadType.optional(),
  /** open 必填：线索叫什么。 */
  title: text.optional(),
  /** 本章对这条线索做了什么。 */
  note: text,
  quote: text,
  thread: id.optional(),
  source: DeclaredSource.optional(),
});
/** 一处相对：offset、byBoundary 二选一。 */
const relative = { offset: TimeOffset.optional(), byBoundary: BoundaryOffsets.optional() };
/** 本章开头离前一个当下章结尾多久，附说明它的那句。 */
export const TimeStartInput = z.object({ ...relative, basis: z.enum(["text", "judged"]), quote: text });
/** 章里换了一天：离本章上一个当下时刻多久（≥ 1 天，或按换天规矩各一份），附新的一天开头那句。 */
export const DayChangeInput = z.object({ ...relative, quote: text.optional() });
/**
 * 不在当下线上的一段：首句、末句原句（代码对回句子编号；补摘那步点了编号的直接给 units）。
 * when：这段是什么时候（past 才有）——折成相对本章开头（整章是一段时相对前一个当下章结尾）；判断不了写 unknown。
 */
export const SegmentInput = z.object({
  frame: SceneFrame,
  firstQuote: text,
  lastQuote: text,
  units: UnitRange.optional(),
  when: z.union([z.object(relative), z.literal("unknown")]).optional(),
});
/**
 * 记账员记的本章时间（设计第 4 节）。start 缺 = 整章是一个段（segments 盖住全章）；start = unknown = 在当下线上、说不出隔多久。
 * sameDay = 整章同一天；跨天就逐次列 dayChanges。两样都没有 = 章末不知道（不当同一天）。
 */
export const TimeInput = z.object({
  kind: z.literal("time"),
  ...declared,
  start: z.union([TimeStartInput, z.literal("unknown")]).optional(),
  sameDay: z.boolean().optional(),
  dayChanges: z.array(DayChangeInput).optional(),
  segments: z.array(SegmentInput).optional(),
  /** 正文明写的星期：0 = 周一 … 6 = 周日。 */
  weekday: z.number().int().min(0).max(6).optional(),
  /** 正文里的时段说法，原样。 */
  timeOfDay: text.optional(),
});
/** 作者定的天数（定稿清单上改的）：本章开头是第几天；作者明确给了结尾才有 dayEnd（= day 就是明确同一天）。和记账员记的并存（设计 2.5）。 */
export const DayInput = z.object({
  kind: z.literal("day"),
  ...declared,
  day: z.number().int().min(1),
  dayEnd: z.number().int().min(1).optional(),
});
/** 出场人物：name = 这个人的已确立名字；nameUsed = 本章正文里怎么称呼他（不同就是别名）。 */
export const PresenceInput = z.object({
  kind: z.literal("presence"),
  ...declared,
  name: text,
  nameUsed: text,
  /** 本章主要跟着这个人的眼睛走。 */
  viewpoint: z.boolean().optional(),
  /** nameUsed 是换个场景就指别人的代称（「那人」「老头」）：只认本章这一处，不记成这个人的别名。 */
  generic: z.boolean().optional(),
  quote: text,
});
export const EntryInput = z.discriminatedUnion("kind", [SummaryInput, FactInput, ThreadInput, TimeInput, DayInput, PresenceInput]);

export type SummaryInput = z.infer<typeof SummaryInput>;
export type FactInput = z.infer<typeof FactInput>;
export type ThreadInput = z.infer<typeof ThreadInput>;
export type TimeInput = z.infer<typeof TimeInput>;
export type DayInput = z.infer<typeof DayInput>;
export type SegmentInput = z.infer<typeof SegmentInput>;
export type DayChangeInput = z.infer<typeof DayChangeInput>;
export type PresenceInput = z.infer<typeof PresenceInput>;
export type EntryInput = z.infer<typeof EntryInput>;

/**
 * 这条声明要核的原句（每一句都得在正文里；undefined = 该附没附）。时间：开头那句、各次换天附了的那句、各段的首末句；
 * 作者定的天数不附。
 */
export function declaredQuotes(entry: EntryInput): readonly (string | undefined)[] {
  switch (entry.kind) {
    case "time":
      return [
        ...(entry.start && entry.start !== "unknown" ? [entry.start.quote] : []),
        ...(entry.dayChanges ?? []).flatMap((change) => (change.quote !== undefined ? [change.quote] : [])),
        ...(entry.segments ?? []).flatMap((segment) => [segment.firstQuote, segment.lastQuote]),
      ];
    case "day":
      return [];
    default:
      return [entry.quote];
  }
}

/** 一处相对（offset / byBoundary）的问题：二选一；按换天规矩各记的只用天。 */
function relativeProblem(value: { readonly offset?: TimeOffset; readonly byBoundary?: BoundaryOffsets }): string | undefined {
  if ((value.offset === undefined) === (value.byBoundary === undefined)) return "相对多少要写一份：要么直接写，要么按两种换天规矩各写一份";
  if (value.byBoundary && (value.byBoundary.midnight.unit !== "day" || value.byBoundary.dawn.unit !== "day")) return "按换天规矩各写一份的只能是天数";
  return undefined;
}

/** 换天的问题：至少过了一天（按换天规矩各写的，两份都不能往回、也不能两份都没换）。 */
function dayChangeProblem(value: { readonly offset?: TimeOffset; readonly byBoundary?: BoundaryOffsets }): string | undefined {
  const relative = relativeProblem(value);
  if (relative) return relative;
  if (value.offset) return value.offset.unit === "day" && value.offset.min !== undefined && value.offset.min >= 1 ? undefined : "换天至少过了一天";
  const { midnight, dawn } = value.byBoundary as BoundaryOffsets;
  if (midnight.min === undefined || dawn.min === undefined || midnight.min < 0 || dawn.min < 0) return "换天不能往回";
  if (midnight.max === 0 && dawn.max === 0) return "两种换天规矩下都没换天，就不是换天";
  return undefined;
}

/** 一条声明的结构问题（字段缺了、自相矛盾）。原句核对不在这里，见 `checkEntries`。 */
export function entryShapeProblem(entry: EntryInput): string | undefined {
  switch (entry.kind) {
    case "fact":
      if (entry.nature !== "event" && (!entry.subject || !entry.attribute || !entry.value)) return "不会变的事实和状态必须写清谁、哪方面、是什么";
      return undefined;
    case "thread":
      if (entry.op === "open" && (!entry.type || !entry.title)) return "新开的线索必须有类型和标题";
      if (entry.op !== "open" && !entry.thread) return "推进或收口必须指明是哪条线索";
      return undefined;
    case "time":
      return timeInputProblem(entry);
    case "day":
      return entry.dayEnd !== undefined && entry.dayEnd < entry.day ? "结尾那天不能比开头早" : undefined;
    default:
      return undefined;
  }
}

function timeInputProblem(entry: TimeInput): string | undefined {
  const segments = entry.segments ?? [];
  const changes = entry.dayChanges ?? [];
  if (entry.start === undefined) {
    if (segments.length === 0) return "没写本章开头，就要写清整章是哪一段";
    if (entry.sameDay !== undefined || changes.length > 0 || entry.weekday !== undefined || entry.timeOfDay !== undefined) return "整章是一段时不写当下的开头、结尾";
  } else if (entry.start !== "unknown") {
    const problem = relativeProblem(entry.start);
    if (problem) return problem;
  }
  if (entry.sameDay === true && changes.length > 0) return "整章同一天就不该有换天";
  for (const change of changes) {
    const problem = dayChangeProblem(change);
    if (problem) return problem;
  }
  for (const segment of segments) {
    if (segment.when === undefined || segment.when === "unknown") continue;
    if (segment.frame === "other") return "梦、想象、传闻这类段不上时间线，不写时间";
    const problem = relativeProblem(segment.when);
    if (problem) return problem;
  }
  return undefined;
}

// —— 账单里存的条目 ——

/** 指一个人 / 一样东西：P2b 照旧只按名字认（只有 mention）；id 只在作者确认或设定卡里明确时有（P3）。 */
export const EntityRef = z.object({ id: id.optional(), mention: text });
export type EntityRef = z.infer<typeof EntityRef>;

/**
 * 这条是谁说的：叙述、人物说的（带说话人）、作者裁定，或不知道。旧账一律 unknown；P3 起记账员给事实、线索标叙述 / 人物说的，
 * 拿不准的照旧 unknown；作者定的天数是 author_ruling。投影按它和所在段限权（设计第 3 节）。
 */
export const EntrySource = z.object({
  kind: z.enum(["narration", "character_claim", "author_ruling", "unknown"]),
  speaker: EntityRef.optional(),
  decision: id.optional(),
});
export type EntrySource = z.infer<typeof EntrySource>;

export const EvidenceResource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("chapter"), chapter: chapterNo }),
  z.object({ kind: z.literal("card"), card: id }),
  z.object({ kind: z.literal("ruling"), decision: id }),
]);

/** 一段证据：出处、那一版原样的哈希、句子编号（定位得了才有）、原句（代码从那一版原文取的）。 */
export const Evidence = z.object({
  resource: EvidenceResource,
  revision: sha,
  units: UnitRange.optional(),
  quote: text,
});
export type Evidence = z.infer<typeof Evidence>;

/**
 * located = 原句在那一版正文里只有一处，句号核得上；quoted = 原句在正文里但不止一处，不任选一句、不给句号；
 * unlocated_legacy = 迁移来的、正文里找不到；stale = 迁移来的、定稿后正文改过；none = 不带原句（作者定的、估的时间，老书导入的）。
 */
export const EvidenceStatus = z.enum(["located", "quoted", "unlocated_legacy", "stale", "none"]);
export type EvidenceStatus = z.infer<typeof EvidenceStatus>;

/** 这条和前文的关系：明写推翻了谁（change，带 replaces），还是不知道。continuation 留给 P3。 */
export const Transition = z.enum(["change", "continuation", "unknown"]);
export type Transition = z.infer<typeof Transition>;

/** native = 照这个格式记的；migrated = 从旧格式搬来的（旧账、老书导入）。 */
export const Provenance = z.enum(["native", "migrated"]);
export type Provenance = z.infer<typeof Provenance>;

/** 叙述范围（P3）：缺 = 不知道。 */
export const EntryScope = z.object({ sceneRefs: z.array(id).optional() });

const common = {
  id,
  review: ReviewMark,
  source: EntrySource,
  transition: Transition,
  scope: EntryScope.optional(),
  evidence: z.array(Evidence),
  evidenceStatus: EvidenceStatus,
  provenance: Provenance,
};

export const SummaryEntry = z.object({ kind: z.literal("summary"), ...common, text });
export const FactEntry = z.object({
  kind: z.literal("fact"),
  ...common,
  nature: FactNature,
  subjectRef: EntityRef.optional(),
  predicate: text.optional(),
  value: text.optional(),
  objectRefs: z.array(EntityRef).optional(),
  text,
  /** 开放集合（「篮子里有……」没列全 ≠ 没有别的），P3。 */
  setScope: z.enum(["open", "closed", "unknown"]).optional(),
  replaces: z.array(id).min(1).optional(),
});
export const ThreadEntry = z.object({
  kind: z.literal("thread"),
  ...common,
  op: ThreadOp,
  threadRef: z.object({ id }),
  type: ThreadType.optional(),
  title: text.optional(),
  note: text,
});

/** 时间关系：at = 就在那一天（作者定的）；offset = 离锚点多久；unknown = 记了时间、说不出是哪天。before / after / overlaps 不用。 */
export const TimeRelation = z.enum(["at", "before", "after", "offset", "overlaps", "unknown"]);
/** 这条说的是：本章开头、本章结尾、章里一次换天、一个段（由段的 timeRefs 指过来）。 */
export const TimeAppliesTo = z.enum(["chapterStart", "chapterEnd", "dayChange", "scene"]);
/** 相对谁：前一个当下章的结尾、本章开头、本章里上一个当下时刻（换天用）。 */
export const TimeAnchor = z.enum(["previousChapterEnd", "chapterStart", "previousMoment"]);
/**
 * 老书导入、盘点时判成不可信的天数（设计 2.6）：条目改成 unknown，原来的值和依据留在这里，只给作者看「约第 N 天」，不当锚、不进链。
 * estimated = 老书里估的；earlier = 不是作者定的、却比上一章早；after_bad = 紧跟在不可信的天数后面、差值是相对它算的；
 * not_author = 导入时记成作者定的、老文件里不是；unproven = 导入时记成作者定的、老文件不在了证明不了（待作者确认）。
 */
export const LegacyTime = z.object({
  relation: TimeRelation,
  day: z.number().int().optional(),
  offset: TimeOffset.optional(),
  basis: TimeBasis,
  reason: z.enum(["estimated", "earlier", "after_bad", "not_author", "unproven"]),
});
export type LegacyTime = z.infer<typeof LegacyTime>;

export const TimeEntry = z.object({
  kind: z.literal("time"),
  ...common,
  relation: TimeRelation,
  appliesTo: TimeAppliesTo,
  anchor: TimeAnchor.optional(),
  offset: TimeOffset.optional(),
  byBoundary: BoundaryOffsets.optional(),
  /** 作者定的故事第几天（relation = at）。 */
  day: z.number().int().min(1).optional(),
  calendarId: id.optional(),
  /** 正文明写的星期：0 = 周一 … 6 = 周日。 */
  weekday: z.number().int().min(0).max(6).optional(),
  timeOfDay: text.optional(),
  basis: TimeBasis,
  legacy: LegacyTime.optional(),
});
export const PresenceEntry = z.object({
  kind: z.literal("presence"),
  ...common,
  entityRef: EntityRef,
  nameUsed: text,
  viewpoint: z.boolean().optional(),
  generic: z.boolean().optional(),
});
export const LedgerEntry = z.discriminatedUnion("kind", [SummaryEntry, FactEntry, ThreadEntry, TimeEntry, PresenceEntry]);

export type SummaryEntry = z.infer<typeof SummaryEntry>;
export type FactEntry = z.infer<typeof FactEntry>;
export type ThreadEntry = z.infer<typeof ThreadEntry>;
export type TimeEntry = z.infer<typeof TimeEntry>;
export type PresenceEntry = z.infer<typeof PresenceEntry>;
export type LedgerEntry = z.infer<typeof LedgerEntry>;

// —— 读条目的几个小函数（读的一方都经这里，不各写各的） ——

/** 这条的原句（第一段证据的）；没有证据 = undefined。 */
export const entryQuote = (entry: LedgerEntry): string | undefined => entry.evidence[0]?.quote;
/** 事实说的是谁 / 什么（名字原样）。 */
export const subjectOf = (entry: FactEntry): string | undefined => entry.subjectRef?.mention;
/** 出场的是谁（已确立的名字原样）。 */
export const presenceName = (entry: PresenceEntry): string => entry.entityRef.mention;
/** 线索动作指的是哪条线索。 */
export const threadOf = (entry: ThreadEntry): string => entry.threadRef.id;

/** 一条存着的条目的结构问题（和 entryShapeProblem 同一套规矩，加上时间关系的格子）。timeModel = 账单的时间格式（缺 = 旧账）。 */
export function storedShapeProblem(entry: LedgerEntry, timeModel?: TimeModel): string | undefined {
  const source = sourceProblem(entry, timeModel);
  if (source) return source;
  switch (entry.kind) {
    case "fact":
      if (entry.nature !== "event" && (!entry.subjectRef || !entry.predicate || !entry.value)) return "不会变的事实和状态必须写清谁、哪方面、是什么";
      if ((entry.transition === "change") !== (entry.replaces !== undefined)) return "明写推翻前文的才是 change，且要写清推翻哪几条";
      return undefined;
    case "thread":
      if (entry.op === "open" && (!entry.type || !entry.title)) return "新开的线索必须有类型和标题";
      return entry.transition === "unknown" ? undefined : "线索动作的变更关系只记 unknown";
    case "time":
      if (entry.transition !== "unknown") return "时间的变更关系只记 unknown";
      if (entry.calendarId !== undefined) return "历法还不用";
      if (entry.legacy && entry.relation !== "unknown") return "判成不可信的老天数只能记成不知道";
      return timeModel === TIME_MODEL ? nativeTimeProblem(entry) : legacyTimeProblem(entry);
    default:
      return entry.transition === "unknown" ? undefined : "这类条目的变更关系只记 unknown";
  }
}

/** 来源：旧账一律 unknown；人物说的要有说话人、只用在事实和线索；作者裁定只用在作者定的天数。 */
function sourceProblem(entry: LedgerEntry, timeModel: TimeModel | undefined): string | undefined {
  const { kind } = entry.source;
  if (kind === "unknown") return undefined;
  if (timeModel !== TIME_MODEL) return "旧账的来源只记 unknown";
  if (kind === "character_claim") return entry.kind === "fact" || entry.kind === "thread" ? undefined : "人物说的只用在事实、线索上";
  if (kind === "author_ruling") return entry.kind === "time" && entry.basis === "author" ? undefined : "作者裁定只用在作者定的天数上";
  return entry.kind === "time" ? "时间不标叙述来源" : undefined;
}

/** 旧账的时间：P2b 的老规矩（作者定第几天、离上一章几天、本章内过几天），外加盘点改成 unknown 的。 */
function legacyTimeProblem(entry: TimeEntry): string | undefined {
  if (entry.byBoundary) return "旧账不按换天规矩分记";
  if (entry.offset && (entry.offset.unit !== "day" || entry.offset.min === undefined || entry.offset.min !== entry.offset.max || entry.offset.min < 0)) return "旧账的相对天数只能是一个确定的、不小于 0 的数";
  switch (entry.relation) {
    case "at":
      if (entry.appliesTo !== "chapterStart" || entry.day === undefined || entry.basis !== "author") return "只有作者能直接定故事第几天（本章开头）";
      return entry.anchor || entry.offset ? "定了第几天就不再写相对谁" : undefined;
    case "offset":
      if (!entry.anchor || !entry.offset || entry.day !== undefined) return "相对天数要写清相对谁、隔几天";
      if (entry.appliesTo === "chapterStart" && entry.anchor !== "previousChapterEnd") return "本章开头只相对上一章结尾";
      if (entry.appliesTo === "chapterEnd" && entry.anchor !== "chapterStart") return "本章结尾只相对本章开头";
      return entry.appliesTo === "chapterStart" || entry.appliesTo === "chapterEnd" ? undefined : "旧账没有换天、段的时间";
    case "unknown":
      if (entry.appliesTo !== "chapterStart" || entry.anchor || entry.offset || entry.day !== undefined) return "说不出哪天的时间只记在本章开头、不带天数";
      return undefined;
    default:
      return "这种时间关系不用";
  }
}

/** P3 起新记的时间（设计 2.2）。一章里各条之间的关系（几条、谁要谁）在整份账单校验里核。 */
function nativeTimeProblem(entry: TimeEntry): string | undefined {
  const marks = entry.weekday !== undefined || entry.timeOfDay !== undefined;
  if (marks && entry.appliesTo !== "chapterStart") return "星期、时段只记在本章开头";
  switch (entry.relation) {
    case "at":
      if (entry.basis !== "author" || entry.day === undefined) return "只有作者能直接定故事第几天";
      if (entry.appliesTo !== "chapterStart" && entry.appliesTo !== "chapterEnd") return "作者定的天数只记本章开头、结尾";
      return entry.anchor || entry.offset || entry.byBoundary ? "定了第几天就不再写相对谁" : undefined;
    case "unknown":
      if (entry.day !== undefined || entry.anchor || entry.offset || entry.byBoundary) return "说不出哪天的时间不带天数";
      if (entry.basis === "author") return "作者定的天数要写是第几天";
      return entry.appliesTo === "chapterStart" || entry.appliesTo === "scene" ? undefined : "说不出哪天的只能是本章开头、段";
    case "offset":
      break;
    default:
      return "这种时间关系不用";
  }
  if (entry.day !== undefined || entry.basis === "author" || entry.basis === "estimated") return "相对的天数不由作者定、也不估";
  const relative = relativeProblem(entry);
  if (relative) return relative;
  switch (entry.appliesTo) {
    case "chapterStart":
      return entry.anchor === "previousChapterEnd" ? undefined : "本章开头相对前一个当下章的结尾";
    case "chapterEnd":
      if (entry.anchor !== "chapterStart") return "本章结尾相对本章开头";
      return entry.offset?.unit === "day" && entry.offset.min === 0 && entry.offset.max === 0 ? undefined : "本章结尾那条只记整章同一天；跨天逐次记换天";
    case "dayChange":
      return entry.anchor === "previousMoment" ? dayChangeProblem(entry) : "换天相对本章里上一个当下时刻";
    case "scene":
      return entry.anchor === "chapterStart" || entry.anchor === "previousChapterEnd" ? undefined : "段的时间相对本章开头（整章是一段时相对前一个当下章结尾）";
  }
}

/** 证据和状态对不对得上：新记的条目要附原句的必须核得上；只有迁移来的能是找不到、过时了。 */
function evidenceProblem(entry: LedgerEntry, chapter: number, origin: LedgerOrigin, timeModel: TimeModel | undefined): string | undefined {
  const status = entry.evidenceStatus;
  if (status === "none") return entry.evidence.length > 0 ? "不带原句的条目不该有证据" : needsEvidence(entry, origin, timeModel) ? "定稿、通读记的条目必须附原句" : undefined;
  if (entry.evidence.length === 0) return "缺原句";
  if (entry.evidence.some((item) => item.resource.kind !== "chapter" || item.resource.chapter !== chapter)) return "证据只能是本章正文";
  if ((status === "unlocated_legacy" || status === "stale") && entry.provenance !== "migrated") return "只有迁移来的条目能是找不到原句、过时了";
  if (status === "located" && entry.evidence.some((item) => item.units === undefined)) return "定位了的证据要有句号";
  if (status !== "located" && entry.evidence.some((item) => item.units !== undefined)) return "没唯一定位的证据不给句号";
  return undefined;
}

const needsEvidence = (entry: LedgerEntry, origin: LedgerOrigin, timeModel: TimeModel | undefined): boolean =>
  entry.provenance === "native" && origin !== "import" && storedNeedsQuote(entry, timeModel);

/** 存着的条目要不要附原句：时间里只有记账员记的本章开头（旧账：正文明写、判断的那条）要；其余都要。 */
function storedNeedsQuote(entry: LedgerEntry, timeModel: TimeModel | undefined): boolean {
  if (entry.kind !== "time") return true;
  if (entry.basis !== "text" && entry.basis !== "judged") return false;
  return timeModel === TIME_MODEL ? entry.appliesTo === "chapterStart" && entry.relation === "offset" : true;
}

/** 这一章正文怎么进来的、账谁记的：commit = 定稿命令；import = 从老书 / 已写的书导入；reread = 记账员通读。 */
export const LedgerOrigin = z.enum(["commit", "import", "reread"]);
export type LedgerOrigin = z.infer<typeof LedgerOrigin>;

/** pending = 这版正文定了、账还没记（entries 空是「待记」，不是「什么都没发生」）；partial = 有明确没记完的；ready = 这次记账做完了。 */
export const LedgerStatus = z.enum(["pending", "partial", "ready"]);
export type LedgerStatus = z.infer<typeof LedgerStatus>;

/** 账记到什么程度：哪几类明确没记、核不上被拒了几条、为什么（代码）、哪几句没覆盖。 */
export const LedgerCoverage = z.object({
  missingKinds: z.array(EntryKind),
  rejectedCount: z.number().int().min(0),
  reasonCodes: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/u)),
  omittedUnits: z.array(UnitRange),
});
export type LedgerCoverage = z.infer<typeof LedgerCoverage>;

/**
 * 一章里不在当下线上的一段（设计 2.1）：句子范围、frame、首末句原句（代码从正文取的，定论改文后按它重新对回编号）、
 * 段的时间（timeRefs 指向 appliesTo = scene 的那条，最多一条；other 段没有）。stale = 改文后对不回了，按「段未知」处理。
 * 旧账一律空 = 没切段，不是「整章当下」的证明。
 */
export const LedgerScene = z.object({
  id,
  units: UnitRange,
  order: z.number().int().min(0),
  timeRefs: z.array(id),
  frame: SceneFrame,
  quotes: z.object({ first: text, last: text }),
  stale: z.literal(true).optional(),
});
export type LedgerScene = z.infer<typeof LedgerScene>;

/**
 * 最近一份记了时间的账单那一套时间（出口复核 R6）：时间条目、段、时间格式原样一份。
 * carry 的条目是几版的并集，段只对得上其中一版；重记时上一份是账待记的，就照这份读回上次记账员记的时间。
 */
export const LedgerCarryTime = z
  .object({
    timeModel: z.literal(TIME_MODEL).optional(),
    entries: z.array(TimeEntry),
    scenes: z.array(LedgerScene),
  })
  .superRefine((time, ctx) => {
    for (const issue of timeLayoutIssues(time)) ctx.addIssue({ code: "custom", ...issue });
  });
export type LedgerCarryTime = z.infer<typeof LedgerCarryTime>;

/**
 * 重记同一章时带上的旧账身份（P2b 设计 3.1）：这一章以前各版账单里出现过的全部条目（同一编号留最近那版），
 * 新账分配编号时照它沿用、跳过（不复用证明不了是同一件事的旧号），补账时照它接回上次开的线索、上次的天数。
 * 每次重记都带、一路继承（新 carry = 旧账的条目 ∪ 旧 carry；time 取最近一份记了时间的那版）。投影不读。
 */
export const LedgerPrevious = z.object({
  /** 被换掉的那份账单的原样哈希。 */
  ledgerSha256: sha,
  carry: z.object({ entries: z.array(LedgerEntry), time: LedgerCarryTime.optional() }),
});
export type LedgerPrevious = z.infer<typeof LedgerPrevious>;

/**
 * 一条时间条目在本章里管什么：作者定的开头 / 结尾、记账员记的开头、结尾（P3 起只记「整章同一天」；旧账是本章内过了几天）、
 * 一次换天、一个段的时间。投影、校验都照它分，不各自看格子。
 */
export type TimeRole = "authorStart" | "authorEnd" | "start" | "end" | "dayChange" | "scene";
export function timeRoleOf(entry: TimeEntry): TimeRole {
  if (entry.relation === "at") return entry.appliesTo === "chapterEnd" ? "authorEnd" : "authorStart";
  switch (entry.appliesTo) {
    case "chapterStart":
      return "start";
    case "chapterEnd":
      return "end";
    case "dayChange":
      return "dayChange";
    case "scene":
      return "scene";
  }
}

type Issue = { readonly path: (string | number)[]; readonly message: string };

/** 一章里时间条目之间、段之间的关系（设计 2.2：开头 ≤ 1、同一天 ≤ 1、换天要有开头、同一天和换天不并存；段不重叠、时间引用对得上）。 */
function timeLayoutIssues(ledger: { readonly timeModel?: TimeModel; readonly entries: readonly LedgerEntry[]; readonly scenes: readonly LedgerScene[] }): Issue[] {
  const issues: Issue[] = [];
  const roles = new Map<TimeRole, number>();
  ledger.entries.forEach((entry, index) => {
    if (entry.kind !== "time") return;
    const role = timeRoleOf(entry);
    roles.set(role, (roles.get(role) ?? 0) + 1);
    if ((role === "start" || role === "end" || role === "authorStart" || role === "authorEnd") && (roles.get(role) ?? 0) > 1) {
      issues.push({ path: ["entries", index], message: "本章开头、结尾的时间各只能有一条（作者定的另算一条）" });
    }
  });
  const has = (role: TimeRole): boolean => (roles.get(role) ?? 0) > 0;
  // 旧账里作者定的开头那天可以带「本章内过了几天」（P2b 当年的存法）。
  const legacy = ledger.timeModel !== TIME_MODEL;
  if (has("end") && !has("start") && !(legacy && has("authorStart"))) issues.push({ path: ["entries"], message: "有本章结尾的时间就要有本章开头那条" });
  if (has("authorEnd") && !has("authorStart")) issues.push({ path: ["entries"], message: "作者定了结尾那天就要定开头那天" });
  if (legacy) {
    if (ledger.scenes.length > 0) issues.push({ path: ["scenes"], message: "旧账没切段" });
    if (has("authorEnd") || has("dayChange") || has("scene")) issues.push({ path: ["entries"], message: "旧账没有作者定的结尾、换天、段的时间" });
    return issues;
  }
  if (has("dayChange") && !has("start")) issues.push({ path: ["entries"], message: "有换天就要有本章开头那条" });
  if (has("dayChange") && has("end")) issues.push({ path: ["entries"], message: "整章同一天就不该有换天" });

  const sceneTimes = new Map<string, TimeEntry>();
  for (const entry of ledger.entries) if (entry.kind === "time" && entry.appliesTo === "scene") sceneTimes.set(entry.id, entry);
  const entryIds = new Set(ledger.entries.map((entry) => entry.id));
  const sceneIds = new Set<string>();
  const orders = new Set<number>();
  const referenced = new Set<string>();
  const sorted = [...ledger.scenes].sort((a, b) => a.units.from - b.units.from);
  sorted.forEach((scene, index) => {
    const at = ledger.scenes.indexOf(scene);
    if (sceneIds.has(scene.id) || entryIds.has(scene.id)) issues.push({ path: ["scenes", at, "id"], message: `段的编号重复：${scene.id}` });
    sceneIds.add(scene.id);
    if (orders.has(scene.order)) issues.push({ path: ["scenes", at, "order"], message: "段的先后重复" });
    orders.add(scene.order);
    const next = sorted[index + 1];
    if (next && next.units.from <= scene.units.to) issues.push({ path: ["scenes", at, "units"], message: "两段的句子重叠了" });
    if (scene.timeRefs.length > (scene.frame === "past" ? 1 : 0)) issues.push({ path: ["scenes", at, "timeRefs"], message: scene.frame === "past" ? "一段最多一条时间" : "梦、想象、传闻这类段不上时间线" });
    for (const ref of scene.timeRefs) {
      const time = sceneTimes.get(ref);
      if (!time || referenced.has(ref)) issues.push({ path: ["scenes", at, "timeRefs"], message: "段指的时间对不上" });
      referenced.add(ref);
      if (time?.anchor === "previousChapterEnd" && (has("start") || has("authorStart"))) issues.push({ path: ["scenes", at, "timeRefs"], message: "本章有当下的开头，段的时间就相对本章开头" });
    }
  });
  for (const id of sceneTimes.keys()) if (!referenced.has(id)) issues.push({ path: ["entries"], message: "段的时间没有段指着" });
  return issues;
}

export const ChapterLedger = z
  .object({
    schema: z.literal(CHAPTER_LEDGER_SCHEMA),
    chapter: chapterNo,
    /** 定稿时正文的 sha256：之后正文被改过，投影据此标「定稿后改过」。 */
    textSha256: sha,
    committedAt: z.string().min(1),
    origin: LedgerOrigin,
    status: LedgerStatus,
    coverage: LedgerCoverage,
    /** 作者点确认时依据的摘要（定稿、补账确认）。 */
    acceptedBasis: text.optional(),
    unitsVersion: z.literal(UNITS_VERSION),
    /** P3 起新记的账带 2；缺 = 旧账（设计 2.1、2.7）。 */
    timeModel: z.literal(TIME_MODEL).optional(),
    scenes: z.array(LedgerScene),
    entries: z.array(LedgerEntry),
    previous: LedgerPrevious.optional(),
    /** 从 v1 迁来的：原文件的哈希（原样在迁移前的存档里）。 */
    legacy: z.object({ schema: z.literal("chapter-ledger/1"), sha256: sha }).optional(),
  })
  .superRefine((ledger, ctx) => {
    const ids = new Set<string>();
    let summaries = 0;
    if (ledger.status === "pending" && (ledger.entries.length > 0 || ledger.scenes.length > 0)) ctx.addIssue({ code: "custom", path: ["entries"], message: "账待记的章不该有条目" });
    ledger.entries.forEach((entry, index) => {
      if (ids.has(entry.id)) ctx.addIssue({ code: "custom", path: ["entries", index, "id"], message: `条目编号重复：${entry.id}` });
      ids.add(entry.id);
      if (entry.kind === "summary") summaries += 1;
      const problem = storedShapeProblem(entry, ledger.timeModel) ?? evidenceProblem(entry, ledger.chapter, ledger.origin, ledger.timeModel);
      if (problem) ctx.addIssue({ code: "custom", path: ["entries", index], message: problem });
    });
    if (summaries > 1) ctx.addIssue({ code: "custom", path: ["entries"], message: "一章只能有一条梗概" });
    for (const issue of timeLayoutIssues(ledger)) ctx.addIssue({ code: "custom", ...issue });
  });
export type ChapterLedger = z.infer<typeof ChapterLedger>;

/**
 * 这份账哪几类没记全（P2b 出口复核第 2 条）：ready 没有；pending 全部；partial 按 coverage 写明的那几类，没写明就当全部（不知道缺哪类）。
 * 读的路径照它：没记全的那类不能按「账里没有」下结论（天数不按上一章 +1 估、线索不算闲置、节奏不算密度、梗概如实说给不出）。
 */
export function missingKindsOf(ledger: Pick<ChapterLedger, "status" | "coverage">): readonly EntryKind[] {
  if (ledger.status === "ready") return [];
  if (ledger.status === "partial" && ledger.coverage.missingKinds.length > 0) return ledger.coverage.missingKinds;
  return EntryKind.options;
}
