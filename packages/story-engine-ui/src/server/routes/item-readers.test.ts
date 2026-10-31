// @vitest-environment node
/**
 * 东西在哪一路验到读的人手里（写作版本 P3b 第 4 节、第 6 节 ★）：真命令定稿 → 投影 → 写手 / 章纲员 / 记账员的材料、
 * 「这章改了什么」、写前备忘、数字核对。
 */
import { rm } from "node:fs/promises";
import { chapterCommit, project, projectBook, readBookSnapshot, readChapterLedger, runCommand, type EntryInput } from "@actalk/story-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import { buildKeeperContext } from "../editorial/keeper-context.js";
import { collectPlanMaterials, planMaterialBlocks } from "../editorial/plan-materials.js";
import { toChapterChanges } from "./chapter-changes.js";
import { buildWritingContextPack } from "../writing/writing-context-pack.js";
import { findLedgerNumberConflicts } from "../writing/ledger-number-check.js";
import { chapterItemMoves, itemsWhere, recentItemMoves } from "../book/item-views.js";
import { readStoryViews } from "../book/story-views.js";

const narration = { kind: "narration" as const };
type Ref = { id: string } | { tag: string };
const appear = (tag: string, name: string, quote: string): EntryInput => ({ kind: "item", review: "auto", op: "appear", tag, name, quote, source: narration });
const at = (seq: number, item: Ref, to: Record<string, unknown>, quote: string, extra: Record<string, unknown> = {}): EntryInput =>
  ({ kind: "item", review: "auto", op: "at", seq, item, to, quote, source: narration, ...extra }) as EntryInput;
const move = (seq: number, item: Ref, from: Record<string, unknown>, to: Record<string, unknown>, quote: string, extra: Record<string, unknown> = {}): EntryInput =>
  ({ kind: "item", review: "auto", op: "move", seq, item, from, to, quote, source: narration, ...extra }) as EntryInput;

const CH1 = "沈知秋怀里揣着借据。她把铁盒放进樟木箱。樟木箱搁在里屋。借据和地契原先都压在樟木箱底。";
const CH2 = "沈知秋把借据塞进铁盒。铁盒盖上刻着一二七。老周说借据早被烧了。";
const CH3 = "铁盒里只有借据。";

let dir: string;
let legacyFact: string;
beforeEach(async () => {
  dir = await makeHomeTempDir("item-views-");
  const commit = async (chapter: number, text: string, entries: EntryInput[]) => {
    const outcome = await runCommand(dir, chapterCommit, { chapter, text: `# 第${chapter}章\n\n${text}`, entries }, { caller: "author", idempotencyKey: `c${chapter}` });
    if (!outcome.ok) throw new Error(outcome.message);
    if (outcome.result.rejected.length > 0) throw new Error(JSON.stringify(outcome.result.rejected));
  };
  await commit(1, CH1, [
    { kind: "summary", review: "auto", text: "沈知秋收好借据", quote: "沈知秋怀里揣着借据" },
    appear("N1", "借据", "沈知秋怀里揣着借据"),
    appear("N2", "铁盒", "她把铁盒放进樟木箱"),
    appear("N3", "樟木箱", "她把铁盒放进樟木箱"),
    at(1, { tag: "N1" }, { kind: "person", name: "沈知秋" }, "沈知秋怀里揣着借据"),
    at(2, { tag: "N2" }, { kind: "inside", item: { tag: "N3" } }, "她把铁盒放进樟木箱"),
    at(3, { tag: "N3" }, { kind: "place", text: "里屋" }, "樟木箱搁在里屋"),
    // 旧记法：一句说了两样东西在哪。
    { kind: "fact", review: "auto", nature: "state", subject: "借据和地契", attribute: "在哪", value: "樟木箱底", text: "借据和地契都在樟木箱底", quote: "借据和地契原先都压在樟木箱底" },
  ]);
  const ledger1 = await readChapterLedger(dir, 1);
  legacyFact = ledger1!.entries.find((entry) => entry.kind === "fact")!.id;
  const ids = await projectBook(dir).then((projection) => new Map(projection.items.map((item) => [item.name, item.id] as const)));
  const id = (name: string) => ({ id: ids.get(name)! });
  await commit(2, CH2, [
    { kind: "summary", review: "auto", text: "借据进了铁盒", quote: "沈知秋把借据塞进铁盒" },
    move(1, id("借据"), { kind: "person", name: "沈知秋" }, { kind: "inside", item: id("铁盒") }, "沈知秋把借据塞进铁盒", { overlaps: [legacyFact] }),
    { kind: "fact", review: "auto", nature: "hard", item: id("铁盒"), subject: "铁盒", attribute: "盖上刻的数", value: "一二七", text: "铁盒盖上刻着一二七", quote: "铁盒盖上刻着一二七" },
    { kind: "item", review: "auto", op: "gone", seq: 2, item: id("借据"), gone: "destroyed", quote: "老周说借据早被烧了", source: { kind: "character_claim", speaker: "老周" } } as EntryInput,
  ]);
  await commit(3, CH3, [
    { kind: "summary", review: "auto", text: "清点铁盒", quote: "铁盒里只有借据" },
    { kind: "item", review: "auto", op: "census", seq: 1, item: id("铁盒"), members: [id("借据")], complete: true, quote: "铁盒里只有借据", source: narration } as EntryInput,
  ]);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("东西在哪：读的人拿到的材料", () => {
  it("这章改了什么：挪动带上装着它的往外找到头；人物说的单列、标谁说的", async () => {
    const projection = await projectBook(dir);
    expect(chapterItemMoves(projection, 2)).toEqual([
      { name: "借据", text: "沈知秋拿着 → 在铁盒里（铁盒在樟木箱里，樟木箱在里屋）", chapter: 2, quote: "沈知秋把借据塞进铁盒" },
      { name: "借据", text: "毁了", chapter: 2, quote: "老周说借据早被烧了", scope: "老周说的" },
    ]);
    expect(toChapterChanges(projection, 3)?.items).toEqual([{ name: "铁盒", text: "清点：只有借据", chapter: 3, quote: "铁盒里只有借据" }]);
  });

  it("写前备忘：最近几章挪过的，每样只列最后一笔、新的先；人物说的不算挪", async () => {
    const projection = project(await readBookSnapshot(dir), { upTo: 3 });
    expect(recentItemMoves(projection).map((line) => [line.name, line.text, line.chapter])).toEqual([
      ["铁盒", "清点：只有借据", 3],
      ["借据", "沈知秋拿着 → 在铁盒里（铁盒在樟木箱里，樟木箱在里屋）", 2],
      ["樟木箱", "在里屋", 1],
    ]);
  });

  it("写手：东西在哪一节（现在、哪章、原句、清点、人物说的单列）；没对齐的旧事实不当已确立事实、单放；硬约束点一句", async () => {
    const pack = await buildWritingContextPack({ projectDir: dir, chapter: 4, userDirection: "沈知秋打开铁盒" });
    const lines = pack.continuityFocus.itemsWhere ?? [];
    // 老周那句之后第 3 章叙述又清点到它在铁盒里：人物说的不再列。
    expect(lines.find((line) => line.startsWith("借据"))).toBe("借据 · 现在：在铁盒里（铁盒在樟木箱里，樟木箱在里屋），第 2 章 · 原句「沈知秋把借据塞进铁盒」");
    expect(lines.find((line) => line.startsWith("铁盒"))).toContain("第 3 章清点过，之后的挪动都记着：现在里面只有借据");
    expect(pack.continuityFocus.establishedFacts.join("\n")).not.toContain("借据和地契");
    expect(pack.continuityFocus.legacyItemFacts).toEqual(["「借据和地契都在樟木箱底」（第 1 章，旧记法）——其中借据的去向以「东西在哪」为准"]);
    expect(pack.hardConstraints.join("\n")).toContain("照 itemsWhere（东西在哪）接着写");
  });

  it("回头重写第 2 章：东西在哪只算到第 1 章，后文的账不露进来", async () => {
    const pack = await buildWritingContextPack({ projectDir: dir, chapter: 2, userDirection: "沈知秋收起借据" });
    expect(pack.continuityFocus.itemsWhere?.find((line) => line.startsWith("借据"))).toBe("借据 · 现在：沈知秋拿着，第 1 章 · 原句「沈知秋怀里揣着借据」");
    expect(pack.continuityFocus.legacyItemFacts).toBeUndefined();
    // 重写第 3 章：老周说的是最近一笔，单列、标没核实。
    const third = await buildWritingContextPack({ projectDir: dir, chapter: 3, userDirection: "清点铁盒" });
    expect(third.continuityFocus.itemsWhere?.find((line) => line.startsWith("借据"))).toBe(
      "借据 · 现在：在铁盒里（铁盒在樟木箱里，樟木箱在里屋），第 2 章 · 老周说毁了（第 2 章，没核实） · 原句「沈知秋把借据塞进铁盒」",
    );
  });

  it("章纲员：同一节进材料块", async () => {
    const materials = await collectPlanMaterials(dir, 4, "沈知秋打开铁盒");
    const blocks = planMaterialBlocks(4, materials, "沈知秋打开铁盒").join("\n\n");
    expect(blocks).toContain("【东西在哪（关键物件此刻在谁手里、放在哪照这里）】\n");
    expect(blocks).toContain("借据 · 现在：在铁盒里");
    expect(blocks).toContain("【旧记法、没逐样对齐的事实】");
  });

  it("记账员：【已有的东西】按 I 号列，东西的特征事实挂在它下面、旧事实那节不再列", async () => {
    const projection = project(await readBookSnapshot(dir), { upTo: 3 });
    const context = buildKeeperContext(projection, "沈知秋打开铁盒，借据还在。");
    expect(context.text).toContain("【已有的东西");
    expect(context.text).toMatch(/I\d 铁盒 · 现在：在樟木箱里/u);
    expect(context.text).toMatch(/ {3}F\d+ 盖上刻的数：一二七（第 2 章，不会变）/u);
    expect([...context.itemHandles.values()].sort()).toEqual(projection.items.map((item) => item.id).sort());
  });

  it("数字核对：主体是东西的事实不核（正文那个数说的是哪一样拿不到绑定）", async () => {
    const views = await readStoryViews(dir);
    const fact = views.facts.facts.find((item) => item.text === "铁盒盖上刻着一二七");
    expect(fact?.subjectId).toBeDefined();
    expect(findLedgerNumberConflicts({ chapter: 4, draftBody: "铁盒盖上刻着一二八。", facts: views.facts.facts })).toEqual([]);
  });

  it("没有相关的东西就不给这一节", async () => {
    const projection = await projectBook(dir);
    expect(itemsWhere({ ...projection, items: [] }, ["随便写写"], []).lines).toEqual([]);
  });
});
