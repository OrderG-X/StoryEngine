// @vitest-environment node
//
// 「AI 记账、作者核账」端到端：预览时算好硬事实、列出账本清单 → 作者勾掉几条 → 按钮定稿时勾掉的不写，事实不再现抽。
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createStoryProject } from "@actalk/story-engine";
import type { ToolExecutionContext } from "@mastra/core/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeHomeTempDir } from "../../lib/home-test-tmp.js";
import { buildProjectRequestContext, markUserConfirmedTool } from "../request-context.js";
import { commitApplyTool } from "../tools/commit-apply.js";
import { buildCommitPreviewToolOutput } from "../tools/commit-preview.js";
import { __resetCommitPreviewStore } from "../tools/commit-preview-store.js";

const llmMocks = vi.hoisted(() => ({ streamChatModelToText: vi.fn(), resolveConfiguredChatModel: vi.fn() }));
vi.mock("../../lib/llm-client.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../lib/llm-client.js")>()), ...llmMocks }));

type ToolExec = (input: Record<string, unknown>, context: ToolExecutionContext) => Promise<Record<string, unknown>>;
const execute = commitApplyTool.execute as unknown as ToolExec;

const SENTENCE = "林远在会议室外停下脚步，摸出那把铜钥匙掂了掂，盘算着接下来每一步该怎么走。";
const DRAFT = `# 第1章\n\n${Array.from({ length: 12 }, () => SENTENCE).join("")}\n`;

beforeEach(() => {
  __resetCommitPreviewStore();
  vi.clearAllMocks();
});

describe("定稿前看账：勾掉的不写", () => {
  it("预览列出线索和事实；作者勾掉线索和一条事实 → 定稿后账本里没有它们，也没再调模型抽事实", async () => {
    const rootDir = await makeHomeTempDir("ledger-checklist-");
    const { projectDir } = await createStoryProject({ rootDir, title: "看账", genre: "都市", premise: "主角进入权力中心。", mainCharacterName: "林远" });
    await writeFile(join(projectDir, "drafts", "fast", "chapter-0001.md"), DRAFT, "utf-8");

    const preview = await buildCommitPreviewToolOutput({
      projectDir,
      chapter: 1,
      declareDelta: async () => ({
        chapter: 1,
        mainEvent: { summary: "林远掂量铜钥匙", quote: SENTENCE },
        seededForeshadowing: [{ summary: "铜钥匙开哪扇门", quote: SENTENCE }],
        resolvedForeshadowing: [],
        resourceDeltas: [],
        keyLeads: [],
      }),
      proposeFacts: async () => ({
        ok: true,
        adds: [{ text: "林远有一把铜钥匙", quote: SENTENCE }, { text: "林远在会议室外" }],
        changes: [],
        conflicts: [],
        newCharacters: [],
      }),
    });
    expect(preview.canCommit).toBe(true);
    const checklist = preview.ledgerChecklist ?? [];
    // 声明里埋的伏笔在引擎里记成一条新线索。
    const lead = checklist.find((item) => item.kind === "thread");
    expect(lead?.label).toBe("新线索：铜钥匙开哪扇门");
    expect(checklist[0]).toMatchObject({ kind: "day", removable: false });
    expect(checklist.filter((item) => item.kind === "fact").map((item) => item.label)).toEqual(["记下：林远有一把铜钥匙", "记下：林远在会议室外"]);

    const requestContext = buildProjectRequestContext(projectDir, 1);
    markUserConfirmedTool(requestContext, "commit_apply");
    const out = await execute({ chapter: 1, excluded: [lead!.id, "fact:1"] }, { requestContext } as unknown as ToolExecutionContext);
    expect(out.committed).toBe(true);
    expect(String(out.summary)).toContain("你去掉的 1 条没记");

    const threads = await readFile(join(projectDir, "story", "threads.json"), "utf-8").catch(() => "");
    expect(threads).not.toContain("铜钥匙开哪扇门");
    const ledger = JSON.parse(await readFile(join(projectDir, "story", "fact-ledger.json"), "utf-8")) as { facts: { text: string }[] };
    expect(ledger.facts.map((fact) => fact.text)).toEqual(["林远有一把铜钥匙"]);
    expect(llmMocks.streamChatModelToText).not.toHaveBeenCalled();
  });

  it("对照：什么都不勾 → 线索和两条事实都写进去", async () => {
    const rootDir = await makeHomeTempDir("ledger-checklist-");
    const { projectDir } = await createStoryProject({ rootDir, title: "看账3", genre: "都市", premise: "主角进入权力中心。", mainCharacterName: "林远" });
    await writeFile(join(projectDir, "drafts", "fast", "chapter-0001.md"), DRAFT, "utf-8");
    await buildCommitPreviewToolOutput({
      projectDir,
      chapter: 1,
      declareDelta: async () => ({
        chapter: 1,
        mainEvent: { summary: "林远掂量铜钥匙", quote: SENTENCE },
        seededForeshadowing: [{ summary: "铜钥匙开哪扇门", quote: SENTENCE }],
        resolvedForeshadowing: [],
        resourceDeltas: [],
        keyLeads: [],
      }),
      proposeFacts: async () => ({ ok: true, adds: [{ text: "林远有一把铜钥匙" }, { text: "林远在会议室外" }], changes: [], conflicts: [], newCharacters: [] }),
    });
    const requestContext = buildProjectRequestContext(projectDir, 1);
    markUserConfirmedTool(requestContext, "commit_apply");
    const out = await execute({ chapter: 1 }, { requestContext } as unknown as ToolExecutionContext);
    expect(out.committed).toBe(true);
    expect(await readFile(join(projectDir, "story", "threads.json"), "utf-8")).toContain("铜钥匙开哪扇门");
    const ledger = JSON.parse(await readFile(join(projectDir, "story", "fact-ledger.json"), "utf-8")) as { facts: { text: string }[] };
    expect(ledger.facts).toHaveLength(2);
  });

  it("勾掉了条目但预览票据没了（进程重启）→ 拒绝定稿、要求重新预览，不照写", async () => {
    const rootDir = await makeHomeTempDir("ledger-checklist-");
    const { projectDir } = await createStoryProject({ rootDir, title: "看账2", genre: "都市", premise: "主角进入权力中心。", mainCharacterName: "林远" });
    await writeFile(join(projectDir, "drafts", "fast", "chapter-0001.md"), DRAFT, "utf-8");
    const preview = await buildCommitPreviewToolOutput({ projectDir, chapter: 1 });
    __resetCommitPreviewStore();
    const requestContext = buildProjectRequestContext(projectDir, 1);
    markUserConfirmedTool(requestContext, "commit_apply");
    const out = await execute({ chapter: 1, previewToken: preview.previewToken, excluded: ["hook:hook-x"] }, { requestContext } as unknown as ToolExecutionContext);
    expect(out.committed).toBe(false);
    expect(out.refused).toBe(true);
  });
});
