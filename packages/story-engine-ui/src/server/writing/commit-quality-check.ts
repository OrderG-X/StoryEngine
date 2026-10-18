import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describeErrorBriefly, listCharacterDirectoryEntries, isPlaceholderCharacterName, readCharacterProfile } from "../book/project-store.js";
import { countDraftChineseCharacters, readWritingRulesLengthIntent } from "./draft-length-control.js";
import {
  defaultQualityJudgement,
  userDisplayCategoryForJudgement,
  type JudgedQualityCandidate,
  type QualityAiJudgement,
  type QualityModelJudgeMeta,
  type QualityUserDisplayCategory,
  type RuleQualityCandidate,
} from "./quality-judgement.js";
import type { CharacterProfile } from "../book/types.js";

const DEFAULT_MIN_BODY_CHINESE_CHARACTERS = 300;
const MIN_BODY_CHINESE_CHARACTERS_FLOOR = 80;
const TARGET_WORDS_MIN_RATIO = 0.75;

export interface CommitQualityIssue {
  readonly severity: "info" | "warning" | "error";
  readonly type: string;
  readonly message: string;
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
  const body = stripMarkdownHeadings(content).trim();
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
  if (content && countDraftChineseCharacters(body) < minBodyChineseCharacters) {
    issues.push(
      errorIssue(
        "too_short",
        `Draft body is shorter than ${minBodyChineseCharacters} Chinese characters (current: ${countDraftChineseCharacters(body)}).`,
      ),
    );
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
  const body = stripMarkdownHeadings(content).trim();

  if (content && !hasMarkdownHeading(content)) {
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
  // 只认真名：新书的占位主角（「主角」）和角色 id 不会出现在正文里——拿它们当门，作者没先改名就永远定不了稿
  // （2026-10-10 作者自写验收）。作者自己写的章也可能整章写一个还没登记的人，所以只提醒、不挡定稿。
  const realNames = characterNames.filter((name) => !isPlaceholderCharacterName(name) && !/^char-/u.test(name));
  if (content && realNames.length > 0 && !realNames.some((name) => content.includes(name))) {
    issues.push({ type: "missing_character_name", severity: "warning", message: "Draft does not mention any known character name." });
  }
  return buildQualityReport("draft_quality", issues);
}

/**
 * 定稿长度下限（长跑 2026-10-04 #5b/#4）：
 *  ① 写作规则显式 chapterLength.minWords → 直接作为下限（「至少 N 字」的硬约束本体，不乘系数、不封顶）；
 *    写入侧（foundation-write-gateway）现在会把用户说的「至少/不少于 N 字」自动落进这个字段。
 *  ② 只有 targetWords → 软推导 floor(target×0.75)（地板 80、封顶 300）——目标字数是「约」不是硬约束，
 *     保留 300 封顶（旧契约：默认建书模板自带 targetWords:1800，若按 0.75 全额执法会把所有默认书的
 *     定稿下限抬到 1350，误伤「作者自愿接受短章」的合法流；目标带的宽松执法留给出稿侧 ⚠ 标注）。
 *  ③ 无任何规则 → 默认 300（老书/无规则书行为不变）。
 * severity 维持既有语义：too_short 是 error 级（预览侧进 blockingReasons、CLI 侧阻断入库）。
 */
async function resolveMinBodyChineseCharacters(projectDir: string): Promise<number> {
  // 读盘口径与旧实现逐字保留：ENOENT=老书合法缺文件、空文件=无规则；损坏 JSON 照旧上抛（不静默降级，铁律④）。
  const text = await readFile(join(projectDir, "story", "writing-rules.json"), "utf-8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!text) return DEFAULT_MIN_BODY_CHINESE_CHARACTERS;
  const intent = readWritingRulesLengthIntent(JSON.parse(text));
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

/** 新书种的占位角色名（固定标记）：不是真名，不拿来核对正文。2026-10-13 上移到 project-store 导出共用。 */

async function listCharacterNames(projectDir: string): Promise<{ readonly names: readonly string[]; readonly degradations: readonly string[] }> {
  // 审计 Med：角色目录/资料读取失败不再无痕清空——EACCES 时 names=[] 会让 missing_character_name
  // 门静默跳过（零 warning），降级必须留痕（铁律④）。
  const degradations: string[] = [];
  let entries: readonly import("node:fs").Dirent[] = [];
  try {
    entries = await listCharacterDirectoryEntries(projectDir);
  } catch (error) {
    degradations.push(`角色目录枚举失败（${describeErrorBriefly(error, projectDir)}），角色名门本轮按空角色名执行。`);
  }
  const profiles = await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    // profile 缺失/损坏（空角色目录、被中断的写入）不应崩掉质检——容错跳过并留痕。
    .map((entry) => readCharacterProfile(projectDir, entry.name).catch((error: unknown) => {
      degradations.push(`角色「${entry.name}」资料读取失败（${describeErrorBriefly(error, projectDir)}），已跳过。`);
      return undefined;
    })));
  return { names: unique(profiles.flatMap((profile) => (profile ? nameCandidates(profile) : []))), degradations };
}

function nameCandidates(profile: CharacterProfile): readonly string[] {
  return [profile.name, profile.id]
    .map((value) => value.trim())
    .filter(Boolean);
}

function stripMarkdownHeadings(content: string): string {
  return content
    .split(/\r?\n/u)
    .filter((line) => !/^#{1,6}\s+\S/u.test(line.trim()))
    .join("\n");
}

function hasMarkdownHeading(content: string): boolean {
  return content.split(/\r?\n/u).some((line) => /^#{1,6}\s+\S/u.test(line.trim()));
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
