/**
 * foundation_write — 对话 AI 改设定本（重构 P9：一批 ops，走核心 card.fill / card.write）。
 *
 *   ops 先在边界归一（模型常传的退化写法：""/[]/"true"/中文类别名）→ 逐条校验 → splitForAi 拆三份：
 *   - AI 能直接做的（建新卡、填空的、改 AI 补的、加别名、列表加项）→ card.fill，可撤销；
 *   - 碰了作者写的（改 / 删作者写的、改名、删卡、换主角）→ 不做，给作者出「确认改设定」按钮，点了走 card.write；
 *   - 指错了 / 格式不对的 → 如实列进「没改成」。
 *
 * 绝不静默失败：summary 只说真做成的；按钮没点之前一个字都没改。
 */
import { createHash } from "node:crypto";
import { createTool } from "@mastra/core/tools";
import type { ToolExecutionContext } from "@mastra/core/tools";
import { z } from "zod";
import {
  applyCardOps,
  CardOp,
  KIND_LABELS,
  MAX_OPS_PER_CHANGE,
  RULE_LIST_LABELS,
  RULE_SCALAR_LABELS,
  readCardsOrLegacy,
  splitForAi,
} from "@actalk/story-core";
import type { SettingCardsFile } from "@actalk/story-core";

import { writeCards } from "../../lib/card-write.js";
import { coerceJsonArray } from "../../lib/lenient-args.js";
import { readProjectDirFromContext } from "../request-context.js";

const OPS_DESCRIPTION = [
  "要做的改动，按顺序做。每项是一个对象，op 选一个：",
  "card.create {kind: character|place|item|lore, name, aliases?, fields?: [{label, value}], protagonist?}：建卡（人物/地点/物品/其他设定）。",
  "field.set {card, label, value}：卡上某一栏写上/改成 value（value 为空串=删这一栏）。栏名自由起，如 外貌、性格、说话方式、在哪、规矩。",
  "card.aliases {card, add?, remove?}：加/删别名。card.rename {card, name}。card.kind {card, kind}。card.delete {card}。card.protagonist {card}：标成主角。",
  "relation.set {a, b, label}：两张人物卡之间的关系（label 为空串=删）。",
  "story.set {label, value}：故事设定的一栏（一句话、题材、世界规矩……；value 为空串=删）。",
  "rules.set {field: perspective|targetWords|minWords|notes, value}：视角 / 每章目标字数 / 每章至少字数 / 补充（null=删）。",
  "rules.add / rules.remove {list: style|musts|bans|avoid, text}：文风 / 一定要做到 / 一定不要写 / 别用的说法 加一条或删一条。",
  "exemplar.add {text, note?}：存一段作者的文风样本。exemplar.remove {exemplar}。",
  "card / a / b 填卡的名字或别名；同一批里前面新建的卡，后面就能用。",
].join("\n");

const inputSchema = z.object({
  ops: coerceJsonArray(z.array(z.record(z.string(), z.unknown())).min(1).max(MAX_OPS_PER_CHANGE)).describe(OPS_DESCRIPTION),
});

const outputSchema = z.object({
  ok: z.boolean().describe("true = 有改动真写进去了，或者全部交给作者确认。"),
  applied: z.array(z.string()).describe("真改了的（只有名字）。"),
  needsConfirmation: z.boolean().optional().describe("有改动碰了作者写的：等作者点「确认改设定」。"),
  foundationConfirm: z.object({ key: z.string(), input: z.record(z.string(), z.unknown()), label: z.string() }).optional(),
  foundationAccept: z.object({ key: z.string(), input: z.record(z.string(), z.unknown()), label: z.string() }).optional()
    .describe("AI 刚写进去的那几处：作者点「认下」就算作者写的（作者口述让 AI 记的，认下后就不显示「AI 补」）。"),
  pending: z.array(z.string()).optional().describe("等作者点头的（只有名字）。"),
  notDone: z.array(z.string()).optional().describe("没改成的和原因。"),
  snapshotId: z.string().optional(),
  refreshScope: z.literal("foundation").optional(),
  summary: z.string(),
});

export type FoundationWriteOutput = z.infer<typeof outputSchema>;

// 类别、规则栏的退化写法 → 正式写法。表里只有自家格式：正式英文名、界面上的中文名、老格式里的类别名。
const KIND_ALIASES: Record<string, string> = {
  ...Object.fromEntries(Object.entries(KIND_LABELS).map(([kind, label]) => [label, kind])),
  location: "place",
  asset: "item",
  world: "lore",
};
const LIST_ALIASES: Record<string, string> = Object.fromEntries(Object.entries(RULE_LIST_LABELS).map(([list, label]) => [label, list]));
const SCALAR_ALIASES: Record<string, string> = Object.fromEntries(Object.entries(RULE_SCALAR_LABELS).map(([field, label]) => [label, field]));
/** 这些键可有可无：模型传了空的就当没传。 */
const OPTIONAL_KEYS = new Set(["aliases", "fields", "protagonist", "add", "remove", "note"]);

function isEmptyValue(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "") || (Array.isArray(value) && value.length === 0);
}

/** 认下是作者的事：漏写 op 时不替模型补成这几种。 */
const NEVER_INFERRED = new Set(["field.accept", "story.accept", "rules.accept"]);
/** 每种改动的键：必填的、允许的（从核心的 CardOp 现取，不另抄一份）。 */
const OP_KEYS = CardOp.options
  .map((option) => {
    const shape = option.shape as Record<string, z.ZodType>;
    const keys = Object.keys(shape).filter((key) => key !== "op");
    return {
      op: (shape.op as z.ZodLiteral<string>).value,
      required: keys.filter((key) => !shape[key]!.safeParse(undefined).success),
      allowed: new Set(keys),
    };
  })
  .filter((item) => !NEVER_INFERRED.has(item.op));

/** 模型漏写 op（GLM 实测头一次常漏）：键刚好只对得上一种改动就补上；对不上、对上好几种都不补，照旧报格式不对。 */
function inferOp(raw: Record<string, unknown>): string | undefined {
  const keys = Object.keys(raw);
  const hits = OP_KEYS.filter((item) => item.required.every((key) => keys.includes(key)) && keys.every((key) => item.allowed.has(key)));
  return hits.length === 1 ? hits[0]!.op : undefined;
}

/** 句法层归一：只动明确的退化写法，语义不猜。 */
export function normalizeRawOp(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (OPTIONAL_KEYS.has(key) && isEmptyValue(value)) continue;
    if (key === "op" && isEmptyValue(value)) continue;
    out[key] = value;
  }
  if (out.op === undefined) {
    const inferred = inferOp(out);
    if (inferred) out.op = inferred;
  }
  if (typeof out.op === "string") out.op = out.op.trim();
  if (typeof out.kind === "string") out.kind = KIND_ALIASES[out.kind.trim()] ?? out.kind.trim().toLowerCase();
  if (typeof out.list === "string") out.list = LIST_ALIASES[out.list.trim()] ?? out.list.trim();
  if (typeof out.field === "string") out.field = SCALAR_ALIASES[out.field.trim()] ?? out.field.trim();
  // 字数写成了故事设定的一栏（栏名正好是写作规则的「每章目标字数 / 每章至少字数」）：搬回写作规则，
  // 不然写作台、出稿都不按它算，AI 却说记好了（换题材长篇实跑 2026-10-27）。只认自家栏名，别的栏不动。
  // 只搬「写上」；空值是删故事设定里那一栏（把记错的那栏清掉），照旧删那一栏，不能当成删写作规则。
  if (out.op === "story.set" && typeof out.label === "string" && !isEmptyValue(out.value)) {
    const field = SCALAR_ALIASES[out.label.trim()];
    if (field === "targetWords" || field === "minWords") {
      delete out.label;
      out.op = "rules.set";
      out.field = field;
    }
  }
  if (out.protagonist === "true" || out.protagonist === "True") out.protagonist = true;
  if (out.protagonist === false || out.protagonist === "false" || out.protagonist === "False") delete out.protagonist;
  for (const key of ["aliases", "add", "remove"] as const) {
    if (typeof out[key] === "string") out[key] = [out[key]];
  }
  if (out.op === "rules.set" && (out.field === "targetWords" || out.field === "minWords") && typeof out.value === "string") {
    const trimmed = out.value.trim();
    out.value = trimmed === "" ? null : /^\d+$/u.test(trimmed) ? Number(trimmed) : out.value;
  }
  if (out.op === "rules.set" && out.value === undefined) out.value = null;
  return out;
}

function describeIssue(index: number, raw: Record<string, unknown>, issue: z.ZodIssue | undefined): string {
  const op = typeof raw.op === "string" ? raw.op : "（没写 op）";
  const where = issue?.path.length ? issue.path.join(".") : "";
  return `第 ${index + 1} 步（${op}）格式不对${where ? `：${where}` : ""}`;
}

function rulesHaveAi(rules: SettingCardsFile["rules"]): boolean {
  const lists = [rules.style, rules.musts, rules.bans, rules.avoid, rules.exemplars];
  const scalars = [rules.perspective, rules.notes, rules.targetWords, rules.minWords];
  return lists.some((list) => list.some((item) => item.by === "ai")) || scalars.some((item) => item?.by === "ai");
}

/**
 * AI 刚直接写进去的那几处对应的「认下」：建卡 / 填栏 → 认下那张卡 / 那一栏；故事设定 → 那一栏；
 * 写作规则只有一个整体认下，所以改前规则里本来就有 AI 补的（作者还没过目）就不带，免得一并认下。
 */
function acceptOpsFor(direct: readonly CardOp[], before: SettingCardsFile): CardOp[] {
  const out = new Map<string, CardOp>();
  const add = (op: CardOp): void => void out.set(JSON.stringify(op), op);
  const wholeCard = new Set(direct.flatMap((op) => (op.op === "card.create" ? [op.name] : [])));
  for (const op of direct) {
    if (op.op === "card.create") add({ op: "field.accept", card: op.name });
    else if (op.op === "field.set" && op.value !== "" && !wholeCard.has(op.card)) add({ op: "field.accept", card: op.card, label: op.label });
    else if (op.op === "story.set" && op.value !== "") add({ op: "story.accept", label: op.label });
    else if ((op.op === "rules.set" || op.op === "rules.add" || op.op === "exemplar.add") && !rulesHaveAi(before.rules)) add({ op: "rules.accept" });
  }
  return [...out.values()];
}

function confirmKey(ops: readonly CardOp[]): string {
  return `card-${createHash("sha256").update(JSON.stringify(ops)).digest("hex").slice(0, 24)}`;
}

export async function foundationWriteLogic(input: { readonly projectDir: string; readonly ops: readonly Record<string, unknown>[] }): Promise<FoundationWriteOutput> {
  const valid: CardOp[] = [];
  const notDone: string[] = [];
  input.ops.forEach((raw, index) => {
    const parsed = CardOp.safeParse(normalizeRawOp(raw));
    if (parsed.success) valid.push(parsed.data);
    else notDone.push(describeIssue(index, raw, parsed.error.issues[0]));
  });

  const at = new Date().toISOString();
  const base = await readCardsOrLegacy(input.projectDir, at);
  const split = splitForAi(base, valid, at);
  const direct = split.direct;
  notDone.push(...split.invalid.map((item) => item.reason));

  let applied: readonly string[] = [];
  let snapshotId: string | undefined;
  if (split.direct.length > 0) {
    const outcome = await writeCards(input.projectDir, { by: "ai", ops: split.direct });
    if (outcome.ok) {
      applied = outcome.lines;
      snapshotId = outcome.snapshotId;
    } else {
      notDone.push(outcome.message);
    }
  }

  // 要作者点头的：按作者身份在「AI 那批改完之后」的样子上试一遍，拿到按钮上的人话；作者身份都做不了的如实列进没改成。
  let confirm: FoundationWriteOutput["foundationConfirm"];
  let pending: readonly string[] = [];
  if (split.needsAuthor.length > 0) {
    const ops = split.needsAuthor.map((item) => item.op);
    const after = await readCardsOrLegacy(input.projectDir, at);
    const dry = applyCardOps(after, ops, { by: "author", at });
    if (dry.ok && dry.lines.length > 0) {
      pending = dry.lines;
      // 按钮回显是「确认改设定：<这里>」，不再带「改设定：」前缀。
      confirm = { key: confirmKey(ops), input: { ops }, label: `${dry.lines[0]}${dry.lines.length > 1 ? ` 等 ${dry.lines.length} 处` : ""}` };
    } else if (!dry.ok) {
      notDone.push(`要你点头的那几处也做不了：${dry.message}`);
    }
  }

  // AI 直接写进去的：给作者一个「认下」（作者口述让 AI 记的，点了就算作者写的）。要作者点头的那批还没做，不和它搅在一起。
  let accept: FoundationWriteOutput["foundationAccept"];
  if (applied.length > 0 && !confirm) {
    const ops = acceptOpsFor(direct, base);
    const after = ops.length > 0 ? await readCardsOrLegacy(input.projectDir, at) : undefined;
    const dry = after ? applyCardOps(after, ops, { by: "author", at }) : undefined;
    if (dry?.ok && dry.lines.length > 0) accept = { key: confirmKey(ops), input: { ops }, label: "刚写的这几处" };
  }

  const parts = [
    applied.length > 0 ? `改好了：${applied.join("；")}。` : undefined,
    accept ? "这几处标着「AI 补」，点「认下」就算你写的。" : undefined,
    pending.length > 0 ? `这几处碰了你写的，要你点「确认改设定」才改：${pending.join("；")}。` : undefined,
    notDone.length > 0 ? `没改成：${notDone.join("；")}。` : undefined,
  ].filter((part): part is string => part !== undefined);
  return {
    ok: applied.length > 0 || pending.length > 0,
    applied: [...applied],
    ...(confirm ? { needsConfirmation: true, foundationConfirm: confirm, pending: [...pending] } : {}),
    ...(accept ? { foundationAccept: accept } : {}),
    ...(notDone.length > 0 ? { notDone } : {}),
    ...(snapshotId ? { snapshotId } : {}),
    ...(applied.length > 0 ? { refreshScope: "foundation" as const } : {}),
    summary: parts.length > 0 ? parts.join("") : "设定本没有变化（要写的和现在的一样）。",
  };
}

export const foundationWriteTool = createTool({
  id: "foundation_write",
  description:
    "改设定本（人物 / 地点 / 物品 / 其他设定卡、关系、故事设定、写作规则、文风样本）。一次可带多步。" +
    "AI 能直接建新卡、填空的栏、改 AI 自己补的；碰了作者写的（改、删、改名、删卡、换主角）不会改，会给作者出「确认改设定」按钮。" +
    "改之前先 read_foundation 看现在写的是什么。不知道的别编，留空。",
  inputSchema,
  outputSchema,
  execute: async (input: z.infer<typeof inputSchema>, context: ToolExecutionContext) => {
    const projectDir = readProjectDirFromContext(context);
    if (!projectDir) {
      throw new Error("foundation_write 缺少 projectDir：请确认调用 agent 时通过 RequestContext 注入了 projectDir。");
    }
    return foundationWriteLogic({ projectDir, ops: input.ops });
  },
});
