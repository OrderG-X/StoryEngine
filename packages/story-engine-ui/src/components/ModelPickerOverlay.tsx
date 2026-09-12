import { TASK_LABELS, type ModelPickerOverlayProps } from "./ModelSettingsDialogTypes.js";

export function ModelPickerOverlay(props: ModelPickerOverlayProps) {
  return (
    <div className="ms-picker-backdrop" role="presentation" onClick={props.onClose}>
      <div className="ms-picker-panel" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <header className="ms-picker-header">
          <div>
            <h4>选择模型</h4>
            <p>为「{TASK_LABELS[props.editingTask]}」分配模型{props.pickerApplyAll ? "，并应用到全部任务" : ""}</p>
          </div>
          <button type="button" className="ms-form-close" onClick={props.onClose}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
          </button>
        </header>

        <div className="ms-picker-search">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
          <input
            type="text"
            placeholder="搜索模型或 AI 服务…"
            value={props.pickerSearch}
            onChange={(e) => props.setPickerSearch(e.target.value)}
            autoFocus
          />
        </div>

        <div className="ms-picker-body">
          {props.allModelsFlat.length === 0 && (
            <div className="ms-picker-empty">
              <p>暂无可用模型</p>
              <span>请先添加 AI 服务并测试连接获取模型列表</span>
            </div>
          )}

          {props.allModelsFlat.length > 0 && props.groupedFilteredModels.length === 0 && (
            <div className="ms-picker-empty">
              <p>未找到匹配模型</p>
            </div>
          )}

          {props.groupedFilteredModels.map(({ provider, items }) => (
            <div key={provider.id} className="ms-picker-group">
              <div className="ms-picker-group-label">
                <span>{provider.label}</span>
                <small>{items.length} 个模型</small>
              </div>
              <div className="ms-picker-model-grid">
                {items.map((item) => {
                  const isSelected = props.tasks[props.editingTask] === `${item.providerId}|${item.model.id}`;
                  return (
                    <button
                      key={`${item.providerId}-${item.model.id}`}
                      type="button"
                      className={`ms-picker-model-chip ${isSelected ? "is-selected" : ""}`}
                      onClick={() => {
                        if (props.pickerApplyAll) {
                          props.onAssignAll(item.providerId, item.model.id);
                        } else {
                          props.onAssignTask(props.editingTask, item.providerId, item.model.id);
                        }
                      }}
                    >
                      <span className="ms-picker-model-name">{item.model.name ?? item.model.id}</span>
                      <span className="ms-picker-model-id">{item.model.id}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <footer className="ms-picker-footer">
          <label className="ms-picker-apply-all">
            <input
              type="checkbox"
              checked={props.pickerApplyAll}
              onChange={(e) => props.setPickerApplyAll(e.target.checked)}
            />
            同时应用到全部任务
          </label>
          <button type="button" className="ms-btn ms-btn-ghost" onClick={props.onClose}>取消</button>
        </footer>
      </div>
    </div>
  );
}
