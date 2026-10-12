/**
 * 章纲员（2026-10-12 编辑部第 3 步）：从第 1 章起一章一章跟读的责任编辑，为下一章拟章纲。
 *
 * 拟第 N 章时，在「读完第 N-1 章」那一刻的窗口后面接上：作者给的方向（可为空）+ 现有拟章纲的章纲 JSON 要求
 * （和旧路 plan-chapter 的 buildPlanMessages 同一份文本——改提示词必须两条路一起在题库上比分）。
 * 输出结构和旧路完全一样：照用 normalizeChapterPlan 宽进归一 + reconcileStoryDay 天数归一，落盘 drafts/plans/。
 * 比旧路强在：窗口里是读过的全书原文和它自己的笔记（主线 / 想要什么 / 钩子 / 节奏），不靠拼一包检索材料。
 */
import { normalizeChapterPlan, writeChapterPlan, type ChapterPlan } from "@actalk/story-engine";
import { resolveConfiguredChatModel, streamChatModelToText, ThinkingTooLongError } from "../lib/llm-client.js";
import { withStep } from "../lib/token-meter.js";
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
} from "../agent/chapter-plan/plan-chapter.js";
import { ensureReaderWindow, type BrainCallModel, type BrainMessage, type ReaderRole } from "./reader-window.js";
import type { PlanProblem } from "./checker.js";

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
};

/** 拟章纲失败（模型挂了 / 不是 JSON / 缺要点）自动再试的次数（同旧路）。 */
const PLAN_RETRIES = 1;
/** 拟章纲「光想不写」的上限：超过就改用关思考重拟（同旧路 PLAN_MAX_THINKING_MS，别两处改出不一样的数）。 */
const PLAN_MAX_THINKING_MS = 150_000;

export type PlanChapterByPlannerResult =
  | { readonly ok: true; readonly plan: ChapterPlan }
  | { readonly ok: false; readonly reason: string; readonly skipped?: "not_ready" };

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
 * 补笔记太多 → skipped:"not_ready"（调用方这次走旧路，笔记在后台补）；拟不成 → ok:false + 原因，不抛、不落盘。
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
  try {
    const ready = await withStep("跟读补笔记", () => ensureReaderWindow({
      projectDir: input.projectDir,
      role: PLANNER_ROLE,
      upTo: input.chapter - 1,
      callModel: input.callModel,
      ...(input.notesRoot ? { notesRoot: input.notesRoot } : {}),
      ...(input.maxCatchUp !== undefined ? { maxCatchUp: input.maxCatchUp } : {}),
      ...(input.onProgress ? { onProgress: input.onProgress } : {}),
    }));
    if (ready.missing > 0) {
      return { ok: false, skipped: "not_ready", reason: `章纲员要补的读书笔记超过 ${input.maxCatchUp} 章` };
    }
    window = ready.messages;
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
      const plan = normalizeChapterPlan(raw, {
        chapter: input.chapter,
        source: "model",
        ...(input.direction?.trim() ? { direction: input.direction } : {}),
        ...(input.now ? { now: input.now } : {}),
      });
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
      return { ok: true, plan: await finalizePlan(input.projectDir, plan, dayOffset, materials) };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  if (skeleton) return { ok: true, plan: await finalizePlan(input.projectDir, skeleton.plan, skeleton.dayOffset, materials) };
  return { ok: false, reason: `章纲没拟成（已自动重试一次）：${lastError || "模型没有返回可用内容"}` };
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

/** 把核账员审出的问题交回章纲员窗口的那条任务消息：只改有问题的要点，其余逐字照抄。 */
export function reviseTask(chapter: number, plan: ChapterPlan, problems: readonly PlanProblem[]): string {
  return [
    `你为第 ${chapter} 章拟的章纲，核账员审出 ${problems.length} 处和前文对不上：`,
    ...problems.map((problem, index) => `${index + 1}. 第 ${problem.point} 条要点「${problem.beat ?? plan.beats[problem.point - 1] ?? ""}」：和第 ${problem.earlierChapter} 章「${problem.earlierQuote}」对不上——${problem.reason}`),
    "按前文把有问题的那几条要点改对（东西在谁手里就照前文安排、日子照前文算、人物还不知道的就改成他不知道），其余内容逐字照抄原章纲；改过的要点保持原来的长短，不要借机添细节。",
    `只输出修正后的完整章纲 JSON（字段同原来）：\n${PLAN_JSON_FIELDS}`,
    `【原章纲（第 ${chapter} 章）】\n${JSON.stringify(planJson(plan), null, 1)}`,
  ].join("\n\n");
}

/** 审章纲结果：earlierQuote 逐字核对过（代码核），point 指 beats 的序号（1 起）。改一轮的结果，ok=false 时调用方用原章纲。 */
export type RevisePlanResult =
  | { readonly ok: true; readonly plan: ChapterPlan }
  | { readonly ok: false; readonly reason: string; readonly skipped?: "not_ready" };

/**
 * 核账员审出问题后，把问题列表交回章纲员窗口改一轮（只改有问题的要点，不循环）。
 * 模型常只回 summary + beats：缺的栏一律沿用原章纲；avoid 取并集；天数原章纲有就不许改丢。改不成 → ok:false，调用方用原章纲。
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
  try {
    const ready = await withStep("跟读补笔记", () => ensureReaderWindow({
      projectDir: input.projectDir,
      role: PLANNER_ROLE,
      upTo: input.chapter - 1,
      callModel: input.callModel,
      ...(input.notesRoot ? { notesRoot: input.notesRoot } : {}),
      ...(input.maxCatchUp !== undefined ? { maxCatchUp: input.maxCatchUp } : {}),
    }));
    if (ready.missing > 0) return { ok: false, skipped: "not_ready", reason: `章纲员要补的读书笔记超过 ${input.maxCatchUp} 章` };
    window = ready.messages;
  } catch (error) {
    return { ok: false, reason: `章纲员读前文没成：${error instanceof Error ? error.message : String(error)}` };
  }
  let raw: Record<string, unknown>;
  try {
    const text = await withStep("章纲员改纲", () => input.callModel(
      [...window, { role: "user", content: reviseTask(input.chapter, input.plan, input.problems) }],
      { json: true },
    ));
    raw = parsePlanJson(text) as Record<string, unknown>;
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  const revised = normalizeChapterPlan(raw, {
    chapter: input.chapter,
    source: input.plan.source,
    ...(input.plan.direction ? { direction: input.plan.direction } : {}),
    ...(input.now ? { now: input.now } : {}),
  });
  if (!revised) return { ok: false, reason: "修正章纲不完整（缺要点）" };
  const keep = <T,>(next: readonly T[], previous: readonly T[]): readonly T[] => (next.length > 0 ? next : previous);
  const location = revised.scene.location ?? input.plan.scene.location;
  const time = revised.scene.time ?? input.plan.scene.time;
  const merged: ChapterPlan = {
    ...revised,
    newInformation: keep(revised.newInformation, input.plan.newInformation),
    characters: keep(revised.characters, input.plan.characters),
    entities: keep(revised.entities, input.plan.entities),
    threadsAdvanced: keep(revised.threadsAdvanced, input.plan.threadsAdvanced),
    scene: { ...(location ? { location } : {}), ...(time ? { time } : {}) },
    avoid: [...new Set([...revised.avoid, ...input.plan.avoid])],
    // 天数：改纲不该动日历——原章纲有天数就沿用；没有（或改纲给了新的）交给 reconcileStoryDay 归一。
    ...(input.plan.storyDay !== undefined && revised.storyDay === undefined ? { storyDay: input.plan.storyDay } : {}),
  };
  const dayOffset = readDayOffset(raw);
  const lastDay = await previousChapterEndDay(input.projectDir, input.chapter);
  const settled = input.plan.storyDay !== undefined && revised.storyDay === undefined
    ? { ...merged, storyDay: reconcileStoryDay(merged, dayOffset, lastDay).storyDay ?? input.plan.storyDay }
    : reconcileStoryDay(merged, dayOffset, lastDay);
  await writeChapterPlan(input.projectDir, settled);
  return { ok: true, plan: settled };
}
