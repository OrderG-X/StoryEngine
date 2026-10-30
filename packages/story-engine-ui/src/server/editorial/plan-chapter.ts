/**
 * 拟章纲编排（resolveChapterPlanForDraft）：章纲员窗口拟纲（planner.ts）→ 核账员窗口审纲（checker.ts）
 * → 有问题交回章纲员改一轮（不循环）。材料和天数归一这些纯函数在 plan-materials.ts。
 */
import { basisDigestBefore, canonicalJson, sha256 } from "@actalk/story-core";
import { readChapterPlan, type ChapterPlan } from "../book/chapter-plan.js";
import { readStoryViews } from "../book/story-views.js";
import {
  callConfiguredBrainModel,
  callConfiguredPlannerModel,
  checkPlanByReader,
  coldPausedNote,
  describeReaderWait,
  planChapterByPlanner,
  revisePlanByPlanner,
  type BrainCallModel,
  type PlanProblem,
} from "./index.js";
import { containsQuote, normalize } from "./continuity/check-chapter.js";
import { collectPlanMaterials } from "./plan-materials.js";
import { withStep } from "../lib/token-meter.js";
import { requestReaderBackfill } from "../lib/reader-backfill.js";
import { readWithStableBasisForWork } from "../book/truth-basis.js";

export interface ResolvedChapterPlan {
  readonly plan?: ChapterPlan;
  /** 给作者看的一句话：章纲是什么 / 为什么没有。 */
  readonly note: string;
  /** 沿用了这章已有的章纲（同一方向重写时不重拟）。 */
  readonly reused: boolean;
  /** 新拟的这份要落盘（只在内存里拟，落盘由调用方定：出稿操作走核心 plan.save）。沿用的、没拟成的没有。 */
  readonly save?: true;
}

/** 章纲员 / 核账员审纲当场最多补多少章笔记；超过就如实说「还在读前文」，笔记在后台补，这次不硬等。 */
export const PLANNER_MAX_CATCH_UP = 10;

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
  readonly maxCatchUp?: number;
  readonly maxVolumeBuilds?: number;
}, direction: string): Promise<ResolvedChapterPlan> {
  const plannerCallModel = input.plannerCallModel ?? callConfiguredPlannerModel;
  const maxCatchUp = input.maxCatchUp ?? PLANNER_MAX_CATCH_UP;
  const volumes = input.maxVolumeBuilds !== undefined ? { maxVolumeBuilds: input.maxVolumeBuilds } : {};
  const planned = await withStep("拟", () => planChapterByPlanner({
    projectDir: input.projectDir,
    chapter: input.chapter,
    ...(direction ? { direction } : {}),
    callModel: plannerCallModel,
    maxCatchUp,
    ...volumes,
  }));
  if (!planned.ok) return { note: `${planned.reason}；这次按没有章纲出稿。`, reused: false };
  // 等读那一句（R5.2 必做 2）：拟纲前先等章纲员当场补了笔记，如实说补了哪几章、花了多久。
  const planWaitNote = planned.waited ? `（${describeReaderWait("planner", planned.waited, "拟纲")}。）` : "";
  // 冷窗口拟纲：章纲员还没读完全书（拟是照已有笔记 + 最近 K 章原文拟的），笔记后台接着补。
  // （R5.2 试过「缺 3～8 章不等、缺口补全时改说直接对照原文」——大考卷比分输了，已删，只留等读标注，
  //   数字见 scripts/eval/results/r52-cold-gap-*.json。）
  let planColdNote = "";
  if (planned.cold) {
    requestReaderBackfill(input.projectDir, { roles: ["planner"], upTo: input.chapter - 1 });
    planColdNote = `章纲员还没读完全书（第 ${planned.cold.notedThrough} / ${input.chapter - 1} 章），这次按${
      [
        ...(planned.cold.notedThrough > 0 ? ["已读笔记"] : []),
        ...(planned.cold.rawTo > 0 ? [`第 ${planned.cold.rawFrom}～${planned.cold.rawTo} 章原文`] : []),
      ].join(" + ")
    }拟的纲，更早的细节可能漏。${coldPausedNote(planned.cold)}`;
  }
  // 动笔前核账员先审章纲：它读过前文，找章纲里和前文对不上的要点（照片那种：第 5 章已带回家，章纲又安排来取）。
  const checkCallModel = input.planCheckReaderCallModel ?? callConfiguredBrainModel;
  const checked = await withStep("审", () => checkPlanByReader({
    projectDir: input.projectDir,
    plan: planned.plan,
    callModel: checkCallModel,
    maxCatchUp,
    ...volumes,
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
    requestReaderBackfill(input.projectDir, { roles: ["checker"], upTo: input.chapter - 1 });
    checkColdNote = `核账员还没读完全书（第 ${checked.cold.notedThrough} / ${input.chapter - 1} 章），这次按${coldBasis(checked.cold)}审的纲，更早的细节可能漏。${coldPausedNote(checked.cold)}`;
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
    maxCatchUp,
    ...volumes,
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
 * 章纲依赖的前文指纹（写作版本 P1a 起用真相依据）：拟纲实际读的那份材料（collectPlanMaterials：设定摘要、前一章、
 * 最近几章正文、前几章章纲的要点和时间、线索、事实……）+ 前面各章正文和账、作者裁定、设定卡的内容摘要 + 前面各章是哪天。
 * 前几章的章纲不在真相里，改了它也得重拟（P1a 复核）。材料夹在两次读依据之间读，中途书上有写就不给指纹。
 * 读不了 → undefined：不沿用，拟出来的也不记指纹。
 */
export async function planBasisOf(projectDir: string, chapter: number, direction?: string): Promise<string | undefined> {
  return (await readPlanBasis(projectDir, chapter, direction))?.key;
}

/**
 * key 是存进章纲的指纹（只看内容：撤销回到同样的前文还能沿用）；digest 是这次读时整本书的依据（带写入代次）。
 * 拟纲前后比两样：内容一样但中途书上有过写（比如 A→B→撤销回 A，章纲员读到的可能是 B），也不挂指纹（P1a 第 2 轮复核）。
 */
async function readPlanBasis(projectDir: string, chapter: number, direction?: string): Promise<{ readonly key: string; readonly digest: string } | undefined> {
  try {
    const read = await readWithStableBasisForWork(projectDir, async () => ({
      materials: await collectPlanMaterials(projectDir, chapter, direction || undefined),
      timeline: (await readStoryViews(projectDir)).timeline.entries.filter((entry) => entry.chapter < chapter),
    }));
    if (!read.basis) return undefined;
    return { key: sha256(canonicalJson({ truth: basisDigestBefore(read.basis, chapter), ...read.value })), digest: read.basis.digest };
  } catch {
    return undefined;
  }
}

async function existingPlanState(projectDir: string, chapter: number, direction: string) {
  const existing = await readChapterPlan(projectDir, chapter).catch(() => undefined);
  return { existing, start: await readPlanBasis(projectDir, chapter, direction) };
}

/** 作者方向没变（同为空或原话相同），而且是作者给的、或拟纲后前文没改。 */
function reusable(existing: ChapterPlan, direction: string, basis: string | undefined): boolean {
  return (existing.direction ?? "") === direction && (existing.source === "author" || (basis !== undefined && existing.basis === basis));
}

/** 这次出稿会不会沿用本章已有章纲（出稿操作据此定要不要先让章纲员读前文；拟纲那步还会再判一次）。 */
export async function chapterPlanReusable(projectDir: string, chapter: number, direction?: string): Promise<boolean> {
  const trimmed = direction?.trim() ?? "";
  const { existing, start } = await existingPlanState(projectDir, chapter, trimmed);
  return existing !== undefined && reusable(existing, trimmed, start?.key);
}

/**
 * 出稿前拿到本章章纲：这章已有章纲、作者方向没变（同为空或原话相同）、拟纲后前文也没改 → 沿用（「重写这一章」保持同一份章纲）；
 * 否则编辑部重拟。前文改过（定论、改了前面哪章、记了裁定）还沿用，章纲就可能和前文对不上又没人审（外部审查 2026-10-28）。
 * 作者给的章纲照旧沿用。拟不成 → plan 缺省 + 如实说明，出稿照旧路径走，绝不阻断出稿。
 * 只在内存里拟、审、改（写作版本 P2a 3.1）：新拟的带 save，调用方落盘。
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
  /** 章纲员、核账员当场最多补几章笔记（出稿操作给 0：笔记在 notes 那一步补过了）；缺省 10。 */
  readonly maxCatchUp?: number;
  /** 当场最多新生成几个卷节点（出稿操作给 0）；缺省不限。 */
  readonly maxVolumeBuilds?: number;
}): Promise<ResolvedChapterPlan> {
  const direction = input.direction?.trim() ?? "";
  const { existing, start } = await existingPlanState(input.projectDir, input.chapter, direction);
  const basis = start?.key;
  const sameDirection = existing !== undefined && (existing.direction ?? "") === direction;
  if (existing && reusable(existing, direction, basis)) {
    return { plan: existing, note: `沿用本章已有章纲：${existing.summary}${directionChangeNote(existing)}`, reused: true };
  }
  const planned = await planByEditorialRoom(input, direction);
  if (!planned.plan) return planned;
  // 拟完再读一遍：拟纲那段时间里材料没变、书上也没写过，这份章纲才挂指纹（变了就不挂，下次重拟）。
  const end = start ? await readPlanBasis(input.projectDir, input.chapter, direction) : undefined;
  const plan = basis && end?.key === basis && end.digest === start?.digest ? { ...planned.plan, basis } : planned.plan;
  const staleNote = sameDirection && existing.basis !== undefined && basis !== undefined ? "前文改过，章纲按现在的重拟了。" : "";
  return { ...planned, plan, save: true, note: `${staleNote}${planned.note}${directionChangeNote(plan)}` };
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
