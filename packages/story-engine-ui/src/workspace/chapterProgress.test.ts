import { afterEach, describe, expect, it } from "vitest";

import type { ChapterMessage, ContinuityCheckData, OperationCardData, SettleCardData } from "../type-defs/workspace.js";
import { useChatStore } from "../stores/chatStore.js";
import { EDIT_MAX_TEXT } from "../api/agentChatClient.js";
import { continuityFixGoal } from "../lib/continuity-fix.js";
import {
  continuityItemKey,
  fixedContinuityByMessage,
  fixInEffect,
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

describe("核账卡之后按核账改、改完再核一处不剩：改掉的条目不再算（真机 2026-11-06）", () => {
  const cross = { quote: "老码头在东边", earlierQuote: "位置：北岸", earlierChapter: 0, reason: "方位", fixChapter: 5, againstSetting: { label: "位置" } };
  const checkMsg: ChapterMessage = { id: "c", role: "assistant", content: "", cards: [{ type: "continuity", check: { ...check, sure: [wrongMarket, wrongName, cross] } }] };
  const CHANGES = [{ from: "她在门口站着。", to: "她在仓门口站住了。" }];
  const PAPER_AFTER = { chapter: 11, body: `${BODY}\n\n她在仓门口站住了。` };
  const fixOp = (id: string, fixed: OperationCardData["fixed"], state: OperationCardData["state"] = "succeeded"): ChapterMessage => ({
    id, role: "assistant", content: "", cards: [{
      type: "operation",
      op: {
        opId: "op-0123456789abcdef0124", kind: "draft.change", mode: "fix", what: "按核账改", state, stateText: "做完了", allowed: [], summary: "", eventSeq: 5,
        ...(fixed ? { fixed } : {}),
      },
    }],
  });

  /** 卡上按钮交的那句改法（和 continuityFixAction 同一份）。 */
  const goalOf = (item: typeof wrongName): string => continuityFixGoal(11, item).slice(0, EDIT_MAX_TEXT);
  const asked = (item: typeof wrongName) => ({ quote: ` ${item.quote} `, goal: goalOf(item) });

  it("这一章、错在这一章、就是点了改掉的那条 = 改掉（原句还在稿里也算：改在别处的）；错在前文那章的、别的章、没做完、在核账之前的都不算", () => {
    const fixed = { chapter: 11, items: [asked(wrongName)], changes: CHANGES };
    expect(latestContinuityResult([checkMsg, fixOp("f", fixed)], 11, PAPER_AFTER)?.settled).toEqual([continuityItemKey(wrongName)]);
    // 对话栏那份不看稿纸：按核账改的另给（条目键 + 那次改的几句），核账卡自己拿稿纸看。
    expect(settledContinuityByMessage([checkMsg, fixOp("f", fixed)]).size).toBe(0);
    expect(fixedContinuityByMessage([checkMsg, fixOp("f", fixed)]).get("c")).toEqual([{ key: continuityItemKey(wrongName), changes: CHANGES }]);
    expect(fixedContinuityByMessage([fixOp("f", fixed), checkMsg]).size).toBe(0);
    expect(openContinuityItems(latestContinuityResult([checkMsg, fixOp("f", fixed)], 11, PAPER_AFTER)!).sure).toEqual([wrongMarket, cross]);
    // 错在第 5 章的那条：原句、改法一样也不算（本章这次改不到它）。
    expect(latestContinuityResult([checkMsg, fixOp("f", { ...fixed, items: [{ quote: cross.quote, goal: continuityFixGoal(11, cross) }] })], 11, PAPER_AFTER)?.settled).toBeUndefined();
    expect(latestContinuityResult([checkMsg, fixOp("f", { ...fixed, chapter: 12 })], 11, PAPER_AFTER)?.settled).toBeUndefined();
    expect(latestContinuityResult([checkMsg, fixOp("f", fixed, "running")], 11, PAPER_AFTER)?.settled).toBeUndefined();
    expect(latestContinuityResult([checkMsg, fixOp("f", undefined)], 11, PAPER_AFTER)?.settled).toBeUndefined();
  });

  it("同一句报了两件事、只点了一件：只划点了的那件（外部审查 2026-11-06）", () => {
    const keyIssue = { ...wrongName, earlierQuote: "钥匙在他口袋里。", reason: "钥匙对不上" };
    const both: ChapterMessage = { id: "c", role: "assistant", content: "", cards: [{ type: "continuity", check: { ...check, sure: [wrongName, keyIssue] } }] };
    const fixed = { chapter: 11, items: [asked(wrongName)], changes: CHANGES };
    expect(latestContinuityResult([both, fixOp("f", fixed)], 11, PAPER_AFTER)?.settled).toEqual([continuityItemKey(wrongName)]);
    // 模型在对话里交的改法（不是卡上那句）：认不出是哪条，不划。
    expect(latestContinuityResult([both, fixOp("f", { ...fixed, items: [{ quote: wrongName.quote, goal: "把姓改成吴" }] })], 11, PAPER_AFTER)?.settled).toBeUndefined();
  });

  it("第二轮按再核报的改的：原句 + 前文原句一字不差的那条也划（作者没点、第二轮改在别处改掉的，外部审查 2026-11-06）", () => {
    const fixed = { chapter: 11, items: [asked(wrongMarket), { quote: wrongName.quote, earlierQuote: ` ${wrongName.earlierQuote}` }], changes: CHANGES };
    expect(latestContinuityResult([checkMsg, fixOp("f", fixed)], 11, PAPER_AFTER)?.settled).toEqual([continuityItemKey(wrongMarket), continuityItemKey(wrongName)]);
    const other = { chapter: 11, items: [{ quote: wrongName.quote, earlierQuote: "摊主姓李。" }], changes: CHANGES };
    expect(latestContinuityResult([checkMsg, fixOp("f", other)], 11, PAPER_AFTER)?.settled).toBeUndefined();
  });

  it("那次改的不在稿里了（撤销了、作者又改了）、稿纸没开这一章：照旧摆出来，不划错", () => {
    const fixed = { chapter: 11, items: [asked(wrongName)], changes: CHANGES };
    // 撤销回到改前：改前那句回来了、改出来的那句不在了。
    expect(latestContinuityResult([checkMsg, fixOp("f", fixed)], 11, { chapter: 11, body: `${BODY}\n\n她在门口站着。` })?.settled).toBeUndefined();
    expect(latestContinuityResult([checkMsg, fixOp("f", fixed)], 11)?.settled).toBeUndefined();
    expect(latestContinuityResult([checkMsg, fixOp("f", fixed)], 11, { chapter: 12, body: PAPER_AFTER.body })?.settled).toBeUndefined();
    expect(fixInEffect(CHANGES, `${BODY}\n\n她在门口站着。`)).toBe(false);
    expect(fixInEffect(CHANGES, PAPER_AFTER.body)).toBe(true);
    // 改出来那句本来别处就有：撤销后改前那句回来了，照样不算（外部审查 2026-11-06）。
    expect(fixInEffect(CHANGES, `她在仓门口站住了。${BODY}\n\n她在门口站着。`)).toBe(false);
    // 两轮改回原样的那条（改前改后一样）不算一处改动；全是这种就不算改了。
    expect(fixInEffect([...CHANGES, { from: "天黑了。", to: "天黑了。" }], PAPER_AFTER.body)).toBe(true);
    expect(fixInEffect([{ from: "天黑了。", to: "天黑了。" }], "天黑了。")).toBe(false);
    // 删掉的句子：删了的还在稿里 = 撤销了。
    const deleted = { ...fixed, changes: [{ from: "她在门口站着。", to: "" }] };
    expect(latestContinuityResult([checkMsg, fixOp("f", deleted)], 11, { chapter: 11, body: BODY })?.settled).toEqual([continuityItemKey(wrongName)]);
    expect(latestContinuityResult([checkMsg, fixOp("f", deleted)], 11, { chapter: 11, body: `${BODY}她在门口站着。` })?.settled).toBeUndefined();
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
