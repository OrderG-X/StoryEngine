// @vitest-environment node
//
// 收口阶段·端到端确定性集成测试（审计点名"完全缺失"的验证闭环）。
// 程序造一本"大书"——50 角色 / 502 条硬事实(含早期相关 + 已取代) / 400 章时间线——
// 走真实出稿路径 runGenerateDraftToolLogic（同时串起①默认预算 ②在场角色软 cap ③事实相关性），
// 用 mock writerClient 截获喂给模型的最终上下文 envelope，断言"长篇不崩"的硬指标真成立：
//   ① 不炸：动态上下文被默认预算压在 12000 以内（timeline 被裁）。
//   ② 堵 stable：50 角色 + 上章点名一大票时，选中角色被软 cap 到 ≤8、收窄露在诊断。
//   ③ 不忘：早期但与本章方向相关的硬设定(遗产)在 180 章仍喂；已取代的旧设定(资金冻结)不喂。
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStoryProject } from "../../book/project-store.js";
import { type WriterClient } from "../../writing/fast-draft-writer.js";
import { type WriterContextEnvelope } from "../../writing/context-gateway.js";
import { describe, expect, it } from "vitest";

import { DEFAULT_TOKEN_BUDGET } from "../context-budget/rank-writer-context.js";
import { DEFAULT_MAX_IN_SCENE_CHARACTERS } from "../presence/in-scene-detector.js";
import { runGenerateDraftToolLogic } from "./generate-draft.js";

const FIRST = "甲乙丙丁戊己庚辛壬癸";
const SECOND = "山川海峰原野泽州城郊";
/** 50 个互不为子串的 2 字配角名（避开主角名"林晚舟"的字）。 */
function supportingName(index: number): string {
  return FIRST[index % 10] + SECOND[Math.floor(index / 10) % 10];
}

async function buildBigBook(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "longform-consolidation-"));
  const { projectDir } = await createStoryProject({
    rootDir,
    title: "长篇收口验证书",
    genre: "都市",
    premise: "主角卷入一桩跨越多年的遗产纷争。",
    mainCharacterName: "林晚舟",
  });

  // —— 50 角色：c00 主角 + c01..c49 配角 ——
  const characters = [
    { id: "c00", name: "林晚舟", role: "主角" },
    ...Array.from({ length: 49 }, (_, i) => ({ id: `c${String(i + 1).padStart(2, "0")}`, name: supportingName(i + 1), role: "配角" })),
  ];
  await writeFile(
    join(projectDir, "story", "character-bible.json"),
    `${JSON.stringify({ version: "v0", characters }, null, 2)}\n`,
    "utf-8",
  );
  await Promise.all(
    characters.map(async (character) => {
      const dir = join(projectDir, "characters", character.id);
      await mkdir(dir, { recursive: true });
      await Promise.all([
        writeFile(join(dir, "profile.json"), `${JSON.stringify({ id: character.id, name: character.name, identity: character.role === "主角" ? "protagonist" : "配角", appearance: {}, tags: [] }, null, 2)}\n`, "utf-8"),
        writeFile(join(dir, "core.json"), `${JSON.stringify({ characterId: character.id, personality: ["沉稳"], speechStyle: "平实" }, null, 2)}\n`, "utf-8"),
        writeFile(join(dir, "state.json"), `${JSON.stringify({ characterId: character.id, emotion: "calm", goal: "推进剧情", lastUpdatedChapter: null }, null, 2)}\n`, "utf-8"),
      ]);
    }),
  );

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
  await writeFile(join(projectDir, "story", "fact-ledger.json"), `${JSON.stringify({ version: "v0", facts }, null, 2)}\n`, "utf-8");

  // —— 400 章时间线（每条都长）：逼动态上下文超默认预算，验证①真的裁 ——
  const longSummary =
    "主角辗转于城北旧仓库、城南码头与市中心写字楼之间反复核对一份牵涉金额时间地点与多方对手的复杂账目处处提防唯恐一步走错满盘皆输";
  await mkdir(join(projectDir, "timeline"), { recursive: true });
  await writeFile(
    join(projectDir, "timeline", "events.json"),
    `${JSON.stringify(Array.from({ length: 400 }, (_, i) => ({ id: `ev-${i + 1}`, chapter: i + 1, summary: `第${i + 1}章：${longSummary}`, participants: ["c00"] })), null, 2)}\n`,
    "utf-8",
  );

  // —— 上一章(179)正文点名 c01..c20 →20 个被命中 + 主角 = 21 选中 → 触发②软 cap ——
  await mkdir(join(projectDir, "chapters"), { recursive: true });
  const prevNames = Array.from({ length: 20 }, (_, i) => supportingName(i + 1));
  await writeFile(
    join(projectDir, "chapters", "0179.md"),
    `# 第179章\n\n${prevNames.map((name) => `${name}在会上各执一词，气氛紧绷。`).join("")}\n`,
    "utf-8",
  );

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
  it("180 章 / 50 角色 / 502 事实 / 400 时间线：不炸 + 不忘 + 堵 stable", async () => {
    const projectDir = await buildBigBook();
    const { client, captured } = capturingWriterClient();

    const out = await runGenerateDraftToolLogic({
      projectDir,
      chapter: 180,
      chapterGoal: "本章揭露遗产的真相",
      maxTimelineEvents: 400, // 放大时间线，逼①出手
      // 故意不传 contextTokenBudget —— 模拟 agent 生产路径，验证默认预算通电
      writerClient: client,
    });

    const envelope = captured();
    expect(envelope).toBeDefined();
    if (!envelope) return;

    // ① 不炸：动态上下文被默认预算压在 12000 以内，且 timeline 确实被裁
    expect(dynamicTokens(envelope)).toBeLessThanOrEqual(DEFAULT_TOKEN_BUDGET);
    expect(out.contextBudget?.droppedSections ?? []).toContain("timeline_events");

    // ② 堵 stable：50 角色 + 上章点名 20 人 → 选中被软 cap，收窄露在诊断
    expect(out.characterSelection?.selectedCharacterIds.length ?? 99).toBeLessThanOrEqual(DEFAULT_MAX_IN_SCENE_CHARACTERS);
    expect(out.characterSelection?.trace.cappedOutNames?.length ?? 0).toBeGreaterThan(0);

    // ③ 不忘：早期但与本章方向(遗产)相关的硬设定在 180 章仍喂；已取代的旧设定不喂
    const pack = envelope.sections.find((section) => section.name === "writing_context_pack")?.content as
      | { readonly continuityFocus?: { readonly establishedFacts?: readonly string[] } }
      | undefined;
    const establishedFacts = pack?.continuityFocus?.establishedFacts ?? [];
    expect(establishedFacts).toContain("第3章：遗产共三亿、藏在境外信托不可动用");
    expect(establishedFacts.some((fact) => fact.includes("资金被冻结"))).toBe(false);
  });
});
