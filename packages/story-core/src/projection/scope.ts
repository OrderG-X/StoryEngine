/**
 * 一条事实、线索在哪说的、谁说的，能改多少现状（写作版本 P3a 设计第 3 节）。纯函数，只看账单里的结构：来源、证据句号、段。
 *
 * 权限 = 来源那行和段那行取交集（哪一格有一行说不能就不能）；原句定位不了不放权。
 *
 *  | 在哪 / 谁说的 | 现状 | replaces | 同格不同值 | 收线索 |
 *  |---|---|---|---|---|
 *  | 叙述、当下（或没切段的旧账） | 更新 | 生效 | 确定 | 能收 |
 *  | other 段（梦、想象、传闻） | 不更新 | 不生效 | 不报 | 不能 |
 *  | past 段（回忆） | 不更新 | 不生效 | 不报 | 不能（理线索时可提议） |
 *  | 人物说的 | 不更新 | 不生效 | 可能 | 不能（理线索时可提议） |
 *  | 段未知 | 不更新 | 不生效 | 可能 | 不能 |
 *  | 来源不知道、在当下 | 更新 | 生效 | 可能 | 能收 |
 */
import type { EntrySource, LedgerEntry, LedgerScene, SceneFrame, UnitRange } from "../schema/ledger.js";

/** 这条在当下（present）、某种段里，还是定不了在段里段外（unknown）。 */
export type EntryFrame = "present" | SceneFrame | "unknown";

export type ConflictLevel = "sure" | "maybe" | "none";

export interface EntryRights {
  /** 能更新现状格子（state 顶替、hard 进现状）。 */
  readonly state: boolean;
  /** replaces 生效。 */
  readonly replaces: boolean;
  /** 和现状同格不同值时报到什么程度。 */
  readonly conflict: ConflictLevel;
  /** 能收线索（不能的按推进记）。 */
  readonly close: boolean;
}

export interface EntryScope {
  readonly frame: EntryFrame;
  readonly source: EntrySource["kind"];
  /** 人物说的：正文里对说话人的称呼。 */
  readonly speaker?: string;
  readonly rights: EntryRights;
}

const inside = (range: UnitRange, scene: { readonly units: UnitRange }): boolean => range.from >= scene.units.from && range.to <= scene.units.to;
const overlaps = (range: UnitRange, scene: { readonly units: UnitRange }): boolean => range.from <= scene.units.to && range.to >= scene.units.from;

/**
 * 按证据句号定这条在哪：本章没有段 → 当下；原句每一处都在段里 → 那段（几段 frame 不同取 other）；都在段外 → 当下；
 * 混着、跨段边、定位不了（不唯一、找不到、没原句）、段改文后对不回了 → 段未知。
 */
export function frameOf(
  evidence: readonly { readonly units?: UnitRange }[],
  located: boolean,
  scenes: readonly Pick<LedgerScene, "units" | "frame" | "stale">[],
): EntryFrame {
  if (scenes.length === 0) return "present";
  if (!located || evidence.length === 0 || scenes.some((scene) => scene.stale)) return "unknown";
  const frames = new Set<EntryFrame>();
  for (const item of evidence) {
    if (!item.units) return "unknown";
    const range = item.units;
    const home = scenes.find((scene) => inside(range, scene));
    if (home) {
      frames.add(home.frame);
      continue;
    }
    if (scenes.some((scene) => overlaps(range, scene))) return "unknown";
    frames.add("present");
  }
  if (frames.size === 1) return [...frames][0]!;
  if (frames.has("present")) return "unknown";
  return "other";
}

const ORDER: Record<ConflictLevel, number> = { none: 0, maybe: 1, sure: 2 };
export const lowerConflict = (a: ConflictLevel, b: ConflictLevel): ConflictLevel => (ORDER[a] <= ORDER[b] ? a : b);

const FULL: EntryRights = { state: true, replaces: true, conflict: "sure", close: true };

function frameRights(frame: EntryFrame): EntryRights {
  switch (frame) {
    case "present":
      return FULL;
    case "other":
    case "past":
      return { state: false, replaces: false, conflict: "none", close: false };
    case "unknown":
      return { state: false, replaces: false, conflict: "maybe", close: false };
  }
}

function sourceRights(source: EntrySource["kind"]): EntryRights {
  switch (source) {
    case "narration":
    case "author_ruling":
      return FULL;
    case "character_claim":
      return { state: false, replaces: false, conflict: "maybe", close: false };
    case "unknown":
      return { state: true, replaces: true, conflict: "maybe", close: true };
  }
}

export function rightsOf(source: EntrySource["kind"], frame: EntryFrame): EntryRights {
  const a = sourceRights(source);
  const b = frameRights(frame);
  return { state: a.state && b.state, replaces: a.replaces && b.replaces, conflict: lowerConflict(a.conflict, b.conflict), close: a.close && b.close };
}

/** 账单里一条事实 / 线索的范围和权限（ledger 给本章的段）。 */
export function scopeOf(entry: LedgerEntry, ledger: { readonly scenes: readonly Pick<LedgerScene, "units" | "frame" | "stale">[] }): EntryScope {
  const frame = frameOf(entry.evidence, entry.evidenceStatus === "located", ledger.scenes);
  return {
    frame,
    source: entry.source.kind,
    ...(entry.source.kind === "character_claim" && entry.source.speaker ? { speaker: entry.source.speaker.mention } : {}),
    rights: rightsOf(entry.source.kind, frame),
  };
}
