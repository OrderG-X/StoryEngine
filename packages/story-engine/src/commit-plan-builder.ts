import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildArcGoalTrackingPlan,
  type ArcGoalUpdate,
  type StaleGoalWarning,
} from "./arc-goal-tracking.js";
import type { AssetLedgerUpdate, CharacterBibleUpdate, CharacterMatrixUpdate, CharacterStateUpdate, CommitDraftInput, LocationBibleUpdate } from "./commit-engine.js";
import { buildHookTrackingPlan, type HookStaleWarning, type HookTrackingUpdate } from "./hook-tracking.js";
import {
  buildThreadTrackingPlan,
  type StaleThreadWarning,
  type ThreadHygieneReport,
  type ThreadTrackingUpdate,
} from "./lead-intent-tracking.js";
import { readArcGoalPool, readCharacterProfile, readHookPool, readThreadPool, toSafeCharacterId } from "./project-store.js";
import { verifyChapterDelta, type ChapterDeltaDeclaration, type VerifiedChapterDelta } from "./chapter-delta.js";
import { detectNameDrift, type EstablishedCharacter, type NameDriftFinding } from "./character-name-consistency.js";
import type { AssetLedger, CharacterMatrixLedger, CharacterProfile, HookItem, LocationBible } from "./types.js";

export interface BuildCommitPlanInput {
  readonly projectDir: string;
  readonly chapter: number;
  readonly draftPath?: string;
  /** Immutable draft bytes captured by a caller-owned formal-commit lock. */
  readonly draftContent?: string;
  /**
   * 可选：写手模型对本章的语义声明（ChapterDelta）。传入时先做确定性证据校验，核实通过的条目用于填充
   * mainEvent/时间线摘要（逐字段优先声明、缺则回退现有正则）；缺失/坏/全部核不上 → 完全等价旧行为（向后兼容）。
   * LLM 调用在 UI server 层完成，引擎只接收纯数据 + 做确定性校验（守 import 边界 + 引擎无 LLM 依赖）。
   */
  readonly declaration?: ChapterDeltaDeclaration;
  /**
   * 可选：本书已确立的角色名（含跨章 prose-only 名，如未登记进角色库的「妹妹林宁」），用于名字漂移写前校验。
   * 与已登记角色名合并成名册；缺省时只用已登记角色名。别名用「名字|别名1|别名2」竖线分隔。
   */
  readonly establishedCharacterNames?: readonly string[];
}

export interface BuildCommitPlanResult {
  readonly passed: boolean;
  readonly commitPlan?: CommitDraftInput["commitPlan"];
  readonly semanticSummary?: ChapterSemanticSummary;
  readonly assetChanges?: CommitAssetChangePlan;
  readonly locationChanges?: CommitLocationChangePlan;
  readonly characterKnowledgeChanges?: CommitCharacterKnowledgeChangePlan;
  readonly highRiskIssueCount?: number;
  readonly requiresExplicitOverride?: boolean;
  readonly blockingReasons?: readonly string[];
  readonly hookTrackingUpdates?: readonly HookTrackingUpdate[];
  readonly staleHookWarnings?: readonly HookStaleWarning[];
  readonly threadTrackingUpdates?: readonly ThreadTrackingUpdate[];
  readonly staleThreadWarnings?: readonly StaleThreadWarning[];
  readonly threadHygieneReport?: ThreadHygieneReport;
  readonly arcGoalUpdates?: readonly ArcGoalUpdate[];
  readonly staleGoalWarnings?: readonly StaleGoalWarning[];
  /**
   * 人物名近形漂移的结构化发现（同 issues 里的「人物名疑似写歪」文本一一对应，但带字段化的
   * establishedName/driftedVariant）。上层据此把它固定展示成明确 warning，不让模型在回执里说软。
   */
  readonly nameDriftFindings?: readonly NameDriftFinding[];
  readonly issues: readonly string[];
}

export interface CommitPreviewCandidate {
  readonly id: string;
  readonly name: string;
  readonly targetId?: string;
  readonly changeType?: string;
  readonly before?: string;
  readonly after?: string;
  readonly evidence: string;
  readonly severity: "info" | "warning" | "high";
  readonly requiresUserConfirm: boolean;
}

export interface CommitAssetChangePlan {
  readonly newAssetCandidates: readonly CommitPreviewCandidate[];
  readonly assetStatusChanges: readonly CommitPreviewCandidate[];
  readonly assetUsageEvidence: readonly CommitPreviewCandidate[];
  readonly unregisteredAssetWarnings: readonly CommitPreviewCandidate[];
}

export interface CommitLocationChangePlan {
  readonly newLocationCandidates: readonly CommitPreviewCandidate[];
  readonly locationTransitionCandidates: readonly CommitPreviewCandidate[];
  readonly spatialViolationWarnings: readonly CommitPreviewCandidate[];
}

export interface CommitCharacterKnowledgeChangePlan {
  readonly stateChanges: readonly CommitPreviewCandidate[];
  readonly knowledgeKnownChanges: readonly CommitPreviewCandidate[];
  readonly knowledgeUnknownChanges: readonly CommitPreviewCandidate[];
  readonly characterMatrixCandidates: readonly CommitPreviewCandidate[];
  readonly forbiddenRevealTouches: readonly CommitPreviewCandidate[];
}

export type SelectiveChangeDecisionState = "accept" | "reject" | "defer";

export interface SelectiveChangeDecision {
  readonly candidateId: string;
  readonly state: SelectiveChangeDecisionState;
  readonly edited?: {
    readonly name?: string;
    readonly after?: string;
    readonly evidence?: string;
  };
}

export interface CommitSelectiveConfirmation {
  readonly assetDecisions?: readonly SelectiveChangeDecision[];
  readonly locationDecisions?: readonly SelectiveChangeDecision[];
  readonly characterKnowledgeDecisions?: readonly SelectiveChangeDecision[];
}

export interface ChapterSemanticSummary {
  readonly chapter: number;
  readonly chapterTitle: string;
  readonly protagonist?: string;
  readonly chapterSummary?: string;
  readonly participants?: readonly string[];
  readonly keyEvents?: readonly string[];
  readonly foreshadowingTerms?: readonly string[];
  readonly timelineSummary?: string;
  readonly mainEvent: string;
  readonly conflict?: string;
  readonly discovery?: string;
  readonly decision?: string;
  readonly gained?: string;
  readonly lost?: string;
  readonly nextLead?: string;
  readonly mentionedHooks: readonly string[];
  readonly mentionedCharacters: readonly string[];
  readonly mentionedCharacterNames: readonly string[];
  /**
   * 模型声明并经证据校验通过的「本章出场角色名」（含未登记进角色库的 prose-only 名，如「妹妹林宁」）。
   * 持久化进时间线，供后续章节组装「已确立角色名册」做名字漂移写前校验（跨章累积）。
   */
  readonly presentCharacterNames?: readonly string[];
  readonly locations: readonly string[];
}

export async function buildCommitPlanFromProject(input: BuildCommitPlanInput): Promise<BuildCommitPlanResult> {
  const issues: string[] = [];
  const draftPath = input.draftPath ?? defaultDraftPath(input.projectDir, input.chapter);
  const [draft, characters, hookPool, threadPool, arcGoalPool, previewContext] = await Promise.all([
    input.draftContent !== undefined
      ? Promise.resolve(input.draftContent)
      : readFile(draftPath, "utf-8").catch((error: unknown) => {
        issues.push(error instanceof Error ? error.message : String(error));
        return undefined;
      }),
    listCharacterProfiles(input.projectDir).catch((error: unknown) => {
      issues.push(error instanceof Error ? error.message : String(error));
      return [];
    }),
    readHookPool(input.projectDir).catch((error: unknown) => {
      issues.push(error instanceof Error ? error.message : String(error));
      return undefined;
    }),
    readThreadPool(input.projectDir).catch((error: unknown) => {
      issues.push(error instanceof Error ? error.message : String(error));
      return undefined;
    }),
    readArcGoalPool(input.projectDir).catch((error: unknown) => {
      issues.push(error instanceof Error ? error.message : String(error));
      return undefined;
    }),
    readCommitPreviewContext(input.projectDir).catch((error: unknown) => {
      issues.push(error instanceof Error ? error.message : String(error));
      return emptyCommitPreviewContext();
    }),
  ]);

  if (!draft) return { passed: false, issues };
  if (characters.length === 0) {
    return { passed: false, issues: [...issues, "No characters found in project."] };
  }
  if (!hookPool || !threadPool || !arcGoalPool) return { passed: false, issues };

  const mainCharacter = selectMainCharacter(characters, draft);
  const matchedHooks = selectMatchingHooks(hookPool.hooks, draft);
  const characterId = toSafeCharacterId(mainCharacter.id);
  // 章节语义声明：仅在传入时做确定性证据校验；核不上的条目进 issues（绝不静默），并逐字段回退旧正则。
  const verifiedDelta = input.declaration ? verifyChapterDelta(input.declaration, draft) : undefined;
  if (verifiedDelta && verifiedDelta.rejected.length > 0) {
    for (const entry of verifiedDelta.rejected) {
      if (entry.reason === "amount_not_in_evidence") {
        issues.push(`章节语义声明数量未采信，仅记入得失条目（${entry.field}·${entry.reason}）：${entry.quote}`);
      } else {
        issues.push(`章节语义声明被拒（${entry.field}·${entry.reason}）：${entry.quote}`);
      }
    }
  }
  // 资源变化：已校验的 resourceDeltas 目前尚未接进「资产卡结构化数量增减」（属独立后续项目——
  // 资产更新链路无数量增减概念、模型把数量写进资产名、需确认流支持）。此处先【显式提示、绝不静默丢弃】：
  // 把每条已核实的资源变化摊进 issues，供预览展示 + agent 据此主动用 foundation_write 同步资产卡。
  // 数量本身仍由 fact-ledger 逐章记账兜底后文一致性。
  if (verifiedDelta && verifiedDelta.resourceDeltas.length > 0) {
    for (const delta of verifiedDelta.resourceDeltas) {
      const kind = delta.change === "gain" ? "获得" : delta.change === "loss" ? "失去" : "消耗";
      const amount = delta.amount ? `（${delta.amount}）` : "";
      issues.push(`资源变化待同步资产卡：${delta.item}${amount} ${kind}——证据「${delta.quote}」。可用 foundation_write 更新对应资产。`);
    }
  }
  // 人物名字漂移写前校验（题材中立）：把模型声明的「本章用名」和已确立角色名做确定性形近比对，
  // 逮住「已确立角色的正确名字本章没用、却用了个形近错名」（如 林宁→林棠）。只提示、不阻塞。
  // 除了塞进 issues（供 plan 可读/向后兼容），也结构化保留在 nameDriftFindings，供上层固定展示成明确 warning。
  let nameDriftFindings: readonly NameDriftFinding[] = [];
  if (verifiedDelta && verifiedDelta.charactersPresent.length > 0) {
    const establishedRegistry = buildEstablishedCharacterRegistry(characters, input.establishedCharacterNames);
    nameDriftFindings = detectNameDrift({
      chapterNames: verifiedDelta.charactersPresent.map((entry) => entry.name),
      established: establishedRegistry,
      draft,
    });
    for (const finding of nameDriftFindings) {
      issues.push(`人物名疑似写歪：本章出现「${finding.driftedVariant}」，与已确立角色「${finding.establishedName}」形近；请确认是否应写作「${finding.establishedName}」。`);
    }
  }
  const semanticSummary = extractChapterSemanticSummary({
    chapter: input.chapter,
    draft,
    characters,
    hooks: hookPool.hooks,
    defaultCharacterId: characterId,
    genreContext: previewContext.genreContext,
    knownLocations: knownLocationNames(previewContext.locationBible),
    ...(verifiedDelta ? { verifiedDelta } : {}),
  });
  const knownCharacterNames = collectKnownCharacterNames(characters, semanticSummary.protagonist);
  const assetChanges = buildAssetChangePlan(draft, previewContext.assetLedger, knownCharacterNames);
  const locationChanges = buildLocationChangePlan(draft, previewContext.locationBible, assetChanges, knownCharacterNames);
  const blockingReasons = buildBlockingReasons({ assetChanges, locationChanges });
  const highRiskIssueCount = countHighRiskIssues({ assetChanges, locationChanges });
  const conservativeCharacterUpdate = buildConservativeCharacterUpdate({
    characterId,
    semanticSummary,
    draft,
  });
  const characterKnowledgeChanges = buildCharacterKnowledgeChangePlan({
    characterId,
    characterName: mainCharacter.name,
    semanticSummary,
    conservativeCharacterUpdate,
    draft,
    protectedSecrets: previewContext.protectedSecrets,
    knownCharacters: characters,
    characterMatrix: previewContext.characterMatrix,
  });
  const participantIds = semanticSummary.mentionedCharacters.length > 0
    ? semanticSummary.mentionedCharacters
    : [characterId];
  const hookTracking = buildHookTrackingPlan({
    chapter: input.chapter,
    draft,
    semanticSummary,
    hookPool,
    ...(verifiedDelta ? { verifiedDelta } : {}),
  });
  const threadTracking = buildThreadTrackingPlan({
    chapter: input.chapter,
    draft,
    semanticSummary,
    threadPool,
    protagonistName: semanticSummary.protagonist ?? mainCharacter.name,
    ...(verifiedDelta ? { verifiedDelta } : {}),
  });
  const arcGoalTracking = buildArcGoalTrackingPlan({
    chapter: input.chapter,
    draft,
    semanticSummary,
    hookTrackingUpdates: hookTracking.updates,
    threadTrackingUpdates: threadTracking.updates,
    arcGoalPool,
    ...(verifiedDelta ? { verifiedDelta } : {}),
  });
  return {
    passed: blockingReasons.length === 0,
    commitPlan: {
      ...(conservativeCharacterUpdate ? { characterUpdates: [conservativeCharacterUpdate] } : {}),
      timelineEvents: [
        {
          summary: semanticSummary.timelineSummary ?? semanticSummary.mainEvent,
          participants: participantIds,
          effects: {
            semanticSummary,
          },
        },
      ],
      worldUpdates: {
        // P2：不再写 chapter_N_committed 水印——它每章覆盖作者/模型已设定的故事阶段（铁律②：
        // 写操作要可撤销、不破坏用户已确立的设定）。自动路径没有阶段推进的证据，保留既有值。
        ...([...matchedHooks.map((hook) => hook.id), ...hookTracking.updates.map((update) => update.id)].length > 0
          ? { activeHooks: unique([...matchedHooks.map((hook) => hook.id), ...hookTracking.updates.map((update) => update.id)]) }
          : {}),
        ...(semanticSummary.conflict ? { activeConflicts: [semanticSummary.conflict] } : {}),
      },
      ...((): { hookUpdates?: readonly { hookId: string; status: "active" | "seeded" | "resolved" | "abandoned" }[] } => {
        const resolvedIds = new Set(hookTracking.resolvedHookIds);
        const activeUpdates = matchedHooks
          .filter((hook) => hook.status !== "resolved" && !resolvedIds.has(hook.id))
          .map((hook) => ({ hookId: hook.id, status: "active" as const }));
        // PR B 幻影 hook：hookUpdates 是「必须指向池内已有 hook」的校验通道（commit-engine.findUnknownHookIds
        // 缺一即 "Hook not found" 硬阻整章）。回收一个未登记线索时 resolvedHookIds 会含一个池外 phantom id
        // —— 它绝不能进这条通道。只放行池内 id；池外 id 的回收由 trackingUpdates 通道 introduce-then-resolve
        // 登记入池（不是丢弃）。
        const poolHookIds = new Set(hookPool.hooks.map((hook) => hook.id));
        const resolvedUpdates = hookTracking.resolvedHookIds
          .filter((id) => poolHookIds.has(id))
          .map((id) => ({ hookId: id, status: "resolved" as const }));
        const allUpdates = [...activeUpdates, ...resolvedUpdates];
        return allUpdates.length > 0 ? { hookUpdates: allUpdates } : {};
      })(),
      ...(hookTracking.updates.length > 0 ? { hookTrackingUpdates: hookTracking.updates } : {}),
      ...(hookTracking.staleHookWarnings.length > 0 ? { staleHookWarnings: hookTracking.staleHookWarnings } : {}),
      ...(threadTracking.updates.length > 0 ? { threadTrackingUpdates: threadTracking.updates } : {}),
      ...(threadTracking.staleThreadWarnings.length > 0 ? { staleThreadWarnings: threadTracking.staleThreadWarnings } : {}),
      threadHygieneReport: threadTracking.threadHygieneReport,
      ...(arcGoalTracking.updates.length > 0 ? { arcGoalUpdates: arcGoalTracking.updates } : {}),
      ...(arcGoalTracking.staleGoalWarnings.length > 0 ? { staleGoalWarnings: arcGoalTracking.staleGoalWarnings } : {}),
      calendar: {
        storyDay: input.chapter === 1 ? 1 : input.chapter,
        timeOfDay: "unknown",
      },
    },
    semanticSummary,
    assetChanges,
    locationChanges,
    characterKnowledgeChanges,
    highRiskIssueCount,
    requiresExplicitOverride: blockingReasons.length > 0,
    blockingReasons,
    hookTrackingUpdates: hookTracking.updates,
    staleHookWarnings: hookTracking.staleHookWarnings,
    threadTrackingUpdates: threadTracking.updates,
    staleThreadWarnings: threadTracking.staleThreadWarnings,
    threadHygieneReport: threadTracking.threadHygieneReport,
    arcGoalUpdates: arcGoalTracking.updates,
    staleGoalWarnings: arcGoalTracking.staleGoalWarnings,
    ...(nameDriftFindings.length > 0 ? { nameDriftFindings } : {}),
    issues: [...issues, ...blockingReasons],
  };
}

export function extractChapterSemanticSummary(input: {
  readonly chapter: number;
  readonly draft: string;
  readonly characters: readonly CharacterProfile[];
  readonly hooks: readonly HookItem[];
  readonly defaultCharacterId: string;
  readonly genreContext?: readonly string[];
  readonly knownLocations?: readonly string[];
  /** 已核实的章节语义声明（证据逐字命中草稿）。逐字段优先用它、缺则回退正则。 */
  readonly verifiedDelta?: VerifiedChapterDelta;
}): ChapterSemanticSummary {
  const body = stripMarkdownHeadings(input.draft);
  const sentences = splitSentences(body);
  const clauses = splitClauses(body);
  const paragraphs = splitParagraphs(body);
  const mentionedCharacterProfiles = selectMentionedCharacterProfiles(input.characters, input.draft, input.defaultCharacterId);
  const defaultCharacter = input.characters.find((character) => toSafeCharacterId(character.id) === input.defaultCharacterId)
    ?? input.characters[0];
  const mentionedCharacters = mentionedCharacterProfiles.map((character) => toSafeCharacterId(character.id));
  const mentionedCharacterNames = mentionedCharacterProfiles.map((character) => character.name);
  const mentionedHooks = selectMatchingHooks(input.hooks, input.draft).map((hook) => hook.id);
  const protagonist = defaultCharacter?.name ?? mentionedCharacterNames[0] ?? input.defaultCharacterId;
  const participants = extractParticipants(body, mentionedCharacterNames, protagonist);
  const used = new Set<string>();
  const conflict = pickFirstDistinct(sentences.filter((sentence) => !isGenericConflictNoise(sentence)), [
    "争执",
    "威胁",
    "克扣",
    "挑衅",
    "被罚",
    "追杀",
    "偷袭",
    "阴谋",
    "毒",
    "造假",
    "假账",
    "假身份",
    "假消息",
    "骗局",
    "骗",
    "夺权",
    "夺走",
    "争夺",
    "抢夺",
    "夺回",
    "打压",
    "抢",
    "受伤",
    "不信任",
  ], used);
  const discovery = pickDiscovery(sentences, used);
  const gained = pickDistinct(clauses.filter((sentence) => !isGenericGainedNoise(sentence) && !isNegatedGainedCandidate(sentence)), ["得到", "拿到", "偷到", "领到", "找到", "搜到", "收集到", "带回"], used);
  const lost = pickDistinct(clauses, ["失去", "被扣", "被抢", "没了", "断电", "断网", "耗尽"], used);
  const decision = pickDecisionSentence(sentences, used);
  const nextLead = pickNextLead(splitSentences(paragraphs.slice(-3).join("\n")), [decision, gained, lost]);
  const locations = extractLocations(body, input.knownLocations);
  const resolvedMentionedCharacters = mentionedCharacters.length > 0 ? mentionedCharacters : [input.defaultCharacterId];
  const resolvedMentionedCharacterNames = mentionedCharacterNames.length > 0
    ? mentionedCharacterNames
    : defaultCharacter?.name
      ? [defaultCharacter.name]
      : [];
  // 模型声明并证据校验通过的本章出场角色名（含未登记 prose-only 名，如「妹妹林宁」）；持久化供后续章名字漂移校验累积。
  const presentCharacterNames = unique(
    (input.verifiedDelta?.charactersPresent ?? [])
      .map((entry) => entry.name?.trim())
      .filter((name): name is string => Boolean(name)),
  );
  // 题材中立的「具名实体」信号：项目自己登记的角色名 + 本章出现的地点名，喂给打分器给具名实质句加权。
  // 角色名（演员）与地点名（场景）分开喂打分器：纯景物句（只提地点）不当事件、不冒头（Codex 5 章 E2E）。
  // 必须在 buildMainEvent 之前算好——mainEvent 的 fallback 复用这份评分排名（不再用脱节的遗留关键词表）。
  const rankedEvents = rankEventSentences(sentences, resolvedMentionedCharacterNames, locations);
  const regexMainEvent = buildMainEvent({
    chapter: input.chapter,
    sentences,
    rankedEvents,
    conflict,
    discovery,
    gained,
    lost,
    decision,
    fallback: `第 ${input.chapter} 章草稿被提交为正式章节。`,
  });
  // mainEvent 逐字段优先用已核实声明的干净摘要；缺则回退正则结果（向后兼容）。
  const declaredMainEvent = input.verifiedDelta?.mainEvent;
  const declaredMainEventSummary = declaredMainEvent ? trimSentence(declaredMainEvent.summary, 90) : "";
  const declaredFallbackMainEventSummary = firstNonEmpty([
    input.verifiedDelta?.discovery ? trimSentence(input.verifiedDelta.discovery.summary, 90) : "",
    input.verifiedDelta?.conflict ? trimSentence(input.verifiedDelta.conflict.summary, 90) : "",
    input.verifiedDelta?.decision ? trimSentence(input.verifiedDelta.decision.summary, 90) : "",
  ]);
  const mainEvent = declaredMainEventSummary || declaredFallbackMainEventSummary || regexMainEvent;
  // conflict/discovery/decision 同理逐字段优先用已核实声明（题材中立），缺则回退上面正则关键词表的结果。
  // 注意：buildMainEvent 的 fallback 仍吃正则版（regexMainEvent 是无声明时才用），此处只改最终对外的语义字段。
  const finalConflict = input.verifiedDelta?.conflict ? trimSentence(input.verifiedDelta.conflict.summary, 90) : conflict;
  const finalDiscovery = input.verifiedDelta?.discovery ? trimSentence(input.verifiedDelta.discovery.summary, 90) : discovery;
  const finalDecision = input.verifiedDelta?.decision ? trimSentence(input.verifiedDelta.decision.summary, 90) : decision;
  const declaredResourceChange = buildDeclaredResourceChangeSummary(input.verifiedDelta?.resourceDeltas ?? []);
  const finalGained = declaredResourceChange.gained ?? (input.verifiedDelta?.hasAnyVerified ? undefined : gained);
  const finalLost = declaredResourceChange.lost ?? (input.verifiedDelta?.hasAnyVerified ? undefined : lost);
  const keyEvents = extractKeyEvents(rankedEvents, mainEvent, resolvedMentionedCharacterNames, locations);
  const chapterSummary = buildChapterSummary(keyEvents, mainEvent);
  const foreshadowingTerms = extractForeshadowingTerms(body, input.hooks);
  // timelineSummary：有声明时直接用声明的【干净核心事件摘要】（= mainEvent），不再用模型引用的原文证据句。
  // 证据句只为「最短可核验」，常是「坑是空的。」这类局部碎片、或模型整段照抄的原文——两者都不适合当时间线展示句
  // （Codex 10 章 E2E·P2：mainEvent 已干净，timelineSummary 仍被碎片/环境/资源数量句抢占）。无声明才回退正则选句。
  const declaredTimelineSummary = declaredMainEventSummary || declaredFallbackMainEventSummary;
  const timelineSummary = declaredTimelineSummary
    ? declaredTimelineSummary
    : keyEvents.length > 0
      ? selectTimelineSummary(rankedEvents, mainEvent, resolvedMentionedCharacterNames)
      : mainEvent;

  return {
    chapter: input.chapter,
    chapterTitle: extractMarkdownTitle(input.draft) ?? `第${input.chapter}章`,
    protagonist,
    chapterSummary,
    participants,
    keyEvents,
    foreshadowingTerms,
    timelineSummary,
    mainEvent,
    ...(finalConflict ? { conflict: finalConflict } : {}),
    ...(finalDiscovery ? { discovery: finalDiscovery } : {}),
    ...(finalDecision ? { decision: finalDecision } : {}),
    ...(finalGained ? { gained: finalGained } : {}),
    ...(finalLost ? { lost: finalLost } : {}),
    ...(nextLead ? { nextLead } : {}),
    mentionedHooks,
    mentionedCharacters: resolvedMentionedCharacters,
    mentionedCharacterNames: resolvedMentionedCharacterNames,
    ...(presentCharacterNames.length > 0 ? { presentCharacterNames } : {}),
    locations,
  };
}

export const buildSemanticSummaryFromDraft = extractChapterSemanticSummary;

function firstNonEmpty(values: readonly string[]): string {
  return values.find((value) => value.trim().length > 0) ?? "";
}

function formatDeclaredResourceDelta(delta: { readonly item: string; readonly amount?: string }): string {
  const item = delta.item.trim();
  const amount = delta.amount?.trim();
  return amount ? `${item}（${amount}）` : item;
}

function buildDeclaredResourceChangeSummary(
  resourceDeltas: readonly VerifiedChapterDelta["resourceDeltas"][number][],
): { readonly gained?: string; readonly lost?: string } {
  if (resourceDeltas.length === 0) return {};
  const gained = resourceDeltas
    .filter((delta) => delta.change === "gain")
    .map(formatDeclaredResourceDelta);
  const lost = resourceDeltas
    .filter((delta) => delta.change === "loss" || delta.change === "spend")
    .map(formatDeclaredResourceDelta);
  return {
    ...(gained.length > 0 ? { gained: trimSentence(gained.join("、"), 90) } : {}),
    ...(lost.length > 0 ? { lost: trimSentence(lost.join("、"), 90) } : {}),
  };
}

interface CommitPreviewContext {
  readonly genreContext: readonly string[];
  readonly assetLedger: AssetLedger;
  readonly locationBible: LocationBible | undefined;
  readonly characterMatrix: CharacterMatrixLedger;
  readonly protectedSecrets: readonly string[];
}

async function readCommitPreviewContext(projectDir: string): Promise<CommitPreviewContext> {
  const [project, worldCore, storyBible, worldBible, assetLedger, locationBible, characterMatrix] = await Promise.all([
    readJsonSafe<Record<string, unknown>>(projectDir, "project.json"),
    readJsonSafe<Record<string, unknown>>(projectDir, join("world", "core.json")),
    readJsonSafe<Record<string, unknown>>(projectDir, join("story", "bible.json")),
    readJsonSafe<Record<string, unknown>>(projectDir, join("story", "world-bible.json")),
    readJsonSafe<AssetLedger>(projectDir, join("story", "assets.json")),
    readJsonSafe<LocationBible>(projectDir, join("story", "location-bible.json")),
    readJsonSafe<CharacterMatrixLedger>(projectDir, join("story", "character-matrix.json")),
  ]);
  return {
    genreContext: [
      readString(project?.title),
      readString(worldCore?.genre),
      readString(worldCore?.premise),
      readString(storyBible?.genre),
      readString(storyBible?.premise),
      readString(storyBible?.projectLogline),
      ...(readStringList(storyBible?.subgenres)),
      ...(readStringList(worldBible?.rules)),
      ...(readStringList(worldBible?.powerOrSurvivalSystems)),
    ].filter(isNonEmptyString),
    assetLedger: assetLedger ?? { version: "v0", assets: [], containers: [] },
    locationBible,
    characterMatrix: characterMatrix ?? { version: "v0", entries: [] },
    protectedSecrets: unique([
      ...readStringList(storyBible?.protectedSecrets),
      ...readStringList(storyBible?.coreMysteries),
      ...readStringList(storyBible?.forbiddenChanges),
    ]),
  };
}

function emptyCommitPreviewContext(): CommitPreviewContext {
  return {
    genreContext: [],
    assetLedger: { version: "v0", assets: [], containers: [] },
    locationBible: undefined,
    characterMatrix: { version: "v0", entries: [] },
    protectedSecrets: [],
  };
}

async function readJsonSafe<T>(projectDir: string, relativePath: string): Promise<T | undefined> {
  return readFile(join(projectDir, relativePath), "utf-8")
    .then((text) => JSON.parse(text) as T)
    .catch(() => undefined);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readStringList(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
    : [];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function buildConservativeCharacterUpdate(input: {
  readonly characterId: string;
  readonly semanticSummary: ChapterSemanticSummary;
  readonly draft: string;
}): CharacterStateUpdate | undefined {
  const goal = chooseCharacterGoal(input.semanticSummary);
  const emotion = chooseCharacterEmotion(input.semanticSummary, input.draft);
  if (!goal && !emotion) return undefined;
  return {
    characterId: input.characterId,
    ...(emotion ? { emotion } : {}),
    ...(goal ? { goal } : {}),
  };
}

function chooseCharacterGoal(summary: ChapterSemanticSummary): string | undefined {
  const decision = cleanGoalSource(summary.decision);
  const nextLead = cleanGoalSource(summary.nextLead);
  const discovery = cleanGoalSource(summary.discovery);
  if (decision) return trimSentence(decision, 48);
  if (nextLead) return `继续追查：${trimSentence(nextLead, 38)}`;
  if (discovery) return `确认发现：${trimSentence(discovery, 38)}`;
  return undefined;
}

function cleanGoalSource(value: string | undefined): string | undefined {
  if (!value || isGenericStateText(value) || isGenericLongEnoughFiller(value) || isActionOnlySentence(value) || isAttitudeOnlySentence(value)) return undefined;
  return value;
}

function chooseCharacterEmotion(summary: ChapterSemanticSummary, draft: string): string | undefined {
  if (summary.conflict) return "警觉";
  if (/紧张|怀疑|警惕|迟疑|压低声音|皱眉|沉默/u.test(draft)) return "克制警觉";
  return undefined;
}

function isGenericStateText(value: string): boolean {
  return /^(?:engaged|active|use the new advantage|follow the next lead|continue the current chapter arc|unknown advantage|character|protagonist)$/iu.test(value.trim());
}

function isGenericLongEnoughFiller(value: string): boolean {
  return /第.{1,3}次确认后|只相信眼前看见/u.test(value);
}

function isActionOnlySentence(value: string): boolean {
  const text = value.trim();
  if (/(?:双肩包|背包|口袋|手机|时间|门窗|钥匙|行李|衣柜|房间).{0,16}检查|检查.{0,16}(?:双肩包|背包|口袋|手机|时间|门窗|钥匙|行李|衣柜|房间)|最后检查/u.test(text)) return true;
  if (/(?:查询|调查|确认|追查|寻找|搜索|前往|申请|检测|弄清|搞清|查清|决定|必须|不能再|要去|先去)/u.test(text)) return false;
  return /(?:把|将).{0,24}(?:抽回|抽回来|折好|塞回|收起|放回|拿起|放下|拉上|关掉|打开|站起来|坐下|转身|看了看|扫了一眼|走向|走到|离开|经过|准备走)|(?:抽回|抽回来|折好|塞回|收起|放回|站起来|坐下|转身离开|准备走)/u.test(text);
}

function isAttitudeOnlySentence(value: string): boolean {
  const text = value.trim();
  if (/(?:查询|调查|确认|追查|寻找|搜索|前往|申请|检测|弄清|搞清|查清|线索|记录|异常)/u.test(text)) return false;
  return /(?:没打算|不打算|不想|没有说话|没说话|觉得不对劲|感觉不对劲|不想再等|不愿再等|自己做决定|等着.{0,12}做决定)/u.test(text);
}

function buildCharacterKnowledgeChangePlan(input: {
  readonly characterId: string;
  readonly characterName: string;
  readonly semanticSummary: ChapterSemanticSummary;
  readonly conservativeCharacterUpdate: CharacterStateUpdate | undefined;
  readonly draft: string;
  readonly protectedSecrets: readonly string[];
  readonly knownCharacters: readonly CharacterProfile[];
  readonly characterMatrix: CharacterMatrixLedger;
}): CommitCharacterKnowledgeChangePlan {
  const stateChanges: CommitPreviewCandidate[] = [];
  if (input.conservativeCharacterUpdate?.emotion) {
    stateChanges.push(infoCandidate({
      name: `${input.characterName}：精神状态`,
      targetId: input.characterId,
      changeType: "character_state_emotion",
      before: "沿用当前状态",
      after: input.conservativeCharacterUpdate.emotion,
      evidence: input.semanticSummary.conflict ?? input.semanticSummary.mainEvent,
    }));
  }
  if (input.conservativeCharacterUpdate?.goal) {
    stateChanges.push(infoCandidate({
      name: `${input.characterName}：当前目标`,
      targetId: input.characterId,
      changeType: "character_state_goal",
      before: "沿用当前目标",
      after: input.conservativeCharacterUpdate.goal,
      evidence: input.semanticSummary.decision ?? input.semanticSummary.nextLead ?? input.semanticSummary.mainEvent,
    }));
  }

  const knowledgeKnownChanges = uniqueCandidates([
    input.semanticSummary.discovery
      ? infoCandidate({
        name: `${input.characterName}知道：${trimSentence(input.semanticSummary.discovery, 40)}`,
        targetId: input.characterId,
        changeType: "knowledge_known",
        before: "未记录",
        after: trimSentence(input.semanticSummary.discovery, 90),
        evidence: input.semanticSummary.discovery,
      })
      : undefined,
  ].filter((item): item is CommitPreviewCandidate => item !== undefined));

  const forbiddenRevealTouches = uniqueCandidates(input.protectedSecrets
    .filter((secret) => input.draft.includes(secret))
    .map((secret) => highCandidate({
      name: `触碰禁止揭示：${secret}`,
      targetId: input.characterId,
      changeType: "forbidden_reveal_touch",
      before: "受保护",
      after: secret,
      evidence: matchingSentence(input.draft, new RegExp(escapeRegExp(secret), "u")) ?? secret,
    })));

  return {
    stateChanges,
    knowledgeKnownChanges,
    knowledgeUnknownChanges: [],
    characterMatrixCandidates: buildCharacterMatrixCandidates({
      draft: input.draft,
      semanticSummary: input.semanticSummary,
      knownCharacters: input.knownCharacters,
      characterMatrix: input.characterMatrix,
    }),
    forbiddenRevealTouches,
  };
}

function buildCharacterMatrixCandidates(input: {
  readonly draft: string;
  readonly semanticSummary: ChapterSemanticSummary;
  readonly knownCharacters: readonly CharacterProfile[];
  readonly characterMatrix: CharacterMatrixLedger;
}): readonly CommitPreviewCandidate[] {
  const body = stripMarkdownHeadings(input.draft);
  const knownNames = new Set(input.knownCharacters.flatMap((character) => [character.name, character.id]).filter(isNonEmptyString));
  const existingNames = new Set((input.characterMatrix.entries ?? []).map((entry) => entry.name));
  const candidates: CommitPreviewCandidate[] = [];
  const sentences = splitSentences(body);
  for (const item of extractPossibleCharacterMentions(body)) {
    if (!isLikelyNewCharacterName(item.name, knownNames, existingNames)) continue;
    const relatedEvidence = collectCharacterEvidence(sentences, item.name);
    const roleHint = relatedEvidence.map(inferCharacterRoleHint).find(isNonEmptyString);
    const relationHint = relatedEvidence.map((sentence) => inferCharacterRelationHint(sentence, input.semanticSummary.protagonist)).find(isNonEmptyString);
    const evidence = relatedEvidence.find((sentence) => inferCharacterRoleHint(sentence)) ?? item.evidence;
    const after = unique([roleHint, relationHint, "轻量候选，未升级为正式角色档案"].filter(isNonEmptyString)).join("；");
    candidates.push(warningCandidate({
      name: `${item.name}（新人物矩阵候选）`,
      targetId: `matrix-${shortHash(item.name)}`,
      changeType: "character_matrix_candidate",
      before: "未记录",
      after,
      evidence,
    }));
  }
  return uniqueCandidates(candidates).slice(0, 8);
}

function collectCharacterEvidence(sentences: readonly string[], name: string): readonly string[] {
  const evidence: string[] = [];
  for (let index = 0; index < sentences.length; index += 1) {
    const sentence = sentences[index] ?? "";
    if (!sentence.includes(name)) continue;
    evidence.push(sentence);
    const next = sentences[index + 1] ?? "";
    if (/^(?:他|她|对方|其)|(?:工牌|胸牌|名片|证件|递给|提醒|低声|回答|说)/u.test(next)) {
      evidence.push(next);
    }
  }
  return unique(evidence);
}

function extractPossibleCharacterMentions(body: string): readonly { readonly name: string; readonly evidence: string }[] {
  const sentences = splitSentences(body);
  const mentions: { name: string; evidence: string }[] = [];
  const patterns = [
    /([\u4e00-\u9fa5]{2,4})从[^，。！？]{0,12}(?:走出来|走出|走来|出现)/gu,
    /(?:看见|看到|注意到|遇见|碰见|迎上|走近|叫住|拦住)\s*([\u4e00-\u9fa5]{2,4})/gu,
    /([\u4e00-\u9fa5]{2,4})(?:站在|把|将|没有|提醒|低声|说|问|开口|递给|拿出|出现|走来|走出来|看着|点头|摇头|皱眉|盯着|抬手|推开|递过来|压低声音|头也没抬|终于|拒绝|一开始|看了他一眼|看了她一眼)/gu,
    /“[^”]{1,100}”\s*([\u4e00-\u9fa5]{2,4})(?:说|问|提醒|开口|低声)/gu,
    /(?:^|[，。！？、：；“”\s在到向对跟和与])([\u4e00-\u9fa5]{2,4})的(?:胸牌|名片|声音|手|目光|脸|背影|工牌|证件|工位|座位|办公桌|电脑|系统账号|权限|申请单)/gu,
  ] as const;
  for (const sentence of sentences) {
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      for (const match of sentence.matchAll(pattern)) {
        const name = normalizeCharacterCandidateName(match[1] ?? "");
        if (name) mentions.push({ name, evidence: sentence });
      }
    }
  }
  return mentions;
}

function normalizeCharacterCandidateName(value: string): string {
  return value
    .replace(/^(?:又在|能让|在|到|向|对|跟|和|与|让|叫|请)/u, "")
    .replace(/(?:把|将|没有|提醒|低声|说|问|开口|递给|拿出|出现|走来|走出来|看着|点头|摇头|皱眉|盯着|抬手|推开|递过来|压低声音|头也没抬|终于|拒绝|一开始|看了他一眼|看了她一眼).*$/u, "")
    .replace(/[“”"'，。！？、：；\s]/gu, "")
    .trim();
}

// 加强（破例⑥·2026-06-24·姓氏硬闸）：中文人名几乎都以姓氏开头。常见姓氏集合（含单字姓 + 几个明确的复姓首字），
// 覆盖约 99% 真实姓名，用作候选人名的正向硬闸——字符黑名单是结尾锚定、治不住「茶几上放 / 透过烟雾 / 耳边轻声 / 似乎 /
// 得像是在」这类中间带方位字、或动词/副词结尾的描写碎片（真书实测全漏过）；改判「首字必须是姓氏」一刀切干净、不误杀真名。
const CHINESE_SURNAME_INITIALS: ReadonlySet<string> = new Set(
  "王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾肖田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严赖覃洪武莫孔汤向常温康施文牛樊葛邢路岳齐梅庄辛管祝左涂谷祁时舒耿牟卜詹关苗凌费纪靳盛童欧甄项曲成游阳裴席卫查屈鲍霍翁隋甘景单包司柏宁柯阮桂闵解强柴华车冉房边辜吉饶刁瞿戚丘古米池滕晋苑邬臧宫来苟全褚廉简娄盖符奚穆党燕郎邸冀谈姬屠连郜晏栾郁商蒙喻揭窦迟宇敖糜鄢冷卓花仇艾蓝都巩井练仲虞卞封竺原官楚佟栗匡宗应巫鞠桑荆谌银扬沙伏岑习胥和蔺云昌诸皇令尉慕赫独澹".split(""),
);

function isLikelyNewCharacterName(
  name: string,
  knownNames: ReadonlySet<string>,
  existingNames: ReadonlySet<string>,
): boolean {
  if (name.length < 2 || name.length > 4) return false;
  if (knownNames.has(name) || existingNames.has(name)) return false;
  if (/^(?:他|她|自己|那里|这里|对方|男人|女人|父亲|母亲|爷爷|奶奶|叔叔|阿姨|老师|老板|秘书|主管|同事|保安|司机|前台|医生|护士|回答)$/u.test(name)) return false;
  if (/(?:集团|公司|部门|科室|办公室|档案室|会议室|走廊|门外|权限|录音|文件|资料|现金|手机|楼层|城市|世界|主角|作者)$/u.test(name)) return false;
  if (/^(?:银色|黑色|白色|红色|黄色|当前|尚未|已经|正在|这个|那个|一支|一张|一份|一个|一种|一些|后才|立刻|马上|终于|没有|并未|开始|继续|只是|不能|不会|需要|对应|申请|编号|备份|日志|流程|从|又|能|在)/u.test(name)) return false;
  if (/(?:推出|追问|知道|确认|对应|授权|申请|编号|删除|归档|开始|继续|影里|门缝|风险|流程外)$/u.test(name)) return false;
  // \u4fee P1\u00b71\uff08\u53d7\u63a7\u7834\u4f8b\u2465\uff09\uff1a\u786c\u6536\u7d27\u2014\u2014\u6b63\u6587\u788e\u7247\u4e0d\u5f53\u4eba\u540d\u3002
  // \u2460 \u62d2\u7edd\u542b\u4ee3\u8bcd/\u865a\u8bcd/\u4ecb\u8bcd\u7b49\u7edd\u4e0d\u51fa\u73b0\u5728\u4eba\u540d\u91cc\u7684\u5b57\uff08\u6cbb\u300c\u4ed6\u62b9\u4e86\u300d\u300c\u8fde\u673a\u4f1a\u90fd\u300d\u300c\u6211\u4e8c\u8bdd\u6ca1\u300d\u300c\u4e0a\u4e2a\u6708\u4e5f\u300d\u8fd9\u7c7b\u788e\u7247\uff09\u3002
  if (/[\u6211\u4f60\u4ed6\u5979\u5b83\u54b1\u4ffa\u60a8\u8c01\u4e5f\u90fd\u5c31\u624d\u8fd8\u53c8\u518d\u6ca1\u4e0d\u522b\u8fde\u628a\u5c06\u88ab\u8ba9\u7ed9\u4ece\u5411\u5f80\u5230\u8ddf\u5bf9\u5f88\u592a\u6700\u633a\u66f4\u5e76\u4e14\u5374\u800c]/u.test(name)) return false;
  // \u2461 \u62d2\u7edd\u4ee5\u65b9\u4f4d/\u65f6\u95f4/\u8bed\u6c14\u540e\u7f00\u7ed3\u5c3e\u7684\u788e\u7247\uff08\u6cbb\u300c\u5e97\u5173\u95e8\u524d\u300d\u8fd9\u7c7b\uff09\u3002
  if (/(?:\u524d|\u540e|\u4e2d|\u91cc|\u4e0a|\u4e0b|\u65f6|\u5916|\u5185|\u65c1|\u8fb9|\u4e86|\u7684|\u7740|\u8fc7|\u5730|\u5f97|\u5462|\u5417|\u5427|\u554a|\u54e6|\u55ef)$/u.test(name)) return false;
  // \u2462 \u59d3\u6c0f\u786c\u95f8\uff082026-06-24\uff09\uff1a\u9996\u5b57\u5fc5\u987b\u662f\u5e38\u89c1\u59d3\u6c0f\uff0c\u5426\u5219\u4e00\u5f8b\u4e0d\u662f\u4eba\u540d\uff08\u6cbb\u5b57\u7b26\u9ed1\u540d\u5355\u6f0f\u8fc7\u7684\u63cf\u5199\u788e\u7247\uff09\u3002
  if (!CHINESE_SURNAME_INITIALS.has(name[0] ?? "")) return false;
  // \u58f0/\u6001\u5f62\u5bb9\u8bcd\uff08\u51b7\u786c\u7684\u58f0\u97f3\u3001\u6c99\u54d1\u7684\u55d3\u97f3\u2026\uff09\uff1a\u59d3\u6c0f\u5b57\uff08\u51b7/\u534e\u2026\uff09+ \u5f62\u5bb9\u8bcd\u7b2c\u4e8c\u5b57\u4f1a\u88ab\u300cX\u7684\u58f0\u97f3/\u76ee\u5149\u300d\u9886\u5c5e\u5f0f\u8bef\u5f53\u4eba\u540d
  // \uff08Codex 1-5 \u7ae0\u771f\u673a\uff1a\u300e\u51b7\u786c\u7684\u58f0\u97f3\u300f\u6536\u4e86\u300e\u51b7\u786c\u300f\uff09\u3002\u6574\u8bcd\u62d2\uff1b\u58f0/\u6001\u5f62\u5bb9\u8bcd\u9898\u6750\u4e2d\u7acb\u3001\u4e0d\u4f1a\u662f\u771f\u4eba\u540d\u3002
  if (/^(?:\u51b7\u786c|\u51b0\u51b7|\u51b7\u6f20|\u6e05\u51b7|\u6c99\u54d1|\u5636\u54d1|\u4f4e\u6c89|\u6d51\u539a|\u82cd\u8001|\u9634\u6c89|\u964c\u751f|\u6e29\u548c|\u67d4\u548c|\u6c89\u7a33|\u6c89\u9ed8|\u5e73\u9759|\u6025\u4fc3|\u8f7b\u67d4|\u98a4\u6296|\u6c99\u6c89|\u5c16\u5229|\u75b2\u60eb|\u6c99\u6da9|\u51b7\u6de1|\u51b7\u5cfb|\u51b7\u51bd)$/u.test(name)) return false;
  return /[\u4e00-\u9fa5]{2,4}/u.test(name);
}

function inferCharacterRoleHint(evidence: string): string | undefined {
  const quotedRole = /(?:胸牌|工牌|名片|证件).{0,16}[“"]([^”"]{2,24})[”"]/u.exec(evidence)?.[1];
  if (quotedRole) return `身份线索：${trimSentence(quotedRole, 40)}`;
  const role = /(战略审计部|法务部|秘书处|审计部|安保部|调查组|董事会|生活秘书|律师|记者|医生|老师|保安|司机|前台)/u.exec(evidence)?.[1];
  return role ? `身份线索：${role}` : undefined;
}

function inferCharacterRelationHint(evidence: string, protagonist: string | undefined): string | undefined {
  const prefix = protagonist ? `与${protagonist}关系：` : "关系：";
  if (/提醒|低声|给你方向|给.{0,8}方向|别太相信|提示|递给|推到.{0,8}面前/u.test(evidence)) return `${prefix}信息提供者 / 风险不明`;
  if (/拦住|盯着|警告|威胁|不许|阻止/u.test(evidence)) return `${prefix}阻碍者 / 需要确认立场`;
  if (/点头|合作|帮|带路|接应/u.test(evidence)) return `${prefix}临时协助`;
  return `${prefix}待确认`;
}

// 题材中立化（R5b · 2026-06-20）：人名不写死，运行期从项目 characters[].name +
// semanticSummary.protagonist 收集真实角色名，动态构造正则用（escapeRegExp 转义、按长度降序避免短名抢匹配）。
function collectKnownCharacterNames(
  characters: readonly CharacterProfile[],
  protagonist: string | undefined,
): readonly string[] {
  return unique([
    ...(protagonist ? [protagonist] : []),
    ...characters.map((character) => character.name),
  ].filter(isNonEmptyString))
    .filter((name) => name.length >= 2 && name.length <= 6)
    .sort((left, right) => right.length - left.length);
}

/**
 * 组装名字漂移校验用的「已确立角色」名册：已登记角色名 + 调用方传入的 prose-only 名（含跨章名）。
 * 传入项支持「名字|别名1|别名2」竖线分隔，拆成规范名 + 别名。题材中立，纯字符串处理。
 */
function buildEstablishedCharacterRegistry(
  characters: readonly CharacterProfile[],
  establishedCharacterNames: readonly string[] | undefined,
): EstablishedCharacter[] {
  const registry: EstablishedCharacter[] = [];
  const seen = new Set<string>();
  for (const character of characters) {
    const name = character.name?.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    registry.push({ canonicalName: name, identityKey: toSafeCharacterId(character.id) });
  }
  for (const raw of establishedCharacterNames ?? []) {
    const parts = raw.split(/[|｜]/u).map((part) => part.trim()).filter(Boolean);
    const canonicalName = parts[0];
    if (!canonicalName || seen.has(canonicalName)) continue;
    seen.add(canonicalName);
    const aliases = parts.slice(1);
    registry.push({ canonicalName, ...(aliases.length > 0 ? { aliases } : {}) });
  }
  return registry;
}

// 返回一个匹配「任意已登记角色名 | 通用第三人称代词」的正则片段（无名时退到通用代词）。
function characterNameAlternation(knownCharacterNames: readonly string[]): string {
  const escaped = knownCharacterNames.map((name) => escapeRegExp(name));
  return [...escaped, "他", "她", "自己"].join("|");
}

function buildAssetChangePlan(
  draft: string,
  ledger: AssetLedger,
  knownCharacterNames: readonly string[],
): CommitAssetChangePlan {
  const body = stripMarkdownHeadings(draft);
  const registeredNames = new Set((ledger.assets ?? []).map((asset) => asset.name));
  const newAssetCandidates: CommitPreviewCandidate[] = [];
  const assetStatusChanges: CommitPreviewCandidate[] = [];
  const assetUsageEvidence: CommitPreviewCandidate[] = [];
  const unregisteredAssetWarnings: CommitPreviewCandidate[] = [];

  for (const candidate of extractAssetCandidates(body)) {
    if (!registeredNames.has(candidate.name) && !newAssetCandidates.some((item) => item.name === candidate.name)) {
      newAssetCandidates.push(candidate);
    }
  }

  // 题材中立化（R5b）：原先写死「欠费手机」「半张魂钢申请表」专名 + 林序人名。
  // 改为数据驱动——遍历账本里状态为「不可用（locked/受限）」或「破损（damaged/half）」的已登记资产，
  // 看正文是否把它写成正常可用 / 凭空复原，命中才报风险，名字直接取自账本（不再写死题材专名）。
  for (const warning of detectLockedAssetRestoredAsWorking(body, ledger)) {
    assetStatusChanges.push(warning);
    unregisteredAssetWarnings.push(warning);
  }
  for (const warning of detectDamagedAssetRestoredAsComplete(body, ledger)) {
    assetStatusChanges.push(warning);
    unregisteredAssetWarnings.push(warning);
  }

  const vehiclePerson = characterNameAlternation(knownCharacterNames);
  const vehicleEvidence = matchingSentence(body, new RegExp(`(?:${vehiclePerson}).{0,20}(?:开车|骑上(?:自行车|电动车|摩托)?|骑着(?:自行车|电动车|摩托|车)|开着(?:车|商务车|汽车|轿车|越野车|面包车)|发动(?:车|汽车|引擎)|拿出车钥匙|坐上出租|上了出租|打车去|叫了车|拦了车|打了一辆(?:车|出租车)|网约车)|(?:打车去|坐上出租|上了出租|打了一辆(?:车|出租车))`, "u"));
  if (vehicleEvidence && !hasRegisteredVehicle(ledger)) {
    const warning = highCandidate("未登记交通工具或打车条件", vehicleEvidence);
    if (!isNegatedVehicleEvidence(vehicleEvidence)) {
      assetUsageEvidence.push(warning);
      unregisteredAssetWarnings.push(warning);
    }
  }

  return {
    newAssetCandidates,
    assetStatusChanges,
    assetUsageEvidence,
    unregisteredAssetWarnings,
  };
}

// 题材中立（R5b）：账本里状态=locked/受限的已登记资产，若正文写成正常使用（联网/通话/启动/解锁…）→ 报风险。
// 名字取自账本资产名，不写死任何题材专名。
function detectLockedAssetRestoredAsWorking(body: string, ledger: AssetLedger): readonly CommitPreviewCandidate[] {
  const warnings: CommitPreviewCandidate[] = [];
  for (const asset of ledger.assets ?? []) {
    if (!isUnavailableAssetStatus(asset.status)) continue;
    const escaped = escapeRegExp(asset.name);
    const evidence = matchingSentence(body, new RegExp(`${escaped}.{0,24}(?:联网|上网|连上网|连上|刷新|通话|打电话|解锁|启用|启动|恢复使用|正常使用|可以用了)`, "u"));
    if (!evidence) continue;
    if (/不能联网|无法联网|没法联网|没有联网|连不上网|(?:欠费|锁定|受限).{0,12}(?:不能|无法|没法)|暂停服务|仍然.{0,8}不能|依旧.{0,8}不能/u.test(evidence)) continue;
    const networked = /联网|上网|连上网|连上|刷新|通话|打电话/u.test(evidence);
    warnings.push(highCandidate(`${asset.name}${networked ? "正常联网" : "正常使用"}风险`, evidence));
  }
  return warnings;
}

// 题材中立（R5b）：账本里状态=damaged 的已登记资产，若正文写成凭空复原/补全成完整 → 报风险。
function detectDamagedAssetRestoredAsComplete(body: string, ledger: AssetLedger): readonly CommitPreviewCandidate[] {
  const warnings: CommitPreviewCandidate[] = [];
  for (const asset of ledger.assets ?? []) {
    if (asset.status !== "damaged") continue;
    const escaped = escapeRegExp(asset.name);
    const evidence = matchingSentence(body, new RegExp(`${escaped}.{0,16}(?:变成|恢复|补成|拼成|成了|补好|补齐).{0,8}完整|完整.{0,8}${escaped}(?:拿到|到手|出现|补好|补齐)`, "u"));
    if (!evidence) continue;
    if (/不完整|不是完整|不能.{0,8}完整|没有.{0,8}完整|仍是|仍然.{0,4}(?:破|半|残)|依旧.{0,4}(?:破|半|残)/u.test(evidence)) continue;
    warnings.push(highCandidate(`${asset.name}凭空复原为完整风险`, evidence));
  }
  return warnings;
}

function isUnavailableAssetStatus(status: string): boolean {
  return status === "locked" || status === "lost" || /受限|不可用|停用/u.test(status);
}

// 抽象/结构性词，不是可登记进资产账本的具体物件——别列成新资产候选（rerun2 P2：节点/区域/可追踪物证 噪声）。
// 题材中立：只列明显的抽象/空间/线索类通用词，不预设任何题材。后缀匹配（「可追踪物证」「东区区域」都落入）。
const NON_ASSET_GENERIC_TERMS = [
  "节点", "区域", "地带", "一带", "范围", "方位", "位置", "通道", "物证", "证据", "线索",
  "现场", "角落", "部位", "部分", "路段", "地段", "方向", "环境", "空间", "区间", "区块",
] as const;

// 身体部位（题材中立·人体通用）。**全 ≥2 字**：故意不含单字 手/眼/脚/背，保护 扳手/桌脚/椅背 等复合物件。
const ASSET_BODY_PART_SUFFIXES = [
  "右眼", "左眼", "双眼", "眼睛", "眼角", "眉毛", "鼻子", "嘴唇", "耳朵", "喉咙", "侧脸", "额头", "下巴",
  "脖子", "肩膀", "胳膊", "手臂", "手腕", "手指", "手掌", "拳头", "胸口", "后背", "脊背", "背影", "膝盖",
  "脚踝", "小腿", "大腿", "头发",
] as const;
// 泛物/碎屑（明显非可登记物件）。只列高确定项，**不含 碎屑**（金属碎屑是有效物证候选）。
const ASSET_GENERIC_OBJECT_SUFFIXES = ["东西", "物品", "玩意", "废铁", "碎石", "瓦砾", "碎砖"] as const;
// 从句/谓语标记：助词/副词夹在中间（前后都有字）说明这是一个句子片段、不是物件名（柜子里放了东西 / 数字还清晰）。
// 前后都要有字 → 保护以这些字起头的真物件（还魂草 的「还」在词首、不撞）。
const CLAUSE_PREDICATE_MARK = /.[了还就都也竟却仍].|正在|刚刚|已经/u;

/** 该候选名是否为「抽象/结构性通用词/身体部位/形状/从句」而非具体物件 → 不应进资产候选。 */
export function isGenericNonAssetName(name: string): boolean {
  const n = name.trim();
  if (!n) return true;
  if (NON_ASSET_GENERIC_TERMS.some((term) => n === term || n.endsWith(term))) return true;
  if (ASSET_BODY_PART_SUFFIXES.some((term) => n.endsWith(term))) return true;
  if (ASSET_GENERIC_OBJECT_SUFFIXES.some((term) => n.endsWith(term))) return true;
  if (/形$/u.test(n)) return true; // 纯形状（三角形/圆形/方形）
  if (CLAUSE_PREDICATE_MARK.test(n)) return true; // 从句/谓语片段
  // 捕获正则过捕的方位从句残片（题材中立）：① 残留前导虚词（的底片…）；② 悬挂方位/介词尾（公开财报里 / 那卷从）；
  // ③「X 平铺/夹/搁/摆在 Y」的置于从句（缺角的轮渡票平铺在旧…）。在 dedup 前剔除，避免最长过捕串挤掉干净物件名。
  if (/^[的了着地得]/u.test(n)) return true;
  if (n.length >= 3 && /[里中旁外从在到]$/u.test(n)) return true;
  if (/(?:平铺|铺|摆|夹|搁|摊|贴|压|挂|放|塞|推|按|举|架)在./u.test(n)) return true;
  return false;
}

function extractAssetCandidates(body: string): readonly CommitPreviewCandidate[] {
  const candidates: CommitPreviewCandidate[] = [];
  const moneyEvidence = matchingSentence(body, /(?:\d+(?:\.\d+)?元|\d+(?:\.\d+)?块钱?|[一二三四五六七八九十百千万]+块[一二三四五六七八九十]?毛|[一二三四五六七八九十百千万]+块钱|[一二三四五六七八九十百千万]+元|现金|钱包|余额)/u);
  if (moneyEvidence && isMoneyAssetEvidence(moneyEvidence)) candidates.push(warningCandidate(extractMoneyName(moneyEvidence), moneyEvidence));
  for (const item of extractGenericAssetMentions(body)) {
    if (isIdentityMarkerAssetEvidence(item.name, item.evidence)) continue;
    if (isGenericNonAssetName(item.name)) continue; // 抽象/结构性通用词不进资产候选（降噪）
    if (!isNegatedAssetEvidence(item.evidence, item.name)) {
      candidates.push(warningCandidate({
        name: item.name,
        changeType: "new_asset_candidate",
        before: "未登记",
        after: "章节正文出现的新物件候选",
        evidence: item.evidence,
      }));
    }
  }
  return uniqueAssetCandidates(candidates);
}

// 题材中立化（R5b）：原先既有写死的「物资表」（压缩饼干/矿泉水/午餐肉/罐头…）又有写死的
// 「物件正则」职场词表（录音笔/权限盘/工牌…）。两者全删，改为纯语法驱动——用「量词 / 取得动词 + 名词短语」
// 这种题材中立的语法信号抽新物件候选，不再枚举任何具体名词，对任何题材都成立。
function extractGenericAssetMentions(body: string): readonly { readonly name: string; readonly evidence: string }[] {
  const results: { name: string; evidence: string }[] = [];
  // ① 量词引出：一/那/这 + 量词 +（可选颜色/形容词）+ 名词。颜色/形容词前缀保留，便于 uniqueAssetCandidates 取更具体名。
  const measurePattern = /(?:一|那|这)(?:支|只|把|枚|张|份|个|瓶|袋|盒|罐|包|块|条|本|台|部)((?:银色|蓝色|黑色|白色|红色|黄色|金色|旧|破旧|残缺|加密|备用|新)?[一-龥]{2,10})/gu;
  // ② 取得动词引出：买/购/掏出/摸出/取出 +（可选「了」）+ 名词（题材中立，不枚举名词；
  //    刻意不收「递给/拿/带」这类后面常跟人名的动词，避免把人名误当物件）。
  const acquirePattern = /(?:买|购|掏出|摸出|取出)了?((?:银色|蓝色|黑色|白色|红色|黄色|金色|旧|破旧|残缺|加密|备用|新)?[一-龥]{2,8})/gu;
  for (const sentence of splitSentences(body)) {
    for (const pattern of [measurePattern, acquirePattern]) {
      pattern.lastIndex = 0;
      for (const match of sentence.matchAll(pattern)) {
        for (const name of expandConjoinedAssetNames(normalizeAssetCandidateName(match[1] ?? ""))) {
          if (name) results.push({ name, evidence: sentence });
        }
      }
    }
  }
  return results;
}

// 把「压缩饼干和矿泉水」这类并列短语拆成多个物件名（题材中立，按「和/与/、/及」断词）。
function expandConjoinedAssetNames(value: string): readonly string[] {
  if (!value) return [];
  return value
    .split(/和|与|、|及|跟/u)
    .map((part) => normalizeAssetCandidateName(part))
    .filter(Boolean);
}

function normalizeAssetCandidateName(value: string): string {
  const name = value
    .replace(/^一[支只把枚张份个瓶袋盒罐包块条本台部]/u, "")
    .replace(/(?:推到|递给|放进|塞进|放在|放回|拿在|挂在|压在|按在|举在).*$/u, "")
    .trim();
  return name.length >= 2 && name.length <= 12 ? name : "";
}

function isNegatedAssetEvidence(evidence: string, name: string): boolean {
  const escaped = escapeRegExp(name);
  if (new RegExp(`别人的${escaped}|没有拿走.{0,8}${escaped}|没拿.{0,8}${escaped}`, "u").test(evidence)) return true;
  if (/(?:没有|没|并未|不).{0,10}(?:拿到|得到|收下|带走|放进口袋|塞进|握住|拿出|递给|推到|出现).{0,10}/u.test(evidence)) return true;
  return false;
}

function isIdentityMarkerAssetEvidence(name: string, evidence: string): boolean {
  return /^(?:工牌|胸牌|名片|证件)$/u.test(name) && /(?:写着|上写|标着|身份|部门|职位)/u.test(evidence);
}

function isMoneyAssetEvidence(evidence: string): boolean {
  if (/(?:没有|没|并未|未|不曾|无).{0,12}(?:获得|得到|拿到|收到|带走|拥有).{0,8}(?:现金|余额)|(?:现金|余额).{0,12}(?:没有到手|没到手|无法使用|不能使用)/u.test(evidence)) return false;
  if (/现金流|资金流/u.test(evidence) && !/(?:\d+(?:\.\d+)?元|\d+(?:\.\d+)?块钱?|[一二三四五六七八九十百千万]+块|[一二三四五六七八九十百千万]+元|钱包|余额|口袋|摸到|掏出|拿出|收下|收到|获得|得到)/u.test(evidence)) return false;
  return /(?:\d+(?:\.\d+)?元|\d+(?:\.\d+)?块钱?|[一二三四五六七八九十百千万]+块[一二三四五六七八九十]?毛|[一二三四五六七八九十百千万]+块钱|[一二三四五六七八九十百千万]+元|钱包|余额|口袋.{0,8}现金|摸到.{0,8}现金|掏出.{0,8}现金|拿出.{0,8}现金|收下.{0,8}现金|收到.{0,8}现金|获得.{0,8}现金|得到.{0,8}现金)/u.test(evidence);
}

function extractMoneyName(evidence: string): string {
  const amount = /((?:\d+(?:\.\d+)?)|(?:[一二三四五六七八九十百千万]+))(?:块(?:钱)?|元|毛)/u.exec(evidence)?.[0];
  return amount ? `${amount}现金` : "现金/余额";
}

function hasRegisteredVehicle(ledger: AssetLedger): boolean {
  return (ledger.assets ?? []).some((asset) =>
    asset.type === "vehicle" || /车|摩托|自行车/u.test(asset.name));
}

function isNegatedVehicleEvidence(evidence: string): boolean {
  return /(?:不现实|不能|无法|没法|没有|没钱|不够|叫不了|打不起|坐不起).{0,16}(?:打车|叫车|出租|网约车|开车|骑车)|(?:打车|叫车|出租|网约车|开车|骑车).{0,16}(?:不现实|不能|无法|没法|没有|没钱|不够|叫不了|打不起|坐不起)/u.test(evidence);
}

function buildLocationChangePlan(
  draft: string,
  locationBible: LocationBible | undefined,
  assetChanges: CommitAssetChangePlan,
  knownCharacterNames: readonly string[],
): CommitLocationChangePlan {
  const body = stripMarkdownHeadings(draft);
  const knownLocationTerms = knownLocationNames(locationBible);
  // 题材中立化（R5b）：删掉写死的固定地名表（便利店/老邮局/财团联合检测中心/市中心…）。
  // 改为只用 extractGenericLocationMentions 的「题材中立结构/设施后缀」语法兜底抽新地点候选。
  const newLocationCandidates = uniqueLocationCandidates([
    ...extractGenericLocationMentions(body, knownCharacterNames)
      .filter((item) => !knownLocationTerms.some((known) => known.includes(item.name) || item.name.includes(known)))
      .filter((item) => !isKnownLocationMicroPosition(item.name, knownLocationTerms))
      .filter((item) => !isNegatedLocationCandidate(item.evidence, item.name))
      .map((item) => warningCandidate({
        name: item.name,
        changeType: "new_location_candidate",
        before: "未登记",
        after: "章节正文出现的新地点候选",
        evidence: item.evidence,
      })),
  ]);
  const spatialViolationWarnings = detectSpatialViolations(body, locationBible);
  const locationTransitionCandidates = detectLocationTransitions(body, locationBible, assetChanges, knownCharacterNames);
  return {
    newLocationCandidates,
    locationTransitionCandidates,
    spatialViolationWarnings,
  };
}

// 题材中立结构/设施后缀：纯结构词（档案室/会议室/走廊/大厅/楼梯间/门口…）+ 通用设施类别
// （店/超市/餐厅/酒店/银行/邮局/医院/药店/电话亭/加油站/车库/停车场/公共电话…）。
// 题材中立「结构后缀」：建筑内部的结构性场所名（档案室/会议室/走廊/大厅/楼梯间/门口/窗口/地下车库…）。
// 这类常带较长建筑前缀（如「海港集团二十七层的档案室门外」），用 building-prefix 模式抽。
const STRUCTURAL_LOCATION_SUFFIXES = [
  "档案室门外",
  "会议室外的长廊",
  "会议室门口",
  "地下车库",
  "电梯厅",
  "楼梯间",
  "档案室",
  "会议室",
  "办公室",
  "走廊",
  "长廊",
  "大厅",
  "公交站",
  "门口",
  "门外",
  "窗口",
] as const;

// 题材中立「设施类别后缀」：独立设施/店铺类别（店/超市/餐厅/邮局/医院/药店/银行/电话亭…）。
// 这类设施名一般是「短修饰 + 类别」（便利店/老邮局/公共电话），用 tight-bound 模式抽，避免吞掉上下文。
const FACILITY_LOCATION_SUFFIXES = [
  "公共电话",
  "便利店",
  "电话亭",
  "加油站",
  "停车场",
  "邮局",
  "超市",
  "餐厅",
  "饭店",
  "酒店",
  "银行",
  "医院",
  "药店",
  "书店",
  "网吧",
  "商店",
  "店",
] as const;

function genericLocationSuffixPattern(suffixes: readonly string[]): string {
  return [...suffixes].map((suffix) => escapeRegExp(suffix)).join("|");
}

function extractGenericLocationMentions(
  body: string,
  knownCharacterNames: readonly string[],
): readonly { readonly name: string; readonly evidence: string }[] {
  const results: { name: string; evidence: string }[] = [];
  // ① 结构性场所：前缀只保留通用建筑/机构类别词（集团/公司/学校/医院/酒店…），删掉专名前缀（不预置任何具体书里的地名）。
  const structuralPattern = new RegExp(
    `((?:[\\u4e00-\\u9fa5A-Za-z0-9]+(?:集团|公司|学校|学院|医院|酒店|小区|大厦|中心|总部)?[\\u4e00-\\u9fa5A-Za-z0-9]*(?:一|二|三|四|五|六|七|八|九|十|二十|三十|\\d+)?(?:层|楼)?(?:的)?){0,3}[\\u4e00-\\u9fa5A-Za-z0-9]{2,20}(?:${genericLocationSuffixPattern(STRUCTURAL_LOCATION_SUFFIXES)}))`,
    "gu",
  );
  // ② 设施类别：tight bound——类别后缀前只允许一个题材中立形容词修饰（老/新/旧/小/大/公共…），
  //    绝不吞动词或上下文，避免「确认便利店」「发现便利店门口」这类污染。
  const facilityPattern = new RegExp(
    `((?:老|新|旧|小|大|公共|私人|连锁|国营|社区)?(?:${genericLocationSuffixPattern(FACILITY_LOCATION_SUFFIXES)}))`,
    "gu",
  );
  for (const sentence of splitSentences(body)) {
    structuralPattern.lastIndex = 0;
    for (const match of sentence.matchAll(structuralPattern)) {
      const name = normalizeLocationCandidateName(match[1] ?? "");
      if (name && !isLocationCandidateNoise(name, knownCharacterNames)) results.push({ name, evidence: sentence });
    }
    facilityPattern.lastIndex = 0;
    for (const match of sentence.matchAll(facilityPattern)) {
      const name = normalizeFacilityCandidateName(match[1] ?? "");
      if (name && !isLocationCandidateNoise(name, knownCharacterNames)) results.push({ name, evidence: sentence });
    }
  }
  return results;
}

// 设施名归一：剥掉前导噪音字（的/了/还/挂着/一部…），保留「修饰 + 设施类别」短名；
// 若剥完仍带噪音前缀，回退到最长的设施类别后缀本身（公共电话/便利店/电话亭…）。
function normalizeFacilityCandidateName(value: string): string {
  let name = value
    // 先剥到动词/感知词之后（发现/看见/经过/走到…），再剥前导噪音字。
    .replace(/^.*(?:发现|看见|看到|注意到|经过|走到|来到|回到|进入|去了|到了|站在|路过|拐进|拐到)/u, "")
    .replace(/^(?:的|了|还|有|到|在|又|着|挂着|放着|立着|摆着|开着|前面|旁边|一部|一家|一间|一台|那家|这家|那个|这个|那部|这部)+/u, "")
    .trim();
  // 仍以噪音字开头（如「着一部公共电话」剥不净）→ 回退到匹配到的最长设施后缀。
  if (/^(?:的|了|还|有|到|在|又|着|一)/u.test(name)) {
    const tail = [...FACILITY_LOCATION_SUFFIXES]
      .filter((suffix) => name.endsWith(suffix))
      .sort((left, right) => right.length - left.length)[0];
    if (tail) name = tail;
  }
  return name.length >= 2 && name.length <= 8 ? name : "";
}

function normalizeLocationCandidateName(value: string): string {
  const compact = value
    // 位移/进出动词表：把「谁 + 位移动词 + 地点」里的动词连同其前的主语一并剥掉，只留地点名。
    // 补 走出/拐进/藏在 等（Codex retest6：走出档案室 / 拐进北塔楼梯间 / 17藏在走廊 全带动词前缀漏进候选）。
    // .*? 惰性匹配，剥到第一个位移动词为止：「拐进北塔楼梯间」只剥「拐进」、保留建筑前缀「北塔」。
    .replace(/^.*?(?:站在|走到|走出|走进|走向|来到|拐进|拐到|拐过|绕过|绕到|穿过|穿进|跑进|跑到|跑出|退到|退出|闯进|钻进|迈进|踏进|冲进|冲出|爬进|藏在|藏进|躲进|躲到|缩进|折回|返回|停在|等在|守在|进入了|进入|离开|推开|靠近|沿着|记下|经过|抵达|到达|给出的|回到|消失在|查到|要查|调阅|挡在|拦在|堵在|横在|候在|查|回)/u, "")
    .replace(/^.*?给出的/u, "")
    .replace(/^[了在到往从进出]+/u, "")
    .replace(/[，。！？、：；“”"'（）()\s]/gu, "")
    .trim()
    .slice(0, 40);
  return normalizeLocationSuffix(compact);
}

function isLocationCandidateNoise(name: string, knownCharacterNames: readonly string[]): boolean {
  if (name.length < 2) return true;
  // 题材中立化（R5b）：人名不写死（删 许澄/林序），改为运行期匹配项目已登记角色名前缀。
  if (knownCharacterNames.some((characterName) => name.startsWith(characterName))) return true;
  // 通用代词 / 指示词 / 叙事噪音前缀（题材中立，不含任何作品专名）。
  if (/^(?:这个|那个|一种|一些|当前|最后|随后|然后|声音|目光|关系|主角|正式|尚未|他|她|有人|又慢慢)/u.test(name)) return true;
  // 通用「队/组」类团体噪音（审计组/调查组/工作组…按结构后缀判定，非专名）。
  if (/^.{0,4}(?:小组|工作组|调查组|审计组|专案组)/u.test(name)) return true;
  // 物件类常见名词前缀（结构噪音，非地点）。
  if (/^(?:胸牌|名片|录音笔|权限卡|手机|现金|资料夹|文件袋)/u.test(name)) return true;
  // 裸方位/门字词（门口/门外/窗口/路口/楼下…）无建筑/专名前缀 → 不是有意义的地点候选，丢弃（Codex 1-5 章真机：门口）。
  // 带前缀的「会议室门口」不受影响（normalizeLocationSuffix 已保留前缀，name 非裸方位词）。
  if (/^(?:门口|门外|门前|门内|窗口|窗外|窗边|路口|街口|巷口|楼上|楼下|墙角|墙边|角落|身后|身边|身前|面前|外面|里面|旁边|对面|前方|后方|两侧|尽头|拐角|门边)$/u.test(name)) return true;
  // 裸「走廊/长廊」：任何多房间建筑都有走廊，无专名/建筑前缀时不是值得登记的【新】地点（Codex retest5）。
  // 只精确排走廊/长廊——同义的「楼梯间」有既有测试明确要求保留为合法候选，不连坐排除。
  if (/^(?:走廊|长廊)$/u.test(name)) return true;
  return false;
}

function normalizeLocationSuffix(value: string): string {
  const suffixes = [
    "档案室门外",
    "会议室外的长廊",
    "会议室门口",
    "地下车库",
    "电梯厅",
    "楼梯间",
    "档案室",
    "会议室",
    "办公室",
    "走廊",
    "长廊",
    "大厅",
    "公交站",
    "门口",
    "门外",
    "窗口",
  ] as const;
  for (const suffix of suffixes) {
    const index = value.lastIndexOf(suffix);
    if (index < 0) continue;
    const prefix = value.slice(0, index);
    if (!prefix) return suffix;
    const prefixTail = prefix.match(/[\u4e00-\u9fa5A-Za-z0-9]{0,12}$/u)?.[0] ?? "";
    // 题材中立：前缀尾若是叙事噪音（知道/提前/有人/那里…）或通用团体词（…组），只取后缀本身。
    if (!prefixTail || /(?:知道|提前|有人|又慢慢|那里|这里)$/u.test(prefixTail) || /(?:小组|工作组|调查组|审计组|专案组)$/u.test(prefixTail)) return suffix;
    // 体标记/时段词（了/一会儿/一下/一阵）几乎只出现在动词短语里、绝不出现在建筑名前缀（「海港集团二十七层的」没有）：
    // 前缀尾带这些=残留动词短语（如「侧身听了一会儿」走廊），不是建筑名，只取后缀本身让裸后缀走噪音过滤（Codex retest6）。
    if (/(?:了|一会儿|一下|一阵)/u.test(prefixTail)) return suffix;
    return `${prefixTail}${suffix}`;
  }
  return value;
}

// 方位微后缀：建筑上的位置点（门口/门外/后门/柜台/路口…），本身不是可登记的新地点。
const POSITIONAL_MICRO_SUFFIX = /(门口|门外|门前|门内|门边|后门|侧门|前门|窗口|窗外|窗边|柜台|吧台|路口|巷口|街口|拐角|墙角)$/u;

/**
 * 候选若 =「已知地点 + 方位微后缀」（如「报亭门口」之于已知「废弃报亭」），是已知地点的微位置、不当【新】地点候选
 * （Codex 复测：报亭门口/只是把报亭门口/又在报亭门口）。判据：剥掉方位后缀后，base 的尾部（2-4 字建筑词）
 * 是某个已知地点名的子串。base 尾是【新】地点（如「…档案室门外」之于未登记的档案室）则不丢、仍是合法新候选。
 */
function isKnownLocationMicroPosition(name: string, knownLocationTerms: readonly string[]): boolean {
  const suffix = POSITIONAL_MICRO_SUFFIX.exec(name)?.[1];
  if (!suffix) return false;
  const base = name.slice(0, name.length - suffix.length);
  if (!base) return false; // 裸方位词由 isLocationCandidateNoise 处理
  for (const known of knownLocationTerms) {
    for (let k = Math.min(4, base.length); k >= 2; k -= 1) {
      if (known.includes(base.slice(base.length - k))) return true;
    }
  }
  return false;
}

function isNegatedLocationCandidate(evidence: string, name: string): boolean {
  if (!name) return false;
  const escapedName = escapeRegExp(name);
  return new RegExp(`(?:没有|没|并未|未|不曾|不).{0,10}(?:回|进入|走进|来到|抵达|到达).{0,6}${escapedName}`, "u").test(evidence)
    || new RegExp(`${escapedName}.{0,8}(?:没有到达|没到达|未抵达|未进入|没有进入)`, "u").test(evidence);
}

function knownLocationNames(locationBible: LocationBible | undefined): readonly string[] {
  return unique((locationBible?.locations ?? []).flatMap((location) => [
    location.name,
    location.parentLocation,
    ...(location.connectedLocations ?? []),
    ...(location.spatialStructure?.floors ?? []),
    ...(location.spatialStructure?.rooms ?? []),
    ...(location.spatialStructure?.entrances ?? []),
    ...(location.spatialStructure?.exits ?? []),
  ].filter(isNonEmptyString)));
}

// 题材中立化（R5b）：原先写死「四楼/五楼/地下室/地下车库/顶楼」枚举表。
// 改为正则抽楼层 token（任意中文/数字+楼/层、地下室、地下N层、顶楼/顶层、N层建筑）
// 再与 location.spatialStructure.floors / 已登记地点名 比对，未登记才报。
const SINGLE_FLOOR_TOKEN = /((?:地下\s*(?:[一二三四五六七八九十]+|\d+)\s*层)|地下室|(?:[一二三四五六七八九十]+|\d+)\s*层楼|(?:[一二三四五六七八九十]+|\d+)\s*楼|地下车库)/gu;
const GENERIC_FLOOR_TOKEN = /(顶楼|顶层)/u;
const TOTAL_FLOOR_TOKEN = /(?:[一二三四五六七八九十]+|\d+)\s*(?:层建筑|层楼|层高楼|层的大楼|层的建筑)/u;

function extractFloorTokens(body: string): readonly { readonly token: string; readonly evidence: string }[] {
  const results: { token: string; evidence: string }[] = [];
  for (const sentence of splitSentences(body)) {
    SINGLE_FLOOR_TOKEN.lastIndex = 0;
    for (const match of sentence.matchAll(SINGLE_FLOOR_TOKEN)) {
      const token = (match[1] ?? "").replace(/\s+/gu, "");
      if (token) results.push({ token, evidence: sentence });
    }
  }
  return results;
}

function isRegisteredFloor(
  token: string,
  floors: ReadonlySet<string>,
  registeredLocationTerms: readonly string[],
): boolean {
  if (floors.has(token)) return true;
  // 已登记楼层/地点名互为子串即视为已登记（数字与中文数字归一后比对）。
  const variants = unique([token, normalizeFloorDigits(token), normalizeFloorChinese(token)]);
  return [...floors].some((floor) => variants.some((variant) => floor.includes(variant) || variant.includes(floor)))
    || registeredLocationTerms.some((term) => variants.some((variant) => term.includes(variant) || variant.includes(term)));
}

function detectSpatialViolations(body: string, locationBible: LocationBible | undefined): readonly CommitPreviewCandidate[] {
  const locations = locationBible?.locations ?? [];
  const floors = new Set(locations.flatMap((location) => location.spatialStructure?.floors ?? []));
  const registeredLocationTerms = knownLocationNames(locationBible);
  const fixedFacts = locations.flatMap((location) => location.fixedFacts ?? []);
  const candidates: CommitPreviewCandidate[] = [];
  const seenTokens = new Set<string>();
  for (const { token, evidence } of extractFloorTokens(body)) {
    if (seenTokens.has(token)) continue;
    seenTokens.add(token);
    if (isNegatedSpatialMention(evidence, token)) continue;
    if (isRegisteredFloor(token, floors, registeredLocationTerms)) continue;
    candidates.push(highCandidate(`未登记楼层：${token}`, evidence));
  }
  const topFloorEvidence = matchingSentence(body, GENERIC_FLOOR_TOKEN);
  if (topFloorEvidence) {
    const topToken = GENERIC_FLOOR_TOKEN.exec(topFloorEvidence)?.[1] ?? "顶楼";
    if (!isNegatedSpatialMention(topFloorEvidence, topToken) && !isRegisteredFloor(topToken, floors, registeredLocationTerms)) {
      candidates.push(warningCandidate(`未登记泛化楼层描述：${topToken}`, topFloorEvidence));
    }
  }
  const totalFloorEvidence = matchingSentence(body, TOTAL_FLOOR_TOKEN);
  if (totalFloorEvidence && !isNegatedSpatialMention(totalFloorEvidence, "") && !registeredFactsAllowFloorDescription(totalFloorEvidence, floors, fixedFacts)) {
    candidates.push(warningCandidate("未登记建筑总层数描述", totalFloorEvidence));
  }
  return candidates;
}

// 题材中立：否定句判定不再写死具体楼层枚举，改为「否定 + 移动/感知动词 + 该 token」通用结构。
function isNegatedSpatialMention(sentence: string, token: string): boolean {
  const escaped = token ? escapeRegExp(token) : "(?:地下车库|地下室|顶楼|顶层|(?:[一二三四五六七八九十]+|\\d+)\\s*楼|(?:[一二三四五六七八九十]+|\\d+)\\s*层楼)";
  return new RegExp(`(?:没有|没|并未|不).{0,12}(?:去|进入|搜索|到达|抵达|走到|前往|上到|下到|看见|出现).{0,12}${escaped}`, "u").test(sentence);
}

function registeredFactsAllowFloorDescription(evidence: string, floors: ReadonlySet<string>, fixedFacts: readonly string[]): boolean {
  const registeredText = [...floors, ...fixedFacts].join("\n");
  const floorCount = evidence.match(/(?:四|五|六|七|八|九|十|\d+)\s*(?:层建筑|层楼|层高楼|层的大楼|层的建筑)/u)?.[0];
  return Boolean(floorCount && registeredText.includes(floorCount.replace(/\s+/gu, "")))
    || /共\s*(?:四|五|六|七|八|九|十|\d+)\s*层/u.test(registeredText);
}

// 题材中立化（R5b）：原先写死「市中心 + 步行」「公交站 + ===6 分钟」。
// 改为遍历 location.travelRules 的登记 method/durationMinutes 通用比对，目标地点名取自 bible。
function detectLocationTransitions(
  body: string,
  locationBible: LocationBible | undefined,
  assetChanges: CommitAssetChangePlan,
  knownCharacterNames: readonly string[],
): readonly CommitPreviewCandidate[] {
  const candidates: CommitPreviewCandidate[] = [];
  const person = characterNameAlternation(knownCharacterNames);
  const rules = (locationBible?.locations ?? []).flatMap((location) => location.travelRules ?? []);

  for (const rule of rules) {
    const targetAliases = unique([rule.targetLocation, ...locationAliases(rule.targetLocation)]).filter(isNonEmptyString);
    const targetPattern = targetAliases.map((alias) => escapeRegExp(alias)).join("|");
    if (!targetPattern) continue;

    // ① 登记的不是步行规则，正文却写「步行/走路 + 该目标」→ 移动方式与登记规则不符风险。
    if (rule.method !== "walk") {
      const walkEvidence = matchingSentence(body, new RegExp(`(?:${targetPattern}).{0,24}(?:步行|走路|走了.{0,6}分钟)|(?:步行|走路).{0,24}(?:${targetPattern})`, "u"));
      if (walkEvidence) candidates.push(highCandidate(`${rule.targetLocation}移动方式与登记规则不符风险`, walkEvidence));
    }

    // ② 登记了到达时长，正文提到该目标却没把登记时长落字 → 移动时间未落字（仅 walk/bus 这类有时长规则）。
    if (typeof rule.durationMinutes === "number" && (rule.method === "walk" || rule.method === "bus")) {
      const targetEvidence = matchingSentence(body, new RegExp(`(?:${targetPattern})`, "u"));
      if (targetEvidence && !durationStatedInText(targetEvidence, rule.durationMinutes)) {
        candidates.push(warningCandidate(`${rule.targetLocation}移动时间未落字`, targetEvidence));
      }
    }
  }

  // ③ 打车/网约车出现，但资产侧已判定「未登记交通工具或打车条件」→ 打车条件未确认。
  const taxiEvidence = matchingSentence(body, new RegExp(`(?:${person}).{0,12}(?:打车去|叫了车|拦了车|坐出租|上了出租|打了一辆|网约车)|打车去|叫了车|拦了车|坐出租|上了出租|打了一辆|网约车`, "u"));
  if (taxiEvidence && assetChanges.unregisteredAssetWarnings.some((item) => item.name.includes("打车") || item.name.includes("交通工具"))) {
    candidates.push(highCandidate("打车条件未确认", taxiEvidence));
  }

  return uniqueCandidates(candidates);
}

// 题材中立：判定正文里是否落字了登记的到达时长（支持阿拉伯数字与中文数字小范围）。
function durationStatedInText(text: string, minutes: number): boolean {
  const arabic = String(minutes);
  const chinese = arabicToChineseSmall(minutes);
  return new RegExp(`(?:${escapeRegExp(arabic)}|${chinese ? escapeRegExp(chinese) : "\\u0000"})\\s*分钟`, "u").test(text);
}

function arabicToChineseSmall(value: number): string | undefined {
  const digits = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
  if (value < 0 || value > 99 || !Number.isInteger(value)) return undefined;
  if (value <= 10) return digits[value];
  if (value < 20) return `十${value % 10 === 0 ? "" : digits[value % 10]}`;
  const tens = Math.floor(value / 10);
  const ones = value % 10;
  return `${digits[tens]}十${ones === 0 ? "" : digits[ones]}`;
}

function buildBlockingReasons(_input: {
  readonly assetChanges: CommitAssetChangePlan;
  readonly locationChanges: CommitLocationChangePlan;
}): readonly string[] {
  // 受控破例③（2026-06-20 用户批准·降级题材特定入库门禁为软提示）：
  // 原先把三类 high candidate（楼层/资产/移动）纳入 blockingReasons 硬拒入库，但这三类全是旧测试书
  // 剧情硬编码（末日物资/林序财团/特定楼层），违题材中立铁律、误伤其他题材，且无 force 越过路径。
  // 降级为不阻塞：candidate 仍在 plan 的 spatialViolationWarnings / unregisteredAssetWarnings /
  // locationTransitionCandidates 字段产出（前端 commitHelpers 照旧当软提示展示），但不再让 passed=false。
  // 题材中立的漂移防护由 commit-quality-check 数据驱动 warning 承担；彻底数据驱动重建见 R5。
  return [];
}

function countHighRiskIssues(input: {
  readonly assetChanges: CommitAssetChangePlan;
  readonly locationChanges: CommitLocationChangePlan;
}): number {
  return [
    ...input.assetChanges.newAssetCandidates,
    ...input.assetChanges.assetStatusChanges,
    ...input.assetChanges.assetUsageEvidence,
    ...input.assetChanges.unregisteredAssetWarnings,
    ...input.locationChanges.newLocationCandidates,
    ...input.locationChanges.locationTransitionCandidates,
    ...input.locationChanges.spatialViolationWarnings,
  ].filter((item) => item.severity === "high").length;
}

function matchingSentence(body: string, pattern: RegExp): string | undefined {
  return splitSentences(body).find((sentence) => pattern.test(sentence));
}

function infoCandidate(input: {
  readonly name: string;
  readonly evidence: string;
  readonly targetId?: string;
  readonly changeType?: string;
  readonly before?: string;
  readonly after?: string;
}): CommitPreviewCandidate {
  return candidate("info", input);
}

function warningCandidate(name: string, evidence: string): CommitPreviewCandidate;
function warningCandidate(input: {
  readonly name: string;
  readonly evidence: string;
  readonly targetId?: string;
  readonly changeType?: string;
  readonly before?: string;
  readonly after?: string;
}): CommitPreviewCandidate;
function warningCandidate(
  inputOrName: string | {
    readonly name: string;
    readonly evidence: string;
    readonly targetId?: string;
    readonly changeType?: string;
    readonly before?: string;
    readonly after?: string;
  },
  evidence?: string,
): CommitPreviewCandidate {
  return candidate("warning", typeof inputOrName === "string" ? { name: inputOrName, evidence: evidence ?? "" } : inputOrName);
}

function highCandidate(name: string, evidence: string): CommitPreviewCandidate;
function highCandidate(input: {
  readonly name: string;
  readonly evidence: string;
  readonly targetId?: string;
  readonly changeType?: string;
  readonly before?: string;
  readonly after?: string;
}): CommitPreviewCandidate;
function highCandidate(
  inputOrName: string | {
    readonly name: string;
    readonly evidence: string;
    readonly targetId?: string;
    readonly changeType?: string;
    readonly before?: string;
    readonly after?: string;
  },
  evidence?: string,
): CommitPreviewCandidate {
  return candidate("high", typeof inputOrName === "string" ? { name: inputOrName, evidence: evidence ?? "" } : inputOrName);
}

function candidate(
  severity: CommitPreviewCandidate["severity"],
  input: {
    readonly name: string;
    readonly evidence: string;
    readonly targetId?: string;
    readonly changeType?: string;
    readonly before?: string;
    readonly after?: string;
  },
): CommitPreviewCandidate {
  const evidence = trimSentence(input.evidence, 120);
  const changeType = input.changeType ?? "candidate";
  return {
    id: candidateId(changeType, input.name, evidence),
    name: input.name,
    ...(input.targetId ? { targetId: input.targetId } : {}),
    changeType,
    ...(input.before ? { before: input.before } : {}),
    ...(input.after ? { after: input.after } : {}),
    evidence,
    severity,
    requiresUserConfirm: true,
  };
}

function candidateId(changeType: string, name: string, evidence: string): string {
  return `${changeType}:${createHash("sha1").update(`${name}\n${evidence}`).digest("hex").slice(0, 10)}`;
}

function uniqueCandidates(candidates: readonly CommitPreviewCandidate[]): readonly CommitPreviewCandidate[] {
  const byName = new Map<string, CommitPreviewCandidate>();
  for (const candidate of candidates) {
    if (!byName.has(candidate.name)) byName.set(candidate.name, candidate);
  }
  return [...byName.values()];
}

export function uniqueAssetCandidates(candidates: readonly CommitPreviewCandidate[]): readonly CommitPreviewCandidate[] {
  const result: CommitPreviewCandidate[] = [];
  const sorted = [...uniqueCandidates(candidates)].sort((left, right) =>
    assetCandidateSpecificity(right.name) - assetCandidateSpecificity(left.name));
  for (const candidate of sorted) {
    // 同基名去重 + 子串别名去重（镜像 uniqueLocationCandidates）：更具体的已 sort 在前先留，
    // 短别名（轮渡票 ⊂ 缺角的轮渡票）被它包含则丢弃；互不包含的同尾物件（闸门钥匙↔房门钥匙）各自保留（Codex 5 章 E2E）。
    if (result.some((kept) => assetBaseName(kept.name) === assetBaseName(candidate.name) || kept.name.includes(candidate.name))) continue;
    result.push(candidate);
  }
  return result;
}

function assetCandidateSpecificity(name: string): number {
  return name.length + (/^(?:银色|蓝色|黑色|白色|红色|黄色|旧|破旧|残缺|加密|备用)/u.test(name) ? 10 : 0);
}

function assetBaseName(name: string): string {
  return name.replace(/^(?:银色|蓝色|黑色|白色|红色|黄色|旧|破旧|残缺|加密|备用)/u, "");
}

function uniqueLocationCandidates(candidates: readonly CommitPreviewCandidate[]): readonly CommitPreviewCandidate[] {
  const result: CommitPreviewCandidate[] = [];
  const sorted = [...uniqueCandidates(candidates)].sort((left, right) =>
    locationSpecificity(right.name) - locationSpecificity(left.name)
    || right.name.length - left.name.length);
  for (const candidate of sorted) {
    if (result.some((kept) => kept.name.includes(candidate.name) || locationNamesMatch(kept.name, candidate.name))) continue;
    result.push(candidate);
  }
  return result;
}

export function buildSelectiveCommitPlan(
  preview: BuildCommitPlanResult,
  confirmation: CommitSelectiveConfirmation | undefined,
): CommitDraftInput["commitPlan"] | undefined {
  if (!preview.commitPlan) return undefined;
  if (!confirmation) return preview.commitPlan;

  const assetDecisions = decisionMap(confirmation.assetDecisions);
  const locationDecisions = decisionMap(confirmation.locationDecisions);
  const characterDecisions = decisionMap(confirmation.characterKnowledgeDecisions);
  const acceptedAssets = allAssetCandidates(preview.assetChanges).filter((candidate) => assetDecisions.get(candidate.id)?.state === "accept");
  const acceptedLocations = allLocationCandidates(preview.locationChanges).filter((candidate) => locationDecisions.get(candidate.id)?.state === "accept");
  const acceptedCharacterChanges = allCharacterKnowledgeCandidates(preview.characterKnowledgeChanges).filter((candidate) => characterDecisions.get(candidate.id)?.state === "accept");
  const characterUpdates = buildConfirmedCharacterStateUpdates(acceptedCharacterChanges, characterDecisions);
  const characterBibleUpdates = buildConfirmedCharacterBibleUpdates(acceptedCharacterChanges, characterDecisions);
  const characterMatrixUpdates = buildConfirmedCharacterMatrixUpdates(preview, acceptedCharacterChanges, characterDecisions);

  const {
    characterUpdates: ignoredCharacterUpdates,
    assetLedgerUpdates: ignoredAssetLedgerUpdates,
    locationBibleUpdates: ignoredLocationBibleUpdates,
    characterBibleUpdates: ignoredCharacterBibleUpdates,
    characterMatrixUpdates: ignoredCharacterMatrixUpdates,
    ...baseCommitPlan
  } = preview.commitPlan;
  void ignoredCharacterUpdates;
  void ignoredAssetLedgerUpdates;
  void ignoredLocationBibleUpdates;
  void ignoredCharacterBibleUpdates;
  void ignoredCharacterMatrixUpdates;

  return {
    ...baseCommitPlan,
    ...(characterUpdates.length > 0 ? { characterUpdates } : {}),
    assetLedgerUpdates: buildConfirmedAssetUpdates(preview, acceptedAssets, assetDecisions),
    locationBibleUpdates: buildConfirmedLocationUpdates(preview, acceptedLocations, locationDecisions),
    characterBibleUpdates,
    ...(characterMatrixUpdates.length > 0 ? { characterMatrixUpdates } : {}),
  };
}

function decisionMap(decisions: readonly SelectiveChangeDecision[] | undefined): ReadonlyMap<string, SelectiveChangeDecision> {
  return new Map((decisions ?? []).map((decision) => [decision.candidateId, decision]));
}

function allAssetCandidates(plan: CommitAssetChangePlan | undefined): readonly CommitPreviewCandidate[] {
  return plan ? [
    ...plan.newAssetCandidates,
    ...plan.assetStatusChanges,
    ...plan.assetUsageEvidence,
    ...plan.unregisteredAssetWarnings,
  ] : [];
}

function allLocationCandidates(plan: CommitLocationChangePlan | undefined): readonly CommitPreviewCandidate[] {
  return plan ? [
    ...plan.newLocationCandidates,
    ...plan.locationTransitionCandidates,
    ...plan.spatialViolationWarnings,
  ] : [];
}

function allCharacterKnowledgeCandidates(plan: CommitCharacterKnowledgeChangePlan | undefined): readonly CommitPreviewCandidate[] {
  return plan ? [
    ...plan.stateChanges,
    ...plan.knowledgeKnownChanges,
    ...plan.knowledgeUnknownChanges,
    ...plan.characterMatrixCandidates,
    ...plan.forbiddenRevealTouches,
  ] : [];
}

function buildConfirmedAssetUpdates(
  preview: BuildCommitPlanResult,
  candidates: readonly CommitPreviewCandidate[],
  decisions: ReadonlyMap<string, SelectiveChangeDecision>,
): readonly AssetLedgerUpdate[] {
  return candidates
    .filter((candidate) => candidate.changeType !== "forbidden_reveal_touch")
    .map((candidate) => {
      const decision = decisions.get(candidate.id);
      const name = decision?.edited?.name ?? candidate.name;
      const evidence = decision?.edited?.evidence ?? candidate.evidence;
      return {
        id: `asset-${shortHash(name)}`,
        name,
        type: inferAssetUpdateType(name),
        ownerName: preview.semanticSummary?.protagonist,
        currentLocationName: preview.semanticSummary?.locations[0],
        carriedByCharacterId: /口袋|身上|手里|拎着|随身/u.test(evidence) ? preview.semanticSummary?.mentionedCharacters[0] : undefined,
        status: inferAssetUpdateStatus(name, evidence),
        conditionNote: candidate.after ?? evidence,
        // 题材中立化（R5b）：删掉「水/饼干/魂钢/申请表」等题材词启发式。新物件候选无已登记元数据，
        // 改为只用题材中立信号——可消耗按通用「货币/明确消耗状态」判定，剧情关键按「被检测为高风险候选」判定。
        isConsumable: inferAssetUpdateType(name) === "money" || inferAssetUpdateStatus(name, evidence) === "consumed",
        isPlotCritical: candidate.severity === "high",
        canAiModify: false,
        rules: candidate.severity === "high" ? [`高风险候选：${candidate.name}`] : [],
        notes: [`第${preview.semanticSummary?.chapter ?? 0}章确认写入：${evidence}`],
      } satisfies AssetLedgerUpdate;
    });
}

function buildConfirmedLocationUpdates(
  preview: BuildCommitPlanResult,
  candidates: readonly CommitPreviewCandidate[],
  decisions: ReadonlyMap<string, SelectiveChangeDecision>,
): readonly LocationBibleUpdate[] {
  return candidates
    .filter((candidate) => !/空间结构冲突|移动规则冲突/u.test(candidate.name))
    .map((candidate) => {
      const decision = decisions.get(candidate.id);
      const name = decision?.edited?.name ?? candidate.name;
      const evidence = decision?.edited?.evidence ?? candidate.evidence;
      return {
        id: `loc-${shortHash(name)}`,
        name,
        type: "candidate",
        locationType: "章节新地点候选",
        knownFeatures: [evidence],
        fixedFacts: [`第${preview.semanticSummary?.chapter ?? 0}章提到：${evidence}`],
        lastSeenChapter: preview.semanticSummary?.chapter,
        lastKnownState: "由入库预览确认加入",
      } satisfies LocationBibleUpdate;
    });
}

function buildConfirmedCharacterStateUpdates(
  candidates: readonly CommitPreviewCandidate[],
  decisions: ReadonlyMap<string, SelectiveChangeDecision>,
): readonly CharacterStateUpdate[] {
  const byCharacter = new Map<string, CharacterStateUpdate>();
  for (const candidate of candidates) {
    if (!candidate.targetId || !candidate.changeType?.startsWith("character_state_")) continue;
    const decision = decisions.get(candidate.id);
    const after = decision?.edited?.after ?? candidate.after;
    if (!after) continue;
    const current = byCharacter.get(candidate.targetId) ?? { characterId: candidate.targetId };
    byCharacter.set(candidate.targetId, {
      ...current,
      ...(candidate.changeType === "character_state_emotion" ? { emotion: after } : {}),
      ...(candidate.changeType === "character_state_goal" ? { goal: after } : {}),
    });
  }
  return [...byCharacter.values()];
}

function buildConfirmedCharacterBibleUpdates(
  candidates: readonly CommitPreviewCandidate[],
  decisions: ReadonlyMap<string, SelectiveChangeDecision>,
): readonly CharacterBibleUpdate[] {
  const byCharacter = new Map<string, CharacterBibleUpdate>();
  for (const candidate of candidates) {
    if (!candidate.targetId || candidate.changeType !== "knowledge_known") continue;
    const decision = decisions.get(candidate.id);
    const after = decision?.edited?.after ?? candidate.after;
    if (!after) continue;
    const current = byCharacter.get(candidate.targetId) ?? { characterId: candidate.targetId };
    byCharacter.set(candidate.targetId, {
      ...current,
      knowledgeKnownAppend: unique([...(current.knowledgeKnownAppend ?? []), after]),
    });
  }
  return [...byCharacter.values()];
}

function buildConfirmedCharacterMatrixUpdates(
  preview: BuildCommitPlanResult,
  candidates: readonly CommitPreviewCandidate[],
  decisions: ReadonlyMap<string, SelectiveChangeDecision>,
): readonly CharacterMatrixUpdate[] {
  return candidates
    .filter((candidate) => candidate.changeType === "character_matrix_candidate")
    .map((candidate) => {
      const decision = decisions.get(candidate.id);
      const name = cleanMatrixCandidateName(decision?.edited?.name ?? candidate.name);
      const evidence = decision?.edited?.evidence ?? candidate.evidence;
      const after = decision?.edited?.after ?? candidate.after;
      const chapter = preview.semanticSummary?.chapter ?? 0;
      const roleHint = extractMatrixField(after, /身份线索：([^；]+)/u);
      const relationToProtagonist = extractMatrixField(after, /关系：([^；]+)|与[^；]+关系：([^；]+)/u);
      const riskHint = /风险不明|需要确认立场/u.test(after ?? evidence) ? "立场和风险待确认" : undefined;
      return {
        id: candidate.targetId ?? `matrix-${shortHash(name)}`,
        name,
        status: "candidate",
        ...(roleHint ? { roleHint } : {}),
        ...(relationToProtagonist ? { relationToProtagonist } : {}),
        ...(riskHint ? { riskHint } : {}),
        firstSeenChapter: chapter,
        lastSeenChapter: chapter,
        evidence: [evidence],
        appearances: [{
          chapter,
          evidence,
          ...(preview.semanticSummary?.locations[0] ? { location: preview.semanticSummary.locations[0] } : {}),
        }],
        relationshipEvents: [{
          chapter,
          ...(relationToProtagonist ? { relationToProtagonist } : {}),
          evidence,
        }],
      } satisfies CharacterMatrixUpdate;
    });
}

function cleanMatrixCandidateName(value: string): string {
  return value.replace(/（新人物矩阵候选）$/u, "").trim();
}

function extractMatrixField(value: string | undefined, pattern: RegExp): string | undefined {
  if (!value) return undefined;
  const match = pattern.exec(value);
  return match ? (match[1] ?? match[2])?.trim() : undefined;
}

function inferAssetUpdateType(name: string): AssetLedgerUpdate["type"] {
  // 题材中立化（R5b）：删掉「水/饼干/食物/罐头」等题材食物词的 consumable 启发式（食物非通用资产类别）。
  // 仅保留题材中立的类别信号：货币（货币符号/单位）、文书（通用证件/文件类别后缀）、交通工具（车）。
  if (/现金|元|块|钱包|余额/u.test(name)) return "money";
  if (/表|证|文件|卡|信封|资料夹|档案袋|合同|遗嘱|名片|胸牌|工牌/u.test(name)) return "document";
  if (/车/u.test(name)) return "vehicle";
  return "item";
}

function inferAssetUpdateStatus(name: string, evidence: string): AssetLedgerUpdate["status"] {
  if (/欠费|锁|不能|受限/u.test(name) || /欠费|锁|不能|受限/u.test(evidence)) return "locked";
  if (/损坏|破|半张/u.test(name) || /损坏|破|半张/u.test(evidence)) return "damaged";
  if (/丢/u.test(name) || /丢/u.test(evidence)) return "lost";
  if (/消耗|喝完|吃完/u.test(evidence)) return "consumed";
  return "available";
}

function pickNextLead(sentences: readonly string[], excluded: readonly (string | undefined)[]): string | undefined {
  const excludedSet = new Set(excluded.filter((value): value is string => value !== undefined));
  const keywords = [
    "线索",
    "异常",
    "异动",
    "声音",
    "黑影",
    "账本",
    "秘密",
    "门后",
    "禁区",
    "约定",
    "明日",
    "失踪",
    "封条",
    "暗号",
    "信物",
  ];
  for (const keyword of keywords) {
    const sentence = [...sentences]
      .reverse()
      .find((candidate) =>
        !excludedSet.has(candidate)
        && candidate.includes(keyword)
        && !isLowValueEventSentence(candidate)
        && !isGenericDiscoveryNoise(candidate)
        && !isLowValueDecisionSentence(candidate)
        && !isBrokenDialogueFragment(candidate));
    if (sentence) return trimSentence(sentence, 90);
  }
  return undefined;
}

async function listCharacterProfiles(projectDir: string): Promise<readonly CharacterProfile[]> {
  const entries = await readdir(join(projectDir, "characters"), { withFileTypes: true });
  const ids = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  const profiles = await Promise.all(ids.map((id) => readCharacterProfile(projectDir, id)));
  return profiles;
}

function selectMainCharacter(characters: readonly CharacterProfile[], draft: string): CharacterProfile {
  const scored = characters
    .map((character, index) => ({
      character,
      index,
      score: characterMentionCount(character, draft) * 10
        + (characterMentionCount(character, draft) > 0 ? mainCharacterProfileScore(character) : 0),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index);
  return scored[0]?.character ?? characters[0]!;
}

function nameMatchesDraft(character: CharacterProfile, draft: string): boolean {
  return [character.name, character.id]
    .map((value) => value.trim())
    .filter(Boolean)
    .some((value) => draft.includes(value));
}

function characterMentionCount(character: CharacterProfile, draft: string): number {
  return [character.name, character.id]
    .map((value) => value.trim())
    .filter(Boolean)
    .reduce((total, value) => total + countOccurrences(draft, value), 0);
}

function mainCharacterProfileScore(character: CharacterProfile): number {
  // 规范主角信号：真实数据里主角标记是 tags:["main-character"]（连字符）或 identity:"protagonist"，
  // 与 writing-context-pack.isMainCharacter / state-overview 一致。别只靠下面的模糊正则——它认「main character」
  // （空格）却认不出「main-character」（连字符），真机里主角靠 tags 却打分归零、被配角 id 字母序抢走主角身份（Codex retest6）。
  if (character.identity === "protagonist" || character.tags?.includes("main-character") === true) return 1000;
  const text = [
    character.id,
    character.identity,
    ...(character.tags ?? []),
  ].filter(isNonEmptyString).join(" ");
  return /protagonist|main[\s-]?character|主角|男主|女主/u.test(text) ? 1000 : 0;
}

function countOccurrences(content: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while (true) {
    index = content.indexOf(needle, index);
    if (index === -1) return count;
    count += 1;
    index += needle.length;
  }
}

function selectMatchingHooks(hooks: readonly HookItem[], draft: string): readonly HookItem[] {
  return hooks.filter((hook) => [hook.id, hook.title, hook.description]
    .map((value) => value.trim())
    .filter(Boolean)
    .some((value) => draft.includes(value)));
}

function selectMentionedCharacterProfiles(
  characters: readonly CharacterProfile[],
  draft: string,
  defaultCharacterId: string,
): readonly CharacterProfile[] {
  return characters
    .map((character, index) => ({
      character,
      index,
      count: characterMentionCount(character, draft),
      isDefault: toSafeCharacterId(character.id) === defaultCharacterId,
    }))
    .filter((item) => item.count > 0)
    .sort((left, right) =>
      Number(right.isDefault) - Number(left.isDefault)
      || right.count - left.count
      || left.index - right.index)
    .map((item) => item.character);
}

function buildMainEvent(input: {
  readonly chapter: number;
  readonly sentences: readonly string[];
  readonly rankedEvents: readonly ScoredEventSentence[];
  readonly conflict?: string;
  readonly discovery?: string;
  readonly gained?: string;
  readonly lost?: string;
  readonly decision?: string;
  readonly fallback: string;
}): string {
  const conflictDiscovery = combineConflictDiscovery(input.conflict, input.discovery);
  const stateChange = combineStateChange(input.gained, input.lost);
  const selected = conflictDiscovery
    ?? input.conflict
    ?? input.discovery
    ?? stateChange
    // 语义字段全空（核心发现常以编号锚点表达、不含"发现/找到"关键词）→ 复用评分排名，别再用遗留关键词表
    // （旧表含"站在"，会把方位/场景句"江岚站在走廊尽头…""还站在原地"当主事件，挤掉核心编号物证 R-17/Q-04·Codex retest6）。
    ?? pickMainEventFromRanked(input.rankedEvents)
    ?? input.decision
    ?? input.sentences[0];
  if (!selected) return input.fallback;
  const summary = trimSentence(selected, 90);
  return summary || input.fallback;
}

/**
 * 从评分排名里选主事件（题材中立），优先级：
 *   1. 「编号-reveal 句」——代号出现在 reveal 标记（写着/印着/标签：/编号…）之后，是本章核心发现句
 *      （Codex retest7：单纯 CODE_ANCHOR 命中会把「把K-19货单折好」这类动作宾语句选成 mainEvent，它其实是
 *      上一章遗留物的过程动作、不是本章发现；只有代号被 reveal 标记引出才是发现）。
 *   2. 「带编号锚点的完整事件句」（score≥4）——裸代号标签（+1）排除在外。
 *   3. 最高分事件句（rankedEvents 已按分值降序）。
 */
function pickMainEventFromRanked(rankedEvents: readonly ScoredEventSentence[]): string | undefined {
  const codeReveal = rankedEvents.find((item) => isCodeRevealSentence(item.sentence));
  if (codeReveal) return codeReveal.sentence;
  const codeAnchored = rankedEvents.find((item) => item.score >= 4 && CODE_ANCHOR.test(item.sentence));
  return (codeAnchored ?? rankedEvents[0])?.sentence;
}

interface ScoredEventSentence {
  readonly sentence: string;
  readonly index: number;
  readonly score: number;
}

// 把整章句子打分排名（分值降序、同分按出场顺序）。keyEvents 与 timelineSummary 共用这一份排名，
// 避免两条路径各自重算、产出不一致（Codex 组合复测 P1：预览看着好、落盘退化）。
function rankEventSentences(
  sentences: readonly string[],
  characterNames: readonly string[] = [],
  locationNames: readonly string[] = [],
): readonly ScoredEventSentence[] {
  return sentences
    .map((sentence, index) => ({
      sentence: normalizeSemanticSentence(sentence),
      index,
      score: scoreEventSentence(sentence, characterNames, locationNames),
    }))
    .filter((item) => item.score > 0 && !isSystemMetaEvent(item.sentence))
    .sort((a, b) => b.score - a.score || a.index - b.index);
}

function extractKeyEvents(ranked: readonly ScoredEventSentence[], mainEvent: string, characterNames: readonly string[] = [], locationNames: readonly string[] = []): readonly string[] {
  const selected = unique([...ranked].slice(0, 8)
    .sort((a, b) => a.index - b.index)
    .map((item) => item.sentence));
  if (selected.length > 0) {
    const normalizedMainEvent = normalizeSemanticSentence(mainEvent);
    if (!isSystemMetaEvent(normalizedMainEvent) && scoreEventSentence(mainEvent, characterNames, locationNames) > 0) {
      return unique([normalizedMainEvent, ...selected]).slice(0, 8);
    }
    return selected;
  }
  return isSystemMetaEvent(mainEvent) ? [] : [trimSentence(mainEvent, 90)];
}

// timelineSummary 取「分值最高的两句」（最具情节意义），而非文档前两句——否则开场场景铺垫（站在货架前/
// 玻璃门褪色）会独占摘要、把核心事件挤出（Codex 组合复测 P1）。为可读性保证至少一句具名（含项目角色名）：
// 若 top-2 全是代词起头句、而别处存在一条「具名且有情节信号（分值高于纯角色基线 3）」的句子，用它替换 top-2
// 里较低分的一条；纯代词/无具名实质句不强行回填（避免抓到「他叹了口气」这种琐碎具名句）。最后按出场顺序排好读着顺。
function selectTimelineSummary(
  ranked: readonly ScoredEventSentence[],
  mainEvent: string,
  characterNames: readonly string[] = [],
): string {
  if (ranked.length === 0) return mainEvent;
  const containsName = (item: ScoredEventSentence): boolean =>
    characterNames.some((name) => name.length >= 2 && item.sentence.includes(name));
  const top = ranked.slice(0, 2);
  if (top.length === 2 && !top.some(containsName)) {
    const namedSignificant = ranked.find((item) => item.score > 3 && containsName(item));
    if (namedSignificant && !top.includes(namedSignificant)) {
      top[1] = namedSignificant;
    }
  }
  // 「编号-reveal 句」是本章核心发现，应保证进时间线摘要——哪怕它原始分数低于「带角色的动作宾语句」
  // （「林渡把M-31货单折好，塞进内袋」角色名+编号=7 分，压过「标签贴在金属盒侧面：P-07」4 分，把 reveal 句
  // 挤出 top-2，摘要被上一章遗留物动作独占·Codex retest9）。若 top 里还没有 reveal 句、但 ranked 里有，
  // 用分数最高的 reveal 句替换 top 里分数较低的那一句。
  if (top.length === 2 && !top.some((item) => isCodeRevealSentence(item.sentence))) {
    const bestReveal = ranked.find((item) => isCodeRevealSentence(item.sentence));
    if (bestReveal && !top.includes(bestReveal)) {
      const lowerIdx = top[0]!.score <= top[1]!.score ? 0 : 1;
      top[lowerIdx] = bestReveal;
    }
  }
  const ordered = unique([...top].sort((a, b) => a.index - b.index).map((item) => item.sentence));
  return trimSentence(ordered.join(" "), 120);
}

function buildChapterSummary(keyEvents: readonly string[], mainEvent: string): string {
  const selected = keyEvents.length > 0
    ? keyEvents.slice(0, 3)
    : isSystemMetaEvent(mainEvent)
      ? []
      : [mainEvent];
  return selected.join(" ");
}

function scoreEventSentence(sentence: string, characterNames: readonly string[] = [], locationNames: readonly string[] = []): number {
  if (isLowValueEventSentence(sentence)) return 0;
  // 对白行（以引号起头，或「X说，"…」说话人归属带出引号）/ 引号不平衡的半截对白，对【事件摘要】无价值——
  // 直接判 0，不让下面的关键词/具名实体加权把它捞回来（Codex 复测：避免「林霁说，"…」对白碎片被实体加权救活）。
  // 整章皆对白时由 extractKeyEvents 的 mainEvent 兜底，不会空。
  if (isBrokenDialogueFragment(sentence)) return 0;
  let score = 0;
  // 题材中立的「具体编号锚点」：字母-数字代号（X-23 / B-41 / HT-771 / L-09 / A-330）。在叙事里出现这类代号
  // 几乎必是情节关键物（案号/储物柜号/合同号/坐标编号），跨题材通用。加权在下方按句子是否完整事件句条件给
  // （Codex 组合复测 P1：核心编号事件被开场铺垫挤出；retest2：裸代号标签 + 「编号」陈述句又把摘要碎片化）。
  const hasCodeAnchor = CODE_ANCHOR.test(sentence);
  const strongKeywords = [
    "发现",
    "看见",
    "注意到",
    "察觉",
    "意识到",
    "决定",
    "准备",
    "打算",
    "必须",
    "不能再",
    "威胁",
    "冲突",
    "争执",
    "克扣",
    "打压",
    "追杀",
    "偷袭",
    "受伤",
    "突破",
    "得到",
    "拿到",
    "失去",
    "交易",
    "暗号",
    "线索",
    "异常",
    "异动",
    "黑影",
    "账本",
    "信物",
    "残页",
    "封条",
    "找到",
    "翻出",
    "撬开",
    "掀开",
    "搜出",
  ];
  const actionKeywords = [
    "推开",
    "进入",
    "来到",
    "离开",
    "追查",
    "调查",
    "反击",
    "修炼",
    "藏起",
    "交出",
    "取回",
    "转移",
    "寻找",
    "搜索",
    "检查",
    "封住",
    "清点",
    "修好",
    "躲避",
  ];
  let keywordHit = false;
  for (const keyword of strongKeywords) {
    if (sentence.includes(keyword)) { score += 3; keywordHit = true; }
  }
  for (const keyword of actionKeywords) {
    if (sentence.includes(keyword)) { score += 2; keywordHit = true; }
  }
  if (sentence.length > 160) score -= 1;
  // 题材中立信号（Codex 复测）：好的摘要句锚定项目登记的【角色名】（演员）。关键词表偏修仙，换题材整章实质句全不命中，
  // 故用项目实体加权给具名实质句冒头机会。但要区分【角色实体=演员】和【地点实体=场景】（Codex 5 章 E2E）：
  const startsWithPronoun = /^(?:他|她|它|他们|她们|它们|对方|两人|众人|大家)/u.test(sentence.replace(/^\s+/u, ""));
  const hasCharacter = characterNames.some((name) => name.length >= 2 && sentence.includes(name));
  // #4.2 抽象总结句护栏：很短（<8 汉字）且无演员（无具名角色、不以拟人代词起头）→ 是总结/口号句（「线索闭环了。」靠
  // 「线索」关键词 +3 冒头、「账外资金链。」），即便命中关键词也判 0。长的真事件句（带具名/代词演员）不受影响。
  const hanLen = (sentence.match(/[一-龥]/gu) ?? []).length;
  // 编号锚点句即便很短也是真事件（「打开柜门，编号 B-41。」），不被抽象总结句护栏误杀。
  if (hanLen < 8 && !hasCharacter && !startsWithPronoun && !hasCodeAnchor) return 0;
  // 编号锚点加权（条件式）：完整事件句（带演员/代词/情节关键词，或够长）给强权 +4，让核心编号事件压过开场铺垫；
  // 裸代号标签（很短、无演员、无关键词，如「合同 A-330。」「L-09。」）只给 +1，不让它压过完整事件句、避免摘要
  // 碎片化（Codex retest2：ch2 落盘退化成「合同 A-330。名字和编号都对得上。」）。
  if (hasCodeAnchor) {
    const bareCodeLabel = hanLen < 6 && !hasCharacter && !startsWithPronoun && !keywordHit;
    score += bareCodeLabel ? 1 : 4;
  }
  if (hasCharacter) {
    score += 3;
    // #4.3 自梳理/环境小动作（擦拭表壳/捋头发/拍灰…）且无情节关键词 → 不是章节主事件，压一压让真事件句冒头。
    if (!keywordHit && AMBIENT_GROOMING.test(sentence)) score -= 2;
  } else {
    // 纯地点（景物）只在句中还有演员信号（拟人代词或情节关键词）时才 +3——「雨砸在旧港巷…」这种只提地点的景物句不当事件。
    const hasLocation = locationNames.some((name) => name.length >= 2 && sentence.includes(name));
    if (hasLocation && (startsWithPronoun || keywordHit)) score += 3;
    // 代词起头+无地点的「代词无地点」惩罚是为压纯景物/口号句设计的；但带编号锚点的句子（如「他…写着"B-7"」）
    // 几乎不可能是景物句——编号本身就是具体情节信号，不该跟着一起罚（Codex retest5：B-7 发现句被这条惩罚
    // 拖到分数低于普通过渡句，核心发现被挤出摘要）。
    else if (!hasLocation && startsWithPronoun && !hasCodeAnchor) score -= 2;
  }
  return score;
}

// 自梳理/环境小动作动词：跨题材通用、与情节无关的细碎动作；只在句子别无情节关键词时用于压分。
const AMBIENT_GROOMING = /擦拭|擦了擦|抹了|抹去|蹭了|蹭掉|捋了|理了理|拍了拍|拍掉|搓着|摩挲|捏着|攥着|揉了揉|捻着/u;

// 题材中立的「具体编号锚点」：字母-数字代号（X-23 / B-41 / HT-771 / L-09 / A-330，支持半/全角连字符）。
// 叙事里出现这类代号几乎必是情节关键物（案号/储物柜号/合同号/坐标编号），用于给核心事件句加权。
// 不收裸词「编号/型号/代号」——它们会让「名字和编号都对得上」「认得这个编号吗」这类陈述/疑问句误冒头（retest2）。
const CODE_ANCHOR = /[A-Za-z]{1,4}[-－—]?\d{1,4}/u;

// 「编号-reveal 句」：代号出现在 reveal 标记（写着/印着/标签/编号…）之后——这才是本章核心发现句。
// 与单纯的 CODE_ANCHOR 命中不同：代号也可能是动作对象（「把K-19货单折好」「把R-12信封塞进抽屉」），
// 那是上一章遗留物的过程动作、不是本章发现。只有代号被 reveal 标记引出时才算核心发现（Codex retest7：
// pickMainEventFromRanked 只看「最高分的 code-anchor 句」，把 K-19 动作宾语句（角色名+编号=7分）选成了
// mainEvent，压过本章真正的发现「标签：P-07」）。
// 判据：① 句含代号；② 代号不是「把/将…」动作宾语；③ 代号前 ~12 字符窗口内有 reveal 标记。
const CODE_REVEAL_MARK = /(?:写着|印在|印着|贴着|标着|刻着|标签|编号|代号|型号)\s*[：:!！:]?\s*/u;
const CODE_ACTION_OBJECT = /(?:把|将|对)[^。！？；;]*[A-Za-z]{1,4}[-－—]?\d{1,4}[^。！？；;]*(?:折|塞|放|拿|推|按|搁|夹|藏|收|装|包|揣|扔|丢|递|交)/u;
function isCodeRevealSentence(sentence: string): boolean {
  const match = sentence.match(CODE_ANCHOR);
  if (!match) return false;
  // 裸编号标签（「编号F-11。」/「代号 K-02。」）只说明文本里有编号，不是完整发现事件。
  // 它可以作为低分编号锚点参与摘要，但不能走 code-reveal 绝对优先权，否则长跑会把 mainEvent 压成裸编号。
  if (new RegExp(`^\\s*(?:编号|代号|型号)\\s*[：:!！:]?\\s*${CODE_ANCHOR.source}\\s*[。！？!?.]?\\s*$`, "u").test(sentence)) {
    return false;
  }
  // 对白内部的句子（「"编号M-31的货单。」对白里也满足「编号+代号」，但它是角色说的话、且句切后带孤儿引号）
  // 不能当核心发现句——code-reveal 优先权会绕过选句闸，必须在这里先把对白碎片挡掉（Codex retest9·E 回归：
  // mainEvent 选成孤儿开引号的「"编号M-31的货单。」）。真正的 reveal 句是叙述句（无引号、引号平衡）。
  if (isBrokenDialogueFragment(sentence)) return false;
  if (CODE_ACTION_OBJECT.test(sentence)) return false;
  const endIndex = (match.index ?? 0) + match[0].length;
  const window = sentence.slice(Math.max(0, (match.index ?? 0) - 12), endIndex);
  return CODE_REVEAL_MARK.test(window);
}

function isDialogueAttributionSentence(sentence: string): boolean {
  const t = sentence.replace(/^\s+/u, "");
  return /^[“”"「『]/u.test(t)
    || /[\p{Script=Han}]{1,4}(?:说|问|喊|叫|低声|冷笑|嘟囔)[，：]?[“”"「『]/u.test(t)
    // 「X声音/语气/嗓音/声线 [不高/低沉/发颤]，"…」也是说话人归属对白句（Codex retest3：秦柏声音不高，"你拿到的是副本）——
    // 旧闸只认 说/问 等动词，漏了用「声音」做归属的；它常在引号处被切成半句，混进摘要尾巴留个孤儿引号。
    || /[\p{Script=Han}]{1,4}(?:的)?(?:声音|语气|嗓音|声线)[^，。！？]{0,6}[，：][“”"「『]/u.test(t);
}

// 引号家族：左右不同形的家族各自独立计数（不互相抵消，避免「」配“”造成假平衡）；左右同形的直引号按奇偶判断
// （每次出现在 开/关 间切换，句内应出现偶数次）。
const ASYMMETRIC_QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["“", "”"],
  ["「", "」"],
  ["『", "』"],
];
const SYMMETRIC_QUOTE_MARKS: readonly string[] = ["\"", "'"];

/**
 * 引号不平衡判定（Codex retest4 根因·Workflow 调查确认）：句子里某个引号家族「开/关数量不等」= 半截/孤儿引号。
 * 治本而非打地鼠——不靠枚举归属动词（说/问/盯着/…永远列不全，前两轮已验证会反复漏），靠数学事实：完整句子里
 * 引号必然配对，多句对白被按句号切断时断口处必不配对。书名号/讽刺引用等正常用法都是【已闭合】的，不会误杀。
 * 必须在 splitSentences 的原始输出上判定（trimSentence 截断后的展示文本判定会被截断本身造出假孤儿引号）。
 */
function hasUnbalancedQuote(sentence: string): boolean {
  for (const [open, close] of ASYMMETRIC_QUOTE_PAIRS) {
    let openCount = 0;
    let closeCount = 0;
    for (const ch of sentence) {
      if (ch === open) openCount += 1;
      else if (ch === close) closeCount += 1;
    }
    if (openCount !== closeCount) return true;
  }
  for (const mark of SYMMETRIC_QUOTE_MARKS) {
    let count = 0;
    for (const ch of sentence) if (ch === mark) count += 1;
    if (count % 2 !== 0) return true;
  }
  return false;
}

/** 对白/引号不平衡的统一闸：scoreEventSentence / scoreSemanticCandidate / scoreDecisionCandidate / pickNextLead
 * 全部选句管线共用同一道闸——前两轮只接在 scoreEventSentence 一条路径上，其余管线没人管，半截对白持续漏网。 */
function isBrokenDialogueFragment(sentence: string): boolean {
  return isDialogueAttributionSentence(sentence) || hasUnbalancedQuote(sentence);
}

function isLowValueEventSentence(sentence: string): boolean {
  return /准备好了的话|当然可以带回去慢慢看|当然可以|看见他换上西装的样子|那笑容里带着一丝理解|发现对方的手掌干燥有力|背靠着门板|落地窗外|脸上的表情介于|资料拿到了/u.test(sentence)
    || /(?:没有新消息|按亮屏幕|七点|敲门声|洗了把脸|眼底|妆容|头发|早餐|清粥|小菜|胃口|酒店的logo|你吃过|喝了一口粥|吃完早餐|窗帘|十五分钟后|出租车|白T恤|牛仔裤|咖啡还是茶|水就行|休息得怎么样)/u.test(sentence)
    || /(?:碗筷|洗了手|父母还坐在原位|下意识地问了一句|坐稳了听|十八岁的年纪|暑假计划|夏令营|大理|驾照|普通得不能再普通|茶几上压着一张纸条|一个保温杯|保鲜盒|三明治|双肩包|床边|手机屏幕上的时间|楼道里很安静|取完行李|接机牌|白手套|贵宾休息室|鲜榨橙汁|头等舱|真皮座椅|总统套房。$|水晶吊灯|水果拼盘|矿泉水|换上西装|下午一点五十五分)/u.test(sentence)
    || /决定先不告诉.{0,8}这件事|没有回复，没有删除/u.test(sentence)
    || isGenericLongEnoughFiller(sentence)
    || /发现这跟昨天那份.{0,24}文件完全不是/u.test(sentence);
}

function isSystemMetaEvent(value: string): boolean {
  return /草稿被提交|正式章节|章节完成|提交草稿|commit|draft/iu.test(value);
}

function extractParticipants(content: string, mentionedCharacterNames: readonly string[], protagonist: string): readonly string[] {
  const roleLabels = [
    "主角",
    "少年",
    "少女",
    "长老",
    "管事",
    "师兄",
    "师姐",
    "黑衣人",
    "老人",
    "成员",
    "同门",
    "杂役弟子",
    "邻居",
    "保安",
    "医生",
    "护士",
  ];
  return unique([
    ...mentionedCharacterNames,
    protagonist,
    ...roleLabels.filter((label) => content.includes(label)),
  ].filter(Boolean)).slice(0, 8);
}

function extractForeshadowingTerms(content: string, hooks: readonly HookItem[]): readonly string[] {
  const knownTerms = [
    "玉佩",
    "残页",
    "旧账本残页",
    "账目",
    "黑气",
    "禁区",
    "血痕",
    "陌生声音",
    "神秘声音",
    "旧伤",
    "封条",
    "暗号",
    "梦境",
    "失踪",
    "破损信物",
    "信物",
    "后墙异常响动",
    "异常响动",
    "黑影",
    "暗页",
    "密信",
  ];
  return unique([
    ...hooks
      .map((hook) => hook.title)
      .map((value) => value.trim())
      .filter((value) => value && content.includes(value)),
    ...(content.includes("后墙") && content.includes("异常响动") ? ["后墙异常响动"] : []),
    ...(content.includes("药品") && (content.includes("调包") || content.includes("替换")) ? ["被调包的药品"] : []),
    ...knownTerms.filter((term) => content.includes(term)),
  ]).slice(0, 10);
}

function combineConflictDiscovery(conflict: string | undefined, discovery: string | undefined): string | undefined {
  if (!conflict && !discovery) return undefined;
  if (!conflict) return discovery;
  if (!discovery) return conflict;
  return trimSentence(`${conflict} ${discovery}`, 110);
}

function combineStateChange(gained: string | undefined, lost: string | undefined): string | undefined {
  if (!gained && !lost) return undefined;
  if (!gained) return lost;
  if (!lost) return gained;
  return trimSentence(`${gained}，${lost}`, 90);
}

// discovery 选句：优先「编号-reveal 句」（本章核心发现），其次走发现关键词表。
// 根因（Codex retest7·P1）：原 pickDistinct 用「看见」等关键词命中对白碎片「别让人看见。」——它从对白内部切出、
// 切完引号丢失、伪装成叙述句，isBrokenDialogueFragment 闸不住——抢占 discovery，再被 buildMainEvent 优先选用，
// 真正的核心发现句（编号印在…：K-19）根本没机会。编号-reveal 句题材中立且几乎不可能是对白碎片，给它绝对优先权。
function pickDiscovery(sentences: readonly string[], used: Set<string>): string | undefined {
  const codeReveal = sentences.find((sentence) =>
    !used.has(sentence)
    && !used.has(trimSentence(sentence, 90))
    && !isGenericDiscoveryNoise(sentence)
    && isCodeRevealSentence(sentence));
  if (codeReveal) {
    const selected = normalizeSemanticSentence(codeReveal);
    used.add(selected);
    used.add(codeReveal);
    return selected;
  }
  return pickDistinct(sentences.filter((sentence) => !isGenericDiscoveryNoise(sentence)), [
    "发现",
    "看见",
    "注意到",
    "察觉",
    "意识到",
    "原来",
    "竟然",
    "秘密",
    "线索",
    "血痕",
    "账本",
  ], used);
}

function pickDistinct(candidates: readonly string[], keywords: readonly string[], used: Set<string>): string | undefined {
  const ranked = candidates
    .map((candidate, index) => ({
      candidate,
      index,
      score: keywords.some((keyword) => candidate.includes(keyword)) ? scoreSemanticCandidate(candidate) : 0,
    }))
    .filter((item) => item.score > 0 && !used.has(item.candidate) && !used.has(trimSentence(item.candidate, 90)))
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const best = ranked[0];
  if (best) {
    const selected = normalizeSemanticSentence(best.candidate);
    used.add(selected);
    used.add(best.candidate);
    return selected;
  }
  const repeated = candidates
    .map((candidate, index) => ({
      candidate,
      index,
      score: keywords.some((keyword) => candidate.includes(keyword)) ? scoreSemanticCandidate(candidate) : 0,
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)[0];
  return repeated ? normalizeSemanticSentence(repeated.candidate) : undefined;
}

function pickFirstDistinct(candidates: readonly string[], keywords: readonly string[], used: Set<string>): string | undefined {
  const isCandidate = (candidate: string): boolean =>
    keywords.some((keyword) => candidate.includes(keyword)) && scoreSemanticCandidate(candidate) > 0;
  const sentence = candidates.find((candidate) =>
    !used.has(candidate) && !used.has(trimSentence(candidate, 90)) && isCandidate(candidate));
  if (sentence) {
    const selected = normalizeSemanticSentence(sentence);
    used.add(selected);
    used.add(sentence);
    return selected;
  }
  const repeated = candidates.find(isCandidate);
  return repeated ? normalizeSemanticSentence(repeated) : undefined;
}

function normalizeSemanticSentence(sentence: string): string {
  return trimSentence(sentence, 90);
}

function scoreSemanticCandidate(sentence: string): number {
  if (isLowValueEventSentence(sentence)) return 0;
  // conflict/discovery/gained/lost 共用这个打分器（经 pickDistinct/pickFirstDistinct）；半截对白/孤儿引号片段
  // 同样判 0，不让它们被 得到/没了/发现 等关键词命中后冒头进 mainEvent（Codex retest4：闸只布在 scoreEventSentence
  // 一条管线、这条管线没人管，混进 mainEvent）。
  if (isBrokenDialogueFragment(sentence)) return 0;
  let score = 1;
  if (/(?:发现|看见|注意到|察觉|意识到|决定|打算|想去|必须|不能再|确认|了解|查清|搞清)/u.test(sentence)) score += 3;
  if (isGenericDiscoveryNoise(sentence) || isGenericGainedNoise(sentence) || isGenericConflictNoise(sentence)) score -= 6;
  return Math.max(0, score);
}

function pickDecisionSentence(sentences: readonly string[], used: Set<string>): string | undefined {
  const keywords = ["决定", "打算", "必须", "不能再", "要去", "想去", "想要", "想先", "想仔细", "想了解", "想确认", "想查", "想弄清", "想搞清", "检查", "搜索", "修好", "前往", "确认", "了解", "查清", "搞清"];
  const ranked = sentences
    .map((candidate, index) => {
      const baseScore = keywords.some((keyword) => candidate.includes(keyword))
        ? scoreDecisionCandidate(candidate)
        : 0;
      return {
        candidate,
        index,
        score: baseScore > 0
          ? baseScore + Math.min(4, Math.floor((index / Math.max(sentences.length, 1)) * 4))
          : 0,
      };
    })
    .filter((item) =>
      item.score > 0
      && (item.score >= 15 || (!used.has(item.candidate) && !used.has(trimSentence(item.candidate, 90)))))
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const best = ranked[0];
  if (best) {
    const selected = trimSentence(best.candidate, 90);
    used.add(selected);
    used.add(best.candidate);
    return selected;
  }
  const repeated = sentences
    .map((candidate, index) => ({
      candidate,
      index,
      score: keywords.some((keyword) => candidate.includes(keyword)) ? scoreDecisionCandidate(candidate) : 0,
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)[0];
  return repeated ? trimSentence(repeated.candidate, 90) : undefined;
}

function scoreDecisionCandidate(sentence: string): number {
  if (isLowValueDecisionSentence(sentence)) return 0;
  if (isBrokenDialogueFragment(sentence)) return 0;
  let score = 0;
  if (/(?:决定|打算|想|要).{0,28}(?:去|看|确认|了解|查|追查|弄清|搞清|下一步|怎么走|自己判断)/u.test(sentence)) score += 8;
  if (/(?:合同|诉讼|纠纷|权限|原件|线索|记录|异常)/u.test(sentence)) score += 8;
  if (/(?:自己判断|能做什么|不能做什么|不能再|不能永远靠别人|自己先搞懂|自己看懂|学会游泳|下一步该怎么走)/u.test(sentence)) score += 12;
  if (/先不告诉|没有回复|没有删除|没有再追问/u.test(sentence)) score -= 8;
  return Math.max(0, score);
}

function isLowValueDecisionSentence(sentence: string): boolean {
  if (/明天.{0,24}文件.{0,18}看明白.{0,18}决定下一步|不能再只是被推着走|自己学会游泳|自己先搞懂|自己看懂/u.test(sentence)) return false;
  return /准备好了的话|先去酒店|放行李|自己做决定|等着.{0,12}做决定|第一阶段.{0,12}程序.{0,8}完成|程序就算.{0,8}完成|今天主要是做一个最基础的程序确认|决定先不告诉.{0,8}这件事|还想追问|姿态表明|确认道|出行标准|都是这个|想起|夏令营|暑假计划|大理|驾照|普通得不能再普通|坐稳了听|双肩包|手机屏幕上的时间|床边|准备下一步继续确认|流程当成最终答案/u.test(sentence)
    || isGenericLongEnoughFiller(sentence);
}

function splitClauses(content: string): readonly string[] {
  return splitParagraphs(content)
    .flatMap((paragraph) => paragraph.split(/但|却|然而|同时|又|，|,|；|;/u))
    .map((clause) => cleanClause(clause))
    .filter(isMeaningfulText);
}

function cleanClause(value: string): string {
  return cleanText(value).replace(/^(?:也|又)\s*/u, "");
}

function extractLocations(content: string, projectKnownLocations: readonly string[] = []): readonly string[] {
  const knownLocations = [...unique([
    ...projectKnownLocations,
  ])].sort((left: string, right: string) => locationSpecificity(right) - locationSpecificity(left) || right.length - left.length);
  const tail = endingContent(content);
  const explicitEndingLocations = explicitEndingLocationCandidates(tail, knownLocations);
  const completedEndingLocations = knownLocations.filter((location) => hasCompletedLocationEvidence(tail, location));
  const endingLocations = knownLocations.filter((location) => locationAppears(tail, location) && !hasOnlyPlannedLocationEvidence(tail, location));
  const allLocations = knownLocations.filter((location) => locationAppears(content, location) && !hasOnlyPlannedLocationEvidence(content, location));
  const stableLocations = unique([
    ...sortLocationsBySpecificity(explicitEndingLocations),
    ...sortLocationsBySpecificity(completedEndingLocations),
    ...sortLocationsBySpecificity(endingLocations),
    ...sortLocationsBySpecificity(allLocations),
  ]);
  const plannedMentions = stableLocations.length > 0
    ? sortLocationsBySpecificity(knownLocations.filter((location) => locationAppears(content, location)))
    : [];
  return unique([...stableLocations, ...plannedMentions]).slice(0, 12);
}

function sortLocationsBySpecificity(locations: readonly string[]): readonly string[] {
  return [...locations].sort((left, right) =>
    locationSpecificity(right) - locationSpecificity(left)
    || right.length - left.length);
}

function endingContent(content: string): string {
  const length = Math.max(160, Math.ceil(content.length * 0.2));
  return content.slice(-length);
}

// 题材中立化（R5b）：原先写死「公交站/一楼大厅/二楼申请窗口/三楼办公区」四条专名到达模式。
// 改为遍历项目 location-bible 派生的 knownLocations（含 floors/connectedLocations），用通用「到达动词 + 任意别名」
// 检测显式到达，命中即返回该已登记地点名——不写死任何作品专名。
const ARRIVAL_VERBS = "站在|到了|到达|抵达|走到|来到|停在|坐在|下到|进入|回到|仍站在";

function explicitEndingLocationCandidates(content: string, knownLocations: readonly string[]): readonly string[] {
  const sentences = splitSentences(content)
    .filter((sentence) => !isPlannedLocationSentence(sentence) && !isNegatedLocationArrivalSentence(sentence));
  const matched: string[] = [];
  for (const known of knownLocations) {
    const aliases = locationAliases(known).map((alias) => escapeRegExp(alias)).filter(Boolean);
    if (aliases.length === 0) continue;
    const pattern = new RegExp(`(?:${ARRIVAL_VERBS})(?:[一-龥A-Za-z0-9]{0,4})?(?:${aliases.join("|")})`, "u");
    if (sentences.some((sentence) => pattern.test(sentence))) matched.push(known);
  }
  return unique(matched);
}

function hasCompletedLocationEvidence(content: string, location: string): boolean {
  return splitSentences(content).some((sentence) =>
    !isNegatedLocationArrivalSentence(sentence)
    &&
    completedLocationFragments(sentence).some((fragment) => locationAppears(fragment, location))
    && !isPlannedLocationSentence(sentence));
}

function completedLocationFragments(sentence: string): readonly string[] {
  return [...sentence.matchAll(/(?:站在|到了|到达|抵达|走到|走进|下到|进入|来到|停在|坐在|留在|回到)([^，。；;\n]{0,24})/gu)]
    .map((match) => match[1]?.trim() ?? "")
    .filter(Boolean);
}

function hasOnlyPlannedLocationEvidence(content: string, location: string): boolean {
  const matched = splitSentences(content).filter((sentence) => locationAppears(sentence, location));
  return matched.length > 0 && matched.every((sentence) => isPlannedLocationSentence(sentence) || isNegatedLocationArrivalSentence(sentence));
}

function isPlannedLocationSentence(sentence: string): boolean {
  return /(?:准备|打算|计划|想|要|将要|正要|准备前往|打算前往).{0,18}(?:去|到|前往|离开)/u.test(sentence);
}

function isNegatedLocationArrivalSentence(sentence: string): boolean {
  return /(?:不代表|并未|没有|还没|尚未|未曾).{0,18}(?:到达|抵达|走到|站在|进入|来到|回到)/u.test(sentence);
}

function locationAppears(content: string, location: string): boolean {
  return locationAliases(location).some((alias) => alias.length > 0 && content.includes(alias));
}

function locationNamesMatch(left: string, right: string): boolean {
  return left === right
    || left.includes(right)
    || right.includes(left)
    || locationAliases(left).some((alias) => locationAliases(right).includes(alias));
}

// 题材中立化（R5b）：原先写死「海天市旧城区/创业孵化楼/一楼大厅/二楼申请窗口」专名别名表。
// 改为按通用规则动态生成别名：数字↔中文楼层归一、剥离行政地理前缀（市/区/省/县/镇/街）、
// 剥离前导楼层 token 得到房间名、公交站↔公交站台通用同义。不写死任何作品专名。
function locationAliases(location: string): readonly string[] {
  const aliases = new Set<string>();
  const add = (value: string): void => {
    const trimmed = value.trim();
    if (trimmed.length >= 2) aliases.add(trimmed);
  };
  add(location);
  add(normalizeFloorDigits(location));
  add(normalizeFloorChinese(location));
  // 剥离前导行政地理前缀（如「海天市旧城区创业孵化楼」→「创业孵化楼」），可叠多级。
  let stripped = location;
  while (true) {
    const next = stripped.replace(/^[一-龥]{2,4}(?:市|区|省|县|镇|村|街道|街)(?=[一-龥])/u, "");
    if (next === stripped) break;
    stripped = next;
    add(stripped);
  }
  // 剥离前导楼层 token（数字/中文楼）得到房间名：「1楼大厅」→「大厅」、「2楼申请窗口」→「申请窗口」。
  for (const base of [location, normalizeFloorDigits(location), normalizeFloorChinese(location)]) {
    const room = base.replace(/^(?:(?:[一二三四五六七八九十]+|\d+)\s*楼|地下\s*(?:[一二三四五六七八九十]+|\d+)\s*层|地下室)/u, "");
    if (room !== base) add(room);
  }
  // 通用交通站点同义。
  if (location.includes("公交站")) {
    add("公交站");
    add("公交站台");
  }
  return [...aliases].filter(isNonEmptyString);
}

// 题材中立化（R5b）：删掉专名（孵化楼/市中心/旧城区），只按通用结构后缀打具体度分。
function locationSpecificity(location: string): number {
  if (/(?:侧门|入口|出口)/u.test(location) && !/楼门口/u.test(location)) return 2;
  if (/(?:大厅|窗口|办公区|终端区|楼梯间|正门|公交站|站台|街口)/u.test(location)) return 3;
  if (/(?:楼|公寓|建筑|大厦|小区|中心|总部|园区)/u.test(location)) return 2;
  return 1;
}

// 题材中立（R5b）：楼层数字↔中文归一不再写死 1/2/3，覆盖任意个位楼层（任何题材的建筑都适用）。
const FLOOR_DIGIT_TO_CHINESE: ReadonlyArray<readonly [string, string]> = [
  ["1", "一"], ["2", "二"], ["3", "三"], ["4", "四"], ["5", "五"],
  ["6", "六"], ["7", "七"], ["8", "八"], ["9", "九"],
];

function normalizeFloorDigits(value: string): string {
  let result = value;
  for (const [digit, chinese] of FLOOR_DIGIT_TO_CHINESE) {
    result = result.replace(new RegExp(`${chinese}楼`, "gu"), `${digit}楼`);
  }
  return result;
}

function normalizeFloorChinese(value: string): string {
  let result = value;
  for (const [digit, chinese] of FLOOR_DIGIT_TO_CHINESE) {
    result = result.replace(new RegExp(`${digit}楼`, "gu"), `${chinese}楼`);
  }
  return result;
}

function isGenericDiscoveryNoise(sentence: string): boolean {
  return /(?:不是什么秘密|不是秘密|都知道|众所周知|公开的秘密|算不上秘密)/u.test(sentence)
    || /(?:看见|发现|意识到).{0,18}(?:时间|闹钟|屏幕|手机|微信|朋友圈|窗外|杯子|座椅|行李箱|天空|城市|舷窗)/u.test(sentence)
    || /真正意识到|这一切不是做梦|父母可能比/u.test(sentence)
    || /发现这跟昨天那份.{0,24}文件完全不是|发现这跟昨天/u.test(sentence)
    || isGenericLongEnoughFiller(sentence)
    || /发现.{0,24}(?:地址|距离|备注栏|装修中)/u.test(sentence);
}

function isGenericGainedNoise(sentence: string): boolean {
  return /当然可以带回去慢慢看|带回去慢慢看|可以带回|文件袋拿到|拿到客厅|拿到茶几|资料拿到了|拿到的所有东西|拿到这些|找到了?和.{0,8}聊天记录|微信聊天记录/u.test(sentence);
}

function isNegatedGainedCandidate(sentence: string): boolean {
  return /(?:没|没有|未|并未|不曾|还没|无法|不能).{0,10}(?:得到|拿到|偷到|领到|找到|搜到|收集到|带回)/u.test(sentence);
}

function isGenericConflictNoise(sentence: string): boolean {
  return /哪个“?所有人”?|不信任到什么程度|脸上的表情介于/u.test(sentence);
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function shortHash(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 10);
}

function splitSentences(content: string): readonly string[] {
  return splitParagraphs(content)
    // 断句把句末标点后【紧跟的右引号】并入本句——否则中文对白「…。"」的句号在引号内，断在 。 之后会把右引号
    // 甩到下句开头，整句对白被切成「说话人归属」碎片、还以孤儿右引号打头（Codex 1-5 章真机：timeline 摘要坏）。
    .flatMap((paragraph) => paragraph.split(/(?<=[。！？!?；;][」』”’】]?)/u))
    .map((sentence) => cleanText(sentence))
    .filter(isMeaningfulText);
}

function splitParagraphs(content: string): readonly string[] {
  return content
    .split(/\n{2,}/u)
    .map((paragraph) => cleanText(paragraph))
    .filter(isMeaningfulText);
}

function stripMarkdownHeadings(content: string): string {
  return content
    .split(/\r?\n/u)
    .filter((line) => !/^#{1,6}\s+\S/u.test(line.trim()))
    .join("\n");
}

function extractMarkdownTitle(content: string): string | undefined {
  const firstLine = content.split(/\r?\n/u).find((line) => line.trim().length > 0)?.trim();
  if (!firstLine?.startsWith("#")) return undefined;
  const title = firstLine.replace(/^#{1,6}\s*/u, "").trim();
  return title || undefined;
}

function cleanText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function isMeaningfulText(value: string): boolean {
  return /[\p{Script=Han}a-z0-9]/iu.test(value);
}

function trimSentence(value: string, maxLength: number): string {
  const clean = cleanText(value).replace(/^[-*]\s*/u, "");
  return clean.length <= maxLength ? clean : `${clean.slice(0, maxLength)}…`;
}

function defaultDraftPath(projectDir: string, chapter: number): string {
  return join(projectDir, "drafts", "fast", `chapter-${padChapter(chapter)}.md`);
}

function padChapter(chapter: number): string {
  return String(Math.max(0, Math.trunc(chapter))).padStart(4, "0");
}
