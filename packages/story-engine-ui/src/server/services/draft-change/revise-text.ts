/**
 * 改一段（不读盘、不写盘）：定位要改的原文 → 精确替换或让修订模型改写 → 落点与诚实守卫 → 算出改后全文。
 * draft.change revise（对话改稿、选中文字改写）用它；定位器 locateRevisionSpan 按核账改、去机器腔也用。
 *
 * - 定位：先精确子串，未命中再「空白 + 引号归一」兜底，再试省略号连起的几截（locateRevisionSpan）。
 * - 精确替换：给了确切新文本就原样换上、不调模型；和原文一样诚实拒。
 * - 漂移守卫：模型回的 beforeText 必须落在点名区间，否则拒。
 * - no-op、目标没动：改后 == 改前、点名那段还原样在稿里，都拒，不报成功。
 *
 * 模型走 llm-client（repair 槽，流式 + 空闲超时、不传 max_tokens）。
 */
import {
  buildDraftRevisionPrompt,
  parseDraftRevisionPreview,
  type DraftRevisionPreview,
  type DraftRevisionTask,
} from "../../writing/draft-revision.js";
import { buildStateOverview } from "../../book/state-overview.js";
import { buildWritingContextPack } from "../../writing/writing-context-pack.js";
import { resolveConfiguredChatModel, streamChatModelToText } from "../../lib/llm-client.js";
import { chinesePunctuationLike } from "../../../lib/dialogue-quotes.js";
import { rethrowIfStopped } from "../../lib/operations/context.js";

/* ---------------------------------------------------------------------------
 * 定位：精确子串优先 + 空白/引号归一兜底
 * ------------------------------------------------------------------------- */

export type RevisionTargetSpan = { readonly start: number; readonly end: number };

/**
 * 引号归一表：模型常把对白连引号一起当 target 传，且引号风格与磁盘不一致（磁盘 curly “”，
 * 模型回 ASCII "" 或 CJK 「」）→ 精确/空白归一都失配。把各种成对引号归成一个 canonical 字符
 * （保持长度 1↔1，origIndex 映射不变）。双引号家族→"，单引号家族→'。
 */
const QUOTE_CANON: Readonly<Record<string, string>> = {
  "“": "\"", "”": "\"", "「": "\"", "」": "\"", "『": "\"", "』": "\"",
  "„": "\"", "‟": "\"", "＂": "\"", "«": "\"", "»": "\"",
  "‘": "'", "’": "'", "‚": "'", "‛": "'", "＇": "'",
};
const canonChar = (ch: string): string => QUOTE_CANON[ch] ?? ch;

/** 空白剥离 + 引号归一（「目标句是否仍原样在稿」的比对也用它，保证与定位同口径）。 */
const normalizeForMatch = (text: string): string => text.replace(/\s+/gu, "").split("").map(canonChar).join("");

/**
 * 改写定位：先精确子串匹配（唯一→span / 多次→ambiguous）；精确未命中时用「空白+引号归一」兜底——
 * 把目标里的空白运行（含全/半角空格、换行）当作任意空白、各种成对引号当等价，回原文匹配真实区间。
 * 纯确定性、题材中立。只归一空白与引号（最常见的对白改写失配源），不碰其它标点（易过度匹配）。
 */
export function locateRevisionSpan(
  draftContent: string,
  target: string,
): RevisionTargetSpan | "not_found" | "ambiguous" {
  // 1) 精确子串匹配优先（唯一→span / 多次→ambiguous）。
  const first = draftContent.indexOf(target);
  if (first >= 0) {
    if (draftContent.indexOf(target, first + target.length) >= 0) return "ambiguous";
    return { start: first, end: first + target.length };
  }
  // 2) 空白+引号归一兜底：剥空白、引号归 canonical 后比对，命中再映射回原文真实区间——覆盖模型回吐片段
  //    空白「多了/少了/全半角不一致」+ 引号风格不一致（“”/""/「」）全部情况（精确 indexOf 对这些一律失败）。
  const strippedChars: string[] = [];
  const origIndex: number[] = []; // strippedChars[i] 对应原文位置 origIndex[i]
  for (let i = 0; i < draftContent.length; i += 1) {
    const ch = draftContent[i]!;
    if (!/\s/u.test(ch)) {
      strippedChars.push(canonChar(ch));
      origIndex.push(i);
    }
  }
  const strippedDraft = strippedChars.join("");
  const strippedTarget = normalizeForMatch(target);
  if (strippedTarget.length === 0) return "not_found";
  const sIdx = strippedDraft.indexOf(strippedTarget);
  if (sIdx >= 0) {
    if (strippedDraft.indexOf(strippedTarget, sIdx + strippedTarget.length) >= 0) return "ambiguous";
    return { start: origIndex[sIdx]!, end: origIndex[sIdx + strippedTarget.length - 1]! + 1 };
  }
  // 3) 省略号连起的几截（模型引原句常写「A……B」，核账也会这样引）：依次找到每一截，取第一截开头到最后一截结尾。
  //    第一截在稿里出现多次 → ambiguous（不猜是哪一处）。
  const fragments = target.split("…").map(normalizeForMatch).filter((part) => part.length > 0);
  if (fragments.length < 2) return "not_found";
  const head = strippedDraft.indexOf(fragments[0]!);
  if (head < 0) return "not_found";
  if (strippedDraft.indexOf(fragments[0]!, head + fragments[0]!.length) >= 0) return "ambiguous";
  let end = head + fragments[0]!.length;
  for (const fragment of fragments.slice(1)) {
    const at = strippedDraft.indexOf(fragment, end);
    if (at < 0) return "not_found";
    end = at + fragment.length;
  }
  return { start: origIndex[head]!, end: origIndex[end - 1]! + 1 };
}
/* ---------------------------------------------------------------------------
 * 结果：守卫拒绝是数据（code），给作者看的话由调用方按码组
 * ------------------------------------------------------------------------- */

export type RevisionFailureCode =
  | "target_empty"
  | "goal_empty"
  | "target_not_found"
  | "target_ambiguous"
  | "exact_replacement_noop"
  | "model_output_unusable"
  | "before_text_not_found"
  | "before_text_ambiguous"
  | "drift_rejected"
  | "noop"
  | "target_unchanged";

export interface RevisionFailure {
  readonly ok: false;
  readonly code: RevisionFailureCode;
  /** model_output_unusable 时的底层错误文本。 */
  readonly detail?: string;
  /** 失败时的任务（可能已按归一兜底的真实区间重建 targetText）。 */
  readonly task: DraftRevisionTask;
  /** 模型已产出预览后的失败，带上模型预览。 */
  readonly preview?: DraftRevisionPreview;
}

/* ---------------------------------------------------------------------------
 * 模型调用：统一 llm-client 路
 * ------------------------------------------------------------------------- */

export type RevisionModelCaller = (prompt: string) => Promise<string>;

export interface RevisionModelChannel {
  readonly call: RevisionModelCaller;
  readonly model: string;
  readonly profileId: string;
}

/**
 * 解析 repair 任务模型并给出调用闭包（解析失败在调用点抛错）。
 * 走 streamChatModelToText（2026-10-02 P2）：修订一整章/长段落时推理模型常跑过 60s，旧非流式 60s 固定死表
 * 会把正常修订误杀成「请求超时」；流式 + 空闲超时只在上游彻底静默 90s 才判死、不设总时长上限。一律不传 max_tokens。
 * 非 2xx / 流中 error 帧 / finish_reason=length 由 llm-client 层诚实抛错（「模型请求失败」「模型返回错误」「被截断」）。
 */
const REVISION_MAX_CONTENT_CHARS = 20_000;

export async function createRevisionModelChannel(): Promise<RevisionModelChannel> {
  const configured = await resolveConfiguredChatModel("repair");
  return {
    model: configured.profile.model,
    profileId: configured.profile.id,
    call: async (prompt) => {
      const { content } = await streamChatModelToText({
        configured,
        messages: [{ role: "user", content: prompt }],
        temperature: configured.profile.temperature ?? 0.45,
        responseFormat: { type: "json_object" },
        // 改的是一两句：回的 JSON 远到不了这么长，超了就是原地打转（长篇连写 2026-10-24 探针：一次吐了两百万字才被截断）。
        maxContentChars: REVISION_MAX_CONTENT_CHARS,
      });
      if (!content.trim()) throw new Error("修订模型返回了空内容。");
      return content;
    },
  };
}

/* ---------------------------------------------------------------------------
 * 共享内部件
 * ------------------------------------------------------------------------- */

/** 去 AI 味改写手法（服务端版；与前端 selectionRevisionTemplates 的 deai 模板同源，因 import 边界不跨包共享）。 */
const DEAI_CRAFT_GUIDANCE =
  "改写这段文字，去掉常见的 AI 腔：删掉空泛的形容词堆砌、套路化的排比与升华总结句、"
  + "「仿佛 / 似乎 / 不禁 / 那一刻 / 心中五味杂陈」之类被滥用的过渡与抒情；"
  + "改用具体的动作、可感的细节和有长短变化的句子，让它读起来像人写的、有呼吸和留白。";

interface ResolvedRevisionTarget {
  readonly ok: true;
  readonly task: DraftRevisionTask;
  readonly span: RevisionTargetSpan;
  readonly resolvedTarget: string;
}

/** 定位用户点名片段；归一兜底命中时用盘稿原文重建任务，下游 prompt/守卫/预览全部精确命中。 */
function resolveRevisionTarget(draftContent: string, task: DraftRevisionTask): ResolvedRevisionTarget | RevisionFailure {
  const target = task.targetText.trim();
  if (!target) return { ok: false, code: "target_empty", task };
  const span = locateRevisionSpan(draftContent, target);
  if (span === "not_found") return { ok: false, code: "target_not_found", task };
  if (span === "ambiguous") return { ok: false, code: "target_ambiguous", task };
  const resolvedTarget = draftContent.slice(span.start, span.end);
  const resolvedTask = resolvedTarget === target ? task : { ...task, targetText: resolvedTarget };
  return { ok: true, task: resolvedTask, span, resolvedTarget };
}

/** 精确替换的确定性预览。 */
function exactReplacementPreview(task: DraftRevisionTask, resolvedTarget: string, replacementText: string): DraftRevisionPreview {
  return {
    taskId: task.id,
    beforeText: resolvedTarget,
    afterText: replacementText,
    changeSummary: "按你给的精确文本替换",
    rationale: "用户指定了确切替换文本，确定性原样落地（未经模型改写）。",
    riskNotes: [],
    preservedFacts: [],
    warnings: [],
  };
}

/** 改一段最多调几次修订模型：一次 + 回的格式不对再要一次（写作版本 P2a 4.5 额度从这里算）。 */
export const REVISE_MAX_CALLS = 2;

/** 组 prompt（overview + writingContextPack + 引擎 buildDraftRevisionPrompt）→ 调模型 → 解析预览。 */
async function generateModelPreview(input: {
  readonly projectDir: string;
  readonly chapter: number;
  readonly task: DraftRevisionTask;
  readonly draftContent: string;
  readonly callModel: RevisionModelCaller;
}): Promise<DraftRevisionPreview> {
  const [overview, writingContextPack] = await Promise.all([
    buildStateOverview({ projectDir: input.projectDir, chapter: input.chapter, maxTimelineEvents: 8 }),
    buildWritingContextPack({
      projectDir: input.projectDir,
      chapter: input.chapter,
      userDirection: "",
      currentChapterGoal: input.task.revisionGoal,
      maxTimelineEvents: 3,
    }).catch(() => undefined),
  ]);
  const prompt = buildDraftRevisionPrompt({
    task: input.task,
    draftContent: input.draftContent,
    stateOverview: overview,
    ...(writingContextPack ? { writingContextPack } : {}),
  });
  try {
    return parseDraftRevisionPreview(await input.callModel(prompt), input.task);
  } catch (error) {
    if (!isUnparsable(error)) throw error;
  }
  // 模型偶尔回半截 JSON（长篇连写 2026-10-24：原文以“开头，模型把它写成英文引号、提前收了字符串）：
  // 同一份提示再要一次，还不行才算没改成。模型调用本身出错（断网、跑飞）不重试，照常往上抛。
  try {
    return parseDraftRevisionPreview(await input.callModel(prompt), input.task);
  } catch (error) {
    if (!isUnparsable(error)) throw error;
    // 引擎解析报的是英文（缺 afterText / 不是 JSON），作者看不懂：换成一句人话（P6 真机：「Draft revision preview requires afterText.」漏到对话里）。
    throw new Error("回的格式不对，或没写改后的句子");
  }
}

/** 解析失败（不是 JSON / 缺 afterText）——和模型调用本身出错分开。 */
function isUnparsable(error: unknown): boolean {
  return error instanceof SyntaxError || (error instanceof Error && error.message.startsWith("Draft revision"));
}

/**
 * 模型预览落点检查：beforeText 须在稿中唯一定位（含归一兜底），且与用户点名区间重叠（漂移守卫）。
 * 通过时返回 beforeText 的真实区间。
 */
function checkModelPreviewPlacement(
  draftContent: string,
  targetSpan: RevisionTargetSpan,
  beforeText: string,
): RevisionTargetSpan | "before_text_not_found" | "before_text_ambiguous" | "drift_rejected" {
  const beforeSpan = locateRevisionSpan(draftContent, beforeText);
  if (beforeSpan === "not_found") return "before_text_not_found";
  if (beforeSpan === "ambiguous") return "before_text_ambiguous";
  const overlaps = beforeSpan.start < targetSpan.end && targetSpan.start < beforeSpan.end;
  return overlaps ? beforeSpan : "drift_rejected";
}

/** 确定性替换：按 beforeText 真实区间切片落地（afterText 收尾去空白、去掉接缝处抄重的半句）。 */
function computeRevisionUpdate(draftContent: string, beforeSpan: RevisionTargetSpan, afterText: string): string {
  const head = draftContent.slice(0, beforeSpan.start);
  const tail = draftContent.slice(beforeSpan.end);
  const replaced = draftContent.slice(beforeSpan.start, beforeSpan.end);
  // 模型回的直引号、半角逗号换成中文的，除非这稿本来就整篇这么写（作者自己的写法，跟着它）。
  const text = chinesePunctuationLike(head + tail, afterText.trim());
  return head + trimSeamPunctuation(head, replaced, trimSeamQuotes(head, replaced, trimSeamOverlap(head, replaced, text, tail), tail), tail) + tail;
}

// 不猜白名单：切句
const SEAM_PUNCTUATION = new Set(["。", "！", "？", "!", "?", "，", ",", "；", ";", "、", "：", ":"]);

/**
 * 接缝标点去重（换题材长篇实跑 2026-10-27）：要改的那截不带句号，新文本自己收了句号，落地成「两周后进场。。」。
 * 新文本收尾的标点和原文紧跟着的那个一样、被替换的那段原本没有它，就去掉新文本的；开头同理。纯逐字比对。
 */
function trimSeamPunctuation(head: string, replaced: string, afterText: string, tail: string): string {
  let text = afterText;
  const last = text.slice(-1);
  if (text.length > 1 && SEAM_PUNCTUATION.has(last) && tail.startsWith(last) && !replaced.endsWith(last)) text = text.slice(0, -1);
  const first = text.slice(0, 1);
  if (text.length > 1 && SEAM_PUNCTUATION.has(first) && head.endsWith(first) && !replaced.startsWith(first)) text = text.slice(1);
  return text;
}

// 不猜白名单：切句
const QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [["“", "”"], ["「", "」"], ["『", "』"]];

/**
 * 接缝引号去重（长篇连写 2026-10-24）：局部改写不该改变这段的引号开合。两种落地错：
 * - 要改的那截在引号里面（「她说，“」之后），新文本自己又包了一对 →「她说，““寄存人是谁……走。””」；
 * - 要改的那截是半段话（开了引号没收），新文本把引号收了 → 原文后面还接着说，话说一半多出一个收引号。
 * 被替换的那段原本没有、接缝处已经有了，或多出来的那个改变了这段的开合，就从新文本里去掉。纯逐字比对标点，不看意思。
 */
function trimSeamQuotes(head: string, replaced: string, afterText: string, tail: string): string {
  let text = afterText;
  for (const [open, close] of QUOTE_PAIRS) {
    const balance = (value: string): number => value.split(open).length - value.split(close).length;
    const extraOpen = (): boolean => text.startsWith(open) && !replaced.startsWith(open);
    const extraClose = (): boolean => text.endsWith(close) && !replaced.endsWith(close);
    if (extraOpen() && extraClose() && (head.endsWith(open) || tail.startsWith(close))) {
      text = text.slice(open.length, text.length - close.length);
      continue;
    }
    if (extraOpen() && (head.endsWith(open) || balance(text) > balance(replaced))) text = text.slice(open.length);
    if (extraClose() && (tail.startsWith(close) || balance(text) < balance(replaced))) text = text.slice(0, text.length - close.length);
  }
  return text;
}

/** 接缝重合至少这么多字才算抄重（一两个字撞上是常事）。 */
const SEAM_MIN_CHARS = 3;
/** 接缝最多往外看这么多字。 */
const SEAM_MAX_CHARS = 60;

/**
 * 接缝去重（2026-10-23 按核账改的考卷）：模型改写常把被改那段紧挨着的下半句也抄进新文本——目标止于「扣子之间」，
 * 新文本末尾带上了原文紧跟着的「，边角发潮」，落地成「边角发潮，边角发潮」。新文本的尾巴和原文紧跟其后的开头逐字重合、
 * 而被替换的那段原本没有这条尾巴，就把重合的部分从新文本里去掉；开头同理。纯逐字比对，不看意思。
 */
function trimSeamOverlap(head: string, replaced: string, afterText: string, tail: string): string {
  let text = afterText;
  for (let size = Math.min(text.length - 1, tail.length, SEAM_MAX_CHARS); size >= SEAM_MIN_CHARS; size -= 1) {
    const piece = tail.slice(0, size);
    if (text.endsWith(piece) && !replaced.endsWith(piece)) {
      text = text.slice(0, text.length - size);
      break;
    }
  }
  for (let size = Math.min(text.length - 1, head.length, SEAM_MAX_CHARS); size >= SEAM_MIN_CHARS; size -= 1) {
    const piece = head.slice(head.length - size);
    if (text.startsWith(piece) && !replaced.startsWith(piece)) {
      text = text.slice(size);
      break;
    }
  }
  return text;
}

/* ---------------------------------------------------------------------------
 * 改一段
 * ------------------------------------------------------------------------- */

export type RevisedText =
  | { readonly ok: true; readonly mode: "exact" | "model"; readonly task: DraftRevisionTask; readonly preview: DraftRevisionPreview; readonly updatedContent: string }
  | RevisionFailure;

export interface ReviseTextInput {
  readonly projectDir: string;
  readonly chapter: number;
  /** 要改的那份全文（工作稿文件原文，带章名行）。 */
  readonly draftContent: string;
  readonly targetText: string;
  readonly revisionGoal: string;
  readonly style?: "deai";
  readonly problemSummary?: string;
  readonly constraints?: readonly string[];
  /** 作者给的确切新文本：给了就原样换上、跳过模型改写。 */
  readonly replacementText?: string;
  readonly callModel: RevisionModelCaller;
}

/** 改一段（不读盘、不写盘）：定位 → 精确替换或模型改写 → 落点与诚实守卫 → 算出改后全文。 */
export async function reviseDraftText(input: ReviseTextInput): Promise<RevisedText> {
  const { projectDir, chapter, draftContent } = input;

  // style=deai 时把去 AI 味手法注入修订目标，不退化成普通润色。
  const revisionGoal = input.style === "deai"
    ? `${DEAI_CRAFT_GUIDANCE}${input.revisionGoal.trim() ? `\n另外按这条具体要求改：${input.revisionGoal.trim()}` : ""}`
    : input.revisionGoal;

  const task: DraftRevisionTask = {
    id: `revision-${Date.now().toString(36)}`,
    chapter,
    targetType: "paragraph",
    targetText: input.targetText,
    problemSummary: input.problemSummary?.trim() || "局部修订",
    revisionGoal,
    constraints: input.constraints ?? [],
    status: "pending",
  };

  const located = resolveRevisionTarget(draftContent, task);
  if (located.ok === false) return located;
  const { task: resolvedTask, span, resolvedTarget } = located;

  // 精确替换：按目标 span 原样落地、跳过模型改写，保证「换成你说的那句」。
  const exactReplacement = input.replacementText?.trim();
  if (exactReplacement) {
    if (exactReplacement === resolvedTarget.trim()) {
      return { ok: false, code: "exact_replacement_noop", task: resolvedTask };
    }
    const preview = exactReplacementPreview(resolvedTask, resolvedTarget, exactReplacement);
    // 原样落地，只去掉接缝上抄重的那个标点（「进场。」接在「。」前面不该成「。。」）。
    const head = draftContent.slice(0, span.start);
    const tail = draftContent.slice(span.end);
    const updatedContent = head + trimSeamPunctuation(head, resolvedTarget, exactReplacement, tail) + tail;
    return { ok: true, mode: "exact", task: resolvedTask, preview, updatedContent };
  }
  // 要模型改写却没说往哪改：不让模型瞎改，如实退回（精确替换和去 AI 味不需要它）。
  if (input.style !== "deai" && !input.revisionGoal.trim()) {
    return { ok: false, code: "goal_empty", task: resolvedTask };
  }

  let preview: DraftRevisionPreview;
  try {
    preview = await generateModelPreview({ projectDir, chapter, task: resolvedTask, draftContent, callModel: input.callModel });
  } catch (error) {
    // 停掉、暂停、等作者不是「没改成」：照样往上抛。
    rethrowIfStopped(error);
    return {
      ok: false,
      code: "model_output_unusable",
      task: resolvedTask,
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  // beforeText 可定位 + 漂移守卫：模型去动了别处 → 诚实拒、不落盘。
  const placement = checkModelPreviewPlacement(draftContent, span, preview.beforeText);
  if (placement === "before_text_not_found" || placement === "before_text_ambiguous" || placement === "drift_rejected") {
    return { ok: false, code: placement, task: resolvedTask, preview };
  }
  const updatedContent = computeRevisionUpdate(draftContent, placement, preview.afterText);

  // no-op 守卫（铁律④：改了等于没改不许报成功）。
  if (updatedContent === draftContent) {
    return { ok: false, code: "noop", task: resolvedTask, preview };
  }
  // 目标级诚实守卫：成功必须 =「用户点名的那段真被改动」。改后它若仍原样存在（空白+引号归一比对）
  // = 目标没真被动 → 诚实拒、不落盘。
  if (normalizeForMatch(updatedContent).includes(normalizeForMatch(resolvedTarget))) {
    return { ok: false, code: "target_unchanged", task: resolvedTask, preview };
  }

  return { ok: true, mode: "model", task: resolvedTask, preview, updatedContent };
}
