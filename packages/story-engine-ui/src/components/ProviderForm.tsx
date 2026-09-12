import { GROUP_LABELS, PROVIDER_PRESETS } from "../constants/providerPresets.js";
import type { ProviderFormProps } from "./ModelSettingsDialogTypes.js";

/**
 * AI 服务配置表单。
 * - 正常模式（弹窗/自定义）：预设选择 + 名称/认证变量/接口地址 + API Key + 测试连接。
 * - minimal 模式（官方预设卡片进来）：只显示 API Key + 测试连接；名称/认证变量/接口地址收进「高级选项」折叠。
 */
export function ProviderForm(props: ProviderFormProps) {
  const minimal = props.minimal === true;
  return (
    <div className="ms-add-form">
      {!props.hideHeader && (
        <div className="ms-form-header">
          <h4>{props.editingProviderId ? "配置 AI 服务" : "添加 AI 服务"}</h4>
          <button type="button" className="ms-form-close" onClick={props.onCancel}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
          </button>
        </div>
      )}

      {!props.editingProviderId && !props.hidePresetPicker && (
        <div className="ms-form-group">
          <label className="ms-form-label">预设</label>
          <div className="ms-preset-groups">
            {(["overseas", "china", "aggregator", "local"] as const).map((group) => {
              const items = PROVIDER_PRESETS.filter((p) => p.group === group);
              return (
                <div key={group} className="ms-preset-group">
                  <span className="ms-preset-group-label">{GROUP_LABELS[group]}</span>
                  <div className="ms-preset-chips">
                    {items.map((preset) => (
                      <button
                        key={preset.id}
                        type="button"
                        className={`ms-preset-chip ${props.formPresetId === preset.id ? "is-active" : ""}`}
                        onClick={() => props.onSelectPreset(preset)}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 极简模式（官方预设）：默认只显示 API Key；名称/地址等收进高级选项。 */}
      {!minimal ? (
        <>
          <div className="ms-form-row">
            <div className="ms-form-field">
              <label className="ms-form-label">名称 <span className="ms-required">*</span></label>
              <input className="ms-input" type="text" placeholder="DeepSeek" value={props.formName} onChange={(e) => props.setFormName(e.target.value)} />
            </div>
            <div className="ms-form-field">
              <label className="ms-form-label">认证变量</label>
              <input className="ms-input" type="text" placeholder="DEEPSEEK_API_KEY" value={props.formAuthEnv} onChange={(e) => props.setFormAuthEnv(e.target.value)} />
            </div>
          </div>

          <div className="ms-form-field">
            <label className="ms-form-label">接口地址 <span className="ms-required">*</span></label>
            <input className="ms-input" type="text" placeholder="https://api.deepseek.com/v1" value={props.formBaseUrl} onChange={(e) => props.setFormBaseUrl(e.target.value)} />
            {props.selectedPreset && (
              <span className="ms-field-hint">预设已填入默认地址，可按需修改</span>
            )}
          </div>
        </>
      ) : (
        <details className="ms-advanced-details">
          <summary className="ms-advanced-summary">高级选项</summary>
          <div className="ms-advanced-body">
            <div className="ms-form-field">
              <label className="ms-form-label">名称 <span className="ms-required">*</span></label>
              <input className="ms-input" type="text" placeholder="DeepSeek" value={props.formName} onChange={(e) => props.setFormName(e.target.value)} />
            </div>
            <div className="ms-form-field">
              <label className="ms-form-label">认证变量</label>
              <input className="ms-input" type="text" placeholder="DEEPSEEK_API_KEY" value={props.formAuthEnv} onChange={(e) => props.setFormAuthEnv(e.target.value)} />
            </div>
            <div className="ms-form-field">
              <label className="ms-form-label">接口地址 <span className="ms-required">*</span></label>
              <input className="ms-input" type="text" placeholder="https://api.deepseek.com/v1" value={props.formBaseUrl} onChange={(e) => props.setFormBaseUrl(e.target.value)} />
              {props.selectedPreset && (
                <span className="ms-field-hint">预设已填入默认地址，可按需修改</span>
              )}
            </div>
          </div>
        </details>
      )}

      <div className="ms-form-field">
        <label className="ms-form-label">API 密钥 {props.editingProviderId ? "（留空表示不修改）" : <span className="ms-required">*</span>}</label>
        <div className="ms-input-group">
          <input
            className="ms-input ms-input-key"
            type={props.showApiKey ? "text" : "password"}
            placeholder="sk-…"
            value={props.formApiKey}
            onChange={(e) => props.setFormApiKey(e.target.value)}
          />
          <button
            type="button"
            className="ms-input-icon-btn"
            onClick={() => props.setShowApiKey((v) => !v)}
            aria-label={props.showApiKey ? "隐藏" : "显示"}
          >
            {props.showApiKey ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            )}
          </button>
        </div>
        <span className="ms-field-hint">保存后会写入本机 ~/.story-engine/model-secrets.json，不写入模型设置 JSON</span>
      </div>

      <div className="ms-form-test">
        <button
          type="button"
          className="ms-test-btn"
          disabled={props.testing || !props.formBaseUrl.trim()}
          onClick={props.onTestConnection}
        >
          {props.testing ? (
            <><span className="ms-spinner" /> 测试中...</>
          ) : (
            <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg> 测试连接</>
          )}
        </button>
        {props.testElapsed && <span className="ms-test-time">{(props.testElapsed / 1000).toFixed(1)}s</span>}
      </div>

      {props.testError && <div className="ms-test-error">{props.testError}</div>}

      {props.testModels.length > 0 && (
        <div className="ms-test-success">
          <span className="ms-test-count">{props.testModels.length} 个模型可用</span>
          <div className="ms-model-grid">
            {props.testModels.map((m) => (
              <button
                key={m.id}
                type="button"
                className="ms-model-tag"
                onClick={() => props.onModelQuickAssign(m.id)}
                title="保存并分配给所有任务"
              >
                {m.name ?? m.id}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="ms-form-actions">
        <button type="button" className="ms-btn ms-btn-ghost" onClick={props.onCancel}>取消</button>
        <button
          type="button"
          className="ms-btn ms-btn-primary"
          disabled={!props.formName.trim() || !props.formBaseUrl.trim()}
          onClick={props.onSaveProvider}
        >
          {props.editingProviderId ? "保存修改" : "添加"}
        </button>
      </div>
    </div>
  );
}
