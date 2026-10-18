// @vitest-environment node
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { AliasTable } from "./alias-generator.js";
import { DEFAULT_MAX_IN_SCENE_CHARACTERS, detectInSceneCharacters, resolveSelectedCharacterIds } from "./in-scene-detector.js";

describe("detectInSceneCharacters", () => {
  it("selects a character when the previous chapter mentions a multi-character alias", () => {
    const result = detectInSceneCharacters({
      characters: charactersFixture(),
      aliasTable: aliasTableFixture(),
      chapterGoal: "这一章继续推进谈判。",
      previousChapterText: "上一章结尾，林总在审计室外停下脚步。",
      prevChapterFound: true,
      activeRelatedCharacterIds: [],
    });

    expect(result.selectedCharacterIds).toContain("c-guo");
    expect(result.trace.byId["c-guo"]).toMatchObject({ viaPrevBody: true, alwaysResident: true });
  });

  it("keeps protagonist and active arc or thread characters even without text matches", () => {
    const result = detectInSceneCharacters({
      characters: charactersFixture(),
      aliasTable: aliasTableFixture(),
      chapterGoal: "这一章不点名任何角色。",
      previousChapterText: "",
      prevChapterFound: false,
      activeRelatedCharacterIds: ["c-arc", "c-thread"],
    });

    expect(result.selectedCharacterIds).toEqual(["c-main", "c-arc", "c-thread"]);
    expect(result.trace.byId["c-main"]).toMatchObject({ alwaysResident: true });
    expect(result.trace.byId["c-arc"]).toMatchObject({ alwaysResident: true });
    expect(result.trace.byId["c-thread"]).toMatchObject({ alwaysResident: true });
  });

  it("does not match one-character aliases that can collide with ordinary words", () => {
    const result = detectInSceneCharacters({
      characters: charactersFixture(),
      aliasTable: aliasTableFixture(),
      chapterGoal: "旭日照进大厅，但没人提到那位总裁。",
      previousChapterText: "",
      prevChapterFound: true,
      activeRelatedCharacterIds: [],
    });

    expect(result.selectedCharacterIds).not.toContain("c-guo");
    expect(result.selectedCharacterIds).toEqual(["c-main"]);
  });

  it("falls back to protagonist plus active arc characters when no previous chapter exists", () => {
    const result = detectInSceneCharacters({
      characters: charactersFixture(),
      aliasTable: aliasTableFixture(),
      chapterGoal: "",
      previousChapterText: "",
      prevChapterFound: false,
      activeRelatedCharacterIds: ["c-arc"],
    });

    expect(result.selectedCharacterIds).toEqual(["c-main", "c-arc"]);
    expect(result.trace.prevChapterFound).toBe(false);
  });

  // #360 题材中立·模型无关：character-bible 完全可能出现 role 缺失/为 null 的退化角色卡
  // （新书早期、模型写卡漏 role、旧书）。isProtagonist 旧码 character.role.includes(...) 对 null
  // 取 .includes 会抛 TypeError → 整个自动在场检测崩。守卫后不崩、主角仍识别、缺 role 按非主角。
  it("does not crash when a character's role is null/undefined (degenerate bible)", () => {
    const characters = [
      ...charactersFixture(),
      { id: "c-norole", name: "无角色卡", role: null } as unknown as ReturnType<typeof charactersFixture>[number],
    ];

    const result = detectInSceneCharacters({
      characters,
      aliasTable: aliasTableFixture(),
      chapterGoal: "无角色卡 出现在这一章。",
      previousChapterText: "",
      prevChapterFound: false,
      activeRelatedCharacterIds: [],
    });

    // 不崩；主角（role=主角）仍恒在；缺 role 的角色命中 goal 仍入选，但不被当主角、不导致崩溃。
    expect(result.selectedCharacterIds).toContain("c-main");
    expect(result.selectedCharacterIds).toContain("c-norole");
    expect(result.trace.byId["c-norole"]?.reasons ?? []).not.toContain("protagonist");
  });
});

// 收口洞②（堵 stable 体量入口）：长篇里活跃弧线累积 + 群像章上章命中一大票 → selected 膨胀，
// 而 character_profile/core 是 stable 段、预算器裁不动 → "几乎全选"使 Phase 1 收窄形同虚设。
// 软 cap：主角恒保 + 按在场信号强度（方向命中=3 / 上章命中=2 / 活跃弧线=1）取前 N，收窄露在 trace、可复现。
describe("detectInSceneCharacters 软 cap（堵 stable 膨胀）", () => {
  function bigFixture() {
    return [
      { id: "c-main", name: "林晚", role: "主角" },
      { id: "c-goal", name: "林远", role: "总裁" },
      { id: "c-prev", name: "顾远", role: "配角" },
      { id: "c-arc1", name: "周宁", role: "配角" },
      { id: "c-arc2", name: "沈砚", role: "配角" },
      { id: "c-arc3", name: "白薇", role: "配角" },
    ];
  }
  function bigAlias(): AliasTable {
    return {
      version: "v0",
      byEntity: {
        "c-main": { canonicalName: "林晚", primary: "林晚", aliases: ["林晚"], generated: [], type: "character" },
        "c-goal": { canonicalName: "林远", primary: "林远", aliases: ["林远"], generated: [], type: "character" },
        "c-prev": { canonicalName: "顾远", primary: "顾远", aliases: ["顾远"], generated: [], type: "character" },
        "c-arc1": { canonicalName: "周宁", primary: "周宁", aliases: ["周宁"], generated: [], type: "character" },
        "c-arc2": { canonicalName: "沈砚", primary: "沈砚", aliases: ["沈砚"], generated: [], type: "character" },
        "c-arc3": { canonicalName: "白薇", primary: "白薇", aliases: ["白薇"], generated: [], type: "character" },
      },
      conflicts: [],
    };
  }

  it("selected 超过软 cap → 主角恒保 + 按在场信号取前 N，未纳入的露在 trace.cappedOutNames", () => {
    const result = detectInSceneCharacters({
      characters: bigFixture(),
      aliasTable: bigAlias(),
      chapterGoal: "本章林远摊牌。", // c-goal 方向命中=3
      previousChapterText: "顾远昨夜离开。", // c-prev 上章命中=2
      prevChapterFound: true,
      activeRelatedCharacterIds: ["c-arc1", "c-arc2", "c-arc3"], // 各 +1，最弱
      maxInScene: 3,
    });

    // 主角(∞) + 方向命中(3) + 上章命中(2) 胜出；三个仅活跃弧线(1) 被收窄出
    expect(result.selectedCharacterIds).toEqual(["c-main", "c-goal", "c-prev"]);
    expect([...result.trace.cappedOutNames ?? []].sort()).toEqual(["周宁", "沈砚", "白薇"]);
    expect(result.summary).toContain("收窄");
  });

  it("selected ≤ 软 cap → 不收窄、cappedOutNames 为空", () => {
    const result = detectInSceneCharacters({
      characters: bigFixture(),
      aliasTable: bigAlias(),
      chapterGoal: "本章林远摊牌。",
      previousChapterText: "",
      prevChapterFound: true,
      activeRelatedCharacterIds: [],
      maxInScene: 8,
    });

    expect(result.selectedCharacterIds).toEqual(["c-main", "c-goal"]);
    expect(result.trace.cappedOutNames ?? []).toEqual([]);
  });

  it("收窄结果稳定可复现（cache-safe：同输入同输出）", () => {
    const input = {
      characters: bigFixture(),
      aliasTable: bigAlias(),
      chapterGoal: "本章林远摊牌。",
      previousChapterText: "顾远昨夜离开。",
      prevChapterFound: true,
      activeRelatedCharacterIds: ["c-arc1", "c-arc2", "c-arc3"],
      maxInScene: 3,
    };
    expect(detectInSceneCharacters(input).selectedCharacterIds).toEqual(detectInSceneCharacters(input).selectedCharacterIds);
  });

  it("导出默认软 cap 常量（默认 8）", () => {
    expect(DEFAULT_MAX_IN_SCENE_CHARACTERS).toBe(8);
  });
});

describe("resolveSelectedCharacterIds", () => {
  it("reads aliases, previous chapter text, and active arc/thread character ids from a project", async () => {
    const projectDir = await tempProject();
    await writeFile(join(projectDir, ".story-engine-ui", "alias-tables.json"), `${JSON.stringify(aliasTableFixture(), null, 2)}\n`, "utf-8");
    await writeFile(join(projectDir, "chapters", "0001.md"), "# 第一章\n\n林总在楼下等候。", "utf-8");
    await writeFile(join(projectDir, "story", "arc-goals.json"), `${JSON.stringify({
      goals: [
        {
          id: "arc-1",
          title: "旧账压力",
          status: "active",
          scope: "mini_arc",
          firstSeenChapter: 1,
          lastTouchedChapter: 1,
          evidence: [],
          relatedCharacters: ["c-arc"],
        },
      ],
    }, null, 2)}\n`, "utf-8");
    await writeFile(join(projectDir, "story", "threads.json"), `${JSON.stringify({
      threads: [
        {
          id: "thread-1",
          type: "lead",
          title: "审计线索",
          status: "open",
          firstSeenChapter: 1,
          lastTouchedChapter: 1,
          evidence: [],
          relatedCharacters: ["c-thread"],
        },
      ],
    }, null, 2)}\n`, "utf-8");

    const resolved = await resolveSelectedCharacterIds({
      projectDir,
      chapter: 2,
      chapterGoal: "继续第二章。",
    });

    expect(resolved.selectedCharacterIds).toEqual(["c-main", "c-guo", "c-arc", "c-thread"]);
    expect(resolved.trace.prevChapterFound).toBe(true);
    expect(resolved.summary).toContain("本章相关角色：林晚、林远、顾远、周宁");
  });

  it("returns explicit selected ids unchanged without reading a narrower inferred set", async () => {
    const projectDir = await tempProject();

    const resolved = await resolveSelectedCharacterIds({
      projectDir,
      chapter: 3,
      chapterGoal: "继续第三章。",
      explicit: ["c-guo"],
    });

    expect(resolved.selectedCharacterIds).toEqual(["c-guo"]);
    expect(resolved.trace.explicit).toBe(true);
  });

  // QA bug：explicit 路径把原始 id 直接 join 进 summary（「本章相关角色：char-ffe5af」），用户可见。
  // 修后：读 bible 把 id 解析成角色名，summary/selectedNames 显名字而非 id；selectedCharacterIds 仍是 id（喂引擎用）。
  it("resolves explicit ids to character names in the summary instead of leaking raw ids", async () => {
    const projectDir = await tempProject();

    const resolved = await resolveSelectedCharacterIds({
      projectDir,
      chapter: 3,
      chapterGoal: "继续第三章。",
      explicit: ["c-guo", "c-arc"],
    });

    expect(resolved.selectedCharacterIds).toEqual(["c-guo", "c-arc"]);
    expect(resolved.trace.selectedNames).toEqual(["林远", "顾远"]);
    expect(resolved.summary).toBe("本章相关角色：林远、顾远");
    expect(resolved.summary).not.toContain("c-guo");
    expect(resolved.summary).not.toContain("c-arc");
  });

  // 接缝 bug（审计 + 真机 spot-verify 实锤）：explicit 含类别词/捏造/哨兵 id 时原样直透
  // → 下游 readCharacterProfile 读不存在的 profile → ENOENT 崩 + 泄露路径。
  // 修后：显式 ref 先按 bible 解析成存在的 canonical id，解析不到的丢弃；全丢则回落自动在场检测，绝不直透。
  it("explicit 全是类别词/捏造/哨兵 id（['主角','char-bogus','none']）→ 过滤为空、回落自动检测，绝不把不存在 id 直透下游", async () => {
    const projectDir = await tempProject();

    const resolved = await resolveSelectedCharacterIds({
      projectDir,
      chapter: 1,
      chapterGoal: "继续第一章。",
      explicit: ["主角", "char-bogus", "none"],
    });

    expect(resolved.selectedCharacterIds).not.toContain("主角");
    expect(resolved.selectedCharacterIds).not.toContain("char-bogus");
    expect(resolved.selectedCharacterIds).not.toContain("none");
    expect(resolved.trace.explicit).toBeUndefined(); // 走了自动检测、不是显式分支
    expect(resolved.selectedCharacterIds).toContain("c-main"); // 自动检测恒保主角
  });

  it("explicit 含一个真角色 + 捏造 id（['c-guo','char-bogus']）→ 留真角色、丢捏造 id，仍走显式", async () => {
    const projectDir = await tempProject();

    const resolved = await resolveSelectedCharacterIds({
      projectDir,
      chapter: 1,
      chapterGoal: "继续第一章。",
      explicit: ["c-guo", "char-bogus"],
    });

    expect(resolved.selectedCharacterIds).toEqual(["c-guo"]);
    expect(resolved.trace.explicit).toBe(true);
  });

  it("explicit 传角色名而非 id（['林远']）→ 解析回 canonical id c-guo，不当捏造 id 丢掉", async () => {
    const projectDir = await tempProject();

    const resolved = await resolveSelectedCharacterIds({
      projectDir,
      chapter: 1,
      chapterGoal: "继续第一章。",
      explicit: ["林远"],
    });

    expect(resolved.selectedCharacterIds).toEqual(["c-guo"]);
    expect(resolved.trace.explicit).toBe(true);
  });

  // ── 编辑部 R4.6（验收 3.7）：名册只有开书占位卡的新书 ─────────────────────────────
  // UI 建书模板未填主角名时落固定占位名「主角」；作者手写章节不会建卡。此时改用最近几章
  // 已定稿 ChapterDelta 的 charactersPresent（时间线 presentCharacterNames）当本章角色。
  describe("名册全是开书占位卡（编辑部 R4.6）", () => {
    async function placeholderRosterProject(): Promise<string> {
      const projectDir = await mkdtemp(join(tmpdir(), "presence-placeholder-"));
      await mkdir(join(projectDir, "story"), { recursive: true });
      await mkdir(join(projectDir, "chapters"), { recursive: true });
      await mkdir(join(projectDir, "timeline"), { recursive: true });
      await writeFile(join(projectDir, "project.json"), `${JSON.stringify({ title: "Placeholder Roster" }, null, 2)}\n`, "utf-8");
      await writeFile(join(projectDir, "story", "character-bible.json"), `${JSON.stringify({
        version: "v0",
        characters: [{ id: "zhu-jue", name: "主角", role: "主角", desire: "进入开篇情境", speechRules: [], behaviorBoundaries: [] }],
      }, null, 2)}\n`, "utf-8");
      await seedCharacterFiles(projectDir, "zhu-jue", "主角");
      await writeFile(join(projectDir, "chapters", "0001.md"), "# 第一章\n\n陆沉在灯塔下修表。", "utf-8");
      await writeFile(join(projectDir, "timeline", "events.json"), `${JSON.stringify([
        {
          id: "ch0001-001",
          chapter: 1,
          summary: "陆沉接下修表活。",
          participants: ["zhu-jue"],
          effects: { semanticSummary: { chapter: 1, mainEvent: "陆沉接下修表活。", presentCharacterNames: ["陆沉"] } },
        },
      ], null, 2)}\n`, "utf-8");
      return projectDir;
    }

    it("占位名册 + 已定稿声明有出场名 → chapterCharactersFromDeltas 带真名，summary 如实说明没拿占位名把关", async () => {
      const projectDir = await placeholderRosterProject();

      const resolved = await resolveSelectedCharacterIds({
        projectDir,
        chapter: 2,
        chapterGoal: "继续第二章。",
      });

      expect(resolved.chapterCharactersFromDeltas).toEqual(["陆沉"]);
      expect(resolved.summary).toContain("陆沉");
      expect(resolved.summary).toContain("按最近定稿章");
      expect(resolved.summary).toContain("没拿占位名把关");
      // 选择仍包含占位卡 id（喂引擎上下文用；关卡豁免在引擎侧按同一份占位标记做）。
      expect(resolved.selectedCharacterIds).toEqual(["zhu-jue"]);
    });

    it("占位名册 + 没有已定稿声明 → 无出场名，summary 如实说（不编名字）", async () => {
      const projectDir = await placeholderRosterProject();
      await writeFile(join(projectDir, "timeline", "events.json"), "[]\n", "utf-8");

      const resolved = await resolveSelectedCharacterIds({
        projectDir,
        chapter: 2,
        chapterGoal: "继续第二章。",
      });

      expect(resolved.chapterCharactersFromDeltas).toBeUndefined();
      expect(resolved.summary).toContain("开书占位");
      expect(resolved.summary).toContain("没拿占位名把关");
    });

    it("名册有真名（哪怕只一张真卡）→ 不走占位兜底，chapterCharactersFromDeltas 缺省（行为不变）", async () => {
      const projectDir = await placeholderRosterProject();
      // 把占位卡改成真名（作者已改名/起过真名的书）。
      await writeFile(join(projectDir, "story", "character-bible.json"), `${JSON.stringify({
        version: "v0",
        characters: [{ id: "zhu-jue", name: "陆沉", role: "主角", desire: "修表", speechRules: [], behaviorBoundaries: [] }],
      }, null, 2)}\n`, "utf-8");

      const resolved = await resolveSelectedCharacterIds({
        projectDir,
        chapter: 2,
        chapterGoal: "继续第二章。",
      });

      expect(resolved.chapterCharactersFromDeltas).toBeUndefined();
      expect(resolved.summary).toBe("本章相关角色：陆沉");
    });
  });

  // P1 残留（复审实锤）：下游 buildWriterContext 对每个 id 直读 characters/<id>/{profile,core,state}.json（无 catch、
  // 缺一即 ENOENT 崩）。所以「bible 里有、但没有角色目录/三件套文件」的 id 同样不能放行——必须按【可读性】过滤，
  // 不能只看 bible 成员（旧 bible∪dir 并集就漏了这类）。
  it("explicit id 在 bible 里但缺三件套文件（仅在册）→ 视为不可读、过滤、回落自动检测，不直透下游 ENOENT", async () => {
    const projectDir = await tempProject();
    // 往 bible 追加一个只在册、没有 characters/<id>/ 文件的幽灵角色。
    await writeFile(
      join(projectDir, "story", "character-bible.json"),
      `${JSON.stringify({ version: "v0", characters: [...charactersFixture(), { id: "c-ghost", name: "幽灵", role: "配角" }] }, null, 2)}\n`,
      "utf-8",
    );

    const resolved = await resolveSelectedCharacterIds({
      projectDir,
      chapter: 1,
      chapterGoal: "继续第一章。",
      explicit: ["c-ghost"],
    });

    expect(resolved.selectedCharacterIds).not.toContain("c-ghost"); // 不可读 → 不直透下游
    expect(resolved.trace.explicit).toBeUndefined(); // 全部不可读 → 回落自动检测
    expect(resolved.selectedCharacterIds).toContain("c-main"); // 自动检测恒保主角
  });

  it("explicit 同时含可读真角色 + 仅在册无文件的 id → 留可读的、丢无文件的", async () => {
    const projectDir = await tempProject();
    await writeFile(
      join(projectDir, "story", "character-bible.json"),
      `${JSON.stringify({ version: "v0", characters: [...charactersFixture(), { id: "c-ghost", name: "幽灵", role: "配角" }] }, null, 2)}\n`,
      "utf-8",
    );

    const resolved = await resolveSelectedCharacterIds({
      projectDir,
      chapter: 1,
      chapterGoal: "继续第一章。",
      explicit: ["c-guo", "c-ghost"],
    });

    expect(resolved.selectedCharacterIds).toEqual(["c-guo"]);
    expect(resolved.trace.explicit).toBe(true);
  });

  // 长篇命门 bug：agent 常把 selectedCharacterIds 传成空数组 []，旧逻辑当「显式指定」→ 走 explicit 分支
  // → 旁路自动在场检测 → 长篇后期角色一多就没有上下文裁剪（早期记忆塌陷/上下文爆炸）。
  // 修后：空数组（含全空白被清掉）不算显式指定，回落自动在场检测。
  it("explicit 传空数组 [] → 不算显式指定，回落自动在场检测（治 agent 传 [] 旁路长篇上下文裁剪）", async () => {
    const projectDir = await tempProject();

    const resolved = await resolveSelectedCharacterIds({
      projectDir,
      chapter: 1,
      chapterGoal: "继续第一章。",
      explicit: [],
    });

    // 不是显式分支（trace.explicit 不为 true），而是走了自动检测
    expect(resolved.trace.explicit).toBeUndefined();
    // 自动检测至少恒保主角（林晚=c-main）
    expect(resolved.selectedCharacterIds).toContain("c-main");
    expect(resolved.summary).toContain("林晚");
    expect(resolved.summary).not.toContain("显式为空");
  });

  it("explicit 传全空白 ['', '  '] → 清洗后为空，同样回落自动在场检测、不旁路", async () => {
    const projectDir = await tempProject();

    const resolved = await resolveSelectedCharacterIds({
      projectDir,
      chapter: 1,
      chapterGoal: "继续第一章。",
      explicit: ["", "  "],
    });

    expect(resolved.trace.explicit).toBeUndefined();
    expect(resolved.selectedCharacterIds).toContain("c-main");
  });

  // 模型无关·绝不泄露裸 char-hash & 防崩：解析不到的 char-xxxx id → 直接丢弃（不直透下游 ENOENT、也绝不漏进 summary）。
  // （旧行为是「留 id 显未知角色」，审计证明留着会让下游 readCharacterProfile 崩——改为丢弃，更干净。）
  it("explicit 的 char-hash id 解析不到 → 丢弃该 id（不直透下游、不泄露 char- 裸 id）", async () => {
    const projectDir = await tempProject();

    const resolved = await resolveSelectedCharacterIds({
      projectDir,
      chapter: 3,
      chapterGoal: "继续第三章。",
      explicit: ["c-guo", "char-deadbeef"],
    });

    expect(resolved.selectedCharacterIds).toEqual(["c-guo"]);
    expect(resolved.trace.selectedNames).toEqual(["林远"]);
    expect(resolved.summary).not.toContain("char-deadbeef");
  });

  // 解析不到的 id（非 char-hash 形状）同样丢弃，绝不直透下游 readCharacterProfile（会 ENOENT 崩）。
  it("explicit 含解析不到的 ref（c-unknown）→ 丢弃，只保留能解析的真角色", async () => {
    const projectDir = await tempProject();

    const resolved = await resolveSelectedCharacterIds({
      projectDir,
      chapter: 3,
      chapterGoal: "继续第三章。",
      explicit: ["c-guo", "c-unknown"],
    });

    expect(resolved.selectedCharacterIds).toEqual(["c-guo"]);
    expect(resolved.trace.selectedNames).toEqual(["林远"]);
    expect(resolved.summary).toBe("本章相关角色：林远");
  });
});

function charactersFixture() {
  return [
    { id: "c-main", name: "林晚", role: "主角" },
    { id: "c-guo", name: "林远", role: "总裁" },
    { id: "c-arc", name: "顾远", role: "配角" },
    { id: "c-thread", name: "周宁", role: "配角" },
  ];
}

function aliasTableFixture(): AliasTable {
  return {
    version: "v0",
    byEntity: {
      "c-main": { canonicalName: "林晚", primary: "林晚", aliases: ["晚"], generated: ["晚"], type: "character" },
      "c-guo": { canonicalName: "林远", primary: "林远", aliases: ["旭", "林总"], generated: ["旭", "林总"], type: "character" },
      "c-arc": { canonicalName: "顾远", primary: "顾远", aliases: ["顾远"], generated: ["顾远"], type: "character" },
      "c-thread": { canonicalName: "周宁", primary: "周宁", aliases: ["周宁"], generated: ["周宁"], type: "character" },
    },
    conflicts: [],
  };
}

async function tempProject(): Promise<string> {
  const projectDir = await mkdtemp(join(tmpdir(), "presence-detector-"));
  await Promise.all([
    mkdir(join(projectDir, "story"), { recursive: true }),
    mkdir(join(projectDir, "chapters"), { recursive: true }),
    mkdir(join(projectDir, ".story-engine-ui"), { recursive: true }),
  ]);
  await writeFile(join(projectDir, "project.json"), `${JSON.stringify({ title: "Presence Test" }, null, 2)}\n`, "utf-8");
  await writeFile(join(projectDir, "story", "character-bible.json"), `${JSON.stringify({
    version: "v0",
    characters: charactersFixture(),
  }, null, 2)}\n`, "utf-8");
  // 真书里每个 bible 角色都有 characters/<id>/{profile,core,state}.json 三件套（下游 writer context 真读它）；
  // fixture 一并落盘——否则「册有、文件缺」会让可读性过滤误判，也才能测出 P1：仅在册无文件的 id 必须被过滤。
  await Promise.all(charactersFixture().map((character) => seedCharacterFiles(projectDir, character.id, character.name)));
  await expect(readFile(join(projectDir, "story", "character-bible.json"), "utf-8")).resolves.toContain("林远");
  return projectDir;
}

async function seedCharacterFiles(projectDir: string, id: string, name: string): Promise<void> {
  const dir = join(projectDir, "characters", id);
  await mkdir(dir, { recursive: true });
  await Promise.all([
    writeFile(join(dir, "profile.json"), `${JSON.stringify({ id, name }, null, 2)}\n`, "utf-8"),
    writeFile(join(dir, "core.json"), `${JSON.stringify({ characterId: id }, null, 2)}\n`, "utf-8"),
    writeFile(join(dir, "state.json"), `${JSON.stringify({ characterId: id, lastUpdatedChapter: null }, null, 2)}\n`, "utf-8"),
  ]);
}
