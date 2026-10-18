/**
 * 对话（重构 P5：从 workspaceStore 拆出）：消息、会话、回合进行中。
 * 消息只存会话文件一份，见 sync/chatSync。
 */
import { updateCard } from "../utils/messageCards.js";
import { create } from "zustand";
import type { ChapterMessage } from "../types.js";
import type { ChatSessionIndexEntry } from "../type-defs/workspace.js";

export interface ChatStore {
  messages: readonly ChapterMessage[];
  sessions: readonly ChatSessionIndexEntry[];
  activeSessionId: string;
  activeArchivedCount: number;
  chatHistoryBudget: number;
  chatLoading: boolean;
  chatError: string | null;
  /** 清空对话的回退备份：非 null 时可撤销刚才的清空（继续对话即清掉入口）。 */
  clearedChatBackup: readonly ChapterMessage[] | null;

  setMessages: (messages: readonly ChapterMessage[]) => void;
  appendMessage: (message: ChapterMessage) => void;
  updateMessage: (id: string, updater: (message: ChapterMessage) => ChapterMessage) => void;
  /** 清空当前对话（备份原消息以供撤销）。不影响正文与资料。 */
  clearChat: () => void;
  /** 撤销上一次清空，恢复对话。 */
  undoClearChat: () => void;
  /** 把某条消息里的某条机器腔违规标为「已改」（追加进该消息机器腔卡的 fixedIds，去重）。 */
  markAiFlavorViolationFixed: (messageId: string, violationId: string) => void;
  /** 走法卡上挑中某一种（null＝换一种、撤回挑选）。只改对话里的卡，不进账。 */
  setDirectionPicked: (messageId: string, picked: number | null) => void;
  /** 核账卡上记下 / 撤回一条「不是问题」（对话卡和稿纸划线共用）。 */
  setContinuityDismissed: (messageId: string, key: string, dismissed: boolean) => void;
  /** 核账 / 定稿预览结果到时记下稿纸版本（之后稿子变了就是「核过后改过稿」「要重新预览」）。 */
  stampCardVersion: (messageId: string, type: "continuity" | "commit-preview", version: string | null) => void;
  setSessions: (sessions: readonly ChatSessionIndexEntry[], activeSessionId?: string) => void;
  setActiveSessionId: (activeSessionId: string) => void;
  setActiveArchivedCount: (activeArchivedCount: number) => void;
  setChatHistoryBudget: (budget: number) => void;
  setChatLoading: (loading: boolean) => void;
  setChatError: (error: string | null) => void;
}

export const useChatStore = create<ChatStore>((set) => ({
  messages: [],
  sessions: [],
  activeSessionId: "",
  activeArchivedCount: 0,
  chatHistoryBudget: 96000,
  chatLoading: false,
  chatError: null,
  clearedChatBackup: null,

  setMessages: (messages) => set({ messages }),
  // 一旦继续对话，撤销「清空」的入口就消失。
  appendMessage: (message) => set((state) => ({ messages: [...state.messages, message], clearedChatBackup: null })),
  updateMessage: (id, updater) =>
    set((state) => ({ messages: state.messages.map((message) => (message.id === id ? updater(message) : message)) })),
  clearChat: () =>
    set((state) => (state.messages.length === 0 ? {} : { messages: [], clearedChatBackup: state.messages })),
  undoClearChat: () =>
    set((state) => (state.clearedChatBackup ? { messages: state.clearedChatBackup, clearedChatBackup: null } : {})),
  markAiFlavorViolationFixed: (messageId, violationId) =>
    set((state) => ({
      messages: state.messages.map((message) => (
        message.id === messageId
          ? updateCard(message, "ai-flavor", (card) => (
            (card.fixedIds ?? []).includes(violationId) ? card : { ...card, fixedIds: [...(card.fixedIds ?? []), violationId] }
          ))
          : message
      )),
    })),
  setContinuityDismissed: (messageId, key, dismissed) =>
    set((state) => ({
      messages: state.messages.map((message) => (
        message.id === messageId
          ? updateCard(message, "continuity", (card) => {
            const current = card.dismissed ?? [];
            if (dismissed === current.includes(key)) return card;
            const next = dismissed ? [...current, key] : current.filter((item) => item !== key);
            const { dismissed: _old, ...rest } = card;
            return next.length > 0 ? { ...rest, dismissed: next } : rest;
          })
          : message
      )),
    })),
  setDirectionPicked: (messageId, picked) =>
    set((state) => ({
      messages: state.messages.map((message) => (
        message.id === messageId
          ? updateCard(message, "directions", (card) => {
            const { picked: _old, ...rest } = card;
            return picked !== null && picked >= 0 && picked < card.brainstorm.options.length ? { ...rest, picked } : rest;
          })
          : message
      )),
    })),
  stampCardVersion: (messageId, type, version) =>
    set((state) => ({
      messages: state.messages.map((message) => (
        message.id !== messageId
          ? message
          : type === "continuity"
            ? updateCard(message, "continuity", (card) => ({ ...card, checkedVersion: version }))
            : updateCard(message, "commit-preview", (card) => ({ ...card, checkedVersion: version }))
      )),
    })),
  setSessions: (sessions, activeSessionId) => set({ sessions, ...(activeSessionId !== undefined ? { activeSessionId } : {}) }),
  setActiveSessionId: (activeSessionId) => set({ activeSessionId }),
  setActiveArchivedCount: (activeArchivedCount) => set({ activeArchivedCount }),
  setChatHistoryBudget: (budget) => set({ chatHistoryBudget: budget }),
  setChatLoading: (loading) => set({ chatLoading: loading }),
  setChatError: (error) => set({ chatError: error }),
}));
