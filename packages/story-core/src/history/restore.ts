/**
 * 整本恢复的计划（写作版本 P2a 片 4B，设计 8.2）：按存档树算——存档有、内容不同 → 写；存档没有、现在有 → 删。
 * 冻结的是整个撤销范围的摘要：应用时（history.apply）在书锁里重新枚举、重算，一样才写；多了、少了、变了任何一个就重算、重新确认。
 * 范围外的（操作、候选、恢复稿、控制文件、回执、镜像）不动。只读：不写盘、不拿锁。
 */
import { fail } from "../commands/runner.js";
import type { CommandFailure } from "../commands/types.js";
import { sha256Bytes } from "../store/transaction.js";
import type { PlannedChange } from "./revert.js";
import { HistoryFileError, HistoryStore, ledgerChapterOfPath, rangeDigestOf, readUndoableFiles, type HistoryReader } from "./store.js";
import { isLedgerV1, upgradeLedgerV1 } from "../ledger/migrate-v1.js";
import { CARDS_PATH, chapterFromFileName, chapterTextPath } from "../store/paths.js";

export interface RestorePlan {
  readonly ok: true;
  readonly changes: readonly PlannedChange[];
  /** 计划时整个撤销范围的摘要。 */
  readonly rangeDigest: string;
}

/**
 * 存档里那份要写回去的字。账本升级之前的存档：旧账当场用迁移器升成新格式（配对的正文取同一份存档里那一章），
 * 写的是升好的那份——书里永远只有新格式；恢复回执记的就是实际写下去的这份，所以这次恢复照样能撤。
 */
async function restoredContent(store: HistoryStore, target: ReadonlyMap<string, string>, path: string, key: string): Promise<string | CommandFailure> {
  const raw = await store.text(key, path);
  const chapter = ledgerChapterOfPath(path);
  if (chapter === undefined || !isLedgerV1(raw)) return raw;
  const textKey = target.get(chapterTextPath(chapter));
  const upgraded = upgradeLedgerV1(raw, textKey === undefined ? undefined : await store.text(textKey, chapterTextPath(chapter)));
  if (!upgraded.ok) return fail("ledger_unreadable", `那份存档里第 ${chapter} 章的账本读不了，恢复不了：${upgraded.reason}。`, { path });
  return `${JSON.stringify(upgraded.ledger, null, 2)}\n`;
}

/**
 * 存档是不是这本书接上新核心之前的：有定稿正文却没有那章的账单（账单是导入老书时才建的；接上之后定稿、导入都是正文和账单一起写），
 * 或者现在有设定卡、存档里没有（设定卡是 P9 起开书时搬的）。恢复过去会删掉账、设定，开书也不会再导一次（那几笔只做一次），
 * 所以如实拦下；要那时的正文，存档里「查看改动」还看得到。
 */
function beforeCore(target: ReadonlyMap<string, string>, current: ReadonlyMap<string, unknown>): boolean {
  if (current.has(CARDS_PATH) && !target.has(CARDS_PATH)) return true;
  const ledgers = new Set([...target.keys()].map(ledgerChapterOfPath).filter((chapter) => chapter !== undefined));
  return [...target.keys()].some((path) => {
    if (!path.startsWith("chapters/") || !path.endsWith(".md")) return false;
    const chapter = chapterFromFileName(path.slice("chapters/".length));
    return chapter !== undefined && !ledgers.has(chapter);
  });
}

export async function planRestore(bookDir: string, tree: string, reader: HistoryReader): Promise<RestorePlan | CommandFailure> {
  const store = new HistoryStore(reader);
  try {
    const target = await store.list(tree);
    if (!target) return fail("tree_gone", "这份存档已经裁掉了，恢复不了。");
    const files = await readUndoableFiles(bookDir);
    if (beforeCore(target, files)) return fail("before_core", "这份存档早于这本书现在的账本和设定，整本恢复会把账和设定丢掉，恢复不了。");
    const current = new Map([...files].map(([path, bytes]) => [path, store.pin(bytes)]));
    const changes: PlannedChange[] = [];
    for (const path of [...new Set([...target.keys(), ...current.keys()])].sort()) {
      const wanted = target.get(path);
      if (wanted === current.get(path)) continue;
      const now = files.get(path);
      const content = wanted === undefined ? null : await restoredContent(store, target, path, wanted);
      if (typeof content === "object" && content !== null) return content;
      // 升好的旧账和现在那份一字不差：不用写。
      if (content !== null && now !== undefined && content === now.toString("utf-8")) continue;
      changes.push({ path, expect: now === undefined ? null : sha256Bytes(now), content });
    }
    return { ok: true, changes, rangeDigest: rangeDigestOf(files) };
  } catch (error) {
    if (error instanceof HistoryFileError) return fail(error.code, error.message, { path: error.path });
    throw error;
  }
}
