import { useMemo, useState } from "react";

import { GROUP_LABELS, PROVIDER_PRESETS, type ProviderPreset, type ProviderPresetGroup } from "../../../constants/providerPresets.js";
import type { SavedProvider } from "../../ModelSettingsDialogTypes.js";

// 国产在前（P11）：用的人多半在国内，海外的要另外的网络条件。
const GROUP_ORDER: readonly ProviderPresetGroup[] = ["china", "aggregator", "overseas", "local"];

const GROUP_LABELS_SHORT: Record<ProviderPresetGroup, string> = {
  overseas: "海外",
  china: "国产",
  aggregator: "聚合",
  local: "本地",
};

interface AiServiceManagerProps {
  readonly savedProviders: readonly SavedProvider[];
  /** 点卡片：id = 预设或已存服务商 id；null = 新建自定义服务。 */
  readonly onSelect: (id: string | null) => void;
}

/** 密钥就绪（已存或不需要）→ 可写作。状态文案只说事实：不说「已连接」（没测过连通）。 */
function statusOf(saved: SavedProvider | undefined): { text: string; dot: "ok" | "warn" | "" } {
  if (!saved) return { text: "未配置", dot: "" };
  if (saved.apiKeyStatus === "present" || saved.apiKeyStatus === "not_required") {
    return { text: "已配置", dot: "ok" };
  }
  return { text: "缺密钥", dot: "warn" };
}

/**
 * 服务商（P10 重排）：已接好的排在上面；没接的收进「添加服务商」（搜索 + 分类 + 自定义服务），
 * 一个都没接时直接展开。点卡片进入配置详情。
 */
export function AiServiceManager({ savedProviders, onSelect }: AiServiceManagerProps) {
  const [query, setQuery] = useState("");
  const [selectedGroup, setSelectedGroup] = useState<ProviderPresetGroup | null>(null);
  const [catalogOpen, setCatalogOpen] = useState(savedProviders.length === 0);

  const savedById = useMemo(() => {
    const map = new Map<string, SavedProvider>();
    for (const p of savedProviders) map.set(p.id, p);
    return map;
  }, [savedProviders]);

  const q = query.trim().toLowerCase();

  const filteredPresets = useMemo(() => {
    return PROVIDER_PRESETS.filter((preset) => {
      if (savedById.has(preset.id)) return false;
      if (selectedGroup && preset.group !== selectedGroup) return false;
      if (!q) return true;
      const savedLabel = savedById.get(preset.id)?.label ?? "";
      return (
        preset.label.toLowerCase().includes(q) ||
        preset.id.toLowerCase().includes(q) ||
        savedLabel.toLowerCase().includes(q)
      );
    });
  }, [q, selectedGroup, savedById]);


  const byGroup = useMemo(() => {
    const map = {} as Record<ProviderPresetGroup, ProviderPreset[]>;
    for (const group of GROUP_ORDER) map[group] = [];
    for (const preset of filteredPresets) map[preset.group].push(preset);
    return map;
  }, [filteredPresets]);

  const groupCounts = useMemo(() => {
    const counts = {} as Record<ProviderPresetGroup, number>;
    for (const group of GROUP_ORDER) {
      counts[group] = PROVIDER_PRESETS.filter((p) => p.group === group && !savedById.has(p.id)).length;
    }
    return counts;
  }, [savedById]);

  const nothingMatched = filteredPresets.length === 0 && Boolean(q);
  const presetLabel = (id: string) => PROVIDER_PRESETS.find((preset) => preset.id === id)?.label;

  return (
    <div className="asm-page">
      {savedProviders.length > 0 ? (
        <section className="asm-group" aria-label="已接好的服务商">
          <h3 className="asm-group-title">已接好的</h3>
          <div className="asm-grid">
            {savedProviders.map((p) => {
              const status = statusOf(p);
              const preset = presetLabel(p.id);
              return (
                <button key={p.id} type="button" className="asm-card is-configured" onClick={() => onSelect(p.id)}>
                  <span className="asm-card-top">
                    <span className="asm-card-name">{p.label}</span>
                    <span className={`asm-dot ${status.dot}`} />
                  </span>
                  <span className="asm-card-status">{status.text}</span>
                  <span className="asm-card-hint asm-card-url">{preset && preset !== p.label ? `${preset} · ${p.baseUrl}` : p.baseUrl}</span>
                </button>
              );
            })}
          </div>
        </section>
      ) : null}

      {savedProviders.length > 0 ? (
        <button type="button" className="asm-add-toggle" aria-expanded={catalogOpen} onClick={() => setCatalogOpen((open) => !open)}>
          {catalogOpen ? "收起" : "＋ 添加服务商"}
        </button>
      ) : null}

      {catalogOpen ? (
      <>
      {/* 二十几家摆出来，新作者不知道挑哪家（2026-10-22 好上手走查）：一句怎么挑，不点名推荐。 */}
      <p className="asm-pick-hint">有哪家的账号就选哪家。都还没有：任选一家注册，在它的控制台建一个 API 密钥，回来点它贴上。模型跑在自己电脑上的，选「本地 / 自部署」。</p>
      {/* 搜索 */}
      <div className="asm-search">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索服务商"
          aria-label="搜索服务商"
        />
        {query && (
          <button className="asm-search-clear" onClick={() => setQuery("")} aria-label="清空搜索" type="button">×</button>
        )}
      </div>

      {/* 分组筛选 */}
      <div className="asm-groups">
        <button
          type="button"
          className={`asm-chip ${selectedGroup === null ? "is-active" : ""}`}
          onClick={() => setSelectedGroup(null)}
        >
          全部 {PROVIDER_PRESETS.filter((p) => !savedById.has(p.id)).length}
        </button>
        {GROUP_ORDER.map((group) => (
          <button
            key={group}
            type="button"
            className={`asm-chip ${selectedGroup === group ? "is-active" : ""}`}
            onClick={() => setSelectedGroup(selectedGroup === group ? null : group)}
          >
            {GROUP_LABELS_SHORT[group]} {groupCounts[group]}
          </button>
        ))}
      </div>

      {/* 分组卡片网格 */}
      {GROUP_ORDER.map((group) => {
        const list = byGroup[group];
        if (list.length === 0) return null;
        return (
          <section key={group} className="asm-group">
            <h3 className="asm-group-title">{GROUP_LABELS[group]}</h3>
            <div className="asm-grid">
              {list.map((preset) => (
                <button key={preset.id} type="button" className="asm-card" onClick={() => onSelect(preset.id)}>
                  <span className="asm-card-top">
                    <span className="asm-card-name">{preset.label}</span>
                    <span className="asm-dot" />
                  </span>
                  <span className="asm-card-status">没接</span>
                  {preset.note ? <span className="asm-card-hint">{preset.note}</span> : null}
                </button>
              ))}
            </div>
          </section>
        );
      })}

      {/* 自定义服务：接任意 OpenAI 兼容接口（已存的自定义服务在上面「已接好的」里）。 */}
      {!selectedGroup && !q ? (
        <section className="asm-group">
          <h3 className="asm-group-title">自定义服务</h3>
          <div className="asm-grid">
            <button type="button" className="asm-card asm-card-custom" onClick={() => onSelect(null)}>
              <span className="asm-card-plus">＋</span>
              <span className="asm-card-status">自定义服务</span>
              <span className="asm-card-hint">接入任意 OpenAI 兼容接口</span>
            </button>
          </div>
        </section>
      ) : null}

      {nothingMatched && (
        <div className="asm-empty">没有匹配的服务商</div>
      )}
      </>
      ) : null}
    </div>
  );
}
