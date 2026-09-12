import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import type { Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import type { DraftPreview } from "../../types.js";
import { uiText } from "./v2Utils.js";
import { decideExternalDraftSync, draftTextToHtml } from "./draftEditorSync.js";
import SelectionToolbar from "./SelectionToolbar.js";
import type { SelectionRevisionKey } from "./selectionRevisionTemplates.js";
import FindReplacePanel from "./FindReplacePanel.js";
import {
  collectDocMatches,
  findInEditor,
  replaceAllInEditor,
  replaceCurrentInEditor,
  type FindResult,
} from "./findReplace.js";
import { FindHighlight, clearFindHighlight, setFindHighlight } from "./findHighlight.js";
import { RevisionHighlight, setRevisionHighlight as applyRevisionHighlight, clearRevisionHighlight } from "./revisionHighlight.js";
import { SentenceFocus } from "./sentenceFocusPlugin.js";
import { typewriterScrollTop } from "./sentenceFocus.js";
import { useWorkspaceStore } from "../../stores/workspaceStore.js";

const BLOCK_SEPARATOR = "\n\n";
const TOOLBAR_GAP = 44;
const TOOLBAR_WIDTH = 240;

export default function WritingPaper({ draft, fontSize = 18, onEdit, onSelectionRewrite, onSelectionRewriteCustom }: {
  readonly draft: DraftPreview;
  readonly fontSize?: number;
  readonly onEdit?: (content: string) => void;
  readonly onSelectionRewrite?: (selectionText: string, key: SelectionRevisionKey) => Promise<void>;
  readonly onSelectionRewriteCustom?: (selectionText: string, instruction: string) => Promise<void>;
}) {
  const paperStyle = {
    "--se-v2-paper-font-size": `${fontSize}px`,
  } as CSSProperties & Record<"--se-v2-paper-font-size", string>;

  if (onEdit) {
    return <EditablePaper draft={draft} onEdit={onEdit} paperStyle={paperStyle} onSelectionRewrite={onSelectionRewrite} onSelectionRewriteCustom={onSelectionRewriteCustom} />;
  }

  const rawContent = draft.content;
  const body = normalizeBody(rawContent);
  return (
    <section className="se-v2-writing-canvas">
      <div className="se-v2-editor-wrap se-v2-paper" style={paperStyle}>
        {body ? (
          <>
            <h1 className="se-v2-paper-title">{normalizeTitle(draft.title, rawContent)}</h1>
            <div className="se-v2-editor-text">{body}</div>
          </>
        ) : (
          <div className="se-v2-editor-empty">
            <h2>当前章节还没有工作稿</h2>
            <p>你可以在右侧让 AI 生成工作稿。</p>
          </div>
        )}
      </div>
    </section>
  );
}

function EditablePaper({ draft, onEdit, paperStyle, onSelectionRewrite, onSelectionRewriteCustom }: {
  readonly draft: DraftPreview;
  readonly onEdit: (content: string) => void;
  readonly paperStyle: CSSProperties;
  readonly onSelectionRewrite?: (selectionText: string, key: SelectionRevisionKey) => Promise<void>;
  readonly onSelectionRewriteCustom?: (selectionText: string, instruction: string) => Promise<void>;
}) {
  const isCommitted = draft.status === "committed";
  // 「刚改片段」黄高亮的定位锚（=改写后的新文本，可多处）。从 store 读，classic 壳从不设它＝恒空＝无副作用。
  const revisionHighlightTexts = useWorkspaceStore((s) => s.revisionHighlightTexts);
  // 最近一次与编辑器同步过的「外部草稿内容」基准（首次为 null，用编辑器归一化后的初值兜底）。
  const lastExternal = useRef<string | null>(null);
  // 记上次同步的章号：换章时强制硬加载新章正文，不被「保留本地脏编辑」挡住（治切章点两下还显示上一章）。
  const lastChapterRef = useRef<number | null>(null);
  const onEditRef = useRef(onEdit);
  onEditRef.current = onEdit;
  // L2：用户正用输入法组字时 AI 恰好出稿落地——此刻 setContent 会被组字结束反写覆盖。
  // pendingExternal 暂存这版外部稿、suppressUpdate 抑制组字回写（防污染 draft.content），待 compositionend 再统一应用。
  const pendingExternalRef = useRef<string | null>(null);
  const suppressUpdateRef = useRef(false);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const [selection, setSelection] = useState<{ readonly text: string; readonly top: number; readonly left: number } | null>(null);
  const [busyKey, setBusyKey] = useState<SelectionRevisionKey | null>(null);
  const canRewrite = Boolean(onSelectionRewrite) && !isCommitted;

  // 查找替换（块④）：当前匹配靠编辑器选区原生高亮；这里只持有面板状态、调 findReplace。
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [matchInfo, setMatchInfo] = useState<FindResult>({ current: 0, total: 0 });

  // 选区变化时算出浮动条该不该出、出在哪。coordsAtPos / getBoundingClientRect 是浏览器能力，
  // jsdom 下会抛——try/catch 兜住，失败就不显示（真实定位交真机）。
  const refreshSelection = useCallback((instance: Editor) => {
    // 查找替换开着时不出选区浮动条——否则查找导航选中匹配会误触发块②的润色条。
    if (!canRewrite || findOpen) { setSelection(null); return; }
    const { from, to, empty } = instance.state.selection;
    if (empty) { setSelection(null); return; }
    // leafText 必须用 "\n" 与 draft.content 的 getText 对齐：Tiptap 的 hardBreak（段内单换行 → <br>）
    // 在 getText 里序列化成 "\n"，若这里用 " " 则选区跨段内换行时与 draft.content 不匹配、revision 路由 400。
    const text = instance.state.doc.textBetween(from, to, BLOCK_SEPARATOR, "\n");
    const host = hostRef.current;
    if (!text.trim() || !host) { setSelection(null); return; }
    try {
      const start = instance.view.coordsAtPos(from);
      const hostRect = host.getBoundingClientRect();
      const top = Math.max(0, start.top - hostRect.top - TOOLBAR_GAP);
      const left = Math.max(0, Math.min(start.left - hostRect.left, host.clientWidth - TOOLBAR_WIDTH));
      setSelection({ text, top, left });
    } catch {
      setSelection(null);
    }
  }, [canRewrite, findOpen]);
  const refreshSelectionRef = useRef(refreshSelection);
  refreshSelectionRef.current = refreshSelection;
  // 浮动操作条只在「选区定下来（松开鼠标）」后出现，而非拖选过程中边拖边冒/抖。
  const pointerSelectingRef = useRef(false);

  const editor = useEditor({
    // 纯文本纸面：关掉 StarterKit 的标题/列表/引用/代码/分隔线与加粗斜体等输入规则，
    // 否则用户在行首敲「# 」会被转成 <h1>、getText 吞掉「#」前缀，破坏 extractDraftTitle 的标题识别契约。
    extensions: [
      StarterKit.configure({
        heading: false,
        bulletList: false,
        orderedList: false,
        blockquote: false,
        codeBlock: false,
        horizontalRule: false,
        bold: false,
        italic: false,
        strike: false,
        code: false,
      }),
      FindHighlight,
      RevisionHighlight,
      SentenceFocus,
    ],
    content: draftTextToHtml(draft.content),
    editable: !isCommitted,
    immediatelyRender: true,
    editorProps: {
      attributes: { class: "se-v2-draft-editor", spellcheck: "false" },
      handleDOMEvents: {
        // 鼠标在正文里按下=开始拖选：先收起浮动条，等松手（document mouseup）选区定型后再弹。
        // 只在可编辑区触发，不含浮动条本身，故不影响「点工具条按钮」。
        mousedown: () => { pointerSelectingRef.current = true; setSelection(null); return false; },
      },
    },
    onUpdate: ({ editor: instance }) => {
      // L2：被 AI 出稿抢占的组字期，忽略组字回写——否则组字结束的 onUpdate 会把组字文本写进 draft.content、
      // 污染掉刚到的 AI 稿。compositionend 时再统一应用 AI 稿。
      if (suppressUpdateRef.current) return;
      // 换章窗口：编辑器里还残留着上一章正文（lastChapterRef 还没被外部同步 effect 推进到当前章），
      // 此刻的 onUpdate 是「旧章内容」，绝不能把它回写进新章的 draft.content——否则把上一章正文写进下一章、
      // 同步 effect 再把它装回编辑器（=切章还显示上一章），且 centerCaret 会滚到上一章光标（=跑到上一章最底下）。
      // 直接忽略，交给外部同步 effect 把新章内容装进来。
      if (lastChapterRef.current !== draft.chapterNumber) return;
      // 打字即进入聚焦模式：让 CSS 把当前句之外淡化（句级淡化 class 由 SentenceFocus 插件常挂，
      // 真正"是否淡"由 host 上的 is-focus-mode 开关控制）。
      setFocusMode(instance, true);
      // 打字机居中：只在「打字」（onUpdate）时把 caret 锁到视口 ~45%。纯光标移动/翻看旧文走
      // onSelectionUpdate、不进这里，故不会被拽回（满足"翻看旧文不被拽"）。
      centerCaret(instance, hostRef.current);
      // 真人编辑就撤掉「刚改片段」黄高亮（onUpdate 只对真人输入触发——AI 应用走 setContent emitUpdate:false 不进这里）。
      if (useWorkspaceStore.getState().revisionHighlightTexts.length > 0) {
        useWorkspaceStore.getState().setRevisionHighlight(null);
      }
      onEditRef.current(instance.getText({ blockSeparator: BLOCK_SEPARATOR }));
    },
    onSelectionUpdate: ({ editor: instance }) => {
      // 拖选区（非空选区）时退出聚焦模式，避免选文时正文整片变暗干扰；折叠光标（打字/移动）保持当前模式。
      if (!instance.state.selection.empty) setFocusMode(instance, false);
      if (pointerSelectingRef.current) return; // 鼠标拖选过程中先不弹浮动条，等松手再弹
      refreshSelectionRef.current(instance);
    },
    onBlur: () => setSelection(null),
  });

  useEffect(() => {
    editor?.setEditable(!isCommitted);
  }, [editor, isCommitted]);

  // 鼠标松开 = 选区定型 → 此刻才弹浮动条（拖选过程中先不弹）。挂 document 级以兼容「拖出编辑器外松手」。
  useEffect(() => {
    const onPointerUp = () => {
      if (!pointerSelectingRef.current) return;
      pointerSelectingRef.current = false;
      if (editor) refreshSelectionRef.current(editor);
    };
    document.addEventListener("mouseup", onPointerUp);
    return () => document.removeEventListener("mouseup", onPointerUp);
  }, [editor]);

  // 外部草稿内容（AI 流式 / 归档结果 / 撤销 / 选区改写应用）到来：按纯逻辑决定接受还是保留用户编辑。
  // 基准存编辑器 getText 回读值而非原始 incoming——ProseMirror 会裁段落首尾空白，存原始值会让流式
  // token 边界一带空格就把后续 delta 全误判成脏编辑、编辑器冻结。
  useEffect(() => {
    if (!editor) return;
    const editorText = editor.getText({ blockSeparator: BLOCK_SEPARATOR });
    if (lastExternal.current === null) {
      lastExternal.current = editorText;
      lastChapterRef.current = draft.chapterNumber;
      return;
    }
    const chapterChanged = lastChapterRef.current !== draft.chapterNumber;
    lastChapterRef.current = draft.chapterNumber;
    const { action } = decideExternalDraftSync({
      incoming: draft.content,
      editorText,
      lastExternal: lastExternal.current,
      chapterChanged,
    });
    if (action === "set") {
      // L2：正在用输入法组字时不能立刻 setContent（会被组字结束反写覆盖）；暂存这版稿、抑制组字回写，
      // 待 compositionend 再应用。editor.view.composing=ProseMirror 的 IME 组字态。
      if (editor.view.composing) {
        pendingExternalRef.current = draft.content;
        suppressUpdateRef.current = true;
        return;
      }
      editor.commands.setContent(draftTextToHtml(draft.content), { emitUpdate: false });
      lastExternal.current = editor.getText({ blockSeparator: BLOCK_SEPARATOR });
      setSelection(null);
    } else if (action === "realign") {
      lastExternal.current = editorText;
    }
  }, [editor, draft.content, draft.chapterNumber]);

  // 「刚改片段」黄高亮：应用一次选区改写/「改掉这句」后，store 里落下改写后的新文本（revisionHighlightText）。
  // 在正文里定位它（取首个唯一匹配）→ 高亮；定位不到（跨段/被裁空白/不唯一首个仍取）→ 静默不高亮、不报错。
  // 依赖含 draft.content：AI 应用后内容与高亮锚同帧到来，本 effect 排在外部同步之后，确保新内容已落再定位。
  useEffect(() => {
    if (!editor) return;
    if (revisionHighlightTexts.length === 0) { clearRevisionHighlight(editor); return; }
    // 逐条在正文里定位（取首个唯一匹配）；定位不到的静默跳过。一键全修一次落多处高亮。
    const ranges = revisionHighlightTexts
      .map((t) => collectDocMatches(editor.state.doc, t, true)[0])
      .filter((m): m is NonNullable<typeof m> => Boolean(m));
    if (ranges.length === 0) { clearRevisionHighlight(editor); return; }
    applyRevisionHighlight(editor, ranges);
    // 跳转到第一处改动：把改动处所在的 DOM 节点滚进视口中央，让用户一眼看到「改在哪」（修 Codex P1「改完不跳转」）。
    const first = ranges.reduce((a, b) => (a.from <= b.from ? a : b));
    try {
      const domAt = editor.view.domAtPos(first.from);
      const node = domAt?.node;
      const el = node instanceof HTMLElement ? node : node?.parentElement ?? null;
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
    } catch { /* 定位/滚动失败不影响高亮本身 */ }
  }, [editor, revisionHighlightTexts, draft.content]);

  // L2：组字结束后统一应用被暂存的外部稿（AI 出稿）——组字期被抑制了回写，draft.content 仍是 AI 稿，
  // 这里把它真正写进编辑器、并把基准对齐，避免后续 sync 又把组字残文当外部变更写回。
  useEffect(() => {
    if (!editor) return undefined;
    const dom = editor.view.dom;
    const onCompositionEnd = () => {
      const pending = pendingExternalRef.current;
      suppressUpdateRef.current = false;
      if (pending === null) return;
      pendingExternalRef.current = null;
      editor.commands.setContent(draftTextToHtml(pending), { emitUpdate: false });
      lastExternal.current = editor.getText({ blockSeparator: BLOCK_SEPARATOR });
      setSelection(null);
    };
    dom.addEventListener("compositionend", onCompositionEnd);
    return () => dom.removeEventListener("compositionend", onCompositionEnd);
  }, [editor]);

  // 查找替换操作：query/大小写变化重算总数 + 高亮所有匹配（不移动选区）；下一个/上一个才导航 + 高亮当前。
  const recountMatches = useCallback((nextQuery: string, nextCase: boolean) => {
    if (!editor) { setMatchInfo({ current: 0, total: 0 }); return; }
    const matches = collectDocMatches(editor.state.doc, nextQuery, nextCase);
    setMatchInfo({ current: 0, total: matches.length });
    setFindHighlight(editor, matches, null);
  }, [editor]);
  const handleCloseFind = useCallback(() => {
    setFindOpen(false);
    setMatchInfo({ current: 0, total: 0 });
    if (editor) clearFindHighlight(editor);
  }, [editor]);

  // Ctrl/Cmd+F 唤出查找替换（按现有 query 重算+高亮，修关闭重开计数丢失）；
  // Esc：面板开着时【始终关闭面板】（含替换后焦点回编辑器的场景），未开时才「不丢稿地回退草稿」。
  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.metaKey || event.ctrlKey) && (event.key === "f" || event.key === "F")) {
      event.preventDefault();
      setFindOpen(true);
      recountMatches(findQuery, caseSensitive);
      return;
    }
    if (event.key !== "Escape") return;
    if (findOpen) {
      event.preventDefault();
      handleCloseFind();
      return;
    }
    if (!editor) return;
    editor.commands.setContent(draftTextToHtml(draft.content), { emitUpdate: false });
    lastExternal.current = editor.getText({ blockSeparator: BLOCK_SEPARATOR });
    setSelection(null);
  }, [editor, draft.content, findOpen, findQuery, caseSensitive, recountMatches, handleCloseFind]);
  const handleFindQueryChange = useCallback((value: string) => {
    setFindQuery(value);
    recountMatches(value, caseSensitive);
  }, [recountMatches, caseSensitive]);
  const handleToggleCase = useCallback(() => {
    setCaseSensitive((prev) => {
      const next = !prev;
      recountMatches(findQuery, next);
      return next;
    });
  }, [recountMatches, findQuery]);
  const handleFind = useCallback((direction: "next" | "prev") => {
    if (editor && findQuery) setMatchInfo(findInEditor(editor, findQuery, caseSensitive, direction));
  }, [editor, findQuery, caseSensitive]);
  const handleReplaceCurrent = useCallback(() => {
    if (!editor || !findQuery) return;
    replaceCurrentInEditor(editor, findQuery, replaceText, caseSensitive);
    recountMatches(findQuery, caseSensitive);
  }, [editor, findQuery, replaceText, caseSensitive, recountMatches]);
  const handleReplaceAll = useCallback(() => {
    if (!editor || !findQuery) return;
    replaceAllInEditor(editor, findQuery, replaceText, caseSensitive);
    recountMatches(findQuery, caseSensitive);
  }, [editor, findQuery, replaceText, caseSensitive, recountMatches]);

  const handlePick = useCallback(async (key: SelectionRevisionKey) => {
    if (!onSelectionRewrite || !selection || busyKey) return;
    setBusyKey(key);
    try {
      await onSelectionRewrite(selection.text, key);
    } finally {
      setBusyKey(null);
      setSelection(null);
    }
  }, [onSelectionRewrite, selection, busyKey]);

  // 「✎ 自己说」：用户在浮动条里输入要求 → 用 custom 模板按要求改写选中段（与 handlePick 同路、同 busy 态）。
  const handlePickCustom = useCallback(async (instruction: string) => {
    if (!onSelectionRewriteCustom || !selection || busyKey) return;
    setBusyKey("custom");
    try {
      await onSelectionRewriteCustom(selection.text, instruction);
    } finally {
      setBusyKey(null);
      setSelection(null);
    }
  }, [onSelectionRewriteCustom, selection, busyKey]);

  const isEmpty = !draft.content.trim();

  return (
    <section className="se-v2-writing-canvas">
      {findOpen ? (
        <FindReplacePanel
          query={findQuery}
          replaceText={replaceText}
          caseSensitive={caseSensitive}
          matchInfo={matchInfo}
          onQueryChange={handleFindQueryChange}
          onReplaceChange={setReplaceText}
          onToggleCase={handleToggleCase}
          onFindPrev={() => handleFind("prev")}
          onFindNext={() => handleFind("next")}
          onReplaceCurrent={handleReplaceCurrent}
          onReplaceAll={handleReplaceAll}
          onClose={handleCloseFind}
        />
      ) : null}
      <div className="se-v2-editor-wrap se-v2-paper se-v2-paper-editable" style={paperStyle} onKeyDown={handleKeyDown}>
        {isCommitted ? (
          <article className="se-v2-notice">
            <p>本章已定稿，内容以定稿版为准。如需修改请通过 AI 助手发起修改。</p>
          </article>
        ) : null}
        <div className="se-v2-draft-editor-host" ref={hostRef}>
          <EditorContent editor={editor} />
          {isEmpty && !isCommitted ? (
            <p className="se-v2-draft-editor-hint" aria-hidden="true">
              当前章节还没有工作稿。你可以在这里手动输入，也可以在右侧让 AI 生成工作稿。
            </p>
          ) : null}
          {canRewrite && selection ? (
            <SelectionToolbar top={selection.top} left={selection.left} busyKey={busyKey} onPick={handlePick} onPickCustom={handlePickCustom} />
          ) : null}
        </div>
      </div>
    </section>
  );
}

/** 在编辑器宿主元素（.se-v2-draft-editor）上开关 is-focus-mode：句级聚焦的"是否淡化"总开关。 */
function setFocusMode(instance: Editor, on: boolean): void {
  instance.view.dom.classList.toggle("is-focus-mode", on);
}

/**
 * 打字机居中滚动：把 caret 在滚动容器 `.se-v2-writing-canvas` 里锁到视口 ~45%（typewriterScrollTop）。
 * coordsAtPos / getBoundingClientRect / scrollTo 都是浏览器能力，jsdom 下会抛——try/catch 兜住、失败即不滚
 *（真实滚动交真机，沿用 refreshSelection 的兜底惯例）。reduced-motion 下用 "auto" 瞬切不平滑动。
 */
function centerCaret(instance: Editor, host: HTMLElement | null): void {
  const canvas = host?.closest(".se-v2-writing-canvas") as HTMLElement | null;
  if (!canvas) return;
  try {
    const caret = instance.view.coordsAtPos(instance.state.selection.head);
    const caretTop = caret.top - canvas.getBoundingClientRect().top + canvas.scrollTop;
    const top = typewriterScrollTop({ caretTop, viewportHeight: canvas.clientHeight });
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    canvas.scrollTo({ top, behavior: reduce ? "auto" : "smooth" });
  } catch {
    /* jsdom / 无布局信息：跳过居中滚动 */
  }
}

function normalizeBody(content: string): string {
  return uiText(content.replace(/^# .*(?:\r?\n){1,2}/u, "").trim(), "");
}

function normalizeTitle(title: string, content: string): string {
  const markdownTitle = content.split(/\r?\n/u).find((line) => line.trim().startsWith("#"))?.replace(/^#+\s*/u, "").trim();
  return uiText(markdownTitle || title, "未命名章节");
}
