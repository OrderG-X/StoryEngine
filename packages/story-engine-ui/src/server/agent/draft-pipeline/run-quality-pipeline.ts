/**
 * 出稿后的固定质量环节（2026-10-08 写作主链重设计·阶段 3）：字数不够就接着写够 → 前后核对（不自动改，问题交作者定）。
 * 2026-10-10 引擎升级第 3 期：前后核对改用和「核账」按钮同一套服务（continuity-v2/check-service），
 * 删掉了出稿专用的旧版核对（对照账本 + 上一章结尾，召回 17～25%、误报 35～57%）和没人用的自动改冲突段。
 *
 * 编排在工具内一次跑完（确定性顺序），不再靠 agent 跨回合「预览→补字→再预览」接力（十章验收：每章来回 3–4 轮、
 * 补字 40 次、单回合思考 11 万字）。任何一步没成都原稿不动 + 如实说明，绝不影响出稿本身的 ok。
 * 真改了正文：先建快照（可撤销回首稿）再原子写盘，与自动去 AI 味同一把项目锁（防与定稿交错）。
 */
import {
  countDraftChineseCharacters,
  withProjectCommitLock,
  type ChapterPlan,
  type DraftLengthTarget,
} from "@actalk/story-engine";
import { writeFileAtomic } from "../../lib/project-io.js";
import { snapshotBeforeDraftOverwrite } from "../tools/snapshot-on-draft-overwrite.js";
import type { CheckCallModel } from "../continuity-v2/check-chapter.js";
import { checkChapterBody, type ChapterCheckItem } from "../continuity-v2/check-service.js";
import { continueDraftToLength, type ContinueCallModel } from "./continue-draft.js";

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
  /** 前后核对（qualityCheck 槽，和「核账」同一套）。缺失 = 不核对。 */
  readonly checkCallModel?: CheckCallModel;
}

export interface QualityPipelineInfo {
  /** 各环节耗时（毫秒）：长篇里「写一章要多久」要看得见，慢在哪一步才能对症。 */
  readonly timings?: { readonly continueMs?: number; readonly continuityMs?: number };
  readonly continuation?: { readonly before: number; readonly after: number; readonly rounds: number; readonly failures: readonly string[] };
  readonly continuity?: {
    readonly checked: boolean;
    /** 确定对不上的 / 可能对不上的——都留给作者定（不自动改）。 */
    readonly sure: readonly ChapterCheckItem[];
    readonly maybe: readonly ChapterCheckItem[];
    readonly failures: readonly string[];
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

/** 首稿低于下限的这个比例才自动续写。 */
const CONTINUE_ONLY_BELOW_RATIO = 0.8;

export async function runDraftQualityPipeline(input: QualityPipelineInput): Promise<QualityPipelineResult> {
  let body = input.draftBody;
  const notes: string[] = [];
  let info: QualityPipelineInfo = {};

  const timings: { continueMs?: number; continuityMs?: number } = {};
  // ① 字数严重不够才接着写（不在中间插句）。2026-10-10 真机试写：首稿只差两三百字也续，续出的一段挤成一大段、
  // 凭空编出前文没有的对话（「韩德胜说钥匙交给孟叔了」），历轮审读里续写段也是矛盾最密的地方——略短就如实说短了多少、交作者定。
  // 作者写明了「至少 N 字」（定稿侧按它硬拦）时仍补到下限——不补作者也得手动再要一次续写，还卡着定不了稿。
  const firstLength = countDraftChineseCharacters(body);
  const continueBelow = input.lengthTarget.hardMinimum ? input.lengthTarget.lowerBound : input.lengthTarget.lowerBound * CONTINUE_ONLY_BELOW_RATIO;
  if (input.continueCallModel && firstLength < continueBelow) {
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
  } else if (firstLength < input.lengthTarget.lowerBound) {
    notes.push(`首稿 ${firstLength} 字，比下限 ${input.lengthTarget.lowerBound} 少 ${input.lengthTarget.lowerBound - firstLength} 字；只差一点就没自动续写（续写容易写出和前文对不上的内容），要补就说一声。`);
  }

  // ② 前后核对：和「核账」按钮同一套（账本对账 + 模型查错 + 核账记忆），不自动改，问题留给作者定。
  // 结果记进核账记忆：作者随后点「核账」，正文没改就直接出这次的结果。
  if (input.checkCallModel && body.trim()) {
    const startedAt = Date.now();
    const result = await checkChapterBody(input.projectDir, input.chapter, body, input.checkCallModel);
    info = { ...info, continuity: { checked: result.ok, sure: result.sure, maybe: result.maybe, failures: result.failures } };
    notes.push(result.ok
      ? result.sure.length + result.maybe.length === 0
        ? "前后核对：没发现和前文对不上的地方。"
        : `前后核对：确定对不上 ${result.sure.length} 处${result.maybe.length > 0 ? `、可能 ${result.maybe.length} 处` : ""}，没自动改，点「核账」看是哪几句。`
      : `前后核对这次没跑成（${result.failures[0] ?? "原因不明"}），稿子没动；可以点「核账」再核一次。`);
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
