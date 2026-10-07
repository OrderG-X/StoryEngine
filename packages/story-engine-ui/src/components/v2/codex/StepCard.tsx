/**
 * StepCard — 写作链路富卡的统一可折叠外壳（对标 inkos 工具执行卡，披 codex 暗金皮）。
 * header：状态点 + 标题 + 徽章（按 status 默认文案，可 statusLabel 覆盖）+ 可选计时 + 折叠箭头。
 * body：折叠区，放各卡自己的结构化内容。无 children 时不可折叠、不出箭头。
 * 样式走 codex.css 的 .step-card / .sc-*（scope .codex-app；暗金，attention=金 / failed=暗红）。
 */
import { createContext, useContext, useState } from "react";
import type { ReactNode } from "react";
import { formatStepElapsed } from "./chatRenderShared.js";
import { IconChevronRight } from "./icons.js";

export type StepCardStatus = "running" | "done" | "attention" | "failed";

const DEFAULT_BADGE: Record<StepCardStatus, string> = {
  running: "执行中",
  done: "已完成",
  attention: "需注意",
  failed: "失败",
};

/**
 * 对话里「较早的回复」用它把卡片默认收起成一行（2026-10-07 改版：治回执卡层层堆叠，越翻越长）。
 * 只影响初始开合，点标题照样展开；最新一条回复不包它，卡片照常展开。
 */
export const StepCardCollapsedByDefault = createContext(false);

export function StepCard({ title, status, statusLabel, elapsedMs, defaultOpen = true, keepOpen = false, children }: {
  readonly title: string;
  readonly status: StepCardStatus;
  readonly statusLabel?: string;
  readonly elapsedMs?: number;
  readonly defaultOpen?: boolean;
  /** 卡里有还能点的关键按钮（如「确认定稿」）时永远默认展开，不受「旧回复收起」影响。 */
  readonly keepOpen?: boolean;
  readonly children?: ReactNode;
}) {
  const collapsedByDefault = useContext(StepCardCollapsedByDefault);
  const [open, setOpen] = useState(keepOpen || (defaultOpen && !collapsedByDefault));
  const hasBody = Boolean(children);
  const badge = statusLabel ?? DEFAULT_BADGE[status];
  const elapsed = typeof elapsedMs === "number" && elapsedMs > 0 ? formatStepElapsed(elapsedMs) : null;
  return (
    <div className={`step-card sc-${status}`}>
      <button
        type="button"
        className="sc-head"
        onClick={() => { if (hasBody) setOpen((v) => !v); }}
        aria-expanded={hasBody ? open : undefined}
        disabled={!hasBody}
      >
        <span className="sc-dot" aria-hidden="true" />
        <span className="sc-title">{title}</span>
        <span className="sc-badge">{badge}</span>
        {elapsed ? <span className="sc-tm">{elapsed}</span> : null}
        {hasBody ? <span className={`sc-caret${open ? " is-open" : ""}`} aria-hidden="true"><IconChevronRight size={12} strokeWidth={2} /></span> : null}
      </button>
      {open && hasBody ? <div className="sc-body">{children}</div> : null}
    </div>
  );
}
