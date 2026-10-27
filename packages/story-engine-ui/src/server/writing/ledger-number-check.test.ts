// @vitest-environment node
import { describe, expect, it } from "vitest";
import { findLedgerNumberConflicts, parseNumberToken } from "./ledger-number-check.js";
import type { FactEntry } from "../book/types.js";

const fact = (id: string, chapter: number, quote: string, extra: Partial<FactEntry> = {}): FactEntry => ({
  id, chapter, text: quote, source: "auto", quote, kind: "hard", ...extra,
});

describe("parseNumberToken", () => {
  it("认中文、逐位写法和阿拉伯数字", () => {
    expect(parseNumberToken("一九八七")).toBe(1987);
    expect(parseNumberToken("二十八")).toBe(28);
    expect(parseNumberToken("十一")).toBe(11);
    expect(parseNumberToken("三百零五")).toBe(305);
    expect(parseNumberToken("两万三千")).toBe(23000);
    expect(parseNumberToken("1985")).toBe(1985);
    expect(parseNumberToken("１２")).toBe(12);
    expect(parseNumberToken("几")).toBeUndefined();
  });
});

describe("账本数字对账（确定性层）", () => {
  // 《半页书店》小考题：第 2 章扉页「林秋 一九八七年春」，第 4 章写成一九八五。
  const ledger = [
    fact("fact-2-6", 2, "扉页的右下角用蓝黑墨水写着两行字，字迹清秀，笔画有点往右斜：\n\n林秋\n一九八七年春", { subject: "《城南旧事》" }),
    fact("fact-2-5", 2, "她凑近了才认出来：城南旧事。人民文学出版社，一九八二年版。", { subject: "《城南旧事》" }),
    fact("fact-3-1", 3, "她以前就住我们这巷子，五号，隔我家一个门。", { subject: "林秋", value: "槐树巷五号" }),
    fact("fact-3-0", 3, "老陈家在七号，院门是两扇刷了绿漆的木门。", { subject: "老陈", value: "槐树巷七号" }),
    fact("fact-1-1", 1, "苏晚今年二十八岁，接手书店三年。", { subject: "苏晚" }),
  ];

  it("扉页年份写错 → 报，两边原句都给", () => {
    const conflicts = findLedgerNumberConflicts({
      chapter: 4,
      draftBody: "他翻开扉页，看着那两行蓝黑墨水的字——林秋，一九八五年春——看了很久。",
      facts: ledger,
    });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ earlierChapter: 2, factId: "fact-2-6" });
    expect(conflicts[0]!.reason).toContain("一九八七");
    expect(conflicts[0]!.reason).toContain("一九八五");
  });

  it("写对了、只是换了写法（1987 / 一九八七）→ 不报", () => {
    expect(findLedgerNumberConflicts({ chapter: 4, draftBody: "扉页上写着：林秋，1987年春。", facts: ledger })).toEqual([]);
  });

  it("点了名的门牌写错 → 报那个人的；没点名、两家门牌都对得上 → 不知道说谁，不报", () => {
    const named = findLedgerNumberConflicts({ chapter: 5, draftBody: "林秋以前住在槐树巷九号。", facts: ledger });
    expect(named).toHaveLength(1);
    expect(named[0]!.factId).toBe("fact-3-1");
    expect(findLedgerNumberConflicts({ chapter: 5, draftBody: "他说你们以前住槐树巷九号，就隔他家一个门。", facts: ledger })).toEqual([]);
  });

  it("两段起止年份（某年至某年）说的是两件事 → 不拿「年至」当模板互相比（真机试写误报）", () => {
    const facts = [fact("c1-9", 1, "她又往后翻，一共找到五个圈。", { subject: "登记簿", value: "五条画圈的记录，1991年至2019年" })];
    expect(findLedgerNumberConflicts({ chapter: 5, draftBody: "外公一九九二年至二〇〇三年寄信七封，均退回。", facts })).toEqual([]);
  });

  it("这个数正好是另一条事实的（老陈家七号）→ 不报", () => {
    expect(findLedgerNumberConflicts({ chapter: 5, draftBody: "林秋那天去了槐树巷七号。", facts: ledger })).toEqual([]);
  });

  it("泛前缀（今年 N 岁）只认紧挨着的主体：说的是别人 → 不报；说的是苏晚 → 报", () => {
    expect(findLedgerNumberConflicts({ chapter: 3, draftBody: "周屿今年三十岁，比苏晚大两岁。", facts: ledger })).toEqual([]);
    const wrong = findLedgerNumberConflicts({ chapter: 3, draftBody: "苏晚今年二十六岁。", facts: ledger });
    expect(wrong).toHaveLength(1);
    expect(wrong[0]!.factId).toBe("fact-1-1");
  });

  it("约数、相对时间、序数不当死设定", () => {
    const facts = [fact("f1", 1, "老陈在槐树巷住了三十年。", { subject: "老陈" })];
    expect(findLedgerNumberConflicts({ chapter: 2, draftBody: "老陈在槐树巷住了三十多年。", facts })).toEqual([]);
    expect(findLedgerNumberConflicts({ chapter: 2, draftBody: "槐树巷三年前拆了一半。", facts })).toEqual([]);
    expect(findLedgerNumberConflicts({ chapter: 2, draftBody: "他住在槐树巷第九号院。", facts })).toEqual([]);
  });

  it("「年」只比年份；「开张头十四年」「开店二十六年」这类时长不当模板（换题材长篇实跑误报）", () => {
    const facts = [
      fact("f-span", 2, "最前头撕掉了一沓，开张头十四年的账不知去向。", { subject: "账本" }),
      fact("f-open", 1, "春分面馆开店二十六年。", { subject: "春分面馆" }),
      fact("f-year", 1, "林国栋一九九四年盘下这间铺子。", { subject: "林国栋" }),
    ];
    expect(findLedgerNumberConflicts({ chapter: 5, draftBody: "“开张头一年。这排门脸里就他一家撑着。", facts })).toEqual([]);
    expect(findLedgerNumberConflicts({ chapter: 40, draftBody: "春分面馆开店二十七年，头一回关门。", facts })).toEqual([]);
    expect(findLedgerNumberConflicts({ chapter: 6, draftBody: "林国栋一九九六年盘下这间铺子。", facts })).toHaveLength(1);
    expect(findLedgerNumberConflicts({ chapter: 6, draftBody: "林国栋九六年盘下这间铺子。", facts })).toHaveLength(1);
  });

  it("只比本章之前、还算数的硬设定：被取代的、会变的状态、本章及以后记的都不比", () => {
    const facts = [
      fact("old", 1, "书店在青石巷五号。", { subject: "半页书店", supersededByChapter: 3 }),
      fact("state", 1, "便签在收银台第二层。", { subject: "便签", kind: "state" }),
      fact("later", 6, "书店在青石巷八号。", { subject: "半页书店" }),
    ];
    expect(findLedgerNumberConflicts({ chapter: 4, draftBody: "半页书店在青石巷六号。便签在收银台第三层。", facts })).toEqual([]);
  });

  it("大考卷上的误报：「一栋两层 / 一栋三层」（两栋楼）、门口停了几辆车（会变）、老账本没类型 → 都不报", () => {
    const facts = [
      fact("f-dong", 2, "片区动迁办在街口往东，是一栋两层的老办公楼。", { subject: "动迁办" }),
      fact("f-car", 3, "街道办门口台阶上停着两辆电动车。", { subject: "街道办" }),
      { id: "f-old", chapter: 2, text: "老宅门牌是梧桐街九号。", source: "auto" },
    ];
    expect(findLedgerNumberConflicts({ chapter: 4, draftBody: "街道办是一栋三层的白瓷砖楼。", facts })).toEqual([]);
    expect(findLedgerNumberConflicts({ chapter: 9, draftBody: "门口牌子底下停着三辆电动车，多了一辆。", facts })).toEqual([]);
    expect(findLedgerNumberConflicts({ chapter: 5, draftBody: "老宅门牌是梧桐街七号。", facts })).toEqual([]);
  });
});
