/**
 * 抽卡（阶段三块③）：「再来一版」出两版候选并排、挑中的换进工作稿。片 2D 收进操作执行器后整份删掉。
 * 改写、去 AI 味、按核账改是改稿操作（片 2C，见 hooks/useDraftEdits.ts、核账卡）。
 */
import { generateDraftCandidate, applyDraftCandidate } from "../api/client.js";
import { useBookStore } from "../stores/bookStore.js";
import { useChatStore } from "../stores/chatStore.js";
import { useUiStore, type DraftCandidate } from "../stores/uiStore.js";
import { useNavigationStore } from "../stores/navigationStore.js";
import { applyOverviewToWorkspace } from "../workspace/applyOverview.js";
import { flushDraftSave, refreshPaper } from "../drafts/draftSync.js";
import { isPaperCommitted } from "../drafts/useDraftPreview.js";
import { useDraftStore } from "../stores/draftStore.js";
import {
  beginWorkspaceOperation,
  finishWorkspaceOperation,
  isWorkspaceOperationCurrent,
  isWorkspaceOperationTargetCurrent,
  workspaceOperationTargetMatches,
  type WorkspaceOperationKind,
  type WorkspaceOperationToken,
} from "../utils/workspaceOperation.js";
import type { WorkspaceOperationTarget } from "../type-defs/workspace.js";

export interface UseWorkflowActionsParams {
  projectPath: string | null;
}

/**
 * 改稿类动作要读盘上的稿子：先把作者没存的字存掉（重构 P5）。
 * 存不上（网络 / 撞版本）就不动手，免得服务端按旧稿改、把作者的字盖掉。
 */
async function saveBeforeDraftAction(): Promise<string | null> {
  const flushed = await flushDraftSave();
  if (!flushed.ok) return `稿子还没存上（${flushed.error}），这次没有动手。`;
  // 撞了版本、盘上变了：作者眼前的字和盘上的不是一份，先选。（AI 候选、恢复稿不在工作稿里，不挡。）
  const cause = useDraftStore.getState().incoming?.cause;
  if (cause === "conflict" || cause === "update") return "稿纸上方有一条「稿子在别处改过」的提示，先选好用哪一版再来。";
  return null;
}

export function useWorkflowActions(params: UseWorkflowActionsParams) {
  const { projectPath } = params;

  const currentOperationIdentity = () => {
    const storeBook = useBookStore.getState();
    const storeChat = useChatStore.getState();
    return {
      projectPath: useNavigationStore.getState().projectPath ?? "",
      chapter: storeBook.workspace.currentChapter.chapterNumber,
      sessionId: storeChat.activeSessionId,
    };
  };

  const beginOwnedOperation = (kind: WorkspaceOperationKind): WorkspaceOperationToken | null => {
    if (!projectPath) return null;
    if (useNavigationStore.getState().projectPath !== projectPath) {
      useNavigationStore.getState().showToast("你切换了书，那个操作没有启动。", 4200);
      return null;
    }
    const token = beginWorkspaceOperation(kind, {
      projectPath,
      chapter: useBookStore.getState().workspace.currentChapter.chapterNumber,
      sessionId: useChatStore.getState().activeSessionId,
    });
    if (!token) {
      useNavigationStore.getState().showToast("已有写作操作正在进行，请等它结束后再试。", 4200);
    }
    return token;
  };

  const ownsCurrentWorkspace = (token: WorkspaceOperationToken): boolean =>
    isWorkspaceOperationTargetCurrent(token, currentOperationIdentity());

  const notifyStaleOperation = (): void => {
    useNavigationStore.getState().showToast("你切换了书，那次结果没有写进当前章节。", 5000);
  };

  const finishOwnedOperation = (token: WorkspaceOperationToken): void => {
    if (!isWorkspaceOperationCurrent(token)) return;
    if (ownsCurrentWorkspace(token)) {
      useUiStore.getState().setDraftActionLoading(null);
    }
    finishWorkspaceOperation(token);
  };

  /* -------------------------------------------------------------- */
  /*  抽卡（阶段三块③）：再来一版 → 生成 2 个临时候选并排 → 挑中落盘     */
  /*  候选 persist:false 不写盘不快照；挑中走 apply-candidate 写前快照=可撤销。*/
  /* -------------------------------------------------------------- */

  const handleRerollCandidates = async (): Promise<void> => {
    const nav = useNavigationStore.getState();
    const wsBook = useBookStore.getState();
    const wsUi = useUiStore.getState();
    if (!projectPath) {
      nav.showToast("请先打开本地项目。");
      return;
    }
    if (isPaperCommitted()) {
      nav.showToast("本章已定稿，正文只读；如需另写请通过 AI 助手发起修订。");
      return;
    }
    const chapter = wsBook.workspace.currentChapter.chapterNumber;
    const operation = beginOwnedOperation("reroll-candidates");
    if (!operation) return;
    wsUi.setDraftActionLoading("reroll-candidates");
    wsUi.setDraftCandidates(null);
    try {
      // 顺序生成 2 版候选（避免并发把模型代理打满）；每版同方向、靠模型温度产生差异。
      // 每版各自 try：某版失败不丢掉已成功的版（部分成功也展示，别白烧 token）。
      const candidates: { readonly body: string; readonly title?: string; readonly originTarget: WorkspaceOperationTarget }[] = [];
      let lastError: unknown;
      // 章纲一句话：不带方向 = 照本章已有章纲另写（作者给这章的方向在章纲里）；没有章纲才先拟一份，第二版沿用。
      let planNote: string | undefined;
      for (let index = 0; index < 2; index += 1) {
        try {
          const result = await generateDraftCandidate({ projectPath, chapter });
          planNote ??= result.planNote;
          if (!ownsCurrentWorkspace(operation)) {
            notifyStaleOperation();
            return;
          }
          if (result.draftBody.trim()) candidates.push({ body: result.draftBody, ...(result.draftTitle ? { title: result.draftTitle } : {}), originTarget: operation });
        } catch (error) {
          lastError = error;
        }
      }
      if (candidates.length === 0) {
        nav.showToast(`再来一版失败：${lastError instanceof Error ? lastError.message : "候选生成失败，请重试。"}`, 5000);
        return;
      }
      useUiStore.getState().setDraftCandidates(candidates);
      if (candidates.length < 2) {
        nav.showToast(`只生成出 ${candidates.length} 版候选（另一版生成失败），可先看这版或再试一次。`);
      } else if (planNote) {
        nav.showToast(planNote, 6000);
      }
    } finally {
      finishOwnedOperation(operation);
    }
  };

  const handleApplyCandidate = async (picked: DraftCandidate): Promise<void> => {
    const nav = useNavigationStore.getState();
    const wsUi = useUiStore.getState();
    if (!projectPath || !picked.body.trim()) {
      nav.showToast("没有可应用的候选。");
      return;
    }
    const candidate = wsUi.draftCandidates?.find((item) => item === picked);
    if (!candidate?.originTarget) {
      nav.showToast("这份候选稿缺少工作区归属，已拒绝应用。", 5000);
      return;
    }
    if (!workspaceOperationTargetMatches(candidate.originTarget, currentOperationIdentity())) {
      nav.showToast("这份候选稿来自切换前的那本书，不能应用到当前章节。", 5000);
      return;
    }
    const operation = beginOwnedOperation("apply-candidate");
    if (!operation) return;
    const chapter = operation.chapter;
    wsUi.setDraftActionLoading("apply-candidate");
    try {
      const blocked = await saveBeforeDraftAction();
      if (blocked) throw new Error(blocked);
      // 带作者眼前那份的版本：存完之后稿子又变了（AI、撤销）就不换，免得盖掉。换上的是整份稿：候选没章名就用作者眼前的
      // （刚存上，和这个版本号说的是同一份）。
      const paper = useDraftStore.getState();
      const result = await applyDraftCandidate({ projectPath, chapter, title: candidate.title ?? paper.title, body: candidate.body, baseVersion: paper.baseVersion });
      if (!ownsCurrentWorkspace(operation)) {
        notifyStaleOperation();
        return;
      }
      applyOverviewToWorkspace(result.overview, { flowStatus: "draft_ready" });
      await refreshPaper();
      useUiStore.getState().setDraftCandidates(null);
      nav.showToast("已用这版替换工作稿，可在「操作历史」撤销。");
    } catch (error) {
      if (!ownsCurrentWorkspace(operation)) {
        notifyStaleOperation();
        return;
      }
      nav.showToast(`选用候选失败：${error instanceof Error ? error.message : String(error)}`, 5000);
    } finally {
      finishOwnedOperation(operation);
    }
  };

  const handleCloseCandidates = (): void => {
    useUiStore.getState().setDraftCandidates(null);
  };

  return {
    handleRerollCandidates,
    handleApplyCandidate,
    handleCloseCandidates,
  } as const;
}
