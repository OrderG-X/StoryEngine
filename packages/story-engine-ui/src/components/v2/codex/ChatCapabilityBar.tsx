/**
 * ChatCapabilityBar —— 聊天区（右栏·唯一控制面）输入框上方的「能力快捷条」。
 *
 * 治「这么多能力用户不知道能用」：写作流程那几个工具已由 ChapterToolRail 按阶段列出；这里补上
 * **散的、非阶段性的资料/整理能力**（补全角色/世界观/地点/资产/写作规则、整理关系/清理线索/合并伏笔）——
 * 它们此前只散落在各资料面板按钮里、用户在聊天时看不见。高频几个常驻露脸，点「⋯ 更多」展开全部。
 *
 * 点一下 = 给 agent 发一句**用户面中文意图**（onSendMessage），仍走「对话是唯一控制面」——不直调引擎、不 PUT。
 * 【用户面措辞铁律】一律说「补全/补充」，绝不出现「做厚 / enrichment」（纪律 2.6：那是内部叫法）。
 * 纯前端、确定性渲染；样式在 codex.css，作用域 .codex-app。
 */
import { useState } from "react";
import { COMMIT_PREVIEW_BUTTON_INTENT, QUALITY_BUTTON_INTENT, REVIEW_BUTTON_INTENT } from "../../../utils/chapterActionIntents.js";

export interface CapabilityAction {
  readonly key: string;
  readonly label: string;
  /** 点击后发给 agent 的中文意图（与各资料面板按钮 / story-agent 触发语一致）。 */
  readonly intent: string;
}

/** 收起时常驻露脸的高频能力（写作/补全/整理 各露一个代表，一眼看见最常用的）。 */
export const QUICK_ACTIONS: readonly CapabilityAction[] = [
  { key: "quality", label: "✓ 硬伤检查", intent: QUALITY_BUTTON_INTENT },
  { key: "char", label: "✦ 补全角色", intent: "帮我把现有角色补全一点" },
  { key: "rel", label: "⬡ 整理角色关系", intent: "从本书已有的硬事实，整理一遍真实出现的人物名单和他们之间的关系" },
];

/**
 * 「⋯ 更多」展开后的全部能力，按 写作 / 补全 / 整理 分组。
 * 写作辅助（内容审阅/检查机器腔/硬伤检查/定稿）也在上方 ChapterToolRail 按阶段提示——那是"当下该用啥"的流程向导，
 * 这里是"能用啥"的能力清单（随时可见），两者用途不同、可并存。
 */
export const CAPABILITY_GROUPS: readonly { readonly title: string; readonly actions: readonly CapabilityAction[] }[] = [
  {
    title: "写作",
    actions: [
      { key: "review", label: "◈ 内容审阅", intent: REVIEW_BUTTON_INTENT },
      { key: "deai", label: "✦ 检查机器腔", intent: "检查这一章的机器腔，把有机器腔的句子列出来" },
      { key: "quality", label: "✓ 硬伤检查", intent: QUALITY_BUTTON_INTENT },
      // 定稿按钮 = 定稿流程入口，确定性走预览（commit_preview）；预览卡再引导「确认定稿」走 commit_apply。
      { key: "commit", label: "↻ 定稿", intent: COMMIT_PREVIEW_BUTTON_INTENT },
    ],
  },
  {
    title: "补全",
    actions: [
      { key: "char", label: "✦ 补全角色", intent: "帮我把现有角色补全一点" },
      { key: "world", label: "✦ 补全世界观", intent: "帮我把世界观补全" },
      { key: "loc", label: "✦ 补全地点", intent: "帮我把地点补全" },
      { key: "asset", label: "✦ 补全道具与资源", intent: "帮我把道具与资源补全" },
      { key: "rules", label: "✦ 补全写作规则", intent: "帮我把写作规则补全、整理本书文风特点" },
    ],
  },

  {
    title: "整理",
    actions: [
      { key: "rel", label: "⬡ 整理角色关系", intent: "从本书已有的硬事实，整理一遍真实出现的人物名单和他们之间的关系" },
      { key: "clean", label: "◌ 清理废弃线索", intent: "把线索里没用的僵尸碎片清理一下" },
      { key: "merge", label: "⇉ 合并重复伏笔", intent: "把讲同一件事的重复伏笔合并成一条" },
    ],
  },
];

export function ChatCapabilityBar({ onSendMessage, disabled }: {
  readonly onSendMessage?: (content: string) => void;
  readonly disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (!onSendMessage) return null;

  const send = (intent: string): void => {
    if (disabled) return;
    onSendMessage(intent);
    setOpen(false);
  };

  return (
    <div className="cap-bar" role="group" aria-label="可用能力">
      <div className="cap-quick">
        {QUICK_ACTIONS.map((action) => (
          <button
            key={action.key}
            type="button"
            className="cap-btn"
            disabled={disabled}
            title={action.intent}
            onClick={() => send(action.intent)}
          >
            {action.label}
          </button>
        ))}
        <button
          type="button"
          className="cap-more"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? "收起" : "⋯ 更多"}
        </button>
      </div>
      {open ? (
        <div className="cap-panel">
          {CAPABILITY_GROUPS.map((group) => (
            <div key={group.title} className="cap-group">
              <span className="cap-group-title">{group.title}</span>
              <div className="cap-group-actions">
                {group.actions.map((action) => (
                  <button
                    key={action.key}
                    type="button"
                    className="cap-btn"
                    disabled={disabled}
                    title={action.intent}
                    onClick={() => send(action.intent)}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
