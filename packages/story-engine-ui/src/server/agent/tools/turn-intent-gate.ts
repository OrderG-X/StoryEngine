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

// 否定词 + 短距离内的「写/动/碰/急」（「下一章不要写」「下一章先别动」都算否定该子句）。
// 含裸「不」与「不着急/不急着」——与已拆除的旧定稿门同口径（「不着急入库」已拦，
// draft 门此前漏收：用户说「不着急写下一章」被当正向放行，白耗一整章 token；2026-09-15 审计 P1-3）
const DRAFT_WRITE_NEGATION_PATTERN = /(?:先)?(?:不(?:着急|急着|要|用|想)?|别|先不|暂不|无需)[^，。；！？\n]{0,6}(?:写|动|碰|急)/u;
// 纯推迟尾句（词表逐槽对齐已拆除的旧定稿门尾句否决表，审计返工 B7——draft 表此前漏收
// commit 表的「算了」前缀、咱们/你主语、现在/目前/暂时副词、再说/反悔了?词根）。
// 不能直接复用同一常量：draft 门额外保有三层 commit 表没有的覆盖——「又」副词、「想一下」词根、
// 「再(说|看|想|等等?)」后缀（「想想再说」「等等再说」「考虑一下再说」，P1-4 测试钉住；
// commit 表无此后缀、是其已知洞，勿回退）。
// 注意「你/咱们」只是主语前缀、词根槽仍必填：「你看看行不行」「你说呢」不配词根不否决。
const DRAFT_WRITE_TRAILING_VETO =
  /^(?:但|但是|不过|可是)?(?:算了)?(?:我|咱们|你)?(?:现在|目前|暂时|再|又)?(?:先)?(?:不(?:着急|急着)|别|别急|不行|不好|等等|等下|等一等|等一下|缓一缓|慢着|再说|反悔了?|想想|想一下|考虑一下|考虑|算了)(?:再(?:说|看|想|等等?))?$/u;
// 范围限定而非拒写：否定作用于「其他/后面/别的章节」这类范围宾语（「不要写后面的章节」
// 限定本轮范围，不是叫停本轮写作）。出现这些范围词时，否定子句不当否决。
const DRAFT_WRITE_SCOPE_LIMIT = /其他|别的|后面|后续|以外|之外/u;

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
 * 本轮用户原话是否允许写正文（generate_draft）。缺原话放行（向后兼容/前端按钮直调不传原话）；
 * 有原话但无写作意图 → 拦（正是「确认定稿」那轮模型自主追加 generate_draft 的场景）。
 *
 * 否定按【子句作用域】判定（复审 P1 重做——此前「否定在正向之后=限定范围」的规则会把
 * 「确认定稿，下一章不要写」反向放行）：
 * - 一个子句里同时有写作词和否定词 → 该子句被否定（「下一章不要写」「别写下一章」）；
 * - 尾句否决：决定性正向子句之后的纯推迟/否定尾句行使否决权（「写第8章，先别写」「写下一章，不着急」
 *   「继续写，慢着」）——对齐 commit 门的尾句否决，2026-09-15 审计 P1-4 补；
 * - 存在至少一个「纯正向」子句（有写作意图、无否定、且后面没被尾句否决）→ 放行
 *   （「继续写第59章正文。只写这一章，不要写其他章。」「先别写，算了还是写第8章吧」）；
 * - 只有被否定的子句 → 拦。
 */
export function userTurnAllowsDraftWrite(userTurnText: string | undefined): boolean {
  const text = normalizeUserTurn(userTurnText);
  if (!text) return true;
  if (!hasAnyPattern(text, DRAFT_WRITE_PATTERNS)) return false;
  const clauses = text.split(CLAUSE_SPLIT).map((clause) => clause.trim()).filter(Boolean);
  const positiveIdx = clauses.findIndex(
    (clause) => hasAnyPattern(clause, DRAFT_WRITE_PATTERNS) && !DRAFT_WRITE_NEGATION_PATTERN.test(clause),
  );
  if (positiveIdx < 0) return false;
  // 尾句否决：正向决定子句之后的尾句若为纯推迟/否定写作，行使否决权（「写第8章，先别写」
  // 「写下一章，等等再说」「写下一章，不急着写」）。「写第7章，不要写后面的章节」
  // 不拦——它的否定限定的是「后面的章节」这一范围宾语，不是本轮写作本身。
  return !clauses.slice(positiveIdx + 1).some((clause) => {
    if (DRAFT_WRITE_TRAILING_VETO.test(clause)) return true;
    // 否定写作尾句（如「先别写」「不急着写」）：命中否定写作即否决，除非是范围限定
    if (!DRAFT_WRITE_NEGATION_PATTERN.test(clause)) return false;
    return !DRAFT_WRITE_SCOPE_LIMIT.test(clause);
  });
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
