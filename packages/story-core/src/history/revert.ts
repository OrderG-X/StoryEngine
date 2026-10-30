/**
 * 撤销一次操作的计划（写作版本 P2a 片 4B，设计 8.1）：整次一起退，不拆，不弄断后面的引用。只读：不写盘、不拿锁
 * （调用方在书锁里调，应用走 history.apply）。
 *
 *  1. 这次操作的回执按写的先后排成 r₁…r_k（没有撤销范围效果的不算），每个文件的效果链要接得上；
 *  2. 每个文件看现在的哈希：等于链尾的写后 → 没人动过；
 *  3. 前像：文件 f 换回这次第一次写它之前那份（链头写前是「不存在」就删），从 r_{i(f)} 记的存档树里取，核哈希 = 链头的写前；
 *     撤后真相 U = 没换的照现在、换回的是各自的前像；
 *  4. 链接不上、后来被改过的列成影响（谁改的、有没有说不清的），调用方等作者「全撤 / 不撤了」，确认时重算、影响变了重新问；
 *  5. 核引用：U 里每条引用者 x 按它自己接着的那一刻定基准（L(x)、s(x)、三支 + 区间写入证据），按 (s, L) 分组，整组比全集的
 *     内容键一样就过，不一样的每条都在两边完整解析再比；变了就不撤、如实说是哪接着；
 *  6. 守护线：碰过的章，撤后正文哈希和账对不上（撤之前对得上）就不撤。
 *
 * 记号：T_j = r_j 记的存档树（r_j 写之前那一刻），T_{k+1} = 现在。区间写入证据（Astra 第 10 轮第 2 条）：i(g) < s(x) 时，
 * 窗口 (r_{s−1} 写完, T_s] 里（按回执时间，r_{s−1} 和 r_s 之间，含同一毫秒的）任何一张别的回执写过 g、或有升级之前的回执
 * （不知道写了什么）→ 证明不了；没有回执写过 g、两头哈希也一样（防不走回执的写）→ g 在窗口里没变过，x 一定是照它写的，取它。
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fail } from "../commands/runner.js";
import type { CommandFailure } from "../commands/types.js";
import { CommandReceipt } from "../schema/book.js";
import { CARDS_PATH, chapterFromFileName, chapterLedgerPath, chapterTextPath, DECISIONS_PATH } from "../store/paths.js";
import { sha256Bytes, type TxEffect } from "../store/transaction.js";
import { cardReferencers, decisionReferencers, digestOf, ledgerReferencers, Resolver, type Referencer, type RefWhere, type TruthView } from "./references.js";
import { HistoryFileError, HistoryStore, isReferenceFile, ledgerChapterOfPath, rangeDigestOf, readUndoableFiles, textOf, type HistoryReader, type Version } from "./store.js";

export type RevertTarget = { readonly opId: string } | { readonly receiptKey: string };

/** 撤销 / 整本恢复那条命令的名字（apply.ts 的 historyApply；这里不引它，免得互相引）。 */
export const HISTORY_APPLY_COMMAND = "history.apply";

/** 计划里的一处改动：现在的 sha256（null = 现在没有，应用时核），换成什么（null = 删）。 */
export interface PlannedChange {
  readonly path: string;
  readonly expect: string | null;
  readonly content: string | null;
}

export interface LaterWrite {
  readonly command: string;
  readonly at: string;
  readonly opId?: string;
}

/** 后来被改过的文件：哪些回执改的；有没有说不清是谁改的（不走回执的写）。 */
export interface ImpactItem {
  readonly path: string;
  readonly by: readonly LaterWrite[];
  readonly unknown: boolean;
}

export interface RevertPlan {
  readonly ok: true;
  /** 撤的是哪几张回执（键，按写的先后）。 */
  readonly receipts: readonly string[];
  readonly changes: readonly PlannedChange[];
  /** 空 = 后来没人动过，可以直接撤；不空 = 要作者确认「全撤」。 */
  readonly impact: readonly ImpactItem[];
  /** 影响和那几份现在的样子的摘要：确认时重算，变了重新问。 */
  readonly impactDigest: string;
  /** 计划时整个撤销范围的摘要：交给 history.apply 核（算好之后哪里改过就不写、重算）。 */
  readonly rangeDigest: string;
}

const time = (receipt: CommandReceipt): number => {
  const value = Date.parse(receipt.at);
  return Number.isFinite(value) ? value : 0;
};

/** 书里全部回执，按写的先后（回执时间、版本号、键）。读路径：不拿锁。读不了的、格式不对的跳过。 */
export async function readReceipts(bookDir: string): Promise<CommandReceipt[]> {
  const dir = join(bookDir, "ledger/receipts");
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const receipts: CommandReceipt[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = CommandReceipt.safeParse(JSON.parse(await readFile(join(dir, name), "utf-8")));
      if (parsed.success) receipts.push(parsed.data);
    } catch {
      // 读不了的跳过（不是这次要撤的就不影响；是的话找不到它，如实说）。
    }
  }
  return receipts.sort((a, b) => time(a) - time(b) || a.version - b.version || a.key.localeCompare(b.key));
}

const targetOf = (receipt: CommandReceipt): RevertTarget => (receipt.opId ? { opId: receipt.opId } : { receiptKey: receipt.key });
const targetId = (target: RevertTarget): string => ("opId" in target ? `op:${target.opId}` : `key:${target.receiptKey}`);

/** history.apply 结果里记的那次（撤的是哪次）；认不出返回 undefined。 */
export function revertTargetOf(value: unknown): RevertTarget | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as { readonly opId?: unknown; readonly receiptKey?: unknown };
  if (typeof record.opId === "string" && record.opId) return { opId: record.opId };
  if (typeof record.receiptKey === "string" && record.receiptKey) return { receiptKey: record.receiptKey };
  return undefined;
}

/**
 * 这本书起点那几笔的防重复标记（建书、开书时导入老格式书、导入已写的书）：「撤销上一步」到它们就停，再往前没什么能撤。
 * 写它们的地方用这几个常量，不各写各的字。
 */
export const BOOK_START_KEYS = {
  create: "book-create",
  importOpen: "book-import:open",
  cardsImportOpen: "cards-import:open",
  importText: "book-import-text",
} as const;

const BOOK_START_KEY_SET: ReadonlySet<string> = new Set(Object.values(BOOK_START_KEYS));

/**
 * 一个文件的一份内容：哪张回执写的（排第几；undefined = 不是回执写的：回执之前就在的那份、在回执之外改成的那份）、
 * 写的时候盘上是哪一份（base）、谱系上照着哪一份来（from：普通的写 = base；撤销 / 恢复换回去的 = 内容一样的那份）。
 */
interface FileVersion {
  readonly writer: number | undefined;
  readonly hash: string | null;
  readonly base: FileVersion | undefined;
  readonly from: FileVersion | undefined;
  /** 在回执之外改成的（作者存稿不留回执、在别处改了文件）：发现它时排到第几张回执（现在 = 回执总数）。 */
  readonly outside?: number;
}

/** 「撤销上一步」撤哪次；unsure = 在回执之外又改过、跟记录接不上的文件（跳过的那几次、找到的这次自己写过的），撤之前要作者点。 */
export interface UndoChoice {
  readonly target: RevertTarget;
  readonly unsure?: readonly string[];
}

/**
 * 「撤销上一步」撤哪次（写作版本 P2a 片 4C）：最近一次**现在还在**的改动——书里某个文件现在这份内容的谱系里有它写的那份。
 * 谱系按回执排：普通的写照着那个文件写之前那份来；撤销 T 照着 T 第一次写那个文件之前那份来（撤掉的那几份不在谱系里）；
 * 整本恢复照着它换回去的那份来（按内容哈希认最近那份）。所以：被撤过的、被别的撤销「全撤」顺带整个退掉的不在了，跳过；
 * 撤销被撤回来，被它撤掉的又在了；整本恢复还在就是上一次（撤它 = 回到恢复之前），被撤过、被全撤退掉了就跳过
 * （Astra 第 11 轮第 3 条、第 12 轮第 1 条：只看「谁撤了谁」会把被撤回来的撤销、被全撤退掉的恢复算错）。
 * 只退了一部分的还在，照常算，撤它服从整组规则。撤销本身不算（撤销的撤销走「撤回来」带号）。
 *
 * 回执之外的写（作者存稿不留回执、在别处改了文件）：回执记的写前跟谱系上前一份对不上就是中间有过，当成照当时盘上那份改的
 * （作者存稿核过版本，确实是）；撤销 / 恢复换回去的内容对不上任何一份记过的，再往前接不上。current（撤销范围里现在每个文件
 * 的哈希）给了就把最后一张回执之后的也这样认出来。被跳过的那次写过的文件之后有过回执之外的写（比如原样放回了它那份），
 * 它在不在就说不准：照样往前找，找到的带上 unsure，撤之前停下给作者看、点了才撤，不自动去撤别章（Astra 第 13 轮第 1 条）。
 * 找到的这次自己写过的文件也一样：谱系里已经没有它、之后又有回执之外的写的，一起进 unsure（第 14 轮第 1 条）。
 *
 * 升级之前的写（回执没有效果记录、没留存档）也算一次：撤的时候如实说只能整本恢复。到这本书的起点（BOOK_START_KEYS）就停。
 * 没有返回 undefined。receipts 按写的先后排好。
 */
export function lastUndoable(receipts: readonly CommandReceipt[], current?: ReadonlyMap<string, string>): UndoChoice | undefined {
  const ids = receipts.map((receipt) => targetId(targetOf(receipt)));
  const versions = new Map<string, FileVersion[]>();
  // 每次（按号）第一次写每个文件写出来的那份。
  const firstWrite = new Map<string, Map<string, FileVersion>>();
  /** 盘上这一刻是 hash：跟前一份对得上就是它；对不上 = 中间有回执之外的写，记一份照前一份改的。 */
  const onDisk = (list: FileVersion[], hash: string | null, at: number): FileVersion => {
    const prev = list.at(-1) as FileVersion;
    if (prev.hash === hash) return prev;
    const outside: FileVersion = { writer: undefined, hash, base: prev, from: prev, outside: at };
    list.push(outside);
    return outside;
  };
  /** 撤销 / 恢复换回去的那份：该是的那份（candidate）对得上就是它；对不上按内容认最近一份；都没有 = 接不上（记一份回执之外的、再往前没有）。 */
  const sameAs = (list: FileVersion[], candidate: FileVersion | undefined, hash: string | null, at: number): FileVersion => {
    if (candidate && candidate.hash === hash) return candidate;
    const same = [...list].reverse().find((version) => version.hash === hash);
    if (same) return same;
    const outside: FileVersion = { writer: undefined, hash, base: undefined, from: undefined, outside: at };
    list.push(outside);
    return outside;
  };
  receipts.forEach((receipt, index) => {
    const result = receipt.result as { readonly kind?: unknown; readonly target?: unknown } | null | undefined;
    const history = receipt.command === HISTORY_APPLY_COMMAND;
    const undone = history && result?.kind !== "restore" ? revertTargetOf(result?.target) : undefined;
    const mine = firstWrite.get(ids[index] as string) ?? new Map<string, FileVersion>();
    for (const effect of receipt.effects ?? []) {
      const list = versions.get(effect.path) ?? [{ writer: undefined, hash: effect.before, base: undefined, from: undefined }];
      versions.set(effect.path, list);
      const base = onDisk(list, effect.before, index);
      const from = !history
        ? base
        : sameAs(list, undone ? firstWrite.get(targetId(undone))?.get(effect.path)?.base : undefined, effect.after, index);
      const version: FileVersion = { writer: index, hash: effect.after, base, from };
      list.push(version);
      if (!mine.has(effect.path)) mine.set(effect.path, version);
    }
    firstWrite.set(ids[index] as string, mine);
  });
  const present = new Set<string>();
  // 文件 → 现在这份的谱系里有哪几次。
  const presentIn = new Map<string, Set<string>>();
  for (const [path, list] of versions) {
    if (current) onDisk(list, current.get(path) ?? null, receipts.length);
    const here = new Set<string>();
    for (let version = list.at(-1); version; version = version.from) if (version.writer !== undefined) here.add(ids[version.writer] as string);
    presentIn.set(path, here);
    for (const id of here) present.add(id);
  }
  // 文件 → 最后一次回执之外的写是在第几张回执之前发现的。
  const lastOutside = new Map<string, number>();
  for (const [path, list] of versions) {
    for (const version of list) if (version.outside !== undefined) lastOutside.set(path, Math.max(lastOutside.get(path) ?? -1, version.outside));
  }
  const unsure = new Set<string>();
  const skip = (receipt: CommandReceipt, index: number): void => {
    for (const effect of receipt.effects ?? []) if (index < (lastOutside.get(effect.path) ?? -1)) unsure.add(effect.path);
  };
  // 找到的这次自己写过、现在的谱系里已经没有它的文件，之后有过回执之外的写（比如作者原样存回了它那份）：撤它会不会动到作者的，
  // 也说不准（Astra 第 14 轮第 1 条：整组靠别的文件还在被选中，这个文件撤了内容对得上就不问了）。
  const choose = (receipt: CommandReceipt, index: number): UndoChoice => {
    const id = ids[index] as string;
    receipts.forEach((mine, at) => {
      if (at > index || ids[at] !== id) return;
      for (const effect of mine.effects ?? []) {
        if (!presentIn.get(effect.path)?.has(id) && at < (lastOutside.get(effect.path) ?? -1)) unsure.add(effect.path);
      }
    });
    return { target: targetOf(receipt), ...(unsure.size > 0 ? { unsure: [...unsure].sort() } : {}) };
  };
  for (let index = receipts.length - 1; index >= 0; index -= 1) {
    const receipt = receipts[index] as CommandReceipt;
    const id = ids[index] as string;
    if (receipt.command === HISTORY_APPLY_COMMAND) {
      const result = receipt.result as { readonly kind?: unknown } | null | undefined;
      if (result?.kind !== "restore" || (receipt.effects ?? []).length === 0) continue;
      if (present.has(id)) return choose(receipt, index);
      skip(receipt, index);
      continue;
    }
    if (BOOK_START_KEY_SET.has(receipt.key)) return undefined;
    if (receipt.effects === undefined) return choose(receipt, index);
    if (receipt.effects.length === 0) continue;
    if (present.has(id)) return choose(receipt, index);
    skip(receipt, index);
  }
  return undefined;
}

/** 「撤销上一步」撤哪次，照书里现在的样子核（撤销范围里每个文件现在的哈希一起交给 lastUndoable）。 */
export async function lastUndoableIn(bookDir: string, receipts: readonly CommandReceipt[]): Promise<UndoChoice | CommandFailure | undefined> {
  let files: Map<string, Buffer>;
  try {
    files = await readUndoableFiles(bookDir);
  } catch (error) {
    if (error instanceof HistoryFileError) return fail(error.code, error.message, { path: error.path });
    throw error;
  }
  return lastUndoable(receipts, new Map([...files].map(([path, bytes]) => [path, sha256Bytes(bytes)])));
}

const chapterOfTextPath = (path: string): number | undefined =>
  path.startsWith("chapters/") && path.endsWith(".md") ? chapterFromFileName(path.slice("chapters/".length)) : undefined;

/** 给作者看的「哪接着」（只说章号和类别，不带编号）。 */
function describeWhere(where: readonly RefWhere[]): string {
  const chapters = [...new Set(where.flatMap((item) => (item.kind === "ledger" ? [item.chapter] : [])))].sort((a, b) => a - b);
  const parts: string[] = [];
  if (chapters.length > 0) parts.push(`第 ${chapters.join("、")} 章的账`);
  if (where.some((item) => item.kind === "decision")) parts.push("你记的裁定");
  if (where.some((item) => item.kind === "relation")) parts.push("设定本里的关系");
  return parts.join("、");
}

export async function planRevert(bookDir: string, target: RevertTarget, reader: HistoryReader): Promise<RevertPlan | CommandFailure> {
  try {
    return await plan(bookDir, target, new HistoryStore(reader));
  } catch (error) {
    if (error instanceof HistoryFileError) return fail(error.code, error.message, { path: error.path });
    throw error;
  }
}

async function plan(bookDir: string, target: RevertTarget, store: HistoryStore): Promise<RevertPlan | CommandFailure> {
  const all = await readReceipts(bookDir);
  const group = all.filter((receipt) => ("opId" in target ? receipt.opId === target.opId : receipt.key === target.receiptKey));
  if (group.length === 0) return fail("nothing_to_undo", "找不到这次改动的记录，撤不了。");
  if (group.some((receipt) => receipt.effects === undefined)) return fail("legacy_receipt", "这次改动是升级之前做的，撤不了。");
  const writes = group.filter((receipt) => (receipt.effects ?? []).length > 0);
  if (writes.length === 0) return fail("nothing_to_undo", "这次没改过能撤的东西。");
  if (writes.some((receipt) => !receipt.snapshotTree)) return fail("no_tree", "这次改动之前没留存档，撤不了。");
  const trees: Version[] = [];
  for (const receipt of writes) {
    const version = await store.list(receipt.snapshotTree as string);
    if (!version) return fail("tree_gone", "这次之前的存档已经裁掉了，撤不了。");
    trees.push(version);
  }
  const files = await readUndoableFiles(bookDir);
  const current = new Map<string, string>();
  const currentSha = new Map<string, string>();
  for (const [path, bytes] of files) {
    current.set(path, store.pin(bytes));
    currentSha.set(path, sha256Bytes(bytes));
  }
  const k = writes.length;
  const at = (j: number): Version => (j <= k ? (trees[j - 1] as Version) : current);
  const groupKeys = new Set(group.map((receipt) => receipt.key));
  const rank = new Map(all.map((receipt, index) => [receipt.key, index]));

  // 1、2：效果链、现在的样子。
  const first = new Map<string, number>();
  const chains = new Map<string, TxEffect[]>();
  writes.forEach((receipt, index) => {
    for (const effect of receipt.effects ?? []) {
      if (!first.has(effect.path)) first.set(effect.path, index + 1);
      chains.set(effect.path, [...(chains.get(effect.path) ?? []), effect]);
    }
  });
  const impact: ImpactItem[] = [];
  for (const [path, chain] of chains) {
    const now = currentSha.get(path) ?? null;
    const linked = chain.every((effect, index) => index === 0 || effect.before === chain[index - 1]?.after);
    if (linked && now === chain.at(-1)?.after) continue;
    const start = rank.get((writes[(first.get(path) as number) - 1] as CommandReceipt).key) as number;
    const touching = all.filter((receipt, index) => index >= start && receipt.effects?.some((effect) => effect.path === path));
    const later = touching.filter((receipt) => !groupKeys.has(receipt.key));
    // 按先后把这次的和别人的接起来：接不上、接到最后不是现在的样子 = 有不走回执的改动，说不清是谁。
    let previous: string | null | undefined;
    let explained = true;
    for (const receipt of touching) {
      const effect = receipt.effects?.find((item) => item.path === path) as TxEffect;
      if (previous !== undefined && effect.before !== previous) explained = false;
      previous = effect.after;
    }
    if (previous !== now) explained = false;
    impact.push({ path, by: later.map((receipt) => ({ command: receipt.command, at: receipt.at, ...(receipt.opId ? { opId: receipt.opId } : {}) })), unknown: !explained });
  }

  // 3：前像、撤后真相。
  const preimage = new Map<string, string | undefined>();
  for (const [path, chain] of chains) {
    const head = chain[0] as TxEffect;
    if (head.before === null) {
      preimage.set(path, undefined);
      continue;
    }
    const key = at(first.get(path) as number).get(path);
    if (key === undefined || (await store.sha(key, path)) !== head.before) return fail("preimage_mismatch", "这次之前的存档和记录对不上，撤不了。", { path });
    preimage.set(path, key);
  }
  const undone = new Map(current);
  for (const [path, key] of preimage) {
    if (key === undefined) undone.delete(path);
    else undone.set(path, key);
  }

  // 5：核引用。
  const blocked = await checkReferences({ store, all, writes, groupKeys, at, k, first, undone });
  if (blocked) return blocked;

  // 6：守护线。
  const touched = new Set<number>();
  for (const path of chains.keys()) {
    const chapter = chapterOfTextPath(path) ?? ledgerChapterOfPath(path);
    if (chapter !== undefined) touched.add(chapter);
  }
  const mismatched = async (version: Version, chapter: number): Promise<boolean> => {
    const ledgerKey = version.get(chapterLedgerPath(chapter));
    if (ledgerKey === undefined) return false;
    const ledger = await store.ledger(ledgerKey, chapterLedgerPath(chapter));
    return (await store.sha(version.get(chapterTextPath(chapter)), chapterTextPath(chapter))) !== ledger.textSha256;
  };
  for (const chapter of [...touched].sort((a, b) => a - b)) {
    if ((await mismatched(undone, chapter)) && !(await mismatched(current, chapter))) {
      return fail("guard_mismatch", `撤完第 ${chapter} 章的正文和账对不上，没撤。`, { chapter });
    }
  }

  const changes: PlannedChange[] = [];
  for (const [path, key] of [...preimage].sort(([a], [b]) => a.localeCompare(b))) {
    if (current.get(path) === key) continue;
    changes.push({ path, expect: currentSha.get(path) ?? null, content: key === undefined ? null : textOf(await store.bytes(key, path), path) });
  }
  return {
    ok: true,
    receipts: writes.map((receipt) => receipt.key),
    changes,
    impact,
    impactDigest: digestOf(impact.map((item) => ({ ...item, now: currentSha.get(item.path) ?? null }))),
    rangeDigest: rangeDigestOf(files),
  };
}

interface CheckInput {
  readonly store: HistoryStore;
  readonly all: readonly CommandReceipt[];
  readonly writes: readonly CommandReceipt[];
  readonly groupKeys: ReadonlySet<string>;
  readonly at: (j: number) => Version;
  readonly k: number;
  readonly first: ReadonlyMap<string, number>;
  readonly undone: Version;
}

async function fileReferencers(store: HistoryStore, path: string, key: string | undefined): Promise<Referencer[]> {
  if (key === undefined) return [];
  if (path === DECISIONS_PATH) return decisionReferencers(await store.decisions(key));
  if (path === CARDS_PATH) return cardReferencers(await store.cards(key));
  return ledgerReferencers(await store.ledger(key, path), path);
}

async function truthOf(store: HistoryStore, version: Version): Promise<TruthView> {
  const ledgers = [];
  for (const [path, key] of version) if (ledgerChapterOfPath(path) !== undefined) ledgers.push(await store.ledger(key, path));
  return { ledgers, decisions: await store.decisions(version.get(DECISIONS_PATH)), cards: await store.cards(version.get(CARDS_PATH)) };
}

async function checkReferences(input: CheckInput): Promise<CommandFailure | undefined> {
  const { store, all, writes, groupKeys, at, k, first, undone } = input;
  const digests = new Map<string, Map<string, string>>();
  const digestIn = async (path: string, key: string | undefined, id: string): Promise<string | undefined> => {
    const memo = `${path}|${key ?? ""}`;
    let map = digests.get(memo);
    if (!map) {
      map = new Map((await fileReferencers(store, path, key)).map((item) => [item.id, item.digest]));
      digests.set(memo, map);
    }
    return map.get(id);
  };

  // 每条引用者：L(x)、s(x)；这次之前就在、没被换掉的直接过（基准就是 U）。
  const groups = new Map<string, { readonly s: number; readonly last: number; readonly members: Referencer[] }>();
  for (const [path, key] of undone) {
    if (!isReferenceFile(path)) continue;
    for (const x of await fileReferencers(store, path, key)) {
      const replaced = first.has(x.file);
      const last = replaced ? (first.get(x.file) as number) : k + 1;
      let s = last;
      while (s > 1 && (await digestIn(x.file, at(s - 1).get(x.file), x.id)) === x.digest) s -= 1;
      if (s === 1 && !replaced) continue;
      const id = `${s}:${last}`;
      const found = groups.get(id) ?? { s, last, members: [] };
      found.members.push(x);
      groups.set(id, found);
    }
  }
  if (groups.size === 0) return undefined;

  const refPaths = new Set<string>();
  for (let j = 1; j <= k + 1; j += 1) for (const path of at(j).keys()) if (isReferenceFile(path)) refPaths.add(path);
  for (const path of undone.keys()) if (isReferenceFile(path)) refPaths.add(path);

  // 窗口 (r_{s−1} 写完, T_s] 里别的回执写过哪些文件、有没有升级之前的回执。
  const windows = new Map<number, { readonly paths: ReadonlySet<string>; readonly legacy: boolean }>();
  const windowOf = (s: number): { readonly paths: ReadonlySet<string>; readonly legacy: boolean } => {
    const cached = windows.get(s);
    if (cached) return cached;
    const low = time(writes[s - 2] as CommandReceipt);
    const high = s <= k ? time(writes[s - 1] as CommandReceipt) : Number.POSITIVE_INFINITY;
    const inside = all.filter((receipt) => !groupKeys.has(receipt.key) && time(receipt) >= low && time(receipt) <= high);
    const window = { paths: new Set(inside.flatMap((receipt) => (receipt.effects ?? []).map((effect) => effect.path))), legacy: inside.some((receipt) => receipt.effects === undefined) };
    windows.set(s, window);
    return window;
  };
  const windowClean = async (s: number, path: string): Promise<boolean> => {
    const window = windowOf(s);
    if (window.legacy || window.paths.has(path)) return false;
    const wrote = (writes[s - 2] as CommandReceipt).effects?.find((effect) => effect.path === path);
    const start = wrote ? wrote.after : await store.sha(at(s - 1).get(path), path);
    return start === (await store.sha(at(s).get(path), path));
  };

  let resolvedUndone: Resolver | undefined;
  const referenced: RefWhere[] = [];
  const unprovable: RefWhere[] = [];
  for (const { s, last, members } of groups.values()) {
    const base = new Map<string, string>();
    let provable = true;
    for (const path of refPaths) {
      const firstWrite = first.get(path);
      let key: string | undefined;
      if (firstWrite !== undefined && firstWrite < s) {
        // 这次操作在 x 出现之前就写过它：要 x 写下时接着的那版，得有证据。
        if (!(await windowClean(s, path))) {
          provable = false;
          break;
        }
        key = at(s).get(path);
      } else if (firstWrite !== undefined && firstWrite < last) {
        // x 存续期间这次操作第一次写它之前那版 = 前像 = U 里的。
        key = undone.get(path);
      } else {
        key = at(last).get(path);
      }
      if (key !== undefined) base.set(path, key);
    }
    if (!provable) {
      unprovable.push(...members.map((member) => member.where));
      continue;
    }
    // 整组比：全集上内容键都一样就整组过。
    if ([...refPaths].every((path) => base.get(path) === undone.get(path))) continue;
    resolvedUndone ??= new Resolver(await truthOf(store, new Map([...undone].filter(([path]) => isReferenceFile(path)))));
    const resolvedBase = new Resolver(await truthOf(store, base));
    for (const member of members) {
      const left = resolvedUndone.identities(member);
      const right = resolvedBase.identities(member);
      if (left.some((identity, index) => identity !== right[index])) referenced.push(member.where);
    }
  }
  if (unprovable.length > 0) {
    return fail("unprovable", `${describeWhere(unprovable)}接着的东西在这次操作之后被别处改过，分不清是照哪一版写的。先处理那边（改账或撤销那次），再撤这次。`, { where: unprovable });
  }
  if (referenced.length > 0) {
    return fail("referenced", `${describeWhere(referenced)}还接着这次改的东西。先处理那边（改账或撤销那次），再撤这次。`, { where: referenced });
  }
  return undefined;
}
