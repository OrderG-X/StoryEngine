import { useEffect, useRef, useState } from "react";
import type { WritingWorkspaceLayoutProps } from "../../../types.js";
import WritingPaper from "../WritingPaper.js";
import DraftCandidatesPanel from "../DraftCandidatesPanel.js";
import RevisionPreviewModal from "./RevisionPreviewModal.js";
import { NamePeek } from "./NamePeek.js";
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
import { useNavigationStore } from "../../../stores/navigationStore.js";
import { useDraftStore } from "../../../stores/draftStore.js";
import { useDraftPreview } from "../../../drafts/useDraftPreview.js";
import { scheduleDraftSave } from "../../../drafts/draftSync.js";

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

/** 从写作规则里读「每章目标字数」（sidebar 已格式化成「目标字数：约 3200 字 / 章」）；没配就返回 null，不画目标条。 */
export function parseTargetChapterWords(writingRules: readonly string[] | undefined): number | null {
  for (const rule of writingRules ?? []) {
    const match = /目标字数[：:]\s*约?\s*(\d{3,6})/u.exec(rule);
    if (match) return Number(match[1]);
  }
  return null;
}

export default function WritingDeskCodex(props: WritingWorkspaceLayoutProps & {
  /** 角色速览卡里点「在设定本中打开」。 */
  readonly onOpenCharacter?: (name: string) => void;
  /** 选区浮动条「问 AI」：把选中段引用进右侧输入框。 */
  readonly onAskAboutSelection?: (selectionText: string) => void;
}) {
  const [activeTab, setActiveTab] = useState<"draft" | "committed">("draft");
  // 正文字号已上提到 displaySettingsStore（设置面板统一调）；底部旧 A-/A+ 步进器已撤。
  const paperFontSize = useDisplaySettingsStore((s) => s.deskFontSize);
  const draft = useDraftPreview({ chapterNumber: props.workspace.currentChapter.chapterNumber, title: props.workspace.currentChapter.title });
  const committedBody = useDraftStore((state) => state.committed?.body ?? "");
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
  // 「作者写、AI 管账」：新书首屏第一个按钮是「自己动笔写」——点了直接出稿纸（2026-10-10 验收：新书原先只有三个让 AI 写的按钮，作者没地方下笔）。
  const [authorStarted, setAuthorStarted] = useState(false);
  const showStarter = isStarterEmptyWorkspace({ draft, chapters: props.workspace.chapters }) && !authorStarted;
  const paperDraft = draft;
  const showEditHint = activeTab === "draft" && draft.status !== "committed" && draft.streaming !== true;
  const targetWords = parseTargetChapterWords(props.sidebar?.writingRules);
  const goalPct = targetWords ? Math.min(100, Math.round((draftWordCount / targetWords) * 100)) : 0;
  // 低于目标 78%（≈「最少」口径）提醒橙，达标绿，其余强调色。
  const goalTone = !targetWords ? "" : draftWordCount >= targetWords ? "met" : draftWordCount < targetWords * 0.78 ? "low" : "";
  // 本章梗概：取时间线里本章的主事件（只有最近几章有），没有就不显示。
  const synopsisEvent = props.overview?.timeline?.recentEvents?.find((event) => event.chapter === draft.chapterNumber);
  const synopsis = (synopsisEvent?.mainEvent || synopsisEvent?.summary || "").trim();
  const [synopsisOpen, setSynopsisOpen] = useState(false);
  // 上一章 / 下一章（按章号相邻，跳过未写的占位章）。
  const realChapters = [...props.workspace.chapters]
    .filter((ch) => ch.status !== "planned" || ch.chapterNumber === draft.chapterNumber)
    .sort((a, b) => a.chapterNumber - b.chapterNumber);
  const prevChapter = [...realChapters].reverse().find((ch) => ch.chapterNumber < draft.chapterNumber) ?? null;
  // 下一章包含「还没写」的占位章：在最新一章时也能一步走到下一章开写。
  const nextChapter = [...props.workspace.chapters]
    .sort((a, b) => a.chapterNumber - b.chapterNumber)
    .find((ch) => ch.chapterNumber > draft.chapterNumber) ?? null;
  const goToChapter = (id: string) => {
    if (workspaceBusy) {
      useNavigationStore.getState().showToast("写作操作正在进行，请等本次操作结束后再切换章节。", 4600);
      return;
    }
    props.onSelectChapter?.(id);
  };

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
          {targetWords ? (
            <span className={`cd-goal ${goalTone}`.trim()} title={`写作规则：每章目标约 ${targetWords.toLocaleString()} 字`}>
              <span className="cd-words"><b>{draftWordCount.toLocaleString()}</b> / {targetWords.toLocaleString()} 字</span>
              <span className="cd-goal-bar" aria-hidden="true"><i style={{ width: `${goalPct}%` }} /></span>
            </span>
          ) : (
            <span className="cd-words">{draftWordCount.toLocaleString()} 字</span>
          )}
          <div className="cd-tabs" role="tablist" aria-label="版本视图">
            <button className={activeTab === "draft" ? "is-active" : ""} onClick={() => setActiveTab("draft")} type="button" aria-label="查看工作稿">工作稿</button>
            <button className={activeTab === "committed" ? "is-active" : ""} onClick={() => setActiveTab("committed")} type="button" aria-label="查看定稿">定稿</button>
          </div>
        </div>
        {synopsis && !showStarter ? (
          <button
            type="button"
            className={`cd-synopsis${synopsisOpen ? " is-open" : ""}`}
            aria-expanded={synopsisOpen}
            title={synopsisOpen ? "收起" : synopsis}
            onClick={() => setSynopsisOpen((open) => !open)}
          >
            <b>本章梗概</b>
            <span>{synopsis}</span>
          </button>
        ) : null}
      </header>

      {/* 中间：稿纸"浮"在暗场里。草稿走 WritingPaper（完整编辑器内核），正文走只读段落（照 WritingDesk）。 */}
      <div className="codex-desk-stage" ref={stageRef}>
        {activeTab === "draft" ? (
          showStarter ? (
            <div className="cd-starter" aria-label="新书起步引导">
              <h2 className="cd-starter-title">从一句话开始</h2>
              <p className="cd-starter-sub">直接在稿纸上写，AI 帮你记人物、东西、伏笔，查前后对不对得上。也可以先跟 AI 聊聊。</p>
              <div className="cd-starter-actions" role="group" aria-label="起步意图">
                <button type="button" className="cd-starter-btn" onClick={() => setAuthorStarted(true)}>
                  自己动笔写
                </button>
                {STARTER_INTENTS.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    className="cd-starter-btn is-ghost"
                    disabled={workspaceBusy || !props.onSendMessage}
                    onClick={() => props.onSendMessage?.(item.intent)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <>
            <PaperIncomingBanner />
            <WritingPaper draft={paperDraft} fontSize={paperFontSize} onEdit={props.onDraftContentChange} onSelectionRewrite={props.onSelectionRewrite} onSelectionRewriteCustom={props.onSelectionRewriteCustom} onAskAboutSelection={props.onAskAboutSelection} />
            </>
          )
        ) : (
          <div className="se-v2-editor-wrap se-v2-paper">
            <div className="se-v2-editor-text">
              {committedBody.trim() ? (
                cleanProseForDisplay(committedBody).split(/\n{2,}/u).map((para, i) => (
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
        {/* 角色名速览：正文里的角色名画虚下划线，鼠标停上去弹出角色卡（不碰编辑器内核，见 NamePeek）。 */}
        {!showStarter ? (
          <NamePeek
            stageRef={stageRef}
            matrix={props.workspace.characterMatrix}
            contentKey={`${draft.chapterNumber}:${activeTab}`}
            onOpenCharacter={props.onOpenCharacter}
          />
        ) : null}
      </div>

      {/* 底部细条：上一章 / 再来一版 / 下一章；都没有时整条不渲染。 */}
      {prevChapter || nextChapter || (canReroll && !showStarter) ? (
      <footer className="codex-desk-bar codex-desk-bar-bottom">
        {prevChapter ? (
          <button className="cd-nav prev" type="button" disabled={workspaceBusy} onClick={() => goToChapter(prevChapter.id)} title="上一章">
            <span>上一章</span>{chapterHeading(prevChapter.chapterNumber, prevChapter.title ?? "")}
          </button>
        ) : <span />}
        {canReroll && !showStarter ? (
          <button
            className="cd-reroll"
            disabled={rerolling}
            onClick={() => props.onReroll?.()}
            title={draftWordCount > 0 || draft.content.trim() ? "会保留当前版本，再生成 2–3 个候选版本供你挑选" : "生成第一版工作稿"}
            type="button"
          >
            {rerolling ? "生成候选中…" : draftWordCount > 0 || draft.content.trim() ? "再来一版" : "写第一版"}
          </button>
        ) : <span />}
        {nextChapter ? (
          <button className="cd-nav next" type="button" disabled={workspaceBusy} onClick={() => goToChapter(nextChapter.id)} title="下一章">
            <span>下一章</span>{nextChapter.status === "planned" ? `第${nextChapter.chapterNumber}章 · 还没写` : chapterHeading(nextChapter.chapterNumber, nextChapter.title ?? "")}
          </button>
        ) : <span />}
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

/**
 * 稿纸上方的提示条（重构 P5）：盘上的稿子在别处变了（AI 改稿、撤销）而作者手上还有没存的字。
 * 两边都不悄悄覆盖，让作者选。
 */
function PaperIncomingBanner() {
  const incoming = useDraftStore((state) => state.incoming);
  const saveStatus = useDraftStore((state) => state.saveStatus);
  const saveError = useDraftStore((state) => state.saveError);
  if (incoming) {
    const text = incoming.cause === "conflict"
      ? "这一章的稿子刚在别处改过（比如 AI 改稿或撤销），你手上这版还没存进去。"
      : "AI 刚写了这一章的新一版，你手上还有没存的字。";
    return (
      <div className="cd-incoming" role="alert">
        <span>{text}</span>
        <div className="cd-incoming-actions">
          <button type="button" onClick={() => useDraftStore.getState().acceptIncoming()}>换成那一版</button>
          <button
            type="button"
            className="is-primary"
            onClick={() => { useDraftStore.getState().keepMine(); scheduleDraftSave(0); }}
          >
            保留我这版
          </button>
        </div>
      </div>
    );
  }
  if (saveStatus === "error") {
    return (
      <div className="cd-incoming is-error" role="alert">
        <span>稿子没存上：{saveError ?? "原因不明"}</span>
        <div className="cd-incoming-actions">
          <button type="button" className="is-primary" onClick={() => scheduleDraftSave(0)}>再存一次</button>
        </div>
      </div>
    );
  }
  return null;
}
