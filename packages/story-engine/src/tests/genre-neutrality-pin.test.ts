import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCommitPlanFromProject, extractChapterSemanticSummary } from "../commit-plan-builder.js";
import { analyzeIntentLifecycle } from "../intent-lifecycle-diagnostics.js";
import { createStoryProject } from "../project-store.js";
import type { CharacterProfile, NarrativeThread } from "../types.js";

// C2c genre-neutrality pins. These guard against re-introducing hardcoded
// prior-work ("末世/丧尸") or any genre-specific term tables into the engine's
// extraction / scoring / classification heuristics. The engine must extract,
// score, and classify using only generic narrative signals and project-driven
// data (location-bible, character names), never baked-in genre vocabulary.
const LEGACY_GENRE_TERMS = /林镇山|远山集团|周景行|陈国辉|灵石|避难所广播|无线电异常信号|感染者|旧城区灾变|林序|许澄|魂钢|创业孵化楼|财团联合检测中心|老邮局|海天市/u;

describe("genre neutrality pins", () => {
  it("never emits a genreProgression field from commit plan extraction (xianxia draft)", async () => {
    const projectDir = await createXianxiaProject();
    await writeDraft(projectDir, 1, [
      "# 第一章 外院账册",
      "",
      "林远在外院园圃被管事当众克扣月钱，还遭到同门挑衅。",
      "他发现账房角落里藏着一本账目，意识到管事暗中克扣外院资源。",
      "他决定先去库房查清账册来源，不能再任人打压。",
    ].join("\n"));

    const result = await buildCommitPlanFromProject({ projectDir, chapter: 1 });

    expect(result.passed).toBe(true);
    expect(result.semanticSummary).toBeDefined();
    expect(Object.keys(result.semanticSummary ?? {})).not.toContain("genreProgression");
    expect(JSON.stringify(result.semanticSummary)).not.toMatch(/genreProgression/u);
  });

  it("does not inject apocalypse phase goals or broadcast/shelter leads into a xianxia archive", async () => {
    const projectDir = await createXianxiaProject();
    await writeDraft(projectDir, 1, [
      "# 第一章 外院账册",
      "",
      "林远在外院园圃被管事当众克扣月钱，还遭到同门挑衅。",
      "他发现账房角落里藏着一本账目，意识到管事暗中克扣外院资源。",
      "他决定先去库房查清账册来源，不能再任人打压。",
    ].join("\n"));

    const result = await buildCommitPlanFromProject({ projectDir, chapter: 1 });

    const arcTitles = result.arcGoalUpdates?.map((goal) => goal.title).join("\n") ?? "";
    const threadTitles = result.threadTrackingUpdates?.map((thread) => thread.title).join("\n") ?? "";
    expect(arcTitles).not.toMatch(/活过前三天|确认无线电信号来源|判断避难所广播真假|找到稳定水源/u);
    expect(threadTitles).not.toMatch(/活过前三天|确认无线电信号来源|判断避难所广播真假|找到稳定水源/u);
    expect(arcTitles).not.toMatch(LEGACY_GENRE_TERMS);
    expect(threadTitles).not.toMatch(LEGACY_GENRE_TERMS);
  });

  it("does not leak prior-work proper nouns from a clean urban draft", async () => {
    const projectDir = await createUrbanProject();
    await writeDraft(projectDir, 1, [
      "# 第一章",
      "",
      "陶然在写字楼前台领到访客证，注意到登记簿上有人冒用了她的部门名义。",
      "她决定先去档案室核对原始合同，弄清谁在背后伪造审批。",
      "保安提醒她三楼办公区下班后不对访客开放。",
    ].join("\n"));

    const result = await buildCommitPlanFromProject({ projectDir, chapter: 1 });
    const summaryText = JSON.stringify(result.semanticSummary ?? {});

    expect(result.passed).toBe(true);
    expect(summaryText).not.toMatch(LEGACY_GENRE_TERMS);
  });

  it("extracts locations only from the project location-bible, not a baked-in table", () => {
    const characters: CharacterProfile[] = [{ id: "character", name: "苏晚", appearance: {} }];

    const summary = extractChapterSemanticSummary({
      chapter: 2,
      draft: [
        "# 第二章",
        "",
        "苏晚走进雾隐谷的星辉殿，又绕到悬空回廊看了一眼。",
        "她没有去园圃，也没有进避难所，只是停在星辉殿前确认门匾的刻字。",
      ].join("\n"),
      characters,
      hooks: [],
      defaultCharacterId: "character",
      knownLocations: ["雾隐谷", "星辉殿", "悬空回廊"],
    });

    expect(summary.locations).toEqual(expect.arrayContaining(["星辉殿"]));
    // Locations the draft mentions but that are NOT in the project bible must not
    // appear, proving extraction is data-driven rather than table-driven.
    expect(summary.locations).not.toContain("园圃");
    expect(summary.locations).not.toContain("避难所");
  });

  it("classifies campus/urban intents without depending on apocalypse vocabulary", () => {
    const report = analyzeIntentLifecycle({
      threads: [
        intentThread("intent-clue", "确认成绩单被篡改的来源", {
          evidence: ["她要追踪那份被改动的成绩单线索。", "陈老师承认看到过原始记录。"],
        }),
        intentThread("intent-location", "前往档案室调查", {
          evidence: ["档案室可能存着原始审批材料。", "她决定前往档案室调查。"],
        }),
        intentThread("intent-resource", "获取原始合同副本", {
          evidence: ["前台说原始合同副本还在保险柜里。"],
        }),
        intentThread("intent-character", "确认目击者证词", {
          evidence: ["她要确认那个目击者的证词是否可靠。"],
        }),
      ],
    }, { currentChapter: 5 });

    // All four concrete narrative intents should stay valuable (kept, not flagged
    // for cleanup) using only generic structure + object, no genre words.
    expect(report.cleanupCandidateCounts.none).toBeGreaterThanOrEqual(4);
    expect(report.lifecycleSuggestionCounts.keep_open_or_touched
      + report.lifecycleSuggestionCounts.low_priority_keep).toBeGreaterThanOrEqual(4);
    expect(report.diagnostics.every((item) => item.intentValueClass !== "low_value_generic")).toBe(true);
  });

  it("keeps the engine heuristics source free of any prior-work genre term table", async () => {
    const files = [
      "commit-plan-builder.ts",
      "arc-goal-tracking.ts",
      "lead-intent-tracking.ts",
      "hook-tracking.ts",
      "intent-lifecycle-diagnostics.ts",
      // R5b 扩 pin：纳入数据驱动化后的引擎文件，防专名再溜回
      "commit-quality-check.ts",
      "state-overview.ts",
      "writing-context-pack.ts",
      "foundation-gap-assistant.ts",
      "foundation-write-gateway.ts",
    ];
    for (const file of files) {
      const source = await readFile(join(import.meta.dirname, "..", file), "utf-8");
      // 只查活代码：去掉纯注释行 + 块注释（注释里说明「R5b 删了 X 专名」是无害记录，pin 防的是活代码里的硬编码词表/正则）。
      const code = source
        .split("\n")
        .filter((line) => !line.trim().startsWith("//"))
        .join("\n")
        .replace(/\/\*[\s\S]*?\*\//gu, "");
      expect(code, `${file} must not hardcode prior-work genre terms in live code`).not.toMatch(LEGACY_GENRE_TERMS);
    }
  });
});

async function createXianxiaProject(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "story-engine-genre-neutral-xianxia-"));
  const { projectDir } = await createStoryProject({
    rootDir,
    title: "外院逆袭",
    genre: "修仙爽文",
    premise: "外院废柴查清组织账目，一路逆袭。",
    mainCharacterName: "林远",
  });
  return projectDir;
}

async function createUrbanProject(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "story-engine-genre-neutral-urban-"));
  const { projectDir } = await createStoryProject({
    rootDir,
    title: "审批迷局",
    genre: "都市悬疑",
    premise: "普通职员陶然追查公司内部的伪造审批。",
    mainCharacterName: "陶然",
  });
  return projectDir;
}

async function writeDraft(projectDir: string, chapter: number, content: string): Promise<void> {
  await mkdir(join(projectDir, "drafts", "fast"), { recursive: true });
  await writeFile(join(projectDir, "drafts", "fast", `chapter-${String(chapter).padStart(4, "0")}.md`), content, "utf-8");
}

function intentThread(
  id: string,
  title: string,
  overrides: Partial<NarrativeThread> = {},
): NarrativeThread {
  return {
    id,
    type: "intent",
    title,
    status: "open",
    firstSeenChapter: 1,
    lastTouchedChapter: 1,
    evidence: [],
    ...overrides,
  };
}
