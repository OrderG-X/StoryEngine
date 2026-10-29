/**
 * 配方登记（写作版本 P2a）：服务起来时调一次 `registerBuiltInRecipes`（dev-api），把配方登记进执行器，
 * 再给编辑部的补读提交口（`lib/reader-backfill.ts`）接上处理函数。导入后的通读记账（background.reread）的几个入口也在这里。
 */
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { bookKey } from "@actalk/story-core";
import { READER_ROLE_IDS } from "../../../editorial/index.js";
import { latestReread, REREAD_KIND, rereadStateOf } from "../../../editorial/reread-state.js";
import { BACKFILL_KIND, readBackfillParams, setReaderBackfillHandler, type ReaderBackfillRequest } from "../../../lib/reader-backfill.js";
import { listOperations, type OperationRecord } from "../../../lib/operations/store.js";
import { registerRecipe, resumeOperation, submitOperation } from "../executor.js";
import { backgroundBackfillRecipe } from "./background-backfill.js";
import { backgroundRereadRecipe } from "./background-reread.js";
import { draftAdoptRecipe, draftDiscardRecipe } from "./draft-candidate.js";
import { draftChangeRecipe } from "./draft-change.js";
import { inspectRunRecipe } from "./inspect-run.js";
import { ledgerChangeRecipe } from "./ledger-change.js";
import { canonProposeRecipe } from "./canon-propose.js";
import { planProposeRecipe } from "./plan-propose.js";
import { settingsChangeRecipe } from "./settings-change.js";

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

/** 交一次通读记账：记到第 total 章（导入时的章数）。不受理返回一句原因。 */
async function submitReread(bookDir: string, total: number): Promise<string | undefined> {
  const outcome = await submitOperation(bookDir, {
    kind: REREAD_KIND,
    params: { total },
    requestKey: randomUUID(),
    issuedAt: new Date().toISOString(),
    origin: { kind: "button" },
  });
  return outcome.ok ? undefined : outcome.message;
}

/** 导入已写的书之后开一轮通读记账（受理了就返回，在后台跑）。没受理抛错（导入那边整本删掉、如实报错）。 */
export async function startReread(bookDir: string, total: number): Promise<void> {
  const refused = await submitReread(bookDir, total);
  if (refused) throw new Error(`通读记账没开始：${refused}`);
}

export type ContinueRereadOutcome =
  | { readonly ok: true; readonly status: "running" | "done" }
  | { readonly ok: false; readonly message: string };

/**
 * 作者在进度行点「接着记」：停着的（结果不明、额度到了、软件关过）接着做这一次；没成、停掉、作废的交一次新的
 * （记到同样的章，已经记上的章不再记）；在记的不动。这本书没通读过如实说。
 */
export async function continueReread(bookDir: string): Promise<ContinueRereadOutcome> {
  const latest = latestReread(await listOperations(bookDir));
  const state = latest ? rereadStateOf(latest) : undefined;
  if (!latest || !state) return { ok: false, message: "这本书没有在通读记账。" };
  if (state.status === "done") return { ok: true, status: "done" };
  if (latest.state === "queued" || latest.state === "running") return { ok: true, status: "running" };
  if (latest.state === "paused") {
    const resumed = await resumeOperation(bookDir, latest.opId);
    return resumed.ok ? { ok: true, status: "running" } : { ok: false, message: resumed.message };
  }
  const refused = await submitReread(bookDir, state.total);
  return refused ? { ok: false, message: refused } : { ok: true, status: "running" };
}

/**
 * 升级前（0.2.5 及以前）导入的书：通读状态记在 `agents/ledger/reread.json`。开书时转一次：没记完的交一次通读记账
 * （已经记上的章不再记），然后删掉那个文件；已经记完的直接删。转不成只记日志、文件留着，下次开书再转。
 */
export async function migrateLegacyRereadState(bookDir: string): Promise<void> {
  const file = join(bookDir, "agents", "ledger", "reread.json");
  let legacy: { readonly status?: unknown; readonly total?: unknown };
  try {
    legacy = JSON.parse(await readFile(file, "utf-8")) as typeof legacy;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn("[reread] 升级前的通读状态读不出来，没转", error);
    return;
  }
  try {
    const pending = legacy.status === "running" || legacy.status === "stopped";
    if (pending && !latestReread(await listOperations(bookDir)) && typeof legacy.total === "number") {
      const refused = await submitReread(bookDir, legacy.total);
      if (refused) {
        console.warn(`[reread] 升级前没记完的通读没转成：${refused}`);
        return;
      }
    }
    await rm(file, { force: true });
  } catch (error) {
    console.warn("[reread] 升级前的通读状态没转成（下次开书再转）", error);
  }
}

export function registerBuiltInRecipes(): void {
  registerRecipe(backgroundBackfillRecipe);
  registerRecipe(backgroundRereadRecipe);
  registerRecipe(inspectRunRecipe);
  registerRecipe(draftChangeRecipe);
  registerRecipe(draftAdoptRecipe);
  registerRecipe(draftDiscardRecipe);
  registerRecipe(planProposeRecipe);
  registerRecipe(settingsChangeRecipe);
  registerRecipe(ledgerChangeRecipe);
  registerRecipe(canonProposeRecipe);
  setReaderBackfillHandler(submitBackfill);
}
