/**
 * 编辑部「在读前文」进度（R4.3 验收 3.3）：老书三个跟读角色（核账员/记账员/章纲员）按共用队列依次补前文笔记。
 * 开书概况带初值（overview.readerCatchUp，开书那次就有：服务端在返回概况前先落 progress），
 * 任一角色在读时每 5 秒轮询一次轻量接口 /api/reader-progress；全读完（reading:false）或离开这本书就停，
 * 没在读不轮询。轮询失败静默（下一次再试），不打扰作者。
 */
import { useEffect, useState } from "react";
import { fetchReaderCatchUp } from "../api/client.js";
import type { ReaderCatchUpStatus } from "../api/types.js";

export const READER_CATCH_UP_POLL_MS = 5_000;

/** 轮询结果记上它是哪本书的：换书后旧结果直接弃，不把上一本的进度闪到这一本上。 */
interface PolledState {
  readonly path: string;
  readonly status: ReaderCatchUpStatus;
}

export function useReaderCatchUp(
  projectPath: string | null | undefined,
  initial: ReaderCatchUpStatus | null | undefined,
): ReaderCatchUpStatus | null {
  const [polled, setPolled] = useState<PolledState | null>(null);
  const live = polled && polled.path === projectPath ? polled.status : null;
  const reading = live ? live.reading : (initial?.reading ?? false);
  useEffect(() => {
    // 没在读不轮询；全读完（reading 翻成 false）或离开这本书（projectPath 变空 / 换书）即停。
    if (!projectPath || !reading) return;
    let alive = true;
    const timer = setInterval(() => {
      void fetchReaderCatchUp(projectPath)
        .then((status) => {
          if (!alive) return;
          setPolled({ path: projectPath, status });
        })
        .catch(() => undefined); // 轮询失败：静默，5 秒后再试
    }, READER_CATCH_UP_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [projectPath, reading]);
  // 没开书（projectPath 空）一律不显示，初值也不带——上一本的进度不该闪在书架/别的书上。
  return projectPath ? (live ?? initial ?? null) : null;
}
