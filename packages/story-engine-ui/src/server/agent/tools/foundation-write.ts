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
 * - 需用户确认的删除（如已晋升 / 已出场角色）：按引擎 classify 的 needs_confirmation 如实回报
 *   「需用户确认」，绝不强写；用户确认后由 agent 再带 confirmed=true 重试。
 * - 题材中立：description / 字段说明用中性词，不注入任何题材。
 */
import {
  applyFoundationWriteSuggestion,
  buildStateOverview,
  type FoundationWriteResult,
  type FoundationWriteSuggestionLike,
} from "@actalk/story-engine";
import { z } from "zod";
import { coerceBoolean, coerceEnum, coerceEnumValues, coerceJsonObject } from "./lenient-args.js";

import { writeTool } from "../withSnapshot.js";
import { readCharacterNameById, resolveEntityLabel } from "../presence/entity-labels.js";
import { resolveFoundationUpdateTargetId } from "../../lib/project-io.js";
import { buildFoundationKnownEntities } from "../../routes/foundation-gaps.js";
import { readUserTurnTextFromContext } from "../request-context.js";
import { userTurnAllowsEstablishedOverride } from "./turn-intent-gate.js";

/** 支持的资料写入动作。覆盖 foundation-write-gateway 的全部建/改/删/改名动作。 */
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
] as const;
export type FoundationWriteActionType = (typeof FOUNDATION_WRITE_ACTION_TYPES)[number];

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

const inputSchema = z.object({
  // 模型无关：枚举大小写宽容。actionType 全小写 snake → coerceEnum；category 含 camelCase
  // （characterRelationships/writingRules）→ coerceEnumValues 大小写不敏感映射回 canonical。这是唯一写资料工具，
  // 模型一旦传错大小写就 InputValidationError 写不进，宽容很值。
  actionType: coerceEnum(z.enum(FOUNDATION_WRITE_ACTION_TYPES).describe(
    "记进已有角色卡=update_character_detail；新建=create_*；改名=rename_character；删除=delete_foundation_entry（配 category）。",
  )),
  category: coerceEnumValues(FOUNDATION_WRITE_CATEGORIES, z.enum(FOUNDATION_WRITE_CATEGORIES).describe(
    "写或删哪一类资料（characterRelationships=角色关系条目）。",
  )),
  targetId: z.string().optional().describe(
    "目标实体 id（更新/改名/删除已有角色·地点·资产时必填，先用 read_foundation/read_state_overview 取得）。新建留空。",
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
  confirmed: coerceBoolean(z.boolean().optional().describe(
    "删除角色、覆盖已确立设定：工具先回『需用户确认』，用户明确同意后带 true 重试（工具还会核对用户原话）。",
  )),
  rationale: z.string().optional().describe("为什么写这条（一句话，便于结果卡说明）。"),
});

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
  refreshScope: z.literal("foundation"),
});

/** 由 actionType + category 推导引擎期望的 targetFile（与 foundation-write-gateway 的校验一致）。 */
export function foundationTargetFileFor(
  actionType: FoundationWriteActionType,
  category: FoundationWriteCategory,
): string {
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
  readonly confirmed?: boolean;
  readonly rationale?: string;
}

/**
 * 是否把本次写入视为「用户已确认覆盖」交给引擎。
 * - 删角色：认工具参数 confirmed（agent 问过后带 true 重试），与既有行为一致。
 * - 其它写入（尤其 age/gender 冲突）：只认本轮用户原话里的明确同意语，不接受 agent 自说 confirmed。
 */
export function resolveFoundationWriteConfirmedByUser(input: {
  readonly actionType: FoundationWriteActionType;
  readonly confirmed?: boolean;
  readonly userTurnText?: string;
}): boolean {
  if (input.actionType === "delete_foundation_entry") {
    return input.confirmed === true;
  }
  return userTurnAllowsEstablishedOverride(input.userTurnText);
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
  readonly refreshScope: "foundation";
}

/** 把 agent 的结构化意图组装成引擎建议。抽出以便单测构造逻辑。 */
export function buildFoundationWriteSuggestion(
  input: FoundationWriteToolInput,
  options: { readonly userTurnText?: string } = {},
): FoundationWriteSuggestionLike {
  const targetFile = foundationTargetFileFor(input.actionType, input.category);
  const confirmedByUser = resolveFoundationWriteConfirmedByUser({
    actionType: input.actionType,
    confirmed: input.confirmed,
    userTurnText: options.userTurnText,
  });
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
  /** 本轮用户原话（由 RequestContext 注入）；覆盖已确立设定时只认这里的明确同意。 */
  readonly userTurnText?: string;
}): Promise<FoundationWriteToolOutput> {
  // 删任何角色都先确认（用户 2026-06-16 拍板）：引擎只对「已 commit 的晋升/已出场角色」强制确认，
  // 这里把保护扩到所有角色——删角色未带 confirmed 时不调引擎删除，统一回报 needsConfirmation，
  // 由 agent 在对话里问用户、确认后带 confirmed=true 重试。整角色删除较重，先问一句更稳（删后仍可撤销）。
  // 仅拦角色删除：地点/资产/世界规则等其它删除保持「直接做+可撤销」，不增确认负担。
  if (
    input.toolInput.actionType === "delete_foundation_entry"
    && input.toolInput.category === "characters"
    && input.toolInput.confirmed !== true
  ) {
    const overview = await buildStateOverview({ projectDir: input.projectDir, maxTimelineEvents: 8 });
    // 模型无关·绝不泄露裸 id：模型只给 targetId（char-xxxx）时把它解析成角色名；解析不到回落「该角色」，
    // 绝不在确认摘要里显「删除角色「char-3f2a」」。
    const nameById = await readCharacterNameById(input.projectDir);
    // 模型无关·绝不泄露裸 id：targetName 槽位也可能被模型错塞 char-id（不只 targetId）——选中的 ref 一律过
    // resolveEntityLabel（命中→名字 / 像内部 char-hash→「未知角色」/ 真名→原样），绝不直接把裸 id 渲进确认摘要。
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
        reason: `删除角色「${who}」前需用户确认`,
        targetFile: "story/character-bible.json",
      }],
      overview,
      summary: `删除角色「${who}」需要你先确认——目前没有删除任何内容。确认要删，我再执行（删除后也可一键撤销）。`,
      refreshScope: "foundation",
    };
  }

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
    { userTurnText: input.userTurnText },
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
      && resolveFoundationWriteConfirmedByUser({
        actionType: input.toolInput.actionType,
        confirmed: input.toolInput.confirmed,
        userTurnText: input.userTurnText,
      }),
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
  };
}

export function buildFoundationWriteSummary(args: {
  readonly applied: boolean;
  readonly needsConfirmation: boolean;
  readonly writes: readonly { readonly summary: string }[];
  readonly skipped: readonly { readonly summary: string }[];
  readonly blocked: readonly { readonly level: string; readonly reason: string }[];
  /** 用户明确同意后覆盖已确立设定成功时追加历史章不同步提示（dogfood 问题 6）。 */
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
    parts.push(`需用户确认后才能执行（未写入）：${reasons.join("；")}`);
    const isEstablishedOverride = reasons.some((reason) => /已确立|长期设定|明确覆盖/u.test(reason));
    if (isEstablishedOverride) {
      parts.push(
        "放行条件：请用户在下一轮明确说「允许覆盖」或「确定／同意」后，再调一次 foundation_write；" +
          "勿无限重试。若用户改口放弃，如实告诉用户这次没改成、设定未变",
      );
    }
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
};
export function foundationWriteSnapshotDetail(input: { readonly actionType?: string; readonly targetName?: string; readonly after?: unknown }): string {
  const verb = FOUNDATION_ACTION_SNAPSHOT_VERB[input.actionType ?? ""] ?? "写资料";
  const afterName = (input.after && typeof input.after === "object" && !Array.isArray(input.after))
    ? (input.after as { readonly name?: unknown }).name : undefined;
  const name = (input.targetName ?? (typeof afterName === "string" ? afterName : undefined) ?? "").trim();
  return name ? `${verb} ${name}` : verb;
}

export const foundationWriteTool = writeTool({
  id: "foundation_write",
  snapshotDetail: foundationWriteSnapshotDetail,
  description:
    "把结构化的资料写入意图落盘：建/改/删/改名 角色、地点、资产、世界规则、写作规则。" +
    "更新或删除已有实体前应先用 read_foundation/read_state_overview 取得 targetId。" +
    "落盘前自动建快照，可一键撤销。【删除任何角色都需用户确认】：首次删角色会回报『需用户确认』、不删除，" +
    "此时不要谎称已删除，应在对话里问用户确认，确认后再带 confirmed=true 重试。" +
    "【覆盖已确立长期设定（如改年龄/性别）】：首次会被拦并回报需确认；请用户下一轮说「允许覆盖」或「确定」，" +
    "再调一次即可（系统核对用户原话，勿只靠自填 confirmed）。被拦后勿无限重试；改不成须如实告诉用户没改成与原因。",
  inputSchema,
  outputSchema,
  run: async ({ input, projectDir, context }) => {
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
        ...(input.confirmed !== undefined ? { confirmed: input.confirmed } : {}),
        ...(input.rationale !== undefined ? { rationale: input.rationale } : {}),
      },
      userTurnText: readUserTurnTextFromContext(context),
    });
    return output;
    // snapshotId 由 writeTool 强制并入，run 不必回填。
  },
});
