/**
 * 「另外几版」卡的纯函数：AI 一次写几版时落选那几版的防御解析。前端投影和服务端存盘白名单共用同一个解析。
 */
import type { DraftVersionsCardData } from "../type-defs/workspace.js";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const positive = (value: unknown): number | undefined => (typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined);

/** 一版最多存这么多字（一章正文远小于它；超了是坏数据，整版不收）。 */
const MAX_BODY_CHARS = 60_000;

/** 工具输出 { chapter, otherVersions } / 存盘的 { chapter, versions } → 校验过的卡数据；没有能用的版返回 undefined。 */
export function readDraftVersions(value: unknown): DraftVersionsCardData | undefined {
  if (!isRecord(value)) return undefined;
  const chapter = positive(value.chapter);
  if (!chapter) return undefined;
  const list = Array.isArray(value.versions) ? value.versions : Array.isArray(value.otherVersions) ? value.otherVersions : [];
  const versions = list.flatMap((item) => {
    if (!isRecord(item)) return [];
    const index = positive(item.index);
    const body = typeof item.body === "string" ? item.body.trim() : "";
    return index && body && body.length <= MAX_BODY_CHARS ? [{ index, body }] : [];
  }).slice(0, 3);
  return versions.length > 0 ? { chapter, versions } : undefined;
}
