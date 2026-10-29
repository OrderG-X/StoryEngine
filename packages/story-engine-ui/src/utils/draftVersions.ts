/**
 * 「另外几版」卡的纯函数：AI 一次写几版时（选优落选的、作者要自己挑的）那几版的防御解析。前端投影和服务端存盘白名单共用同一个解析。
 */
import type { DraftVersionsCardData } from "../type-defs/workspace.js";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const positive = (value: unknown): number | undefined => (typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined);

/** 一版最多存这么多字（一章正文远小于它；超了是坏数据，整版不收）。 */
const MAX_BODY_CHARS = 60_000;

const CANDIDATE_ID = /^[0-9a-z-]{8,80}$/u;
const SHA = /^[0-9a-f]{64}$/u;

/**
 * 写稿结果 { chapter, otherVersions, pick? } / 存盘的 { chapter, versions, pick? } → 校验过的卡数据；没有能用的版返回 undefined。
 * 没留成候选的（老版本的卡，没有候选号）、作者已经处理过的（handled）不收：换不上了。
 */
export function readDraftVersions(value: unknown): DraftVersionsCardData | undefined {
  if (!isRecord(value)) return undefined;
  const chapter = positive(value.chapter);
  if (!chapter) return undefined;
  const list = Array.isArray(value.versions) ? value.versions : Array.isArray(value.otherVersions) ? value.otherVersions : [];
  const versions = list.flatMap((item) => {
    if (!isRecord(item) || item.handled === true) return [];
    const index = positive(item.index);
    const body = typeof item.body === "string" ? item.body.trim() : "";
    const candidateId = typeof item.candidateId === "string" && CANDIDATE_ID.test(item.candidateId) ? item.candidateId : undefined;
    const sha = typeof item.sha === "string" && SHA.test(item.sha) ? item.sha : undefined;
    const title = typeof item.title === "string" && item.title.trim() ? item.title.trim().slice(0, 200) : undefined;
    return index && body && body.length <= MAX_BODY_CHARS && candidateId && sha ? [{ index, candidateId, sha, ...(title ? { title } : {}), body }] : [];
  }).slice(0, 3);
  return versions.length > 0 ? { chapter, ...(value.pick === true ? { pick: true as const } : {}), versions } : undefined;
}
