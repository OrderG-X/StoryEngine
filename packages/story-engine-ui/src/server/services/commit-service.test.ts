/**
 * commit-service 持久回执的 tmp 清理回归锁（SWE-2-Max 审计既有旧账）：
 * writeDurableCommitReceipt 全程无 catch 时，open/write/rename 任一失败都会把临时文件漏在
 * .story-engine-ui/commit-idempotency/ 里，被下一次快照扫进 git。
 *
 * 故障注入手法：tmp 文件名 = .<sha256(idempotencyKey)前16位>.<pid>.<Date.now()>.tmp，
 * 用 fake timers 钉死 Date.now() 后名字完全可预测，预先在该处放一个占位文件 →
 * open(tmp, "wx") 独占创建必以 EEXIST 失败（rename(文件→文件) 无法靠文件系统状态造失败，
 * 故故障点选在独占创建这一步）。旧码无 catch → 占位文件残留（红）；新码 catch 清 tmp → 无残留（绿）。
 * 节点内置模块的跨模块 mock 在本 vitest 配置下不生效（externalized），故不用 vi.mock("node:fs/promises")。
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storyEngineMocks = vi.hoisted(() => ({
  buildCommitPlanFromProject: vi.fn(),
  buildStateOverview: vi.fn(),
  checkCommitPlanSemanticQuality: vi.fn(),
  checkDraftBeforeCommit: vi.fn(),
  commitFastDraft: vi.fn(),
  readArcGoalPool: vi.fn(),
  readCharacterBible: vi.fn(),
  readHookPool: vi.fn(),
  readThreadPool: vi.fn(),
  readTimelineEvents: vi.fn(),
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

const snapshotMocks = vi.hoisted(() => ({
  createSnapshot: vi.fn(),
}));

vi.mock("../lib/snapshot.js", () => ({
  ...snapshotMocks,
}));

import { runCommitApply, runCommitPreview } from "./commit-service.js";

const {
  buildCommitPlanFromProject,
  buildStateOverview,
  checkCommitPlanSemanticQuality,
  checkDraftBeforeCommit,
  commitFastDraft,
} = storyEngineMocks;
const { createSnapshot } = snapshotMocks;

const FIXED_NOW = new Date("2026-09-11T06:00:00.000Z");
const DRAFT_CONTENT = "# 第1章\n\n回执临时文件清理测试草稿。";
const IDEMPOTENCY_KEY = "idem-service-tmp-cleanup-0001";

describe("commit-service durable receipt tmp cleanup", () => {
  let projectDir: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    storyEngineMocks.withProjectCommitLock.mockImplementation(async (_projectDir: string, task: () => Promise<unknown>) => task());
    storyEngineMocks.recoverProjectCommitTransactions.mockResolvedValue(undefined);
    buildCommitPlanFromProject.mockResolvedValue({ passed: true, issues: [], commitPlan: { threads: [] } });
    buildStateOverview.mockResolvedValue({ overview: true });
    checkCommitPlanSemanticQuality.mockReturnValue({ passed: true, issues: [] });
    checkDraftBeforeCommit.mockResolvedValue({ passed: true, issues: [] });
    commitFastDraft.mockResolvedValue({
      passed: true,
      chapter: 1,
      updatedCharacters: [],
      timelineEventIds: [],
      updatedHooks: [],
      updatedWorld: false,
      updatedCalendar: false,
      issues: [],
    });
    createSnapshot.mockResolvedValue({ id: "a".repeat(40), label: "入库前快照：第1章", timestamp: 0 });
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (projectDir) {
      await rm(projectDir, { recursive: true, force: true });
      projectDir = undefined;
    }
  });

  it("completed 回执换入失败 → 照常降级为 warning、清掉临时文件、pending 回执原样保留", async () => {
    projectDir = await createProjectFixture();
    const credentials = await previewCredentials(projectDir);
    const receiptDir = join(projectDir, ".story-engine-ui", "commit-idempotency");
    await mkdir(receiptDir, { recursive: true });
    const occupiedTmp = predictedReceiptTmpPath(receiptDir, IDEMPOTENCY_KEY);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIXED_NOW);
    await writeFile(occupiedTmp, "occupied", "utf-8");

    const result = await runCommitApply({
      projectDir,
      chapter: 1,
      policy: {
        kind: "http_durable_receipt",
        idempotencyKey: IDEMPOTENCY_KEY,
        credentials,
      },
    });

    expect(result.kind).toBe("committed");
    // 诚实性契约：入库已成功、回执落盘失败必须如实降级为 warning，不许静默。
    expect(result.kind === "committed" ? result.httpPayload?.warnings : []).toEqual(
      expect.arrayContaining([expect.stringContaining("idempotency receipt persistence failed")]),
    );
    expect(commitFastDraft).toHaveBeenCalledTimes(1);
    // 回归锁：临时文件（含占位文件）一个不留。
    const residue = (await readdir(receiptDir)).filter((entry) => entry.endsWith(".tmp"));
    expect(residue).toEqual([]);
    // 绝不删证据：claim 阶段落盘的 pending 回执必须原样保留，供下次同键重试走磁盘对账恢复。
    const receiptFiles = (await readdir(receiptDir)).filter((entry) => entry.endsWith(".json"));
    expect(receiptFiles).toHaveLength(1);
    const stored = JSON.parse(await readFile(join(receiptDir, receiptFiles[0]!), "utf-8")) as { status: string };
    expect(stored.status).toBe("pending");
  });

  it("pending 恢复出口补写 completed 回执失败 → 恢复响应照给、带 warning、无 tmp 残留、pending 不丢", async () => {
    projectDir = await createProjectFixture();
    const credentials = await previewCredentials(projectDir);
    // 模拟「入库已成功、completed 回执未及落盘进程即死」：正式章已按草稿原文写入，回执停在 pending。
    await mkdir(join(projectDir, "chapters"), { recursive: true });
    await writeFile(join(projectDir, "chapters", "0001.md"), DRAFT_CONTENT, "utf-8");
    const receiptDir = join(projectDir, ".story-engine-ui", "commit-idempotency");
    await mkdir(receiptDir, { recursive: true });
    const pendingReceiptFileName = `${createHash("sha256")
      .update(`${resolve(projectDir)}\u0000${1}\u0000${IDEMPOTENCY_KEY}`, "utf-8")
      .digest("hex")}.json`;
    const pendingReceiptText = `${JSON.stringify({
      version: 1,
      status: "pending",
      projectHash: createHash("sha256").update(resolve(projectDir), "utf-8").digest("hex"),
      chapter: 1,
      idempotencyKey: IDEMPOTENCY_KEY,
      transactionId: credentials.transactionId,
      previewHash: credentials.previewHash,
      createdAt: "2026-09-10T00:00:00.000Z",
    }, null, 2)}\n`;
    await writeFile(join(receiptDir, pendingReceiptFileName), pendingReceiptText, "utf-8");
    const occupiedTmp = predictedReceiptTmpPath(receiptDir, IDEMPOTENCY_KEY);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIXED_NOW);
    await writeFile(occupiedTmp, "occupied", "utf-8");

    const result = await runCommitApply({
      projectDir,
      chapter: 1,
      policy: {
        kind: "http_durable_receipt",
        idempotencyKey: IDEMPOTENCY_KEY,
        credentials,
      },
    });

    expect(result.kind).toBe("recovered");
    // 恢复不是重做：绝不重跑入库、不重拍快照。
    expect(commitFastDraft).not.toHaveBeenCalled();
    expect(createSnapshot).not.toHaveBeenCalled();
    if (result.kind !== "recovered") throw new Error("expected recovered result");
    expect(result.payload.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("idempotency receipt persistence failed after recovered commit")]),
    );
    const residue = (await readdir(receiptDir)).filter((entry) => entry.endsWith(".tmp"));
    expect(residue).toEqual([]);
    // pending 证据逐字节保留（补写失败只是没换成 completed，绝不删证据）。
    await expect(readFile(join(receiptDir, pendingReceiptFileName), "utf-8")).resolves.toBe(pendingReceiptText);
  });
});

async function createProjectFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "story-engine-commit-service-"));
  await mkdir(join(root, "drafts", "fast"), { recursive: true });
  await writeFile(join(root, "drafts", "fast", "chapter-0001.md"), DRAFT_CONTENT, "utf-8");
  return root;
}

async function previewCredentials(
  projectDir: string,
): Promise<{ readonly transactionId: string; readonly previewHash: string; readonly idempotencyKey: string }> {
  const preview = await runCommitPreview({
    projectDir,
    chapter: 1,
    judge: async ({ deterministicQuality }) => deterministicQuality,
  });
  if (preview.kind !== "preview") throw new Error(`expected preview result, got ${preview.kind}`);
  return {
    transactionId: preview.transaction.transactionId,
    previewHash: preview.transaction.previewHash,
    idempotencyKey: IDEMPOTENCY_KEY,
  };
}

/** 与 writeDurableCommitReceipt 的 tmp 命名逐字同源（fake timers 钉死 Date.now 后才可预测）。 */
function predictedReceiptTmpPath(receiptDir: string, idempotencyKey: string): string {
  const digest = createHash("sha256").update(idempotencyKey, "utf-8").digest("hex").slice(0, 16);
  return join(receiptDir, `.${digest}.${process.pid}.${FIXED_NOW.getTime()}.tmp`);
}
