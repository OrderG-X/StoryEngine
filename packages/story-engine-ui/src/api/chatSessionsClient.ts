import type { ChatSession, ChatSessionIndex } from "../type-defs/workspace.js";

const BASE = "/api/chat-sessions";

// ── 窗口纪元登记（防误清 + 防过期全量回写，复审 P1）─────────────────────────────
// 每当从服务端成功拿到一份会话（读/建/切/删的接手会话），登记它的 windowEpoch。
// save 时自动附带：服务端发现纪元过期（会话已在别处冷热分层过）会拒绝覆盖。
// 从未登记过的会话 = 本次运行从没成功加载过它 → 客户端内存里的 messages 不可信，
// 保存直接短路跳过（这正是「加载失败→自动保存空历史→死锁/清空」那条雷的引信）。
const sessionEpochs = new Map<string, number>();

// 「保存被跳过」的 UI 信号（UI 审计 T1：绝不静默失败）。autosave 每 350ms 都可能撞一次短路，
// 直接 toast 会刷屏 → 客户端按会话去重（每会话每次运行只报一次），App 挂载时注册 notifier 弹 toast。
let saveSkippedNotifier: ((info: { readonly projectPath: string; readonly id: string }) => void) | null = null;
const saveSkipNotifiedKeys = new Set<string>();

export function setChatSessionSaveSkippedNotifier(
  fn: ((info: { readonly projectPath: string; readonly id: string }) => void) | null,
): void {
  saveSkippedNotifier = fn;
}

function epochKey(projectPath: string, id: string): string {
  return `${projectPath}::${id}`;
}

function recordSessionEpoch(projectPath: string, session: ChatSession | null | undefined): void {
  if (!session?.id) return;
  const key = epochKey(projectPath, session.id);
  sessionEpochs.set(key, (session as { windowEpoch?: number }).windowEpoch ?? 0);
  // 已成功加载 → 之前的「未加载」告警失效；若日后再短路（如会话被删后残留引用）重新报。
  saveSkipNotifiedKeys.delete(key);
}

function notifySaveSkippedOnce(projectPath: string, id: string): void {
  const key = epochKey(projectPath, id);
  if (saveSkipNotifiedKeys.has(key)) return;
  saveSkipNotifiedKeys.add(key);
  try {
    saveSkippedNotifier?.({ projectPath, id });
  } catch {
    // 通知通道本身绝不反过来炸保存链。
  }
}

async function put<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch(BASE, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error ?? "chat-sessions 请求失败");
  return json as T;
}

export async function listChatSessions(projectPath: string): Promise<{ ok: true; index: ChatSessionIndex; chatHistoryBudgetTokens?: number }> {
  const res = await fetch(`${BASE}?list=1&project=${encodeURIComponent(projectPath)}`);
  const json = await res.json();
  if (!json.ok) throw new Error(json.error ?? "读取会话列表失败");
  return json;
}
export async function readChatSession(projectPath: string, id: string): Promise<{ ok: true; session: ChatSession | null }> {
  const res = await fetch(`${BASE}?project=${encodeURIComponent(projectPath)}&session=${encodeURIComponent(id)}`);
  const json = await res.json();
  if (!json.ok) throw new Error(json.error ?? "读取会话失败");
  recordSessionEpoch(projectPath, (json as { session?: ChatSession | null }).session);
  return json;
}
export const createChatSession = async (projectPath: string, name?: string) => {
  const result = await put<{ ok: true; session: ChatSession; index: ChatSessionIndex }>({ action: "create", projectPath, name });
  recordSessionEpoch(projectPath, result.session);
  return result;
};
export const renameChatSession = (projectPath: string, id: string, name: string) =>
  put<{ ok: true; index: ChatSessionIndex }>({ action: "rename", projectPath, id, name });
export const deleteChatSession = async (projectPath: string, id: string) => {
  const result = await put<{ ok: true; session: ChatSession; index: ChatSessionIndex; activeSessionId: string }>({ action: "delete", projectPath, id });
  sessionEpochs.delete(epochKey(projectPath, id));
  recordSessionEpoch(projectPath, result.session);
  return result;
};
export const setActiveChatSession = async (projectPath: string, id: string) => {
  const result = await put<{ ok: true; session: ChatSession; index: ChatSessionIndex }>({ action: "setActive", projectPath, id });
  recordSessionEpoch(projectPath, result.session);
  return result;
};
export const saveChatSessionMessages = async (projectPath: string, id: string, messages: unknown): Promise<{ ok: true }> => {
  const epoch = sessionEpochs.get(epochKey(projectPath, id));
  if (epoch === undefined) {
    // 本次运行从未成功加载过这份会话 → 内存里的 messages 不可信（多半是加载失败后的空壳）。
    // 跳过保存（不抛错：抛错会让自动保存链进入失败态、锁死切书/切会话导航——复审 P1 的死锁链）。
    // 但不能静默：console.warn 之外再发一次性 UI 信号（toast，按会话去重，不随每次 autosave 刷屏）。
    console.warn("[chat-sessions] 跳过保存：该会话本次运行尚未成功加载，内存副本不可信", { id });
    notifySaveSkippedOnce(projectPath, id);
    return { ok: true };
  }
  return put<{ ok: true }>({ action: "save", projectPath, id, messages, windowEpoch: epoch });
};
/** 退出/切换前的「尽力而为」保存（审查 #4）：keepalive fetch，请求能在页面卸载后继续送达。 */
export function saveChatSessionMessagesBeacon(projectPath: string, id: string, messages: unknown): void {
  try {
    const epoch = sessionEpochs.get(epochKey(projectPath, id));
    if (epoch === undefined) return; // 未成功加载过 → 同 saveChatSessionMessages 的短路理由
    const body = JSON.stringify({ action: "save", projectPath, id, messages, windowEpoch: epoch });
    // Fetch 标准对 keepalive 请求体有 64KiB 硬配额，超限的请求浏览器直接判网络错误——
    // 发了也必败，如实跳过（长会话的兜底是常态 autosave，卸载兜底只对小体量有效）。复审 P1。
    if (body.length > 60_000) {
      console.warn("[chat-sessions] 卸载期保存超过 keepalive 64KiB 配额，本次跳过（依赖此前的常态自动保存）", { bytes: body.length });
      return;
    }
    fetch(BASE, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {
      // 尽力而为：卸载途中失败无法补救；catch 兜住 rejection，避免每次卸载冒 unhandled rejection。
    });
  } catch {
    // 尽力而为：卸载途中失败无法补救，忽略。
  }
}
export const archiveChatSession = (projectPath: string, id: string) =>
  put<{ ok: true; archivedCount: number; tokensBefore: number; tokensAfter: number }>({ action: "archive", projectPath, id });
export const unarchiveChatSession = (projectPath: string, id: string) =>
  put<{ ok: true; archivedCount: number }>({ action: "unarchive", projectPath, id });
export const saveChatHistoryBudget = (projectPath: string, budget: number) =>
  put<{ ok: true; chatHistoryBudgetTokens: number }>({ action: "setBudget", projectPath, budget });

/** 仅供单测：清空纪元登记 / 跳过告警去重 / 通知回调，防模块态跨用例串味。 */
export function __resetChatSessionsClientForTests(): void {
  sessionEpochs.clear();
  saveSkipNotifiedKeys.clear();
  saveSkippedNotifier = null;
}
