import { useEffect, useState } from "react";
import type { AssetDetailStatus, AssetSummary } from "../../../types.js";
import PanelEnrichButton from "./PanelEnrichButton.js";
import { fetchAssetEnrichment, type AssetEnrichmentData } from "../../../api/assetEnrichmentClient.js";
import { uiList, uiText } from "../v2Utils.js";
import { CustomFieldsSection } from "./CustomFieldsSection.js";
import { isPlaceholderUiValue } from "../../../shared/sparse-panel-honesty.js";

/**
 * AssetCodexPanel — 资产 / 道具面板（codex 设计的数据驱动版，厚版全 section）。
 *
 * 视觉照 GLM 设计稿 codex.html#p-assets（样式在 codex.css，作用域 .codex-app）：
 *  - .asset-owner 按持有人分组 → .ao-head 头像 + 概述
 *  - .asset-grps 四桶：随身资产 / 当前可用 / 受限·不可用 / 剧情关键·隐藏
 *  - .asset-item 内含 .ai-vis（读者可见 / 知情边界标）+ .ai-note（细节一行）
 *  - .asset-rule 资产硬规则 · 全局限制
 *  - .continuity 连续性风险提示（写作前必看）
 *
 * 和上一版降级版的关键区别：codex 比引擎厚的 section 不再整块省略，而是
 * **把每个 section 的版式都写出来**，像世界观面板那样「有数据则显、暂无则该 section / 该字段降级隐藏」。
 *  - 引擎现有字段（持有人 / 四桶 / type / location / rules / notes / 关键标记）直接接、与 AssetPanel 同口径。
 *  - 引擎暂无、待后续做厚生成的字段 → 走可选 props（readonly optional），有则渲染、无则降级隐藏，绝不造假：
 *      · .ai-vis 读者可见性 / 知情边界  → assetVisibility（资产名 → 可见性标文案）
 *      · .ao-sub 持有人画像概述           → ownerDescriptions（持有人 → 一句话画像；无则回落到计数概述）
 *      · .continuity 连续性风险提示       → continuityRisks（结构化风险条目）
 *
 * 数据处理沿用 AssetPanel 的口径（AssetPanel 未导出内部函数、本任务不得改动现有文件，
 * 故在此忠实复刻同一套解析，保证两个面板名单一致），仅 buildAssetCards 携带 vis/desc 注入。
 */


/** codex 厚字段：资产名 → 读者可见性 / 知情边界标（如「读者可见」「仅主角知」「主角+某配角知」）。 */
export type AssetVisibilityMap = Readonly<Record<string, string>>;
/** codex 厚字段：持有人 → 一句话画像（.ao-sub）。 */
export type AssetOwnerDescriptionMap = Readonly<Record<string, string>>;

/** codex 厚字段：一条连续性风险提示（.continuity .citem）。 */
export interface AssetContinuityRisk {
  /** 风险类别小标题，如「铺垫缺口」「凭空取物风险」「滞留提醒」；可空。 */
  readonly label?: string;
  /** 风险正文。 */
  readonly detail: string;
}

interface AssetCardData {
  readonly name: string;
  readonly type: string;
  readonly owner: string;
  readonly location: string;
  readonly carried: boolean;
  readonly status: string;
  readonly rule?: string;
  readonly usageRules: readonly string[];
  readonly lossRules: readonly string[];
  readonly notes: readonly string[];
  readonly critical?: boolean;
  /** codex 厚字段（可选注入）：读者可见性 / 知情边界标，无则该卡不渲染 .ai-vis。 */
  readonly visibility?: string;
  /** 自定义额外字段（破例⑦展示）。 */
  readonly extraFields?: Readonly<Record<string, string | readonly string[]>>;
}

interface AssetOwnerView {
  readonly name: string;
  readonly items: readonly AssetCardData[];
  readonly carried: readonly AssetCardData[];
  readonly available: readonly AssetCardData[];
  readonly unavailable: readonly AssetCardData[];
  readonly critical: readonly AssetCardData[];
  /** codex 厚字段（可选注入）：持有人一句话画像，无则回落到计数概述。 */
  readonly description?: string;
}

export default function AssetCodexPanel({
  assets,
  projectPath,
  assetVisibility,
  ownerDescriptions,
  continuityRisks,
  onSendMessage,
  protagonistName,
}: {
  readonly assets: AssetSummary;
  /**
   * 项目路径：传了就按 WorldbuildingCodexPanel 的模式拉 .story-engine-ui/asset-enrichment.json，
   * 用做厚结果填三个可选厚字段（显式 props 仍优先；fixture 预览不传 projectPath，故预览不受影响）。
   */
  readonly projectPath?: string | null;
  readonly onSendMessage?: (message: string) => void;
  /** codex 厚版：资产读者可见性 / 知情边界（.ai-vis）。引擎暂无 → 缺省时该标降级隐藏。 */
  readonly assetVisibility?: AssetVisibilityMap;
  /** codex 厚版：持有人画像概述（.ao-sub）。引擎暂无 → 缺省时回落到计数概述。 */
  readonly ownerDescriptions?: AssetOwnerDescriptionMap;
  /** codex 厚版：连续性风险提示（.continuity）。引擎暂无 → 缺省时该 section 降级隐藏。 */
  readonly continuityRisks?: readonly AssetContinuityRisk[];
  /** 主角真名：数据里写「主角」/ protagonist 的持有人显示成这个名字。 */
  readonly protagonistName?: string;
}) {
  const [fetched, setFetched] = useState<AssetEnrichmentData | null>(null);
  useEffect(() => {
    let alive = true;
    if (!projectPath) {
      setFetched(null);
      return;
    }
    void fetchAssetEnrichment(projectPath).then((e) => {
      if (alive) setFetched(e);
    });
    return () => {
      alive = false;
    };
  }, [projectPath]);

  // 显式 props 优先；否则用 fetch 到的做厚结果（projectPath 为空 / 还没做过厚 → fetched 为 null，全降级）。
  const effVisibility = assetVisibility ?? fetched?.assetVisibility;
  const effOwnerDescriptions = ownerDescriptions ?? fetched?.ownerDescriptions;
  const effContinuityRisks = continuityRisks ?? fetched?.continuityRisks;

  const cards = buildAssetCards(assets, effVisibility);
  const owners = buildAssetOwners(cards, effOwnerDescriptions, protagonistName);
  // 资产规则原样列出；不再从「资源」里按「无 / 不能 / 欠费」字眼挑哪条算限制（重构 P7「不猜」）。
  const limits = uniqueUiList(assets.assetRules);
  const criticalCount = cards.filter((card) => card.critical).length;

  const risks = (effContinuityRisks ?? []).filter((risk) => Boolean(risk.detail && risk.detail.trim()));
  const isEmpty = owners.length === 0 && limits.length === 0 && risks.length === 0;

  return (
    <section className="panel on" id="p-assets">
      <div className="page-head">
        <div>
          <div className="kicker">道具与资源</div>
          <h1>道具与资源</h1>
          <PanelEnrichButton onSendMessage={onSendMessage} intent="帮我把道具与资源补全" label="补全道具与资源" />
          {!isEmpty ? (
            <p className="lead-sub">
              按持有人分组，再按可用性分桶。每件标注读者可见性、角色知情状态与剧情风险——写作前据此判断「这个角色能不能突然拿出它」。
            </p>
          ) : null}
        </div>
        {!isEmpty ? (
          <div className="stats">
            <div className="stat"><b>{owners.length}</b><small>持有人</small></div>
            <div className="stat"><b>{cards.length}</b><small>物品</small></div>
            <div className="stat"><b>{criticalCount}</b><small>关键</small></div>
          </div>
        ) : null}
      </div>

      {isEmpty ? (
        <div className="catrail-foot panel-empty-center" style={{ marginTop: 40 }}>
          <b>还没有道具与资源</b>去右边对 AI 说「帮我把角色的随身物品和资源理一下」，生成后这里就会按持有人铺开。
        </div>
      ) : (
        <>
          {owners.map((owner) => (
            <OwnerLedger key={owner.name} owner={owner} />
          ))}

          {cards.map((card) => (
            <CustomFieldsSection key={`cf-${card.name}`} fields={card.extraFields} title={`${uiText(card.name, "未命名道具")} · 自定义字段`} />
          ))}

          {limits.length > 0 ? (
            <div className="asset-rule">
              <h5>道具与资源的硬规则</h5>
              <ul>
                {limits.map((rule, i) => (
                  <li key={i}>{rule}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {risks.length > 0 ? (
            <div className="continuity">
              <h5>写作前留意：连续性风险</h5>
              {risks.map((risk, i) => (
                <div key={i} className="citem">
                  <span>
                    {has(risk.label) ? <b>{risk.label}：</b> : null}
                    {risk.detail}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

function OwnerLedger({ owner }: { readonly owner: AssetOwnerView }) {
  return (
    <div className="asset-owner">
      <div className="ao-head">
        <div className="ao-av">{avatarText(owner.name)}</div>
        <div>
          <h3>{owner.name === UNOWNED_ASSET_GROUP ? owner.name : `${uiText(owner.name, "未命名归属")} 持有`}</h3>
          <div className="ao-sub">{has(owner.description) ? owner.description : ownerSummary(owner)}</div>
        </div>
      </div>
      <div className="asset-grps">
        <AssetGroup title="随身物品" items={owner.carried} />
        <AssetGroup title="当前可用" items={owner.available} />
        <AssetGroup title="受限 / 不可用" items={owner.unavailable} variant="locked" />
        <AssetGroup title="剧情关键 / 隐藏" items={owner.critical} variant="hidden" accent />
      </div>
    </div>
  );
}

function AssetGroup({
  accent,
  items,
  title,
  variant,
}: {
  readonly accent?: boolean;
  readonly items: readonly AssetCardData[];
  readonly title: string;
  readonly variant?: "locked" | "hidden";
}) {
  if (items.length === 0) return null;
  return (
    <div className="asset-grp">
      <h5 style={accent ? { color: "var(--accent-hi)" } : undefined}>
        {title} <span className="cnt">{items.length}</span>
      </h5>
      {items.map((asset) => {
        const note = assetNote(asset);
        return (
          <div className={`asset-item${variant ? ` ${variant}` : ""}`} key={`${title}:${asset.name}:${asset.status}`}>
            <div>
              <b>{uiText(asset.name, "未命名道具")}</b>
              {has(asset.visibility) ? <span className="ai-vis">{asset.visibility}</span> : null}
              {note ? <span className="ai-note">{note}</span> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function has(value?: string): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** 把卡片上的类型 / 位置 / 规则 / 备注收成一行 note；无任何细节则返回空（→ 隐藏 .ai-note）。 */
function assetNote(asset: AssetCardData): string {
  const parts = [
    asset.type,
    asset.rule,
    ...uiList(asset.usageRules),
    ...uiList(asset.lossRules),
    ...uiList(asset.notes),
    asset.location && asset.location !== "随身" ? `位置：${asset.location}` : undefined,
  ].filter((part): part is string => Boolean(part && part.trim()));
  const seen = new Set<string>();
  const deduped = parts.filter((part) => {
    if (seen.has(part)) return false;
    seen.add(part);
    return true;
  });
  return deduped.join(" · ");
}

function ownerSummary(owner: AssetOwnerView): string {
  const parts = [
    `${owner.items.length} 件物品`,
    owner.carried.length ? `随身 ${owner.carried.length} 件` : undefined,
    owner.unavailable.length ? `受限 ${owner.unavailable.length} 件` : undefined,
    owner.critical.length ? `关键 ${owner.critical.length} 件` : undefined,
  ].filter((part): part is string => Boolean(part));
  return parts.join(" · ");
}

// ───────────────────────── 数据处理（复刻 AssetPanel 的口径，保持名单一致） ─────────────────────────

/** 资料里没写持有人的物品单独成组，不默认算到主角头上（不替作者编归属）。 */
export const UNOWNED_ASSET_GROUP = "还没写明在谁手里";

export function buildAssetOwners(
  cards: readonly AssetCardData[],
  descriptions?: AssetOwnerDescriptionMap,
  protagonistName?: string,
): readonly AssetOwnerView[] {
  const lead = protagonistName?.trim() || "主角";
  const displayOwner = (owner: string | undefined): string => {
    const text = uiText(owner, "").trim();
    if (!text || isPlaceholderUiValue(text)) return UNOWNED_ASSET_GROUP;
    return PROTAGONIST_OWNER_WORDS.has(text.toLowerCase()) ? lead : text;
  };
  const grouped = new Map<string, AssetCardData[]>();
  cards.forEach((card) => {
    const owner = displayOwner(card.owner);
    grouped.set(owner, [...(grouped.get(owner) ?? []), card]);
  });
  return [...grouped.entries()]
    .map(([name, items]) => ({
      name,
      items,
      ...partitionBuckets(items),
      description: descriptions?.[name] ?? (name === lead ? descriptions?.["主角"] : undefined),
    }))
    .sort(
      (a, b) =>
        Number(b.name === lead) - Number(a.name === lead) ||
        Number(a.name === UNOWNED_ASSET_GROUP) - Number(b.name === UNOWNED_ASSET_GROUP) ||
        b.items.length - a.items.length ||
        a.name.localeCompare(b.name, "zh-CN"),
    );
}

/**
 * 互斥分桶：codex 里每件资产只落一个桶。按优先级 关键 > 受限 > 随身 > 当前可用
 * 依次归位，已归入高优先级桶的项不再进入低优先级桶——杜绝随身/关键被「当前可用」重复收录。
 * （对照 codex.html#p-assets：随身桶里的可用项不应再出现在「当前可用」，关键/受限同理。）
 */
function partitionBuckets(items: readonly AssetCardData[]): {
  readonly carried: readonly AssetCardData[];
  readonly available: readonly AssetCardData[];
  readonly unavailable: readonly AssetCardData[];
  readonly critical: readonly AssetCardData[];
} {
  const critical: AssetCardData[] = [];
  const unavailable: AssetCardData[] = [];
  const carried: AssetCardData[] = [];
  const available: AssetCardData[] = [];
  for (const item of items) {
    if (item.critical) critical.push(item);
    else if (!isAvailable(item.status)) unavailable.push(item);
    else if (item.carried) carried.push(item);
    else available.push(item);
  }
  return { carried, available, unavailable, critical };
}

function buildAssetCards(assets: AssetSummary, visibility?: AssetVisibilityMap): readonly AssetCardData[] {
  const withVis = (card: AssetCardData): AssetCardData => {
    const vis = lookupVisibility(visibility, card.name);
    return vis ? { ...card, visibility: vis } : card;
  };

  if (assets.items?.length) {
    return assets.items
      .map(assetCardFromDetail)
      .map(withVis)
      .sort(
        (a, b) =>
          Number(b.carried) - Number(a.carried) ||
          Number(b.critical) - Number(a.critical) ||
          a.name.localeCompare(b.name, "zh-CN"),
      );
  }
  const byName = new Map<string, AssetCardData>();
  const unavailableNames = new Set(uiList(assets.unavailableAssets).map(assetKey));
  const criticalNames = new Set(uiList(assets.plotCriticalItems).map(assetKey));

  const add = (value: string, patch: Partial<AssetCardData>) => {
    if (isPlaceholderUiValue(value)) return;
    const parsed = parseAssetText(value);
    if (isPlaceholderUiValue(parsed.name)) return;
    const key = assetKey(parsed.name);
    const current = byName.get(key);
    byName.set(key, {
      name: parsed.name,
      type: parsed.type ?? current?.type ?? "物品",
      owner: parsed.owner ?? current?.owner ?? "主角",
      location: parsed.location ?? current?.location ?? (patch.carried ? "随身" : ""),
      carried: patch.carried ?? current?.carried ?? false,
      status: patch.status ?? parsed.status ?? current?.status ?? (unavailableNames.has(key) ? "受限" : "可用"),
      rule: parsed.rule ?? current?.rule,
      usageRules: current?.usageRules ?? [],
      lossRules: current?.lossRules ?? [],
      notes: current?.notes ?? [],
      critical: patch.critical ?? current?.critical ?? criticalNames.has(key),
    });
  };

  uiList(assets.carriedItems).forEach((item) => add(item, { carried: true, location: "随身" }));
  uiList(assets.availableAssets).forEach((item) => {
    if (!unavailableNames.has(assetKey(item))) add(item, { status: "可用" });
  });
  uiList(assets.unavailableAssets).forEach((item) => add(item, { status: "不可用" }));
  uiList(assets.plotCriticalItems).forEach((item) => add(item, { critical: true }));
  uiList(assets.properties).forEach((item) => add(item, { type: "住所 / 不动产", carried: false }));

  return [...byName.values()].map(withVis).sort(
    (a, b) =>
      Number(b.carried) - Number(a.carried) ||
      Number(b.critical) - Number(a.critical) ||
      a.name.localeCompare(b.name, "zh-CN"),
  );
}

/** 可见性查表：先精确名，再按解析键（去掉「：限制…」后缀）兜底，匹配不到则无（→ 隐藏 .ai-vis）。 */
function lookupVisibility(visibility: AssetVisibilityMap | undefined, name: string): string | undefined {
  if (!visibility) return undefined;
  const exact = visibility[name];
  if (has(exact)) return exact;
  const keyed = visibility[assetKey(name)];
  return has(keyed) ? keyed : undefined;
}

function assetCardFromDetail(asset: AssetDetailStatus): AssetCardData {
  return {
    name: asset.name,
    type: asset.type,
    // 详情里没写持有人也没写谁随身带着 → 不默认归主角（分到「还没写明在谁手里」）。
    owner: asset.owner ?? asset.carriedBy ?? "",
    location: asset.currentLocation ?? (asset.carriedBy ? "随身" : ""),
    carried: Boolean(asset.carriedBy),
    status: asset.status,
    rule: [...asset.rules, ...asset.usageRules, ...asset.lossRules][0],
    usageRules: asset.usageRules,
    lossRules: asset.lossRules,
    notes: asset.notes,
    critical: asset.isPlotCritical,
    ...(asset.extraFields ? { extraFields: asset.extraFields } : {}),
  };
}

function parseAssetText(value: string): Partial<AssetCardData> & { readonly name: string } {
  const text = uiText(value);
  const [head, ...parts] = text.split(/[｜|]/u).map((item) => item.trim()).filter(Boolean);
  const fields = Object.fromEntries(
    parts.map((part) => {
      const index = part.indexOf("：");
      return index > -1 ? [part.slice(0, index), part.slice(index + 1)] : [part, ""];
    }),
  );
  const name = (head ?? text).split(/[：:，,·]/u)[0]?.trim() || text;
  return {
    name,
    type: fields["类型"],
    owner: fields["归属"] ?? fields["归属人"],
    location: fields["位置"] ?? fields["当前地点"],
    status: fields["状态"],
    rule: fields["规则"] ?? fields["限制"],
  };
}

// 资产状态：引擎的枚举（damaged / lost / locked / consumed）经 uiText 成了中文标签，加上这里自己给的「不可用」。
// 只认这几个整串，不按「锁 / 破 / 用完」字眼猜（重构 P7「不猜」）。
const UNAVAILABLE_STATUSES = new Set(["damaged", "lost", "locked", "consumed", "受损", "丢失", "受限", "已用完", "不可用"]);

function isAvailable(status: string): boolean {
  return !UNAVAILABLE_STATUSES.has(status.trim().toLowerCase());
}

const PROTAGONIST_OWNER_WORDS = new Set(["主角", "protagonist"]);

function uniqueUiList(values: readonly string[] | undefined): readonly string[] {
  const seen = new Set<string>();
  const list: string[] = [];
  for (const value of uiList(values)) {
    if (seen.has(value)) continue;
    seen.add(value);
    list.push(value);
  }
  return list;
}

function assetKey(value: string): string {
  return uiText(value).split(/[：:·，,、|｜]/u)[0]?.trim() ?? uiText(value);
}

function avatarText(name: string): string {
  const cleaned = uiText(name, "资");
  return cleaned.slice(0, 1).toUpperCase();
}
