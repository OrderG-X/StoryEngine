/**
 * 作者喊停之后，这一轮的 AI 不许再往书里写（长篇连写走查 2026-10-24）。
 *
 * 作者点「■」、关窗、连接断了，路由那头的中止信号就翻了；可出稿流水线、改稿这些不接中止信号，模型调用会照跑完、
 * 几分钟后把稿写进盘——界面已经说了「本次没有改动 / 已停止」，作者可能已经在稿纸上自己写了，被后到的 AI 稿整份盖掉。
 * 路由把一轮对话 / 按钮动作套在 runAbortableTurn 里；AI 写工作稿、AI 补设定卡这两个唯一通道落盘前问 turnAborted()。
 * 只拦 AI 的写：作者点的按钮（定稿、确认改设定）照常做完。
 */
import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage<AbortSignal>();

export function runAbortableTurn<T>(signal: AbortSignal, fn: () => T): T {
  return storage.run(signal, fn);
}

/** 这一轮作者已经喊停（不在任何一轮里 = 没停）。 */
export function turnAborted(): boolean {
  return storage.getStore()?.aborted ?? false;
}

export const TURN_ABORTED_MESSAGE = "你已经喊停了，这一步没往书里写。";
