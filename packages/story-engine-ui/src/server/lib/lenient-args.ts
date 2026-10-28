import { z } from "zod";

/**
 * LLM↔工具入参宽容层 —— 把模型以字符串形式发来的 tool-call 参数还原成 schema 期望的类型。
 *
 * **根因（2026-06-25 实测·SSE 抓包铁证）**：部分模型/网关（实测 qwen3.7-plus 经 hub.example.com）
 * 把**所有** tool-call 参数序列化成字符串——`chapter:"5"` / `allowWriteAhead:"false"` /
 * `selectedCharacterIds:"[]"` / `after:"{...}"`。严格 `z.number()/z.boolean()/z.array()/z.record()`
 * 一律拒，框架回 "Tool input validation failed ... expected number, received string"，模型反复重试
 * 仍改不过来 → 整章正文写不出来（generate_draft 永远失败）。
 *
 * 修法：在每个 agent 要填的 number/boolean/array/object 字段外包一层 `z.preprocess`，**只在类型不符时
 * 尽力还原**（`"5"→5`、`"false"→false`、`"[]"→[]`、`'{...}'→{...}`），还原不了就原样交给 base schema
 * **如实报错、不放水**（`"abc"` 仍拒、`requestedDraftLength:"0"` 仍被 `.positive()` 拒）。空串/纯空白
 * 视作「没填」→ undefined，交给 `.optional()`。对本来就发正确类型的好模型**逐字节零行为改动**。
 *
 * 题材中立、纯确定性、不调 LLM。`base` 上的 `.describe()`/`.optional()` 原样保留——`z.toJSONSchema`
 * 仍渲染出 base 的类型与 required 语义（模型看到的 schema 不变，实测见 lenient-args.test.ts）。
 */

function toNumberLike(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (trimmed === "") return undefined; // 空串=没填，交给 optional
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : value; // 还原不了（"abc"）→ 原样让 base 报错
}

// 模型无关：不同模型给布尔的退化形态五花八门——字符串 "true"/"True"/"1"/"yes"/"y"、数字 1/0。
// 全归一；真还原不了（"maybe"/2）原样交给 z.boolean 如实拒、不放水。
const BOOL_TRUE = new Set(["true", "1", "yes", "y"]);
const BOOL_FALSE = new Set(["false", "0", "no", "n"]);
function toBooleanLike(value: unknown): unknown {
  if (value === null) return undefined; // 退化空值视同缺省（模型常给 recommended:null）——否则穿到 z.boolean().optional() 被拒
  if (value === 1) return true;
  if (value === 0) return false;
  if (typeof value !== "string") return value;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "") return undefined;
  if (BOOL_TRUE.has(trimmed)) return true;
  if (BOOL_FALSE.has(trimmed)) return false;
  return value;
}

// 空串/纯空白 → undefined：治 `input.x ?? 默认` 接不住空串（`"" ?? d = ""`），让缺省回退正常生效。
// 非空值原样（不 trim——是否 trim 由下游语义决定）。用于 optional string 字段。
function toBlankUndefined(value: unknown): unknown {
  if (typeof value === "string" && value.trim() === "") return undefined;
  return value;
}

// 枚举宽容：trim + 小写，吃下 "Add"/" REMOVE "/" major " 这类大小写/空白变体（枚举 canonical 值须为小写）。
// 空串/空白 → undefined（交给 optional）；非空原样小写交给 z.enum 校验，不在枚举内仍如实拒。
function toEnumLike(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  return trimmed.toLowerCase();
}

// 大小写不敏感枚举（canonical 值含 camelCase 时用，如 category 的 characterRelationships/writingRules）：
// 把输入按 trim + 小写 与 canonical 值逐一比对，命中则归一回**原 canonical 大小写**；空→undefined；不命中原样交 z.enum 拒。
function makeEnumValueCoercer(canonicalValues: readonly string[]) {
  return (value: unknown): unknown => {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    if (trimmed === "") return undefined;
    const lower = trimmed.toLowerCase();
    return canonicalValues.find((c) => c.toLowerCase() === lower) ?? trimmed;
  };
}

/** 字符串 → 字符串数组：`""`/`"[]"`→`[]`；`'["a","b"]'`→JSON 解析；`"a,b，c"`→逗号/中文逗号兜底切分。 */
function toStringArrayLike(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "[]") return [];
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed : value;
    } catch {
      return value;
    }
  }
  return trimmed
    // 不猜白名单：切句
    .split(/[,，]/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 字符串 → 任意数组（对象数组用，如 suggest_next_steps.choices）：仅 JSON 解析，不做逗号兜底。 */
function toJsonArrayLike(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "[]") return [];
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed : value;
    } catch {
      return value;
    }
  }
  return value;
}

/** 字符串 → 对象（如 foundation_write.after 整块被序列化成字符串时）：仅 JSON 解析。 */
function toJsonObjectLike(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return value;
    }
  }
  return value;
}

export const coerceNumber = <T extends z.ZodType>(base: T) => z.preprocess(toNumberLike, base);
export const coerceBoolean = <T extends z.ZodType>(base: T) => z.preprocess(toBooleanLike, base);
export const coerceStringArray = <T extends z.ZodType>(base: T) => z.preprocess(toStringArrayLike, base);
export const coerceJsonArray = <T extends z.ZodType>(base: T) => z.preprocess(toJsonArrayLike, base);
export const coerceJsonObject = <T extends z.ZodType>(base: T) => z.preprocess(toJsonObjectLike, base);
/** 空串/纯空白 → undefined。用于 optional string，让 execute 里的 `?? 默认` 接得住模型传的空串。 */
export const blankToUndefined = <T extends z.ZodType>(base: T) => z.preprocess(toBlankUndefined, base);
/** 模型面数值归一：非正数（0/负/非有限）→ undefined，让 `?? 默认` 兜底；正数原样。治模型把 `0` 当"默认/不限"用。 */
export function positiveOrUndefined(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * 模型 JSON 里的章号 / 句号：数字、数字串，或照我们自己提示里的写法写成「第 10 章」「[78]」。正整数才收。
 * 换题材长篇实跑 2026-10-27：定论查全书回 {"chapter":"第 10 章"}，章号认不出，同章另两句静默丢了。
 */
export function positiveIntLike(value: unknown): number | undefined {
  let text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  // 不猜白名单：章节标题
  const titled = /^第\s*(\d+)\s*章$/u.exec(text);
  if (titled) text = titled[1]!;
  const bracketed = /^\[(\d+)\]$/u.exec(text);
  if (bracketed) text = bracketed[1]!;
  const parsed = text ? Number(text) : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** 枚举宽容（trim + 小写）。枚举 canonical 值须为小写；空串→undefined。 */
export const coerceEnum = <T extends z.ZodType>(base: T) => z.preprocess(toEnumLike, base);
/** 大小写不敏感枚举（canonical 含 camelCase 时用）：按 canonical 值大小写不敏感匹配并归一回 canonical。 */
export const coerceEnumValues = <T extends z.ZodType>(canonicalValues: readonly string[], base: T) =>
  z.preprocess(makeEnumValueCoercer(canonicalValues), base);
