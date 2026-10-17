/**
 * 书的事件：写命令成功后推一条（版本号 + 改了什么）。核心只管进程内分发；
 * 服务端订阅后转成 SSE 推给界面，界面按 changed 原地更新。
 */
import type { BookEvent } from "./types.js";

export type BookEventListener = (event: BookEvent) => void;

export class BookEventHub {
  private readonly listeners = new Set<BookEventListener>();

  subscribe(listener: BookEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 推给所有订阅者；某个订阅者出错不影响别的、也不影响命令本身。 */
  emit = (event: BookEvent): void => {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.warn(`[story-core] 事件订阅者出错：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };
}
