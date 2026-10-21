#!/usr/bin/env node
/**
 * 生成第三方软件许可清单（P11，build-desktop.sh 在 staging 上调）。
 *
 * 用法：node gen-notices.mjs <出文件> <node_modules 目录> [<额外包目录>...]
 *   - node_modules：pnpm deploy 出的扁平生产依赖（含嵌套 node_modules、@scope）。
 *   - 额外包目录：打进前端包、但只在 devDependencies 里的库（比如图标、样式工具），单个包的根目录。
 *
 * 每个包一节：名字@版本、许可类型、包里自带的许可文件原文（没带就写明没带）。
 * 自家工作区包（@actalk/*）不算第三方，跳过。随包 git 的说明在 vendor/git/NOTICE.txt，这里只提一句。
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [outFile, nodeModules, ...extraDirs] = process.argv.slice(2);
if (!outFile || !nodeModules) {
  console.error("用法：node gen-notices.mjs <出文件> <node_modules 目录> [<额外包目录>...]");
  process.exit(2);
}

const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.|-|$)/iu;

/** @type {Map<string, { name: string, version: string, license: string, texts: string[] }>} */
const packages = new Map();

function licenseOf(pkg) {
  if (typeof pkg.license === "string") return pkg.license;
  if (pkg.license && typeof pkg.license.type === "string") return pkg.license.type;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((item) => item?.type ?? String(item)).join(" OR ");
  return "未注明";
}

function addPackage(dir) {
  const manifest = join(dir, "package.json");
  if (!existsSync(manifest)) return;
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(manifest, "utf-8"));
  } catch {
    return;
  }
  if (typeof pkg.name !== "string" || pkg.name.startsWith("@actalk/")) return;
  const key = `${pkg.name}@${pkg.version ?? "?"}`;
  if (packages.has(key)) return;
  const texts = [];
  for (const entry of readdirSync(dir).sort()) {
    if (!LICENSE_FILE.test(entry)) continue;
    const file = join(dir, entry);
    try {
      if (statSync(file).isFile()) texts.push(readFileSync(file, "utf-8").trim());
    } catch {
      // 读不了就算没带
    }
  }
  packages.set(key, { name: pkg.name, version: String(pkg.version ?? "?"), license: licenseOf(pkg), texts });
}

function walk(modulesDir) {
  if (!existsSync(modulesDir)) return;
  for (const entry of readdirSync(modulesDir)) {
    if (entry.startsWith(".")) continue;
    const full = join(modulesDir, entry);
    if (entry.startsWith("@")) {
      for (const scoped of readdirSync(full)) {
        addPackage(join(full, scoped));
        walk(join(full, scoped, "node_modules"));
      }
      continue;
    }
    addPackage(full);
    walk(join(full, "node_modules"));
  }
}

walk(nodeModules);
for (const dir of extraDirs) addPackage(dir);

const sorted = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
const lines = [
  "StoryEngine 用到的第三方软件及其许可",
  "",
  `共 ${sorted.length} 个开源包。每节是包名@版本、许可类型、包里自带的许可原文。`,
  "Electron 与 Chromium 的许可随应用一起分发（应用包里的 LICENSE 与 LICENSES.chromium.html）。",
  "随包的 git（Mac 版）按 GPLv2 分发，说明和源代码地址见应用包里的 vendor/git/NOTICE.txt。",
  "",
];
for (const item of sorted) {
  lines.push("=".repeat(72), `${item.name}@${item.version}（${item.license}）`, "=".repeat(72));
  lines.push(item.texts.length > 0 ? item.texts.join("\n\n---\n\n") : "（包里没带许可原文，许可类型见上。）", "");
}
writeFileSync(outFile, `${lines.join("\n")}\n`, "utf-8");
console.log(`第三方许可清单：${sorted.length} 个包 → ${outFile}`);
