/**
 * steering-service — chapter-steering 的 application service（generate_chapter_steering 工具调用）。
 *
 * 原来还有 POST /api/chapter-steering 一条 HTTP 路同调本 service；重构 P4 删掉了那条路
 * （前端早已不调它，方案只经对话里 AI 调工具出）。
 *
 * 引擎 buildChapterSteeringDraft 是确定性推导（零 LLM、只读），本 service 同样只读：
 * 不调模型、不写盘、不建快照。缺方向由本 service 统一拒绝，工具渲染成 ok:false + 诚实 summary。
 *
 * 入参归一：chapter/pacing/revealLevel 在本 service 做一次——章号数字字符串还原（"3"→3）、
 * 枚举 trim+小写+白名单（"Fast"→fast）、非法/空白一律 → undefined 走引擎默认。
 */
import { buildChapterSteeringDraft } from "@actalk/story-engine";
import type {
  ChapterSteeringDraft,
  ChapterSteeringPacing,
  ChapterSteeringRevealLevel,
} from "@actalk/story-engine";

export interface ChapterSteeringInput {
  readonly projectDir: string;
  /** 适配层原始方向文本；service 内 trim 后判空（两侧同一守卫）。 */
  readonly userDirection?: string;
  /** 章号原始入参（数字或数字字符串）；service 统一归一，非法/非正 → undefined（引擎按进度推断）。 */
  readonly chapter?: number | string;
  /** pacing 原始入参；service 统一 trim+小写+白名单归一（"Fast"→"fast"），非法/空白 → undefined（引擎默认 medium）。 */
  readonly pacing?: string;
  /** revealLevel 原始入参；同 pacing 的归一口径，非法/空白 → undefined（引擎默认 small）。 */
  readonly revealLevel?: string;
  readonly mustInclude?: readonly string[];
  readonly mustAvoid?: readonly string[];
  readonly maxSuggestions?: number;
}

export type ChapterSteeringResult =
  | { readonly ok: true; readonly draft: ChapterSteeringDraft }
  | { readonly ok: false; readonly reason: "missing_user_direction" };

const STEERING_PACINGS: readonly ChapterSteeringPacing[] = ["slow", "medium", "fast"];
const STEERING_REVEAL_LEVELS: readonly ChapterSteeringRevealLevel[] = ["none", "small", "large"];

/** 枚举入参归一：trim + 小写 + 白名单校验；非法/空白 → undefined（走引擎默认，与工具 coerceEnum 同口径）。 */
function normalizeSteeringEnum<T extends string>(value: string | undefined, allowed: readonly T[]): T | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  return (allowed as readonly string[]).includes(normalized) ? (normalized as T) : undefined;
}

/** 章号入参归一：数字字符串还原为数字（与工具 coerceNumber 同口径）；非正/非有限/还原不了 → undefined。 */
function normalizeSteeringChapter(value: number | string | undefined): number | undefined {
  const raw = typeof value === "string" ? (value.trim() === "" ? Number.NaN : Number(value.trim())) : value;
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : undefined;
}

export async function runChapterSteering(input: ChapterSteeringInput): Promise<ChapterSteeringResult> {
  const userDirection = input.userDirection?.trim() ?? "";
  if (!userDirection) {
    return { ok: false, reason: "missing_user_direction" };
  }

  const chapter = normalizeSteeringChapter(input.chapter);
  const pacing = normalizeSteeringEnum(input.pacing, STEERING_PACINGS);
  const revealLevel = normalizeSteeringEnum(input.revealLevel, STEERING_REVEAL_LEVELS);
  const draft = await buildChapterSteeringDraft({
    projectDir: input.projectDir,
    userDirection,
    ...(chapter !== undefined ? { chapter } : {}),
    ...(pacing !== undefined ? { pacing } : {}),
    ...(revealLevel !== undefined ? { revealLevel } : {}),
    ...(input.mustInclude !== undefined ? { mustInclude: input.mustInclude } : {}),
    ...(input.mustAvoid !== undefined ? { mustAvoid: input.mustAvoid } : {}),
    ...(input.maxSuggestions !== undefined ? { maxSuggestions: input.maxSuggestions } : {}),
  });
  return { ok: true, draft };
}
