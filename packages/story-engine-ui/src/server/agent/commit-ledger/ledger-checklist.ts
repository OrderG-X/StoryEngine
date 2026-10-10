/**
 * 定稿前的「账本变化清单」（2026-10-10 重新设计「AI 记账、作者核账」第 2 期）。
 *
 * 定稿预览时把这一章会往账本里写的东西逐条列成人话：硬事实、旧事实改记、伏笔 / 线索 / 目标的新开·推进·收回、
 * 本章记为故事第几天。作者去掉不对的，定稿时这些条目不写（伏笔线索目标从计划里拿掉，事实不入账）。
 * 和旧设定对不上的、新出现的人物只提示，不写账本，所以不能勾。
 *
 * 条目 id 稳定：伏笔 / 线索 / 目标用引擎的 id（标题哈希，同一版草稿重算一致）；事实按提案下标、改记按旧事实 id。
 */
import type { FactProposal, FactProposalExclusions } from "../fact-ledger/reconcile-facts.js";

export type LedgerChecklistKind = "fact" | "change" | "hook" | "thread" | "goal" | "day" | "conflict" | "new_character";

export interface LedgerChecklistItem {
  readonly id: string;
  readonly kind: LedgerChecklistKind;
  /** 一行人话：「新伏笔：《……》」「记下：……」。 */
  readonly label: string;
  /** 依据（本章原句）。 */
  readonly detail?: string;
  /** 作者能不能去掉（只提示、不写账本的条目不能勾）。 */
  readonly removable: boolean;
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
}): readonly LedgerChecklistItem[] {
  const { chapter, plan, facts } = input;
  const items: LedgerChecklistItem[] = [];
  const storyDay = plan?.calendar?.storyDay;
  if (typeof storyDay === "number" && storyDay > 0) {
    items.push({ id: "day", kind: "day", label: `这一章记为故事第 ${storyDay} 天`, removable: false });
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
    facts.adds.forEach((fact, index) => {
      items.push({ id: `fact:${index}`, kind: "fact", label: `记下：${fact.text}`, ...(clip(fact.quote) ? { detail: clip(fact.quote) } : {}), removable: true });
    });
    for (const change of facts.changes) {
      items.push({
        id: `change:${change.factId}`,
        kind: "change",
        label: `改记：「${change.oldText}」→「${change.newText}」`,
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
  }
  return items;
}

/** 把作者去掉的条目 id 分到各处：计划里的伏笔 / 线索 / 目标 id，事实提案的下标 / 旧事实 id。 */
export function splitExclusions(excluded: readonly string[]): {
  readonly hookIds: ReadonlySet<string>;
  readonly threadIds: ReadonlySet<string>;
  readonly goalIds: ReadonlySet<string>;
  readonly facts: FactProposalExclusions;
} {
  const hookIds = new Set<string>();
  const threadIds = new Set<string>();
  const goalIds = new Set<string>();
  const adds = new Set<number>();
  const changes = new Set<string>();
  for (const raw of excluded) {
    const [kind, ...rest] = raw.split(":");
    const value = rest.join(":");
    if (!value) continue;
    if (kind === "hook") hookIds.add(value);
    else if (kind === "thread") threadIds.add(value);
    else if (kind === "goal") goalIds.add(value);
    else if (kind === "fact" && /^\d+$/u.test(value)) adds.add(Number(value));
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
