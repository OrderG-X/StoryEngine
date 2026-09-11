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

  it("否定后末句改主意（无「正式」级措辞）同样放行：后说话算数", () => {
    expect(userTurnAllowsCommitApply("先别入库，算了还是确认入库")).toBe(true);
  });

  it.each([
    // 复审 P1 实测误放行：否定嵌在确认锚与动词之间，嵌套后顾够不着
    "确认不定稿",
    "不能确认定稿",
    "无法确认入库",
  ])("拦截确认锚与动词之间的否定：%s", (text) => {
    expect(userTurnAllowsCommitApply(text)).toBe(false);
  });

  it("「不确认了直接定稿」放行：「不确认」被「了」闭合成独立否定单元，末句「直接定稿」是肯定（复审 P1 实测误拦）", () => {
    expect(userTurnAllowsCommitApply("不确认了直接定稿")).toBe(true);
  });

  it.each([
    "先别入库，不过还是别确认入库",
    "先别入库，不过还是别确认定稿",
    "不确认入库",
    "没确认定稿",
    "未确认提交本章",
  ])("拦截否定确认与反转通道的二次否定：%s", (text) => {
    expect(userTurnAllowsCommitApply(text)).toBe(false);
  });

  it("「特别确认」不误伤（别确认≠否定，特别确认=确认）", () => {
    expect(userTurnAllowsCommitApply("预览没问题，特别确认定稿")).toBe(true);
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
    "确定裁掉旧快照",
    "把快照历史裁到最近100条，确认裁剪",
    "裁剪快照历史，确认",
    "直接裁剪快照历史",
    // 短确认整句（agent 预览后问过，用户回一个短确认）
    "确认",
    "确定",
    "裁吧",
    "好的，行",
    // 否定带域锚：被否定的是线索清理，不拦快照裁剪确认（复审实锤：此前误拦）
    "确认裁剪快照历史，别清理线索",
    "先别清理线索，确认裁剪快照历史",
    // 把字句宾语前置（复审实锤：此前误拦）
    "确认把快照清理掉",
    "确定把操作历史裁掉",
    "确认把存档点清掉",
    // 「特别确认」是加强语气的真确认——虽含「别确认」子串，但「别」前面是「特」，不是二次否定（agent-61 裁决项：此前误拦）
    "特别确认裁掉快照历史",
    // 裸「裁」域锚定 + 确认级收尾（复审实锤：注释自称放行但动词表没有裸「裁」，实际误拦）
    "把快照历史裁到100条，确认",
    "把操作历史裁到50条，确定",
    // 现状口径钉住：尾随疑问语气仍放行（一审建议拦截疑问句，未采纳，防日后漂移）
    "确认裁剪吗",
    "确认裁剪吗？",
    // 现状口径钉住：泛短确认「可以/行/没问题」放行（一审建议收紧，未采纳，防日后漂移）
    "可以",
    "行",
    "没问题",
    "好的，可以",
  ])("允许明确确认裁剪意图：%s", (text) => {
    expect(userTurnAllowsSnapshotPrune(text)).toBe(true);
  });

  it.each([
    "继续写第56章正文",
    // 首次请求只有裁剪意图、没有确认级措辞 → 只够走 dry-run 预览，不够真裁
    "裁剪一下快照历史",
    "把快照历史裁到最近100条",
    "操作历史太长了，帮我裁一下",
    // 「吧」级商量语气同样只是首次请求，不够确认级（复审实锤：此前放行）
    "裁剪快照历史吧",
    "清理一下操作历史吧",
    "裁掉那些存档点吧",
    // 跨域不放行：确认的是线索/写作规则清理，与快照无关（复审实锤：此前放行）
    "确认清理线索",
    "直接清理写作规则",
    "确认一下要清理的线索",
    // 故事内容里的「历史/存档」不是快照域（复审实锤：此前放行）
    "清掉那段黑历史吧",
    "裁剪这段历史剧情吧",
    // 否定
    "先别裁剪快照历史",
    "不要清理快照",
    "确认裁剪，先别裁了",
    // 否定前缀「不确认/没确认」是拒绝不是确认（复审实锤：此前误放行）
    "不确认裁剪",
    "不确认裁剪快照历史",
    "没确认裁剪",
    "没确认裁剪快照历史",
    // 裁系动词拖着非域宾语不算快照真裁确认（复审实锤：此前误放行）
    "确认裁掉这段剧情",
    "直接裁掉这段黑历史",
    "确定裁掉那些支线剧情",
    // 把字句跨域同样不放行
    "确认把这段剧情裁掉",
  ])("拦截没有确认意图或否定裁剪：%s", (text) => {
    expect(userTurnAllowsSnapshotPrune(text)).toBe(false);
  });

  it.each([
    "先别裁剪，算了还是确认裁剪快照历史",
    // 反转通道放宽：裸「裁吧」作为否定后的改主意也算确认级（复审实锤：此前误拦）
    "先别裁剪，算了还是裁吧",
    "先别裁剪，确认",
    // 「不确认」之后真改主意仍放行（①的否定前缀不误伤真反转）
    "不确认裁剪，算了还是裁吧",
    "我不确认，但还是确认裁剪快照历史吧",
  ])("否定后有正向反转则允许：%s", (text) => {
    expect(userTurnAllowsSnapshotPrune(text)).toBe(true);
  });

  it.each([
    // 二次否定里的「裁吧/确认裁掉」只是子串巧合，不是改主意（复审实锤：反转通道误放行）
    "先别裁剪，不过还是别裁吧",
    "先别裁剪，不过还是不裁吧",
    "先别裁剪，不过还是别裁剪吧",
    "先别裁剪，不过还是不确认裁掉",
    // 「别确认」同样是二次否定（agent-61 裁决项：反转确认锚后顾只挡 不/没/未，漏了「别」）
    "先别裁剪，不过还是别确认裁掉快照",
  ])("否定后的伪反转仍拦截：%s", (text) => {
    expect(userTurnAllowsSnapshotPrune(text)).toBe(false);
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
