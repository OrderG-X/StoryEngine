/**
 * 拟章纲（2026-10-08 写作主链重设计·阶段 2「先想后写」）。
 *
 * 十章真机验收：作者只说「接着写」时写手拿到的目标是空话，剧情原地打转（同一个发现被重新发现 5 次）。
 * 出稿前先用一次模型调用拟章纲：接住上一章结尾、至少推进一条开着的线索、至少给一条新信息、写明不要重复什么，
 * 并点名本章涉及的人/物/地——引擎据此翻旧章原文与旧事实（见引擎 chapter-plan.ts / earlier-passages.ts）。
 *
 * 模型无关：输出宽进归一（normalizeChapterPlan）；坏 JSON / 挂了 → 自动重试一次；仍不成 → ok:false + 原因，
 * 由调用方如实告知并回落「无章纲出稿」，绝不拿空章纲冒充。题材中立：提示词不预设任何题材。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  normalizeChapterPlan,
  readArcGoalPool,
  readAssetLedger,
  readCharacterBible,
  readChapterPlan,
  readLocationBible,
  readStoryBible,
  readThreadPool,
  readTimelineEvents,
  writeChapterPlan,
  type ChapterPlan,
} from "@actalk/story-engine";
import { resolveConfiguredChatModel, streamChatModelToText } from "../../lib/llm-client.js";

export type PlanCallModel = (
  messages: readonly { readonly role: "system" | "user"; readonly content: string }[],
) => Promise<string>;

export interface PlanChapterInput {
  readonly projectDir: string;
  readonly chapter: number;
  /** 作者这章的方向原话；没给 = 模型按现状自己拟。 */
  readonly direction?: string;
  readonly callModel: PlanCallModel;
}

export type PlanChapterResult =
  | { readonly ok: true; readonly plan: ChapterPlan }
  | { readonly ok: false; readonly reason: string };

/** 拟章纲失败（模型挂了 / 不是 JSON / 缺要点）自动再试的次数。 */
const PLAN_RETRIES = 1;
const PREVIOUS_TAIL_CHARS = 3000;
const MAX_OPEN_THREADS = 15;
const RECENT_CHAPTER_SUMMARIES = 6;

export interface PlanChapterMaterials {
  readonly premise?: string;
  readonly longFormGoals: readonly string[];
  readonly previousChapter?: { readonly chapter: number; readonly text: string };
  readonly recentChapters: readonly string[];
  readonly openThreads: readonly string[];
  readonly openGoals: readonly string[];
  readonly characters: readonly string[];
  readonly entities: readonly string[];
  readonly protectedSecrets: readonly string[];
}

const settle = async <T>(promise: Promise<T>, fallback: T): Promise<T> => promise.catch(() => fallback);

async function readPreviousChapterText(projectDir: string, chapter: number): Promise<PlanChapterMaterials["previousChapter"]> {
  if (chapter <= 1) return undefined;
  const pad = String(chapter - 1).padStart(4, "0");
  const content = await readFile(join(projectDir, "chapters", `${pad}.md`), "utf-8")
    .catch(() => readFile(join(projectDir, "drafts", "fast", `chapter-${pad}.md`), "utf-8"))
    .catch(() => "");
  const body = content.replace(/^#[^\n]*\n/u, "").trim();
  if (!body) return undefined;
  return { chapter: chapter - 1, text: body.length > PREVIOUS_TAIL_CHARS ? `（前略）${body.slice(-PREVIOUS_TAIL_CHARS)}` : body };
}

/** 读盘收集拟章纲的材料。全部读失败即空、绝不阻断（拟不成就回落无章纲出稿）。 */
export async function collectPlanMaterials(projectDir: string, chapter: number): Promise<PlanChapterMaterials> {
  const [storyBible, threadPool, goalPool, timeline, characterBible, assetLedger, locationBible, previousChapter] = await Promise.all([
    settle(readStoryBible(projectDir), null),
    settle(readThreadPool(projectDir), { threads: [] }),
    settle(readArcGoalPool(projectDir), { goals: [] }),
    settle(readTimelineEvents(projectDir), []),
    settle(readCharacterBible(projectDir), null),
    settle(readAssetLedger(projectDir), { version: "v0" as const, assets: [], containers: [] }),
    settle(readLocationBible(projectDir), null),
    readPreviousChapterText(projectDir, chapter),
  ]);
  const openThreads = threadPool.threads
    .filter((thread) => thread.status === "open" || thread.status === "touched")
    .sort((a, b) => b.lastTouchedChapter - a.lastTouchedChapter)
    .slice(0, MAX_OPEN_THREADS)
    .map((thread) => {
      // 标题入库时被截成 16 字加「…」：带上第一条证据，模型才看得懂这条线索在问什么。
      const evidence = thread.title.endsWith("…") ? thread.evidence?.[0]?.slice(0, 60) : undefined;
      return `${thread.title}${evidence ? `（${evidence}）` : ""}（上次第 ${thread.lastTouchedChapter} 章）`;
    });
  const openGoals = goalPool.goals
    .filter((goal) => goal.status === "active" || goal.status === "touched")
    .map((goal) => `${goal.title}（${goal.scope === "main_arc" ? "主线" : "阶段目标"}）`);
  const recentChapters = [...timeline]
    .filter((event) => event.chapter < chapter)
    .sort((a, b) => a.chapter - b.chapter)
    .slice(-RECENT_CHAPTER_SUMMARIES)
    .map((event) => `第 ${event.chapter} 章：${event.summary.slice(0, 120)}`);
  return {
    ...(storyBible?.premise ? { premise: storyBible.premise } : {}),
    longFormGoals: storyBible?.longFormGoals ?? [],
    ...(previousChapter ? { previousChapter } : {}),
    recentChapters,
    openThreads,
    openGoals,
    characters: (characterBible?.characters ?? []).map((character) => character.name).filter(Boolean),
    entities: [
      ...assetLedger.assets.map((asset) => asset.name).filter(Boolean),
      ...(locationBible?.locations ?? []).map((location) => location.name).filter(Boolean),
    ],
    protectedSecrets: storyBible?.protectedSecrets ?? [],
  };
}

export function buildPlanMessages(
  chapter: number,
  materials: PlanChapterMaterials,
  direction?: string,
): { readonly role: "system" | "user"; readonly content: string }[] {
  const system = [
    "你是长篇小说的章纲策划。读前文和故事现状，为下一章拟一份章纲。只输出一个 JSON，不要解释、不要 Markdown。",
    "要求：",
    "1. 紧接上一章结尾：时间、地点、人物各自在哪、手里有什么，都从上一章结尾接上；换场要交代怎么过去的。",
    "2. 这章必须让故事往前走：至少推进一条「开着的线索」或「目标」，并且至少给出一条读者此前不知道的新信息或局面变化（newInformation）。前文已经发现、说过、确认过的东西不算新信息。",
    "3. 不要重演前文：上一章或前几章已经写过的发现、对话、场面，写进 avoid，本章不得再来一遍。",
    "4. 作者给了方向就照方向展开，不要改方向。",
    "5. 优先用已有的人物、地点、物件；确需新人物或新物件可以引入，但要写进 characters / entities。",
    "6. 不要揭开「受保护的秘密」，除非作者方向明确要求。",
    "JSON 字段：",
    "{\"summary\":\"一句话说这章讲什么\",\"beats\":[\"按顺序 3–6 个要点，每个是一件具体发生的事\"],\"newInformation\":[\"1–3 条本章新出现的信息/变化\"],",
    "\"scene\":{\"location\":\"开场地点\",\"time\":\"开场时间（相对上一章，如第二天上午）\"},\"characters\":[\"出场人物名\"],",
    "\"entities\":[\"本章涉及的物件/地点/文书名，用前文里的原名\"],\"threadsAdvanced\":[{\"title\":\"推进的线索或目标（照抄下面列表里的说法）\",\"how\":\"怎么推进\"}],",
    "\"avoid\":[\"本章不要重复的东西\"]}",
  ].join("\n");
  const blocks = [
    `【要写的章】第 ${chapter} 章`,
    direction?.trim() ? `【作者这章的方向】${direction.trim()}` : "【作者这章的方向】没有特别指定，按故事现状自然往下推进。",
    materials.premise ? `【故事前提】${materials.premise}` : "",
    materials.longFormGoals.length > 0 ? `【长线目标】${materials.longFormGoals.join("；")}` : "",
    materials.openGoals.length > 0 ? `【目标】\n${materials.openGoals.join("\n")}` : "",
    materials.openThreads.length > 0 ? `【开着的线索】\n${materials.openThreads.join("\n")}` : "",
    materials.recentChapters.length > 0 ? `【前面几章发生了什么】\n${materials.recentChapters.join("\n")}` : "",
    materials.characters.length > 0 ? `【已有人物】${materials.characters.join("、")}` : "",
    materials.entities.length > 0 ? `【已登记的物件/地点】${materials.entities.join("、")}` : "",
    materials.protectedSecrets.length > 0 ? `【受保护的秘密（不要揭开）】${materials.protectedSecrets.join("；")}` : "",
    materials.previousChapter
      ? `【上一章（第 ${materials.previousChapter.chapter} 章）正文${materials.previousChapter.text.startsWith("（前略）") ? "结尾" : ""}】\n${materials.previousChapter.text}`
      : "【上一章】没有（这是开篇）。",
  ].filter(Boolean);
  return [{ role: "system", content: system }, { role: "user", content: blocks.join("\n\n") }];
}

function parsePlanJson(text: string): unknown {
  const match = text.match(/\{[\s\S]*\}/u);
  if (!match) throw new Error("章纲不是 JSON");
  return JSON.parse(match[0]);
}

/** 拟章纲并落盘（drafts/plans/chapter-NNNN.json）。失败自动重试一次；仍失败 ok:false + 原因，不抛。 */
export async function planChapter(input: PlanChapterInput): Promise<PlanChapterResult> {
  const materials = await collectPlanMaterials(input.projectDir, input.chapter);
  const messages = buildPlanMessages(input.chapter, materials, input.direction);
  let lastError = "";
  for (let attempt = 0; attempt <= PLAN_RETRIES; attempt += 1) {
    try {
      const plan = normalizeChapterPlan(parsePlanJson(await input.callModel(messages)), {
        chapter: input.chapter,
        source: "model",
        ...(input.direction?.trim() ? { direction: input.direction } : {}),
      });
      if (!plan) {
        lastError = "章纲缺要点";
        continue;
      }
      await writeChapterPlan(input.projectDir, plan);
      return { ok: true, plan };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return { ok: false, reason: `章纲没拟成（已自动重试一次）：${lastError || "模型没有返回可用内容"}` };
}

/**
 * 生产用 callModel：chapterSteering 任务槽（思考开关随作者的任务设置），json_object。
 * 走 streamChatModelToText：流式 + 空闲超时（有字节就续命、无总时长上限）；一律不传 max_tokens（铁律）。
 */
export const callConfiguredPlanModel: PlanCallModel = async (messages) => {
  const configured = await resolveConfiguredChatModel("chapterSteering");
  const { content } = await streamChatModelToText({
    configured,
    messages: messages.map((message) => ({ role: message.role, content: message.content })),
    responseFormat: { type: "json_object" },
  });
  if (!content.trim()) throw new Error("章纲模型返回了空内容");
  return content;
};

export interface ResolvedChapterPlan {
  readonly plan?: ChapterPlan;
  /** 给作者看的一句话：章纲是什么 / 为什么没有。 */
  readonly note: string;
  /** 沿用了这章已有的章纲（同一方向重写时不重拟）。 */
  readonly reused: boolean;
}

/**
 * 出稿前拿到本章章纲：这章已有章纲、且作者方向没变（同为空或原话相同）→ 沿用（「重写这一章」保持同一份章纲）；
 * 否则重拟。拟不成 → plan 缺省 + 如实说明，出稿照旧路径走，绝不阻断出稿。
 */
export async function resolveChapterPlanForDraft(input: PlanChapterInput): Promise<ResolvedChapterPlan> {
  const direction = input.direction?.trim() ?? "";
  const existing = await readChapterPlan(input.projectDir, input.chapter).catch(() => undefined);
  if (existing && (existing.direction ?? "") === direction) {
    return { plan: existing, note: `沿用本章已有章纲：${existing.summary}`, reused: true };
  }
  const planned = await planChapter({ ...input, ...(direction ? { direction } : {}) });
  if (!planned.ok) return { note: `${planned.reason}；这次按没有章纲出稿。`, reused: false };
  return { plan: planned.plan, note: `本章章纲：${planned.plan.summary}`, reused: false };
}
