// @vitest-environment node
import { describe, expect, it } from "vitest";

import { wholeSentenceTarget } from "./revision-service.js";

describe("wholeSentenceTarget：核账抄的半句补成整句再交去改", () => {
  const draft = "“我出。”杜卫平说，“我爹的账上沾了那船的钱，他那本手账里一笔一笔都记着。这些年这钱在我手里压着，花在当年那条船的人身上，不亏心。”\n许微没接话。";

  it("止于逗号的半句 → 补到句首句末（连说话人和收尾引号）", () => {
    expect(wholeSentenceTarget(draft, "我爹的账上沾了那船的钱，他那本手账里一笔一笔都记着。这些年这钱在我手里压着"))
      .toBe("杜卫平说，“我爹的账上沾了那船的钱，他那本手账里一笔一笔都记着。这些年这钱在我手里压着，花在当年那条船的人身上，不亏心。”");
  });

  it("本来就是整句 → 原样；段尾整句不跨到下一段", () => {
    expect(wholeSentenceTarget(draft, "许微没接话。")).toBe("许微没接话。");
    expect(wholeSentenceTarget(draft, "许微没接话")).toBe("许微没接话。");
  });

  it("找不到 / 不唯一 → 原样返回（交给下游如实报）", () => {
    expect(wholeSentenceTarget(draft, "这句不在稿里")).toBe("这句不在稿里");
    expect(wholeSentenceTarget("他走了。他走了。", "他走了")).toBe("他走了");
  });

  it("一段几百字没有句号 → 不往外补（不能整段交出去）", () => {
    const runOn = `${"雾很大，".repeat(60)}灯还亮着，${"船没回来，".repeat(60)}`;
    expect(wholeSentenceTarget(runOn, "灯还亮着")).toBe("灯还亮着");
  });
});
