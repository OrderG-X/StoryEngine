/**
 * 消息上的卡（重构 P5）：取、挂、改。一条消息上同一种卡最多一张，再挂同一种就顶掉旧的。
 */
import type { ChapterMessage, MessageCard, MessageCardType } from "../type-defs/workspace.js";

export type CardOf<T extends MessageCardType> = Extract<MessageCard, { readonly type: T }>;

export function cardOf<T extends MessageCardType>(message: Pick<ChapterMessage, "cards">, type: T): CardOf<T> | undefined {
  return message.cards?.find((card): card is CardOf<T> => card.type === type);
}

export function hasCard(message: Pick<ChapterMessage, "cards">, type: MessageCardType): boolean {
  return cardOf(message, type) !== undefined;
}

export function withCard<M extends Pick<ChapterMessage, "cards">>(message: M, card: MessageCard): M {
  return { ...message, cards: [...(message.cards ?? []).filter((existing) => existing.type !== card.type), card] };
}

export function withCards<M extends Pick<ChapterMessage, "cards">>(message: M, cards: readonly MessageCard[]): M {
  return cards.reduce((next, card) => withCard(next, card), message);
}

export function updateCard<M extends Pick<ChapterMessage, "cards">, T extends MessageCardType>(
  message: M,
  type: T,
  update: (card: CardOf<T>) => CardOf<T>,
): M {
  const current = cardOf(message, type);
  if (!current) return message;
  return { ...message, cards: (message.cards ?? []).map((card) => (card === current ? update(current) : card)) };
}

export function isErrorMessage(message: Pick<ChapterMessage, "cards">): boolean {
  return hasCard(message, "error");
}
