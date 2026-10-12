// @vitest-environment node
/**
 * 声明路由（2026-10-12 编辑部 T2 起 = 记账员一路；R3 删旧声明后没有回退）：
 * 预览的章节声明走记账员（读过前文）；没准备好（not_ready）→ 这次按 fallback 如实标注（「这章的线索没记上」进 summary），
 * 笔记在后台补。这里只测路由，不测记账员本身（见 brain/ledger.test.ts）。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeHomeTempDir } from "../../lib/home-test-tmp.js";
import type { LedgerDeclareResult } from "../../brain/ledger.js";

const ledgerMock = vi.hoisted(() => ({
  declareChapterDeltaByLedger: vi.fn(),
}));
vi.mock("../../brain/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../brain/index.js")>()),
  declareChapterDeltaByLedger: ledgerMock.declareChapterDeltaByLedger,
}));

const { buildDeclareDeltaRouter } = await import("./commit-preview.js");
const { LEDGER_ROLE } = await import("../../brain/ledger.js");

beforeEach(() => {
  ledgerMock.declareChapterDeltaByLedger.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

const INPUT = { chapter: 3, draft: "正文。", projectDir: "/tmp/书" } as const;
const MODEL_OUTCOME = {
  status: "model" as const,
  declaration: {
    chapter: 3,
    mainEvent: { summary: "事", quote: "正文。" },
    seededForeshadowing: [],
    resolvedForeshadowing: [],
    resourceDeltas: [],
    keyLeads: [],
  },
};

describe("buildDeclareDeltaRouter（记账员一路）", () => {
  it("走记账员，声明结果原样透传", async () => {
    ledgerMock.declareChapterDeltaByLedger.mockResolvedValue({ outcome: MODEL_OUTCOME } satisfies LedgerDeclareResult);
    const router = buildDeclareDeltaRouter();
    const outcome = await router({ ...INPUT, openThreadTitles: ["线索一"] });
    expect(outcome).toEqual(MODEL_OUTCOME);
    expect(ledgerMock.declareChapterDeltaByLedger).toHaveBeenCalledWith(expect.objectContaining({
      projectDir: INPUT.projectDir,
      chapter: 3,
      openThreadTitles: ["线索一"],
      maxCatchUp: 10,
    }));
  });

  it("记账员没准备好（not_ready）→ 这次声明按 fallback 如实说「还在读前文」，后台补它的笔记", async () => {
    const dir = await makeHomeTempDir("ledger-route-");
    await mkdir(join(dir, "chapters"), { recursive: true });
    await writeFile(join(dir, "chapters", "0001.md"), "# 第1章\n\n正文1。\n", "utf-8");
    await writeFile(join(dir, "chapters", "0002.md"), "# 第2章\n\n正文2。\n", "utf-8");
    ledgerMock.declareChapterDeltaByLedger.mockResolvedValue({
      outcome: { status: "fallback", reason: "记账员还在读前文，这次没有记账" },
      skipped: "not_ready",
      pending: { done: 0, total: 2 },
    } satisfies LedgerDeclareResult);
    const router = buildDeclareDeltaRouter({
      ledgerCallModel: async () => "记账笔记",
    });
    const outcome = await router({ chapter: 3, draft: "正文。", projectDir: dir });
    // 不拿旧声明顶：如实 fallback，原因一路带进 declarationStatus=fallback 的通道。
    expect(outcome).toEqual({ status: "fallback", reason: "记账员还在读前文，这次没有记账" });
    // 后台补笔记（void 不等待）：轮询等到记账员第 1、2 章笔记落盘。
    const notesPath = join(dir, "agents", LEDGER_ROLE.id, "notes");
    for (let i = 0; i < 40 && !(await readFile(join(notesPath, "0002.json"), "utf-8").then(() => true, () => false)); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(await readFile(join(notesPath, "0002.json"), "utf-8")).toContain("记账笔记");
  });

  it("拿不到 projectDir → 如实 fallback（没有打开的书，没法记账），不碰记账员", async () => {
    const router = buildDeclareDeltaRouter();
    const outcome = await router({ chapter: 2, draft: "正文。" });
    expect(outcome).toEqual({ status: "fallback", reason: expect.stringContaining("没有打开的书") });
    expect(ledgerMock.declareChapterDeltaByLedger).not.toHaveBeenCalled();
  });
});
