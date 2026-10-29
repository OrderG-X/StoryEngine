/**
 * 步骤检查点（写作版本 P2a 设计第三节）：`steps/<stepId>.json`。一步做完、输出落盘了才算做完；
 * 恢复时输入指纹对得上就直接用存下的输出（零调用），对不上或没有就整步重做。写由 executor 在栅栏里做。
 */
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson, sha256 } from "@actalk/story-core";
import { writeFileAtomic } from "../project-io.js";
import { operationDir } from "./store.js";

export const STEP_SCHEMA = "operation-step/1" as const;

export interface StepCheckpoint {
  readonly schema: typeof STEP_SCHEMA;
  readonly stepId: string;
  /** 这一步输入的指纹：冻结材料、前面步骤的输出。 */
  readonly inputHash: string;
  /** 跑出这一步的执行号（`runEpoch:stepId`）。 */
  readonly exec: string;
  readonly output: unknown;
  readonly finishedAt: string;
}

const stepsDir = (bookDir: string, opId: string): string => join(operationDir(bookDir, opId), "steps");
/** stepId 只用配方里写死的字、数字、冒号、横线；冒号换成下划线当文件名。 */
const stepFile = (bookDir: string, opId: string, stepId: string): string => join(stepsDir(bookDir, opId), `${stepId.replace(/[^0-9A-Za-z-]/gu, "_")}.json`);

export const inputHashOf = (input: unknown): string => sha256(canonicalJson(input ?? null));

export async function readCheckpoint(bookDir: string, opId: string, stepId: string): Promise<StepCheckpoint | undefined> {
  try {
    const value = JSON.parse(await readFile(stepFile(bookDir, opId, stepId), "utf-8")) as Partial<StepCheckpoint>;
    if (value.schema !== STEP_SCHEMA || value.stepId !== stepId || typeof value.inputHash !== "string" || !("output" in value)) return undefined;
    return value as StepCheckpoint;
  } catch {
    // 没有 / 坏了：这一步当没做完，整步重做。
    return undefined;
  }
}

/** 写一步的检查点（调用方在栅栏里）。 */
export async function writeCheckpoint(bookDir: string, opId: string, checkpoint: StepCheckpoint): Promise<void> {
  await mkdir(stepsDir(bookDir, opId), { recursive: true });
  await writeFileAtomic(stepFile(bookDir, opId, checkpoint.stepId), `${JSON.stringify(checkpoint, null, 2)}\n`);
}
