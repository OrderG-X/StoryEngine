/**
 * ChatCapabilityBar —— 聊天区（右栏·唯一控制面）输入框上方的「能力快捷条」。
 *
 * 治「这么多能力用户不知道能用」：写作流程那几个工具已由 ChapterToolRail 按阶段列出；这里补上
 * **散的、非阶段性的资料/整理能力**（补全人物/故事设定/地点/物品/写作规则、整理关系/理线索/合并伏笔）——
 * 它们此前只散落在各资料面板按钮里、用户在聊天时看不见。高频几个常驻露脸，点「⋯ 更多」展开全部。
 *
 * 点一下：带 `button` 的是固定动作，直接发结构化动作（onChapterButton，重构 P4）；其余给 AI 发一句用户面中文（onSendMessage）。
 * 【用户面措辞铁律】一律说「补全/补充」，绝不出现「做厚 / enrichment」（纪律 2.6：那是内部叫法）。
 * 纯前端、确定性渲染；样式在 codex.css，作用域 .codex-app。
 */
import { useState } from "react";
import type { ChapterButton } from "../../../utils/chapterButtons.js";

export interface CapabilityAction {
  readonly key: string;
  readonly label: string;
  /** 不带 button 时：点击后发给 AI 的一句话（与各资料面板按钮 / story-agent 触发语一致）。带 button 时只做悬停提示。 */
  readonly intent: string;
  /** 固定动作：点了直接发结构化动作，不经模型。 */
  readonly button?: ChapterButton;
}

const CONTINUITY: CapabilityAction = { key: "continuity", label: "核账", intent: "拿这一章对一遍前文，看有没有前后对不上的地方", button: "continuity" };

/** 收起时常驻露脸的高频能力（写作/补全/整理 各露一个代表，一眼看见最常用的）。 */
export const QUICK_ACTIONS: readonly CapabilityAction[] = [
  CONTINUITY,
  { key: "char", label: "补全人物", intent: "帮我把人物卡补全一点：只补空着的，按正文里写过的来" },
  { key: "rel", label: "整理人物关系", intent: "按正文里写过的，把人物之间的关系记进设定本" },
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
      CONTINUITY,
      { key: "review", label: "内容审阅", intent: "审阅这一章的内容，给评分和改进建议", button: "review" },
      { key: "deai", label: "检查机器腔", intent: "检查这一章的机器腔，把有机器腔的句子列出来" },
      { key: "quality", label: "硬伤检查", intent: "对这一章做硬伤检查，列出硬伤", button: "quality" },
      // 定稿按钮 = 交一次定稿：先出定稿清单；清单上的「确认定稿」才真定稿。
      { key: "commit", label: "定稿", intent: "定稿这一章", button: "commit" },
    ],
  },
  {
    title: "补全",
    actions: [
      { key: "char", label: "补全人物", intent: "帮我把人物卡补全一点：只补空着的，按正文里写过的来" },
      { key: "uncard", label: "给没建卡的建卡", intent: "把账里出场过、还没建卡的人物建成卡，按正文里写过的填" },
      { key: "world", label: "补全故事设定", intent: "帮我把故事设定补全一点：只补空着的" },
      { key: "loc", label: "补全地点", intent: "帮我把地点卡补全一点：只补空着的，按正文里写过的来" },
      { key: "asset", label: "补全物品", intent: "帮我把物品卡补全一点：只补空着的，按正文里写过的来" },
      { key: "rules", label: "补全写作规则", intent: "帮我把写作规则补全、整理本书文风特点" },
    ],
  },

  {
    title: "整理",
    actions: [
      { key: "rel", label: "整理人物关系", intent: "按正文里写过的，把人物之间的关系记进设定本" },
      { key: "tidy", label: "理一遍线索", intent: "把开着的线索理一遍，看看哪些其实已经收了" },
      { key: "merge", label: "归并线索", intent: "把讲同一件事的重复线索归并成一条" },
    ],
  },
];

/** 按 key 取能力（找不到返回 undefined）。 */
export function capabilityByKey(key: string): CapabilityAction | undefined {
  for (const group of CAPABILITY_GROUPS) {
    const hit = group.actions.find((action) => action.key === key);
    if (hit) return hit;
  }
  return undefined;
}

const UNDO_LAST: CapabilityAction = { key: "undo", label: "撤销上一步", intent: "撤销上一步", button: "undo" };

/**
 * 不在写作台时，快捷条最前面换成跟当前页有关的能力（设定本按分类、历史给「撤销上一步」）；
 * 写作台返回 null（照旧按本章进度给写作工具）。时间线没有专门能力，也返回 null。
 */
export function contextActionsForView(view: "desk" | "library" | "history", cat: string): readonly CapabilityAction[] | null {
  if (view === "history") return [UNDO_LAST];
  if (view !== "library") return null;
  const keysByCat: Record<string, readonly string[]> = {
    story: ["world"],
    rules: ["rules"],
    chars: ["char", "rel"],
    relations: ["rel"],
    items: ["asset"],
    places: ["loc"],
    uncarded: ["uncard"],
    hooks: ["tidy", "merge"],
  };
  const keys = keysByCat[cat];
  if (!keys) return null;
  return keys.map(capabilityByKey).filter((action): action is CapabilityAction => Boolean(action));
}

export function ChatCapabilityBar({ onSendMessage, onChapterButton, disabled, leading = [], leadingOnly = false, variant = "bar" }: {
  readonly onSendMessage?: (content: string) => void;
  /** 固定动作按钮（带 button 的）点了走这里：直接发结构化动作。 */
  readonly onChapterButton?: (button: ChapterButton) => void;
  readonly disabled?: boolean;
  /** true：只放 leading（设定本/历史里不再拿写作工具凑满一排），其余进「更多」。 */
  readonly leadingOnly?: boolean;
  /** 按本章进度派生的工具（ChapterToolRail.railActionsForFlow）：排在最前、第一个高亮；常驻快捷里同 key 的去重。 */
  readonly leading?: readonly CapabilityAction[];
  /** menu（重构 P6 写作台）：只出一个「更多」小按钮放在输入框左边，点开在上方弹出全部能力；不占一整条。 */
  readonly variant?: "bar" | "menu";
}) {
  const [open, setOpen] = useState(false);
  if (!onSendMessage) return null;

  const send = (action: CapabilityAction): void => {
    if (disabled) return;
    if (action.button && onChapterButton) onChapterButton(action.button);
    else onSendMessage(action.intent);
    setOpen(false);
  };

  const panel = (
    <div className={`cap-panel${variant === "menu" ? " is-pop" : ""}`}>
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
                onClick={() => send(action)}
              >
                {action.label}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );

  if (variant === "menu") {
    return (
      <div className="cap-menu">
        <button
          type="button"
          className="cap-menu-btn"
          aria-expanded={open}
          aria-label="更多能力"
          title="内容审阅、检查机器腔、补资料、整理线索……"
          onClick={() => setOpen((value) => !value)}
        >
          {open ? "收起" : "更多"}
        </button>
        {open ? panel : null}
      </div>
    );
  }

  return (
    <div className="cap-bar" role="group" aria-label="可用能力">
      <div className="cap-quick">
        {leading.map((action, index) => (
          <button
            key={`lead-${action.key}`}
            type="button"
            className={`cap-btn${index === 0 ? " is-lead" : ""}`}
            disabled={disabled}
            title={action.intent}
            onClick={() => send(action)}
          >
            {action.label}
          </button>
        ))}
        {/* 一排最多放 3 个常用（本章进度工具优先），其余进「更多」：窄栏里也不折成两行。 */}
        {(leadingOnly ? [] : QUICK_ACTIONS).filter((action) => !leading.some((lead) => lead.key === action.key)).slice(0, Math.max(0, 3 - leading.length)).map((action) => (
          <button
            key={action.key}
            type="button"
            className="cap-btn"
            disabled={disabled}
            title={action.intent}
            onClick={() => send(action)}
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
          {open ? "收起" : "更多"}
        </button>
      </div>
      {open ? panel : null}
    </div>
  );
}
