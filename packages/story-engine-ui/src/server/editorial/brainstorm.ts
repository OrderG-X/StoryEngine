/**
 * 头脑风暴（重构 P6 第 5 步，草图 ⑤）：章纲员出几种走法，核账员替每种对过前文，作者挑一种。
 *
 *  - 章纲员：在「读完第 N-1 章」的窗口后面接「给三种不同的走法」（作者的想法可有可无），
 *    每种 3 步 + 推进了哪些开着的线索（只许填线索编号，代码换成名字，不认识的丢掉）。
 *  - 核账员：一次核完几种走法的每一步（互相替代、不用彼此对得上），前文原句由代码逐字核对（同审章纲）。
 *  - 只读：不落章纲、不进账。作者挑中的那种之后作为「这章的方向」交给写这一章；没挑中的不留痕。
 */
import { projectBook, type ThreadView } from "@actalk/story-core";
import { withStep } from "../lib/token-meter.js";
import { canCallAgain } from "../lib/llm-client.js";
import { rethrowIfStopped } from "../lib/operations/context.js";
import { coreSnapshotFor } from "../lib/snapshot.js";
import { ensureBookOnCore } from "../book/mirror/ensure.js";
import { readEarlierChapters, type EarlierText } from "./continuity/check-chapter.js";
import { collectPlanMaterials, OPENING_PLAN_NOTE, planMaterialBlocks } from "./plan-materials.js";
import { buildColdReaderWindow, ensureReaderWindow, type BrainCallModel, type BrainMessage, type ColdCoverage, type ReaderRole } from "./reader-window.js";
import { readerWaitingHandlers } from "./reader-progress.js";
import { PLANNER_ROLE } from "./planner.js";
import { CHECKER_ROLE, parsePlanProblems } from "./checker.js";

/** 出几种走法。 */
export const BRAINSTORM_OPTIONS = 3;
/** 每种最多几步（模型多写了截掉）。 */
const MAX_STEPS = 5;
/** 每种最多带几条推进的线索（模型多列了只留前几条）。 */
const MAX_ADVANCED = 3;
/** 提示里最多列几条开着的线索（分量重、停得久的在前）。 */
const MAX_THREADS_IN_PROMPT = 40;
/** 拟走法失败（不是 JSON / 能用的走法不够）自动再试的次数。 */
const RETRIES = 1;
/** 当场最多补几章笔记；超过就按冷窗口（已有笔记 + 最近几章原文）想，同拟章纲。 */
const MAX_CATCH_UP = 10;

const WEIGHT_RANK: Record<ThreadView["weight"], number> = { major: 0, normal: 1, minor: 2 };

export interface BrainstormThread {
  readonly id: string;
  readonly title: string;
  /** 停了几章没动（算到的章 − 最近一笔）。 */
  readonly idle: number;
  readonly stale: boolean;
  readonly weight: ThreadView["weight"];
}

export interface BrainstormProblem {
  /** 这种走法的第几步（1 起）。 */
  readonly step: number;
  readonly earlierChapter: number;
  /** 前文原句（代码核对过真在那章里）。 */
  readonly earlierQuote: string;
  readonly reason: string;
}

export interface BrainstormOption {
  readonly title: string;
  readonly steps: readonly string[];
  readonly recommended?: true;
  /** 推进了哪些开着的线索（名字，不带编号）。 */
  readonly threads: readonly { readonly title: string; readonly idle: number; readonly stale: boolean }[];
  readonly problems: readonly BrainstormProblem[];
}

export type BrainstormResult =
  | {
    readonly ok: true;
    readonly chapter: number;
    readonly idea?: string;
    readonly options: readonly BrainstormOption[];
    /** 核账员核过前文没有；没核成时 checkNote 说原因。 */
    readonly checked: boolean;
    readonly checkNote?: string;
    /** 前面还没有定稿的章（新书第一章）：没前文可对，核账员不核。 */
    readonly nothingEarlier?: true;
    /** 章纲员 / 核账员还没读完全书，这次按已有笔记 + 最近几章原文想的。 */
    readonly coldNote?: string;
  }
  | { readonly ok: false; readonly reason: string };

/** 开着的线索（新核心投影）：分量重的先、停得久的先。书还没接到新格式上就没有（不挡头脑风暴）。 */
export async function readOpenThreads(projectDir: string): Promise<readonly BrainstormThread[]> {
  try {
    const onCore = await ensureBookOnCore(projectDir, { snapshot: coreSnapshotFor(projectDir) });
    if (!onCore.ok) return [];
    const projection = await projectBook(projectDir);
    return projection.threads
      .filter((thread) => thread.status !== "closed")
      .map((thread) => ({
        id: thread.id,
        title: thread.title,
        idle: Math.max(0, projection.upTo - thread.lastTouchedAt),
        stale: thread.status === "stale",
        weight: thread.weight,
      }))
      .sort((a, b) => WEIGHT_RANK[a.weight] - WEIGHT_RANK[b.weight] || b.idle - a.idle || a.id.localeCompare(b.id));
  } catch {
    return [];
  }
}

/** 章纲员那条任务消息：账本材料（不带它读过的原文）+ 带编号的开着的线索 + 要求。 */
export function brainstormTask(input: {
  readonly chapter: number;
  readonly materialBlocks: readonly string[];
  readonly threads: readonly BrainstormThread[];
  readonly idea?: string;
  readonly avoid?: readonly string[];
}): string {
  const threads = input.threads.slice(0, MAX_THREADS_IN_PROMPT);
  const idea = input.idea?.trim();
  // 第 1 章前面没有正文：别说「跟读到第 0 章」「接住第 0 章的结尾」（换题材长篇实跑 2026-10-27）。
  const opening = input.chapter <= 1;
  return [
    opening
      ? `这是全书第 1 章，前面还没有正文。作者在想第 1 章怎么开篇，请你给 ${BRAINSTORM_OPTIONS} 种不同的开法让他挑（几种是互相替代的，作者只会用一种）。只输出一个 JSON，不要解释、不要 Markdown。`
      : `你已经从第 1 章跟读到了第 ${input.chapter - 1} 章（见上面的原文和你的笔记）。作者在想第 ${input.chapter} 章往哪走，请你给 ${BRAINSTORM_OPTIONS} 种不同的走法让他挑（几种是互相替代的，作者只会用一种）。只输出一个 JSON，不要解释、不要 Markdown。`,
    ...input.materialBlocks,
    threads.length > 0
      ? `【开着的线索（编号｜线索｜停了几章）】\n${threads.map((thread) => `${thread.id}｜${thread.title}｜${thread.idle > 0 ? `停了 ${thread.idle} 章` : "刚动过"}${thread.weight === "major" ? "｜大伏笔" : ""}`).join("\n")}`
      : "【开着的线索】没有。",
    ...(input.avoid && input.avoid.length > 0 ? [`【这几种已经给过作者了，别再出一样的】${input.avoid.join("；")}`] : []),
    [
      "要求：",
      opening
        ? `- ${BRAINSTORM_OPTIONS} 种都从故事的开头写起，彼此要真不一样：开场的事、先露的线索不同；别只是换个说法。${OPENING_PLAN_NOTE}`
        : `- ${BRAINSTORM_OPTIONS} 种都接住第 ${input.chapter - 1} 章的结尾，彼此要真不一样：推进不同的线索，或者同一条线索走不同的方向；别只是换个说法。`,
      // 换题材长篇实跑 2026-10-27：作者说「不碰催收和陆生」，三种里还有一种写了欠债和那通催收电话。
      ...(idea ? ["- 作者给了想法：每种都照他的想法走，只是走法不同；他说了这章不碰、不写的事，哪一种都别碰，threads 也别挑那几条。"] : []),
      "- 每种 3 步，每步一句话、不超过 30 个字，写具体的事（谁、做了什么、结果怎样），不写「推动剧情」「制造悬念」这类空话；对白、细节留给正文。",
      "- 和前文对不上的不要出：东西在谁手上、人在哪、谁知道什么、过了几天。受保护的秘密不要揭开。",
      "- threads 填这种走法主要推进的开着的线索编号，最多 3 条（只从上面的列表里挑，没有就给空数组）。",
      "- 挑一种你最推荐的，recommended 写 true，其余写 false。",
      "- title 四到八个字，说清这种走法是什么。",
    ].join("\n"),
    `JSON：{"options":[{"title":"","steps":["","",""],"threads":["编号"],"recommended":false}]}`,
  ].join("\n\n");
}

function parseJsonObject(text: string): Record<string, unknown> {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("走法不是 JSON");
  const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("走法不是 JSON 对象");
  return parsed as Record<string, unknown>;
}

/** 结构化布尔：只认 true / "true"（大小写不限）；别的当没给。 */
function isTrue(value: unknown): boolean {
  return value === true || (typeof value === "string" && value.trim().toLowerCase() === "true");
}

function readStrings(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

/**
 * 解析章纲员的走法：名字和步骤都要有；线索只认列表里的编号（换成名字，不认识的丢掉，绝不把编号露给作者）；
 * 推荐只留第一个；同名的只留一个；最多 BRAINSTORM_OPTIONS 种。能用的不到 2 种算没拟成。
 */
export function parseBrainstorm(text: string, threads: readonly BrainstormThread[]): BrainstormOption[] {
  const parsed = parseJsonObject(text);
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const options: BrainstormOption[] = [];
  let recommendedTaken = false;
  for (const raw of Array.isArray(parsed.options) ? parsed.options : []) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    const title = typeof record.title === "string" ? record.title.trim() : "";
    const steps = readStrings(record.steps).slice(0, MAX_STEPS);
    if (!title || steps.length === 0) continue;
    if (options.some((option) => option.title === title)) continue;
    const seen = new Set<string>();
    const advanced = readStrings(record.threads)
      .map((id) => byId.get(id))
      .filter((thread): thread is BrainstormThread => {
        if (!thread || seen.has(thread.id)) return false;
        seen.add(thread.id);
        return true;
      })
      .slice(0, MAX_ADVANCED)
      .map((thread) => ({ title: thread.title, idle: thread.idle, stale: thread.stale }));
    const recommended = !recommendedTaken && isTrue(record.recommended);
    if (recommended) recommendedTaken = true;
    options.push({ title, steps, ...(recommended ? { recommended: true as const } : {}), threads: advanced, problems: [] });
    if (options.length >= BRAINSTORM_OPTIONS) break;
  }
  if (options.length < 2) throw new Error(`能用的走法只有 ${options.length} 种`);
  return options;
}

/** 核账员那条任务消息：几种走法的每一步按全局编号列出，逐条对照前文（输出同审章纲）。 */
export function brainstormCheckTask(chapter: number, options: readonly Pick<BrainstormOption, "title" | "steps">[]): string {
  let point = 0;
  const blocks = options.map((option, index) => [
    `【走法${index + 1}：${option.title}】`,
    ...option.steps.map((step) => `${(point += 1)}. ${step}`),
  ].join("\n"));
  return [
    `作者在想第 ${chapter} 章往哪走，章纲员给了下面几种走法（互相替代，作者只会挑一种，几种之间不用对得上），还没写正文。对照你读过的前文原文和笔记，逐条核对每一步和前文对不对得上：`,
    "- 谁手里有什么：物件此刻在哪、在谁手上，是不是安排拿错了、放错了、又交了一遍",
    "- 谁在哪：人物的位置和行程按前文接不接得上",
    "- 谁知道什么：安排人物说出或用到的信息，他按前文还不可能知道",
    "- 日子：时间和「几天后」按前文过了几天算得对不对",
    "每一步前面有编号。核对到的逐条列进 problems，每条判 conflict：true＝按前文不可能成立；false＝对得上或不构成矛盾（这一步本身安排了变化过程的不算）。",
    "conflict 为 true 的条目：point 写那一步的编号；earlierQuote 逐字抄前文和它冲突的那一句（抄不出原文的不要报）；earlierChapter 写那句在第几章；reason 一句话说哪里对不上。conflict 为 false 的条目：reason 一句话写核对结论，其余字段留空。",
    ...blocks,
    '只输出一个 JSON：{"problems":[{"point":1,"conflict":true,"earlierQuote":"","earlierChapter":1,"reason":""}]}；没有问题就给空数组。',
  ].join("\n\n");
}

/** 核账员的结果按全局编号分回各走法（第几种、第几步）。原句核对、自我否决过滤都沿用审章纲的解析。 */
export function splitBrainstormProblems(text: string, options: readonly BrainstormOption[], earlier: EarlierText): BrainstormOption[] {
  const flat = options.flatMap((option, optionIndex) => option.steps.map((step, stepIndex) => ({ step, optionIndex, stepIndex })));
  const problems = parsePlanProblems(text, { beats: flat.map((item) => item.step) }, earlier);
  const byOption = options.map(() => [] as BrainstormProblem[]);
  for (const problem of problems) {
    const at = flat[problem.point - 1];
    if (!at) continue;
    byOption[at.optionIndex]!.push({
      step: at.stepIndex + 1,
      earlierChapter: problem.earlierChapter,
      earlierQuote: problem.earlierQuote,
      reason: problem.reason,
    });
  }
  // 推荐是章纲员还没核前文时挑的：核出对不上的就不再标推荐（换题材长篇实跑 2026-10-27：推荐的那种恰好对不上）。
  return options.map((option, index) => {
    const problems = byOption[index]!;
    const { recommended, ...rest } = option;
    return { ...rest, ...(recommended && problems.length === 0 ? { recommended } : {}), problems };
  });
}

/** 读到第 upTo 章的跟读窗口：要补的笔记太多就用冷窗口（已有笔记 + 最近几章原文），同拟章纲 / 审章纲。 */
async function readerWindow(input: {
  readonly projectDir: string;
  readonly role: ReaderRole;
  readonly upTo: number;
  readonly callModel: BrainCallModel;
  readonly notesRoot?: string;
  readonly maxCatchUp?: number;
}): Promise<{ readonly messages: BrainMessage[]; readonly cold?: ColdCoverage }> {
  const root = input.notesRoot ?? input.projectDir;
  const waiting = readerWaitingHandlers(root, input.role.id, input.upTo);
  const ready = await withStep("跟读补笔记", () => ensureReaderWindow({
    projectDir: input.projectDir,
    role: input.role,
    upTo: input.upTo,
    callModel: input.callModel,
    ...(input.notesRoot ? { notesRoot: input.notesRoot } : {}),
    maxCatchUp: input.maxCatchUp ?? MAX_CATCH_UP,
    waitingAs: "想走法",
    onCatchUpBegin: waiting.onCatchUpBegin,
    onProgress: waiting.onProgress,
    onCatchUpEnd: waiting.onCatchUpEnd,
  }));
  if (ready.missing === 0) return { messages: ready.messages };
  const built = await buildColdReaderWindow({
    projectDir: input.projectDir,
    role: input.role,
    upTo: input.upTo,
    ...(input.notesRoot ? { notesRoot: input.notesRoot } : {}),
  });
  return { messages: built.messages, cold: built.coverage };
}

function coldText(who: string, cold: ColdCoverage, upTo: number): string {
  const basis = [
    ...(cold.notedThrough > 0 ? ["已读笔记"] : []),
    ...(cold.rawTo > 0 ? [`第 ${cold.rawFrom}～${cold.rawTo} 章原文`] : []),
  ].join(" + ");
  return `${who}还没读完全书（第 ${cold.notedThrough} / ${upTo} 章），这次按${basis}想的，更早的细节可能漏。`;
}

/**
 * 想第 N 章的几种走法：章纲员出、核账员核。只读（不落章纲、不进账）。
 * 章纲员没拟成 → ok:false + 原因；核账员没核成 → 照样给走法，checked:false 如实说没核。
 */
export async function brainstormChapter(input: {
  readonly projectDir: string;
  readonly chapter: number;
  /** 作者的想法原话；没给 = 按故事现状想。 */
  readonly idea?: string;
  /** 「再来几种」：已经给过的走法名字，别再出一样的。 */
  readonly avoid?: readonly string[];
  readonly callPlanner: BrainCallModel;
  readonly callChecker: BrainCallModel;
  readonly notesRoot?: string;
  readonly maxCatchUp?: number;
  /** 冷窗口时在后台接着补笔记（生产传 catchUpReaders）。 */
  readonly onCold?: (role: "planner" | "checker") => void;
  /** 读开着的线索（测试注入）；缺省读新核心投影。 */
  readonly readThreads?: (projectDir: string) => Promise<readonly BrainstormThread[]>;
}): Promise<BrainstormResult> {
  const upTo = input.chapter - 1;
  const idea = input.idea?.trim() || undefined;
  const windowInput = {
    projectDir: input.projectDir,
    upTo,
    ...(input.notesRoot ? { notesRoot: input.notesRoot } : {}),
    ...(input.maxCatchUp !== undefined ? { maxCatchUp: input.maxCatchUp } : {}),
  };

  let plannerWindow: Awaited<ReturnType<typeof readerWindow>>;
  try {
    plannerWindow = await readerWindow({ ...windowInput, role: PLANNER_ROLE, callModel: input.callPlanner });
  } catch (error) {
    return { ok: false, reason: `章纲员读前文没成：${error instanceof Error ? error.message : String(error)}` };
  }
  if (plannerWindow.cold) input.onCold?.("planner");

  const [threads, materials] = await Promise.all([
    (input.readThreads ?? readOpenThreads)(input.projectDir),
    collectPlanMaterials(input.projectDir, input.chapter, idea),
  ]);
  // 线索用新核心投影的（带编号、停了几章）；账本材料里旧的线索清单不再重复给。
  const materialBlocks = planMaterialBlocks(input.chapter, { ...materials, openThreads: [] }, idea, { withoutPreviousChapter: true, withoutRecentSummaries: true })
    .filter((block) => !block.startsWith("【要写的章】"));
  const task = brainstormTask({ chapter: input.chapter, materialBlocks, threads, ...(idea ? { idea } : {}), ...(input.avoid ? { avoid: input.avoid } : {}) });

  let options: BrainstormOption[] | undefined;
  let lastError = "";
  let tries = 0;
  for (let attempt = 0; attempt <= RETRIES && !options; attempt += 1) {
    tries += 1;
    try {
      const text = await withStep("章纲员想走法", () => input.callPlanner([...plannerWindow.messages, { role: "user", content: task }], { json: true }));
      options = parseBrainstorm(text, threads);
    } catch (error) {
      rethrowIfStopped(error);
      lastError = error instanceof Error ? error.message : String(error);
      // 被拒、结果不明、跑飞：再发也一样，不再试（写作版本 P2a 4.2）。解析不了的照常重试一次。
      if (!canCallAgain(error)) break;
    }
  }
  if (!options) return { ok: false, reason: `章纲员没想出能用的走法${tries > 1 ? "（已自动重试一次）" : ""}：${lastError || "模型没有返回可用内容"}` };

  const coldNotes = plannerWindow.cold ? [coldText("章纲员", plannerWindow.cold, upTo)] : [];
  let checked = false;
  let checkNote: string | undefined;
  // 核出来的每处都要引前文原句核实；前面一章都没定稿（新书第一章）就一处也立不住，白调一次模型还说「核过前文」（2026-10-23 从零走查）。
  const earlier = await readEarlierChapters(input.projectDir, input.chapter);
  const nothingEarlier = earlier.chapters.length === 0;
  if (!nothingEarlier) {
    try {
      const checkerWindow = await readerWindow({ ...windowInput, role: CHECKER_ROLE, callModel: input.callChecker });
      if (checkerWindow.cold) {
        input.onCold?.("checker");
        coldNotes.push(coldText("核账员", checkerWindow.cold, upTo));
      }
      const text = await withStep("核账员核走法", () => input.callChecker(
        [...checkerWindow.messages, { role: "user", content: brainstormCheckTask(input.chapter, options!) }],
        { json: true },
      ));
      options = splitBrainstormProblems(text, options, earlier);
      checked = true;
    } catch (error) {
      checkNote = `核账员这次没核成：${error instanceof Error ? error.message : String(error)}`;
    }
  }

  return {
    ok: true,
    chapter: input.chapter,
    ...(idea ? { idea } : {}),
    options,
    checked,
    ...(checkNote ? { checkNote } : {}),
    ...(nothingEarlier ? { nothingEarlier: true as const } : {}),
    ...(coldNotes.length > 0 ? { coldNote: coldNotes.join("") } : {}),
  };
}
