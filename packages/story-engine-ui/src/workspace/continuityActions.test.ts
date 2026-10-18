// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const save = vi.fn(async () => true);
vi.mock("../api/continuityDismissalsClient.js", () => ({ saveContinuityDismissal: (...args: unknown[]) => save(...(args as [])) }));

import { dismissContinuityItem } from "./continuityActions.js";
import { useNavigationStore } from "../stores/navigationStore.js";

describe("「不是问题」存盘（P7 后：按错所在那章记）", () => {
  afterEach(() => save.mockClear());

  it("错在前面那章的（对设定本）：记在那章、带设定标记", async () => {
    useNavigationStore.setState({ projectPath: "/book" });
    await dismissContinuityItem({
      messageId: "m1",
      chapter: 8,
      item: { quote: "走了五年", earlierQuote: "三年前过世", earlierChapter: 3, fixChapter: 3, reason: "", againstSetting: { label: "人物卡" } },
    });
    expect(save).toHaveBeenCalledWith("/book", { chapter: 3, quote: "走了五年", earlierQuote: "三年前过世", againstSetting: true }, false);
  });

  it("错在这一章的照旧记在这一章", async () => {
    useNavigationStore.setState({ projectPath: "/book" });
    await dismissContinuityItem({ messageId: "m1", chapter: 8, item: { quote: "甲", earlierQuote: "乙", earlierChapter: 6, reason: "对不上" } });
    expect(save).toHaveBeenCalledWith("/book", { chapter: 8, quote: "甲", earlierQuote: "乙", reason: "对不上" }, false);
  });
});
