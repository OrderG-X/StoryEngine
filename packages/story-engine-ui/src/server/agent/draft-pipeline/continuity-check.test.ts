// @vitest-environment node
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  checkAndRepairContinuity,
  collectContinuityReferences,
  describeContinuityOutcome,
  parseContinuityIssues,
  repairContinuityIssues,
  type ContinuityReferences,
} from "./continuity-check.js";

const DRAFT = [
  "林舟一早骑车出门，往南门去。",
  "菜场还在，门口摆着几摊卖豆腐的。",
  "他又看了一遍登记表，四月十七对上了。",
].join("\n\n");

const REFS: ContinuityReferences = {
  facts: ["第4章：南门菜场十来年前就拆了，原址盖了商场。"],
  passages: [],
};

describe("parseContinuityIssues", () => {
  it("引文逐字在正文里才采信；坏条目丢弃并计数", () => {
    const out = parseContinuityIssues(JSON.stringify({
      issues: [
        { type: "contradiction", quote: "菜场还在，门口摆着几摊卖豆腐的。", conflict: "第4章：菜场十来年前就拆了", fix: "改成原址的商场" },
        { type: "contradiction", quote: "正文里根本没有这句", conflict: "x", fix: "y" },
        { type: "style", quote: "林舟一早骑车出门", conflict: "文风", fix: "改" },
        { type: "missing_beat", conflict: "没写到吴师傅", fix: "补一场" },
      ],
    }), DRAFT);
    expect(out.issues.map((issue) => issue.type)).toEqual(["contradiction", "missing_beat"]);
    expect(out.droppedUnverified).toBe(1);
  });

  it("不是 JSON → 抛（由调用方收成「没核成」）", () => {
    expect(() => parseContinuityIssues("审读完毕，没有问题", DRAFT)).toThrow();
  });
});

describe("repairContinuityIssues", () => {
  it("只换冲突段，其余一字不动；改得太短的段不用", async () => {
    const issues = [
      { type: "contradiction" as const, quote: "菜场还在", conflict: "第4章：菜场已拆", fix: "改成商场" },
      { type: "repeat" as const, quote: "四月十七对上了", conflict: "第3章已核对过", fix: "改成新进展" },
    ];
    const callModel = vi.fn(async () => JSON.stringify({
      paragraphs: [
        { index: 1, text: "菜场早没了，原址立着一排商场，玻璃门擦得锃亮。" },
        { index: 2, text: "短" },
      ],
    }));
    const result = await repairContinuityIssues({ draftBody: DRAFT, issues, references: REFS, callModel });
    expect(result.repairedParagraphs).toBe(1);
    expect(result.draftBody).toBe([
      "林舟一早骑车出门，往南门去。",
      "菜场早没了，原址立着一排商场，玻璃门擦得锃亮。",
      "他又看了一遍登记表，四月十七对上了。",
    ].join("\n\n"));
  });
});

describe("checkAndRepairContinuity", () => {
  it("核出冲突 → 修一轮 → 复核干净", async () => {
    const check = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({ issues: [{ type: "contradiction", quote: "菜场还在", conflict: "第4章：菜场已拆", fix: "改成商场" }] }))
      .mockResolvedValueOnce(JSON.stringify({ issues: [] }));
    const repair = vi.fn(async () => JSON.stringify({ paragraphs: [{ index: 1, text: "菜场早没了，原址立着一排商场，玻璃门擦得锃亮。" }] }));
    const result = await checkAndRepairContinuity({ chapter: 8, draftBody: DRAFT, references: REFS, checkCallModel: check, repairCallModel: repair });
    expect(result.changed).toBe(true);
    expect(result.remaining).toEqual([]);
    expect(describeContinuityOutcome(result)).toBe("前后核对：对照了 1 条旧设定和前文，发现 1 处问题，已改好 1 段，复核已无冲突。");
  });

  it("没有冲突 → 不修不改", async () => {
    const repair = vi.fn();
    const result = await checkAndRepairContinuity({
      chapter: 8, draftBody: DRAFT, references: REFS, checkCallModel: vi.fn(async () => "{\"issues\":[]}"), repairCallModel: repair,
    });
    expect(repair).not.toHaveBeenCalled();
    expect(result.changed).toBe(false);
    expect(describeContinuityOutcome(result)).toContain("没发现冲突");
  });

  it("审读挂了 → 原稿不动，如实说没核过（绝不说已一致）", async () => {
    const result = await checkAndRepairContinuity({
      chapter: 8, draftBody: DRAFT, references: REFS, checkCallModel: vi.fn(async () => { throw new Error("idle timeout"); }), repairCallModel: vi.fn(),
    });
    expect(result.changed).toBe(false);
    expect(describeContinuityOutcome(result)).toContain("没跑成");
  });

  it("复核没跑成 → 第一次发现的问题原样留给作者", async () => {
    const check = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({ issues: [{ type: "contradiction", quote: "菜场还在", conflict: "第4章：菜场已拆", fix: "改" }] }))
      .mockRejectedValueOnce(new Error("idle timeout"));
    const repair = vi.fn(async () => JSON.stringify({ paragraphs: [{ index: 1, text: "菜场早没了，原址立着一排商场，玻璃门擦得锃亮。" }] }));
    const result = await checkAndRepairContinuity({ chapter: 8, draftBody: DRAFT, references: REFS, checkCallModel: check, repairCallModel: repair });
    expect(result.changed).toBe(true);
    expect(result.remaining).toHaveLength(1);
    expect(describeContinuityOutcome(result)).toContain("需要你定");
  });
});

describe("collectContinuityReferences", () => {
  it("按本章正文写到的东西挑旧事实（正文写到菜场 → 翻出菜场已拆）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "se-continuity-refs-"));
    await mkdir(join(dir, "story"), { recursive: true });
    await writeFile(join(dir, "story", "fact-ledger.json"), JSON.stringify({
      version: "v0",
      facts: [
        { id: "fact-4-0", chapter: 4, text: "南门菜场十来年前就拆了，原址盖了商场。", source: "auto" },
        ...Array.from({ length: 30 }, (_, i) => ({ id: `fact-5-${i}`, chapter: 5, text: `周婶第${i}回来串门说拆迁`, source: "auto" })),
      ],
    }), "utf-8");
    const refs = await collectContinuityReferences({ projectDir: dir, chapter: 8, draftBody: DRAFT, previousChapterText: "上一章结尾。" });
    expect(refs.facts[0]).toContain("南门菜场十来年前就拆了");
    expect(refs.previousChapterTail).toBe("上一章结尾。");
  });
});
