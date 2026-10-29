/**
 * 只读检查（写作版本 P2a inspect.run）：核账、硬伤检查、内容审阅、查 AI 味四种都从这里出结果。
 *
 * - 正文先冻结（`freezeChapterText`，盘上稿件只用核心 `parseDraftFile` 拆）：inspect.run 的 freeze 步存下它，接着做时照这一份核。
 * - 结果是界面卡片和下一轮模型读的形状（沿用原来 check_continuity / quality_check / ai_review / check_ai_flavor 的输出）。
 * - 只读：不改正文、不写账本；核账只写核账记忆（按内容键的缓存）。
 */
import { parseDraftFile, readChapterPaper, readDraftState } from "@actalk/story-core";
import { buildWritingContextPack } from "../writing/writing-context-pack.js";
import { checkDraftBeforeCommit, type CommitQualityReport } from "../writing/commit-quality-check.js";
import { refineQualityReport, type RefinedQualityReport } from "../writing/quality-report-refine.js";
import { runAiFlavorCheck, type AiFlavorReport } from "../writing/ai-flavor/ai-flavor-check.js";
import { readAntiRules, withAntiRulesNote } from "../writing/ai-flavor/anti-rules.js";
import { resolveConfiguredChatModel, streamChatModelToText } from "../lib/llm-client.js";
import { hasRealDraftContent } from "../lib/project-io.js";
import { canReuseCheck, checkChapterBody, type ChapterCheckOptions, type ChapterCheckResult } from "../editorial/continuity/check-service.js";
import { rereadBlocker } from "../editorial/reread-state.js";
import type { DraftAIReviewReport } from "../writing/draft-ai-review.js";
import { runDraftAIReview } from "./review-service.js";

export type InspectMode = "continuity" | "quality" | "review" | "flavor";

/** 冻结的一章正文：核账核工作稿（没有就核定稿），另外三种只看工作稿。 */
export interface FrozenChapterText {
  readonly chapter: number;
  readonly source: "draft" | "committed";
  /** 原样全文（带章名行）：硬伤检查、内容审阅照它看（缺不缺章名也是硬伤）。 */
  readonly fileText: string;
  /** 去掉章名行的正文。 */
  readonly body: string;
  /** 工作稿的版本号（界面据此判断核过后稿子改没改）；核的是定稿时没有。 */
  readonly version?: string;
}

const NO_TEXT: Record<InspectMode, (chapter: number) => string> = {
  continuity: (chapter) => `第 ${chapter} 章还没有正文，没法核账。`,
  quality: (chapter) => `第 ${chapter} 章还没有可做硬伤检查的正文（工作稿为空或还没写）。先写这一章，再来检查。`,
  review: (chapter) => `第 ${chapter} 章还没有可审的正文（工作稿为空或还没生成）。请先生成本章正文，再来做内容审阅。`,
  flavor: (chapter) => `第 ${chapter} 章还没有工作稿，先出稿再查 AI 味。`,
};

/** 冻结一章正文（代次先读、正文后读，版本号和存稿同一口径）。没有可查的正文返回一句原因。 */
export async function freezeChapterText(bookDir: string, chapter: number, mode: InspectMode): Promise<FrozenChapterText | { readonly missing: string }> {
  const draft = (await readDraftState(bookDir, chapter)).file;
  if (draft) {
    const { body } = parseDraftFile(draft.text);
    if (body.trim() && (mode === "continuity" || hasRealDraftContent(draft.text))) {
      return { chapter, source: "draft", fileText: draft.text, body, version: draft.version };
    }
  }
  if (mode === "continuity") {
    const committed = (await readChapterPaper(bookDir, chapter)).committed;
    if (committed?.body.trim()) {
      return { chapter, source: "committed", fileText: committed.title ? `# ${committed.title}\n\n${committed.body}\n` : `${committed.body}\n`, body: committed.body };
    }
  }
  return { missing: NO_TEXT[mode](chapter) };
}

/**
 * 查的是哪一份（四种结果都带，Astra P2a 第 10 轮第 4 条）：停过再接着做查的是冻结的那份，期间作者可能改过稿；
 * 界面和下一轮模型拿它和稿纸现在的版本比，对不上就标「这是改稿前的结论」。
 */
export interface CheckedFrom {
  /** 查的是工作稿还是已定稿正文。 */
  readonly source: "draft" | "committed" | null;
  /** 查的是工作稿哪一版；查的是定稿时没有。 */
  readonly checkedVersion?: string;
}

function checkedFrom(frozen: FrozenChapterText): CheckedFrom {
  return { source: frozen.source, ...(frozen.version !== undefined ? { checkedVersion: frozen.version } : {}) };
}

/* ------------------------------------------------------------------ */
/*  核账                                                                */
/* ------------------------------------------------------------------ */

export type ContinuityCheckOutput = ChapterCheckResult & CheckedFrom;

export async function runContinuityCheck(bookDir: string, frozen: FrozenChapterText, options: ChapterCheckOptions = {}): Promise<ContinuityCheckOutput> {
  const result = await checkChapterBody(bookDir, frozen.chapter, frozen.body.trim(), options);
  return { ...result, ...checkedFrom(frozen) };
}

/**
 * 只拿上次的核账结果（P11）：AI 出稿时已经核过一遍、结果在核账记忆里，就照那份出核账卡；
 * 记忆对不上（出稿后又改过、前文改过）、导入的书还在通读记账就返回 null——不在作者看不见的地方再调一次模型。
 */
export async function cachedContinuityCheck(bookDir: string, chapter: number): Promise<ContinuityCheckOutput | null> {
  const frozen = await freezeChapterText(bookDir, chapter, "continuity");
  if ("missing" in frozen) return null;
  if (await rereadBlocker(bookDir, "核账")) return null;
  if (!(await canReuseCheck(bookDir, chapter, frozen.body.trim()))) return null;
  return runContinuityCheck(bookDir, frozen);
}

/* ------------------------------------------------------------------ */
/*  硬伤检查（确定性，不调模型）                                         */
/* ------------------------------------------------------------------ */

export interface QualityCheckOutput extends CheckedFrom {
  readonly chapter: number;
  readonly ok: boolean;
  /** 有拦定稿的硬伤或严重问题：卡片显「部分完成」，不显绿。 */
  readonly partialMiss: boolean;
  readonly passed: boolean;
  readonly quality: CommitQualityReport;
  readonly refined: RefinedQualityReport;
  readonly errorIssueCount: number;
  readonly summary: string;
}

export async function runQualityCheck(bookDir: string, frozen: FrozenChapterText): Promise<QualityCheckOutput> {
  const quality = await checkDraftBeforeCommit({ projectDir: bookDir, chapter: frozen.chapter, draftContent: frozen.fileText });
  const refined = refineQualityReport(quality);
  const errorIssueCount = refined.blocking.length;
  return {
    chapter: frozen.chapter,
    ok: true,
    partialMiss: errorIssueCount > 0 || refined.severe.length > 0,
    passed: refined.passed,
    quality,
    refined,
    errorIssueCount,
    summary: `第 ${frozen.chapter} 章硬伤检查：${refined.summary}`,
    ...checkedFrom(frozen),
  };
}

/* ------------------------------------------------------------------ */
/*  内容审阅                                                            */
/* ------------------------------------------------------------------ */

export interface ReviewOutput extends CheckedFrom {
  readonly chapter: number;
  /** 走了安全回退（模型不可用、输出不合规）= 没真审成。 */
  readonly ok: boolean;
  readonly review: DraftAIReviewReport;
  readonly usedFallback: boolean;
  /** 服务端实测的正文字数。 */
  readonly actualWordCount: number;
  readonly summary: string;
}

export async function runReview(
  bookDir: string,
  frozen: FrozenChapterText,
  input: { readonly chapterGoal?: string; readonly userDirection?: string; readonly callModel?: (prompt: string) => Promise<string> } = {},
): Promise<ReviewOutput> {
  const result = await runDraftAIReview({
    projectDir: bookDir,
    chapter: frozen.chapter,
    explicitDraftContent: frozen.fileText,
    trustExplicit: true,
    ...(input.chapterGoal !== undefined ? { chapterGoal: input.chapterGoal } : {}),
    ...(input.userDirection !== undefined ? { userDirection: input.userDirection } : {}),
    ...(input.callModel ? { callModel: input.callModel } : {}),
  });
  return { chapter: result.chapter, ok: result.ok, review: result.review, usedFallback: result.usedFallback, actualWordCount: result.actualWordCount, summary: result.summary, ...checkedFrom(frozen) };
}

/* ------------------------------------------------------------------ */
/*  查 AI 味                                                            */
/* ------------------------------------------------------------------ */

export type FlavorOutput = AiFlavorReport & CheckedFrom & { readonly chapter: number };

/**
 * 跨章「前文已建立要素」：设定本里的物品名 + 已确立硬事实，喂给体检模型，免得把前文铺垫过的道具误判成凭空出现。
 * 读不到就是空的，退回只看当前章。
 */
export async function gatherEstablishedElements(bookDir: string, chapter: number): Promise<string[]> {
  const pack = await buildWritingContextPack({ projectDir: bookDir, chapter, userDirection: "", maxTimelineEvents: 3 }).catch(() => undefined);
  if (!pack) return [];
  const assetNames = [...pack.setting.items.map((brief) => brief.name), ...pack.setting.otherNames.items];
  return Array.from(new Set([...assetNames, ...pack.continuityFocus.establishedFacts].map((s) => s.trim()).filter(Boolean))).slice(0, 24);
}

/** draftReview 那一路的模型（流式 + 空闲超时，不设总时长）。 */
async function callFlavorModel(prompt: string): Promise<string> {
  const configured = await resolveConfiguredChatModel("draftReview");
  const { content } = await streamChatModelToText({
    configured,
    messages: [{ role: "user", content: prompt }],
    temperature: configured.profile.temperature ?? 0.3,
    responseFormat: { type: "json_object" },
  });
  if (!content) throw new Error("体检模型返回了空内容。");
  return content;
}

export async function runFlavorCheck(bookDir: string, frozen: FrozenChapterText, callModel: (prompt: string) => Promise<string> = callFlavorModel): Promise<FlavorOutput> {
  const antiRules = await readAntiRules(bookDir);
  const establishedElements = await gatherEstablishedElements(bookDir, frozen.chapter);
  const report = await runAiFlavorCheck({ draftText: frozen.body.trim(), antiRules: antiRules.items, establishedElements, callModel });
  return { ...(antiRules.failure ? { ...report, summary: withAntiRulesNote(report.summary, antiRules.failure) } : report), chapter: frozen.chapter, ...checkedFrom(frozen) };
}
