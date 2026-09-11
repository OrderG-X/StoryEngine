import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import { registerCommitRoutes } from "./commit.js";
import type { Middleware } from "../lib/project-io.js";

const storyEngineMocks = vi.hoisted(() => ({
  buildCommitPlanFromProject: vi.fn(),
  buildStateOverview: vi.fn(),
  buildSelectiveCommitPlan: vi.fn(),
  checkCommitPlanSemanticQuality: vi.fn(),
  checkDraftBeforeCommit: vi.fn(),
  commitFastDraft: vi.fn(),
  recoverProjectCommitTransactions: vi.fn(async () => undefined),
  withProjectCommitLock: vi.fn(async (_projectDir: string, task: () => Promise<unknown>) => task()),
}));

vi.mock("@actalk/story-engine", () => ({
  ...storyEngineMocks,
  normalizeDraftRevisionPreview: vi.fn((value: unknown) => value),
}));

const qualityJudgeMocks = vi.hoisted(() => ({
  judgeDraftQualityWithModel: vi.fn(),
}));

vi.mock("../lib/quality-judge.js", () => ({
  ...qualityJudgeMocks,
}));

const serverPreflightMocks = vi.hoisted(() => ({
  buildFormalCommitApplyServerPreflight: vi.fn(),
}));

vi.mock("../lib/formal-commit-apply-server-preflight.js", () => ({
  ...serverPreflightMocks,
}));

const dryRunPlanMocks = vi.hoisted(() => ({
  buildFormalCommitApplyDryRunPlan: vi.fn(),
}));

vi.mock("../lib/formal-commit-apply-dry-run-plan.js", () => ({
  ...dryRunPlanMocks,
}));

const executionScaffoldMocks = vi.hoisted(() => ({
  buildFormalCommitTransactionExecutionScaffold: vi.fn(),
}));

vi.mock("../lib/formal-commit-transaction-execution-scaffold.js", () => ({
  ...executionScaffoldMocks,
}));

const executionPlanMocks = vi.hoisted(() => ({
  buildFormalCommitTransactionExecutionPlan: vi.fn(),
}));

vi.mock("../lib/formal-commit-transaction-execution-plan.js", () => ({
  ...executionPlanMocks,
}));

const snapshotPlanMocks = vi.hoisted(() => ({
  buildFormalCommitPreApplySnapshotPlan: vi.fn(),
}));

vi.mock("../lib/formal-commit-pre-apply-snapshot-plan.js", () => ({
  ...snapshotPlanMocks,
}));

const snapshotMocks = vi.hoisted(() => ({
  createSnapshot: vi.fn(),
}));

vi.mock("../lib/snapshot.js", () => ({
  ...snapshotMocks,
}));

const {
  buildCommitPlanFromProject,
  buildStateOverview,
  buildSelectiveCommitPlan,
  checkCommitPlanSemanticQuality,
  checkDraftBeforeCommit,
  commitFastDraft,
  withProjectCommitLock,
} = storyEngineMocks;
const { createSnapshot } = snapshotMocks;
const { judgeDraftQualityWithModel } = qualityJudgeMocks;
const { buildFormalCommitApplyServerPreflight } = serverPreflightMocks;
const { buildFormalCommitApplyDryRunPlan } = dryRunPlanMocks;
const { buildFormalCommitTransactionExecutionScaffold } = executionScaffoldMocks;
const { buildFormalCommitTransactionExecutionPlan } = executionPlanMocks;
const { buildFormalCommitPreApplySnapshotPlan } = snapshotPlanMocks;

describe("commit routes", () => {
  let projectDir: string | undefined;
  const routeLockTails = new Map<string, Promise<unknown>>();

  beforeEach(() => {
    vi.clearAllMocks();
    routeLockTails.clear();
    withProjectCommitLock.mockImplementation(async (project: string, task: () => Promise<unknown>) => {
      const previous = routeLockTails.get(project) ?? Promise.resolve();
      const run = previous.catch(() => undefined).then(task);
      routeLockTails.set(project, run);
      try {
        return await run;
      } finally {
        if (routeLockTails.get(project) === run) routeLockTails.delete(project);
      }
    });
    buildCommitPlanFromProject.mockResolvedValue({
      passed: true,
      issues: [],
      commitPlan: { threads: [] },
    });
    buildStateOverview.mockResolvedValue({ overview: true });
    buildSelectiveCommitPlan.mockReturnValue({ threads: [] });
    checkDraftBeforeCommit.mockResolvedValue(qualityReport("draft-ok"));
    checkCommitPlanSemanticQuality.mockReturnValue(qualityReport("semantic-ok"));
    judgeDraftQualityWithModel.mockImplementation(async ({ deterministicQuality }: { deterministicQuality: unknown }) => deterministicQuality);
    commitFastDraft.mockResolvedValue({ passed: true });
    createSnapshot.mockResolvedValue({ id: "a".repeat(40), label: "入库前快照：第1章", timestamp: 0 });
    buildFormalCommitApplyDryRunPlan.mockReturnValue({
      ok: true,
      plan: dryRunPlanFixture(),
    });
    buildFormalCommitTransactionExecutionScaffold.mockReturnValue(executionScaffoldFixture());
    buildFormalCommitTransactionExecutionPlan.mockReturnValue({
      ok: true,
      plan: executionPlanFixture(),
      rejectedFiles: [],
    });
    buildFormalCommitPreApplySnapshotPlan.mockResolvedValue({
      ok: true,
      plan: snapshotPlanFixture(),
      rejectedFiles: [],
    });
  });

  afterEach(async () => {
    if (projectDir) {
      await rm(projectDir, { recursive: true, force: true });
      projectDir = undefined;
    }
  });

  it("keeps commit preview available as a read-only dry-run", async () => {
    projectDir = await createProjectFixture();

    const response = await callCommitRoute("/api/commit/preview", {
      projectPath: projectDir,
      chapter: 1,
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload).toMatchObject({
      ok: true,
      commitPlan: { passed: true },
      draftQuality: { passed: true },
      semanticQuality: { passed: true },
      transaction: {
        version: "transaction-hardening-v1",
        chapter: 1,
      },
      formalCommitPreview: {
        status: "blocked",
        dryRun: true,
        readOnly: true,
        didWriteState: false,
        didWriteMarkdown: false,
        didWriteMemory: false,
        didFormalCommit: false,
        canConfirm: false,
        confirmUnavailable: true,
      },
    });
    expect(response.payload.formalCommitPreview).toMatchObject({
      blockingReasons: expect.arrayContaining([
        "missing_snapshot_manifest",
        "missing_transaction_backup",
        "server_validation_unavailable",
        "formal_commit_confirm_unavailable",
      ]),
      chapterOnlyConfirmReadiness: {
        status: "ready",
        blockingReasons: [],
        confirmRequestContextAvailable: true,
        serverFlagRequiredForWrite: true,
        fullFormalCommitReady: false,
        doesNotUpdateState: true,
        readinessStatus: "ready_for_formal_review",
      },
      wouldChangeFiles: ["chapters/0001.md"],
    });
    expect(typeof response.payload.transactionId).toBe("string");
    expect(typeof response.payload.previewHash).toBe("string");
    expect(buildCommitPlanFromProject).toHaveBeenCalledTimes(1);
    expect(checkDraftBeforeCommit).toHaveBeenCalledTimes(1);
    expect(judgeDraftQualityWithModel).toHaveBeenCalledTimes(2);
    expect(commitFastDraft).not.toHaveBeenCalled();
    await expect(access(join(projectDir, "chapters", "0001.md"))).rejects.toThrow();
  });

  it("returns chapter-only confirm hashes from the current draft and committed chapter", async () => {
    projectDir = await createProjectFixture();
    await mkdir(join(projectDir, "chapters"), { recursive: true });
    await writeFile(join(projectDir, "chapters", "0001.md"), "# 第1章\n\n旧正式正文。", "utf-8");
    const draftMarkdown = await readFile(join(projectDir, "drafts", "fast", "chapter-0001.md"), "utf-8");
    const committedMarkdown = await readFile(join(projectDir, "chapters", "0001.md"), "utf-8");

    const response = await callCommitRoute("/api/commit/preview", {
      projectPath: projectDir,
      chapter: 1,
    });

    expect(response.statusCode).toBe(200);
    const formalCommitPreview = response.payload.formalCommitPreview as {
      readonly confirmRequestContext: {
        readonly previewHash: string;
        readonly baseHash: string;
        readonly workspaceDraftId: string;
      };
    };
    const transaction = response.payload.transaction as {
      readonly previewHash: string;
      readonly projectHash: string;
    };
    expect(formalCommitPreview).toMatchObject({
      confirmRequestContext: {
        projectPath: projectDir,
        chapterTarget: 1,
        previewHash: sha256(draftMarkdown),
        workspaceDraftId: sha256(draftMarkdown),
        baseHash: sha256(committedMarkdown),
        readinessStatus: "ready_for_formal_review",
      },
      chapterOnlyConfirmReadiness: {
        status: "ready",
        blockingReasons: [],
        confirmRequestContextAvailable: true,
      },
    });
    expect(formalCommitPreview.confirmRequestContext.previewHash).not.toBe(transaction.previewHash);
    expect(formalCommitPreview.confirmRequestContext.baseHash).not.toBe(transaction.projectHash);
  });

  it("returns controlled no-write response for forbidden preview fields", async () => {
    projectDir = await createProjectFixture();

    const response = await callCommitRoute("/api/commit/preview", {
      projectPath: projectDir,
      chapter: 1,
      rawPatchText: "@@ malicious",
      arbitraryFilePath: "/tmp/outside.md",
      confirm: true,
      apply: true,
      write: true,
      commit: true,
      agentAutoApply: true,
      rollback: true,
      memoryWrite: true,
      formalCommit: true,
    });

    expect(response.statusCode).toBe(400);
    expect(response.payload).toMatchObject({
      ok: false,
      reason: "formal_commit_preview_forbidden_fields",
      formalCommitPreview: {
        status: "blocked",
        dryRun: true,
        readOnly: true,
        didWriteState: false,
        didWriteMarkdown: false,
        didWriteMemory: false,
        didFormalCommit: false,
        canConfirm: false,
      },
    });
    expect(response.payload.forbiddenFields).toEqual([
      "rawPatchText",
      "arbitraryFilePath",
      "confirm",
      "apply",
      "write",
      "commit",
      "agentAutoApply",
      "rollback",
      "memoryWrite",
      "formalCommit",
    ]);
    expect(buildCommitPlanFromProject).not.toHaveBeenCalled();
    expect(commitFastDraft).not.toHaveBeenCalled();
    await expect(access(join(projectDir, "chapters", "0001.md"))).rejects.toThrow();
  });

  it("returns controlled no-write response for missing preview project path", async () => {
    const response = await callCommitRoute("/api/commit/preview", {
      chapter: 1,
    });

    expect(response.statusCode).toBe(400);
    expect(response.payload).toMatchObject({
      ok: false,
      reason: "formal_commit_preview_missing_project_path",
      formalCommitPreview: {
        status: "blocked",
        blockingReasons: expect.arrayContaining(["missing_project_path"]),
        didWriteState: false,
        didWriteMarkdown: false,
        didWriteMemory: false,
        didFormalCommit: false,
      },
    });
    expect(buildCommitPlanFromProject).not.toHaveBeenCalled();
  });

  it("returns controlled no-write response for missing preview chapter target", async () => {
    projectDir = await createProjectFixture();

    const response = await callCommitRoute("/api/commit/preview", {
      projectPath: projectDir,
    });

    expect(response.statusCode).toBe(400);
    expect(response.payload).toMatchObject({
      ok: false,
      reason: "formal_commit_preview_missing_chapter_target",
      formalCommitPreview: {
        status: "blocked",
        blockingReasons: expect.arrayContaining(["missing_chapter_target"]),
        didFormalCommit: false,
      },
    });
    expect(buildCommitPlanFromProject).not.toHaveBeenCalled();
  });

  it("applies the full commit and returns the report, overview, and chapter content", async () => {
    projectDir = await createProjectFixture();
    buildCommitPlanFromProject.mockResolvedValue({
      passed: true,
      issues: [],
      commitPlan: { title: "第1章", timelineEvents: [{ summary: "事件", participants: [] }] },
    });
    commitFastDraft.mockResolvedValue({
      passed: true,
      chapter: 1,
      chapterPath: join(projectDir, "chapters", "0001.md"),
      updatedCharacters: ["lin-xiao"],
      timelineEventIds: ["evt-1"],
      updatedHooks: [],
      updatedWorld: false,
      updatedCalendar: false,
      issues: [],
    });
    buildStateOverview.mockResolvedValue({ overview: true });
    const applyBody = await previewApplyBody(projectDir, "idem-full-commit-0001");

    const response = await callCommitRoute("/api/commit/apply", {
      ...applyBody,
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload).toMatchObject({ ok: true, overview: { overview: true } });
    expect(response.payload.report).toMatchObject({ passed: true, updatedCharacters: ["lin-xiao"] });
    expect(typeof response.payload.chapterContent).toBe("string");
    // 写入前自动快照，整份提交可撤销
    expect(createSnapshot).toHaveBeenCalledWith(projectDir, "入库前快照：第1章");
    // 完整状态提交交给引擎 commitFastDraft，传入整份计划（不再逐条勾选、不再拒绝状态 JSON）
    expect(commitFastDraft).toHaveBeenCalledWith(expect.objectContaining({
      projectDir,
      chapter: 1,
      commitPlan: expect.objectContaining({ title: "第1章" }),
    }));
  });

  it("returns 409 when the commit plan is not applyable", async () => {
    projectDir = await createProjectFixture();
    buildCommitPlanFromProject.mockResolvedValue({ passed: false, issues: ["缺少草稿语义"], commitPlan: null });
    const applyBody = await previewApplyBody(projectDir, "idem-invalid-plan-0001");

    const response = await callCommitRoute("/api/commit/apply", applyBody);

    expect(response.statusCode).toBe(409);
    expect(response.payload).toMatchObject({ ok: false, reason: "commit_plan_not_applyable" });
    expect(commitFastDraft).not.toHaveBeenCalled();
    expect(createSnapshot).not.toHaveBeenCalled();
  });

  it("returns 409 and keeps the pre-write snapshot when commitFastDraft fails", async () => {
    projectDir = await createProjectFixture();
    commitFastDraft.mockResolvedValue({
      passed: false,
      chapter: 1,
      issues: ["Hook not found: h1"],
      updatedCharacters: [],
      timelineEventIds: [],
      updatedHooks: [],
      updatedWorld: false,
      updatedCalendar: false,
    });
    const applyBody = await previewApplyBody(projectDir, "idem-engine-fail-0001");

    const response = await callCommitRoute("/api/commit/apply", applyBody);

    expect(response.statusCode).toBe(409);
    expect(response.payload).toMatchObject({ ok: false, reason: "commit_failed" });
    // 快照在写入尝试前已创建，失败也能从操作历史回退
    expect(createSnapshot).toHaveBeenCalledWith(projectDir, "入库前快照：第1章");
  });

  it.each(["transactionId", "previewHash", "idempotencyKey"] as const)(
    "rejects apply with missing %s before snapshot or commit writes",
    async (missingField) => {
      projectDir = await createProjectFixture();
      const complete = await previewApplyBody(projectDir, "idem-required-fields-0001");
      const body = { ...complete };
      delete body[missingField];

      const response = await callCommitRoute("/api/commit/apply", body);

      expect(response.statusCode).toBe(409);
      expect(response.payload).toMatchObject({
        ok: false,
        reason: "formal_commit_apply_transaction_preflight_failed",
        transactionPreflight: { ok: false },
      });
      expect(createSnapshot).not.toHaveBeenCalled();
      expect(commitFastDraft).not.toHaveBeenCalled();
    },
  );

  it("rejects both a stale transaction id and a stale preview hash after the previewed draft changes", async () => {
    projectDir = await createProjectFixture();
    const first = await previewApplyBody(projectDir, "idem-stale-preview-0001");
    await writeFile(
      join(projectDir, "drafts", "fast", "chapter-0001.md"),
      "# 第1章\n\n预览之后又编辑过的测试草稿。",
      "utf-8",
    );
    const current = await previewApplyBody(projectDir, "idem-stale-preview-current-0001");
    vi.clearAllMocks();

    const staleTransaction = await callCommitRoute("/api/commit/apply", {
      ...current,
      transactionId: first.transactionId,
      idempotencyKey: "idem-stale-transaction-0001",
    });
    const stalePreviewHash = await callCommitRoute("/api/commit/apply", {
      ...current,
      previewHash: first.previewHash,
      idempotencyKey: "idem-stale-hash-0001",
    });

    expect(staleTransaction.statusCode).toBe(409);
    expect(staleTransaction.payload).toMatchObject({
      ok: false,
      reason: "formal_commit_apply_transaction_preflight_failed",
      transactionPreflight: { ok: false, code: "transaction_id_mismatch" },
    });
    expect(stalePreviewHash.statusCode).toBe(409);
    expect(stalePreviewHash.payload).toMatchObject({
      ok: false,
      reason: "formal_commit_apply_transaction_preflight_failed",
      transactionPreflight: { ok: false, code: "preview_hash_mismatch" },
    });
    expect(createSnapshot).not.toHaveBeenCalled();
    expect(commitFastDraft).not.toHaveBeenCalled();
  });

  it("replays the original successful response for the same project/chapter idempotency key without writing twice", async () => {
    projectDir = await createProjectFixture();
    commitFastDraft.mockResolvedValue({
      passed: true,
      chapter: 1,
      updatedCharacters: ["original-report"],
      timelineEventIds: [],
      updatedHooks: [],
      updatedWorld: false,
      updatedCalendar: false,
      issues: [],
    });
    const applyBody = await previewApplyBody(projectDir, "idem-replay-original-0001");

    const first = await callCommitRoute("/api/commit/apply", applyBody);
    commitFastDraft.mockResolvedValue({ passed: true, updatedCharacters: ["must-not-run"] });
    const replay = await callCommitRoute("/api/commit/apply", applyBody);

    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.payload).toMatchObject({
      ...first.payload,
      idempotencyReplayed: true,
      report: { updatedCharacters: ["original-report"] },
    });
    expect(createSnapshot).toHaveBeenCalledTimes(1);
    expect(commitFastDraft).toHaveBeenCalledTimes(1);
  });

  it("scopes identical idempotency keys by project and chapter", async () => {
    projectDir = await createProjectFixture();
    const secondProjectDir = await createProjectFixture();
    try {
      const firstBody = await previewApplyBody(projectDir, "idem-shared-project-scope");
      const secondBody = await previewApplyBody(secondProjectDir, "idem-shared-project-scope");
      vi.clearAllMocks();
      commitFastDraft.mockResolvedValue({ passed: true, updatedCharacters: [] });
      buildStateOverview.mockResolvedValue({ overview: true });
      createSnapshot.mockResolvedValue({ id: "b".repeat(40) });

      const first = await callCommitRoute("/api/commit/apply", firstBody);
      const second = await callCommitRoute("/api/commit/apply", secondBody);

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(commitFastDraft).toHaveBeenCalledTimes(2);
      expect(createSnapshot).toHaveBeenCalledTimes(2);
    } finally {
      await rm(secondProjectDir, { recursive: true, force: true });
    }
  });

  it("allows only one in-flight apply per project and chapter even when idempotency keys differ", async () => {
    projectDir = await createProjectFixture();
    const firstBody = await previewApplyBody(projectDir, "idem-concurrent-first-0001");
    const secondBody = { ...firstBody, idempotencyKey: "idem-concurrent-second-0001" };
    vi.clearAllMocks();
    buildCommitPlanFromProject.mockResolvedValue({ passed: true, issues: [], commitPlan: { threads: [] } });
    buildStateOverview.mockResolvedValue({ overview: true });
    createSnapshot.mockResolvedValue({ id: "c".repeat(40) });
    const commitGate = deferred<Record<string, unknown>>();
    const secondCommitReached = deferred<undefined>();
    commitFastDraft.mockImplementation(() => {
      if (commitFastDraft.mock.calls.length >= 2) secondCommitReached.resolve(undefined);
      return commitGate.promise;
    });

    const firstPending = callCommitRoute("/api/commit/apply", firstBody);
    await vi.waitFor(() => expect(commitFastDraft).toHaveBeenCalledTimes(1));
    const concurrentPending = callCommitRoute("/api/commit/apply", secondBody);
    const concurrentOutcome = await Promise.race([
      concurrentPending.then((response) => ({ kind: "response" as const, response })),
      secondCommitReached.promise.then(() => ({ kind: "second_commit" as const })),
    ]);
    commitGate.resolve({ passed: true, updatedCharacters: ["first-only"] });
    const concurrent = await concurrentPending;

    expect(concurrentOutcome.kind).toBe("response");
    expect(concurrent.statusCode).toBe(409);
    expect(concurrent.payload).toMatchObject({
      ok: false,
      reason: "formal_commit_apply_chapter_busy",
    });
    expect(createSnapshot).toHaveBeenCalledTimes(1);
    expect(commitFastDraft).toHaveBeenCalledTimes(1);

    const first = await firstPending;
    expect(first.statusCode).toBe(200);
  });

  it("serializes and rechecks a delayed same-key request instead of claiming twice", async () => {
    projectDir = await createProjectFixture();
    const applyBody = await previewApplyBody(projectDir, "idem-delayed-double-miss-0001");
    vi.clearAllMocks();
    const plan = { passed: true, issues: [], commitPlan: { threads: [] } };
    const firstPlanGate = deferred<typeof plan>();
    buildCommitPlanFromProject.mockReturnValueOnce(firstPlanGate.promise);
    commitFastDraft.mockResolvedValue({ passed: true, updatedCharacters: ["original-only"] });
    buildStateOverview.mockResolvedValue({ overview: true });
    createSnapshot.mockResolvedValue({ id: "d".repeat(40) });

    const firstPending = callCommitRoute("/api/commit/apply", applyBody);
    const secondPending = callCommitRoute("/api/commit/apply", applyBody);
    await vi.waitFor(() => expect(buildCommitPlanFromProject).toHaveBeenCalledTimes(1));
    firstPlanGate.resolve(plan);
    const first = await firstPending;
    expect(first.statusCode).toBe(200);

    const second = await secondPending;

    expect(second.statusCode).toBe(200);
    expect(second.payload).toMatchObject({
      idempotencyReplayed: true,
      report: { updatedCharacters: ["original-only"] },
    });
    expect(createSnapshot).toHaveBeenCalledTimes(1);
    expect(commitFastDraft).toHaveBeenCalledTimes(1);
    expect(buildCommitPlanFromProject).toHaveBeenCalledTimes(1);
  });

  it("rejects when the draft changes while the pre-write snapshot is being created", async () => {
    projectDir = await createProjectFixture();
    const applyBody = await previewApplyBody(projectDir, "idem-snapshot-edit-0001");
    vi.clearAllMocks();
    buildCommitPlanFromProject.mockResolvedValue({ passed: true, issues: [], commitPlan: { threads: [] } });
    const snapshotGate = deferred<{ id: string }>();
    createSnapshot.mockReturnValue(snapshotGate.promise);
    commitFastDraft.mockResolvedValue({ passed: true, updatedCharacters: [] });

    const pending = callCommitRoute("/api/commit/apply", applyBody);
    await vi.waitFor(() => expect(createSnapshot).toHaveBeenCalledTimes(1));
    await writeFile(
      join(projectDir, "drafts", "fast", "chapter-0001.md"),
      "# 第1章\n\n快照期间被自动保存替换的新正文。",
      "utf-8",
    );
    snapshotGate.resolve({ id: "e".repeat(40) });
    const response = await pending;

    expect(response.statusCode).toBe(409);
    expect(response.payload).toMatchObject({ ok: false, reason: "formal_commit_apply_draft_changed" });
    expect(commitFastDraft).not.toHaveBeenCalled();
  });

  it("keeps a successful business commit truthful when overview refresh fails", async () => {
    projectDir = await createProjectFixture();
    const applyBody = await previewApplyBody(projectDir, "idem-overview-failure-0001");
    vi.clearAllMocks();
    buildCommitPlanFromProject.mockResolvedValue({ passed: true, issues: [], commitPlan: { threads: [] } });
    createSnapshot.mockResolvedValue({ id: "f".repeat(40) });
    commitFastDraft.mockResolvedValue({
      passed: true,
      chapter: 1,
      updatedCharacters: ["committed-before-overview"],
      timelineEventIds: [],
      updatedHooks: [],
      updatedWorld: false,
      updatedCalendar: false,
      issues: [],
    });
    buildStateOverview.mockRejectedValue(new Error("overview unavailable after commit"));

    const response = await callCommitRoute("/api/commit/apply", applyBody);

    expect(response.statusCode).toBe(200);
    expect(response.payload).toMatchObject({
      ok: true,
      report: { passed: true, updatedCharacters: ["committed-before-overview"] },
      overview: null,
      warnings: expect.arrayContaining([expect.stringContaining("overview")]),
    });
    expect(commitFastDraft).toHaveBeenCalledTimes(1);
  });

  it("persists a durable receipt so a fresh route module replays success without reapplying", async () => {
    projectDir = await createProjectFixture();
    const applyBody = await previewApplyBody(projectDir, "idem-durable-restart-0001");
    commitFastDraft.mockResolvedValue({
      passed: true,
      chapter: 1,
      updatedCharacters: ["durable-original"],
      timelineEventIds: [],
      updatedHooks: [],
      updatedWorld: false,
      updatedCalendar: false,
      issues: [],
    });

    const first = await callCommitRoute("/api/commit/apply", applyBody);
    expect(first.statusCode).toBe(200);
    const receiptDir = join(projectDir, ".story-engine-ui", "commit-idempotency");
    const receiptFiles = await readdir(receiptDir);
    expect(receiptFiles).toHaveLength(1);

    vi.resetModules();
    const freshRegistrar = (await import("./commit.js")).registerCommitRoutes;
    commitFastDraft.mockResolvedValue({ passed: true, updatedCharacters: ["must-not-run-after-restart"] });
    const replay = await callCommitRoute("/api/commit/apply", applyBody, freshRegistrar);

    expect(replay.statusCode).toBe(200);
    expect(replay.payload).toMatchObject({
      idempotencyReplayed: true,
      report: { updatedCharacters: ["durable-original"] },
    });
    expect(commitFastDraft).toHaveBeenCalledTimes(1);
  });

  it("rejects reuse of a durable idempotency key with different preview credentials", async () => {
    projectDir = await createProjectFixture();
    const applyBody = await previewApplyBody(projectDir, "idem-durable-collision-0001");
    const first = await callCommitRoute("/api/commit/apply", applyBody);
    expect(first.statusCode).toBe(200);

    const collision = await callCommitRoute("/api/commit/apply", {
      ...applyBody,
      previewHash: "0".repeat(64),
    });

    expect(collision.statusCode).toBe(409);
    expect(collision.payload).toMatchObject({
      ok: false,
      reason: "formal_commit_apply_idempotency_collision",
    });
    expect(commitFastDraft).toHaveBeenCalledTimes(1);
    expect(createSnapshot).toHaveBeenCalledTimes(1);
  });

  it("rejects a changed idempotency key for an already completed preview transaction", async () => {
    projectDir = await createProjectFixture();
    const applyBody = await previewApplyBody(projectDir, "idem-original-transaction-0001");
    const first = await callCommitRoute("/api/commit/apply", applyBody);
    expect(first.statusCode).toBe(200);

    const bypass = await callCommitRoute("/api/commit/apply", {
      ...applyBody,
      idempotencyKey: "idem-changed-transaction-0002",
    });

    expect(bypass.statusCode).toBe(409);
    expect(bypass.payload).toMatchObject({
      ok: false,
      reason: "formal_commit_apply_transaction_already_claimed",
    });
    expect(commitFastDraft).toHaveBeenCalledTimes(1);
    expect(createSnapshot).toHaveBeenCalledTimes(1);
  });

  it("rejects a changed key when the same preview transaction has an uncertain pending receipt", async () => {
    projectDir = await createProjectFixture();
    const applyBody = await previewApplyBody(projectDir, "idem-original-pending-0001");
    const receiptDir = join(projectDir, ".story-engine-ui", "commit-idempotency");
    await mkdir(receiptDir, { recursive: true });
    const cacheKey = `${projectDir}\u0000${applyBody.chapter}\u0000${applyBody.idempotencyKey}`;
    const fileName = `${createHash("sha256").update(cacheKey, "utf-8").digest("hex")}.json`;
    await writeFile(join(receiptDir, fileName), `${JSON.stringify({
      version: 1,
      status: "pending",
      projectHash: createHash("sha256").update(projectDir, "utf-8").digest("hex"),
      chapter: applyBody.chapter,
      idempotencyKey: applyBody.idempotencyKey,
      transactionId: applyBody.transactionId,
      previewHash: applyBody.previewHash,
      createdAt: "2026-07-13T00:00:00.000Z",
    }, null, 2)}\n`, "utf-8");

    const bypass = await callCommitRoute("/api/commit/apply", {
      ...applyBody,
      idempotencyKey: "idem-changed-pending-0002",
    });

    expect(bypass.statusCode).toBe(409);
    expect(bypass.payload).toMatchObject({
      ok: false,
      reason: "formal_commit_apply_transaction_already_claimed",
    });
    expect(commitFastDraft).not.toHaveBeenCalled();
    expect(createSnapshot).not.toHaveBeenCalled();
  });

  it("recovers a crash between the successful commit and the durable receipt write (disk reconciliation, no redo)", async () => {
    projectDir = await createProjectFixture();
    const applyBody = await previewApplyBody(projectDir, "idem-crash-after-commit-0001");
    // 模拟「commitFastDraft 已成功、completed 回执未及落盘进程即死」：
    // 正式章已按草稿原文写入（引擎侧 chapters/N.md = 草稿逐字），回执停在 pending。
    const draftContent = await readFile(join(projectDir, "drafts", "fast", "chapter-0001.md"), "utf-8");
    await mkdir(join(projectDir, "chapters"), { recursive: true });
    await writeFile(join(projectDir, "chapters", "0001.md"), draftContent, "utf-8");
    const receiptFileName = await writePendingReceiptFixture(projectDir, applyBody);

    const response = await callCommitRoute("/api/commit/apply", applyBody);

    expect(response.statusCode).toBe(200);
    expect(response.payload).toMatchObject({
      ok: true,
      idempotencyRecovered: true,
      overview: { overview: true },
      chapterContent: draftContent,
      chapterTitle: "第1章",
      report: { chapter: 1, passed: true, recoveredFromPendingReceipt: true },
    });
    expect(response.payload.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("恢复")]),
    );
    // P3-1：恢复路径必须如实声明详细变更清单不可恢复、report 里那些零值是占位空值
    expect(response.payload.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("详细变更清单不可恢复"), expect.stringContaining("占位空值")]),
    );
    // 恢复不是重做：绝不重跑入库、不重拍快照
    expect(commitFastDraft).not.toHaveBeenCalled();
    expect(createSnapshot).not.toHaveBeenCalled();
    // 回执已补写为 completed：同键再试直接重放补写的响应，不再对账
    const stored = JSON.parse(await readFile(
      join(projectDir, ".story-engine-ui", "commit-idempotency", receiptFileName),
      "utf-8",
    )) as { status: string; payload?: { ok: boolean } };
    expect(stored).toMatchObject({ status: "completed", payload: { ok: true } });
    const replay = await callCommitRoute("/api/commit/apply", applyBody);
    expect(replay.statusCode).toBe(200);
    expect(replay.payload).toMatchObject({ idempotencyReplayed: true, chapterContent: draftContent });
    expect(commitFastDraft).not.toHaveBeenCalled();
    expect(createSnapshot).not.toHaveBeenCalled();
  });

  it("keeps fail-closed 409 with actionable guidance when the pending receipt's commit never landed", async () => {
    projectDir = await createProjectFixture();
    const applyBody = await previewApplyBody(projectDir, "idem-crash-before-commit-0001");
    // 崩溃发生在入库前：chapters/0001.md 不存在，只有 pending 回执
    const receiptFileName = await writePendingReceiptFixture(projectDir, applyBody);

    const response = await callCommitRoute("/api/commit/apply", applyBody);

    expect(response.statusCode).toBe(409);
    expect(response.payload).toMatchObject({
      ok: false,
      reason: "formal_commit_apply_idempotency_in_progress",
    });
    const message = String(response.payload.error);
    expect(message).toContain("重新生成定稿预览");
    expect(message).toContain(join(".story-engine-ui", "commit-idempotency"));
    expect(message).toContain(receiptFileName);
    // fail-closed 不删证据：pending 回执原样保留
    const stored = JSON.parse(await readFile(
      join(projectDir, ".story-engine-ui", "commit-idempotency", receiptFileName),
      "utf-8",
    )) as { status: string };
    expect(stored.status).toBe("pending");
    expect(commitFastDraft).not.toHaveBeenCalled();
    expect(createSnapshot).not.toHaveBeenCalled();
  });

  it("keeps fail-closed 409 when the committed chapter content does not match the pending receipt's draft", async () => {
    projectDir = await createProjectFixture();
    const applyBody = await previewApplyBody(projectDir, "idem-crash-content-mismatch-0001");
    // 章已入库但内容与本次预览的草稿不一致（入库的不是这份草稿）→ 不得当作恢复
    await mkdir(join(projectDir, "chapters"), { recursive: true });
    await writeFile(join(projectDir, "chapters", "0001.md"), "# 第1章\n\n另一版早已入库的正文。", "utf-8");
    await writePendingReceiptFixture(projectDir, applyBody);

    const response = await callCommitRoute("/api/commit/apply", applyBody);

    expect(response.statusCode).toBe(409);
    expect(response.payload).toMatchObject({
      ok: false,
      reason: "formal_commit_apply_idempotency_in_progress",
    });
    expect(commitFastDraft).not.toHaveBeenCalled();
    expect(createSnapshot).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")("fails closed when the durable receipt directory is a symlink", async () => {
    projectDir = await createProjectFixture();
    const applyBody = await previewApplyBody(projectDir, "idem-receipt-symlink-0001");
    const outsideReceiptDir = await makeHomeTempDir("story-engine-outside-receipt-");
    await mkdir(join(projectDir, ".story-engine-ui"), { recursive: true });
    await symlink(outsideReceiptDir, join(projectDir, ".story-engine-ui", "commit-idempotency"));

    const response = await callCommitRoute("/api/commit/apply", applyBody);

    expect(response.statusCode).toBeGreaterThanOrEqual(409);
    expect(response.payload).toMatchObject({ ok: false });
    expect(commitFastDraft).not.toHaveBeenCalled();
    await expect(readdir(outsideReceiptDir)).resolves.toEqual([]);
  });

  it.skipIf(process.platform === "win32")("rejects a symlinked .story-engine-ui parent and never replays an outside receipt", async () => {
    projectDir = await createProjectFixture();
    const applyBody = await previewApplyBody(projectDir, "idem-outside-parent-0001");
    const outsideUiRoot = await makeHomeTempDir("story-engine-outside-ui-parent-");
    const outsideReceiptDir = join(outsideUiRoot, "commit-idempotency");
    await mkdir(outsideReceiptDir, { recursive: true });
    const cacheKey = `${projectDir}\u0000${applyBody.chapter}\u0000${applyBody.idempotencyKey}`;
    const receiptPath = join(
      outsideReceiptDir,
      `${createHash("sha256").update(cacheKey, "utf-8").digest("hex")}.json`,
    );
    const outsideReceipt = `${JSON.stringify({
      version: 1,
      status: "completed",
      projectHash: createHash("sha256").update(projectDir, "utf-8").digest("hex"),
      chapter: 1,
      idempotencyKey: applyBody.idempotencyKey,
      transactionId: applyBody.transactionId,
      previewHash: applyBody.previewHash,
      createdAt: "2026-07-13T00:00:00.000Z",
      payload: {
        ok: true,
        report: { updatedCharacters: ["outside-forged-replay"] },
        overview: null,
        chapterContent: "outside forged content",
        chapterTitle: "outside forged title",
      },
    }, null, 2)}\n`;
    await writeFile(receiptPath, outsideReceipt, "utf-8");
    await symlink(outsideUiRoot, join(projectDir, ".story-engine-ui"));

    const response = await callCommitRoute("/api/commit/apply", applyBody);

    expect(response.statusCode).toBeGreaterThanOrEqual(409);
    expect(response.payload).toMatchObject({ ok: false });
    expect(response.payload).not.toMatchObject({ report: { updatedCharacters: ["outside-forged-replay"] } });
    expect(commitFastDraft).not.toHaveBeenCalled();
    await expect(readFile(receiptPath, "utf-8")).resolves.toBe(outsideReceipt);
  });
});

async function createProjectFixture(): Promise<string> {
  const root = await makeHomeTempDir("story-engine-ui-commit-route-");
  const draftsDir = join(root, "drafts", "fast");
  await mkdir(draftsDir, { recursive: true });
  await writeFile(join(draftsDir, "chapter-0001.md"), "# 第1章\n\n测试草稿。", "utf-8");
  return root;
}

async function previewApplyBody(
  projectPath: string,
  idempotencyKey: string,
): Promise<{
  projectPath: string;
  chapter: number;
  transactionId: string;
  previewHash: string;
  idempotencyKey: string;
}> {
  const preview = await callCommitRoute("/api/commit/preview", { projectPath, chapter: 1 });
  if (preview.statusCode !== 200) {
    throw new Error(`Expected commit preview to succeed, received ${preview.statusCode}`);
  }
  return {
    projectPath,
    chapter: 1,
    transactionId: String(preview.payload.transactionId),
    previewHash: String(preview.payload.previewHash),
    idempotencyKey,
  };
}

/** 写一份与 applyBody 完全匹配的 pending 回执（模拟「claim 之后、completed 落盘之前」进程中断），返回回执文件名。 */
async function writePendingReceiptFixture(
  projectPath: string,
  applyBody: { chapter: number; transactionId: string; previewHash: string; idempotencyKey: string },
): Promise<string> {
  const receiptDir = join(projectPath, ".story-engine-ui", "commit-idempotency");
  await mkdir(receiptDir, { recursive: true });
  const cacheKey = `${projectPath}\u0000${applyBody.chapter}\u0000${applyBody.idempotencyKey}`;
  const fileName = `${createHash("sha256").update(cacheKey, "utf-8").digest("hex")}.json`;
  await writeFile(join(receiptDir, fileName), `${JSON.stringify({
    version: 1,
    status: "pending",
    projectHash: createHash("sha256").update(projectPath, "utf-8").digest("hex"),
    chapter: applyBody.chapter,
    idempotencyKey: applyBody.idempotencyKey,
    transactionId: applyBody.transactionId,
    previewHash: applyBody.previewHash,
    createdAt: "2026-09-08T00:00:00.000Z",
  }, null, 2)}\n`, "utf-8");
  return fileName;
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function validApplyPreflightBody(projectPath: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectPath,
    chapter: 1,
    confirm: true,
    transactionId: "txv1-ch0001-previewhash",
    previewHash: "preview-hash",
    idempotencyKey: "idem-1234567890",
    currentDraftHash: "draft-a",
    previewDraftHash: "draft-a",
    currentCommitPlanHash: "plan-a",
    previewCommitPlanHash: "plan-a",
    changedFiles: ["chapters/0001.md"],
    rejectedFiles: [],
    unsafeNodes: [],
    txResidue: { status: "clean" },
    ...overrides,
  };
}

function passedServerPreflightFixture(
  changedFiles: readonly string[],
  overrides: { readonly draftHash?: string } = {},
): Record<string, unknown> {
  const draftHash = overrides.draftHash ?? "draft-hash";
  return {
    ok: true,
    currentTransaction: {
      version: "transaction-hardening-v1",
      transactionId: "txv1-ch0001-previewhash",
      previewHash: "preview-hash",
      projectHash: "project-hash",
      chapter: 1,
      draftHash,
      commitPlanHash: "plan-hash",
      selectiveCandidateSummaryHash: "summary-hash",
    },
    transactionPreflight: { ok: true },
    formalPreflight: {
      ok: true,
      changedFiles,
      rejectedFiles: [],
      warnings: [],
      txResidueStatus: "clean",
    },
    formalPreflightInput: {
      confirm: true,
      transactionId: "txv1-ch0001-previewhash",
      previewHash: "preview-hash",
      idempotencyKey: "idem-1234567890",
      currentDraftHash: draftHash,
      previewDraftHash: draftHash,
      currentCommitPlanHash: "plan-hash",
      previewCommitPlanHash: "plan-hash",
      changedFiles,
      txResidue: { status: "clean" },
    },
    residues: [],
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf-8").digest("hex");
}

function dryRunPlanFixture(wouldWriteFiles: readonly string[] = ["chapters/0001.md"]): Record<string, unknown> {
  return {
    version: "formal-commit-apply-dry-run-v0",
    wouldWriteFiles,
    affectedStateAreas: ["chapter_manuscript"],
    forbiddenStateAreas: [],
    riskFlags: ["dry_run_only", "no_production_apply"],
    noWriteConfirmed: true,
    productionApplyImplemented: false,
  };
}

function executionScaffoldFixture(): Record<string, unknown> {
  return {
    ok: false,
    reason: "formal_commit_transaction_execution_not_implemented",
    executionStage: "not_implemented",
    wouldWriteFiles: ["chapters/0001.md"],
    affectedStateAreas: ["chapter_manuscript"],
    noWriteConfirmed: true,
    productionApplyImplemented: false,
    transactionCreated: false,
    committed: false,
  };
}

function executionPlanFixture(): Record<string, unknown> {
  return {
    version: "formal-commit-transaction-execution-plan-v0",
    transactionWouldBeCreated: false,
    transactionDirPreview: ".story-engine-tx/commit-chapter-0001",
    manifestPreview: {
      chapter: 1,
      status: "planned_not_created",
      files: ["chapters/0001.md"],
      createdAt: null,
    },
    rollbackPreview: {
      required: true,
      files: ["chapters/0001.md"],
      strategy: "restore_previous_or_no_partial_write",
      implemented: false,
    },
    noWriteConfirmed: true,
    productionApplyImplemented: false,
  };
}

function snapshotPlanFixture(): Record<string, unknown> {
  return {
    version: "formal-commit-pre-apply-snapshot-plan-v0",
    snapshotWouldBeCreated: false,
    snapshotDirPreview: ".story-engine-tx/commit-chapter-0001/snapshot",
    files: [
      {
        relativePath: "chapters/0001.md",
        existsBeforeApply: false,
        rollbackAction: "delete_if_created",
      },
    ],
    noWriteConfirmed: true,
    productionApplyImplemented: false,
    rollbackSnapshotImplemented: false,
  };
}

async function callCommitRoute(
  path: string,
  body: Record<string, unknown> | string,
  routeRegistrar: typeof registerCommitRoutes = registerCommitRoutes,
): Promise<{
  readonly statusCode: number;
  readonly payload: Record<string, unknown>;
}> {
  const handlers: Middleware[] = [];
  routeRegistrar({ use: (handler) => handlers.push(handler) });
  const rawBody = typeof body === "string" ? body : JSON.stringify(body);
  const req = Object.assign(Readable.from([Buffer.from(rawBody)]), {
    method: "POST",
    url: path,
  }) as IncomingMessage;
  const chunks: Buffer[] = [];
  const res = {
    statusCode: 200,
    setHeader: (name: string, value: string | number | readonly string[]) => {
      void name;
      void value;
      return res as unknown as ServerResponse;
    },
    end: (chunk?: string | Buffer) => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return res as unknown as ServerResponse;
    },
  } as unknown as ServerResponse;

  await new Promise<void>((resolve, reject) => {
    const result = handlers[0]?.(req, res, (error?: unknown) => error ? reject(error) : resolve()) as unknown;
    Promise.resolve(result).then(() => resolve(), reject);
  });

  const payload = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown>;
  return { statusCode: res.statusCode, payload };
}

function qualityReport(id: string): {
  readonly passed: boolean;
  readonly issues: readonly unknown[];
  readonly judgedIssues: readonly unknown[];
  readonly summary: string;
} {
  return {
    passed: true,
    issues: [],
    judgedIssues: [],
    summary: id,
  };
}
