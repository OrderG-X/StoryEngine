export interface StoryProject {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}












/** 作者文风样本（正向锚）：喂模型模仿句法节奏/用词偏好/叙事温度，不得照抄内容、情节或具体名物。 */
export interface StyleExemplar {
  readonly id: string;
  readonly title: string;
  readonly text: string;
  readonly note?: string;
  readonly createdAtMs: number;
}

export interface WritingRules {
  readonly version: "v0";
  readonly narrativePerspective?: string;
  readonly proseStyle: readonly string[];
  readonly chapterLength?: {
    readonly minWords?: number;
    readonly targetWords?: number;
    readonly maxWords?: number;
  };
  readonly pacing?: string;
  readonly revealPolicy?: string;
  readonly genreRequirements: readonly string[];
  readonly suspenseRules: readonly string[];
  readonly payoffRules: readonly string[];
  readonly reversalRules: readonly string[];
  readonly readerExperienceRules: readonly string[];
  readonly forbiddenContent: readonly string[];
  readonly doNotDo: readonly string[];
  readonly antiAiPatterns?: readonly string[];
  /** 用户自定义的全局写作规矩（自由 Markdown，短、每次必喂模型）。受控破例⑧。 */
  readonly customNotes?: string;
  /** 作者文风样本（正向锚，每次写正文必喂）；最多 5 条、单条 text ≤2000 字（限额由 style-exemplars.ts 归一/管理工具把关）。 */
  readonly styleExemplars?: readonly StyleExemplar[];
}




export interface FactEntry {
  readonly id: string;
  readonly chapter: number;
  readonly text: string;
  readonly source: "auto" | "manual" | string;
  /** 有效区间（章为单位，纯机械判定、题材中立）。缺省=从来源章起、永不失效（向后兼容旧账本）。 */
  readonly effectiveFromChapter?: number;
  /** 从第几章起失效（被取代）。缺省/undefined=仍有效。 */
  readonly supersededByChapter?: number;
  /** 被哪条事实取代（登记合法演进链，可选）。 */
  readonly supersededByFactId?: string;
  /** 出处：本章里写到这件事的原句（2026-10-10 账本 v2；老账本没有）。 */
  readonly quote?: string;
  /** 结构化三元组（可选）：谁 / 哪方面 / 是什么，供确定性比对（同一主体同一属性值不同 = 对不上）。 */
  readonly subject?: string;
  readonly attribute?: string;
  readonly value?: string;
  /** hard = 不该变的（年龄、门牌、写着的字）；state = 会变的状态（在哪、在谁手里）；event = 发生过的事。 */
  readonly kind?: "hard" | "state" | "event";
}

export interface FactLedger {
  readonly version: "v0";
  readonly facts: readonly FactEntry[];
}














export interface HookItem {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly status: "seeded" | "active" | "inactive" | "resolved" | "abandoned";
  readonly relatedCharacters: readonly string[];
  readonly firstSeenChapter?: number;
  readonly lastTouchedChapter?: number;
  readonly evidence?: readonly string[];
  readonly nextActionHint?: string;
  readonly relatedLocations?: readonly string[];
  readonly activationKeywords?: readonly string[];
  readonly relatedCharacterIds?: readonly string[];
  readonly effectiveFromChapter?: number;
  readonly supersededByChapter?: number;
  /** B4: 该 hook 在第几章被回收（resolved）。单调：定死在第一次回收那章，后续提及不覆盖。供伏笔线索面板显示「第N章埋→第M章回收」。 */
  readonly resolvedAtChapter?: number;
}

export interface HookPool {
  readonly hooks: readonly HookItem[];
}

export interface NarrativeThread {
  readonly id: string;
  readonly type: "lead" | "intent";
  readonly title: string;
  readonly status: "open" | "touched" | "done" | "stale";
  readonly firstSeenChapter: number;
  readonly lastTouchedChapter: number;
  readonly evidence: readonly string[];
  /** 作者定的轻重（只写不是「一般」的）：大伏笔要到后面才揭，久不提也不当过期线索。 */
  readonly weight?: "major" | "minor";
  readonly nextActionHint?: string;
  readonly relatedCharacters?: readonly string[];
  readonly relatedLocations?: readonly string[];
  readonly activationKeywords?: readonly string[];
  readonly relatedCharacterIds?: readonly string[];
  readonly effectiveFromChapter?: number;
  readonly supersededByChapter?: number;
}

export interface ThreadPool {
  readonly threads: readonly NarrativeThread[];
}

export interface ArcGoal {
  readonly id: string;
  readonly title: string;
  readonly status: "active" | "touched" | "completed" | "stale";
  readonly scope: "chapter" | "mini_arc" | "main_arc";
  readonly firstSeenChapter: number;
  readonly lastTouchedChapter: number;
  readonly targetChapters?: number;
  readonly evidence: readonly string[];
  readonly relatedHooks?: readonly string[];
  readonly relatedThreads?: readonly string[];
  readonly relatedCharacters?: readonly string[];
  readonly relatedLocations?: readonly string[];
  readonly nextActionHint?: string;
}

export interface ArcGoalPool {
  readonly goals: readonly ArcGoal[];
}

export interface TimelineEvent {
  readonly id: string;
  readonly chapter: number;
  /** 这章的账还没记上：梗概、出场、线索都给不出（summary 是如实说给不出的那句，不是「什么都没发生」）。 */
  readonly ledgerPending?: true;
  readonly summary: string;
  readonly participants: readonly string[];
  readonly effects?: Record<string, unknown>;
  readonly activationKeywords?: readonly string[];
  readonly relatedCharacterIds?: readonly string[];
  readonly effectiveFromChapter?: number;
  readonly supersededByChapter?: number;
}

export interface StoryCalendar {
  readonly currentStoryDay: number;
  readonly currentTimeOfDay: "morning" | "noon" | "afternoon" | "evening" | "night" | "late_night" | "unknown";
}

export interface ModelSettingsV0 {
  readonly version: 1;
  readonly defaultProvider?: string;
  readonly defaultProfile?: string;
  readonly providers: Record<string, ProviderConfig>;
  readonly profiles: Record<string, ModelProfile>;
  readonly taskProfiles: TaskProfileMap;
}

export interface ProviderConfig {
  readonly id: string;
  readonly label?: string;
  readonly type: "openai-compatible" | "openai" | "local" | "custom";
  readonly baseUrl: string;
  readonly apiKeyEnv?: string;
  /**
   * 每-provider 自定义请求头（如备胎 relay 需要的 x-opencode-session）。
   * 值视同机密：summary/API 输出只回键名（customHeaderNames），绝不回值。
   */
  readonly customHeaders?: Record<string, string>;
  /**
   * 额度组（写作版本 P2a）：同一套餐的不同密钥、不同入口填成同一组，限流闸的在途计数挂在组上。
   * 非秘密；不填 = 接口地址的 origin。
   */
  readonly quotaGroup?: string;
}

export interface ModelProfile {
  readonly id: string;
  readonly label?: string;
  readonly provider: string;
  readonly model: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly timeoutMs?: number;
  readonly retries?: number;
  readonly stream?: boolean;
}

export interface TaskProfileMap {
  readonly fastDraft?: string;
  readonly chapterSteering?: string;
  readonly qualityCheck?: string;
  readonly repair?: string;
  readonly futureReview?: string;
  readonly draftReview?: string;
  readonly triage?: string;
}

export type ModelSettingsStatus = "missing" | "loaded" | "invalid_json" | "invalid_schema";

export type ModelSettingsIssueSeverity = "info" | "warning" | "error" | "high";

export interface ModelSettingsValidationIssue {
  readonly severity: ModelSettingsIssueSeverity;
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export interface ProviderConfigSummary {
  readonly id: string;
  readonly label?: string;
  readonly type: ProviderConfig["type"];
  readonly baseUrl: string;
  readonly apiKeyEnv?: string;
  readonly apiKeyStatus: "not_required" | "present" | "missing";
  /** 自定义请求头的键名列表（脱敏：只出 key 名，绝不出值——值视同机密）。 */
  readonly customHeaderNames?: readonly string[];
  readonly quotaGroup?: string;
}

export interface ModelProfileSummary {
  readonly id: string;
  readonly label?: string;
  readonly provider: string;
  readonly model: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly timeoutMs?: number;
  readonly retries?: number;
  readonly stream?: boolean;
}

export interface ModelSettingsSummary {
  readonly available: boolean;
  readonly status: ModelSettingsStatus;
  readonly configPath: string;
  readonly defaultProvider?: string;
  readonly defaultProfile?: string;
  readonly providers: readonly ProviderConfigSummary[];
  readonly profiles: readonly ModelProfileSummary[];
  readonly taskProfiles: TaskProfileMap;
  readonly issueCount: number;
  readonly highRiskIssueCount: number;
}

export interface ModelSettingsLoadResult {
  readonly passed: boolean;
  readonly available: boolean;
  readonly status: ModelSettingsStatus;
  readonly configPath: string;
  readonly summary: ModelSettingsSummary;
  readonly issues: readonly ModelSettingsValidationIssue[];
}

