export type FormalCommitV0StateArea =
  | "chapter_manuscript"
  | "timeline"
  | "hooks"
  | "threads"
  | "arc_goals"
  | "character_state"
  | "world_state"
  | "calendar"
  | "story_timeline"
  | "fact_ledger";

export type FormalCommitV0ForbiddenArea =
  | "asset_ledger"
  | "location_bible"
  | "character_bible"
  | "character_matrix";

export const FORMAL_COMMIT_V0_STATIC_ALLOWED_PATHS = [
  "timeline/events.json",
  "story/hooks.json",
  "story/threads.json",
  "story/arc-goals.json",
  "world/state.json",
  "time/calendar.json",
  "story/timeline.json",
  "story/fact-ledger.json",
] as const;

export const FORMAL_COMMIT_V0_FORBIDDEN_PATHS = [
  "story/assets.json",
  "story/location-bible.json",
  "story/character-bible.json",
  "story/character-matrix.json",
] as const;

export interface FormalCommitV0NormalizedChangedFiles {
  readonly acceptedFiles: readonly string[];
  readonly rejectedFiles: readonly string[];
}

export function isFormalCommitV0AllowedPath(file: string): boolean {
  return formalCommitV0StateAreaForPath(file) !== undefined;
}

export function isFormalCommitV0ForbiddenPath(file: string): boolean {
  return formalCommitV0ForbiddenAreaForPath(file) !== undefined;
}

export function isFormalCommitV0SafeRelativePath(file: string): boolean {
  if (!file || file.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(file)) return false;
  return !file.split(/[\\/]+/u).includes("..");
}

export function isFormalCommitV0ChapterOutputPath(file: string): boolean {
  const match = /^chapters\/(\d+)\.md$/u.exec(file);
  if (!match) return false;
  const chapter = Number(match[1]);
  if (!Number.isSafeInteger(chapter) || chapter <= 0) return false;
  return file === `chapters/${String(chapter).padStart(4, "0")}.md`;
}

export function isFormalCommitV0CharacterId(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/u.test(value);
}

export function formalCommitV0CharacterStatePath(characterId: string): string | undefined {
  return isFormalCommitV0CharacterId(characterId)
    ? `characters/${characterId}/state.json`
    : undefined;
}

export function formalCommitV0StateAreaForPath(file: string): FormalCommitV0StateArea | undefined {
  if (!isFormalCommitV0SafeRelativePath(file)) return undefined;
  if (isFormalCommitV0ChapterOutputPath(file)) return "chapter_manuscript";
  if (file === "timeline/events.json") return "timeline";
  if (file === "story/hooks.json") return "hooks";
  if (file === "story/threads.json") return "threads";
  if (file === "story/arc-goals.json") return "arc_goals";
  if (/^characters\/[A-Za-z0-9_-]+\/state\.json$/u.test(file)) return "character_state";
  if (file === "world/state.json") return "world_state";
  if (file === "time/calendar.json") return "calendar";
  if (file === "story/timeline.json") return "story_timeline";
  if (file === "story/fact-ledger.json") return "fact_ledger";
  return undefined;
}

export function formalCommitV0ForbiddenAreaForPath(file: string): FormalCommitV0ForbiddenArea | undefined {
  if (file === "story/assets.json") return "asset_ledger";
  if (file === "story/location-bible.json") return "location_bible";
  if (file === "story/character-bible.json") return "character_bible";
  if (file === "story/character-matrix.json") return "character_matrix";
  return undefined;
}

export function normalizeFormalCommitV0ChangedFiles(files: readonly string[]): FormalCommitV0NormalizedChangedFiles {
  const acceptedFiles: string[] = [];
  const rejectedFiles: string[] = [];
  for (const file of unique(files)) {
    if (isFormalCommitV0AllowedPath(file)) {
      acceptedFiles.push(file);
    } else {
      rejectedFiles.push(file);
    }
  }
  return { acceptedFiles, rejectedFiles };
}

function unique(items: readonly string[]): string[] {
  const result: string[] = [];
  for (const item of items) {
    if (!result.includes(item)) result.push(item);
  }
  return result;
}
