import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve, sep } from "node:path";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceRoot = join(packageRoot, "src");
const SERVER_ONLY_PACKAGES = ["@mastra/core", "ai", "@ai-sdk/openai-compatible"];

const errors = [];

// 前端 bundle 不许带服务端代码：src/server/ 以外的源文件只能 `import type` 服务端模块
// （编译期被 erase、不进 bundle）；测试文件不进 bundle，不管。
// 服务端代码（Mastra agent / 工具 / 模型调用 / 老格式书读写）只许落在 src/server/ 下。
for (const filePath of collectSourceFiles(sourceRoot)) {
  const normalizedPath = normalize(filePath);
  if (isServerFile(normalizedPath) || isTestFile(normalizedPath)) continue;
  const text = readFileSync(filePath, "utf8");
  for (const statement of findImports(text)) {
    if (isTypeOnlyImport(statement.clause)) continue;
    if (!statement.source.startsWith(".")) {
      if (SERVER_ONLY_PACKAGES.some((name) => statement.source === name || statement.source.startsWith(`${name}/`))) {
        errors.push(`${formatPath(filePath)} imports server-only package ${statement.source}`);
      }
      continue;
    }
    const target = normalize(resolve(dirname(filePath), statement.source));
    if (isServerFile(target)) errors.push(`${formatPath(filePath)} imports server module ${statement.source}`);
  }
}

if (errors.length > 0) {
  console.error("UI import boundary check failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log("UI import boundary check passed.");

function collectSourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) return collectSourceFiles(fullPath);
    if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) return [fullPath];
    return [];
  });
}

function findImports(text) {
  const imports = [];
  const staticImportPattern = /(?:^|\n)\s*import\s+(?!["'])([\s\S]*?)\s+from\s+["']([^"']+)["'];?/g;
  const sideEffectImportPattern = /(?:^|\n)\s*import\s+["']([^"']+)["'];?/g;
  const dynamicImportPattern = /import\s*\(\s*["']([^"']+)["']\s*\)/g;

  for (const match of text.matchAll(staticImportPattern)) {
    imports.push({ clause: match[1].trim(), source: match[2] });
  }

  for (const match of text.matchAll(sideEffectImportPattern)) {
    imports.push({ clause: "side-effect import", source: match[1] });
  }

  for (const match of text.matchAll(dynamicImportPattern)) {
    imports.push({ clause: "dynamic import", source: match[1] });
  }

  return imports;
}

function formatPath(filePath) {
  return relative(packageRoot, filePath);
}

function normalize(filePath) {
  return filePath.split(sep).join("/");
}

function isServerFile(normalizedPath) {
  return normalizedPath.includes("/src/server/");
}

function isTestFile(normalizedPath) {
  return /\.test\.(ts|tsx)$/.test(normalizedPath) || normalizedPath.endsWith("/src/test-global-setup.ts") || normalizedPath.endsWith("/src/test-setup.ts");
}

// 纯类型导入 `import type { ... }` / `import type Foo` / `import type * as X`：clause 以 `type` 开头。
// 这类导入编译期被 erase，不进运行时 bundle。注意只放行整句 `import type`，不放行 inline 的
// `import { type A, value B }`（那种 clause 以 `{` 开头、含 value import，仍按 value 拦截）。
function isTypeOnlyImport(clause) {
  return /^type\b/.test(clause.trim());
}
