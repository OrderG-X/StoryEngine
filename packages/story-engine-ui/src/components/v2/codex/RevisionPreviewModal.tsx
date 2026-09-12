/**
 * RevisionPreviewModal — 选区改写预览的「写作区下方独立弹窗」。
 *
 * 设计目标：一目了然。把改写结果直接显示成一段话，删去的字划掉、新增/改动的字金色高亮
 * （行内 diff，见 inlineDiff.ts），配一行图例 + 一句「改了什么」+ 风险（有才显示）。
 * 砍掉老卡那堆冗余字段（修订任务/原文片段/修订目标/约束/双栏原文-修订后），不再让人逐字对着比。
 *
 * 零改引擎、零改 apply 路径——同一套 activeRevisionTask/activeRevisionPreview 数据，换个清晰的展示。
 * `activeRevisionTask` 非空才渲染；定位/毛玻璃/z-index 走 codex.css 的 `.revision-preview-modal`，
 * 相对 `.codex-desk`（relative）居中覆盖稿纸区（宽 640–720px、高上限 70%）。previewDraftRevision 是同步 API、无逐字思考流，故生成中只做 loading 态。
 *
 * 四态：generating / idle（任务在但无 preview）/ zero-diff（前后相同，无「应用到工作稿」）/ preview。
 * 切勿把 idle 并进假 loading：审稿「生成修订任务」若只建任务不立刻请求，会永久卡「正在改写中…」。
 */
import type { WritingWorkspaceLayoutProps } from "../../../types.js";
import { useDisplaySettingsStore, ZOOM_MIN, ZOOM_MAX, ZOOM_STEP } from "../../../stores/displaySettingsStore.js";
import { diffChars } from "./inlineDiff.js";
import { isRevisionZeroDiff } from "./revisionZeroDiff.js";

/** draftActionLoading 是不是「正在改写本次选区 / 正在生成本次修订草案」。 */
function isGeneratingRevision(loading: string | null | undefined): boolean {
  if (!loading) return false;
  return loading === "revision-preview" || loading.startsWith("selection-rewrite-");
}

export default function RevisionPreviewModal(props: WritingWorkspaceLayoutProps) {
  const task = props.activeRevisionTask;
  if (!task) return null; // 没有选区改写在进行 → 不渲染弹窗。
  const preview = props.activeRevisionPreview;
  const generating = isGeneratingRevision(props.draftActionLoading);
  const applying = props.draftActionLoading === "revision-apply";
  const risks = preview ? [...preview.riskNotes, ...preview.warnings].map((r) => `${r}`.trim()).filter(Boolean) : [];
  const rewriteZoom = useDisplaySettingsStore((s) => s.rewriteZoom);
  const adjustFont = useDisplaySettingsStore((s) => s.adjustDisplaySetting);
  const zeroDiff = preview ? isRevisionZeroDiff(preview.beforeText, preview.afterText) : false;

  return (
    <div className="revision-preview-modal" role="dialog" aria-label="修改预览">
      <div className="rpm-head">
        <span className="rpm-title">修改预览</span>
        <div className="rpm-font" aria-label="框内字号">
          <button type="button" className="rpm-font-btn" disabled={rewriteZoom <= ZOOM_MIN} onClick={() => adjustFont("rewriteZoom", -ZOOM_STEP)} aria-label="框内字号减小">A−</button>
          <button type="button" className="rpm-font-btn" disabled={rewriteZoom >= ZOOM_MAX} onClick={() => adjustFont("rewriteZoom", ZOOM_STEP)} aria-label="框内字号增大">A+</button>
        </div>
        <button
          type="button"
          className="rpm-close"
          onClick={props.onDismissRevisionTask}
          aria-label="放弃本次改写"
          title="放弃本次改写"
        >
          ×
        </button>
      </div>

      {generating ? (
        <div className="rpm-generating" aria-live="polite">
          <span className="rpm-think">正在改写中…</span>
        </div>
      ) : !preview ? (
        <div className="rpm-idle" aria-live="polite">
          <p className="rpm-idle-msg">修订草案尚未生成（可能生成失败）</p>
          <div className="rpm-actions">
            <button
              type="button"
              className="rpm-btn"
              disabled={!props.onGenerateRevisionPreview}
              onClick={props.onGenerateRevisionPreview}
            >
              生成修订草案
            </button>
            <button type="button" className="rpm-btn" onClick={props.onDismissRevisionTask}>
              放弃
            </button>
          </div>
        </div>
      ) : zeroDiff ? (
        <div className="rpm-idle" aria-live="polite">
          <p className="rpm-idle-msg">这段无需修改——改写结果与原文相同，草稿不会有变化。</p>
          <div className="rpm-actions">
            <button type="button" className="rpm-apply" onClick={props.onDismissRevisionTask}>
              保留原文并关闭
            </button>
            <button
              type="button"
              className="rpm-btn"
              disabled={!props.onGenerateRevisionPreview}
              onClick={props.onGenerateRevisionPreview}
            >
              换一种改法
            </button>
          </div>
        </div>
      ) : (
        <div className="rpm-body">
          {/* 图例固定在滚动区外（P1-16）；框内字号只缩放 diff/说明。 */}
          <div className="rpm-legend rpm-legend-fixed">
            <span className="rpm-tag-del">划掉</span>＝删去
            <span className="rpm-tag-add">高亮</span>＝新增 / 改动
          </div>
          <div className="rpm-content" style={{ zoom: rewriteZoom }}>
            <p className="rpm-diff">
              {diffChars(preview.beforeText, preview.afterText).map((seg, idx) => {
                if (seg.type === "equal") return <span key={idx}>{seg.text}</span>;
                if (seg.type === "del") return <del key={idx} className="rpm-del">{seg.text}</del>;
                return <mark key={idx} className="rpm-add">{seg.text}</mark>;
              })}
            </p>
            {`${preview.changeSummary}`.trim() ? (
              <p className="rpm-summary">改了什么：{`${preview.changeSummary}`.trim()}</p>
            ) : null}
            {risks.length ? <p className="rpm-risk">⚠ {risks.join("；")}</p> : null}
          </div>
          <div className="rpm-actions">
            <button
              type="button"
              className="rpm-apply"
              disabled={applying || !props.onApplyRevisionPreview}
              onClick={props.onApplyRevisionPreview}
            >
              {applying ? "正在应用…" : "应用到工作稿"}
            </button>
            <button
              type="button"
              className="rpm-btn"
              disabled={applying || !props.onGenerateRevisionPreview}
              onClick={props.onGenerateRevisionPreview}
            >
              再改一版
            </button>
            <button type="button" className="rpm-btn" disabled={applying} onClick={props.onDismissRevisionTask}>
              放弃
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
