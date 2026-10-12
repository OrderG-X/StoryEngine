// @vitest-environment node
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../tools/snapshot-on-draft-overwrite.js", () => ({
  snapshotBeforeDraftOverwrite: vi.fn(async () => "snap-1"),
}));

import { runDraftQualityPipeline } from "./run-quality-pipeline.js";

// 假查错模型说的是核账员那套话术（写笔记 / 三遍核账 / 自复核），经 checkCallModel 注入；
// 核账员本身的行为见 brain/checker.test.ts 和 continuity-v2/check-service.test.ts。

const TARGET = { requested: 60, lowerBound: 40, upperBound: 70, source: "writing_rules" as const };

async function makeBook(draft: string): Promise<{ projectDir: string; draftPath: string }> {
  const projectDir = await mkdtemp(join(tmpdir(), "se-quality-pipeline-"));
  await mkdir(join(projectDir, "drafts", "fast"), { recursive: true });
  await mkdir(join(projectDir, "story"), { recursive: true });
  await mkdir(join(projectDir, "chapters"), { recursive: true });
  await writeFile(join(projectDir, "chapters", "0007.md"), "# 第7章\n\n他决定明天去南门菜场后街。南门菜场十来年前就拆了，原址盖了商场。\n", "utf-8");
  await writeFile(join(projectDir, "story", "fact-ledger.json"), JSON.stringify({
    version: "v0", facts: [{ id: "fact-4-0", chapter: 4, text: "南门菜场十来年前就拆了，原址盖了商场。", source: "auto" }],
  }), "utf-8");
  const draftPath = join(projectDir, "drafts", "fast", "chapter-0008.md");
  await writeFile(draftPath, `# 第8章 · 菜场\n\n${draft}\n`, "utf-8");
  return { projectDir, draftPath };
}

/** 假的核账员：写笔记回一句；三遍里「盯东西」那遍报「菜场还在」对不上第 7 章；自复核判确定。 */
function fakeChecker() {
  return vi.fn(async (messages: readonly { readonly role: string; readonly content: string }[], options: { readonly json?: boolean }) => {
    if (!options.json) return "笔记";
    const last = messages.at(-1)!.content;
    if (last.includes("你刚才核完报了")) {
      const ids = [...last.matchAll(/【(K\d+)】/gu)].map((match) => match[1]);
      return JSON.stringify({ verdicts: ids.map((id) => ({ id, verdict: "sure" })) });
    }
    if (last.includes("这一遍只盯东西")) {
      return JSON.stringify({ checks: [], contradictions: [{ quote: "菜场还在", earlierQuote: "南门菜场十来年前就拆了", earlierChapter: 7, reason: "菜场早拆了", confidence: "sure" }] });
    }
    return JSON.stringify({ checks: [], contradictions: [] });
  });
}

describe("runDraftQualityPipeline", () => {
  it("续写够字数 → 核账（和「核账」按钮同一套）报出问题但不自动改；先建快照再原子写盘续写的部分", async () => {
    const draft = "林舟一早骑车出门，往南门去。\n\n菜场还在，门口摆着几摊卖豆腐的。";
    const { projectDir, draftPath } = await makeBook(draft);
    // 续写从最后一段接着写（模型交回的是改写后的最后一段 + 新写的部分）。
    const continueCallModel = vi.fn(async () => "菜场还在，门口摆着几摊卖豆腐的，他推着车往后街走，找那个修鞋的吴师傅打听当年钟表厂宿舍的事。");
    const checkCallModel = fakeChecker();

    const result = await runDraftQualityPipeline({
      projectDir, chapter: 8, draftPath, title: "第8章 · 菜场", draftBody: draft, lengthTarget: TARGET,
      continueCallModel, checkCallModel,
    });

    expect(result.changed).toBe(true);
    expect(result.snapshotId).toBe("snap-1");
    expect(result.info.continuation?.rounds).toBe(1);
    expect(result.info.continuity).toMatchObject({ checked: true, sure: [expect.objectContaining({ quote: "菜场还在", earlierChapter: 7 })] });
    const written = await readFile(draftPath, "utf-8");
    expect(written).toContain("菜场还在"); // 不自动改，交作者定
    expect(written).toContain("修鞋的吴师傅");
    expect(result.notes.join("\n")).toContain("确定对不上 1 处");
    // 结果记进核账记忆：作者随后点「核账」、正文没改就直接出这次的结果。
    const memory = JSON.parse(await readFile(join(projectDir, ".story-engine-ui", "continuity-checks", "0008.json"), "utf-8")) as { issues: unknown[] };
    expect(memory.issues).toHaveLength(1);
  });

  it("只比下限少一点 → 不续写，如实说短了多少（2026-10-10 真机试写：续出的段凭空编对话）", async () => {
    const draft = "林舟一早骑车出门，往南门去。他在后街口停下，找修鞋的吴师傅打听当年钟表厂宿舍的事，吴师傅想了很久才开口，说那片宿舍早拆了。";
    const { projectDir, draftPath } = await makeBook(draft);
    const continueCallModel = vi.fn(async () => "续写的一段。");
    const result = await runDraftQualityPipeline({
      projectDir, chapter: 8, draftPath, title: "第8章", draftBody: draft, lengthTarget: { ...TARGET, lowerBound: 60 }, continueCallModel,
    });
    expect(continueCallModel).not.toHaveBeenCalled();
    expect(result.changed).toBe(false);
    expect(result.notes.join("\n")).toContain("只差一点就没自动续写");
    // 作者写明了「至少 N 字」（定稿硬拦）→ 差一点也补到下限。
    const hard = await makeBook(draft);
    const continueHard = vi.fn(async () => "他推着车往后街走，修鞋摊还在，吴师傅抬头看了他一眼。");
    await runDraftQualityPipeline({
      projectDir: hard.projectDir, chapter: 8, draftPath: hard.draftPath, title: "第8章", draftBody: draft,
      lengthTarget: { ...TARGET, lowerBound: 60, hardMinimum: true }, continueCallModel: continueHard,
    });
    expect(continueHard).toHaveBeenCalled();
  });

  it("什么都没改 → 不建快照、不写盘；核账没跑成如实说", async () => {
    const draft = "林舟一早骑车出门，往南门去，路上想着祖父那张登记表上的字。\n\n菜场早没了，原址立着一排商场。";
    const { projectDir, draftPath } = await makeBook(draft);
    const before = await readFile(draftPath, "utf-8");
    const result = await runDraftQualityPipeline({
      projectDir, chapter: 8, draftPath, title: "第8章 · 菜场", draftBody: draft, lengthTarget: TARGET,
      continueCallModel: vi.fn(), checkCallModel: vi.fn(async (_messages: unknown, options: { readonly json?: boolean }) => {
        if (!options.json) return "笔记";
        throw new Error("idle timeout");
      }),
    });
    expect(result.changed).toBe(false);
    expect(result.snapshotId).toBeUndefined();
    expect(await readFile(draftPath, "utf-8")).toBe(before);
    expect(result.notes.join("\n")).toContain("没跑成");
  });
});
