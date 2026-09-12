import type { ModelInfoItem } from "../api/types.js";
import type { ProviderPreset } from "../constants/providerPresets.js";

// 7 个任务类型（按难度成组：写作类建议关思考、动脑类建议开）。删死槽 futureReview、补主对话 triage、做厚拆 enrichment。
export const TASK_LABELS: Record<string, string> = {
  fastDraft: "正文生成",
  triage: "主对话",
  repair: "局部改稿",
  chapterSteering: "章节方案",
  enrichment: "资料补全",
  draftReview: "内容审阅",
  qualityCheck: "硬伤检查",
};

export const TASK_HINTS: Record<string, string> = {
  fastDraft: "写正文，要会写作的模型",
  triage: "右侧对话总控，驱动所有工具",
  repair: "按建议局部修订正文",
  chapterSteering: "分析上下文、生成章节方案",
  enrichment: "世界观/角色/地点/道具与资源等资料补全",
  draftReview: "深度分析整章并给出改进建议",
  qualityCheck: "定稿前查硬伤/连续性",
};

/**
 * 每个任务的「思考」软建议（2026-06-23 调研修正）：创作类(正文/改稿)建议关——思考把创作"理性化"反而更AI腔、更慢；
 * 动脑类(章节方案/做厚/审稿/质检)建议开——规划/一致性/评判靠推理加分；
 * **主对话(triage)建议开**——它是 agent 编排器(意图→选对工具→规划多步)，不是闲聊，思考帮它少调错工具少幻觉
 * （证据：agentic 研究里强 agent 一律走 Deliberative Mode 先想再动手）。仅提示，用户随意调。
 */
export const TASK_SUGGEST_THINKING: Record<string, boolean> = {
  fastDraft: false,
  triage: true,
  repair: false,
  chapterSteering: true,
  enrichment: true,
  draftReview: true,
  qualityCheck: true,
};

export interface SavedProvider {
  readonly id: string;
  readonly label: string;
  readonly baseUrl: string;
  readonly apiKeyEnv: string;
  readonly apiKeyStatus: "present" | "missing" | "not_required";
}

export interface FlatModelItem {
  readonly providerId: string;
  readonly providerLabel: string;
  readonly model: ModelInfoItem;
}

export interface GroupedModelItems {
  readonly provider: SavedProvider;
  readonly items: readonly FlatModelItem[];
}

export interface ProviderFormProps {
  readonly editingProviderId: string | null;
  /** 隐藏预设选择区（从服务商卡片进入详情时：供应商已确定，无需再选预设）。 */
  readonly hidePresetPicker?: boolean;
  /** 极简模式（官方预设）：只显示 API Key + 测试连接，名称/接口地址收进高级选项折叠。 */
  readonly minimal?: boolean;
  /** 隐藏表单自带标题栏（整页详情已有页头时避免双标题+双关闭）。 */
  readonly hideHeader?: boolean;
  readonly formPresetId: string;
  readonly formName: string;
  readonly formBaseUrl: string;
  readonly formAuthEnv: string;
  readonly formApiKey: string;
  readonly showApiKey: boolean;
  readonly selectedPreset: ProviderPreset | null;
  readonly testing: boolean;
  readonly testModels: readonly ModelInfoItem[];
  readonly testError: string | null;
  readonly testElapsed: number | null;
  readonly setFormName: (value: string) => void;
  readonly setFormBaseUrl: (value: string) => void;
  readonly setFormAuthEnv: (value: string) => void;
  readonly setFormApiKey: (value: string) => void;
  readonly setShowApiKey: (updater: (value: boolean) => boolean) => void;
  readonly onSelectPreset: (preset: ProviderPreset) => void;
  readonly onTestConnection: () => void;
  readonly onCancel: () => void;
  readonly onSaveProvider: () => void;
  readonly onModelQuickAssign: (modelId: string) => void;
}

export interface ProviderListProps {
  readonly savedProviders: readonly SavedProvider[];
  readonly providerModels: Record<string, readonly ModelInfoItem[]>;
  readonly providerErrors: Record<string, string>;
  readonly expandedProviderId: string | null;
  readonly showProviderForm: boolean;
  readonly onAddProvider: () => void;
  readonly onToggleProvider: (providerId: string | null) => void;
  readonly onEditProvider: (provider: SavedProvider) => void;
  readonly onRefreshProvider: (provider: SavedProvider) => void;
  readonly onDeleteProvider: (providerId: string) => void;
  readonly onAssignAll: (providerId: string, modelId: string) => void;
}

export interface TaskAssignmentSectionProps {
  readonly tasks: Record<string, string>;
  readonly thinking: Record<string, boolean>;
  readonly savedProviders: readonly SavedProvider[];
  readonly onEditTask: (taskKey: string) => void;
  readonly onToggleThinking: (taskKey: string) => void;
}

export interface ModelPickerOverlayProps {
  readonly editingTask: string;
  readonly pickerApplyAll: boolean;
  readonly pickerSearch: string;
  readonly allModelsFlat: readonly FlatModelItem[];
  readonly groupedFilteredModels: readonly GroupedModelItems[];
  readonly tasks: Record<string, string>;
  readonly setPickerApplyAll: (value: boolean) => void;
  readonly setPickerSearch: (value: string) => void;
  readonly onClose: () => void;
  readonly onAssignAll: (providerId: string, modelId: string) => void;
  readonly onAssignTask: (taskKey: string, providerId: string, modelId: string) => void;
}
