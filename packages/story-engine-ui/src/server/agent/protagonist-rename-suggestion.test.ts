// @vitest-environment node
//
// 编辑部 R4.6 建议项（R5.1 起改判据）：第 1 章定稿后主角卡还是开书占位、已定稿章节声明的视角人物
// 里取最多的真名 → 下一步选项给「把主角卡改成『X』」。只是建议：作者点了才发 intent 给模型去改名，
// 这里绝不写盘。不再数出场次数（视角是林小满、宋伯名字出现再多也是建议林小满）。
// 全部假数据落临时目录 + mock executeTool，不调模型。
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RequestContext } from "@mastra/core/di";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildProtagonistRenameSuggestion } from "./protagonist-rename-suggestion.js";
import { runUserAction, type UserActionToolExecutor } from "./user-actions.js";

describe("buildProtagonistRenameSuggestion（编辑部 R4.6 建议项；R5.1 起按视角人物取人）", () => {
  let projectDir: string | undefined;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), "rename-suggestion-"));
    await mkdir(join(projectDir, "story"), { recursive: true });
    await mkdir(join(projectDir, "timeline"), { recursive: true });
  });

  afterEach(async () => {
    if (projectDir) {
      await rm(projectDir, { recursive: true, force: true });
      projectDir = undefined;
    }
  });

  async function seedBook(protagonistName: string): Promise<void> {
    await writeFile(join(projectDir!, "story", "character-bible.json"), `${JSON.stringify({
      version: "v0",
      characters: [{ id: "zhu-jue", name: protagonistName, role: "主角", desire: "进入开篇情境", speechRules: [], behaviorBoundaries: [] }],
    }, null, 2)}\n`, "utf-8");
  }

  async function seedTimeline(events: readonly unknown[]): Promise<void> {
    await writeFile(join(projectDir!, "timeline", "events.json"), `${JSON.stringify(events, null, 2)}\n`, "utf-8");
  }

  function event(chapter: number, names: readonly string[], viewpoint?: string): unknown {
    return {
      id: `ch${String(chapter).padStart(4, "0")}-001`,
      chapter,
      summary: `第${chapter}章事件`,
      participants: [],
      effects: {
        semanticSummary: {
          chapter,
          mainEvent: `第${chapter}章主事件`,
          presentCharacterNames: names,
          ...(viewpoint ? { viewpointCharacter: viewpoint } : {}),
        },
      },
    };
  }

  it("验收场景：视角人物是林小满、宋伯名字出现更多（出场章数更多）→ 建议改成林小满，不数出场", async () => {
    await seedBook("主角");
    await seedTimeline([
      event(1, ["林小满", "宋伯"], "林小满"),
      event(2, ["宋伯", "宋伯他弟"]), // 宋伯出场更多，但这章没有视角声明
      event(3, ["宋伯"], "林小满"),
    ]);

    const suggestion = await buildProtagonistRenameSuggestion(projectDir!, 3);

    expect(suggestion).toBeDefined();
    expect(suggestion!.label).toBe("把主角卡改成『林小满』");
    expect(suggestion!.intent).toContain("林小满");
    expect(suggestion!.intent).toContain("视角人物");
    expect(suggestion!.intent).not.toContain("出场最多");
    expect(suggestion!.intent).not.toMatch(/zhu-jue/u);
  });

  it("有视角声明的真名 → 建议（label/intent 都说人话，不出现裸 id）", async () => {
    await seedBook("主角");
    await seedTimeline([
      event(1, ["陆沉", "阿禾"], "陆沉"),
      event(2, ["陆沉", "阿禾"], "陆沉"),
    ]);

    const suggestion = await buildProtagonistRenameSuggestion(projectDir!, 2);

    expect(suggestion).toBeDefined();
    expect(suggestion!.label).toBe("把主角卡改成『陆沉』");
    expect(suggestion!.intent).toContain("陆沉");
    expect(suggestion!.intent).toContain("视角人物");
  });

  it("主角卡已有真名 → 不建议（已经不用改）", async () => {
    await seedBook("陆沉");
    await seedTimeline([event(1, ["陆沉"], "陆沉")]);

    await expect(buildProtagonistRenameSuggestion(projectDir!, 1)).resolves.toBeUndefined();
  });

  it("占位卡 + 一章都没有视角声明 → 不建议（没有依据不猜名字，不退回数出场次数）", async () => {
    await seedBook("主角");
    // 老数据：有出场名、没有 viewpointCharacter——旧判据会给「宋伯」（3 章都出场），新判据不给建议。
    await seedTimeline([
      event(1, ["林小满", "宋伯"]),
      event(2, ["宋伯"]),
      event(3, ["宋伯"]),
    ]);

    await expect(buildProtagonistRenameSuggestion(projectDir!, 3)).resolves.toBeUndefined();
  });

  it("占位卡 + 没有任何已定稿声明 → 不建议", async () => {
    await seedBook("主角");
    await seedTimeline([]);

    await expect(buildProtagonistRenameSuggestion(projectDir!, 1)).resolves.toBeUndefined();
  });

  it("只统计已定稿章（beforeChapter 之前），没定稿的章的视角不算", async () => {
    await seedBook("主角");
    await seedTimeline([event(2, ["只在第2章的人"], "只在第2章的人")]);

    await expect(buildProtagonistRenameSuggestion(projectDir!, 1)).resolves.toBeUndefined();
  });
});

describe("runUserAction 定稿收尾追加改名建议（编辑部 R4.6，只加不改原选项）", () => {
  const passthroughScrubber = () => ({ push: (t: string) => t, flush: () => "" });

  function collect() {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    return { events, sendEvent: (event: string, data: unknown) => events.push({ event, data: data as Record<string, unknown> }) };
  }

  let projectDir: string | undefined;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), "rename-suggestion-action-"));
    await mkdir(join(projectDir, "story"), { recursive: true });
    await mkdir(join(projectDir, "timeline"), { recursive: true });
    await writeFile(join(projectDir, "story", "character-bible.json"), `${JSON.stringify({
      version: "v0",
      characters: [{ id: "zhu-jue", name: "主角", role: "主角", desire: "进入开篇情境", speechRules: [], behaviorBoundaries: [] }],
    }, null, 2)}\n`, "utf-8");
    await writeFile(join(projectDir, "timeline", "events.json"), `${JSON.stringify([
      {
        id: "ch0001-001",
        chapter: 1,
        summary: "陆沉登场。",
        participants: [],
        effects: { semanticSummary: { chapter: 1, mainEvent: "陆沉登场。", presentCharacterNames: ["陆沉"], viewpointCharacter: "陆沉" } },
      },
    ], null, 2)}\n`, "utf-8");
  });

  afterEach(async () => {
    if (projectDir) {
      await rm(projectDir, { recursive: true, force: true });
      projectDir = undefined;
    }
  });

  it("定稿成功 + 占位主角卡 + 视角最多的真名 → 原选项照旧、末尾多一个「把主角卡改成『陆沉』」", async () => {
    const executeTool: UserActionToolExecutor = async () => ({ ok: true, committed: true, chapter: 1, summary: "第 1 章已定稿。" });
    const { events, sendEvent } = collect();

    await runUserAction({
      action: { toolName: "commit_apply", chapter: 1 },
      requestContext: new RequestContext(),
      executeTool,
      sendEvent,
      scrubber: passthroughScrubber(),
      scrubError: String,
      projectDir,
    });

    const next = events.at(-1)!.data.output as { choices: { label: string; intent: string }[] };
    expect(next.choices.map((choice) => choice.label)).toEqual(["写第 2 章", "把主角卡改成『陆沉』"]);
    expect(next.choices[1]!.intent).toContain("视角人物");
  });

  it("没给 projectDir（其他调用方）→ 行为与原来完全一致，不多选项", async () => {
    const executeTool: UserActionToolExecutor = async () => ({ ok: true, committed: true, chapter: 1, summary: "第 1 章已定稿。" });
    const { events, sendEvent } = collect();

    await runUserAction({
      action: { toolName: "commit_apply", chapter: 1 },
      requestContext: new RequestContext(),
      executeTool,
      sendEvent,
      scrubber: passthroughScrubber(),
      scrubError: String,
    });

    const next = events.at(-1)!.data.output as { choices: { label: string }[] };
    expect(next.choices.map((choice) => choice.label)).toEqual(["写第 2 章"]);
  });

  it("定稿没成（committed:false）→ 不给改名建议（没定稿就没有新依据）", async () => {
    const executeTool: UserActionToolExecutor = async () => ({ ok: false, committed: false, summary: "还没预览，不能定稿。" });
    const { events, sendEvent } = collect();

    await runUserAction({
      action: { toolName: "commit_apply", chapter: 1 },
      requestContext: new RequestContext(),
      executeTool,
      sendEvent,
      scrubber: passthroughScrubber(),
      scrubError: String,
      projectDir,
    });

    const next = events.at(-1)!.data.output as { choices: { label: string }[] };
    expect(next.choices.map((choice) => choice.label)).toEqual(["重新预览"]);
  });
});
