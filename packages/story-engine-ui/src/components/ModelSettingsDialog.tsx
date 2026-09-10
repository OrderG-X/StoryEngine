import { useCallback, useEffect, useReducer, useRef, useState, useMemo } from "react";
import { testModelConnection, fetchModelSettings, saveModelSettings } from "../api/client.js";
import type { ModelInfoItem, ModelSettingsLoadResult } from "../api/types.js";
import { PROVIDER_PRESETS, type ProviderPreset } from "../constants/providerPresets.js";
import type { WizardServicePreset } from "../constants/wizardPresets.js";
import type { ModelSettingsDialogProps } from "../types.js";
import { AiSetupWizard } from "./AiSetupWizard.js";
import { AiSimpleView } from "./AiSimpleView.js";
import { ChatMemoryBudgetSection } from "./ChatMemoryBudgetSection.js";
import { DisplaySettingsSection } from "./DisplaySettingsSection.js";
import { ModelPickerOverlay } from "./ModelPickerOverlay.js";
import {
  buildModelSettingsConfig,
  buildTaskAssignmentsPayload,
  buildWizardRecommendedState,
  formatHumanTestError,
  parseChatHistoryBudgetTokens,
  parseModelSettings,
  parseTaskViewState,
  pickRecommendedModelId,
} from "./ModelSettingsDialogLogic.js";
import { TASK_LABELS, type FlatModelItem, type GroupedModelItems, type SavedProvider } from "./ModelSettingsDialogTypes.js";
import { ProviderForm } from "./ProviderForm.js";
import { ProviderList } from "./ProviderList.js";
import { TaskAssignmentSection } from "./TaskAssignmentSection.js";
import "./ModelSettingsDialog.css";

const DEFAULT_CHAT_MEMORY = 96_000;

function formatProviderRefreshError(providerLabel: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/401|authentication|api key|invalid/i.test(message)) {
    return `${providerLabel} 鉴权失败：API Key 无效或已过期。请编辑该 AI 服务的认证变量/密钥后再刷新。`;
  }
  if (/404|not found/i.test(message)) {
    return `${providerLabel} 模型列表接口不可用。请检查接口地址是否需要 /v1。`;
  }
  const cleaned = message.replace(/\s+/g, " ").trim();
  return `${providerLabel} 模型列表刷新失败：${cleaned.slice(0, 180)}${cleaned.length > 180 ? "..." : ""}`;
}

interface PickerState {
  readonly editingTask: string | null;
  readonly applyAll: boolean;
  readonly search: string;
}

const CLOSED_PICKER_STATE: PickerState = {
  editingTask: null,
  applyAll: false,
  search: "",
};

interface ProviderFormState {
  readonly presetId: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly authEnv: string;
  readonly apiKey: string;
  readonly showApiKey: boolean;
}

const EMPTY_PROVIDER_FORM: ProviderFormState = {
  presetId: "",
  name: "",
  baseUrl: "",
  authEnv: "",
  apiKey: "",
  showApiKey: false,
};

type ProviderFormAction =
  | { readonly type: "reset" }
  | { readonly type: "selectPreset"; readonly preset: ProviderPreset }
  | { readonly type: "editProvider"; readonly provider: SavedProvider; readonly presetId: string }
  | { readonly type: "setField"; readonly field: "presetId" | "name" | "baseUrl" | "authEnv" | "apiKey"; readonly value: string }
  | { readonly type: "setShowApiKey"; readonly value: boolean };

function providerFormReducer(state: ProviderFormState, action: ProviderFormAction): ProviderFormState {
  switch (action.type) {
    case "reset":
      return EMPTY_PROVIDER_FORM;
    case "selectPreset":
      return {
        ...state,
        presetId: action.preset.id,
        name: action.preset.label,
        baseUrl: action.preset.baseUrl,
        authEnv: action.preset.apiKeyEnvSuggestion || "",
        apiKey: "",
      };
    case "editProvider":
      return {
        presetId: action.presetId,
        name: action.provider.label,
        baseUrl: action.provider.baseUrl,
        authEnv: action.provider.apiKeyEnv,
        apiKey: "",
        showApiKey: false,
      };
    case "setField":
      return { ...state, [action.field]: action.value };
    case "setShowApiKey":
      return { ...state, showApiKey: action.value };
  }
}

interface ConnectionTestState {
  readonly testing: boolean;
  readonly models: readonly ModelInfoItem[];
  readonly error: string | null;
  readonly elapsed: number | null;
}

const EMPTY_CONNECTION_TEST: ConnectionTestState = {
  testing: false,
  models: [],
  error: null,
  elapsed: null,
};

type ConnectionTestAction =
  | { readonly type: "reset" }
  | { readonly type: "start" }
  | { readonly type: "success"; readonly models: readonly ModelInfoItem[]; readonly elapsed: number | null }
  | { readonly type: "error"; readonly error: string };

function connectionTestReducer(state: ConnectionTestState, action: ConnectionTestAction): ConnectionTestState {
  switch (action.type) {
    case "reset":
      return EMPTY_CONNECTION_TEST;
    case "start":
      return { testing: true, models: [], error: null, elapsed: null };
    case "success":
      return { testing: false, models: action.models, error: null, elapsed: action.elapsed };
    case "error":
      return { testing: false, models: [], error: action.error, elapsed: null };
  }
}

type SettingsSurface = "wizard" | "simple" | "advanced";

export default function ModelSettingsDialog({ open, onCancel, embedded }: ModelSettingsDialogProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saveWarnings, setSaveWarnings] = useState<readonly string[]>([]);
  const [, setLoadResult] = useState<ModelSettingsLoadResult | null>(null);
  const [rawText, setRawText] = useState("");
  const [rawTextDraft, setRawTextDraft] = useState("");
  const [rawJsonOpen, setRawJsonOpen] = useState(false);
  const [rawJsonDirty, setRawJsonDirty] = useState(false);

  const [savedProviders, setSavedProviders] = useState<readonly SavedProvider[]>([]);
  const [providerModels, setProviderModels] = useState<Record<string, readonly ModelInfoItem[]>>({});
  const [providerErrors, setProviderErrors] = useState<Record<string, string>>({});
  const [pendingProviderApiKeys, setPendingProviderApiKeys] = useState<Record<string, string>>({});
  const [tasks, setTasks] = useState<Record<string, string>>({});
  const [thinking, setThinking] = useState<Record<string, boolean>>({});
  const [chatMemoryBudget, setChatMemoryBudget] = useState(DEFAULT_CHAT_MEMORY);

  const [showProviderForm, setShowProviderForm] = useState(false);
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null);
  const [providerForm, dispatchProviderForm] = useReducer(providerFormReducer, EMPTY_PROVIDER_FORM);
  const [connectionTest, dispatchConnectionTest] = useReducer(connectionTestReducer, EMPTY_CONNECTION_TEST);
  const [syncingModels, setSyncingModels] = useState(false);
  const [forceAdvanced, setForceAdvanced] = useState(embedded);
  const [wizardBusy, setWizardBusy] = useState(false);
  const [wizardError, setWizardError] = useState<string | null>(null);
  const [simpleTesting, setSimpleTesting] = useState(false);
  const [simpleTestError, setSimpleTestError] = useState<string | null>(null);
  const [simpleTestNotice, setSimpleTestNotice] = useState<string | null>(null);

  const [pickerState, setPickerState] = useState<PickerState>(CLOSED_PICKER_STATE);
  const [expandedProviderId, setExpandedProviderId] = useState<string | null>(null);
  const prevOpenRef = useRef(false);

  const selectedPreset = useMemo(
    () => PROVIDER_PRESETS.find((p) => p.id === providerForm.presetId) ?? null,
    [providerForm.presetId],
  );

  const surface: SettingsSurface = useMemo(() => {
    if (forceAdvanced) return "advanced";
    if (savedProviders.length === 0) return "wizard";
    return "simple";
  }, [forceAdvanced, savedProviders.length]);

  const primaryProvider = savedProviders[0] ?? null;

  const closeModelPicker = useCallback(() => {
    setPickerState(CLOSED_PICKER_STATE);
  }, []);

  const openModelPicker = useCallback((taskKey: string) => {
    setPickerState({ editingTask: taskKey, applyAll: false, search: "" });
  }, []);

  const resetForm = useCallback(() => {
    dispatchProviderForm({ type: "reset" });
    dispatchConnectionTest({ type: "reset" });
  }, []);

  const syncProviderModels = useCallback(async (
    providers: readonly SavedProvider[],
    isCancelled: () => boolean = () => false,
  ) => {
    if (providers.length === 0) return;
    setSyncingModels(true);
    await Promise.all(
      providers.map(async (p) => {
        if (isCancelled()) return;
        const preset = PROVIDER_PRESETS.find((pr) => pr.id === p.id);
        try {
          const r = await testModelConnection({
            providerId: p.id,
            baseUrl: p.baseUrl || preset?.baseUrl || "",
            apiKeyEnv: p.apiKeyEnv || preset?.apiKeyEnvSuggestion || undefined,
          });
          if (!isCancelled()) {
            setProviderModels((prev) => ({ ...prev, [p.id]: r.models }));
          }
        } catch {
          // Individual failure is ok; user can refresh manually.
        }
      }),
    );
    if (!isCancelled()) setSyncingModels(false);
  }, []);

  // 弹窗打开时锁定 body 滚动：避免「页面 body 滚动 + 弹窗内滚动」双滚动，
  // 否则 backdrop-filter 全屏模糊层逐帧重绘 → macOS 上滚动闪烁。
  // 整页（embedded）模式无 backdrop，不需要锁。
  useEffect(() => {
    if (!open || embedded) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [open, embedded]);

  useEffect(() => {
    if (!open) {
      prevOpenRef.current = false;
      return;
    }
    // embedded（整页）模式：open 恒为 true，StrictMode 双挂载下不能用 prevOpenRef 跳过，
    // 否则 remount 时加载被跳过、loading 永远停在 true。整页每次挂载都应重新拉取配置。
    if (!embedded && prevOpenRef.current) return;
    prevOpenRef.current = true;

    let cancelled = false;
    setLoading(true);
    setError(null);
    setNotice(null);
    setSaveWarnings([]);
    setWizardError(null);
    setSimpleTestError(null);
    setSimpleTestNotice(null);
    if (!embedded) setForceAdvanced(false);
    setShowProviderForm(false);
    setEditingProviderId(null);
    setRawJsonOpen(false);
    setRawJsonDirty(false);
    closeModelPicker();
    setExpandedProviderId(null);
    setProviderErrors({});
    setPendingProviderApiKeys({});
    resetForm();

    fetchModelSettings()
      .then((r) => {
        if (cancelled) return;
        try {
          setLoadResult(r.result ?? null);
          setRawText(r.rawText ?? "");
          setRawTextDraft(r.rawText ?? "");
          const parsed = parseModelSettings(r.result);
          setSavedProviders(parsed.providers);
          setProviderModels(parsed.providerModels);
          const viewState = parseTaskViewState(r.taskAssignments, r.result?.summary?.profiles ?? []);
          setTasks(Object.keys(viewState.tasks).length > 0 ? viewState.tasks : parsed.tasks);
          setThinking(viewState.thinking);
          setChatMemoryBudget(parseChatHistoryBudgetTokens(r.rawText) ?? DEFAULT_CHAT_MEMORY);
          void syncProviderModels(parsed.providers, () => cancelled);
        } catch (innerErr) {
          if (!cancelled) {
            setError(`解析配置失败：${innerErr instanceof Error ? innerErr.message : String(innerErr)}`);
          }
        }
      })
      .catch((e) => {
        if (!cancelled) setError(`读取失败：${e instanceof Error ? e.message : String(e)}`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, embedded, resetForm, syncProviderModels, closeModelPicker]);

  const selectPresetForForm = useCallback((preset: ProviderPreset) => {
    dispatchProviderForm({ type: "selectPreset", preset });
    dispatchConnectionTest({ type: "reset" });
  }, []);

  const doTestConnection = useCallback(async () => {
    const baseUrl = providerForm.baseUrl.trim();
    if (!baseUrl) return;
    dispatchConnectionTest({ type: "start" });
    try {
      const r = await testModelConnection({
        providerId: providerForm.presetId || "custom",
        baseUrl,
        apiKeyEnv: providerForm.authEnv || undefined,
        apiKey: providerForm.apiKey || undefined,
      });
      dispatchConnectionTest({ type: "success", models: r.models, elapsed: r.elapsedMs ?? null });
      setProviderModels((prev) => ({ ...prev, [providerForm.presetId || "custom"]: r.models }));
    } catch (e) {
      dispatchConnectionTest({ type: "error", error: formatHumanTestError(e) });
    }
  }, [providerForm]);

  const openAddForm = () => {
    resetForm();
    setEditingProviderId(null);
    setShowProviderForm(true);
    closeModelPicker();
  };

  const openEditForm = (provider: SavedProvider) => {
    const preset = PROVIDER_PRESETS.find((p) => p.id === provider.id);
    dispatchProviderForm({ type: "editProvider", provider, presetId: preset ? preset.id : "" });
    dispatchConnectionTest({ type: "success", models: providerModels[provider.id] ?? [], elapsed: null });
    setEditingProviderId(provider.id);
    setShowProviderForm(true);
    closeModelPicker();
  };

  const handleSaveProvider = useCallback(() => {
    const name = providerForm.name.trim();
    const baseUrl = providerForm.baseUrl.trim();
    if (!name || !baseUrl) return;
    const id = editingProviderId || (providerForm.presetId || name.toLowerCase().replace(/[^\w]/g, "-"));
    setSavedProviders((prev) => {
      const previousStatus = editingProviderId
        ? (prev.find((p) => p.id === editingProviderId)?.apiKeyStatus ?? "missing")
        : "missing";
      const newProv: SavedProvider = {
        id,
        label: name,
        baseUrl,
        apiKeyEnv: providerForm.authEnv,
        apiKeyStatus: providerForm.apiKey ? "present" : previousStatus,
      };
      const exists = prev.some((p) => p.id === id);
      if (exists) return prev.map((p) => (p.id === id ? newProv : p));
      return [...prev, newProv];
    });
    if (connectionTest.models.length > 0) {
      setProviderModels((prev) => ({ ...prev, [id]: [...connectionTest.models] }));
    }
    if (providerForm.apiKey.trim()) {
      setPendingProviderApiKeys((prev) => ({ ...prev, [id]: providerForm.apiKey.trim() }));
    }
    setShowProviderForm(false);
    setEditingProviderId(null);
    resetForm();
  }, [editingProviderId, providerForm, connectionTest.models, resetForm]);

  const handleDeleteProvider = (id: string) => {
    setSavedProviders((prev) => prev.filter((p) => p.id !== id));
    setProviderModels((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setProviderErrors((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setPendingProviderApiKeys((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setTasks((prev) => {
      const next: Record<string, string> = {};
      for (const [k, v] of Object.entries(prev)) {
        const [pid] = v.split("|");
        if (pid !== id) next[k] = v;
      }
      return next;
    });
  };

  const handleRefreshProviderModels = async (provider: SavedProvider) => {
    const preset = PROVIDER_PRESETS.find((p) => p.id === provider.id);
    setError(null);
    setProviderErrors((prev) => {
      const next = { ...prev };
      delete next[provider.id];
      return next;
    });
    try {
      const r = await testModelConnection({
        providerId: provider.id,
        baseUrl: provider.baseUrl || preset?.baseUrl || "",
        apiKeyEnv: provider.apiKeyEnv || preset?.apiKeyEnvSuggestion || undefined,
        apiKey: pendingProviderApiKeys[provider.id],
      });
      setProviderModels((prev) => ({ ...prev, [provider.id]: r.models }));
    } catch (e) {
      setProviderErrors((prev) => ({
        ...prev,
        [provider.id]: formatProviderRefreshError(provider.label, e),
      }));
    }
  };

  const assignAll = (providerId: string, modelId: string) => {
    const next: Record<string, string> = {};
    for (const key of Object.keys(TASK_LABELS)) next[key] = `${providerId}|${modelId}`;
    setTasks(next);
    closeModelPicker();
  };

  const assignTask = (taskKey: string, providerId: string, modelId: string) => {
    setTasks((prev) => ({ ...prev, [taskKey]: `${providerId}|${modelId}` }));
    closeModelPicker();
  };

  const toggleThinking = (taskKey: string) => {
    setThinking((prev) => ({ ...prev, [taskKey]: !(prev[taskKey] ?? true) }));
  };

  const applySavedResult = useCallback((
    res: Awaited<ReturnType<typeof saveModelSettings>>,
  ) => {
    setLoadResult(res.result);
    setRawText(res.rawText);
    setRawTextDraft(res.rawText);
    setRawJsonDirty(false);
    const parsed = parseModelSettings(res.result);
    setSavedProviders(parsed.providers);
    setProviderModels(parsed.providerModels);
    if (res.taskAssignments) {
      const vs = parseTaskViewState(res.taskAssignments, res.result?.summary?.profiles ?? []);
      if (Object.keys(vs.tasks).length > 0) setTasks(vs.tasks);
      setThinking(vs.thinking);
    }
    setChatMemoryBudget(parseChatHistoryBudgetTokens(res.rawText) ?? chatMemoryBudget);
    setPendingProviderApiKeys({});
    setSaveWarnings(res.warnings ?? []);
  }, [chatMemoryBudget]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setNotice(null);
    setSaveWarnings([]);
    try {
      let payloadText: string;
      if (rawJsonDirty) {
        payloadText = rawTextDraft;
      } else {
        const config = buildModelSettingsConfig(savedProviders, tasks, {
          chatHistoryBudgetTokens: chatMemoryBudget,
          previousRawText: rawText,
        });
        payloadText = JSON.stringify(config, null, 2);
      }
      const taskAssignments = buildTaskAssignmentsPayload(tasks, thinking);
      const res = await saveModelSettings(payloadText, pendingProviderApiKeys, taskAssignments);
      applySavedResult(res);
      setNotice("已保存并校验通过。");
      setForceAdvanced(false);
    } catch (e) {
      setError(`保存失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const handleWizardTestAndStart = async (input: {
    readonly preset: WizardServicePreset;
    readonly apiKey: string;
    readonly baseUrl: string;
  }) => {
    setWizardBusy(true);
    setWizardError(null);
    setError(null);
    try {
      const test = await testModelConnection({
        providerId: input.preset.id,
        baseUrl: input.baseUrl,
        apiKey: input.apiKey,
        apiKeyEnv: input.preset.apiKeyEnv || undefined,
      });
      const modelId = pickRecommendedModelId(test.models, input.preset.recommendedModel);
      if (!modelId) {
        setWizardError("连通成功，但服务未返回可用模型。请换服务或到高级设置手动配置。");
        return;
      }
      const recommended = buildWizardRecommendedState(input.preset, input.baseUrl, modelId);
      const config = buildModelSettingsConfig(recommended.providers, recommended.tasks, {
        chatHistoryBudgetTokens: chatMemoryBudget,
        previousRawText: rawText,
      });
      const taskAssignments = buildTaskAssignmentsPayload(recommended.tasks, recommended.thinking);
      const providerId = recommended.providers[0]?.id ?? input.preset.id;
      const res = await saveModelSettings(
        JSON.stringify(config, null, 2),
        { [providerId]: input.apiKey },
        taskAssignments,
      );
      applySavedResult(res);
      setTasks(recommended.tasks);
      setThinking(recommended.thinking);
      setProviderModels((prev) => ({ ...prev, [providerId]: test.models }));
      setNotice("已连通并写入推荐配置，可以开始写作。");
      setForceAdvanced(false);
    } catch (e) {
      setWizardError(formatHumanTestError(e));
    } finally {
      setWizardBusy(false);
    }
  };

  const handleSimpleRetest = async () => {
    if (!primaryProvider) return;
    setSimpleTesting(true);
    setSimpleTestError(null);
    setSimpleTestNotice(null);
    try {
      const r = await testModelConnection({
        providerId: primaryProvider.id,
        baseUrl: primaryProvider.baseUrl,
        apiKeyEnv: primaryProvider.apiKeyEnv || undefined,
        apiKey: pendingProviderApiKeys[primaryProvider.id],
      });
      setProviderModels((prev) => ({ ...prev, [primaryProvider.id]: r.models }));
      setSimpleTestNotice(`连通正常，可用模型 ${r.models.length} 个。`);
    } catch (e) {
      setSimpleTestError(formatHumanTestError(e));
    } finally {
      setSimpleTesting(false);
    }
  };

  const handleChangeKey = () => {
    if (!primaryProvider) return;
    setForceAdvanced(true);
    openEditForm(primaryProvider);
  };

  const hasChanges = Object.values(tasks).some(Boolean) || savedProviders.length > 0 || rawJsonDirty;

  const allModelsFlat = useMemo(() => {
    const out: FlatModelItem[] = [];
    for (const prov of savedProviders) {
      const models = providerModels[prov.id] ?? [];
      for (const m of models) {
        out.push({ providerId: prov.id, providerLabel: prov.label, model: m });
      }
    }
    return out;
  }, [savedProviders, providerModels]);

  const filteredModels = useMemo(() => {
    const q = pickerState.search.trim().toLowerCase();
    if (!q) return allModelsFlat;
    return allModelsFlat.filter(
      (item) =>
        item.model.id.toLowerCase().includes(q) ||
        (item.model.name ?? "").toLowerCase().includes(q) ||
        item.providerLabel.toLowerCase().includes(q),
    );
  }, [allModelsFlat, pickerState.search]);

  const groupedFilteredModels = useMemo(() => {
    const map: Record<string, typeof filteredModels> = {};
    for (const item of filteredModels) {
      if (!map[item.providerId]) map[item.providerId] = [];
      map[item.providerId].push(item);
    }
    const result: GroupedModelItems[] = [];
    for (const prov of savedProviders) {
      if (map[prov.id]) result.push({ provider: prov, items: map[prov.id] });
    }
    return result;
  }, [filteredModels, savedProviders]);

  if (!open) return null;

  const subtitle =
    surface === "wizard"
      ? "还没接 AI？按三步选服务、填密钥、测通即可开始。"
      : surface === "simple"
        ? "日常只需确认当前服务；进阶选项收在「高级设置」。"
        : "高级选项：AI 服务、任务分配、深度分析、记忆上限与原始 JSON。";


  function renderBody() {
    return (
      <>
          {!embedded && <DisplaySettingsSection />}

          {error && <div className="ms-error">{error}</div>}
          {notice && <div className="ms-notice">{notice}</div>}
          {saveWarnings.length > 0 && (
            <div className="ms-notice ms-warn-notice">
              {saveWarnings.map((warning) => (
                <div key={warning}>{warning}</div>
              ))}
            </div>
          )}
          {loading && <div className="ms-loading">正在加载配置...</div>}
          {syncingModels && surface === "advanced" && (
            <div className="ms-notice ms-sync-notice">
              <span className="ms-spinner ms-spinner-sm" />
              正在同步各 AI 服务的可用模型列表...
            </div>
          )}

          {!loading && surface === "wizard" && (
            <>
              <div className="ms-group-heading">
                <h3>AI 设置</h3>
                <p>配置写作所用的 AI 服务。完成后即可在右侧对话里写作。</p>
              </div>
              <AiSetupWizard
                busy={wizardBusy}
                error={wizardError}
                onTestAndStart={(input) => { void handleWizardTestAndStart(input); }}
              />
              <button
                type="button"
                className="ms-advanced-entry ms-advanced-entry-quiet"
                onClick={() => setForceAdvanced(true)}
              >
                高级设置
                <span className="ms-advanced-entry-hint">手动添加服务 / 任务分配 / JSON</span>
              </button>
            </>
          )}

          {!loading && surface === "simple" && primaryProvider && (
            <>
              <div className="ms-group-heading">
                <h3>AI 设置</h3>
                <p>当前写作所用的 AI 服务。</p>
              </div>
              <AiSimpleView
                provider={primaryProvider}
                testing={simpleTesting}
                testError={simpleTestError}
                testNotice={simpleTestNotice}
                onChangeKey={handleChangeKey}
                onRetest={() => { void handleSimpleRetest(); }}
                onOpenAdvanced={() => setForceAdvanced(true)}
              />
            </>
          )}

          {!loading && surface === "advanced" && (
            <>
              <div className="ms-advanced-toolbar">
                {!embedded && (
                  <button
                    type="button"
                    className="ms-btn ms-btn-ghost ms-btn-xs"
                    onClick={() => {
                      setForceAdvanced(false);
                      setShowProviderForm(false);
                      setEditingProviderId(null);
                      resetForm();
                    }}
                  >
                    ← 返回
                  </button>
                )}
                {!embedded && <span className="ms-advanced-toolbar-label">高级设置</span>}
              </div>

              {!embedded && (
                <div className="ms-group-heading">
                  <h3>AI 设置</h3>
                  <p>配置写作所用的 AI 服务与各功能使用的模型。</p>
                </div>
              )}

              <section className="ms-section">
                <ProviderList
                  savedProviders={savedProviders}
                  providerModels={providerModels}
                  providerErrors={providerErrors}
                  expandedProviderId={expandedProviderId}
                  showProviderForm={showProviderForm}
                  onAddProvider={openAddForm}
                  onToggleProvider={setExpandedProviderId}
                  onEditProvider={openEditForm}
                  onRefreshProvider={(provider) => { void handleRefreshProviderModels(provider); }}
                  onDeleteProvider={handleDeleteProvider}
                  onAssignAll={assignAll}
                />

                {showProviderForm && (
                  <ProviderForm
                    editingProviderId={editingProviderId}
                    formPresetId={providerForm.presetId}
                    formName={providerForm.name}
                    formBaseUrl={providerForm.baseUrl}
                    formAuthEnv={providerForm.authEnv}
                    formApiKey={providerForm.apiKey}
                    showApiKey={providerForm.showApiKey}
                    selectedPreset={selectedPreset}
                    testing={connectionTest.testing}
                    testModels={connectionTest.models}
                    testError={connectionTest.error}
                    testElapsed={connectionTest.elapsed}
                    setFormName={(value) => dispatchProviderForm({ type: "setField", field: "name", value })}
                    setFormBaseUrl={(value) => dispatchProviderForm({ type: "setField", field: "baseUrl", value })}
                    setFormAuthEnv={(value) => dispatchProviderForm({ type: "setField", field: "authEnv", value })}
                    setFormApiKey={(value) => dispatchProviderForm({ type: "setField", field: "apiKey", value })}
                    setShowApiKey={(updater) => dispatchProviderForm({
                      type: "setShowApiKey",
                      value: updater(providerForm.showApiKey),
                    })}
                    onSelectPreset={selectPresetForForm}
                    onTestConnection={doTestConnection}
                    onCancel={() => { setShowProviderForm(false); setEditingProviderId(null); }}
                    onSaveProvider={handleSaveProvider}
                    onModelQuickAssign={(modelId) => {
                      const id = editingProviderId || (providerForm.presetId || providerForm.name.toLowerCase().replace(/[^\w]/g, "-"));
                      handleSaveProvider();
                      assignAll(id, modelId);
                    }}
                  />
                )}
              </section>

              {savedProviders.length > 0 && !showProviderForm && (
                <TaskAssignmentSection
                  tasks={tasks}
                  thinking={thinking}
                  savedProviders={savedProviders}
                  onEditTask={openModelPicker}
                  onToggleThinking={toggleThinking}
                />
              )}

              <ChatMemoryBudgetSection
                value={chatMemoryBudget}
                onChange={setChatMemoryBudget}
              />

              <section className="ms-section ms-raw-json-section">
                <button
                  type="button"
                  className="ms-raw-json-toggle"
                  aria-expanded={rawJsonOpen}
                  onClick={() => setRawJsonOpen((v) => !v)}
                >
                  原始 JSON 编辑
                  <span className="ms-section-hint">{rawJsonDirty ? "已修改，保存时将以此为准" : "高级用户 / 排障"}</span>
                </button>
                {rawJsonOpen && (
                  <textarea
                    className="ms-raw-json"
                    value={rawTextDraft}
                    spellCheck={false}
                    aria-label="model-settings.json 原文"
                    onChange={(e) => {
                      setRawTextDraft(e.target.value);
                      setRawJsonDirty(e.target.value !== rawText);
                    }}
                  />
                )}
              </section>
            </>
          )}

      </>
    );
  }

  const footer = (
    <footer className="ms-footer">
      <button className="ms-btn ms-btn-ghost" onClick={onCancel} type="button">
        {surface === "wizard" ? "关闭" : "取消"}
      </button>
      {surface === "advanced" && (
        <button
          className="ms-btn ms-btn-primary"
          disabled={loading || saving || !hasChanges}
          onClick={() => { void handleSave(); }}
          type="button"
        >
          {saving ? "保存中..." : "保存设置"}
        </button>
      )}
    </footer>
  );

  const picker = pickerState.editingTask && (
    <ModelPickerOverlay
      editingTask={pickerState.editingTask}
      pickerApplyAll={pickerState.applyAll}
      pickerSearch={pickerState.search}
      allModelsFlat={allModelsFlat}
      groupedFilteredModels={groupedFilteredModels}
      tasks={tasks}
      setPickerApplyAll={(applyAll) => setPickerState((prev) => ({ ...prev, applyAll }))}
      setPickerSearch={(search) => setPickerState((prev) => ({ ...prev, search }))}
      onClose={closeModelPicker}
      onAssignAll={assignAll}
      onAssignTask={assignTask}
    />
  );

  return embedded ? (
    <section className="msk-embedded ms-dialog" role="region" aria-label="设置">
      <header className="ms-header">
        <div className="ms-header-text">
          <h2 className="ms-title">设置</h2>
          <p className="ms-subtitle">{subtitle}</p>
        </div>
        <button className="ms-close" onClick={onCancel} aria-label="返回写作台">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
      </header>
      <div className="ms-body">{renderBody()}</div>
      {footer}
      {picker}
    </section>
  ) : (
    <div className="msk-backdrop" role="presentation" onClick={onCancel}>
      <section className="msk-dialog ms-dialog" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <header className="ms-header">
          <div className="ms-header-text">
            <h2 className="ms-title">设置</h2>
            <p className="ms-subtitle">{subtitle}</p>
          </div>
          <button className="ms-close" onClick={onCancel} aria-label="关闭">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
          </button>
        </header>
        <div className="ms-body">{renderBody()}</div>
        {footer}
      </section>
      {picker}
    </div>
  );
}
