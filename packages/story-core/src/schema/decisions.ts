/**
 * 作者裁定（真相之三）：作者亲手做的、不属于某一章账单的决定，按时间顺序存在 `ledger/decisions.json`。
 *
 * 只能由作者档的命令写（界面按钮），AI 永远写不进来。投影最后一步按顺序套用这些裁定。
 * 设定卡（身份、年龄、规则这类不变属性）也是作者裁定，留在旧文件里，后面几期再搬。
 */
import { z } from "zod";

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
};
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
]).refine((value) => value.type !== "fact.assert" || structured(value), { message: STRUCTURE_MESSAGE });
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
]).refine((value) => value.type !== "fact.assert" || structured(value), { message: STRUCTURE_MESSAGE });
export type AuthorDecision = z.infer<typeof AuthorDecision>;

export const AuthorDecisionsFile = z.object({
  schema: z.literal(AUTHOR_DECISIONS_SCHEMA),
  decisions: z.array(AuthorDecision),
});
export type AuthorDecisionsFile = z.infer<typeof AuthorDecisionsFile>;
