import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { CommitDraftInput } from "./commit-engine.js";
import { readCharacterProfile } from "./project-store.js";
import {
  defaultQualityJudgement,
  userDisplayCategoryForJudgement,
  type JudgedQualityCandidate,
  type QualityAiJudgement,
  type QualityModelJudgeMeta,
  type QualityUserDisplayCategory,
  type RuleQualityCandidate,
} from "./quality-judgement.js";
import type { CharacterProfile } from "./types.js";
import { buildWritingContextPack, type WritingContextPack } from "./writing-context-pack.js";

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

export async function checkDraftBeforeCommit(input: {
  readonly projectDir: string;
  readonly chapter: number;
  readonly draftContent: string;
}): Promise<CommitQualityReport> {
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
  if (content && countChineseCharacters(body) < minBodyChineseCharacters) {
    issues.push(errorIssue("too_short", `Draft body is shorter than ${minBodyChineseCharacters} Chinese characters.`));
  }
  if (content && containsModelExplanation(content)) {
    issues.push(errorIssue("model_explanation", "Draft contains model explanation or refusal wording."));
  }
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

  const characterNames = await listCharacterNames(input.projectDir);
  if (content && characterNames.length > 0 && !characterNames.some((name) => content.includes(name))) {
    issues.push(errorIssue("missing_character_name", "Draft does not mention any known character name."));
  }
  if (content) {
    // P2 铁律④：上下文包构造失败时此前静默跳过连续性检查——检查于是「通过」了，却没查任何东西，
    // 给用户假的安全感。降级仍要（不能让一次坏读盘堵死入库），但必须留 warning 说明「没查」。
    const writingContextPack = await buildWritingContextPack({
      projectDir: input.projectDir,
      chapter: input.chapter,
      userDirection: "",
      maxTimelineEvents: 3,
    }).catch((error) => {
      issues.push({
        type: "continuity_check_skipped",
        message: `连续性检查已跳过：上下文构造失败（${error instanceof Error ? error.message : String(error)}）。入库仍可进行，但未校验与前文的一致性。`,
        severity: "warning",
      });
      return undefined;
    });
    if (writingContextPack) {
      issues.push(...checkWritingContextPackDraft(body, writingContextPack, input.chapter));
    }
    // 与上面同口径（铁律④）：人称漂移检查读盘失败时不能静默跳过——不然「没查」被当成「查了没问题」。
    // 降级仍要（不堵死入库），但留 warning 说明「没查」。
    const pronounDriftIssues = await findCrossChapterPronounDrift({
      projectDir: input.projectDir,
      chapter: input.chapter,
      draftBody: body,
      knownNames: characterNames,
    }).catch((error) => {
      issues.push({
        type: "pronoun_drift_check_skipped",
        message: `人称漂移检查已跳过：跨章比对失败（${error instanceof Error ? error.message : String(error)}）。入库仍可进行，但未校验人称一致性。`,
        severity: "warning",
      });
      return [];
    });
    issues.push(...pronounDriftIssues);
  }

  return buildQualityReport("draft_quality", issues);
}

async function resolveMinBodyChineseCharacters(projectDir: string): Promise<number> {
  const targetWords = await readWritingRuleTargetWords(projectDir);
  if (targetWords === undefined) return DEFAULT_MIN_BODY_CHINESE_CHARACTERS;
  return Math.min(
    DEFAULT_MIN_BODY_CHINESE_CHARACTERS,
    Math.max(MIN_BODY_CHINESE_CHARACTERS_FLOOR, Math.floor(targetWords * TARGET_WORDS_MIN_RATIO)),
  );
}

async function readWritingRuleTargetWords(projectDir: string): Promise<number | undefined> {
  const text = await readFile(join(projectDir, "story", "writing-rules.json"), "utf-8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!text) return undefined;
  const parsed = JSON.parse(text) as unknown;
  if (!isRecord(parsed) || !isRecord(parsed.chapterLength)) return undefined;
  const value = parsed.chapterLength.targetWords;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function checkWritingContextPackDraft(
  draftBody: string,
  pack: WritingContextPack,
  chapter: number,
): readonly CommitQualityIssue[] {
  const issues: CommitQualityIssue[] = [];
  const requiredLocation = pack.locationContext.requiredCurrentLocation;
  if (requiredLocation && !containsLocationReference(draftBody, requiredLocation)) {
    issues.push({
      severity: "warning",
      type: "writing_context_required_location_missing",
      message: `Draft does not clearly use required location: ${requiredLocation}.`,
    });
  }

  const locationDrift = findLocationDrift(draftBody, pack);
  if (locationDrift.length > 0) {
    issues.push({
      severity: "warning",
      type: "writing_context_location_drift",
      message: `Draft may invent locations outside Location Bible: ${locationDrift.join("；")}.`,
    });
  }

  const forbiddenRevealHits = matchingPhrases(draftBody, [
    ...pack.worldRulesContext.protectedSecrets,
    ...pack.worldRulesContext.hiddenTruths,
    ...pack.protagonistContext.forbiddenReveals,
  ]);
  if (forbiddenRevealHits.length > 0) {
    issues.push({
      severity: "warning",
      type: "writing_context_forbidden_reveal",
      message: `Draft mentions protected reveal terms: ${forbiddenRevealHits.join("；")}.`,
    });
  }

  const unknownTruthHits = matchingPhrases(draftBody, pack.protagonistContext.unknownTruths);
  if (unknownTruthHits.length > 0) {
    issues.push({
      severity: "warning",
      type: "writing_context_knowledge_boundary",
      message: `Draft may let protagonist access unknown truths: ${unknownTruthHits.join("；")}.`,
    });
  }

  const setupAssets = unique([
    ...pack.assetContext.initialAssets,
    ...pack.assetContext.keyItems,
    ...pack.assetContext.resourceLimits,
  ]);
  if (setupAssets.length > 0 && !setupAssets.some((asset) => containsAssetReference(draftBody, asset))) {
    issues.push({
      severity: "warning",
      type: "writing_context_setup_asset_missing",
      message: "Draft does not mention any setup asset or resource limit.",
    });
  }

  const identityDrift = findIdentityDetailDrift(draftBody, pack);
  if (identityDrift.length > 0) {
    issues.push({
      severity: "warning",
      type: "writing_context_identity_detail_drift",
      message: `Draft may invent unregistered identity details: ${identityDrift.join("；")}.`,
    });
  }

  const travelViolations = findTravelRuleViolations(draftBody, pack);
  if (travelViolations.length > 0) {
    issues.push({
      severity: "warning",
      type: "writing_context_travel_rule_violation",
      message: `Draft may violate travel rules: ${travelViolations.join("；")}.`,
    });
  }

  const floorStructureWarnings = findFloorStructureWarnings(draftBody, pack);
  if (floorStructureWarnings.length > 0) {
    issues.push({
      severity: "warning",
      type: "writing_context_floor_structure_conflict",
      message: `正文出现未登记楼层/建筑总层数描述：${floorStructureWarnings.join("；")}。请确认是否需要补充地点结构。`,
    });
  }

  const unavailableAssetViolations = findUnavailableAssetViolations(draftBody, pack);
  if (unavailableAssetViolations.length > 0) {
    issues.push({
      severity: "warning",
      type: "writing_context_unavailable_asset_used",
      message: `Draft may use unavailable assets incorrectly: ${unavailableAssetViolations.join("；")}.`,
    });
  }

  const protagonistName = pack.protagonistContext.name?.trim();
  if (pack.protagonistContext.age && draftBody.includes(pack.protagonistContext.age) === false) {
    // 只算与登记年龄不同、且「主角名附近(±12字)」或「自指(自己/我 X岁)」的年龄——
    // 别的角色的年龄（如"四十多岁的男人/六十岁的老者"，纯描写、无自指无主角名）不是主角漂移（实测高误报）。
    const drift: string[] = [];
    for (const match of draftBody.matchAll(/[一二两三四五六七八九十\d]{1,3}\s*岁/gu)) {
      const age = match[0].replace(/\s+/gu, "");
      if (age === pack.protagonistContext.age) continue;
      const at = match.index ?? 0;
      const window = draftBody.slice(Math.max(0, at - 12), at + match[0].length + 12);
      if ((protagonistName && window.includes(protagonistName)) || /自己|我/u.test(window)) drift.push(age);
    }
    if (drift.length > 0) {
      issues.push({
        severity: "warning",
        type: "writing_context_age_drift",
        message: `Draft may drift character age: ${unique(drift).slice(0, 4).join("；")}.`,
      });
    }
  }

  const shortDialogueCount = Array.from(draftBody.matchAll(/[“"][^”"]{1,3}[”"]/gu)).length;
  const dialogueCount = Array.from(draftBody.matchAll(/[“"][^”"]+[”"]/gu)).length;
  if (pack.protagonistContext.speechSamples.length > 0 && shortDialogueCount >= 3 && dialogueCount > 0 && shortDialogueCount / dialogueCount > 0.75) {
    issues.push({
      severity: "warning",
      type: "writing_context_speech_style_risk",
      message: "Draft has very short dialogue; check it against speech samples.",
    });
  }

  if (chapter === 1 && pack.chapterTask.firstChapterGoal) {
    const firstChapterTerms = [
      pack.chapterTask.firstChapterGoal,
      pack.chapterTask.openingScene,
      pack.chapterTask.firstHook,
      pack.chapterTask.firstConflict,
    ].filter((item): item is string => Boolean(item));
    if (firstChapterTerms.length > 0 && !firstChapterTerms.some((term) => containsFuzzyReference(draftBody, term))) {
      issues.push({
        severity: "warning",
        type: "writing_context_first_chapter_setup_missing",
        message: "Draft does not clearly use firstChapterSetup.",
      });
    }
  }

  return issues;
}

export function checkCommitPlanSemanticQuality(
  commitPlan: CommitDraftInput["commitPlan"],
): CommitQualityReport {
  const issues: CommitQualityIssue[] = [];
  const timelineEvents = commitPlan.timelineEvents ?? [];

  for (const [index, event] of timelineEvents.entries()) {
    if (isSystemTimelineSummary(event.summary)) {
      issues.push({
        severity: "warning",
        type: "semantic_timeline_summary_generic",
        message: `Timeline event ${index + 1} summary looks like a system commit description instead of story content.`,
      });
    }
    const semanticSummary = event.effects?.semanticSummary;
    if (!hasNonEmptyStringProperty(semanticSummary, "chapterSummary")) {
      issues.push({
        severity: "warning",
        type: "semantic_chapter_summary_missing",
        message: `Timeline event ${index + 1} semantic summary is missing chapterSummary.`,
      });
    }
    if (!hasNonEmptyArrayProperty(semanticSummary, "keyEvents")) {
      issues.push({
        severity: "warning",
        type: "semantic_key_events_missing",
        message: `Timeline event ${index + 1} semantic summary has no keyEvents.`,
      });
    }
  }

  if (timelineEvents.length === 0) {
    issues.push({
      severity: "warning",
      type: "semantic_timeline_missing",
      message: "Commit plan has no timeline events to carry story history forward.",
    });
  }

  return buildQualityReport("commit_semantic", issues);
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

async function listCharacterNames(projectDir: string): Promise<readonly string[]> {
  const entries = await readdir(join(projectDir, "characters"), { withFileTypes: true }).catch(() => []);
  const profiles = await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    // profile 缺失/损坏（空角色目录、被中断的写入）不应崩掉质检——容错跳过（对齐 writing-context-pack 的 .catch）。
    .map((entry) => readCharacterProfile(projectDir, entry.name).catch(() => undefined)));
  return unique(profiles.flatMap((profile) => (profile ? nameCandidates(profile) : [])));
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

function containsModelExplanation(content: string): boolean {
  const normalized = content.trim();
  return [
    /(?:^|\n)\s*(?:以下是|下面是)(?:本章|第[一二三四五六七八九十百\d]+章|修改后|修订后|续写|正文|草稿)/u,
    /作为(?:一个)?\s*AI/u,
    /我(?:无法|不能)(?:协助|提供|完成|继续|生成|写作|创作)/u,
  ].some((pattern) => pattern.test(normalized));
}

function isSystemTimelineSummary(value: string): boolean {
  return /草稿被提交|正式章节|章节完成|提交草稿|commit|draft/iu.test(value);
}

function hasNonEmptyStringProperty(value: unknown, key: string): boolean {
  if (typeof value !== "object" || value === null || !(key in value)) return false;
  const property = (value as Record<string, unknown>)[key];
  return typeof property === "string" && property.trim().length > 0;
}

function hasNonEmptyArrayProperty(value: unknown, key: string): boolean {
  if (typeof value !== "object" || value === null || !(key in value)) return false;
  const property = (value as Record<string, unknown>)[key];
  return Array.isArray(property) && property.length > 0;
}

function hasDialogue(content: string): boolean {
  return /[“”"']/u.test(content);
}

function splitSentences(content: string): readonly string[] {
  return content
    .split(/(?<=[。！？!?])\s*|\n+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

async function findCrossChapterPronounDrift(input: {
  readonly projectDir: string;
  readonly chapter: number;
  readonly draftBody: string;
  readonly knownNames: readonly string[];
}): Promise<readonly CommitQualityIssue[]> {
  if (input.chapter <= 1 || !input.draftBody.trim()) return [];
  const priorText = await readPriorFormalChapters(input.projectDir, input.chapter);
  if (!priorText.trim()) return [];
  const candidateNames = unique([
    ...input.knownNames,
    ...extractPronounNameCandidates(priorText),
    ...extractPronounNameCandidates(input.draftBody),
  ]).filter((name) => name.length >= 2 && name.length <= 4 && !isPronounNameNoise(name));
  const issues: CommitQualityIssue[] = [];
  for (const name of candidateNames) {
    if (!priorText.includes(name) || !input.draftBody.includes(name)) continue;
    const prior = inferNamePronounUsage(priorText, name);
    const current = inferNamePronounUsage(input.draftBody, name);
    if (!prior.gender || !current.gender || prior.gender === current.gender) continue;
    issues.push({
      severity: "warning",
      type: "cross_chapter_pronoun_drift",
      message: `角色称谓可能漂移：${name} 之前按${genderText(prior.gender)}叙述，本章出现${genderText(current.gender)}叙述。请确认是否写错“他/她”。前文证据：${trimForIssue(prior.evidence ?? "")}；本章证据：${trimForIssue(current.evidence ?? "")}`,
    });
  }
  return issues.slice(0, 6);
}

async function readPriorFormalChapters(projectDir: string, chapter: number): Promise<string> {
  const texts = await Promise.all(Array.from({ length: chapter - 1 }, async (_, index) => {
    const chapterNumber = index + 1;
    return readFile(join(projectDir, "chapters", `${String(chapterNumber).padStart(4, "0")}.md`), "utf-8")
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "";
        throw error;
      });
  }));
  return texts.join("\n\n");
}

function extractPronounNameCandidates(content: string): readonly string[] {
  const names: string[] = [];
  const patterns = [
    /([\u4e00-\u9fa5]{2,4})(?:说|问|提醒|低声|站在|看着|拍了拍|递给|把|将|头也没抬|终于|开口|走出|走来|出现|拒绝|皱眉|点头|摇头)/gu,
    /“[^”]{1,100}”\s*([\u4e00-\u9fa5]{2,4})(?:说|问|提醒|低声|开口)/gu,
    /([\u4e00-\u9fa5]{2,4})的(?:声音|目光|手|脸|背影|胸牌|工牌|工位|座位)/gu,
  ] as const;
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    for (const match of content.matchAll(pattern)) {
      const name = (match[1] ?? "").trim();
      if (name) names.push(name);
    }
  }
  return unique(names);
}

function inferNamePronounUsage(content: string, name: string): { readonly gender?: "male" | "female"; readonly evidence?: string } {
  for (const context of collectNameSentencePairs(content, name)) {
    if (!isNameSubjectLike(context.sentence, name)) continue;
    if (/^(?:她|她的)/u.test(context.nextSentence)) return { gender: "female", evidence: `${context.sentence}${context.nextSentence}` };
    if (/^(?:他|他的)/u.test(context.nextSentence)) return { gender: "male", evidence: `${context.sentence}${context.nextSentence}` };
  }
  let maleEvidence: string | undefined;
  let femaleEvidence: string | undefined;
  for (const context of collectNameSentencePairs(content, name)) {
    if (!femaleEvidence && new RegExp(`${escapeRegExp(name)}[^。！？\\n]{0,80}[，,；;]\\s*她(?!的)(?:把|说|问|提醒|低声|看|点|摇|皱|拍|示意|开口|走|站|递|拿|转|没有|不|也|已经|正在)`, "u").test(context.sentence)) {
      femaleEvidence = context.sentence;
    }
    if (!maleEvidence && new RegExp(`${escapeRegExp(name)}[^。！？\\n]{0,80}[，,；;]\\s*他(?!的)(?:把|说|问|提醒|低声|看|点|摇|皱|拍|示意|开口|走|站|递|拿|转|没有|不|也|已经|正在)`, "u").test(context.sentence)) {
      maleEvidence = context.sentence;
    }
  }
  if (femaleEvidence && !maleEvidence) return { gender: "female", evidence: femaleEvidence };
  if (maleEvidence && !femaleEvidence) return { gender: "male", evidence: maleEvidence };
  return {};
}

function collectNameSentencePairs(content: string, name: string): readonly { readonly sentence: string; readonly nextSentence: string }[] {
  const sentences = splitSentences(content);
  const contexts: { sentence: string; nextSentence: string }[] = [];
  for (let index = 0; index < sentences.length; index += 1) {
    const sentence = sentences[index] ?? "";
    if (!sentence.includes(name)) continue;
    contexts.push({ sentence, nextSentence: sentences[index + 1] ?? "" });
  }
  return contexts;
}

function isNameSubjectLike(sentence: string, name: string): boolean {
  const normalized = sentence.replace(/^[“"'\s]+/u, "");
  return normalized.startsWith(name);
}

function isPronounNameNoise(name: string): boolean {
  return /^(?:他|她|自己|对方|这个|那个|一种|一些|当前|然后|随后|终于|没有|已经|正在|立刻|后才|开始|继续|只是|不能|不会)$/u.test(name)
    || /(?:集团|公司|部门|科室|办公室|档案室|会议室|权限|文件|资料|手机|现金|楼层|城市|世界|主角|作者)$/u.test(name);
}

function genderText(gender: "male" | "female"): string {
  return gender === "female" ? "女性/她" : "男性/他";
}

function trimForIssue(value: string): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, 120);
}

function containsLocationReference(content: string, location: string): boolean {
  if (content.includes(location)) return true;
  return locationKeywords(location).some((keyword) => content.includes(keyword));
}

function containsFuzzyReference(content: string, value: string): boolean {
  if (content.includes(value)) return true;
  const keywords = locationKeywords(value);
  return keywords.length > 0 && keywords.some((keyword) => content.includes(keyword));
}

function containsAssetReference(content: string, value: string): boolean {
  if (containsFuzzyReference(content, value)) return true;
  // 题材中立：用资产名本身派生的名词 token 做模糊命中，而不是写死任何具体物名同义词。
  // 资产值形如 `name · status · conditionNote`，取名字段抽出长度≥2 的汉字/字母数字 token。
  for (const token of assetNameTokens(value)) {
    if (content.includes(token)) return true;
  }
  return false;
}

/**
 * 从资产展示串（`name · status · conditionNote`）里抽出可用于模糊命中的名词 token。
 * 取名字段，去掉「半张/残缺/破损」等状态修饰词后，按汉字串/字母数字串切出长度≥2 的核心词，
 * 让正文里只写了核心物名（去掉状态前缀）也能算作引用了该资产——题材中立、不写死任何专名。
 */
function assetNameTokens(value: string): readonly string[] {
  const name = (value.split("·")[0] ?? "").trim();
  if (!name) return [];
  const stripped = name.replace(/半张|残缺|不完整|破损|缺角|缺了一?半?|撕[掉破]?/gu, "");
  const tokens = [
    name,
    stripped,
    ...Array.from(stripped.matchAll(/[\p{Script=Han}]{2,}|[A-Za-z0-9]{2,}/gu)).map((match) => match[0]),
  ];
  return unique(tokens).filter((token) => token.length >= 2);
}

function locationKeywords(value: string): readonly string[] {
  const compactValue = value.replace(/[，,。；;、\s/]+/gu, "");
  const city = compactValue.match(/[\p{Script=Han}]{2,6}市/u)?.[0];
  const district = compactValue.match(/[\p{Script=Han}]{2,8}区/u)?.[0];
  const building = compactValue.match(/[\p{Script=Han}]{2,10}(?:办公楼|大楼|学校|学院|大厅|窗口|办公室|中心)/u)?.[0];
  return unique([
    value,
    compactValue,
    city,
    district,
    building,
    district && building ? `${district}${building}` : undefined,
    ...value.split(/[，,。；;、\s/]+/u).filter((item) => item.length >= 2),
  ].filter((item): item is string => Boolean(item))).filter((item) => item.length >= 2);
}

function findLocationDrift(content: string, pack: WritingContextPack): readonly string[] {
  const allowed = unique([
    pack.locationContext.requiredCurrentLocation,
    pack.locationContext.openingLocation,
    ...pack.locationContext.nearbyLocations,
  ].filter((item): item is string => Boolean(item))
    .flatMap((item) => locationKeywords(item)));
  const allowedSet = new Set(allowed);
  // 只查「具体场所/建筑」漂移，不再查城市名（`X市`）：城市是故事设定背景，没登记不等于"凭空捏造"，
  // 且 `[Han]{2,8}市` 会把「城市/上市/市场（调研市[场]）」全误当地名（实测 story-test10 第8/10/12 章高误报）。
  const candidates = unique(
    Array.from(content.matchAll(/[\p{Script=Han}]{2,10}(?:中学|学校|学院|办公楼|大楼|大厅|广场|中心)/gu)).map((match) => match[0]),
  );
  return candidates
    .filter((candidate) => !isNonLocationWord(candidate))
    .filter((candidate) => !isNameFragment(candidate)) // 排「而且选的不是商会大楼」这类句子碎片
    .filter((candidate) => !allowedSet.has(candidate) && !allowed.some((item) => item.includes(candidate) || candidate.includes(item)))
    .slice(0, 6);
}

function isNonLocationWord(candidate: string): boolean {
  if (/菜市$/u.test(candidate)) return true;
  // 通用「中心」词（市中心/购物中心/研究中心…）是泛称不是专名场所，别当成被捏造的地点。
  if (/(?:市|购物|商业|活动|研究|服务|健身|体育|展览|会议|医疗|社区|娱乐|培训)中心$/u.test(candidate)) return true;
  return false;
}

function matchingPhrases(content: string, phrases: readonly string[]): readonly string[] {
  return unique(phrases)
    .filter((phrase) => phrase.length >= 2 && content.includes(phrase))
    .slice(0, 8);
}

function findTravelRuleViolations(content: string, pack: WritingContextPack): readonly string[] {
  const rules = pack.locationContext.travelRules ?? [];
  const violations: string[] = [];
  for (const rule of rules) {
    if (!content.includes(rule.targetLocation)) continue;
    if (rule.method === "taxi" && /步行|走路/u.test(content) && typeof rule.durationMinutes === "number" && rule.durationMinutes >= 15) {
      violations.push(`${rule.targetLocation} 应按 ${rule.method} ${rule.durationMinutes} 分钟，不应写成步行很快到达`);
    }
    if (typeof rule.durationMinutes === "number") {
      const shortTripPattern = new RegExp(`(?:${escapeRegExp(rule.targetLocation)}|到(?:了)?${escapeRegExp(rule.targetLocation)}).{0,16}(?:一|二|两|三|四|五|六|七|八|九|十|\\d+)分钟`, "u");
      const reverseShortTripPattern = new RegExp(`(?:一|二|两|三|四|五|六|七|八|九|十|\\d+)分钟.{0,16}(?:${escapeRegExp(rule.targetLocation)}|到(?:了)?${escapeRegExp(rule.targetLocation)})`, "u");
      if (rule.durationMinutes >= 15 && (shortTripPattern.test(content) || reverseShortTripPattern.test(content))) {
        violations.push(`${rule.targetLocation} 登记移动时间为 ${rule.durationMinutes} 分钟，不应写成几分钟到达`);
      }
    }
    if ((rule.method === "stairs" || rule.method === "elevator") && /打车|公交/u.test(content)) {
      violations.push(`${rule.targetLocation} 是楼内移动，不应写成跨城交通`);
    }
  }
  return violations.slice(0, 6);
}

function findFloorStructureWarnings(content: string, pack: WritingContextPack): readonly string[] {
  const floors = pack.locationContext.spatialStructure?.floors ?? [];
  if (floors.length === 0) return [];
  const registeredText = [
    ...floors,
    ...pack.locationContext.fixedFacts,
  ].join("\n").replace(/\s+/gu, "");
  const candidates = unique([
    ...Array.from(content.matchAll(/(?:四|五|六|七|八|九|十|\d+)\s*(?:层建筑|层楼|层高楼|层的大楼|层的建筑)/gu)).map((match) => match[0]),
    ...Array.from(content.matchAll(/(?:四楼|4楼|五楼|5楼|六楼|6楼|地下室|地下车库|顶楼)/gu)).map((match) => match[0]),
  ]);
  return candidates
    .filter((candidate) => !registeredFloorTextAllows(candidate, registeredText))
    .slice(0, 6);
}

function registeredFloorTextAllows(candidate: string, registeredText: string): boolean {
  const normalized = candidate.replace(/\s+/gu, "");
  if (registeredText.includes(normalized)) return true;
  if (/^(?:四|五|六|七|八|九|十|\d+)楼$/u.test(normalized)) return registeredText.includes(normalized);
  if (/地下室|地下车库|顶楼/u.test(normalized)) return registeredText.includes(normalized);
  const floorCount = normalized.match(/^(?:四|五|六|七|八|九|十|\d+)/u)?.[0];
  return Boolean(floorCount && new RegExp(`(?:共|总共)?${escapeRegExp(floorCount)}层`, "u").test(registeredText));
}

// 题材中立：用「资产被标为破损/缺损」这一通用状态信号 + 通用「恢复完好」描述，
// 而不是写死任何具体破损物专名。
const ASSET_RESTORE_TOKENS = /完整|整张|完好|修好|修复|恢复|补全|补齐|焕然一新|崭新|齐全/u;
const ASSET_BROKEN_TOKENS = /半张|残缺|不完整|破损|损坏|缺角|缺[了一]|断裂|裂[了开]|坏[了的]|失灵|停机|欠费|没电|无法使用|不能用|用不了|失效/u;

function findUnavailableAssetViolations(content: string, pack: WritingContextPack): readonly string[] {
  const violations: string[] = [];
  // ① 不可用资产（status≠available）被写成可正常使用：名字命中正文 + 出现「恢复完好/正常」描述。
  for (const asset of pack.assetContext.unavailableAssets) {
    const tokens = assetNameTokens(asset);
    if (tokens.length === 0) continue;
    const hit = tokens.find((token) => content.includes(token));
    if (!hit) continue;
    if (ASSET_RESTORE_TOKENS.test(content) || /正常(?:使用|运转|联网|工作|运作)/u.test(content)) {
      const displayName = (asset.split("·")[0] ?? asset).trim() || hit;
      violations.push(`${displayName} 当前不可用，不应写成突然恢复正常或完好可用`);
    }
  }
  // ② 破损/缺损的关键剧情资产被凭空写成完整：仅当资产本身（名字或状态备注）带破损信号才触发。
  for (const asset of pack.assetContext.plotCriticalAssets) {
    if (!ASSET_BROKEN_TOKENS.test(asset)) continue;
    const tokens = assetNameTokens(asset);
    if (tokens.length === 0) continue;
    const hit = tokens.find((token) => content.includes(token));
    if (!hit) continue;
    if (ASSET_RESTORE_TOKENS.test(content)) {
      const displayName = (asset.split("·")[0] ?? asset).trim() || hit;
      violations.push(`${displayName} 是破损/不完整的关键资产，不应凭空变回完整`);
    }
  }
  if (pack.assetContext.ownedAssets.every((asset) => !/车|汽车|摩托/u.test(asset)) && /开车|车钥匙|他的车|驾驶/u.test(content)) {
    violations.push("没有登记车辆时不能默认主角有车");
  }
  return violations;
}

function findIdentityDetailDrift(content: string, pack: WritingContextPack): readonly string[] {
  const allowedText = [
    pack.protagonistContext.identity,
    pack.protagonistContext.name,
    ...pack.protagonistContext.knownFacts,
    ...pack.worldRulesContext.socialOrder,
    ...pack.worldRulesContext.factions.map((faction) => faction.name),
  ].filter((item): item is string => Boolean(item)).join("\n");
  const name = pack.protagonistContext.name?.trim();
  const found: string[] = [];
  // 身份漂移 = **主角**的身份细节被凭空捏造（如主角突然"毕业于某大学/是某公司的人"）。
  // 只算「主角名」附近(±12字)的机构/学校——配角的公司、环境里泛提的「上市公司/你们公司」不是主角身份漂移
  // （实测高误报：把全章每个公司都当主角身份捏造）。剩下真存疑的交 LLM 判定层。
  for (const match of content.matchAll(/[\p{Script=Han}]{2,12}(?:职业技术学院|大学|中学|学校|学院|公司|集团|财团|机构)/gu)) {
    const candidate = match[0];
    if (allowedText.includes(candidate)) continue;
    if (isNameFragment(candidate)) continue; // 排「那家公司/现在连公司/选的不是商会大楼」句子碎片
    if (name) {
      const at = match.index ?? 0;
      const window = content.slice(Math.max(0, at - 12), at + candidate.length + 12);
      if (!window.includes(name)) continue; // 不在主角名附近 → 不是主角身份漂移
    }
    found.push(candidate);
  }
  return unique(found).slice(0, 6);
}

/**
 * 判断「X大楼/X公司/X集团/X大学…」是不是句子碎片（而非专名）：正则贪婪会把前面的话一起 grab 进来
 * （如「而且选的不是商会大楼」「现在连公司」），专名最后一字不会是 的/连/是/你/我 这类语法虚词或代词。
 */
const PROPER_NAME_FRAGMENT_PRECHAR = /[的了连家个些么也都还就在和与跟那这几某每各同里到从把被让对向是有又再且并们你我他她咱您把要会能想]/u;
function isNameFragment(candidate: string): boolean {
  const match = candidate.match(/^(.*?)(?:职业技术学院|大学|中学|学校|学院|办公楼|大楼|大厅|广场|中心|公司|集团|财团|机构)$/u);
  const prefix = match?.[1] ?? "";
  if (prefix.length < 2) return true; // 前缀太短（连公司/选大楼）几乎不是真专名
  return PROPER_NAME_FRAGMENT_PRECHAR.test(prefix.charAt(prefix.length - 1));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function countChineseCharacters(content: string): number {
  return [...content.matchAll(/\p{Script=Han}/gu)].length;
}

function errorIssue(type: string, message: string): CommitQualityIssue {
  return {
    severity: "error",
    type,
    message,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
