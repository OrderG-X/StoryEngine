/**
 * 补读进度的落盘 I/O 和「动作在等它读完」的标注（2026-10-13 编辑部 R5.2）。
 *
 * progress.json 的归属原来在 catch-up.ts；R5.2 起核账 / 拟纲 / 记账当场补笔记（等读）也要写这份文件，
 * 而 catch-up.ts 顶层 import checker.ts（拿 callConfiguredBrainModel），checker 反过来 import 它会成环——
 * 所以把纯 I/O 和文案拆到这里：只依赖 reader-window 的 writeAtomically，谁都能 import。
 * 等读标注走的就是 R4.3 那条轮询链路（progress.json → /api/reader-progress → 进度行），不新开通道。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeAtomically } from "./reader-window.js";

/** 进度行里角色 id → 叫法（和前端 READER_ROLE_LABELS 同一张表）。 */
export const READER_ROLE_LABELS: Readonly<Record<string, string>> = {
  checker: "核账员",
  ledger: "记账员",
  planner: "章纲员",
};

export interface ReaderProgress {
  readonly role: string;
  /** 还在补吗。 */
  readonly reading: boolean;
  /** 已经有有效笔记的章数（读到第几章）。 */
  readonly done: number;
  /** 这轮要读到第几章。 */
  readonly total: number;
  readonly updatedAt: string;
  /** 上一次补读没成的原因（接着补成功就不带）。 */
  readonly error?: string;
  /** 哪个动作在等它读完（R5.2）：核账 / 拟纲 / 记账。只在当场等读期间带，读完即清。 */
  readonly waiting?: string;
}

export const progressFile = (root: string, roleId: string): string => join(root, "agents", roleId, "progress.json");

export async function writeReaderProgress(root: string, progress: ReaderProgress): Promise<void> {
  await writeAtomically(progressFile(root, progress.role), `${JSON.stringify(progress, null, 2)}\n`);
}

/** 读一个角色的补读进度；没写过 / 文件坏了返回 undefined。 */
export async function readReaderProgress(notesRoot: string, roleId: string): Promise<ReaderProgress | undefined> {
  try {
    const parsed = JSON.parse(await readFile(progressFile(notesRoot, roleId), "utf-8")) as Partial<ReaderProgress>;
    if (typeof parsed.done !== "number" || typeof parsed.total !== "number" || typeof parsed.reading !== "boolean") return undefined;
    return {
      role: roleId,
      reading: parsed.reading,
      done: Math.max(0, Math.floor(parsed.done)),
      total: Math.max(0, Math.floor(parsed.total)),
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
      ...(typeof parsed.error === "string" && parsed.error ? { error: parsed.error } : {}),
      ...(typeof parsed.waiting === "string" && parsed.waiting ? { waiting: parsed.waiting } : {}),
    };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// 等读回执（R5.2 必做 2）：动作等过补读，回执加一句「这次先等 X 读完第 a～b 章（用时 …）再 Y」
// ---------------------------------------------------------------------------

/** 一次当场等读的事实：补了第 from～to 章笔记、花了 ms 毫秒。 */
export interface ReaderWaited {
  readonly from: number;
  readonly to: number;
  readonly ms: number;
}

/** 等读用时的人话（「1 分 31 秒」/「45 秒」）。 */
export function formatReaderWaitDuration(ms: number): string {
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds} 秒`;
  return seconds > 0 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`;
}

/** 等读那一句：如「这次先等核账员读完第 51～58 章（用时 1 分 31 秒）再核」。action 是句尾动词（再核 / 再拟纲 / 再记账）。 */
export function describeReaderWait(roleId: string, waited: ReaderWaited, action: string): string {
  const label = READER_ROLE_LABELS[roleId] ?? roleId;
  const span = waited.from >= waited.to ? `第 ${waited.from} 章` : `第 ${waited.from}～${waited.to} 章`;
  return `这次先等${label}读完${span}（用时 ${formatReaderWaitDuration(waited.ms)}）再${action}`;
}

// ---------------------------------------------------------------------------
// 等读标注（R5.2 必做 1）：当场补笔记期间把「谁在等谁读完」写进 progress.json，进度行照 R4.3 的轮询显示
// ---------------------------------------------------------------------------

/**
 * 给 ensureReaderWindow 的三个回调（onCatchUpBegin / onProgress / onCatchUpEnd）：当场补读开始、每写完一章、
 * 结束（含失败）各落一次 progress.json。reading:true + waiting:<动作名> 期间，界面进度行在对应角色后标
 * 「（核账在等它读完）」；结束时 reading:false、waiting 清掉。写不进盘只 warn（书目录只读等场景），不影响补读。
 */
export function readerWaitingHandlers(root: string, roleId: string, upTo: number, waiting: string): {
  readonly onCatchUpBegin: (done: number) => Promise<void>;
  readonly onProgress: (chapter: number) => Promise<void>;
  readonly onCatchUpEnd: (done: number) => Promise<void>;
} {
  const write = async (progress: ReaderProgress): Promise<void> => {
    await writeReaderProgress(root, progress).catch((error) => {
      console.warn(`[brain] ${roleId} 等读进度没写上（不影响这次核账/拟纲/记账）`, error);
    });
  };
  return {
    onCatchUpBegin: async (done) => { await write({ role: roleId, reading: true, done, total: upTo, updatedAt: new Date().toISOString(), waiting }); },
    onProgress: async (chapter) => { await write({ role: roleId, reading: true, done: chapter, total: upTo, updatedAt: new Date().toISOString(), waiting }); },
    onCatchUpEnd: async (done) => { await write({ role: roleId, reading: false, done, total: upTo, updatedAt: new Date().toISOString() }); },
  };
}
