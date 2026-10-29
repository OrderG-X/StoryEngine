// @vitest-environment node
// 一份稿只有两种样子（写作版本 P1 第 14、15 轮复核）：文件原文只经核心 parseDraftFile 拆、composeDraftFile 拼，
// 拆开以后谁都不再按章名行拆。各处自己写「去开头 # 行」的正则，迟早又把正文开头的小节当章名吃掉（AC1–AC3 都是这么来的）。
// 这里扫两个包的源码：认 # 开头行的写法，所在行或上一行必须登记「章名行白名单：<类别>」，类别只认下面几种。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const UI_SRC = dirname(dirname(fileURLToPath(import.meta.url)));
const PACKAGES = dirname(dirname(UI_SRC));
const ROOTS = [join(PACKAGES, "story-core", "src"), UI_SRC];

/** 类别 → 能用在哪（undefined = 哪都行）。 */
const KINDS: Readonly<Record<string, readonly string[] | undefined>> = {
  文件原文: ["story-core/src/draft/format.ts"], // 拆 / 拼文件原文：只此一处
  模型输出: undefined, // 模型交回来的字，变成拆开的稿之前清理
  导入切章: undefined, // 作者导入的整本 txt 切章
  正文小节: undefined, // 正文里的「## 小节」行（编号句子单列一条）
  字数口径: undefined, // 字数不算标题行（全仓同一口径）
  定位: undefined, // 只读：在正文里找段落时跳过标题行，不改字
};

const MARK = "章名行白名单：";
const HEADING = /\/\^(?:\\s\*)?#|#\{1,|\(\?:\^\|\\n\)#|startsWith\(["'`]#|RegExp\(["'`]\^(?:\\\\s\*)?#/u;

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === "node_modules" || name === "dist") continue;
      files.push(...sourceFiles(path));
    } else if (/\.(ts|tsx)$/u.test(name) && !/\.test\.(ts|tsx)$/u.test(name)) {
      files.push(path);
    }
  }
  return files;
}

it("认「# 开头行」的写法都登记过类别，拆文件原文只在核心 draft/format.ts", () => {
  const offenders: string[] = [];
  let registered = 0;
  for (const root of ROOTS) {
    for (const file of sourceFiles(root)) {
      const rel = relative(PACKAGES, file).split("\\").join("/");
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (!HEADING.test(line)) return;
        const marked = [line, lines[index - 1] ?? ""].map((text) => text.split(MARK)[1]?.trim().split(/\s/u)[0]).find(Boolean);
        if (!marked) {
          offenders.push(`${rel}:${index + 1} 没登记`);
          return;
        }
        if (!(marked in KINDS)) {
          offenders.push(`${rel}:${index + 1} 不认识的类别「${marked}」`);
          return;
        }
        const only = KINDS[marked];
        if (only && !only.includes(rel)) offenders.push(`${rel}:${index + 1} 「${marked}」只能在 ${only.join("、")}`);
        registered += 1;
      });
    }
  }
  expect(offenders).toEqual([]);
  // 扫得到东西（路径错了会一个都扫不到、白白通过）
  expect(registered).toBeGreaterThan(5);
});
