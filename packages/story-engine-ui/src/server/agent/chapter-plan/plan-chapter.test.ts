// @vitest-environment node
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStoryProject, readChapterPlan } from "@actalk/story-engine";
import { describe, expect, it, vi } from "vitest";
import { buildPlanMessages, collectPlanMaterials, planChapter, resolveChapterPlanForDraft } from "./plan-chapter.js";

async function makeBook(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "se-plan-chapter-"));
  const { projectDir } = await createStoryProject({
    rootDir, title: "海州账册", genre: "urban", premise: "审计员林澈追查账册篡改。", mainCharacterName: "林澈",
  });
  await mkdir(join(projectDir, "chapters"), { recursive: true });
  await writeFile(join(projectDir, "chapters", "0001.md"), "# 第1章 · 账册\n\n林澈把蓝色账册锁进抽屉，决定明天去档案室。\n", "utf-8");
  await writeFile(join(projectDir, "story", "threads.json"), JSON.stringify({
    threads: [
      { id: "lead-1", type: "lead", title: "账册第三页被谁撕掉了…", status: "open", firstSeenChapter: 1, lastTouchedChapter: 1, evidence: ["账册第三页被谁撕掉了，撕口很新"] },
      { id: "lead-2", type: "lead", title: "已经收口的旧事", status: "done", firstSeenChapter: 1, lastTouchedChapter: 1, evidence: [] },
    ],
  }), "utf-8");
  return projectDir;
}

const GOOD_PLAN = JSON.stringify({
  summary: "林澈去档案室对出缺页",
  beats: ["一早去档案室", "管理员拦人", "对出缺页是一笔境外汇款"],
  newInformation: ["缺页记的是一笔境外汇款"],
  scene: { location: "档案室", time: "第二天上午" },
  characters: ["林澈"],
  entities: ["蓝色账册", "档案室"],
  threadsAdvanced: [{ title: "账册第三页被谁撕掉了", how: "对出缺页内容" }],
  avoid: ["不要再写锁抽屉"],
});

describe("拟章纲材料与提示词", () => {
  it("带上一章原文、开着的线索（截断标题补证据）、不带已收口的", async () => {
    const projectDir = await makeBook();
    const materials = await collectPlanMaterials(projectDir, 2);
    expect(materials.previousChapter?.text).toContain("决定明天去档案室");
    expect(materials.openThreads).toEqual(["账册第三页被谁撕掉了…（账册第三页被谁撕掉了，撕口很新）（上次第 1 章）"]);
    const [system, user] = buildPlanMessages(2, materials, "让他去档案室");
    expect(system.content).toContain("至少给出一条读者此前不知道的新信息");
    expect(user.content).toContain("【作者这章的方向】让他去档案室");
    expect(user.content).toContain("决定明天去档案室");
    expect(user.content).not.toContain("已经收口的旧事");
  });
});

describe("planChapter", () => {
  it("拟成即落盘", async () => {
    const projectDir = await makeBook();
    const result = await planChapter({ projectDir, chapter: 2, callModel: vi.fn(async () => GOOD_PLAN) });
    expect(result.ok).toBe(true);
    expect((await readChapterPlan(projectDir, 2))?.summary).toBe("林澈去档案室对出缺页");
  });

  it("第一次坏 JSON、重试成功", async () => {
    const projectDir = await makeBook();
    const callModel = vi.fn().mockResolvedValueOnce("不是JSON").mockResolvedValueOnce(GOOD_PLAN);
    const result = await planChapter({ projectDir, chapter: 2, callModel });
    expect(callModel).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
  });

  it("两次都不成 → ok:false + 原因，不抛、不落盘", async () => {
    const projectDir = await makeBook();
    const callModel = vi.fn(async () => JSON.stringify({ characters: ["林澈"] }));
    const result = await planChapter({ projectDir, chapter: 2, callModel });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("章纲没拟成（已自动重试一次）") });
    expect(await readChapterPlan(projectDir, 2)).toBeUndefined();
  });
});

describe("resolveChapterPlanForDraft", () => {
  it("同一方向重写沿用已有章纲；方向变了重拟", async () => {
    const projectDir = await makeBook();
    const callModel = vi.fn(async () => GOOD_PLAN);
    const first = await resolveChapterPlanForDraft({ projectDir, chapter: 2, callModel });
    expect(first.reused).toBe(false);
    const again = await resolveChapterPlanForDraft({ projectDir, chapter: 2, callModel });
    expect(again.reused).toBe(true);
    expect(callModel).toHaveBeenCalledTimes(1);
    const redirected = await resolveChapterPlanForDraft({ projectDir, chapter: 2, direction: "改成去银行", callModel });
    expect(redirected.reused).toBe(false);
    expect(callModel).toHaveBeenCalledTimes(2);
    expect((await readChapterPlan(projectDir, 2))?.direction).toBe("改成去银行");
  });

  it("拟不成 → 没有章纲 + 如实说明照常出稿", async () => {
    const projectDir = await makeBook();
    const resolved = await resolveChapterPlanForDraft({ projectDir, chapter: 2, callModel: vi.fn(async () => { throw new Error("socket hang up"); }) });
    expect(resolved.plan).toBeUndefined();
    expect(resolved.note).toContain("这次按没有章纲出稿");
  });
});
