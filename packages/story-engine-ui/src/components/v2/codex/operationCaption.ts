/**
 * 不走对话的那几步（内容审阅 / 硬伤检查 / 修改方案 / 定稿预览…）跑的时候，AI 栏要看得见在干什么。
 * 这些操作以前只挂一条看不见的 system 消息，推理模型审一章要好几分钟，期间对话区一片空白像卡死。
 * 纯函数：按进行中的操作给一句人话；不认识的操作给通用说法。
 */
const CAPTIONS: Readonly<Record<string, string>> = {
  "ai-review": "正在做内容审阅，推理模型可能要几分钟",
  "quality-check": "正在做硬伤检查",
  "revision-preview": "正在准备修改方案",
  "revision-apply": "正在把修改用到工作稿",
  "commit-preview": "正在生成定稿预览",
  "commit-apply": "正在定稿",
  "generate-draft": "正在写稿",
  "reroll-candidates": "正在再写一版",
  "apply-candidate": "正在换用这一版",
  "deai-fix-all": "正在去 AI 味",
  "direct-edit": "正在改稿",
};

/** 选区改写按钮（selection-rewrite-<key>）对应的动作名。 */
const SELECTION_ACTIONS: Readonly<Record<string, string>> = {
  polish: "润色", rewrite: "改写", deai: "去 AI 味", expand: "扩写", condense: "缩写", continue: "续写", custom: "改写",
};

export function operationCaption(loading: string | null | undefined): string | null {
  if (!loading) return null;
  const selection = /^selection-rewrite-(.+)$/u.exec(loading);
  if (selection) return `正在${SELECTION_ACTIONS[selection[1]!] ?? "改写"}选中的段落`;
  return CAPTIONS[loading] ?? "正在处理";
}

/** 消息上那张进行中的卡（startAgentFlow 挂的 running 卡）。 */
export function runningAgentCard<T extends { readonly status?: string; readonly title?: string; readonly summary?: string }>(
  cards: readonly T[] | undefined,
): T | null {
  return cards?.find((card) => card.status === "running") ?? null;
}
