// @vitest-environment node
/**
 * draft-service D1 长度执法回读降级（GLM P3 旧账④）的回归锁：
 * 原实现 `readFile(report.draftPath, "utf-8").catch(() => "")` —— 落盘回读失败得空串 →
 * 整段长度执法静默跳过、响应仍 ok:true，长度不达标/超长的稿子无声流入工作稿。
 * 修复后：回读对齐 L1 口径（readFileContentWithRetry 3×60ms），仍失败则执法跳过在 summary
 * 如实留痕（⚠ 长度执法未执行），绝不静默；ok 仍 true（草稿确已落盘，绝不谎报失败）。
 * 复审 P2② 起：降级同时随 http.warnings 投影带出——路由 200 投影不带 summary，
 * 没有这条通道 HTTP 调用方拿到 ok:true+空稿却零信号（形同假成功）。
 *
 * 故障注入手法：引擎 mock 的 runFastDraft 报 passed 但不真写盘 → draftPath 不存在 → 回读必失败。
 * （节点内置 fs 在本 vitest 配置下不可跨模块 mock，故障从真实文件系统状态造。）
 */
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { WriterClient } from "@actalk/story-engine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storyEngineMocks = vi.hoisted(() => ({
  buildDraftLengthReport: vi.fn(() => ({
    requestedDraftLength: 1800,
    lowerBound: 200,
    upperBound: 2000,
    actualLength: 500,
    lengthStatus: "within_range",
    source: "default",
    whetherTrimmed: false,
  })),
  buildStateOverview: vi.fn(async () => ({ overview: true })),
  checkDraftBeatFidelity: vi.fn(() => ({ missingBeats: [] })),
  countDraftChineseCharacters: vi.fn(() => 500),
  detectAiFlavorViolations: vi.fn(() => ({ total: 0, bySeverity: { high: 0, medium: 0, low: 0 }, violations: [] })),
  persistFastDraftBody: vi.fn(),
  readWritingRules: vi.fn(async () => null),
  resolveDraftLengthTarget: vi.fn(() => ({ requested: 1800, lowerBound: 200, upperBound: 2000, source: "default" })),
  resolveDraftMaxOutputTokens: vi.fn(() => 2048),
  runFastDraft: vi.fn(),
  trimDraftBodyToLengthTarget: vi.fn(),
}));

vi.mock("@actalk/story-engine", () => ({
  ...storyEngineMocks,
}));

vi.mock("../lib/beat-miss-adjudication.js", () => ({
  adjudicateMissingBeats: vi.fn(),
  isAdjudicationQuoteVerbatim: vi.fn(() => true),
}));

vi.mock("../agent/tools/check-ai-flavor.js", () => ({
  readAntiAiPatterns: vi.fn(async () => []),
  readAntiRules: vi.fn(async () => []),
}));

vi.mock("../agent/tools/snapshot-on-draft-overwrite.js", () => ({
  snapshotBeforeDraftOverwrite: vi.fn(async () => undefined),
}));

vi.mock("../agent/context-budget/rank-writer-context.js", () => ({
  contextBudgetPayload: vi.fn(() => ({ budget: true })),
  makeWriterRankContext: vi.fn(() => ({
    rankContext: (envelope: unknown) => envelope,
    droppedSections: [],
    droppedDetails: [],
    coreImpact: false,
    issues: [],
  })),
  resolveWriterTokenBudget: vi.fn(() => 8000),
}));

vi.mock("../agent/presence/in-scene-detector.js", () => ({
  resolveSelectedCharacterIds: vi.fn(async () => ({ selectedCharacterIds: [], trace: {}, summary: "在场角色 0 人" })),
}));

vi.mock("../agent/ai-flavor/ai-flavor-rules.js", () => ({
  ALL_BUILTIN_AI_FLAVOR_RULES: [],
  buildUserAntiAiPatternRules: vi.fn(() => []),
}));

vi.mock("../agent/ai-flavor/de-ai-flavor-batch.js", () => ({
  runDeAiFlavorBatch: vi.fn(),
}));

import { defaultDraftPath } from "../lib/project-io.js";
import { runDeAiFlavorBatch } from "../agent/ai-flavor/de-ai-flavor-batch.js";
import { snapshotBeforeDraftOverwrite } from "../agent/tools/snapshot-on-draft-overwrite.js";
import { readFileContentWithRetry, readPreviousDraftForRollback, runAutoDeAiRound, runGenerateDraft } from "./draft-service.js";

const DRAFT_TEXT = "# 第1章\n\n主角拿到账册，连夜翻看。\n";
// chmod 0o000 注入读失败在 root 下不生效（root 无视权限位），win32 无 POSIX 权限语义——跳过。
const skipChmodCase = process.platform === "win32"
  || (typeof process.getuid === "function" && process.getuid() === 0);

function stubWriterClient(): WriterClient {
  return {
    generateDraft: vi.fn(async () => ({ title: "账册", content: DRAFT_TEXT })),
  };
}

describe("readFileContentWithRetry（L1 同口径 3×60ms 的原文回读）", () => {
  let projectDir: string | undefined;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), "story-engine-draft-service-"));
  });

  afterEach(async () => {
    if (projectDir) {
      await rm(projectDir, { recursive: true, force: true });
      projectDir = undefined;
    }
  });

  it("首次读不到、重试期间文件出现 → 读到原始全文（含标题行）", async () => {
    const path = join(projectDir!, "chapter-0001.md");
    const pending = readFileContentWithRetry(path, { retries: 3, delayMs: 40 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await writeFile(path, DRAFT_TEXT, "utf-8");
    await expect(pending).resolves.toBe(DRAFT_TEXT);
  });

  it("彻底读不到 → 返回空串（调用方据此如实降级，不静默）", async () => {
    await expect(
      readFileContentWithRetry(join(projectDir!, "missing.md"), { retries: 3, delayMs: 1 }),
    ).resolves.toBe("");
  });
});

describe("runGenerateDraft D1 enforce 路回读降级（GLM P3 旧账④）", () => {
  let projectDir: string | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    projectDir = await mkdtemp(join(tmpdir(), "story-engine-draft-service-"));
  });

  afterEach(async () => {
    if (projectDir) {
      await rm(projectDir, { recursive: true, force: true });
      projectDir = undefined;
    }
  });

  it("落盘回读彻底失败 → ok:true 但执法跳过在 summary 如实留痕，绝不静默", async () => {
    const draftPath = defaultDraftPath(projectDir!, 1);
    // 故障注入：引擎报 passed 并给出 draftPath，但草稿根本没落盘 → 回读重试耗尽仍空。
    storyEngineMocks.runFastDraft.mockResolvedValue({
      chapter: 1,
      passed: true,
      draftPath,
      contextStats: { totalTokenEstimate: 0, stableTokenEstimate: 0, dynamicTokenEstimate: 0, contextSections: [] },
      promptFingerprint: {},
      issues: [],
    });

    const result = await runGenerateDraft({
      projectDir: projectDir!,
      chapter: 1,
      writerClient: stubWriterClient(),
      policies: { lengthPolicy: "enforce_or_rollback", aiFlavorRecheck: false },
    });

    // 草稿「确已落盘」是引擎报告的口径，绝不因此谎报失败——但执法跳过必须留痕。
    expect(result.ok).toBe(true);
    expect(result.rejection).toBeUndefined();
    expect(result.summary).toContain("长度执法未执行");
    // 执法确实没跑（不是跑了但没留痕）。
    expect(storyEngineMocks.countDraftChineseCharacters).not.toHaveBeenCalled();
    // 回读为空沿用 A11 可见性提示（两件事各说各的，不合并、不互相遮盖）。
    expect(result.summary).toContain("正文已写盘，但本次未能载入到写作区显示");
    expect(result.http.draftContent).toBe("");
    // 复审 P2②：降级信息除 summary 外必须随 http.warnings 投影带出（路由 200 不投影 summary，
    // 少了这条通道 HTTP 调用方就是 ok:true+空稿零信号）。warnings 是纯文本版（无 ⚠/（注：…）装饰）。
    expect(result.http.warnings).toEqual([
      expect.stringContaining("长度执法未执行"),
      expect.stringContaining("正文已写盘，但本次未能载入到写作区显示"),
    ]);
  }, 10_000);

  it("落盘回读正常 → 执法照常执行，summary 不带降级标注（行为不变）", async () => {
    const draftPath = defaultDraftPath(projectDir!, 1);
    storyEngineMocks.runFastDraft.mockImplementation(async () => {
      await mkdir(dirname(draftPath), { recursive: true });
      await writeFile(draftPath, DRAFT_TEXT, "utf-8");
      return {
        chapter: 1,
        passed: true,
        draftPath,
        contextStats: { totalTokenEstimate: 0, stableTokenEstimate: 0, dynamicTokenEstimate: 0, contextSections: [] },
        promptFingerprint: {},
        issues: [],
      };
    });

    const result = await runGenerateDraft({
      projectDir: projectDir!,
      chapter: 1,
      writerClient: stubWriterClient(),
      policies: { lengthPolicy: "enforce_or_rollback", aiFlavorRecheck: false },
    });

    expect(result.ok).toBe(true);
    // 执法真跑了（字数核对经 countCjkChars → 引擎 countDraftChineseCharacters）。
    expect(storyEngineMocks.countDraftChineseCharacters).toHaveBeenCalled();
    expect(result.summary).not.toContain("长度执法未执行");
    expect(result.draftBody).toBe("主角拿到账册，连夜翻看。");
    expect(result.http.draftContent).toContain("主角拿到账册");
    // 无降级 → warnings 字段缺省，不打扰正常 200。
    expect(result.http.warnings).toBeUndefined();
  }, 10_000);
});

// P2-5：写前读旧稿的裸 catch（readFile().catch(()=>undefined)）把「旧稿存在但读失败」与「无旧稿」混为一谈——
// 执法拒稿回滚因此走 rm 删掉盘上真稿。修复后三态分清：absent/present/unreadable，unreadable 写盘前诚实拒稿。
describe("readPreviousDraftForRollback（P2-5 写前读旧稿 fail-closed 三态）", () => {
  let projectDir: string | undefined;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), "story-engine-draft-service-"));
  });

  afterEach(async () => {
    if (projectDir) {
      await rm(projectDir, { recursive: true, force: true });
      projectDir = undefined;
    }
  });

  it("无旧稿（ENOENT）→ absent（确定答案不重试；回滚删引擎新写文件是对的）", async () => {
    await expect(
      readPreviousDraftForRollback(join(projectDir!, "missing.md"), { retries: 3, delayMs: 1 }),
    ).resolves.toEqual({ kind: "absent" });
  });

  it("旧稿存在 → present，原文逐字返回（回滚凭据）", async () => {
    const path = join(projectDir!, "draft.md");
    await writeFile(path, DRAFT_TEXT, "utf-8");
    await expect(
      readPreviousDraftForRollback(path, { retries: 3, delayMs: 1 }),
    ).resolves.toEqual({ kind: "present", content: DRAFT_TEXT });
  });

  it.skipIf(process.platform === "win32")("旧稿存在但彻底读失败（ELOOP 自指 symlink）→ unreadable 如实带错误", async () => {
    const path = join(projectDir!, "looped.md");
    await symlink(path, path); // 自指环：readFile 必 ELOOP，root 下也确定触发
    const result = await readPreviousDraftForRollback(path, { retries: 2, delayMs: 1 });
    expect(result.kind).toBe("unreadable");
    expect(result.kind === "unreadable" && result.error.length > 0).toBe(true);
  });
});

describe("runGenerateDraft enforce 路写前读失败（P2-5 真稿保护）", () => {
  let projectDir: string | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    projectDir = await mkdtemp(join(tmpdir(), "story-engine-draft-service-"));
  });

  afterEach(async () => {
    if (projectDir) {
      await rm(projectDir, { recursive: true, force: true });
      projectDir = undefined;
    }
  });

  const OLD_DRAFT = "# 第1章\n\n这是上一版合格旧稿，绝不允许被回滚误删。\n";

  it.skipIf(skipChmodCase)("旧稿存在但读失败（chmod 0o000）→ ok:false 诚实拒稿，真稿逐字不动、生成未启动", async () => {
    const draftPath = defaultDraftPath(projectDir!, 1);
    await mkdir(dirname(draftPath), { recursive: true });
    await writeFile(draftPath, OLD_DRAFT, "utf-8");
    await chmod(draftPath, 0o000); // 真故障注入：文件在、读必败（EACCES）

    const writer = stubWriterClient();
    let result!: Awaited<ReturnType<typeof runGenerateDraft>>;
    try {
      result = await runGenerateDraft({
        projectDir: projectDir!,
        chapter: 1,
        writerClient: writer,
        policies: { lengthPolicy: "enforce_or_rollback", aiFlavorRecheck: false },
      });
    } finally {
      await chmod(draftPath, 0o644); // 恢复权限以便校验与清理
    }

    // 诚实拒稿：ok:false + 如实说明（读取失败/未覆盖），不走 rejection（不是执法拒稿）。
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("读取失败");
    expect(result.summary).toContain("未覆盖");
    expect(result.issues.join(" ")).toContain("读取失败");
    expect(result.rejection).toBeUndefined();
    // 铁律④：errno 原文内嵌的绝对路径绝不进用户可见文案（summary/issues 同口径消毒）。
    expect(result.summary).toContain("(本地路径)");
    expect(result.summary).not.toContain(projectDir!);
    expect(result.issues.join(" ")).not.toContain(projectDir!);
    // 真稿逐字不动——回滚 rm 路径绝不能被触发；
    expect(await readFile(draftPath, "utf-8")).toBe(OLD_DRAFT);
    // 且生成根本没启动（写盘前拒稿，引擎/模型都没碰）。
    expect(storyEngineMocks.runFastDraft).not.toHaveBeenCalled();
    expect(writer.generateDraft).not.toHaveBeenCalled();
  }, 10_000);

  it("旧稿读正常 + 执法拒稿 → 回滚逐字写回旧稿（回归：fail-closed 不误伤正常回滚）", async () => {
    const draftPath = defaultDraftPath(projectDir!, 1);
    await mkdir(dirname(draftPath), { recursive: true });
    await writeFile(draftPath, OLD_DRAFT, "utf-8");
    // 引擎落盘一版「短稿」覆盖旧稿；字数核对返回 100 < lowerBound 200 → 执法拒稿。
    storyEngineMocks.countDraftChineseCharacters.mockReturnValue(100);
    storyEngineMocks.runFastDraft.mockImplementation(async () => {
      await writeFile(draftPath, "# 第1章\n\n短。\n", "utf-8");
      return {
        chapter: 1,
        passed: true,
        draftPath,
        contextStats: { totalTokenEstimate: 0, stableTokenEstimate: 0, dynamicTokenEstimate: 0, contextSections: [] },
        promptFingerprint: {},
        issues: [],
      };
    });

    const result = await runGenerateDraft({
      projectDir: projectDir!,
      chapter: 1,
      writerClient: stubWriterClient(),
      policies: { lengthPolicy: "enforce_or_rollback", aiFlavorRecheck: false },
    });

    expect(result.ok).toBe(false);
    expect(result.rejection?.kind).toBe("length_rejected");
    expect(await readFile(draftPath, "utf-8")).toBe(OLD_DRAFT); // 回滚凭据来自写前读，逐字写回
  }, 10_000);
});

describe("runAutoDeAiRound 快照失败降级（P2-5·铁律④ 路径消毒）", () => {
  let projectDir: string | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    projectDir = await mkdtemp(join(tmpdir(), "story-engine-draft-service-"));
  });

  afterEach(async () => {
    if (projectDir) {
      await rm(projectDir, { recursive: true, force: true });
      projectDir = undefined;
    }
  });

  it("快照读稿 fail-closed 抛错带绝对路径 → info.error 如实降级但路径已消毒，原稿不动", async () => {
    const draftPath = defaultDraftPath(projectDir!, 1);
    await mkdir(dirname(draftPath), { recursive: true });
    await writeFile(draftPath, DRAFT_TEXT, "utf-8");
    vi.mocked(runDeAiFlavorBatch).mockResolvedValue({
      ok: true,
      detected: 1,
      rewritten: 1,
      skipped: 0,
      skippedByReason: { notFound: 0, ambiguous: 0, noop: 0, overlap: 0, noRewrite: 0 },
      changes: [],
      updatedContent: "# 第1章\n\n改写后的正文，与原文不同。\n",
      summary: "一键全修：1 处 AI 腔，改了 1 处。",
    });
    // 快照 fail-closed 的 errno 原文内嵌绝对路径（真实形态见 snapshot-on-draft-overwrite）。
    vi.mocked(snapshotBeforeDraftOverwrite).mockRejectedValueOnce(
      new Error(`第1章工作稿读取失败（EACCES: permission denied, open '${draftPath}'），已中止`),
    );

    const result = await runAutoDeAiRound({
      projectDir: projectDir!,
      chapter: 1,
      draftPath,
      initialHighMedium: 1,
      targets: [],
      rules: [],
      antiRules: [],
      callModel: vi.fn(async () => ""),
    });

    // 降级如实报：本轮没跑成（改写放弃），error 直达用户前路径已洗。
    expect(result.info.attempted).toBe(true);
    expect(result.info.fixedCount).toBe(0);
    expect(result.info.error).toContain("(本地路径)");
    expect(result.info.error ?? "").not.toContain(projectDir!);
    expect(result.draftBody).toBeUndefined();
    expect(result.snapshotId).toBeUndefined();
    // 原稿分毫不动（降级承诺）。
    expect(await readFile(draftPath, "utf-8")).toBe(DRAFT_TEXT);
  });
});
