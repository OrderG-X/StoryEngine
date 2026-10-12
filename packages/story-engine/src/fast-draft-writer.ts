import { join } from "node:path";
import type { ChapterPlan } from "./chapter-plan.js";
import { cjkBigrams } from "./text-similarity.js";
import {
  buildAiFlavorReport,
  detectAiFlavorViolations,
  type AiFlavorReport,
  type AiFlavorRule,
} from "./ai-flavor-detection.js";
import {
  estimateTokens,
  buildWriterContext,
  type WriterContextEnvelope,
} from "./context-gateway.js";
import { checkDraftBeatFidelity, type BeatFidelityReport } from "./draft-beat-fidelity.js";
import {
  applyDraftLengthConstraint,
  buildDraftLengthReport,
  resolveDraftLengthTarget,
  resolveDraftMaxOutputTokens,
  trimDraftBodyToLengthTarget,
  type DraftLengthReport,
} from "./draft-length-control.js";
import {
  attachDiagnostics,
  recordContextStats,
  recordRuntimeLatency,
  recordTokenUsage,
  startRuntimeLatency,
  writeDiagnostics,
  type DiagnosticsRecord,
} from "./diagnostics.js";
import { buildPromptFingerprint, type PromptFingerprint } from "./prompt-cache-diagnostics.js";
import { describeErrorBriefly, PLACEHOLDER_CHARACTER_NAME, readWritingRules, writeFileAtomic } from "./project-store.js";
import type { CharacterProfile } from "./types.js";

export { resolveDraftMaxOutputTokens } from "./draft-length-control.js";

export interface WriterClient {
  readonly generateDraft: (input: {
    readonly context: WriterContextEnvelope;
    readonly maxOutputTokens: number;
  }) => Promise<{
    readonly title: string;
    readonly content: string;
    readonly tokenUsage?: TokenUsage;
    readonly cacheMetrics?: CacheMetrics;
  }>;
}

export interface TokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface CacheMetrics {
  readonly provider: string;
  readonly promptCacheHitTokens: number | null;
  readonly promptCacheMissTokens: number | null;
  readonly cacheHitRatio: number | null;
  readonly rawCacheMetadata: Record<string, unknown> | null;
  readonly cacheMetricsAvailable: boolean;
}

export interface FastDraftInput {
  readonly projectDir: string;
  readonly chapter: number;
  readonly chapterGoal: string;
  readonly writerClient: WriterClient;
  readonly selectedCharacterIds?: readonly string[];
  readonly selectedHookIds?: readonly string[];
  /**
   * 时间线相关段的条数请求：可裁的 `timeline_events` 段按它取最近 N 条（默认 5）；
   * 受保护的 `writing_context_pack` 内时间线摘要另自限 ≤3 条（传更大值不会顶爆保护段）。
   */
  readonly maxTimelineEvents?: number;
  /** 用户/agent 指定的本章必须命中要点：注入「本章硬约束」让模型逐条落实，出稿后确定性核对（Codex 复测：首稿跑偏）。 */
  readonly mustHitBeats?: readonly string[];
  /** 本章章纲（阶段 2「先想后写」）：进受保护段并驱动翻旧资料，见 buildWriterContext。 */
  readonly chapterPlan?: ChapterPlan;
  /**
   * 按章纲分前后两半写（2026-10-08 十章验收第五轮）：写手一次只写得出一千八到两千字，「先写短、再接着续」的续写
   * 会越过章纲最后一步自己编新的一天、新地点（第五轮 58 处矛盾里 27 处出在续写）。有章纲且要点够多时，
   * 前半章只写前一半要点、后半章接着写剩下的要点并收尾——字数靠要点撑起来，而不是事后硬续。缺省 = 一次写完（旧行为）。
   */
  readonly segmentByPlan?: boolean;
  readonly rankContext?: (envelope: WriterContextEnvelope) => WriterContextEnvelope;
  readonly maxOutputTokens?: number;
  readonly requestedDraftLength?: number;
  readonly dryRun?: boolean;
  /**
   * persist=false（抽卡候选用）：照常调模型生成正文，但**不写工作稿文件**，把正文放进 report.draftBody 返回。
   * 让「再来一版」能临时生成 2–3 个候选并排给用户挑，不冲掉当前草稿、不污染操作历史。默认 true（写盘，原行为）。
   */
  readonly persist?: boolean;
  /**
   * AI 腔确定性回检规则（机制进引擎、策略留 UI：规则数据由上层传入，引擎不内置禁词表）。
   * 不传/空数组 → 完全不跑、报告里无 aiFlavor 字段（旧调用方零行为变化）；传了 → 出稿后跑
   * detectAiFlavorViolations，结果以 warning-only 放进 report.aiFlavor（绝不影响 passed、不拦稿、不触发重试）。
   */
  readonly aiFlavorRules?: readonly AiFlavorRule[];
}

export interface FastDraftReport {
  readonly chapter: number;
  readonly passed: boolean;
  readonly draftPath?: string;
  /** persist=false（抽卡候选）时正文放这里返回，不写文件。 */
  readonly draftBody?: string;
  readonly title?: string;
  readonly contextStats: {
    readonly totalTokenEstimate: number;
    readonly stableTokenEstimate: number;
    readonly dynamicTokenEstimate: number;
    readonly contextSections: readonly string[];
  };
  readonly tokenUsage?: TokenUsage;
  readonly cacheMetrics?: CacheMetrics;
  readonly promptFingerprint: PromptFingerprint;
  readonly draftLength?: DraftLengthReport;
  readonly beatFidelity?: BeatFidelityReport;
  /** AI 腔确定性回检（warning-only）：仅 input.aiFlavorRules 非空时出现。 */
  readonly aiFlavor?: AiFlavorReport;
  readonly diagnostics?: DiagnosticsRecord;
  readonly issues: readonly string[];
}

/**
 * 工作稿写盘的唯一通道：runFastDraft persist:true 与「先 persist:false 出候选、选出优胜再落盘」共用，
 * 保证 drafts/fast/chapter-XXXX.md 的路径与标题行格式（`# {title}\n\n{body}\n`）只有这一处定义，
 * 上层（路由抽卡落盘、agent 多候选选优落盘）绝不在引擎外另拼这个文件。
 */
export async function persistFastDraftBody(input: {
  readonly projectDir: string;
  readonly chapter: number;
  readonly title: string;
  readonly draftBody: string;
}): Promise<string> {
  const draftPath = join(input.projectDir, "drafts", "fast", `chapter-${padChapter(input.chapter)}.md`);
  // 审计 Med：工作稿正文（用户核心内容）原子写——JSON 全收口了，唯独 .md 还是裸 writeFile，
  // 进程被杀（OOM/断电）会留下截断的半章稿，且截断文件无解析校验、下次被当正常稿读走。
  await writeFileAtomic(draftPath, `# ${input.title}\n\n${input.draftBody.trim()}\n`);
  return draftPath;
}

/** 后半章里某段的两字片段有这么大比例出现在前半章同一段里，就算重演。 */
const REPLAY_CONTAINMENT = 0.55;
const REPLAY_MIN_CHARS = 24;

/** 后半章里重演前半章的段落（确定性：两字片段包含率）。 */
export function findReplayedParagraphs(firstHalf: string, secondHalf: string): readonly string[] {
  const firstParagraphs = firstHalf.split(/\n+/u).map((item) => item.trim()).filter(Boolean).map((text) => cjkBigrams(text));
  const replayed: string[] = [];
  for (const paragraph of secondHalf.split(/\n+/u).map((item) => item.trim()).filter(Boolean)) {
    const grams = cjkBigrams(paragraph);
    if (grams.size < REPLAY_MIN_CHARS) continue;
    const hit = firstParagraphs.some((first) => {
      let shared = 0;
      for (const gram of grams) if (first.has(gram)) shared += 1;
      return shared / grams.size >= REPLAY_CONTAINMENT;
    });
    if (hit) replayed.push(paragraph);
  }
  return replayed;
}

/** 章纲要点至少几条才分两半写（太少就一次写完）。 */
const MIN_BEATS_TO_SEGMENT = 4;
/**
 * 目标字数至少这么多才分两半写。原为 2600：2026-10-10 真机试写目标 2500 的书一次只写出一千六七，
 * 剩下一千多字靠续写补，硬伤几乎全出在续写段——一次写不够目标的都该分两半。1800 这类短章仍一次写完。
 */
const MIN_TARGET_TO_SEGMENT = 2000;

/** 改写某一段的内容（token 估算随之更新），其余段原样。 */
function withSectionContent(context: WriterContextEnvelope, name: string, content: unknown): WriterContextEnvelope {
  return {
    ...context,
    sections: context.sections.map((section) => (section.name === name ? { ...section, content, tokenEstimate: estimateTokens(content) } : section)),
  };
}

/**
 * 把分半写时每一半不同的段（本章目标、章纲）挪到最后：服务商缓存只认开头完全相同的前缀，
 * 原先它们排在上一章原文、事实、线索这一大片前面，后半章调用从这里起就和前半章不同，后面整片都吃不到缓存
 * （2026-10-10 实测：内部调用 7.2 万输入只命中 0.3 万）。
 */
function withSectionsLast(context: WriterContextEnvelope, names: readonly string[]): WriterContextEnvelope {
  const moved = names.flatMap((name) => context.sections.filter((section) => section.name === name));
  return { ...context, sections: [...context.sections.filter((section) => !names.includes(section.name)), ...moved] };
}

/** 每一半各自不同的段，放在最后（见 withSectionsLast）。 */
const PER_HALF_SECTIONS = ["chapter_plan", "chapter_goal"] as const;

function withExtraSection(context: WriterContextEnvelope, name: string, content: unknown): WriterContextEnvelope {
  return {
    ...context,
    sections: [...context.sections, { name, content, tokenEstimate: estimateTokens(content), cachePolicy: "dynamic" as const }],
  };
}

/** 要点里明写了换天（第二天 / 次日 / 几天后……）才允许一章跨天。 */
const DAY_CHANGE = /第二天|第二日|次日|翌日|隔天|隔日|转天|两天后|三天后|几天后|数日后|过了[一两三几\d]+天/u;

/**
 * 分半写时每一半只写自己的要点（第十四轮验收：章纲段原样给前半章，「每个要点都要真正写到」压过了
 * 「只写前一半」——第 8、10 章前半就写完全部要点，后半无事可写只好重演或凭空多出一天）。
 * 前半章仍看得到后半章要写什么（标成「这次不写」）：第十五轮完全不给，前半章不知道场面还要接着演，
 * 自己把人送出门、把匣子当场打开，后半章再按要点写就跟它打架。
 */
function planSectionForHalf(
  planSection: Record<string, unknown>,
  half: "first" | "second",
  beats: readonly string[],
  split: number,
): Record<string, unknown> {
  const { summary: _summary, newInformation, threadsAdvanced, beats: _beats, instruction: _instruction, ...rest } = planSection;
  if (half === "first") {
    return {
      ...rest,
      instruction: [
        `这是本章前半章要写的部分：只写 beats 里这 ${split} 个要点，按顺序写。`,
        `laterBeats 是后半章另写的要点，这次一个字都不写、不提前透露；前半章也不要写出和它们对不上的事（后面还要出场的人别先送走，后面才出现的东西别先拿出来）。`,
        "写到最后一个要点刚写完就停：场面不收尾、人物不离场、不总结。",
      ].join(""),
      beats: beats.slice(0, split),
      laterBeats: beats.slice(split),
    };
  }
  return {
    ...rest,
    instruction: [
      `这是本章后半章要写的部分。前半章（already_written）已经写完了 alreadyDone 里的要点，那些事都发生过了，不再写一遍、不换个说法再来一次。`,
      `只写下面这 ${beats.length - split} 个要点，按顺序写，写到最后一个自然收住本章。`,
      newInformation ? "「本章新信息」前半章没写出来的，要在后半章明确写出。" : "",
      "「本章不要重复」里的内容不得再写一遍。",
    ].join(""),
    alreadyDone: beats.slice(0, split),
    beats: beats.slice(split),
    ...(newInformation ? { newInformation } : {}),
    ...(threadsAdvanced ? { threadsAdvanced } : {}),
  };
}

export interface SegmentedDraftInfo {
  /** 前半章写到第几个要点。 */
  readonly split: number;
  /** 后半章首稿里重演前半章的段数。 */
  readonly replayedFound: number;
  /** 检出重演后是否重写过后半章。 */
  readonly retried: boolean;
  /** 最终留下的后半章里还重演着的段数。 */
  readonly replayedRemaining: number;
  /** 前半章首稿照抄上一章的段数，与重写后还剩的段数。 */
  readonly copiedFromPrevious: number;
  readonly copiedRemaining: number;
}

/** 前半章与上一章原文至少这么多段高度重合才重写（偶尔一段回顾不算照抄）。 */
const COPY_RETRY_MIN_PARAGRAPHS = 2;

function previousChapterText(context: WriterContextEnvelope): string | undefined {
  const content = context.sections.find((section) => section.name === "previous_chapter")?.content as { readonly text?: unknown } | undefined;
  return typeof content?.text === "string" && content.text.trim() ? content.text : undefined;
}

/**
 * 前半章：只写前一半要点、停在半途（不收尾）；后半章：带上已写好的前半章原文，接着写剩下的要点并收住本章。
 * 后半章没写成 → 只交前半章（如实记一条 issue），后续的「续写够字数」环节会兜底。
 */
async function generateBySegments(input: {
  readonly writerClient: WriterClient;
  readonly context: WriterContextEnvelope;
  readonly plan: ChapterPlan;
  readonly rawChapterGoal: string;
  readonly lengthTarget: ReturnType<typeof resolveDraftLengthTarget>;
  readonly maxOutputTokens: number;
}): Promise<{
  readonly generated: Awaited<ReturnType<WriterClient["generateDraft"]>>;
  readonly secondHalfError?: string;
  readonly info?: SegmentedDraftInfo;
}> {
  const beats = input.plan.beats;
  const split = Math.ceil(beats.length / 2);
  const half = Math.round(input.lengthTarget.requested / 2);
  const numbered = (from: number, to: number) => beats.slice(from, to).map((beat, index) => `${from + index + 1}. ${beat}`).join("  ");
  const planSection = input.context.sections.find((section) => section.name === "chapter_plan")?.content as Record<string, unknown> | undefined;
  // 一章默认在同一天里（章纲只记一个故事日）：第十四轮后半章凭空写「第二天」，正文比日历多走两天、截止日无声越过。
  const sameDay = beats.some((beat) => DAY_CHANGE.test(beat))
    ? ""
    : `本章都在同一天里${input.plan.storyDay ? `（故事第 ${input.plan.storyDay} 天）` : ""}，不要写「第二天」「次日」「几天后」这类跳天。`;

  // 作者没给方向时本章目标就是章纲的整章一句话——前半章看到它也会往全章结局写，前半章不给。
  const firstGoal = [
    input.rawChapterGoal.trim() === input.plan.summary.trim() ? "" : input.rawChapterGoal,
    "",
    `【本章分前后两半写，这次是前半章】只写章纲要点 1–${split}：${numbered(0, split)}。`,
    `前半章写 ${half} 个中文字符左右（不少于 ${Math.round(half * 0.85)}）。写到第 ${split} 个要点结束处就停，不要收尾、不要总结、不要提前写后面的要点。`,
    sameDay,
  ].filter(Boolean).join("\n");
  let firstContext = withSectionContent(withSectionsLast(input.context, PER_HALF_SECTIONS), "chapter_goal", { chapter: input.plan.chapter, goal: firstGoal });
  if (planSection) firstContext = withSectionContent(firstContext, "chapter_plan", planSectionForHalf(planSection, "first", beats, split));
  let first = await input.writerClient.generateDraft({ context: firstContext, maxOutputTokens: input.maxOutputTokens });
  let firstBody = stripLeadingMarkdownChapterHeading(first.content).trim();
  // 前半章照抄上一章（第二十一轮第 3 章前半把第 2 章 3500 字一字不差重写了一遍，本章要点一个没写）：
  // 与上一章原文有两段以上高度重合 → 带提示重写前半章一次，取照抄更少的那版。
  const previousText = previousChapterText(input.context);
  const copied = previousText ? findReplayedParagraphs(previousText, firstBody) : [];
  let copiedRemaining = copied.length;
  if (copied.length >= COPY_RETRY_MIN_PARAGRAPHS) {
    const retryGoal = [
      firstGoal,
      `【上一次的前半章把上一章的原文又写了一遍】例如：「${copied.slice(0, 2).map((text) => text.slice(0, 60)).join("」「")}」。上一章已经写完了，本章从上一章结尾之后接着写本章的要点，一句都不要照抄上一章。`,
    ].join("\n");
    const retry = await input.writerClient.generateDraft({
      context: withSectionContent(firstContext, "chapter_goal", { chapter: input.plan.chapter, goal: retryGoal }),
      maxOutputTokens: input.maxOutputTokens,
    }).catch(() => undefined);
    const retryBody = retry ? stripLeadingMarkdownChapterHeading(retry.content).trim() : "";
    const retryCopied = retryBody && previousText ? findReplayedParagraphs(previousText, retryBody).length : copied.length;
    if (retry && retryBody && retryCopied < copied.length) {
      first = retry;
      firstBody = retryBody;
      copiedRemaining = retryCopied;
    }
  }

  const secondGoal = [
    input.rawChapterGoal,
    "",
    `【本章分前后两半写，这次是后半章】前半章已经写好（见 already_written，那是本章正文，一个字都不要重写、不要复述）。`,
    `前半章已经写过要点 1–${split}（${numbered(0, split)}）：这些事已经发生了，后半章不要再写一遍、不要换个说法再来一次，人物也不要再「第一次」看见或说起它们。`,
    `紧接前半章最后一句往下写，只写章纲要点 ${split + 1}–${beats.length}：${numbered(split, beats.length)}。`,
    `后半章写 ${half} 个中文字符左右（不少于 ${Math.round(half * 0.85)}），写到最后一个要点自然收住本章。不要写标题。`,
    sameDay ? `后半章紧接前半章最后一句的时刻往下写。${sameDay}` : "",
  ].filter(Boolean).join("\n");
  let secondContext = withSectionContent(withSectionsLast(input.context, PER_HALF_SECTIONS), "chapter_goal", { chapter: input.plan.chapter, goal: secondGoal });
  if (planSection) secondContext = withSectionContent(secondContext, "chapter_plan", planSectionForHalf(planSection, "second", beats, split));
  secondContext = withExtraSection(secondContext, "already_written", {
    instruction: "这是本章已经写好的前半章正文。从它最后一句之后接着写，人物所在位置、手里的东西、时间都从这里接上。",
    text: firstBody,
  });
  try {
    const second = await input.writerClient.generateDraft({ context: secondContext, maxOutputTokens: input.maxOutputTokens });
    let secondBody = stripLeadingMarkdownChapterHeading(second.content).trim();
    if (!secondBody) throw new Error("后半章是空的");
    // 接缝重演检测（第十三轮验收：后半章把前半章的整场戏重演一遍，7 处矛盾出在接缝）：后半章有段落与前半章
    // 某段高度重合 → 带着被重演的片段提示重写后半章一次，取重演更少的那版。确定性检测、只在检出时多花一次调用。
    // 后半章既不能重演前半章，也不能照抄上一章。
    const alreadyWritten = previousText ? `${firstBody}\n${previousText}` : firstBody;
    const replays = findReplayedParagraphs(alreadyWritten, secondBody);
    let retried = false;
    let replayedRemaining = replays.length;
    if (replays.length > 0) {
      const retryGoal = [
        secondGoal,
        `【上一次的后半章把前半章（或上一章）已经写过的场面又写了一遍】例如：「${replays.slice(0, 2).map((text) => text.slice(0, 60)).join("」「")}」。这些都已经发生过了，这次绝对不要重演，从前半章最后一句之后往前推进新的事。`,
      ].join("\n");
      const retry = await input.writerClient.generateDraft({
        context: withSectionContent(secondContext, "chapter_goal", { chapter: input.plan.chapter, goal: retryGoal }),
        maxOutputTokens: input.maxOutputTokens,
      }).catch(() => undefined);
      const retryBody = retry ? stripLeadingMarkdownChapterHeading(retry.content).trim() : "";
      retried = retryBody.length > 0;
      const retryReplays = retryBody ? findReplayedParagraphs(alreadyWritten, retryBody).length : replays.length;
      if (retryBody && retryReplays < replays.length) {
        secondBody = retryBody;
        replayedRemaining = retryReplays;
      }
    }
    return {
      generated: {
        ...first,
        content: `${first.content.match(/^#[^\n]*\n/u)?.[0] ?? ""}${firstBody}\n\n${secondBody}`,
      },
      info: { split, replayedFound: replays.length, retried, replayedRemaining, copiedFromPrevious: copied.length, copiedRemaining },
    };
  } catch (error) {
    return {
      generated: first,
      secondHalfError: `后半章没写成（${describeErrorBriefly(error)}），只交了前半章，字数不够的部分由后续续写环节补。`,
    };
  }
}

export async function runFastDraft(input: FastDraftInput): Promise<FastDraftReport> {
  const latencyTimer = startRuntimeLatency();
  // P2 铁律④：损坏的 writing-rules.json 此前静默降级为 null——模型拿不到任何风格/篇幅规则，
  // 出稿质量悄悄掉档而用户一无所知。降级仍要（不能让一次坏读盘炸掉出稿），但原因要进 issues。
  const writingRulesFailure: string[] = [];
  const writingRules = await readWritingRules(input.projectDir).catch((error) => {
    // errno code/错误类型 + 相对文件名，绝不拼 error.message 原文（带本地绝对路径=泄漏）。
    writingRulesFailure.push(
      `写作规则读取失败（story/writing-rules.json，${describeErrorBriefly(error)}），已降级为无规则。`,
    );
    return null;
  });
  const draftLengthTarget = resolveDraftLengthTarget({
    chapterGoal: input.chapterGoal,
    requestedDraftLength: input.requestedDraftLength,
    writingRules,
  });
  const chapterGoal = applyDraftLengthConstraint(input.chapterGoal, draftLengthTarget);
  const emptyDraftLength = buildDraftLengthReport({
    draftBody: "",
    lengthTarget: draftLengthTarget,
  });
  // P1-5 真修（2026-09-15）：上下文构造真进 try——任何读盘/构包失败（含 rankContext 注入函数抛错）
  // 都落成 passed:false + writer_context_unavailable，绝不让 runFastDraft 整体 reject 砸穿调用方。
  let context: WriterContextEnvelope;
  try {
    const builtContext = await buildWriterContext({
      projectDir: input.projectDir,
      chapter: input.chapter,
      chapterGoal,
      selectedCharacterIds: input.selectedCharacterIds,
      selectedHookIds: input.selectedHookIds,
      maxTimelineEvents: input.maxTimelineEvents,
      ...(input.mustHitBeats && input.mustHitBeats.length > 0 ? { mustHitBeats: input.mustHitBeats } : {}),
      ...(input.chapterPlan ? { chapterPlan: input.chapterPlan } : {}),
    });
    context = input.rankContext ? input.rankContext(builtContext) : builtContext;
  } catch (error) {
    // 上下文不存在时没有真实 section 可统计——给空壳包底的零值指纹/统计，报告结构仍完整诚实。
    const emptyContext = emptyWriterContext(input.chapter);
    return withFastDraftDiagnostics(input.projectDir, {
      chapter: input.chapter,
      passed: false,
      contextStats: buildContextStats(emptyContext),
      promptFingerprint: buildPromptFingerprint(emptyContext),
      draftLength: emptyDraftLength,
      issues: [
        ...writingRulesFailure,
        `writer_context_unavailable: 写作上下文读取失败（${describeErrorBriefly(error, input.projectDir)}），未生成本章草稿。`,
      ],
    }, latencyTimer);
  }
  const contextStats = buildContextStats(context);
  const promptFingerprint = buildPromptFingerprint(context);
  if (input.dryRun === true) {
    return withFastDraftDiagnostics(input.projectDir, {
      chapter: input.chapter,
      passed: true,
      draftLength: emptyDraftLength,
      contextStats,
      promptFingerprint,
      issues: writingRulesFailure,
    }, latencyTimer);
  }

  try {
    const maxOutputTokens = input.maxOutputTokens ?? resolveDraftMaxOutputTokens(draftLengthTarget);
    // 目标字数不高（写手一次就写得出）时不分：第十二轮目标 1800 也拆成两个 900，平白多出接缝和重演。
    const segmented = input.segmentByPlan && input.chapterPlan && input.chapterPlan.beats.length >= MIN_BEATS_TO_SEGMENT
      && draftLengthTarget.requested >= MIN_TARGET_TO_SEGMENT
      ? await generateBySegments({
        writerClient: input.writerClient,
        context,
        plan: input.chapterPlan,
        rawChapterGoal: input.chapterGoal,
        lengthTarget: draftLengthTarget,
        maxOutputTokens,
      })
      : undefined;
    const generated = segmented?.generated ?? await input.writerClient.generateDraft({ context, maxOutputTokens });
    if (segmented?.secondHalfError) writingRulesFailure.push(segmented.secondHalfError);
    if (segmented?.info && segmented.info.copiedFromPrevious >= COPY_RETRY_MIN_PARAGRAPHS) {
      writingRulesFailure.push(segmented.info.copiedRemaining < COPY_RETRY_MIN_PARAGRAPHS
        ? `前半章首稿照抄了上一章 ${segmented.info.copiedFromPrevious} 段，已重写前半章。`
        : `前半章首稿照抄了上一章 ${segmented.info.copiedFromPrevious} 段，重写后仍有 ${segmented.info.copiedRemaining} 段与上一章相近，请留意。`);
    }
    // 接缝重演留痕（第十四轮审读：检出与重写都没留下记录，事后查不到这一步做了什么）。
    if (segmented?.info && segmented.info.replayedFound > 0) {
      writingRulesFailure.push(segmented.info.replayedRemaining === 0
        ? `后半章首稿重演了前半章 ${segmented.info.replayedFound} 段，已重写后半章。`
        : `后半章首稿重演了前半章 ${segmented.info.replayedFound} 段，${segmented.info.retried ? "重写后" : ""}仍有 ${segmented.info.replayedRemaining} 段与前半章相近。`);
    }
    const generatedTitle = chooseDraftTitle(input.chapter, generated.title, generated.content);
    const rawDraftBody = stripMarkdownEmphasis(stripLeadingMarkdownChapterHeading(generated.content));
    const rawDraftLength = buildDraftLengthReport({
      draftBody: rawDraftBody,
      lengthTarget: draftLengthTarget,
    });
    // 分两半写的稿超了上限不裁：裁只能从结尾往前砍，砍掉的正是章纲最后几个要点
    // （第十七轮第 4 章停在半句对白上，要点 5 后半和要点 6 全丢）。超出多少如实记一条，交作者定。
    const overLengthKept = Boolean(segmented) && rawDraftLength.lengthStatus === "above_upper_bound";
    if (overLengthKept) {
      writingRulesFailure.push(`正文 ${rawDraftLength.actualLength} 字，超过上限 ${draftLengthTarget.upperBound} 字；分两半写的稿不从结尾裁（会截掉最后的要点），留给你定。`);
    }
    const trimResult = rawDraftLength.lengthStatus === "above_upper_bound" && !overLengthKept
      ? trimDraftBodyToLengthTarget(rawDraftBody, draftLengthTarget)
      : undefined;
    const draftBody = trimResult?.ok ? trimResult.draftBody : rawDraftBody;
    const draftLength = buildDraftLengthReport({
      draftBody,
      lengthTarget: draftLengthTarget,
      ...(trimResult?.ok
        ? {
          finalLengthAfterTrim: trimResult.finalLength,
          whetherTrimmed: trimResult.draftBody !== rawDraftBody.trim(),
        }
        : {}),
    });
    const normalizedGenerated = { ...generated, title: generatedTitle, content: draftBody };
    // 出稿后确定性保真核对：用户/agent 指定的必命中要点里的具体锚点（编号/数字+量词+名物）漏了就软警告（不阻塞）。
    const beatFidelity = input.mustHitBeats && input.mustHitBeats.length > 0
      ? checkDraftBeatFidelity({ draftContent: normalizedGenerated.content, mustHitBeats: input.mustHitBeats })
      : undefined;
    // AI 腔确定性回检（规则数据由上层传入）：与 beatFidelity 同级的 warning-only 软警告——
    // 绝不影响 passed、不拦稿、不触发重试；不传规则则完全跳过（向后兼容）。
    const aiFlavor = input.aiFlavorRules && input.aiFlavorRules.length > 0
      ? buildAiFlavorReport(detectAiFlavorViolations(normalizedGenerated.content, input.aiFlavorRules))
      : undefined;
    const issues = validateDraft(normalizedGenerated, context);
    if (trimResult && !trimResult.ok) {
      issues.push("Draft content could not be safely trimmed within the requested length range.");
    }
    if (issues.length > 0) {
      return withFastDraftDiagnostics(input.projectDir, {
        chapter: input.chapter,
        passed: false,
        title: generatedTitle,
        contextStats,
        promptFingerprint,
        draftLength,
        tokenUsage: generated.tokenUsage,
        cacheMetrics: generated.cacheMetrics,
        ...(beatFidelity ? { beatFidelity } : {}),
        ...(aiFlavor ? { aiFlavor } : {}),
        // 校验失败早退同样并 writingRulesFailure——降级留痕不能因稿子没过校验被吞
        // （与其余三条返回路径同口径，复审 C 级）。
        issues: [...writingRulesFailure, ...issues],
      }, latencyTimer);
    }

    if (input.persist === false) {
      // 抽卡候选：不写工作稿、不动磁盘，把正文交回路由临时展示。
      return withFastDraftDiagnostics(input.projectDir, {
        chapter: input.chapter,
        passed: true,
        draftBody: normalizedGenerated.content.trim(),
        title: generatedTitle,
        contextStats,
        promptFingerprint,
        draftLength,
        tokenUsage: generated.tokenUsage,
        cacheMetrics: generated.cacheMetrics,
        ...(beatFidelity ? { beatFidelity } : {}),
        ...(aiFlavor ? { aiFlavor } : {}),
        issues: writingRulesFailure,
      }, latencyTimer);
    }

    const draftPath = await persistFastDraftBody({
      projectDir: input.projectDir,
      chapter: input.chapter,
      title: generatedTitle,
      draftBody: normalizedGenerated.content,
    });
    return withFastDraftDiagnostics(input.projectDir, {
      chapter: input.chapter,
      passed: true,
      draftPath,
      title: generatedTitle,
      contextStats,
      promptFingerprint,
      draftLength,
      tokenUsage: generated.tokenUsage,
      cacheMetrics: generated.cacheMetrics,
      ...(beatFidelity ? { beatFidelity } : {}),
      ...(aiFlavor ? { aiFlavor } : {}),
      issues: writingRulesFailure,
    }, latencyTimer);
  } catch (error) {
    return withFastDraftDiagnostics(input.projectDir, {
      chapter: input.chapter,
      passed: false,
      contextStats,
      promptFingerprint,
      draftLength: emptyDraftLength,
      // describeErrorBriefly：errno/自造 code → 错误码+相对文件名；无路径分隔符的安全文案
      // （如缺 API key）原样放行——CLI 的 issues 契约（精确断言 adapter 文案）靠它保住。
      issues: [...writingRulesFailure, describeErrorBriefly(error, input.projectDir)],
    }, latencyTimer);
  }
}

/** 上下文构造失败时的空壳包底：仅用于产出结构完整的零值 contextStats/promptFingerprint。 */
function emptyWriterContext(chapter: number): WriterContextEnvelope {
  return {
    projectId: "",
    chapter,
    sections: [],
    trace: {
      sectionNames: [],
      totalTokenEstimate: 0,
      stableTokenEstimate: 0,
      dynamicTokenEstimate: 0,
      selectedCharacters: [],
      selectedHooks: [],
      selectedTimelineEvents: [],
    },
  };
}

async function withFastDraftDiagnostics(
  projectDir: string,
  report: FastDraftReport,
  latencyTimer: ReturnType<typeof startRuntimeLatency>,
): Promise<FastDraftReport> {
  // 审计 Low：诊断是旁证不是业务本身（commit 侧 withCommitDiagnostics 同款）——出稿已成功、稿已落盘后
  // 诊断写失败，绝不能把整次出稿翻改判成失败（调用方会按失败处理、抽卡正文白烧）。吞掉并留痕。
  let diagnostics: Awaited<ReturnType<typeof writeDiagnostics>>;
  try {
    diagnostics = await writeDiagnostics(projectDir, {
    stage: "fast-draft",
    chapter: report.chapter,
    generatedAt: new Date().toISOString(),
    runtimeLatency: recordRuntimeLatency(latencyTimer),
    ...(report.tokenUsage !== undefined ? { tokenUsage: recordTokenUsage(report.tokenUsage) } : {}),
    contextStats: recordContextStats(report.contextStats),
    details: {
      passed: report.passed,
      draftPath: report.draftPath,
      title: report.title,
      issueCount: report.issues.length,
      promptFingerprint: report.promptFingerprint,
      ...(report.draftLength !== undefined ? { draftLength: report.draftLength } : {}),
      ...(report.cacheMetrics !== undefined ? { cacheMetrics: report.cacheMetrics } : {}),
    },
  });
  } catch (error) {
    return {
      ...report,
      issues: [...report.issues, `诊断记录写入失败（${describeErrorBriefly(error, projectDir)}），不影响本次出稿结果。`],
    };
  }
  return attachDiagnostics(report, diagnostics);
}

function buildContextStats(context: WriterContextEnvelope): FastDraftReport["contextStats"] {
  const totalTokenEstimate = context.sections.reduce((sum, section) => sum + section.tokenEstimate, 0);
  const stableTokenEstimate = context.sections
    .filter((section) => section.cachePolicy === "stable")
    .reduce((sum, section) => sum + section.tokenEstimate, 0);
  return {
    totalTokenEstimate,
    stableTokenEstimate,
    dynamicTokenEstimate: totalTokenEstimate - stableTokenEstimate,
    contextSections: context.sections.map((section) => section.name),
  };
}

function validateDraft(
  generated: {
    readonly title: string;
    readonly content: string;
  },
  context: WriterContextEnvelope,
): string[] {
  const issues: string[] = [];
  const title = generated.title.trim();
  const content = generated.content.trim();
  if (!title) issues.push("Draft title is required.");
  if (!content) issues.push("Draft content is required.");
  if (content && looksLikeToolOrJsonArtifact(content)) {
    issues.push("Draft content looks like JSON or a tool-call artifact.");
  }

  const characterNames = selectedCharacterMentionCandidates(context);
  if (content && characterNames.length > 0 && !characterNames.some((name) => content.includes(name))) {
    issues.push(`Draft content must mention at least one selected character: ${characterNames.join(", ")}.`);
  }
  return issues;
}

function selectedCharacterMentionCandidates(context: WriterContextEnvelope): string[] {
  const profilesSection = context.sections.find((section) => section.name === "character_profile");
  const profiles = Array.isArray(profilesSection?.content)
    ? profilesSection.content as CharacterProfile[]
    : [];
  // 开书占位名（模板固定标记，如 UI 新建书未填主角名落的「主角」）不进选角关卡：占位名不是真名，
  // 正文当然不会写到它——拿它当门，作者没先改名就永远出不了稿（编辑部 R4.6，2026-10-13 真机验收 3.7）。
  // 与 commit-quality-check 的角色名门共用同一份 PLACEHOLDER_CHARACTER_NAME。真名（含「真名 / 主角」
  // 这类竖线复名拆出的真名段）照旧把关。
  return unique(profiles.flatMap((profile) => nameCandidates(profile.name)))
    .filter((name) => !PLACEHOLDER_CHARACTER_NAME.test(name));
}

function nameCandidates(name: string): string[] {
  const trimmed = name.trim();
  if (!trimmed) return [];
  return [trimmed, ...trimmed.split(/[\/／|｜,，、]/u).map((part) => part.trim())].filter(Boolean);
}

function looksLikeToolOrJsonArtifact(content: string): boolean {
  if (/^(?:\{|\[)/u.test(content)) {
    try {
      JSON.parse(content);
      return true;
    } catch {
      return false;
    }
  }
  return /tool_call|function_call|"arguments"\s*:|"name"\s*:/iu.test(content);
}

/**
 * 去掉小说正文里的 Markdown 强调记号：**粗体** / __粗体__ → 原文。
 * 模型偶尔把句子包成粗体，正文是纯文本、编辑器不渲染 Markdown，记号会原样出现在稿纸上（「**九号，西侧，二层。**」）。
 * 只认成对、同一行内的记号；单个星号（如「*」作分隔或引用）不动。题材中立、纯确定性。
 */
export function stripMarkdownEmphasis(content: string): string {
  return content
    .replace(/\*\*(?=\S)([^*\n]*?\S)\*\*/gu, "$1")
    .replace(/__(?=\S)([^_\n]*?\S)__/gu, "$1");
}

function stripLeadingMarkdownChapterHeading(content: string): string {
  const normalized = content.replace(/\r\n?/gu, "\n").trimStart();
  const lines = normalized.split("\n");
  const firstContentLineIndex = lines.findIndex((line) => line.trim().length > 0);
  if (firstContentLineIndex < 0) return normalized.trim();

  const firstContentLine = lines[firstContentLineIndex].trim();
  if (!isMarkdownChapterHeading(firstContentLine) && !isPlainChapterHeading(firstContentLine)) return normalized.trim();

  const nextLines = lines.slice(firstContentLineIndex + 1);
  while (nextLines[0]?.trim() === "") nextLines.shift();
  return nextLines.join("\n").trim();
}

function chooseDraftTitle(chapter: number, title: string, content: string): string {
  const modelHeadingTitle = extractLeadingChapterTitle(content);
  const cleanTitle = title.trim();
  if (modelHeadingTitle && !isGenericChapterTitle(modelHeadingTitle, chapter)) return modelHeadingTitle;
  if (cleanTitle && !isGenericChapterTitle(cleanTitle, chapter)) return cleanTitle;
  return `第${chapter}章`;
}

function extractLeadingChapterTitle(content: string): string | undefined {
  const normalized = content.replace(/\r\n?/gu, "\n").trimStart();
  const firstLine = normalized.split("\n").find((line) => line.trim().length > 0)?.trim();
  if (!firstLine) return undefined;
  if (isMarkdownChapterHeading(firstLine)) return firstLine.replace(/^#{1,6}\s+/u, "").trim();
  if (isPlainChapterHeading(firstLine)) return firstLine.trim();
  return undefined;
}

function isGenericChapterTitle(title: string, chapter: number): boolean {
  const trimmed = title.trim();
  return trimmed === `第${chapter}章` || /^第[一二三四五六七八九十百千万\d]+章$/u.test(trimmed);
}

function isMarkdownChapterHeading(line: string): boolean {
  if (!/^#{1,6}\s+\S/u.test(line)) return false;
  const title = line.replace(/^#{1,6}\s+/u, "").trim();
  if (!title) return false;
  if (/^第[一二三四五六七八九十百千万\d]+章(?:\s*[·：:、-]\s*.*)?$/u.test(title)) return true;
  return title.length <= 40 && !/[。！？!?；;]/u.test(title);
}

function isPlainChapterHeading(line: string): boolean {
  return /^第[一二三四五六七八九十百千万\d]+章(?:\s*[·：:、-]\s*[^。！？!?；;]{1,32})?$/u.test(line.trim());
}

function padChapter(chapter: number): string {
  return String(Math.max(0, Math.trunc(chapter))).padStart(4, "0");
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
