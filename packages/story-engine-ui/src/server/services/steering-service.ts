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
  readonly chapter?: number;
  readonly pacing?: ChapterSteeringPacing;
  readonly revealLevel?: ChapterSteeringRevealLevel;
  readonly mustInclude?: readonly string[];
  readonly mustAvoid?: readonly string[];
  readonly maxSuggestions?: number;
}

export type ChapterSteeringResult =
  | { readonly ok: true; readonly draft: ChapterSteeringDraft }
  | { readonly ok: false; readonly reason: "missing_user_direction" };

export async function runChapterSteering(input: ChapterSteeringInput): Promise<ChapterSteeringResult> {
  const userDirection = input.userDirection?.trim() ?? "";
  if (!userDirection) {
    return { ok: false, reason: "missing_user_direction" };
  }

  const draft = await buildChapterSteeringDraft({
    projectDir: input.projectDir,
    userDirection,
    ...(input.chapter !== undefined ? { chapter: input.chapter } : {}),
    ...(input.pacing !== undefined ? { pacing: input.pacing } : {}),
    ...(input.revealLevel !== undefined ? { revealLevel: input.revealLevel } : {}),
    ...(input.mustInclude !== undefined ? { mustInclude: input.mustInclude } : {}),
    ...(input.mustAvoid !== undefined ? { mustAvoid: input.mustAvoid } : {}),
    ...(input.maxSuggestions !== undefined ? { maxSuggestions: input.maxSuggestions } : {}),
  });
  return { ok: true, draft };
}
