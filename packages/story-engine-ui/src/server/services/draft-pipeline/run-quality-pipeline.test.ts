// @vitest-environment node
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../lib/snapshot-on-draft-overwrite.js", () => ({
  snapshotBeforeDraftOverwrite: vi.fn(async () => "snap-1"),
}));

import { readDraft } from "@actalk/story-core";
import { snapshotBeforeDraftOverwrite } from "../../lib/snapshot-on-draft-overwrite.js";
import { fixableInDraft, runDraftQualityPipeline } from "./run-quality-pipeline.js";

// 假查错模型说的是核账员那套话术（写笔记 / 三遍核账 / 自复核），经 checkCallModel 注入；
// 核账员本身的行为见 editorial/checker.test.ts 和 editorial/continuity/check-service.test.ts。

const versionOf = async (dir: string, chapter: number) => (await readDraft(dir, chapter))?.version ?? null;

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
      projectDir, chapter: 8, baseVersion: await versionOf(projectDir, 8), title: "第8章 · 菜场", draftBody: draft, lengthTarget: TARGET,
      continueCallModel, checkCallModel,
    });

    expect(result.changed).toBe(true);
    expect(result.snapshotId).toBe("snap-1");
    expect(result.info.continuation?.rounds).toBe(1);
    expect(result.info.continuity).toMatchObject({ checked: true, sure: [expect.objectContaining({ quote: "菜场还在，门口摆着几摊卖豆腐的，他推着车往后街走，找那个修鞋的吴师傅打听当年钟表厂宿舍的事。", earlierChapter: 7 })] });
    const written = await readFile(draftPath, "utf-8");
    expect(written).toContain("菜场还在"); // 不自动改，交作者定
    expect(written).toContain("修鞋的吴师傅");
    expect(result.notes.join("\n")).toContain("确定对不上 1 处");
    // 结果记进核账记忆：作者随后点「核账」、正文没改就直接出这次的结果。
    const memory = JSON.parse(await readFile(join(projectDir, ".story-engine-ui", "continuity-checks", "0008.json"), "utf-8")) as { issues: unknown[] };
    expect(memory.issues).toHaveLength(1);
  });

  // 2026-10-23：核出「确定」又错在新稿里的，按核账卡「改这处」同一句要求、同一条路改一轮（P12 起按编号句子），改完再核。
  it("按核账改：确定错在新稿里的按前文改、改完再核，留给作者的是改后还剩的；正文写盘", async () => {
    const draft = "林舟一早骑车出门，往南门去，路上想着祖父那张登记表上的字。\n\n菜场还在，门口摆着几摊卖豆腐的。";
    const { projectDir, draftPath } = await makeBook(draft);
    const checkCallModel = fakeChecker();
    const fixCallModel = vi.fn(async (prompt: string) => {
      expect(prompt).toContain("南门菜场十来年前就拆了"); // 改稿要求带着前文原句（和核账卡同一句）
      expect(prompt).toContain("1. [2]：");
      return JSON.stringify({ edits: [{ id: 2, to: "菜场早没了，门口摆着几摊卖豆腐的。" }] });
    });
    const result = await runDraftQualityPipeline({
      projectDir, chapter: 8, baseVersion: await versionOf(projectDir, 8), title: "第8章 · 菜场", draftBody: draft, lengthTarget: TARGET,
      checkCallModel, fixCallModel, skipOverwriteSnapshot: true,
    });
    expect(fixCallModel).toHaveBeenCalledTimes(1);
    expect(result.changed).toBe(true);
    expect(result.draftBody).toContain("菜场早没了，门口摆着几摊卖豆腐的。");
    expect(await readFile(draftPath, "utf-8")).toContain("菜场早没了");
    // 改完再核：「菜场还在」已不在正文里，核账员再报也核不过原句，核账卡上就没了。
    expect(result.info.continuity).toMatchObject({ checked: true, sure: [], autoFixed: { applied: 1, failed: 0 } });
    expect(result.notes.join("\n")).toContain("按前文改了 1 处");
    expect(result.notes.join("\n")).toContain("改完又核了一遍：没发现和前文对不上的地方");
    const memory = JSON.parse(await readFile(join(projectDir, ".story-engine-ui", "continuity-checks", "0008.json"), "utf-8")) as { issues: unknown[] };
    expect(memory.issues).toHaveLength(0);
  });

  it("改完再核，核账员又说改后那句不对（两遍说法相反）→ 降成「可能」交作者，不算「确定」；改句记下来", async () => {
    const draft = "林舟一早骑车出门，往南门去，路上想着祖父那张登记表上的字。\n\n菜场还在，门口摆着几摊卖豆腐的。";
    const { projectDir } = await makeBook(draft);
    const checkCallModel = vi.fn(async (messages: readonly { readonly role: string; readonly content: string }[], options: { readonly json?: boolean }) => {
      if (!options.json) return "笔记";
      const last = messages.at(-1)!.content;
      if (last.includes("你刚才核完报了")) {
        const ids = [...last.matchAll(/【(K\d+)】/gu)].map((match) => match[1]);
        return JSON.stringify({ verdicts: ids.map((id) => ({ id, verdict: "sure" })) });
      }
      if (!last.includes("这一遍只盯东西")) return JSON.stringify({ checks: [], contradictions: [] });
      const quote = last.includes("菜场早没了") ? "菜场早没了" : "菜场还在";
      return JSON.stringify({ checks: [], contradictions: [{ quote, earlierQuote: "南门菜场十来年前就拆了", earlierChapter: 7, reason: "两遍说法不一", confidence: "sure" }] });
    });
    const fixCallModel = vi.fn(async () => JSON.stringify({ edits: [{ id: 2, to: "菜场早没了，门口摆着几摊卖豆腐的。" }] }));
    const result = await runDraftQualityPipeline({
      projectDir, chapter: 8, baseVersion: await versionOf(projectDir, 8), title: "第8章 · 菜场", draftBody: draft, lengthTarget: TARGET,
      checkCallModel, fixCallModel, skipOverwriteSnapshot: true,
    });
    expect(result.info.continuity?.sure).toEqual([]);
    expect(result.info.continuity?.maybe).toEqual([expect.objectContaining({
      quote: "菜场早没了，门口摆着几摊卖豆腐的。",
      revisited: { from: "菜场还在，门口摆着几摊卖豆腐的。" },
    })]);
    const log = JSON.parse(await readFile(join(projectDir, ".story-engine-ui", "continuity-checks", "0008.fixes.json"), "utf-8")) as unknown;
    expect(log).toEqual([{ from: "菜场还在，门口摆着几摊卖豆腐的。", to: "菜场早没了，门口摆着几摊卖豆腐的。" }]);
  });

  it("接着写（P13）：核出的错在本来写好的那段里 → 不替作者改、只说有几处；错在接着写的那段照常改；标题不换", async () => {
    const prefix = "林舟一早骑车出门，往南门去，路上想着祖父那张登记表上的字。\n\n菜场还在，门口摆着几摊卖豆腐的。";
    const draft = `${prefix}\n\n他推着车往后街走，找那个修鞋的吴师傅打听当年钟表厂宿舍的事。`;
    const { projectDir } = await makeBook(draft);
    const fixCallModel = vi.fn(async () => JSON.stringify({ edits: [{ id: 2, to: "菜场早没了，门口摆着几摊卖豆腐的。" }] }));
    const result = await runDraftQualityPipeline({
      projectDir, chapter: 8, baseVersion: await versionOf(projectDir, 8), draftBody: draft, lengthTarget: TARGET,
      checkCallModel: fakeChecker(), fixCallModel, skipOverwriteSnapshot: true, keepPrefix: prefix,
    });
    expect(fixCallModel).not.toHaveBeenCalled();
    expect(result.draftBody).toContain("菜场还在，门口摆着几摊卖豆腐的。");
    // 按出处分开说，免得对话 AI 把本来就有的说成「接着写带进来的」。
    expect(result.notes.join("\n")).toContain("确定对不上 1 处（新写的那段没有，前面本来写好的那部分 1 处），这章不自动改");
    expect(result.info.continuity).toMatchObject({ sure: [expect.objectContaining({ quote: "菜场还在，门口摆着几摊卖豆腐的。" })] });

    // 同一句落在接着写的那段里：照常按前文改，写盘时标题沿用原来的。
    const tail = "林舟一早骑车出门，往南门去，路上想着祖父那张登记表上的字。";
    const second = await makeBook(`${tail}\n\n菜场还在，门口摆着几摊卖豆腐的。`);
    const fixed = await runDraftQualityPipeline({
      projectDir: second.projectDir, chapter: 8, baseVersion: await versionOf(second.projectDir, 8), draftBody: `${tail}\n\n菜场还在，门口摆着几摊卖豆腐的。`, lengthTarget: TARGET,
      checkCallModel: fakeChecker(), fixCallModel, skipOverwriteSnapshot: true, keepPrefix: tail,
    });
    expect(fixCallModel).toHaveBeenCalledTimes(1);
    expect(fixed.draftBody).toContain("菜场早没了");
    expect(await readFile(second.draftPath, "utf-8")).toMatch(/^# 第8章 · 菜场\n/u);
  });

  it("按核账改没改成（模型回的不能用）→ 正文不动、不再核，如实说那几处还在", async () => {
    const draft = "林舟一早骑车出门，往南门去，路上想着祖父那张登记表上的字。\n\n菜场还在，门口摆着几摊卖豆腐的。";
    const { projectDir, draftPath } = await makeBook(draft);
    const before = await readFile(draftPath, "utf-8");
    const checkCallModel = fakeChecker();
    const result = await runDraftQualityPipeline({
      projectDir, chapter: 8, baseVersion: await versionOf(projectDir, 8), title: "第8章 · 菜场", draftBody: draft, lengthTarget: TARGET,
      checkCallModel, fixCallModel: vi.fn(async () => "不是 JSON"),
    });
    expect(result.changed).toBe(false);
    expect(await readFile(draftPath, "utf-8")).toBe(before);
    expect(result.info.continuity).toMatchObject({ sure: [expect.objectContaining({ quote: "菜场还在，门口摆着几摊卖豆腐的。" })], autoFixed: { applied: 0, failed: 1 } });
    expect(result.notes.join("\n")).toContain("1 处没改成");
  });

  it("自动改的只认错在新稿里、对的是前文原文的；对的是设定卡（错的可能是卡）、错在前面那章的不自动改", () => {
    const base = { quote: "菜场还在", earlierQuote: "南门菜场十来年前就拆了", earlierChapter: 7, reason: "菜场早拆了" };
    expect(fixableInDraft(8, base)).toBe(true);
    expect(fixableInDraft(8, { ...base, earlierChapter: 8 })).toBe(true);
    expect(fixableInDraft(8, { ...base, fixChapter: 8 })).toBe(true);
    expect(fixableInDraft(8, { ...base, fixChapter: 5 })).toBe(false);
    expect(fixableInDraft(8, { ...base, againstSetting: { label: "地点" } })).toBe(false);
  });

  it("只比下限少一点 → 不续写，如实说短了多少（2026-10-10 真机试写：续出的段凭空编对话）", async () => {
    const draft = "林舟一早骑车出门，往南门去。他在后街口停下，找修鞋的吴师傅打听当年钟表厂宿舍的事，吴师傅想了很久才开口，说那片宿舍早拆了。";
    const { projectDir, draftPath } = await makeBook(draft);
    const continueCallModel = vi.fn(async () => "续写的一段。");
    const result = await runDraftQualityPipeline({
      projectDir, chapter: 8, baseVersion: await versionOf(projectDir, 8), title: "第8章", draftBody: draft, lengthTarget: { ...TARGET, lowerBound: 60 }, continueCallModel,
    });
    expect(continueCallModel).not.toHaveBeenCalled();
    expect(result.changed).toBe(false);
    // 短了多少由出稿回执按最终正文说一次（draft-service 的字数提示），这里不另说。
    expect(result.notes.join("\n")).not.toMatch(/下限|字数/u);
    // 作者写明了「至少 N 字」（定稿硬拦）→ 差一点也补到下限。
    const hard = await makeBook(draft);
    const continueHard = vi.fn(async () => "他推着车往后街走，修鞋摊还在，吴师傅抬头看了他一眼。");
    await runDraftQualityPipeline({
      projectDir: hard.projectDir, chapter: 8, baseVersion: await versionOf(hard.projectDir, 8), title: "第8章", draftBody: draft,
      lengthTarget: { ...TARGET, lowerBound: 60, hardMinimum: true }, continueCallModel: continueHard,
    });
    expect(continueHard).toHaveBeenCalled();
  });

  it("补写的那会儿作者存了稿 → 补写结果不写回、如实说，作者存的那份不动（外部审查 2026-10-28：补写落盘盖掉作者刚存的句子）", async () => {
    const draft = "林舟推开门。";
    const { projectDir, draftPath } = await makeBook(draft);
    const continueCallModel = vi.fn(async () => {
      await writeFile(draftPath, "# 第8章 · 菜场\n\n作者刚刚保存的新句子。\n", "utf-8");
      return "林舟推开门后沿着旧街慢慢走去，一路走到南门。".repeat(4);
    });
    const result = await runDraftQualityPipeline({
      projectDir, chapter: 8, baseVersion: await versionOf(projectDir, 8), title: "第8章 · 菜场", draftBody: draft, lengthTarget: TARGET, continueCallModel,
    });
    expect(continueCallModel).toHaveBeenCalled();
    expect(result.changed).toBe(false);
    expect(result.conflict).toBe(true);
    expect(result.notes.join("\n")).toContain("没写进去");
    expect(await readFile(draftPath, "utf-8")).toContain("作者刚刚保存的新句子。");
  });

  it("什么都没改 → 不建快照、不写盘；核账没跑成如实说", async () => {
    const draft = "林舟一早骑车出门，往南门去，路上想着祖父那张登记表上的字。\n\n菜场早没了，原址立着一排商场。";
    const { projectDir, draftPath } = await makeBook(draft);
    const before = await readFile(draftPath, "utf-8");
    const result = await runDraftQualityPipeline({
      projectDir, chapter: 8, baseVersion: await versionOf(projectDir, 8), title: "第8章 · 菜场", draftBody: draft, lengthTarget: TARGET,
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

  // R4.2（验收 3.2）：出稿流程内已有「写盘前」存档点，续写补字的重写不再另建——一次出稿=操作历史里的一步。
  it("skipOverwriteSnapshot → 补写重写不再建快照（撤销点由流程级存档点兜着），写盘照旧", async () => {
    const draft = "林舟一早骑车出门，往南门去。\n\n菜场还在，门口摆着几摊卖豆腐的。";
    const { projectDir, draftPath } = await makeBook(draft);
    vi.mocked(snapshotBeforeDraftOverwrite).mockClear(); // 本文件无全局 clearAllMocks，清掉前面用例的调用记录
    const continueCallModel = vi.fn(async () => "菜场还在，门口摆着几摊卖豆腐的，他推着车往后街走，找修鞋的吴师傅打听钟表厂宿舍的事。");
    const result = await runDraftQualityPipeline({
      projectDir, chapter: 8, baseVersion: await versionOf(projectDir, 8), title: "第8章", draftBody: draft, lengthTarget: TARGET,
      continueCallModel, skipOverwriteSnapshot: true,
    });
    expect(result.changed).toBe(true);
    expect(result.snapshotId).toBeUndefined();
    expect(snapshotBeforeDraftOverwrite).not.toHaveBeenCalled();
    expect(await readFile(draftPath, "utf-8")).toContain("修鞋的吴师傅");
  });

  // 修复轮（2026-10-13）：出稿内嵌核账走冷窗口（核账员还没读完全书）时，0 处也不许只说「没发现对不上」——
  // 对照范围必须跟上（和「核账」按钮路同一个口径），info.continuity 同时带上 coverage 供上层用。
  it("老书没读完就出稿：核账冷窗口 0 处 → 回执如实说只对照了第 5～12 章原文 + 账本，更早的细节可能漏", async () => {
    const draft = "林舟一早骑车出门，往南门去。路上想着祖父那张登记表上的字，想着钟表厂宿舍还没拆掉的年月，脚步慢了下来。";
    const { projectDir, draftPath } = await makeBook(draft);
    // 另一本 12 章的老书（和 check-service.test.ts 同款构造）：要补的笔记超过 10 章 → 冷窗口。
    for (let chapter = 1; chapter <= 12; chapter += 1) {
      await writeFile(join(projectDir, "chapters", `${String(chapter).padStart(4, "0")}.md`), `# 第${chapter}章\n\n第${chapter}章的内容，林舟照常开门。\n`, "utf-8");
    }
    const quiet = vi.fn(async (_messages: readonly { readonly role: string; readonly content: string }[], options: { readonly json?: boolean }) => {
      if (!options.json) return "笔记";
      return JSON.stringify({ checks: [], contradictions: [] });
    });
    const result = await runDraftQualityPipeline({
      projectDir, chapter: 13, baseVersion: await versionOf(projectDir, 13), title: "第13章", draftBody: draft, lengthTarget: TARGET,
      checkCallModel: quiet,
    });
    expect(result.changed).toBe(false);
    expect(result.info.continuity?.checked).toBe(true);
    expect(result.info.continuity?.coverage).toEqual({ mode: "cold", notedThrough: 0, rawFrom: 5, rawTo: 12 });
    const text = result.notes.join("\n");
    expect(text).toContain("没发现和前文对不上的地方");
    expect(text).toContain("核账员还没读完全书");
    expect(text).toContain("这次只对照了第 5～12 章原文 + 账本");
    expect(text).toContain("更早的细节可能漏");
    // 冷窗口结果不写核账记忆（小范围不能当全书核过来缓存）——出稿路和「核账」按钮路同规矩。
    await expect(readFile(join(projectDir, ".story-engine-ui", "continuity-checks", "0013.json"), "utf-8")).rejects.toThrow();
  });
});
