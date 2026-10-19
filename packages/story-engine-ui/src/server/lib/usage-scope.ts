/**
 * 用量记在哪本书名下（P10）：调模型的地方不知道是哪本书，从调用上下文带（AsyncLocalStorage）。
 *
 * - 每个 HTTP 请求开一个空范围（dev-api 里挂在安全闸后面），路由过项目路径闸（guardProjectPath）时记下书；
 *   这个请求里排的后台活（补读、记账、自动备份）都在同一个范围里，记到同一本书。
 * - 后台补读、通读记账另外显式带上书（withUsageBook），开书时排的活也不丢。
 * 这里只放范围，不引别的模块：项目读写层要引它，用量账本身在 usage-ledger.ts。
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { resolve } from "node:path";

interface UsageScope {
  book?: string;
}

const storage = new AsyncLocalStorage<UsageScope>();

/** 开一个还不知道书的范围（每个 HTTP 请求一个）。 */
export function runInUsageScope<T>(fn: () => T): T {
  return storage.run({}, fn);
}

/** 在明确知道书的范围里跑（后台补读、通读记账）。 */
export function withUsageBook<T>(projectDir: string, fn: () => T): T {
  return storage.run({ book: resolve(projectDir) }, fn);
}

/** 路由过项目路径闸时记下这次请求是哪本书（一个请求只认第一本）。不在范围里就不记。 */
export function noteUsageBook(projectDir: string): void {
  const scope = storage.getStore();
  if (scope && !scope.book) scope.book = resolve(projectDir);
}

/** 当前调用属于哪本书；不知道是 undefined。 */
export function currentUsageBook(): string | undefined {
  return storage.getStore()?.book;
}
