/**
 * plan_chapter —— 想这一章往哪走（写作版本 P2a 片 2D；收编原来的 brainstorm_chapter）。和 run_check 一样只交意图：
 * 宽进归一 → 交给执行器（plan.propose）→ 回受理回执，受理了这一轮就停；章纲员出几种走法、核账员替每种对前文、
 * 走法卡、下一步都由服务端出。只读：不落章纲、不进账。
 *
 * 留在工具这层的只有对话才有的事：章号（模型没给用作者所在章）；作者的想法要是作者原话（规矩 5）：核不上就不带、如实说，
 * 照故事现状想（只是想几种走法，不为这个退回重交）。别的前提（导入的书在记账、模型没配）由配方受理前判。
 */
import { createTool, type ToolExecutionContext } from "@mastra/core/tools";
import { z } from "zod";
import { coerceNumber, coerceStringArray } from "../../lib/lenient-args.js";
import { submitOperation } from "../../services/operations/executor.js";
import { PLAN_PROPOSE_KIND, readPlanProposeParams } from "../../services/operations/recipes/plan-propose.js";
import {
  readAuthorWordsFromContext,
  readMessageRefFromContext,
  readProjectDirFromContext,
  resolveChapterFromInputOrContext,
} from "../request-context.js";
import { checkAuthorQuote } from "./author-quote.js";
import { receiptOf, type SubmitReceipt } from "./op-tools.js";

const inputSchema = z.object({
  chapter: coerceNumber(z.number().int().positive().optional().describe("想第几章；省略=作者当前所在章。")),
  idea: z.string().optional().describe("作者对这章的想法原话（可空；空=按故事现状想）。只抄作者的话，别自己编；不是原话的不带。"),
  avoid: coerceStringArray(z.array(z.string()).optional().describe("「再来几种」时已经给过的走法名字；一般不填。")),
});

export const planChapterTool = createTool({
  id: "plan_chapter",
  description:
    "想走法：章纲员按读过的前文给这一章出几种不同的走法（每种几步、推进哪些线索），核账员替每种对过前文；作者在稿纸上挑一种。" +
    "只读，不写任何文件。作者问『这章怎么写 / 往哪走 / 给我几个思路 / 下一章有什么走法』时调用；作者要正文就调 change_draft。" +
    "交出去服务端就按固定步骤做，这一轮到此为止：走法卡、下一步都由系统接着出，你不用再说、也别替作者编走法。一条作者消息只交一件事。",
  inputSchema,
  execute: async (input: z.infer<typeof inputSchema>, context: ToolExecutionContext): Promise<SubmitReceipt> => {
    const bookDir = readProjectDirFromContext(context);
    if (!bookDir) return { ok: false, code: "no_book", summary: "没有打开的书，交不了。" };
    const ref = readMessageRefFromContext(context);
    if (!ref) return { ok: false, code: "no_message_ref", summary: "这条消息没带消息号，交不了：请作者刷新页面后再说一次。" };
    const chapter = resolveChapterFromInputOrContext(input.chapter, context);
    if (chapter === undefined) return { ok: false, code: "no_chapter", summary: "不知道要想第几章：请作者说一下章号。" };
    let ideaNote = "";
    let idea: string | undefined;
    if (input.idea?.trim()) {
      const check = checkAuthorQuote(input.idea, readAuthorWordsFromContext(context) ?? []);
      if (check.notFound.length === 0 && check.quoted.length > 0) idea = input.idea.trim();
      else ideaNote = "填的想法不是作者原话，这次没带上，照故事现状想。";
    }
    const params = readPlanProposeParams({ chapter, ...(idea ? { idea } : {}), ...(input.avoid ? { avoid: input.avoid } : {}) });
    if (!params) return { ok: false, code: "bad_params", summary: "要想哪一章没说清：请给章号。" };
    const outcome = await submitOperation(bookDir, {
      kind: PLAN_PROPOSE_KIND,
      params,
      requestKey: `chat:${ref.messageId}`,
      issuedAt: ref.issuedAt,
      origin: { kind: "chat", messageId: ref.messageId, chapter },
    });
    const receipt = receiptOf(outcome, "chat", { kind: PLAN_PROPOSE_KIND, chapter });
    return ideaNote ? { ...receipt, summary: `${receipt.summary}${ideaNote}` } : receipt;
  },
});
