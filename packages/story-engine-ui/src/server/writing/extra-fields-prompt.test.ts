// @vitest-environment node
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildWriterContext } from "./context-gateway.js";
import { renderFastDraftPromptText } from "./prompt-cache-diagnostics.js";
import { createStoryProject, toSafeCharacterId } from "../book/project-store.js";

describe("extraFields reach the writer prompt", () => {
  it("renders custom extra fields from character state into the prompt text", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "story-engine-extrafields-"));
    const { projectDir } = await createStoryProject({
      rootDir,
      title: "我的修仙副本",
      genre: "xianxia",
      premise: "主角从杂役弟子逆袭。",
      mainCharacterName: "林晚",
    });
    const charId = "lin-wan";
    const dir = join(projectDir, "characters", toSafeCharacterId(charId));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "profile.json"), JSON.stringify({ id: charId, name: "林晚" }), "utf-8");
    await writeFile(join(dir, "core.json"), JSON.stringify({ characterId: charId, personality: ["坚韧"] }), "utf-8");
    await writeFile(join(dir, "state.json"), JSON.stringify({
      characterId: charId,
      emotion: "平静",
      goal: "突破金丹",
      extraFields: { 境界: "金丹期", 功法: ["奔雷诀"] },
    }), "utf-8");

    const envelope = await buildWriterContext({
      projectDir,
      chapter: 1,
      chapterGoal: "林晚突破金丹期。",
      selectedCharacterIds: [charId],
      maxTimelineEvents: 3,
    });
    const prompt = renderFastDraftPromptText(envelope);

    expect(prompt).toContain("境界");
    expect(prompt).toContain("金丹期");
    expect(prompt).toContain("奔雷诀");
  });

  it("renders custom extra fields from a location card into the prompt text", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "story-engine-extrafields-loc-"));
    const { projectDir } = await createStoryProject({
      rootDir,
      title: "我的修仙副本",
      genre: "xianxia",
      premise: "主角从杂役弟子逆袭。",
      mainCharacterName: "林晚",
    });
    await writeFile(join(projectDir, "story", "location-bible.json"), JSON.stringify({
      version: "v0",
      locations: [{
        id: "loc-forbidden-hall",
        name: "锁灵殿",
        type: "禁区",
        knownFeatures: [],
        risks: [],
        resources: [],
        extraFields: { 禁制类型: "困灵阵", 守卫: ["石傀儡", "雷符阵"] },
      }],
    }), "utf-8");

    const envelope = await buildWriterContext({
      projectDir,
      chapter: 1,
      chapterGoal: "林晚潜入锁灵殿。",
      maxTimelineEvents: 3,
    });
    const prompt = renderFastDraftPromptText(envelope);

    expect(prompt).toContain("禁制类型");
    expect(prompt).toContain("困灵阵");
    expect(prompt).toContain("石傀儡");
  });

  it("renders custom extra fields from an asset card into the prompt text", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "story-engine-extrafields-asset-"));
    const { projectDir } = await createStoryProject({
      rootDir,
      title: "我的修仙副本",
      genre: "xianxia",
      premise: "主角从杂役弟子逆袭。",
      mainCharacterName: "林晚",
    });
    await writeFile(join(projectDir, "story", "assets.json"), JSON.stringify({
      version: "v0",
      assets: [{
        id: "asset-thunder-blade",
        name: "玄铁雷刃",
        type: "keyItem",
        ownerName: "林晚",
        status: "available",
        extraFields: { 材质: "玄铁", 品阶: "法器", 附魔: ["雷属性", "破甲"] },
      }],
      containers: [],
    }), "utf-8");

    const envelope = await buildWriterContext({
      projectDir,
      chapter: 1,
      chapterGoal: "林晚祭炼玄铁雷刃。",
      maxTimelineEvents: 3,
    });
    const prompt = renderFastDraftPromptText(envelope);

    expect(prompt).toContain("材质");
    expect(prompt).toContain("玄铁");
    expect(prompt).toContain("品阶");
    expect(prompt).toContain("法器");
  });
});
