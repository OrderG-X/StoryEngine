import { useEffect, useState } from "react";
import type { StateOverviewHookItem, StateOverviewThreadItem } from "../../../api/types.js";
import PanelEnrichButton from "./PanelEnrichButton.js";
import {
  fetchForeshadowingOverrides,
  type ForeshadowingImportance,
  type ForeshadowingOverrides,
} from "../../../api/foreshadowingOverridesClient.js";

/**
 * HookCodexPanel — 伏笔线索面板（codex 设计的数据驱动版）。
 *
 * 视觉照 codex.css #p-hooks 作用域（.codex-app）：
 *  - 两个桶：未回收（active hooks + open threads）/ 已回收（resolvedCount 计数 + 可选明细）
 *  - 每条标注大小（大伏笔 / 小线索，小圆点区分）+ 埋章 / 回收章号 + relatedCount 折叠数
 *  - override：fetchForeshadowingOverrides 拉用户手动设定的大小，覆盖引擎派生 size
 *
 * 数据来源：
 *  - hookItems: 未回收的活跃伏笔（StateOverviewHookItem, status 非 resolved）
 *  - threadItems: 未回收的活跃线索（StateOverviewThreadItem, status 非 done/stale）
 *  - resolvedHookCount / doneThreadCount: 已回收计数（明细暂无时按计数展示）
 *
 * 只读面板：改设定走右侧 AI 对话，不加编辑按钮。
 * 字段可选降级：size/firstSeenChapter/resolvedAtChapter/relatedCount 缺时隐藏对应部分，绝不造假。
 */

// ── 内部工具 ──────────────────────────────────────────────────────────────────

type ShownSize = "major" | "minor" | undefined;

function SizeBadge({ size }: { readonly size: ShownSize }) {
  if (size === "major") {
    return <span className="tag warn"><i className="tag-dot" aria-hidden="true" />大伏笔</span>;
  }
  if (size === "minor") {
    return <span className="tag"><i className="tag-dot" aria-hidden="true" />小线索</span>;
  }
  return null;
}

function ChapterInfo({
  firstSeenChapter,
  resolvedAtChapter,
  isResolved,
}: {
  readonly firstSeenChapter?: number;
  readonly resolvedAtChapter?: number;
  readonly isResolved: boolean;
}) {
  if (isResolved) {
    if (firstSeenChapter != null && resolvedAtChapter != null) {
      return (
        <span className="h3" style={{ opacity: 0.6 }}>
          第{firstSeenChapter}章埋 → 第{resolvedAtChapter}章回收
        </span>
      );
    }
    if (firstSeenChapter != null) {
      return (
        <span className="h3" style={{ opacity: 0.6 }}>
          第{firstSeenChapter}章埋 · 已回收
        </span>
      );
    }
    return (
      <span className="h3" style={{ opacity: 0.6 }}>
        已回收
      </span>
    );
  }
  // 未回收
  if (firstSeenChapter != null) {
    return (
      <span className="h3" style={{ opacity: 0.6 }}>
        第{firstSeenChapter}章埋·进行中
      </span>
    );
  }
  return (
    <span className="h3" style={{ opacity: 0.6 }}>
      进行中
    </span>
  );
}

function RelatedBadge({ relatedCount }: { readonly relatedCount?: number }) {
  if (!relatedCount || relatedCount <= 0) return null;
  return <span className="tag">(+{relatedCount} 条相关)</span>;
}

// ── 组件 ──────────────────────────────────────────────────────────────────────

export default function HookCodexPanel({
  hookItems,
  threadItems,
  resolvedHookCount,
  doneThreadCount,
  projectPath,
  onSendMessage,
}: {
  readonly hookItems: readonly StateOverviewHookItem[];
  readonly threadItems: readonly StateOverviewThreadItem[];
  readonly resolvedHookCount: number;
  readonly doneThreadCount: number;
  readonly projectPath?: string | null;
  readonly onSendMessage?: (message: string) => void;
}) {
  const [overrides, setOverrides] = useState<ForeshadowingOverrides>({});

  useEffect(() => {
    let alive = true;
    if (!projectPath) {
      setOverrides({});
      return;
    }
    void fetchForeshadowingOverrides(projectPath).then((data) => {
      if (alive) setOverrides(data);
    });
    return () => {
      alive = false;
    };
  }, [projectPath]);

  // 活跃（未回收）桶：hookItems 里 status 非 resolved + threadItems 里 status 非 done/stale
  const activeHooks = hookItems.filter((h) => h.status !== "resolved");
  const activeThreads = threadItems.filter((t) => t.status !== "done" && t.status !== "stale");

  // 已回收明细（若 hookItems 中有 resolved 的，纳入已回收桶展示）
  const resolvedHooks = hookItems.filter((h) => h.status === "resolved");
  const doneThreads = threadItems.filter((t) => t.status === "done");

  const totalUnresolved = activeHooks.length + activeThreads.length;
  const totalResolved = resolvedHookCount + doneThreadCount;

  // shownSize: overrides 优先，其次 item.size
  function hookShownSize(item: StateOverviewHookItem): ShownSize {
    const override = overrides[item.id] as ForeshadowingImportance | undefined;
    return override ?? item.size;
  }

  function threadShownSize(item: StateOverviewThreadItem): ShownSize {
    const override = overrides[item.id] as ForeshadowingImportance | undefined;
    return override ?? item.size;
  }

  // 空态
  if (totalUnresolved === 0 && totalResolved === 0 && resolvedHooks.length === 0 && doneThreads.length === 0) {
    return (
      <section className="panel on" id="p-hooks">
        <div className="page-head">
          <div>
            <div className="kicker">Hooks · 伏笔线索追踪</div>
            <h1>伏笔 / 线索</h1>
          <div className="panel-enrich-row"><PanelEnrichButton onSendMessage={onSendMessage} intent="把线索里没用的僵尸碎片清理一下" label="清理废弃线索" /><PanelEnrichButton onSendMessage={onSendMessage} intent="把讲同一件事的重复伏笔合并成一条" label="合并重复伏笔" /></div>
          </div>
        </div>
        <div className="catrail-foot" style={{ marginTop: 40 }}>
          <b>还没有伏笔线索</b>去右边对 AI 说「帮我梳理当前的伏笔和线索」，生成后这里会按未回收/已回收分桶铺开。
        </div>
      </section>
    );
  }

  return (
    <section className="panel on" id="p-hooks">
      <div className="page-head">
        <div>
          <div className="kicker">Hooks · 伏笔线索追踪</div>
          <h1>伏笔 / 线索</h1>
          <div className="panel-enrich-row"><PanelEnrichButton onSendMessage={onSendMessage} intent="把线索里没用的僵尸碎片清理一下" label="清理废弃线索" /><PanelEnrichButton onSendMessage={onSendMessage} intent="把讲同一件事的重复伏笔合并成一条" label="合并重复伏笔" /></div>
          <p className="lead-sub">
            按回收状态分桶。大伏笔是关键情节节点，小线索是辅助细节——写作前确认哪些还悬而未决，哪些已经兑现。
          </p>
        </div>
        <div className="stats">
          {totalUnresolved > 0 ? (
            <div className="stat">
              <b>{totalUnresolved}</b>
              <small>未回收</small>
            </div>
          ) : null}
          {totalResolved > 0 ? (
            <div className="stat">
              <b>{totalResolved}</b>
              <small>已回收</small>
            </div>
          ) : null}
        </div>
      </div>

      {/* 未回收桶 */}
      {totalUnresolved > 0 ? (
        <div className="asset-grp">
          <h5 className="h2">
            未回收 <span className="cnt">{totalUnresolved}</span>
          </h5>

          {activeHooks.map((item) => (
            <div key={item.id} className="asset-item">
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <SizeBadge size={hookShownSize(item)} />
                  <b>{item.title}</b>
                  <RelatedBadge relatedCount={item.relatedCount} />
                </div>
                <ChapterInfo
                  firstSeenChapter={item.firstSeenChapter}
                  resolvedAtChapter={item.resolvedAtChapter}
                  isResolved={false}
                />
              </div>
            </div>
          ))}

          {activeThreads.map((item) => (
            <div key={item.id} className="asset-item">
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <SizeBadge size={threadShownSize(item)} />
                  <b>{item.title}</b>
                  <RelatedBadge relatedCount={item.relatedCount} />
                </div>
                <ChapterInfo
                  firstSeenChapter={item.firstSeenChapter}
                  resolvedAtChapter={item.resolvedAtChapter}
                  isResolved={false}
                />
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {/* 已回收桶 */}
      {(totalResolved > 0 || resolvedHooks.length > 0 || doneThreads.length > 0) ? (
        <div className="asset-grp" style={{ opacity: 0.7 }}>
          <h5 className="h2">
            已回收 <span className="cnt">{totalResolved}</span>
          </h5>

          {/* 若有明细则列出 */}
          {resolvedHooks.map((item) => (
            <div key={item.id} className="asset-item">
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <SizeBadge size={hookShownSize(item)} />
                  <b>{item.title}</b>
                  <span className="tag ok">已回收</span>
                  <RelatedBadge relatedCount={item.relatedCount} />
                </div>
                <ChapterInfo
                  firstSeenChapter={item.firstSeenChapter}
                  resolvedAtChapter={item.resolvedAtChapter}
                  isResolved={true}
                />
              </div>
            </div>
          ))}

          {doneThreads.map((item) => (
            <div key={item.id} className="asset-item">
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <SizeBadge size={threadShownSize(item)} />
                  <b>{item.title}</b>
                  <span className="tag ok">已完成</span>
                  <RelatedBadge relatedCount={item.relatedCount} />
                </div>
                <ChapterInfo
                  firstSeenChapter={item.firstSeenChapter}
                  resolvedAtChapter={item.resolvedAtChapter}
                  isResolved={true}
                />
              </div>
            </div>
          ))}

          {/* 若明细为空但计数 > 0，仅按计数展示说明文 */}
          {resolvedHooks.length === 0 && doneThreads.length === 0 && totalResolved > 0 ? (
            <div className="asset-item" style={{ opacity: 0.6 }}>
              <span>这里只记已回收的总数。想知道某条是怎么收的，直接问右边的 AI。</span>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
