import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectBook, readBible } from "../index.js";
import type { EntryInput } from "../schema/ledger.js";
import { readChapterLedger, readDecisions, sha256 } from "../store/book.js";
import { draftPath } from "../store/paths.js";
import { draftVersionOf, readDraft } from "../draft/draft.js";
import { splitUnits } from "../text/units.js";
import { chapterCommit } from "./chapter-commit.js";
import { runCommand } from "./runner.js";
import { settleApply, type SettleApplyArgs, type SettleApplyResult } from "./settle-apply.js";
import type { CommandOutcome, CommandSuccess } from "./types.js";

let book: string;
beforeEach(async () => {
  book = await mkdtemp(join(tmpdir(), "story-core-settle-"));
});
afterEach(async () => {
  await rm(book, { recursive: true, force: true });
});

const CH1 = "# 第1章 · 旧屋\n\n杜叔走了整整十年。屋里没人住过。\n\n许微推开门，灰扑了一脸。";
const CH2 = "# 第2章 · 来信\n\n“杜叔走了五年了。”孟叔说。许微没接话。\n\n信封上写着杜长顺的名字。";

const CH1_ENTRIES: EntryInput[] = [
  { kind: "summary", review: "auto", text: "许微进杜叔的旧屋", quote: "许微推开门" },
  { kind: "fact", review: "auto", nature: "hard", subject: "杜长顺", attribute: "去世", value: "十年前", text: "杜长顺十年前去世", quote: "杜叔走了整整十年" },
  { kind: "presence", review: "auto", name: "许微", nameUsed: "许微", viewpoint: true, quote: "许微推开门" },
];
const CH2_ENTRIES: EntryInput[] = [
  { kind: "summary", review: "auto", text: "孟叔说起杜叔", quote: "杜叔走了五年了" },
  { kind: "fact", review: "auto", nature: "hard", subject: "杜长顺", attribute: "去世", value: "五年前", text: "杜长顺五年前去世", quote: "杜叔走了五年了" },
  { kind: "presence", review: "auto", name: "孟叔", nameUsed: "孟叔", quote: "孟叔说。许微没接话" },
  { kind: "presence", review: "auto", name: "杜长顺", nameUsed: "杜叔", quote: "杜叔走了五年了" },
  { kind: "thread", review: "auto", op: "open", type: "question", title: "杜叔怎么死的", note: "孟叔提起杜叔", quote: "杜叔走了五年了" },
];

const author = (key: string) => ({ caller: "author" as const, idempotencyKey: key });

function expectOk<R>(outcome: CommandOutcome<R>): CommandSuccess<R> {
  if (!outcome.ok) throw new Error(`命令失败：${outcome.code} ${outcome.message}`);
  return outcome;
}

async function seed(): Promise<void> {
  expectOk(await runCommand(book, chapterCommit, { chapter: 1, text: CH1, entries: CH1_ENTRIES }, author("c1")));
  expectOk(await runCommand(book, chapterCommit, { chapter: 2, text: CH2, entries: CH2_ENTRIES }, author("c2")));
}

function unitOf(text: string, sentence: string) {
  const unit = splitUnits(text).find((item) => item.text === sentence);
  if (!unit) throw new Error(`没有这句：${sentence}`);
  return unit;
}

function fixCh2(extra: Partial<SettleApplyArgs["chapters"][number]> = {}): SettleApplyArgs["chapters"][number] {
  const unit = unitOf(CH2, "“杜叔走了五年了。”");
  return { chapter: 2, textSha256: sha256(CH2), edits: [{ id: unit.id, from: unit.text, to: "“杜叔走了十年了。”" }], facts: [], retract: [], ...extra };
}

describe("定论并改齐", () => {
  it("记定论、换句、账单跟着改：没给改法的事实作废，梗概 / 线索 / 出场的原句换成新句", async () => {
    await seed();
    const outcome = expectOk(await runCommand(book, settleApply, {
      label: "定论：杜长顺十年前去世",
      cardOps: [{ op: "canon.add", text: "杜长顺十年前去世" }],
      chapters: [fixCh2()],
      drafts: [],
    }, author("s1")));
    const result: SettleApplyResult = outcome.result;
    expect(result.cardLines).toEqual(["记下定论「杜长顺十年前去世」"]);
    expect(result.chapters).toEqual([{ chapter: 2, edits: 1, factsUpdated: [], factsRetracted: ["杜长顺五年前去世"], requoted: 3, presenceDropped: [] }]);
    expect(outcome.changed).toEqual({ chapters: [2], ledgers: [2], decisions: true, cards: true });

    const text = await readFile(join(book, "chapters/0002.md"), "utf-8");
    expect(text).toBe("# 第2章 · 来信\n\n“杜叔走了十年了。”孟叔说。许微没接话。\n\n信封上写着杜长顺的名字。");
    const ledger = await readChapterLedger(book, 2);
    expect(ledger?.textSha256).toBe(sha256(text));
    expect(ledger?.entries.find((entry) => entry.kind === "summary")?.quote).toBe("“杜叔走了十年了。”");
    expect(ledger?.entries.find((entry) => entry.kind === "thread")?.quote).toBe("“杜叔走了十年了。”");
    expect(ledger?.entries.find((entry) => entry.kind === "presence" && entry.name === "孟叔")?.quote).toBe("孟叔说。许微没接话");

    const decisions = await readDecisions(book);
    expect(decisions).toEqual([expect.objectContaining({ type: "fact.retract", note: "定论改齐：原句改了" })]);
    const view = await projectBook(book);
    expect(view.conflicts).toEqual([]);
    expect(view.chapters.find((chapter) => chapter.chapter === 2)?.editedSinceCommit).toBe(false);
    const { bible } = await readBible(book);
    expect(bible.canon.map((item) => item.text)).toEqual(["杜长顺十年前去世"]);
  });

  it("给了改法的事实按改法改（编号不变）；改法核不上改后的正文整条不写", async () => {
    await seed();
    const before = await readChapterLedger(book, 2);
    const fact = before!.entries.find((entry) => entry.kind === "fact")!;
    const bad = await runCommand(book, settleApply, {
      label: "定论",
      cardOps: [],
      chapters: [fixCh2({ facts: [{ id: fact.id, value: "十年前", quote: "杜叔走了五年了" }] })],
      drafts: [],
    }, author("s-bad"));
    expect(bad).toMatchObject({ ok: false, code: "fact_patch_invalid" });
    expect(await readFile(join(book, "chapters/0002.md"), "utf-8")).toBe(CH2);

    const outcome = expectOk(await runCommand(book, settleApply, {
      label: "定论",
      cardOps: [],
      chapters: [fixCh2({ facts: [{ id: fact.id, value: "十年前", text: "杜长顺十年前去世", quote: "杜叔走了十年了" }] })],
      drafts: [],
    }, author("s2")));
    expect(outcome.result.chapters[0]).toMatchObject({ factsUpdated: ["杜长顺十年前去世"], factsRetracted: [] });
    const after = await readChapterLedger(book, 2);
    expect(after?.entries.find((entry) => entry.id === fact.id)).toMatchObject({ value: "十年前", quote: "杜叔走了十年了" });
    expect(await readDecisions(book)).toEqual([]);
  });

  it("没记原句的老账：点名作废的照作废，没点名的不动", async () => {
    await seed();
    const path = join(book, "ledger/chapters/0002.json");
    // 老书导入的账（origin: import）才允许事实不带原句。
    const raw = { ...(JSON.parse(await readFile(path, "utf-8")) as { entries: Record<string, unknown>[] }), origin: "import" };
    raw.entries.push(
      { kind: "fact", review: "auto", nature: "event", text: "孟叔说杜叔五年前走的", id: "fact-2-90" },
      { kind: "fact", review: "auto", nature: "event", text: "许微没接孟叔的话", id: "fact-2-91" },
    );
    await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`);
    expect(await runCommand(book, settleApply, { label: "定论", cardOps: [], chapters: [fixCh2({ retract: ["fact-2-99"] })], drafts: [] }, author("s-unknown")))
      .toMatchObject({ ok: false, code: "unknown_fact" });
    const outcome = expectOk(await runCommand(book, settleApply, {
      label: "定论",
      cardOps: [],
      chapters: [fixCh2({ retract: ["fact-2-90"] })],
      drafts: [],
    }, author("s-old")));
    expect(outcome.result.chapters[0]?.factsRetracted).toEqual(["杜长顺五年前去世", "孟叔说杜叔五年前走的"]);
    expect((await readDecisions(book)).map((decision) => decision.type === "fact.retract" ? decision.fact : "")).toEqual(expect.arrayContaining(["fact-2-90"]));
    expect((await readDecisions(book)).some((decision) => decision.type === "fact.retract" && decision.fact === "fact-2-91")).toBe(false);
  });

  it("预览后正文改过、定稿后在别处改过：一处都不改", async () => {
    await seed();
    const moved = await runCommand(book, settleApply, { label: "定论", cardOps: [], chapters: [fixCh2({ textSha256: sha256("别的") })], drafts: [] }, author("s3"));
    expect(moved).toMatchObject({ ok: false, code: "chapter_moved" });
    const edited = `${CH2}\n\n多了一段。`;
    await writeFile(join(book, "chapters/0002.md"), edited);
    const unit = unitOf(edited, "“杜叔走了五年了。”");
    const outcome = await runCommand(book, settleApply, {
      label: "定论",
      cardOps: [{ op: "canon.add", text: "杜长顺十年前去世" }],
      chapters: [{ chapter: 2, textSha256: sha256(edited), edits: [{ id: unit.id, from: unit.text, to: "“杜叔走了十年了。”" }], facts: [] }],
      drafts: [],
    }, author("s4"));
    expect(outcome).toMatchObject({ ok: false, code: "edited_since_commit" });
    const { bible } = await readBible(book);
    expect(bible.canon).toEqual([]);
  });

  it("工作稿按编号换句、带版本号；版本对不上不改", async () => {
    await seed();
    const draft = "# 第3章 · 夜\n\n孟叔又说，杜叔走了五年。许微摇头。\n";
    await mkdir(join(book, "drafts/fast"), { recursive: true });
    await writeFile(join(book, draftPath(3)), draft);
    const unit = unitOf(draft, "孟叔又说，杜叔走了五年。");
    const edits = [{ id: unit.id, from: unit.text, to: "孟叔又说，杜叔走了十年。" }];
    expect(await runCommand(book, settleApply, { label: "定论", cardOps: [], chapters: [], drafts: [{ chapter: 3, baseVersion: "0000", edits }] }, author("s5")))
      .toMatchObject({ ok: false, code: "draft_moved" });
    const outcome = expectOk(await runCommand(book, settleApply, {
      label: "定论",
      cardOps: [],
      chapters: [],
      drafts: [{ chapter: 3, baseVersion: (await readDraft(book, 3))!.version, edits }],
    }, author("s6")));
    const written = await readFile(join(book, draftPath(3)), "utf-8");
    expect(written).toBe("# 第3章 · 夜\n\n孟叔又说，杜叔走了十年。许微摇头。\n");
    expect(outcome.result.drafts).toEqual([{ chapter: 3, edits: 1, version: (await readDraft(book, 3))!.version }]);
    // 老书第一次写工作稿：版本号带上这次的代次，和全文的哈希不一样（撤销回原样也对不上旧的）。
    expect(outcome.result.drafts[0]!.version).not.toBe(draftVersionOf(written, { epoch: "" }));
    expect(outcome.changed).toEqual({ drafts: [3] });
  });

  it("AI 调不了；出场的称呼改没了就去掉这条出场", async () => {
    await seed();
    expect(await runCommand(book, settleApply, { label: "定论", cardOps: [], chapters: [fixCh2()], drafts: [] }, { caller: "ai" }))
      .toMatchObject({ ok: false, code: "author_only" });
    const unit = unitOf(CH2, "“杜叔走了五年了。”");
    const outcome = expectOk(await runCommand(book, settleApply, {
      label: "定论",
      cardOps: [],
      chapters: [{ chapter: 2, textSha256: sha256(CH2), edits: [{ id: unit.id, from: unit.text, to: "“他走了十年了。”" }], facts: [] }],
      drafts: [],
    }, author("s7")));
    expect(outcome.result.chapters[0]?.presenceDropped).toEqual(["杜叔"]);
    const ledger = await readChapterLedger(book, 2);
    expect(ledger?.entries.some((entry) => entry.kind === "presence" && entry.nameUsed === "杜叔")).toBe(false);
  });
});
