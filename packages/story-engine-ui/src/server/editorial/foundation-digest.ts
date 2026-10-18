/**
 * 设定本摘要（2026-10-14 编辑部 R7.3）：把人物卡、地点、资产、世界规则里能核的硬信息拼成一份「设定」交给核账员。
 *
 * 报告 3.3：爷爷「三年前过世」只写在人物卡里，核账不看设定本 → 第 3 章写「五年」漏报，
 * 第 6 章写「三年」反倒以第 3 章为准被报错。修法是把设定本作为一份对照材料进核账窗口（题材中立，
 * 不预设字段名，按项目里真实存的资料拼）；模型引的设定原文照样要经代码核对（settingQuoteLabel），
 * 抄不出的不算。纯读：不改正文、不写设定。
 */
import {
  readAssetLedger,
  readCharacterBible,
  readLocationBible,
  readWorldBible,
} from "../book/project-store.js";
import {
  type AssetItem,
  type CharacterBibleEntry,
  type LocationBibleEntry,
  type WorldBible,
} from "../book/types.js";
import { containsQuote, normalize } from "./continuity/check-chapter.js";

/** 一类设定（人物卡 / 地点 / 资产 / 世界规则）：label 进回执，text 是拼好的原文摘要（核对引文按它来）。 */
export interface SettingSection {
  readonly label: string;
  readonly text: string;
}

export interface FoundationDigest {
  readonly sections: readonly SettingSection[];
  /** 拼进核账窗口的整段文字（各节带小标题）。 */
  readonly text: string;
  /** 设定本太长被截断过：如实标出来，截掉的部分引文核对不上、自然不收。 */
  readonly truncated: boolean;
}

/** 设定摘要的预算：比一章笔记宽裕（设定是全书共用的硬信息），但不许把窗口撑爆。 */
export const FOUNDATION_DIGEST_MAX_CHARS = 8000;

/** 常见字段的中文标签；没在表里的键（含作者自定义 extraFields）原样用键名——题材中立，不预设字段名。 */
const FIELD_LABELS: Record<string, string> = {
  role: "身份", age: "年龄", gender: "性别", identity: "身份说明", desire: "想要", longTermDesire: "长期想要",
  fear: "害怕", weakness: "弱点", contradiction: "矛盾点", moralBoundary: "底线", privateMotive: "私心",
  relationshipToProtagonist: "和主角的关系", relationshipDynamics: "关系", appearanceAnchors: "外貌",
  knowledgeKnown: "已经知道", knowledgeUnknown: "还不知道", cannotReveal: "不能说破", cannotDo: "不会做",
  personalityBaseline: "性格", speechRules: "说话规矩", speechStyle: "说话风格", speechSamples: "口吻样本",
  behaviorBoundaries: "行为边界", currentStateHint: "当前状态", hiddenStance: "隐藏立场",
  type: "类型", knownFeatures: "已知特征", narrativeFunction: "作用", possibleConflicts: "可能的冲突",
  currentStatus: "当前状态", hiddenFacts: "隐藏事实", connectedLocations: "相连的地方", fixedFacts: "定死的事实",
  secrets: "秘密", risks: "风险", resources: "资源", currentKnownPosition: "已知位置", lastKnownState: "最后已知状态",
  spatialStructure: "结构", sensoryDetails: "感官", travelRules: "路程", parentLocation: "上级地点",
  status: "现状", notes: "备注", rules: "规矩", usageRules: "使用规矩", lossRules: "丢失规矩",
  ownerName: "在谁手里", currentLocationName: "现在在哪", carriedByName: "随身带着的人",
  worldPremise: "世界前提", rules_list: "规则", factions: "势力", powerOrSurvivalSystems: "力量或生存体系",
  historyFacts: "历史事实", socialOrder: "社会秩序", resourceRules: "资源规矩", authorityRules: "权力规矩",
  conflictSources: "冲突来源", protectedSecrets: "被保护的秘密", publicFacts: "公开事实",
  forbiddenRuleBreaks: "不许打破的规矩",
};
/** 这些键不进摘要：内部 id 和 id 引用（给作者看的文字不出现裸 id）、布尔开关、纯结构对象。 */
const SKIP_FIELDS = new Set(["id", "canAiModify", "arc", "voice", "ownerCharacterId", "currentLocationId", "carriedByCharacterId", "lastSeenChapter", "firstSeenChapter", "containsAssetIds", "locationId", "parentId"]);

/**
 * 会随剧情变的「现状」字段不进摘要（重构 P3，10-17 事故根治）：卡片上的现状是作者建卡时写的，
 * 写到后面早就过时了，核账员拿它当设定去比，就会把正文里合理的变化报成矛盾。现状以前文正文和账本为准。
 * 只认这几个固定的键；作者自定义字段（extraFields）不知道含义，照旧进摘要，不猜。
 */
const CURRENT_STATE_FIELDS = new Set([
  "currentStateHint", "currentStatus", "currentKnownPosition", "lastKnownState", "status",
  "ownerName", "currentLocationName", "carriedByName",
]);

const label = (key: string): string => FIELD_LABELS[key] ?? key;

/** 数组项拼成一句：字符串直接用；对象（路程规则这类）把叶子字段拼出来，不递归嵌套对象。 */
function describeValue(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    const parts = value.map((item) => describeValue(item)).filter((item): item is string => Boolean(item));
    return parts.length > 0 ? parts.join("；") : undefined;
  }
  if (value && typeof value === "object") {
    const parts = Object.entries(value as Record<string, unknown>)
      .map(([key, inner]) => {
        const text = describeValue(inner);
        return text ? `${label(key)}：${text}` : undefined;
      })
      .filter((item): item is string => Boolean(item));
    return parts.length > 0 ? parts.join("，") : undefined;
  }
  return undefined;
}

/** 一个实体（角色 / 地点 / 资产）拼成一行：名字（身份）打头，其余「标签：内容」用分号隔。
 *  extraFields（作者自定义字段）摊平成它自己的键值，不带 extraFields 前缀。 */
function entityLine(name: string, header: string | undefined, entry: Record<string, unknown>): string | undefined {
  const parts: string[] = [];
  const extra = entry.extraFields && typeof entry.extraFields === "object" && !Array.isArray(entry.extraFields)
    ? entry.extraFields as Record<string, unknown>
    : undefined;
  for (const [key, value] of Object.entries(entry)) {
    if (key === "name" || key === "extraFields" || SKIP_FIELDS.has(key) || CURRENT_STATE_FIELDS.has(key)) continue;
    const text = describeValue(value);
    if (text) parts.push(`${label(key)}：${text}`);
  }
  for (const [key, value] of Object.entries(extra ?? {})) {
    const text = describeValue(value);
    if (text) parts.push(`${label(key)}：${text}`);
  }
  if (parts.length === 0) return header ? `${name}（${header}）` : name;
  return `${name}${header ? `（${header}）` : ""}——${parts.join("；")}`;
}

function characterLine(entry: CharacterBibleEntry): string | undefined {
  return entityLine(entry.name, entry.role, entry as unknown as Record<string, unknown>);
}

function locationLine(entry: LocationBibleEntry): string | undefined {
  const type = [entry.type, entry.locationType].filter(Boolean).join("／") || undefined;
  return entityLine(entry.name, type, entry as unknown as Record<string, unknown>);
}

function assetLine(entry: AssetItem): string | undefined {
  return entityLine(entry.name, entry.type, entry as unknown as Record<string, unknown>);
}

function worldLines(bible: WorldBible): readonly string[] {
  return Object.entries(bible as unknown as Record<string, unknown>)
    .filter(([key]) => key !== "version")
    .map(([key, value]) => {
      const text = describeValue(value);
      return text ? `${label(key === "rules" ? "rules_list" : key)}：${text}` : undefined;
    })
    .filter((item): item is string => Boolean(item));
}

/**
 * 读设定本拼摘要。哪类资料都没有（新建的书）→ undefined（核账照旧，不提示设定）；
 * 文件坏了由调用方按失败如实记。sections 按人物卡 → 地点 → 资产 → 世界规则排，空的不进。
 */
export async function readFoundationDigest(projectDir: string): Promise<FoundationDigest | undefined> {
  const [characters, locations, assets, world] = await Promise.all([
    readCharacterBible(projectDir),
    readLocationBible(projectDir),
    readAssetLedger(projectDir),
    readWorldBible(projectDir),
  ]);
  const blocks: readonly { readonly label: string; readonly lines: readonly string[] }[] = [
    { label: "人物卡", lines: (characters?.characters ?? []).map(characterLine).filter((l): l is string => Boolean(l)) },
    { label: "地点", lines: (locations?.locations ?? []).map(locationLine).filter((l): l is string => Boolean(l)) },
    {
      label: "资产",
      lines: [
        ...(assets.assets ?? []).map(assetLine).filter((l): l is string => Boolean(l)),
        ...(assets.containers ?? []).map((container) => assetLine(container as unknown as AssetItem)).filter((l): l is string => Boolean(l)),
      ],
    },
    { label: "世界规则", lines: world ? worldLines(world) : [] },
  ];
  const present = blocks.filter((block) => block.lines.length > 0);
  if (present.length === 0) return undefined;
  let truncated = false;
  const sections = present.map((block) => {
    const lines = [...block.lines];
    let text = `【${block.label}】\n${lines.join("\n")}`;
    while (text.length > FOUNDATION_DIGEST_MAX_CHARS && lines.length > 1) {
      lines.pop();
      truncated = true;
      text = `【${block.label}】\n${lines.join("\n")}`;
    }
    return { label: block.label, text };
  });
  return {
    sections,
    text: sections.map((section) => section.text).join("\n"),
    truncated,
  };
}

/** 拼进核账窗口的那段话：小标题 + 各节原文摘要（＋截断说明）。 */
export function foundationMessage(digest: FoundationDigest): string {
  return [
    "【设定本（作者定的硬设定：人物卡、地点、资产、世界规则）】",
    "（东西在谁手里、人在哪这类会变的现状不在这里，以前文正文为准。）",
    digest.text,
    ...(digest.truncated ? ["（设定本太长，这里只给了前面一部分。）"] : []),
  ].join("\n");
}

/** 一句「设定原文」真在设定本里吗：在 → 返回它所在那节的 label（人物卡 / 地点 / 资产 / 世界规则）；不在 → undefined。 */
export function settingQuoteLabel(digest: FoundationDigest, quote: string): string | undefined {
  if (normalize(quote).length < 4) return undefined;
  for (const section of digest.sections) {
    if (containsQuote(normalize(section.text), quote)) return section.label;
  }
  return undefined;
}
