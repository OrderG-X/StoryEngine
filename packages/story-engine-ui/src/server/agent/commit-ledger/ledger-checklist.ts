/**
 * 定稿前的「账本变化清单」（2026-10-10 重新设计「AI 记账、作者核账」第 2 期）。
 *
 * 定稿预览时把这一章会往账本里写的东西逐条列成人话：硬事实、旧事实改记、伏笔 / 线索 / 目标的新开·推进·收回、
 * 本章记为故事第几天。作者去掉不对的，定稿时这些条目不写（伏笔线索目标从计划里拿掉，事实不入账）。
 * 和旧设定对不上的、新出现的人物只提示，不写账本，所以不能勾。
 *
 * 条目 id 稳定：伏笔 / 线索 / 目标用引擎的 id（标题哈希，同一版草稿重算一致）；事实按内容短哈希、改记按旧事实 id。
 */
import { factKey, type FactProposal, type FactProposalExclusions } from "../fact-ledger/reconcile-facts.js";

export type LedgerChecklistKind = "fact" | "change" | "hook" | "thread" | "goal" | "day" | "conflict" | "new_character" | "fact_failed";

export interface LedgerChecklistItem {
  readonly id: string;
  readonly kind: LedgerChecklistKind;
  /** 一行人话：「新伏笔：《……》」「记下：……」。 */
  readonly label: string;
  /** 依据（本章原句）。 */
  readonly detail?: string;
  /** 作者能不能去掉（只提示、不写账本的条目不能勾）。 */
  readonly removable: boolean;
  /** 作者能改的值（目前只有「第几天」）：界面给输入框，改了随「确认定稿」带上。 */
  readonly editableDay?: number;
  /** 引擎没把握、要作者确认（如没在正文里找到时间说法，天数是按上一章 +1 估的）。 */
  readonly needsConfirm?: boolean;
}

/** 本章在故事时间线上的位置（引擎 BuildCommitPlanResult.timelineEntry + 格式化好的「故事第 N 天（周X）」）。 */
export interface ChecklistTimeLike {
  readonly day: number;
  readonly label: string;
  readonly source: string;
  readonly quote?: string;
}

interface TrackingUpdateLike {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly firstSeenChapter: number;
  readonly evidence?: readonly string[];
  readonly type?: string;
}

/** 计划里和清单有关的部分（引擎 commitPlan 的子集，宽进）。 */
export interface ChecklistPlanLike {
  readonly hookTrackingUpdates?: readonly TrackingUpdateLike[];
  readonly threadTrackingUpdates?: readonly TrackingUpdateLike[];
  readonly arcGoalUpdates?: readonly TrackingUpdateLike[];
  readonly calendar?: { readonly storyDay?: number };
}

const MAX_DETAIL = 80;
const clip = (text: string | undefined): string | undefined => {
  const trimmed = text?.replace(/\s+/gu, " ").trim();
  if (!trimmed) return undefined;
  return trimmed.length > MAX_DETAIL ? `${trimmed.slice(0, MAX_DETAIL)}…` : trimmed;
};

function trackingVerb(update: TrackingUpdateLike, chapter: number, done: readonly string[]): "新" | "推进" | "收回" {
  if (done.includes(update.status)) return "收回";
  return update.firstSeenChapter === chapter ? "新" : "推进";
}

export function buildLedgerChecklist(input: {
  readonly chapter: number;
  readonly plan: ChecklistPlanLike | undefined;
  readonly facts?: FactProposal;
  /** 故事时间线上的位置；缺省时退回计划里的日历天数（老调用方）。 */
  readonly time?: ChecklistTimeLike;
  /** 事实文字的显示换算（日子按时间线换）；条目 id 仍按原文算，作者改了天数也认得出勾掉的是哪条。 */
  readonly displayFact?: (text: string) => string;
}): readonly LedgerChecklistItem[] {
  const show = input.displayFact ?? ((text: string) => text);
  const { chapter, plan, facts } = input;
  const items: LedgerChecklistItem[] = [];
  if (input.time) {
    const guessed = input.time.source === "fallback";
    const why = guessed
      ? "（正文里没找到时间说法，按上一章的第二天估的，不对就改）"
      : input.time.source === "author" ? "（你定的）" : "";
    items.push({
      id: "day",
      kind: "day",
      label: `这一章记为${input.time.label}${why}`,
      ...(input.time.quote ? { detail: clip(input.time.quote) } : {}),
      removable: false,
      editableDay: input.time.day,
      ...(guessed ? { needsConfirm: true } : {}),
    });
  } else {
    const storyDay = plan?.calendar?.storyDay;
    if (typeof storyDay === "number" && storyDay > 0) {
      items.push({ id: "day", kind: "day", label: `这一章记为故事第 ${storyDay} 天`, removable: false });
    }
  }
  for (const update of plan?.hookTrackingUpdates ?? []) {
    const verb = trackingVerb(update, chapter, ["resolved"]);
    items.push({
      id: `hook:${update.id}`,
      kind: "hook",
      label: `${verb === "新" ? "新伏笔" : verb === "收回" ? "收回伏笔" : "推进伏笔"}：${update.title}`,
      ...(clip(update.evidence?.at(-1)) ? { detail: clip(update.evidence?.at(-1)) } : {}),
      removable: true,
    });
  }
  for (const update of plan?.threadTrackingUpdates ?? []) {
    const noun = update.type === "intent" ? "人物打算" : "线索";
    const verb = trackingVerb(update, chapter, ["done"]);
    items.push({
      id: `thread:${update.id}`,
      kind: "thread",
      label: `${verb === "新" ? `新${noun}` : verb === "收回" ? `了结${noun}` : `推进${noun}`}：${update.title}`,
      ...(clip(update.evidence?.at(-1)) ? { detail: clip(update.evidence?.at(-1)) } : {}),
      removable: true,
    });
  }
  for (const update of plan?.arcGoalUpdates ?? []) {
    const verb = trackingVerb(update, chapter, ["completed"]);
    items.push({
      id: `goal:${update.id}`,
      kind: "goal",
      label: `${verb === "新" ? "新目标" : verb === "收回" ? "完成目标" : "推进目标"}：${update.title}`,
      ...(clip(update.evidence?.at(-1)) ? { detail: clip(update.evidence?.at(-1)) } : {}),
      removable: true,
    });
  }
  if (facts?.ok) {
    for (const fact of facts.adds) {
      items.push({ id: `fact:${factKey(fact.text)}`, kind: "fact", label: `记下：${show(fact.text)}`, ...(clip(fact.quote) ? { detail: clip(fact.quote) } : {}), removable: true });
    }
    for (const change of facts.changes) {
      items.push({
        id: `change:${change.factId}`,
        kind: "change",
        label: `改记：「${change.oldText}」→「${show(change.newText)}」`,
        ...(clip(change.quote) ? { detail: clip(change.quote) } : {}),
        removable: true,
      });
    }
    facts.conflicts.forEach((conflict, index) => {
      items.push({
        id: `conflict:${index}`,
        kind: "conflict",
        label: `和旧设定对不上（账本不动，你定）：${conflict.old}`,
        ...(clip(conflict.quote) ? { detail: clip(conflict.quote) } : {}),
        removable: false,
      });
    });
    if (facts.newCharacters.length > 0) {
      items.push({ id: "new_character", kind: "new_character", label: `新出现的人物（不建卡，要建就说一声）：${facts.newCharacters.join("、")}`, removable: false });
    }
  } else if (facts && !facts.ok) {
    // 事实没抽成：绝不让清单看起来「这章没什么可记的」。定稿时会再抽一次。
    items.push({
      id: "fact_failed",
      kind: "fact_failed",
      label: `这章的事实没抽成${facts.failureSummary ? `（${facts.failureSummary.replace(/^（|）$/gu, "")}）` : ""}，确认定稿时会再抽一次`,
      removable: false,
      needsConfirm: true,
    });
  }
  return items;
}

/** 把作者去掉的条目 id 分到各处：计划里的伏笔 / 线索 / 目标 id，事实的内容短哈希 / 旧事实 id。 */
export function splitExclusions(excluded: readonly string[]): {
  readonly hookIds: ReadonlySet<string>;
  readonly threadIds: ReadonlySet<string>;
  readonly goalIds: ReadonlySet<string>;
  readonly facts: FactProposalExclusions;
} {
  const hookIds = new Set<string>();
  const threadIds = new Set<string>();
  const goalIds = new Set<string>();
  const adds = new Set<string>();
  const changes = new Set<string>();
  for (const raw of excluded) {
    const [kind, ...rest] = raw.split(":");
    const value = rest.join(":");
    if (!value) continue;
    if (kind === "hook") hookIds.add(value);
    else if (kind === "thread") threadIds.add(value);
    else if (kind === "goal") goalIds.add(value);
    else if (kind === "fact") adds.add(value);
    else if (kind === "change") changes.add(value);
  }
  return { hookIds, threadIds, goalIds, facts: { adds, changes } };
}

interface PlanWithHooks {
  readonly hookTrackingUpdates?: readonly { readonly id: string }[];
  readonly threadTrackingUpdates?: readonly { readonly id: string }[];
  readonly arcGoalUpdates?: readonly { readonly id: string }[];
  readonly hookUpdates?: readonly { readonly hookId: string }[];
  readonly worldUpdates?: { readonly activeHooks?: readonly string[] };
}

/**
 * 从定稿计划里拿掉作者去掉的伏笔 / 线索 / 目标：对应的跟踪更新不写，伏笔的状态更新和「活跃伏笔」里也去掉。
 * 没有要去掉的就原样返回。
 */
export function excludeFromCommitPlan<T extends PlanWithHooks>(plan: T, exclusions: ReturnType<typeof splitExclusions>): T {
  const { hookIds, threadIds, goalIds } = exclusions;
  if (hookIds.size === 0 && threadIds.size === 0 && goalIds.size === 0) return plan;
  const keep = <U extends { readonly id: string }>(list: readonly U[] | undefined, drop: ReadonlySet<string>) =>
    list?.filter((item) => !drop.has(item.id));
  const worldUpdates = plan.worldUpdates?.activeHooks
    ? { ...plan.worldUpdates, activeHooks: plan.worldUpdates.activeHooks.filter((id) => !hookIds.has(id)) }
    : plan.worldUpdates;
  return {
    ...plan,
    ...(plan.hookTrackingUpdates ? { hookTrackingUpdates: keep(plan.hookTrackingUpdates, hookIds) } : {}),
    ...(plan.threadTrackingUpdates ? { threadTrackingUpdates: keep(plan.threadTrackingUpdates, threadIds) } : {}),
    ...(plan.arcGoalUpdates ? { arcGoalUpdates: keep(plan.arcGoalUpdates, goalIds) } : {}),
    ...(plan.hookUpdates ? { hookUpdates: plan.hookUpdates.filter((update) => !hookIds.has(update.hookId)) } : {}),
    ...(worldUpdates ? { worldUpdates } : {}),
  };
}
