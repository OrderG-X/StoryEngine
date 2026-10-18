/**
 * canonical-resolvers — Phase 2 统一真值源的确定性 resolver（受控破例④）。
 *
 * 纯函数、无副作用、题材中立、不调 LLM。把散落各处的多源 `??` 链收敛成
 * 单一 canonical 输出，供 `state-overview.ts` 调用，使「面板展示」与「AI 写作 prompt」同源。
 * 缺字段一律退回更低优先级或 undefined（旧书无新字段时逐字节向后兼容）。
 */

/** 当前目标：currentGoal 优先，缺则 goal。 */
export function resolveCurrentGoal(
  state?: { readonly currentGoal?: string; readonly goal?: string },
): string | undefined {
  return state?.currentGoal ?? state?.goal;
}

/** 精神状态：currentMentalState > mood > emotion。 */
export function resolveMentalState(
  state?: {
    readonly currentMentalState?: string;
    readonly mood?: string;
    readonly emotion?: string;
  },
): string | undefined {
  return state?.currentMentalState ?? state?.mood ?? state?.emotion;
}

/**
 * 在世身份：bible 静态定义优先（curated 权威），缺则 runtime 快照。
 * 注：身份是设定属性、非易变状态，runtime 快照可能滞后，故 bible 为权威（与现行为一致）。
 */
export function resolveIdentity(
  input?: { readonly bibleIdentity?: string; readonly runtimeIdentity?: string },
): string | undefined {
  return input?.bibleIdentity ?? input?.runtimeIdentity;
}

/** 当前位置：runtime 当前位置名优先，缺则 timeline 派生（timeline 可能滞后，故次优先）。 */
export function resolveCurrentLocation(
  input?: { readonly runtimeLocationName?: string; readonly timelineLocation?: string },
): string | undefined {
  return input?.runtimeLocationName ?? input?.timelineLocation;
}

/**
 * 去重归一口径（E1·唯一真值源）：把连续 Unicode 空白折叠为单个 ASCII 空格 + trim。
 * 刻意「零有损」——不删全部空白（防 `dark room`≡`darkroom` 英文分词误并）、不转小写
 * （防中文大小写无关误并）、不去标点、不做 NFKC/同义/子串。只折叠「渲染出来仅差空白数量」的条目。
 * 写侧（mergeStringArrays）与读侧（dedupeAppearanceAnchors/dedupeStringList）必须始终调本函数，
 * 防写/读口径再次漂移。题材中立、纯确定性、不调 LLM。
 */
export function normalizeForDedup(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

// 软边界：空白或 Unicode 标点。前缀含纳仅当更长串在前缀末尾处是软边界才成立——
// 守中文续字（`他很高`/`他很高兴`：下一字「兴」非软边界 → 不并），边界守卫天然偏向少合并。
const SOFT_BOUNDARY = /[\s\p{P}]/u;

/**
 * list 去重（E1 核心）：① 空白折叠（normalizeForDedup 相等即重复，留首个原串）；
 * ② 前缀含纳——若条目 A 的归一 key 是 B 的归一 key 的严格前缀、且 B 在该前缀末尾处是软边界，
 * 则丢 A 留更长的 B（A 文字已逐字含在 B 内 → 零文本损失，治真书陈雨薇式「原文 + 追加后缀」重复）。
 * 守 #357：只比前缀（起点锚定），后缀/子串一律不并（`账本`≠`账目`、`血痕`≠`走廊尽头的血痕与碎镜`）；
 * 绝不 includes/双向子串/bigram/编辑距离/跨字段比对。保序、纯确定性、题材中立。
 */
export function dedupeStringList(items: readonly string[]): readonly string[] {
  // 1. trim 非空 + 归一 key；精确 key 折叠（空白变体），留首个原串、保首见序。
  const firstRawByKey = new Map<string, string>();
  const keysInOrder: string[] = [];
  for (const raw of items) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = normalizeForDedup(trimmed);
    if (!firstRawByKey.has(key)) {
      firstRawByKey.set(key, trimmed);
      keysInOrder.push(key);
    }
  }
  // 2. 前缀含纳：A 被某个更长的 B 严格前缀含纳（边界软）则丢弃 A。
  const dropped = new Set<string>();
  for (const a of keysInOrder) {
    for (const b of keysInOrder) {
      if (a === b) continue;
      if (b.length > a.length && b.startsWith(a) && SOFT_BOUNDARY.test(b.charAt(a.length))) {
        dropped.add(a);
        break;
      }
    }
  }
  // 3. 存活 key 的原串，保序输出。
  return keysInOrder.filter((key) => !dropped.has(key)).map((key) => firstRawByKey.get(key)!);
}

/** 外观锚点：多源合并 + 去重（空白折叠 + 前缀含纳，保留首次出现顺序），跳过 undefined 源。 */
export function dedupeAppearanceAnchors(
  ...sources: readonly (readonly string[] | undefined)[]
): readonly string[] {
  const flat: string[] = [];
  for (const source of sources) {
    if (!source) continue;
    for (const item of source) flat.push(item);
  }
  return dedupeStringList(flat);
}

/** 内部：取第一个 trim 后非空的值（空串/纯空白视作缺失）。 */
function firstNonBlank(...vals: readonly (string | undefined)[]): string | undefined {
  for (const v of vals) {
    if (v && v.trim()) return v;
  }
  return undefined;
}

/**
 * A 类·职能三名合一。优先级：narrativeRole（做厚「叙事岗位」）> bibleRole > roleHint。
 * 空串/纯空白视作缺失（与展示口径一致：空职能不占权威位）。
 */
export function resolveCharacterRole(
  input?: { readonly narrativeRole?: string; readonly bibleRole?: string; readonly roleHint?: string },
): string | undefined {
  return firstNonBlank(input?.narrativeRole, input?.bibleRole, input?.roleHint);
}

export type TrustLevel = "low" | "medium" | "high";

const TRUST_PERCENT: Record<TrustLevel, number> = { low: 25, medium: 55, high: 85 };

/**
 * B 类·信任：三档为权威，百分比由三档确定性派生（仅供进度条显示）。
 * 取消 AI 独立 trustPercent 权威——档与条永不矛盾。level 缺 → undefined（无信任信息）。
 */
export function resolveTrust(
  level: TrustLevel | undefined,
): { readonly level: TrustLevel; readonly percent: number } | undefined {
  if (!level) return undefined;
  return { level, percent: TRUST_PERCENT[level] };
}
