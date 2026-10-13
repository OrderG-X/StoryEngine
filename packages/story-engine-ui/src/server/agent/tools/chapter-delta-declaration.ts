/**
 * chapter-delta-declaration —— 「声明本章语义」的确定性契约层（UI server 层，守 import 边界）。
 *
 * 背景：引擎退出「从正文正则猜结构化数据」，改由模型主动声明本章 mainEvent / 埋的伏笔 / 回收的伏笔 / 资源变化 / 关键线索，
 * 每条附正文原句证据；引擎只做确定性证据校验（见 @actalk/story-engine 的 verifyChapterDelta）。
 * 2026-10-12 编辑部 R3 起，声明只由记账员（brain/ledger.ts，跟读窗口里声明）产出；本模块留下的是共用的
 * 确定性工具：字段说明（buildChapterDeltaSystemSpec）、附加上下文段（buildChapterDeltaContextSections）、
 * 逐条打捞的解析（parseChapterDeltaDeclaration）、线索编号换算（resolveThreadRefs）、照抄提醒（warnLikelyCopiedSummaries）。
 *
 * 铁律：题材中立、绝不臆造——模型只允许引用正文真实出现的句子，引擎会逐字复核、对不上就丢弃。
 * 解析是【逐条打捞】不是整体判死：单条列表项不合 schema 只丢那一条，其余照收——对齐 lenient-args 的「永远不信模型会传干净输入」。
 * 丢条经 DeclarationDropListener 回调（生产接 console.warn 落 server 日志），长跑诊断有迹可循。
 */
import { z } from "zod";
import type { ChapterDeltaDeclaration } from "@actalk/story-engine";

const evidenceItem = z.object({
  summary: z.string().trim().min(1),
  quote: z.string().trim().min(1),
});

/** 可选文本字段宽进：空串/空白/非字符串一律当「没给」，不让整条声明因为一个空的可选字段被丢掉（模型常给 ""）。 */
const optionalHint = z.preprocess(
  (value) => (typeof value === "string" && value.trim() ? value.trim() : undefined),
  z.string().optional(),
);

/**
 * 线索编号引用宽进（R7.8）：除了单个字符串，数组（模型常把多个编号写成 ["T3","T5"]）也收——
 * 过滤非字符串项后用「、」拼成一个字符串，交给 resolveThreadRefs 展开成多条；拼不出内容当「没给」。
 */
const refListHint = z.preprocess(
  (value) => {
    if (Array.isArray(value)) {
      const parts = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
      return parts.length > 0 ? parts.map((item) => item.trim()).join("、") : undefined;
    }
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  },
  z.string().optional(),
);

const foreshadowingItem = z.object({
  summary: z.string().trim().min(1),
  quote: z.string().trim().min(1),
  targetThreadHint: refListHint,
});

/**
 * 关键线索（阶段 4「记账对号」）：progress=advanced + targetThreadHint 指向已开着的线索 → 推进那一条、不新建。
 * progress 宽进：中英文说法都认，认不出就当没给（按新线索处理），不丢整条。
 * targetThreadHint 宽进「多个编号」（R7.8 线索降噪）：同一谜团拆成的多条，推进/回收时要能把相关编号都挂上——
 * 字符串里写多个（T3、T5）或直接给数组都收，展开在 resolveThreadRefs 做。
 */
const keyLeadItem = z.object({
  summary: z.string().trim().min(1),
  quote: z.string().trim().min(1),
  progress: z.preprocess((value) => {
    const text = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (text === "advanced" || text === "推进" || text === "advance") return "advanced";
    if (text === "introduced" || text === "新" || text === "新增" || text === "new") return "introduced";
    return undefined;
  }, z.enum(["introduced", "advanced"]).optional()),
  targetThreadHint: refListHint,
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
  /** 可选：这个称呼指向的已确立人物名字（编辑部记账员用；旧声明不写这个字段照旧）。 */
  aliasOf: optionalHint,
  quote: z.string().trim().min(1),
});

const arcGoalItem = z.object({
  summary: z.string().trim().min(1),
  progress: z.enum(["introduced", "advanced", "completed"]),
  scope: z.enum(["main_arc", "mini_arc"]).optional(),
  targetGoalHint: z.string().trim().min(1).optional(),
  quote: z.string().trim().min(1),
});

const pendingIntentItem = evidenceItem.extend({ targetThreadHint: refListHint });

/** 本章的时间（故事时间线）：宽进——天数给成「3」「三」都收，星期给成「星期二」也收；原句必须有。 */
const CHINESE_SMALL_NUMBERS: Record<string, number> = { 零: 0, 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const timeItem = z.object({
  daysSincePrevious: z.preprocess((value) => {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (/^\d+$/u.test(trimmed)) return Number(trimmed);
      if (trimmed in CHINESE_SMALL_NUMBERS) return CHINESE_SMALL_NUMBERS[trimmed];
      return undefined;
    }
    return value === null ? undefined : value;
  }, z.number().int().min(0).max(3650).optional()),
  weekday: z.preprocess((value) => (typeof value === "string" && value.trim() ? value.trim() : undefined), z.string().optional()),
  timeOfDay: z.preprocess((value) => (typeof value === "string" && value.trim() ? value.trim() : undefined), z.string().optional()),
  quote: z.string().trim().min(1),
});

/** 章内过了几天：天数宽进（「1」「一」「两」都收），原句必须有。 */
const timeSpanItem = z.object({
  days: z.preprocess((value) => {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (/^\d+$/u.test(trimmed)) return Number(trimmed);
      if (trimmed in CHINESE_SMALL_NUMBERS) return CHINESE_SMALL_NUMBERS[trimmed];
      return undefined;
    }
    return value;
  }, z.number().int().min(1).max(60)),
  quote: z.string().trim().min(1),
});

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

/**
 * 声明字段的说明与 JSON 键（记账员拼在跟读窗口后那条 user 消息里；字段契约的单一事实源，改这里必须在题库上比分）。
 */
export function buildChapterDeltaSystemSpec(): string {
  return [
    "你是中文小说的『章节语义记录员』。只读这一章正文，声明本章发生的结构化语义，供后续状态追踪使用。",
    "题材中立：不要假设任何题材套路。只声明正文【真实写到】的，禁臆造、禁补剧情、禁预设走向；本章没有的类别就给空数组。",
    "每一条都必须附 quote：一句【逐字摘自正文的原句】作为证据（可含标点，但不能改写、不能拼接、不能自己造句）。程序会逐字复核，对不上的条目会被丢弃。",
    "字段说明：",
    "· mainEvent：本章最核心的一件事。mainEvent 选【本章推动故事的最大一件事】——交易达成、关键会面、重大发现、冲突爆发、得到/失去关键东西。看见某人/某物（望风、暗哨、路人经过）、赶路、进门、环境与气氛铺垫都不是 mainEvent，除非本章确实只发生了这一件事。summary 一句话概括，quote 引用最能代表该事件的正文原句。",
    "· conflict：本章的核心冲突/对立（可选，没有就不给）。summary=冲突是什么，quote=体现冲突的正文原句。",
    "· discovery：本章主角查明/发现/得知的关键信息（可选，没有就不给）。summary=发现了什么，quote=写到该发现的正文原句。",
    "· decision：本章主角做出的关键决定/选择（可选，没有就不给）。summary=决定做什么，quote=写到该决定的正文原句。",
    "· seededForeshadowing[]：本章【新埋下】、预期后文回收的跨章悬念（之前没出现过；下方【已开着的线索】里已有的不算新伏笔）。summary=这条伏笔是什么，quote=埋设它的原句。本章内已经解决的紧张/障碍不算伏笔，不要报。",
    "· resolvedForeshadowing[]：本章【回收/揭晓】的、【之前已埋下】的伏笔或线索——正文必须写出了答案/结论才算回收；只是又提到、又核对一遍、有了新进展，那是推进，报进 keyLeads（progress=advanced），不要报在这里。summary=揭晓了什么，quote=揭晓的原句；对应下方【已开着的线索】里的哪一条，就把它的编号（如 T3）填进 targetThreadHint。之前挂着的计划/待办（尤其是『决定/需要/打算』类条目）本章做完了/不再需要了，也算回收，同样报进 resolvedForeshadowing 并给编号；别只回收谜题类伏笔。",
    "· resourceDeltas[]：本章主角实际完成的获得/失去/消耗的具体资源（物品/货币/数量）。item=资源名，change=gain|loss|spend，amount=原文数量字符串（如『十二枚』，不要换算单位、不要自己算），quote=写到该变化的原句。程序逐字核对 amount 在 quote 里；正文没写明数量就省略 amount，只报 item+change+quote，别猜数、别选无数量的句子。交易未成交、对方没收下/推回、只是拿出来展示的，都不算得失（如把灵石放在柜台上但对方没收=没有失去）。",
    "· keyLeads[]：本章浮现或推进的关键线索/悬念（不同于已回收的）。summary+quote，再加 progress：introduced=本章新冒出来的问题；advanced=推进了下方【已开着的线索】里的某一条（有了新进展但还没解开），这时把那条的编号（如 T3）填进 targetThreadHint；同一谜团在【已开着的线索】里拆成了多条的，把相关编号都填上（如 T3、T5），让每条都算推进。同一件事只报一条：seededForeshadowing 里报过的，不要在 keyLeads 再报一遍；已开着的线索有新进展，一律报 advanced，不要换个说法当新线索。introduced 只报正文里【还没有答案】的问题，summary 写成问句（「谁…？」「为什么…？」）；本章查到的结果、看到的东西本身是事实（会另记进事实账本），不是线索。",
    "· pendingIntents[]：本章留下的未完成待办/下一步意图（不同于已完成决定）。summary=还要做什么，quote=写到该待办/意图的原句。只有正文明确留下后续行动时才报；已经完成的行动不要报。和下方【已开着的线索】里某条是同一件事的，把它的编号填进 targetThreadHint，不要换个说法另报一条。",
    "· charactersPresent[]：本章正文里【出现的每个有名字的角色】各报一条。name=正文里用到的名字（逐字照抄，含姓氏，不要改写），quote=含该名字的原句；若该角色对应下方【本书已确立的角色名】里的某人，name 必须与已确立写法【完全一致】，别写成形近的错名；若能指明是谁，用 identityHint 备注（如『主角』『主角的妹妹』）。",
    "· viewpoint：这一章主要跟着谁的眼睛走（视角人物）——写那个人的名字，且要与 charactersPresent 里该角色的写法一致；多视角或全知叙事就省略整个字段。",
    "· arcGoalProgress[]：本章对【主线/阶段目标】的推进。目标=主角这条线在图谋/追求什么（题材中立，不要套任何题材模板）。长篇里主角几乎每章都在为某个目标使劲——本章只要主角在为某个目标查/找/争/守/逃/达成什么，就【至少报一条】（哪怕只是 advanced 一个已存在的目标）；只有纯过渡、主角完全没有任何目标性行动时才给空数组。每条：summary=目标是什么（一句话，尽量简短、像个标题，跨章尽量用同一个说法），progress=introduced(本章新确立这个目标)|advanced(本章朝它推进了一步)|completed(本章达成/了结了它)，scope=main_arc(贯穿全书的大目标)|mini_arc(近几章的小目标)（introduced 时给），quote=最能代表该推进的【正文里连续的一整句原文】（不要拼接多句）。若推进/达成的是下方【已存在的主线/阶段目标】里的某一条，把它的标题填进 targetGoalHint（务必对应已有条目、逐字沿用其标题，不要新造），让它归到同一条、别把一个目标拆成好几个。",
    "· time：本章正文交代了时间就报（和上一章隔了几天 / 星期几 / 时段），没交代就省略整个字段。daysSincePrevious=和上一章隔了几天（同一天 0，「第二天」1，「三天后」3；正文没说隔几天就不填）；weekday=正文明写的星期（「周二」，没写就不填，不要自己推算）；timeOfDay=正文写的时段（「下午」）；quote=本章开头交代时间的那句原文（章中间才换天的那句报在 timeSpan，别报在这里）。不要写「故事第几天」，也不要根据上下文自己推日子。",
    "· timeSpan：本章正文里【章内换了天】才报（开头那天写着写着到了「第二天上午」「过了两天」）。days=从本章开头到结尾一共过了几天（只换了一次天就是 1）；quote=交代换天的那句原文。整章都在同一天里就省略。开头和上一章隔了几天报在 time 里，别算进这里。",
    "· continuityWithPrevious：如果下方给了【上一章结尾】，判断本章开头是否自然承接上一章结尾。connects=true|false；若 false，note 用一句话说明断裂点。这个字段不带 quote，也不要把上一章结尾内容当作任何字段的 quote 来源。未给上一章结尾时省略。",
    "通用摘要规则：summary 必须是你自己组织的一句话概括（谁+做了什么+结果），禁止把 quote 原句照抄或近乎照抄当 summary。summary 是给时间线看的干净摘要，quote 才是证据原文。",
    "写名字的铁律：本书已确立的角色，名字每次都必须与【本书已确立的角色名】里的写法逐字一致，禁止把『林宁』写成『林棠』这类形近漂移。",
    "只输出一个 JSON 对象，键为：mainEvent, conflict, discovery, decision, seededForeshadowing, resolvedForeshadowing, resourceDeltas, keyLeads, pendingIntents, charactersPresent, viewpoint, arcGoalProgress, continuityWithPrevious, time, timeSpan。不要 Markdown、不要解释、不要多余文字。",
  ].join("\n");
}

/**
 * 声明的附加上下文段（开着的线索 / 已确立角色名 / 已存在目标 / 上一章结尾），按这个顺序拼在正文后面。
 * 记账员复用同一段（上一章结尾那段它不需要——窗口里刚读过全文，调用方不传就没有）。
 */
export function buildChapterDeltaContextSections(input: {
  readonly openThreadTitles?: readonly string[];
  readonly establishedNames?: readonly string[];
  readonly openGoalTitles?: readonly string[];
  readonly previousChapterEnding?: string;
}): string {
  const openThreads = input.openThreadTitles && input.openThreadTitles.length > 0
    ? `\n【已开着的线索（编号 标题；推进或回收时把编号填进 targetThreadHint，不要新造；本章写出答案的记得报进 resolvedForeshadowing）】\n${input.openThreadTitles.map((title, index) => `T${index + 1} ${title}`).join("\n")}`
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
  return `${previousEnding}${openThreads}${establishedNames}${openGoals}`;
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

/** summary 疑似照抄 quote 的提醒（记账员路也复用：两路同一套诊断）。 */
export function warnLikelyCopiedSummaries(chapter: number, declaration: ChapterDeltaDeclaration): void {
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
  // 章内换天：模型给 0 / 空 / 坏值都当没报（整章同一天），不算丢字段。
  const timeSpan = ((): z.infer<typeof timeSpanItem> | undefined => {
    if (raw.timeSpan === undefined || raw.timeSpan === null) return undefined;
    const result = timeSpanItem.safeParse(raw.timeSpan);
    return result.success ? result.data : undefined;
  })();
  const time = ((): z.infer<typeof timeItem> | undefined => {
    if (raw.time === undefined || raw.time === null) return undefined;
    const result = timeItem.safeParse(raw.time);
    if (result.success) return result.data;
    onDrop?.("time", result.error.issues.map((issue) => issue.message).join("; "));
    return undefined;
  })();
  // 视角人物（R5.1）：一个名字字符串；空串/空白/非字符串当「没给」（多视角或全知），不记 onDrop。
  // 「在不在出场名单里」的语义校验在引擎 verifyChapterDelta，这里只做句法归一。
  const viewpoint = ((): string | undefined => {
    const result = optionalHint.safeParse(raw.viewpoint);
    return result.success ? result.data : undefined;
  })();
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
    keyLeads: salvageList(raw.keyLeads, keyLeadItem, "keyLeads", onDrop),
    pendingIntents: salvageList(raw.pendingIntents, pendingIntentItem, "pendingIntents", onDrop),
    charactersPresent: salvageList(raw.charactersPresent, characterItem, "charactersPresent", onDrop),
    arcGoalProgress: salvageList(raw.arcGoalProgress, arcGoalItem, "arcGoalProgress", onDrop),
    ...(continuityWithPrevious ? { continuityWithPrevious } : {}),
    ...(viewpoint ? { viewpoint } : {}),
    ...(time ? { time: { quote: time.quote, ...(time.daysSincePrevious !== undefined ? { daysSincePrevious: time.daysSincePrevious } : {}), ...(time.weekday ? { weekday: time.weekday } : {}), ...(time.timeOfDay ? { timeOfDay: time.timeOfDay } : {}) } } : {}),
    ...(timeSpan ? { timeSpan } : {}),
  };
}

/**
 * 把线索编号（T3）换回给模型看的那条标题原文：引擎按标题归到同一条线索。
 * 不是编号的（模型直接写了标题）原样保留；编号越界的当没给（按新线索处理，宁可多一条也不指错）。
 * 多编号展开（R7.8 线索降噪）：targetThreadHint 整串只由编号和分隔符组成（T3、T5）时，拆成多条声明、
 * 每条各挂一个编号——同一谜团拆成的几条线索，一次推进/回收能挂到所有相关条目上，不再只记其中一条、
 * 让其余的白白吃「多章没推进」。单个编号（或混着其他文字的）行为不变。
 */
export function resolveThreadRefs(declaration: ChapterDeltaDeclaration, openThreadTitles: readonly string[]): ChapterDeltaDeclaration {
  const resolve = (hint: string | undefined): string | undefined => {
    if (!hint) return undefined;
    const ref = /^\s*[Tt](\d+)\s*$/u.exec(hint);
    if (!ref) return hint;
    return openThreadTitles[Number(ref[1]) - 1];
  };
  const withHint = <T extends { readonly targetThreadHint?: string }>(item: T): T => {
    const { targetThreadHint, ...rest } = item;
    const resolved = resolve(targetThreadHint);
    return (resolved ? { ...rest, targetThreadHint: resolved } : rest) as T;
  };
  const MULTI_REF_HINT = /^(?:\s*[Tt]\d+[\s、,，;；/]\s*)+[Tt]\d+\s*$/u;
  const expandRefHints = <T extends { readonly targetThreadHint?: string }>(items: readonly T[]): readonly T[] =>
    items.flatMap((item) => {
      const hint = item.targetThreadHint?.trim();
      if (!hint || !MULTI_REF_HINT.test(hint)) return [withHint(item)];
      const titles = [...hint.matchAll(/[Tt](\d+)/gu)]
        .map((match) => openThreadTitles[Number(match[1]) - 1])
        .filter((title): title is string => typeof title === "string" && title.length > 0);
      const uniqueTitles = [...new Set(titles)];
      const { targetThreadHint: _dropped, ...rest } = item;
      // 全部越界 → 当没给（与单个越界编号同口径，按新线索处理）；
      // 只剩一个有效标题 → 不拆条，直接换成那个标题（别把「T2、T9」这种原串留在 hint 里指不到任何线索）。
      if (uniqueTitles.length === 0) return [rest as T];
      if (uniqueTitles.length === 1) return [{ ...rest, targetThreadHint: uniqueTitles[0] } as T];
      return uniqueTitles.map((title) => ({ ...rest, targetThreadHint: title }) as T);
    });
  return {
    ...declaration,
    resolvedForeshadowing: expandRefHints(declaration.resolvedForeshadowing),
    keyLeads: expandRefHints(declaration.keyLeads),
    ...(declaration.pendingIntents ? { pendingIntents: expandRefHints(declaration.pendingIntents) } : {}),
  };
}
