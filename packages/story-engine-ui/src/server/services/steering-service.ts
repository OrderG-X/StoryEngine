/**
 * steering-service — chapter-steering 的共享 application service（双轨合一·评审簇第一波）。
 *
 * POST /api/chapter-steering（routes/chapter-steering.ts）与 generate_chapter_steering 工具
 * （agent/tools/generate-chapter-steering.ts）此前各自进程内复刻同一编排，已实际漂移过；
 * 现在同调本 service 拿 canonical result，两侧只剩适配层：
 *   - 路由：HTTP 入参解析（body/projectPath 必填/400 包装，D26）+ { ok, draft } 投影。
 *   - 工具：RequestContext 取 projectDir/章号回退（D26）+ 用户可见 summary（D27）。
 *
 * 引擎 buildChapterSteeringDraft 是确定性推导（零 LLM、只读），本 service 同样只读：
 * 不调模型、不写盘、不建快照。缺方向是共享编排判定（D28 已收敛为本 service 的统一拒绝），
 * 两侧差异只剩适配层渲染：路由 400 + error 字段，工具 ok:false + 诚实 summary。
 *
 * 入参归一（2026-09-11 收敛·lenient-args vs project-io 归一差）：chapter/pacing/revealLevel
 * 统一在本 service 做一次——章号数字字符串还原（"3"→3）、枚举 trim+小写+白名单（"Fast"→fast）、
 * 非法/空白一律 → undefined 走引擎默认。此前路由严格匹配（readPacing 非 canonical 即丢）而工具
 * coerceEnum/coerceNumber 宽容还原，同一输入两侧行为真实不同。mustInclude/mustAvoid 的字符串
 * 分隔符差（路由按 \n/; 拆、工具按 ,/JSON 拆）收不动（见 parity/chapter-steering.parity.test.ts 头注释登记）。
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
