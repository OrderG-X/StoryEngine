import { useEffect, useState } from "react";
import type { LocationDetailStatus, LocationStatus } from "../../../types.js";
import PanelEnrichButton from "./PanelEnrichButton.js";
import { fetchLocationEnrichment, type LocationEnrichmentData } from "../../../api/locationEnrichmentClient.js";
import { uiJoin, uiList, uiText } from "../v2Utils.js";
import { CustomFieldsSection } from "./CustomFieldsSection.js";
import { isPlaceholderUiValue } from "../../../shared/sparse-panel-honesty.js";

/**
 * LocationCodexPanel — 地点面板（codex 设计的数据驱动版，厚版全 section）。
 * 视觉照 GLM 设计稿 codex.html #p-places（.locs/.loc/.loc-top + .loc-grid 九宫格 + .layout 楼层房间，
 * 样式在 codex.css，作用域 .codex-app），接与现有 LocationPanel 完全一致的真实数据
 * （props.location，可无缝替换）。整页与空状态遵循 WorldbuildingCodexPanel 范式。
 *
 * 与上一版「降级版」的关键区别：codex 设计稿里 .loc-grid 的**所有 section 版式都写出来**，
 * 不再整块省略。引擎已有的字段直接接、有则显；codex 比引擎厚、引擎暂未生成的字段，
 * 加成**可选 props**（thickFields），有则渲染对应 .loc-cell、无则该格降级隐藏（绝不编造）。
 *
 * codex 九宫格对照（按设计稿 .loc-grid 的顺序与变体）：
 *   1) 表面印象 surfaceImpression  → 暂无引擎字段，可选 prop，无则隐藏
 *   2) 隐藏真相 hiddenFacts  .hid  → 引擎有（LocationDetailStatus.hiddenFacts）
 *   3) 叙事功能 narrativeFunction  → 引擎有
 *   4) 常见风险 risks       .alert → 引擎有
 *   5) 进入限制 entryRestriction   → 暂无引擎字段，可选 prop，无则隐藏
 *   6) 离开代价 exitCost     .alert → 暂无引擎字段，可选 prop，无则隐藏
 *   7) 当前状态 currentStatus      → 引擎有
 *   8) 关联势力 associatedForces   → 暂无引擎字段，可选 prop，无则隐藏
 *   9) 物品可用 resources          → 引擎有
 * 引擎里有、设计稿没单列的真实字段（场景质感/可能冲突/固定事实/移动规则/相邻地点）补成额外 .loc-cell，避免丢真数据。
 * .layout 区按设计稿用 .lfloor + .lroom + .larrow（房间间用「·」分隔符）复刻空间结构。
 *
 * 可选 props（厚字段）按 location.locations 的下标对齐：thickFields[i] 对应第 i 张地点卡。
 * 后续做厚生成数据后，外壳把厚字段一并传入即可自动填满对应 section，本文件无需再改。
 */
const GLYPHS = ["⌂", "⬛", "♞", "▲", "◈", "★", "⬡", "✦"];

/** codex 比引擎厚、引擎暂未生成的「每地点」字段。有则渲染对应 .loc-cell，无则该格降级隐藏。 */
export interface LocationThickFields {
  /** 表面印象（.loc-cell）——外人/初见时的观感。 */
  readonly surfaceImpression?: string;
  /** 进入限制（.loc-cell）——进入需要的条件/权限。 */
  readonly entryRestriction?: string;
  /** 离开代价（.loc-cell .alert）——离开会留下的把柄/代价。 */
  readonly exitCost?: string;
  /** 关联势力（.loc-cell）——暗中盯着/实控此地的势力。 */
  readonly associatedForces?: string;
  /** 状态标签（.loc-st 的 tag 文案）——如「高危 · 监控中」，无则用真实 currentStatus 或当前标记。 */
  readonly statusTag?: string;
  /** 状态标签色调：warn=偏黄、danger=偏红，无则默认 warn。 */
  readonly statusTone?: "warn" | "danger" | "neutral";
}

interface LocCellView {
  readonly label: string;
  readonly value: string;
  /** "hid" = 隐藏真相强调；"alert" = 风险/代价类红字。 */
  readonly tone?: "hid" | "alert";
}

interface LocCardView {
  readonly key: string;
  readonly name: string;
  readonly glyph: string;
  /** kind · position（已清洗，可能为空）。 */
  readonly where: string;
  readonly statusTag?: string;
  readonly statusTone: "warn" | "danger" | "neutral";
  readonly cells: readonly LocCellView[];
  readonly floors: readonly string[];
  readonly rooms: readonly string[];
  readonly extraFields?: Readonly<Record<string, string | readonly string[]>>;
}

function cell(label: string, value: string, tone?: "hid" | "alert"): LocCellView | null {
  const text = uiText(value, "");
  if (!text || isPlaceholderUiValue(text)) return null;
  return { label, value: text, tone };
}

/** 按 codex.html #p-places 的九宫格顺序拼 cells；厚字段缺省时对应格自动消失。 */
function detailToCard(
  item: LocationDetailStatus,
  index: number,
  isCurrent: boolean,
  thick?: LocationThickFields,
): LocCardView {
  const status = uiText(item.currentStatus, "");
  const cells = [
    // 1) 表面印象（厚字段，暂无引擎数据 → 无则隐藏）
    thick?.surfaceImpression ? cell("表面印象", thick.surfaceImpression) : null,
    // 2) 隐藏真相（引擎有，.hid）
    cell("隐藏真相", uiJoin(item.hiddenFacts, ""), "hid"),
    // 3) 叙事功能（引擎有）
    cell("叙事功能", uiText(item.narrativeFunction, "")),
    // 4) 常见风险（引擎有，.alert）
    cell("常见风险", uiJoin(item.risks, ""), "alert"),
    // 5) 进入限制（厚字段 → 无则隐藏）
    thick?.entryRestriction ? cell("进入限制", thick.entryRestriction) : null,
    // 6) 离开代价（厚字段，.alert → 无则隐藏）
    thick?.exitCost ? cell("离开代价", thick.exitCost, "alert") : null,
    // 7) 当前状态（引擎有）
    cell("当前状态", status),
    // 8) 关联势力（厚字段 → 无则隐藏）
    thick?.associatedForces ? cell("关联势力", thick.associatedForces) : null,
    // 9) 物品可用（引擎有）
    cell("物品可用", uiJoin(item.resources, "")),
    // 引擎里有、设计稿没单列的真实字段 → 补成额外格，避免丢真数据
    cell("场景质感", uiJoin(item.sensory, "")),
    cell("可能冲突", uiJoin(item.possibleConflicts, ""), "alert"),
    cell("固定事实", uiJoin(item.fixedFacts, "")),
    cell("相邻地点", uiJoin(item.nearbyLocations, "")),
    cellFromList("移动规则", item.travelRules),
  ].filter((c): c is LocCellView => c !== null);

  const kind = uiText(item.type, "");
  const position = uiText(item.currentKnownPosition ?? item.parentLocation, "");
  return {
    key: item.id || item.name || `loc-${index}`,
    name: uiText(item.name, "未命名地点"),
    glyph: GLYPHS[index % GLYPHS.length] ?? "⌂",
    where: [kind, position].filter(Boolean).join(" · "),
    statusTag: thick?.statusTag || (isCurrent ? "当前地点" : status || undefined),
    statusTone: thick?.statusTone ?? (isCurrent ? "warn" : "neutral"),
    cells,
    floors: uiList(item.floors),
    rooms: uiList(item.rooms),
    ...(item.extraFields ? { extraFields: item.extraFields } : {}),
  };
}

function cellFromList(label: string, values: readonly string[] | undefined, tone?: "hid" | "alert"): LocCellView | null {
  const list = uiList(values);
  return list.length > 0 ? { label, value: list.join("；"), tone } : null;
}

/** location.locations 缺失时的降级：仅用顶层字段拼一张「当前地点」卡（仍走全 section 版式）。 */
function currentToCard(location: LocationStatus, thick?: LocationThickFields): LocCardView {
  const cells = [
    thick?.surfaceImpression ? cell("表面印象", thick.surfaceImpression) : null,
    cell("常见风险", uiJoin(location.risks, ""), "alert"),
    thick?.entryRestriction ? cell("进入限制", thick.entryRestriction) : null,
    thick?.exitCost ? cell("离开代价", thick.exitCost, "alert") : null,
    thick?.associatedForces ? cell("关联势力", thick.associatedForces) : null,
    cell("物品可用", uiJoin(location.resources, "")),
    cell("固定事实", uiJoin(location.fixedFacts, "")),
    cell("相邻地点", uiJoin(location.nearbyLocations, "")),
    cellFromList("移动规则", location.travelRules),
  ].filter((c): c is LocCellView => c !== null);

  return {
    key: "current",
    name: uiText(location.currentLocation, "当前地点"),
    glyph: GLYPHS[0] ?? "⌂",
    where: uiText(location.currentPosition, ""),
    statusTag: thick?.statusTag || "当前地点",
    statusTone: thick?.statusTone ?? "warn",
    cells,
    floors: uiList(location.floors),
    rooms: uiList(location.rooms),
  };
}

function buildCards(
  location: LocationStatus,
  thickFields?: readonly (LocationThickFields | undefined)[],
): readonly LocCardView[] {
  if (location.locations && location.locations.length > 0) {
    const currentName = uiText(location.currentLocation).replace(/\s+/gu, "");
    return location.locations
      .filter((item) => !isPlaceholderUiValue(item.name))
      .map((item, index) =>
        detailToCard(item, index, uiText(item.name).replace(/\s+/gu, "") === currentName, thickFields?.[index]),
      );
  }
  // 无地点明细且当前地点也是占位/空 → 不造假卡。
  if (isPlaceholderUiValue(location.currentLocation) || !uiText(location.currentLocation, "")) {
    return [];
  }
  return [currentToCard(location, thickFields?.[0])];
}

/**
 * 把做厚结果 byLocation（地点名 → 厚字段）按 location.locations 的顺序映射成 thickFields 数组，
 * 对上面板按下标对齐的渲染逻辑。生成器以地点名为键（StateOverviewLocationDetailItem.name，
 * 与 LocationDetailStatus.name 同源），故此处按 loc.name 逐张取对应厚字段（取不到 → undefined → 该卡全降级）。
 * location.locations 缺失时退化到单张「当前地点」卡，用 currentLocation 名取键。
 */
function mapByLocationToThick(
  location: LocationStatus,
  byLocation: Readonly<Record<string, LocationThickFields>> | undefined,
): readonly (LocationThickFields | undefined)[] | undefined {
  if (!byLocation) return undefined;
  const pick = (name: string): LocationThickFields | undefined => {
    const exact = byLocation[name];
    if (exact) return exact;
    const trimmed = byLocation[name.trim()];
    return trimmed ?? undefined;
  };
  if (location.locations && location.locations.length > 0) {
    return location.locations.map((item) => pick(uiText(item.name, "")));
  }
  return [pick(uiText(location.currentLocation, ""))];
}

function statusTagClass(tone: "warn" | "danger" | "neutral"): string {
  if (tone === "danger") return "tag danger";
  if (tone === "neutral") return "tag";
  return "tag warn";
}

export default function LocationCodexPanel({
  location,
  projectPath,
  thickFields,
  onSendMessage,
}: {
  readonly location: LocationStatus;
  /**
   * 项目路径：传了就按 WorldbuildingCodexPanel 的模式拉 .story-engine-ui/location-enrichment.json
   * （byLocation:地点名→厚字段），按 location.locations 顺序映射成 thickFields 数组填补对应 .loc-cell
   * （显式 thickFields prop 仍优先；fixture 预览不传 projectPath，故预览不受影响）。
   */
  readonly projectPath?: string | null;
  readonly onSendMessage?: (message: string) => void;
  /**
   * codex 比引擎厚、引擎暂未生成的「每地点」字段，按 location.locations 下标对齐。
   * 有则渲染对应 .loc-cell（表面印象/进入限制/离开代价/关联势力 等），无则该格降级隐藏。
   * 后续做厚生成数据后由外壳传入即可自动填满，本文件无需再改。
   */
  readonly thickFields?: readonly LocationThickFields[];
}) {
  const [fetched, setFetched] = useState<LocationEnrichmentData | null>(null);
  useEffect(() => {
    let alive = true;
    if (!projectPath) {
      setFetched(null);
      return;
    }
    void fetchLocationEnrichment(projectPath).then((e) => {
      if (alive) setFetched(e);
    });
    return () => {
      alive = false;
    };
  }, [projectPath]);

  // 显式 thickFields 优先；否则把 fetch 到的 byLocation（地点名→厚字段）按 location.locations 顺序
  // 映射成数组，对上面板按下标对齐的渲染逻辑（projectPath 为空 / 还没做过厚 → undefined，全降级）。
  const effThickFields = thickFields ?? mapByLocationToThick(location, fetched?.byLocation);

  const cards = buildCards(location, effThickFields);
  const isEmpty = cards.length === 0;

  return (
    <section className="panel on" id="p-places">
      <div className="page-head">
        <div>
          <div className="kicker">场景资料</div>
          <h1>地点</h1>
          <PanelEnrichButton onSendMessage={onSendMessage} intent="帮我补全地点资料" label="✦ 补全地点" />
          {!isEmpty ? (
            <p className="lead-sub">每个地点的氛围、秘密、能发生什么和行动限制都在这里。已有资料会直接显示，暂时没有的内容不会硬凑。</p>
          ) : null}
        </div>
        {!isEmpty ? (
          <div className="stats">
            <div className="stat"><b>{cards.length}</b><small>地点</small></div>
          </div>
        ) : null}
      </div>

      {isEmpty ? (
        <div className="catrail-foot panel-empty-center" style={{ marginTop: 40 }}>
          <b>还没有地点资料</b>　去右边对 AI 说「帮我整理这章会用到的地点」，AI 会把地点资料整理在这里。
        </div>
      ) : (
        <div className="locs">
          {cards.map((card) => (
            <article key={card.key} className="loc">
              <div className="loc-top">
                <div className="lg">{card.glyph}</div>
                <div>
                  <h3>{card.name}</h3>
                  {card.where ? <div className="loc-where">{card.where}</div> : null}
                </div>
                {card.statusTag ? (
                  <span className="loc-st"><span className={statusTagClass(card.statusTone)}>{card.statusTag}</span></span>
                ) : null}
              </div>

              {card.cells.length > 0 ? (
                <div className="loc-grid">
                  {card.cells.map((c, i) => (
                    <div key={`${card.key}-${c.label}-${i}`} className={c.tone ? `loc-cell ${c.tone}` : "loc-cell"}>
                      <h6>{c.label}</h6>
                      <p>{c.value}</p>
                    </div>
                  ))}
                </div>
              ) : null}

              {card.floors.length > 0 || card.rooms.length > 0 ? (
                <div className="layout">
                  {card.floors.map((floor) => <span key={`f-${floor}`} className="lfloor">{floor}</span>)}
                  {card.rooms.map((room, i) => (
                    <span key={`room-${card.key}-${i}`}>
                      {i > 0 ? <span className="larrow">·</span> : null}
                      <span className="lroom">{room}</span>
                    </span>
                  ))}
                </div>
              ) : null}

              <CustomFieldsSection fields={card.extraFields} />
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
