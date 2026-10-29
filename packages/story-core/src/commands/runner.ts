/**
 * 写命令的执行器：所有写操作都从这里过，命令自己不碰盘。
 *
 * 顺序固定：查权限 → 校参数 → 加书锁 → 收拾上次没写完的事务 → 有回执就回放（同键换参数就拒绝）→ 栅栏（precondition）→
 * 核依据 → plan → 打快照 → 事务落盘（正文 / 账单 / 裁定 + 回执 + 写入代次 + 版本号，版本号最后写；工作稿不动版本号和写入代次，
 * 写了哪章工作稿就在同一个事务里换那章的工作稿代次）→ 推事件。
 * 回执记下撤销范围里每个文件换之前、换之后的哈希（effects）和写之前那份存档的树号（写作版本 P2a）。
 * 什么都不用改的也留回执（带了防重复标记的话）：不然这次请求迟到重发，会把这之间别人改的盖回去。
 * 任何一步不成都如实返回失败，书保持原样。
 */
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { BOOK_HEAD_SCHEMA, COMMAND_RECEIPT_SCHEMA, CommandReceipt } from "../schema/book.js";
import { canonicalJson, diffTruthBasis } from "../store/basis.js";
import { BookFileError, readHead, readTruthBasis } from "../store/book.js";
import { bookKey, withBookLock } from "../store/lock.js";
import { draftGensWrite, readDraftGens, revisionWrite } from "../store/control.js";
import { assertInsideBook, draftChapterOfPath, HEAD_PATH, isUndoablePath, receiptPath } from "../store/paths.js";
import { commitFiles, recoverTransactions, sha256Bytes, type RecoveryReport, type TxEffect, type TxWrite } from "../store/transaction.js";
import type { BookEvent, CommandFailure, CommandOutcome, RunOptions, WriteCommandSpec, WritePlan } from "./types.js";

export function fail(code: string, message: string, details?: unknown): CommandFailure {
  return { ok: false, code, message, ...(details !== undefined ? { details } : {}) };
}

function isFailure(value: unknown): value is CommandFailure {
  return typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === false;
}

function keyHash(key: string): string {
  return createHash("sha256").update(key, "utf-8").digest("hex").slice(0, 32);
}

function argsHashOf(args: unknown): string {
  return createHash("sha256").update(canonicalJson(args), "utf-8").digest("hex");
}

/** 撤销范围里这几个文件换之前、换之后的哈希（换之前按盘上原始字节算；不存在是 null）。 */
async function undoableEffects(bookDir: string, writes: readonly TxWrite[]): Promise<TxEffect[]> {
  const effects: TxEffect[] = [];
  for (const write of writes) {
    const path = assertInsideBook(write.path);
    if (!isUndoablePath(path)) continue;
    let before: string | null = null;
    try {
      if ((await lstat(join(bookDir, path))).isFile()) before = sha256Bytes(await readFile(join(bookDir, path)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    effects.push({ path: path.split(sep).join("/"), before, after: sha256Bytes(write.content) });
  }
  return effects;
}

/** 一次操作一步的幂等键（没另给键时用它）。 */
export const opCommandKey = (op: { readonly opId: string; readonly stepId: string }): string => `op:${op.opId}:${op.stepId}`;

/** 这个键的回执（没有 / 不是这个键的 → undefined）。命令之后的事出了意外时，调用方据此判断真相已经写上没有（读路径，不拿锁）。 */
export async function readCommandReceipt(bookDir: string, key: string): Promise<CommandReceipt | undefined> {
  return readReceipt(bookDir, key);
}

async function readReceipt(bookDir: string, key: string): Promise<CommandReceipt | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(bookDir, receiptPath(keyHash(key))), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const parsed = CommandReceipt.safeParse(JSON.parse(raw));
  return parsed.success && parsed.data.key === key ? parsed.data : undefined;
}

export async function runCommand<A, R>(
  bookDir: string,
  spec: WriteCommandSpec<A, R>,
  rawArgs: unknown,
  options: RunOptions,
): Promise<CommandOutcome<R>> {
  if (spec.tier === "author" && options.caller !== "author") {
    return fail("author_only", "这一步只能由你在界面上点按钮来做，AI 不能替你做。");
  }
  const key = options.idempotencyKey?.trim() || (options.op ? opCommandKey(options.op) : undefined);
  if (spec.idempotent && !key) return fail("missing_idempotency_key", "这一步缺少防重复的标记，没有执行。");
  const parsed = spec.args.safeParse(rawArgs);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return fail("invalid_args", `参数不对：${first?.path.join(".") || "整体"}：${first?.message ?? "格式不对"}`, parsed.error.issues);
  }

  return withBookLock(bookDir, async () => {
    let recovery: RecoveryReport;
    try {
      recovery = await recoverTransactions(bookDir);
    } catch (error) {
      return fail("book_unreadable", "这本书的目录读不了，没有执行。", error instanceof Error ? error.message : String(error));
    }
    if (recovery.problems.length > 0) {
      return fail("transaction_residue", "上次写到一半的记录读不了，先不动这本书，免得丢数据。作者确认后可以把它挪到一边留证，再继续写。", recovery);
    }
    const notice = recovery.rolledBack.length > 0 || recovery.keptOverLimit ? { recovered: recovery } : {};
    const argsHash = argsHashOf(options.intent !== undefined ? options.intent : parsed.data);
    if (key) {
      const receipt = await readReceipt(bookDir, key);
      if (receipt) {
        if (receipt.command !== spec.name) return fail("idempotency_key_reused", "防重复标记被别的操作用过了，没有执行。");
        if (receipt.argsHash !== undefined && receipt.argsHash !== argsHash) {
          return fail("idempotency_args_changed", "这一步已经按上一次的选择做过了，这次的选择没有执行。");
        }
        return { ok: true, result: receipt.result as R, version: receipt.version, changed: receipt.changed, replayed: true, ...notice };
      }
    }
    if (options.precondition) {
      const blocked = await options.precondition();
      if (blocked) return blocked;
    }
    if (options.basis) {
      let changes;
      try {
        changes = diffTruthBasis(options.basis, await readTruthBasis(bookDir));
      } catch (error) {
        return fail("book_unreadable", "这本书的目录读不了，没有执行。", error instanceof Error ? error.message : String(error));
      }
      if (changes.length > 0) return fail("basis_changed", "预览之后书里有地方改过，这张预览作废了，请重新预览一次。", { changes });
    }

    const now = options.now?.() ?? new Date();
    const draftGen = randomUUID();
    let planned: Awaited<ReturnType<typeof spec.plan>>;
    try {
      planned = await spec.plan({ bookDir, caller: options.caller, now, draftGen }, parsed.data);
    } catch (error) {
      if (error instanceof BookFileError) return fail("book_file_invalid", error.message);
      return fail("plan_failed", "这一步出了意外，书保持原样。", error instanceof Error ? error.message : String(error));
    }
    if (isFailure(planned)) return planned;
    const head = await readHead(bookDir);
    const at = now.toISOString();
    const receiptOf = (version: number, changed: WritePlan<R>["changed"], effects: readonly TxEffect[], snapshotTree?: string): TxWrite => {
      const receipt: CommandReceipt = {
        schema: COMMAND_RECEIPT_SCHEMA, key: key as string, command: spec.name, version, at, changed, result: planned.result, argsHash,
        ...(options.op ? { opId: options.op.opId, stepId: options.op.stepId } : {}),
        effects: [...effects],
        ...(snapshotTree ? { snapshotTree } : {}),
      };
      return { path: receiptPath(keyHash(key as string)), content: `${JSON.stringify(receipt, null, 2)}\n` };
    };
    if (planned.writes.length === 0) {
      // 不用改也留回执：同一请求迟到重发时回放这次的结果，不会照那时的参数再执行一遍。
      if (key) {
        try {
          await commitFiles(bookDir, [receiptOf(head.version, {}, [])]);
        } catch (error) {
          return fail("write_failed", "写盘没成功，书保持原样。", error instanceof Error ? error.message : String(error));
        }
      }
      return { ok: true, result: planned.result, version: head.version, changed: {}, replayed: false, ...notice };
    }

    let snapshotTree: string | undefined;
    if (spec.snapshot && options.snapshot) {
      try {
        snapshotTree = (await options.snapshot(planned.label, spec.name)) || undefined;
      } catch (error) {
        return fail("snapshot_failed", "没能先存撤销点，这次没有写。", error instanceof Error ? error.message : String(error));
      }
    }

    const bumps = spec.bumpsVersion !== false;
    const version = bumps ? head.version + 1 : head.version;
    // 代次第一个换上（之后哪一步写失败回滚，换回原样后再换新的）、版本号最后一个（读的一方据此判断有没有读到一半）。
    // 写了工作稿的，那几章的工作稿代次跟着换（在工作稿之前写：正赶上读的，算出来的版本号谁都对不上）。
    const draftChapters = [...new Set(planned.writes.flatMap((write) => {
      const chapter = draftChapterOfPath(write.path);
      return chapter === undefined ? [] : [chapter];
    }))];
    let gens: TxWrite[] = [];
    if (draftChapters.length > 0) {
      try {
        gens = [draftGensWrite(await readDraftGens(bookDir), draftChapters, draftGen)];
      } catch (error) {
        return fail("book_unreadable", "这本书的目录读不了，没有执行。", error instanceof Error ? error.message : String(error));
      }
    }
    const writes: TxWrite[] = [...(bumps ? [revisionWrite(now)] : []), ...gens, ...planned.writes];
    if (key) {
      let effects: TxEffect[];
      try {
        effects = await undoableEffects(bookDir, planned.writes);
      } catch (error) {
        return fail("book_unreadable", "这本书的目录读不了，没有执行。", error instanceof Error ? error.message : String(error));
      }
      writes.push(receiptOf(version, planned.changed, effects, snapshotTree));
    }
    if (bumps) writes.push({ path: HEAD_PATH, content: `${JSON.stringify({ schema: BOOK_HEAD_SCHEMA, version, updatedAt: at }, null, 2)}\n` });
    try {
      await commitFiles(bookDir, writes);
    } catch (error) {
      return fail("write_failed", "写盘没成功，书保持原样。", error instanceof Error ? error.message : String(error));
    }

    const event: BookEvent = { book: bookKey(bookDir), version, command: spec.name, label: planned.label, changed: planned.changed, at };
    options.emit?.(event);
    return { ok: true, result: planned.result, version, changed: planned.changed, replayed: false, ...notice };
  });
}
