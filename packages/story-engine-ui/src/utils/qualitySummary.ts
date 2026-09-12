import type { ChapterAgentCard, DraftQualityReport, JudgedQualityCandidate, QualityAiJudgement } from "../api/types.js";

/**
 * B7 降噪：高召回低精度的纯启发式类目（稀疏白名单 vs 后缀正则全量抽取→必然大量误报）。
 * 这些类目的「待确认」在展示层降为「观察项」（折叠、不进醒目待确认区），只影响显示、不影响入库门禁
 * （门禁只看 error 级，这些都是 warning）。AI 明确 confirmed 的仍保留，尊重高置信判定。引擎规则零改。
 */
const NOISY_HEURISTIC_TYPES: ReadonlySet<string> = new Set<string>([
  "writing_context_required_location_missing",
  "writing_context_location_drift",
  "writing_context_identity_drift",
  "cross_chapter_pronoun_drift",
]);

function effectiveDisplayCategory(item: JudgedQualityCandidate): JudgedQualityCandidate["userDisplayCategory"] {
  if (
    item.userDisplayCategory === "needs_confirmation"
    && typeof item.type === "string"
    && NOISY_HEURISTIC_TYPES.has(item.type)
  ) {
    return "watch";
  }
  return item.userDisplayCategory;
}

export function summarizeDraftQualityReport(quality: DraftQualityReport): {
  readonly confirmed: number;
  readonly needsConfirmation: number;
  readonly watch: number;
  readonly dismissed: number;
  readonly content: string;
  readonly cardStatus: ChapterAgentCard["status"];
  readonly cardTitle: string;
  readonly cardDetail: readonly string[];
} {
  const judgedRaw = quality.judgedIssues ?? quality.issues.map((issue, index): JudgedQualityCandidate => ({
    id: issue.candidateId ?? `issue-${index + 1}`,
    source: "draft_quality",
    message: issue.message,
    evidence: issue.message,
    severityHint: issue.severity === "error" ? "high" : issue.severity === "warning" ? "medium" : "low",
    confidenceHint: issue.severity === "error" ? 0.95 : issue.severity === "warning" ? 0.55 : 0.35,
    status: "judged",
    type: issue.type,
    userDisplayCategory: issue.userDisplayCategory ?? (issue.severity === "error" ? "confirmed" : issue.severity === "warning" ? "needs_confirmation" : "watch"),
    judgement: issue.judgement ?? defaultUiJudgement(issue.candidateId ?? `issue-${index + 1}`, issue.severity),
  }));
  // B7：噪音启发式类目的「待确认」展示层降为「观察项」，再统计/渲染（一次重映射，下游全用降噪后的类目）。
  const judged = judgedRaw.map((item) => ({ ...item, userDisplayCategory: effectiveDisplayCategory(item) }));
  const confirmed = judged.filter((item) => item.userDisplayCategory === "confirmed").length;
  const needsConfirmation = judged.filter((item) => item.userDisplayCategory === "needs_confirmation").length;
  const watch = judged.filter((item) => item.userDisplayCategory === "watch").length;
  const dismissed = judged.filter((item) => item.userDisplayCategory === "dismissed").length;
  const visibleDetails = judged
    .filter((item) => item.userDisplayCategory !== "dismissed")
    .slice(0, 5)
    .map((item) => `${qualityCategoryLabel(item.userDisplayCategory)}｜${qualityIssueDisplayText(item)}：${qualityJudgementExplanation(item.judgement)}`);
  const modelLine = qualityModelLine(quality.modelJudge);
  const content = confirmed === 0 && needsConfirmation === 0
    ? `质检完成：没有确认问题。观察项 ${watch} 个，已忽略 ${dismissed} 个。${modelLine}`
    : `质检完成：确认问题 ${confirmed} 个，待确认 ${needsConfirmation} 个，观察项 ${watch} 个，已忽略 ${dismissed} 个。确认问题建议先修；待确认项需要你判断是不是作者意图。${modelLine}`;
  return {
    confirmed,
    needsConfirmation,
    watch,
    dismissed,
    content,
    cardStatus: confirmed > 0 ? "blocked" : needsConfirmation > 0 ? "needs_confirmation" : "completed",
    cardTitle: confirmed > 0 ? "质检发现确认问题" : needsConfirmation > 0 ? "质检需要作者确认" : "工作稿质检完成",
    cardDetail: visibleDetails.length ? visibleDetails : [modelLine],
  };
}

function qualityModelLine(modelJudge: DraftQualityReport["modelJudge"]): string {
  if (!modelJudge?.used) return "规则未发现候选问题，未调用 AI 判定。";
  if (!modelJudge.fallbackUsed) return `AI 判定模型：${modelJudge.model ?? modelJudge.profileId ?? "qualityCheck"}。`;
  if (modelJudge.error) {
    return `AI 语义判定未完成（${modelJudge.error}）。本轮已按规则候选先分级，可稍后重试或切换更快的质量检查模型。`;
  }
  return "AI 语义判定未完成。本轮已按规则候选先分级，可稍后重试或切换更快的质量检查模型。";
}

function qualityCategoryLabel(category: JudgedQualityCandidate["userDisplayCategory"]): string {
  if (category === "confirmed") return "确认问题";
  if (category === "needs_confirmation") return "待确认";
  if (category === "watch") return "观察项";
  return "已忽略";
}

export function qualityIssueDisplayText(item: Pick<JudgedQualityCandidate, "type" | "message" | "evidence">): string {
  switch (item.type) {
    case "empty_draft":
      return "工作稿为空";
    case "tool_or_json_artifact":
      return "正文里疑似残留工具调用或 JSON";
    case "title_only":
      return "只有标题，没有正文";
    case "too_short":
      return "正文字数少于 300 个中文字符";
    case "model_explanation":
      return "正文里出现模型解释或拒绝语";
    case "missing_chapter_title":
      return "缺少明显章节标题";
    case "no_dialogue":
      return "正文没有明显对话";
    case "missing_character_name":
      return "正文没有出现已登记角色名";
    case "writing_context_required_location_missing":
      return replaceEnglishPrefix(item.message, "Draft does not clearly use required location:", "没有明确使用本章要求地点：");
    case "writing_context_location_drift":
      return replaceEnglishPrefix(item.message, "Draft may invent locations outside Location Bible:", "可能出现未登记地点：");
    case "writing_context_asset_drift":
      return replaceEnglishPrefix(item.message, "Draft may invent assets outside Asset Ledger:", "可能出现未登记道具：");
    case "writing_context_identity_detail_drift":
      return replaceEnglishPrefix(item.message, "Draft may invent unregistered identity details:", "可能写入未登记身份细节：");
    case "writing_context_forbidden_reveal":
      return "可能触碰禁止提前揭开的信息";
    default:
      return translateCommonQualityMessage(item.message);
  }
}

function qualityJudgementExplanation(judgement: QualityAiJudgement | undefined): string {
  const text = judgement?.explanation?.trim();
  if (!text) return "保留为待确认。";
  if (text === "Rule-based structural check marked this candidate as a hard blocker.") {
    return "规则确认这是硬阻断问题。";
  }
  if (text === "Rule-based check found a possible issue that needs context judgement.") {
    return "规则发现可能问题，需要作者结合意图确认。";
  }
  if (text === "Rule-based check found a low-risk watch item.") {
    return "规则发现低风险观察项。";
  }
  return translateCommonQualityMessage(text);
}

function replaceEnglishPrefix(message: string, englishPrefix: string, chinesePrefix: string): string {
  if (!message.startsWith(englishPrefix)) return translateCommonQualityMessage(message);
  return `${chinesePrefix}${message.slice(englishPrefix.length).trim()}`;
}

function translateCommonQualityMessage(message: string): string {
  return message
    .replace(/^Draft content is empty\.$/u, "工作稿为空。")
    .replace(/^Draft content looks like JSON or a tool-call artifact\.$/u, "正文里疑似残留 JSON 或工具调用。")
    .replace(/^Draft contains a title but no body content\.$/u, "工作稿只有标题，没有正文。")
    .replace(/^Draft body is shorter than 300 Chinese characters\.$/u, "正文字数少于 300 个中文字符。")
    .replace(/^Draft contains model explanation or refusal wording\.$/u, "正文里出现模型解释或拒绝语。")
    .replace(/^Draft does not contain an obvious chapter title\.$/u, "缺少明显章节标题。")
    .replace(/^Draft does not contain obvious dialogue\.$/u, "正文没有明显对话。")
    .replace(/^Draft does not mention any known character name\.$/u, "正文没有出现已登记角色名。")
    .replace(/^Draft may invent unregistered identity details:/u, "可能写入未登记身份细节：")
    .replace(/^Draft may invent locations outside Location Bible:/u, "可能出现未登记地点：")
    .replace(/^Draft may invent assets outside Asset Ledger:/u, "可能出现未登记道具：")
    .replace(/^Draft does not clearly use required location:/u, "没有明确使用本章要求地点：");
}

function defaultUiJudgement(candidateId: string, severity: DraftQualityReport["issues"][number]["severity"]): QualityAiJudgement {
  if (severity === "error") {
    return {
      candidateId,
      verdict: "confirmed",
      severity: "high",
      explanation: "规则确认这是硬阻断问题。",
      recommendedAction: "require_confirmation",
    };
  }
  if (severity === "warning") {
    return {
      candidateId,
      verdict: "uncertain",
      severity: "medium",
      explanation: "规则发现可能问题，需要作者结合意图确认。",
      recommendedAction: "ask_user",
    };
  }
  return {
    candidateId,
    verdict: "uncertain",
    severity: "low",
    explanation: "规则发现低风险观察项。",
    recommendedAction: "watch",
  };
}
