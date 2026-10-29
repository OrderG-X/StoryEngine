/**
 * 配方登记（写作版本 P2a）：服务起来时调一次 `registerBuiltInRecipes`（dev-api），把配方登记进执行器，
 * 再给编辑部的补读提交口（`lib/reader-backfill.ts`）接上处理函数。
 */
import { randomUUID } from "node:crypto";
import { bookKey } from "@actalk/story-core";
import { READER_ROLE_IDS } from "../../../editorial/index.js";
import { BACKFILL_KIND, readBackfillParams, setReaderBackfillHandler, type ReaderBackfillRequest } from "../../../lib/reader-backfill.js";
import { listOperations, type OperationRecord } from "../../../lib/operations/store.js";
import { registerRecipe, submitOperation } from "../executor.js";
import { backgroundBackfillRecipe } from "./background-backfill.js";
import { inspectRunRecipe } from "./inspect-run.js";

/** 同一本书交后台补读排成一条（两个请求同时到，不会各受理一次）。 */
const backfillChains = new Map<string, Promise<unknown>>();

const rolesOf = (record: OperationRecord): readonly string[] => readBackfillParams(record.params)?.ranges.map((range) => range.role) ?? [];

/**
 * 交一次后台补读，按角色排（Astra P2a 第 8 轮第 2、6 条）：
 * - 某个角色的补读**停着**（结果不明、额度到了、被打断）：这个角色等作者处理，不另起一份把可能已经计费的调用自动重发一遍；
 * - 某个角色**正在补**（排着 / 跑着）：不另起一份跟它抢，它跑完会按它那几个角色再看一眼（读的途中新定稿的章在那一次里补）；
 * - 其余要补的角色：交一份新的，冻结它们各自还差的范围和额度（和正在补的别的角色同时排在这本书的补读队上，不同时打模型）。
 * 不受理（都读齐了、没配模型）不算错。
 */
export async function submitBackfill(bookDir: string, request: ReaderBackfillRequest): Promise<void> {
  const key = bookKey(bookDir);
  const previous = backfillChains.get(key) ?? Promise.resolve();
  const current = previous.then(async () => {
    const backfills = (await listOperations(bookDir)).filter((record) => record.kind === BACKFILL_KIND);
    const taken = new Set(backfills
      .filter((record) => record.state === "queued" || record.state === "running" || record.state === "paused")
      .flatMap(rolesOf));
    const roles = (request.roles ?? READER_ROLE_IDS).filter((role) => !taken.has(role));
    if (roles.length === 0) return;
    await submitOperation(bookDir, {
      kind: BACKFILL_KIND,
      params: { roles, upTo: request.upTo },
      requestKey: randomUUID(),
      issuedAt: new Date().toISOString(),
      origin: { kind: "background" },
    });
  });
  const tail = current.catch(() => undefined);
  backfillChains.set(key, tail);
  try {
    await current;
  } finally {
    if (backfillChains.get(key) === tail) backfillChains.delete(key);
  }
}

/** 单测：等这个进程里排着的补读提交都交完。等过返回 true。 */
export async function __drainBackfillSubmissionsForTests(): Promise<boolean> {
  if (backfillChains.size === 0) return false;
  while (backfillChains.size > 0) await Promise.all([...backfillChains.values()]);
  return true;
}

export function registerBuiltInRecipes(): void {
  registerRecipe(backgroundBackfillRecipe);
  registerRecipe(inspectRunRecipe);
  setReaderBackfillHandler(submitBackfill);
}
