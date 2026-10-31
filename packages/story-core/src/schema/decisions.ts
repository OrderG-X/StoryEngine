/**
 * 作者裁定（真相之三）：作者亲手做的、不属于某一章账单的决定，按时间顺序存在 `ledger/decisions.json`。
 *
 * 只能由作者档的命令写（界面按钮），AI 永远写不进来。投影最后一步按顺序套用这些裁定。
 * 设定卡（身份、年龄、规则这类不变属性）也是作者裁定，留在旧文件里，后面几期再搬。
 */
import { z } from "zod";
import { CensusMember, ItemGone, ItemPlace, itemLinks } from "./ledger.js";

export const AUTHOR_DECISIONS_SCHEMA = "author-decisions/1" as const;

const text = z.string().trim().min(1);

/** 把几条线索归成一条（「像同一件事」）。from 里的线索并进 into，之后指向 from 的推进都算到 into 上。 */
const threadMerge = { type: z.literal("thread.merge"), from: z.array(text).min(1), into: text };
/** 作者说这条线索其实在第 chapter 章收了。 */
const threadClose = { type: z.literal("thread.close"), thread: text, chapter: z.number().int().min(1), note: text.optional() };
/** 线索的分量：major 不许丢；minor 停多久都不提醒。 */
const threadWeight = { type: z.literal("thread.weight"), thread: text, weight: z.enum(["major", "normal", "minor"]) };
/** 作者说核账员报的这条「不是问题」。issue 是问题的确定性键，由出问题的一方给。 */
const issueDismiss = { type: z.literal("issue.dismiss"), issue: text, note: text.optional() };
/** 作者说这条事实记错了：投影里作废，原账单不动。 */
const factRetract = { type: z.literal("fact.retract"), fact: text, note: text.optional() };
/** 作者说这条事实从第 chapter 章起不再成立（没有新说法顶替）。老书里手动作废的事实导入成这个。 */
const factExpire = { type: z.literal("fact.expire"), fact: text, chapter: z.number().int().min(1), note: text.optional() };
/** 作者改一章的故事天数（定稿后才发现记错了）：第 day 天（到第 dayEnd 天，这一章跨天时）。顶掉那章账单里记的。 */
const chapterDay = {
  type: z.literal("chapter.day"),
  chapter: z.number().int().min(1),
  day: z.number().int().min(1),
  dayEnd: z.number().int().min(1).optional(),
};
/** 作者改写一章的梗概（定稿后才发现记账员写偏了）：顶掉那章账单里记的。是作者说的，没有原句。 */
const chapterSummary = { type: z.literal("chapter.summary"), chapter: z.number().int().min(1), text };
const dayOrdered = (value: { type: string; day?: number; dayEnd?: number }): boolean =>
  value.type !== "chapter.day" || value.dayEnd === undefined || value.day === undefined || value.dayEnd >= value.day;
const DAY_MESSAGE = "到第几天不能比第几天早";
/**
 * 作者补记（或改写）一条事实，算在第 chapter 章（那章之后、下一章之前生效）。没有原句：是作者说的，不是正文写的。
 * corrects = 改写的是哪条（那条随之作废）。hard / state 必须写清谁、哪方面、是什么，和账单里的事实同一个规矩。
 */
const factAssertShape = {
  type: z.literal("fact.assert"),
  chapter: z.number().int().min(1),
  nature: z.enum(["hard", "state", "event"]),
  subject: text.optional(),
  attribute: text.optional(),
  value: text.optional(),
  text,
  corrects: text.optional(),
  note: text.optional(),
  /** 主体是一样东西（P3b）：东西编号。改后的那条还挂在那样东西上，不按名字重新认。 */
  subjectId: text.optional(),
};
/**
 * 东西（写作版本 P3b 设计 2.7）。item.merge：这几样是同一样（账里这样就是卡上那样也是它）——账里所有位置指 from 的都算 into。
 * item.split：这几处说的不是那一样（refs 精确到哪条的哪个位置），是另一样东西（名字 name，编号 `x-<裁定号>`）。
 * item.retract：记账员这条东西条目记错了（不算）。item.state：到第 chapter 章末它在哪 / 丢了还是毁了 / 里面是什么（作者定的，压过那章记的）。
 */
const itemMerge = { type: z.literal("item.merge"), from: z.array(text).min(1), into: text, note: text.optional() };
export const ItemPosition = z.object({ entry: text, at: z.enum(["item", "to", "from", "member", "subject"]), index: z.number().int().min(0).optional() });
export type ItemPosition = z.infer<typeof ItemPosition>;
const itemSplit = { type: z.literal("item.split"), item: text, refs: z.array(ItemPosition).min(1), name: text, note: text.optional() };
const itemRetract = { type: z.literal("item.retract"), entry: text, note: text.optional() };
export const ItemStateRuling = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("at"), to: ItemPlace }),
  z.object({ kind: z.literal("gone"), gone: ItemGone }),
  z.object({ kind: z.literal("census"), members: z.array(CensusMember), complete: z.boolean() }),
]);
export type ItemStateRuling = z.infer<typeof ItemStateRuling>;
/** 作者定的去处关联的旧记法事实，逐样：at / gone 关联裁定那样东西，清点关联各成员。 */
export function itemStateLinksOf(decision: {
  readonly item: string;
  readonly state: ItemStateRuling;
  readonly replaces?: readonly string[];
  readonly overlaps?: readonly string[];
}): readonly { readonly item: string; readonly replaces: readonly string[]; readonly overlaps: readonly string[] }[] {
  const own = decision.replaces || decision.overlaps ? [{ item: decision.item, replaces: decision.replaces ?? [], overlaps: decision.overlaps ?? [] }] : [];
  const members = decision.state.kind === "census"
    ? decision.state.members.flatMap((member) => (member.replaces || member.overlaps ? [{ item: member.id, replaces: member.replaces ?? [], overlaps: member.overlaps ?? [] }] : []))
    : [];
  return [...own, ...members];
}
/** at / gone 的旧记法关联挂在裁定上（关联 item）；清点的挂在各成员上（设计 2.6、2.7）。 */
const itemState = { type: z.literal("item.state"), item: text, chapter: z.number().int().min(1), state: ItemStateRuling, ...itemLinks, note: text.optional() };
const structured = (value: { nature: string; subject?: string; attribute?: string; value?: string }): boolean =>
  value.nature === "event" || Boolean(value.subject && value.attribute && value.value);
const STRUCTURE_MESSAGE = "不会变的事实和状态必须写清谁、哪方面、是什么";

export const DecisionInput = z.discriminatedUnion("type", [
  z.object(threadMerge),
  z.object(threadClose),
  z.object(threadWeight),
  z.object(issueDismiss),
  z.object(factRetract),
  z.object(factExpire),
  z.object(factAssertShape),
  z.object(chapterDay),
  z.object(chapterSummary),
  z.object(itemMerge),
  z.object(itemSplit),
  z.object(itemRetract),
  z.object(itemState),
]).refine((value) => value.type !== "fact.assert" || structured(value), { message: STRUCTURE_MESSAGE })
  .refine(dayOrdered, { message: DAY_MESSAGE });
export type DecisionInput = z.infer<typeof DecisionInput>;

const meta = { id: text, at: text };
export const AuthorDecision = z.discriminatedUnion("type", [
  z.object({ ...threadMerge, ...meta }),
  z.object({ ...threadClose, ...meta }),
  z.object({ ...threadWeight, ...meta }),
  z.object({ ...issueDismiss, ...meta }),
  z.object({ ...factRetract, ...meta }),
  z.object({ ...factExpire, ...meta }),
  z.object({ ...factAssertShape, ...meta }),
  z.object({ ...chapterDay, ...meta }),
  z.object({ ...chapterSummary, ...meta }),
  z.object({ ...itemMerge, ...meta }),
  z.object({ ...itemSplit, ...meta }),
  z.object({ ...itemRetract, ...meta }),
  z.object({ ...itemState, ...meta }),
]).refine((value) => value.type !== "fact.assert" || structured(value), { message: STRUCTURE_MESSAGE })
  .refine(dayOrdered, { message: DAY_MESSAGE });
export type AuthorDecision = z.infer<typeof AuthorDecision>;

export const AuthorDecisionsFile = z.object({
  schema: z.literal(AUTHOR_DECISIONS_SCHEMA),
  decisions: z.array(AuthorDecision),
});
export type AuthorDecisionsFile = z.infer<typeof AuthorDecisionsFile>;
