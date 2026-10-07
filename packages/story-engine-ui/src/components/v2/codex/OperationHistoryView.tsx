/**
 * OperationHistoryView —— 资料中心/写作台 同级的「操作历史」主区视图（R3#3）。
 *
 * 修：旧入口点左侧「操作历史」只触发一个被 projectPath 门控的全局模态，真书路径异常或 summary-only 书时
 * 静默不出、主区仍是正文书桌。改成确定性主区视图（与「资料中心/写作台」同构、点了必显），不依赖模态是否挂载。
 * 复用既有只读取数/恢复接口（fetchSnapshots / restoreSnapshotApi）——恢复线本就被认可，不新增写入旁路（守铁律②）。
 */
import { useEffect, useState } from "react";
import { fetchSnapshots, restoreSnapshotApi } from "../../../api/client.js";
import type { SnapshotEntryDto } from "../../../api/types.js";
import { drainAutosave, resumeAutosave, suspendAutosave } from "../../../utils/autosaveControl.js";
import { restoreSnapshotSafely } from "../../../utils/safeSnapshotRestore.js";

function formatTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleString("zh-CN", { hour12: false });
}

function formatRelativeTime(epochSeconds: number): string {
  const elapsedSeconds = Math.max(0, Math.floor(Date.now() / 1000) - epochSeconds);
  if (elapsedSeconds < 60) return "刚刚";
  if (elapsedSeconds < 3600) return `${Math.floor(elapsedSeconds / 60)} 分钟前`;
  if (elapsedSeconds < 86400) return `${Math.floor(elapsedSeconds / 3600)} 小时前`;
  return `${Math.floor(elapsedSeconds / 86400)} 天前`;
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

export default function OperationHistoryView({ projectPath }: { readonly projectPath: string | null | undefined }) {
  const [snapshots, setSnapshots] = useState<SnapshotEntryDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  // 恢复要先在行内确认一次（恢复会整页重载，误点代价大）。
  const [confirmId, setConfirmId] = useState<string | null>(null);

  useEffect(() => {
    if (!projectPath) return;
    let alive = true;
    fetchSnapshots(projectPath)
      .then((list) => { if (alive) setSnapshots(list); })
      .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [projectPath]);

  const handleRestore = async (id: string): Promise<void> => {
    if (!projectPath) return;
    setRestoring(id);
    setError(null);
    try {
      await restoreSnapshotSafely({
        suspend: suspendAutosave,
        drain: drainAutosave,
        restore: () => restoreSnapshotApi(projectPath, id),
        reload: () => window.location.reload(),
        resumeOnFailure: resumeAutosave,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRestoring(null);
    }
  };

  const groups = snapshots ? groupSnapshotsByDay(snapshots) : [];

  return (
    <div className="op-history">
      <div className="op-history-body">
        <header className="op-history-head">
          <h2>操作历史</h2>
          <p className="op-history-hint">AI 每次写入前都会自动存档。恢复前也会先存一份，恢复本身也能再撤销。</p>
        </header>
        {!projectPath ? <div className="op-history-empty">请先打开一本真实的本地项目，才能查看操作历史。</div> : null}
        {projectPath && error ? <div className="op-history-error">读取存档失败：{error}</div> : null}
        {projectPath && !error && snapshots === null ? <div className="op-history-empty">正在读取存档列表…</div> : null}
        {projectPath && snapshots !== null && snapshots.length === 0 ? (
          <div className="op-history-empty">还没有任何存档。AI 第一次写入前会自动创建。</div>
        ) : null}
        {groups.map((group) => (
          <section key={group.day} className="op-history-group" aria-label={group.day}>
            <h3 className="op-history-day">{group.day}</h3>
            <div className="op-history-list">
              {group.items.map((snapshot) => {
                const confirming = confirmId === snapshot.id;
                return (
                  <div key={snapshot.id} className="op-history-entry">
                    <article className={`op-history-item${confirming ? " is-confirming" : ""}`}>
                      <span className="op-history-clock" title={formatTime(snapshot.timestamp)}>{formatClock(snapshot.timestamp)}</span>
                      <strong>{snapshot.label}</strong>
                      <span className="op-history-time" title={formatTime(snapshot.timestamp)}>{formatRelativeTime(snapshot.timestamp)}</span>
                      <button
                        className="op-history-restore"
                        disabled={restoring !== null}
                        aria-expanded={confirming}
                        onClick={() => setConfirmId(confirming ? null : snapshot.id)}
                        type="button"
                      >
                        {restoring === snapshot.id ? "恢复中……" : "恢复到这里"}
                      </button>
                    </article>
                    {confirming && restoring === null ? (
                      <div className="op-history-confirm" role="alertdialog" aria-label="确认恢复">
                        <span>恢复到「{snapshot.label}」这一刻？现在的内容会先自动存档，之后也能再撤销。</span>
                        <button className="op-history-confirm-go" type="button" onClick={() => void handleRestore(snapshot.id)}>恢复</button>
                        <button className="op-history-confirm-cancel" type="button" onClick={() => setConfirmId(null)}>取消</button>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
