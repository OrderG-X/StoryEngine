// @vitest-environment node
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../tools/snapshot-on-draft-overwrite.js", () => ({
  snapshotBeforeDraftOverwrite: vi.fn(async () => "snap-1"),
}));

import { runDraftQualityPipeline } from "./run-quality-pipeline.js";

const TARGET = { requested: 60, lowerBound: 40, upperBound: 70, source: "writing_rules" as const };

async function makeBook(draft: string): Promise<{ projectDir: string; draftPath: string }> {
  const projectDir = await mkdtemp(join(tmpdir(), "se-quality-pipeline-"));
  await mkdir(join(projectDir, "drafts", "fast"), { recursive: true });
  await mkdir(join(projectDir, "story"), { recursive: true });
  await mkdir(join(projectDir, "chapters"), { recursive: true });
  await writeFile(join(projectDir, "chapters", "0007.md"), "# 第7章\n\n他决定明天去南门菜场后街。\n", "utf-8");
  await writeFile(join(projectDir, "story", "fact-ledger.json"), JSON.stringify({
    version: "v0", facts: [{ id: "fact-4-0", chapter: 4, text: "南门菜场十来年前就拆了，原址盖了商场。", source: "auto" }],
  }), "utf-8");
  const draftPath = join(projectDir, "drafts", "fast", "chapter-0008.md");
  await writeFile(draftPath, `# 第8章 · 菜场\n\n${draft}\n`, "utf-8");
  return { projectDir, draftPath };
}

describe("runDraftQualityPipeline", () => {
  it("续写够字数 → 核对出冲突 → 改掉 → 复核干净；先建快照再原子写盘", async () => {
    const draft = "林舟一早骑车出门，往南门去。\n\n菜场还在，门口摆着几摊卖豆腐的。";
    const { projectDir, draftPath } = await makeBook(draft);
    const continueCallModel = vi.fn(async () => "菜场还在，门口摆着几摊卖豆腐的，他推着车往后街走，找那个修鞋的吴师傅打听当年钟表厂宿舍的事。");
    const checkCallModel = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({ issues: [{ type: "contradiction", quote: "菜场还在", evidence: "南门菜场十来年前就拆了", conflict: "第4章：菜场十来年前就拆了", fix: "改成原址商场" }] }))
      .mockResolvedValueOnce(JSON.stringify({ issues: [] }));
    const repairCallModel = vi.fn(async () => JSON.stringify({
      fixes: [{ id: "S1", text: "菜场早没了，原址立着一排商场，他推着车往后街走，找那个修鞋的吴师傅打听当年钟表厂宿舍的事。" }],
    }));

    const result = await runDraftQualityPipeline({
      projectDir, chapter: 8, draftPath, title: "第8章 · 菜场", draftBody: draft, lengthTarget: TARGET,
      continueCallModel, checkCallModel, repairCallModel,
    });

    expect(result.changed).toBe(true);
    expect(result.snapshotId).toBe("snap-1");
    expect(result.info.continuation?.rounds).toBe(1);
    expect(result.info.continuity).toMatchObject({ checked: true, found: 1, repairedParagraphs: 1, remaining: [] });
    // 核对时把「菜场已拆」这条旧事实翻出来给了审读模型（正文写到了菜场）。
    expect(JSON.stringify(checkCallModel.mock.calls[0][0])).toContain("南门菜场十来年前就拆了");
    const written = await readFile(draftPath, "utf-8");
    expect(written.startsWith("# 第8章 · 菜场\n\n林舟一早骑车出门")).toBe(true);
    expect(written).toContain("菜场早没了");
    expect(written).not.toContain("菜场还在");
    expect(result.notes.join("\n")).toContain("已接着写到");
    expect(result.notes.join("\n")).toContain("复核已无冲突");
  });

  it("什么都没改 → 不建快照、不写盘", async () => {
    const draft = "林舟一早骑车出门，往南门去，路上想着祖父那张登记表上的字。\n\n菜场早没了，原址立着一排商场。";
    const { projectDir, draftPath } = await makeBook(draft);
    const before = await readFile(draftPath, "utf-8");
    const result = await runDraftQualityPipeline({
      projectDir, chapter: 8, draftPath, title: "第8章 · 菜场", draftBody: draft, lengthTarget: TARGET,
      continueCallModel: vi.fn(), checkCallModel: vi.fn(async () => "{\"issues\":[]}"), repairCallModel: vi.fn(),
    });
    expect(result.changed).toBe(false);
    expect(result.snapshotId).toBeUndefined();
    expect(await readFile(draftPath, "utf-8")).toBe(before);
  });
});
