/**
 * QualityCheckCard — 质检明细卡：blocking 硬伤（拦入库·突出红）+ soft 软提示（参考不拦·默认折叠防噪音）。
 * 数据来自 quality_check 的 RefinedQualityReport（message.qualityReport）。用 StepCard 暗金外壳。
 * 有硬伤 → status=attention、默认展开；无硬伤 → status=done、徽章「通过」、默认收起。
 */
import { useState } from "react";
import { StepCard } from "./StepCard.js";
import { IconChevronRight } from "./icons.js";
import type { QualityCardReport, QualityCardIssue } from "../../../api/types.js";

function IssueRow({ issue }: { readonly issue: QualityCardIssue }) {
  return (
    <li className="qcc-item">
      <div className="qcc-line">
        <span className={`qcc-sev qcc-sev-${issue.severity}`}>{issue.label}</span>
        <span className="qcc-msg">{issue.message}</span>
      </div>
    </li>
  );
}

export function QualityCheckCard({ report }: { readonly report: QualityCardReport }) {
  const blocking = report.blocking ?? [];
  const severe = report.severe ?? [];
  const soft = report.soft ?? [];
  const hasBlocking = blocking.length > 0;
  const hasSevere = severe.length > 0;
  const [softOpen, setSoftOpen] = useState(false);
  // 无硬伤 → 默认折叠（防噪音）；有软提示则在徽章里计数提示，用户要看再展开整卡 → 再展开软提示。
  const passLabel = soft.length > 0 ? `通过 · ${soft.length} 提示` : "通过";
  // afterfix：severe（AI confirmed+high 的严重问题）虽不硬拦入库，但绝不能用绿「通过」埋掉——
  // 卡片转 attention、默认展开、严重项与硬伤同级醒目（独立 ul、不折叠），不再单打「可入库」误导。
  const statusLabel = hasBlocking
    ? `${blocking.length} 处硬伤`
    : hasSevere
      ? `${severe.length} 处严重 · 建议先改`
      : passLabel;
  return (
    <StepCard
      title="硬伤检查"
      status={hasBlocking || hasSevere ? "attention" : "done"}
      statusLabel={statusLabel}
      defaultOpen={hasBlocking || hasSevere}
    >
      {hasBlocking ? (
        <ul className="qcc-list">{blocking.map((i) => <IssueRow issue={i} key={`${i.type}|${i.message}`} />)}</ul>
      ) : null}
      {hasSevere ? (
        <>
          <p className="qcc-severe-note">没有阻止定稿的硬伤，但有 {severe.length} 处严重问题（AI 已确认），强烈建议先改再定稿：</p>
          <ul className="qcc-list">{severe.map((i) => <IssueRow issue={i} key={`${i.type}|${i.message}`} />)}</ul>
        </>
      ) : null}
      {!hasBlocking && !hasSevere ? (
        <p className="qcc-pass">没有硬伤，可以定稿。</p>
      ) : null}
      {soft.length > 0 ? (
        <div className="qcc-soft">
          <button type="button" className="qcc-soft-toggle" onClick={() => setSoftOpen((v) => !v)} aria-expanded={softOpen}>
            <span className={`qcc-caret${softOpen ? " is-open" : ""}`} aria-hidden="true"><IconChevronRight size={11} strokeWidth={2} /></span>
            软提示 {soft.length} 处（参考不拦）
          </button>
          {softOpen ? <ul className="qcc-list">{soft.map((i) => <IssueRow issue={i} key={`${i.type}|${i.message}`} />)}</ul> : null}
        </div>
      ) : null}
    </StepCard>
  );
}
