/**
 * 出稿字数不够时在出稿这一步就续写够（2026-10-08 写作主链重设计·阶段 3）。
 *
 * 十章真机验收：10 章里 7 章首稿低于作者设的下限，定稿被拦 12 次，AI 事后用「逐句替换」插字 40 次——
 * 插进去的句子读起来像注水，还带进新矛盾（门槛划痕、手背上的疤）。根因：对话出稿只标注不补写，
 * 补写只能靠改稿工具逐句插。改成：出稿时发现不够，就让写手从最后一段起接着往下写（最后一段一起重写，
 * 避免「已经收尾又续上一段」），把章纲里写得太简略的要点写充分，自然收尾。最多两轮，仍不够如实标注。
 * 一轮的调用被拒、结果不明这类不能再发的失败就停（canCallAgain），不进下一轮。
 *
 * 模型无关：续写结果只取正文（剥标题/解释）；比原来还短、空、像 JSON → 视为没续成，原稿不动。
 */
import { countDraftChineseCharacters, draftLengthFloor, type DraftLengthTarget } from "../../writing/draft-length-control.js";
import { stripTrailingSegmentMarkers } from "../../writing/fast-draft-writer.js";
import { cutAtWriterEndMark, WRITER_END_MARK } from "../../writing/prompt-cache-diagnostics.js";
import { chinesePunctuation } from "../../../lib/dialogue-quotes.js";
import { type ChapterPlan } from "../../book/chapter-plan.js";
import { canCallAgain } from "../../lib/llm-client.js";
import { rethrowIfStopped } from "../../lib/operations/context.js";

export type ContinueCallModel = (
  messages: readonly { readonly role: "system" | "user"; readonly content: string }[],
) => Promise<string>;

export interface ContinueDraftInput {
  readonly chapter: number;
  readonly draftBody: string;
  readonly lengthTarget: DraftLengthTarget;
  readonly chapterPlan?: ChapterPlan;
  readonly callModel: ContinueCallModel;
  /** 最多续写几轮（默认 2）。 */
  readonly maxRounds?: number;
}

export interface ContinueDraftResult {
  readonly draftBody: string;
  /** 实际续写成功的轮数（0 = 没续 / 没续成）。 */
  readonly rounds: number;
  readonly before: number;
  readonly after: number;
  /** 续写调用失败/结果不可用的原因（成功为空）。 */
  readonly failures: readonly string[];
}

const DEFAULT_ROUNDS = 2;

/** 把正文拆成「保留的前文」和「最后一段」：最后一段交给续写一起重写，免得收尾句后面硬接。 */
export function splitForContinuation(body: string): { readonly prefix: string; readonly lastParagraph: string } {
  const paragraphs = body.trim().split(/\n\s*\n|\n/u).map((item) => item.trim()).filter(Boolean);
  if (paragraphs.length <= 1) return { prefix: "", lastParagraph: paragraphs[0] ?? "" };
  return { prefix: paragraphs.slice(0, -1).join("\n\n"), lastParagraph: paragraphs.at(-1) ?? "" };
}

export function buildContinuationMessages(input: {
  readonly chapter: number;
  readonly prefix: string;
  readonly lastParagraph: string;
  readonly need: number;
  readonly lengthTarget: DraftLengthTarget;
  readonly chapterPlan?: ChapterPlan;
}): { readonly role: "system" | "user"; readonly content: string }[] {
  const lastLength = countDraftChineseCharacters(input.lastParagraph);
  const target = input.need + lastLength;
  // 上限：整章不超过目标区间上限（验收：首稿只差 100 字，一口气续到 4465 字，目标才 3000）。
  const ceiling = Math.max(target, input.lengthTarget.upperBound - countDraftChineseCharacters(input.prefix));
  const system = [
    "你是小说写手，正在写同一章的后半部分。只输出接下来的正文，不要标题、不要解释、不要重复前文。",
    `从「前文」最后一句之后接着写；「原最后一段」由你重写并扩展（可以吸收它的内容，但不要原样照抄后再接着写）。`,
    `这一段续写写 ${target}–${ceiling} 个汉字（不少于 ${target}，不要超过 ${ceiling}）：把章纲里还没写到或写得太简略的要点写充分——用具体的动作、对话、场面推进，不要堆形容词、不要回顾前文、不要总结感想。`,
    "只在本章已经写到的场景里往深处写：不要开始新的一天、不要换到新的地点、不要引入新的人物、新的文书或新的物件、不要让事情有前文没有的新结果——把已有场面的动作、对话、细节写足，写到章纲最后一个要点就收住。",
    "人物、物件、地点、时间必须和前文一致。最后自然收住本章。",
    `写完另起一行只写 ${WRITER_END_MARK}；这一行后面什么都不写（不要自检、不要说明）。`,
  ].join("\n");
  const plan = input.chapterPlan
    ? [
      `【本章章纲】${input.chapterPlan.summary}`,
      `要点：${input.chapterPlan.beats.map((beat, index) => `${index + 1}. ${beat}`).join("  ")}`,
      input.chapterPlan.newInformation.length > 0 ? `本章新信息（必须写明）：${input.chapterPlan.newInformation.join("；")}` : "",
    ].filter(Boolean).join("\n")
    : "";
  const user = [
    `【第 ${input.chapter} 章】`,
    plan,
    input.prefix ? `【前文】\n${input.prefix}` : "【前文】（无，从头写）",
    `【原最后一段】\n${input.lastParagraph}`,
  ].filter(Boolean).join("\n\n");
  return [{ role: "system", content: system }, { role: "user", content: user }];
}

/** 剥掉模型可能加的 Markdown 标题行和末尾的「（全文完）」这类标记，留正文。
 *  「好的 / 以下是」这类开场白不再按词表剥（重构 P7「不猜」：正文第一句也可能是「好的。」）——提示词已要求只出正文。 */
function cleanContinuation(text: string): string {
  return chinesePunctuation(stripTrailingSegmentMarkers(cutAtWriterEndMark(text).replace(/^\s*#[^\n]*\n/u, ""))).trim();
}

export async function continueDraftToLength(input: ContinueDraftInput): Promise<ContinueDraftResult> {
  const before = countDraftChineseCharacters(input.draftBody);
  const maxRounds = input.maxRounds ?? DEFAULT_ROUNDS;
  const failures: string[] = [];
  let body = input.draftBody.trim();
  let rounds = 0;
  for (let attempt = 0; attempt < maxRounds; attempt += 1) {
    const current = countDraftChineseCharacters(body);
    if (current >= draftLengthFloor(input.lengthTarget)) break;
    // 续到目标字数（而不是刚过下限）：留出余量，免得再被下限拦。
    const need = Math.max(input.lengthTarget.requested - current, draftLengthFloor(input.lengthTarget) - current);
    const { prefix, lastParagraph } = splitForContinuation(body);
    let continuation = "";
    try {
      continuation = cleanContinuation(await input.callModel(buildContinuationMessages({
        chapter: input.chapter, prefix, lastParagraph, need, lengthTarget: input.lengthTarget,
        ...(input.chapterPlan ? { chapterPlan: input.chapterPlan } : {}),
      })));
    } catch (error) {
      rethrowIfStopped(error);
      failures.push(`第 ${attempt + 1} 轮续写没成：${error instanceof Error ? error.message : String(error)}`);
      // 被拒、结果不明、跑飞：下一轮正文没变、还是同一个请求，不再发（写作版本 P2a 4.2）。
      if (!canCallAgain(error)) break;
      continue;
    }
    const candidate = prefix ? `${prefix}\n\n${continuation}` : continuation;
    // 续完反而更短 / 是空的 / 像 JSON 或说明文字 → 不用，原稿不动。
    if (!continuation || /^[{[]/u.test(continuation) || countDraftChineseCharacters(candidate) <= current) {
      failures.push(`第 ${attempt + 1} 轮续写结果不可用，原稿未动`);
      continue;
    }
    body = candidate;
    rounds += 1;
  }
  return { draftBody: body, rounds, before, after: countDraftChineseCharacters(body), failures };
}
