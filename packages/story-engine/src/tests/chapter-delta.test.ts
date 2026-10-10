import { describe, expect, it } from "vitest";
import {
  evidenceAppearsInDraft,
  verifyChapterDelta,
  type ChapterDeltaDeclaration,
} from "../chapter-delta.js";

const DRAFT = [
  "陆青岚蹲在药垄边，指尖沾着湿泥。",
  "低头扒开槐花落，半块残玉露了出来。玉质偏暗，正面刻着半只青色的鹤。",
  "墙根的浮土下埋着个青瓷瓶，黄签上的墨字还鲜亮：补气丹，十二枚。",
  "师父失踪三个月，组织只给了个“外出云游未归”的说法。",
].join("\n");

function baseDeclaration(overrides: Partial<ChapterDeltaDeclaration> = {}): ChapterDeltaDeclaration {
  return {
    chapter: 1,
    mainEvent: { summary: "捡到鹤纹残玉", quote: "半块残玉露了出来。" },
    seededForeshadowing: [],
    resolvedForeshadowing: [],
    resourceDeltas: [],
    keyLeads: [],
    ...overrides,
  };
}

describe("evidenceAppearsInDraft", () => {
  const normalizedDraft = DRAFT.replace(/\s+/gu, "");

  it("逐字命中的原句判为存在", () => {
    expect(evidenceAppearsInDraft("半块残玉露了出来。", normalizedDraft)).toBe(true);
  });

  it("只有空白差异（换行/空格）仍判为存在", () => {
    expect(evidenceAppearsInDraft("玉质偏暗，  正面刻着半只青色的鹤。", normalizedDraft)).toBe(true);
  });

  it("正文里没有的句子判为不存在", () => {
    expect(evidenceAppearsInDraft("他一剑劈开了大门。", normalizedDraft)).toBe(false);
  });

  it("空证据判为不存在", () => {
    expect(evidenceAppearsInDraft("", normalizedDraft)).toBe(false);
    expect(evidenceAppearsInDraft("   ", normalizedDraft)).toBe(false);
  });
});

describe("verifyChapterDelta", () => {
  it("证据命中的 mainEvent 被保留", () => {
    const result = verifyChapterDelta(baseDeclaration(), DRAFT);
    expect(result.mainEvent?.summary).toBe("捡到鹤纹残玉");
    expect(result.rejected).toHaveLength(0);
    expect(result.hasAnyVerified).toBe(true);
  });

  it("证据对不上的 mainEvent 被拒、且不进结果", () => {
    const result = verifyChapterDelta(
      baseDeclaration({ mainEvent: { summary: "瞎编的大事", quote: "他一剑劈开了大门。" } }),
      DRAFT,
    );
    expect(result.mainEvent).toBeUndefined();
    expect(result.rejected).toEqual([
      { field: "mainEvent", quote: "他一剑劈开了大门。", reason: "evidence_not_in_draft" },
    ]);
    expect(result.hasAnyVerified).toBe(false);
  });

  it("逐条校验伏笔：命中的留、不命中的进 rejected", () => {
    const result = verifyChapterDelta(
      baseDeclaration({
        seededForeshadowing: [
          { summary: "鹤纹残玉", quote: "正面刻着半只青色的鹤。" },
          { summary: "凭空捏造", quote: "地上有一张藏宝图。" },
        ],
      }),
      DRAFT,
    );
    expect(result.seededForeshadowing).toHaveLength(1);
    expect(result.seededForeshadowing[0]?.summary).toBe("鹤纹残玉");
    expect(result.rejected).toEqual([
      { field: "seededForeshadowing[1]", quote: "地上有一张藏宝图。", reason: "evidence_not_in_draft" },
    ]);
  });

  it("资源数量：amount 出现在证据句里则通过", () => {
    const result = verifyChapterDelta(
      baseDeclaration({
        resourceDeltas: [
          { item: "补气丹", change: "gain", amount: "十二枚", quote: "黄签上的墨字还鲜亮：补气丹，十二枚。" },
        ],
      }),
      DRAFT,
    );
    expect(result.resourceDeltas).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
  });

  it("资源数量：amount 不在证据句里则弃数量保条目，并披露 rejected（防数量漂移且不丢资源变化）", () => {
    const result = verifyChapterDelta(
      baseDeclaration({
        resourceDeltas: [
          { item: "补气丹", change: "gain", amount: "一瓶", quote: "黄签上的墨字还鲜亮：补气丹，十二枚。" },
        ],
      }),
      DRAFT,
    );
    expect(result.resourceDeltas).toEqual([
      { item: "补气丹", change: "gain", quote: "黄签上的墨字还鲜亮：补气丹，十二枚。" },
    ]);
    expect(result.rejected).toEqual([
      { field: "resourceDeltas[0]", quote: "黄签上的墨字还鲜亮：补气丹，十二枚。", reason: "amount_not_in_evidence" },
    ]);
  });

  it("资源数量：quote 不在草稿里仍整条拒绝，不保留 item/change", () => {
    const result = verifyChapterDelta(
      baseDeclaration({
        resourceDeltas: [
          { item: "补气丹", change: "gain", amount: "一瓶", quote: "黄签上的墨字还鲜亮：补气丹，一瓶。" },
        ],
      }),
      DRAFT,
    );
    expect(result.resourceDeltas).toHaveLength(0);
    expect(result.rejected).toEqual([
      { field: "resourceDeltas[0]", quote: "黄签上的墨字还鲜亮：补气丹，一瓶。", reason: "evidence_not_in_draft" },
    ]);
  });

  it("pendingIntents：证据命中的待办意图被保留", () => {
    const draft = `${DRAFT}\n陆青岚决定明日去档案室查清残玉来历。`;
    const result = verifyChapterDelta(
      baseDeclaration({
        pendingIntents: [
          { summary: "陆青岚明日查残玉来历", quote: "陆青岚决定明日去档案室查清残玉来历。" },
        ],
      }),
      draft,
    );

    expect(result.pendingIntents).toHaveLength(1);
    expect(result.pendingIntents[0]?.summary).toBe("陆青岚明日查残玉来历");
    expect(result.rejected).toHaveLength(0);
  });

  it("pendingIntents：证据对不上的待办意图逐条拒绝", () => {
    const result = verifyChapterDelta(
      baseDeclaration({
        pendingIntents: [
          { summary: "陆青岚去丹房", quote: "陆青岚决定去丹房查账。" },
        ],
      }),
      DRAFT,
    );

    expect(result.pendingIntents).toHaveLength(0);
    expect(result.rejected).toEqual([
      { field: "pendingIntents[0]", quote: "陆青岚决定去丹房查账。", reason: "evidence_not_in_draft" },
    ]);
  });

  it("continuityWithPrevious：主观衔接判断原样透传，不参与证据校验和 hasAnyVerified", () => {
    const result = verifyChapterDelta(
      baseDeclaration({
        continuityWithPrevious: { connects: false, note: "上一章已在黑龙潭等待，本章却回到园圃日常。" },
      }),
      DRAFT,
    );

    expect(result.continuityWithPrevious).toEqual({
      connects: false,
      note: "上一章已在黑龙潭等待，本章却回到园圃日常。",
    });
    expect(result.rejected).toHaveLength(0);
    expect(result.hasAnyVerified).toBe(true);
  });

  it("空证据被标 empty_quote", () => {
    const result = verifyChapterDelta(
      baseDeclaration({ mainEvent: { summary: "无证据", quote: "" } }),
      DRAFT,
    );
    expect(result.mainEvent).toBeUndefined();
    expect(result.rejected[0]?.reason).toBe("empty_quote");
  });

  it("完全空声明：hasAnyVerified=false、无 rejected", () => {
    const result = verifyChapterDelta(
      {
        chapter: 2,
        mainEvent: { summary: "", quote: "" },
        seededForeshadowing: [],
        resolvedForeshadowing: [],
        resourceDeltas: [],
        keyLeads: [],
      },
      DRAFT,
    );
    expect(result.hasAnyVerified).toBe(false);
    // mainEvent 空 quote 会记一条 empty_quote
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toBe("empty_quote");
  });

  it("人物名册：名字出现在证据句且证据在草稿里则通过", () => {
    const result = verifyChapterDelta(
      baseDeclaration({
        charactersPresent: [
          { name: "陆青岚", quote: "陆青岚蹲在药垄边，指尖沾着湿泥。", identityHint: "主角" },
        ],
      }),
      DRAFT,
    );
    expect(result.charactersPresent).toHaveLength(1);
    expect(result.charactersPresent[0]?.name).toBe("陆青岚");
    expect(result.rejected).toHaveLength(0);
    expect(result.hasAnyVerified).toBe(true);
  });

  it("人物名册：名字不在证据句里则被拒（name_not_in_evidence）", () => {
    const result = verifyChapterDelta(
      baseDeclaration({
        charactersPresent: [
          { name: "王二", quote: "陆青岚蹲在药垄边，指尖沾着湿泥。" },
        ],
      }),
      DRAFT,
    );
    expect(result.charactersPresent).toHaveLength(0);
    expect(result.rejected).toEqual([
      { field: "charactersPresent[0]", quote: "陆青岚蹲在药垄边，指尖沾着湿泥。", reason: "name_not_in_evidence" },
    ]);
  });

  it("人物名册：证据句不在草稿里则被拒（evidence_not_in_draft）", () => {
    const result = verifyChapterDelta(
      baseDeclaration({
        charactersPresent: [
          { name: "陆青岚", quote: "陆青岚一剑劈开了大门。" },
        ],
      }),
      DRAFT,
    );
    expect(result.charactersPresent).toHaveLength(0);
    expect(result.rejected[0]?.reason).toBe("evidence_not_in_draft");
  });

  it("主线目标推进：证据命中则保留、计入 hasAnyVerified", () => {
    const result = verifyChapterDelta(
      baseDeclaration({
        arcGoalProgress: [
          { summary: "查明师父失踪真相", progress: "introduced", scope: "main_arc", quote: "师父失踪三个月，组织只给了个“外出云游未归”的说法。" },
        ],
      }),
      DRAFT,
    );
    expect(result.arcGoalProgress).toHaveLength(1);
    expect(result.arcGoalProgress[0]?.progress).toBe("introduced");
    expect(result.rejected).toHaveLength(0);
    expect(result.hasAnyVerified).toBe(true);
  });

  it("主线目标推进：证据对不上则被拒、不进结果", () => {
    const result = verifyChapterDelta(
      baseDeclaration({
        mainEvent: { summary: "", quote: "" },
        arcGoalProgress: [
          { summary: "凭空的目标", progress: "advanced", quote: "他一夜之间登基称帝。" },
        ],
      }),
      DRAFT,
    );
    expect(result.arcGoalProgress).toHaveLength(0);
    expect(result.hasAnyVerified).toBe(false);
    expect(result.rejected).toEqual(expect.arrayContaining([
      { field: "arcGoalProgress[0]", quote: "他一夜之间登基称帝。", reason: "evidence_not_in_draft" },
    ]));
  });

  it("可选语义标量 conflict/discovery/decision：证据命中保留、对不上被拒、计入 hasAnyVerified", () => {
    const result = verifyChapterDelta(
      baseDeclaration({
        mainEvent: { summary: "", quote: "" },
        conflict: { summary: "埋着可疑之物", quote: "墙根的浮土下埋着个青瓷瓶，黄签上的墨字还鲜亮：补气丹，十二枚。" },
        discovery: { summary: "发现鹤纹残玉", quote: "半块残玉露了出来。" },
        decision: { summary: "凭空的决定", quote: "他决定即刻启程离开组织。" },
      }),
      DRAFT,
    );
    expect(result.conflict?.summary).toBe("埋着可疑之物");
    expect(result.discovery?.summary).toBe("发现鹤纹残玉");
    expect(result.decision).toBeUndefined();
    expect(result.hasAnyVerified).toBe(true);
    expect(result.rejected).toEqual(expect.arrayContaining([
      { field: "decision", quote: "他决定即刻启程离开组织。", reason: "evidence_not_in_draft" },
    ]));
  });

  it("未声明 conflict/discovery/decision → 结果里没有、也不误报 rejected", () => {
    const result = verifyChapterDelta(baseDeclaration(), DRAFT);
    expect(result.conflict).toBeUndefined();
    expect(result.discovery).toBeUndefined();
    expect(result.decision).toBeUndefined();
    expect(result.rejected).toHaveLength(0);
  });

  it("多类混合：各字段独立裁决，互不影响", () => {
    const result = verifyChapterDelta(
      baseDeclaration({
        resolvedForeshadowing: [{ summary: "师父失踪", quote: "师父失踪三个月，组织只给了个“外出云游未归”的说法。", targetThreadHint: "师父失踪" }],
        keyLeads: [{ summary: "残玉线索", quote: "玉质偏暗，正面刻着半只青色的鹤。" }],
      }),
      DRAFT,
    );
    expect(result.mainEvent?.summary).toBe("捡到鹤纹残玉");
    expect(result.resolvedForeshadowing).toHaveLength(1);
    expect(result.keyLeads).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
    expect(result.hasAnyVerified).toBe(true);
  });
});

describe("时间声明（故事时间线）", () => {
  const draft = "三天后，周二下午，苏晚才又见到周屿。他手里拎着一个牛皮纸袋。";
  const base = { chapter: 5, mainEvent: { summary: "见面", quote: "苏晚才又见到周屿" }, seededForeshadowing: [], resolvedForeshadowing: [], resourceDeltas: [], keyLeads: [] };

  it("原句在正文里、星期写在原句里 → 收；隔几天要是合理整数", () => {
    const verified = verifyChapterDelta({ ...base, time: { daysSincePrevious: 3, weekday: "周二", timeOfDay: "下午", quote: "三天后，周二下午，苏晚才又见到周屿。" } }, draft);
    expect(verified.time).toEqual({ daysSincePrevious: 3, weekday: "周二", timeOfDay: "下午", quote: "三天后，周二下午，苏晚才又见到周屿。" });
  });

  it("原句不在正文 → 拒；星期没写在原句里（模型自己推的）→ 只丢星期；隔几天是负数 → 只丢天数", () => {
    expect(verifyChapterDelta({ ...base, time: { daysSincePrevious: 3, quote: "五天后" } }, draft).time).toBeUndefined();
    const guessed = verifyChapterDelta({ ...base, time: { daysSincePrevious: 3, weekday: "周三", quote: "三天后，周二下午，苏晚才又见到周屿。" } }, draft);
    expect(guessed.time).toEqual({ daysSincePrevious: 3, quote: "三天后，周二下午，苏晚才又见到周屿。" });
    const negative = verifyChapterDelta({ ...base, time: { daysSincePrevious: -1, weekday: "周二", quote: "三天后，周二下午，苏晚才又见到周屿。" } }, draft);
    expect(negative.time).toEqual({ weekday: "周二", quote: "三天后，周二下午，苏晚才又见到周屿。" });
  });

  it("隔几天必须写在原句里：原句只有「周五下午」时不收模型推的「隔 0 天」，只收星期", () => {
    const text = "周五下午，苏晚提前一个钟头关了店。";
    const verified = verifyChapterDelta({ ...base, mainEvent: { summary: "关店", quote: "苏晚提前一个钟头关了店" }, time: { daysSincePrevious: 0, weekday: "周五", timeOfDay: "下午", quote: "周五下午，苏晚提前一个钟头关了店。" } }, text);
    expect(verified.time).toEqual({ weekday: "周五", timeOfDay: "下午", quote: "周五下午，苏晚提前一个钟头关了店。" });
    const next = verifyChapterDelta({ ...base, mainEvent: { summary: "雨停", quote: "第二天雨停了" }, time: { daysSincePrevious: 1, quote: "第二天雨停了，天还阴着。" } }, "第二天雨停了，天还阴着。");
    expect(next.time).toEqual({ daysSincePrevious: 1, quote: "第二天雨停了，天还阴着。" });
  });

  it("模型漏填星期、原句里只写了一个星期 → 照原句取；原句写了两个星期 → 不猜", () => {
    const text = "周四晚上，苏晚关店比平时晚。她想起周二那天的事。";
    const own = { ...base, mainEvent: { summary: "关店", quote: "苏晚关店比平时晚" } };
    expect(verifyChapterDelta({ ...own, time: { timeOfDay: "晚上", quote: "周四晚上，苏晚关店比平时晚。" } }, text).time)
      .toEqual({ weekday: "周四", timeOfDay: "晚上", quote: "周四晚上，苏晚关店比平时晚。" });
    expect(verifyChapterDelta({ ...own, time: { timeOfDay: "晚上", quote: "周四晚上，苏晚关店比平时晚。她想起周二那天的事。" } }, text).time)
      .toEqual({ timeOfDay: "晚上", quote: "周四晚上，苏晚关店比平时晚。她想起周二那天的事。" });
  });

  it("开头时间和章内换天引的是同一句 → 只算在开头，不再算章内过了一天", () => {
    const text = "苏晚想了一夜。第二天一早，她骑车去了槐树巷。";
    const verified = verifyChapterDelta({
      ...base,
      mainEvent: { summary: "去槐树巷", quote: "她骑车去了槐树巷" },
      time: { daysSincePrevious: 1, quote: "第二天一早，她骑车去了槐树巷。" },
      timeSpan: { days: 1, quote: "第二天一早，她骑车去了槐树巷。" },
    }, text);
    expect(verified.time?.daysSincePrevious).toBe(1);
    expect(verified.timeSpan).toBeUndefined();
  });

  it("章内换天：原句在正文里、写着换天说法、天数 1～60 才收；否则当整章同一天", () => {
    const text = "周二傍晚，苏晚把牌子翻了个面。第二天上午，她把店交给王婶，去了槐树巷。";
    const own = { ...base, mainEvent: { summary: "去槐树巷", quote: "她把店交给王婶" } };
    expect(verifyChapterDelta({ ...own, timeSpan: { days: 1, quote: "第二天上午，她把店交给王婶，去了槐树巷。" } }, text).timeSpan)
      .toEqual({ days: 1, quote: "第二天上午，她把店交给王婶，去了槐树巷。" });
    expect(verifyChapterDelta({ ...own, timeSpan: { days: 1, quote: "周二傍晚，苏晚把牌子翻了个面。" } }, text).timeSpan).toBeUndefined();
    expect(verifyChapterDelta({ ...own, timeSpan: { days: 0, quote: "第二天上午，她把店交给王婶，去了槐树巷。" } }, text).timeSpan).toBeUndefined();
    expect(verifyChapterDelta({ ...own, timeSpan: { days: 1, quote: "第三天她又来了。" } }, text).timeSpan).toBeUndefined();
  });
});
