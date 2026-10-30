// @vitest-environment node
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createStoryProject } from "./project-store.js";
import { buildStateOverview } from "./state-overview.js";

describe("State Overview defensive readers", () => {
  it("project.json 坏了：书名按占位显示，但如实挂警告（审计 Low：面板显示「坏」而非「空」）", async () => {
    const projectDir = await createLegacyBookWithSparseFiles();
    await writeFile(join(projectDir, "project.json"), "{not-json", "utf-8");

    const overview = await buildStateOverview({ projectDir, chapter: 1 });

    // 读侧降级照做（不堵概览）
    expect(overview.uiHints.warnings.join(" ")).toContain("资料文件损坏");
    expect(overview.uiHints.warnings.join(" ")).toContain("project.json");
  });

  it("老书还没有设定卡：从手写的老设定文件现拼（缺字段不崩、不写盘）", async () => {
    const projectDir = await createLegacyBookWithSparseFiles();

    const overview = await buildStateOverview({ projectDir, chapter: 1 });

    expect(overview.storyStatus.currentObjective).toBeUndefined();
    expect(overview.project.genre).toBe("mystery");
    expect(overview.setting.cards).toEqual({ characters: 0, places: 1, items: 0, lore: 0 });
    expect(overview.setting.targetChapterWords).toBeUndefined();
  });

  it("设定卡文件坏了：设定本按空显示，并如实提醒", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "story-engine-defensive-cards-"));
    const { projectDir } = await createStoryProject({ rootDir, title: "坏卡", protagonistName: "林澈" });
    await writeFile(join(projectDir, "ledger", "cards.json"), "{not-json", "utf-8");

    const overview = await buildStateOverview({ projectDir, chapter: 1 });

    expect(overview.setting.cards).toEqual({ characters: 0, places: 0, items: 0, lore: 0 });
    expect(overview.characters.protagonist).toBeUndefined();
    expect(overview.uiHints.warnings.join(" ")).toContain("设定卡读不出来");
  });

  it("新建的书：作者填了什么概况就有什么，没填的不编", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "story-engine-defensive-complete-"));
    const { projectDir } = await createStoryProject({
      rootDir,
      title: "完整项目",
      genre: "mystery",
      logline: "完整默认项目仍应正常生成状态总览。",
      protagonistName: "林澈",
    });

    const overview = await buildStateOverview({ projectDir, chapter: 1 });

    expect(overview.project).toMatchObject({
      title: "完整项目",
      genre: "mystery",
      logline: "完整默认项目仍应正常生成状态总览。",
      currentChapter: 1,
    });
    expect(overview.characters.protagonist).toBe("林澈");
    expect(overview.setting.cards.characters).toBe(1);
    expect(overview.setting.storyFields).toBe(2);
    expect(overview.setting.targetChapterWords).toBeUndefined();

    const blank = await createStoryProject({ rootDir, title: "空书" });
    const empty = await buildStateOverview({ projectDir: blank.projectDir });
    expect(empty.project).toMatchObject({ title: "空书", genre: "", logline: "" });
    expect(empty.characters).toEqual({ knownCharacters: [] });
  });
});

/** P9 以前的书：只有 project.json 和几份手写的老设定文件，没有 ledger/cards.json。 */
async function createLegacyBookWithSparseFiles(): Promise<string> {
  const projectDir = await mkdtemp(join(tmpdir(), "story-engine-defensive-readers-"));
  await mkdir(join(projectDir, "story"), { recursive: true });
  await Promise.all([
    writeJson(projectDir, "project.json", { id: "old", title: "旧项目", createdAt: "", updatedAt: "" }),
    writeJson(projectDir, "story/core.json", { tone: "quiet" }),
    writeJson(projectDir, "story/bible.json", { version: "v0", genre: "mystery", setupAssets: {} }),
    writeJson(projectDir, "story/writing-rules.json", { version: "v0", narrativePerspective: "third_limited" }),
    writeJson(projectDir, "story/world-bible.json", { version: "v0" }),
    writeJson(projectDir, "story/location-bible.json", {
      version: "v0",
      locations: [{ id: "old-building", name: "旧楼", type: "building" }],
    }),
  ]);
  return projectDir;
}

async function writeJson(projectDir: string, relativePath: string, value: unknown): Promise<void> {
  await writeFile(join(projectDir, relativePath), `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}
