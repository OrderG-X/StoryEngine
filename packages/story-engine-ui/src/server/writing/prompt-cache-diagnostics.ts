import { createHash } from "node:crypto";
import type { ContextSection, WriterContextEnvelope, WritingContextPack } from "./context-gateway.js";
import { renderSettingPack } from "./setting-pack.js";

export interface PromptFingerprint {
  readonly fullPromptHash: string;
  readonly stablePrefixHash: string | null;
  readonly dynamicSuffixHash: string | null;
  readonly promptSectionOrder: readonly string[];
  readonly stableSections: readonly string[];
  readonly dynamicSections: readonly string[];
  readonly unknownSections: readonly string[];
  readonly firstDynamicSectionIndex: number | null;
  readonly firstDynamicCharOffset: number | null;
  readonly firstDynamicSectionName: string | null;
  readonly estimatedStablePrefixChars: number;
  readonly estimatedStablePrefixRatio: number;
}

export interface PromptDifference {
  readonly firstDiffCharOffset: number | null;
  readonly leftSnippet: string;
  readonly rightSnippet: string;
}

const FAST_DRAFT_PROTOCOL_SECTION = "fast_draft_protocol";
const CHAPTER_SECTION = "Chapter";

export function renderFastDraftPromptText(envelope: WriterContextEnvelope): string {
  const stableSections = envelope.sections.filter((section) => section.cachePolicy === "stable");
  const dynamicSections = envelope.sections.filter((section) => section.cachePolicy !== "stable");
  const stableText = renderSections(stableSections);
  const dynamicText = renderSections(dynamicSections);
  return [
    "You are the StoryEngine-NG FastDraft writer.",
    "Write only the chapter body.",
    "Do not include explanations, analysis, JSON, markdown metadata, or tool calls.",
    "Do not update state, timeline, world, hooks, or calendar.",
    "Use only the structured context sections below.",
    "Follow the 本章硬约束 section before any stylistic preference.",
    "If the previous_uncommitted_draft section exists, treat it as the immediate previous chapter even though it is not formal state; preserve protagonist identity, pronouns, scene facts, and unresolved pressure from it.",
    "If the chapter_plan section exists, write this chapter by its beats in order; every beat must actually happen on the page, and its newInformation must be stated explicitly. If the earlier_passages section exists, those are verbatim passages from earlier chapters about the objects/places this chapter involves: keep their state and wording consistent.",
    "If the already_written section exists, it is the first half of THIS chapter, already written: continue right after its last sentence; never rewrite, summarize or repeat it, and do not write a title.",
    "If the previous_chapter section exists, it is the verbatim text of the immediately previous chapter. Continue from where it ends; every object's state and location, every character's whereabouts, and who-knows-what must match it; never re-discover or redo what already happened there — move the story forward.",
    "正文开头必须是 markdown 章节标题，格式：# 第N章 · 标题。N 用阿拉伯数字，等于本章章号。",
    "标题由你根据本章正文自然拟定，必须存在，但不要剧透设定里写着还没揭开、不能说破的内容。如给出 chapter_titles 段（本书已有各章标题），不要起与之重复的标题。",
    "连续章节必须避免重复上一章开头场面、首句结构和人物进场方式；除非用户明确要求原地续接，否则用新的动作、时间点或压力源切入。",
    "",
    stableText,
    "",
    `Chapter: ${envelope.chapter}`,
    dynamicText,
  ].filter((part) => part !== "").join("\n");
}

export function buildPromptFingerprint(envelope: WriterContextEnvelope, prompt = renderFastDraftPromptText(envelope)): PromptFingerprint {
  const stableContextSections = envelope.sections.filter((section) => section.cachePolicy === "stable").map((section) => section.name);
  const dynamicContextSections = envelope.sections.filter((section) => section.cachePolicy === "dynamic").map((section) => section.name);
  const unknownContextSections = envelope.sections
    .filter((section) => section.cachePolicy !== "stable" && section.cachePolicy !== "dynamic")
    .map((section) => section.name);
  const promptSectionOrder = [
    FAST_DRAFT_PROTOCOL_SECTION,
    ...stableContextSections,
    CHAPTER_SECTION,
    ...dynamicContextSections,
    ...unknownContextSections,
  ];
  const stableSections = [
    FAST_DRAFT_PROTOCOL_SECTION,
    ...stableContextSections,
  ];
  const dynamicSections = [
    CHAPTER_SECTION,
    ...dynamicContextSections,
  ];
  const unknownSections = unknownContextSections;
  const firstDynamic = firstDynamicSection(envelope.sections);
  const firstDynamicCharOffset = firstDynamic
    ? prompt.indexOf(firstDynamic.marker)
    : null;
  const stablePrefix = typeof firstDynamicCharOffset === "number" && firstDynamicCharOffset >= 0
    ? prompt.slice(0, firstDynamicCharOffset)
    : prompt;
  const dynamicSuffix = typeof firstDynamicCharOffset === "number" && firstDynamicCharOffset >= 0
    ? prompt.slice(firstDynamicCharOffset)
    : "";

  return {
    fullPromptHash: sha256(prompt),
    stablePrefixHash: stablePrefix ? sha256(stablePrefix) : null,
    dynamicSuffixHash: dynamicSuffix ? sha256(dynamicSuffix) : null,
    promptSectionOrder,
    stableSections,
    dynamicSections,
    unknownSections,
    firstDynamicSectionIndex: firstDynamic?.sectionIndex ?? null,
    firstDynamicCharOffset: typeof firstDynamicCharOffset === "number" && firstDynamicCharOffset >= 0 ? firstDynamicCharOffset : null,
    firstDynamicSectionName: firstDynamic?.sectionName ?? null,
    estimatedStablePrefixChars: Math.max(0, typeof firstDynamicCharOffset === "number" && firstDynamicCharOffset >= 0 ? firstDynamicCharOffset : prompt.length),
    estimatedStablePrefixRatio: ratio(stablePrefix.length, prompt.length),
  };
}

export function findFirstPromptDifference(left: string, right: string, contextRadius = 30): PromptDifference {
  const limit = Math.min(left.length, right.length);
  for (let index = 0; index < limit; index += 1) {
    if (left[index] !== right[index]) {
      return {
        firstDiffCharOffset: index,
        leftSnippet: snippet(left, index, contextRadius),
        rightSnippet: snippet(right, index, contextRadius),
      };
    }
  }
  if (left.length !== right.length) {
    return {
      firstDiffCharOffset: limit,
      leftSnippet: snippet(left, limit, contextRadius),
      rightSnippet: snippet(right, limit, contextRadius),
    };
  }
  return {
    firstDiffCharOffset: null,
    leftSnippet: "",
    rightSnippet: "",
  };
}

function firstDynamicSection(sections: readonly ContextSection[]): {
  readonly sectionName: string;
  readonly sectionIndex: number;
  readonly marker: string;
} | undefined {
  const stableCount = sections.filter((section) => section.cachePolicy === "stable").length;
  return {
    sectionName: CHAPTER_SECTION,
    sectionIndex: stableCount + 1,
    marker: "Chapter:",
  };
}

function renderSections(sections: readonly ContextSection[]): string {
  return sections.map((section) => (section.name === "writing_context_pack"
    ? renderWritingContextPack(section.content as WritingContextPack)
    : [`## ${section.name}`, JSON.stringify(section.content, null, 2)]).join("\n")).join("\n\n");
}

/**
 * 写作上下文包：硬约束放最前（模型先守它再管文风），设定（规矩、文风样本、设定卡）渲染成文字，
 * 其余（本章任务、接着写要扛住的线）照旧给 JSON。
 */
function renderWritingContextPack(pack: WritingContextPack): string[] {
  const { setting, hardConstraints, ...rest } = pack;
  const constraints = hardConstraints.filter((line) => line.trim().length > 0);
  return [
    ...(constraints.length > 0 ? ["## 本章硬约束", ...constraints.map((line) => `- ${line}`), ""] : []),
    ...renderSettingPack(setting),
    "## writing_context_pack",
    JSON.stringify(rest, null, 2),
  ];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function ratio(part: number, total: number): number {
  if (total <= 0) return 0;
  return Number((part / total).toFixed(6));
}

function snippet(value: string, index: number, radius: number): string {
  const start = Math.max(0, index - radius);
  const end = Math.min(value.length, index + radius);
  return value.slice(start, end);
}
