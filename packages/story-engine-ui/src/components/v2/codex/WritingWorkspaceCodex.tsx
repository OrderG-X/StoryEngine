import { useEffect, useRef, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import type { WritingWorkspaceLayoutProps } from "../../../types.js";
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
import "./codex.css";

/**
 * WritingWorkspaceCodex — 按 GLM 设计稿 codex.html 重做的写作工作区三栏外壳（落地进行中）。
 * 左=书架/导航；中=资料中心(codex 视觉) 或 写作台；右=AI 对话。
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

// 左栏（书架）基准宽度（px）。界面字号放大时按 uiZoom 放大，避免缩放后字挤/截断。
const RAIL_BASE_WIDTH = 188;

/** 资料类目卡的鼠标跟手金光：把指针在卡内坐标写进 --mx/--my，CSS ::after 径向光据此定位。 */
function trackCatLight(event: ReactMouseEvent<HTMLButtonElement>): void {
  const rect = event.currentTarget.getBoundingClientRect();
  event.currentTarget.style.setProperty("--mx", `${event.clientX - rect.left}px`);
  event.currentTarget.style.setProperty("--my", `${event.clientY - rect.top}px`);
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
  const [view, setView] = useState<"library" | "desk" | "history" | "settings" | "display">(() =>
    defaultCenterViewForWorkspace(props.workspace),
  );
  // 设置类整页占满全窗口（隐藏左右栏）；settings/display 之外的视图保持三栏。
  const isFullscreenView = (view as string) === "settings" || (view as string) === "display";
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

  // 左栏宽度随界面字号放大：避免放大后书架文字挤/截断。catrail（资料类目栏）宽度在 codex.css
  // 里用 calc(... * var(--codex-ui-zoom)) 同步放大。
  const railWidth = Math.round(RAIL_BASE_WIDTH * uiZoom);

  // T3：跟视口宽度走——右栏实际宽度 = min(用户拖的宽度, 视口装得下的宽度)；
  // 连右栏硬下限都装不下时默认自动收成 44px 竖条；用户没碰过展开/收起时窗口变宽自动恢复，
  // 点过之后以手动意愿为准（resolveRightPanelOpen，复审返工：修掉自动收起后展开钮死点击）。
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const aiWidthThatFits = viewportWidth - railWidth - MID_MIN_WIDTH;
  const aiAutoCollapsed = !isFullscreenView && aiWidthThatFits < AI_FIT_MIN_WIDTH;
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
      {/* 设置类整页（AI 设置/显示设置）隐藏右 AI 栏（保留左侧栏）：让设置页有更宽空间。
          其他视图保持三栏（第 3 列宽度可拖 rightWidth、随视口自动压缩 effectiveRightWidth；折叠/装不下时 44px 回收写作空间。左栏宽度随 uiZoom 放大）。 */}
      <div className="app" style={{ gridTemplateColumns: isFullscreenView ? `${railWidth}px minmax(0, 1fr)` : `${railWidth}px minmax(0, 1fr) ${effectiveRightOpen ? effectiveRightWidth : 44}px` }}>
        {/* ══ 左：书架 ══ */}
        <aside className="rail">
          <div
            className="brand"
            role="button"
            tabIndex={0}
            title="返回书架（首页）"
            style={{ cursor: "pointer" }}
            onClick={() => props.onGoHome?.()}
            onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); props.onGoHome?.(); } }}
          >
            <div className="mark">书</div>
            <div className="name">STORY ENGINE<small>写作引擎 · v2</small></div>
          </div>
          <div className="book">
            <div className="bk-title">{projectName}</div>
            <div className="bk-meta">长篇 · 当前第 {currentChapter.chapterNumber} 章</div>
            <div className="bk-meta" style={{ marginTop: 5 }}>共 {realChapterCount} 章</div>
          </div>
          <div className="nav-sec">导航</div>
          <button className={`nav-item ${view === "library" ? "on" : ""}`} onClick={() => setView("library")} type="button">
            <span className="ic">▦</span>资料中心
          </button>
          <button className={`nav-item ${view === "desk" ? "on" : ""}`} onClick={() => setView("desk")} type="button">
            <span className="ic">✎</span>写作台
          </button>
          <button className={`nav-item ${view === "settings" ? "on" : ""}`} onClick={() => setView("settings")} type="button" title="AI 服务与模型设置">
            <span className="ic">⚙</span>AI 设置
          </button>
          <button className={`nav-item ${view === "display" ? "on" : ""}`} onClick={() => setView("display")} type="button" title="界面显示与字号">
            <span className="ic">◐</span>显示设置
          </button>
          {/* 章节列表已移到「写作台」视图的章节竖轨（资料中心视图换章走「章节」类目）。 */}

          {/* 底部工具区：操作历史。用量入口已撤（流式草稿拿不回 provider usage、长期为 0，无实际意义）。 */}
          <div className="rail-spacer" />
          <div className="nav-sec">工具</div>
          <button className={`nav-item ${view === "history" ? "on" : ""}`} onClick={() => setView("history")} type="button" title="操作历史 / 快照恢复">
            <span className="ic">⟲</span>操作历史
          </button>
        </aside>

        {/* ══ 中：资料中心 / 写作台 ══ */}
        <main className="desk">
          <div key={view} className="view-anim">
          {view === "settings" ? (
            <ModelSettingsEmbedded onBack={() => setView("desk")} />
          ) : view === "display" ? (
            <DisplaySettingsEmbedded onBack={() => setView("desk")} />
          ) : view === "history" ? (
            <OperationHistoryView projectPath={props.projectPath} />
          ) : view === "library" ? (
            <>
              <div className="topbar">
                <div className="crumbs">
                  <b>{projectName}</b><span className="sep">/</span>
                  <span className="here">资料中心</span><span className="sep">/</span>
                  <span>{catTitle}</span>
                </div>
                <div className="right">
                  {/* 资料全局搜索（D）：跨类目找人/物/设定，点结果跳类目。 */}
                  <div className="lib-search-wrap">
                    <input
                      className="lib-search"
                      type="search"
                      value={libQuery}
                      onChange={(event) => setLibQuery(event.target.value)}
                      onKeyDown={(event) => { if (event.key === "Escape") setLibQuery(""); }}
                      placeholder="搜资料（人 / 物 / 设定）…"
                      aria-label="搜索资料"
                    />
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
                  {/* 资料字号已并入「设置 · 显示」面板（统一调，含左侧两栏）；此处旧步进器已撤。 */}
                  <span className="view-pill">只读视图 · 改设定请 <b>向右对 AI 说</b></span>
                </div>
              </div>
              <div className="codex">
                <nav className="catrail">
                  <div className="catrail-title">资料类目 · {CATS.length}</div>
                  {CATS.map((c, i) => (
                    <button
                      key={c.id}
                      className={`cat cat-enter ${cat === c.id ? "on" : ""}`}
                      style={{ animationDelay: `${i * 45}ms` }}
                      onClick={() => setCat(c.id)}
                      onMouseMove={trackCatLight}
                      type="button"
                    >
                      <span className="glyph">{c.glyph}</span>
                      <span className="ct"><b>{c.title}</b><small>{c.sub}</small></span>
                    </button>
                  ))}
                  <div className="catrail-foot">
                    <b>提示</b>　这是只读展示。要修改任何设定，请在右边对 AI 说——它会把改动同步回来。
                  </div>
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
            // 写作台视图：左侧章节竖轨（可收起 + 搜索）+ 右侧 WritingDeskCodex（codex 沉浸聚光稿纸）。
            // 章节竖轨也是 .catrail（被 uiZoom 缩放），展开时列宽随 uiZoom 放大，避免缩放后裁切。
            <div className="codex" style={{ gridTemplateColumns: deskRailOpen ? `calc(212px * var(--codex-ui-zoom)) minmax(0, 1fr)` : "44px minmax(0, 1fr)" }}>
              {deskRailOpen ? (
                <nav className="catrail" aria-label="章节">
                  <div className="catrail-head">
                    <span className="catrail-title">章节 · {realChapterCount}</span>
                    <button className="rail-collapse-btn" onClick={() => setDeskRailOpen(false)} type="button" title="收起章节栏" aria-label="收起章节栏">⟨</button>
                  </div>
                  <input
                    className="chap-search"
                    type="search"
                    value={chapterQuery}
                    onChange={(event) => setChapterQuery(event.target.value)}
                    placeholder="搜索章节（标题或章号）…"
                    aria-label="搜索章节"
                  />
                  {visibleChapters.map((ch) => {
                    const idx = chapters.indexOf(ch);
                    return (
                      <button
                        key={ch.id}
                        className={`cat ${ch.id === currentId ? "on" : ""}`}
                        disabled={workspaceBusy}
                        title={workspaceBusy ? "写作操作进行中，暂不能切换章节" : undefined}
                        onClick={() => {
                          if (workspaceBusy) {
                            useNavigationStore.getState().showToast("写作操作正在进行，请等本次操作结束后再切换章节。", 4600);
                            return;
                          }
                          props.onSelectChapter?.(ch.id);
                        }}
                        type="button"
                      >
                        <span className="glyph">{String(idx + 1).padStart(2, "0")}</span>
                        <span className="ct">
                          <b>{ch.title || `第 ${ch.chapterNumber} 章`}</b>
                          <small>第 {ch.chapterNumber} 章</small>
                        </span>
                      </button>
                    );
                  })}
                  {visibleChapters.length === 0 ? (
                    <div className="catrail-empty">没有匹配「{chapterQuery.trim()}」的章节</div>
                  ) : null}
                </nav>
              ) : (
                <nav className="catrail catrail-collapsed" aria-label="章节（已收起）">
                  <button className="rail-expand-btn" onClick={() => setDeskRailOpen(true)} type="button" title="展开章节栏" aria-label="展开章节栏">
                    <span aria-hidden="true">☰</span>
                    <span>章节</span>
                  </button>
                </nav>
              )}
              <WritingDeskCodex {...props} />
            </div>
          )}
          </div>
          {/* 保存状态 Pill：中栏底边右下角（.desk 相对定位），不再压右栏 AI 发送键（UI 审计 T8）。 */}
          <SaveStatusPill onRetry={props.onRetryAutosave} />
        </main>

        {/* ══ 右：AI 对话（codex 视觉，AiChatCodex；唯一控制面） ══ */}
        {!isFullscreenView && (
          <AiChatCodex
            {...props}
            rightOpen={effectiveRightOpen}
            // 展开/收起必须相对「当前实际显示态」翻——自动收起期间内部 rightOpen 仍是 true（用户默认意愿），
            // 盲目取反会把它翻成 false（点了等于没点，复审 T3 死点击的根因）。
            onToggleRight={() => { setAiManualToggled(true); setRightOpen(!effectiveRightOpen); }}
            onResizeStart={handleResizeStart}
          />
        )}
      </div>
    </div>
  );
}
