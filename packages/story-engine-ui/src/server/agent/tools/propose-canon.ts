/**
 * propose_canon —— 定论（写作版本 P2a 片 3C；收编 settle_fact）。作者定下一个说法（「杜叔是十年前走的，以这个为准」）时只交意图：
 * 宽进归一 → 交给执行器（canon.propose）→ 回受理回执，受理了这一轮就停。服务端查全书哪几句和它对不上、设定本和账里哪些跟着改，
 * 出一张定论卡（和核账卡上「以第 N 章为准」出的同一张），作者点「确认」才一次改齐（作者档、可撤销）。
 */
import { createTool, type ToolExecutionContext } from "@mastra/core/tools";
import { z } from "zod";
import { CANON_TEXT_MAX } from "@actalk/story-core";
import { blankToUndefined, coerceNumber } from "../../lib/lenient-args.js";
import { submitOperation } from "../../services/operations/executor.js";
import { CANON_PROPOSE_KIND } from "../../services/operations/recipes/canon-propose.js";
import { readMessageRefFromContext, readProjectDirFromContext, resolveChapterFromInputOrContext } from "../request-context.js";
import { receiptOf, type SubmitReceipt } from "./op-tools.js";

const inputSchema = z.object({
  canon: z.string().trim().min(1).max(CANON_TEXT_MAX).describe("作者定下的说法，尽量用作者的原话（一句话说清是什么，如『杜长顺十年前去世』）；谁、哪儿写全名，单拿出来也看得懂——作者话里省掉的主语、地方照前文补上，「我爸」「她妈」这类称呼写成那个人卡上的名字，别留「那里」「这场」这种离了上下文就两可的说法。只写这件事本身：不写章号、不写「以…为准」「只管…」「不涉及…」这类说明（它原样记进设定本）。"),
  chapter: coerceNumber(blankToUndefined(z.number().int().positive().optional().describe("作者此刻在写的章号；缺省用当前章。这一章有工作稿时连工作稿一起查。"))),
});

export const proposeCanonTool = createTool({
  id: "propose_canon",
  description:
    "作者定下某个说法、要全书以它为准时调用（如『杜叔是十年前走的，以这个为准』『前面写错了，统一成……』『那条定论过时了，改成……』）：" +
    "交出去服务端查全书哪几句和它对不上、设定本和账里哪些要跟着改，出一张定论卡给作者看（改的是设定本里已有的定论时，卡上会换掉旧的那条）。交出去不会马上改，作者在卡上点「确认」才改齐。" +
    // 换题材长篇实跑 2026-10-27：同一条连查了两遍（第二遍只换了措辞），白等一分钟。
    "只在作者明说要定下来时调，别替作者定。一条定论调一次：卡出了就等作者点，别为换个措辞再调一遍。" +
    "交出去服务端就按固定步骤做，这一轮到此为止：查到几处、要作者点的卡都由系统接着说，你不用再说，绝不说『已改齐』。一条作者消息只交一件事。",
  inputSchema,
  execute: async (input: z.infer<typeof inputSchema>, context: ToolExecutionContext): Promise<SubmitReceipt> => {
    const bookDir = readProjectDirFromContext(context);
    if (!bookDir) return { ok: false, code: "no_book", summary: "没有打开的书，交不了。" };
    const ref = readMessageRefFromContext(context);
    if (!ref) return { ok: false, code: "no_message_ref", summary: "这条消息没带消息号，交不了：请作者刷新页面后再说一次。" };
    const chapter = resolveChapterFromInputOrContext(input.chapter, context);
    const outcome = await submitOperation(bookDir, {
      kind: CANON_PROPOSE_KIND,
      mode: "statement",
      params: { statement: input.canon, ...(chapter !== undefined ? { chapter } : {}) },
      requestKey: `chat:${ref.messageId}`,
      issuedAt: ref.issuedAt,
      origin: { kind: "chat", messageId: ref.messageId },
    });
    return receiptOf(outcome, "chat", { kind: CANON_PROPOSE_KIND, mode: "statement", ...(chapter !== undefined ? { chapter } : {}) });
  },
});
