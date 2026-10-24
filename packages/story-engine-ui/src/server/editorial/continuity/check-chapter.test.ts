// @vitest-environment node
// 编辑部 R3 后这里只测确定性工具集（原句核对 / 通读解析 / 核账记忆 / 合并去重 / 账本对账 / 对冲）；
// 调模型的编排（组合查错 combo）已删，核账员那一路的行为见 editorial/checker.test.ts 和 check-service.test.ts。
import { describe, expect, it, vi } from "vitest";
import {
  containsQuote,
  hedged,
  issueStillPresent,
  ledgerNumberIssues,
  mergeContinuityIssues,
  parseFullReadIssues,
  settleMirroredIssues,
  snapIssueQuotes,
  snapToOriginal,
  splitSentences,
  type ContinuityIssueV2,
  type EarlierText,
} from "./check-chapter.js";

const EARLIER: EarlierText = {
  chapters: [
    { chapter: 2, sentences: splitSentences("周婶端着茶进来。林舟把怀表锁进了柜台下的抽屉。林溪说她后天走。") },
    { chapter: 1, sentences: splitSentences("客人把怀表放在绒布上就走了。周婶说这表是前天送来的。") },
  ],
};
const BODY = "林舟一早开门。他从工作台上拿起那块怀表，表盖还开着。周婶在门口喊他。";

describe("原句核对 containsQuote", () => {
  it("逐字在 → true；长句改一两个字（九成两字片段落在同一窗口）→ 也算在；太短 / 编的 → false", () => {
    expect(containsQuote(BODY, "他从工作台上拿起那块怀表")).toBe(true);
    // 模型抄长原句常改一两个字：够长的句子丢两三个两字片段仍过九成线（短句差一个字就到不了九成，只能逐字）。
    const long = "林舟一早开门，把柜台上的灯拧亮，从工作台下面拿起那块黄铜怀表，表盖还开着没有合上。";
    expect(containsQuote(long, "林舟一早开门，把柜台上的灯拧亮，从工作台下面拿起那块黄铜怀表，表盖还开着没有合上。")).toBe(true);
    expect(containsQuote(long, "林舟一早开门，把柜台上的灯拧亮，从工作台下面拿起那块黄铜怀表，表盖还开着没有关上。")).toBe(true);
    expect(containsQuote(BODY, "他从工作桌上拿起那块怀表")).toBe(false); // 短句改一个字就到不了九成
    expect(containsQuote(BODY, "正文里没有的一句话呀")).toBe(false);
    expect(containsQuote(BODY, "表")).toBe(false);
  });
});

describe("通读解析 parseFullReadIssues", () => {
  it("两边原句都要找得到：本章那句在本章、前文那句在前文（或本章更早处）", () => {
    const issues = parseFullReadIssues(JSON.stringify({
      contradictions: [
        { quote: "他从工作台上拿起那块怀表", earlierQuote: "林舟把怀表锁进了柜台下的抽屉", earlierChapter: 2, reason: "位置对不上" },
        { quote: "他从工作台上拿起那块怀表", earlierQuote: "前文没有的一句话呀", earlierChapter: 2, reason: "x" },
        { quote: "本章没有的一句话", earlierQuote: "林舟把怀表锁进了柜台下的抽屉", earlierChapter: 2, reason: "x" },
      ],
    }), 3, BODY, EARLIER);
    expect(issues).toHaveLength(1);
    expect(issues[0].earlierChapter).toBe(2);
  });

  it("本章那句和「本章前文」那句是同一处（互相包含）→ 不报", () => {
    const issues = parseFullReadIssues(JSON.stringify({
      contradictions: [{ quote: "表盖还开着", earlierQuote: "他从工作台上拿起那块怀表，表盖还开着。", earlierChapter: 3, reason: "重复" }],
    }), 3, BODY, EARLIER);
    expect(issues).toEqual([]);
    const doubled = `${BODY}他从工作台上拿起那块怀表，表盖还开着。`;
    const repeated = parseFullReadIssues(JSON.stringify({
      contradictions: [{ quote: "表盖还开着", earlierQuote: "他从工作台上拿起那块怀表，表盖还开着。", earlierChapter: 3, reason: "同一句写了两遍" }],
    }), 3, doubled, EARLIER);
    expect(repeated).toHaveLength(1);
  });

  it("理由里自己说「一致 / 不矛盾」的也照收：是不是问题交给 A 自复核的结构化判定（重构 P7 删了词表）", () => {
    const issues = parseFullReadIssues(JSON.stringify({
      contradictions: [
        { quote: "他从工作台上拿起那块怀表", earlierQuote: "林舟把怀表锁进了柜台下的抽屉", earlierChapter: 2, reason: "前后一致，不矛盾" },
      ],
    }), 3, BODY, EARLIER);
    expect(issues.map((issue) => issue.quote)).toEqual(["他从工作台上拿起那块怀表，表盖还开着。"]);
  });
});

describe("模型调用的对冲 hedged", () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it("第一份很慢 → 过了对冲时间再发一份，先回来的为准", async () => {
    let calls = 0;
    const run = vi.fn(async () => {
      calls += 1;
      const mine = calls;
      await sleep(mine === 1 ? 200 : 10);
      return `第${mine}份`;
    });
    await expect(hedged(run, 30)).resolves.toBe("第2份");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("第一份很快 → 不再发第二份", async () => {
    const run = vi.fn(async () => "快");
    await expect(hedged(run, 50)).resolves.toBe("快");
    await sleep(80);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("第一份失败 → 马上补发一份（不等对冲时间）；两份都失败才算失败", async () => {
    let calls = 0;
    const flaky = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("断了");
      return "好了";
    });
    await expect(hedged(flaky, 10_000)).resolves.toBe("好了");
    const broken = vi.fn(async () => { throw new Error("一直断"); });
    await expect(hedged(broken, 10_000)).rejects.toThrow("一直断");
    expect(broken).toHaveBeenCalledTimes(2);
  });
});

describe("核账记忆：上次的问题还在不在", () => {
  const issue = { quote: "他从工作台上拿起那块怀表，表盖还开着。", earlierQuote: "林舟把怀表锁进了柜台下的抽屉。", earlierChapter: 2, reason: "x", kind: "object" as const };

  it("两边原句逐字都在 → 在；作者只改了一个字 → 不在（不能模糊算还在）", () => {
    expect(issueStillPresent(issue, 3, BODY, EARLIER, BODY)).toBe(true);
    expect(issueStillPresent(issue, 3, BODY.replace("表盖还开着", "表盖已合上"), EARLIER, BODY)).toBe(false);
    expect(issueStillPresent(issue, 3, BODY.replace("工作台", "工作桌"), EARLIER, BODY)).toBe(false);
  });

  it("两句都在本章：两句连同中间那段一字不差才算还在；作者挪了段、在中间补了句 → 不在（交给这次重核）", () => {
    const before = "护士挂上吊瓶，罗睡着了。医生转头问罗：“这伤怎么来的？”许微回到床边。";
    const here = { quote: "医生转头问罗：“这伤怎么来的？”", earlierQuote: "护士挂上吊瓶，罗睡着了。", earlierChapter: 3, reason: "睡着的人没法被问话", kind: "event" as const };
    expect(issueStillPresent(here, 3, before, EARLIER, before)).toBe(true);
    expect(issueStillPresent(here, 3, `${before}天黑了。`, EARLIER, before)).toBe(true);
    const moved = "医生转头问罗：“这伤怎么来的？”护士挂上吊瓶，罗睡着了。许微回到床边。";
    expect(issueStillPresent(here, 3, moved, EARLIER, before)).toBe(false);
    const woke = "护士挂上吊瓶，罗睡着了。半夜罗醒了。医生转头问罗：“这伤怎么来的？”许微回到床边。";
    expect(issueStillPresent(here, 3, woke, EARLIER, before)).toBe(false);
  });

  it("对设定本的条目：错的那句还在（本章或 fixChapter 那章）、设定本还这么写 → 在；句子改了或设定改了 → 不在", () => {
    const SETTING = "外貌：左腿有旧伤";
    const settingSays = (quote: string) => quote === SETTING;
    const here = { quote: "周婶在门口喊他。", earlierQuote: SETTING, earlierChapter: 3, reason: "x", kind: "event" as const, againstSetting: { label: "人物卡" } };
    expect(issueStillPresent(here, 3, BODY, EARLIER, BODY, settingSays)).toBe(true);
    expect(issueStillPresent(here, 3, BODY.replace("周婶在门口喊他。", "门口没人。"), EARLIER, BODY, settingSays)).toBe(false);
    expect(issueStillPresent(here, 3, BODY, EARLIER, BODY, () => false)).toBe(false);
    expect(issueStillPresent(here, 3, BODY, EARLIER, BODY)).toBe(false);
    const there = { ...here, quote: "林溪说她后天走。", earlierChapter: 2, fixChapter: 2 };
    expect(issueStillPresent(there, 3, BODY, EARLIER, BODY, settingSays)).toBe(true);
    expect(issueStillPresent({ ...there, fixChapter: 1 }, 3, BODY, EARLIER, BODY, settingSays)).toBe(false);
  });
});

describe("合并去重 mergeContinuityIssues：同一句只报一次", () => {
  const issue = (quote: string, reason: string): ContinuityIssueV2 => ({ quote, earlierQuote: "林舟把怀表锁进了柜台下的抽屉。", earlierChapter: 2, reason, kind: "object" });

  it("一条的原句包含另一条的 → 只留先来的", () => {
    const merged = mergeContinuityIssues([issue("他从工作台上拿起那块怀表，表盖还开着。", "位置对不上"), issue("拿起那块怀表", "同一件事又报一遍")]);
    expect(merged.map((item) => item.reason)).toEqual(["位置对不上"]);
  });

  it("两段搭着抄（一条的尾巴是另一条的开头，搭上 8 字以上）→ 同一句，只留先来的；只搭一两个字的不算", () => {
    const merged = mergeContinuityIssues([
      issue("那扇门她来过不止一回，就在那排库房往里数第三个门", "门的位置对不上"),
      issue("就在那排库房往里数第三个门，门前一小片空地", "同一扇门又报一遍"),
      issue("门前一小片空地，她说", "搭边太短"),
      issue("她说完就走了。", "另一句"),
    ]);
    expect(merged.map((item) => item.reason)).toEqual(["门的位置对不上", "搭边太短", "另一句"]);
  });
});

describe("方向相反的一对 settleMirroredIssues：两条各让改对方，降成「可能」交作者挑", () => {
  const LIU = "落款那个姓，姓刘。刘成泰。";
  const RUAN = "船东阮成泰。被扣货车挂靠单位。";
  const inChapter = (quote: string, earlierQuote: string, extra: Partial<ContinuityIssueV2> = {}): ContinuityIssueV2 =>
    ({ quote, earlierQuote, earlierChapter: 19, reason: "姓对不上", kind: "identity", confidence: "sure", ...extra });

  it("本章 A 对不上 B、又报 B 对不上 A → 两条都降「可能」；不成对的照旧", () => {
    const settled = settleMirroredIssues([
      inChapter(RUAN, LIU),
      inChapter("阮。R。", "刮剩的是立刀旁", { earlierChapter: 18 }),
      inChapter(LIU, RUAN),
    ], 19);
    expect(settled.map((item) => item.confidence)).toEqual(["maybe", "sure", "maybe"]);
  });

  it("引的是前文某章、或对设定本的，不算成对", () => {
    const againstSetting = { label: "地点" };
    const settled = settleMirroredIssues([
      inChapter(RUAN, LIU, { earlierChapter: 18 }),
      inChapter(LIU, RUAN, { againstSetting }),
    ], 19);
    expect(settled.map((item) => item.confidence)).toEqual(["sure", "sure"]);
  });
});

describe("引文对回原句 snapToOriginal / snapIssueQuotes", () => {
  const draft = "“我有一个条件。整条巷子十一月底清空，我要留到最后一天交房。登记簿里还有客人没取的表，铺子得开着门等人。”\n\n他看了她一眼，没再说话。";
  const sentences = splitSentences(draft);

  it("都对回整句（P12 编号句子）：半句 → 那一整句；抄错一两个字 → 正文真句；跨两句抄的 / 「A……B」两截 → 那几句；编的 → 原样", () => {
    expect(snapToOriginal(sentences, "十一月底清空")).toBe("整条巷子十一月底清空，我要留到最后一天交房。");
    expect(snapToOriginal(sentences, "整条巷子十一月底清空，我要留到最后一天交房。")).toBe("整条巷子十一月底清空，我要留到最后一天交房。");
    expect(snapToOriginal(sentences, "她看了她一眼，没再说话。")).toBe("他看了她一眼，没再说话。");
    expect(snapToOriginal(sentences, "交房。登记簿里")).toBe("整条巷子十一月底清空，我要留到最后一天交房。登记簿里还有客人没取的表，铺子得开着门等人。”");
    expect(snapToOriginal(sentences, "整条巷子十一月底清空……铺子得开着门等人")).toBe("整条巷子十一月底清空，我要留到最后一天交房。登记簿里还有客人没取的表，铺子得开着门等人。”");
    expect(snapToOriginal(sentences, "整条巷子十一月底清空，铺子得开着门等人。")).toBe("整条巷子十一月底清空，我要留到最后一天交房。登记簿里还有客人没取的表，铺子得开着门等人。”");
    expect(snapToOriginal(sentences, "他们明天一早就搬走了。")).toBe("他们明天一早就搬走了。");
  });

  it("同一句抄成两个样子（真机试写第 6 章）：对回原句后合并成一条", () => {
    const setting = { againstSetting: { label: "地点" }, earlierChapter: 6, earlierQuote: "青石巷——现状：明年要拆迁", reason: "对不上", kind: "event" as const };
    const snapped = snapIssueQuotes([
      { ...setting, quote: "整条巷子十一月底清空，铺子得开着门等人。" },
      { ...setting, quote: "整条巷子十一月底要清空，我要留到最后一天交房" },
    ], 6, draft, { chapters: [] });
    expect(snapped.map((issue) => issue.earlierQuote)).toEqual(["青石巷——现状：明年要拆迁", "青石巷——现状：明年要拆迁"]);
    expect(snapped[1]!.quote).toBe("整条巷子十一月底清空，我要留到最后一天交房。");
    expect(mergeContinuityIssues(snapped)).toHaveLength(1);
  });

  it("前文那句对它标的那一章", () => {
    const earlier: EarlierText = { chapters: [{ chapter: 1, sentences: splitSentences("周婶端着茶进来，说这块表是她男人年轻时在城南百货买的，戴了三十年。") }] };
    const [issue] = snapIssueQuotes([{ quote: "他看了她一眼", earlierQuote: "周婶说这块表是她男人年轻时在城南百货买的，戴了三十年", earlierChapter: 1, reason: "r", kind: "event" }], 3, draft, earlier);
    expect(issue!.earlierQuote).toBe("周婶端着茶进来，说这块表是她男人年轻时在城南百货买的，戴了三十年。");
  });
});

describe("账本数字对账（确定性层）", () => {
  const ledgerFacts = [{
    id: "fact-2-6", chapter: 2, text: "扉页写着林秋，一九八七年春", source: "auto",
    quote: "扉页上写着两行字：林秋，一九八七年春。", subject: "城南旧事", kind: "hard" as const,
  }];
  const body = "他翻开扉页，看着那两行字——林秋，一九八五年春——看了很久。";

  it("账本对出来的照报「确定」（source=ledger），排最前", async () => {
    const result = await ledgerNumberIssues({ projectDir: "/nonexistent", chapter: 4, draftBody: body, ledgerFacts });
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({ source: "ledger", confidence: "sure", earlierChapter: 2, kind: "number" });
    expect(result.failures).toEqual([]);
  });
});
