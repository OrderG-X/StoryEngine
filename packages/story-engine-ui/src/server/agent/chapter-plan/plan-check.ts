/**
 * 章纲审校（2026-10-09 十章验收第十轮）：动笔前先拿章纲对一遍旧设定，有冲突当场改章纲。
 *
 * 第十轮审读：46 处矛盾里 21 处在章纲阶段就写错了——同一个人第 4 章说表一直收着、第 7 章说早丢了；
 * 某人 1998 年回没回老家翻了三次；「三天前」一直不动。拟章纲时给的旧事实是按「上一章原文」挑的，
 * 章纲里新安排的说法涉及的旧事实未必在里头。审校换个检索词：按章纲自己写了什么去翻旧事实（说到林晓和怀表，
 * 就把「林晓说表一直收着」翻出来），再加故事日历和上一章结尾。章纲很短，这一步又快又准。
 *
 * 模型无关：输出宽进；改过的章纲必须是合法章纲（normalizeChapterPlan 过得了）才用，否则保留原章纲并如实记录。
 * 审校挂了 → 原章纲照用（不阻断出稿）。
 */
import {
  normalizeChapterPlan,
  readCharacterBible,
  readFactLedger,
  readStoryClock,
  selectEffectiveFacts,
  writeChapterPlan,
  type ChapterPlan,
} from "@actalk/story-engine";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PlanCallModel } from "./plan-chapter.js";

const CHECK_FACT_CAP = 30;
const PREVIOUS_ENDING_CHARS = 800;

export interface PlanCheckResult {
  readonly plan: ChapterPlan;
  /** 审校改了章纲。 */
  readonly revised: boolean;
  /** 审校指出的问题（改了的和没改成的都列）。 */
  readonly issues: readonly string[];
  /** 审校没跑成的原因。 */
  readonly error?: string;
}

function planText(plan: ChapterPlan): string {
  return [
    plan.summary,
    ...plan.beats,
    ...plan.newInformation,
    ...plan.threadsAdvanced.map((step) => `${step.title} ${step.how}`),
    plan.scene.location ?? "",
    plan.scene.time ?? "",
  ].join("\n");
}

export function buildPlanCheckMessages(input: {
  readonly plan: ChapterPlan;
  readonly facts: readonly string[];
  readonly clock: readonly string[];
  readonly characters: readonly string[];
  readonly previousEnding?: string;
}): { readonly role: "system" | "user"; readonly content: string }[] {
  const system = [
    "你是长篇小说的章纲审校。对照【已确立事实】【故事日历】【人物】【上一章结尾】，检查下面这份章纲有没有和前文对不上的地方：",
    "· 同一个人对同一件事的说法前后翻转（前文说表一直收着，章纲让他说早就丢了），除非章纲明确安排了「他之前在撒谎/记错了」并写出揭穿的过程；",
    "· 物件在哪、在谁手里、坏没坏；地点在不在；谁已经知道什么（不能让人物知道他还不可能知道的事）；",
    "· storyDay 与【故事日历】是否顺得下去、星期几是否算得对、「几天前」是否按天数差算；人物在某一年多大是否对得上；",
    "· 前文已经发现、确认、做过的事，章纲又安排一遍；上一章结尾的人物位置、时间与章纲开场接不上。",
    "没有问题就只输出 {\"ok\":true}。",
    "有问题就输出 {\"issues\":[\"每条一句：哪里和哪条前文对不上\"],\"plan\":{修正后的完整章纲，字段与原章纲相同：summary, beats, newInformation, scene, storyDay, characters, entities, threadsAdvanced, avoid}}——只改有问题的地方，其余照抄原章纲。",
    "只输出一个 JSON，不要解释、不要 Markdown。",
  ].join("\n");
  const user = [
    `【章纲（第 ${input.plan.chapter} 章）】\n${JSON.stringify({
      summary: input.plan.summary,
      beats: input.plan.beats,
      newInformation: input.plan.newInformation,
      scene: input.plan.scene,
      ...(input.plan.storyDay ? { storyDay: input.plan.storyDay } : {}),
      characters: input.plan.characters,
      entities: input.plan.entities,
      threadsAdvanced: input.plan.threadsAdvanced,
      avoid: input.plan.avoid,
    }, null, 1)}`,
    input.facts.length > 0 ? `【已确立事实】\n${input.facts.join("\n")}` : "【已确立事实】（无）",
    input.clock.length > 0 ? `【故事日历】\n${input.clock.join("\n")}` : "",
    input.characters.length > 0 ? `【人物】${input.characters.join("、")}` : "",
    input.previousEnding ? `【上一章结尾】\n${input.previousEnding}` : "",
  ].filter(Boolean).join("\n\n");
  return [{ role: "system", content: system }, { role: "user", content: user }];
}

async function readPreviousEnding(projectDir: string, chapter: number): Promise<string | undefined> {
  if (chapter <= 1) return undefined;
  const pad = String(chapter - 1).padStart(4, "0");
  const content = await readFile(join(projectDir, "chapters", `${pad}.md`), "utf-8").catch(() => "");
  const body = content.replace(/^#[^\n]*\n/u, "").trim();
  return body ? body.slice(-PREVIOUS_ENDING_CHARS) : undefined;
}

export async function checkAndRevisePlan(input: {
  readonly projectDir: string;
  readonly plan: ChapterPlan;
  readonly callModel: PlanCallModel;
}): Promise<PlanCheckResult> {
  const { plan } = input;
  const [ledger, characterBible, clock, previousEnding] = await Promise.all([
    readFactLedger(input.projectDir).catch(() => null),
    readCharacterBible(input.projectDir).catch(() => null),
    readStoryClock(input.projectDir, plan.chapter).catch(() => []),
    readPreviousEnding(input.projectDir, plan.chapter),
  ]);
  const characterNames = (characterBible?.characters ?? []).map((character) => character.name).filter(Boolean);
  const facts = selectEffectiveFacts({
    facts: ledger?.facts ?? [],
    chapter: plan.chapter,
    relevantNames: characterNames,
    continuityText: planText(plan),
    retrievalTerms: [...plan.characters, ...plan.entities],
    cap: CHECK_FACT_CAP,
  }).facts;
  const characters = (characterBible?.characters ?? [])
    .filter((character) => Boolean(character.name))
    .map((character) => {
      const notes = [character.role?.trim().slice(0, 30), character.age?.trim() ? `${character.age.trim()}岁`.replace(/岁岁$/u, "岁") : undefined].filter(Boolean);
      return notes.length > 0 ? `${character.name}（${notes.join("，")}）` : character.name;
    });
  const messages = buildPlanCheckMessages({
    plan,
    facts,
    clock: clock.map((entry) => `第 ${entry.chapter} 章：故事第 ${entry.storyDay} 天${entry.time ? `（${entry.time}）` : ""}，${entry.summary}`),
    characters,
    ...(previousEnding ? { previousEnding } : {}),
  });
  let raw: Record<string, unknown>;
  try {
    const text = await input.callModel(messages);
    const match = text.match(/\{[\s\S]*\}/u);
    if (!match) throw new Error("审校结果不是 JSON");
    raw = JSON.parse(match[0]) as Record<string, unknown>;
  } catch (error) {
    return { plan, revised: false, issues: [], error: error instanceof Error ? error.message : String(error) };
  }
  const issues = (Array.isArray(raw.issues) ? raw.issues : [])
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean)
    .slice(0, 8);
  if (raw.ok === true || issues.length === 0 || !raw.plan) return { plan, revised: false, issues };
  const revised = normalizeChapterPlan(raw.plan, {
    chapter: plan.chapter,
    source: plan.source,
    ...(plan.direction ? { direction: plan.direction } : {}),
  });
  if (!revised) return { plan, revised: false, issues, error: "审校给的修正章纲不完整，沿用原章纲" };
  // 原章纲里确定性并进的「别再用这些说法」不能丢；没给天数就沿用原来的。
  const keptAvoid = plan.avoid.filter((item) => item.startsWith("别再用这些说法：") && !revised.avoid.includes(item));
  const merged: ChapterPlan = {
    ...revised,
    avoid: [...revised.avoid, ...keptAvoid],
    ...(revised.storyDay === undefined && plan.storyDay !== undefined ? { storyDay: plan.storyDay } : {}),
  };
  await writeChapterPlan(input.projectDir, merged);
  return { plan: merged, revised: true, issues };
}
