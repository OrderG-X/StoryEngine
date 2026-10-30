/**
 * 撤销 / 恢复这类不走 runner、直接换文件的，换完在书锁里调 bumpRevision：写入代次和工作稿纪元一起换新（store/control.ts）。
 * runner 自己把写入代次和真相放在同一个事务里写。
 */
import { withBookLock } from "./lock.js";
import { bookEpochWrite, freshDraftGensWrite, revisionWrite } from "./control.js";
import { commitFiles } from "./transaction.js";

export { revisionWrite } from "./control.js";

/**
 * 换一个新代次：之前记下的依据全部对不上（撤销 / 恢复后，按那之前算的预览一律作废），各章工作稿的版本号也全换。
 * bookEpoch：书的纪元也换（从备份、回收站搬回来：之前受理的操作一律不能再写，写作版本 P2a）。
 */
export async function bumpRevision(bookDir: string, now: Date = new Date(), options: { readonly bookEpoch?: boolean } = {}): Promise<void> {
  await withBookLock(bookDir, () => commitFiles(bookDir, [revisionWrite(now), freshDraftGensWrite(), ...(options.bookEpoch ? [bookEpochWrite(now)] : [])]));
}
