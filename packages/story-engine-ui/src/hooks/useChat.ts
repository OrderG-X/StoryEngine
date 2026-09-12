import { useCallback, useRef } from "react";
import { directEditDraft, fetchChapterChatStream, fetchChapterWorkspace, restoreSnapshotApi, saveChapterWorkspace } from "../api/client.js";
import { streamAgentChat } from "../api/agentChatClient.js";
import { renameChatSession } from "../api/chatSessionsClient.js";
import {
  emptyAssistantMessage,
  projectAgentEvent,
  settleStoppedAgentTurn,
  type AgentProjectionEvent,
} from "./agentEventProjection.js";
import { deriveIntentTitle } from "./deriveIntentTitle.js";
import { nextFlowAfterToolResult } from "./agentFlowStatus.js";
import { truncateMessagesFrom, undoCutId } from "./truncateMessages.js";
import { buildUndoPersistRequest } from "./undoPersist.js";
import { buildOutboundConversation } from "./buildOutboundConversation.js";
import { flowStatusAfterGenerateFailure, shouldAdoptDiskDraftAfterStop, shouldReconcileCommitAttempt } from "./reconcileChapterState.js";
import { honestyRewritePatch } from "./detectUnbackedCompletion.js";
import { DIRECT_WRITE_FALLBACK_GOAL, matchDeterministicChapterAction } from "../utils/chapterActionIntents.js";
import { markUndoReloadPreferSession } from "../utils/undoReloadFlag.js";
import { drainAutosave, resumeAutosave, suspendAutosave } from "../utils/autosaveControl.js";
import type {
  ChapterAdviceCard,
  ChapterAgentCard,
  ChapterWorkspaceSnapshot,
  FoundationGapAppliedWrite,
  FoundationGapApplyPlan,
  FoundationGapChatResult,
  FoundationGapSkippedWrite,
  FoundationConflictItem,
  FoundationGapSuggestion,
  StateOverview,
} from "../api/types.js";
import type { ChapterMessage, ChapterWorkflowState, SuggestedAction } from "../types.js";
import { suggestedAction } from "../utils/workflowHelpers.js";
import {
  isChapterAgentCancel,
  isChapterAgentConfirm,
  isClearDraftRequest,
} from "../utils/chatTextHelpers.js";
import {
  compactStrings,
  countTextWords,
  extractDraftTitle,
} from "../utils/textUtils.js";
import { useWorkspaceStore } from "../stores/workspaceStore.js";
import { useNavigationStore } from "../stores/navigationStore.js";
import {
  beginWorkspaceOperation,
  finishWorkspaceOperation,
  isWorkspaceBusy,
  isWorkspaceOperationCurrent,
  isWorkspaceOperationTargetCurrent,
  retargetWorkspaceOperation,
} from "../utils/workspaceOperation.js";
import { recordWorkspaceRevision } from "../utils/workspaceRevisionTracker.js";

/* ------------------------------------------------------------------ */
/*  Helper: firstChapterSetupDirection                                 */
/* ------------------------------------------------------------------ */

function firstChapterSetupDirection(overview: StateOverview | null): string {
  const setup = overview?.storyBible?.firstChapterSetup;
  if (!setup) return "";
  return compactStrings([
    setup.goal,
    setup.openingScene,
    setup.hook,
    setup.conflict,
  ]).join("；");
}

function foundationSuggestionKey(suggestion: FoundationGapSuggestion): string {
  const after = suggestion.after as Record<string, unknown> | undefined;
  const bibleEntry = (after?.bibleEntry ?? after) as Record<string, unknown> | undefined;
  const name = String(bibleEntry?.name ?? suggestion.extractedEntityName ?? suggestion.targetPath ?? suggestion.targetFile ?? "");
  return [
    suggestion.actionType,
    suggestion.targetFile,
    suggestion.targetPath,
    suggestion.category,
    name,
    JSON.stringify(after ?? {}),
  ].join("|");
}

function uniqueFoundationSuggestions(suggestions: readonly FoundationGapSuggestion[]): FoundationGapSuggestion[] {
  const seen = new Set<string>();
  const unique: FoundationGapSuggestion[] = [];
  for (const suggestion of suggestions) {
    const key = foundationSuggestionKey(suggestion);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(suggestion);
  }
  return unique;
}

function foundationSuggestionLabel(suggestion: FoundationGapSuggestion): string {
  if (suggestion.actionType === "delete_foundation_entry") {
    const beforeRecord = suggestion.before as Record<string, unknown> | undefined;
    const beforeName = typeof beforeRecord?.name === "string" ? beforeRecord.name : undefined;
    const name = suggestion.extractedEntityName
      ?? beforeName
      ?? (typeof suggestion.before === "string" ? suggestion.before : "目标条目");
    return `删除资料「${shortFoundationLabel(String(name))}」`;
  }
  const actionLabel = suggestion.actionType === "create_character" ? "创建角色"
    : suggestion.actionType === "rename_character" ? "修改角色名"
    : suggestion.actionType === "update_character_detail" ? "更新角色资料"
    : suggestion.actionType === "create_location" ? "创建地点"
    : suggestion.actionType === "create_asset" ? "创建资产"
    : suggestion.actionType === "update_world_rule" ? "补世界观"
    : suggestion.actionType === "update_writing_rule" ? "补写作规则"
    : suggestion.actionType;
  const scalarValue = foundationSuggestionTextValue(suggestion);
  if ((suggestion.actionType === "update_world_rule" || suggestion.actionType === "update_writing_rule") && scalarValue) {
    return `${actionLabel}「${shortFoundationLabel(scalarValue)}」`;
  }
  const after = suggestion.after as Record<string, unknown> | undefined;
  const bibleEntry = (after?.bibleEntry ?? after) as Record<string, unknown> | undefined;
  const name = String(bibleEntry?.name ?? suggestion.extractedEntityName ?? "未知");
  const identity = String(bibleEntry?.identity ?? "");
  const role = String(bibleEntry?.role ?? "");
  return `${actionLabel}「${name}」${identity ? ` — ${identity}` : ""}${role ? `（${role}）` : ""}`;
}

const FOUNDATION_PREVIEW_FIELD_LABELS: Record<string, string> = {
  name: "名字",
  role: "定位",
  age: "年龄",
  gender: "性别",
  identity: "身份",
  appearanceAnchors: "外貌锚点",
  desire: "欲望",
  fear: "恐惧",
  weakness: "短板",
  contradiction: "人物反差",
  moralBoundary: "道德底线",
  privateMotive: "隐性动机",
  relationshipToProtagonist: "与主角关系",
  relationshipDynamics: "关系动态",
  speechStyle: "说话风格",
  speechSamples: "典型台词",
  behaviorBoundaries: "行为边界",
  knowledgeKnown: "知道什么",
  knowledgeUnknown: "不知道什么",
  cannotReveal: "不能透露",
  cannotDo: "不能做",
  rules: "世界规则",
  powerOrSurvivalSystems: "资源规则",
  socialOrder: "社会结构",
  factions: "势力",
  historyFacts: "历史事实",
  worldPremise: "世界前提",
  narrativePerspective: "叙事视角",
  proseStyle: "文风",
  pacing: "节奏",
  doNotDo: "写作禁忌",
  forbiddenContent: "禁写内容",
  readerExperienceRules: "读者体验规则",
  type: "类型",
  ownerName: "归属",
  currentLocationName: "所在位置",
  status: "状态",
  usageRules: "使用规则",
  lossRules: "丢失规则",
  narrativeFunction: "叙事功能",
  risks: "风险",
  resources: "资源",
};

export function foundationSuggestionPreviewText(suggestions: readonly FoundationGapSuggestion[]): string {
  return suggestions.map((suggestion) => {
    const after = suggestion.after as Record<string, unknown> | string | readonly unknown[] | null;
    const source = (after && typeof after === "object" && !Array.isArray(after) && "bibleEntry" in after
      ? (after as Record<string, unknown>).bibleEntry
      : after) as Record<string, unknown> | string | readonly unknown[] | null;
    const lines: string[] = [`【${foundationSuggestionLabel(suggestion)}】`];
    if (typeof source === "string") {
      lines.push(source);
    } else if (Array.isArray(source)) {
      lines.push(...source.filter((item): item is string => typeof item === "string"));
    } else if (source && typeof source === "object") {
      for (const [key, value] of Object.entries(source)) {
        if (key === "id" || value === undefined || value === null) continue;
        const label = FOUNDATION_PREVIEW_FIELD_LABELS[key] ?? key;
        if (typeof value === "string" && value.trim()) {
          lines.push(`${label}：${value.trim()}`);
        } else if (Array.isArray(value)) {
          const items = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
          if (items.length) lines.push(`${label}：${items.join("、")}`);
        }
      }
    }
    return lines.slice(0, 24).join("\n");
  }).join("\n\n");
}

function foundationSuggestionTextValue(suggestion: FoundationGapSuggestion): string {
  if (typeof suggestion.after === "string") return suggestion.after.trim();
  if (Array.isArray(suggestion.after)) return suggestion.after.map(String).join("；").trim();
  const source = suggestion.sourceUserMessage?.trim();
  if (!source) return "";
  return source
    .replace(/^(?:加一条|新增|补充|写入|记录|设定)?\s*(?:世界观规则|世界观|写作规则|规则)?[：:\s]*/u, "")
    .replace(/(?:。?\s*)?请(?:整理|生成|做成|形成)[^。]*?(?:草案|卡|建议)?(?:，|,)?(?:确认后)?(?:写入|保存|记录)?(?:。)?$/u, "")
    .replace(/(?:请)?(?:整理[^。]*?草案，?)?(?:确认后)?(?:写入|保存|记录)(?:。)?$/u, "")
    .trim();
}

function shortFoundationLabel(value: string): string {
  const text = value.trim();
  return text.length > 32 ? `${text.slice(0, 32)}...` : text;
}

export function isShortFoundationWriteCommand(message: string): boolean {
  const text = message.trim();
  if (!text) return false;
  return /^(?:写入|写入吧|都写进去|都记下来|记下来|保存|确认|确认写入|可以写入|就这些)(?:[，,、\s]*(?:写入|保存|记下来))?[吧了。．.!！?？\s]*$/u.test(text);
}

// 注意:不做归档过滤——仅用于 useChat-write-status-copy.test.ts 测试路径
export function conversationFromWorkspaceMessages(): readonly { readonly role: "user" | "assistant"; readonly content: string }[] {
  return useWorkspaceStore.getState().workspace.messages
    .filter((item) => item.role === "user" || item.role === "assistant")
    .map((item) => ({ role: item.role as "user" | "assistant", content: item.content }));
}

/* ------------------------------------------------------------------ */
/*  资料直写谓词：两个谓词共用「清空/重置守卫 + 白名单 every 校验」      */
/*  下面抽出共用部分，让两个谓词只表达各自差异，差异一眼可见。           */
/* ------------------------------------------------------------------ */

/** 清空/重置类消息绝不直写——共用守卫。 */
function isFoundationClearOrResetRequest(text: string): boolean {
  return /清空|重置/u.test(text);
}

/**
 * 较窄白名单（7 项）：仅 shouldAutoApplyFoundationSuggestionsFromChat 用。
 * 它是 DIRECT_ARCHIVE_ACTION_TYPES 的真子集（少了 update_asset_status、
 * update_location_detail、update_knowledge_boundary 三项）。
 */
const AUTO_APPLY_ACTION_TYPES = new Set<FoundationGapSuggestion["actionType"]>([
  "create_character",
  "rename_character",
  "update_character_detail",
  "create_location",
  "create_asset",
  "update_world_rule",
  "update_writing_rule",
]);

const DIRECT_ARCHIVE_ACTION_TYPES = new Set<FoundationGapSuggestion["actionType"]>([
  "create_character",
  "rename_character",
  "update_character_detail",
  "create_location",
  "create_asset",
  "update_asset_status",
  "update_location_detail",
  "update_world_rule",
  "update_writing_rule",
  "update_knowledge_boundary",
  // 注意：故意未纳入 create_relationship 与 update_character_boundary——
  // route 会产出 create_relationship。这两类不直写是有意为之，不是遗漏：
  // - create_relationship：关系涉及双角色一致性，单边直写可能让两侧资料不自洽；
  // - update_character_boundary：边界涉及知识/不可透露信息泄漏，误写风险高。
  // 留待单独派发（带双角色/边界校验），届时再决定是否纳入。
]);

/** 全部建议都落在给定白名单内（共用 every 校验）。 */
function everyActionInWhitelist(
  suggestions: readonly FoundationGapSuggestion[],
  whitelist: ReadonlySet<FoundationGapSuggestion["actionType"]>,
): boolean {
  return suggestions.every((suggestion) => whitelist.has(suggestion.actionType));
}

export function shouldAutoApplyFoundationSuggestionsFromChat(
  message: string,
  suggestions: readonly FoundationGapSuggestion[],
): boolean {
  if (suggestions.length === 0) return false;
  const text = message.trim();
  if (isFoundationClearOrResetRequest(text)) return false;
  if (suggestions.every((suggestion) => suggestion.actionType === "delete_foundation_entry")) {
    return isFoundationDeleteRequest(text);
  }
  if (/删除|移除/u.test(text)) return false;
  // 差异点 1：本谓词额外要求消息里出现显式写入动词门槛（短写入指令 / 直接写 / 显式写入请求）。
  const directWriteText = /(?:直接|马上|立即).{0,8}(?:写入|保存|记录)|(?:写入|保存|记录)(?:当前书籍|资料|角色资料|地点资料|资产资料|世界观资料|写作规则)?[。.]?$/u.test(text);
  if (!isShortFoundationWriteCommand(text) && !directWriteText && !isExplicitFoundationWriteRequest(text)) {
    return false;
  }
  // 差异点 2：本谓词用较窄的 7 项白名单（AUTO_APPLY_ACTION_TYPES）。
  return everyActionInWhitelist(suggestions, AUTO_APPLY_ACTION_TYPES);
}

/**
 * 资料归档「直接写」判定：当资料 Agent 已经生成可执行的写入建议（generatedSuggestions，
 * 不含仅供确认的 draftSuggestion）且全部落在安全的资料写入动作里时，默认直接写入并回报。
 * 这避免「凡归档都先预览等用户点确认」的防御性中间态；删除/清空仍走各自的合法确认路径。
 *
 * 与 shouldAutoApplyFoundationSuggestionsFromChat 的关系（二者在调用点用 `||` 并联）：
 * - 无动词门槛：本谓词不要求用户消息出现「写入/保存」等显式动词——后者是已废弃的防御式门槛。
 *   纯讨论不会产出 generatedSuggestions，因此不会误写。
 * - 白名单更全：本谓词用 DIRECT_ARCHIVE_ACTION_TYPES（10 项），是旧谓词 7 项白名单的超集。
 * 因此 `||` 并联时，旧谓词唯一能额外命中的情形，是 draftSuggestion 也需纳入白名单校验时
 * （本谓词只看 generatedSuggestions，不含 draftSuggestion）。
 */
export function shouldDirectArchiveGeneratedSuggestions(
  message: string,
  generatedSuggestions: readonly FoundationGapSuggestion[],
): boolean {
  if (generatedSuggestions.length === 0) return false;
  const text = message.trim();
  if (isFoundationClearOrResetRequest(text)) return false;
  // 删除类不在直写白名单里：删除走 isFoundationDeleteRequest + 写前快照的专门路径。
  return everyActionInWhitelist(generatedSuggestions, DIRECT_ARCHIVE_ACTION_TYPES);
}

/**
 * 资料归档「是否直接写」的总判定（问题 B）。
 *
 * - directArchive=true（资料补全的「决断式抽取」）：把 draftSuggestion 也纳入可直写集合。
 *   即对 allSuggestions（= [draftSuggestion?, ...generatedSuggestions]）做白名单校验，
 *   而不再「只认 generatedSuggestions」。这样模型若只给出 draftSuggestion，也能直写、不再写不进。
 *   安全不放宽：仍走 DIRECT_ARCHIVE_ACTION_TYPES 白名单 + 清空/重置守卫（删除类不在白名单，
 *   仍走自己的写前快照确认路径）。
 * - directArchive=false（交互式资料管家面板）：完全保留原行为——draftSuggestion 仍是
 *   「草案待确认」，不放宽；只在用户显式写入指令 + generatedSuggestions 命中时才直写。
 */
export function shouldDirectArchiveFromChat(input: {
  readonly directArchive: boolean;
  readonly sourceText: string;
  readonly allSuggestions: readonly FoundationGapSuggestion[];
  readonly generatedSuggestions: readonly FoundationGapSuggestion[];
}): boolean {
  if (input.directArchive) {
    if (input.allSuggestions.length === 0) return false;
    const text = input.sourceText.trim();
    if (isFoundationClearOrResetRequest(text)) return false;
    // 决断式直写仍要过白名单：删除类不在白名单内，会落回各自的确认路径。
    return everyActionInWhitelist(input.allSuggestions, DIRECT_ARCHIVE_ACTION_TYPES);
  }
  // 交互模式：不放宽，沿用原 `||` 并联——只认 generatedSuggestions，不含 draftSuggestion。
  return shouldAutoApplyFoundationSuggestionsFromChat(input.sourceText, input.allSuggestions)
    || shouldDirectArchiveGeneratedSuggestions(input.sourceText, input.generatedSuggestions);
}

export function isFoundationDeleteRequest(message: string): boolean {
  const text = message.trim();
  if (!text) return false;
  const deleteLike = /(?:删除|删掉|移除|去掉|清除|清空|delete|remove)/iu.test(text);
  if (!deleteLike) return false;
  if (/(?:草稿|正文|章节|本章|下一章|左侧草稿|工作稿|书籍|这本书|项目|draft|chapter|book|project)/iu.test(text)) {
    return false;
  }
  const foundationTargetLike = /(?:资料|角色|人物|主角|配角|占位|档案|卡|世界观|地点|资产|道具|物品|规则|关系|character|profile|bible|matrix|asset|location|foundation)/iu.test(text);
  const bareDeleteConfirmLike = /^(?:删除|删掉|移除|去掉|清除)(?:吧|掉|它|这个|那个)?[。.!！?？\s]*$/iu.test(text);
  return foundationTargetLike || bareDeleteConfirmLike;
}

export interface FoundationNoExecutableChangeFeedback {
  readonly title: string;
  readonly summary: string;
  readonly detail: readonly string[];
}

export function isExplicitFoundationWriteRequest(message: string): boolean {
  const text = message.trim();
  if (!text) return false;
  const targetLike = /(?:资料|角色|人物|主角|名字|名称|设定|档案|卡|世界观|地点|资产|道具|物品|车|枪|手机|现金|背包|规则|写作规则|文风|节奏|年龄|身份|定位|职业|说话|语气|心境|情绪|目标|关系|知道|不知道|不能透露|profile|character|hero|protagonist|name|card|bible|matrix|world|asset|location|rule)/iu.test(text);
  const futureRenameLike = /(?:以后|从现在起).{0,16}(?:都叫|叫|名字叫|名叫|改为|改成|设为)/iu.test(text)
    || /from now on.{0,40}(?:call|name|rename|change|update)/iu.test(text);
  const futureStyleLike = /(?:以后|从现在起).{0,16}(?:文风|风格|节奏|写作规则).{0,16}(?:更|少|多|不要|避免|冷|快|慢)/iu.test(text)
    || /from now on.{0,40}(?:style|tone|pacing|rule).{0,40}(?:more|less|avoid|colder|faster|slower)/iu.test(text);
  const writeLike = /(?:改|修改|换成|改成|设为|更新|保存|写入|记录|记一下|新增|创建|添加|加一|加个|加一辆|加一把|加一个|给.{0,12}加|安排|配一|别叫|rename|change|update|remember|wrong name|should be|make it|call .{0,40} anymore)/iu.test(text)
    || futureRenameLike
    || futureStyleLike;
  const onlyDraftLike = /(?:草稿|正文|章节|下一章|本章|chapter|draft)/iu.test(text) && !targetLike;
  return targetLike && writeLike && !onlyDraftLike;
}

export function buildNoExecutableFoundationChangeFeedback(sourceText: string): FoundationNoExecutableChangeFeedback {
  if (isFoundationDeleteRequest(sourceText)) {
    return {
      title: "没有找到可删除的资料条目",
      summary: "没有定位到要删除的资料条目，未写入任何文件。",
      detail: [
        "scope: 当前书籍工作区",
        "写入状态：未写入任何文件",
        "原因：没有从当前资料里找到与你描述匹配的条目。",
        "下一步：把要删除的对象说得更具体，例如“删除角色〈角色名〉”。",
      ],
    };
  }
  const summary = "资料修改未完成：没有生成可确认的资料修改，未写入任何文件。";
  return {
    title: "资料修改未完成",
    summary,
    detail: [
      "scope: 当前书籍工作区",
      "写入状态：未写入任何文件",
      "原因：没有生成可确认的资料修改",
      "下一步：请生成资料修改预览，或把要修改的字段说得更具体。",
    ],
  };
}

function buildUndoFoundationWriteAction(undoId: string): SuggestedAction {
  return {
    id: "undo-foundation-write",
    label: "撤回本次修改",
    description: "恢复到这次 Agent 修改前的资料状态。",
    permission: "project_config_write",
    requiresConfirmation: false,
    endpoint: undoId,
  };
}

/**
 * 修2：把写入记录去重成「真实写入的卡片」清单。同一卡片的多文件写入（如删除产生 3 个文件写入）算一条，
 * 让结果卡按真实写入条数回报，而非凭 accepted.length 虚报。去重键优先 targetId，退回 targetName，再退回 targetFile。
 */
function foundationWrittenCards(
  writes: readonly FoundationGapAppliedWrite[],
): readonly { readonly key: string; readonly domain: FoundationGapAppliedWrite["domain"] }[] {
  const seen = new Map<string, FoundationGapAppliedWrite["domain"]>();
  for (const write of writes) {
    const key = `${write.domain}:${write.targetId ?? write.targetName ?? write.targetFile}`;
    if (!seen.has(key)) seen.set(key, write.domain);
  }
  return [...seen.entries()].map(([key, domain]) => ({ key, domain }));
}

export function foundationApplyResultText(
  plan: FoundationGapApplyPlan | null,
  writes: readonly FoundationGapAppliedWrite[] = [],
  skippedWrites: readonly FoundationGapSkippedWrite[] = [],
): string {
  if (writes.length > 0) {
    // 修2：诚实回报合并两类没写成——规划期冲突（plan.skippedConflicts）+ 写入期跳过（skippedWrites，
    // 缺 targetId/找不到卡片）。优先采用引擎算好的精确原因（含真实实体名）。
    const skippedReasons = skippedWrites.map((skip) => skip.summary).filter(Boolean);
    const conflictCount = plan?.skippedConflicts.length ?? 0;
    const skipCount = skippedWrites.length;
    const skippedLine = (conflictCount + skipCount) > 0
      ? (skippedReasons.length > 0
        ? `另有 ${conflictCount + skipCount} 条没能写入：${skippedReasons.join("；")}`
        : `另有 ${conflictCount} 条这次没有写入（需要确认或被保护规则拦下），可以再说一次让我单独处理。`)
      : undefined;
    // 修2：真实写入条数按 writes 去重推导（同一卡片的多文件写入算一条），不用 accepted.length 虚报。
    const writtenCards = foundationWrittenCards(writes);
    if (writtenCards.length >= 2) {
      const counts = new Map<FoundationGapAppliedWrite["domain"], number>();
      for (const card of writtenCards) {
        counts.set(card.domain, (counts.get(card.domain) ?? 0) + 1);
      }
      const parts = [...counts.entries()].map(([domain, count]) => `${foundationWriteDomainLabel(domain)} ${count} 条`);
      return [
        `已写入 ${writtenCards.length} 条资料（${parts.join("、")}），可撤回本次修改。`,
        ...foundationNewExtraFieldLines(writes),
        ...(skippedLine ? [skippedLine] : []),
      ].join("\n");
    }
    // 单条真实写入 + 有写入期跳过：如实告知「写入 N 条 + M 条没能写入（原因…）」。
    const single = foundationWritesResultText(writes);
    if (skipCount > 0 && skippedReasons.length > 0) {
      return [
        `已写入 ${writtenCards.length} 条资料，另有 ${skipCount} 条没能写入：${skippedReasons.join("；")}`,
        single,
      ].join("\n");
    }
    return skippedLine ? `${single}\n${skippedLine}` : single;
  }
  // 修3：到这里 writes 为空，代表「一个字没写」。绝不报「已修改/可撤回」（哪怕 plan.fileChanges 非空——
  // 那只是 targetFilesForFoundationWriteSuggestion 在缺 targetId 时仍算出的占位文件，并无真实写入）。
  if (!plan || plan.acceptedSuggestions.length === 0) return "当前没有可写入的资料草案。";
  // 修1：优先采用引擎算好的精确原因（skippedWrites[].summary，含真实角色名），而非 UI 自己猜的通用句。
  const skippedReasons = skippedWrites.map((skip) => skip.summary).filter(Boolean);
  if (skippedReasons.length > 0) {
    return [
      "资料修改未完成：未写入任何文件。",
      `原因：${skippedReasons.join("；")}`,
      "下一步：把要修改的对象说得更具体（例如点名是哪个角色），我再试一次。",
    ].join("\n");
  }
  return [
    "资料修改未完成：未写入任何文件。",
    "原因：没能定位到这条资料对应的卡片，所以没有写入任何内容。",
    "下一步：把要修改的对象说得更具体（例如点名是哪个角色），我再试一次。",
  ].join("\n");
}

function foundationCategoryShortLabel(category: string): string {
  if (category === "characters") return "角色";
  if (category === "characterRelationships") return "角色关系";
  if (category === "world") return "世界观";
  if (category === "writingRules") return "写作规则";
  if (category === "locations") return "地点";
  if (category === "assets") return "资产";
  if (category === "knowledgeBoundary") return "知识边界";
  return "资料";
}

const DELETE_CONFIRM_PREFIX = "delete_needs_explicit_confirm:";

export function foundationDeleteConfirmationConflicts(plan: FoundationGapApplyPlan | null): readonly FoundationConflictItem[] {
  if (!plan) return [];
  return plan.skippedConflicts.filter((conflict) => (
    typeof conflict.description === "string" && conflict.description.startsWith(DELETE_CONFIRM_PREFIX)
  ));
}

export function foundationDeleteConfirmText(conflicts: readonly FoundationConflictItem[]): string {
  const reasons = conflicts
    .map((conflict) => conflict.description.slice(DELETE_CONFIRM_PREFIX.length).trim())
    .filter(Boolean);
  const reasonText = reasons.length > 0 ? reasons.join("；") : "已在正文中使用";
  return `这条资料在正文里出现过（${reasonText}），删除后正文里的相关描写不会自动修改。确认要删除吗？`;
}

export function foundationDeleteBlockedText(plan: FoundationGapApplyPlan | null): string | undefined {
  if (!plan) return undefined;
  if (plan.skippedConflicts.some((conflict) => conflict.description === "cannot_delete_protagonist")) {
    return "主角不能删除，未修改任何文件。如果要换主角，可以改主角的名字或修改主角资料。";
  }
  if (plan.skippedConflicts.some((conflict) => conflict.description === "delete_target_not_found")) {
    return "没有找到要删除的资料条目，可能已经删除过了。未修改任何文件。";
  }
  return undefined;
}

export function foundationWritesResultText(writes: readonly FoundationGapAppliedWrite[]): string {
  const newFieldLines = foundationNewExtraFieldLines(writes);
  const rename = writes.find((write) => write.action === "rename_character" && write.targetName);
  if (rename?.targetName) {
    return [
      `已把主角名改为${rename.targetName}。`,
      ...newFieldLines,
      "左侧资料已更新，可撤回本次修改。",
    ].join("\n");
  }
  const primaryLine = foundationWriteProductLine(writes);
  if (primaryLine) {
    return [
      primaryLine,
      ...newFieldLines,
      "资料已更新，可撤回本次修改。",
    ].join("\n");
  }
  const lines = ["已修改。", ""];
  const seen = new Set<string>();
  for (const write of writes) {
    const objectLine = write.targetName
      ? `对象：${foundationWriteDomainLabel(write.domain)} ${write.targetName}`
      : `对象：${foundationWriteDomainLabel(write.domain)}`;
    if (!seen.has(objectLine)) {
      lines.push(objectLine);
      seen.add(objectLine);
    }
    const fileLine = `位置：${foundationWriteTargetLabel(write.targetFile)}`;
    if (!seen.has(fileLine)) {
      lines.push(fileLine);
      seen.add(fileLine);
    }
  }
  for (const fieldLine of newFieldLines) {
    if (!seen.has(fieldLine)) {
      lines.push(fieldLine);
      seen.add(fieldLine);
    }
  }
  lines.push("状态：左侧资料已刷新，可撤回本次修改。");
  return lines.join("\n");
}

/**
 * 当本次写入新建了卡上原本没有的自定义字段时，如实回报「为〈卡名〉新增自定义字段：境界、功法」。
 * 纯中文、不展示英文 key 或文件路径；按卡名归并，去重。
 */
function foundationNewExtraFieldLines(writes: readonly FoundationGapAppliedWrite[]): readonly string[] {
  const byCard = new Map<string, Set<string>>();
  for (const write of writes) {
    const fields = (write.newExtraFields ?? []).map((field) => field.trim()).filter(Boolean);
    if (fields.length === 0) continue;
    const cardName = write.targetName?.trim();
    const key = cardName ? `「${cardName}」` : `该${foundationWriteDomainLabel(write.domain)}`;
    const bucket = byCard.get(key) ?? new Set<string>();
    for (const field of fields) bucket.add(field);
    byCard.set(key, bucket);
  }
  return [...byCard.entries()].map(([card, fields]) => `为${card}新增自定义字段：${[...fields].join("、")}`);
}

function foundationWriteProductLine(writes: readonly FoundationGapAppliedWrite[]): string | undefined {
  const primary = writes[0];
  if (!primary) return undefined;
  const name = primary.targetName?.trim();
  if (primary.action === "delete_foundation_entry" || primary.action.startsWith("delete_")) {
    const fileCount = new Set(writes.map((write) => write.targetFile)).size;
    const label = foundationWriteDomainLabel(primary.domain);
    return name
      ? `已删除${label}「${name}」，共更新 ${fileCount} 个文件。`
      : `已删除一条${label}资料，共更新 ${fileCount} 个文件。`;
  }
  if (primary.domain === "asset") {
    if (name) return primary.action === "update_asset_status" ? `已更新${name}的资产状态。` : `已把${name}加入资产资料。`;
    return "资产资料已更新。";
  }
  if (primary.domain === "location") {
    if (name) return primary.action === "update_location_detail" ? `已更新${name}的地点资料。` : `已把${name}加入地点资料。`;
    return "地点资料已更新。";
  }
  if (primary.domain === "world") return "世界观已更新。";
  if (primary.domain === "writingRules") return "写作规则已更新。";
  if (primary.domain === "character" && name) {
    return primary.action === "update_character_detail" || primary.action.startsWith("update_character_")
      ? `已更新${name}的角色资料。`
      : `已把${name}加入角色资料。`;
  }
  return undefined;
}

function foundationWriteDomainLabel(domain: FoundationGapAppliedWrite["domain"]): string {
  if (domain === "character") return "角色";
  if (domain === "location") return "地点";
  if (domain === "world") return "世界观";
  if (domain === "writingRules") return "写作规则";
  if (domain === "asset") return "资产";
  return "资料";
}

function foundationWriteTargetLabel(targetFile: string): string {
  if (targetFile === "story/character-bible.json") return "角色设定";
  if (targetFile.match(/^characters\/[^/]+\/profile\.json$/u)) return "角色档案";
  if (targetFile.match(/^characters\/[^/]+\/core\.json$/u)) return "角色核心资料";
  if (targetFile.match(/^characters\/[^/]+\/state\.json$/u)) return "角色状态资料";
  if (targetFile === "story/location-bible.json") return "地点资料";
  if (targetFile === "story/assets.json") return "资产账本";
  if (targetFile === "story/world-bible.json") return "世界观";
  if (targetFile === "story/writing-rules.json") return "写作规则";
  if (targetFile === "story/bible.json") return "故事设定";
  if (targetFile === "world/core.json") return "世界核心资料";
  if (targetFile === "world/state.json") return "世界状态资料";
  return targetFile;
}

function mergeAgentCardPatch(card: ChapterAgentCard, patch: Partial<ChapterAgentCard>): ChapterAgentCard {
  return {
    ...card,
    ...patch,
    detail: mergeAgentCardDetails(card.detail, patch.detail),
  };
}

function mergeAgentCardDetails(
  existing: readonly string[] | undefined,
  incoming: readonly string[] | undefined,
): readonly string[] | undefined {
  if (!existing?.length) return incoming;
  if (!incoming?.length) return existing;
  const auditLines = existing.filter(isRouteAuditDetailLine);
  return uniqueStrings([...auditLines, ...incoming]);
}

function isRouteAuditDetailLine(line: string): boolean {
  return /^(route|action|target|confidence|reason):\s*/u.test(line.trim()) || /^判断：/u.test(line.trim());
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function buildLocalStoryDataAnswer(message: string, overview: StateOverview | null): string | undefined {
  if (!overview) return undefined;
  const assetAnswer = buildLocalAssetAnswer(message, overview);
  if (assetAnswer) return assetAnswer;
  const characterAnswer = buildLocalCharacterAnswer(message, overview);
  if (characterAnswer) return characterAnswer;
  const locationAnswer = buildLocalLocationAnswer(message, overview);
  if (locationAnswer) return locationAnswer;
  if (/写作规则|文风|禁止|不要/u.test(message)) {
    const rules = [
      overview.writingRules?.narrativePerspective ? `叙事视角：${overview.writingRules.narrativePerspective}` : undefined,
      overview.writingRules?.proseStyle?.length ? `文风：${overview.writingRules.proseStyle.join("、")}` : undefined,
      overview.writingRules?.doNotDo?.length ? `禁止事项：${overview.writingRules.doNotDo.join("；")}` : undefined,
    ].filter(Boolean);
    return rules.length ? `当前写作规则：\n${rules.map((item) => `- ${item}`).join("\n")}` : "当前还没有可用的写作规则记录。";
  }
  return undefined;
}

function buildLocalAssetAnswer(message: string, overview: StateOverview): string | undefined {
  if (!/(资产|道具|物品|卡|权限|钥匙|手机|文件|在哪|能做什么|可用|随身)/u.test(message)) return undefined;
  const assets = overview.assetSummary?.assetItems ?? [];
  const asset = assets.find((item) => message.includes(item.name))
    ?? assets.find((item) => item.name.split(/[：:·，,、\s]/u).some((part) => part.length >= 2 && message.includes(part)));
  if (!asset) return undefined;
  const lines = [
    `位置：${asset.currentLocation ?? (asset.carriedBy ? "随身" : "未记录")}`,
    asset.owner ? `归属：${asset.owner}` : undefined,
    asset.carriedBy ? `携带者：${asset.carriedBy}` : undefined,
    `状态：${asset.status}`,
    asset.usageRules.length ? `用途：${asset.usageRules.join("；")}` : undefined,
    asset.rules.length ? `规则：${asset.rules.join("；")}` : undefined,
    asset.lossRules.length ? `遗失规则：${asset.lossRules.join("；")}` : undefined,
  ].filter(Boolean);
  return `${asset.name} 已登记在当前资产资料中。\n${lines.map((item) => `- ${item}`).join("\n")}`;
}

function buildLocalCharacterAnswer(message: string, overview: StateOverview): string | undefined {
  if (!/(角色|人物|是谁|设定|身份|目标|弱点|欲望|说话)/u.test(message)) return undefined;
  const characters = overview.characterMatrix?.characters ?? [];
  const character = characters.find((item) => message.includes(item.name));
  if (!character) return undefined;
  const lines = [
    character.identity ? `身份：${character.identity}` : undefined,
    character.role ? `定位：${character.role}` : undefined,
    character.age ? `年龄：${character.age}` : undefined,
    character.currentLocation ? `当前位置：${character.currentLocation}` : undefined,
    character.currentGoal ? `当前目标：${character.currentGoal}` : undefined,
    character.desire ? `欲望：${character.desire}` : undefined,
    character.weakness ? `弱点：${character.weakness}` : undefined,
    character.speechStyle ? `说话风格：${character.speechStyle}` : undefined,
  ].filter(Boolean);
  return `${character.name} 的当前资料：\n${lines.map((item) => `- ${item}`).join("\n")}`;
}

function buildLocalLocationAnswer(message: string, overview: StateOverview): string | undefined {
  if (!/(地点|位置|场景|楼|房间|在哪|风险|资源)/u.test(message)) return undefined;
  const locations = overview.locationDetailSummary?.locations ?? [];
  const location = locations.find((item) => message.includes(item.name));
  if (!location) return undefined;
  const lines = [
    `类型：${location.type}`,
    location.parentLocation ? `上级地点：${location.parentLocation}` : undefined,
    location.narrativeFunction ? `叙事功能：${location.narrativeFunction}` : undefined,
    location.sensory.length ? `感官锚点：${location.sensory.join("；")}` : undefined,
    location.possibleConflicts.length ? `风险/冲突：${location.possibleConflicts.join("；")}` : undefined,
  ].filter(Boolean);
  return `${location.name} 的当前地点资料：\n${lines.map((item) => `- ${item}`).join("\n")}`;
}

function pendingFoundationCopyForSuggestions(suggestions: readonly FoundationGapSuggestion[]): string {
  const hasCharacterSuggestion = suggestions.some((suggestion) => suggestion.category === "characters" || suggestion.category === "characterRelationships");
  return hasCharacterSuggestion ? "已生成角色资料建议，等待确认写入。" : "已生成基础资料建议，等待确认写入。";
}

function lastSentenceReplacementFromInstruction(instruction: string): string | null {
  const match = instruction.trim().match(
    /最后一句(?:话)?(?:改成|改为|换成|改写成)[：:\s「“"']*(.+?)[」”"']*(?:[，,。；;\s]*(?:其他|其余|其它).*?(?:不要动|不动|保持不变))?$/u,
  );
  const replacement = match?.[1]?.trim()
    .replace(/[，,。；;\s]*(?:其他|其余|其它).*?(?:不要动|不动|保持不变).*$/u, "")
    .replace(/[」”"']$/u, "")
    .trim();
  if (!replacement) return null;
  return /[。！？.!?]$/u.test(replacement) ? replacement : `${replacement}。`;
}

function replaceLastNonEmptyLine(content: string, replacement: string): string {
  const match = content.match(/^([\s\S]*?)([^\n]*\S[^\n]*)(\s*)$/u);
  if (!match) return replacement;
  return `${match[1] ?? ""}${replacement}${match[3] ?? ""}`;
}

function stripPseudoToolCallsForDisplay(value: string): string {
  return value
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/giu, "")
    .replace(/<function=[^>]+>[\s\S]*?<\/function>/giu, "")
    .replace(/<parameter=[^>]+>[\s\S]*?<\/parameter>/giu, "")
    .trim();
}


/* ------------------------------------------------------------------ */
/*  useChat hook                                                        */
/* ------------------------------------------------------------------ */

export interface UseChatParams {
  projectPath: string | null;
  resolveChapterDirection: (value?: unknown) => string;
  handleGenerateDraft: (
    chapterGoalOverride?: string,
    options?: { errorTarget?: "chat" | "steering"; progressMessageId?: string; fallbackGoalWhenEmpty?: string },
  ) => Promise<void>;
  handleQualityCheck: () => Promise<void>;
  handleDraftAIReview: () => Promise<void>;
  handleGenerateRevisionPreview: () => Promise<void>;
  handleApplyRevisionPreview: () => Promise<void>;
  handleCommitPreview: () => Promise<void>;
  handleCommitApply: () => void;
  handleGenerateSteering: (directionOverride?: unknown) => Promise<void>;
  handleContinueNextChapter: () => Promise<void>;
  handleCreateRevisionTask: (source: { issue?: any; suggestion?: any }) => void;
  handleFoundationGapChat?: (input: {
    readonly userMessage: string;
    readonly currentDraft?: FoundationGapSuggestion | null;
    readonly currentIntent?: string | null;
    readonly selectedCategory?: string | null;
    readonly chatHistory?: readonly { readonly role: "assistant" | "user"; readonly content: string }[];
    readonly currentDraftContent?: string | null;
    readonly directArchive?: boolean;
  }) => Promise<FoundationGapChatResult>;
  handleApplyFoundationGapSuggestionsFromChat?: (suggestionIds?: readonly string[]) => Promise<{ readonly plan: FoundationGapApplyPlan; readonly writes: readonly FoundationGapAppliedWrite[]; readonly skippedWrites: readonly FoundationGapSkippedWrite[]; readonly undo?: { readonly undoId: string; readonly changedFiles: readonly string[] } } | null>;
  handleRollbackFoundationGapApplyFromChat?: (undoId: string) => Promise<boolean>;
  applyOverviewToWorkspace: (
    overview: StateOverview,
    draftContent?: string,
    flowStatus?: ChapterWorkflowState,
    draftTitle?: string,
    // 写类工具回传的「本次实际操作章号」——前端认领以推进当前章，修跨章草稿污染。
    targetChapter?: number,
  ) => void;
  /**
   * 资料类刷新：仅按 StateOverview 重建资料/侧栏面板，保留当前章节/草稿/消息。
   * agent 的 foundation_write 结果（refreshScope:"foundation"）调它；可不传。
   */
  refreshWorkspaceFromOverview?: (overview: StateOverview) => void;
  /** 把当前草稿直接持久化（写 drafts/fast 草稿文件 + 工作区快照）。 */
  saveDraftChanges?: () => Promise<void>;
}

export interface UseChatResult {
  handleSendMessage: (message: string) => Promise<void>;
  handleSelectAdviceCard: (key: string, card: ChapterAdviceCard) => void;
  handleSuggestedAction: (action: SuggestedAction) => void;
  /** 块级「撤销到此」：把该回合 git 改动整块回退 + 截断该回合及其后对话 + 重拉 overview 刷工作台。 */
  undoToTurn: (message: ChapterMessage) => Promise<void>;
  /** M3：停止当前在跑的 agent 流（中止 SSE）；已写出内容保留、不报错。无在跑流时调用是 no-op。 */
  stopAgent: () => void;
}

export function useChat(params: UseChatParams): UseChatResult {
  const {
    projectPath,
    resolveChapterDirection,
    handleGenerateDraft,
    handleQualityCheck,
    handleDraftAIReview,
    handleGenerateRevisionPreview,
    handleApplyRevisionPreview,
    handleCommitPreview,
    handleCommitApply,
    handleGenerateSteering,
    handleContinueNextChapter,
    handleCreateRevisionTask,
    handleFoundationGapChat,
    handleApplyFoundationGapSuggestionsFromChat,
    handleRollbackFoundationGapApplyFromChat,
    applyOverviewToWorkspace,
    refreshWorkspaceFromOverview,
    saveDraftChanges,
  } = params;

  /* ---- store access ---- */
  const workspace = useWorkspaceStore((s) => s.workspace);
  const setWorkspace = useWorkspaceStore((s) => s.setWorkspace);
  const appendMessage = useWorkspaceStore((s) => s.appendMessage);
  const updateMessage = useWorkspaceStore((s) => s.updateMessage);
  const steeringDirection = useWorkspaceStore((s) => s.steeringDirection);
  const chatLoading = useWorkspaceStore((s) => s.chatLoading);
  const setChatLoading = useWorkspaceStore((s) => s.setChatLoading);
  const setChatError = useWorkspaceStore((s) => s.setChatError);
  const pendingDirectEditInstruction = useWorkspaceStore((s) => s.pendingDirectEditInstruction);
  const setPendingDirectEditInstruction = useWorkspaceStore((s) => s.setPendingDirectEditInstruction);
  const selectedAdviceCards = useWorkspaceStore((s) => s.selectedAdviceCards);
  const setSelectedAdviceCards = useWorkspaceStore((s) => s.setSelectedAdviceCards);
  const commitPreviewReport = useWorkspaceStore((s) => s.commitPreviewReport);
  const activeRevisionTask = useWorkspaceStore((s) => s.activeRevisionTask);
  const currentOverview = useWorkspaceStore((s) => s.currentOverview);

  const showToast = useNavigationStore((s) => s.showToast);
  const autoRenameRequestSeqRef = useRef(0);

  /* ---- internal helpers ---- */

  const updateAgentCard = useCallback(
    (cardId: string | undefined, patch: Partial<ChapterAgentCard>) => {
      if (!cardId) return;
      const message = useWorkspaceStore.getState().workspace.messages.find((item) =>
        item.agentCards?.some((card) => card.id === cardId),
      );
      if (!message) return;
      updateMessage(message.id, (current) => ({
        ...current,
        agentCards: current.agentCards?.map((card) => (
          card.id === cardId ? mergeAgentCardPatch(card, patch) : card
        )),
      }));
    },
    [updateMessage],
  );

  const updateAgentCardHostMessage = useCallback(
    (
      cardId: string | undefined,
      content: string,
      cardPatch: Partial<ChapterAgentCard>,
      messagePatch?: Partial<Pick<ChapterMessage, "suggestedActions" | "toolOutput">>,
    ): boolean => {
      if (!cardId) return false;
      const message = useWorkspaceStore.getState().workspace.messages.find((item) =>
        item.agentCards?.some((card) => card.id === cardId),
      );
      if (!message) return false;
      updateMessage(message.id, (current) => ({
        ...current,
        ...messagePatch,
        content,
        agentCards: current.agentCards?.map((card) => (
          card.id === cardId ? mergeAgentCardPatch(card, cardPatch) : card
        )),
      }));
      return true;
    },
    [updateMessage],
  );

  const ensureDraftEditAgentCard = useCallback(
    (messageId: string): string => {
      const existing = useWorkspaceStore.getState().workspace.messages
        .find((item) => item.id === messageId)
        ?.agentCards?.[0]?.id;
      if (existing) return existing;

      const cardId = `agent-draft-edit-${Date.now()}`;
      updateMessage(messageId, (current) => ({
        ...current,
        content: "正在按你的要求修改左侧工作稿。",
        agentCards: [{
          id: cardId,
          kind: "draft",
          agentName: "draftEditAgent",
          status: "running",
          title: "正在直接修改草稿",
          summary: "正在按用户要求修改左侧工作稿。",
          detail: [
            "target: 左侧工作稿",
            "write: 草稿改动将自动保存",
            "formal state: 不改正式故事",
          ],
        }],
      }));
      return cardId;
    },
    [updateMessage],
  );

  /**
   * 直接改稿时没有流式宿主消息，这里新建一条带 draft-edit 卡片的助手消息，
   * 返回卡片 id 供 directEditWorkingDraft 把进度/结果渲染进同一张卡片（而非散成独立消息）。
   */
  const createDraftEditHostCard = useCallback((): string => {
    const messageId = `assistant-draft-edit-host-${Date.now()}`;
    const cardId = `agent-draft-edit-${Date.now()}`;
    appendMessage({
      id: messageId,
      role: "assistant",
      content: "正在按你的要求修改左侧工作稿。",
      agentCards: [{
        id: cardId,
        kind: "draft",
        agentName: "draftEditAgent",
        status: "running",
        title: "正在直接修改草稿",
        summary: "正在按用户要求修改左侧工作稿。",
        detail: [
          "target: 左侧工作稿",
          "write: 草稿改动将自动保存",
          "formal state: 不改正式故事",
        ],
      }],
    });
    return cardId;
  }, [appendMessage]);

  const directEditWorkingDraft = useCallback(
    async (instruction: string, agentCardId?: string): Promise<void> => {
      const current = useWorkspaceStore.getState();
      const draft = current.workspace.draft;
      if (!projectPath) {
        setChatError("请先打开真实本地项目。");
        return;
      }
      if (isClearDraftRequest(instruction) && !draft.content.trim()) {
        appendMessage({
          id: `assistant-direct-clear-empty-${Date.now()}`,
          role: "assistant",
          content: "左侧工作稿已经是空的。",
        });
        return;
      }
      if (!draft.content.trim()) {
        appendMessage({
          id: `assistant-direct-edit-empty-${Date.now()}`,
          role: "assistant",
          content: "当前草稿为空，不能直接修改。你可以先让我生成草稿。",
          suggestedActions: [suggestedAction("generate-draft")],
        });
        return;
      }
      if (useNavigationStore.getState().projectPath !== projectPath) return;
      const operation = beginWorkspaceOperation("direct-edit", {
        projectPath,
        chapter: current.workspace.currentChapter.chapterNumber,
        sessionId: current.activeSessionId,
      });
      if (!operation) {
        showToast("已有操作正在进行，请等它结束后再修改草稿。", 4200);
        return;
      }
      const ownsDirectEditTarget = (): boolean => {
        const live = useWorkspaceStore.getState();
        return isWorkspaceOperationTargetCurrent(operation, {
          projectPath: useNavigationStore.getState().projectPath ?? "",
          chapter: live.workspace.currentChapter.chapterNumber,
          sessionId: live.activeSessionId,
        });
      };
      const finishDirectEdit = (): void => {
        if (!isWorkspaceOperationCurrent(operation)) return;
        finishWorkspaceOperation(operation);
      };
      updateAgentCard(agentCardId, {
        status: "running",
        title: "正在直接修改草稿",
        summary: "正在按用户要求修改左侧工作稿。",
      });
      const completeDraftEdit = (
        fallbackMessageId: string,
        content: string,
        toolOutput: readonly string[],
        card: ChapterAgentCard,
      ) => {
        const updatedExistingCard = updateAgentCardHostMessage(agentCardId, content, {
          ...card,
          id: agentCardId ?? card.id,
        }, { toolOutput });
        if (!updatedExistingCard) {
          appendMessage({
            id: fallbackMessageId,
            role: "assistant",
            content,
            toolOutput,
            agentCards: [card],
          });
        }
      };
      const lastSentenceReplacement = lastSentenceReplacementFromInstruction(instruction);
      if (lastSentenceReplacement) {
        try {
          const nextContent = replaceLastNonEmptyLine(draft.content, lastSentenceReplacement);
          current.setWorkspace({
            ...current.workspace,
            flowStatus: "draft_ready",
            draft: {
              ...draft,
              content: nextContent,
              wordCount: countTextWords(nextContent),
              status: "draft",
            },
          });
          completeDraftEdit(
            `assistant-direct-last-sentence-${Date.now()}`,
            `已把最后一句改成「${lastSentenceReplacement}」，并自动保存到草稿。不满意可以在操作历史中恢复快照。`,
            ["draftEditAgent: 已执行本地精确改句", `change: 最后一句 -> ${lastSentenceReplacement}`, "safety: 已自动保存草稿，未写正式状态"],
            {
              id: `direct-last-sentence-success-${Date.now()}`,
              kind: "draft",
              agentName: "draftEditAgent",
              status: "completed",
              title: "草稿已直接修改",
              summary: "已按用户要求修改左侧工作稿，并自动保存。",
              detail: [`change: 最后一句 -> ${lastSentenceReplacement}`, "target: 左侧工作稿", "write: 草稿改动已自动保存"],
            },
          );
          await saveDraftChanges?.();
        } finally {
          finishDirectEdit();
        }
        return;
      }
      if (isClearDraftRequest(instruction)) {
        try {
          current.setWorkspace({
            ...current.workspace,
            flowStatus: "draft_ready",
            draft: { ...draft, content: "", wordCount: 0, status: "draft" },
          });
          completeDraftEdit(
            `assistant-direct-clear-${Date.now()}`,
            "已清空左侧当前编辑区。为防误删，本次不会用空内容覆盖磁盘草稿；刷新后仍可恢复原稿。",
            ["draftEditAgent: 已直接清空工作稿", "change: 当前草稿内容已置空", "safety: 空内容未覆盖磁盘草稿，未写正式状态"],
            {
              id: `direct-clear-success-${Date.now()}`,
              kind: "draft",
              agentName: "draftEditAgent",
              status: "completed",
              title: "草稿已直接修改",
              summary: "已清空当前编辑区；磁盘草稿保留。",
              detail: ["target: 左侧工作稿", "write: 未以空内容覆盖磁盘草稿"],
            },
          );
          await saveDraftChanges?.();
        } finally {
          finishDirectEdit();
        }
        return;
      }
      current.setDraftActionLoading("direct-edit");
      try {
        const result = await directEditDraft({
          projectPath,
          chapter: operation.chapter,
          instruction,
          draftContent: draft.content,
        });
        if (!ownsDirectEditTarget()) {
          useNavigationStore.getState().showToast("原工作区已经变化，已丢弃迟到的改稿结果。", 5000);
          return;
        }
        const nextStore = useWorkspaceStore.getState();
        nextStore.setWorkspace({
          ...nextStore.workspace,
          flowStatus: "draft_ready",
          draft: {
            ...nextStore.workspace.draft,
            title: extractDraftTitle(result.draftContent) ?? nextStore.workspace.draft.title,
            content: result.draftContent,
            wordCount: countTextWords(result.draftContent),
            status: "draft",
          },
        });
        completeDraftEdit(
          `assistant-direct-edit-${Date.now()}`,
          `${result.reply} 改动已自动保存到草稿，不满意可以在操作历史中恢复快照。`,
          [
            "draftEditAgent: 已调用 repair 模型直接修改工作稿",
            `model profile: ${result.profileId ?? "unknown"} / ${result.model ?? "unknown"}`,
            `change: ${result.changeSummary}`,
            "safety: 已自动保存草稿，未写正式状态",
          ],
          {
            id: `direct-edit-success-${Date.now()}`,
            kind: "draft",
            agentName: "draftEditAgent",
            status: "completed",
            title: "草稿已直接修改",
            summary: "已按用户要求修改左侧工作稿，并自动保存。",
            detail: [
              `change: ${result.changeSummary}`,
              "target: 左侧工作稿",
              "write: 草稿改动已自动保存",
            ],
          },
        );
        await saveDraftChanges?.();
      } catch (error) {
        if (!ownsDirectEditTarget()) return;
        updateAgentCard(agentCardId, {
          status: "failed",
          title: "草稿修改失败",
          summary: error instanceof Error ? error.message : String(error),
        });
        setChatError(error instanceof Error ? error.message : String(error));
      } finally {
        if (isWorkspaceOperationCurrent(operation)) {
          if (ownsDirectEditTarget()) useWorkspaceStore.getState().setDraftActionLoading(null);
          finishWorkspaceOperation(operation);
        }
      }
    },
    [appendMessage, projectPath, saveDraftChanges, setChatError, showToast, updateAgentCard, updateAgentCardHostMessage],
  );

  const runFoundationAgentFromChat = useCallback(
    async (
      sourceText: string,
      chatHistory?: readonly { readonly role: "assistant" | "user"; readonly content: string }[],
      linkedAgentCardId?: string,
      options?: { readonly directArchive?: boolean },
    ): Promise<boolean> => {
      if (!handleFoundationGapChat) {
        appendMessage({
          id: `assistant-foundation-guard-${Date.now()}`,
          role: "assistant",
          content: "当前工作台没有接上资料补全工具，暂时不能检查或补资料。",
        });
        return true;
      }
      if (!projectPath) {
        appendMessage({
          id: `assistant-foundation-project-guard-${Date.now()}`,
          role: "assistant",
          content: "请先打开真实本地项目，再检查或补全资料。",
        });
        return true;
      }
      if (useNavigationStore.getState().projectPath !== projectPath) return true;
      const initial = useWorkspaceStore.getState();
      const operation = beginWorkspaceOperation("foundation-write", {
        projectPath,
        chapter: initial.workspace.currentChapter.chapterNumber,
        sessionId: initial.activeSessionId,
      });
      if (!operation) {
        showToast("已有操作正在进行，请等它结束后再处理资料。", 4200);
        return true;
      }
      const ownsFoundationTarget = (): boolean => {
        const live = useWorkspaceStore.getState();
        return isWorkspaceOperationTargetCurrent(operation, {
          projectPath: useNavigationStore.getState().projectPath ?? "",
          chapter: live.workspace.currentChapter.chapterNumber,
          sessionId: live.activeSessionId,
        });
      };
      const messageId = `assistant-foundation-agent-${Date.now()}`;
      const runningCard: ChapterAgentCard = {
        id: `${messageId}-card`,
        kind: "foundation",
        agentName: "foundationAgent",
        status: "running",
        title: "检查资料工作区",
        summary: "正在读取当前书籍资料、缺口报告和上下文。",
        detail: [
          "范围：仅当前书籍工作区",
          "读取：故事资料、世界资料、角色资料",
        ],
      };
      if (linkedAgentCardId) {
        updateAgentCard(linkedAgentCardId, {
          status: "running",
          title: "正在调用资料 Agent",
          summary: "正在判断是否能生成待确认的资料修改。",
          detail: [
            "scope: 当前书籍工作区",
            "agent: foundationAgent",
            "写入状态：未写入任何文件",
            "下一步：生成预览后才可确认",
          ],
        });
      }
      if (!linkedAgentCardId) {
        appendMessage({
          id: messageId,
          role: "assistant",
          content: "正在检查当前书籍工作区资料。",
          agentCards: [runningCard],
        });
      }
      const updateFoundationMessage = (
        content: string,
        cardPatch: Partial<ChapterAgentCard>,
        suggestedActions: readonly SuggestedAction[] = [],
      ) => {
        if (linkedAgentCardId) {
          // Don't overwrite the orchestrator's original reply content.
          // Progress/status belongs in the agent card (summary/title/detail).
          updateAgentCardHostMessage(linkedAgentCardId, content, cardPatch, { suggestedActions });
          return;
        }
        updateMessage(messageId, (current) => ({
          ...current,
          content,
          agentCards: [{
            ...runningCard,
            ...cardPatch,
          }],
          suggestedActions,
        }));
      };
      // Variant that preserves the orchestrator's original reply content when linkedAgentCardId is set.
      const updateFoundationProgressPreservingReply = (
        content: string,
        cardPatch: Partial<ChapterAgentCard>,
        suggestedActions: readonly SuggestedAction[] = [],
      ) => {
        if (linkedAgentCardId) {
          const message = useWorkspaceStore.getState().workspace.messages.find((item) =>
            item.agentCards?.some((card) => card.id === linkedAgentCardId),
          );
          if (message) {
            updateMessage(message.id, (current) => ({
              ...current,
              suggestedActions: suggestedActions.length > 0 ? suggestedActions : current.suggestedActions,
              agentCards: current.agentCards?.map((card) => (
                card.id === linkedAgentCardId ? mergeAgentCardPatch(card, cardPatch) : card
              )),
            }));
          }
          return;
        }
        updateFoundationMessage(content, cardPatch, suggestedActions);
      };
      setChatLoading(true);
      setChatError(null);
      try {
        const foundationResult = await handleFoundationGapChat({
          userMessage: sourceText,
          chatHistory,
          currentDraftContent: useWorkspaceStore.getState().workspace.draft.content,
          ...(options?.directArchive ? { directArchive: true } : {}),
        });
        if (!ownsFoundationTarget()) return true;
        const allSuggestions = uniqueFoundationSuggestions([
          ...(foundationResult.draftSuggestion ? [foundationResult.draftSuggestion] : []),
          ...foundationResult.generatedSuggestions,
        ]);
        const suggestionCount = allSuggestions.length;
        const suggestionSummary = allSuggestions.map(foundationSuggestionLabel);
        const uniqueCategories = new Set(allSuggestions.map((suggestion) => suggestion.category));
        const onlyCharacters = uniqueCategories.size === 1 && uniqueCategories.has("characters");
        const noExecutableFoundationChange = suggestionCount === 0 && isExplicitFoundationWriteRequest(sourceText);
        const noExecutableFeedback = noExecutableFoundationChange
          ? buildNoExecutableFoundationChangeFeedback(sourceText)
          : null;
        if (
          suggestionCount > 0
          && handleApplyFoundationGapSuggestionsFromChat
          // 资料归档默认直接写：Agent 一旦生成可执行写入建议就直写+回报，
          // 不再落到「资料草案待确认」的 accept-foundation-suggestions 中间态。
          // directArchive 下还会接受 draftSuggestion（问题 B）；交互模式不放宽。
          && shouldDirectArchiveFromChat({
            directArchive: Boolean(options?.directArchive),
            sourceText,
            allSuggestions,
            generatedSuggestions: foundationResult.generatedSuggestions,
          })
        ) {
          updateFoundationProgressPreservingReply(
            "正在修改资料。",
            {
              status: "running",
              title: "正在修改",
              summary: "我会直接完成这次修改，完成后可以撤回。",
              detail: [
                ...suggestionSummary.map((line) => `· ${line}`),
                "scope: 当前书籍工作区",
              ],
            },
          );
          const result = await handleApplyFoundationGapSuggestionsFromChat(allSuggestions.map((suggestion) => suggestion.id));
          if (!ownsFoundationTarget()) return true;
          const deleteConfirmConflicts = foundationDeleteConfirmationConflicts(result?.plan ?? null);
          if (result && (result.writes?.length ?? 0) === 0 && deleteConfirmConflicts.length > 0) {
            const confirmIds = deleteConfirmConflicts
              .map((conflict) => conflict.id.replace(/:write-risk$/u, ""))
              .filter(Boolean);
            updateFoundationProgressPreservingReply(
              foundationDeleteConfirmText(deleteConfirmConflicts),
              {
                status: "needs_confirmation",
                title: "删除需要确认",
                summary: "目标在正文中出现过，需要你确认后才会删除。",
                detail: [
                  ...suggestionSummary.map((line) => `· ${line}`),
                  "scope: 当前书籍工作区",
                  "写入状态：未写入任何文件",
                ],
              },
              [{
                id: "confirm-foundation-delete",
                label: "确认删除",
                description: "确认后立即删除，完成后仍可撤回。",
                permission: "project_config_write",
                requiresConfirmation: true,
                endpoint: confirmIds.join(","),
              }],
            );
            return true;
          }
          const deleteBlockedText = foundationDeleteBlockedText(result?.plan ?? null);
          if (result && (result.writes?.length ?? 0) === 0 && deleteBlockedText) {
            updateFoundationProgressPreservingReply(
              deleteBlockedText,
              {
                status: "blocked",
                title: "未删除",
                summary: deleteBlockedText,
                detail: [
                  ...suggestionSummary.map((line) => `· ${line}`),
                  "scope: 当前书籍工作区",
                  "写入状态：未写入任何文件",
                ],
              },
            );
            return true;
          }
          const resultText = foundationApplyResultText(result?.plan ?? null, result?.writes ?? [], result?.skippedWrites ?? []);
          // 修3：诚实判定看真实写入，不只看 plan 是否存在。
          // 一个字没写（writes 为空）时：报「未修改/failed」、不挂假撤销按钮（哪怕服务端因 plan.fileChanges
          // 非空算出了占位 undo），detail 里也不暴露 undo。
          const didWrite = (result?.writes?.length ?? 0) > 0;
          const undoActions = didWrite && result?.undo ? [buildUndoFoundationWriteAction(result.undo.undoId)] : [];
          updateFoundationProgressPreservingReply(
            resultText,
            {
              status: didWrite ? "completed" : "failed",
              title: didWrite ? "已修改" : "未修改",
              summary: didWrite ? "资料已更新。" : resultText,
              detail: [
                ...suggestionSummary.map((line) => `· ${line}`),
                "scope: 当前书籍工作区",
                didWrite ? "写入状态：已写入" : "写入状态：未写入任何文件",
                ...(didWrite && result?.undo ? [`undo: ${result.undo.undoId}`] : []),
              ],
            },
            undoActions,
          );
          return true;
        }
        const cardTitle = noExecutableFeedback?.title ?? (suggestionCount > 0 && onlyCharacters
          ? "角色草案待确认"
          : suggestionCount > 0
            ? "资料草案待确认"
            : "资料检查完成");
        const summaryText = noExecutableFeedback?.summary ?? (suggestionCount > 0
          ? `${pendingFoundationCopyForSuggestions(allSuggestions)} 尚未进入左侧资料区。`
          : "资料检查完成，当前没有需要写入的补全建议。");
        const updateNoExecutableOrProgress = noExecutableFeedback ? updateFoundationMessage : updateFoundationProgressPreservingReply;
        updateNoExecutableOrProgress(
          suggestionCount > 0 && !noExecutableFeedback
            ? `${summaryText}\n\n${foundationSuggestionPreviewText(allSuggestions)}`
            : summaryText,
          {
            status: noExecutableFoundationChange ? "blocked" : suggestionCount > 0 ? "needs_confirmation" : "completed",
            title: cardTitle,
            summary: summaryText,
            detail: noExecutableFeedback?.detail ?? [
              ...suggestionSummary.map((line) => `· ${line}`),
              "scope: 当前书籍工作区",
              ...(suggestionCount > 0
                ? [
                    "status: pending / suggested，等待用户确认",
                    "targetStore: foundation_suggestion / agent_card / chat",
                    "leftPanelVisible: false，未提交到 committed character files 前不会出现在左侧资料区",
                  ]
                : ["write: 无需写入"]),
            ],
          },
          suggestionCount > 0
            ? [{
                id: "accept-foundation-suggestions",
                label: "确认写入资料",
                description: "确认后才会写入对应资料文件；当前仍是待确认建议",
                permission: "project_config_write",
                requiresConfirmation: true,
                endpoint: allSuggestions.map((suggestion) => suggestion.id).join(","),
              }]
            : [],
        );
        return true;
      } catch (error) {
        if (!ownsFoundationTarget()) return true;
        const message = error instanceof Error ? error.message : String(error);
        setChatError(message);
        updateFoundationProgressPreservingReply(
          `资料 Agent 失败：${message}`,
          {
            status: "failed",
            title: "资料检查失败",
            summary: message,
            detail: [
              "scope: 当前书籍工作区",
              "agent: foundationAgent",
              "write: 未写入",
            ],
          },
        );
        return true;
      } finally {
        if (isWorkspaceOperationCurrent(operation)) {
          if (ownsFoundationTarget()) setChatLoading(false);
          finishWorkspaceOperation(operation);
        }
      }
    },
    [appendMessage, handleApplyFoundationGapSuggestionsFromChat, handleFoundationGapChat, projectPath, setChatError, setChatLoading, showToast, updateAgentCard, updateAgentCardHostMessage, updateMessage],
  );

  /**
   * agent 大脑总入口：右侧对话是唯一驱动面——直接把对话交给
   * Mastra 写作总控 agent，它自行决定读状态 / 写资料，全程经 SSE 增量回流。
   *
   * 流程：
   *   - 起一条空 assistant 消息，把 agent 事件经 agentEventProjection 增量投影进同一条消息。
   *   - text-delta 累加文本；tool-call/tool-result 投影成 toolSteps + agentCards（命中时间线字典）。
   *   - onToolResult 按 refreshScope 刷新工作台：full → applyOverviewToWorkspace；
   *     foundation → refreshWorkspaceFromOverview（仅刷资料面板，保留章节/草稿/消息）。
   *   - onError 绝不静默失败：追加一条可重试的 assistant 消息（retry-agent，携带原始消息）。
   * 被 handleSendMessage 和「重试」按钮共用。
   */
  // M3：当前在跑的 agent 流的中止器，供「停止」按钮调用；每轮开始时置入、收尾清空。
  const agentAbortRef = useRef<AbortController | null>(null);
  const stopAgent = useCallback(() => {
    agentAbortRef.current?.abort();
  }, []);

  const runAgentDispatch = useCallback(
    async (
      text: string,
      conversation: readonly { readonly role: "user" | "assistant"; readonly content: string }[],
    ): Promise<void> => {
      if (!projectPath) {
        setChatError("请先打开真实本地项目。");
        return;
      }
      if (useNavigationStore.getState().projectPath !== projectPath) {
        showToast("当前项目已经变化，不能启动旧工作区请求。", 4200);
        return;
      }

      const initialStore = useWorkspaceStore.getState();
      const claimedOperation = beginWorkspaceOperation("agent-chat", {
        projectPath,
        chapter: initialStore.workspace.currentChapter.chapterNumber,
        sessionId: initialStore.activeSessionId,
      });
      if (!claimedOperation) {
        showToast("已有写作操作正在进行，请等它结束后再发送新请求。", 4200);
        return;
      }
      let operation = claimedOperation;
      const ownsCurrentWorkspace = (): boolean => {
        const current = useWorkspaceStore.getState();
        return isWorkspaceOperationTargetCurrent(operation, {
          projectPath: useNavigationStore.getState().projectPath ?? "",
          chapter: current.workspace.currentChapter.chapterNumber,
          sessionId: current.activeSessionId,
        });
      };
      const notifyStaleOperation = (): void => {
        useNavigationStore.getState().showToast("原工作区已经变化，已丢弃迟到的 AI 结果。", 5000);
      };

      const assistantMsgId = `assistant-agent-${Date.now()}`;
      appendMessage(emptyAssistantMessage(assistantMsgId));
      // 回合起点打点：意图标题（=用户原话压一行）+ 回合开始墙钟。块头由此渲染。
      updateMessage(assistantMsgId, (current) => ({
        ...current,
        intentTitle: deriveIntentTitle(text),
        turnStartedAt: Date.now(),
      }));

      const project = (event: AgentProjectionEvent) => {
        if (!ownsCurrentWorkspace()) return;
        updateMessage(assistantMsgId, (current) => projectAgentEvent(current, event));
      };

      // 把 tool-call 与 tool-result 关联起来：优先用后端 toolCallId；缺省时退回「同名工具的最近一次合成 id」。
      const toolCallIds = new Map<string, string>();
      const stepIdFor = (toolName: string, toolCallId?: string): string => {
        const id = toolCallId ?? toolCallIds.get(toolName) ?? `${toolName}-${Date.now()}`;
        toolCallIds.set(toolName, id);
        return id;
      };

      setChatLoading(true);
      setChatError(null);

      let sawError = false;
      // 出稿流式缓冲：generate_draft 的正文 delta 逐字累加到这里、灌进当前章编辑器；
      // 每次出稿（generate_draft tool-call）重置；完成时 onToolResult 用引擎处理过的终稿落定（覆盖这份原始流）。
      let streamedDraft = "";
      let draftStreamChapter: number | null = null;
      let reportedDraftChapterMismatch = false;
      // 追加一条错误卡消息（isErrorNotice；可重试时带 retry-agent）。tool-error 与 error 共用。
      const appendErrorMessage = (message: string, retryable: boolean) => {
        appendMessage({
          id: `assistant-agent-error-${Date.now()}`,
          role: "assistant",
          content: "AI 服务暂时没响应，本次没有改动。",
          isErrorNotice: true,
          errorDetail: message,
          ...(retryable
            ? {
              suggestedActions: [
                {
                  id: "retry-agent",
                  label: "重试这一步",
                  description: "重新让写作助手处理这条消息",
                  permission: "safe_read" as const,
                  requiresConfirmation: false,
                  endpoint: text,
                },
              ],
            }
            : {}),
        });
      };
      // R2 磁盘对账：SSE 在写类工具 tool-result 之前断流时，客户端只收到 error、看起来失败，但磁盘可能
      // 已入库（commit_apply 真写盘在前、SSE 回执在后）。错误收尾时拉一次磁盘真值，若该章已入库而 UI 没体现，
      // 用完整章节快照恢复正文/标题/文件标记/revision/流程态，而不是只改一个 flowStatus。
      let reconciliationPromise: Promise<void> | null = null;
      let commitReconciliationDraft: string | null = null;
      // A-5：本轮是否出现过章节写类工具调用（generate_draft/revise_draft/commit_apply）——
      // 「停止」收尾时据此决定要不要拉一次磁盘对账（纯读/问答回合不浪费这次 IO）。
      let sawChapterWriteToolCall = false;
      // 磁盘真值读取：5s 超时兜底，绝不让对账把回合收尾卡死（对账尽力而为，失败当没拉到）。
      const fetchChapterSnapshotWithTimeout = async (chapter: number): Promise<ChapterWorkspaceSnapshot | undefined> => {
        if (!projectPath) return undefined;
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const reconciliationAbort = new AbortController();
        return Promise.race([
          fetchChapterWorkspace({ projectPath, chapter }, reconciliationAbort.signal),
          new Promise<undefined>((resolve) => {
            timeoutId = setTimeout(() => {
              reconciliationAbort.abort();
              resolve(undefined);
            }, 5_000);
          }),
        ]).finally(() => {
          if (timeoutId !== undefined) clearTimeout(timeoutId);
        });
      };
      // 据磁盘快照把「其实已入库」的完整章节态恢复进工作区（错误对账与停止对账共用同一恢复动作）。
      const adoptCommittedSnapshot = (snap: ChapterWorkspaceSnapshot, chapter: number): void => {
        const store = useWorkspaceStore.getState();
        const current = store.workspace;
        const draftContent = snap.draftContent ?? current.draft.content;
        const draftTitle = snap.draftTitle ?? current.draft.title;
        const flowStatus = snap.flowStatus ?? "committed";
        store.updateWorkspace({
          flowStatus,
          currentChapter: {
            ...current.currentChapter,
            title: draftTitle,
            hasCommittedChapter: snap.hasCommittedChapter === true,
            hasDraftFile: snap.hasDraftFile === true,
            hasWorkspaceSnapshot: true,
          },
          chapters: current.chapters.map((item) => item.chapterNumber === chapter
            ? {
              ...item,
              title: draftTitle,
              hasCommittedChapter: snap.hasCommittedChapter === true,
              hasDraftFile: snap.hasDraftFile === true,
              hasWorkspaceSnapshot: true,
            }
            : item),
          draft: {
            ...current.draft,
            chapterNumber: chapter,
            title: draftTitle,
            content: draftContent,
            savedContent: draftContent,
            wordCount: draftContent.trim() ? countTextWords(draftContent) : undefined,
            status: flowStatus === "committed" || flowStatus === "ready_for_next" ? "committed" : "draft",
          },
        });
        const revision = snap.revision ?? 0;
        recordWorkspaceRevision(projectPath, chapter, revision);
        store.setWorkspaceRevision(revision);
        appendMessage({
          id: `assistant-reconcile-${Date.now()}`,
          role: "assistant",
          content: `（磁盘核对：第 ${chapter} 章其实已经入库了——上一步可能因网络/连接中断没收到回执、看起来像失败，但磁盘上确已写入。已把状态更正为「已入库」。）`,
        });
      };
      const reconcileChapterFromDisk = async (): Promise<void> => {
        try {
          if (!projectPath) return;
          const attemptedDraftContent = commitReconciliationDraft;
          if (attemptedDraftContent === null) return;
          const chapter = operation.chapter;
          if (typeof chapter !== "number") return;
          const snap = await fetchChapterSnapshotWithTimeout(chapter);
          if (!snap) return;
          if (!ownsCurrentWorkspace()) return;
          const flowNow = useWorkspaceStore.getState().workspace.flowStatus;
          if (shouldReconcileCommitAttempt(snap, flowNow, attemptedDraftContent)) {
            adoptCommittedSnapshot(snap, chapter);
          }
        } catch {
          // 对账尽力而为，绝不让它破坏错误收尾路径。
        }
      };
      // A-5 停止对账：写类工具在飞时被「停止」腰斩，SSE 回执丢失，但服务端可能在停止前已写完整稿
      // （generate_draft 落 drafts/fast）或已入库（commit_apply）。拉一次磁盘真值：
      //   ① commit_apply 在飞且盘证一致 → 复用「其实已入库」整体恢复；
      //   ② 盘上草稿比停止那刻编辑器里的更全 → 采用盘稿（停止后用户又动过编辑器则不盖）；
      //   否则保留编辑器里已流出的内容（「已停止 · 已写出的内容保留」）， autosave 随后照常落盘。
      const reconcileAbortedTurnFromDisk = async (): Promise<void> => {
        try {
          if (!projectPath) return;
          const chapter = operation.chapter;
          if (typeof chapter !== "number") return;
          const attemptedDraftContent = commitReconciliationDraft;
          const editorAtStop = useWorkspaceStore.getState().workspace.draft.content;
          const snap = await fetchChapterSnapshotWithTimeout(chapter);
          if (!snap) return;
          if (!ownsCurrentWorkspace()) return;
          const flowNow = useWorkspaceStore.getState().workspace.flowStatus;
          if (attemptedDraftContent !== null && shouldReconcileCommitAttempt(snap, flowNow, attemptedDraftContent)) {
            adoptCommittedSnapshot(snap, chapter);
            return;
          }
          if (!shouldAdoptDiskDraftAfterStop(snap, editorAtStop)) return;
          const live = useWorkspaceStore.getState();
          if (live.workspace.draft.content !== editorAtStop) return;
          const draftContent = snap.draftContent ?? "";
          const draftTitle = snap.draftTitle ?? extractDraftTitle(draftContent) ?? live.workspace.draft.title;
          live.updateWorkspace({ flowStatus: "draft_ready" });
          live.updateDraft({
            chapterNumber: chapter,
            title: draftTitle,
            content: draftContent,
            savedContent: draftContent,
            wordCount: countTextWords(draftContent),
            status: "draft",
          });
          const revision = snap.revision ?? 0;
          recordWorkspaceRevision(projectPath, chapter, revision);
          live.setWorkspaceRevision(revision);
          appendMessage({
            id: `assistant-stop-reconcile-${Date.now()}`,
            role: "assistant",
            content: `（磁盘核对：第 ${chapter} 章的工作稿已按盘上更完整的一版恢复。）`,
          });
        } catch {
          // 对账尽力而为，绝不让它破坏停止收尾路径。
        }
      };
      const requestChapterReconciliation = (): void => {
        if (commitReconciliationDraft === null) return;
        reconciliationPromise ??= reconcileChapterFromDisk();
      };
      // 出稿失败收尾：onToolCall(generate_draft) 把 flowStatus 置「正在生成草稿」，失败路径若不复位，标题区
      // 会卡在「正在生成草稿」=明明失败却谎称在生成（诚实铁律）。同步据「编辑器是否已有草稿内容」复位成
      // draft_ready/idle；「磁盘其实已入库」的特例由上面 reconcileChapterFromDisk 异步再升成 committed。
      const unstickGeneratingFlow = (): void => {
        if (!ownsCurrentWorkspace()) return;
        const ws = useWorkspaceStore.getState();
        const next = flowStatusAfterGenerateFailure(ws.workspace.flowStatus, ws.workspace.draft.content.trim().length > 0);
        if (next) ws.updateWorkspace({ flowStatus: next });
      };
      // M3：本轮的中止器——「停止」按钮 abort 它即可干净停掉这条流（streamAgentChat 据此不报错收尾）。
      const abortController = new AbortController();
      agentAbortRef.current = abortController;
      try {
        // H3：把用户当前所在章一并发给后端，让 agent 默认作用于该章、各工具缺省回退该值（回看旧章不写错章）。
        const currentChapterNumber = useWorkspaceStore.getState().workspace.currentChapter?.chapterNumber;
        await streamAgentChat(
          {
            projectPath,
            messages: [...conversation, { role: "user", content: text }],
            ...(typeof currentChapterNumber === "number" ? { currentChapter: currentChapterNumber } : {}),
          },
          {
            onTextDelta: (delta) => project({ type: "text-delta", text: delta }),
            onReasoningDelta: (delta) => project({ type: "reasoning-delta", text: delta }),
            onToolCall: ({ toolName, toolCallId }) => {
              if (!ownsCurrentWorkspace()) return;
              project({ type: "tool-call", toolCallId: stepIdFor(toolName, toolCallId), toolName, startedAt: Date.now() });
              // A-5：记一笔「本轮有章节写类工具」——「停止」收尾时拉一次磁盘对账（回执可能被腰斩、盘上其实已写）。
              if (toolName === "generate_draft" || toolName === "revise_draft" || toolName === "commit_apply") {
                sawChapterWriteToolCall = true;
              }
              // 出稿/续写一开始就把中间区切到写作台，让用户看着正文出现（而不是默默落进数据层、还停在资料中心）。
              if (toolName === "generate_draft") {
                useNavigationStore.getState().requestCenterView("desk");
                streamedDraft = ""; // 新一次出稿：清空流式缓冲，逐字从头累加。
                draftStreamChapter = null;
                reportedDraftChapterMismatch = false;
                // 出稿一开始就把流程态置「正在生成草稿」，否则续写时标题区会残留上一章的「已入库」误导用户。
                useWorkspaceStore.getState().updateWorkspace({ flowStatus: "draft_generating" });
              } else if (toolName === "revise_draft") {
                // 用户让 AI 改稿：也把中间区切到写作台，改完的正文/高亮就在眼前（和出稿、和体检卡「改掉这句」一致，
                // 别让改动默默落进数据层、用户还停在资料中心以为没反应）。revise 不流式，故不动 streamedDraft/flowStatus。
                useNavigationStore.getState().requestCenterView("desk");
              } else if (toolName === "commit_apply") {
                // Proof anchor for SSE-loss reconciliation. Unrelated tool
                // errors never get permission to replace the editor draft.
                commitReconciliationDraft = useWorkspaceStore.getState().workspace.draft.content;
              }
            },
            onDraftDelta: ({ chapter, text }) => {
              if (!ownsCurrentWorkspace()) return;
              const store = useWorkspaceStore.getState();
              if (draftStreamChapter === null) {
                const previousChapter = operation.chapter;
                const adopted = retargetWorkspaceOperation(operation, { chapter });
                if (!adopted) return;
                operation = adopted;
                draftStreamChapter = chapter;
                if (chapter !== previousChapter) {
                  const cur = store.workspace.currentChapter;
                  store.updateWorkspace({
                    currentChapter: {
                      ...cur,
                      chapterNumber: chapter,
                      status: "current",
                      title: `第${chapter}章`,
                      hasCommittedChapter: false,
                      hasDraftFile: false,
                      hasWorkspaceSnapshot: false,
                    },
                    draft: {
                      ...store.workspace.draft,
                      chapterNumber: chapter,
                      status: "draft",
                      title: `第${chapter}章`,
                      content: "",
                      wordCount: 0,
                    },
                  });
                }
              } else if (chapter !== draftStreamChapter) {
                if (!reportedDraftChapterMismatch) {
                  reportedDraftChapterMismatch = true;
                  useNavigationStore.getState().showToast("收到不同章节的迟到正文片段，已拒绝混入当前草稿。", 5000);
                }
                return;
              }
              streamedDraft += text;
              const wordCount = countTextWords(streamedDraft); // 字数跟着流式长，别残留上一章旧字数。
              store.updateDraft({ content: streamedDraft, wordCount });
            },
            onToolResult: (info) => {
              if (!ownsCurrentWorkspace()) return;
              if (typeof info.chapter === "number" && info.chapter !== operation.chapter) return;
              if (info.toolName === "commit_apply") commitReconciliationDraft = null;
              project({
                type: "tool-result",
                toolCallId: stepIdFor(info.toolName, info.toolCallId),
                toolName: info.toolName,
                endedAt: Date.now(),
                output: info,
              });
              // 去 AI 味体检：报告已随上面 project(output:info) 挂到这条 assistant 消息上（见 agentEventProjection
              // 的 check_ai_flavor 分支），在时间线里随对话渲染体检卡——不再写全局 store（旧挂件会一直钉底部）。
              // A（2026-06-18）：让本章流程状态在纯 agent 流程也走完整生命周期——据刚完成的工具推进 flowStatus，
              // 不再只有 draftBody 的工具才推进（质检/审稿/预览这些只读工具原本走 else 分支保留原状→顶部流程地图半死）。
              // nextFlowAfterToolResult：在推进之上还管「出稿 ok=false（守卫拒绝走 tool-result，不是 tool-error）时
              // 把卡在 draft_generating 的状态据草稿内容复位」——否则标题/输入框卡在「正在生成草稿」谎报（Codex 复测命中）。
              const flowBefore = useWorkspaceStore.getState().workspace.flowStatus;
              const hasDraftContent = useWorkspaceStore.getState().workspace.draft.content.trim().length > 0;
              const nextFlow = nextFlowAfterToolResult(info.toolName, info, flowBefore, hasDraftContent);
              // 按刷新范围更新工作台（保留各自的既有刷新函数，只调用不改它们）。
              if (!info.overview) {
                if (info.toolName === "commit_apply" && info.committed === true && typeof info.draftBody === "string") {
                  const store = useWorkspaceStore.getState();
                  const current = store.workspace;
                  const committedTitle = info.draftTitle ?? current.draft.title;
                  const committedBody = info.draftBody;
                  store.updateWorkspace({
                    flowStatus: "committed",
                    currentChapter: {
                      ...current.currentChapter,
                      chapterNumber: operation.chapter,
                      title: committedTitle,
                      hasCommittedChapter: true,
                      hasDraftFile: true,
                      hasWorkspaceSnapshot: true,
                    },
                    chapters: current.chapters.map((item) => item.chapterNumber === operation.chapter
                      ? { ...item, title: committedTitle, hasCommittedChapter: true, hasDraftFile: true, hasWorkspaceSnapshot: true }
                      : item),
                    draft: {
                      ...current.draft,
                      chapterNumber: operation.chapter,
                      title: committedTitle,
                      content: committedBody,
                      savedContent: committedBody,
                      wordCount: committedBody.trim() ? countTextWords(committedBody) : undefined,
                      status: "committed",
                    },
                  });
                  return;
                }
                // 没带 overview 的工具（如质检/预览只读）也要推进流程状态，否则地图卡在写稿不动。
                if (nextFlow !== flowBefore) useWorkspaceStore.getState().updateWorkspace({ flowStatus: nextFlow });
                return;
              }
              if (info.refreshScope === "full") {
                if (typeof info.draftBody === "string" && info.draftBody.trim()) {
                  // 改草稿/入库工具：把真正文作为 draftContent 载入工作区。
                  // - generate_draft/revise_draft → draft_ready（草稿待保存）。
                  // - commit_apply 成功（committed=true）→ committed（已入库；让 autosave 不再把章节写回 drafts/fast）。
                  // 与老路径 handleGenerateDraft/handleCommitApply 同构——否则只用 overview 刷新会把草稿冲成占位、autosave 抹掉真正文。
                  // 传 info.chapter（工具实际操作的章号）让前端认领权威章：写第2章时推进当前章到2，autosave 才会写 chapter-0002.md 而非覆盖 chapter-0001.md（修跨章污染）。
                  applyOverviewToWorkspace(info.overview, info.draftBody, nextFlow, info.draftTitle, info.chapter);
                } else {
                  // 读类/未带正文的 full 刷新（如 read_state_overview）：回传工作区现有草稿正文，
                  // 绝不让 applyOverviewToWorkspace 用 overview 占位重置草稿（否则 autosave 会把占位写回磁盘抹掉真正文）。
                  const current = useWorkspaceStore.getState().workspace;
                  applyOverviewToWorkspace(info.overview, current.draft.content, nextFlow, current.draft.title);
                }
              } else if (info.refreshScope === "foundation") {
                refreshWorkspaceFromOverview?.(info.overview);
              }
            },
            onToolError: (info) => {
              if (!ownsCurrentWorkspace()) return;
              sawError = true;
              // 先收尾：把对应 running 的步骤/卡片置 failed（复用已测投影逻辑），时间线不再卡转圈。
              project({
                type: "tool-error",
                toolCallId: stepIdFor(info.toolName, info.toolCallId),
                toolName: info.toolName,
                endedAt: Date.now(),
                error: info.message,
              });
              // 再如实回报：追加一条可重试的错误气泡。
              appendErrorMessage(info.message, info.retryable);
              unstickGeneratingFlow();          // 出稿失败：标题区别卡在「正在生成草稿」
              requestChapterReconciliation(); // R2：断流可能其实已入库，拉磁盘真值对账更正
            },
            onError: (message, retryable) => {
              if (!ownsCurrentWorkspace()) return;
              sawError = true;
              appendErrorMessage(message, retryable);
              unstickGeneratingFlow();          // 出稿失败：标题区别卡在「正在生成草稿」
              requestChapterReconciliation(); // R2：同上
            },
            onDone: () => undefined,
          },
          abortController.signal,
        );
      } catch (error) {
        if (!ownsCurrentWorkspace()) {
          notifyStaleOperation();
          return;
        }
        // streamAgentChat 内部已把异常转成 onError；这里兜底防御未捕获路径。
        if (!sawError) {
          const message = error instanceof Error ? error.message : String(error);
          appendMessage({
            id: `assistant-agent-error-${Date.now()}`,
            role: "assistant",
            content: "AI 服务暂时没响应，本次没有改动。",
            isErrorNotice: true,
            errorDetail: message,
            suggestedActions: [
              {
                id: "retry-agent",
                label: "重试这一步",
                description: "重新让写作助手处理这条消息",
                permission: "safe_read",
                requiresConfirmation: false,
                endpoint: text,
              },
            ],
          });
        }
        unstickGeneratingFlow();          // 出稿失败：标题区别卡在「正在生成草稿」
        requestChapterReconciliation(); // R2 兜底：未捕获异常路径也对账一次
      } finally {
        // A-5 停止收尾：用户点「■」abort 只是断了流（streamAgentChat 对主动 abort 不报错、不收尾），
        // 回合收尾必须在这里补齐——
        //   ① 残留 running 的步骤/卡片结算成「已停止」（不是 failed：不是工具失败，是人喊停），金光/字幕随之静止；
        //   ② 卡在「正在生成草稿」的流程态同步按编辑器现状复位（盘上真值随后异步再校）；
        //   ③ 写类工具在飞 → 拉一次磁盘对账（回执丢了但盘上可能已写完整稿/已入库）。
        const wasAborted = abortController.signal.aborted;
        if (wasAborted && ownsCurrentWorkspace()) {
          updateMessage(assistantMsgId, (current) => settleStoppedAgentTurn(current, Date.now()));
          unstickGeneratingFlow();
          if (sawChapterWriteToolCall) {
            reconciliationPromise ??= reconcileAbortedTurnFromDisk();
          }
        }
        // 保持 operation 所有权直到盘上真值读完；否则异步 fetch 刚返回，finally 已释放 token，
        // 对账会把本应恢复的成功结果误当成迟到数据丢掉。
        if (reconciliationPromise) await reconciliationPromise;
        if (!ownsCurrentWorkspace() && isWorkspaceOperationCurrent(operation)) {
          notifyStaleOperation();
        }
        // 回合终点打点：正常完成 / tool-error / onError / 未捕获兜底都走到这里，
        // 保证块头耗时在失败路径也能落地（onDone 只在正常流末尾触发，覆盖不全）。
        if (ownsCurrentWorkspace()) {
          updateMessage(assistantMsgId, (current) => ({
            ...current,
            turnEndedAt: Date.now(),
          }));
        }
        // A1 谎报探针：回合「看似成功」（无 error）却声称已生成/已写入/已入库、且零写类工具成功 → 用确定性失败文案盖掉假成功。
        // 错误回合已有 error 气泡 + R2 对账，不在此重复。被「停止」腰斩的回合也不盖——流是被掐断的，
        // 半截文本不等于「声称完成」，「已停止」步骤结算 + 字幕已如实表达，再叠「没有执行」是双重谎报。
        if (!wasAborted && !sawError && ownsCurrentWorkspace()) {
          const finished = useWorkspaceStore.getState().workspace.messages.find((m) => m.id === assistantMsgId);
          if (finished) {
            // 诚实收尾：盖掉假成功正文的同时，清掉同条消息上 agent 顺手挂的诱导卡（「直接入库」/「质检通过」），
            // 否则「质检/入库没有执行」正文与「可入库」卡并存、自相矛盾（修 Bug3）。
            const patch = honestyRewritePatch({
              content: finished.content,
              toolSteps: finished.toolSteps,
              userText: text,
            });
            if (patch) {
              updateMessage(assistantMsgId, (current) => ({ ...current, ...patch }));
            }
          }
        }
        if (isWorkspaceOperationCurrent(operation)) {
          if (ownsCurrentWorkspace()) setChatLoading(false);
          finishWorkspaceOperation(operation);
        }
        agentAbortRef.current = null; // 本轮收尾，清掉中止器（避免「停止」误伤下一轮）。
      }
    },
    [
      appendMessage,
      applyOverviewToWorkspace,
      projectPath,
      refreshWorkspaceFromOverview,
      setChatError,
      setChatLoading,
      updateMessage,
      showToast,
    ],
  );

  /* ---- undoToTurn：块级「撤销到此」 ---- */

  /**
   * 块级精确撤销：把某个 AI 回合的 git 改动整块回退，并让对话历史与工作台同步回退，不整页刷。
   *
   * 步骤（顺序谨慎）：
   *  1. 防御：streaming 未结束（chatLoading）或该回合无 git 快照（turnSnapshots 空）→ 不动。
   *  2. restore 该回合的「首次写入前快照」turnSnapshots[0] —— 磁盘整块回退到回合开始前。
   *  3. 截断对话：去掉该回合 assistant 消息及其后的所有消息（保留触发它的用户消息，可重问）。
   *  4. 重拉 overview 刷工作台：复用读类「无正文回传现有 draft.content」的防占位写法，
   *     绝不用 overview 占位重置 draft（否则 autosave 会把占位写回磁盘抹掉真正文）。
   *  5. 失败不静默：追加一条 system 错误气泡，并把对话/工作台留在原状（git restore 失败时未截断）。
   *
   * 与全局 SnapshotHistoryDialog 并存：两者共用同一 git 历史，这里是 inline 按回合的精确入口。
   */
  const undoToTurn = useCallback(
    async (message: ChapterMessage): Promise<void> => {
      const store = useWorkspaceStore.getState();
      // 防御①：streaming 中不允许撤上一回合（会回退正在写的中间态）。
      if (store.chatLoading) return;
      // 防御②：草稿/纯读回合无 git 快照，不可块级撤销（块脚本就不渲染按钮，这里再兜一道）。
      const undoSnapshotId = message.turnSnapshots?.[0]?.snapshotId;
      if (!undoSnapshotId) return;
      if (!projectPath) {
        setChatError("请先打开真实本地项目。");
        return;
      }
      if (useNavigationStore.getState().projectPath !== projectPath) {
        showToast("当前项目已经变化，不能发送旧工作区请求。", 4200);
        return;
      }
      const live = useWorkspaceStore.getState();
      if (isWorkspaceBusy() || live.chatLoading || live.steeringLoading || Boolean(live.draftActionLoading)) {
        showToast("已有写作操作正在进行，请等它结束后再发送新请求。", 4200);
        return;
      }

      // M5：restore 前先冻结 autosave + 排空在途 PUT，否则一笔在途/待触发的 autosave 落在 restore 之后
      //     会把回合后的旧草稿写回磁盘、抹掉回退（撤销时灵时不灵）。冻结挡住后续（含下面截断又触发的那次）；
      //     drain 等掉已发出的在途 PUT，使它落在 restore 之前、随后被 restore 一并回退。冻结态随 reload 重置。
      suspendAutosave();
      await drainAutosave();

      // restore 是唯一动磁盘的步骤；先单独 try，失败时如实回报「没动磁盘」、不截断对话。
      try {
        // ② git 整块回退到该回合首次写入前。
        await restoreSnapshotApi(projectPath, undoSnapshotId);
      } catch (error) {
        // 撤销失败、不会 reload：解冻 autosave，否则本页 autosave 永久停摆（M5 冻结的副作用）。
        resumeAutosave();
        const messageText = error instanceof Error ? error.message : String(error);
        appendMessage({
          id: `assistant-undo-error-${Date.now()}`,
          role: "assistant",
          content: `撤销失败：${messageText}。没有改动磁盘或对话历史。`,
        });
        setChatError(messageText);
        return;
      }

      // ③ 截断对话：连同触发该回合的用户提问一起去掉该回合及其后（回到「没问过」的干净态，
      //    不留「你问了、AI 没回」的孤儿用户气泡）。updateWorkspace 同步把 messages 写进 sessionStorage。
      const liveMessages = useWorkspaceStore.getState().workspace.messages;
      const truncated = truncateMessagesFrom(liveMessages, undoCutId(liveMessages, message.id));
      useWorkspaceStore.getState().updateWorkspace({ messages: truncated });

      // H5 根治：把干净截断【显式写回当前章后端文件】，使磁盘成为干净真值——否则磁盘对话文件仍是被 git
      //    restore 还原的回合起点脏态（含孤儿消息），reload 时（dev StrictMode 让 openProject 跑两次、
      //    一次性 preferSession flag 被首次消费 → 二次回退读磁盘；或用户二次刷新）孤儿气泡复活。
      //    读回 restore 后的快照拿回退草稿，只替换 messages，不重写 .md（草稿已被 git 还原）。失败则降级靠 flag。
      // 优先用被撤销回合实际操作的章（工具回报、回写进 turnSnapshots[0].chapterNumber）：单聊天走天涯后用户
      //    可能在第5章撤销一个属于第1章的回合，按当前停留章会错写到第5章。旧快照无 chapterNumber 时退化当前章。
      const undoChapter =
        message.turnSnapshots?.[0]?.chapterNumber ??
        useWorkspaceStore.getState().workspace.currentChapter.chapterNumber;
      try {
        const restored = await fetchChapterWorkspace({ projectPath, chapter: undoChapter });
        const saved = await saveChapterWorkspace(buildUndoPersistRequest(projectPath, undoChapter, truncated, restored));
        if (saved.revision !== undefined) {
          recordWorkspaceRevision(projectPath, undoChapter, saved.revision);
          const live = useWorkspaceStore.getState();
          if (useNavigationStore.getState().projectPath === projectPath
            && live.workspace.currentChapter.chapterNumber === undoChapter) {
            live.setWorkspaceRevision(saved.revision);
          }
        }
      } catch {
        // 写回失败（极少，localhost）：不阻断撤销，降级靠下面的 preferSession flag。
      }

      // H5 兜底：标记下一次 openProject 优先 sessionStorage 干净截断、忽略磁盘对话（防显式写回未命中 openProject 实际读的章）。
      markUndoReloadPreferSession();
      // ④ 整页重载，从磁盘真值重建工作台 —— 与全局快照恢复（App.tsx 的 onRestored）同一收尾。
      //    必须重载而非局部刷新：草稿正文不在 overview 里（overview 只是状态摘要），且 autosave
      //    依赖前端 draft.content。若像读类刷新那样保留旧 draft.content，autosave（350ms 防抖、
      //    依赖 messages 变化会重跑）会把「该回合之后生成的旧草稿」写回磁盘、抹掉刚 restore 的回退
      //    —— 这正是 Codex M3 V2 实测到的状态不一致 bug。重载后：messages 取截断后的（sessionStorage），
      //    草稿/资料取磁盘真值（已被 git restore 还原），三者一致，且页面重建前无旧稿可被 autosave 写回。
      window.location.reload();
    },
    [appendMessage, projectPath, setChatError],
  );

  /* ---- handleSendMessage ---- */

  const handleSendMessage = useCallback(
    async (message: string) => {
      const text = message.trim();
      if (!text) return;
      if (!projectPath) {
        setChatError("请先打开真实本地项目。");
        return;
      }
      const live = useWorkspaceStore.getState();
      if (isWorkspaceBusy() || live.chatLoading || live.steeringLoading || Boolean(live.draftActionLoading)) {
        showToast("已有操作正在进行，请等它结束后再发送新请求。", 4200);
        return;
      }

      const userMessage: ChapterMessage = {
        id: `user-${Date.now()}`,
        role: "user",
        content: text,
      };

      const conversation = buildOutboundConversation(
        workspace.messages,
        useWorkspaceStore.getState().activeArchivedCount,
        useWorkspaceStore.getState().chatHistoryBudget,
      );

      appendMessage(userMessage);

      // 自动起名：还叫默认「新会话」的会话，首条用户消息一发就用原话压成标题命名。
      // 手动/已自动命名过的会话名不是默认值，不会被覆盖；fire-and-forget，不阻塞发送。
      {
        const st = useWorkspaceStore.getState();
        const active = st.sessions.find((s) => s.id === st.activeSessionId);
        if (active && (active.name === "新会话" || active.name === "会话")) {
          const requestSeq = ++autoRenameRequestSeqRef.current;
          const originProjectPath = projectPath;
          const originSessionId = active.id;
          void renameChatSession(projectPath, active.id, deriveIntentTitle(text))
            // 只更新 sessions 列表（拿到新名），不传 activeSessionId：异步起名期间用户
            // 若已切到别的会话，传回旧的 activeSessionId 会把当前选择回拉，造成名/内容错乱。
            .then((r) => {
              const live = useWorkspaceStore.getState();
              if (requestSeq !== autoRenameRequestSeqRef.current
                || useNavigationStore.getState().projectPath !== originProjectPath
                || live.activeSessionId !== originSessionId) return;
              live.setSessions(r.index.sessions);
            })
            .catch((err) => console.error("[useChat] 会话自动起名失败", err));
        }
      }

      // 改稿低把握度先问后的待确认改稿指令消费：下一轮用户确认/取消在此消费。
      if (pendingDirectEditInstruction) {
        if (isChapterAgentConfirm(text)) {
          const instruction = pendingDirectEditInstruction;
          setPendingDirectEditInstruction(null);
          await directEditWorkingDraft(instruction, createDraftEditHostCard());
          return;
        }
        if (isChapterAgentCancel(text)) {
          setPendingDirectEditInstruction(null);
          appendMessage({
            id: `assistant-direct-edit-cancel-${Date.now()}`,
            role: "assistant",
            content: "已取消修改。你可以继续告诉我接下来怎么做。",
          });
          return;
        }
      }

      // R3#1：审稿/质检 这类只读分析按钮发出的固定意图，确定性直调对应 handler——不过模型（三轮封测证明模型
      // 经常不调 ai_review/quality_check，靠 NL 让模型猜不可靠）。只读、结果照样渲染进时间线，不违铁律②。
      // 只拦【精确等于】按钮常量的文本；用户自由打字仍走下方 agent 对话链路。
      // 固定动作按钮（审稿/质检/写这一章）确定性直调对应 handler，不靠模型 NL 猜（多轮证明不可靠）。
      // 只读(审稿/质检)与写工作稿(生成草稿)都与 agent 工具共享同一份磁盘状态、无内存票据接缝；
      // 入库(commit_preview/apply 涉及服务端票据)与开书资料(开放式)仍走 agent。
      const deterministicAction = matchDeterministicChapterAction(text);
      if (deterministicAction) {
        if (deterministicAction === "ai_review") await handleDraftAIReview();
        else if (deterministicAction === "quality_check") await handleQualityCheck();
        // 写这一章：没显式方向也用题材中立默认目标直接出稿；错误进聊天区（不落「方案整理失败」）。
        else await handleGenerateDraft(undefined, { errorTarget: "chat", fallbackGoalWhenEmpty: DIRECT_WRITE_FALLBACK_GOAL });
        return;
      }

      // 唯一控制面：把对话交给 Mastra 写作总控 agent。
      await runAgentDispatch(text, conversation);
    },
    [
      projectPath,
      workspace.messages,
      pendingDirectEditInstruction,
      appendMessage,
      setChatError,
      setPendingDirectEditInstruction,
      createDraftEditHostCard,
      directEditWorkingDraft,
      runAgentDispatch,
      handleDraftAIReview,
      handleQualityCheck,
      handleGenerateDraft,
      showToast,
    ],
  );


  /* ---- handleSelectAdviceCard ---- */

  const handleSelectAdviceCard = useCallback(
    (key: string, card: ChapterAdviceCard) => {
      const exists = selectedAdviceCards.some((item) => item.key === key);
      if (exists) {
        setSelectedAdviceCards(selectedAdviceCards.filter((item) => item.key !== key));
      } else {
        setSelectedAdviceCards([...selectedAdviceCards, { key, card }]);
      }
    },
    [selectedAdviceCards, setSelectedAdviceCards],
  );

  const runOwnedFoundationWrite = useCallback(
    async <T,>(write: () => Promise<T>): Promise<T | null> => {
      if (!projectPath || useNavigationStore.getState().projectPath !== projectPath) return null;
      const initial = useWorkspaceStore.getState();
      const operation = beginWorkspaceOperation("foundation-write", {
        projectPath,
        chapter: initial.workspace.currentChapter.chapterNumber,
        sessionId: initial.activeSessionId,
      });
      if (!operation) {
        showToast("已有操作正在进行，请等它结束后再写入资料。", 4200);
        return null;
      }
      const ownsTarget = (): boolean => {
        const live = useWorkspaceStore.getState();
        return isWorkspaceOperationTargetCurrent(operation, {
          projectPath: useNavigationStore.getState().projectPath ?? "",
          chapter: live.workspace.currentChapter.chapterNumber,
          sessionId: live.activeSessionId,
        });
      };
      try {
        const result = await write();
        if (!ownsTarget()) {
          useNavigationStore.getState().showToast("原工作区已经变化，已丢弃迟到的资料写入回执。", 5000);
          return null;
        }
        return result;
      } catch (error) {
        if (!ownsTarget()) return null;
        throw error;
      } finally {
        finishWorkspaceOperation(operation);
      }
    },
    [projectPath, showToast],
  );

  /* ---- handleSuggestedAction ---- */

  // 动作消费（A-6 建议条配套）：动作成功执行后把它从携带它的消息上摘掉——否则建议条继续显示
  // 已完成的动作（如「撤回本次修改」撤回成功后还能再点），成假入口。失败/未执行不摘，留着重试。
  const consumeSuggestedAction = useCallback(
    (consumed: SuggestedAction): void => {
      const store = useWorkspaceStore.getState();
      const carrier = [...store.workspace.messages].reverse().find((m) =>
        m.role === "assistant"
        && (m.suggestedActions ?? []).some((a) => a.id === consumed.id && a.endpoint === consumed.endpoint));
      if (!carrier) return;
      updateMessage(carrier.id, (current) => ({
        ...current,
        suggestedActions: (current.suggestedActions ?? []).filter(
          (a) => !(a.id === consumed.id && a.endpoint === consumed.endpoint),
        ),
      }));
    },
    [updateMessage],
  );

  const handleSuggestedAction = useCallback(
    (action: SuggestedAction) => {
      if (action.disabledReason) {
        showToast(action.disabledReason);
        return;
      }
      // workflow 类动作：不再直接调老工作流函数（那会绕过 Mastra agent、没有思考/工具反馈），
      // 改成用 handleSendMessage 发一条中文请求给 agent，走正常对话链路（出 SSE 思考/调用工具）。
      switch (action.id) {
        case "generate-steering":
          void handleSendMessage("帮我读一下当前状态，整理这一章的承接建议。");
          return;
        case "generate-draft":
          void handleSendMessage("帮我写这一章的草稿。");
          return;
        case "generate-draft-direct": {
          const direction = resolveChapterDirection().trim();
          void handleSendMessage(
            direction ? `帮我写这一章的草稿，方向是：${direction}` : "帮我写这一章的草稿。",
          );
          return;
        }
        case "quality-check":
          void handleSendMessage("帮我检查这一章的连续性和逻辑风险。");
          return;
        case "ai-review":
          void handleSendMessage("帮我审一下这一章的稿子，给修改建议。");
          return;
        case "revision-preview":
          void handleSendMessage("按我的方向给这一章改一版，先出预览。");
          return;
        case "revision-apply":
          void handleApplyRevisionPreview();
          return;
        case "commit-preview":
          void handleSendMessage("帮我预览这一章的入库改动。");
          return;
        case "commit-apply":
          void handleSendMessage("确认定稿");
          return;
        case "continue-next": {
          void handleSendMessage("继续写下一章。");
          return;
        }
        case "confirm-foundation-delete": {
          const ids = action.endpoint?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
          if (ids.length === 0 || !handleApplyFoundationGapSuggestionsFromChat) return;
          void runOwnedFoundationWrite(async () => {
            const store = useWorkspaceStore.getState();
            store.setFoundationGapSuggestions(store.foundationGapSuggestions.map((suggestion) => (
              ids.includes(suggestion.id) ? { ...suggestion, confirmedByUser: true } : suggestion
            )));
            return handleApplyFoundationGapSuggestionsFromChat(ids);
          }).then((result) => {
            if (!result) return;
            consumeSuggestedAction(action);
            // 修3：只有真有写入才挂撤销按钮，避免「啥也没写却给假撤销」。
            const undoActions = (result?.writes?.length ?? 0) > 0 && result?.undo ? [buildUndoFoundationWriteAction(result.undo.undoId)] : [];
            appendMessage({
              id: `assistant-foundation-delete-confirmed-${Date.now()}`,
              role: "assistant",
              content: foundationApplyResultText(result?.plan ?? null, result?.writes ?? [], result?.skippedWrites ?? []),
              suggestedActions: undoActions,
            });
          });
          return;
        }
        case "accept-foundation-suggestions": {
          const ids = action.endpoint?.split(",").map((item) => item.trim()).filter(Boolean);
          if (!handleApplyFoundationGapSuggestionsFromChat) return;
          void runOwnedFoundationWrite(() => handleApplyFoundationGapSuggestionsFromChat(ids)).then((result) => {
            if (!result) return;
            consumeSuggestedAction(action);
            const undoActions = (result?.writes?.length ?? 0) > 0 && result?.undo ? [buildUndoFoundationWriteAction(result.undo.undoId)] : [];
            appendMessage({
              id: `assistant-foundation-applied-${Date.now()}`,
              role: "assistant",
              content: foundationApplyResultText(result?.plan ?? null, result?.writes ?? [], result?.skippedWrites ?? []),
              suggestedActions: undoActions,
            });
          });
          return;
        }
        case "undo-foundation-write": {
          const undoId = action.endpoint?.trim();
          if (!undoId || !handleRollbackFoundationGapApplyFromChat) {
            appendMessage({
              id: `assistant-foundation-undo-missing-${Date.now()}`,
              role: "assistant",
              content: "没有找到可撤回的修改记录。",
            });
            return;
          }
          void runOwnedFoundationWrite(() => handleRollbackFoundationGapApplyFromChat(undoId)).then((ok) => {
            if (ok === null) return;
            if (ok) consumeSuggestedAction(action);
            appendMessage({
              id: `assistant-foundation-undone-${Date.now()}`,
              role: "assistant",
              content: ok ? "已撤回本次修改。" : "撤回失败，请查看资料补全面板错误。",
            });
          });
          return;
        }
        case "retry-agent": {
          // agent 大脑失败后重试：用按钮 endpoint 携带的原始消息重跑 agent 派发，不重复 append 用户消息。
          const original = action.endpoint?.trim();
          if (!original) return;
          void runAgentDispatch(
            original,
            buildOutboundConversation(
              useWorkspaceStore.getState().workspace.messages,
              useWorkspaceStore.getState().activeArchivedCount,
              useWorkspaceStore.getState().chatHistoryBudget,
            ),
          );
          return;
        }
        default:
          return;
      }
    },
    [
      showToast,
      resolveChapterDirection,
      handleSendMessage,
      handleApplyRevisionPreview,
      handleApplyFoundationGapSuggestionsFromChat,
      handleRollbackFoundationGapApplyFromChat,
      appendMessage,
      consumeSuggestedAction,
      runAgentDispatch,
      runOwnedFoundationWrite,
    ],
  );

  return {
    handleSendMessage,
    handleSelectAdviceCard,
    handleSuggestedAction,
    undoToTurn,
    stopAgent,
  };
}
