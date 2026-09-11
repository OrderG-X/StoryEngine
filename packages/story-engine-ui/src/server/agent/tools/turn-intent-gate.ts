// 术语人话化：定稿 = 入库（新旧词都认，兼容老会话与用户习惯）
// 确认引导词带后顾：紧跟「不/没/未/别」的是二次否定（「别确认入库」不算确认）；「特别确认」不算否定（嵌套后顾只挡前面不是「特」的「别」）。
const COMMIT_CONFIRM_LEAD = "(?<![不没未])(?<!(?<!特)别)(?:确认)";
const COMMIT_APPLY_PATTERNS = [
  new RegExp(`(?:${COMMIT_CONFIRM_LEAD}|正式|执行)[^。！？；\\n]{0,12}(?:入库|提交|定稿)`, "u"),
  /直接(?:正式)?(?:入库|定稿)/u,
  /提交本章/u,
  new RegExp(`${COMMIT_CONFIRM_LEAD}定稿`, "u"),
  /定稿吧/u,
  /定稿并更新资料/u,
  /把(?:这|第\s*\d+)\s*章[^。！？；\n]{0,16}(?:正式)?(?:入库|定稿)/u,
  /走完预览并(?:正式)?(?:入库|定稿)/u,
  /预览(?:通过|没问题|无误)?(?:就|后|再)?(?:直接)?(?:正式)?(?:入库|定稿)/u,
];

// commit 门否定判定（复审 P1 方案级重做）：三层嵌套后顾已到极限——「确认不定稿」「不能确认定稿」
// 「无法确认入库」里否定嵌在确认锚与动词之间，后顾够不着（曾误放行）；「不确认了直接定稿」里
// 「不确认」是被「了」闭合的独立否定单元，不该打死后面的「直接定稿」（曾误拦）。
// 迁到 draft 门同款「子句切分 + 词法极性」：
// - 按子句切分原话，逐子句找入库动词（入库|定稿|提交），不含动词的子句与本门无关；
// - 子句极性：最后一个入库动词之前存在未被「了」闭合的否定词 → 否定极性
//   （「不确认了直接定稿」里「不」被「了」闭合，「直接定稿」是肯定极性）；
// - 否定词表：不/未/别（「不要/不能/不用/先不/暂不/不确认」由「不」字天然覆盖）+ 没（「没问题」豁免，
//   「预览没问题后再正式入库」不是否定）+ 无法/无需（「无」不单字扫，防「预览无误后入库」误伤）；
//   「别」前是「特」豁免（「特别确认」的「别」是语气词的一部分，与确认锚后顾同口径）；
// - 后说话算数：最后一个含入库动词的子句决定结果——「先别入库，算了还是确认入库」末句肯定=放行；
//   「先别入库，不过还是别确认入库」末句否定=拦；
// - 放行仍 fail-closed：肯定子句须命中 COMMIT_APPLY_PATTERNS 正向句式（裸「入库吧」现状不放行），
//   否定子句则裸动词也算数（「先别入库」「别定稿」够不着正向句式，但必须拦得住）。
const COMMIT_VERB_PATTERN = /入库|定稿|提交/gu;
const COMMIT_NEGATION_WORD = /(?<!特)别|没(?!问题)|无法|无需|[不未]/gu;

/** 子句内最后一个入库动词的下标；无动词返回 -1。 */
function lastCommitVerbIndex(clause: string): number {
  let index = -1;
  for (const match of clause.matchAll(COMMIT_VERB_PATTERN)) index = match.index;
  return index;
}

/** 子句极性：最后一个入库动词之前存在未被「了」闭合的否定词 → 否定极性。 */
function isCommitClauseNegated(clause: string, verbIndex: number): boolean {
  const prefix = clause.slice(0, verbIndex);
  let lastNegation: RegExpExecArray | undefined;
  for (const match of prefix.matchAll(COMMIT_NEGATION_WORD)) lastNegation = match;
  if (!lastNegation) return false;
  return !prefix.slice(lastNegation.index + lastNegation[0].length).includes("了");
}

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

/**
 * 本轮用户原话是否允许真入库（commit_apply）。缺原话放行（向后兼容/前端按钮直调不传原话）。
 * 否定按【子句作用域 + 词法极性】判定（与 draft 门同哲学，复审 P1 重做——嵌套后顾够不着
 * 「确认不定稿」这类嵌在确认锚与动词之间的否定）：最后一个含入库动词的子句决定结果，
 * 否定极性 → 拦；肯定极性 → 须命中正向句式才放行。
 */
export function userTurnAllowsCommitApply(userTurnText: string | undefined): boolean {
  const text = normalizeUserTurn(userTurnText);
  if (!text) return true;
  const clauses = text.split(CLAUSE_SPLIT).map((clause) => clause.trim()).filter(Boolean);
  let decision: { negated: boolean; positive: boolean } | undefined;
  for (const clause of clauses) {
    const verbIndex = lastCommitVerbIndex(clause);
    if (verbIndex < 0) continue;
    decision = {
      negated: isCommitClauseNegated(clause, verbIndex),
      positive: hasAnyPattern(clause, COMMIT_APPLY_PATTERNS),
    };
  }
  if (!decision || decision.negated) return false;
  return decision.positive;
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
// 复审收紧（跨域误放行实锤：「确认清理线索」曾放行快照真裁；「确认裁掉这段剧情」也曾放行）：
// - 确认级动词（裁剪|裁掉|清理|清掉）一律要求快照域宾语（快照|操作历史|存档点）同框；
//   把字句宾语前置（「确认把快照清理掉」）算同框；裸「裁」只在域宾语锚定时收进动词表；
// - 裸「确认裁剪/确定裁掉」整句属短确认（agent 预览后问过，用户原话复述），与裸「确认」同级；
// - 否定带域锚且认「不确认/没确认」前缀：「不确认裁剪快照历史」是拒绝，不是确认；
//   「确认裁剪快照历史，别清理线索」里被否定的是线索清理，不拦裁剪确认；
// - 反转放行：「先别裁剪，算了还是裁吧」——否定之后用户明确改主意要裁，视为确认级；
//   但「裁吧/确认裁掉」紧跟「别/不/没/未」是二次否定（「先别裁剪，不过还是别裁吧」、
//   「先别裁剪，不过还是别确认裁掉快照」），不算反转；「特别确认」的「别」前带「特」，是真确认。
const SNAPSHOT_PRUNE_VERB = "(?:裁剪|裁掉|裁|清理|清掉)";
const SNAPSHOT_PRUNE_DOMAIN = "(?:快照|操作历史|存档点)";
// 「确认/确定」锚的前置后顾：紧跟「不/没/未」（不确认/没确认/未确认）或「别」（别确认）时是否定、
// 不是确认锚——否则「先别裁剪，不过还是别确认裁掉快照」里「别确认裁掉快照」会被误当反转后的真确认
// （二次否定漏放行）。但「特别确认」含「别确认」子串、是加强语气的真确认：嵌套后顾 (?<!(?<!特)别)
// 只挡「前面不是特的别」，「特别确认裁掉快照历史」照常命中放行（agent-61 裁决项）。
const SNAPSHOT_PRUNE_CONFIRM_ANCHOR_GUARDED = "(?<![不没未])(?<!(?<!特)别)(?:确认|确定)";
// 确认级引导词：带后顾的「确认/确定」，或不涉及二次否定的「真的/直接」。
const SNAPSHOT_PRUNE_CONFIRM_LEAD = `(?:${SNAPSHOT_PRUNE_CONFIRM_ANCHOR_GUARDED}|真的|直接)`;
const SNAPSHOT_PRUNE_CONFIRM_PATTERNS = [
  // 确认级措辞 + 动词 + 域宾语同框：「确认裁剪快照历史」「确定清理快照历史」可；
  // 「确认清理线索」「确认裁掉这段剧情」跨域不可
  new RegExp(`${SNAPSHOT_PRUNE_CONFIRM_LEAD}[^。！？；\\n]{0,10}${SNAPSHOT_PRUNE_VERB}[^。！？；\\n]{0,8}${SNAPSHOT_PRUNE_DOMAIN}`, "u"),
  // 把字句宾语前置：「确认把快照清理掉」「确定把操作历史裁掉」（复审实锤：此前误拦）
  new RegExp(`${SNAPSHOT_PRUNE_CONFIRM_LEAD}[^。！？；\\n]{0,6}把[^。！？；\\n]{0,8}${SNAPSHOT_PRUNE_DOMAIN}[^。！？；\\n]{0,10}${SNAPSHOT_PRUNE_VERB}`, "u"),
  // 动词 + 域宾语 + 确认级收尾：「裁剪快照历史，确认」「裁掉旧快照，动手」；
  // 「吧」不算确认收尾——「裁剪快照历史吧」是首次请求语气，只够预览
  new RegExp(`${SNAPSHOT_PRUNE_VERB}[^。！？；\\n]{0,8}${SNAPSHOT_PRUNE_DOMAIN}[^。！？；\\n]{0,8}(?:确认|确定|动手)`, "u"),
  // 把字句 + 确认级收尾：「把快照历史裁到100条，确认」——裸「裁」有域宾语锚定才收进动词表
  // （复审实锤：旧注释自称此句放行，但动词表里没有裸「裁」，实际误拦）
  new RegExp(`把[^。！？；\\n]{0,8}${SNAPSHOT_PRUNE_DOMAIN}[^。！？；\\n]{0,10}${SNAPSHOT_PRUNE_VERB}[^。！？；\\n]{0,8}(?:确认|确定|动手)`, "u"),
  // 短确认整句（agent 预览后问过「确认裁剪？」，用户回「确认/裁吧」）
  /^(?:好的?[，,。!\s]*)?(?:确认|确定|可以|行|没问题|裁吧|裁剪吧|裁掉吧|动手吧)[。.!！]?$/u,
  // 裸「确认裁剪/确定裁掉」整句短确认，与裸「确认」同级；尾随疑问语气（吗/？）现状放行——
  // 一审曾建议把疑问句也算拦截，未采纳，此处钉住现状口径
  /^(?:好的?[，,。!\s]*)?(?:确认|确定)(?:裁剪|裁掉)[吗呢嘛]?[。.!！?？]?$/u,
];

// 否定带域锚：裁剪系动词直接拦（别裁/先别裁剪）；清理系动词须带快照域宾语才拦——
// 「别清理线索」拦的是线索清理，不该拦快照裁剪确认。
// 复审补网：「不确认/没确认」前缀同样是否定（「不确认裁剪快照历史」曾被误放行）。
// 「别」写成 (?<!特)别：「特别确认」里的「别」是加强语气词的一部分，不是否定前缀（agent-61 裁决项：此前误拦真确认）。
const SNAPSHOT_PRUNE_NEGATION_PATTERN = new RegExp(
  `(?:先)?(?:(?<!特)别|不要|先不|暂不|无需|不用|算了|不确认|没确认|未确认)[^，。；！？\\n]{0,8}(?:裁(?:剪|掉)?|(?:清理|清掉)[^，。；！？\\n]{0,8}${SNAPSHOT_PRUNE_DOMAIN})`,
  "u",
);

// 反转放行用的确认锚（作用在否定之后的余文上，故不用 ^$ 整句锚）：
// 「算了还是裁吧」「算了，确认裁剪」「先别裁剪，确认」都算用户改主意要裁。
// 复审补网：确认锚紧跟「别/不/没/未」是二次否定而非改主意——
// 「先别裁剪，不过还是别裁吧」里「裁吧」只是「别裁吧」的子串，不算反转；
// 「先别裁剪，不过还是别确认裁掉快照」里「确认裁掉快照」只是「别确认…」的子串，同样不算反转
// （确认锚与 SNAPSHOT_PRUNE_CONFIRM_PATTERNS 共用同一后顾，「特别确认」不受影响）。
const SNAPSHOT_PRUNE_REVERSAL_CONFIRM = new RegExp(
  `${SNAPSHOT_PRUNE_CONFIRM_ANCHOR_GUARDED}[^。！？；\\n]{0,8}(?:裁(?:剪|掉)?|(?:清理|清掉)[^，。；！？\\n]{0,8}${SNAPSHOT_PRUNE_DOMAIN})` +
    "|(?<![别不])(?:裁吧|裁剪吧|裁掉吧|动手吧)" +
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
