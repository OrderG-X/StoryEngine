/**
 * ai-flavor-rules —— 「去AI味」确定性检测的规则数据层（机制进引擎、策略留 UI）。
 *
 * 定位（用户拍板 2026-06-25·与 builtin-anti-ai-rules 同源）：这套确定性闸是**我们的内置规则**，
 * 代码常量、用户看不见删不掉、只我们改常量升级（开源后谁要改自己 fork）。
 * 检测机器（抽整句/同句去重/频率闸/排序/id 形状）已整体下沉引擎 detectAiFlavorViolations
 * （@actalk/story-engine ai-flavor-detection），本模块只剩规则数据 + 薄封装——
 * 语义与旧本地实现逐点一致（引擎头注释列了逐点对齐清单，改规则数据时别动机器语义）。
 *
 * 设计（治「软误报噪音」铁律）：确定性层**只收跨源公认、低误报**的硬毛病——先正则高精度命中，
 * 再叫 LLM 补主观判断（见 ai-flavor-check.ts 的 runAiFlavorCheck 合并）。
 *   - 收：不是…而是壳句式 / 解释腔剧透腔（殊不知·他不知道的是·命运早已）/ 金句升华 / AI 套话禁词。
 *   - **不收**：破折号「——」、省略号「……」——调研实锤是弱/有争议信号（AI 用得比真人还少），
 *     且网文对话里常见，做确定性闸必误报；交给上游 builtin-anti-ai-rules 在生成时规避即可。
 *
 * 输出与 LLM 路同构（AiFlavorViolation）：text=逐字取自草稿的【整句】（供下游「改掉这句」定位）。
 * 纯函数、确定性、题材中立、不调 LLM。
 */
import {
  detectAiFlavorViolations,
  type AiFlavorFrequencyGateRule,
  type AiFlavorPatternRule,
  type AiFlavorRule,
} from "@actalk/story-engine";
import type { AiFlavorViolation } from "./ai-flavor-check.js";

/** 兼容旧导出名：规则类型就是引擎的 AiFlavorRule（判别联合：pattern / frequency_gate）。 */
export type { AiFlavorRule } from "@actalk/story-engine";

/**
 * 内置确定性规则集（pattern 类）。每条都是跨源公认、低误报的硬毛病；severity 体现"该不该硬改"。
 * 改这里＝给用户升级（同步 builtin-anti-ai-rules 的版本观）。
 */
export const BUILTIN_AI_FLAVOR_RULES: readonly AiFlavorPatternRule[] = [
  {
    kind: "pattern",
    id: "not-x-but-y",
    label: "不是…而是 句式",
    severity: "high",
    // 不是X而是Y / 并非X而是Y / 不在于X而在于Y / 与其说X不如说Y。
    // 排除「是不是」「不不是」（反问/口语），靠 (?<![是不]) 负向后顾；要求后面真有「而是/而在于/不如说」才算。
    pattern:
      /(?<![是不])不是[^，。！？\n、；：]{1,18}，?(?:而是|而在于)|并非[^，。！？\n、；：]{1,18}，?(?:而是|而在于)|不在于[^，。！？\n、；：]{1,18}，?而在于|与其说[^，。！？\n、；：]{1,18}，?不如说/gu,
    reason: "AI 最爱的『不是…而是』壳句式（跨中英社区第一高频 tell）",
    suggestedFix: "拆成直述句，直接把结论说出来",
  },
  {
    kind: "pattern",
    id: "explainer-spoiler",
    label: "解释腔/剧透腔",
    severity: "high",
    pattern: /殊不知|(?:他|她|它|她们|他们)不知道的是|多年以后|许多年后|命运早已/gu,
    reason: "上帝视角解释/提前剧透，破坏信息差与代入",
    suggestedFix: "让信息在场景里被人物得知，别由叙述者直接交代",
  },
  {
    kind: "pattern",
    id: "summary-uplift",
    label: "金句升华/替读者下结论",
    severity: "medium",
    pattern: /这一刻[^。！？\n]{0,14}(?:终于)?明白|终于(?:明白|懂得)了什么(?:是|叫)|彰显(?:着|了)?|象征着/gu,
    reason: "替读者下结论、强行拔高升华",
    suggestedFix: "删掉总结句，让读者自己从前文动作里感受",
  },
  {
    kind: "pattern",
    id: "ai-cliche-face",
    label: "AI 套话·表情/心理套路",
    severity: "medium",
    // 表情/心理类最像 AI 的套路词。
    pattern:
      /眼(?:中|里|底)闪过|嘴角(?:微微)?(?:勾起|上扬|一?扬)|眉头(?:微)?皱|瞳孔(?:微)?缩|心(?:中|头|底)(?:一动|一震|一紧|微动)|心中暗(?:道|想|忖)|心底泛起/gu,
    reason: "被用烂的 AI 表情/心理套路词",
    suggestedFix: "换成具体动作或可见细节，别换成另一个形容词",
  },
  {
    kind: "pattern",
    id: "ai-cliche-hedge",
    label: "AI 套话·情态中介词",
    severity: "low",
    // novel-deslop 一级禁用词·情态/判断类（高精度固定词，低误报）：仿佛/犹如… + 一丝/一抹/些许/隐约 + 不易察觉/不可否认…
    pattern: /仿佛|犹如|宛若|宛如|不由自主|情不自禁|五味杂陈|不容置疑|显而易见|毫无疑问|一丝|一抹|些许|几分|隐约|不由得|不易察觉|不可否认|不言而喻/gu,
    reason: "被用烂的 AI 情态/判断中介词",
    suggestedFix: "删掉中介词直写画面，或换成具体动作",
  },
  {
    kind: "pattern",
    id: "ai-cliche-action",
    label: "AI 套话·动作套路",
    severity: "medium",
    // novel-deslop 一级禁用词·动作类最高频套路：深吸一口气 / 倒吸一口凉气。
    pattern: /深(?:深)?(?:地|的)?吸了?一口气|深吸口气|倒吸(?:了)?一口(?:凉|冷)?气/gu,
    reason: "被用烂的 AI 动作套路（深吸一口气类）",
    suggestedFix: "换成具体身体反应（胸口起伏了一下）或直接删掉",
  },
  {
    kind: "pattern",
    id: "omni-adverbial",
    label: "万能状语·带着…的",
    severity: "medium",
    // novel-deslop gate B 万能状语：「，带着X的Y」。要求前置逗号（trailing 状语从句）以降误报。
    pattern: /，带着[^，。！？\n、；：]{2,12}的/gu,
    reason: "AI 惯用的『带着…的』万能状语，把情绪/状态打包成装饰",
    suggestedFix: "拆成独立短句或换成具体动作描写",
  },
];

/**
 * 「虚弱副词扎堆」频率闸（novel-deslop「弱化副词每千字≤3」）：缓缓/微微 这类词单字常用，
 * 出现即报必误报——只在累计 ≥4 处且每千字密度 >3 时报一条，挂在第一处没被模式规则命中的整句上。
 * id 取 "filler-adverb-flood"（与旧硬编码 violation id `aiflavor-rule-filler-adverb-flood` 逐字一致）。
 */
export const FILLER_ADVERB_FLOOD_RULE: AiFlavorFrequencyGateRule = {
  kind: "frequency_gate",
  id: "filler-adverb-flood",
  severity: "low",
  words: ["缓缓", "微微", "轻轻", "淡淡", "默默"],
  maxPerThousandChars: 3,
  minOccurrences: 4,
  label: "虚弱副词扎堆",
  reason: "缓缓/微微/轻轻/淡淡 等弱化副词密度过高（每千字宜≤3）",
  suggestedFix: "删掉大部分弱化副词，只在真有必要时留一两个，多用具体动作",
};

/** 内置规则全量（7 条模式规则 + 虚弱副词频率闸）——generate_draft 回检与 detectAiFlavorRules 共用。 */
export const ALL_BUILTIN_AI_FLAVOR_RULES: readonly AiFlavorRule[] = [
  ...BUILTIN_AI_FLAVOR_RULES,
  FILLER_ADVERB_FLOOD_RULE,
];

/**
 * 用户自定义 antiAiPatterns（writing-rules.json 的字符串数组）→ 引擎 pattern 规则：
 * 字面量匹配（正则元字符转义，用户词是数据不是正则）、severity 一律 low——
 * 用户自定义词误报风险高，给最低档，只提示不硬报。
 */
export function buildUserAntiAiPatternRules(patterns: readonly string[]): readonly AiFlavorRule[] {
  return patterns
    .map((word) => word.trim())
    .filter(Boolean)
    .map((word, index) => ({
      kind: "pattern" as const,
      id: `user-anti-ai-${index}`,
      severity: "low" as const,
      pattern: new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gu"),
      label: "写作规则·自定义反AI词",
      reason: `命中项目写作规则 antiAiPatterns：「${word}」`,
      suggestedFix: "删掉或换个说法",
    }));
}

/**
 * 确定性检测：跑内置规则（薄封装引擎 detectAiFlavorViolations），命中处抽出整句去重，
 * 返回 AiFlavorViolation[]（高→低排序）。同一整句被多条规则命中 → 只留 severity 最高的一条。
 * 返回的 violation 额外带引擎的 ruleId/start/end（draftText.slice(start,end)===text），
 * 下游按 UI AiFlavorViolation 形状消费即可。
 */
export function detectAiFlavorRules(draftText: string): readonly AiFlavorViolation[] {
  return detectAiFlavorViolations(draftText, ALL_BUILTIN_AI_FLAVOR_RULES);
}
