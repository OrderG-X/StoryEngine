/**
 * 消息上的卡存盘白名单（重构 P5）：按 type 逐种校验，认不出的 type、形状不对的卡丢掉；一条消息上同一种卡只留最后一张。
 *
 * 老会话里卡还是消息上分散的老字段（commitPreview / continuityCheck / isErrorNotice……），读的时候在这里转成卡
 * （只读迁移：写回去就是新格式）。adviceCards、aiReviewReport 早已没人写、界面也不再渲染，迁移时认出来直接丢。
 */
import type {
  AiFlavorReport,
  CommitPreviewCardData,
  ContinuityCheckData,
  ContinuityCheckItemData,
  MessageCard,
  MessageCardType,
  NextStepPrompt,
} from "../../type-defs/workspace.js";
import type { DraftReviewView, QualityCardReport } from "../../api/types.js";
import { parseNextStepUserAction, readAiErrorReason, readSettingRef, type AgentUserAction } from "../../api/agentChatClient.js";
import { readBrainstormData, readPicked } from "../../utils/brainstormCard.js";
import { readSettleData, readSettleExcluded } from "../../utils/settleCard.js";
import { isRecord, readNonNegativeInteger, readPositiveInteger, readString, readStringAllowEmpty, readStringList } from "./value-readers.js";

/** 存盘形态的卡数组 → 校验过的卡。 */
export function readMessageCards(value: unknown): MessageCard[] {
  if (!Array.isArray(value)) return [];
  return dedupeByType(value.flatMap((item) => {
    const card = readMessageCard(item);
    return card ? [card] : [];
  }));
}

/** 老会话：消息上分散的老卡片字段 → 卡（只读迁移）。 */
export function legacyMessageCards(item: Record<string, unknown>): MessageCard[] {
  const cards: (MessageCard | undefined)[] = [
    isRecord(item.aiFlavorReport)
      ? withFixedIds({ type: "ai-flavor", report: item.aiFlavorReport as unknown as AiFlavorReport }, item.aiFlavorFixedIds)
      : undefined,
    isRecord(item.draftReview) ? { type: "draft-review", review: item.draftReview as unknown as DraftReviewView } : undefined,
    cardFromContinuity(item.continuityCheck),
    isRecord(item.qualityReport) ? { type: "quality", report: item.qualityReport as unknown as QualityCardReport } : undefined,
    cardFromCommitPreview(item.commitPreview),
    item.commitReport !== undefined && item.commitReport !== null ? { type: "commit-report", report: item.commitReport } : undefined,
    cardFromNextSteps(item.nextStepPrompt),
    item.isErrorNotice === true ? errorCard(item.errorDetail, undefined) : undefined,
    cardFromStatusNotes(item.statusNotes),
  ];
  return cards.filter((card): card is MessageCard => card !== undefined);
}

function readMessageCard(value: unknown): MessageCard | undefined {
  if (!isRecord(value)) return undefined;
  const type = value.type as MessageCardType;
  switch (type) {
    case "ai-flavor":
      return isRecord(value.report)
        ? withFixedIds({ type, report: value.report as unknown as AiFlavorReport }, value.fixedIds)
        : undefined;
    case "draft-review":
      return isRecord(value.review) ? { type, review: value.review as unknown as DraftReviewView } : undefined;
    case "continuity": {
      const card = cardFromContinuity(value.check);
      if (!card || card.type !== "continuity") return undefined;
      const dismissed = readStringList(Array.isArray(value.dismissed) ? value.dismissed : []).slice(0, 200);
      const checkedVersion = value.checkedVersion === null ? null : readString(value.checkedVersion);
      return {
        ...card,
        ...(dismissed.length > 0 ? { dismissed } : {}),
        ...(checkedVersion !== undefined ? { checkedVersion } : {}),
      };
    }
    case "quality":
      return isRecord(value.report) ? { type, report: value.report as unknown as QualityCardReport } : undefined;
    case "commit-preview": {
      const card = cardFromCommitPreview(value.preview);
      if (!card || card.type !== "commit-preview") return undefined;
      const checkedVersion = value.checkedVersion === null ? null : readString(value.checkedVersion);
      return { ...card, ...(checkedVersion !== undefined ? { checkedVersion } : {}) };
    }
    case "commit-report":
      // 定稿回执原样存（体量大、结构跟着引擎走），渲染侧 summarizeCommitReport 防御解析。
      return value.report !== undefined && value.report !== null ? { type, report: value.report } : undefined;
    case "next-steps":
      return cardFromNextSteps(value.prompt);
    case "error":
      return errorCard(value.detail, value.reason);
    case "status-notes":
      return cardFromStatusNotes(value.notes);
    case "directions": {
      const brainstorm = readBrainstormData(value.brainstorm);
      if (!brainstorm) return undefined;
      const picked = readPicked(value.picked, brainstorm);
      return { type, brainstorm, ...(picked !== undefined ? { picked } : {}) };
    }
    case "settle": {
      const settle = readSettleData(value.settle);
      if (!settle) return undefined;
      const excluded = readSettleExcluded(value.excluded, settle);
      const applied = typeof value.applied === "string" && value.applied.trim() ? value.applied.trim().slice(0, 2000) : "";
      return { type, settle, ...(excluded ? { excluded } : {}), ...(applied ? { applied } : {}) };
    }
    default:
      return undefined;
  }
}

function dedupeByType(cards: readonly MessageCard[]): MessageCard[] {
  const byType = new Map<MessageCardType, MessageCard>();
  for (const card of cards) {
    byType.delete(card.type);
    byType.set(card.type, card);
  }
  return [...byType.values()];
}

function withFixedIds(card: { readonly type: "ai-flavor"; readonly report: AiFlavorReport }, value: unknown): MessageCard {
  const fixedIds = readStringList(Array.isArray(value) ? value : []).slice(0, 50);
  return fixedIds.length > 0 ? { ...card, fixedIds } : card;
}

/** 出错卡：原始报错 + 服务端分的类（P11，重开后照样说清原因）。 */
function errorCard(detail: unknown, reason: unknown): MessageCard {
  const text = readString(detail);
  const kind = readAiErrorReason(reason);
  return { type: "error", ...(text ? { detail: text } : {}), ...(kind ? { reason: kind } : {}) };
}

function cardFromStatusNotes(value: unknown): MessageCard | undefined {
  const notes = readStringList(Array.isArray(value) ? value : []).slice(0, 20);
  return notes.length > 0 ? { type: "status-notes", notes } : undefined;
}

function cardFromContinuity(value: unknown): MessageCard | undefined {
  const check = readContinuityCheck(value);
  return check ? { type: "continuity", check } : undefined;
}

function cardFromCommitPreview(value: unknown): MessageCard | undefined {
  const preview = readCommitPreview(value);
  return preview ? { type: "commit-preview", preview } : undefined;
}

function cardFromNextSteps(value: unknown): MessageCard | undefined {
  const prompt = readNextStepPrompt(value);
  return prompt ? { type: "next-steps", prompt } : undefined;
}

/** 核账卡：章号 + 确定 / 可能两档；每条至少要有本章原句和前文原句。 */
function readContinuityCheck(value: unknown): ContinuityCheckData | undefined {
  if (!isRecord(value)) return undefined;
  const chapter = readPositiveInteger(value.chapter);
  if (chapter === undefined) return undefined;
  return { chapter, sure: readContinuityItems(value.sure), maybe: readContinuityItems(value.maybe) };
}

function readContinuityItems(value: unknown): ContinuityCheckItemData[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 200).flatMap((item): ContinuityCheckItemData[] => {
    if (!isRecord(item)) return [];
    const quote = readStringAllowEmpty(item.quote);
    const earlierQuote = readStringAllowEmpty(item.earlierQuote);
    if (quote === undefined || earlierQuote === undefined) return [];
    const againstSetting = readSettingRef(item.againstSetting);
    const fixChapter = readPositiveInteger(item.fixChapter);
    return [{
      quote,
      earlierQuote,
      earlierChapter: readNonNegativeInteger(item.earlierChapter) ?? 0,
      reason: readStringAllowEmpty(item.reason) ?? "",
      ...(againstSetting ? { againstSetting } : {}),
      ...(fixChapter !== undefined ? { fixChapter } : {}),
    }];
  });
}

/** 「下一步」选项卡：question 非空 + choices 逐项 label/intent 非空、recommended 若在须 boolean；清洗后为空 → 不要；上限 8。 */
function readNextStepPrompt(value: unknown): NextStepPrompt | undefined {
  if (!isRecord(value)) return undefined;
  const question = readString(value.question);
  if (!question || !Array.isArray(value.choices)) return undefined;
  const choices: { label: string; intent: string; recommended?: boolean; action?: AgentUserAction }[] = [];
  for (const item of value.choices) {
    if (!isRecord(item)) continue;
    const label = readString(item.label);
    const intent = readString(item.intent);
    if (!label || !intent) continue;
    if ("recommended" in item && typeof item.recommended !== "boolean") continue;
    // choice.action（R4.7）：服务端生成的确定性选项带结构化动作，刷新/重开后照旧直达；
    // 白名单外/形状不对的丢掉 action，选项退回发文本意图。
    const action = parseNextStepUserAction(item.action);
    choices.push({
      label,
      intent,
      ...(typeof item.recommended === "boolean" ? { recommended: item.recommended } : {}),
      ...(action ? { action } : {}),
    });
  }
  if (choices.length === 0) return undefined;
  return { question, choices: choices.slice(0, 8) };
}

/** 定稿预览卡：章号 + 能不能定是必须的，其余逐项校验。 */
function readCommitPreview(value: unknown): CommitPreviewCardData | undefined {
  if (!isRecord(value)) return undefined;
  const chapter = readPositiveInteger(value.chapter);
  if (chapter === undefined || typeof value.canCommit !== "boolean") return undefined;
  const blockingReasons = readStringList(value.blockingReasons).slice(0, 20);
  const summary = readString(value.summary);
  const previewToken = readString(value.previewToken);
  const draftIssueCount = readNonNegativeInteger(value.draftIssueCount);
  const semanticIssueCount = readNonNegativeInteger(value.semanticIssueCount);
  const draftIssues = readStringList(value.draftIssues).slice(0, 20);
  const semanticIssues = readStringList(value.semanticIssues).slice(0, 20);
  const ledgerChecklist = Array.isArray(value.ledgerChecklist)
    ? value.ledgerChecklist.filter(isRecord).slice(0, 200).flatMap((item) => {
      const id = readString(item.id);
      const label = readString(item.label);
      if (!id || !label) return [];
      const detail = readString(item.detail);
      const reason = readString(item.reason);
      const editableDay = readPositiveInteger(item.editableDay);
      return [{
        id,
        kind: readString(item.kind) ?? "",
        label,
        ...(reason ? { reason } : {}),
        ...(detail ? { detail } : {}),
        removable: item.removable === true,
        ...(editableDay !== undefined ? { editableDay } : {}),
        ...(item.needsConfirm === true ? { needsConfirm: true } : {}),
        ...(item.defaultUnchecked === true ? { defaultUnchecked: true } : {}),
      }];
    })
    : [];
  const notRecorded = readStringList(value.notRecorded).slice(0, 50);
  const notes = readStringList(value.notes).slice(0, 20);
  return {
    chapter,
    canCommit: value.canCommit,
    ...(blockingReasons.length > 0 ? { blockingReasons } : {}),
    ...(summary ? { summary } : {}),
    ...(draftIssueCount !== undefined ? { draftIssueCount } : {}),
    ...(semanticIssueCount !== undefined ? { semanticIssueCount } : {}),
    ...(draftIssues.length > 0 ? { draftIssues } : {}),
    ...(semanticIssues.length > 0 ? { semanticIssues } : {}),
    ...(previewToken ? { previewToken } : {}),
    ...(ledgerChecklist.length > 0 ? { ledgerChecklist } : {}),
    ...(notRecorded.length > 0 ? { notRecorded } : {}),
    ...(notes.length > 0 ? { notes } : {}),
  };
}
