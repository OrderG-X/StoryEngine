/**
 * 新书首屏引导（P1-5）：空书落写作台 + 稿纸空态三意图。
 * 纯函数，便于单测。点了把半句话填进右侧输入框、光标放句末，作者接着打完再发（不直接发）：
 * 2026-10-22 好上手走查——直接发「我有一个点子」，AI 只能反问「说说你的点子」，白等一轮。
 *
 * 「空」= 没有真正文（占位引导稿不算）+ 没有已定稿章。新建书会种占位 draft .md，
 * 必须走 isRealDraftContent，不能只看 wordCount / 非空 trim。
 */
import { isRealDraftContent } from "../../../utils/draftContent.js";

export interface StarterIntent {
  readonly key: string;
  readonly label: string;
  /** 点击后填进右侧输入框的半句话（不发送），作者接着写。 */
  readonly prefill: string;
}

/** 稿纸空态三个起步意图。 */
export const STARTER_INTENTS: readonly StarterIntent[] = [
  { key: "idea", label: "我有一个点子", prefill: "我有一个点子：" },
  { key: "protagonist", label: "帮我理主角", prefill: "帮我理一理主角。我想的主角是：" },
  { key: "opening", label: "直接写开头", prefill: "帮我写第一章的开头。故事大概是：" },
];

/**
 * 开书三步（2026-10-23 从零走查）：首屏把「说说故事 → 第一章往哪走 → 写」摆出来，跟着真数据打勾。
 * 走查时作者跟 AI 聊完、人物卡都建好了，首屏还是那句「从一句话开始」，看不出下一步该干什么。
 * 只看设定本有没有卡、故事设定填没填（作者自己写的、AI 补的都算），不看聊天说了什么。
 * 第二步做完（出了走法）引导就收起、走法挂在稿纸上方，所以这里只有前一步会打勾。
 */
export interface StarterStep {
  readonly key: "story" | "directions" | "write";
  readonly label: string;
  readonly hint: string;
  readonly done: boolean;
}

/** 设定本里显示几个名字，多的说「等 N 个」。 */
const STARTER_NAMES_SHOWN = 3;

export function starterSteps(input: {
  readonly chapter: number;
  /** 设定本里的卡名（人物、地方、东西、设定）。 */
  readonly cardNames: readonly string[];
  /** 故事设定那页（题材、年代……）填了没有。 */
  readonly storyFilled: boolean;
}): readonly StarterStep[] {
  const names = input.cardNames.filter((name) => name.trim());
  const storyHint = names.length > 0
    ? `设定本里有了：${names.slice(0, STARTER_NAMES_SHOWN).join("、")}${names.length > STARTER_NAMES_SHOWN ? ` 等 ${names.length} 个` : ""}`
    : input.storyFilled ? "设定本里有了故事设定" : "跟 AI 聊聊点子，它把人物、世界记进设定本";
  return [
    { key: "story", label: "说说故事", hint: storyHint, done: names.length > 0 || input.storyFilled },
    { key: "directions", label: input.chapter === 1 ? "第一章往哪走" : `第 ${input.chapter} 章往哪走`, hint: "AI 给几种走法挑，也能跳过", done: false },
    { key: "write", label: "写", hint: "自己写或让 AI 起草，写完核账、定稿", done: false },
  ];
}

export interface StarterWorkspaceProbe {
  readonly draft: { readonly content: string; readonly wordCount?: number };
  readonly chapters: readonly {
    readonly hasDraftFile?: boolean;
    readonly hasCommittedChapter?: boolean;
    readonly status?: string;
  }[];
}

/**
 * 无真正文 / 无正式章节 → 视为「空书首屏」。
 * 占位引导稿（「还没有草稿正文…」）不算真正文；有任一 hasDraftFile（真稿）或已定稿章 → 不再显示引导。
 */
export function isStarterEmptyWorkspace(workspace: StarterWorkspaceProbe): boolean {
  if (isRealDraftContent(workspace.draft.content)) return false;
  // 章节列表有几条路径只带 status、不带文件标记（2026-10-11 真机验收：7 章的书刷新后点「下一章」，
  // 第 8 章空稿纸冒出新书引导）——列表里标了已定稿的也算动过。
  return !workspace.chapters.some(
    (chapter) => chapter.hasDraftFile === true || chapter.hasCommittedChapter === true || chapter.status === "committed",
  );
}

/**
 * 打开一本书默认落写作台：空书看起步引导，有稿的书接着写（书架上点的是「继续写」）。
 * 2026-10-07 改版前非空书落资料中心——和顶栏「写作」在首位、书架「继续写」的预期对不上，改成一律写作台。
 */
export function defaultCenterViewForWorkspace(): "library" | "desk" {
  return "desk";
}
