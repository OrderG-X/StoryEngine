import { afterEach, describe, expect, it } from "vitest";

import type { ChapterMessage, ContinuityCheckData, OperationCardData, SettleCardData } from "../type-defs/workspace.js";
import { useChatStore } from "../stores/chatStore.js";
import {
  continuityItemKey,
  latestContinuityResult,
  openContinuityItems,
  paperAction,
  settledContinuityByMessage,
  type ContinuityResult,
} from "./chapterProgress.js";

const BODY = "第二天下午，林舟骑车去了东门菜场。\n\n摊主是个姓王的老师傅。";
const wrongMarket = { quote: "林舟骑车去了东门菜场。", earlierQuote: "约在南门菜场后街。", earlierChapter: 10, reason: "菜场对不上" };
const wrongName = { quote: "摊主是个姓王的老师傅。", earlierQuote: "摊主姓吴。", earlierChapter: 10, reason: "姓对不上" };
const maybeOne = { quote: "第二天下午", earlierQuote: "次日上午", earlierChapter: 10, reason: "时间可能对不上" };
const check: ContinuityCheckData = { chapter: 11, sure: [wrongMarket, wrongName], maybe: [maybeOne] };

const result = (over: Partial<ContinuityResult> = {}): ContinuityResult => ({
  messageId: "m1", check, dismissed: [], checkedVersion: "v1", ...over,
});

describe("稿纸底下那一个按钮（安静账房：只留「定稿」）", () => {
  it("没写没有；写了没定稿、定稿后又改过是「定稿」；已定稿没有，账没记上 / 没记全是「补记账」", () => {
    expect(paperAction({ paper: { body: "", committed: null } })).toBeUndefined();
    expect(paperAction({ paper: { body: BODY, committed: null } })).toEqual({ button: "commit", label: "定稿" });
    expect(paperAction({ paper: { body: `${BODY}又写一句。`, committed: { body: BODY } } })).toEqual({ button: "commit", label: "定稿" });
    expect(paperAction({ paper: { body: BODY, committed: { body: BODY } } })).toBeUndefined();
    expect(paperAction({ paper: { body: BODY, committed: { body: BODY } }, ledger: "pending" })).toEqual({ button: "fill", label: "补记账" });
    expect(paperAction({ paper: { body: BODY, committed: { body: BODY } }, ledger: "partial" })).toEqual({ button: "fill", label: "补记账" });
    // 没定稿时账的状况不管。
    expect(paperAction({ paper: { body: BODY, committed: null }, ledger: "pending" })).toEqual({ button: "commit", label: "定稿" });
  });
});

describe("还要作者看的条目", () => {
  it("标了不是问题：不再算；模型引的原句不逐字（带……）也照算，不猜作者改没改", () => {
    expect(openContinuityItems(result()).sure).toHaveLength(2);
    expect(openContinuityItems(result({ dismissed: [continuityItemKey(wrongMarket)] })).sure).toEqual([wrongName]);
    const stitched = { ...wrongName, quote: "林舟骑车……老师傅" };
    expect(openContinuityItems(result({ check: { ...check, sure: [stitched] } })).sure).toEqual([stitched]);
    expect(openContinuityItems(result()).maybe).toEqual([maybeOne]);
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
