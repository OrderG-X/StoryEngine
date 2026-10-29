/**
 * 单测：等一次操作的记录到某个样子。盘上先换上、调度表和订阅在落盘之后才更新，所以看到盘上对了还要拿一次锁，
 * 等写这一笔的那一方整个做完（负载重时只看盘会和进程内的登记错开）。按截止时间等，不按次数。
 */
import { readOperation, withBookThenRecord, type OperationRecord } from "./store.js";

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
