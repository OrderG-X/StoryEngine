import type { StateOverview } from "../api/types.js";

/**
 * 判断 overview 是否代表「刚建好、还没动过的空书」。
 *
 * 空书 = 用户还没真正开始写：没有章节、只有占位主角（或没有角色）、没有草稿/已提交章节。
 * 只读现成 StateOverview 字段，不依赖新增引擎数据。
 *
 * 【为什么不看 threads/arcGoals 计数】（V4 真机失败的教训）：
 * 历史上建书会种 1 个 status:"active" 的 arc-goal（也可能种伏笔），那是**建书噪声、不代表用户干了活**，
 * 旧实现据此判「非空书」→ reopen 落到章节语气。该种子来源已随极简空建退役（建书不再种 arc-goal/伏笔），
 * 但本函数仍只认「用户已开始写」的可靠信号、不看这些计数，以兼容历史/异常项目，避免误判。
 * 真正反映「用户已开始写」的可靠信号只有：有章节（currentChapter 非 null）、有草稿/已提交章节、角色多于占位主角。
 * 另外：用户若真聊过（建了角色/世界），会留下真实历史会话，selectOpenProjectMessages 在 isFreshBook 之前的
 * 「genuine session」分支已会拦截——所以 isFreshBook 只需判「从没聊过的书」，可放心忽略建书噪声计数。
 *
 * 安全原则：currentChapter 必须明确为 null、characters 必须为数组，否则（结构异常/老接口）保守判「非空书」，
 * 宁可走章节语气，也绝不把开书开场白误注入到已有内容的书上。
 */
export function isFreshBook(overview: StateOverview | null | undefined): boolean {
  if (!overview) return false;

  // 必须明确为 null（无章节）。number 或字段缺失都算「不是空书」。
  if (overview.project?.currentChapter !== null) return false;

  // 角色：空书只有占位主角（或暂无角色）。缺 characters 块/非数组 → 非空书。
  const knownCharacters = overview.characters?.knownCharacters;
  if (!Array.isArray(knownCharacters)) return false;
  if (knownCharacters.length > 1) return false;

  // 草稿/已提交章节：有任一草稿或已提交章节即「动过」→ 非空书。无 uiChapterFiles 视作「未动」。
  const hasWrittenChapter = overview.uiChapterFiles?.some(
    (file) => file.hasDraftFile === true || file.hasCommittedChapter === true,
  ) ?? false;
  if (hasWrittenChapter) return false;

  return true;
}
