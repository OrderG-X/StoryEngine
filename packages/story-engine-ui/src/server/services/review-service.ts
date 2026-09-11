/**
 * review-service — draft AI 审稿的共享 application service（双轨合一·评审簇第一波）。
 *
 * POST /api/draft/ai-review（routes/draft.ts handleDraftAIReview）与 ai_review 工具
 * （agent/tools/ai-review.ts）此前各自进程内复刻同一编排，已实际漂移过；
 * 现在同调本 service 拿 canonical result，两侧只剩适配层投影：
 *   - 路由：HTTP 入参解析 + model/profileId 输出（D20）；失败时 ok:false + error 包装。
 *   - 工具：RequestContext 取 projectDir/章号回退 + 用户可见 summary（D20）。
 *
 * 编排：取真草稿（与质检同源）→ 确定性质检 + 状态概览 + 写作上下文 → 组 prompt →
 * callModel(draftReview 槽，流式+空闲超时) → parseDraftAIReviewReport（失败回退）。只读：不写盘、不建快照。
 *
 * 两条原豁免分歧已收敛为共享语义（刻意修复，见 parity/ai-review.parity.test.ts 头注释）：
 *   - D17 无草稿：两侧同走「三处取稿皆空 → 诚实 no_draft 结果、绝不审空稿谎报」；
 *     差异只剩适配层渲染（路由保持 500 状态码兼容 + ok:false，工具 ok:false + summary）。
 *   - D18 模型失败/烂输出的 ok 契约：canonical result 一律 ok:!usedFallback（走回退=没真审成）；
 *     路由随之从「永远 ok:true 仅靠 usedFallback」收敛为 200 + ok:false + 诚实 error
 *     （前端 reviewDraftWithAI 对 ok:false 走 throw → failAgentFlow 红卡，路径本就有测试覆盖，
 *     不再渲染「审稿完成：被阻止」的假完成卡——与工具侧治 A5 同方向）。
 *
 * 显式策略参数：
 *   - trustExplicit（D19）：路由传 true（编辑器实时稿顶格优先）；工具默认 false（盘稿优先）。
 *   - deterministicQuality：HTTP 专属输入通道（前端可预传质检结果，工具无此通道）。
 *
 * 入参归一（SWE P1-5 收敛·两侧适配层共用这一个归一点）：chapterGoal/userDirection 统一
 *   trim + 空白→undefined——此前路由 readString（trim+空白→undefined）而工具 z.string() 原样透传，
 *   同一输入（如「  加冲突  」）两侧送进模型的 prompt 真实不同；现在无论哪侧给原始串，结果一致。
 */
import {
  buildDraftAIReviewPrompt,
  buildStateOverview,
  buildWritingContextPack,
  checkDraftBeforeCommit,
  fallbackDraftAIReviewReport,
  parseDraftAIReviewReport,
  type CommitQualityReport,
  type DraftAIReviewReport,
} from "@actalk/story-engine";

import { resolveConfiguredChatModel, streamChatModelToText, type ResolvedChatModel } from "../lib/llm-client.js";
import { countTextWords } from "../../utils/textUtils.js";
import { resolveDraftContentForQualityCheck } from "./quality-service.js";

/** 把服务端实测字数钉进审稿 prompt，禁止模型瞎估（dogfood 问题 10）。 */
export function appendActualWordCountToReviewPrompt(prompt: string, actualWordCount: number): string {
  return [
    prompt,
    "",
    `【服务端计量·禁止估算】正文实际 ${actualWordCount} 字。报告 summary 与任何字数相关评价必须引用此实际字数，禁止自行估计、约数或「大概一千字」这类猜测。`,
  ].join("\n");
}

const VERDICT_LABEL: Record<DraftAIReviewReport["verdict"], string> = {
  ready_to_commit: "可以定稿",
  needs_minor_revision: "需小修",
  needs_major_revision: "需大改",
  blocked: "被阻止",
};

export interface DraftAIReviewInput {
  readonly projectDir: string;
  readonly chapter: number;
  readonly explicitDraftContent?: string;
  /** D19 显式策略：路由传 true（编辑器实时稿可信、顶格优先）；工具默认 false（盘稿优先）。 */
  readonly trustExplicit?: boolean;
  readonly chapterGoal?: string;
  readonly userDirection?: string;
  /** HTTP 专属输入通道：前端预传的确定性质检结果；缺省由本 service 现跑 checkDraftBeforeCommit。 */
  readonly deterministicQuality?: CommitQualityReport;
  /** 单测注入的模型调用（返回模型原始内容字符串）；缺省走 draftReview 槽流式调用。 */
  readonly callModel?: (prompt: string) => Promise<string>;
  readonly retries?: number;
  readonly delayMs?: number;
}

export interface DraftAIReviewResult {
  readonly chapter: number;
  /** no_draft=三处皆无真稿的诚实短路；reviewed=跑完了审稿流程（review 可能是 fallback 报告）。 */
  readonly kind: "no_draft" | "reviewed";
  /** 诚实契约（D18 收敛后）：走安全回退或无稿 → false（没真审成），真审完 → true。 */
  readonly ok: boolean;
  readonly review: DraftAIReviewReport;
  readonly usedFallback: boolean;
  readonly actualWordCount: number;
  /** D20 输出面：路由投影 model/profileId；工具不投影。注入 callModel 时（单测）缺省。 */
  readonly model?: string;
  readonly profileId?: string;
  /** 用户可见结论摘要：工具投影为 summary；路由在 ok:false 时借作 error 文案（两侧同一文案）。 */
  readonly summary: string;
}

export async function runDraftAIReview(input: DraftAIReviewInput): Promise<DraftAIReviewResult> {
  const { projectDir, chapter } = input;
  // 入参归一（P1-5）：chapterGoal/userDirection 无论哪侧进来都先 trim + 空白→undefined 再进 prompt。
  const chapterGoal = normalizeOptionalReviewText(input.chapterGoal);
  const userDirection = normalizeOptionalReviewText(input.userDirection);
  // 模型无关取稿（与质检同源）：真显式正文（trustExplicit 时顶格）→ 文件(带重试) → workspace 原始草稿。
  // 治孪生 bug：模型多塞 `draftContent:""`（或文件暂空/占位）时，旧 `?? readFile` 会审一份空稿并
  // ok:true 谎报「审了」。三处皆无真稿 → 诚实 no_draft，绝不审空稿。
  const resolved = await resolveDraftContentForQualityCheck({
    projectDir,
    chapter,
    ...(input.explicitDraftContent !== undefined ? { explicitDraftContent: input.explicitDraftContent } : {}),
    ...(input.trustExplicit !== undefined ? { trustExplicit: input.trustExplicit } : {}),
    ...(input.retries !== undefined ? { retries: input.retries } : {}),
    ...(input.delayMs !== undefined ? { delayMs: input.delayMs } : {}),
  });
  if (!resolved.hasRealDraft) {
    return {
      chapter,
      kind: "no_draft",
      ok: false,
      review: fallbackDraftAIReviewReport("本章还没有可审的正文（草稿为空或还没生成）。"),
      usedFallback: true,
      actualWordCount: 0,
      summary: `第 ${chapter} 章还没有可审的正文（草稿为空或还没生成）。请先生成本章正文，再来审稿。`,
    };
  }
  const draftContent = resolved.content;
  const actualWordCount = countTextWords(draftContent);

  const deterministicQuality = input.deterministicQuality
    ?? await checkDraftBeforeCommit({ projectDir, chapter, draftContent });
  const [overview, writingContextPack] = await Promise.all([
    buildStateOverview({ projectDir, chapter, maxTimelineEvents: 8 }),
    buildWritingContextPack({
      projectDir,
      chapter,
      userDirection: userDirection ?? "",
      ...(chapterGoal !== undefined ? { currentChapterGoal: chapterGoal } : {}),
      maxTimelineEvents: 3,
    }).catch(() => undefined),
  ]);

  const prompt = appendActualWordCountToReviewPrompt(
    buildDraftAIReviewPrompt({
      chapter,
      draftContent,
      ...(chapterGoal !== undefined ? { chapterGoal } : {}),
      ...(userDirection !== undefined ? { userDirection } : {}),
      deterministicQuality,
      stateOverview: overview,
      ...(writingContextPack ? { writingContextPack } : {}),
    }),
    actualWordCount,
  );

  // 注入 callModel（单测）时不解析模型配置——不触网、不读模型设置。
  const configured = input.callModel ? undefined : await resolveConfiguredChatModel("draftReview");
  const callModel = input.callModel ?? ((value: string) => callDraftReviewModel(configured!, value));
  const review = await runReviewModel(prompt, callModel);
  const usedFallback = review.verdict === "blocked"
    && review.issues.some((issue) => issue.id === "ai-review-format-error");

  return {
    chapter,
    kind: "reviewed",
    ok: !usedFallback, // 走回退=没真审成→ok:false→诚实显红；真审完→ok:true
    review,
    usedFallback,
    actualWordCount,
    ...(configured !== undefined ? { model: configured.profile.model, profileId: configured.profile.id } : {}),
    summary: usedFallback
      ? `第 ${chapter} 章 AI 审稿未完成（模型不可用），未改任何内容；请稍后重试或人工检查。`
      : `第 ${chapter} 章 AI 审稿：${VERDICT_LABEL[review.verdict]}（评分 ${review.score}；正文实际 ${actualWordCount} 字）。${review.summary}`,
  };
}

/** 可选文本入参归一：trim + 空白→undefined（与路由 readString 同口径；双轨统一在本 service 做这一次）。 */
function normalizeOptionalReviewText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** 调模型并解析；任何失败（请求/空内容/解析）都走 fallback，绝不抛、不谎称审稿通过。 */
async function runReviewModel(
  prompt: string,
  callModel: (prompt: string) => Promise<string>,
): Promise<DraftAIReviewReport> {
  try {
    const content = await callModel(prompt);
    return parseDraftAIReviewReport(content);
  } catch (error) {
    return fallbackDraftAIReviewReport(error instanceof Error ? error.message : String(error));
  }
}

/**
 * draftReview 槽的默认模型调用：流式 + 空闲超时——审稿内容多、推理模型思考久，绝不设总时长上限，
 * 有任何字节（正文/思考 token）就续命，只有连接彻底静默才判死（streamChatModelToText 内部 abort 并抛错）。
 */
async function callDraftReviewModel(configured: ResolvedChatModel, prompt: string): Promise<string> {
  const { content } = await streamChatModelToText({
    configured,
    messages: [{ role: "user", content: prompt }],
    temperature: configured.profile.temperature ?? 0.35,
    responseFormat: { type: "json_object" },
  });
  const text = content.trim();
  if (!text) throw new Error("审稿模型返回了空内容。");
  return text;
}
