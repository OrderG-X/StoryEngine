/**
 * revise_draft —— 对话里改工作稿里的一段或几段（写作版本 P2a 片 2C，交 draft.change revise）。
 * 和 change_draft 一样只交意图：宽进归一 → 交给执行器 → 回受理回执，受理了这一轮就停；
 * 定位原文、调修订模型、诚实守卫（改了别处、改了等于没改、原文还在）、换上前存档都由服务端做，结论由服务端出。
 *
 * - 一条作者消息只交一次：要改几处都放进 edits（按先后在同一份稿上改）。
 * - 原文要逐字取自工作稿、只出现一次；找不到、不止一处的那段如实说没改成，别的照改。
 * - 作者点名了确切新文本就带 replacementText：原样换上、不调模型。
 * - 题材中立：说明里只用中性词。
 */
import { createTool, type ToolExecutionContext } from "@mastra/core/tools";
import { z } from "zod";
import { coerceEnum, coerceJsonArray, coerceNumber } from "../../lib/lenient-args.js";
import { DRAFT_CHANGE_KIND, EDIT_MAX_REVISIONS, readDraftEditParams } from "../../services/draft-change/params.js";
import { submitOperation } from "../../services/operations/executor.js";
import { readMessageRefFromContext, readProjectDirFromContext, resolveChapterFromInputOrContext } from "../request-context.js";
import { receiptOf, type SubmitReceipt } from "./op-tools.js";

const editSchema = z.object({
  // 模型无关：缺了原文的那条不让整次调用挂在参数校验上，归一时去掉、全没有就如实退回。
  targetText: z.string().optional().describe("要改的原文，必须逐字取自当前工作稿、在稿里只出现一次（先 read_draft 拿正文）。"),
  // 模型无关：给了 replacementText 时模型常不填它，缺省按没给。
  revisionGoal: z.string().optional().describe("往哪改（如「语气更克制」「补一个动作细节」）。给了 replacementText 可不填。"),
  replacementText: z.string().optional().describe("作者点名了确切新文本（「把这句换成『……』」）就填：原样换上、不调模型。要 AI 改写就别填。"),
});

const inputSchema = z.object({
  chapter: coerceNumber(z.number().int().positive().optional().describe("要改的章号；省略=作者当前所在章。")),
  edits: coerceJsonArray(z.array(editSchema).optional()).describe(`这次要改的几处（最多 ${EDIT_MAX_REVISIONS} 处），一处一条。作者一句话里要改几处都放这里，一次交。`),
  // 模型无关：只改一处时模型常把字段直接放在顶层（沿用旧参数形状），照收成一条。
  targetText: z.string().optional().describe("只改一处时也可以直接填这三个字段（同 edits 里的一条）。"),
  revisionGoal: z.string().optional(),
  replacementText: z.string().optional(),
  // 模型无关：枚举大小写宽容（"DeAI" / "DEAI"）。
  style: coerceEnum(z.enum(["deai"]).optional().describe("deai=按去机器腔的手法改（作者要把 AI 味改掉时）。")),
});

type ReviseInput = z.infer<typeof inputSchema>;

/** 模型交的几处归成一份：edits 里的 + 顶层那一处（没原文的去掉）。 */
export function reviseEditsOf(input: Pick<ReviseInput, "edits" | "targetText" | "revisionGoal" | "replacementText">): readonly { readonly targetText: string; readonly revisionGoal?: string; readonly replacementText?: string }[] {
  const top = { targetText: input.targetText, revisionGoal: input.revisionGoal, replacementText: input.replacementText };
  return [...(input.edits ?? []), top].flatMap((edit) => (edit.targetText?.trim() ? [{ ...edit, targetText: edit.targetText }] : []));
}

export const reviseDraftTool = createTool({
  id: "revise_draft",
  description:
    "改某章工作稿里的一段或几段（原文必须逐字取自工作稿、只出现一次）。作者说「把这段改成…… / 修一下这一句 / 这段语气太冲，改克制点」时调用；" +
    "要改几处都放进 edits 一次交。交出去服务端就定位、改写、换上（改前存档、可撤销），这一轮到此为止：结论由系统接着出，你别说已经改好。" +
    "没受理（ok:false）照 summary 如实转告：code=no_draft 是这章还没有工作稿；bad_params 是要改的原文没给或太长，补上再交。",
  inputSchema,
  execute: async (input: ReviseInput, context: ToolExecutionContext): Promise<SubmitReceipt> => {
    const bookDir = readProjectDirFromContext(context);
    if (!bookDir) return { ok: false, code: "no_book", summary: "没有打开的书，交不了。" };
    const ref = readMessageRefFromContext(context);
    if (!ref) return { ok: false, code: "no_message_ref", summary: "这条消息没带消息号，交不了：请作者刷新页面后再说一次。" };
    const chapter = resolveChapterFromInputOrContext(input.chapter, context);
    if (chapter === undefined) return { ok: false, code: "no_chapter", summary: "不知道要改哪一章：请作者说一下章号。" };
    const edits = reviseEditsOf(input);
    if (edits.length === 0) return { ok: false, code: "bad_params", chapter, summary: "没给要改的原文：先 read_draft 拿到正文，逐字抄要改的那段再交。" };
    const params = readDraftEditParams("revise", { chapter, edits, ...(input.style ? { style: input.style } : {}) });
    if (!params) {
      return {
        ok: false,
        code: "bad_params",
        chapter,
        summary: edits.length > EDIT_MAX_REVISIONS
          ? `一次最多改 ${EDIT_MAX_REVISIONS} 处，这次给了 ${edits.length} 处：挑最要紧的先交。`
          : "要改的原文或改法太长了：只抄要改的那一两句再交。",
      };
    }
    const outcome = await submitOperation(bookDir, {
      kind: DRAFT_CHANGE_KIND,
      mode: "revise",
      params,
      requestKey: `chat:${ref.messageId}`,
      issuedAt: ref.issuedAt,
      origin: { kind: "chat", messageId: ref.messageId, chapter },
    });
    const receipt = receiptOf(outcome, "chat", { kind: DRAFT_CHANGE_KIND, mode: "revise", chapter });
    return receipt.ok ? receipt : { ...receipt, chapter };
  },
});
