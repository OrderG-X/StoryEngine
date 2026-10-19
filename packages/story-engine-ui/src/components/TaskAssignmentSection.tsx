import { PROVIDER_PRESETS } from "../constants/providerPresets.js";
import { TASK_HINTS, TASK_LABELS, TASK_SUGGEST_THINKING, type TaskAssignmentSectionProps } from "./ModelSettingsDialogTypes.js";

export function TaskAssignmentSection({ tasks, thinking, savedProviders, onEditTask, onToggleThinking }: TaskAssignmentSectionProps) {
  return (
    <section className="ms-section">
      <div className="ms-section-header">
        <div className="ms-section-title-row">
          <h3 className="ms-section-title">各功能使用的 AI</h3>
        </div>
        <span className="ms-section-hint">每个功能可以用不同的模型；写正文建议关「深度思考」，审稿、查硬伤建议开</span>
      </div>

      <div className="ms-task-list">
        {Object.entries(TASK_LABELS).map(([key, label]) => {
          const current = tasks[key] ?? "";
          const [curProv, curModel] = current ? current.split("|") : ["", ""];
          const provLabel = curProv
            ? (savedProviders.find((p) => p.id === curProv)?.label ?? PROVIDER_PRESETS.find((p) => p.id === curProv)?.label ?? curProv)
            : "";
          const think = thinking[key] ?? true;
          const suggestOn = TASK_SUGGEST_THINKING[key] ?? true;

          return (
            <div key={key} className="ms-task-row">
              <div className="ms-task-label-col">
                <span className="ms-task-name">{label}</span>
                <span className="ms-task-desc">{TASK_HINTS[key]}</span>
              </div>
              <div className="ms-task-action-col">
                {curModel ? (
                  <>
                    <span className="ms-task-model-badge" title={`${provLabel} · ${curModel}`}>
                      {provLabel && <span className="ms-task-prov">{provLabel}</span>}
                      {curModel}
                    </span>
                    <button type="button" className="ms-btn ms-btn-xs" onClick={() => onEditTask(key)}>换</button>
                  </>
                ) : (
                  <>
                    <button type="button" className="ms-btn ms-btn-xs ms-btn-dashed" onClick={() => onEditTask(key)}>分配模型</button>
                    <span className="ms-task-fallback-note">没单独选，用默认模型</span>
                  </>
                )}
                <label className="ms-task-think" title={suggestOn ? "这个功能建议开深度思考" : "这个功能建议关深度思考（写正文更自然）"}>
                  <input type="checkbox" checked={think} onChange={() => onToggleThinking(key)} />
                  <span className="ms-task-think-label">深度思考</span>
                  <span className="ms-task-think-hint">{suggestOn ? "建议开" : "建议关"}</span>
                </label>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
