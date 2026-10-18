/**
 * 拟章纲编排（resolveChapterPlanForDraft）：章纲员窗口拟纲（planner.ts）→ 核账员窗口审纲（checker.ts）
 * → 有问题交回章纲员改一轮（不循环）。材料和天数归一这些纯函数在 plan-materials.ts。
 */
import { readChapterPlan, type ChapterPlan } from "../book/chapter-plan.js";
import {
  callConfiguredBrainModel,
  callConfiguredPlannerModel,
  catchUpReaders,
  checkPlanByReader,
  describeReaderWait,
  planChapterByPlanner,
  revisePlanByPlanner,
  type BrainCallModel,
  type PlanProblem,
} from "./index.js";
import { containsQuote, normalize } from "./continuity/check-chapter.js";
import { withStep } from "../lib/token-meter.js";

export interface ResolvedChapterPlan {
  readonly plan?: ChapterPlan;
  /** 给作者看的一句话：章纲是什么 / 为什么没有。 */
  readonly note: string;
  /** 沿用了这章已有的章纲（同一方向重写时不重拟）。 */
  readonly reused: boolean;
}

/** 章纲员 / 核账员审纲当场最多补多少章笔记；超过就如实说「还在读前文」，笔记在后台补，这次不硬等。 */
const PLANNER_MAX_CATCH_UP = 10;

/**
 * 编辑部拟章纲：章纲员窗口拟纲 → 核账员窗口审纲 → 有问题交回章纲员改一轮（不循环）。
 * R4.4 冷窗口兜底：章纲员 / 核账员还没读完全书（要补的笔记太多）不再「按没有章纲出稿」——
 * 拿已有笔记 + 最近 K 章原文照拟照审，note 里如实标「这次对照了多少」，笔记在后台接着补，读齐自动回正常路。
 */
async function planByEditorialRoom(input: {
  readonly projectDir: string;
  readonly chapter: number;
  readonly direction?: string;
  readonly plannerCallModel?: BrainCallModel;
  readonly planCheckReaderCallModel?: BrainCallModel;
}, direction: string): Promise<ResolvedChapterPlan> {
  const plannerCallModel = input.plannerCallModel ?? callConfiguredPlannerModel;
  const planned = await withStep("拟", () => planChapterByPlanner({
    projectDir: input.projectDir,
    chapter: input.chapter,
    ...(direction ? { direction } : {}),
    callModel: plannerCallModel,
    maxCatchUp: PLANNER_MAX_CATCH_UP,
  }));
  if (!planned.ok) return { note: `${planned.reason}；这次按没有章纲出稿。`, reused: false };
  // 等读那一句（R5.2 必做 2）：拟纲前先等章纲员当场补了笔记，如实说补了哪几章、花了多久。
  const planWaitNote = planned.waited ? `（${describeReaderWait("planner", planned.waited, "拟纲")}。）` : "";
  // 冷窗口拟纲：章纲员还没读完全书（拟是照已有笔记 + 最近 K 章原文拟的），笔记后台接着补。
  // （R5.2 试过「缺 3～8 章不等、缺口补全时改说直接对照原文」——大考卷比分输了，已删，只留等读标注，
  //   数字见 scripts/eval/results/r52-cold-gap-*.json。）
  let planColdNote = "";
  if (planned.cold) {
    void catchUpReaders(input.projectDir, input.chapter - 1, { callModel: plannerCallModel });
    planColdNote = `章纲员还没读完全书（第 ${planned.cold.notedThrough} / ${input.chapter - 1} 章），这次按${
      [
        ...(planned.cold.notedThrough > 0 ? ["已读笔记"] : []),
        ...(planned.cold.rawTo > 0 ? [`第 ${planned.cold.rawFrom}～${planned.cold.rawTo} 章原文`] : []),
      ].join(" + ")
    }拟的纲，更早的细节可能漏。`;
  }
  // 动笔前核账员先审章纲：它读过前文，找章纲里和前文对不上的要点（照片那种：第 5 章已带回家，章纲又安排来取）。
  const checkCallModel = input.planCheckReaderCallModel ?? callConfiguredBrainModel;
  const checked = await withStep("审", () => checkPlanByReader({
    projectDir: input.projectDir,
    plan: planned.plan,
    callModel: checkCallModel,
    maxCatchUp: PLANNER_MAX_CATCH_UP,
  }));
  const brief = (lines: readonly string[]) => `${lines.slice(0, 2).join("；")}${lines.length > 2 ? "等" : ""}`;
  const coldBasis = (cold: { readonly notedThrough: number; readonly rawFrom: number; readonly rawTo: number }): string =>
    [
      ...(cold.notedThrough > 0 ? ["已读笔记"] : []),
      ...(cold.rawTo > 0 ? [`第 ${cold.rawFrom}～${cold.rawTo} 章原文`] : []),
    ].join(" + ");
  // 等读那一句（R5.2）：审纲前先等核账员当场补了笔记。
  const checkWaitNote = checked.waited ? `（${describeReaderWait("checker", checked.waited, "审章纲")}。）` : "";
  // 冷窗口审纲：核账员还没读完全书，这次按已有笔记 + 最近 K 章原文审的，笔记后台接着补（点名 checker）。
  let checkColdNote = "";
  if (checked.cold) {
    void catchUpReaders(input.projectDir, input.chapter - 1, { callModel: checkCallModel, roles: ["checker"] });
    checkColdNote = `核账员还没读完全书（第 ${checked.cold.notedThrough} / ${input.chapter - 1} 章），这次按${coldBasis(checked.cold)}审的纲，更早的细节可能漏。`;
  }
  const coldNote = [planColdNote, checkColdNote].filter(Boolean).map((note) => `（${note}）`).join("");
  const waitNote = `${planWaitNote}${checkWaitNote}`;
  if (checked.failures.length > 0) {
    return { plan: planned.plan, note: `本章章纲：${planned.plan.summary}（章纲审校这次没跑成：${checked.failures[0]}）${coldNote}${waitNote}`, reused: false };
  }
  if (checked.problems.length === 0) {
    return { plan: planned.plan, note: `本章章纲：${planned.plan.summary}${coldNote}${waitNote}`, reused: false };
  }
  // R7.5 作者方向和前文既成事实对不上（authorWilled）：不自动改——改了等于替作者改主意，回执问以哪个为准。
  // 只有章纲员自己拟错的（非 authorWilled）才交回改一轮；全是作者方向时连改纲那一步都省了。
  // 作者这章没给方向（比如点「写下一章」）时，要点不可能「来自作者方向」：模型标的 authorWilled 不作数，全交章纲员改。
  const hasDirection = direction.trim().length > 0;
  // 章纲员已声明改掉的方向原话（directionChanges），审纲再拿方向原话报「和前文对不上」就是重复：回执已说「章纲改成了…」，
  // 再问「这次先照你的方向出稿」自相矛盾（P7 GLM 复跑三次里两次这样）。核账员抄的方向原话落在已声明的那句里就不再问。
  const declared = (planned.plan.directionChanges ?? []).map((change) => normalize(change.said));
  const alreadyChanged = (problem: PlanProblem) => problem.directionQuote !== undefined
    && declared.some((said) => containsQuote(said, problem.directionQuote!) || containsQuote(normalize(problem.directionQuote!), said));
  const asked = hasDirection ? checked.problems.filter((problem) => problem.authorWilled && !alreadyChanged(problem)) : [];
  const autoFix = hasDirection ? checked.problems.filter((problem) => !problem.authorWilled) : checked.problems;
  const short = (text: string) => (text.length > 30 ? `${text.slice(0, 30)}…` : text);
  const askSentence = asked.length > 0
    ? `你给的方向里「${short(asked[0]!.directionQuote ?? asked[0]!.beat ?? planned.plan.beats[asked[0]!.point - 1] ?? "")}」和第 ${asked[0]!.earlierChapter} 章「${short(asked[0]!.earlierQuote)}」对不上——以哪个为准？这次先照你的方向出稿；要按前文的话说一声，我改这条要点。`
    : "";
  if (autoFix.length === 0) {
    if (asked.length === 0) return { plan: planned.plan, note: `本章章纲：${planned.plan.summary}${coldNote}${waitNote}`, reused: false };
    return { plan: planned.plan, note: `本章章纲：${planned.plan.summary}（核账员审出 ${asked.length} 处和前文对不上，都来自你给的方向：${askSentence}）${coldNote}${waitNote}`, reused: false };
  }
  // 有问题：把问题列表交回章纲员窗口，只改有问题的要点，改一轮、不循环。改不成就用原章纲（如实说明）。
  const revised = await withStep("改", () => revisePlanByPlanner({
    projectDir: input.projectDir,
    chapter: input.chapter,
    plan: planned.plan,
    problems: autoFix,
    callModel: plannerCallModel,
    maxCatchUp: PLANNER_MAX_CATCH_UP,
  }));
  if (revised.ok) {
    const reviseColdNote = revised.cold && !planned.cold ? "（改纲这次按最近几章原文改的。）" : "";
    const reviseWaitNote = revised.waited && !planned.waited ? `（${describeReaderWait("planner", revised.waited, "改章纲")}。）` : "";
    return {
      plan: revised.plan,
      note: `本章章纲：${revised.plan.summary}（核账员审出 ${checked.problems.length} 处和前文对不上，已让章纲员改掉 ${autoFix.length} 处：${brief(autoFix.map((problem) => problem.reason))}${askSentence ? `；另有 ${asked.length} 处来自你给的方向：${askSentence}` : ""}）${coldNote}${reviseColdNote}${waitNote}${reviseWaitNote}`,
      reused: false,
    };
  }
  return {
    plan: planned.plan,
    note: `本章章纲：${planned.plan.summary}（核账员审出 ${checked.problems.length} 处和前文对不上，但改章纲没成：${revised.reason}。${askSentence ? `另有 ${asked.length} 处来自你给的方向：${askSentence}` : ""}）${coldNote}${waitNote}`,
    reused: false,
  };
}

/**
 * 出稿前拿到本章章纲：这章已有章纲、且作者方向没变（同为空或原话相同）→ 沿用（「重写这一章」保持同一份章纲）；
 * 否则编辑部重拟。拟不成 → plan 缺省 + 如实说明，出稿照旧路径走，绝不阻断出稿。
 */
export async function resolveChapterPlanForDraft(input: {
  readonly projectDir: string;
  readonly chapter: number;
  /** 作者这章的方向原话；没给 = 章纲员按现状自己拟。 */
  readonly direction?: string;
  /** 章纲员那一路的模型调用（测试注入）；缺省走 chapterSteering 槽（思考开关随作者的任务设置）。 */
  readonly plannerCallModel?: BrainCallModel;
  /** 核账员审章纲的模型调用（测试注入）；缺省走 qualityCheck 槽。 */
  readonly planCheckReaderCallModel?: BrainCallModel;
}): Promise<ResolvedChapterPlan> {
  const direction = input.direction?.trim() ?? "";
  const existing = await readChapterPlan(input.projectDir, input.chapter).catch(() => undefined);
  if (existing && (existing.direction ?? "") === direction) {
    return { plan: existing, note: `沿用本章已有章纲：${existing.summary}${directionChangeNote(existing)}`, reused: true };
  }
  const planned = await planByEditorialRoom(input, direction);
  return planned.plan ? { ...planned, note: `${planned.note}${directionChangeNote(planned.plan)}` } : planned;
}

/** 章纲员没照方向原话安排的地方，回执如实告诉作者（P7：方向里的「铜盒」被悄悄改成「怀表」，作者不知道）。 */
function directionChangeNote(plan: ChapterPlan): string {
  const changes = plan.directionChanges ?? [];
  if (changes.length === 0) return "";
  const first = changes[0]!;
  const more = changes.length > 1 ? `（另有 ${changes.length - 1} 处）` : "";
  const why = first.why.replace(/[。．.；;，,\s]+$/u, ""); // 不猜白名单：切句
  return `（你给的方向里「${first.said}」和前文对不上：${why}。章纲改成了「${first.changedTo}」${more}；要照你原话写就说一声。）`;
}
