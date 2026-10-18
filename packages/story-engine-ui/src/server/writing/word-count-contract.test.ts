import { countDraftChineseCharacters } from "./draft-length-control.js";
import { describe, expect, it } from "vitest";

import { countTextWords } from "../../utils/textUtils.js";

// 放在 server/ 下：本契约要同时 import 服务端的字数口径（server/writing），前端文件不许 value-import 服务端模块
// （scripts/check-import-boundary.mjs）。
// 长跑 2026-10-04 #5 复核钉测：三口径（AI 读稿 read_draft.charCount / UI 写作区 countTextWords /
// 引擎定稿执法 countDraftChineseCharacters）必须同字符集。两侧分属 UI/引擎两个包，靠字符串/正则各自维护——
// 本测试用边缘字符文本把两边钉在一起：任何一侧单独改字符集（比如加回 〇/扩展B、或换 \p{Script=Han}）
// 都会在此红，防止「三口径打架」回归（真机第 2 章 2989 纯汉字被 AI 报成 3616 的根因）。
describe("countTextWords 与引擎执法口径同源（长跑 #5 跨包契约）", () => {
  it("边缘字符文本：countTextWords(全文) === 引擎 countDraftChineseCharacters(去标题正文)", () => {
    const body =
      "檐角的铜铃轻响，他说：“先记下来。”\n" + // 常规汉字 + 全/半角标点 + 引号
      "㐀䶵㒱㥯赹\n" + // 扩展 A 区（\u3400-\u4DBF，属于 [\u3400-\u9fff]）
      "〇㈠<pre>标签</pre>42hello world\n" + // 〇 U+3007（\p{Script=Han} 认、本口径不认）+ 括号字 + 西文数字
      "𠀀𠀁"; // 扩展 B（U+20000+，surrogate pair，两口径都不认）
    const fullText = `---\ntitle: 标题不该计数\n---\n# 第1章 章节标题同样不该计\n\n${body}\n`;
    const uiCount = countTextWords(fullText);
    const engineCount = countDraftChineseCharacters(body); // 引擎执法侧收到的是去标题正文
    expect(uiCount).toBe(engineCount);
    // 明确钉住字符集语义本身（不是同假）：常规汉字与扩展 A 区（㐀䶵㒱㥯赹）计、〇（U+3007）与
    // 扩展 B（𠀀）不计、frontmatter/标题/西文数字不计。20 = 13（檐角…来）+ 5（扩展A）+ 2（标签）。
    expect(uiCount).toBe(20);
    expect(countTextWords("〇𠀀𠀁")).toBe(0);
    expect(countTextWords("㐀䶵")).toBe(2);
  });

  it("口径统一去标点去标题：含标点全字符口径（旧 read_draft 行为）必大于纯汉字口径", () => {
    const draft = "# 第1章 标题\n\n他站在门口，风把信纸吹得沙沙作响。\n";
    const legacyNoWhitespace = draft.replace(/\s/gu, "").length; // 旧 read_draft「去空白全字符」
    expect(countTextWords(draft)).toBe(countDraftChineseCharacters("他站在门口，风把信纸吹得沙沙作响。"));
    expect(countTextWords(draft)).toBeLessThan(legacyNoWhitespace); // 旧口径把标点+标题都计入（#5 元凶）
  });
});
