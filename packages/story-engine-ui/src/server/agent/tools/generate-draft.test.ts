// @vitest-environment node
//
// generate_draft 纯逻辑单测：复刻 routes/draft.ts 的 runFastDraft 落工作稿编排（进程内）。
// 草稿待保存 → 不建 git 快照（withSnapshot 不参与）；写盘后 refreshScope:"full"。
// writerClient 注入一个 mock model（不调真实 LLM），引擎应用走临时项目 fixture。
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createStoryProject, countDraftChineseCharacters, runFastDraft, type StateOverview, type WriterClient } from "@actalk/story-engine";
import type { ToolExecutionContext } from "@mastra/core/tools";
import { describe, expect, it, vi } from "vitest";

import { writeFile } from "node:fs/promises";

import { ALIAS_TABLE_RELATIVE_PATH } from "../alias-generator/alias-generator.js";
import { defaultCommittedChapterPath, defaultDraftPath } from "../../lib/project-io.js";
import { makeWriterRankContext } from "../context-budget/rank-writer-context.js";
import { buildProjectRequestContext } from "../request-context.js";
import {
  advancePastCommittedFrontier,
  aiFlavorWeightedScore,
  attachCandidateExcerpts,
  attachCandidateTemperatures,
  buildAiFlavorInfo,
  buildAiFlavorWarning,
  buildAutoDeAiNote,
  buildCandidateExcerpt,
  buildCandidateSummaryLine,
  buildDraftLengthInfo,
  buildDraftLengthWarning,
  buildNoWriteIntentBlockedOutput,
  buildSequencingBlockedOutput,
  DRAFT_CANDIDATE_SCORE_WEIGHTS,
  DRAFT_CANDIDATE_TEMPERATURE_OFFSETS,
  generateDraftTool,
  isChapterCommitted,
  pickAutoDeAiTargets,
  positiveOrUndefined,
  rankDraftCandidates,
  readDraftBodyWithRetry,
  resolveCandidateTemperatures,
  runGenerateDraftToolLogic,
  scoreDraftCandidate,
  type DraftCandidateScoreInput,
} from "./generate-draft.js";

describe("positiveOrUndefined（模型把 0 当『默认/不限』用 → 归一成 undefined，让 ?? 默认 兜底）", () => {
  it("0/负/NaN/undefined → undefined；正数原样", () => {
    expect(positiveOrUndefined(0)).toBeUndefined();
    expect(positiveOrUndefined(-5)).toBeUndefined();
    expect(positiveOrUndefined(Number.NaN)).toBeUndefined();
    expect(positiveOrUndefined(undefined)).toBeUndefined();
    expect(positiveOrUndefined(8)).toBe(8);
    expect(positiveOrUndefined(12_000)).toBe(12_000);
  });
});

async function makeProject(title: string, mainCharacterName = "林远"): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "gen-draft-test-"));
  const { projectDir } = await createStoryProject({
    rootDir,
    title,
    genre: "都市",
    premise: "主角进入权力中心。",
    mainCharacterName,
  });
  return projectDir;
}

/** 构造一个返回固定长正文的 mock writerClient（不调真实模型）。 */
function mockWriterClient(body: string): WriterClient {
  return {
    async generateDraft({ context }) {
      return { title: `第${context.chapter}章`, content: body };
    },
  };
}

/** 够长（>200 中文字、>=3 段）且提及主角的正文，确保通过引擎长度/有效性门槛。 */
function longBody(mainCharacterName: string): string {
  const para = `${mainCharacterName}在走廊尽头停下脚步，反复掂量手里这份账册的分量，心里盘算着接下来每一步该怎么走才不至于落人话柄。`;
  return [para, para, para, para].join("\n\n");
}

async function seedSecondaryCharacter(projectDir: string): Promise<void> {
  const characterDir = join(projectDir, "characters", "lin-wan-qing");
  await mkdir(characterDir, { recursive: true });
  await writeFile(join(characterDir, "profile.json"), `${JSON.stringify({ id: "lin-wan-qing", name: "林婉清" }, null, 2)}\n`, "utf-8");
  await writeFile(join(characterDir, "core.json"), `${JSON.stringify({ characterId: "lin-wan-qing", personality: ["冷静"] }, null, 2)}\n`, "utf-8");
  await writeFile(join(characterDir, "state.json"), `${JSON.stringify({ characterId: "lin-wan-qing", emotion: "calm", goal: "assist", lastUpdatedChapter: null }, null, 2)}\n`, "utf-8");
}

async function seedMainCharacter(projectDir: string): Promise<void> {
  const characterDir = join(projectDir, "characters", "guo-xu");
  await mkdir(characterDir, { recursive: true });
  await writeFile(join(characterDir, "profile.json"), `${JSON.stringify({ id: "guo-xu", name: "林远", identity: "protagonist", appearance: {}, tags: [] }, null, 2)}\n`, "utf-8");
  await writeFile(join(characterDir, "core.json"), `${JSON.stringify({ characterId: "guo-xu", personality: ["谨慎"], speechStyle: "克制" }, null, 2)}\n`, "utf-8");
  await writeFile(join(characterDir, "state.json"), `${JSON.stringify({ characterId: "guo-xu", emotion: "alert", goal: "进入核心场景", lastUpdatedChapter: null }, null, 2)}\n`, "utf-8");
}

describe("generate_draft 写工作稿工具", () => {
  it("生成成功 → 写入工作稿文件，返回 draftPath/draftBody 与 refreshScope:full，且不带 snapshotId（草稿不建 git 快照）", async () => {
    const projectDir = await makeProject("出稿", "林远");
    const out = await runGenerateDraftToolLogic({
      projectDir,
      chapter: 1,
      chapterGoal: "第 1 章：主角初入局。",
      writerClient: mockWriterClient(longBody("林远")),
    });
    expect(out.ok).toBe(true);
    expect(out.refreshScope).toBe("full");
    expect(out.draftPath).toBe(defaultDraftPath(projectDir, 1));
    expect(out.draftBody && out.draftBody.includes("林远")).toBe(true);
    // 草稿待保存：不建 git 快照、不带 snapshotId
    expect("snapshotId" in out).toBe(false);
    // 工作稿确实落盘
    const onDisk = await readFile(defaultDraftPath(projectDir, 1), "utf-8");
    expect(onDisk).toContain("林远");
    // overview 供前端刷新
    expect(out.overview).toBeTruthy();
  });

  // Codex 复测额外发现：首稿把「第三块砖→第三层杂志架」「债权池A-17→数字串」。mustHitBeats 注入硬约束 +
  // 出稿后确定性核对，漏写/改写 → summary 带「首稿核对」软警告，让 agent 如实转达、问用户要不要改稿。
  it("mustHitBeats 里的具体锚点漏写/被改写 → summary 带首稿核对软警告", async () => {
    const projectDir = await makeProject("保真漏", "林远");
    const body = [longBody("林远"), "林远撬开第三层杂志架后面的暗格，取出薄铁盒，收据背面写着债权池17号。"].join("\n\n");
    const out = await runGenerateDraftToolLogic({
      projectDir,
      chapter: 1,
      mustHitBeats: ["第三块砖", "债权池A-17"],
      writerClient: mockWriterClient(body),
    });
    expect(out.ok).toBe(true);
    expect(out.summary).toContain("首稿核对");
    expect(out.summary).toContain("第三块砖");
    expect(out.summary).toContain("债权池A-17");
  });

  it("mustHitBeats 都写到了 → summary 不带首稿核对警告", async () => {
    const projectDir = await makeProject("保真中", "林远");
    const body = [longBody("林远"), "林远撬开第三块砖后面的暗格，取出薄铁盒，收据背面写着债权池A-17。"].join("\n\n");
    const out = await runGenerateDraftToolLogic({
      projectDir,
      chapter: 1,
      mustHitBeats: ["第三块砖", "债权池A-17"],
      writerClient: mockWriterClient(body),
    });
    expect(out.ok).toBe(true);
    expect(out.summary).not.toContain("首稿核对");
  });

  it("模型返回工具/JSON 伪正文 → 引擎拒绝写盘，诚实回报 ok=false（含 issues），不谎称成功", async () => {
    const projectDir = await makeProject("无效", "林远");
    const out = await runGenerateDraftToolLogic({
      projectDir,
      chapter: 1,
      chapterGoal: "第 1 章。",
      // 看起来像 JSON/工具调用产物 → 引擎 validateDraft 判无效，passed:false。
      writerClient: mockWriterClient('{"tool":"call","args":{}}'),
    });
    expect(out.ok).toBe(false);
    expect(out.draftPath).toBeUndefined();
    expect(out.issues.length).toBeGreaterThan(0);
    expect(out.summary).toMatch(/未通过|未写入|拒绝/u);
  });

  it("透传 selectedCharacterIds / selectedHookIds / maxTimelineEvents 给 FastDraft context", async () => {
    const projectDir = await makeProject("选中上下文", "林远");
    await seedSecondaryCharacter(projectDir);
    const writerClient: WriterClient = {
      async generateDraft({ context }) {
        expect(context.trace.selectedCharacters).toEqual(["lin-wan-qing"]);
        expect(context.sections.find((section) => section.name === "character_profile")?.content).toEqual([
          expect.objectContaining({ id: "lin-wan-qing", name: "林婉清" }),
        ]);
        return { title: `第${context.chapter}章`, content: longBody("林婉清") };
      },
    };

    const out = await runGenerateDraftToolLogic({
      projectDir,
      chapter: 1,
      chapterGoal: "林婉清出场。",
      selectedCharacterIds: ["lin-wan-qing"],
      selectedHookIds: ["h-ledger"],
      maxTimelineEvents: 2,
      writerClient,
    });

    expect(out.ok).toBe(true);
  });

  // P1 集成断言（复审实锤）：显式 selectedCharacterIds 是「bible 有、但缺 characters/<id>/ 三件套文件」的幽灵 id 时，
  // 过滤层必须把它判为不可读、丢弃、回落自动检测——整条 generate_draft → buildWriterContext 不再 ENOENT 崩。
  it("显式 selectedCharacterIds 是 bible 有、三件套文件缺的幽灵 id → 过滤回落、整条不 ENOENT 崩、幽灵 id 不进 context", async () => {
    const projectDir = await makeProject("册有文件缺", "林远");
    const biblePath = join(projectDir, "story", "character-bible.json");
    const bible = JSON.parse(await readFile(biblePath, "utf-8")) as { readonly characters: { id: string; name: string; role: string }[] };
    bible.characters.push({ id: "ghost-no-files", name: "幽灵", role: "配角" }); // 只进册、不建文件（真书角色都有 role）
    await writeFile(biblePath, `${JSON.stringify(bible, null, 2)}\n`, "utf-8");

    let contextIds: readonly string[] = [];
    const writerClient: WriterClient = {
      async generateDraft({ context }) {
        contextIds = context.trace.selectedCharacters ?? [];
        return { title: `第${context.chapter}章`, content: longBody("林远") };
      },
    };

    const out = await runGenerateDraftToolLogic({
      projectDir,
      chapter: 1,
      chapterGoal: "推进剧情。",
      selectedCharacterIds: ["ghost-no-files"],
      writerClient,
    });

    expect(out.ok).toBe(true); // 没有 ENOENT 崩
    expect(contextIds).not.toContain("ghost-no-files"); // 幽灵 id 没被直透下游 context
  });

  it("omitted selectedCharacterIds are resolved from chapter goal and previous chapter aliases before FastDraft", async () => {
    const projectDir = await makeProject("自动挑角色", "林远");
    await seedMainCharacter(projectDir);
    await seedSecondaryCharacter(projectDir);
    await writeFile(
      join(projectDir, "story", "character-bible.json"),
      `${JSON.stringify({
        version: "v0",
        characters: [
          { id: "guo-xu", name: "林远", role: "主角" },
          { id: "lin-wan-qing", name: "林婉清", role: "老师" },
        ],
      }, null, 2)}\n`,
      "utf-8",
    );
    await mkdir(join(projectDir, ".story-engine-ui"), { recursive: true });
    await writeFile(
      join(projectDir, ALIAS_TABLE_RELATIVE_PATH),
      `${JSON.stringify({
        version: "v0",
        byEntity: {
          "guo-xu": { canonicalName: "林远", primary: "林远", aliases: ["林总"], generated: ["林总"], type: "character" },
          "lin-wan-qing": { canonicalName: "林婉清", primary: "林婉清", aliases: ["林老师"], generated: ["林老师"], type: "character" },
        },
        conflicts: [],
      }, null, 2)}\n`,
      "utf-8",
    );
    await mkdir(join(projectDir, "chapters"), { recursive: true });
    await writeFile(join(projectDir, "chapters", "0001.md"), "# 第一章\n\n林老师在门外递来一份资料。", "utf-8");
    const writerClient: WriterClient = {
      async generateDraft({ context }) {
        expect(context.trace.selectedCharacters).toEqual(expect.arrayContaining(["guo-xu", "lin-wan-qing"]));
        return { title: `第${context.chapter}章`, content: longBody("林远") };
      },
    };

    const out = await runGenerateDraftToolLogic({
      projectDir,
      chapter: 2,
      chapterGoal: "继续写林总处理资料。",
      writerClient,
    });

    expect(out.ok).toBe(true);
    expect(out.characterSelection?.selectedCharacterIds).toEqual(expect.arrayContaining(["guo-xu", "lin-wan-qing"]));
    expect(out.summary).toContain("本章相关角色：林远、林婉清");
  });

  it("returns context budget dropped sections when the tool ranker trims dynamic context", async () => {
    const projectDir = await makeProject("预算诊断", "林远");
    await writeFile(
      join(projectDir, "timeline", "events.json"),
      `${JSON.stringify(Array.from({ length: 8 }, (_, index) => ({
        id: `event-${index + 1}`,
        chapter: index + 1,
        summary: `林远在第${index + 1}章持续追查一条很长的线索，线索包含地点、对手、证据和下一步压力。`,
        participants: ["guo-xu"],
      })), null, 2)}\n`,
      "utf-8",
    );

    const out = await runGenerateDraftToolLogic({
      projectDir,
      chapter: 1,
      chapterGoal: "第 1 章：主角初入局。",
      contextTokenBudget: 1,
      writerClient: mockWriterClient(longBody("林远")),
    });

    expect(out.ok).toBe(true);
    expect(out.contextBudget?.droppedSections.length).toBeGreaterThan(0);
  });

  // 收口洞①（总放大器）：生产出稿路径即便用户没给 contextTokenBudget，也必须套用默认预算，
  // 否则 Phase 0/1 的全部 dynamic 裁剪在真实写作里是死的。这里用一份超大的 timeline（远超默认
  // 预算）+ 省略 contextTokenBudget，断言现在仍会裁掉低优先 dynamic 段。改前=undefined→no-op→不裁（RED）。
  it("省略 contextTokenBudget 时，生产路径仍套用默认预算裁剪超大 dynamic 上下文（洞①通电）", async () => {
    const projectDir = await makeProject("默认预算通电", "林远");
    const bigSummary =
      "林远在这一章里辗转于城北的旧仓库、城南的码头和市中心的写字楼之间，反复核对一份牵涉金额、时间、地点与多方对手的复杂账目，" +
      "每一步都要权衡眼前的证据与背后的压力，生怕走错一步就满盘皆输，于是把每一个细节都记在心里反复掂量。";
    await writeFile(
      join(projectDir, "timeline", "events.json"),
      `${JSON.stringify(Array.from({ length: 400 }, (_, index) => ({
        id: `event-${index + 1}`,
        chapter: index + 1,
        summary: `第${index + 1}章：${bigSummary}`,
        participants: ["guo-xu"],
      })), null, 2)}\n`,
      "utf-8",
    );

    const out = await runGenerateDraftToolLogic({
      projectDir,
      chapter: 1,
      chapterGoal: "第 1 章：主角初入局。",
      // 故意不传 contextTokenBudget —— 模拟 agent 生产路径
      maxTimelineEvents: 400,
      writerClient: mockWriterClient(longBody("林远")),
    });

    expect(out.ok).toBe(true);
    expect(out.contextBudget?.droppedSections.length).toBeGreaterThan(0);
  });

  it("keeps stable prompt prefix cache-safe when the production ranker trims dynamic context", async () => {
    const projectDir = await makeProject("缓存安全", "林远");
    await writeFile(
      join(projectDir, "timeline", "events.json"),
      `${JSON.stringify(Array.from({ length: 8 }, (_, index) => ({
        id: `event-${index + 1}`,
        chapter: index + 1,
        summary: `林远在第${index + 1}章持续追查一条很长的线索，线索包含地点、对手、证据和下一步压力。`,
        participants: ["guo-xu"],
      })), null, 2)}\n`,
      "utf-8",
    );
    const writerClient = mockWriterClient(longBody("林远"));
    const baseline = await runFastDraft({
      projectDir,
      chapter: 1,
      chapterGoal: "第 1 章：主角初入局。",
      writerClient,
      dryRun: true,
      maxTimelineEvents: 8,
    });
    const rankedContext = makeWriterRankContext({ tokenBudget: 1 });

    const ranked = await runFastDraft({
      projectDir,
      chapter: 1,
      chapterGoal: "第 1 章：主角初入局。",
      writerClient,
      dryRun: true,
      maxTimelineEvents: 8,
      rankContext: rankedContext.rankContext,
    });

    expect(rankedContext.droppedSections.length).toBeGreaterThan(0);
    expect(ranked.promptFingerprint.stablePrefixHash).toBe(baseline.promptFingerprint.stablePrefixHash);
    expect(ranked.promptFingerprint.dynamicSuffixHash).not.toBe(baseline.promptFingerprint.dynamicSuffixHash);
  });
});

describe("draftLength 字数透明（一次成稿不重试：低于下限不拒绝、如实标注）", () => {
  it("buildDraftLengthInfo：只提纯关键字段（目标区间/实际字数/状态/来源），不带 retryReason/裁剪细节", () => {
    const info = buildDraftLengthInfo({
      requestedDraftLength: 1800,
      lowerBound: 1530,
      upperBound: 2070,
      actualLength: 200,
      lengthStatus: "below_lower_bound",
      source: "writing_rules",
      retryReason: "below_lower_bound",
      whetherTrimmed: false,
    });
    expect(info).toEqual({
      requestedDraftLength: 1800,
      lowerBound: 1530,
      upperBound: 2070,
      actualLength: 200,
      lengthStatus: "below_lower_bound",
      source: "writing_rules",
    });
  });

  it("buildDraftLengthWarning：below_lower_bound → ⚠ 标注（实际X字/下限Y字）；其余状态 → 空串", () => {
    const base = { requestedDraftLength: 1800, lowerBound: 1530, upperBound: 2070, source: "writing_rules" as const };
    expect(buildDraftLengthWarning({ ...base, actualLength: 200, lengthStatus: "below_lower_bound" }))
      .toBe("⚠ 低于目标字数下限（实际200字/下限1530字）。可以按原样接受，或让我重写一版补足字数。");
    expect(buildDraftLengthWarning({ ...base, actualLength: 1700, lengthStatus: "within_range" })).toBe("");
    expect(buildDraftLengthWarning({ ...base, actualLength: 2500, lengthStatus: "above_upper_bound" })).toBe("");
  });

  it("正文低于目标字数下限 → 仍 ok:true 照写盘（不拒绝、不自动补写），draftLength 透出 + summary 打 ⚠ 标注", async () => {
    const projectDir = await makeProject("字数透明", "林远");
    const shortBody = "林远走进了房间。"; // 远低于新项目写作规则目标 1800 的下限 1530
    const out = await runGenerateDraftToolLogic({
      projectDir,
      chapter: 1,
      chapterGoal: "第 1 章。",
      writerClient: mockWriterClient(shortBody),
    });
    // 低于下限不拒绝：照常出稿写盘
    expect(out.ok).toBe(true);
    const onDisk = await readFile(defaultDraftPath(projectDir, 1), "utf-8");
    expect(onDisk).toContain("林远走进了房间");
    // draftLength 关键信息进输出（新项目目标来自写作规则 1800 → 下限 1530/上限 2070）
    expect(out.draftLength).toEqual({
      requestedDraftLength: 1800,
      lowerBound: 1530,
      upperBound: 2070,
      actualLength: countDraftChineseCharacters(shortBody),
      lengthStatus: "below_lower_bound",
      source: "writing_rules",
    });
    // summary 如实标注，agent 可转达用户决定重写或接受
    expect(out.summary).toContain(
      `⚠ 低于目标字数下限（实际${countDraftChineseCharacters(shortBody)}字/下限1530字）`,
    );
  });

  it("字数落在目标区间内 → lengthStatus=within_range，summary 不带 ⚠ 字数标注", async () => {
    const projectDir = await makeProject("字数达标", "林远");
    const para = "林远在走廊尽头停下脚步，反复掂量手里这份账册的分量，心里盘算着接下来每一步该怎么走才不至于落人话柄。";
    const repeats = Math.ceil(1700 / countDraftChineseCharacters(para)); // 落进 1530–2070 区间
    const body = Array.from({ length: repeats }, () => para).join("\n\n");
    const out = await runGenerateDraftToolLogic({
      projectDir,
      chapter: 1,
      chapterGoal: "第 1 章。",
      writerClient: mockWriterClient(body),
    });
    expect(out.ok).toBe(true);
    expect(out.draftLength?.lengthStatus).toBe("within_range");
    expect(out.draftLength?.actualLength).toBeGreaterThanOrEqual(out.draftLength?.lowerBound ?? 0);
    expect(out.draftLength?.actualLength).toBeLessThanOrEqual(out.draftLength?.upperBound ?? Number.MAX_SAFE_INTEGER);
    expect(out.summary).not.toContain("低于目标字数下限");
  });

  it("显式 requestedDraftLength → 目标来源如实标为 user", async () => {
    const projectDir = await makeProject("用户定字数", "林远");
    const out = await runGenerateDraftToolLogic({
      projectDir,
      chapter: 1,
      requestedDraftLength: 300,
      writerClient: mockWriterClient(longBody("林远")),
    });
    expect(out.ok).toBe(true);
    expect(out.draftLength?.requestedDraftLength).toBe(300);
    expect(out.draftLength?.source).toBe("user");
  });

  it("引擎校验不过（passed:false）→ ok:false 之外同样带出 draftLength（失败也透明，不藏）", async () => {
    const projectDir = await makeProject("失败带字数", "林远");
    const out = await runGenerateDraftToolLogic({
      projectDir,
      chapter: 1,
      chapterGoal: "第 1 章。",
      writerClient: mockWriterClient('{"tool":"call","args":{}}'),
    });
    expect(out.ok).toBe(false);
    expect(out.draftLength).toBeDefined();
    expect(out.draftLength?.actualLength).toBe(0); // JSON 伪正文无中文字符
    expect(out.draftLength?.lengthStatus).toBe("below_lower_bound");
  });
});

describe("readDraftBodyWithRetry（L1 回读兜底）", () => {
  it("文件有正文 → 去标题返回正文", async () => {
    const projectDir = await makeProject("回读", "林远");
    const path = defaultDraftPath(projectDir, 2);
    await writeFile(path, "# 第二章\n\n林远走进了房间，停在窗前。", "utf-8");
    const body = await readDraftBodyWithRetry(path, { delayMs: 0 });
    expect(body).toBe("林远走进了房间，停在窗前。");
  });

  it("文件读不到（极少数 FS 抖动模拟）→ 重试后仍空返回空字符串（调用方据此沿用旧稿、不谎报失败）", async () => {
    const body = await readDraftBodyWithRetry("/nonexistent/path/chapter-0001.md", { retries: 3, delayMs: 0 });
    expect(body).toBe("");
  });
});

describe("章序护栏（防穿帮）", () => {
  it("buildSequencingBlockedOutput：ok:false + 结构化 reason + 讲清穿帮原因的 summary", () => {
    const out = buildSequencingBlockedOutput(4, 3, {} as StateOverview);
    expect(out.ok).toBe(false);
    expect(out.blockedReason).toBe("previous_chapter_not_committed");
    expect(out.pendingChapterToCommit).toBe(3);
    expect(out.refreshScope).toBe("full");
    expect(out.summary).toContain("第 3 章");
    expect(out.summary).toContain("第 4 章");
    expect(out.summary).toContain("穿帮");
  });

  it("isChapterCommitted：未入库→false；写入 chapters/N.md→true", async () => {
    const projectDir = await makeProject("护栏测试书");
    expect(await isChapterCommitted(projectDir, 1)).toBe(false);
    const committedPath = defaultCommittedChapterPath(projectDir, 1);
    await mkdir(dirname(committedPath), { recursive: true });
    await writeFile(committedPath, "# 第一章\n\n已入库正文。", "utf-8");
    expect(await isChapterCommitted(projectDir, 1)).toBe(true);
  });
});

describe("advancePastCommittedFrontier（已入库前沿→推进下一章，治章号 off-by-one）", () => {
  it("隐式章号 + 回退章已入库 + 下一章未入库（前沿）→ 推进到下一章", () => {
    expect(advancePastCommittedFrontier({
      explicitChapter: false, resolvedChapter: 6, resolvedCommitted: true, nextChapterCommitted: false,
    })).toBe(7);
  });

  it("显式点名章号 → 一律尊重、绝不推进（哪怕该章已入库，例如要重写它的草稿）", () => {
    expect(advancePastCommittedFrontier({
      explicitChapter: true, resolvedChapter: 6, resolvedCommitted: true, nextChapterCommitted: false,
    })).toBe(6);
  });

  it("隐式章号 + 回退章未入库（有草稿/空章）→ 不推进，接着写本章", () => {
    expect(advancePastCommittedFrontier({
      explicitChapter: false, resolvedChapter: 6, resolvedCommitted: false, nextChapterCommitted: false,
    })).toBe(6);
  });

  it("隐式章号 + 回退章已入库但下一章也已入库（前沿之内的中间章）→ 不推进，避免误改中间章", () => {
    expect(advancePastCommittedFrontier({
      explicitChapter: false, resolvedChapter: 3, resolvedCommitted: true, nextChapterCommitted: true,
    })).toBe(3);
  });
});

describe("写作意图门（防入库后自主续写）", () => {
  type ToolExec = (input: Record<string, unknown>, context: ToolExecutionContext) => Promise<unknown>;
  const execute = generateDraftTool.execute as unknown as ToolExec;

  it("buildNoWriteIntentBlockedOutput：ok:false + 结构化 reason + 面向用户的 summary（不泄工具名）", () => {
    const out = buildNoWriteIntentBlockedOutput(6, {} as StateOverview);
    expect(out.ok).toBe(false);
    expect(out.blockedReason).toBe("no_write_intent_this_turn");
    expect(out.refreshScope).toBe("full");
    expect(out.summary).toContain("第 6 章");
    expect(out.summary).not.toMatch(/generate_draft|commit_apply|commit_preview/u);
  });

  it("本轮原话只有定稿意图（入库后模型擅自续写的场景）→ 拦在调模型之前，不写盘、不烧额度", async () => {
    const projectDir = await makeProject("意图门拦截");
    const llmClientModule = await import("../../lib/llm-client.js");
    const spy = vi.spyOn(llmClientModule, "createConfiguredWriterClient").mockResolvedValue(mockWriterClient(longBody("林远")));

    try {
      const context = {
        requestContext: buildProjectRequestContext(projectDir, 1, undefined, "确认定稿"),
      } as unknown as ToolExecutionContext;

      const out = await execute({}, context) as { ok: boolean; blockedReason?: string; summary: string };
      expect(out.ok).toBe(false);
      expect(out.blockedReason).toBe("no_write_intent_this_turn");
      expect(spy).not.toHaveBeenCalled();
      await expect(readFile(defaultDraftPath(projectDir, 1), "utf-8")).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }
  });

  it("本轮原话带写作意图（含尾部范围限定否定的马拉松原话）→ 放行照常出稿", async () => {
    const projectDir = await makeProject("意图门放行", "林远");
    const llmClientModule = await import("../../lib/llm-client.js");
    const spy = vi.spyOn(llmClientModule, "createConfiguredWriterClient").mockResolvedValue(mockWriterClient(longBody("林远")));

    try {
      const context = {
        requestContext: buildProjectRequestContext(projectDir, 1, undefined, "继续写第1章正文。只写这一章，不要写其他章。"),
      } as unknown as ToolExecutionContext;

      const out = await execute({}, context) as { ok: boolean; chapter: number };
      expect(out.ok).toBe(true);
      expect(out.chapter).toBe(1);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("generate_draft execute 章号回退（currentChapter）", () => {
  type ToolExec = (input: Record<string, unknown>, context: ToolExecutionContext) => Promise<unknown>;
  const execute = generateDraftTool.execute as unknown as ToolExec;

  it("不传 chapter 但注入 currentChapter:5 → 工具用第5章执行（非默认第1章）", async () => {
    const projectDir = await makeProject("章号回退测试");
    // 第4章先入库，让章序护栏放行（第5章的 prior = 第4章需入库）
    const committed4 = defaultCommittedChapterPath(projectDir, 4);
    await mkdir(dirname(committed4), { recursive: true });
    await writeFile(committed4, "# 第四章\n\n" + "已入库。".repeat(20), "utf-8");

    const mockClient: WriterClient = mockWriterClient(longBody("林远"));
    const llmClientModule = await import("../../lib/llm-client.js");
    const spy = vi.spyOn(llmClientModule, "createConfiguredWriterClient").mockResolvedValue(mockClient);

    try {
      const context = {
        requestContext: buildProjectRequestContext(projectDir, 5),
      } as unknown as ToolExecutionContext;

      const out = await execute({}, context) as { ok: boolean; chapter: number };
      // 工具必须作用于第5章，而非第1章
      expect(out.chapter).toBe(5);
    } finally {
      spy.mockRestore();
    }
  });

  it("不传 chapter、currentChapter:6 且第6章已入库（前沿）→ 出稿推进到第7章（治 off-by-one，非重写第6章）", async () => {
    const projectDir = await makeProject("前沿推进测试");
    // 第 1–6 章全部入库，第 6 章是写作前沿（第 7 章还没入库）
    for (let ch = 1; ch <= 6; ch++) {
      const committed = defaultCommittedChapterPath(projectDir, ch);
      await mkdir(dirname(committed), { recursive: true });
      await writeFile(committed, `# 第${ch}章\n\n` + "已入库正文。".repeat(20), "utf-8");
    }

    const mockClient: WriterClient = mockWriterClient(longBody("林远"));
    const llmClientModule = await import("../../lib/llm-client.js");
    const spy = vi.spyOn(llmClientModule, "createConfiguredWriterClient").mockResolvedValue(mockClient);

    try {
      const context = {
        requestContext: buildProjectRequestContext(projectDir, 6),
      } as unknown as ToolExecutionContext;

      const out = await execute({}, context) as { ok: boolean; chapter: number };
      expect(out.chapter).toBe(7);
    } finally {
      spy.mockRestore();
    }
  });

  it("显式 chapter:6 且第6章已入库 → 尊重点名、作用于第6章（不推进；用户要重写其草稿）", async () => {
    const projectDir = await makeProject("显式点名不推进");
    for (let ch = 1; ch <= 6; ch++) {
      const committed = defaultCommittedChapterPath(projectDir, ch);
      await mkdir(dirname(committed), { recursive: true });
      await writeFile(committed, `# 第${ch}章\n\n` + "已入库正文。".repeat(20), "utf-8");
    }

    const mockClient: WriterClient = mockWriterClient(longBody("林远"));
    const llmClientModule = await import("../../lib/llm-client.js");
    const spy = vi.spyOn(llmClientModule, "createConfiguredWriterClient").mockResolvedValue(mockClient);

    try {
      const context = {
        requestContext: buildProjectRequestContext(projectDir, 6),
      } as unknown as ToolExecutionContext;

      const out = await execute({ chapter: 6 }, context) as { ok: boolean; chapter: number };
      expect(out.chapter).toBe(6);
    } finally {
      spy.mockRestore();
    }
  });

  it("不传 chapter 且 context 无 currentChapter → throw 含「缺少章号」", async () => {
    const projectDir = await makeProject("缺章号测试");
    const context = {
      requestContext: buildProjectRequestContext(projectDir),
    } as unknown as ToolExecutionContext;

    await expect(execute({}, context)).rejects.toThrow(/缺少章号/);
  });
});

describe("generate_draft 出稿即 AI 腔回检（warning-only，内置规则 + antiAiPatterns）", () => {
  it("检出 high/medium AI 腔 → aiFlavor 字段计数正确 + summary 打 ⚠ 标注引导「去AI味」", async () => {
    const projectDir = await makeProject("回检命中", "林远");
    // 深吸一口气(medium) + 殊不知(high) 两处硬命中
    const body = "林远深吸一口气，压下怒火。殊不知，门后的真相正在等他。";
    const out = await runGenerateDraftToolLogic({
      projectDir,
      chapter: 1,
      writerClient: mockWriterClient(body),
    });
    expect(out.ok).toBe(true); // warning-only：绝不拦稿
    expect(out.aiFlavor).toEqual({
      total: 2,
      bySeverity: { high: 1, medium: 1, low: 0 },
      truncated: false,
    });
    expect(out.summary).toContain("⚠ 检出 2 处疑似 AI 腔（high 1 / medium 1）");
    expect(out.summary).toContain("去AI味");
  });

  it("干净稿 → aiFlavor.total=0，summary 不加 AI 腔噪音", async () => {
    const projectDir = await makeProject("回检干净", "林远");
    const out = await runGenerateDraftToolLogic({
      projectDir,
      chapter: 1,
      writerClient: mockWriterClient(longBody("林远")),
    });
    expect(out.ok).toBe(true);
    expect(out.aiFlavor).toEqual({ total: 0, bySeverity: { high: 0, medium: 0, low: 0 }, truncated: false });
    expect(out.summary).not.toContain("疑似 AI 腔");
  });

  it("writing-rules.json 的 antiAiPatterns 命中 → 按 low 档检出（正则元字符转义、字面量匹配），summary 不加 ⚠ 噪音", async () => {
    const projectDir = await makeProject("回检用户词", "林远");
    const rulesPath = join(projectDir, "story", "writing-rules.json");
    const rules = JSON.parse(await readFile(rulesPath, "utf-8")) as Record<string, unknown>;
    rules.antiAiPatterns = ["量子涨落", "C++"]; // 「C++」带正则元字符：不转义会直接 new RegExp 抛错
    await writeFile(rulesPath, `${JSON.stringify(rules, null, 2)}\n`, "utf-8");

    const body = "林远盯着仪器，量子涨落曲线剧烈抖动。他骂了一句，这破设备又吞了 C++ 补丁。";
    const out = await runGenerateDraftToolLogic({
      projectDir,
      chapter: 1,
      writerClient: mockWriterClient(body),
    });
    expect(out.ok).toBe(true); // 不崩（元字符已转义）
    expect(out.aiFlavor?.total).toBe(2); // 两个用户词各命中一处整句
    expect(out.aiFlavor?.bySeverity).toEqual({ high: 0, medium: 0, low: 2 }); // 用户自定义词一律 low 档
    expect(out.summary).not.toContain("疑似 AI 腔"); // 只有 low 不打 ⚠（治噪音）
  });

  it("writing-rules.json 读不到（已删除）→ 不崩，内置规则照常回检", async () => {
    const projectDir = await makeProject("回检无规则文件", "林远");
    await rm(join(projectDir, "story", "writing-rules.json"));
    const out = await runGenerateDraftToolLogic({
      projectDir,
      chapter: 1,
      writerClient: mockWriterClient("林远走出门。殊不知，这一走就是三年。"),
    });
    expect(out.ok).toBe(true);
    expect(out.aiFlavor?.bySeverity.high).toBe(1); // 内置「殊不知」仍命中
    expect(out.summary).toContain("⚠ 检出 1 处疑似 AI 腔（high 1）");
  });

  it("buildAiFlavorWarning：只有 low / 干净 → 空串；有 high/medium → ⚠ 如实标注", () => {
    expect(buildAiFlavorWarning({ total: 0, bySeverity: { high: 0, medium: 0, low: 0 }, truncated: false })).toBe("");
    expect(buildAiFlavorWarning({ total: 2, bySeverity: { high: 0, medium: 0, low: 2 }, truncated: false })).toBe("");
    expect(buildAiFlavorWarning({ total: 3, bySeverity: { high: 1, medium: 1, low: 1 }, truncated: false }))
      .toBe("⚠ 检出 3 处疑似 AI 腔（high 1 / medium 1），可对我说「去AI味」逐条修订。");
  });

  it("buildAiFlavorInfo：清单 capped 8 被截断 → truncated=true（total 仍是全量）", () => {
    const v = { id: "x", ruleId: "r", text: "t", start: 0, end: 1, reason: "r", severity: "high" as const };
    const info = buildAiFlavorInfo({
      total: 10,
      bySeverity: { high: 10, medium: 0, low: 0 },
      violations: Array.from({ length: 8 }, () => v),
    });
    expect(info).toEqual({ total: 10, bySeverity: { high: 10, medium: 0, low: 0 }, truncated: true });
    expect(buildAiFlavorInfo({ total: 1, bySeverity: { high: 0, medium: 1, low: 0 }, violations: [v] }).truncated).toBe(false);
  });
});

// 出稿含 high/medium 命中 → 自动去味一轮（复用 de-ai-flavor-batch：六门禁批量改写 + 倒序落盘）+ 复检。
// 改写模型注入 mock；正文用「深吸一口气(medium) + 殊不知(high)」两处确定性硬命中（与上方回检测试同稿）。
describe("generate_draft 出稿后自动去味闭环（high/medium → 一轮改写 + 复检）", () => {
  const FLAVORED_BODY = "林远深吸一口气，压下怒火。殊不知，门后的真相正在等他。";
  const REWRITE_BOTH = JSON.stringify({ rewrites: [
    { text: "林远深吸一口气，压下怒火。", afterText: "林远攥紧拳，把火压下去。" },
    { text: "殊不知，门后的真相正在等他。", afterText: "门后的真相正在等他。" },
  ] });
  const REWRITE_ONE = JSON.stringify({ rewrites: [
    { text: "殊不知，门后的真相正在等他。", afterText: "门后的真相正在等他。" },
  ] });

  it("mock 改写模型成功 → 落盘文本已改写 + autoDeAi 计数正确 + summary 三态之「修掉 N 处、复检干净」", async () => {
    const projectDir = await makeProject("自动去味成功", "林远");
    const out = await runGenerateDraftToolLogic({
      projectDir,
      chapter: 1,
      writerClient: mockWriterClient(FLAVORED_BODY),
      deAiCallModel: async () => REWRITE_BOTH,
    });
    expect(out.ok).toBe(true); // 出稿本身不受去味影响
    // aiFlavor 仍是初始检出（保留），autoDeAi 才是改后复检
    expect(out.aiFlavor).toEqual({ total: 2, bySeverity: { high: 1, medium: 1, low: 0 }, truncated: false });
    expect(out.autoDeAi).toEqual({
      attempted: true,
      fixedCount: 2,
      remainingHighMedium: 0,
      skipped: { notFound: 0, ambiguous: 0, noop: 0, overlap: 0, noRewrite: 0 },
    });
    expect(out.summary).toContain("已自动去 AI 味修掉 2 处，复检干净。");
    expect(out.summary).not.toContain("可对我说「去AI味」逐条修订"); // 已修完，不再引导手动
    // 落盘文本与 draftBody 都是改后稿
    const onDisk = await readFile(defaultDraftPath(projectDir, 1), "utf-8");
    expect(onDisk).toContain("林远攥紧拳，把火压下去。门后的真相正在等他。");
    expect(onDisk).not.toContain("深吸一口气");
    expect(onDisk).not.toContain("殊不知");
    expect(out.draftBody).toContain("攥紧拳");
    // 覆盖刚写盘的草稿前建了快照（对齐 revise_draft 先快照），snapshotId 进输出
    expect(typeof out.snapshotId).toBe("string");
  });

  it("模型只改了一句 → fixedCount 1 + 复检还剩 1 处 + summary 如实报剩（可手动去AI味）", async () => {
    const projectDir = await makeProject("自动去味部分", "林远");
    const out = await runGenerateDraftToolLogic({
      projectDir,
      chapter: 1,
      writerClient: mockWriterClient(FLAVORED_BODY),
      deAiCallModel: async () => REWRITE_ONE,
    });
    expect(out.ok).toBe(true);
    expect(out.autoDeAi?.attempted).toBe(true);
    expect(out.autoDeAi?.fixedCount).toBe(1);
    expect(out.autoDeAi?.remainingHighMedium).toBe(1); // 深吸一口气(medium) 还在
    expect(out.autoDeAi?.skipped.noRewrite).toBe(1);   // 模型没给这条的改写
    expect(out.summary).toContain("已自动去 AI 味修掉 1 处");
    expect(out.summary).toContain("复检还剩 1 处");
    expect(out.summary).toContain("去AI味");
    const onDisk = await readFile(defaultDraftPath(projectDir, 1), "utf-8");
    expect(onDisk).toContain("深吸一口气"); // 没改的那句原样保留
    expect(onDisk).not.toContain("殊不知");
  });

  it("改写模型 400 抛错 → 原稿不动 + 如实报告（error 进输出、summary 说没跑成），ok 不受影响", async () => {
    const projectDir = await makeProject("自动去味模型挂", "林远");
    const out = await runGenerateDraftToolLogic({
      projectDir,
      chapter: 1,
      writerClient: mockWriterClient(FLAVORED_BODY),
      deAiCallModel: async () => { throw new Error("模型请求失败：400 bad request"); },
    });
    expect(out.ok).toBe(true); // 出稿本身没失败
    expect(out.autoDeAi?.attempted).toBe(true);
    expect(out.autoDeAi?.fixedCount).toBe(0);
    expect(out.autoDeAi?.remainingHighMedium).toBe(2); // 原稿未动 → 剩初始检出
    expect(out.autoDeAi?.error).toContain("400");
    expect(out.autoDeAi?.skipped.noRewrite).toBe(2);
    expect(out.summary).toContain("自动去味没跑成");
    expect(out.summary).toContain("400");
    expect(out.summary).toContain("原稿未动");
    const onDisk = await readFile(defaultDraftPath(projectDir, 1), "utf-8");
    expect(onDisk).toContain("深吸一口气"); // 原稿一个字没动
    expect(onDisk).toContain("殊不知");
  });

  it("改写模型返回烂 JSON → 一处没能安全替换、原稿不动 + 如实报告", async () => {
    const projectDir = await makeProject("自动去味烂JSON", "林远");
    const out = await runGenerateDraftToolLogic({
      projectDir,
      chapter: 1,
      writerClient: mockWriterClient(FLAVORED_BODY),
      deAiCallModel: async () => "抱歉，这段我改不了（不是 JSON）",
    });
    expect(out.ok).toBe(true);
    expect(out.autoDeAi?.attempted).toBe(true);
    expect(out.autoDeAi?.fixedCount).toBe(0);
    expect(out.autoDeAi?.remainingHighMedium).toBe(2);
    expect(out.autoDeAi?.skipped.noRewrite).toBe(2);
    expect(out.summary).toContain("没能安全替换");
    expect(out.summary).toContain("原稿未动");
    const onDisk = await readFile(defaultDraftPath(projectDir, 1), "utf-8");
    expect(onDisk).toContain(FLAVORED_BODY);
  });

  it("autoDeAi:false → 不改写只标注（不调用改写模型，summary 退回原 ⚠ 标注）", async () => {
    const projectDir = await makeProject("自动去味关闭", "林远");
    const deAiCallModel = vi.fn(async () => REWRITE_BOTH);
    const out = await runGenerateDraftToolLogic({
      projectDir,
      chapter: 1,
      writerClient: mockWriterClient(FLAVORED_BODY),
      autoDeAi: false,
      deAiCallModel,
    });
    expect(out.ok).toBe(true);
    expect(deAiCallModel).not.toHaveBeenCalled();
    expect(out.autoDeAi).toEqual({
      attempted: false,
      fixedCount: 0,
      remainingHighMedium: 2,
      skipped: { notFound: 0, ambiguous: 0, noop: 0, overlap: 0, noRewrite: 0 },
    });
    expect(out.summary).toContain("⚠ 检出 2 处疑似 AI 腔（high 1 / medium 1）"); // 只标注
    const onDisk = await readFile(defaultDraftPath(projectDir, 1), "utf-8");
    expect(onDisk).toContain(FLAVORED_BODY);
  });

  it("只有 low 命中（用户自定义词）→ 不触发自动去味，autoDeAi 字段不出现", async () => {
    const projectDir = await makeProject("自动去味low不动", "林远");
    const rulesPath = join(projectDir, "story", "writing-rules.json");
    const rules = JSON.parse(await readFile(rulesPath, "utf-8")) as Record<string, unknown>;
    rules.antiAiPatterns = ["量子涨落"];
    await writeFile(rulesPath, `${JSON.stringify(rules, null, 2)}\n`, "utf-8");

    const deAiCallModel = vi.fn(async () => REWRITE_BOTH);
    const out = await runGenerateDraftToolLogic({
      projectDir,
      chapter: 1,
      writerClient: mockWriterClient("林远盯着仪器，量子涨落曲线剧烈抖动。"),
      deAiCallModel,
    });
    expect(out.ok).toBe(true);
    expect(out.aiFlavor?.bySeverity).toEqual({ high: 0, medium: 0, low: 1 });
    expect(deAiCallModel).not.toHaveBeenCalled(); // low 不动
    expect("autoDeAi" in out).toBe(false);
  });

  it("pickAutoDeAiTargets：只挑 high/medium，low 不动", () => {
    const mk = (severity: "high" | "medium" | "low") => ({ id: severity, ruleId: "r", text: severity, start: 0, end: 1, reason: "r", severity });
    const report = {
      total: 3,
      bySeverity: { high: 1, medium: 1, low: 1 },
      violations: [mk("high"), mk("medium"), mk("low")],
    };
    expect(pickAutoDeAiTargets(report).map((v) => v.severity)).toEqual(["high", "medium"]);
  });

  it("buildAutoDeAiNote：四态文案如实（未跑/失败/全修掉/部分剩）", () => {
    const initial = { total: 2, bySeverity: { high: 1, medium: 1, low: 0 }, truncated: false };
    const skipped = { notFound: 0, ambiguous: 0, noop: 0, overlap: 0, noRewrite: 0 };
    expect(buildAutoDeAiNote({ attempted: false, fixedCount: 0, remainingHighMedium: 2, skipped }, initial))
      .toBe("⚠ 检出 2 处疑似 AI 腔（high 1 / medium 1），可对我说「去AI味」逐条修订。");
    expect(buildAutoDeAiNote({ attempted: true, fixedCount: 0, remainingHighMedium: 2, skipped, error: "400" }, initial))
      .toContain("没跑成（400）");
    expect(buildAutoDeAiNote({ attempted: true, fixedCount: 0, remainingHighMedium: 2, skipped: { ...skipped, noRewrite: 2 } }, initial))
      .toContain("没能安全替换");
    expect(buildAutoDeAiNote({ attempted: true, fixedCount: 2, remainingHighMedium: 0, skipped }, initial))
      .toBe("已自动去 AI 味修掉 2 处，复检干净。");
    expect(buildAutoDeAiNote({ attempted: true, fixedCount: 1, remainingHighMedium: 1, skipped: { ...skipped, noRewrite: 1 } }, initial))
      .toContain("还剩 1 处");
  });

  it("execute 端到端接线：默认自动去味走 repair 任务槽（resolveConfiguredChatModel(\"repair\") + streamChatModelToText）", async () => {
    const projectDir = await makeProject("自动去味接线", "林远");
    const llmClientModule = await import("../../lib/llm-client.js");
    const spyWriter = vi.spyOn(llmClientModule, "createConfiguredWriterClient").mockResolvedValue(mockWriterClient(FLAVORED_BODY));
    const spyResolve = vi.spyOn(llmClientModule, "resolveConfiguredChatModel").mockResolvedValue({
      provider: { id: "p", baseUrl: "http://127.0.0.1:1", apiKeyEnv: "TEST_KEY" },
      profile: { id: "prof", provider: "p", model: "test-model" },
      apiKey: "k",
      thinking: false,
      thinkingDialect: "none",
    } as unknown as Awaited<ReturnType<typeof llmClientModule.resolveConfiguredChatModel>>);
    const spyStream = vi.spyOn(llmClientModule, "streamChatModelToText").mockResolvedValue({ content: REWRITE_BOTH, thinking: "" });

    try {
      const context = {
        requestContext: buildProjectRequestContext(projectDir, 1, undefined, "写第1章正文。"),
      } as unknown as ToolExecutionContext;
      const execute = generateDraftTool.execute as unknown as (input: Record<string, unknown>, ctx: ToolExecutionContext) => Promise<{
        ok: boolean; autoDeAi?: { attempted: boolean; fixedCount: number; remainingHighMedium: number };
      }>;
      const out = await execute({}, context);
      expect(out.ok).toBe(true);
      expect(spyResolve).toHaveBeenCalledWith("repair"); // 改写用 repair 任务槽
      expect(spyStream).toHaveBeenCalledTimes(1);
      expect(out.autoDeAi).toMatchObject({ attempted: true, fixedCount: 2, remainingHighMedium: 0 });
      const onDisk = await readFile(defaultDraftPath(projectDir, 1), "utf-8");
      expect(onDisk).toContain("攥紧拳");
    } finally {
      spyWriter.mockRestore();
      spyResolve.mockRestore();
      spyStream.mockRestore();
    }
  });

  it("execute 端到端接线：autoDeAi:false → repair 槽完全不解析、不改写只标注", async () => {
    const projectDir = await makeProject("自动去味接线关闭", "林远");
    const llmClientModule = await import("../../lib/llm-client.js");
    const spyWriter = vi.spyOn(llmClientModule, "createConfiguredWriterClient").mockResolvedValue(mockWriterClient(FLAVORED_BODY));
    const spyResolve = vi.spyOn(llmClientModule, "resolveConfiguredChatModel");
    const spyStream = vi.spyOn(llmClientModule, "streamChatModelToText");

    try {
      const context = {
        requestContext: buildProjectRequestContext(projectDir, 1, undefined, "写第1章正文。"),
      } as unknown as ToolExecutionContext;
      const execute = generateDraftTool.execute as unknown as (input: Record<string, unknown>, ctx: ToolExecutionContext) => Promise<{
        ok: boolean; autoDeAi?: { attempted: boolean }; summary: string;
      }>;
      const out = await execute({ autoDeAi: false }, context);
      expect(out.ok).toBe(true);
      expect(spyResolve).not.toHaveBeenCalled();
      expect(spyStream).not.toHaveBeenCalled();
      expect(out.autoDeAi?.attempted).toBe(false);
      expect(out.summary).toContain("⚠ 检出 2 处疑似 AI 腔");
      const onDisk = await readFile(defaultDraftPath(projectDir, 1), "utf-8");
      expect(onDisk).toContain(FLAVORED_BODY);
    } finally {
      spyWriter.mockRestore();
      spyResolve.mockRestore();
      spyStream.mockRestore();
    }
  });
});

// 去味后 beats 复核：去味真落改动后对最终正文重跑一遍引擎确定性核对（纯函数零 token）——去味按整句
// 改写、可能吃掉 beats 锚点（锚点句恰是被改写的 AI 腔句时）。新出现的漏写如实进 beatFidelity.postDeAiNewMisses
// + summary「去味后新漏 N 条」；去味前已判漏的不重复报；没吃掉锚点则零噪音。
describe("generate_draft 去味后 beats 复核（去味吃掉锚点 → 如实报新漏）", () => {
  // 「深吸一口气」medium 命中的整句里带锚点「第三块砖」——去味改写这句时锚点可能一起被吃掉。
  const ANCHOR_FLAVORED_BODY = "林远深吸一口气，撬开第三块砖后面的暗格，取出薄铁盒。";
  const EAT_ANCHOR = JSON.stringify({ rewrites: [
    { text: ANCHOR_FLAVORED_BODY, afterText: "林远撬开暗格，取出薄铁盒。" }, // 改写吃掉了「第三块砖」
  ] });
  const KEEP_ANCHOR = JSON.stringify({ rewrites: [
    { text: ANCHOR_FLAVORED_BODY, afterText: "林远撬开第三块砖，取出薄铁盒。" }, // 锚点保住
  ] });

  it("去味改写吃掉锚点 → postDeAiNewMisses 如实报新漏 + summary 标「去味后新漏 1 条」（原稿锚点全中、零判漏）", async () => {
    const projectDir = await makeProject("去味吃锚点", "林远");
    const out = await runGenerateDraftToolLogic({
      projectDir,
      chapter: 1,
      mustHitBeats: ["第三块砖"],
      writerClient: mockWriterClient(ANCHOR_FLAVORED_BODY),
      deAiCallModel: async () => EAT_ANCHOR,
    });
    expect(out.ok).toBe(true);
    expect(out.autoDeAi?.fixedCount).toBe(1); // 去味真落了改动才触发复核
    // 去味前锚点全中（零判漏）；新漏只来自去味后复核，如实标注来源（确定性结果、未经 AI 复核）
    expect(out.beatFidelity).toEqual({
      missingBeats: [],
      adjudicatedCovered: [],
      adjudication: "not_run",
      postDeAiNewMisses: ["第三块砖"],
    });
    expect(out.summary).toContain("去味后新漏 1 条");
    expect(out.summary).toContain("第三块砖");
    expect(out.summary).not.toContain("⚠ 首稿核对"); // 去味前没有判漏，不打这条
    const onDisk = await readFile(defaultDraftPath(projectDir, 1), "utf-8");
    expect(onDisk).not.toContain("第三块砖"); // 锚点确实被吃掉了
  });

  it("去味改写保住锚点 → 无 postDeAiNewMisses、beatFidelity 字段不出现、summary 无新漏噪音", async () => {
    const projectDir = await makeProject("去味保锚点", "林远");
    const out = await runGenerateDraftToolLogic({
      projectDir,
      chapter: 1,
      mustHitBeats: ["第三块砖"],
      writerClient: mockWriterClient(ANCHOR_FLAVORED_BODY),
      deAiCallModel: async () => KEEP_ANCHOR,
    });
    expect(out.ok).toBe(true);
    expect(out.autoDeAi?.fixedCount).toBe(1); // 去味真改了，但没吃掉锚点
    expect("beatFidelity" in out).toBe(false);
    expect(out.summary).toContain("复检干净"); // 去味本身照常如实报
    expect(out.summary).not.toContain("去味后新漏");
    const onDisk = await readFile(defaultDraftPath(projectDir, 1), "utf-8");
    expect(onDisk).toContain("第三块砖");
  });

  it("去味前已判漏的要点不重复计入新漏：missingBeats 保留债权池A-17，postDeAiNewMisses 只收新吃掉的「第三块砖」", async () => {
    const projectDir = await makeProject("去味新旧漏分流", "林远");
    const out = await runGenerateDraftToolLogic({
      projectDir,
      chapter: 1,
      mustHitBeats: ["第三块砖", "债权池A-17"], // A-17 原稿就漏（确定性判漏）；第三块砖原稿命中、被去味吃掉
      writerClient: mockWriterClient(ANCHOR_FLAVORED_BODY),
      deAiCallModel: async () => EAT_ANCHOR,
    });
    expect(out.ok).toBe(true);
    expect(out.beatFidelity).toEqual({
      missingBeats: ["债权池A-17"],           // 去味前后都漏 → 留在原位，不重复进新漏
      adjudicatedCovered: [],
      adjudication: "not_run",
      postDeAiNewMisses: ["第三块砖"],        // 只有新吃掉的进这里
    });
    expect(out.summary).toContain("⚠ 首稿核对");
    expect(out.summary).toContain("债权池A-17");
    expect(out.summary).toContain("去味后新漏 1 条");
  });
});


// mock writer 返回不同质量候选，验证：选优正确、落选理由一句人话、只有优胜者落盘、
// 单候选失败不拖死、全失败 ok:false 诚实、candidates=1 零行为变化、优胜稿照常走 autoDeAi 闭环。
describe("多候选确定性评分器（纯函数，权重全透明）", () => {
  function candidateInput(overrides: Partial<DraftCandidateScoreInput> & { index: number }): DraftCandidateScoreInput {
    return {
      eligible: true,
      aiFlavorCounts: { high: 0, medium: 0, low: 0 },
      belowLowerBound: false,
      actualLength: 1800,
      lowerBound: 1530,
      missingBeatCount: 0,
      ...overrides,
    };
  }

  it("scoreDraftCandidate：100 起扣——漏要点 -50/条、低于下限 -25、AI 腔计权 -10/分，可为负", () => {
    expect(DRAFT_CANDIDATE_SCORE_WEIGHTS).toEqual({ perMissingBeat: 50, belowLowerBound: 25, perAiFlavorPoint: 10 });
    expect(scoreDraftCandidate(candidateInput({ index: 0 }))).toBe(100);
    expect(scoreDraftCandidate(candidateInput({
      index: 0,
      missingBeatCount: 1,
      belowLowerBound: true,
      aiFlavorCounts: { high: 2, medium: 1, low: 5 }, // low 不计：计权 2×3+1×1=7
    }))).toBe(100 - 50 - 25 - 70);
  });

  it("aiFlavorWeightedScore：high×3 + medium×1，low 不计", () => {
    expect(aiFlavorWeightedScore({ high: 2, medium: 3, low: 9 })).toBe(9);
    expect(aiFlavorWeightedScore({ high: 0, medium: 0, low: 0 })).toBe(0);
  });

  it("AI 腔少者胜：落选理由一句人话（AI 腔 2 处 > 优胜者 0 处），逐候选得分进报告", () => {
    const ranked = rankDraftCandidates([
      candidateInput({ index: 0, aiFlavorCounts: { high: 1, medium: 1, low: 0 } }), // 计权 4 → 60 分
      candidateInput({ index: 1 }),                                                 // 100 分
    ]);
    expect(ranked.chosenIndex).toBe(1);
    expect(ranked.entries).toHaveLength(2);
    expect(ranked.entries[0]).toMatchObject({
      index: 1, chosen: false, score: 60,
      aiFlavorCounts: { high: 1, medium: 1, low: 0 },
      reason: "AI 腔 2 处 > 优胜者 0 处",
    });
    expect(ranked.entries[1]).toMatchObject({ index: 2, chosen: true, score: 100 });
    expect(ranked.entries[1].reason).toContain("综合评分最高（100 分）");
    expect(ranked.entries[1].reason).toContain("要点全中");
  });

  it("漏必命中要点比 AI 腔更重：干净但漏要点的候选输给带 1 处 high 的达标候选（内容硬约束优先）", () => {
    const ranked = rankDraftCandidates([
      candidateInput({ index: 0, missingBeatCount: 1 }),                            // 50 分
      candidateInput({ index: 1, aiFlavorCounts: { high: 1, medium: 0, low: 0 } }), // 70 分
    ]);
    expect(ranked.chosenIndex).toBe(1);
    expect(ranked.entries[0].reason).toBe("必命中要点漏 1 条 > 优胜者 0 条");
  });

  it("低于字数下限输给达标者：理由带实际字数/下限", () => {
    const ranked = rankDraftCandidates([
      candidateInput({ index: 0, belowLowerBound: true, actualLength: 200 }), // 75 分
      candidateInput({ index: 1 }),                                           // 100 分
    ]);
    expect(ranked.chosenIndex).toBe(1);
    expect(ranked.entries[0].reason).toBe("低于字数下限（实际200字/下限1530字），优胜者达标");
  });

  it("同分 → 取序号靠前者，落选理由讲清 tie-break（无随机、无模型偏好）", () => {
    const ranked = rankDraftCandidates([candidateInput({ index: 0 }), candidateInput({ index: 1 })]);
    expect(ranked.chosenIndex).toBe(0);
    expect(ranked.entries[0].chosen).toBe(true);
    expect(ranked.entries[1].reason).toBe("与优胜者同分（100 分），按候选顺序取序号靠前者");
  });

  it("AI 腔处数相同但 high 档更多 → 计权分出胜负，理由讲严重度而非处数", () => {
    const ranked = rankDraftCandidates([
      candidateInput({ index: 0, aiFlavorCounts: { high: 1, medium: 0, low: 0 } }), // 计权 3 → 70 分
      candidateInput({ index: 1, aiFlavorCounts: { high: 0, medium: 1, low: 0 } }), // 计权 1 → 90 分
    ]);
    expect(ranked.chosenIndex).toBe(1);
    expect(ranked.entries[0].reason).toBe("AI 腔同为 1 处但 high 档更多（high 1 处 > 优胜者 0 处）");
  });

  it("eligible=false 的候选永远不得中选（哪怕其余候选全都更差）", () => {
    const ranked = rankDraftCandidates([
      candidateInput({ index: 0, eligible: false, failureReason: "生成失败：模型请求失败：500" }),
      candidateInput({ index: 1, missingBeatCount: 3, belowLowerBound: true, aiFlavorCounts: { high: 5, medium: 0, low: 0 } }),
    ]);
    expect(ranked.chosenIndex).toBe(1); // 再差也是唯一合格候选
    expect(ranked.entries[0]).toMatchObject({ chosen: false, reason: "生成失败：模型请求失败：500" });
    expect(ranked.entries[0].score).toBeUndefined(); // 失败候选不参与评分
  });

  it("全部不合格 → chosenIndex 缺省，失败原因逐候选如实列出", () => {
    const ranked = rankDraftCandidates([
      candidateInput({ index: 0, eligible: false, failureReason: "未通过引擎校验（空正文）" }),
      candidateInput({ index: 1, eligible: false, failureReason: "生成失败：模型请求超时" }),
    ]);
    expect(ranked.chosenIndex).toBeUndefined();
    expect(ranked.entries.map((entry) => entry.chosen)).toEqual([false, false]);
    expect(ranked.entries.map((entry) => entry.reason)).toEqual([
      "未通过引擎校验（空正文）",
      "生成失败：模型请求超时",
    ]);
  });

  it("buildCandidateSummaryLine：优点逐条核实——AI 腔不是最少就绝不说「最少」", () => {
    const all = [
      candidateInput({ index: 0 }),                                                    // 无 AI 腔
      candidateInput({ index: 1, aiFlavorCounts: { high: 0, medium: 2, low: 0 } }),    // 优胜但 AI 腔 2 处
    ];
    const line = buildCandidateSummaryLine(2, all[1], all);
    expect(line).toContain("已生成 2 个候选并选出第 2 个");
    expect(line).toContain("要点全中、字数达标");
    expect(line).not.toContain("AI 腔最少"); // 另一个候选更干净——夸口就是谎报
    expect(line).toContain("其余落选原因见 candidatesReport");
  });

  it("buildCandidateSummaryLine：无 AI 腔命中直说；全胜选手可说「AI 腔最少」；无优点可讲时退回「综合评分最高」", () => {
    const clean = candidateInput({ index: 0 });
    expect(buildCandidateSummaryLine(2, clean, [clean, candidateInput({ index: 1, aiFlavorCounts: { high: 1, medium: 0, low: 0 } })]))
      .toContain("无 AI 腔命中");
    const flavoredWinner = candidateInput({ index: 0, aiFlavorCounts: { high: 0, medium: 1, low: 0 } });
    const moreFlavored = candidateInput({ index: 1, aiFlavorCounts: { high: 2, medium: 0, low: 0 } });
    expect(buildCandidateSummaryLine(2, flavoredWinner, [flavoredWinner, moreFlavored])).toContain("AI 腔最少（1 处）");
    const poor = candidateInput({ index: 0, missingBeatCount: 1, belowLowerBound: true, aiFlavorCounts: { high: 1, medium: 0, low: 0 } });
    const poorButCleaner = candidateInput({ index: 1, missingBeatCount: 2, belowLowerBound: true });
    expect(buildCandidateSummaryLine(2, poor, [poor, poorButCleaner])).toContain("（综合评分最高）");
  });

  it("temperature 错开档位常量：基准 / ±0.15 / ±0.3（方向由 resolveCandidateTemperatures 按 base 定）", () => {
    expect(DRAFT_CANDIDATE_TEMPERATURE_OFFSETS).toEqual([0, 0.15, 0.3]);
  });

  it("resolveCandidateTemperatures：base 0.8 向上错开（既有行为不回归）；base ≥0.85 向上会撞封顶 → 向下错开", () => {
    expect(resolveCandidateTemperatures(0.8, 3)).toEqual([0.8, 0.95, 1.0]);
    expect(resolveCandidateTemperatures(0.84, 3)).toEqual([0.84, 0.99, 1.0]); // 向上还错得开
    // P3-3：base 已是 1.0 时旧实现三候选同温（全撞封顶）防坍缩静默失效 → 改为向下错开
    const capped = resolveCandidateTemperatures(1.0, 3);
    expect(capped).toEqual([1.0, 0.85, 0.7]);
    expect(new Set(capped).size).toBe(3); // 互不相同
    expect(capped[0]).toBeGreaterThan(capped[1] as number); // 递减
    expect(capped[1]).toBeGreaterThan(capped[2] as number);
    expect(resolveCandidateTemperatures(0.9, 3)).toEqual([0.9, 0.75, 0.6]);
    expect(resolveCandidateTemperatures(0.85, 3)).toEqual([0.85, 0.7, 0.55]); // 0.85+0.15 与 0.85+0.3 会同撞 1.0
    expect(resolveCandidateTemperatures(1.0, 2)).toEqual([1.0, 0.85]); // candidates=2 只取前两档
    expect(resolveCandidateTemperatures(0, 3)).toEqual([0, 0.15, 0.3]); // 下限夹逼 0，向上照常
  });

  it("attachCandidateTemperatures：只标真注入错温 client 的槽位；缺位回退槽/未注入温度 → 不编造", () => {
    const entries = [
      { index: 1, chosen: true, aiFlavorCounts: { high: 0, medium: 0, low: 0 }, actualLength: 100, reason: "x" },
      { index: 2, chosen: false, aiFlavorCounts: { high: 0, medium: 0, low: 0 }, actualLength: 100, reason: "y" },
    ];
    const both = attachCandidateTemperatures(entries, [0.8, 0.95], [{} as WriterClient, {} as WriterClient]);
    expect(both.map((entry) => entry.temperature)).toEqual([0.8, 0.95]);
    const missingSlot = attachCandidateTemperatures(entries, [0.8, 0.95], [{} as WriterClient]); // 槽位 2 缺位回退 writerClient
    expect(missingSlot.map((entry) => entry.temperature)).toEqual([0.8, undefined]);
    expect(attachCandidateTemperatures(entries, undefined, undefined)).toBe(entries); // 未注入温度 → 原样返回
  });

  it("buildCandidateExcerpt：不足 100 字原样返回（无省略号），首尾空白先收掉", () => {
    expect(buildCandidateExcerpt("林远走进了房间。")).toBe("林远走进了房间。");
    const hundred = "字".repeat(100);
    expect(buildCandidateExcerpt(`  ${hundred}  `)).toBe(hundred); // 恰好 100 字不截断
  });

  it("buildCandidateExcerpt：超长截断加省略号；窗口后半有句读边界 → 落在边界后，不硬切半句", () => {
    const opening = `${"账".repeat(60)}。`; // 61 字，句读边界在保留 ≥ 一半的位置
    const body = `${opening}${"余".repeat(200)}`;
    expect(buildCandidateExcerpt(body)).toBe(`${opening}…`);
  });

  it("buildCandidateExcerpt：句读边界太靠前（预览会短得没用）→ 硬切 100 字加省略号", () => {
    const body = `开门。${"他".repeat(200)}`; // 「。」在第 3 字
    const excerpt = buildCandidateExcerpt(body);
    expect(Array.from(excerpt)).toHaveLength(101); // 100 字 + 省略号
    expect(excerpt.startsWith("开门。")).toBe(true);
    expect(excerpt.endsWith("…")).toBe(true);
  });

  it("buildCandidateExcerpt：半长阈值钉死「>=」语义——边界在 index 49（恰一半）落边界收；index 48（差一字）硬切 100", () => {
    // 实现：cutAt = boundary + 1 >= floor(maxChars/2)=50 ? boundary + 1 : maxChars。
    // 「>=」若退化成「>」，index 49 会从「落边界 51 字」退成「硬切 101 字」——两条断言把阈值两侧同时钉死。
    const boundaryAt49 = `${"前".repeat(49)}。${"余".repeat(200)}`; // 「。」在 index 49 → 收 50 字 = 恰一半 → 落边界
    expect(buildCandidateExcerpt(boundaryAt49)).toBe(`${"前".repeat(49)}。…`);
    const boundaryAt48 = `${"前".repeat(48)}。${"余".repeat(200)}`; // 「。」在 index 48 → 收 49 字 < 一半 → 硬切 100 字
    expect(buildCandidateExcerpt(boundaryAt48)).toBe(`${"前".repeat(48)}。${"余".repeat(51)}…`);
  });

  it("buildCandidateExcerpt：CJK 友好——按码位切，不劈代理对半个字", () => {
    const excerpt = buildCandidateExcerpt("😀".repeat(150));
    expect(Array.from(excerpt)).toHaveLength(101);
    expect(Array.from(excerpt.slice(0, -1)).every((char) => char === "😀")).toBe(true); // 每个字符都完整
    expect(excerpt.endsWith("…")).toBe(true);
  });

  it("attachCandidateExcerpts：有正文的候选带开头预览；失败候选（无正文/空白）不带 excerpt 字段", () => {
    const entries = [
      { index: 1, chosen: true, aiFlavorCounts: { high: 0, medium: 0, low: 0 }, actualLength: 100, reason: "x" },
      { index: 2, chosen: false, aiFlavorCounts: { high: 0, medium: 0, low: 0 }, actualLength: 0, reason: "y" },
    ];
    const attached = attachCandidateExcerpts(entries, ["开头第一段正文。", undefined]);
    expect(attached[0]?.excerpt).toBe("开头第一段正文。");
    expect(attached[1] && "excerpt" in attached[1]).toBe(false);
    const blank = attachCandidateExcerpts(entries, ["   ", ""]); // 空白正文同样视为没有正文
    expect(blank.every((entry) => !("excerpt" in entry))).toBe(true);
  });
});

describe("generate_draft 多候选采样集成（mock writer 返回不同质量候选）", () => {
  // 「殊不知」high +「深吸一口气」medium 的确定性硬命中句（与回检测试同稿）。
  const FLAVOR_TAIL = "林远深吸一口气，压下怒火。殊不知，门后的真相正在等他。";
  const REWRITE_BOTH = JSON.stringify({ rewrites: [
    { text: "林远深吸一口气，压下怒火。", afterText: "林远攥紧拳，把火压下去。" },
    { text: "殊不知，门后的真相正在等他。", afterText: "门后的真相正在等他。" },
  ] });

  /** 落进新项目写作规则目标区间（1530–2070 字）的正文（沿用既有达标测试的构造法）。 */
  function inRangeBody(mainCharacterName: string): string {
    const para = `${mainCharacterName}在走廊尽头停下脚步，反复掂量手里这份账册的分量，心里盘算着接下来每一步该怎么走才不至于落人话柄。`;
    const repeats = Math.ceil(1700 / countDraftChineseCharacters(para));
    return Array.from({ length: repeats }, () => para).join("\n\n");
  }

  it("3 候选不同质量 → 干净达标稿中选、落选理由正确、只有优胜者落盘、summary 一行讲清", async () => {
    const projectDir = await makeProject("多候选选优", "林远");
    const clean = inRangeBody("林远");
    const flavored = `${inRangeBody("林远")}\n\n${FLAVOR_TAIL}`;
    const short = "林远走进了房间。";

    const out = await runGenerateDraftToolLogic({
      projectDir,
      chapter: 1,
      writerClient: mockWriterClient(flavored), // 缺位序号回退用，本例三个候选都显式注入
      candidates: 3,
      candidateWriterClients: [mockWriterClient(flavored), mockWriterClient(clean), mockWriterClient(short)],
    });

    expect(out.ok).toBe(true);
    expect(out.draftPath).toBe(defaultDraftPath(projectDir, 1));
    // 只有优胜者（第 2 个）落盘，格式与 candidates=1 完全一致（# 标题行 + 正文）
    const onDisk = await readFile(defaultDraftPath(projectDir, 1), "utf-8");
    expect(onDisk).toBe(`# 第1章\n\n${clean}\n`);
    expect(out.draftBody).toBe(clean);
    // 逐候选透明报告：得分/AI 腔计数/字数/中选/原因
    expect(out.candidatesReport).toHaveLength(3);
    expect(out.candidatesReport?.[0]).toMatchObject({
      index: 1, chosen: false, score: 60,
      aiFlavorCounts: { high: 1, medium: 1, low: 0 },
      reason: "AI 腔 2 处 > 优胜者 0 处",
    });
    expect(out.candidatesReport?.[1]).toMatchObject({ index: 2, chosen: true, score: 100 });
    expect(out.candidatesReport?.[2]).toMatchObject({ index: 3, chosen: false, score: 75 });
    expect(out.candidatesReport?.[2].reason).toContain("低于字数下限");
    // summary 一行：选了第 2 个 + 核实过的优点
    expect(out.summary).toContain("已生成 3 个候选并选出第 2 个（要点全中、字数达标、无 AI 腔命中），其余落选原因见 candidatesReport。");
    // 优胜稿干净 → 不带 AI 腔 ⚠ 噪音
    expect(out.aiFlavor).toEqual({ total: 0, bySeverity: { high: 0, medium: 0, low: 0 }, truncated: false });
    expect(out.summary).not.toContain("疑似 AI 腔");
  });

  it("要点保真优先于文风：干净但漏要点的候选输给带 AI 腔但要点全中的候选，summary 不夸「AI 腔最少」", async () => {
    const projectDir = await makeProject("多候选要点优先", "林远");
    const cleanMissingBeat = inRangeBody("林远"); // 不含「第三块砖」
    const flavoredHitsBeat = `${inRangeBody("林远")}\n\n林远撬开第三块砖后面的暗格。${FLAVOR_TAIL}`;

    const out = await runGenerateDraftToolLogic({
      projectDir,
      chapter: 1,
      mustHitBeats: ["第三块砖"],
      writerClient: mockWriterClient(cleanMissingBeat),
      candidates: 2,
      candidateWriterClients: [mockWriterClient(cleanMissingBeat), mockWriterClient(flavoredHitsBeat)],
      autoDeAi: false, // 只标注不改写，聚焦选优断言
    });

    expect(out.ok).toBe(true);
    expect(out.candidatesReport?.[0]).toMatchObject({
      index: 1, chosen: false, score: 50,
      reason: "必命中要点漏 1 条 > 优胜者 0 条",
    });
    expect(out.candidatesReport?.[1]).toMatchObject({ index: 2, chosen: true, score: 60 });
    const onDisk = await readFile(defaultDraftPath(projectDir, 1), "utf-8");
    expect(onDisk).toContain("第三块砖");
    // 优胜稿 AI 腔比落选者多——summary 绝不夸「AI 腔最少」
    expect(out.summary).toContain("已生成 2 个候选并选出第 2 个（要点全中、字数达标）");
    expect(out.summary).not.toContain("AI 腔最少");
  });

  it("单候选失败不拖死全局：中间候选模型 500 → 如实记 failed，优胜者从其余候选中选出", async () => {
    const projectDir = await makeProject("多候选单失败", "林远");
    const clean = inRangeBody("林远");
    const throwingClient: WriterClient = {
      async generateDraft() {
        throw new Error("模型请求失败：500 Internal server error");
      },
    };

    const out = await runGenerateDraftToolLogic({
      projectDir,
      chapter: 1,
      writerClient: mockWriterClient(`${inRangeBody("林远")}\n\n${FLAVOR_TAIL}`),
      candidates: 3,
      candidateWriterClients: [
        mockWriterClient(`${inRangeBody("林远")}\n\n${FLAVOR_TAIL}`),
        throwingClient,
        mockWriterClient(clean),
      ],
    });

    expect(out.ok).toBe(true);
    expect(out.candidatesReport).toHaveLength(3);
    expect(out.candidatesReport?.[1]).toMatchObject({ index: 2, chosen: false });
    expect(out.candidatesReport?.[1].score).toBeUndefined();
    expect(out.candidatesReport?.[1].reason).toContain("未通过引擎校验");
    expect(out.candidatesReport?.[1].reason).toContain("500");
    // 优胜者显式钉死：第 3 个候选中选（edfd56a 曾误删这两条，只靠落盘内容间接等价——补回显式断言）
    expect(out.candidatesReport?.[2]).toMatchObject({ index: 3, chosen: true });
    expect(out.summary).toContain("已生成 3 个候选并选出第 3 个");
    const onDisk = await readFile(defaultDraftPath(projectDir, 1), "utf-8");
    expect(onDisk).toBe(`# 第1章\n\n${clean}\n`);
  });

  // 真机验收：落选稿 persist:false 不落盘、candidatesReport 只有分数，用户完全读不到落选稿长什么样 →
  // 逐候选带正文开头预览（excerpt，约前 100 字），失败候选没有正文则不带。
  it("落选/优胜候选都带开头预览（excerpt），超长截断加省略号；失败候选没有正文 → 不带 excerpt", async () => {
    const projectDir = await makeProject("多候选开头预览", "林远");
    const clean = inRangeBody("林远");
    const flavored = `${inRangeBody("林远")}\n\n${FLAVOR_TAIL}`;
    const throwingClient: WriterClient = {
      async generateDraft() {
        throw new Error("模型请求失败：502 Bad Gateway");
      },
    };

    const out = await runGenerateDraftToolLogic({
      projectDir,
      chapter: 1,
      writerClient: mockWriterClient(flavored),
      candidates: 3,
      candidateWriterClients: [mockWriterClient(flavored), throwingClient, mockWriterClient(clean)],
    });

    expect(out.ok).toBe(true);
    expect(out.candidatesReport).toHaveLength(3);
    // 落选候选（第 1 个）：带正文开头预览；超长 → 句读边界截断 + 省略号，且确是落选稿开头的逐字前缀
    const loser = out.candidatesReport?.[0];
    expect(loser?.chosen).toBe(false);
    expect(loser?.excerpt).toBe(buildCandidateExcerpt(flavored));
    expect(loser?.excerpt?.endsWith("…")).toBe(true);
    expect(Array.from(loser?.excerpt ?? "").length).toBeLessThanOrEqual(101);
    expect(flavored.startsWith((loser?.excerpt ?? "").slice(0, -1))).toBe(true);
    // 失败候选（第 2 个）：没有正文 → 不带 excerpt 字段（与 score 缺省同理，绝不编造）
    expect(out.candidatesReport?.[1].score).toBeUndefined();
    expect(out.candidatesReport?.[1].reason).toContain("未通过引擎校验"); // 模型 502 被引擎兜成 passed:false 报告（无 draftBody）
    expect(out.candidatesReport?.[1] && "excerpt" in out.candidatesReport[1]).toBe(false);
    // 优胜候选（第 3 个）：同样带开头预览，供和落选稿比对风格
    const winner = out.candidatesReport?.[2];
    expect(winner?.chosen).toBe(true);
    expect(winner?.excerpt).toBe(buildCandidateExcerpt(clean));
    expect(winner?.excerpt?.endsWith("…")).toBe(true);
  });

  it("全部候选失败 → ok:false 诚实回报：逐候选列明原因、不落盘、不假装出稿成功", async () => {
    const projectDir = await makeProject("多候选全失败", "林远");
    const badClient = mockWriterClient('{"tool":"call","args":{}}'); // JSON 伪正文 → 引擎校验拒绝

    const out = await runGenerateDraftToolLogic({
      projectDir,
      chapter: 1,
      writerClient: badClient,
      candidates: 3,
      candidateWriterClients: [badClient, badClient, badClient],
    });

    expect(out.ok).toBe(false);
    expect(out.issues.length).toBeGreaterThan(0);
    expect(out.summary).toContain("已生成 3 个候选，但全部未通过或生成失败，未写入工作稿");
    expect(out.summary).toContain("各候选情况见 candidatesReport");
    expect(out.candidatesReport).toHaveLength(3);
    expect(out.candidatesReport?.map((entry) => entry.chosen)).toEqual([false, false, false]);
    expect(out.candidatesReport?.every((entry) => entry.reason.includes("未通过引擎校验"))).toBe(true);
    // 校验不过的候选没有正文（引擎 passed:false 报告不带 draftBody）→ 一律不带 excerpt 字段
    // （缺省如实反映「没有正文」，绝不编造——此前这条不变量零断言，纯靠引擎报告形状隐性兜底）
    expect(out.candidatesReport?.every((entry) => !("excerpt" in entry))).toBe(true);
    // 失败也透明：draftLength 带出（首个失败报告的），且绝不写盘
    expect(out.draftLength).toBeDefined();
    await expect(readFile(defaultDraftPath(projectDir, 1), "utf-8")).rejects.toThrow();
  });

  it("优胜稿照常走 autoDeAi 闭环：带腔优胜稿中选 → 自动去味落盘 + 报告保留初检计数", async () => {
    const projectDir = await makeProject("多候选去味闭环", "林远");
    const cleanMissingBeat = inRangeBody("林远"); // 漏「第三块砖」→ 50 分
    const flavoredHitsBeat = `${inRangeBody("林远")}\n\n林远撬开第三块砖后面的暗格。${FLAVOR_TAIL}`; // 60 分 → 优胜

    const out = await runGenerateDraftToolLogic({
      projectDir,
      chapter: 1,
      mustHitBeats: ["第三块砖"],
      writerClient: mockWriterClient(cleanMissingBeat),
      candidates: 2,
      candidateWriterClients: [mockWriterClient(cleanMissingBeat), mockWriterClient(flavoredHitsBeat)],
      deAiCallModel: async () => REWRITE_BOTH,
    });

    expect(out.ok).toBe(true);
    expect(out.candidatesReport?.[1]).toMatchObject({
      index: 2, chosen: true,
      aiFlavorCounts: { high: 1, medium: 1, low: 0 }, // candidatesReport 保留初检计数
    });
    // 与 candidates=1 完全一致的后续链：autoDeAi 改了优胜稿并复检干净
    expect(out.autoDeAi).toMatchObject({ attempted: true, fixedCount: 2, remainingHighMedium: 0 });
    expect(out.summary).toContain("已自动去 AI 味修掉 2 处，复检干净。");
    expect(typeof out.snapshotId).toBe("string"); // 去味覆盖落盘前建了快照
    const onDisk = await readFile(defaultDraftPath(projectDir, 1), "utf-8");
    expect(onDisk).toContain("攥紧拳");
    expect(onDisk).not.toContain("深吸一口气");
    expect(onDisk).not.toContain("殊不知");
  });

  it("candidates=1（显式）→ 单次成稿、无 candidatesReport，与默认零差异", async () => {
    const projectDir = await makeProject("多候选显式1", "林远");
    const client = mockWriterClient(longBody("林远"));
    const spy = vi.spyOn(client, "generateDraft");

    const out = await runGenerateDraftToolLogic({
      projectDir,
      chapter: 1,
      writerClient: client,
      candidates: 1,
    });

    expect(out.ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1); // 只调一次模型
    expect("candidatesReport" in out).toBe(false);
    expect(out.summary).not.toContain("候选");
  });

  it("candidateWriterClients 缺位的序号回退 writerClient（防御：少注入不崩、不静默换规则）", async () => {
    const projectDir = await makeProject("多候选回退", "林远");
    const clean = inRangeBody("林远");

    const out = await runGenerateDraftToolLogic({
      projectDir,
      chapter: 1,
      writerClient: mockWriterClient(clean), // 序号 2 缺位 → 回退用它
      candidates: 2,
      candidateWriterClients: [mockWriterClient(`${inRangeBody("林远")}\n\n${FLAVOR_TAIL}`)],
    });

    expect(out.ok).toBe(true);
    expect(out.candidatesReport).toHaveLength(2);
    expect(out.candidatesReport?.[1]).toMatchObject({ index: 2, chosen: true });
    const onDisk = await readFile(defaultDraftPath(projectDir, 1), "utf-8");
    expect(onDisk).toBe(`# 第1章\n\n${clean}\n`);
  });

  it("execute 端到端接线：candidates:3 → 3 个 writer 的 temperature 依次错开（基准/+0.15/封顶 1.0），不走单候选 writer、不接流式 sink", async () => {
    const projectDir = await makeProject("多候选接线", "林远");
    const clean = inRangeBody("林远");
    const llmClientModule = await import("../../lib/llm-client.js");
    const spyResolve = vi.spyOn(llmClientModule, "resolveConfiguredChatModel").mockResolvedValue({
      provider: { id: "p", baseUrl: "http://127.0.0.1:1", apiKeyEnv: "TEST_KEY" },
      profile: { id: "prof", provider: "p", model: "test-model", temperature: 0.8 },
      apiKey: "k",
      thinking: false,
      thinkingDialect: "none",
    } as unknown as Awaited<ReturnType<typeof llmClientModule.resolveConfiguredChatModel>>);
    const seenTemperatures: (number | undefined)[] = [];
    const bodies = [`${inRangeBody("林远")}\n\n${FLAVOR_TAIL}`, clean, "林远走进了房间。"];
    let callIndex = 0;
    const spyCreate = vi.spyOn(llmClientModule, "createOpenAICompatibleWriterClient").mockImplementation(
      ((configured: { profile: { temperature?: number } }, onDelta?: unknown) => {
        seenTemperatures.push(configured.profile.temperature);
        expect(onDelta).toBeUndefined(); // 多候选采样绝不逐字流进编辑器（N 版会串稿）
        const body = bodies[callIndex];
        callIndex += 1;
        return { async generateDraft() { return { title: "第1章", content: body }; } };
      }) as unknown as typeof llmClientModule.createOpenAICompatibleWriterClient,
    );
    const spyWriter = vi.spyOn(llmClientModule, "createConfiguredWriterClient");
    const spyStream = vi.spyOn(llmClientModule, "streamChatModelToText");

    try {
      const context = {
        requestContext: buildProjectRequestContext(projectDir, 1, undefined, "写第1章正文，多写几版挑一挑。"),
      } as unknown as ToolExecutionContext;
      const execute = generateDraftTool.execute as unknown as (input: Record<string, unknown>, ctx: ToolExecutionContext) => Promise<{
        ok: boolean; summary: string; candidatesReport?: readonly { index: number; chosen: boolean }[];
      }>;
      const out = await execute({ candidates: 3 }, context);

      expect(out.ok).toBe(true);
      // 基准 0.8 / +0.15 / +0.3→封顶 1.0（部分 provider temperature 上限为 1）
      expect(seenTemperatures).toEqual([0.8, 0.95, 1.0]);
      expect(spyResolve).toHaveBeenCalledWith("fastDraft");
      expect(spyWriter).not.toHaveBeenCalled(); // 多候选不走单候选 writer 通道
      expect(spyStream).not.toHaveBeenCalled(); // 优胜稿干净 → autoDeAi 不触发改写
      expect(out.candidatesReport).toHaveLength(3);
      expect(out.candidatesReport?.[1]).toMatchObject({ index: 2, chosen: true });
      expect(out.summary).toContain("已生成 3 个候选并选出第 2 个");
      const onDisk = await readFile(defaultDraftPath(projectDir, 1), "utf-8");
      expect(onDisk).toBe(`# 第1章\n\n${clean}\n`);
    } finally {
      spyResolve.mockRestore();
      spyCreate.mockRestore();
      spyWriter.mockRestore();
      spyStream.mockRestore();
    }
  });

  // P3-3：base 温度已封顶 1.0 时，旧实现三候选同温（全撞 Math.min(1,…)）防坍缩静默失效 → 向下错开，
  // 且实际温度如实进 candidatesReport（不再只说「依次错开」却给了三个同温）。
  it("execute 端到端接线：profile 温度已封顶 1.0 时向下错开（1.0/0.85/0.7 互不相同且递减），实际温度进 candidatesReport", async () => {
    const projectDir = await makeProject("多候选封顶错温", "林远");
    const clean = inRangeBody("林远");
    const llmClientModule = await import("../../lib/llm-client.js");
    const spyResolve = vi.spyOn(llmClientModule, "resolveConfiguredChatModel").mockResolvedValue({
      provider: { id: "p", baseUrl: "http://127.0.0.1:1", apiKeyEnv: "TEST_KEY" },
      profile: { id: "prof", provider: "p", model: "test-model", temperature: 1.0 }, // base 已封顶
      apiKey: "k",
      thinking: false,
      thinkingDialect: "none",
    } as unknown as Awaited<ReturnType<typeof llmClientModule.resolveConfiguredChatModel>>);
    const seenTemperatures: (number | undefined)[] = [];
    const bodies = [`${inRangeBody("林远")}\n\n${FLAVOR_TAIL}`, clean, "林远走进了房间。"];
    let callIndex = 0;
    const spyCreate = vi.spyOn(llmClientModule, "createOpenAICompatibleWriterClient").mockImplementation(
      ((configured: { profile: { temperature?: number } }) => {
        seenTemperatures.push(configured.profile.temperature);
        const body = bodies[callIndex];
        callIndex += 1;
        return { async generateDraft() { return { title: "第1章", content: body }; } };
      }) as unknown as typeof llmClientModule.createOpenAICompatibleWriterClient,
    );
    const spyWriter = vi.spyOn(llmClientModule, "createConfiguredWriterClient");
    const spyStream = vi.spyOn(llmClientModule, "streamChatModelToText");

    try {
      const context = {
        requestContext: buildProjectRequestContext(projectDir, 1, undefined, "写第1章正文，多写几版挑一挑。"),
      } as unknown as ToolExecutionContext;
      const execute = generateDraftTool.execute as unknown as (input: Record<string, unknown>, ctx: ToolExecutionContext) => Promise<{
        ok: boolean; summary: string; candidatesReport?: readonly { index: number; chosen: boolean; temperature?: number }[];
      }>;
      const out = await execute({ candidates: 3 }, context);

      expect(out.ok).toBe(true);
      // 向下错开：三候选温度互不相同且递减（旧行为会是 [1.0, 1.0, 1.0] 同温静默失效）
      expect(seenTemperatures).toEqual([1.0, 0.85, 0.7]);
      // 实际温度如实进逐候选报告
      expect(out.candidatesReport?.map((entry) => entry.temperature)).toEqual([1.0, 0.85, 0.7]);
      expect(out.candidatesReport?.[1]).toMatchObject({ index: 2, chosen: true });
      const onDisk = await readFile(defaultDraftPath(projectDir, 1), "utf-8");
      expect(onDisk).toBe(`# 第1章\n\n${clean}\n`);
    } finally {
      spyResolve.mockRestore();
      spyCreate.mockRestore();
      spyWriter.mockRestore();
      spyStream.mockRestore();
    }
  });
});
