/**
 * edit_fact_ledger —— 写类工具：增删改硬事实账本（story/fact-ledger.json）。
 * 用户在对话里说「把第7章那条改成…/删掉…/记一条…」时由 agent 调用。写前自动建快照，可撤销。
 */
import { buildStateOverview } from "@actalk/story-engine";
import { z } from "zod";
import { coerceEnum, coerceNumber } from "./lenient-args.js";
import { writeTool } from "../withSnapshot.js";
import { applyFactEdit, readFactLedger, CorruptFactLedgerError } from "../fact-ledger/fact-ledger.js";

const inputSchema = z.object({
  // 模型无关：枚举大小写宽容（模型常传 "Add"/"REMOVE"），否则核心写分发偶发硬 InputValidationError。
  op: coerceEnum(z.enum(["add", "update", "remove", "supersede"]).describe(
    "add 新增；update 改（id+text）；remove 删（id）；supersede=某设定从某章起变了（targetText 或 id + chapter）。",
  )),
  id: z.string().optional().describe("update/remove/supersede 的目标条目 id（形如 fact-7-0）。不知道 id 时 supersede 用 targetText 描述即可。"),
  chapter: coerceNumber(z.number().int().positive().optional().describe("add 时该事实属于第几章；supersede 时=从第几章起失效（通常填用户当前所在章）。")),
  text: z.string().optional().describe("add/update 的事实内容（一句话、具体可核对）。"),
  targetText: z.string().optional().describe("supersede 时：要取代的那条旧事实的描述/关键词（如『资金被冻结』），系统据此在账本里找到它，无需你知道 id。"),
  supersededByFactId: z.string().optional().describe("supersede 时可选：被哪条新事实取代（登记演进链）。"),
});

const outputSchema = z.object({
  snapshotId: z.string().describe("写前快照 id，可一键撤销本次改动。"),
  ok: z.boolean(),
  summary: z.string(),
  facts: z.unknown().describe("改后的账本条目，供回答用户。"),
  refreshScope: z.literal("foundation"),
});

export async function editFactLedgerLogic(input: {
  readonly projectDir: string;
  readonly op: "add" | "update" | "remove" | "supersede";
  readonly id?: string;
  readonly chapter?: number;
  readonly text?: string;
  readonly targetText?: string;
  readonly supersededByFactId?: string;
}): Promise<{ readonly ok: boolean; readonly summary: string; readonly facts: unknown }> {
  // 修 P1·3：add 缺章号时从当前章 context 解析（解析不到则交给 applyFactEdit 如实 ok:false，不再默认第 0 章）。
  let chapter = input.chapter;
  if (input.op === "add" && chapter === undefined) {
    const overview = await buildStateOverview({ projectDir: input.projectDir, maxTimelineEvents: 8 }).catch(() => undefined);
    const cur = overview?.project?.currentChapter;
    if (typeof cur === "number" && Number.isInteger(cur) && cur > 0) chapter = cur;
  }
  const { ok, summary } = await applyFactEdit(input.projectDir, input.op, {
    ...(input.id ? { id: input.id } : {}),
    ...(chapter !== undefined ? { chapter } : {}),
    ...(input.text ? { text: input.text } : {}),
    ...(input.targetText ? { targetText: input.targetText } : {}),
    ...(input.supersededByFactId ? { supersededByFactId: input.supersededByFactId } : {}),
  });
  // 末尾重读账本供回答；损坏时 applyFactEdit 已 ok:false，这里不再抛、给空（修 P1·2）。
  let facts: unknown = [];
  try {
    facts = (await readFactLedger(input.projectDir)).facts;
  } catch (error) {
    if (!(error instanceof CorruptFactLedgerError)) throw error;
  }
  return { ok, summary, facts };
}

export const editFactLedgerTool = writeTool({
  id: "edit_fact_ledger",
  description:
    "增删改硬事实账本；某设定变了用 op=supersede。只记客观已确认的事实，角色台词里的威胁、猜测不当事实记。可撤销。",
  inputSchema,
  outputSchema,
  run: async ({ input, projectDir }) => {
    const result = await editFactLedgerLogic({
      projectDir,
      op: input.op,
      ...(input.id ? { id: input.id } : {}),
      ...(input.chapter ? { chapter: input.chapter } : {}),
      ...(input.text ? { text: input.text } : {}),
      ...(input.targetText ? { targetText: input.targetText } : {}),
      ...(input.supersededByFactId ? { supersededByFactId: input.supersededByFactId } : {}),
    });
    return { ...result, refreshScope: "foundation" as const };
  },
});
