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
