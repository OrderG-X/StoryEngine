import { useEffect, useState } from "react";
import type { StateOverviewCharacterMatrix, StateOverviewCharacterMatrixItem } from "../../../api/types.js";
import PanelEnrichButton from "./PanelEnrichButton.js";
import { CustomFieldsSection } from "./CustomFieldsSection.js";
import type { AssetSummary, LocationStatus, ProtagonistStatus, SidebarData } from "../../../types.js";
import { fetchCharacterEnrichment, type CharacterEnrichmentData } from "../../../api/characterEnrichmentClient.js";
import { uiList, uiText } from "../v2Utils.js";
import { filterSystemStoryMeta, isPlaceholderUiValue } from "../../../shared/sparse-panel-honesty.js";

/**
 * CharacterCodexPanel — 角色面板（codex 设计的数据驱动版，厚版全 section）。
 *
 * 视觉照 GLM 设计稿 codex.html #p-chars（样式在 codex.css，.codex-app 作用域）：
 *   .char 档案卡 → .char-head/.avatar + .char-id（多 tag）
 *   .layer3 三层人格（内核 / 表层气质 / 社交伪装）
 *   .drive3 驱动三件套（核心驱动 / 外部目标 / 内部缺失）
 *   .char-row 字段行（恐惧 / 边界 / 缺陷 / 秘密 / 锚点 / 关系 / 位置 / 风险 …）
 *   .arc 成长弧（P1 起点误区 / P2 第一卷挫败 / P3 关键代价，渲染进一行 .char-row）
 *   .voice 表达合同（说话风格 / 情绪外露 / 禁用表达 / 语言禁区）
 *   .know 知情边界（知道的事实 / 不知道的真相）
 *
 * 数据接 characterMatrix + protagonist + sidebar + location + assets，props 与现有 CharacterPanel 完全一致，
 * 可无缝替换。范式严格照 WorldbuildingCodexPanel：**所有 section 的版式都写出来**，有数据则显、暂无则该 section 降级隐藏，绝不造假。
 *
 * codex 比引擎厚、引擎暂未生成的字段 → 加成可选 props（readonly optional），等后续做厚 generate 后自动填满：
 *   - layer3 的「表层气质 surface / 社交伪装 mask」：引擎只有单层人设 → 暂无、整单元降级隐藏。
 *   - .arc 成长弧三步（arcStart / arcSetback / arcCost）：引擎无成长弧模型 → 暂无、整块隐藏。
 *   - .voice「情绪外露 emotionalExposure」：引擎暂无该字段 → 暂无、隐藏该单元。
 *   - 「核心驱动 desire / 内部缺失 innerLack」属厚字段时，可由扩展 props 注入。
 * 这些字段一旦由 fromMatrixItem 或上游做厚后填上，对应版式自动铺出，无需再改组件。
 */
interface CharacterCodexView {
  readonly name: string;
  readonly age?: string;
  readonly identity?: string;
  readonly role: string;
  /** 第二个角色标签（如「主角推动者」「伏笔持有人」），来自 matrix.roleHint。 */
  readonly roleHint?: string;
  /** 角色自定义字段（破例⑦）：从矩阵迁回档案——自定义字段属于角色本身、归档案管。 */
  readonly extraFields?: Readonly<Record<string, string | readonly string[]>>;
  /** 内核人格（layer3.core）：独立于副标题 identity 的一句话内核，**只来自做厚**；缺失时降级隐藏，绝不回落 currentGoal（会和「外部目标」撞成同一行）或 identity。 */
  readonly core?: string;
  /** 表层气质（layer3.surf）：厚字段，引擎暂无 → 一般为空、降级隐藏。 */
  readonly surface?: string;
  /** 社交伪装（layer3.mask）：厚字段，引擎暂无 → 一般为空、降级隐藏。 */
  readonly mask?: string;
  /** 核心驱动（drive3）。 */
  readonly desire?: string;
  /** 外部目标（drive3）。 */
  readonly currentGoal?: string;
  /** 内部缺失（drive3）：厚字段优先，缺则回落到短板/隐性动机。 */
  readonly innerLack?: string;
  readonly fear?: string;
  readonly weakness?: string;
  readonly moralBoundary?: string;
  readonly contradiction?: string;
  readonly privateMotive?: string;
  readonly protectedSecrets: readonly string[];
  readonly appearanceAnchors: readonly string[];
  /** 日常锚点（.char-row「日常锚点」）：厚字段，引擎暂无 → 降级隐藏。 */
  readonly dailyAnchors: readonly string[];
  readonly currentLocation?: string;
  readonly riskReminders: readonly string[];
  readonly speechStyle?: string;
  readonly speechSamples: readonly string[];
  /** 情绪外露（.voice）：厚字段，引擎暂无 → 隐藏该单元。 */
  readonly emotionalExposure?: string;
  readonly forbiddenReveals: readonly string[];
  readonly cannotDo: readonly string[];
  readonly carriedAssets: readonly string[];
  readonly plotCriticalAssets: readonly string[];
  readonly relationshipToProtagonist?: string;
  readonly trustLevel?: string;
  readonly knownFacts: readonly string[];
  readonly unknownTruths: readonly string[];
  readonly lastSeenChapter?: number;
  /** 成长弧 P1 起点误区：厚字段，引擎暂无 → 整块 .arc 隐藏。 */
  readonly arcStart?: string;
  /** 成长弧 P2 第一卷挫败。 */
  readonly arcSetback?: string;
  /** 成长弧 P3 关键代价。 */
  readonly arcCost?: string;
}

/**
 * 厚版扩写字段（按角色 id 索引）：codex 比引擎厚、引擎暂未生成的字段在这里注入。
 * 不传则对应 section 一律降级隐藏，绝不造假。后续 generate 做厚后由上游接进来即可自动填满。
 */
/** .char-row 一行字段（label/value + 可选语气：secret 金、risk 红）。 */
interface CharRow {
  readonly label: string;
  readonly value: string;
  readonly tone?: "secret" | "risk";
}

export interface CharacterCodexEnrichment {
  /** 内核人格（layer3.core）：与副标题 identity 是不同文案，单独喂这一格。 */
  readonly core?: string;
  /** 表层气质（layer3.surf）。 */
  readonly surface?: string;
  /** 社交伪装（layer3.mask）。 */
  readonly mask?: string;
  /** 内部缺失（drive3）。 */
  readonly innerLack?: string;
  /** 情绪外露（.voice）。 */
  readonly emotionalExposure?: string;
  /** 日常锚点（.char-row「日常锚点」）。 */
  readonly dailyAnchors?: readonly string[];
  /** 成长弧三步。 */
  readonly arcStart?: string;
  readonly arcSetback?: string;
  readonly arcCost?: string;
}

export default function CharacterCodexPanel({
  assets,
  characterMatrix,
  enrichment,
  location,
  projectPath,
  protagonist,
  sidebar,
  onSendMessage,
}: {
  readonly assets: AssetSummary;
  readonly characterMatrix?: StateOverviewCharacterMatrix;
  /** codex 厚版扩写字段（按角色名索引），暂无则对应 section 降级隐藏。 */
  readonly enrichment?: Readonly<Record<string, CharacterCodexEnrichment>>;
  readonly location: LocationStatus;
  /**
   * 项目路径：传了就按 AssetCodexPanel 的模式拉 .story-engine-ui/character-enrichment.json，
   * 用做厚结果填 enrichment（显式 props 仍优先；fixture 预览不传 projectPath，故预览不受影响）。
   */
  readonly projectPath?: string | null;
  readonly onSendMessage?: (message: string) => void;
  readonly protagonist: ProtagonistStatus;
  readonly sidebar: SidebarData;
}) {
  const [fetched, setFetched] = useState<CharacterEnrichmentData | null>(null);
  useEffect(() => {
    let alive = true;
    if (!projectPath) {
      setFetched(null);
      return;
    }
    void fetchCharacterEnrichment(projectPath).then((e) => {
      if (alive) setFetched(e);
    });
    return () => {
      alive = false;
    };
  }, [projectPath]);

  // 显式 props 优先；否则用 fetch 到的做厚结果（projectPath 为空 / 还没做过厚 → fetched 为 null，全降级）。
  const effEnrichment = enrichment ?? fetched?.byCharacter;

  const characters = normalizeCharacters(protagonist, characterMatrix, effEnrichment);

  if (characters.length === 0) {
    return (
      <div className="read-inner">
        <div className="catrail-foot" style={{ marginTop: 40 }}>
          <b>还没有角色档案</b>　去右边对 AI 说「帮我补全主要角色」，AI 会把每个角色的性格、目标和说话方式整理在这里。
        </div>
      </div>
    );
  }

  // 主角按名字定 lead（不靠 /主角/ 正则——做厚后 role 是「叙事岗位」长描述，配角描述里可能含
  // 「作为主角的竞争对手」会被正则误判抢走 lead）。权威源 = ProtagonistStatus.name；缺则回落第一个角色。
  const leadName = protagonist.name?.trim() || undefined;
  const leadIndexByName = leadName ? characters.findIndex((c) => c.name === leadName) : -1;
  const leadIndex = leadIndexByName >= 0 ? leadIndexByName : (characters.length > 0 ? 0 : -1);
  const protagonistCount = leadIndex >= 0 ? 1 : 0;

  return (
    <section className="panel on" id="p-chars">
      <div className="page-head">
        <div>
          <div className="kicker">角色档案</div>
          <h1>角色</h1>
          <PanelEnrichButton onSendMessage={onSendMessage} intent="帮我把现有角色补全一点" label="✦ 补全角色" />
          <p className="lead-sub">每个角色的性格、目标、成长、说话方式和知道的事都在这里。已有资料会直接显示，暂时没有的内容不会硬凑。</p>
        </div>
        <div className="stats">
          <div className="stat"><b>{characters.length}</b><small>角色</small></div>
          <div className="stat"><b>{protagonistCount}</b><small>主角</small></div>
        </div>
      </div>

      <div className="chars">
        {characters.map((character, index) => {
          const isLead = index === leadIndex;
          return (
            <CharacterCard
              key={character.name}
              character={character}
              isLead={isLead}
              fallbackLocation={location.currentLocation}
            />
          );
        })}
      </div>
    </section>
  );
}

function CharacterCard({
  character,
  isLead,
  fallbackLocation,
}: {
  readonly character: CharacterCodexView;
  readonly isLead: boolean;
  readonly fallbackLocation?: string;
}) {
  // 职能 tag 取短标签：主角直接「主角」；其余取冒号/句号前那截（做厚后 role 常是「商业劲敌：作为主角的…」
  // 一整段，整段塞进小 tag 会爆版）。完整 role 仍喂正文（引擎侧），这里只管展示。
  const roleLabel = shortRoleLabel(character.role, isLead);
  const roleTag = roleTagClass(roleLabel);
  const currentLocation = character.currentLocation ?? (isLead ? fallbackLocation : undefined);
  const safeLocation = currentLocation && !isPlaceholderUiValue(currentLocation) ? currentLocation : undefined;
  const forbiddenReveals = filterSystemStoryMeta(character.forbiddenReveals);
  const riskReminders = filterSystemStoryMeta(character.riskReminders);

  // .layer3 三层人格：仅渲染有真实内容的单元；surf/mask 引擎暂无 → 通常自动消失。
  const layers = [
    { cls: "core", title: "内核人格", text: character.core },
    { cls: "surf", title: "表层气质", text: character.surface },
    { cls: "mask", title: "社交伪装", text: character.mask },
  ].filter((l): l is { cls: string; title: string; text: string } => Boolean(l.text));

  // .drive3：核心驱动 / 外部目标 / 内部缺失。无内容的单元降级隐藏。
  const drives = [
    { title: "核心驱动", text: character.desire },
    { title: "外部目标", text: character.currentGoal },
    { title: "内部缺失", text: character.innerLack ?? character.weakness ?? character.privateMotive },
  ].filter((d): d is { title: string; text: string } => Boolean(d.text));

  // .arc 成长弧（P1/P2/P3）：厚字段，引擎暂无 → 整块隐藏。
  const arcSteps = [
    { n: "P1", text: character.arcStart },
    { n: "P2", text: character.arcSetback },
    { n: "P3", text: character.arcCost },
  ].filter((a): a is { n: string; text: string } => Boolean(a.text));

  // .char-row 字段：缺值不渲染整行。
  const rows = ([
    character.fear ? { label: "核心恐惧", value: character.fear } : null,
    character.moralBoundary ? { label: "道德边界", value: character.moralBoundary } : null,
    character.weakness ? { label: "核心缺陷", value: character.weakness } : null,
    character.contradiction ? { label: "反差", value: character.contradiction } : null,
    character.privateMotive ? { label: "隐性动机", value: character.privateMotive } : null,
    character.protectedSecrets.length > 0 ? { label: "秘密", value: uiList(character.protectedSecrets).join("；"), tone: "secret" as const } : null,
    character.appearanceAnchors.length > 0 ? { label: "外貌锚点", value: uiList(character.appearanceAnchors).join(" · ") } : null,
    character.relationshipToProtagonist ? { label: "与主角关系", value: character.relationshipToProtagonist } : null,
    character.trustLevel ? { label: "信任度", value: character.trustLevel } : null,
    character.carriedAssets.length > 0 ? { label: "携带资产", value: uiList(character.carriedAssets).join(" · ") } : null,
    character.plotCriticalAssets.length > 0 ? { label: "关键资产", value: uiList(character.plotCriticalAssets).join(" · ") } : null,
  ] as readonly (CharRow | null)[]).filter((r): r is CharRow => r !== null);

  // 表达合同之后的「日常锚点 / 所在位置 / 最近出场 / 风险提醒」行（照 mockup 顺序排在 .voice 之后）。
  const tailRows = ([
    character.dailyAnchors.length > 0 ? { label: "日常锚点", value: uiList(character.dailyAnchors).join(" · ") } : null,
    safeLocation ? { label: "所在位置", value: uiText(safeLocation) } : null,
    character.lastSeenChapter ? { label: "最近出场", value: `第${character.lastSeenChapter}章` } : null,
    riskReminders.length > 0 ? { label: "写作提醒", value: uiList(riskReminders).join("；"), tone: "risk" as const } : null,
  ] as readonly (CharRow | null)[]).filter((r): r is CharRow => r !== null);

  // .voice 表达合同：说话风格 / 情绪外露 / 禁用表达 / 语言禁区。情绪外露引擎暂无 → 隐藏该单元。
  const voices = [
    character.speechStyle ? { cls: "", title: "说话风格", text: character.speechStyle } : null,
    !character.speechStyle && character.speechSamples.length > 0 ? { cls: "", title: "口吻示例", text: `「${uiList(character.speechSamples)[0] ?? ""}」` } : null,
    character.emotionalExposure ? { cls: "", title: "情绪外露", text: character.emotionalExposure } : null,
    forbiddenReveals.length > 0 ? { cls: "ban", title: "这个角色不会说", text: uiList(forbiddenReveals).join("；") } : null,
    character.cannotDo.length > 0 ? { cls: "ban", title: "这个角色不会说", text: uiList(character.cannotDo).join("；") } : null,
  ].filter((v): v is { cls: string; title: string; text: string } => v !== null && Boolean(v.text));

  const hasKnow = character.knownFacts.length > 0 || character.unknownTruths.length > 0;

  return (
    <article className={`char ${isLead ? "lead" : ""}`} style={isLead ? { gridColumn: "1/-1" } : undefined}>
      <div className="char-head">
        <div className="avatar">{avatarText(character.name)}</div>
        <div className="char-id">
          <h3>{uiText(character.name, "未命名角色")}</h3>
          <div className="sub">
            {character.age ? <b>{uiText(character.age)}</b> : null}
            {character.identity ? <><span>·</span><span>{uiText(character.identity)}</span></> : null}
            <span>·</span>
            {/* P2 canonical：职能只显一个权威值（resolveCharacterRole 已合并 narrativeRole/role/roleHint）；
                取短标签展示，避免做厚后的「叙事岗位」长描述塞爆 tag。不再单列 roleHint 致重复。 */}
            <span className={`tag ${roleTag}`}>{uiText(roleLabel, "角色")}</span>
          </div>
        </div>
      </div>

      <div className="char-body">
          {layers.length > 0 ? (
            <div className="layer3">
              {layers.map((l) => (
                <div key={l.cls} className={`ly ${l.cls}`}><h6>{l.title}</h6><p>{uiText(l.text)}</p></div>
              ))}
            </div>
          ) : null}

          {drives.length > 0 ? (
            <div className="drive3">
              {drives.map((d) => (
                <div key={d.title} className="dv"><h6>{d.title}</h6><p>{uiText(d.text)}</p></div>
              ))}
            </div>
          ) : null}

          {rows.map((r) => (
            <div key={r.label} className="char-row">
              <span className="ck">{r.label}</span>
              <span className={`cv ${r.tone ?? ""}`}>{r.value}</span>
            </div>
          ))}

          {arcSteps.length > 0 ? (
            <div className="char-row">
              <span className="ck">成长弧</span>
              <span className="cv">
                <div className="arc">
                  {arcSteps.map((a) => (
                    <div key={a.n} className="astep" data-n={a.n}>{uiText(a.text)}</div>
                  ))}
                </div>
              </span>
            </div>
          ) : null}

          {voices.length > 0 ? (
            <div className="voice">
              {voices.map((v, i) => (
                <div key={`${v.title}:${i}`} className={`vc ${v.cls}`}><h6>{v.title}</h6><p>{v.text}</p></div>
              ))}
            </div>
          ) : null}

          {tailRows.length > 0 ? (
            <div style={{ marginTop: 12 }}>
              {tailRows.map((r) => (
                <div key={r.label} className="char-row">
                  <span className="ck">{r.label}</span>
                  <span className={`cv ${r.tone ?? ""}`}>{r.value}</span>
                </div>
              ))}
            </div>
          ) : null}

          {hasKnow ? (
            <div className="know">
              {character.knownFacts.length > 0 ? (
                <div className="kbox">
                  <h6>知道的事实</h6>
                  <ul>{uiList(character.knownFacts).map((f, i) => <li key={`${f}:${i}`}>{f}</li>)}</ul>
                </div>
              ) : null}
              {character.unknownTruths.length > 0 ? (
                <div className="kbox dont">
                  <h6>不知道的真相</h6>
                  <ul>{uiList(character.unknownTruths).map((f, i) => <li key={`${f}:${i}`}>{f}</li>)}</ul>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        <CustomFieldsSection fields={character.extraFields} title="自定义字段" />
    </article>
  );
}

/** 从真实数据生成 codex 视图。仅 characterMatrix 有内容时用矩阵，否则只展示主角骨架（与 CharacterPanel 同源）。 */
function normalizeCharacters(
  protagonist: ProtagonistStatus,
  matrix?: StateOverviewCharacterMatrix,
  enrichment?: Readonly<Record<string, CharacterCodexEnrichment>>,
): readonly CharacterCodexView[] {
  if (matrix?.characters.length) {
    return matrix.characters.map((c) => fromMatrixItem(c, enrichment?.[c.name] ?? enrichment?.[c.id]));
  }
  if (!protagonist.name?.trim()) return [];
  const ext = enrichment?.[protagonist.name];
  return [{
    name: protagonist.name,
    age: protagonist.age,
    identity: protagonist.identity,
    role: "主角",
    roleHint: undefined,
    extraFields: undefined, // 无矩阵兜底路径，extraFields 不可得；有矩阵时主角走 fromMatrixItem 拿 c.extraFields
    core: ext?.core, // 只认真正做厚的内核；没有就降级隐藏，绝不借「当前处境」冒充（那不是内核人格）
    surface: ext?.surface,
    mask: ext?.mask,
    desire: undefined,
    currentGoal: protagonist.currentGoal,
    innerLack: ext?.innerLack,
    fear: undefined,
    weakness: undefined,
    moralBoundary: undefined,
    contradiction: undefined,
    privateMotive: undefined,
    protectedSecrets: [],
    appearanceAnchors: [],
    dailyAnchors: ext?.dailyAnchors ?? [],
    currentLocation: undefined,
    riskReminders: [],
    speechStyle: protagonist.speechStyle,
    speechSamples: protagonist.speechSamples,
    emotionalExposure: ext?.emotionalExposure,
    forbiddenReveals: [],
    cannotDo: protagonist.cannotDo,
    carriedAssets: [],
    plotCriticalAssets: [],
    relationshipToProtagonist: undefined,
    trustLevel: undefined,
    knownFacts: [],
    unknownTruths: [],
    lastSeenChapter: undefined,
    arcStart: ext?.arcStart,
    arcSetback: ext?.arcSetback,
    arcCost: ext?.arcCost,
  }];
}

function fromMatrixItem(c: StateOverviewCharacterMatrixItem, ext?: CharacterCodexEnrichment): CharacterCodexView {
  // 结构化厚字段同时存在两处：UI 侧 character-enrichment.json（ext，喂结构化段）+ 引擎 bible.extraFields
  // （喂正文，破例⑦）。展示优先 ext，缺则从 extraFields 中文键兜底——这样把这些键从「自定义字段」prune 掉
  // 时不会丢内容（结构化段仍展示一次），治「自定义字段跟角色内容重复」。
  const ef = c.extraFields;
  const efStr = (key: string): string | undefined => {
    const v = ef?.[key];
    if (typeof v === "string") return v.trim() || undefined;
    if (Array.isArray(v)) return v.join("、").trim() || undefined;
    return undefined;
  };
  const efArr = (key: string): readonly string[] => {
    const v = ef?.[key];
    if (Array.isArray(v)) return v;
    if (typeof v === "string" && v.trim()) return [v];
    return [];
  };
  // 成长弧三步的键名可能是「成长弧·起点误区」等（中点字符不固定），按前缀+阶段词兜底匹配。
  const efArc = (stage: string): string | undefined => {
    if (!ef) return undefined;
    const key = Object.keys(ef).find((k) => k.startsWith("成长弧") && k.includes(stage));
    return key ? efStr(key) : undefined;
  };
  return {
    name: c.name,
    age: c.age,
    identity: c.identity,
    role: c.role,
    roleHint: c.roleHint,
    extraFields: pruneDerivedExtraFields(c.extraFields),
    core: ext?.core ?? efStr("内核人格"), // bug 修复：原本 ?? c.currentGoal 会让「内核人格」和「外部目标」(也是 currentGoal) 显示成一模一样；没做厚就降级隐藏
    surface: ext?.surface ?? efStr("表层气质"),
    mask: ext?.mask ?? efStr("社交伪装"),
    desire: c.desire,
    currentGoal: c.currentGoal,
    innerLack: ext?.innerLack ?? efStr("内部缺失") ?? c.weakness ?? c.privateMotive,
    fear: c.fear,
    weakness: c.weakness,
    moralBoundary: c.moralBoundary,
    contradiction: c.contradiction,
    privateMotive: c.privateMotive,
    protectedSecrets: c.protectedSecrets,
    appearanceAnchors: c.appearanceAnchors ?? [],
    dailyAnchors: ext?.dailyAnchors ?? efArr("日常锚点"),
    currentLocation: c.currentLocation,
    riskReminders: c.riskReminders,
    speechStyle: c.speechStyle,
    speechSamples: c.speechSamples,
    emotionalExposure: ext?.emotionalExposure ?? efStr("情绪外露"),
    forbiddenReveals: c.forbiddenReveals,
    cannotDo: c.cannotDo,
    carriedAssets: c.carriedAssets,
    plotCriticalAssets: c.plotCriticalAssets,
    relationshipToProtagonist: c.relationshipToProtagonist,
    trustLevel: c.trustLevel,
    knownFacts: c.knownFacts,
    unknownTruths: c.unknownTruths,
    lastSeenChapter: c.lastSeenChapter,
    arcStart: ext?.arcStart ?? efArc("起点"),
    arcSetback: ext?.arcSetback ?? efArc("挫败"),
    arcCost: ext?.arcCost ?? efArc("代价"),
  };
}

function avatarText(name: string): string {
  const cleaned = uiText(name, "角").replace(/[《》]/gu, "");
  return cleaned.slice(0, 1) || "角";
}

function roleTagClass(role: string): string {
  if (/主角/u.test(role)) return "warn";
  if (/反派|敌|压力源|对手/u.test(role)) return "danger";
  if (/盟友|友|伙伴|镜像/u.test(role)) return "ok";
  if (/入口|世界观|线索|伏笔/u.test(role)) return "gold";
  return "info";
}

/**
 * 职能短标签：主角恒「主角」；其余取冒号/句号/换行前那截并限长——做厚后 role 常是「商业劲敌：作为主角的…」
 * 一整段叙事岗位，整段塞进小 tag 会爆版。完整 role 仍由引擎喂正文，这里只管展示精简。
 */
function shortRoleLabel(role: string, isLead: boolean): string {
  if (isLead) return "主角";
  const head = (role ?? "").split(/[：:。\n]/u)[0]?.trim() ?? "";
  if (!head) return "角色";
  return head.length <= 16 ? head : `${head.slice(0, 16)}…`;
}

/**
 * 做厚/canonical 管线已占的中文 extraFields 键——它们都有结构化展示位（三层人格/驱动/情绪/日常锚点/成长弧/叙事岗位），
 * 不该再作为「自定义字段」重复出现。成长弧三步按前缀另判（键名中点字符不固定）。
 */
const DERIVED_EXTRA_KEYS: ReadonlySet<string> = new Set([
  "内核人格", "表层气质", "社交伪装",
  "核心驱动", "外部目标", "内部缺失",
  "情绪外露", "日常锚点", "叙事岗位",
]);

/** 从 extraFields 剔除上述派生键，只留真·用户自定义字段；全被剔光则返回 undefined（CustomFieldsSection 整块隐藏）。 */
function pruneDerivedExtraFields(
  extra?: Readonly<Record<string, string | readonly string[]>>,
): Readonly<Record<string, string | readonly string[]>> | undefined {
  if (!extra) return undefined;
  const kept = Object.entries(extra).filter(
    ([key]) => !DERIVED_EXTRA_KEYS.has(key.trim()) && !key.trim().startsWith("成长弧"),
  );
  return kept.length > 0 ? Object.fromEntries(kept) : undefined;
}
