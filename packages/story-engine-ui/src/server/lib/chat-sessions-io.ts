import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readWorkspaceMessages } from "./project-io.js";
import { estimateTokens } from "@actalk/story-engine";

export type StoredMessage = ReturnType<typeof readWorkspaceMessages>[number];

export interface StoredChatSession {
  id: string;
  name: string;
  messages: StoredMessage[];
  archivedCount: number;
  prevArchivedCount?: number;
  /** 窗口纪元：每次冷热分层溢写 +1。save 带过期纪元 = 旧页面/他页的过期全量副本 → 拒绝覆盖。缺省 0。 */
  windowEpoch?: number;
  /** 累计已溢写进冷归档的消息条数（真值；聊天头部的归档标记按它渲染）。缺省 0。 */
  coldArchivedCount?: number;
  createdAt: string;
  updatedAt: string;
}
export interface ChatSessionIndexEntry { id: string; name: string; updatedAt: string }
export interface ChatSessionIndex { sessions: ChatSessionIndexEntry[]; activeSessionId: string }

export function chatSessionsDir(projectDir: string): string {
  return join(projectDir, ".story-engine-ui", "chat-sessions");
}
export function chatSessionPath(projectDir: string, id: string): string {
  return join(chatSessionsDir(projectDir), `session-${id}.json`);
}
export function chatSessionIndexPath(projectDir: string): string {
  return join(chatSessionsDir(projectDir), "index.json");
}
/** 冷归档：溢出热窗口的旧消息按行追加于此（jsonl，只增不删），数据永不丢。 */
export function chatSessionArchivePath(projectDir: string, id: string): string {
  return join(chatSessionsDir(projectDir), `session-${id}.archive.jsonl`);
}

// ── 会话冷热分层（治长书会话无界增长：50 章实测 250 条消息 1.4MB，保存/加载/DOM 三处放大）──
// 做法对齐主流 agent 产品的通行方案（压缩后只看近期、旧事落盘归档、按窗口取消息）：
// 打开会话时把超出热窗口的旧消息溢写进冷归档，热文件只留尾窗。窗口按【字节】算——
// 消息很肥（内嵌工具步骤/报告），按条数开窗拦不住体积增长。
export const HOT_WINDOW_BYTE_LIMIT = 640 * 1024;
export const HOT_WINDOW_MIN_MESSAGES = 30; // 单条再大也至少保留最近这么多条（UI 不能空）
export const HOT_WINDOW_MAX_MESSAGES = 300; // 单条再小也不保留超过这么多条（DOM 有界）

function messageBytes(message: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(message), "utf8");
  } catch {
    return 0;
  }
}

/** 纯逻辑：热窗口起点（冷段 = messages[0, start)）。从尾往前按字节累计，超预算或超条数上限即切。 */
export function computeHotWindowStart(messages: readonly unknown[]): number {
  let bytes = 0;
  let start = messages.length;
  while (start > 0) {
    const candidate = start - 1;
    const kept = messages.length - candidate;
    if (kept > HOT_WINDOW_MAX_MESSAGES) break;
    const size = messageBytes(messages[candidate]);
    if (bytes + size > HOT_WINDOW_BYTE_LIMIT && kept > HOT_WINDOW_MIN_MESSAGES) break;
    bytes += size;
    start = candidate;
  }
  return start;
}

/**
 * 结算持久化里的僵尸「running」工具步骤：会话是从磁盘读出的 → 原始 SSE 早已断开，
 * 不可能还有步骤在跑。不结算的话，重载后实时字幕会永远挂着「正在定稿…」（50 章耐力跑实测）。
 * 置为 partial（诚实：该步没完成回报，结果未知），不谎报 failed 也不谎报 completed。
 */
export function settleInterruptedToolSteps(
  messages: StoredMessage[],
): { readonly messages: StoredMessage[]; readonly settled: number } {
  let settled = 0;
  const next = messages.map((message) => {
    const record = message as StoredMessage & { toolSteps?: readonly Record<string, unknown>[] };
    const steps = record.toolSteps;
    if (!steps?.length || !steps.some((step) => step.status === "running")) return message;
    const toolSteps = steps.map((step) => {
      if (step.status !== "running") return step;
      settled += 1;
      const note = "该步在页面或服务中断时仍在进行，最终结果未回传——以当前正文与状态为准。";
      const detail = typeof step.detail === "string" && step.detail.trim() ? `${step.detail}\n${note}` : note;
      return {
        ...step,
        status: "partial",
        endedAt: typeof step.endedAt === "number" ? step.endedAt : Date.now(),
        detail,
      };
    });
    return { ...record, toolSteps } as StoredMessage;
  });
  return { messages: next, settled };
}

function newId(): string { return `session-${randomUUID().slice(0, 8)}`; }
function now(): string { return new Date().toISOString(); }

function buildNewSession(name = "新会话"): StoredChatSession {
  const ts = now();
  return { id: newId(), name, messages: [], archivedCount: 0, createdAt: ts, updatedAt: ts };
}

// ── 并发安全：原子写 + 项目级写锁（根治 fuzz 测出的 BUG-1/2/3）────────────────────
let __tmpSeq = 0;
/**
 * 原子写：写临时文件并 fsync 落盘后再 rename 覆盖（POSIX rename 原子），避免并发 writeFile O_TRUNC
 * 把 JSON 写撕裂、断电时 rename 先于数据落盘；任何一步失败都清掉临时文件（force），不留 .tmp- 残留。
 * 口径对齐 project-io.ts 的 writeFileAtomic。
 */
async function atomicWrite(path: string, data: string): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${__tmpSeq++}`;
  try {
    const handle = await open(tmp, "w");
    try {
      await handle.writeFile(data, "utf-8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}
/**
 * 按项目串行化所有会话写操作，消除对 index.json / 会话文件的「读→改→写」交错
 * （后写覆盖先写丢字段、archivedCount 越界等）。同一进程内有效，覆盖单标签页/多标签页/
 * 自动起名+autosave+清理 等所有并发路径。公共 API 加锁；内部 *Impl 不加锁、只被锁内调用（防重入死锁）。
 */
const __projectWriteLock = new Map<string, Promise<unknown>>();
function withProjectLock<T>(projectDir: string, fn: () => Promise<T>): Promise<T> {
  const prev = __projectWriteLock.get(projectDir) ?? Promise.resolve();
  const next = prev.then(fn, fn); // 前一个成功或失败都继续，不让链断在异常上
  __projectWriteLock.set(projectDir, next.then(() => undefined, () => undefined));
  return next;
}

async function readRawIndex(projectDir: string): Promise<ChatSessionIndex | null> {
  const parsed = await readFile(chatSessionIndexPath(projectDir), "utf-8")
    .then((t) => JSON.parse(t) as unknown).catch(() => null);
  if (!parsed || typeof parsed !== "object") return null;
  const rec = parsed as Record<string, unknown>;
  if (!Array.isArray(rec.sessions) || typeof rec.activeSessionId !== "string") return null;
  const sessions = rec.sessions
    .filter((s): s is ChatSessionIndexEntry =>
      !!s && typeof (s as ChatSessionIndexEntry).id === "string")
    .map((s) => ({ id: s.id, name: String(s.name ?? "会话"), updatedAt: String(s.updatedAt ?? now()) }));
  return { sessions, activeSessionId: rec.activeSessionId };
}

const __failNextIndexWriteForTests = new Set<string>();
/** Test-only one-shot fault injection used to prove transaction rollback. */
export function failNextChatSessionIndexWriteForTests(projectDir: string): void {
  __failNextIndexWriteForTests.add(projectDir);
}

async function writeIndex(projectDir: string, index: ChatSessionIndex): Promise<void> {
  if (__failNextIndexWriteForTests.delete(projectDir)) {
    throw new Error("模拟 index 写入失败");
  }
  await mkdir(chatSessionsDir(projectDir), { recursive: true });
  await atomicWrite(chatSessionIndexPath(projectDir), `${JSON.stringify(index, null, 2)}\n`);
}

async function upsertIndexEntry(projectDir: string, entry: ChatSessionIndexEntry): Promise<void> {
  const current = (await readRawIndex(projectDir)) ?? { sessions: [], activeSessionId: "" };
  const sessions = current.sessions.filter((s) => s.id !== entry.id);
  sessions.unshift(entry);
  // localeCompare 是合法比较器（旧写法相等时永不返回 0，同毫秒条目排序随机翻转——复审 P3）
  sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const activeSessionId = current.activeSessionId || entry.id;
  await writeIndex(projectDir, { sessions, activeSessionId });
}

export async function readChatSession(projectDir: string, id: string): Promise<StoredChatSession | null> {
  const parsed = await readFile(chatSessionPath(projectDir, id), "utf-8")
    .then((t) => JSON.parse(t) as StoredChatSession).catch(() => null);
  if (!parsed) return null;
  return {
    ...parsed,
    messages: readWorkspaceMessages(parsed.messages),
    archivedCount: parsed.archivedCount ?? 0,
    windowEpoch: typeof parsed.windowEpoch === "number" ? parsed.windowEpoch : 0,
    coldArchivedCount: typeof parsed.coldArchivedCount === "number" ? parsed.coldArchivedCount : 0,
  };
}

export async function writeChatSession(projectDir: string, session: StoredChatSession): Promise<void> {
  await mkdir(chatSessionsDir(projectDir), { recursive: true });
  await atomicWrite(chatSessionPath(projectDir, session.id), `${JSON.stringify(session, null, 2)}\n`);
  await upsertIndexEntry(projectDir, { id: session.id, name: session.name, updatedAt: session.updatedAt });
}

/** 冷归档标记消息的固定 id：溢写后插在热窗头部，让用户看得见「更早的对话去哪了」。 */
export const COLD_ARCHIVE_MARKER_ID = "sys-cold-archive";

function buildColdArchiveMarker(totalArchived: number): StoredMessage {
  return {
    id: COLD_ARCHIVE_MARKER_ID,
    role: "system",
    content: `—— 更早的 ${totalArchived} 条对话已归档（没有丢失，随本书数据一起保存）——`,
  } as StoredMessage;
}

/**
 * 崩溃安全的 jsonl 追加：open("a") → 尾字节非换行先补 \n（自愈上次部分写留下的半行）→
 * write → fsync → close。fsync 保证「先冷后热」的持久化顺序真实成立（append 留在 page cache、
 * 热文件 rename 先落盘的断电窗口被关闭）。
 */
async function appendJsonlDurable(path: string, lines: readonly string[]): Promise<void> {
  if (lines.length === 0) return;
  const handle = await open(path, "a");
  try {
    const { size } = await handle.stat();
    if (size > 0) {
      const tail = Buffer.alloc(1);
      await handle.read(tail, 0, 1, size - 1);
      if (tail.toString("utf8") !== "\n") await handle.write("\n", size, "utf8");
    }
    await handle.write(`${lines.join("\n")}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * 「打开会话」时的整备（锁内调用）：结算僵尸 running 步骤 + 把热窗口外的旧消息溢写进冷归档。
 * 常态（窗口内、无僵尸步骤）零写盘零改动。溢写顺序先冷档（fsync）后热文件——崩溃最多冷档多一段重复，绝不丢消息。
 * archivedCount / prevArchivedCount 是 messages 的下标游标，随溢出量左移（含在冷段里的部分归零）。
 * 溢写后：windowEpoch+1（save 带过期纪元会被拒，防旧页全量回写）；热窗头部插入归档标记（用户可见，绝不静默搬走）。
 */
async function prepareSessionForDisplayImpl(
  projectDir: string,
  session: StoredChatSession,
): Promise<StoredChatSession> {
  const settledResult = settleInterruptedToolSteps(session.messages);

  // 旧归档标记先摘出来（不算业务消息，切片和游标都不该被它搅动）
  let messages = settledResult.messages;
  let archivedCount = session.archivedCount;
  let prevArchivedCount = session.prevArchivedCount;
  const markerIndex = messages.findIndex((message) => message.id === COLD_ARCHIVE_MARKER_ID);
  if (markerIndex >= 0) {
    messages = [...messages.slice(0, markerIndex), ...messages.slice(markerIndex + 1)];
    if (markerIndex < archivedCount) archivedCount = Math.max(0, archivedCount - 1);
    if (prevArchivedCount !== undefined && markerIndex < prevArchivedCount) {
      prevArchivedCount = Math.max(0, prevArchivedCount - 1);
    }
  }

  const start = computeHotWindowStart(messages);
  if (start === 0 && settledResult.settled === 0 && markerIndex < 0) return session;

  let windowEpoch = session.windowEpoch ?? 0;
  let coldArchivedCount = session.coldArchivedCount ?? 0;
  if (start > 0) {
    const cold = messages.slice(0, start);
    messages = messages.slice(start);
    await mkdir(chatSessionsDir(projectDir), { recursive: true });
    await appendJsonlDurable(
      chatSessionArchivePath(projectDir, session.id),
      cold.map((message) => JSON.stringify(message)),
    );
    archivedCount = Math.max(0, archivedCount - start);
    if (prevArchivedCount !== undefined) prevArchivedCount = Math.max(0, prevArchivedCount - start);
    windowEpoch += 1;
    coldArchivedCount += start;
  }
  if (coldArchivedCount > 0) {
    messages = [buildColdArchiveMarker(coldArchivedCount), ...messages];
    if (archivedCount > 0) archivedCount += 1; // 标记插在头部：已归档段边界随之右移一位
    if (prevArchivedCount !== undefined && prevArchivedCount > 0) prevArchivedCount += 1;
  }
  const next: StoredChatSession = {
    ...session,
    messages,
    archivedCount,
    ...(prevArchivedCount !== undefined ? { prevArchivedCount } : {}),
    windowEpoch,
    coldArchivedCount,
    updatedAt: now(),
  };
  await writeChatSession(projectDir, next);
  return next;
}

/** 整备失败绝不拖垮加载：降级返回原始会话（宁可这次不分层，也不给客户端一个 500——
 * 客户端把加载失败当空历史后，自动保存会把空数组写回来清空整段历史（50 章耐力书实测被炸）。 */
async function prepareSessionSafely(projectDir: string, session: StoredChatSession): Promise<StoredChatSession> {
  try {
    return await prepareSessionForDisplayImpl(projectDir, session);
  } catch (error) {
    console.warn("[chat-sessions] 会话整备失败，降级返回原始会话", { id: session.id, error });
    return session;
  }
}

/** 读单个会话并整备给前端显示（GET /api/chat-sessions?session=…）。 */
export function loadChatSessionForDisplay(projectDir: string, id: string): Promise<StoredChatSession | null> {
  return withProjectLock(projectDir, async () => {
    const session = await readChatSession(projectDir, id);
    if (!session) return null;
    return prepareSessionSafely(projectDir, session);
  });
}

async function createChatSessionImpl(projectDir: string, name = "新会话"): Promise<StoredChatSession> {
  const session = buildNewSession(name);
  await writeChatSession(projectDir, session);
  await setActiveChatSessionImpl(projectDir, session.id);
  return session;
}
export function createChatSession(projectDir: string, name = "新会话"): Promise<StoredChatSession> {
  return withProjectLock(projectDir, () => createChatSessionImpl(projectDir, name));
}

export function createChatSessionTransaction(
  projectDir: string,
  name = "新会话",
): Promise<{ readonly session: StoredChatSession; readonly index: ChatSessionIndex }> {
  return withProjectLock(projectDir, async () => {
    // create itself is the bootstrap on a fresh project. Reading raw state avoids
    // manufacturing a throwaway default session before the single committed index write.
    const current = (await readRawIndex(projectDir)) ?? { sessions: [], activeSessionId: "" };
    const session = buildNewSession(name);
    const sessions = [
      { id: session.id, name: session.name, updatedAt: session.updatedAt },
      ...current.sessions.filter((entry) => entry.id !== session.id),
    ].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    const index = { sessions, activeSessionId: session.id };
    await mkdir(chatSessionsDir(projectDir), { recursive: true });
    await atomicWrite(chatSessionPath(projectDir, session.id), `${JSON.stringify(session, null, 2)}\n`);
    try {
      await writeIndex(projectDir, index);
    } catch (error) {
      await rm(chatSessionPath(projectDir, session.id), { force: true });
      throw error;
    }
    return { session, index };
  });
}

async function renameChatSessionImpl(projectDir: string, id: string, name: string): Promise<ChatSessionIndex> {
  const session = await readChatSession(projectDir, id);
  if (!session) throw new Error(`会话不存在: ${id}`);
  await writeChatSession(projectDir, { ...session, name, updatedAt: now() });
  return readChatSessionIndexImpl(projectDir);
}
export function renameChatSession(projectDir: string, id: string, name: string): Promise<ChatSessionIndex> {
  return withProjectLock(projectDir, () => renameChatSessionImpl(projectDir, id, name));
}

async function setActiveChatSessionImpl(projectDir: string, id: string): Promise<ChatSessionIndex> {
  const current = (await readRawIndex(projectDir)) ?? { sessions: [], activeSessionId: "" };
  if (!current.sessions.some((s) => s.id === id)) throw new Error(`会话不存在: ${id}`);
  const next = { ...current, activeSessionId: id };
  await writeIndex(projectDir, next);
  return next;
}
export function setActiveChatSession(projectDir: string, id: string): Promise<ChatSessionIndex> {
  return withProjectLock(projectDir, () => setActiveChatSessionImpl(projectDir, id));
}

export function switchChatSessionTransaction(
  projectDir: string,
  id: string,
): Promise<{ readonly session: StoredChatSession; readonly index: ChatSessionIndex }> {
  return withProjectLock(projectDir, async () => {
    // 先完整确认目标可读，再改 active；读失败时 index 绝不变化。
    const current = await readChatSessionIndexImpl(projectDir);
    const stored = await readChatSession(projectDir, id);
    if (!stored || !current.sessions.some((entry) => entry.id === id)) throw new Error(`会话不存在: ${id}`);
    // 切到的会话要给前端显示 → 顺路整备（僵尸步骤结算 + 冷热分层）；整备会更新该会话的 index 条目，
    // 故 active 指针基于整备后重读的 index 写入，避免用旧副本回退排序。
    const session = await prepareSessionSafely(projectDir, stored);
    const refreshed = await readChatSessionIndexImpl(projectDir);
    const index = { ...refreshed, activeSessionId: id };
    await writeIndex(projectDir, index);
    return { session, index };
  });
}

async function deleteChatSessionTransactionImpl(
  projectDir: string,
  id: string,
): Promise<{ readonly session: StoredChatSession; readonly index: ChatSessionIndex }> {
  const current = await readChatSessionIndexImpl(projectDir);
  const target = await readChatSession(projectDir, id);
  if (!target || !current.sessions.some((session) => session.id === id)) {
    throw new Error(`会话不存在: ${id}`);
  }
  const sessions = current.sessions.filter((s) => s.id !== id);
  let replacement: StoredChatSession | null = null;
  let next: ChatSessionIndex;
  let nextActiveSession: StoredChatSession;
  if (sessions.length === 0) {
    replacement = buildNewSession();
    nextActiveSession = replacement;
    await mkdir(chatSessionsDir(projectDir), { recursive: true });
    await atomicWrite(chatSessionPath(projectDir, replacement.id), `${JSON.stringify(replacement, null, 2)}\n`);
    next = {
      sessions: [{ id: replacement.id, name: replacement.name, updatedAt: replacement.updatedAt }],
      activeSessionId: replacement.id,
    };
  } else {
    const activeSessionId = current.activeSessionId === id ? sessions[0].id : current.activeSessionId;
    // 所有可能失败的读取必须发生在删除/index mutation 之前。
    const active = await readChatSession(projectDir, activeSessionId);
    if (!active) throw new Error(`活跃会话不可读: ${activeSessionId}`);
    nextActiveSession = active;
    next = { sessions, activeSessionId };
  }

  let indexWritten = false;
  try {
    await writeIndex(projectDir, next);
    indexWritten = true;
    await rm(chatSessionPath(projectDir, id));
    // 冷归档随会话一起删（不删会永久残留孤儿 jsonl）；删除失败不致命。
    await rm(chatSessionArchivePath(projectDir, id), { force: true }).catch(() => undefined);
    // 删除已提交；接手显示的活跃会话顺路整备（失败不回滚删除，用原样返回兜底）。
    // index 返回整备后的重读值：整备会 bump 该会话 updatedAt/重排序，返回旧副本会让前端列表过时（复审 P2）。
    const displayed = await prepareSessionSafely(projectDir, nextActiveSession);
    const refreshed = await readChatSessionIndexImpl(projectDir).catch(() => next);
    return { index: refreshed, session: displayed };
  } catch (error) {
    if (indexWritten) {
      await atomicWrite(chatSessionPath(projectDir, id), `${JSON.stringify(target, null, 2)}\n`);
      await writeIndex(projectDir, current);
    }
    if (replacement) await rm(chatSessionPath(projectDir, replacement.id), { force: true });
    throw error;
  }
}
export function deleteChatSession(projectDir: string, id: string): Promise<ChatSessionIndex> {
  return withProjectLock(projectDir, async () => (await deleteChatSessionTransactionImpl(projectDir, id)).index);
}


export function deleteChatSessionTransaction(
  projectDir: string,
  id: string,
): Promise<{ readonly session: StoredChatSession; readonly index: ChatSessionIndex }> {
  return withProjectLock(projectDir, () => deleteChatSessionTransactionImpl(projectDir, id));
}

async function saveChatSessionMessagesImpl(
  projectDir: string,
  id: string,
  messages: unknown,
  clientWindowEpoch?: number,
): Promise<void> {
  const session = await readChatSession(projectDir, id);
  if (!session) throw new Error(`会话不存在: ${id}`);
  // 窗口纪元对账：冷热分层每次溢写 +1。带过期纪元的保存 = 旧页面/其他标签页手里的过期全量副本，
  // 无条件覆盖会把热文件撑回全量、游标错位、下次打开再重复归档。拒绝并让客户端刷新取真值。
  // 不带纪元（老客户端/兼容路径）放行——空守卫仍是最终防线。
  const serverEpoch = session.windowEpoch ?? 0;
  if (clientWindowEpoch !== undefined && clientWindowEpoch < serverEpoch) {
    throw new Error("已拒绝保存：这份会话在别处（其他页面/标签）整理过，本次提交的是过期副本。刷新页面即可继续，历史没有丢。");
  }
  const next = readWorkspaceMessages(messages);
  // 防误清守卫（50 章耐力书实测被炸）：会话加载瞬时失败时，客户端会把「空历史」当现状自动保存回来，
  // 空数组覆盖非空历史 = 不可逆全丢。如实拒绝（客户端只会看到一次保存失败，历史保住）；
  // 真要清空历史请走「新建会话 / 删除会话」这两条显式路径。
  if (next.length === 0 && session.messages.length > 0) {
    throw new Error(
      `已拒绝保存：空消息列表将覆盖该会话的 ${session.messages.length} 条历史（疑似加载失败后的误保存，非用户意图）。`,
    );
  }
  // 消息被替换/截断（如撤销回退到更早）后，旧游标可能落到新数组之外 → 收缩进合法范围，
  // 杜绝游标 > messages.length（活跃窗口 slice 出空数组、聊天历史凭空全丢）。prev 游标同夹（复审 P2：
  // 不夹的话「归档→回退→撤销归档」会把 archivedCount 恢复成越界旧值，AI 上下文静默变空）。
  const archivedCount = Math.min(session.archivedCount, next.length);
  const prevArchivedCount = session.prevArchivedCount === undefined
    ? undefined
    : Math.min(session.prevArchivedCount, next.length);
  await writeChatSession(projectDir, {
    ...session,
    messages: next,
    archivedCount,
    ...(prevArchivedCount !== undefined ? { prevArchivedCount } : {}),
    updatedAt: now(),
  });
}
export function saveChatSessionMessages(
  projectDir: string,
  id: string,
  messages: unknown,
  clientWindowEpoch?: number,
): Promise<void> {
  return withProjectLock(projectDir, () => saveChatSessionMessagesImpl(projectDir, id, messages, clientWindowEpoch));
}

async function bootstrapSessions(projectDir: string): Promise<void> {
  const cwDir = join(projectDir, ".story-engine-ui", "chapter-workspaces");
  const files = (await readdir(cwDir).catch(() => []))
    .filter((f) => /^chapter-\d+\.json$/u.test(f))
    .sort(); // 文件名零补齐 → 字典序即章号升序
  const merged: StoredMessage[] = [];
  for (const f of files) {
    const raw = await readFile(join(cwDir, f), "utf-8").then((t) => JSON.parse(t) as { messages?: unknown }).catch(() => null);
    const msgs = readWorkspaceMessages(raw?.messages);
    if (msgs.length === 0) continue;
    const chapterNum = Number(f.match(/\d+/u)![0]);
    merged.push({ id: `sys-mig-${chapterNum}`, role: "system", content: `— 第 ${chapterNum} 章 —` } as StoredMessage);
    merged.push(...msgs);
  }
  if (merged.length === 0) {
    await createChatSessionImpl(projectDir, "新会话");
    return;
  }
  const ts = now();
  const session: StoredChatSession = { id: newId(), name: "(旧)按章对话合并", messages: merged, archivedCount: 0, createdAt: ts, updatedAt: ts };
  await writeChatSession(projectDir, session);
  await setActiveChatSessionImpl(projectDir, session.id);
}

async function readChatSessionIndexImpl(projectDir: string): Promise<ChatSessionIndex> {
  let index = await readRawIndex(projectDir);
  if (!index || index.sessions.length === 0) {
    await bootstrapSessions(projectDir);
    index = await readRawIndex(projectDir);
  }
  return index!;
}
export function readChatSessionIndex(projectDir: string): Promise<ChatSessionIndex> {
  return withProjectLock(projectDir, () => readChatSessionIndexImpl(projectDir));
}

function activeTokens(messages: StoredMessage[], cursor: number): number {
  return estimateTokens(messages.slice(cursor).map((m) => m.content ?? "").join("\n"));
}

export function computeArchiveCursor(
  messages: StoredMessage[], budgetTokens: number, targetRatio = 0.55, keepRecent = 6,
): number {
  const target = budgetTokens * targetRatio;
  const maxCursor = Math.max(0, messages.length - keepRecent);
  let cursor = 0;
  while (cursor < maxCursor && activeTokens(messages, cursor) > target) cursor++;
  return cursor;
}

async function archiveOldMessagesImpl(
  projectDir: string, id: string, budgetTokens: number,
): Promise<{ archivedCount: number; tokensBefore: number; tokensAfter: number }> {
  const session = await readChatSession(projectDir, id);
  if (!session) throw new Error(`会话不存在: ${id}`);
  const tokensBefore = activeTokens(session.messages, session.archivedCount);
  const cursor = Math.max(session.archivedCount, computeArchiveCursor(session.messages, budgetTokens));
  await writeChatSession(projectDir, {
    ...session, prevArchivedCount: session.archivedCount, archivedCount: cursor, updatedAt: now(),
  });
  return { archivedCount: cursor, tokensBefore, tokensAfter: activeTokens(session.messages, cursor) };
}
export function archiveOldMessages(
  projectDir: string, id: string, budgetTokens: number,
): Promise<{ archivedCount: number; tokensBefore: number; tokensAfter: number }> {
  return withProjectLock(projectDir, () => archiveOldMessagesImpl(projectDir, id, budgetTokens));
}

async function unarchiveLastImpl(projectDir: string, id: string): Promise<{ archivedCount: number }> {
  const session = await readChatSession(projectDir, id);
  if (!session) throw new Error(`会话不存在: ${id}`);
  // 双保险夹紧：prev 游标若因历史数据越界，恢复时也绝不能超过消息数（否则活跃上下文静默变空）。
  const restored = Math.min(session.prevArchivedCount ?? 0, session.messages.length);
  await writeChatSession(projectDir, { ...session, archivedCount: restored, prevArchivedCount: undefined, updatedAt: now() });
  return { archivedCount: restored };
}
export function unarchiveLast(projectDir: string, id: string): Promise<{ archivedCount: number }> {
  return withProjectLock(projectDir, () => unarchiveLastImpl(projectDir, id));
}
