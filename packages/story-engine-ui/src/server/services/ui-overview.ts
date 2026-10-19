/**
 * 开书概况的界面附加信息（重构 P7 第 6 步从 lib/project-io 挪来）：故事日历、角色现状卡、章节文件状态、编辑部补读进度。
 * 要读编辑部的补读进度，所以放在流程层（services），基础设施层（lib）不引编辑部。
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { StateOverview } from "../book/state-overview.js";
import { readReadersCatchUpStatus, type ReadersCatchUpStatus } from "../editorial/catch-up.js";
import { readPlaceholderProtagonist, type PlaceholderProtagonist } from "../writing/presence/protagonist-placeholder.js";
import { compactRecord, isRecord, mergeStringLists, readPositiveInteger, readString, readUiChapterFileStates, type UiChapterFileState } from "../lib/project-io.js";


type StoryCalendarView = {
  readonly currentStoryDay: number;
  readonly currentTimeOfDay: "morning" | "noon" | "afternoon" | "evening" | "night" | "late_night" | "unknown";
};

type CharacterDetailView = Record<string, unknown> & {
  readonly id: string;
  readonly name: string;
};

async function readStoryCalendarView(projectDir: string): Promise<StoryCalendarView | undefined> {
  const parsed = await readFile(join(projectDir, "time", "calendar.json"), "utf-8")
    .then((text) => JSON.parse(text) as unknown)
    .catch(() => undefined);
  if (!isRecord(parsed)) return undefined;
  const currentStoryDay = readPositiveInteger(parsed.currentStoryDay) ?? 1;
  const currentTimeOfDay = readCalendarTimeOfDay(parsed.currentTimeOfDay);
  return { currentStoryDay, currentTimeOfDay };
}

function readCalendarTimeOfDay(value: unknown): StoryCalendarView["currentTimeOfDay"] {
  return value === "morning"
    || value === "noon"
    || value === "afternoon"
    || value === "evening"
    || value === "night"
    || value === "late_night"
    || value === "unknown"
    ? value
    : "unknown";
}

async function readJsonRecord(path: string): Promise<Record<string, unknown> | undefined> {
  const parsed = await readFile(path, "utf-8")
    .then((text) => JSON.parse(text) as unknown)
    .catch(() => undefined);
  return isRecord(parsed) ? parsed : undefined;
}

function readStringListLocal(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
  return [];
}

async function readCharacterDetailViews(projectDir: string): Promise<readonly CharacterDetailView[]> {
  const entries = await readdir(join(projectDir, "characters"), { withFileTypes: true }).catch(() => []);
  const bible = await readFile(join(projectDir, "story", "character-bible.json"), "utf-8")
    .then((text) => JSON.parse(text) as unknown)
    .catch(() => undefined);
  const bibleCharacters = isRecord(bible) && Array.isArray(bible.characters) ? bible.characters.filter(isRecord) : [];
  const details = await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map(async (entry) => {
      const characterDir = join(projectDir, "characters", entry.name);
      const [profile, state, core] = await Promise.all([
        readJsonRecord(join(characterDir, "profile.json")),
        readJsonRecord(join(characterDir, "state.json")),
        readJsonRecord(join(characterDir, "core.json")),
      ]);
      if (!profile) return undefined;
      const id = readString(profile.id) ?? entry.name;
      const bibleEntry = bibleCharacters.find((item) => readString(item.id) === id || readString(item.name) === readString(profile.name));
      return compactRecord({
        id,
        name: readString(profile.name) ?? id,
        role: readString(bibleEntry?.role) ?? readString(profile.identity),
        identity: readString(profile.identity),
        age: readString(profile.age),
        gender: readString(profile.gender),
        height: readString(profile.height),
        weight: readString(profile.weight),
        distinctiveTraits: readStringListLocal(profile.distinctiveTraits),
        bodyTraits: readStringListLocal(profile.bodyTraits),
        privateBodyTraits: readStringListLocal(profile.privateBodyTraits),
        intimacyBoundaries: readStringListLocal(profile.intimacyBoundaries),
        tags: readStringListLocal(profile.tags),
        appearance: isRecord(profile.appearance) ? profile.appearance : undefined,
        appearanceAnchors: mergeStringLists(profile.appearanceAnchors, bibleEntry?.appearanceAnchors),
        emotion: readString(state?.emotion) ?? readString(state?.mood),
        goal: readString(state?.goal) ?? readString(state?.currentGoal),
        mood: readString(state?.mood) ?? readString(state?.emotion),
        currentGoal: readString(state?.currentGoal) ?? readString(state?.goal),
        recentEvents: readStringListLocal(state?.recentEvents),
        relationshipToUser: readString(state?.relationshipToUser),
        currentArc: readString(state?.currentArc),
        currentLocationId: readString(state?.currentLocationId),
        currentLocationName: readString(state?.currentLocationName),
        lastUpdatedChapter: typeof state?.lastUpdatedChapter === "number" ? state.lastUpdatedChapter : null,
        personality: readStringListLocal(core?.personality),
        speechStyle: readString(core?.speechStyle),
        taboos: readStringListLocal(core?.taboos),
        worldview: readString(core?.worldview),
        desire: readString(bibleEntry?.desire) ?? readString(core?.desire),
        fear: readString(bibleEntry?.fear) ?? readString(core?.fear),
        weakness: readString(bibleEntry?.weakness),
        contradiction: readString(bibleEntry?.contradiction) ?? readString(core?.contradiction),
        moralBoundary: readString(bibleEntry?.moralBoundary) ?? readString(core?.moralBoundary),
        privateMotive: readString(bibleEntry?.privateMotive),
        relationshipToProtagonist: readString(bibleEntry?.relationshipToProtagonist),
        relationshipDynamics: readStringListLocal(bibleEntry?.relationshipDynamics),
        trustLevel: readString(bibleEntry?.trustLevel),
        hiddenStance: readString(bibleEntry?.hiddenStance),
        speechRules: readStringListLocal(bibleEntry?.speechRules),
        speechSamples: mergeStringLists(bibleEntry?.speechSamples, isRecord(core?.voice) ? core.voice.sampleLines : undefined),
        behaviorBoundaries: readStringListLocal(bibleEntry?.behaviorBoundaries),
        knowledgeKnown: mergeStringLists(bibleEntry?.knowledgeKnown, state?.knowledgeKnown),
        knowledgeUnknown: mergeStringLists(bibleEntry?.knowledgeUnknown, state?.knowledgeUnknown),
        cannotReveal: mergeStringLists(bibleEntry?.cannotReveal, state?.cannotReveal),
        cannotDo: readStringListLocal(bibleEntry?.cannotDo),
        arcPromise: readString(bibleEntry?.arcPromise),
        currentStateHint: readString(bibleEntry?.currentStateHint),
        currentPhysicalState: readString(state?.currentPhysicalState),
        currentMentalState: readString(state?.currentMentalState),
        currentResourceState: readString(state?.currentResourceState),
      }) as CharacterDetailView;
    }));
  return details.filter((item): item is CharacterDetailView => item !== undefined);
}

export async function withUiOverviewDetails(projectDir: string, overview: StateOverview): Promise<StateOverview & {
  readonly calendar?: StoryCalendarView;
  readonly characterDetails?: readonly CharacterDetailView[];
  /** 编辑部三个跟读角色的后台补读进度（R4.3）：核账员/记账员/章纲员各读到第几章，任一在读才带。 */
  readonly readerCatchUp?: { readonly reading: boolean; readonly roles: readonly { readonly role: string; readonly reading: boolean; readonly done: number; readonly total: number }[] };
  readonly uiChapterFiles?: readonly UiChapterFileState[];
  /** 主角卡还是开书占位、已定稿章节有视角人物（「待处理」里建议改名；导入的书记完账后也有）。 */
  readonly placeholderProtagonist?: PlaceholderProtagonist;
}> {
  const calendar = await readStoryCalendarView(projectDir);
  const [characterDetails, uiChapterFiles, readerCatchUp, placeholderProtagonist] = await Promise.all([
    readCharacterDetailViews(projectDir),
    readUiChapterFileStates(projectDir),
    readReadersCatchUpProgress(projectDir),
    readPlaceholderProtagonist(projectDir, Number.MAX_SAFE_INTEGER).catch(() => undefined),
  ]);
  return {
    ...overview,
    ...(calendar ? { calendar } : {}),
    ...(characterDetails.length ? { characterDetails } : {}),
    ...(readerCatchUp ? { readerCatchUp } : {}),
    ...(uiChapterFiles.length ? { uiChapterFiles } : {}),
    ...(placeholderProtagonist ? { placeholderProtagonist } : {}),
  };
}

/** 三个跟读角色的补读进度（agents/<角色>/progress.json，形状同 catch-up 的 ReadersCatchUpStatus）：全读完就不带（进度行消失）。
 *  导入的书通读记账停下了也带（P8）：进度行要显示原因和「接着记」。 */
async function readReadersCatchUpProgress(projectDir: string): Promise<ReadersCatchUpStatus | undefined> {
  const status = await readReadersCatchUpStatus(projectDir).catch(() => undefined);
  return status?.reading || status?.reread ? status : undefined;
}
