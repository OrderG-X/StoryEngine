/**
 * 栅栏、暂停入口、派生发布（写作版本 P2a 设计 6.2、6.3）。
 *
 * - **栅栏**：worker 的每一笔写都在书锁里先核栅栏再写（同一次持锁）。栅栏先看本次执行的 signal（内存），再看书目录在不在、
 *   书的纪元没换、盘上记录还是 running 且 runEpoch 是这一次。所有改状态的事都在书锁里（store.changeOperation），
 *   所以书锁里读到的状态就是准的。核心命令把它当 precondition（runner 书锁里、事务前跑）。
 * - **暂停只有一个入口** pauseOperation：先停住本次执行（同步打断 signal，之后发不出、写不进），再按锁序换状态；
 *   换完才算「已暂停」（事件、卡片在这之后）。正拿着书锁在写的那一笔已经过了栅栏，让它写完（对账列出来）。
 * - **派生发布**：锁外算好，短拿书锁核书目录在、纪元没换、head 还是算的那版，才发布；核不过丢掉、记一句，不建目录。
 */
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fail, readBookEpoch, readHead, withBookLock, type CommandFailure } from "@actalk/story-core";
import { abortExecution, currentOperation, OperationStopped, StopSignal, stopOf, type OperationContext } from "./context.js";
import { assertNotHoldingRecordLock, changeOperation, readOperation, type OperationRecord, type PauseReason } from "./store.js";

async function bookDirExists(bookDir: string): Promise<boolean> {
  try {
    return (await stat(bookDir)).isDirectory();
  } catch {
    return false;
  }
}

/** 核栅栏（调用方拿着书锁）。不过返回失败（核心命令的 precondition 形状）。 */
export async function checkFence(context: OperationContext): Promise<CommandFailure | undefined> {
  if (context.signal.aborted) {
    const stop = stopOf(context.signal.reason);
    return fail("operation_stopped", stop?.type === "pause" ? "这次已经暂停了，没有写。" : stop?.type === "wait" ? "这次在等作者点按钮，没有写。" : "这次已经停掉了，没有写。");
  }
  if (!(await bookDirExists(context.bookDir))) return fail("book_gone", "这本书已经不在原处了，没有写。");
  if ((await readBookEpoch(context.bookDir)) !== context.bookEpoch) {
    return fail("book_epoch_changed", "这本书在这期间整本恢复过（或从备份、回收站搬回过），这次停下了，没有写。");
  }
  const stored = await readOperation(context.bookDir, context.opId);
  if (stored.kind !== "record" || stored.record.state !== "running" || stored.record.runEpoch !== context.runEpoch) {
    return fail("operation_stopped", "这次已经停掉了，没有写。");
  }
  return undefined;
}

/** 给核心命令的 precondition。 */
export const fencePrecondition = (context: OperationContext) => (): Promise<CommandFailure | undefined> => checkFence(context);

/** 一笔受栅栏管的写：书锁里核栅栏、同一次持锁里写；不过抛 OperationStopped。 */
export async function withFence<T>(context: OperationContext, write: () => Promise<T>): Promise<T> {
  assertNotHoldingRecordLock();
  return withBookLock(context.bookDir, async () => {
    const blocked = await checkFence(context);
    if (blocked) throw new OperationStopped(blocked.code, blocked.message);
    return write();
  });
}

/**
 * 书里的缓存写（设计 6.3：核账记忆、改句记录、跟读笔记、卷笔记——按内容键整份覆盖，步骤里可写）：
 * - 在这本书的一次操作里 → 栅栏里写（书锁里核栅栏、同一次持锁写，停掉 / 暂停之后写不进）；
 * - 在**别的书**的操作里 → 拒绝（Astra P2a 第 8 轮第 3 条：不当成操作外的写放过去，不然停掉的操作还能写别的书）；
 * - 不在操作里（还没迁走的旧入口）→ 同一次持书锁里先核书目录在、再写：删书进回收站也拿这把锁，
 *   不会核过之后书被挪走、写又在原处建出幽灵目录（第 8 轮第 3 条）。
 */
export async function writeBookCache<T>(bookDir: string, write: () => Promise<T>): Promise<T> {
  const context = currentOperation();
  if (context) {
    if (resolve(context.bookDir) !== resolve(bookDir)) {
      throw new OperationStopped("cross_book_write", "这次操作只写它自己那本书，别的书没有写。");
    }
    return withFence(context, write);
  }
  assertNotHoldingRecordLock();
  return withBookLock(bookDir, async () => {
    if (!(await bookDirExists(bookDir))) throw new OperationStopped("book_gone", "这本书已经不在原处了，没有写。");
    return write();
  });
}

/**
 * 暂停入口（设计 6.2）。第一段停住本次执行（同步），第二段书锁 → 记录锁换状态：记录还是这个 runEpoch、还在 queued / running 才换
 * （已经被取消、被别的暂停换过就什么都不做），换成 paused、runEpoch + 1。reconcile 在换状态前按回执补「已应用」（executor 给）。
 * 返回换完的记录；没换返回 undefined。拿着记录锁时不能调（第二段要书锁）。
 */
export async function pauseOperation(
  bookDir: string,
  opId: string,
  runEpoch: number,
  reason: PauseReason,
  reconcile?: (record: OperationRecord) => Promise<OperationRecord>,
): Promise<OperationRecord | undefined> {
  abortExecution(bookDir, opId, { type: "pause", reason }, runEpoch);
  assertNotHoldingRecordLock();
  let reconciled: OperationRecord | undefined;
  if (reconcile) {
    const stored = await readOperation(bookDir, opId);
    if (stored.kind === "record") reconciled = await reconcile(stored.record);
  }
  let changed = false;
  const record = await changeOperation(bookDir, opId, (current) => {
    if (current.runEpoch !== runEpoch || (current.state !== "running" && current.state !== "queued")) return undefined;
    changed = true;
    const base = reconciled && reconciled.eventSeq === current.eventSeq ? reconciled : current;
    return { ...base, state: "paused", pauseReason: reason, runEpoch: runEpoch + 1 };
  });
  return changed ? record : undefined;
}

/** 这次执行被停了：给调用方抛的错（暂停、取消都是）。 */
export function stoppedError(context: OperationContext): OperationStopped {
  const stop = stopOf(context.signal.reason);
  return new OperationStopped("operation_stopped", stop?.type === "pause" ? "这次已经暂停了。" : stop?.type === "wait" ? "这次在等作者点按钮。" : "这次已经停掉了。");
}

export { StopSignal };

/* ------------------------------------------------------------------ */
/*  派生发布                                                            */
/* ------------------------------------------------------------------ */

export type DerivedOutcome = { readonly published: true } | { readonly published: false; readonly warning: string };

/**
 * 派生物（定稿后统计、自动备份）：sourceVersion 是算的时候 head 的版本号，compute 在书锁外按「此刻的真相」算好，
 * publish 在短拿的书锁里把算好的东西放进去（rename）。核不过就不发布、返回一句 warning（不在原处建目录、不发布旧版本）。
 */
export async function publishDerived<T>(
  bookDir: string,
  compute: () => Promise<{ readonly sourceVersion: number; readonly value: T }>,
  publish: (value: T) => Promise<void>,
): Promise<DerivedOutcome> {
  const epoch = await readBookEpoch(bookDir).catch(() => undefined);
  const computed = await compute();
  assertNotHoldingRecordLock();
  return withBookLock(bookDir, async () => {
    if (!(await bookDirExists(bookDir))) return { published: false, warning: "书已经不在原处，没有更新。" };
    if (epoch === undefined || (await readBookEpoch(bookDir)) !== epoch) return { published: false, warning: "书在这期间整本恢复过，没有更新。" };
    if ((await readHead(bookDir)).version !== computed.sourceVersion) return { published: false, warning: "书在这期间又改过，这份没有更新（下次会跟上）。" };
    await publish(computed.value);
    return { published: true };
  });
}
