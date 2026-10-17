#!/usr/bin/env node
/**
 * 「不猜」棘轮检查（重构 P0，2026-10-17；规矩见 docs/rebuild/PLAN.md 第三节第 1 条）。
 *
 * 数每个源文件里「含中文的正则」——正则字面量 /…中文…/ 和 new RegExp("…中文…")。
 * 这是「拿正则猜作者意图 / 猜 AI 真假 / 猜文本语义」的代理指标；切句、找原句、数字归一这类
 * 正当文本处理登记在 no-guess-allowlist.json（写明理由），不计数。
 *
 * 棘轮：每个文件的计数不得超过 no-guess-baseline.json 里的值；基线里没有的文件必须为 0。
 * 只许降不许升。降了之后跑 `--update` 把基线往下收（--update 永远不会调高任何一项）。
 *
 * 用法（仓库根）：
 *   node tools/guards/check-no-guess.mjs            # 检查，超了退出码 1
 *   node tools/guards/check-no-guess.mjs --update   # 把基线收紧到当前值
 *   node tools/guards/check-no-guess.mjs --report   # 按目录打印分布
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const require = createRequire(join(repoRoot, "packages", "story-engine-ui", "package.json"));
const ts = require("typescript");

const SCAN_ROOTS = [
  "packages/story-engine/src",
  "packages/story-engine-ui/src",
  "packages/story-core/src",
];
const BASELINE_PATH = join(here, "no-guess-baseline.json");
const ALLOWLIST_PATH = join(here, "no-guess-allowlist.json");
const CJK = /[㐀-鿿豈-﫿　-〿！-～]/u;

function isSourceFile(name) {
  return /\.(ts|tsx|mjs|js)$/u.test(name) && !/\.(test|spec)\.(ts|tsx|mjs|js)$/u.test(name) && !name.endsWith(".d.ts");
}

function walk(dir, out) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    if (entry === "__tests__" || entry === "test-fixtures") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (isSourceFile(entry)) out.push(full);
  }
  return out;
}

/** 一个文件里含中文的正则：返回 [{ line, text }]。 */
function findChineseRegexes(file) {
  const text = readFileSync(file, "utf8");
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const hits = [];
  const record = (node, snippet) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    hits.push({ line: line + 1, text: snippet.slice(0, 80) });
  };
  const visit = (node) => {
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
      if (CJK.test(node.text)) record(node, node.text);
    } else if (
      (ts.isNewExpression(node) || ts.isCallExpression(node))
      && ts.isIdentifier(node.expression)
      && node.expression.text === "RegExp"
      && node.arguments?.length
    ) {
      const first = node.arguments[0];
      if (CJK.test(first.getText(source))) record(node, first.getText(source));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

function readJson(path, fallback) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback;
}

const args = new Set(process.argv.slice(2));
const allowlist = readJson(ALLOWLIST_PATH, { files: {} }).files ?? {};
const baseline = readJson(BASELINE_PATH, { files: {} }).files ?? {};

const counts = {};
const details = {};
for (const root of SCAN_ROOTS) {
  for (const file of walk(join(repoRoot, root), [])) {
    const rel = relative(repoRoot, file).split(sep).join("/");
    if (allowlist[rel]) continue;
    const hits = findChineseRegexes(file);
    if (hits.length) {
      counts[rel] = hits.length;
      details[rel] = hits;
    }
  }
}
const total = Object.values(counts).reduce((sum, n) => sum + n, 0);

if (args.has("--report")) {
  const byDir = {};
  for (const [file, n] of Object.entries(counts)) {
    const key = file.split("/").slice(0, 5).join("/");
    byDir[key] = (byDir[key] ?? 0) + n;
  }
  for (const [dir, n] of Object.entries(byDir).sort((a, b) => b[1] - a[1])) console.log(String(n).padStart(5), dir);
  console.log(`共 ${total} 处，${Object.keys(counts).length} 个文件`);
  process.exit(0);
}

if (args.has("--update")) {
  const next = {};
  const isFirstRun = !existsSync(BASELINE_PATH);
  for (const [file, n] of Object.entries(counts)) {
    const old = baseline[file];
    if (isFirstRun) next[file] = n;
    else if (old !== undefined) next[file] = Math.min(old, n);
  }
  const blocked = Object.entries(counts).filter(([file, n]) => !isFirstRun && (baseline[file] ?? 0) < n);
  const sorted = Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)));
  const nextTotal = Object.values(sorted).reduce((sum, n) => sum + n, 0);
  writeFileSync(BASELINE_PATH, `${JSON.stringify({
    note: "不猜棘轮基线：每个文件含中文正则的处数上限，只许降。由 check-no-guess.mjs --update 生成，别手工调高。",
    total: nextTotal,
    files: sorted,
  }, null, 2)}\n`);
  console.log(`基线已收紧：${nextTotal} 处（当前 ${total}）`);
  if (blocked.length) {
    console.log("下面这些文件比基线多，--update 不会替你调高，先改代码：");
    for (const [file, n] of blocked) console.log(`  ${file}: ${n} > ${baseline[file] ?? 0}`);
    process.exit(1);
  }
  process.exit(0);
}

const over = Object.entries(counts).filter(([file, n]) => n > (baseline[file] ?? 0));
if (over.length) {
  console.error("「不猜」检查没过：下面的文件新增了含中文的正则（规矩见 docs/rebuild/PLAN.md 第三节第 1 条）。");
  console.error("要么改成结构化做法；要么确属切句 / 找原句 / 数字归一，登记到 tools/guards/no-guess-allowlist.json 并写理由。");
  for (const [file, n] of over) {
    console.error(`  ${file}: ${n} 处（上限 ${baseline[file] ?? 0}）`);
    for (const hit of details[file].slice(0, 5)) console.error(`    第 ${hit.line} 行  ${hit.text}`);
  }
  process.exit(1);
}
const baseTotal = Object.values(baseline).reduce((sum, n) => sum + n, 0);
const shrunk = total < baseTotal ? `（比基线少 ${baseTotal - total} 处，可跑 --update 收紧）` : "";
console.log(`「不猜」检查通过：含中文正则 ${total} 处${shrunk}`);
