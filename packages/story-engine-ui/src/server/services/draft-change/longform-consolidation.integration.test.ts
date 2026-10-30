// @vitest-environment node
//
// 收口阶段·端到端确定性集成测试（审计点名"完全缺失"的验证闭环）。
// 程序造一本"大书"——50 张人物卡 / 502 条硬事实(含早期相关 + 已取代) / 179 章定稿 + 长时间线——
// 走真实写稿操作（draft.change 配方 + 执行器，同时串起①默认预算 ②在场角色软 cap ③事实相关性），
// 用 mock writerClient 截获喂给模型的最终上下文 envelope，断言"长篇不崩"的硬指标真成立：
//   ① 不炸：动态上下文被默认预算压在 12000 以内（timeline 被裁）。
//   ② 堵 stable：50 角色 + 上章点名一大票时，选中角色被软 cap 到 ≤8、收窄露在诊断。
//   ③ 不忘：早期但与本章方向相关的硬设定(遗产)在 180 章仍喂；已取代的旧设定(资金冻结)不喂。
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cardWrite, runCommand } from "@actalk/story-core";
import { createStoryProject } from "../../book/project-store.js";
import { makeHomeTempDir } from "../../lib/home-test-tmp.js";
import { __resetOperationStoreForTests } from "../../lib/operations/store.js";
import { type WriterClient } from "../../writing/fast-draft-writer.js";
import { type WriterContextEnvelope } from "../../writing/context-gateway.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __drainOperationsForTests, __resetRecipesForTests } from "../operations/executor.js";
import { fakeDraftDeps, fakePlanner, quietReader, runDraftChange } from "../operations/recipes/draft-change-kit.js";
import { ensureBookOnCore } from "../../book/ensure-on-core.js";
import { checkerRoleFor, DEFAULT_READER_VARIANT } from "../../editorial/checker.js";
import { PLANNER_ROLE } from "../../editorial/planner.js";
import { ensureReaderWindow } from "../../editorial/reader-window.js";

import { DEFAULT_TOKEN_BUDGET } from "../../writing/rank-writer-context.js";
import { DEFAULT_MAX_IN_SCENE_CHARACTERS } from "../../writing/presence/in-scene-detector.js";

let rootDir: string | undefined;
beforeEach(() => {
  __resetOperationStoreForTests();
  __resetRecipesForTests();
});
afterEach(async () => {
  await __drainOperationsForTests();
  vi.unstubAllEnvs();
  if (rootDir) await rm(rootDir, { recursive: true, force: true });
  rootDir = undefined;
});

const FIRST = "甲乙丙丁戊己庚辛壬癸";
const SECOND = "山川海峰原野泽州城郊";
/** 50 个互不为子串的 2 字配角名（避开主角名"林晚舟"的字）。 */
function supportingName(index: number): string {
  return FIRST[index % 10] + SECOND[Math.floor(index / 10) % 10];
}

async function buildBigBook(): Promise<string> {
  rootDir = await makeHomeTempDir("longform-consolidation-");
  vi.stubEnv("SE_DATA_DIR", join(rootDir, "data"));
  const { projectDir } = await createStoryProject({
    rootDir,
    title: "长篇收口验证书",
    genre: "都市",
    logline: "主角卷入一桩跨越多年的遗产纷争。",
    protagonistName: "林晚舟",
  });

  // —— 50 角色：主角（开书时建的卡）+ 49 个配角卡 ——
  const outcome = await runCommand(projectDir, cardWrite, {
    ops: Array.from({ length: 49 }, (_, i) => ({
      op: "card.create" as const, kind: "character" as const, name: supportingName(i + 1), fields: [{ label: "性格", value: "沉稳，说话平实" }],
    })),
  }, { caller: "author", idempotencyKey: "longform-cast" });
  if (!outcome.ok) throw new Error(outcome.message);

  // —— 502 条硬事实：早期相关锚点 + 已取代 + 500 条无关填充 ——
  const facts = [
    { id: "anchor", chapter: 3, text: "遗产共三亿、藏在境外信托不可动用", source: "manual" },
    { id: "frozen", chapter: 5, text: "资金被冻结暂时不能动", source: "manual", supersededByChapter: 50 },
    ...Array.from({ length: 500 }, (_, i) => ({
      id: `fil-${i}`,
      chapter: 10 + (i % 169),
      text: "市井见闻家长里短闲谈琐碎无关紧要",
      source: "auto" as const,
    })),
  ];
  await mkdir(join(projectDir, "story"), { recursive: true });
  await writeFile(join(projectDir, "story", "fact-ledger.json"), `${JSON.stringify({ version: "v0", facts }, null, 2)}\n`, "utf-8");

  // —— 400 章时间线（每条都长）：逼动态上下文超默认预算，验证①真的裁 ——
  const longSummary =
    "主角辗转于城北旧仓库、城南码头与市中心写字楼之间反复核对一份牵涉金额时间地点与多方对手的复杂账目处处提防唯恐一步走错满盘皆输";
  await mkdir(join(projectDir, "timeline"), { recursive: true });
  await writeFile(
    join(projectDir, "timeline", "events.json"),
    `${JSON.stringify(Array.from({ length: 400 }, (_, i) => ({ id: `ev-${i + 1}`, chapter: i + 1, summary: `第${i + 1}章：${longSummary}`, participants: ["林晚舟"] })), null, 2)}\n`,
    "utf-8",
  );

  // —— 前 178 章定稿正文（开书时按老账导进核心：时间线、事实只导有正文的章）——
  await mkdir(join(projectDir, "chapters"), { recursive: true });
  for (let chapter = 1; chapter < 179; chapter += 1) {
    await writeFile(join(projectDir, "chapters", `${String(chapter).padStart(4, "0")}.md`), `# 第${chapter}章\n\n林晚舟照常过日子。\n`, "utf-8");
  }
  // —— 上一章(179)正文点名 c01..c20 →20 个被命中 + 主角 = 21 选中 → 触发②软 cap ——
  const prevNames = Array.from({ length: 20 }, (_, i) => supportingName(i + 1));
  await writeFile(
    join(projectDir, "chapters", "0179.md"),
    `# 第179章\n\n${prevNames.map((name) => `${name}在会上各执一词，气氛紧绷。`).join("")}\n`,
    "utf-8",
  );

  // 开书接上核心（老账按章导进账单），再让章纲员、核账员把前 179 章读完：长篇里专员早就跟读着，写第 180 章不用停下等补读。
  const onCore = await ensureBookOnCore(projectDir);
  if (!onCore.ok) throw new Error(onCore.reason);
  await ensureReaderWindow({ projectDir, role: PLANNER_ROLE, upTo: 179, callModel: fakePlanner() });
  await ensureReaderWindow({ projectDir, role: checkerRoleFor(DEFAULT_READER_VARIANT.structuredNotes), upTo: 179, callModel: quietReader });

  return projectDir;
}

/** 截获喂给模型的最终上下文 envelope；返回足够长且提到主角的正文让出稿通过。 */
function capturingWriterClient(): { client: WriterClient; captured: () => WriterContextEnvelope | undefined } {
  let captured: WriterContextEnvelope | undefined;
  const para = "林晚舟在走廊尽头停下脚步，反复掂量手里这份账册的分量，盘算着接下来每一步该怎么走才不至于落人话柄，心里那根弦始终绷得紧紧的。";
  return {
    client: {
      async generateDraft({ context }) {
        captured = context;
        return { title: "第180章", content: [para, para, para, para].join("\n\n") };
      },
    },
    captured: () => captured,
  };
}

function dynamicTokens(envelope: WriterContextEnvelope): number {
  return envelope.sections.filter((section) => section.cachePolicy !== "stable").reduce((sum, section) => sum + section.tokenEstimate, 0);
}

describe("长篇收口 端到端：①预算 + ②角色软cap + ③事实相关性 在一本大书上一起成立", () => {
  it("180 章 / 50 角色 / 502 事实 / 长时间线：不炸 + 不忘 + 堵 stable", async () => {
    const projectDir = await buildBigBook();
    const { client, captured } = capturingWriterClient();

    const { body: out } = await runDraftChange(projectDir, "write", {
      chapter: 180,
      direction: "本章揭露遗产的真相",
      maxTimelineEvents: 400, // 放大时间线，逼①出手
      // 故意不传 contextTokenBudget —— 模拟对话里交的写稿，验证默认预算通电
      allowWriteAhead: true,
    }, fakeDraftDeps({ writerClient: client }));

    const envelope = captured();
    expect(envelope).toBeDefined();
    if (!envelope) return;

    // ① 不炸：动态上下文被默认预算压在 12000 以内，且 timeline 确实被裁
    expect(dynamicTokens(envelope)).toBeLessThanOrEqual(DEFAULT_TOKEN_BUDGET);
    expect((out?.contextBudget as { readonly droppedSections?: readonly string[] } | undefined)?.droppedSections ?? []).toContain("timeline_events");

    // ② 堵 stable：50 角色 + 上章点名 20 人 → 选中被软 cap，收窄露在诊断
    expect(out?.characterSelection.selected.length ?? 99).toBeLessThanOrEqual(DEFAULT_MAX_IN_SCENE_CHARACTERS);
    expect(out?.characterSelection.selected[0]).toBe("林晚舟"); // 主角恒带、占名额
    expect(out?.characterSelection.cappedOutNames.length ?? 0).toBe(21 - DEFAULT_MAX_IN_SCENE_CHARACTERS);
    expect(out?.notes.join("\n")).toContain("按在场相关性收窄到");
    // 喂给写手的人物整张卡也被收窄：主角 + 至多 cap-1 个配角
    const setting = (envelope.sections.find((section) => section.name === "writing_context_pack")?.content as
      | { readonly setting?: { readonly cast?: readonly unknown[] } }
      | undefined)?.setting;
    expect(setting?.cast?.length ?? 99).toBeLessThanOrEqual(DEFAULT_MAX_IN_SCENE_CHARACTERS - 1);

    // ③ 不忘：早期但与本章方向(遗产)相关的硬设定在 180 章仍喂；已取代的旧设定不喂
    const pack = envelope.sections.find((section) => section.name === "writing_context_pack")?.content as
      | { readonly continuityFocus?: { readonly establishedFacts?: readonly string[] } }
      | undefined;
    const establishedFacts = pack?.continuityFocus?.establishedFacts ?? [];
    expect(establishedFacts).toContain("第3章：遗产共三亿、藏在境外信托不可动用");
    expect(establishedFacts.some((fact) => fact.includes("资金被冻结"))).toBe(false);
  }, 120_000); // 先让两个专员读完 179 章（盘重），并行跑时 20 秒不够
});
