// @vitest-environment node
/**
 * Task B3-1: 伏笔大小分级（热度读时派生）
 *
 * deriveSize 是纯确定性函数，无 LLM、无写盘。
 * weight = (span>=10 ? 2 : 0) + (evidenceCount>=3 ? 1 : 0) + (relatedCharacterCount>=2 ? 1 : 0)
 * weight >= 2 → "major"，否则 "minor"
 */
import { describe, it, expect } from "vitest";
import { deriveSize } from "./state-overview.js";

// ---------------------------------------------------------------------------
// deriveSize 纯函数单元测试
// ---------------------------------------------------------------------------

describe("deriveSize — 正例与负例", () => {
  it("大伏笔正例：借条（span=46、evidence>=3、relatedChars>=2）→ major", () => {
    expect(
      deriveSize({
        firstSeenChapter: 1,
        lastTouchedChapter: 47,
        evidenceCount: 5,
        relatedCharacterCount: 2,
      }),
    ).toBe("major");
  });

  it("小线索正例：一次性碎片（span=0、evidence=1、relatedChars=0）→ minor", () => {
    expect(
      deriveSize({
        firstSeenChapter: 10,
        lastTouchedChapter: 10,
        evidenceCount: 1,
        relatedCharacterCount: 0,
      }),
    ).toBe("minor");
  });
});

describe("deriveSize — 权重边界", () => {
  it("span 刚好 10 → 得 2 分，weight=2 → major", () => {
    expect(
      deriveSize({
        firstSeenChapter: 5,
        lastTouchedChapter: 15,
        evidenceCount: 0,
        relatedCharacterCount: 0,
      }),
    ).toBe("major");
  });

  it("span=9（差一格不到 10）、无其他分 → minor", () => {
    expect(
      deriveSize({
        firstSeenChapter: 1,
        lastTouchedChapter: 10,
        evidenceCount: 0,
        relatedCharacterCount: 0,
      }),
    ).toBe("minor");
  });

  it("evidence 刚好 3 → 得 1 分，单独不够 major", () => {
    expect(
      deriveSize({
        firstSeenChapter: 5,
        lastTouchedChapter: 5,
        evidenceCount: 3,
        relatedCharacterCount: 0,
      }),
    ).toBe("minor");
  });

  it("evidence>=3 + relatedChars>=2（weight=2）→ major，即使 span<10", () => {
    expect(
      deriveSize({
        firstSeenChapter: 3,
        lastTouchedChapter: 5,
        evidenceCount: 3,
        relatedCharacterCount: 2,
      }),
    ).toBe("major");
  });

  it("relatedChars 刚好 2 → 得 1 分，单独不够 major", () => {
    expect(
      deriveSize({
        firstSeenChapter: 1,
        lastTouchedChapter: 1,
        evidenceCount: 0,
        relatedCharacterCount: 2,
      }),
    ).toBe("minor");
  });

  it("span>=10 + evidence>=3（weight=3）→ major", () => {
    expect(
      deriveSize({
        firstSeenChapter: 1,
        lastTouchedChapter: 20,
        evidenceCount: 4,
        relatedCharacterCount: 0,
      }),
    ).toBe("major");
  });

  it("缺省 firstSeenChapter/lastTouchedChapter 时当 span=0 处理 → minor（单条件）", () => {
    expect(
      deriveSize({
        evidenceCount: 1,
        relatedCharacterCount: 1,
      }),
    ).toBe("minor");
  });

  it("weight=1 时（只有 evidence>=3）→ minor", () => {
    expect(
      deriveSize({
        firstSeenChapter: 1,
        lastTouchedChapter: 5,
        evidenceCount: 3,
        relatedCharacterCount: 0,
      }),
    ).toBe("minor");
  });
});
