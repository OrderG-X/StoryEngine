import { describe, expect, it } from "vitest";
import {
  FORMAL_COMMIT_V0_FORBIDDEN_PATHS,
  FORMAL_COMMIT_V0_STATIC_ALLOWED_PATHS,
  formalCommitV0ForbiddenAreaForPath,
  formalCommitV0StateAreaForPath,
  isFormalCommitV0AllowedPath,
  isFormalCommitV0ChapterOutputPath,
  isFormalCommitV0ForbiddenPath,
  isFormalCommitV0SafeRelativePath,
  normalizeFormalCommitV0ChangedFiles,
} from "./formal-commit-v0-allowlist.js";

describe("formal commit V0 allowlist", () => {
  it("allows chapters/0001.md", () => {
    expect(isFormalCommitV0AllowedPath("chapters/0001.md")).toBe(true);
  });

  it("allows chapters/9999.md", () => {
    expect(isFormalCommitV0AllowedPath("chapters/9999.md")).toBe(true);
  });

  it("accepts canonical 4 digit chapter output paths", () => {
    expect(isFormalCommitV0ChapterOutputPath("chapters/0001.md")).toBe(true);
    expect(isFormalCommitV0ChapterOutputPath("chapters/0012.md")).toBe(true);
    expect(isFormalCommitV0ChapterOutputPath("chapters/9999.md")).toBe(true);
  });

  it("accepts canonical 5+ digit chapter output paths", () => {
    expect(isFormalCommitV0ChapterOutputPath("chapters/10000.md")).toBe(true);
    expect(isFormalCommitV0ChapterOutputPath("chapters/12345.md")).toBe(true);
  });

  it("rejects non-canonical chapter output paths", () => {
    expect(isFormalCommitV0ChapterOutputPath("chapters/0000.md")).toBe(false);
    expect(isFormalCommitV0ChapterOutputPath("chapters/00001.md")).toBe(false);
    expect(isFormalCommitV0ChapterOutputPath("chapters/001.md")).toBe(false);
    expect(isFormalCommitV0ChapterOutputPath("chapters/01.md")).toBe(false);
    expect(isFormalCommitV0ChapterOutputPath("chapters/abc.md")).toBe(false);
    expect(isFormalCommitV0ChapterOutputPath("chapters/10000.txt")).toBe(false);
    expect(isFormalCommitV0ChapterOutputPath("/chapters/0001.md")).toBe(false);
    expect(isFormalCommitV0ChapterOutputPath("../chapters/0001.md")).toBe(false);
  });

  it("allows canonical 5+ digit chapter paths through the shared path policy", () => {
    expect(formalCommitV0StateAreaForPath("chapters/10000.md")).toBe("chapter_manuscript");
    expect(isFormalCommitV0AllowedPath("chapters/10000.md")).toBe(true);
  });

  it("rejects chapters/1.md", () => {
    expect(isFormalCommitV0AllowedPath("chapters/1.md")).toBe(false);
  });

  it("rejects chapters/0001.txt", () => {
    expect(isFormalCommitV0AllowedPath("chapters/0001.txt")).toBe(false);
  });

  it("allows timeline/events.json", () => {
    expect(isFormalCommitV0AllowedPath("timeline/events.json")).toBe(true);
  });

  it("allows story/hooks.json", () => {
    expect(isFormalCommitV0AllowedPath("story/hooks.json")).toBe(true);
  });

  it("allows story/threads.json", () => {
    expect(isFormalCommitV0AllowedPath("story/threads.json")).toBe(true);
  });

  it("allows story/arc-goals.json", () => {
    expect(isFormalCommitV0AllowedPath("story/arc-goals.json")).toBe(true);
  });

  it("allows characters/lin-xiao/state.json", () => {
    expect(isFormalCommitV0AllowedPath("characters/lin-xiao/state.json")).toBe(true);
  });

  it("allows characters/lin_xiao-1/state.json", () => {
    expect(isFormalCommitV0AllowedPath("characters/lin_xiao-1/state.json")).toBe(true);
  });

  it("rejects characters/../state.json", () => {
    expect(isFormalCommitV0AllowedPath("characters/../state.json")).toBe(false);
  });

  it("rejects characters/lin/xiao/state.json", () => {
    expect(isFormalCommitV0AllowedPath("characters/lin/xiao/state.json")).toBe(false);
  });

  it("rejects characters//state.json", () => {
    expect(isFormalCommitV0AllowedPath("characters//state.json")).toBe(false);
  });

  it("allows world/state.json", () => {
    expect(isFormalCommitV0AllowedPath("world/state.json")).toBe(true);
  });

  it("allows time/calendar.json", () => {
    expect(isFormalCommitV0AllowedPath("time/calendar.json")).toBe(true);
  });

  it("rejects story/assets.json", () => {
    expect(isFormalCommitV0ForbiddenPath("story/assets.json")).toBe(true);
    expect(isFormalCommitV0AllowedPath("story/assets.json")).toBe(false);
  });

  it("rejects story/location-bible.json", () => {
    expect(isFormalCommitV0ForbiddenPath("story/location-bible.json")).toBe(true);
    expect(isFormalCommitV0AllowedPath("story/location-bible.json")).toBe(false);
  });

  it("rejects story/character-bible.json", () => {
    expect(isFormalCommitV0ForbiddenPath("story/character-bible.json")).toBe(true);
    expect(isFormalCommitV0AllowedPath("story/character-bible.json")).toBe(false);
  });

  it("rejects story/character-matrix.json", () => {
    expect(isFormalCommitV0ForbiddenPath("story/character-matrix.json")).toBe(true);
    expect(isFormalCommitV0AllowedPath("story/character-matrix.json")).toBe(false);
  });

  it("rejects absolute path /tmp/file.json", () => {
    expect(isFormalCommitV0SafeRelativePath("/tmp/file.json")).toBe(false);
    expect(isFormalCommitV0AllowedPath("/tmp/file.json")).toBe(false);
  });

  it("rejects Windows absolute path C:\\tmp\\file.json", () => {
    expect(isFormalCommitV0SafeRelativePath("C:\\tmp\\file.json")).toBe(false);
    expect(isFormalCommitV0AllowedPath("C:\\tmp\\file.json")).toBe(false);
  });

  it("rejects traversal path ../outside.json", () => {
    expect(isFormalCommitV0SafeRelativePath("../outside.json")).toBe(false);
    expect(isFormalCommitV0AllowedPath("../outside.json")).toBe(false);
  });

  it("rejects unknown path notes/freeform.json", () => {
    expect(isFormalCommitV0AllowedPath("notes/freeform.json")).toBe(false);
  });

  it("maps allowed paths to expected state areas", () => {
    expect(formalCommitV0StateAreaForPath("chapters/0001.md")).toBe("chapter_manuscript");
    expect(formalCommitV0StateAreaForPath("timeline/events.json")).toBe("timeline");
    expect(formalCommitV0StateAreaForPath("story/hooks.json")).toBe("hooks");
    expect(formalCommitV0StateAreaForPath("story/threads.json")).toBe("threads");
    expect(formalCommitV0StateAreaForPath("story/arc-goals.json")).toBe("arc_goals");
    expect(formalCommitV0StateAreaForPath("characters/lin-xiao/state.json")).toBe("character_state");
    expect(formalCommitV0StateAreaForPath("world/state.json")).toBe("world_state");
    expect(formalCommitV0StateAreaForPath("time/calendar.json")).toBe("calendar");
  });

  it("maps forbidden paths to expected forbidden areas", () => {
    expect(formalCommitV0ForbiddenAreaForPath("story/assets.json")).toBe("asset_ledger");
    expect(formalCommitV0ForbiddenAreaForPath("story/location-bible.json")).toBe("location_bible");
    expect(formalCommitV0ForbiddenAreaForPath("story/character-bible.json")).toBe("character_bible");
    expect(formalCommitV0ForbiddenAreaForPath("story/character-matrix.json")).toBe("character_matrix");
  });

  it("normalizeFormalCommitV0ChangedFiles dedupes while preserving order", () => {
    expect(normalizeFormalCommitV0ChangedFiles([
      "chapters/0001.md",
      "timeline/events.json",
      "chapters/0001.md",
      "story/hooks.json",
    ])).toMatchObject({
      acceptedFiles: ["chapters/0001.md", "timeline/events.json", "story/hooks.json"],
      rejectedFiles: [],
    });
  });

  it("normalizeFormalCommitV0ChangedFiles separates accepted and rejected files", () => {
    expect(normalizeFormalCommitV0ChangedFiles([
      "chapters/0001.md",
      "story/assets.json",
      "../outside.json",
      "notes/freeform.json",
    ])).toEqual({
      acceptedFiles: ["chapters/0001.md"],
      rejectedFiles: ["story/assets.json", "../outside.json", "notes/freeform.json"],
    });
  });

  it("exports the static allowed and forbidden path constants", () => {
    expect(FORMAL_COMMIT_V0_STATIC_ALLOWED_PATHS).toEqual([
      "timeline/events.json",
      "story/hooks.json",
      "story/threads.json",
      "story/arc-goals.json",
      "world/state.json",
      "time/calendar.json",
      "story/timeline.json",
      "story/fact-ledger.json",
    ]);
    expect(FORMAL_COMMIT_V0_FORBIDDEN_PATHS).toEqual([
      "story/assets.json",
      "story/location-bible.json",
      "story/character-bible.json",
      "story/character-matrix.json",
    ]);
  });

  it("identifies committed chapter output paths", () => {
    expect(isFormalCommitV0ChapterOutputPath("chapters/0001.md")).toBe(true);
    expect(isFormalCommitV0ChapterOutputPath("chapters/1.md")).toBe(false);
  });
});
