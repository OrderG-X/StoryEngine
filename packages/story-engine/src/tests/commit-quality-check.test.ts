import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkCommitPlanSemanticQuality, checkDraftBeforeCommit, checkWritingContextPackDraft } from "../commit-quality-check.js";
import { createStoryProject } from "../project-store.js";
import type { WritingContextPack } from "../writing-context-pack.js";

describe("commit quality check", () => {
  it("warns when commit plan semantic timeline is too generic", () => {
    const report = checkCommitPlanSemanticQuality({
      timelineEvents: [
        {
          summary: "第 3 章草稿被提交为正式章节。",
          participants: ["character"],
          effects: {
            semanticSummary: {
              chapterSummary: "",
              keyEvents: [],
            },
          },
        },
      ],
    });

    expect(report.passed).toBe(true);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "warning", type: "semantic_timeline_summary_generic" }),
      expect.objectContaining({ severity: "warning", type: "semantic_chapter_summary_missing" }),
      expect.objectContaining({ severity: "warning", type: "semantic_key_events_missing" }),
    ]));
  });

  it("accepts commit plan semantic timeline with real story events", () => {
    const report = checkCommitPlanSemanticQuality({
      timelineEvents: [
        {
          summary: "林远发现账房账目，并决定追查库房账册暗号。",
          participants: ["character"],
          effects: {
            semanticSummary: {
              chapterSummary: "林远发现账房账目，并决定追查库房账册暗号。",
              keyEvents: ["林远发现账房账目。"],
            },
          },
        },
      ],
    });

    expect(report.passed).toBe(true);
    expect(report.issues).toEqual([]);
  });

  it("rejects empty draft content", async () => {
    const projectDir = await createFixtureProject();

    const report = await checkDraftBeforeCommit({ projectDir, chapter: 1, draftContent: "   " });

    expect(report.passed).toBe(false);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "error", type: "empty_draft" }),
    ]));
  });

  it("rejects JSON and tool-call artifacts", async () => {
    const projectDir = await createFixtureProject();

    const jsonReport = await checkDraftBeforeCommit({
      projectDir,
      chapter: 1,
      draftContent: JSON.stringify({ name: "tool", arguments: {} }),
    });
    const toolReport = await checkDraftBeforeCommit({
      projectDir,
      chapter: 1,
      draftContent: "tool_call: write_chapter({})",
    });

    expect(jsonReport.passed).toBe(false);
    expect(toolReport.passed).toBe(false);
    expect(jsonReport.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "error", type: "tool_or_json_artifact" }),
    ]));
    expect(toolReport.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "error", type: "tool_or_json_artifact" }),
    ]));
  });

  it("rejects drafts that do not mention a known character name", async () => {
    const projectDir = await createFixtureProject();

    const report = await checkDraftBeforeCommit({
      projectDir,
      chapter: 1,
      draftContent: longDraft({ characterName: "少年", withTitle: true, withDialogue: true }),
    });

    expect(report.passed).toBe(false);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "error", type: "missing_character_name" }),
    ]));
  });

  it("rejects drafts shorter than 300 Chinese characters", async () => {
    const projectDir = await createFixtureProject();

    const report = await checkDraftBeforeCommit({
      projectDir,
      chapter: 1,
      draftContent: "# 第一章\n\n林远说：“我要留下。”\n",
    });

    expect(report.passed).toBe(false);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "error", type: "too_short" }),
    ]));
  });

  it("uses writing-rule target words to lower the hard short-draft gate", async () => {
    const projectDir = await createFixtureProject();
    await writeFile(
      join(projectDir, "story", "writing-rules.json"),
      `${JSON.stringify({ version: "v0", chapterLength: { targetWords: 200 }, proseStyle: [], genreRequirements: [], suspenseRules: [], payoffRules: [], reversalRules: [], readerExperienceRules: [], forbiddenContent: [], doNotDo: [] }, null, 2)}\n`,
      "utf-8",
    );

    const report = await checkDraftBeforeCommit({
      projectDir,
      chapter: 1,
      draftContent: [
        "# 第一章 外院账册",
        "",
        "林远站在外院园圃的石阶前，把刚领到的账册压在袖中。他没有立刻争辩，只把管事涂改过的粮米数额记下来，准备等夜里核对库房旧账。风从药畦间吹过，他听见同门压低声音提醒：“别在这里翻脸。”林远点头，知道真正的反击要从证据开始。他还记下库房门口两名杂役的换班时间，确认今晚能避开管事的眼线。等钟声落下，他会先查园圃旧锁，再找到账册缺页的去向，把这场羞辱变成可追责的线索。",
      ].join("\n"),
    });

    expect(report.issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "too_short" }),
    ]));
  });

  it("rejects title-only drafts", async () => {
    const projectDir = await createFixtureProject();

    const report = await checkDraftBeforeCommit({
      projectDir,
      chapter: 1,
      draftContent: "# 第一章\n",
    });

    expect(report.passed).toBe(false);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "error", type: "title_only" }),
    ]));
  });

  it("rejects model explanation wording", async () => {
    const projectDir = await createFixtureProject();

    const report = await checkDraftBeforeCommit({
      projectDir,
      chapter: 1,
      draftContent: `${longDraft({ characterName: "林远", withTitle: true, withDialogue: true })}\n以下是本章正文。`,
    });

    expect(report.passed).toBe(false);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "error", type: "model_explanation" }),
    ]));
  });

  it("does not reject ordinary dialogue that says of course", async () => {
    const projectDir = await createFixtureProject();

    const report = await checkDraftBeforeCommit({
      projectDir,
      chapter: 1,
      draftContent: `${longDraft({ characterName: "林远", withTitle: true, withDialogue: true })}\n李明远说：“你当然可以带回去慢慢看。”`,
    });

    expect(report.issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "model_explanation" }),
    ]));
  });

  it("warns when a draft has no obvious chapter title", async () => {
    const projectDir = await createFixtureProject();

    const report = await checkDraftBeforeCommit({
      projectDir,
      chapter: 1,
      draftContent: longDraft({ characterName: "林远", withTitle: false, withDialogue: true }),
    });

    expect(report.passed).toBe(true);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "warning", type: "missing_chapter_title" }),
    ]));
  });

  it("adds info when a draft has no obvious dialogue", async () => {
    const projectDir = await createFixtureProject();

    const report = await checkDraftBeforeCommit({
      projectDir,
      chapter: 1,
      draftContent: longDraft({ characterName: "林远", withTitle: true, withDialogue: false }),
    });

    expect(report.passed).toBe(true);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "info", type: "no_dialogue" }),
    ]));
  });

  it("warns when a recurring character pronoun drifts across chapters", async () => {
    const projectDir = await createFixtureProject();
    await writeFile(
      join(projectDir, "chapters", "0001.md"),
      [
        "# 第一章",
        "",
        "林远在账房外第一次见到沈砚。沈砚说话很轻，却把账册缺页递给他。",
        "沈砚又把半页编号纸递到林远手里。",
        "她提醒林远：“别在这里翻脸，先把证据带出去。”",
      ].join("\n"),
      "utf-8",
    );

    const report = await checkDraftBeforeCommit({
      projectDir,
      chapter: 2,
      draftContent: [
        "# 第二章 账册回声",
        "",
        "林远重新回到账房外，确认管事换班后才靠近窗下。沈砚从檐影里走出来，他拍了拍林远的肩膀，示意他先看门缝里的纸灰。",
        longDraft({ characterName: "林远", withTitle: false, withDialogue: true }),
      ].join("\n"),
    });

    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        severity: "warning",
        type: "cross_chapter_pronoun_drift",
        message: expect.stringContaining("沈砚"),
      }),
    ]));
    expect(report.issues.map((issue) => issue.message).join("\n")).toContain("前文证据");
    expect(report.issues.map((issue) => issue.message).join("\n")).toContain("本章证据");
    expect(report.issues.map((issue) => issue.message).join("\n")).toContain("她提醒林远");
    expect(report.issues.map((issue) => issue.message).join("\n")).toContain("他拍了拍林远");
    expect(report.issues.map((issue) => issue.message).join("\n")).not.toContain("林远 之前按女性/她");
  });

  it("does not reference legacy InkOS packages", async () => {
    const sourcePath = join(import.meta.dirname, "..", "commit-quality-check.ts");
    const source = await import("node:fs/promises").then((fs) => fs.readFile(sourcePath, "utf-8"));

    expect(source).not.toMatch(new RegExp([
      ["packages", "core"].join("/"),
      ["@actalk", "inkos-core"].join("/"),
      ["Pipeline", "Runner"].join(""),
    ].join("|")));
  });

  // R5b 题材中立化护栏：源码不得写死任何题材特定专名（末日/财团/魂钢/申请表/孵化楼…）。
  // 用拆词拼接绕开「pin 测试匹配到测试自身字符串」的问题，逐个断言。
  it("keeps the commit-quality source free of genre-specific proper nouns", async () => {
    const sourcePath = join(import.meta.dirname, "..", "commit-quality-check.ts");
    const source = await import("node:fs/promises").then((fs) => fs.readFile(sourcePath, "utf-8"));
    const bannedTerms = [
      ["豪", "车"].join(""),
      ["别", "墅"].join(""),
      ["黑", "卡"].join(""),
      ["魂", "钢"].join(""),
      ["储物", "戒"].join(""),
      ["百万", "现金"].join(""),
      ["孵化", "楼"].join(""),
      ["行政", "楼"].join(""),
      ["政务", "大厅"].join(""),
      ["中心", "广场"].join(""),
      ["欠费", "手机"].join(""),
      ["申请", "表"].join(""),
      ["公交", "卡"].join(""),
      ["神", "器"].join(""),
    ];
    for (const term of bannedTerms) {
      expect(source, `must not hardcode genre term: ${term}`).not.toContain(term);
    }
  });
});

describe("commit quality writing-context-pack checks (genre-neutral)", () => {
  it("no longer flags a generic genre-specific 'invented asset' table", () => {
    // 旧实现会对正文里出现的「豪车/别墅/魂钢」等专名报 invented_asset；题材中立化后该写死表已删，
    // 任何题材的具体物名都不应仅凭出现就被当作「凭空捏造关键资产」。
    const pack = makePack();
    const body = "他开着一辆豪车驶进别墅区，腰间挂着一枚储物戒，里面还压着百万现金。";
    const issues = checkWritingContextPackDraft(body, pack, 5);
    expect(issues.map((issue) => issue.type)).not.toContain("writing_context_invented_asset");
  });

  it("counts a setup asset as used even when only the core noun (no status prefix) appears", () => {
    // ②：containsAssetReference 改成读资产名派生 token，正文写「申请表」即算引用了登记的「半张申请表」。
    const pack = makePack({
      setupKeyItems: ["半张申请表"],
    });
    const usedBody = "他从怀里掏出那张申请表，在窗口前递了上去，等待盖章。这一章他始终守在政务窗口。".repeat(2);
    const issues = checkWritingContextPackDraft(usedBody, pack, 5);
    expect(issues.map((issue) => issue.type)).not.toContain("writing_context_setup_asset_missing");
  });

  it("still warns when no setup asset is referenced at all", () => {
    const pack = makePack({ setupKeyItems: ["半张申请表"] });
    const body = "他在街上漫无目的地走着，什么也没带，只是看着行人来来往往，心里盘算下一步。".repeat(2);
    const issues = checkWritingContextPackDraft(body, pack, 5);
    expect(issues.map((issue) => issue.type)).toContain("writing_context_setup_asset_missing");
  });

  it("warns when a registered unavailable asset is written as suddenly working again (any genre)", () => {
    // ④：欠费手机/失灵设备凭空恢复——用「不可用资产名命中 + 恢复正常描述」的通用判定。
    const pack = makePack({
      unavailableAssets: ["旧手机 · damaged · 长期欠费停机"],
    });
    const body = "他掏出那部旧手机，屏幕忽然恢复正常，信号满格，顺利打通了对方的电话。".repeat(2);
    const issues = checkWritingContextPackDraft(body, pack, 5);
    expect(issues.map((issue) => issue.type)).toContain("writing_context_unavailable_asset_used");
  });

  it("does not warn when an unavailable asset is merely mentioned without being restored", () => {
    const pack = makePack({
      unavailableAssets: ["旧手机 · damaged · 长期欠费停机"],
    });
    const body = "他看着那部欠费停机的旧手机，黑着屏，没有半点反应，只能无奈地把它塞回口袋。".repeat(2);
    const issues = checkWritingContextPackDraft(body, pack, 5);
    expect(issues.map((issue) => issue.type)).not.toContain("writing_context_unavailable_asset_used");
  });

  it("warns when a broken plot-critical asset is magically made complete again", () => {
    const pack = makePack({
      plotCriticalAssets: ["半张地图 · damaged · 缺了另一半"],
    });
    const body = "他低头一看，手里那张地图竟变得完整无缺，整张铺展开来，纹路清晰可辨。".repeat(2);
    const issues = checkWritingContextPackDraft(body, pack, 5);
    expect(issues.map((issue) => issue.type)).toContain("writing_context_unavailable_asset_used");
  });

  it("does not warn for a plot-critical asset that carries no broken/partial signal", () => {
    const pack = makePack({
      plotCriticalAssets: ["传家玉佩 · 祖辈相传"],
    });
    const body = "他握着那枚完整的传家玉佩，温润光滑，想起祖辈的嘱托，决定带着它继续上路。".repeat(2);
    const issues = checkWritingContextPackDraft(body, pack, 5);
    expect(issues.map((issue) => issue.type)).not.toContain("writing_context_unavailable_asset_used");
  });

  it("flags only generic building-suffix locations outside the bible, not baked-in proper nouns", () => {
    // ③：地点漂移检测保留通用建筑后缀（学校/大楼/大厅/广场/中心），删了「孵化楼/政务大厅」等专名表。
    const pack = makePack({ nearbyLocations: ["明德中学"] });
    const body = "他先回到明德中学门口确认，又顺路绕去了陌生的星汉大楼，那是资料里从没出现过的地方。".repeat(2);
    const issues = checkWritingContextPackDraft(body, pack, 5);
    const driftIssue = issues.find((issue) => issue.type === "writing_context_location_drift");
    expect(driftIssue?.message ?? "").toContain("星汉大楼");
    expect(driftIssue?.message ?? "").not.toContain("明德中学");
  });

  it("地点漂移不再把『城市/上市/市场』当地名（治糙正则误报）", () => {
    const pack = makePack({});
    const body = "他在这个城市里待了三年，家里的公司刚在纳斯达克上市，今天还要去做一次市场调研。".repeat(2);
    const issues = checkWritingContextPackDraft(body, pack, 5);
    expect(issues.map((i) => i.type)).not.toContain("writing_context_location_drift");
  });

  it("通用『市中心/购物中心』不当被捏造的场所", () => {
    const pack = makePack({});
    const body = "他约在市中心碰头，又拐进旁边的购物中心买了杯咖啡。".repeat(2);
    const issues = checkWritingContextPackDraft(body, pack, 5);
    expect(issues.map((i) => i.type)).not.toContain("writing_context_location_drift");
  });

  it("身份漂移不把『那家公司/现在连公司/家里公司』句子碎片当编造身份", () => {
    const pack = makePack({});
    const body = "他知道家里公司的底细，可现在连公司都快保不住了，那家公司早就被掏空。".repeat(2);
    const issues = checkWritingContextPackDraft(body, pack, 5);
    expect(issues.map((i) => i.type)).not.toContain("writing_context_identity_detail_drift");
  });

  it("身份漂移仍抓主角名旁的真机构专名（主角被捏造身份）", () => {
    const pack = makePack({ protagonistName: "林远" });
    const body = "林远递上名片，说自己是星海科技公司的人，对方愣了一下。";
    const issues = checkWritingContextPackDraft(body, pack, 5);
    const drift = issues.find((i) => i.type === "writing_context_identity_detail_drift");
    expect(drift?.message ?? "").toContain("星海科技公司");
  });

  it("身份漂移不算配角的公司（离主角名远）", () => {
    const pack = makePack({ protagonistName: "林远" });
    // 配角郑元泰的航运集团、环境里泛提的上市公司，都离主角名 >12 字 → 不是主角身份漂移。
    const body = "林远在沙发上慢慢坐下来，旁边有人闲聊起来，说郑元泰的航运集团最近又吃下两家上市公司，财大气粗。";
    const issues = checkWritingContextPackDraft(body, pack, 5);
    expect(issues.map((i) => i.type)).not.toContain("writing_context_identity_detail_drift");
  });

  it("年龄漂移：别的角色的年龄不算主角漂移", () => {
    const pack = makePack({ protagonistName: "林远", protagonistAge: "24" });
    // 林远只在开头出现一次；别人的年龄都离主角名 >12 字，不该判主角年龄漂移。
    const body = "林远刚进门，屋里已经坐了不少人，气氛压抑。对面那个男人慢慢抬眼，看着像五十岁上下，墙角还窝着一个六十岁的老者，眯着眼一言不发。";
    const issues = checkWritingContextPackDraft(body, pack, 5);
    expect(issues.map((i) => i.type)).not.toContain("writing_context_age_drift");
  });

  it("年龄漂移：主角名旁边写错年龄仍抓", () => {
    const pack = makePack({ protagonistName: "林远", protagonistAge: "24" });
    const body = "今年三十岁的林远叹了口气，觉得自己老了。".repeat(2);
    const issues = checkWritingContextPackDraft(body, pack, 5);
    const drift = issues.find((i) => i.type === "writing_context_age_drift");
    expect(drift?.message ?? "").toContain("三十岁");
  });
});

async function createFixtureProject(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "story-engine-quality-"));
  const { projectDir } = await createStoryProject({
    rootDir,
    title: "质量检查测试",
    genre: "修仙爽文",
    premise: "用户自己当主角，从外院废柴逆袭到掌控组织。",
    mainCharacterName: "林远",
  });
  await writeFile(
    join(projectDir, "drafts", "fast", "chapter-0001.md"),
    longDraft({ characterName: "林远", withTitle: true, withDialogue: true }),
    "utf-8",
  );
  return projectDir;
}

function longDraft(input: {
  readonly characterName: string;
  readonly withTitle: boolean;
  readonly withDialogue: boolean;
}): string {
  const title = input.withTitle ? "# 第一章 外院园圃\n\n" : "";
  const dialogue = input.withDialogue ? `${input.characterName}说：“我不会再让他们随意夺走我的月钱。”\n\n` : "";
  const paragraph = [
    `${input.characterName}站在外院园圃的青石路上，袖口沾着晨露和药泥，心里却比任何时候都清醒。`,
    "管事刚刚把最差的灵田分给他，又当着众人的面扣下半袋粮米，仿佛这只是成员理所当然要吞下的苦头。",
    "他没有立刻争辩，而是把账册上每一个被涂改的数字都记在心里，知道真正的机会不会来自怒火，只会来自证据、耐心和一次准确的反击。",
  ].join("");
  return `${title}${dialogue}${Array.from({ length: 5 }, () => paragraph).join("\n\n")}\n`;
}

/**
 * 构造一个最小但结构完整的 WritingContextPack，专给 checkWritingContextPackDraft 的题材中立检测做单测。
 * 只填测试关心的字段（资产 / 地点），其余按类型给空值，避免触发无关检测的副作用。
 */
function makePack(overrides: {
  readonly setupKeyItems?: readonly string[];
  readonly unavailableAssets?: readonly string[];
  readonly plotCriticalAssets?: readonly string[];
  readonly nearbyLocations?: readonly string[];
  readonly protagonistName?: string;
  readonly protagonistAge?: string;
} = {}): WritingContextPack {
  return {
    chapterTask: { chapterNumber: 5, userDirection: "", currentChapterGoal: "" },
    protagonistContext: {
      name: overrides.protagonistName ?? "主角",
      ...(overrides.protagonistAge ? { age: overrides.protagonistAge } : {}),
      behaviorBoundaries: [],
      knownFacts: [],
      unknownTruths: [],
      forbiddenReveals: [],
      resourcesLimit: [],
      speechSamples: [],
      cannotDo: [],
      extraFields: [],
    },
    supportingCast: [],
    locationContext: {
      travelRules: [],
      fixedFacts: [],
      locationRisks: [],
      locationResources: [],
      nearbyLocations: overrides.nearbyLocations ?? [],
      extraFields: [],
      locationDoNotInventRule: "",
    },
    worldRulesContext: {
      coreRules: [],
      resourceRules: [],
      socialOrder: [],
      factions: [],
      conflictSources: [],
      hiddenTruths: [],
      protectedSecrets: [],
    },
    assetContext: {
      initialAssets: [],
      keyItems: overrides.setupKeyItems ?? [],
      resourceLimits: [],
      importantCarriedItems: [],
      carriedAssets: [],
      ownedAssets: [],
      usableAssets: [],
      unavailableAssets: overrides.unavailableAssets ?? [],
      plotCriticalAssets: overrides.plotCriticalAssets ?? [],
      assetHardRules: [],
      extraFields: [],
      assetDoNotInventRule: "",
    },
    continuityFocus: {
      recentTimelineEvents: [],
      mustCarryHooks: [],
      mustCarryThreads: [],
      arcGoalFocus: [],
      establishedFacts: [],
    },
    writingRulesContext: {
      proseStyle: [],
      forbiddenContent: [],
      doNotDo: [],
      readerExperienceRules: [],
      styleExemplars: [],
    },
    hardConstraints: [],
    sourceTrace: [],
  };
}
