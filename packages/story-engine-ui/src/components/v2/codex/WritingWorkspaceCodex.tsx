import { useEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import type { WritingWorkspaceLayoutProps } from "../../../types.js";
import type { ChapterNavItem } from "../../../type-defs/workspace.js";
import { useDisplaySettingsStore } from "../../../stores/displaySettingsStore.js";
import { useNavigationStore } from "../../../stores/navigationStore.js";
import AiChatCodex from "./AiChatCodex.js";
import WritingDeskCodex from "./WritingDeskCodex.js";
import AssetCodexPanel from "./AssetCodexPanel.js";
import CharacterCodexPanel from "./CharacterCodexPanel.js";
import CharacterMatrixCodexPanel from "./CharacterMatrixCodexPanel.js";
import HookCodexPanel from "./HookCodexPanel.js";
import LocationCodexPanel from "./LocationCodexPanel.js";
import TimelineCodexPanel from "./TimelineCodexPanel.js";
import WorldbuildingCodexPanel from "./WorldbuildingCodexPanel.js";
import WritingRulesCodexPanel from "./WritingRulesCodexPanel.js";
import { flattenCharacterSearchItem, searchLibraryIndex } from "./librarySearch.js";
import OperationHistoryView from "./OperationHistoryView.js";
import { ModelSettingsEmbedded } from "./ModelSettingsEmbedded.js";
import { DisplaySettingsEmbedded } from "./DisplaySettingsEmbedded.js";
import { SaveStatusPill } from "./SaveStatusPill.js";
import { countRealChapters } from "../../../api/stateOverviewAdapter.js";
import { defaultCenterViewForWorkspace } from "./starterGuidance.js";
import { isWorkspaceBusy } from "../../../utils/workspaceOperation.js";
import { chapterBareTitle, chapterHeading } from "../v2Utils.js";
import { IconChevronLeft, IconClose, IconFocus, IconPanelLeft, IconPanelRight, IconSearch, IconSettings } from "./icons.js";
import "./se-tokens.css";
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
 *  - 铁律不变：资料只读，改设定走右侧 AI 对话。
 */
// 章节不在「资料中心」类目里——它属于写作上下文，走「写作台」视图的章节竖轨。
const CATS = [
  { id: "world", glyph: "◈", title: "故事设定 · 世界观", sub: "概要 / 规则 / 资源 / 关系" },
  { id: "rules", glyph: "§", title: "写作规则", sub: "本书文风 · 避免机器腔" },
  { id: "matrix", glyph: "⬡", title: "角色关系", sub: "关系网 · 单角色近况" },
  { id: "chars", glyph: "♟", title: "角色", sub: "角色档案" },
  { id: "assets", glyph: "⚖", title: "道具与资源", sub: "物品归属" },
  { id: "places", glyph: "⌖", title: "地点", sub: "场景规则" },
  { id: "hooks", glyph: "❖", title: "伏笔线索", sub: "未回收 / 已回收" },
  { id: "timeline", glyph: "▤", title: "时间线", sub: "近期 · 中段 · 远期" },
] as const;

// 设定本左侧导航用的短名（CATS.title 保留给旧测试与搜索结果标签）。
const CAT_LABELS: Record<(typeof CATS)[number]["id"], string> = {
  world: "世界观", rules: "写作规则", matrix: "角色关系", chars: "角色",
  assets: "道具与资源", places: "地点", hooks: "伏笔与线索", timeline: "时间线",
};

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

type SettingsTab = "model" | "display";

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
    defaultCenterViewForWorkspace(props.workspace),
  );
  // 设置改成弹窗（不再占中栏整页），null = 关着。
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const [cat, setCat] = useState<string>("world");
  const [deskRailOpen, setDeskRailOpen] = useState(() => !focusWriting);
  const [chapterQuery, setChapterQuery] = useState("");
  const [libQuery, setLibQuery] = useState("");
  // 三处字号已上提到 displaySettingsStore（设置面板也读写同一份）。这里只读聊天/界面缩放。
  const chatZoom = useDisplaySettingsStore((s) => s.chatZoom);

  // P1-8：专注写作 = 复用两侧收起（章节栏 + AI 栏），状态由 displaySettings 记住。
  useEffect(() => {
    setDeskRailOpen(!focusWriting);
    setRightOpen(!focusWriting);
  }, [focusWriting]);

  // 出稿/续写一开始（useChat 在 generate_draft tool-call 时 requestCenterView("desk")）→ 自动切到写作台，
  // 让用户看着正文出现，不必手动点。一次性消费后清空，避免之后切走又被拽回。
  const pendingCenterView = useNavigationStore((s) => s.pendingCenterView);
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
  const catTitle = CATS.find((c) => c.id === cat)?.title ?? "";
  const crumbHere = view === "desk"
    ? chapterHeading(currentChapter.chapterNumber, currentChapter.title ?? "")
    : view === "library" ? `设定本 · ${CAT_LABELS[cat as keyof typeof CAT_LABELS] ?? catTitle}` : "操作历史";

  // 资料全局搜索（打磨D）：跨类目搜 sidebar 已聚合的分类标签，命中可一键跳到对应类目。
  // 世界观面板的数据是面板内单独拉取的（不在 props），故搜不到——只覆盖 sidebar 已有的 5 类。
  const librarySearchSources: readonly { readonly cat: string; readonly catLabel: string; readonly items: readonly string[] }[] = [
    { cat: "world", catLabel: "故事设定", items: props.sidebar.storySettings },
    { cat: "rules", catLabel: "写作规则", items: props.sidebar.writingRules },
    // 角色卡是 JSON 串：摊平成可读值串再喂搜索，结果不再是一坨 JSON（修 R2#5）。
    { cat: "chars", catLabel: "角色", items: props.sidebar.characters.map(flattenCharacterSearchItem) },
    { cat: "places", catLabel: "地点", items: props.sidebar.locations },
    { cat: "assets", catLabel: "道具与资源", items: props.sidebar.assets },
  ];
  const libQ = libQuery.trim().toLowerCase();
  const librarySearchResults = searchLibraryIndex(librarySearchSources, libQuery);

  // 拖动右缘改宽：pointer 拖动期间实时夹在 [min,max] 设宽，松手解绑监听。
  function handleResizeStart(event: ReactPointerEvent) {
    event.preventDefault();
    resizingRef.current = true;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    const onMove = (moveEvent: PointerEvent) => {
      if (!resizingRef.current) return;
      const next = Math.min(AI_MAX_WIDTH, Math.max(AI_MIN_WIDTH, window.innerWidth - moveEvent.clientX));
      setRightWidth(next);
    };
    const onUp = () => {
      resizingRef.current = false;
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  useEffect(() => {
    if (!settingsTab) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setSettingsTab(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settingsTab]);

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
  const chapterRows = buildChapterRows(visibleChapters, Boolean(chapterFilter));

  // 写作台章节栏展开时占的宽度（随界面字号放大），窄视口让位要扣掉它。
  const chapterRailWidth = view === "desk" && deskRailOpen ? Math.round(CHAPTER_RAIL_BASE_WIDTH * uiZoom) : 0;

  // T3：跟视口宽度走——右栏实际宽度 = min(用户拖的宽度, 视口装得下的宽度)；
  // 连右栏硬下限都装不下时默认自动收成 44px 竖条；用户没碰过展开/收起时窗口变宽自动恢复，
  // 点过之后以手动意愿为准（resolveRightPanelOpen，复审返工：修掉自动收起后展开钮死点击）。
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const aiWidthThatFits = viewportWidth - chapterRailWidth - MID_MIN_WIDTH;
  const aiAutoCollapsed = aiWidthThatFits < AI_FIT_MIN_WIDTH;
  const effectiveRightOpen = resolveRightPanelOpen(rightOpen, aiAutoCollapsed, aiManualToggled);
  const effectiveRightWidth = Math.max(AI_FIT_MIN_WIDTH, Math.min(rightWidth, aiWidthThatFits));

  return (
    <div
      className="codex-app"
      style={{ "--codex-chat-zoom": chatZoom, "--codex-ui-zoom": uiZoom } as CSSProperties}
    >
      {!gitAvailable && (
        <div className="env-warning-bar" role="alert">
          未检测到 git：快照与撤销功能不可用（写作不受影响）。安装 git 后重启应用即可恢复。
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
              title="章节列表"
              onClick={() => setDeskRailOpen(!deskRailOpen)}
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
          <button className={view === "library" ? "on" : ""} type="button" aria-pressed={view === "library"} onClick={() => setView("library")}>设定本</button>
          <button className={view === "history" ? "on" : ""} type="button" aria-pressed={view === "history"} onClick={() => setView("history")}>历史</button>
        </nav>
        <div className="se-top-r">
          <button
            className={`se-icon-btn${focusWriting ? " on" : ""}`}
            type="button"
            aria-label="专注写作"
            aria-pressed={focusWriting}
            title="专注写作（收起两侧）"
            onClick={() => {
              if (!focusWriting) setView("desk");
              useDisplaySettingsStore.getState().toggleFocusWriting();
            }}
          >
            <IconFocus />
          </button>
          <button className="se-icon-btn" type="button" aria-label="设置" title="设置" onClick={() => setSettingsTab("model")}>
            <IconSettings />
          </button>
          <button
            className={`se-icon-btn${effectiveRightOpen ? " on" : ""}`}
            type="button"
            aria-label={effectiveRightOpen ? "收起 AI 助手" : "展开 AI 助手"}
            aria-pressed={effectiveRightOpen}
            title="AI 助手"
            onClick={() => { setAiManualToggled(true); setRightOpen(!effectiveRightOpen); }}
          >
            <IconPanelRight />
          </button>
        </div>
      </header>
      <div className="app" style={{ gridTemplateColumns: `minmax(0, 1fr) ${effectiveRightOpen ? effectiveRightWidth : 44}px` }}>
        {/* ══ 中：资料中心 / 写作台 ══ */}
        <main className="desk">
          <div key={view} className="view-anim">
          {view === "history" ? (
            <OperationHistoryView projectPath={props.projectPath} />
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
                              onClick={() => { setCat(r.cat); setLibQuery(""); }}
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
                  {CATS.map((c) => (
                    <button
                      key={c.id}
                      className={`se-bnav-item${cat === c.id ? " on" : ""}`}
                      aria-current={cat === c.id ? "page" : undefined}
                      title={c.sub}
                      onClick={() => setCat(c.id)}
                      type="button"
                    >
                      {CAT_LABELS[c.id]}
                    </button>
                  ))}
                  <p className="se-bnav-note">设定由 AI 维护，这里只读。想改哪一处，直接在右边说。</p>
                </nav>
                <div className="read">
                  <div className="read-inner read-enter" key={cat}>
                    {cat === "world" ? <WorldbuildingCodexPanel projectPath={props.projectPath} fallbackData={props.workspace.worldbuildingFallback} onSendMessage={props.onSendMessage} /> : null}
                    {cat === "rules" ? <WritingRulesCodexPanel items={props.sidebar.writingRules} customNotes={props.sidebar.writingRulesCustomNotes} projectPath={props.projectPath} onSendMessage={props.onSendMessage} /> : null}
                    {cat === "matrix" ? <CharacterMatrixCodexPanel matrix={props.workspace.characterMatrix} protagonistName={props.workspace.protagonist?.name} projectPath={props.projectPath} currentChapter={currentChapter.chapterNumber} /> : null}
                    {cat === "chars" ? <CharacterCodexPanel assets={props.workspace.assets} characterMatrix={props.workspace.characterMatrix} location={props.workspace.location} projectPath={props.projectPath} protagonist={props.workspace.protagonist} sidebar={props.sidebar} onSendMessage={props.onSendMessage} /> : null}
                    {cat === "assets" ? <AssetCodexPanel assets={props.workspace.assets} projectPath={props.projectPath} onSendMessage={props.onSendMessage} /> : null}
                    {cat === "places" ? <LocationCodexPanel location={props.workspace.location} projectPath={props.projectPath} onSendMessage={props.onSendMessage} /> : null}
                    {cat === "hooks" ? <HookCodexPanel hookItems={props.overview?.hooks.activeItems ?? []} threadItems={props.overview?.threads.keyOpenItems ?? []} resolvedHookCount={props.overview?.hooks.resolvedCount ?? 0} doneThreadCount={props.overview?.threads.done ?? 0} projectPath={props.projectPath} onSendMessage={props.onSendMessage} /> : null}
                    {cat === "timeline" ? <TimelineCodexPanel timeline={props.overview?.timeline} /> : null}
                  </div>
                </div>
              </div>
            </>
          ) : (
            // 写作台视图：左侧章节列表（顶栏按钮开合 + 搜索，每 10 章一组）+ 右侧 WritingDeskCodex 稿纸。
            <div className="codex" style={{ gridTemplateColumns: deskRailOpen ? `calc(${CHAPTER_RAIL_BASE_WIDTH}px * var(--codex-ui-zoom)) minmax(0, 1fr)` : "minmax(0, 1fr)" }}>
              {deskRailOpen ? (
                <nav className="se-chapters" aria-label="章节">
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
                  <div className="se-ch-list">
                    {chapterRows.map((row) => row.kind === "group" ? (
                      <div key={row.key} className="se-ch-group">{row.label}</div>
                    ) : (
                      <button
                        key={row.ch.id}
                        className={`se-ch${row.ch.id === currentId ? " on" : ""}`}
                        disabled={workspaceBusy}
                        aria-current={row.ch.id === currentId ? "page" : undefined}
                        title={workspaceBusy ? "写作操作进行中，暂不能切换章节" : `${chapterHeading(row.ch.chapterNumber, row.ch.title ?? "")} · ${CHAPTER_STATUS_LABEL[row.ch.status]}`}
                        onClick={() => {
                          if (workspaceBusy) {
                            useNavigationStore.getState().showToast("写作操作正在进行，请等本次操作结束后再切换章节。", 4600);
                            return;
                          }
                          props.onSelectChapter?.(row.ch.id);
                        }}
                        type="button"
                      >
                        <span className="se-ch-n">{row.ch.chapterNumber}</span>
                        <span className={`se-ch-t${chapterBareTitle(row.ch.title ?? "") && row.ch.status !== "planned" ? "" : " untitled"}`}>{chapterBareTitle(row.ch.title ?? "") || "未命名"}</span>
                        <span className={`se-dot ${CHAPTER_STATUS_DOT[row.ch.status]}`} aria-hidden="true" />
                      </button>
                    ))}
                    {visibleChapters.length === 0 ? (
                      <div className="se-ch-empty">没有章名或章号包含「{chapterQuery.trim()}」的章节</div>
                    ) : null}
                  </div>
                </nav>
              ) : null}
              <WritingDeskCodex {...props} />
            </div>
          )}
          </div>
          {/* 保存状态 Pill：中栏底边右下角（.desk 相对定位），不再压右栏 AI 发送键（UI 审计 T8）。 */}
          <SaveStatusPill onRetry={props.onRetryAutosave} />
        </main>

        {/* ══ 右：AI 对话（codex 视觉，AiChatCodex；唯一控制面） ══ */}
        <AiChatCodex
          {...props}
          rightOpen={effectiveRightOpen}
          // 展开/收起必须相对「当前实际显示态」翻——自动收起期间内部 rightOpen 仍是 true（用户默认意愿），
          // 盲目取反会把它翻成 false（点了等于没点，复审 T3 死点击的根因）。
          onToggleRight={() => { setAiManualToggled(true); setRightOpen(!effectiveRightOpen); }}
          onResizeStart={handleResizeStart}
        />
      </div>
      {settingsTab ? (
        <>
          <div className="se-scrim" aria-hidden="true" onClick={() => setSettingsTab(null)} />
          <div className="se-modal" role="dialog" aria-modal="true" aria-label="设置">
            <nav className="se-modal-nav" aria-label="设置分类">
              <span className="se-modal-title">设置</span>
              <button className={settingsTab === "model" ? "on" : ""} type="button" onClick={() => setSettingsTab("model")}>模型</button>
              <button className={settingsTab === "display" ? "on" : ""} type="button" onClick={() => setSettingsTab("display")}>显示</button>
            </nav>
            <div className="se-modal-body">
              <button className="se-icon-btn se-modal-close" type="button" aria-label="关闭设置" onClick={() => setSettingsTab(null)}>
                <IconClose />
              </button>
              {settingsTab === "model"
                ? <ModelSettingsEmbedded onBack={() => setSettingsTab(null)} />
                : <DisplaySettingsEmbedded onBack={() => setSettingsTab(null)} />}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
