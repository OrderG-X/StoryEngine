import { createHash } from "node:crypto";
import type { ContextSection, WriterContextEnvelope } from "./context-gateway.js";

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
    "正文开头必须是 markdown 章节标题，格式：# 第N章 · 标题。",
    "标题由你根据本章正文自然拟定，必须存在，但不要剧透 protectedSecrets / forbiddenReveals，也不要提前揭开 unknownTruths。",
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
  return sections.map((section) => [
    ...(section.name === "writing_context_pack" ? renderWritingContextHardConstraints(section.content) : []),
    `## ${section.name}`,
    JSON.stringify(section.content, null, 2),
  ].join("\n")).join("\n\n");
}

function renderWritingContextHardConstraints(content: unknown): readonly string[] {
  const record = typeof content === "object" && content !== null ? (content as Record<string, unknown>) : undefined;
  const out: string[] = [];

  const constraints = record?.["hardConstraints"];
  if (Array.isArray(constraints)) {
    const lines = constraints.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    if (lines.length > 0) {
      out.push("## 本章硬约束", ...lines.map((line) => `- ${line}`), "");
    }
  }

  // 作者自定写作规矩（customNotes·自由 Markdown）：从 writingRulesContext 提到 prompt 顶层人类可读处，
  // 而非只埋在下方 JSON 里被转义——它是用户的全局写作规矩，模型每次都要照着写。受控破例⑧。
  const writingRulesContext = record?.["writingRulesContext"];
  const customNotes = typeof writingRulesContext === "object" && writingRulesContext !== null
    ? (writingRulesContext as { readonly customNotes?: unknown }).customNotes
    : undefined;
  if (typeof customNotes === "string" && customNotes.trim().length > 0) {
    out.push("## 作者自定写作规矩（务必遵守）", customNotes.trim(), "");
  }

  // 作者文风样本（styleExemplars·正向锚）：与 customNotes 同样提到 prompt 顶层人类可读处——
  // 风格样本赢过风格描述；文案必须同时钉住「模仿风格」与「不得照抄内容/情节/名物」两头，
  // 防模型把样本里的具体情节名物搬进正文。
  const styleExemplarsRaw = typeof writingRulesContext === "object" && writingRulesContext !== null
    ? (writingRulesContext as { readonly styleExemplars?: unknown }).styleExemplars
    : undefined;
  const styleExemplars = Array.isArray(styleExemplarsRaw)
    ? styleExemplarsRaw.filter((item): item is { readonly title: string; readonly text: string; readonly note?: string } =>
      typeof item === "object" && item !== null
      && typeof (item as { readonly title?: unknown }).title === "string"
      && (item as { readonly title: string }).title.trim().length > 0
      && typeof (item as { readonly text?: unknown }).text === "string"
      && (item as { readonly text: string }).text.trim().length > 0)
    : [];
  if (styleExemplars.length > 0) {
    out.push(
      "## 作者文风样本（模仿风格·不得照抄内容）",
      "以下是作者文风样本：模仿其句法节奏、用词偏好与叙事温度；不得照抄样本内容、情节或具体名物。",
      ...styleExemplars.flatMap((item, index) => [
        `### 样本${index + 1} · ${item.title.trim()}`,
        ...(typeof item.note === "string" && item.note.trim() ? [`（注：${item.note.trim()}）`] : []),
        item.text.trim(),
        "",
      ]),
    );
  }

  return out;
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
