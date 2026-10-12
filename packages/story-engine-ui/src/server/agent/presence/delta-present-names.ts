/**
 * delta-present-names — 从已定稿章的记账声明里读「本章出场角色名」（编辑部 R4.6，2026-10-13）。
 *
 * 数据源：时间线 events.json 里每章事件的 effects.semanticSummary.presentCharacterNames——
 * 这正是定稿时 ChapterDelta 声明经引擎证据校验后持久化的「本章出场角色名」（commit-plan-builder
 * extractChapterSemanticSummary）。老事件没有这个字段就当空（向后兼容，不猜）。
 *
 * 用途（都是只读，不写盘）：
 * 1. 出稿选角兜底：新书名册只有开书占位卡（模板固定名「主角」）时，用最近几章的出场名当本章角色，
 *    占位卡不进关卡（关卡豁免在引擎侧 fast-draft-writer，同一份 PLACEHOLDER_CHARACTER_NAME 标记）。
 * 2. 定稿后的改名建议：主角卡还是占位、而已定稿声明里有出场最多的真名时，建议作者把占位卡改成那个名。
 */
import { readTimelineEvents, PLACEHOLDER_CHARACTER_NAME } from "@actalk/story-engine";

interface SemanticSummaryLike {
  readonly presentCharacterNames?: readonly unknown[];
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
      if (seen.has(name) || PLACEHOLDER_CHARACTER_NAME.test(name)) continue;
      seen.add(name);
      names.push(name);
    }
  }
  return names.slice(0, options.cap ?? 8);
}

/** 出场名 → 出现章数（在 beforeChapter 之前的已定稿声明里），供「出场最多」的改名建议用。 */
export async function readPresentNameChapterCounts(
  projectDir: string,
  beforeChapter: number,
): Promise<readonly { readonly name: string; readonly chapters: number; readonly latestChapter: number }[]> {
  const events = await readTimelineEvents(projectDir).catch(() => []);
  const stats = new Map<string, { chapters: Set<number>; latest: number }>();
  for (const event of events) {
    const chapter = typeof event.chapter === "number" && Number.isFinite(event.chapter) ? event.chapter : Number.NaN;
    if (!Number.isFinite(chapter) || chapter >= beforeChapter) continue;
    for (const name of presentNamesOfEvent(event)) {
      if (PLACEHOLDER_CHARACTER_NAME.test(name)) continue;
      const entry = stats.get(name) ?? { chapters: new Set<number>(), latest: chapter };
      entry.chapters.add(chapter);
      entry.latest = Math.max(entry.latest, chapter);
      stats.set(name, entry);
    }
  }
  return [...stats.entries()]
    .map(([name, entry]) => ({ name, chapters: entry.chapters.size, latestChapter: entry.latest }))
    .sort((left, right) => right.chapters - left.chapters || right.latestChapter - left.latestChapter || left.name.localeCompare(right.name));
}
