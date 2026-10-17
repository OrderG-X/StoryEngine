/**
 * 每本书一把写锁（进程内）：同一本书的写命令排队一个个来。读不拿锁。
 *
 * 桌面版只有一个服务进程，进程内的锁就够；同一本书换个写法的路径（软链、相对路径）归到同一把锁。
 */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

const tails = new Map<string, Promise<void>>();

export function bookKey(bookDir: string): string {
  try {
    return realpathSync.native(bookDir);
  } catch {
    return resolve(bookDir);
  }
}

export async function withBookLock<T>(bookDir: string, task: () => Promise<T>): Promise<T> {
  const key = bookKey(bookDir);
  const previous = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const tail = previous.then(() => gate);
  tails.set(key, tail);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}
