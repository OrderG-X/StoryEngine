/**
 * manage_ledger —— 改账一个入口（重构 P3 起：改账是作者裁定，你只能提议）。
 *
 * 你调它不会改任何东西：它把要改的翻成裁定草案、查准指向哪条事实 / 线索（查不准就如实说、列候选），
 * 然后界面给作者出「确认改账」按钮，作者点了才记（改前自动存档、可撤销）。见 ../ledger-decisions.ts。
 */
import { createTool } from "@mastra/core/tools";
import type { ToolExecutionContext } from "@mastra/core/tools";
import { z } from "zod";

import { planLedgerChange, type LedgerChangeRequest } from "../ledger-decisions.js";
import { readProjectDirFromContext } from "../request-context.js";
import { blankToUndefined, coerceEnum, coerceJsonArray, coerceNumber } from "../../lib/lenient-args.js";

export const LEDGER_OPS = ["add", "update", "remove", "supersede", "resolve", "clean", "group", "importance", "day"] as const;
export type LedgerOp = (typeof LEDGER_OPS)[number];

const groupList = z.array(z.union([z.string(), z.array(z.string())]));

const inputSchema = z.object({
  // 模型无关：枚举大小写宽容（模型常传 "Add"/"REMOVE"）。
  op: coerceEnum(z.enum(LEDGER_OPS).describe(
    "事实：add 补记；update 改写（id 或 targetText + text）；remove 删掉记错的（id 或 targetText）；supersede=某事实从某章起不再成立（id 或 targetText + chapter）。" +
      "线索：resolve=记为已收（query 或 id）；group=归并讲同一件事的几条（groups）；importance=定大伏笔 / 小线索（id 或 query + importance）。" +
      "天数：day=改已定稿某章是故事第几天（chapter + day，这一章跨天再给 dayEnd）。",
  )),
  id: blankToUndefined(z.string().optional().describe("事实或线索的编号（read_state_overview 里取）。别念给作者听。")),
  chapter: coerceNumber(z.number().int().positive().optional().describe(
    "add：算在第几章（缺省=最新定稿章）；supersede：从第几章起不再成立；resolve：在第几章收的（缺省=最新定稿章）。",
  )),
  text: blankToUndefined(z.string().optional().describe("add / update 的事实内容（一句话、具体可核对）。")),
  targetText: blankToUndefined(z.string().optional().describe("不知道编号时，用那条事实的原话或关键词指认（对上多条会如实请你说清）。")),
  query: blankToUndefined(z.string().optional().describe("resolve / importance：线索的标题或关键词。")),
  importance: coerceEnum(z.enum(["major", "normal", "minor"]).optional().describe("importance：major=大伏笔（不许丢），minor=小线索（停多久都不提醒），normal=普通。")),
  nature: coerceEnum(z.enum(["hard", "state", "event"]).optional().describe(
    "add：hard=不会变的（年龄、门牌）；state=会变的状态（在哪、在谁手里）；event=发生过的事。hard / state 要同时给 subject、attribute、value。",
  )),
  subject: blankToUndefined(z.string().optional().describe("add：谁 / 什么（hard、state 必填）。")),
  attribute: blankToUndefined(z.string().optional().describe("add：哪方面（如「年纪」「在哪」）。")),
  value: blankToUndefined(z.string().optional().describe("add / update：是什么。")),
  day: coerceNumber(z.number().int().positive().optional().describe("day：这一章是故事第几天。")),
  dayEnd: coerceNumber(z.number().int().positive().optional().describe("day：这一章到故事第几天（跨天才给；不跨就不给或和 day 一样）。")),
  groups: coerceJsonArray(groupList.optional().describe(
    "group：几组线索（标题或编号），每组第一条留下、其余并进去，如 [[\"钟为什么停\",\"钟楼的钟停了\"]]。只有一组也可以直接给一个数组。",
  )),
});

const outputSchema = z.object({
  ok: z.boolean().describe("恒为 false：你调它不会改账。needsConfirmation=true 时界面已出「确认改账」按钮。"),
  op: z.string(),
  needsConfirmation: z.boolean().optional(),
  blockedReason: z.string().optional(),
  summary: z.string().describe("给作者看的结论。"),
  ledgerConfirm: z.object({
    key: z.string(),
    label: z.string(),
    decisions: z.array(z.unknown()),
    lines: z.array(z.string()),
  }).optional().describe("「确认改账」按钮带的东西（界面用，你不用转述）。"),
});

function normalizeGroups(value: z.infer<typeof groupList> | undefined): string[][] {
  if (!value || value.length === 0) return [];
  if (value.every((item) => typeof item === "string")) return [value as string[]];
  return value.map((item) => (typeof item === "string" ? [item] : item));
}

export async function runManageLedger(projectDir: string, input: z.infer<typeof inputSchema>): Promise<z.infer<typeof outputSchema>> {
  const request: LedgerChangeRequest = {
    op: input.op,
    ...(input.id ? { id: input.id } : {}),
    ...(input.chapter ? { chapter: input.chapter } : {}),
    ...(input.text ? { text: input.text } : {}),
    ...(input.targetText ? { targetText: input.targetText } : {}),
    ...(input.query ? { query: input.query } : {}),
    ...(input.importance ? { importance: input.importance } : {}),
    ...(input.nature ? { nature: input.nature } : {}),
    ...(input.subject ? { subject: input.subject } : {}),
    ...(input.attribute ? { attribute: input.attribute } : {}),
    ...(input.value ? { value: input.value } : {}),
    ...(input.op === "group" ? { groups: normalizeGroups(input.groups) } : {}),
    ...(input.day ? { day: input.day } : {}),
    ...(input.dayEnd ? { dayEnd: input.dayEnd } : {}),
  };
  const plan = await planLedgerChange(projectDir, request);
  if (!plan.ok) return { ok: false, op: input.op, blockedReason: plan.code, summary: `没改账：${plan.reason}` };
  const lines = plan.lines;
  return {
    ok: false,
    op: input.op,
    needsConfirmation: true,
    blockedReason: "awaiting_user_confirmation",
    summary: `要改的账：${lines.join("；")}。还没改——请点「确认改账」按钮（改前自动存档，可撤销）。`,
    ledgerConfirm: { key: plan.key, label: lines[0] ?? "改账", decisions: [...plan.decisions], lines: [...lines] },
  };
}

export const manageLedgerTool = createTool({
  id: "manage_ledger",
  description:
    "改账（事实的补记 / 改写 / 删掉 / 标不再成立；线索的记为已收 / 归并 / 定大小；已定稿某章的故事天数，op 见参数）。改账是作者的决定：" +
    "你调它不会改任何东西，它给作者出「确认改账」按钮，作者点了才改；一轮里调几次，界面合成一个按钮，点一次全记。调完告诉作者点按钮，绝不说『已改好』。" +
    "只在作者明说要改账时调；作者没说过的决定不要替作者做。",
  inputSchema,
  outputSchema,
  execute: async (input: z.infer<typeof inputSchema>, context: ToolExecutionContext) => {
    const projectDir = readProjectDirFromContext(context);
    if (!projectDir) throw new Error("manage_ledger 缺少 projectDir：请确认调用 agent 时通过 RequestContext 注入了 projectDir。");
    return runManageLedger(projectDir, input);
  },
});
