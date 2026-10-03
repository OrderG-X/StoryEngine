/**
 * chapter-delta-declaration —— 让写手模型「声明本章语义」的一次确定性 JSON 调用（UI server 层，守 import 边界）。
 *
 * 背景：引擎退出「从正文正则猜结构化」，改由模型主动声明本章 mainEvent / 埋的伏笔 / 回收的伏笔 / 资源变化 / 关键线索，
 * 每条附正文原句证据；引擎只做确定性证据校验（见 @actalk/story-engine 的 verifyChapterDelta）。本模块负责生成声明。
 *
 * 铁律：题材中立 prompt、强制关思考、responseFormat=json_object；坏 JSON / 超时 / 任何异常 → status=fallback + 原因
 * （本章降级到引擎确定性规则，但状态一路带到用户可见 summary，绝不静默；旧签名 declareChapterDelta 仍返回 undefined 兼容）。
 * callModel 注入便于单测（不真连网络）。绝不臆造：模型只允许引用正文真实出现的句子，引擎会逐字复核、对不上就丢弃。
 * 解析是【逐条打捞】不是整体判死：单条列表项不合 schema 只丢那一条，其余照收——对齐 lenient-args 的「永远不信模型会传干净输入」。
 * 降级绝不静默：每次失败/丢条都 console.warn 落 server 日志（用户路径仍平滑降级，但长跑诊断有迹可循）。
 */
import { z } from "zod";
import type { ChapterDeltaDeclaration } from "@actalk/story-engine";
import { resolveConfiguredChatModel, streamChatModelToText } from "../../lib/llm-client.js";
import type { ChapterDeltaDeclarationOutcome } from "../../services/commit-service.js";

export type DeclareCallModel = (
  messages: readonly { readonly role: "system" | "user"; readonly content: string }[],
) => Promise<string>;

const evidenceItem = z.object({
  summary: z.string().trim().min(1),
  quote: z.string().trim().min(1),
});

const foreshadowingItem = z.object({
  summary: z.string().trim().min(1),
  quote: z.string().trim().min(1),
  targetThreadHint: z.string().trim().min(1).optional(),
});

const resourceItem = z.object({
  item: z.string().trim().min(1),
  change: z.enum(["gain", "loss", "spend"]),
  amount: z.string().trim().min(1).optional(),
  quote: z.string().trim().min(1),
});

const characterItem = z.object({
  name: z.string().trim().min(1),
  identityHint: z.string().trim().min(1).optional(),
  quote: z.string().trim().min(1),
});

const arcGoalItem = z.object({
  summary: z.string().trim().min(1),
  progress: z.enum(["introduced", "advanced", "completed"]),
  scope: z.enum(["main_arc", "mini_arc"]).optional(),
  targetGoalHint: z.string().trim().min(1).optional(),
  quote: z.string().trim().min(1),
});

const pendingIntentItem = evidenceItem;

const continuityWithPreviousItem = z.object({
  connects: z.boolean(),
  note: z.string().trim().min(1).optional(),
});

/** 声明里被丢弃的坏条目回调（生产路径接 console.warn，单测可注入 spy；不传=静默丢）。 */
export type DeclarationDropListener = (field: string, detail: string) => void;

/**
 * 逐条打捞的列表解析：数组里单条不合 schema 只丢那一条（记 onDrop），其余照收。
 * 非数组（模型退化输入：字符串/对象/null）→ 整个字段按空数组处理并记 onDrop。
 * 背景（2026-07-04 20 章真机）：旧行为是任何一条枚举写错 → 整份声明 undefined → 连干净的 mainEvent 一起陪葬。
 */
function salvageList<T>(
  raw: unknown,
  itemSchema: z.ZodType<T>,
  field: string,
  onDrop?: DeclarationDropListener,
): T[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    onDrop?.(field, `非数组（${typeof raw}），整字段按空处理`);
    return [];
  }
  const kept: T[] = [];
  raw.forEach((entry, index) => {
    const result = itemSchema.safeParse(entry);
    if (result.success) kept.push(result.data);
    else onDrop?.(`${field}[${index}]`, result.error.issues.map((issue) => issue.message).join("; "));
  });
  return kept;
}

/** 可选标量（mainEvent/conflict/discovery/decision）的打捞：不合 schema → undefined + 记 onDrop，绝不牵连整份声明。 */
function salvageScalar(
  raw: unknown,
  field: string,
  onDrop?: DeclarationDropListener,
): z.infer<typeof evidenceItem> | undefined {
  if (raw === undefined || raw === null) return undefined;
  const result = evidenceItem.safeParse(raw);
  if (result.success) return result.data;
  onDrop?.(field, result.error.issues.map((issue) => issue.message).join("; "));
  return undefined;
}

/** 跨章衔接是主观判断，不带 quote；坏结构只丢该字段，不牵连整份声明。 */
function salvageContinuityWithPrevious(
  raw: unknown,
  field: string,
  onDrop?: DeclarationDropListener,
): z.infer<typeof continuityWithPreviousItem> | undefined {
  if (raw === undefined || raw === null) return undefined;
  const result = continuityWithPreviousItem.safeParse(raw);
  if (result.success) return result.data;
  onDrop?.(field, result.error.issues.map((issue) => issue.message).join("; "));
  return undefined;
}

export function buildChapterDeltaMessages(input: {
  readonly chapter: number;
  readonly draft: string;
  readonly openThreadTitles?: readonly string[];
  readonly establishedNames?: readonly string[];
  readonly openGoalTitles?: readonly string[];
  readonly previousChapterEnding?: string;
}): { readonly role: "system" | "user"; readonly content: string }[] {
  const system = [
    "你是中文小说的『章节语义记录员』。只读这一章正文，声明本章发生的结构化语义，供后续状态追踪使用。",
    "题材中立：不要假设任何题材套路。只声明正文【真实写到】的，禁臆造、禁补剧情、禁预设走向；本章没有的类别就给空数组。",
    "每一条都必须附 quote：一句【逐字摘自正文的原句】作为证据（可含标点，但不能改写、不能拼接、不能自己造句）。程序会逐字复核，对不上的条目会被丢弃。",
    "字段说明：",
    "· mainEvent：本章最核心的一件事。mainEvent 选【本章推动故事的最大一件事】——交易达成、关键会面、重大发现、冲突爆发、得到/失去关键东西。看见某人/某物（望风、暗哨、路人经过）、赶路、进门、环境与气氛铺垫都不是 mainEvent，除非本章确实只发生了这一件事。summary 一句话概括，quote 引用最能代表该事件的正文原句。",
    "· conflict：本章的核心冲突/对立（可选，没有就不给）。summary=冲突是什么，quote=体现冲突的正文原句。",
    "· discovery：本章主角查明/发现/得知的关键信息（可选，没有就不给）。summary=发现了什么，quote=写到该发现的正文原句。",
    "· decision：本章主角做出的关键决定/选择（可选，没有就不给）。summary=决定做什么，quote=写到该决定的正文原句。",
    "· seededForeshadowing[]：本章【新埋下】、预期后文回收的跨章悬念（之前没出现过）。summary=这条伏笔是什么，quote=埋设它的原句。本章内已经解决的紧张/障碍不算伏笔，不要报。",
    "· resolvedForeshadowing[]：本章【回收/揭晓】的、【之前已埋下】的伏笔或线索。summary=揭晓了什么，quote=揭晓的原句；若能对应到下方【已存在的未决伏笔/线索】里的某一条，把它的标题填进 targetThreadHint（务必对应已有条目，不要新造）。只要本章把某条旧伏笔/线索交代清楚了，就一定要在这里报一条，别让它一直挂着没收口。之前挂着的计划/待办（尤其是『决定/需要/打算』类条目）本章做完了/不再需要了，也算回收，同样报进 resolvedForeshadowing 并给 targetThreadHint；别只回收谜题类伏笔。",
    "· resourceDeltas[]：本章主角实际完成的获得/失去/消耗的具体资源（物品/货币/数量）。item=资源名，change=gain|loss|spend，amount=原文数量字符串（如『十二枚』，不要换算单位、不要自己算），quote=写到该变化的原句。程序逐字核对 amount 在 quote 里；正文没写明数量就省略 amount，只报 item+change+quote，别猜数、别选无数量的句子。交易未成交、对方没收下/推回、只是拿出来展示的，都不算得失（如把灵石放在柜台上但对方没收=没有失去）。",
    "· keyLeads[]：本章浮现的、指向后续的关键线索/悬念（不同于已回收的）。summary+quote。",
    "· pendingIntents[]：本章留下的未完成待办/下一步意图（不同于已完成决定）。summary=还要做什么，quote=写到该待办/意图的原句。只有正文明确留下后续行动时才报；已经完成的行动不要报。",
    "· charactersPresent[]：本章正文里【出现的每个有名字的角色】各报一条。name=正文里用到的名字（逐字照抄，含姓氏，不要改写），quote=含该名字的原句；若该角色对应下方【本书已确立的角色名】里的某人，name 必须与已确立写法【完全一致】，别写成形近的错名；若能指明是谁，用 identityHint 备注（如『主角』『主角的妹妹』）。",
    "· arcGoalProgress[]：本章对【主线/阶段目标】的推进。目标=主角这条线在图谋/追求什么（题材中立，不要套任何题材模板）。长篇里主角几乎每章都在为某个目标使劲——本章只要主角在为某个目标查/找/争/守/逃/达成什么，就【至少报一条】（哪怕只是 advanced 一个已存在的目标）；只有纯过渡、主角完全没有任何目标性行动时才给空数组。每条：summary=目标是什么（一句话，尽量简短、像个标题，跨章尽量用同一个说法），progress=introduced(本章新确立这个目标)|advanced(本章朝它推进了一步)|completed(本章达成/了结了它)，scope=main_arc(贯穿全书的大目标)|mini_arc(近几章的小目标)（introduced 时给），quote=最能代表该推进的【正文里连续的一整句原文】（不要拼接多句）。若推进/达成的是下方【已存在的主线/阶段目标】里的某一条，把它的标题填进 targetGoalHint（务必对应已有条目、逐字沿用其标题，不要新造），让它归到同一条、别把一个目标拆成好几个。",
    "· continuityWithPrevious：如果下方给了【上一章结尾】，判断本章开头是否自然承接上一章结尾。connects=true|false；若 false，note 用一句话说明断裂点。这个字段不带 quote，也不要把上一章结尾内容当作任何字段的 quote 来源。未给上一章结尾时省略。",
    "通用摘要规则：summary 必须是你自己组织的一句话概括（谁+做了什么+结果），禁止把 quote 原句照抄或近乎照抄当 summary。summary 是给时间线看的干净摘要，quote 才是证据原文。",
    "写名字的铁律：本书已确立的角色，名字每次都必须与【本书已确立的角色名】里的写法逐字一致，禁止把『林宁』写成『林棠』这类形近漂移。",
    "只输出一个 JSON 对象，键为：mainEvent, conflict, discovery, decision, seededForeshadowing, resolvedForeshadowing, resourceDeltas, keyLeads, pendingIntents, charactersPresent, arcGoalProgress, continuityWithPrevious。不要 Markdown、不要解释、不要多余文字。",
  ].join("\n");
  const openThreads = input.openThreadTitles && input.openThreadTitles.length > 0
    ? `\n【已存在的未决伏笔/线索（回收时 targetThreadHint 请从这里选，不要新造；本章交代清楚的记得报进 resolvedForeshadowing）】\n${input.openThreadTitles.join("、")}`
    : "";
  const establishedNames = input.establishedNames && input.establishedNames.length > 0
    ? `\n【本书已确立的角色名（务必逐字沿用，勿写形近错名）】\n${input.establishedNames.join("、")}`
    : "";
  const openGoals = input.openGoalTitles && input.openGoalTitles.length > 0
    ? `\n【已存在的主线/阶段目标（推进/达成时 targetGoalHint 请从这里选，不要新造）】\n${input.openGoalTitles.join("、")}`
    : "";
  const previousEnding = input.previousChapterEnding && input.previousChapterEnding.trim().length > 0
    ? `\n【上一章结尾（仅用于判断衔接，绝不能作为任何字段的 quote 来源）】\n${input.previousChapterEnding.trim()}`
    : "";
  const user = `【第 ${input.chapter} 章正文】\n${input.draft}${previousEnding}${openThreads}${establishedNames}${openGoals}`;
  return [{ role: "system", content: system }, { role: "user", content: user }];
}

function normalizeSummaryForCopyCheck(text: string): string {
  return text.replace(/[\s\u3000]+/gu, "");
}

function isSummaryLikelyCopiedFromQuote(summary: string, quote: string): boolean {
  const normalizedSummary = normalizeSummaryForCopyCheck(summary);
  const normalizedQuote = normalizeSummaryForCopyCheck(quote);
  if (!normalizedSummary || !normalizedQuote) return false;
  if (normalizedSummary === normalizedQuote) return true;
  const diff = Math.abs(normalizedSummary.length - normalizedQuote.length);
  return diff < 6 && (normalizedSummary.includes(normalizedQuote) || normalizedQuote.includes(normalizedSummary));
}

function warnLikelyCopiedSummaries(chapter: number, declaration: ChapterDeltaDeclaration): void {
  const fields = [
    ["mainEvent", declaration.mainEvent],
    ["conflict", declaration.conflict],
    ["discovery", declaration.discovery],
    ["decision", declaration.decision],
  ] as const;
  for (const [field, value] of fields) {
    if (value && isSummaryLikelyCopiedFromQuote(value.summary, value.quote)) {
      console.warn(`[chapter-delta] ch${chapter} ${field}.summary 疑似照抄 quote 原句`);
    }
  }
}

/**
 * 从模型文本里抠出 JSON 并打捞成 ChapterDeltaDeclaration。
 * 只有「抠不出 JSON / JSON.parse 失败 / 根不是对象」才整体 undefined；
 * 字段级的坏数据（单条枚举写错、类型不对）逐条丢弃并记 onDrop，其余照收——绝不整份陪葬。
 */
export function parseChapterDeltaDeclaration(
  modelText: string,
  chapter: number,
  onDrop?: DeclarationDropListener,
): ChapterDeltaDeclaration | undefined {
  const match = modelText.match(/\{[\s\S]*\}/u);
  if (!match) {
    onDrop?.("(root)", "模型输出里抠不出 JSON 对象");
    return undefined;
  }
  let root: unknown;
  try {
    root = JSON.parse(match[0]);
  } catch (error) {
    onDrop?.("(root)", `JSON.parse 失败：${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
  if (typeof root !== "object" || root === null || Array.isArray(root)) {
    onDrop?.("(root)", "JSON 根不是对象");
    return undefined;
  }
  const raw = root as Record<string, unknown>;
  const mainEvent = salvageScalar(raw.mainEvent, "mainEvent", onDrop);
  if (raw.mainEvent === undefined || raw.mainEvent === null) {
    onDrop?.("mainEvent", `声明缺失 mainEvent（模型未给），将回退正则`);
  }
  const conflict = salvageScalar(raw.conflict, "conflict", onDrop);
  const discovery = salvageScalar(raw.discovery, "discovery", onDrop);
  const decision = salvageScalar(raw.decision, "decision", onDrop);
  const continuityWithPrevious = salvageContinuityWithPrevious(raw.continuityWithPrevious, "continuityWithPrevious", onDrop);
  return {
    chapter,
    // mainEvent 是引擎契约里的必填项；模型没给/给坏时用空证据占位，引擎会以 empty_quote 拒收并回退正则（等价老行为）。
    mainEvent: mainEvent ?? { summary: "", quote: "" },
    ...(conflict ? { conflict } : {}),
    ...(discovery ? { discovery } : {}),
    ...(decision ? { decision } : {}),
    seededForeshadowing: salvageList(raw.seededForeshadowing, foreshadowingItem, "seededForeshadowing", onDrop),
    resolvedForeshadowing: salvageList(raw.resolvedForeshadowing, foreshadowingItem, "resolvedForeshadowing", onDrop),
    resourceDeltas: salvageList(raw.resourceDeltas, resourceItem, "resourceDeltas", onDrop),
    keyLeads: salvageList(raw.keyLeads, evidenceItem, "keyLeads", onDrop),
    pendingIntents: salvageList(raw.pendingIntents, pendingIntentItem, "pendingIntents", onDrop),
    charactersPresent: salvageList(raw.charactersPresent, characterItem, "charactersPresent", onDrop),
    arcGoalProgress: salvageList(raw.arcGoalProgress, arcGoalItem, "arcGoalProgress", onDrop),
    ...(continuityWithPrevious ? { continuityWithPrevious } : {}),
  };
}

/**
 * 编排：让模型声明本章语义。任何异常/超时/坏 JSON → undefined（非致命，降级到引擎正则）。
 * 空正文直接返回 undefined，不浪费一次模型调用。
 * 降级绝不静默：失败原因 console.warn 落 server 日志（20 章真机曾 6/20 章无声回退正则、mainEvent 变对白碎片，
 * 日志零痕迹 → 诊断只能靠事后对账；用户路径仍平滑降级不受影响）。
 */
export interface DeclareChapterDeltaInput {
  readonly chapter: number;
  readonly draft: string;
  readonly callModel: DeclareCallModel;
  readonly openThreadTitles?: readonly string[];
  readonly establishedNames?: readonly string[];
  readonly openGoalTitles?: readonly string[];
  readonly previousChapterEnding?: string;
}

/** 兼容旧签名：只要声明本体（拿不到=undefined）。新代码请用 declareChapterDeltaWithStatus 拿状态+原因。 */
export async function declareChapterDelta(input: DeclareChapterDeltaInput): Promise<ChapterDeltaDeclaration | undefined> {
  return (await declareChapterDeltaWithStatus(input)).declaration;
}

/** 把异常文本压成一行、截短（不含草稿正文；上游错误体可能很长）。 */
function compactErrorText(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).trim().replace(/\s+/gu, " ");
  return message.length > 160 ? `${message.slice(0, 160)}…` : message || "未知错误";
}

/**
 * 带状态的声明编排：status=model 表示拿到了可用声明（引擎还会逐条做证据校验）；status=fallback 表示本章没拿到，
 * 下游按确定性规则兜底，并把 reason 一路带到给用户看的 summary——治「6/20 章无声回退正则、用户不知情」的静默退化。
 * 任何异常/超时/坏 JSON 都不抛（声明不是致命步骤），但绝不静默：返回 fallback+原因，并 console.warn 落 server 日志。
 */
export async function declareChapterDeltaWithStatus(input: DeclareChapterDeltaInput): Promise<ChapterDeltaDeclarationOutcome> {
  if (!input.draft || input.draft.trim().length === 0) {
    return { status: "fallback", reason: "正文为空，没有可声明的章节语义" };
  }
  const onDrop: DeclarationDropListener = (field, detail) => {
    console.warn(`[chapter-delta] ch${input.chapter} 声明字段丢弃 ${field}：${detail}`);
  };
  try {
    const messages = buildChapterDeltaMessages({
      chapter: input.chapter,
      draft: input.draft,
      ...(input.openThreadTitles ? { openThreadTitles: input.openThreadTitles } : {}),
      ...(input.establishedNames ? { establishedNames: input.establishedNames } : {}),
      ...(input.openGoalTitles ? { openGoalTitles: input.openGoalTitles } : {}),
      ...(input.previousChapterEnding ? { previousChapterEnding: input.previousChapterEnding } : {}),
    });
    const text = await input.callModel(messages);
    const declaration = parseChapterDeltaDeclaration(text, input.chapter, onDrop);
    if (!declaration) {
      console.warn(`[chapter-delta] ch${input.chapter} 声明整体失败（模型输出无法解析成 JSON），回退引擎正则`);
      return { status: "fallback", reason: "声明模型的输出无法解析成结构化 JSON" };
    }
    warnLikelyCopiedSummaries(input.chapter, declaration);
    return { status: "model", declaration };
  } catch (error) {
    console.warn(
      `[chapter-delta] ch${input.chapter} 声明调用异常（${error instanceof Error ? error.message : String(error)}），回退引擎正则`,
    );
    return { status: "fallback", reason: `声明模型调用失败：${compactErrorText(error)}` };
  }
}

/**
 * 声明调用的空闲窗口（不是总时长上限）：只要模型还在吐字节就续命，彻底静默超过这么久才判死。
 * 预览路径用户在等，所以比审稿/质检的 90s 收紧到 45s（真机 2026-07-04 实测正常返回 10~16s）；
 * 但绝不再设固定总时长死表——旧 20s/45s 死表掐在长正文分布右尾上，是 6/20 章无声降级的直接原因。
 */
export const DECLARE_IDLE_TIMEOUT_MS = 45_000;

/**
 * 生产用 callModel：复用 chapterSteering 任务档、强制关思考（声明只机械抽 JSON、不需推理链）、json_object。
 * 走 streamChatModelToText：流式 + 空闲超时（有字节就续命、无总时长上限）；一律不传 max_tokens。
 * 流里的 error 帧 / finish_reason=length 会在 llm-client 层诚实抛错，这里原样向上抛，由 declareChapterDeltaWithStatus 收成 fallback+原因。
 */
export const callConfiguredDeclareModel: DeclareCallModel = async (messages) => {
  const configured = await resolveConfiguredChatModel("chapterSteering");
  const { content } = await streamChatModelToText({
    configured: { ...configured, thinking: false },
    messages: messages.map((message) => ({ role: message.role, content: message.content })),
    responseFormat: { type: "json_object" },
    idleTimeoutMs: DECLARE_IDLE_TIMEOUT_MS,
  });
  if (!content.trim()) throw new Error("声明模型返回了空内容。");
  return content;
};
