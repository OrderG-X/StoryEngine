/**
 * 投影：全部从真相（章节账单 + 作者裁定 + 正文）算出来，随时可重算，不另存。
 * 界面、核账员、对话 AI 读的都是这一份。里面的 id 只给程序用，展示时一律换成名字 / 标题。
 */
import type { FactNature, ReviewMark, ThreadType, TimeBasis } from "../schema/ledger.js";

export interface ChapterView {
  readonly chapter: number;
  readonly origin: "commit" | "import";
  readonly committedAt: string;
  readonly summary?: string;
  /** 故事第几天（从 1 起）。 */
  readonly day: number;
  /** 本章结束时是第几天。 */
  readonly dayEnd: number;
  /** 天数的依据；missing = 账单里没有时间，投影按上一章 +1 估的（要请作者确认）。 */
  readonly dayBasis: TimeBasis | "missing";
  /** 0 = 周一 … 6 = 周日。 */
  readonly weekday?: number;
  /** 星期是从最近一个明写的星期推出来的。 */
  readonly weekdayDerived: boolean;
  readonly timeOfDay?: string;
  /** 出场人物（已确立名字）。 */
  readonly present: readonly string[];
  readonly viewpoint?: string;
  /** 定稿后正文被改过（和账单记的 sha256 对不上）。正文文件不在时为 undefined。 */
  readonly editedSinceCommit?: boolean;
  readonly textMissing: boolean;
}

export type FactStatus = "current" | "superseded" | "retracted";

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
}

export interface ThreadView {
  readonly id: string;
  readonly type: ThreadType;
  readonly title: string;
  readonly openedAt: number;
  readonly lastTouchedAt: number;
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
  readonly dangling: readonly DanglingView[];
  /** 作者说过「不是问题」的问题键。 */
  readonly dismissedIssues: readonly string[];
}
