import { useEffect, useState } from "react";
import { fetchWorldbuilding, type WorldbuildingData } from "../../../api/worldbuildingClient.js";
import PanelEnrichButton from "./PanelEnrichButton.js";
import { CustomFieldsSection } from "./CustomFieldsSection.js";
import {
  filterSystemStoryMeta,
  isSystemStoryMetaSentence,
} from "../../../shared/sparse-panel-honesty.js";

/**
 * WorldbuildingCodexPanel — 世界观面板（codex 设计的数据驱动版，厚版全 section）。
 * 视觉照 GLM 设计稿 codex.html #p-world（样式在 codex.css，.codex-app 作用域），数据接 WorldbuildingData。
 * 厚版字段(worldRules/factions/specialElements/storyBinding/概要明细/隐藏目标/关系稳定性)由扩展后的
 * generate_worldbuilding 生成；旧数据缺这些字段时对应 section 自动降级隐藏，不造假。
 */
const ROMAN = ["Ⅰ", "Ⅱ", "Ⅲ", "Ⅳ", "Ⅴ", "Ⅵ", "Ⅶ", "Ⅷ", "Ⅸ", "Ⅹ"];

function has(s?: string): s is string {
  return typeof s === "string" && s.trim().length > 0;
}
function splitHead(text: string): readonly [string, string] {
  const m = text.split(/[:：]/);
  return [m[0]?.trim() ?? text, m.slice(1).join("：").trim()];
}

function H2({ no, title, cnt }: { readonly no: string; readonly title: string; readonly cnt?: string }) {
  return (
    <div className="h2">
      <span className="bar" /><span className="no">{no}</span><h2>{title}</h2><span className="tail" />
      {cnt ? <span className="cnt">{cnt}</span> : null}
    </div>
  );
}

type SpecCell = { readonly k: string; readonly v?: string; readonly full?: boolean; readonly tags?: readonly string[] };
function SpecGrid({ cells, mb }: { readonly cells: readonly SpecCell[]; readonly mb?: boolean }) {
  const visible = cells.filter((c) => has(c.v) || (c.tags && c.tags.length > 0));
  if (visible.length === 0) return null;
  return (
    <div className="spec" style={mb ? { marginBottom: 18 } : undefined}>
      {visible.map((c, i) => (
        <div key={i} className={`cell ${c.full ? "full" : ""}`}>
          <h5>{c.k}</h5>
          <div className="val">
            {c.tags ? c.tags.map((t, j) => <span key={j} className="kwd">{t}</span>) : c.v}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function WorldbuildingCodexPanel({
  projectPath,
  onSendMessage,
  data: dataProp,
  fallbackData,
  initialSub,
}: {
  readonly projectPath?: string | null;
  readonly onSendMessage?: (message: string) => void;
  readonly data?: WorldbuildingData | null;
  /** 加厚层 fetch 返回 null 时的兜底（引擎正典世界观）；data 显式传值时不生效。 */
  readonly fallbackData?: WorldbuildingData | null;
  readonly initialSub?: string;
}) {
  const [fetched, setFetched] = useState<WorldbuildingData | null>(null);
  const [sub, setSub] = useState<string>(initialSub ?? "overview");

  useEffect(() => {
    if (dataProp !== undefined) return;
    let alive = true;
    if (!projectPath) {
      setFetched(null);
      return;
    }
    void fetchWorldbuilding(projectPath).then((w) => {
      if (alive) setFetched(w);
    });
    return () => {
      alive = false;
    };
  }, [projectPath, dataProp]);

  const raw = dataProp !== undefined ? dataProp : (fetched ?? fallbackData ?? null);
  // 展示层兜底：滤系统元话术；滤完若无任何故事向内容 → 当空（老书不迁移也干净）。
  const w = sanitizeWorldbuildingForDisplay(raw);
  if (!w) {
    return (
      <section className="panel on" id="p-world">
        <div className="page-head">
          <div>
            <div className="kicker">World Foundation</div>
            <h1>故事设定 <em>·</em> 世界观</h1>
            <PanelEnrichButton onSendMessage={onSendMessage} intent="帮我把世界观补全" label="补全世界观" />
          </div>
        </div>
        <div className="catrail-foot panel-empty-center" style={{ marginTop: 40 }}>
          <b>还没有世界观</b>　去右边对 AI 说「帮我把世界观搭起来」，生成后这里就会铺开。
        </div>
      </section>
    );
  }

  const bind = w.storyBinding;
  const hasBinding = Boolean(
    bind && [bind.activeForces, bind.coreLocations, bind.usedElements, bind.conflictTypes, bind.forbidden, bind.toneSupport]
      .some((a) => a && a.length > 0),
  );
  const subtabs = [
    { id: "overview", no: "01", label: "概要 · 规则" },
    { id: "resources", no: "02", label: "资源库" },
    { id: "relations", no: "03", label: "关系层" },
    ...(hasBinding ? [{ id: "binding", no: "04", label: "本卷绑定" }] : []),
  ];

  return (
    <section className="panel on" id="p-world">
      <div className="page-head">
        <div>
          <div className="kicker">World Foundation</div>
          <h1>故事设定 <em>·</em> 世界观</h1>
          <PanelEnrichButton onSendMessage={onSendMessage} intent="帮我把世界观补全" label="补全世界观" />
          <p className="lead-sub">{has(w.overview.worldSentence) ? w.overview.worldSentence : w.overview.coreConflict}</p>
        </div>
        <div className="stats">
          <div className="stat"><b>{w.forces.length}</b><small>势力</small></div>
          {w.factions && w.factions.length > 0 ? <div className="stat"><b>{w.factions.length}</b><small>阵营</small></div> : <div className="stat"><b>{w.socialStructure.length}</b><small>圈层</small></div>}
          <div className="stat"><b>{w.rules.length}</b><small>法则</small></div>
          {w.specialElements && w.specialElements.length > 0 ? <div className="stat"><b>{w.specialElements.length}</b><small>要素</small></div> : <div className="stat"><b>{w.locations.length}</b><small>地点</small></div>}
        </div>
      </div>

      <div className="wb-hero">
        {has(w.overview.oneLine) && !isSystemStoryMetaSentence(w.overview.oneLine) ? (
          <p className="one serif">{w.overview.oneLine}</p>
        ) : null}
        <div className="wb-metas">
          <div className="wb-meta"><b>基调</b><span>{w.overview.tone}</span></div>
          <div className="wb-meta"><b>核心冲突</b><span>{w.overview.coreConflict}</span></div>
          {has(w.overview.coreTheme) ? <div className="wb-meta"><b>核心主题</b><span>{w.overview.coreTheme}</span></div> : null}
        </div>
      </div>

      {/* 世界观自定义字段（破例⑦展示）：从引擎正典兜底取 extraFields，即便做厚层覆盖了其余字段也照常显。 */}
      <CustomFieldsSection fields={fallbackData?.extraFields ?? w.extraFields} />

      <div className="subtabs">
        {subtabs.map((t) => (
          <button key={t.id} className={`subtab ${sub === t.id ? "on" : ""}`} onClick={() => setSub(t.id)} type="button">
            <span className="sub-no">{t.no}</span>{t.label}
          </button>
        ))}
      </div>

      {sub === "overview" ? <OverviewSub w={w} /> : null}
      {sub === "resources" ? <ResourcesSub w={w} /> : null}
      {sub === "relations" ? <RelationsSub w={w} /> : null}
      {sub === "binding" && hasBinding ? <BindingSub w={w} /> : null}
    </section>
  );
}

function OverviewSub({ w }: { readonly w: WorldbuildingData }) {
  const o = w.overview;
  const r = w.worldRules;
  return (
    <div className="subpanel on">
      <SpecGridSection
        no="01" title="世界概要" cnt="定调 · 非细节"
        cells={[
          { k: "世界名称", v: o.worldName },
          { k: "题材基底", v: o.genreBase },
          { k: "时代背景", v: o.era },
          { k: "核心主题", v: o.coreTheme },
          { k: "基调标签", full: true, tags: o.toneTags },
          { k: "世界一句话", full: true, v: o.worldSentence },
        ]}
      />

      {w.socialStructure.length > 0 ? (
        <>
          <H2 no="02" title="社会结构" cnt={`自上而下 · ${w.socialStructure.length} 层圈层`} />
          <div className="pyramid">
            {w.socialStructure.map((s, i) => {
              const [head, body] = splitHead(s);
              return (
                <div key={i} className={`tier t${Math.min(i + 1, 4)}`}>
                  <span className="roman">{ROMAN[i] ?? i + 1}</span>
                  <div className="body"><b>{head}</b>{body ? <p>{body}</p> : null}</div>
                </div>
              );
            })}
          </div>
        </>
      ) : null}

      {r && (has(r.realityStability) || has(r.supernaturalVisibility) || has(r.truthAccessibility) || has(r.narrativeLimit)) ? (
        <>
          <H2 no="03" title="世界法则" cnt="上位约束 · 不可违反" />
          <div className="h3"><span className="dot" />现实 / 超常 / 信息 规则</div>
          <SpecGrid
            mb
            cells={[
              { k: "现实稳定度", v: r.realityStability },
              { k: "超常可见性", v: r.supernaturalVisibility },
              { k: "真相可达性", v: r.truthAccessibility },
              { k: "叙事限制", v: r.narrativeLimit },
            ]}
          />
        </>
      ) : null}

      {w.rules.length > 0 ? (
        <>
          <div className="h3"><span className="dot" />{w.rules.length} 条铁律 · 法典</div>
          <div className="laws">
            {w.rules.map((rule, i) => (
              <div key={i} className="law">
                <div className="ix">{ROMAN[i] ?? i + 1}<small>条</small></div>
                <div className="law-body"><h4>{rule.name}</h4><p>{rule.detail}</p></div>
              </div>
            ))}
          </div>
        </>
      ) : (
        <div className="catrail-foot" style={{ marginTop: 18 }}>
          <b>还没有世界法则</b>　去右边对 AI 说「帮我定几条本书的世界铁律」，生成后这里会按法典列出。
        </div>
      )}
    </div>
  );
}

/** 带 H2 标题的 SpecGrid——空数据时整块（含标题）隐藏。 */
function SpecGridSection({
  no, title, cnt, cells,
}: {
  readonly no: string; readonly title: string; readonly cnt?: string; readonly cells: readonly SpecCell[];
}) {
  const visible = cells.filter((c) => has(c.v) || (c.tags && c.tags.length > 0));
  if (visible.length === 0) return null;
  return (
    <>
      <H2 no={no} title={title} cnt={cnt} />
      <SpecGrid cells={cells} />
    </>
  );
}

function ResourcesSub({ w }: { readonly w: WorldbuildingData }) {
  let n = 0;
  const next = () => String(++n).padStart(2, "0");
  return (
    <div className="subpanel on">
      {w.factions && w.factions.length > 0 ? (
        <>
          <H2 no={`02·${next()}`} title="阵营" cnt="思想立场 · 非组织" />
          <div className="res-grid">
            {w.factions.map((f, i) => (
              <div key={i} className="res-card">
                <div className="rch"><b>{f.name}</b></div>
                <div className="rcr"><span className="k">核心立场</span><span className="v">{f.stance}</span></div>
                <div className="rcr"><span className="k">长期目标</span><span className="v">{f.longTermGoal}</span></div>
                <div className="rcr"><span className="k">最大恐惧</span><span className="v">{f.fear}</span></div>
                <div className="rcr"><span className="k">叙事价值</span><span className="v">{f.narrativeValue}</span></div>
              </div>
            ))}
          </div>
        </>
      ) : null}

      {w.forces.length > 0 ? (
        <>
          <H2 no={`02·${next()}`} title="势力" cnt={`${w.forces.length} 方角力 · 含施压方式`} />
          <div className="forces">
            {w.forces.map((f, i) => (
              <article key={i} className={`force ${i === 0 ? "lead" : ""}`}>
                <div className="force-head">
                  <div className="glyph">{(f.name || "势").slice(0, 1)}</div>
                  <div className="force-name"><h3>{f.name}</h3>{f.type ? <div className="role">{f.type}</div> : null}</div>
                </div>
                {f.resources ? <div className="fseg"><span className="k">资源</span><span className="v">{f.resources}</span></div> : null}
                {f.objective ? <div className="fseg obj"><span className="k obj">目标</span><span className="v">{f.objective}</span></div> : null}
                {has(f.hiddenObjective) ? <div className="fseg hidden"><span className="k hid">隐藏目标</span><span className="v">{f.hiddenObjective}</span></div> : null}
                {f.pressure ? <div className="fseg press"><span className="k press">施压方式</span><span className="v">{f.pressure}</span></div> : null}
              </article>
            ))}
          </div>
        </>
      ) : null}

      {w.specialElements && w.specialElements.length > 0 ? (
        <>
          <H2 no={`02·${next()}`} title="特殊要素" cnt="推动情节的机关" />
          <div className="res-grid">
            {w.specialElements.map((e, i) => (
              <div key={i} className="res-card">
                <div className="rch"><span className="ric">★</span><b>{e.name}</b>{e.type ? <span className="rtype tag warn">{e.type}</span> : null}</div>
                <div className="rcr"><span className="k">作用</span><span className="v">{e.effect}</span></div>
                <div className="rcr"><span className="k">使用代价</span><span className="v">{e.cost}</span></div>
                <div className="rcr"><span className="k">掌控者</span><span className="v">{e.controller}</span></div>
                <div className="rcr"><span className="k">剧情价值</span><span className="v">{e.plotValue}</span></div>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

function RelationsSub({ w }: { readonly w: WorldbuildingData }) {
  let n = 0;
  const next = () => String(++n).padStart(2, "0");
  return (
    <div className="subpanel on">
      {w.relations.length > 0 && w.forces.length > 0 ? (
        <>
          <H2 no={`03·${next()}`} title="势力关系网" cnt={`${w.relations.length} 组核心关系`} />
          <ForceGraph forces={w.forces} relations={w.relations} />
          <H2 no={`03·${next()}`} title="关系明细" cnt="含稳定性" />
          <div className="spec">
            {w.relations.map((r, i) => {
              const [label] = splitHead(r.relation);
              return (
                <div key={i} className="cell full">
                  <h5>{r.from} → {r.to}</h5>
                  <div className="val">
                    <span className="tag info">{label}</span>
                    {has(r.stability) ? <span className="tag">{r.stability}</span> : null}
                    {"　"}{r.relation}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      ) : null}

      {w.conflictSources.length > 0 ? (
        <>
          <H2 no={next()} title="核心冲突来源" cnt={`${w.conflictSources.length} 条引爆线`} />
          <div className="conflicts">
            {w.conflictSources.map((c, i) => {
              const [head, body] = splitHead(c);
              return (
                <div key={i} className="conflict">
                  <span className="cn">{String(i + 1).padStart(2, "0")}</span>
                  <p>{body ? <><b>{head}</b>　{body}</> : c}</p>
                </div>
              );
            })}
          </div>
        </>
      ) : null}

      {w.storyEntries.length > 0 ? (
        <>
          <H2 no={next()} title="开局方向" cnt="可直接开写" />
          <div className="entries">
            {w.storyEntries.map((e, i) => (
              <article key={i} className="entry">
                <div className="et"><span className="hook-no">HOOK {String(i + 1).padStart(2, "0")}</span><b>{e.title}</b></div>
                <p>{e.hook}</p>
              </article>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

function BindingSub({ w }: { readonly w: WorldbuildingData }) {
  const b = w.storyBinding;
  if (!b) return null;
  const cells: readonly { readonly k: string; readonly items?: readonly string[] }[] = [
    { k: "激活势力", items: b.activeForces },
    { k: "核心舞台地点", items: b.coreLocations },
    { k: "调用特殊要素", items: b.usedElements },
    { k: "适配冲突类型", items: b.conflictTypes },
    { k: "禁止组合", items: b.forbidden },
    { k: "基调支撑", items: b.toneSupport },
  ];
  const visible = cells.filter((c) => c.items && c.items.length > 0);
  return (
    <div className="subpanel on">
      <H2 no="04" title="本卷故事绑定" cnt="从世界全量裁出的有效切片" />
      <p className="lede" style={{ marginBottom: 18 }}>
        世界里存的是「全量可能性」，本卷只激活其中少量有效元素——下面是本卷从世界资源中挑出的局部舞台。
      </p>
      <div className="bind">
        {visible.map((c, i) => (
          <div key={i} className="cell">
            <h5>{c.k}</h5>
            <ul>{c.items!.map((it, j) => <li key={j}>{it}</li>)}</ul>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 势力关系网（动态圆形布局，先 SVG 示意；落地阶段换 React Flow 可拖拽）。 */
function ForceGraph({
  forces,
  relations,
}: {
  readonly forces: WorldbuildingData["forces"];
  readonly relations: WorldbuildingData["relations"];
}) {
  const W = 820, H = 460, cx = W / 2, cy = H / 2;
  const rx = Math.min(310, 150 + forces.length * 12), ry = 150;
  const pos = new Map<string, { x: number; y: number }>();
  forces.forEach((f, i) => {
    const a = ((-90 + (360 * i) / forces.length) * Math.PI) / 180;
    pos.set(f.name, { x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) });
  });
  return (
    <div className="graph-wrap">
      <div className="ghd">势力关系拓扑 · 节点 = 势力 · 连线 = 关系</div>
      <svg className="graph" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
        <defs>
          <marker id="ar" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">
            <path d="M0,0 L7,3 L0,6 Z" className="arrow" />
          </marker>
        </defs>
        {relations.map((r, i) => {
          const a = pos.get(r.from), b = pos.get(r.to);
          if (!a || !b) return null;
          const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
          const [label] = splitHead(r.relation);
          return (
            <g key={i}>
              <path d={`M${a.x},${a.y} L${b.x},${b.y}`} className="edge" markerEnd="url(#ar)" />
              <g transform={`translate(${mx},${my})`}>
                <rect x="-46" y="-13" width="92" height="26" rx="13" className="edge-pill" />
                <text x="0" y="4" textAnchor="middle" className="edge-label">{label.slice(0, 6)}</text>
              </g>
            </g>
          );
        })}
        {forces.map((f, i) => {
          const p = pos.get(f.name);
          if (!p) return null;
          return (
            <foreignObject key={i} x={p.x - 92} y={p.y - 38} width="184" height="76">
              <div className={`gnode-card ${i === 0 ? "hot" : ""}`}>
                {i === 0 ? <span className="gn-dot" /> : null}
                <div className="gn-name">{f.name}</div>
                {f.type ? <div className="gn-role">{f.type}</div> : null}
              </div>
            </foreignObject>
          );
        })}
      </svg>
      <div className="gfoot">
        <span style={{ marginLeft: "auto", color: "var(--muted)" }}>SVG 示意 · 落地阶段将以 React Flow 实现可拖拽</span>
      </div>
    </div>
  );
}

/** 展示层：滤系统元话术；滤完若无故事向实质内容则视为空。 */
function sanitizeWorldbuildingForDisplay(w: WorldbuildingData | null): WorldbuildingData | null {
  if (!w) return null;
  const rules = w.rules.filter((r) => has(r.detail) && !isSystemStoryMetaSentence(r.detail));
  const socialStructure = filterSystemStoryMeta(w.socialStructure);
  const conflictSources = filterSystemStoryMeta(w.conflictSources);
  const oneLine = has(w.overview.oneLine) && !isSystemStoryMetaSentence(w.overview.oneLine)
    ? w.overview.oneLine
    : "";
  const next: WorldbuildingData = {
    ...w,
    overview: {
      ...w.overview,
      oneLine,
      coreConflict: isSystemStoryMetaSentence(w.overview.coreConflict) ? "" : w.overview.coreConflict,
    },
    rules,
    socialStructure,
    conflictSources,
  };
  const empty =
    rules.length === 0 &&
    socialStructure.length === 0 &&
    next.forces.length === 0 &&
    conflictSources.length === 0 &&
    next.locations.length === 0 &&
    !(next.factions && next.factions.length > 0) &&
    !(next.specialElements && next.specialElements.length > 0) &&
    !has(oneLine) &&
    !has(next.overview.coreConflict) &&
    !has(next.overview.tone) &&
    !has(next.overview.worldSentence);
  return empty ? null : next;
}
