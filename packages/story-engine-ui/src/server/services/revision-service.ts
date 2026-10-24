/**
 * revision-service — /api/draft/revision/*（两步）与 agent/tools/revise-draft.ts（一步）的共享编排。
 *
 * 双轨合一前，两条轨道在进程内复刻同一套「定位 → 预览 → 守卫 → 落盘」，漂移清单（D21–D25）
 * 见 routes/revise-draft.parity.test.ts。收编后本服务落定统一语义：
 *
 *   D21 定位宽容度【已收敛】：先精确子串匹配，未命中再「空白+引号归一」兜底（locateRevisionSpan）。
 *       原是工具路独有；HTTP 路纯 indexOf 直接 400——收编后 HTTP 路获得兜底（刻意修复）。
 *   D22 漂移守卫【已收敛·刻意修复】：模型回吐的 beforeText 必须落在用户点名区间，否则诚实拒。
 *       原是工具路独有；HTTP 路模型说改哪就改哪还报 ok:true——收编后 HTTP preview 步拒漂移预览（400）。
 *   D23 精确替换快路【已收敛】：replacementText 给了就跳过模型、确定性原样落地。原是工具路独有；
 *       HTTP preview 步从 task.replacementText 获得同一能力。
 *   D24 流程形态【仍是显式分歧】：HTTP 两步（previewRevision → applyRevision，apply 需 confirm:true，
 *       由路由自持）；工具一步（reviseDraftOneShot 内部 preview+apply 合一）。preview 产物即 apply 入参。
 *   D25 no-op 诚实【已收敛·刻意修复】：改后==改前拒绝报成功。原是工具路独有；HTTP apply 曾把原样
 *       内容再写一遍还报 applied:true——收编后 HTTP apply 步拒 no-op（400）。
 *   目标级诚实守卫【已收敛·2026-09-11 补，同日改 targetText 回传通道】：成功必须 = 用户点名句真被
 *       改动——改后目标句仍原样存在（空白+引号归一比对）= 没真改到 → 诚实拒、不落盘。原是工具路
 *       独有且未登记进漂移清单：HTTP 两步路对「大区间 beforeText 覆盖目标句、afterText 保留目标句
 *       原样」的预览曾报 applied:true。回传通道：apply 接受可选 targetText（用户原始点名片段，
 *       客户端 task 里存着），applyRevision 在 apply 时的当前草稿上用 locateRevisionSpan 自己重新
 *       解析目标区间——resolvedTarget 来自服务端解析而非客户端字符串（裸回传可伪造：
 *       resolvedTarget:"的" → 恒拒一切修订），解析不到（草稿在预览后已大变）→ 诚实拒并说明。
 *       整体替换豁免（与 reviseDraftOneShot 的 exact 分支一致）：beforeText 在当前草稿的落点恰为
 *       目标区间本身（beforeSpan == targetSpan）= 目标被整段替换，新文本恰好含旧文不算「没动」；
 *       豁免判据由服务端从真实区间算出，客户端无可乘之字段。
 *
 * 模型调用统一走 llm-client（resolveConfiguredChatModel("repair") + callOpenAICompatibleChatModel）：
 * HTTP 预览路原来的裸 fetch 收编进统一路，自动获得超时/思考方言/opencode 会话头等全部既有横切能力
 * （刻意收敛）。错误文案沿用工具路原文（「修订模型请求失败：…」），HTTP 路兜底预览 riskNotes 里的
 * 诊断文案随之从「模型请求失败：…」变为「修订模型请求失败：…」（仅此一处文案差）。
 *
 * 显式策略参数（两侧刻意保留的分歧，不再是暗漂移）：
 *   policies.modelErrorFallback   — HTTP preview：模型调用失败回 200 + 安全兜底预览（前端 A.5 契约，
 *                                   前端据 afterText===beforeText 诚实报失败）；工具路：模型失败诚实拒。
 */
import { readFile } from "node:fs/promises";
import {
  buildDraftRevisionPrompt,
  fallbackDraftRevisionPreview,
  parseDraftRevisionPreview,
  type DraftRevisionPreview,
  type DraftRevisionTask,
} from "../writing/draft-revision.js";
import { buildStateOverview } from "../book/state-overview.js";
import { buildWritingContextPack } from "../writing/writing-context-pack.js";

import { resolveConfiguredChatModel, streamChatModelToText } from "../lib/llm-client.js";
import { withBookLock } from "@actalk/story-core";
import { writeAiDraft } from "../lib/ai-draft-write.js";
import { defaultDraftPath } from "../lib/project-io.js";
import { runWithSnapshot } from "../lib/snapshot.js";
import { curlyStraightQuotes } from "../../lib/dialogue-quotes.js";

/* ---------------------------------------------------------------------------
 * D21 定位：精确子串优先 + 空白/引号归一兜底
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
 * 结果类型：守卫拒绝是数据（code），用户可见文案由两侧适配层各按其历史口径组装
 * ------------------------------------------------------------------------- */

export type RevisionFailureCode =
  | "target_empty"
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
  /** model_output_unusable 时的底层错误文本（适配层拼进各自文案）。 */
  readonly detail?: string;
  /** 失败时的任务（可能已按归一兜底的真实区间重建 targetText）。 */
  readonly task?: DraftRevisionTask;
  /** 模型已产出预览后的失败，带上模型预览（工具路原样回填 output.preview）。 */
  readonly preview?: DraftRevisionPreview;
}

export interface RevisionPreviewSuccess {
  readonly ok: true;
  /** exact=精确替换快路（未调模型）；model=模型/兜底/确定性预览。 */
  readonly mode: "exact" | "model";
  readonly task: DraftRevisionTask;
  readonly preview: DraftRevisionPreview;
}

export interface RevisionApplySuccess {
  readonly ok: true;
  readonly applied: true;
  readonly preview: DraftRevisionPreview;
  readonly draftPath: string;
  /** 替换后的全文（未做落盘归一；落盘文本统一 `${updatedContent.trimEnd()}\n`）。 */
  readonly updatedContent: string;
  /** 这次写回的版本号（见 nextDraftVersion）。 */
  readonly draftVersion?: number;
}

export interface RevisionOneShotSuccess extends RevisionApplySuccess {
  readonly mode: "exact" | "model";
  readonly task: DraftRevisionTask;
}

/** 工具一步路的失败必带 task（适配层据它组兜底预览）；两步 apply 的失败没有任务上下文。 */
export interface RevisionOneShotFailure extends RevisionFailure {
  readonly task: DraftRevisionTask;
}

/* ---------------------------------------------------------------------------
 * 模型调用：统一 llm-client 路（原 HTTP 裸 fetch 收编于此）
 * ------------------------------------------------------------------------- */

export type RevisionModelCaller = (prompt: string) => Promise<string>;

export interface RevisionModelChannel {
  readonly call: RevisionModelCaller;
  readonly model: string;
  readonly profileId: string;
}

/**
 * 解析 repair 任务模型并给出调用闭包（解析失败在调用点抛错，时序与两轨原实现各自一致）。
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

/** 定位用户点名片段（D21）；归一兜底命中时用盘稿原文重建任务，下游 prompt/守卫/预览全部精确命中。 */
function resolveRevisionTarget(draftContent: string, task: DraftRevisionTask): ResolvedRevisionTarget | RevisionOneShotFailure {
  const target = task.targetText.trim();
  if (!target) return { ok: false, code: "target_empty", task };
  const span = locateRevisionSpan(draftContent, target);
  if (span === "not_found") return { ok: false, code: "target_not_found", task };
  if (span === "ambiguous") return { ok: false, code: "target_ambiguous", task };
  const resolvedTarget = draftContent.slice(span.start, span.end);
  const resolvedTask = resolvedTarget === target ? task : { ...task, targetText: resolvedTarget };
  return { ok: true, task: resolvedTask, span, resolvedTarget };
}

/** D23 精确替换快路的确定性预览（两轨共用同一份文案）。 */
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
 * 模型预览落点检查：beforeText 须在稿中唯一定位（含归一兜底），且与用户点名区间重叠（D22 漂移守卫）。
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
  // 模型回的直引号换成中文引号，除非这稿本来就整篇用直引号（作者自己的写法，跟着它）。
  const rest = head + tail;
  const text = rest.includes("\"") && !rest.includes("“") ? afterText.trim() : curlyStraightQuotes(afterText.trim());
  return head + trimSeamQuotes(head, replaced, trimSeamOverlap(head, replaced, text, tail), tail) + tail;
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

/**
 * 工作稿写回的版本号：同一进程里严格递增（2026-10-10 真机验收：模型把两处修改并行发出，两个结果几乎同时到前端，
 * 前端按到达顺序套用，后到的那份是更早写的正文，编辑器显示少了一处）。前端只认版本更新的那份。
 */
let lastDraftVersion = 0;
export function nextDraftVersion(): number {
  lastDraftVersion = Math.max(Date.now() * 1000, lastDraftVersion + 1);
  return lastDraftVersion;
}

/** 改稿写回走 draft.write（重构 P7：AI 写工作稿只有这一条路）。 */
async function persistRevisionUpdate(projectDir: string, chapter: number, updatedContent: string): Promise<number> {
  await writeAiDraft(projectDir, { chapter, body: updatedContent });
  return nextDraftVersion();
}

/* ---------------------------------------------------------------------------
 * 两步形态（HTTP）：previewRevision → applyRevision（preview 产物即 apply 入参）
 * ------------------------------------------------------------------------- */

export async function previewRevision(input: {
  readonly projectDir: string;
  readonly chapter: number;
  readonly task: DraftRevisionTask;
  /** HTTP 路允许 body.draftContent 覆盖（工作区即时稿）；缺省读盘。 */
  readonly draftContent?: string;
  /** D23：用户指定的精确替换文本——给了就跳过模型、出确定性预览。 */
  readonly replacementText?: string;
  readonly callModel: RevisionModelCaller;
  readonly policies?: {
    readonly modelErrorFallback?: boolean;
  };
}): Promise<RevisionPreviewSuccess | RevisionFailure> {
  const { projectDir, chapter } = input;
  const draftContent = input.draftContent ?? await readFile(defaultDraftPath(projectDir, chapter), "utf-8");
  const located = resolveRevisionTarget(draftContent, input.task);
  if (located.ok === false) return located;
  const { task, resolvedTarget } = located;

  // D23 精确替换快路：给了确切新文本 → 确定性预览、不调模型；与原文一致则诚实拒（no-op）。
  const exactReplacement = input.replacementText?.trim();
  if (exactReplacement) {
    if (exactReplacement === resolvedTarget.trim()) {
      return { ok: false, code: "exact_replacement_noop", task };
    }
    return { ok: true, mode: "exact", task, preview: exactReplacementPreview(task, resolvedTarget, exactReplacement) };
  }

  let preview: DraftRevisionPreview;
  if (input.policies?.modelErrorFallback) {
    // A.5 安全兜底（HTTP preview 契约）：模型调用失败回安全兜底预览，由前端据 no-op 诚实报失败。
    preview = await generateModelPreview({ projectDir, chapter, task, draftContent, callModel: input.callModel })
      .catch((error) => fallbackDraftRevisionPreview(task, error instanceof Error ? error.message : String(error)));
  } else {
    try {
      preview = await generateModelPreview({ projectDir, chapter, task, draftContent, callModel: input.callModel });
    } catch (error) {
      return {
        ok: false,
        code: "model_output_unusable",
        task,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }
  // D22 漂移守卫（preview 步拦下：模型说改哪之前先核验落点）。兜底/确定性预览的 beforeText 即
  // 任务原文，必然通过；只有模型真回吐了别处才拒。
  const placement = checkModelPreviewPlacement(draftContent, located.span, preview.beforeText);
  if (typeof placement === "string") {
    return { ok: false, code: placement, task, preview };
  }
  return { ok: true, mode: "model", task, preview };
}

export async function applyRevision(input: {
  readonly projectDir: string;
  readonly chapter: number;
  readonly preview: DraftRevisionPreview;
  /** 可选：用户原始点名片段（task.targetText 回传）——带了就在 apply 时的当前草稿上重新解析目标区间、
   *  落盘前做与工具路同口径的 target_unchanged 守卫；没带（旧客户端）保持原行为，守卫是纯增量。 */
  readonly targetText?: string;
}): Promise<RevisionApplySuccess | RevisionFailure> {
  const { projectDir, chapter } = input;
  const draftPath = defaultDraftPath(projectDir, chapter);
  // #9：读稿→算稿→写盘整段在书锁里（与 reviseDraftOneShot、存档、定稿同一把，可重入）——两笔并发 apply
  // 不会交错出「各自基于旧稿、最后写者赢」。原来按草稿文件另加一把互斥，和书锁嵌套顺序相反时会互相等死。
  return withBookLock(projectDir, () => applyRevisionLocked(input, draftPath));
}

async function applyRevisionLocked(
  input: Parameters<typeof applyRevision>[0],
  draftPath: string,
): Promise<RevisionApplySuccess | RevisionFailure> {
  const { projectDir, chapter, preview } = input;
  const draftContent = await readFile(draftPath, "utf-8");
  const beforeSpan = locateRevisionSpan(draftContent, preview.beforeText);
  if (beforeSpan === "not_found") return { ok: false, code: "before_text_not_found" };
  if (beforeSpan === "ambiguous") return { ok: false, code: "before_text_ambiguous" };
  const updatedContent = computeRevisionUpdate(draftContent, beforeSpan, preview.afterText);
  // D25 no-op 诚实：改后==改前 → 拒、不落盘，绝不谎报 applied:true。
  if (updatedContent === draftContent) return { ok: false, code: "noop" };
  // 目标级诚实守卫（与 reviseDraftOneShot 同口径）：回传了用户点名片段，就在 apply 时的当前草稿上
  // 用 locateRevisionSpan（D21 归一兜底同套）自己重新解析目标区间——resolvedTarget 来自服务端解析
  // 而非客户端字符串，伪造面消除（顶多传个不存在的目标，落得诚实拒）。解析不到 = 草稿在预览后
  // 已大变、预览语义失效 → 诚实拒并说明，不落盘。
  if (input.targetText) {
    const targetSpan = locateRevisionSpan(draftContent, input.targetText);
    if (targetSpan === "not_found") return { ok: false, code: "target_not_found" };
    if (targetSpan === "ambiguous") return { ok: false, code: "target_ambiguous" };
    const resolvedTarget = draftContent.slice(targetSpan.start, targetSpan.end);
    // 整体替换豁免（同 reviseDraftOneShot 的 exact 分支语义）：beforeText 在当前草稿的落点恰为目标
    // 区间本身 = 目标被整段替换，改后新文本恰好含旧文不算「没动」。判据由服务端从真实区间算出。
    const wholesaleReplacement = beforeSpan.start === targetSpan.start && beforeSpan.end === targetSpan.end;
    if (!wholesaleReplacement && normalizeForMatch(updatedContent).includes(normalizeForMatch(resolvedTarget))) {
      return { ok: false, code: "target_unchanged", preview };
    }
  }
  // 审计 High-2：快照与落盘同一临界区（此前 HTTP 路的 createSnapshot 在锁内一瞬、紧接的覆盖写在
  // 锁外，commit_apply 在锁内读同一工作稿并定稿——交错可丢修订或把半截稿定稿）。修订应用前快照的
  // 时序语义不变：守卫全过之后才进 runWithSnapshot（拒绝路径不建快照）。
  await runWithSnapshot(projectDir, "修订应用前快照", async () => {
    await persistRevisionUpdate(projectDir, chapter, updatedContent);
  });
  return { ok: true, applied: true, preview, draftPath, updatedContent };
}

/* ---------------------------------------------------------------------------
 * 一步形态（Mastra 工具）：preview+apply 合一，一次调用落盘
 * ------------------------------------------------------------------------- */

export async function reviseDraftOneShot(input: {
  readonly projectDir: string;
  readonly chapter: number;
  readonly targetText: string;
  readonly revisionGoal: string;
  readonly style?: "deai";
  readonly problemSummary?: string;
  readonly constraints?: readonly string[];
  /** D23 精确替换快路：用户给的确切新文本——给了就原样落地、跳过模型改写。 */
  readonly replacementText?: string;
  readonly callModel: RevisionModelCaller;
}): Promise<RevisionOneShotSuccess | RevisionOneShotFailure> {
  const draftPath = defaultDraftPath(input.projectDir, input.chapter);
  // #9（长跑 2026-10-04 真机实证）：Mastra 对同一轮模型回出的多个 tool call 是
  // Promise.all 并行执行（@mastra/core 1.42.0 executeTools）。「读稿 → 调修订模型 → 写盘」
  // 这段读-改-写此前无任何互斥：同轮 N 笔 revise_draft 并发跑时各自读到同一份「本轮开头的
  // 工作稿」、各自写回「开头稿+自己的修订」，最后写者赢——前面的修订被静默覆盖（真机第 2 章
  // 两笔丢一笔、第 14 章四笔并发只活最后一笔，AI 会话原话「并发改写只保留了最后一处」）。
  // 修法：整段进书锁——第二笔排队等第一笔写完才读盘，每笔修订天然基于磁盘最新工作稿（含上一笔的结果）。
  // 重构 P7 起用书锁（可重入，revise_draft 工具外层本就拿着它）：读概览不拿锁，修订模型跑几十秒只让写操作排队。
  return withBookLock(input.projectDir, () => reviseDraftOneShotLocked(input, draftPath));
}

async function reviseDraftOneShotLocked(
  input: Parameters<typeof reviseDraftOneShot>[0],
  draftPath: string,
): Promise<RevisionOneShotSuccess | RevisionOneShotFailure> {
  const draftContent = await readFile(draftPath, "utf-8");
  const revised = await reviseDraftText({ ...input, draftContent });
  if (!revised.ok) return revised;
  const draftVersion = await persistRevisionUpdate(input.projectDir, input.chapter, revised.updatedContent);
  return { ...revised, applied: true, draftPath, draftVersion };
}

export type RevisedText =
  | { readonly ok: true; readonly mode: "exact" | "model"; readonly task: DraftRevisionTask; readonly preview: DraftRevisionPreview; readonly updatedContent: string }
  | RevisionOneShotFailure;

/**
 * 改一段的核心（不读盘、不写盘）：定位 → 精确替换或模型改写 → 落点与诚实守卫 → 算出改后全文。
 * 改稿工具（reviseDraftOneShot，读盘写盘）和出稿流程里的「按核账改」（正文还在内存里）共用这一条。
 */
export async function reviseDraftText(input: Omit<Parameters<typeof reviseDraftOneShot>[0], "projectDir" | "chapter"> & {
  readonly projectDir: string;
  readonly chapter: number;
  readonly draftContent: string;
}): Promise<RevisedText> {
  const { projectDir, chapter, draftContent } = input;

  // style=deai 时把去 AI 味手法注入修订目标——让 agent 看完 check_ai_flavor 后能直接经本工具去 AI 味，
  // 不再退化成普通润色。
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

  // D23 精确替换快路：按目标 span 原样落地、跳过模型改写，保证「换成你说的那句」。
  const exactReplacement = input.replacementText?.trim();
  if (exactReplacement) {
    if (exactReplacement === resolvedTarget.trim()) {
      return { ok: false, code: "exact_replacement_noop", task: resolvedTask };
    }
    const preview = exactReplacementPreview(resolvedTask, resolvedTarget, exactReplacement);
    const updatedContent = draftContent.slice(0, span.start) + exactReplacement + draftContent.slice(span.end);
    return { ok: true, mode: "exact", task: resolvedTask, preview, updatedContent };
  }

  let preview: DraftRevisionPreview;
  try {
    preview = await generateModelPreview({ projectDir, chapter, task: resolvedTask, draftContent, callModel: input.callModel });
  } catch (error) {
    return {
      ok: false,
      code: "model_output_unusable",
      task: resolvedTask,
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  // beforeText 可定位 + D22 漂移守卫：模型去动了别处 → 诚实拒、不落盘。
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
