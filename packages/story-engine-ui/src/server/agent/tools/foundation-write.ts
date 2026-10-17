/**
 * foundation_write — 写类工具：把结构化的资料写入意图落盘（角色 / 地点 / 资产 / 世界规则 /
 * 写作规则的建·改·删·改名）。
 *
 * 资料写入工作流：agent 给出结构化写入意图
 * （actionType + targetId + after），本工具组装成 FoundationWriteSuggestion，交给引擎的
 * classify + applyFoundationWriteSuggestion 落盘（引擎自带风险分级与目标缺失诚实跳过）。
 *
 * 铁律：
 * - 直接做 + 可撤销：用 writeTool 包装，落盘前已建快照，output 带 snapshotId。
 * - 绝不静默失败 / 绝不谎报：看引擎真实 writes / skipped / blocked，写不进不报成功。
 * - 作者档（重构 P4）：删角色、引擎判为 needs_confirmation 的写入（如覆盖已确立的年龄/性别）只出
 *   「确认改设定」按钮（输出 foundationConfirm），作者点了由服务端带作者确认执行
 *   （agent/foundation-decisions.ts）。AI 自己调永远不会真写这类改动，也不再读作者原话猜「同意」。
 * - 题材中立：description / 字段说明用中性词，不注入任何题材。
 */
import {
  applyFoundationWriteSuggestion,
  buildStateOverview,
  STYLE_EXEMPLAR_MAX_COUNT,
  STYLE_EXEMPLAR_MAX_TEXT_CHARS,
  type FoundationWriteResult,
  type FoundationWriteSuggestionLike,
} from "@actalk/story-engine";
import { z } from "zod";
import { blankToUndefined, coerceEnum, coerceEnumValues, coerceJsonObject } from "./lenient-args.js";

import { writeTool } from "../withSnapshot.js";
import { readCharacterNameById, resolveEntityLabel } from "../presence/entity-labels.js";
import { resolveFoundationUpdateTargetId } from "../../lib/project-io.js";
import { buildFoundationKnownEntities } from "./foundation-known-entities.js";
import { manageStyleExemplarsLogic, type ManageStyleExemplarsOutput, type StyleExemplarAction } from "./manage-style-exemplars.js";

/** 支持的资料写入动作。覆盖 foundation-write-gateway 的全部建/改/删/改名动作；style_exemplar_* 四个在工具内
 * 转给 manageStyleExemplarsLogic（作者文风样本，同是 writing-rules.json 一族），不进引擎网关。 */
export const FOUNDATION_WRITE_ACTION_TYPES = [
  "create_character",
  "update_character_detail",
  "rename_character",
  "create_location",
  "update_location_detail",
  "create_asset",
  "update_asset_status",
  "update_world_rule",
  "update_writing_rule",
  "delete_foundation_entry",
  "style_exemplar_add",
  "style_exemplar_list",
  "style_exemplar_update",
  "style_exemplar_remove",
] as const;
export type FoundationWriteActionType = (typeof FOUNDATION_WRITE_ACTION_TYPES)[number];

/** style_exemplar_* 动作（2026-10-12 编辑部 R3b：manage_style_exemplars 并入本工具）。 */
export const STYLE_EXEMPLAR_ACTION_TYPES = ["style_exemplar_add", "style_exemplar_list", "style_exemplar_update", "style_exemplar_remove"] as const;
export type StyleExemplarActionType = (typeof STYLE_EXEMPLAR_ACTION_TYPES)[number];

export function isStyleExemplarActionType(actionType: string): actionType is StyleExemplarActionType {
  return (STYLE_EXEMPLAR_ACTION_TYPES as readonly string[]).includes(actionType);
}

function styleExemplarActionOf(actionType: StyleExemplarActionType): StyleExemplarAction {
  return actionType === "style_exemplar_add" ? "add"
    : actionType === "style_exemplar_list" ? "list"
      : actionType === "style_exemplar_update" ? "update"
        : "remove";
}

export const FOUNDATION_WRITE_CATEGORIES = [
  "characters",
  "characterRelationships",
  "locations",
  "assets",
  "world",
  "writingRules",
] as const;
export type FoundationWriteCategory = (typeof FOUNDATION_WRITE_CATEGORIES)[number];

export const FOUNDATION_WRITE_ASSETIZATION_GUIDANCE =
  "【资料资产化】用户给了角色/地点/资产/世界/写作规则的基础信息时，after 要一笔写成可写正文的结构化资料，" +
  "不要只把用户原话薄薄塞进一个字段。把用户已明说的事实拆进最贴近的引擎字段：角色用 identity/desire/fear/" +
  "relationshipToProtagonist/relationshipDynamics/personalityBaseline/behaviorBoundaries/knowledgeKnown/" +
  "knowledgeUnknown/cannotReveal/cannotDo/appearanceAnchors/extraFields；地点用 narrativeFunction/risks/floors/" +
  "rooms/extraFields；资产用 status/usageRules/lossRules/narrativeFunction/risks/notes/extraFields；" +
  "世界和写作规则用对应数组字段。不得凭空补具体事实；不知道就留空，或写进 knowledgeUnknown/cannotReveal/" +
  "extraFields 这类边界字段。";

/** 入参 schema（「确认改设定」按钮带回的写入，服务端执行前也按它校验）。 */
export const foundationWriteInputSchema = z.object({
  // 模型无关：枚举大小写宽容。actionType 全小写 snake → coerceEnum；category 含 camelCase
  // （characterRelationships/writingRules）→ coerceEnumValues 大小写不敏感映射回 canonical。这是唯一写资料工具，
  // 模型一旦传错大小写就 InputValidationError 写不进，宽容很值。
  actionType: coerceEnum(z.enum(FOUNDATION_WRITE_ACTION_TYPES).describe(
    "记进已有角色卡=update_character_detail；新建=create_*；改名=rename_character；删除=delete_foundation_entry（配 category）；" +
      "作者文风样本=style_exemplar_add/list/update/remove（category 填 writingRules）。",
  )),
  category: coerceEnumValues(FOUNDATION_WRITE_CATEGORIES, z.enum(FOUNDATION_WRITE_CATEGORIES).describe(
    "写或删哪一类资料（characterRelationships=角色关系条目）。",
  )),
  targetId: z.string().optional().describe(
    "目标实体 id（更新/改名/删除已有角色·地点·资产时必填，先用 read_foundation/read_state_overview 取得）；style_exemplar_update/remove 也可作样本 id（先 style_exemplar_list 取得）。新建留空。",
  ),
  targetName: z.string().optional().describe("按名字定位（只对 update_* 生效）；改名和删除必须给 targetId。"),
  before: z.unknown().optional().describe(
    "删除关系条目 / 世界规则 / 写作规则这类「按内容删」时，填要删除的原文字符串（引擎据此精确定位）。",
  ),
  // 长跑 #3（改名入参缺口·模型无关归一）：改名的「新名字」给一条直达参数——真机首调用时模型在
  // targetName（=旧名，按名定位用）与 after.name 之间没有明确指路，猜错就报「缺参数」再自愈重试。
  // 只在 after 里没写 name/newName 时生效；两边都给以 after 为准（更完整的结构化意图）。
  newName: z.string().optional().describe(
    "rename_character 专用：角色的新名字直接填这里（等价写进 after.name，二选一即可）。旧名字用 targetId/targetName 定位，别把新名字放进 targetName。",
  ),
  // 长跑 #3：after 允许整体省略（默认 {}）——省略时引擎按缺字段诚实 skip 回报，
  // 不再让整次调用死在 zod 硬校验 InputValidationError 上（边界宽容，见 CLAUDE.md 模型无关原则）。
  after: coerceJsonObject(z.record(z.string(), z.unknown()).default({}).describe(
    // 2026-10-10 对话 AI 瘦身：键名对照保留（写错键就不落盘），去掉重复的说明文字。
    "要写入的内容，键名必须用下面的引擎字段，否则不落盘（删除可填 {}）。\n" +
      `${FOUNDATION_WRITE_ASSETIZATION_GUIDANCE}\n` +
      "- 改名：{\"name\":\"新名\"}（或顶层 newName）。新建角色要有 name。\n" +
      "- 角色字符串字段：age/gender/identity/desire/fear/weakness/contradiction/moralBoundary/privateMotive/relationshipToProtagonist/trustLevel/speechStyle；" +
      "字符串数组：appearanceAnchors（外貌特征）/relationshipDynamics（关系动态）/speechSamples（说话示例）/personalityBaseline（性格基线）/behaviorBoundaries（行为边界）/" +
      "knowledgeKnown（已知）/knowledgeUnknown（未知）/cannotReveal（不可透露）/cannotDo（不会做的事）。\n" +
      "- 地点：name/type/floors/rooms/narrativeFunction/risks；资产：name/status；世界规则：rules/socialOrder/historyFacts/powerOrSurvivalSystems（数组）。\n" +
      "- 写作规则：proseStyle/forbiddenContent/doNotDo（数组）；customNotes=整段自由 Markdown（空串=清空）；targetChapterWords=每章目标字数；" +
      "用户说『每章至少 N 字』要同时传 minChapterChineseCharacters=N（0=清除下限）。\n" +
      "- 没有专用字段的杂项：{\"extraFields\":{\"键\":\"值\"}}。\n" +
      "- 纠错（角色和写作规则）：删某几条 {\"removeFromArrays\":{\"字段\":[\"原文\"]}}（原文逐字照抄 read_foundation）；改一条=同一次删旧+加新；" +
      "整列重写 {\"replaceArrays\":{\"字段\":[...]}}（[]=清空）；删自定义键 {\"removeExtraFieldKeys\":[\"键\"]}。没匹配上会 ok:false。",
  )),
  exemplarTitle: blankToUndefined(z.string().optional().describe(
    "style_exemplar_*：样本标题。add 必填；没给 targetId 时 update/remove 按标题定位；同给时是要改成的新标题。",
  )),
  exemplarText: blankToUndefined(z.string().optional().describe(
    `style_exemplar_*：样本正文（作者自己写的、想让 AI 模仿风格的段落）。add 必填；update 给了才替换。最多 ${STYLE_EXEMPLAR_MAX_COUNT} 条、单条 ≤${STYLE_EXEMPLAR_MAX_TEXT_CHARS} 字，超限如实拒绝。`,
  )),
  exemplarNote: blankToUndefined(z.string().optional().describe(
    "style_exemplar_*：可选备注（这段是什么/想让 AI 学什么）。add/update 给了才写。",
  )),
  rationale: z.string().optional().describe("为什么写这条（一句话，便于结果卡说明）。"),
});

const inputSchema = foundationWriteInputSchema;

const outputSchema = z.object({
  snapshotId: z.string().describe("本次写入前的快照 id，前端凭此可一键撤销。"),
  ok: z.boolean().describe(
    "统一诚实成功标志：true=确实写入了内容；false=未写入（目标缺失跳过 / 需用户确认 / 被拦截）。" +
      "前端结构性防谎报与 agent 诚实回报都只认这个字段。",
  ),
  applied: z.boolean().describe("是否真的写入了内容。"),
  needsConfirmation: z.boolean().describe("是否因『需用户确认』被挡下（如删除已晋升/已出场角色）。为 true 时未写入任何内容。"),
  partialMiss: z.boolean().describe("写成功，但有 removeFromArrays/删键目标没命中（如『改某条』旧原文差字没删成、新值已加）。为 true 时前端显示『部分完成』(琥珀色，不当全成功)，提示用户核对、避免新旧并存。"),
  writes: z.array(z.object({
    action: z.string(),
    targetFile: z.string(),
    targetName: z.string().optional(),
    summary: z.string(),
  })).describe("实际落盘的写入记录（诚实回报）。"),
  skipped: z.array(z.object({
    reason: z.string(),
    action: z.string(),
    summary: z.string(),
  })).describe("因目标缺失等被跳过的写入（诚实回报，不假装成功）。"),
  blocked: z.array(z.object({
    level: z.string(),
    reason: z.string(),
    targetFile: z.string(),
  })).describe("被风险拦截或需确认而未写入的项（含 level=needs_confirmation/blocked）。"),
  overview: z.unknown().describe("落盘后重新读取的 StateOverview，供前端刷新资料面板。"),
  summary: z.string().describe("写入结果的自然语言摘要。"),
  refreshScope: z.literal("foundation").optional().describe("影响面提示；style_exemplar_list 只读不带。"),
  // style_exemplar_* 专属（原 manage_style_exemplars 的结果形状；action=list 只读，前端诚实探针据此不给写背书）。
  action: z.string().optional().describe("style_exemplar_*：本次动作（add/list/update/remove）。"),
  count: z.number().optional().describe("style_exemplar_*：动作后的样本总数。"),
  exemplars: z.array(z.object({
    id: z.string(),
    title: z.string(),
    text: z.string(),
    note: z.string().optional(),
    createdAtMs: z.number(),
  })).optional().describe("style_exemplar_*：动作后的全量样本（list 时即现有清单）。"),
  droppedBad: z.array(z.string()).optional().describe("style_exemplar_*：被跳过的损坏样本条目及原因。"),
  foundationConfirm: z.object({
    key: z.string(),
    label: z.string(),
    input: z.record(z.string(), z.unknown()),
  }).optional().describe("needsConfirmation=true 时「确认改设定」按钮带的东西（界面用，你不用转述）。"),
});

/** 由 actionType + category 推导引擎期望的 targetFile（与 foundation-write-gateway 的校验一致；style_exemplar_* 不进引擎，归写作规则文件）。 */
export function foundationTargetFileFor(
  actionType: FoundationWriteActionType,
  category: FoundationWriteCategory,
): string {
  if (isStyleExemplarActionType(actionType)) return "story/writing-rules.json";
  if (actionType === "delete_foundation_entry") {
    if (category === "locations") return "story/location-bible.json";
    if (category === "assets") return "story/assets.json";
    if (category === "world") return "story/world-bible.json";
    if (category === "writingRules") return "story/writing-rules.json";
    // characters / characterRelationships
    return "story/character-bible.json";
  }
  if (
    actionType === "create_character"
    || actionType === "update_character_detail"
    || actionType === "rename_character"
  ) {
    return "story/character-bible.json";
  }
  if (actionType === "create_location" || actionType === "update_location_detail") return "story/location-bible.json";
  if (actionType === "create_asset" || actionType === "update_asset_status") return "story/assets.json";
  if (actionType === "update_world_rule") return "story/world-bible.json";
  if (actionType === "update_writing_rule") return "story/writing-rules.json";
  return "story/character-bible.json";
}

export interface FoundationWriteToolInput {
  readonly actionType: FoundationWriteActionType;
  readonly category: FoundationWriteCategory;
  readonly targetId?: string;
  readonly targetName?: string;
  readonly before?: unknown;
  /** rename_character 的新名字直达通道（长跑 #3）：after 里没写 name/newName 时归一进 after.name。 */
  readonly newName?: string;
  /** 可省略（zod default {}）：引擎对缺字段按诚实 skip 回报，不硬崩。 */
  readonly after?: Record<string, unknown>;
  /** style_exemplar_* 专属：样本标题/正文/备注（2026-10-12 R3b 并入）。 */
  readonly exemplarTitle?: string;
  readonly exemplarText?: string;
  readonly exemplarNote?: string;
  readonly rationale?: string;
}

export interface FoundationWriteToolOutput {
  readonly ok: boolean;
  readonly applied: boolean;
  readonly needsConfirmation: boolean;
  readonly partialMiss: boolean;
  readonly writes: { action: string; targetFile: string; targetName?: string; summary: string }[];
  readonly skipped: { reason: string; action: string; summary: string }[];
  readonly blocked: { level: string; reason: string; targetFile: string }[];
  readonly overview: unknown;
  readonly summary: string;
  readonly refreshScope?: "foundation";
  /** style_exemplar_* 专属（原 manage_style_exemplars 的结果形状）。 */
  readonly action?: string;
  readonly count?: number;
  readonly exemplars?: ManageStyleExemplarsOutput["exemplars"];
  readonly droppedBad?: string[];
  /** 作者档按钮（needsConfirmation 时才有）：作者点「确认改设定」后原样带回执行。 */
  readonly foundationConfirm?: FoundationConfirmPayload;
}

export interface FoundationConfirmPayload {
  /** 这一份提议的标识：点两次只执行一次。 */
  readonly key: string;
  /** 按钮旁的一句话（动作 + 对象，如「删条目 林溪」）。 */
  readonly label: string;
  /** 被拦下的那次写入，原样带回（服务端执行前再按入参 schema 校验）。 */
  readonly input: Record<string, unknown>;
}

function buildFoundationConfirm(toolInput: FoundationWriteToolInput): FoundationConfirmPayload {
  const key = `fw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return { key, label: foundationWriteSnapshotDetail(toolInput), input: { ...toolInput } as Record<string, unknown> };
}

/** 删角色是作者档：没有作者确认时不删，直接回「确认改设定」按钮（在建快照之前判，不留空存档点）。 */
export async function deleteCharacterAwaitingAuthor(input: {
  readonly projectDir: string;
  readonly toolInput: FoundationWriteToolInput;
  readonly authorConfirmed?: boolean;
}): Promise<FoundationWriteToolOutput | undefined> {
  if (
    input.toolInput.actionType !== "delete_foundation_entry"
    || input.toolInput.category !== "characters"
    || input.authorConfirmed === true
  ) {
    return undefined;
  }
  const overview = await buildStateOverview({ projectDir: input.projectDir, maxTimelineEvents: 8 });
  // 模型无关·绝不泄露裸 id：targetName / targetId 都可能是 char-id——选中的 ref 一律过
  // resolveEntityLabel（命中→名字 / 像内部 char-hash→「未知角色」/ 真名→原样），绝不直接把裸 id 渲进确认摘要。
  const nameById = await readCharacterNameById(input.projectDir);
  const whoRef = input.toolInput.targetName ?? input.toolInput.targetId;
  const who = whoRef ? resolveEntityLabel(whoRef, nameById) : "该角色";
  return {
    ok: false,
    applied: false,
    needsConfirmation: true,
    partialMiss: false,
    writes: [],
    skipped: [],
    blocked: [{
      level: "needs_confirmation",
      reason: `删除角色「${who}」要你确认`,
      targetFile: "story/character-bible.json",
    }],
    overview,
    summary: `删除角色「${who}」要你点「确认改设定」——目前没有删除任何内容（删了也能撤销）。`,
    refreshScope: "foundation",
    foundationConfirm: buildFoundationConfirm(input.toolInput),
  };
}

/** style_exemplar_* 路径：转给 manageStyleExemplarsLogic（纯逻辑，不走引擎网关），结果映射成本工具的诚实回报形状。 */
async function applyStyleExemplarLogic(input: {
  readonly projectDir: string;
  readonly toolInput: FoundationWriteToolInput;
}): Promise<FoundationWriteToolOutput> {
  const action = styleExemplarActionOf(input.toolInput.actionType as StyleExemplarActionType);
  const out = await manageStyleExemplarsLogic({
    projectDir: input.projectDir,
    toolInput: {
      action,
      ...(input.toolInput.targetId ? { id: input.toolInput.targetId } : {}),
      ...(input.toolInput.exemplarTitle ? { title: input.toolInput.exemplarTitle } : {}),
      ...(input.toolInput.exemplarText ? { text: input.toolInput.exemplarText } : {}),
      ...(input.toolInput.exemplarNote ? { note: input.toolInput.exemplarNote } : {}),
    },
  });
  const isList = out.action === "list";
  return {
    ok: out.ok,
    applied: out.ok && !isList,
    needsConfirmation: false,
    partialMiss: false,
    writes: [],
    skipped: [],
    blocked: [],
    overview: undefined,
    summary: out.summary,
    // list 只读：不 refreshScope（不给「影响范围·资料」徽标）、不建快照（走 preflight）。
    ...(isList ? {} : { refreshScope: "foundation" as const }),
    action: out.action,
    count: out.count,
    exemplars: [...out.exemplars],
    droppedBad: [...out.droppedBad],
  };
}

/** 把 agent 的结构化意图组装成引擎建议。抽出以便单测构造逻辑。 */
export function buildFoundationWriteSuggestion(
  input: FoundationWriteToolInput,
  options: { readonly authorConfirmed?: boolean } = {},
): FoundationWriteSuggestionLike {
  const targetFile = foundationTargetFileFor(input.actionType, input.category);
  const confirmedByUser = options.authorConfirmed === true;
  // 长跑 #3（改名入参归一）：顶层 newName 是「新名字」的直达通道——引擎只认 after.name/after.newName，
  // 模型首调用常把新名字放错位（targetName 是旧名定位用）而吃「缺参数」重试。after 已写 name/newName
  // 时以 after 为准（更完整的结构化意图），否则把 newName 归一进 after.name。
  const afterRecord = input.after ?? {};
  const afterWithNewName = input.newName && input.newName.trim() && !afterRecord.name && !afterRecord.newName
    ? { ...afterRecord, name: input.newName }
    : afterRecord;
  return {
    actionType: input.actionType,
    category: input.category,
    targetFile,
    targetPath: "$",
    ...(input.targetId ? { targetId: input.targetId } : {}),
    ...(input.targetName ? { extractedEntityName: input.targetName } : {}),
    ...(input.before !== undefined ? { before: input.before } : {}),
    ...(confirmedByUser ? { confirmedByUser: true } : {}),
    after: afterWithNewName,
  };
}

/**
 * 纯逻辑：落盘 + 诚实回报。抽出为可直接单测的函数（不经 writeTool 快照包装）。
 * needsConfirmation 由引擎 classify 的 blockedWrites[].level === "needs_confirmation" 决定。
 */
export async function applyFoundationWriteToolLogic(input: {
  readonly projectDir: string;
  readonly toolInput: FoundationWriteToolInput;
  /** 作者点了「确认改设定」（只由 foundation-decisions.ts 的按钮通道给 true）；AI 自己调永远是 false。 */
  readonly authorConfirmed?: boolean;
}): Promise<FoundationWriteToolOutput> {
  // 文风样本（style_exemplar_*）：不进引擎网关，转给 manageStyleExemplarsLogic（同是 writing-rules.json 一族，2026-10-12 R3b 并入）。
  if (isStyleExemplarActionType(input.toolInput.actionType)) {
    return applyStyleExemplarLogic({ projectDir: input.projectDir, toolInput: input.toolInput });
  }
  // 删任何角色都要作者确认（用户 2026-06-16 拍板；重构 P4 起是作者档按钮）。地点/资产/世界规则等其它删除
  // 保持「直接做+可撤销」，不增确认负担。
  const awaitingAuthor = await deleteCharacterAwaitingAuthor(input);
  if (awaitingAuthor) return awaitingAuthor;

  // 写前解析更新类操作的目标 id：模型常漏带 targetId（尤其早期补主角人设），书里只有一个该类实体时
  // 兜底落到它，避免「没能找到对应角色」的吓人失败（见 resolveFoundationUpdateTargetId）。
  const resolvedTargetId = resolveFoundationUpdateTargetId({
    actionType: input.toolInput.actionType,
    targetId: input.toolInput.targetId,
    targetName: input.toolInput.targetName,
    knownEntities: buildFoundationKnownEntities(
      await buildStateOverview({ projectDir: input.projectDir, maxTimelineEvents: 8 }),
    ),
  });
  const shouldRewriteTargetId =
    input.toolInput.actionType === "update_character_detail"
    || input.toolInput.actionType === "update_location_detail"
    || input.toolInput.actionType === "update_asset_status";
  const suggestion = buildFoundationWriteSuggestion(
    {
      ...input.toolInput,
      targetId: shouldRewriteTargetId ? resolvedTargetId : input.toolInput.targetId,
    },
    { authorConfirmed: input.authorConfirmed },
  );
  const result: FoundationWriteResult = await applyFoundationWriteSuggestion({
    projectDir: input.projectDir,
    suggestion,
  });

  const overview = await buildStateOverview({ projectDir: input.projectDir, maxTimelineEvents: 8 });

  // 绝不泄露裸 id（铁律④）：引擎回报里只认得 targetId 时会写成「要给「char-ffe5af」改名…」，进给用户看的摘要前换成角色名。
  const nameById = await readCharacterNameById(input.projectDir);
  const named = (text: string): string => nameCharacterIds(text, nameById);
  const writes = result.writes.map((w) => ({
    action: w.action,
    targetFile: w.targetFile,
    ...(w.targetName ? { targetName: named(w.targetName) } : {}),
    summary: named(w.summary),
  }));
  const skipped = (result.skipped ?? []).map((s) => ({
    reason: s.reason,
    action: s.action,
    summary: named(s.summary),
  }));
  const blocked = (result.blockedWrites ?? []).map((b) => ({
    level: b.level,
    reason: named(b.reason),
    targetFile: b.targetFile,
  }));
  const needsConfirmation = blocked.some((b) => b.level === "needs_confirmation");
  // 部分完成（修#1 + Bug2）：写成功了（applied），但有 skip 表示「请求的某项没做成」——
  // ① correction_target_not_found：removeFromArrays/删键目标没命中（旧值没删成、新值已加、两条并存）；
  // ② name_change_requires_rename：把改名混进 update 给已有真名角色，其它字段写了但名字没改。
  // 两者都该显「部分完成」(琥珀)而非绿色全成功，绝不让 agent 据此谎称「改名成功/全部完成」(铁律④)。
  const partialMiss = result.applied === true
    && skipped.some((s) => s.reason === "correction_target_not_found" || s.reason === "name_change_requires_rename");

  const summary = buildFoundationWriteSummary({
    applied: result.applied,
    needsConfirmation,
    writes,
    skipped,
    blocked,
    establishedOverrideApplied: result.applied === true
      && input.toolInput.actionType !== "delete_foundation_entry"
      && input.authorConfirmed === true,
  });

  return {
    // ok=诚实成功：只有真写入了内容才算成。needsConfirmation/目标缺失跳过时 applied=false → ok=false。
    ok: result.applied === true,
    applied: result.applied,
    needsConfirmation,
    partialMiss,
    writes,
    skipped,
    blocked,
    overview,
    summary,
    refreshScope: "foundation",
    ...(needsConfirmation && input.authorConfirmed !== true ? { foundationConfirm: buildFoundationConfirm(input.toolInput) } : {}),
  };
}

export function buildFoundationWriteSummary(args: {
  readonly applied: boolean;
  readonly needsConfirmation: boolean;
  readonly writes: readonly { readonly summary: string }[];
  readonly skipped: readonly { readonly summary: string }[];
  readonly blocked: readonly { readonly level: string; readonly reason: string }[];
  /** 作者点了「确认改设定」、改成了时追加历史章不同步提示（dogfood 问题 6）。 */
  readonly establishedOverrideApplied?: boolean;
}): string {
  const parts: string[] = [];
  if (args.applied && args.writes.length > 0) {
    parts.push(`已写入 ${args.writes.length} 处：${args.writes.map((w) => w.summary).join("；")}`);
  } else {
    parts.push("本次没有写入任何内容");
  }
  if (args.skipped.length > 0) {
    parts.push(`跳过 ${args.skipped.length} 处：${args.skipped.map((s) => s.summary).join("；")}`);
  }
  if (args.needsConfirmation) {
    const reasons = args.blocked.filter((b) => b.level === "needs_confirmation").map((b) => b.reason);
    parts.push(`要你点「确认改设定」才执行（还没写入）：${reasons.join("；")}`);
  }
  const otherBlocked = args.blocked.filter((b) => b.level !== "needs_confirmation");
  if (otherBlocked.length > 0) {
    parts.push(`拦截 ${otherBlocked.length} 处（不安全/目标缺失）：${otherBlocked.map((b) => b.reason).join("；")}`);
  }
  if (args.establishedOverrideApplied) {
    parts.push("已定稿章节不会自动改动（如需同步修改历史章节，请明确告诉我）");
  }
  parts.push("本次操作已建快照，可一键撤销");
  // 各段自带句号时去掉再拼，免得出现「…内容。。本次操作…」。
  return parts.map((part) => part.replace(/[。\s]+$/u, "")).join("。");
}

/** 文本里的角色内部 id（char-xxxx）换成名字；解析不到用中性说法，绝不原样露出。 */
export function nameCharacterIds(text: string, nameById: ReadonlyMap<string, string>): string {
  return text.replace(/\bchar-[0-9a-z]{4,12}\b/giu, (id) => nameById.get(id) ?? "这个角色");
}

// 操作历史快照细节（rerun2 P2：几十条同名「资料写入」不可辨）：动作 + 实体名，让用户能分辨恢复到哪一步。题材中立。
const FOUNDATION_ACTION_SNAPSHOT_VERB: Record<string, string> = {
  create_character: "建角色", rename_character: "角色改名", update_character_detail: "改角色",
  create_location: "建地点", update_location_detail: "改地点",
  create_asset: "建资产", update_asset_status: "改资产",
  update_world_rule: "改世界规则", update_writing_rule: "改写作规则",
  delete_foundation_entry: "删条目",
  style_exemplar_add: "加文风样本", style_exemplar_list: "查文风样本",
  style_exemplar_update: "改文风样本", style_exemplar_remove: "删文风样本",
};
export function foundationWriteSnapshotDetail(input: { readonly actionType?: string; readonly targetName?: string; readonly after?: unknown; readonly exemplarTitle?: string }): string {
  const verb = FOUNDATION_ACTION_SNAPSHOT_VERB[input.actionType ?? ""] ?? "写资料";
  const afterName = (input.after && typeof input.after === "object" && !Array.isArray(input.after))
    ? (input.after as { readonly name?: unknown }).name : undefined;
  const name = (isStyleExemplarActionType(input.actionType ?? "")
    ? input.exemplarTitle ?? ""
    : input.targetName ?? (typeof afterName === "string" ? afterName : undefined) ?? "").trim();
  return name ? `${verb} ${name}` : verb;
}

export const foundationWriteTool = writeTool({
  id: "foundation_write",
  snapshotDetail: foundationWriteSnapshotDetail,
  description:
    "把结构化的资料写入意图落盘：建/改/删/改名 角色、地点、资产、世界规则、写作规则。" +
    "作者文风样本也走这里：用户给满意段落说『照这个感觉写』时 style_exemplar_add 存进（写正文时模仿节奏用词、不照抄内容）；改/删前先 style_exemplar_list。" +
    "更新或删除已有实体前应先用 read_foundation/read_state_overview 取得 targetId。" +
    "落盘前自动建快照，可一键撤销。删角色、覆盖已确立的设定（如改年龄/性别）是作者的决定：你调它不会真改，" +
    "会回 needsConfirmation=true 并给作者出「确认改设定」按钮。这时告诉作者点按钮，别说『已改好』，也别重试。",
  inputSchema,
  outputSchema,
  // style_exemplar_list 只读：走 preflight 直接返回，不建 no-op 快照污染操作历史（原 manage_style_exemplars 同款）。
  // 删角色等作者确认也在这里回（不建空存档点）。
  preflight: async ({ input, projectDir }) => {
    if (input.actionType === "style_exemplar_list") return applyStyleExemplarLogic({ projectDir, toolInput: input });
    return deleteCharacterAwaitingAuthor({ projectDir, toolInput: input });
  },
  run: async ({ input, projectDir }) => {
    const output = await applyFoundationWriteToolLogic({
      projectDir,
      toolInput: {
        actionType: input.actionType,
        category: input.category,
        ...(input.targetId !== undefined ? { targetId: input.targetId } : {}),
        ...(input.targetName !== undefined ? { targetName: input.targetName } : {}),
        ...(input.before !== undefined ? { before: input.before } : {}),
        // 改名的顶层 newName 必须透传：此前 run 里漏了它，模型按说明传 newName 仍报「没有给出新名字」、
        // 只能换 after.name 重试一次（2026-10-07 真 agent 复现，两本新书都撞）。
        ...(input.newName !== undefined ? { newName: input.newName } : {}),
        after: input.after,
        ...(input.exemplarTitle !== undefined ? { exemplarTitle: input.exemplarTitle } : {}),
        ...(input.exemplarText !== undefined ? { exemplarText: input.exemplarText } : {}),
        ...(input.exemplarNote !== undefined ? { exemplarNote: input.exemplarNote } : {}),
        ...(input.rationale !== undefined ? { rationale: input.rationale } : {}),
      },
      // AI 档：永远不带作者确认。作者档的改动走「确认改设定」按钮（foundation-decisions.ts）。
      authorConfirmed: false,
    });
    return output;
    // snapshotId 由 writeTool 强制并入，run 不必回填。
  },
});
