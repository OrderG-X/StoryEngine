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
 *    P2b 只把格子留好（来源一律 unknown、场景为空），P3 再让记账员、投影真用它们。
 * 读的一方经这里的几个小函数取（entryQuote、subjectOf、presenceName、threadOf），不各写各的。
 * 条目编号只在系统内部用，绝不直接给作者看。
 */
import { z } from "zod";

export const CHAPTER_LEDGER_SCHEMA = "chapter-ledger/2" as const;
/** 证据里的句子编号按哪一版切句算（`text/units.ts`）。切法改了就加一。 */
export const UNITS_VERSION = 1 as const;

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

export const EntryKind = z.enum(["summary", "fact", "thread", "time", "presence"]);
export type EntryKind = z.infer<typeof EntryKind>;

// —— 交给「定稿」命令的条目（记账员、定稿清单的声明） ——

const declared = { review: ReviewMark };

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
});
export const TimeInput = z.object({
  kind: z.literal("time"),
  ...declared,
  basis: TimeBasis,
  /** text / judged 必填。 */
  quote: text.optional(),
  /** 和上一章结尾隔了几天（0 = 同一天）。 */
  daysSincePrevious: z.number().int().min(0).max(3650).optional(),
  /** 作者直接定的「故事第几天」（只认 basis = author）。 */
  day: z.number().int().min(1).optional(),
  /** 本章内过了几天（章末 = 当天 + 这个数）。 */
  daysInChapter: z.number().int().min(0).max(3650).optional(),
  /** 正文明写的星期：0 = 周一 … 6 = 周日。 */
  weekday: z.number().int().min(0).max(6).optional(),
  /** 正文里的时段说法，原样。 */
  timeOfDay: text.optional(),
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
export const EntryInput = z.discriminatedUnion("kind", [SummaryInput, FactInput, ThreadInput, TimeInput, PresenceInput]);

export type SummaryInput = z.infer<typeof SummaryInput>;
export type FactInput = z.infer<typeof FactInput>;
export type ThreadInput = z.infer<typeof ThreadInput>;
export type TimeInput = z.infer<typeof TimeInput>;
export type PresenceInput = z.infer<typeof PresenceInput>;
export type EntryInput = z.infer<typeof EntryInput>;

/** 这条要不要附原句：时间由作者定或代码估的不用，其余都要。 */
export function entryNeedsQuote(entry: { readonly kind: EntryKind; readonly basis?: TimeBasis }): boolean {
  return entry.kind !== "time" || entry.basis === "text" || entry.basis === "judged";
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
      if (entry.day !== undefined && entry.basis !== "author") return "只有作者能直接定故事第几天";
      return undefined;
    default:
      return undefined;
  }
}

// —— 账单里存的条目 ——

/** 指一个人 / 一样东西：P2b 照旧只按名字认（只有 mention）；id 只在作者确认或设定卡里明确时有（P3）。 */
export const EntityRef = z.object({ id: id.optional(), mention: text });
export type EntityRef = z.infer<typeof EntityRef>;

/** 这条是谁说的：叙述、人物说的、作者裁定，或不知道。P2b 一律 unknown（旧账、现在的记账员都没分）。 */
export const EntrySource = z.object({
  kind: z.enum(["narration", "character_claim", "author_ruling", "unknown"]),
  speaker: EntityRef.optional(),
  decision: id.optional(),
});
export type EntrySource = z.infer<typeof EntrySource>;

/** 正文里第几句到第几句（含两头，`text/units.ts` 的编号）。 */
export const UnitRange = z.object({ from: z.number().int().min(1), to: z.number().int().min(1) }).refine((range) => range.from <= range.to, "句子范围倒了");
export type UnitRange = z.infer<typeof UnitRange>;

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

/** 时间关系：at = 就在那一天（作者定的）；offset = 离锚点几天；unknown = 记了时间、说不出是哪天。before / after / overlaps 留给 P3。 */
export const TimeRelation = z.enum(["at", "before", "after", "offset", "overlaps", "unknown"]);
/** 这条说的是本章开头还是本章结尾。 */
export const TimeAppliesTo = z.enum(["chapterStart", "chapterEnd"]);
/** 相对谁：上一章结尾，或本章开头（本章结尾那条用）。 */
export const TimeAnchor = z.enum(["previousChapterEnd", "chapterStart"]);
export const DayOffset = z.object({ unit: z.literal("day"), min: z.number().int().min(-3650).max(3650), max: z.number().int().min(-3650).max(3650) });

export const TimeEntry = z.object({
  kind: z.literal("time"),
  ...common,
  relation: TimeRelation,
  appliesTo: TimeAppliesTo,
  anchor: TimeAnchor.optional(),
  offset: DayOffset.optional(),
  /** 作者定的故事第几天（relation = at）。 */
  day: z.number().int().min(1).optional(),
  calendarId: id.optional(),
  /** 正文明写的星期：0 = 周一 … 6 = 周日。 */
  weekday: z.number().int().min(0).max(6).optional(),
  timeOfDay: text.optional(),
  basis: TimeBasis,
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

/** 一条存着的条目的结构问题（和 entryShapeProblem 同一套规矩，加上时间关系的格子）。 */
export function storedShapeProblem(entry: LedgerEntry): string | undefined {
  switch (entry.kind) {
    case "fact":
      if (entry.nature !== "event" && (!entry.subjectRef || !entry.predicate || !entry.value)) return "不会变的事实和状态必须写清谁、哪方面、是什么";
      if ((entry.transition === "change") !== (entry.replaces !== undefined)) return "明写推翻前文的才是 change，且要写清推翻哪几条";
      return undefined;
    case "thread":
      if (entry.op === "open" && (!entry.type || !entry.title)) return "新开的线索必须有类型和标题";
      return entry.transition === "unknown" ? undefined : "线索动作的变更关系 P2b 只记 unknown";
    case "time":
      return timeShapeProblem(entry);
    default:
      return entry.transition === "unknown" ? undefined : "这类条目的变更关系 P2b 只记 unknown";
  }
}

/** 时间：P2b 只放格子，语义照旧（作者定第几天、离上一章几天、本章内过几天）；P3 放宽这些限制不用再迁一次。 */
function timeShapeProblem(entry: TimeEntry): string | undefined {
  if (entry.transition !== "unknown") return "时间的变更关系 P2b 只记 unknown";
  if (entry.offset && (entry.offset.min !== entry.offset.max || entry.offset.min < 0)) return "P2b 的相对天数只能是一个确定的、不小于 0 的数";
  if (entry.calendarId !== undefined) return "历法 P2b 还不用";
  switch (entry.relation) {
    case "at":
      if (entry.appliesTo !== "chapterStart" || entry.day === undefined || entry.basis !== "author") return "只有作者能直接定故事第几天（本章开头）";
      return entry.anchor || entry.offset ? "定了第几天就不再写相对谁" : undefined;
    case "offset":
      if (!entry.anchor || !entry.offset || entry.day !== undefined) return "相对天数要写清相对谁、隔几天";
      if (entry.appliesTo === "chapterStart" && entry.anchor !== "previousChapterEnd") return "本章开头只相对上一章结尾";
      if (entry.appliesTo === "chapterEnd" && entry.anchor !== "chapterStart") return "本章结尾只相对本章开头";
      return undefined;
    case "unknown":
      if (entry.appliesTo !== "chapterStart" || entry.anchor || entry.offset || entry.day !== undefined) return "说不出哪天的时间只记在本章开头、不带天数";
      return undefined;
    default:
      return "这种时间关系 P2b 还不用";
  }
}

/** 证据和状态对不对得上：新记的条目要附原句的必须核得上；只有迁移来的能是找不到、过时了。 */
function evidenceProblem(entry: LedgerEntry, chapter: number, origin: LedgerOrigin): string | undefined {
  const status = entry.evidenceStatus;
  if (status === "none") return entry.evidence.length > 0 ? "不带原句的条目不该有证据" : needsEvidence(entry, origin) ? "定稿、通读记的条目必须附原句" : undefined;
  if (entry.evidence.length === 0) return "缺原句";
  if (entry.evidence.some((item) => item.resource.kind !== "chapter" || item.resource.chapter !== chapter)) return "P2b 的证据只能是本章正文";
  if ((status === "unlocated_legacy" || status === "stale") && entry.provenance !== "migrated") return "只有迁移来的条目能是找不到原句、过时了";
  if (status === "located" && entry.evidence.some((item) => item.units === undefined)) return "定位了的证据要有句号";
  if (status !== "located" && entry.evidence.some((item) => item.units !== undefined)) return "没唯一定位的证据不给句号";
  return undefined;
}

const needsEvidence = (entry: LedgerEntry, origin: LedgerOrigin): boolean =>
  entry.provenance === "native" && origin !== "import" && entryNeedsQuote(entry);

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
 * 重记同一章时带上的旧账身份（P2b 设计 3.1）：这一章以前各版账单里出现过的全部条目（同一编号留最近那版），
 * 新账分配编号时照它沿用、跳过（不复用证明不了是同一件事的旧号），补账时照它接回上次开的线索、上次的天数。
 * 每次重记都带、一路继承（新 carry = 旧账的条目 ∪ 旧 carry）。投影不读。
 */
export const LedgerPrevious = z.object({
  /** 被换掉的那份账单的原样哈希。 */
  ledgerSha256: sha,
  carry: z.object({ entries: z.array(LedgerEntry) }),
});
export type LedgerPrevious = z.infer<typeof LedgerPrevious>;

/** 一章的场景（P3）：P2b 一律空 = 没切场景，不是「一个场景」。 */
export const LedgerScene = z.object({ id, units: UnitRange, order: z.number().int().min(0), timeRefs: z.array(id) });

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
    scenes: z.array(LedgerScene),
    entries: z.array(LedgerEntry),
    previous: LedgerPrevious.optional(),
    /** 从 v1 迁来的：原文件的哈希（原样在迁移前的存档里）。 */
    legacy: z.object({ schema: z.literal("chapter-ledger/1"), sha256: sha }).optional(),
  })
  .superRefine((ledger, ctx) => {
    const ids = new Set<string>();
    let summaries = 0;
    const times = new Set<string>();
    if (ledger.status === "pending" && ledger.entries.length > 0) ctx.addIssue({ code: "custom", path: ["entries"], message: "账待记的章不该有条目" });
    if (ledger.scenes.length > 0) ctx.addIssue({ code: "custom", path: ["scenes"], message: "场景 P2b 还不用" });
    ledger.entries.forEach((entry, index) => {
      if (ids.has(entry.id)) ctx.addIssue({ code: "custom", path: ["entries", index, "id"], message: `条目编号重复：${entry.id}` });
      ids.add(entry.id);
      if (entry.kind === "summary") summaries += 1;
      if (entry.kind === "time") {
        if (times.has(entry.appliesTo)) ctx.addIssue({ code: "custom", path: ["entries", index], message: "本章开头、结尾的时间各只能有一条" });
        times.add(entry.appliesTo);
      }
      if (entry.source.kind !== "unknown") ctx.addIssue({ code: "custom", path: ["entries", index, "source"], message: "来源 P2b 只记 unknown" });
      const problem = storedShapeProblem(entry) ?? evidenceProblem(entry, ledger.chapter, ledger.origin);
      if (problem) ctx.addIssue({ code: "custom", path: ["entries", index], message: problem });
    });
    if (summaries > 1) ctx.addIssue({ code: "custom", path: ["entries"], message: "一章只能有一条梗概" });
    if (times.has("chapterEnd") && !times.has("chapterStart")) ctx.addIssue({ code: "custom", path: ["entries"], message: "有本章结尾的时间就要有本章开头那条" });
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
