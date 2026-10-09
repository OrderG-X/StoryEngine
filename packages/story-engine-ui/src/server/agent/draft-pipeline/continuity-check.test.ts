// @vitest-environment node
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildSegmentForRecheck,
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

  it("审读自己都说「不算矛盾」的条目丢掉（第十二轮误报里的一大类）", () => {
    const out = parseContinuityIssues(JSON.stringify({
      issues: [
        { type: "contradiction", quote: "菜场还在，门口摆着几摊卖豆腐的。", conflict: "与第4章菜场已拆一致吗？细看不算矛盾", fix: "无需修改" },
        { type: "contradiction", quote: "菜场还在，门口摆着几摊卖豆腐的。", conflict: "可能是另一处菜场，暂不列为矛盾", fix: "保持" },
        { type: "repeat", quote: "四月十七对上了", conflict: "与第3章核对相近，此条不报", fix: "—" },
        { type: "contradiction", quote: "菜场还在，门口摆着几摊卖豆腐的。", conflict: "第4章：菜场十来年前就拆了", fix: "改成商场" },
      ],
    }), DRAFT);
    expect(out.issues).toHaveLength(1);
    expect(out.issues[0].conflict).toBe("第4章：菜场十来年前就拆了");
  });

  it("不是 JSON → 抛（由调用方收成「没核成」）", () => {
    expect(() => parseContinuityIssues("审读完毕，没有问题", DRAFT)).toThrow();
  });
});

describe("repairContinuityIssues", () => {
  // 2026-10-08 第六轮验收：整段重写的自动修补改出 13 处新矛盾、删掉后文还在引用的台词——改为只换出问题的那一句。
  it("只换出问题的那一句，其余一字不动；改得太短的不用", async () => {
    const issues = [
      { type: "contradiction" as const, quote: "菜场还在", conflict: "第4章：菜场已拆", fix: "改成商场" },
      { type: "repeat" as const, quote: "四月十七对上了", conflict: "第3章已核对过", fix: "改成新进展" },
    ];
    const callModel = vi.fn(async () => JSON.stringify({
      fixes: [
        { id: "S1", text: "菜场早没了，原址立着一排商场，玻璃门擦得锃亮。" },
        { id: "S2", text: "短" },
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
    const repair = vi.fn(async () => JSON.stringify({ fixes: [{ id: "S1", text: "菜场早没了，原址立着一排商场，玻璃门擦得锃亮。" }] }));
    const result = await checkAndRepairContinuity({ chapter: 8, draftBody: DRAFT, references: REFS, checkCallModel: check, repairCallModel: repair });
    expect(result.changed).toBe(true);
    expect(result.remaining).toEqual([]);
    expect(describeContinuityOutcome(result)).toBe("前后核对：对照了 1 条旧设定和前文，发现 1 处问题，已改好 1 处，复核已无冲突。");
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
    const repair = vi.fn(async () => JSON.stringify({ fixes: [{ id: "S1", text: "菜场早没了，原址立着一排商场，玻璃门擦得锃亮。" }] }));
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

describe("复核只看改过的段 + 最多两轮", () => {
  it("buildSegmentForRecheck：改过的段连同前后各一段", () => {
    const body = ["一", "二", "三", "四", "五"].join("\n\n");
    expect(buildSegmentForRecheck(body, [2])).toBe("二\n\n三\n\n四");
    expect(buildSegmentForRecheck(body, [0, 4])).toBe("一\n\n二\n\n四\n\n五");
  });

  it("第一轮没改干净 → 第二轮再改；复核喂的是片段不是整章", async () => {
    const check = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({ issues: [{ type: "contradiction", quote: "菜场还在", conflict: "第4章：菜场已拆", fix: "改成商场" }] }))
      .mockResolvedValueOnce(JSON.stringify({ issues: [{ type: "contradiction", quote: "菜场的豆腐摊", conflict: "第4章：菜场已拆", fix: "去掉豆腐摊" }] }))
      .mockResolvedValueOnce(JSON.stringify({ issues: [] }));
    const repair = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({ fixes: [{ id: "S1", text: "菜场早拆了，可原址门口还剩菜场的豆腐摊，摆着几块豆腐。" }] }))
      .mockResolvedValueOnce(JSON.stringify({ fixes: [{ id: "S1", text: "菜场早拆了，原址立着一排商场，玻璃门擦得锃亮。" }] }));
    const result = await checkAndRepairContinuity({ chapter: 8, draftBody: DRAFT, references: REFS, checkCallModel: check, repairCallModel: repair });
    expect(repair).toHaveBeenCalledTimes(2);
    expect(result.repairedParagraphs).toBe(2);
    expect(result.remaining).toEqual([]);
    expect(result.draftBody).toContain("原址立着一排商场");
    // 复核调用里的「本章正文」只是改过的段与前后段，不含与改动无关的段落之外的内容。
    const recheckUser = String((check.mock.calls[1][0] as { content: string }[])[1].content);
    expect(recheckUser).toContain("菜场早拆了");
  });

  it("两轮都没改干净 → 剩下的留给作者，不无限循环", async () => {
    // 引文要逐字命中（≥4 字）：原文与两次改稿里都有「门口摆着几摊卖豆腐的」。
    const stubborn = JSON.stringify({ issues: [{ type: "contradiction", quote: "门口摆着几摊卖豆腐的", conflict: "第4章：菜场已拆", fix: "改" }] });
    const check = vi.fn(async () => stubborn);
    const repair = vi.fn(async () => JSON.stringify({ fixes: [{ id: "S1", text: "菜场还是在那里，门口摆着几摊卖豆腐的。" }] }));
    const result = await checkAndRepairContinuity({ chapter: 8, draftBody: DRAFT, references: REFS, checkCallModel: check, repairCallModel: repair });
    // 第二轮改出来和原句一样 → 不算改动、不再复核，剩下的留给作者。
    expect(repair).toHaveBeenCalledTimes(2);
    expect(check).toHaveBeenCalledTimes(2);
    expect(result.remaining).toHaveLength(1);
  });
});

describe("sentenceContaining", () => {
  it("取引文所在的整句（带后引号）", async () => {
    const { sentenceContaining } = await import("./continuity-check.js");
    expect(sentenceContaining("他说：“菜场还在呢。”她没接话。", "菜场还在")).toBe("他说：“菜场还在呢。”");
    expect(sentenceContaining(DRAFT, "四月十七对上了")).toBe("他又看了一遍登记表，四月十七对上了。");
  });
});

describe("只核对、不自动改（第八轮验收：自动改了 32 句，18 句改出新毛病）", () => {
  it("不给改写调用 → 问题原样留给作者，正文不动，说明里请作者定", async () => {
    const check = vi.fn(async () => JSON.stringify({ issues: [{ type: "contradiction", quote: "菜场还在", conflict: "第4章：菜场已拆", fix: "改成商场" }] }));
    const result = await checkAndRepairContinuity({ chapter: 8, draftBody: DRAFT, references: REFS, checkCallModel: check });
    expect(result.changed).toBe(false);
    expect(result.draftBody).toBe(DRAFT);
    expect(result.remaining).toHaveLength(1);
    expect(check).toHaveBeenCalledTimes(1);
    expect(describeContinuityOutcome(result)).toContain("没有自动改（你定）：「菜场还在」与第4章：菜场已拆");
  });
});

