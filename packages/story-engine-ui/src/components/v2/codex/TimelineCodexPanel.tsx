import { useState } from "react";
import type { TimelineLayerEvent, TimelineMacroBlock } from "@actalk/story-engine";
import type { StateOverviewTimelineEvent } from "../../../api/types.js";

/**
 * TimelineCodexPanel — 时间线面板（只读，回顾长篇脉络）。
 *
 * 三层垂直流式（新在上，倒序）：
 *  - L1 近期（recentEvents）：最近 3 章，完整字段，全展开。
 *  - L2 中段（earlierSummary）：第 4-15 章紧凑摘要，默认展开最近 3 条 + 折叠更早。
 *  - L3 远期（macroSummary）：第 16 章前每 5 章一宏块，全展开。
 *
 * 数据来自 props.overview.timeline（engine 已分层）。只读面板，无富化按钮。
 * 字段可选降级：location/mainEvent 缺时隐藏对应部分，绝不造假。
 *
 * 去重两则（2026-07-04 真机走查）：
 * - 章级：recentEvents 窗口与 L2/L3 窗口可能重叠（短书尤甚），同一章会在「近期」「中段」各出现一遍
 *   → 渲染前把已被 L2/L3 覆盖的章从 L1 剔除。
 * - 句级：timelineSummary 是 top-2 句拼接、首句常常就是 mainEvent，直接渲染会同一句上下各一遍
 *   → summary 渲染前抠掉 mainEvent 子串，只留补充句。
 */
/**
 * 从 summary 里抠掉 mainEvent 子串，返回剩余补充句；全被抠空则返回 undefined（不渲染）。
 * mainEvent 可能因 truncate 带尾部省略号——匹配前先去掉再找子串。
 */
export function stripMainEventFromSummary(
  summary: string | undefined,
  mainEvent: string | undefined,
): string | undefined {
  const full = (summary ?? "").trim();
  if (!full) return undefined;
  const needle = (mainEvent ?? "").trim().replace(/…+$/u, "");
  if (!needle || !full.includes(needle)) {
    return full === (mainEvent ?? "").trim() ? undefined : full;
  }
  const rest = full
    .replace(needle, " ")
    .replace(/\s+/gu, " ")
    .trim()
    // 抠掉截断版 mainEvent 后残留的孤儿省略号（句中正常的 …… 不受影响）
    .replace(/^…+\s*/u, "")
    .trim();
  return rest.length > 0 ? rest : undefined;
}

export default function TimelineCodexPanel({
  timeline,
}: {
  readonly timeline?: {
    readonly recentEvents: readonly StateOverviewTimelineEvent[];
    readonly earlierSummary: readonly TimelineLayerEvent[];
    readonly macroSummary: readonly TimelineMacroBlock[];
  };
}) {
  const recentEvents = timeline?.recentEvents ?? [];
  const earlierSummary = timeline?.earlierSummary ?? [];
  const macroSummary = timeline?.macroSummary ?? [];

  const [l2Expanded, setL2Expanded] = useState(false);

  const isEmpty = recentEvents.length === 0 && earlierSummary.length === 0 && macroSummary.length === 0;
  if (isEmpty) {
    return (
      <section className="panel on" id="p-timeline">
        <div className="page-head">
          <div>
            <div className="kicker">Timeline · 章节脉络</div>
            <h1>时间线</h1>
          </div>
        </div>
        <div className="catrail-foot" style={{ marginTop: 40 }}>
          <b>还没有时间线</b>　去右边写第一章并定稿，时间线会按近期 / 中段 / 远期三层铺开。
        </div>
      </section>
    );
  }

  // recentEvents 窗口（最后 N 条）与 L2/L3 分层窗口（近 l1Window 章之外）不一致，
  // 同一章可能同时落进「近期」与「中段/远期」——渲染前把已被下层覆盖的章从 L1 剔掉，一章只出现一次。
  const l2Chapters = new Set(earlierSummary.map((event) => event.chapter));
  const coveredByMacro = (chapter: number): boolean =>
    macroSummary.some((block) => chapter >= block.fromChapter && chapter <= block.toChapter);
  const l1Descending = [...recentEvents]
    .filter((event) => !l2Chapters.has(event.chapter) && !coveredByMacro(event.chapter))
    .sort((a, b) => b.chapter - a.chapter);
  const l2Descending = [...earlierSummary].sort((a, b) => b.chapter - a.chapter);
  const l3Descending = [...macroSummary].sort((a, b) => b.toChapter - a.toChapter);

  return (
    <section className="panel on" id="p-timeline">
      <div className="page-head">
        <div>
          <div className="kicker">Timeline · 章节脉络</div>
          <h1>时间线</h1>
          <p className="lead-sub">
            按时间倒序铺开。近期看得详细，中段紧凑，远期按块概括——越往回越粗，一眼看清长篇脉络。
          </p>
        </div>
      </div>

      {/* L1 近期 — 完整字段，全展开 */}
      {l1Descending.length > 0 ? (
        <div className="asset-grp">
          <h5 className="h2">
            ● 近期 <span className="cnt">{l1Descending.length}</span>
          </h5>
          {l1Descending.map((event) => (
            <div key={`l1-${event.chapter}`} className="asset-item">
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <b>第{event.chapter}章</b>
                  {event.location ? (
                    <span className="tag" data-testid="loc">📍&nbsp;{event.location}</span>
                  ) : null}
                </div>
                {event.mainEvent ? (
                  <b data-testid="mainEvent">{event.mainEvent}</b>
                ) : null}
                {/* summary 常以 mainEvent 句开头（timelineSummary=top-2 句拼接、首句多为 mainEvent），
                    渲染前抠掉 mainEvent 子串，只留补充句——否则同一句上下各一遍。 */}
                {(() => {
                  const rest = stripMainEventFromSummary(event.summary, event.mainEvent);
                  return rest ? <span>{rest}</span> : null;
                })()}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {/* L2 中段 — 紧凑摘要，默认 3 条 + 折叠更早 */}
      {l2Descending.length > 0 ? (
        <div className="asset-grp">
          <h5 className="h2">
            ▦ 中段 <span className="cnt">{l2Descending.length}</span>
          </h5>
          {(l2Expanded ? l2Descending : l2Descending.slice(0, 3)).map((event) => (
            <div key={`l2-${event.chapter}`} className="asset-item">
              <span style={{ opacity: 0.85 }}>第{event.chapter}章 · {event.summary}</span>
            </div>
          ))}
          {l2Descending.length > 3 ? (
            <button
              type="button"
              style={{ cursor: "pointer", border: "1px dashed var(--line)", padding: "4px 8px", borderRadius: 4, background: "transparent", color: "inherit", marginTop: 4 }}
              onClick={() => setL2Expanded((v) => !v)}
            >
              {l2Expanded ? "◂ 折叠" : `▸ 展开更早 ${l2Descending.length - 3} 章`}
            </button>
          ) : null}
        </div>
      ) : null}

      {/* L3 远期 — 每 5 章一宏块，全展开 */}
      {l3Descending.length > 0 ? (
        <div className="asset-grp" style={{ opacity: 0.8 }}>
          <h5 className="h2">
            ▤ 远期 <span className="cnt">{l3Descending.length}</span>
          </h5>
          {l3Descending.map((block, index) => (
            <div key={`l3-${block.fromChapter}-${block.toChapter}-${index}`} className="asset-item">
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <b style={{ opacity: 0.7 }}>第{block.fromChapter}-{block.toChapter}章</b>
                <span style={{ fontStyle: "italic" }}>{block.summary}</span>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
