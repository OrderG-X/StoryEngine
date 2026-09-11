import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { fetchModelSettings, saveModelSettings, testModelConnection } from "../../../api/client.js";
import { PROVIDER_PRESETS } from "../../../constants/providerPresets.js";
import type { ModelInfoItem } from "../../../api/types.js";
import { ChatMemoryBudgetSection } from "../../ChatMemoryBudgetSection.js";
import { ModelPickerOverlay } from "../../ModelPickerOverlay.js";
import { ProviderForm } from "../../ProviderForm.js";
import { TaskAssignmentSection } from "../../TaskAssignmentSection.js";
import {
  buildModelSettingsConfig,
  buildTaskAssignmentsPayload,
  formatHumanTestError,
  parseChatHistoryBudgetTokens,
  parseModelSettings,
  parseTaskViewState,
} from "../../ModelSettingsDialogLogic.js";
import {
  TASK_LABELS,
  type FlatModelItem,
  type GroupedModelItems,
  type SavedProvider,
} from "../../ModelSettingsDialogTypes.js";
import { useWorkspaceStore } from "../../../stores/workspaceStore.js";
import { AiServiceManager } from "./AiServiceManager.js";
// 本页直接用 .ms-notice/.ms-warn-notice/.ms-error 等 ms-* 样式，显式引入其所在 css，不再隐式依赖单 bundle 里别人捎带。
import "../../ModelSettingsDialog.css";
import "./aiSettings.css";

const DEFAULT_CHAT_MEMORY = 96_000;

interface AiSettingsPageProps {
  readonly onBack: () => void;
}

interface FormState {
  readonly presetId: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly authEnv: string;
  readonly apiKey: string;
  readonly showApiKey: boolean;
}

const EMPTY_FORM: FormState = { presetId: "", name: "", baseUrl: "", authEnv: "", apiKey: "", showApiKey: false };

/** 详情目标：id = 预设或已存服务商 id；null = 新建自定义服务。 */
type View = { readonly kind: "list" } | { readonly kind: "detail"; readonly id: string | null };

interface PickerState {
  readonly editingTask: string | null;
  readonly applyAll: boolean;
  readonly search: string;
}

const CLOSED_PICKER: PickerState = { editingTask: null, applyAll: false, search: "" };

/** 持久化快照：每次写盘带全量状态，序列化排队防交错覆盖。 */
interface PersistSnapshot {
  readonly providers: readonly SavedProvider[];
  readonly tasks: Record<string, string>;
  readonly thinking: Record<string, boolean>;
  readonly budget: number;
  readonly apiKeys?: Record<string, string>;
}

function slugifyProviderId(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^\w]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || `custom-${Date.now().toString(36)}`;
}

/**
 * AI 设置整页（服务商卡片 + 详情配置 + 任务分配）：
 *  - list：服务商卡片网格（预设 + 已存自定义），下方是「各功能使用的 AI」任务分配与对话记忆上限；
 *  - detail：点卡片进入该服务商配置（已配置的回填已保存值），测通后可一键「保存并分配给所有任务」。
 * 数据层走与 ModelSettingsDialog 相同的逻辑：读 result.summary（带密钥状态的规范化视图），
 * 写 buildModelSettingsConfig（providers 保持「以 id 为键的对象」规范形态）+ 任务分配旁路。
 * 每步操作即时落盘——没有全局「保存」按钮。
 */
export function AiSettingsPage({ onBack }: AiSettingsPageProps) {
  const [view, setView] = useState<View>({ kind: "list" });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [savedProviders, setSavedProviders] = useState<readonly SavedProvider[]>([]);
  const [providerModels, setProviderModels] = useState<Record<string, readonly ModelInfoItem[]>>({});
  const [tasks, setTasks] = useState<Record<string, string>>({});
  const [thinking, setThinking] = useState<Record<string, boolean>>({});
  const [chatMemoryBudget, setChatMemoryBudget] = useState(DEFAULT_CHAT_MEMORY);

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [testing, setTesting] = useState(false);
  const [testModels, setTestModels] = useState<readonly ModelInfoItem[]>([]);
  const [testError, setTestError] = useState<string | null>(null);
  const [testElapsed, setTestElapsed] = useState<number | null>(null);

  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [opError, setOpError] = useState<string | null>(null);
  const [saveWarnings, setSaveWarnings] = useState<readonly string[]>([]);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [picker, setPicker] = useState<PickerState>(CLOSED_PICKER);

  // 最新状态镜像：持久化调用取「此刻真值 + 本次改动」，不受 setState 异步影响。
  const stateRef = useRef({ providers: savedProviders, tasks, thinking, budget: chatMemoryBudget });
  useEffect(() => {
    stateRef.current = { providers: savedProviders, tasks, thinking, budget: chatMemoryBudget };
  }, [savedProviders, tasks, thinking, chatMemoryBudget]);

  const persistQueue = useRef(Promise.resolve());
  const budgetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 最近一次 GET/保存回显的配置原文（customHeaders 已打码）：persist 写盘前会先 GET 刷新它再作合并底
  // （防同会话他面改盘后被陈旧缓存静默抹字段）；预读失败时才用它兜底。只作写盘输入、不驱动渲染，用 ref 即可。
  const rawTextRef = useRef("");

  const detailId = view.kind === "detail" ? view.id : null;
  const detailSaved = useMemo(
    () => (detailId ? savedProviders.find((p) => p.id === detailId) ?? null : null),
    [detailId, savedProviders],
  );
  const detailPreset = useMemo(
    () => (detailId ? PROVIDER_PRESETS.find((p) => p.id === detailId) ?? null : null),
    [detailId],
  );
  const editingExisting = detailSaved !== null;

  const applySaved = useCallback((
    res: Awaited<ReturnType<typeof saveModelSettings>>,
    refreshWarnings: boolean,
  ) => {
    rawTextRef.current = res.rawText;
    const parsed = parseModelSettings(res.result);
    setSavedProviders(parsed.providers);
    // 模型列表合并：保留比 profile 反推更全的已同步列表（仅限仍存在的服务商）。
    setProviderModels((prev) => {
      const merged: Record<string, readonly ModelInfoItem[]> = { ...parsed.providerModels };
      for (const p of parsed.providers) {
        const old = prev[p.id];
        if (old && old.length > (merged[p.id]?.length ?? 0)) merged[p.id] = old;
      }
      return merged;
    });
    const viewState = parseTaskViewState(res.taskAssignments, res.result?.summary?.profiles ?? []);
    setTasks(Object.keys(viewState.tasks).length > 0 ? viewState.tasks : parsed.tasks);
    if (Object.keys(viewState.thinking).length > 0) setThinking(viewState.thinking);
    const budget = parseChatHistoryBudgetTokens(res.rawText);
    if (budget !== null) setChatMemoryBudget(budget);
    // 警告归属「服务商保存」类动作：只有它们（refreshWarnings=true）的成功响应才刷新/清空警告；
    // 任务分配、thinking 开关、记忆上限等轻量旁路保存不动旧警告——防用户还没补回丢的头，
    // 警告就被无关自动保存抹掉。任何保存真带回新警告都如实替换展示（新警告绝不静默吞）。
    // 警告需用户补明文值才能消解，不走 4 秒自动消失。
    setSaveWarnings((prev) => {
      if (res.warnings && res.warnings.length > 0) return res.warnings;
      return refreshWarnings ? [] : prev;
    });
  }, []);

  /** 全量快照写盘（config 规范 map + 任务旁路 + 密钥），排队串行防交错。 */
  const persist = useCallback((
    overrides: Partial<PersistSnapshot>,
    options?: { readonly refreshWarnings?: boolean },
  ) => {
    const snapshot: PersistSnapshot = { ...stateRef.current, ...overrides };
    const run = async () => {
      // 合并底取「此刻磁盘真值」：本页只在挂载时拉过一次 rawText，而同会话内 App 级设置弹窗
      // （首页与工作区都能开 ModelSettingsDialog）随时可能改盘——拿陈旧 ref 当合并底会把别人
      // 新写的字段（defaultProfile/customHeaders 等表单不认识的键）静默抹掉（三审 P2 rawTextRef
      // 陈旧）。预读失败退回 ref 缓存：持久化主路不因一次 GET 变脆。
      try {
        rawTextRef.current = (await fetchModelSettings()).rawText;
      } catch { /* 退回 ref 缓存合并 */ }
      const built = buildModelSettingsConfig(snapshot.providers, snapshot.tasks, {
        chatHistoryBudgetTokens: snapshot.budget,
        previousRawText: rawTextRef.current,
      });
      const payload = buildTaskAssignmentsPayload(built.cleanedTasks, snapshot.thinking);
      const res = await saveModelSettings(JSON.stringify(built.config, null, 2), snapshot.apiKeys, payload);
      applySaved(res, options?.refreshWarnings ?? false);
      // 合并清洗动作（剔除手写明文密钥/清掉指向已删服务商的任务/非法旋钮回默认）如实进警告区，
      // 与服务端 warnings 同栏、不自动消失——用户据此补密钥或重选模型。
      if (built.cleaningWarnings.length > 0) {
        setSaveWarnings((prev) => [...built.cleaningWarnings, ...prev]);
      }
    };
    const p = persistQueue.current.then(run, run);
    persistQueue.current = p.then(
      () => undefined,
      () => undefined,
    );
    return p;
  }, [applySaved]);

  /** 后台逐家刷新可用模型列表（用已存密钥测连通）；单家失败静默，任务分配选择器仍有 profile 反推兜底。 */
  const syncProviderModels = useCallback(async (
    providers: readonly SavedProvider[],
    isCancelled: () => boolean = () => false,
  ) => {
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
          if (!isCancelled() && r.models.length > 0) {
            setProviderModels((prev) => ({ ...prev, [p.id]: r.models }));
          }
        } catch {
          // 单家刷新失败不阻塞页面；详情页测试连接可看到具体错误。
        }
      }),
    );
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchModelSettings()
      .then((r) => {
        if (cancelled) return;
        rawTextRef.current = r.rawText ?? "";
        const parsed = parseModelSettings(r.result);
        setSavedProviders(parsed.providers);
        setProviderModels(parsed.providerModels);
        const viewState = parseTaskViewState(r.taskAssignments, r.result?.summary?.profiles ?? []);
        setTasks(Object.keys(viewState.tasks).length > 0 ? viewState.tasks : parsed.tasks);
        setThinking(viewState.thinking);
        setChatMemoryBudget(parseChatHistoryBudgetTokens(r.rawText) ?? DEFAULT_CHAT_MEMORY);
        setLoading(false);
        void syncProviderModels(parsed.providers, () => cancelled);
      })
      .catch((e) => {
        if (cancelled) return;
        setLoadError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [syncProviderModels]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  const openDetail = useCallback((id: string | null) => {
    const saved = id ? savedProviders.find((p) => p.id === id) : undefined;
    const preset = id ? PROVIDER_PRESETS.find((p) => p.id === id) : undefined;
    // 已配置的回填已保存值（防「重开显示预设默认、保存覆盖自定义地址」）；未配置的用预设默认。
    setForm({
      presetId: preset?.id ?? "",
      name: saved?.label ?? preset?.label ?? "",
      baseUrl: saved?.baseUrl ?? preset?.baseUrl ?? "",
      authEnv: saved?.apiKeyEnv ?? preset?.apiKeyEnvSuggestion ?? "",
      apiKey: "",
      showApiKey: false,
    });
    setTestModels(id ? [...(providerModels[id] ?? [])] : []);
    setTestError(null);
    setTestElapsed(null);
    setDeleteArmed(false);
    setView({ kind: "detail", id });
  }, [savedProviders, providerModels]);

  const backToList = useCallback(() => {
    setView({ kind: "list" });
    setTestError(null);
    setDeleteArmed(false);
  }, []);

  const handleTest = useCallback(async () => {
    const baseUrl = form.baseUrl.trim();
    if (!baseUrl) {
      setTestError("请先填写接口地址");
      return;
    }
    setTesting(true);
    setTestError(null);
    setTestModels([]);
    const started = Date.now();
    try {
      const r = await testModelConnection({
        providerId: detailId ?? form.presetId ?? "custom",
        baseUrl,
        apiKey: form.apiKey.trim() || undefined,
        apiKeyEnv: form.authEnv.trim() || undefined,
      });
      setTestElapsed(Date.now() - started);
      setTestModels(r.models);
      if (detailId) setProviderModels((prev) => ({ ...prev, [detailId]: r.models }));
    } catch (e) {
      setTestElapsed(Date.now() - started);
      setTestError(formatHumanTestError(e));
    } finally {
      setTesting(false);
    }
  }, [form.baseUrl, form.apiKey, form.authEnv, form.presetId, detailId]);

  /** 由表单构造下一份 providers（新建/更新），返回目标 id 与列表。 */
  const buildNextProviders = useCallback((): { id: string; providers: readonly SavedProvider[] } | null => {
    const name = form.name.trim();
    const baseUrl = form.baseUrl.trim();
    if (!name || !baseUrl) {
      setTestError("请填写名称和接口地址");
      return null;
    }
    const id = detailId ?? (form.presetId || slugifyProviderId(name));
    const previous = savedProviders.find((p) => p.id === id);
    const next: SavedProvider = {
      id,
      label: name,
      baseUrl,
      apiKeyEnv: form.authEnv.trim(),
      apiKeyStatus: form.apiKey.trim() ? "present" : previous?.apiKeyStatus ?? "missing",
    };
    const providers = previous
      ? savedProviders.map((p) => (p.id === id ? next : p))
      : [...savedProviders, next];
    return { id, providers };
  }, [form, detailId, savedProviders]);

  const handleSaveProvider = useCallback(async () => {
    const built = buildNextProviders();
    if (!built) return;
    setSaving(true);
    setTestError(null);
    try {
      const key = form.apiKey.trim();
      await persist(
        { providers: built.providers, apiKeys: key ? { [built.id]: key } : undefined },
        { refreshWarnings: true },
      );
      if (testModels.length > 0) {
        setProviderModels((prev) => ({ ...prev, [built.id]: [...testModels] }));
      }
      setNotice("已保存");
      backToList();
    } catch (e) {
      setTestError(`保存失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  }, [buildNextProviders, form.apiKey, testModels, persist, backToList]);

  /** 测通后点模型：保存服务商 + 该模型分配给全部任务，一步到位（原「死按钮」补活）。 */
  const handleQuickAssign = useCallback(async (modelId: string) => {
    const built = buildNextProviders();
    if (!built) return;
    const nextTasks: Record<string, string> = {};
    for (const key of Object.keys(TASK_LABELS)) nextTasks[key] = `${built.id}|${modelId}`;
    setSaving(true);
    setTestError(null);
    try {
      const key = form.apiKey.trim();
      await persist(
        {
          providers: built.providers,
          tasks: nextTasks,
          apiKeys: key ? { [built.id]: key } : undefined,
        },
        { refreshWarnings: true },
      );
      if (testModels.length > 0) {
        setProviderModels((prev) => ({ ...prev, [built.id]: [...testModels] }));
      }
      setNotice(`已保存，并把 ${modelId} 分配给全部任务`);
      backToList();
    } catch (e) {
      setTestError(`保存失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  }, [buildNextProviders, form.apiKey, testModels, persist, backToList]);

  const handleDeleteProvider = useCallback(async () => {
    if (!detailId || !editingExisting) return;
    if (!deleteArmed) {
      setDeleteArmed(true);
      return;
    }
    const nextProviders = savedProviders.filter((p) => p.id !== detailId);
    const nextTasks: Record<string, string> = {};
    for (const [k, v] of Object.entries(tasks)) {
      const [pid] = v.split("|");
      if (pid !== detailId) nextTasks[k] = v;
    }
    setSaving(true);
    setTestError(null);
    try {
      await persist({ providers: nextProviders, tasks: nextTasks }, { refreshWarnings: true });
      setProviderModels((prev) => {
        const next = { ...prev };
        delete next[detailId];
        return next;
      });
      setNotice("已删除该 AI 服务");
      backToList();
    } catch (e) {
      setTestError(`删除失败：${e instanceof Error ? e.message : String(e)}`);
      setDeleteArmed(false);
    } finally {
      setSaving(false);
    }
  }, [detailId, editingExisting, deleteArmed, savedProviders, tasks, persist, backToList]);

  const commitTasks = useCallback((nextTasks: Record<string, string>, nextThinking: Record<string, boolean>) => {
    setTasks(nextTasks);
    setThinking(nextThinking);
    persist({ tasks: nextTasks, thinking: nextThinking })
      .then(() => setOpError(null))
      .catch((e) => setOpError(`任务分配保存失败：${e instanceof Error ? e.message : String(e)}`));
  }, [persist]);

  const assignTask = useCallback((taskKey: string, providerId: string, modelId: string) => {
    commitTasks({ ...stateRef.current.tasks, [taskKey]: `${providerId}|${modelId}` }, stateRef.current.thinking);
    setPicker(CLOSED_PICKER);
  }, [commitTasks]);

  const assignAll = useCallback((providerId: string, modelId: string) => {
    const next: Record<string, string> = {};
    for (const key of Object.keys(TASK_LABELS)) next[key] = `${providerId}|${modelId}`;
    commitTasks(next, stateRef.current.thinking);
    setPicker(CLOSED_PICKER);
  }, [commitTasks]);

  const toggleThinking = useCallback((taskKey: string) => {
    const current = stateRef.current.thinking;
    commitTasks(stateRef.current.tasks, { ...current, [taskKey]: !(current[taskKey] ?? true) });
  }, [commitTasks]);

  const handleBudgetChange = useCallback((tokens: number) => {
    setChatMemoryBudget(tokens);
    // 同步工作区在用值：聊天记忆裁剪读 workspaceStore.chatHistoryBudget（useChat/ChatSessionBar 徽标），
    // 不同步的话这里改完要重开书才生效（与 ChatSessionBar 直改预算的行为对齐）。
    useWorkspaceStore.getState().setChatHistoryBudget(tokens);
    if (budgetTimer.current) clearTimeout(budgetTimer.current);
    budgetTimer.current = setTimeout(() => {
      persist({ budget: tokens })
        .then(() => setOpError(null))
        .catch((e) => setOpError(`记忆上限保存失败：${e instanceof Error ? e.message : String(e)}`));
    }, 600);
  }, [persist]);

  useEffect(() => () => {
    if (budgetTimer.current) clearTimeout(budgetTimer.current);
  }, []);

  const allModelsFlat = useMemo(() => {
    const out: FlatModelItem[] = [];
    for (const prov of savedProviders) {
      for (const m of providerModels[prov.id] ?? []) {
        out.push({ providerId: prov.id, providerLabel: prov.label, model: m });
      }
    }
    return out;
  }, [savedProviders, providerModels]);

  const groupedFilteredModels = useMemo(() => {
    const q = picker.search.trim().toLowerCase();
    const filtered = q
      ? allModelsFlat.filter(
          (item) =>
            item.model.id.toLowerCase().includes(q) ||
            (item.model.name ?? "").toLowerCase().includes(q) ||
            item.providerLabel.toLowerCase().includes(q),
        )
      : allModelsFlat;
    const map: Record<string, FlatModelItem[]> = {};
    for (const item of filtered) {
      (map[item.providerId] ??= []).push(item);
    }
    const result: GroupedModelItems[] = [];
    for (const prov of savedProviders) {
      if (map[prov.id]) result.push({ provider: prov, items: map[prov.id] });
    }
    return result;
  }, [allModelsFlat, picker.search, savedProviders]);

  const customDetail = view.kind === "detail" && view.id === null;
  const headerTitle = view.kind === "list"
    ? "AI 设置"
    : customDetail
      ? "自定义服务"
      : form.name || detailPreset?.label || "AI 服务";
  const headerSubtitle = view.kind === "list"
    ? "选择服务商填 Key，即可开始写作；下方可给每个功能分配模型。"
    : editingExisting
      ? "改动保存后立即生效。密钥留空表示不修改。"
      : "填入 API Key，测试通过后保存。";

  return (
    <section className="msk-embedded ms-dialog asm-shell" role="region" aria-label="AI 设置">
      <header className="ms-header">
        <div className="ms-header-text">
          <h2 className="ms-title">{headerTitle}</h2>
          <p className="ms-subtitle">{headerSubtitle}</p>
        </div>
        <button className="ms-close" onClick={onBack} aria-label="返回写作台">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
      </header>

      <div className="ms-body asm-body">
        {loading && <div className="ms-loading">正在加载配置...</div>}
        {loadError && !loading && <div className="ms-error">{loadError}</div>}

        {!loading && !loadError && (
          <div key={view.kind} className="asm-view-anim">
            {notice && <div className="ms-notice">{notice}</div>}
            {saveWarnings.length > 0 && (
              <div className="ms-notice ms-warn-notice">
                {saveWarnings.map((warning, index) => (
                  <div key={`warn-${index}`}>{warning}</div>
                ))}
                {/* 本页表单只有名称/地址/认证变量/密钥 4 个字段、无 raw JSON 编辑器，
                    被丢的 customHeaders 在本页补不回——指路到首页设置弹窗的原始 JSON。 */}
                <div>
                  补回路径：回首页点「设置」→ 高级设置 →「原始 JSON 编辑」，在对应服务商下写回
                  customHeaders 明文值后保存。
                </div>
              </div>
            )}
            {opError && <div className="ms-error">{opError}</div>}

            {view.kind === "list" && (
              <>
                <AiServiceManager
                  savedProviders={savedProviders}
                  onSelect={(id) => openDetail(id)}
                />

                {savedProviders.length > 0 && (
                  <TaskAssignmentSection
                    tasks={tasks}
                    thinking={thinking}
                    savedProviders={savedProviders}
                    onEditTask={(taskKey) => setPicker({ editingTask: taskKey, applyAll: false, search: "" })}
                    onToggleThinking={toggleThinking}
                  />
                )}

                <ChatMemoryBudgetSection value={chatMemoryBudget} onChange={handleBudgetChange} />
              </>
            )}

            {view.kind === "detail" && (
              <>
                <button type="button" className="asm-back" onClick={backToList}>
                  ← 返回服务商列表
                </button>
                {customDetail && (
                  <div className="asm-custom-note">
                    接入任意 OpenAI 兼容接口：填写服务名称与 Base URL。
                  </div>
                )}
                <ProviderForm
                  editingProviderId={editingExisting ? detailId : null}
                  hidePresetPicker
                  hideHeader
                  minimal={detailPreset !== null}
                  formPresetId={form.presetId}
                  formName={form.name}
                  formBaseUrl={form.baseUrl}
                  formAuthEnv={form.authEnv}
                  formApiKey={form.apiKey}
                  showApiKey={form.showApiKey}
                  selectedPreset={detailPreset}
                  testing={testing}
                  testModels={testModels}
                  testError={testError}
                  testElapsed={testElapsed}
                  setFormName={(v: string) => setForm((f) => ({ ...f, name: v }))}
                  setFormBaseUrl={(v: string) => setForm((f) => ({ ...f, baseUrl: v }))}
                  setFormAuthEnv={(v: string) => setForm((f) => ({ ...f, authEnv: v }))}
                  setFormApiKey={(v: string) => setForm((f) => ({ ...f, apiKey: v }))}
                  setShowApiKey={(updater: (value: boolean) => boolean) => setForm((f) => ({ ...f, showApiKey: updater(f.showApiKey) }))}
                  onSelectPreset={() => { /* 详情页服务商已确定，预设选择区已隐藏 */ }}
                  onTestConnection={() => { void handleTest(); }}
                  onCancel={backToList}
                  onSaveProvider={() => { void handleSaveProvider(); }}
                  onModelQuickAssign={(modelId: string) => { void handleQuickAssign(modelId); }}
                />
                {editingExisting && (
                  <div className="asm-danger-row">
                    <button
                      type="button"
                      className={`asm-delete-btn ${deleteArmed ? "is-armed" : ""}`}
                      disabled={saving}
                      onClick={() => { void handleDeleteProvider(); }}
                    >
                      {deleteArmed ? "再点一次确认删除" : "删除此服务"}
                    </button>
                    {deleteArmed && (
                      <button type="button" className="asm-delete-cancel" onClick={() => setDeleteArmed(false)}>
                        算了
                      </button>
                    )}
                  </div>
                )}
                {saving && <div className="ms-notice">保存中...</div>}
              </>
            )}
          </div>
        )}
      </div>

      {picker.editingTask && (
        <ModelPickerOverlay
          editingTask={picker.editingTask}
          pickerApplyAll={picker.applyAll}
          pickerSearch={picker.search}
          allModelsFlat={allModelsFlat}
          groupedFilteredModels={groupedFilteredModels}
          tasks={tasks}
          setPickerApplyAll={(applyAll) => setPicker((prev) => ({ ...prev, applyAll }))}
          setPickerSearch={(search) => setPicker((prev) => ({ ...prev, search }))}
          onClose={() => setPicker(CLOSED_PICKER)}
          onAssignAll={assignAll}
          onAssignTask={assignTask}
        />
      )}
    </section>
  );
}
