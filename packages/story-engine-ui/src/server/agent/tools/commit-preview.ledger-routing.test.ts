// @vitest-environment node
/**
 * 声明路由（2026-10-12 编辑部 T2）：STORY_LEDGER=reader 时预览的章节声明先走记账员，
 * 没准备好（not_ready）回旧声明并后台补笔记；缺省直接旧声明。这里只测路由，不测两条路本身
 * （旧声明见 chapter-delta-declaration.test.ts，记账员见 brain/ledger.test.ts）。
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
  vi.stubEnv("STORY_LEDGER", undefined as unknown as string);
  ledgerMock.declareChapterDeltaByLedger.mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
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

describe("buildDeclareDeltaRouter（STORY_LEDGER 开关）", () => {
  it("没开（缺省）→ 直接旧声明，不碰记账员", async () => {
    const legacy = vi.fn(async () => ({ status: "fallback" as const, reason: "旧路" }));
    const router = buildDeclareDeltaRouter({ legacyDeclare: legacy });
    const outcome = await router({ ...INPUT });
    expect(outcome).toEqual({ status: "fallback", reason: "旧路" });
    expect(ledgerMock.declareChapterDeltaByLedger).not.toHaveBeenCalled();
  });

  it("STORY_LEDGER=reader 且有 projectDir → 走记账员，声明结果原样透传", async () => {
    vi.stubEnv("STORY_LEDGER", "reader");
    const legacy = vi.fn(async () => ({ status: "fallback" as const }));
    ledgerMock.declareChapterDeltaByLedger.mockResolvedValue({ outcome: MODEL_OUTCOME } satisfies LedgerDeclareResult);
    const router = buildDeclareDeltaRouter({ legacyDeclare: legacy });
    const outcome = await router({ ...INPUT, openThreadTitles: ["线索一"] });
    expect(outcome).toEqual(MODEL_OUTCOME);
    expect(legacy).not.toHaveBeenCalled();
    expect(ledgerMock.declareChapterDeltaByLedger).toHaveBeenCalledWith(expect.objectContaining({
      projectDir: INPUT.projectDir,
      chapter: 3,
      openThreadTitles: ["线索一"],
      maxCatchUp: 10,
    }));
  });

  it("记账员没准备好（not_ready）→ 这次走旧声明，后台补它的笔记", async () => {
    vi.stubEnv("STORY_LEDGER", "reader");
    const dir = await makeHomeTempDir("ledger-route-");
    await mkdir(join(dir, "chapters"), { recursive: true });
    await writeFile(join(dir, "chapters", "0001.md"), "# 第1章\n\n正文1。\n", "utf-8");
    await writeFile(join(dir, "chapters", "0002.md"), "# 第2章\n\n正文2。\n", "utf-8");
    const legacy = vi.fn(async () => ({ status: "fallback" as const, reason: "旧声明" }));
    ledgerMock.declareChapterDeltaByLedger.mockResolvedValue({
      outcome: { status: "fallback", reason: "记账员还在读前文" },
      skipped: "not_ready",
    } satisfies LedgerDeclareResult);
    const router = buildDeclareDeltaRouter({
      legacyDeclare: legacy,
      ledgerCallModel: async () => "记账笔记",
    });
    const outcome = await router({ chapter: 3, draft: "正文。", projectDir: dir });
    expect(outcome).toEqual({ status: "fallback", reason: "旧声明" });
    // 后台补笔记（void 不等待）：轮询等到记账员第 1、2 章笔记落盘。
    const notesPath = join(dir, "agents", LEDGER_ROLE.id, "notes");
    for (let i = 0; i < 40 && !(await readFile(join(notesPath, "0002.json"), "utf-8").then(() => true, () => false)); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(await readFile(join(notesPath, "0002.json"), "utf-8")).toContain("记账笔记");
  });

  it("拿不到 projectDir（老调用方没传）→ 即使开着也走旧声明", async () => {
    vi.stubEnv("STORY_LEDGER", "reader");
    const legacy = vi.fn(async () => ({ status: "fallback" as const, reason: "旧路" }));
    const router = buildDeclareDeltaRouter({ legacyDeclare: legacy });
    await router({ chapter: 2, draft: "正文。" });
    expect(legacy).toHaveBeenCalledTimes(1);
    expect(ledgerMock.declareChapterDeltaByLedger).not.toHaveBeenCalled();
  });
});
