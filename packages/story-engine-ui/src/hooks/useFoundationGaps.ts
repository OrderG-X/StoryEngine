import { useCallback } from "react";
import { useWorkspaceStore } from "../stores/workspaceStore.js";
import { useNavigationStore } from "../stores/navigationStore.js";
import {
  fetchFoundationGapReport,
  fetchFoundationGapSuggestions,
  chatFoundationGapAssistant,
  previewFoundationGapApply,
  applyFoundationGapDecisions,
  rollbackFoundationGapApply,
  confirmFoundationGapCharacterStateWrite,
} from "../api/client.js";
import { workspaceFromStateOverview, sidebarFromStateOverview } from "../api/stateOverviewAdapter.js";
import type {
  FoundationGapReport,
  FoundationGapSuggestion,
  FoundationGapDecision,
  FoundationGapAppliedWrite,
  FoundationGapApplyPlan,
  FoundationGapSkippedWrite,
  FoundationGapChatMessageInput,
  FoundationGapConfirmCharacterStateWriteResult,
  StateOverview,
} from "../api/types.js";

export function useFoundationGaps(projectPath: string | null) {
  const showToast = useNavigationStore((state) => state.showToast);

  const foundationGapReport = useWorkspaceStore((state) => state.foundationGapReport);
  const foundationGapSuggestions = useWorkspaceStore((state) => state.foundationGapSuggestions);
  const foundationGapDecisions = useWorkspaceStore((state) => state.foundationGapDecisions);
  const setFoundationGapReport = useWorkspaceStore((state) => state.setFoundationGapReport);
  const setFoundationGapSuggestions = useWorkspaceStore((state) => state.setFoundationGapSuggestions);
  const setFoundationGapDecisions = useWorkspaceStore((state) => state.setFoundationGapDecisions);
  const setFoundationGapApplyPlan = useWorkspaceStore((state) => state.setFoundationGapApplyPlan);
  const setFoundationGapLoading = useWorkspaceStore((state) => state.setFoundationGapLoading);
  const setFoundationGapError = useWorkspaceStore((state) => state.setFoundationGapError);

  const setCurrentOverview = useWorkspaceStore((state) => state.setCurrentOverview);
  const setWorkspace = useWorkspaceStore((state) => state.setWorkspace);
  const setSidebar = useWorkspaceStore((state) => state.setSidebar);

  const refreshWorkspaceFromOverview = useCallback(
    // 必须与 useProjectNavigation.ts 的 mergeFoundationRefreshWorkspace 保持同款字段保留（H4：资料刷新
    // 保留用户当前停留章 currentChapter/chapters，不跳到 overview 最新章）。改一处记得同步另一处。
    (overview: StateOverview) => {
      setCurrentOverview(overview);
      const current = useWorkspaceStore.getState().workspace;
      setWorkspace({
        ...workspaceFromStateOverview(overview),
        currentChapter: current.currentChapter,
        chapters: current.chapters,
        messages: current.messages,
        flowStatus: current.flowStatus,
        draft: current.draft,
      });
      setSidebar(sidebarFromStateOverview(overview));
    },
    [setCurrentOverview, setWorkspace, setSidebar],
  );

  const selectedFoundationGapDecisions = useCallback(
    (): readonly FoundationGapDecision[] =>
      foundationGapSuggestions
        .map((suggestion) => {
          const decision = foundationGapDecisions[suggestion.id] ?? "defer";
          if (decision === "accept" || decision === "edit") {
            return { suggestionId: suggestion.id, decision: "edit" as const, editedAfter: suggestion.after };
          }
          return { suggestionId: suggestion.id, decision };
        })
        .filter((decision) => decision.decision !== "defer" || foundationGapDecisions[decision.suggestionId] === "defer"),
    [foundationGapSuggestions, foundationGapDecisions],
  );

  const handleScanFoundationGaps = useCallback(async () => {
    if (!projectPath) {
      setFoundationGapError("请先打开真实本地项目。");
      return;
    }
    setFoundationGapLoading("扫描资料缺口");
    setFoundationGapError(null);
    try {
      const report = await fetchFoundationGapReport(projectPath);
      setFoundationGapReport(report);
      setFoundationGapSuggestions(report.suggestions);
      setFoundationGapDecisions(Object.fromEntries(report.suggestions.map((suggestion) => [suggestion.id, "defer" as const])));
      setFoundationGapApplyPlan(null);
    } catch (error) {
      setFoundationGapError(error instanceof Error ? error.message : String(error));
    } finally {
      setFoundationGapLoading(null);
    }
  }, [projectPath, setFoundationGapError, setFoundationGapLoading, setFoundationGapReport, setFoundationGapSuggestions, setFoundationGapDecisions, setFoundationGapApplyPlan]);

  const handleGenerateFoundationGapSuggestions = useCallback(async () => {
    if (!projectPath) {
      setFoundationGapError("请先打开真实本地项目。");
      return;
    }
    setFoundationGapLoading("生成补全建议");
    setFoundationGapError(null);
    try {
      const result = await fetchFoundationGapSuggestions(projectPath);
      setFoundationGapReport(result.report);
      setFoundationGapSuggestions(result.suggestions);
      setFoundationGapDecisions(Object.fromEntries(result.suggestions.map((suggestion) => [suggestion.id, "defer" as const])));
      setFoundationGapApplyPlan(null);
    } catch (error) {
      setFoundationGapError(error instanceof Error ? error.message : String(error));
    } finally {
      setFoundationGapLoading(null);
    }
  }, [projectPath, setFoundationGapError, setFoundationGapLoading, setFoundationGapReport, setFoundationGapSuggestions, setFoundationGapDecisions, setFoundationGapApplyPlan]);

  const handleFoundationGapChat = useCallback(
    async (input: {
      userMessage: string;
      currentDraft?: FoundationGapSuggestion | null;
      currentIntent?: string | null;
      selectedCategory?: string | null;
      chatHistory?: readonly FoundationGapChatMessageInput[];
      currentDraftContent?: string | null;
      directArchive?: boolean;
    }) => {
      if (!projectPath) {
        throw new Error("请先打开真实本地项目。");
      }
      const result = await chatFoundationGapAssistant({
        projectPath,
        userMessage: input.userMessage,
        currentReport: foundationGapReport,
        currentSuggestions: foundationGapSuggestions,
        currentDecisions: foundationGapDecisions,
        currentDraft: input.currentDraft,
        currentIntent: input.currentIntent,
        selectedCategory: input.selectedCategory,
        chatHistory: input.chatHistory,
        currentDraftContent: input.currentDraftContent,
        directArchive: input.directArchive,
      });
      const nextGeneratedSuggestions = result.draftSuggestion
        ? [result.draftSuggestion, ...result.generatedSuggestions.filter((suggestion) => suggestion.id !== result.draftSuggestion?.id)]
        : result.generatedSuggestions;
      if (nextGeneratedSuggestions.length > 0) {
        const currentSuggestions = useWorkspaceStore.getState().foundationGapSuggestions;
        const generatedById = new Map(nextGeneratedSuggestions.map((item) => [item.id, item]));
        const replaced = currentSuggestions.map((item) => generatedById.get(item.id) ?? item);
        const existingIds = new Set(replaced.map((item) => item.id));
        const additions = nextGeneratedSuggestions.filter((item) => !existingIds.has(item.id));
        if (additions.length || nextGeneratedSuggestions.some((item) => currentSuggestions.some((currentItem) => currentItem.id === item.id))) {
          setFoundationGapSuggestions([...replaced, ...additions]);
        }

        const currentDecisions = useWorkspaceStore.getState().foundationGapDecisions;
        const newDecisions = Object.fromEntries(
          nextGeneratedSuggestions
            .filter((suggestion) => currentDecisions[suggestion.id] === undefined)
            .map((suggestion) => [suggestion.id, "defer" as const]),
        );
        if (Object.keys(newDecisions).length) {
          setFoundationGapDecisions({ ...currentDecisions, ...newDecisions });
        }

        setFoundationGapApplyPlan(null);
      }
      if (result.fallbackUsed) {
        setFoundationGapError(null);
      }
      return result;
    },
    [
      projectPath,
      foundationGapReport,
      foundationGapSuggestions,
      foundationGapDecisions,
      setFoundationGapSuggestions,
      setFoundationGapDecisions,
      setFoundationGapApplyPlan,
      setFoundationGapError,
    ],
  );

  const handleFoundationGapDecisionChange = useCallback(
    (suggestionId: string, decision: FoundationGapDecision["decision"]) => {
      const current = useWorkspaceStore.getState().foundationGapDecisions;
      setFoundationGapDecisions({ ...current, [suggestionId]: decision });
      setFoundationGapApplyPlan(null);
    },
    [setFoundationGapDecisions, setFoundationGapApplyPlan],
  );

  const handlePreviewFoundationGapApply = useCallback(async () => {
    if (!projectPath) {
      setFoundationGapError("请先打开真实本地项目。");
      return;
    }
    setFoundationGapLoading("生成写入预览");
    setFoundationGapError(null);
    try {
      setFoundationGapApplyPlan(await previewFoundationGapApply(projectPath, selectedFoundationGapDecisions(), foundationGapSuggestions));
    } catch (error) {
      setFoundationGapError(error instanceof Error ? error.message : String(error));
    } finally {
      setFoundationGapLoading(null);
    }
  }, [projectPath, foundationGapSuggestions, selectedFoundationGapDecisions, setFoundationGapError, setFoundationGapLoading, setFoundationGapApplyPlan]);

  const executeFoundationGapApply = useCallback(async (override?: {
    readonly decisions: readonly FoundationGapDecision[];
    readonly suggestions: readonly FoundationGapSuggestion[];
  }): Promise<FoundationGapApplyPlan | null> => {
    if (!projectPath) return null;
    setFoundationGapLoading("确认写入资料");
    setFoundationGapError(null);
    try {
      const result = await applyFoundationGapDecisions(
        projectPath,
        override?.decisions ?? selectedFoundationGapDecisions(),
        override?.suggestions ?? foundationGapSuggestions,
      );
      refreshWorkspaceFromOverview(result.overview);
      setFoundationGapApplyPlan(result.plan);
      const nextReport = await fetchFoundationGapReport(projectPath);
      setFoundationGapReport(nextReport);
      setFoundationGapSuggestions(nextReport.suggestions);
      setFoundationGapDecisions(Object.fromEntries(nextReport.suggestions.map((suggestion) => [suggestion.id, "defer" as const])));
      showToast("资料补全已写入。");
      return result.plan;
    } catch (error) {
      setFoundationGapError(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      setFoundationGapLoading(null);
    }
  }, [
    projectPath,
    foundationGapSuggestions,
    selectedFoundationGapDecisions,
    refreshWorkspaceFromOverview,
    setFoundationGapLoading,
    setFoundationGapError,
    setFoundationGapApplyPlan,
    setFoundationGapReport,
    setFoundationGapSuggestions,
    setFoundationGapDecisions,
    showToast,
  ]);

  const handleApplyFoundationGapDecisions = useCallback(async () => {
    if (!projectPath) {
      setFoundationGapError("请先打开真实本地项目。");
      return;
    }
    const acceptedCount = Object.values(foundationGapDecisions).filter((decision) => decision === "accept" || decision === "edit").length;
    if (acceptedCount === 0) {
      setFoundationGapError("请先接受至少一条补全建议。");
      return;
    }
    await executeFoundationGapApply();
  }, [projectPath, foundationGapDecisions, setFoundationGapError, executeFoundationGapApply]);

  const handleApplyFoundationGapSuggestionsFromChat = useCallback(
    async (suggestionIds?: readonly string[]): Promise<{ readonly plan: FoundationGapApplyPlan; readonly writes: readonly FoundationGapAppliedWrite[]; readonly skippedWrites: readonly FoundationGapSkippedWrite[]; readonly undo?: { readonly undoId: string; readonly changedFiles: readonly string[] } } | null> => {
      if (!projectPath) {
        setFoundationGapError("请先打开真实本地项目。");
        return null;
      }
      const store = useWorkspaceStore.getState();
      const currentSuggestions = store.foundationGapSuggestions;
      const currentDecisions = store.foundationGapDecisions;
      const idSet = new Set((suggestionIds ?? []).filter(Boolean));
      const targets = idSet.size > 0
        ? currentSuggestions.filter((suggestion) => idSet.has(suggestion.id))
        : currentSuggestions.filter((suggestion) => (
            suggestion.id.startsWith("ai-")
            || suggestion.gapId.startsWith("ai-gap")
            || Boolean(suggestion.sourceUserMessage)
          ));
      if (targets.length === 0) {
        return null;
      }
      const targetIds = new Set(targets.map((suggestion) => suggestion.id));
      const decisions: readonly FoundationGapDecision[] = currentSuggestions.map((suggestion) => {
        if (targetIds.has(suggestion.id)) {
          return { suggestionId: suggestion.id, decision: "edit" as const, editedAfter: suggestion.after };
        }
        return { suggestionId: suggestion.id, decision: currentDecisions[suggestion.id] ?? "defer" };
      });
      setFoundationGapLoading("确认写入资料");
      setFoundationGapError(null);
      try {
        const result = await applyFoundationGapDecisions(projectPath, decisions, currentSuggestions);
        refreshWorkspaceFromOverview(result.overview);
        setFoundationGapApplyPlan(result.plan);
        const nextReport = await fetchFoundationGapReport(projectPath);
        setFoundationGapReport(nextReport);
        const shouldPreserveChatSuggestionsForConfirmation = result.writes.length === 0 && result.plan.skippedConflicts.length > 0;
        if (!shouldPreserveChatSuggestionsForConfirmation) {
          setFoundationGapSuggestions(nextReport.suggestions);
          setFoundationGapDecisions(Object.fromEntries(nextReport.suggestions.map((suggestion) => [suggestion.id, "defer" as const])));
        }
        // 修3：toast 也要诚实——一个字没写就别报「已修改」。
        showToast(result.writes.length > 0 ? "已修改资料。" : "这次没有写入任何资料。");
        return { plan: result.plan, writes: result.writes, skippedWrites: result.skippedWrites, undo: result.undo };
      } catch (error) {
        setFoundationGapError(error instanceof Error ? error.message : String(error));
        return null;
      } finally {
        setFoundationGapLoading(null);
      }
    },
    [
      projectPath,
      refreshWorkspaceFromOverview,
      setFoundationGapLoading,
      setFoundationGapError,
      setFoundationGapApplyPlan,
      setFoundationGapReport,
      setFoundationGapSuggestions,
      setFoundationGapDecisions,
      showToast,
    ],
  );

  const handleRollbackFoundationGapApplyFromChat = useCallback(
    async (undoId: string): Promise<boolean> => {
      if (!projectPath) {
        setFoundationGapError("请先打开真实本地项目。");
        return false;
      }
      setFoundationGapLoading("撤销资料修改");
      setFoundationGapError(null);
      try {
        const result = await rollbackFoundationGapApply(projectPath, undoId);
        refreshWorkspaceFromOverview(result.overview);
        const nextReport = await fetchFoundationGapReport(projectPath);
        setFoundationGapReport(nextReport);
        setFoundationGapSuggestions(nextReport.suggestions);
        setFoundationGapDecisions(Object.fromEntries(nextReport.suggestions.map((suggestion) => [suggestion.id, "defer" as const])));
        showToast("已撤销本次资料修改。");
        return true;
      } catch (error) {
        setFoundationGapError(error instanceof Error ? error.message : String(error));
        return false;
      } finally {
        setFoundationGapLoading(null);
      }
    },
    [
      projectPath,
      refreshWorkspaceFromOverview,
      setFoundationGapLoading,
      setFoundationGapError,
      setFoundationGapReport,
      setFoundationGapSuggestions,
      setFoundationGapDecisions,
      showToast,
    ],
  );

  const handleConfirmFoundationGapSuggestion = useCallback(
    async (suggestion: FoundationGapSuggestion): Promise<FoundationGapApplyPlan> => {
      if (!projectPath) {
        throw new Error("请先打开真实本地项目。");
      }
      // 资料类「直接写」：接受面板草案卡后直接写入，去掉冗余的预览往返。
      // 写入前服务端（阶段一）会自动 git 快照并产出 undo，正确性与可撤销不变。
      //
      // 复用 executeFoundationGapApply：刷新/reset/toast（"资料补全已写入。"）与「确认写入」面板
      // 按钮完全一致，单点维护。这里只负责把被确认的草案强制为 edit 决策，其余 apply 流程交给共用助手。
      //
      // 守卫一致性（对照 handleApplyFoundationGapSuggestionsFromChat 的
      // shouldPreserveChatSuggestionsForConfirmation）：confirm 路径只从面板草案卡触发，
      // 草案均为非 delete、不会返回 needs-confirm（writes 空 + skippedConflicts），
      // 故无需「保留草案」守卫——executeFoundationGapApply 的无条件 reset 在此前提下行为正确。
      const nextSuggestions = [
        suggestion,
        ...foundationGapSuggestions.filter((item) => item.id !== suggestion.id),
      ];
      const nextDecisions: Readonly<Record<string, FoundationGapDecision["decision"]>> = {
        ...foundationGapDecisions,
        [suggestion.id]: "edit",
      };
      const decisions: readonly FoundationGapDecision[] = nextSuggestions
        .map((item) => {
          const decision = nextDecisions[item.id] ?? "defer";
          if (item.id === suggestion.id || decision === "accept" || decision === "edit") {
            return { suggestionId: item.id, decision: "edit" as const, editedAfter: item.after };
          }
          return { suggestionId: item.id, decision };
        });
      const plan = await executeFoundationGapApply({ decisions, suggestions: nextSuggestions });
      if (!plan) {
        // executeFoundationGapApply 在出错时吞掉异常并 setFoundationGapError，
        // 但 confirm 的契约是抛出，调用方（面板卡）据此回退 UI。
        throw new Error(useWorkspaceStore.getState().foundationGapError ?? "资料写入失败。");
      }
      return plan;
    },
    [
      projectPath,
      foundationGapSuggestions,
      foundationGapDecisions,
      executeFoundationGapApply,
    ],
  );

  const handleConfirmCharacterStateWrite = useCallback(
    async (suggestion: FoundationGapSuggestion): Promise<FoundationGapConfirmCharacterStateWriteResult> => {
      if (!projectPath) {
        throw new Error("请先打开真实本地项目。");
      }
      const request = await buildCharacterStateConfirmRequest(projectPath, suggestion);
      setFoundationGapLoading("确认写入角色状态");
      setFoundationGapError(null);
      try {
        const result = await confirmFoundationGapCharacterStateWrite(request);
        if (result.status === "committed") {
          if (result.overview) {
            refreshWorkspaceFromOverview(result.overview);
          }
          const nextReport = await fetchFoundationGapReport(projectPath).catch(() => null);
          if (nextReport) {
            setFoundationGapReport(nextReport);
            setFoundationGapSuggestions(nextReport.suggestions);
            setFoundationGapDecisions(Object.fromEntries(nextReport.suggestions.map((item) => [item.id, "defer" as const])));
          }
          showToast(result.stateOverviewRefreshSucceeded
            ? "角色状态已写入，左侧资料区已刷新。"
            : "角色状态已写入，但左侧资料区刷新失败，请手动刷新。");
        } else {
          setFoundationGapError(`角色状态未写入。${result.reason ?? "未知原因"}`);
        }
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setFoundationGapError(`角色状态未写入。${message}`);
        throw new Error(message);
      } finally {
        setFoundationGapLoading(null);
      }
    },
    [
      projectPath,
      refreshWorkspaceFromOverview,
      setFoundationGapLoading,
      setFoundationGapError,
      setFoundationGapReport,
      setFoundationGapSuggestions,
      setFoundationGapDecisions,
      showToast,
    ],
  );

  return {
    handleScanFoundationGaps,
    handleGenerateFoundationGapSuggestions,
    handleFoundationGapChat,
    handleFoundationGapDecisionChange,
    handlePreviewFoundationGapApply,
    handleApplyFoundationGapDecisions,
    executeFoundationGapApply,
    handleApplyFoundationGapSuggestionsFromChat,
    handleRollbackFoundationGapApplyFromChat,
    handleConfirmFoundationGapSuggestion,
    handleConfirmCharacterStateWrite,
  };
}

const CHARACTER_STATE_PATCH_ALLOWED_KEYS = new Set([
  "currentGoal",
  "mood",
  "relationshipToProtagonist",
  "recentEvents",
  "currentArc",
  "notes",
  "updatedAt",
]);

async function buildCharacterStateConfirmRequest(projectPath: string, suggestion: FoundationGapSuggestion) {
  const targetFile = normalizeCharacterStateTargetFile(suggestion);
  if (!targetFile) {
    throw new Error("当前建议不是 V1 允许的角色状态写入。");
  }
  const characterId = targetFile.split("/")[1] ?? "";
  const before = isRecord(suggestion.before) ? suggestion.before : {};
  const statePatch = pickAllowedCharacterStatePatch(suggestion.after);
  if (Object.keys(statePatch).length === 0) {
    throw new Error("角色状态补丁为空或包含不允许字段。");
  }
  const suggestionIds = [suggestion.id];
  const baseHash = await sha256Hex(stableJson(before));
  const previewHash = await sha256Hex(stableJson({ characterId, targetFile, suggestionIds, statePatch }));
  return {
    projectPath,
    characterId,
    targetFile,
    previewHash,
    baseHash,
    idempotencyKey: `foundation-character-state:${suggestion.id}:${previewHash}:${baseHash}`,
    explicitConfirm: true as const,
    suggestionIds,
    statePatch,
  };
}

function normalizeCharacterStateTargetFile(suggestion: FoundationGapSuggestion): `characters/${string}/state.json` | undefined {
  const match = /^characters\/([^/]+)\/state\.json$/u.exec(suggestion.targetFile);
  if (!match?.[1]) return undefined;
  if (suggestion.targetFile.includes("..")) return undefined;
  return `characters/${match[1]}/state.json`;
}

function pickAllowedCharacterStatePatch(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const patch: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (CHARACTER_STATE_PATCH_ALLOWED_KEYS.has(key)) {
      patch[key] = item;
    }
  }
  return patch;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256Hex(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const digest = await globalThis.crypto.subtle.digest("SHA-256", encoder.encode(input));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
