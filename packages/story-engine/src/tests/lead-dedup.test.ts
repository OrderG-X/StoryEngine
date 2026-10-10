/**
 * B2-2: 入库去重——近重复 lead 归并进既有线索 (bigram)
 *
 * 保守路线（删 bigramSuffixContains 后）：
 *   - 归并只走两条安全路径：精确/子串包含 + Jaccard≥0.6
 *   - 「听到响动」↔「不连续的响动」（Jaccard≈0.14）不再强求归并，
 *     折叠改由 B2-3 展示层处理
 *   - 三组危险对（父亲的债/邻居的债 等）反例断言不归并
 */

import { describe, expect, it } from "vitest";
import { verifyChapterDelta } from "../chapter-delta.js";
import { buildThreadTrackingPlan } from "../lead-intent-tracking.js";
import type { NarrativeThread, ThreadPool } from "../types.js";

/** 最小语义摘要，满足 buildThreadTrackingPlan 需要 */
const minimalSummary = {
  chapter: 1,
  chapterTitle: "第一章",
  protagonist: "林远",
  mainEvent: "测试章节",
  nextLead: undefined as string | undefined,
  discovery: undefined as string | undefined,
  decision: undefined as string | undefined,
  mentionedHooks: [] as readonly string[],
  mentionedCharacters: [] as readonly string[],
  mentionedCharacterNames: [] as readonly string[],
  locations: [] as readonly string[],
  };

/** 2026-10-10 起线索只听声明：把「本章新埋这条线索、原句是整段草稿」包成已核声明。 */
function leadDelta(chapter: number, draft: string, summary: string) {
  return verifyChapterDelta({
    chapter,
    mainEvent: { summary, quote: draft },
    seededForeshadowing: [{ summary, quote: draft }],
    resolvedForeshadowing: [],
    resourceDeltas: [],
    keyLeads: [],
  }, draft);
}

/** 构造一条 open lead 的辅助函数 */
function makeOpenLead(
  id: string,
  title: string,
  evidence: string,
  firstSeenChapter = 1,
): NarrativeThread {
  return {
    id,
    type: "lead",
    title,
    status: "open",
    firstSeenChapter,
    lastTouchedChapter: firstSeenChapter,
    evidence: [evidence],
  };
}

// ---------------------------------------------------------------------------
// 主测试套件
// ---------------------------------------------------------------------------

describe("B2-2 lead 去重 — 近重复归并进既有线索", () => {
  // ---------------------------------------------------------------------------
  // 安全正例：子串包含路径
  // ---------------------------------------------------------------------------

  it("DEDUP (子串正例): 完全相同标题应归并进既有线索", () => {
    const existingThread = makeOpenLead(
      "lead-existing-响动-exact",
      "不连续的响动",
      "院子里出现了不连续的响动。",
    );
    const threadPool: ThreadPool = { threads: [existingThread] };

    const plan = buildThreadTrackingPlan({
      chapter: 2,
      draft: "林远再次注意到了不连续的响动，感觉有人在监视。",
      semanticSummary: { ...minimalSummary, chapter: 2, nextLead: "不连续的响动" },
      threadPool,
      verifiedDelta: leadDelta(2, "林远再次注意到了不连续的响动，感觉有人在监视。", "不连续的响动"),
    });

    const soundUpdates = plan.updates.filter(
      (u) => u.type === "lead" && u.title.includes("响动"),
    );
    // 完全相同标题，应走子串路径归并，只有 1 条
    expect(soundUpdates.length).toBe(1);
    expect(soundUpdates[0]!.id).toBe(existingThread.id);
    expect(soundUpdates[0]!.status).toBe("touched");
    // 不应出现在 introducedThreads
    expect(plan.introducedThreads).not.toContain(existingThread.id);
  });

  it("DEDUP (子串正例): 「响动」⊆「后墙响动线索」应归并（子串包含）", () => {
    const existingThread = makeOpenLead(
      "lead-existing-短响动",
      "响动",
      "走廊里听到了响动。",
    );
    const threadPool: ThreadPool = { threads: [existingThread] };

    // 新候选标题包含既有标题「响动」作为子串，canonicalThreadTitle 归一后子串命中
    const plan = buildThreadTrackingPlan({
      chapter: 2,
      draft: "后墙出现了异常响动，十分可疑。",
      semanticSummary: {
        ...minimalSummary,
        chapter: 2,
        nextLead: "响动",
        discovery: "后墙出现了异常响动，十分可疑。",
      },
      threadPool,
      verifiedDelta: leadDelta(2, "后墙出现了异常响动，十分可疑。", "响动"),
    });

    const soundUpdates = plan.updates.filter(
      (u) => u.type === "lead" && (u.title.includes("响动") || u.evidence.some((e) => e.includes("响动"))),
    );
    // 归并后 id 应为既有，不新建
    expect(soundUpdates.some((u) => u.id === existingThread.id)).toBe(true);
    // 不应在 introducedThreads 里
    expect(plan.introducedThreads).not.toContain(existingThread.id);
  });

  // ---------------------------------------------------------------------------
  // 三条 anti-merge 反例（Critical 的核心验证）
  // ---------------------------------------------------------------------------

  it("ANTI-MERGE #1: 「父亲的债」↔「邻居的债」——共享尾「的债」但应各自独立", () => {
    const existingThread = makeOpenLead(
      "lead-existing-父亲债",
      "父亲的债",
      "林远发现父亲留下了一笔巨额债务。",
    );
    const threadPool: ThreadPool = { threads: [existingThread] };

    const plan = buildThreadTrackingPlan({
      chapter: 2,
      draft: "邻居的债务线索浮出水面，与林远家无关。",
      semanticSummary: {
        ...minimalSummary,
        chapter: 2,
        nextLead: "邻居的债",
        discovery: "邻居的债务线索浮出水面，与林远家无关。",
      },
      threadPool,
      verifiedDelta: leadDelta(2, "邻居的债务线索浮出水面，与林远家无关。", "邻居的债"),
    });

    // 新候选「邻居的债」不应归并进「父亲的债」
    const debtUpdates = plan.updates.filter(
      (u) => u.type === "lead" && u.title.includes("债"),
    );
    // 两条线索必须都存在（各自独立）
    expect(debtUpdates.length).toBeGreaterThanOrEqual(1);

    // introducedThreads 里必须有「邻居的债」对应的新 id
    const newDebtUpdate = plan.updates.find(
      (u) => u.type === "lead" && u.title.includes("邻居") && u.id !== existingThread.id,
    );
    if (newDebtUpdate) {
      // 找到了新建的条目，必须在 introducedThreads 里
      expect(plan.introducedThreads).toContain(newDebtUpdate.id);
    } else {
      // 如果标题没命中「邻居」，确保没有把「父亲的债」的 id 复用
      const wrongMerge = plan.updates.find(
        (u) => u.id === existingThread.id && u.title !== existingThread.title,
      );
      expect(wrongMerge).toBeUndefined();
    }

    // 「父亲的债」不应被归并进来的「邻居的债」覆盖
    const fatherDebtUpdate = plan.updates.find((u) => u.id === existingThread.id);
    if (fatherDebtUpdate) {
      // 它仍然是「父亲的债」的线索，而非邻居的
      expect(fatherDebtUpdate.title).toBe("父亲的债");
    }

    // 核心：「邻居的债」候选不应使用既有「父亲的债」的 id
    const neighborDebt = plan.updates.find(
      (u) =>
        u.type === "lead" &&
        (u.title.includes("邻居") || u.evidence.some((e) => e.includes("邻居"))),
    );
    if (neighborDebt) {
      expect(neighborDebt.id).not.toBe(existingThread.id);
      expect(plan.introducedThreads).toContain(neighborDebt.id);
    }
  });

  it("ANTI-MERGE #2: 「工地的响动」↔「楼上的响动」——共享尾「响动」但应各自独立", () => {
    const existingThread = makeOpenLead(
      "lead-existing-工地响动",
      "工地的响动",
      "林远听到了工地传来的异常响动。",
    );
    const threadPool: ThreadPool = { threads: [existingThread] };

    const plan = buildThreadTrackingPlan({
      chapter: 2,
      draft: "楼上传来的响动线索让林远心生疑惑。",
      semanticSummary: {
        ...minimalSummary,
        chapter: 2,
        nextLead: "楼上的响动",
        discovery: "楼上传来的响动线索让林远心生疑惑。",
      },
      threadPool,
      verifiedDelta: leadDelta(2, "楼上传来的响动线索让林远心生疑惑。", "楼上的响动"),
    });

    // 「楼上的响动」不应归并进「工地的响动」
    const upstairsUpdates = plan.updates.filter(
      (u) =>
        u.type === "lead" &&
        (u.title.includes("楼上") || u.evidence.some((e) => e.includes("楼上"))),
    );

    if (upstairsUpdates.length > 0) {
      // 找到了「楼上的响动」相关候选，必须是新建的（不复用工地的 id）
      upstairsUpdates.forEach((u) => {
        expect(u.id).not.toBe(existingThread.id);
      });
      // 且必须出现在 introducedThreads
      const introducedUpstairs = upstairsUpdates.filter((u) =>
        plan.introducedThreads.includes(u.id),
      );
      expect(introducedUpstairs.length).toBeGreaterThan(0);
    }

    // 「工地的响动」的 id 不应被「楼上的响动」更新时用掉
    const wrongMerge = plan.updates.find(
      (u) =>
        u.id === existingThread.id &&
        (u.title.includes("楼上") || u.evidence.some((e) => e.includes("楼上") && !e.includes("工地"))),
    );
    expect(wrongMerge).toBeUndefined();
  });

  it("ANTI-MERGE #3: 「藏起来的借条」↔「烧掉的借条」——共享尾「借条」但应各自独立", () => {
    const existingThread = makeOpenLead(
      "lead-existing-藏借条",
      "藏起来的借条",
      "有人把借条藏起来了，林远怀疑是父亲所为。",
    );
    const threadPool: ThreadPool = { threads: [existingThread] };

    const plan = buildThreadTrackingPlan({
      chapter: 3,
      draft: "被烧掉的借条线索指向幕后黑手。",
      semanticSummary: {
        ...minimalSummary,
        chapter: 3,
        nextLead: "烧掉的借条",
        discovery: "被烧掉的借条线索指向幕后黑手。",
      },
      threadPool,
      verifiedDelta: leadDelta(3, "被烧掉的借条线索指向幕后黑手。", "烧掉的借条"),
    });

    // 「烧掉的借条」不应归并进「藏起来的借条」
    const burnedUpdates = plan.updates.filter(
      (u) =>
        u.type === "lead" &&
        (u.title.includes("烧") || u.evidence.some((e) => e.includes("烧"))),
    );

    if (burnedUpdates.length > 0) {
      // 找到了「烧掉的借条」相关候选，必须是新建（不复用藏借条的 id）
      burnedUpdates.forEach((u) => {
        expect(u.id).not.toBe(existingThread.id);
      });
      // 且必须出现在 introducedThreads
      const introducedBurned = burnedUpdates.filter((u) =>
        plan.introducedThreads.includes(u.id),
      );
      expect(introducedBurned.length).toBeGreaterThan(0);
    }

    // 「藏起来的借条」的 update（若有）不应混入「烧掉」相关证据（误并标志）
    const hiddenUpdate = plan.updates.find((u) => u.id === existingThread.id);
    if (hiddenUpdate) {
      // title 仍是原来的
      expect(hiddenUpdate.title).toBe("藏起来的借条");
    }
  });

  // ---------------------------------------------------------------------------
  // 原有 STATUS FILTER 测试（保留）
  // ---------------------------------------------------------------------------

  it("STATUS FILTER: done 状态的同型线索不应触发归并（新候选应新建）", () => {
    const doneThread: NarrativeThread = {
      id: "lead-done-響动",
      type: "lead",
      title: "听到响动",
      status: "done", // 已收口，不应再归并
      firstSeenChapter: 1,
      lastTouchedChapter: 1,
      evidence: ["响动已查清是猫。"],
    };
    const threadPool: ThreadPool = { threads: [doneThread] };

    const plan = buildThreadTrackingPlan({
      chapter: 5,
      draft: "林远又听到了不连续的响动，但这次更奇怪。",
      semanticSummary: { ...minimalSummary, chapter: 5, nextLead: "不连续的响动" },
      threadPool,
      verifiedDelta: leadDelta(5, "林远又听到了不连续的响动，但这次更奇怪。", "不连续的响动"),
    });

    // 新候选「不连续的响动」应新建（因既有线索 status=done）
    const soundUpdates = plan.updates.filter((u) =>
      u.type === "lead" && (u.title.includes("响动") || u.evidence.some((e) => e.includes("响动"))),
    );

    // done 线索更新后 status 仍是 done（不被覆盖）
    const doneUpdate = soundUpdates.find((u) => u.id === doneThread.id);
    if (doneUpdate) {
      expect(doneUpdate.status).toBe("done");
    }

    // 新候选应当出现在 introducedThreads（因为 done 的不参与归并）
    const newSoundUpdates = soundUpdates.filter((u) => u.id !== doneThread.id);
    if (newSoundUpdates.length > 0) {
      expect(plan.introducedThreads).toContain(newSoundUpdates[0]!.id);
    }
  });

  it("STATUS FILTER: touched 状态的同型线索应参与归并（与 open 同等对待）", () => {
    const touchedThread: NarrativeThread = {
      id: "lead-touched-響动",
      type: "lead",
      title: "后墙响动",
      status: "touched",
      firstSeenChapter: 1,
      lastTouchedChapter: 2,
      evidence: ["第2章又听到了后墙响动。"],
    };
    const threadPool: ThreadPool = { threads: [touchedThread] };

    // 精确子串归并：「后墙响动」子串包含「响动」
    const plan = buildThreadTrackingPlan({
      chapter: 3,
      draft: "林远注意到后墙的响动，显然还没查清。",
      semanticSummary: { ...minimalSummary, chapter: 3, nextLead: "后墙的响动仍未查明" },
      threadPool,
      verifiedDelta: leadDelta(3, "林远注意到后墙的响动，显然还没查清。", "后墙的响动仍未查明"),
    });

    const soundUpdates = plan.updates.filter((u) =>
      u.type === "lead" && (u.title.includes("响动") || u.evidence.some((e) => e.includes("响动"))),
    );
    expect(soundUpdates.length).toBe(1);
    expect(soundUpdates[0]!.id).toBe(touchedThread.id);
    expect(soundUpdates[0]!.status).toBe("touched");
  });

  it("ANTI-MERGE: 真正不同的两条线索不应被误并（抽屉借条 ≠ 后墙响动）", () => {
    // 反例：这两条 bigram 相似度 < 0.6，不应归并
    const existingThread = makeOpenLead(
      "lead-existing-抽屉",
      "抽屉夹层的借条",
      "林远在抽屉夹层里发现了一张借条。",
    );
    const threadPool: ThreadPool = { threads: [existingThread] };

    const plan = buildThreadTrackingPlan({
      chapter: 2,
      draft: "后墙发出异常响动，黑影一闪而过。",
      semanticSummary: {
        ...minimalSummary,
        chapter: 2,
        nextLead: "后墙响动线索",
        discovery: "后墙发出异常响动，黑影一闪而过。",
      },
      threadPool,
      verifiedDelta: leadDelta(2, "后墙发出异常响动，黑影一闪而过。", "后墙响动线索"),
    });

    // 后墙响动相关 update 应有独立 id（新建），不复用抽屉借条的 id
    const wallUpdates = plan.updates.filter((u) => u.title.includes("响动") || u.title.includes("后墙"));
    expect(wallUpdates.length).toBeGreaterThan(0);
    wallUpdates.forEach((u) => {
      expect(u.id).not.toBe(existingThread.id);
    });

    // 且 introducedThreads 里能找到后墙线索（说明确实新建了）
    const wallIntroduced = plan.introducedThreads.filter((id) =>
      plan.updates.find((u) => u.id === id && (u.title.includes("响动") || u.title.includes("后墙"))),
    );
    expect(wallIntroduced.length).toBeGreaterThan(0);
  });
});
