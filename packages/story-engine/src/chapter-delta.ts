/**
 * ChapterDelta —— 章节语义「模型声明 + 证据校验」的契约类型与确定性校验器。
 *
 * 设计见 docs/superpowers/specs/2026-07-02-chapter-delta-declaration-design.md。
 *
 * 背景：过去引擎从正文用正则/枚举词表「猜」本章语义（mainEvent/伏笔/资源/线索），题材补丁跨题材必崩。
 * 新方向：让写手模型主动【声明】本章语义，每条附正文原句证据；引擎退出「猜」，只做一件**确定性、题材中立**的事——
 * 核对声明引用的原句是否真出现在本章草稿里。核不上就拒绝采纳该条（绝不静默），上层据此逐字段回退到旧正则。
 *
 * 本文件是**纯确定性、无 LLM 依赖**（LLM 调用留在 UI server 层）。它只定义数据形状 + 校验，
 * 已被 commit-plan-builder.ts 消费：传入章节语义声明时由 verifyChapterDelta 做证据校验，核不上的条目进 issues（绝不静默），
 * 上层据此逐字段回退到旧正则——这是刻意的兼容设计，声明能力不可用时旧链路行为不变。
 */

/** 一条声明必带的正文证据：模型引用的原句，校验时必须逐字（归一化空白后）命中草稿。 */
export interface ChapterDeltaEvidence {
  /** 模型引用的正文原句。 */
  readonly quote: string;
}

/** 伏笔声明（埋下 seeded / 回收 resolved 共用）。 */
export interface ForeshadowingDeclaration extends ChapterDeltaEvidence {
  /** 这条伏笔是什么（人可读，用于标题/展示）。 */
  readonly summary: string;
  /** 回收时可选：指向哪条**已存在**线索（其标题或锚点），用于归到同一条、避免线索分裂。 */
  readonly targetThreadHint?: string;
}

/** 资源变化方向。 */
export type ResourceChangeKind = "gain" | "loss" | "spend";

/** 资源变化声明。程序只透传+校验，绝不做单位换算或数量推断。 */
export interface ResourceDeltaDeclaration extends ChapterDeltaEvidence {
  /** 资源名（补气丹 / 贡献点 …）。 */
  readonly item: string;
  readonly change: ResourceChangeKind;
  /** 原文数量字符串（"十二枚"）；可选。校验时要求它出现在 evidence 里。 */
  readonly amount?: string;
}

/** 带摘要的证据（mainEvent / 关键线索）。 */
export interface SummarizedEvidence extends ChapterDeltaEvidence {
  readonly summary: string;
}

/** 本章留下的未完成待办/下一步意图。 */
export interface PendingIntentDeclaration extends ChapterDeltaEvidence {
  readonly summary: string;
}

/**
 * 主线/阶段目标推进声明：模型报「本章对哪个目标做了什么」，附正文原句证据。
 * 引擎据此驱动 arc-goal 追踪（题材中立），替代旧的题材关键词表（那套换题材必空转）。
 */
export interface ArcGoalProgressDeclaration extends ChapterDeltaEvidence {
  /** 目标是什么（人可读；新确立时用作标题，推进/完成时用于匹配已有目标）。 */
  readonly summary: string;
  /** 本章对该目标做了什么：introduced=新确立，advanced=推进，completed=达成。 */
  readonly progress: "introduced" | "advanced" | "completed";
  /** 目标层级（新确立时生效）：main_arc=贯穿全书的主线，mini_arc=近几章的阶段目标。缺省按 mini_arc。 */
  readonly scope?: "main_arc" | "mini_arc";
  /** 推进/完成时可选：指向哪条已存在目标（其标题），用于对号入座、避免目标分裂。 */
  readonly targetGoalHint?: string;
}

/**
 * 人物名册声明：模型报「本章出现了哪个角色、正文里用的是什么名字」，附一句含该名字的原文证据。
 * 引擎据此得到一份**干净的本章用名清单**，再和已确立角色名做确定性形近比对（治名字漂移），
 * 而不用去正文里瞎猜哪些词是人名（那会把「林家」「林间」误判成人名）。
 */
export interface CharacterPresenceDeclaration extends ChapterDeltaEvidence {
  /** 本章正文里对该角色使用的名字。 */
  readonly name: string;
  /** 可选：指向一个已确立身份（角色 id / 关系锚点如「主角的妹妹」），用于把「同一个人」跨章对齐。 */
  readonly identityHint?: string;
}

/**
 * 本章开头与上一章结尾的主观衔接判断。
 * 这是模型基于「上一章结尾摘录 + 本章正文」做的整体判断，不附正文 quote，也不参与证据校验。
 */
export interface ContinuityWithPreviousDeclaration {
  /** true=自然承接；false=疑似断裂/跳切过硬，需要提醒用户确认。 */
  readonly connects: boolean;
  readonly note?: string;
}

/** 模型对本章的完整语义声明。 */
export interface ChapterDeltaDeclaration {
  readonly chapter: number;
  readonly mainEvent: SummarizedEvidence;
  /** 本章的核心冲突/对立（可选）。summary=冲突是什么，quote=体现冲突的正文原句。缺省回退正则。 */
  readonly conflict?: SummarizedEvidence;
  /** 本章主角【查明/发现/得知】的关键信息（可选）。summary=发现了什么，quote=写到该发现的正文原句。缺省回退正则。 */
  readonly discovery?: SummarizedEvidence;
  /** 本章主角做出的关键决定/选择（可选）。summary=决定做什么，quote=写到该决定的正文原句。缺省回退正则。 */
  readonly decision?: SummarizedEvidence;
  readonly seededForeshadowing: readonly ForeshadowingDeclaration[];
  readonly resolvedForeshadowing: readonly ForeshadowingDeclaration[];
  readonly resourceDeltas: readonly ResourceDeltaDeclaration[];
  readonly keyLeads: readonly SummarizedEvidence[];
  /** 本章留下的未完成待办/下一步意图（可选；缺省视为空）。 */
  readonly pendingIntents?: readonly PendingIntentDeclaration[];
  /** 本章出现的角色名册（可选；缺省视为未声明，名字漂移校验自动跳过）。 */
  readonly charactersPresent?: readonly CharacterPresenceDeclaration[];
  /** 主线/阶段目标推进（可选；缺省视为未声明，arc-goal 追踪回退旧关键词路径）。 */
  readonly arcGoalProgress?: readonly ArcGoalProgressDeclaration[];
  /** 本章开头与上一章结尾是否自然衔接（可选；不附 quote，不参与证据校验，只用于提醒）。 */
  readonly continuityWithPrevious?: ContinuityWithPreviousDeclaration;
}

/** 被拒绝的声明条目（诚实回报，绝不静默丢弃）。 */
export interface RejectedDeltaEntry {
  /** 字段定位，如 "mainEvent" / "seededForeshadowing[0]" / "resourceDeltas[1]"。 */
  readonly field: string;
  /** 被拒的证据原句。 */
  readonly quote: string;
  readonly reason: DeltaRejectReason;
}

export type DeltaRejectReason =
  | "empty_quote" // 证据为空
  | "evidence_not_in_draft" // 证据原句不在草稿里
  | "amount_not_in_evidence" // 声明了数量，但数量字符串不在证据句里；剥掉 amount、保留资源得失条目
  | "name_not_in_evidence"; // 声明了角色名，但名字不在证据句里

/**
 * 校验后的声明：只保留证据核实通过的条目；被拒条目集中在 rejected（供诊断/降级判断）。
 * 每类字段都是「原声明的子集」，上层可逐字段决定用声明值还是回退正则。
 */
export interface VerifiedChapterDelta {
  readonly chapter: number;
  readonly mainEvent?: SummarizedEvidence;
  /** 校验通过的核心冲突声明（证据句在草稿里）。 */
  readonly conflict?: SummarizedEvidence;
  /** 校验通过的关键发现声明。 */
  readonly discovery?: SummarizedEvidence;
  /** 校验通过的关键决定声明。 */
  readonly decision?: SummarizedEvidence;
  readonly seededForeshadowing: readonly ForeshadowingDeclaration[];
  readonly resolvedForeshadowing: readonly ForeshadowingDeclaration[];
  readonly resourceDeltas: readonly ResourceDeltaDeclaration[];
  readonly keyLeads: readonly SummarizedEvidence[];
  /** 校验通过的未完成待办/下一步意图。 */
  readonly pendingIntents: readonly PendingIntentDeclaration[];
  /** 校验通过的人物名册（名字逐字出现在证据句、且证据句在草稿里）。 */
  readonly charactersPresent: readonly CharacterPresenceDeclaration[];
  /** 校验通过的主线/阶段目标推进声明。 */
  readonly arcGoalProgress: readonly ArcGoalProgressDeclaration[];
  /** 原样透传的跨章衔接判断；不参与证据校验。 */
  readonly continuityWithPrevious?: ContinuityWithPreviousDeclaration;
  readonly rejected: readonly RejectedDeltaEntry[];
  /** 是否有任何一条声明通过校验（全拒 → 上层整体回退正则）。 */
  readonly hasAnyVerified: boolean;
}

/** 归一化：压掉所有空白（空格/换行/制表符/全角空格），便于「原句是否出现在草稿」的宽松逐字比对。 */
function normalizeForMatch(text: string): string {
  return text.replace(/[\s\u3000]+/gu, "");
}

/** 证据原句是否（归一化空白后）逐字出现在草稿里。空证据 → 视为不命中。 */
export function evidenceAppearsInDraft(quote: string, normalizedDraft: string): boolean {
  const normalizedQuote = normalizeForMatch(quote ?? "");
  if (normalizedQuote.length === 0) return false;
  return normalizedDraft.includes(normalizedQuote);
}

/**
 * 确定性、题材中立的证据校验：逐条核对声明引用的原句是否真在草稿里出现，通过的留下、失败的进 rejected。
 * 不做任何语义推断、不换算数量、不依赖题材词表。
 */
export function verifyChapterDelta(
  declaration: ChapterDeltaDeclaration,
  draft: string,
): VerifiedChapterDelta {
  const normalizedDraft = normalizeForMatch(draft ?? "");
  const rejected: RejectedDeltaEntry[] = [];

  const checkEvidence = (quote: string, field: string): boolean => {
    if (normalizeForMatch(quote ?? "").length === 0) {
      rejected.push({ field, quote: quote ?? "", reason: "empty_quote" });
      return false;
    }
    if (!evidenceAppearsInDraft(quote, normalizedDraft)) {
      rejected.push({ field, quote, reason: "evidence_not_in_draft" });
      return false;
    }
    return true;
  };

  const mainEvent = checkEvidence(declaration.mainEvent?.quote ?? "", "mainEvent")
    ? declaration.mainEvent
    : undefined;

  // 可选语义标量（conflict/discovery/decision）：只在声明了才校验；缺省不记 rejected（区别于必填的 mainEvent）。
  const conflict = declaration.conflict && checkEvidence(declaration.conflict.quote, "conflict")
    ? declaration.conflict
    : undefined;
  const discovery = declaration.discovery && checkEvidence(declaration.discovery.quote, "discovery")
    ? declaration.discovery
    : undefined;
  const decision = declaration.decision && checkEvidence(declaration.decision.quote, "decision")
    ? declaration.decision
    : undefined;

  const seededForeshadowing = (declaration.seededForeshadowing ?? []).filter((entry, index) =>
    checkEvidence(entry.quote, `seededForeshadowing[${index}]`),
  );

  const resolvedForeshadowing = (declaration.resolvedForeshadowing ?? []).filter((entry, index) =>
    checkEvidence(entry.quote, `resolvedForeshadowing[${index}]`),
  );

  const keyLeads = (declaration.keyLeads ?? []).filter((entry, index) =>
    checkEvidence(entry.quote, `keyLeads[${index}]`),
  );

  const pendingIntents = (declaration.pendingIntents ?? []).filter((entry, index) =>
    checkEvidence(entry.quote, `pendingIntents[${index}]`),
  );

  const resourceDeltas = (declaration.resourceDeltas ?? []).flatMap((entry, index) => {
    const field = `resourceDeltas[${index}]`;
    if (!checkEvidence(entry.quote, field)) return [];
    // 数量只校验、不换算：若声明了 amount，要求它逐字出现在证据句里（防止「1 瓶→12 枚」这类凭空漂移）。
    if (entry.amount && entry.amount.trim().length > 0) {
      const amountInEvidence = normalizeForMatch(entry.quote).includes(normalizeForMatch(entry.amount));
      if (!amountInEvidence) {
        rejected.push({ field, quote: entry.quote, reason: "amount_not_in_evidence" });
        const { amount: _amount, ...entryWithoutAmount } = entry;
        return [entryWithoutAmount];
      }
    }
    return [entry];
  });

  const charactersPresent = (declaration.charactersPresent ?? []).filter((entry, index) => {
    const field = `charactersPresent[${index}]`;
    if (!checkEvidence(entry.quote, field)) return false;
    // 名字必须逐字出现在证据句里，杜绝「声明了名字但证据句根本没这个名字」的空报。
    const nameInEvidence = normalizeForMatch(entry.quote).includes(normalizeForMatch(entry.name ?? ""));
    if (!nameInEvidence) {
      rejected.push({ field, quote: entry.quote, reason: "name_not_in_evidence" });
      return false;
    }
    return true;
  });

  const arcGoalProgress = (declaration.arcGoalProgress ?? []).filter((entry, index) =>
    checkEvidence(entry.quote, `arcGoalProgress[${index}]`),
  );

  const hasAnyVerified =
    mainEvent !== undefined ||
    conflict !== undefined ||
    discovery !== undefined ||
    decision !== undefined ||
    seededForeshadowing.length > 0 ||
    resolvedForeshadowing.length > 0 ||
    resourceDeltas.length > 0 ||
    keyLeads.length > 0 ||
    pendingIntents.length > 0 ||
    charactersPresent.length > 0 ||
    arcGoalProgress.length > 0;

  return {
    chapter: declaration.chapter,
    ...(mainEvent ? { mainEvent } : {}),
    ...(conflict ? { conflict } : {}),
    ...(discovery ? { discovery } : {}),
    ...(decision ? { decision } : {}),
    seededForeshadowing,
    resolvedForeshadowing,
    resourceDeltas,
    keyLeads,
    pendingIntents,
    charactersPresent,
    arcGoalProgress,
    ...(declaration.continuityWithPrevious ? { continuityWithPrevious: declaration.continuityWithPrevious } : {}),
    rejected,
    hasAnyVerified,
  };
}
