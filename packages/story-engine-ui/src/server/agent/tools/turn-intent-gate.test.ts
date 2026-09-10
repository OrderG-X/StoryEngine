import { describe, expect, it } from "vitest";

import {
  userTurnAllowsCommitApply,
  userTurnAllowsDraftWrite,
  userTurnAllowsEstablishedOverride,
  userTurnAllowsResolveThread,
  userTurnAllowsSnapshotPrune,
  userTurnAllowsThreadCleanup,
} from "./turn-intent-gate.js";

describe("turn-intent-gate commit_apply", () => {
  it.each([
    "确认定稿",
    "定稿吧",
    "定稿并更新资料",
    "确认正式入库",
    "执行入库",
    "直接入库",
    "直接正式入库",
    "提交本章",
    "把这章正式入库",
    "把第59章草稿走完预览并正式入库",
    "预览通过就直接入库",
    "预览没问题后再正式入库",
  ])("允许明确定稿/入库意图：%s", (text) => {
    expect(userTurnAllowsCommitApply(text)).toBe(true);
  });

  it.each([
    "继续写第59章正文。只写这一章，不要写其他章。",
    "先别入库，改完再说",
    "不要正式入库，只生成预览",
    "暂不提交，我先看看",
  ])("拦截没有正式入库意图或否定入库：%s", (text) => {
    expect(userTurnAllowsCommitApply(text)).toBe(false);
  });

  it("否定后有正向反转则允许", () => {
    expect(userTurnAllowsCommitApply("先别入库，算了还是确认正式入库")).toBe(true);
  });

  it("缺失 userTurnText 默认放行，兼容老调用点", () => {
    expect(userTurnAllowsCommitApply(undefined)).toBe(true);
    expect(userTurnAllowsCommitApply("   ")).toBe(true);
  });
});

// 治「入库后模型自主续写下一章」：那一轮用户原话只有定稿/审稿等意图、没有任何写作意图，
// 模型却擅自 generate_draft。门从宽设计（只拦明显无写作意图的轮），常见写作说法必须全放行。
describe("turn-intent-gate draft write（generate_draft 写作意图门）", () => {
  it.each([
    "写第8章",
    "写第 12 章正文",
    "写这一章",
    "写本章开头",
    "继续写第59章正文。只写这一章，不要写其他章。",
    "继续",
    "好，继续",
    "继续写",
    "接着写下一章",
    "往下写",
    "下一章",
    "写吧",
    "开始写",
    "动笔吧",
    "重写这一章",
    "再写一版",
    "扩写这一段",
    "定稿并接着写下一章",
    // 评审加固 补的真实说法：中文数字章号 / 宾语前置 / 继续+章号 / 创作
    "请把第八章写出来",
    "第8章写完",
    "继续第八章",
    "接着第 9 章",
    "创作第 8 章",
    "把这段写出来",
  ])("允许明确写作/续写意图：%s", (text) => {
    expect(userTurnAllowsDraftWrite(text)).toBe(true);
  });

  it.each([
    "确认定稿",
    "定稿吧",
    "确认正式入库",
    "做一次硬伤检查",
    "审一下这一章",
    "查一下AI味",
    "帮我完善主角的角色卡",
    "清理旧线索",
    "把世界观做厚一点",
    "先别写，改完再说",
    "这一章先别写",
    "别写下一章",
    // 评审加固 反例：正向词在否定子句里，不得反向放行
    "确认定稿，下一章不要写",
    "定稿吧，下一章先别动",
    "确认入库。下一章不用写了",
  ])("拦截没有写作意图或否定写作：%s", (text) => {
    expect(userTurnAllowsDraftWrite(text)).toBe(false);
  });

  it("否定后有正向反转则允许（反转子句是纯正向）", () => {
    expect(userTurnAllowsDraftWrite("先别写，算了还是写第8章吧")).toBe(true);
  });

  it("否定只作用于所在子句 = 限定范围而非拒写 → 允许", () => {
    expect(userTurnAllowsDraftWrite("写第7章正文，不要写后面的章节")).toBe(true);
  });

  it("缺失 userTurnText 默认放行，兼容前端按钮直调等不带原话的调用", () => {
    expect(userTurnAllowsDraftWrite(undefined)).toBe(true);
    expect(userTurnAllowsDraftWrite("   ")).toBe(true);
  });
});

describe("turn-intent-gate thread cleanup", () => {
  it.each([
    "清理旧线索",
    "把重复线索归并一下",
    "整理一下线索，重复的合并",
    "线索太乱了，帮我收拢",
    "线索重复，合并一下",
  ])("允许明确线索清理意图：%s", (text) => {
    expect(userTurnAllowsThreadCleanup(text)).toBe(true);
  });

  it.each([
    "继续写第60章正文",
    "不要清理线索，先往下写",
    "先别归并线索，我自己看",
    "无需整理线索",
  ])("拦截没有清理意图或否定清理：%s", (text) => {
    expect(userTurnAllowsThreadCleanup(text)).toBe(false);
  });

  it("否定后有正向反转则允许", () => {
    expect(userTurnAllowsThreadCleanup("先别清理线索，算了还是把重复线索归并一下")).toBe(true);
  });

  it("缺失 userTurnText 默认放行，兼容老调用点", () => {
    expect(userTurnAllowsThreadCleanup(undefined)).toBe(true);
    expect(userTurnAllowsThreadCleanup("   ")).toBe(true);
  });
});

describe("turn-intent-gate resolve_thread", () => {
  it.each([
    "把安保盘问那条线索收掉",
    "这条线索已经完结了，标记完成",
    "应对安保人员的盘问这条已经完了",
    "把『赶在A071换班前』那条收口",
  ])("允许明确单条线索收口意图：%s", (text) => {
    expect(userTurnAllowsResolveThread(text)).toBe(true);
  });

  it.each([
    "继续写第11章正文",
    "看到待收口提醒，先别收掉",
    "不要标记完成，继续写",
    "线索还没完结",
  ])("拦截没有收口意图或否定收口：%s", (text) => {
    expect(userTurnAllowsResolveThread(text)).toBe(false);
  });
});

describe("turn-intent-gate snapshot prune（prune_snapshots 真裁确认门）", () => {
  it.each([
    "确认裁剪",
    "确认裁剪快照历史",
    "确定清理快照历史",
    "把快照历史裁到最近100条，确认裁剪",
    "裁剪快照历史吧",
    "清理一下操作历史吧",
    "直接裁剪快照历史",
    // 短确认整句（agent 预览后问过，用户回一个短确认）
    "确认",
    "确定",
    "裁吧",
    "好的，行",
  ])("允许明确确认裁剪意图：%s", (text) => {
    expect(userTurnAllowsSnapshotPrune(text)).toBe(true);
  });

  it.each([
    "继续写第56章正文",
    // 首次请求只有裁剪意图、没有确认级措辞 → 只够走 dry-run 预览，不够真裁
    "裁剪一下快照历史",
    "把快照历史裁到最近100条",
    "操作历史太长了，帮我裁一下",
    // 否定
    "先别裁剪快照历史",
    "不要清理快照",
    "确认裁剪，先别裁了",
  ])("拦截没有确认意图或否定裁剪：%s", (text) => {
    expect(userTurnAllowsSnapshotPrune(text)).toBe(false);
  });

  it("否定后有正向反转则允许", () => {
    expect(userTurnAllowsSnapshotPrune("先别裁剪，算了还是确认裁剪快照历史")).toBe(true);
  });

  it("缺失 userTurnText 默认放行，兼容前端按钮/旧会话等不带原话的调用", () => {
    expect(userTurnAllowsSnapshotPrune(undefined)).toBe(true);
    expect(userTurnAllowsSnapshotPrune("   ")).toBe(true);
  });
});

describe("turn-intent-gate established override（已确立设定覆盖同意）", () => {
  it.each([
    "允许覆盖",
    "确认覆盖",
    "可以覆盖",
    "覆盖吧",
    "确定",
    "同意",
    "好的，确定",
    "我同意覆盖",
  ])("明确同意覆盖：%s", (text) => {
    expect(userTurnAllowsEstablishedOverride(text)).toBe(true);
  });

  it.each([
    "把主角李默的年龄改成32岁",
    "把年龄改为33",
    "不确定",
    "不同意",
    "算了不改",
    "先别改",
    "继续写下一章",
  ])("仅改写请求或否定/放弃 → 不放行：%s", (text) => {
    expect(userTurnAllowsEstablishedOverride(text)).toBe(false);
  });

  it("缺失 userTurnText → 不放行（fail-closed，与入库意图门缺省放行不同）", () => {
    expect(userTurnAllowsEstablishedOverride(undefined)).toBe(false);
    expect(userTurnAllowsEstablishedOverride("   ")).toBe(false);
  });
});
