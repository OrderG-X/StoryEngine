/**
 * 书的写入代次（写作版本 P1a，见 paths.ts 的 REVISION_PATH 和 basis.ts）：每次写真相都换一个新的随机号。
 * runner 把它和真相放在同一个事务里写；撤销 / 恢复这类不走 runner、直接换文件的，换完在书锁里调 bumpRevision。
 */
import { randomUUID } from "node:crypto";
import { withBookLock } from "./lock.js";
import { REVISION_PATH } from "./paths.js";
import { commitFiles, type TxWrite } from "./transaction.js";

export function revisionWrite(now: Date): TxWrite {
  return { path: REVISION_PATH, content: `${JSON.stringify({ schema: "store-revision/1", id: randomUUID(), at: now.toISOString() }, null, 2)}\n` };
}

/** 换一个新代次：之前记下的依据全部对不上（撤销 / 恢复后，按那之前算的预览一律作废）。 */
export async function bumpRevision(bookDir: string, now: Date = new Date()): Promise<void> {
  await withBookLock(bookDir, () => commitFiles(bookDir, [revisionWrite(now)]));
}
