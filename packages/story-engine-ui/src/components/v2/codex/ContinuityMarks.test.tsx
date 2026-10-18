// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { findQuoteRange } from "./ContinuityMarks.js";

const paper = (html: string): HTMLElement => {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.append(root);
  return root;
};

describe("稿纸上找核账原句（划线定位）", () => {
  afterEach(() => { document.body.innerHTML = ""; });

  it("不计空白、跨文本节点找到原句", () => {
    const root = paper("<p>第二天下午，<strong>林舟</strong>骑车去了 东门菜场。</p>");
    expect(findQuoteRange(root, "林舟骑车去了东门菜场。")?.toString()).toBe("林舟骑车去了 东门菜场。");
  });

  it("模型用「……」连起两截：从第一截画到最后一截（可跨段）", () => {
    const root = paper("<p>甲。</p><p>摊主是个姓吴的老师傅，正低头钉掌。王师傅抬头看了他一眼。</p>");
    expect(findQuoteRange(root, "摊主是个姓吴的老师傅……王师傅抬头")?.toString()).toBe("摊主是个姓吴的老师傅，正低头钉掌。王师傅抬头");
    const two = paper("<p>摊主姓吴，正低头钉掌。</p><p>王师傅抬头看了他一眼。</p>");
    const range = findQuoteRange(two, "正低头钉掌。……王师傅抬头");
    expect(range?.startContainer.textContent).toBe("摊主姓吴，正低头钉掌。");
    expect(range?.endContainer.textContent).toBe("王师傅抬头看了他一眼。");
  });

  it("截的顺序对不上、或找不到：不画", () => {
    const root = paper("<p>王师傅抬头。摊主姓吴。</p>");
    expect(findQuoteRange(root, "摊主姓吴……王师傅")).toBeNull();
    expect(findQuoteRange(root, "没有这句")).toBeNull();
    expect(findQuoteRange(root, "……")).toBeNull();
  });
});
