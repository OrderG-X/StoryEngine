/**
 * 每本书一把写锁（进程内）：同一本书的写命令排队一个个来。读不拿锁。
 *
 * 桌面版只有一个服务进程，进程内的锁就够；同一本书换个写法的路径（软链、相对路径）归到同一把锁。
 * 可重入（重构 P7）：拿着锁的这条调用链里再要同一本书的锁直接进（比如出稿先打存档点、再走 draft.applyGenerated），
 * 服务端各处的「项目写锁」都归到这一把，不再有两把锁互相等。锁放开以后才跑起来的后续（没 await 的 promise）
 * 不算还拿着锁，要重新排队。
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

const tails = new Map<string, Promise<void>>();

interface HeldBooks {
  readonly books: ReadonlySet<string>;
  active: boolean;
}
const held = new AsyncLocalStorage<HeldBooks>();

export function bookKey(bookDir: string): string {
  try {
    return realpathSync.native(bookDir);
  } catch {
    return resolve(bookDir);
  }
}

export async function withBookLock<T>(bookDir: string, task: () => Promise<T>): Promise<T> {
  const key = bookKey(bookDir);
  const current = held.getStore();
  if (current?.active && current.books.has(key)) return task();
  const previous = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const tail = previous.then(() => gate);
  tails.set(key, tail);
  await previous;
  const context: HeldBooks = { books: new Set([...(current?.books ?? []), key]), active: true };
  try {
    return await held.run(context, task);
  } finally {
    context.active = false;
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}
