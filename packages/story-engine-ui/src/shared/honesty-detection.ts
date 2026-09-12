export interface HonestyToolStep {
  readonly toolName?: string;
  readonly status?: string;
  /**
   * prune_snapshots 结果口径：dryRun=「没落盘」（只读预览 / 无需裁剪 / 被守卫拦下 / 失败回滚都是 true；
   * 仅真裁成功改写历史为 false）。写背书只认 false——dry-run 预览态 completed 不背书「已裁剪/已保存」。
   */
  readonly dryRun?: boolean;
  /**
   * manage_style_exemplars 结果动作：list 是只读 action，completed 也不背书「已添加/已删除」类声称；
   * 写背书只认 add/update/remove。
   */
  readonly action?: string;
}

type ToolStep = HonestyToolStep;

/**
 * 真·写类工具：完成「已生成/已写入/已入库」必须有它们之一真成功背书。
 * 注意排除 commit_preview / quality_check / ai_review / check_ai_flavor / read_* / suggest_next_steps：
 * 它们成功不等于「真写盘/真入库」——实测见到 agent 质检+预览成功后谎称「第N章已正式入库」（commit_apply 并未成功），
 * 若把这些算作背书就漏判。
 * prune_snapshots / manage_style_exemplars 不在此表：它们带只读形态（dry-run 预览 / list action），
 * 背书须按结果 payload 逐工具判定，见 stepBacksWriteClaim。
 */
const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  "generate_draft", "revise_draft", "commit_apply", "foundation_write",
  "generate_worldbuilding", "generate_asset_enrichment", "generate_location_enrichment",
  "generate_character_enrichment", "generate_matrix_enrichment", "generate_character_relationships",
  "generate_writing_rules_enrichment", "generate_alias_table",
  "edit_fact_ledger", "set_foreshadowing_importance", "clean_legacy_threads", "group_related_leads",
]);

/**
 * 写背书逐工具判定（按结果 payload 加粒度，别一刀切）：
 * - prune_snapshots：dry-run 预览态 completed 不是写（预览没落盘）。结果带 dryRun 时只认 false（真裁落盘）——
 *   真裁成功后 agent 转述「已裁剪/已保存到备份目录」须认它背书，漏了会被 A1 误判谎报、服务端强制作废重做（复审实锤）；
 *   缺 payload 的旧调用方维持旧口径（completed 即背书），不向坏方向回归。
 * - manage_style_exemplars：list 只读，completed 不背书「已添加/已删除」；只认 add/update/remove 真落盘动作。
 *   缺 payload 时维持旧口径（该工具本不在写背书集 → 不背书）。
 * - 其余写类工具：completed 即背书（照旧）。
 */
function stepBacksWriteClaim(step: ToolStep): boolean {
  if (typeof step.toolName !== "string" || step.status !== "completed") return false;
  if (step.toolName === "prune_snapshots") return step.dryRun !== true;
  if (step.toolName === "manage_style_exemplars") {
    return step.action === "add" || step.action === "update" || step.action === "remove";
  }
  return WRITE_TOOL_NAMES.has(step.toolName);
}

/**
 * 强「写类完成」断言（保守，只抓本人完成口吻；不含已读取/已审稿/已质检这类非写类，避免误伤）。
 * 允许「已正式入库 / 已成功生成」这种 已 与动词间夹「正式/成功」的写法（实测谎报正是「第3章已正式入库」）。
 */
// 术语人话化：定稿/已保存 与旧词 入库/落盘 双写，新旧模板都命中。
const COMPLETION_CLAIM = /已(?:经)?\s*(?:正式|成功)?\s*(?:生成|写好了?|写完|写入|保存|存好|存进|落盘|入库|定稿|提交了?入库)|已定稿[^。！？]{0,8}资料已更新/u;
// R3#2：关系整理类完成断言（generate_character_relationships 失败却说「关系已梳理清楚」=谎报）。
// 收窄到「关系」与「整理/梳理/理清/理顺」同现，避免误伤「整理思路/线索」等无关说法。
const RELATIONSHIP_COMPLETION_CLAIM = /(?:人物|角色)?关系[^。！？]{0,12}已(?:经)?\s*(?:整理|梳理|理清|理顺)|已(?:经)?\s*(?:整理|梳理)好?(?:人物|角色)?关系/u;
const COMMIT_COMPLETION_CLAIM = /已(?:经)?\s*(?:正式|成功)?\s*(?:入库|定稿|提交了?入库)|正式(?:入库|定稿)(?:完成|成功)|(?:入库|定稿)(?:完成|成功)|已定稿[^。！？]{0,8}资料已更新/u;
const COMMIT_PREVIEW_CLAIM = /(?:入库|定稿)(?:影响)?预览|定稿改动/u;
// 事实账本「已记入账本/已入账/硬事实已记」类完成断言（scoped 到 账本/账/事实，避免误伤「记住你的想法」这类对话）。
const FACT_COMPLETION_CLAIM = /已(?:经)?(?:把[^。！？]{0,16})?(?:记入|记进|记下|记到|登记|录入)[^。！？]{0,6}(?:账本|账|事实)|已(?:经)?入账|(?:硬事实|事实)[^。！？]{0,6}已(?:记|登记|入账)/u;
// 改稿/重写类完成断言（Codex retest2·铁律④）：revise_draft 全被诚实拒/重写没调 generate_draft，磁盘没变，
// agent 却口头说「修正了10处 / 已重写 / 改好了」。旧 COMPLETION_CLAIM 只认 生成/写入/入库 动词，漏掉改稿动词。
// 要求过去式完成标记（已…/…了/…了N处），避免误伤「建议改成…/可以帮你重写吗」这类提议、将来时。
const REVISION_COMPLETION_CLAIM = new RegExp([
  "(?:修正|改|替换|改写|润色|修订)了\\s*\\d+\\s*(?:处|个|句|段)",                       // 修正了10处 / 改了3句
  "已(?:经)?\\s*(?:把[^。！？]{0,16})?(?:改好|改完|改成|改为|换成|替换|修正|修订|润色|重写)",  // 已改好 / 已重写 / 已把X改成Y
  "(?:改好|改完|修正|修订|润色|重写|替换)(?:好|完)?了",                                  // 改好了 / 重写了 / 润色完了
].join("|"), "u");

/**
 * 多章「状态汇报」特征：带 ✅/❌ 状态标记，或一条消息里枚举了 ≥2 个带状态后缀的「第N章」。
 * 这类是 read_chapters_overview + 磁盘真相得出的诚实进度汇报（如「第1章✅已入库、第2章✅已入库」），
 * 不是「我刚完成了某事」的单次动作宣称——绝不能因为里面有「已入库」就误报成谎报（实测踩到的假阳性）。
 */
const CHAPTER_STATUS_MARKER = /第\s*\d+\s*章[^。！？，]{0,10}(?:✅|❌|已入库|已定稿|已提交|有草稿|无草稿|还没写|未写|空|待入库|待定稿)/gu;

/**
 * 聚合进度陈述（r8 真机假阳性）：用户问「看下当前状态」，agent 如实转述磁盘真相「全书已正式入库 100 章」，
 * 被 COMMIT_COMPLETION_CLAIM 误判成「谎报入库」（read-only 回合无写工具背书）。「全书/本书/共 N 章已入库」
 * 是状态描述、不是本回合动作宣称——豁免。单章动作宣称（「第88章已正式入库」）不受影响、照抓。
 */
const AGGREGATE_PROGRESS_STATEMENT =
  /(?:全书|本书|共|目前|现在)[^。！？]{0,8}\d+\s*章[^。！？]{0,6}(?:已|均|全部)?(?:正式)?(?:入库|定稿|提交)|已(?:正式)?(?:入库|定稿)\s*\d+\s*章/u;

function hasAnyCompletionClaim(content: string): boolean {
  return (
    COMPLETION_CLAIM.test(content) ||
    RELATIONSHIP_COMPLETION_CLAIM.test(content) ||
    FACT_COMPLETION_CLAIM.test(content) ||
    REVISION_COMPLETION_CLAIM.test(content)
  );
}

function isStatusReport(content: string): boolean {
  if (/[✅❌]/u.test(content)) return true;
  if ((content.match(CHAPTER_STATUS_MARKER) ?? []).length >= 2) return true;
  // 聚合进度句豁免，但同消息里还有「第N章已入库/已修正N处」式单次动作宣称时不豁免（那仍是本回合动作口径）。
  return AGGREGATE_PROGRESS_STATEMENT.test(content) && !hasAnyCompletionClaim(content.replace(AGGREGATE_PROGRESS_STATEMENT, ""));
}

function hasCompletedTool(toolSteps: readonly ToolStep[] | undefined, toolName: string): boolean {
  return (toolSteps ?? []).some((step) => step.toolName === toolName && step.status === "completed");
}

function hasToolAttempt(toolSteps: readonly ToolStep[] | undefined, toolName: string): boolean {
  return (toolSteps ?? []).some((step) => step.toolName === toolName);
}

function isBackedCommitPreviewClaim(content: string, toolSteps: readonly ToolStep[] | undefined): boolean {
  return COMMIT_PREVIEW_CLAIM.test(content) && !COMMIT_COMPLETION_CLAIM.test(content) && hasCompletedTool(toolSteps, "commit_preview");
}

/**
 * A1 谎报探针：assistant 回合做了「写类完成断言」却**没有任何真写类工具成功背书** → 判为口惠而实不至。
 *
 * 治头号根因「零工具调用却宣称完成」(ch8)，并覆盖「质检/预览成功但 commit_apply 没成功却谎称已入库」(实测见到)。
 * 两道闸：①多章状态汇报（✅❌/枚举多章）是诚实进度汇报、直接放过，避免误报；②否则要求有真写类工具成功背书，
 * 没有就判（commit_preview/quality_check/read 等成功不算背书）。失败的写工具本身也已在时间线结构性标红。
 * 纯确定性、保守，供 useChat 在回合收尾时挂一条诚实提醒。题材中立。
 */
export function detectUnbackedCompletionClaim(
  content: string,
  toolSteps: readonly ToolStep[] | undefined,
): boolean {
  if (!COMPLETION_CLAIM.test(content) && !RELATIONSHIP_COMPLETION_CLAIM.test(content) && !FACT_COMPLETION_CLAIM.test(content) && !REVISION_COMPLETION_CLAIM.test(content)) return false;
  if (isStatusReport(content)) return false;
  if (isBackedCommitPreviewClaim(content, toolSteps)) return false;
  const hasWriteSuccess = (toolSteps ?? []).some(stepBacksWriteClaim);
  return !hasWriteSuccess;
}

// 「整理关系」类请求（🕸 整理关系 按钮 / 自由打字）：用于给诚实文案选关系专属口径，
// 不要把关系工具失败误套成「正式入库未完成」（#5 真机：Kimi 关系失败却显示 commit_apply 缺失文案）。
const RELATIONSHIP_INTEGRATION_REQUEST = /(?:整理|梳理|理清|理顺)[^。！？]{0,30}关系|人物关系|关系(?:矩阵|网|图谱)/u;

const CONFIRM_COMMIT_RETRY_HINT = "请再发一次『确认定稿』，我会直接执行";

/**
 * 诚实文案选择：优先按**请求类型**给对的口径（userText），content 兜底。
 * - 整理关系类请求 → 关系专属文案（不误套 commit）。
 * - 否则 content 命中 commit 完成断言 → 入库未完成文案。
 * - 其余 → 通用「操作未完成」。
 */
export function unbackedCompletionNoticeText(content: string, userText = ""): string {
  if (RELATIONSHIP_INTEGRATION_REQUEST.test(userText) && !COMMIT_APPLY_REQUEST.test(userText)) {
    return "关系整理未完成：本回合没有检测到关系矩阵真正写入（梳理人物关系未成功），所以关系矩阵没有更新。多因书里硬事实还太少、暂无可整理的关系素材——可先多写几章或手动登记关系后再整理。";
  }
  if (COMMIT_COMPLETION_CLAIM.test(content)) {
    return `定稿未完成：本回合没有检测到定稿成功执行，所以没有证据表明章节已经正式写入并更新资料。${CONFIRM_COMMIT_RETRY_HINT}`;
  }
  if (FACT_COMPLETION_CLAIM.test(content)) {
    return "故事事实没有写入：本回合没有检测到记录故事事实成功执行，所以硬事实没有真正记下。请直接再说“把这些事实记进账本”。";
  }
  if (REVISION_COMPLETION_CLAIM.test(content)) {
    return "改稿没有真正保存：本回合没有检测到改写工具成功应用、或重写没有调用 generate_draft，所以草稿可能并未真正改动（修改方案往往因目标片段没逐字命中被诚实拒）。请以磁盘/工具结果为准，把要改的原文逐字说清后重试。";
  }
  return "操作未完成：本回合助手声称已经生成、写入或保存，但没有检测到对应写入工具成功执行。请以工具结果和磁盘状态为准，必要时重新执行。";
}

export interface MissingExecutionResult {
  readonly intent: string;
  readonly expectedTool: string;
  readonly notice: string;
}

interface ExecutionExpectation {
  readonly intent: string;
  readonly expectedTool: string;
  readonly notice: string;
  readonly matches: (text: string) => boolean;
}

// `方向(?![：:])`：避免吃掉出稿指令的「第N章方向：…」标题前缀（那是用户给了方向+要写正文，不是「只聊方向」的方案讨论）。
const WRITING_PLAN_ONLY = /(?:怎么写|如何写|方案|思路|建议|方向(?![：:])|大纲|聊聊|讨论|分析|评价|看看|要不要)/u;
const COMMIT_PREVIEW_REQUEST = /(?:入库预览|定稿(?:影响)?预览|生成.*预览|预览.*(?:入库|定稿)|看看.*(?:入库|定稿)|检查.*(?:入库|定稿)|准备.*(?:入库|定稿)|预览.*定稿改动)/u;
const COMMIT_APPLY_REQUEST = /(?:确认|正式|执行).{0,12}(?:入库|提交|定稿)|(?:入库|提交|定稿).{0,12}(?:确认|正式|执行)|直接(?:正式)?(?:入库|定稿)|提交本章|确认定稿|定稿吧|定稿并更新资料|把(?:这|第\s*\d+)\s*章.{0,12}(?:正式)?(?:入库|定稿)/u;
const NEGATED_COMMIT_PREVIEW = /(?:不用|无需|不要|先不|暂不).{0,8}预览/u;
// 裸『续写』→『续写(?!作)』：别被开书话术「后续写作必须用这些设定」里的「续写作」子串误命中（Codex 1-5 章真机）。
const DRAFT_GENERATION_REQUEST = /(?:写第?\s*\d+\s*章|(?:写|开始|进入)?下一章(?:的?正文)?|把(?:这|第\s*\d+)\s*章.{0,12}(?:写了|写出来|重写|续写)|写.*正文|出一版|再写一版|重写这章|续写(?!作)|继续写|动笔|来一段|把.*写出来|照这个写|按这个写)/u;
// 补开书话术：「写入角色/地点/资产/世界观/写作规则/设定」「开书资料」也是写资料（原正则只认「写入资料/写进资料」相邻写法）。
// 「补进角色卡/写角色卡」（Codex retest6 真机 P1）：用户常说「角色卡」而非字面「资料」，原正则只认「补.*角色资料」，
// 漏掉「补进角色卡」这种等价写法，导致这类请求落不到 foundation_write、被 generate_draft 的宽枝误吞。
const FOUNDATION_WRITE_REQUEST = /(?:记一下|记进|记录到|写进资料|写入资料|写入(?:角色|地点|资产|世界观|写作规则|设定)|开书资料|补进.*资料|补.*角色资料|补.*地点资料|补.*资产资料|补.*世界观|补.*写作规则|补.*(?:角色|人物)卡|写.*(?:角色|人物)卡|改.*资料|修改.*资料|改.*角色|删除.*角色|删掉.*角色|删.*角色|写清楚.*关系|整理.*资料|把.*记到.*卡|做厚.*资料|做厚.*世界观|做厚.*写作规则)/u;
const REVISION_REQUEST = /(?:润色|改写|去\s*AI\s*味|去AI味|扩写|缩写|把这段.*改|把.*语气改|改得.*一点)/u;
// 事实账本 = edit_fact_ledger（记硬事实/线索进账本）。scoped 到 (硬)事实/线索/账本 上下文，避免误吞「记住你的想法」这类对话。
const FACT_RECORD_REQUEST = /(?:硬事实|事实|线索|关键信息)[^。！？]{0,8}(?:记(?:住|下|进|到|入)?|登记|入账)|(?:记(?:住|下|进|到|入)|登记|录入)[^。！？]{0,8}(?:账本|账|硬事实|事实)|记进.{0,4}账本/u;
// 质检 = quality_check（硬伤/能不能入库口径）。审稿、AI 味体检各有独立工具，已从这里拆出去（见下方两条），
// 否则「审稿/AI味」会被误归到 quality_check，连带把模型正确调了 ai_review/check_ai_flavor 也误报「质检没执行」。
const QUALITY_REQUEST = /(?:质检|硬伤检查|检查.*正文|看看.*问题|质量检查|列出硬伤)/u;
// 内容审阅 = ai_review（评分 + 改进建议）。注意「评分/建议」会命中 WRITING_PLAN_ONLY，但那只 gate generate_draft、不影响这里。
// 新旧词双写：审稿/审校/内容审阅。
const AI_REVIEW_REQUEST = /(?:审稿|审校|内容审阅|审阅.{0,8}内容|审一下.{0,10}稿|审阅这一章|审.{0,6}这.{0,4}稿|给.{0,6}评分|评分.{0,6}改进)/u;
// 检查机器腔 = check_ai_flavor（查/列出机器腔/AI 腔，不改稿）。「去 AI 味」是改稿、归 revise_draft，故 matches 里排除 REVISION。
const AI_FLAVOR_REQUEST = /AI\s*味|AI\s*腔|AI\s*感|机翻感|机器腔|像.{0,4}AI.{0,4}写/iu;
// 出稿/改稿里「少/别/避免…AI 味」是**写作约束**（写的时候少点 AI 腔），不是「跑 check_ai_flavor 体检」的请求——别误报「AI 味体检没有执行」（Codex 1-5 章真机：出稿指令带「少AI味」被误判）。
const AI_FLAVOR_AS_CONSTRAINT = /(?:少|减少|降低|别|不要|不能|避免|没有?|不带|去掉|控制|压低|保持.{0,4}少).{0,3}(?:AI\s*味|AI\s*腔|AI\s*感)/iu;
// 明确「生成入库预览/出预览/做预览」=必须真跑 commit_preview 的请求，区别于「检查能不能入库」这类可行性问句（后者质检也能答、可让位）。
const EXPLICIT_PREVIEW_REQUEST = /(?:入库|定稿)(?:影响)?预览|(?:生成|出|做|来).{0,4}预览|预览.{0,4}(?:入库|定稿|这章|本章|第\s*\d+\s*章|定稿改动)/u;
const POLITE_EXECUTION_REQUEST = /(?:能不能|能否|可不可以|可以帮我|麻烦|帮我).{0,40}(?:补进|写进|记进|写入|补|删|删除|改|写第|写.*正文|入库|定稿|提交|质检|硬伤检查|审稿|内容审阅|润色|改写)/u;
const QUESTION_LIKE = /[？?]\s*$|(?:吗|呢|会不会|有没有|能不能|能否|可不可以|可以吗)/u;
// 反转（自我更正）语气词：出现在被否定动词前后，表示「改主意、还是要做」。
const REVERSAL_MARKER = "(?:直接|确认|正式|执行|现在|马上|还是|重新|算了|就|先)";
// 反转必须针对【同一意图】的动词：否定某动作后又正向要求【同一动作】才算自我更正。
// 反例：「不要质检，直接入库」里的「入库」属于 commit_apply、不能拿来反转 quality_check 的否定，
// 否则每次「不质检、直接入库」都会误报「质检没有执行」（用户实测：每次入库都跳出来吓人）。
const INTENT_REVERSAL_VERB: Readonly<Record<string, string>> = {
  commit_preview: "预览",
  commit_apply: "(?:入库|提交|定稿)",
  generate_draft: "(?:正文|出稿|动笔|续写|再写一版|重写这章)",
  foundation_write: "(?:资料|角色卡|人物卡)",
  edit_fact_ledger: "(?:入账|登记|账本|记进|记下|记住)",
  revise_draft: "(?:改写|润色|修订|重写)",
  check_ai_flavor: "(?:AI\\s*味|AI\\s*腔|AI\\s*感|机器腔)",
  ai_review: "(?:审稿|审校|内容审阅|审阅)",
  quality_check: "(?:质检|硬伤检查)",
};

/** 否定后是否出现【同一意图】的正向反转（自我更正）。跨意图的正向动作不算数。 */
function hasSameIntentReversal(suffix: string, intent: string): boolean {
  const verb = INTENT_REVERSAL_VERB[intent];
  if (!verb) return false;
  const reversal = new RegExp(
    `${REVERSAL_MARKER}[^，。；,.;!?？]{0,12}${verb}|${verb}[^，。；,.;!?？]{0,8}${REVERSAL_MARKER}`,
    "u",
  );
  return reversal.test(suffix);
}
// 否定改【逐意图】判定（Codex 5 章 E2E·P1）：旧的全局 hasBlockingNegation 把「不要正式入库」整条熔断，
// 连坐放过同消息里「质检/AI味/预览」三个正向请求。改成只挡【被否定的那个意图】——否定 X 不影响正向请求的 Y。
const NEG_PREFIX = "(?:先)?(?:别(?!的)|不要|先不|暂不|无需|不用)[^，。；,.;!?？]{0,8}";
const INTENT_NEGATION_PATTERNS: Readonly<Record<string, RegExp>> = {
  commit_preview: new RegExp(`${NEG_PREFIX}预览`, "u"),
  commit_apply: new RegExp(`${NEG_PREFIX}(?:正式)?(?:入库|提交|定稿)`, "u"),
  generate_draft: new RegExp(`${NEG_PREFIX}(?:正文|出稿|动笔|出一版|写(?!资料|入|进|其他|别的|下一|后面|后续))`, "u"),
  foundation_write: new RegExp(`${NEG_PREFIX}(?:写资料|写入资料|资料|补|删|删除)`, "u"),
  edit_fact_ledger: new RegExp(`${NEG_PREFIX}(?:记|入账|登记)`, "u"),
  revise_draft: new RegExp(`${NEG_PREFIX}(?:改|润色|改写)`, "u"),
  check_ai_flavor: new RegExp(`${NEG_PREFIX}(?:AI\\s*味|AI\\s*腔|机器腔)`, "iu"),
  ai_review: new RegExp(`${NEG_PREFIX}(?:审稿|审校|内容审阅|审阅)`, "u"),
  quality_check: new RegExp(`${NEG_PREFIX}(?:质检|硬伤检查)`, "u"),
};

const EXECUTION_EXPECTATIONS: readonly ExecutionExpectation[] = [
  {
    intent: "commit_preview",
    expectedTool: "commit_preview",
    notice: "定稿影响预览没有执行：本回合没有检测到定稿预览操作，所以没有生成可用于定稿的预览。请直接再说“生成定稿影响预览”。",
    // 明确「生成定稿/入库预览」即便句尾带「不要正式定稿」否定（会让 COMMIT_APPLY_REQUEST 误吞），也算预览请求——治假预览谎报漏报。
    matches: (text) => (COMMIT_PREVIEW_REQUEST.test(text) && !COMMIT_APPLY_REQUEST.test(text)) || EXPLICIT_PREVIEW_REQUEST.test(text),
  },
  {
    intent: "commit_apply",
    expectedTool: "commit_apply",
    notice: `定稿没有执行：本回合没有检测到定稿操作，所以章节没有正式写入并更新资料。${CONFIRM_COMMIT_RETRY_HINT}`,
    matches: (text) => COMMIT_APPLY_REQUEST.test(text) && (!COMMIT_PREVIEW_REQUEST.test(text) || NEGATED_COMMIT_PREVIEW.test(text)),
  },
  {
    intent: "generate_draft",
    expectedTool: "generate_draft",
    notice: "正文生成没有执行：本回合没有检测到生成正文操作，所以没有真正生成或覆盖草稿。请直接再说“按刚才要求写正文”。",
    // 让位给写资料：「把赵叔的小传写出来，记进角色资料」既命中 generate_draft 宽枝（把…写出来/来一段），
    // 又是写资料请求。照 revise_draft 同款 !FOUNDATION_WRITE_REQUEST，避免写资料被误报「正文生成没有执行」（Codex 真机 P1）。
    matches: (text) => DRAFT_GENERATION_REQUEST.test(text) && !WRITING_PLAN_ONLY.test(text) && !FOUNDATION_WRITE_REQUEST.test(text),
  },
  {
    // 必须排在 foundation_write 之前：「把硬事实记进账本」是记事实(edit_fact_ledger)、不是写设定资料。
    intent: "edit_fact_ledger",
    expectedTool: "edit_fact_ledger",
    notice: "事实账本没有写入：本回合没有检测到整理事实账本操作，所以硬事实没有真正记进账本。请直接再说“把这些事实记进账本”。",
    matches: (text) => FACT_RECORD_REQUEST.test(text),
  },
  {
    intent: "foundation_write",
    expectedTool: "foundation_write",
    notice: "资料写入没有执行：本回合没有检测到写入资料操作，所以资料没有真正保存。不需要你重复解释；请直接再说“按刚才的内容写入资料”。",
    matches: (text) => FOUNDATION_WRITE_REQUEST.test(text) && !FACT_RECORD_REQUEST.test(text),
  },
  {
    intent: "revise_draft",
    expectedTool: "revise_draft",
    notice: "改稿没有执行：本回合没有检测到润色改写操作，所以正文没有真正被润色或改写。请直接再说“按刚才要求改稿”。",
    matches: (text) => REVISION_REQUEST.test(text) && !FOUNDATION_WRITE_REQUEST.test(text),
  },
  {
    // 必须排在 revise_draft 之后：「去 AI 味」是改稿（revise 先命中），「查/列出 AI 味」才是体检。
    intent: "check_ai_flavor",
    expectedTool: "check_ai_flavor",
    notice: "机器腔检查没有执行：本回合没有检测到检查机器腔操作，所以没有真正检查机器腔。请直接再说“检查这一章的机器腔”。",
    matches: (text) => AI_FLAVOR_REQUEST.test(text) && !REVISION_REQUEST.test(text) && !AI_FLAVOR_AS_CONSTRAINT.test(text),
  },
  {
    intent: "ai_review",
    expectedTool: "ai_review",
    notice: "内容审阅没有执行：本回合没有检测到内容审阅操作，所以没有真正完成审阅。请直接再说“审阅这一章的内容”。",
    matches: (text) => AI_REVIEW_REQUEST.test(text) && !QUALITY_REQUEST.test(text) && !AI_FLAVOR_REQUEST.test(text),
  },
  {
    intent: "quality_check",
    expectedTool: "quality_check",
    notice: "硬伤检查没有执行：本回合没有检测到硬伤检查操作，所以没有真正完成硬伤检查。请直接再说“硬伤检查这一章”。",
    matches: (text) => QUALITY_REQUEST.test(text),
  },
];

function isNonExecutionQuestion(text: string): boolean {
  return QUESTION_LIKE.test(text) && !POLITE_EXECUTION_REQUEST.test(text);
}

/** 该意图是否被用户明确否定（且否定后没有针对【同一意图】的正向反转）→ 只挡这一个意图，不连坐别的正向请求。 */
function isExpectationNegated(text: string, intent: string): boolean {
  const pattern = INTENT_NEGATION_PATTERNS[intent];
  if (!pattern) return false;
  const match = pattern.exec(text);
  if (!match || match.index === undefined) return false;
  const suffix = text.slice(match.index + match[0].length);
  return !hasSameIntentReversal(suffix, intent);
}

/**
 * A2 执行一致性探针：用户请求是明确执行类任务，但本回合完全没有对应工具尝试 → 拦下普通闲聊式回复。
 *
 * 这层不判断工具成功与否；只判断「该调用的工具是否被尝试」。只要工具出现过（completed/failed/needs_confirmation/running），
 * 结果都交给工具时间线和专门错误文案展示，避免把诚实失败误判为没执行。
 */
const INTENT_LABEL: Readonly<Record<string, string>> = {
  commit_preview: "定稿影响预览",
  commit_apply: "定稿",
  generate_draft: "正文生成",
  foundation_write: "更新故事资料",
  edit_fact_ledger: "记录故事事实",
  revise_draft: "修改草稿",
  check_ai_flavor: "检查机器腔",
  ai_review: "内容审阅",
  quality_check: "硬伤检查",
};

/** 组合指令多项都没执行时，列全所有缺失项的一条提醒——直接覆盖整条假结果消息，别让用户以为其中某项真做了。 */
function composeCombinedMissingNotice(missing: readonly MissingExecutionResult[]): string {
  const labels = missing.map((item) => INTENT_LABEL[item.intent] ?? item.intent);
  return `本回合这些操作都没有执行：${labels.join("、")}。助手给出的是口头结果、不是真正的工具输出——请重新发送，让我真正调用这些工具。`;
}

/**
 * 有依据的拒绝/不可行回复（审计 A-4 误报实锤：用户「把第 99 章正式入库」，agent 调读类工具核实后
 * 如实答「第 99 章不存在、没法入库」——已调读工具、没调 commit_apply 都是对的，不是「只有口头声称」）。
 * 回复含拒绝/不可行语义且本回合真调过读类工具（拒绝有磁盘依据）→ 执行一致性探针豁免：
 * 不追加系统更正、不自动重做。零读工具的纯口头拒绝不豁免（无依据的拒绝照样可能是空转）；
 * 混着写类完成断言的回复已由 A1（detectUnbackedCompletionClaim）先行判决，走不到这层豁免。
 * `(?<!能)不能`：排除「能不能…」反问句式里的「不能」。
 */
const REFUSAL_OR_INFEASIBLE = /(?:不存在|没法|无法|还没有|(?<!能)不能)/u;
const READ_TOOL_NAME = /^read_/u;

export function isGroundedRefusalReply(
  content: string,
  toolSteps: readonly ToolStep[] | undefined,
): boolean {
  if (!REFUSAL_OR_INFEASIBLE.test(content)) return false;
  return (toolSteps ?? []).some(
    (step) => typeof step.toolName === "string" && READ_TOOL_NAME.test(step.toolName),
  );
}

export function detectMissingExecutionForRequest(
  userText: string,
  toolSteps: readonly ToolStep[] | undefined,
): MissingExecutionResult | null {
  const text = userText.trim();
  if (!text) return null;
  if (isNonExecutionQuestion(text)) return null;
  const missing: MissingExecutionResult[] = [];
  for (const expectation of EXECUTION_EXPECTATIONS) {
    if (!expectation.matches(text)) continue;
    // 否定只挡【被否定的那个意图】：组合指令「质检+预览，不要正式入库」里，否定 commit_apply 不该连坐放过质检/预览。
    if (isExpectationNegated(text, expectation.intent)) continue;
    // 该意图真尝试过（含 failed/needs_confirmation）→ 不算缺；但**不再全局 return null**，
    // 否则组合指令里「质检真跑了、预览没跑」会被质检的尝试整体放过、漏报没跑的预览（Codex 5 章 E2E）。
    if (hasToolAttempt(toolSteps, expectation.expectedTool)) continue;
    // 「检查能不能入库」这类既像入库预览、又像质检的【模糊可行性问句】：若本回合已真跑了 quality_check（质检也是在答
    // 「这章能不能入库」），就别再用「入库预览没执行」盖掉质检结果（afterfix·Codex 真机：质检轮被误盖成 commit_preview 提醒）。
    // 但【明确要「生成入库预览」】绝不因质检完成而让位——否则组合指令里没真跑 commit_preview 却谎称「预览通过」会漏报（Codex 1-5 章真机·假预览）。
    if (expectation.intent === "commit_preview" && hasCompletedTool(toolSteps, "quality_check") && !EXPLICIT_PREVIEW_REQUEST.test(text)) continue;
    // 「继续写下一章/接着写」既像出稿，模型也可能（因前一章未入库、直接生成会被守卫拒、穿帮）改为 revise_draft
    // 扩写当前章 + 建议下一步。若本回合真跑了 revise_draft（草稿确被改写），就别再用「正文生成没有执行·没有覆盖
    // 草稿」盖掉——既与「润色改写」步骤矛盾，其补救「再说写正文」还会撞前一章未入库的守卫拒绝、是死路（Codex 真机）。
    if (expectation.intent === "generate_draft" && hasCompletedTool(toolSteps, "revise_draft")) continue;
    // 开书/写资料回合：DRAFT 宽枝可能撞上写资料话术，但本回合真跑了 foundation_write（资料确落盘），就别误报
    // 「正文生成没有执行」——同 revise 让位范式（Codex 1-5 章真机：开书写入角色/地点/世界观被误报）。
    if (expectation.intent === "generate_draft" && hasCompletedTool(toolSteps, "foundation_write")) continue;
    missing.push({
      intent: expectation.intent,
      expectedTool: expectation.expectedTool,
      notice: expectation.notice,
    });
  }
  if (missing.length === 0) return null;
  if (missing.length === 1) return missing[0]!;
  // 多项都缺：第一项作 intent/expectedTool（兼容旧用法），notice 列全所有缺失项。
  return { intent: missing[0]!.intent, expectedTool: missing[0]!.expectedTool, notice: composeCombinedMissingNotice(missing) };
}

// ============ 服从重试（r8：治「口头声称完成但零工具调用」的执行层，配合服务端自动重做） ============

/** 服务端更正文案的固定前缀（agent-chat 追加更正时使用；历史消毒据此识别「声称已被作废」的回合）。 */
export const HONESTY_CORRECTION_MARKER = "⚠️ 系统更正：";

/**
 * 服从重试的可见过渡文案：首轮只口头声称、未调工具时，服务端在自动重做前把它推给用户，
 * 让可见记录保持诚实（前面的声称无效、后面才是真实执行）。**必须整串原样输出**——
 * 历史消毒（sanitizeCorrectedAssistantHistory）按整串切分丢弃被作废的声称段。
 */
export const OBEDIENCE_RETRY_TRANSITION_TEXT =
  "\n\n⚠️ 系统提示：检测到上述操作只有口头声称、没有实际执行，已自动重做——以下才是真实执行结果。\n\n";

/**
 * 服从重试的纠偏消息（追加进模型消息序列后重跑一轮）。措辞要点：①宣布上一轮声称全部作废；
 * ②点名「必须调用工具」并给意图→工具对照（弱模型需要显式路标）；③禁止在拿到工具成功结果前再输出完成句；
 * ④若已定位到期望工具（服务端会同时强制 toolChoice），明说本轮该调哪个。
 */
export function buildObedienceRetryNudgeMessage(
  userText: string | undefined,
  forcedToolName?: string,
): { role: "system"; content: string } {
  return {
    role: "system",
    content:
      "【系统纠偏·必须服从】你上一轮只输出了口头声称，没有调用任何工具——那些「已生成/已写入/已入库/已落盘」的说法全部无效、已被系统作废，磁盘上什么都没发生。" +
      `现在重新处理用户本轮请求${userText?.trim() ? `（原话：「${userText.trim()}」）` : ""}：` +
      (forcedToolName
        ? `本轮你必须调用 ${forcedToolName} 工具真正执行（系统已强制，不允许只回文本）。`
        : "立即调用对应工具真正执行——写正文→generate_draft；入库预览→commit_preview；正式入库→先 commit_preview 后 commit_apply；写资料→foundation_write；改稿→revise_draft；其余同理。") +
      "在拿到工具成功结果（ok=true）之前，绝对禁止输出任何「已完成/已生成/已写入/已入库/已落盘」类句子。",
  };
}

/**
 * 从「声称文本」反推被编造的写类工具（r8 三轮·ch96 实锤）：模型真跑了 commit_preview、却把
 * commit_apply 编出来——此时用户意图（预览+入库组合句）里预览已尝试、apply 让位于组合语义，
 * detectMissingExecutionForRequest 定位不到期望工具；但声称本身就指认了被编造的动作。
 * 只认无歧义的映射（入库→commit_apply / 改稿→revise_draft / 记账→edit_fact_ledger），
 * 「已生成/已写入」这类泛动词在 generate_draft/foundation_write 间有歧义，返回 undefined 走 required 兜底。
 */
export function inferClaimedWriteTool(content: string): string | undefined {
  if (COMMIT_COMPLETION_CLAIM.test(content)) return "commit_apply";
  if (REVISION_COMPLETION_CLAIM.test(content)) return "revise_draft";
  if (FACT_COMPLETION_CLAIM.test(content)) return "edit_fact_ledger";
  return undefined;
}

/**
 * 历史回执污染清洗（r8 任务②）：被系统更正/作废过的编造回执若原样留在历史里，会成为后续回合的
 * 「造假范本」（模型续写它见过 N 遍的回执剧本而不调工具——ch84/ch88 实锤的正反馈污染）。进站消毒：
 * - assistant 历史消息含「系统更正」标记 → 整条替换成短桩（那一轮什么都没写入，编造正文没有保留价值）；
 * - assistant 历史消息含「自动重做」过渡 → 丢弃最后一处过渡之前的被作废声称段，只保留真实结果段；
 * - user 消息绝不动（用户原话是意图门的授权依据）。
 * 纯确定性字符串处理。已知可接受的边角：assistant 正经讨论「系统更正」机制本身的消息会被误桩化——
 * 该字符串只在护栏输出中出现，正常写作对话不会撞上。
 */
export const CORRECTED_CLAIM_HISTORY_STUB =
  "（本回合曾口头声称完成操作，但没有执行任何工具，声称已被系统更正作废；实际没有写入任何内容。）";
export const RETRIED_CLAIM_HISTORY_PREFIX =
  "（本回合最初的口头声称未实际执行、已被系统作废并自动重做，以下是重做后的真实结果：）";

export function sanitizeCorrectedAssistantHistory<T extends { readonly role: string; readonly content: string }>(
  messages: readonly T[],
): readonly T[] {
  return messages.map((message) => {
    if (message.role !== "assistant") return message;
    if (message.content.includes(HONESTY_CORRECTION_MARKER)) {
      return { ...message, content: CORRECTED_CLAIM_HISTORY_STUB };
    }
    if (message.content.includes(OBEDIENCE_RETRY_TRANSITION_TEXT)) {
      const segments = message.content.split(OBEDIENCE_RETRY_TRANSITION_TEXT);
      const realTail = (segments[segments.length - 1] ?? "").trim();
      return { ...message, content: `${RETRIED_CLAIM_HISTORY_PREFIX}\n${realTail}` };
    }
    return message;
  });
}

/** 诚实收尾改写补丁：盖掉假成功正文，并清掉同一条消息上 agent 顺手挂的、与诚实结论矛盾的前瞻卡。 */
export interface HonestyRewritePatch {
  readonly content: string;
  readonly segments: undefined;
  /** 清掉「下一步·直接入库」诱导卡（suggest_next_steps 挂的）——否则与「没执行」自相矛盾。 */
  readonly nextStepPrompt: undefined;
  /** 清掉「质检通过」明细卡——本回合质检根本没真跑。 */
  readonly qualityReport: undefined;
  /** 定稿口头成功时挂「重新确认定稿」一键重发（走 commit-apply 建议动作）。 */
  readonly suggestedActions?: readonly {
    readonly id: string;
    readonly label: string;
    readonly description: string;
    readonly permission: "formal_state_write";
    readonly requiresConfirmation: false;
  }[];
}

const CONFIRM_COMMIT_RETRY_ACTION = {
  id: "commit-apply",
  label: "重新确认定稿",
  description: "再次发送「确认定稿」，直接执行入库",
  permission: "formal_state_write" as const,
  requiresConfirmation: false as const,
};

function clearedPatch(notice: string, withCommitRetry = false): HonestyRewritePatch {
  return {
    content: notice,
    segments: undefined,
    nextStepPrompt: undefined,
    qualityReport: undefined,
    ...(withCommitRetry ? { suggestedActions: [CONFIRM_COMMIT_RETRY_ACTION] } : {}),
  };
}

/**
 * 回合诚实收尾：本回合「声称完成却无写类工具背书」(A1) 或「请求了执行类动作却没调对应工具」(A2) →
 * 返回用诚实失败文案盖掉假成功的消息补丁，并**连带清掉同一条消息上的诱导性前瞻卡**
 * （nextStepPrompt「直接入库」/ qualityReport「质检通过」）。
 *
 * 治 Bug3：诚实兜底原本只改 content/segments，却留下 agent 调 suggest_next_steps 挂的「可入库」卡，
 * 于是「质检没有执行」正文与「直接入库」卡并存、自相矛盾。无需改写 → null。纯确定性，供 useChat 回合收尾调用。
 */
export function honestyRewritePatch(args: {
  readonly content: string;
  readonly toolSteps: readonly ToolStep[] | undefined;
  readonly userText: string;
}): HonestyRewritePatch | null {
  if (detectUnbackedCompletionClaim(args.content, args.toolSteps)) {
    const notice = unbackedCompletionNoticeText(args.content, args.userText);
    const isCommit = COMMIT_COMPLETION_CLAIM.test(args.content) || COMMIT_APPLY_REQUEST.test(args.userText);
    return clearedPatch(notice, isCommit);
  }
  // 有依据的拒绝不是违令（审计 A-4）：读了盘如实说「不存在/没法入库」，别盖「没有执行」文案。
  if (isGroundedRefusalReply(args.content, args.toolSteps)) return null;
  const missingExecution = detectMissingExecutionForRequest(args.userText, args.toolSteps);
  if (missingExecution) {
    return clearedPatch(missingExecution.notice, missingExecution.intent === "commit_apply");
  }
  return null;
}
