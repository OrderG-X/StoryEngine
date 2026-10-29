/**
 * read_operation（写作版本 P2a 契约第二节）：查某次操作的状态、步骤、结果——作者问「刚才核出来第二处是什么」「补读到哪了」时用。
 * 只读操作记录：不触发任何补读、不拿锁、不写盘。不给操作号就列最近几次（和每轮开头注入的同一份）。
 */
import { createTool, type ToolExecutionContext } from "@mastra/core/tools";
import { z } from "zod";
import { blankToUndefined } from "../../lib/lenient-args.js";
import { isOperationId, readOperation } from "../../lib/operations/store.js";
import { buildOperationSummary, checkedDraftChanged, operationWhat, type OperationSummary } from "../../services/operations/summary.js";
import { operationView, type OperationView } from "../../services/operations/view.js";
import { readProjectDirFromContext } from "../request-context.js";

const inputSchema = z.object({
  opId: blankToUndefined(z.string().max(64).optional().describe("操作号（每轮开头「最近的操作」里列的）。省略就列最近几次。")),
});

export type ReadOperationOutput =
  | { readonly ok: true; readonly what: string; readonly operation: OperationView; readonly draftChanged?: true; readonly summary: string }
  | { readonly ok: true; readonly recent: OperationSummary; readonly summary: string }
  | { readonly ok: false; readonly code: string; readonly summary: string };

export async function readOperationForModel(bookDir: string, opId: string | undefined): Promise<ReadOperationOutput> {
  if (!opId) {
    const recent = await buildOperationSummary(bookDir);
    return { ok: true, recent, summary: recent.operations.length === 0 ? "这本书最近没有操作。" : `最近 ${recent.operations.length} 次操作。` };
  }
  const id = opId.trim();
  const stored = isOperationId(id) ? await readOperation(bookDir, id).catch(() => ({ kind: "absent" as const })) : { kind: "absent" as const };
  if (stored.kind === "tombstone") {
    return { ok: false, code: "cleared", summary: `这次操作早就结束、细节已经清掉了${stored.tombstone.summary ? `；当时的结果：${stored.tombstone.summary}` : "。"}` };
  }
  if (stored.kind !== "record") return { ok: false, code: "absent", summary: "找不到这次操作：操作号对不上，先看每轮开头「最近的操作」里列的。" };
  const view = operationView(stored.record);
  const chapter = (stored.record.params as { readonly chapter?: unknown } | null)?.chapter;
  const what = operationWhat(stored.record.kind, stored.record.mode, typeof chapter === "number" ? chapter : stored.record.origin.chapter);
  const changed = await checkedDraftChanged(bookDir, stored.record);
  const said = view.summary ? `${what}：${view.summary}` : what;
  return {
    ok: true,
    what,
    operation: view,
    ...(changed ? { draftChanged: true as const } : {}),
    summary: changed ? `${said}（查的是改稿前那一版，稿子之后改过）` : said,
  };
}

export const readOperationTool = createTool({
  id: "read_operation",
  description:
    "查某次操作（核账、审阅这类交给服务端做的事）现在怎么样了：在做、停着、做完了、结果是什么。只读，不会让它接着做。" +
    "操作号见每轮开头「最近的操作」；不给就列最近几次。操作号别念给作者。",
  inputSchema,
  execute: async (input: z.infer<typeof inputSchema>, context: ToolExecutionContext): Promise<ReadOperationOutput> => {
    const bookDir = readProjectDirFromContext(context);
    if (!bookDir) return { ok: false, code: "no_book", summary: "没有打开的书。" };
    return readOperationForModel(bookDir, input.opId);
  },
});
