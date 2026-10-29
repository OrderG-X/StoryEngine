/**
 * 专员动笔前先读完前文（写作版本 P2a：核账、出稿操作的 notes 步）：当场最多补 maxCatchUp 章笔记、maxVolumeBuilds 个卷节点；
 * 缺得更多就一份都不补（0 次调用），由调用方决定走冷窗口（核账）还是交后台补读、停下等（出稿）。补到一半模型调用失败照实抛。
 * 这个角色的后台补读停着等作者：一份都不补（那份可能有一笔结果不明、已经计费的调用），带回停着的那份。
 */
import { withStep } from "../lib/token-meter.js";
import type { PausedBackfill } from "../lib/reader-backfill.js";
import { readerWaitingHandlers, type ReaderWaited } from "./reader-progress.js";
import { ensureReaderWindow, type BrainCallModel, type ReaderRole } from "./reader-window.js";

export interface ReaderNotesOutcome {
  readonly role: string;
  /** 还缺几份（超过当场上限、卷节点到了上限、后台补读停着）。 */
  readonly missing: number;
  readonly built: number;
  readonly volumesBuilt: number;
  readonly readThrough: number;
  readonly waited?: ReaderWaited;
  readonly pausedBackfill?: PausedBackfill;
}

export async function prepareReaderNotes(input: {
  readonly projectDir: string;
  readonly role: ReaderRole;
  /** 要写 / 要核的是第几章：读到它前一章。 */
  readonly chapter: number;
  readonly callModel: BrainCallModel;
  readonly maxCatchUp: number;
  readonly maxVolumeBuilds: number;
  /** 进度行标「哪个动作在等它读完」。 */
  readonly waitingAs: string;
}): Promise<ReaderNotesOutcome> {
  if (input.chapter <= 1) return { role: input.role.id, missing: 0, built: 0, volumesBuilt: 0, readThrough: 0 };
  const waiting = readerWaitingHandlers(input.projectDir, input.role.id, input.chapter - 1);
  const ready = await withStep("跟读补笔记", () => ensureReaderWindow({
    projectDir: input.projectDir,
    role: input.role,
    upTo: input.chapter - 1,
    callModel: input.callModel,
    maxCatchUp: input.maxCatchUp,
    maxVolumeBuilds: input.maxVolumeBuilds,
    waitingAs: input.waitingAs,
    onCatchUpBegin: waiting.onCatchUpBegin,
    onProgress: waiting.onProgress,
    onCatchUpEnd: waiting.onCatchUpEnd,
  }));
  return {
    role: input.role.id,
    missing: ready.missing,
    built: ready.built,
    volumesBuilt: ready.volumesBuilt,
    readThrough: ready.readThrough,
    ...(ready.waited ? { waited: ready.waited } : {}),
    ...(ready.pausedBackfill ? { pausedBackfill: ready.pausedBackfill } : {}),
  };
}
