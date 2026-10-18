/**
 * R3 ESM loader hooks —— 让 `.mjs` 驱动脚本能直接 import UI 侧 `.ts` 模块（直调底层生成器）。
 *
 * 为什么需要：本仓库 UI 侧 `src/server/**\/*.ts` 用 NodeNext 约定（相对 import 写成 `.js` 后缀
 * 但实际指向 `.ts` 源文件）；纯 `node --experimental-strip-types` 不会把 `.js`→`.ts` 重映射，
 * 任何带「运行时相对 .js import」的 UI 模块（如 generate-draft.ts → ../../lib/llm-client.js）
 * 在 node 直跑下都会 ERR_MODULE_NOT_FOUND。本 hooks 做两件事：
 *   resolve(): 相对 `.js` specifier 若磁盘上存在同名 `.ts` → 重写到 `.ts`。
 *   load():    `.ts` 源用 esbuild（已是本包 devDependency，零新依赖）剥类型 → ESM。
 *
 * 用法：驱动脚本顶部
 *   import { register } from "node:module";
 *   register("./r3-ts-hooks.mjs", import.meta.url);
 * 然后 **动态** import UI 侧 `.ts`（静态 import 会在 register 生效前被求值）。
 * 包名 import（`@actalk/story-core` 等）走已构建 dist，不经本 hooks（bare specifier 直接放行）。
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { transformSync } from "esbuild";

export async function resolve(specifier, context, next) {
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js")) {
    const parent = context.parentURL ?? pathToFileURL(`${process.cwd()}/`).href;
    const candidate = new URL(specifier.replace(/\.js$/u, ".ts"), parent);
    if (existsSync(fileURLToPath(candidate))) {
      return { url: candidate.href, shortCircuit: true, format: "module" };
    }
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url.endsWith(".ts")) {
    const sourcePath = fileURLToPath(url);
    const code = readFileSync(sourcePath, "utf8");
    const out = transformSync(code, {
      loader: "ts",
      format: "esm",
      target: "node22",
      sourcefile: sourcePath,
    });
    return { format: "module", source: out.code, shortCircuit: true };
  }
  return next(url, context);
}
