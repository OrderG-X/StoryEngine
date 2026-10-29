/**
 * 界面服务端取真相依据只走这里（写作版本 P1 第 7 轮复核 U3；源码扫描挡别处直接调核心的读依据）。
 *
 * 老格式镜像（时间线、线索、事实那几份）是从真相生成的投影：写完真相之后、同步镜像之前有一小段落后，
 * 同步没成就一直落后。写手、专员读的不少材料还在镜像里，照落后的镜像读出来的东西挂上新依据，换上、确认时就核不出来。
 * 所以挂到产物上的依据，取的时候镜像必须正是这一版的。
 *
 * **依据在书锁里取**（第 8 轮复核 V2）：写真相的命令整个在书锁里，锁里读不到「真相写了一半、版本号还没换」的中间态；
 * 镜像落后就在同一把锁里同步（镜像同步一律在书锁里，见 mirror/sync.ts），同步完镜像就是这一版的。
 * 改设定卡只涨版本号、不同步镜像，也在这里补上。同步没成（写盘失败）如实说、不给依据。
 * 取到之后真相再变，依据就对不上，产物照依据作废——不用管镜像后来怎样。
 */
import { listChapterLedgers, readHead, readTruthBasis, withBookLock, type BasisChange, type TruthBasis } from "@actalk/story-core";
import { readMirrorVersion, syncLegacyMirror } from "./mirror/sync.js";

export const MIRROR_LAG_MESSAGE = "按账整理的时间线和线索还没跟上刚改的账（同步没成），这次没做。稍后再试一次";

/** 镜像没跟上真相：这时读出的材料不能挂依据。 */
export class MirrorLagError extends Error {
  constructor() {
    super(MIRROR_LAG_MESSAGE);
    this.name = "MirrorLagError";
  }
}

/**
 * 镜像是不是这一版的。书还没上新核心（版本 0）、还没有账单（新书没定稿过、老书没导入）不生成镜像（同开书 ensure.ts），
 * 读到的老文件就是材料本身，不算落后。
 */
async function mirrorInStep(projectDir: string): Promise<boolean> {
  const head = (await readHead(projectDir)).version;
  if (head === 0 || (await readMirrorVersion(projectDir)) === head) return true;
  return (await listChapterLedgers(projectDir)).length === 0;
}

/** 书锁里：镜像落后就同步一次，跟上了给依据；同步没成返回 undefined。 */
function basisInStep(projectDir: string): Promise<TruthBasis | undefined> {
  return withBookLock(projectDir, async () => {
    if (!(await mirrorInStep(projectDir))) await syncLegacyMirror(projectDir).catch(() => undefined);
    return (await mirrorInStep(projectDir)) ? readTruthBasis(projectDir) : undefined;
  });
}

/**
 * 要挂到产物上的依据（出稿开写、改稿、定论 / 改账 / 改设定 / 定稿票、去 AI 味）：在读任何材料**之前**取。
 * 镜像跟不上抛 MirrorLagError。短拿书锁（可重入：在书锁里调也行）。
 */
export async function readTruthBasisForWork(projectDir: string): Promise<TruthBasis> {
  const basis = await basisInStep(projectDir);
  if (!basis) throw new MirrorLagError();
  return basis;
}

/**
 * 按内容复用的缓存（核账记忆、章纲）读材料：读之前、读之后各在书锁里取一次依据，两次一样才给依据；
 * 中途书上有写（哪怕又改回原样，代次也换了）、镜像跟不上，就照常返回材料、不给依据（缓存不存、不复用）。
 */
export async function readWithStableBasisForWork<T>(projectDir: string, read: () => Promise<T>): Promise<{ readonly value: T; readonly basis?: TruthBasis }> {
  const before = await basisInStep(projectDir).catch(() => undefined);
  const value = await read();
  if (!before) return { value };
  const after = await withBookLock(projectDir, () => readTruthBasis(projectDir)).catch(() => undefined);
  return after?.digest === before.digest ? { value, basis: before } : { value };
}

/** 只用来比「书现在和那份依据一样不一样」，不挂到任何产物上（比的一方已经核过镜像）。 */
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
