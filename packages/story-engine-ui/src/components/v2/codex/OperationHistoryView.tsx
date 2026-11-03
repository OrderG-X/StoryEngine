/**
 * OperationHistoryView —— 资料中心/写作台 同级的「操作历史」主区视图（R3#3）。
 *
 * 修：旧入口点左侧「操作历史」只触发一个被 projectPath 门控的全局模态，真书路径异常或 summary-only 书时
 * 静默不出、主区仍是正文书桌。改成确定性主区视图（与「资料中心/写作台」同构、点了必显），不依赖模态是否挂载。
 * 复用既有只读取数/恢复接口（fetchSnapshots / restoreSnapshotApi）——恢复线本就被认可，不新增写入旁路（守铁律②）。
 * 安静账房（2026-11-03）：只列定稿、正文改动（哪章定了、AI 改了哪章），设定、恢复那几条每天收成一行，点开才看；不再有统计、筛选、「查看改动」。
 */
import { useEffect, useState } from "react";
import { fetchSnapshots, restoreSnapshotApi } from "../../../api/client.js";
import type { SnapshotEntryDto } from "../../../api/types.js";
import { flushAllSaves } from "../../../sync/saveAll.js";
import { syncWorkspaceAfterRestore } from "../../../workspace/syncAfterRestore.js";
import { noteRestoreInChat } from "../../../workspace/restoreNote.js";
import { claimWorkspaceForRestore } from "../../../workspace/claimRestore.js";
import { finishWorkspaceOperation } from "../../../utils/workspaceOperation.js";
import { useNavigationStore } from "../../../stores/navigationStore.js";
import { PageHead, Skeleton } from "./bibleVisual.js";

function formatTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleString("zh-CN", { hour12: false });
}

function formatClock(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 按自然日分组（新的在前）：今天 / 昨天 / 10 月 5 日；跨年才带年份。组内保持原顺序。 */
export function groupSnapshotsByDay<T extends { readonly timestamp: number }>(
  snapshots: readonly T[],
  now: Date = new Date(),
): { readonly day: string; readonly items: readonly T[] }[] {
  const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  const today = dayKey(now);
  const yesterday = dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  const groups: { day: string; key: string; items: T[] }[] = [];
  for (const snapshot of snapshots) {
    const d = new Date(snapshot.timestamp * 1000);
    const key = dayKey(d);
    let group = groups.find((g) => g.key === key);
    if (!group) {
      const label = key === today ? "今天"
        : key === yesterday ? "昨天"
          : d.getFullYear() === now.getFullYear() ? `${d.getMonth() + 1} 月 ${d.getDate()} 日`
            : `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`;
      group = { day: label, key, items: [] };
      groups.push(group);
    }
    group.items.push(snapshot);
  }
  return groups.map(({ day, items }) => ({ day, items }));
}

export type SnapshotKind = "commit" | "draft" | "bible" | "restore";

/** 分类由服务端按写入方工具名给出（重构 P7：不再按人话标签里的字眼猜）。 */
export function snapshotKind(snapshot: Pick<SnapshotEntryDto, "kind">): SnapshotKind {
  return snapshot.kind ?? "draft";
}

/** 平时就列出来的：定稿、正文改动；设定、恢复收起来。 */
const isChapterChange = (snapshot: Pick<SnapshotEntryDto, "kind">): boolean => {
  const kind = snapshotKind(snapshot);
  return kind === "commit" || kind === "draft";
};

/**
 * refreshKey 变了就重读列表（传开书概况：开着历史页时在聊天里撤销、AI 写入、定稿，概况一刷新这里跟着出新条目，
 * 不用切走再切回来）。
 */
export default function OperationHistoryView({ projectPath, refreshKey }: {
  readonly projectPath: string | null | undefined;
  readonly refreshKey?: unknown;
}) {
  const [snapshots, setSnapshots] = useState<SnapshotEntryDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  // 恢复要先在行内确认一次（会把整本书退回那个存档，误点代价大）。
  const [confirmId, setConfirmId] = useState<string | null>(null);
  // 哪几天把收起来的（设定、恢复）也摊开了。
  const [openDays, setOpenDays] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    if (!projectPath) return;
    let alive = true;
    fetchSnapshots(projectPath)
      .then((list) => { if (alive) setSnapshots(list); })
      .catch((e: unknown) => { if (alive) setError(`读取存档失败：${e instanceof Error ? e.message : String(e)}`); });
    return () => { alive = false; };
  }, [projectPath, refreshKey]);

  // 恢复后原地重读（重构 P5）：不整页刷新，列表里多出「恢复前」那条存档。
  const handleRestore = async (id: string): Promise<void> => {
    if (!projectPath) return;
    // 恢复到记完一笔都占着工作区：这期间开不了新的一轮对话、换不了章（第 6 轮复核 T10）。
    const claimed = claimWorkspaceForRestore(projectPath);
    if (!claimed) {
      setError("AI 或别的操作正在进行，等它结束再恢复。");
      return;
    }
    setRestoring(id);
    setError(null);
    try {
      const flushed = await flushAllSaves();
      if (!flushed.ok) throw new Error(`${flushed.error}，先别恢复，等它存上再试`);
      const label = snapshots?.find((snapshot) => snapshot.id === id)?.label;
      const restored = await restoreSnapshotApi(projectPath, id);
      setConfirmId(null);
      await syncWorkspaceAfterRestore(projectPath);
      // 书本来就是那个样子（什么都没动）：对话里不记「恢复到了」。
      if (label && restored.changed) await noteRestoreInChat(projectPath, label);
      useNavigationStore.getState().showToast(restored.changed ? `${restored.conclusion}恢复前的样子也存了一份，可以再恢复回去。` : restored.conclusion, 4200);
      setSnapshots(await fetchSnapshots(projectPath));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRestoring(null);
      finishWorkspaceOperation(claimed);
    }
  };

  const groups = snapshots ? groupSnapshotsByDay(snapshots) : [];

  return (
    <div className="op-history">
      <div className="op-history-body">
        <PageHead kicker="这本书" title="操作历史" sub="每次改动前都存了一份，能回到任何一步之前。" />
        {!projectPath ? <div className="op-history-empty">请先打开一本真实的本地项目，才能查看操作历史。</div> : null}
        {projectPath && error ? <div className="op-history-error">{error}</div> : null}
        {projectPath && !error && snapshots === null ? <Skeleton label="正在读取存档列表…" /> : null}
        {projectPath && snapshots !== null && snapshots.length === 0 ? (
          <div className="op-history-empty">还没有任何存档。AI 第一次写入前会自动创建。</div>
        ) : null}
        {groups.map((group) => {
          const open = openDays.has(group.day);
          const folded = group.items.filter((snapshot) => !isChapterChange(snapshot)).length;
          const shown = open ? group.items : group.items.filter(isChapterChange);
          return (
          <section key={group.day} className="op-history-group" aria-label={group.day}>
            <h3 className="op-history-day"><span>{group.day}</span></h3>
            <div className="op-history-list">
              {shown.map((snapshot) => {
                const confirming = confirmId === snapshot.id;
                // 「恢复到…」这条本身就是恢复的结果，内容和它恢复的那条一样；要撤销恢复，点它下面那条「恢复前的自动存档」。
                const restorable = !snapshot.label.startsWith("恢复到");
                return (
                  <div key={snapshot.id} className={`op-history-entry is-${snapshotKind(snapshot)}`}>
                    <article className={`op-history-item${confirming ? " is-confirming" : ""}`}>
                      <span className="op-history-clock" title={formatTime(snapshot.timestamp)}>{formatClock(snapshot.timestamp)}</span>
                      <strong>{snapshot.label}</strong>
                      <span />
                      <span className="op-history-acts">
                        {restorable ? (
                          <button
                            className="op-history-restore"
                            disabled={restoring !== null}
                            aria-expanded={confirming}
                            onClick={() => setConfirmId(confirming ? null : snapshot.id)}
                            type="button"
                          >
                            {restoring === snapshot.id ? "恢复中……" : "恢复到这之前"}
                          </button>
                        ) : null}
                      </span>
                    </article>
                    {confirming && restoring === null ? (
                      <div className="op-history-confirm" role="alertdialog" aria-label="确认恢复">
                        <span>回到「{snapshot.label}」之前的样子？现在的内容会先自动存档，之后也能再撤销。</span>
                        <button className="op-history-confirm-go" type="button" onClick={() => void handleRestore(snapshot.id)}>恢复</button>
                        <button className="op-history-confirm-cancel" type="button" onClick={() => setConfirmId(null)}>取消</button>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
            {folded > 0 ? (
              <button
                className="op-history-more"
                type="button"
                aria-expanded={open}
                onClick={() => setOpenDays((days) => {
                  const next = new Set(days);
                  if (open) next.delete(group.day);
                  else next.add(group.day);
                  return next;
                })}
              >
                {open ? "收起设定、恢复那几条" : `还有 ${folded} 条设定、恢复的改动`}
              </button>
            ) : null}
          </section>
          );
        })}
      </div>
    </div>
  );
}
