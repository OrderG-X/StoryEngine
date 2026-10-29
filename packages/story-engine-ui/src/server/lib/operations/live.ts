/**
 * 操作的实时事件（写作版本 P2a 设计 6.7）：进度、步骤开始、正文流。不落盘（记录变化另走 store.onOperationRecord）。
 * 订阅交接（先挂监听、缓冲 → 读快照 → 丢掉已计入快照的 → 直通）在 executor 的 subscribeOperation。
 */
import { bookKey } from "@actalk/story-core";

export type LiveEvent =
  /** 一步开始（含整步重做）：exec = `runEpoch:stepId`，前端拿它换掉残稿、丢掉旧执行迟到的事件。 */
  | { readonly type: "step"; readonly step: string; readonly exec: string }
  /** 给作者看的一句进度（「核账员在读第 3 章」）。 */
  | { readonly type: "progress"; readonly text: string; readonly exec?: string }
  /** 正文流：exec + streamSeq 定切点（同一次执行里递增）；replace = 整段换成 text。 */
  | { readonly type: "draft-delta"; readonly exec: string; readonly streamSeq: number; readonly text: string; readonly replace?: boolean };

type LiveListener = (event: LiveEvent) => void;
const listeners = new Map<string, Set<LiveListener>>();
const keyOf = (bookDir: string, opId: string): string => `${bookKey(bookDir)}:${opId}`;

export function emitLive(bookDir: string, opId: string, event: LiveEvent): void {
  for (const listener of listeners.get(keyOf(bookDir, opId)) ?? []) {
    try {
      listener(event);
    } catch (error) {
      console.warn("[operations] 实时事件的订阅方出错（不影响操作）", error);
    }
  }
}

/** 订阅一次操作的实时事件；返回退订。 */
export function onLive(bookDir: string, opId: string, listener: LiveListener): () => void {
  const key = keyOf(bookDir, opId);
  const set = listeners.get(key) ?? new Set<LiveListener>();
  set.add(listener);
  listeners.set(key, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(key);
  };
}

export function __resetLiveForTests(): void {
  listeners.clear();
}
