/**
 * 定论卡（P12；片 3C 起是 canon.propose 操作等作者时的预览、做完的结果）的防御解析：操作视图 → 校验过的卡数据。
 */
import type { SettleCardData } from "../type-defs/workspace.js";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const chapterOf = (value: unknown): number | undefined => (typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined);
const list = (value: unknown, max: number): readonly unknown[] => (Array.isArray(value) ? value.slice(0, max) : []);

export function readSettleData(value: unknown): SettleCardData | undefined {
  if (!isRecord(value)) return undefined;
  const canon = text(value.canon);
  if (!canon) return undefined;
  const edits = list(value.edits, 200).flatMap((item) => {
    if (!isRecord(item)) return [];
    const chapter = chapterOf(item.chapter);
    const key = text(item.key);
    const from = text(item.from);
    const to = text(item.to);
    if (!chapter || !key || !from || !to) return [];
    const why = text(item.why);
    return [{ key, chapter, draft: item.draft === true, from, to, ...(why ? { why } : {}) }];
  });
  const facts = list(value.facts, 200).flatMap((item) => {
    if (!isRecord(item)) return [];
    const chapter = chapterOf(item.chapter);
    const before = text(item.before);
    if (!chapter || !before) return [];
    const after = text(item.after);
    return [{ chapter, before, ...(after ? { after } : {}) }];
  });
  const fields = list(value.fields, 60).flatMap((item) => {
    if (!isRecord(item)) return [];
    const key = text(item.key);
    const label = text(item.label);
    const to = text(item.to);
    if (!key || !label || !to) return [];
    const card = text(item.card);
    return [{ key, ...(card ? { card } : {}), label, from: text(item.from), to }];
  });
  const searched = list(value.searched, 2000).flatMap((item) => {
    const chapter = chapterOf(item);
    return chapter ? [chapter] : [];
  });
  const missed = list(value.missed, 20).flatMap((item) => {
    if (!isRecord(item)) return [];
    const chapter = chapterOf(item.chapter);
    const quote = text(item.quote);
    return chapter && quote ? [{ chapter, quote }] : [];
  });
  const failures = list(value.failures, 40).map(text).filter(Boolean);
  const resolves = typeof value.resolves === "string" && value.resolves.length <= 4000 ? value.resolves : "";
  const replaces = text(value.replaces);
  const chapter = chapterOf(value.chapter);
  return {
    canon,
    canonExists: value.canonExists === true,
    ...(value.sceneOnly === true ? { sceneOnly: true } : {}),
    ...(replaces ? { replaces } : {}),
    ...(chapter ? { chapter } : {}),
    edits,
    facts,
    fields,
    searched,
    missed,
    failures,
    ...(resolves ? { resolves } : {}),
  };
}

/** 作者划掉的：只认卡上真有的 key。 */
export function readSettleExcluded(value: unknown, data: SettleCardData): readonly string[] {
  if (!Array.isArray(value)) return [];
  const keys = new Set([...data.edits.map((edit) => edit.key), ...data.fields.map((field) => field.key)]);
  return [...new Set(value.filter((key): key is string => typeof key === "string" && keys.has(key)))];
}
