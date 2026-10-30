/**
 * 投影：全部从真相（章节账单 + 作者裁定 + 正文）算出来，随时可重算，不另存。
 * 界面、核账员、对话 AI 读的都是这一份。里面的 id 只给程序用，展示时一律换成名字 / 标题。
 */
import type { EntryKind, FactNature, LedgerStatus, ReviewMark, ThreadType } from "../schema/ledger.js";
import type { EntryFrame } from "./scope.js";
import type { ChapterTime, TimeConflictView, TimeWorld } from "./time.js";

export interface ChapterView {
  readonly chapter: number;
  readonly origin: "commit" | "import" | "reread";
  readonly committedAt: string;
  readonly summary?: string;
  /** 这章的账记到什么程度：pending = 正文定了、账还没记上（不贡献任何条目，不是「什么都没发生」）。 */
  readonly ledgerStatus: LedgerStatus;
  /** 哪几类没记全（账待记 = 全部；没记全 = 写明的那几类，没写明当全部）；记全了就没有。没记全的那类不能按「账里没有」下结论。 */
  readonly missingKinds?: readonly EntryKind[];
  /** 故事时间（P3a，projection/time.ts）：当下线、开头 / 结尾区间、段、星期。 */
  readonly time: ChapterTime;
  /** 出场人物（已确立名字）。 */
  readonly present: readonly string[];
  readonly viewpoint?: string;
  /** 定稿后正文被改过（和账单记的 sha256 对不上）。正文文件不在时为 undefined。 */
  readonly editedSinceCommit?: boolean;
  readonly textMissing: boolean;
}

/** aside = 记着、但不算现状（梦里的、回忆里的、人物说的、定不了在段里段外的，设计第 3 节）。 */
export type FactStatus = "current" | "superseded" | "retracted" | "aside";

/** 这条在哪说的、谁说的（展示「某某说过」「梦里」用）。 */
export interface StatementScope {
  readonly frame: EntryFrame;
  readonly source: "narration" | "character_claim" | "author_ruling" | "unknown";
  readonly speaker?: string;
}

export interface FactView {
  readonly id: string;
  readonly chapter: number;
  readonly nature: FactNature;
  /** 主体的已确立名字（别名已归并）。没有主体的旧事件没有这两项。 */
  readonly subject?: string;
  readonly subjectKey?: string;
  readonly attribute?: string;
  readonly attributeKey?: string;
  readonly value?: string;
  readonly text: string;
  /** 老书导入的事实可能没有原句。 */
  readonly quote?: string;
  readonly review: ReviewMark;
  readonly status: FactStatus;
  readonly scope: StatementScope;
  readonly supersededAt?: number;
  readonly supersededBy?: string;
}

/** 某个主体（人、物、地方）某方面的现状和历史，按最新一章算。 */
export interface SubjectAttributeView {
  readonly attribute: string;
  readonly key: string;
  readonly nature: "hard" | "state";
  /** 现在有效的那条（state 只有一条；hard 有矛盾时可能多条，见 conflicts）。 */
  readonly current: readonly string[];
  /** 从早到晚的全部记录（事实 id）。 */
  readonly history: readonly string[];
}

export interface SubjectView {
  readonly key: string;
  readonly name: string;
  readonly attributes: readonly SubjectAttributeView[];
}

export type ThreadStatus = "open" | "active" | "stale" | "closed";
export type ThreadWeight = "major" | "normal" | "minor";

export interface ThreadTouch {
  readonly chapter: number;
  readonly op: "open" | "advance" | "close";
  readonly note: string;
  readonly quote?: string;
  /** 账单条目 id。 */
  readonly entry: string;
  /** 记账员记的是收口，但它是人物说的 / 回忆里的 / 梦里的 / 定不了在哪的：按推进记（理线索时可以提议收）。 */
  readonly closeDenied?: StatementScope;
}

export interface ThreadView {
  readonly id: string;
  readonly type: ThreadType;
  readonly title: string;
  readonly openedAt: number;
  readonly lastTouchedAt: number;
  /** 最近一次动到现在隔了几章（账待记的章不数：不知道它动没动）。 */
  readonly idleChapters: number;
  readonly closedAt?: number;
  readonly closedBy?: "ledger" | "author";
  readonly status: ThreadStatus;
  readonly weight: ThreadWeight;
  readonly touches: readonly ThreadTouch[];
  /** 作者归并进来的线索 id。 */
  readonly mergedFrom: readonly string[];
}

export interface CastMember {
  readonly key: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly chapters: readonly number[];
  readonly viewpointChapters: readonly number[];
  /** 每章出场的原句（这章记的第一条），故事地图点格子回原文用。 */
  readonly appearances: readonly { readonly chapter: number; readonly quote: string }[];
}

/** 投影自己就能确定的矛盾：同一主体同一方面、不会变的事实前后值不同，又没有明写推翻。 */
export interface ConflictView {
  /** 确定性的问题键，作者点「不是问题」时记进裁定。 */
  readonly key: string;
  readonly kind: "hard-fact";
  /** sure = 两条都是叙述当下说的；maybe = 有一条来源不明 / 人物说的 / 定不了在段里段外，交核账员拿原文判。 */
  readonly confidence: "sure" | "maybe";
  readonly subject: string;
  readonly attribute: string;
  readonly facts: readonly [string, string];
}

/** 指向了不存在的东西（线索、事实、裁定里的线索）。绝不悄悄丢掉，摆出来给人看。 */
export interface DanglingView {
  readonly kind: "thread" | "fact" | "decision";
  readonly ref: string;
  readonly chapter?: number;
  /** 账单条目 id 或裁定 id。 */
  readonly source: string;
}

export interface BookProjection {
  /** 算这份投影时书的版本号。 */
  readonly version: number;
  /** 算到第几章（含）。 */
  readonly upTo: number;
  /** 读真相时正好在写、没读稳。 */
  readonly unsettled: boolean;
  readonly chapters: readonly ChapterView[];
  readonly facts: readonly FactView[];
  readonly subjects: readonly SubjectView[];
  readonly threads: readonly ThreadView[];
  readonly cast: readonly CastMember[];
  readonly conflicts: readonly ConflictView[];
  /** 作者定的天数和记账员记的对不上（设计 2.5）。 */
  readonly timeConflicts: readonly TimeConflictView[];
  /** 时间推了哪几个世界（作者定了换天规矩就只有那一个）。 */
  readonly timeWorlds: readonly TimeWorld[];
  readonly dangling: readonly DanglingView[];
  /** 作者说过「不是问题」的问题键。 */
  readonly dismissedIssues: readonly string[];
}
