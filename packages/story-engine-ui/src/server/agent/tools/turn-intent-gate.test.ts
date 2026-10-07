import { describe, expect, it } from "vitest";

import {
  userTurnAllowsDraftWrite,
  userTurnAllowsEstablishedOverride,
  userTurnAllowsResolveThread,
  userTurnAllowsThreadCleanup,
} from "./turn-intent-gate.js";

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

  // P1-3：否定词表补裸「不」与「不着急/不急着」——对齐 commit 门，此前漏收致出稿被白耗
  it.each([
    "不着急写下一章",
    "我不着急写下一章",
    "不急着写第8章",
    "下一章先不写",
    "这一章不用写",
  ])("P1-3 推迟/否定写作句应拦：%s", (text) => {
    expect(userTurnAllowsDraftWrite(text)).toBe(false);
  });

  // P1-4：尾句否决——正向决定子句之后的纯推迟/否定尾句行使否决权（对齐 commit 门）
  it.each([
    "写第8章，先别写",
    "写下一章，等等再说",
    "继续写，慢着",
    "写第8章，不着急",
    "写下一章，不急着写",
    "写第8章，算了",
  ])("P1-4 尾句否决应拦：%s", (text) => {
    expect(userTurnAllowsDraftWrite(text)).toBe(false);
  });

  it("P1-4 范围限定尾句不得被误拦（否定作用于范围宾语，不是叫停本轮）", () => {
    expect(userTurnAllowsDraftWrite("写第7章正文，不要写后面的章节")).toBe(true);
    expect(userTurnAllowsDraftWrite("写这章，其他章别写")).toBe(true);
  });

  // 审计返工 B7：draft 尾句否决词表逐槽对齐已拆除的旧定稿门尾句否决表——
  // 补「算了」前缀、咱们/你主语、现在/目前/暂时副词、再说/反悔了?词根。
  it.each([
    "写第8章，我反悔了",
    "写第8章，再说",
    "写第8章，你先等等",
    "写第8章，暂时别写",
    "写第8章，咱们等等",
    "写第8章，目前先等等",
    "写第8章，暂时等等",
    "写第8章，我现在反悔了",
    "写第8章，不过你反悔了",
    "写第8章，算了再说",
  ])("B7 词表对齐后应拦的尾句否决：%s", (text) => {
    expect(userTurnAllowsDraftWrite(text)).toBe(false);
  });

  // B7 合法面（防误拦回归）：「你」只是主语前缀、不配词根不否决；
  // 「现在/目前」副词后不配否决词根不否决。
  it.each([
    "写第8章，你看看行不行",
    "写下一章，现在就写",
    "写第8章，目前设定不变",
    "写第8章，你说呢",
    "写第8章，咱们现在开始写",
  ])("B7 合法面不误拦：%s", (text) => {
    expect(userTurnAllowsDraftWrite(text)).toBe(true);
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
