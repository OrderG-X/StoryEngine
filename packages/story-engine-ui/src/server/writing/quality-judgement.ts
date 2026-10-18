export type QualityCandidateSource =
  | "draft_quality"
  | "writing_context"
  | "commit_semantic"
  | "continuity"
  | "foundation_gap"
  | "revision";

export type QualityCandidateSeverityHint = "low" | "medium" | "high";
export type QualityCandidateStatus = "candidate" | "judged";
export type QualityAiJudgementVerdict = "confirmed" | "uncertain" | "dismissed" | "author_intent";
export type QualityAiJudgementSeverity = "none" | "low" | "medium" | "high";
export type QualityAiJudgementAction = "ignore" | "watch" | "ask_user" | "revise" | "require_confirmation";
export type QualityUserDisplayCategory = "confirmed" | "needs_confirmation" | "watch" | "dismissed";

export interface RuleQualityCandidate {
  readonly id: string;
  readonly source: QualityCandidateSource;
  readonly type: string;
  readonly message: string;
  readonly evidence: string;
  readonly severityHint: QualityCandidateSeverityHint;
  readonly confidenceHint: number;
  readonly status: QualityCandidateStatus;
  readonly contextHint?: string;
}

export interface QualityAiJudgement {
  readonly candidateId: string;
  readonly verdict: QualityAiJudgementVerdict;
  readonly severity: QualityAiJudgementSeverity;
  readonly explanation: string;
  readonly recommendedAction: QualityAiJudgementAction;
}

export interface JudgedQualityCandidate extends RuleQualityCandidate {
  readonly status: "judged";
  readonly judgement: QualityAiJudgement;
  readonly userDisplayCategory: QualityUserDisplayCategory;
}

export interface QualityModelJudgeMeta {
  readonly used: boolean;
  readonly fallbackUsed: boolean;
  readonly profileId?: string;
  readonly model?: string;
  readonly error?: string;
  readonly summary?: string;
}

export function defaultQualityJudgement(candidate: RuleQualityCandidate): QualityAiJudgement {
  if (candidate.severityHint === "high") {
    return {
      candidateId: candidate.id,
      verdict: "confirmed",
      severity: "high",
      explanation: "Rule-based structural check marked this candidate as a hard blocker.",
      recommendedAction: "require_confirmation",
    };
  }
  if (candidate.severityHint === "medium") {
    return {
      candidateId: candidate.id,
      verdict: "uncertain",
      severity: "medium",
      explanation: "Rule-based check found a possible issue that needs context judgement.",
      recommendedAction: "ask_user",
    };
  }
  return {
    candidateId: candidate.id,
    verdict: "uncertain",
    severity: "low",
    explanation: "Rule-based check found a low-risk watch item.",
    recommendedAction: "watch",
  };
}

export function userDisplayCategoryForJudgement(judgement: QualityAiJudgement): QualityUserDisplayCategory {
  if (judgement.verdict === "dismissed" || judgement.verdict === "author_intent" || judgement.severity === "none") {
    return "dismissed";
  }
  if (judgement.verdict === "confirmed") {
    return "confirmed";
  }
  if (judgement.recommendedAction === "ask_user" || judgement.recommendedAction === "require_confirmation") {
    return "needs_confirmation";
  }
  return "watch";
}
