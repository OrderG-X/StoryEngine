import type { ChapterAgentCard } from "../api/types.js";
import type { ChapterMessage } from "../types.js";

export type DraftAgentSettlement = "saved" | "rejected";

const PENDING_DRAFT_PATTERN = /待保存草稿|待保存草稿改动|保存或拒绝|用户可保存或拒绝|保存后写入\s*drafts\/fast|等待保存|未写正式故事/u;
const PENDING_DRAFT_SENTENCE = /(?:黄色部分是本次 AI 改动，)?满意就保存草稿，不满意就拒绝改动。?|草稿已写入左侧工作区，保存后写入\s*drafts\/fast。?/gu;

export function settlePendingDraftAgentCards(
  messages: readonly ChapterMessage[],
  settlement: DraftAgentSettlement,
): readonly ChapterMessage[] {
  let changed = false;
  const nextMessages = messages.map((message) => {
    if (!message.agentCards?.length) return message;
    let messageChanged = false;
    const agentCards = message.agentCards.map((card) => {
      if (!isPendingDraftAgentCard(card, message.content)) return card;
      messageChanged = true;
      return settleDraftAgentCard(card, settlement);
    });
    if (!messageChanged) return message;
    changed = true;
    return {
      ...message,
      content: settleDraftMessageContent(message.content, settlement),
      agentCards,
    };
  });
  return changed ? nextMessages : messages;
}

function isPendingDraftAgentCard(card: ChapterAgentCard, messageContent: string): boolean {
  if (card.kind !== "draft") return false;
  if (card.status === "saved" || card.status === "rejected") return false;
  const detailText = card.detail?.join("\n") ?? "";
  return PENDING_DRAFT_PATTERN.test(card.summary)
    || PENDING_DRAFT_PATTERN.test(detailText)
    || PENDING_DRAFT_PATTERN.test(messageContent);
}

function settleDraftAgentCard(card: ChapterAgentCard, settlement: DraftAgentSettlement): ChapterAgentCard {
  const saved = settlement === "saved";
  const details = (card.detail ?? []).filter((line) => !PENDING_DRAFT_PATTERN.test(line));
  return {
    ...card,
    status: settlement,
    title: saved ? "工作稿改动已保存" : "工作稿改动已拒绝",
    summary: saved
      ? "本次工作稿改动已保存到当前章节工作稿文件。"
      : "本次工作稿改动已拒绝，左侧已撤销到保存前内容。",
    detail: uniqueStrings([
      ...details,
      saved ? "result: 已保存到当前章节工作稿" : "result: 已撤销到保存前内容",
    ]),
  };
}

function settleDraftMessageContent(content: string, settlement: DraftAgentSettlement): string {
  const suffix = settlement === "saved"
    ? "本次 AI 工作稿改动已保存到当前章节工作稿。"
    : "本次 AI 工作稿改动已被拒绝，左侧已撤销到保存前内容。";
  const next = content.replace(PENDING_DRAFT_SENTENCE, "").trim();
  if (!next) return suffix;
  if (next.includes(suffix)) return next;
  return `${next}\n\n${suffix}`;
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
