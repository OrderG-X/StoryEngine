import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import type { WritingWorkspaceLayoutProps } from "../../../types.js";
import type { ChapterNavItem } from "../../../type-defs/workspace.js";
import { useDisplaySettingsStore } from "../../../stores/displaySettingsStore.js";
import { useNavigationStore } from "../../../stores/navigationStore.js";
import { usePresence } from "../../../hooks/usePresence.js";
import AiChatCodex from "./AiChatCodex.js";
import WritingDeskCodex from "./WritingDeskCodex.js";
import { ThreadBoard } from "./ThreadBoard.js";
import { requestQuoteJump } from "./QuoteJump.js";
import { fetchBookSearch } from "../../../api/bookSearchClient.js";
import { StoryMap } from "./StoryMap.js";
import { ChapterChanges } from "./ChapterChanges.js";
import { BibleBook, type BibleCat } from "./BibleBook.js";
import { useBible } from "./useBible.js";
import { bibleNavCounts, bibleSearchSources, mentionNamesOf, namePeekCardsOf, paletteCharactersOf } from "./bibleIndex.js";
import { searchLibraryIndex } from "./librarySearch.js";
import OperationHistoryView from "./OperationHistoryView.js";
import { SettingsModal, type SettingsTab } from "./SettingsModal.js";
import { ExportDialog } from "../shelf/ExportDialog.js";
import { SaveStatusPill } from "./SaveStatusPill.js";
import { paperStage, useDraftStore } from "../../../stores/draftStore.js";
import { countRealChapters } from "../../../api/stateOverviewAdapter.js";
import { defaultCenterViewForWorkspace } from "./starterGuidance.js";
import { contextActionsForView } from "./ChatCapabilityBar.js";
import { isWorkspaceBusy } from "../../../utils/workspaceOperation.js";
import { chapterBareTitle, chapterDisplayTitle, chapterHeading } from "../v2Utils.js";
import { ThemeToggleButton } from "./ThemeToggleButton.js";
import { CommandPalette, type PaletteCommand } from "./CommandPalette.js";
import { refreshOverviewNow } from "../../../workspace/refreshOverview.js";
import { useThemeStore } from "../../../stores/themeStore.js";
import { CommitSheetHost } from "./CommitSheet.js";
import { IconChevronLeft, IconFocus, IconPanelLeft, IconPanelRight, IconPlus, IconSearch, IconSettings } from "./icons.js";

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/u.test(navigator.platform || navigator.userAgent);
/** 快捷键提示里的修饰键（Mac ⌘，别的 Ctrl+）。 */
const MOD = IS_MAC ? "⌘" : "Ctrl+";
const SHIFT = IS_MAC ? "⇧" : "Shift+";
import "./codex.css";
import "./se-shell.css";
import "./se-desk.css";
import "./se-ai.css";
import "./se-bible.css";

/**
 * WritingWorkspaceCodex — 写作工作区外壳。
 * 2026-10-07 改版：撤掉左侧导航栏，改为全宽顶栏（书名面包屑 / 写作·设定本·历史 / 专注·设置·AI 开关），
 * 设置改成弹窗；下方两栏 = 中（写作台 / 资料中心 / 操作历史）+ 右（AI 对话）。
 *
 * 落地策略（用户选的 B：直接在主界面渐进替换）：
 *  - 中栏「资料中心」用 codex 新视觉，7 类全接真实数据。
 *  - 右栏「AI」=唯一控制面（AiChatCodex：工具调用单独气泡 + 四步进度 + 金色气泡 + 思考折叠）。
 *  - 中栏「写作台」用 codex 沉浸聚光视觉（WritingDeskCodex：居中悬浮稿纸 + 暗角 + 金 caret + 当前句呼吸辉光），编辑器内核复用 WritingPaper。
 *  - 重构 P9：设定本作者直接改（作者档命令、可撤销），也可以在右边让 AI 改。
 */
// 章节不在「资料中心」类目里——它属于写作上下文，走「写作台」视图的章节竖轨。
const CATS = [
  { id: "changes", title: "这章改了什么", sub: "定稿记下的人 · 线索 · 事", group: "刚定稿" },
  { id: "story", title: "故事设定", sub: "一句话 · 题材 · 世界规矩 · 其他设定", group: "设定卡" },
  { id: "rules", title: "写作规则", sub: "视角 · 字数 · 文风 · 禁写" },
  { id: "chars", title: "人物", sub: "人物卡 · 账里记的" },
  { id: "relations", title: "关系", sub: "谁和谁什么关系" },
  { id: "items", title: "物品", sub: "物品卡" },
  { id: "places", title: "地点", sub: "地点卡" },
  { id: "uncarded", title: "还没建卡", sub: "账里有、卡里没有的" },
  { id: "hooks", title: "伏笔与线索", sub: "刚埋下 · 在推进 · 停太久 · 已收口", group: "全书的账" },
  { id: "timeline", title: "故事地图", sub: "章 × 人物 · 故事日" },
] as const;

const BIBLE_CATS = new Set<string>(["story", "rules", "chars", "relations", "items", "places", "uncarded"]);

/** 仅供测试用：导出 CATS 数组供轻量测试断言（不影响生产代码）。 */
export const __CATS_FOR_TEST = CATS;

// 右栏对话宽度可调范围（px）。
const AI_MIN_WIDTH = 320;
const AI_MAX_WIDTH = 640;
const AI_DEFAULT_WIDTH = 372;
// 窄视口右栏让位（T3）：中栏至少保住的宽度，与右栏的硬下限。
// 视口装不下「左栏 + 中栏下限 + 右栏下限」时右栏默认自动收成 44px 竖条（手动展开/收起后不再自动干预，
// 见 resolveRightPanelOpen）；装得下就把右栏压到能放下的宽度，composer 与发送键永远在视口内
// （styles.css 的 body min-width:1180 已同步撤掉）。
const MID_MIN_WIDTH = 480;
const AI_FIT_MIN_WIDTH = 280;

function readStoredAiWidth(): number {
  try {
    const saved = Number(window.localStorage.getItem("codex.aiWidth"));
    if (Number.isFinite(saved) && saved >= AI_MIN_WIDTH && saved <= AI_MAX_WIDTH) return saved;
  } catch { /* 隐私模式/无 localStorage：用默认 */ }
  return AI_DEFAULT_WIDTH;
}

// 写作台章节栏基准宽度（px，随 uiZoom 放大）。窄视口让位计算要扣掉它。
const CHAPTER_RAIL_BASE_WIDTH = 248;
const CHAPTER_DRAWER_BREAKPOINT = 1280;

const CHAPTER_STATUS_LABEL: Record<ChapterNavItem["status"], string> = {
  committed: "已定稿", draft: "工作稿", current: "当前章", planned: "还没写",
};
// 只给「要你留意」的章亮点：工作稿=橙点；当前章靠整行高亮、已定稿与未写不打点，列表才安静。
const CHAPTER_STATUS_DOT: Record<ChapterNavItem["status"], string> = {
  committed: "", draft: "warn", current: "", planned: "",
};

type ChapterRow =
  | { readonly kind: "group"; readonly key: string; readonly label: string }
  | { readonly kind: "chapter"; readonly ch: ChapterNavItem };

/** 章节列表行：新章在上；不搜索时每 10 章插一个分组标题（第 51–58 章），搜索时平铺。 */
/** 这章还要定稿：工作稿章，或已定稿、但工作稿定稿后又改过。 */
export function needsCommit(chapter: ChapterNavItem): boolean {
  return chapter.status === "draft" || (chapter.status === "committed" && chapter.editedSinceCommit === true);
}

/** 章节栏底部那一行：还有工作稿没定稿 / 全部已定稿 / 一章都没定稿（新书别说「全部已定稿」，P7 桌面包走查）。 */
export function chapterFootStatus(draftCount: number, committedCount: number): { readonly dot: "warn" | "ok" | ""; readonly text: string } {
  if (draftCount > 0) return { dot: "warn", text: `${draftCount} 章工作稿还没定稿` };
  return committedCount > 0 ? { dot: "ok", text: "全部已定稿" } : { dot: "", text: "还没有定稿的章" };
}

export function buildChapterRows(chapters: readonly ChapterNavItem[], searching: boolean): readonly ChapterRow[] {
  const rows: ChapterRow[] = [];
  let lastGroup: number | null = null;
  const ordered = [...chapters].sort((a, b) => b.chapterNumber - a.chapterNumber);
  const maxNumber = ordered[0]?.chapterNumber ?? 0;
  for (const ch of ordered) {
    if (!searching) {
      const group = Math.floor((Math.max(1, ch.chapterNumber) - 1) / 10);
      if (group !== lastGroup) {
        lastGroup = group;
        const lo = group * 10 + 1;
        const hi = Math.min(group * 10 + 10, maxNumber);
        rows.push({ kind: "group", key: `g${group}`, label: lo === hi ? `第 ${lo} 章` : `第 ${lo}–${hi} 章` });
      }
    }
    rows.push({ kind: "chapter", ch });
  }
  return rows;
}

/**
 * T3：右栏开合裁决——手动意愿优先于窄视口自动收起。
 * 用户没碰过展开/收起（manualToggled=false）时：视口装不下右栏硬下限就收成 44px 竖条，窗口变宽自动恢复展开；
 * 用户一旦点过，就完全以手动意愿为准——窄窗点展开也真的展开（中栏 minmax(0,1fr) 被挤压但不出屏），
 * 手动收起后变宽也不擅自弹开。
 */
export function resolveRightPanelOpen(rightOpen: boolean, autoCollapsed: boolean, manualToggled: boolean): boolean {
  return rightOpen && (manualToggled || !autoCollapsed);
}

export default function WritingWorkspaceCodex(props: WritingWorkspaceLayoutProps) {
  const workspaceBusy = Boolean(
    props.chatLoading
    || props.steeringLoading
    || props.draftActionLoading
    || isWorkspaceBusy(),
  );
  const focusWriting = useDisplaySettingsStore((s) => s.focusWriting);
  const [rightOpen, setRightOpen] = useState(() => !focusWriting);
  // T3：用户是否点过右栏展开/收起。点过之后手动意愿覆盖窄视口自动收起（见 resolveRightPanelOpen）。
  const [aiManualToggled, setAiManualToggled] = useState(false);
  // 环境健康：系统缺 git 时快照/撤销不可用（桌面前置·Windows 测试者大概率没装）——
  // 顶部亮黄条明说，绝不静默降级。只在挂载时探一次（git 可用性运行期不会变）。
  const [gitAvailable, setGitAvailable] = useState(true);
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/health")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { gitAvailable?: boolean } | null) => {
        if (!cancelled && data && data.gitAvailable === false) setGitAvailable(false);
      })
      .catch(() => { /* 探测失败不打扰（保持默认可用假设，写作功能不受影响） */ });
    return () => { cancelled = true; };
  }, []);
  const [rightWidth, setRightWidth] = useState(readStoredAiWidth);
  // P1-5：空书首次进入默认落写作台（非资料中心）。
  const [view, setView] = useState<"library" | "desk" | "history">(() =>
    defaultCenterViewForWorkspace(),
  );
  // 设置改成弹窗（不再占中栏整页），null = 关着。
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  // 设置再打开回到上次那页（苹果规范：记住上次打开的面板）。
  const lastSettingsTabRef = useRef<SettingsTab>("model");
  useEffect(() => { if (settingsTab) lastSettingsTabRef.current = settingsTab; }, [settingsTab]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // 设置 / ⌘K 关的时候先播完退场再卸。
  const settingsPresence = usePresence(settingsTab !== null);
  const palettePresence = usePresence(paletteOpen);
  const [exportOpen, setExportOpen] = useState(false);
  const [cat, setCat] = useState<string>("story");
  // 设定本先展开哪张卡（正文名字速览、搜索结果、⌘K 点进来的）。
  const [bibleFocus, setBibleFocus] = useState<string | undefined>(undefined);
  // 设定本换页从顶上看起（不留上一页翻到的位置）；要点开某张卡的，卡自己再滚过去（它的 effect 在这之后跑）。
  const bibleReadRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { if (bibleReadRef.current) bibleReadRef.current.scrollTop = 0; }, [cat]);
  // 窄窗开局收起章节抽屉（不挡稿纸）；宽窗按专注写作开关决定。
  const [deskRailOpen, setDeskRailOpen] = useState(() => !focusWriting && window.innerWidth >= CHAPTER_DRAWER_BREAKPOINT);
  // 章节栏开合要滑：顶栏按钮、快捷键、专注写作切换时滑出 / 收回，稿纸跟着平移；
  // 切页面（设定本 → 写作台）重建时不滑，不然每回写作台稿纸都晃一下。
  const railPresence = usePresence(deskRailOpen);
  const [railSlide, setRailSlide] = useState(false);
  useLayoutEffect(() => { setRailSlide(false); }, [view]);
  const toggleRail = (open: boolean) => { setRailSlide(true); setDeskRailOpen(open); };
  const [chapterQuery, setChapterQuery] = useState("");
  const chapterListRef = useRef<HTMLDivElement | null>(null);
  const [libQuery, setLibQuery] = useState("");
  // 三处字号已上提到 displaySettingsStore（设置面板也读写同一份）。这里只读聊天/界面缩放。
  const chatZoom = useDisplaySettingsStore((s) => s.chatZoom);

  // P1-8：专注写作 = 复用两侧收起（章节栏 + AI 栏），状态由 displaySettings 记住。
  useEffect(() => {
    setDeskRailOpen(!focusWriting && window.innerWidth >= CHAPTER_DRAWER_BREAKPOINT);
    setRightOpen(!focusWriting);
  }, [focusWriting]);

  // 出稿/续写一开始（useChat 在 generate_draft tool-call 时 requestCenterView("desk")）→ 自动切到写作台，
  // 让用户看着正文出现，不必手动点。一次性消费后清空，避免之后切走又被拽回。
  const pendingCenterView = useNavigationStore((s) => s.pendingCenterView);
  // 刚定稿还没看过「这章改了什么」：顶栏「设定本」亮小点，点进去先到那一页（看过就清）。
  const unseenChangesChapter = useNavigationStore((s) => s.unseenChangesChapter);
  useEffect(() => {
    if (view === "library" && cat === "changes" && unseenChangesChapter !== null) {
      useNavigationStore.getState().setUnseenChangesChapter(null);
    }
  }, [view, cat, unseenChangesChapter]);
  useEffect(() => {
    if (!pendingCenterView) return;
    setView(pendingCenterView);
    useNavigationStore.getState().clearPendingCenterView();
  }, [pendingCenterView]);
  const uiZoom = useDisplaySettingsStore((s) => s.uiZoom);
  const resizingRef = useRef(false);

  const { chapters, currentChapter, projectName } = props.workspace;
  // 共 N 章不计尾随的占位「下一章」（修 R2#4「2/3」）。
  const realChapterCount = countRealChapters(chapters, currentChapter.chapterNumber);
  const currentId = currentChapter.id;
  // 伏笔看板点原句：切到写作台、打开那一章、滚到这句（QuoteJump）。
  const jumpToQuote = (chapter: number, quote: string) => {
    const target = chapters.find((ch) => ch.chapterNumber === chapter);
    if (!target) {
      useNavigationStore.getState().showToast(`第 ${chapter} 章不在章节列表里，没法跳过去。`, 4200);
      return;
    }
    if (target.id !== currentId && workspaceBusy) {
      useNavigationStore.getState().showToast("写作操作正在进行，请等本次操作结束后再切换章节。", 4600);
      return;
    }
    setView("desk");
    requestQuoteJump(chapter, quote);
    if (target.id !== currentId) props.onSelectChapter?.(target.id);
  };
  // ⌘K 搜正文（要稳定的引用：面板按它决定要不要重搜）。
  const projectPath = props.projectPath;
  const searchBookText = useMemo(
    () => (projectPath ? (query: string, signal: AbortSignal) => fetchBookSearch(projectPath, query, signal) : undefined),
    [projectPath],
  );
  // 故事地图点章号、已定稿章的「去第 N 章」：切到写作台打开那一章。
  const openChapterNumber = (chapter: number) => {
    const target = chapters.find((ch) => ch.chapterNumber === chapter);
    if (!target) {
      useNavigationStore.getState().showToast(`第 ${chapter} 章不在章节列表里，没法打开。`, 4200);
      return;
    }
    if (target.id !== currentId && workspaceBusy) {
      useNavigationStore.getState().showToast("写作操作正在进行，请等本次操作结束后再切换章节。", 4600);
      return;
    }
    setView("desk");
    if (target.id !== currentId) props.onSelectChapter?.(target.id);
  };
  // 「这章改了什么」先看哪章：刚定稿没看过的那章 > 当前章（已定稿时）> 最近定稿的章。进页时定下，翻页不被拽回。
  const [changesChapter, setChangesChapter] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (view !== "library" || cat !== "changes") return;
    const current = currentChapter.status === "committed" || currentChapter.hasCommittedChapter ? currentChapter.chapterNumber : undefined;
    setChangesChapter(unseenChangesChapter ?? current);
    // 只在进这一页时定：unseen 清掉、当前章变了都不再拽。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, cat]);
  // 故事地图、改动面板只要章名本身（当前章的名字从稿纸标题行来，带着「第N章 · 」）。
  const lastCommittedChapter = useMemo(() => Math.max(0, ...chapters.filter((ch) => ch.status === "committed" || ch.hasCommittedChapter).map((ch) => ch.chapterNumber)), [chapters]);
  const chapterTitles = useMemo(() => new Map(chapters.map((ch) => [ch.chapterNumber, chapterBareTitle(ch.title ?? "")] as const).filter(([, title]) => title.length > 0)), [chapters]);
  const catTitle = CATS.find((c) => c.id === cat)?.title ?? "";
  const crumbHere = view === "desk"
    ? chapterHeading(currentChapter.chapterNumber, currentChapter.title ?? "")
    : view === "library" ? `设定本 · ${catTitle}` : "操作历史";

  // 设定视图（重构 P9）：设定本各页、搜索、⌘K、正文名字速览、@ 提及都用这一份；开书概况每刷新一次跟着重读。
  const bibleState = useBible(props.projectPath ?? undefined, props.overview);
  const librarySearchSources = useMemo(() => bibleSearchSources(bibleState.bible), [bibleState.bible]);
  const paletteCharacters = useMemo(() => paletteCharactersOf(bibleState.bible), [bibleState.bible]);
  const bibleCounts = useMemo(() => bibleNavCounts(bibleState.bible), [bibleState.bible]);
  const peekCards = useMemo(() => namePeekCardsOf(bibleState.bible), [bibleState.bible]);
  const mentionNames = useMemo(() => mentionNamesOf(bibleState.bible), [bibleState.bible]);
  const openInBible = (target: string, name?: string) => {
    setView("library");
    setCat(target);
    setBibleFocus(name);
  };
  // 作者在设定本里改成了：开书概况跟着刷新（主角、待处理、书架简介）。
  const refreshOverview = () => { if (props.projectPath) void refreshOverviewNow(props.projectPath); };
  const libQ = libQuery.trim().toLowerCase();
  const paletteCommands: PaletteCommand[] = [
    {
      id: "next", label: "AI 写下一章", hint: "在右边进行，要几分钟", disabled: workspaceBusy || !props.onSendMessage,
      run: () => { setView("desk"); props.onSendMessage?.("继续写下一章的正文，现在就动笔直接出稿"); },
    },
    { id: "desk", label: "打开写作台", hint: `${MOD}1`, run: () => setView("desk") },
    { id: "library", label: "打开设定本", hint: `${MOD}2`, run: () => setView("library") },
    { id: "history", label: "打开操作历史", hint: `${MOD}3`, run: () => setView("history") },
    { id: "rail", label: "收起 / 展开章节列表", hint: `${MOD}\\`, run: () => shortcutsRef.current.rail?.() },
    { id: "ai", label: "收起 / 展开 AI 助手", hint: `${MOD}${SHIFT}\\`, run: () => shortcutsRef.current.ai?.() },
    {
      id: "focus", label: focusWriting ? "退出专注写作" : "专注写作", hint: "收起两侧",
      run: () => { setRailSlide(true); setView("desk"); useDisplaySettingsStore.getState().toggleFocusWriting(); },
    },
    { id: "theme", label: "切换深色 / 纸面主题", hint: "外观", run: () => useThemeStore.getState().toggle() },
    { id: "settings", label: "模型设置", hint: `设置 ${MOD},`, run: () => setSettingsTab("model") },
    { id: "display", label: "显示设置（主题、字号）", hint: "设置", run: () => setSettingsTab("display") },
    { id: "export", label: "导出这本书", hint: "txt · Word · epub", disabled: !props.projectPath, run: () => setExportOpen(true) },
    { id: "home", label: "回到书架", hint: "视图", run: () => props.onGoHome?.() },
  ];
  const librarySearchResults = searchLibraryIndex(librarySearchSources, libQuery);

  // 选中段引用进输入框：压成一行、过长截断（完整段 AI 能从稿子里对上）。
  function quoteForComposer(text: string): string {
    const flat = text.replace(/\s+/gu, " ").trim();
    return flat.length > 60 ? `${flat.slice(0, 60)}…` : flat;
  }

  // 资料面板里的「问 AI」：把一句话填进右侧输入框（不发送），打开 AI 栏并把光标放到句末，作者看过再发。
  function fillComposer(text: string) {
    props.onSteeringDirectionChange(text);
    setAiManualToggled(true);
    setRightOpen(true);
    window.setTimeout(() => {
      const box = document.querySelector<HTMLTextAreaElement>(".codex-app .composer textarea");
      if (!box) return;
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
    }, 60);
  }

  // 拖动右缘改宽：pointer 拖动期间实时夹在 [min,max] 设宽，松手解绑监听。
  function handleResizeStart(event: ReactPointerEvent) {
    event.preventDefault();
    resizingRef.current = true;
    document.body.classList.add("se-resizing");
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    const onMove = (moveEvent: PointerEvent) => {
      if (!resizingRef.current) return;
      const next = Math.min(AI_MAX_WIDTH, Math.max(AI_MIN_WIDTH, window.innerWidth - moveEvent.clientX));
      setRightWidth(next);
    };
    const onUp = () => {
      resizingRef.current = false;
      document.body.classList.remove("se-resizing");
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  // 快捷键（任何地方都能按，再按一次关）：⌘K 搜索与命令面板；对标走查补上 ⌘, 设置（苹果规范）、
  // ⌘1 / 2 / 3 换写作台 / 设定本 / 历史、⌘\ 收放章节栏、⌘⇧\ 收放 AI 栏（Ulysses 式）。
  // 要用到当次渲染的状态的动作放 ref 里（每次渲染换新），监听只挂一次。
  const shortcutsRef = useRef<Partial<Record<"settings" | "rail" | "ai", () => void>>>({});
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.isComposing) return;
      const key = event.key.toLowerCase();
      const views: Record<string, "desk" | "library" | "history"> = { "1": "desk", "2": "library", "3": "history" };
      if (key === "k") setPaletteOpen((open) => !open);
      else if (key === ",") shortcutsRef.current.settings?.();
      else if (event.code === "Backslash") shortcutsRef.current[event.shiftKey ? "ai" : "rail"]?.();
      else if (!event.shiftKey && views[key]) setView(views[key]);
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);


  // 宽度变化落盘（下次进来记住）。
  useEffect(() => {
    try { window.localStorage.setItem("codex.aiWidth", String(rightWidth)); } catch { /* 忽略 */ }
  }, [rightWidth]);

  // 字号偏好落盘由 displaySettingsStore 负责（每次 set 自动写回 localStorage）。

  // 章节搜索过滤：标题 / 章号 / 序号匹配；空查询=全部。
  const chapterFilter = chapterQuery.trim().toLowerCase();
  const visibleChapters = chapterFilter
    ? chapters.filter((ch, i) =>
      (ch.title ?? "").toLowerCase().includes(chapterFilter)
      || String(ch.chapterNumber).includes(chapterFilter)
      || String(i + 1).includes(chapterFilter))
    : chapters;
  // 「还没写」的占位章不进列表：开新章走顶上的「写第 N 章」，翻到它走稿纸底部的「下一章」。
  const chapterRows = buildChapterRows(visibleChapters.filter((ch) => ch.status !== "planned" || ch.id === currentId), Boolean(chapterFilter));
  // 当前章的状态看稿纸（和稿纸工具条、右栏顶卡同源 paperStage；章节列表里它只标「current」，看不出是不是还没定稿）。
  const currentStage = useDraftStore((state) => (state.chapter === props.workspace.currentChapter.chapterNumber ? paperStage(state) : null));
  const currentIsDraft = currentStage === "draft" || currentStage === "edited";
  const currentLabel = currentStage === "edited" ? "定稿后又改过" : currentIsDraft ? "工作稿还没定稿" : currentStage === "committed" ? "已定稿" : null;
  // ⌘K 里的章也按这个说（不再自己另算）。
  const paletteChapters = chapters.map((ch) => (ch.id === currentId && currentStage && currentStage !== "empty"
    ? { ...ch, status: currentIsDraft ? "draft" as const : "committed" as const }
    : ch));
  // 别的章：工作稿章，和定稿后工作稿又改过的章（P11：AI 改了别的已定稿章，不用切过去才算上）。
  const draftChapterCount = chapters.filter((ch) => ch.id !== currentId && needsCommit(ch)).length + (currentIsDraft ? 1 : 0);
  const chapterFoot = chapterFootStatus(draftChapterCount, chapters.filter((ch) => ch.status === "committed" || ch.hasCommittedChapter).length);
  // 「写第 N 章」：最新一章已定稿时才出（还有工作稿没定稿就先别开新章）。
  const latestReal = [...chapters].filter((ch) => ch.status !== "planned").sort((a, b) => b.chapterNumber - a.chapterNumber)[0];
  const nextToWrite = latestReal && (latestReal.status === "committed" || latestReal.hasCommittedChapter) && draftChapterCount === 0
    ? latestReal.chapterNumber + 1
    : null;

  // 写作台章节栏展开时占的宽度（随界面字号放大），窄视口让位要扣掉它。
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  // 窄窗（<1280）章节栏改成浮在稿纸上的抽屉，不再挤占稿纸宽度。
  const chapterDrawer = viewportWidth < CHAPTER_DRAWER_BREAKPOINT;
  const chapterRailWidth = view === "desk" && deskRailOpen && !chapterDrawer ? Math.round(CHAPTER_RAIL_BASE_WIDTH * uiZoom) : 0;
  // 窗口跨过抽屉线：变窄收起抽屉（不挡稿纸），变宽且没开专注写作就把章节栏摆回来
  // （对标走查：窄过一次再放大，章节栏一直收着，120 章的书看不到目录）。
  const wasDrawerRef = useRef(chapterDrawer);
  useEffect(() => {
    if (wasDrawerRef.current !== chapterDrawer) setDeskRailOpen(!chapterDrawer && !focusWriting);
    wasDrawerRef.current = chapterDrawer;
  }, [chapterDrawer, focusWriting]);
  // 换了章（⌘K、回原句、上一章 / 下一章）章节栏滚到当前章：长书的当前章常在列表外头。
  useEffect(() => {
    chapterListRef.current?.querySelector<HTMLElement>(".se-ch.on")?.scrollIntoView?.({ block: "nearest" });
  }, [currentId, deskRailOpen, view]);

  // T3：跟视口宽度走——右栏实际宽度 = min(用户拖的宽度, 视口装得下的宽度)；
  // 连右栏硬下限都装不下时默认自动收成 44px 竖条；用户没碰过展开/收起时窗口变宽自动恢复，
  // 点过之后以手动意愿为准（resolveRightPanelOpen，复审返工：修掉自动收起后展开钮死点击）。
  const aiWidthThatFits = viewportWidth - chapterRailWidth - MID_MIN_WIDTH;
  const aiAutoCollapsed = aiWidthThatFits < AI_FIT_MIN_WIDTH;
  const effectiveRightOpen = resolveRightPanelOpen(rightOpen, aiAutoCollapsed, aiManualToggled);
  const effectiveRightWidth = Math.max(AI_FIT_MIN_WIDTH, Math.min(rightWidth, aiWidthThatFits));
  shortcutsRef.current = {
    settings: () => setSettingsTab((tab) => (tab ? null : lastSettingsTabRef.current)),
    rail: () => {
      if (view !== "desk") { setView("desk"); setDeskRailOpen(true); return; }
      setRailSlide(true);
      setDeskRailOpen((open) => !open);
    },
    ai: () => { setAiManualToggled(true); setRightOpen(!effectiveRightOpen); },
  };

  return (
    <div
      className="codex-app"
      style={{ "--codex-chat-zoom": chatZoom, "--codex-ui-zoom": uiZoom } as CSSProperties}
    >
      {!gitAvailable && (
        <div className="env-warning-bar" role="alert">
          未检测到 git：存档与撤销功能不可用（写作不受影响）。安装 git 后重启应用即可恢复。
        </div>
      )}
      <header className="se-top">
        <div className="se-top-l">
          {view === "desk" ? (
            <button
              className={`se-icon-btn${deskRailOpen ? " on" : ""}`}
              type="button"
              aria-label={deskRailOpen ? "收起章节列表" : "展开章节列表"}
              aria-pressed={deskRailOpen}
              title={`章节列表（${MOD}\\）`}
              onClick={() => toggleRail(!deskRailOpen)}
            >
              <IconPanelLeft />
            </button>
          ) : null}
          <nav className="se-crumb" aria-label="当前位置">
            <button className="se-crumb-book" type="button" title="返回书架" onClick={() => props.onGoHome?.()}>
              <IconChevronLeft size={14} strokeWidth={1.8} />
              <span className="se-crumb-name">{projectName}</span>
            </button>
            <span className="se-crumb-sep" aria-hidden="true">/</span>
            <span className="se-crumb-here">{crumbHere}</span>
          </nav>
        </div>
        <nav className="se-seg" aria-label="视图">
          <button className={view === "desk" ? "on" : ""} type="button" aria-pressed={view === "desk"} onClick={() => setView("desk")}>写作</button>
          <button
            className={`${view === "library" ? "on" : ""}${unseenChangesChapter !== null ? " has-dot" : ""}`}
            type="button"
            aria-pressed={view === "library"}
            title={unseenChangesChapter !== null ? `第 ${unseenChangesChapter} 章定稿了：点进来看这章改了什么` : undefined}
            onClick={() => {
              if (unseenChangesChapter !== null) setCat("changes");
              setView("library");
            }}
          >
            设定本{unseenChangesChapter !== null ? <span className="se-seg-dot" aria-label="有新定稿的改动" /> : null}
          </button>
          <button className={view === "history" ? "on" : ""} type="button" aria-pressed={view === "history"} onClick={() => setView("history")}>历史</button>
        </nav>
        <div className="se-top-r">
          <button className="se-search-btn" type="button" aria-label="搜索章节、正文、设定、命令" onClick={() => setPaletteOpen(true)}>
            <IconSearch size={16} />
            <span className="se-search-lbl">搜章节、正文、设定</span>
            <kbd>{IS_MAC ? "⌘K" : "Ctrl K"}</kbd>
          </button>
          <button
            className={`se-icon-btn${focusWriting ? " on" : ""}`}
            type="button"
            aria-label="专注写作"
            aria-pressed={focusWriting}
            title="专注写作（收起两侧）"
            onClick={() => {
              if (!focusWriting) setView("desk");
              setRailSlide(true);
              useDisplaySettingsStore.getState().toggleFocusWriting();
            }}
          >
            <IconFocus />
          </button>
          <ThemeToggleButton className="se-icon-btn se-theme-btn" />
          <button className="se-icon-btn" type="button" aria-label="设置" title={`设置（${MOD},）`} onClick={() => setSettingsTab(lastSettingsTabRef.current)}>
            <IconSettings />
          </button>
          <button
            className={`se-icon-btn${effectiveRightOpen ? " on" : ""}`}
            type="button"
            aria-label={effectiveRightOpen ? "收起 AI 助手" : "展开 AI 助手"}
            aria-pressed={effectiveRightOpen}
            title={`AI 助手（${MOD}${SHIFT}\\）`}
            onClick={() => { setAiManualToggled(true); setRightOpen(!effectiveRightOpen); }}
          >
            <IconPanelRight />
          </button>
        </div>
      </header>
      <div className="app" style={{ gridTemplateColumns: `minmax(0, 1fr) ${effectiveRightOpen ? effectiveRightWidth : 44}px`, "--ai-w": `${effectiveRightWidth}px` } as CSSProperties}>
        {/* ══ 中：资料中心 / 写作台 ══ */}
        <main className="desk">
          <div key={view} className="view-anim">
          {view === "history" ? (
            <OperationHistoryView projectPath={props.projectPath} refreshKey={props.overview} />
          ) : view === "library" ? (
            <>
              <div className="codex se-bible">
                <nav className="se-bnav" aria-label="设定分类">
                  {/* 资料全局搜索：跨类目找人 / 物 / 设定，点结果跳到对应类目。 */}
                  <div className="lib-search-wrap">
                    <label className="se-field-search">
                      <IconSearch size={14} strokeWidth={1.8} />
                      <input
                        type="search"
                        value={libQuery}
                        onChange={(event) => setLibQuery(event.target.value)}
                        onKeyDown={(event) => { if (event.key === "Escape") setLibQuery(""); }}
                        placeholder="搜人、物、设定…"
                        aria-label="搜索资料"
                      />
                    </label>
                    {libQ ? (
                      <div className="lib-search-pop" role="listbox" aria-label="搜索结果">
                        {librarySearchResults.length > 0 ? (
                          librarySearchResults.map((r, i) => (
                            <button
                              key={`${r.cat}-${i}-${r.label}`}
                              className="lib-search-hit"
                              type="button"
                              role="option"
                              onClick={() => { openInBible(r.cat, r.focus); setLibQuery(""); }}
                            >
                              <span className="lib-hit-cat">{r.catLabel}</span>
                              <span className="lib-hit-label">{r.snippet}</span>
                            </button>
                          ))
                        ) : (
                          <div className="lib-search-empty">没找到匹配「{libQuery.trim()}」的资料</div>
                        )}
                      </div>
                    ) : null}
                  </div>
                  {CATS.map((c) => [
                    "group" in c ? <p key={`g-${c.id}`} className="se-bnav-group">{c.group}</p> : null,
                    <button
                      key={c.id}
                      className={`se-bnav-item${cat === c.id ? " on" : ""}`}
                      aria-current={cat === c.id ? "page" : undefined}
                      title={c.sub}
                      onClick={() => { setCat(c.id); setBibleFocus(undefined); }}
                      type="button"
                    >
                      {c.title}
                      {bibleCounts[c.id as BibleCat] ? <span className="se-bnav-count" aria-hidden="true">{bibleCounts[c.id as BibleCat]}</span> : null}
                    </button>,
                  ])}
                  <p className="se-bnav-note">点字就能改，也可以在右边让 AI 改。</p>
                </nav>
                <div className="read" ref={bibleReadRef}>
                  <div className={`read-inner read-enter${cat === "hooks" || cat === "timeline" ? " is-wide" : ""}`} key={cat}>
                    {cat === "changes" && props.projectPath ? (
                      <ChapterChanges
                        projectPath={props.projectPath}
                        busy={workspaceBusy}
                        chapterTitles={chapterTitles}
                        onJump={jumpToQuote}
                        {...(changesChapter !== undefined ? { chapter: changesChapter } : {})}
                      />
                    ) : null}
                    {BIBLE_CATS.has(cat) && props.projectPath ? (
                      <BibleBook
                        cat={cat as BibleCat}
                        projectPath={props.projectPath}
                        bible={bibleState.bible}
                        error={bibleState.error}
                        reload={bibleState.reload}
                        busy={workspaceBusy}
                        onJump={jumpToQuote}
                        onChanged={refreshOverview}
                        onOpenCat={openInBible}
                        chapterCount={lastCommittedChapter}
                        bookTitle={projectName}
                        {...(bibleFocus ? { focusName: bibleFocus } : {})}
                      />
                    ) : null}
                    {cat === "hooks" && props.projectPath ? (
                      <ThreadBoard
                        projectPath={props.projectPath}
                        busy={workspaceBusy}
                        onJump={jumpToQuote}
                        {...(props.onSendUserAction ? { onAction: props.onSendUserAction } : {})}
                      />
                    ) : null}
                    {cat === "timeline" && props.projectPath ? (
                      <StoryMap
                        projectPath={props.projectPath}
                        busy={workspaceBusy}
                        chapterTitles={chapterTitles}
                        onJump={jumpToQuote}
                        onOpenChapter={openChapterNumber}
                      />
                    ) : null}
                  </div>
                </div>
              </div>
            </>
          ) : (
            // 写作台视图：左侧章节列表（顶栏按钮开合 + 搜索，每 10 章一组）+ 右侧 WritingDeskCodex 稿纸。
            <div className="codex se-desk-wrap" style={{ gridTemplateColumns: railPresence.mounted && !chapterDrawer ? "auto minmax(0, 1fr)" : "minmax(0, 1fr)" }}>
              {railPresence.mounted && chapterDrawer ? (
                <button className="se-drawer-scrim" type="button" aria-label="收起章节列表" onClick={() => setDeskRailOpen(false)} data-closing={railPresence.closing || undefined} />
              ) : null}
              {railPresence.mounted ? (
                <nav
                  ref={railPresence.ref}
                  className={`se-chapters${chapterDrawer ? " is-drawer" : " is-rail"}${railSlide ? " is-slide" : ""}`}
                  style={chapterDrawer ? undefined : ({ "--rail-w": `${CHAPTER_RAIL_BASE_WIDTH}px` } as CSSProperties)}
                  data-closing={railPresence.closing || undefined}
                  aria-label="章节"
                >
                  <div className="se-ch-head"><b>章节</b><span>{realChapterCount} 章</span></div>
                  <label className="se-field-search">
                    <IconSearch size={14} strokeWidth={1.8} />
                    <input
                      type="search"
                      value={chapterQuery}
                      onChange={(event) => setChapterQuery(event.target.value)}
                      onKeyDown={(event) => { if (event.key === "Escape") setChapterQuery(""); }}
                      placeholder="搜章名或章号"
                      aria-label="搜索章节"
                    />
                  </label>
                  {nextToWrite && !chapterFilter ? (
                    // 章节栏的「+」就是新开一章给作者自己写（对标走查：原来点了是 AI 出整章，没接 AI 也能点）；
                    // 要 AI 写，在那章稿纸下面点「AI 写这一章」或跟右边说。
                    <button
                      className="se-new-ch"
                      type="button"
                      disabled={workspaceBusy}
                      title={`打开第 ${nextToWrite} 章的空白稿纸自己写；要 AI 写，在稿纸下面点「AI 写这一章」`}
                      onClick={() => openChapterNumber(nextToWrite)}
                    >
                      <IconPlus size={16} />写第 {nextToWrite} 章
                    </button>
                  ) : null}
                  <div className="se-ch-list" ref={chapterListRef}>
                    {chapterRows.map((row) => row.kind === "group" ? (
                      <div key={row.key} className="se-ch-group">{row.label}</div>
                    ) : (
                      <button
                        key={row.ch.id}
                        className={`se-ch${row.ch.id === currentId ? " on" : ""}`}
                        disabled={workspaceBusy}
                        aria-current={row.ch.id === currentId ? "page" : undefined}
                        title={workspaceBusy ? "写作操作进行中，暂不能切换章节" : `${chapterHeading(row.ch.chapterNumber, row.ch.title ?? "")} · ${row.ch.id === currentId ? (currentLabel ?? CHAPTER_STATUS_LABEL[row.ch.status]) : row.ch.status === "committed" && row.ch.editedSinceCommit ? "定稿后又改过" : CHAPTER_STATUS_LABEL[row.ch.status]}`}
                        onClick={() => {
                          if (workspaceBusy) {
                            useNavigationStore.getState().showToast("写作操作正在进行，请等本次操作结束后再切换章节。", 4600);
                            return;
                          }
                          props.onSelectChapter?.(row.ch.id);
                          if (chapterDrawer) setDeskRailOpen(false);
                        }}
                        type="button"
                      >
                        <span className="se-ch-n">{row.ch.chapterNumber}</span>
                        <span className={`se-ch-t${chapterDisplayTitle(row.ch.title ?? "") && row.ch.status !== "planned" ? "" : " untitled"}`}>{chapterDisplayTitle(row.ch.title ?? "") || "未命名"}</span>
                        <span className={`se-dot ${row.ch.id === currentId ? (currentIsDraft ? "warn" : "") : needsCommit(row.ch) ? "warn" : CHAPTER_STATUS_DOT[row.ch.status]}`} aria-hidden="true" />
                      </button>
                    ))}
                    {visibleChapters.length === 0 ? (
                      <div className="se-ch-empty">没有章名或章号包含「{chapterQuery.trim()}」的章节</div>
                    ) : null}
                  </div>
                  <div className="se-ch-foot">
                    <span className={`se-dot ${chapterFoot.dot}`} aria-hidden="true" />
                    {chapterFoot.text}
                  </div>
                </nav>
              ) : null}
              <WritingDeskCodex
                {...props}
                onOpenChapter={openChapterNumber}
                peekCards={peekCards}
                onOpenCharacter={(name) => openInBible("chars", name)}
                onAskAboutSelection={(text) => fillComposer(`关于这段「${quoteForComposer(text)}」，`)}
                onFillComposer={fillComposer}
              />
            </div>
          )}
          </div>
          {/* 保存状态 Pill：中栏底边右下角（.desk 相对定位），不再压右栏 AI 发送键（UI 审计 T8）。 */}
          <SaveStatusPill />
        </main>

        {/* ══ 右：AI 对话（codex 视觉，AiChatCodex；唯一控制面） ══ */}
        <AiChatCodex
          {...props}
          onOpenChapter={openChapterNumber}
          mentionNames={mentionNames}
          rightOpen={effectiveRightOpen}
          // 展开/收起必须相对「当前实际显示态」翻——自动收起期间内部 rightOpen 仍是 true（用户默认意愿），
          // 盲目取反会把它翻成 false（点了等于没点，复审 T3 死点击的根因）。
          onToggleRight={() => { setAiManualToggled(true); setRightOpen(!effectiveRightOpen); }}
          onResizeStart={handleResizeStart}
          onResizeReset={() => setRightWidth(AI_DEFAULT_WIDTH)}
          // 输入框提示跟着当前页走：设定本里说改设定，历史里说撤销；写作台按写作进度提示。
          composerHint={view === "library" ? "想改哪条设定，直接说" : view === "history" ? "比如「撤销上一步」" : undefined}
          contextActions={contextActionsForView(view, cat)}
          onOpenModelSettings={() => setSettingsTab("model")}
          // 设置弹窗开 / 关都会翻转这个值 → AI 栏重读当前模型（改完模型关弹窗即生效）。
          modelRefreshKey={settingsTab === null ? 1 : 0}
        />
      </div>
      {palettePresence.mounted ? (
        <CommandPalette
          presence={palettePresence}
          onClose={() => setPaletteOpen(false)}
          chapters={paletteChapters}
          characters={paletteCharacters}
          librarySources={librarySearchSources}
          commands={paletteCommands}
          onPickChapter={(id) => {
            setView("desk");
            if (id === currentId) return;
            if (workspaceBusy) {
              useNavigationStore.getState().showToast("写作操作正在进行，请等本次操作结束后再切换章节。", 4600);
              return;
            }
            props.onSelectChapter?.(id);
          }}
          onPickCharacter={(name) => openInBible("chars", name)}
          onPickSetting={(target, focus) => openInBible(target, focus)}
          {...(searchBookText ? { searchText: searchBookText } : {})}
          onPickText={jumpToQuote}
        />
      ) : null}
      {/* 定稿清单（重构 P6）：定稿预览一到就弹；挂在最外层，专注模式、AI 栏收起时也弹得出来。 */}
      <CommitSheetHost busy={workspaceBusy} {...(props.onSuggestedAction ? { onSuggestedAction: props.onSuggestedAction } : {})} />
      <ExportDialog book={exportOpen && props.projectPath ? { title: projectName, projectPath: props.projectPath } : null} onClose={() => setExportOpen(false)} />
      {settingsPresence.mounted ? <SettingsModal tab={settingsTab ?? lastSettingsTabRef.current} onTab={setSettingsTab} onClose={() => setSettingsTab(null)} presence={settingsPresence} /> : null}
    </div>
  );
}
