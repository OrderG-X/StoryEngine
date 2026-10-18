/**
 * 工具结果「给界面的」和「给模型的」分开（2026-10-10 自审：一章约 20 万输入 token，八成是对话 AI 在烧——
 * 18 个工具把 7–8k 的状态总览塞回结果，出稿 / 改稿 / 定稿还带整章正文；一轮多步时这些在后续每一步里反复重发）。
 *
 * 界面照旧拿完整结果（SSE tool-result 原样转发、写作区刷新靠它）；模型只看去掉总览与正文的精简版。
 * 读类工具（read_*）的本职就是把资料给模型看，原样保留。
 * 定稿预览：整份引擎计划（几千字的 JSON）不给模型，给它账本清单的人话标签就够转述（界面本来就不用 plan）。
 */

/** 读类工具：结果就是给模型读的，不精简。 */
const READ_TOOLS = new Set(["read_state_overview", "read_chapters_overview", "read_timeline", "read_foundation", "read_draft"]);

/** 只给界面用、模型不需要的字段。 */
const UI_ONLY_FIELDS = new Set(["overview", "refreshScope"]);

/** 整章正文：模型要看原文就调 read_draft，结果里只留字数。 */
const BODY_FIELDS = new Set(["draftBody"]);

function countHan(text: string): number {
  // 不猜白名单：切句
  return (text.match(/[㐀-鿿]/gu) ?? []).length;
}

/** 给模型看的精简结果（非对象原样返回）。 */
export function slimToolOutputForModel(toolName: string, output: unknown): unknown {
  if (READ_TOOLS.has(toolName)) return output;
  if (!output || typeof output !== "object" || Array.isArray(output)) return output;
  const slim: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(output as Record<string, unknown>)) {
    if (UI_ONLY_FIELDS.has(key)) continue;
    if (BODY_FIELDS.has(key)) {
      if (typeof value === "string" && value.trim()) {
        slim.draftChars = countHan(value);
        slim.draftBodyNote = "正文已写进工作稿，这里不重复给；要逐字引用原文就调 read_draft。";
      }
      continue;
    }
    if (toolName === "commit_preview" && key === "plan") continue;
    if (key === "ledgerChecklist" && Array.isArray(value)) {
      slim.ledgerChecklist = value.map((item) => (item && typeof item === "object" ? (item as { label?: unknown }).label : item));
      continue;
    }
    slim[key] = value;
  }
  return slim;
}

/** 给工具表里每个工具挂上「给模型的精简版」（Mastra toModelOutput：界面拿原结果，模型看这个）。 */
export function withSlimModelOutput<T extends Record<string, object>>(tools: T): T {
  for (const [name, tool] of Object.entries(tools)) {
    if (READ_TOOLS.has(name)) continue;
    Object.assign(tool, {
      toModelOutput: (output: unknown) => ({ type: "json", value: slimToolOutputForModel(name, output) as never }),
    });
  }
  return tools;
}
