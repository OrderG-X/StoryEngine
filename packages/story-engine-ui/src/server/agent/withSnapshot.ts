/**
 * writeTool — 写类工具的高阶声明器。
 *
 * 铁律「直接做 + 可撤销」：每一个会落盘的工具，在执行前先做一次 git 快照
 * （createSnapshot），把当前全部状态存档，执行结果再附上 `snapshotId`，
 * 前端凭这个 id 即可一键撤销本次写入。无确认弹窗——先做，可反悔。
 *
 * 用法：写类工具不要直接 createTool，而是用本函数包装：
 *   export const foundationWriteTool = writeTool({ id, description, inputSchema, outputSchema, run });
 * 其中 `run({ input, projectDir, snapshotId, context })` 是真正的落盘逻辑，
 * 拿到的是「已建好快照」的 projectDir 与 snapshotId。
 *
 * projectDir 来源：每个请求通过 Mastra 的 RequestContext 注入（agent-chat 路由里
 * `new RequestContext([["projectDir", dir]])`），本包装层在 execute 里读出来。
 * 取不到 projectDir 视为编程错误，直接抛——绝不静默失败、绝不写错项目。
 */
import { createTool } from "@mastra/core/tools";
import type { ToolExecutionContext } from "@mastra/core/tools";
import type { z } from "zod";

import { runWithSnapshot } from "../lib/snapshot.js";
import { REQUEST_CONTEXT_PROJECT_DIR_KEY, readProjectDirFromContext } from "./request-context.js";

export interface WriteToolDefinition<
  TInput extends z.ZodTypeAny,
  TOutput extends z.ZodTypeAny,
> {
  readonly id: string;
  readonly description: string;
  readonly inputSchema: TInput;
  readonly outputSchema: TOutput;
  /**
   * 真正的落盘逻辑。调用前已建好快照，拿到 snapshotId + projectDir。
   * 返回值会被 outputSchema 校验；本包装层会强制把 snapshotId 并入返回对象，
   * 因此 outputSchema 必须声明 `snapshotId: z.string()`。
   */
  readonly run: (args: {
    readonly input: z.infer<TInput>;
    readonly projectDir: string;
    readonly snapshotId: string;
    readonly context: ToolExecutionContext;
  }) => Promise<Omit<z.infer<TOutput>, "snapshotId"> & { readonly snapshotId?: string }>;
  /**
   * 写入前守卫。发生在 createSnapshot 之前；返回结果时不建快照、不进入 run。
   * 用于「要作者点按钮才做」这类确定性拒绝，避免 no-op 快照污染历史。
   */
  readonly preflight?: (args: {
    readonly input: z.infer<TInput>;
    readonly projectDir: string;
    readonly context: ToolExecutionContext;
  }) => Promise<(Omit<z.infer<TOutput>, "snapshotId"> & { readonly snapshotId?: string }) | undefined>
    | (Omit<z.infer<TOutput>, "snapshotId"> & { readonly snapshotId?: string }) | undefined;
  /**
   * 可选：据入参生成一句简短「细节」，拼进快照标签（agent:<id>:<detail>）让操作历史能分辨同类多次写入
   * （如『建角色 顾长风』『改资产 事故原始图纸』）。题材中立、不含冒号（含则被换成·，避免破坏标签解析）。
   */
  readonly snapshotDetail?: (input: z.infer<TInput>) => string | undefined;
}

/**
 * 声明一个写类工具：execute 前先 createSnapshot(projectDir, "agent:"+id)，
 * 把 snapshotId 注入 run，并强制并入返回结果。
 */
export function writeTool<
  TInput extends z.ZodTypeAny,
  TOutput extends z.ZodTypeAny,
>(def: WriteToolDefinition<TInput, TOutput>) {
  return createTool({
    id: def.id,
    description: def.description,
    inputSchema: def.inputSchema,
    outputSchema: def.outputSchema,
    execute: async (input: z.infer<TInput>, context: ToolExecutionContext) => {
      const projectDir = readProjectDirFromContext(context);
      if (!projectDir) {
        throw new Error(
          `写类工具 ${def.id} 缺少 projectDir：请确认调用 agent 时通过 RequestContext 注入了 "${REQUEST_CONTEXT_PROJECT_DIR_KEY}"。`,
        );
      }
      const preflightResult = await def.preflight?.({ input, projectDir, context });
      if (preflightResult !== undefined) return { ...preflightResult, snapshotId: preflightResult.snapshotId ?? "" };
      // 先快照再写入——无确认弹窗，但每次写入都可一键撤销。
      // PR C：快照 + run 落盘原子化（同一 project 锁），消除并发快照/撤销切进 run 中间的竞态。
      // 标签可带细节（rerun2 P2 可读性）：agent:<id>:<detail>。细节里的冒号换成·，避免破坏 humanizeUndoLabel 的首冒号拆分。
      const detail = def.snapshotDetail?.(input)?.trim().replace(/:/gu, "·");
      const label = detail ? `agent:${def.id}:${detail}` : `agent:${def.id}`;
      const { snapshot, result } = await runWithSnapshot(projectDir, label, (snapshotId) =>
        def.run({ input, projectDir, snapshotId, context }),
      );
      // 强制并入快照 id，调用方 run 不必自己回填。
      // 修 P2·4：run 明确返回 ok:false（被 preview guard 拒/需确认/没写入）时，这次快照是 no-op，
      // 不把它当「可撤销快照」透出——避免把失败 no-op 结构上包成「有快照」误导后续逻辑。
      const wrote = (result as { readonly ok?: boolean }).ok !== false;
      return { ...result, snapshotId: wrote ? snapshot.id : "" };
    },
  });
}
