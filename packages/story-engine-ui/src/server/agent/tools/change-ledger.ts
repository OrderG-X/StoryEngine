/**
 * change_ledger —— 改账（写作版本 P2a 片 3B；收编 manage_ledger）。和别的提交工具一样只交意图：
 * 宽进归一 → 交给执行器（ledger.change）→ 回受理回执，受理了这一轮就停。改账是作者的决定：这里交的只是提议，
 * 服务端算好要改哪几笔、出「确认改账」卡，作者点了才记（改前存档、可撤销）；查不准指的是哪条的如实列出来。
 * 理线索（review）：记账员按全书判开着的线索收没收、点出收口原句，收了的同样等作者点。
 */
import { createTool, type ToolExecutionContext } from "@mastra/core/tools";
import { z } from "zod";
import { blankToUndefined, coerceBoolean, coerceEnum, coerceJsonArray, coerceNumber } from "../../lib/lenient-args.js";
import { submitOperation } from "../../services/operations/executor.js";
import { LEDGER_OPS } from "../../services/ledger-change/plan.js";
import { LEDGER_CHANGE_KIND, MAX_LEDGER_CHANGES } from "../../services/operations/recipes/ledger-change.js";
import { readMessageRefFromContext, readProjectDirFromContext } from "../request-context.js";
import { receiptOf, type SubmitReceipt } from "./op-tools.js";

const groupList = z.array(z.union([z.string(), z.array(z.string())]));

const changeSchema = z.object({
  // 模型无关：枚举大小写宽容（模型常传 "Add"/"REMOVE"）。
  op: coerceEnum(z.enum(LEDGER_OPS).describe(
    "事实：add 补记；update 改写（id 或 targetText + text）；remove 删掉记错的（id 或 targetText）；supersede=某事实从某章起不再成立（id 或 targetText + chapter）。" +
      "线索：resolve=记为已收（query 或 id）；group=归并讲同一件事的几条（groups）；importance=定大伏笔 / 小线索（id 或 query + importance）。" +
      "天数：day=改已定稿某章是故事第几天（chapter + day；作者说了到第几天才给 dayEnd）。" +
      "梗概：summary=改写已定稿某章的梗概（chapter + text，text 是整条新梗概）。",
  )),
  id: blankToUndefined(z.string().optional().describe("事实或线索的编号（read_state_overview 里取）。别念给作者听。")),
  chapter: coerceNumber(z.number().int().positive().optional().describe(
    "add：算在第几章（缺省=最新定稿章）；supersede：从第几章起不再成立；resolve：在第几章收的（缺省=最新定稿章）；day / summary：改哪一章（缺省=最新定稿章）。",
  )),
  text: blankToUndefined(z.string().optional().describe("add / update 的事实内容（一句话、具体可核对）；summary 的整条新梗概。")),
  targetText: blankToUndefined(z.string().optional().describe("不知道编号时，用那条事实的原话或关键词指认（对上多条会如实请作者说清）。")),
  query: blankToUndefined(z.string().optional().describe("resolve / importance：线索的标题或关键词。")),
  importance: coerceEnum(z.enum(["major", "normal", "minor"]).optional().describe("importance：major=大伏笔（不许丢），minor=小线索（停多久都不提醒），normal=普通。")),
  nature: coerceEnum(z.enum(["hard", "state", "event"]).optional().describe(
    "add：hard=不会变的（年龄、门牌）；state=会变的状态（在哪、在谁手里）；event=发生过的事。hard / state 要同时给 subject、attribute、value。",
  )),
  subject: blankToUndefined(z.string().optional().describe("add：谁 / 什么（hard、state 必填）。")),
  attribute: blankToUndefined(z.string().optional().describe("add：哪方面（如「年纪」「在哪」）。")),
  value: blankToUndefined(z.string().optional().describe("add / update：是什么。")),
  day: coerceNumber(z.number().int().positive().optional().describe("day：这一章是故事第几天。")),
  dayEnd: coerceNumber(z.number().int().positive().optional().describe("day：作者说的这一章到故事第几天。只说了开头就不给（结尾按这章里换天推）；作者说就这一天，给和 day 一样。")),
  groups: coerceJsonArray(groupList.optional().describe(
    "group：几组线索（标题或编号），每组第一条留下、其余并进去，如 [[\"钟为什么停\",\"钟楼的钟停了\"]]。只有一组也可以直接给一个数组。",
  )),
});

const inputSchema = z.object({
  changes: coerceJsonArray(z.array(changeSchema).max(MAX_LEDGER_CHANGES).optional().describe("要改的几笔账，一项一笔（作者一句话里说了几处就给几项）。")),
  review: coerceBoolean(z.boolean().optional().describe(
    "true=把开着的线索理一遍：记账员按全书判哪些其实已经收了、点出收口原句（作者说理一下线索、看看哪些收了时用，不带 changes）。",
  )),
});

type Change = z.infer<typeof changeSchema>;

/** 只有一组时模型常直接给一个字符串数组：当成一组。 */
function normalizeGroups(value: Change["groups"]): string[][] {
  if (!value || value.length === 0) return [];
  if (value.every((item) => typeof item === "string")) return [value as string[]];
  return value.map((item) => (typeof item === "string" ? [item] : item));
}

const normalizeChange = (change: Change): Record<string, unknown> => {
  const { groups, ...rest } = change;
  return { ...Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined)), ...(change.op === "group" ? { groups: normalizeGroups(groups) } : {}) };
};

export const changeLedgerTool = createTool({
  id: "change_ledger",
  description:
    "改账（事实的补记 / 改写 / 删掉 / 标不再成立；线索的记为已收 / 归并 / 定大小；已定稿某章的故事天数、梗概），或理一遍开着的线索（review）。" +
    "改账是作者的决定：交出去不会马上改，服务端算好要改的几笔、给作者出「确认改账」卡，作者点了才记（改前存档、可撤销）。" +
    "作者一句话里要改几处就一次交几项 changes。只在作者明说要改账、理线索时调；作者没说过的决定不要替作者做。" +
    "交出去服务端就按固定步骤做，这一轮到此为止：要改的哪几笔、要作者点的卡都由系统接着说，你不用再说，绝不说『已改好』。一条作者消息只交一件事。",
  inputSchema,
  execute: async (input: z.infer<typeof inputSchema>, context: ToolExecutionContext): Promise<SubmitReceipt> => {
    const bookDir = readProjectDirFromContext(context);
    if (!bookDir) return { ok: false, code: "no_book", summary: "没有打开的书，交不了。" };
    const ref = readMessageRefFromContext(context);
    if (!ref) return { ok: false, code: "no_message_ref", summary: "这条消息没带消息号，交不了：请作者刷新页面后再说一次。" };
    const changes = (input.changes ?? []).map(normalizeChange);
    // 有要改的就改（review 顺手带了个 true 也不当理线索）；什么都没给如实说。
    const mode = changes.length > 0 ? "edit" : input.review ? "review" : undefined;
    if (!mode) return { ok: false, code: "bad_params", summary: "没说要改哪几笔账，也没说要理线索。" };
    const outcome = await submitOperation(bookDir, {
      kind: LEDGER_CHANGE_KIND,
      mode,
      params: mode === "edit" ? { changes } : {},
      requestKey: `chat:${ref.messageId}`,
      issuedAt: ref.issuedAt,
      origin: { kind: "chat", messageId: ref.messageId },
    });
    return receiptOf(outcome, "chat", { kind: LEDGER_CHANGE_KIND, mode });
  },
});
