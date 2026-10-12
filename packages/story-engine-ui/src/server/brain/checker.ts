/**
 * 核账员（2026-10-12 编辑部第 1 步）：从第 1 章起一章一章跟读、自己记笔记的连续性编辑。
 *
 * 核第 N 章时，在「读完第 N-1 章」那一刻的窗口后面接上新稿，分三遍（盯东西 / 盯人 / 盯时间与信息）让它先逐条对照、再列矛盾。
 * 提示词来自评测脚本 scripts/eval/run-reader-agent.mjs（那一版在题库上验证过）：改提示词先在题库上比分，别凭感觉改。
 * 比旧核账（临时拼材料判一次）查得全：窗口里是读过的全文和它自己的笔记，不靠检索拼证据。
 */
import { resolveConfiguredChatModel, streamChatModelToText } from "../lib/llm-client.js";
import { withStep } from "../lib/token-meter.js";
import {
  containsQuote,
  hedged,
  normalize,
  parseFullReadIssues,
  readEarlierChapters,
  type ContinuityIssueV2,
  type EarlierText,
} from "../agent/continuity-v2/check-chapter.js";
import type { ChapterPlan } from "@actalk/story-engine";
import { ensureReaderWindow, type BrainCallModel, type BrainMessage, type ReaderRole } from "./reader-window.js";

export const CHECKER_ROLE: ReaderRole = {
  id: "checker",
  system: [
    "你是这本长篇小说的连续性编辑，从第 1 章起一章一章跟读。",
    "每读完一章，你写一份读书笔记，记下以后核对要用的硬信息。",
    "作者交来新稿时，你对照读过的前文原文和你的笔记，找出新稿里和前文（或和新稿自己更早的位置）对不上的地方。",
  ].join("\n"),
  noteTask: [
    "读完写这一章的笔记（纯文本，800 字以内），只记以后核对要用的硬信息，不复述情节：",
    "- 时间：本章发生在哪天、离上一章过了几天、几点到几点；约好的日子、期限",
    "- 物件：要紧的东西现在在哪、在谁手里、什么样、写着什么、有几个；本章谁把什么交给了谁、带走了、放回了",
    "- 人物：年龄或能推出年龄的线索、住处、职业、身份、亲属关系、称呼；本章结束时各自在哪",
    "- 信息：谁知道了什么、谁还不知道什么",
    "- 地点：方位、距离、路上用多久、样子",
  ].join("\n"),
};

export type CheckerFocus = "objects" | "people" | "time";

export const CHECKER_FOCUS: Record<CheckerFocus, string> = {
  objects: "这一遍只盯东西：每样物件此刻在哪、在谁手里、什么样、写着什么、有几个；人物身上带的东西是否凭空出现或消失；同一场面里摆设前后是否一致。",
  people: "这一遍只盯人：人物在哪、住在哪、和谁住、身份、年龄、职业、亲属关系、称呼；同一人前后说法是否一致；同一场面里人物的位置和动作前后是否接得上。",
  time: "这一遍只盯时间和信息：几天前、昨天、上周、星期几按前文过了几天算对不对；期限还剩几天；钟点和天色前后接不接得上；路上用时；人物有没有说出按前文还不可能知道的事；把前文发生过的事说成了别的样子。",
};

/** 三遍，各自独立并行；label 用在失败说明里。 */
const CHECKER_PASSES: readonly { readonly focus: CheckerFocus; readonly label: string }[] = [
  { focus: "objects", label: "第 1 遍（盯东西）" },
  { focus: "people", label: "第 2 遍（盯人）" },
  { focus: "time", label: "第 3 遍（盯时间）" },
];

/** 核账提示：先逐条列出新稿里碰到硬信息的说法并对照前文，再把对不上的列为矛盾，每条带把握（sure / maybe）。 */
export function checkTask(chapter: number, focus?: CheckerFocus): string {
  return [
    `这是作者刚交的第 ${chapter} 章新稿（上面还没给过你）。对照你读过的前文原文和笔记，逐段核对：`,
    "1. 先在 checks 里按顺序列出新稿里每一处碰到硬信息的说法：物件在哪、谁拿着、写着什么、有几个；人物年龄、身份、住处、亲属、称呼；几天前、几点、星期、天色；谁知道什么；方位、距离、路上用时；数目。每条一句：说法要点 → 前文怎么写的 → 对得上 / 对不上。新稿自己前后也要核（同一场面的钟点、物件位置、人物位置）。",
    "2. 对不上的放进 contradictions。写了变化过程的、人物明确在撒谎或记错的、只是补充细节的，不算。本来会变的状态（门开关、灯、值班的人）不同时候不一样也不算。",
    "每条 contradictions：quote 逐字抄新稿里有问题的那一句；earlierQuote 逐字抄前文（或新稿更早处）和它冲突的那一句；earlierChapter 写那句在第几章；reason 一句话说哪里对不上；confidence 写 sure（两处不可能同时成立）或 maybe（看着对不上，但也说得通）。抄不出原文的不要报。",
    ...(focus ? [`【这一遍的重点】${CHECKER_FOCUS[focus]}`] : []),
    "只输出一个 JSON：{\"checks\":[\"...\"],\"contradictions\":[{\"quote\":\"\",\"earlierQuote\":\"\",\"earlierChapter\":1,\"reason\":\"\",\"confidence\":\"sure\"}]}",
  ].join("\n");
}

/**
 * 核账员 / 跟读用的模型调用（qualityCheck 槽）：关思考、低随机性、流式。
 * 不传 max_tokens，不设总时长上限（超时铁律）：只有「光想不写」超过 maxThinkingMs 和输出超过 maxContentChars 两道闸，
 * 外面套对冲（一次调用迟迟不回就并行再发一份，谁先回来用谁）。空内容抛错，不当成没问题。
 */
export const callConfiguredBrainModel: BrainCallModel = (messages, options) => {
  const once = async () => {
    const resolved = await resolveConfiguredChatModel("qualityCheck");
    const { content } = await streamChatModelToText({
      configured: { ...resolved, thinking: false },
      messages: messages.map((message) => ({ role: message.role, content: message.content })),
      temperature: 0.1,
      ...(options.json ? { responseFormat: { type: "json_object" as const } } : {}),
      maxThinkingMs: 180_000,
      maxContentChars: 60_000,
    });
    if (!content.trim()) throw new Error("模型返回了空内容");
    return content;
  };
  return hedged(once, 120_000);
};

/** 从模型原始 JSON 里按 quote 取把握：sure / 确定 → sure，其余 maybe；同一句出现几次，有一次 sure 就是 sure。 */
function readConfidences(text: string): Map<string, "sure" | "maybe"> {
  const out = new Map<string, "sure" | "maybe">();
  try {
    const parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as { contradictions?: unknown };
    for (const item of Array.isArray(parsed.contradictions) ? parsed.contradictions : []) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const quote = String(record.quote ?? "").trim();
      const said = String(record.confidence ?? "").toLowerCase();
      const sure = /sure|确定/u.test(said) && !/unsure|not sure|不确定|不太确定/u.test(said);
      if (sure || !out.has(quote)) out.set(quote, sure ? "sure" : "maybe");
    }
  } catch {
    // 解析不了就全当 maybe（正文那边 parseFullReadIssues 自己会报「不是 JSON」）
  }
  return out;
}

/** 三遍合并：一条的原句包含另一条的算同一条，留先出现的；同一句一遍判 sure、一遍判 maybe 取 sure。 */
function mergePasses(passes: readonly (readonly ContinuityIssueV2[])[]): ContinuityIssueV2[] {
  const merged: ContinuityIssueV2[] = [];
  for (const issue of passes.flat()) {
    const quote = normalize(issue.quote);
    const index = merged.findIndex((other) => { const kept = normalize(other.quote); return kept.includes(quote) || quote.includes(kept); });
    if (index < 0) merged.push(issue);
    else if (issue.confidence === "sure" && merged[index]!.confidence !== "sure") merged[index] = { ...merged[index]!, confidence: "sure" };
  }
  return merged;
}

export interface ReaderCheckResult {
  /** 带 confidence。 */
  readonly issues: ContinuityIssueV2[];
  /** 没跑成的步骤（如实说明）。三遍全失败才算这次没核成。 */
  readonly failures: string[];
  /** not_ready＝要补的笔记太多（超过 maxCatchUp），这次没核。 */
  readonly skipped?: "not_ready";
}

/** 核账员核一章：先确保读完前文（缺的笔记补上），再三遍并行核新稿。 */
export async function checkChapterByReader(input: {
  readonly projectDir: string;
  readonly chapter: number;
  readonly draftBody: string;
  readonly callModel: BrainCallModel;
  readonly notesRoot?: string;
  readonly maxCatchUp?: number;
  /** 前面各章原文（核账服务已读过就传进来，省得再读一遍）；缺省从书目录读。 */
  readonly earlier?: EarlierText;
}): Promise<ReaderCheckResult> {
  let window: BrainMessage[];
  try {
    const ready = await withStep("跟读补笔记", () => ensureReaderWindow({
      projectDir: input.projectDir,
      role: CHECKER_ROLE,
      upTo: input.chapter - 1,
      callModel: input.callModel,
      ...(input.notesRoot ? { notesRoot: input.notesRoot } : {}),
      ...(input.maxCatchUp !== undefined ? { maxCatchUp: input.maxCatchUp } : {}),
    }));
    if (ready.missing > 0) return { issues: [], failures: [], skipped: "not_ready" };
    window = ready.messages;
  } catch (error) {
    // 补到一半失败：已写下的笔记留着，下次接着补；这次如实说没核成。
    return { issues: [], failures: [`核账员读前文没成：${error instanceof Error ? error.message : String(error)}`] };
  }
  const earlier = input.earlier ?? await readEarlierChapters(input.projectDir, input.chapter);
  const settled = await withStep("核账员", () => Promise.allSettled(CHECKER_PASSES.map(async ({ focus }) => {
    const text = await input.callModel(
      [...window, { role: "user", content: `【新稿：第 ${input.chapter} 章】\n${input.draftBody}\n\n${checkTask(input.chapter, focus)}` }],
      { json: true },
    );
    const confidences = readConfidences(text);
    return parseFullReadIssues(text, input.chapter, input.draftBody, earlier)
      .map((issue): ContinuityIssueV2 => ({ ...issue, confidence: confidences.get(issue.quote) ?? "maybe" }));
  })));
  const failures: string[] = [];
  const passes: ContinuityIssueV2[][] = [];
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") passes.push(result.value);
    else failures.push(`${CHECKER_PASSES[index]!.label}没跑成：${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
  });
  return { issues: mergePasses(passes), failures };
}

// ---------- 审章纲（2026-10-12 编辑部第 3 步） ----------

/** 核账员审章纲审出的一条问题：point 指 beats 的序号（1 起），beat 由代码按序号取回（不信模型抄写）。 */
export interface PlanProblem {
  readonly point: number;
  readonly beat?: string;
  readonly earlierQuote: string;
  readonly earlierChapter: number;
  readonly reason: string;
}

export interface ReaderPlanCheckResult {
  /** earlierQuote 已由代码逐字核对过真在前文里（抄不出的在解析时丢掉）。 */
  readonly problems: readonly PlanProblem[];
  readonly failures: string[];
  /** not_ready＝要补的笔记太多（超过 maxCatchUp），这次没审。 */
  readonly skipped?: "not_ready";
}

/** 审章纲提示：核账员窗口（读到 N-1）后接「这是第 N 章的章纲（还没写正文）」+ 章纲要点，找和前文矛盾的要点。 */
export function planCheckTask(chapter: number, plan: ChapterPlan): string {
  return [
    `这是作者准备照着写第 ${chapter} 章的章纲（还没写正文），上面还没给过你。对照你读过的前文原文和笔记，找出章纲里和前文对不上的要点：`,
    "- 谁手里有什么：物件此刻在哪、在谁手上，章纲是不是安排拿错了、放错了、又交了一遍",
    "- 谁在哪：人物的位置和行程按前文接不接得上",
    "- 谁知道什么：章纲安排人物说出或用到的信息，他按前文还不可能知道",
    "- 日子：开场时间和「几天后」按前文过了几天算得对不对",
    "- 前文已经做过、发现、确认过的事，章纲又安排一遍",
    "章纲明确安排了变化过程的、作者方向明确要求的，不算。",
    "每条 problems：point 写第几条要点（下面要点列表的序号）；earlierQuote 逐字抄前文和它冲突的那一句；earlierChapter 写那句在第几章；reason 一句话说哪里对不上。抄不出原文的不要报。",
    `【第 ${chapter} 章章纲】`,
    `一句话：${plan.summary}`,
    `要点：\n${plan.beats.map((beat, index) => `${index + 1}. ${beat}`).join("\n")}`,
    ...(plan.newInformation.length > 0 ? [`新信息：\n${plan.newInformation.map((item, index) => `${index + 1}. ${item}`).join("\n")}`] : []),
    `开场：${plan.scene.location ?? "（没写）"}，${plan.scene.time ?? "（没写）"}`,
    ...(plan.characters.length > 0 ? [`人物：${plan.characters.join("、")}`] : []),
    ...(plan.entities.length > 0 ? [`物件/地点：${plan.entities.join("、")}`] : []),
    '只输出一个 JSON：{"problems":[{"point":1,"earlierQuote":"","earlierChapter":1,"reason":""}]}；没有问题就给空数组。',
  ].join("\n");
}

/** 前文按章号 → 归一后的全文（核 earlierQuote 用）。 */
function earlierByText(earlier: EarlierText): ReadonlyMap<number, string> {
  return new Map(earlier.chapters.map((item) => [item.chapter, normalize(item.sentences.join(""))]));
}

/** 要点序号：数字、「第 2 条」都收；越界（或没写）丢掉。 */
function readPoint(raw: unknown, beats: readonly string[]): number | undefined {
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw : "";
  const digits = /\d+/u.exec(text);
  if (!digits) return undefined;
  const point = Number(digits[0]);
  return Number.isInteger(point) && point >= 1 && point <= beats.length ? point : undefined;
}

/**
 * 解析审章纲输出：earlierQuote 由代码核对真在前文里（先信它报的章号，对不上按章序搜），抄不出原文的丢掉；
 * point 越界的丢掉（模型没指到具体要点的问题没法只改那条要点）。
 */
export function parsePlanProblems(text: string, plan: ChapterPlan, earlier: EarlierText): readonly PlanProblem[] {
  let parsed: { problems?: unknown };
  try {
    parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as { problems?: unknown };
  } catch {
    throw new Error("审章纲结果不是 JSON");
  }
  const byChapter = earlierByText(earlier);
  const out: PlanProblem[] = [];
  for (const item of Array.isArray(parsed.problems) ? parsed.problems : []) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const earlierQuote = String(record.earlierQuote ?? "").trim();
    const reason = String(record.reason ?? "").trim();
    const point = readPoint(record.point ?? record.beat, plan.beats);
    if (!point || !earlierQuote || !reason) continue;
    const claimed = Number(record.earlierChapter);
    const inClaimed = Number.isInteger(claimed) && claimed >= 1 && byChapter.has(claimed) && containsQuote(byChapter.get(claimed)!, earlierQuote);
    const chapter = inClaimed
      ? claimed
      : [...byChapter.keys()].sort((a, b) => a - b).find((key) => containsQuote(byChapter.get(key)!, earlierQuote));
    if (chapter === undefined) continue;
    out.push({ point, beat: plan.beats[point - 1], earlierQuote, earlierChapter: chapter, reason });
  }
  return out;
}

/**
 * 核账员审章纲：在读完第 N-1 章的窗口后面接「第 N 章的章纲（还没写正文）」+ 要点，一遍找出和前文矛盾的要点。
 * 章纲短，不用像核正文那样分三遍。earlierQuote 全部经代码核对。
 */
export async function checkPlanByReader(input: {
  readonly projectDir: string;
  readonly plan: ChapterPlan;
  readonly callModel: BrainCallModel;
  readonly notesRoot?: string;
  readonly maxCatchUp?: number;
  /** 前面各章原文（调用方已读过就传进来）；缺省从书目录读。 */
  readonly earlier?: EarlierText;
}): Promise<ReaderPlanCheckResult> {
  let window: BrainMessage[];
  try {
    const ready = await withStep("跟读补笔记", () => ensureReaderWindow({
      projectDir: input.projectDir,
      role: CHECKER_ROLE,
      upTo: input.plan.chapter - 1,
      callModel: input.callModel,
      ...(input.notesRoot ? { notesRoot: input.notesRoot } : {}),
      ...(input.maxCatchUp !== undefined ? { maxCatchUp: input.maxCatchUp } : {}),
    }));
    if (ready.missing > 0) return { problems: [], failures: [], skipped: "not_ready" };
    window = ready.messages;
  } catch (error) {
    return { problems: [], failures: [`核账员读前文没成：${error instanceof Error ? error.message : String(error)}`] };
  }
  const earlier = input.earlier ?? await readEarlierChapters(input.projectDir, input.plan.chapter);
  try {
    const text = await withStep("核账员审纲", () => input.callModel(
      [...window, { role: "user", content: planCheckTask(input.plan.chapter, input.plan) }],
      { json: true },
    ));
    return { problems: parsePlanProblems(text, input.plan, earlier), failures: [] };
  } catch (error) {
    return { problems: [], failures: [`审章纲没跑成：${error instanceof Error ? error.message : String(error)}`] };
  }
}
