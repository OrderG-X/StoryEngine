// @vitest-environment node
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { makeHomeTempDir } from "../../lib/home-test-tmp.js";
import { addDismissal, dismissalsPath, isDismissed, readDismissals, removeDismissal } from "./dismissals.js";

const ITEM = { chapter: 8, quote: "她把便签塞进了抽屉。", earlierQuote: "便签一直揣在她兜里。" };

describe("核账「不是问题」记录", () => {
  it("记下后能认出同一条（模型抄句差一两个字也认）；前文换了一句就当另一处", async () => {
    const dir = await makeHomeTempDir("dismiss-");
    expect(await readDismissals(dir)).toEqual([]);
    expect(await addDismissal(dir, ITEM)).toBe(1);
    expect(await addDismissal(dir, { ...ITEM, quote: "她把便签塞进了抽屉" })).toBe(1);
    const items = await readDismissals(dir);
    expect(isDismissed(8, { quote: "她把便签塞进抽屉。", earlierQuote: "便签一直揣在她兜里" }, items)).toBe(true);
    expect(isDismissed(9, ITEM, items)).toBe(false);
    expect(isDismissed(8, { quote: ITEM.quote, earlierQuote: "老周说那张纸早烧了。" }, items)).toBe(false);
    expect(JSON.parse(await readFile(dismissalsPath(dir), "utf-8")).version).toBe("v0");
  });

  it("撤回删掉对得上的那条；文件坏了当没标过", async () => {
    const dir = await makeHomeTempDir("dismiss-");
    await addDismissal(dir, ITEM);
    expect(await removeDismissal(dir, ITEM)).toBe(1);
    expect(await readDismissals(dir)).toEqual([]);
  });

  it("书目录不在了就不写（不建幽灵目录）", async () => {
    await expect(addDismissal("/nonexistent-book-dir-xyz", ITEM)).rejects.toThrow();
  });
});
