// 术语人话化：定稿 = 入库（新旧词都认，兼容老会话与用户习惯）
const COMMIT_APPLY_PATTERNS = [
  /(?:确认|正式|执行)[^。！？；\n]{0,12}(?:入库|提交|定稿)/u,
  /直接(?:正式)?(?:入库|定稿)/u,
  /提交本章/u,
  /确认定稿/u,
  /定稿吧/u,
  /定稿并更新资料/u,
  /把(?:这|第\s*\d+)\s*章[^。！？；\n]{0,16}(?:正式)?(?:入库|定稿)/u,
  /走完预览并(?:正式)?(?:入库|定稿)/u,
  /预览(?:通过|没问题|无误)?(?:就|后|再)?(?:直接)?(?:正式)?(?:入库|定稿)/u,
];

const COMMIT_NEGATION_PATTERN = /(?:先)?(?:别|不要|先不|暂不|无需|不用)[^，。；！？\n]{0,8}(?:正式)?(?:入库|提交|定稿)/u;

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

// 否定词 + 短距离内的「写/动/碰/急」（「下一章不要写」「下一章先别动」都算否定该子句）
const DRAFT_WRITE_NEGATION_PATTERN = /(?:先)?(?:别|不要|先不|暂不|无需|不用)[^，。；！？\n]{0,6}(?:写|动|碰|急)/u;

/** 子句切分（逗号/句号/分号/问叹号/换行）：否定的作用域按子句判定，不跨子句误伤。 */
const CLAUSE_SPLIT = /[，,。．.;；！!？?\n]+/u;

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

export function userTurnAllowsCommitApply(userTurnText: string | undefined): boolean {
  const text = normalizeUserTurn(userTurnText);
  if (!text) return true;
  if (!hasAnyPattern(text, COMMIT_APPLY_PATTERNS)) return false;
  return !hasBlockingNegation(text, COMMIT_NEGATION_PATTERN, COMMIT_APPLY_PATTERNS);
}

/**
 * 本轮用户原话是否允许写正文（generate_draft）。缺原话放行（向后兼容/前端按钮直调不传原话）；
 * 有原话但无写作意图 → 拦（正是「确认定稿」那轮模型自主追加 generate_draft 的场景）。
 *
 * 否定按【子句作用域】判定（复审 P1 重做——此前「否定在正向之后=限定范围」的规则会把
 * 「确认定稿，下一章不要写」反向放行）：
 * - 一个子句里同时有写作词和否定词 → 该子句被否定（「下一章不要写」「别写下一章」）；
 * - 存在至少一个「纯正向」子句（有写作意图、无否定）→ 放行
 *   （「继续写第59章正文。只写这一章，不要写其他章。」「先别写，算了还是写第8章吧」）；
 * - 只有被否定的子句 → 拦。
 */
export function userTurnAllowsDraftWrite(userTurnText: string | undefined): boolean {
  const text = normalizeUserTurn(userTurnText);
  if (!text) return true;
  if (!hasAnyPattern(text, DRAFT_WRITE_PATTERNS)) return false;
  const clauses = text.split(CLAUSE_SPLIT).map((clause) => clause.trim()).filter(Boolean);
  return clauses.some((clause) =>
    hasAnyPattern(clause, DRAFT_WRITE_PATTERNS) && !DRAFT_WRITE_NEGATION_PATTERN.test(clause),
  );
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

// 快照历史「真裁」确认意图（prune_snapshots confirm=true；dry-run 预览只读、不过这道门）。
// 与 commit 门同哲学：缺原话放行（前端按钮/旧会话兼容）；有原话须见「确认裁剪」级意图——
// 「裁剪一下快照历史」「裁剪快照历史吧」这种首次请求（含「吧」级商量语气）只够走预览，不够真裁。
// 复审收紧（跨域误放行实锤：「确认清理线索」曾放行快照真裁）：
// - 确认动词收窄为 裁剪|裁掉；清理|清掉 必须与快照域宾语（快照|操作历史|存档点）同框才算数；
// - 否定同样带域锚：「确认裁剪快照历史，别清理线索」里被否定的是线索清理，不拦裁剪确认；
// - 反转放行：「先别裁剪，算了还是裁吧」——否定之后用户明确改主意要裁，视为确认级。
const SNAPSHOT_PRUNE_VERB = "(?:裁剪|裁掉)";
const SNAPSHOT_PRUNE_DOMAIN = "(?:快照|操作历史|存档点)";
const SNAPSHOT_PRUNE_CONFIRM_PATTERNS = [
  // 确认级措辞 + 裁剪动词：「确认裁剪」「直接裁掉」「确认裁剪快照历史」
  new RegExp(`(?:确认|确定|真的|直接)[^。！？；\\n]{0,10}${SNAPSHOT_PRUNE_VERB}`, "u"),
  // 清理动词须带快照域宾语同框：「确定清理快照历史」可；「确认清理线索」跨域不可
  new RegExp(`(?:确认|确定|真的|直接)[^。！？；\\n]{0,10}(?:清理|清掉)[^。！？；\\n]{0,8}${SNAPSHOT_PRUNE_DOMAIN}`, "u"),
  // 裁剪动词 + 域宾语 + 确认级收尾：「把快照历史裁到100条，确认」「裁剪快照历史，动手」；
  // 「吧」不算确认收尾——「裁剪快照历史吧」是首次请求语气，只够预览
  new RegExp(`${SNAPSHOT_PRUNE_VERB}[^。！？；\\n]{0,8}${SNAPSHOT_PRUNE_DOMAIN}[^。！？；\\n]{0,8}(?:确认|确定|动手)`, "u"),
  // 短确认整句（agent 预览后问过「确认裁剪？」，用户回「确认/裁吧」）
  /^(?:好的?[，,。!\s]*)?(?:确认|确定|可以|行|没问题|裁吧|裁剪吧|裁掉吧|动手吧)[。.!！]?$/u,
];

// 否定带域锚：裁剪系动词直接拦（别裁/先别裁剪）；清理系动词须带快照域宾语才拦——
// 「别清理线索」拦的是线索清理，不该拦快照裁剪确认。
const SNAPSHOT_PRUNE_NEGATION_PATTERN = new RegExp(
  `(?:先)?(?:别|不要|先不|暂不|无需|不用|算了)[^，。；！？\\n]{0,8}(?:裁(?:剪|掉)?|(?:清理|清掉)[^，。；！？\\n]{0,8}${SNAPSHOT_PRUNE_DOMAIN})`,
  "u",
);

// 反转放行用的确认锚（作用在否定之后的余文上，故不用 ^$ 整句锚）：
// 「算了还是裁吧」「算了，确认裁剪」「先别裁剪，确认」都算用户改主意要裁。
const SNAPSHOT_PRUNE_REVERSAL_CONFIRM = new RegExp(
  `(?:确认|确定)[^。！？；\\n]{0,8}(?:裁(?:剪|掉)?|(?:清理|清掉)[^，。；！？\\n]{0,8}${SNAPSHOT_PRUNE_DOMAIN})` +
    "|(?:裁吧|裁剪吧|裁掉吧|动手吧)" +
    // 否定余文以一个短确认子句收尾：「先别裁剪，确认」——须以标点/空白开头，防「我不确认」误命中
    "|(?:^|[，,。；！？\\s])(?:好的?[，,。!\\s]*)?(?:确认|确定|可以|行|没问题)[。.!！]?$",
  "u",
);

/** 「先别裁剪，算了还是裁吧」式反转：否定之后（带反转语气词）又出现确认级裁意 → 视为确认。 */
function hasSnapshotPruneReversal(text: string): boolean {
  const match = SNAPSHOT_PRUNE_NEGATION_PATTERN.exec(text);
  if (!match || match.index === undefined) return false;
  const afterNegation = text.slice(match.index + match[0].length);
  return REVERSAL_MARKER.test(afterNegation) && SNAPSHOT_PRUNE_REVERSAL_CONFIRM.test(afterNegation);
}

export function userTurnAllowsSnapshotPrune(userTurnText: string | undefined): boolean {
  const text = normalizeUserTurn(userTurnText);
  if (!text) return true;
  // 反转句式先判：裸「裁吧」够不着正向确认锚，但「先别裁剪，算了还是裁吧」是否定后的同动作改主意。
  if (hasSnapshotPruneReversal(text)) return true;
  if (!hasAnyPattern(text, SNAPSHOT_PRUNE_CONFIRM_PATTERNS)) return false;
  return !hasBlockingNegation(text, SNAPSHOT_PRUNE_NEGATION_PATTERN, SNAPSHOT_PRUNE_CONFIRM_PATTERNS);
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
