import { useState } from "react";
import { CHAT_MEMORY_PRESETS } from "../constants/wizardPresets.js";

export interface ChatMemoryBudgetSectionProps {
  readonly value: number;
  readonly onChange: (tokens: number) => void;
}

/** 对话记忆：只给短 / 标准 / 长篇三档；具体数字收进「更多」（P10）。 */
export function ChatMemoryBudgetSection({ value, onChange }: ChatMemoryBudgetSectionProps) {
  const isPreset = CHAT_MEMORY_PRESETS.some((preset) => preset.tokens === value);
  const [showMore, setShowMore] = useState(!isPreset);
  return (
    <section className="ms-section" aria-label="对话记忆">
      <div className="ms-section-header">
        <div className="ms-section-title-row">
          <h3 className="ms-section-title">对话记忆</h3>
        </div>
        <span className="ms-section-hint">AI 一次能记住多少前面的对话；长篇选「长篇」</span>
      </div>

      <div className="ms-memory-row">
        <div className="ms-memory-presets" role="group" aria-label="记忆预设">
          {CHAT_MEMORY_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={`ms-memory-preset ${value === preset.tokens ? "is-active" : ""}`}
              onClick={() => onChange(preset.tokens)}
            >
              {preset.label}
            </button>
          ))}
        </div>
        {showMore ? (
        <label className="ms-memory-input-wrap">
          <span className="ms-form-label">tokens</span>
          <input
            className="ms-input ms-memory-input"
            type="number"
            min={10_000}
            step={1_000}
            value={value}
            onChange={(e) => {
              const next = Number.parseInt(e.target.value, 10);
              if (Number.isFinite(next) && next > 0) onChange(next);
            }}
          />
        </label>
        ) : (
          <button type="button" className="ms-btn ms-btn-xs" onClick={() => setShowMore(true)}>更多</button>
        )}
      </div>
    </section>
  );
}
