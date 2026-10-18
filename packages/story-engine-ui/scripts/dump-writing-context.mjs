/**
 * dump-writing-context.mjs —— checkpoint 肉眼核对的关键工具（无逐章生成、无写盘）。
 *
 * 用法：
 *   node scripts/dump-writing-context.mjs --projectDir=<书目录> --chapter=10 [--ranked] [--chapterGoal="..."]
 *
 * 打印 writing_context_pack 段各字段命中情况（protagonist/supportingCast/location/worldRules/asset/
 * writingRules/continuityFocus.establishedFacts）+ trace token（裁剪前/后）+ renderFastDraftPromptText 长度
 * + readFactLedger 头尾。--ranked 套 makeWriterRankContext({tokenBudget:resolveWriterTokenBudget()}) 重算裁剪后 token。
 *
 * 老引擎函数（buildWriterContext/renderFastDraftPromptText/readFactLedger）已搬进 src/server/writing、src/server/book，经 r3-ts-hooks 动态 import；
 * 裁剪用 makeWriterRankContext/resolveWriterTokenBudget 是 UI 侧 `.ts` → 经 r3-ts-hooks 动态 import。
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./r3-ts-hooks.mjs", import.meta.url);

const { buildWriterContext } = await import("../src/server/writing/context-gateway.ts");
const { renderFastDraftPromptText } = await import("../src/server/writing/prompt-cache-diagnostics.ts");
const { readFactLedger } = await import("../src/server/book/project-store.ts");
const { makeWriterRankContext, resolveWriterTokenBudget } = await import(
  "../src/server/agent/context-budget/rank-writer-context.ts"
);

function parseArgs(argv) {
  const out = {};
  for (const raw of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/u.exec(raw);
    if (!m) continue;
    out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

function nonEmpty(value) {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function traceFrom(envelope) {
  return {
    totalTokenEstimate: envelope.trace.totalTokenEstimate,
    stableTokenEstimate: envelope.trace.stableTokenEstimate,
    dynamicTokenEstimate: envelope.trace.dynamicTokenEstimate,
    sectionNames: envelope.trace.sectionNames,
    promptTextLength: renderFastDraftPromptText(envelope).length,
  };
}

export async function dumpWritingContext({ projectDir, chapter, chapterGoal, ranked }) {
  // chapterGoal 是 buildWriterContext 的必填项（BuildWriterContextInput.chapterGoal: string），种子书干跑给占位即可。
  const goal = (chapterGoal ?? "").trim() || `继续第 ${chapter} 章。`;
  const envelope = await buildWriterContext({ projectDir, chapter, chapterGoal: goal, maxTimelineEvents: 8 });
  const packSection = envelope.sections.find((s) => s.name === "writing_context_pack");
  const pack = packSection?.content ?? {};

  const packFields = {
    "protagonistContext.extraFields": {
      hit: nonEmpty(pack.protagonistContext?.extraFields),
      value: pack.protagonistContext?.extraFields ?? [],
    },
    "supportingCast[].traits": {
      hit: (pack.supportingCast ?? []).some((c) => nonEmpty(c.traits)),
      value: (pack.supportingCast ?? []).map((c) => ({ name: c.name, traits: c.traits ?? [] })),
    },
    "assetContext.extraFields": {
      hit: nonEmpty(pack.assetContext?.extraFields),
      value: pack.assetContext?.extraFields ?? [],
    },
    "locationContext.extraFields": {
      hit: nonEmpty(pack.locationContext?.extraFields),
      value: pack.locationContext?.extraFields ?? [],
    },
    worldRulesContext: {
      hit: nonEmpty(pack.worldRulesContext),
      coreRules: pack.worldRulesContext?.coreRules ?? [],
      conflictSources: pack.worldRulesContext?.conflictSources ?? [],
      keys: Object.keys(pack.worldRulesContext ?? {}),
    },
    writingRulesContext: {
      hit: nonEmpty(pack.writingRulesContext),
      keys: Object.keys(pack.writingRulesContext ?? {}),
    },
    "continuityFocus.establishedFacts": {
      hit: nonEmpty(pack.continuityFocus?.establishedFacts),
      count: (pack.continuityFocus?.establishedFacts ?? []).length,
      value: pack.continuityFocus?.establishedFacts ?? [],
    },
  };

  const traceBefore = traceFrom(envelope);

  let traceAfter = null;
  let droppedSections = null;
  if (ranked) {
    const plan = makeWriterRankContext({ tokenBudget: resolveWriterTokenBudget() });
    const trimmed = plan.rankContext(envelope);
    traceAfter = traceFrom(trimmed);
    droppedSections = plan.droppedSections;
  }

  const ledger = await readFactLedger(projectDir);
  const facts = ledger?.facts ?? [];
  const headTail = (arr, n) =>
    arr.length <= n * 2
      ? arr
      : [...arr.slice(0, n), { _gap: arr.length - n * 2 }, ...arr.slice(arr.length - n)];
  const ledgerView = {
    factsLength: facts.length,
    sample: headTail(
      facts.map((f) => ({
        chapter: f.chapter,
        text: f.text,
        effectiveFromChapter: f.effectiveFromChapter ?? null,
        supersededByChapter: f.supersededByChapter ?? null,
      })),
      3,
    ),
  };

  return {
    projectDir,
    chapter,
    chapterGoal: goal,
    packFields,
    trace: { before: traceBefore, ...(ranked ? { afterRanked: traceAfter, droppedSections } : {}) },
    factLedger: ledgerView,
  };
}

// CLI 入口（被 r3-longform-e2e 复用时只 import dumpWritingContext，不触发本块）。
// 守卫用 pathToFileURL 规范化（项目路径含空格，import.meta.url 编码成 %20，旧字符串拼接永不相等）。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.projectDir || args.chapter === undefined) {
    console.error("用法：node scripts/dump-writing-context.mjs --projectDir=<书目录> --chapter=<N> [--ranked] [--chapterGoal=\"...\"]");
    process.exit(2);
  }
  const result = await dumpWritingContext({
    projectDir: String(args.projectDir),
    chapter: Number.parseInt(String(args.chapter), 10),
    chapterGoal: typeof args.chapterGoal === "string" ? args.chapterGoal : undefined,
    ranked: Boolean(args.ranked),
  });
  console.log(JSON.stringify(result, null, 2));
}
