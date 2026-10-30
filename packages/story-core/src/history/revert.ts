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
 * 「撤销上一步」撤哪次（写作版本 P2a 片 4C）：最近一次写过撤销范围、还没被撤的。撤销、整本恢复本身跳过；被撤过的跳过
 * （撤它的那次后来又被撤了，就不算被撤）；整本恢复（真换了东西的）之前的不算：恢复已经把它们换掉了。
 * 升级之前的写（回执没有效果记录）也算一次：撤的时候如实说只能整本恢复。之前没留存档的写（建书、导入时写的那一笔）是这本书的起点，
 * 到它就停：再往前没什么能撤。没有返回 undefined。receipts 按写的先后排好。
 */
export function lastUndoable(receipts: readonly CommandReceipt[]): RevertTarget | undefined {
  const undone = new Set<string>();
  for (let index = receipts.length - 1; index >= 0; index -= 1) {
    const receipt = receipts[index] as CommandReceipt;
    const id = targetId(targetOf(receipt));
    if (undone.has(id)) continue;
    if (receipt.command === HISTORY_APPLY_COMMAND) {
      const result = receipt.result as { readonly kind?: unknown; readonly target?: unknown } | null | undefined;
      if (result?.kind === "restore") {
        if ((receipt.effects ?? []).length > 0) return undefined;
        continue;
      }
      const target = revertTargetOf(result?.target);
      if (target) undone.add(targetId(target));
      continue;
    }
    if (receipt.effects !== undefined && receipt.effects.length === 0) continue;
    if (receipt.effects !== undefined && !receipt.snapshotTree) return undefined;
    return targetOf(receipt);
  }
  return undefined;
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
  if (group.some((receipt) => receipt.effects === undefined)) return fail("legacy_receipt", "这次改动是升级之前做的，撤不了，只能整本回到那之前的存档。");
  const writes = group.filter((receipt) => (receipt.effects ?? []).length > 0);
  if (writes.length === 0) return fail("nothing_to_undo", "这次没改过能撤的东西。");
  if (writes.some((receipt) => !receipt.snapshotTree)) return fail("no_tree", "这次改动之前没留存档，撤不了，只能整本恢复。");
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
