import {
  previewDraftRevision,
  applyDraftRevision,
  DraftRevisionRefused,
  applyDeAiFlavorBatch,
  generateDraftCandidate,
  applyDraftCandidate,
} from "../api/client.js";
import type {
  DraftAIReviewIssue,
  DraftAIRevisionSuggestion,
  DraftRevisionTask,
  ChapterAgentCard,
} from "../api/types.js";
import { useBookStore } from "../stores/bookStore.js";
import { useChatStore } from "../stores/chatStore.js";
import { useUiStore, type DraftCandidate } from "../stores/uiStore.js";
import { useNavigationStore } from "../stores/navigationStore.js";
import type { ChapterMessage } from "../types.js";
import { compactStrings, cleanUiText } from "../utils/textUtils.js";
import { applyOverviewToWorkspace } from "../workspace/applyOverview.js";
import { flushDraftSave, refreshPaper } from "../drafts/draftSync.js";
import { currentPaperText, isPaperCommitted } from "../drafts/useDraftPreview.js";
import { useDraftStore } from "../stores/draftStore.js";
import {
  SELECTION_REVISION_TEMPLATES,
  buildSelectionRevisionTask,
  isNoOpRevisionPreview,
  type SelectionRevisionKey,
} from "../components/v2/selectionRevisionTemplates.js";
import { isRevisionZeroDiff } from "../components/v2/codex/revisionZeroDiff.js";
import { suggestedAction } from "../utils/workflowHelpers.js";
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

/* ------------------------------------------------------------------ */
/*  File-scope helpers (extracted from App.tsx)                        */
/* ------------------------------------------------------------------ */

function completedAgentCard(input: {
  readonly id: string;
  readonly kind: ChapterAgentCard["kind"];
  readonly agentName: string;
  readonly title: string;
  readonly summary: string;
  readonly detail?: readonly string[];
  readonly status?: ChapterAgentCard["status"];
}): ChapterAgentCard {
  return {
    id: input.id,
    kind: input.kind,
    agentName: input.agentName,
    status: input.status ?? "completed",
    title: input.title,
    summary: input.summary,
    ...(input.detail?.length ? { detail: input.detail } : {}),
  };
}

/**
 * 修订类型只看审稿结果里的结构化类目（重构 P4）：不再拿正则去猜建议文字里的「开头/结尾/对话」。
 * 类目对不上的一律按通用修订（段落）。
 */
function revisionTargetTypeFromCategory(category: DraftAIReviewIssue["category"] | undefined): DraftRevisionTask["targetType"] {
  if (category === "reader_hook") return "ending";
  if (category === "dialogue") return "dialogue";
  if (category === "pacing") return "section";
  return "paragraph";
}

function draftParagraphs(draftContent: string): string[] {
  return draftContent
    .split(/\n{2,}/u)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0 && !/^#\s*/u.test(paragraph)); // 章名行白名单：定位
}

function findExactOrContainingParagraph(draftContent: string, needle: string): string | null {
  const normalizedNeedle = needle.trim();
  if (!normalizedNeedle) return null;
  if (draftContent.includes(normalizedNeedle)) return normalizedNeedle;
  const paragraphs = draftParagraphs(draftContent);
  const compactNeedle = normalizedNeedle.replace(/\s+/g, "");
  return paragraphs.find((paragraph) => paragraph.replace(/\s+/g, "").includes(compactNeedle)) ?? null;
}

function resolveRevisionTarget(
  source: { readonly issue?: DraftAIReviewIssue; readonly suggestion?: DraftAIRevisionSuggestion },
  draftContent: string,
): { readonly targetText: string; readonly targetType: DraftRevisionTask["targetType"]; readonly guessed: boolean } | null {
  const sourceTexts = [
    source.issue?.evidence,
    source.issue?.affectedParagraphHint,
    source.suggestion?.target,
  ].filter((item): item is string => Boolean(item?.trim()));
  const targetType = revisionTargetTypeFromCategory(source.issue?.category);
  for (const candidate of sourceTexts) {
    const exact = findExactOrContainingParagraph(draftContent, candidate);
    if (exact) return { targetText: exact, targetType, guessed: false };
  }
  // B5：找不到原句 → 退一段给作者核对（标 guessed=true，调用方明确提示「是猜的」，绝不静默当精确目标）。
  // 只按结构化类目选：追读钩子取最后一段，其余取第一段；不按建议文字猜。
  const paragraphs = draftParagraphs(draftContent);
  const fallback = source.issue?.category === "reader_hook" ? paragraphs.at(-1) : paragraphs[0];
  return fallback ? { targetText: fallback, targetType, guessed: true } : null;
}

function revisionIssueConstraints(issue?: DraftAIReviewIssue): readonly string[] {
  if (!issue) return [];
  const description = cleanUiText(issue.description);
  const evidence = cleanUiText(issue.evidence);
  return compactStrings([
    description ? `问题说明：${description.slice(0, 220)}` : undefined,
    evidence ? `内容审阅证据：${evidence.slice(0, 260)}` : undefined,
  ]);
}

/* ------------------------------------------------------------------ */
/*  Hook interface                                                     */
/* ------------------------------------------------------------------ */

export interface UseWorkflowActionsParams {
  projectPath: string | null;
  appendMessage: (message: ChapterMessage) => void;
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

/* ------------------------------------------------------------------ */
/*  Hook implementation                                                */
/* ------------------------------------------------------------------ */

export function useWorkflowActions(params: UseWorkflowActionsParams) {
  const { projectPath, appendMessage } = params;

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

  const startAgentFlow = (input: {
    readonly messageId: string;
    readonly kind: ChapterAgentCard["kind"];
    readonly agentName: string;
    readonly title: string;
    readonly summary: string;
    readonly detail?: readonly string[];
  }): string => {
    appendMessage({
      id: input.messageId,
      role: "system",
      content: `${input.title}。`,
      agentCards: [completedAgentCard({
        id: input.messageId.replace(/^assistant-/u, "agent-"),
        kind: input.kind,
        agentName: input.agentName,
        status: "running",
        title: input.title,
        summary: input.summary,
        detail: input.detail,
      })],
    });
    return input.messageId;
  };

  const updateAgentFlow = (messageId: string, input: {
    readonly role?: ChapterMessage["role"];
    readonly content: string;
    readonly card: ChapterAgentCard;
    readonly suggestedActions?: ChapterMessage["suggestedActions"];
    readonly toolOutput?: readonly string[];
  }): void => {
    useChatStore.getState().updateMessage(messageId, (current) => ({
      ...current,
      role: input.role ?? current.role,
      content: input.content,
      agentCards: [input.card],
      ...(input.suggestedActions ? { suggestedActions: input.suggestedActions } : {}),
      ...(input.toolOutput ? { toolOutput: input.toolOutput } : {}),
    }));
  };

  const failAgentFlow = (messageId: string, input: {
    readonly kind: ChapterAgentCard["kind"];
    readonly agentName: string;
    readonly title: string;
    readonly error: unknown;
  }): void => {
    const message = input.error instanceof Error ? input.error.message : String(input.error);
    updateAgentFlow(messageId, {
      content: `${input.title}失败：${message}`,
      card: completedAgentCard({
        id: messageId.replace(/^assistant-/u, "agent-"),
        kind: input.kind,
        agentName: input.agentName,
        status: "failed",
        title: `${input.title}失败`,
        summary: message,
      }),
    });
  };

  /* -------------------------------------------------------------- */
  /*  handleGenerateRevisionPreview  (App.tsx 1258-1292)            */
  /*  须排在 handleCreateRevisionTask 之前：创建任务后会立刻 fire-and-  */
  /*  forget 调本函数，靠声明顺序避免 const 暂死区。                    */
  /* -------------------------------------------------------------- */

  const handleGenerateRevisionPreview = async (): Promise<void> => {
    const nav = useNavigationStore.getState();
    const wsUi = useUiStore.getState();

    if (!projectPath || !wsUi.activeRevisionTask) {
      nav.showToast("请先创建修订任务。");
      return;
    }

    const operation = beginOwnedOperation("revision-preview");
    if (!operation) return;
    wsUi.setDraftActionLoading("revision-preview");
    const messageId = startAgentFlow({
      messageId: `assistant-revision-preview-progress-${Date.now()}`,
      kind: "revision",
      agentName: "revisionAgent",
      title: "修订 Agent 运行中",
      summary: "正在定位原文片段，并生成局部修订草案。",
      detail: ["定位原文中", "生成修订草案中"],
    });
    try {
      const blocked = await saveBeforeDraftAction();
      if (blocked) throw new Error(blocked);
      const result = await previewDraftRevision({
        projectPath,
        chapter: operation.chapter,
        task: wsUi.activeRevisionTask,
      });
      if (!ownsCurrentWorkspace(operation)) {
        notifyStaleOperation();
        return;
      }
      const sUi = useUiStore.getState();
      sUi.setActiveRevisionTask(result.task);
      sUi.setActiveRevisionPreview({ ...result.preview, originTarget: operation });
      updateAgentFlow(messageId, {
        role: "assistant",
        content: "修订草案已生成。请查看原文 / 修订后的对比；确认后才会应用到工作稿。",
        card: completedAgentCard({
          id: messageId.replace(/^assistant-/u, "agent-"),
          kind: "revision",
          agentName: "revisionAgent",
          status: "needs_confirmation",
          title: "修订草案已生成",
          summary: result.preview.changeSummary,
          detail: [
            `风险提醒：${result.preview.riskNotes.length + result.preview.warnings.length}`,
            "等待确认后才应用到工作稿",
          ],
        }),
        suggestedActions: [{
          id: "revision-apply",
          label: "应用到工作稿",
          description: "只替换工作稿中的对应片段，不写已定稿版。",
          permission: "draft_write",
          requiresConfirmation: true,
          endpoint: "/api/draft/revision/apply",
        }],
      });
    } catch (error) {
      if (!ownsCurrentWorkspace(operation)) {
        notifyStaleOperation();
        return;
      }
      failAgentFlow(messageId, {
        kind: "revision",
        agentName: "revisionAgent",
        title: "修订 Agent",
        error,
      });
      useChatStore.getState().setChatError(error instanceof Error ? error.message : String(error));
    } finally {
      finishOwnedOperation(operation);
    }
  };

  /* -------------------------------------------------------------- */
  /*  handleCreateRevisionTask  (App.tsx 1212-1256)                 */
  /* -------------------------------------------------------------- */

  const handleCreateRevisionTask = (source: { readonly issue?: DraftAIReviewIssue; readonly suggestion?: DraftAIRevisionSuggestion }): void => {
    const wsBook = useBookStore.getState();
    const nav = useNavigationStore.getState();

    const paperText = currentPaperText();
    if (!paperText.trim()) {
      nav.showToast("当前没有可修订的工作稿。");
      return;
    }
    const target = resolveRevisionTarget(source, paperText);
    if (!target) {
      nav.showToast("无法自动定位原文片段。请先在内容审阅建议中选择更具体的问题，或把要修的段落发给我。", 4200);
      return;
    }
    if (target.guessed) {
      // B5：没精确定位到原句、按类目猜了一段——明确提示用户核对，不静默改错段。
      nav.showToast("没能精确定位到要修的原句，已按猜测选了一段。请在下方预览里核对是不是这段，不是就把原句发给我重定位。", 4600);
    }

    const task: DraftRevisionTask = {
      id: `revision-${Date.now().toString(36)}`,
      ...(source.issue ? { sourceIssueId: source.issue.id } : {}),
      ...(source.suggestion ? { sourceSuggestionId: source.suggestion.id } : {}),
      chapter: wsBook.workspace.currentChapter.chapterNumber,
      targetType: target.targetType,
      targetText: target.targetText,
      problemSummary: source.issue?.title ?? source.suggestion?.target ?? "局部修订",
      revisionGoal: source.issue?.suggestedFix ?? source.suggestion?.suggestion ?? "根据内容审阅建议优化当前片段。",
      constraints: [
        "只修改选中的原文片段，不重写全文。",
        "不改变本章核心事件。",
        "不提前揭开隐藏真相。",
        "不新增未登记关键道具或地点。",
        ...revisionIssueConstraints(source.issue),
      ],
      status: "pending",
    };

    const sUi = useUiStore.getState();
    sUi.setActiveRevisionTask(task);
    sUi.setActiveRevisionPreview(null);
    appendMessage({
      id: `assistant-revision-task-${Date.now()}`,
      role: "assistant",
      content: "已创建修订任务，正在生成修订草案…可在写作台下方的预览弹窗查看对比",
      agentCards: [completedAgentCard({
        id: "agent-revision-task",
        kind: "revision",
        agentName: "revisionAgent",
        status: "needs_confirmation",
        title: "修订任务已准备",
        summary: task.problemSummary,
        detail: [
          `目标类型：${task.targetType}`,
          `修订目标：${task.revisionGoal}`,
          "正在生成修订草案，不直接写入",
        ],
      })],
    });
    // 对齐选区改写：创建任务后立刻触发生成，避免弹窗卡在假 loading 死路。
    void handleGenerateRevisionPreview();
  };

  /* -------------------------------------------------------------- */
  /*  handleApplyRevisionPreview  (App.tsx 1294-1321)               */
  /* -------------------------------------------------------------- */

  const handleApplyRevisionPreview = async (): Promise<void> => {
    const nav = useNavigationStore.getState();
    const wsUi = useUiStore.getState();

    if (!projectPath || !wsUi.activeRevisionPreview) {
      nav.showToast("请先生成修订草案。");
      return;
    }
    const revisionOrigin = (wsUi.activeRevisionPreview as { readonly originTarget?: WorkspaceOperationTarget }).originTarget;
    if (!revisionOrigin) {
      nav.showToast("这份修订预览缺少工作区归属，已拒绝应用。", 5000);
      return;
    }
    if (!workspaceOperationTargetMatches(revisionOrigin, currentOperationIdentity())) {
      nav.showToast("这份修订预览来自切换前的那本书，不能应用到当前章节。", 5000);
      return;
    }
    // P0-3 防御纵深：UI 零差异态可能被绕过；入口再拦一次，绝不假成功落盘。
    if (isRevisionZeroDiff(wsUi.activeRevisionPreview.beforeText, wsUi.activeRevisionPreview.afterText)) {
      nav.showToast("没有可应用的改动，工作稿未变");
      wsUi.setActiveRevisionTask(null);
      wsUi.setActiveRevisionPreview(null);
      return;
    }
    // B2：把这次「手动选区改写」的 before→after 留住，应用成功后写进对话记录——让 agent 不再对前端直改瞎眼
    // （两套改写体系彼此无感知的根因：路①前端 REST 改写应用后只刷工作区、不告诉 agent 改了什么）。
    const appliedPreview = wsUi.activeRevisionPreview;
    const { originTarget: _originTarget, ...revisionPreviewForApi } = wsUi.activeRevisionPreview;
    const brief = (text: string): string => {
      const s = text.replace(/\s+/gu, " ").trim();
      return s.length > 60 ? `${s.slice(0, 60)}…` : s;
    };

    const operation = beginOwnedOperation("revision-apply");
    if (!operation) return;
    wsUi.setDraftActionLoading("revision-apply");
    const messageId = startAgentFlow({
      messageId: `assistant-revision-apply-progress-${Date.now()}`,
      kind: "revision",
      agentName: "revisionAgent",
      title: "应用修订中",
      summary: "正在把已确认的局部修订写回工作稿。",
      detail: ["写入工作稿中", "刷新章节状态中"],
    });
    try {
      const blocked = await saveBeforeDraftAction();
      if (blocked) throw new Error(blocked);
      const result = await applyDraftRevision({
        projectPath,
        chapter: operation.chapter,
        preview: revisionPreviewForApi,
        // 目标级诚实守卫回传链：把任务里存着的用户点名片段带上——服务端在 apply 时的当前草稿上
        // 重新解析目标区间（解析不到 = 草稿已大变 → 诚实拒）；不回传 resolvedTarget，不信客户端字符串。
        ...(wsUi.activeRevisionTask?.targetText ? { targetText: wsUi.activeRevisionTask.targetText } : {}),
      });
      if (!ownsCurrentWorkspace(operation)) {
        notifyStaleOperation();
        return;
      }
      applyOverviewToWorkspace(result.overview, { flowStatus: "draft_ready" });
      await refreshPaper();
      // 「刚改片段」黄高亮：用改写后的新文本作定位锚，正文里把刚改的那段标出来（WritingPaper 据此高亮）。
      wsUi.setRevisionHighlight(wsUi.activeRevisionPreview.afterText);
      // 体检「改掉这句」联动：若这次改写来自某条违规，应用成功后把它在卡片里标「已改 ✓」并清掉 pending。
      const pending = useUiStore.getState().aiFlavorPending;
      if (pending) {
        useChatStore.getState().markAiFlavorViolationFixed(pending.messageId, pending.violationId);
        useUiStore.getState().setAiFlavorPending(null);
      }
      updateAgentFlow(messageId, {
        role: "assistant",
        content:
          "已把选中的这段改好，写进了工作稿（只动工作稿正文，已定稿版未变）：\n"
          + `· 原文：「${brief(appliedPreview.beforeText)}」\n`
          + `· 改为：「${brief(appliedPreview.afterText)}」\n`
          + "后续涉及这段以改后的为准。想再确认整章，可以再做一次硬伤检查或内容审阅。",
        card: completedAgentCard({
          id: messageId.replace(/^assistant-/u, "agent-"),
          kind: "revision",
          agentName: "revisionAgent",
          title: "修订已应用到工作稿",
          summary: "已替换工作稿中对应片段。",
          detail: ["没有定稿", "可以再做一次硬伤检查或内容审阅"],
        }),
        suggestedActions: [suggestedAction("quality-check"), suggestedAction("ai-review"), suggestedAction("commit-preview")],
      });
      const sUi = useUiStore.getState();
      sUi.setActiveRevisionTask(null);
      sUi.setActiveRevisionPreview(null);
    } catch (error) {
      if (!ownsCurrentWorkspace(operation)) {
        notifyStaleOperation();
        return;
      }
      // 写的途中书变了：没换上，这版留成候选（不是出错）。预览收起（再点也换不上），稿纸上方出提示让作者选。
      if (error instanceof DraftRevisionRefused && error.code === "draft_kept") {
        updateAgentFlow(messageId, {
          role: "assistant",
          content: error.message,
          card: completedAgentCard({
            id: messageId.replace(/^assistant-/u, "agent-"),
            kind: "revision",
            agentName: "revisionAgent",
            title: "这版没换上，留着",
            summary: error.message,
            detail: ["稿纸上方可以换成它"],
          }),
        });
        const sUi = useUiStore.getState();
        sUi.setActiveRevisionTask(null);
        sUi.setActiveRevisionPreview(null);
        await refreshPaper().catch(() => undefined);
        return;
      }
      failAgentFlow(messageId, {
        kind: "revision",
        agentName: "revisionAgent",
        title: "应用修订",
        error,
      });
      if (error instanceof DraftRevisionRefused && error.code === "preview_stale") {
        // 方案过期：如实说，这份预览再点也没用，收起。
        nav.showToast(error.message, 5000);
        const sUi = useUiStore.getState();
        sUi.setActiveRevisionTask(null);
        sUi.setActiveRevisionPreview(null);
      } else {
        useChatStore.getState().setChatError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      finishOwnedOperation(operation);
    }
  };

  /* -------------------------------------------------------------- */
  /*  handleDismissRevisionTask  (App.tsx 1323-1327)                */
  /* -------------------------------------------------------------- */

  const handleDismissRevisionTask = (): void => {
    const wsUi = useUiStore.getState();
    const current = wsUi.activeRevisionTask;
    wsUi.setActiveRevisionTask(current ? { ...current, status: "dismissed" } : null);
    wsUi.setActiveRevisionTask(null);
    wsUi.setActiveRevisionPreview(null);
    wsUi.setAiFlavorPending(null); // 放弃改写：清掉「在改哪条违规」，卡片那条回到「待改」。
  };

  /* -------------------------------------------------------------- */
  /*  handleSelectionRewrite （阶段三块②：选区浮动操作条）           */
  /*  选中正文 → 点按钮（固定模板）→ 复用「审稿修订预览」流：             */
  /*  preview → 存进 activeRevisionTask/activeRevisionPreview → 出「改写前后对比卡」， */
  /*  用户在卡上点「应用到工作稿」才落盘（走 handleApplyRevisionPreview，写前快照=可撤销）。 */
  /*  不再直接 apply——治「点了不知改了啥」。失败就地明示、不乱改。               */
  /*  选区文本随 task.targetText 存进预览态，即使等待确认期间编辑器选区丢了也不受影响。 */
  /* -------------------------------------------------------------- */

  /**
   * 选区改写内核：选区文本 + 模板键（+ 可选 extraGoal）→ preview → 出「改写前后对比卡」、应用前快照可撤销。
   * handleSelectionRewrite（浮动操作条）与 handleFixAiFlavorViolation（体检「改掉这句」）都调它，
   * 行为完全一致——后者只是固定 key=deai 并把 violation.suggestedFix 作为 extraGoal 拼进改写目标。
   */
  const runSelectionRevision = async (
    selectionText: string,
    key: SelectionRevisionKey,
    extraGoal?: string,
    origin?: { readonly messageId: string; readonly violationId: string },
  ): Promise<void> => {
    const nav = useNavigationStore.getState();
    const wsBook = useBookStore.getState();
    const wsUi = useUiStore.getState();
    const template = SELECTION_REVISION_TEMPLATES.find((item) => item.key === key);
    if (!projectPath) {
      nav.showToast("请先打开本地项目。");
      return;
    }
    if (isPaperCommitted()) {
      nav.showToast("本章已定稿，正文只读；如需修改请通过 AI 助手发起修订。");
      return;
    }
    const chapter = wsBook.workspace.currentChapter.chapterNumber;
    const task = buildSelectionRevisionTask({ selectionText, key, chapter, ...(extraGoal ? { extraGoal } : {}) });
    if (!task || !template) {
      nav.showToast("请先在正文里选中一段文字。");
      return;
    }
    const operation = beginOwnedOperation("selection-rewrite");
    if (!operation) return;
    // 改写预览框（RevisionPreviewModal）浮在中栏写作台上：体检卡的「改掉这句」是在右侧聊天点的，
    // 用户可能正停在资料中心，不切过去就看不到预览框＝以为卡死（Codex P1）。点了就把中间区切到写作台。
    // 浮动操作条路用户本就在写作台，这里是 no-op，安全共用。
    nav.requestCenterView("desk");
    // 点了立刻弹框进「正在改写」态——别等 previewDraftRevision 返回才建 task（否则框要等几秒才出现＝没反应）。
    wsUi.setActiveRevisionTask(task);
    wsUi.setActiveRevisionPreview(null);
    wsUi.setRevisionHighlight(null); // 新一次改写开始：先撤掉上一段「刚改片段」黄高亮。
    wsUi.setAiFlavorPending(origin ?? null); // 体检「改掉这句」带来源：记下「在改哪条违规」，应用成功后据它标已改、卡片显示「改写中…」。
    wsUi.setDraftActionLoading(`selection-rewrite-${key}`);
    const messageId = startAgentFlow({
      messageId: `assistant-selection-rewrite-progress-${Date.now()}`,
      kind: "revision",
      agentName: "revisionAgent",
      title: `${template.label} Agent 运行中`,
      summary: `正在${template.label}选中的段落，并生成前后对比草案。`,
      detail: ["定位选中片段中", "生成修订草案中"],
    });
    try {
      const blocked = await saveBeforeDraftAction();
      if (blocked) throw new Error(blocked);
      const previewResult = await previewDraftRevision({
        projectPath,
        chapter: operation.chapter,
        task,
      });
      if (!ownsCurrentWorkspace(operation)) {
        notifyStaleOperation();
        return;
      }
      // 治 A.5：模型调用失败时 revision/preview 返回 200 + 安全兜底（afterText===beforeText 的 no-op）。
      // 绝不把 no-op 当成功、绝不谎报「已改写」——不出预览卡、诚实 toast 失败，原文未动、可重试。
      if (isNoOpRevisionPreview(previewResult.preview)) {
        failAgentFlow(messageId, {
          kind: "revision",
          agentName: "revisionAgent",
          title: template.label,
          error: new Error("模型未能改写（可能调用失败或超时），原文未改动。"),
        });
        nav.showToast(`${template.label}失败：模型未能改写（可能调用失败或超时），原文未改动，请重试。`, 5000);
        const fsUi = useUiStore.getState();
        fsUi.setActiveRevisionTask(null);   // 失败：关掉刚弹出的框
        fsUi.setActiveRevisionPreview(null);
        fsUi.setAiFlavorPending(null);
        return;
      }
      // 不直接 apply：把任务 + 预览存进「审稿修订预览」同一套状态，让 codex 出「改写前后对比卡」，
      // 用户在卡上点「应用到工作稿」才走 handleApplyRevisionPreview 落盘（写前快照=可撤销）。
      // task 里带着 targetText（=选区原文），即使等待确认期间编辑器选区丢了，apply/再改一版都不依赖即时选区。
      const sUi = useUiStore.getState();
      sUi.setActiveRevisionTask(previewResult.task);
      sUi.setActiveRevisionPreview({ ...previewResult.preview, originTarget: operation });
      updateAgentFlow(messageId, {
        role: "assistant",
        content: `已生成${template.label}草案。请在中间的写作台查看「原文 / 修订后」对比，确认后点「应用到工作稿」才会改正文。`,
        card: completedAgentCard({
          id: messageId.replace(/^assistant-/u, "agent-"),
          kind: "revision",
          agentName: "revisionAgent",
          status: "needs_confirmation",
          title: `${template.label}草案已生成`,
          summary: previewResult.preview.changeSummary,
          detail: [
            `风险提醒：${previewResult.preview.riskNotes.length + previewResult.preview.warnings.length}`,
            "等待确认后才应用到工作稿",
          ],
        }),
        suggestedActions: [{
          id: "revision-apply",
          label: "应用到工作稿",
          description: "只替换工作稿中的对应片段，不写已定稿版。",
          permission: "draft_write",
          requiresConfirmation: true,
          endpoint: "/api/draft/revision/apply",
        }],
      });
    } catch (error) {
      if (!ownsCurrentWorkspace(operation)) {
        notifyStaleOperation();
        return;
      }
      // 绝不静默、绝不乱改：原文未动，就地明示失败原因。
      failAgentFlow(messageId, {
        kind: "revision",
        agentName: "revisionAgent",
        title: template.label,
        error,
      });
      nav.showToast(`${template.label}失败：${error instanceof Error ? error.message : String(error)}`, 5000);
      const fsUi = useUiStore.getState();
      fsUi.setActiveRevisionTask(null);   // 失败：关掉刚弹出的框
      fsUi.setActiveRevisionPreview(null);
      fsUi.setAiFlavorPending(null);      // 治：体检「改掉这句」预览生成失败时，卡片别卡在「改写中…」。
    } finally {
      finishOwnedOperation(operation);
    }
  };

  // 浮动操作条入口：行为不变，直接转调内核（不传 extraGoal）。
  const handleSelectionRewrite = (selectionText: string, key: SelectionRevisionKey): Promise<void> =>
    runSelectionRevision(selectionText, key);

  // 「✎ 自己说」入口：用户的具体要求作为 extraGoal、走 custom 模板（基底安全框 + 用户要求拼成改写方向）。
  const handleSelectionRewriteCustom = (selectionText: string, instruction: string): Promise<void> =>
    runSelectionRevision(selectionText, "custom", instruction);

  // 体检「改掉这句」：复用同一改写内核，key 固定 deai，把这句的 suggestedFix 作为额外改写方向。
  // 带上来源（messageId + violationId）：应用成功后据它把卡片那条标「已改 ✓」、并在改写期间显示「改写中…」。
  const handleFixAiFlavorViolation = (
    violation: { readonly id: string; readonly text: string; readonly suggestedFix?: string },
    messageId: string,
  ): void => {
    void runSelectionRevision(violation.text, "deai", violation.suggestedFix, { messageId, violationId: violation.id });
  };

  // 体检「一键全修」：把卡片里还没改的违规一次批量去 AI 味（走 /api/draft/de-ai-flavor/apply 倒序落盘 + 整批快照）。
  // 诚实：只把真改掉的那几条标「已改 ✓」、按改后文本多处高亮；没改的不标、toast 如实报「改了 M / N」。
  const handleFixAiFlavorAll = async (
    violations: readonly { readonly id: string; readonly text: string; readonly reason?: string; readonly severity?: string; readonly suggestedFix?: string }[],
    messageId: string,
  ): Promise<void> => {
    const nav = useNavigationStore.getState();
    const wsUi = useUiStore.getState();
    if (!projectPath) { nav.showToast("请先打开本地项目。"); return; }
    if (isPaperCommitted()) {
      nav.showToast("本章已定稿，正文只读；如需修改请通过 AI 助手发起修订。");
      return;
    }
    if (violations.length === 0) { nav.showToast("没有要改的机器腔。"); return; }
    const operation = beginOwnedOperation("deai-fix-all");
    if (!operation) return;
    const chapter = operation.chapter;
    wsUi.setAiFlavorBatchPending(messageId);
    wsUi.setRevisionHighlight(null);
    wsUi.setDraftActionLoading("deai-fix-all");
    try {
      const blocked = await saveBeforeDraftAction();
      if (blocked) throw new Error(blocked);
      const resp = await applyDeAiFlavorBatch({
        projectPath,
        chapter,
        violations: violations.map((v) => ({
          id: v.id, text: v.text,
          ...(v.reason ? { reason: v.reason } : {}),
          ...(v.severity ? { severity: v.severity } : {}),
          ...(v.suggestedFix ? { suggestedFix: v.suggestedFix } : {}),
        })),
      });
      if (!ownsCurrentWorkspace(operation)) {
        notifyStaleOperation();
        return;
      }
      if (resp.result.rewritten > 0) {
        await refreshPaper();
        const norm = (s: string): string => s.replace(/\s+/gu, "");
        const changedBefores = resp.result.changes.map((c) => norm(c.before));
        for (const v of violations) {
          const t = norm(v.text);
          if (changedBefores.some((b) => b === t || b.includes(t) || t.includes(b))) {
            useChatStore.getState().markAiFlavorViolationFixed(messageId, v.id);
          }
        }
        // 多处黄高亮 + 滚到首处改动（WritingPaper effect 据此联动）。
        useUiStore.getState().setRevisionHighlights(resp.result.changes.map((c) => c.after));
      }
      nav.showToast(resp.summary, 5000);
    } catch (error) {
      if (!ownsCurrentWorkspace(operation)) {
        notifyStaleOperation();
        return;
      }
      nav.showToast(`一键全修没成：${error instanceof Error ? error.message : String(error)}`, 5000);
      // 没换上的那版留成了候选：重读一次，稿纸出提示。
      await refreshPaper().catch(() => undefined);
    } finally {
      if (isWorkspaceOperationCurrent(operation)) {
        if (ownsCurrentWorkspace(operation)) {
          useUiStore.getState().setAiFlavorBatchPending(null);
          useUiStore.getState().setDraftActionLoading(null);
        }
        finishWorkspaceOperation(operation);
      }
    }
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

  /* -------------------------------------------------------------- */
  /*  Return                                                         */
  /* -------------------------------------------------------------- */

  return {
    handleSelectionRewrite,
    handleSelectionRewriteCustom,
    handleFixAiFlavorViolation,
    handleFixAiFlavorAll,
    handleRerollCandidates,
    handleApplyCandidate,
    handleCloseCandidates,
    handleCreateRevisionTask,
    handleGenerateRevisionPreview,
    handleApplyRevisionPreview,
    handleDismissRevisionTask,
  } as const;
}
