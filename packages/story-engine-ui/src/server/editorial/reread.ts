/**
 * 通读记账（P8 导入连载，设计见 docs/rebuild/P8-serial-import-design.md）。
 *
 * 导入已写的书后，每章只有一份空账单。记账员从第 1 章起一章一章读、一章一章记：
 *   读真相 → 投影（算到上一章）→ 记账员交账单（前文笔记必须补齐，不走冷窗口）→ 核原句、分流
 *   → 去掉「会改前文不会变的事实」那几条（定稿时这种默认不写、要作者勾，通读没人勾，就不写）→ 「通读记账」命令。
 * 一章最多试 REREAD_ATTEMPTS 次，还不成就停下、如实记原因，等作者点「接着记」。
 * 记账员读的是哪一版书（依据）跟着命令走：读完之后书上有任何写（作者确认了定论、改了设定、撤销……），这章这遍的账不记，
 * 照新的样子重读重记（写作版本 P1a 复核：不然旧正文的梗概会挂到新正文上）。这种重来不算一次失败，最多 BASIS_RETRIES 回。
 *
 * 在书的补读队列里跑（和后台补读排同一条队，不同时打模型服务商）。进程重启后开书接着记（状态文件里是 running）；
 * 停下的不自动重试（一直失败的话每次开书都白花一轮调用），作者点了才接着记。
 */
import { randomBytes } from "node:crypto";
import {
  checkEntries,
  classifyForReview,
  ledgerReread,
  project,
  readBookSnapshot,
  readChapterLedger,
  readChapterText,
  runCommand,
  sha256,
  withBookLock,
} from "@actalk/story-core";
import { recoverProjectCommitTransactions } from "../book/legacy-commit-recovery.js";
import { syncLegacyMirror } from "../book/mirror/sync.js";
import { runInReaderCatchUpQueue } from "./catch-up.js";
import { callConfiguredBrainModel } from "./checker.js";
import { touchesHardFact } from "./commit-flow.js";
import { runLedgerKeeper } from "./ledger-keeper.js";
import type { BrainCallModel } from "./reader-window.js";
import { readRereadState, REREAD_STATE_SCHEMA, writeRereadState, type RereadState } from "./reread-state.js";

/** 一章最多试几次（模型偶尔交坏 JSON、连接断一下都很正常）。 */
export const REREAD_ATTEMPTS = 3;
/** 记的途中书变了、照新的重记：一章最多重来几回（作者一直在改就停下，等「接着记」）。 */
export const BASIS_RETRIES = 5;

export interface RereadOptions {
  readonly callModel?: BrainCallModel;
  /** 记完之后调一次（编辑部入口拿它排核账员、章纲员的后台补读）。 */
  readonly onDone?: (total: number) => void;
  readonly now?: () => Date;
}

/** 这本书正在跑的通读（进程内）：同一本书只跑一轮。 */
const active = new Set<string>();

export function isRereadActive(projectDir: string): boolean {
  return active.has(projectDir);
}

/** 记一轮新的通读：要记到第 total 章，从第 1 章起。 */
export async function beginReread(projectDir: string, total: number, now: Date = new Date()): Promise<RereadState> {
  const at = now.toISOString();
  return writeRereadState(projectDir, {
    schema: REREAD_STATE_SCHEMA,
    status: "running",
    run: randomBytes(6).toString("hex"),
    total,
    done: 0,
    recorded: 0,
    skipped: 0,
    startedAt: at,
    updatedAt: at,
    resumedAt: at,
    doneAtResume: 0,
  });
}

type ChapterOutcome =
  | { readonly ok: true; readonly recorded: number; readonly skipped: number }
  /** bookChanged：记的途中书变了（不是记账员的错），照新的重记。 */
  | { readonly ok: false; readonly reason: string; readonly bookChanged?: true };

function oneLine(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error)).trim().split(/\s+/u).join(" ");
  return text.length > 120 ? `${text.slice(0, 120)}…` : text || "未知错误";
}

async function rereadChapter(projectDir: string, chapter: number, run: string, callModel: BrainCallModel): Promise<ChapterOutcome> {
  // 先读快照（带依据）再读正文；正文和快照里记的对不上 = 两次读之间有写，照新的重来。
  const snapshot = await readBookSnapshot(projectDir);
  if (snapshot.unsettled) return { ok: false, reason: "这本书正在写盘", bookChanged: true };
  const text = await readChapterText(projectDir, chapter);
  if (text === undefined) return { ok: false, reason: `第 ${chapter} 章的正文不见了` };
  if (snapshot.basis.texts[String(chapter)] !== sha256(text)) return { ok: false, reason: "记的途中这章正文改过", bookChanged: true };
  const before = project(snapshot, { upTo: chapter - 1 });
  const keeper = await runLedgerKeeper({ projectDir, chapter, draft: text, before, callModel, maxCatchUp: Number.MAX_SAFE_INTEGER });
  if (!keeper.ok) return { ok: false, reason: keeper.reason };
  const checked = checkEntries(keeper.parsed.entries, text, before);
  const plan = classifyForReview(checked.accepted, before, { chapter });
  const optIn = new Set(plan.review.filter((item) => touchesHardFact(item, before)).map((item) => item.index));
  const entries = checked.accepted.filter((item) => !optIn.has(item.index)).map((item) => item.entry);
  // 这一轮这一章只记一次：记完进程被杀、接着记时重跑记账员，账会不一样，照样回放上次记下的（不算换了选择）。
  // 依据是记账员读的那一版：之后书上有写就不记（核心先回放、再核依据）。
  // 老格式事务（升级前崩溃留下的）先收拾再记：收拾会换写入代次，照没收拾的半截真相记的就核不过依据（第 4 轮复核 R9）。
  const outcome = await withBookLock(projectDir, async () => {
    await recoverProjectCommitTransactions(projectDir);
    return runCommand(projectDir, ledgerReread, { chapter, entries }, {
      caller: "author",
      idempotencyKey: `reread:${run}:${chapter}`,
      intent: { chapter },
      basis: snapshot.basis,
    });
  });
  if (!outcome.ok) return outcome.code === "basis_changed" ? { ok: false, reason: "记的途中书改过", bookChanged: true } : { ok: false, reason: outcome.message };
  return {
    ok: true,
    recorded: outcome.result.recorded,
    skipped: checked.rejected.length + optIn.size + keeper.parsed.drops.length + outcome.result.rejected.length,
  };
}

async function rereadLoop(projectDir: string, options: RereadOptions): Promise<RereadState | undefined> {
  const now = () => (options.now?.() ?? new Date()).toISOString();
  let state = await readRereadState(projectDir);
  if (!state || state.status === "done") return state;
  // 每次接着记（停下后点「接着记」、进程重启后开书）都从这会儿起重新计时：估剩余时间不算停着的那段。
  const { stoppedReason: _dropped, ...rest } = state;
  state = await writeRereadState(projectDir, { ...rest, status: "running", resumedAt: now(), doneAtResume: state.done, updatedAt: now() });
  const callModel = options.callModel ?? callConfiguredBrainModel;
  for (let chapter = state.done + 1; chapter <= state.total; chapter += 1) {
    // 上次记完这章、还没来得及落进度就停了：账单已经是通读记的，不再花一次调用。
    const existing = await readChapterLedger(projectDir, chapter).catch(() => undefined);
    let outcome: ChapterOutcome = existing?.origin === "reread" ? { ok: true, recorded: 0, skipped: 0 } : { ok: false, reason: "" };
    let changedRetries = 0;
    for (let attempt = 1; attempt <= REREAD_ATTEMPTS && !outcome.ok; attempt += 1) {
      try {
        outcome = await rereadChapter(projectDir, chapter, state.run, callModel);
      } catch (error) {
        outcome = { ok: false, reason: oneLine(error) };
      }
      // 书变了不算记账员失败：照新的重来，不占次数（一直在变就算一次，免得停不下来）。
      if (!outcome.ok && outcome.bookChanged && changedRetries < BASIS_RETRIES) {
        changedRetries += 1;
        attempt -= 1;
      }
    }
    if (!outcome.ok) {
      return writeRereadState(projectDir, { ...state, status: "stopped", stoppedReason: outcome.reason || "没记上", updatedAt: now() });
    }
    state = await writeRereadState(projectDir, {
      ...state,
      done: chapter,
      recorded: state.recorded + outcome.recorded,
      skipped: state.skipped + outcome.skipped,
      updatedAt: now(),
    });
  }
  state = await writeRereadState(projectDir, { ...state, status: "done", updatedAt: now(), finishedAt: now() });
  // 写作上下文还读老格式文件：记完重生成一次镜像（中途不生成，几百章每章一次太费）。没成只记日志，下次开书会重生成。
  const mirror = await syncLegacyMirror(projectDir).catch((error: unknown) => ({ ok: false as const, reason: oneLine(error) }));
  if (!mirror.ok) console.warn(`[reread] 记完了，老格式镜像没生成：${mirror.reason}`);
  return state;
}

/**
 * 跑（或接着跑）这本书的通读。永不抛错，调用方放心 `void`：出意外就停下、把原因写进状态文件。
 * 已经在跑就直接回；没有通读、已经记完也直接回。
 */
export async function runReread(projectDir: string, options: RereadOptions = {}): Promise<void> {
  if (active.has(projectDir)) return;
  active.add(projectDir);
  let finished: RereadState | undefined;
  try {
    finished = await runInReaderCatchUpQueue(projectDir, () => rereadLoop(projectDir, options));
  } catch (error) {
    console.warn("[reread] 通读出了意外，停下了", error);
    const state = await readRereadState(projectDir);
    if (state && state.status === "running") {
      await writeRereadState(projectDir, { ...state, status: "stopped", stoppedReason: oneLine(error), updatedAt: new Date().toISOString() }).catch(() => undefined);
    }
  } finally {
    active.delete(projectDir);
  }
  if (finished?.status === "done") options.onDone?.(finished.total);
}
