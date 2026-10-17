/**
 * 对话存盘（重构 P5）：对话只存一份——项目里的会话文件。
 *
 * 原来有三份（浏览器 sessionStorage、会话文件、按章的 chapter-workspace JSON），撤销和刷新时互相打架，
 * 要靠「下一次开书优先哪一份」的一次性标记去猜。现在只有会话文件：
 * - 消息变了，停 350ms 存一次；一次只发一笔，按先后排队。
 * - 换书、换会话、关窗前 flush。
 * - 存哪一份在调用那一刻就定下（哪本书、哪个会话、哪组消息），排队期间换了书也不会存错地方。
 */
import { create } from "zustand";
import { saveChatSessionMessages, saveChatSessionMessagesBeacon } from "../api/chatSessionsClient.js";
import { useNavigationStore } from "../stores/navigationStore.js";
import { useWorkspaceStore } from "../stores/workspaceStore.js";
import type { ChapterMessage } from "../types.js";

export const CHAT_SAVE_DELAY_MS = 350;

export type ChatSaveResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

interface ChatSaveTarget {
  readonly projectPath: string;
  readonly sessionId: string;
  readonly messages: readonly ChapterMessage[];
}

export interface ChatSaveState {
  readonly status: "idle" | "saving" | "saved" | "error";
  readonly error: string | null;
}

/** 对话存盘状态（给「保存失败」提示用）。 */
export const useChatSaveStore = create<ChatSaveState>(() => ({ status: "idle", error: null }));

let timer: ReturnType<typeof setTimeout> | null = null;
let chain: Promise<unknown> = Promise.resolve();
/** 每个会话最后一次存进去的那组消息（按引用比：zustand 每次改消息都换新数组）。 */
const lastSaved = new Map<string, readonly ChapterMessage[]>();

const keyOf = (target: Pick<ChatSaveTarget, "projectPath" | "sessionId">): string => `${target.projectPath}::${target.sessionId}`;

function clearTimer(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

function currentTarget(): ChatSaveTarget | null {
  const projectPath = useNavigationStore.getState().projectPath;
  const store = useWorkspaceStore.getState();
  if (!projectPath || !store.activeSessionId) return null;
  return { projectPath, sessionId: store.activeSessionId, messages: store.workspace.messages };
}

/** 刚从会话文件读进来的消息：记成已存，免得开书就原样回写一遍。 */
export function markChatLoaded(projectPath: string, sessionId: string, messages: readonly ChapterMessage[]): void {
  lastSaved.set(keyOf({ projectPath, sessionId }), messages);
}

async function send(target: ChatSaveTarget, options: { readonly allowEmpty?: boolean }): Promise<ChatSaveResult> {
  const key = keyOf(target);
  if (lastSaved.get(key) === target.messages) return { ok: true };
  // 空对话只在作者明确清空 / 撤销到最前时才写（服务端也有防误清守卫）。
  if (target.messages.length === 0 && !options.allowEmpty) return { ok: true };
  useChatSaveStore.setState({ status: "saving", error: null });
  try {
    await saveChatSessionMessages(target.projectPath, target.sessionId, target.messages, options.allowEmpty ? { allowEmpty: true } : undefined);
    lastSaved.set(key, target.messages);
    useChatSaveStore.setState({ status: "saved", error: null });
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    useChatSaveStore.setState({ status: "error", error: message });
    return { ok: false, error: message };
  }
}

function enqueue(target: ChatSaveTarget, options: { readonly allowEmpty?: boolean } = {}): Promise<ChatSaveResult> {
  const run = chain.then(() => send(target, options));
  chain = run.catch(() => undefined);
  return run;
}

/** 消息变了：停一会儿再存。 */
export function scheduleChatSave(delay = CHAT_SAVE_DELAY_MS): void {
  clearTimer();
  timer = setTimeout(() => {
    timer = null;
    void saveChatNow();
  }, delay);
}

/** 现在就存当前会话（allowEmpty：作者明确清空 / 撤销到最前）。 */
export function saveChatNow(options: { readonly allowEmpty?: boolean } = {}): Promise<ChatSaveResult> {
  clearTimer();
  const target = currentTarget();
  if (!target) return Promise.resolve({ ok: true });
  return enqueue(target, options);
}

/** 关窗途中的最后一笔（keepalive，不等回执）。 */
export function saveChatKeepalive(): void {
  const target = currentTarget();
  if (!target || lastSaved.get(keyOf(target)) === target.messages || target.messages.length === 0) return;
  clearTimer();
  saveChatSessionMessagesBeacon(target.projectPath, target.sessionId, target.messages);
}

/** 只供单测。 */
export function __resetChatSyncForTests(): void {
  clearTimer();
  chain = Promise.resolve();
  lastSaved.clear();
  useChatSaveStore.setState({ status: "idle", error: null });
}
