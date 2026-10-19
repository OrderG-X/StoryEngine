import type { CommitQualityReport } from "./commit-quality-check.js";
import type { StateOverview } from "../book/state-overview.js";
import type { WritingContextPack } from "./writing-context-pack.js";
import { renderSettingPack } from "./setting-pack.js";

export type DraftAIReviewVerdict = "ready_to_commit" | "needs_minor_revision" | "needs_major_revision" | "blocked";

export type DraftAIReviewIssueCategory =
  | "plot"
  | "pacing"
  | "character"
  | "dialogue"
  | "style"
  | "continuity"
  | "worldbuilding"
  | "reader_hook";

export interface DraftAIReviewIssue {
  readonly id: string;
  readonly severity: "info" | "warning" | "high";
  readonly category: DraftAIReviewIssueCategory;
  readonly title: string;
  readonly description: string;
  readonly evidence: string;
  readonly suggestedFix: string;
  readonly affectedParagraphHint?: string;
}

export interface DraftAIRevisionSuggestion {
  readonly id: string;
  readonly target: string;
  readonly suggestion: string;
  readonly reason: string;
  readonly priority: "low" | "medium" | "high";
}

export interface DraftAIReviewReport {
  readonly passed: boolean;
  readonly score: number;
  readonly verdict: DraftAIReviewVerdict;
  readonly summary: string;
  readonly strengths: readonly string[];
  readonly issues: readonly DraftAIReviewIssue[];
  readonly suggestedRevisions: readonly DraftAIRevisionSuggestion[];
  readonly continuityNotes: readonly string[];
  readonly styleNotes: readonly string[];
  readonly characterNotes: readonly string[];
  readonly pacingNotes: readonly string[];
  readonly readerHookNotes: readonly string[];
  readonly shouldCommit: boolean;
  readonly blockingReasons: readonly string[];
}

export interface BuildDraftAIReviewPromptInput {
  readonly chapter: number;
  readonly draftContent: string;
  readonly chapterGoal?: string;
  readonly userDirection?: string;
  readonly writingContextPack?: WritingContextPack;
  readonly stateOverview?: StateOverview;
  readonly deterministicQuality?: CommitQualityReport;
}

export function buildDraftAIReviewPrompt(input: BuildDraftAIReviewPromptInput): string {
  const pack = input.writingContextPack;
  const overview = input.stateOverview;
  const contextSummary = {
    chapter: input.chapter,
    chapterGoal: input.chapterGoal ?? pack?.chapterTask.currentChapterGoal ?? "",
    userDirection: input.userDirection ?? pack?.chapterTask.userDirection ?? "",
    story: overview ? {
      title: overview.project.title,
      genre: overview.project.genre,
      currentChapter: overview.project.currentChapter,
      storyStatus: overview.storyStatus,
    } : undefined,
    hardConstraints: pack?.hardConstraints,
    continuityFocus: pack?.continuityFocus,
    deterministicQuality: input.deterministicQuality ? {
      passed: input.deterministicQuality.passed,
      issues: input.deterministicQuality.issues.slice(0, 20),
    } : undefined,
  };
  const settingText = pack ? renderSettingPack(pack.setting).join("\n").trim() : "";

  return [
    "你是 StoryEngine-NG 的“审稿老师”，不是写手。",
    "",
    "你的任务：只审当前草稿，评价文学质量、剧情质量、人物表现、节奏、文风、追读感和连续性风险。",
    "",
    "硬性规则：",
    "1. 不改正文，不输出重写全文，不输出整章改写。",
    "2. 不泄露设定里写着还没揭开、不能说破的内容。",
    "3. 不建议让人物知道他此刻不该知道的事。",
    "4. 不建议违反设定卡（人物、地点、物品、规矩）和写作规则。",
    "5. 只给明确、可执行的修改建议。",
    "6. 如果草稿有明显高风险问题，verdict 必须是 needs_major_revision 或 blocked。",
    "7. 输出必须是 JSON 对象，不能有 Markdown 包裹。",
    "8. 给作者看的文字（summary、strengths、issues 的 title/description/evidence 以外的说明、suggestedFix 等）一律写中文自然语言，不得出现上下文里的英文字段名、检查项代码或内部 id（如 deterministicQuality、missing_chapter_title、char-xxx）；要提到某项检查，用中文说它查的是什么（如「自动检查提示缺章节标题」，别说「机械检查」）。",
    "",
    "必须审查：",
    "- 剧情质量：本章事件、冲突、推进、悬念、水文、是否偏离目标。",
    "- 节奏：开头抓人、中段拖沓、信息揭示速度、结尾追读点、场景转换。",
    "- 人物：人设、说话方式、对话自然度、降智、开挂、情绪跳跃。",
    "- 文风：写作规则、是否写成设定说明书、解释过多、细节不足。",
    "- 连续性：上一章承接、设定卡、账里记的现状、已确立事实、谁知道什么。",
    "- 角色连续性必须单独检查：同名人物的他/她、身份、年龄、关系、立场不能前后漂移；正文出现设定本里没有的新人物时指出来（作者可以给他建卡）。",
    "- 设定卡内部一致性必须单独检查：同一张卡里同一属性（年龄/身高/外貌等）写了互斥的取值（如同时写“二十六七岁”和“三十出头”），在 issues 里如实指出（category=character）、不臆断替作者改写；注意区分“看起来X、实际Y”这类合法的观感vs实情描写，不算矛盾。",
    "- 地点/物品连续性必须单独检查：不能把一句动作描述当成地点名；物品此刻在谁手里、在哪，以账里记的现状和前文为准。",
    "- 入库建议：是否建议入库、是否先修改、高风险问题、最需要改的段落。",
    "",
    "JSON 格式：",
    JSON.stringify({
      passed: true,
      score: 82,
      verdict: "ready_to_commit | needs_minor_revision | needs_major_revision | blocked",
      summary: "一句总体结论",
      strengths: ["优点"],
      issues: [{
        id: "issue-1",
        severity: "info | warning | high",
        category: "plot | pacing | character | dialogue | style | continuity | worldbuilding | reader_hook",
        title: "问题标题",
        description: "问题说明",
        evidence: "草稿证据，短引即可",
        suggestedFix: "可执行修改建议",
        affectedParagraphHint: "可选：大致段落位置",
      }],
      suggestedRevisions: [{
        id: "rev-1",
        target: "要改的位置或对象",
        suggestion: "怎么改",
        reason: "为什么",
        priority: "low | medium | high",
      }],
      continuityNotes: ["连续性备注"],
      styleNotes: ["文风备注"],
      characterNotes: ["人物备注"],
      pacingNotes: ["节奏备注"],
      readerHookNotes: ["追读备注"],
      shouldCommit: true,
      blockingReasons: ["阻断原因"],
    }, null, 2),
    "",
    ...(settingText ? ["设定（设定卡 + 账里记的现状）：", settingText, ""] : []),
    "上下文摘要：",
    JSON.stringify(contextSummary, null, 2),
    "",
    "当前草稿正文：",
    input.draftContent,
  ].join("\n");
}

export function parseDraftAIReviewReport(raw: string): DraftAIReviewReport {
  const json = extractJsonObject(raw);
  if (!json) {
    throw new Error("AI review output did not contain a JSON object.");
  }
  return normalizeDraftAIReviewReport(JSON.parse(json) as unknown);
}

export function normalizeDraftAIReviewReport(value: unknown): DraftAIReviewReport {
  if (!isRecord(value)) {
    throw new Error("Draft AI review report root must be an object.");
  }
  const verdict = readVerdict(value.verdict);
  const score = clampScore(readNumber(value.score) ?? (verdict === "ready_to_commit" ? 85 : verdict === "needs_minor_revision" ? 70 : verdict === "needs_major_revision" ? 55 : 35));
  const issues = readIssues(value.issues);
  const blockingReasons = readStringList(value.blockingReasons).slice(0, 12);
  const shouldCommit = typeof value.shouldCommit === "boolean"
    ? value.shouldCommit
    : verdict === "ready_to_commit" || verdict === "needs_minor_revision";
  return {
    passed: typeof value.passed === "boolean" ? value.passed : shouldCommit && verdict !== "blocked",
    score,
    verdict,
    summary: readString(value.summary) ?? "AI 深度审稿已完成。",
    strengths: readStringList(value.strengths).slice(0, 8),
    issues,
    suggestedRevisions: readSuggestions(value.suggestedRevisions),
    continuityNotes: readStringList(value.continuityNotes).slice(0, 8),
    styleNotes: readStringList(value.styleNotes).slice(0, 8),
    characterNotes: readStringList(value.characterNotes).slice(0, 8),
    pacingNotes: readStringList(value.pacingNotes).slice(0, 8),
    readerHookNotes: readStringList(value.readerHookNotes).slice(0, 8),
    shouldCommit,
    blockingReasons,
  };
}

export function fallbackDraftAIReviewReport(reason: string): DraftAIReviewReport {
  return {
    passed: false,
    score: 0,
    verdict: "blocked",
    summary: "AI 深度审稿未能完成，已进入安全回退。",
    strengths: [],
    issues: [{
      id: "ai-review-format-error",
      severity: "high",
      category: "continuity",
      title: "AI 审稿结果不可用",
      description: reason,
      evidence: "模型输出不是合法审稿 JSON，系统没有写入任何正式状态。",
      suggestedFix: "请稍后重试 AI 深度审稿，或先依据快速质检结果人工检查。",
    }],
    suggestedRevisions: [],
    continuityNotes: ["AI 审稿结果不可用；未写正式状态。"],
    styleNotes: [],
    characterNotes: [],
    pacingNotes: [],
    readerHookNotes: [],
    shouldCommit: false,
    blockingReasons: ["AI 深度审稿结果不可用"],
  };
}

function readIssues(value: unknown): readonly DraftAIReviewIssue[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((item, index) => ({
    id: readString(item.id) ?? `issue-${index + 1}`,
    severity: readSeverity(item.severity),
    category: readCategory(item.category),
    title: readString(item.title) ?? "未命名问题",
    description: readString(item.description) ?? "",
    evidence: readString(item.evidence) ?? "",
    suggestedFix: readString(item.suggestedFix) ?? "",
    ...(readString(item.affectedParagraphHint) ? { affectedParagraphHint: readString(item.affectedParagraphHint) } : {}),
  })).slice(0, 30);
}

function readSuggestions(value: unknown): readonly DraftAIRevisionSuggestion[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((item, index) => ({
    id: readString(item.id) ?? `rev-${index + 1}`,
    target: readString(item.target) ?? "草稿",
    suggestion: readString(item.suggestion) ?? "",
    reason: readString(item.reason) ?? "",
    priority: readPriority(item.priority),
  })).slice(0, 20);
}

function readVerdict(value: unknown): DraftAIReviewVerdict {
  return value === "ready_to_commit" || value === "needs_minor_revision" || value === "needs_major_revision" || value === "blocked"
    ? value
    : "needs_minor_revision";
}

function readSeverity(value: unknown): DraftAIReviewIssue["severity"] {
  return value === "high" || value === "warning" || value === "info" ? value : "warning";
}

function readCategory(value: unknown): DraftAIReviewIssueCategory {
  return value === "plot" || value === "pacing" || value === "character" || value === "dialogue" || value === "style" || value === "continuity" || value === "worldbuilding" || value === "reader_hook"
    ? value
    : "plot";
}

function readPriority(value: unknown): DraftAIRevisionSuggestion["priority"] {
  return value === "high" || value === "medium" || value === "low" ? value : "medium";
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readStringList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.map(readString).filter((item): item is string => item !== undefined);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractJsonObject(raw: string): string | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/u);
  if (fenced?.[1]) return fenced[1].trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  return raw.slice(start, end + 1).trim();
}

