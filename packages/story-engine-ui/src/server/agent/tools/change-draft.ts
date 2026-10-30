/**
 * change_draft —— 对话里让 AI 写一章、接着往下写（写作版本 P2a 3.1、第七节；收编原来的 generate_draft）。
 * 和 run_check 一样只交意图：宽进归一 → 交给执行器（draft.change）→ 回受理回执，受理了这一轮就停；
 * 拟纲、写、补字数、去 AI 味、核账、按核账改、换上工作稿都由服务端按固定步骤做，结论、核账卡、下一步也由服务端出。
 *
 * 留在工具这层的只有对话才有的事：
 * - 章号：模型没给就用作者所在章；所在章刚定稿、又是写作前沿时推到下一章（治 off-by-one）。接着写不推。
 * - 方向、要点是作者原话（规矩 5）：逐句核不上原话就不交、如实退回（还没花额度）。作者在稿纸上挑过走法的并进方向。
 * 别的前提（导入的书在记账、有稿没点重写、前一章没定稿、没得接、已定稿）由配方受理前判，没受理回 ok:false + code；
 * 有稿的章另带「接着往下写」「重写这一章」两个按钮（作者档，点了才写）。
 */
import { createTool, type ToolExecutionContext } from "@mastra/core/tools";
import { z } from "zod";
import { coerceBoolean, coerceEnum, coerceNumber, coerceStringArray } from "../../lib/lenient-args.js";
import { isChapterCommitted } from "../../lib/working-draft-text.js";
import { DRAFT_CHANGE_KIND, readDraftChangeParams, type DraftChangeMode } from "../../services/draft-change/params.js";
import { submitOperation } from "../../services/operations/executor.js";
import { rewriteChoices } from "../draft-finish.js";
import type { NextStepChoice } from "../next-steps.js";
import {
  readAuthorWordsFromContext,
  readMessageRefFromContext,
  readPickedDirectionFromContext,
  readProjectDirFromContext,
  resolveChapterFromInputOrContext,
} from "../request-context.js";
import { checkAuthorQuote } from "./author-quote.js";
import { receiptOf, type SubmitReceipt } from "./op-tools.js";

/**
 * 已定稿前沿 → 推进下一章（治长篇连写的章号 off-by-one：定稿第 6 章后说「写第 7 章」却落回第 6 章）。
 * 只在模型没给章号、所在章已定稿、下一章还没定稿时推进：「在刚定稿的最新章上写正文」几乎都是想写下一章。
 * 显式点名章号一律尊重；前沿之内的已定稿章（下一章也定稿了）不推进。纯逻辑、可测。
 */
export function advancePastCommittedFrontier(input: {
  readonly explicitChapter: boolean;
  readonly resolvedChapter: number;
  readonly resolvedCommitted: boolean;
  readonly nextChapterCommitted: boolean;
}): number {
  if (!input.explicitChapter && input.resolvedCommitted && !input.nextChapterCommitted) return input.resolvedChapter + 1;
  return input.resolvedChapter;
}

/** 交章纲员和写手的作者方向：方向原话 + 方向里没有的要点，一条一行；都没有就是 undefined（章纲按故事现状往下推）。 */
export function authorDirectionOf(chapterGoal: string | undefined, mustHitBeats: readonly string[] | undefined): string | undefined {
  const goal = chapterGoal?.trim() ?? "";
  const beats = (mustHitBeats ?? []).map((beat) => beat.trim()).filter((beat) => beat && !goal.includes(beat));
  return [goal, ...beats].filter(Boolean).join("\n") || undefined;
}

/** 作者给这一章挑中的走法并进方向：方向里已经有了就不重复；作者另外说的接在后面。纯逻辑、可测。 */
export function withPickedDirection(goal: string | undefined, picked: string | undefined): string | undefined {
  if (!picked) return goal;
  if (!goal) return picked;
  if (goal.includes(picked)) return goal;
  return `${picked}\n作者另外说：${goal}`;
}

/** change_draft 的回执：受理回执，外加有稿时的两个按钮、前一章没定稿时该先定稿的那章。 */
export interface ChangeDraftReceipt extends SubmitReceipt {
  /** 有稿的章：「接着往下写」「重写这一章」按钮（界面画成作者按钮，你不用转述）。 */
  readonly rewriteChoices?: readonly NextStepChoice[];
  /** 前一章没定稿：建议先定稿的那一章。 */
  readonly pendingChapterToCommit?: number;
}

const inputSchema = z.object({
  mode: coerceEnum(z.enum(["write", "continue"]).optional().describe(
    "write=写这一章（缺省）；continue=接着这一章的工作稿往下写：已写的字一个不动，从最后一句接着写（作者写了半章要你接、稿子短了要补、作者说接着写 / 续写 / 再写几百字）。",
  )),
  chapter: coerceNumber(z.number().int().positive().optional().describe("章号；省略=作者当前所在章。")),
  chapterGoal: z.string().optional().describe(
    "本章方向（continue 时是接下来写什么）：只能原样抄作者说过的话，抄的每句一个字不改（别删字、别把「他」换成名字；可以只抄讲方向的那几句）；作者没给方向就别填，章纲会按故事现状往下推。不是原话会被退回。",
  ),
  requestedDraftLength: coerceNumber(z.number().int().nonnegative().optional().describe("期望字数；省略=按写作规则。continue 时是这次接着写多少字（省略=写到本章目标）。")),
  mustHitBeats: coerceStringArray(z.array(z.string()).optional().describe(
    "作者给的本章必须写到的具体要点（名物、数字、编号、关键动作），逐条原样填，别压成一句话、别换词。和方向一起交章纲员，同样不是原话会被退回。",
  )),
  selectedCharacters: coerceStringArray(z.array(z.string()).optional().describe("一般不填。作者点名这章要写谁时，填人物名字。")),
  maxTimelineEvents: coerceNumber(z.number().int().nonnegative().optional().describe("一般不填。")),
  contextTokenBudget: coerceNumber(z.number().int().nonnegative().optional().describe("一般不填。")),
  allowWriteAhead: coerceBoolean(z.boolean().optional().describe("前一章没定稿被挡下时，只有作者明确说仍要先写才带 true。")),
  autoDeAi: coerceBoolean(z.boolean().optional().describe("false=检出机器腔只标注、不自动去味（默认自动去味一轮）。")),
  candidates: coerceNumber(z.number().int().min(1).max(3).optional().describe("1–3，默认 1；作者明确要多版才填，耗时和 token 约 N 倍。continue 不用。")),
  authorPicks: coerceBoolean(z.boolean().optional().describe(
    "作者要自己挑（「多写几版给我挑」「另写两版我看看」）才带 true：几版都摆给作者挑，一版都不换进工作稿、不核账，这章有稿也照样写；没填 candidates 就写 2 版。continue 不用。",
  )),
  thenPreview: coerceBoolean(z.boolean().optional().describe("作者明说写完就定稿才带 true：稿写成了系统接着出这一章的定稿清单（作者点「确认定稿」才写入）。")),
});

export const changeDraftTool = createTool({
  id: "change_draft",
  description:
    "写一章正文进工作稿（未定稿），或接着这一章的工作稿往下写（mode=continue）。交出去服务端就按固定步骤做：拟章纲、写、" +
    "字数不够接着写、去 AI 味、核账、按核账改一轮再核，最后换上工作稿（先存档、可撤销）。这一轮到此为止：正文流进稿纸，" +
    "字数、漏写的要点、核账卡、下一步都由系统接着出，你不用再说、也别说已经写完。一条作者消息只交一件事。" +
    "没受理（ok:false）照 summary 如实转告：code=chapter_has_text 是这章已经有稿，按钮随这次结果出给作者了，告诉作者点按钮或说要改哪里，别重试；" +
    "previous_chapter_not_committed 是前一章没定稿，讲清原因、问作者先定稿还是仍要先写（作者明说仍要写才带 allowWriteAhead 再交）；" +
    "chapter_goal_not_author_words 是方向不是作者原话，原样抄作者的话（或不填）再交；nothing_to_continue 是这章还没正文，要从头写就用 write 再交；" +
    "chapter_committed、rereading 照 summary 转告，别重试。",
  inputSchema,
  execute: async (input: z.infer<typeof inputSchema>, context: ToolExecutionContext): Promise<ChangeDraftReceipt> => {
    const bookDir = readProjectDirFromContext(context);
    if (!bookDir) return { ok: false, code: "no_book", summary: "没有打开的书，交不了。" };
    const ref = readMessageRefFromContext(context);
    if (!ref) return { ok: false, code: "no_message_ref", summary: "这条消息没带消息号，交不了：请作者刷新页面后再说一次。" };
    const mode: DraftChangeMode = input.mode ?? "write";
    const fallback = resolveChapterFromInputOrContext(input.chapter, context);
    if (fallback === undefined) return { ok: false, code: "no_chapter", summary: "不知道要写哪一章：请作者说一下章号。" };
    const explicitChapter = Number.isInteger(input.chapter) && (input.chapter as number) > 0;
    // 接着写就是接作者眼前这章，不往下一章推。
    const chapter = mode === "continue" || explicitChapter ? fallback : advancePastCommittedFrontier({
      explicitChapter,
      resolvedChapter: fallback,
      resolvedCommitted: await isChapterCommitted(bookDir, fallback),
      nextChapterCommitted: await isChapterCommitted(bookDir, fallback + 1),
    });
    // 作者要点也是作者原话，和方向一起交章纲员：只交写手的话，章纲员自拟一份纲、写手照纲写，要点被纲盖掉（长篇实跑第 35 章）。
    const goal = authorDirectionOf(input.chapterGoal, input.mustHitBeats);
    const authorWords = readAuthorWordsFromContext(context);
    if (goal && authorWords) {
      const quote = checkAuthorQuote(goal, authorWords);
      if (quote.notFound.length > 0) {
        const shown = quote.notFound.slice(0, 3).map((clause) => `「${clause.slice(0, 30)}」`).join("");
        return {
          ok: false,
          code: "chapter_goal_not_author_words",
          chapter,
          summary: `这次还没动笔：填的本章方向里有不是作者原话的句子${shown}。改用作者的原话（或不填方向、按故事现状往下推）再交。`,
        };
      }
    }
    // 作者在稿纸上方给这一章挑过走法：照它写（和「写这一章」按钮同一口径），作者在对话里另外说的接在后面。
    const direction = withPickedDirection(goal, readPickedDirectionFromContext(context, chapter));
    const read = readDraftChangeParams(mode, {
      chapter,
      direction,
      mustHitBeats: input.mustHitBeats,
      length: input.requestedDraftLength,
      selectedCharacters: input.selectedCharacters,
      maxTimelineEvents: input.maxTimelineEvents,
      contextTokenBudget: input.contextTokenBudget,
      candidates: input.candidates,
      ...(input.authorPicks === true ? { pick: "author" } : {}),
      autoDeAi: input.autoDeAi,
      thenPreview: input.thenPreview,
      allowWriteAhead: input.allowWriteAhead,
    });
    if (!read) return { ok: false, code: "bad_params", summary: "要写哪一章没说清：请给章号。" };
    const outcome = await submitOperation(bookDir, {
      kind: DRAFT_CHANGE_KIND,
      mode: read.mode,
      params: read.params,
      requestKey: `chat:${ref.messageId}`,
      issuedAt: ref.issuedAt,
      origin: { kind: "chat", messageId: ref.messageId, chapter },
    });
    const receipt = receiptOf(outcome, "chat", { kind: DRAFT_CHANGE_KIND, mode: read.mode, chapter });
    if (receipt.ok) return receipt;
    if (receipt.code === "chapter_has_text") {
      const committed = await isChapterCommitted(bookDir, chapter);
      return { ...receipt, chapter, rewriteChoices: rewriteChoices(read.params, committed) };
    }
    if (receipt.code === "previous_chapter_not_committed") return { ...receipt, chapter, pendingChapterToCommit: chapter - 1 };
    return { ...receipt, chapter };
  },
});
