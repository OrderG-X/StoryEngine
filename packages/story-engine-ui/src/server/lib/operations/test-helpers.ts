/**
 * 单测：等一次操作的记录到某个样子。盘上先换上、调度表和订阅在落盘之后才更新，所以看到盘上对了还要拿一次锁，
 * 等写这一笔的那一方整个做完（负载重时只看盘会和进程内的登记错开）。按截止时间等，不按次数。
 */
import { randomUUID } from "node:crypto";
import { acceptOperation, changeOperation, readOperation, withBookThenRecord, type OperationRecord, type OperationState } from "./store.js";

export const SETTLED_STATES: readonly string[] = ["succeeded", "failed", "cancelled", "obsolete", "paused"];

export async function untilOperation(
  bookDir: string,
  opId: string,
  matches: (record: OperationRecord) => boolean,
  timeoutMs = 20_000,
): Promise<OperationRecord> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const stored = await readOperation(bookDir, opId);
    if (stored.kind === "record" && matches(stored.record)) {
      await withBookThenRecord(bookDir, opId, async () => undefined);
      const settled = await readOperation(bookDir, opId);
      if (settled.kind === "record") return settled.record;
    }
    if (Date.now() > deadline) throw new Error(`没等到操作 ${opId} 到要的样子`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * 单测：直接在书里落一条某类操作的记录（不跑配方，按合法的状态转换一路换到 state；缺省 queued）。
 * patch 在最后一步一起写上（停着的原因、失败原因、已落盘的效果……）。
 */
export async function seedOperation(
  bookDir: string,
  input: { readonly kind: string; readonly params: unknown; readonly state?: OperationState; readonly patch?: Partial<OperationRecord> },
): Promise<OperationRecord> {
  const accepted = await acceptOperation(bookDir, {
    requestKey: randomUUID(),
    issuedAt: new Date().toISOString(),
    kind: input.kind,
    params: input.params,
    recipeVersion: 1,
    origin: { kind: "background" },
    writeScope: { chapters: [] },
    budget: { limit: 0 },
  }, { bookEpoch: async () => "seed" });
  if (!accepted.ok || !("record" in accepted)) throw new Error("单测落操作记录没受理");
  const state = input.state ?? "queued";
  const path: OperationState[] = state === "queued" ? [] : state === "paused" || state === "cancelled" ? [state] : ["running", state];
  let record = accepted.record;
  for (const [index, next] of path.entries()) {
    const last = index === path.length - 1;
    const changed = await changeOperation(bookDir, record.opId, (current) => ({ ...current, state: next, ...(last ? input.patch : {}) }));
    if (!changed) throw new Error("单测换操作状态没成");
    record = changed;
  }
  if (path.length === 0 && input.patch) record = (await changeOperation(bookDir, record.opId, (current) => ({ ...current, ...input.patch }))) ?? record;
  return record;
}
