import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCommitPlanFromProject, extractChapterSemanticSummary } from "../commit-plan-builder.js";
import { createStoryProject, toSafeCharacterId } from "../project-store.js";
import type { ChapterDeltaDeclaration } from "../chapter-delta.js";
import type { CharacterProfile, HookItem } from "../types.js";

describe("commit plan semantic summary", () => {
  it("extracts chapter semantics and writes them into timeline effects", async () => {
    const projectDir = await createFixtureProject();
    await seedHookPool(projectDir);
    await writeDraft(projectDir, 1, semanticDraft());

    const result = await buildCommitPlanFromProject({ projectDir, chapter: 1 });

    expect(result.passed).toBe(true);
    const protagonistId = toSafeCharacterId("林远");
    expect(result.semanticSummary).toMatchObject({
      chapter: 1,
      protagonist: "林远",
      chapterSummary: expect.stringContaining("林远"),
      participants: expect.arrayContaining(["林远", "管事", "同门"]),
      keyEvents: expect.arrayContaining([
        expect.stringContaining("克扣"),
        expect.stringContaining("账目"),
      ]),
      foreshadowingTerms: expect.arrayContaining(["账目", "破损信物", "后墙异常响动"]),
      timelineSummary: expect.stringContaining("林远"),
      mainEvent: expect.stringContaining("克扣"),
      conflict: expect.stringContaining("克扣"),
      discovery: expect.stringContaining("账目"),
      decision: expect.stringContaining("决定"),
      gained: "林远得到半枚破损信物",
      lost: "被扣掉了本该领到的粮米。",
      nextLead: expect.stringContaining("线索"),
      mentionedHooks: ["h-ledger"],
      mentionedCharacters: [protagonistId],
      mentionedCharacterNames: ["林远"],
      locations: expect.arrayContaining(["外院", "园圃", "账房", "库房"]),
    });
    expect(result.semanticSummary?.mainEvent).not.toBe("第 1 章草稿被提交为正式章节。");
    expect(result.semanticSummary?.mainEvent).not.toBe(result.semanticSummary?.decision);
    expect(result.semanticSummary?.decision).not.toBe(result.semanticSummary?.nextLead);
    expect(result.semanticSummary?.gained).not.toBe(result.semanticSummary?.lost);
    expect(result.commitPlan?.timelineEvents?.[0]).toMatchObject({
      summary: result.semanticSummary?.timelineSummary,
      participants: [protagonistId],
      effects: {
        semanticSummary: result.semanticSummary,
      },
    });
    expect(result.commitPlan?.timelineEvents?.[0]?.effects?.semanticSummary).toMatchObject({
      mentionedCharacterNames: ["林远"],
      locations: expect.arrayContaining(["园圃", "库房", "账房"]),
    });
    // P2：currentPhase 水印已移除（自动路径无阶段证据，保留作者既有设定）
    expect(result.commitPlan?.worldUpdates).toMatchObject({
      activeHooks: expect.arrayContaining(["h-ledger"]),
      activeConflicts: [expect.stringContaining("克扣")],
    });
    expect(result.commitPlan?.characterUpdates?.[0]).toMatchObject({
      characterId: protagonistId,
      emotion: "警觉",
      goal: expect.stringContaining("查清账册来源"),
    });
  });

  // 阶段 2·① 向后兼容：不传 declaration 时，走完整旧正则路径（本用例作为下面「传声明」用例的对照锚点）。
  it("不传 declaration：mainEvent/timelineSummary 完全由正则抽取（旧行为基线）", async () => {
    const projectDir = await createFixtureProject();
    await seedHookPool(projectDir);
    await writeDraft(projectDir, 1, semanticDraft());

    const result = await buildCommitPlanFromProject({ projectDir, chapter: 1 });

    expect(result.passed).toBe(true);
    // 旧行为：mainEvent 来自正则选句（含"克扣"核心事件），不等于任何声明摘要
    expect(result.semanticSummary?.mainEvent).toContain("克扣");
    expect(result.issues.some((issue) => issue.includes("章节语义声明"))).toBe(false);
  });

  // 阶段 2·② 传合法声明（证据逐字命中）：mainEvent 与 timelineSummary 都用声明的干净摘要，无 issues。
  it("传证据命中的 declaration：mainEvent=timelineSummary=声明干净摘要、无 rejected issues", async () => {
    const projectDir = await createFixtureProject();
    await seedHookPool(projectDir);
    await writeDraft(projectDir, 1, semanticDraft());

    const declaration: ChapterDeltaDeclaration = {
      chapter: 1,
      mainEvent: {
        summary: "林远发现管事暗中克扣外院资源的账目",
        quote: "他发现账房角落里藏着一本账目，意识到组织管事暗中克扣外院资源。",
      },
      seededForeshadowing: [],
      resolvedForeshadowing: [],
      resourceDeltas: [],
      keyLeads: [],
    };

    const result = await buildCommitPlanFromProject({ projectDir, chapter: 1, declaration });

    expect(result.passed).toBe(true);
    // 逐字段优先声明：mainEvent 用声明的干净摘要（不再是正则从正文猜的句子）
    expect(result.semanticSummary?.mainEvent).toBe("林远发现管事暗中克扣外院资源的账目");
    // timelineSummary 也用声明的干净摘要（= mainEvent），不再用模型引用的原文证据句
    expect(result.semanticSummary?.timelineSummary).toBe("林远发现管事暗中克扣外院资源的账目");
    // 证据全部命中 → 无声明被拒
    expect(result.issues.some((issue) => issue.includes("章节语义声明被拒"))).toBe(false);
  });

  // Codex 10 章 E2E·P2 回归：mainEvent 已干净，但 timelineSummary 被模型引用的局部碎片证据句抢占
  // （真机 ch2 mainEvent 摘要干净、quote="坑是空的。"，时间线面板显示成碎片）。
  // 修后：有声明时 timelineSummary 用干净摘要，绝不落回碎片证据句。
  it("声明证据句是局部碎片时：timelineSummary 仍用干净摘要、不落回碎片（Codex P2）", async () => {
    const projectDir = await createFixtureProject();
    await seedHookPool(projectDir);
    await writeDraft(projectDir, 3, [
      "# 第三章",
      "",
      "叶青衡摸黑绕到废塔墙根下的藏丹坑，蹲下身伸手往里探。",
      "坑是空的。",
      "他心里一沉，转身时被沈砚拦住，沉声警告他别再追查师父的事。",
    ].join("\n"));

    const declaration: ChapterDeltaDeclaration = {
      chapter: 3,
      mainEvent: {
        summary: "叶青衡发现废塔藏丹坑已空，被沈砚警告不要再追查",
        quote: "坑是空的。",
      },
      seededForeshadowing: [],
      resolvedForeshadowing: [],
      resourceDeltas: [],
      keyLeads: [],
    };

    const result = await buildCommitPlanFromProject({ projectDir, chapter: 3, declaration });

    expect(result.passed).toBe(true);
    expect(result.semanticSummary?.mainEvent).toBe("叶青衡发现废塔藏丹坑已空，被沈砚警告不要再追查");
    // 关键：timelineSummary 不再是碎片证据句「坑是空的。」，而是干净摘要
    expect(result.semanticSummary?.timelineSummary).toBe("叶青衡发现废塔藏丹坑已空，被沈砚警告不要再追查");
    expect(result.semanticSummary?.timelineSummary).not.toBe("坑是空的。");
    // 落盘时间线事件的 summary 也不该是碎片（面板 L1/L2 展示读的是它）
    expect(result.commitPlan?.timelineEvents?.[0]?.summary).not.toBe("坑是空的。");
  });

  // 阶段 2·③ 传 evidence 对不上的声明：该条被拒 → 逐字段回退正则 + issues 诚实记录（绝不静默）。
  it("传证据对不上的 declaration：mainEvent 回退正则 + issues 记录被拒条目", async () => {
    const projectDir = await createFixtureProject();
    await seedHookPool(projectDir);
    await writeDraft(projectDir, 1, semanticDraft());

    // 对照：同一草稿、不传声明时的正则 mainEvent
    const baseline = await buildCommitPlanFromProject({ projectDir, chapter: 1 });

    const declaration: ChapterDeltaDeclaration = {
      chapter: 1,
      mainEvent: { summary: "凭空捏造的大事", quote: "他一剑劈开了整座大门。" },
      seededForeshadowing: [],
      resolvedForeshadowing: [],
      resourceDeltas: [],
      keyLeads: [],
    };

    const result = await buildCommitPlanFromProject({ projectDir, chapter: 1, declaration });

    expect(result.passed).toBe(true);
    // 证据对不上 → mainEvent 逐字段回退到正则结果（与不传声明时一致）
    expect(result.semanticSummary?.mainEvent).toBe(baseline.semanticSummary?.mainEvent);
    expect(result.semanticSummary?.mainEvent).not.toBe("凭空捏造的大事");
    // 被拒条目诚实进 issues（含字段定位与原因）
    expect(
      result.issues.some(
        (issue) => issue.includes("章节语义声明被拒") && issue.includes("mainEvent") && issue.includes("他一剑劈开了整座大门。"),
      ),
    ).toBe(true);
  });

  // 修复②（最小版）：已校验的 resourceDeltas 显式进 issues（不静默）、供 agent 同步资产卡；不阻断入库。
  it("传含 resourceDeltas 的合法声明：资源变化进 issues 提示、passed 仍为 true", async () => {
    const projectDir = await createFixtureProject();
    await seedHookPool(projectDir);
    await writeDraft(projectDir, 1, semanticDraft());

    const declaration: ChapterDeltaDeclaration = {
      chapter: 1,
      mainEvent: { summary: "林远发现账目", quote: "他发现账房角落里藏着一本账目，意识到组织管事暗中克扣外院资源。" },
      seededForeshadowing: [],
      resolvedForeshadowing: [],
      resourceDeltas: [
        { item: "破损信物", change: "gain", amount: "半枚", quote: "林远得到半枚破损信物，却也被扣掉了本该领到的粮米。" },
      ],
      keyLeads: [],
    };

    const result = await buildCommitPlanFromProject({ projectDir, chapter: 1, declaration });

    expect(result.passed).toBe(true);
    expect(result.issues.some((issue) => issue.includes("资源变化待同步资产卡") && issue.includes("破损信物") && issue.includes("半枚"))).toBe(true);
  });

  it("resourceDeltas 数量证据不匹配：数量未采信但资源得失条目仍进 issues", async () => {
    const projectDir = await createFixtureProject();
    await seedHookPool(projectDir);
    await writeDraft(projectDir, 1, semanticDraft());

    const declaration: ChapterDeltaDeclaration = {
      chapter: 1,
      mainEvent: { summary: "林远发现账目", quote: "他发现账房角落里藏着一本账目，意识到组织管事暗中克扣外院资源。" },
      seededForeshadowing: [],
      resolvedForeshadowing: [],
      resourceDeltas: [
        { item: "破损信物", change: "gain", amount: "一枚", quote: "林远得到半枚破损信物，却也被扣掉了本该领到的粮米。" },
      ],
      keyLeads: [],
    };

    const result = await buildCommitPlanFromProject({ projectDir, chapter: 1, declaration });

    expect(result.passed).toBe(true);
    expect(result.issues.some((issue) => issue.includes("章节语义声明数量未采信，仅记入得失条目") && issue.includes("amount_not_in_evidence"))).toBe(true);
    expect(result.issues.some((issue) => issue.includes("资源变化待同步资产卡") && issue.includes("破损信物") && !issue.includes("一枚"))).toBe(true);
    expect(result.semanticSummary?.gained).toBe("破损信物");
  });

  it("已校验 resourceDeltas 存在时：gained/lost 用声明资源派生，避免正则碎片污染", () => {
    const summary = extractChapterSemanticSummary({
      chapter: 26,
      draft: [
        "# 第二十六章",
        "",
        "秤盘里放着几株干巴巴的灵草。他左手没了，袖口空荡荡。",
        "陆青岚把月隐草收进布袋，低声说：“这一株够用了。”",
        "他花掉三十枚灵石，又把旧符纸烧成灰。",
      ].join("\n"),
      characters: [{ id: toSafeCharacterId("陆青岚"), name: "陆青岚", appearance: {} }],
      hooks: [],
      defaultCharacterId: toSafeCharacterId("陆青岚"),
      verifiedDelta: {
        chapter: 26,
        mainEvent: {
          summary: "陆青岚在后街从独眼刘手中购得月隐草",
          quote: "陆青岚把月隐草收进布袋，低声说：“这一株够用了。”",
        },
        seededForeshadowing: [],
        resolvedForeshadowing: [],
        resourceDeltas: [
          {
            item: "月隐草",
            change: "gain",
            amount: "一株",
            quote: "陆青岚把月隐草收进布袋，低声说：“这一株够用了。”",
          },
          {
            item: "灵石",
            change: "spend",
            amount: "三十枚",
            quote: "他花掉三十枚灵石，又把旧符纸烧成灰。",
          },
        ],
        keyLeads: [],
        pendingIntents: [],
        charactersPresent: [],
        arcGoalProgress: [],
        rejected: [],
        hasAnyVerified: true,
      },
    });

    expect(summary.gained).toBe("月隐草（一株）");
    expect(summary.lost).toBe("灵石（三十枚）");
    expect(summary.lost).not.toContain("他左手没了");
  });

  it("mainEvent 缺失但 discovery 校验通过：mainEvent/timelineSummary 用 discovery 摘要兜底", () => {
    const summary = extractChapterSemanticSummary({
      chapter: 31,
      draft: [
        "# 第三十一章",
        "",
        "雨声压着窗沿，周砚没有回头。",
        "铜盒底层贴着标签：S-41。",
        "他把铜盒合上，决定天亮前去账房。",
      ].join("\n"),
      characters: [{ id: toSafeCharacterId("周砚"), name: "周砚", appearance: {} }],
      hooks: [],
      defaultCharacterId: toSafeCharacterId("周砚"),
      verifiedDelta: {
        chapter: 31,
        discovery: {
          summary: "周砚确认铜盒底层藏有编号 S-41 的账册线索",
          quote: "铜盒底层贴着标签：S-41。",
        },
        seededForeshadowing: [],
        resolvedForeshadowing: [],
        resourceDeltas: [],
        keyLeads: [],
        pendingIntents: [],
        charactersPresent: [],
        arcGoalProgress: [],
        rejected: [],
        hasAnyVerified: true,
      },
    });

    expect(summary.discovery).toBe("周砚确认铜盒底层藏有编号 S-41 的账册线索");
    expect(summary.mainEvent).toBe("周砚确认铜盒底层藏有编号 S-41 的账册线索");
    expect(summary.timelineSummary).toBe("周砚确认铜盒底层藏有编号 S-41 的账册线索");
  });

  it("verifiedDelta 无 mainEvent/conflict/discovery/decision：mainEvent 仍保持正则旧行为", () => {
    const input = {
      chapter: 32,
      draft: [
        "# 第三十二章",
        "",
        "周砚在库房门后找到编号 T-08 的旧账册。",
        "他把旧账册塞进内袋，转身去找陈禾。",
      ].join("\n"),
      characters: [{ id: toSafeCharacterId("周砚"), name: "周砚", appearance: {} }],
      hooks: [],
      defaultCharacterId: toSafeCharacterId("周砚"),
    };
    const baseline = extractChapterSemanticSummary(input);
    const withVerifiedNonScalar = extractChapterSemanticSummary({
      ...input,
      verifiedDelta: {
        chapter: 32,
        seededForeshadowing: [],
        resolvedForeshadowing: [],
        resourceDeltas: [],
        keyLeads: [
          { summary: "T-08 旧账册待查", quote: "周砚在库房门后找到编号 T-08 的旧账册。" },
        ],
        pendingIntents: [],
        charactersPresent: [],
        arcGoalProgress: [],
        rejected: [],
        hasAnyVerified: true,
      },
    });

    expect(withVerifiedNonScalar.mainEvent).toBe(baseline.mainEvent);
    expect(withVerifiedNonScalar.timelineSummary).toBe(baseline.timelineSummary);
  });

  it("没有已校验 resourceDeltas 时：gained/lost 仍回退旧正则行为", () => {
    const summary = extractChapterSemanticSummary({
      chapter: 26,
      draft: [
        "# 第二十六章",
        "",
        "陆青岚得到月隐草。",
        "他左手没了，袖口空荡荡。",
      ].join("\n"),
      characters: [{ id: toSafeCharacterId("陆青岚"), name: "陆青岚", appearance: {} }],
      hooks: [],
      defaultCharacterId: toSafeCharacterId("陆青岚"),
    });

    expect(summary.gained).toContain("月隐草");
    expect(summary.lost).toContain("左手没了");
  });

  it("已有任意校验声明但 resourceDeltas 为空：gained/lost 不再回退正则乱抽", () => {
    const summary = extractChapterSemanticSummary({
      chapter: 33,
      draft: [
        "# 第三十三章",
        "",
        "周砚得到这个答案时没有松气。",
        "他还没找到真正的钥匙，旧账册也没了下落。",
        "陈禾点头，说：“先查 S-41。”",
      ].join("\n"),
      characters: [{ id: toSafeCharacterId("周砚"), name: "周砚", appearance: {} }],
      hooks: [],
      defaultCharacterId: toSafeCharacterId("周砚"),
      verifiedDelta: {
        chapter: 33,
        mainEvent: {
          summary: "周砚和陈禾决定继续查 S-41",
          quote: "陈禾点头，说：“先查 S-41。”",
        },
        seededForeshadowing: [],
        resolvedForeshadowing: [],
        resourceDeltas: [],
        keyLeads: [],
        pendingIntents: [],
        charactersPresent: [],
        arcGoalProgress: [],
        rejected: [],
        hasAnyVerified: true,
      },
    });

    expect(summary.gained).toBeUndefined();
    expect(summary.lost).toBeUndefined();
  });

  it("无声明正则 fallback：否定的『没找到』不算 gained，真实获得仍可识别", () => {
    const negated = extractChapterSemanticSummary({
      chapter: 34,
      draft: [
        "# 第三十四章",
        "",
        "周砚还没找到打开暗柜的办法。",
        "他只把账册重新塞回纸袋。",
      ].join("\n"),
      characters: [{ id: toSafeCharacterId("周砚"), name: "周砚", appearance: {} }],
      hooks: [],
      defaultCharacterId: toSafeCharacterId("周砚"),
    });
    const gained = extractChapterSemanticSummary({
      chapter: 35,
      draft: [
        "# 第三十五章",
        "",
        "周砚找到了半筐凝露草，立刻封进木箱。",
      ].join("\n"),
      characters: [{ id: toSafeCharacterId("周砚"), name: "周砚", appearance: {} }],
      hooks: [],
      defaultCharacterId: toSafeCharacterId("周砚"),
    });

    expect(negated.gained).toBeUndefined();
    expect(gained.gained).toContain("凝露草");
  });

  // conflict/discovery/decision 声明化：逐字段优先用声明干净摘要（题材中立），缺则回退正则关键词表。
  it("传含 conflict/discovery/decision 的合法声明：三字段都用声明干净摘要（不同于正则基线）", async () => {
    const projectDir = await createFixtureProject();
    await seedHookPool(projectDir);
    await writeDraft(projectDir, 1, semanticDraft());

    const baseline = await buildCommitPlanFromProject({ projectDir, chapter: 1 });

    const declaration: ChapterDeltaDeclaration = {
      chapter: 1,
      mainEvent: { summary: "林远发现管事克扣外院资源的账目", quote: "他发现账房角落里藏着一本账目，意识到组织管事暗中克扣外院资源。" },
      conflict: { summary: "被管事克扣、遭同门挑衅", quote: "林远在外院园圃被管事当众克扣月钱，还遭到同门挑衅。" },
      discovery: { summary: "查到账目暗指账目", quote: "他发现账房角落里藏着一本账目，意识到组织管事暗中克扣外院资源。" },
      decision: { summary: "决意去库房查清账册", quote: "他决定先去库房查清账册来源，不能再任人打压。" },
      seededForeshadowing: [],
      resolvedForeshadowing: [],
      resourceDeltas: [],
      keyLeads: [],
    };

    const result = await buildCommitPlanFromProject({ projectDir, chapter: 1, declaration });

    expect(result.passed).toBe(true);
    expect(result.semanticSummary?.conflict).toBe("被管事克扣、遭同门挑衅");
    expect(result.semanticSummary?.discovery).toBe("查到账目暗指账目");
    expect(result.semanticSummary?.decision).toBe("决意去库房查清账册");
    // 证明是声明覆盖而非碰巧：声明摘要 ≠ 不传声明时的正则结果
    expect(result.semanticSummary?.conflict).not.toBe(baseline.semanticSummary?.conflict);
    expect(result.semanticSummary?.discovery).not.toBe(baseline.semanticSummary?.discovery);
    expect(result.semanticSummary?.decision).not.toBe(baseline.semanticSummary?.decision);
    expect(result.issues.some((issue) => issue.includes("章节语义声明被拒"))).toBe(false);
  });

  it("传 conflict 证据对不上的声明：conflict 回退正则 + issues 记录被拒（discovery/decision 未声明不受影响）", async () => {
    const projectDir = await createFixtureProject();
    await seedHookPool(projectDir);
    await writeDraft(projectDir, 1, semanticDraft());
    const baseline = await buildCommitPlanFromProject({ projectDir, chapter: 1 });

    const declaration: ChapterDeltaDeclaration = {
      chapter: 1,
      mainEvent: { summary: "林远发现账目", quote: "他发现账房角落里藏着一本账目，意识到组织管事暗中克扣外院资源。" },
      conflict: { summary: "凭空冲突", quote: "他与掌门在训练场大战三百回合。" },
      seededForeshadowing: [],
      resolvedForeshadowing: [],
      resourceDeltas: [],
      keyLeads: [],
    };

    const result = await buildCommitPlanFromProject({ projectDir, chapter: 1, declaration });

    expect(result.passed).toBe(true);
    // conflict 证据对不上 → 回退正则（与不传声明一致），绝不采纳凭空摘要
    expect(result.semanticSummary?.conflict).toBe(baseline.semanticSummary?.conflict);
    expect(result.semanticSummary?.conflict).not.toBe("凭空冲突");
    expect(result.issues.some((issue) => issue.includes("章节语义声明被拒") && issue.includes("conflict"))).toBe(true);
  });

  // 人物一致性写前校验：模型声明的本章用名与已确立角色名做形近比对，逮住写歪的错名（题材中立）。
  it("传含 charactersPresent 的声明：已登记角色名被写歪 → issues 提示疑似漂移，不阻断入库", async () => {
    const projectDir = await createFixtureProject();
    await seedHookPool(projectDir);
    // 草稿把已登记主角「林远」写成形近的「林元」，且全程没出现正确名「林远」。
    await writeDraft(projectDir, 2, [
      "# 第二章",
      "",
      "林元走进账房，翻看那本账目。",
      "",
      "他把破损信物揣进怀里，转身离开。",
    ].join("\n"));

    const declaration: ChapterDeltaDeclaration = {
      chapter: 2,
      mainEvent: { summary: "查看账目", quote: "林元走进账房，翻看那本账目。" },
      seededForeshadowing: [],
      resolvedForeshadowing: [],
      resourceDeltas: [],
      keyLeads: [],
      charactersPresent: [
        { name: "林元", quote: "林元走进账房，翻看那本账目。", identityHint: "主角" },
      ],
    };

    const result = await buildCommitPlanFromProject({ projectDir, chapter: 2, declaration });

    expect(result.passed).toBe(true);
    expect(
      result.issues.some((issue) => issue.includes("人物名疑似写歪") && issue.includes("林元") && issue.includes("林远")),
    ).toBe(true);
    // 结构化发现（供上层固定展示成明确 warning，不靠模型转述）：与 issues 文本一一对应。
    expect(result.nameDriftFindings).toEqual([
      expect.objectContaining({ establishedName: "林远", driftedVariant: "林元" }),
    ]);
  });

  it("charactersPresent 用的是正确角色名 → 不报漂移", async () => {
    const projectDir = await createFixtureProject();
    await seedHookPool(projectDir);
    await writeDraft(projectDir, 2, [
      "# 第二章",
      "",
      "林远走进账房，翻看那本账目。",
    ].join("\n"));

    const declaration: ChapterDeltaDeclaration = {
      chapter: 2,
      mainEvent: { summary: "查看账目", quote: "林远走进账房，翻看那本账目。" },
      seededForeshadowing: [],
      resolvedForeshadowing: [],
      resourceDeltas: [],
      keyLeads: [],
      charactersPresent: [
        { name: "林远", quote: "林远走进账房，翻看那本账目。", identityHint: "主角" },
      ],
    };

    const result = await buildCommitPlanFromProject({ projectDir, chapter: 2, declaration });

    expect(result.passed).toBe(true);
    expect(result.issues.some((issue) => issue.includes("人物名疑似写歪"))).toBe(false);
  });

  // prose-only 名（未登记进角色库的跨章人物，如「妹妹林宁」）经 establishedCharacterNames 传入也能被护住。
  it("establishedCharacterNames 传入的 prose-only 名被写歪 → 同样报漂移", async () => {
    const projectDir = await createFixtureProject();
    await seedHookPool(projectDir);
    await writeDraft(projectDir, 2, [
      "# 第二章",
      "",
      "林远提起妹妹林棠去年失踪的事，久久不能平静。",
    ].join("\n"));

    const declaration: ChapterDeltaDeclaration = {
      chapter: 2,
      mainEvent: { summary: "提起妹妹失踪", quote: "林远提起妹妹林棠去年失踪的事，久久不能平静。" },
      seededForeshadowing: [],
      resolvedForeshadowing: [],
      resourceDeltas: [],
      keyLeads: [],
      charactersPresent: [
        { name: "林远", quote: "林远提起妹妹林棠去年失踪的事，久久不能平静。" },
        { name: "林棠", quote: "林远提起妹妹林棠去年失踪的事，久久不能平静。", identityHint: "妹妹" },
      ],
    };

    const result = await buildCommitPlanFromProject({
      projectDir,
      chapter: 2,
      declaration,
      establishedCharacterNames: ["林宁"],
    });

    expect(result.passed).toBe(true);
    expect(
      result.issues.some((issue) => issue.includes("人物名疑似写歪") && issue.includes("林棠") && issue.includes("林宁")),
    ).toBe(true);
  });

  // 累积闭环：声明并校验通过的出场角色名写进 semanticSummary（随时间线持久化），供后续章名字漂移校验用。
  it("charactersPresent 校验通过后写入 semanticSummary.presentCharacterNames（供跨章累积）", async () => {
    const projectDir = await createFixtureProject();
    await seedHookPool(projectDir);
    await writeDraft(projectDir, 2, [
      "# 第二章",
      "",
      "林远提起妹妹林宁去年失踪的事。",
    ].join("\n"));

    const declaration: ChapterDeltaDeclaration = {
      chapter: 2,
      mainEvent: { summary: "提起妹妹失踪", quote: "林远提起妹妹林宁去年失踪的事。" },
      seededForeshadowing: [],
      resolvedForeshadowing: [],
      resourceDeltas: [],
      keyLeads: [],
      charactersPresent: [
        { name: "林远", quote: "林远提起妹妹林宁去年失踪的事。" },
        { name: "林宁", quote: "林远提起妹妹林宁去年失踪的事。", identityHint: "妹妹" },
      ],
    };

    const result = await buildCommitPlanFromProject({ projectDir, chapter: 2, declaration });

    expect(result.passed).toBe(true);
    expect(result.semanticSummary?.presentCharacterNames).toEqual(expect.arrayContaining(["林远", "林宁"]));
    // 持久化进时间线 effects，后续章可读回累积成已确立名册
    const persisted = result.commitPlan?.timelineEvents?.[0]?.effects?.semanticSummary as { presentCharacterNames?: string[] } | undefined;
    expect(persisted?.presentCharacterNames).toEqual(expect.arrayContaining(["林远", "林宁"]));
  });

  it("keeps mentionedHooks empty when HookPool is empty", async () => {
    const projectDir = await createFixtureProject();
    await writeDraft(projectDir, 1, semanticDraft());

    const result = await buildCommitPlanFromProject({ projectDir, chapter: 1 });

    expect(result.passed).toBe(true);
    expect(result.semanticSummary?.mentionedHooks).toEqual([]);
    expect(result.commitPlan?.hookUpdates).toBeUndefined();
  });

  it("falls back to a generic timeline summary when draft has no extractable event", () => {
    const characters: CharacterProfile[] = [
      {
        id: "character",
        name: "林远",
        appearance: {},
      },
    ];
    const hooks: HookItem[] = [];

    const summary = extractChapterSemanticSummary({
      chapter: 7,
      draft: "# 第七章\n\n……",
      characters,
      hooks,
      defaultCharacterId: "character",
    });

    expect(summary.mainEvent).toBe("第 7 章草稿被提交为正式章节。");
    expect(summary.chapterSummary).toBe("");
    expect(summary.participants).toEqual(["林远"]);
    expect(summary.keyEvents).toEqual([]);
    expect(summary.foreshadowingTerms).toEqual([]);
    expect(summary.timelineSummary).toBe("第 7 章草稿被提交为正式章节。");
    expect(summary.protagonist).toBe("林远");
    expect(summary.mentionedCharacters).toEqual(["character"]);
    expect(summary.mentionedCharacterNames).toEqual(["林远"]);
    expect(summary.mentionedHooks).toEqual([]);
    expect(summary.locations).toEqual([]);
  });

  it("extracts semantic locations from the project bible and generic foreshadowing terms", () => {
    const characters: CharacterProfile[] = [
      {
        id: "character",
        name: "林澈",
        appearance: {},
      },
    ];

    const summary = extractChapterSemanticSummary({
      chapter: 3,
      draft: [
        "# 第三章",
        "",
        "林澈从西院回廊下到中庭，看见侧门半开。",
        "他准备去档案室找原件，顺路检查地窖通道。",
        "门口拖着一道血痕，墙角还压着一封密信。",
      ].join("\n"),
      characters,
      hooks: [],
      defaultCharacterId: "character",
      knownLocations: ["西院回廊", "中庭", "档案室", "地窖"],
    });

    // Locations are data-driven from the project location bible only.
    expect(summary.locations).toEqual(expect.arrayContaining(["中庭", "档案室", "地窖"]));
    // Foreshadowing comes from the genre-neutral noun table + hook titles.
    expect(summary.foreshadowingTerms).toEqual(expect.arrayContaining(["血痕", "密信"]));
    expect(summary.keyEvents).toEqual(expect.arrayContaining([
      expect.stringContaining("档案室找原件"),
    ]));
  });

  it("does not reference legacy InkOS packages", async () => {
    const source = await readFile(join(import.meta.dirname, "..", "commit-plan-builder.ts"), "utf-8");

    expect(source).not.toMatch(new RegExp([
      ["packages", "core"].join("/"),
      ["@actalk", "inkos-core"].join("/"),
      ["Pipeline", "Runner"].join(""),
    ].join("|")));
  });

  // Codex 1-5 章真机：timeline 摘要曾是对白碎片、且以右引号打头（句切器在「。"」处把右引号甩到下句开头，
  // 打分又给「X说」归属句 +1 让碎片冒头）。修后：句切器认弯引号、对白归属句降权，摘要取叙述句。
  it("timeline 摘要不取对白碎片、不以引号打头（句切器认弯引号 + 对白归属句降权）", () => {
    const summary = extractChapterSemanticSummary({
      draft: [
        "# 第1章 残页",
        "",
        "林霁连夜搜查旧档案室，发现一张被夹在废纸里的残页。",
        "",
        "“顾闻舟给我的。”林霁说，“他说这是他在整理旧档案时发现的。但他不知道这意味着什么。”",
      ].join("\n"),
      chapter: 1,
      characters: [{ id: "林霁", name: "林霁" }],
      hooks: [],
      defaultCharacterId: toSafeCharacterId("林霁"),
    });
    // 不以右/左引号或书名号打头（治孤儿引号碎片）
    expect(summary.timelineSummary).not.toMatch(/^[“”"「『」』]/u);
    // 不是「X说，"…」说话人归属对白碎片
    expect(summary.timelineSummary).not.toMatch(/[一-龥]{1,4}说，[“”"「]/u);
    // 叙述事件被抓到（残页这条只出现在叙述句里）
    expect(summary.timelineSummary).toContain("残页");
    for (const ev of summary.keyEvents ?? []) {
      expect(ev).not.toMatch(/^[“”"「『]/u);
    }
  });

  // Codex 复测：都市悬疑整章实质事件句（「苏晚撬开砖取出铁盒」「许鸣站在报亭门口」）一个修仙味关键词都不命中→全 0 被滤，
  // 唯独退场尾动作「他说完，转身离开」靠「离开」+2 冒头当 timelineSummary，信息量低。修后：用项目自己的角色名/地点名
  // 当题材中立信号给具名实质句加权，裸代词起头无实体句降权——摘要落在具名事件句上、不再是退场尾动作。
  it("timeline 摘要优先具名实体实质句、不取关键词命中的退场尾动作（Codex 复测：他说完，转身离开）", () => {
    const summary = extractChapterSemanticSummary({
      draft: [
        "# 第2章 报亭",
        "",
        "苏晚站在废弃报亭前，撬开第三块砖，取出一只薄铁盒。",
        "",
        "许鸣站在报亭门口，挡住了她的去路。",
        "",
        "他说完，转身离开。",
      ].join("\n"),
      chapter: 2,
      characters: [
        { id: toSafeCharacterId("苏晚"), name: "苏晚", appearance: {} },
        { id: toSafeCharacterId("许鸣"), name: "许鸣", appearance: {} },
      ],
      hooks: [],
      defaultCharacterId: toSafeCharacterId("苏晚"),
      knownLocations: ["废弃报亭"],
    });
    const timelineSummary = summary.timelineSummary ?? "";
    // 不取退场尾动作当摘要
    expect(timelineSummary).not.toContain("转身离开");
    // 摘要落在具名实体（角色或地点）的实质事件句上
    expect(/苏晚|许鸣|报亭/u.test(timelineSummary)).toBe(true);
  });

  // Codex 5 章 E2E·P1：摘要抓环境句（「雨砸在旧港巷…」只提地点）和总结句（「线索闭环了」靠 线索 关键词冒头）。
  // 修后：地点实体≠角色实体（纯景物句不得 +3）；很短且无演员的总结句即便命中关键词也判 0。
  it("timeline 摘要丢纯景物句和总结句、取具名事件句（地点实体不当演员 + 短总结句判0）", () => {
    const summary = extractChapterSemanticSummary({
      draft: [
        "# 第5章 闭环",
        "",
        "雨砸在旧港巷的青石板上，溅起一层白雾。",
        "",
        "林澈把那张缺角的轮渡票平铺在旧航线图上，票角严丝合缝。",
        "",
        "线索闭环了。",
      ].join("\n"),
      chapter: 5,
      characters: [{ id: toSafeCharacterId("林澈"), name: "林澈", appearance: {} }],
      hooks: [],
      defaultCharacterId: toSafeCharacterId("林澈"),
      knownLocations: ["旧港巷"],
    });
    const ts = summary.timelineSummary ?? "";
    expect(ts).not.toContain("线索闭环");      // 短总结句不当摘要
    expect(ts).not.toContain("雨砸");           // 纯景物句（只提地点）不当摘要
    expect(ts).toContain("林澈");               // 具名事件句
    for (const ev of summary.keyEvents ?? []) {
      expect(ev).not.toContain("线索闭环");
      expect(ev).not.toContain("雨砸在旧港巷");
    }
  });

  // Codex 组合复测·P1：timeline/events.json 落盘摘要退化——开场场景铺垫（站在货架前/玻璃门褪色）
  // 独占 summary，核心情节事件（在第三块砖下找到编号 X-23 的账册底片）被文档顺序挤出。根因：scoreEventSentence
  // 对「含主角名」一律 +3 → 全章每句都 3 分、区分度坍塌，核心事件没有额外加权，timelineSummary=keyEvents.slice(0,2)
  // 又只取文档前两句。修后：① 字母-数字编号锚点（X-23/HT-771）+ 通用发现动词（找到/掀开）给核心事件加权；
  // ② timelineSummary 取分值最高的两句（最具情节意义），而非文档前两句。
  it("timeline 摘要抓核心情节事件（编号锚点）、不被开场场景铺垫独占（Codex 组合复测 P1）", () => {
    const summary = extractChapterSemanticSummary({
      draft: [
        "# 第1章",
        "",
        "许燃站在桥东便利店的货架前，指尖划过一排排胶带，最后停在一卷黑色绝缘胶带上。",
        "",
        "玻璃门上的“营业”二字褪了色，许燃推门进去，风铃发出一声哑响。",
        "",
        "陈姨坐在柜台后修一台老式海鸥相机，手指关节泛着常年的黄渍。",
        "",
        "许燃跟进里间的暗房，空气里弥漫着醋酸和定影液的刺鼻气味。",
        "",
        "许燃蹲下身，掀开墙角第三块砖，取出一卷编号 X-23 的账册底片。",
        "",
        "许燃顺着账册底片，又在柜台暗格里找到一份编号 HT-771 的假合同。",
      ].join("\n"),
      chapter: 1,
      characters: [{ id: toSafeCharacterId("许燃"), name: "许燃", appearance: {} }],
      hooks: [],
      defaultCharacterId: toSafeCharacterId("许燃"),
    });
    const ts = summary.timelineSummary ?? "";
    // 两个核心情节事件（编号 X-23 账册底片 / 编号 HT-771 假合同）进摘要
    expect(ts).toContain("X-23");
    expect(ts).toContain("HT-771");
    // 开场场景铺垫（货架前 / 玻璃门褪色）不独占摘要
    expect(ts).not.toContain("货架");
    expect(ts).not.toContain("玻璃门");
    // keyEvents 也应抓到核心事件
    expect((summary.keyEvents ?? []).some((ev) => ev.includes("X-23"))).toBe(true);
    expect((summary.keyEvents ?? []).some((ev) => ev.includes("HT-771"))).toBe(true);
  });

  // Codex retest2·P1：第1轮编号加权修了「编号事件被挤出」，但 ch2 摘要退化成碎片句「合同 A-330。名字和编号都对得上。」。
  // 根因：① CODE_ANCHOR 含裸词「编号」→「名字和编号都对得上」「认得这个编号吗」这类陈述/疑问句也被 +4 冒头；
  // ② 裸代号标签（「合同 A-330。」「L-09。」很短、无演员、无动作）拿满 +4，压过完整事件句。
  // 修后：CODE_ANCHOR 只认字母-数字代号（去掉裸词「编号/型号/代号」）；裸代号标签只 +1，完整事件句（带演员）冒头。
  it("timeline 摘要取完整事件句、不被裸代号标签/编号陈述句碎片化（Codex retest2 P1）", () => {
    const summary = extractChapterSemanticSummary({
      draft: [
        "# 第2章",
        "",
        "沈织推门进去，走到柜台前，把背包放在台面上。",
        "",
        "老田转身走向后排的铁柜，在第九号柜前停下，插进钥匙。",
        "",
        "合同 A-330。",
        "",
        "名字和编号都对得上。",
        "",
        "怀里的合同 A-330 贴着皮肤，凉意渗透衬衫，直抵心脏。",
      ].join("\n"),
      chapter: 2,
      characters: [{ id: toSafeCharacterId("沈织"), name: "沈织", appearance: {} }],
      hooks: [],
      defaultCharacterId: toSafeCharacterId("沈织"),
    });
    const ts = summary.timelineSummary ?? "";
    // 核心代号 A-330 进摘要
    expect(ts).toContain("A-330");
    // 不被「名字和编号都对得上」这类编号陈述句碎片占据（去掉裸词「编号」加权后它判 0）
    expect(ts).not.toContain("名字和编号都对得上");
    // 摘要落在带演员的完整事件句上
    expect(ts).toContain("沈织");
  });

  // Codex retest3·P2：ch2 摘要混入半截对白「秦柏声音不高，"你拿到的是副本。」——以「X声音[不高/低沉]，"」做
  // 说话人归属的对白句没被对白闸拦下（旧闸只认 说/问/喊/叫/低声/冷笑/嘟囔），且在引号处被切成半句。
  // 修后：声音/语气/嗓音/声线 做归属的对白句也判 0、不进摘要。
  it("timeline 摘要不取「X声音…，引号」半截对白（Codex retest3 P2：秦柏声音不高，\"…）", () => {
    const summary = extractChapterSemanticSummary({
      draft: [
        "# 第2章",
        "",
        "顾行把录音笔 R-17 塞进裤袋，旧采访证的边角硌着手心。",
        "",
        "秦柏声音不高，“你拿到的是副本。剩下的还在我手里。”",
      ].join("\n"),
      chapter: 2,
      characters: [
        { id: toSafeCharacterId("顾行"), name: "顾行", appearance: {} },
        { id: toSafeCharacterId("秦柏"), name: "秦柏", appearance: {} },
      ],
      hooks: [],
      defaultCharacterId: toSafeCharacterId("顾行"),
    });
    const ts = summary.timelineSummary ?? "";
    expect(ts).not.toContain("秦柏声音不高");          // 半截对白归属句不进摘要
    expect(ts).not.toMatch(/[“"「『][^”"」』]*$/u);   // 摘要不以未闭合的引号收尾
    expect(ts).toContain("R-17");                       // 真事件句仍在
  });

  // Codex retest4·根因（Workflow 调查确认）：isDialogueAttributionSentence 只接在 scoreEventSentence
  // （→keyEvents/timelineSummary）一条管线上，但 mainEvent/nextLead 走另外 4+ 条独立选句管线
  // （pickDistinct/pickFirstDistinct→scoreSemanticCandidate、pickDecisionSentence→scoreDecisionCandidate、
  // pickNextLead 内联过滤），全都没接这道闸——前两轮"加归属动词"只是在已覆盖的那一条路径上打地鼠，
  // 这三条没人管的路径继续混入半截对白。本轮根治：① 新增题材中立的「引号不平衡」判定（按数学事实——完整句子
  // 引号必然配对、断口处必不配对，不用再枚举归属动词）；② 把它和 isDialogueAttributionSentence 一起接进全部
  // 选句管线，不再只接一条。
  describe("孤儿引号/半截对白根治（Codex retest4：闸只布了一条线，另外4条选句管线没人管）", () => {
    it("keyEvents：「盯着+冒号+引号」非动词归属句（不在归属动词表里）仍因未闭合引号被排除", () => {
      const summary = extractChapterSemanticSummary({
        draft: [
          "# 第2章",
          "",
          "陆峥拿到H-31钥匙，转身要走。",
          "",
          "秦屿没理他，盯着陆峥：“你妹妹留给你的不是证据，是诱饵。这件事还没完。”",
        ].join("\n"),
        chapter: 2,
        characters: [
          { id: toSafeCharacterId("陆峥"), name: "陆峥", appearance: {} },
          { id: toSafeCharacterId("秦屿"), name: "秦屿", appearance: {} },
        ],
        hooks: [],
        defaultCharacterId: toSafeCharacterId("陆峥"),
      });
      // 半截对白（无论从哪个断口切出来）都不进 keyEvents——既不含未闭合的开引号片段，也不含孤儿收尾的闭引号片段
      for (const ev of summary.keyEvents ?? []) {
        const opens = (ev.match(/“/gu) ?? []).length;
        const closes = (ev.match(/”/gu) ?? []).length;
        expect(opens).toBe(closes);
      }
      expect((summary.keyEvents ?? []).some((ev) => ev.includes("你妹妹留给你的不是证据"))).toBe(false);
      // 真事件句（H-31）仍被抓到
      expect((summary.keyEvents ?? []).some((ev) => ev.includes("H-31"))).toBe(true);
    });

    it("mainEvent（gained/lost 走 clause 路径）：引号开头碎片即便命中关键词也不被选中", () => {
      const summary = extractChapterSemanticSummary({
        draft: [
          "# 第3章",
          "",
          "陆峥追问之后，得到的回答是，“没了，别再找了。”",
          "",
          "陆峥拿到一份编号L-08的清单，转身离开。",
        ].join("\n"),
        chapter: 3,
        characters: [{ id: toSafeCharacterId("陆峥"), name: "陆峥", appearance: {} }],
        hooks: [],
        defaultCharacterId: toSafeCharacterId("陆峥"),
      });
      // mainEvent 不应是孤儿引号开头的碎片（如 "没了 这种半截）
      expect(summary.mainEvent).not.toMatch(/^[“"「『]/u);
      expect(summary.mainEvent).not.toContain("“没了");
    });

    it("nextLead（pickNextLead 关键词「声音」命中）：直引号未被合并闭合、留下孤儿引号片段不被选中（Codex retest4 原例：直引号不在句切器合并白名单内，与弯引号待遇不同）", () => {
      const summary = extractChapterSemanticSummary({
        draft: [
          "# 第3章",
          "",
          "陆峥僵在原地，没有回头。",
          "",
          "\"你别想跑。\"皮鞋声音重新响起来，从楼梯那头传来。",
        ].join("\n"),
        chapter: 3,
        characters: [{ id: toSafeCharacterId("陆峥"), name: "陆峥", appearance: {} }],
        hooks: [],
        defaultCharacterId: toSafeCharacterId("陆峥"),
      });
      // 唯一候选句因引号不平衡被排除、没有其它候选回退 → nextLead 正确地落空（宁缺不留半截），不是 undefined 之外的破碎值
      expect(summary.nextLead === undefined || !/^[“"「』]/u.test(summary.nextLead)).toBe(true);
    });
  });

  // Codex retest5：孤儿引号修好后，摘要仍偏过程动作（"推开玻璃门""猛地转头"），没抓住核心发现
  // （"找到红色票根 B-7"）。根因：代词起头+编号锚点的发现句被「代词无地点 -2」惩罚——该惩罚是为压纯景物句
  // 设计的（"雨砸在旧港巷…"只提地点没演员），但带编号的句子几乎不可能是景物句，不该一起罚。
  describe("时间线摘要质量·核心发现句压过过程动作（Codex retest5）", () => {
    it("代词起头+编号锚点的发现句不再被「代词无地点」惩罚，能压过开场过渡动作", () => {
      const summary = extractChapterSemanticSummary({
        draft: [
          "# 第1章",
          "",
          "沈砚推开售票处的玻璃门，门轴发出干涩的声响。",
          "",
          "他小心地往外抽——一张红色票根，背面用铅笔写着“B-7”。",
          "",
          "沈砚猛地转头，售票窗口旁的侧门站着个女人。",
        ].join("\n"),
        chapter: 1,
        characters: [{ id: toSafeCharacterId("沈砚"), name: "沈砚", appearance: {} }],
        hooks: [],
        defaultCharacterId: toSafeCharacterId("沈砚"),
      });
      const ts = summary.timelineSummary ?? "";
      expect(ts).toContain("B-7");
    });

    // 回归守卫（真实 retest5 场景，不需要新改动——编号锚点+具名角色已叠加压过纯关键词句，记录下来防回归）。
    it("具名角色+编号锚点的发现句（不靠代词）本就压过随手命中关键词的过渡句", () => {
      const summary = extractChapterSemanticSummary({
        draft: [
          "# 第2章",
          "",
          "沈砚跟上去，拐过两个弯，推开一扇铁门，进了档案室。",
          "",
          "沈砚拉开暗格，里面平放着一份蓝色封皮的合同副本 A-330，和一个黑色胶片盒。",
        ].join("\n"),
        chapter: 2,
        characters: [{ id: toSafeCharacterId("沈砚"), name: "沈砚", appearance: {} }],
        hooks: [],
        defaultCharacterId: toSafeCharacterId("沈砚"),
      });
      const ts = summary.timelineSummary ?? "";
      expect(ts).toContain("A-330");
    });
  });

  // Codex retest6：mainEvent 仍偏到低价值方位/场景句（"江岚站在走廊尽头…" / "走廊尽头，江岚还站在原地"），
  // 没抓住本章核心发现（编号物证 R-17 / Q-04）。根因：buildMainEvent 用的是遗留扁平关键词表（pickDistinct
  // 含"站在"），与 scoreEventSentence 评分路径脱节——当 conflict/discovery/gained/lost/decision 全空
  // （核心发现用编号锚点表达、不含"发现/找到"关键词）时，fallback 抓第一个命中"站在"的方位场景句。
  // 修后：mainEvent fallback 改用评分排名；且优先选带编号锚点的完整发现句（编号物证=本章核心发现）。
  describe("mainEvent 抓核心发现（编号锚点）、不偏方位场景句（Codex retest6）", () => {
    it("Ch1：核心发现是编号账册 R-17，mainEvent 不该是配角站位的方位场景句", () => {
      const summary = extractChapterSemanticSummary({
        draft: [
          "# 第1章",
          "",
          "唐越蹲在最后一排柜子前，手指摸到最底层抽屉的缝隙。",
          "",
          "里面是一本蓝皮账册，封面上用记号笔写着：R-17。",
          "",
          "江岚站在走廊尽头，手里拿着一个档案袋。",
        ].join("\n"),
        chapter: 1,
        characters: [
          { id: toSafeCharacterId("唐越"), name: "唐越", appearance: {} },
          { id: toSafeCharacterId("江岚"), name: "江岚", appearance: {} },
        ],
        hooks: [],
        defaultCharacterId: toSafeCharacterId("唐越"),
      });
      expect(summary.mainEvent).toContain("R-17");
      expect(summary.mainEvent).not.toContain("站在走廊尽头");
    });

    it("Ch2：核心发现是编号胶片袋 Q-04，mainEvent 不该是方位场景句或纯过渡开门动作", () => {
      const summary = extractChapterSemanticSummary({
        draft: [
          "# 第2章",
          "",
          "走廊尽头，江岚还站在原地。",
          "",
          "江岚从兜里掏出钥匙，拧开锁，推开门。",
          "",
          "袋子不大，封面上用白漆笔写着：Q-04。",
        ].join("\n"),
        chapter: 2,
        characters: [
          { id: toSafeCharacterId("唐越"), name: "唐越", appearance: {} },
          { id: toSafeCharacterId("江岚"), name: "江岚", appearance: {} },
        ],
        hooks: [],
        defaultCharacterId: toSafeCharacterId("唐越"),
      });
      expect(summary.mainEvent).toContain("Q-04");
      expect(summary.mainEvent).not.toContain("还站在原地");
    });

    // 防回归：没有编号锚点时，mainEvent 仍走评分排名的最高分事件句，绝不回退到"站在"方位场景句。
    it("无编号锚点：mainEvent 落在最高分事件句、不被『站在』方位句抢走", () => {
      const summary = extractChapterSemanticSummary({
        draft: [
          "# 第3章",
          "",
          "顾行站在窗边，望着楼下的车流。",
          "",
          "顾行撬开抽屉暗格，取出一沓泛黄的信件。",
        ].join("\n"),
        chapter: 3,
        characters: [{ id: toSafeCharacterId("顾行"), name: "顾行", appearance: {} }],
        hooks: [],
        defaultCharacterId: toSafeCharacterId("顾行"),
      });
      expect(summary.mainEvent).toContain("信件");
      expect(summary.mainEvent).not.toContain("望着楼下");
    });
  });

  // Codex retest7·P1（C 未过，两条独立选句路径残留）：
  //  ① discovery 关键词表含「看见」→ 对白碎片「别让人看见。」命中抢占 discovery，buildMainEvent 优先用 discovery
  //     → mainEvent 变成「别让人看见。」，真正的核心发现句（编号印在封面右上角：K-19）根本没机会。
  //     这是 retest4「闸只布了一条线」在 discovery 选句路径上的残留——对白碎片闸（isBrokenDialogueFragment）
  //     只接在 scoreEventSentence 上，没接 discovery 的 pickDistinct 关键词路径。
  //  ② Ch2 discovery 为空走 fallback，pickMainEventFromRanked 选「带编号锚点的最高分句」——但 K-19 出现在
  //     动作宾语位置（沈明把K-19货单折好，score=角色名+编号=7）压过 P-07（编号在 reveal 标记「标签：」之后）。
  //     「编号是动作对象」≠「编号是本章核心发现」；只有「编号出现在 reveal 标记之后」(写着/印着/标签：/编号：)
  //     才是真正的核心发现句。
  //  修后：① discovery 的 pickDistinct 关键词路径接 isBrokenDialogueFragment 闸，对白碎片不再抢占；
  //        ② mainEvent/discovery 优先选 isCodeRevealSentence（编号在 reveal 标记后）的发现句。
  describe("mainEvent/discovery 选「编号-reveal 句」而非对白碎片/编号动作宾语（Codex retest7）", () => {
    // retest7 Ch1 真机失败：mainEvent=discovery="别让人看见。"
    it("Ch1：discovery 不被对白碎片「别让人看见」抢占，mainEvent 落在编号 K-19 发现句上", () => {
      const summary = extractChapterSemanticSummary({
        draft: [
          "# 第1章",
          "",
          "档案室在二楼最里侧，沈明摸墙走过去。",
          "",
          "白鹭坐在修复台前，台灯照着一本摊开的旧账册。",
          "",
          "“我知道。”沈明拉开靠墙的档案柜，蹲下身，手指顺着柜底木纹摸过去。",
          "",
          "夹层缝隙里夹着一本薄薄的货单，边缘泛黄，纸角卷起。",
          "",
          "编号印在封面右上角：K-19。",
          "",
          "“找到了。”沈明站起来，把货单搁在修复台边沿。",
          "",
          "她合上货单，推到沈明面前。",
          "",
          "“拿走吧。别让人看见。”",
        ].join("\n"),
        chapter: 1,
        characters: [
          { id: toSafeCharacterId("沈明"), name: "沈明", appearance: {} },
          { id: toSafeCharacterId("白鹭"), name: "白鹭", appearance: {} },
        ],
        hooks: [],
        defaultCharacterId: toSafeCharacterId("沈明"),
      });
      // 对白碎片「别让人看见」不该抢占 discovery / mainEvent
      expect(summary.discovery).not.toContain("别让人看见");
      expect(summary.mainEvent).not.toBe("别让人看见。");
      // mainEvent 应落在核心发现句——含编号 K-19（reveal 标记「印在…：」之后）
      expect(summary.mainEvent).toContain("K-19");
    });

    // retest7 Ch2 真机失败：mainEvent="沈明把K-19货单折好，塞进内袋。"（K-19 是动作宾语，非本章发现）
    // 本章真正的核心发现是 P-07（标签：P-07 / 编号P-07缺了一格）。
    it("Ch2：mainEvent 选编号-reveal 句（标签：P-07）而非编号动作宾语句（把K-19货单折好）", () => {
      const summary = extractChapterSemanticSummary({
        draft: [
          "# 第2章",
          "",
          "沈明把K-19货单折好，塞进内袋。",
          "",
          "两人贴着墙根穿过走廊，拐进北塔楼梯间。",
          "",
          "白鹭走到最里面那列柜子前，蹲下，用力一撬——背板松了。",
          "",
          "柜背和墙体之间夹着一卷东西。黑色塑料外壳，边缘贴着手写标签：P-07。",
          "",
          "“K-19不是货单。”她站起来，把胶卷递过去，“是提货索引。”",
          "",
          "“缺了一格。”沈明语气冷淡，拇指按住胶卷边缘，“编号P-07缺了一格。”",
        ].join("\n"),
        chapter: 2,
        characters: [
          { id: toSafeCharacterId("沈明"), name: "沈明", appearance: {} },
          { id: toSafeCharacterId("白鹭"), name: "白鹭", appearance: {} },
        ],
        hooks: [],
        defaultCharacterId: toSafeCharacterId("沈明"),
      });
      // mainEvent 不该是上一章的 K-19 动作宾语句（折货单）
      expect(summary.mainEvent).not.toContain("折好");
      // mainEvent 应是本章核心发现——含 P-07
      expect(summary.mainEvent).toContain("P-07");
    });

    // 防回归：编号 reveal 标记的判定要够准——「编号P-07缺了一格」里「编号」紧贴代号也是 reveal；
    // 但「他把K-19货单折好」K-19 是动作对象（把…宾语）不是 reveal，不该被当核心发现。
    it("区分：编号在 reveal 标记后（标签：/编号+代号）是发现，编号在「把/将」宾语位是动作对象", () => {
      const summary = extractChapterSemanticSummary({
        draft: [
          "# 第3章",
          "",
          "陈默把R-12信封塞进抽屉，转身出门。",
          "",
          "封底用红笔写着：T-90。",
        ].join("\n"),
        chapter: 3,
        characters: [{ id: toSafeCharacterId("陈默"), name: "陈默", appearance: {} }],
        hooks: [],
        defaultCharacterId: toSafeCharacterId("陈默"),
      });
      // R-12 是「把…塞进」的动作宾语，不是本章发现；T-90 在「写着：」reveal 标记后，是发现
      expect(summary.mainEvent).not.toContain("塞进抽屉");
      expect(summary.mainEvent).toContain("T-90");
    });
  });

  // Codex retest9·E 回归 + timelineSummary：retest7 的 code-reveal 优先权修好了 mainEvent/discovery（命中本章编号），
  // 但暴露两个新残留：
  //  ① 对白里也有满足 isCodeRevealSentence 的句子（「"编号M-31的货单。"」——对白内部「编号+代号」），它被 code-reveal
  //     优先权选中、却带着孤儿开引号（句切器在引号处断句），违反 E（孤儿引号）。真机 Ch1 mainEvent="“编号M-31的货单。"。
  //     根因：isCodeRevealSentence 优先权绕过了对白闸（isBrokenDialogueFragment），没排除「对白内部的 code-reveal 句」。
  //     真正干净的 reveal 句是叙述句「封面右上角印着：M-31。」，应优先选它。
  //  ② timelineSummary（selectTimelineSummary 取 scoreEventSentence top-2）被「上一章遗留物的动作宾语句」独占：
  //     「林渡把M-31货单折好，塞进内袋。」（角色名+编号=7分）压过本章 reveal 句「标签贴在金属盒侧面：P-07。」（无角色名=4分），
  //     top-2 全是 M-31 动作句，P-07 reveal 句挤不进摘要。根因：selectTimelineSummary 只看原始分数、
  //     不认 code-reveal 优先（reveal 句是本章核心发现，应优先纳入摘要，哪怕原始分数较低）。
  describe("code-reveal 不选对白碎片、timelineSummary 优先纳入 reveal 句（Codex retest9）", () => {
    // retest9 Ch1 真机失败：mainEvent=discovery=""编号M-31的货单。"（孤儿开引号）
    it("Ch1：对白里的 code-reveal 句（“编号M-31的货单。”）不被选，落在叙述 reveal 句（封面印着：M-31）上，无孤儿引号", () => {
      const summary = extractChapterSemanticSummary({
        draft: [
          "# 第1章",
          "",
          "档案馆的走廊空荡荡的，林渡的脚步声在瓷砖上反弹了两下就消失了。",
          "",
          "“旧海关缉私科的，林渡。”他掏出证件放在台面上，“想查一批档案。”",
          "",
          "许鸢放下镊子，看了证件一眼，没碰。“哪批？”",
          "",
          "“编号M-31的货单。”",
          "",
          "许鸢走到最里面那排，蹲下来，拉开最底层的抽屉。",
          "",
          "林渡蹲下来，接过货单。封面右上角印着：M-31。",
        ].join("\n"),
        chapter: 1,
        characters: [
          { id: toSafeCharacterId("林渡"), name: "林渡", appearance: {} },
          { id: toSafeCharacterId("许鸢"), name: "许鸢", appearance: {} },
        ],
        hooks: [],
        defaultCharacterId: toSafeCharacterId("林渡"),
      });
      // mainEvent 不该是孤儿开引号的对白碎片
      expect(summary.mainEvent).not.toMatch(/^[“"「『]/u);
      expect(summary.discovery).not.toMatch(/^[“"「『]/u);
      // 不该是对白里的「编号M-31的货单」（应排除对白 code-reveal 句）
      expect(summary.mainEvent).not.toBe("“编号M-31的货单。");
      // 应落在干净的叙述 reveal 句上（含 M-31）
      expect(summary.mainEvent).toContain("M-31");
    });

    // retest9 Ch2 真机失败：timelineSummary 被两个 M-31 动作句独占，P-07 reveal 句挤不进
    it("Ch2：timelineSummary 优先纳入本章 code-reveal 句（标签：P-07），不被上一章遗留物动作句独占", () => {
      const summary = extractChapterSemanticSummary({
        draft: [
          "# 第2章",
          "",
          "林渡把M-31货单折好，塞进内袋。",
          "",
          "许鸢盯着他，说：“M-31不是货单，是提货索引。”",
          "",
          "她拐进北塔楼梯间，铁梯扶手积了灰，踩上去吱嘎响。",
          "",
          "许鸢从钥匙圈上挑出一把，插进去转了两圈，咔嗒一声。",
          "",
          "里面躺着一卷胶卷。标签贴在金属盒侧面：P-07。",
          "",
          "林渡把盒子塞进内袋，和M-31货单贴在一起。",
        ].join("\n"),
        chapter: 2,
        characters: [
          { id: toSafeCharacterId("林渡"), name: "林渡", appearance: {} },
          { id: toSafeCharacterId("许鸢"), name: "许鸢", appearance: {} },
        ],
        hooks: [],
        defaultCharacterId: toSafeCharacterId("林渡"),
      });
      const ts = summary.timelineSummary ?? "";
      // timelineSummary 必须含本章 reveal 句 P-07
      expect(ts).toContain("P-07");
      // 不该被「折好，塞进内袋」这类遗留物动作句独占（至少不能两句都是 M-31 动作）
      expect(ts).not.toBe("林渡把M-31货单折好，塞进内袋。 林渡把盒子塞进内袋，和M-31货单贴在一起。");
    });

    // 防回归：无 code-reveal 句时，timelineSummary 仍走原始分数排名（不破坏既有行为）。
    it("无 code-reveal 句时：timelineSummary 仍取最高分事件句（不强行纳入无 reveal 的章节）", () => {
      const summary = extractChapterSemanticSummary({
        draft: [
          "# 第3章",
          "",
          "顾行撬开抽屉暗格，取出一沓泛黄的信件。",
          "",
          "顾行把信件塞进口袋，转身离开。",
        ].join("\n"),
        chapter: 3,
        characters: [{ id: toSafeCharacterId("顾行"), name: "顾行", appearance: {} }],
        hooks: [],
        defaultCharacterId: toSafeCharacterId("顾行"),
      });
      // 无编号 reveal 句 → timelineSummary 走分数排名，含具名事件
      expect(summary.timelineSummary).toContain("顾行");
    });
  });

  // Codex 长跑 15 章·P1：retest7/9 修了 discovery/rankedEvents，但 conflict 仍走 pickFirstDistinct
  // 直取第一个命中「假账/骗局」的句子，没接半截对白闸。于是「陆衡看着他，"假账做得再真…」
  // 会和干净编号 reveal 拼成 mainEvent，重新出现未闭合引号。
  describe("长跑回归：mainEvent 不被 conflict 对白碎片和裸编号标签污染", () => {
    it("conflict 选句也必须排除半截对白，mainEvent 落在干净编号 reveal 句", () => {
      const summary = extractChapterSemanticSummary({
        draft: [
          "# 第3章",
          "",
          "乔宁推开栅栏，手电光扫过台阶。",
          "",
          "周砚拉开柜门，翻到档案袋背面。",
          "",
          "陆衡看着他，“假账做得再真，也是假账。你最好别碰。”",
          "",
          "黑色马克笔写着三个字符：K-02。",
        ].join("\n"),
        chapter: 3,
        characters: [
          { id: toSafeCharacterId("周砚"), name: "周砚", appearance: {} },
          { id: toSafeCharacterId("陆衡"), name: "陆衡", appearance: {} },
          { id: toSafeCharacterId("乔宁"), name: "乔宁", appearance: {} },
        ],
        hooks: [],
        defaultCharacterId: toSafeCharacterId("周砚"),
      });

      expect(summary.mainEvent).toContain("K-02");
      expect(summary.mainEvent).not.toContain("假账做得再真");
      expect(summary.mainEvent).not.toMatch(/[“"「『][^”"」』]*$/u);
    });

    it("裸编号标签（编号F-11）不应压过带演员的实质事件句成为 mainEvent/discovery", () => {
      const summary = extractChapterSemanticSummary({
        draft: [
          "# 第8章",
          "",
          "周砚把F-09的放大照片放在柜台上，指着第七帧画面上那个扎马尾的侧影。",
          "",
          "秦叔放下镊子，摘了放大镜。",
          "",
          "编号F-11。",
        ].join("\n"),
        chapter: 8,
        characters: [
          { id: toSafeCharacterId("周砚"), name: "周砚", appearance: {} },
          { id: toSafeCharacterId("秦叔"), name: "秦叔", appearance: {} },
        ],
        hooks: [],
        defaultCharacterId: toSafeCharacterId("周砚"),
      });

      expect(summary.mainEvent).not.toBe("编号F-11。");
      expect(summary.discovery).not.toBe("编号F-11。");
      expect(summary.mainEvent).toContain("周砚");
      expect(summary.timelineSummary).toContain("F-09");
    });
  });
});

async function createFixtureProject(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "story-engine-semantic-"));
  const { projectDir } = await createStoryProject({
    rootDir,
    title: "语义摘要测试",
    genre: "修仙爽文",
    premise: "用户自己当主角，从外院废柴逆袭到掌控组织。",
    mainCharacterName: "林远",
  });
  await writeFile(
    join(projectDir, "story", "location-bible.json"),
    `${JSON.stringify({
      version: "v0",
      locations: ["外院", "园圃", "账房", "库房"].map((name, index) => ({
        id: `loc-${index}`,
        name,
        type: index === 0 ? "opening" : "scene",
      })),
    }, null, 2)}\n`,
    "utf-8",
  );
  return projectDir;
}

async function writeDraft(projectDir: string, chapter: number, content: string): Promise<void> {
  await writeFile(join(projectDir, "drafts", "fast", `chapter-${String(chapter).padStart(4, "0")}.md`), content, "utf-8");
}

async function seedHookPool(projectDir: string): Promise<void> {
  await mkdir(join(projectDir, "story"), { recursive: true });
  await writeFile(join(projectDir, "story", "hooks.json"), `${JSON.stringify({
    hooks: [
      {
        id: "h-ledger",
        title: "账目",
        description: "组织管事暗中克扣外院资源。",
        status: "seeded",
        relatedCharacters: ["character"],
      },
    ],
  }, null, 2)}\n`, "utf-8");
}

function semanticDraft(): string {
  return [
    "# 第一章 外院账册",
    "",
    "林远在外院园圃被管事当众克扣月钱，还遭到同门挑衅。",
    "",
    "他发现账房角落里藏着一本账目，意识到组织管事暗中克扣外院资源。",
    "",
    "林远得到半枚破损信物，却也被扣掉了本该领到的粮米。",
    "",
    "他决定先去库房查清账册来源，不能再任人打压。",
    "",
    "夜色落下时，后墙传来异常响动，那条线索还没有结束。",
  ].join("\n");
}
