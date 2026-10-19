// @vitest-environment node
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CHAPTER_LEDGER_SCHEMA,
  applyCardOps,
  bibleView,
  cardWrite,
  emptySettingCards,
  project,
  runCommand,
  type CardOp,
  type ChapterLedger,
  type LedgerEntry,
} from "@actalk/story-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeHomeTempDir } from "../../lib/home-test-tmp.js";
import {
  DEFAULT_MAX_IN_SCENE_CHARACTERS,
  detectInSceneCharacters,
  inSceneCandidates,
  resolveInSceneCharacters,
  type DetectInSceneInput,
  type InSceneCandidate,
} from "./in-scene-detector.js";

const AT = "2026-10-19T08:00:00.000Z";

function cast(): InSceneCandidate[] {
  return [
    { name: "林晚", aliases: ["晚"], protagonist: true },
    { name: "林远", aliases: ["旭", "林总"], protagonist: false },
    { name: "顾远", aliases: [], protagonist: false },
    { name: "周宁", aliases: [], protagonist: false },
  ];
}

function detect(overrides: Partial<DetectInSceneInput> = {}) {
  return detectInSceneCharacters({
    candidates: cast(),
    chapterGoal: "",
    previousChapterText: "",
    prevChapterFound: false,
    previousPresent: [],
    ...overrides,
  });
}

describe("detectInSceneCharacters：信号", () => {
  it("主角恒带：方向、上一章、账里都没点到谁时也带主角", () => {
    const result = detect({ chapterGoal: "这一章不点名任何人。" });
    expect(result.selected).toEqual(["林晚"]);
    expect(result.reasons["林晚"]).toEqual(["protagonist"]);
    expect(result.explicit).toBe(false);
  });

  it("名字或别名在本章方向里逐字出现 → chapter_goal", () => {
    const result = detect({ chapterGoal: "林总在会议室摊牌，顾远旁听。" });
    expect(result.selected).toEqual(["林晚", "林远", "顾远"]);
    expect(result.reasons["林远"]).toEqual(["chapter_goal"]);
    expect(result.reasons["顾远"]).toEqual(["chapter_goal"]);
  });

  it("上一章正文里出现（别名也算）→ previous_chapter", () => {
    const result = detect({ previousChapterText: "上一章结尾，林总在审计室外停下脚步。", prevChapterFound: true });
    expect(result.selected).toEqual(["林晚", "林远"]);
    expect(result.reasons["林远"]).toEqual(["previous_chapter"]);
    expect(result.prevChapterFound).toBe(true);
  });

  it("账里记着上一章出场（按名字或别名）→ previous_presence", () => {
    const result = detect({ previousPresent: ["周宁", "林总"] });
    expect(result.selected).toEqual(["林晚", "林远", "周宁"]);
    expect(result.reasons["周宁"]).toEqual(["previous_presence"]);
    expect(result.reasons["林远"]).toEqual(["previous_presence"]);
  });

  it("名字至少两个字才拿去找：单字别名（旭、晚）撞上普通字不算", () => {
    const result = detect({ chapterGoal: "旭日照进大厅，天色已晚，没人提那位总裁。", previousChapterText: "旭日东升。", prevChapterFound: true });
    expect(result.selected).toEqual(["林晚"]);
    expect(result.reasons["林晚"]).toEqual(["protagonist"]);
    expect(result.selected).not.toContain("林远");
  });

  it("候选为空 / 没人被点到：summary 如实说，不编名字", () => {
    expect(detect({ candidates: [] }).summary).toBe("本章相关人物：还没有人物卡，账里也没记过出场的人。");
    const noProtagonist = detect({ candidates: cast().map((candidate) => ({ ...candidate, protagonist: false })), chapterGoal: "风很大。" });
    expect(noProtagonist.selected).toEqual([]);
    expect(noProtagonist.summary).toBe("本章相关人物：本章方向和上一章里都没点到谁。");
  });
});

describe("detectInSceneCharacters：作者点名优先", () => {
  it("点了名 → 只带主角和点到的人，方向/上一章里的信号不再加人", () => {
    const result = detect({ explicit: ["顾远"], chapterGoal: "林远摊牌。", previousPresent: ["周宁"] });
    expect(result.selected).toEqual(["林晚", "顾远"]);
    expect(result.explicit).toBe(true);
    expect(result.reasons["顾远"]).toEqual(["explicit"]);
  });

  it("点名用的是别名 → 换成卡上的名字", () => {
    const result = detect({ explicit: [" 林总 "] });
    expect(result.selected).toEqual(["林晚", "林远"]);
    expect(result.explicit).toBe(true);
    expect(result.summary).toBe("本章相关人物：林晚、林远");
  });

  it("点到的名字对不上任何人 → 丢掉；一个都对不上就回落自动检测", () => {
    const partly = detect({ explicit: ["顾远", "查无此人"] });
    expect(partly.selected).toEqual(["林晚", "顾远"]);
    expect(partly.explicit).toBe(true);

    const none = detect({ explicit: ["主角", "char-bogus"], chapterGoal: "周宁到了。" });
    expect(none.explicit).toBe(false);
    expect(none.selected).toEqual(["林晚", "周宁"]);
    expect(none.summary).not.toContain("char-bogus");
  });

  it("点名传空数组或全空白 → 不算点名，走自动检测（不旁路收窄）", () => {
    for (const explicit of [[], ["", "  "]]) {
      const result = detect({ explicit, chapterGoal: "林远摊牌。" });
      expect(result.explicit).toBe(false);
      expect(result.selected).toEqual(["林晚", "林远"]);
    }
  });
});

describe("detectInSceneCharacters：超额按分收窄", () => {
  function crowd(): InSceneCandidate[] {
    return [
      { name: "白薇", aliases: [], protagonist: false },
      { name: "沈砚", aliases: [], protagonist: false },
      { name: "周宁", aliases: [], protagonist: false },
      { name: "顾远", aliases: [], protagonist: false },
      { name: "林远", aliases: [], protagonist: false },
      { name: "林晚", aliases: [], protagonist: true },
    ];
  }
  const crowdInput = (): DetectInSceneInput => ({
    candidates: crowd(),
    chapterGoal: "本章林远摊牌，顾远也在。", // 林远 3、顾远 3
    previousChapterText: "顾远昨夜离开，周宁送他。", // 顾远 +2、周宁 2
    prevChapterFound: true,
    previousPresent: ["沈砚", "白薇"], // 各 2
    maxInScene: 3,
  });

  it("主角占名额；其余按分排（方向 3 + 上一章 2 > 方向 3 > 2），收窄掉的名字如实列出", () => {
    const result = detectInSceneCharacters(crowdInput());
    expect(result.selected).toEqual(["林晚", "顾远", "林远"]);
    expect(result.reasons["顾远"]).toEqual(["chapter_goal", "previous_chapter"]);
    // 同分按候选顺序（卡在前的先）
    expect(result.cappedOutNames).toEqual(["白薇", "沈砚", "周宁"]);
    expect(result.summary).toBe("本章相关人物：林晚、顾远、林远（按在场相关性收窄到 3 人，没带：白薇、沈砚、周宁）");
  });

  it("没超额 → 不收窄、cappedOutNames 为空、summary 不提收窄", () => {
    const result = detectInSceneCharacters({ ...crowdInput(), maxInScene: 8 });
    expect(result.selected).toHaveLength(6);
    expect(result.cappedOutNames).toEqual([]);
    expect(result.summary).not.toContain("收窄");
  });

  it("不传 maxInScene 用默认 8", () => {
    expect(DEFAULT_MAX_IN_SCENE_CHARACTERS).toBe(8);
    const many = Array.from({ length: 10 }, (_, index) => ({ name: `人物${String.fromCharCode(0x7532 + index)}`, aliases: [], protagonist: false }));
    const result = detectInSceneCharacters({
      candidates: many,
      chapterGoal: many.map((candidate) => candidate.name).join("、"),
      previousChapterText: "",
      prevChapterFound: false,
      previousPresent: [],
    });
    expect(result.selected).toHaveLength(8);
    expect(result.cappedOutNames).toHaveLength(2);
  });

  it("同输入同输出（可复现）", () => {
    expect(detectInSceneCharacters(crowdInput())).toEqual(detectInSceneCharacters(crowdInput()));
  });
});

describe("inSceneCandidates", () => {
  type Draft = LedgerEntry extends infer E ? (E extends LedgerEntry ? Omit<E, "id" | "review"> : never) : never;
  const ledgerOf = (chapter: number, drafts: Draft[]): ChapterLedger => ({
    schema: CHAPTER_LEDGER_SCHEMA,
    chapter,
    textSha256: "0".repeat(64),
    committedAt: AT,
    origin: "commit",
    entries: drafts.map((draft, index) => ({ review: "auto", ...draft, id: `c${chapter}-${index + 1}` }) as LedgerEntry),
  });

  it("人物卡在前（带账里用过的称呼），账里出场、还没建卡的人在后；账里别的主体不算人", () => {
    const projection = project({
      ledgers: [ledgerOf(1, [
        { kind: "presence", name: "许微", nameUsed: "许微", quote: "许微来了" },
        { kind: "presence", name: "孟庆山", nameUsed: "孟叔", quote: "孟叔来了" },
        { kind: "presence", name: "韩德胜", nameUsed: "老韩", quote: "老韩来了" },
        { kind: "fact", nature: "state", subject: "铜钥匙", attribute: "在哪", value: "抽屉里", text: "铜钥匙在抽屉里", quote: "铜钥匙在抽屉里" },
      ])],
      decisions: [],
    });
    const ops: CardOp[] = [
      { op: "card.create", kind: "character", name: "许微", aliases: ["小微"], protagonist: true },
      { op: "card.create", kind: "character", name: "孟庆山" },
      { op: "card.create", kind: "place", name: "三号仓" },
    ];
    const outcome = applyCardOps(emptySettingCards(), ops, { by: "author", at: AT });
    if (!outcome.ok) throw new Error(outcome.message);
    const candidates = inSceneCandidates(bibleView(projection, outcome.file));
    expect(candidates).toEqual([
      { name: "许微", aliases: ["小微"], protagonist: true },
      { name: "孟庆山", aliases: ["孟叔"], protagonist: false },
      { name: "韩德胜", aliases: ["老韩"], protagonist: false },
    ]);
  });
});

describe("resolveInSceneCharacters（读真书）", () => {
  let projectDir: string;
  beforeEach(async () => {
    projectDir = await makeHomeTempDir("presence-detector-");
    await mkdir(join(projectDir, "chapters"), { recursive: true });
    await writeFile(join(projectDir, "project.json"), `${JSON.stringify({ title: "Presence Test" }, null, 2)}\n`, "utf-8");
  });
  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  async function cards(ops: CardOp[]): Promise<void> {
    const outcome = await runCommand(projectDir, cardWrite, { ops }, { caller: "author", idempotencyKey: `t-${Math.random()}` });
    if (!outcome.ok) throw new Error(outcome.message);
  }
  async function ledger(chapter: number, present: { name: string; nameUsed?: string }[]): Promise<void> {
    const file: ChapterLedger = {
      schema: CHAPTER_LEDGER_SCHEMA,
      chapter,
      textSha256: "0".repeat(64),
      committedAt: AT,
      origin: "commit",
      entries: present.map((item, index) => ({
        kind: "presence", review: "auto", id: `c${chapter}-${index + 1}`, name: item.name, nameUsed: item.nameUsed ?? item.name, quote: `${item.nameUsed ?? item.name}来了`,
      })),
    };
    await mkdir(join(projectDir, "ledger", "chapters"), { recursive: true });
    await writeFile(join(projectDir, "ledger", "chapters", `${String(chapter).padStart(4, "0")}.json`), JSON.stringify(file), "utf-8");
  }
  const defaultCards = (): CardOp[] => [
    { op: "card.create", kind: "character", name: "林晚", protagonist: true },
    { op: "card.create", kind: "character", name: "林远", aliases: ["林总"] },
    { op: "card.create", kind: "character", name: "顾远" },
    { op: "card.create", kind: "character", name: "周宁" },
  ];

  it("读设定卡 + 上一章正文 + 账里上一章出场：账里出场还没建卡的人也带上；summary 只有名字", async () => {
    await cards(defaultCards());
    await writeFile(join(projectDir, "chapters", "0001.md"), "# 第一章\n\n林总在楼下等候。", "utf-8");
    await ledger(1, [{ name: "林晚" }, { name: "韩德胜", nameUsed: "老韩" }]);

    const resolved = await resolveInSceneCharacters({ projectDir, chapter: 2, chapterGoal: "顾远来送信。" });

    expect(resolved.selected).toEqual(["林晚", "顾远", "林远", "韩德胜"]);
    expect(resolved.reasons["林远"]).toEqual(["previous_chapter"]);
    expect(resolved.reasons["韩德胜"]).toEqual(["previous_presence"]);
    expect(resolved.prevChapterFound).toBe(true);
    expect(resolved.summary).toBe("本章相关人物：林晚、顾远、林远、韩德胜");
    expect(resolved.summary).not.toMatch(/k-|char-|c\d-/u);
  });

  it("上一章还没定稿 → 读上一章工作稿", async () => {
    await cards(defaultCards());
    await mkdir(join(projectDir, "drafts", "fast"), { recursive: true });
    await writeFile(join(projectDir, "drafts", "fast", "chapter-0002.md"), "周宁推门进来。", "utf-8");

    const resolved = await resolveInSceneCharacters({ projectDir, chapter: 3, chapterGoal: "继续。" });

    expect(resolved.prevChapterFound).toBe(true);
    expect(resolved.selected).toEqual(["林晚", "周宁"]);
  });

  it("账里最近一章不是紧挨着的上一章 → 不拿它的出场当信号", async () => {
    await cards(defaultCards());
    await ledger(1, [{ name: "顾远" }]);

    const resolved = await resolveInSceneCharacters({ projectDir, chapter: 3, chapterGoal: "继续。" });

    expect(resolved.selected).toEqual(["林晚"]);
    expect(resolved.prevChapterFound).toBe(false);
  });

  it("第一章没有上一章；作者点名按卡上的名字和别名认", async () => {
    await cards(defaultCards());

    const resolved = await resolveInSceneCharacters({ projectDir, chapter: 1, chapterGoal: "顾远登场。", explicit: ["林总", "查无此人"] });

    expect(resolved.prevChapterFound).toBe(false);
    expect(resolved.explicit).toBe(true);
    expect(resolved.selected).toEqual(["林晚", "林远"]);
  });

  it("超额收窄在真书上同样如实列出没带的人", async () => {
    await cards(defaultCards());
    await writeFile(join(projectDir, "chapters", "0001.md"), "顾远和周宁吵了一架。", "utf-8");

    const resolved = await resolveInSceneCharacters({ projectDir, chapter: 2, chapterGoal: "林远摊牌。", maxInScene: 2 });

    expect(resolved.selected).toEqual(["林晚", "林远"]);
    expect(resolved.cappedOutNames).toEqual(["顾远", "周宁"]);
    expect(resolved.summary).toContain("没带：顾远、周宁");
  });

  it("新书：没有设定卡、账里也没人 → 什么都不选，如实说", async () => {
    const resolved = await resolveInSceneCharacters({ projectDir, chapter: 1, chapterGoal: "开篇。" });
    expect(resolved.selected).toEqual([]);
    expect(resolved.summary).toBe("本章相关人物：还没有人物卡，账里也没记过出场的人。");
  });
});
