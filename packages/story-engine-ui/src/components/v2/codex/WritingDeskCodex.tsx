import { useEffect, useRef, useState } from "react";
import type { WritingWorkspaceLayoutProps } from "../../../types.js";
import WritingPaper from "../WritingPaper.js";
import DraftCandidatesPanel from "../DraftCandidatesPanel.js";
import RevisionPreviewModal from "./RevisionPreviewModal.js";
import { chapterHeading, cleanProseForDisplay, flowLabel } from "../v2Utils.js";
import { useWorkspaceStore } from "../../../stores/workspaceStore.js";
import { useDisplaySettingsStore } from "../../../stores/displaySettingsStore.js";
import {
  committedEmptySubtitle,
  committedEmptyTitle,
  PREVIEW_COMMIT_INTENT,
} from "./committedEmptyCopy.js";
import {
  STARTER_INTENTS,
  isStarterEmptyWorkspace,
} from "./starterGuidance.js";
import { isWorkspaceBusy } from "../../../utils/workspaceOperation.js";

/**
 * WritingDeskCodex — 沉浸聚光式 codex 写作台外壳。
 *
 * 逻辑/handler/状态与 WritingDesk 一致（activeTab 草稿/正文、draftCandidates、reroll、
 * WritingPaper 调用、DraftCandidatesPanel）；只把外层 chrome 的 markup 换成 codex 沉浸版：
 *  - 顶部纤细悬浮条（codex 暗金、半透/淡）：《书名》· chapterHeading + flowLabel + 字数 + 草稿/正文 toggle。
 *  - 中间：稿纸 + WritingPaper（草稿）/ 正式正文，外套 .codex-desk 让 CSS 做居中悬浮 + 四周压暗。
 *  - 底部纤细悬浮条：再来一版（正文字号已上提到 displaySettingsStore，由「设置 · 显示」面板统一调）。
 *
 * 编辑器内核（句级聚焦、打字机居中、查找替换、选区改写、IME、外部稿同步）全在 WritingPaper 里复用，
 * 本组件一行都不碰；codex 沉浸视觉（居中稿纸 / 暗角 / 金 caret / 当前句呼吸辉光）全走 codex.css 的 .codex-desk 作用域。
 */
/** 状态药丸配色：定稿=绿、生成/检查中=强调色、其余（工作稿/待开始）=橙，提醒「还没定稿」。 */
function flowTone(state: WritingWorkspaceLayoutProps["workspace"]["flowStatus"]): string {
  if (state === "committed" || state === "ready_for_next") return "ok";
  if (state === "draft_generating") return "run";
  if (state === "idle" || state === "steering_ready") return "";
  return "warn";
}

export default function WritingDeskCodex(props: WritingWorkspaceLayoutProps) {
  const [activeTab, setActiveTab] = useState<"draft" | "committed">("draft");
  // 正文字号已上提到 displaySettingsStore（设置面板统一调）；底部旧 A-/A+ 步进器已撤。
  const paperFontSize = useDisplaySettingsStore((s) => s.deskFontSize);
  const draft = props.workspace.draft;
  const draftCandidates = useWorkspaceStore((state) => state.draftCandidates);
  const draftActionLoading = useWorkspaceStore((state) => state.draftActionLoading);
  const workspaceBusy = Boolean(
    props.chatLoading
    || props.steeringLoading
    || draftActionLoading
    || isWorkspaceBusy(),
  );
  const rerolling = draftActionLoading === "reroll-candidates";
  const applyingCandidate = draftActionLoading === "apply-candidate";
  const canReroll = draft.status !== "committed" && Boolean(props.onReroll) && !workspaceBusy;
  const draftWordCount = draft.wordCount ?? 0;
  const showStarter = isStarterEmptyWorkspace(props.workspace);
  const showEditHint = activeTab === "draft" && draft.status !== "committed";

  // 切章/切视图后正文回到顶部：稿纸的滚动容器（草稿=.se-v2-writing-canvas / 正文=.se-v2-paper）
  // 是 .codex-desk-stage 的直接子元素、且 overflow-y:auto。换章时 draft 变了但容器 scrollTop 不会自己归零，
  // 导致「看完上一章切到下一章还停在半中腰、要手动拉回顶」。这里在切章/切视图时把当前滚动子容器归顶；
  // 再用一帧 rAF 兜底（草稿视图里 WritingPaper 切章后会 in-place 换内容/可能微调布局，避免它把位置又顶下去）。
  const stageRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const resetTop = () => {
      const scroller = stage.querySelector<HTMLElement>(
        ":scope > .se-v2-writing-canvas, :scope > .se-v2-paper",
      );
      if (scroller) scroller.scrollTop = 0;
    };
    resetTop();
    const raf = requestAnimationFrame(resetTop);
    return () => cancelAnimationFrame(raf);
  }, [draft.chapterNumber, activeTab]);

  return (
    <div className="codex-desk" aria-label="写作台">
      {/* 顶部细条：章号标题 + 状态 + 字数 + 工作稿/定稿 切换（书名在全局顶栏；专注写作开关也在顶栏）。 */}
      <header className="codex-desk-bar codex-desk-bar-top">
        <div className="cd-title">
          <strong className="cd-chapter">{chapterHeading(draft.chapterNumber, draft.title)}</strong>
          <em className={`cd-flow ${flowTone(props.workspace.flowStatus)}`}>{flowLabel(props.workspace.flowStatus)}</em>
          {showEditHint ? (
            <span className="cd-edit-hint">可直接编辑 · 自动保存</span>
          ) : null}
        </div>
        <div className="cd-bar-right">
          <span className="cd-words">{draftWordCount.toLocaleString()} 字</span>
          <div className="cd-tabs" role="tablist" aria-label="版本视图">
            <button className={activeTab === "draft" ? "is-active" : ""} onClick={() => setActiveTab("draft")} type="button" aria-label="查看工作稿">工作稿</button>
            <button className={activeTab === "committed" ? "is-active" : ""} onClick={() => setActiveTab("committed")} type="button" aria-label="查看定稿">定稿</button>
          </div>
        </div>
      </header>

      {/* 中间：稿纸"浮"在暗场里。草稿走 WritingPaper（完整编辑器内核），正文走只读段落（照 WritingDesk）。 */}
      <div className="codex-desk-stage" ref={stageRef}>
        {activeTab === "draft" ? (
          showStarter ? (
            <div className="cd-starter" aria-label="新书起步引导">
              <h2 className="cd-starter-title">从一句话开始</h2>
              <p className="cd-starter-sub">不必先填资料。选一个方向，右侧 AI 会陪你搭起来。</p>
              <div className="cd-starter-actions" role="group" aria-label="起步意图">
                {STARTER_INTENTS.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    className="cd-starter-btn"
                    disabled={workspaceBusy || !props.onSendMessage}
                    onClick={() => props.onSendMessage?.(item.intent)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <WritingPaper draft={draft} fontSize={paperFontSize} onEdit={props.onDraftContentChange} onSelectionRewrite={props.onSelectionRewrite} onSelectionRewriteCustom={props.onSelectionRewriteCustom} />
          )
        ) : (
          <div className="se-v2-editor-wrap se-v2-paper">
            <div className="se-v2-editor-text">
              {draft.status === "committed" && draft.content.trim() ? (
                cleanProseForDisplay(draft.content).split(/\n{2,}/u).map((para, i) => (
                  para.trim() ? <p key={i}>{para.trim()}</p> : null
                ))
              ) : (
                <div className="se-v2-editor-empty cd-committed-empty">
                  <h2>{committedEmptyTitle()}</h2>
                  <p>{committedEmptySubtitle(draftWordCount)}</p>
                  <div className="cd-committed-empty-actions">
                    <button
                      type="button"
                      className="cd-committed-primary"
                      onClick={() => setActiveTab("draft")}
                    >
                      返回工作稿继续写
                    </button>
                    {props.onSendMessage ? (
                      <button
                        type="button"
                        className="cd-committed-secondary"
                        disabled={workspaceBusy || draftWordCount <= 0}
                        onClick={() => props.onSendMessage?.(PREVIEW_COMMIT_INTENT)}
                      >
                        预览定稿改动
                      </button>
                    ) : null}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* 底部细条：只放「再来一版」；没得放时整条不渲染（不留空条）。 */}
      {canReroll && !showStarter ? (
      <footer className="codex-desk-bar codex-desk-bar-bottom">
        {(
          <button
            className="cd-reroll"
            disabled={rerolling}
            onClick={() => props.onReroll?.()}
            title={draftWordCount > 0 || draft.content.trim() ? "会保留当前版本，再生成 2–3 个候选版本供你挑选" : "生成第一版工作稿"}
            type="button"
          >
            {rerolling ? "生成候选中…" : draftWordCount > 0 || draft.content.trim() ? "↻ 再来一版" : "✎ 写第一版"}
          </button>
        )}
      </footer>
      ) : null}

      {draftCandidates && draftCandidates.length > 0 ? (
        <DraftCandidatesPanel
          candidates={draftCandidates}
          busy={workspaceBusy || applyingCandidate}
          onPick={(content) => props.onApplyCandidate?.(content)}
          onClose={() => props.onCloseCandidates?.()}
        />
      ) : null}

      {/* 选区改写预览：覆盖稿纸区居中模态（相对 .codex-desk 绝对定位）。
          activeRevisionTask 非空才渲染；行为（零差异/生成态）不变。 */}
      <RevisionPreviewModal {...props} />
    </div>
  );
}
