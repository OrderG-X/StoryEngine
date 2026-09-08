export interface StoryProject {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CharacterProfile {
  /** 用户/AI 自定义的额外字段；内置字段之外的"便签"，写作时注入 prompt，不参与引擎逻辑。 */
  readonly extraFields?: Record<string, string | readonly string[]>;
  readonly id: string;
  readonly name: string;
  readonly identity?: string;
  readonly age?: string;
  readonly gender?: string;
  readonly appearance?: {
    readonly body?: string;
    readonly face?: string;
    readonly hair?: string;
    readonly clothing?: string;
    readonly distinguishingFeatures?: readonly string[];
  };
  readonly appearanceAnchors?: readonly string[];
  readonly tags?: readonly string[];
}

export interface CharacterVoiceProfile {
  readonly style?: string;
  readonly rhythm?: string;
  readonly avoidanceTopics?: readonly string[];
  readonly sampleLines?: readonly string[];
}

export interface CharacterArcProfile {
  readonly startState?: string;
  readonly currentState?: string;
  readonly projectedDirection?: string;
}

export interface CharacterCore {
  readonly extraFields?: Record<string, string | readonly string[]>;
  readonly characterId: string;
  readonly personality: readonly string[];
  readonly speechStyle?: string;
  readonly taboos?: readonly string[];
  readonly worldview?: string;
  readonly desire?: string;
  readonly fear?: string;
  readonly contradiction?: string;
  readonly moralBoundary?: string;
  readonly voice?: CharacterVoiceProfile;
  readonly behaviorHabits?: readonly string[];
  readonly arc?: CharacterArcProfile;
}

export interface CharacterState {
  readonly extraFields?: Record<string, string | readonly string[]>;
  readonly characterId: string;
  readonly emotion: string;
  readonly goal: string;
  readonly mood?: string;
  readonly currentGoal?: string;
  readonly recentEvents?: readonly string[];
  readonly relationshipToUser?: string;
  readonly currentArc?: string;
  readonly currentPhysicalState?: string;
  readonly currentMentalState?: string;
  readonly currentResourceState?: string;
  readonly currentLocationId?: string;
  readonly currentLocationName?: string;
  readonly knowledgeKnown?: readonly string[];
  readonly knowledgeUnknown?: readonly string[];
  readonly cannotReveal?: readonly string[];
  readonly lastSeenChapter?: number | null;
  readonly lastUpdatedChapter?: number | null;
}

export interface WorldCore {
  readonly genre: string;
  readonly premise: string;
  readonly rules: readonly string[];
  readonly mainConflict: string;
}

export interface WorldState {
  readonly extraFields?: Record<string, string | readonly string[]>;
  readonly currentPhase: string;
  readonly activeConflicts: readonly string[];
  readonly activeHooks: readonly string[];
  readonly knownSecrets: readonly string[];
  readonly lastUpdatedChapter?: number | null;
}

export interface StoryCore {
  readonly readerPromise: string;
  readonly tone: string;
  readonly targetEmotion: string;
  readonly pacingStyle?: string;
}

export interface StoryBible {
  readonly version: "v0";
  readonly projectLogline: string;
  readonly premise: string;
  readonly genre: string;
  readonly subgenres: readonly string[];
  readonly readerPromise: string;
  readonly longFormGoals: readonly string[];
  readonly centralConflicts: readonly string[];
  readonly coreMysteries: readonly string[];
  readonly forbiddenChanges: readonly string[];
  readonly canonFacts: readonly string[];
  readonly openQuestions: readonly string[];
  readonly setupAssets?: FoundationSetupAssets;
  readonly firstChapterSetup?: FirstChapterSetup;
  readonly protectedSecrets?: readonly string[];
}

export interface FoundationSetupAssets {
  readonly initialAssets: readonly string[];
  readonly keyItems: readonly string[];
  readonly resourceLimits: readonly string[];
}

export interface FirstChapterSetup {
  readonly goal?: string;
  readonly openingScene?: string;
  readonly hook?: string;
  readonly conflict?: string;
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
}

export interface CharacterBibleEntry {
  /** 用户/AI 自定义的额外字段（做厚便签）；写作时渲染进 protagonistContext / supportingCast，不参与引擎逻辑。 */
  readonly extraFields?: Record<string, string | readonly string[]>;
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly age?: string;
  readonly gender?: string;
  readonly identity?: string;
  readonly appearanceAnchors?: readonly string[];
  readonly longTermDesire?: string;
  readonly desire?: string;
  readonly fear?: string;
  readonly weakness?: string;
  readonly contradiction?: string;
  readonly moralBoundary?: string;
  readonly privateMotive?: string;
  readonly relationshipToProtagonist?: string;
  readonly relationshipDynamics?: readonly string[];
  readonly trustLevel?: "low" | "medium" | "high" | string;
  readonly hiddenStance?: string;
  readonly voice?: CharacterVoiceProfile;
  readonly speechRules?: readonly string[];
  readonly speechStyle?: string;
  readonly speechSamples?: readonly string[];
  readonly personalityBaseline?: readonly string[];
  readonly socialEnergy?: "low" | "medium" | "high" | string;
  readonly behaviorBoundaries?: readonly string[];
  readonly knowledgeKnown?: readonly string[];
  readonly knowledgeUnknown?: readonly string[];
  readonly cannotReveal?: readonly string[];
  readonly cannotDo?: readonly string[];
  readonly canAiModify?: boolean;
  readonly arcPromise?: string;
  readonly arc?: CharacterArcProfile;
  readonly currentStateHint?: string;
}

export interface CharacterBible {
  readonly version: "v0";
  readonly characters: readonly CharacterBibleEntry[];
}

export interface CharacterMatrixLedger {
  readonly version: "v0";
  readonly entries: readonly CharacterMatrixEntry[];
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
}

export interface FactLedger {
  readonly version: "v0";
  readonly facts: readonly FactEntry[];
}

export interface CharacterMatrixAppearance {
  readonly chapter: number;
  readonly evidence: string;
  readonly location?: string;
}

export interface CharacterMatrixRelationshipEvent {
  readonly chapter: number;
  readonly relationToProtagonist?: string;
  readonly evidence: string;
}

export interface CharacterMatrixEntry {
  readonly id: string;
  readonly name: string;
  readonly status: "candidate" | "accepted" | "ignored" | "promoted";
  readonly roleHint?: string;
  readonly relationToProtagonist?: string;
  readonly riskHint?: string;
  readonly firstSeenChapter?: number;
  readonly lastSeenChapter?: number;
  readonly promotedCharacterId?: string;
  readonly evidence: readonly string[];
  readonly appearances: readonly CharacterMatrixAppearance[];
  readonly relationshipEvents: readonly CharacterMatrixRelationshipEvent[];
}

export interface WorldBibleFaction {
  readonly id: string;
  readonly name: string;
  readonly goal: string;
  readonly resources?: readonly string[];
}

export interface WorldBible {
  readonly version: "v0";
  readonly rules: readonly string[];
  readonly factions: readonly WorldBibleFaction[];
  readonly powerOrSurvivalSystems: readonly string[];
  readonly historyFacts: readonly string[];
  readonly socialOrder: readonly string[];
  readonly worldPremise?: string;
  readonly resourceRules?: readonly string[];
  readonly authorityRules?: readonly string[];
  readonly conflictSources?: readonly string[];
  readonly fixedFacts?: readonly string[];
  readonly protectedSecrets?: readonly string[];
  readonly publicFacts?: readonly string[];
  readonly hiddenFacts?: readonly string[];
  readonly forbiddenRuleBreaks?: readonly string[];
}

export interface LocationSensoryDetails {
  readonly visual?: readonly string[];
  readonly sound?: readonly string[];
  readonly smell?: readonly string[];
  readonly touch?: readonly string[];
}

export interface LocationBibleEntry {
  readonly extraFields?: Record<string, string | readonly string[]>;
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly parentId?: string;
  readonly parentLocation?: string;
  readonly locationType?: string;
  readonly spatialStructure?: LocationSpatialStructure;
  readonly sensoryDetails?: LocationSensoryDetails;
  readonly currentKnownPosition?: string;
  readonly knownFeatures: readonly string[];
  readonly risks: readonly string[];
  readonly resources: readonly string[];
  readonly narrativeFunction?: string;
  readonly possibleConflicts?: readonly string[];
  readonly currentStatus?: string;
  readonly hiddenFacts?: readonly string[];
  readonly connectedLocations?: readonly string[];
  readonly travelRules?: readonly LocationTravelRule[];
  readonly secrets?: readonly string[];
  readonly fixedFacts?: readonly string[];
  readonly lastSeenChapter?: number;
  readonly lastKnownState?: string;
}

export interface LocationBible {
  readonly version: "v0";
  readonly locations: readonly LocationBibleEntry[];
}

export interface LocationSpatialStructure {
  readonly floors?: readonly string[];
  readonly rooms?: readonly string[];
  readonly entrances?: readonly string[];
  readonly exits?: readonly string[];
}

export interface LocationTravelRule {
  readonly from?: string;
  readonly targetLocation: string;
  readonly method: "walk" | "taxi" | "bus" | "elevator" | "stairs" | string;
  readonly durationMinutes?: number;
  readonly constraint?: string;
}

export interface AssetLedger {
  readonly version: "v0";
  readonly assets: readonly AssetItem[];
  readonly containers: readonly AssetContainer[];
}

export interface AssetItem {
  readonly extraFields?: Record<string, string | readonly string[]>;
  readonly id: string;
  readonly name: string;
  readonly type: "item" | "vehicle" | "property" | "money" | "document" | "container" | "keyItem" | "consumable" | string;
  readonly ownerCharacterId?: string;
  readonly ownerName?: string;
  readonly currentLocationId?: string;
  readonly currentLocationName?: string;
  readonly carriedByCharacterId?: string;
  readonly containerId?: string;
  readonly quantity?: number;
  readonly status: "available" | "damaged" | "lost" | "locked" | "consumed" | "unknown" | string;
  readonly conditionNote?: string;
  readonly isConsumable?: boolean;
  readonly isPlotCritical?: boolean;
  readonly canAiModify?: boolean;
  readonly firstSeenChapter?: number;
  readonly lastSeenChapter?: number;
  readonly rules?: readonly string[];
  readonly usageRules?: readonly string[];
  readonly lossRules?: readonly string[];
  readonly blockedReason?: string;
  readonly notes?: readonly string[];
}

export interface AssetContainer {
  readonly id: string;
  readonly name: string;
  readonly ownerCharacterId?: string;
  readonly locationId?: string;
  readonly containsAssetIds: readonly string[];
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
