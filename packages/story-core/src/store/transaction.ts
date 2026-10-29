/**
 * 多文件事务：一条命令要写的所有文件，要么全写上，要么全不写。
 *
 * 做法（和旧引擎的定稿事务同一个思路，精简过）：
 *  1. 在 `.story-core-tx/<事务号>/` 下备份要覆盖的旧文件、写好所有新文件（都 fsync）；
 *  2. 写清单 manifest.json（status = prepared）——清单落盘之前，书里一个字节都没动；
 *  3. 逐个 rename 新文件到位（单个 rename 是原子的）；
 *  4. 清单改成 applied，删掉事务目录。
 * 中途断电或进程被杀：下次写之前 `recoverTransactions` 把 prepared 的事务回滚（已换上的文件换回备份、
 * 新建的删掉），applied 的只清目录。调用方把版本号文件放在最后一个写，读的一方据此判断有没有读到一半。
 * 恢复的三条规矩（P1 第 19 轮复核）：
 *  - **代次只往前走**：写入代次换上了就不退回；收拾半截事务时两份代次（写入代次、工作稿代次）都不从任何备份换回。每退完一份、
 *    标它收拾过之前换新的：写入代次换新；碰过哪几章工作稿，那几章的工作稿号换新（只碰了工作稿代次、不知道哪章的，整本换新纪元）。
 *    途中有人读到了一半新内容，照它算的依据、版本号一律对不上；被杀在哪一步，重开再退一遍只会更新
 *    （写作版本 P1b 第 3 轮、P1 第 18 轮 AF1、第 19 轮 AG2）。写代次的调用方把它放在第一个写。
 *    进程内写到一半失败（一直拿着书锁、备份是刚拍的）照原样换回工作稿代次：开工前读到的版本号照样能存，途中读到的对不上。
 *  - **不毁唯一副本**：要盖掉 / 删掉的文件，盘上现在的内容不是这份事务写的（清单记着写了什么，核不上；老格式核不了），
 *    先原样另存（store/saved-copies.ts）再动——升级前后的版本混着用过，残留的事务可能比现在的稿还旧（AG3）。另存不下就停。
 *  - **失败就挡住**：哪一份退不下去（老格式的也一样），比它先开工的一份都不退、它自己不标收拾过，写命令如实拒绝开工（AG1）。
 * 没收拾的事务有好几份（老格式残留 + 核心的）：按开工先后倒着退（后开工的先退），同一个文件谁先谁后分不清就不退、如实报。
 *
 * 安全边界：书目录本身是软链时按真实路径算；目标文件或它的任何一级上级目录是软链，一律拒绝（不跟着链写到书外）。
 * 清单坏了的事务不知道换到哪一步，原样留着、写命令拒绝开工；作者确认后由 setAsideBrokenTransactions
 * 挪进 `.story-core-kept/` 留证（不删），那里攒到 KEPT_REPORT_THRESHOLD 份以上就在恢复报告里如实提醒。
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join, normalize, sep } from "node:path";
import {
  hasPendingLegacyTransactions,
  LegacyResidueError,
  markLegacyTransactionRecovered,
  scanLegacyTransactions,
  tidyLegacyTransactions,
  undoLegacyTransaction,
  type PendingLegacyTransaction,
} from "./legacy-transaction.js";
import { withBookLock } from "./lock.js";
import { draftGensWrite, freshDraftGensWrite, readDraftGens, revisionWrite } from "./control.js";
import { assertInsideBook, DISPLACED_DIR, DRAFT_GENS_PATH, draftChapterOfPath, isControlPath, KEPT_TX_DIR, REVISION_PATH, TX_DIR } from "./paths.js";
import { discardAside, moveFileInBook, placeFileInBook, readFileInBook, removeFileInBook, settleInterruptedPlace, writeFileInBook } from "./safe-fs.js";
import { saveCopyBeforeRestore } from "./saved-copies.js";

/** 留证区里超过这么多份，恢复报告里提醒一次（不自动删）。 */
export const KEPT_REPORT_THRESHOLD = 20;

export interface TxWrite {
  /** 相对书目录的路径。 */
  readonly path: string;
  readonly content: string;
}

interface ManifestFile {
  readonly path: string;
  readonly existed: boolean;
  readonly slot: string;
  /** 这次写的内容的 sha256（P1 第 19 轮）：回滚时盘上的还是它，就是这次写到一半的，换回不用另存。老清单没有。 */
  readonly wrote?: string;
  /**
   * 原来那份的 sha256（existed 的才有，P1 第 22 轮 AJ1）：回滚时盘上已经是它就是换回过了——拿内容证明，
   * 不拿「备份不在了」证明（备份可能是被挪走的）。老清单没有：退之前从备份算出来记进旁记（ORIGINALS_FILE，绑着这份事务和文件），
   * 备份也不在时说不清，如实失败。
   */
  readonly had?: string;
}

interface Manifest {
  readonly schema: "story-core-tx/1";
  readonly id: string;
  readonly createdAt: string;
  readonly status: "prepared" | "applied";
  readonly files: readonly ManifestFile[];
}

export interface RecoveryReport {
  /** 回滚了的事务号。 */
  readonly rolledBack: readonly string[];
  /** 只清了目录的（已完成或还没开始换文件的）。 */
  readonly cleaned: readonly string[];
  /** 处理不了、原样留着的（清单坏了，或事务目录不是普通目录）。留着不删，绝不当没发生。 */
  readonly problems: readonly string[];
  /** 留证区里已经挪过去的坏事务份数。 */
  readonly kept: number;
  /** 留证区超过 KEPT_REPORT_THRESHOLD 份了。 */
  readonly keptOverLimit: boolean;
}

/** 书目录的真实路径（书目录本身是软链时跟到底）。 */
async function realBook(bookDir: string): Promise<string> {
  return realpath(bookDir);
}

/**
 * 从书目录往下逐级检查 relativeDir 的每一级：是软链或不是目录就拒绝。还不存在的那一级起不用查（之后 mkdir 建的是真目录）。
 */
async function assertPlainDirs(root: string, relativeDir: string): Promise<void> {
  if (relativeDir === "." || relativeDir === "") return;
  let current = root;
  for (const part of relativeDir.split(sep)) {
    current = join(current, part);
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`上级目录是软链或不是目录，拒绝写：${relativeDir}`);
    }
  }
}

/** 目标路径：在书里、上级目录全是真目录、自己不是软链也不是目录。返回 existed。 */
async function checkTarget(root: string, path: string): Promise<boolean> {
  await assertPlainDirs(root, dirname(path));
  try {
    const stat = await lstat(join(root, path));
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`目标不是普通文件，拒绝覆盖：${path}`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** 事务目录里新建一个文件（暂存、备份）：只新建、不跟软链，落盘。权限和以前一样受 umask 管。 */
async function createDurable(path: string, content: string): Promise<void> {
  const handle = await open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o666);
  try {
    await handle.writeFile(content, "utf-8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeManifest(bookDir: string, txDir: string, manifest: Manifest): Promise<void> {
  await writeFileInBook(bookDir, join(txDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { label: "transaction manifest" });
}

/** 退回一份做了什么：真换上过文件没有、碰了哪几章工作稿、碰没碰工作稿代次（调用方据此换代次）。 */
interface RollbackResult {
  readonly changed: boolean;
  readonly draftChapters: readonly number[];
  readonly gensTouched: boolean;
}

/**
 * 暂存的样子（P1 第 22 轮）：不在 = 换上过；在、而且就是写进去的那份 = 没换上（rename 挪走的就是它）；
 * 在但核不上（软链、硬链、内容不对）= 被动过，要看正式那份才定得下。
 */
async function stagedState(bookDir: string, staged: string, file: ManifestFile): Promise<"moved" | "intact" | "tampered"> {
  let content: string | undefined;
  try {
    content = await readFileInBook(bookDir, staged, "transaction staged");
  } catch {
    return "tampered";
  }
  if (content === undefined) return "moved";
  return file.wrote !== undefined && digest(content) !== file.wrote ? "tampered" : "intact";
}

/**
 * 老清单退之前补记的原来那份的指纹（P1 第 23 轮）：事务目录里的旁记，清单本身不改。绑着这份事务（实例号 = 事务号 + 清单指纹）
 * 和每个槽位的文件路径（P1 第 24 轮）：别的事务的旁记、路径对不上的条目一律不认；备份还在的，旁记记的得和备份对得上。
 */
const ORIGINALS_FILE = "originals.json";
const ORIGINALS_SCHEMA = "story-core-tx-originals/2";

interface OriginalsRecord {
  readonly schema: typeof ORIGINALS_SCHEMA;
  readonly tx: string;
  readonly files: Readonly<Record<string, { readonly path: string; readonly had: string }>>;
}

/** 核过的旁记：认下的（槽位 → 原来那份的指纹），和备份对不上的槽位。 */
interface Originals {
  readonly known: ReadonlyMap<string, string>;
  readonly disputed: ReadonlySet<string>;
}

type ReadBackup = (path: string) => Promise<string | undefined>;

/** 收拾时读备份：不跟软链、单链接（先 settleInterruptedPlace 摘过放上一半的名字）。 */
const strictBackup = (bookDir: string): ReadBackup => (path) => readFileInBook(bookDir, path, "rollback backup");

/** 只读扫描时读备份（不动盘，放上一半的备份和正式那份是同一个文件，内容照样对）。 */
const plainBackup: ReadBackup = async (path) => {
  const stats = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!stats) return undefined;
  if (stats.isSymbolicLink() || !stats.isFile()) throw new Error("备份不是普通文件");
  return readFile(path, "utf-8");
};

/** 读这份事务的旁记：没有、读不出、不是这份事务的，都当没记过（说不清的照旧如实失败）。 */
async function readOriginalsRecord(bookDir: string, txDir: string, manifest: Manifest): Promise<OriginalsRecord["files"]> {
  let raw: string | undefined;
  try {
    raw = await readFileInBook(bookDir, join(txDir, ORIGINALS_FILE), "transaction originals");
  } catch {
    return {};
  }
  if (raw === undefined) return {};
  try {
    const parsed = JSON.parse(raw) as Partial<OriginalsRecord> | null;
    if (!parsed || parsed.schema !== ORIGINALS_SCHEMA || parsed.tx !== coreInstance(manifest) || !parsed.files || typeof parsed.files !== "object") return {};
    return parsed.files;
  } catch {
    return {};
  }
}

/** 核旁记：只认这份事务、路径对得上的条目；备份还在的，记的得是备份的指纹（不是就记进 disputed，谁都不信）。 */
async function readOriginals(bookDir: string, txDir: string, manifest: Manifest, readBackup: ReadBackup): Promise<Originals> {
  const known = new Map<string, string>();
  const disputed = new Set<string>();
  const unknown = manifest.files.filter((file) => file.existed && file.had === undefined);
  if (unknown.length === 0) return { known, disputed };
  const record = await readOriginalsRecord(bookDir, txDir, manifest);
  for (const file of unknown) {
    const entry = Object.hasOwn(record, file.slot) ? record[file.slot] : undefined;
    if (!entry || entry.path !== file.path || typeof entry.had !== "string") continue;
    const backup = await readBackup(join(txDir, "backup", file.slot));
    if (backup !== undefined && digest(backup) !== entry.had) disputed.add(file.slot);
    else known.set(file.slot, entry.had);
  }
  return { known, disputed };
}

/** 原来那份的指纹：清单记着的；老清单看核过的旁记，再从备份算；都没有是 undefined。旁记和备份对不上如实失败。 */
async function originalDigest(txDir: string, file: ManifestFile, originals: Originals, readBackup: ReadBackup): Promise<string | undefined> {
  if (file.had !== undefined) return file.had;
  if (originals.disputed.has(file.slot)) throw new Error(`旁记和备份记的原来那份对不上，说不清：${file.path}`);
  const known = originals.known.get(file.slot);
  if (known !== undefined) return known;
  const content = await readBackup(join(txDir, "backup", file.slot));
  return content === undefined ? undefined : digest(content);
}

/**
 * 老清单退之前，先把原来那份的指纹从备份算出来记进旁记、落盘，再动文件（P1 第 23 轮）：退到一半被杀、备份已经换回去了，
 * 下次拿旁记证明换没换回（退的先后也按它算），不靠「备份不在了」。清单不改：另存的实例号跟着清单走，被杀了重来号不变。
 */
async function recordOriginals(bookDir: string, txDir: string, manifest: Manifest): Promise<Originals> {
  const readBackup = strictBackup(bookDir);
  const originals = await readOriginals(bookDir, txDir, manifest, readBackup);
  const unknown = manifest.files.filter((file) => file.existed && file.had === undefined);
  if (unknown.length === 0 || originals.disputed.size > 0) return originals;
  const known = new Map(originals.known);
  let added = false;
  for (const file of unknown) {
    if (known.has(file.slot)) continue;
    const had = await originalDigest(txDir, file, originals, readBackup);
    if (had === undefined) continue;
    known.set(file.slot, had);
    added = true;
  }
  if (added) {
    const files = Object.fromEntries(unknown.filter((file) => known.has(file.slot)).map((file) => [file.slot, { path: file.path, had: known.get(file.slot)! }]));
    const record: OriginalsRecord = { schema: ORIGINALS_SCHEMA, tx: coreInstance(manifest), files };
    await writeFileInBook(bookDir, join(txDir, ORIGINALS_FILE), `${JSON.stringify(record)}\n`, { label: "transaction originals" });
  }
  return { known, disputed: originals.disputed };
}

/**
 * 上次退到一半被杀留下的（P1 第 24 轮，见 safe-fs 文件头三步）：放上了、还没摘掉暂存 / 备份名字的摘掉；挪到 aside 还没放上的放回去；
 * 原处另有一份的，aside 里那份不是这次写的就先另存（「不毁唯一副本」），再删 aside。
 */
async function settleInterrupted(bookDir: string, txDir: string, manifest: Manifest): Promise<void> {
  for (const file of manifest.files) {
    let path: string;
    try {
      path = assertInsideBook(file.path);
    } catch {
      continue;
    }
    const aside = join(txDir, "aside", file.slot);
    const left = await settleInterruptedPlace(bookDir, join(bookDir, path), {
      label: "rollback target",
      sources: [join(txDir, "staged", file.slot), join(txDir, "backup", file.slot)],
      aside,
    });
    if (left === undefined) continue;
    if (digest(left) !== file.wrote) await saveCopyBeforeRestore(bookDir, { from: coreInstance(manifest), path, content: left });
    await discardAside(bookDir, aside, { label: "rollback target", expectSha: digest(left) });
  }
}

/**
 * 把一份 prepared 的事务退回去：已换上的文件换回备份，事务新建的文件删掉。写入代次不动；工作稿代次只有进程内失败
 * （`inProcess`）才换回，收拾半截事务时不动（见文件头）。不换代次：调用方看返回的，换代次（advanceEpochs）之后再清掉这份事务。
 *
 * 换没换回拿内容证明（P1 第 22 轮 AJ1）：盘上已经是原来那份（新建的已经不在）才算退过了；不是就得从备份换回，
 * 备份不在、核不上如实失败。要盖掉 / 删掉的那份，既不是这次写的、也不是原来的，先另存（「不毁唯一副本」），
 * 再只盖掉 / 删掉核过的这一份：先挪到事务目录里的 aside 核过内容再动（safe-fs 的 placeFileInBook / removeFileInBook，AJ2、第 24 轮）。
 */
async function rollback(bookDir: string, txDir: string, manifest: Manifest, inProcess = false): Promise<RollbackResult> {
  await mkdir(join(txDir, "aside"), { recursive: true });
  await settleInterrupted(bookDir, txDir, manifest);
  const originals = await recordOriginals(bookDir, txDir, manifest);
  const readBackup = strictBackup(bookDir);
  let changed = false;
  let gensTouched = false;
  const draftChapters = new Set<number>();
  for (const file of manifest.files) {
    const staged = await stagedState(bookDir, join(txDir, "staged", file.slot), file);
    if (staged === "intact") continue;
    // 换上过（包括上次回滚到一半已经换回去的）：书被这次写动过。暂存被动过的，下面核正式那份：还是原来的样子就没动过。
    // 代次说不清换没换上就当换上过（只往前走，多换一次新的不丢东西）。
    if (staged === "moved" || isControlPath(file.path)) changed = true;
    if (file.path === REVISION_PATH) continue;
    if (file.path === DRAFT_GENS_PATH) {
      gensTouched = true;
      if (!inProcess) continue;
    }
    const path = assertInsideBook(file.path);
    const chapter = draftChapterOfPath(path);
    if (chapter !== undefined) draftChapters.add(chapter);
    await assertPlainDirs(bookDir, dirname(path));
    const target = join(bookDir, path);
    const backup = join(txDir, "backup", file.slot);
    const aside = join(txDir, "aside", file.slot);
    const had = file.existed ? await originalDigest(txDir, file, originals, readBackup) : undefined;
    if (file.existed && had === undefined) throw new Error(`备份不在、清单也没记原来是什么，说不清换没换回：${path}`);
    const current = await readFileInBook(bookDir, target, "rollback target");
    const now = current === undefined ? undefined : digest(current);
    // 已经是原来的样子：退过了（暂存被动过的 = 没换上过）。
    if (now === had) continue;
    if (staged === "tampered") throw new Error(`暂存被动过、正式那份也不是原来的样子，说不清换没换上：${path}`);
    if (current !== undefined && now !== file.wrote) await saveCopyBeforeRestore(bookDir, { from: coreInstance(manifest), path, content: current });
    if (!file.existed) await removeFileInBook(bookDir, target, { label: "rollback target", expectSha: now!, aside });
    else await placeFileInBook(bookDir, backup, target, { label: "rollback target", expectSha: had, ...(now === undefined ? { expectTarget: null } : { expectTarget: now, aside }) });
  }
  return { changed, draftChapters: [...draftChapters], gensTouched };
}

async function writeControl(bookDir: string, write: TxWrite): Promise<void> {
  const path = assertInsideBook(write.path);
  await assertPlainDirs(bookDir, dirname(path));
  await mkdir(dirname(join(bookDir, path)), { recursive: true });
  await checkTarget(bookDir, path);
  // 同目录临时文件 + 一次 rename（safe-fs）：被杀在中间要么是旧的、要么是新的，不会是半截；途中路径被调换如实报错。
  await writeFileInBook(bookDir, join(bookDir, path), write.content, { label: "control file", createMode: 0o666 });
}

/**
 * 退完一份之后换代次（见文件头「代次只往前走」）：写入代次换新的；碰过的那几章工作稿号换新的（drafts 给了才换）；
 * 只碰了工作稿代次、说不清哪章的，整本换新纪元。
 */
async function advanceEpochs(bookDir: string, drafts?: { readonly chapters: readonly number[]; readonly gensTouched: boolean }): Promise<void> {
  await writeControl(bookDir, revisionWrite(new Date()));
  if (!drafts) return;
  if (drafts.chapters.length > 0) await writeControl(bookDir, draftGensWrite(await readDraftGens(bookDir), drafts.chapters, randomUUID()));
  else if (drafts.gensTouched) await writeControl(bookDir, freshDraftGensWrite());
}

export async function commitFiles(givenBookDir: string, writes: readonly TxWrite[]): Promise<void> {
  if (writes.length === 0) return;
  const bookDir = await realBook(givenBookDir);
  await assertPlainDirs(bookDir, TX_DIR);
  const seen = new Set<string>();
  const id = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
  const txDir = join(bookDir, TX_DIR, id);
  await mkdir(join(txDir, "staged"), { recursive: true });
  await mkdir(join(txDir, "backup"), { recursive: true });
  const files: ManifestFile[] = [];
  try {
    for (const [index, write] of writes.entries()) {
      const path = assertInsideBook(write.path);
      if (seen.has(path)) throw new Error(`同一个事务里重复写同一个文件：${path}`);
      seen.add(path);
      const target = join(bookDir, path);
      const slot = String(index);
      const existed = await checkTarget(bookDir, path);
      const original = existed ? await readFileInBook(bookDir, target, "transaction target") : undefined;
      if (existed && original === undefined) throw new Error(`要覆盖的文件刚才还在、现在不在了：${path}`);
      if (original !== undefined) await createDurable(join(txDir, "backup", slot), original);
      await createDurable(join(txDir, "staged", slot), write.content);
      files.push({ path, existed, slot, wrote: digest(write.content), ...(original !== undefined ? { had: digest(original) } : {}) });
    }
  } catch (error) {
    // 清单还没写，书里什么都没动：直接丢掉暂存。
    await rm(txDir, { recursive: true, force: true });
    throw error;
  }
  const manifest: Manifest = { schema: "story-core-tx/1", id, createdAt: new Date().toISOString(), status: "prepared", files };
  await writeManifest(bookDir, txDir, manifest);
  try {
    for (const file of files) {
      const target = join(bookDir, file.path);
      await assertPlainDirs(bookDir, dirname(file.path));
      await mkdir(dirname(target), { recursive: true });
      // 盖掉的得还是备份时那份（rename 前核，safe-fs 文件头）；新建的独占放上（原处有了就不放）。写的途中被别处改过就不盖，整份退回。
      const staged = join(txDir, "staged", file.slot);
      if (file.had === undefined) await placeFileInBook(bookDir, staged, target, { label: "transaction target", expectSha: file.wrote, expectTarget: null });
      else await moveFileInBook(bookDir, staged, target, { label: "transaction target", expectSha: file.wrote, precheckTargetSha: file.had });
    }
  } catch (error) {
    // 进程内失败：一直拿着书锁，工作稿代次照原样换回（见文件头），写入代次换新。退不下去的（核不上、备份被动过）
    // 事务原样留着，下一个写命令开工前再收拾、收拾不了如实挡住；这里报这次写没成的原因。
    let undone: RollbackResult;
    try {
      undone = await rollback(bookDir, txDir, manifest, true);
    } catch {
      throw error;
    }
    if (undone.changed) await advanceEpochs(bookDir);
    await rm(txDir, { recursive: true, force: true });
    throw error;
  }
  await writeManifest(bookDir, txDir, { ...manifest, status: "applied" });
  await rm(txDir, { recursive: true, force: true });
}

/** 有没有没收尾的事务（读的一方用：有就说明正在写或上次写断了）。老格式（升级前崩溃留下的）没收拾的也算。 */
export async function hasPendingTransactions(bookDir: string): Promise<boolean> {
  try {
    if ((await readdir(join(bookDir, TX_DIR))).length > 0) return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return hasPendingLegacyTransactions(bookDir);
}

type TxState =
  | { readonly kind: "no-manifest" }
  | { readonly kind: "manifest"; readonly manifest: Manifest }
  | { readonly kind: "broken" };

/** 看一个事务目录是什么情况。不是普通目录（软链、文件）、清单读不了，都算坏的。 */
async function inspect(txDir: string): Promise<TxState> {
  const stat = await lstat(txDir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) return { kind: "broken" };
  let raw: string;
  try {
    raw = await readFile(join(txDir, "manifest.json"), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "no-manifest" };
    return { kind: "broken" };
  }
  try {
    const manifest = JSON.parse(raw) as Manifest;
    const valid =
      manifest.schema === "story-core-tx/1" &&
      (manifest.status === "prepared" || manifest.status === "applied") &&
      Array.isArray(manifest.files) &&
      manifest.files.every((file) => typeof file?.path === "string" && typeof file.slot === "string" && typeof file.existed === "boolean"
        && (file.wrote === undefined || typeof file.wrote === "string") && (file.had === undefined || typeof file.had === "string"));
    return valid ? { kind: "manifest", manifest } : { kind: "broken" };
  } catch {
    return { kind: "broken" };
  }
}

async function listDir(path: string): Promise<string[] | undefined> {
  try {
    return await readdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function keptCount(bookDir: string): Promise<number> {
  return (await listDir(join(bookDir, KEPT_TX_DIR)))?.filter((name) => name !== basename(DISPLACED_DIR)).length ?? 0;
}

/** 一份要退的事务（老格式或核心的）：开工时间、会换回哪些文件（→ 换回成什么）。 */
interface Undo {
  readonly format: "legacy" | "core";
  readonly name: string;
  readonly createdAt: string;
  readonly restores: ReadonlyMap<string, string | null>;
  readonly manifest?: Manifest;
}

interface CoreScan {
  readonly prepared: readonly Undo[];
  readonly cleaned: readonly string[];
  readonly problems: readonly string[];
}

const digest = (text: string): string => createHash("sha256").update(text, "utf-8").digest("hex");

/** 一份核心事务的实例号（另存去重用，P1 第 20 轮 AH3）：事务号 + 清单指纹。回滚中清单不改，被杀了重来号不变。 */
function coreInstance(manifest: Manifest): string {
  return `${manifest.id}@${digest(JSON.stringify(manifest)).slice(0, 16)}`;
}

/** 暂存还在、不是放上一半（和正式那份是同一个文件）的：没换上。 */
async function notPlaced(staged: string, target: string): Promise<boolean> {
  const stagedStats = await lstat(staged).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!stagedStats) return false;
  const targetStats = await lstat(target).catch(() => undefined);
  return !(targetStats && stagedStats.isFile() && targetStats.dev === stagedStats.dev && targetStats.ino === stagedStats.ino);
}

/** 核心事务逐个看清（只读）：要回滚的（prepared）带上它会换回哪些文件；坏的记进 problems；没清单 / applied 的只清目录。 */
async function scanCoreTransactions(bookDir: string): Promise<CoreScan> {
  const root = join(bookDir, TX_DIR);
  const rootStat = await lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!rootStat) return { prepared: [], cleaned: [], problems: [] };
  // 事务根本身是软链或文件：里面的东西一样都不碰。
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return { prepared: [], cleaned: [], problems: [TX_DIR] };
  const prepared: Undo[] = [];
  const cleaned: string[] = [];
  const problems: string[] = [];
  for (const name of (await listDir(root)) ?? []) {
    const txDir = join(root, name);
    const state = await inspect(txDir);
    if (state.kind === "broken") {
      problems.push(name);
      continue;
    }
    if (state.kind !== "manifest" || state.manifest.status !== "prepared") {
      // 没清单 = 书里没动过；applied = 已经全换上了。都只清目录。
      cleaned.push(name);
      continue;
    }
    const restores = new Map<string, string | null>();
    const originals = await readOriginals(bookDir, txDir, state.manifest, plainBackup);
    for (const file of state.manifest.files) {
      // 没换上的、代次（退的时候换新的，不换回）不算；路径不对的回滚时如实失败。
      if (isControlPath(file.path)) continue;
      let path: string;
      try {
        path = assertInsideBook(file.path);
      } catch {
        continue;
      }
      if (await notPlaced(join(txDir, "staged", file.slot), join(bookDir, path))) continue;
      if (!file.existed) {
        restores.set(path, null);
        continue;
      }
      // 原来是什么说不清（老清单、没补记、备份也不在、旁记和备份对不上）：先后不按它算，回滚时如实失败。
      const had = await originalDigest(txDir, file, originals, plainBackup).catch(() => undefined);
      if (had !== undefined) restores.set(path, had);
    }
    prepared.push({ format: "core", name, createdAt: state.manifest.createdAt, restores, manifest: state.manifest });
  }
  return { prepared, cleaned, problems };
}

function legacyUndo(tx: PendingLegacyTransaction): Undo {
  return { format: "legacy", name: tx.name, createdAt: tx.createdAt, restores: new Map([...tx.restores].map(([path, before]) => [normalize(path), before])) };
}

/**
 * 退的先后（P1 第 18 轮 AF2）：按开工时间倒着退，后开工的先退——后开工的备份的正是先开工那份写到一半的样子，
 * 先退先开工的、再退后开工的，就把那份半截稿换回来了。两份换回同一个文件、换回的内容不一样、开工时间又分不清
 * （一样、读不出来）的，谁先退都可能错，一份都不退：返回分不清的那几份。
 */
function undoOrder(undos: readonly Undo[]): readonly Undo[] | { readonly ambiguous: readonly Undo[] } {
  const time = (undo: Undo): number => Date.parse(undo.createdAt);
  const ambiguous = new Set<Undo>();
  for (const [index, left] of undos.entries()) {
    for (const right of undos.slice(index + 1)) {
      const conflict = [...left.restores].some(([path, before]) => right.restores.has(path) && right.restores.get(path) !== before);
      if (!conflict) continue;
      if (!Number.isFinite(time(left)) || !Number.isFinite(time(right)) || time(left) === time(right)) {
        ambiguous.add(left);
        ambiguous.add(right);
      }
    }
  }
  if (ambiguous.size > 0) return { ambiguous: [...ambiguous] };
  const key = (undo: Undo): number => (Number.isFinite(time(undo)) ? time(undo) : Number.NEGATIVE_INFINITY);
  return [...undos].sort((left, right) => key(right) - key(left));
}

/**
 * 收拾上次没写完的事务：老格式残留（`.story-engine-tx/`，老版本崩溃留下的）和核心自己的一起，按开工先后倒着退，
 * 再收尾（清目录、归档）。只在书锁里调（写命令开工前、先读盘再定参数之前）。老格式收拾不了、或和别的事务分不清先后，
 * 抛 `LegacyResidueError`（写命令照「残留」如实失败）；核心的坏事务原样留着、记进 problems。
 */
export async function recoverTransactions(givenBookDir: string): Promise<RecoveryReport> {
  const bookDir = await realBook(givenBookDir);
  const legacy = await scanLegacyTransactions(bookDir);
  const core = await scanCoreTransactions(bookDir);
  const kept = await keptCount(bookDir);
  const report = (rolledBack: string[], cleaned: string[], problems: string[]): RecoveryReport => ({
    rolledBack,
    cleaned,
    problems,
    kept,
    keptOverLimit: kept > KEPT_REPORT_THRESHOLD,
  });
  const order = undoOrder([...legacy.map(legacyUndo), ...core.prepared]);
  const rolledBack: string[] = [];
  const problems = [...core.problems];
  if ("ambiguous" in order) {
    if (order.ambiguous.some((undo) => undo.format === "legacy")) {
      throw new LegacyResidueError(Object.assign(new Error("老格式残留和别的未完成写入改了同一个文件，分不清先后"), { code: "TX_OVERLAP_ORDER_UNKNOWN" }));
    }
    // 只有核心的分不清：都原样留着（不退也不清），交给作者。
    return report([], [], [...problems, ...order.ambiguous.map((undo) => undo.name)]);
  }
  for (const undo of order) {
    if (undo.format === "legacy") {
      // 退不下去、另存不下、换不了代次：整轮停、抛「残留」（不标收拾过，下次照样挡着；比它先开工的一份都不退）。
      try {
        const undone = await undoLegacyTransaction(bookDir, undo.name, ({ instance, path, content }) => saveCopyBeforeRestore(bookDir, { from: instance, path, content }));
        if (undone.changed) await advanceEpochs(bookDir, { chapters: undone.draftChapters, gensTouched: undone.gensTouched });
        await markLegacyTransactionRecovered(bookDir, undo.name);
      } catch (error) {
        throw error instanceof LegacyResidueError ? error : new LegacyResidueError(error);
      }
      continue;
    }
    const txDir = join(bookDir, TX_DIR, undo.name);
    try {
      const undone = await rollback(bookDir, txDir, undo.manifest!);
      if (undone.changed) await advanceEpochs(bookDir, { chapters: undone.draftChapters, gensTouched: undone.gensTouched });
    } catch {
      // 回滚不下去（清单指到书外、上级目录被换成软链、另存不下……）：原样留着，交给作者；比它先开工的也先不退（不然退到一半的书叠在没退的上面）。
      problems.push(undo.name);
      return report(rolledBack, [], problems);
    }
    rolledBack.push(undo.name);
    await rm(txDir, { recursive: true, force: true });
  }
  await tidyLegacyTransactions(bookDir);
  for (const name of core.cleaned) await rm(join(bookDir, TX_DIR, name), { recursive: true, force: true });
  return report(rolledBack, [...core.cleaned], problems);
}

/** 拿书锁收拾一遍（不在写命令里、要先把书收拾干净再看的：开书接上新核心、测试）。 */
export async function recoverBookTransactions(givenBookDir: string): Promise<RecoveryReport> {
  return withBookLock(givenBookDir, () => recoverTransactions(givenBookDir));
}

/**
 * 作者确认后，把收拾不了的坏事务挪进留证区（单次 rename，不删）。之后写命令就能照常开工。
 * 自己拿写锁；返回挪走了哪些、留证区现在共几份。
 */
export async function setAsideBrokenTransactions(givenBookDir: string): Promise<{ readonly moved: readonly string[]; readonly kept: number; readonly keptOverLimit: boolean }> {
  const bookDir = await realBook(givenBookDir);
  return withBookLock(bookDir, async () => {
    let problems: readonly string[];
    try {
      problems = (await recoverTransactions(bookDir)).problems;
    } catch (error) {
      // 老格式残留收拾不了不归留证区管（写命令照旧如实失败）：只挪核心自己的坏事务，别的一样不动。
      if (!(error instanceof LegacyResidueError)) throw error;
      problems = (await scanCoreTransactions(bookDir)).problems;
    }
    const moved: string[] = [];
    if (problems.length > 0) {
      await assertPlainDirs(bookDir, KEPT_TX_DIR);
      await mkdir(join(bookDir, KEPT_TX_DIR), { recursive: true });
      const stamp = Date.now().toString(36);
      for (const name of problems) {
        const from = name === TX_DIR ? join(bookDir, TX_DIR) : join(bookDir, TX_DIR, name);
        await rename(from, join(bookDir, KEPT_TX_DIR, `${stamp}-${name.replace(/[^\w.-]/gu, "_")}`));
        moved.push(name);
      }
    }
    const kept = await keptCount(bookDir);
    return { moved, kept, keptOverLimit: kept > KEPT_REPORT_THRESHOLD };
  });
}
