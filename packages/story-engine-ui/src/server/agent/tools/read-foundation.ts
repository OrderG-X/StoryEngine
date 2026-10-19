/**
 * read_foundation — 只读：读设定本（重构 P9 改读设定视图：设定卡 + 账里记的现状）。
 *
 * 不带名字 = 全书一览（故事设定、写作规则全给，卡只列名字）；带名字 = 那一张卡的全部（卡上写的、关系、
 * 账里定下的和现状、出场）。读类工具不建快照、不动磁盘。
 */
import { createTool } from "@mastra/core/tools";
import type { ToolExecutionContext } from "@mastra/core/tools";
import { nameKey, readBible, type BibleEntry, type BibleView, type UncardedEntry } from "@actalk/story-core";
import { z } from "zod";

import { blankToUndefined } from "../../lib/lenient-args.js";
import { readProjectDirFromContext } from "../request-context.js";
import { bibleOverviewText, entryText, uncardedText } from "../bible-readable.js";

/** 参数约定（自家格式）：读主角可以直接填这个词。 */
const PROTAGONIST_REF = "主角";

const inputSchema = z.object({
  name: blankToUndefined(z.string().max(80).optional()).describe(
    "可选：人物 / 地点 / 物品 / 设定的名字或别名（读主角可以填「主角」）。不填 = 读全书设定一览。",
  ),
});

const outputSchema = z.object({
  found: z.boolean().describe("带了名字时：找到了没有。不带名字恒为 true。"),
  text: z.string().describe("设定原文（中文，只有名字；标着「AI 补的」的是 AI 写的，改它不用作者点头）。"),
  summary: z.string(),
});

function findEntry(bible: BibleView, ref: string): BibleEntry | UncardedEntry | undefined {
  const all = [...bible.characters, ...bible.places, ...bible.items, ...bible.lore];
  if (ref === PROTAGONIST_REF && bible.protagonist) return all.find((entry) => entry.card.protagonist);
  const key = nameKey(ref);
  return all.find((entry) => [entry.card.name, ...entry.card.aliases, ...entry.ledgerAliases].some((item) => nameKey(item) === key))
    ?? bible.uncarded.find((entry) => [entry.name, ...entry.aliases].some((item) => nameKey(item) === key));
}

export async function readFoundationLogic(input: { readonly projectDir: string; readonly name?: string }): Promise<z.infer<typeof outputSchema>> {
  const { bible } = await readBible(input.projectDir);
  const ref = input.name?.trim();
  if (!ref) {
    const cards = bible.characters.length + bible.places.length + bible.items.length + bible.lore.length;
    return {
      found: true,
      text: bibleOverviewText(bible).join("\n"),
      summary: `设定本：${cards} 张卡${bible.uncarded.length > 0 ? `，账里还有 ${bible.uncarded.length} 个没建卡` : ""}。`,
    };
  }
  const entry = findEntry(bible, ref);
  if (!entry) {
    return {
      found: false,
      text: bibleOverviewText(bible).join("\n"),
      summary: `设定本里没有「${ref}」，账里也没记过。下面是全书一览。`,
    };
  }
  if ("card" in entry) return { found: true, text: entryText(entry).join("\n"), summary: `读了「${entry.card.name}」。` };
  return { found: true, text: uncardedText(entry).join("\n"), summary: `「${entry.name}」还没建卡，下面是账里记的。` };
}

export const readFoundationTool = createTool({
  id: "read_foundation",
  description:
    "读设定本：不带名字读全书一览（故事设定、写作规则、各类卡的名字、账里有还没建卡的）；带名字读那一张卡的全部" +
    "（卡上写的、关系、正文里定下的、账里记的现状、出场章）。问到设定、要改设定之前先读，绝不凭印象。",
  inputSchema,
  outputSchema,
  execute: async (input: z.infer<typeof inputSchema>, context: ToolExecutionContext) => {
    const projectDir = readProjectDirFromContext(context);
    if (!projectDir) {
      throw new Error("read_foundation 缺少 projectDir：请确认调用 agent 时通过 RequestContext 注入了 projectDir。");
    }
    return readFoundationLogic({ projectDir, ...(input.name ? { name: input.name } : {}) });
  },
});
