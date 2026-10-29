/**
 * 改稿按钮（写作版本 P2a 片 2C）：稿纸上选中文字改写、AI 味卡「改掉这句 / 一键全修」都交 draft.change 的改稿操作、进对话一轮，
 * 操作卡跟着走——改写先出改前改后、作者点「换上」才换；去 AI 味直接改。换前都存档、可撤销。核账卡的「改这处」自己出动作。
 * 改的是盘上那份：这一轮开头先存作者没存的字；稿纸上挂着「稿子在别处改过」的提示（眼前的和盘上的不是一份）就先不交。
 */
import { EDIT_MAX_TEXT, EDIT_MAX_VIOLATIONS, newEditAction, type AgentUserAction } from "../api/agentChatClient.js";
import { SELECTION_REVISION_TEMPLATES, selectionEditGoal, type SelectionRevisionKey } from "../components/v2/selectionRevisionTemplates.js";
import { isPaperCommitted } from "../drafts/useDraftPreview.js";
import { useDraftStore } from "../stores/draftStore.js";
import { useNavigationStore } from "../stores/navigationStore.js";
import { useUiStore } from "../stores/uiStore.js";
import type { AiFlavorViolation } from "../type-defs/workspace.js";
import { clearAiFlavorFixing } from "../workspace/draftEditOutcome.js";

type SendUserAction = (action: AgentUserAction, options?: { readonly echo?: string }) => Promise<void>;

/** 回显里引一句原文：太长的截短。 */
const quoted = (text: string): string => {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > 40 ? `「${flat.slice(0, 40)}…」` : `「${flat}」`;
};

/** 能改稿纸开着的这章就给章号，不能就说清为什么、给 undefined。 */
function editableChapter(): number | undefined {
  const toast = useNavigationStore.getState().showToast;
  const paper = useDraftStore.getState();
  if (!paper.loaded || paper.chapter <= 0) {
    toast("请先打开一章。");
    return undefined;
  }
  if (isPaperCommitted()) {
    toast("本章已定稿，正文只读；要改请在对话里说。");
    return undefined;
  }
  const cause = paper.incoming?.cause;
  if (cause === "conflict" || cause === "update") {
    toast("稿纸上方有一条「稿子在别处改过」的提示，先选好用哪一版再来。", 4200);
    return undefined;
  }
  return paper.chapter;
}

export function useDraftEdits({ sendUserAction }: { readonly sendUserAction: SendUserAction }) {
  const rewrite = async (selectionText: string, key: SelectionRevisionKey, extraGoal?: string): Promise<void> => {
    const toast = useNavigationStore.getState().showToast;
    if (!selectionText.trim()) {
      toast("请先在正文里选中一段文字。");
      return;
    }
    if (selectionText.length > EDIT_MAX_TEXT) {
      toast(`选的太长了：一次最多改 ${EDIT_MAX_TEXT} 字，分几段选。`, 4200);
      return;
    }
    const goal = selectionEditGoal(key, extraGoal);
    const chapter = editableChapter();
    if (!goal || chapter === undefined) return;
    const label = key === "custom" ? "改" : SELECTION_REVISION_TEMPLATES.find((item) => item.key === key)?.label ?? "改";
    await sendUserAction(
      newEditAction({ mode: "revise", chapter, edits: [{ targetText: selectionText, revisionGoal: goal }], preview: true, ...(key === "deai" ? { style: "deai" as const } : {}) }),
      { echo: key === "custom" && extraGoal ? `改第 ${chapter} 章这段（${extraGoal.trim()}）：${quoted(selectionText)}` : `${label}第 ${chapter} 章这段：${quoted(selectionText)}` },
    );
  };

  /** 浮动操作条上的几个模板（润色 / 改写 / 去机器腔 / 扩写 / 缩写 / 续写）。 */
  const handleSelectionRewrite = (selectionText: string, key: SelectionRevisionKey): Promise<void> => rewrite(selectionText, key);

  /** 「✎ 自己说」：作者的要求拼进改法。 */
  const handleSelectionRewriteCustom = (selectionText: string, instruction: string): Promise<void> => rewrite(selectionText, "custom", instruction);

  const deai = (violations: readonly AiFlavorViolation[], messageId: string, single: boolean): void => {
    const toast = useNavigationStore.getState().showToast;
    if (violations.length === 0) {
      toast("没有要改的机器腔。");
      return;
    }
    const chapter = editableChapter();
    if (chapter === undefined) return;
    // 一次最多改这么多句（超了服务端整个不收）：先改前面的，剩下的还在卡上。
    const picked = violations.slice(0, EDIT_MAX_VIOLATIONS);
    const ui = useUiStore.getState();
    if (single) ui.setAiFlavorPending({ messageId, violationId: picked[0]!.id });
    else ui.setAiFlavorBatchPending(messageId);
    // 这一轮完了（改好了、没改成、被挡下没交上）卡上的「改写中…」都收起；改掉了哪几句在这一轮里已经标上了。
    void sendUserAction(newEditAction({
      mode: "deai",
      chapter,
      violations: picked.map((item) => ({
        id: item.id,
        text: item.text,
        ...(item.reason ? { reason: item.reason } : {}),
        severity: item.severity,
        ...(item.suggestedFix ? { suggestedFix: item.suggestedFix } : {}),
      })),
    })).finally(clearAiFlavorFixing);
  };

  /** AI 味卡「改掉这句」：只改这一句，直接改、可撤销。 */
  const handleFixAiFlavorViolation = (violation: AiFlavorViolation, messageId: string): void => deai([violation], messageId, true);

  /** AI 味卡「一键全修」：卡上还没改的几句一次改。 */
  const handleFixAiFlavorAll = (violations: readonly AiFlavorViolation[], messageId: string): void => deai(violations, messageId, false);

  return { handleSelectionRewrite, handleSelectionRewriteCustom, handleFixAiFlavorViolation, handleFixAiFlavorAll } as const;
}
