/**
 * 编辑部「在读前文」进度（R4.3 验收 3.3）：老书三个跟读角色（核账员/记账员/章纲员）按共用队列依次补前文笔记。
 * 开书概况带初值（overview.readerCatchUp，开书那次就有：服务端在返回概况前先落 progress），
 * 任一角色在读时每 5 秒轮询一次轻量接口 /api/reader-progress；全读完（reading:false）或离开这本书就停，
 * 没在读不轮询。轮询失败静默（下一次再试），不打扰作者。
 *
 * R6.2（复验新发现 2）同一次打开里，后来的补读进度也要显示：
 * - 新的盖旧的：开书概况刷新会带来新初值（overview 每次 setCurrentOverview 都是新对象），
 *   旧轮询结果按「逻辑时钟」让位——每份初值拨一格，轮询结果记着自己是哪一格拿的，
 *   初值换新后旧轮询快照作废（不按来源分新旧，谁新听谁的）。这样开书那轮读完（reading:false 停了）之后，
 *   定稿预热 / 点核账排队补读带来的 reading:true 还能盖上来、轮询也能重新起步。
 * - 动作进行中也轮询：作者点了核账、定稿预览、写下一章或发消息、对话在等回包时（actionInFlight），
 *   即使 reading:false 也按 5 秒轮一次——服务端的「（核账在等它读完）」标注（R6.1）一出来界面就能看到；
 *   回包到了（actionInFlight 翻 false）再按 reading 决定停不停。
 */
import { useEffect, useState } from "react";
import { fetchReaderCatchUp, fetchStateOverview } from "../api/client.js";
import { useNavigationStore } from "../stores/navigationStore.js";
import { applyOverviewToWorkspace } from "../workspace/applyOverview.js";
import type { ReaderCatchUpStatus } from "../api/types.js";

export const READER_CATCH_UP_POLL_MS = 5_000;

/** 轮询结果记上它是哪本书、哪一格逻辑时钟拿的：换书弃、初值拨过新格也弃，不让旧快照盖住新状态。 */
interface PolledState {
  readonly path: string;
  readonly seq: number;
  readonly status: ReaderCatchUpStatus;
}

export function useReaderCatchUp(
  projectPath: string | null | undefined,
  initial: ReaderCatchUpStatus | null | undefined,
  actionInFlight?: boolean,
): ReaderCatchUpStatus | null {
  const [polled, setPolled] = useState<PolledState | null>(null);
  // 逻辑时钟：初值对象一换（服务端新拍的一份概况）就拨一格，旧轮询结果随之作废（新的盖旧的）。
  const [initialSeq, setInitialSeq] = useState(0);
  const [seenInitial, setSeenInitial] = useState(initial);
  if (initial !== seenInitial) {
    setSeenInitial(initial);
    setInitialSeq((seq) => seq + 1);
  }
  const live = polled && polled.path === projectPath && polled.seq >= initialSeq ? polled.status : null;
  // 导入的书通读记账停下了（P8）也接着轮询：作者点「接着记」后几秒内就能看到它又走起来。
  const reading = live ? live.reading || Boolean(live.reread) : (initial?.reading ?? false) || Boolean(initial?.reread);
  const busy = Boolean(actionInFlight);
  useEffect(() => {
    // 没在读且没动作在跑：不轮询；全读完（reading 翻 false）且没有动作、或离开这本书（projectPath 变空 / 换书）即停。
    if (!projectPath || (!reading && !busy)) return;
    let alive = true;
    const timer = setInterval(() => {
      void fetchReaderCatchUp(projectPath)
        .then((status) => {
          if (!alive) return;
          setPolled({ path: projectPath, seq: initialSeq, status });
        })
        .catch(() => undefined); // 轮询失败：静默，5 秒后再试
    }, READER_CATCH_UP_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [projectPath, reading, busy, initialSeq]);
  // 没开书（projectPath 空）一律不显示，初值也不带——上一本的进度不该闪在书架/别的书上。
  return projectPath ? (live ?? initial ?? null) : null;
}

/**
 * 导入的书通读记账刚记完（P8）：原地重读一次概况，故事地图、伏笔看板、设定本跟着换上记好的账，不用作者刷新页面。
 * 只认「同一本书上一刻还在通读、这一刻没了」。
 */
export function useRefreshWhenRereadDone(projectPath: string | null | undefined, status: ReaderCatchUpStatus | null): void {
  const rereading = Boolean(status?.reread);
  const [seen, setSeen] = useState<{ readonly path: string | null | undefined; readonly rereading: boolean }>({ path: projectPath, rereading });
  useEffect(() => {
    const finished = seen.path === projectPath && seen.rereading && !rereading;
    if (seen.path !== projectPath || seen.rereading !== rereading) setSeen({ path: projectPath, rereading });
    if (!finished || !projectPath) return;
    void fetchStateOverview({ projectPath, maxTimelineEvents: 8 })
      .then((overview) => {
        if (useNavigationStore.getState().projectPath === projectPath) applyOverviewToWorkspace(overview);
      })
      .catch(() => undefined); // 没刷上：下次开书 / 刷新照样能看到
  }, [projectPath, rereading, seen]);
}
