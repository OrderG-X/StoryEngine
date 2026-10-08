/**
 * 出稿后的固定质量环节（2026-10-08 写作主链重设计·阶段 3）：字数不够就接着写够 → 前后核对 → 有冲突自动修一轮。
 *
 * 编排在工具内一次跑完（确定性顺序），不再靠 agent 跨回合「预览→补字→再预览」接力（十章验收：每章来回 3–4 轮、
 * 补字 40 次、单回合思考 11 万字）。任何一步没成都原稿不动 + 如实说明，绝不影响出稿本身的 ok。
 * 真改了正文：先建快照（可撤销回首稿）再原子写盘，与自动去 AI 味同一把项目锁（防与定稿交错）。
 */
import {
  countDraftChineseCharacters,
  findEarlierPassages,
  collectPlanEntityTerms,
  readChapterPlan,
  withProjectCommitLock,
  type ChapterPlan,
  type DraftLengthTarget,
} from "@actalk/story-engine";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../../lib/project-io.js";
import { snapshotBeforeDraftOverwrite } from "../tools/snapshot-on-draft-overwrite.js";
import { continueDraftToLength, type ContinueCallModel } from "./continue-draft.js";
import {
  checkAndRepairContinuity,
  collectContinuityReferences,
  describeContinuityOutcome,
  type CheckCallModel,
  type ContinuityIssue,
} from "./continuity-check.js";

export interface QualityPipelineInput {
  readonly projectDir: string;
  readonly chapter: number;
  readonly draftPath: string;
  readonly title: string;
  readonly draftBody: string;
  readonly lengthTarget: DraftLengthTarget;
  readonly chapterPlan?: ChapterPlan;
  /** 续写（fastDraft 槽）。缺失 = 不补写。 */
  readonly continueCallModel?: ContinueCallModel;
  /** 前后核对（qualityCheck 槽）与修改（repair 槽）。缺一 = 不核对。 */
  readonly checkCallModel?: CheckCallModel;
  readonly repairCallModel?: CheckCallModel;
}

export interface QualityPipelineInfo {
  /** 各环节耗时（毫秒）：长篇里「写一章要多久」要看得见，慢在哪一步才能对症。 */
  readonly timings?: { readonly continueMs?: number; readonly continuityMs?: number };
  readonly continuation?: { readonly before: number; readonly after: number; readonly rounds: number; readonly failures: readonly string[] };
  readonly continuity?: {
    readonly checked: boolean;
    readonly referenceCount: number;
    readonly found: number;
    readonly repairedParagraphs: number;
    /** 修完复核后仍在的问题——留给作者定。 */
    readonly remaining: readonly ContinuityIssue[];
  };
}

export interface QualityPipelineResult {
  readonly draftBody: string;
  readonly changed: boolean;
  readonly snapshotId?: string;
  readonly info: QualityPipelineInfo;
  /** 给作者看的几句话（进 summary）。 */
  readonly notes: readonly string[];
}

async function readPreviousChapterText(projectDir: string, chapter: number): Promise<string | undefined> {
  if (chapter <= 1) return undefined;
  const pad = String(chapter - 1).padStart(4, "0");
  const content = await readFile(join(projectDir, "chapters", `${pad}.md`), "utf-8")
    .catch(() => readFile(join(projectDir, "drafts", "fast", `chapter-${pad}.md`), "utf-8"))
    .catch(() => "");
  return content.replace(/^#[^\n]*\n/u, "").trim() || undefined;
}

/** 前几章与本章章纲里的开场时间，给审读查日期/星期/先后。 */
async function readPlanTimeline(projectDir: string, chapter: number, plan: ChapterPlan | undefined): Promise<readonly string[]> {
  const out: string[] = [];
  for (let n = Math.max(1, chapter - 5); n < chapter; n += 1) {
    const previous = await readChapterPlan(projectDir, n).catch(() => undefined);
    if (previous?.scene.time) out.push(`第 ${n} 章：${previous.scene.time}`);
  }
  if (plan?.scene.time) out.push(`第 ${chapter} 章（本章）：${plan.scene.time}`);
  return out;
}

export async function runDraftQualityPipeline(input: QualityPipelineInput): Promise<QualityPipelineResult> {
  let body = input.draftBody;
  const notes: string[] = [];
  let info: QualityPipelineInfo = {};

  const timings: { continueMs?: number; continuityMs?: number } = {};
  // ① 字数在出稿这一步写够（接着写，不在中间插句）。
  if (input.continueCallModel && countDraftChineseCharacters(body) < input.lengthTarget.lowerBound) {
    const startedAt = Date.now();
    const continued = await continueDraftToLength({
      chapter: input.chapter,
      draftBody: body,
      lengthTarget: input.lengthTarget,
      callModel: input.continueCallModel,
      ...(input.chapterPlan ? { chapterPlan: input.chapterPlan } : {}),
    });
    timings.continueMs = Date.now() - startedAt;
    info = { ...info, continuation: { before: continued.before, after: continued.after, rounds: continued.rounds, failures: continued.failures } };
    if (continued.rounds > 0) {
      body = continued.draftBody;
      notes.push(continued.after >= input.lengthTarget.lowerBound
        ? `首稿 ${continued.before} 字低于下限 ${input.lengthTarget.lowerBound}，已接着写到 ${continued.after} 字。`
        : `首稿 ${continued.before} 字低于下限 ${input.lengthTarget.lowerBound}，接着写到 ${continued.after} 字，仍差 ${input.lengthTarget.lowerBound - continued.after} 字。`);
    } else if (continued.failures.length > 0) {
      notes.push(`首稿 ${continued.before} 字低于下限 ${input.lengthTarget.lowerBound}，自动续写没成（${continued.failures.at(-1)}）。`);
    }
  }

  // ② 前后核对（+ ③ 注入了改写调用时才自动修；生产路默认不自动修，问题留给作者定）。
  if (input.checkCallModel && body.trim()) {
    const startedAt = Date.now();
    const passages = input.chapterPlan
      ? await findEarlierPassages({
        projectDir: input.projectDir,
        chapter: input.chapter,
        terms: collectPlanEntityTerms(input.chapterPlan),
        excludeChapters: [input.chapter - 1],
      }).catch(() => [])
      : [];
    const previousChapterText = await readPreviousChapterText(input.projectDir, input.chapter);
    const timeline = await readPlanTimeline(input.projectDir, input.chapter, input.chapterPlan);
    const references = await collectContinuityReferences({
      projectDir: input.projectDir,
      chapter: input.chapter,
      draftBody: body,
      passages,
      ...(previousChapterText ? { previousChapterText } : {}),
      ...(timeline.length > 0 ? { timeline } : {}),
    });
    const result = await checkAndRepairContinuity({
      chapter: input.chapter,
      draftBody: body,
      references,
      checkCallModel: input.checkCallModel,
      ...(input.repairCallModel ? { repairCallModel: input.repairCallModel } : {}),
      ...(input.chapterPlan ? { chapterPlan: input.chapterPlan } : {}),
    });
    info = {
      ...info,
      continuity: {
        checked: result.firstCheck.checked,
        referenceCount: result.firstCheck.referenceCount,
        found: result.firstCheck.issues.length,
        repairedParagraphs: result.repairedParagraphs,
        remaining: result.remaining,
      },
    };
    if (result.changed) body = result.draftBody;
    notes.push(describeContinuityOutcome(result));
    timings.continuityMs = Date.now() - startedAt;
  }
  info = { ...info, timings };
  console.info(
    `[draft-pipeline] ch${input.chapter} 续写 ${Math.round((timings.continueMs ?? 0) / 1000)}s / 核对与修改 ${Math.round((timings.continuityMs ?? 0) / 1000)}s`,
  );

  const changed = body !== input.draftBody;
  if (!changed) return { draftBody: input.draftBody, changed: false, info, notes };
  let snapshotId: string | undefined;
  await withProjectCommitLock(input.projectDir, async () => {
    snapshotId = await snapshotBeforeDraftOverwrite(input.projectDir, input.chapter, `第${input.chapter}章补写与前后核对前快照`);
    await writeFileAtomic(input.draftPath, `# ${input.title}\n\n${body.trim()}\n`);
  });
  return { draftBody: body.trim(), changed: true, ...(snapshotId ? { snapshotId } : {}), info, notes };
}
