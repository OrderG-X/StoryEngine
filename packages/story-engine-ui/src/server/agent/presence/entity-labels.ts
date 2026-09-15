/**
 * entity-labels —— 把内部 entity id（char-xxxx 等）解析成给用户/模型看的人类可读名字。
 *
 * 模型无关·铁律：任何裸 entity id 进给用户看的 summary/参与者列表前都必须解析成名字，
 * 解析不到再按"像不像内部 hash id"决定中性占位还是原样保留——绝不直接吐 char-ffe5af 这类 hash。
 * 纯确定性、题材中立、不调 LLM。
 */
import { readCharacterBible } from "@actalk/story-engine";

/**
 * 内部实体 hash id 的形状（如 char-ffe5af / asset-3c2d / thread-9a1b）。匹配上且解析不到名字
 * → 中性占位，绝不泄露裸 hash。做厚工具的 targetIds 会带 asset-/location- 等各类引擎 slug，
 * 都按同一规则兜底。
 */
const INTERNAL_ENTITY_ID = /^(?:char|asset|location|thread|hook|fact|lead|goal|chapter)-[0-9a-z]+$/iu;

/** 读角色册 → id→角色名 映射（解析裸 char-id 用）。读失败/无册 → 空 Map（调用方据此回落，不崩）。 */
export async function readCharacterNameById(projectDir: string): Promise<Map<string, string>> {
  const bible = await readCharacterBible(projectDir).catch(() => null);
  const map = new Map<string, string>();
  for (const character of bible?.characters ?? []) {
    if (character.id && character.name) map.set(character.id, character.name);
  }
  return map;
}

/**
 * 把单个 ref（char-id / 角色名 / "protagonist" 等关键词）解析成展示名：
 * - 命中 id→名映射 → 名字；
 * - 解析不到但"像内部 char-hash id" → 中性占位（不泄露裸 hash）；
 * - 其余（已是名字 / "protagonist" 等可读关键词）→ 原样保留。
 */
export function resolveEntityLabel(ref: string, nameById: ReadonlyMap<string, string>): string {
  const name = nameById.get(ref);
  if (name) return name;
  return INTERNAL_ENTITY_ID.test(ref) ? "「未知角色」" : ref;
}

/** 批量解析（如 timeline 事件的 participants）。 */
export function resolveEntityLabels(refs: readonly string[], nameById: ReadonlyMap<string, string>): string[] {
  return refs.map((ref) => resolveEntityLabel(ref, nameById));
}

/**
 * 解析 semanticSummary 里已知的 id-承载字段（participants 数组 / protagonist 标量）成名字，其它字段原样。
 * 引擎多数已写名字，但模型无关：万一某条写的是裸 char-id，也不能原样透传给模型/用户。
 */
export function resolveSemanticSummaryLabels(
  sem: Record<string, unknown>,
  nameById: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...sem };
  if (Array.isArray(sem.participants)) {
    out.participants = sem.participants.map((p) => (typeof p === "string" ? resolveEntityLabel(p, nameById) : p));
  }
  if (typeof sem.protagonist === "string") {
    out.protagonist = resolveEntityLabel(sem.protagonist, nameById);
  }
  return out;
}
