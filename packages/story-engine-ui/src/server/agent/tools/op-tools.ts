/**
 * 提交操作的对话工具（写作版本 P2a 契约第二、三节）：模型只交意图和参数，服务端按固定配方跑完。
 * execute 只做一件事：宽进归一 → 交给执行器 → 回受理回执（`accepted` + 操作号）。受理了这一轮就停（turn-flow），
 * 进度、结果、下一步都由服务端出，模型不再多说一轮。没受理（参数不对、前提不满足）回 ok:false + code + 一句原因，模型照常往下走。
 *
 * 片 1 只有 run_check（收编核账、硬伤检查、内容审阅、查 AI 味）；别的提交工具随各自那一片加。
 */
import { createTool, type ToolExecutionContext } from "@mastra/core/tools";
import { z } from "zod";
import { blankToUndefined, coerceBoolean, coerceEnum, coerceNumber } from "../../lib/lenient-args.js";
import { submitOperation, type SubmitOutcome } from "../../services/operations/executor.js";
import { INSPECT_KIND } from "../../services/operations/recipes/inspect-run.js";
import { operationWhat } from "../../services/operations/view.js";
import { checkAuthorQuote } from "./author-quote.js";
import {
  readAuthorWordsFromContext,
  readMessageRefFromContext,
  readProjectDirFromContext,
  resolveChapterFromInputOrContext,
} from "../request-context.js";

/** 提交操作的对话工具名（turn-flow 按它们判「这一步交了操作」）。 */
export const SUBMIT_TOOL_NAMES: ReadonlySet<string> = new Set(["run_check"]);

/** 受理回执（给模型看、也给界面认「这一步交出去了」）。 */
export interface SubmitReceipt {
  readonly ok: boolean;
  /** 受理了（新受理的、或这条消息早就交过的那次）：界面按 opId 接着显示进度。 */
  readonly accepted?: true;
  readonly opId?: string;
  readonly kind?: string;
  readonly mode?: string;
  readonly chapter?: number;
  /** 这条消息早就交过（重发、模型又调一次）：回的是原来那次，不另开。 */
  readonly existing?: true;
  readonly code?: string;
  readonly summary: string;
}

/**
 * 执行器的结果 → 回执。via：对话里交的（请求号 = 那条作者消息）还是按钮交的（请求号 = 按钮出的时候给的号），两边说法不同。
 * 同一个请求号再交回原来那次（existing）：对话键只认键，模型这次交得不一样也回原来那次（一条消息只做一件）；按钮键换了选择执行器不受理。
 */
export function receiptOf(
  outcome: SubmitOutcome,
  via: "chat" | "button",
  wanted: { readonly kind: string; readonly mode?: string; readonly chapter?: number },
): SubmitReceipt {
  if (!outcome.ok) return { ok: false, code: outcome.code, summary: outcome.message };
  if ("tombstone" in outcome) {
    const result = outcome.tombstone.summary ? `：${outcome.tombstone.summary}` : "。";
    return {
      ok: false,
      code: "already_done",
      summary: via === "chat" ? `这条消息交的那次早就做完了${result}要再做一次，等作者再说一句。` : `这个按钮早就按过、做完了${result}`,
    };
  }
  const { record, existing } = outcome;
  const chapter = (record.params as { readonly chapter?: unknown } | null)?.chapter;
  const what = operationWhat(record.kind, record.mode, typeof chapter === "number" ? chapter : record.origin.chapter);
  const same = record.kind === wanted.kind && record.mode === wanted.mode && chapter === wanted.chapter;
  return {
    ok: true,
    accepted: true,
    opId: record.opId,
    kind: record.kind,
    ...(record.mode !== undefined ? { mode: record.mode } : {}),
    ...(typeof chapter === "number" ? { chapter } : {}),
    ...(existing ? { existing: true as const } : {}),
    // 作者在步骤卡上看得到这句；模型这一轮看不到（受理那一步走完这一轮就停）。
    summary: !existing
      ? `交出去了：${what}。`
      : same
        ? `${what}已经交过了，接着看原来那次。`
        : `这条消息已经交过别的事（${what}），一条消息只做一件：这件没交，接着看原来那次。`,
  };
}

function noBook(): SubmitReceipt {
  return { ok: false, code: "no_book", summary: "没有打开的书，交不了。" };
}

function noMessageRef(): SubmitReceipt {
  return { ok: false, code: "no_message_ref", summary: "这条消息没带消息号，交不了：请作者刷新页面后再说一次。" };
}

const runCheckInput = z.object({
  mode: coerceEnum(z.enum(["continuity", "quality", "review", "flavor"]).describe(
    "做哪种检查：continuity=核账（这一章和前文、设定对不对得上，前后吃书）；quality=硬伤检查（空稿、太短、缺标题这类确定性检查）；" +
      "review=内容审阅（剧情、节奏、人物、对白、读者钩子，给评分和改进建议）；flavor=查 AI 味（挑出机器腔的句子，只看不改）。",
  )),
  chapter: coerceNumber(z.number().int().positive().optional().describe("哪一章；省略时用作者当前所在章。")),
  fresh: coerceBoolean(z.boolean().optional().describe("只给核账：正文没改也重新核（作者说「再细核一遍」）。缺省时正文和前文都没改就直接给上次结果。")),
  focus: blankToUndefined(z.string().max(500).optional().describe(
    "只给内容审阅：作者说的审稿重点，原样抄作者的话（例如作者说「重点看节奏」就填「重点看节奏」）；不是作者原话的不收。没说就不填。",
  )),
});

export const runCheckTool = createTool({
  id: "run_check",
  description:
    "检查一章：核账 / 硬伤检查 / 内容审阅 / 查 AI 味（mode 选一种）。只读，不改正文、不改账。" +
    "交出去服务端就按固定步骤做，这一轮到此为止：进度、结果卡、下一步都由系统接着出，你不用再说、也别说已经做完。" +
    "一条作者消息只交一件事。",
  inputSchema: runCheckInput,
  execute: async (input: z.infer<typeof runCheckInput>, context: ToolExecutionContext): Promise<SubmitReceipt> => {
    const bookDir = readProjectDirFromContext(context);
    if (!bookDir) return noBook();
    const ref = readMessageRefFromContext(context);
    if (!ref) return noMessageRef();
    const chapter = resolveChapterFromInputOrContext(input.chapter, context);
    if (chapter === undefined) return { ok: false, code: "no_chapter", summary: "不知道要检查哪一章：请作者说一下章号。" };
    // 审稿重点要是作者原话（规矩 5）：核不上的不收、如实说，不让模型改成原话重调。
    let focusNote = "";
    let userDirection: string | undefined;
    if (input.mode === "review" && input.focus?.trim()) {
      const check = checkAuthorQuote(input.focus, readAuthorWordsFromContext(context) ?? []);
      if (check.notFound.length === 0 && check.quoted.length > 0) userDirection = input.focus.trim();
      else focusNote = "审稿重点不是作者原话，这次没带上。";
    }
    const params = {
      chapter,
      ...(input.mode === "continuity" && input.fresh === true ? { fresh: true } : {}),
      ...(userDirection ? { userDirection } : {}),
    };
    const outcome = await submitOperation(bookDir, {
      kind: INSPECT_KIND,
      mode: input.mode,
      params,
      requestKey: `chat:${ref.messageId}`,
      issuedAt: ref.issuedAt,
      origin: { kind: "chat", messageId: ref.messageId, chapter },
    });
    const receipt = receiptOf(outcome, "chat", { kind: INSPECT_KIND, mode: input.mode, chapter });
    return focusNote ? { ...receipt, summary: `${receipt.summary}${focusNote}` } : receipt;
  },
});
