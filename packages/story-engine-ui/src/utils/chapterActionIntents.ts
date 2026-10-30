/**
 * 结构化动作的对话回显文案，以及「写这一章」的默认目标。
 *
 * 重构 P4 起：按钮直接发结构化动作（utils/chapterButtons.ts），输入框的字一律交给 AI——
 * 不再拿「文字等于按钮文案」认回按钮动作（原 matchDeterministicChapterAction 和那一串按钮文案常量已删）。
 */
import { isDraftEditAction, type DraftEditParamsData } from "../api/agentChatClient.js";

// 「写这一章」按钮直写时的题材中立默认目标：用户没填方向、也没整理方案时，按现有资料/已写章节自然推进，
// 直接出稿——绝不因「没方向」落到「方案整理失败」旧链路（Kimi/Qwen 两轮真机都中：点按钮→方案整理失败）。
// 题材中立（铁律③）：不预设任何题材/世界观，让引擎据项目真实资料写。
export const DIRECT_WRITE_FALLBACK_GOAL = "依据现有故事资料、已写章节与写作规则，自然承接并写出本章正文。";

/** 「写这一章」按钮解析本章目标：有显式方向/方案就用它（trim），空则用题材中立默认目标，**永不返回空**。 */
export function resolveDirectWriteChapterGoal(explicit: string, fallback: string = DIRECT_WRITE_FALLBACK_GOAL): string {
  return explicit.trim() || fallback;
}

/**
 * 结构化动作（按钮、「下一步」选项）点击后落在对话里的「你：…」一句话——动作本身经 body.action 直达服务端，
 * 这句只是对话里给作者看的回显。
 */
export function userActionChoiceText(
  action: import("../api/agentChatClient.js").AgentUserAction,
  /** 「写这一章」照作者挑中的走法写时，那种走法的名字（回显里写明照哪种写）。 */
  directionTitle?: string,
): string {
  return operationActionText(action, directionTitle);
}

/** 等作者点的按钮点了哪个：先按按钮认（「确认改设定」「确认改账」「确认定稿」「全撤」「确认裁剪」），再按选法认（改写的「换上 / 再改一版」）。 */
const ACTION_TEXT: Readonly<Record<string, string>> = {
  "confirm-settings": "确认改设定",
  "confirm-ledger": "确认改账",
  "confirm-canon": "确认定论，改齐前文",
  "confirm-commit": "确认定稿",
  "confirm-undo": "全撤",
  "confirm-prune": "确认裁剪",
};
const DECISION_TEXT: Readonly<Record<string, string>> = { apply: "换上", again: "再改一版" };

const WEIGHT_TEXT = { major: "大伏笔", normal: "普通线索", minor: "小线索" } as const;

/** 直接改账（线索板、梗概上点的）的回显：只有一笔照它说，几笔说几笔（没带标题的说「这条」，不念编号）。 */
function ledgerActionText(changes: readonly import("../api/agentChatClient.js").LedgerChangeData[]): string {
  if (changes.length !== 1) return `改 ${changes.length} 笔账`;
  const change = changes[0]!;
  if (change.op === "summary") return `改第 ${change.chapter} 章的梗概`;
  if (change.op === "day") return `第 ${change.chapter} 章记为故事第 ${change.day} 天`;
  if (change.op === "keepDay") return `第 ${change.chapter} 章的天数以我定的为准`;
  const thread = change.title ? `线索「${change.title}」` : "这条线索";
  return change.op === "resolve" ? `收掉${thread}` : `${thread}定为${WEIGHT_TEXT[change.importance]}`;
}

/** 回显里引一句原文：太长的截短。 */
const quoted = (text: string): string => {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > 40 ? `「${flat.slice(0, 40)}…」` : `「${flat}」`;
};

/** 改稿按钮（片 2C）的回显：按核账改、去 AI 味、改写。 */
function editActionText(params: DraftEditParamsData): string {
  const chapter = params.chapter;
  if (params.mode === "fix") {
    return params.fixes.length === 1 ? `改第 ${chapter} 章这一处：${quoted(params.fixes[0]!.targetText)}` : `改掉第 ${chapter} 章这 ${params.fixes.length} 处`;
  }
  if (params.mode === "deai") {
    return params.violations.length === 1 ? `改掉第 ${chapter} 章这句的机器腔：${quoted(params.violations[0]!.text)}` : `改掉第 ${chapter} 章这 ${params.violations.length} 句的机器腔`;
  }
  return params.edits.length === 1 ? `改写第 ${chapter} 章这段：${quoted(params.edits[0]!.targetText)}` : `改写第 ${chapter} 章这 ${params.edits.length} 段`;
}

/** 点的那个按钮的字。撤销等「全撤」停第二回、第三回的按钮号带着回数（confirm-undo-2），字还是「全撤」。 */
function resumeActionText(actionId: string): string | undefined {
  return ACTION_TEXT[actionId] ?? (actionId.startsWith("confirm-undo-") ? ACTION_TEXT["confirm-undo"] : undefined);
}

/** 操作按钮（写作版本 P2a）的回显：写稿、新检查按种类说；「接着做」「不要了」照按钮字。 */
function operationActionText(action: import("../api/agentChatClient.js").OperationActionData, directionTitle?: string): string {
  if (action.kind === "resume") return action.answer ? (resumeActionText(action.answer.actionId) ?? DECISION_TEXT[action.answer.decision] ?? "接着做") : "接着做";
  if (action.kind === "cancel") return "不要了";
  if (action.type === "settings.change") return "认下 AI 刚写的设定";
  if (action.type === "history.change") return action.mode === "restore" ? "恢复到这个存档" : action.params.opId ? "撤回来" : "撤销上一步";
  if (action.type === "ledger.change") return ledgerActionText(action.params.changes);
  if (action.type === "canon.propose") {
    if (action.mode === "statement") return `按定论查前文：「${action.params.statement}」`;
    const { truth } = action.params;
    return truth.where === "setting" ? `以设定为准：${truth.label}「${truth.quote}」` : `以第 ${truth.chapter} 章为准：「${truth.quote}」`;
  }
  const chapter = action.params.chapter;
  if (action.type === "commit.prepare") return action.params.fill ? `补记第 ${chapter} 章的账` : action.params.allowShort ? `第 ${chapter} 章就这么短，照样定稿` : `定稿第 ${chapter} 章`;
  if (isDraftEditAction(action)) return editActionText(action.params);
  if (action.type === "draft.adopt") return `第 ${chapter} 章换成 AI 写好的那版`;
  if (action.type === "draft.discard") return `第 ${chapter} 章 AI 写好的那版不要了`;
  if (action.type === "plan.propose") {
    const idea = action.params.idea ? `：${action.params.idea}` : "";
    return action.params.avoid?.length ? `第 ${chapter} 章再来几种走法${idea}` : `想想第 ${chapter} 章往哪走${idea}`;
  }
  if (action.type === "draft.change") {
    if (action.mode === "continue") return `第 ${chapter} 章接着往下写`;
    if (action.params.pick === "author") return `第 ${chapter} 章另写几版给我挑`;
    if (action.params.rewrite) return `重写第 ${chapter} 章`;
    return directionTitle ? `照「${directionTitle}」写第 ${chapter} 章的正文` : `写第 ${chapter} 章的正文`;
  }
  switch (action.mode) {
    case "continuity":
      return action.params.fresh ? `再核一遍第 ${chapter} 章的账` : `核第 ${chapter} 章的账`;
    case "review":
      return `审阅第 ${chapter} 章的内容`;
    case "quality":
      return `对第 ${chapter} 章做硬伤检查`;
    case "flavor":
      return `查第 ${chapter} 章的 AI 味`;
  }
}
