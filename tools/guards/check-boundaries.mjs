#!/usr/bin/env node
/**
 * 新旧代码隔离 + 服务端分层检查（重构 P0 起，P7 第 6 步加分层；规矩见 docs/rebuild/PLAN.md 第二节第 6 条、第三节第 6 条）。
 *
 * boundaries.json 里每条规则：dir（目录）+ forbid（不许 import 的模块前缀，或相对路径落到的目录）+ allow（例外前缀，只给测试基建用）。
 * 新代码要用旧模块里的好东西，就把它「搬」过来，不许直接 import 旧的——否则旧模块永远删不掉。
 * 目录还不存在的规则直接跳过（P2 起陆续生效）。
 *
 * 用法（仓库根）：node tools/guards/check-boundaries.mjs
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const { rules } = JSON.parse(readFileSync(join(here, "boundaries.json"), "utf8"));

const IMPORT_RE = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/gu;

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mjs|js)$/u.test(entry)) out.push(full);
  }
  return out;
}

const toPosix = (p) => p.split(sep).join("/");
const violations = [];
let checkedRules = 0;
for (const rule of rules) {
  const dir = join(repoRoot, rule.dir);
  if (!existsSync(dir)) continue;
  checkedRules += 1;
  for (const file of walk(dir, [])) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(IMPORT_RE)) {
      const spec = match[1] ?? match[2] ?? match[3];
      const target = spec.startsWith(".") ? toPosix(relative(repoRoot, resolve(dirname(file), spec))) : spec;
      const hit = rule.forbid.find((prefix) => (prefix.endsWith("/")
        ? target.startsWith(prefix)
        : target === prefix || target.startsWith(`${prefix}/`)));
      const allowed = (rule.allow ?? []).some((prefix) => target.startsWith(prefix));
      if (hit && !allowed) {
        const line = text.slice(0, match.index).split("\n").length;
        violations.push(`${toPosix(relative(repoRoot, file))}:${line}  import「${spec}」——${rule.why}`);
      }
    }
  }
}

if (violations.length) {
  console.error("分层检查没过：下层 import 了上层（或核心引了服务端）。把要共用的东西挪到下层，别反着引。");
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log(`分层检查通过（生效规则 ${checkedRules}/${rules.length} 条）`);
