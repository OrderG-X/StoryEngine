// @vitest-environment node
// 额度算式（写作版本 P2a 4.5）：都从专员导出的常数乘出来，常数改了额度跟着变。真实调用数核算式的用例跟着配方走（inspect.run 那片）。
import { describe, expect, it } from "vitest";
import { DEFAULT_READER_VARIANT, READER_CALL_MAX_SENDS, readerCheckCalls, readerRecheckCalls } from "../../editorial/checker.js";
import { HEDGE_MAX_COPIES } from "../../editorial/continuity/check-chapter.js";
import { READER_MAX_CATCH_UP, READER_MAX_VOLUME_BUILDS } from "../../editorial/continuity/check-service.js";
import { MODEL_CALL_MAX_SENDS } from "../../lib/llm-client.js";
import { volumeBuildsBound } from "../../editorial/reader-window.js";
import { backfillBudget, backfillStepSends, inspectStepBudget, inspectTasks, READER_CHECK_SENDS, READER_NOTES_SENDS, sumBudget } from "./budgets.js";

describe("额度算式", () => {
  it("核账员一次调用：对冲份数 × 每份（主 + 备用）", () => {
    expect(MODEL_CALL_MAX_SENDS).toBe(2);
    expect(HEDGE_MAX_COPIES).toBe(2);
    expect(READER_CALL_MAX_SENDS).toBe(HEDGE_MAX_COPIES * MODEL_CALL_MAX_SENDS);
  });

  it("整章核：翻原文 + 对设定 + 三遍 × 每遍次数 + 自复核；只核改过的：翻原文 + 并行次数 + 自复核", () => {
    // 三遍（三个侧重）：默认每遍 4 次。
    expect(readerCheckCalls(DEFAULT_READER_VARIANT)).toBe(1 + 1 + 3 * DEFAULT_READER_VARIANT.passRepeats! + 1);
    expect(readerRecheckCalls(DEFAULT_READER_VARIANT)).toBe(1 + DEFAULT_READER_VARIANT.recheckRepeats! + 1);
    expect(readerCheckCalls({})).toBe(2 + 3);
    expect(readerRecheckCalls({ passRepeats: 3 })).toBe(1 + 3);
  });

  it("inspect.run 各模式每一步的上限", () => {
    expect(inspectStepBudget("continuity")).toEqual({
      notes: (READER_MAX_CATCH_UP + READER_MAX_VOLUME_BUILDS) * READER_CALL_MAX_SENDS,
      check: Math.max(readerCheckCalls(DEFAULT_READER_VARIANT), readerRecheckCalls(DEFAULT_READER_VARIANT)) * READER_CALL_MAX_SENDS,
    });
    expect(READER_NOTES_SENDS).toBe(48);
    expect(READER_CHECK_SENDS).toBe(60);
    expect(sumBudget(inspectStepBudget("continuity"))).toBe(108);
    expect(inspectStepBudget("review")).toEqual({ run: MODEL_CALL_MAX_SENDS });
    expect(inspectStepBudget("flavor")).toEqual({ run: MODEL_CALL_MAX_SENDS });
    expect(inspectStepBudget("quality")).toEqual({});
    expect(sumBudget(inspectStepBudget("quality"))).toBe(0);
  });

  it("兼容改参按用到的任务去重算：核账 qualityCheck、审稿 / 查 AI 味 draftReview、质检不调模型", () => {
    expect(inspectTasks("continuity")).toEqual(["qualityCheck"]);
    expect(inspectTasks("review")).toEqual(["draftReview"]);
    expect(inspectTasks("flavor")).toEqual(["draftReview"]);
    expect(inspectTasks("quality")).toEqual([]);
  });

  it("后台补读：冻结的章数 + 这段里最多新生成的卷节点，各乘核账员一次调用的上限", () => {
    expect(backfillBudget([{ from: 1, to: 5 }])).toBe(5 * READER_CALL_MAX_SENDS); // 十章以内用不到卷笔记
    expect(backfillBudget([])).toBe(0);
    // 第 200 章：叶子 20 个 + 十块数 19、20 各自最多合并 18、19 次。
    expect(backfillBudget([{ from: 200, to: 200 }])).toBe((1 + 20 + 18 + 19) * READER_CALL_MAX_SENDS);
    expect(backfillStepSends(200)).toBe(backfillBudget([{ from: 200, to: 200 }]));
    // 两个角色各算各的。
    expect(backfillBudget([{ from: 1, to: 3 }, { from: 1, to: 3 }])).toBe(6 * READER_CALL_MAX_SENDS);
  });

  it("卷节点上界：B 个十块 = B 个叶子 + 每个不同的 B 最多 B-1 次合并", () => {
    expect(volumeBuildsBound(0, 9)).toBe(0);
    expect(volumeBuildsBound(9, 10)).toBe(1);
    expect(volumeBuildsBound(10, 19)).toBe(1);
    expect(volumeBuildsBound(19, 20)).toBe(2 + 1);
    expect(volumeBuildsBound(0, 30)).toBe(3 + 1 + 2);
    expect(volumeBuildsBound(25, 25)).toBe(2 + 1);
  });
});
