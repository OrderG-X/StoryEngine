/**
 * 资料中心稀疏态诚实层（2026-07-12 审计 batch1）：
 *  - 占位「尚未配置…」不算真实条目
 *  - 系统元话术（产品不变量）不进故事向面板
 *  - 写作规则做厚：剥「反AI·」前缀 / 拆条 / ≤40 字截断
 */

/** 已知系统约束句（起步就这一句；扩集合时只加常量，勿散落硬编码）。 */
export const SYSTEM_STORY_META_SENTENCES: readonly string[] = [
  "正式事实只能通过确认提交更新。",
];

function normalizeSentence(value: string): string {
  return value
    .trim()
    .replace(/[。．.！!？?\s]+$/u, "")
    .replace(/\s+/gu, "");
}

const META_NORMALIZED = new Set(SYSTEM_STORY_META_SENTENCES.map(normalizeSentence));

/** 本程序给条目加过的展示前缀（闭集，按前缀查，不猜）。 */
const DISPLAY_LABEL_PREFIXES = ["禁止提前揭开", "禁用表达", "风险提醒", "系统约束", "产品约束"];

/** 剥常见展示前缀后再比对，盖住「禁止提前揭开：…」这类包装。 */
function metaCore(value: string): string {
  const text = value.trim();
  for (const label of DISPLAY_LABEL_PREFIXES) {
    const sep = text.charAt(label.length);
    if (text.startsWith(label) && (sep === "：" || sep === ":")) return normalizeSentence(text.slice(label.length + 1).trim());
  }
  return normalizeSentence(text);
}

/** 是否为系统元话术（含带常见前缀的包装句）。 */
export function isSystemStoryMetaSentence(value: string | null | undefined): boolean {
  if (!value?.trim()) return false;
  const core = metaCore(value);
  if (META_NORMALIZED.has(core)) return true;
  return META_NORMALIZED.has(normalizeSentence(value));
}

/** 从故事向字符串列表里滤掉系统元话术（老书不迁移也干净）。 */
export function filterSystemStoryMeta(values: readonly string[] | null | undefined): string[] {
  return (values ?? []).filter((v) => typeof v === "string" && v.trim() && !isSystemStoryMetaSentence(v));
}

/** 本程序自己垫的占位文字（闭集）。 */
const PLACEHOLDER_PREFIXES = ["尚未配置", "待配置", "暂无数据", "待确认", "暂无"];
const PLACEHOLDER_WORDS = new Set(["未知", "unknown"]);

/** 「尚未配置… / 待配置 / 暂无数据」占位槽，不算真实资料。 */
export function isPlaceholderUiValue(value: string | null | undefined): boolean {
  if (!value?.trim()) return true;
  const t = value.trim();
  // 审计截图里的占位一律以「尚未配置」起头（随身物品 / 当前地点 / 法则…）；整词待配置等同。
  return PLACEHOLDER_PREFIXES.some((prefix) => t.startsWith(prefix)) || PLACEHOLDER_WORDS.has(t.toLowerCase());
}

/** 只保留真实条目；占位整槽丢弃。 */
export function filterPlaceholderUiValues(values: readonly string[] | null | undefined): string[] {
  return (values ?? []).filter((v) => typeof v === "string" && !isPlaceholderUiValue(v));
}

/** 老书做厚时本程序自己加的「反AI·」前缀（闭集）。 */
const ANTI_AI_PREFIXES = ["反AI", "反 Ai", "反ai"];
const ANTI_AI_SEPARATORS = "·•.-—–";

/** 剥掉「反AI·」前缀，返回剩下的；没有前缀返回 undefined。 */
function afterAntiAiPrefix(value: string): string | undefined {
  const text = value.trim();
  const prefix = ANTI_AI_PREFIXES.find((item) => text.startsWith(item));
  if (!prefix) return undefined;
  let rest = text.slice(prefix.length);
  if (rest && ANTI_AI_SEPARATORS.includes(rest.charAt(0))) rest = rest.slice(1);
  return rest.trim();
}
const MAX_BOOK_STYLE_CHARS = 40;

/** 是否以「反AI·」类前缀开头（老书做厚垃圾，展示应归反 AI 区）。 */
export function isAntiAiPrefixedRule(value: string | null | undefined): boolean {
  return Boolean(value?.trim() && afterAntiAiPrefix(value) !== undefined);
}

/** 剥「反AI·」前缀；无前缀则原样。 */
export function stripAntiAiPrefix(value: string): string {
  return afterAntiAiPrefix(value) ?? value.trim();
}

/**
 * 做厚写入前的语义清洗：剥前缀 → 按句/分号拆条 → 每条 ≤40 字截断。
 * 不信模型会吐干净短句；空结果返回 []。
 */
export function sanitizeBookStyleRuleLines(raw: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of raw) {
    if (typeof line !== "string" || !line.trim()) continue;
    const stripped = stripAntiAiPrefix(line);
    if (!stripped || isSystemStoryMetaSentence(stripped)) continue;
    const parts = stripped
      .split(/[；;。！？!\n]+/u)
      .map((p) => p.trim())
      .filter(Boolean);
    for (const part of parts.length > 0 ? parts : [stripped]) {
      let piece = part.replace(/^[\d]+[.、)\]]\s*/u, "").trim();
      // 「名：描述」过长时优先保留描述侧短句；名本身也过长则截断。
      const colon = piece.indexOf("：") >= 0 ? piece.indexOf("：") : piece.indexOf(":");
      if (colon > 0 && piece.length > MAX_BOOK_STYLE_CHARS) {
        const after = piece.slice(colon + 1).trim();
        piece = after.length > 0 && after.length <= MAX_BOOK_STYLE_CHARS
          ? after
          : after.slice(0, MAX_BOOK_STYLE_CHARS) || piece.slice(0, MAX_BOOK_STYLE_CHARS);
      } else if (piece.length > MAX_BOOK_STYLE_CHARS) {
        piece = piece.slice(0, MAX_BOOK_STYLE_CHARS);
      }
      if (!piece || isPlaceholderUiValue(piece) || isSystemStoryMetaSentence(piece)) continue;
      if (seen.has(piece)) continue;
      seen.add(piece);
      out.push(piece);
    }
  }
  return out;
}

/**
 * 展示层：把「反AI·」开头的条目从语言风格类字段拆出，交给反 AI 区。
 * 返回 { kept, antiAi }——kept 留在原字段，antiAi 供面板并入 Anti-AI 表。
 */
export function partitionAntiAiPrefixedRules(values: readonly string[] | null | undefined): {
  readonly kept: string[];
  readonly antiAi: string[];
} {
  const kept: string[] = [];
  const antiAi: string[] = [];
  for (const v of values ?? []) {
    if (typeof v !== "string" || !v.trim()) continue;
    if (isAntiAiPrefixedRule(v)) antiAi.push(v.trim());
    else kept.push(v.trim());
  }
  return { kept, antiAi };
}

/** 长于 60 字或含「；」的 value → 拆成条目列表（面板扫读）。 */
export function splitLongRuleValueForDisplay(value: string | null | undefined): string[] {
  if (!value?.trim()) return [];
  const text = value.trim();
  if (text.includes("；") || text.includes(";") || text.length > 60) {
    return [...new Set(
      text.split(/[；;\n]/u).map((s) => s.trim()).filter((s) => s && !isPlaceholderUiValue(s)),
    )];
  }
  return [text];
}
