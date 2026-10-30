/**
 * 界面服务端取真相依据只走这里（写作版本 P1 第 7 轮复核 U3；源码扫描挡别处直接调核心的读依据）。
 *
 * **依据在书锁里取**（第 8 轮复核 V2）：写真相的命令整个在书锁里，锁里读不到「真相写了一半、版本号还没换」的中间态。
 * 取之前先收拾写到一半的事务（P1 第 17 轮），收拾不了如实说、不给依据。
 * 取到之后真相再变，依据就对不上，产物照依据作废。读者的材料都从真相现算（P2b 删了镜像），没有「落后」这回事。
 */
import { readTruthBasis, withBookLock, withSettledBook, type BasisChange, type TruthBasis } from "@actalk/story-core";

/** 书上有写到一半、收拾不了的事务：这时不给依据。 */
export class BookUnsettledError extends Error {
  constructor(reason: string) {
    super(`上次写到一半的记录还没收拾好（${reason}），这次没做`);
    this.name = "BookUnsettledError";
  }
}

/** 书锁里：先收拾半截事务，再取依据。 */
async function settledBasis(projectDir: string): Promise<TruthBasis> {
  const settled = await withSettledBook(projectDir, () => readTruthBasis(projectDir));
  if (!settled.ok) throw new BookUnsettledError(settled.message);
  return settled.value;
}

/**
 * 要挂到产物上的依据（出稿开写、改稿、定论 / 改账 / 改设定 / 定稿票、去 AI 味）：在读任何材料**之前**取。
 * 收拾不了半截事务抛 BookUnsettledError。短拿书锁（可重入：在书锁里调也行）。
 */
export async function readTruthBasisForWork(projectDir: string): Promise<TruthBasis> {
  return settledBasis(projectDir);
}

/**
 * 按内容复用的缓存（核账记忆、章纲）读材料：读之前、读之后各在书锁里取一次依据，两次一样才给依据；
 * 中途书上有写（哪怕又改回原样，代次也换了）、收拾不了半截事务，就照常返回材料、不给依据（缓存不存、不复用）。
 */
export async function readWithStableBasisForWork<T>(projectDir: string, read: () => Promise<T>): Promise<{ readonly value: T; readonly basis?: TruthBasis }> {
  const before = await settledBasis(projectDir).catch(() => undefined);
  const value = await read();
  if (!before) return { value };
  const after = await withBookLock(projectDir, () => readTruthBasis(projectDir)).catch(() => undefined);
  return after?.digest === before.digest ? { value, basis: before } : { value };
}

/** 只用来比「书现在和那份依据一样不一样」，不挂到任何产物上。 */
export async function readTruthBasisToCompare(projectDir: string): Promise<TruthBasis> {
  return readTruthBasis(projectDir);
}

/** 依据变了哪些 → 给作者看的一句（只有章号和「设定本 / 作者裁定」，不带编号）。 */
export function describeBasisChanges(changes: readonly BasisChange[]): string {
  const parts: string[] = [];
  const chapters = (kind: "text" | "ledger") =>
    [...new Set(changes.flatMap((change) => (change.kind === kind ? [change.chapter] : [])))].sort((a, b) => a - b);
  const list = (numbers: readonly number[]): string =>
    numbers.length > 4 ? `第 ${numbers.slice(0, 4).join("、")} 等 ${numbers.length} 章` : `第 ${numbers.join("、")} 章`;
  const texts = chapters("text");
  const ledgers = chapters("ledger").filter((chapter) => !texts.includes(chapter));
  if (texts.length > 0) parts.push(`${list(texts)}的定稿正文`);
  if (ledgers.length > 0) parts.push(`${list(ledgers)}的账`);
  if (changes.some((change) => change.kind === "cards")) parts.push("设定本");
  if (changes.some((change) => change.kind === "decisions")) parts.push("作者裁定");
  return parts.length > 0 ? parts.join("、") : "书里的内容";
}
