/**
 * 前端「真工作稿」判定（与 server/lib/project-io.ts 的 hasRealDraftContent 同口径，前端安全版·不引 server）。
 *
 * 写作台在「本章还没真正文」时显示一段引导占位（buildStateBackedDraftPlaceholder，以「还没有工作稿正文」/
 * 「还没有载入本章工作稿正文」开头；旧版「还没有草稿正文」/「还没有载入本章草稿正文」可能还在老书盘上）。
 * 这不是用户/AI 写的真稿。确定性只读按钮（质检/内容审阅）在占位稿上不应运行，
 * 否则会显示「质检完成」误导用户把占位当真稿（Kimi 真机 #4）。
 */
const EMPTY_DRAFT_PLACEHOLDER_PREFIXES = [
  "还没有工作稿正文",
  "还没有载入本章工作稿正文",
  "还没有草稿正文",
  "还没有载入本章草稿正文",
] as const;

/** 去空白后非空、且不是显示用空工作稿占位符 → 才算有真工作稿可质检/内容审阅。 */
export function isRealDraftContent(content: string | undefined): boolean {
  const body = (content ?? "").trim();
  if (!body) return false;
  return !EMPTY_DRAFT_PLACEHOLDER_PREFIXES.some((prefix) => body.startsWith(prefix));
}
