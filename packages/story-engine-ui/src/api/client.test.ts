import { afterEach, describe, expect, it, vi } from "vitest";

import { summarizeFormalCommitApplyError } from "../utils/formalCommitApplyErrorCopy.js";
import {
  applyFoundationGapDecisions,
  chatFoundationGapAssistant,
  applyCommit,
  confirmFoundationGapCharacterStateWrite,
  fetchMemoryContextRead,
  fetchModelSettings,
  FOUNDATION_GAP_APPLY_TIMEOUT_MESSAGE,
  FOUNDATION_GAP_APPLY_TIMEOUT_MS,
  FOUNDATION_GAP_CHAT_TIMEOUT_MESSAGE,
  FOUNDATION_GAP_CHAT_TIMEOUT_MS,
  previewCommit,
  saveChapterWorkspace,
  saveModelSettings,
  ChapterWorkspaceConflictError,
} from "./client.js";

describe("saveChapterWorkspace revision conflicts", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("surfaces HTTP 409 as a typed conflict carrying the current server snapshot", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      ok: false,
      error: "工作区 revision 冲突",
      snapshot: {
        chapter: 1,
        messages: [],
        selectedAdviceCardKeys: [],
        draftContent: "server wins",
        revision: 4,
      },
    }, 409)));

    const error = await saveChapterWorkspace({
      projectPath: "/tmp/story-project",
      chapter: 1,
      messages: [],
      selectedAdviceCardKeys: [],
      expectedRevision: 3,
    }).then(() => null, (reason: unknown) => reason);

    expect(error).toBeInstanceOf(ChapterWorkspaceConflictError);
    expect(error).toMatchObject({
      snapshot: { chapter: 1, draftContent: "server wins", revision: 4 },
    });
  });
});

describe("applyCommit structured error payloads", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("preserves transaction preflight payload for stale preview copy", async () => {
    const payload = {
      ok: false,
      reason: "formal_commit_apply_transaction_preflight_failed",
      transactionPreflight: { code: "preview_hash_mismatch" },
    };
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(payload, 409)));

    const error = await captureApplyCommitError();
    const copy = summarizeFormalCommitApplyError(error);

    expect((error as { readonly payload?: unknown }).payload).toMatchObject(payload);
    expect(flattenCopy(copy)).toContain("重新生成定稿预览");
  });

  it("preserves transaction residue payload for residue copy", async () => {
    const payload = {
      ok: false,
      reason: "formal_commit_apply_transaction_preflight_failed",
      transactionPreflight: { code: "transaction_residue_found" },
    };
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(payload, 409)));

    const copy = summarizeFormalCommitApplyError(await captureApplyCommitError());

    expect(flattenCopy(copy)).toContain("事务残留");
    expect(flattenCopy(copy)).toContain("不要重复提交");
  });

  it("preserves finalize failure payload for possible written chapter copy", async () => {
    const payload = {
      ok: false,
      reason: "formal_commit_apply_finalize_failed",
      transactionFinalized: false,
      finalizeError: "simulated finalize throw",
      changedFiles: ["chapters/0001.md"],
      transactionDir: ".story-engine-tx/commit-chapter-0001",
    };
    const fetchMock = vi.fn(async () => jsonResponse(payload, 500));
    vi.stubGlobal("fetch", fetchMock);

    const copy = summarizeFormalCommitApplyError(await captureApplyCommitError());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(flattenCopy(copy)).toContain("章节可能已经写入");
    expect(flattenCopy(copy)).toContain("事务 finalized 失败");
    expect(flattenCopy(copy)).toContain("不要重复点击");
    expect(flattenCopy(copy)).toContain(".story-engine-tx");
  });

  it("preserves snapshot materialization payload for same-chapter collision copy", async () => {
    const payload = {
      ok: false,
      reason: "formal_commit_snapshot_materialization_failed",
      snapshotResult: { reason: "existing_transaction_dir" },
    };
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(payload, 409)));

    const copy = summarizeFormalCommitApplyError(await captureApplyCommitError());

    expect(flattenCopy(copy)).toContain("同一章");
    expect(flattenCopy(copy)).toContain("事务目录");
  });
});

describe("fetchMemoryContextRead", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts only display-safe read request fields to the memory context route", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => jsonResponse({
      ok: true,
      status: "ready",
      viewModel: null,
      warnings: [],
      blockingReasons: [],
      normalizedPath: "memory/project.json",
      readOnly: true,
      canWrite: false,
      canInjectAutomatically: false,
      didReadFile: true,
      didWriteMemory: false,
      didInjectAutomatically: false,
      requestId: "req-1",
      safety: safetyFlags(),
    }, 200));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchMemoryContextRead({
      projectPath: "/tmp/story-project",
      memoryTargetPath: "memory/project.json",
      limits: { maxFileBytes: 65536, maxMemoryItems: 50, maxTextLengthPerItem: 500 },
      requestId: "req-1",
      testHooks: { shouldNotForward: true },
      sourcePath: "/tmp/story-project/memory/project.json",
      apply: true,
      confirm: true,
      write: true,
    } as never);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/memory/context/read",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectPath: "/tmp/story-project",
          memoryTargetPath: "memory/project.json",
          limits: { maxFileBytes: 65536, maxMemoryItems: 50, maxTextLengthPerItem: 500 },
          requestId: "req-1",
        }),
      }),
    );
    expect(result.status).toBe("ready");
    expect(result.normalizedPath).toBe("memory/project.json");
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty("testHooks");
    expect(body).not.toHaveProperty("sourcePath");
    expect(body).not.toHaveProperty("apply");
    expect(body).not.toHaveProperty("confirm");
    expect(body).not.toHaveProperty("write");
  });

  it("returns controlled blocked payloads for route errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      ok: false,
      status: "blocked",
      viewModel: null,
      warnings: [],
      blockingReasons: ["blocked path"],
      normalizedPath: "",
      readOnly: true,
      canWrite: false,
      canInjectAutomatically: false,
      didReadFile: false,
      didWriteMemory: false,
      didInjectAutomatically: false,
      requestId: "req-2",
      safety: safetyFlags(),
    }, 400)));

    const result = await fetchMemoryContextRead({
      projectPath: "/tmp/story-project",
      memoryTargetPath: "../memory/project.json",
      requestId: "req-2",
    });

    expect(result.status).toBe("blocked");
    expect(result.blockingReasons).toContain("blocked path");
    expect(result.didWriteMemory).toBe(false);
    expect(result.didInjectAutomatically).toBe(false);
  });

  it("converts network failures into controlled failed display results", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("network down");
    }));

    const result = await fetchMemoryContextRead({
      projectPath: "/tmp/story-project",
      memoryTargetPath: "memory/project.json",
      requestId: "req-3",
    });

    expect(result.status).toBe("failed");
    expect(result.warnings.join("\n")).toContain("memory context route request failed");
    expect(result.didReadFile).toBe(false);
    expect(result.safety.noMemoryWrite).toBe(true);
  });
});

describe("confirmFoundationGapCharacterStateWrite", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts only the character state confirm contract to the unique foundation route", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => jsonResponse({
      ok: true,
      result: {
        status: "committed",
        scope: "character_state_only",
        changedFiles: ["characters/lin-xiao/state.json"],
        didWriteCharacterState: true,
        didWriteCharacterProfile: false,
        didWriteCharacterBible: false,
        didWriteCharacterMatrix: false,
        didWriteChapterMarkdown: false,
        didWriteTimeline: false,
        didWriteWorld: false,
        didWriteMemory: false,
        didCallCommitEngine: false,
        didCallApplyCommit: false,
        stateOverviewRefreshRequested: true,
        stateOverviewRefreshSucceeded: true,
        stateOverviewRefreshError: null,
        rollbackAttempted: false,
        rollbackSucceeded: null,
        residue: [],
      },
    }, 200));
    vi.stubGlobal("fetch", fetchMock);

    await confirmFoundationGapCharacterStateWrite({
      projectPath: "/tmp/story-project",
      characterId: "lin-xiao",
      targetFile: "characters/lin-xiao/state.json",
      previewHash: "preview-hash",
      baseHash: "base-hash",
      idempotencyKey: "idem-1",
      explicitConfirm: true,
      suggestionIds: ["suggestion-1"],
      statePatch: { mood: "冷静" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/foundation-gaps/confirm-character-write",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
      }),
    );
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      projectPath: "/tmp/story-project",
      characterId: "lin-xiao",
      targetFile: "characters/lin-xiao/state.json",
      previewHash: "preview-hash",
      baseHash: "base-hash",
      idempotencyKey: "idem-1",
      explicitConfirm: true,
      suggestionIds: ["suggestion-1"],
      statePatch: { mood: "冷静" },
    });
    expect(JSON.stringify(body)).not.toContain("/api/commit/apply");
    expect(JSON.stringify(body)).not.toContain("/api/formal-write/");
    expect(JSON.stringify(body)).not.toContain("CommitEngine");
  });
});

describe("foundation agent endpoint timeouts", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("times out foundation gap chat requests so the UI can unlock", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => abortableNeverResponse(init)));

    const request = chatFoundationGapAssistant({
      projectPath: "/tmp/story-project",
      userMessage: "角色里好像有个多余的",
    });
    const expected = expect(request).rejects.toThrow(FOUNDATION_GAP_CHAT_TIMEOUT_MESSAGE);

    await vi.advanceTimersByTimeAsync(FOUNDATION_GAP_CHAT_TIMEOUT_MS);
    await expected;
  });

  it("times out foundation gap apply requests instead of waiting forever", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => abortableNeverResponse(init)));

    const request = applyFoundationGapDecisions(
      "/tmp/story-project",
      [{ suggestionId: "suggestion-1", decision: "accept" }],
      [],
    );
    const expected = expect(request).rejects.toThrow(FOUNDATION_GAP_APPLY_TIMEOUT_MESSAGE);

    await vi.advanceTimersByTimeAsync(FOUNDATION_GAP_APPLY_TIMEOUT_MS);
    await expected;
  });
});

describe("fetchModelSettings", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads model and provider settings from the global settings route", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      ok: true,
      result: {
        passed: true,
        available: true,
        status: "loaded",
        configPath: "/Users/example/.story-engine/model-settings.json",
        summary: {
          available: true,
          status: "loaded",
          configPath: "/Users/example/.story-engine/model-settings.json",
          defaultProvider: "main",
          providers: [{
            id: "main",
            label: "OpenAI Compatible",
            type: "openai-compatible",
            baseUrl: "https://api.example.com/v1",
            apiKeyStatus: "present",
          }],
          profiles: [{
            id: "balanced",
            label: "Balanced",
            provider: "main",
            model: "model-name",
            temperature: 0.7,
            maxTokens: 4096,
            timeoutMs: 60000,
            retries: 2,
            stream: true,
          }],
          taskProfiles: { fastDraft: "balanced" },
          issueCount: 0,
          highRiskIssueCount: 0,
        },
        issues: [],
      },
      rawText: "{\"version\":1}\n",
    }, 200));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchModelSettings();

    expect(fetchMock).toHaveBeenCalledWith("/api/model-settings", expect.any(Object));
    expect(result.result.summary.providers[0]?.id).toBe("main");
    expect(result.rawText).toBe("{\"version\":1}\n");
  });
});

describe("saveModelSettings warnings passthrough", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function okPayload(warnings?: readonly string[]) {
    return {
      ok: true,
      result: {
        passed: true,
        available: true,
        status: "loaded",
        configPath: "/Users/example/.story-engine/model-settings.json",
        summary: {
          available: true,
          status: "loaded",
          configPath: "/Users/example/.story-engine/model-settings.json",
          providers: [],
          profiles: [],
          taskProfiles: {},
          issueCount: 0,
          highRiskIssueCount: 0,
        },
        issues: [],
      },
      rawText: "{\"version\":1}\n",
      ...(warnings ? { warnings } : {}),
    };
  }

  it("透传 PUT 响应的 warnings（丢头警告必须能到达面板，绝不静默吞掉）", async () => {
    const warnings = ["1 个自定义请求头无法还原已丢弃（未保存）：main 的 x-brand-new。如需保留请重新填写明文值后保存。"];
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(okPayload(warnings), 200)));

    const result = await saveModelSettings("{\"version\":1}");

    expect(result.warnings).toEqual(warnings);
  });

  it("响应不带 warnings 字段时结果为 undefined（无丢弃不刷警告）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(okPayload(), 200)));

    const result = await saveModelSettings("{\"version\":1}");

    expect(result.warnings).toBeUndefined();
  });
});

describe("previewCommit", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts only preview-safe fields to /api/commit/preview", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({
      ok: true,
      commitPlan: { passed: true, commitPlan: {} },
      draftQuality: { passed: true, issues: [] },
      transaction: {
        version: "transaction-hardening-v1",
        transactionId: "txv1-ch0001-previewhash",
        previewHash: "preview-hash",
        projectHash: "project-hash",
        chapter: 1,
        draftHash: "draft-hash",
        commitPlanHash: "plan-hash",
        selectiveCandidateSummaryHash: "summary-hash",
      },
      transactionId: "txv1-ch0001-previewhash",
      previewHash: "preview-hash",
      formalCommitPreview: {
        status: "unavailable",
        formalCommitPlan: { passed: true, commitPlan: {} },
        wouldChangeFiles: ["chapters/0001.md"],
        wouldUpdateState: false,
        blockingReasons: ["formal_commit_confirm_unavailable"],
        warnings: [],
        requestId: "req-1",
        dryRun: true,
        readOnly: true,
        didWriteState: false,
        didWriteMarkdown: false,
        didWriteMemory: false,
        didFormalCommit: false,
        canConfirm: false,
        confirmUnavailable: true,
        previewToken: null,
        chapterOnlyConfirmReadiness: {
          status: "blocked",
          blockingReasons: ["formal_commit_confirm_unavailable"],
          confirmRequestContextAvailable: false,
          serverFlagRequiredForWrite: true,
          fullFormalCommitReady: false,
          doesNotUpdateState: true,
          readinessStatus: null,
        },
        safety: safetyFlags(),
      },
    }, 200));
    vi.stubGlobal("fetch", fetchMock);

    const result = await previewCommit({
      projectPath: "/tmp/story-project",
      chapter: 1,
      requestId: "req-1",
      confirm: true,
      apply: true,
      write: true,
      commit: true,
      formalCommit: true,
      agentAutoApply: true,
      rollback: true,
      memoryWrite: true,
      sourcePath: "/tmp/source.md",
      targetPath: "/tmp/target.md",
      absolutePath: "/tmp/absolute.md",
      rawPatch: "raw patch",
      patch: "patch",
      directStateJson: "{}",
      markdownContent: "# chapter",
      stateJson: "{}",
      testHooks: true,
      unsafeOverride: true,
    } as never);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/commit/preview",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectPath: "/tmp/story-project",
          chapter: 1,
          requestId: "req-1",
        }),
      }),
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty("confirm");
    expect(body).not.toHaveProperty("apply");
    expect(body).not.toHaveProperty("write");
    expect(body).not.toHaveProperty("commit");
    expect(body).not.toHaveProperty("formalCommit");
    expect(body).not.toHaveProperty("agentAutoApply");
    expect(body).not.toHaveProperty("rollback");
    expect(body).not.toHaveProperty("memoryWrite");
    expect(body).not.toHaveProperty("sourcePath");
    expect(body).not.toHaveProperty("targetPath");
    expect(body).not.toHaveProperty("absolutePath");
    expect(body).not.toHaveProperty("rawPatch");
    expect(body).not.toHaveProperty("patch");
    expect(body).not.toHaveProperty("directStateJson");
    expect(body).not.toHaveProperty("markdownContent");
    expect(body).not.toHaveProperty("stateJson");
    expect(body).not.toHaveProperty("testHooks");
    expect(body).not.toHaveProperty("unsafeOverride");
    expect(result.formalCommitPreview?.didFormalCommit).toBe(false);
  });
});

async function captureApplyCommitError(): Promise<unknown> {
  try {
    await applyCommit({
      projectPath: "/tmp/story-project",
      chapter: 1,
      transactionId: "tx-1",
      previewHash: "hash-1",
      selectiveConfirmation: {
        assetDecisions: [],
        locationDecisions: [],
        characterKnowledgeDecisions: [],
      },
    });
  } catch (error) {
    return error;
  }
  throw new Error("expected applyCommit to throw");
}

function jsonResponse(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function abortableNeverResponse(init?: RequestInit): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (!(signal instanceof AbortSignal)) return;
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

function safetyFlags() {
  return {
    noStateJsonWrite: true,
    noMemoryWrite: true,
    noMarkdownWrite: true,
    noFormalCommit: true,
    noPromptInjection: true,
    noConfirmApplyEffect: true,
  } as const;
}

function flattenCopy(copy: ReturnType<typeof summarizeFormalCommitApplyError>): string {
  return [copy.title, copy.message, ...copy.detail].join("\n");
}
