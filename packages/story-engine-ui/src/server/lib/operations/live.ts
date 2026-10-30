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
  /**
   * 正文流：exec + streamSeq 定切点（同一次执行里递增）；replace = 新写的这段整段换成 text；
   * base = text 是接着写时本来写好的那段（原样显示在新写的前面，不当新写的清理），同时新写的清空。
   */
  | { readonly type: "draft-delta"; readonly exec: string; readonly streamSeq: number; readonly text: string; readonly replace?: true; readonly base?: true };

export type DraftDeltaEvent = Extract<LiveEvent, { readonly type: "draft-delta" }>;

type LiveListener = (event: LiveEvent) => void;
const listeners = new Map<string, Set<LiveListener>>();
const keyOf = (bookDir: string, opId: string): string => `${bookKey(bookDir)}:${opId}`;

/** 正文流到现在的样子（每次操作一份，这次执行结束就清）：订阅晚到的先补发这份。 */
interface DraftStream {
  readonly exec: string;
  readonly streamSeq: number;
  readonly base: string;
  readonly text: string;
}
const streams = new Map<string, DraftStream>();

function track(key: string, event: DraftDeltaEvent): void {
  const previous = streams.get(key);
  const same = previous?.exec === event.exec ? previous : undefined;
  if (event.base) streams.set(key, { exec: event.exec, streamSeq: event.streamSeq, base: event.text, text: "" });
  else streams.set(key, { exec: event.exec, streamSeq: event.streamSeq, base: same?.base ?? "", text: event.replace ? event.text : `${same?.text ?? ""}${event.text}` });
}

/** 补发用：这次操作正文流到现在的样子（本来写好的那段 + 新写的整段换上），没有在流就是空。两条同一个 streamSeq。 */
export function draftStreamCatchUp(bookDir: string, opId: string): readonly DraftDeltaEvent[] {
  const stream = streams.get(keyOf(bookDir, opId));
  if (!stream) return [];
  return [
    ...(stream.base ? [{ type: "draft-delta" as const, exec: stream.exec, streamSeq: stream.streamSeq, text: stream.base, base: true as const }] : []),
    { type: "draft-delta", exec: stream.exec, streamSeq: stream.streamSeq, text: stream.text, replace: true },
  ];
}

/** 这次执行结束了：正文流不再补发（结果以盘上为准）。 */
export function clearDraftStream(bookDir: string, opId: string): void {
  streams.delete(keyOf(bookDir, opId));
}

export function emitLive(bookDir: string, opId: string, event: LiveEvent): void {
  if (event.type === "draft-delta") track(keyOf(bookDir, opId), event);
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
  streams.clear();
}
