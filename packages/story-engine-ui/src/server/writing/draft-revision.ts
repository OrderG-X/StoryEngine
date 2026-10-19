import type { DraftAIReviewIssue, DraftAIRevisionSuggestion } from "./draft-ai-review.js";
import type { StateOverview } from "../book/state-overview.js";
import type { WritingContextPack } from "./writing-context-pack.js";
import { renderSettingPack } from "./setting-pack.js";

export type DraftRevisionTargetType =
  | "paragraph"
  | "section"
  | "dialogue"
  | "opening"
  | "ending"
  | "whole_draft_note";

export type DraftRevisionStatus = "pending" | "preview_generated" | "applied" | "dismissed";

export interface DraftRevisionTask {
  readonly id: string;
  readonly sourceIssueId?: string;
  readonly sourceSuggestionId?: string;
  readonly chapter: number;
  readonly targetType: DraftRevisionTargetType;
  readonly targetText: string;
  readonly targetRangeHint?: string;
  readonly problemSummary: string;
  readonly revisionGoal: string;
  readonly constraints: readonly string[];
  readonly status: DraftRevisionStatus;
}

export interface DraftRevisionPreview {
  readonly taskId: string;
  readonly beforeText: string;
  readonly afterText: string;
  readonly changeSummary: string;
  readonly rationale: string;
  readonly riskNotes: readonly string[];
  readonly preservedFacts: readonly string[];
  readonly warnings: readonly string[];
}

export interface DraftRevisionApplyResult {
  readonly applied: boolean;
  readonly chapter: number;
  readonly draftPath: string;
  readonly updatedWordCount: number;
}

export interface BuildDraftRevisionPromptInput {
  readonly task: DraftRevisionTask;
  readonly draftContent: string;
  readonly writingContextPack?: WritingContextPack;
  readonly stateOverview?: StateOverview;
}

export function createRevisionTaskFromIssue(input: {
  readonly chapter: number;
  readonly issue: DraftAIReviewIssue;
  readonly draftContent: string;
  readonly constraints?: readonly string[];
}): DraftRevisionTask {
  const targetText = findTargetText(input.draftContent, input.issue.evidence);
  return {
    id: `revision-${Date.now().toString(36)}-${input.issue.id}`,
    sourceIssueId: input.issue.id,
    chapter: input.chapter,
    targetType: targetTypeFromIssueCategory(input.issue.category),
    targetText,
    ...(input.issue.affectedParagraphHint ? { targetRangeHint: input.issue.affectedParagraphHint } : {}),
    problemSummary: input.issue.title,
    revisionGoal: input.issue.suggestedFix,
    constraints: input.constraints ?? [],
    status: "pending",
  };
}

export function createRevisionTaskFromSuggestion(input: {
  readonly chapter: number;
  readonly suggestion: DraftAIRevisionSuggestion;
  readonly draftContent: string;
  readonly constraints?: readonly string[];
}): DraftRevisionTask {
  const targetText = findTargetText(input.draftContent, input.suggestion.target);
  return {
    id: `revision-${Date.now().toString(36)}-${input.suggestion.id}`,
    sourceSuggestionId: input.suggestion.id,
    chapter: input.chapter,
    // 改哪种段落不从意见字面猜（重构 P7「不猜」）；原句定位靠 targetRangeHint。
    targetType: "paragraph",
    targetText,
    targetRangeHint: input.suggestion.target,
    problemSummary: input.suggestion.reason,
    revisionGoal: input.suggestion.suggestion,
    constraints: input.constraints ?? [],
    status: "pending",
  };
}

export function buildDraftRevisionPrompt(input: BuildDraftRevisionPromptInput): string {
  const pack = input.writingContextPack;
  const overview = input.stateOverview;
  const contextSummary = {
    chapter: input.task.chapter,
    targetType: input.task.targetType,
    problemSummary: input.task.problemSummary,
    revisionGoal: input.task.revisionGoal,
    constraints: input.task.constraints,
    ...(overview ? { story: { title: overview.project.title, genre: overview.project.genre } } : {}),
    hardConstraints: pack?.hardConstraints,
  };
  const settingText = pack ? renderSettingPack(pack.setting).join("\n").trim() : "";

  return [
    "你是 StoryEngine-NG 的“修订助手”，不是新写手。",
    "",
    "你的任务：只修订指定片段，生成局部修订草案。",
    "",
    "硬性规则：",
    "1. 只修指定片段，不重写全文。",
    "2. 不改变本章核心事件。",
    "3. 不新增设定本里没有的要紧物件，不改变地点的格局。",
    "4. 不让人物知道他此刻不该知道的事。",
    "5. 不提前揭开设定里写着还没揭开、不能说破的内容。",
    "6. 不改变人物的年龄、身份、长期性格或说话方式。",
    "7. 保留原文中有效信息。",
    "8. 如果修订目标或约束明确要求修正代词、称谓、年龄、身份等局部事实，不要以信息不足为理由保持原样；按目标修订片段，并把不确定性写入 riskNotes。",
    "9. 输出必须是 JSON 对象，不能有 Markdown 包裹。",
    "",
    "JSON 格式：",
    JSON.stringify({
      taskId: input.task.id,
      beforeText: input.task.targetText,
      afterText: "修订后的片段",
      changeSummary: "修改了什么",
      rationale: "为什么这样改",
      riskNotes: ["潜在风险"],
      preservedFacts: ["保留的事实"],
      warnings: ["需要用户注意的内容"],
    }, null, 2),
    "",
    ...(settingText ? ["设定（设定卡 + 账里记的现状）：", settingText, ""] : []),
    "上下文摘要：",
    JSON.stringify(contextSummary, null, 2),
    "",
    "当前草稿全文：",
    input.draftContent,
    "",
    "需要修订的原文片段：",
    input.task.targetText,
  ].join("\n");
}

export function parseDraftRevisionPreview(raw: string, task: DraftRevisionTask): DraftRevisionPreview {
  const json = extractJsonObject(raw);
  if (!json) throw new Error("Draft revision output did not contain a JSON object.");
  return normalizeDraftRevisionPreview(JSON.parse(json) as unknown, task);
}

export function normalizeDraftRevisionPreview(value: unknown, task: DraftRevisionTask): DraftRevisionPreview {
  if (!isRecord(value)) {
    throw new Error("Draft revision preview root must be an object.");
  }
  const afterText = readString(value.afterText);
  if (!afterText) {
    throw new Error("Draft revision preview requires afterText.");
  }
  return {
    taskId: readString(value.taskId) ?? task.id,
    beforeText: readString(value.beforeText) ?? task.targetText,
    afterText,
    changeSummary: readString(value.changeSummary) ?? "已生成局部修订草案。",
    rationale: readString(value.rationale) ?? "根据审稿建议进行局部修订。",
    riskNotes: readStringList(value.riskNotes).slice(0, 8),
    preservedFacts: readStringList(value.preservedFacts).slice(0, 8),
    warnings: readStringList(value.warnings).slice(0, 8),
  };
}

export function fallbackDraftRevisionPreview(task: DraftRevisionTask, reason: string): DraftRevisionPreview {
  return {
    taskId: task.id,
    beforeText: task.targetText,
    afterText: task.targetText,
    changeSummary: "修订草案未能生成，已进入安全回退。",
    rationale: "模型输出不可用，系统不会修改草稿。",
    riskNotes: [reason],
    preservedFacts: [],
    warnings: ["未应用任何修改。"],
  };
}

export function applyDraftRevisionToContent(input: {
  readonly draftContent: string;
  readonly beforeText: string;
  readonly afterText: string;
}): string {
  const before = input.beforeText.trim();
  if (!before) {
    throw new Error("修订目标为空，无法应用。");
  }
  const firstIndex = input.draftContent.indexOf(before);
  if (firstIndex < 0) {
    throw new Error("未在当前草稿中找到原文片段，请重新选择目标段落。");
  }
  const secondIndex = input.draftContent.indexOf(before, firstIndex + before.length);
  if (secondIndex >= 0) {
    throw new Error("原文片段在草稿中出现多次，请选择更精确的目标段落。");
  }
  return `${input.draftContent.slice(0, firstIndex)}${input.afterText.trim()}${input.draftContent.slice(firstIndex + before.length)}`;
}

export function countDraftWords(content: string): number {
  const chinese = content.match(/[\p{Script=Han}]/gu)?.length ?? 0;
  const latin = content.replace(/[\p{Script=Han}]/gu, " ").match(/[A-Za-z0-9]+/gu)?.length ?? 0;
  return chinese + latin;
}

function findTargetText(draftContent: string, hint: string): string {
  const cleanedHint = hint.trim().replace(/^["“”'‘’]+|["“”'‘’]+$/gu, "");
  if (cleanedHint && draftContent.includes(cleanedHint)) return cleanedHint;
  const paragraphs = draftContent
    .replace(/\r\n?/gu, "\n")
    .split(/\n{2,}/u)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph && !/^#{1,6}\s+/u.test(paragraph));
  if (cleanedHint) {
    const keyword = cleanedHint.slice(0, Math.min(cleanedHint.length, 16));
    const found = paragraphs.find((paragraph) => paragraph.includes(keyword));
    if (found) return found;
  }
  return paragraphs[0] ?? "";
}

function targetTypeFromIssueCategory(category: DraftAIReviewIssue["category"]): DraftRevisionTargetType {
  if (category === "dialogue") return "dialogue";
  if (category === "reader_hook") return "ending";
  if (category === "pacing") return "section";
  if (category === "character" || category === "style" || category === "continuity") return "paragraph";
  return "paragraph";
}

function extractJsonObject(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/iu)?.[1]?.trim();
  if (fenced?.startsWith("{") && fenced.endsWith("}")) return fenced;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return null;
}


function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(readString).filter((item): item is string => Boolean(item));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
