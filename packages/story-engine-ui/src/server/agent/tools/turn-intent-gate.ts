// 定稿（commit_apply）不再走本文件的文本意图门（2026-10-07）：真写盘只由用户点「确认定稿」按钮的
// 结构化动作授权（agent/user-actions.ts），模型发起的调用只出确认按钮——用正则猜中文授权说法追不完。

// 快照裁剪（prune_snapshots）同样改成按钮授权（2026-10-07）：模型只预览，用户点「确认裁剪」才真裁——
// 原来与定稿门共用的「子句极性」正则引擎随之整体删除。

// 写正文/续写意图（放行 generate_draft）。治「入库后模型自主续写下一章」——那一轮用户原话只有
// 定稿/审稿等意图、没有任何写作意图，模型却擅自 generate_draft。与 commit_apply 门对称：缺原话放行、
// 有原话但无写作意图则拦。注意：这道门只在模型「真的去调 generate_draft」时才生效，故 pattern 从宽——
// 只要覆盖常见的「写/继续/下一章/写吧/重写/扩写」，把「确认定稿/审稿/查AI味/理资料/清线索」这些纯非写作轮排除即可。
// 章号必须同时认阿拉伯与中文数字（复审 P1：「请把第八章写出来」曾被误拦）。
const CH_NUM = "[0-9一二三四五六七八九十百千零两]+";
const DRAFT_WRITE_PATTERNS = [
  /写[^。！？；\n]{0,8}(?:正文|草稿|初稿|开头|结尾|片段|场景)/u,
  new RegExp(`写[^。！？；\\n]{0,6}(?:这一?章|本章|这章|第\\s*${CH_NUM}\\s*章|下一?章|一段)`, "u"),
  // 宾语前置：「（请）把第八章写出来 / 第8章写完 / 第八章续上」
  new RegExp(`(?:把|将)?第\\s*${CH_NUM}\\s*章[^。！？；\\n]{0,8}(?:写出来|写完|写好|续上|写)`, "u"),
  // 「继续第八章 / 接着第8章」
  new RegExp(`(?:继续|接着)[^。！？；\\n]{0,4}第\\s*${CH_NUM}\\s*章`, "u"),
  /(?:继续|接着|往下|接下去|接下来)[^。！？；\n]{0,6}写/u,
  /^(?:好[，,]?)?继续(?:$|[，,。！？\s])/u,
  /下一章/u,
  /(?:重写|再写|重新写)/u,
  /写吧/u,
  /(?:开始写|动笔|出一?版)/u,
  /扩写/u,
  /写出来/u,
  new RegExp(`(?:创作|撰写)[^。！？；\\n]{0,6}(?:第\\s*${CH_NUM}\\s*章|正文|这一?章|下一?章)`, "u"),
];

// R7.1（十章试写报告 3.1，2026-10-14）：写作门的否定词否决整体拆除——DRAFT_WRITE_NEGATION_PATTERN /
// DRAFT_WRITE_TRAILING_VETO / DRAFT_WRITE_SCOPE_LIMIT 三套子句极性正则一并删掉。作者打字的回合
// 命中上面的正向表即放行：角色台词「谁也别想再动它」「先别写信给他」曾命中「别…动/写」被误拦，
// 第 9 章两次没写成。防「定稿后模型自主续写」的用途不变：原话一点写作说法都没有的回合
// （「确认定稿」「核账」「预览定稿」）照旧拦；界面按钮/选项点出来的出稿带 body.action 结构化动作，
// generate_draft 工具见用户确认标记优先放行（user-actions.ts 的 runGenerateDraftAction）。
// 不再用正则猜中文否定说法（CLAUDE.md 铁律），代价见任务单 R7.1 报告。

const THREAD_CLEANUP_PATTERNS = [
  /(?:清理|归并|收拢|合并|整理)[^。！？；\n]{0,12}线索/u,
  /线索[^。！？；\n]{0,12}(?:清理|归并|收拢|合并|太乱|重复)/u,
];

const THREAD_CLEANUP_NEGATION_PATTERN = /(?:先)?(?:别|不要|先不|暂不|无需|不用)[^，。；！？\n]{0,8}(?:清理|归并|收拢|合并|整理)?[^，。；！？\n]{0,8}线索/u;

const THREAD_RESOLVE_PATTERNS = [
  /(?:把|将)?[^。！？；\n]{0,24}(?:线索|伏笔|那条|这条)[^。！？；\n]{0,24}(?:收口|收掉|完结|标记完成|已经完了|结束了)/u,
  /(?:收口|收掉|完结|标记完成)[^。！？；\n]{0,24}(?:线索|伏笔|那条|这条)/u,
  /[^。！？；\n]{1,24}(?:这条|那条)?[^。！？；\n]{0,8}(?:已经完了|已经结束|已完成)/u,
];

const THREAD_RESOLVE_NEGATION_PATTERN = /(?:先)?(?:别|不要|先不|暂不|无需|不用|没|还没|未)[^，。；！？\n]{0,12}(?:收口|收掉|完结|标记完成|完成|完了|结束)/u;

const REVERSAL_MARKER = /(?:算了|还是|但|不过|改成|现在|直接|确认)/u;

function normalizeUserTurn(text: string | undefined): string | undefined {
  const normalized = text?.trim();
  return normalized ? normalized : undefined;
}

function hasAnyPattern(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function hasBlockingNegation(text: string, negationPattern: RegExp, allowPatterns: readonly RegExp[]): boolean {
  const match = negationPattern.exec(text);
  if (!match || match.index === undefined) return false;

  const afterNegation = text.slice(match.index + match[0].length);
  if (!REVERSAL_MARKER.test(afterNegation)) return true;
  return !hasAnyPattern(afterNegation, allowPatterns);
}

/**
 * 本轮用户原话是否允许写正文（generate_draft）。缺原话放行（向后兼容/前端按钮直调不传原话）；
 * 有原话时只看正向表：命中任何写作说法 → 放行（R7.1 起不再用否定词否决——角色台词里的
 * 「别想再动它」曾被「别…动」误拦）；一个写作说法都没有 → 拦（正是「确认定稿」那轮
 * 模型自主追加 generate_draft 的场景，防定稿后自己往下写）。
 */
export function userTurnAllowsDraftWrite(userTurnText: string | undefined): boolean {
  const text = normalizeUserTurn(userTurnText);
  if (!text) return true;
  return hasAnyPattern(text, DRAFT_WRITE_PATTERNS);
}

export function userTurnAllowsThreadCleanup(userTurnText: string | undefined): boolean {
  const text = normalizeUserTurn(userTurnText);
  if (!text) return true;
  if (!hasAnyPattern(text, THREAD_CLEANUP_PATTERNS)) return false;
  return !hasBlockingNegation(text, THREAD_CLEANUP_NEGATION_PATTERN, THREAD_CLEANUP_PATTERNS);
}

export function userTurnAllowsResolveThread(userTurnText: string | undefined): boolean {
  const text = normalizeUserTurn(userTurnText);
  if (!text) return true;
  if (!hasAnyPattern(text, THREAD_RESOLVE_PATTERNS)) return false;
  return !hasBlockingNegation(text, THREAD_RESOLVE_NEGATION_PATTERN, THREAD_RESOLVE_PATTERNS);
}

/**
 * 已确立长期设定（如 age/gender）覆盖同意语。
 * fail-closed：缺原话 / 仅「改成」请求 / 否定语 → false；不接受 agent 自说自话。
 * 与入库意图门「缺省放行」刻意不同——覆盖已确立事实必须听到用户明确同意。
 */
const ESTABLISHED_OVERRIDE_PATTERNS = [
  /允许覆盖/u,
  /确认覆盖/u,
  /可以覆盖/u,
  /明确覆盖/u,
  /覆盖吧/u,
  /(?<![不未])同意覆盖/u,
  /(?<![不未])确定覆盖/u,
  // 短同意整句（agent 问过后用户回「确定/同意」）
  /^(?:好的?[，,。!\s]*)?(?:确定|同意|可以|行|没问题)(?:[。.!！]?)$/u,
];

const ESTABLISHED_OVERRIDE_NEGATION = /(?:不|别|先不|暂不|无需|不用|算了)[^，。；！？\n]{0,8}(?:覆盖|改|同意|确定)/u;

export function userTurnAllowsEstablishedOverride(userTurnText: string | undefined): boolean {
  const text = normalizeUserTurn(userTurnText);
  if (!text) return false;
  if (ESTABLISHED_OVERRIDE_NEGATION.test(text) && !/(?:还是|那就|那就还是).{0,6}(?:允许覆盖|确定|同意)/u.test(text)) {
    return false;
  }
  return ESTABLISHED_OVERRIDE_PATTERNS.some((pattern) => pattern.test(text));
}
