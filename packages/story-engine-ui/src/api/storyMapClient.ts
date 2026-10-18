/**
 * 故事地图的数据（GET /api/story-map，重构 P6）。读不到就如实给原因。
 */

export interface StoryMapChapter {
  readonly chapter: number;
  readonly day: number;
  readonly dayEnd: number;
  readonly weekday?: number;
  readonly weekdayDerived: boolean;
  readonly timeOfDay?: string;
  readonly basis: "text" | "judged" | "author" | "estimated" | "missing";
  readonly summary?: string;
  readonly present: readonly string[];
  readonly viewpoint?: string;
}

export interface StoryMapMember {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly viewpointChapters: readonly number[];
  readonly appearances: readonly { readonly chapter: number; readonly quote: string }[];
}

export interface StoryMap {
  readonly upTo: number;
  readonly chapters: readonly StoryMapChapter[];
  readonly cast: readonly StoryMapMember[];
}

export type StoryMapResult = { readonly ok: true; readonly map: StoryMap } | { readonly ok: false; readonly error: string };

export async function fetchStoryMap(projectPath: string, signal?: AbortSignal): Promise<StoryMapResult> {
  try {
    const res = await fetch(`/api/story-map?project=${encodeURIComponent(projectPath)}`, signal ? { signal } : {});
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; map?: StoryMap; error?: string };
    if (body.ok === true && body.map && Array.isArray(body.map.chapters) && Array.isArray(body.map.cast)) return { ok: true, map: body.map };
    return { ok: false, error: body.error?.trim() || `读故事地图没成（${res.status}）。` };
  } catch (error) {
    if (signal?.aborted) return { ok: false, error: "已取消。" };
    return { ok: false, error: `读故事地图没成：${error instanceof Error ? error.message : String(error)}` };
  }
}
