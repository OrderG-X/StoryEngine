/**
 * 章纲员（2026-10-12 编辑部第 3 步）：从第 1 章起一章一章跟读的责任编辑，为下一章拟章纲。
 *
 * 拟第 N 章时，在「读完第 N-1 章」那一刻的窗口后面接上：作者给的方向（可为空）+ 章纲 JSON 要求
 * （plan-chapter 的 PLAN_REQUIREMENT_LINES / PLAN_JSON_FIELDS / planMaterialBlocks 同一份文本——改提示词必须在题库上比分）。
 * 输出宽进归一（normalizeChapterPlan）+ reconcileStoryDay 天数归一，落盘 drafts/plans/。
 * 强在：窗口里是读过的全书原文和它自己的笔记（主线 / 想要什么 / 钩子 / 节奏），不靠拼一包检索材料。
 */
import { normalizeChapterPlan, writeChapterPlan, type ChapterPlan } from "../book/chapter-plan.js";
import { resolveConfiguredChatModel, streamChatModelToText, ThinkingTooLongError } from "../lib/llm-client.js";
import { withStep } from "../lib/token-meter.js";
import { containsQuote, normalize, readEarlierChapters } from "./continuity/check-chapter.js";
import {
  collectPlanMaterials,
  isSkeletonPlan,
  parsePlanJson,
  PLAN_JSON_FIELDS,
  PLAN_REQUIREMENT_LINES,
  planMaterialBlocks,
  previousChapterEndDay,
  readDayOffset,
  reconcileStoryDay,
  type PlanChapterMaterials,
} from "./plan-materials.js";
import { buildColdReaderWindow, ensureReaderWindow, type BrainCallModel, type BrainMessage, type ColdCoverage, type ReaderRole } from "./reader-window.js";
import { readerWaitingHandlers, type ReaderWaited } from "./reader-progress.js";
import { readPoint, type PlanProblem } from "./checker.js";

export const PLANNER_ROLE: ReaderRole = {
  id: "planner",
  system: [
    "你是这本长篇小说的责任编辑，从第 1 章起一章一章跟读。",
    "每读完一章，你写一份读书笔记，记下对安排后面章节有用的东西。",
    "作者要写下一章时，你按读过的前文、作者的打算和书的现状，为下一章拟一份章纲：接住上一章结尾、推进开着的线索、留下新钩子，别和前文对不上。",
  ].join("\n"),
  noteTask: [
    "读完写这一章的笔记（纯文本，600 字以内），只记对安排后面章节有用的东西，不复述情节：",
    "- 主线：本章推进了哪条主线，推进到了哪一步",
    "- 人物：本章出场的人物各自想要什么、得到了什么、下一步打算",
    "- 钩子：本章留下的没解决的问题、悬而未决的事",
    "- 节奏：这一章是紧张还是舒缓，下一章适合接什么节奏",
  ].join("\n"),
  // P7 长书验收：没有卷笔记时窗口只能折原文、笔记只增不减，两百章时拟纲提示词涨到二十几万字；有了它和核账员一样封顶。
  volumeTask: [
    "把上面这些读书笔记缩写成一份卷笔记（纯文本，1500 字以内），按章序保住以后安排章节要用的东西，不复述情节：",
    "- 主线：这几章把主线从哪推进到哪，到这几章结束卡在哪一步",
    "- 人物：主要人物各自想要什么、彼此关系怎么变了、到这几章结束各自打算做什么",
    "- 钩子：到这几章结束还没解决的问题、悬而未决的事；这几章里解决了的一笔带过",
    "- 用过的桥段：这几章已经用过的场面、冲突、揭示方式，以后别再重复",
    "- 节奏：这几章整体是紧还是松",
    "同一件事前后有变化时，记最后的状态，再用半句话带出之前的状态。",
  ].join("\n"),
};

/** 拟章纲失败（模型挂了 / 不是 JSON / 缺要点）自动再试的次数（同旧路）。 */
const PLAN_RETRIES = 1;
/** 拟章纲「光想不写」的上限：超过就改用关思考重拟（同旧路 PLAN_MAX_THINKING_MS，别两处改出不一样的数）。 */
const PLAN_MAX_THINKING_MS = 150_000;

export type PlanChapterByPlannerResult =
  | { readonly ok: true; readonly plan: ChapterPlan; /** 冷窗口＝章纲员还没读完全书，这次按已有笔记 + 最近 K 章原文拟的纲（R4.4 起不再跳过）。 */ readonly cold?: ColdCoverage; /** 这次先等了补读（R5.2＋R6.1，谁补的都算）：note 据此加「这次先等章纲员读完…再拟纲」。 */ readonly waited?: ReaderWaited }
  | { readonly ok: false; readonly reason: string };

/** 窗口（读到 N-1）后面接的那条任务消息：作者方向 + 账本材料 + 和旧路同一份的章纲 JSON 要求。 */
export function plannerTask(chapter: number, materials: PlanChapterMaterials, direction?: string): string {
  // 章纲员读过全书原文，「上一章正文 / 前面几章摘要」不用再带；账本里开着的线索、已确立事实这些照带（要求里点名了它们）。
  const blocks = planMaterialBlocks(chapter, materials, direction, { withoutPreviousChapter: true, withoutRecentSummaries: true });
  const requirements = ["要求：", ...PLAN_REQUIREMENT_LINES, "JSON 字段：", PLAN_JSON_FIELDS].join("\n");
  return [
    `你已经从第 1 章跟读到了第 ${chapter - 1} 章（见上面的原文和你的笔记）。现在为第 ${chapter} 章拟一份章纲。只输出一个 JSON，不要解释、不要 Markdown。`,
    ...blocks,
    requirements,
  ].join("\n\n");
}

/**
 * 章纲员那一路的模型调用（chapterSteering 槽）：思考开关随作者在「章纲」任务上的设置，不硬编码。
 * 写笔记是简单活，一律关思考（同核账员）；拟纲「光想不写」超过上限就关思考重拟。不传 max_tokens、不设总时长上限。
 */
export const callConfiguredPlannerModel: BrainCallModel = async (messages, options) => {
  const configured = await resolveConfiguredChatModel("chapterSteering");
  const call = async (thinking: boolean) => {
    const { content } = await streamChatModelToText({
      configured: { ...configured, thinking },
      messages: messages.map((message) => ({ role: message.role, content: message.content })),
      ...(options.json ? { responseFormat: { type: "json_object" as const } } : {}),
      ...(thinking ? { maxThinkingMs: PLAN_MAX_THINKING_MS } : {}),
    });
    if (!content.trim()) throw new Error("章纲员模型返回了空内容");
    return content;
  };
  const thinking = options.json ? configured.thinking : false;
  try {
    return await call(thinking);
  } catch (error) {
    if (!(error instanceof ThinkingTooLongError)) throw error;
    console.warn(`[draft-pipeline] 章纲员拟纲思考超过 ${PLAN_MAX_THINKING_MS / 1000} 秒还没出结果，改用不思考重拟`);
    return call(false);
  }
};

/** 收尾和旧路 finish 一致：天数归一（程序按上一章往后加）+ 反复出现的描写确定性并进 avoid + 落盘。 */
async function finalizePlan(projectDir: string, plan: ChapterPlan, dayOffset: number | undefined, materials: PlanChapterMaterials): Promise<ChapterPlan> {
  const lastDay = await previousChapterEndDay(projectDir, plan.chapter);
  const dated = reconcileStoryDay(plan, dayOffset, lastDay);
  const withAvoid = materials.recurringPhrases.length > 0
    ? { ...dated, avoid: [...dated.avoid, `别再用这些说法：${materials.recurringPhrases.join("、")}`] }
    : dated;
  await writeChapterPlan(projectDir, withAvoid);
  return withAvoid;
}

/**
 * 章纲员拟第 N 章章纲（读到 N-1 的窗口 + 方向 + 章纲 JSON 要求），拟成落盘 drafts/plans/chapter-NNNN.json。
 * 补笔记太多 → skipped:"not_ready" + pending（调用方如实说「还在读前文」并后台补笔记）；拟不成 → ok:false + 原因，不抛、不落盘。
 */
export async function planChapterByPlanner(input: {
  readonly projectDir: string;
  readonly chapter: number;
  /** 作者这章的方向原话；没给 = 按故事现状自己拟。 */
  readonly direction?: string;
  readonly callModel: BrainCallModel;
  readonly notesRoot?: string;
  readonly maxCatchUp?: number;
  readonly now?: Date;
  readonly onProgress?: (chapter: number) => void;
}): Promise<PlanChapterByPlannerResult> {
  let window: BrainMessage[];
  let cold: ColdCoverage | undefined;
  let waited: ReaderWaited | undefined;
  try {
    // 等读（R5.2＋R6.1）：补读期间进度行标「拟纲在等它读完」（进程内登记，进锁前后都算）；
    // 等过了（笔记是谁补上的都算）由 ensureReaderWindow 带回 waited，note 如实说等了哪几章。
    const root = input.notesRoot ?? input.projectDir;
    const waiting = readerWaitingHandlers(root, PLANNER_ROLE.id, input.chapter - 1);
    const onProgress = input.onProgress
      ? async (chapter: number) => { await waiting.onProgress(chapter); await input.onProgress?.(chapter); }
      : waiting.onProgress;
    const ready = await withStep("跟读补笔记", () => ensureReaderWindow({
      projectDir: input.projectDir,
      role: PLANNER_ROLE,
      upTo: input.chapter - 1,
      callModel: input.callModel,
      ...(input.notesRoot ? { notesRoot: input.notesRoot } : {}),
      ...(input.maxCatchUp !== undefined ? { maxCatchUp: input.maxCatchUp } : {}),
      waitingAs: "拟纲",
      onCatchUpBegin: waiting.onCatchUpBegin,
      onProgress,
      onCatchUpEnd: waiting.onCatchUpEnd,
    }));
    waited = ready.waited;
    if (ready.missing > 0) {
      // R4.4 冷窗口兜底：要补的笔记太多不再「按没有章纲出稿」——已有笔记 + 最近 K 章原文先拟，
      // 冷窗口的范围随结果带回（章纲的 note 如实标），笔记由调用方在后台接着补。冷窗口不落盘任何笔记。
      const built = await buildColdReaderWindow({
        projectDir: input.projectDir,
        role: PLANNER_ROLE,
        upTo: input.chapter - 1,
        ...(input.notesRoot ? { notesRoot: input.notesRoot } : {}),
      });
      window = built.messages;
      cold = built.coverage;
    } else {
      window = ready.messages;
    }
  } catch (error) {
    // 补到一半失败：已写下的笔记留着，下次接着补；这次如实说没拟成。
    return { ok: false, reason: `章纲员读前文没成：${error instanceof Error ? error.message : String(error)}` };
  }
  // 材料里只留账本状态（开着的线索 / 已确立事实 / 人物年龄 / 受保护的秘密）：全书原文它已经读过了。
  const materials = await collectPlanMaterials(input.projectDir, input.chapter, input.direction);
  let lastError = "";
  let skeleton: { readonly plan: ChapterPlan; readonly dayOffset: number | undefined } | undefined;
  for (let attempt = 0; attempt <= PLAN_RETRIES; attempt += 1) {
    try {
      const raw = parsePlanJson(await withStep("章纲员", () => input.callModel(
        [...window, { role: "user", content: plannerTask(input.chapter, materials, input.direction) }],
        { json: true },
      )));
      const plan = withVerifiedDirectionChanges(normalizeChapterPlan(raw, {
        chapter: input.chapter,
        source: "model",
        ...(input.direction?.trim() ? { direction: input.direction } : {}),
        ...(input.now ? { now: input.now } : {}),
      }));
      if (!plan) {
        lastError = "章纲缺要点";
        continue;
      }
      const dayOffset = readDayOffset(raw);
      if (isSkeletonPlan(plan, dayOffset) && attempt < PLAN_RETRIES) {
        console.warn(`[draft-pipeline] ch${input.chapter} 章纲员拟的章纲只有要点、人物/开场/新信息全空，重拟一次`);
        skeleton = { plan, dayOffset };
        continue;
      }
      return { ok: true, plan: await finalizePlan(input.projectDir, plan, dayOffset, materials), ...(cold ? { cold } : {}), ...(waited ? { waited } : {}) };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  if (skeleton) return { ok: true, plan: await finalizePlan(input.projectDir, skeleton.plan, skeleton.dayOffset, materials), ...(cold ? { cold } : {}), ...(waited ? { waited } : {}) };
  return { ok: false, reason: `章纲没拟成（已自动重试一次）：${lastError || "模型没有返回可用内容"}` };
}

/** 「改了作者方向」的声明要核原话：said 真在作者方向里才留（模型声明 + 原句核实），抄不出原话的丢掉。 */
function withVerifiedDirectionChanges(plan: ChapterPlan | undefined): ChapterPlan | undefined {
  if (!plan?.directionChanges) return plan;
  const direction = normalize(plan.direction ?? "");
  const kept = plan.directionChanges.filter((change) => containsQuote(direction, change.said));
  const { directionChanges: _dropped, ...rest } = plan;
  return kept.length > 0 ? { ...rest, directionChanges: kept } : rest;
}

/** 章纲 JSON（给改纲提示用，字段和旧审校 buildPlanCheckMessages 的一致）。 */
function planJson(plan: ChapterPlan): Record<string, unknown> {
  return {
    summary: plan.summary,
    beats: plan.beats,
    newInformation: plan.newInformation,
    scene: plan.scene,
    ...(plan.storyDay !== undefined ? { storyDay: plan.storyDay } : {}),
    characters: plan.characters,
    entities: plan.entities,
    threadsAdvanced: plan.threadsAdvanced,
    avoid: plan.avoid,
  };
}

/** 冲突原句在前文里的上下文（归一化后定位，前后各 80 字）。窗口十几万字，模型常定位不到原句才改不对，把那段直接贴给它。 */
function quoteContext(body: string, quote: string): string | undefined {
  const nb = normalize(body);
  const nq = normalize(quote);
  const at = nq.length >= 4 ? nb.indexOf(nq) : -1;
  if (at < 0) return undefined;
  return nb.slice(Math.max(0, at - 80), Math.min(nb.length, at + nq.length + 80));
}

/** 把核账员审出的问题交回章纲员窗口的那条任务消息：只改被指出的那几条要点，其余由程序照原章纲保留（R7.5）。
 *  输出只要被改的要点（不要整份重拟）——旧口径「重发完整章纲 JSON」一次 100 秒、思考 1.2 万字，窄输出把要改的东西缩到几条。 */
export function reviseTask(chapter: number, plan: ChapterPlan, problems: readonly PlanProblem[], contexts: readonly (string | undefined)[] = []): string {
  return [
    `你为第 ${chapter} 章拟的章纲，核账员审出 ${problems.length} 处和前文对不上：`,
    ...problems.map((problem, index) => [
      `${index + 1}. 第 ${problem.point} 条要点「${problem.beat ?? plan.beats[problem.point - 1] ?? ""}」：和第 ${problem.earlierChapter} 章对不上——${problem.reason}`,
      contexts[index] ? `   前文第 ${problem.earlierChapter} 章那段：「…${contexts[index]}…」` : `   冲突的前文原句：「${problem.earlierQuote}」`,
    ].join("\n")),
    "按前文把这几条要点改对：可以整条重写（东西在谁手里就照前文安排、人在哪就照前文安排、日子照前文算、人物还不知道的事就改成他不知道的），不要只换说法糊弄过去。没被指出的要点一个字都不用管，程序会照原章纲保留。",
    `只输出一个 JSON：{"revised":[{"point":1,"beat":"改好的那条要点全文"}],"summary":""}。revised 只列被改的要点（point 写序号）；一句话（summary）只有也提到被改的要点时才换新的，否则留空。除此之外不要输出任何别的内容。`,
    `【原章纲（第 ${chapter} 章）】\n${JSON.stringify(planJson(plan), null, 1)}`,
  ].join("\n\n");
}

/** 审章纲结果：earlierQuote 逐字核对过（代码核），point 指 beats 的序号（1 起）。改一轮的结果，ok=false 时调用方用原章纲。 */
export type RevisePlanResult =
  | { readonly ok: true; readonly plan: ChapterPlan; /** 冷窗口＝章纲员还没读完全书，这次按已有笔记 + 最近 K 章原文改的纲。 */ readonly cold?: ColdCoverage; /** 这次先等了补读（R5.2＋R6.1，谁补的都算）。 */ readonly waited?: ReaderWaited }
  | { readonly ok: false; readonly reason: string };

/**
 * 核账员审出问题后，把问题列表交回章纲员窗口改一轮（只改有问题的要点，不循环）。
 * R7.5 起模型只回被改的要点（{"revised":[{"point":1,"beat":"…"}],"summary":""}），代码按序号确定性拼回原章纲：
 * 其余栏（人物/新信息/开场/avoid/天数）原样保留，不靠模型重抄。改不出任何要点 → ok:false，调用方用原章纲。
 */
export async function revisePlanByPlanner(input: {
  readonly projectDir: string;
  readonly chapter: number;
  readonly plan: ChapterPlan;
  readonly problems: readonly PlanProblem[];
  readonly callModel: BrainCallModel;
  readonly notesRoot?: string;
  readonly maxCatchUp?: number;
  readonly now?: Date;
}): Promise<RevisePlanResult> {
  let window: BrainMessage[];
  let cold: ColdCoverage | undefined;
  let waited: ReaderWaited | undefined;
  try {
    // 等读（R5.2＋R6.1）：改纲也在拟纲流程里，补读期间进度行标「拟纲在等它读完」；等没等由 ensureReaderWindow 判（谁补的都算）。
    const root = input.notesRoot ?? input.projectDir;
    const waiting = readerWaitingHandlers(root, PLANNER_ROLE.id, input.chapter - 1);
    const ready = await withStep("跟读补笔记", () => ensureReaderWindow({
      projectDir: input.projectDir,
      role: PLANNER_ROLE,
      upTo: input.chapter - 1,
      callModel: input.callModel,
      ...(input.notesRoot ? { notesRoot: input.notesRoot } : {}),
      ...(input.maxCatchUp !== undefined ? { maxCatchUp: input.maxCatchUp } : {}),
      waitingAs: "拟纲",
      onCatchUpBegin: waiting.onCatchUpBegin,
      onProgress: waiting.onProgress,
      onCatchUpEnd: waiting.onCatchUpEnd,
    }));
    waited = ready.waited;
    if (ready.missing > 0) {
      // R4.4 冷窗口兜底：没读完也照改（已有笔记 + 最近 K 章原文，冲突的前文原段本来就贴在任务消息里）。
      const built = await buildColdReaderWindow({
        projectDir: input.projectDir,
        role: PLANNER_ROLE,
        upTo: input.chapter - 1,
        ...(input.notesRoot ? { notesRoot: input.notesRoot } : {}),
      });
      window = built.messages;
      cold = built.coverage;
    } else {
      window = ready.messages;
    }
  } catch (error) {
    return { ok: false, reason: `章纲员读前文没成：${error instanceof Error ? error.message : String(error)}` };
  }
  let raw: Record<string, unknown>;
  try {
    // 每条问题的冲突原句在前文里的上下文：直接贴进任务消息（窗口太长，模型自己翻不到就改不对）。
    const earlier = await readEarlierChapters(input.projectDir, input.chapter);
    const byChapter = new Map(earlier.chapters.map((item) => [item.chapter, item.sentences.join("")]));
    const contexts = input.problems.map((problem) => {
      const body = byChapter.get(problem.earlierChapter);
      return body ? quoteContext(body, problem.earlierQuote) : undefined;
    });
    const text = await withStep("章纲员改纲", () => input.callModel(
      [...window, { role: "user", content: reviseTask(input.chapter, input.plan, input.problems, contexts) }],
      { json: true },
    ));
    raw = parsePlanJson(text) as Record<string, unknown>;
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  // R7.5 确定性拼回：模型只回被改的要点（{"revised":[{"point":1,"beat":"…"}],"summary":""}），
  // 代码按序号换进原章纲——其余栏（人物/新信息/开场/avoid/天数）原样保留，不靠模型重抄。
  const beats = [...input.plan.beats];
  const revisedSummary = typeof raw.summary === "string" ? raw.summary.replace(/\s+/gu, " ").trim() : "";
  let changed = 0;
  for (const item of Array.isArray(raw.revised) ? raw.revised : []) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const beat = typeof record.beat === "string" ? record.beat.replace(/\s+/gu, " ").trim() : "";
    const point = readPoint(record.point ?? record.beat, input.plan.beats);
    if (!point || !beat || beat.length > 400) continue;
    if (beats[point - 1] === beat) continue;
    beats[point - 1] = beat;
    changed += 1;
  }
  if (changed === 0 && !revisedSummary) return { ok: false, reason: "改纲没改出任何要点（revised 为空或序号越界）" };
  const settled: ChapterPlan = {
    ...input.plan,
    beats,
    ...(revisedSummary ? { summary: revisedSummary } : {}),
  };
  await writeChapterPlan(input.projectDir, settled);
  return { ok: true, plan: settled, ...(cold ? { cold } : {}), ...(waited ? { waited } : {}) };
}
