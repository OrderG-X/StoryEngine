// @vitest-environment node
//
// delta-present-names 单测（编辑部 R4.6）：从已定稿章的时间线语义摘要里读「本章出场角色名」。
// 全部假数据落临时目录，不调模型。
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readPresentNameChapterCounts, readRecentPresentCharacterNames } from "./delta-present-names.js";

describe("delta-present-names（编辑部 R4.6：已定稿声明的出场名）", () => {
  let projectDir: string | undefined;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), "delta-present-names-"));
    await mkdir(join(projectDir, "timeline"), { recursive: true });
  });

  afterEach(async () => {
    if (projectDir) {
      await rm(projectDir, { recursive: true, force: true });
      projectDir = undefined;
    }
  });

  async function seedTimeline(events: readonly unknown[]): Promise<void> {
    await writeFile(join(projectDir!, "timeline", "events.json"), `${JSON.stringify(events, null, 2)}\n`, "utf-8");
  }

  function event(chapter: number, names: readonly string[]): unknown {
    return {
      id: `ch${String(chapter).padStart(4, "0")}-001`,
      chapter,
      summary: `第${chapter}章事件`,
      participants: [],
      effects: { semanticSummary: { chapter, mainEvent: `第${chapter}章主事件`, presentCharacterNames: names } },
    };
  }

  it("最近章在前、章内保持声明顺序、跨章去重；只算 beforeChapter 之前的已定稿章", async () => {
    await seedTimeline([
      event(1, ["陆沉", "阿禾"]),
      event(2, ["阿禾", "陆沉", "周伯"]),
      event(3, ["陆沉"]),
      event(5, ["未来章的人"]), // chapter >= beforeChapter(4)：还没定稿，不该进来
    ]);

    await expect(readRecentPresentCharacterNames(projectDir!, 4)).resolves.toEqual(["陆沉", "阿禾", "周伯"]);
  });

  it("只取最近 3 章（缺省），更早章的独有名字不进来", async () => {
    await seedTimeline([
      event(1, ["只在第1章的人"]),
      event(2, ["甲"]),
      event(3, ["乙"]),
      event(4, ["丙"]),
    ]);

    await expect(readRecentPresentCharacterNames(projectDir!, 5)).resolves.toEqual(["丙", "乙", "甲"]);
  });

  it("占位名（建书模板固定标记）不进来；老事件没有 presentCharacterNames 字段当空、不猜", async () => {
    await seedTimeline([
      event(1, ["主角", "陆沉"]),
      { id: "ch0002-001", chapter: 2, summary: "老格式事件", participants: [] },
    ]);

    await expect(readRecentPresentCharacterNames(projectDir!, 3)).resolves.toEqual(["陆沉"]);
  });

  it("events.json 缺失/损坏 → 空名单（不抛、不猜）", async () => {
    await expect(readRecentPresentCharacterNames(projectDir!, 2)).resolves.toEqual([]);
    await writeFile(join(projectDir!, "timeline", "events.json"), "{not-json", "utf-8");
    await expect(readRecentPresentCharacterNames(projectDir!, 2)).resolves.toEqual([]);
  });

  it("readPresentNameChapterCounts：按出场章数排序（并列按最新章），供「出场最多」的改名建议用", async () => {
    await seedTimeline([
      event(1, ["陆沉", "阿禾"]),
      event(2, ["陆沉"]),
      event(3, ["阿禾", "陆沉"]),
    ]);

    const counts = await readPresentNameChapterCounts(projectDir!, 4);
    expect(counts.map((item) => [item.name, item.chapters])).toEqual([
      ["陆沉", 3],
      ["阿禾", 2],
    ]);
  });
});
