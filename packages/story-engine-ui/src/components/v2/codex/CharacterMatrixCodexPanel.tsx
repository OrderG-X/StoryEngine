import type {
  StateOverviewCharacterMatrix,
  StateOverviewCharacterMatrixItem,
  StateOverviewCharacterRelationship,
} from "../../../api/types.js";
import { buildCharacterGraphModel, type GraphRelationshipInput } from "./characterGraph.js";
import { matrixPanelCopy } from "./matrixPanelCopy.js";

/**
 * CharacterMatrixCodexPanel — 角色矩阵面板（对标 inkos 的精简版）。
 *
 * inkos 的角色矩阵 = 每个角色只看 4 样：
 *   - 当前：此刻在干嘛（character.currentGoal）
 *   - 关系：跟谁有关系（对象名 · relationType · 第N章）
 *   - 已知：他知道什么（character.knownFacts）
 *   - 未知：他不知道什么（character.unknownTruths）
 *
 * 数据全部读引擎 canonical StateOverviewCharacterMatrix（与同级 ../CharacterMatrixPanel.tsx 同源）。
 * 「有数据则显 / 无则该行隐藏 / 绝不造假」。关系以主角为隐含起点（主角→各目标），主角的卡列全部
 * relationships；非主角角色 X 的卡取 relationships 里 targetName===X.name 的那条、渲成「主角 · …」。
 *
 * 下方保留 CharacterForceGraph 关系网（一眼看全谁跟谁、信任度配色，只读可视化）。
 * 必须渲染在 .codex-app 作用域下（codex.css 作用域，由外壳包裹）。
 */

function trim(value?: string): string {
  return value?.trim() ?? "";
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((v) => v.trim()).filter((v) => v.length > 0))];
}

/** 一条关系渲成 inkos 的「对象名 · relationType · 第N章」（缺章号则省略章号段）。 */
function formatRelationLine(targetLabel: string, relationship: StateOverviewCharacterRelationship): string {
  const parts = [targetLabel];
  const relationType = trim(relationship.relationType);
  if (relationType) parts.push(relationType);
  if (relationship.lastChangedChapter) parts.push(`第 ${relationship.lastChangedChapter} 章`);
  return parts.join(" · ");
}

export default function CharacterMatrixCodexPanel({
  matrix,
  protagonistName: propProtagonistName,
}: {
  readonly matrix?: StateOverviewCharacterMatrix;
  /** 权威主角名（来自 ProtagonistStatus.name）；传了就按名字定主角，避免被职能描述里含「主角」二字的配角骗。 */
  readonly protagonistName?: string;
  /** 外壳仍可传，但精简版不再消费（保留以兼容调用方）。 */
  readonly projectPath?: string | null;
  /** 外壳仍可传，但精简版不再消费（保留以兼容调用方）。 */
  readonly currentChapter?: number | null;
}) {
  const characters = matrix?.characters ?? [];
  const relationships = matrix?.relationships ?? [];

  if (!characters.length) {
    return (
      <div className="read-inner">
        <div className="catrail-foot" style={{ marginTop: 40 }}>
          <b>还没有角色关系</b>　去右边对 AI 说「帮我整理角色关系」，AI 会把角色之间的联系、立场和变化整理在这里。
        </div>
      </div>
    );
  }

  // 主角名：权威值优先（ProtagonistStatus.name），否则回落职能含「主角」者、再回落第一个角色。
  // 不再纯靠 role.includes("主角")——做厚后 role 是「叙事岗位」长描述，配角描述里可能含「作为主角的竞争对手」会误判。
  const protagonistName =
    trim(propProtagonistName) ||
    trim(characters.find((c) => c.role.includes("主角"))?.name) ||
    trim(characters[0]?.name);

  let no = 0;
  const nextNo = () => String(++no).padStart(2, "0");
  const copy = matrixPanelCopy(characters.length);
  const showStats = characters.length > 0;

  return (
    <section className="panel on" id="p-matrix">
      <div className="page-head">
        <div>
          <div className="kicker">{copy.kicker}</div>
          <h1>{copy.titleLead}<em>{copy.titleEm}</em></h1>
          <p className="lead-sub">
            {copy.hint
              ? copy.hint
              : "每个角色只看四样：此刻在干嘛 / 跟谁有关系 / 知道什么 / 不知道什么。"}
          </p>
        </div>
        {showStats ? (
          <div className="stats">
            <div className="stat"><b>{characters.length}</b><small>角色</small></div>
            {relationships.length > 0 ? (
              <div className="stat"><b>{relationships.length}</b><small>关系对</small></div>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="h2"><span className="bar" /><span className="no">{nextNo()}</span><h2>{copy.sectionTitle}</h2><span className="tail" /></div>
      <div className="matrix-cards">
        {characters.map((character) => (
          <MatrixCharCard
            key={character.id}
            character={character}
            relationships={relationships}
            protagonistName={protagonistName}
          />
        ))}
      </div>

      {relationships.length > 0 ? (
        <>
          <div className="h2"><span className="bar" /><span className="no">{nextNo()}</span><h2>关系网</h2><span className="tail" /></div>
          <CharacterForceGraph characters={characters} relationships={relationships} protagonistName={protagonistName} />
        </>
      ) : null}
    </section>
  );
}

/**
 * 单角色卡（inkos 4 行）：当前 / 关系 / 已知 / 未知。每行有数据才显、无则隐藏、绝不造假。
 * 主角卡视觉高亮（.matrix-char-card.pro）。
 */
function MatrixCharCard({
  character,
  relationships,
  protagonistName,
}: {
  readonly character: StateOverviewCharacterMatrixItem;
  readonly relationships: readonly StateOverviewCharacterRelationship[];
  readonly protagonistName: string;
}) {
  const name = trim(character.name) || "未命名角色";
  // 按名字判主角（不靠 role.includes("主角")，见上）。
  const isProtagonist = trim(protagonistName).length > 0 && trim(character.name) === trim(protagonistName);
  const current = trim(character.currentGoal);

  // 关系行：主角的卡列全部 relationships（每条 target · type · 章）；
  // 非主角 X 的卡取 relationships 里 targetName===X.name 那条，渲成「主角 · type · 章」。
  const relationLines: string[] = isProtagonist
    ? relationships.map((r) => formatRelationLine(trim(r.targetName) || "未知对象", r))
    : (() => {
        const own = relationships.find((r) => trim(r.targetName) === name);
        return own ? [formatRelationLine(trim(protagonistName) || "主角", own)] : [];
      })();

  const known = unique(character.knownFacts);
  const unknown = unique(character.unknownTruths);

  return (
    <div className={`matrix-char-card${isProtagonist ? " pro" : ""}`}>
      <div className="mcc-name">{name}</div>
      {current ? (
        <div className="mcc-row">
          <span className="mcc-k">当前</span>
          <span className="mcc-v">{current}</span>
        </div>
      ) : null}
      {relationLines.length > 0 ? (
        <div className="mcc-row">
          <span className="mcc-k">关系</span>
          <span className="mcc-v">{relationLines.join("\n")}</span>
        </div>
      ) : null}
      {known.length > 0 ? (
        <div className="mcc-row">
          <span className="mcc-k">已知</span>
          <span className="mcc-v">{known.join("；")}</span>
        </div>
      ) : null}
      {unknown.length > 0 ? (
        <div className="mcc-row">
          <span className="mcc-k">未知</span>
          <span className="mcc-v">{unknown.join("；")}</span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * 角色关系网：节点=角色、连线=关系，主角居中、其余环绕。
 * 关系以主角为隐含起点指向 targetName；连线按信任度着色（低=暗红张力 / 中=金线 / 高=青绿）。
 * 复用世界观 ForceGraph 的 SVG 技法与样式。只读可视化（不在图上编辑，守"对 AI 说"控制面铁律）。
 * reduce-motion 由 codex.css 全局兜底。
 */
function CharacterForceGraph({
  characters,
  relationships,
  protagonistName,
}: {
  readonly characters: readonly StateOverviewCharacterMatrixItem[];
  readonly relationships: readonly StateOverviewCharacterRelationship[];
  readonly protagonistName?: string;
}) {
  // 布局/端点解析/配色由纯函数 buildCharacterGraphModel 算（已单测）。
  const relInputs: GraphRelationshipInput[] = relationships.map((r) => ({
    ...(trim(r.targetCharacterId) ? { targetCharacterId: r.targetCharacterId } : {}),
    ...(trim(r.targetName) ? { targetName: r.targetName } : {}),
    ...(trim(r.relationType) ? { relationType: r.relationType } : {}),
    ...(trim(r.attitude) ? { attitude: r.attitude } : {}),
    ...(r.trustLevel ? { trustLevel: r.trustLevel } : {}),
  }));
  const model = buildCharacterGraphModel(
    characters.map((c) => ({ id: c.id, name: c.name, role: c.role })),
    relInputs,
    undefined,
    protagonistName,
  );

  return (
    <div className="graph-wrap">
      <div className="ghd">角色关系拓扑 · 节点 = 角色 · 连线 = 关系（颜色 = 信任度）</div>
      <svg className="graph" viewBox={`0 0 ${model.width} ${model.height}`} preserveAspectRatio="xMidYMid meet">
        <defs>
          <marker id="car" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">
            <path d="M0,0 L7,3 L0,6 Z" className="arrow" />
          </marker>
        </defs>
        {model.edges.map((e) => (
          <g key={e.key}>
            <path d={`M${e.x1},${e.y1} L${e.x2},${e.y2}`} className={`edge ${e.trustClass}`} markerEnd="url(#car)" />
            {e.label ? (
              <g transform={`translate(${e.mx},${e.my})`}>
                <rect x="-44" y="-12" width="88" height="24" rx="12" className="edge-pill" />
                <text x="0" y="4" textAnchor="middle" className="edge-label">{e.label}</text>
              </g>
            ) : null}
          </g>
        ))}
        {model.nodes.map((n) => (
          <foreignObject key={n.id} x={n.x - 86} y={n.y - 34} width="172" height="68">
            <div className={`gnode-card ${n.isProtagonist ? "hot" : ""}`}>
              {n.isProtagonist ? <span className="gn-dot" /> : null}
              <div className="gn-name">{n.name}</div>
              {trim(n.role) ? <div className="gn-role">{n.role}</div> : null}
            </div>
          </foreignObject>
        ))}
      </svg>
      <div className="gfoot">
        <span><i style={{ borderTopColor: "rgba(184,107,107,.72)" }} />信任低 / 张力</span>
        <span><i />中</span>
        <span><i style={{ borderTopColor: "rgba(127,200,164,.7)" }} />信任高</span>
        <span style={{ marginLeft: "auto", color: "var(--muted)" }}>主角居中 · 只读，改关系请向右对 AI 说</span>
      </div>
    </div>
  );
}
