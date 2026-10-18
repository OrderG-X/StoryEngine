/** R5a token 采样：对 180 章 fixture 在多个 chapter 跑 buildWriterContext + rankContext，判收敛。无 GLM。 */
import { register } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

register("./r3-ts-hooks.mjs", import.meta.url);

const { buildWriterContext } = await import("../src/server/writing/context-gateway.ts");
const { renderFastDraftPromptText } = await import("../src/server/writing/prompt-cache-diagnostics.ts");
const { makeWriterRankContext, resolveWriterTokenBudget } = await import(
  "../src/server/agent/context-budget/rank-writer-context.ts"
);

const projectDir = join(homedir(), "StoryEngine-NG-r5", "story-engine", "r5fix");
const budget = resolveWriterTokenBudget();
console.log(`token 预算 = ${budget}\n`);

const SAMPLES = [10, 50, 100, 150, 180];
const rows = [];
for (const chapter of SAMPLES) {
  const env = await buildWriterContext({ projectDir, chapter, chapterGoal: "继续推进剧情，主角与配角的关系再进一步。", maxTimelineEvents: 8 });
  const before = env.trace.totalTokenEstimate;
  const plan = makeWriterRankContext({ tokenBudget: budget });
  const trimmed = plan.rankContext(env);
  const after = trimmed.trace.totalTokenEstimate;
  const dropped = plan.droppedSections ?? [];
  const promptLen = renderFastDraftPromptText(trimmed).length;
  const secSizes = Object.fromEntries(trimmed.sections.map((s) => [s.name, s.tokenEstimate]));
  const details = (plan.droppedDetails ?? []).map((d) => `${d.name}:${d.reason}`);
  const threadsKept = trimmed.sections.some((s) => s.name === "story_threads");
  const arcKept = trimmed.sections.some((s) => s.name === "arc_goals");
  rows.push({ chapter, before, after, dropped, promptLen, secSizes, details, threadsKept, arcKept });
  console.log(`ch${String(chapter).padStart(3)}: 裁剪前=${before}  裁剪后=${after}  threads段保留=${threadsKept}  arc段保留=${arcKept}  详情=[${details.join(", ")}]`);
}

console.log("\n=== 裁剪后 token 曲线 ===");
console.log(rows.map((r) => `ch${r.chapter}:${r.after}`).join("  →  "));
const a = rows.map((r) => r.after);
const g50to180 = ((a[4] - a[1]) / a[1]) * 100;
const g100to180 = ((a[4] - a[2]) / a[2]) * 100;
console.log(`50→180 增幅 = ${g50to180.toFixed(1)}%   100→180 增幅 = ${g100to180.toFixed(1)}%`);
console.log(Math.abs(g100to180) < 10 ? "判定：收敛 ✅（裁剪后有上界，长篇 token 扛得住）" : "判定：发散 ❌（裁剪后随章数涨，需定位膨胀段）");

console.log("\n=== 裁剪前 token 曲线（对照）===");
console.log(rows.map((r) => `ch${r.chapter}:${r.before}`).join("  →  "));

console.log("\n=== 逐 section（裁剪后）ch10 → ch180，只列有变化的 ===");
const allSecs = new Set(rows.flatMap((r) => Object.keys(r.secSizes)));
for (const sec of allSecs) {
  const s10 = rows[0].secSizes[sec] ?? 0;
  const s180 = rows[4].secSizes[sec] ?? 0;
  if (s10 !== s180) console.log(`  ${sec}: ${s10} → ${s180}  (${s180 > s10 ? "+" : ""}${s180 - s10})`);
}
console.log("\n=== 各 chapter 被裁掉的段 ===");
for (const r of rows) console.log(`  ch${r.chapter}: [${r.dropped.join(", ")}]`);
