/**
 * 后台补读（2026-10-12 T5 长书）：老书第一次用专员（或笔记被改动作废）时，后台按顺序把前文笔记补齐。
 *
 * 补读本身还是 ensureReaderWindow（同一本书同一角色进程内排队，笔记按章落盘）；这里只加三件事：
 *   - 进度写盘（agents/<角色>/progress.json）：读到第几章、共几章、还剩没剩错。界面靠现有的 workspace 刷新（state-overview）看它，
 *     不新开轮询；
 *   - 进程内去重：已经在补就不重复排一遍（服务重启后 progress 残留 reading=true 也照样接着补——笔记在盘上，不会从头来）；
 *   - 每本书一条共用队列（2026-10-12 R1）：三个角色依次补（checker → ledger → planner），
 *     不同时并发打模型服务商；不同轮次也按先来后到排在这条队上。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { callConfiguredBrainModel } from "./checker.js";
import { ensureReaderWindow, writeAtomically, type BrainCallModel, type ReaderRole } from "./reader-window.js";

export interface ReaderProgress {
  readonly role: string;
  /** 还在补吗。 */
  readonly reading: boolean;
  /** 已经有有效笔记的章数（读到第几章）。 */
  readonly done: number;
  /** 这轮要读到第几章。 */
  readonly total: number;
  readonly updatedAt: string;
  /** 上一次补读没成的原因（接着补成功就不带）。 */
  readonly error?: string;
}

const progressFile = (root: string, roleId: string): string => join(root, "agents", roleId, "progress.json");

const writeProgress = (root: string, progress: ReaderProgress): Promise<void> =>
  writeAtomically(progressFile(root, progress.role), `${JSON.stringify(progress, null, 2)}\n`);

/** 读一个角色的补读进度；没写过 / 文件坏了返回 undefined。 */
export async function readReaderProgress(notesRoot: string, roleId: string): Promise<ReaderProgress | undefined> {
  try {
    const parsed = JSON.parse(await readFile(progressFile(notesRoot, roleId), "utf-8")) as Partial<ReaderProgress>;
    if (typeof parsed.done !== "number" || typeof parsed.total !== "number" || typeof parsed.reading !== "boolean") return undefined;
    return {
      role: roleId,
      reading: parsed.reading,
      done: Math.max(0, Math.floor(parsed.done)),
      total: Math.max(0, Math.floor(parsed.total)),
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
      ...(typeof parsed.error === "string" && parsed.error ? { error: parsed.error } : {}),
    };
  } catch {
    return undefined;
  }
}

/** 正在补的角色（进程内）：同一本书同一角色只排一个，后来的直接回。 */
const activeCatchUps = new Set<string>();

/** 每本书一条补读队列（R1）：三个角色共用，按角色依次补，不同时并发打模型。 */
const bookCatchUpQueues = new Map<string, Promise<unknown>>();

/** 同一本书的补读任务排成一条队：先来后到，一条跑完再跑下一条（前一条失败不拦后面的）。 */
export async function runInReaderCatchUpQueue<T>(root: string, task: () => Promise<T>): Promise<T> {
  const previous = bookCatchUpQueues.get(root) ?? Promise.resolve();
  const current = previous.then(task);
  const tail = current.catch(() => undefined);
  bookCatchUpQueues.set(root, tail);
  try {
    return await current;
  } finally {
    if (bookCatchUpQueues.get(root) === tail) bookCatchUpQueues.delete(root);
  }
}

/** 已排队 / 在跑的补读目标（书目录＋角色组 → 要读到的章）。 */
const queuedCatchUps = new Map<string, number>();

const catchUpQueueKey = (root: string, roles: readonly string[]): string => `${root}\u0000${[...roles].sort().join(",")}`;

/** 这本书这组角色已有一轮要读到 ≥ upTo 的补读在队里 → 不用再排一轮（角色不同不算，照排）。 */
export function isReaderCatchUpQueued(root: string, roles: readonly string[], upTo: number): boolean {
  const queued = queuedCatchUps.get(catchUpQueueKey(root, roles));
  return queued !== undefined && queued >= upTo;
}

/** 登记 / 撤销一轮补读目标（catchUpReaders 用；导出供测试确认队列状态）。 */
export function markReaderCatchUpQueued(root: string, roles: readonly string[], upTo: number): void {
  const key = catchUpQueueKey(root, roles);
  queuedCatchUps.set(key, Math.max(queuedCatchUps.get(key) ?? 0, upTo));
}

export function unmarkReaderCatchUpQueued(root: string, roles: readonly string[], upTo: number): void {
  const key = catchUpQueueKey(root, roles);
  if (queuedCatchUps.get(key) === upTo) queuedCatchUps.delete(key); // 只撤自己那轮：后面排的更大目标还在
}

/**
 * 后台补一个角色的前文笔记到第 upTo 章，进度落盘。失败不抛（调用方放心 void）：如实写进 progress 的 error，
 * 已补的笔记都在盘上，下次接着补（服务重启也一样——按笔记文件接着来，不从头读）。
 */
export async function startReaderCatchUp(
  projectDir: string,
  role: ReaderRole,
  upTo: number,
  options: { readonly callModel?: BrainCallModel; readonly notesRoot?: string } = {},
): Promise<void> {
  const root = options.notesRoot ?? projectDir;
  const key = `${root}\u0000${role.id}`;
  if (activeCatchUps.has(key)) return;
  activeCatchUps.add(key);
  let readThrough = 0;
  try {
    // 接着上次的进度标（重启 / 上次没成后 done 已经在盘上），别把界面上看到的章数打回 0。
    const previous = await readReaderProgress(root, role.id);
    const total = Math.max(upTo, previous?.total ?? 0);
    await writeProgress(root, {
      role: role.id,
      reading: true,
      done: Math.min(previous?.done ?? 0, total),
      total,
      updatedAt: new Date().toISOString(),
    });
    await ensureReaderWindow({
      projectDir,
      role,
      upTo,
      callModel: options.callModel ?? callConfiguredBrainModel,
      ...(options.notesRoot ? { notesRoot: options.notesRoot } : {}),
      onProgress: async (chapter) => {
        // 每读完一章落一次盘（等落完再写下一章，进度不回跳）：界面刷新（开书、各工具回包）就能看到最新进度。
        await writeProgress(root, { role: role.id, reading: true, done: chapter, total, updatedAt: new Date().toISOString() })
          .catch(() => undefined);
      },
    }).then((result) => {
      // 读到第几章如实记（某章定稿读不到时 ensure 会停在它前一章，不能谎报读到了 upTo）。
      readThrough = result.readThrough;
    });
    await writeProgress(root, {
      role: role.id,
      reading: false,
      done: readThrough,
      total,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    // 失败如实：读到哪里记哪里，下次接着补。
    console.warn(`[brain] ${role.id} 后台补读没成（不影响别的，下次接着补）`, error);
    const done = await readReaderProgress(root, role.id);
    await writeProgress(root, {
      role: role.id,
      reading: false,
      done: done?.done ?? 0,
      total: done?.total ?? upTo,
      updatedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => undefined);
  } finally {
    activeCatchUps.delete(key);
  }
}
