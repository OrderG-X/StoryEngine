/**
 * 改设定的 ops（写作版本 P2a 片 3，从 foundation_write 挪来）：模型常传的退化写法在边界归一（只动句法、不猜意思），
 * 逐条校验，格式不对的如实说第几步、为什么；AI 刚写进去的那几处对应的「认下」。
 */
import { z } from "zod";
import {
  CardOp,
  KIND_LABELS,
  RULE_LIST_LABELS,
  RULE_SCALAR_LABELS,
} from "@actalk/story-core";
import type { SettingCardsFile } from "@actalk/story-core";

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
export function acceptOpsFor(direct: readonly CardOp[], before: SettingCardsFile): CardOp[] {
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

/** 模型给的一批 ops → 能用的 + 没改成的（第几步、为什么）。 */
export function readSettingsOps(raw: readonly Record<string, unknown>[]): { readonly valid: CardOp[]; readonly notDone: string[] } {
  const valid: CardOp[] = [];
  const notDone: string[] = [];
  raw.forEach((item, index) => {
    const parsed = CardOp.safeParse(normalizeRawOp(item));
    if (parsed.success) valid.push(parsed.data);
    else notDone.push(describeIssue(index, item, parsed.error.issues[0]));
  });
  return { valid, notDone };
}
