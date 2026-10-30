/**
 * 冻结材料（写作版本 P2a 契约第五节）：`inputs/<名>.json`，只放这次操作自己的目录、只供本操作恢复和溯源。
 * 受理时写在 operation.json 之前（store.acceptOperation 带 inputs）：有一份有效记录，它的冻结材料就一定在。
 */
import { readFile } from "node:fs/promises";
import { inputPath } from "./store.js";

/** 读一份冻结材料；没有、坏了都是 undefined（调用方如实说）。 */
export async function readOperationInput(bookDir: string, opId: string, name: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(inputPath(bookDir, opId, name), "utf-8")) as unknown;
  } catch {
    return undefined;
  }
}
