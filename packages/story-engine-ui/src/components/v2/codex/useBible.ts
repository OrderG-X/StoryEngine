/**
 * 设定视图（重构 P9）：一本书读一份，设定本各页、正文里的名字速览、@ 提及、搜索都用它。
 * refreshKey 变了就重读（开书概况每次刷新都会换新对象：AI 改了设定、撤销、定稿之后都跟着重读）；
 * 作者自己在设定本里改完调 reload（等重读回来才算完：设定本存完再收起编辑框，不闪改前的字）。读不到如实给原因，不当空设定显示。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchBible, type BibleView } from "../../../api/bibleClient.js";

export interface BibleState {
  readonly bible: BibleView | null;
  readonly error: string | null;
  readonly reload: () => Promise<void>;
}

export function useBible(projectPath: string | undefined, refreshKey: unknown): BibleState {
  const [bible, setBible] = useState<BibleView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [seq, setSeq] = useState(0);
  const waiting = useRef<Array<() => void>>([]);
  const reload = useCallback(() => new Promise<void>((resolve) => {
    waiting.current.push(resolve);
    setSeq((value) => value + 1);
  }), []);

  // 换书先清空：别把上一本书的人名挂在这本书的正文上。
  useEffect(() => {
    setBible(null);
    setError(null);
  }, [projectPath]);

  useEffect(() => {
    if (!projectPath) return undefined;
    const controller = new AbortController();
    void fetchBible(projectPath, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.ok) {
        setBible(result.bible);
        setError(null);
      } else {
        setError(result.error);
      }
      const done = waiting.current.splice(0);
      for (const resolve of done) resolve();
    });
    return () => controller.abort();
  }, [projectPath, refreshKey, seq]);

  return { bible, error, reload };
}
