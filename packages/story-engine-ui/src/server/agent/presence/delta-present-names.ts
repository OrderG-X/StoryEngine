/**
 * delta-present-names — 从已定稿章的记账声明里读「本章出场角色名」「本章视角人物」（编辑部 R4.6 / R5.1）。
 *
 * 数据源：时间线 events.json 里每章事件的 effects.semanticSummary——这正是定稿时 ChapterDelta 声明
 * 经引擎证据校验后持久化的章节语义（commit-plan-builder extractChapterSemanticSummary）：
 * presentCharacterNames＝本章出场角色名；viewpointCharacter＝本章视角人物（R5.1 起）。
 * 老事件没有这些字段就当空（向后兼容，不猜）。
 *
 * 用途（都是只读，不写盘）：
 * 1. 出稿选角兜底：新书名册只有开书占位卡（模板固定名「主角」）时，用最近几章的出场名当本章角色，
 *    占位卡不进关卡（关卡豁免在引擎侧 fast-draft-writer，同一份 isPlaceholderCharacterName 标记）。
 * 2. 定稿后的改名建议（R5.1 起改判据）：主角卡还是占位时，建议作者把它改成「已定稿章节里
 *    声明视角最多」的那个名字——不再数出场次数（视角人物是林小满、别的名字出现再多也不抢）。
 */
import { readTimelineEvents, isPlaceholderCharacterName } from "../../book/project-store.js";

interface SemanticSummaryLike {
  readonly presentCharacterNames?: readonly unknown[];
  readonly viewpointCharacter?: unknown;
}

/** 单条时间线事件里经校验的出场名（老事件缺字段 → 空，不猜）。 */
export function presentNamesOfEvent(event: { readonly chapter?: unknown; readonly effects?: unknown }): readonly string[] {
  const effects = typeof event.effects === "object" && event.effects !== null ? event.effects as { readonly semanticSummary?: unknown } : undefined;
  const semantic = effects?.semanticSummary;
  if (typeof semantic !== "object" || semantic === null) return [];
  const raw = (semantic as SemanticSummaryLike).presentCharacterNames;
  if (!Array.isArray(raw)) return [];
  const names: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const name = item.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/** 单条时间线事件里持久化的视角人物（老事件缺字段 → undefined，不猜）。 */
export function viewpointOfEvent(event: { readonly chapter?: unknown; readonly effects?: unknown }): string | undefined {
  const effects = typeof event.effects === "object" && event.effects !== null ? event.effects as { readonly semanticSummary?: unknown } : undefined;
  const semantic = effects?.semanticSummary;
  if (typeof semantic !== "object" || semantic === null) return undefined;
  const raw = (semantic as SemanticSummaryLike).viewpointCharacter;
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

/**
 * 最近几章（缺省 3 章）已定稿声明的出场名，最新章在前、章内保持声明顺序；占位名不进来。
 * 只算 chapter 之前（< beforeChapter）的章：本章自己还没定稿，出场名尚不存在。
 */
export async function readRecentPresentCharacterNames(
  projectDir: string,
  beforeChapter: number,
  options: { readonly chapters?: number; readonly cap?: number } = {},
): Promise<readonly string[]> {
  const events = await readTimelineEvents(projectDir).catch(() => []);
  const chapterOf = (event: { readonly chapter?: unknown }): number =>
    typeof event.chapter === "number" && Number.isFinite(event.chapter) ? event.chapter : Number.NaN;
  const finalizedChapters = [...new Set(events.filter((event) => chapterOf(event) < beforeChapter).map(chapterOf))]
    .filter((chapter) => Number.isFinite(chapter))
    .sort((left, right) => right - left)
    .slice(0, options.chapters ?? 3);
  const byChapterDesc = new Map(finalizedChapters.map((chapter) => [chapter, true]));
  const names: string[] = [];
  const seen = new Set<string>();
  // 事件按章分组后按章倒序取，保证「最近章在前」稳定（不依赖 events.json 里的行序）。
  const grouped = new Map<number, readonly string[]>();
  for (const event of events) {
    const chapter = chapterOf(event);
    if (!byChapterDesc.has(chapter)) continue;
    grouped.set(chapter, [...(grouped.get(chapter) ?? []), ...presentNamesOfEvent(event)]);
  }
  for (const chapter of finalizedChapters) {
    for (const name of grouped.get(chapter) ?? []) {
      if (seen.has(name) || isPlaceholderCharacterName(name)) continue;
      seen.add(name);
      names.push(name);
    }
  }
  return names.slice(0, options.cap ?? 8);
}

/**
 * 视角人物 → 已定稿声明的视角章数（beforeChapter 之前），供「视角最多」的改名建议用（R5.1 判据）。
 * 一章只算一次（同章多条事件取第一个非空视角）；老事件没有 viewpointCharacter 就整章不算——
 * 一章都没有视角声明时结果为空，调用方据此不给建议，绝不退回数出场次数。
 */
export async function readViewpointChapterCounts(
  projectDir: string,
  beforeChapter: number,
): Promise<readonly { readonly name: string; readonly chapters: number; readonly latestChapter: number }[]> {
  const events = await readTimelineEvents(projectDir).catch(() => []);
  const stats = new Map<string, { chapters: Set<number>; latest: number }>();
  const seenChapters = new Map<number, string>();
  for (const event of events) {
    const chapter = typeof event.chapter === "number" && Number.isFinite(event.chapter) ? event.chapter : Number.NaN;
    if (!Number.isFinite(chapter) || chapter >= beforeChapter) continue;
    if (seenChapters.has(chapter)) continue; // 同章后续事件的视角不重复计
    const viewpoint = viewpointOfEvent(event);
    if (!viewpoint || isPlaceholderCharacterName(viewpoint)) continue; // 这条事件没视角：看同章下一条
    seenChapters.set(chapter, viewpoint);
    const entry = stats.get(viewpoint) ?? { chapters: new Set<number>(), latest: chapter };
    entry.chapters.add(chapter);
    entry.latest = Math.max(entry.latest, chapter);
    stats.set(viewpoint, entry);
  }
  return [...stats.entries()]
    .map(([name, entry]) => ({ name, chapters: entry.chapters.size, latestChapter: entry.latest }))
    .sort((left, right) => right.chapters - left.chapters || right.latestChapter - left.latestChapter || left.name.localeCompare(right.name));
}
