import type { DraftRevisionTask } from "../../api/types.js";

/**
 * 选区浮动操作条的 6 个固定指令模板（阶段三块②）。
 * 每个按钮 = 一条固定的 revisionGoal，喂给现成的 draft-revision 路由（按选中片段改写、写前快照、可撤销）。
 * 这些是 V2「Skill 系统」的地基；V1 不开放用户自建。模板**题材中立**——只写作工艺、不含任何题材专名。
 */

export type SelectionRevisionKey = "polish" | "rewrite" | "deai" | "expand" | "condense" | "continue" | "custom";

export interface SelectionRevisionTemplate {
  readonly key: SelectionRevisionKey;
  readonly label: string;
  readonly problemSummary: string;
  readonly revisionGoal: string;
  /** true=不渲染成预设按钮（如 custom「自己说」走独立输入入口，goal 由用户要求经 extraGoal 填）。 */
  readonly hidden?: boolean;
}

export const SELECTION_REVISION_TEMPLATES: readonly SelectionRevisionTemplate[] = [
  {
    key: "polish",
    label: "润色",
    problemSummary: "用户选中一段正文，要求润色。",
    revisionGoal:
      "在不改变情节、人物、设定与事实的前提下润色这段文字：让语言更流畅、节奏更自然、用词更精准，"
      + "保持原有篇幅与叙事视角，不增删情节、不引入新角色或新设定。",
  },
  {
    key: "rewrite",
    label: "改写",
    problemSummary: "用户选中一段正文，要求换一种写法。",
    revisionGoal:
      "保留这段文字的核心意思与全部关键信息，换一种表达方式重写：可调整句式、措辞与展开顺序，"
      + "但不得改变情节走向、人物设定与既有事实，篇幅大致相当。",
  },
  {
    key: "deai",
    label: "去机器腔",
    problemSummary: "用户选中一段正文，要求去掉 AI 腔。",
    revisionGoal:
      "改写这段文字，去掉常见的 AI 腔：删掉空泛的形容词堆砌、套路化的排比与升华总结句、"
      + "「仿佛 / 似乎 / 不禁 / 那一刻 / 心中五味杂陈」之类被滥用的过渡与抒情；"
      + "改用具体的动作、可感的细节和有长短变化的句子，让它读起来像人写的、有呼吸和留白。"
      + "情节、人物、事实、视角一律不变，篇幅大致相当。",
  },
  {
    key: "expand",
    label: "扩写",
    problemSummary: "用户选中一段正文，要求扩写。",
    revisionGoal:
      "在不改变情节走向的前提下扩写这段文字：补充感官细节、动作、心理或环境描写，让画面更丰满。"
      + "新增内容必须与已有设定、人物和事实一致，不得引入新的情节冲突、新角色或新设定。",
  },
  {
    key: "condense",
    label: "缩写",
    problemSummary: "用户选中一段正文，要求精简。",
    revisionGoal:
      "在保留关键信息与情节推进的前提下精简这段文字：删掉冗余、重复和不必要的修饰，让它更紧凑有力，"
      + "篇幅明显缩短，但不得丢失任何对后续有用的事实或伏笔。",
  },
  {
    key: "continue",
    label: "续写",
    problemSummary: "用户选中一段正文，要求接着往下写。",
    revisionGoal:
      "在这段文字之后自然地续写下去：原文一字不改地保留，紧接着往下写一小段，"
      + "承接当前的情节、情绪、场景与视角，风格与前文一致。输出必须是「原文 + 续写部分」的完整文本。",
  },
  {
    // 「自己说」：不渲染成预设按钮，走浮动条上的独立输入入口。基底只给安全框，
    // 用户的具体要求经 extraGoal 拼成「针对本句的具体方向：…」驱动改写。
    key: "custom",
    label: "自己说",
    hidden: true,
    problemSummary: "用户选中一段正文，并给出自己的改写要求。",
    revisionGoal:
      "按用户提出的具体要求改写这段文字。在满足用户要求的前提下，不改变情节走向、人物设定与既有事实，"
      + "叙事视角保持一致；除非用户明确要求增减篇幅，否则篇幅大致相当。",
  },
];

/** 浮动操作条上要渲染成按钮的预设（排除 custom 这种走独立输入入口的）。 */
export const VISIBLE_SELECTION_REVISION_TEMPLATES: readonly SelectionRevisionTemplate[] =
  SELECTION_REVISION_TEMPLATES.filter((template) => !template.hidden);

/**
 * 由选区文本 + 模板键构建一条 DraftRevisionTask（喂给 /api/draft/revision/preview）。
 * 选区为空或模板键非法 → 返回 null（调用方据此明示，不发请求）。targetText 保持选区原样
 * （路由侧自己 trim 做唯一性匹配），只在整体空白时拒绝。
 */
/**
 * 选区改写的 preview 是不是「没改动」（模型调用失败时 draft-revision 会返回 afterText===beforeText 的安全兜底，
 * 或模型没产出改动）。选区改写是用户显式要求改写，no-op 一律视为「没改成」——调用方据此**跳过 apply、诚实报失败**，
 * 绝不把兜底 no-op 当成功 apply、绝不谎报「已改写」。
 */
export function isNoOpRevisionPreview(preview: { readonly beforeText: string; readonly afterText: string }): boolean {
  return preview.afterText.trim() === preview.beforeText.trim();
}

export function buildSelectionRevisionTask(input: {
  readonly selectionText: string;
  readonly key: SelectionRevisionKey;
  readonly chapter: number;
  /** 额外改写方向（如去 AI 味体检给这句的 suggestedFix）。非空时拼在模板目标之后，不替换模板目标。 */
  readonly extraGoal?: string;
}): DraftRevisionTask | null {
  const template = SELECTION_REVISION_TEMPLATES.find((item) => item.key === input.key);
  if (!template || !input.selectionText.trim()) return null;
  const extra = input.extraGoal?.trim();
  const revisionGoal = extra
    ? `${template.revisionGoal}\n\n针对本句的具体方向：${extra}`
    : template.revisionGoal;
  return {
    id: `selection-rewrite-${template.key}-ch${input.chapter}`,
    chapter: input.chapter,
    targetType: "section",
    targetText: input.selectionText,
    problemSummary: template.problemSummary,
    revisionGoal,
    constraints: [],
    status: "pending",
  };
}
