/**
 * prepare_commit —— 定稿（写作版本 P2a 片 4A；收编 commit_preview）。作者想定稿时只交意图：交给执行器（commit.prepare）→
 * 回受理回执，受理了这一轮就停。服务端过硬闸、让记账员记这一章的账，出定稿清单（和稿纸上「定稿」按钮出的同一份），
 * 作者在清单上点「确认定稿」才写入（作者档、写前存档、可撤销）。对话 AI 没有别的定稿路子。
 * 补账（fill，写作版本 P2b）：定稿时账没记上 / 没记全的那章，按定稿那版正文补记，出补账清单，作者点「确认记账」才记，正文不动。
 */
import { createTool, type ToolExecutionContext } from "@mastra/core/tools";
import { z } from "zod";
import { coerceBoolean, coerceNumber } from "../../lib/lenient-args.js";
import { submitOperation } from "../../services/operations/executor.js";
import { COMMIT_PREPARE_KIND } from "../../services/operations/recipes/commit-prepare.js";
import { readMessageRefFromContext, readProjectDirFromContext, resolveChapterFromInputOrContext } from "../request-context.js";
import { receiptOf, type SubmitReceipt } from "./op-tools.js";

const inputSchema = z.object({
  chapter: coerceNumber(z.number().int().positive().optional().describe("要定稿的章号；省略时用作者当前所在章。")),
  fill: coerceBoolean(z.boolean().optional().describe("true=补账：这章定稿时账没记上 / 没记全，按定稿那版正文补记（正文不动）。")),
});

export const prepareCommitTool = createTool({
  id: "prepare_commit",
  description:
    "作者想定稿（入库）某一章时调用：交出去服务端过一遍硬伤、让记账员记这一章的账（谁出场、出了什么事、线索、第几天），出一张定稿清单给作者看。" +
    "交出去不会马上定稿：作者在清单上点「确认定稿」才写入。定不了（没稿、太短）的原因也在清单上；记账员没记成时卡上给作者「再记一次」「先定正文、账待记」。" +
    "作者要补记某章的账（概况里说那章账没记上 / 没记全）时带 fill:true：出补账清单，作者点「确认记账」才记，正文不动。" +
    "交出去服务端就按固定步骤做，这一轮到此为止：清单、结论、下一步都由系统接着出，你不用再说，绝不说『已定稿』。一条作者消息只交一件事。",
  inputSchema,
  execute: async (input: z.infer<typeof inputSchema>, context: ToolExecutionContext): Promise<SubmitReceipt> => {
    const bookDir = readProjectDirFromContext(context);
    if (!bookDir) return { ok: false, code: "no_book", summary: "没有打开的书，交不了。" };
    const ref = readMessageRefFromContext(context);
    if (!ref) return { ok: false, code: "no_message_ref", summary: "这条消息没带消息号，交不了：请作者刷新页面后再说一次。" };
    const chapter = resolveChapterFromInputOrContext(input.chapter, context);
    if (chapter === undefined) return { ok: false, code: "no_chapter", summary: input.fill ? "不知道要补哪一章的账：请作者说一下章号。" : "不知道要定稿哪一章：请作者说一下章号。" };
    const outcome = await submitOperation(bookDir, {
      kind: COMMIT_PREPARE_KIND,
      params: { chapter, ...(input.fill ? { fill: true } : {}) },
      requestKey: `chat:${ref.messageId}`,
      issuedAt: ref.issuedAt,
      origin: { kind: "chat", messageId: ref.messageId, chapter },
    });
    return receiptOf(outcome, "chat", { kind: COMMIT_PREPARE_KIND, chapter });
  },
});
