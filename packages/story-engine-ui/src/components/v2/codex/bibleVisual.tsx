/**
 * 设定本的图形小件（2026-10-20 设定本美化）：头像、出场条、关系图。
 * 只画已有的数据：头像是名字第一个字 + 按名字定的色，出场条是账里记的出场章，关系图是记下的关系。
 */
import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { BibleRelationView, CardKind } from "../../../api/bibleClient.js";
import { toneOf } from "../../../lib/tone.js";

export function firstGlyph(name: string): string {
  return Array.from(name.trim())[0] ?? "?";
}

/** 头像：人物是圆的，别的（地点 / 物品 / 设定）是方的。 */
export function Avatar({ name, kind, large }: { readonly name: string; readonly kind: CardKind; readonly large?: boolean }) {
  return (
    <span className={`se-bk-av tone-${toneOf(name)}${kind === "character" ? "" : " is-square"}${large ? " is-lg" : ""}`} aria-hidden="true">
      {firstGlyph(name)}
    </span>
  );
}

/** 出场条：全书一格一章，出场的章亮。章多了格子挤成细条，照样看得出疏密。 */
export function PresenceStrip({ chapters, total, large }: { readonly chapters: readonly number[]; readonly total: number; readonly large?: boolean }) {
  const n = Math.max(total, ...chapters, 0);
  if (n <= 0 || chapters.length === 0) return null;
  const inset = n <= 60 ? 0.14 : 0;
  return (
    <svg className={`se-bk-strip${large ? " is-lg" : ""}`} viewBox={`0 0 ${n} 1`} preserveAspectRatio="none" aria-hidden="true">
      {chapters.filter((ch) => ch >= 1 && ch <= n).map((ch) => (
        <rect key={ch} x={ch - 1 + inset} y={0} width={1 - inset * 2} height={1} />
      ))}
    </svg>
  );
}

const GRAPH_MAX = 12;
const GRAPH_H = 360;
const LABEL_MAX = 8;

interface GraphNode { readonly name: string; readonly x: number; readonly y: number; readonly center: boolean }

/** 关系图：主角（没有就是关系最多的那个）在中间，其余围一圈。人太多只画关系最多的 12 个，如实说。 */
export function RelationGraph({ relations, center, kindOf, onOpen }: {
  readonly relations: readonly BibleRelationView[];
  readonly center?: string;
  readonly kindOf: (name: string) => CardKind;
  readonly onOpen?: (name: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => { if (el.clientWidth > 0) setWidth(el.clientWidth); };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const layout = useMemo(() => graphLayout(relations, center, width), [relations, center, width]);
  if (layout.nodes.length < 2) return null;
  const at = new Map(layout.nodes.map((node) => [node.name, node] as const));
  return (
    <div className="se-bk-graph" ref={box}>
      <svg viewBox={`0 0 ${width} ${GRAPH_H}`} width={width} height={GRAPH_H} role="img" aria-label="关系图">
        {layout.edges.map((relation) => {
          const a = at.get(relation.a)!;
          const b = at.get(relation.b)!;
          const label = Array.from(relation.label);
          return (
            <g key={relation.id} className={`se-bk-edge${a.center || b.center ? " is-center" : ""}${relation.by === "ai" ? " is-ai" : ""}`}>
              <title>{`${relation.a} — ${relation.b}：${relation.label}`}</title>
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
              <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2} dy="0.35em">
                {label.length > LABEL_MAX ? `${label.slice(0, LABEL_MAX - 1).join("")}…` : relation.label}
              </text>
            </g>
          );
        })}
        {layout.nodes.map((node) => {
          const r = node.center ? 26 : 20;
          const square = kindOf(node.name) !== "character";
          return (
            <g key={node.name} className={`se-bk-node tone-${toneOf(node.name)}${node.center ? " is-center" : ""}`}
              transform={`translate(${node.x} ${node.y})`}
              {...(onOpen ? {
                role: "button",
                tabIndex: 0,
                "aria-label": `打开「${node.name}」`,
                onClick: () => onOpen(node.name),
                onKeyDown: (event: KeyboardEvent) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(node.name); } },
              } : {})}>
              {square ? <rect x={-r} y={-r} width={r * 2} height={r * 2} rx={8} /> : <circle r={r} />}
              <text className="se-bk-node-glyph" dy="0.35em">{firstGlyph(node.name)}</text>
              <text className="se-bk-node-name" y={r + 15}>{node.name}</text>
            </g>
          );
        })}
      </svg>
      {layout.hidden > 0 ? <p className="se-bk-hint">图里只画了关系最多的 {GRAPH_MAX} 个，还有 {layout.hidden} 个在下面的列表里。</p> : null}
    </div>
  );
}

export function graphLayout(relations: readonly BibleRelationView[], protagonist: string | undefined, width: number): {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly BibleRelationView[];
  readonly hidden: number;
} {
  const degree = new Map<string, number>();
  for (const relation of relations) {
    degree.set(relation.a, (degree.get(relation.a) ?? 0) + 1);
    degree.set(relation.b, (degree.get(relation.b) ?? 0) + 1);
  }
  const all = [...degree.keys()];
  if (all.length < 2) return { nodes: [], edges: [], hidden: 0 };
  const byDegree = [...all].sort((x, y) => (degree.get(y) ?? 0) - (degree.get(x) ?? 0));
  const centerName = protagonist && degree.has(protagonist) ? protagonist : byDegree[0]!;
  const kept = new Set([centerName, ...byDegree.filter((name) => name !== centerName).slice(0, GRAPH_MAX - 1)]);
  const edges = relations.filter((relation) => kept.has(relation.a) && kept.has(relation.b));
  // 圈上先排和中心有关系的（按记的顺序），再排别的：连中心的线不交叉。
  const linked = edges.flatMap((relation) => relation.a === centerName ? [relation.b] : relation.b === centerName ? [relation.a] : []);
  const ring = [...new Set([...linked, ...all.filter((name) => kept.has(name) && name !== centerName)])];
  const cx = width / 2;
  const cy = GRAPH_H / 2 - 6;
  const rx = Math.max(110, Math.min(width / 2 - 70, 300));
  const ry = GRAPH_H / 2 - 52;
  const start = ring.length <= 2 ? 0 : -Math.PI / 2;
  const nodes: GraphNode[] = [{ name: centerName, x: cx, y: cy, center: true }];
  ring.forEach((name, index) => {
    const angle = start + (index / ring.length) * Math.PI * 2;
    nodes.push({ name, x: cx + Math.cos(angle) * rx, y: cy + Math.sin(angle) * ry, center: false });
  });
  return { nodes, edges, hidden: all.length - kept.size };
}
