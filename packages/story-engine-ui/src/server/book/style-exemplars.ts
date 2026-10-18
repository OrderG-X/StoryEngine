import { createHash } from "node:crypto";
import type { StyleExemplar } from "./types.js";

export const STYLE_EXEMPLAR_MAX_COUNT = 5;
export const STYLE_EXEMPLAR_MAX_TEXT_CHARS = 2000;
export const STYLE_EXEMPLAR_PROMPT_TEXT_CHARS = 800;
export const STYLE_EXEMPLAR_PROMPT_TOTAL_TEXT_CHARS = 1600;

export interface StyleExemplarNormalization {
  readonly exemplars: readonly StyleExemplar[];
  /** 被跳过的坏条目原因（人可读），供调用方如实报告；正常条目不受影响。 */
  readonly dropped: readonly string[];
}

/**
 * 防御性归一 writing-rules.json 里的 styleExemplars（该文件可被手改/外部工具写坏）：
 * 旧书无此字段 → 空；坏条目（非对象/缺 title/缺 text/超存储上限）逐条跳过并给出原因；
 * 超过 5 条的合法条目同样溢出跳过。缺 id 的条目按内容哈希派生稳定 id（确定性，不写回文件）。
 */
export function normalizeStyleExemplars(raw: unknown): StyleExemplarNormalization {
  if (raw === undefined || raw === null) return { exemplars: [], dropped: [] };
  if (!Array.isArray(raw)) {
    return { exemplars: [], dropped: ["styleExemplars 不是数组，已整段忽略"] };
  }
  const exemplars: StyleExemplar[] = [];
  const dropped: string[] = [];
  const usedIds = new Set<string>();
  raw.forEach((entry, index) => {
    const label = `第${index + 1}条`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      dropped.push(`${label}不是对象，已跳过`);
      return;
    }
    const record = entry as Record<string, unknown>;
    const title = typeof record.title === "string" ? record.title.trim() : "";
    if (!title) {
      dropped.push(`${label}缺 title（标题），已跳过`);
      return;
    }
    const text = typeof record.text === "string" ? record.text.trim() : "";
    if (!text) {
      dropped.push(`${label}「${title}」缺 text（样本正文），已跳过`);
      return;
    }
    if (text.length > STYLE_EXEMPLAR_MAX_TEXT_CHARS) {
      dropped.push(`${label}「${title}」正文 ${text.length} 字超过存储上限 ${STYLE_EXEMPLAR_MAX_TEXT_CHARS} 字，已跳过`);
      return;
    }
    if (exemplars.length >= STYLE_EXEMPLAR_MAX_COUNT) {
      dropped.push(`${label}「${title}」超出最多 ${STYLE_EXEMPLAR_MAX_COUNT} 条上限，已跳过`);
      return;
    }
    const rawId = typeof record.id === "string" ? record.id.trim() : "";
    const baseId = rawId || `exemplar-${shortHash(`${title}\n${text}`)}`;
    let id = baseId;
    let suffix = 2;
    while (usedIds.has(id)) {
      id = `${baseId}-${suffix}`;
      suffix += 1;
    }
    usedIds.add(id);
    const note = typeof record.note === "string" && record.note.trim() ? record.note.trim() : undefined;
    const createdAtMs = typeof record.createdAtMs === "number" && Number.isFinite(record.createdAtMs) && record.createdAtMs >= 0
      ? record.createdAtMs
      : 0;
    exemplars.push({
      id,
      title,
      text,
      ...(note ? { note } : {}),
      createdAtMs,
    });
  });
  return { exemplars, dropped };
}

/** 注入写作上下文的样本形态：只带 title/text/note——id 与 createdAtMs 是内部簿记，不喂模型。 */
export interface StyleExemplarPromptItem {
  readonly title: string;
  readonly text: string;
  readonly note?: string;
}

/**
 * 注入预算：每条 text 截到 STYLE_EXEMPLAR_PROMPT_TEXT_CHARS，样本区 text 总量封顶
 * STYLE_EXEMPLAR_PROMPT_TOTAL_TEXT_CHARS；预算用完后的整条不进（仍存在文件里）。
 */
export function buildStyleExemplarPromptItems(exemplars: readonly StyleExemplar[]): readonly StyleExemplarPromptItem[] {
  const items: StyleExemplarPromptItem[] = [];
  let remaining = STYLE_EXEMPLAR_PROMPT_TOTAL_TEXT_CHARS;
  for (const exemplar of exemplars) {
    if (remaining <= 0) break;
    const budget = Math.min(STYLE_EXEMPLAR_PROMPT_TEXT_CHARS, remaining);
    const text = exemplar.text.slice(0, budget);
    if (!text) continue;
    items.push({
      title: exemplar.title,
      text,
      ...(exemplar.note ? { note: exemplar.note } : {}),
    });
    remaining -= text.length;
  }
  return items;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 6);
}
