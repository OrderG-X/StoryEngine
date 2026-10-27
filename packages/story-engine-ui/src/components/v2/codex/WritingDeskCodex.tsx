import { useEffect, useRef, useState } from "react";
import type { WritingWorkspaceLayoutProps } from "../../../types.js";
import WritingPaper from "../WritingPaper.js";
import DraftCandidatesPanel from "../DraftCandidatesPanel.js";
import RevisionPreviewModal from "./RevisionPreviewModal.js";
import { NamePeek } from "./NamePeek.js";
import type { NamePeekCard } from "./bibleIndex.js";
import { ContinuityMarks } from "./ContinuityMarks.js";
import { BrainstormPanel } from "./Brainstorm.js";
import { QuoteJumpMarker } from "./QuoteJump.js";
import { PaperToolbar } from "./PaperToolbar.js";
import { ChapterTitle } from "./ChapterTitle.js";
import { ChapterSynopsis } from "./ChapterSynopsis.js";
import { PreWriteMemo } from "./PreWriteMemo.js";
import { IconPencil } from "./icons.js";
import { useChapterDirections, useChapterProgress, useContinuityResult } from "../../../workspace/chapterProgress.js";
import { chapterHeading, cleanProseForDisplay } from "../v2Utils.js";
import { useUiStore } from "../../../stores/uiStore.js";
import { useDisplaySettingsStore } from "../../../stores/displaySettingsStore.js";
import {
  committedEmptySubtitle,
  committedEmptyTitle,
} from "./committedEmptyCopy.js";
import {
  STARTER_INTENTS,
  isStarterEmptyWorkspace,
  starterSteps,
} from "./starterGuidance.js";
import { isWorkspaceBusy } from "../../../utils/workspaceOperation.js";
import { useNavigationStore } from "../../../stores/navigationStore.js";
import { useDraftStore } from "../../../stores/draftStore.js";
import { useDraftPreview } from "../../../drafts/useDraftPreview.js";
import { refreshPaper, scheduleDraftSave } from "../../../drafts/draftSync.js";
import { retitleCommittedChapter } from "../../../api/workingDraftClient.js";
import { useBookStore } from "../../../stores/bookStore.js";
import { updateChapterListTitle } from "../../../utils/bookUtils.js";

/** 章节列表和顶栏面包屑当场换上新章名（不等下一次刷新概览）。 */
function showChapterTitle(chapterNumber: number, title: string): void {
  const book = useBookStore.getState();
  const { workspace } = book;
  book.updateWorkspace({
    chapters: updateChapterListTitle(workspace.chapters, chapterNumber, title),
    ...(workspace.currentChapter.chapterNumber === chapterNumber ? { currentChapter: { ...workspace.currentChapter, title } } : {}),
  });
}

/** 作者改章名：工作稿的章名跟正文一起存。 */
function renameChapter(chapterNumber: number, title: string): void {
  useDraftStore.getState().setTitle(title);
  scheduleDraftSave(0);
  showChapterTitle(chapterNumber, title);
}

/**
 * 改已定稿那一章的章名（作者档、改前存档可撤销；正文和账不动）。真机试写：定稿前忘起章名，定稿后稿纸锁了、
 * 章名点不动，AI 也改不了，章节栏永远「未命名」。没改成如实说原因。
 */
async function renameCommittedChapter(chapterNumber: number, title: string): Promise<void> {
  const projectPath = useDraftStore.getState().projectPath;
  if (!projectPath) return;
  const outcome = await retitleCommittedChapter(projectPath, chapterNumber, title);
  const toast = useNavigationStore.getState().showToast;
  if (!outcome.ok) {
    toast(`章名没改成：${outcome.error}`, 4600);
    return;
  }
  showChapterTitle(chapterNumber, outcome.title);
  await refreshPaper({ force: true, chapter: chapterNumber }).catch(() => undefined);
  if (!outcome.unchanged) toast("章名改好了，操作历史里能撤销。");
}

/**
 * WritingDeskCodex — 沉浸聚光式 codex 写作台外壳。
 *
 * 逻辑/handler/状态与 WritingDesk 一致（activeTab 草稿/正文、draftCandidates、reroll、
 * WritingPaper 调用、DraftCandidatesPanel）；只把外层 chrome 的 markup 换成 codex 沉浸版：
 *  - 顶部纤细悬浮条（codex 暗金、半透/淡）：chapterHeading + 字数 + 工作稿/定稿 toggle。
 *    章节状态只在稿纸底下的工具条和右栏顶卡显示（同源 chapterProgress，P6 第 6 步拿掉了这里另算的状态药丸）。
 *  - 中间：稿纸 + WritingPaper（草稿）/ 正式正文，外套 .codex-desk 让 CSS 做居中悬浮 + 四周压暗。
 *  - 底部纤细悬浮条：再来一版（正文字号已上提到 displaySettingsStore，由「设置 · 显示」面板统一调）。
 *
 * 编辑器内核（句级聚焦、打字机居中、查找替换、选区改写、IME、外部稿同步）全在 WritingPaper 里复用，
 * 本组件一行都不碰；codex 沉浸视觉（居中稿纸 / 暗角 / 金 caret / 当前句呼吸辉光）全走 codex.css 的 .codex-desk 作用域。
 */
/** 每章目标字数：读开书概况里设定本写作规则的结构化字段；没定就返回 null，不画目标条。 */
export function targetChapterWordsOf(overview: { readonly setting?: { readonly targetChapterWords?: number } } | null | undefined): number | null {
  const value = overview?.setting?.targetChapterWords;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

export default function WritingDeskCodex(props: WritingWorkspaceLayoutProps & {
  /** 正文名字速览要的人物卡（设定视图，WritingWorkspaceCodex 读一份传下来）。 */
  readonly peekCards?: readonly NamePeekCard[];
  /** 角色速览卡里点「在设定本中打开」。 */
  readonly onOpenCharacter?: (name: string) => void;
  /** 选区浮动条「问 AI」：把选中段引用进右侧输入框。 */
  readonly onAskAboutSelection?: (selectionText: string) => void;
  /** 新书起步按钮：把半句话填进右侧输入框（不发送）。 */
  readonly onFillComposer?: (text: string) => void;
  /** 新书首屏三步看的设定本：有哪些卡、故事设定填没填。 */
  readonly starter?: { readonly cardNames: readonly string[]; readonly storyFilled: boolean };
  /** 按章号打开一章（已定稿时工具条的「去第 N 章」）。 */
  readonly onOpenChapter?: (chapter: number) => void;
  /** 回原句：打开那一章、滚到这句（写前备忘里点线索、状态）。 */
  readonly onJumpToQuote?: (chapter: number, quote: string) => void;
}) {
  const [activeTab, setActiveTab] = useState<"draft" | "committed">("draft");
  // 正文字号已上提到 displaySettingsStore（设置面板统一调）；底部旧 A-/A+ 步进器已撤。
  const paperFontSize = useDisplaySettingsStore((s) => s.deskFontSize);
  const draft = useDraftPreview({ chapterNumber: props.workspace.currentChapter.chapterNumber, title: props.workspace.currentChapter.title });
  const committedBody = useDraftStore((state) => state.committed?.body ?? "");
  const draftCandidates = useUiStore((state) => state.draftCandidates);
  const draftActionLoading = useUiStore((state) => state.draftActionLoading);
  const workspaceBusy = Boolean(
    props.chatLoading
    || draftActionLoading
    || isWorkspaceBusy(),
  );
  const rerolling = draftActionLoading === "reroll-candidates";
  const applyingCandidate = draftActionLoading === "apply-candidate";
  const canReroll = draft.status !== "committed" && Boolean(props.onReroll) && !workspaceBusy;
  const draftWordCount = draft.wordCount ?? 0;
  // 「作者写、AI 管账」：新书首屏第一个按钮是「自己动笔写」——点了直接出稿纸（2026-10-10 验收：新书原先只有三个让 AI 写的按钮，作者没地方下笔）。
  const [authorStarted, setAuthorStarted] = useState(false);
  // AI 出了走法、或正在出稿，就收起引导：走法挂在稿纸上方、拟纲进度写在稿纸里，引导盖着作者就看不到
  // （2026-10-23 从零走查：AI 说「在稿纸上方挑」，稿纸上还是「从一句话开始」）。
  const chapterDirections = useChapterDirections(draft.chapterNumber);
  const generatingDraft = useBookStore((s) => s.workspace.flowStatus === "draft_generating");
  const showStarter = isStarterEmptyWorkspace({ draft, chapters: props.workspace.chapters })
    && !authorStarted && !chapterDirections && !generatingDraft;
  // 「自己动笔写」：收起引导、光标直接落进稿纸（不然还得再找地方点一下）。
  function startWriting() {
    setAuthorStarted(true);
    window.setTimeout(() => document.querySelector<HTMLElement>(".codex-app .se-v2-draft-editor")?.focus(), 60);
  }
  const steps = starterSteps({ chapter: draft.chapterNumber, cardNames: props.starter?.cardNames ?? [], storyFilled: props.starter?.storyFilled ?? false });
  const storyDone = steps[0]!.done;
  // 首屏点了「出几种走法」：想的这一两分钟按钮上说在想，走法一到引导就收起（见上面 showStarter）。
  const [askedDirections, setAskedDirections] = useState(false);
  useEffect(() => {
    if (!workspaceBusy) setAskedDirections(false);
  }, [workspaceBusy]);
  const paperDraft = draft;
  const showEditHint = activeTab === "draft" && draft.status !== "committed" && draft.streaming !== true;
  const targetWords = targetChapterWordsOf(props.overview);
  // 这一章还差什么（工具条和右栏顶卡同源）+ 这一章最新的核账结果（稿纸划线）。
  const progress = useChapterProgress(targetWords);
  const continuityResult = useContinuityResult(draft.chapterNumber);
  const goalPct = targetWords ? Math.min(100, Math.round((draftWordCount / targetWords) * 100)) : 0;
  // 低于目标 78%（≈「最少」口径）提醒橙，达标绿，其余强调色。
  const goalTone = !targetWords ? "" : draftWordCount >= targetWords ? "met" : draftWordCount < targetWords * 0.78 ? "low" : "";
  // 本章梗概：取时间线里本章的主事件（只有最近几章有），没有就不显示。
  const synopsisEvent = props.overview?.timeline?.recentEvents?.find((event) => event.chapter === draft.chapterNumber);
  const synopsis = (synopsisEvent?.mainEvent || synopsisEvent?.summary || "").trim();
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
      {/* 顶部细条：章号标题 + 字数 + 工作稿/定稿 切换（书名在全局顶栏；专注写作开关也在顶栏）。 */}
      <header className="codex-desk-bar codex-desk-bar-top">
        <div className="cd-title">
          <ChapterTitle
            chapterNumber={draft.chapterNumber}
            title={draft.title}
            editable={(showEditHint || (draft.status === "committed" && draft.streaming !== true)) && !workspaceBusy}
            onRename={(title) => (draft.status === "committed"
              ? void renameCommittedChapter(draft.chapterNumber, title)
              : renameChapter(draft.chapterNumber, title))}
          />
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
          <ChapterSynopsis
            key={draft.chapterNumber}
            chapter={draft.chapterNumber}
            text={synopsis}
            busy={workspaceBusy}
            {...(props.onSendUserAction ? { onAction: props.onSendUserAction } : {})}
          />
        ) : !showStarter && activeTab === "draft" && draft.status !== "committed" ? (
          <PreWriteMemo
            projectPath={props.projectPath ?? undefined}
            chapter={draft.chapterNumber}
            refreshKey={props.overview}
            busy={workspaceBusy}
            {...(props.onJumpToQuote ? { onJump: props.onJumpToQuote } : {})}
          />
        ) : null}
      </header>

      {/* 中间：稿纸"浮"在暗场里。草稿走 WritingPaper（完整编辑器内核），正文走只读段落（照 WritingDesk）。 */}
      <div className="codex-desk-stage" ref={stageRef}>
        {activeTab === "draft" ? (
          showStarter ? (
            <div className="cd-starter" aria-label="新书起步引导">
              <span className="cd-starter-mark" aria-hidden="true"><IconPencil size={22} /></span>
              <h2 className="cd-starter-title">从一句话开始</h2>
              <ol className="cd-starter-steps" aria-label="开书三步">
                {steps.map((step, index) => (
                  <li key={step.key} className={step.done ? "is-done" : ""}>
                    <span className="cd-starter-step-mark" aria-hidden="true">{step.done ? "✓" : index + 1}</span>
                    <b>{step.label}</b>
                    <span>{step.hint}</span>
                  </li>
                ))}
              </ol>
              <div className="cd-starter-actions" role="group" aria-label="起步意图">
                <button type="button" className="cd-starter-btn" onClick={startWriting}>
                  自己动笔写
                </button>
                {storyDone ? (
                  <>
                    {/* 故事说过了：下一步是这一章往哪走（和稿纸上方「给我几种走法」同一个动作），或者直接让 AI 起草。 */}
                    <button
                      type="button"
                      className="cd-starter-btn is-ghost"
                      disabled={!props.onSendUserAction || workspaceBusy}
                      onClick={() => {
                        setAskedDirections(true);
                        props.onSendUserAction?.({ toolName: "brainstorm_chapter", chapter: draft.chapterNumber });
                      }}
                    >
                      {askedDirections && workspaceBusy ? "AI 在想几种走法，要一两分钟……" : "给我几种走法"}
                    </button>
                    {askedDirections && workspaceBusy ? null : (
                      <button
                        type="button"
                        className="cd-starter-btn is-ghost"
                        disabled={!props.onChapterButton || workspaceBusy}
                        onClick={() => props.onChapterButton?.("write")}
                      >
                        AI 写这一章
                      </button>
                    )}
                  </>
                ) : STARTER_INTENTS.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    className="cd-starter-btn is-ghost"
                    disabled={!props.onFillComposer}
                    onClick={() => props.onFillComposer?.(item.prefill)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <>
            <PaperIncomingBanner />
            {/* 头脑风暴：空章问「往哪走」、给几种走法挑；挑中后收成一条「这章打算」（见 Brainstorm）。 */}
            <BrainstormPanel
              chapter={draft.chapterNumber}
              draftEmpty={!draft.content.trim()}
              hidden={draft.status === "committed" || draft.streaming === true}
              busy={workspaceBusy}
              {...(props.onSendUserAction ? { onAction: props.onSendUserAction } : {})}
            />
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
                    {props.onChapterButton ? (
                      <button
                        type="button"
                        className="cd-committed-secondary"
                        disabled={workspaceBusy || draftWordCount <= 0}
                        // 结构化动作（和稿纸底下的「定稿」同一个）：以前发一句「生成定稿预览」给模型，
                        // 模型照抄前文回「预览好了，清单打开着」却没调工具（2026-10-19 试写）。
                        onClick={() => props.onChapterButton?.("commit_preview")}
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
        {/* 名字速览：正文里的人物名画虚下划线，鼠标停上去弹出人物卡（不碰编辑器内核，见 NamePeek）。 */}
        {!showStarter ? (
          <NamePeek
            stageRef={stageRef}
            cards={props.peekCards ?? []}
            contentKey={`${draft.chapterNumber}:${activeTab}`}
            onOpenCharacter={props.onOpenCharacter}
          />
        ) : null}
        {/* 核账问题画在原句下面，点开对照前文原句（不碰编辑器内核，见 ContinuityMarks）。 */}
        {!showStarter && activeTab === "draft" ? (
          <ContinuityMarks
            stageRef={stageRef}
            result={continuityResult}
            contentKey={`${draft.chapterNumber}`}
            busy={workspaceBusy}
            {...(props.onSendMessage ? { onRevise: props.onSendMessage } : {})}
            {...(props.onSendUserAction ? { onFixAction: props.onSendUserAction } : {})}
          />
        ) : null}
        {/* 从伏笔看板点原句回来：滚到这句、短暂标亮（见 QuoteJump）。 */}
        {!showStarter ? (
          <QuoteJumpMarker
            stageRef={stageRef}
            chapter={draft.chapterNumber}
            contentKey={`${draft.chapterNumber}:${activeTab}:${draft.content.length}`}
            showingCommitted={activeTab === "committed"}
            canShowCommitted={committedBody.trim().length > 0}
            onShowCommitted={() => setActiveTab("committed")}
          />
        ) : null}
      </div>

      {/* 底部：上一章 / 本章动作（核账状态 + 核账 / 定稿，专注模式也在）/ 下一章。 */}
      {!showStarter ? (
      <footer className="codex-desk-bar codex-desk-bar-bottom">
        {prevChapter ? (
          <button className="cd-nav prev" type="button" disabled={workspaceBusy} onClick={() => goToChapter(prevChapter.id)} title="上一章">
            <span>上一章</span>{chapterHeading(prevChapter.chapterNumber, prevChapter.title ?? "")}
          </button>
        ) : <span />}
        {activeTab === "draft" ? (
          <PaperToolbar
            progress={progress}
            busy={workspaceBusy || draft.streaming === true}
            onChapterButton={props.onChapterButton}
            {...(props.onOpenChapter ? { onOpenChapter: props.onOpenChapter } : {})}
            {...(canReroll && draft.content.trim() ? {
              reroll: {
                label: "AI 另写几版",
                running: rerolling,
                onClick: () => props.onReroll?.(),
                title: "会保留当前版本，再生成 2–3 个候选版本供你挑选",
              },
            } : {})}
          />
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
