/**
 * 写一章章纲（写作版本 P2a）：出稿流水在内存里拟好、审好、改好最终那份，由这条命令落盘一次。
 * 章纲的格式和归一归服务端（`book/chapter-plan.ts`）：这里只收归一好的整份文本、核它是一个 JSON 对象，原样写。
 * 和盘上一样就什么都不写（照样留回执）。不动书的版本号（章纲不是真相）；打存档，回执记前后哈希，撤销这次出稿时一起退。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { planPath } from "../store/paths.js";
import { fail } from "./runner.js";
import type { WriteCommandSpec } from "./types.js";

export const PlanSaveArgs = z.object({
  chapter: z.number().int().min(1),
  content: z.string().min(2),
});
export type PlanSaveArgs = z.infer<typeof PlanSaveArgs>;

export interface PlanSaveResult {
  readonly chapter: number;
  /** 盘上原来就是这一份，这次什么都没写。 */
  readonly unchanged: boolean;
}

async function readCurrent(bookDir: string, chapter: number): Promise<string | undefined> {
  try {
    return await readFile(join(bookDir, planPath(chapter)), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function isJsonObject(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

export const planSave: WriteCommandSpec<PlanSaveArgs, PlanSaveResult> = {
  name: "plan.save",
  tier: "ai-direct",
  summary: "写一章章纲（出稿流水拟好的最终那份）。",
  args: PlanSaveArgs,
  snapshot: true,
  idempotent: false,
  bumpsVersion: false,
  async plan(context, args) {
    if (!isJsonObject(args.content)) return fail("invalid_plan", `第 ${args.chapter} 章的章纲格式不对，没有写。`);
    const label = `拟章纲：第 ${args.chapter} 章`;
    if ((await readCurrent(context.bookDir, args.chapter)) === args.content) {
      return { label, writes: [], changed: {}, result: { chapter: args.chapter, unchanged: true } };
    }
    return {
      label,
      writes: [{ path: planPath(args.chapter), content: args.content }],
      changed: { plans: [args.chapter] },
      result: { chapter: args.chapter, unchanged: false },
    };
  },
};
