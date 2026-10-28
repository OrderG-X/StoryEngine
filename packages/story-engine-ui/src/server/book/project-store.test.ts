// @vitest-environment node
import { access, mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { SettingCardsFile } from "@actalk/story-core";
import {
  createStoryProject,
  readArcGoalPool,
  readHookPool,
  readProject,
  readStoryCalendar,
  readThreadPool,
  readTimelineEvents,
  writeFileAtomic,
} from "./project-store.js";

async function readCardsFile(projectDir: string): Promise<SettingCardsFile> {
  return SettingCardsFile.parse(JSON.parse(await readFile(join(projectDir, "ledger", "cards.json"), "utf-8")));
}

describe("StoryEngine-NG ProjectStore", () => {
  it("新书目录名：中文书名只剩数字时用 story-<hash>，有英文词时用英文词", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "story-engine-ng-"));
    const digits = await createStoryProject({ rootDir, title: "改名测试书2" });
    expect(digits.projectDir.split("/").at(-1)).toMatch(/^story-[0-9a-z]+$/u);
    const english = await createStoryProject({ rootDir, title: "UI审计-20260912" });
    expect(english.projectDir.split("/").at(-1)).toBe("ui-20260912");
  });

  it("建书只写 project.json、chapters/ 和设定卡：题材、一句话进故事设定，主角是一张标了主角的人物卡", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "story-engine-ng-"));
    const result = await createStoryProject({
      rootDir,
      title: "我的修仙副本",
      genre: "xianxia",
      logline: "用户自己当主角，从杂役弟子开始逆袭。",
      protagonistName: "Guo Xu",
    });

    // 不再建老格式目录、不写模板占位文件（store-control 是核心的写入代次，写设定卡时记下）。
    const top = (await readdir(result.projectDir)).filter((name) => !name.startsWith(".")).sort();
    expect(top).toEqual(["chapters", "ledger", "project.json", "store-control"]);
    expect((await stat(join(result.projectDir, "chapters"))).isDirectory()).toBe(true);
    for (const legacy of ["story", "world", "characters", "timeline", "time", "drafts"]) {
      await expect(access(join(result.projectDir, legacy))).rejects.toMatchObject({ code: "ENOENT" });
    }

    await expect(readProject(result.projectDir)).resolves.toMatchObject({
      id: expect.stringMatching(/^story-[a-f0-9]{6}$/u),
      title: "我的修仙副本",
    });

    const cards = await readCardsFile(result.projectDir);
    expect(cards.story.fields.map(({ label, value, by }) => ({ label, value, by }))).toEqual([
      { label: "题材", value: "xianxia", by: "author" },
      { label: "一句话", value: "用户自己当主角，从杂役弟子开始逆袭。", by: "author" },
    ]);
    expect(cards.cards).toHaveLength(1);
    expect(cards.cards[0]).toMatchObject({ kind: "character", name: "Guo Xu", aliases: [], protagonist: true, fields: [], by: "author" });
    expect(cards.relations).toEqual([]);
    // 不再写默认写作规则（目标字数 1800、第三人称有限视角……）。
    expect(cards.rules).toEqual({ style: [], musts: [], bans: [], avoid: [], exemplars: [] });

    // 账的读口：没有老文件就按空的读。
    await expect(readHookPool(result.projectDir)).resolves.toEqual({ hooks: [] });
    await expect(readThreadPool(result.projectDir)).resolves.toEqual({ threads: [] });
    await expect(readArcGoalPool(result.projectDir)).resolves.toEqual({ goals: [] });
    await expect(readTimelineEvents(result.projectDir)).resolves.toEqual([]);
    await expect(readStoryCalendar(result.projectDir)).resolves.toEqual({ currentStoryDay: 1, currentTimeOfDay: "unknown" });
  });

  it("作者没填（或只填了空格）的不写：没有占位主角、占位前提，设定卡是空的", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "story-engine-ng-bare-"));
    const bare = await createStoryProject({ rootDir, title: "只有书名" });
    const blank = await createStoryProject({ rootDir, title: "全是空格", genre: "  ", logline: "", protagonistName: " " });

    for (const { projectDir } of [bare, blank]) {
      const cards = await readCardsFile(projectDir);
      expect(cards.story.fields).toEqual([]);
      expect(cards.cards).toEqual([]);
      expect(cards.relations).toEqual([]);
      expect(cards.rules).toEqual({ style: [], musts: [], bans: [], avoid: [], exemplars: [] });
      const raw = await readFile(join(projectDir, "ledger", "cards.json"), "utf-8");
      for (const placeholder of ["主角", "长篇故事", "主角进入一个等待展开的故事世界", "1800"]) {
        expect(raw).not.toContain(placeholder);
      }
    }
  });

  it("keeps Chinese project ids stable and avoids same-title directory collisions", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "story-engine-ng-chinese-id-"));
    const first = await createStoryProject({
      rootDir,
      title: "从零开始的海天市",
      genre: "urban",
      logline: "普通人进入城市英灵体系。",
      protagonistName: "林序",
    });
    const second = await createStoryProject({
      rootDir,
      title: "从零开始的海天市",
      genre: "urban",
      logline: "同名项目不覆盖旧项目。",
      protagonistName: "林序",
    });

    expect(first.project.id).toMatch(/^story-[a-f0-9]{6}$/u);
    expect(second.project.id).toBe(`${first.project.id}-2`);
    expect(first.projectDir).not.toBe(second.projectDir);
    // 两本各写各的设定卡，后建的不覆盖先建的。
    expect((await readCardsFile(first.projectDir)).story.fields.find((field) => field.label === "一句话")?.value).toBe("普通人进入城市英灵体系。");
    expect((await readCardsFile(second.projectDir)).story.fields.find((field) => field.label === "一句话")?.value).toBe("同名项目不覆盖旧项目。");
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

  it("设定卡没写成（主角名超长被核心拒）：整本回滚，书库里不留半截目录", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "story-engine-ng-rollback-"));
    await expect(createStoryProject({
      rootDir,
      title: "rollback probe",
      genre: "urban",
      logline: "This should fail before leaving a half-created project.",
      protagonistName: "a".repeat(300),
    })).rejects.toThrow(/参数不对/u);

    await expect(access(join(rootDir, "story-engine", "rollback-probe"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(join(rootDir, "story-engine"))).toEqual([]);

    // 回滚干净：同名书再建一次拿到原来的目录名（没有被残留占掉变成 -2）。
    const retry = await createStoryProject({ rootDir, title: "rollback probe", protagonistName: "Lin" });
    expect(retry.projectDir.split("/").at(-1)).toBe("rollback-probe");
  });
});
