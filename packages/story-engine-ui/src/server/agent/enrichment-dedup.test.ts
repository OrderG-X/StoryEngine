// @vitest-environment node
//
// appendDedup —— 做厚工具共用 list 去重原语。委托引擎唯一归一口径 dedupeStringList
// （空白折叠 + 前缀含纳），替换各 generate_* 工具里各自拷贝的精确 Set 去重，保证同源、不口径漂移。
import { describe, expect, it } from "vitest";

import { appendDedup, semanticDedupRules } from "./enrichment-dedup.js";

describe("appendDedup（做厚共用去重·委托引擎 dedupeStringList）", () => {
  it("合并 existing + additions，折叠仅差首尾空白的重复", () => {
    expect(appendDedup(["禁止泄露顾长风身份"], ["禁止泄露顾长风身份 "])).toEqual(["禁止泄露顾长风身份"]);
  });
  it("前缀含纳：后缀扩展折叠为更长一条（边界处标点）", () => {
    expect(appendDedup(["与主角对立"], ["与主角对立，但暗中通风报信"]))
      .toEqual(["与主角对立，但暗中通风报信"]);
  });
  it("守 #357：子串/后缀不并（账本≠账目账目）", () => {
    expect(appendDedup(["账本"], ["账目账目"])).toEqual(["账本", "账目账目"]);
  });
  it("不并同义/不同细节（不同场景穿着）", () => {
    expect(appendDedup(["穿深蓝色衬衫"], ["穿米色风衣"])).toEqual(["穿深蓝色衬衫", "穿米色风衣"]);
  });
  it("existing 内部已有重复也一并折叠（保序）", () => {
    expect(appendDedup(["A", "A "], ["B"])).toEqual(["A", "B"]);
  });
  it("additions 为空 → 原样去重 existing", () => {
    expect(appendDedup(["X", "X"], [])).toEqual(["X"]);
  });
});

describe("semanticDedupRules P0-4", () => {

  it("去标点空白后相同 → 弃", () => {
    expect(semanticDedupRules(["禁 止：排比凑字。", "禁止排比凑字"])).toEqual(["禁 止：排比凑字。"]);
  });

  it("全文前 20 字归一化相同 → 弃", () => {
    expect(
      semanticDedupRules([
        "多写动作细节：用动作带情绪，少总结腔。",
        "多写动作细节：用动作带情绪，再补一句感官。",
      ]),
    ).toEqual(["多写动作细节：用动作带情绪，少总结腔。"]);
  });

  it("真正不同的规则保留", () => {
    expect(semanticDedupRules(["禁止视角越界", "慎用万能比喻"])).toEqual([
      "禁止视角越界",
      "慎用万能比喻",
    ]);
  });
});
