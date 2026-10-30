/**
 * change_settings —— 改设定本（写作版本 P2a 片 3；收编 foundation_write）。和别的提交工具一样只交意图：
 * 宽进归一 → 交给执行器（settings.change）→ 回受理回执，受理了这一轮就停；改了什么、要作者点「确认改设定」的卡、「认下」按钮都由服务端出。
 * 全是 AI 能做的（建新卡、填空的、改 AI 补的）直接改（存档、可撤销）；碰了作者写的整批停下，等作者点了才改。
 * 退化写法（"" / [] / "true" / 中文类别名、漏写 op）在配方受理时归一（services/settings-change/ops.ts）。
 */
import { createTool, type ToolExecutionContext } from "@mastra/core/tools";
import { MAX_OPS_PER_CHANGE } from "@actalk/story-core";
import { z } from "zod";
import { coerceJsonArray } from "../../lib/lenient-args.js";
import { submitOperation } from "../../services/operations/executor.js";
import { SETTINGS_CHANGE_KIND } from "../../services/operations/recipes/settings-change.js";
import { readMessageRefFromContext, readProjectDirFromContext } from "../request-context.js";
import { receiptOf, type SubmitReceipt } from "./op-tools.js";

const OPS_DESCRIPTION = [
  "要做的改动，按顺序做。每项是一个对象，op 选一个：",
  "card.create {kind: character|place|item|lore, name, aliases?, fields?: [{label, value}], protagonist?}：建卡（人物/地点/物品/其他设定）。",
  "field.set {card, label, value}：卡上某一栏写上/改成 value（value 为空串=删这一栏）。栏名自由起，如 外貌、性格、说话方式、在哪、规矩。",
  "card.aliases {card, add?, remove?}：加/删别名。card.rename {card, name}。card.kind {card, kind}。card.delete {card}。card.protagonist {card}：标成主角。",
  "relation.set {a, b, label}：两张人物卡之间的关系（label 为空串=删）。",
  "story.set {label, value}：故事设定的一栏（一句话、题材、世界规矩……；value 为空串=删）。",
  "rules.set {field: perspective|targetWords|minWords|notes, value}：视角 / 每章目标字数 / 每章至少字数 / 补充（null=删）。",
  "rules.add / rules.remove {list: style|musts|bans|avoid, text}：文风 / 一定要做到 / 一定不要写 / 别用的说法 加一条或删一条。",
  "exemplar.add {text, note?}：存一段作者的文风样本。exemplar.remove {exemplar}。",
  "card / a / b 填卡的名字或别名；同一批里前面新建的卡，后面就能用。",
].join("\n");

const inputSchema = z.object({
  ops: coerceJsonArray(z.array(z.record(z.string(), z.unknown())).min(1).max(MAX_OPS_PER_CHANGE)).describe(OPS_DESCRIPTION),
});

export const changeSettingsTool = createTool({
  id: "change_settings",
  description:
    "改设定本（人物 / 地点 / 物品 / 其他设定卡、关系、故事设定、写作规则、文风样本）。一次可带多步。" +
    "AI 能直接建新卡、填空的栏、改 AI 自己补的；碰了作者写的（改、删、改名、删卡、换主角）整批不改，给作者出「确认改设定」卡，作者点了才改。" +
    "改之前先 read_foundation 看现在写的是什么。不知道的别编，留空。" +
    "交出去服务端就按固定步骤做，这一轮到此为止：改了什么、要不要作者点头都由系统接着说，你不用再说。一条作者消息只交一件事。",
  inputSchema,
  execute: async (input: z.infer<typeof inputSchema>, context: ToolExecutionContext): Promise<SubmitReceipt> => {
    const bookDir = readProjectDirFromContext(context);
    if (!bookDir) return { ok: false, code: "no_book", summary: "没有打开的书，交不了。" };
    const ref = readMessageRefFromContext(context);
    if (!ref) return { ok: false, code: "no_message_ref", summary: "这条消息没带消息号，交不了：请作者刷新页面后再说一次。" };
    const outcome = await submitOperation(bookDir, {
      kind: SETTINGS_CHANGE_KIND,
      params: { ops: input.ops },
      requestKey: `chat:${ref.messageId}`,
      issuedAt: ref.issuedAt,
      origin: { kind: "chat", messageId: ref.messageId },
    });
    return receiptOf(outcome, "chat", { kind: SETTINGS_CHANGE_KIND });
  },
});
