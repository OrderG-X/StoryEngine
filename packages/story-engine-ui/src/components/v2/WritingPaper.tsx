import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import type { Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import type { DraftPreview } from "../../types.js";
import { uiText } from "./v2Utils.js";
import { decideExternalDraftSync, draftTextToHtml } from "./draftEditorSync.js";
import SelectionToolbar from "./SelectionToolbar.js";
import { sentenceSpan } from "./sentenceSnap.js";
import { setSnapPreview, SNAP_PREVIEW_KEY, SnapPreview } from "./snapPreview.js";
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
import { useBookStore } from "../../stores/bookStore.js";
import { useUiStore } from "../../stores/uiStore.js";
import { scrollBehavior } from "../../stores/motionStore.js";

const BLOCK_SEPARATOR = "\n\n";
const TOOLBAR_GAP = 44;
// 浮动条宽度上限（定位时防右侧溢出）：完整一排 8 个按钮约 490px；定稿章节只有「问 AI」一个钮。
const TOOLBAR_WIDTH = 500;
const ASK_ONLY_TOOLBAR_WIDTH = 80;

export default function WritingPaper({ draft, fontSize = 18, onEdit, onSelectionRewrite, onSelectionRewriteCustom, onAskAboutSelection }: {
  readonly draft: DraftPreview;
  readonly fontSize?: number;
  readonly onEdit?: (content: string) => void;
  readonly onSelectionRewrite?: (selectionText: string, key: SelectionRevisionKey) => Promise<void>;
  readonly onSelectionRewriteCustom?: (selectionText: string, instruction: string) => Promise<void>;
  /** 选区浮动条「问 AI」：把选中文字交给外层（引用进对话输入框），不改稿。 */
  readonly onAskAboutSelection?: (selectionText: string) => void;
}) {
  const paperStyle = {
    "--se-v2-paper-font-size": `${fontSize}px`,
  } as CSSProperties & Record<"--se-v2-paper-font-size", string>;

  if (onEdit) {
    return <EditablePaper draft={draft} onEdit={onEdit} paperStyle={paperStyle} onSelectionRewrite={onSelectionRewrite} onSelectionRewriteCustom={onSelectionRewriteCustom} onAskAboutSelection={onAskAboutSelection} />;
  }

  // 稿纸上是拆开的稿：正文原样显示（开头的「# 某某」也是正文），章名就是 draft.title。
  const body = uiText(draft.content.trim(), "");
  return (
    <section className="se-v2-writing-canvas">
      <div className="se-v2-editor-wrap se-v2-paper" style={paperStyle}>
        {body ? (
          <>
            <h1 className="se-v2-paper-title">{uiText(draft.title, "未命名章节")}</h1>
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

/**
 * 把编辑器选区两端各自对齐到所在段落里的句子边界。段落文字用 textBetween(leafText="\n") 取，
 * 每个字符/换行正好占一个文档位置，偏移量可以直接加回段落起点。
 */
function snapToSentences(instance: Editor, from: number, to: number): { from: number; to: number } | null {
  try {
    const { doc } = instance.state;
    const $from = doc.resolve(from);
    const $to = doc.resolve(to);
    if (!$from.parent.isTextblock || !$to.parent.isTextblock) return null;
    const fromStart = $from.start();
    const fromText = doc.textBetween(fromStart, $from.end(), "\n", "\n");
    const toStart = $to.start();
    const toText = doc.textBetween(toStart, $to.end(), "\n", "\n");
    const fromOffset = from - fromStart;
    const toOffset = to - toStart;
    // 选区刚好停在段首/段尾（如三击选整段）就不往旁边段落里扩。
    const nextFrom = fromOffset >= fromText.length ? from : fromStart + sentenceSpan(fromText, fromOffset, fromOffset).start;
    const nextTo = toOffset === 0 ? to : toStart + sentenceSpan(toText, toOffset, toOffset).end;
    return nextFrom < nextTo ? { from: nextFrom, to: nextTo } : null;
  } catch {
    return null;
  }
}

function EditablePaper({ draft, onEdit, paperStyle, onSelectionRewrite, onSelectionRewriteCustom, onAskAboutSelection }: {
  readonly draft: DraftPreview;
  readonly onEdit: (content: string) => void;
  readonly paperStyle: CSSProperties;
  readonly onSelectionRewrite?: (selectionText: string, key: SelectionRevisionKey) => Promise<void>;
  readonly onSelectionRewriteCustom?: (selectionText: string, instruction: string) => Promise<void>;
  readonly onAskAboutSelection?: (selectionText: string) => void;
}) {
  const isCommitted = draft.status === "committed";
  // 定稿的章默认锁着防手滑；作者点「自己改这章」才解开这一章（2026-10-22 对标走查：导入的书整本是定稿，
  // 没接 AI 时连错字都改不了）。打了字就成了「定稿后又改过」，不再算定稿，自然一直能改。
  const [unlockedChapter, setUnlockedChapter] = useState<number | null>(null);
  const authorUnlocked = isCommitted && unlockedChapter === draft.chapterNumber;
  const focusAfterUnlockRef = useRef(false);
  // 改完又定稿了（不是定稿→定稿）：重新锁上，提示换回「定稿了」（真模型走查：再定稿后还写着「改吧」）。
  const wasCommittedRef = useRef(isCommitted);
  useEffect(() => {
    if (isCommitted && !wasCommittedRef.current) setUnlockedChapter(null);
    wasCommittedRef.current = isCommitted;
  }, [isCommitted]);
  // AI 正在流式出稿：稿纸只读显示流出来的字，作者这时打的字不会混进去（重构 P5）。
  const locked = (isCommitted && !authorUnlocked) || draft.streaming === true;
  // 「刚改片段」黄高亮的定位锚（=改写后的新文本，可多处）。从 store 读，classic 壳从不设它＝恒空＝无副作用。
  const revisionHighlightTexts = useUiStore((s) => s.revisionHighlightTexts);
  // AI 出稿中：稿纸空着时说清 AI 在干什么（拟章纲要一两分钟），别显示「你可以在这里手动输入」。
  const draftPhase = useUiStore((s) => s.draftPhase);
  const generating = useBookStore((s) => s.workspace.flowStatus === "draft_generating");
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
  const canRewrite = Boolean(onSelectionRewrite) && !locked;
  // 定稿后不能就地改写，但仍可选中一段「问 AI」（不改稿）——浮动条只剩这一个按钮。
  const canAsk = Boolean(onAskAboutSelection);

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
    if (!(canRewrite || canAsk) || findOpen) { setSnapPreview(instance, null); setSelection(null); return; }
    const { from: rawFrom, to: rawTo, empty } = instance.state.selection;
    if (empty) { setSnapPreview(instance, null); setSelection(null); return; }
    // 能改写时改写的文字对齐到整句（见 sentenceSnap.ts）：只选半句去润色，模型会补全句子，应用后后半句重复。
    // 编辑器选区不动（作者选几个字打字替换，不能一下吞掉整句），会被改的整句另用底纹标出来（snapPreview）。
    const snapped = canRewrite ? snapToSentences(instance, rawFrom, rawTo) : null;
    setSnapPreview(instance, snapped && (snapped.from !== rawFrom || snapped.to !== rawTo) ? snapped : null);
    const from = snapped?.from ?? rawFrom;
    const to = snapped?.to ?? rawTo;
    // leafText 必须用 "\n" 与 draft.content 的 getText 对齐：Tiptap 的 hardBreak（段内单换行 → <br>）
    // 在 getText 里序列化成 "\n"，若这里用 " " 则选区跨段内换行时与 draft.content 不匹配、revision 路由 400。
    const text = instance.state.doc.textBetween(from, to, BLOCK_SEPARATOR, "\n");
    const host = hostRef.current;
    if (!text.trim() || !host) { setSelection(null); return; }
    try {
      const start = instance.view.coordsAtPos(from);
      const hostRect = host.getBoundingClientRect();
      const top = Math.max(0, start.top - hostRect.top - TOOLBAR_GAP);
      const barWidth = canRewrite ? TOOLBAR_WIDTH : ASK_ONLY_TOOLBAR_WIDTH;
      const left = Math.max(0, Math.min(start.left - hostRect.left, host.clientWidth - barWidth));
      setSelection({ text, top, left });
    } catch {
      setSelection(null);
    }
  }, [canRewrite, canAsk, findOpen]);
  const refreshSelectionRef = useRef(refreshSelection);
  refreshSelectionRef.current = refreshSelection;
  // 浮动操作条只在「选区定下来（松开鼠标）」后出现，而非拖选过程中边拖边冒/抖。
  const pointerSelectingRef = useRef(false);

  const editor = useEditor({
    // 纯文本纸面：关掉 StarterKit 的标题/列表/引用/代码/分隔线与加粗斜体等输入规则，
    // 否则用户在行首敲「# 」会被转成 <h1>、getText 吞掉「#」前缀，作者打的「# 某某」就该原样是正文里的字（章名只从章名入口改）。
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
      SnapPreview,
    ],
    content: draftTextToHtml(draft.content),
    editable: !locked,
    immediatelyRender: true,
    editorProps: {
      attributes: { class: "se-v2-draft-editor", spellcheck: "false" },
      handleDOMEvents: {
        // 鼠标在正文里按下=开始拖选：先收起浮动条，等松手（document mouseup）选区定型后再弹。
        // 只在可编辑区触发，不含浮动条本身，故不影响「点工具条按钮」。
        mousedown: (view) => {
          pointerSelectingRef.current = true;
          setSelection(null);
          if (SNAP_PREVIEW_KEY.getState(view.state)) view.dispatch(view.state.tr.setMeta(SNAP_PREVIEW_KEY, null));
          return false;
        },
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
      if (useUiStore.getState().revisionHighlightTexts.length > 0) {
        useUiStore.getState().setRevisionHighlight(null);
      }
      onEditRef.current(instance.getText({ blockSeparator: BLOCK_SEPARATOR }));
    },
    onSelectionUpdate: ({ editor: instance }) => {
      // 拖选区（非空选区）时退出聚焦模式，避免选文时正文整片变暗干扰；折叠光标（打字/移动）保持当前模式。
      if (!instance.state.selection.empty) setFocusMode(instance, false);
      if (pointerSelectingRef.current) return; // 鼠标拖选过程中先不弹浮动条，等松手再弹
      refreshSelectionRef.current(instance);
    },
    onBlur: ({ editor: instance }) => { setSnapPreview(instance, null); setSelection(null); },
  });

  // 锁 / 解锁不算作者改字：TipTap 的 setEditable 默认会发一次 update，onUpdate 会把编辑器里的字当作者打的回写——
  // 流式出稿结束解锁时，回写的是流式显示那版（分半出稿两段接缝少个空行），稿纸就误报「你手上还有没存的字」（重构 P6 真机）。
  useEffect(() => {
    editor?.setEditable(!locked, false);
    if (!locked && focusAfterUnlockRef.current) {
      focusAfterUnlockRef.current = false;
      editor?.commands.focus("end");
    }
  }, [editor, locked]);
  const handleUnlock = useCallback(() => {
    focusAfterUnlockRef.current = true;
    setUnlockedChapter(draft.chapterNumber);
  }, [draft.chapterNumber]);

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
      el?.scrollIntoView({ block: "center", behavior: scrollBehavior() });
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

  // 点稿纸空白处（正文下面那一大片、页边）把光标放到正文末尾：编辑区只有字那么高，
  // 新作者点空白稿纸打不了字（2026-10-22 好上手走查）。只认点在稿纸本身，点到查找条、提示等子元素不管。
  const handleCanvasMouseDown = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (locked || !editor || event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target !== event.currentTarget && !target.classList.contains("se-v2-editor-wrap") && !target.classList.contains("se-v2-draft-editor-host")) return;
    event.preventDefault();
    editor.commands.focus("end");
  }, [editor, locked]);

  return (
    <section className="se-v2-writing-canvas" onMouseDown={handleCanvasMouseDown}>
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
            {authorUnlocked ? (
              <p>改吧。改完记得再定稿一次，账才跟得上。</p>
            ) : (
              <>
                <p>这章定稿了，稿纸锁着防手滑。自己改或跟右边的 AI 说都行，改完再定稿一次。</p>
                <button type="button" className="se-v2-notice-action" onClick={handleUnlock}>自己改这章</button>
              </>
            )}
          </article>
        ) : null}
        {generating && draftPhase === "check" && !isEmpty ? (
          <div className="se-v2-notice se-v2-notice-busy" role="status"><p>{draft.chapterNumber > 1 ? "AI 在对前文，有对不上的会改掉，改好自动换上" : "AI 在核对前后，有对不上的会改掉，改好自动换上"}</p></div>
        ) : null}
        <div className="se-v2-draft-editor-host" ref={hostRef}>
          <EditorContent editor={editor} />
          {isEmpty && !isCommitted ? (
            <p className="se-v2-draft-editor-hint" aria-hidden="true">
              {draftPhase === "plan"
                ? "AI 先拟这一章的章纲（一般要一两分钟），拟好就开始写正文……"
                : generating || draftPhase === "write"
                  ? "AI 正在写正文……"
                  : "在这里直接写。想让 AI 先起个草稿，就在右边跟它说。"}
            </p>
          ) : null}
          {(canRewrite || canAsk) && selection ? (
            <SelectionToolbar
              top={selection.top}
              left={selection.left}
              busyKey={busyKey}
              askOnly={!canRewrite}
              onPick={handlePick}
              onPickCustom={handlePickCustom}
              onAsk={onAskAboutSelection ? () => { onAskAboutSelection(selection.text); setSelection(null); } : undefined}
            />
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
    canvas.scrollTo({ top, behavior: scrollBehavior() });
  } catch {
    /* jsdom / 无布局信息：跳过居中滚动 */
  }
}

