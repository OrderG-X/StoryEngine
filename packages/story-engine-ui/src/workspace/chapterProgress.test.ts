import { afterEach, describe, expect, it } from "vitest";

import type { ChapterMessage, ContinuityCheckData, OperationCardData, SettleCardData } from "../type-defs/workspace.js";
import { useChatStore } from "../stores/chatStore.js";
import {
  chapterProgress,
  continuityItemKey,
  latestContinuityResult,
  openContinuityItems,
  settledContinuityByMessage,
  type ContinuityResult,
} from "./chapterProgress.js";

const BODY = "第二天下午，林舟骑车去了东门菜场。\n\n摊主是个姓王的老师傅。";
const wrongMarket = { quote: "林舟骑车去了东门菜场。", earlierQuote: "约在南门菜场后街。", earlierChapter: 10, reason: "菜场对不上" };
const wrongName = { quote: "摊主是个姓王的老师傅。", earlierQuote: "摊主姓吴。", earlierChapter: 10, reason: "姓对不上" };
const maybeOne = { quote: "第二天下午", earlierQuote: "次日上午", earlierChapter: 10, reason: "时间可能对不上" };
const check: ContinuityCheckData = { chapter: 11, sure: [wrongMarket, wrongName], maybe: [maybeOne] };

const paper = (over: Partial<Parameters<typeof chapterProgress>[0]["paper"]> = {}) => ({
  chapter: 11,
  body: BODY,
  committed: null,
  baseVersion: "v1",
  savedBody: BODY,
  title: "",
  savedTitle: "",
  streaming: null,
  ...over,
});
const result = (over: Partial<ContinuityResult> = {}): ContinuityResult => ({
  messageId: "m1", check, dismissed: [], checkedVersion: "v1", ...over,
});

describe("这一章还差什么（写 / 核账 / 定稿 + 主按钮）", () => {
  it("还没写：主按钮写这一章", () => {
    const p = chapterProgress({ paper: paper({ body: "", savedBody: "" }), result: null, targetWords: 3000 });
    expect(p.write).toEqual({ done: false, text: "还没写" });
    expect(p.primary.kind).toBe("write");
    expect(p.statusLine).toBe("这一章还没写");
  });

  it("有稿没核：主按钮核账；字数比目标少照实说", () => {
    const p = chapterProgress({ paper: paper(), result: null, targetWords: 100 });
    expect(p.write.done).toBe(true);
    expect(p.write.text).toMatch(/比目标少/);
    expect(p.check).toMatchObject({ state: "none", done: false, text: "还没核" });
    expect(p.primary).toEqual({ kind: "continuity", label: "核账" });
    expect(p.statusLine).toBe("还没核账");
  });

  it("核出问题：主按钮「去看那 N 处」，顶卡和工具条数一致", () => {
    const p = chapterProgress({ paper: paper(), result: result(), targetWords: null });
    expect(p.check).toMatchObject({ state: "issues", done: true, sure: 2, maybe: 1, text: "有 2 处要你看，1 处可能" });
    expect(p.primary).toEqual({ kind: "show_issues", label: "去看那 2 处" });
    expect(p.statusLine).toBe("核过了：2 处对不上，1 处可能");
  });

  it("标了不是问题：不再算；模型引的原句不逐字（带……）也照算，不猜作者改没改", () => {
    const dismissed = chapterProgress({ paper: paper(), result: result({ dismissed: [continuityItemKey(wrongMarket)] }), targetWords: null });
    expect(dismissed.check.sure).toBe(1);
    const stitched = { ...wrongName, quote: "林舟骑车……老师傅" };
    const p = chapterProgress({ paper: paper(), result: result({ check: { ...check, sure: [stitched] } }), targetWords: null });
    expect(p.check.sure).toBe(1);
  });

  it("确定的都处理掉：主按钮定稿", () => {
    const p = chapterProgress({
      paper: paper(),
      result: result({ dismissed: [continuityItemKey(wrongMarket), continuityItemKey(wrongName)] }),
      targetWords: null,
    });
    expect(p.check.state).toBe("clean");
    expect(p.primary).toEqual({ kind: "commit", label: "定稿" });
    expect(p.statusLine).toBe("核过了：没有确定对不上的，1 处可能");
  });

  it("核过后稿子变了（版本变 / 还有没存的字）：再核一遍", () => {
    const moved = chapterProgress({ paper: paper({ baseVersion: "v2" }), result: result(), targetWords: null });
    expect(moved.check).toMatchObject({ state: "stale", done: false, text: "核过后改过稿" });
    expect(moved.primary).toEqual({ kind: "continuity", label: "再核一遍" });
    const dirty = chapterProgress({ paper: paper({ body: `${BODY}又写一句。` }), result: result(), targetWords: null });
    expect(dirty.check.state).toBe("stale");
  });

  it("老卡没记版本：不判「改过稿」", () => {
    const { checkedVersion: _drop, ...old } = result();
    const p = chapterProgress({ paper: paper({ baseVersion: "v9" }), result: old, targetWords: null });
    expect(p.check.state).toBe("issues");
  });

  it("已定稿：核账不再要求，主按钮写下一章；定稿后又改过照实说", () => {
    const done = chapterProgress({ paper: paper({ committed: { body: BODY } }), result: null, targetWords: null });
    expect(done.check).toMatchObject({ done: true, text: "—" });
    expect(done.commit).toEqual({ done: true, text: "已定稿" });
    expect(done.primary.kind).toBe("write_next");
    const edited = chapterProgress({ paper: paper({ committed: { body: "旧稿。" } }), result: null, targetWords: null });
    expect(edited.commit).toEqual({ done: false, text: "定稿后又改过" });
  });

  it("定稿前核出过问题、作者改完定了：定稿后不再标红催「有 N 处要你看」", () => {
    const done = chapterProgress({ paper: paper({ committed: { body: BODY } }), result: result(), targetWords: null });
    expect(done.check).toMatchObject({ state: "none", done: true, sure: 0, text: "定稿前核过" });
    expect(done.statusLine).toBe("已定稿");
  });

  it("已定稿、账没记上 / 没记全：主按钮「补记账」，状态照实说；没定稿时不管", () => {
    const pending = chapterProgress({ paper: paper({ committed: { body: BODY } }), result: null, targetWords: null, nextChapter: 13, ledger: "pending" });
    expect(pending.primary).toEqual({ kind: "fill", label: "补记账" });
    expect(pending.statusLine).toBe("正文定了，账还没记上");
    expect(pending.commit).toEqual({ done: true, text: "已定稿 · 账待记" });
    expect(pending.next).toBeUndefined();
    const partial = chapterProgress({ paper: paper({ committed: { body: BODY } }), result: null, targetWords: null, ledger: "partial" });
    expect(partial.statusLine).toBe("已定稿，账没记全");
    const drafting = chapterProgress({ paper: paper(), result: null, targetWords: null, ledger: "pending" });
    expect(drafting.primary.kind).toBe("continuity");
  });

  it("已定稿、知道后面第一个没定稿的章：主按钮「去第 N 章」（只换章不出稿）；没定稿时不带", () => {
    const done = chapterProgress({ paper: paper({ committed: { body: BODY } }), result: null, targetWords: null, nextChapter: 13 });
    expect(done.primary).toEqual({ kind: "open_next", label: "去第 13 章" });
    expect(done.next).toBe(13);
    const drafting = chapterProgress({ paper: paper(), result: null, targetWords: null, nextChapter: 13 });
    expect(drafting.next).toBeUndefined();
  });
});

describe("核账结果取当前会话里这一章最新那张卡", () => {
  const msg = (id: string, chapter: number, extra: object = {}): ChapterMessage => ({
    id, role: "assistant", content: "", cards: [{ type: "continuity", check: { ...check, chapter }, ...extra }],
  });

  it("取最新的、只认这一章", () => {
    const messages = [msg("a", 11), msg("b", 10), msg("c", 11, { dismissed: ["k"], checkedVersion: "v3" }), msg("d", 12)];
    expect(latestContinuityResult(messages, 11)).toMatchObject({ messageId: "c", dismissed: ["k"], checkedVersion: "v3" });
    expect(latestContinuityResult(messages, 9)).toBeNull();
  });
});

describe("核账卡之后定论改齐了：改掉的条目不再算", () => {
  const cross = { quote: "老码头在东边", earlierQuote: "位置：北岸", earlierChapter: 0, reason: "方位", fixChapter: 5, againstSetting: { label: "位置" } };
  const checkMsg: ChapterMessage = { id: "c", role: "assistant", content: "", cards: [{ type: "continuity", check: { ...check, sure: [wrongMarket, cross] } }] };
  /** 定论这次操作的卡（片 3C 起改齐的结果在操作卡上）：做完了、改了（applied）才算。 */
  const canonOp = (id: string, card: SettleCardData, result: { readonly applied?: boolean; readonly excluded?: readonly string[]; readonly state?: OperationCardData["state"] } = {}): ChapterMessage => ({
    id, role: "assistant", content: "", cards: [{
      type: "operation",
      op: {
        opId: "op-0123456789abcdef0123", kind: "canon.propose", what: "定论", state: result.state ?? "succeeded", stateText: "做完了", allowed: [], summary: "", eventSeq: 3,
        canon: { card, excluded: result.excluded ?? [], applied: result.applied ?? true },
      },
    }],
  });
  const harbor: SettleCardData = {
    canon: "老码头在北岸", canonExists: false, fields: [], facts: [], searched: [5], missed: [], failures: [],
    edits: [{ key: "e1", chapter: 5, draft: false, from: "老码头在东边，走过去二十分钟。", to: "老码头在北岸，走过去二十分钟。" }],
  };
  const settle = (id: string, extra: { readonly applied?: string; readonly excluded?: readonly string[] }): ChapterMessage =>
    extra.applied ? canonOp(id, harbor, { ...(extra.excluded ? { excluded: extra.excluded } : {}) }) : canonOp(id, harbor, { state: "waiting_author", applied: false });

  it("核账之后改齐的定论：那章被改的句子里有条目原句 = 改掉；没改齐 / 划掉 / 在核账之前的都不算", () => {
    const key = continuityItemKey(cross);
    expect(latestContinuityResult([checkMsg, settle("s", { applied: "改齐了。" })], 11)).toMatchObject({ settled: [key] });
    expect(settledContinuityByMessage([checkMsg, settle("s", { applied: "改齐了。" })]).get("c")).toEqual([key]);
    expect(latestContinuityResult([checkMsg, settle("s", {})], 11)?.settled).toBeUndefined();
    expect(latestContinuityResult([checkMsg, settle("s", { applied: "改齐了。", excluded: ["e1"] })], 11)?.settled).toBeUndefined();
    expect(settledContinuityByMessage([settle("s", { applied: "改齐了。" }), checkMsg]).size).toBe(0);
    const result = latestContinuityResult([checkMsg, settle("s", { applied: "改齐了。" })], 11)!;
    expect(openContinuityItems(result).sure).toEqual([wrongMarket]);
  });

  it("核账原句连着两句、定论只改了其中一句：也算改掉", () => {
    const twoSentences = { ...cross, quote: "老码头在东边，走过去二十分钟。他沿着河走。" };
    const msg: ChapterMessage = { id: "c", role: "assistant", content: "", cards: [{ type: "continuity", check: { ...check, sure: [twoSentences] } }] };
    expect(latestContinuityResult([msg, settle("s", { applied: "改齐了。" })], 11)?.settled).toEqual([continuityItemKey(twoSentences)]);
  });

  it("「以本章为准」点的那条（resolves）：另一边真改了才算——对设定的看设定栏改没改，对前文的看那章被改的句子", () => {
    const setting = { quote: "港务局按失踪结的案", earlierQuote: "官方以海难结案", earlierChapter: 0, reason: "结案", fixChapter: 1, againstSetting: { label: "故事设定" } };
    const msg: ChapterMessage = { id: "c", role: "assistant", content: "", cards: [{ type: "continuity", check: { ...check, sure: [setting, wrongMarket] } }] };
    const fieldSettle = (extra: { readonly excluded?: readonly string[] }): ChapterMessage => canonOp("s", {
      canon: "按失踪结案", canonExists: false, edits: [], facts: [], searched: [], missed: [], failures: [],
      fields: [{ key: "f1", label: "历史", from: "官方以海难结案", to: "港务局按失踪结案" }], resolves: continuityItemKey(setting),
    }, extra);
    expect(latestContinuityResult([msg, fieldSettle({})], 11)?.settled).toEqual([continuityItemKey(setting)]);
    expect(latestContinuityResult([msg, fieldSettle({ excluded: ["f1"] })], 11)?.settled).toBeUndefined();
    const chapterSettle = canonOp("s2", {
      canon: "东门菜场", canonExists: false, fields: [], facts: [], searched: [10], missed: [], failures: [],
      edits: [{ key: "e1", chapter: 10, draft: false, from: "约在南门菜场后街。", to: "约在东门菜场后街。" }], resolves: continuityItemKey(wrongMarket),
    });
    expect(latestContinuityResult([msg, chapterSettle], 11)?.settled).toEqual([continuityItemKey(wrongMarket)]);
  });
});

describe("chatStore：不是问题记在卡上", () => {
  afterEach(() => useChatStore.setState({ messages: [] }));

  it("记下 / 撤回，空了字段就去掉；只动这张卡，服务端带的版本留着", () => {
    useChatStore.setState({ messages: [
      { id: "m1", role: "assistant", content: "", cards: [{ type: "continuity", check, checkedVersion: "v7" }] },
      { id: "m2", role: "assistant", content: "", cards: [{ type: "continuity", check }] },
    ] });
    const store = useChatStore.getState();
    store.setContinuityDismissed("m1", "k1", true);
    store.setContinuityDismissed("m1", "k1", true);
    const card = () => useChatStore.getState().messages[0]!.cards![0]!;
    expect(card()).toMatchObject({ dismissed: ["k1"], checkedVersion: "v7" });
    expect(useChatStore.getState().messages[1]!.cards![0]).not.toHaveProperty("dismissed");
    useChatStore.getState().setContinuityDismissed("m1", "k1", false);
    expect(card()).not.toHaveProperty("dismissed");
  });
});
