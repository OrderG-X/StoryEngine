/**
 * 通读记账的状态文件（P8 导入连载）：`agents/ledger/reread.json`。纯 I/O + 文案，谁都能 import（不成环）。
 *
 * 导入已写的书后，记账员从第 1 章起一章一章记账；状态记着要记到第几章、记完第几章、在跑 / 停下 / 记完、停下的原因。
 * 进度行、核账 / 定稿 / 拟纲前的那道闸都读它。它不是真相：真相是每章的账单，这份只是「通读到哪了」。
 */
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { writeAtomically } from "./reader-window.js";

export const REREAD_STATE_SCHEMA = "reread/1" as const;

export interface RereadState {
  readonly schema: typeof REREAD_STATE_SCHEMA;
  /** running = 在记（或进程重启前在记，开书时接着记）；stopped = 某章连着记不上，等作者点「接着记」；done = 记完了。 */
  readonly status: "running" | "stopped" | "done";
  /** 这一轮的编号（命令防重复标记用）。 */
  readonly run: string;
  /** 要记到第几章（导入时的章数）。 */
  readonly total: number;
  /** 记完第几章。 */
  readonly done: number;
  /** 记上的条数、没记上的条数（原句核不上、默认不改前文的）。 */
  readonly recorded: number;
  readonly skipped: number;
  readonly startedAt: string;
  readonly updatedAt: string;
  /** 这次接着记是什么时候、那时记完第几章（估还要多久用）。 */
  readonly resumedAt: string;
  readonly doneAtResume: number;
  /** 停下的原因（status = stopped）。 */
  readonly stoppedReason?: string;
  readonly finishedAt?: string;
}

export const rereadStateFile = (root: string): string => join(root, "agents", "ledger", "reread.json");

export async function readRereadState(root: string): Promise<RereadState | undefined> {
  try {
    const parsed = JSON.parse(await readFile(rereadStateFile(root), "utf-8")) as Partial<RereadState>;
    if (parsed.schema !== REREAD_STATE_SCHEMA || typeof parsed.total !== "number" || typeof parsed.done !== "number") return undefined;
    if (parsed.status !== "running" && parsed.status !== "stopped" && parsed.status !== "done") return undefined;
    return parsed as RereadState;
  } catch {
    return undefined;
  }
}

export async function writeRereadState(root: string, state: RereadState): Promise<RereadState> {
  await stat(root); // 书已删就别再写（免得建出幽灵目录）
  await writeAtomically(rereadStateFile(root), `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

/** 还要多久（分钟）：按这次接着记以来的平均每章用时估；这次记了不到 2 章不估。 */
export function rereadEtaMinutes(state: RereadState, now: number = Date.now()): number | undefined {
  if (state.status !== "running") return undefined;
  const doneThisRun = state.done - state.doneAtResume;
  const elapsed = now - Date.parse(state.resumedAt);
  if (doneThisRun < 2 || !Number.isFinite(elapsed) || elapsed <= 0) return undefined;
  return Math.max(1, Math.round((elapsed / doneThisRun) * (state.total - state.done) / 60_000));
}

/** 「大约还要 25 分钟」/「大约还要 2 小时」。 */
export function formatRereadEta(minutes: number): string {
  if (minutes < 60) return `大约还要 ${minutes} 分钟`;
  const hours = Math.round(minutes / 60);
  return `大约还要 ${hours} 小时`;
}

/**
 * 通读没完成时，核账 / 定稿 / 拟纲这些要读全书账的动作挡在这里：账还没记全，核出来的「对不上」会是假的。
 * 返回给作者看的一句话；通读完了（或这本书没有通读）返回 undefined。action 是这次被挡的动作（核账 / 定稿 / 想走法 / 出稿）。
 */
export async function rereadBlocker(root: string, action: string): Promise<string | undefined> {
  const state = await readRereadState(root);
  if (!state || state.status === "done") return undefined;
  const waiting = "核账、定稿、想走法、AI 写稿都要等它记完，你自己写不受影响。";
  if (state.status === "stopped") {
    return `这次没能${action}：记账员通读前文停在了第 ${state.done + 1} 章（${state.stoppedReason ?? "没记上"}），点右栏进度行的「接着记」。${waiting}`;
  }
  const eta = rereadEtaMinutes(state);
  return `这次没能${action}：记账员还在通读前文、逐章记账（记完 ${state.done}/${state.total} 章${eta ? `，${formatRereadEta(eta)}` : ""}）。${waiting}`;
}
