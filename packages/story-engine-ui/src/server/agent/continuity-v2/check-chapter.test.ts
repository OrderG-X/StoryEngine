// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  checkChapterContinuity,
  findEvidence,
  parseClaims,
  parseFullReadIssues,
  parseVerdicts,
  searchForms,
  splitSentences,
  type ChapterClaim,
  type EarlierText,
} from "./check-chapter.js";

const EARLIER: EarlierText = {
  chapters: [
    { chapter: 2, sentences: splitSentences("周婶端着茶进来。林舟把怀表锁进了柜台下的抽屉。林溪说她后天走。") },
    { chapter: 1, sentences: splitSentences("客人把怀表放在绒布上就走了。周婶说这表是前天送来的。") },
  ],
};
const BODY = "林舟一早开门。他从工作台上拿起那块怀表，表盖还开着。周婶在门口喊他。";

describe("查错 v2：拆说法", () => {
  it("按句子编号取回原句（分段时编号连续）；越界的丢掉；同一句只留一条；名字去重、过滤过长过短；类型认不出当 event", () => {
    const sentences = splitSentences(BODY);
    const claims = parseClaims(JSON.stringify({
      claims: [
        { s: 2, t: ["怀表", "工作台", "怀表", "x"], k: "object" },
        { s: 9, t: ["x"], k: "object" },
        { s: "[3]", t: "周婶、门口", k: "随便" },
        { s: 3, t: ["周婶"], k: "place" },
      ],
    }), sentences.slice(1), 1);
    expect(claims).toHaveLength(2);
    expect(claims[0]).toMatchObject({ id: "C1", quote: sentences[1], terms: ["怀表", "工作台"], kind: "object" });
    expect(claims[1]).toMatchObject({ quote: sentences[2], terms: ["周婶", "门口"], kind: "event" });
  });

  it("宽进：模型照老格式逐字抄原句也认，抄不出原文的不收", () => {
    const claims = parseClaims(JSON.stringify({
      claims: [
        { quote: "他从工作台上拿起那块怀表，表盖还开着。", terms: ["怀表"], kind: "object" },
        { quote: "正文里没有这句", terms: ["x"], kind: "object" },
      ],
    }), splitSentences(BODY));
    expect(claims.map((claim) => claim.quote)).toEqual(["他从工作台上拿起那块怀表，表盖还开着。"]);
  });
});

describe("查错 v2：对前文", () => {
  it("长名字也用短形去找（「樟木匣」→「木匣」）", () => {
    expect(searchForms("樟木匣")).toEqual(["樟木匣", "木匣"]);
    expect(searchForms("待修的表")).toEqual(["待修的表"]);
  });

  it("每个名字带上它最近一次被提到的那句：怀表最近一次是第 2 章「锁进了抽屉」", () => {
    const claim: ChapterClaim = { id: "C1", quote: "他从工作台上拿起那块怀表，表盖还开着。", claim: "怀表在工作台上", terms: ["怀表"], kind: "object" };
    const evidence = findEvidence(claim, EARLIER, 3, splitSentences(BODY));
    expect(evidence[0]).toMatchObject({ chapter: 2, text: "林舟把怀表锁进了柜台下的抽屉。" });
    expect(evidence.map((item) => item.chapter)).toContain(1);
  });
});

describe("查错 v2：逐条判", () => {
  const claim: ChapterClaim = { id: "C1", quote: "他从工作台上拿起那块怀表，表盖还开着。", claim: "怀表在工作台上", terms: ["怀表"], kind: "object" };
  const batch = [{ claim, evidence: findEvidence(claim, EARLIER, 3, splitSentences(BODY)) }];

  it("冲突的前文那句必须出自给出的原句；理由里自己说不矛盾的丢掉", () => {
    const issues = parseVerdicts(JSON.stringify({
      contradictions: [
        { id: "C1", earlierQuote: "林舟把怀表锁进了柜台下的抽屉", reason: "第 2 章怀表锁在抽屉里，本章却在工作台上，没写取出来" },
        { id: "C1", earlierQuote: "凭空编的一句前文", reason: "x" },
        { id: "C1", earlierQuote: "客人把怀表放在绒布上就走了", reason: "前后一致，不矛盾" },
      ],
    }), batch);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ earlierChapter: 2, earlierQuote: "林舟把怀表锁进了柜台下的抽屉。" });
  });
});

describe("查错 v2：整章通读", () => {
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
  });
});

describe("组合查错：通读 + 逐条判，合并去重后分三档复核", () => {
  it("复核判「不是」的删掉、「确定」的排前面、没给判断的当「可能」", async () => {
    const callModel = vi.fn(async (messages: readonly { readonly role: string; readonly content: string }[]) => {
      const system = messages[0].content;
      if (system.includes("复核编辑")) {
        return JSON.stringify({ verdicts: [{ id: "K1", verdict: "maybe" }, { id: "K2", verdict: "sure" }, { id: "K3", verdict: "no" }] });
      }
      if (system.includes("连续性审读员")) {
        const user = messages[1].content;
        if (user.includes("只盯东西")) {
          return JSON.stringify({ contradictions: [{ quote: "他从工作台上拿起那块怀表", earlierQuote: "林舟把怀表锁进了柜台下的抽屉", earlierChapter: 2, reason: "位置对不上" }] });
        }
        if (user.includes("只盯人")) {
          return JSON.stringify({ contradictions: [{ quote: "周婶在门口喊他", earlierQuote: "周婶端着茶进来", earlierChapter: 2, reason: "周婶位置" }] });
        }
        return JSON.stringify({ contradictions: [{ quote: "林舟一早开门", earlierQuote: "林溪说她后天走", earlierChapter: 2, reason: "牵强" }] });
      }
      return JSON.stringify({ claims: [] });
    });
    const result = await checkChapterContinuity({ projectDir: "/nonexistent", chapter: 3, draftBody: BODY, callModel, earlier: EARLIER });
    expect(result.candidates).toBe(3);
    expect(result.issues.map((issue) => [issue.reason, issue.confidence])).toEqual([["周婶位置", "sure"], ["位置对不上", "maybe"]]);
  });

  it("复核没跑成 → 候选原样交出并如实记一笔", async () => {
    const callModel = vi.fn(async (messages: readonly { readonly role: string; readonly content: string }[]) => {
      if (messages[0].content.includes("复核编辑")) throw new Error("idle timeout");
      if (messages[0].content.includes("连续性审读员") && messages[1].content.includes("只盯东西")) {
        return JSON.stringify({ contradictions: [{ quote: "他从工作台上拿起那块怀表", earlierQuote: "林舟把怀表锁进了柜台下的抽屉", earlierChapter: 2, reason: "位置对不上" }] });
      }
      return JSON.stringify({ contradictions: [], claims: [] });
    });
    const result = await checkChapterContinuity({ projectDir: "/nonexistent", chapter: 3, draftBody: BODY, callModel, earlier: EARLIER });
    expect(result.issues).toHaveLength(1);
    expect(result.failures.join("")).toContain("复核没跑成");
  });
});
