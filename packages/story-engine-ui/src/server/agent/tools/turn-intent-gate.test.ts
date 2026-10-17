import { describe, expect, it } from "vitest";

import {
  userTurnAllowsDraftWrite,
  userTurnAllowsEstablishedOverride,
} from "./turn-intent-gate.js";

// 治「入库后模型自主续写下一章」：那一轮用户原话只有定稿/审稿等意图、没有任何写作意图，
// 模型却擅自 generate_draft。门从宽设计（只拦明显无写作意图的轮），常见写作说法必须全放行。
// R7.1（十章试写报告 3.1）：否定词否决整体拆除——作者打字的回合命中正向表即放行（角色台词里的
// 否定说法不再误拦），门只剩「原话一点写作说法都没有 → 拦」这一个职责。
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
    // 界面按钮/建议条发出的固定文案（正向表命中，不回归）
    "写这一章的正文", // 「写这一章」按钮回显（DRAFT_BUTTON_INTENT）
    "帮我写这一章的工作稿。", // 建议条 generate-draft
    "帮我写这一章的工作稿，方向是：老周上门对质。", // 建议条 generate-draft-direct（带方向）
    "继续写下一章。", // 建议条 continue-next
    "继续写第 4 章的正文", // 定稿后「写第 N 章」选项回显（userActionChoiceText）
  ])("允许明确写作/续写意图：%s", (text) => {
    expect(userTurnAllowsDraftWrite(text)).toBe(true);
  });

  // R7.1 核心回归：任务单点名的两句台词——否定词在角色台词里，不是作者叫停
  it.each([
    "写第 9 章：第二天爷爷用铁丝缠死了摆锤，说：『钟停在这儿，谁也别想再动它。』",
    "写下一章，里面老周说『先别写信给他』",
  ])("R7.1 台词里的否定说法不再否决（正向表命中即放行）：%s", (text) => {
    expect(userTurnAllowsDraftWrite(text)).toBe(true);
  });

  // R7.1 改口径：这几句旧用例靠否定词否决才拦的，现在按「正向表命中即放行」放行——
  // 代价是作者真叫停时模型若仍去调 generate_draft 门不再兜（任务单 R7.1 明确取舍）。
  it.each([
    "别写下一章",
    "确认定稿，下一章不要写",
    "定稿吧，下一章先别动",
    "确认入库。下一章不用写了",
    "不着急写下一章", // P1-3
    "写第8章，先别写", // P1-4
    "写第8章，算了", // B7
    "先别写，算了还是写第8章吧", // 旧「否定后反转」用例：正向表命中，放行口径不变
    "写第7章正文，不要写后面的章节", // 旧「范围限定」用例：同上
  ])("R7.1 含写作说法的否定句按新口径放行（否决逻辑已拆）：%s", (text) => {
    expect(userTurnAllowsDraftWrite(text)).toBe(true);
  });

  it.each([
    "确认定稿",
    "定稿吧",
    "确认正式入库",
    "预览定稿",
    "核账",
    "核账：拿这一章对一遍前文，看有没有前后对不上的地方",
    "做一次硬伤检查",
    "审一下这一章",
    "查一下AI味",
    "帮我完善主角的角色卡",
    "清理旧线索",
    "把世界观做厚一点",
    // 界面按钮/建议条发出的非写作文案（原话一点写作说法都没有，照拦——防定稿后自主续写不退化）
    "帮我预览这一章的定稿改动。",
    "帮我检查这一章的连续性和逻辑风险。",
    "帮我审一下这一章的稿子，给修改建议。",
    "按我的方向给这一章改一版，先出预览。",
    "帮我读一下当前状态，整理这一章的承接建议。",
    "撤销上一步",
    // 「写」不领章词/宾语：词序上没有写作说法 → 照拦（不是否定否决，是正向表没命中）
    "这一章先不写",
    "这一章不用写", // 旧 P1-3 用例：新口径下依旧拦（没有写作说法）
    "先别写，改完再说",
  ])("拦截没有写作说法的回合：%s", (text) => {
    expect(userTurnAllowsDraftWrite(text)).toBe(false);
  });

  it("缺失 userTurnText 默认放行，兼容前端按钮直调等不带原话的调用", () => {
    expect(userTurnAllowsDraftWrite(undefined)).toBe(true);
    expect(userTurnAllowsDraftWrite("   ")).toBe(true);
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
