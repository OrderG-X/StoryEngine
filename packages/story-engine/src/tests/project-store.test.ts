import { access, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  createStoryProject,
  readAssetLedger,
  readCharacterBible,
  readCharacterCore,
  readCharacterProfile,
  readCharacterState,
  readArcGoalPool,
  readHookPool,
  readLocationBible,
  readProject,
  readStoryCalendar,
  readStoryBible,
  readStoryCore,
  readThreadPool,
  readTimelineEvents,
  readWorldBible,
  readWorldCore,
  readWorldState,
  readWritingRules,
  isSentinelEntityId,
  toSafeCharacterId,
  writeFileAtomic,
} from "../project-store.js";

describe("StoryEngine-NG ProjectStore", () => {
  it("creates and reads the minimal structured project layout", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "story-engine-ng-"));
    const result = await createStoryProject({
      rootDir,
      title: "我的修仙副本",
      genre: "xianxia",
      premise: "用户自己当主角，从杂役弟子开始逆袭。",
      mainCharacterName: "Guo Xu / 主角",
    });
    const characterId = "guo-xu";

    await expect(access(join(result.projectDir, "project.json"))).resolves.toBeUndefined();
    await expect(access(join(result.projectDir, "world", "core.json"))).resolves.toBeUndefined();
    await expect(access(join(result.projectDir, "world", "state.json"))).resolves.toBeUndefined();
    await expect(access(join(result.projectDir, "story", "core.json"))).resolves.toBeUndefined();
    await expect(access(join(result.projectDir, "story", "bible.json"))).resolves.toBeUndefined();
    await expect(access(join(result.projectDir, "story", "writing-rules.json"))).resolves.toBeUndefined();
    await expect(access(join(result.projectDir, "story", "character-bible.json"))).resolves.toBeUndefined();
    await expect(access(join(result.projectDir, "story", "world-bible.json"))).resolves.toBeUndefined();
    await expect(access(join(result.projectDir, "story", "location-bible.json"))).resolves.toBeUndefined();
    await expect(access(join(result.projectDir, "story", "assets.json"))).resolves.toBeUndefined();
    await expect(access(join(result.projectDir, "story", "hooks.json"))).resolves.toBeUndefined();
    await expect(access(join(result.projectDir, "story", "threads.json"))).resolves.toBeUndefined();
    await expect(access(join(result.projectDir, "story", "arc-goals.json"))).resolves.toBeUndefined();
    await expect(access(join(result.projectDir, "timeline", "events.json"))).resolves.toBeUndefined();
    await expect(access(join(result.projectDir, "time", "calendar.json"))).resolves.toBeUndefined();
    await expect(access(join(result.projectDir, "characters", characterId, "profile.json"))).resolves.toBeUndefined();
    await expect(access(join(result.projectDir, "characters", characterId, "core.json"))).resolves.toBeUndefined();
    await expect(access(join(result.projectDir, "characters", characterId, "state.json"))).resolves.toBeUndefined();

    expect((await stat(join(result.projectDir, "drafts", "fast"))).isDirectory()).toBe(true);
    expect((await stat(join(result.projectDir, "chapters"))).isDirectory()).toBe(true);

    await expect(readProject(result.projectDir)).resolves.toMatchObject({
      id: expect.stringMatching(/^story-[a-f0-9]{6}$/u),
      title: "我的修仙副本",
    });
    await expect(readWorldCore(result.projectDir)).resolves.toMatchObject({
      genre: "xianxia",
      premise: "用户自己当主角，从杂役弟子开始逆袭。",
    });
    await expect(readWorldState(result.projectDir)).resolves.toMatchObject({
      currentPhase: "开篇",
      lastUpdatedChapter: null,
    });
    await expect(readStoryCore(result.projectDir)).resolves.toMatchObject({
      readerPromise: "用户自己当主角，从杂役弟子开始逆袭。",
    });
    await expect(readStoryBible(result.projectDir)).resolves.toMatchObject({
      version: "v0",
      genre: "xianxia",
      readerPromise: "用户自己当主角，从杂役弟子开始逆袭。",
    });
    await expect(readWritingRules(result.projectDir)).resolves.toMatchObject({
      version: "v0",
      narrativePerspective: "第三人称有限视角",
      pacing: "中等",
    });
    await expect(readCharacterBible(result.projectDir)).resolves.toMatchObject({
      version: "v0",
      characters: [expect.objectContaining({
        id: characterId,
        name: "Guo Xu / 主角",
        desire: "进入开篇情境并面对核心变化",
      })],
    });
    await expect(readWorldBible(result.projectDir)).resolves.toMatchObject({
      version: "v0",
      rules: [],
    });
    // 系统约束句是产品不变量，不再种进故事向 bible / world rules（2026-07-12 稀疏态审计）。
    const bible = await readStoryBible(result.projectDir);
    expect(bible).not.toBeNull();
    expect(bible!.forbiddenChanges ?? []).not.toContain("正式事实只能通过确认提交更新。");
    await expect(readLocationBible(result.projectDir)).resolves.toEqual({
      version: "v0",
      locations: [],
    });
    await expect(readAssetLedger(result.projectDir)).resolves.toEqual({
      version: "v0",
      assets: [],
      containers: [],
    });
    await expect(readHookPool(result.projectDir)).resolves.toEqual({ hooks: [] });
    await expect(readThreadPool(result.projectDir)).resolves.toEqual({ threads: [] });
    await expect(readArcGoalPool(result.projectDir)).resolves.toEqual({ goals: [] });
    await expect(readTimelineEvents(result.projectDir)).resolves.toEqual([]);
    await expect(readStoryCalendar(result.projectDir)).resolves.toMatchObject({
      currentStoryDay: 1,
      currentTimeOfDay: "unknown",
    });
    await expect(readCharacterProfile(result.projectDir, characterId)).resolves.toMatchObject({
      id: characterId,
      name: "Guo Xu / 主角",
      identity: "protagonist",
    });
    await expect(readCharacterCore(result.projectDir, characterId)).resolves.toMatchObject({
      characterId,
      personality: ["自主行动"],
    });
    await expect(readCharacterState(result.projectDir, characterId)).resolves.toMatchObject({
      characterId,
      relationshipToUser: "本人",
      lastUpdatedChapter: null,
    });
  });

  it("sanitizes character ids for safe filesystem paths", () => {
    expect(toSafeCharacterId(" Lin Wan-Qing!! ")).toBe("lin-wan-qing");
    expect(toSafeCharacterId("../林婉清")).toMatch(/^char-[a-f0-9]{6}$/u);
  });

  it("isSentinelEntityId 标记哨兵占位词（none/null/undefined…），用于生成侧跳过", () => {
    for (const sentinel of ["none", "null", "undefined", "NONE", " none ", "N/A", "", undefined]) {
      expect(isSentinelEntityId(sentinel)).toBe(true);
    }
    expect(isSentinelEntityId("char-ffe5af")).toBe(false);
    expect(isSentinelEntityId("陈雨薇")).toBe(false);
  });

  it("⚠️向后兼容：toSafeCharacterId 不改写哨兵词（旧书 id/目录恰为 \"none\" 的角色仍读得到文件）", () => {
    // toSafeId 既归一已有 id 去读文件，绝不能把 "none" 算成 char-<hash>，否则旧书 characters/none/ 读不到→崩。
    expect(toSafeCharacterId("none")).toBe("none");
    expect(toSafeCharacterId("null")).toBe("null");
  });

  it("keeps Chinese project ids stable and avoids same-title directory collisions", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "story-engine-ng-chinese-id-"));
    const first = await createStoryProject({
      rootDir,
      title: "从零开始的海天市",
      genre: "urban",
      premise: "普通人进入城市英灵体系。",
      mainCharacterName: "林序",
    });
    const second = await createStoryProject({
      rootDir,
      title: "从零开始的海天市",
      genre: "urban",
      premise: "同名项目不覆盖旧项目。",
      mainCharacterName: "林序",
    });

    expect(first.project.id).toMatch(/^story-[a-f0-9]{6}$/u);
    expect(second.project.id).toBe(`${first.project.id}-2`);
    expect(first.projectDir).not.toBe(second.projectDir);
  });

  it("writeFileAtomic 自建缺失父目录并落盘（path.join 深层子目录目标）", async () => {
    // 复审 C 级收尾：目标路径父目录不存在时 writeFileAtomic 必须 mkdir -p 自建——
    // 现存调用点目录都预建/必存在，这条专门钉「父目录缺失」的兜底行为
    // （咬「mkdir 跳过/dir 算错」变异；Windows `\` 路径下旧 lastIndexOf("/") 正是死在这里）。
    const rootDir = await mkdtemp(join(tmpdir(), "story-engine-ng-atomic-"));
    const target = join(rootDir, "nested", "deeper", "target.json");

    await writeFileAtomic(target, "{ \"ok\": true }\n");

    await expect(readFile(target, "utf-8")).resolves.toBe("{ \"ok\": true }\n");
    // rename 已消费 tmp：目录里只有目标文件，无 .tmp- 残渣。
    expect(await readdir(join(rootDir, "nested", "deeper"))).toEqual(["target.json"]);
  });

  it("rolls back partial project directories when initial creation fails", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "story-engine-ng-rollback-"));
    await expect(createStoryProject({
      rootDir,
      title: "rollback probe",
      genre: "urban",
      premise: "This should fail before leaving a half-created project.",
      mainCharacterName: "a".repeat(300),
    })).rejects.toThrow();

    await expect(access(join(rootDir, "story-engine", "rollback-probe"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
