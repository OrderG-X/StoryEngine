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

export interface BuildDraftRevisionPromptInput {
  readonly task: DraftRevisionTask;
  readonly draftContent: string;
  readonly writingContextPack?: WritingContextPack;
  readonly stateOverview?: StateOverview;
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
    "7. 保留原文中有效信息。改完的片段要和稿里紧挨着它的前一句、后一句连着读顺：前后句刚写过的动作、东西，片段里不要再写一遍（真机试写：前一句「缰绳搭在膝上」，改出来又是「缰绳在膝上搭着」）。",
    "8. 如果修订目标或约束明确要求修正代词、称谓、年龄、身份等局部事实，不要以信息不足为理由保持原样；按目标修订片段，并把不确定性写入 riskNotes。",
    "9. 修订目标、问题说明里的「第 N 章」「前文」「设定」是告诉你出处的，不是故事里的话：afterText 是小说正文，不许写章号，也不许出现「前文」「设定」这类写作用语（真机试写：改出了「第4章那天，是周叔帮着……」）。",
    "10. 输出必须是 JSON 对象，不能有 Markdown 包裹。",
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

function normalizeDraftRevisionPreview(value: unknown, task: DraftRevisionTask): DraftRevisionPreview {
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
