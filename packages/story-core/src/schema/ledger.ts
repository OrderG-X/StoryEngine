/**
 * 章节账单（真相之二）：每章一份，定稿时写入 `ledger/chapters/NNNN.json`。
 *
 * 一章引起的全部变化都在这里：本章梗概、事实、线索（开 / 推进 / 收）、时间、出场人物（含称呼）。
 * 每一条都带本章原句（时间由作者定或代码估的除外），写入前由代码核对原句真在正文里。
 * 事实账本、线索池、时间线、人物现状……全是从这些账单算出来的投影，不另存。
 *
 * 每种条目先定「交给定稿命令的样子」（Input，没有 id），账单里存的条目 = Input + 核心分配的 id。
 * 条目编号只在系统内部用，绝不直接给作者看。
 */
import { z } from "zod";

export const CHAPTER_LEDGER_SCHEMA = "chapter-ledger/1" as const;

const text = z.string().trim().min(1);
const id = text;

/** 这条是作者在定稿清单上亲眼看过点头的（author），还是自动记下、可撤销的（auto）。 */
export const ReviewMark = z.enum(["author", "auto"]);
export type ReviewMark = z.infer<typeof ReviewMark>;

/** 本章梗概（每章至多一条）。 */
const summaryShape = {
  kind: z.literal("summary"),
  review: ReviewMark,
  text,
  quote: text,
};

/**
 * 事实。hard = 不会变的（年龄、门牌、写着的字）；state = 会变的状态（在哪、在谁手里、开着还是锁着）；
 * event = 发生过的事。hard / state 必须写清「谁 · 哪方面 · 是什么」，投影靠它做确定性比对。
 */
export const FactNature = z.enum(["hard", "state", "event"]);
export type FactNature = z.infer<typeof FactNature>;

const factShape = {
  kind: z.literal("fact"),
  review: ReviewMark,
  nature: FactNature,
  /** 谁 / 什么。hard 和 state 必填；event 可以没有（老书导入的旧事件常常没有）。 */
  subject: text.optional(),
  attribute: text.optional(),
  value: text.optional(),
  /** 给人看的一句话。 */
  text,
  quote: text,
  /** 本章明写推翻了前文哪些事实（那几条的 id）。不会变的事实只能这样作废。 */
  replaces: z.array(id).min(1).optional(),
};

/** 线索类型：question = 悬念 / 待解的问题；intent = 人物的打算、待办；goal = 主角的目标。 */
export const ThreadType = z.enum(["question", "intent", "goal"]);
export type ThreadType = z.infer<typeof ThreadType>;

export const ThreadOp = z.enum(["open", "advance", "close"]);
export type ThreadOp = z.infer<typeof ThreadOp>;

const threadShape = {
  kind: z.literal("thread"),
  review: ReviewMark,
  op: ThreadOp,
  /** open 必填。 */
  type: ThreadType.optional(),
  /** open 必填：线索叫什么。 */
  title: text.optional(),
  /** 本章对这条线索做了什么。 */
  note: text,
  quote: text,
};

/**
 * 时间依据：text = 正文明写；judged = 记账员读前后文判断（附本章开头那句）；
 * author = 作者定的；estimated = 代码按上一章 +1 估的（一律请作者确认）。
 */
export const TimeBasis = z.enum(["text", "judged", "author", "estimated"]);
export type TimeBasis = z.infer<typeof TimeBasis>;

const timeShape = {
  kind: z.literal("time"),
  review: ReviewMark,
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
};

/** 出场人物：name = 这个人的已确立名字；nameUsed = 本章正文里怎么称呼他（不同就是别名）。 */
const presenceShape = {
  kind: z.literal("presence"),
  review: ReviewMark,
  name: text,
  nameUsed: text,
  /** 本章主要跟着这个人的眼睛走。 */
  viewpoint: z.boolean().optional(),
  /** nameUsed 是换个场景就指别人的代称（「那人」「老头」）：只认本章这一处，不记成这个人的别名。 */
  generic: z.boolean().optional(),
  quote: text,
};

// —— 交给「定稿」命令的条目 ——

export const SummaryInput = z.object(summaryShape);
export const FactInput = z.object(factShape);
/** 新开的线索可以带上本章上次定稿时的编号（重定稿时沿用，后文的推进才接得上）；推进、收口必须带。 */
export const ThreadInput = z.object({ ...threadShape, thread: id.optional() });
export const TimeInput = z.object(timeShape);
export const PresenceInput = z.object(presenceShape);
export const EntryInput = z.discriminatedUnion("kind", [SummaryInput, FactInput, ThreadInput, TimeInput, PresenceInput]);

export type SummaryInput = z.infer<typeof SummaryInput>;
export type FactInput = z.infer<typeof FactInput>;
export type ThreadInput = z.infer<typeof ThreadInput>;
export type TimeInput = z.infer<typeof TimeInput>;
export type PresenceInput = z.infer<typeof PresenceInput>;
export type EntryInput = z.infer<typeof EntryInput>;

// —— 账单里存的条目 ——
// 原句在存盘格式里是可选的：只有从老书导入的账单（origin = import）允许没有原句（老数据当年没存）；
// 走「定稿」「通读记账」命令写的账单，ChapterLedger 的校验要求每条都有（时间由作者定或代码估的除外）。

const stored = { id, quote: text.optional() };
export const SummaryEntry = z.object({ ...summaryShape, ...stored });
export const FactEntry = z.object({ ...factShape, ...stored });
export const ThreadEntry = z.object({ ...threadShape, ...stored, thread: id });
export const TimeEntry = z.object({ ...timeShape, id });
export const PresenceEntry = z.object({ ...presenceShape, ...stored });
export const LedgerEntry = z.discriminatedUnion("kind", [SummaryEntry, FactEntry, ThreadEntry, TimeEntry, PresenceEntry]);

export type SummaryEntry = z.infer<typeof SummaryEntry>;
export type FactEntry = z.infer<typeof FactEntry>;
export type ThreadEntry = z.infer<typeof ThreadEntry>;
export type TimeEntry = z.infer<typeof TimeEntry>;
export type PresenceEntry = z.infer<typeof PresenceEntry>;
export type LedgerEntry = z.infer<typeof LedgerEntry>;

/** 这条要不要附原句：时间由作者定或代码估的不用，其余都要。 */
export function entryNeedsQuote(entry: LedgerEntry | EntryInput): boolean {
  return entry.kind !== "time" || entry.basis === "text" || entry.basis === "judged";
}

/** 一条条目的结构问题（字段缺了、自相矛盾）。原句核对不在这里，见 `checkEntries`。 */
export function entryShapeProblem(entry: LedgerEntry | EntryInput): string | undefined {
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

export const ChapterLedger = z
  .object({
    schema: z.literal(CHAPTER_LEDGER_SCHEMA),
    chapter: z.number().int().min(1),
    /** 定稿时正文的 sha256：之后正文被改过，投影据此标「定稿后改过」。 */
    textSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    committedAt: z.string().min(1),
    /** commit = 走「定稿」命令写的；import = 从老书数据导入的（导入已写的书时是空账单）；reread = 记账员通读前文记的。 */
    origin: z.enum(["commit", "import", "reread"]),
    entries: z.array(LedgerEntry),
  })
  .superRefine((ledger, ctx) => {
    const ids = new Set<string>();
    let summaries = 0;
    let times = 0;
    ledger.entries.forEach((entry, index) => {
      if (ids.has(entry.id)) ctx.addIssue({ code: "custom", path: ["entries", index, "id"], message: `条目编号重复：${entry.id}` });
      ids.add(entry.id);
      if (entry.kind === "summary") summaries += 1;
      if (entry.kind === "time") times += 1;
      const problem = entryShapeProblem(entry);
      if (problem) ctx.addIssue({ code: "custom", path: ["entries", index], message: problem });
      if (ledger.origin !== "import" && entryNeedsQuote(entry) && !entry.quote) {
        ctx.addIssue({ code: "custom", path: ["entries", index, "quote"], message: "定稿、通读记的条目必须附原句" });
      }
    });
    if (summaries > 1) ctx.addIssue({ code: "custom", path: ["entries"], message: "一章只能有一条梗概" });
    if (times > 1) ctx.addIssue({ code: "custom", path: ["entries"], message: "一章只能有一条时间" });
  });
export type ChapterLedger = z.infer<typeof ChapterLedger>;
