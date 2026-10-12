// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildThreadTrackingPlan, verifyChapterDelta, type ChapterDeltaDeclaration } from "@actalk/story-engine";

/**
 * R2.2 任务第 2 项的确认测试（2026-10-12）：「第 1 章去重——同一章新开的线索里引同一句原文的只留一条」。
 * 引擎早有 sameEvidence 批内去重（lead-intent-tracking.ts），记账员路的声明走的是同一段引擎代码
 * （declaration → verifyChapterDelta → buildThreadTrackingPlan），这里从记账员形状的声明起把整条链路
 * 走一遍钉住这个行为：两条新线索引同一句原文，只落一条。纯假数据、不打网络。
 */
describe("同一章新开线索引同一句原文的去重（引擎 sameEvidence 对记账员这条路生效）", () => {
  it("记账员形声明里两条新线索引同一句原文 → verifyChapterDelta + buildThreadTrackingPlan 只落一条", () => {
    const draft = "仓库的门锁着。墙角有一只木箱，箱子上落满了灰。他蹲下来看那只木箱，箱盖上的铜扣已经生锈。";
    // 记账员路产出的声明就是 ChapterDeltaDeclaration（T2：输出结构与旧声明完全一样），下游与旧路共用同一段引擎代码。
    const declaration: ChapterDeltaDeclaration = {
      chapter: 1,
      mainEvent: { summary: "他查看了仓库里的木箱", quote: "墙角有一只木箱，箱子上落满了灰。" },
      seededForeshadowing: [
        { summary: "木箱里装的是什么", quote: "墙角有一只木箱，箱子上落满了灰。" },
        { summary: "为什么木箱锁在这里", quote: "墙角有一只木箱，箱子上落满了灰。" },
      ],
      resolvedForeshadowing: [],
      resourceDeltas: [],
      keyLeads: [],
      pendingIntents: [],
      charactersPresent: [],
      arcGoalProgress: [],
    };
    const verified = verifyChapterDelta(declaration, draft);
    expect(verified.seededForeshadowing).toHaveLength(2); // 证据都属实，两条都过了校验
    const plan = buildThreadTrackingPlan({
      chapter: 1,
      draft,
      semanticSummary: {
        chapter: 1,
        chapterTitle: "",
        mainEvent: "查看木箱",
        mentionedHooks: [],
        mentionedCharacters: [],
        mentionedCharacterNames: [],
        locations: [],
      },
      threadPool: { threads: [] },
      verifiedDelta: verified,
    });
    const newLeads = plan.updates.filter((update) => update.type === "lead");
    expect(newLeads).toHaveLength(1); // sameEvidence 批内去重：引同一句原文的只留一条
  });
});
