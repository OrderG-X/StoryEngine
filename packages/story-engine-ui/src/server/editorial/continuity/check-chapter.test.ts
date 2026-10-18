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
    expect(issues.map((issue) => issue.quote)).toEqual(["他从工作台上拿起那块怀表"]);
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
    expect(issueStillPresent(issue, 3, BODY, EARLIER)).toBe(true);
    expect(issueStillPresent(issue, 3, BODY.replace("表盖还开着", "表盖已合上"), EARLIER)).toBe(false);
    expect(issueStillPresent(issue, 3, BODY.replace("工作台", "工作桌"), EARLIER)).toBe(false);
  });
});

describe("合并去重 mergeContinuityIssues：同一句只报一次", () => {
  const issue = (quote: string, reason: string): ContinuityIssueV2 => ({ quote, earlierQuote: "林舟把怀表锁进了柜台下的抽屉。", earlierChapter: 2, reason, kind: "object" });

  it("一条的原句包含另一条的 → 只留先来的", () => {
    const merged = mergeContinuityIssues([issue("他从工作台上拿起那块怀表，表盖还开着。", "位置对不上"), issue("拿起那块怀表", "同一件事又报一遍")]);
    expect(merged.map((item) => item.reason)).toEqual(["位置对不上"]);
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
