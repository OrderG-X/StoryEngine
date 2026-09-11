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
import { basename, join, resolve } from "node:path";
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

import { commitIdempotencyCacheSizeForTests, runCommitApply, runCommitPreview } from "./commit-service.js";

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


/* ---------------------------------------------------------------------------
 * GLM P3 旧账清账（2026-09-11）的回归锁：
 * ① 声明通道裸 catch → 回退正则必须 console.warn 留痕（章节号+错误摘要，不含草稿正文）；
 * ② pending 对账 IO 失败与「确认对不上」分开 409 文案——IO 失败只说稍后重试，绝不诱导删回执；
 * ③ 幂等内存缓存 50 条 FIFO 上界——超界淘汰最旧；淘汰的是内存加速层，持久回执照常兜底重放。
 * ------------------------------------------------------------------------- */

/** 与上面既有 describe 同一套 mock 基线（独立成函数，供下面三个 describe 的 beforeEach 复用）。 */
function resetMocksBaseline(): void {
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
  createSnapshot.mockResolvedValue({ id: "a".repeat(40), label: "入库前快照", timestamp: 0 });
}

describe("commit-preview 声明通道降级留痕（GLM P3 旧账①）", () => {
  let projectDir: string | undefined;

  beforeEach(() => resetMocksBaseline());

  afterEach(async () => {
    if (projectDir) {
      await rm(projectDir, { recursive: true, force: true });
      projectDir = undefined;
    }
  });

  it("声明模型抛错 → 预览照常（回退正则），且 console.warn 留痕章节号与错误摘要、不含草稿正文", async () => {
    projectDir = await createProjectFixture();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const preview = await runCommitPreview({
        projectDir,
        chapter: 1,
        declarationChannel: {
          declareDelta: async () => {
            throw new Error("声明模型 503");
          },
        },
        judge: async ({ deterministicQuality }) => deterministicQuality,
      });

      // 行为不变：声明降级为缺省（结果不带 declaration 字段），计划走纯正则。
      expect(preview.kind).toBe("preview");
      if (preview.kind === "preview") expect("declaration" in preview).toBe(false);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const warnText = warnSpy.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
      expect(warnText).toContain("ch1");
      expect(warnText).toContain("声明模型 503");
      expect(warnText).not.toContain(DRAFT_CONTENT);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("commit-apply pending 对账报错分流（GLM P3 旧账②）", () => {
  let projectDir: string | undefined;

  beforeEach(() => resetMocksBaseline());

  afterEach(async () => {
    if (projectDir) {
      await rm(projectDir, { recursive: true, force: true });
      projectDir = undefined;
    }
  });

  it("对账读盘 IO 失败 → 409 文案单列「对账读取失败」，绝不诱导删回执，pending 回执原样保留", async () => {
    projectDir = await createProjectFixture();
    const credentials = await previewCredentials(projectDir);
    const pending = await writePendingReceipt(projectDir, 1, credentials);
    // 故障注入：草稿路径换成同名目录 → readFile 必以 EISDIR 失败（非 ENOENT，属「对账读失败」而非「对不上」）。
    const draftPath = join(projectDir, "drafts", "fast", "chapter-0001.md");
    await rm(draftPath);
    await mkdir(draftPath);

    const result = await runCommitApply({
      projectDir,
      chapter: 1,
      policy: { kind: "http_durable_receipt", idempotencyKey: IDEMPOTENCY_KEY, credentials },
    });

    expect(result.kind).toBe("idempotency_in_progress");
    if (result.kind !== "idempotency_in_progress") throw new Error(`expected idempotency_in_progress, got ${result.kind}`);
    expect(result.error).toContain("对账读取失败");
    expect(result.error).toContain("请稍后重试");
    expect(result.error).toContain("请勿删除");
    // 分流的关键：IO 失败文案绝不出现「删除回执文件」这条出路（回执是上次定稿的唯一证据）。
    expect(result.error).not.toContain("删除回执文件");
    expect(commitFastDraft).not.toHaveBeenCalled();
    // 绝不删证据：pending 回执逐字节原样保留。
    await expect(readFile(join(pending.receiptDir, pending.fileName), "utf-8")).resolves.toBe(pending.text);
  });

  it("确认对不上（章未入库）→ 仍走原 409 文案（含删除回执这条可执行出路），不受分流影响", async () => {
    projectDir = await createProjectFixture();
    const credentials = await previewCredentials(projectDir);
    // 回执停 pending，磁盘上没有 chapters/0001.md（上次定稿确实未入库）→ ENOENT → mismatch。
    await writePendingReceipt(projectDir, 1, credentials);

    const result = await runCommitApply({
      projectDir,
      chapter: 1,
      policy: { kind: "http_durable_receipt", idempotencyKey: IDEMPOTENCY_KEY, credentials },
    });

    expect(result.kind).toBe("idempotency_in_progress");
    if (result.kind !== "idempotency_in_progress") throw new Error(`expected idempotency_in_progress, got ${result.kind}`);
    expect(result.error).toContain("磁盘对账显示该章未按此次预览入库");
    expect(result.error).toContain("删除回执文件");
    expect(result.error).not.toContain("对账读取失败");
    expect(commitFastDraft).not.toHaveBeenCalled();
  });
});

describe("commit-apply 幂等内存缓存上界（GLM P3 旧账③）", () => {
  let projectDir: string | undefined;

  beforeEach(() => {
    resetMocksBaseline();
    // 入库 mock 必须真写 chapters/NNNN.md（与引擎 commitFastDraft 同口径：草稿原文落盘）——
    // replayed 判定现在先过磁盘对账（安全不变量⑦），mock 不落盘会让重放对账永远对不上、
    // 把旧的「内存 replayed 假成功」行为固化进断言。
    commitFastDraft.mockImplementation(async (input: { readonly projectDir: string; readonly chapter: number; readonly draftContent: string }) => {
      await mkdir(join(input.projectDir, "chapters"), { recursive: true });
      await writeFile(join(input.projectDir, "chapters", `${String(input.chapter).padStart(4, "0")}.md`), input.draftContent, "utf-8");
      return {
        passed: true,
        chapter: input.chapter,
        updatedCharacters: [],
        timelineEventIds: [],
        updatedHooks: [],
        updatedWorld: false,
        updatedCalendar: false,
        issues: [],
      };
    });
  });

  afterEach(async () => {
    if (projectDir) {
      await rm(projectDir, { recursive: true, force: true });
      projectDir = undefined;
    }
  });

  // 55 = 上界 50 + 5 条余量（本文件先前用例也会占少量更旧的条目，FIFO 先淘它们再淘本章 1）。
  it("超 50 条 FIFO 淘汰最旧；被淘汰键的同键重放由持久回执照常兜底，绝不重跑入库", async () => {
    projectDir = await createProjectFixture();
    const chapterCount = 55;
    const chapterKey = (chapter: number) => `idem-bound-ch-${String(chapter).padStart(4, "0")}`;
    let firstChapterCredentials: { readonly transactionId: string; readonly previewHash: string; readonly idempotencyKey: string } | undefined;
    for (let chapter = 1; chapter <= chapterCount; chapter++) {
      await writeFile(
        join(projectDir, "drafts", "fast", `chapter-${String(chapter).padStart(4, "0")}.md`),
        `# 第${chapter}章\n\n缓存上界测试草稿 ${chapter}。`,
        "utf-8",
      );
      const credentials = await previewCredentialsFor(projectDir, chapter, chapterKey(chapter));
      const applied = await runCommitApply({
        projectDir,
        chapter,
        policy: { kind: "http_durable_receipt", idempotencyKey: chapterKey(chapter), credentials },
      });
      if (applied.kind !== "committed") throw new Error(`chapter ${chapter}: expected committed, got ${applied.kind}`);
      if (chapter === 1) firstChapterCredentials = credentials;
    }
    if (!firstChapterCredentials) throw new Error("missing chapter 1 credentials");

    // 上界锁：55 次成功 apply 后内存条目恒不超 50（最旧的含第 1 章已被淘汰）。
    expect(commitIdempotencyCacheSizeForTests()).toBe(50);
    expect(commitFastDraft).toHaveBeenCalledTimes(chapterCount);

    // 重放不受淘汰影响：第 1 章内存条目已淘汰，同键同凭证重放仍由磁盘持久回执逐字兜底
    // （章节文件真在盘上、与回执 payload 逐字一致，磁盘对账⑦通过才允许 replayed）。
    const replayed = await runCommitApply({
      projectDir,
      chapter: 1,
      policy: { kind: "http_durable_receipt", idempotencyKey: chapterKey(1), credentials: firstChapterCredentials },
    });
    expect(replayed.kind).toBe("replayed");
    expect(commitFastDraft).toHaveBeenCalledTimes(chapterCount);

    // 旁证淘汰确曾发生（删文件纯属测试探针，用来区分内存/磁盘两条重放路径，非生产语义）：
    // 第 1 章删掉磁盘回执后同键重放只能真重跑（内存已无条目）；仍留存的第 55 章删回执后仍走内存重放
    // （内存条目在 + 章节文件真在盘上，对账⑦通过——若章节不在盘上，内存重放会被对账拦下，见下个 describe）。
    await rm(receiptFilePath(projectDir, 1, chapterKey(1)), { force: true });
    const recommitted = await runCommitApply({
      projectDir,
      chapter: 1,
      policy: { kind: "http_durable_receipt", idempotencyKey: chapterKey(1), credentials: firstChapterCredentials },
    });
    expect(recommitted.kind).toBe("committed");
    expect(commitFastDraft).toHaveBeenCalledTimes(chapterCount + 1);

    const lastChapterCredentials = await previewCredentialsFor(projectDir, chapterCount, chapterKey(chapterCount));
    await rm(receiptFilePath(projectDir, chapterCount, chapterKey(chapterCount)), { force: true });
    const memoryReplayed = await runCommitApply({
      projectDir,
      chapter: chapterCount,
      policy: { kind: "http_durable_receipt", idempotencyKey: chapterKey(chapterCount), credentials: lastChapterCredentials },
    });
    expect(memoryReplayed.kind).toBe("replayed");
    expect(commitFastDraft).toHaveBeenCalledTimes(chapterCount + 1);
  }, 30_000);
});

/** 与既有 previewCredentials 同口径、但章号/幂等键可指定（上界测试要逐章各 Preview 一次）。 */
async function previewCredentialsFor(
  projectDir: string,
  chapter: number,
  idempotencyKey: string,
): Promise<{ readonly transactionId: string; readonly previewHash: string; readonly idempotencyKey: string }> {
  const preview = await runCommitPreview({
    projectDir,
    chapter,
    judge: async ({ deterministicQuality }) => deterministicQuality,
  });
  if (preview.kind !== "preview") throw new Error(`expected preview result, got ${preview.kind}`);
  return {
    transactionId: preview.transaction.transactionId,
    previewHash: preview.transaction.previewHash,
    idempotencyKey,
  };
}

/** 与 commit-service 的回执文件命名逐字同源：sha256(`${resolve(dir)}\u0000${chapter}\u0000${key}`).json。 */
function receiptFilePath(projectDir: string, chapter: number, idempotencyKey: string): string {
  const digest = createHash("sha256")
    .update(`${resolve(projectDir)}\u0000${chapter}\u0000${idempotencyKey}`, "utf-8")
    .digest("hex");
  return join(projectDir, ".story-engine-ui", "commit-idempotency", `${digest}.json`);
}

/** 造一份停在 pending 的持久回执（上次定稿 claim 后中断的场景）。 */
async function writePendingReceipt(
  projectDir: string,
  chapter: number,
  credentials: { readonly transactionId: string; readonly previewHash: string; readonly idempotencyKey: string },
): Promise<{ readonly receiptDir: string; readonly fileName: string; readonly text: string }> {
  const path = receiptFilePath(projectDir, chapter, credentials.idempotencyKey);
  const receiptDir = join(projectDir, ".story-engine-ui", "commit-idempotency");
  await mkdir(receiptDir, { recursive: true });
  const text = `${JSON.stringify({
    version: 1,
    status: "pending",
    projectHash: createHash("sha256").update(resolve(projectDir), "utf-8").digest("hex"),
    chapter,
    idempotencyKey: credentials.idempotencyKey,
    transactionId: credentials.transactionId,
    previewHash: credentials.previewHash,
    createdAt: "2026-09-10T00:00:00.000Z",
  }, null, 2)}\n`;
  await writeFile(path, text, "utf-8");
  return { receiptDir, fileName: basename(path), text };
}


/* ---------------------------------------------------------------------------
 * replayed 磁盘对账（安全不变量⑦·复审 P2①）的回归锁：
 * undo 撤销会把持久回执连同章节文件一起回滚，内存缓存条目却留在进程内——
 * 旧实现此时同键重放直接报 replayed（HTTP 200），磁盘上什么都没写（假成功）。
 * 修复后：内存/持久/竞态三条 replayed 路径一律先过磁盘对账（章在盘上且与回执 payload
 * 逐字一致才允许重放）；对不上 fall through 走真 apply，回执与磁盘矛盾时 fail-closed 409。
 * ------------------------------------------------------------------------- */
describe("commit-apply replayed 磁盘对账（undo 假成功根治·复审 P2①）", () => {
  let projectDir: string | undefined;

  beforeEach(() => {
    resetMocksBaseline();
    // 入库 mock 真写 chapters/NNNN.md（与引擎 commitFastDraft 同口径：草稿原文落盘），对账才有真相可核。
    commitFastDraft.mockImplementation(async (input: { readonly projectDir: string; readonly chapter: number; readonly draftContent: string }) => {
      await mkdir(join(input.projectDir, "chapters"), { recursive: true });
      await writeFile(join(input.projectDir, "chapters", `${String(input.chapter).padStart(4, "0")}.md`), input.draftContent, "utf-8");
      return {
        passed: true,
        chapter: input.chapter,
        updatedCharacters: [],
        timelineEventIds: [],
        updatedHooks: [],
        updatedWorld: false,
        updatedCalendar: false,
        issues: [],
      };
    });
  });

  afterEach(async () => {
    if (projectDir) {
      await rm(projectDir, { recursive: true, force: true });
      projectDir = undefined;
    }
  });

  /** 首次真实入库（持久回执正常落盘），返回凭证供同键重放。 */
  async function commitChapterOnce(
    dir: string,
  ): Promise<{ readonly transactionId: string; readonly previewHash: string; readonly idempotencyKey: string }> {
    const credentials = await previewCredentials(dir);
    const result = await runCommitApply({
      projectDir: dir,
      chapter: 1,
      policy: { kind: "http_durable_receipt", idempotencyKey: IDEMPOTENCY_KEY, credentials },
    });
    if (result.kind !== "committed") throw new Error(`expected committed, got ${result.kind}`);
    return credentials;
  }

  function applyWith(credentials: { readonly transactionId: string; readonly previewHash: string; readonly idempotencyKey: string }) {
    return runCommitApply({
      projectDir: projectDir!,
      chapter: 1,
      policy: { kind: "http_durable_receipt", idempotencyKey: IDEMPOTENCY_KEY, credentials },
    });
  }

  it("章在盘上且与回执逐字一致 → 同键重放照常 replayed（对账不误伤正常重放）", async () => {
    projectDir = await createProjectFixture();
    const credentials = await commitChapterOnce(projectDir);

    const replayed = await applyWith(credentials);

    expect(replayed.kind).toBe("replayed");
    // 真重放：绝不重跑入库。
    expect(commitFastDraft).toHaveBeenCalledTimes(1);
  });

  it("undo 撤销后（回执随快照回滚、章节文件不在、内存条目残留）→ 不再假 replayed，fall through 真入库", async () => {
    projectDir = await createProjectFixture();
    const credentials = await commitChapterOnce(projectDir);
    const chapterPath = join(projectDir, "chapters", "0001.md");
    await expect(readFile(chapterPath, "utf-8")).resolves.toBe(DRAFT_CONTENT);

    // 模拟 undo：快照回滚把回执连同章节文件一起删掉；进程内内存缓存条目残留（旧假成功的现场）。
    await rm(chapterPath);
    await rm(receiptFilePath(projectDir, 1, IDEMPOTENCY_KEY), { force: true });

    const result = await applyWith(credentials);

    // 磁盘真相为准：内存 replayed 被对账拦下，fall through 走真 apply——章节真的重新落盘。
    expect(result.kind).toBe("committed");
    expect(commitFastDraft).toHaveBeenCalledTimes(2);
    await expect(readFile(chapterPath, "utf-8")).resolves.toBe(DRAFT_CONTENT);

    // 真入库后内存条目被新的 completed 覆写、回执重新落盘：再次同键重放走对账通过的正常 replayed。
    const replayed = await applyWith(credentials);
    expect(replayed.kind).toBe("replayed");
    expect(commitFastDraft).toHaveBeenCalledTimes(2);
  });

  it("持久回执在但章节文件被撤 → 不重放、不假成功，fail-closed 409 且回执逐字节保留", async () => {
    projectDir = await createProjectFixture();
    const credentials = await commitChapterOnce(projectDir);
    await rm(join(projectDir, "chapters", "0001.md"));
    const receiptOnDisk = receiptFilePath(projectDir, 1, IDEMPOTENCY_KEY);
    const receiptText = await readFile(receiptOnDisk, "utf-8");

    const result = await applyWith(credentials);

    // 回执与磁盘矛盾：fall through 后 claim 撞上现存 completed 回执，由竞态对账出口 fail-closed 收口。
    expect(result.kind).toBe("idempotency_in_progress");
    if (result.kind !== "idempotency_in_progress") throw new Error(`expected idempotency_in_progress, got ${result.kind}`);
    expect(result.error).toContain("已完成记录");
    expect(result.error).toContain("未按此次预览入库");
    // 确认对不上 → 出路含「人工核对后删回执重试=真实重新入库」。
    expect(result.error).toContain("删除回执文件");
    expect(result.error).not.toContain("对账读取失败");
    // 绝不重复入库；回执证据逐字节保留（绝不删证据后重做）。
    expect(commitFastDraft).toHaveBeenCalledTimes(1);
    await expect(readFile(receiptOnDisk, "utf-8")).resolves.toBe(receiptText);
  });

  it("章节文件内容与回执记录不符（被改/被旧版顶回）→ 同样 fail-closed 409，不重放", async () => {
    projectDir = await createProjectFixture();
    const credentials = await commitChapterOnce(projectDir);
    await writeFile(join(projectDir, "chapters", "0001.md"), "# 第1章\n\n被改动过的内容。", "utf-8");

    const result = await applyWith(credentials);

    expect(result.kind).toBe("idempotency_in_progress");
    if (result.kind !== "idempotency_in_progress") throw new Error(`expected idempotency_in_progress, got ${result.kind}`);
    expect(result.error).toContain("内容已变化");
    expect(commitFastDraft).toHaveBeenCalledTimes(1);
  });
});


/* ---------------------------------------------------------------------------
 * 复审第四轮 P2-2：两条「对账读失败」409 文案的路径消毒回归锁——
 * errno 原文（ENOTDIR/EACCES 等）内嵌绝对路径（如 open '/abs/path/chapters/0001.md'），
 * 直达用户前必须按 commit-apply 同款口径洗掉（绝对路径 →「(本地路径)」，errno 码保留诊断价值）。
 * 故障注入选 ENOTDIR（把路径中间目录换成普通文件）：error.message 必带绝对路径，
 * 且对 root 跑手也稳定触发（chmod 造的 EACCES 在 root 下会被权限豁免跳过）。
 * ------------------------------------------------------------------------- */
describe("commit-apply 409 文案路径消毒（复审第四轮 P2-2）", () => {
  let projectDir: string | undefined;

  beforeEach(() => {
    resetMocksBaseline();
    // 入库 mock 真写 chapters/NNNN.md（与引擎 commitFastDraft 同口径），completed 回执对账才有真相可核。
    commitFastDraft.mockImplementation(async (input: { readonly projectDir: string; readonly chapter: number; readonly draftContent: string }) => {
      await mkdir(join(input.projectDir, "chapters"), { recursive: true });
      await writeFile(join(input.projectDir, "chapters", `${String(input.chapter).padStart(4, "0")}.md`), input.draftContent, "utf-8");
      return {
        passed: true,
        chapter: input.chapter,
        updatedCharacters: [],
        timelineEventIds: [],
        updatedHooks: [],
        updatedWorld: false,
        updatedCalendar: false,
        issues: [],
      };
    });
  });

  afterEach(async () => {
    if (projectDir) {
      await rm(projectDir, { recursive: true, force: true });
      projectDir = undefined;
    }
  });

  it("pending 对账读失败文案：errno 保留、绝对路径洗成「(本地路径)」（pendingReceiptUnreadableMessage）", async () => {
    projectDir = await createProjectFixture();
    const credentials = await previewCredentials(projectDir);
    await writePendingReceipt(projectDir, 1, credentials);
    // 故障注入：drafts/fast 换成同名普通文件 → 对账读草稿必 ENOTDIR 且 message 带绝对路径
    //（非 ENOENT，属「对账读失败」而非「对不上」）。
    const fastDir = join(projectDir, "drafts", "fast");
    await rm(fastDir, { recursive: true });
    await writeFile(fastDir, "not a directory", "utf-8");

    const result = await runCommitApply({
      projectDir,
      chapter: 1,
      policy: { kind: "http_durable_receipt", idempotencyKey: IDEMPOTENCY_KEY, credentials },
    });

    expect(result.kind).toBe("idempotency_in_progress");
    if (result.kind !== "idempotency_in_progress") throw new Error(`expected idempotency_in_progress, got ${result.kind}`);
    expect(result.error).toContain("对账读取失败");
    expect(result.error).toContain("ENOTDIR"); // errno 码保留诊断价值
    expect(result.error).toContain("(本地路径)");
    expect(result.error).not.toContain(projectDir); // 绝对路径绝不直达用户
    expect(commitFastDraft).not.toHaveBeenCalled();
  });

  it("completed 回执对账读失败文案：同款消毒（completedReceiptUnreadableMessage）", async () => {
    projectDir = await createProjectFixture();
    const credentials = await previewCredentials(projectDir);
    const first = await runCommitApply({
      projectDir,
      chapter: 1,
      policy: { kind: "http_durable_receipt", idempotencyKey: IDEMPOTENCY_KEY, credentials },
    });
    if (first.kind !== "committed") throw new Error(`expected committed, got ${first.kind}`);
    // 故障注入：chapters 目录换成同名普通文件 → 同键重试的对账读 chapters/0001.md 必 ENOTDIR（带绝对路径）。
    const chaptersDir = join(projectDir, "chapters");
    await rm(chaptersDir, { recursive: true });
    await writeFile(chaptersDir, "not a directory", "utf-8");

    const result = await runCommitApply({
      projectDir,
      chapter: 1,
      policy: { kind: "http_durable_receipt", idempotencyKey: IDEMPOTENCY_KEY, credentials },
    });

    // 磁盘对账读失败 → 重放被拒（fail-closed），文案走 completedReceiptUnreadableMessage。
    expect(result.kind).toBe("idempotency_in_progress");
    if (result.kind !== "idempotency_in_progress") throw new Error(`expected idempotency_in_progress, got ${result.kind}`);
    expect(result.error).toContain("磁盘对账读取失败");
    expect(result.error).toContain("ENOTDIR");
    expect(result.error).toContain("(本地路径)");
    expect(result.error).not.toContain(projectDir);
    // 绝不重放/重做：入库只发生过第一次那一次。
    expect(commitFastDraft).toHaveBeenCalledTimes(1);
  });
});
