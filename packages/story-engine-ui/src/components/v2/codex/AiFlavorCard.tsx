/**
 * AiFlavorCard — 去 AI 味体检卡（随对应 assistant 消息渲染在时间线里，随对话滚动，不再钉底部）。
 *
 * 展示 check_ai_flavor 的报告：总评 + 进度 + 违规清单。每条按状态渲染：
 *   - 待改：原句 + 原因 + 「改掉这句」（复用选区改写链路 key=deai，弹预览框、应用前快照可撤销）。
 *   - 改写中：这条正在走改写（pendingViolationId 命中），按钮换成「改写中…」。
 *   - 已改 ✓：应用成功后（id ∈ fixedIds），整条置灰、收起原因与按钮、标「已改 ✓」——和左侧正文黄高亮联动。
 * 外壳走统一 StepCard（暗金折叠卡 + 状态徽章=X/N 已改），body 内仍用 .afc-*（高=暗红 / 中=金 / 轻=灰）。
 */
import { StepCard } from "./StepCard.js";
import type { AiFlavorReport, AiFlavorViolation } from "../../../types.js";

const SEVERITY_LABEL: Record<AiFlavorViolation["severity"], string> = { high: "重", medium: "中", low: "轻" };

export function AiFlavorCard({ report, fixedIds = [], pendingViolationId = null, awaitingApply = false, batchPending = false, onFix, onFixAll }: {
  readonly report: AiFlavorReport;
  /** 已点「改掉这句」并应用成功的违规 id（来自该条消息的 aiFlavorFixedIds）。 */
  readonly fixedIds?: readonly string[];
  /** 当前正在改写的违规 id（来自 store 的 aiFlavorPending，命中本卡时显示「改写中…」）。 */
  readonly pendingViolationId?: string | null;
  /** 那条 pending 的改写草案是否已生成、正等用户去写作台点「应用到工作稿」（activeRevisionPreview 就绪）。
   *  true=系统已闲、在等人 → 显「待应用」；false=模型还在改 → 显「改写中…」。治「等用户期间误标改写中＝以为卡死」。 */
  readonly awaitingApply?: boolean;
  /** 本卡是否正在「一键全修」中（命中时顶部按钮转「全修中…」、禁重复点）。 */
  readonly batchPending?: boolean;
  readonly onFix?: (violation: AiFlavorViolation) => void;
  /** 一键全修：把还没改的违规一次性批量去 AI 味。 */
  readonly onFixAll?: (violations: readonly AiFlavorViolation[]) => void;
}) {
  const total = report.violations.length;
  const fixedCount = report.violations.filter((v) => fixedIds.includes(v.id)).length;
  const allFixed = total === 0 || fixedCount >= total;
  const unfixed = report.violations.filter((v) => !fixedIds.includes(v.id));
  return (
    <StepCard
      title="检查机器腔"
      status={allFixed ? "done" : "attention"}
      statusLabel={total > 0 ? `${fixedCount}/${total} 已改` : "没有机器腔"}
      defaultOpen
    >
      <p className="afc-summary">
        {report.summary}
        {report.usedFallback ? <span className="afc-fallback"> · 模型没接上，用了通用判据</span> : null}
      </p>
      {/* afterfix3：点明这是文风体检、不拦入库——否则与质检「可入库」并排时读着自相矛盾（Codex 反馈）。仅有违规时显，避免噪音。 */}
      {total === 0 ? null : <p className="afc-note">文风检查 · 不影响定稿，按需修改</p>}
      {/* 一键全修：还有没改的违规且提供了 onFixAll 时显。一次批量改写、倒序落盘、整批可撤销（修 Codex「逐句改太费劲」）。 */}
      {!allFixed && onFixAll ? (
        <button
          type="button"
          className="chip afc-fix-all"
          disabled={batchPending}
          onClick={() => onFixAll(unfixed)}
        >
          {batchPending ? "一键全修中…" : `一键全修剩余 ${unfixed.length} 处`}
        </button>
      ) : null}
      {total === 0 ? null : (
        <ul className="afc-list">
          {report.violations.map((v) => {
            const fixed = fixedIds.includes(v.id);
            const pending = !fixed && pendingViolationId === v.id;
            return (
              <li className={`afc-item${fixed ? " afc-item-fixed" : ""}`} key={v.id}>
                <div className="afc-line">
                  <span className={`afc-sev afc-sev-${v.severity}`}>{SEVERITY_LABEL[v.severity]}</span>
                  <span className="afc-text serif">{v.text}</span>
                  {fixed ? <span className="afc-done">已改 ✓</span> : null}
                </div>
                {/* 已改的收起原因（去冗余、缩短卡片）；待改/改写中才显示原因。 */}
                {fixed ? null : <p className="afc-reason">{v.reason}</p>}
                {fixed ? null : pending ? (
                  <span className="afc-pending">{awaitingApply ? "待应用" : "改写中…"}</span>
                ) : onFix ? (
                  <button type="button" className="chip afc-fix" onClick={() => onFix(v)}>
                    改掉这句
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </StepCard>
  );
}
