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

// ─── 子句极性引擎：commit_apply / snapshot_prune 两门共用（复审 P1-A 参数化重做）───
// 判定哲学（draft 门同款「子句切分 + 词法极性」，动词集/域宾语集/正向句式集作参数）：
// - 按子句切分原话，逐子句找域内动词；不含域内动词的子句不参与极性判定；
// - 子句极性：最后一个域内动词之前存在未被「了」闭合的否定词 → 否定极性
//   （「不确认了直接定稿」里「不」被「了」闭合，「直接定稿」是肯定极性）；
//   动词之后紧跟「不行/不了」也是否定（「确认入库不行」「确认提交不了」，复审 P2-3）；
// - 否定词表：不/未/别 + 没（豁免 没问题/没毛病/没什么——「确认没毛病就入库」的「没」修饰状语，
//   与逗号版同判放行，复审 P2-3 误拦回归）+ 无法/无需（「无」不单字扫，防「预览无误后入库」误伤）；
//   「不」豁免 不着急/不急着（状语否定，否的是「着急」不是动词——「不着急确认入库」曾误拦）；
//   「别」前是「特」豁免（「特别确认」的「别」是语气词的一部分，与确认锚后顾同口径）；
// - 后说话算数：最后一个相关子句（含域内动词，或整句短确认）定结果；
// - 尾句否决：决定性子句之后跟纯否定/推迟尾句（「先别/先等等/算了先别/不过我反悔了」）→ 拦（复审 P2-3）；
// - 放行仍 fail-closed：肯定子句须命中正向句式（裸「入库吧」不放行），否定子句裸动词也算拦；
// - 疑问句 fail-closed 由参数表态：commit 门拦（「确认定稿？」「你确认要入库吗」是问不是确认，复审 P2-3）；
//   prune 门「确认裁剪吗」放行是钉住的现状口径（一审建议拦、未采纳）。
const GATE_NEGATION_WORD = /(?<!特)别|没(?!问题|毛病|什么)|无法|无需|不(?!着急|急着)|未/gu;
// 动词后否定：「确认入库不行」「确认提交不了」
const GATE_POST_VERB_NEGATION = /^(?:了)?(?:不行|不了|不可以|不能|不许|不成)/u;
// 疑问：半/全角问号出现即疑问；句尾「吗」亦然（「你确认要入库吗」）
const GATE_QUESTION_MARK = /[？?]|吗[呢呀]?\s*[。.!！?？]?\s*$/u;
// 强反转语气词：否定之后自带这些词的肯定子句才算真改主意；裸「还是」不算
// （「别裁剪快照，还是确认裁掉快照吧」仍拦，复审 P1-A 扩展例）
const GATE_STRONG_REVERSAL = /算了|但|不过|可是|那就|现在|改成/u;
// 纯否定/推迟尾句（整句锚定，防「别清理线索」这类带跨域动词的子句误伤——它否的是线索，不是本门动作）
const GATE_TRAILING_VETO_CLAUSE =
  /^(?:但|但是|不过|可是)?(?:算了)?(?:我)?(?:再)?(?:先)?(?:别|别急|不行|不好|等等|等下|等一等|缓一缓|再说|反悔了?|想想|考虑一下|考虑)[。.!！]?$/u;

interface ClauseGateSpec {
  /** 域内动词（无域宾语锚定也算相关子句）：commit = 入库|定稿|提交；prune = 裁剪|裁掉|裁 */
  readonly verbPattern: RegExp;
  /** 跨域动词：须与域宾语同子句才算相关（prune 的 清理|清掉——「别清理线索」否的是线索清理，与快照无关） */
  readonly domainVerbPattern?: RegExp;
  /** 域宾语（prune = 快照|操作历史|存档点）；缺省表示无域概念（commit） */
  readonly domainPattern?: RegExp;
  /** 正向句式集：肯定子句须命中才放行（fail-closed 主保险，「入库有风险吗」式疑问/泛句进不来） */
  readonly positivePatterns: readonly RegExp[];
  /** 整句短确认（agent 预览后问过，用户回「确认/可以/裁吧」）：无域内动词也可作最终决定 */
  readonly shortConfirmPatterns: readonly RegExp[];
  /** 自带强反转语气词时裸动词收尾也算确认级（prune「先别裁剪，算了还是裁吧」）；否定极性优先于它 */
  readonly bareVerbConfirmPattern?: RegExp;
  /** 疑问句 fail-closed（commit true；prune false——「确认裁剪吗」放行是钉住的现状口径） */
  readonly blockQuestions: boolean;
  /** 否定后的非短确认放行须自带强反转标记（prune true——裸「还是」不够；commit false——末句肯定即后说话算数） */
  readonly overrideNeedsStrongMarker: boolean;
}

interface GateVerbHit {
  index: number;
  length: number;
}

/** 子句内最后一个相关域内动词；跨域动词仅在与域宾语同子句时计入。 */
function lastGateVerb(clause: string, spec: ClauseGateSpec): GateVerbHit | undefined {
  let hit: GateVerbHit | undefined;
  for (const match of clause.matchAll(spec.verbPattern)) hit = { index: match.index, length: match[0].length };
  if (spec.domainVerbPattern && spec.domainPattern?.test(clause)) {
    for (const match of clause.matchAll(spec.domainVerbPattern)) {
      if (!hit || match.index > hit.index) hit = { index: match.index, length: match[0].length };
    }
  }
  return hit;
}

/** 子句极性：末动词前存在未被「了」闭合的否定词，或动词后紧跟「不行/不了」→ 否定极性。 */
function isGateClauseNegated(clause: string, verb: GateVerbHit): boolean {
  if (GATE_POST_VERB_NEGATION.test(clause.slice(verb.index + verb.length))) return true;
  const prefix = clause.slice(0, verb.index);
  let lastNegation: RegExpExecArray | undefined;
  for (const match of prefix.matchAll(GATE_NEGATION_WORD)) lastNegation = match;
  if (!lastNegation) return false;
  return !prefix.slice(lastNegation.index + lastNegation[0].length).includes("了");
}

interface GateClauseInfo {
  relevant: boolean;
  negated: boolean;
  positive: boolean;
  strongMarker: boolean;
  domainCarrying: boolean;
  crossDomainAction: boolean;
  shortConfirm: boolean;
  veto: boolean;
}

function decideByClausePolarity(text: string, spec: ClauseGateSpec): boolean {
  const clauses = text.split(CLAUSE_SPLIT).map((clause) => clause.trim()).filter(Boolean);
  const infos: GateClauseInfo[] = clauses.map((clause) => {
    const verb = lastGateVerb(clause, spec);
    if (!verb) {
      return {
        relevant: false,
        negated: false,
        positive: false,
        strongMarker: false,
        domainCarrying: false,
        // 带跨域动词但无域宾语的子句（「确认清理线索」）：短确认收尾时不能把这类原话当无关背景
        crossDomainAction: spec.domainVerbPattern ? [...clause.matchAll(spec.domainVerbPattern)].length > 0 : false,
        shortConfirm: hasAnyPattern(clause, spec.shortConfirmPatterns),
        veto: GATE_TRAILING_VETO_CLAUSE.test(clause),
      };
    }
    const negated = isGateClauseNegated(clause, verb);
    const strongMarker = GATE_STRONG_REVERSAL.test(clause);
    return {
      relevant: true,
      negated,
      positive:
        hasAnyPattern(clause, spec.positivePatterns) ||
        (!negated && strongMarker && spec.bareVerbConfirmPattern?.test(clause) === true),
      strongMarker,
      domainCarrying: spec.domainPattern ? spec.domainPattern.test(clause) : true,
      crossDomainAction: false,
      shortConfirm: hasAnyPattern(clause, spec.shortConfirmPatterns),
      veto: false,
    };
  });
  let lastRelevant = -1;
  let lastShortConfirm = -1;
  infos.forEach((info, index) => {
    if (info.relevant) lastRelevant = index;
    if (info.shortConfirm) lastShortConfirm = index;
  });
  const decisionIndex = Math.max(lastRelevant, lastShortConfirm);
  // 尾句否决：决定性子句之后的纯否定/推迟尾句行使否决权（「确认入库，先别」「确认定稿，但是先等等」）
  if (infos.some((info, index) => index > decisionIndex && info.veto)) return false;
  if (spec.blockQuestions && GATE_QUESTION_MARK.test(text)) return false;
  if (lastRelevant < 0) {
    // 无域内动词：整句短确认放行（「确认」「好的，行」）；但原话带跨域动作子句时 fail-closed——
    // 「确认清理线索，确认」确认的是线索清理，不是本门动作
    if (lastShortConfirm < 0) return false;
    return !infos.some((info) => info.crossDomainAction);
  }
  const last = infos[lastRelevant];
  // 短确认尾句行使最终决定权：「先别裁剪，确认」「裁剪快照历史，确认」
  if (lastShortConfirm > lastRelevant) return true;
  if (last.negated) return false;
  if (last.positive) {
    // 否定之后的非短确认放行须自带强反转标记（prune）：「别裁剪快照，还是确认裁掉快照吧」裸「还是」不算改主意
    if (
      spec.overrideNeedsStrongMarker &&
      !last.strongMarker &&
      infos.some((info, index) => index < lastRelevant && info.relevant && info.negated)
    ) {
      return false;
    }
    return true;
  }
  // 非正向相关尾句：整句短确认 + 非否定的域内动作子句 → 放行（「确认，把快照清理掉吧」）
  return last.domainCarrying && lastShortConfirm >= 0;
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

const COMMIT_GATE_SPEC: ClauseGateSpec = {
  verbPattern: /入库|定稿|提交/gu,
  positivePatterns: COMMIT_APPLY_PATTERNS,
  shortConfirmPatterns: [],
  blockQuestions: true,
  overrideNeedsStrongMarker: false,
};

/**
 * 本轮用户原话是否允许真入库（commit_apply）。缺原话放行（向后兼容/前端按钮直调不传原话）。
 * 子句极性引擎判定（见上方 GATE 注释块）：末个含入库动词的子句定结果——否定极性 → 拦；
 * 肯定极性 → 须命中正向句式才放行；疑问句与尾随否决同样 fail-closed（复审 P2-3）。
 */
export function userTurnAllowsCommitApply(userTurnText: string | undefined): boolean {
  const text = normalizeUserTurn(userTurnText);
  if (!text) return true;
  return decideByClausePolarity(text, COMMIT_GATE_SPEC);
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
// 与 commit 门共用子句极性引擎（复审 P1-A 重做——旧实现「确认不裁剪快照历史」曾字面反义放行真裁）；
// 缺原话放行（前端按钮/旧会话兼容）。本门特有参数：
// - 动词分两组：裁系（裁剪|裁掉|裁）天然域内；清理系（清理|清掉）跨域——须与快照域宾语
//   （快照|操作历史|存档点）同子句才算相关（「确认清理线索」与快照无关；「别清理线索」不拦裁剪确认）；
// - 正向句式一律要求确认级措辞 + 域宾语同框（把字句宾语前置算同框）；「吧」级商量语气只是首次请求，
//   只够走预览；整句短确认（「确认/裁吧/可以」）是 agent 预览后问过的回答，算确认级；
// - 否定后的放行须自带强反转语气词（算了/但/不过）：「先别裁剪，算了还是裁吧」放行，
//   但「别裁剪快照，还是确认裁掉快照吧」裸「还是」不算改主意（复审 P1-A 扩展例）；
// - 疑问句口径：「确认裁剪吗」放行是钉住的现状（一审建议拦、未采纳），与 commit 门以参数区分。
const SNAPSHOT_PRUNE_VERB = "(?:裁剪|裁掉|裁|清理|清掉)";
const SNAPSHOT_PRUNE_DOMAIN = "(?:快照|操作历史|存档点)";
// 「确认/确定」锚的后顾仍在正向句式里服役：紧跟「不/没/未/别」的确认锚是二次否定、不是确认锚；
// 「特别确认」的「别」前带「特」，是加强语气的真确认（agent-61 裁决项）。
const SNAPSHOT_PRUNE_CONFIRM_ANCHOR_GUARDED = "(?<![不没未])(?<!(?<!特)别)(?:确认|确定)";
const SNAPSHOT_PRUNE_CONFIRM_LEAD = `(?:${SNAPSHOT_PRUNE_CONFIRM_ANCHOR_GUARDED}|真的|直接)`;
// 整句短确认：可带一个反转语气词前缀（「先别裁剪，不过可以」的「不过可以」是改主意）
const SNAPSHOT_PRUNE_SHORT_CONFIRM =
  /^(?:但|但是|不过|可是|算了|那就)?(?:好的?[，,、\s]*)?(?:确认|确定|可以|行|没问题|裁吧|裁剪吧|裁掉吧|动手吧)[。.!！]?$/u;
const SNAPSHOT_PRUNE_CONFIRM_PATTERNS = [
  // 确认级措辞 + 动词 + 域宾语同框：「确认裁剪快照历史」「确定清理快照历史」可；
  // 「确认清理线索」「确认裁掉这段剧情」跨域不可
  new RegExp(`${SNAPSHOT_PRUNE_CONFIRM_LEAD}[^。！？；\\n]{0,10}${SNAPSHOT_PRUNE_VERB}[^。！？；\\n]{0,8}${SNAPSHOT_PRUNE_DOMAIN}`, "u"),
  // 把字句宾语前置：「确认把快照清理掉」「确定把操作历史裁掉」
  new RegExp(`${SNAPSHOT_PRUNE_CONFIRM_LEAD}[^。！？；\\n]{0,6}把[^。！？；\\n]{0,8}${SNAPSHOT_PRUNE_DOMAIN}[^。！？；\\n]{0,10}${SNAPSHOT_PRUNE_VERB}`, "u"),
  // 动词 + 域宾语 + 确认级收尾（子句内）：「裁剪快照历史确认」「裁掉旧快照动手」
  new RegExp(`${SNAPSHOT_PRUNE_VERB}[^。！？；\\n]{0,8}${SNAPSHOT_PRUNE_DOMAIN}[^。！？；\\n]{0,8}(?:确认|确定|动手)`, "u"),
  // 把字句 + 确认级收尾（子句内）：「把快照历史裁到100条确认」
  new RegExp(`把[^。！？；\\n]{0,8}${SNAPSHOT_PRUNE_DOMAIN}[^。！？；\\n]{0,10}${SNAPSHOT_PRUNE_VERB}[^。！？；\\n]{0,8}(?:确认|确定|动手)`, "u"),
  SNAPSHOT_PRUNE_SHORT_CONFIRM,
  // 裸「确认裁剪/确定裁掉」整句短确认，与裸「确认」同级；尾随疑问语气（吗/？）放行是钉住的现状口径
  /^(?:好的?[，,。!\s]*)?(?:确认|确定)(?:裁剪|裁掉)[吗呢嘛]?[。.!！?？]?$/u,
];

const SNAPSHOT_PRUNE_GATE_SPEC: ClauseGateSpec = {
  verbPattern: /裁剪|裁掉|裁/gu,
  domainVerbPattern: /清理|清掉/gu,
  domainPattern: /快照|操作历史|存档点/u,
  positivePatterns: SNAPSHOT_PRUNE_CONFIRM_PATTERNS,
  shortConfirmPatterns: [SNAPSHOT_PRUNE_SHORT_CONFIRM],
  // 自带强反转语气词时裸「裁吧」族也算确认级（「先别裁剪，算了还是裁吧」）；否定极性优先
  bareVerbConfirmPattern: /裁吧|裁剪吧|裁掉吧|动手吧/u,
  blockQuestions: false,
  overrideNeedsStrongMarker: true,
};

export function userTurnAllowsSnapshotPrune(userTurnText: string | undefined): boolean {
  const text = normalizeUserTurn(userTurnText);
  if (!text) return true;
  return decideByClausePolarity(text, SNAPSHOT_PRUNE_GATE_SPEC);
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
