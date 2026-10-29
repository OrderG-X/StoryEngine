/**
 * 界面服务端取真相依据只走这里（写作版本 P1 第 7 轮复核 U3；源码扫描挡别处直接调核心的读依据）。
 *
 * 老格式镜像（时间线、线索、事实那几份）是从真相生成的投影：写完真相之后、同步镜像之前有一小段落后，
 * 同步没成就一直落后。写手、专员读的不少材料还在镜像里，照落后的镜像读出来的东西挂上新依据，换上、确认时就核不出来。
 * 所以挂到产物上的依据，取的时候镜像必须正是这一版的：落后就同步一次（镜像是投影，补上它不改真相；
 * 改设定卡只涨版本号、不同步镜像，也在这里补上），正在写入同步不成就稍等再试，再不行如实说、不给依据。
 * 取到之后真相再变，依据就对不上，产物照依据作废——不用管镜像后来怎样。
 */
import { listChapterLedgers, readHead, readTruthBasis, readWithStableBasis, type TruthBasis } from "@actalk/story-core";
import { readMirrorVersion, syncLegacyMirror } from "./mirror/sync.js";

export const MIRROR_LAG_MESSAGE = "按账整理的时间线和线索还没跟上刚改的账（同步没成），这次没做。稍后再试一次";

/** 镜像没跟上真相：这时读出的材料不能挂依据。 */
export class MirrorLagError extends Error {
  constructor() {
    super(MIRROR_LAG_MESSAGE);
    this.name = "MirrorLagError";
  }
}

const LAG_WAITS_MS = [0, 30, 60, 120, 240] as const;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 镜像是不是这一版的。书还没上新核心（版本 0）、还没有账单（新书没定稿过、老书没导入）不生成镜像（同开书 ensure.ts），
 * 读到的老文件就是材料本身，不算落后。
 */
async function mirrorInStep(projectDir: string): Promise<boolean> {
  const head = (await readHead(projectDir)).version;
  if (head === 0 || (await readMirrorVersion(projectDir)) === head) return true;
  return (await listChapterLedgers(projectDir)).length === 0;
}

/** 落后就同步一次（同步按书排队，和写真相那边的同步撞上也只是同一份写两遍）；正在写入没同步成，稍等再试。还不行返回 false。 */
async function catchUpMirror(projectDir: string): Promise<boolean> {
  for (const wait of LAG_WAITS_MS) {
    if (wait > 0) await sleep(wait);
    if (await mirrorInStep(projectDir)) return true;
    await syncLegacyMirror(projectDir).catch(() => undefined);
    if (await mirrorInStep(projectDir)) return true;
  }
  return false;
}

/**
 * 要挂到产物上的依据（出稿开写、改稿、定论 / 改账 / 定稿票、去 AI 味）：镜像是这一版的才给，跟不上抛 MirrorLagError。
 * 不拿书锁；在书锁里调也行（那时落后只可能是同步没成，会补一次）。
 */
export async function readTruthBasisForWork(projectDir: string): Promise<TruthBasis> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!(await catchUpMirror(projectDir))) throw new MirrorLagError();
    const before = (await readHead(projectDir)).version;
    const basis = await readTruthBasis(projectDir);
    if ((await readHead(projectDir)).version === before && (await mirrorInStep(projectDir))) return basis;
  }
  throw new MirrorLagError();
}

/**
 * 按内容复用的缓存（核账记忆、章纲）读材料：材料夹在两次读依据之间读，前后一样、镜像前后都是这一版的才给依据；
 * 镜像跟不上就照常返回材料、不给依据（缓存不存、不复用）。
 */
export async function readWithStableBasisForWork<T>(projectDir: string, read: () => Promise<T>): Promise<{ readonly value: T; readonly basis?: TruthBasis }> {
  if (!(await catchUpMirror(projectDir))) return { value: await read() };
  const result = await readWithStableBasis(projectDir, read);
  if (!result.basis) return result;
  return (await mirrorInStep(projectDir)) ? result : { value: result.value };
}

/** 只用来比「书现在和那份依据一样不一样」，不挂到任何产物上（比的一方已经核过镜像）。 */
export async function readTruthBasisToCompare(projectDir: string): Promise<TruthBasis> {
  return readTruthBasis(projectDir);
}
