import type { ChapterPlan } from "../book/chapter-plan.js";
import { cjkBigrams } from "@actalk/story-core";
import {
  buildAiFlavorReport,
  detectAiFlavorViolations,
  type AiFlavorReport,
  type AiFlavorRule,
} from "@actalk/story-core";
import {
  estimateTokens,
  buildWriterContext,
  type LastDraftConflict,
  type WriterContextEnvelope,
  type WritingContextPack,
} from "./context-gateway.js";
import { checkDraftBeatFidelity, type BeatFidelityReport } from "@actalk/story-core";
import {
  applyDraftLengthConstraint,
  buildDraftLengthReport,
  countDraftChineseCharacters,
  draftLengthAim,
  lengthRulesOf,
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
import { describeErrorBriefly } from "../book/project-store.js";
import { readBibleTolerant } from "./setting-pack.js";
import { stripMarkdownEmphasis } from "../../lib/markdown-emphasis.js";
import { chinesePunctuation, chinesePunctuationLike } from "../../lib/dialogue-quotes.js";

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
  /** 本章要带的人物（名字，在场检测的结果）；不给就由上下文入口自己挑。 */
  readonly selectedCharacters?: readonly string[];
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
  /** 这一章上一稿核出的「确定」对不上（错在本章的）：进受保护段 last_draft_conflicts，见 buildWriterContext。 */
  readonly lastDraftConflicts?: readonly LastDraftConflict[];
  /**
   * 按章纲分前后两半写（2026-10-08 十章验收第五轮）：写手一次只写得出一千八到两千字，「先写短、再接着续」的续写
   * 会越过章纲最后一步自己编新的一天、新地点（第五轮 58 处矛盾里 27 处出在续写）。有章纲且要点够多时，
   * 前半章只写前一半要点、后半章接着写剩下的要点并收尾——字数靠要点撑起来，而不是事后硬续。缺省 = 一次写完（旧行为）。
   */
  readonly segmentByPlan?: boolean;
  /**
   * 接着往下写（P13）：text = 本章已经写好的正文（作者写的或上一版 AI 稿，不含标题行）。给了就不从头写：
   * 写手看着它从最后一句往下接，交回的正文 = 它原样 + 接着写的。length = 这次接着写多少字（不给 = 写到本章目标）；
   * direction = 作者这次说接下来写什么（原话；chapterGoal 在没给方向时是章纲一句话或套话，不能当作者的话）。
   */
  readonly continueFrom?: { readonly text: string; readonly length?: number; readonly direction?: string };
  /**
   * 正文流式进稿纸时，换掉已经流出去的字（参数 = 这次写的、稿纸上该显示的全部；接着写时不含本来写好的那段）：
   * 分两段写时接下一段前补个空行，某段要重写时先退回这段之前、定了用哪版再显示那版——不然稿纸上同一段写两遍，
   * 字数先涨后跌。不给 = 只追加。
   */
  readonly onStreamReset?: (visible: string) => void;
  readonly rankContext?: (envelope: WriterContextEnvelope) => WriterContextEnvelope;
  readonly maxOutputTokens?: number;
  readonly requestedDraftLength?: number;
  readonly dryRun?: boolean;
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
  /** 通过时的正文（不含标题行）。引擎不写盘：落工作稿统一走核心的 draft.write（重构 P7）。 */
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
/** 接着往下写、没说写多少时：离本章目标还差得比这少，也写这么多（已经够长了还让接着写，就是要往下推一段）。 */
const MIN_CONTINUE_LENGTH = 600;

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
        "只写正文：读者看到的是整章连着读，不要写「（前半章完）」「待续」这类分段标记或任何说明。",
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
  /** 整章不到下限、又要了一次后半章：之前和之后后半章的字数（没用上就相等）。 */
  readonly lengthRetry?: { readonly before: number; readonly after: number };
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
  readonly restream?: (visible: string) => void;
}): Promise<{
  readonly generated: Awaited<ReturnType<WriterClient["generateDraft"]>>;
  readonly secondHalfError?: string;
  readonly info?: SegmentedDraftInfo;
}> {
  const beats = input.plan.beats;
  const split = Math.ceil(beats.length / 2);
  const aim = draftLengthAim(input.lengthTarget);
  const half = Math.round(aim / 2);
  const numbered = (from: number, to: number) => beats.slice(from, to).map((beat, index) => `${from + index + 1}. ${beat}`).join("  ");
  const planSection = input.context.sections.find((section) => section.name === "chapter_plan")?.content as Record<string, unknown> | undefined;
  // 一章默认在同一天里（章纲只记一个故事日）：第十四轮后半章凭空写「第二天」，正文比日历多走两天、截止日无声越过。
  // 要点里有没有写换天交给模型自己读，不用词表猜（重构 P7「不猜」）。
  const sameDay = `本章从${input.plan.storyDay ? `故事第 ${input.plan.storyDay} 天` : "上一章结束的那天"}开始；章纲要点里没写换天，就都在同一天里，不要自己加「第二天」「次日」「几天后」这类跳天。`;

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
  let firstBody = stripTrailingSegmentMarkers(stripLeadingMarkdownChapterHeading(first.content)).trim();
  // 前半章照抄上一章（第二十一轮第 3 章前半把第 2 章 3500 字一字不差重写了一遍，本章要点一个没写）：
  // 与上一章原文有两段以上高度重合 → 带提示重写前半章一次，取照抄更少的那版。
  const previousText = previousChapterText(input.context);
  const copied = previousText ? findReplayedParagraphs(previousText, firstBody) : [];
  let copiedRemaining = copied.length;
  if (copied.length >= COPY_RETRY_MIN_PARAGRAPHS) {
    input.restream?.("");
    const retryGoal = [
      firstGoal,
      `【上一次的前半章把上一章的原文又写了一遍】例如：「${copied.slice(0, 2).map((text) => text.slice(0, 60)).join("」「")}」。上一章已经写完了，本章从上一章结尾之后接着写本章的要点，一句都不要照抄上一章。`,
    ].join("\n");
    const retry = await input.writerClient.generateDraft({
      context: withSectionContent(firstContext, "chapter_goal", { chapter: input.plan.chapter, goal: retryGoal }),
      maxOutputTokens: input.maxOutputTokens,
    }).catch(() => undefined);
    const retryBody = retry ? stripTrailingSegmentMarkers(stripLeadingMarkdownChapterHeading(retry.content)).trim() : "";
    const retryCopied = retryBody && previousText ? findReplayedParagraphs(previousText, retryBody).length : copied.length;
    if (retry && retryBody && retryCopied < copied.length) {
      first = retry;
      firstBody = retryBody;
      copiedRemaining = retryCopied;
    }
  }

  // 后半章补足前半章少写的（写手越到后面越短：长篇连写第 26～29 章首稿多在下限上下，前半章短了后半章还按一半要）。
  const secondTarget = Math.max(half, aim - countDraftChineseCharacters(firstBody));
  // 稿纸上：前半章（重写过就是用上的那版）+ 空行，后半章从这里往下流。
  const firstVisible = `${first.content.match(/^#[^\n]*\n/u)?.[0] ?? ""}${firstBody}\n\n`;
  input.restream?.(firstVisible);
  const secondGoal = [
    input.rawChapterGoal,
    "",
    `【本章分前后两半写，这次是后半章】前半章已经写好（见 already_written，那是本章正文，一个字都不要重写、不要复述）。`,
    `前半章已经写过要点 1–${split}（${numbered(0, split)}）：这些事已经发生了，后半章不要再写一遍、不要换个说法再来一次，人物也不要再「第一次」看见或说起它们。`,
    `紧接前半章最后一句往下写，只写章纲要点 ${split + 1}–${beats.length}：${numbered(split, beats.length)}。`,
    `后半章写 ${secondTarget} 个中文字符左右（不少于 ${Math.round(secondTarget * 0.85)}），写到最后一个要点自然收住本章。不要写标题。`,
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
    let secondBody = stripTrailingSegmentMarkers(stripLeadingMarkdownChapterHeading(second.content)).trim();
    if (!secondBody) throw new Error("后半章是空的");
    // 接缝重演检测（第十三轮验收：后半章把前半章的整场戏重演一遍，7 处矛盾出在接缝）：后半章有段落与前半章
    // 某段高度重合 → 带着被重演的片段提示重写后半章一次，取重演更少的那版。确定性检测、只在检出时多花一次调用。
    // 后半章既不能重演前半章，也不能照抄上一章。
    const alreadyWritten = previousText ? `${firstBody}\n${previousText}` : firstBody;
    const replays = findReplayedParagraphs(alreadyWritten, secondBody);
    let retried = false;
    let replayedRemaining = replays.length;
    if (replays.length > 0) {
      input.restream?.(firstVisible);
      const retryGoal = [
        secondGoal,
        `【上一次的后半章把前半章（或上一章）已经写过的场面又写了一遍】例如：「${replays.slice(0, 2).map((text) => text.slice(0, 60)).join("」「")}」。这些都已经发生过了，这次绝对不要重演，从前半章最后一句之后往前推进新的事。`,
      ].join("\n");
      const retry = await input.writerClient.generateDraft({
        context: withSectionContent(secondContext, "chapter_goal", { chapter: input.plan.chapter, goal: retryGoal }),
        maxOutputTokens: input.maxOutputTokens,
      }).catch(() => undefined);
      const retryBody = retry ? stripTrailingSegmentMarkers(stripLeadingMarkdownChapterHeading(retry.content)).trim() : "";
      retried = retryBody.length > 0;
      const retryReplays = retryBody ? findReplayedParagraphs(alreadyWritten, retryBody).length : replays.length;
      if (retryBody && retryReplays < replays.length) {
        secondBody = retryBody;
        replayedRemaining = retryReplays;
      }
      input.restream?.(firstVisible + secondBody);
    }
    // 整章还不到下限：说清上次写了多少、这次要多少，再要一次后半章，取更长且重演不更多的那版（只在短了时多花一次调用）。
    const firstLength = countDraftChineseCharacters(firstBody);
    const shortBy = input.lengthTarget.lowerBound - firstLength - countDraftChineseCharacters(secondBody);
    let lengthRetry: SegmentedDraftInfo["lengthRetry"];
    if (shortBy > 0) {
      input.restream?.(firstVisible);
      const before = countDraftChineseCharacters(secondBody);
      const retryGoal = [
        secondGoal,
        `【上一次的后半章只写了 ${before} 个字，整章比最少字数还差 ${shortBy} 字】这次后半章要写够 ${secondTarget} 个中文字符：每个要点的场面写足（动作、对话、人物的反应、环境），不要加章纲以外的新事，不要跳天。`,
      ].join("\n");
      const retry = await input.writerClient.generateDraft({
        context: withSectionContent(secondContext, "chapter_goal", { chapter: input.plan.chapter, goal: retryGoal }),
        maxOutputTokens: input.maxOutputTokens,
      }).catch(() => undefined);
      const retryBody = retry ? stripTrailingSegmentMarkers(stripLeadingMarkdownChapterHeading(retry.content)).trim() : "";
      const retryLength = countDraftChineseCharacters(retryBody);
      const used = retryLength > before && findReplayedParagraphs(alreadyWritten, retryBody).length <= replayedRemaining;
      if (used) secondBody = retryBody;
      input.restream?.(firstVisible + secondBody);
      lengthRetry = { before, after: used ? retryLength : before };
    }
    return {
      generated: {
        ...first,
        content: `${first.content.match(/^#[^\n]*\n/u)?.[0] ?? ""}${firstBody}\n\n${secondBody}`,
      },
      info: { split, replayedFound: replays.length, retried, replayedRemaining, copiedFromPrevious: copied.length, copiedRemaining, ...(lengthRetry ? { lengthRetry } : {}) },
    };
  } catch (error) {
    input.restream?.(firstVisible);
    return {
      generated: first,
      secondHalfError: `后半章没写成（${describeErrorBriefly(error)}），只交了前半章，字数不够的部分由后续续写环节补。`,
    };
  }
}

export interface ContinuationInfo {
  /** 接着写的那段里重演已写部分（或上一章）的段数；检出后重写过没有；最后还剩几段。 */
  readonly replayedFound: number;
  readonly retried: boolean;
  readonly replayedRemaining: number;
  /** 分几次接的（要接的多就分两次，写手一次写不了那么长）；planned 是本来要分几次（后一次没写成就少一次）。 */
  readonly parts: number;
  readonly planned: number;
  /** 接完还不够、又要了一次最后那段：之前和之后那段的字数（没用上就相等）。 */
  readonly lengthRetry?: { readonly before: number; readonly after: number };
}

/** 要接的字数超过这么多就分两次接：写手一次大约写一千来字（长篇连写第 26～29 章、P13 真机接 2200 只写了 1477）。 */
const CONTINUE_CHUNK = 1400;

/**
 * 接着往下写：已写的正文作为 already_written 交给写手，从最后一句往下接；作者这次说的方向（原话）放在前面。
 * 本章有章纲就照带（不新拟——章纲员看不到作者写的半章），让写手接着写还没写到的要点。
 * 要接得多就分两次（前一次不收尾、停在场面中间，后一次收住本章）；每次的接缝重演照分半写的后半章那套查，
 * 检出就带着提示重写一次、取重演少的那版。接完还不到 minLength，说清差多少再要一次最后那段，用更长的那版。
 */
async function generateContinuation(input: {
  readonly writerClient: WriterClient;
  readonly context: WriterContextEnvelope;
  readonly chapter: number;
  readonly existing: string;
  readonly plan?: ChapterPlan;
  readonly direction: string;
  /** 这次瞄着接多少字；minLength = 至少接多少（不到就再要一次最后那段）。 */
  readonly addLength: number;
  readonly minLength: number;
  readonly maxOutputTokens: number;
  readonly restream?: (visible: string) => void;
}): Promise<{ readonly generated: Awaited<ReturnType<WriterClient["generateDraft"]>>; readonly info: ContinuationInfo }> {
  const parts = input.addLength > CONTINUE_CHUNK ? 2 : 1;
  const firstTarget = parts === 2 ? Math.round(input.addLength / 2) : input.addLength;
  const base = withSectionsLast(input.context, PER_HALF_SECTIONS);
  const clean = (content: string): string => stripTrailingSegmentMarkers(stripLeadingMarkdownChapterHeading(content)).trim();
  const previousText = previousChapterText(input.context);
  const goalFor = (target: number, min: number, last: boolean): string => [
    input.direction ? `【作者说接下来写】${input.direction}` : "",
    "【接着往下写】本章已经写了一部分（见 already_written，那是本章的正文，一个字都不要改、不要重写、不要复述）。",
    "紧接它最后一句往下写：人物在哪、手里拿着什么、是什么时候，都从那里接上；写过的事已经发生了，不再写一遍、不换个说法再来一次。",
    input.plan
      ? `本章章纲里 already_written 还没写到的要点，按顺序接着写；${last ? "要点都写到了就顺着往下推，写到合适的地方收住本章。" : "这次写不完的留到下一次。"}`
      : last ? "顺着故事往下推，写到合适的地方收住本章。" : "顺着故事往下推。",
    last
      ? `这次接着写 ${target} 个中文字符左右（不少于 ${min}）。只写接下来的正文，不要标题、不要说明。`
      : `这次只接一段：写 ${target} 个中文字符左右（不少于 ${min}），停在一个场面中间也行，不要收尾、不要总结，后面还会接着写。只写接下来的正文，不要标题、不要说明。`,
  ].filter(Boolean).join("\n");
  const contextFor = (written: string, goal: string): WriterContextEnvelope => withExtraSection(
    withSectionContent(base, "chapter_goal", { chapter: input.chapter, goal }),
    "already_written",
    { instruction: "这是本章已经写好的正文。从它最后一句之后接着写。", text: written },
  );
  // 写一段：重演了已写的（含上一章）就带提示再要一次，取重演少的。稿纸上先退回这段之前（shownBefore = 这次已经接上的），
  // 定了用哪版再显示那版。
  const writeOnce = async (written: string, shownBefore: string, goal: string, required: boolean) => {
    const alreadyWritten = previousText ? `${written}\n${previousText}` : written;
    const context = contextFor(written, goal);
    const first = required
      ? await input.writerClient.generateDraft({ context, maxOutputTokens: input.maxOutputTokens })
      : await input.writerClient.generateDraft({ context, maxOutputTokens: input.maxOutputTokens }).catch(() => undefined);
    let body = first ? clean(first.content) : "";
    if (!body) {
      if (required) throw new Error("接着写的那段是空的");
      return undefined;
    }
    const replays = findReplayedParagraphs(alreadyWritten, body);
    let retried = false;
    let remaining = replays.length;
    if (replays.length > 0) {
      input.restream?.(shownBefore);
      const retryGoal = [
        goal,
        `【上一次接着写的那段把已经写过的场面又写了一遍】例如：「${replays.slice(0, 2).map((text) => text.slice(0, 60)).join("」「")}」。这些都已经发生过了，这次绝对不要重演，从已写部分最后一句之后往前推进新的事。`,
      ].join("\n");
      const retry = await input.writerClient.generateDraft({ context: contextFor(written, retryGoal), maxOutputTokens: input.maxOutputTokens }).catch(() => undefined);
      const retryBody = retry ? clean(retry.content) : "";
      retried = retryBody.length > 0;
      const retryReplays = retryBody ? findReplayedParagraphs(alreadyWritten, retryBody).length : replays.length;
      if (retryBody && retryReplays < replays.length) {
        body = retryBody;
        remaining = retryReplays;
      }
      input.restream?.(shownBefore + body);
    }
    return { generated: first!, body, found: replays.length, retried, remaining };
  };

  const pieces: string[] = [];
  let found = 0;
  let retried = false;
  let remaining = 0;
  let generated: Awaited<ReturnType<WriterClient["generateDraft"]>> | undefined;
  let lastTarget = firstTarget;
  let lastMin = Math.round(parts === 2 ? input.minLength / 2 : input.minLength);
  const shownThrough = (list: readonly string[]): string => list.map((piece) => `${piece}\n\n`).join("");
  for (let part = 0; part < parts; part += 1) {
    const last = part === parts - 1;
    const written = [input.existing, ...pieces].join("\n\n");
    if (part > 0) {
      const done = countDraftChineseCharacters(pieces.join(""));
      lastTarget = Math.max(input.addLength - done, MIN_CONTINUE_LENGTH);
      lastMin = Math.min(Math.max(input.minLength - done, Math.round(MIN_CONTINUE_LENGTH * 0.85)), lastTarget);
      // 稿纸上前一段和这一段之间空一行（两次调用的字是直接接着流的）。
      input.restream?.(shownThrough(pieces));
    }
    // 第二段没写成：交第一段（如实算字数），不让整次接着写白费。
    const piece = await writeOnce(written, shownThrough(pieces), goalFor(lastTarget, lastMin, last), part === 0);
    if (!piece) break;
    generated ??= piece.generated;
    pieces.push(piece.body);
    found += piece.found;
    retried ||= piece.retried;
    remaining += piece.remaining;
  }

  // 接完还不够：说清差多少，再要一次最后那段（重演不更多、更长才用）。
  let lengthRetry: ContinuationInfo["lengthRetry"];
  const added = countDraftChineseCharacters(pieces.join(""));
  if (added < input.minLength && pieces.length === parts) {
    const lastPiece = pieces[pieces.length - 1]!;
    const before = countDraftChineseCharacters(lastPiece);
    const written = [input.existing, ...pieces.slice(0, -1)].join("\n\n");
    const earlier = countDraftChineseCharacters(pieces.slice(0, -1).join(""));
    const target = Math.max(lastTarget, input.addLength - earlier);
    const goal = [
      goalFor(target, input.minLength - earlier, true),
      `【上一次只写了 ${before} 个字，还差 ${input.minLength - added} 字】这次要写够 ${target} 个中文字符：场面写足（动作、对话、人物的反应、环境），不要加和前文对不上的新事，不要跳天。`,
    ].join("\n");
    input.restream?.(shownThrough(pieces.slice(0, -1)));
    const retry = await writeOnce(written, shownThrough(pieces.slice(0, -1)), goal, false).catch(() => undefined);
    const after = retry ? countDraftChineseCharacters(retry.body) : before;
    const replaysBefore = findReplayedParagraphs(previousText ? `${written}\n${previousText}` : written, lastPiece).length;
    const used = retry !== undefined && after > before && retry.remaining <= replaysBefore;
    if (used) pieces[pieces.length - 1] = retry.body;
    input.restream?.(pieces.join("\n\n"));
    lengthRetry = { before, after: used ? after : before };
  }

  // 只回接着写的那段：已写的由调用方原样拼回（清理星号、换引号都不能碰作者的字）。
  return {
    generated: { ...generated!, content: pieces.join("\n\n") },
    info: { replayedFound: found, retried, replayedRemaining: remaining, parts: pieces.length, planned: parts, ...(lengthRetry ? { lengthRetry } : {}) },
  };
}

export async function runFastDraft(input: FastDraftInput): Promise<FastDraftReport> {
  const latencyTimer = startRuntimeLatency();
  // P2 铁律④：设定卡坏了不静默降级——降级仍要（不能让一次坏读盘炸掉出稿），但原因要进 issues。
  const writingRulesFailure: string[] = [];
  const settingRead = await readBibleTolerant(input.projectDir);
  if (settingRead.failure) writingRulesFailure.push(settingRead.failure);
  const draftLengthTarget = resolveDraftLengthTarget({
    chapterGoal: input.chapterGoal,
    requestedDraftLength: input.requestedDraftLength,
    lengthRules: lengthRulesOf(settingRead.bible.rules),
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
      ...(input.selectedCharacters ? { selectedCharacters: input.selectedCharacters } : {}),
      selectedHookIds: input.selectedHookIds,
      maxTimelineEvents: input.maxTimelineEvents,
      ...(input.mustHitBeats && input.mustHitBeats.length > 0 ? { mustHitBeats: input.mustHitBeats } : {}),
      ...(input.chapterPlan ? { chapterPlan: input.chapterPlan } : {}),
      ...(input.lastDraftConflicts && input.lastDraftConflicts.length > 0 ? { lastDraftConflicts: input.lastDraftConflicts } : {}),
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
    const existing = input.continueFrom?.text.trim() ?? "";
    const existingLength = countDraftChineseCharacters(existing);
    // 作者说了这次写多少就照它（不少于八成五）；没说就写到本章字数：瞄区间中间，至少到下限（差得少也写 600）。
    const asked = input.continueFrom?.length;
    const addLength = asked ?? Math.max(draftLengthAim(draftLengthTarget) - existingLength, MIN_CONTINUE_LENGTH);
    const minLength = asked
      ? Math.round(asked * 0.85)
      : Math.min(Math.max(draftLengthTarget.lowerBound - existingLength, Math.round(MIN_CONTINUE_LENGTH * 0.85)), addLength);
    const continued = existing
      ? await generateContinuation({
        writerClient: input.writerClient,
        context,
        chapter: input.chapter,
        existing,
        ...(input.chapterPlan ? { plan: input.chapterPlan } : {}),
        direction: input.continueFrom?.direction?.trim() ?? "",
        addLength,
        minLength,
        maxOutputTokens,
        ...(input.onStreamReset ? { restream: input.onStreamReset } : {}),
      })
      : undefined;
    if (continued && continued.info.replayedFound > 0) {
      writingRulesFailure.push(continued.info.replayedRemaining === 0
        ? `接着写的那段重演了前面 ${continued.info.replayedFound} 段，已重写。`
        : `接着写的那段重演了前面 ${continued.info.replayedFound} 段，${continued.info.retried ? "重写后" : ""}仍有 ${continued.info.replayedRemaining} 段和前面相近。`);
    }
    if (continued && continued.info.parts < continued.info.planned) writingRulesFailure.push("分两次接着写，后一次没写成，只接了前一段（停在场面中间）。");
    if (continued?.info.lengthRetry) {
      const { before, after } = continued.info.lengthRetry;
      writingRulesFailure.push(after > before
        ? `接着写的不够长，最后那段重写了一次（${before} → ${after} 字）。`
        : "接着写的不够长，最后那段重写了一次，没写得更长，用的还是原来那版。");
    }
    const segmented = !continued && input.segmentByPlan && input.chapterPlan && input.chapterPlan.beats.length >= MIN_BEATS_TO_SEGMENT
      && draftLengthTarget.requested >= MIN_TARGET_TO_SEGMENT
      ? await generateBySegments({
        writerClient: input.writerClient,
        context,
        plan: input.chapterPlan,
        rawChapterGoal: input.chapterGoal,
        lengthTarget: draftLengthTarget,
        maxOutputTokens,
        ...(input.onStreamReset ? { restream: input.onStreamReset } : {}),
      })
      : undefined;
    const generated = continued?.generated ?? segmented?.generated ?? await input.writerClient.generateDraft({ context, maxOutputTokens });
    if (segmented?.secondHalfError) writingRulesFailure.push(segmented.secondHalfError);
    if (segmented?.info && segmented.info.copiedFromPrevious >= COPY_RETRY_MIN_PARAGRAPHS) {
      writingRulesFailure.push(segmented.info.copiedRemaining < COPY_RETRY_MIN_PARAGRAPHS
        ? `前半章首稿照抄了上一章 ${segmented.info.copiedFromPrevious} 段，已重写前半章。`
        : `前半章首稿照抄了上一章 ${segmented.info.copiedFromPrevious} 段，重写后仍有 ${segmented.info.copiedRemaining} 段与上一章相近，请留意。`);
    }
    if (segmented?.info?.lengthRetry) {
      const { before, after } = segmented.info.lengthRetry;
      writingRulesFailure.push(after > before
        ? `整章不到最少字数，后半章重写了一次（${before} → ${after} 字）。`
        : `整章不到最少字数，后半章重写了一次，没写得更长，用的还是原来那版。`);
    }
    // 接缝重演留痕（第十四轮审读：检出与重写都没留下记录，事后查不到这一步做了什么）。
    if (segmented?.info && segmented.info.replayedFound > 0) {
      writingRulesFailure.push(segmented.info.replayedRemaining === 0
        ? `后半章首稿重演了前半章 ${segmented.info.replayedFound} 段，已重写后半章。`
        : `后半章首稿重演了前半章 ${segmented.info.replayedFound} 段，${segmented.info.retried ? "重写后" : ""}仍有 ${segmented.info.replayedRemaining} 段与前半章相近。`);
    }
    const generatedTitle = chooseDraftTitle(input.chapter, generated.title, generated.content);
    const cleanedBody = stripTrailingSegmentMarkers(stripMarkdownEmphasis(stripLeadingMarkdownChapterHeading(generated.content)));
    // 英文直引号、半角逗号换成中文的（接着写时跟着作者那段的写法）；回的是 JSON / 工具调用就原样留着，交给下面的关卡认出来拦下。
    const writtenBody = looksLikeToolOrJsonArtifact(cleanedBody.trim())
      ? cleanedBody
      : continued ? chinesePunctuationLike(existing, cleanedBody) : chinesePunctuation(cleanedBody);
    // 接着写：清理只动新写的那段，已写的原样拼在前面。
    const rawDraftBody = continued ? `${existing}\n\n${writtenBody.trim()}` : writtenBody;
    const rawDraftLength = buildDraftLengthReport({
      draftBody: rawDraftBody,
      lengthTarget: draftLengthTarget,
    });
    // 分两半写的稿超了上限不裁：裁只能从结尾往前砍，砍掉的正是章纲最后几个要点
    // （第十七轮第 4 章停在半句对白上，要点 5 后半和要点 6 全丢）。超出多少如实记一条，交作者定。
    // 接着写的稿也不裁：从结尾往前砍砍掉的是刚接上的那段，裁不好还会截在半句上。
    const overLengthKept = Boolean(segmented || continued) && rawDraftLength.lengthStatus === "above_upper_bound";
    if (overLengthKept) {
      writingRulesFailure.push(continued
        ? `正文 ${rawDraftLength.actualLength} 字，超过上限 ${draftLengthTarget.upperBound} 字；接着写的稿不从结尾裁，留给你定。`
        : `正文 ${rawDraftLength.actualLength} 字，超过上限 ${draftLengthTarget.upperBound} 字；分两半写的稿不从结尾裁（会截掉最后的要点），留给你定。`);
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
    // 接着写的稿开头是作者的字，整章查不出新写那段是不是 JSON / 工具调用，单查一次。
    if (continued && looksLikeToolOrJsonArtifact(writtenBody.trim())) issues.push("Draft content looks like JSON or a tool-call artifact.");
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

    // 引擎只出正文、不写盘：落工作稿由调用方走核心的 draft.write（重构 P7 第 3 步）。
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

/** 出稿关卡认的人名：本章上下文里带上的主角和在场人物（设定包里的名字和别名）。 */
function selectedCharacterMentionCandidates(context: WriterContextEnvelope): string[] {
  const packSection = context.sections.find((section) => section.name === "writing_context_pack");
  const pack = packSection?.content as WritingContextPack | undefined;
  const briefs = [...(pack?.setting.protagonist ? [pack.setting.protagonist] : []), ...(pack?.setting.cast ?? [])];
  return unique(briefs.flatMap((brief) => [brief.name, ...(brief.aliases ?? [])]));
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

/** 分段标记最长几个字（括号里头）：「本章未完」「未完待续」「前半章完」都在这以内。 */
const SEGMENT_MARKER_MAX_INNER = 8;
const SEGMENT_MARKER_BRACKETS: readonly (readonly [string, string])[] = [["（", "）"], ["(", ")"]];
/** 括号里只要带这两个字之一就是分段标记（「本章未完」「待续」「全文完」）；带句读的（「（完了。）」）是人物心声，不动。 */
const SEGMENT_MARKER_WORDS = ["完", "续"] as const;
const SENTENCE_MARKS = ["。", "！", "？", "…", "，", "!", "?", ","] as const;

function isSegmentMarker(paragraph: string): boolean {
  const text = paragraph.trim();
  return SEGMENT_MARKER_BRACKETS.some(([open, close]) => {
    if (!text.startsWith(open) || !text.endsWith(close)) return false;
    const inner = text.slice(open.length, -close.length).trim();
    return inner.length > 0
      && inner.length <= SEGMENT_MARKER_MAX_INNER
      && !inner.includes(open) && !inner.includes(close)
      && SEGMENT_MARKER_WORDS.some((word) => inner.includes(word))
      && !SENTENCE_MARKS.some((mark) => inner.includes(mark));
  });
}

/**
 * 去掉正文末尾写手自己加的分段标记段：「（本章未完）」「（未完待续）」「（全文完）」。
 * 分两半写时提示里明写了别加，模型照样加（重构 P6 真机：GLM 前半章收在「（本章未完）」，接上后半章就夹在正文中间）。
 * 只看末尾、只认整段就是一对括号的短标记；正文中间的括号段是作者的事，不动。
 */
export function stripTrailingSegmentMarkers(content: string): string {
  const lines = content.trimEnd().split("\n");
  while (lines.length > 0 && (lines.at(-1)!.trim() === "" || isSegmentMarker(lines.at(-1)!))) lines.pop();
  return lines.join("\n").trimEnd();
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
  if (modelHeadingTitle && !isGenericChapterTitle(modelHeadingTitle, chapter)) {
    return normalizeModelChapterTitle(chapter, modelHeadingTitle);
  }
  if (cleanTitle && !isGenericChapterTitle(cleanTitle, chapter)) return cleanTitle;
  return `第${chapter}章`;
}

/**
 * 模型写的开头标题统一成「第N章 · 标题」（2026-10-14 编辑部 R7.7，报告第 5 节）：
 * 章号一律用代码里的本章章号（阿拉伯数字）——模型会写成「第九章」「第十章」，还会数错章；
 * 分隔符统一「 · 」。把模型自己写的第X章前缀（汉字/阿拉伯数字、带不带分隔符都认）剥掉后按规范重拼，
 * 纯确定性后处理，不改标题文字本身。剥完没有剩余（模型只写了「第九章」这类章号行）→ 只留「第N章」。
 */
function normalizeModelChapterTitle(chapter: number, modelTitle: string): string {
  const bare = modelTitle
    .trim()
    // 不猜白名单：章节标题
    .replace(/^第[一二三四五六七八九十百千万〇零\d]+\s*章[\s·：:、\-—]*/u, "")
    .trim();
  return bare ? `第${chapter}章 · ${bare}` : `第${chapter}章`;
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
  // 不猜白名单：章节标题
  return trimmed === `第${chapter}章` || /^第[一二三四五六七八九十百千万\d]+章$/u.test(trimmed);
}

function isMarkdownChapterHeading(line: string): boolean {
  if (!/^#{1,6}\s+\S/u.test(line)) return false;
  const title = line.replace(/^#{1,6}\s+/u, "").trim();
  if (!title) return false;
  // 不猜白名单开始：章节标题
  if (/^第[一二三四五六七八九十百千万\d]+章(?:\s*[·：:、-]\s*.*)?$/u.test(title)) return true;
  return title.length <= 40 && !/[。！？!?；;]/u.test(title);
  // 不猜白名单结束
}

function isPlainChapterHeading(line: string): boolean {
  // 不猜白名单：章节标题
  return /^第[一二三四五六七八九十百千万\d]+章(?:\s*[·：:、-]\s*[^。！？!?；;]{1,32})?$/u.test(line.trim());
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
