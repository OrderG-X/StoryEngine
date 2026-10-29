import { parseDraftFile, readCardsOrLegacy } from "@actalk/story-core";
import { describeErrorBriefly } from "../book/project-store.js";
import { countDraftChineseCharacters, lengthRulesOf, readWritingRulesLengthIntent } from "./draft-length-control.js";
import {
  defaultQualityJudgement,
  userDisplayCategoryForJudgement,
  type JudgedQualityCandidate,
  type QualityAiJudgement,
  type QualityModelJudgeMeta,
  type QualityUserDisplayCategory,
  type RuleQualityCandidate,
} from "./quality-judgement.js";

const DEFAULT_MIN_BODY_CHINESE_CHARACTERS = 300;
const MIN_BODY_CHINESE_CHARACTERS_FLOOR = 80;
const TARGET_WORDS_MIN_RATIO = 0.75;

export interface CommitQualityIssue {
  readonly severity: "info" | "warning" | "error";
  readonly type: string;
  readonly message: string;
  /** too_short 带结构化字数：给人看的说法由 quality-report-refine 的 describeQualityIssue 统一出，别从 message 里抠数字。 */
  readonly length?: { readonly min: number; readonly current: number };
  readonly candidateId?: string;
  readonly judgement?: QualityAiJudgement;
  readonly userDisplayCategory?: QualityUserDisplayCategory;
}

export interface CommitQualityReport {
  readonly passed: boolean;
  readonly issues: readonly CommitQualityIssue[];
  readonly candidates?: readonly RuleQualityCandidate[];
  readonly judgedIssues?: readonly JudgedQualityCandidate[];
  readonly modelJudge?: QualityModelJudgeMeta;
}

/**
 * 定稿硬闸（重构 P3）：只挡「这根本不是一章正文」的稿——空的、只有标题、太短、混进了工具 JSON。
 * 语义问题不在这里猜，交给核账员。新定稿链只用这一组；checkDraftBeforeCommit 在它上面再加提醒类检查（质检、审稿在用）。
 */
export async function checkDraftHardGates(input: {
  readonly projectDir: string;
  readonly draftContent: string;
}): Promise<readonly CommitQualityIssue[]> {
  const issues: CommitQualityIssue[] = [];
  const content = input.draftContent.trim();
  // 文件原文只经核心 parseDraftFile 拆一次（写作版本 P1 第 15 轮）：没章名时正文开头的「# 小节」也是正文。
  const body = parseDraftFile(content).body;
  const minBodyChineseCharacters = await resolveMinBodyChineseCharacters(input.projectDir);

  if (!content) {
    issues.push(errorIssue("empty_draft", "Draft content is empty."));
  }
  if (content && looksLikeToolOrJsonArtifact(content)) {
    issues.push(errorIssue("tool_or_json_artifact", "Draft content looks like JSON or a tool-call artifact."));
  }
  if (content && !body) {
    issues.push(errorIssue("title_only", "Draft contains a title but no body content."));
  }
  // 长跑 2026-10-04 #5：计数口径统一 countDraftChineseCharacters（[\u3400-\u9fff] 纯汉字，去标题行）——
  // 与出稿执法（draft-length-control）、UI 写作区显示（countTextWords 同字符集）同源，
  // 不再用自己的 \p{Script=Han} 另算一套（〇/扩展B 等边缘字符三处口径不一致）。
  const bodyChineseCharacters = countDraftChineseCharacters(withoutHeadingLines(body));
  if (content && bodyChineseCharacters < minBodyChineseCharacters) {
    issues.push({
      ...errorIssue(
        "too_short",
        `Draft body is shorter than ${minBodyChineseCharacters} Chinese characters (current: ${bodyChineseCharacters}).`,
      ),
      length: { min: minBodyChineseCharacters, current: bodyChineseCharacters },
    });
  }
  return issues;
}

export async function checkDraftBeforeCommit(input: {
  readonly projectDir: string;
  readonly chapter: number;
  readonly draftContent: string;
}): Promise<CommitQualityReport> {
  const issues: CommitQualityIssue[] = [...(await checkDraftHardGates(input))];
  const content = input.draftContent.trim();
  const { title, body } = parseDraftFile(content);

  if (content && !title) {
    issues.push({
      severity: "warning",
      type: "missing_chapter_title",
      message: "Draft does not contain an obvious chapter title.",
    });
  }
  if (body && !hasDialogue(body)) {
    issues.push({
      severity: "info",
      type: "no_dialogue",
      message: "Draft does not contain obvious dialogue.",
    });
  }

  const { names: characterNames, degradations: characterNameDegradations } = await listCharacterNames(input.projectDir);
  for (const degradation of characterNameDegradations) {
    issues.push({ type: "character_names_degraded", severity: "warning", message: degradation });
  }
  // 作者自己写的章也可能整章写一个还没登记的人，所以只提醒、不挡定稿（2026-10-10 作者自写验收）。
  if (content && characterNames.length > 0 && !characterNames.some((name) => content.includes(name))) {
    issues.push({ type: "missing_character_name", severity: "warning", message: "Draft does not mention any known character name." });
  }
  return buildQualityReport("draft_quality", issues);
}

/**
 * 定稿长度下限（长跑 2026-10-04 #5b/#4）：
 *  ① 写作规则定了每章最少字数 → 直接作为下限（「至少 N 字」的硬约束本体，不乘系数、不封顶，也不垫 300 地板：作者写 30 就按 30）；
 *  ② 只有目标字数 → 软推导 floor(target×0.75)（地板 80、封顶 300）——目标字数是「约」不是硬约束，
 *     目标带的宽松执法留给出稿侧 ⚠ 标注；
 *  ③ 无任何规则 → 默认 300。
 * severity 维持既有语义：too_short 是 error 级（预览侧进 blockingReasons）。设定卡坏了照旧上抛（不静默降级，铁律④）。
 */
async function resolveMinBodyChineseCharacters(projectDir: string): Promise<number> {
  const intent = readWritingRulesLengthIntent(lengthRulesOf((await readCardsOrLegacy(projectDir)).rules));
  if (intent.minWords !== undefined) return intent.minWords;
  // rawTargetWords：只验正数、不归一——保住「targetWords:200 → 下限 150」这类下调门槛的既有行为。
  if (intent.rawTargetWords !== undefined) {
    return Math.min(
      DEFAULT_MIN_BODY_CHINESE_CHARACTERS,
      Math.max(MIN_BODY_CHINESE_CHARACTERS_FLOOR, Math.floor(intent.rawTargetWords * TARGET_WORDS_MIN_RATIO)),
    );
  }
  return DEFAULT_MIN_BODY_CHINESE_CHARACTERS;
}

export function buildQualityReport(
  source: RuleQualityCandidate["source"],
  issues: readonly CommitQualityIssue[],
  modelJudge?: QualityModelJudgeMeta,
): CommitQualityReport {
  const candidates = issues.map((issue, index) => issueToCandidate(issue, source, index));
  const judgedIssues = candidates.map((candidate, index) => {
    const issue = issues[index];
    const judgement = issue?.judgement ?? defaultQualityJudgement(candidate);
    return {
      ...candidate,
      status: "judged" as const,
      judgement,
      userDisplayCategory: issue?.userDisplayCategory ?? userDisplayCategoryForJudgement(judgement),
    };
  });
  const enrichedIssues = issues.map((issue, index) => {
    const candidate = candidates[index];
    const judged = judgedIssues[index];
    return {
      ...issue,
      candidateId: candidate?.id,
      judgement: judged?.judgement,
      userDisplayCategory: judged?.userDisplayCategory,
    };
  });

  return {
    passed: !enrichedIssues.some((issue) => issue.severity === "error" && issue.userDisplayCategory !== "dismissed"),
    issues: enrichedIssues,
    candidates,
    judgedIssues,
    ...(modelJudge ? { modelJudge } : {}),
  };
}

function issueToCandidate(issue: CommitQualityIssue, source: RuleQualityCandidate["source"], index: number): RuleQualityCandidate {
  const candidateId = issue.candidateId ?? `${source}:${issue.type}:${index + 1}`;
  return {
    id: candidateId,
    source,
    type: issue.type,
    message: issue.message,
    evidence: issue.message,
    severityHint: issue.severity === "error" ? "high" : issue.severity === "warning" ? "medium" : "low",
    confidenceHint: issue.severity === "error" ? 0.95 : issue.severity === "warning" ? 0.55 : 0.35,
    status: "candidate",
  };
}

/** 人物卡上的名字和别名（角色名门用）。设定卡读不出来时留痕、本轮按空执行。 */
async function listCharacterNames(projectDir: string): Promise<{ readonly names: readonly string[]; readonly degradations: readonly string[] }> {
  try {
    const cards = await readCardsOrLegacy(projectDir);
    return { names: unique(cards.cards.filter((card) => card.kind === "character").flatMap((card) => [card.name, ...card.aliases])), degradations: [] };
  } catch (error) {
    return { names: [], degradations: [`设定卡读取失败（${describeErrorBriefly(error, projectDir)}），角色名门本轮按空角色名执行。`] };
  }
}

/** 字数不算标题行（全仓同一口径：前端 countTextWords、出稿执法都这样数）。 */
function withoutHeadingLines(body: string): string {
  return body
    .split(/\r?\n/u)
    .filter((line) => !/^#{1,6}\s+\S/u.test(line.trim())) // 章名行白名单：字数口径
    .join("\n");
}

function looksLikeToolOrJsonArtifact(content: string): boolean {
  if (/^(?:\{|\[)/u.test(content)) {
    try {
      JSON.parse(content);
      return true;
    } catch {
      return false;
    }
  }
  return /tool_call|function_call|"arguments"\s*:|"name"\s*:/iu.test(content);
}

function hasDialogue(content: string): boolean {
  return /[“”"']/u.test(content);
}

function errorIssue(type: string, message: string): CommitQualityIssue {
  return {
    severity: "error",
    type,
    message,
  };
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
