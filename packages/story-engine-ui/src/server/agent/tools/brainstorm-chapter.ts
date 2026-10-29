/**
 * brainstorm_chapter —— 头脑风暴（重构 P6 第 5 步）：章纲员出几种走法、核账员替每种对过前文，作者在稿纸上挑。
 *
 * 只读：不落章纲、不进账、不建快照。作者挑中的那种作为「这章的方向」交给写这一章（change_draft 的 chapterGoal / 写稿按钮的 direction）；
 * 没挑中的不留痕。取代原来的 generate_chapter_steering（确定性建议清单，不读前文）。
 */
import { createTool } from "@mastra/core/tools";
import type { ToolExecutionContext } from "@mastra/core/tools";
import { z } from "zod";
import { coerceNumber, coerceStringArray } from "../../lib/lenient-args.js";
import { readProjectDirFromContext, resolveChapterFromInputOrContext } from "../request-context.js";
import { brainstormChapter, callConfiguredBrainModel, callConfiguredPlannerModel, rereadBlocker, type BrainCallModel, type BrainstormOption } from "../../editorial/index.js";
import { requestReaderBackfill } from "../../lib/reader-backfill.js";

const inputSchema = z.object({
  chapter: coerceNumber(z.number().int().positive().optional().describe("想第几章；省略=作者当前所在章。")),
  idea: z.string().optional().describe("作者对这章的想法原话（可空；空=按故事现状想）。只抄作者的话，别自己编。"),
  avoid: coerceStringArray(z.array(z.string()).optional().describe("「再来几种」时已经给过的走法名字；一般不填。")),
});

const outputSchema = z.object({
  ok: z.boolean(),
  chapter: z.number().optional(),
  idea: z.string().optional(),
  options: z.array(z.unknown()).optional().describe("几种走法：名字、几步、推进的线索、和前文对不上的地方。"),
  checked: z.boolean().optional(),
  checkNote: z.string().optional(),
  coldNote: z.string().optional(),
  summary: z.string(),
});

export interface BrainstormToolOutput {
  readonly ok: boolean;
  readonly chapter?: number;
  readonly idea?: string;
  readonly options?: readonly BrainstormOption[];
  readonly checked?: boolean;
  readonly checkNote?: string;
  readonly coldNote?: string;
  readonly summary: string;
}

export async function runBrainstormTool(input: {
  readonly projectDir: string;
  readonly chapter: number;
  readonly idea?: string;
  readonly avoid?: readonly string[];
  readonly callPlanner?: BrainCallModel;
  readonly callChecker?: BrainCallModel;
}): Promise<BrainstormToolOutput> {
  // 导入的书还在通读记账（P8）：开着的线索、前文的账都没记全，想出来的走法对不上前文。
  const rereading = await rereadBlocker(input.projectDir, "想走法");
  if (rereading) return { ok: false, chapter: input.chapter, summary: rereading };
  const callPlanner = input.callPlanner ?? callConfiguredPlannerModel;
  const callChecker = input.callChecker ?? callConfiguredBrainModel;
  const avoid = input.avoid?.map((item) => item.trim()).filter(Boolean);
  const result = await brainstormChapter({
    projectDir: input.projectDir,
    chapter: input.chapter,
    ...(input.idea?.trim() ? { idea: input.idea.trim() } : {}),
    ...(avoid && avoid.length > 0 ? { avoid } : {}),
    callPlanner,
    callChecker,
    // 冷窗口：笔记在后台接着补（同拟章纲），读齐后下次就按全书想。
    onCold: (role) => requestReaderBackfill(input.projectDir, { roles: [role], upTo: input.chapter - 1 }),
  });
  if (!result.ok) return { ok: false, chapter: input.chapter, summary: `第 ${input.chapter} 章的走法没想出来：${result.reason}` };
  const conflicted = result.options.filter((option) => option.problems.length > 0).length;
  // 新书第一章没前文可核，不提核账。
  const tail = result.nothingEarlier
    ? ""
    : !result.checked
      ? "核账员这次没核成，挑之前留意前文。"
      : conflicted > 0 ? `其中 ${conflicted} 种和前文有对不上的地方，卡上标了。` : "";
  return {
    ok: true,
    chapter: result.chapter,
    ...(result.idea ? { idea: result.idea } : {}),
    options: result.options,
    checked: result.checked,
    ...(result.checkNote ? { checkNote: result.checkNote } : {}),
    ...(result.coldNote ? { coldNote: result.coldNote } : {}),
    summary: `第 ${result.chapter} 章想了 ${result.options.length} 种走法，在稿纸上挑。${tail}`,
  };
}

export const brainstormChapterTool = createTool({
  id: "brainstorm_chapter",
  description:
    "头脑风暴：章纲员按读过的前文给这一章出三种不同的走法（每种几步、推进哪些线索），核账员替每种对过前文；作者在稿纸上挑一种。" +
    "只读，不写任何文件。作者问『这章怎么写 / 往哪走 / 给我几个思路 / 下一章有什么走法』时调用；作者要正文就调 change_draft。",
  inputSchema,
  outputSchema,
  execute: async (input: z.infer<typeof inputSchema>, context: ToolExecutionContext) => {
    const projectDir = readProjectDirFromContext(context);
    if (!projectDir) throw new Error("brainstorm_chapter 缺少 projectDir：请确认调用 agent 时通过 RequestContext 注入了 projectDir。");
    const chapter = resolveChapterFromInputOrContext(input.chapter, context);
    if (chapter === undefined) return { ok: false, summary: "不知道要想第几章，先在左边选一章。" };
    return runBrainstormTool({
      projectDir,
      chapter,
      ...(input.idea !== undefined ? { idea: input.idea } : {}),
      ...(input.avoid !== undefined ? { avoid: input.avoid } : {}),
    });
  },
});
