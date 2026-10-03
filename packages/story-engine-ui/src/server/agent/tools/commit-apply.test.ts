// @vitest-environment node
//
// commit_apply 纯逻辑单测：守卫「必须先 commit_preview 过同一章且草稿未变」否则诚实拒绝；
// 合格流程能入库并消费 token（防重复入库）。引擎写入用临时项目 fixture。
import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as storyEngine from "@actalk/story-engine";
import { createStoryProject, readCharacterMatrixLedger } from "@actalk/story-engine";
import type { ToolExecutionContext } from "@mastra/core/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildProjectRequestContext } from "../request-context.js";
import { extractAndAppendFacts } from "../fact-ledger/fact-ledger.js";
import { listSnapshots } from "../../lib/snapshot.js";
import {
  appendLifecycleNotesToSummary,
  appendNewCharactersToSummary,
  applyCommitToolLogic,
  buildThreadMaintenanceNote,
  callConfiguredFactModel,
  CLEANUP_VISIBLE_HINT_THRESHOLD,
  commitApplyTool,
  DECLARATION_FALLBACK_NOTICE,
  FACT_EXTRACTION_IDLE_TIMEOUT_MS,
  OPEN_THREADS_HINT_THRESHOLD,
  scrubBareEntityIdsFromText,
} from "./commit-apply.js";
import { buildCommitPreviewToolOutput } from "./commit-preview.js";
import { __resetCommitPreviewStore } from "./commit-preview-store.js";

// 入库后抽硬事实是非致命附加步骤，且会真连 LLM 网络（writer.example.com）——单测 mock 掉，
// 避免走完整 execute 路径的「currentChapter 兜底」测试依赖网络变 flaky（CI/离线必超时）。
// 入库主逻辑（applyCommitToolLogic）不经此函数，不受影响。
vi.mock("../fact-ledger/fact-ledger.js", () => ({
  extractAndAppendFacts: vi.fn(async () => ({ ok: true, added: 0, summary: "", newCharacters: [] })),
}));

// 硬事实抽取的模型调用边界（P2：走 streamChatModelToText 空闲超时，不再是非流式 20s 固定死表）。其余 llm-client 走真实现。
const llmMocks = vi.hoisted(() => ({
  resolveConfiguredChatModel: vi.fn(),
  streamChatModelToText: vi.fn(),
  callOpenAICompatibleChatModel: vi.fn(),
}));
vi.mock("../../lib/llm-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/llm-client.js")>();
  return { ...actual, ...llmMocks };
});

// 把 @actalk/story-engine 换成可 spy 的可变副本（importOriginal 保留所有真实实现）。
// 默认行为：透传真实引擎，其余测试不受影响。
// 目的：让用例C能用 vi.spyOn(storyEngineModule, 'buildCommitPlanFromProject') 注入失败，
// 验证候选转换失败时 commitFastDraft 仍正常运行（非致命降级路径）。
vi.mock("@actalk/story-engine", async (importOriginal) => {
  const original = await importOriginal<typeof import("@actalk/story-engine")>();
  return { ...original };
});

type ToolExec = (input: Record<string, unknown>, context: ToolExecutionContext) => Promise<unknown>;
const execute = commitApplyTool.execute as unknown as ToolExec;

beforeEach(() => {
  __resetCommitPreviewStore();
});

async function makeProject(title: string, mainCharacterName = "林远"): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "commit-apply-test-"));
  const { projectDir } = await createStoryProject({
    rootDir,
    title,
    genre: "都市",
    premise: "主角进入权力中心。",
    mainCharacterName,
  });
  return projectDir;
}

function longDraft(chapter: number, mainCharacterName: string): string {
  const sentence = `${mainCharacterName}在会议室外停下脚步，反复掂量手里那份账册的分量，盘算着接下来每一步该怎么走。`;
  const body = Array.from({ length: 12 }, () => sentence).join("");
  return `# 第${chapter}章\n\n${body}\n`;
}

async function writeDraft(projectDir: string, chapter: number, content: string): Promise<void> {
  await writeFile(
    join(projectDir, "drafts", "fast", `chapter-${String(chapter).padStart(4, "0")}.md`),
    content,
    "utf-8",
  );
}

describe("commit_apply 守卫", () => {
  it("未预览直接入库 → 拒绝（refused），不入库、不谎报", async () => {
    const projectDir = await makeProject("未预览", "林远");
    await writeDraft(projectDir, 1, longDraft(1, "林远"));
    const out = await applyCommitToolLogic({ projectDir, chapter: 1, previewToken: "fake-token" });
    expect(out.ok).toBe(false); // 统一诚实标志：被拒=未入库=ok:false（前端防谎报只认它）
    expect(out.committed).toBe(false);
    expect(out.refused).toBe(true);
    expect(out.refusalReason).toContain("commit_preview");
  });

  it("没有有效预览时，占位 previewToken 仍拒绝，伪造 token 偷不到入库", async () => {
    const projectDir = await makeProject("占位token无预览", "林远");
    await writeDraft(projectDir, 1, longDraft(1, "林远"));
    const out = await applyCommitToolLogic({ projectDir, chapter: 1, previewToken: "token_placeholder" });
    expect(out.ok).toBe(false);
    expect(out.committed).toBe(false);
    expect(out.refused).toBe(true);
    expect(out.refusalReason).toContain("commit_preview");
  });

  it("预览仍在 store 时，不传 previewToken 也能正式入库", async () => {
    const projectDir = await makeProject("store接管token", "林远");
    await writeDraft(projectDir, 1, longDraft(1, "林远"));
    const preview = await buildCommitPreviewToolOutput({ projectDir, chapter: 1 });
    expect(preview.canCommit).toBe(true);

    const out = await applyCommitToolLogic({ projectDir, chapter: 1 } as any);
    expect(out.ok).toBe(true);
    expect(out.committed).toBe(true);
    expect(out.refused).toBe(false);
  });

  it("预览仍在 store 时，空串、占位、乱编 token 都按 store record 校验并可入库", async () => {
    for (const token of ["", "   ", "token_placeholder", "f".repeat(64)]) {
      const projectDir = await makeProject(`store覆盖模型token-${token.length}`, "林远");
      await writeDraft(projectDir, 1, longDraft(1, "林远"));
      const preview = await buildCommitPreviewToolOutput({ projectDir, chapter: 1 });
      expect(preview.canCommit).toBe(true);

      const out = await applyCommitToolLogic({ projectDir, chapter: 1, previewToken: token });
      expect(out.ok).toBe(true);
      expect(out.committed).toBe(true);
      expect(out.refused).toBe(false);
    }
  });

  it("预览后 store 蒸发且不传 token → 拒绝并要求重新预览", async () => {
    const projectDir = await makeProject("store蒸发无token", "林远");
    await writeDraft(projectDir, 1, longDraft(1, "林远"));
    const preview = await buildCommitPreviewToolOutput({ projectDir, chapter: 1 });
    expect(preview.canCommit).toBe(true);
    __resetCommitPreviewStore();

    const out = await applyCommitToolLogic({ projectDir, chapter: 1 } as any);
    expect(out.ok).toBe(false);
    expect(out.committed).toBe(false);
    expect(out.refused).toBe(true);
    expect(out.refusalReason).toContain("commit_preview");
  });

  it("预览后草稿又改动且不传 token → 仍拒绝，不能现算 token 偷过握手", async () => {
    const projectDir = await makeProject("store接管但草稿变更", "林远");
    await writeDraft(projectDir, 1, longDraft(1, "林远"));
    const preview = await buildCommitPreviewToolOutput({ projectDir, chapter: 1 });
    expect(preview.canCommit).toBe(true);

    await writeDraft(projectDir, 1, `${longDraft(1, "林远")}林远又补了一句话改动了草稿内容。\n`);
    const out = await applyCommitToolLogic({ projectDir, chapter: 1 } as any);
    expect(out.ok).toBe(false);
    expect(out.committed).toBe(false);
    expect(out.refused).toBe(true);
    expect(out.refusalReason).toContain("重新 commit_preview");
  });

  it("store 蒸发后 token 错误 → 拒绝", async () => {
    const projectDir = await makeProject("错token", "林远");
    await writeDraft(projectDir, 1, longDraft(1, "林远"));
    await buildCommitPreviewToolOutput({ projectDir, chapter: 1 });
    __resetCommitPreviewStore();
    const out = await applyCommitToolLogic({ projectDir, chapter: 1, previewToken: "wrong-token" });
    expect(out.committed).toBe(false);
    expect(out.refused).toBe(true);
  });

  it("预览后草稿又改动 → 拒绝（draft_changed），要求重新预览", async () => {
    const projectDir = await makeProject("草稿变更", "林远");
    await writeDraft(projectDir, 1, longDraft(1, "林远"));
    const preview = await buildCommitPreviewToolOutput({ projectDir, chapter: 1 });
    expect(preview.previewToken).toBeTruthy();
    // 预览后改草稿
    await writeDraft(projectDir, 1, `${longDraft(1, "林远")}林远又补了一句话改动了草稿内容。\n`);
    const out = await applyCommitToolLogic({ projectDir, chapter: 1, previewToken: preview.previewToken! });
    expect(out.committed).toBe(false);
    expect(out.refused).toBe(true);
    expect(out.refusalReason).toContain("重新 commit_preview");
  });

  it("合格流程：预览→带 token 入库成功；同章再入库走 A7 幂等（已入库同内容→幂等成功、不重复写入）", async () => {
    const projectDir = await makeProject("合格入库", "林远");
    await writeDraft(projectDir, 1, longDraft(1, "林远"));
    const preview = await buildCommitPreviewToolOutput({ projectDir, chapter: 1 });
    expect(preview.canCommit).toBe(true);

    const out = await applyCommitToolLogic({ projectDir, chapter: 1, previewToken: preview.previewToken! });
    expect(out.ok).toBe(true); // 真入库成功 → ok:true
    expect(out.refused).toBe(false);
    expect(out.committed).toBe(true);
    expect(out.refreshScope).toBe("full");
    expect(out.summary).toContain("第 1 章已定稿，资料已更新");
    expect(out.summary).toContain("改动已建立存档点");
    const report = out.report as { passed: boolean; chapter: number };
    expect(report.passed).toBe(true);
    // 入库成功必须回传章节正文（去标题），供前端以 committed 状态载入工作区、防 autosave 复活已入库章节。
    expect(out.draftBody).toContain("林远在会议室外停下脚步");
    expect(out.draftBody).not.toContain("# 第1章");
    // 标题为纯章号（无副标题）时 draftTitle 留空，不把「第1章」当成标题强行回传。
    expect(out.draftTitle).toBeUndefined();

    // A7 幂等：该章已入库、且草稿内容没变 → 再次入库幂等回报「已入库」（committed=true、不 refused、不重复写入）。
    // 这是断流后重试的正解：不再因 token 被消费而误报「尚未预览」让用户以为没入库。
    const again = await applyCommitToolLogic({ projectDir, chapter: 1, previewToken: preview.previewToken! });
    expect(again.ok).toBe(true);
    expect(again.committed).toBe(true);
    expect(again.refused).toBe(false);
    expect(again.summary).toContain("重复请求");
  });

  it("R3：预览后 store 蒸发（重启/换会话）→ 带同 token 仍能首次入库（无状态重算，不再 no_preview 卡死）", async () => {
    const projectDir = await makeProject("断流入库", "林远");
    await writeDraft(projectDir, 1, longDraft(1, "林远"));
    const preview = await buildCommitPreviewToolOutput({ projectDir, chapter: 1 });
    expect(preview.canCommit).toBe(true);
    __resetCommitPreviewStore(); // 模拟进程重启 / 换会话：预览 token 内存记录蒸发
    const out = await applyCommitToolLogic({ projectDir, chapter: 1, previewToken: preview.previewToken! });
    expect(out.ok).toBe(true); // 草稿没变 → 重算 token 仍匹配 → 首次入库照样成功
    expect(out.committed).toBe(true);
    expect(out.refused).toBe(false);
  });
});

describe("commit_apply 章号缺省回退（H3）", () => {
  it("不传 previewToken 但注入 currentChapter 且已有预览 → 工具用系统票据入库", async () => {
    const projectDir = await makeProject("execute无token", "林远");
    await writeDraft(projectDir, 5, longDraft(5, "林远"));
    const preview = await buildCommitPreviewToolOutput({ projectDir, chapter: 5 });
    expect(preview.canCommit).toBe(true);
    const context = { requestContext: buildProjectRequestContext(projectDir, 5) } as unknown as ToolExecutionContext;

    const out = await execute({}, context) as { committed: boolean; report: { chapter: number } };
    expect(out.committed).toBe(true);
    expect(out.report.chapter).toBe(5);
  });

  it("注入本轮用户原话但没有正式入库意图 → 写入前拦截，不入库也不建快照", async () => {
    const projectDir = await makeProject("本轮意图门-拦自动入库", "林远");
    await writeDraft(projectDir, 5, longDraft(5, "林远"));
    const preview = await buildCommitPreviewToolOutput({ projectDir, chapter: 5 });
    expect(preview.canCommit).toBe(true);
    const beforeSnapshots = await listSnapshots(projectDir);
    const context = {
      requestContext: buildProjectRequestContext(projectDir, 5, undefined, "继续写第5章正文。只写这一章，不要写其他章。"),
    } as unknown as ToolExecutionContext;

    const out = await execute({}, context) as { ok: boolean; committed: boolean; blockedReason?: string; summary: string };

    expect(out.ok).toBe(false);
    expect(out.committed).toBe(false);
    expect(out.blockedReason).toBe("user_turn_no_commit_intent");
    expect(out.summary).toContain("本回合用户没有明确要求定稿");
    expect(out.summary).toContain("确认定稿");
    expect(out.summary).toContain("确认正式入库");
    await expect(access(join(projectDir, "chapters", "0005.md"))).rejects.toThrow();
    expect(await listSnapshots(projectDir)).toHaveLength(beforeSnapshots.length);
  });

  it("注入本轮用户原话且有正式入库意图 → 正常入库", async () => {
    const projectDir = await makeProject("本轮意图门-允许入库", "林远");
    await writeDraft(projectDir, 5, longDraft(5, "林远"));
    const preview = await buildCommitPreviewToolOutput({ projectDir, chapter: 5 });
    expect(preview.canCommit).toBe(true);
    const context = {
      requestContext: buildProjectRequestContext(projectDir, 5, undefined, "把第5章草稿走完预览并正式入库。"),
    } as unknown as ToolExecutionContext;

    const out = await execute({}, context) as { committed: boolean; report: { chapter: number } };

    expect(out.committed).toBe(true);
    expect(out.report.chapter).toBe(5);
  });

  it("不传 chapter 但注入 currentChapter:5 → 工具用第5章执行", async () => {
    const projectDir = await makeProject("回退到当前章", "林远");
    await writeDraft(projectDir, 5, longDraft(5, "林远"));
    const preview = await buildCommitPreviewToolOutput({ projectDir, chapter: 5 });
    expect(preview.canCommit).toBe(true);
    const context = { requestContext: buildProjectRequestContext(projectDir, 5) } as unknown as ToolExecutionContext;
    // 不传 chapter，工具应从 context 中读取 currentChapter:5 执行入库
    const out = await execute({ previewToken: preview.previewToken }, context) as { committed: boolean; report: { chapter: number } };
    expect(out.committed).toBe(true);
    expect(out.report.chapter).toBe(5);
  });

  it("不传 chapter 且 context 无 currentChapter → throw 含「缺少章号」", async () => {
    const projectDir = await makeProject("无章号", "林远");
    const preview = await buildCommitPreviewToolOutput({ projectDir, chapter: 1 });
    const context = { requestContext: buildProjectRequestContext(projectDir) } as unknown as ToolExecutionContext;
    // 不传 chapter 且 context 无 currentChapter → 应 throw 含「缺少章号」
    await expect(execute({ previewToken: preview.previewToken ?? "tok" }, context)).rejects.toThrow("缺少章号");
  });
});

describe("commit_apply 角色候选持久化（Task 8）", () => {
  // 构造一章草稿：主角林远 + 新人物林静（二字名·非主角·过 isLikelyNewCharacterName 启发式）
  // 关键模式："看见林静" 匹配 extractPossibleCharacterMentions 的 pattern 2
  // （看见|看到|...）\s*([一-龥]{2,4})
  // 正文量须 ≥ 300 汉字（默认阈值），重复基础句到 12 次确保通过字数门槛
  function draftWithNewCharacter(chapter: number, mainChar: string): string {
    const pad = Array.from({ length: 12 }, () => `${mainChar}在会议室外停下脚步，反复掂量手里那份账册的分量，盘算着接下来每一步该怎么走。`).join("");
    const body = [
      `${mainChar}推开会议室的门，一眼看见林静站在走廊对面，手里拿着一叠文件。`,
      `林静点头示意，把文件推过来，低声说了几个字。`,
      `${mainChar}接过文件，重新盘算着接下来每一步。`,
      `林静看了他一眼，没有再开口。`,
      pad,
    ].join("");
    return `# 第${chapter}章\n\n${body}\n`;
  }

  // 构造一章草稿：仅含误抓词（对方/保安），不含真实新人物名
  // 同样保证 ≥ 300 汉字
  function draftWithNoiseOnly(chapter: number, mainChar: string): string {
    const pad = Array.from({ length: 12 }, () => `${mainChar}在会议室外停下脚步，反复掂量手里那份账册的分量，盘算着接下来每一步该怎么走。`).join("");
    const body = [
      `${mainChar}推开会议室的门，对方站在走廊对面，手里拿着一叠文件。`,
      `对方点头示意，保安把文件推过来，低声说了几个字。`,
      `${mainChar}接过文件，重新盘算着接下来每一步。`,
      `对方看了他一眼，没有再开口。`,
      pad,
    ].join("");
    return `# 第${chapter}章\n\n${body}\n`;
  }

  it("用例A：章节含新人物名(林静)→入库后不再被正则写成候选（治脏·2026-06-24 改为告知）", async () => {
    const projectDir = await makeProject("停脏不写候选", "林远");
    await writeDraft(projectDir, 1, draftWithNewCharacter(1, "林远"));
    const preview = await buildCommitPreviewToolOutput({ projectDir, chapter: 1 });
    expect(preview.canCommit).toBe(true);

    const out = await applyCommitToolLogic({ projectDir, chapter: 1, previewToken: preview.previewToken! });
    expect(out.ok).toBe(true);
    expect(out.committed).toBe(true);

    // 停掉正则注入后，林静不再被自动写进矩阵（新人物改走入库后『告知』，由用户决定建卡）。
    const matrix = await readCharacterMatrixLedger(projectDir);
    const linJing = matrix.entries.find((entry) => entry.name === "林静");
    expect(linJing, "林静不应被自动写进 character-matrix").toBeUndefined();
  });

  it("用例B：误抓词（对方/保安）不应写入 character-matrix（守住不污染）", async () => {
    const projectDir = await makeProject("噪声防污染", "林远");
    await writeDraft(projectDir, 1, draftWithNoiseOnly(1, "林远"));
    const preview = await buildCommitPreviewToolOutput({ projectDir, chapter: 1 });
    expect(preview.canCommit).toBe(true);

    const out = await applyCommitToolLogic({ projectDir, chapter: 1, previewToken: preview.previewToken! });
    expect(out.ok).toBe(true);
    expect(out.committed).toBe(true);

    // 入库后读 character-matrix.json，断言误抓词未出现
    const matrix = await readCharacterMatrixLedger(projectDir);
    const duifang = matrix.entries.find((entry) => entry.name.includes("对方"));
    const baoan = matrix.entries.find((entry) => entry.name.includes("保安"));
    expect(duifang, "\"对方\"不应被登记").toBeUndefined();
    expect(baoan, "\"保安\"不应被登记").toBeUndefined();
  });

  it("用例D：入库 summary 用真实显示名点名已更新角色，不暴露 slug", async () => {
    const projectDir = await makeProject("点名已更新角色", "林远");
    // 含『决定/怀疑』触发主角状态更新；report.updatedCharacters 是 slug，需按 overview 映射回真名。
    const sentence = "林远在会议室外停下脚步，反复掂量手里那份账册的分量，决定接下来每一步该怎么走，心里却隐隐生出怀疑。";
    await writeDraft(projectDir, 1, `# 第1章\n\n${Array.from({ length: 12 }, () => sentence).join("")}\n`);
    const preview = await buildCommitPreviewToolOutput({ projectDir, chapter: 1 });
    expect(preview.canCommit).toBe(true);
    const out = await applyCommitToolLogic({ projectDir, chapter: 1, previewToken: preview.previewToken! });
    expect(out.committed).toBe(true);
    expect(out.summary).not.toContain("更新角色"); // 旧『更新角色 N 个』格式已退役
    expect(out.summary).toContain("更新：林远"); // 真实显示名（不是 char-<hash> slug）
    expect(out.summary).not.toMatch(/char-[0-9a-f]/); // 绝不暴露内部 slug
  });
});

// 阶段 4：apply 复用 preview 阶段缓存的 declaration，不重复调模型；取不到则降级（declaration=undefined）。
describe("commit_apply 复用预览缓存的章节语义声明", () => {
  it("preview 缓存了 declaration → apply 把它透传给引擎（不重复调模型）", async () => {
    const projectDir = await makeProject("复用声明入库", "林远");
    await writeDraft(projectDir, 1, longDraft(1, "林远"));
    const declaration = {
      chapter: 1,
      mainEvent: { summary: "林远掂量账册的分量", quote: "林远在会议室外停下脚步" },
      seededForeshadowing: [],
      resolvedForeshadowing: [],
      resourceDeltas: [],
      keyLeads: [],
    };
    // preview 阶段注入声明（模拟模型调用），随 token 缓存。
    const preview = await buildCommitPreviewToolOutput({
      projectDir,
      chapter: 1,
      declareDelta: async () => declaration,
    });
    expect(preview.canCommit).toBe(true);

    const spy = vi.spyOn(storyEngine, "buildCommitPlanFromProject");
    try {
      const out = await applyCommitToolLogic({ projectDir, chapter: 1, previewToken: preview.previewToken! });
      expect(out.committed).toBe(true);
      // 引擎被调用时带上了预览缓存的 declaration（复用、不重复调模型）。
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ declaration }));
    } finally {
      spy.mockRestore();
    }
  });

  it("preview 未产生 declaration（store 无）→ apply 不带 declaration（降级，引擎走正则）", async () => {
    const projectDir = await makeProject("无声明入库降级", "林远");
    await writeDraft(projectDir, 1, longDraft(1, "林远"));
    // 不注入 declareDelta → record 无 declaration
    const preview = await buildCommitPreviewToolOutput({ projectDir, chapter: 1 });
    expect(preview.canCommit).toBe(true);

    const spy = vi.spyOn(storyEngine, "buildCommitPlanFromProject");
    try {
      const out = await applyCommitToolLogic({ projectDir, chapter: 1, previewToken: preview.previewToken! });
      expect(out.committed).toBe(true);
      const arg = spy.mock.calls.at(-1)?.[0] as { declaration?: unknown };
      expect(arg?.declaration).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  // P1（2026-10-02）：ChapterDelta 声明失败不再对用户静默——apply 摘要里必须明说「本章按确定性规则兜底」。
  it("预览阶段声明失败（fallback）→ 入库成功，但 summary 带【章节语义声明未生效】且 declarationStatus=fallback", async () => {
    const projectDir = await makeProject("声明失败入库提示", "林远");
    await writeDraft(projectDir, 1, longDraft(1, "林远"));
    const preview = await buildCommitPreviewToolOutput({
      projectDir,
      chapter: 1,
      declareDelta: async () => {
        throw new Error("模型连接静默超过 45s（一直没有任何响应），判定连接已死，请重试。");
      },
    });
    expect(preview.canCommit).toBe(true);
    expect(preview.declarationStatus).toBe("fallback");

    const out = await applyCommitToolLogic({ projectDir, chapter: 1, previewToken: preview.previewToken! });
    expect(out.ok).toBe(true);
    expect(out.committed).toBe(true);
    expect(out.declarationStatus).toBe("fallback");
    expect(out.summary).toContain(DECLARATION_FALLBACK_NOTICE);
    expect(out.summary).toContain("静默超过 45s");
    expect(out.summary).toContain("已定稿"); // 入库本身仍如实报成功
  });

  it("预览声明成功（model）→ summary 不带兜底提示，declarationStatus=model", async () => {
    const projectDir = await makeProject("声明成功无提示", "林远");
    await writeDraft(projectDir, 1, longDraft(1, "林远"));
    const preview = await buildCommitPreviewToolOutput({
      projectDir,
      chapter: 1,
      declareDelta: async () => ({
        chapter: 1,
        mainEvent: { summary: "林远掂量账册的分量", quote: "林远在会议室外停下脚步" },
        seededForeshadowing: [],
        resolvedForeshadowing: [],
        resourceDeltas: [],
        keyLeads: [],
      }),
    });
    const out = await applyCommitToolLogic({ projectDir, chapter: 1, previewToken: preview.previewToken! });
    expect(out.committed).toBe(true);
    expect(out.declarationStatus).toBe("model");
    expect(out.summary).not.toContain(DECLARATION_FALLBACK_NOTICE);
  });

  it("票据蒸发（进程重启/凭 token 无状态放行）→ 入库成功但如实说明「预览票据里取不到声明」", async () => {
    const projectDir = await makeProject("票据蒸发兜底提示", "林远");
    await writeDraft(projectDir, 1, longDraft(1, "林远"));
    const preview = await buildCommitPreviewToolOutput({
      projectDir,
      chapter: 1,
      declareDelta: async () => ({
        chapter: 1,
        mainEvent: { summary: "林远掂量账册的分量", quote: "林远在会议室外停下脚步" },
        seededForeshadowing: [],
        resolvedForeshadowing: [],
        resourceDeltas: [],
        keyLeads: [],
      }),
    });
    expect(preview.declarationStatus).toBe("model");
    __resetCommitPreviewStore(); // 模拟进程重启：内存票据蒸发，token 仍可按当前草稿无状态重算放行
    const out = await applyCommitToolLogic({ projectDir, chapter: 1, previewToken: preview.previewToken! });
    expect(out.committed).toBe(true);
    expect(out.declarationStatus).toBe("fallback");
    expect(out.summary).toContain(DECLARATION_FALLBACK_NOTICE);
    expect(out.summary).toContain("预览票据里取不到");
  });

  it("声明失败原因里的裸 id / 本地绝对路径不进用户可见摘要", async () => {
    const projectDir = await makeProject("声明原因消毒", "林远");
    await writeDraft(projectDir, 1, longDraft(1, "林远"));
    const preview = await buildCommitPreviewToolOutput({
      projectDir,
      chapter: 1,
      declareDelta: async () => {
        throw new Error("ENOENT /Users/someone/secret/book/char-abcd1234.json");
      },
    });
    const out = await applyCommitToolLogic({ projectDir, chapter: 1, previewToken: preview.previewToken! });
    expect(out.committed).toBe(true);
    expect(out.summary).toContain(DECLARATION_FALLBACK_NOTICE);
    expect(out.summary).not.toContain("/Users/someone");
    expect(out.summary).not.toMatch(/char-abcd1234/u);
    expect(out.declarationReason).not.toContain("/Users/someone");
  });
});

describe("callConfiguredFactModel（P2：硬事实抽取走流式空闲超时，不再是 20s 固定死表）", () => {
  it("chapterSteering 档、强制 thinking:false、json_object、idleTimeoutMs=FACT_EXTRACTION_IDLE_TIMEOUT_MS；不走非流式", async () => {
    llmMocks.resolveConfiguredChatModel.mockResolvedValue({
      provider: { id: "p", baseUrl: "https://x.invalid/v1" },
      profile: { id: "m", provider: "p", model: "m" },
      apiKey: "",
      thinking: true,
      thinkingDialect: "glm",
    });
    llmMocks.streamChatModelToText.mockResolvedValue({ content: "{\"facts\":[]}", thinking: "" });
    try {
      const text = await callConfiguredFactModel([{ role: "user", content: "抽事实" }]);
      expect(text).toBe("{\"facts\":[]}");
      expect(llmMocks.resolveConfiguredChatModel).toHaveBeenCalledWith("chapterSteering");
      expect(llmMocks.callOpenAICompatibleChatModel).not.toHaveBeenCalled();
      const call = llmMocks.streamChatModelToText.mock.calls[0]?.[0] as Record<string, unknown>;
      expect((call.configured as { thinking: boolean }).thinking).toBe(false);
      expect(call.responseFormat).toEqual({ type: "json_object" });
      expect(call.idleTimeoutMs).toBe(FACT_EXTRACTION_IDLE_TIMEOUT_MS);
      expect("timeoutMs" in call).toBe(false);
      expect("max_tokens" in call || "maxTokens" in call).toBe(false);
    } finally {
      vi.clearAllMocks();
    }
  });

  it("流式返回空内容 → 抛错（fact-ledger 收成 ok=false「没抽成」，不把空串当成功）", async () => {
    llmMocks.resolveConfiguredChatModel.mockResolvedValue({
      provider: { id: "p", baseUrl: "https://x.invalid/v1" },
      profile: { id: "m", provider: "p", model: "m" },
      apiKey: "",
      thinking: false,
      thinkingDialect: "none",
    });
    llmMocks.streamChatModelToText.mockResolvedValue({ content: " ", thinking: "" });
    try {
      await expect(callConfiguredFactModel([{ role: "user", content: "抽事实" }])).rejects.toThrow("空内容");
    } finally {
      vi.clearAllMocks();
    }
  });
});

describe("appendNewCharactersToSummary（新出现人物只告知不写盘）", () => {
  it("有新人物 → 折进摘要；空 → 原样", () => {
    expect(appendNewCharactersToSummary("第3章已定稿，资料已更新。", ["林静", "周明"]))
      .toBe("第3章已定稿，资料已更新。 这章还出现了新人物：林静、周明——要给谁正式建卡就说一声。");
    expect(appendNewCharactersToSummary("第3章已定稿，资料已更新。", [])).toBe("第3章已定稿，资料已更新。");
  });
});

describe("appendLifecycleNotesToSummary（r7 自动蛰伏必须折进可见摘要，绝不静默）", () => {
  it("有蛰伏的意图/阶段目标 → 摘要点名（各截 3 条），并说明写到即恢复", () => {
    const summary = appendLifecycleNotesToSummary("第30章已定稿，资料已更新。", {
      threadTracking: {
        expiredIntentThreads: [{ title: "主角去流云坊市买原料" }],
      },
      arcGoalTracking: {
        expiredArcGoals: [
          { title: "突破炼气七层瓶颈" },
          { title: "查清账房暗门" },
          { title: "找回失窃玉简" },
          { title: "结交外院管事" },
        ],
      },
    });
    expect(summary).toContain("自动蛰伏");
    expect(summary).toContain("意图线索 1 条（「主角去流云坊市买原料」）");
    expect(summary).toContain("阶段目标 4 条");
    expect(summary).toContain("「突破炼气七层瓶颈」");
    expect(summary).toContain("等 4 条"); // 只点名前 3 条，余量如实报总数
    expect(summary).not.toContain("结交外院管事");
    expect(summary).toContain("写到会自动恢复");
  });

  it("没有蛰伏条目 / report 结构缺失 → 摘要原样", () => {
    expect(appendLifecycleNotesToSummary("第3章已定稿，资料已更新。", { threadTracking: {} })).toBe("第3章已定稿，资料已更新。");
    expect(appendLifecycleNotesToSummary("第3章已定稿，资料已更新。", undefined)).toBe("第3章已定稿，资料已更新。");
  });
});

// 线索池体检提示（确定性、只提醒不动手）：长篇实测 10 章即可积到近 30 条 open 而作者毫无察觉——
// 工具/快照/意图门都在，缺的是提醒时机。清理本身仍要用户点头（意图门拦着），这里只补盲区。
describe("buildThreadMaintenanceNote（入库后线索堆积提醒）", () => {
  const overviewWith = (open: number, cleanupVisible: number) =>
    ({ threads: { open, cleanupVisibleCount: cleanupVisible } }) as unknown as storyEngine.StateOverview;

  it("open 达阈值 → 提醒带条数与「清理线索」说法", () => {
    const note = buildThreadMaintenanceNote(overviewWith(28, 0));
    expect(note).toContain("28 条");
    expect(note).toContain("清理线索");
    expect(note).toContain("可一键撤销");
  });

  it("低价值线索达阈值（open 未达）→ 也提醒，并点出低价值条数", () => {
    const note = buildThreadMaintenanceNote(overviewWith(10, CLEANUP_VISIBLE_HINT_THRESHOLD));
    expect(note).toContain(`${CLEANUP_VISIBLE_HINT_THRESHOLD} 条`);
    expect(note).toContain("低价值");
  });

  it("两项都低于阈值 / overview 缺失 → 不提醒（空串）", () => {
    expect(buildThreadMaintenanceNote(overviewWith(OPEN_THREADS_HINT_THRESHOLD - 1, 0))).toBe("");
    expect(buildThreadMaintenanceNote(overviewWith(5, CLEANUP_VISIBLE_HINT_THRESHOLD - 1))).toBe("");
    expect(buildThreadMaintenanceNote(undefined)).toBe("");
  });

  it("提示面向用户：不泄工具名、不冒英文行话（铁律④）", () => {
    const note = buildThreadMaintenanceNote(overviewWith(35, 12));
    expect(note).not.toMatch(/clean_legacy_threads|group_related_leads|commit_apply/u);
    expect(note).not.toMatch(/hook|thread|arc/iu);
  });
});

describe("commit_apply 入库后告知：knownNames 用真实显示名（防主角被误报为新人物）", () => {
  it("execute 给 extractAndAppendFacts 传的 knownNames 是真名、不含 slug", async () => {
    const mocked = vi.mocked(extractAndAppendFacts);
    mocked.mockClear();
    const projectDir = await makeProject("knownNames真名", "林远");
    await writeDraft(projectDir, 1, longDraft(1, "林远"));
    const preview = await buildCommitPreviewToolOutput({ projectDir, chapter: 1 });
    const context = { requestContext: buildProjectRequestContext(projectDir, 1) } as unknown as ToolExecutionContext;
    await execute({ previewToken: preview.previewToken }, context);

    expect(mocked).toHaveBeenCalledTimes(1);
    const known = mocked.mock.calls[0]![0].knownNames ?? [];
    expect(known).toContain("林远"); // 真实显示名（全量角色 roster）
    expect(known.some((n) => /^char-/.test(n))).toBe(false); // 不含 slug ID
  });
});

// 铁律④·绝不泄露裸 id/path：入库失败分支会把引擎 report.issues 逐字摊进给用户看的 summary/refusalReason，
// 里面可能含 commit-engine 合成的裸 hook-<hash>（幻影 hook）/char-/thread- 或本地绝对路径。进用户面前必须消毒。
describe("scrubBareEntityIdsFromText 失败摘要裸 id/path 消毒", () => {
  it("解析不到的 hook-<hash>（幻影 hook）→ 中性占位，绝不泄露裸 id", () => {
    const out = scrubBareEntityIdsFromText("Hook not found: hook-11s0ihy", new Map());
    expect(out).not.toContain("hook-11s0ihy");
  });

  it("能解析的 char-id → 角色名，不泄露 slug", () => {
    const out = scrubBareEntityIdsFromText("角色 char-ffe5af 状态异常", new Map([["char-ffe5af", "陆沉"]]));
    expect(out).toContain("陆沉");
    expect(out).not.toContain("char-ffe5af");
  });

  it("剥本地绝对路径，不把磁盘路径漏给用户", () => {
    const out = scrubBareEntityIdsFromText("open '/Users/author/story-engine/story/x/profile.json' 失败", new Map());
    expect(out).not.toContain("/Users/author");
  });

  it("普通文字与中文标题原样保留（只消毒裸 id/path）", () => {
    const out = scrubBareEntityIdsFromText("第 3 章入库计划缺少时间线锚点", new Map());
    expect(out).toBe("第 3 章入库计划缺少时间线锚点");
  });
});

describe("commit_apply 入库失败分支：摊给用户的 summary 消毒 + 不谎称已建快照", () => {
  it("commitFastDraft 报幻影 hook（passed:false, issues 含 hook-<hash>）→ summary 不泄露裸 id、也不谎称已建快照可撤销", async () => {
    const projectDir = await makeProject("入库失败消毒", "林远");
    await writeDraft(projectDir, 1, longDraft(1, "林远"));
    const preview = await buildCommitPreviewToolOutput({ projectDir, chapter: 1 });
    const spy = vi.spyOn(storyEngine, "commitFastDraft").mockResolvedValue({
      chapter: 1,
      passed: false,
      issues: ["Hook not found: hook-11s0ihy"],
      updatedCharacters: [],
      timelineEventIds: [],
      updatedHooks: [],
      updatedWorld: false,
      updatedCalendar: false,
    } as Awaited<ReturnType<typeof storyEngine.commitFastDraft>>);
    try {
      const out = await applyCommitToolLogic({ projectDir, chapter: 1, previewToken: preview.previewToken! });
      expect(out.committed).toBe(false);
      expect(out.summary).not.toContain("hook-11s0ihy"); // 裸 id 不泄露
      expect(out.summary).not.toContain("已建快照可撤销"); // 失败=已回滚，不谎称可撤销
    } finally {
      spy.mockRestore();
    }
  });
});
